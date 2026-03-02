'use strict';

/**
 * skill: browser.agent
 *
 * Factory skill that discovers, builds, and manages Playwright-backed narrow agents.
 * Each generated agent is stored as a structured .md descriptor in DuckDB at
 * ~/.thinkdrop/agents.db and as a .md file under ~/.thinkdrop/agents/.
 *
 * These agents are purpose-built for specific web services (slack.agent,
 * discord.agent, notion.agent, etc.) that have no CLI. They understand the
 * DOM layout and navigation patterns of their target service.
 *
 * Actions:
 *   build_agent    { service, startUrl?, force? } → generates .md descriptor,
 *                                                    stores in DuckDB
 *   query_agent    { service?, id? }              → retrieves agent descriptor
 *   list_agents    {}                             → all browser agents in registry
 *   validate_agent { id }                         → checks if service URL is reachable,
 *                                                    updates status
 *   run            { agentId, task, context? }    → executes a task using the agent's
 *                                                    descriptor as LLM context + browser.act
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');
const logger = require('../logger.cjs');

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const AGENTS_DIR     = path.join(os.homedir(), '.thinkdrop', 'agents');
const BROWSER_ACT_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

// ---------------------------------------------------------------------------
// DuckDB registry (shared with cli.agent)
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
// Known browser-only services map
// ---------------------------------------------------------------------------

const KNOWN_BROWSER_SERVICES = {
  slack:     { startUrl: 'https://app.slack.com',                   authSuccessPattern: 'app.slack.com/client',    capabilities: ['send_message', 'read_messages', 'manage_channels'] },
  discord:   { startUrl: 'https://discord.com/channels/@me',         authSuccessPattern: 'discord.com/channels',    capabilities: ['send_message', 'read_messages', 'manage_servers'] },
  notion:    { startUrl: 'https://www.notion.so',                    authSuccessPattern: 'notion.so/',              capabilities: ['create_page', 'read_page', 'manage_databases'] },
  figma:     { startUrl: 'https://www.figma.com',                    authSuccessPattern: 'figma.com/files',         capabilities: ['read_files', 'manage_projects'] },
  linear:    { startUrl: 'https://linear.app',                       authSuccessPattern: 'linear.app/',             capabilities: ['create_issue', 'list_issues', 'manage_projects'] },
  jira:      { startUrl: 'https://id.atlassian.com',                 authSuccessPattern: 'atlassian.net',           capabilities: ['create_issue', 'list_issues', 'manage_sprints'] },
  confluence:{ startUrl: 'https://id.atlassian.com',                 authSuccessPattern: 'atlassian.net/wiki',      capabilities: ['create_page', 'read_page', 'manage_spaces'] },
  airtable:  { startUrl: 'https://airtable.com',                     authSuccessPattern: 'airtable.com/',           capabilities: ['read_records', 'create_records', 'manage_bases'] },
  hubspot:   { startUrl: 'https://app.hubspot.com',                  authSuccessPattern: 'app.hubspot.com/',        capabilities: ['manage_contacts', 'manage_deals', 'send_email'] },
  salesforce:{ startUrl: 'https://login.salesforce.com',             authSuccessPattern: 'lightning.force.com',     capabilities: ['manage_leads', 'manage_opportunities', 'run_reports'] },
  twitter:   { startUrl: 'https://twitter.com',                      authSuccessPattern: 'twitter.com/home',        capabilities: ['post_tweet', 'read_timeline', 'manage_dms'] },
  facebook:  { startUrl: 'https://www.facebook.com',                 authSuccessPattern: 'facebook.com/',           capabilities: ['post_content', 'read_feed', 'manage_pages'] },
  instagram: { startUrl: 'https://www.instagram.com',                authSuccessPattern: 'instagram.com/',          capabilities: ['post_content', 'read_feed'] },
  linkedin:  { startUrl: 'https://www.linkedin.com',                 authSuccessPattern: 'linkedin.com/feed',       capabilities: ['post_content', 'manage_connections', 'read_messages'] },
  openai:    { startUrl: 'https://platform.openai.com/api-keys',     authSuccessPattern: 'platform.openai.com',     capabilities: ['get_api_key', 'manage_usage'] },
  sendgrid:  { startUrl: 'https://app.sendgrid.com/settings/api_keys', authSuccessPattern: 'app.sendgrid.com',     capabilities: ['get_api_key', 'send_email'] },
  mailgun:   { startUrl: 'https://app.mailgun.com/settings/api_security', authSuccessPattern: 'app.mailgun.com',   capabilities: ['get_api_key', 'send_email'] },
};

function lookupBrowserService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_BROWSER_SERVICES[key] || null;
}

// ---------------------------------------------------------------------------
// browser.act HTTP helper (calls the same command-service, avoids circular dep
// by using HTTP since we are already inside command-service process)
// ---------------------------------------------------------------------------

function callBrowserAct(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'browser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('browser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('browser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// ---------------------------------------------------------------------------
// Action: build_agent
// ---------------------------------------------------------------------------

function buildBrowserDescriptorMd({ id, service, startUrl, authSuccessPattern, capabilities }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  return [
    '---',
    `id: ${id}`,
    `type: browser`,
    `service: ${service}`,
    `start_url: ${startUrl}`,
    `auth_success_pattern: ${authSuccessPattern}`,
    `capabilities:`,
    capYaml,
    '---',
    '',
    `## Instructions`,
    `Use Playwright via browser.act skill for all ${service} operations.`,
    `Session is persistent — use profile: "${service}_agent" so the user logs in once.`,
    `Always start navigation from: ${startUrl}`,
    '',
    `## Auth`,
    `Use action:waitForAuth with url="${startUrl}" and authSuccessUrl="${authSuccessPattern}".`,
    `Once authenticated, the session is stored at ~/.thinkdrop/browser-sessions/${service}_agent/`,
    '',
    `## Navigation Patterns`,
    `After auth, use action:scanCurrentPage to observe the DOM before clicking or typing.`,
    `Use action:navigate to go to specific URLs within the service.`,
    `Use action:click with selector from scanCurrentPage elements.`,
    `Use action:type to fill in text fields.`,
    `Use action:evaluate to extract values from the DOM.`,
  ].join('\n');
}

async function actionBuildAgent({ service, startUrl: explicitUrl, force = false }) {
  if (!service) return { ok: false, error: 'service is required' };

  const serviceKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId    = `${serviceKey}.agent`;
  const meta       = lookupBrowserService(service);

  const startUrl          = explicitUrl || meta?.startUrl;
  const authSuccessPattern = meta?.authSuccessPattern || serviceKey;
  const capabilities      = meta?.capabilities || ['navigate', 'interact'];

  if (!startUrl) {
    return {
      ok: false,
      error: `No known start URL for service "${service}". Pass startUrl: explicitly.`,
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

  const descriptor = buildBrowserDescriptorMd({ id: agentId, service: serviceKey, startUrl, authSuccessPattern, capabilities });

  // Write .md to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  const db = await getDb();
  if (db) {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'browser', ?, NULL, ?, ?, CURRENT_TIMESTAMP, 'healthy', CURRENT_TIMESTAMP)`,
      agentId,
      serviceKey,
      JSON.stringify(capabilities),
      descriptor
    );
  }

  logger.info(`[browser.agent] built agent: ${agentId}`, { capabilities });
  return {
    ok: true,
    agentId,
    alreadyExists: false,
    service: serviceKey,
    startUrl,
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
    const agentId = id || `${(service || '').toLowerCase().replace(/[^a-z0-9]/g, '')}.agent`;
    const mdPath  = path.join(AGENTS_DIR, `${agentId}.md`);
    if (!fs.existsSync(mdPath)) return { ok: true, found: false, agentId };
    return { ok: true, found: true, agentId, descriptor: fs.readFileSync(mdPath, 'utf8') };
  }

  let rows;
  if (id) {
    rows = await db.all("SELECT * FROM agents WHERE id = ?", id);
  } else {
    const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    rows = await db.all("SELECT * FROM agents WHERE service = ? AND type = 'browser'", serviceKey);
  }

  if (!rows || rows.length === 0) return { ok: true, found: false };

  const row = rows[0];
  return {
    ok: true,
    found: true,
    agentId: row.id,
    service: row.service,
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
    return { ok: true, agents: files.map(f => ({ id: f.replace('.md', ''), type: 'browser' })) };
  }
  const rows = await db.all("SELECT id, type, service, capabilities, status, last_validated FROM agents WHERE type = 'browser' ORDER BY created_at DESC");
  return {
    ok: true,
    agents: (rows || []).map(r => ({
      id: r.id,
      type: r.type,
      service: r.service,
      capabilities: r.capabilities ? JSON.parse(r.capabilities) : [],
      status: r.status,
      lastValidated: r.last_validated,
    })),
  };
}

// ---------------------------------------------------------------------------
// Action: validate_agent — checks service URL reachability, updates status
// ---------------------------------------------------------------------------

async function actionValidateAgent({ id }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  // Extract start_url from descriptor
  const lines    = (existing.descriptor || '').split('\n');
  const urlLine  = lines.find(l => l.startsWith('start_url:'));
  const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : null;

  if (!startUrl) {
    await _updateStatus(id, 'needs_update', 'No start_url found in descriptor');
    return { ok: true, agentId: id, healthy: false, issue: 'missing_start_url' };
  }

  // Quick HTTP reachability check (HEAD request)
  const reachable = await new Promise(resolve => {
    const url = new URL(startUrl);
    const mod  = url.protocol === 'https:' ? require('https') : http;
    const req  = mod.request({ hostname: url.hostname, path: url.pathname, method: 'HEAD', timeout: 8000 }, res => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });

  if (!reachable) {
    await _updateStatus(id, 'needs_update', `Service URL not reachable: ${startUrl}`);
    return { ok: true, agentId: id, healthy: false, issue: 'url_unreachable', startUrl };
  }

  await _updateStatus(id, 'healthy', null);
  return { ok: true, agentId: id, healthy: true, startUrl };
}

async function _updateStatus(id, status, failureNote) {
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
// Action: run — executes a task using the agent's descriptor as context
// The agent descriptor is passed as system context; browser.act handles the
// actual Playwright interactions. This action returns structured guidance
// for the caller (typically planSkills/executeCommand) to act on.
// ---------------------------------------------------------------------------

async function actionRun({ agentId, task, context }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task)    return { ok: false, error: 'task is required' };

  const existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.` };
  }

  // Extract start_url and auth_success_pattern from descriptor front matter
  const lines              = (existing.descriptor || '').split('\n');
  const urlLine            = lines.find(l => l.startsWith('start_url:'));
  const authLine           = lines.find(l => l.startsWith('auth_success_pattern:'));
  const startUrl           = urlLine   ? urlLine.replace('start_url:', '').trim()            : null;
  const authSuccessPattern = authLine  ? authLine.replace('auth_success_pattern:', '').trim() : null;

  if (!startUrl) return { ok: false, error: 'Agent descriptor missing start_url' };

  const profile   = `${agentId.replace('.agent', '')}_agent`;
  const sessionId = `${agentId}_${Date.now()}`;

  logger.info(`[browser.agent] run agentId=${agentId} task="${task}"`);

  // Step 1: ensure auth session exists (persistent profile — login once)
  let authResult;
  try {
    authResult = await callBrowserAct({
      action: 'waitForAuth',
      sessionId,
      profile,
      url: startUrl,
      authSuccessUrl: authSuccessPattern,
      authTimeoutMs: 5 * 60 * 1000,
      timeoutMs: 15000,
    }, 6 * 60 * 1000);
  } catch (err) {
    return { ok: false, error: `waitForAuth failed: ${err.message}` };
  }

  if (!authResult?.ok) {
    return { ok: false, error: `Auth failed for ${agentId}: ${authResult?.error}` };
  }

  // Step 2: return agent descriptor + session info so the LLM/executeCommand
  // can compose the actual browser.act steps for this specific task
  return {
    ok: true,
    agentId,
    sessionId,
    profile,
    startUrl,
    task,
    authenticated: true,
    alreadyAuthenticated: authResult.alreadyAuthenticated,
    descriptor: existing.descriptor,
    capabilities: existing.capabilities,
    message: `Agent ${agentId} is ready. Session "${sessionId}" authenticated. Use browser.act with sessionId="${sessionId}" to execute task: "${task}".`,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function browserAgent(args) {
  const { action } = args || {};

  logger.info('[browser.agent] invoked', { action });

  switch (action) {
    case 'build_agent':
      return await actionBuildAgent(args);

    case 'query_agent':
      return await actionQueryAgent(args);

    case 'list_agents':
      return await actionListAgents();

    case 'validate_agent':
      return await actionValidateAgent(args);

    case 'run':
      return await actionRun(args);

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: build_agent | query_agent | list_agents | validate_agent | run`,
      };
  }
}

module.exports = { browserAgent, KNOWN_BROWSER_SERVICES };
