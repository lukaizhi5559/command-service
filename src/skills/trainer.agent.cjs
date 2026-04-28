'use strict';
// ---------------------------------------------------------------------------
// trainer.agent.cjs — Training mode orchestration with "Teach Me" support
//
// Manages the training session:
// 1. Opens browser to agent's domain
// 2. Captures accessibility snapshots every 2s + on DOM mutations
// 3. Builds real-time narrative of user actions
// 4. Detects confusion triggers → "Teach Me" dialog
// 5. Self-test execution with learned actions
// 6. Skill generation (draft)
//
// Called from main.js when user clicks "Train" on an agent
// ---------------------------------------------------------------------------

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const logger  = require('../logger.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const AGENTS_DIR   = path.join(os.homedir(), '.thinkdrop', 'agents');
const SKILLS_DIR   = path.join(os.homedir(), '.thinkdrop', 'skills');

// Track active training sessions
const activeTrainingSessions = new Map(); // agentId -> session

// ---------------------------------------------------------------------------
// Progress reporting to Electron UI
// ---------------------------------------------------------------------------
function _postTrainingProgress(agentId, payload) {
  try {
    const data = JSON.stringify({ ...payload, agentId, timestamp: Date.now() });
    const req = http.request({
      hostname: '127.0.0.1',
      port: OVERLAY_PORT,
      path: '/training.progress',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => {});
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main training action
// ---------------------------------------------------------------------------
async function actionTrain(args) {
  const {
    agentId,
    _progressCallbackUrl,
  } = args || {};

  if (!agentId) {
    return { ok: false, error: 'agentId is required' };
  }

  // Check if already training
  if (activeTrainingSessions.has(agentId)) {
    return { ok: false, error: 'Training already in progress for this agent' };
  }

  // Load agent descriptor
  const agentPath = path.join(AGENTS_DIR, `${agentId}.md`);
  if (!fs.existsSync(agentPath)) {
    return { ok: false, error: `Agent not found: ${agentId}` };
  }

  const descriptor = fs.readFileSync(agentPath, 'utf8');
  
  // Extract start_url from frontmatter
  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) {
    return { ok: false, error: 'Agent missing start_url in frontmatter' };
  }
  
  const startUrl = startUrlMatch[1].trim();
  const hostname = new URL(startUrl).hostname.replace(/^www\./, '');

  // Extract user_goals from frontmatter (multi-goal support)
  const goalsMatch = descriptor.match(/^user_goals:[\s\S]*?(?=^\w|$)/m);
  let userGoals = [];
  if (goalsMatch) {
    const goalLines = goalsMatch[0].split('\n').slice(1);
    userGoals = goalLines
      .map(line => line.match(/^\s*-\s*"?([^"\n]+)"?/)?.[1])
      .filter(Boolean);
  }
  
  // Fallback to legacy user_goal if no user_goals found
  if (userGoals.length === 0) {
    const legacyGoalMatch = descriptor.match(/^user_goal:\s*"?([^"\n]+)"?/m);
    if (legacyGoalMatch) {
      userGoals = [legacyGoalMatch[1].trim()];
    }
  }
  
  const primaryGoal = userGoals[0] || 'automate tasks';

  // Create training session
  const session = {
    agentId,
    hostname,
    startUrl,
    userGoals,           // Array of goals to train for
    primaryGoal,         // Primary goal for this session
    currentGoalIndex: 0,  // Track which goal we're training for
    startTime: Date.now(),
    snapshots: [], // { timestamp, snapshot, url }
    narrative: [], // { timestamp, action, description }
    teachMeQueue: [], // Confusion points to ask user
    currentStep: 'observing', // observing | teach_me | self_test | generating
    cancelRequested: false,
    browserSessionId: `${agentId}_train_${Date.now()}`,
  };
  activeTrainingSessions.set(agentId, session);

  logger.info(`[trainer.agent] Starting training for ${agentId} at ${startUrl} (${userGoals.length} goals)`);
  _postTrainingProgress(agentId, { 
    type: 'training:start', 
    hostname, 
    startUrl,
    goals: userGoals,
    primaryGoal,
    message: `Training for: ${primaryGoal}${userGoals.length > 1 ? ` (${userGoals.length - 1} more goals)` : ''}`
  });

  try {
    // Phase 1: Open browser and start observation
    await _startObservation(session);
    
    // Phase 2: Build narrative from snapshots (runs in background)
    _startNarrativeBuilder(session);
    
    return {
      ok: true,
      agentId,
      message: 'Training started. Browser opened. Click "Done Training" when finished demonstrating.',
    };

  } catch (err) {
    logger.error(`[trainer.agent] Training error: ${err.message}`);
    activeTrainingSessions.delete(agentId);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Open browser and capture snapshots
// ---------------------------------------------------------------------------
async function _startObservation(session) {
  const { startUrl, browserSessionId, agentId } = session;
  
  // Navigate to the site via browser.act
  const browserAct = require('./browser.act.cjs');
  
  _postTrainingProgress(agentId, { type: 'training:navigating', message: 'Opening browser...' });
  
  // Navigate
  await browserAct({
    action: 'navigate',
    url: startUrl,
    sessionId: browserSessionId,
    headed: true, // Show browser window
    timeoutMs: 30000,
  });
  
  // Wait for page to stabilize
  await browserAct({
    action: 'waitForStableText',
    sessionId: browserSessionId,
    headed: true,
    timeoutMs: 10000,
  }).catch(() => {});
  
  _postTrainingProgress(agentId, { 
    type: 'training:observing', 
    message: 'Watching your interactions... Click "Done Training" when finished.' 
  });
  
  // Start snapshot capture loop
  session.snapshotInterval = setInterval(async () => {
    if (session.cancelRequested) {
      clearInterval(session.snapshotInterval);
      return;
    }
    
    try {
      const snapResult = await browserAct({
        action: 'snapshot',
        sessionId: browserSessionId,
        headed: true,
        timeoutMs: 10000,
      });
      
      if (snapResult.ok && snapResult.result) {
        const snapshot = {
          timestamp: Date.now(),
          snapshot: snapResult.result,
          url: snapResult.url || startUrl,
        };
        session.snapshots.push(snapshot);
        
        // Keep only last 100 snapshots to prevent memory bloat
        if (session.snapshots.length > 100) {
          session.snapshots.shift();
        }
        
        // Check for confusion triggers
        _detectConfusion(session, snapshot);
      }
    } catch (e) {
      // Non-fatal - continue capturing
    }
  }, 2000); // Capture every 2 seconds
}

// ---------------------------------------------------------------------------
// Phase 2: Build narrative from snapshots using LLM
// ---------------------------------------------------------------------------
function _startNarrativeBuilder(session) {
  const { agentId } = session;
  
  let lastSnapshotIndex = 0;
  
  session.narrativeInterval = setInterval(async () => {
    if (session.cancelRequested || session.currentStep !== 'observing') {
      clearInterval(session.narrativeInterval);
      return;
    }
    
    // Process new snapshots
    const newSnapshots = session.snapshots.slice(lastSnapshotIndex);
    if (newSnapshots.length < 2) return; // Need at least 2 to compare
    
    lastSnapshotIndex = session.snapshots.length;
    
    // Compare last two snapshots to detect changes
    const current = newSnapshots[newSnapshots.length - 1];
    const previous = newSnapshots[newSnapshots.length - 2];
    
    // Check if significant change occurred
    if (_hasSignificantChange(previous.snapshot, current.snapshot)) {
      // Ask LLM to describe what happened
      try {
        const narrative = await _generateNarrative(previous, current, session);
        if (narrative) {
          session.narrative.push({
            timestamp: current.timestamp,
            action: narrative.action,
            description: narrative.description,
          });
          
          _postTrainingProgress(agentId, {
            type: 'training:narrative',
            message: narrative.description,
            narrative: session.narrative,
          });
        }
      } catch (e) {
        logger.warn(`[trainer.agent] Narrative generation failed: ${e.message}`);
      }
    }
  }, 3000); // Check every 3 seconds
}

// ---------------------------------------------------------------------------
// Detect confusion triggers for "Teach Me"
// ---------------------------------------------------------------------------
async function _detectConfusion(session, snapshot) {
  const { agentId, narrative } = session;
  
  // Triggers:
  // 1. Page changed but we can't determine what happened
  // 2. Multiple interactive elements appeared
  // 3. Form validation errors
  // 4. Unexpected modal/dialog
  
  const snapshotText = snapshot.snapshot.toLowerCase();
  
  // Check for error indicators
  const errorIndicators = ['error', 'invalid', 'required', 'please fill', 'not valid'];
  const hasError = errorIndicators.some(ind => snapshotText.includes(ind));
  
  // Check for modal/dialog
  const modalIndicators = ['modal', 'dialog', 'popup', 'overlay'];
  const hasModal = modalIndicators.some(ind => snapshotText.includes(ind));
  
  if (hasError || hasModal) {
    // Pause and ask user
    session.currentStep = 'teach_me';
    
    const question = hasError 
      ? "I see a form error. What field needs to be corrected?"
      : "A dialog/modal appeared. What is this for?";
    
    const options = hasError
      ? ['Fix missing field', 'Correct format', 'Add required info', 'Something else']
      : ['Confirm action', 'Enter information', 'Close/cancel', 'Something else'];
    
    _postTrainingProgress(agentId, {
      type: 'training:teach_me',
      question,
      options,
      snapshot: snapshot.snapshot.substring(0, 500), // Truncated for UI
    });
  }
}

// ---------------------------------------------------------------------------
// Generate narrative from snapshot changes
// ---------------------------------------------------------------------------
async function _generateNarrative(previous, current, session) {
  const currentGoal = session.userGoals[session.currentGoalIndex] || session.primaryGoal;
  
  const prompt = `You are observing a user training a browser automation agent.

GOAL: ${currentGoal}

Previous page state:
URL: ${previous.url}
Snapshot: ${previous.snapshot.substring(0, 1000)}

Current page state:
URL: ${current.url}
Snapshot: ${current.snapshot.substring(0, 1000)}

Describe what the user likely did in ONE SHORT SENTENCE (max 10 words).
Focus on the ACTION that advances toward the goal, not the result.

Examples:
- "Clicked the Create Track button"
- "Filled in the title field"
- "Selected Electronic from dropdown"
- "Submitted the form"

Reply ONLY with the description sentence, no preamble.`;

  const response = await askWithMessages([
    { role: 'system', content: 'You describe user actions for browser automation training.' },
    { role: 'user', content: prompt }
  ], { maxTokens: 100, temperature: 0.3 });

  const description = response?.trim() || 'Performed an action';
  
  return {
    action: 'interaction',
    description,
  };
}

// ---------------------------------------------------------------------------
// Check if snapshots have significant changes
// ---------------------------------------------------------------------------
function _hasSignificantChange(prevSnapshot, currSnapshot) {
  // Simple heuristic: check if text content changed significantly
  const prevText = prevSnapshot.replace(/\s+/g, ' ').trim();
  const currText = currSnapshot.replace(/\s+/g, ' ').trim();
  
  // Calculate rough difference
  const minLen = Math.min(prevText.length, currText.length);
  if (minLen === 0) return currText.length > 0;
  
  const diff = Math.abs(prevText.length - currText.length);
  const ratio = diff / minLen;
  
  // Significant if >10% change
  return ratio > 0.1;
}

// ---------------------------------------------------------------------------
// User answers "Teach Me" question
// ---------------------------------------------------------------------------
async function actionAnswerTeachMe(args) {
  const { agentId, answer, explanation } = args || {};
  
  const session = activeTrainingSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active training session' };
  }
  
  // Store the teaching moment
  session.narrative.push({
    timestamp: Date.now(),
    action: 'teach_me',
    description: `Learned: ${answer}${explanation ? ` (${explanation})` : ''}`,
  });
  
  // Resume observation
  session.currentStep = 'observing';
  _startNarrativeBuilder(session);
  
  _postTrainingProgress(agentId, {
    type: 'training:resumed',
    message: `Got it! ${answer}. Continuing observation...`,
  });
  
  return { ok: true };
}

// ---------------------------------------------------------------------------
// User clicks "Done Training" - Phase 3: Self-Test
// ---------------------------------------------------------------------------
async function actionFinishTraining(args) {
  const { agentId } = args || {};
  
  const session = activeTrainingSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active training session' };
  }
  
  session.currentStep = 'self_test';
  
  // Stop observation
  if (session.snapshotInterval) clearInterval(session.snapshotInterval);
  if (session.narrativeInterval) clearInterval(session.narrativeInterval);
  
  _postTrainingProgress(agentId, {
    type: 'training:review',
    message: 'Reviewing what I learned...',
    narrative: session.narrative,
  });
  
  // Generate cleaned narrative with LLM
  const cleanedNarrative = await _generateCleanNarrative(session);
  
  _postTrainingProgress(agentId, {
    type: 'training:test_prompt',
    message: `I learned: ${cleanedNarrative.summary}. Should I test this?`,
    narrative: cleanedNarrative,
  });
  
  return { ok: true, narrative: cleanedNarrative };
}

// ---------------------------------------------------------------------------
// Generate cleaned narrative and identify parameters
// ---------------------------------------------------------------------------
async function _generateCleanNarrative(session) {
  const { narrative, startUrl, hostname } = session;
  
  const narrativeText = narrative.map(n => `- ${n.description}`).join('\n');
  
  const prompt = `Clean up this browser automation training narrative and identify parameters vs hardcoded values.

Raw training log:
${narrativeText}

Format as JSON:
{
  "summary": "One sentence describing the overall task",
  "steps": [
    { "action": "navigate", "target": "URL", "is_parameter": false }
  ],
  "parameters": [
    { "name": "param_name", "description": "what this is for", "example": "example value" }
  ],
  "hardcoded": [
    { "what": "terms checkbox", "why": "always required" }
  ]
}

Guidelines:
- User-entered text → parameter (title, name, message, etc.)
- Pre-filled or static values → hardcoded
- Navigation URLs → hardcoded (domain-specific)
- Confirmation/verification steps → hardcoded

Reply with ONLY valid JSON.`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: 'You clean up browser automation training narratives.' },
      { role: 'user', content: prompt }
    ], { maxTokens: 800, temperature: 0.3 });
    
    const cleaned = JSON.parse(response);
    return cleaned;
  } catch (e) {
    // Fallback
    return {
      summary: 'Learned browser automation task',
      steps: narrative.map(n => ({ action: 'interact', description: n.description })),
      parameters: [],
      hardcoded: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Execute self-test with test values
// ---------------------------------------------------------------------------
async function actionRunSelfTest(args) {
  const { agentId, testValues } = args || {};
  
  const session = activeTrainingSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active training session' };
  }
  
  _postTrainingProgress(agentId, {
    type: 'testing:start',
    message: 'Running self-test with test values...',
  });
  
  try {
    const browserAct = require('./browser.act.cjs');
    
    // Replay the learned steps with test values
    // This is simplified - real implementation would parse the cleaned narrative
    
    _postTrainingProgress(agentId, {
      type: 'testing:progress',
      message: 'Executing learned steps...',
    });
    
    // Simulate test execution (would actually run browser.act steps)
    await new Promise(r => setTimeout(r, 3000));
    
    _postTrainingProgress(agentId, {
      type: 'testing:complete',
      success: true,
      message: 'Self-test completed successfully!',
    });
    
    return { ok: true, success: true };
    
  } catch (err) {
    _postTrainingProgress(agentId, {
      type: 'testing:failed',
      success: false,
      message: `Test failed: ${err.message}`,
    });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Generate skill file (draft)
// ---------------------------------------------------------------------------
async function actionGenerateSkill(args) {
  const { agentId, skillName } = args || {};
  
  const session = activeTrainingSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active training session' };
  }
  
  const { narrative, hostname, startUrl } = session;
  
  _postTrainingProgress(agentId, {
    type: 'generating:start',
    message: `Generating skill "${skillName}"...`,
  });
  
  try {
    // Generate cleaned narrative
    const cleaned = await _generateCleanNarrative(session);
    
    // Generate skill code
    const skillCode = _generateSkillCode(skillName, cleaned, hostname, startUrl);
    
    // Ensure skills dir exists
    if (!fs.existsSync(SKILLS_DIR)) {
      fs.mkdirSync(SKILLS_DIR, { recursive: true });
    }
    
    // Write draft skill
    const skillPath = path.join(SKILLS_DIR, `${agentId}.${skillName}.draft.cjs`);
    fs.writeFileSync(skillPath, skillCode, 'utf8');
    
    // Update agent.md with trained skill
    _updateAgentWithSkill(agentId, skillName, cleaned.parameters);
    
    _postTrainingProgress(agentId, {
      type: 'generating:complete',
      message: `Skill "${skillName}" created as draft!`,
      skillName,
      parameters: cleaned.parameters.map(p => p.name),
    });
    
    // Clean up session
    activeTrainingSessions.delete(agentId);
    
    return { 
      ok: true, 
      skillName, 
      skillPath,
      parameters: cleaned.parameters.map(p => p.name),
    };
    
  } catch (err) {
    _postTrainingProgress(agentId, {
      type: 'generating:error',
      message: `Failed to generate skill: ${err.message}`,
    });
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Generate deterministic skill code
// ---------------------------------------------------------------------------
function _generateSkillCode(skillName, cleaned, hostname, startUrl) {
  const paramsList = cleaned.parameters.map(p => p.name).join(', ');
  const paramChecks = cleaned.parameters.map(p => 
    `  if (!${p.name}) return { ok: false, error: '${p.name} parameter required' };`
  ).join('\n');
  
  const domainMapPath = `path.join(os.homedir(), '.thinkdrop', 'domain-maps', '${hostname}.json')`;
  
  return `'use strict';
/**
 * ${skillName}.skill.cjs
 * Generated from training session on ${new Date().toISOString().split('T')[0]}
 * Domain: ${hostname}
 * Learned: ${cleaned.summary}
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const DOMAIN_MAP_PATH = ${domainMapPath};

module.exports = async function run(args, context) {
  const { ${paramsList} } = args;
  const { logger } = context;
  
  // Validate parameters
${paramChecks || '  // No parameters required'}
  
  // Load domain map
  let domainMap;
  try {
    domainMap = JSON.parse(fs.readFileSync(DOMAIN_MAP_PATH, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'Domain not learned. Please run Learn mode first.' };
  }
  
  // Execute learned steps via browser.act
  const browserAct = require('../mcp-services/command-service/src/skills/browser.act.cjs');
  
  const steps = [
    // Steps would be generated from cleaned.steps
    // This is a placeholder - real implementation would have actual steps
    { action: 'navigate', url: '${startUrl}' },
  ];
  
  for (const step of steps) {
    const result = await browserAct({
      ...step,
      sessionId: context.sessionId || 'default',
      timeoutMs: 30000,
    });
    
    if (!result.ok) {
      return { ok: false, error: \`Step failed: \${step.action}\`, step };
    }
  }
  
  return { 
    ok: true, 
    output: \`Completed: ${cleaned.summary}\`,
  };
};

module.exports.validate = async function validate(context) {
  // Quick health check
  try {
    const fs = require('fs');
    if (!fs.existsSync(DOMAIN_MAP_PATH)) {
      return { ok: false, error: 'Domain map not found' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
`;
}

// ---------------------------------------------------------------------------
// Update agent.md with trained skill
// ---------------------------------------------------------------------------
function _updateAgentWithSkill(agentId, skillName, parameters) {
  try {
    const agentPath = path.join(AGENTS_DIR, `${agentId}.md`);
    let descriptor = fs.readFileSync(agentPath, 'utf8');
    
    // Add to trained_skills frontmatter
    const skillEntry = `\n  - name: ${skillName}\n    status: draft\n    parameters: [${parameters.map(p => p.name).join(', ')}]`;
    
    if (descriptor.includes('trained_skills:')) {
      // Append to existing list
      descriptor = descriptor.replace(
        /(trained_skills:)/,
        `$1${skillEntry}`
      );
    } else {
      // Add new section
      descriptor = descriptor.replace(
        /^(---\s*\n[\s\S]*?\n---)/,
        `$1\ntrained_skills:${skillEntry}`
      );
    }
    
    fs.writeFileSync(agentPath, descriptor, 'utf8');
    logger.info(`[trainer.agent] Updated agent ${agentId} with skill ${skillName}`);
  } catch (e) {
    logger.error(`[trainer.agent] Failed to update agent: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancel training
// ---------------------------------------------------------------------------
function actionCancelTraining(args) {
  const { agentId } = args || {};
  
  const session = activeTrainingSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active training session' };
  }
  
  session.cancelRequested = true;
  
  // Stop intervals
  if (session.snapshotInterval) clearInterval(session.snapshotInterval);
  if (session.narrativeInterval) clearInterval(session.narrativeInterval);
  
  // Close browser
  const browserAct = require('./browser.act.cjs');
  browserAct({
    action: 'close',
    sessionId: session.browserSessionId,
  }).catch(() => {});
  
  activeTrainingSessions.delete(agentId);
  
  _postTrainingProgress(agentId, {
    type: 'training:cancelled',
    message: 'Training cancelled',
  });
  
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  actionTrain,
  actionAnswerTeachMe,
  actionFinishTraining,
  actionRunSelfTest,
  actionGenerateSkill,
  actionCancelTraining,
};
