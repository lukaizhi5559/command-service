'use strict';

/**
 * skill: cli.agent
 *
 * Factory skill that discovers, installs, and manages CLI-backed narrow agents.
 * Each generated agent is stored as a structured .md descriptor in DuckDB at
 * ~/.thinkdrop/agents.db and as a .md file under ~/.thinkdrop/agents/.
 *
 * Actions:
 *   discover       { cli }                   → checks which/version/help
 *   install        { cli?, service?, method? }→ brew/npm/pip install
 *   run            { agentId, task }           → agentic: reads descriptor from DuckDB, LLM infers argv, executes
 *                  { cli, argv, cwd?, env?,   → raw: executes CLI directly (backward compat)
 *                   timeoutMs?, stdin? }
 *   build_agent    { service, cli?, force? }  → discovers CLI, generates .md descriptor,
 *                                               stores in DuckDB + ~/.thinkdrop/agents/
 *   query_agent    { service?, id? }          → retrieves agent descriptor from DuckDB
 *   list_agents    {}                         → all agents in registry
 *   validate_agent { id }                     → checks version drift, updates status
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');

// Import shell.run's allowlist so run_shell interpreter validation and
// LLM tool awareness stay in sync with what shell.run will actually accept.
const { ALLOWED_COMMANDS: SHELL_ALLOWED_COMMANDS } = require('./shell.run.cjs');

// Import shared database module
const { withDb, resetDbCache, AGENTS_DB_PATH, AGENTS_DIR } = require('@thinkdrop/agents-db');

// Subset of ALLOWED_COMMANDS that are script interpreters (accept -c or -e flag)
const _SHELL_INTERPRETERS = new Set(
  [...SHELL_ALLOWED_COMMANDS].filter(cmd =>
    /^(bash|sh|zsh|fish|node|python[23]?|ruby|perl|deno|bun)$/.test(cmd)
  )
);

const DEFAULT_TIMEOUT_MS = 15000;


// ---------------------------------------------------------------------------
// Process helper
// ---------------------------------------------------------------------------

function spawnCapture(cmd, argv = [], opts = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let proc;
    try {
      proc = spawn(cmd, argv, {
        cwd: opts.cwd || os.homedir(),
        env: { ...process.env, ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: '', exitCode: -1, error: err.message });
    }
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    if (opts.stdin) { proc.stdin.write(opts.stdin); }
    proc.stdin.end();
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr, exitCode: -1, error: 'timeout', executionTime: Date.now() - t0 });
    }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? -1, executionTime: Date.now() - t0 });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, exitCode: -1, error: err.message, executionTime: Date.now() - t0 });
    });
  });
}

async function whichCli(cli) {
  const r = await spawnCapture('which', [cli], { timeoutMs: 5000 });
  if (r.ok && r.stdout.trim()) return r.stdout.trim();
  for (const p of [
    `/usr/local/bin/${cli}`,
    `/opt/homebrew/bin/${cli}`,
    `/usr/bin/${cli}`,
    path.join(os.homedir(), '.local/bin', cli),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Known CLI map: service → install/auth metadata
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI seed cache — fast-path for well-known services.
// This is NOT a hard gate. Any service not listed here is resolved via LLM
// discovery (see resolveCLIMeta below) and the result is cached back in DuckDB.
// ---------------------------------------------------------------------------

// Bootstrap-only seed map — minimal cold-start anchors so the system can act on first run.
// This map is NEVER the source of truth after the first build+validate cycle.
// validate_agent writes corrections back to DuckDB; cli.agent reads DuckDB first.
// Do NOT add opinionated tool choices here (e.g. which CLI to use for Gmail) —
// that decision belongs to validate_agent after it checks what's actually installed.
const KNOWN_CLI_MAP = {
  github:      { cli: 'gh',          method: 'brew', pkg: 'gh',                          tokenCmd: ['auth', 'token'] },
  aws:         { cli: 'aws',         method: 'brew', pkg: 'awscli',                       tokenCmd: ['sts', 'get-caller-identity'] },
  stripe:      { cli: 'stripe',      method: 'brew', pkg: 'stripe/stripe-cli/stripe',     tokenCmd: ['config', '--list'] },
  heroku:      { cli: 'heroku',      method: 'npm',  pkg: 'heroku',                       tokenCmd: ['auth:token'] },
  netlify:     { cli: 'netlify',     method: 'npm',  pkg: 'netlify-cli',                  tokenCmd: ['status'] },
  vercel:      { cli: 'vercel',      method: 'npm',  pkg: 'vercel',                       tokenCmd: ['whoami'] },
  firebase:    { cli: 'firebase',    method: 'npm',  pkg: 'firebase-tools',               tokenCmd: ['login:ci'] },
  gcloud:      { cli: 'gcloud',      method: 'brew', pkg: 'google-cloud-sdk',             tokenCmd: ['auth', 'print-access-token'] },
  fly:         { cli: 'fly',         method: 'brew', pkg: 'flyctl',                       tokenCmd: ['auth', 'token'], installUrl: 'https://fly.io/install.sh' },
  doctl:       { cli: 'doctl',       method: 'brew', pkg: 'doctl',                        tokenCmd: ['auth', 'token'] },
  docker:      { cli: 'docker',      method: 'brew', pkg: 'docker',                       tokenCmd: null },
  twilio:      { cli: 'twilio',      method: 'npm',  pkg: 'twilio-cli',                   tokenCmd: ['profiles:list'] },
  wrangler:    { cli: 'wrangler',    method: 'npm',  pkg: 'wrangler',                     tokenCmd: ['whoami'] },
  terraform:   { cli: 'terraform',   method: 'brew', pkg: 'terraform',                    tokenCmd: null },
  kubectl:     { cli: 'kubectl',     method: 'brew', pkg: 'kubernetes-cli',               tokenCmd: ['config', 'current-context'] },
  shopify:     { cli: 'shopify',     method: 'npm',  pkg: '@shopify/cli',                 tokenCmd: ['auth', 'whoami'] },
  supabase:    { cli: 'supabase',    method: 'brew', pkg: 'supabase/tap/supabase',        tokenCmd: ['status'] },
  railway:     { cli: 'railway',     method: 'brew', pkg: 'railway',                      tokenCmd: ['whoami'] },
  render:      { cli: 'render',      method: 'npm',  pkg: 'render-cli',                   tokenCmd: ['whoami'] },
  planetscale: { cli: 'pscale',      method: 'brew', pkg: 'planetscale/tap/pscale',       tokenCmd: ['auth', 'whoami'] },
  neon:        { cli: 'neon',        method: 'npm',  pkg: 'neonctl',                      tokenCmd: ['whoami'] },
  doppler:     { cli: 'doppler',     method: 'brew', pkg: 'dopplerhq/cli/doppler',        tokenCmd: ['me', '--json'] },
  turso:       { cli: 'turso',       method: 'brew', pkg: 'tursodatabase/tap/turso',      tokenCmd: ['auth', 'whoami'] },
  resend:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://resend.com/api-keys',                    apiKeyEnvVar: 'RESEND_API_KEY' },
  openai:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://platform.openai.com/api-keys',               apiKeyEnvVar: 'OPENAI_API_KEY' },
  anthropic:   { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://console.anthropic.com/settings/keys',        apiKeyEnvVar: 'ANTHROPIC_API_KEY' },
  notion:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://www.notion.so/my-integrations',              apiKeyEnvVar: 'NOTION_API_KEY' },
  airtable:    { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://airtable.com/create/tokens',                 apiKeyEnvVar: 'AIRTABLE_TOKEN' },
  slack:       { cli: null, method: null, pkg: null, tokenCmd: null, isOAuth: true,   apiKeyUrl: 'https://api.slack.com/apps',                         apiKeyEnvVar: 'SLACK_BOT_TOKEN' },
  discord:     { cli: null, method: null, pkg: null, tokenCmd: null, isOAuth: true,   apiKeyUrl: 'https://discord.com/developers/applications',        apiKeyEnvVar: 'DISCORD_BOT_TOKEN' },
  gmail:       { cli: null, method: null, pkg: null, tokenCmd: null, isOAuth: true,  apiKeyUrl: 'https://console.cloud.google.com/apis/credentials', apiKeyEnvVar: 'GMAIL_CLIENT_ID' },
  himalaya:    { cli: 'himalaya',   method: 'brew', pkg: 'himalaya',  tokenCmd: ['account', 'list'],                   apiKeyUrl: null, apiKeyEnvVar: null },
  linear:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://linear.app/settings/api',                   apiKeyEnvVar: 'LINEAR_API_KEY' },
  sendgrid:    { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://app.sendgrid.com/settings/api_keys',         apiKeyEnvVar: 'SENDGRID_API_KEY' },
  mailgun:     { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://app.mailgun.com/settings/api_security',      apiKeyEnvVar: 'MAILGUN_API_KEY' },
  pinecone:    { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://pinecone.io/organizations/-/projects/-/keys', apiKeyEnvVar: 'PINECONE_API_KEY' },
  cohere:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://dashboard.cohere.com/api-keys',              apiKeyEnvVar: 'COHERE_API_KEY' },
  huggingface: { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://huggingface.co/settings/tokens',             apiKeyEnvVar: 'HF_TOKEN' },
  google:      { cli: 'gcloud',      method: 'brew', pkg: 'google-cloud-sdk',             tokenCmd: ['auth', 'print-access-token'] },
};

// ---------------------------------------------------------------------------
// CLI registry loader — merges runtime cli-registry.json providers into
// KNOWN_CLI_MAP so preflight and build_agent know about pandoc, ffmpeg,
// imagemagick, etc. without hardcoding them.
// ---------------------------------------------------------------------------

const CLI_REGISTRY_PATH = path.join(__dirname, '..', 'cli-registry.json');

function loadCliRegistry() {
  try {
    if (!fs.existsSync(CLI_REGISTRY_PATH)) return null;
    return JSON.parse(fs.readFileSync(CLI_REGISTRY_PATH, 'utf8'));
  } catch (err) {
    logger.warn(`[cli.agent] loadCliRegistry: failed — ${err.message}`);
    return null;
  }
}

function registryProviderToMeta(provider) {
  const method = provider.installSource?.startsWith('npm') ? 'npm'
    : provider.installSource?.startsWith('pip') ? 'pip'
    : provider.installSource?.startsWith('brew') ? 'brew'
    : provider.installSource?.startsWith('curl') ? 'curl'
    : 'brew';

  let pkg = provider.installPkg || null;
  if (!pkg && provider.installCmd) {
    const parts = provider.installCmd.trim().split(/\s+/);
    const installIdx = parts.findIndex(p => p === 'install' || p === 'i');
    const candidate = installIdx >= 0 && parts[installIdx + 1] ? parts[installIdx + 1] : null;
    pkg = candidate ? candidate.replace(/^-+/, '') : parts[parts.length - 1];
  }

  return {
    cli: provider.tool || null,
    method,
    pkg,
    tokenCmd: null,
    isOAuth: provider.authType === 'oauth',
    isApiKey: provider.authType === 'env',
    authEnv: provider.authEnv || [],
    authCmd: provider.authCmd || null,
    apiKeyEnvVar: provider.authEnv?.[0] || null,
    apiKeyUrl: provider.links?.[0]?.url || null,
    _keywords: [],
  };
}

function mergeRegistryIntoKnownMap(registry) {
  if (!registry || typeof registry !== 'object') return;
  for (const [serviceKey, serviceDef] of Object.entries(registry)) {
    const providers = serviceDef.providers || {};
    const defaultProvider = serviceDef.defaultProvider;
    const keywords = Array.isArray(serviceDef.keywords) ? serviceDef.keywords : [];

    for (const [providerKey, provider] of Object.entries(providers)) {
      const meta = registryProviderToMeta(provider);
      const key = providerKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!KNOWN_CLI_MAP[key]) {
        KNOWN_CLI_MAP[key] = { ...meta, _keywords: [...keywords, providerKey, provider.tool || ''].filter(Boolean) };
      } else if (KNOWN_CLI_MAP[key]._keywords) {
        KNOWN_CLI_MAP[key]._keywords.push(...keywords, providerKey, provider.tool || '');
      }
    }

    if (defaultProvider && providers[defaultProvider]) {
      const key = serviceKey.toLowerCase().replace(/[^a-z0-9]/g, '');
      const meta = registryProviderToMeta(providers[defaultProvider]);
      if (!KNOWN_CLI_MAP[key]) {
        KNOWN_CLI_MAP[key] = { ...meta, _keywords: [...keywords, serviceKey, defaultProvider, providers[defaultProvider].tool || ''].filter(Boolean) };
      }
    }
  }
}

const CLI_REGISTRY = loadCliRegistry();
mergeRegistryIntoKnownMap(CLI_REGISTRY);

// ---------------------------------------------------------------------------
// LLM-driven CLI meta resolution — called when service is not in KNOWN_CLI_MAP
// or when KNOWN_CLI_MAP entry has no CLI (null entries are OAuth/API-key services).
// Result is cached into DuckDB cli_meta table so LLM is only called once per service.
// ---------------------------------------------------------------------------

const CLI_DISCOVERY_SYSTEM_PROMPT = `You are a CLI and SDK knowledge base. Given a service name, return structured JSON describing how to interact with it programmatically.

For services with official CLIs: describe the CLI tool, install method, and token/auth command.
For services with only REST APIs (no CLI): say so, and describe the API key format and where to find it.
For OAuth services: say so, and describe the OAuth scopes and flow.

Output ONLY valid JSON:
{
  "hasCli": true | false,
  "cli": "<cli tool name or null>",
  "method": "brew" | "npm" | "pip" | "curl" | null,
  "pkg": "<package name for install or null>",
  "tokenCmd": ["<argv array to get current token, e.g. ['auth', 'token']>"] | null,
  "isOAuth": true | false,
  "isApiKey": true | false,
  "apiKeyEnvVar": "<common env var name for the API key, e.g. OPENAI_API_KEY>",
  "apiKeyUrl": "<URL where user finds their API key>",
  "oauthScopes": ["<scope>"],
  "notes": "<one sentence about auth/credential setup>"
}`;

async function resolveCLIMeta(service) {
  const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. DuckDB cli_meta_cache — highest priority.
  //    validate_agent writes corrected meta here; this must win over the seed map
  //    so corrections actually propagate on subsequent calls.
  let cachedMeta = null;
  try {
    await withDb(async (db) => {
      const rows = await db.all(
        "SELECT meta_json FROM cli_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { cachedMeta = JSON.parse(rows[0].meta_json); } catch {}
      }
    });
    if (cachedMeta) return cachedMeta;
  } catch {}

  // 2. Seed map — bootstrap fallback only (cold-start before any agent has been built).
  //    Never the source of truth after the first validate cycle.
  if (KNOWN_CLI_MAP[seedKey]) return KNOWN_CLI_MAP[seedKey];

  // 3. LLM discovery
  logger.info(`[cli.agent] resolveCLIMeta: LLM lookup for unknown service "${service}"`);
  const raw = await callLLM(
    CLI_DISCOVERY_SYSTEM_PROMPT,
    `Service: ${service}`,
    { temperature: 0.1, maxTokens: 400 }
  );

  let meta = null;
  if (raw) {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) meta = JSON.parse(match[0]);
    } catch {}
  }

  if (!meta) {
    // Hard fallback: no CLI, API-key assumed
    meta = { hasCli: false, cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true, isOAuth: false };
  }

  // 4. cache result in DuckDB
  try {
    await withDb(async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS cli_meta_cache (
          service     TEXT PRIMARY KEY,
          meta_json   TEXT NOT NULL,
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).catch(() => {});
      await db.run(
        "INSERT OR REPLACE INTO cli_meta_cache (service, meta_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        seedKey, JSON.stringify(meta)
      );
    });
  } catch {}

  return meta;
}

function lookupService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_CLI_MAP[key] || null;
}

// Async version: checks seed cache first, then LLM discovery
async function lookupServiceAsync(service) {
  return await resolveCLIMeta(service);
}


// ---------------------------------------------------------------------------
// Action: discover
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subcommand discovery — 3-tier: oclif → cobra → --help parse
// Returns a map of { subcmd: helpText } for the top-level subcommands.
// ---------------------------------------------------------------------------

async function discoverSubcommands(binPath) {
  const SUBCMD_CHARS = 350; // chars budget per subcommand help snippet (Tier 3 only)

  // ── Tier 1: oclif (heroku, twilio, netlify, vercel, firebase, shopify) ──
  // No cap — oclif `commands --json` returns compact {id, summary} objects (~100 chars each).
  // 100+ entries is fine for any LLM we target (OpenAI/Claude 128K+; 7B Qwen 32K+).
  try {
    const oclifResult = await spawnCapture(binPath, ['commands', '--json'], { timeoutMs: 4000 });
    if (oclifResult.ok && oclifResult.stdout.trim().startsWith('[')) {
      const commands = JSON.parse(oclifResult.stdout.trim());
      if (Array.isArray(commands) && commands.length > 0) {
        const subMap = {};
        for (const cmd of commands.slice(0, 100)) {
          const id = cmd.id || cmd.name || '';
          if (id) subMap[id] = cmd.summary || cmd.description || '';
        }
        return subMap;
      }
    }
  } catch {}

  // ── Tier 2: cobra __complete (gh, kubectl, helm, docker, fly, stripe, etc.) ──
  // No cap on top-level commands — names are compact (comma-separated strings, ~10KB total).
  // Removing the .slice() cap is the fix for cobra CLIs like `gh` which have 30+ top-level
  // commands: the old cap of 15 cut off `repo`, `pr`, `issue`, `org` etc. entirely.
  try {
    const cobraResult = await spawnCapture(binPath, ['__complete', ''], { timeoutMs: 3000 });
    if (cobraResult.ok || cobraResult.stdout.trim()) {
      const topCmds = cobraResult.stdout.trim().split('\n')
        .map(l => l.split('\t')[0].trim())
        .filter(l => l && /^[a-z][a-z0-9\-_]*$/.test(l) && l !== ':0');
      if (topCmds.length > 0) {
        const subMap = {};
        await Promise.all(topCmds.map(async (cmd) => {
          const [subResult, helpR] = await Promise.all([
            spawnCapture(binPath, ['__complete', cmd, ''], { timeoutMs: 2000 }),
            spawnCapture(binPath, [cmd, '--help'],         { timeoutMs: 3000 }),
          ]);
          // cobra __complete: visible subcommands only
          const cobraNames = (subResult.stdout || '').trim().split('\n')
            .map(l => l.split('\t')[0].trim())
            .filter(l => l && /^[a-z][a-z0-9\-_]*$/.test(l) && l !== ':0');
          // --help: ALL subcommands including Hidden=true (e.g. `star`, `unstar`)
          const helpText = helpR.stdout || helpR.stderr || '';
          const SKIP = /^(usage|examples?|flags?|options?|help|version|available|additional|core|alias)$/i;
          const helpNames = [...helpText.matchAll(/^ {2,8}([a-z][a-z0-9\-_]+)[:\s]/gm)]
            .map(m => m[1]).filter(n => n.length > 1 && !SKIP.test(n));
          // Leaf command (no cobra subcommands): store raw help text so the LLM sees actual flags/usage.
          // Command group (has subcommands): store compact comma-separated subcommand names.
          if (cobraNames.length === 0) {
            subMap[cmd] = helpText.slice(0, SUBCMD_CHARS);
          } else {
            subMap[cmd] = [...new Set([...cobraNames, ...helpNames])].join(', ');
          }
        }));
        return subMap;
      }
    }
  } catch {}

  // ── Tier 3: Universal fallback — parse --help text, fetch 1-level subcommand help ──
  // Cap at 50 — each entry stores up to SUBCMD_CHARS (350) of full help text.
  // 50 × 350 chars = ~17KB, well within any LLM context window.
  try {
    const helpResult = await spawnCapture(binPath, ['--help'], { timeoutMs: 5000 });
    const helpText = helpResult.stdout || helpResult.stderr || '';
    // Match lines like "  repo        Manage repositories"
    const subcmdMatches = [...helpText.matchAll(/^ {1,4}([a-z][a-z0-9\-_]+)\s{2,}/gm)]
      .map(m => m[1])
      .filter(s => s.length > 1)
      .slice(0, 50);
    if (subcmdMatches.length > 0) {
      const subMap = {};
      await Promise.all(subcmdMatches.map(async (cmd) => {
        const sub = await spawnCapture(binPath, [cmd, '--help'], { timeoutMs: 3000 });
        const text = (sub.stdout || sub.stderr || '').slice(0, SUBCMD_CHARS);
        if (text) subMap[cmd] = text;
      }));
      return subMap;
    }
  } catch {}

  return {};
}

async function actionDiscover({ cli }) {
  if (!cli) return { ok: false, error: 'cli is required' };
  const binPath = await whichCli(cli);
  if (!binPath) return { ok: true, installed: false, cli, binPath: null, version: null, help: null };

  const versionResult = await spawnCapture(binPath, ['--version'], { timeoutMs: 8000 });
  const helpResult    = await spawnCapture(binPath, ['--help'],    { timeoutMs: 8000 });
  const subcommandMap = await discoverSubcommands(binPath);

  return {
    ok: true,
    installed: true,
    cli,
    binPath,
    version: (versionResult.stdout || versionResult.stderr).split('\n')[0].trim() || null,
    help: (helpResult.stdout || helpResult.stderr).slice(0, 4000),
    subcommandMap,
  };
}

// ---------------------------------------------------------------------------
// Action: install
// ---------------------------------------------------------------------------

async function actionInstall({ cli, service, method }) {
  if (!cli && !service) return { ok: false, error: 'cli or service is required' };

  const meta      = service ? lookupService(service) : null;
  const cliName   = cli || meta?.cli;
  const instMethod = method || meta?.method || 'brew';
  const pkg        = meta?.pkg || cliName;
  const installUrl = meta?.installUrl || null;

  if (!cliName) return { ok: false, error: 'Cannot determine CLI name' };

  const alreadyAt = await whichCli(cliName);
  if (alreadyAt) return { ok: true, alreadyInstalled: true, cli: cliName, binPath: alreadyAt };

  // If the CLI uses a script-based install (curl | bash pattern), route through vet
  // for security: vet fetches, lints with shellcheck, diffs, and requires approval.
  if (installUrl && instMethod === 'script') {
    const vetPath = await whichCli('vet');
    if (vetPath) {
      logger.info(`[cli.agent] actionInstall: routing ${cliName} through vet for secure install from ${installUrl}`);
      const result = await spawnCapture(vetPath, [installUrl], { timeoutMs: 120000 });
      if (!result.ok) return { ok: false, error: result.stderr || result.error, stdout: result.stdout };
      const binPath = await whichCli(cliName);
      return { ok: true, alreadyInstalled: false, cli: cliName, binPath, stdout: result.stdout, vetted: true };
    }
    // vet not available — fall back to curl | bash with a security warning
    logger.warn(`[cli.agent] actionInstall: vet not available — falling back to curl|bash for ${cliName}. Install vet for secure installs: brew tap vet-run/vet && brew install vet-run`);
    const curlResult = await spawnCapture('bash', ['-c', `curl -fsSL ${installUrl} | bash`], { timeoutMs: 120000 });
    if (!curlResult.ok) return { ok: false, error: curlResult.stderr || curlResult.error, stdout: curlResult.stdout };
    const binPath = await whichCli(cliName);
    return { ok: true, alreadyInstalled: false, cli: cliName, binPath, stdout: curlResult.stdout, vetted: false };
  }

  let result;
  if (instMethod === 'brew') {
    result = await spawnCapture('brew', ['install', pkg], { timeoutMs: 180000 });
  } else if (instMethod === 'npm') {
    result = await spawnCapture('npm', ['install', '-g', pkg], { timeoutMs: 120000 });
  } else if (instMethod === 'pip' || instMethod === 'pip3') {
    result = await spawnCapture('pip3', ['install', pkg], { timeoutMs: 120000 });
  } else {
    return { ok: false, error: `Unknown install method: ${instMethod}` };
  }

  if (!result.ok) return { ok: false, error: result.stderr || result.error, stdout: result.stdout };

  const binPath = await whichCli(cliName);
  return { ok: true, alreadyInstalled: false, cli: cliName, binPath, stdout: result.stdout };
}

// ---------------------------------------------------------------------------
// Action: run — agentic loop helpers
// ---------------------------------------------------------------------------

/**
 * Upgrades a CLI binary in-place via the appropriate package manager.
 * Called by the agentic loop `run_update` action — never prompts the user.
 */
async function agentRunUpdate(cliName, meta) {
  const method = meta?.method || 'brew';
  const pkg    = meta?.pkg    || cliName;
  logger.info(`[cli.agent] agentRunUpdate: ${method} force-reinstall ${pkg}`);
  let result;
  if (method === 'brew') {
    // reinstall (not upgrade) — forces clean relink even when brew thinks it's already current.
    // Fixes PATH shadowing where an old binary overrides the brew-managed one.
    result = await spawnCapture('brew', ['reinstall', pkg], { timeoutMs: 180000 });
    if (result.ok) {
      await spawnCapture('brew', ['link', '--overwrite', pkg], { timeoutMs: 30000 });
    }
  } else if (method === 'npm') {
    // Clear npm cache first, then force-reinstall global package
    await spawnCapture('npm', ['cache', 'clean', '--force'], { timeoutMs: 30000 });
    result = await spawnCapture('npm', ['install', '-g', `${pkg}@latest`], { timeoutMs: 120000 });
  } else if (method === 'pip' || method === 'pip3') {
    // --force-reinstall re-downloads and reinstalls even if already up-to-date
    result = await spawnCapture('pip3', ['install', '--force-reinstall', '--upgrade', pkg], { timeoutMs: 120000 });
  } else {
    return { ok: false, error: `Unknown install method: ${method}` };
  }
  return { ok: result.ok, stdout: result.stdout || result.stderr || '', error: result.error };
}

async function agentWebSearch(query) {
  const http = require('http');
  const { URL } = require('url');
  const wsUrl = new URL(process.env.MCCP_WEB_SEARCH_API_URL || 'http://127.0.0.1:3002');
  const wsApiKey = process.env.MCP_WEB_SEARCH_API_KEY || '';
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'web-search',
      requestId: `ws_${Date.now()}`, action: 'search',
      payload: { query, maxResults: 3 },
    });
    const req = http.request({
      hostname: wsUrl.hostname, port: parseInt(wsUrl.port) || 3002,
      path: '/web.search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${wsApiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.results || parsed?.results || [];
          if (results.length === 0) { resolve(`web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); return; }
          resolve(results.slice(0, 3).map(r => `${r.title}\n${r.description}`).join('\n---\n'));
        } catch { resolve(data.slice(0, 600) || `web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); }
      });
    });
    req.on('error', (e) => resolve(`web_search failed: ${e.message || 'connection error'} — try web_fetch with a direct docs URL instead`));
    req.setTimeout(5000, () => { req.destroy(); resolve(`web_search timed out for: "${query}" — try web_fetch with a direct docs URL instead`); });
    req.write(body);
    req.end();
  });
}

async function agentWebFetch(url) {
  const WEB_FETCH_CHARS = 2000;
  const pc = await spawnCapture('/opt/homebrew/bin/playwright-cli', ['fetch', url], { timeoutMs: 15000 });
  if (pc.ok && pc.stdout.trim()) return pc.stdout.slice(0, WEB_FETCH_CHARS);
  const cr = await spawnCapture('curl', ['-sL', '--max-time', '10', url], { timeoutMs: 15000 });
  if (cr.stdout) return cr.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, WEB_FETCH_CHARS);
  return '';
}

// Builds the systemInstructions for a loop turn: loop prompt + trimmed descriptor.
// Descriptor is placed in system (not user) to avoid WS bridge prompt-field size limits.
function buildTurnSystemPrompt(descriptor, learnedRules, userContext) {
  const DESCRIPTOR_LIMIT = 3000;
  const trimmedDescriptor = (descriptor || '(none)').slice(0, DESCRIPTOR_LIMIT);
  const rulesSection = (Array.isArray(learnedRules) && learnedRules.length > 0)
    ? '\n\n## Learned Command Rules (from past runs)\n' + learnedRules.map(r => `- ${r}`).join('\n')
    : '';
  // User context: authenticated identities so the LLM knows the correct owner/account
  // without guessing (e.g. github: lukaizhi5559 → use -R lukaizhi5559/repo, not repo/repo)
  const userContextSection = (userContext && Object.keys(userContext).length > 0)
    ? '\n\n## User Context (authenticated identities — use these, do NOT guess)\n' +
      Object.entries(userContext).map(([svc, user]) => `- ${svc}: ${user}`).join('\n')
    : '';
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const currentDate = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const temporalContext = `\n\n## Temporal Context\nCurrent local date: ${currentDate}. Time zone: ${timezone}. For a month/day with no year that has already passed this year, schedule the next occurrence. For an event with no time, create an all-day event. Never invent a historical year.`;
  return `${CLI_AGENTIC_LOOP_PROMPT}\n\n## Agent Descriptor\n${trimmedDescriptor}${rulesSection}${userContextSection}${temporalContext}`;
}

// Builds the user-turn prompt for a loop turn: task + history only (~200-400 chars).
function buildTurnPrompt(task, history) {
  const histLines = history.length === 0
    ? '(none — this is turn 1)'
    : history.map(h => {
        const parts = Object.entries(h)
          .filter(([k]) => k !== 'turn' && k !== 'observation')
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
        return `  Turn ${h.turn}: ${parts}\n    Observation: ${h.observation}`;
      }).join('\n\n');
  return `## Task\n${task}\n\n## Turn History\n${histLines}\n\n## Next Action\nOutput a single JSON action object.`;
}

// Summarizes stderr for the LLM observation. Head-only truncation drops the
// concrete error for argparse-style CLIs (Python/Go) which print the actual
// "error: unrecognized arguments: --foo" line at the END, after a long usage
// block. Always surface the last few error-bearing lines alongside the head.
function summarizeStderr(stderr, headChars = 400) {
  const s = stderr || '';
  const head = s.slice(0, headChars);
  const errLines = s.split('\n')
    .filter(l => /\berror\b|invalid|unrecognized|unexpected|not recognized|missing required/i.test(l))
    .slice(-3)
    .join('\n');
  return errLines && !head.includes(errLines) ? `${head}\n[KEY ERROR LINES]:\n${errLines}` : head;
}

const CLI_AGENTIC_LOOP_PROMPT = `You are an expert CLI automation agent executing a user task step-by-step.
You have access to a CLI tool described in the Agent Descriptor below. The descriptor is the ONLY source of truth for what commands exist — do NOT invent or guess commands from training knowledge.
Each turn you output exactly ONE JSON action object from this palette:

  run_cmd    – execute CLI command:         { "action": "run_cmd", "argv": [...] }
  run_help   – read subcommand help:        { "action": "run_help", "subcmd": [...] }
  run_shell  – script for probing/piping:   { "action": "run_shell", "script": "...", "interpreter": "bash" }
             interpreters: bash (default) | node | python3
             bash:    "yt-dlp --help 2>&1 | grep -A3 'sub'"
             node:    "const r=require('child_process').execSync('yt-dlp --version').toString(); console.log(r)"
             python3: "import subprocess,json; r=subprocess.run(['yt-dlp','--version'],capture_output=True); print(r.stdout.decode())"
  run_update – upgrade CLI to latest:       { "action": "run_update", "cli": "<name>" }
  web_search – search for docs/examples:   { "action": "web_search", "query": "..." }
  web_fetch  – read a docs/reference URL:  { "action": "web_fetch", "url": "..." }
  done       – task complete:              { "action": "done", "summary": "..." }
  ask_user   – need user clarification:    { "action": "ask_user", "question": "...", "options": [], "save_rule": "..." }  (save_rule optional — see Rules)

Each action object may include an optional "thinking" field: one sentence (max 120 chars) explaining why you chose this action. Example: { "action": "run_help", "subcmd": [], "thinking": "Need to check yt-dlp flag syntax before running." }

Rules:
- argv must NOT include the CLI binary name itself — only the subcommand and its arguments.
- ONLY use subcommands and flags explicitly listed in the Agent Descriptor. Do NOT guess or invent commands from training knowledge — the descriptor is authoritative. EXCEPTION: if the CLI tool itself emits a WARNING: line recommending a specific flag (e.g. "add --js-runtimes node", "use --config"), you MAY add that exact flag on the next retry even if it is not in the descriptor. This is self-healing behavior — the tool is telling you what it needs.
- If the required subcommand or flag is NOT in the descriptor, use run_help FIRST — it reads the CLI's own built-in docs in 1 turn and is always more accurate than web_search. For subcommand CLIs (gh, docker, aws) pass the relevant subcmd path. For flag-driven CLIs (yt-dlp, ffmpeg, curl) where flags are not subcommands, pass a relevant section keyword if available, e.g. ["--help"]. Only fall back to web_search if run_help output is insufficient or the operation is completely novel.
- Do NOT issue web_search on turn 1 if the CLI tool is installed and you only need flag syntax — run_help is faster, free, and the tool's own docs are the authoritative source.
- web_search and web_fetch are your fallback sources when run_help is insufficient — prefer fresh docs over assumptions. If 2 consecutive web_search turns returned "no results", STOP searching — hard-pivot to web_fetch with the best official docs URL you know. Do NOT keep issuing web_search with variant queries.
- After run_cmd returns exitCode=0: if the task is fully complete (write/delete/star/follow — no output to process), output done. If the output needs further processing (decode base64, extract a URL or path, save content to a file), continue with the next action.
- Use run_help when you need exact flags or argument format. \`subcmd\` is the path WITHOUT the binary — e.g. \`["compose", "up"]\` fetches \`docker compose up --help\`. For flag-driven CLIs with no subcommands (e.g. yt-dlp, ffmpeg, curl), use an empty array \`[]\` to fetch the full --help, which contains all flag syntax. The run_help output is automatically keyword-filtered to show lines relevant to the current task.
- run_shell is your PRIMARY DIAGNOSTIC INSTRUMENT — use it to probe any unknown before making assumptions or giving up. It is not just for flag discovery; it is how you test hypotheses about WHY something failed. run_shell for PROBING/DIAGNOSIS; run_cmd for primary task execution.
  Diagnostic uses: verify a URL is live, check a dependency exists, grep help output, test a permission, inspect a file, confirm env vars.
  Interpreter guidance: use "bash" (default) for grep/pipe/head/curl; use "node" when you need JSON.parse, regex processing, or child_process; use "python3" for data manipulation.
  Example: { "action": "run_shell", "script": "yt-dlp --help 2>&1 | grep -B1 -A3 'sub\\|caption\\|vtt'", "interpreter": "bash" }
  Within bash scripts, you can use any allowlisted system tool: jq, curl, wget, grep, sed, awk, head, tail, wc, sort, uniq, cut, base64, ffmpeg, ffprobe, git, node, python3, and all standard Unix utilities.
- Use run_update only when the CLI binary itself is confirmed missing or broken — never for unknown subcommands.
- Output JSON only. No prose before or after the JSON object.
- When you discover that a class of subcommands does NOT exist and there is a general escape-hatch alternative, write a BROAD save_rule that covers ALL similar operations — not just the one you just solved. The rule must include: (1) what pattern of operations has no dedicated subcommand, (2) the general escape-hatch command with syntax, (3) at least 3 examples covering different operation types so future runs never need to rediscover this pattern.
  Bad (too narrow): "'gh repo star' does not exist. Use: gh api --method PUT /user/starred/{owner}/{repo}."
  Good (broad): "Many 'gh' operations have no dedicated subcommand — use 'gh api --method GET/PUT/DELETE/POST <REST endpoint>' for all of them. Syntax: run_help [\"api\"] shows full flags. Examples: star=PUT /user/starred/{owner}/{repo}, unstar=DELETE /user/starred/{owner}/{repo}, readme=GET /repos/{owner}/{repo}/readme, releases=GET /repos/{owner}/{repo}/releases, follow_user=PUT /user/following/{username}."
- ask_user is the LAST RESORT. Do NOT use ask_user until you have run at least one diagnostic probe (run_shell or run_help) after a failure. The user should never see ask_user for a failure that a 1-line shell probe could have explained or resolved.
- Never use ask_user for CLI version or installation issues — use run_update instead.
- MULTI-TURN ask_user: When processing a resume context where the user selected an option that implies a value is needed (e.g. "Yes, specify duration") but the actual value was NOT provided in the answer, emit another ask_user with an EMPTY options array to collect the specific value via free-text input. Do NOT guess or hallucinate values the user did not explicitly provide. The UI will show a free-text input field when options is empty.

## Universal Failure Protocol — DIAGNOSE FIRST (applies to every run_cmd exitCode≠0)

When run_cmd returns exitCode≠0, your FIRST job is to DIAGNOSE the failure category before retrying or escalating.
Every CLI failure belongs to one of 5 categories. Identify the category from the error signal, then run the corresponding probe:

**Category A — Wrong flags/syntax**
  Signals: "unknown option", "invalid", "unrecognized", "unexpected argument", "missing required"

  Step A-1 (MANDATORY): Probe for the correct flag:
    run_shell: <cli> --help 2>&1 | grep -B2 -A4 '<keyword from error>'

  Step A-2 (MANDATORY if probe shows the correct syntax):
    Output run_cmd immediately with the corrected flags from the help output.
    DO NOT use ask_user if the help output reveals the correct flag — apply it directly.
    Only use ask_user if 2 consecutive run_help/run_shell probes both fail to reveal the correct syntax.

**Category B — Missing dependency or runtime**
  Signals: WARNING about missing runtime/component, "not found", "install", "requires", "no such file"

  Step B-1 (MANDATORY): Probe whether the dependency exists:
    run_shell: which <dependency> 2>&1; <dependency> --version 2>&1

  Step B-2 (MANDATORY — DO NOT use ask_user for a missing runtime):
    - If dependency exists → retry run_cmd with the correct runtime flag (e.g. --js-runtimes node)
    - If dependency is missing → run_update to install it; never ask the user to install it manually
  Special: if WARNING mentions "Remote component challenge solver script... skipped", add --remote-components ejs:github to next run_cmd alongside --js-runtimes node.

**Category C — Bad input (URL dead, file missing, ID deleted, resource removed)**
  Signals: "unavailable", "not found", "404", "does not exist", "private", "removed", "Video unavailable", "No such file"
  This error is about the TARGET (URL/file/ID), NOT the command syntax — do NOT change flags first.

  Step C-1 (MANDATORY): Probe the input to confirm it is dead:
    run_shell: <cli> --<cheapest-verify-flag> '<input>' 2>&1
    Examples: yt-dlp --get-title --js-runtimes node --remote-components ejs:github '<url>'; curl -sI '<url>' | head -3; ls -la '<filepath>'

  Step C-2a (if probe exitCode≠0 — input is confirmed dead — MANDATORY before ask_user):
    Search for a working alternative in the SAME run_shell turn or next turn:
      - YouTube URL dead: run_shell: yt-dlp --flat-playlist --get-url --js-runtimes node --remote-components ejs:github 'ytsearch3:<video title and creator>' 2>&1 | head -5
      - File missing: run_shell: find ~ -name '<filename>' -type f 2>/dev/null | head -5
    Take the FIRST returned URL/path and immediately output run_cmd with it.
    DO NOT use ask_user before attempting this alternative search — it is MANDATORY.
    Only use ask_user if the alternative search itself returns no results or all alternatives also fail.

  Step C-2b (if probe exitCode=0 — input is alive):
    The original flags were wrong → retry run_cmd with corrected flags (not a Category C issue after all).

**Category D — Tool itself broken or missing**
  Signals: "command not found", segfault, "No such file or directory" for the binary, version mismatch

  Step D-1 (MANDATORY): Probe whether the tool exists and its version:
    run_shell: which <cli> 2>&1; <cli> --version 2>&1

  Step D-2 (MANDATORY — DO NOT use ask_user for a missing or broken binary):
    - If tool found but version is outdated → run_update immediately
    - If tool not found at all → run_update to install it
    Never ask the user to install or update a CLI manually — run_update handles it.

**Category E — Environment, auth, or network failure**
  Signals: "permission denied", "unauthorized", "403", "401", "connection refused", "token expired", "SSL error"
  Probe:   run_shell: curl -sI '<url>' 2>&1 | head -5  OR  <cli> whoami 2>&1  OR  <cli> auth status 2>&1
  Fix:     surface the specific finding to the user with ask_user — include what the probe returned.

**Category F — Interactive TUI / requires PTY (terminal emulator)**
  Signals: "No tty detected", "interactive terminal required", "not a tty", "requires a terminal", "must be run in a terminal", "isatty"
  Root cause: The tool calls isatty() at the OS level. NO flag (-t, --tty, --no-tty, --force-tty, --batch) can bypass a missing PTY — these flags change rendering mode only, not whether a PTY exists.
  DO NOT: retry with -t or --no-tty — both will fail with the same error. DO NOT: use ask_user for this.

  Step F-1 (MANDATORY — skip ALL flag retries):
    Output run_shell immediately with a non-interactive equivalent that achieves the same goal:
    - System resource monitor / top processes: run_shell "top -l 1 -n 10 -o cpu 2>/dev/null | head -30 || ps aux --sort=-%cpu | head -15"
    - Disk usage: run_shell "df -h && du -sh /* 2>/dev/null | sort -rh | head -20"
    - Memory stats: run_shell "vm_stat 2>/dev/null || free -h 2>/dev/null"
    - Network stats: run_shell "netstat -an | head -30 || ss -tuln | head -20"
    - If the tool has a --once, --batch, or --export flag: try run_cmd with that flag instead of run_shell.

  Step F-2: After run_shell succeeds, call done with the output — the task is complete.
    If run_shell also fails: call done with a clear explanation:
    "This tool requires an interactive terminal (PTY) and cannot run in the automation environment. Here is equivalent data from system utilities: [any partial output]"

  NEVER use ask_user for "No tty detected" — it is a fixed environment constraint, not a user decision.
  NEVER retry run_cmd with tty-related flags after seeing this error even once.

**ORDERING RULE:**
1. Read the error signal → identify category A/B/C/D/E/F
2. Run the cheapest probe that confirms the hypothesis (1 run_shell turn)
3. Apply the category fix
4. Only escalate to ask_user after probe confirms the problem cannot be self-resolved

## Mandatory recovery protocol when run_cmd fails with "unknown command"
If run_cmd returns exitCode≠0 with "unknown command" in the stderr observation:
1. Do NOT retry variants. Do NOT use run_update.
2. Read the [auto-fetched help] block appended to the observation — if it shows the correct syntax, output run_cmd immediately with that syntax.
3. If the auto-fetched help does NOT reveal the correct syntax, try run_help on a likely escape-hatch subcommand: ["api"], ["call"], or ["request"]. If the help output confirms an escape-hatch pattern → output run_cmd directly with that syntax, then use ask_user with a broad save_rule covering the whole pattern.
4. Only if run_help is insufficient: output web_search with query: "<cli-name> <operation> REST API official docs".
5. Next turn: read the observation — if URLs are visible, output web_fetch with the most relevant official docs URL.
6. If the fetched page confirms the correct command syntax → output run_cmd with exactly that syntax.
7. If the fetched page shows the command does NOT exist or provides an alternative → output ask_user.
   The ask_user message MUST explain: what you searched, what the docs say, and the best alternative found.
   IMPORTANT: When proposing a specific command, embed it in the option text so the user's choice becomes an actionable task — NOT just "Yes, use the alternative".
   IMPORTANT: save_rule must be BROAD — cover the general pattern, not just the one operation you just solved (see save_rule guidance above).
   Example: { "action": "ask_user", "question": "I couldn't find a 'gh repo star' command. The gh CLI uses 'gh api --method <METHOD> <endpoint>' for REST operations without dedicated subcommands. Would you like me to use that?", "options": ["Yes, run: gh api --method PUT /user/starred/microsoft/vscode", "No, cancel"], "save_rule": "Many 'gh' operations have no dedicated subcommand — use 'gh api --method GET/PUT/DELETE/POST <REST endpoint>'. Syntax: run_help [\"api\"] shows full flags. Examples: star=PUT /user/starred/{owner}/{repo}, unstar=DELETE /user/starred/{owner}/{repo}, readme=GET /repos/{owner}/{repo}/readme, releases=GET /repos/{owner}/{repo}/releases, follow_user=PUT /user/following/{username}." }
- ask_user can also be used to present a discovered alternative at any point — always include what was searched, what was found, and the proposed command.
- Never use ask_user for CLI version or installation issues — use run_update instead.

## Mandatory recovery protocol when run_cmd observation contains [ACTIONABLE WARNINGS]
If the observation starts with "[ACTIONABLE WARNINGS — act on these]:", the CLI tool itself is telling you how to fix the command:
1. Read every WARNING line carefully — it is authoritative, higher priority than the descriptor.
2. On the NEXT turn, retry run_cmd with the suggested flag/option added to the previous argv.
   - If the warning says "add --flag VALUE", add exactly that to argv.
   - If the warning says an optional dependency is missing (e.g. deno, bun), try the next available runtime flag first (e.g. --js-runtimes node, then --js-runtimes bun) before escalating.
3. Do NOT issue web_search for something the CLI warning already told you.
4. Do NOT repeat the identical argv — always incorporate the warning's suggestion.
5. If the retry still fails with a new warning, apply that warning's suggestion in the next turn.
6. Only escalate to ask_user if 2 consecutive WARNING-driven retries both fail with exitCode≠0 and no new actionable warning is present.
   Special case: if WARNING mentions "Remote component challenge solver script (node) was skipped", add --remote-components ejs:github alongside --js-runtimes node on the next retry — both flags are required together for yt-dlp YouTube extraction.`;

// ---------------------------------------------------------------------------
// Action: run
// ---------------------------------------------------------------------------

const CLI_RUN_SYSTEM_PROMPT = `You are a CLI command inference engine. Given an agent descriptor (which describes a CLI tool, its capabilities, and help text) and a plain-language task, output the minimal argv array needed to accomplish that task.

Output ONLY valid JSON — an object with exactly these fields:
{
  "argv": ["<arg1>", "<arg2>", ...],
  "reasoning": "<one sentence explaining the command choice>"
}

Rules:
- argv should NOT include the CLI binary name itself, only the arguments
- Prefer subcommands from the descriptor's Subcommand Reference or CLI Help Reference; for well-known CLIs (gh, aws, gcloud, kubectl, heroku, firebase, fly, doctl, stripe, vercel, netlify, railway, docker), also draw on your expert knowledge of the CLI when the specific subcommand is not in the descriptor
- If the descriptor shows authentication is persistent (already logged in), do NOT add auth steps
- If the task is ambiguous, pick the most common/safe interpretation
- If the task genuinely cannot be expressed as a single CLI invocation, set argv to [] and explain in reasoning`;

async function actionRun({ cli, argv = [], cwd, env, timeoutMs, stdin, agentId, task, _progressCallbackUrl, _stepIndex }) {
  // ── Agentic path: agentId + task → LLM infers argv from descriptor ──
  if (agentId && task) {
    const agentResult = await withDb(async (db) => {
      const rows = await db.all(
        'SELECT id, cli_tool, descriptor, status FROM agents WHERE id = ?', agentId
      ).catch(() => null);

      if (!rows || rows.length === 0) {
        return { ok: false, error: `No agent found: ${agentId}. Use action:build_agent to create it first.`, needsBuild: true };
      }

      const agent = rows[0];
      if (agent.status === 'needs_update') {
        logger.warn(`[cli.agent] run: agent ${agentId} status=needs_update, proceeding anyway`);
      }

      const cliTool = agent.cli_tool;
      if (!cliTool) return { ok: false, error: `Agent ${agentId} has no cli_tool — cannot run` };

      const binPath = await whichCli(cliTool);
      if (!binPath) {
        return { ok: false, error: `CLI not found: ${cliTool}. Run action:build_agent to reinstall.`, needsBuild: true };
      }

      logger.info(`[cli.agent] agentic run: ${agentId} task="${task}"`);
      return { ok: true, agent, cliTool, binPath };
    });

    if (!agentResult.ok) return agentResult;
    const { agent, cliTool, binPath } = agentResult;

    // ── pre_steps: execute shared services before the CLI loop ──────────────
    // Descriptor frontmatter may declare pre_steps that must run first.
    // Supported purposes:
    //   resolve_url  → calls web.agent search to find a URL; injects {{resolvedUrl}}
    //   resolve_user → calls user.agent to get user context; injects {{userName}}, {{userEmail}}
    // Results are injected as template tokens into the task string before the loop.
    let resolvedTask = task;
    try {
      const _fmMatch = (agent.descriptor || '').match(/^---\s*\n([\s\S]*?)\n---/);
      if (_fmMatch) {
        const _yaml = _fmMatch[1];
        const _preStepsMatch = _yaml.match(/pre_steps:\s*\n((?:\s+-[^\n]*\n?)*)/);
        if (_preStepsMatch) {
          const _preLines = _preStepsMatch[1].split('\n')
            .map(l => l.trim().replace(/^-\s*/, ''))
            .filter(Boolean);

          for (const _preLine of _preLines) {
            // Parse "skill: web.agent action: search_and_navigate purpose: resolve_url"
            const _skillM   = _preLine.match(/skill:\s*(\S+)/);
            const _purposeM = _preLine.match(/purpose:\s*(\S+)/);
            const _skill    = _skillM?.[1] || '';
            const _purpose  = _purposeM?.[1] || '';

            if (_skill === 'web.agent' && _purpose === 'resolve_url') {
              logger.info(`[cli.agent] pre_step: web.agent resolve_url for task "${task.slice(0, 80)}"`);
              try {
                // ── Fast path: URL already present in the task string ──────────
                // If the task already contains a URL (e.g. second invocation after
                // web.agent found one), use it directly — skip the web search entirely.
                // This prevents resolve_url from replacing a known YouTube URL with an
                // unrelated blog result that the generic extractor cannot handle.
                const _existingUrlMatch = task.match(/https?:\/\/[^\s"'<>]+/);
                let _resolvedUrl = _existingUrlMatch ? _existingUrlMatch[0] : '';

                if (!_resolvedUrl) {
                  // ── Web search path ──────────────────────────────────────────
                  // Bias the web search toward the platform the CLI is designed for.
                  // Inferred from: (1) task text platform signals, (2) agent descriptor capabilities.
                  // No hardcoded CLI names — fully data-driven.
                  const _taskLower = task.toLowerCase();
                  let _searchBias = '';
                  // Hoist _isMediaDownloader before the if/else so it is always in scope.
                  const _agentCaps = (agent?.capabilities || []).join(' ').toLowerCase();
                  const _isMediaDownloader = /download|extract_audio|extract_subtitle|write_subs|write_auto_subs|stream/.test(_agentCaps);
                  if (_taskLower.includes('youtube') || _taskLower.includes('youtu.be')) {
                    _searchBias = ' site:youtube.com';
                  } else {
                    if (_isMediaDownloader) _searchBias = ' site:youtube.com';
                  }
                  const _searchSnippets = await agentWebSearch(task + _searchBias);
                  // For media downloader agents (or youtube-biased searches), require a
                  // youtube.com/watch URL specifically — prevents picking up recipe blog
                  // URLs or other non-video pages that yt-dlp cannot process.
                  if (_isMediaDownloader || _searchBias.includes('youtube.com')) {
                    const _ytMatch = _searchSnippets.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?[^\s"'<>]+/);
                    _resolvedUrl = _ytMatch ? _ytMatch[0] : '';
                  }
                  // Fall back to first URL in snippets only if no platform-specific match found
                  if (!_resolvedUrl) {
                    const _urlMatch = _searchSnippets.match(/https?:\/\/[^\s"'<>]+/);
                    _resolvedUrl = _urlMatch ? _urlMatch[0] : '';
                  }
                }

                if (_resolvedUrl) {
                  logger.info(`[cli.agent] pre_step: resolved URL = ${_resolvedUrl}`);
                  resolvedTask = resolvedTask.replace(/\{\{resolvedUrl\}\}/g, _resolvedUrl);
                  // Also append URL to task if no template token present
                  if (!task.includes('{{resolvedUrl}}')) {
                    resolvedTask = `${resolvedTask} URL: ${_resolvedUrl}`;
                  }
                }
              } catch (_preErr) {
                logger.warn(`[cli.agent] pre_step web.agent failed (non-fatal): ${_preErr.message}`);
              }

            } else if (_skill === 'web.agent' && _purpose === 'resolve_file') {
              // resolve_file: extract a file path from the task, resolving to an absolute path.
              // Checks common user locations in priority order.
              logger.info(`[cli.agent] pre_step: resolve_file for task "${task.slice(0, 80)}"`);
              try {
                const _fs = require('fs');
                const _os = require('os');
                const _path = require('path');

                // Try to extract an explicit file reference from the task string
                const _fileMatch = task.match(
                  /(?:file|path|input|source|from|open|read|process|convert|encode)\s+["\u2018\u2019\u201c\u201d]?([^\s"'<>]+\.[a-zA-Z0-9]{2,6})["\u2018\u2019\u201c\u201d]?/i
                ) || task.match(/([~/]?(?:[^/\s]+\/)+[^/\s]+\.[a-zA-Z0-9]{2,6})/);

                const _rawFilePath = _fileMatch ? _fileMatch[1] : null;

                if (_rawFilePath) {
                  // Resolve ~ to home
                  const _expandedPath = _rawFilePath.startsWith('~')
                    ? _path.join(_os.homedir(), _rawFilePath.slice(1))
                    : _rawFilePath;

                  // Check absolute path first, then search common locations
                  const _searchDirs = [
                    '',                                          // as-is / absolute
                    _os.homedir(),
                    _path.join(_os.homedir(), 'Downloads'),
                    _path.join(_os.homedir(), 'Desktop'),
                    _path.join(_os.homedir(), 'Documents'),
                    process.cwd(),
                  ];

                  let _resolvedFile = null;
                  for (const _dir of _searchDirs) {
                    const _candidate = _dir ? _path.join(_dir, _path.basename(_expandedPath)) : _expandedPath;
                    if (_fs.existsSync(_candidate)) {
                      _resolvedFile = _candidate;
                      break;
                    }
                  }

                  if (_resolvedFile) {
                    logger.info(`[cli.agent] pre_step: resolved file = ${_resolvedFile}`);
                    resolvedTask = resolvedTask.replace(/\{\{resolvedFile\}\}/g, _resolvedFile);
                    if (!task.includes('{{resolvedFile}}')) {
                      resolvedTask = `${resolvedTask} FILE: ${_resolvedFile}`;
                    }
                  } else {
                    logger.warn(`[cli.agent] pre_step resolve_file: "${_rawFilePath}" not found in common locations`);
                    // Still inject the raw path — let the CLI agent handle the error
                    resolvedTask = resolvedTask.replace(/\{\{resolvedFile\}\}/g, _expandedPath);
                    if (!task.includes('{{resolvedFile}}')) {
                      resolvedTask = `${resolvedTask} FILE: ${_expandedPath}`;
                    }
                  }
                }
              } catch (_preErr) {
                logger.warn(`[cli.agent] pre_step resolve_file failed (non-fatal): ${_preErr.message}`);
              }

            } else if (_skill === 'web.agent' && _purpose === 'resolve_query') {
              // resolve_query: convert a natural-language task into a structured search/query string.
              // Uses agentWebSearch to find relevant context, then extracts the best query.
              logger.info(`[cli.agent] pre_step: resolve_query for task "${task.slice(0, 80)}"`);
              try {
                const _snippets = await agentWebSearch(task);
                // Extract the most relevant title line as a structured query
                const _titleMatch = _snippets.match(/^(.+?)(?:\n|$)/);
                const _resolvedQuery = _titleMatch ? _titleMatch[1].trim() : task.slice(0, 120);
                if (_resolvedQuery) {
                  logger.info(`[cli.agent] pre_step: resolved query = "${_resolvedQuery.slice(0, 80)}"`);
                  resolvedTask = resolvedTask.replace(/\{\{resolvedQuery\}\}/g, _resolvedQuery);
                  if (!task.includes('{{resolvedQuery}}')) {
                    resolvedTask = `${resolvedTask} QUERY: ${_resolvedQuery}`;
                  }
                }
              } catch (_preErr) {
                logger.warn(`[cli.agent] pre_step resolve_query failed (non-fatal): ${_preErr.message}`);
              }
            }
          }
        }
      }
    } catch (_preStepErr) {
      logger.warn(`[cli.agent] pre_steps parse failed (non-fatal): ${_preStepErr.message}`);
    }
    const effectiveTask = resolvedTask;

    // ── Meta-task safety net: "rebuild/refresh/recreate/reset [X] agent" ──
    // These are agent-management commands, not CLI tasks — route to build_agent.
    if (/\b(rebuild|recreate|refresh|reset|reinitializ[e]?|re-?build|re-?create)\b/i.test(task) &&
        /\bagent\b/i.test(task)) {
      const service = (agent.service || cliTool || agentId.replace(/\.agent$/i, ''));
      logger.info(`[cli.agent] run: meta-task detected ("${task}") — redirecting to build_agent for service "${service}"`);
      return await actionBuildAgent({ service, force: true });
    }

    // ── Multi-turn agentic loop ──
    const MAX_TURNS = 12;
    const OBSERVATION_CHARS = 600;
    const RUN_HELP_CHARS = 3000; // larger budget for run_help — flag syntax needs space
    const loopHistory = [];
    const transcript = [];
    let currentBinPath = binPath;
    let loopMeta = null; // lazy-loaded on first run_update
    // Loop guard: track exact failing argv signatures + total failed run_cmd turns
    // so the LLM doesn't burn all turns re-running near-identical failing commands.
    const failedArgvSigs = new Map(); // JSON.stringify(argv) → fail count
    let totalFailedRunCmds = 0;

    // ── Resume context injection ──────────────────────────────────────────────
    // When main.js resumes after an ask_user pause, it appends a [Resume context:]
    // block to the task string. Parse it and pre-populate loopHistory with
    // synthetic prior turns so the LLM doesn't restart from turn 1 and repeat
    // the same failed probe sequence it already ran before pausing.
    //
    // Supports two formats:
    //   1. Legacy single-pair: [Resume context: You previously asked "Q". The user answered: "A". Continue from this point based on the user's answer.]
    //   2. Multi-pair: [Resume context:\n  Previous Q&A:\n  1. Q: "Q1" → A: "A1"\n  2. Q: "Q2" → A: "A2"\n  Continue from this point. If any answer is a choice that implies a value is needed but doesn't contain the actual value, emit another ask_user to collect it. Do NOT guess values.]
    const _legacyResumeMatch = effectiveTask.match(/\[Resume context: You previously asked "(.+?)"\. The user answered: "(.+?)"\. Continue from this point based on the user's answer\.\][\s\S]*/s);
    const _multiResumeMatch = effectiveTask.match(/\[Resume context:\s*\n\s*Previous Q&A:\s*\n([\s\S]*?)\n\s*Continue from this point\.[\s\S]*?\]/s);

    if (_legacyResumeMatch) {
      const _priorQuestion = _legacyResumeMatch[1];
      const _userAnswer    = _legacyResumeMatch[2];
      loopHistory.push({
        turn: 1,
        action: 'ask_user',
        question: _priorQuestion,
        observation: `User answered: "${_userAnswer}". Continue from this point — do NOT repeat previous diagnostic attempts. If the user's answer indicates a DIRECTION (e.g. "duration" / "Specify duration") but does NOT contain the actual VALUE needed to proceed, your NEXT action MUST be ask_user with an EMPTY options array asking for the specific value (e.g. "What duration?"). Do NOT repeat the previous choice question. Do NOT guess values.`,
      });
      logger.info(`[cli.agent] resume context (legacy single-pair) detected for ${agentId} — pre-seeded loopHistory with prior ask_user + user answer`, { agentId });
    } else if (_multiResumeMatch) {
      const _qaBlock = _multiResumeMatch[1];
      const _pairRegex = /\d+\.\s*Q:\s*"(.+?)"\s*→\s*A:\s*"(.+?)"/g;
      let _pair;
      let _pairIdx = 1;
      while ((_pair = _pairRegex.exec(_qaBlock)) !== null) {
        const _q = _pair[1];
        const _a = _pair[2];
        loopHistory.push({
          turn: _pairIdx,
          action: 'ask_user',
          question: _q,
          observation: `User answered: "${_a}". Continue from this point — do NOT repeat previous diagnostic attempts. If the user's answer indicates a DIRECTION (e.g. "duration" / "Specify duration") but does NOT contain the actual VALUE needed to proceed, your NEXT action MUST be ask_user with an EMPTY options array asking for the specific value (e.g. "What duration?"). Do NOT repeat the previous choice question. Do NOT guess values.`,
        });
        _pairIdx++;
      }
      logger.info(`[cli.agent] resume context (multi-pair) detected for ${agentId} — pre-seeded loopHistory with ${_pairIdx - 1} prior ask_user + user answer pair(s)`, { agentId });
    }

    // Load per-agent learned rules (saved by past ask_user save_rule events).
    // Falls back to [] silently if user-memory service is unavailable.
    const skillDb = require('../skill-helpers/skill-db.cjs');
    const learnedRules = await skillDb.getContextRules('cli_agent:' + agentId).catch(() => []);
    if (learnedRules.length > 0) {
      logger.info(`[cli.agent] loaded ${learnedRules.length} learned rule(s) for ${agentId}`, { agentId });
    }

    // Resolve authenticated user identity for this agent's service.
    // Injected into the system prompt so the LLM uses the correct owner/account.
    const _serviceKey = (agent.service || agentId.replace(/\.agent$/i, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const _userContext = {};
    if (IDENTITY_COMMANDS[_serviceKey]) {
      try {
        const _idCmd = IDENTITY_COMMANDS[_serviceKey];
        const _idR = await spawnCapture(currentBinPath, _idCmd.argv, { timeoutMs: 5000 });
        if (_idR.ok) {
          const _user = _idCmd.extract(_idR.stdout);
          if (_user) {
            _userContext[_serviceKey] = _user;
            logger.info(`[cli.agent] agentic run: resolved ${_serviceKey} identity → "${_user}"`, { agentId });
          }
        }
      } catch (_idErr) {
        logger.debug(`[cli.agent] agentic run: identity resolution failed for ${_serviceKey}: ${_idErr.message}`);
      }
    }

    // Use effectiveTask (with pre_step token injections) as the loop task.
    // Strip any [Resume context: ...] suffix — it's already pre-seeded into loopHistory
    // as a synthetic turn above, so including it in the task string would be redundant.
    const loopTask = effectiveTask.replace(/\s*\[Resume context:[\s\S]*?\]\s*$/, '').trim();

    let _authAttempted = false; // prevents infinite auto-auth retry within the agentic loop

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // ── Real-time turn progress → Electron overlay server ──────────────────
      // POST turn info to the overlay /agent-turn endpoint so the UI can show
      // "Turn N/M" in the heartbeat label before the full response arrives.
      if (_progressCallbackUrl) {
        const _turnPayload = JSON.stringify({ type: 'agent:turn_live', agentId, turn, maxTurns: MAX_TURNS, stepIndex: _stepIndex ?? 0, currentAction: null });
        const http = require('http');
        const _req = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_turnPayload) }, timeout: 2000 });
        _req.on('error', () => {}); // fire-and-forget
        _req.write(_turnPayload);
        _req.end();
      }

      const turnSys  = buildTurnSystemPrompt(agent.descriptor, learnedRules, _userContext);
      const turnUser = buildTurnPrompt(loopTask, loopHistory);
      logger.info(`[cli.agent] loop turn=${turn} syschars=${turnSys.length} userchars=${turnUser.length}`, { agentId, task: loopTask });

      const llmRaw = await callLLM(turnSys, turnUser, { temperature: 0.1, maxTokens: 400 });

      logger.info(`[cli.agent] loop turn=${turn} llmRaw=${llmRaw === null ? 'NULL' : `"${(llmRaw || '').slice(0, 300)}"`}`, { agentId });

      let action = null;
      if (llmRaw) {
        try {
          // Greedy match — finds outermost { ... } even with nested braces
          const m = llmRaw.match(/\{[\s\S]*\}/);
          if (m) action = JSON.parse(m[0]);
        } catch (parseErr) {
          logger.warn(`[cli.agent] loop turn=${turn} JSON parse failed: ${parseErr.message} — attempting sanitize`, { agentId });
          // ── Fallback: sanitize common LLM JSON errors and retry ──────────
          try {
            const m = llmRaw.match(/\{[\s\S]*\}/);
            if (m) {
              const sanitized = m[0]
                .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')   // strip control chars
                .replace(/\\'/g, "'")                              // \' → '
                .replace(/\n/g, '\\n')                             // unescaped newlines
                .replace(/\r/g, '\\r')                             // unescaped CRs
                .replace(/\t/g, '\\t')                             // unescaped tabs
                .replace(/,\s*([\]}])/g, '$1');                    // trailing commas
              action = JSON.parse(sanitized);
              logger.info(`[cli.agent] loop turn=${turn} JSON sanitize recovered action=${action?.action}`, { agentId });
            }
          } catch (_sanitizeErr) {
            // ── Last resort: regex-extract action + question for ask_user ──
            const actionMatch = llmRaw.match(/"action"\s*:\s*"([^"]+)"/);
            const questionMatch = llmRaw.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (actionMatch) {
              action = { action: actionMatch[1] };
              if (questionMatch) action.question = questionMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n');
              logger.info(`[cli.agent] loop turn=${turn} regex fallback recovered action=${action.action}`, { agentId });
            } else {
              logger.warn(`[cli.agent] loop turn=${turn} all parse fallbacks failed`, { agentId });
            }
          }
        }
      }

      if (!action || !action.action) {
        logger.warn(`[cli.agent] loop turn=${turn} parse_error — no valid action in LLM output`, { agentId });
        loopHistory.push({ turn, action: 'parse_error', observation: `LLM output: ${(llmRaw || 'NULL').slice(0, 200)}` });
        continue;
      }

      logger.info(`[cli.agent] loop turn=${turn} action=${action.action}`, { agentId, task });

      // Fire a second turn_live update now that we know the actual action type.
      // The first one (top of loop) fires before LLM responds — this one fires after parse.
      // Also carry the optional thinking field so the UI can show it live.
      if (_progressCallbackUrl) {
        const _actionPayload = JSON.stringify({ type: 'agent:turn_live', agentId, turn, maxTurns: MAX_TURNS, stepIndex: _stepIndex ?? 0, currentAction: action.action, thinking: action.thinking || null });
        const http = require('http');
        const _req2 = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_actionPayload) }, timeout: 2000 });
        _req2.on('error', () => {});
        _req2.write(_actionPayload);
        _req2.end();
      }

      if (action.action === 'done') {
        transcript.push({ turn, action, outcome: { ok: true, result: action.summary || '' }, thoughts: action.thinking || null });
        return { ok: true, agentId, task, stdout: action.summary || '', agentTurns: turn, transcript };
      }

      if (action.action === 'ask_user') {
        // Persist any discovered command-mapping rule so future runs skip the discovery turns.
        // Saved regardless of user's Yes/No — the CLI docs truth is independent of the user's choice.
        if (action.save_rule && typeof action.save_rule === 'string' && action.save_rule.trim()) {
          skillDb.setContextRule('cli_agent:' + agentId, action.save_rule.trim(), 'cli_agent').catch(() => {});
          logger.info(`[cli.agent] saved learned rule for ${agentId}: "${action.save_rule.slice(0, 120)}"`, { agentId });
        }

        // ── Auto-auth intercept: if this ask_user is about authentication, attempt silent login ──
        const _questionLower = (action.question || '').toLowerCase();
        const _isAuthQuestion = /\b(auth|login|sign[\s-]?in|not logged|unauthorized|unauthenticated|credentials|token expired|permission denied|403|401)\b/i.test(_questionLower);
        if (_isAuthQuestion && currentBinPath && !_authAttempted) {
          _authAttempted = true; // prevent infinite retry
          logger.info(`[cli.agent] ask_user appears auth-related for ${agentId} — attempting auto-auth`, { agentId });
          try {
            const _authArgv = await discoverAuthLoginCmd(currentBinPath, cliTool || agentId);
            if (_authArgv) {
              // Emit task:auth_required so UI shows the overlay
              if (_progressCallbackUrl) {
                try {
                  const http = require('http');
                  const _svcDisplay = (agent?.service || cliTool || agentId).replace(/_/g, ' ');
                  const _payload = JSON.stringify({
                    type: 'task:auth_required',
                    agentId,
                    serviceDisplay: _svcDisplay,
                    loginUrl: '',
                    sessionId: null,
                    stepIndex: _stepIndex ?? 0,
                    message: `Signing in to ${_svcDisplay}… A browser window may open for authorization.`,
                  });
                  const _req = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_payload) }, timeout: 3000 });
                  _req.on('error', () => {});
                  _req.write(_payload);
                  _req.end();
                } catch (_) {}
              }

              // Run the auth command (may open a browser for OAuth)
              logger.info(`[cli.agent] running auto-auth: ${currentBinPath} ${_authArgv.join(' ')}`, { agentId });
              const _authResult = await spawnCapture(currentBinPath, _authArgv, { timeoutMs: 180000 });
              logger.info(`[cli.agent] auto-auth result: exitCode=${_authResult.exitCode}`, { agentId });

              // Emit task:auth_resolved
              if (_progressCallbackUrl) {
                try {
                  const http = require('http');
                  const _resolvedPayload = JSON.stringify({ type: 'task:auth_resolved', agentId, stepIndex: _stepIndex ?? 0 });
                  const _resolvedReq = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_resolvedPayload) }, timeout: 3000 });
                  _resolvedReq.on('error', () => {});
                  _resolvedReq.write(_resolvedPayload);
                  _resolvedReq.end();
                } catch (_) {}
              }

              if (_authResult.exitCode === 0) {
                // Auth succeeded — retry the loop instead of surfacing ask_user
                logger.info(`[cli.agent] auto-auth succeeded for ${agentId} — retrying task`, { agentId });
                loopHistory.push({ turn, action: 'auto_auth', observation: `Auto-login succeeded. Retrying original task.` });
                continue; // back to top of agentic loop
              }
            }
          } catch (_authErr) {
            logger.warn(`[cli.agent] auto-auth failed for ${agentId}: ${_authErr.message}`, { agentId });
          }
        }

        // ── Duplicate question guard ─────────────────────────────────────────────
        // If the LLM emits an ask_user with the same question text as one already
        // in loopHistory (from resume context pre-seeding), don't surface it again.
        // Instead, push a corrective observation and continue the loop so the LLM
        // gets another chance to ask for the specific value. On the third repeat,
        // force a free-text prompt so the user can type the value directly.
        const _questionText = action.question || '';
        const _normalizeQ = (s) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        const _priorQuestions = loopHistory
          .filter(h => h.action === 'ask_user' && h.question)
          .map(h => _normalizeQ(h.question));
        const _normalizedNew = _normalizeQ(_questionText);
        const _dupCount = _priorQuestions.filter(q => q === _normalizedNew).length;

        if (_dupCount > 0 && _dupCount < 2) {
          // First duplicate: push corrective observation and continue loop
          logger.warn(`[cli.agent] duplicate ask_user detected (turn ${turn}) for ${agentId} — pushing corrective observation`, { agentId });
          loopHistory.push({
            turn,
            action: 'ask_user',
            question: _questionText,
            observation: `You already asked this exact question and the user already answered it. Do NOT repeat it. Based on the user's previous answer, if a VALUE is still needed (e.g. duration, end time, date), emit ask_user with an EMPTY options array and a question asking specifically for that value. If enough information has been collected, proceed with run_cmd or done instead.`,
          });
          continue;
        } else if (_dupCount >= 2) {
          // Repeated duplicate after correction: force free-text prompt
          logger.warn(`[cli.agent] duplicate ask_user persisted after correction (turn ${turn}) for ${agentId} — forcing free-text prompt`, { agentId });
          return {
            ok: false,
            agentId,
            task,
            askUser: true,
            question: `Could you provide the specific value needed to proceed?`,
            options: [],
            agentTurns: turn,
            transcript,
            savedRule: (action.save_rule || '').trim() || null,
            freeText: true,
          };
        }

        // ── Credential-aware ask_user enhancement ────────────────────────────────
        // Detect missing credential questions and provide actionable options
        const _credentialKeywords = /\b(client_id|client_secret|api_key|token|credential|password|secret|auth)\b/i;
        const _isCredentialQuestion = _credentialKeywords.test(_questionText);
        
        let _enhancedOptions = action.options || [];
        let _actionMeta = {};
        
        if (_isCredentialQuestion && _enhancedOptions.length === 0) {
          // Extract credential type from question
          const _credMatch = _questionText.match(/\b(client_id|client_secret|api_key|token|credential|password|secret)\b/i);
          const _credType = _credMatch ? _credMatch[1].toLowerCase() : 'credential';
          const _serviceName = agent.service || agentId.replace(/\.agent$/i, '');
          
          _enhancedOptions = [
            { 
              label: `Yes, I have ${_credType} — Open ${agentId} settings`, 
              value: 'have_credentials',
              action: 'open_agent_settings',
              agentId 
            },
            { 
              label: `No, help me create ${_credType}`, 
              value: 'need_help',
              action: 'web_search',
              query: `${_serviceName} ${_credType} setup create get how to`
            }
          ];
          
          _actionMeta = { 
            isCredentialRequest: true, 
            credentialType: _credType,
            service: _serviceName 
          };
        }

        // Do NOT push to transcript — ask_user is a terminal escalation, not an executed step.
        // Showing it as a turn bubble would duplicate the question text that the UI card already displays.
        return { 
          ok: false, 
          agentId, 
          task, 
          askUser: true, 
          question: _questionText, 
          options: _enhancedOptions, 
          agentTurns: turn, 
          transcript, 
          savedRule: (action.save_rule || '').trim() || null,
          ..._actionMeta
        };
      }

      let observation = '';

      if (action.action === 'run_cmd') {
        // Detect long-running gcloud commands and extend the timeout accordingly.
        // `gcloud services enable` can take 60-180s for API activation.
        const _argv = action.argv || [];
        const _isGcloudServicesEnable = (
          agentId.toLowerCase().includes('gcloud') &&
          _argv[0] === 'services' && _argv[1] === 'enable'
        );
        const _stepTimeoutMs = _isGcloudServicesEnable ? 180000 : (timeoutMs || 30000);
        const cmdResult = await spawnCapture(currentBinPath, _argv, { cwd, env, timeoutMs: _stepTimeoutMs });
        logger.info(`[cli.agent] loop turn=${turn} run_cmd exitCode=${cmdResult.exitCode} stdout="${cmdResult.stdout.slice(0, 200)}" stderr="${(cmdResult.stderr || '').slice(0, 200)}"`, { agentId });
        // Idempotent success: treat "already done" CLi responses as success (e.g. gh repo star on already-starred repo exits 1)
        const alreadyDone = /already starred|already watching|already following|nothing to (do|change)|up.to.date|no changes/i.test(
          cmdResult.stdout + ' ' + (cmdResult.stderr || '')
        );
        if (alreadyDone) {
          // Idempotent: "already starred/following" etc — task definitively complete, exit immediately.
          transcript.push({ turn, action, outcome: { ok: true, result: cmdResult.stdout.slice(0, 300) }, thoughts: action.thinking || null });
          return {
            ok: true, agentId, task,
            inferredArgv: action.argv, stdout: cmdResult.stdout,
            stderr: cmdResult.stderr, exitCode: cmdResult.exitCode, agentTurns: turn, transcript,
          };
        }
        if (cmdResult.exitCode === -1) {
          // Timeout — process was killed. Explicitly label so the LLM does NOT call done.
          observation = `exitCode=-1 (TIMED OUT — command was killed before completing; it did NOT succeed). Do NOT call done. Use a faster alternative — e.g. for fetching a single GitHub file prefer "gh api /repos/{owner}/{repo}/readme" over "gh repo clone".`;
        } else if (cmdResult.exitCode === 0) {
          // Command succeeded — feed stdout back so the LLM can evaluate: call "done" if the
          // task is fully complete, or continue (e.g. decode base64, save to file, follow a URL)
          // if the output needs further processing. Do NOT auto-exit here.
          transcript.push({ turn, action, outcome: { ok: true, result: cmdResult.stdout.slice(0, 300) }, thoughts: action.thinking || null });
          observation = `exitCode=0 stdout="${cmdResult.stdout.slice(0, 800)}"`;
          loopHistory.push({ turn, ...action, observation: observation.slice(0, OBSERVATION_CHARS) });
          continue; // transcript already pushed above; skip bottom push
        } else {
          // Non-zero, non-timeout failure — auto-inject deep subcommand help on "unknown command".
          // Build the help path by walking the argv, stripping trailing --flags and positional args (paths/URLs),
          // so we fetch the most specific help available rather than just argv[0].
          // Examples:
          //   ["compose", "up", "--no-deps"]               → fetch ["compose", "up", "--help"]
          //   ["api", "--method", "PUT", "/user/starred"]  → fetch ["api", "--help"]
          //   ["repo", "star", "owner/repo"]               → fetch ["repo", "star", "--help"]
          const syntaxFailure = /unknown command|usage:|unrecognized|invalid (?:choice|option)|unexpected argument|missing required/i.test(cmdResult.stderr || '');
          if (syntaxFailure) {
            const argv = action.argv || [];
            const unknownCommand = /unknown command/i.test(cmdResult.stderr || '');
            const subcmdPath = (unknownCommand ? argv.slice(0, 3) : argv.slice(0, 1))
              .filter(a => !a.startsWith('-') && !/[/\\]/.test(a) && !/^[A-Z_]+=/.test(a));
            if (subcmdPath.length > 0) {
              const helpLabel = subcmdPath.join(' ');
              const helpR = await spawnCapture(currentBinPath, [...subcmdPath, '--help'], { timeoutMs: 4000 });
              const helpText = (helpR.stdout || helpR.stderr || '').slice(0, RUN_HELP_CHARS);
              observation = `exitCode=${cmdResult.exitCode} stderr="${summarizeStderr(cmdResult.stderr, 400)}"\n[authoritative help for "${helpLabel}" — use only this syntax on the next command]:\n${helpText}`;
            } else {
              observation = `exitCode=${cmdResult.exitCode} stdout="${cmdResult.stdout.slice(0, 300)}" stderr="${summarizeStderr(cmdResult.stderr, 400)}"`;
            }
          } else {
            // Extract WARNING: lines and surface them as top-priority actionable hints.
            // Any CLI WARNING: that says "add --flag" or "use --option" is a self-healing signal.
            const _warningLines = (cmdResult.stderr || '')
              .split('\n')
              .filter(l => /^\s*WARNING:/i.test(l) && l.trim().length > 10)
              .map(l => l.trim())
              .join('\n');
            if (_warningLines) {
              observation = `exitCode=${cmdResult.exitCode}\n[ACTIONABLE WARNINGS — act on these]:\n${_warningLines.slice(0, 400)}\nstdout="${cmdResult.stdout.slice(0, 150)}"`;
            } else {
              observation = `exitCode=${cmdResult.exitCode} stdout="${cmdResult.stdout.slice(0, 300)}" stderr="${summarizeStderr(cmdResult.stderr, 200)}"`;
            }
          }
          // ── Loop guard ────────────────────────────────────────────────────
          // Detect exact-argv repeat failures and excessive total failures so
          // the LLM changes approach or asks the user instead of burning turns.
          totalFailedRunCmds++;
          const _argvSig = JSON.stringify(action.argv || []);
          const _sigFails = (failedArgvSigs.get(_argvSig) || 0) + 1;
          failedArgvSigs.set(_argvSig, _sigFails);
          // Prepend (not append) so guards survive the OBSERVATION_CHARS head-truncation.
          if (totalFailedRunCmds >= 6) {
            observation = `[LOOP GUARD] ${totalFailedRunCmds} commands have failed in this session. STOP guessing. Your next action MUST be ask_user — summarize the last error and ask the user how to proceed.\n${observation}`;
          } else if (_sigFails >= 2) {
            observation = `[LOOP GUARD] You have run this EXACT command ${_sigFails} times and it failed the same way each time. Do NOT run it again. Fix the specific flag/value named in the error below, or call ask_user to ask the user for guidance.\n${observation}`;
          }
        }

      } else if (action.action === 'run_help') {
        const helpR = await spawnCapture(currentBinPath, [...(action.subcmd || []), '--help'], { timeoutMs: 8000 });
        const _rawHelp = helpR.stdout || helpR.stderr || '';
        // When subcmd is [] (full --help), the raw output can be 60KB+ with relevant flags
        // buried deep (e.g. yt-dlp subtitle flags at char ~28000). Instead of returning
        // the useless head, extract task-relevant keywords and return targeted lines.
        if ((action.subcmd || []).length === 0 && _rawHelp.length > RUN_HELP_CHARS) {
          // Build keyword set from the current task string
          const _taskWords = loopTask.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3);
          const _MEDIA_KEYWORDS = ['sub', 'caption', 'transcript', 'srt', 'vtt', 'write', 'audio', 'extract', 'format', 'playlist', 'chapter', 'thumb', 'metadata', 'embed'];
          const _keywords = [...new Set([..._taskWords, ..._MEDIA_KEYWORDS])].filter(k => k.length > 2);
          const _helpLines = _rawHelp.split('\n');
          const _CONTEXT = 2; // lines of context around each match
          const _matchedIdx = new Set();
          _helpLines.forEach((line, i) => {
            const _lc = line.toLowerCase();
            if (_keywords.some(kw => _lc.includes(kw))) {
              for (let c = Math.max(0, i - _CONTEXT); c <= Math.min(_helpLines.length - 1, i + _CONTEXT); c++) {
                _matchedIdx.add(c);
              }
            }
          });
          if (_matchedIdx.size > 0) {
            const _filtered = [..._matchedIdx].sort((a, b) => a - b).map(i => _helpLines[i]).join('\n');
            observation = `[keyword-filtered help — ${_matchedIdx.size} relevant lines]:\n${_filtered}`.slice(0, RUN_HELP_CHARS);
            logger.info(`[cli.agent] loop turn=${turn} run_help: keyword-filtered ${_matchedIdx.size}/${_helpLines.length} lines`, { agentId });
          } else {
            observation = _rawHelp.slice(0, RUN_HELP_CHARS);
          }
        } else {
          observation = _rawHelp.slice(0, RUN_HELP_CHARS);
        }

      } else if (action.action === 'run_update') {
        if (!loopMeta) loopMeta = await lookupServiceAsync(cliTool);
        const updateR = await agentRunUpdate(cliTool, loopMeta);
        if (updateR.ok) {
          const newBin = await whichCli(cliTool);
          if (newBin) currentBinPath = newBin;
          // Auto-retry the last failed run_cmd with the fresh binary — saves a full LLM turn.
          // Without this, the LLM wastes turn 4 on run_help instead of retrying the command.
          const lastCmd = [...loopHistory].reverse().find(h => h.action === 'run_cmd');
          if (lastCmd?.argv) {
            logger.info(`[cli.agent] loop turn=${turn} run_update ok — auto-retrying: ${JSON.stringify(lastCmd.argv)}`, { agentId });
            const retryR = await spawnCapture(currentBinPath, lastCmd.argv, { cwd, env, timeoutMs: timeoutMs || 30000 });
            logger.info(`[cli.agent] loop turn=${turn} auto-retry exitCode=${retryR.exitCode} stdout="${retryR.stdout.slice(0, 200)}" stderr="${(retryR.stderr || '').slice(0, 200)}"`, { agentId });
            const alreadyDone = /already starred|already watching|already following|nothing to (do|change)|up.to.date|no changes/i.test(
              retryR.stdout + ' ' + (retryR.stderr || '')
            );
            if (alreadyDone) {
              transcript.push({ turn, action, outcome: { ok: true, result: retryR.stdout.slice(0, 300) }, thoughts: action.thinking || null });
              return { ok: true, agentId, task, inferredArgv: lastCmd.argv, stdout: retryR.stdout, stderr: retryR.stderr, exitCode: retryR.exitCode, agentTurns: turn, transcript };
            }
            if (retryR.exitCode === -1) {
              observation = `run_update ok; retry exitCode=-1 (TIMED OUT — command was killed before completing). Do NOT call done. Try a faster alternative approach.`;
            } else if (retryR.exitCode === 0) {
              transcript.push({ turn, action, outcome: { ok: true, result: retryR.stdout.slice(0, 300) }, thoughts: action.thinking || null });
              observation = `run_update ok; retry exitCode=0 stdout="${retryR.stdout.slice(0, 800)}"`;
              loopHistory.push({ turn, ...action, observation: observation.slice(0, OBSERVATION_CHARS) });
              continue;
            }
            observation = `run_update ok; retry exitCode=${retryR.exitCode} stderr="${(retryR.stderr || '').slice(0, 300)}"`;
          } else {
            observation = `run_update succeeded: ${(updateR.stdout || '').slice(0, OBSERVATION_CHARS)}`;
          }
        } else {
          observation = `run_update failed: ${(updateR.error || updateR.stdout || '').slice(0, OBSERVATION_CHARS)}`;
        }

      } else if (action.action === 'web_search') {
        const snippets = await agentWebSearch(action.query || '');
        observation = snippets.slice(0, OBSERVATION_CHARS);

      } else if (action.action === 'web_fetch') {
        const page = await agentWebFetch(action.url || '');
        observation = page.slice(0, 2000);

      } else if (action.action === 'run_shell') {
        // Shell composition action — runs a script via bash/node/python3 so the LLM can pipe,
        // grep, head, and combine stdout+stderr. Use for probing ONLY, not primary task execution.
        const _script = (action.script || '').trim();
        if (!_script) {
          observation = 'run_shell: script is required';
        } else {
          try {
            const { shellRun } = require('./shell.run.cjs');
            // Derive interpreter set from shell.run's ALLOWED_COMMANDS — stays in sync automatically
            const _interp = _SHELL_INTERPRETERS.has(action.interpreter) ? action.interpreter : 'bash';
            // node uses -e (eval), shell interpreters use -c (command)
            const _interpFlag = _interp === 'node' ? '-e' : '-c';
            const _shellR = await shellRun({ cmd: _interp, argv: [_interpFlag, _script], timeoutMs: 15000 });
            const _combined = [_shellR.stdout || '', _shellR.stderr || ''].filter(Boolean).join('\n').trim();
            // When probe returns the same short error as the original failure (< 60 chars),
            // the LLM has no new information. Enrich with a diagnostic hint so it knows
            // the input type may be wrong (not just dead) and suggests ytsearch3: recovery.
            if (_shellR.exitCode !== 0 && _combined.length < 60) {
              observation = `exitCode=${_shellR.exitCode} probe_output="${_combined}" — probe returned same error as original command; the input URL/file may be the wrong type entirely (not just unavailable). NEXT STEP (MANDATORY): run_shell: yt-dlp --flat-playlist --get-url --js-runtimes node --remote-components ejs:github 'ytsearch3:<video title and creator>' 2>&1 | head -5`;
            } else {
              observation = (_combined || `exitCode=${_shellR.exitCode}`).slice(0, RUN_HELP_CHARS);
            }
            logger.info(`[cli.agent] loop turn=${turn} run_shell interp=${_interp} exitCode=${_shellR.exitCode} chars=${_combined.length}`, { agentId });
          } catch (_shellErr) {
            observation = `run_shell error: ${_shellErr.message}`;
          }
        }

      } else {
        observation = `unknown action: ${action.action}`;
      }

      loopHistory.push({ turn, ...action, observation: observation.slice(0, OBSERVATION_CHARS) });
      transcript.push({ turn, action, observation: observation.slice(0, 300), outcome: { ok: false, error: observation.slice(0, 300) }, thoughts: action.thinking || null });
    }

    return {
      ok: false, agentId, task,
      error: `Agentic loop reached MAX_TURNS (${MAX_TURNS}) without completing`,
      agentTurns: MAX_TURNS, transcript,
    };
  }

  // ── Raw path: cli + argv (backward compat) ──
  if (!cli) return { ok: false, error: 'cli or agentId is required' };

  const binPath = await whichCli(cli);
  if (!binPath) return { ok: false, error: `CLI not found: ${cli}. Use action:install first.` };

  const result = await spawnCapture(binPath, argv, {
    cwd, env, timeoutMs: timeoutMs || 30000, stdin,
  });

  logger.info('[cli.agent] run', { cli, argv, exitCode: result.exitCode });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    executionTime: result.executionTime,
    error: result.error,
  };
}


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// discoverAuthLoginCmd — dynamically discovers the auth login command for a CLI.
// Probes `<cli> auth login --help`, then `<cli> login --help`, then `<cli> auth --help`
// to find the correct authentication subcommand. Also detects --web/--browser flags
// for non-interactive OAuth. Returns argv array or null if not discoverable.
// Caches results in-memory so subsequent calls for the same CLI skip probe overhead.
// ---------------------------------------------------------------------------
const _authLoginCmdCache = new Map(); // cliName → argv[] | null

async function discoverAuthLoginCmd(binPath, cliName) {
  // Check in-memory cache first
  if (_authLoginCmdCache.has(cliName)) {
    return _authLoginCmdCache.get(cliName);
  }
  // Probe 1: <cli> auth login --help
  const r1 = await spawnCapture(binPath, ['auth', 'login', '--help'], { timeoutMs: 5000 });
  const r1out = (r1.stdout || '') + (r1.stderr || '');
  if (r1.exitCode === 0 && /usage|login|authenticate/i.test(r1out)) {
    const argv = ['auth', 'login'];
    if (/--web\b/.test(r1out)) argv.push('--web');
    else if (/--browser\b/.test(r1out)) argv.push('--browser');
    logger.info(`[cli.agent] discoverAuthLoginCmd: ${cliName} → [${argv.join(' ')}]`);
    _authLoginCmdCache.set(cliName, argv);
    return argv;
  }

  // Probe 2: <cli> login --help
  const r2 = await spawnCapture(binPath, ['login', '--help'], { timeoutMs: 5000 });
  const r2out = (r2.stdout || '') + (r2.stderr || '');
  if (r2.exitCode === 0 && /usage|login|authenticate/i.test(r2out)) {
    const argv = ['login'];
    if (/--web\b/.test(r2out)) argv.push('--web');
    else if (/--browser\b/.test(r2out)) argv.push('--browser');
    logger.info(`[cli.agent] discoverAuthLoginCmd: ${cliName} → [${argv.join(' ')}]`);
    _authLoginCmdCache.set(cliName, argv);
    return argv;
  }

  // Probe 3: <cli> auth --help — look for a login/signin subcommand
  const r3 = await spawnCapture(binPath, ['auth', '--help'], { timeoutMs: 5000 });
  const r3out = (r3.stdout || '') + (r3.stderr || '');
  if (r3.exitCode === 0) {
    const subMatch = r3out.match(/\b(login|signin|sign-in|authenticate)\b/i);
    if (subMatch) {
      const subcmd = subMatch[1].toLowerCase();
      const argv = ['auth', subcmd];
      // Check if this subcmd supports --web
      const r3b = await spawnCapture(binPath, ['auth', subcmd, '--help'], { timeoutMs: 5000 });
      const r3bout = (r3b.stdout || '') + (r3b.stderr || '');
      if (/--web\b/.test(r3bout)) argv.push('--web');
      else if (/--browser\b/.test(r3bout)) argv.push('--browser');
      logger.info(`[cli.agent] discoverAuthLoginCmd: ${cliName} → [${argv.join(' ')}]`);
      _authLoginCmdCache.set(cliName, argv);
      return argv;
    }
  }

  logger.info(`[cli.agent] discoverAuthLoginCmd: ${cliName} → not discoverable`);
  _authLoginCmdCache.set(cliName, null);
  return null;
}

// ---------------------------------------------------------------------------
// _discoverVerifyCmd — scans --help output for a read-only subcommand that
// makes an API call requiring valid auth. Uses heuristic pre-filter + LLM
// classification (via skill-llm.cjs) to pick the best "verify auth" command.
// Returns argv array (e.g. ['list']) or null if none found.
// ---------------------------------------------------------------------------

// Subcommand names that are likely read-only and API-backed, in priority order
const VERIFY_CANDIDATES = ['list', 'status', 'whoami', 'info', 'show', 'agenda'];

// Description keywords indicating the subcommand makes a remote API call
const API_BACKED_KEYWORDS = /\bavailable\b|\byour\b|\bagenda\b|\bevents?\b|\brepos?\b|\bcalendars?\b|\baccount\b|\bremote\b|\bprojects?\b|\bdatabases?\b|\bclusters?\b|\bspaces?\b|\bteams?\b/i;

// Description keywords indicating the subcommand is local-only (no auth needed)
const LOCAL_ONLY_KEYWORDS = /\bconfig\b|\bprofile\b|\bversion\b|\bsettings?\b|\bbuild\b|\blocal\b|\bprint\b|\bhelp\b|\binit\b|\bsetup\b|\binstall\b/i;

async function _discoverVerifyCmd(binPath, cliName, mainHelp, helpParts) {
  // Parse positional arguments line: {init,list,search,edit,...}
  // Some CLIs (e.g. gcalcli) also have option enums like --lineart {fancy,unicode,ascii},
  // so we collect ALL {a,b,c} blocks and pick the one with the most items that contains
  // at least one known verify candidate — that is the positional/subcommand list.
  const allMatches = [];
  const posRe = /\{([a-z][a-z0-9_,\s-]*(?:,\s*[a-z][a-z0-9_-]*)+)\}/gi;
  let m;
  while ((m = posRe.exec(mainHelp)) !== null) {
    const items = m[1].split(/,\s*/).map(s => s.trim().toLowerCase()).filter(Boolean);
    if (items.length > 0) allMatches.push({ raw: m[1], items });
  }
  if (allMatches.length === 0) {
    logger.debug(`[cli.agent] _discoverVerifyCmd: ${cliName} — no {a,b,c} blocks found in --help`);
    return null;
  }

  // Prefer blocks that contain at least one verify candidate; among those, pick the longest.
  // If no block contains a verify candidate, pick the longest block overall.
  const candidateMatches = allMatches.filter(match => VERIFY_CANDIDATES.some(v => match.items.includes(v)));
  const bestMatch = (candidateMatches.length > 0 ? candidateMatches : allMatches)
    .sort((a, b) => b.items.length - a.items.length)[0];

  const allSubcmds = bestMatch.items;
  logger.debug(`[cli.agent] _discoverVerifyCmd: ${cliName} — selected ${allSubcmds.length}-item block from ${allMatches.length} total {a,b,c} blocks`);

  // Build subcommand → description map from aligned help text
  const subcmdDescs = {};
  for (const sub of allSubcmds) {
    // Match lines like "    list                list available calendars"
    const descMatch = mainHelp.match(new RegExp(`^\\s{2,8}${sub}\\s{2,}(.+)$`, 'im'));
    if (descMatch) {
      subcmdDescs[sub] = descMatch[1].trim();
    } else {
      subcmdDescs[sub] = '';
    }
  }

  // Phase 1: Heuristic pre-filter
  const heuristicCandidates = [];
  for (const candidate of VERIFY_CANDIDATES) {
    const sub = allSubcmds.find(s => s === candidate || s.startsWith(candidate));
    if (!sub) continue;
    const desc = subcmdDescs[sub] || '';
    // Skip local-only subcommands
    if (LOCAL_ONLY_KEYWORDS.test(desc) && !API_BACKED_KEYWORDS.test(desc)) {
      logger.debug(`[cli.agent] _discoverVerifyCmd: skipping '${sub}' (local-only: "${desc}")`);
      continue;
    }
    heuristicCandidates.push({ sub, desc, score: API_BACKED_KEYWORDS.test(desc) ? 2 : 1 });
  }

  // Also check subcommands not in VERIFY_CANDIDATES but with API-backed descriptions
  for (const sub of allSubcmds) {
    if (heuristicCandidates.some(c => c.sub === sub)) continue;
    const desc = subcmdDescs[sub] || '';
    if (API_BACKED_KEYWORDS.test(desc) && !LOCAL_ONLY_KEYWORDS.test(desc)) {
      // Skip destructive subcommands
      if (/\bdelete\b|\bremove\b|\bcreate\b|\badd\b|\bedit\b|\bupdate\b|\bimport\b|\bremind\b/i.test(sub)) continue;
      heuristicCandidates.push({ sub, desc, score: 1 });
    }
  }

  if (heuristicCandidates.length === 0) {
    logger.debug(`[cli.agent] _discoverVerifyCmd: ${cliName} — no verify candidates found`);
    return null;
  }

  // Sort by score (API-backed first) then by VERIFY_CANDIDATES priority
  heuristicCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aIdx = VERIFY_CANDIDATES.indexOf(a.sub) === -1 ? 99 : VERIFY_CANDIDATES.indexOf(a.sub);
    const bIdx = VERIFY_CANDIDATES.indexOf(b.sub) === -1 ? 99 : VERIFY_CANDIDATES.indexOf(b.sub);
    return aIdx - bIdx;
  });

  // If the top candidate has score 2 (clearly API-backed), use it directly
  if (heuristicCandidates[0].score >= 2) {
    const pick = heuristicCandidates[0];
    logger.info(`[cli.agent] _discoverVerifyCmd: ${cliName} → ['${pick.sub}'] (heuristic: "${pick.desc}")`);
    return [pick.sub];
  }

  // Phase 2: LLM classification when heuristics are ambiguous
  try {
    let llmModule = null;
    try { llmModule = require('../skill-helpers/skill-llm.cjs'); } catch (_) {}

    if (llmModule?.ask) {
      const candidateList = heuristicCandidates.slice(0, 6).map(c => `- ${c.sub}: "${c.desc}"`).join('\n');
      const prompt = `Given these CLI subcommands and their --help descriptions, which ONE subcommand makes a network/API call that requires valid authentication to succeed? Pick the best "verify auth" command. Return ONLY the subcommand name, nothing else.

Subcommands:
${candidateList}`;

      const llmAnswer = await llmModule.ask(prompt, { timeoutMs: 10000 });
      if (llmAnswer) {
        const cleaned = llmAnswer.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        // Verify the LLM pick exists in our candidates
        const match = heuristicCandidates.find(c => c.sub === cleaned);
        if (match) {
          logger.info(`[cli.agent] _discoverVerifyCmd: ${cliName} → ['${cleaned}'] (LLM classified: "${match.desc}")`);
          return [cleaned];
        }
      }
    }
  } catch (_) {}

  // Fallback: use top heuristic candidate
  const pick = heuristicCandidates[0];
  logger.info(`[cli.agent] _discoverVerifyCmd: ${cliName} → ['${pick.sub}'] (fallback heuristic: "${pick.desc}")`);
  return [pick.sub];
}

// ---------------------------------------------------------------------------
// discoverSetupFromHelp — parses <cli> --help (and subcommand --help) to extract
// structured setupInfo: authCmd, initCmd, credentials, instructions.
// This is the primary setup discovery method when the CLI is installed.
// Returns setupInfo object or null if --help doesn't contain setup-relevant info.
// Caches results in-memory.
// ---------------------------------------------------------------------------
const _setupHelpCache = new Map(); // cliName → setupInfo | null

async function discoverSetupFromHelp(binPath, cliName) {
  if (_setupHelpCache.has(cliName)) {
    return _setupHelpCache.get(cliName);
  }

  const setupInfo = {};
  const helpParts = [];

  // 1. Run <cli> --help
  const r0 = await spawnCapture(binPath, ['--help'], { timeoutMs: 5000 });
  const r0out = (r0.stdout || '') + (r0.stderr || '');
  if (r0.exitCode !== 0 && !r0out) {
    // Try -h as fallback
    const r0b = await spawnCapture(binPath, ['-h'], { timeoutMs: 5000 });
    const r0bout = (r0b.stdout || '') + (r0b.stderr || '');
    if (r0b.exitCode !== 0 && !r0bout) {
      _setupHelpCache.set(cliName, null);
      return null;
    }
    helpParts.push({ subcmd: null, output: r0bout });
  } else {
    helpParts.push({ subcmd: null, output: r0out });
  }

  const mainHelp = helpParts[0].output;
  const mainLower = mainHelp.toLowerCase();

  // 2. Detect setup-related subcommands from main --help
  const setupSubcmds = [];
  const subcmdPatterns = [
    { regex: /\b(init|setup|config(?:ure)?)\b/gi, field: 'initCmd' },
    { regex: /\b(auth(?:enticate)?|login|signin|sign-in)\b/gi, field: 'authCmd' },
  ];

  for (const { regex, field } of subcmdPatterns) {
    const matches = [...mainHelp.matchAll(regex)];
    for (const m of matches) {
      const subcmd = m[1].toLowerCase().replace(/-/g, '');
      if (!setupSubcmds.some(s => s.subcmd === subcmd)) {
        setupSubcmds.push({ subcmd, field, raw: m[1] });
      }
    }
  }

  // 3. For each found subcommand, run <cli> <subcmd> --help for details
  for (const { subcmd, field, raw } of setupSubcmds.slice(0, 4)) {
    try {
      const rs = await spawnCapture(binPath, [subcmd, '--help'], { timeoutMs: 5000 });
      const rsout = (rs.stdout || '') + (rs.stderr || '');
      if (rsout) {
        helpParts.push({ subcmd, output: rsout });

        // Set the command (use the raw form from --help if it had a hyphen)
        if (field === 'initCmd' && !setupInfo.initCmd) {
          setupInfo.initCmd = `${cliName} ${raw.toLowerCase()}`;
        } else if (field === 'authCmd' && !setupInfo.authCmd) {
          // Check for --web/--browser flags
          let authCmd = `${cliName} ${raw.toLowerCase()}`;
          if (/--web\b/.test(rsout)) authCmd += ' --web';
          else if (/--browser\b/.test(rsout)) authCmd += ' --browser';
          setupInfo.authCmd = authCmd;
        }

        // Check for OAuth/client_id/client_secret in subcommand help
        const subLower = rsout.toLowerCase();
        if (/client.?id|client.?secret|oauth/.test(subLower) && !setupInfo.credentials) {
          setupInfo.credentials = ['oauth'];
        }
        if (/api.?key|api-key/.test(subLower) && !setupInfo.credentials) {
          setupInfo.credentials = ['api_key'];
        }
      }
    } catch (_) {}
  }

  // 4. Also check main --help for OAuth/API key indicators
  if (!setupInfo.credentials) {
    if (/client.?id|client.?secret|oauth/.test(mainLower)) {
      setupInfo.credentials = ['oauth'];
    } else if (/api.?key|api-key/.test(mainLower)) {
      setupInfo.credentials = ['api_key'];
    }
  }

  // 4b. Discover verifyCmd — a read-only subcommand that makes an API call
  // requiring valid auth. Used by actionPreflightCheck when tokenCmd is null.
  if (!setupInfo.verifyCmd) {
    setupInfo.verifyCmd = await _discoverVerifyCmd(binPath, cliName, mainHelp, helpParts);
  }

  // 5. Build instructions from what we found
  if (setupInfo.initCmd || setupInfo.authCmd) {
    const parts = [];
    if (setupInfo.credentials?.includes('oauth')) {
      parts.push('Requires OAuth client ID and secret.');
    } else if (setupInfo.credentials?.includes('api_key')) {
      parts.push('Requires API key.');
    }
    if (setupInfo.initCmd) {
      parts.push(`Run \`${setupInfo.initCmd}\` to configure.`);
    } else if (setupInfo.authCmd) {
      parts.push(`Run \`${setupInfo.authCmd}\` to authenticate.`);
    }
    setupInfo.instructions = parts.join(' ');
  }

  // 6. If we found nothing useful, return null
  if (!setupInfo.authCmd && !setupInfo.initCmd && !setupInfo.credentials && !setupInfo.instructions && !setupInfo.verifyCmd) {
    _setupHelpCache.set(cliName, null);
    return null;
  }

  // 7. Store help output (truncated) for debugging
  setupInfo.helpOutput = helpParts.map(h => h.output).join('\n---\n').slice(0, 2000);

  logger.info(`[cli.agent] discoverSetupFromHelp: ${cliName} → ${JSON.stringify({ authCmd: setupInfo.authCmd, initCmd: setupInfo.initCmd, credentials: setupInfo.credentials, verifyCmd: setupInfo.verifyCmd })}`);
  _setupHelpCache.set(cliName, setupInfo);
  return setupInfo;
}

// _registerCliInAllowlist — proactively register a CLI in shell.run's
// user allowlist (~/.thinkdrop/allowed-commands.json) so shell.run can
// execute it directly without hitting the reactive consent gate.
// Called by actionBuildAgent after a CLI is confirmed installed.
// Non-fatal: build_agent succeeds even if this write fails.
// ---------------------------------------------------------------------------
function _registerCliInAllowlist(cliName) {
  try {
    const allowPath = path.join(os.homedir(), '.thinkdrop', 'allowed-commands.json');
    fs.mkdirSync(path.dirname(allowPath), { recursive: true });
    let existing = [];
    if (fs.existsSync(allowPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
        existing = Array.isArray(raw) ? raw : (Array.isArray(raw?.commands) ? raw.commands : []);
      } catch (_) {}
    }
    const baseName = path.basename(cliName);
    const normalized = [...new Set([...existing, baseName])].sort();
    fs.writeFileSync(allowPath, JSON.stringify({ commands: normalized }, null, 2), 'utf8');
    logger.info(`[cli.agent] registered "${baseName}" in shell.run allowlist (${allowPath})`);
  } catch (err) {
    logger.warn(`[cli.agent] could not register "${cliName}" in shell.run allowlist: ${err.message}`);
  }
}

// Action: build_agent
// ---------------------------------------------------------------------------

function inferCapabilities(helpText, meta) {
  const caps = new Set();
  if (meta?.tokenCmd) caps.add('get_token');
  const patterns = [
    [/\bpr\b|\bpull.request/i,   'create_pr'],
    [/\bissue/i,                  'create_issue'],
    [/\brepo\b/i,                 'manage_repos'],
    [/\bsend\b|\bmessage/i,       'send_message'],
    [/\bdeploy\b/i,               'deploy'],
    [/\bsecret\b/i,               'manage_secrets'],
    [/\blog\b|\blogs\b/i,         'view_logs'],
    [/\bconfig\b/i,               'manage_config'],
    [/\bauth\b|\blogin\b/i,       'authenticate'],
    [/\bworkflow\b|\baction\b/i,  'manage_workflows'],
    [/\bbucket\b|\bs3\b/i,        'manage_storage'],
    [/\blambda\b|\bfunction\b/i,  'manage_functions'],
    [/\bsms\b|\bcall\b/i,         'send_sms'],
    [/\bpayment\b|\bcharge\b/i,   'manage_payments'],
  ];
  for (const [re, cap] of patterns) {
    if (re.test(helpText)) caps.add(cap);
  }
  if (caps.size === 0) caps.add('run_commands');
  return [...caps];
}

// ---------------------------------------------------------------------------
// extractCapabilitiesAndFlags — LLM-driven capability + flag table extraction.
// Passes the FULL --help text to the LLM (no char truncation — LLMs have 128K+
// context; 60KB of help text is trivial). Returns:
//   { capabilities: string[], flagTable: string }
// where flagTable is a markdown table of capability → exact flag syntax.
// Falls back to inferCapabilities() regex if LLM is unavailable.
// ---------------------------------------------------------------------------
const CAPABILITY_EXTRACT_SYSTEM = `You are a CLI tool analyst. Given a CLI tool's --help output, extract its key capabilities and the exact flag syntax needed to use each one.

Output ONLY valid JSON with this exact structure:
{
  "capabilities": ["capability_slug_1", "capability_slug_2", ...],
  "flagMap": {
    "capability_slug_1": "--flag1 VALUE --flag2",
    "capability_slug_2": "--other-flag"
  },
  "notes": "any critical env requirements (e.g. required runtimes, auth steps)"
}

Rules:
- capability slugs: lowercase_underscore, e.g. "extract_subtitles", "download_video", "extract_audio"
- flagMap values: exact flag syntax as you would type it (no binary name, no URL placeholder)
- Include at most 15 capabilities — prioritize in this order:
  1. HIGHEST PRIORITY — media/content operations: download, extract, subtitle, transcription, audio, video, format selection, playlist, captions, chapters
  2. MEDIUM PRIORITY — core functional ops: search, convert, stream, record, upload
  3. LOW PRIORITY — tool management: update, configure, list-extractors, set-user-agent, rate-limit, network options
  (If cap limit forces exclusion, drop low-priority items first)
- For video/audio download tools (yt-dlp, youtube-dl, gallery-dl, spotdl): you MUST include BOTH:
  - "extract_subtitles": "--write-subs --sub-langs LANG --sub-format FORMAT --skip-download"
  - "write_auto_subs": "--write-auto-subs --sub-langs LANG --sub-format FORMAT --skip-download"
  Replace LANG with the actual flag default (e.g. "en") and FORMAT with common format (e.g. "vtt")
- For tools with JS runtime requirements (yt-dlp, etc.), include a "js_runtime" entry in flagMap with the flag to specify the runtime
- notes: one short sentence only, or empty string
- No markdown, no explanation — ONLY the JSON object`;

async function extractCapabilitiesAndFlags(cliName, helpText) {
  if (!helpText || !helpText.trim()) return null;

  const user = `CLI tool: ${cliName}

Full --help output:
${helpText}

Extract capabilities and flag syntax.`;

  try {
    const raw = await callLLM(CAPABILITY_EXTRACT_SYSTEM, user, { temperature: 0.1, maxTokens: 800 });
    if (raw) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed?.capabilities) && parsed.capabilities.length > 0) {
          logger.info(`[cli.agent] extractCapabilitiesAndFlags: extracted ${parsed.capabilities.length} capabilities for "${cliName}"`);
          return parsed;
        }
      }
    }
  } catch (llmErr) {
    logger.warn(`[cli.agent] extractCapabilitiesAndFlags LLM failed for "${cliName}" (falling back to regex): ${llmErr.message}`);
  }
  return null;
}

// Regex fallback for inferPreSteps when LLM is unavailable.
function _inferPreStepsFallback(cliName, helpText) {
  const help = (helpText || '').toLowerCase();
  const name = cliName.toLowerCase();
  const steps = [];

  // URL-primary tools
  const URL_RE = [
    /\burl\b.*\binput\b|\binput\b.*\burl\b/,
    /\byoutube\b|\bvimeo\b|\btiktok\b|\brumble\b|\bdailymot/,
    /yt.dlp|youtube.dl|gallery.dl/,
    /\b(download|extract|fetch|scrape)\b.*\burl\b/,
    /usage:.*\s+url/,
    /positional.*\burl\b|\burl\b.*positional/,
  ];
  if (URL_RE.some(re => re.test(help)) || URL_RE.some(re => re.test(name))) {
    steps.push('  - skill: web.agent action: search_and_navigate purpose: resolve_url');
  }

  // File-primary tools
  const FILE_RE = [
    /\binput\b.*\bfile\b|\bfile\b.*\binput\b/,
    /usage:.*<(input|source|file|src)>/,
    /ffmpeg|imagemagick|magick|pandoc|convert|sox|mutagen|exiftool/,
  ];
  if (FILE_RE.some(re => re.test(help)) || FILE_RE.some(re => re.test(name))) {
    steps.push('  - skill: web.agent action: search_and_navigate purpose: resolve_file');
  }

  return steps;
}

/**
 * Infer pre_steps for a CLI descriptor using LLM analysis of --help output.
 * The LLM determines what external inputs the tool requires as primary positional
 * arguments (URL, file path, structured query) that a user's natural-language
 * task description may not provide explicitly.
 * Falls back to regex detection if LLM is unavailable.
 */
async function inferPreSteps(cliName, helpText) {
  const HELP_LIMIT = 3000;
  const trimmedHelp = (helpText || '').slice(0, HELP_LIMIT);

  if (!trimmedHelp) return _inferPreStepsFallback(cliName, helpText);

  const system = `You are a CLI tool analyst. Given a CLI tool's --help output, identify what external inputs the tool requires as its PRIMARY positional arguments — things the tool cannot function without, and that a user's natural-language task description might not provide explicitly.

Three input types to detect:
- "resolve_url"   → tool's primary positional arg is a URL (e.g. yt-dlp <URL>, wget <URL>, gallery-dl <URL>)
- "resolve_file"  → tool's primary positional arg is a local file path (e.g. ffmpeg -i <file>, pandoc <file>, convert <file>)
- "resolve_query" → tool requires a structured search/query string rather than accepting free-form natural language directly

Rules:
- Only include a pre_step when the tool CANNOT run without that input type
- "resolve_url" and "resolve_file" are mutually exclusive as the PRIMARY input
- Never add pre_steps for optional flags or configuration options
- If no pre_steps are needed (tool is self-contained), return { "pre_steps": [] }
- Respond ONLY with valid JSON, no markdown, no explanation

Output format:
{ "pre_steps": [ { "purpose": "resolve_url", "reason": "<one sentence>" } ] }`;

  const user = `CLI tool: ${cliName}

--help output:
${trimmedHelp}

What external primary inputs does "${cliName}" require that a user's natural-language task description might not provide explicitly?`;

  try {
    const raw = await callLLM(system, user, { temperature: 0.1, maxTokens: 300 });
    if (raw) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed?.pre_steps)) {
          const steps = parsed.pre_steps
            .filter(s => s && typeof s.purpose === 'string')
            .map(s => `  - skill: web.agent action: search_and_navigate purpose: ${s.purpose}`);
          logger.info(`[cli.agent] inferPreSteps LLM result for "${cliName}": ${JSON.stringify(parsed.pre_steps)}`);
          return steps;
        }
      }
    }
  } catch (llmErr) {
    logger.warn(`[cli.agent] inferPreSteps LLM failed (falling back to regex): ${llmErr.message}`);
  }

  // Fallback to regex if LLM unavailable or returned unparseable output
  return _inferPreStepsFallback(cliName, helpText);
}

async function buildDescriptorMd({ id, service, cliName, version, capabilities, helpText, subcommandMap, llmExtraction }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');

  // Generate usage playbook from capabilities and subcommandMap
  const usagePlaybook = generateUsagePlaybook(service, cliName, capabilities, subcommandMap);

  // Infer pre_steps via LLM analysis of --help output (regex fallback if LLM unavailable)
  const preStepsLines = await inferPreSteps(cliName, helpText);
  const preStepsYaml = preStepsLines.length > 0
    ? `pre_steps:\n${preStepsLines.join('\n')}\n`
    : '';

  const parts = [
    '---',
    `id: ${id}`,
    `type: cli`,
    `service: ${service}`,
    `cli_tool: ${cliName}`,
    `capabilities:`,
    capYaml,
    `version: ${version || 'unknown'}`,
    ...(preStepsYaml ? [preStepsYaml.trimEnd()] : []),
    '---',
    '',
    `## Instructions`,
    `Use \`${cliName}\` CLI for all ${service} operations.`,
    `Authentication is persistent after the first \`${cliName} auth login\` (or equivalent).`,
    `Always use \`run_help\` to check flag syntax before running unfamiliar commands.`,
  ];

  // ── LLM-extracted capability + flag table (preferred) ──────────────────────
  // When available, this replaces the raw truncated --help blob entirely.
  // The LLM reads the FULL --help (no char limit) and produces a compact,
  // authoritative table of capabilities → exact flag syntax.
  if (llmExtraction?.flagMap && Object.keys(llmExtraction.flagMap).length > 0) {
    parts.push('');
    parts.push('## Key Capabilities & Flags');
    parts.push('| Capability | Exact Flag Syntax |');
    parts.push('|---|---|');
    for (const [cap, flags] of Object.entries(llmExtraction.flagMap)) {
      parts.push(`| ${cap.replace(/_/g, ' ')} | \`${flags}\` |`);
    }
    if (llmExtraction.notes) {
      parts.push('');
      parts.push(`> **Note:** ${llmExtraction.notes}`);
    }
    // Keep a short head of raw help for basic usage/version context
    parts.push('');
    parts.push('## CLI Usage (head)');
    parts.push('```');
    parts.push((helpText || '').slice(0, 500));
    parts.push('```');
  } else {
    // ── Fallback: raw --help head (no LLM extraction available) ──────────────
    parts.push('');
    parts.push('## CLI Help Output');
    parts.push('```');
    parts.push((helpText || '').slice(0, 2000));
    parts.push('```');
  }

  // Append subcommand help when available
  if (subcommandMap && Object.keys(subcommandMap).length > 0) {
    parts.push('', '## Subcommand Help');
    // Include top 5 subcommands with their full --help output
    const subcmds = Object.entries(subcommandMap).slice(0, 5);
    for (const [subcmd, detail] of subcmds) {
      parts.push(`### ${subcmd} --help`);
      parts.push('```');
      parts.push((String(detail)).slice(0, 500));
      parts.push('```');
    }
  }

  // Append usage playbook
  parts.push('', usagePlaybook);

  return parts.join('\n');
}

/**
 * Generate usage playbook from capabilities and subcommands
 * Maps natural language to CLI commands
 */
function generateUsagePlaybook(service, cliName, capabilities, subcommandMap) {
  const playbook = ['## Usage Playbook', ''];
  playbook.push('| User Says | CLI Command |');
  playbook.push('|-----------|-------------|');

  // Map common capabilities to example commands
  const capabilityPatterns = {
    'create_pr': [`Create a pull request for "fix bug"`, `${cliName} pr create --title "fix bug"`],
    'create_issue': [`File a bug about login`, `${cliName} issue create --title "Login bug" --label bug`],
    'manage_repos': [`List my repositories`, `${cliName} repo list`],
    'send_message': [`Send "hello" to #general`, `${cliName} chat send --channel general --message "hello"`],
    'deploy': [`Deploy to production`, `${cliName} deploy --prod`],
    'manage_secrets': [`Set API_KEY secret`, `${cliName} secrets set API_KEY`],
    'view_logs': [`Show recent logs`, `${cliName} logs --tail`],
    'manage_config': [`Set config value`, `${cliName} config set key value`],
    'authenticate': [`Login to ${service}`, `${cliName} auth login`],
    'get_token': [`Get current auth token`, `${cliName} auth token`],
    'run_commands': [`Run a command on ${service}`, `${cliName} <command>`],
    'transcribe': [`Transcribe video to text`, `${cliName} <video_url>`],
    'transcribe_video': [`Transcribe this YouTube video`, `${cliName} "https://youtube.com/watch?v=..."`],
    'extract_audio': [`Extract audio from video`, `${cliName} <video> --extract-audio`],
  };

  // Add patterns for each capability
  for (const cap of capabilities) {
    if (capabilityPatterns[cap]) {
      playbook.push(`| ${capabilityPatterns[cap][0]} | \`${capabilityPatterns[cap][1]}\` |`);
    }
  }

  // Add patterns from subcommandMap
  if (subcommandMap && Object.keys(subcommandMap).length > 0) {
    const subcmds = Object.keys(subcommandMap).slice(0, 3);
    for (const subcmd of subcmds) {
      playbook.push(`| ${subcmd} something with ${service} | \`${cliName} ${subcmd} <args>\` |`);
    }
  }

  // Default pattern if no specific capabilities
  if (capabilities.length === 0 || capabilities.includes('run_commands')) {
    playbook.push(`| Work with ${service} | \`${cliName} <command> <args>\` |`);
  }

  // Add natural language patterns section
  playbook.push('');
  playbook.push('## Natural Language Patterns');
  playbook.push(`- "use ${service} to <action>"`);
  playbook.push(`- "${cliName} <command>"`);
  playbook.push(`- "help me with ${service}"`);

  // Add capability-specific patterns
  for (const cap of capabilities.slice(0, 3)) {
    const pattern = cap.replace(/_/g, ' ');
    playbook.push(`- "${pattern} using ${service}"`);
  }

  return playbook.join('\n');
}

async function _buildApiKeyAgentDescriptor({ service, serviceKey, agentId, meta, force = false }) {
  // Check registry
  if (!force) {
    const checkResult = await withDb(async (db) => {
      const rows = await db.all('SELECT id, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update') {
        return { found: true, status: rows[0].status };
      }
      return { found: false };
    });
    if (checkResult.found) {
      return { ok: true, agentId, alreadyExists: true, status: checkResult.status, isApiKey: true };
    }
  }

  const apiKeyEnvVar = meta?.apiKeyEnvVar || `${serviceKey.toUpperCase()}_API_KEY`;
  const apiKeyUrl    = meta?.apiKeyUrl    || `https://${serviceKey}.com/settings/api-keys`;
  const capabilities = ['api_call', 'get_api_key'];

  const descriptor = [
    '---',
    `id: ${agentId}`,
    `type: api_key`,
    `service: ${serviceKey}`,
    `cli_tool: null`,
    `api_key_env: ${apiKeyEnvVar}`,
    `api_key_url: ${apiKeyUrl}`,
    `capabilities:`,
    capabilities.map(c => `  - ${c}`).join('\n'),
    '---',
    '',
    `## Instructions`,
    `${serviceKey} has no official CLI. Authentication is via API key.`,
    `API key env var: \`${apiKeyEnvVar}\``,
    `Get API key at: ${apiKeyUrl}`,
    `Store the key in macOS Keychain: keytar.setPassword('thinkdrop', 'skill:<name>:${apiKeyEnvVar}', '<key>')`,
    `${meta?.notes || ''}`,
  ].join('\n');

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'api_key', ?, NULL, ?, ?, CURRENT_TIMESTAMP, 'healthy', CURRENT_TIMESTAMP)`,
      agentId, serviceKey, JSON.stringify(capabilities), descriptor
    );
  });

  logger.info(`[cli.agent] built api_key agent: ${agentId}`);
  return { ok: true, agentId, alreadyExists: false, isApiKey: true, service: serviceKey, apiKeyEnvVar, apiKeyUrl, descriptor, mdPath };
}

async function actionBuildAgent({ service, cli: explicitCli, force = false }) {
  if (!service) return { ok: false, error: 'service is required' };

  const serviceKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId    = `${serviceKey}.agent`;

  // Resolve meta via LLM if not in seed cache — never hard-fail on unknown service
  const meta    = await lookupServiceAsync(service);
  const cliName = explicitCli || meta?.cli;

  // If this is an OAuth or API-key-only service with no CLI, delegate to browser.agent
  if (!cliName) {
    if (meta?.isOAuth) {
      return {
        ok: false,
        noCli: true,
        isOAuth: true,
        service: serviceKey,
        error: `"${service}" uses OAuth — delegate to browser.agent build_agent for credential setup.`,
        delegateTo: 'browser.agent',
        meta,
      };
    }
    if (meta?.isApiKey) {
      // For API-key-only services, build a minimal descriptor so installSkill
      // knows the key name and where to find it — no CLI needed.
      return await _buildApiKeyAgentDescriptor({ service, serviceKey, agentId, meta, force });
    }
    return {
      ok: false,
      noCli: true,
      service: serviceKey,
      error: `No CLI found for "${service}". LLM lookup returned no CLI or install method.`,
      meta,
    };
  }

  // Check registry — skip rebuild unless forced
  if (!force) {
    const checkResult = await withDb(async (db) => {
      const rows = await db.all('SELECT id, status FROM agents WHERE id = ?', agentId);
      if (rows?.length > 0) {
        const status = rows[0].status || 'needs_validation';
        if (status !== 'needs_update') return { found: true, status };
      }
      return { found: false };
    });
    if (checkResult.found) {
      return { ok: true, agentId, alreadyExists: true, status: checkResult.status };
    }
  }

  // Discover CLI — if not installed, attempt auto-install via brew/npm
  let discovery = await actionDiscover({ cli: cliName });
  if (!discovery.installed && meta?.method && meta?.pkg) {
    logger.info(`[cli.agent] build_agent: auto-installing CLI "${cliName}" via ${meta.method}…`);
    const installResult = await actionInstall({ cli: cliName, service, method: meta.method });
    if (installResult.ok || installResult.alreadyInstalled) {
      discovery = await actionDiscover({ cli: cliName });
    }
  }
  if (!discovery.installed) {
    return {
      ok: false,
      agentId,
      error: `CLI "${cliName}" is not installed and auto-install failed. Try: ${meta?.method || 'brew'} install ${meta?.pkg || cliName}`,
      needsInstall: true,
      installMeta: meta ? { cli: cliName, method: meta.method, pkg: meta.pkg } : null,
    };
  }

  // LLM-driven capability + flag extraction from FULL --help (no char limit).
  // Falls back to regex inferCapabilities() if LLM is unavailable.
  const llmExtraction = await extractCapabilitiesAndFlags(cliName, discovery.help || '');
  const capabilities = llmExtraction?.capabilities?.length
    ? llmExtraction.capabilities
    : inferCapabilities(discovery.help || '', meta);

  const descriptor   = await buildDescriptorMd({
    id: agentId,
    service: serviceKey,
    cliName,
    version: discovery.version,
    capabilities,
    helpText: discovery.help,
    subcommandMap: discovery.subcommandMap,
    llmExtraction,
  });

  // Proactively register CLI in shell.run's user allowlist so shell.run can
  // execute it directly (e.g. via bash -c "yt-dlp ...") without the consent gate.
  _registerCliInAllowlist(cliName);

  // Write .md file to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'cli', ?, ?, ?, ?, CURRENT_TIMESTAMP, 'needs_validation', CURRENT_TIMESTAMP)`,
      agentId,
      serviceKey,
      cliName,
      JSON.stringify(capabilities),
      descriptor
    );
  });

  logger.info(`[cli.agent] built agent: ${agentId}`, { capabilities });
  return {
    ok: true,
    agentId,
    alreadyExists: false,
    service: serviceKey,
    cliTool: cliName,
    version: discovery.version,
    capabilities,
    mdPath,
    descriptor,
    stdout: `Agent ${agentId} built successfully. CLI: ${cliName} v${discovery.version || 'unknown'}. Capabilities: ${capabilities.join(', ')}.`,
  };
}


// ---------------------------------------------------------------------------
// Action: query_agent
// ---------------------------------------------------------------------------

async function actionQueryAgent({ service, id }) {
  if (!service && !id) return { ok: false, error: 'service or id is required' };

  return await withDb(async (db) => {
    let rows;
    if (id) {
      rows = await db.all('SELECT * FROM agents WHERE id = ?', id);
    } else {
      const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      rows = await db.all('SELECT * FROM agents WHERE service = ? AND type = ?', serviceKey, 'cli');
    }

    if (!rows || rows.length === 0) return { ok: true, found: false };

    const row = rows[0];
    return {
      ok: true,
      found: true,
      agentId: row.id,
      service: row.service,
      cliTool: row.cli_tool,
      capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
      status: row.status || 'needs_validation',
      lastValidated: row.last_validated,
      descriptor: row.descriptor,
    };
  });
}

// ---------------------------------------------------------------------------
// Action: list_agents
// ---------------------------------------------------------------------------

async function actionListAgents() {
  if (!fs.existsSync(AGENTS_DIR)) return { ok: true, agents: [] };
  
  return await withDb(async (db) => {
    const rows = await db.all("SELECT id, type, service, cli_tool, capabilities, status, last_validated FROM agents WHERE type = 'cli' ORDER BY created_at DESC");
    return {
      ok: true,
      agents: (rows || []).map(r => ({
        id: r.id,
        type: r.type,
        service: r.service,
        cliTool: r.cli_tool,
        capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
        status: r.status || 'needs_validation',
        lastValidated: r.last_validated,
      })),
    };
  });
}

// Action: list_all_agents (for main process UI via HTTP)
// ---------------------------------------------------------------------------

function _parseFrontmatterField(descriptor, key) {
  if (!descriptor) return null;
  const match = descriptor.match(new RegExp(`^${key}:\\s*(.+)`, 'm'));
  return match ? match[1].trim() : null;
}

async function actionListAllAgents() {
  return await withDb(async (db) => {
    // Unconditional: delete all legacy bare-id rows (e.g. 'youtube', 'gmail')
    // that don't have the canonical '.agent' suffix. Safe to run every call.
    await db.run("DELETE FROM agents WHERE id NOT LIKE '%.agent'").catch(() => {});

    const rows = await db.all("SELECT id, type, service, cli_tool, capabilities, status, last_validated, descriptor, authed_at FROM agents ORDER BY created_at DESC");
    return {
      ok: true,
      agents: (rows || []).map(r => {
        const apiKeyUrl = _parseFrontmatterField(r.descriptor, 'api_key_url');
        const apiKeyEnv = _parseFrontmatterField(r.descriptor, 'api_key_env');
        // Normalize id to canonical '.agent' suffix
        let id = r.id || '';
        if (id && !id.toLowerCase().endsWith('.agent')) {
          id = `${id}.agent`;
        }
        return {
          id,
          type: r.type || 'browser',
          service: r.service,
          cliTool: r.cli_tool,
          capabilities: (() => { try { return r.capabilities ? JSON.parse(r.capabilities) : []; } catch (_) { return []; } })(),
          status: r.status || 'pending',
          lastValidated: r.last_validated,
          authedAt: r.authed_at || null,
          start_url: _parseFrontmatterField(r.descriptor, 'start_url') || null,
          ...(apiKeyUrl ? { apiKeyUrl } : {}),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Shared: lightweight LLM caller via the VSCode WebSocket backend (port 4000)
// ---------------------------------------------------------------------------

const LLM_WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
const LLM_API_KEY = process.env.VSCODE_API_KEY || '';

async function callLLM(systemPrompt, userQuery, { temperature = 0.2, maxTokens = 1200 } = {}) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return null; }

  const url = new URL(LLM_WS_URL);
  if (LLM_API_KEY) url.searchParams.set('apiKey', LLM_API_KEY);
  url.searchParams.set('userId', 'cli_agent_validator');
  url.searchParams.set('clientId', `cli_agent_${Date.now()}`);

  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url.toString()); } catch { return resolve(null); }

    let accumulated = '';
    let streamStarted = false;
    const connTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, 8000);
    const respTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(accumulated || null); }, 60000);

    ws.on('open', () => {
      clearTimeout(connTimeout);
      ws.send(JSON.stringify({
        id: `val_${Date.now()}`,
        type: 'llm_request',
        payload: {
          prompt: userQuery,
          provider: 'openai',
          options: { temperature, stream: true, taskType: 'ask' },
          context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] },
        },
        timestamp: Date.now(),
        metadata: { source: 'cli_agent_validator' },
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_start') { streamStarted = true; }
        else if (msg.type === 'llm_stream_chunk') { accumulated += (msg.payload?.text || msg.payload?.chunk || ''); }
        else if (msg.type === 'llm_stream_end') { clearTimeout(respTimeout); ws.close(); resolve(accumulated); }
        else if (msg.type === 'error') { clearTimeout(respTimeout); ws.close(); resolve(accumulated || null); }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
    ws.on('close', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
  });
}

// ---------------------------------------------------------------------------
// Action: validate_agent — LLM-powered health check, error diagnosis + auto-fix
// ---------------------------------------------------------------------------

// Phase 1: health check — are the documented commands still working?
const CLI_HEALTH_CHECK_PROMPT = `You are ThinkDrop's CLI Agent Health Checker. Your job is to assess whether the CLI commands documented in an agent descriptor are still working correctly.

You will receive:
1. The agent's current descriptor (.md with capabilities, version, help reference)
2. Results of running representative CLI commands (stdout, stderr, exit codes)
3. Current CLI version vs stored version

Your analysis must cover:
- Are the documented commands still valid? (flag renames, deprecated subcommands, changed syntax)
- Did any commands produce errors? What is the root cause and exact fix?
- Did the version change in a breaking way?
- Are any capabilities now missing or renamed?
- Does the help output reveal new capabilities not in the descriptor?

Output ONLY valid JSON:
{
  "verdict": "healthy" | "degraded" | "needs_update",
  "versionDrift": true | false,
  "brokenCommands": ["<cmd that failed and why>"],
  "fixes": ["<precise fix instruction — exact new command syntax, flag, or workaround>"],
  "newCapabilities": ["<capability found in new help that is not in descriptor>"],
  "removedCapabilities": ["<capability that no longer exists>"],
  "updatedDescriptorPatch": "<patch text to append/replace in ## Instructions section, or null if no change needed>",
  "summary": "<one sentence overall assessment>"
}

IMPORTANT: Only flag real errors. A non-zero exit code on a token command is expected when the user is not logged in — treat that as healthy. Focus on syntax errors, unknown flags, command not found, and breaking API changes.`;

// Phase 2: pipeline review — does this descriptor handle every case the pipeline will throw at it?
// This is the "senior engineer code review" pass — reason about gaps, missing alternatives,
// wrong routing flags, incomplete capabilities, edge cases the pipeline will hit.
const CLI_PIPELINE_REVIEW_PROMPT = `You are ThinkDrop's Pipeline Review Agent. You perform a deep review of a CLI agent descriptor — not just checking if commands work, but whether the descriptor is COMPLETE and CORRECT for all the real-world cases the autonomous pipeline will encounter.

The ThinkDrop pipeline works like this:
- planSkills reads agent descriptors to decide whether credentials are already resolved
- buildSkill injects agent descriptors into the LLM prompt to generate skill code
- installSkill calls cli.agent to silently extract credentials before prompting the user
- cli.agent routes services based on: cli (has CLI tool), isOAuth (needs browser OAuth), isApiKey (API key only)

You must reason as a senior engineer reviewing this descriptor. Ask yourself:

1. ROUTING CORRECTNESS
   - Is cli: null correct? Or is there actually a CLI tool for this service that should be used instead?
   - If cli: null, is isOAuth or isApiKey set correctly? (Gmail = isOAuth, OpenAI = isApiKey)
   - Are there better or more widely-used CLI tools that were overlooked? (e.g. himalaya for Gmail, gh for GitHub)
   - Example gap found in real review: gmail had cli: null + isOAuth, but himalaya CLI exists and handles Gmail OAuth natively

2. CAPABILITY COMPLETENESS
   - Do the listed capabilities match what a skill would actually need for this service?
   - Are common operations missing? (e.g. gmail missing: list_inbox, search_emails, send_email, get_attachment)
   - Are there capabilities listed that the CLI cannot actually perform?

3. AUTH FLOW ACCURACY
   - Is the tokenCmd correct and will it actually return a usable token?
   - For OAuth services: does the descriptor explain the full refresh token flow?
   - For API key services: is apiKeyUrl pointing to the correct page?
   - Are there edge cases (token expiry, scope insufficiency, rate limits) not documented?

4. SKILL CODE QUALITY RISK
   - If a skill is built using this descriptor, will the generated code be correct?
   - Are CLI command examples precise enough? (exact flags, output format, JSON vs plaintext)
   - Will the skill know how to handle errors from this service?

5. PIPELINE GAPS
   - Is there anything about this service that the pipeline will hit but this descriptor doesn't cover?
   - Are there setup steps required (e.g. himalaya account configure) that installSkill needs to know about?
   - Are there platform limitations (macOS only, requires specific version, etc.)?

Output ONLY valid JSON:
{
  "routingCorrect": true | false,
  "routingIssues": ["<precise description of routing problem and exact fix>"],
  "betterAlternatives": [{ "name": "<cli name>", "reason": "<why it's better>", "installCmd": "<brew/npm install ...>" }],
  "missingCapabilities": ["<capability that should be listed but isn't>"],
  "incorrectCapabilities": ["<capability listed but CLI cannot actually do it>"],
  "authFlowIssues": ["<problem with auth flow documentation>"],
  "skillCodeRisks": ["<thing that will cause generated skill code to be wrong>"],
  "pipelineGaps": ["<gap the pipeline will hit but descriptor doesn't cover>"],
  "setupStepsRequired": ["<interactive setup step installSkill must inform the user about>"],
  "descriptorPatch": "<full replacement for ## Instructions section if significant changes needed, or null>",
  "verdict": "complete" | "has_gaps" | "needs_rebuild",
  "summary": "<2-3 sentence assessment written like a senior engineer's code review comment>"
}`;

// Pick representative safe read-only commands to probe from the descriptor
function pickProbeCommands(cliName, descriptor, meta) {
  const probes = [];

  // Always probe: version + help
  probes.push({ label: 'version', argv: ['--version'] });
  probes.push({ label: 'help', argv: ['--help'] });

  // Service-specific safe read commands
  const svc = (meta?.cli || cliName || '').toLowerCase();
  const SAFE_PROBES = {
    gh:        [{ label: 'auth_status', argv: ['auth', 'status'] }, { label: 'repo_list', argv: ['repo', 'list', '--limit', '1'] }],
    aws:       [{ label: 'sts_identity', argv: ['sts', 'get-caller-identity'] }, { label: 'configure_list', argv: ['configure', 'list'] }],
    stripe:    [{ label: 'config_list', argv: ['config', '--list'] }],
    heroku:    [{ label: 'auth_whoami', argv: ['auth:whoami'] }, { label: 'apps', argv: ['apps', '--all'] }],
    netlify:   [{ label: 'status', argv: ['status'] }],
    vercel:    [{ label: 'whoami', argv: ['whoami'] }],
    firebase:  [{ label: 'projects_list', argv: ['projects:list'] }],
    gcloud:    [{ label: 'auth_list', argv: ['auth', 'list'] }, { label: 'config_list', argv: ['config', 'list'] }],
    fly:       [{ label: 'auth_whoami', argv: ['auth', 'whoami'] }, { label: 'apps_list', argv: ['apps', 'list'] }],
    doctl:     [{ label: 'account_get', argv: ['account', 'get'] }],
    docker:    [{ label: 'info', argv: ['info', '--format', '{{.ServerVersion}}'] }, { label: 'ps', argv: ['ps', '--format', 'table {{.Names}}'] }],
    twilio:    [{ label: 'profiles_list', argv: ['profiles:list'] }],
    terraform: [{ label: 'version', argv: ['version'] }, { label: 'providers', argv: ['providers'] }],
    kubectl:   [{ label: 'version', argv: ['version', '--client'] }, { label: 'config_view', argv: ['config', 'current-context'] }],
  };

  const extra = SAFE_PROBES[svc] || [];
  return [...probes, ...extra];
}

async function actionValidateAgent({ id }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  const cliName = existing.cliTool;
  const meta    = await lookupServiceAsync(existing.service);

  // Step 1: confirm CLI is still installed
  const discovery = await actionDiscover({ cli: cliName });
  if (!discovery.installed) {
    const note = `CLI "${cliName}" no longer found. Reinstall with action:install.`;
    await _updateAgentStatus(id, 'needs_update', note);
    return { ok: true, agentId: id, healthy: false, verdict: 'needs_update', issue: 'cli_not_found', cliTool: cliName, summary: note };
  }

  // Step 2: run representative probe commands, collect results
  const probes   = pickProbeCommands(cliName, existing.descriptor, meta);
  const binPath  = await whichCli(cliName);
  const probeResults = [];

  for (const probe of probes) {
    const r = await spawnCapture(binPath, probe.argv, { timeoutMs: 10000 });
    probeResults.push({
      label:    probe.label,
      argv:     `${cliName} ${probe.argv.join(' ')}`,
      exitCode: r.exitCode,
      stdout:   r.stdout.slice(0, 800),
      stderr:   r.stderr.slice(0, 400),
      ok:       r.ok,
    });
  }

  // Step 3: extract stored version from descriptor
  const descriptorLines = (existing.descriptor || '').split('\n');
  const versionLine     = descriptorLines.find(l => l.startsWith('version:'));
  const storedVersion   = versionLine ? versionLine.replace('version:', '').trim() : 'unknown';
  const currentVersion  = discovery.version || 'unknown';

  // Step 4: ask LLM to diagnose
  const probeReport = probeResults.map(p =>
    `[${p.label}] \`${p.argv}\` → exit:${p.exitCode}\nSTDOUT: ${p.stdout}\nSTDERR: ${p.stderr}`
  ).join('\n\n---\n\n');

  const userQuery = [
    `## Agent: ${id}`,
    `## Stored version: ${storedVersion}`,
    `## Current version: ${currentVersion}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 3000),
    '```',
    ``,
    `## Probe Command Results`,
    probeReport,
  ].join('\n');

  // ── Phase 1: health check — are documented commands still working? ───────────
  let healthDiagnosis = null;
  const healthRaw = await callLLM(CLI_HEALTH_CHECK_PROMPT, userQuery, { temperature: 0.1, maxTokens: 1200 });
  if (healthRaw) {
    try {
      const m = healthRaw.match(/\{[\s\S]*\}/);
      if (m) healthDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[cli.agent] validate_agent health parse failed for ${id}`);
    }
  }

  // Mechanical fallback if LLM unavailable
  if (!healthDiagnosis) {
    const versionChanged = storedVersion !== 'unknown' && currentVersion !== 'unknown' && storedVersion !== currentVersion;
    const failedProbes   = probeResults.filter(p => !p.ok && p.label !== 'version' && p.label !== 'help');
    healthDiagnosis = {
      verdict: (versionChanged || failedProbes.length > 0) ? 'needs_update' : 'healthy',
      versionDrift: versionChanged,
      brokenCommands: failedProbes.map(p => p.label),
      fixes: [], newCapabilities: [], removedCapabilities: [],
      updatedDescriptorPatch: null,
      summary: versionChanged
        ? `Version changed: ${storedVersion} → ${currentVersion}`
        : (failedProbes.length > 0 ? `${failedProbes.length} probe(s) failed` : 'Mechanical check passed.'),
    };
  }

  // ── Phase 2: pipeline review — is the descriptor complete for the full pipeline? ─
  // Senior-engineer pass: routing correctness, missing alternatives, capability gaps,
  // auth flow accuracy, skill code risks, setup steps installSkill must surface.
  let reviewDiagnosis = null;
  const reviewQuery = [
    `## Agent: ${id}  (service: ${existing.service}, type: ${existing.type || 'cli'})`,
    `## CLI tool: ${cliName || 'none'}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 4000),
    '```',
    ``,
    `## CLI --help output (first 2000 chars)`,
    '```',
    (probeResults.find(p => p.label === 'help')?.stdout || 'not available').slice(0, 2000),
    '```',
    ``,
    `## Seed-map entry for this service`,
    JSON.stringify(await lookupServiceAsync(existing.service) || {}, null, 2),
  ].join('\n');

  const reviewRaw = await callLLM(CLI_PIPELINE_REVIEW_PROMPT, reviewQuery, { temperature: 0.15, maxTokens: 1600 });
  if (reviewRaw) {
    try {
      const m = reviewRaw.match(/\{[\s\S]*\}/);
      if (m) reviewDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[cli.agent] validate_agent review parse failed for ${id}`);
    }
  }

  // ── Phase 3: cross-agent composition check ───────────────────────────────
  // Scan installed skills that mention this service and verify the skill→agent
  // interface contract: are the args they pass still what the agent expects?
  // A human reviewer would read the skill code and compare it to the descriptor.
  let compositionIssues = [];
  try {
    const os = require('os');
    const skillsBase = path.join(os.homedir(), '.thinkdrop', 'skills');
    if (fs.existsSync(skillsBase)) {
      const skillDirs = fs.readdirSync(skillsBase, { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name);
      const serviceKey = (existing.service || id.replace('.agent', '')).toLowerCase();
      const relatedSkills = [];
      for (const skillDir of skillDirs) {
        if (!skillDir.toLowerCase().includes(serviceKey)) continue;
        const skillFile = path.join(skillsBase, skillDir, `${skillDir}.cjs`);
        if (!fs.existsSync(skillFile)) continue;
        const code = fs.readFileSync(skillFile, 'utf8').slice(0, 3000);
        relatedSkills.push({ name: skillDir, code });
      }
      if (relatedSkills.length > 0 && cliName) {
        const compositionQuery = [
          `## Agent descriptor for ${id}`,
          '```',
          (existing.descriptor || '').slice(0, 2000),
          '```',
          '',
          `## Skills that use this agent (${relatedSkills.length}):`,
          ...relatedSkills.map(s => `### ${s.name}\n\`\`\`js\n${s.code}\n\`\`\``),
        ].join('\n');

        const COMPOSITION_PROMPT = `You are reviewing whether installed skills correctly call a CLI agent.
Check: do the skill's shell commands match the agent descriptor's documented commands exactly?
Are flag names, argument order, and output parsing consistent with what the agent documents?
Output ONLY valid JSON: { "issues": ["<precise mismatch description and fix>"], "ok": true|false }`;

        const compRaw = await callLLM(COMPOSITION_PROMPT, compositionQuery, { temperature: 0.1, maxTokens: 800 });
        if (compRaw) {
          try {
            const m = compRaw.match(/\{[\s\S]*\}/);
            if (m) {
              const compResult = JSON.parse(m[0]);
              compositionIssues = compResult.issues || [];
            }
          } catch { /* non-fatal */ }
        }
      }
    }
  } catch (_) { /* non-fatal — never block validation */ }

  // ── Phase 4: inject runtime failure_log into review for context ───────────
  // If real production failures exist in failure_log, prepend them to the
  // review verdict so the LLM reasons about actual errors, not just theory.
  const runtimeFailureNote = existing.failure_log
    ? `\n\n## Runtime Failures (from production — most recent first)\n${existing.failure_log.slice(0, 1000)}`
    : '';
  if (runtimeFailureNote && reviewDiagnosis) {
    reviewDiagnosis.summary = `[Runtime failures present] ${reviewDiagnosis.summary || ''}`;
  }

  // ── Combine verdicts (worst-case wins) ────────────────────────────────────
  const HEALTH_RANK  = { healthy: 0, degraded: 1, needs_update: 2 };
  const REVIEW_MAP   = { complete: 'healthy', has_gaps: 'degraded', needs_rebuild: 'needs_update' };
  const healthVerdict  = healthDiagnosis.verdict || 'healthy';
  const reviewVerdict  = reviewDiagnosis?.verdict || 'complete';
  const reviewStatus   = REVIEW_MAP[reviewVerdict] || 'healthy';
  const compositionStatus = compositionIssues.length > 0 ? 'degraded' : 'healthy';
  const finalStatus    = [healthVerdict, reviewStatus, compositionStatus]
    .reduce((worst, s) => HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst, 'healthy');

  const failureParts = [];
  if (healthVerdict !== 'healthy')     failureParts.push(`Health: ${healthDiagnosis.summary}`);
  if (reviewVerdict !== 'complete' && reviewDiagnosis?.summary) failureParts.push(`Review: ${reviewDiagnosis.summary}`);
  if (reviewDiagnosis?.pipelineGaps?.length) failureParts.push(`Gaps: ${reviewDiagnosis.pipelineGaps.join(' | ')}`);
  if (reviewDiagnosis?.betterAlternatives?.length)
    failureParts.push(`Alternatives: ${reviewDiagnosis.betterAlternatives.map(a => `${a.name} (${a.reason})`).join(' | ')}`);
  if (compositionIssues.length > 0)    failureParts.push(`Composition: ${compositionIssues.join(' | ')}`);
  if (runtimeFailureNote)              failureParts.push(`RuntimeFailures: ${(existing.failure_log || '').slice(0, 200)}`);
  const failureLog = failureParts.length > 0 ? failureParts.join('\n') : null;

  // ── Auto-patch descriptor ─────────────────────────────────────────────────
  let patchedDescriptor = existing.descriptor;
  let descriptorPatched = false;

  if (healthVerdict === 'needs_update' && healthDiagnosis.updatedDescriptorPatch) {
    patchedDescriptor = patchDescriptor(patchedDescriptor, {
      version: currentVersion, patch: healthDiagnosis.updatedDescriptorPatch,
      newCaps: healthDiagnosis.newCapabilities || [], removedCaps: healthDiagnosis.removedCapabilities || [],
    });
    descriptorPatched = true;
  }
  if (reviewDiagnosis?.descriptorPatch) {
    patchedDescriptor = patchDescriptor(patchedDescriptor, {
      version: currentVersion, patch: reviewDiagnosis.descriptorPatch,
      newCaps: reviewDiagnosis.missingCapabilities || [], removedCaps: reviewDiagnosis.incorrectCapabilities || [],
    });
    descriptorPatched = true;
  }

  // ── Auto-rebuild with better CLI if review demands it ────────────────────
  let rebuildTriggered = false;
  if (reviewVerdict === 'needs_rebuild' && reviewDiagnosis?.betterAlternatives?.length > 0) {
    const best = reviewDiagnosis.betterAlternatives[0];
    logger.info(`[cli.agent] validate_agent: rebuilding ${id} with ${best.name} — ${best.reason}`);
    try {
      const rebuildResult = await actionBuildAgent({ service: existing.service, cli: best.name, force: true });
      if (rebuildResult.ok) {
        rebuildTriggered = true;
        descriptorPatched = true;
        logger.info(`[cli.agent] validate_agent: rebuilt ${id} with ${best.name}`);
      }
    } catch (rebuildErr) {
      logger.warn(`[cli.agent] validate_agent: rebuild with ${best.name} failed: ${rebuildErr.message}`);
    }
  }

  // ── Persist results ───────────────────────────────────────────────────────
  if (descriptorPatched && !rebuildTriggered) {
    const mdPath = path.join(AGENTS_DIR, `${id}.md`);
    fs.writeFileSync(mdPath, patchedDescriptor, 'utf8');
    await withDb(async (db) => {
      await db.run(
        `UPDATE agents SET descriptor = ?, status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?`,
        patchedDescriptor, finalStatus, failureLog, id
      );

      // Also write corrected meta back to cli_meta_cache so resolveCLIMeta
      // (which checks DuckDB first) picks up validate_agent corrections immediately.
      // Extract current known fields from the patched descriptor + review diagnosis.
      const serviceKey = (existing.service || id.replace('.agent', '')).toLowerCase().replace(/[^a-z0-9]/g, '');
      const cliLine    = patchedDescriptor.split('\n').find(l => l.startsWith('cli_tool:'));
      const correctedCli = cliLine ? cliLine.replace('cli_tool:', '').trim() : null;
      const seedEntry  = KNOWN_CLI_MAP[serviceKey] || {};
      const correctedMeta = {
        ...seedEntry,
        ...(correctedCli ? { cli: correctedCli } : {}),
        ...(reviewDiagnosis?.betterAlternatives?.[0] ? {
          cli:    reviewDiagnosis.betterAlternatives[0].name,
          method: reviewDiagnosis.betterAlternatives[0].installMethod || seedEntry.method || null,
          pkg:    reviewDiagnosis.betterAlternatives[0].pkg || seedEntry.pkg || null,
        } : {}),
      };
      try {
        await db.run(`
          CREATE TABLE IF NOT EXISTS cli_meta_cache (
            service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `).catch(() => {});
        await db.run(
          'INSERT OR REPLACE INTO cli_meta_cache (service, meta_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
          serviceKey, JSON.stringify(correctedMeta)
        );
        logger.info(`[cli.agent] validate_agent: wrote corrected meta to cli_meta_cache for ${serviceKey}`);
      } catch (cacheErr) {
        logger.warn(`[cli.agent] validate_agent: cli_meta_cache write failed: ${cacheErr.message}`);
      }
    });
  } else {
    await _updateAgentStatus(id, finalStatus, failureLog);
  }

  logger.info(`[cli.agent] validate_agent ${id} → health:${healthVerdict} review:${reviewVerdict} final:${finalStatus}`);

  return {
    ok: true,
    agentId: id,
    healthy: finalStatus === 'healthy',
    verdict: finalStatus,
    version: currentVersion,
    // Phase 1
    versionDrift:         healthDiagnosis.versionDrift || false,
    brokenCommands:       healthDiagnosis.brokenCommands || [],
    fixes:                healthDiagnosis.fixes || [],
    newCapabilities:      healthDiagnosis.newCapabilities || [],
    removedCapabilities:  healthDiagnosis.removedCapabilities || [],
    healthSummary:        healthDiagnosis.summary,
    // Phase 2
    reviewVerdict,
    routingCorrect:       reviewDiagnosis?.routingCorrect ?? true,
    routingIssues:        reviewDiagnosis?.routingIssues || [],
    betterAlternatives:   reviewDiagnosis?.betterAlternatives || [],
    missingCapabilities:  reviewDiagnosis?.missingCapabilities || [],
    pipelineGaps:         reviewDiagnosis?.pipelineGaps || [],
    setupStepsRequired:   reviewDiagnosis?.setupStepsRequired || [],
    skillCodeRisks:       reviewDiagnosis?.skillCodeRisks || [],
    reviewSummary:        reviewDiagnosis?.summary,
    // Phase 3
    compositionIssues,
    // Phase 4
    hasRuntimeFailures: !!existing.failure_log,
    // Meta
    probeResults,
    descriptorPatched,
    rebuildTriggered,
  };
}

function patchDescriptor(descriptor, { version, patch, newCaps, removedCaps }) {
  let lines = descriptor.split('\n');

  // Update version in front matter
  const vIdx = lines.findIndex(l => l.startsWith('version:'));
  if (vIdx >= 0) lines[vIdx] = `version: ${version}`;

  // Add new capabilities to front matter list
  if (newCaps.length > 0) {
    const capsStart = lines.findIndex(l => l.trim() === 'capabilities:');
    if (capsStart >= 0) {
      let insertAt = capsStart + 1;
      while (insertAt < lines.length && lines[insertAt].startsWith('  - ')) insertAt++;
      const newCapLines = newCaps.map(c => `  - ${c}`);
      lines.splice(insertAt, 0, ...newCapLines);
    }
  }

  // Remove deprecated capabilities
  if (removedCaps.length > 0) {
    lines = lines.filter(l => !removedCaps.some(c => l.trim() === `- ${c}`));
  }

  // Append patch to the end of ## Instructions section (before ## CLI Help Reference)
  if (patch) {
    const helpIdx = lines.findIndex(l => l.startsWith('## CLI Help Reference'));
    const patchLines = [``, `## Validator Notes (${new Date().toISOString().slice(0, 10)})`, patch];
    if (helpIdx >= 0) {
      lines.splice(helpIdx, 0, ...patchLines);
    } else {
      lines.push(...patchLines);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Action: record_failure — append a runtime error from recoverSkill to failure_log
// This is the live production feedback loop: real skill failures feed into the
// next validate_agent run so the LLM diagnoses real errors, not just version drift.
// ---------------------------------------------------------------------------

async function actionRecordFailure({ id, failureEntry }) {
  if (!id || !failureEntry) return { ok: false, error: 'id and failureEntry are required' };
  try {
    return await withDb(async (db) => {
      // Append to existing failure_log (keep last 5 entries, newest first)
      const row = await db.get('SELECT failure_log FROM agents WHERE id = ?', id);
      if (!row) return { ok: false, error: `Agent not found: ${id}` };
      const existing = row.failure_log || '';
      const entries = existing ? existing.split('\n---\n') : [];
      entries.unshift(failureEntry); // newest first
      const trimmed = entries.slice(0, 5).join('\n---\n');
      await db.run(
        'UPDATE agents SET failure_log = ?, status = CASE WHEN status = \'healthy\' THEN \'degraded\' ELSE status END WHERE id = ?',
        trimmed, id
      );
      logger.info(`[cli.agent] record_failure: appended runtime error for ${id}`);
      return { ok: true, agentId: id };
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Action: review_seed_map — LLM re-evaluates KNOWN_CLI_MAP for staleness
// Are brew package names still correct? Did CLIs get renamed or deprecated?
// Runs as part of nightly cron — separate from per-agent validate_agent.
// ---------------------------------------------------------------------------

const SEED_MAP_REVIEW_PROMPT = `You are ThinkDrop's CLI Seed Map Reviewer. Your job is to verify that the entries in a CLI service seed map are still accurate.

For each entry you receive, check:
1. Is the CLI tool name still correct and in active use?
2. Is the brew/npm install package name still accurate?
3. Has the CLI been renamed, deprecated, or superseded by a better tool?
4. Is the tokenCmd still the right command to get a usable auth token?
5. Are there widely-adopted new CLIs for services that currently have cli: null?

Output ONLY valid JSON:
{
  "staleEntries": [
    { "service": "<service key>", "issue": "<what is wrong>", "fix": "<exact corrected values as JSON patch>" }
  ],
  "missingClis": [
    { "service": "<service key>", "suggestedCli": "<cli name>", "installCmd": "<brew/npm install ...>", "reason": "<why this CLI should be used>" }
  ],
  "summary": "<one sentence overall assessment>"
}`;

// ---------------------------------------------------------------------------
// Action: preflight_check — detect CLIs needed for a task and check their status
//
// Called by planSkills BEFORE the LLM prompt is built. Gives the LLM accurate
// pre-flight context so it plans the right install/auth steps upfront instead of
// discovering missing tools mid-execution.
//
// Returns:
// {
//   ok: true,
//   brew: { installed: bool, path: string|null },
//   curl: { installed: bool, path: string|null },
//   detectedClis: [{ service, cli, installed, binPath, version, authed, authStatus, installMethod, installPkg, tokenCmd }],
//   summary: string  — compact one-liner for planSkills context injection
// }
// ---------------------------------------------------------------------------

// LLM-based service/CLI extraction — no static keyword map needed.
// The LLM knows about any service (Zapier, IFTTT, Airtable, Linear, Notion, etc.)
// and returns a list of { service, cli, installMethod, installPkg } objects.
const PREFLIGHT_EXTRACT_PROMPT = `You are a CLI pre-flight detector. Given a task description, identify every external service or CLI tool the task needs.

For each service found, output a JSON array of objects with these fields:
- service: lowercase identifier (e.g. "github", "zapier", "linear", "airtable", "docker")
- cli: the CLI tool name if one exists for this service, or null if API-key/OAuth only (e.g. "gh" for github, null for stripe)
- installMethod: "brew" | "npm" | "curl" | "direct" | null — how to install the CLI on macOS
- installPkg: the brew formula / npm package name / installer URL, or null
- isApiKey: true if the service uses API key auth (no CLI login flow), false otherwise
- isOAuth: true if the service uses OAuth browser login (no token CLI), false otherwise

Known examples:
- github → cli="gh", installMethod="brew", installPkg="gh"
- aws → cli="aws", installMethod="brew", installPkg="awscli"
- docker → cli="docker", installMethod="brew", installPkg="--cask docker"
- kubernetes/k8s → cli="kubectl", installMethod="brew", installPkg="kubectl"
- terraform → cli="terraform", installMethod="brew", installPkg="terraform"
- vercel → cli="vercel", installMethod="npm", installPkg="vercel"
- netlify → cli="netlify", installMethod="npm", installPkg="netlify-cli"
- heroku → cli="heroku", installMethod="brew", installPkg="heroku/brew/heroku"
- stripe → cli="stripe", installMethod="brew", installPkg="stripe/stripe-cli/stripe", isApiKey=true
- gcloud → cli="gcloud", installMethod="curl", installPkg="https://sdk.cloud.google.com"
- fly.io → cli="flyctl", installMethod="brew", installPkg="flyctl"
- doppler → cli="doppler", installMethod="brew", installPkg="dopplerhq/cli/doppler"
- supabase → cli="supabase", installMethod="brew", installPkg="supabase/tap/supabase"
- railway → cli="railway", installMethod="npm", installPkg="@railway/cli"
- shopify → cli="shopify", installMethod="npm", installPkg="@shopify/cli"
- wrangler/cloudflare → cli="wrangler", installMethod="npm", installPkg="wrangler"
- twilio → cli="twilio", installMethod="npm", installPkg="twilio-cli", isApiKey=true
- zapier → cli="zapier", installMethod="npm", installPkg="zapier-platform-cli"
- linear → cli=null, isApiKey=true (API only)
- airtable → cli=null, isApiKey=true (API only)
- notion → cli=null, isApiKey=true (API only)
- ifttt → cli=null, isOAuth=true (OAuth only)
- slack → cli=null, isApiKey=true (Bot token)
- gmail/google → cli=null, isOAuth=true
- openai → cli=null, isApiKey=true

If the task mentions no external services or CLIs (pure local shell/file tasks), return [].
Return ONLY a valid JSON array. No markdown, no explanation.`;

// Per-service identity resolution commands — returns the authenticated username/account.
// Keys must match KNOWN_CLI_MAP service keys. Each entry: { argv, extract(stdout) → string|null }
const IDENTITY_COMMANDS = {
  github:  { argv: ['api', 'user', '--jq', '.login'],                       extract: s => s.trim() || null },
  aws:     { argv: ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], extract: s => s.trim() || null },
  gcloud:  { argv: ['config', 'get-value', 'account'],                      extract: s => { const v = s.trim(); return v && !v.includes('(unset)') ? v : null; } },
  vercel:  { argv: ['whoami'],                                               extract: s => s.trim() || null },
  netlify: { argv: ['status', '--json'],                                     extract: s => { try { return JSON.parse(s).email || null; } catch { return s.trim().match(/Email:\s*(\S+)/)?.[1] || null; } } },
  fly:     { argv: ['auth', 'whoami'],                                       extract: s => s.trim() || null },
  heroku:  { argv: ['auth:whoami'],                                          extract: s => s.trim() || null },
  doctl:   { argv: ['account', 'get', '--format', 'Email', '--no-header'],   extract: s => s.trim() || null },
  supabase:{ argv: ['status'],                                               extract: s => s.trim().match(/(?:email|user):\s*(\S+)/i)?.[1] || null },
  railway: { argv: ['whoami'],                                               extract: s => s.trim() || null },
  wrangler:{ argv: ['whoami'],                                               extract: s => s.trim().match(/(\S+@\S+|\S+)/)?.[1] || null },
};

// ---------------------------------------------------------------------------
// checkCredentialFiles — checks for known credential/token file paths that
// indicate the CLI has been configured. Used as a final fallback when the
// verify command couldn't determine auth status (unknown/no_auth_check).
// Returns { found: true, path, size, mtime } or { found: false }.
// ---------------------------------------------------------------------------
function _expandCredPath(p, cliName) {
  const home = os.homedir();
  let resolved = p
    .replace(/^~/, home)
    .replace(/\{cli\}/g, cliName)
    // Windows env var expansion: %APPDATA%, %LOCALAPPDATA%, %USERPROFILE%
    .replace(/%APPDATA%/gi, process.env.APPDATA || '')
    .replace(/%LOCALAPPDATA%/gi, process.env.LOCALAPPDATA || '')
    .replace(/%USERPROFILE%/gi, process.env.USERPROFILE || home);
  return resolved;
}

const CRED_FILE_PATTERNS = [
  // gcalcli — OAuth token file (no .dat extension on modern installs)
  { cli: 'gcalcli', paths: [
    '~/Library/Application Support/gcalcli/oauth',
    '~/.config/gcalcli/oauth',
    '%APPDATA%\\gcalcli\\oauth',
    '%LOCALAPPDATA%\\gcalcli\\oauth',
    // Legacy/alternate names
    '~/.config/gcalcli/oauth.dat',
    '~/Library/Application Support/gcalcli/oauth.dat',
  ]},
  // gh
  { cli: 'gh', paths: [
    '~/.config/gh/hosts.yml',
    '~/Library/Application Support/gh/hosts.yml',
    '%APPDATA%\\gh\\hosts.yml',
  ]},
  // Generic patterns — checked for any CLI not matched above
  { cli: null, paths: [
    '~/.config/{cli}/credentials.json',
    '~/.config/{cli}/token.json',
    '~/.config/{cli}/.credentials',
    '~/.config/{cli}/auth.json',
    '~/.config/{cli}/oauth_token',
    '~/.{cli}/credentials',
    '~/.{cli}/.token',
    '~/.{cli}/config/credentials',
    '%APPDATA%\\{cli}\\credentials.json',
    '%APPDATA%\\{cli}\\token.json',
    '%LOCALAPPDATA%\\{cli}\\credentials.json',
  ]},
];

async function checkCredentialFiles(cliName) {
  for (const pattern of CRED_FILE_PATTERNS) {
    if (pattern.cli && pattern.cli !== cliName) continue;
    for (const p of pattern.paths) {
      const resolved = _expandCredPath(p, cliName);
      if (!resolved) continue;
      try {
        if (fs.existsSync(resolved)) {
          const stat = fs.statSync(resolved);
          if (stat.size > 0) {
            logger.info(`[cli.agent] checkCredentialFiles: ${cliName} credential file found at ${resolved} (${stat.size} bytes)`);
            return { found: true, path: resolved, size: stat.size, mtime: stat.mtime };
          }
        }
      } catch (_) {}
    }
  }
  return { found: false };
}

async function checkAuthStatus(binPath, tokenCmd, timeoutMs = 8000, serviceKey = null) {
  if (!binPath || !tokenCmd || tokenCmd.length === 0) {
    return { authed: null, authStatus: 'unknown', authUser: null };
  }
  const r = await spawnCapture(binPath, tokenCmd, { timeoutMs });
  const combined = (r.stdout + r.stderr).toLowerCase();

  // Auth-failure patterns — checked in BOTH exit 0 and non-zero cases to catch
  // CLIs that exit 0 with auth warnings, expired tokens, or partial setup states
  const AUTH_FAILURE_PATTERNS = /not logged in|not authenticated|unauthenticated|login required|run.*auth.*login|please login|please authenticate|no credentials|credentials expired|token expired|re-authenticate|access denied|permission denied|\b401\b|\b403\b|invalid_grant|invalid_token|expired|not configured|not authorized/i;

  if (r.ok) {
    // Check for auth-failure signals even when exit 0 (false-positive guard)
    if (AUTH_FAILURE_PATTERNS.test(combined)) {
      logger.info(`[cli.agent] checkAuthStatus: ${serviceKey || '?'} exit 0 but auth-failure pattern detected → not_authenticated`);
      return { authed: false, authStatus: 'not_authenticated', authUser: null };
    }
    const tokenLike = r.stdout.trim().length > 4;
    // Detect help/config text masquerading as valid output
    const isHelpText = /^usage:|--help|show this help/i.test(r.stdout.trim());
    if (isHelpText) {
      logger.info(`[cli.agent] checkAuthStatus: ${serviceKey || '?'} exit 0 but output is help text → unknown`);
      return { authed: null, authStatus: 'unknown', authUser: null };
    }
    // Resolve authenticated user identity if we have a service-specific command
    let authUser = null;
    if (tokenLike && serviceKey && IDENTITY_COMMANDS[serviceKey]) {
      try {
        const idCmd = IDENTITY_COMMANDS[serviceKey];
        const idR = await spawnCapture(binPath, idCmd.argv, { timeoutMs: 5000 });
        if (idR.ok) {
          authUser = idCmd.extract(idR.stdout);
          if (authUser) {
            logger.info(`[cli.agent] checkAuthStatus: ${serviceKey} identity resolved → "${authUser}"`);
          }
        }
      } catch (idErr) {
        logger.debug(`[cli.agent] checkAuthStatus: ${serviceKey} identity resolution failed: ${idErr.message}`);
      }
    }
    return { authed: tokenLike, authStatus: tokenLike ? 'authenticated' : 'no_token_returned', authUser };
  }
  // Non-zero exit
  if (AUTH_FAILURE_PATTERNS.test(combined)) {
    return { authed: false, authStatus: 'not_authenticated', authUser: null };
  }
  return { authed: null, authStatus: 'unknown', authUser: null };
}

// Parse a JSON array from a raw LLM string (handles markdown fences)
function parseJsonArray(raw) {
  if (!raw) return null;
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
  const start = text.indexOf('[');
  if (start === -1) return null;
  text = text.substring(start);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  try { return JSON.parse(end !== -1 ? text.substring(0, end + 1) : text); } catch { return null; }
}

async function actionPreflightCheck({ task, clis: explicitClis, agents: explicitAgents }) {
  // 1. Always check bootstrap tools: brew + curl (run in parallel with LLM detection)
  const bootstrapPromise = Promise.all([
    whichCli('brew'),
    whichCli('curl'),
  ]);

  // 2. Detect which services/CLIs are relevant to the task
  //    Priority: explicit agents > explicit list > LLM extraction + keyword fallback
  let llmExtracted = null;
  let agentSetupInfos = {}; // service → setupInfo from agent descriptors

  if (Array.isArray(explicitAgents) && explicitAgents.length > 0) {
    // Caller passed registered agent descriptors — build meta from them
    llmExtracted = explicitAgents.map(a => ({
      service:       (a.service || a.id || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
      cli:           a.cliTool || a.cli || null,
      installMethod: a.installMethod || null,
      installPkg:    a.installPkg || null,
      isApiKey:      a.isApiKey || false,
      isOAuth:       a.isOAuth || false,
      _agentId:      a.id || null,
      _setupInfo:    a.setupInfo || null,
    }));
    // Collect setupInfo per service
    for (const a of explicitAgents) {
      const svcKey = (a.service || a.id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (a.setupInfo) agentSetupInfos[svcKey] = a.setupInfo;
    }
  } else if (Array.isArray(explicitClis) && explicitClis.length > 0) {
    // Caller passed explicit service/CLI names — build minimal meta objects
    llmExtracted = explicitClis.map(c => ({
      service:       c.toLowerCase().replace(/[^a-z0-9]/g, ''),
      cli:           null,  // will resolve via KNOWN_CLI_MAP below
      installMethod: null,
      installPkg:    null,
      isApiKey:      false,
      isOAuth:       false,
    }));
  } else if (task) {
    // Use LLM to extract services — works for ANY service the LLM knows about
    try {
      let llmModule = null;
      try { llmModule = require('../skill-helpers/skill-llm.cjs'); } catch (_) {}

      if (llmModule?.ask) {
        const prompt = `${PREFLIGHT_EXTRACT_PROMPT}\n\nTask: "${task}"`;
        const raw = await llmModule.ask(prompt, { maxTokens: 400, temperature: 0.0, fastMode: true })
          .catch(() => null);
        if (raw) {
          const parsed = parseJsonArray(raw);
          if (Array.isArray(parsed)) {
            llmExtracted = parsed;
            logger.info(`[cli.agent] preflight_check: LLM detected ${parsed.length} service(s) — ${parsed.map(p => p.service).join(', ')}`);
          }
        }
      }
    } catch (llmErr) {
      logger.warn(`[cli.agent] preflight_check: LLM extraction failed — ${llmErr.message}`);
    }

    // Fallback: if LLM unavailable or returned an empty array, use KNOWN_CLI_MAP keyword matching.
    // An empty array from the LLM is NOT definitive — the LLM may miss services that
    // have registered CLI agents (e.g. gcalcli for Google Calendar). Always run keyword
    // fallback and merge any new services with the LLM result.
    if (!llmExtracted || (Array.isArray(llmExtracted) && llmExtracted.length === 0)) {
      const _llmServices = new Set(Array.isArray(llmExtracted) ? llmExtracted.map(e => e.service) : []);
      const taskLower = task.toLowerCase();
      const knownServices = Object.keys(KNOWN_CLI_MAP);
      const matchedSet = new Map();
      for (const svc of knownServices) {
        const meta = KNOWN_CLI_MAP[svc];
        if (taskLower.includes(svc)) {
          matchedSet.set(svc, meta);
          continue;
        }
        const keywords = Array.isArray(meta._keywords) ? meta._keywords : [];
        if (keywords.some(k => k && taskLower.includes(k.toLowerCase()))) {
          matchedSet.set(svc, meta);
        }
      }
      const matched = Array.from(matchedSet.keys()).filter(svc => !_llmServices.has(svc));
      const keywordResults = matched.map(svc => {
        const meta = KNOWN_CLI_MAP[svc];
        return {
          service:       svc,
          cli:           meta?.cli || null,
          installMethod: meta?.method || null,
          installPkg:    meta?.pkg || null,
          isApiKey:      meta?.isApiKey || false,
          isOAuth:       meta?.isOAuth  || false,
        };
      });
      if (matched.length > 0) {
        logger.info(`[cli.agent] preflight_check: keyword fallback matched ${matched.length} service(s) — ${matched.join(', ')}`);
      }
      // Merge: keep LLM results, add keyword-only services
      llmExtracted = [...(Array.isArray(llmExtracted) ? llmExtracted : []), ...keywordResults];
    }
  }

  const [brewPath, curlPath] = await bootstrapPromise;
  const brew = { installed: !!brewPath, path: brewPath };
  const curl = { installed: !!curlPath, path: curlPath };

  const servicesToCheck = llmExtracted || [];

  // 3. For each detected service, resolve meta + check CLI install + auth
  const detectedClis = [];

  await Promise.all(servicesToCheck.map(async (entry) => {
    const serviceKey = entry.service;

    // Merge LLM-extracted meta with KNOWN_CLI_MAP (KNOWN_CLI_MAP has tokenCmd etc.)
    const knownMeta = KNOWN_CLI_MAP[serviceKey] || {};
    const setupInfo = entry._setupInfo || agentSetupInfos[serviceKey] || knownMeta.setupInfo || null;
    const meta = {
      cli:           entry.cli  || knownMeta.cli  || null,
      method:        entry.installMethod || knownMeta.method || 'brew',
      pkg:           entry.installPkg   || knownMeta.pkg   || entry.cli || null,
      installUrl:    knownMeta.installUrl || null,
      tokenCmd:      knownMeta.tokenCmd || null,
      isApiKey:      entry.isApiKey ?? knownMeta.isApiKey ?? false,
      isOAuth:       entry.isOAuth  ?? knownMeta.isOAuth  ?? false,
      apiKeyEnvVar:  knownMeta.apiKeyEnvVar || null,
      apiKeyUrl:     knownMeta.apiKeyUrl   || null,
      setupInfo:     setupInfo,
    };

    const cliName = meta.cli;
    if (!cliName) {
      detectedClis.push({
        service:       serviceKey,
        cli:           null,
        installed:     null,
        binPath:       null,
        version:       null,
        authed:        null,
        authStatus:    meta.isOAuth ? 'oauth_required' : (meta.isApiKey ? 'api_key_required' : 'no_cli'),
        installMethod: null,
        installPkg:    null,
        tokenCmd:      null,
        apiKeyEnvVar:  meta.apiKeyEnvVar,
        apiKeyUrl:     meta.apiKeyUrl,
        isApiKey:      meta.isApiKey,
        isOAuth:       meta.isOAuth,
        agentId:       entry._agentId || null,
        setupInfo:     meta.setupInfo || null,
      });
      return;
    }

    const binPath = await whichCli(cliName);
    if (!binPath) {
      detectedClis.push({
        service:       serviceKey,
        cli:           cliName,
        installed:     false,
        binPath:       null,
        version:       null,
        authed:        false,
        authStatus:    'not_installed',
        installMethod: meta.method,
        installPkg:    meta.pkg,
        installUrl:    meta.installUrl || null,
        tokenCmd:      meta.tokenCmd,
        isApiKey:      meta.isApiKey,
        isOAuth:       meta.isOAuth,
        agentId:       entry._agentId || null,
        setupInfo:     meta.setupInfo || null,
      });
      return;
    }

    // CLI is installed — get version + check auth
    const versionResult = await spawnCapture(binPath, ['--version'], { timeoutMs: 6000 });
    const version = (versionResult.stdout || versionResult.stderr).split('\n')[0].trim() || null;

    // ── Layer 3: Determine effective token/verify command ──
    // If no tokenCmd from KNOWN_CLI_MAP, discover verifyCmd from --help early
    let _earlySetupInfo = null;
    if (!meta.tokenCmd) {
      try {
        _earlySetupInfo = await discoverSetupFromHelp(binPath, cliName);
      } catch (_) {}
    }
    const _effectiveTokenCmd = meta.tokenCmd || _earlySetupInfo?.verifyCmd || null;

    let authResult = _effectiveTokenCmd
      ? await checkAuthStatus(binPath, _effectiveTokenCmd, 8000, serviceKey)
      : { authed: null, authStatus: 'no_auth_check', authUser: null };

    // ── Layer 4: Credential file check fallback ──
    // If auth status is still unknown, check for credential files on disk
    if (authResult.authStatus === 'unknown' || authResult.authStatus === 'no_auth_check') {
      const credCheck = await checkCredentialFiles(cliName);
      if (credCheck.found) {
        authResult = { authed: true, authStatus: 'configured', authUser: null };
      }
    }

    // ── Proactive auto-auth: if not authenticated, attempt discoverAuthLoginCmd + run ──
    if (authResult.authStatus === 'not_authenticated') {
      try {
        const _authArgv = await discoverAuthLoginCmd(binPath, cliName);
        if (_authArgv) {
          logger.info(`[cli.agent] preflight_check: ${cliName} not authenticated — running auto-auth: ${_authArgv.join(' ')}`);
          const _autoAuthR = await spawnCapture(binPath, _authArgv, { timeoutMs: 180000 });
          if (_autoAuthR.exitCode === 0) {
            // Re-check auth after login using effective token/verify command
            authResult = _effectiveTokenCmd
              ? await checkAuthStatus(binPath, _effectiveTokenCmd, 8000, serviceKey)
              : { authed: true, authStatus: 'authenticated', authUser: null };
            logger.info(`[cli.agent] preflight_check: ${cliName} auto-auth succeeded — authStatus=${authResult.authStatus}`);
          } else {
            logger.warn(`[cli.agent] preflight_check: ${cliName} auto-auth failed (exit=${_autoAuthR.exitCode})`);
          }
        }
      } catch (_autoErr) {
        logger.warn(`[cli.agent] preflight_check: ${cliName} auto-auth error: ${_autoErr.message}`);
      }
    }

    // ── Discover setup info from --help when CLI is installed but not authenticated ──
    // Reuse _earlySetupInfo if already discovered above
    let _helpSetupInfo = _earlySetupInfo;
    let _finalSetupInfo = meta.setupInfo || null;
    let _finalAuthStatus = authResult.authStatus;
    if (authResult.authed !== true && authResult.authStatus !== 'authenticated' && authResult.authStatus !== 'configured') {
      if (!_helpSetupInfo) {
        try {
          _helpSetupInfo = await discoverSetupFromHelp(binPath, cliName);
        } catch (_helpErr) {
          logger.debug(`[cli.agent] preflight_check: ${cliName} discoverSetupFromHelp error: ${_helpErr.message}`);
        }
      }
      if (_helpSetupInfo) {
        // Merge: descriptor values take priority, --help fills missing fields
        _finalSetupInfo = { ...(_helpSetupInfo || {}), ...((meta.setupInfo || {})) };
        // Refine authStatus based on what --help revealed — only if we don't have a definitive status
        if (authResult.authStatus !== 'not_authenticated') {
          if (_helpSetupInfo.credentials?.includes('oauth')) {
            _finalAuthStatus = 'oauth_required';
          } else if (_helpSetupInfo.credentials?.includes('api_key')) {
            _finalAuthStatus = 'api_key_required';
          } else if (_helpSetupInfo.initCmd) {
            _finalAuthStatus = 'init_required';
          }
        }
      }
    } else if (_helpSetupInfo) {
      // Authenticated/configured — still merge setupInfo for setup guide display
      _finalSetupInfo = { ...(_helpSetupInfo || {}), ...((meta.setupInfo || {})) };
    }

    detectedClis.push({
      service:       serviceKey,
      cli:           cliName,
      installed:     true,
      binPath,
      version,
      authed:        authResult.authed,
      authStatus:    _finalAuthStatus,
      authUser:      authResult.authUser || null,
      installMethod: meta.method,
      installPkg:    meta.pkg,
      installUrl:    meta.installUrl || null,
      tokenCmd:      meta.tokenCmd,
      isApiKey:      meta.isApiKey,
      isOAuth:       meta.isOAuth,
      agentId:       entry._agentId || null,
      setupInfo:     _finalSetupInfo,
    });
  }));

  // 4. Build compact summary for planSkills context injection
  const brewNote = brew.installed ? `brew ✓` : `brew NOT INSTALLED (macOS: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)")`;
  const curlNote = curl.installed ? `curl ✓` : `curl NOT INSTALLED`;

  const cliNotes = detectedClis.map(c => {
    if (!c.cli) {
      if (c.isOAuth)   return `${c.service}: OAuth-based (no CLI) — browser setup required`;
      if (c.isApiKey)  return `${c.service}: API key required (${c.apiKeyEnvVar || 'check service settings'}) — no CLI`;
      return `${c.service}: no CLI available`;
    }
    if (!c.installed) {
      const installCmd = c.installMethod === 'npm'
        ? `npm install -g ${c.installPkg}`
        : `brew install ${c.installPkg || c.cli}`;
      return `${c.cli} (${c.service}): NOT INSTALLED — install with: ${installCmd}`;
    }
    if (c.authStatus === 'not_authenticated') {
      return `${c.cli} (${c.service}): installed (${c.version}) — NOT AUTHENTICATED`;
    }
    if (c.authStatus === 'authenticated') {
      const userNote = c.authUser ? ` as ${c.authUser}` : '';
      return `${c.cli} (${c.service}): installed (${c.version}) — authenticated${userNote} ✓`;
    }
    if (c.authStatus === 'configured') {
      return `${c.cli} (${c.service}): installed (${c.version}) — configured (credentials found) ✓`;
    }
    return `${c.cli} (${c.service}): installed (${c.version}) — auth unknown`;
  });

  const summary = [brewNote, curlNote, ...cliNotes].join(' | ');

  logger.info(`[cli.agent] preflight_check: ${detectedClis.length} CLI(s) detected — ${summary.slice(0, 200)}`);

  return {
    ok: true,
    brew,
    curl,
    detectedClis,
    summary,
  };
}

async function actionReviewSeedMap() {
  const entries = Object.entries(KNOWN_CLI_MAP).map(([svc, meta]) => ({
    service: svc,
    cli: meta.cli,
    method: meta.method,
    pkg: meta.pkg,
    tokenCmd: meta.tokenCmd,
    isOAuth: meta.isOAuth || false,
    isApiKey: meta.isApiKey || false,
  }));

  const query = `## Current KNOWN_CLI_MAP entries (${entries.length} services):\n${JSON.stringify(entries, null, 2)}`;
  const raw = await callLLM(SEED_MAP_REVIEW_PROMPT, query, { temperature: 0.15, maxTokens: 1600 });
  if (!raw) return { ok: true, staleEntries: [], missingClis: [], summary: 'LLM unavailable' };

  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, staleEntries: [], missingClis: [], summary: 'LLM returned unparseable response' };
    const result = JSON.parse(m[0]);
    logger.info(`[cli.agent] review_seed_map: ${result.staleEntries?.length || 0} stale, ${result.missingClis?.length || 0} missing CLIs`);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function _updateAgentStatus(id, status, failureNote) {
  await withDb(async (db) => {
    if (failureNote) {
      await db.run(
        'UPDATE agents SET status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, failureNote, id
      );
    } else {
      await db.run(
        'UPDATE agents SET status = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, id
      );
    }
  });
}


/**
 * Patch an existing agent descriptor in-place — update capabilities and/or descriptor text
 * without a full rebuild. Used to add capabilities (e.g. extract_transcript) post-build.
 */
async function actionPatchAgent({ id, capabilities, descriptor, status }) {
  if (!id) return { ok: false, error: 'id is required' };
  return await withDb(async (db) => {
    const rows = await db.all('SELECT id, capabilities, descriptor, status FROM agents WHERE id = ?', id).catch(() => null);
    if (!rows || rows.length === 0) return { ok: false, error: `Agent not found: ${id}` };

    const current = rows[0];
    let newCaps = current.capabilities || [];
    if (Array.isArray(capabilities) && capabilities.length > 0) {
      const capSet = new Set([...(Array.isArray(newCaps) ? newCaps : []), ...capabilities]);
      newCaps = [...capSet];
    }

    const newDescriptor = descriptor || current.descriptor;
    const newStatus = status || current.status;

    await db.run(
      'UPDATE agents SET capabilities = ?, descriptor = ?, status = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
      JSON.stringify(newCaps), newDescriptor, newStatus, id
    );

    logger.info(`[cli.agent] patch_agent: updated ${id}`);
    return { ok: true, id, capabilities: newCaps, status: newStatus };
  });
}


// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function cliAgent(args) {
  const { action } = args || {};

  logger.info('[cli.agent] invoked', { action });

  switch (action) {
    case 'discover':
      return await actionDiscover(args);

    case 'install':
      return await actionInstall(args);

    case 'run':
      return await actionRun(args);

    case 'build_agent':
      return await actionBuildAgent(args);

    case 'query_agent':
      return await actionQueryAgent(args);

    case 'list_agents':
      return await actionListAgents();

    case 'patch_agent':
      return await actionPatchAgent(args);

    case 'validate_agent':
      return await actionValidateAgent(args);

    case 'record_failure':
      return await actionRecordFailure(args);

    case 'review_seed_map':
      return await actionReviewSeedMap(args);

    case 'preflight_check':
      return await actionPreflightCheck(args);

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: discover | install | run | build_agent | patch_agent | query_agent | list_agents | validate_agent | record_failure | review_seed_map | preflight_check`,
      };
  }
}

module.exports = { cliAgent, KNOWN_CLI_MAP, actionListAllAgents, resetDbCache, discoverSetupFromHelp };

// ── One-shot startup migration: ensure ytdlp.agent has transcript capabilities ──
// Runs 5s after module load to allow DuckDB init. No-ops if already patched.
setTimeout(async () => {
  try {
    await withDb(async (db) => {
      const rows = await db.all("SELECT capabilities FROM agents WHERE id = 'ytdlp.agent'").catch(() => null);
      if (!rows || rows.length === 0) return;
      const caps = Array.isArray(rows[0].capabilities) ? rows[0].capabilities : [];
      if (caps.includes('extract_transcript')) return; // already patched
      await actionPatchAgent({
        id: 'ytdlp.agent',
        capabilities: ['extract_transcript', 'write_auto_subs', 'write_subs', 'list_subs'],
        descriptor: [
          '---',
          'id: ytdlp.agent',
          'type: cli',
          'service: ytdlp',
          'cli_tool: yt-dlp',
          'capabilities:',
        '  - update_tool', '  - ignore_errors', '  - list_extractors',
        '  - use_specific_extractors', '  - set_default_search_prefix',
        '  - output_to_file', '  - simulate_download', '  - force_ipv4',
        '  - set_user_agent', '  - limit_download_rate',
        '  - download_audio_only', '  - extract_audio',
        '  - extract_transcript', '  - write_auto_subs', '  - write_subs', '  - list_subs',
        'version: 2026.03.17',
        'pre_steps:',
        '  - skill: web.agent action: search_and_navigate purpose: resolve_url',
        '---',
        '',
        '## Instructions',
        'Use `yt-dlp` CLI for all ytdlp operations.',
        'Add `--js-runtimes node` to any command that fails with a JS runtime warning.',
        '',
        '## Key Capabilities & Flags',
        '| Capability | Exact Flag Syntax |',
        '|---|---|',
        '| update tool | `-U` |',
        '| ignore errors | `-i` |',
        '| list extractors | `--list-extractors` |',
        '| output to file | `-o TEMPLATE` |',
        '| simulate download | `-s` |',
        '| force ipv4 | `--force-ipv4` |',
        '| download audio only | `-x` |',
        '| extract audio | `--extract-audio` |',
        '| extract transcript/subtitles | `--write-auto-subs --sub-lang en --skip-download --convert-subs srt -o /tmp/transcript_%(id)s --js-runtimes node` |',
        '| list available subtitles | `--list-subs` |',
        '| write embedded subs | `--write-subs --sub-lang en` |',
        '',
        '## Usage Playbook',
        '',
        '| User Says | CLI Command |',
        '|-----------|-------------|',
        '| Extract audio from video | `yt-dlp <video> --extract-audio --js-runtimes node` |',
        '| Get transcript / subtitles | `yt-dlp <video> --write-auto-subs --sub-lang en --skip-download --convert-subs srt -o /tmp/transcript_%(id)s --js-runtimes node` |',
        '| Download video | `yt-dlp <video> --js-runtimes node` |',
        '',
        '## Natural Language Patterns',
        '- "get transcript from video"',
        '- "download subtitles for video"',
        '- "extract audio from video"',
        '- "download video"',
      ].join('\n'),
    });
    logger.info('[cli.agent] startup migration: ytdlp.agent patched with transcript capabilities');
    });
  } catch (e) {
    logger.warn(`[cli.agent] startup migration failed (non-fatal): ${e.message}`);
  }
}, 5000);
