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
 *   run            { cli, argv, cwd?, env?,   → executes CLI, returns stdout/stderr
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
  let Database;
  try {
    ({ Database } = require('duckdb-async'));
  } catch {
    try { Database = require('duckdb').Database; } catch { return null; }
  }
  fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  _db = await Database.create(AGENTS_DB_PATH);
  await _db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL DEFAULT 'cli',
      service        TEXT NOT NULL,
      cli_tool       TEXT,
      capabilities   TEXT,
      descriptor     TEXT,
      last_validated TIMESTAMP,
      failure_log    TEXT,
      status         TEXT NOT NULL DEFAULT 'healthy',
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
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

const KNOWN_CLI_MAP = {
  github:    { cli: 'gh',        method: 'brew', pkg: 'gh',                        tokenCmd: ['auth', 'token'] },
  aws:       { cli: 'aws',       method: 'brew', pkg: 'awscli',                    tokenCmd: null },
  stripe:    { cli: 'stripe',    method: 'brew', pkg: 'stripe/stripe-cli/stripe',  tokenCmd: ['config', '--list'] },
  heroku:    { cli: 'heroku',    method: 'npm',  pkg: 'heroku',                    tokenCmd: ['auth:token'] },
  netlify:   { cli: 'netlify',   method: 'npm',  pkg: 'netlify-cli',               tokenCmd: ['status'] },
  vercel:    { cli: 'vercel',    method: 'npm',  pkg: 'vercel',                    tokenCmd: null },
  firebase:  { cli: 'firebase',  method: 'npm',  pkg: 'firebase-tools',            tokenCmd: ['login:ci'] },
  gcloud:    { cli: 'gcloud',    method: 'brew', pkg: 'google-cloud-sdk',          tokenCmd: ['auth', 'print-access-token'] },
  fly:       { cli: 'fly',       method: 'brew', pkg: 'flyctl',                    tokenCmd: ['auth', 'token'] },
  doctl:     { cli: 'doctl',     method: 'brew', pkg: 'doctl',                     tokenCmd: null },
  docker:    { cli: 'docker',    method: 'brew', pkg: 'docker',                    tokenCmd: null },
  twilio:    { cli: 'twilio',    method: 'npm',  pkg: 'twilio-cli',                tokenCmd: ['profiles:list'] },
  wrangler:  { cli: 'wrangler',  method: 'npm',  pkg: 'wrangler',                  tokenCmd: null },
  terraform: { cli: 'terraform', method: 'brew', pkg: 'terraform',                 tokenCmd: null },
  kubectl:   { cli: 'kubectl',   method: 'brew', pkg: 'kubernetes-cli',            tokenCmd: null },
};

function lookupService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_CLI_MAP[key] || null;
}


// ---------------------------------------------------------------------------
// Action: discover
// ---------------------------------------------------------------------------

async function actionDiscover({ cli }) {
  if (!cli) return { ok: false, error: 'cli is required' };
  const binPath = await whichCli(cli);
  if (!binPath) return { ok: true, installed: false, cli, binPath: null, version: null, help: null };

  const versionResult = await spawnCapture(binPath, ['--version'], { timeoutMs: 8000 });
  const helpResult    = await spawnCapture(binPath, ['--help'],    { timeoutMs: 8000 });

  return {
    ok: true,
    installed: true,
    cli,
    binPath,
    version: (versionResult.stdout || versionResult.stderr).split('\n')[0].trim() || null,
    help: (helpResult.stdout || helpResult.stderr).slice(0, 4000),
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
// Action: run
// ---------------------------------------------------------------------------

async function actionRun({ cli, argv = [], cwd, env, timeoutMs, stdin }) {
  if (!cli) return { ok: false, error: 'cli is required' };

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

function buildDescriptorMd({ id, service, cliName, version, capabilities, helpText }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  return [
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
    (helpText || '').slice(0, 3000),
    '```',
  ].join('\n');
}

async function actionBuildAgent({ service, cli: explicitCli, force = false }) {
  if (!service) return { ok: false, error: 'service is required' };

  const serviceKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId    = `${serviceKey}.agent`;
  const meta       = lookupService(service);
  const cliName    = explicitCli || meta?.cli;

  if (!cliName) {
    return {
      ok: false,
      error: `No known CLI for service "${service}". Pass cli: explicitly or add it to KNOWN_CLI_MAP.`,
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

  // Discover CLI
  const discovery = await actionDiscover({ cli: cliName });
  if (!discovery.installed) {
    return {
      ok: false,
      agentId,
      error: `CLI "${cliName}" is not installed. Use action:install to install it first.`,
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
// Action: validate_agent  — checks version drift, updates status in DB
// ---------------------------------------------------------------------------

async function actionValidateAgent({ id }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  const cliName   = existing.cliTool;
  const discovery = await actionDiscover({ cli: cliName });

  if (!discovery.installed) {
    await _updateAgentStatus(id, 'needs_update', `CLI ${cliName} no longer found at install path`);
    return { ok: true, agentId: id, healthy: false, issue: 'cli_not_found', cliTool: cliName };
  }

  // Compare version — extract first token from version string
  const descriptorLines = (existing.descriptor || '').split('\n');
  const versionLine = descriptorLines.find(l => l.startsWith('version:'));
  const storedVersion = versionLine ? versionLine.replace('version:', '').trim() : null;
  const currentVersion = discovery.version;

  const versionChanged = storedVersion && currentVersion && storedVersion !== currentVersion;

  if (versionChanged) {
    const failureNote = `Version changed: ${storedVersion} → ${currentVersion}. Re-run build_agent to update.`;
    await _updateAgentStatus(id, 'needs_update', failureNote);
    return { ok: true, agentId: id, healthy: false, issue: 'version_drift', storedVersion, currentVersion };
  }

  await _updateAgentStatus(id, 'healthy', null);
  return { ok: true, agentId: id, healthy: true, version: currentVersion };
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

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: discover | install | run | build_agent | query_agent | list_agents | validate_agent`,
      };
  }
}

module.exports = { cliAgent, KNOWN_CLI_MAP };
