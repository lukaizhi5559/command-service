'use strict';
/**
 * skill-scout.cjs
 *
 * Dynamic CLI and API discovery — the fallback when static registries don't match.
 *
 * Discovery strategy:
 *   CLI path:
 *     1. Check if a binary already exists on $PATH (which <service>)
 *     2. Search npm for "<service>-cli" / "<service>-command" packages
 *     3. Search brew for the service name (macOS/Linux)
 *     4. LLM validates top candidates and picks the best one
 *     5. Cache result back into cli-registry.json for future runs
 *
 *   API path:
 *     1. Check if an npm package named "<service>" or "@<service>/<service>" is available
 *     2. Search npm for "<service>" and filter by download count + keyword match
 *     3. LLM validates top candidates and picks the official SDK
 *     4. Cache result back into api-registry.json for future runs
 *
 * Exports:
 *   discoverCLI(serviceName, capability)  → cli-registry entry or null
 *   discoverAPI(serviceName, capability)  → api-registry entry or null
 *   discover(serviceName, capability)     → { cliMatch, apiMatch } (CLI first)
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync } = require('child_process');
const logger = require('../logger.cjs');

const REGISTRY_DIR = path.join(__dirname);
const CLI_REGISTRY_PATH = path.join(REGISTRY_DIR, 'cli-registry.json');
const API_REGISTRY_PATH = path.join(REGISTRY_DIR, 'api-registry.json');

const DISCOVERY_TIMEOUT_MS = 15000;
const NPM_SEARCH_TIMEOUT_MS = 20000;

// ── Utility: run a shell command and return stdout (or null on error) ─────────
function sh(cmd, timeoutMs) {
  try {
    const [bin, ...args] = cmd.split(' ');
    const r = spawnSync(bin, args, {
      timeout: timeoutMs || DISCOVERY_TIMEOUT_MS,
      encoding: 'utf8',
      env: { ...process.env },
    });
    return (r.stdout || '').trim() || null;
  } catch (_) {
    return null;
  }
}

// ── Check if a binary is already on $PATH ─────────────────────────────────────
function whichBinary(name) {
  return sh(`which ${name}`, 5000);
}

// ── Search npm registry for packages matching a query ─────────────────────────
function npmSearch(query, limit) {
  limit = limit || 5;
  try {
    const r = spawnSync('npm', ['search', query, '--json', '--no-description', `--searchlimit=${limit}`], {
      timeout: NPM_SEARCH_TIMEOUT_MS,
      encoding: 'utf8',
    });
    if (!r.stdout) return [];
    const results = JSON.parse(r.stdout);
    return Array.isArray(results) ? results : [];
  } catch (_) {
    return [];
  }
}

// ── Search brew for a formula ─────────────────────────────────────────────────
function brewSearch(query) {
  if (process.platform === 'win32') return [];
  try {
    const r = spawnSync('brew', ['search', '--formula', query], {
      timeout: DISCOVERY_TIMEOUT_MS,
      encoding: 'utf8',
    });
    const lines = (r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    // Filter out warning/info lines
    return lines.filter(l => !l.startsWith('=') && !l.includes('No formula'));
  } catch (_) {
    return [];
  }
}

// ── LLM validation: pick the best CLI/SDK from candidates ─────────────────────
async function llmPickBest(serviceName, capability, candidates, type) {
  try {
    const { ask } = require('../skill-llm.cjs');
    const candidateList = candidates.map((c, i) => `${i + 1}. ${c.name || c} — ${c.description || ''}`).join('\n');

    const system = `You are a tool selector. Given a service name and a list of candidate CLI tools or npm SDKs, pick the single best official or most widely-used option. Respond with ONLY valid JSON, no explanation.

CRITICAL: For CLI type, ONLY pick packages that install a real executable binary (e.g. twilio-cli installs 'twilio', @slack/cli installs 'slack'). NEVER pick TypeScript-only SDKs, REST API wrappers, or packages that have no binary (e.g. 'clicksend', 'stripe', 'axios' are SDKs — NOT CLI tools). If no candidate is a real CLI binary, respond with index:0.`;

    const user = `Service: ${serviceName}
Capability: ${capability}
Type: ${type} (cli or api)

Candidates:
${candidateList}

Pick the best one. Respond:
{"index": <1-based index>, "name": "<package or binary name>", "reason": "<one sentence>", "authType": "env|oauth|none", "authEnvGuess": ["ENV_VAR_NAME_1", "ENV_VAR_NAME_2"]}

If none of the candidates are suitable, respond: {"index": 0, "name": null}`;

    const raw = await ask(user, { systemPrompt: system, temperature: 0.1 });
    const text = (raw || '').trim().replace(/^```json?\n?/i, '').replace(/\n?```$/, '');
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

// ── Write a discovered entry back into the registry for caching ───────────────
function cacheToRegistry(registryPath, capability, providerKey, entry) {
  try {
    let registry = {};
    if (fs.existsSync(registryPath)) {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }
    if (!registry[capability]) {
      registry[capability] = { keywords: [capability], providers: {}, defaultProvider: providerKey };
    }
    registry[capability].providers[providerKey] = entry;
    if (!registry[capability].defaultProvider) registry[capability].defaultProvider = providerKey;
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');
    logger.info(`[SkillScout] Cached ${providerKey} → ${registryPath} for capability "${capability}"`);
  } catch (e) {
    logger.warn(`[SkillScout] Cache write failed: ${e.message}`);
  }
}

// ── Build install command from npm package name ───────────────────────────────
function buildNpmInstallCmd(pkgName) {
  return `npm install -g ${pkgName}`;
}

// ── Build install command from brew formula ───────────────────────────────────
function buildBrewInstallCmd(formula) {
  return `brew install ${formula}`;
}

/**
 * Discover a CLI tool for a service dynamically.
 * Delegates to skill-builder.cjs which uses web-search-driven discovery
 * instead of narrow npm search / brew search.
 *
 * @param {string} serviceName  e.g. "twilio", "stripe", "github"
 * @param {string} capability   e.g. "sms", "payment", "vcs"
 * @returns {Promise<{ capability, provider, config } | null>}
 */
async function discoverCLI(serviceName, capability) {
  const svc = (serviceName || '').toLowerCase().trim();
  if (!svc) return null;

  logger.info(`[SkillScout] Dynamic CLI discovery (web-search) for "${svc}" (capability: ${capability})`);

  try {
    const { buildSkill } = require('./skill-builder.cjs');
    const result = await buildSkill(svc, capability || svc);
    if (result?.type === 'cli') {
      cacheToRegistry(CLI_REGISTRY_PATH, result.capability, result.provider, result.config);
      return result;
    }
  } catch (e) {
    logger.warn(`[SkillScout] skill-builder CLI discovery failed: ${e.message}`);
  }

  return null;
}

/**
 * Discover an npm SDK or native HTTPS API approach for a service dynamically.
 * Delegates to skill-builder.cjs which uses web-search-driven discovery.
 *
 * @param {string} serviceName  e.g. "stripe", "openai", "supabase"
 * @param {string} capability   e.g. "payment", "ai", "database"
 * @returns {Promise<{ capability, provider, config } | null>}
 */
async function discoverAPI(serviceName, capability) {
  const svc = (serviceName || '').toLowerCase().trim();
  if (!svc) return null;

  logger.info(`[SkillScout] Dynamic API discovery (web-search) for "${svc}" (capability: ${capability})`);

  try {
    const { buildSkill } = require('./skill-builder.cjs');
    const result = await buildSkill(svc, capability || svc);
    if (result?.type === 'api') {
      cacheToRegistry(API_REGISTRY_PATH, result.capability, result.provider, result.config);
      return result;
    }
  } catch (e) {
    logger.warn(`[SkillScout] skill-builder API discovery failed: ${e.message}`);
  }

  return null;
}

/**
 * Main entry: try CLI discovery first, then API.
 *
 * @param {string} serviceName  confirmed service name from user (e.g. "stripe")
 * @param {string} capability   capability category (e.g. "payment") — can be same as serviceName
 * @returns {Promise<{ cliMatch: object|null, apiMatch: object|null }>}
 */
async function discover(serviceName, capability) {
  const cap = capability || serviceName;
  const cliMatch = await discoverCLI(serviceName, cap);
  const apiMatch = cliMatch ? null : await discoverAPI(serviceName, cap);
  return { cliMatch, apiMatch };
}

/**
 * Validate a static registry entry is real and installable.
 * For CLI entries: verifies the install package exists on npm/brew and optionally
 *   fetches --help text if the tool is already on PATH.
 * For API entries: verifies the npm package name exists on the registry.
 *
 * @param {'cli'|'api'} type
 * @param {object}       config   registry provider config
 * @returns {Promise<{ valid: boolean, reason: string, helpText: string|null }>}
 */
async function validateRegistryEntry(type, config) {
  if (type === 'cli') {
    const { tool, installCmd, installSource } = config;

    // If tool is already on PATH, it's valid — grab --help while we're here
    const onPath = tool ? whichBinary(tool) : null;
    if (onPath) {
      let helpText = null;
      try {
        const r = spawnSync(tool, ['--help'], { timeout: 6000, encoding: 'utf8' });
        helpText = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 2000) || null;
      } catch (_) {}
      logger.info(`[SkillScout] Validate CLI: ${tool} found on PATH at ${onPath}`);
      return { valid: true, reason: `${tool} already installed`, helpText };
    }

    // Not on PATH — ensure brew exists (install if needed), then install the formula
    if (installSource === 'brew' || installSource === 'brew-cask') {
      const isCask = installSource === 'brew-cask';
      const formula = (installCmd || '')
        .replace(/^brew install\s+(--cask\s+)?/i, '').trim();
      if (!formula) return { valid: false, reason: 'No brew formula in installCmd', helpText: null };

      // ── Step 1: ensure brew is installed ─────────────────────────────────────
      let brewPath = whichBinary('brew');
      if (!brewPath) {
        logger.info('[SkillScout] brew not found — installing Homebrew (this takes ~2 min first time)…');
        const brewInstall = spawnSync('/bin/bash', [
          '-c',
          'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        ], { timeout: 300000, encoding: 'utf8', env: { ...process.env, NONINTERACTIVE: '1' } });

        if (brewInstall.status !== 0) {
          logger.warn(`[SkillScout] Homebrew install failed: ${(brewInstall.stderr || '').slice(0, 300)}`);
          return { valid: false, reason: 'Homebrew install failed — cannot proceed with brew-based CLI', helpText: null };
        }

        // Homebrew may land in /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel)
        const appleBrewPath = '/opt/homebrew/bin/brew';
        const intelBrewPath = '/usr/local/bin/brew';
        brewPath = fs.existsSync(appleBrewPath) ? appleBrewPath
                 : fs.existsSync(intelBrewPath) ? intelBrewPath
                 : whichBinary('brew');

        if (!brewPath) {
          return { valid: false, reason: 'Homebrew installed but brew binary not found on PATH', helpText: null };
        }
        logger.info(`[SkillScout] Homebrew installed at ${brewPath}`);
      }

      // ── Step 2: brew install the formula ────────────────────────────────────
      logger.info(`[SkillScout] brew install ${isCask ? '--cask ' : ''}${formula}…`);
      const installArgs = isCask ? ['install', '--cask', formula] : ['install', formula];
      const installResult = spawnSync(brewPath, installArgs, {
        timeout: 300000,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${path.dirname(brewPath)}:${process.env.PATH}` },
      });

      if (installResult.status !== 0) {
        logger.warn(`[SkillScout] brew install ${formula} failed: ${(installResult.stderr || '').slice(0, 300)}`);
        return { valid: false, reason: `brew install ${formula} failed`, helpText: null };
      }

      // ── Step 3: grab --help text now that the tool is installed ─────────────
      let helpText = null;
      if (tool) {
        try {
          const brewBin = path.join(path.dirname(brewPath), tool);
          const binToUse = whichBinary(tool) || (fs.existsSync(brewBin) ? brewBin : null);
          if (binToUse) {
            const h = spawnSync(binToUse, ['--help'], { timeout: 6000, encoding: 'utf8' });
            helpText = ((h.stdout || '') + (h.stderr || '')).trim().slice(0, 2000) || null;
          }
        } catch (_) {}
      }
      logger.info(`[SkillScout] ${tool || formula} installed via brew`);
      return { valid: true, reason: `${tool || formula} installed via brew`, helpText };
    }

    if (installSource === 'npm') {
      const pkg = (installCmd || '').replace(/^npm install\s+-g\s+/i, '').trim();
      if (!pkg) return { valid: false, reason: 'No npm package in installCmd', helpText: null };
      // First confirm the package exists on npm
      try {
        const r = spawnSync('npm', ['info', pkg, 'name', '--json'], { timeout: 10000, encoding: 'utf8' });
        if (r.status === 0 && r.stdout) {
          const info = JSON.parse(r.stdout);
          const name = typeof info === 'string' ? info : info?.name;
          if (name) {
            // Package exists — but also verify it installs a real binary, not a TS-only SDK.
            // If the tool binary is NOT on PATH already, run probeCmd to test.
            if (tool && !whichBinary(tool)) {
              const probe = spawnSync(tool, ['--version'], { timeout: 5000, encoding: 'utf8' });
              if (probe.status !== 0 && !probe.stdout && !probe.stderr) {
                logger.warn(`[SkillScout] Validate CLI: ${tool} not on PATH and probe failed — likely TS-only SDK, not a CLI binary`);
                return { valid: false, reason: `${pkg} is an npm package but installs no "${tool}" binary (likely TS-only SDK)`, helpText: null };
              }
            }
            logger.info(`[SkillScout] Validate CLI npm: ${pkg} → ${name}`);
            return { valid: true, reason: `npm package ${name} exists`, helpText: null };
          }
        }
      } catch (_) {}
      return { valid: false, reason: `npm package ${pkg} not found on registry`, helpText: null };
    }

    // Unknown install source — assume valid to avoid blocking
    return { valid: true, reason: 'unknown install source — assumed valid', helpText: null };
  }

  if (type === 'api') {
    const { npm: pkg } = config;
    // npm: null is intentional — means "use native https, no SDK install needed"
    if (pkg === null || pkg === undefined || pkg === '') {
      if (pkg === null) return { valid: true, reason: 'native https (no npm package needed)', helpText: null };
      return { valid: false, reason: 'No npm package defined', helpText: null };
    }
    try {
      const r = spawnSync('npm', ['info', pkg, 'name', 'description', '--json'], { timeout: 10000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout) {
        const info = JSON.parse(r.stdout);
        const name = typeof info === 'string' ? info : info?.name;
        if (name) {
          logger.info(`[SkillScout] Validate API npm: ${pkg} → ${name}`);
          return { valid: true, reason: `npm package ${name} exists`, helpText: null };
        }
      }
    } catch (_) {}
    return { valid: false, reason: `npm package ${pkg} not found on registry`, helpText: null };
  }

  return { valid: true, reason: 'unknown type — assumed valid', helpText: null };
}

module.exports = { discover, discoverCLI, discoverAPI, validateRegistryEntry };
