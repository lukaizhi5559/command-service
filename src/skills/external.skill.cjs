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

  // Load OAuth tokens stored by the Skills tab Connect flow
  // Stored as JSON under key: oauth:<provider>:<skillName>
  const oauth = {};
  if (keytar && oauthProviders && oauthProviders.length > 0) {
    await Promise.all(oauthProviders.map(async (provider) => {
      try {
        const raw = await keytar.getPassword('thinkdrop', `oauth:${provider}:${skillName}`);
        if (raw) {
          try { oauth[provider] = JSON.parse(raw); } catch(_) { oauth[provider] = { access_token: raw }; }
        }
      } catch (_) {}
    }));
  }

  return {
    logger,
    secrets,
    oauth,
    skillName,
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
      const skillFn = typeof skillModule === 'function' ? skillModule : skillModule.default;

      if (typeof skillFn !== 'function') {
        clearTimeout(timer);
        reject(new Error(`Skill module at "${execPath}" must export a function`));
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

async function run(args) {
  const { name, args: skillArgs, timeoutMs: rawTimeout, secretKeys } = args || {};
  const timeoutMs = Math.min(rawTimeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

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

  if (!skillRecord.enabled) {
    return { ok: false, skillName: name, error: `Skill "${name}" is currently disabled.` };
  }

  const execPath = skillRecord.execPath;
  const execType = skillRecord.execType;

  let resolvedPath;
  try {
    resolvedPath = validateExecPath(execPath);
  } catch (err) {
    return { ok: false, skillName: name, execType, error: err.message };
  }

  logger.info(`[external.skill] Running ${execType} skill at: ${resolvedPath}`);

  // Derive secretKeys from contractMd when not supplied by caller (e.g. cron run-now path)
  let resolvedSecretKeys = secretKeys || [];
  if (resolvedSecretKeys.length === 0 && skillRecord.contractMd) {
    const secretsLine = skillRecord.contractMd.match(/^secrets:\s*(.+)$/m);
    if (secretsLine && secretsLine[1].trim()) {
      resolvedSecretKeys = secretsLine[1].split(',').map(s => s.trim()).filter(Boolean);
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

  try {
    let result;
    if (execType === 'node') {
      result = await runNodeSkill(resolvedPath, skillArgs, timeoutMs, context);
    } else if (execType === 'shell') {
      result = await runShellSkill(resolvedPath, skillArgs, timeoutMs);
    } else {
      return { ok: false, skillName: name, error: `Unknown exec_type "${execType}". Must be "node" or "shell".` };
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
