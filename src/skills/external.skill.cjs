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

async function runNodeSkill(execPath, args, timeoutMs) {
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

      Promise.resolve(skillFn(args || {}))
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
  const { name, args: skillArgs, timeoutMs: rawTimeout } = args || {};
  const timeoutMs = Math.min(rawTimeout || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  if (!name) {
    return { ok: false, error: 'external.skill requires args.name (the skill name to execute)' };
  }

  logger.info(`[external.skill] Executing skill: ${name}`);

  let skillRecord;
  try {
    skillRecord = await fetchSkillRecord(name, 5000);
  } catch (err) {
    return { ok: false, skillName: name, error: `Failed to fetch skill registration for "${name}": ${err.message}` };
  }

  if (!skillRecord) {
    return { ok: false, skillName: name, error: `No installed skill named "${name}". Use "install skill at <path>" to add it.` };
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
    return { ok: false, skillName: name, execType, error: err.message };
  }

  logger.info(`[external.skill] Running ${execType} skill at: ${resolvedPath}`);

  try {
    let result;
    if (execType === 'node') {
      result = await runNodeSkill(resolvedPath, skillArgs, timeoutMs);
    } else if (execType === 'shell') {
      result = await runShellSkill(resolvedPath, skillArgs, timeoutMs);
    } else {
      return { ok: false, skillName: name, error: `Unknown exec_type "${execType}". Must be "node" or "shell".` };
    }

    logger.info(`[external.skill] Skill "${name}" completed successfully`);
    return { ...result, skillName: name, execType };
  } catch (err) {
    logger.error(`[external.skill] Skill "${name}" failed: ${err.message}`);
    return { ok: false, skillName: name, execType, error: err.message };
  }
}

module.exports = { run };
