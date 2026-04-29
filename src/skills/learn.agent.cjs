'use strict';
// ---------------------------------------------------------------------------
// learn.agent.cjs — Blocking learn mode for agent domain exploration
//
// This skill provides a blocking learning experience for the user:
// 1. Scans the domain using explore.agent scan mode
// 2. Updates the agent .md file with discovered states
// 3. Sends real-time progress updates to the Electron UI
// 4. Blocks other ThinkDrop interactions until complete
//
// Called from main.js when user clicks "Learn" on an agent
// ---------------------------------------------------------------------------

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const logger  = require('../logger.cjs');

const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const AGENTS_DIR   = path.join(os.homedir(), '.thinkdrop', 'agents');

// Track active learn sessions
const activeLearnSessions = new Map(); // agentId -> { startTime, progress, cancelRequested }

// ---------------------------------------------------------------------------
// Progress reporting to Electron UI
// ---------------------------------------------------------------------------
function _postLearnProgress(agentId, payload) {
  try {
    const data = JSON.stringify({ ...payload, agentId, timestamp: Date.now() });
    const req = http.request({
      hostname: '127.0.0.1',
      port: OVERLAY_PORT,
      path: '/learn.progress',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => { /* ignore response */ });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main learn action — progressive learning cascade
//
// Cascade: explore (scan) → web research → video tutorial → needs training
// ---------------------------------------------------------------------------
const MIN_STATES_THRESHOLD = 3;

async function actionLearn(args) {
  const {
    agentId,
    maxScanDepth = 2,
    _progressCallbackUrl,
    options = {},
  } = args || {};

  if (!agentId) {
    return { ok: false, error: 'agentId is required' };
  }

  // Check if already learning
  if (activeLearnSessions.has(agentId)) {
    return { ok: false, error: 'Learning already in progress for this agent' };
  }

  // Load agent descriptor
  const agentPath = path.join(AGENTS_DIR, `${agentId}.agent.md`);
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

  // Extract user_goals from frontmatter
  const goalsMatch = descriptor.match(/^user_goals:[\s\S]*?(?=^\w|$)/m);
  let userGoals = [];
  if (goalsMatch) {
    const goalLines = goalsMatch[0].split('\n').slice(1);
    userGoals = goalLines
      .map(line => line.match(/^\s*-\s*"?([^"\n]+)"?/)?.[1])
      .filter(Boolean);
  }
  const primaryGoal = userGoals[0] || 'automate tasks';

  // Create learn session
  const session = {
    agentId,
    startUrl,
    hostname,
    primaryGoal,
    startTime: Date.now(),
    progress: 0,
    cancelRequested: false,
    discoveredStates: [],
    insights: [],
  };
  activeLearnSessions.set(agentId, session);

  logger.info(`[learn.agent] Starting progressive learn mode for ${agentId}`);
  _postLearnProgress(agentId, { type: 'learn:start', hostname, startUrl, goal: primaryGoal });

  try {
    // === STEP 0: AUTHENTICATION CHECK ===
    // Check if auth is required and prompt user to log in first
    const signInUrlMatch = descriptor.match(/^sign_in_url:\s*(.+)$/m);
    const authPatternMatch = descriptor.match(/^auth_success_pattern:\s*(.+)$/m);
    const requiresAuth = signInUrlMatch || /login|signin|auth/i.test(startUrl);
    
    if (requiresAuth) {
      _postLearnProgress(agentId, { 
        type: 'learn:auth_required', 
        message: 'Authentication required. Please log in to continue learning.'
      });
      
      // Use browser.agent's waitForAuth pattern
      const { browserAct } = require('./browser.act.cjs');
      const signInUrl = signInUrlMatch ? signInUrlMatch[1].trim() : startUrl;
      const authPattern = authPatternMatch ? authPatternMatch[1].trim() : hostname;
      
      logger.info(`[learn.agent] Prompting for auth at ${signInUrl}`);
      
      // Open visible browser for auth (headed mode)
      const authResult = await browserAct({
        action: 'waitForAuth',
        url: signInUrl,
        authSuccessUrl: authPattern,
        profile: agentId.replace(/\./g, '_'),
        headed: true,  // Always visible for auth
        timeout: 120000,  // 2 minute timeout for auth
      });
      
      if (!authResult.ok) {
        _postLearnProgress(agentId, { 
          type: 'learn:auth_failed', 
          error: 'Authentication not completed. Learn mode cancelled.'
        });
        return { ok: false, error: 'Authentication required but not completed' };
      }
      
      _postLearnProgress(agentId, { 
        type: 'learn:auth_success', 
        message: 'Authenticated successfully. Proceeding with scan...'
      });
    }

    // === STEP 1: EXPLORE AGENT SCAN ===
    _postLearnProgress(agentId, { type: 'learn:exploring', message: 'Scanning domain structure...' });
    
    const exploreAgent = require('./explore.agent.cjs');
    const exploreResult = await exploreAgent.scanDomain({
      url: startUrl,
      agentId,
      maxScanDepth,
      _progressCallbackUrl,
      _trigger: 'learn_mode',
      headed: options.headed || false,
    });

    if (session.cancelRequested) {
      _postLearnProgress(agentId, { type: 'learn:cancelled' });
      return { ok: false, reason: 'cancelled' };
    }

    if (!exploreResult.ok) {
      _postLearnProgress(agentId, { type: 'learn:error', error: exploreResult.error });
      return { ok: false, error: exploreResult.error };
    }

    // Get discovered states
    const domainMapPath = path.join(os.homedir(), '.thinkdrop', 'domain-maps', `${hostname}.json`);
    let discoveredStates = [];
    
    if (fs.existsSync(domainMapPath)) {
      try {
        const domainMap = JSON.parse(fs.readFileSync(domainMapPath, 'utf8'));
        discoveredStates = Object.keys(domainMap.states || {});
        session.discoveredStates = discoveredStates;
        logger.info(`[learn.agent] Step 1 complete: ${discoveredStates.length} states discovered`);
      } catch (e) {
        logger.warn(`[learn.agent] Failed to read domain map: ${e.message}`);
      }
    }

    // === STEP 2: WEB RESEARCH (if insufficient states) ===
    if (discoveredStates.length < MIN_STATES_THRESHOLD) {
      _postLearnProgress(agentId, { 
        type: 'learn:web_research', 
        message: `Found only ${discoveredStates.length} states. Researching web for guidance...` 
      });

      try {
        const webAgent = require('./web.agent.cjs');
        const webResult = await webAgent({
          action: 'get_tutorial_steps',
          query: `${primaryGoal} on ${hostname}`
        });

        if (webResult.ok && webResult.mergedSteps?.length > 0) {
          session.insights.push({
            source: 'web',
            steps: webResult.mergedSteps,
            confidence: webResult.confidence
          });
          
          _postLearnProgress(agentId, {
            type: 'learn:web_learned',
            message: `Found ${webResult.mergedSteps.length} steps from web research`,
            stepCount: webResult.mergedSteps.length
          });

          // Re-scan with web insights
          _postLearnProgress(agentId, { type: 'learn:re_exploring', message: 'Re-scanning with web insights...' });
          
          const exploreResult2 = await exploreAgent.scanDomain({
            url: startUrl,
            agentId,
            maxScanDepth,
            _progressCallbackUrl,
            _trigger: 'learn_mode_web_enhanced',
            guidedBy: webResult.mergedSteps,
            headed: options.headed || false,
          });

          if (exploreResult2.ok && fs.existsSync(domainMapPath)) {
            try {
              const domainMap2 = JSON.parse(fs.readFileSync(domainMapPath, 'utf8'));
              discoveredStates = Object.keys(domainMap2.states || {});
              session.discoveredStates = discoveredStates;
            } catch (e) {
              logger.warn(`[learn.agent] Failed to read updated domain map: ${e.message}`);
            }
          }
        }
      } catch (err) {
        logger.warn(`[learn.agent] Web research failed: ${err.message}`);
      }
    }

    // === STEP 3: VIDEO TUTORIAL (if still insufficient) ===
    if (discoveredStates.length < MIN_STATES_THRESHOLD) {
      _postLearnProgress(agentId, { 
        type: 'learn:video_search', 
        message: `Found ${discoveredStates.length} states. Searching for video tutorials...` 
      });

      try {
        // Note: video.agent requires browserAct dependency - simplified for now
        // In production, this would integrate with a browser session
        _postLearnProgress(agentId, { 
          type: 'learn:video_skipped', 
          message: 'Video analysis queued for future enhancement' 
        });
      } catch (err) {
        logger.warn(`[learn.agent] Video research failed: ${err.message}`);
      }
    }

    // === STEP 4: DETERMINE IF TRAINING NEEDED ===
    const needsTraining = discoveredStates.length < MIN_STATES_THRESHOLD;

    // Update agent descriptor
    _updateAgentWithLearnedStates(agentPath, descriptor, discoveredStates, session.insights);

    const duration = Date.now() - session.startTime;
    
    if (needsTraining) {
      _postLearnProgress(agentId, { 
        type: 'learn:needs_training', 
        message: `Could not fully auto-learn (${discoveredStates.length} states found). Training recommended.`,
        states: discoveredStates,
        stateCount: discoveredStates.length,
        duration,
      });

      return {
        ok: true,
        agentId,
        hostname,
        states: discoveredStates,
        stateCount: discoveredStates.length,
        duration,
        needsTraining: true,
        reason: 'Insufficient states discovered through automated methods',
      };
    }

    _postLearnProgress(agentId, { 
      type: 'learn:complete', 
      message: `Successfully learned ${discoveredStates.length} states`,
      states: discoveredStates,
      duration,
      stateCount: discoveredStates.length,
      insights: session.insights.length
    });

    logger.info(`[learn.agent] Progressive learn complete for ${agentId} — ${discoveredStates.length} states, ${session.insights.length} insights, ${duration}ms`);

    return {
      ok: true,
      agentId,
      hostname,
      states: discoveredStates,
      stateCount: discoveredStates.length,
      duration,
      needsTraining: false,
      insights: session.insights,
    };

  } catch (err) {
    logger.error(`[learn.agent] Learn mode error: ${err.message}`);
    _postLearnProgress(agentId, { type: 'learn:error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeLearnSessions.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Update agent .md file with learned states and insights
// ---------------------------------------------------------------------------
function _updateAgentWithLearnedStates(agentPath, descriptor, states, insights = []) {
  try {
    let updated = descriptor;
    
    // Update status based on learning success
    const status = states.length >= MIN_STATES_THRESHOLD ? 'learned' : 'needs_training';
    updated = updated.replace(/^status:\s*.+$/m, `status: ${status}`);
    
    // Add or update last_learned timestamp
    const now = new Date().toISOString();
    if (/^last_learned:\s*.+$/m.test(updated)) {
      updated = updated.replace(/^last_learned:\s*.+$/m, `last_learned: ${now}`);
    } else {
      updated = updated.replace(/^(status:\s*.*)$/m, `$1\nlast_learned: ${now}`);
    }
    
    // Add or update learned_states list
    if (states.length > 0) {
      const statesYaml = states.map(s => `  - ${s}`).join('\n');
      
      if (/^learned_states:/m.test(updated)) {
        updated = updated.replace(/learned_states:[\s\S]*?(?=\n\w|$)/, `learned_states:\n${statesYaml}`);
      } else {
        updated = updated.replace(/^(last_learned:\s*.*)$/m, `$1\nlearned_states:\n${statesYaml}`);
      }
    }
    
    // Add research insights if available
    if (insights.length > 0) {
      const webInsight = insights.find(i => i.source === 'web');
      if (webInsight && !updated.includes('## Research Insights')) {
        const insightsSection = `\n\n## Research Insights\n\n### Web Research\n${webInsight.steps.map(s => `- ${s.text}`).join('\n')}`;
        updated += insightsSection;
      }
    }
    
    // Add ## Learned States section if not present
    if (!updated.includes('## Learned States')) {
      const statesSection = `\n\n## Learned States\n${states.map(s => `- **${s}**: ${s.replace(/_/g, ' ')}`).join('\n')}`;
      updated += statesSection;
    }
    
    fs.writeFileSync(agentPath, updated, 'utf8');
    logger.info(`[learn.agent] Updated agent file with ${states.length} states, ${insights.length} insights`);
  } catch (err) {
    logger.error(`[learn.agent] Failed to update agent file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cancel learn mode
// ---------------------------------------------------------------------------
function actionCancelLearn(args) {
  const { agentId } = args || {};
  
  if (!agentId) {
    return { ok: false, error: 'agentId is required' };
  }
  
  const session = activeLearnSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active learn session for this agent' };
  }
  
  session.cancelRequested = true;
  _postLearnProgress(agentId, { type: 'learn:cancelling' });
  
  return { ok: true, message: 'Learn mode cancellation requested' };
}

// ---------------------------------------------------------------------------
// Get learn status
// ---------------------------------------------------------------------------
function actionGetLearnStatus(args) {
  const { agentId } = args || {};
  
  if (agentId) {
    const session = activeLearnSessions.get(agentId);
    if (!session) {
      return { ok: true, active: false, agentId };
    }
    
    return {
      ok: true,
      active: true,
      agentId,
      progress: session.progress,
      startTime: session.startTime,
      discoveredStates: session.discoveredStates,
    };
  }
  
  // Return all active sessions
  const sessions = Array.from(activeLearnSessions.entries()).map(([id, s]) => ({
    agentId: id,
    progress: s.progress,
    startTime: s.startTime,
  }));
  
  return { ok: true, active: sessions.length > 0, sessions };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  actionLearn,
  actionCancelLearn,
  actionGetLearnStatus,
};
