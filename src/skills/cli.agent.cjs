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

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const AGENTS_DIR     = path.join(os.homedir(), '.thinkdrop', 'agents');
const DEFAULT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// DuckDB registry
// ---------------------------------------------------------------------------

let _db = null;

async function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  try {
    const duckdbAsync = require('duckdb-async');
    _db = await duckdbAsync.Database.create(AGENTS_DB_PATH);
  } catch {
    try {
      const { Database } = require('duckdb');
      const raw = await new Promise((resolve, reject) => {
        const db = new Database(AGENTS_DB_PATH, (err) => { if (err) reject(err); else resolve(db); });
      });
      _db = {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise((res) => raw.close(() => res())),
      };
    } catch { return null; }
  }
  await _db.run(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'cli', service TEXT NOT NULL,
    cli_tool TEXT, capabilities TEXT, descriptor TEXT, last_validated TIMESTAMP,
    failure_log TEXT, status TEXT NOT NULL DEFAULT 'healthy', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await _db.run(`CREATE TABLE IF NOT EXISTS cli_meta_cache (
    service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  return _db;
}


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
  fly:         { cli: 'fly',         method: 'brew', pkg: 'flyctl',                       tokenCmd: ['auth', 'token'] },
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
  pinecone:    { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://app.pinecone.io/organizations/-/projects/-/keys', apiKeyEnvVar: 'PINECONE_API_KEY' },
  cohere:      { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://dashboard.cohere.com/api-keys',              apiKeyEnvVar: 'COHERE_API_KEY' },
  huggingface: { cli: null, method: null, pkg: null, tokenCmd: null, isApiKey: true,  apiKeyUrl: 'https://huggingface.co/settings/tokens',             apiKeyEnvVar: 'HF_TOKEN' },
  google:      { cli: 'gcloud',      method: 'brew', pkg: 'google-cloud-sdk',             tokenCmd: ['auth', 'print-access-token'] },
};

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
  try {
    const db = await getDb();
    if (db) {
      const rows = await db.all(
        "SELECT meta_json FROM cli_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { return JSON.parse(rows[0].meta_json); } catch {}
      }
    }
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
    const db = await getDb();
    if (db) {
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
    }
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

  if (!cliName) return { ok: false, error: 'Cannot determine CLI name' };

  const alreadyAt = await whichCli(cliName);
  if (alreadyAt) return { ok: true, alreadyInstalled: true, cli: cliName, binPath: alreadyAt };

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
function buildTurnSystemPrompt(descriptor, learnedRules) {
  const DESCRIPTOR_LIMIT = 3000;
  const trimmedDescriptor = (descriptor || '(none)').slice(0, DESCRIPTOR_LIMIT);
  const rulesSection = (Array.isArray(learnedRules) && learnedRules.length > 0)
    ? '\n\n## Learned Command Rules (from past runs)\n' + learnedRules.map(r => `- ${r}`).join('\n')
    : '';
  return `${CLI_AGENTIC_LOOP_PROMPT}\n\n## Agent Descriptor\n${trimmedDescriptor}${rulesSection}`;
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

const CLI_AGENTIC_LOOP_PROMPT = `You are an expert CLI automation agent executing a user task step-by-step.
You have access to a CLI tool described in the Agent Descriptor below. The descriptor is the ONLY source of truth for what commands exist — do NOT invent or guess commands from training knowledge.
Each turn you output exactly ONE JSON action object from this palette:

  run_cmd    – execute CLI command:         { "action": "run_cmd", "argv": [...] }
  run_help   – read subcommand help:        { "action": "run_help", "subcmd": [...] }
  run_update – upgrade CLI to latest:       { "action": "run_update", "cli": "<name>" }
  web_search – search for docs/examples:   { "action": "web_search", "query": "..." }
  web_fetch  – read a docs/reference URL:  { "action": "web_fetch", "url": "..." }
  done       – task complete:              { "action": "done", "summary": "..." }
  ask_user   – need user clarification:    { "action": "ask_user", "question": "...", "options": [], "save_rule": "..." }  (save_rule optional — see Rules)

Rules:
- argv must NOT include the CLI binary name itself — only the subcommand and its arguments.
- ONLY use subcommands and flags explicitly listed in the Agent Descriptor. Do NOT guess or invent commands from training knowledge — the descriptor is authoritative.
- If the required subcommand is NOT in the descriptor, FIRST try run_help on the most likely escape-hatch subcommand (e.g. ["api"], ["call"], ["request"]) — it returns instant local docs in 1 turn. Only fall back to web_search if run_help output is insufficient or the operation is completely novel.
- web_search and web_fetch are your fallback sources when run_help is insufficient — prefer fresh docs over assumptions. If 2 consecutive web_search turns returned "no results", STOP searching — hard-pivot to web_fetch with the best official docs URL you know. Do NOT keep issuing web_search with variant queries.
- After run_cmd returns exitCode=0: if the task is fully complete (write/delete/star/follow — no output to process), output done. If the output needs further processing (decode base64, extract a URL or path, save content to a file), continue with the next action.
- Use run_help when you know the subcommand path but need exact flags or argument format. \`subcmd\` is the path WITHOUT the binary — e.g. \`["compose", "up"]\` fetches \`docker compose up --help\`. \`subcmd\` must contain at least one entry — never call run_help with an empty array (root-level help is already in the Agent Descriptor).
- Use run_update only when the CLI binary itself is confirmed missing or broken — never for unknown subcommands.
- Output JSON only. No prose before or after the JSON object.
- When you discover that a class of subcommands does NOT exist and there is a general escape-hatch alternative, write a BROAD save_rule that covers ALL similar operations — not just the one you just solved. The rule must include: (1) what pattern of operations has no dedicated subcommand, (2) the general escape-hatch command with syntax, (3) at least 3 examples covering different operation types so future runs never need to rediscover this pattern.
  Bad (too narrow): "'gh repo star' does not exist. Use: gh api --method PUT /user/starred/{owner}/{repo}."
  Good (broad): "Many 'gh' operations have no dedicated subcommand — use 'gh api --method GET/PUT/DELETE/POST <REST endpoint>' for all of them. Syntax: run_help [\"api\"] shows full flags. Examples: star=PUT /user/starred/{owner}/{repo}, unstar=DELETE /user/starred/{owner}/{repo}, readme=GET /repos/{owner}/{repo}/readme, releases=GET /repos/{owner}/{repo}/releases, follow_user=PUT /user/following/{username}."

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
- Never use ask_user for CLI version or installation issues — use run_update instead.`;

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
    const db = await getDb();
    if (!db) return { ok: false, error: 'DuckDB not available for agentic run' };

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

    // ── Meta-task safety net: "rebuild/refresh/recreate/reset [X] agent" ──
    // These are agent-management commands, not CLI tasks — route to build_agent.
    if (/\b(rebuild|recreate|refresh|reset|reinitializ[e]?|re-?build|re-?create)\b/i.test(task) &&
        /\bagent\b/i.test(task)) {
      const service = (agent.service || cliTool || agentId.replace(/\.agent$/i, ''));
      logger.info(`[cli.agent] run: meta-task detected ("${task}") — redirecting to build_agent for service "${service}"`);
      return await actionBuildAgent({ service, force: true });
    }

    // ── Multi-turn agentic loop ──
    const MAX_TURNS = 8;
    const OBSERVATION_CHARS = 600;
    const loopHistory = [];
    const transcript = [];
    let currentBinPath = binPath;
    let loopMeta = null; // lazy-loaded on first run_update

    // Load per-agent learned rules (saved by past ask_user save_rule events).
    // Falls back to [] silently if user-memory service is unavailable.
    const skillDb = require('../skill-helpers/skill-db.cjs');
    const learnedRules = await skillDb.getContextRules('cli_agent:' + agentId).catch(() => []);
    if (learnedRules.length > 0) {
      logger.info(`[cli.agent] loaded ${learnedRules.length} learned rule(s) for ${agentId}`, { agentId });
    }

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // ── Real-time turn progress → Electron overlay server ──────────────────
      // POST turn info to the overlay /agent-turn endpoint so the UI can show
      // "Turn N/M" in the heartbeat label before the full response arrives.
      if (_progressCallbackUrl) {
        const _turnPayload = JSON.stringify({ type: 'agent:turn_live', agentId, turn, maxTurns: MAX_TURNS, stepIndex: _stepIndex ?? 0 });
        const http = require('http');
        const _req = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_turnPayload) }, timeout: 2000 });
        _req.on('error', () => {}); // fire-and-forget
        _req.write(_turnPayload);
        _req.end();
      }

      const turnSys  = buildTurnSystemPrompt(agent.descriptor, learnedRules);
      const turnUser = buildTurnPrompt(task, loopHistory);
      logger.info(`[cli.agent] loop turn=${turn} syschars=${turnSys.length} userchars=${turnUser.length}`, { agentId, task });

      const llmRaw = await callLLM(turnSys, turnUser, { temperature: 0.1, maxTokens: 400 });

      logger.info(`[cli.agent] loop turn=${turn} llmRaw=${llmRaw === null ? 'NULL' : `"${(llmRaw || '').slice(0, 300)}"`}`, { agentId });

      let action = null;
      if (llmRaw) {
        try {
          // Greedy match — finds outermost { ... } even with nested braces
          const m = llmRaw.match(/\{[\s\S]*\}/);
          if (m) action = JSON.parse(m[0]);
        } catch (parseErr) {
          logger.warn(`[cli.agent] loop turn=${turn} JSON parse failed: ${parseErr.message}`, { agentId });
        }
      }

      if (!action || !action.action) {
        logger.warn(`[cli.agent] loop turn=${turn} parse_error — no valid action in LLM output`, { agentId });
        loopHistory.push({ turn, action: 'parse_error', observation: `LLM output: ${(llmRaw || 'NULL').slice(0, 200)}` });
        continue;
      }

      logger.info(`[cli.agent] loop turn=${turn} action=${action.action}`, { agentId, task });

      if (action.action === 'done') {
        transcript.push({ turn, action, outcome: { ok: true, result: action.summary || '' }, thoughts: null });
        return { ok: true, agentId, task, stdout: action.summary || '', agentTurns: turn, transcript };
      }

      if (action.action === 'ask_user') {
        // Persist any discovered command-mapping rule so future runs skip the discovery turns.
        // Saved regardless of user's Yes/No — the CLI docs truth is independent of the user's choice.
        if (action.save_rule && typeof action.save_rule === 'string' && action.save_rule.trim()) {
          skillDb.setContextRule('cli_agent:' + agentId, action.save_rule.trim(), 'cli_agent').catch(() => {});
          logger.info(`[cli.agent] saved learned rule for ${agentId}: "${action.save_rule.slice(0, 120)}"`, { agentId });
        }
        // Do NOT push to transcript — ask_user is a terminal escalation, not an executed step.
        // Showing it as a turn bubble would duplicate the question text that the UI card already displays.
        return { ok: false, agentId, task, askUser: true, question: action.question || '', options: action.options || [], agentTurns: turn, transcript, savedRule: (action.save_rule || '').trim() || null };
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
          transcript.push({ turn, action, outcome: { ok: true, result: cmdResult.stdout.slice(0, 300) }, thoughts: null });
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
          transcript.push({ turn, action, outcome: { ok: true, result: cmdResult.stdout.slice(0, 300) }, thoughts: null });
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
          if (/unknown command/i.test(cmdResult.stderr || '')) {
            const argv = action.argv || [];
            const subcmdPath = argv
              .slice(0, 3) // depth cap — avoid absurdly nested CLIs (e.g. gcloud)
              .filter(a => !a.startsWith('-') && !/[/\\]/.test(a) && !/^[A-Z_]+=/.test(a));
            if (subcmdPath.length > 0) {
              const helpLabel = subcmdPath.join(' ');
              const helpR = await spawnCapture(currentBinPath, [...subcmdPath, '--help'], { timeoutMs: 4000 });
              const helpText = (helpR.stdout || helpR.stderr || '').slice(0, OBSERVATION_CHARS);
              observation = `exitCode=${cmdResult.exitCode} stderr="${(cmdResult.stderr || '').slice(0, 200)}"\n[auto-fetched help for "${helpLabel}"]:\n${helpText}`;
            } else {
              observation = `exitCode=${cmdResult.exitCode} stdout="${cmdResult.stdout.slice(0, 300)}" stderr="${(cmdResult.stderr || '').slice(0, 200)}"`;
            }
          } else {
            observation = `exitCode=${cmdResult.exitCode} stdout="${cmdResult.stdout.slice(0, 300)}" stderr="${(cmdResult.stderr || '').slice(0, 200)}"`;
          }
        }

      } else if (action.action === 'run_help') {
        const helpR = await spawnCapture(currentBinPath, [...(action.subcmd || []), '--help'], { timeoutMs: 4000 });
        observation = (helpR.stdout || helpR.stderr || '').slice(0, OBSERVATION_CHARS);

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
              transcript.push({ turn, action, outcome: { ok: true, result: retryR.stdout.slice(0, 300) }, thoughts: null });
              return { ok: true, agentId, task, inferredArgv: lastCmd.argv, stdout: retryR.stdout, stderr: retryR.stderr, exitCode: retryR.exitCode, agentTurns: turn, transcript };
            }
            if (retryR.exitCode === -1) {
              observation = `run_update ok; retry exitCode=-1 (TIMED OUT — command was killed before completing). Do NOT call done. Try a faster alternative approach.`;
            } else if (retryR.exitCode === 0) {
              transcript.push({ turn, action, outcome: { ok: true, result: retryR.stdout.slice(0, 300) }, thoughts: null });
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

      } else {
        observation = `unknown action: ${action.action}`;
      }

      loopHistory.push({ turn, ...action, observation: observation.slice(0, OBSERVATION_CHARS) });
      transcript.push({ turn, action, outcome: { ok: false, error: observation.slice(0, 300) }, thoughts: null });
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

function buildDescriptorMd({ id, service, cliName, version, capabilities, helpText, subcommandMap }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  const parts = [
    '---',
    `id: ${id}`,
    `type: cli`,
    `service: ${service}`,
    `cli_tool: ${cliName}`,
    `capabilities:`,
    capYaml,
    `version: ${version || 'unknown'}`,
    '---',
    '',
    `## Instructions`,
    `Use \`${cliName}\` CLI for all ${service} operations.`,
    `Authentication is persistent after the first \`${cliName} auth login\` (or equivalent).`,
    `Always use \`${cliName} --help\` for the latest flag syntax before running unfamiliar commands.`,
    '',
    `## CLI Help Reference`,
    '```',
    (helpText || '').slice(0, 2000),
    '```',
  ];

  // Append subcommand reference when available
  if (subcommandMap && Object.keys(subcommandMap).length > 0) {
    parts.push('', '## Subcommand Reference');
    for (const [subcmd, detail] of Object.entries(subcommandMap)) {
      parts.push(`### ${subcmd}`);
      if (detail) parts.push((String(detail)).slice(0, 350));
    }
  }

  return parts.join('\n');
}

async function _buildApiKeyAgentDescriptor({ service, serviceKey, agentId, meta, force = false }) {
  // Check registry
  if (!force) {
    const db = await getDb();
    if (db) {
      const rows = await db.all('SELECT id, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update') {
        return { ok: true, agentId, alreadyExists: true, status: rows[0].status, isApiKey: true };
      }
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

  const db = await getDb();
  if (db) {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'api_key', ?, NULL, ?, ?, CURRENT_TIMESTAMP, 'healthy', CURRENT_TIMESTAMP)`,
      agentId, serviceKey, JSON.stringify(capabilities), descriptor
    );
  }

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
    const db = await getDb();
    if (db) {
      const rows = await db.all('SELECT id, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update') {
        return { ok: true, agentId, alreadyExists: true, status: rows[0].status };
      }
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

  const capabilities = inferCapabilities(discovery.help || '', meta);
  const descriptor   = buildDescriptorMd({
    id: agentId,
    service: serviceKey,
    cliName,
    version: discovery.version,
    capabilities,
    helpText: discovery.help,
    subcommandMap: discovery.subcommandMap,
  });

  // Write .md file to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  const db = await getDb();
  if (db) {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'cli', ?, ?, ?, ?, CURRENT_TIMESTAMP, 'healthy', CURRENT_TIMESTAMP)`,
      agentId,
      serviceKey,
      cliName,
      JSON.stringify(capabilities),
      descriptor
    );
  }

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

  const db = await getDb();
  if (!db) {
    // Fallback: read from .md file on disk
    const agentId  = id || `${(service || '').toLowerCase().replace(/[^a-z0-9]/g, '')}.agent`;
    const mdPath   = path.join(AGENTS_DIR, `${agentId}.md`);
    if (!fs.existsSync(mdPath)) return { ok: true, found: false, agentId };
    return { ok: true, found: true, agentId, descriptor: fs.readFileSync(mdPath, 'utf8') };
  }

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
    status: row.status,
    lastValidated: row.last_validated,
    descriptor: row.descriptor,
  };
}

// ---------------------------------------------------------------------------
// Action: list_agents
// ---------------------------------------------------------------------------

async function actionListAgents() {
  const db = await getDb();
  if (!db) {
    if (!fs.existsSync(AGENTS_DIR)) return { ok: true, agents: [] };
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
    return { ok: true, agents: files.map(f => ({ id: f.replace('.md', ''), type: 'cli' })) };
  }

  const rows = await db.all("SELECT id, type, service, cli_tool, capabilities, status, last_validated FROM agents ORDER BY created_at DESC");
  return {
    ok: true,
    agents: (rows || []).map(r => ({
      id: r.id,
      type: r.type,
      service: r.service,
      cliTool: r.cli_tool,
      capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
      status: r.status,
      lastValidated: r.last_validated,
    })),
  };
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
    const db = await getDb();
    if (db) {
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
    }
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
  const db = await getDb();
  if (!db) return { ok: false, error: 'DB unavailable' };
  try {
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

async function checkAuthStatus(binPath, tokenCmd, timeoutMs = 8000) {
  if (!binPath || !tokenCmd || tokenCmd.length === 0) {
    return { authed: null, authStatus: 'unknown' };
  }
  const r = await spawnCapture(binPath, tokenCmd, { timeoutMs });
  // A non-zero exit with "not logged in" / "unauthenticated" = clearly not authed
  // A non-zero exit for other reasons (network, etc.) = unknown
  const combined = (r.stdout + r.stderr).toLowerCase();
  if (r.ok) {
    const tokenLike = r.stdout.trim().length > 4;
    return { authed: tokenLike, authStatus: tokenLike ? 'authenticated' : 'no_token_returned' };
  }
  if (/not logged in|not authenticated|unauthenticated|login required|run.*auth.*login|please login|please authenticate|no credentials/i.test(combined)) {
    return { authed: false, authStatus: 'not_authenticated' };
  }
  return { authed: null, authStatus: 'unknown' };
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

async function actionPreflightCheck({ task, clis: explicitClis }) {
  // 1. Always check bootstrap tools: brew + curl (run in parallel with LLM detection)
  const bootstrapPromise = Promise.all([
    whichCli('brew'),
    whichCli('curl'),
  ]);

  // 2. Detect which services/CLIs are relevant to the task
  //    Priority: explicit list > LLM extraction > KNOWN_CLI_MAP keyword fallback
  let llmExtracted = null;

  if (Array.isArray(explicitClis) && explicitClis.length > 0) {
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

    // Fallback: if LLM unavailable or returned nothing, use KNOWN_CLI_MAP keyword matching
    if (!llmExtracted) {
      const taskLower = task.toLowerCase();
      const knownServices = Object.keys(KNOWN_CLI_MAP);
      const matched = knownServices.filter(svc => taskLower.includes(svc));
      llmExtracted = matched.map(svc => ({
        service:       svc,
        cli:           KNOWN_CLI_MAP[svc]?.cli || null,
        installMethod: KNOWN_CLI_MAP[svc]?.method || null,
        installPkg:    KNOWN_CLI_MAP[svc]?.pkg || null,
        isApiKey:      KNOWN_CLI_MAP[svc]?.isApiKey || false,
        isOAuth:       KNOWN_CLI_MAP[svc]?.isOAuth  || false,
      }));
      if (matched.length > 0) {
        logger.info(`[cli.agent] preflight_check: keyword fallback matched ${matched.length} service(s)`);
      }
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
    const meta = {
      cli:           entry.cli  || knownMeta.cli  || null,
      method:        entry.installMethod || knownMeta.method || 'brew',
      pkg:           entry.installPkg   || knownMeta.pkg   || entry.cli || null,
      tokenCmd:      knownMeta.tokenCmd || null,
      isApiKey:      entry.isApiKey ?? knownMeta.isApiKey ?? false,
      isOAuth:       entry.isOAuth  ?? knownMeta.isOAuth  ?? false,
      apiKeyEnvVar:  knownMeta.apiKeyEnvVar || null,
      apiKeyUrl:     knownMeta.apiKeyUrl   || null,
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
        tokenCmd:      meta.tokenCmd,
        isApiKey:      meta.isApiKey,
        isOAuth:       meta.isOAuth,
      });
      return;
    }

    // CLI is installed — get version + check auth
    const versionResult = await spawnCapture(binPath, ['--version'], { timeoutMs: 6000 });
    const version = (versionResult.stdout || versionResult.stderr).split('\n')[0].trim() || null;

    const authResult = meta.tokenCmd
      ? await checkAuthStatus(binPath, meta.tokenCmd, 8000)
      : { authed: null, authStatus: 'no_auth_check' };

    detectedClis.push({
      service:       serviceKey,
      cli:           cliName,
      installed:     true,
      binPath,
      version,
      authed:        authResult.authed,
      authStatus:    authResult.authStatus,
      installMethod: meta.method,
      installPkg:    meta.pkg,
      tokenCmd:      meta.tokenCmd,
      isApiKey:      meta.isApiKey,
      isOAuth:       meta.isOAuth,
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
      return `${c.cli} (${c.service}): installed (${c.version}) — authenticated ✓`;
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
  const db = await getDb();
  if (!db) return;
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
        error: `Unknown action: "${action}". Valid: discover | install | run | build_agent | query_agent | list_agents | validate_agent | record_failure | review_seed_map | preflight_check`,
      };
  }
}

module.exports = { cliAgent, KNOWN_CLI_MAP };
