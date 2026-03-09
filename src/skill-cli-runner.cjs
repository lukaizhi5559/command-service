'use strict';
/**
 * skill-cli-runner.cjs
 *
 * Universal runner for CLI-backed skills.
 * Reads cli.json from a skill directory, ensures the CLI is installed,
 * loads secrets from keytar, uses LLM to build the exact command from
 * the CLI's --help output + user intent, then executes it.
 *
 * Used by executeCommand when a skill directory has cli.json but no index.cjs.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const logger = require('./logger.cjs');

const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

/**
 * Check if a CLI tool is available on PATH.
 * @param {string} probeCmd  e.g. "twilio --version"
 * @returns {boolean}
 */
function isCLIInstalled(probeCmd) {
  try {
    const [bin, ...probArgs] = probeCmd.split(' ');
    const r = spawnSync(bin, probArgs, { timeout: 10000, encoding: 'utf8' });
    return r.status === 0 || (r.stdout || '').length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Install a CLI tool.
 * @param {string} installCmd  e.g. "npm install -g twilio-cli"
 */
function installCLI(installCmd) {
  logger.info(`[SkillCLIRunner] Installing CLI: ${installCmd}`);
  execSync(installCmd, { stdio: 'pipe', timeout: 120000 });
  logger.info(`[SkillCLIRunner] CLI installed: ${installCmd}`);
}

/**
 * Run a CLI's --help and return the output (truncated to 4000 chars).
 * @param {string} helpCmd  e.g. "twilio --help"
 * @returns {string}
 */
function probeCLIHelp(helpCmd) {
  try {
    const [bin, ...helpArgs] = helpCmd.split(' ');
    const r = spawnSync(bin, helpArgs, { timeout: 15000, encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).slice(0, 4000);
    return out || '(no help output)';
  } catch (e) {
    return `(help probe failed: ${e.message})`;
  }
}

/**
 * Load secrets for the skill from keytar.
 * @param {string} skillName
 * @param {string[]} authEnv  list of env var names
 * @returns {Record<string, string>}  map of env var name → value (only found ones)
 */
async function loadSecrets(skillName, authEnv) {
  const secrets = {};
  let keytar;
  try { keytar = require('keytar'); } catch (_) { return secrets; }
  for (const key of authEnv) {
    try {
      // Try skill-scoped key first, then global 'thinkdrop' service
      const val = await keytar.getPassword(skillName, key)
        || await keytar.getPassword('thinkdrop', key);
      if (val) secrets[key] = val;
    } catch (_) {}
  }
  return secrets;
}

/**
 * Use the LLM to build the exact CLI command for the given intent.
 * @param {object} cliConfig    full cli.json descriptor
 * @param {string} helpText     output of --help
 * @param {string} intent       user's intent / args description
 * @param {object} secretsEnv   loaded secrets (values masked in prompt)
 * @returns {Promise<string>}   the shell command to run
 */
async function buildCommandWithLLM(cliConfig, helpText, intent, secretsEnv) {
  const { ask } = require('./skill-llm.cjs');

  const secretsSummary = Object.keys(secretsEnv).length > 0
    ? `Available env vars (secrets loaded, values not shown): ${Object.keys(secretsEnv).join(', ')}`
    : '(no secrets loaded)';

  const system = `You are a CLI command builder. Given a CLI tool's help text and a user intent, output ONLY the exact shell command to run — no explanation, no markdown, no code fences. Just the raw command string.

Rules:
- Use the tool name as shown in the help text
- Reference env vars by name (e.g. $TWILIO_ACCOUNT_SID) where the CLI accepts them, or rely on them being set in the environment
- Do NOT hardcode secret values
- If the help text shows a subcommand pattern, use it
- Output exactly ONE line — the complete runnable command`;

  const user = `CLI tool: ${cliConfig.tool}
Help text:
${helpText}

User intent: ${intent}

${secretsSummary}

Example commands from registry:
${(cliConfig.exampleCmds || []).join('\n')}

Output the exact command to run:`;

  try {
    const raw = await ask(user, { systemPrompt: system, temperature: 0.1 });
    // Strip any accidental markdown or newlines
    return raw.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').split('\n')[0].trim();
  } catch (e) {
    logger.warn(`[SkillCLIRunner] LLM command build failed: ${e.message}`);
    // Fall back to example command if available
    return (cliConfig.exampleCmds || [])[0] || null;
  }
}

/**
 * Execute the built command with secrets injected as env vars.
 * @param {string} command
 * @param {object} secretsEnv
 * @param {number} timeoutMs
 * @returns {{ ok: boolean, output: string, error?: string }}
 */
function executeCommand(command, secretsEnv, timeoutMs = 60000) {
  try {
    logger.info(`[SkillCLIRunner] Executing: ${command}`);
    const result = spawnSync('sh', ['-c', command], {
      timeout: timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, ...secretsEnv },
    });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    if (result.status === 0) {
      return { ok: true, output: stdout || stderr || '(command completed with no output)' };
    }
    return { ok: false, output: stdout, error: stderr || `Exit code ${result.status}` };
  } catch (e) {
    return { ok: false, output: '', error: e.message };
  }
}

/**
 * Main entry point — run a CLI-backed skill.
 *
 * @param {string} skillName   e.g. "send.text.message"
 * @param {object} args        runtime args from the skill plan step
 * @param {object} opts
 * @param {boolean} opts.dryRun  if true, return the command but don't execute
 * @returns {Promise<{ ok: boolean, result?: string, command?: string, error?: string }>}
 */
async function run(skillName, args = {}, opts = {}) {
  const skillDir = path.join(SKILLS_DIR, skillName);
  const cliJsonPath = path.join(skillDir, 'cli.json');

  if (!fs.existsSync(cliJsonPath)) {
    return { ok: false, error: `No cli.json found for skill "${skillName}" at ${cliJsonPath}` };
  }

  let cliConfig;
  try {
    cliConfig = JSON.parse(fs.readFileSync(cliJsonPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Failed to parse cli.json for "${skillName}": ${e.message}` };
  }

  const { tool, probeCmd, helpCmd, installCmd, authEnv = [], authType } = cliConfig;

  // ── 1. Ensure CLI is installed ──────────────────────────────────────────────
  if (!isCLIInstalled(probeCmd)) {
    logger.info(`[SkillCLIRunner] CLI "${tool}" not found — installing…`);
    try {
      installCLI(installCmd);
    } catch (e) {
      return { ok: false, error: `Failed to install CLI "${tool}": ${e.message}` };
    }
    // Verify after install
    if (!isCLIInstalled(probeCmd)) {
      return { ok: false, cliNotAvailable: true, error: `CLI "${tool}" still not available after install attempt` };
    }
  }

  // ── 2. Handle OAuth-type auth (prompt user if not logged in) ────────────────
  if (authType === 'oauth' && cliConfig.authCmd) {
    logger.info(`[SkillCLIRunner] CLI "${tool}" uses OAuth — relying on existing auth session`);
    // For OAuth CLIs (gh, gcloud, az), we assume the user has already authenticated.
    // The skill build process should have prompted for this via gatherContext.
  }

  // ── 3. Load secrets from keytar ─────────────────────────────────────────────
  const secretsEnv = await loadSecrets(skillName, authEnv);
  const missingSecrets = authEnv.filter(k => !secretsEnv[k]);
  if (missingSecrets.length > 0 && authType === 'env') {
    logger.warn(`[SkillCLIRunner] Missing secrets for "${skillName}": ${missingSecrets.join(', ')}`);
    return {
      ok: false,
      error: `Missing required credentials: ${missingSecrets.join(', ')}. Please provide them via the credential prompt.`,
      missingSecrets,
    };
  }

  // ── 4. Probe --help and build command with LLM ──────────────────────────────
  const helpText = probeCLIHelp(helpCmd);
  logger.debug(`[SkillCLIRunner] help text length: ${helpText.length}`);

  // Build intent string from args
  const intent = typeof args === 'string'
    ? args
    : Object.entries(args)
        .filter(([k]) => k !== 'name' && k !== 'secretKeys')
        .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
        .join(', ');

  const command = await buildCommandWithLLM(cliConfig, helpText, intent, secretsEnv);
  if (!command) {
    return { ok: false, error: `Could not build a CLI command for intent: ${intent}` };
  }

  logger.info(`[SkillCLIRunner] Built command: ${command}`);

  if (opts.dryRun) {
    return { ok: true, command, result: '(dry run — command not executed)' };
  }

  // ── 5. Execute ───────────────────────────────────────────────────────────────
  const execResult = executeCommand(command, secretsEnv);
  if (execResult.ok) {
    return { ok: true, command, result: execResult.output };
  }
  return { ok: false, command, error: execResult.error, output: execResult.output };
}

module.exports = { run, isCLIInstalled, probeCLIHelp, loadSecrets };
