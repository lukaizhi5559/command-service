'use strict';

/**
 * skill: external.skill
 *
 * Executor for user-installed external skills registered in the installed_skills DB.
 * Skills must reside inside ~/.thinkdrop/skills/ (security boundary).
 *
 * Args schema:
 * {
 *   name:      string   — registered skill name (e.g. "check.weather.daily")
 *   args?:     object   — input args to pass to the skill (from plan step)
 *   timeoutMs: number   — max execution time, default 30000
 * }
 *
 * Returns:
 * {
 *   ok:        boolean
 *   output:    string
 *   error?:    string
 *   skillName: string
 *   execType:  string
 * }
 *
 * Execution types:
 *   node  — require(exec_path) and call module.exports(args) → string|object
 *   shell — spawn as bash script with JSON args piped to stdin
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const SKILLS_BASE_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;

function validateExecPath(execPath) {
  const resolved = path.resolve(execPath);
  if (!resolved.startsWith(SKILLS_BASE_DIR)) {
    throw new Error(
      `Security violation: exec_path "${execPath}" is outside the allowed skills directory (${SKILLS_BASE_DIR})`
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Skill file not found: ${resolved}`);
  }
  return resolved;
}

/**
 * Fallback for creator-built skills: checks ~/.thinkdrop/skills/<dotName>/
 * for index.py (Python) first, then index.cjs (Node.js).
 * Works even when user-memory is unavailable or returns UNAUTHORIZED.
 * Tries both dot-notation (gmail.daily) and kebab-notation (gmail-daily) as dir names.
 */
async function fetchSkillRecordFromUserSkillsDir(name) {
  try {
    const candidates = [
      name,                          // gmail.daily   (dot-notation)
      name.replace(/\./g, '_'),      // gmail_daily   (underscore — canonical dir name)
      name.replace(/\./g, '-'),      // gmail-daily   (kebab fallback)
    ];
    // Check for Python skills first, then Node.js
    for (const candidate of candidates) {
      const pythonPath = path.join(SKILLS_BASE_DIR, candidate, 'index.py');
      if (fs.existsSync(pythonPath)) {
        logger.info(`[external.skill] Found Python skill at ${pythonPath}`);
        return {
          name,
          execPath: pythonPath,
          execType: 'python',
          enabled: true,
          source: 'user-skills-dir',
        };
      }
    }
    for (const candidate of candidates) {
      const nodePath = path.join(SKILLS_BASE_DIR, candidate, 'index.cjs');
      if (fs.existsSync(nodePath)) {
        logger.info(`[external.skill] Found Node.js skill at ${nodePath}`);
        return {
          name,
          execPath: nodePath,
          execType: 'node',
          enabled: true,
          source: 'user-skills-dir',
        };
      }
    }

    // Trainer recipe fallback: e.g. spotify/spotify.create.music.playlist.skill.json
    const firstSegment = name.split('.')[0];
    if (firstSegment) {
      const agentSkillDir = path.join(SKILLS_BASE_DIR, firstSegment);
      if (fs.existsSync(agentSkillDir)) {
        const newRecipePath = path.join(agentSkillDir, `${name}.json`);
        if (fs.existsSync(newRecipePath)) {
          logger.info(`[external.skill] Found trainer recipe at ${newRecipePath}`);
          return { name, execPath: newRecipePath, execType: 'recipe', enabled: true, source: 'user-skills-dir' };
        }
        const legacyRecipePath = path.join(agentSkillDir, `${name}.skill.json`);
        if (fs.existsSync(legacyRecipePath)) {
          logger.info(`[external.skill] Found trainer recipe at ${legacyRecipePath}`);
          return { name, execPath: legacyRecipePath, execType: 'recipe', enabled: true, source: 'user-skills-dir' };
        }
      }
    }
    return null;
  } catch (e) {
    logger.warn(`[external.skill] user-skills-dir fallback failed: ${e.message}`);
    return null;
  }
}

// ── Build context object passed as 2nd arg to skill run(args, context) ────────
// Resolves secrets from keytar using the skill name as namespace.
// context.secrets keys match the uppercase names declared in contract_md
// context.oauth is a map of provider → parsed token object (from skills:oauth-connect flow)
// context._missingOAuth lists providers that had no token (caller should gate on this)
async function buildSkillContext(skillName, secretKeys, oauthProviders) {
  let keytar = null;
  try { keytar = require('keytar'); } catch (_) {}

  const secrets = {};
  if (keytar && secretKeys && secretKeys.length > 0) {
    await Promise.all(secretKeys.map(async (key) => {
      try {
        // Try namespaced key first (skill:<name>:<key>), then bare key as fallback
        const val = (await keytar.getPassword('thinkdrop', `skill:${skillName}:${key}`)) ||
                    (await keytar.getPassword('thinkdrop', key));
        if (val) secrets[key] = val;
      } catch (_) {}
    }));
  }

  // Load OAuth tokens stored by the Skills tab Connect flow.
  // Resolution order:
  //   1. skill-specific key: oauth:<provider>:<skillName>  (set by per-skill Connect flow)
  //   2. global key:         oauth:<provider>              (set by Connections tab Connect)
  // Attempts token refresh for providers with short-lived access tokens (Google, Microsoft, etc.).
  // Tracks providers with no token so callers can surface a helpful error.
  const oauth = {};
  const missingOAuth = [];
  if (keytar && oauthProviders && oauthProviders.length > 0) {
    let oauthRefresh = null;
    try { oauthRefresh = require('../oauth-refresh.cjs'); } catch (_) {}

    await Promise.all(oauthProviders.map(async (provider) => {
      try {
        // Attempt proactive token refresh for providers with expiring access tokens.
        // Returns the (possibly refreshed) blob, or null if no token is stored.
        let blob = null;
        if (oauthRefresh) {
          blob = await oauthRefresh.refreshTokenIfNeeded(keytar, provider, skillName);
        }
        // Fallback for non-expiring providers or when refresh module unavailable:
        // load directly from keytar (skill-specific → global).
        if (!blob) {
          let raw = await keytar.getPassword('thinkdrop', `oauth:${provider}:${skillName}`);
          if (!raw) raw = await keytar.getPassword('thinkdrop', `oauth:${provider}`);
          if (raw) {
            try { blob = JSON.parse(raw); } catch(_) { blob = { access_token: raw }; }
          }
        }

        if (blob) {
          // A blob with only client credentials (no access/refresh token) means the user
          // hasn't completed the Connect flow yet — treat as missing.
          if (!blob.access_token && !blob.refresh_token) {
            missingOAuth.push(provider);
          } else {
            oauth[provider] = blob;
          }
        } else {
          missingOAuth.push(provider);
        }
      } catch (_) {
        missingOAuth.push(provider);
      }
    }));
  }

  // Inject shared infrastructure so skills can use context.db and context.llm
  // without needing to know the absolute path to command-service internals.
  let db = null;
  let llm = null;
  try { db = require('../skill-helpers/skill-db.cjs'); } catch (_) {}
  try { llm = require('../skill-helpers/skill-llm.cjs'); } catch (_) {}

  return {
    logger,
    secrets,
    oauth,
    skillName,
    db,   // context.db.get/set/remember/recall/getSkill etc.
    llm,  // context.llm.ask(prompt) / context.llm.askWithMessages(messages)
    _missingOAuth: missingOAuth, // providers with no stored token (caller gates on this)
  };
}

async function runNodeSkill(execPath, args, timeoutMs, context) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Node skill timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      delete require.cache[require.resolve(execPath)];
      const skillModule = require(execPath);
      // Support three export styles:
      // 1. module.exports = function(args, ctx) {}          — legacy function style
      // 2. module.exports = { run(args, ctx) {} }           — object style (domain skills from explore.agent)
      // 3. module.exports = { default: function(args) {} }  — ES module compat
      const skillFn = typeof skillModule === 'function'
        ? skillModule
        : (typeof skillModule?.run === 'function'
          ? (args, ctx) => skillModule.run(args, ctx)
          : skillModule?.default);

      if (typeof skillFn !== 'function') {
        clearTimeout(timer);
        reject(new Error(`Skill module at "${execPath}" must export a function or an object with a run() method`));
        return;
      }

      Promise.resolve(skillFn(args || {}, context || { logger, secrets: {} }))
        .then((result) => {
          clearTimeout(timer);
          const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          // Preserve sessionFileCreations if skill returned it (for "newly created file" references)
          const sessionFileCreations = result?.sessionFileCreations || null;
          resolve({ ok: true, output, sessionFileCreations });
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function runShellSkill(execPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const argsJson = JSON.stringify(args || {});

    const child = spawn('bash', [execPath], {
      env: { ...process.env },
      killSignal: 'SIGTERM'
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.stdin.write(argsJson);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Shell skill timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        reject(new Error(`Shell skill exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Run a Python skill by spawning python3 process with JSON args via stdin
 */
async function runPythonSkill(execPath, args, timeoutMs, context) {
  return new Promise((resolve, reject) => {
    const argsJson = JSON.stringify(args || {});
    const contextJson = JSON.stringify({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      secrets: context?.secrets || {},
      skillName: context?.skillName || 'python-skill',
      db: context?.db || null
    });

    const child = spawn('python3', [execPath], {
      env: { ...process.env, SKILL_CONTEXT: contextJson },
      killSignal: 'SIGTERM'
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // Send args as JSON via stdin
    child.stdin.write(argsJson);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Python skill timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        // Try to parse stdout as JSON (expected format: { ok: true/false, output/error: ... })
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (e) {
        // If not valid JSON, treat as plain text output
        if (code === 0) {
          resolve({ ok: true, output: stdout.trim() });
        } else {
          resolve({ ok: false, error: stderr.trim() || stdout.trim() || 'Python skill failed' });
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // If python3 not found, return clear error
      if (err.message?.includes('ENOENT')) {
        resolve({ ok: false, error: 'Python3 not found. Please install Python 3 to run this skill.' });
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Fetch skill registration from the user-memory service via direct HTTP.
 * The command service is a separate process — no mcpAdapter available here.
 */
async function fetchSkillRecord(name, timeoutMs) {
  const http = require('http');
  const userMemoryUrl = process.env.MCP_USER_MEMORY_URL || process.env.USER_MEMORY_SERVICE_URL || 'http://localhost:3001';
  const apiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'skill.get',
      payload: { name },
      requestId: `ext-skill-${Date.now()}`
    });
    const url = new URL('/skill.get', userMemoryUrl);
    const options = {
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Detect MCP error responses and reject so caller handles them properly
          if (parsed?.status === 'error') {
            reject(new Error(parsed?.error?.message || 'skill.get returned error'));
            return;
          }
          // formatMCPResponse wraps result in { status, data } — unwrap it
          resolve(parsed?.data || null);
        } catch (e) {
          reject(new Error(`Failed to parse skill.get response: ${e.message}`));
        }
      });
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`skill.get request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('response', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

// ── Recipe skill runner ───────────────────────────────────────────────────────
// Executes a trained waypoint recipe (.skill.json) by running each waypoint
// through browser.act in sequence. Params from skillArgs are substituted for
// {{paramRef}} placeholders in fill/paste/select values.
//
// Recipe schema:
//   {
//     name, startUrl, targetUrl, params: [{ name, type, required, description }],
//     waypoints: [{ step, type, selector, altSelectors?, value?, paramRef?, ... }]
//   }
//
// Returns: { ok, output?, error? }
//

// ---------------------------------------------------------------------------
// Agent skill runner: delegates to playwrightAgent with natural language instructions.
// The agent snapshots the live DOM, finds elements by intent, and executes step-by-step.
// No CSS selectors are stored or replayed — the agent adapts to the live page.
// ---------------------------------------------------------------------------
async function runAgentSkill(recipe, skillArgs, timeoutMs) {
  const sessionId = skillArgs?.sessionId;
  if (!sessionId) {
    return { ok: false, error: 'Agent skill execution requires a sessionId' };
  }

  const instructions = recipe.instructions || '';
  if (!instructions) {
    return { ok: false, error: `Agent skill "${recipe.name}" has no instructions` };
  }

  // Build args with defaults from recipe params (use example values if arg is missing)
  const args = { ...(skillArgs || {}) };
  for (const p of recipe.params || []) {
    if (args[p.name] === undefined && p.example !== undefined) {
      args[p.name] = p.example;
    }
  }

  // Fail fast on missing required params (don't let the agent hallucinate values)
  for (const p of recipe.params || []) {
    if (p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === '')) {
      return { ok: false, error: `Missing required parameter: ${p.name}` };
    }
  }

  logger.info(`[external.skill] runAgentSkill: "${recipe.name}" instructions="${instructions.substring(0, 200)}" sessionId=${sessionId}`);

  try {
    // Use the deterministic instruction runner instead of the autonomous playwrightAgent.
    // The runner parses instructions into steps, snapshots the DOM for each step,
    // resolves elements via focused LLM calls, and executes via browserAct directly.
    // This avoids the playwrightAgent's 12-turn loop that restarts tasks and creates
    // duplicate actions (e.g. creating multiple playlists).
    const { runInstructionSkill } = require('./instruction.runner.cjs');
    const result = await runInstructionSkill({
      instructions,
      params: recipe.params || [],
      skillArgs: args,
      startUrl: recipe.startUrl,
      sessionId,
      timeoutMs: timeoutMs || 90000,
    });

    logger.info(`[external.skill] runAgentSkill: "${recipe.name}" ok=${result?.ok}${result?.error ? ' error=' + result.error : ''}`);
    return {
      ok: !!result?.ok,
      output: result?.output || (result?.ok ? `Completed agent skill ${recipe.name}` : ''),
      error: result?.ok ? undefined : (result.error || 'Agent skill failed'),
    };
  } catch (e) {
    logger.error(`[external.skill] runAgentSkill threw: ${e.message}`);
    return { ok: false, error: `Agent skill "${recipe.name}" failed: ${e.message}` };
  }
}

async function runRecipeSkill(resolvedPath, skillArgs, timeoutMs) {
  let recipe;
  try {
    recipe = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Failed to read recipe at ${resolvedPath}: ${e.message}` };
  }

  const sessionId = skillArgs?.sessionId;
  if (!sessionId) {
    return { ok: false, error: 'Recipe execution requires a sessionId' };
  }

  // ── Agent-based skill: delegate to playwrightAgent with natural language instructions ──
  // New format: { execType: "agent", instructions: "...", params: [...], startUrl: "..." }
  // The agent snapshots the live DOM, finds elements by intent, and executes step-by-step.
  if (recipe.execType === 'agent' || (recipe.instructions && !Array.isArray(recipe.waypoints))) {
    logger.info(`[external.skill] Agent skill "${recipe.name}" — delegating to playwrightAgent`);
    return await runAgentSkill(recipe, skillArgs, timeoutMs);
  }

  // ── Composite recipe: chain multiple .skill.json files ───────────────────
  // A composite .recipe.json has a `skills: [{ skill: "name.skill" }]` array
  // referencing other skill files in the same directory. We run each in order,
  // passing paramFlow between them (extract returns feed the next skill's args).
  if (Array.isArray(recipe.skills) && recipe.skills.length > 0 && !Array.isArray(recipe.waypoints)) {
    logger.info(`[external.skill] Composite recipe "${recipe.name}" — chaining ${recipe.skills.length} skill(s)`);
    const recipeDir = path.dirname(resolvedPath);
    const chainArgs = { ...(skillArgs || {}) };

    // Initialize args with defaults from recipe params
    for (const p of recipe.params || []) {
      if (chainArgs[p.name] === undefined && p.example !== undefined) {
        chainArgs[p.name] = p.example;
      }
    }

    let totalWaypoints = 0;
    for (let i = 0; i < recipe.skills.length; i++) {
      const skillRef = recipe.skills[i];
      const skillName = skillRef.skill || skillRef.name;
      if (!skillName) {
        return { ok: false, error: `Composite recipe ${recipe.name}: skill #${i + 1} has no name` };
      }

      // Resolve the referenced skill file from the same directory
      const skillFileCandidates = [
        path.join(recipeDir, `${skillName}.json`),
        path.join(recipeDir, `${skillName}.skill.json`),
        path.join(recipeDir, `${skillName}.recipe.json`),
      ];
      let skillFilePath = null;
      for (const candidate of skillFileCandidates) {
        if (fs.existsSync(candidate)) { skillFilePath = candidate; break; }
      }
      if (!skillFilePath) {
        return { ok: false, error: `Composite recipe ${recipe.name}: skill "${skillName}" not found in ${recipeDir}` };
      }

      logger.info(`[external.skill] Composite recipe step ${i + 1}/${recipe.skills.length}: running ${skillName} from ${skillFilePath}`);

      // Run the referenced skill (which may itself be a single-skill .skill.json
      // or a nested composite .recipe.json — recursion handles both)
      const subResult = await runRecipeSkill(skillFilePath, chainArgs, timeoutMs);
      if (!subResult.ok) {
        return { ok: false, error: `Composite recipe ${recipe.name} failed at skill "${skillName}": ${subResult.error}` };
      }

      totalWaypoints += subResult.waypointCount || 0;

      // Propagate extract returns into chainArgs for the next skill
      if (subResult.returns && typeof subResult.returns === 'object') {
        for (const [key, val] of Object.entries(subResult.returns)) {
          chainArgs[key] = val;
        }
        logger.info(`[external.skill] Composite recipe: propagated returns from ${skillName}: ${Object.keys(subResult.returns).join(', ')}`);
      }
    }

    return { ok: true, output: `Completed composite recipe ${recipe.name} (${recipe.skills.length} skills, ${totalWaypoints} waypoints)`, waypointCount: totalWaypoints };
  }

  // ── Single-skill recipe: run waypoints directly ──────────────────────────
  const waypoints = Array.isArray(recipe.waypoints) ? recipe.waypoints : [];
  if (waypoints.length === 0) {
    return { ok: false, error: `Recipe ${recipe.name} has no waypoints and no chained skills` };
  }

  // Build args with defaults from recipe params
  const args = { ...(skillArgs || {}) };
  for (const p of recipe.params || []) {
    if (args[p.name] === undefined && p.example !== undefined) {
      args[p.name] = p.example;
    }
  }

  // Resolve params in a value string like "{{playlist_name}}"
  const resolveValue = (value) => {
    if (typeof value !== 'string' || !value.includes('{{')) return value;
    return value.replace(/\{\{(\s*[^}\\s]+\s*)\}\}/g, (_, rawName) => {
      const name = rawName.trim();
      return args[name] !== undefined ? String(args[name]) : _;
    });
  };

  // If the recipe does not start with a navigation, jump to startUrl first
  const effectiveWaypoints = waypoints.slice();
  if (effectiveWaypoints[0].type !== 'navigate' && recipe.startUrl) {
    effectiveWaypoints.unshift({ step: 0, type: 'navigate', url: recipe.startUrl });
  }

  const actionTimeout = Math.min(timeoutMs || 15000, 30000);
  const returns = {};

  for (const wp of effectiveWaypoints) {
    const value = resolveValue(wp.value || '');

    // Navigate waypoints don't need selector resolution
    if (wp.type === 'navigate') {
      try {
        const res = await browserAct({ sessionId, action: 'navigate', url: wp.url || recipe.startUrl, timeoutMs: actionTimeout });
        if (res && !res.ok) {
          return { ok: false, error: `Waypoint ${wp.step} (navigate) failed: ${res.error || 'unknown'}` };
        }
      } catch (e) {
        return { ok: false, error: `Waypoint ${wp.step} (navigate) threw: ${e.message}` };
      }
      continue;
    }

    // Extract waypoints — not yet implemented
    if (wp.type === 'extract') {
      logger.info(`[external.skill] Extract waypoint ${wp.step} skipped in runtime (not yet implemented)`);
      continue;
    }

    // Build candidate selectors: primary + all altSelectors
    const selectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);

    // Determine the browserAct action and extra args for this waypoint type
    const actionMap = {
      click:     { action: 'click',  extraArgs: {} },
      dblclick:  { action: 'click',  extraArgs: {} },
      rightclick:{ action: 'click',  extraArgs: {} },
      fill:      { action: 'fill',   extraArgs: { text: value } },
      paste:     { action: 'type',   extraArgs: { text: value } },
      select:    { action: 'select', extraArgs: { value } },
      check:     { action: 'check',  extraArgs: { checked: !!wp.checked } },
      submit:    { action: 'press',  extraArgs: { key: 'Enter' } },
      keycombo:  { action: 'press',  extraArgs: { key: wp.key || 'Enter' } },
    };
    const actionInfo = actionMap[wp.type];
    if (!actionInfo) {
      return { ok: false, error: `Unknown waypoint type: ${wp.type}` };
    }

    let res = null;
    let lastError = '';

    // ── Fast path: try each candidate selector ──────────────────────────
    for (const sel of selectors) {
      try {
        res = await browserAct({ sessionId, selector: sel, action: actionInfo.action, ...actionInfo.extraArgs, timeoutMs: actionTimeout });
        if (res && res.ok) break;
        lastError = res?.error || 'not found';
      } catch (e) {
        lastError = e.message;
      }
    }

    // ── LLM path: if all selectors failed, find element by intent ───────
    if (!res || !res.ok) {
      const intent = wp.intent || (wp.elementText ? `${wp.type} the "${wp.elementText}" element` : null);
      if (intent) {
        logger.info(`[external.skill] Waypoint ${wp.step} (${wp.type}): all ${selectors.length} selector(s) failed — trying LLM intent resolution`);
        try {
          const ref = await _resolveElementByIntent(sessionId, intent, wp.elementText, wp.type, actionTimeout);
          if (ref) {
            logger.info(`[external.skill] LLM resolved intent to ref=${ref}`);
            res = await browserAct({ sessionId, selector: ref, action: actionInfo.action, ...actionInfo.extraArgs, timeoutMs: actionTimeout });
            if (!res || !res.ok) {
              lastError = res?.error || `LLM ref ${ref} failed`;
            }
          } else {
            lastError = `LLM could not find element for intent: "${intent}"`;
          }
        } catch (e) {
          lastError = `LLM resolution error: ${e.message}`;
        }
      }
    }

    if (!res || !res.ok) {
      const triedCount = selectors.length + (wp.intent || wp.elementText ? 1 : 0);
      return { ok: false, error: `Waypoint ${wp.step} (${wp.type}) failed: tried ${triedCount} approach(es) — ${lastError}` };
    }

    // ── Verify expectedResult (if present) ──────────────────────────────
    // For click waypoints with expectedResult: { type: "url_pattern", pattern: "/playlist/*" }
    // Wait briefly for navigation, then check if the URL matches the pattern.
    if (wp.expectedResult && wp.expectedResult.type === 'url_pattern') {
      const pattern = wp.expectedResult.pattern;
      try {
        // Wait 2 seconds for navigation to settle
        await new Promise(r => setTimeout(r, 2000));
        const urlRes = await browserAct({ action: 'getPageText', sessionId, timeoutMs: 5000 });
        // getPageText doesn't give us the URL — use a snapshot which includes URL
        const snapRes = await browserAct({ action: 'snapshot', sessionId, headed: true, timeoutMs: 5000 });
        const currentUrl = snapRes?.url || snapRes?.result?.match(/URL:\s*(\S+)/)?.[1] || '';
        if (currentUrl) {
          // Convert pattern to regex: /playlist/* → /playlist/[^/]+
          const regex = new RegExp(pattern.replace(/\*/g, '[^/?]+').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^/?]+'));
          if (!regex.test(currentUrl)) {
            logger.warn(`[external.skill] Waypoint ${wp.step}: expectedResult pattern ${pattern} did not match URL ${currentUrl} — continuing anyway`);
          } else {
            logger.info(`[external.skill] Waypoint ${wp.step}: expectedResult pattern ${pattern} matched URL ${currentUrl}`);
          }
        }
      } catch (e) {
        logger.warn(`[external.skill] Waypoint ${wp.step}: expectedResult verification error: ${e.message}`);
      }
    }
  }

  return { ok: true, output: `Completed ${effectiveWaypoints.length} waypoints for ${recipe.name}`, waypointCount: effectiveWaypoints.length, returns };
}

// ---------------------------------------------------------------------------
// LLM element resolution: snapshot DOM → ask LLM to find element by intent
// Returns a tdN ref string, or null if the LLM can't find a matching element.
// Uses browser-engine.cjs's buildRefTree via browserAct({ action: 'snapshot' }).
// ---------------------------------------------------------------------------
async function _resolveElementByIntent(sessionId, intent, elementText, actionType, timeoutMs) {
  // Take a DOM snapshot — this tags elements with tdN refs and returns YAML
  const snapResult = await browserAct({ action: 'snapshot', sessionId, headed: true, timeoutMs: Math.min(timeoutMs, 10000) });
  if (!snapResult || !snapResult.ok) {
    logger.warn(`[external.skill] LLM resolution: snapshot failed — ${snapResult?.error || 'unknown'}`);
    return null;
  }

  const snapshotYaml = snapResult.result || snapResult.stdout || '';
  if (!snapshotYaml || snapshotYaml.length < 10) {
    logger.warn(`[external.skill] LLM resolution: empty snapshot`);
    return null;
  }

  // Trim snapshot to avoid token explosion (keep first 4000 chars)
  const trimmedSnapshot = snapshotYaml.length > 4000
    ? snapshotYaml.slice(0, 4000) + '\n... (truncated)'
    : snapshotYaml;

  const systemPrompt = `You find a specific UI element on a web page. You will be given:
1. An intent describing what element to interact with
2. A DOM snapshot with element refs (tdN format)

Return ONLY a JSON object (no markdown, no explanation):
{"ref": "tdN", "confidence": "high|medium|low"}

If no matching element exists, return: {"ref": null}`;

  const userPrompt = `I need to ${intent}.

Current page snapshot:
${trimmedSnapshot}

Which element should I interact with? Return the ref (e.g. td5).`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0, maxTokens: 50, responseTimeoutMs: 10000 });

    const raw = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(raw);
    if (parsed.ref && typeof parsed.ref === 'string') {
      return parsed.ref;
    }
    logger.info(`[external.skill] LLM resolution: no ref returned for intent "${intent}"`);
    return null;
  } catch (e) {
    logger.warn(`[external.skill] LLM resolution parse error: ${e.message}`);
    return null;
  }
}

// ── Project skill runner ───────────────────────────────────────────────────────
// Manages the lifecycle of a project-type skill:
//   1. Read manifest to get project dir + default port
//   2. Check if process is already running (PID file)
//   3. If not running → spawn `node server/index.js` on a random port
//   4. Wait for /health to respond
//   5. POST to /thinkdrop/command with the skill args
//   6. Return result

const _projectProcesses = new Map(); // projectName → { proc, port }

async function runProjectSkill(projectDir, skillArgs, timeoutMs, skillName) {
  const net = require('net');

  // Read manifest
  let manifest = {};
  try {
    const manifestPath = path.join(projectDir, '.thinkdrop-project.json');
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }
  } catch (_) {}

  const defaultPort = manifest.defaultPort || 40000;
  let port = defaultPort;

  // Check if already running
  let existing = _projectProcesses.get(skillName);
  if (existing) {
    // Verify it's still alive
    try {
      await _pingProject(existing.port, 2000);
      port = existing.port;
      logger.info(`[external.skill] Project "${skillName}" already running on port ${port}`);
    } catch (_) {
      // Dead — clean up and restart
      try { existing.proc.kill('SIGTERM'); } catch (_) {}
      _projectProcesses.delete(skillName);
      existing = null;
    }
  }

  if (!existing) {
    // Find an available port
    port = await _findFreePort(defaultPort);

    logger.info(`[external.skill] Starting project "${skillName}" on port ${port}...`);
    const proc = spawn('node', ['server/index.js'], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port) },
      detached: false,
    });

    proc.on('exit', () => { _projectProcesses.delete(skillName); });

    _projectProcesses.set(skillName, { proc, port });

    // Wait for server to be ready
    const ready = await _waitProjectReady(port, 15000);
    if (!ready) {
      try { proc.kill('SIGTERM'); } catch (_) {}
      _projectProcesses.delete(skillName);
      return { ok: false, error: `Project "${skillName}" server failed to start on port ${port}` };
    }
  }

  // POST command
  const action = skillArgs?.action || 'run';
  return new Promise((resolve) => {
    const body = JSON.stringify({ action, args: skillArgs || {} });
    const req = require('http').request({
      hostname: '127.0.0.1',
      port,
      path: '/thinkdrop/command',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: parsed.ok === true, output: JSON.stringify(parsed.result), result: parsed.result, error: parsed.error });
        } catch (_) {
          resolve({ ok: false, error: `Invalid JSON response from project: ${data.slice(0, 200)}` });
        }
      });
    });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, error: `Project command timed out after ${timeoutMs}ms` }); }, timeoutMs);
    req.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    req.on('response', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

async function _pingProject(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action: 'ping' });
    const req = require('http').request({
      hostname: '127.0.0.1', port, path: '/thinkdrop/command', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { resolve(res.statusCode); });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ping timeout')); });
    req.write(body);
    req.end();
  });
}

async function _waitProjectReady(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = require('http').get(`http://127.0.0.1:${port}/health`, res => resolve(res.statusCode));
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

async function _findFreePort(preferredPort) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(preferredPort, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      // Port in use — pick random
      const server2 = net.createServer();
      server2.listen(0, '127.0.0.1', () => {
        const port = server2.address().port;
        server2.close(() => resolve(port));
      });
    });
  });
}

async function run(args) {
  const { name, args: skillArgs, timeoutMs: rawTimeout, secretKeys, execPath: directExecPath, ...flatRest } = args || {};
  const timeoutMs = Math.min(rawTimeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  // Defense-in-depth: LLMs sometimes emit skill params flat alongside "name" instead of
  // nesting them under "args". Merge any unknown top-level keys into skillArgs so the
  // skill receives them regardless of the LLM's output format.
  let mergedSkillArgs = (skillArgs != null || Object.keys(flatRest).length > 0)
    ? { ...(flatRest || {}), ...(skillArgs || {}) }
    : undefined;

  if (!name) {
    return { ok: false, error: 'external.skill requires args.name (the skill name to execute)' };
  }

  logger.info(`[external.skill] Executing skill: ${name}${directExecPath ? ` (direct execPath: ${directExecPath})` : ''}`);

  // ── Direct execPath override ──────────────────────────────────────────────
  // When the caller supplies an absolute execPath (e.g. the training preview
  // runner pointing at a temp .skill.json), skip the user-memory / disk lookup
  // and use it directly. The path must still pass validateExecPath for safety.
  if (directExecPath) {
    let resolvedDirectPath;
    try {
      resolvedDirectPath = validateExecPath(directExecPath);
    } catch (err) {
      return { ok: false, skillName: name, error: `Invalid direct execPath "${directExecPath}": ${err.message}` };
    }
    logger.info(`[external.skill] Using direct execPath override: ${resolvedDirectPath}`);

    // Infer execType from extension
    const ext = path.extname(resolvedDirectPath).toLowerCase();
    let directExecType = 'recipe';
    if (ext === '.cjs' || ext === '.js') directExecType = 'node';
    else if (ext === '.py') directExecType = 'python';
    else if (ext === '.sh') directExecType = 'shell';

    try {
      let result;
      if (directExecType === 'recipe') {
        result = await runRecipeSkill(resolvedDirectPath, mergedSkillArgs, timeoutMs);
      } else if (directExecType === 'node') {
        const context = await buildSkillContext(name, [], []);
        result = await runNodeSkill(resolvedDirectPath, mergedSkillArgs, timeoutMs, context);
      } else if (directExecType === 'python') {
        const context = await buildSkillContext(name, [], []);
        result = await runPythonSkill(resolvedDirectPath, mergedSkillArgs, timeoutMs, context);
      } else if (directExecType === 'shell') {
        result = await runShellSkill(resolvedDirectPath, mergedSkillArgs, timeoutMs);
      } else {
        return { ok: false, skillName: name, error: `Unknown direct execType "${directExecType}"` };
      }
      logger.info(`[external.skill] Direct execPath result: ok=${result?.ok}${result?.error ? ` error=${result.error}` : ''}`);
      return { ...result, skillName: name };
    } catch (e) {
      logger.error(`[external.skill] Direct execPath threw: ${e.message}`);
      return { ok: false, skillName: name, error: `Direct execPath failed: ${e.message}` };
    }
  }

  let skillRecord;
  let skillSource = 'user-memory';

  try {
    skillRecord = await fetchSkillRecord(name, 5000);
  } catch (err) {
    logger.warn(`[external.skill] user-memory lookup failed for "${name}": ${err.message} — trying ~/.thinkdrop/skills/ fallback`);
  }

  if (!skillRecord) {
    logger.info(`[external.skill] "${name}" not in user-memory — checking ~/.thinkdrop/skills/`);
    skillRecord = await fetchSkillRecordFromUserSkillsDir(name);
    if (skillRecord) skillSource = skillRecord.source;
  }

  if (!skillRecord) {
    return { ok: false, skillName: name, error: `No installed skill named "${name}". Use "install skill at <path>" to add it.` };
  }

  logger.info(`[external.skill] Found skill "${name}" via ${skillSource}`);

  // Inject sessionId from skill's agentId when caller didn't supply one.
  // Skills created for a specific agent must run in that agent's persistent
  // browser session — not the default unauthenticated tab.
  //
  // Resolution order (most → least authoritative):
  //   1. skillRecord.agentId   — set by explore.agent in user-memory (e.g. "gmail" → "gmail_agent")
  //   2. skill.json agent_id   — read from disk when user-memory record omits agentId
  //   3. sourceDomain prefix   — last resort: "perplexity.ai" → "perplexity_agent"
  //   4. skill name prefix     — "perplexity_ai_navigate_history" → "perplexity_agent"
  if (!mergedSkillArgs?.sessionId) {
    let _derivedSessionId = null;

    // 1. agentId from user-memory record (most reliable — set explicitly by explore.agent)
    if (skillRecord?.agentId) {
      _derivedSessionId = skillRecord.agentId.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_agent';
    }

    // 2. agent_id from skill.json on disk (populated by explore.agent; may not be in user-memory)
    if (!_derivedSessionId) {
      try {
        const _skillDir = path.join(SKILLS_BASE_DIR, name.replace(/\./g, '_'));
        const _skillJsonPath = path.join(_skillDir, 'skill.json');
        if (fs.existsSync(_skillJsonPath)) {
          const _meta = JSON.parse(fs.readFileSync(_skillJsonPath, 'utf8'));
          if (_meta.agent_id) {
            _derivedSessionId = _meta.agent_id.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '_agent';
            logger.debug(`[external.skill] Read agent_id="${_meta.agent_id}" from skill.json for "${name}"`);
          }
        }
      } catch (_) { /* non-fatal */ }
    }

    // 3. sourceDomain first label: "mail.google.com" → first segment before dot → fallback to full replace
    if (!_derivedSessionId && skillRecord?.sourceDomain) {
      const _domainFirstLabel = skillRecord.sourceDomain.split('.')[0];
      _derivedSessionId = _domainFirstLabel + '_agent';
    }

    // 4. skill name prefix: "perplexity_ai_navigate_history" → "perplexity_agent"
    if (!_derivedSessionId && name && /^[a-z][a-z0-9]+_/.test(name)) {
      _derivedSessionId = name.split('_')[0] + '_agent';
    }

    if (_derivedSessionId) {
      mergedSkillArgs = { ...(mergedSkillArgs || {}), sessionId: _derivedSessionId };
      logger.info(`[external.skill] Injected sessionId="${_derivedSessionId}" for skill "${name}"`);
    }
  }

  if (!skillRecord.enabled) {
    return { ok: false, skillName: name, error: `Skill "${name}" is currently disabled.` };
  }

  const execPath = skillRecord.execPath;
  const execType = skillRecord.execType;

  let resolvedPath;
  try {
    resolvedPath = validateExecPath(execPath);
  } catch (err) {
    // exec_path from user-memory might be stale (dot-notation dir).
    // Try underscore-normalized directory before failing.
    const _dotDir = path.basename(path.dirname(execPath.replace(/^~/, os.homedir())));
    const _underDir = _dotDir.replace(/\./g, '_');
    if (_underDir !== _dotDir) {
      const altPath = path.join(SKILLS_BASE_DIR, _underDir, path.basename(execPath));
      try {
        resolvedPath = validateExecPath(altPath);
        logger.info(`[external.skill] Resolved stale exec_path via underscore fallback: ${altPath}`);
      } catch (_) {
        return { ok: false, skillName: name, execType, error: err.message };
      }
    } else {
      return { ok: false, skillName: name, execType, error: err.message };
    }
  }

  logger.info(`[external.skill] Running ${execType} skill at: ${resolvedPath}`);

  // ── Staleness check for navigate_history skills ───────────────────────────
  // navigate_history skills bake a static history index at scan time. If the
  // index is older than HISTORY_SKILL_TTL_DAYS, emit a non-blocking warning so
  // the user knows results may not include recent searches. Execution continues
  // regardless — the post-run rescan in browser.agent will refresh it afterward.
  const HISTORY_SKILL_TTL_DAYS = 7;
  const _isHistorySkill = name.endsWith('_navigate_history') || (skillRecord?.sourceAction === 'navigate_history');
  if (_isHistorySkill) {
    try {
      const _skillDir = path.dirname(resolvedPath);
      const _skillJsonPath = path.join(_skillDir, 'skill.json');
      if (fs.existsSync(_skillJsonPath)) {
        const _skillMeta = JSON.parse(fs.readFileSync(_skillJsonPath, 'utf8'));
        const _scannedAt = _skillMeta.scanned_at || _skillMeta.created_at;
        if (_scannedAt) {
          const _ageMs = Date.now() - new Date(_scannedAt).getTime();
          const _ageDays = Math.floor(_ageMs / (1000 * 60 * 60 * 24));
          if (_ageDays >= HISTORY_SKILL_TTL_DAYS) {
            logger.warn(`[external.skill] "${name}" history index is ${_ageDays} day(s) old — results may not include recent searches. A background rescan will refresh it after this run.`);
          }
        }
      }
    } catch (_ttlErr) {
      // Non-fatal — proceed with execution
    }
  }

  // Derive secretKeys from contractMd when not supplied by caller (e.g. cron run-now path)
  let resolvedSecretKeys = secretKeys || [];
  if (resolvedSecretKeys.length === 0 && skillRecord.contractMd) {
    // Block list format:  secrets:\n  - KEY1\n  - KEY2
    const blockMatch = skillRecord.contractMd.match(/^secrets\s*:\s*\n((?:[ \t]+-[ \t]+\S+[ \t]*\n?)+)/m);
    if (blockMatch) {
      resolvedSecretKeys = blockMatch[1].split('\n')
        .map(l => l.replace(/^[ \t]+-[ \t]+/, '').trim())
        .filter(Boolean);
    } else {
      // Inline format:  secrets: KEY1, KEY2  or  secrets: [KEY1, KEY2]
      const inlineMatch = skillRecord.contractMd.match(/^secrets:\s*(.+)$/m);
      if (inlineMatch && inlineMatch[1].trim()) {
        const raw = inlineMatch[1].replace(/^\[|\]$/g, ''); // strip YAML brackets
        resolvedSecretKeys = raw.split(/[,\s]+/).map(s => s.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
      }
    }
    if (resolvedSecretKeys.length > 0) {
      logger.info(`[external.skill] Resolved secretKeys from contractMd: ${resolvedSecretKeys.join(', ')}`);
    }
  }

  // Parse oauth providers from contractMd
  let resolvedOAuthProviders = [];
  if (skillRecord.contractMd) {
    const oauthLine = skillRecord.contractMd.match(/^oauth:\s*(.+)$/m);
    if (oauthLine && oauthLine[1].trim()) {
      resolvedOAuthProviders = oauthLine[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (resolvedOAuthProviders.length > 0) {
        logger.info(`[external.skill] OAuth providers for ${name}: ${resolvedOAuthProviders.join(', ')}`);
      }
    }
  }

  // Build context with logger + secrets + oauth tokens resolved from keytar
  const context = await buildSkillContext(name, resolvedSecretKeys, resolvedOAuthProviders);

  // OAuth gate: if any declared OAuth provider has no token, fail fast with a
  // structured needsOAuth response so executeCommand.js can trigger gatherOAuthCallback
  // and prompt the user to connect before retrying — instead of a cryptic API error.
  if (context._missingOAuth && context._missingOAuth.length > 0) {
    const missing = context._missingOAuth;
    const firstProvider = missing[0];
    logger.warn(`[external.skill] "${name}" missing OAuth token for: ${missing.join(', ')}`);
    return {
      ok: false,
      skillName: name,
      needsOAuth: {
        providers: missing,
        provider:  firstProvider,
        tokenKey:  `oauth:${firstProvider}:${name}`,
        scopes:    '',  // caller fills from frontmatter if available
      },
      error: `Skill "${name}" needs OAuth connection for: ${missing.join(', ')}. Connect in the Skills tab first.`,
    };
  }

  try {
    let result;
    // .json paths are descriptors — route to the appropriate runner, not require()
    const basename = require('path').basename(resolvedPath);
    if (basename === 'api.json') {
      const skillApiRunner = require('../skill-helpers/skill-api-runner.cjs');
      result = await skillApiRunner.run(name, mergedSkillArgs, { contractMd: skillRecord.contractMd, timeoutMs, context });
    } else if (basename === 'cli.json') {
      const skillCliRunner = require('../skill-helpers/skill-cli-runner.cjs');
      result = await skillCliRunner.run(name, mergedSkillArgs, { contractMd: skillRecord.contractMd, timeoutMs, context });
    } else if (resolvedPath.endsWith('.md')) {
      // Contract-based skills: exec_path points to skill.md (not index.cjs).
      // These skills define their execution as shell.run/curl steps in ## Plan / ## Commands.
      // They cannot be require()'d or spawned — planSkills must read the contractMd
      // and generate the appropriate shell.run / browser.act steps at plan time.
      logger.info(`[external.skill] "${name}" is a contract-based skill (skill.md) — needs planSkills routing`);
      return {
        ok: false,
        skillName: name,
        execType,
        contractBased: true,
        contractMd: skillRecord.contractMd || null,
        error: `Skill "${name}" is contract-based (skill.md). It defines shell.run/curl steps in its plan section. planSkills should read the contractMd and generate execution steps — not invoke external.skill directly.`
      };
    } else if (execType === 'project') {
      result = await runProjectSkill(resolvedPath, mergedSkillArgs, timeoutMs, name);
    } else if (execType === 'python') {
      result = await runPythonSkill(resolvedPath, mergedSkillArgs, timeoutMs, context);
    } else if (execType === 'node') {
      result = await runNodeSkill(resolvedPath, mergedSkillArgs, timeoutMs, context);
    } else if (execType === 'shell') {
      result = await runShellSkill(resolvedPath, mergedSkillArgs, timeoutMs);
    } else if (execType === 'recipe') {
      result = await runRecipeSkill(resolvedPath, mergedSkillArgs, timeoutMs);
    } else {
      return { ok: false, skillName: name, error: `Unknown exec_type "${execType}". Must be "python", "node", "shell", "project", or "recipe".` };
    }

    // If the skill itself returned ok:false with a non-trivial error, report it as a potential
    // API contract failure so skill.reviewer can write a learned api_rule.
    if (!result.ok && result.error && !/missing.*secret|secret.*missing|not found|disabled/i.test(result.error)) {
      _reportRuntimeFailure(name, result.error, resolvedPath).catch(() => {});
    }

    if (result && result.ok) {
      logger.info(`[external.skill] Skill "${name}" completed successfully`);
    } else {
      logger.warn(`[external.skill] Skill "${name}" completed with error: ${result?.error || 'unknown'}`);
    }
    return { ...result, skillName: name, execType };
  } catch (err) {
    logger.error(`[external.skill] Skill "${name}" failed: ${err.message}`);
    // Report unexpected runtime exceptions to skill.reviewer for learning
    _reportRuntimeFailure(name, err.message, resolvedPath).catch(() => {});
    return { ok: false, skillName: name, execType, error: err.message };
  }
}

// ── Fire-and-forget runtime failure reporter ──────────────────────────────────
async function _reportRuntimeFailure(skillName, errorMessage, execPath) {
  try {
    const fs = require('fs');
    const skillCode = fs.existsSync(execPath) ? fs.readFileSync(execPath, 'utf8') : '';
    if (!skillCode) return;
    const skillReviewer = require('./skill.reviewer.cjs');
    await skillReviewer({ action: 'report_failure', skillName, errorMessage, skillCode });
  } catch (_) { /* non-fatal */ }
}

module.exports = { run };
