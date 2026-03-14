'use strict';
/**
 * skill-api-runner.cjs
 *
 * Universal runner for API SDK-backed skills.
 * Reads api.json from a skill directory, ensures the npm SDK is installed,
 * loads secrets from keytar, uses LLM to generate a minimal JS snippet
 * from the SDK's README/init pattern + user intent, then executes it
 * in an isolated child process.
 *
 * Used by executeCommand when a skill directory has api.json but no index.cjs.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const logger = require('./logger.cjs');

const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

/**
 * Replace Unicode smart quotes and lookalike chars with ASCII equivalents.
 * LLMs sometimes emit \u2018/\u2019 (\u2018 \u2019) or \u201c/\u201d (\u201c \u201d)
 * which cause SyntaxError: Unexpected token in Node.js.
 */
function sanitizeSnippet(code) {
  return code
    .replace(/[\u2018\u2019\u02bc\u0060]/g, "'")
    .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2026]/g, '...');
}

/**
 * Check snippet syntax using `node --check`.
 * @param {string} snippet
 * @returns {{ ok: boolean, error?: string }}
 */
function validateSnippetSyntax(snippet) {
  const tmpFile = path.join(os.tmpdir(), `_snip_check_${Date.now()}.cjs`);
  try {
    fs.writeFileSync(tmpFile, snippet, 'utf8');
    const r = spawnSync(process.execPath, ['--check', tmpFile], { timeout: 8000, encoding: 'utf8' });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: (r.stderr || r.stdout || 'syntax error').trim().split('\n')[0] };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Ensure an npm package is installed in the skill's node_modules.
 * @param {string} skillDir   path to skill directory
 * @param {string} pkg        npm package name
 */
function ensurePackage(skillDir, pkg) {
  const nmPath = path.join(skillDir, 'node_modules', pkg.replace(/^@[^/]+\//, m => m).split('/')[0]);
  if (fs.existsSync(nmPath)) return; // already installed

  logger.info(`[SkillAPIRunner] Installing npm package: ${pkg} in ${skillDir}`);
  // Ensure package.json exists so npm install works
  const pkgJsonPath = path.join(skillDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: path.basename(skillDir), version: '1.0.0', private: true }, null, 2));
  }
  execSync(`npm install --save ${pkg} --prefer-offline`, { cwd: skillDir, stdio: 'pipe', timeout: 120000 });
  logger.info(`[SkillAPIRunner] Package installed: ${pkg}`);
}

/**
 * Load secrets for the skill from keytar.
 * @param {string} skillName
 * @param {string[]} authEnv  list of env var names
 * @returns {Promise<Record<string, string>>}
 */
async function loadSecrets(skillName, authEnv) {
  const secrets = {};
  let keytar;
  try { keytar = require('keytar'); } catch (_) { return secrets; }
  for (const key of authEnv) {
    try {
      const val = await keytar.getPassword(skillName, key)
        || await keytar.getPassword('thinkdrop', key);
      if (val) secrets[key] = val;
    } catch (_) {}
  }
  return secrets;
}

/**
 * Use LLM to generate a minimal async JS snippet that accomplishes the intent
 * using the SDK's init pattern.
 *
 * @param {object} apiConfig    full api.json descriptor
 * @param {string} intent       user's intent / args description
 * @param {object} secretsEnv   loaded secrets (keys only shown to LLM)
 * @returns {Promise<string>}   JS code snippet (async IIFE)
 */
async function buildSnippetWithLLM(apiConfig, intent, secretsEnv) {
  const { ask } = require('./skill-llm.cjs');

  const secretsSummary = Object.keys(secretsEnv).length > 0
    ? `Secrets available as process.env.*: ${Object.keys(secretsEnv).join(', ')}`
    : '(no secrets available)';

  const isNativeHttp = !apiConfig.npm;

  const system = isNativeHttp
    ? `You are a Node.js code generator. Generate a minimal CommonJS async IIFE that accomplishes the user intent using Node.js built-in modules ONLY (https, http, etc.) — no npm packages.

Rules:
- Output ONLY valid Node.js CommonJS code — no markdown, no fences, no explanation
- Use ONLY Node.js built-in modules: const https = require('https');
- NEVER use require() with any npm package name
- Access secrets via process.env.KEY_NAME (they will be injected at runtime)
- The code must be a self-contained async IIFE: (async () => { ... })()
- Print the result to stdout as JSON: console.log(JSON.stringify({ ok: true, result: ... }))
- On error: console.log(JSON.stringify({ ok: false, error: err.message }))
- Keep it minimal — just the HTTP request + output
- Do NOT use any relative require() paths
- Do NOT call process.exit()
- CRITICAL: Use ONLY ASCII characters — no smart quotes, no curly quotes, no unicode dashes
- CRITICAL: Always call req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); }) on every https.request so the process never hangs
- CRITICAL: NEVER use secrets.KEY or context.secrets.KEY — always use process.env.KEY_NAME
- CRITICAL: For phone numbers (args.to, args.phone, args.phoneNumber, args.phone_number, args.recipient), normalize to E.164 before sending: const raw = String(args.to||args.phoneNumber||args.phone||'').replace(/\D/g,''); const to = raw.length===10 ? '+1'+raw : '+'+raw;`
    : `You are a Node.js code generator for API SDK calls. Generate a minimal CommonJS async IIFE that accomplishes the user intent using the given SDK.

Rules:
- Output ONLY valid Node.js CommonJS code — no markdown, no fences, no explanation
- Use require() with the exact npm package name provided
- Access secrets via process.env.KEY_NAME (they will be injected at runtime)
- The code must be a self-contained async IIFE: (async () => { ... })()
- Print the result to stdout as JSON: console.log(JSON.stringify({ ok: true, result: ... }))
- On error: console.log(JSON.stringify({ ok: false, error: err.message }))
- Keep it minimal — just the init + one API call + output
- Do NOT use any relative require() paths
- Do NOT call process.exit()
- CRITICAL: Use ONLY ASCII characters — no smart quotes, no curly quotes, no unicode dashes
- CRITICAL: NEVER use secrets.KEY or context.secrets.KEY — always use process.env.KEY_NAME`;

  const user = isNativeHttp
    ? `API: native HTTPS (no npm package — use built-in https module)

Init pattern (use exactly as shown):
${apiConfig.initSnippet}

Example request pattern (adapt for the intent):
${apiConfig.exampleSnippet}

${secretsSummary}

User intent: ${intent}

Generate the complete async IIFE. CRITICAL requirements:
1. Capture the result of every await call into a variable
2. Always end with: console.log(JSON.stringify({ ok: true, result: <captured_result> }))
3. Wrap in try/catch: catch(err){ console.log(JSON.stringify({ ok: false, error: err.message })) }
4. Never leave an await result uncaptured — always assign it: const result = await new Promise(...)
Generate the complete async IIFE Node.js snippet using only built-in https:`
    : `SDK npm package: ${apiConfig.npm}

Init snippet pattern:
${apiConfig.initSnippet}

Example API call pattern:
${apiConfig.exampleSnippet}

${secretsSummary}

User intent: ${intent}

Generate the complete async IIFE. CRITICAL requirements:
1. Capture the result of every await call into a variable
2. Always end with: console.log(JSON.stringify({ ok: true, result: <captured_result> }))
3. Wrap in try/catch: catch(err){ console.log(JSON.stringify({ ok: false, error: err.message })) }
4. Never leave an await result uncaptured — always assign it: const result = await ...
Generate the complete async IIFE Node.js snippet:`;

  /**
   * Extract just the code from an LLM response that may contain prose preamble,
   * markdown fences, or explanation text after the snippet.
   */
  const clean = (raw) => {
    let s = raw.trim();
    // 1. Extract content inside first ```...``` block if present
    const fenceMatch = s.match(/```(?:javascript|js|node|cjs)?\n?([\s\S]*?)```/i);
    if (fenceMatch) {
      s = fenceMatch[1].trim();
    } else {
      // 2. No fence — find first line that looks like JS code
      // (starts with const/let/var/async/(  or is an IIFE opener)
      const lines = s.split('\n');
      const codeStart = lines.findIndex(l =>
        /^\s*(const|let|var|async\s+function|async\s*\(|\(async|\(function|function|\/\/|\/\*)/.test(l)
      );
      if (codeStart > 0) {
        // Drop prose preamble before first code line
        s = lines.slice(codeStart).join('\n').trim();
      }
      // 3. Also strip trailing prose after the last }) or );
      const lastCodeLine = s.lastIndexOf('})');
      const lastSemiCode = s.lastIndexOf(');');
      const cutAt = Math.max(lastCodeLine, lastSemiCode);
      if (cutAt > 0 && cutAt < s.length - 3) {
        s = s.slice(0, cutAt + 2).trim();
      }
    }
    return sanitizeSnippet(s);
  };

  try {
    const raw = await ask(user, { systemPrompt: system, temperature: 0.1 });
    const snippet = clean(raw);

    // Validate syntax — retry once with stricter prompt if it fails
    const check = validateSnippetSyntax(snippet);
    if (!check.ok) {
      logger.warn(`[SkillAPIRunner] Snippet syntax error: ${check.error} — retrying with fix hint`);
      const retryUser = user + `\n\nPREVIOUS ATTEMPT HAD SYNTAX ERROR: ${check.error}\nOutput ONLY the raw JavaScript code — no explanation, no preamble, no markdown fences. Start your response directly with (async () => {. Use only ASCII characters — no smart quotes, curly quotes, or unicode dashes.`;
      const raw2 = await ask(retryUser, { systemPrompt: system, temperature: 0.0 });
      const snippet2 = clean(raw2);
      const check2 = validateSnippetSyntax(snippet2);
      if (!check2.ok) {
        logger.warn(`[SkillAPIRunner] Retry snippet also has syntax error: ${check2.error}`);
        return null;
      }
      return snippet2;
    }
    return snippet;
  } catch (e) {
    logger.warn(`[SkillAPIRunner] LLM snippet build failed: ${e.message}`);
    return null;
  }
}

/**
 * Execute a generated JS snippet in an isolated child process with secrets as env vars.
 * @param {string} snippet      JS code to run
 * @param {string} skillDir     cwd for the process (has node_modules)
 * @param {object} secretsEnv   secrets to inject as env vars
 * @param {number} timeoutMs
 * @returns {{ ok: boolean, result?: any, error?: string, raw?: string }}
 */
function executeSnippet(snippet, skillDir, secretsEnv, timeoutMs = 60000) {
  // Write snippet to a temp file in skillDir
  const tmpFile = path.join(skillDir, '_runner_tmp.cjs');
  try {
    fs.writeFileSync(tmpFile, snippet, 'utf8');
    const result = spawnSync(process.execPath, [tmpFile], {
      cwd: skillDir,
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, ...secretsEnv, NODE_PATH: path.join(skillDir, 'node_modules') },
    });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();

    // Try to parse the last JSON line from stdout
    const lines = stdout.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (typeof parsed === 'object' && 'ok' in parsed) {
          return parsed.ok
            ? { ok: true, result: parsed.result, raw: stdout }
            : { ok: false, error: parsed.error || stderr, raw: stdout };
        }
      } catch (_) {}
    }

    // No structured output — return raw stdout if process succeeded
    if (result.status === 0) {
      return { ok: true, result: stdout || '(completed with no output)', raw: stdout };
    }
    return { ok: false, error: stderr || `Exit code ${result.status}`, raw: stdout };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

/**
 * Main entry point — run an API SDK-backed skill.
 *
 * @param {string} skillName   e.g. "send.email"
 * @param {object} args        runtime args from the skill plan step
 * @param {object} opts
 * @param {boolean} opts.dryRun  if true, return the snippet but don't execute
 * @returns {Promise<{ ok: boolean, result?: any, snippet?: string, error?: string }>}
 */
async function run(skillName, args = {}, opts = {}) {
  const skillDir = path.join(SKILLS_DIR, skillName);
  const apiJsonPath = path.join(skillDir, 'api.json');

  if (!fs.existsSync(apiJsonPath)) {
    return { ok: false, error: `No api.json found for skill "${skillName}" at ${apiJsonPath}` };
  }

  let apiConfig;
  try {
    apiConfig = JSON.parse(fs.readFileSync(apiJsonPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Failed to parse api.json for "${skillName}": ${e.message}` };
  }

  const { npm: npmPkg, authEnv = [] } = apiConfig;

  // ── 1. Ensure SDK is installed (skip if npm: null — uses native https) ───────
  if (npmPkg) {
    try {
      ensurePackage(skillDir, npmPkg);
    } catch (e) {
      return { ok: false, error: `Failed to install SDK "${npmPkg}": ${e.message}` };
    }
  } else {
    logger.info(`[SkillAPIRunner] No npm package for "${skillName}" — using native https (no install needed)`);
  }

  // ── 2. Load secrets from keytar ─────────────────────────────────────────────
  const secretsEnv = await loadSecrets(skillName, authEnv);
  const missingSecrets = authEnv.filter(k => !secretsEnv[k]);
  if (missingSecrets.length > 0) {
    logger.warn(`[SkillAPIRunner] Missing secrets for "${skillName}": ${missingSecrets.join(', ')}`);
    return {
      ok: false,
      error: `Missing required credentials: ${missingSecrets.join(', ')}. Please provide them via the credential prompt.`,
      missingSecrets,
    };
  }

  // ── 3. Build intent string from args ────────────────────────────────────────
  // Normalize phone number fields to E.164 before passing to LLM
  const normalizedArgs = typeof args === 'object' && args !== null
    ? Object.fromEntries(Object.entries(args).map(([k, v]) => {
        if (['to', 'phone', 'phonenumber', 'phoneNumber', 'phone_number', 'recipient', 'number'].includes(k) && typeof v === 'string') {
          const digits = v.replace(/\D/g, '');
          if (digits.length === 10) return [k, '+1' + digits];
          if (digits.length === 11 && digits[0] === '1') return [k, '+' + digits];
        }
        return [k, v];
      }))
    : args;

  const intent = typeof normalizedArgs === 'string'
    ? normalizedArgs
    : Object.entries(normalizedArgs)
        .filter(([k]) => k !== 'name' && k !== 'secretKeys')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
        .join(', ');

  // ── 4. Generate execution snippet with LLM ──────────────────────────────────
  const snippet = await buildSnippetWithLLM(apiConfig, intent, secretsEnv);
  if (!snippet) {
    return { ok: false, error: `Could not generate SDK snippet for intent: ${intent}` };
  }

  logger.info(`[SkillAPIRunner] Generated snippet for "${skillName}" (${snippet.length} chars)`);
  logger.debug(`[SkillAPIRunner] Snippet:\n${snippet.slice(0, 500)}`);

  if (opts.dryRun) {
    return { ok: true, snippet, result: '(dry run — snippet not executed)' };
  }

  // ── 5. Execute snippet in isolated child process ─────────────────────────────
  logger.info(`[SkillAPIRunner] Executing snippet for "${skillName}":\n${snippet}`);
  const execResult = executeSnippet(snippet, skillDir, secretsEnv, 20000);
  logger.info(`[SkillAPIRunner] Execution result for "${skillName}": ok=${execResult.ok} result=${JSON.stringify(execResult.result)} raw=${execResult.raw} error=${execResult.error}`);
  if (execResult.ok) {
    return { ok: true, snippet, result: execResult.result };
  }
  return { ok: false, snippet, error: execResult.error, output: execResult.raw };
}

module.exports = { run, loadSecrets, ensurePackage };
