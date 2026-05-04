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
 * Fallback for creator-built skills: checks ~/.thinkdrop/skills/<dotName>/index.cjs
 * which skillCreator copies to when registering. Works even when user-memory is
 * unavailable or returns UNAUTHORIZED.
 * Tries both dot-notation (gmail.daily) and kebab-notation (gmail-daily) as dir names.
 */
async function fetchSkillRecordFromUserSkillsDir(name) {
  try {
    const candidates = [
      name,                          // gmail.daily   (dot-notation)
      name.replace(/\./g, '_'),      // gmail_daily   (underscore — canonical dir name)
      name.replace(/\./g, '-'),      // gmail-daily   (kebab fallback)
    ];
    for (const candidate of candidates) {
      const skillPath = path.join(SKILLS_BASE_DIR, candidate, 'index.cjs');
      if (fs.existsSync(skillPath)) {
        logger.info(`[external.skill] Found creator skill at ${skillPath}`);
        return {
          name,
          execPath: skillPath,
          execType: 'node',
          enabled: true,
          source: 'user-skills-dir',
        };
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
          resolve({ ok: true, output });
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
  const { name, args: skillArgs, timeoutMs: rawTimeout, secretKeys, ...flatRest } = args || {};
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

  logger.info(`[external.skill] Executing skill: ${name}`);

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

  // Inject sessionId from skill's sourceDomain when caller didn't supply one.
  // Skills created for a specific agent (e.g. perplexity_*) must run in that
  // agent's persistent browser session — not the default unauthenticated tab.
  // Fallback: derive from skill name prefix (e.g. "perplexity_ai_navigate_history" → "perplexity_agent")
  // for manually-created skills that were not registered with sourceDomain.
  if (!mergedSkillArgs?.sessionId) {
    let _derivedSessionId = null;
    if (skillRecord?.sourceDomain) {
      _derivedSessionId = skillRecord.sourceDomain.replace(/[\.\-]/g, '_') + '_agent';
    } else if (name && /^[a-z][a-z0-9]+_/.test(name)) {
      // Extract first word of underscore-delimited skill name as domain hint
      // e.g. "perplexity_ai_navigate_history" → "perplexity", "gmail_send" → "gmail"
      const _prefix = name.split('_')[0];
      // Only inject if the prefix maps to a known agent file pattern
      const _agentId = _prefix + '_agent';
      _derivedSessionId = _agentId;
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
    } else if (execType === 'node') {
      result = await runNodeSkill(resolvedPath, mergedSkillArgs, timeoutMs, context);
    } else if (execType === 'shell') {
      result = await runShellSkill(resolvedPath, mergedSkillArgs, timeoutMs);
    } else {
      return { ok: false, skillName: name, error: `Unknown exec_type "${execType}". Must be "node", "shell", or "project".` };
    }

    // If the skill itself returned ok:false with a non-trivial error, report it as a potential
    // API contract failure so skill.reviewer can write a learned api_rule.
    if (!result.ok && result.error && !/missing.*secret|secret.*missing|not found|disabled/i.test(result.error)) {
      _reportRuntimeFailure(name, result.error, resolvedPath).catch(() => {});
    }

    logger.info(`[external.skill] Skill "${name}" completed successfully`);
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
