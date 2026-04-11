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
  await _db.run(`CREATE TABLE IF NOT EXISTS browser_meta_cache (
    service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  return _db;
}


// ---------------------------------------------------------------------------
// Known browser-only services map
// ---------------------------------------------------------------------------

// Bootstrap seed map — cold-start anchors for first build_agent call before DuckDB has an entry.
// signInUrl here is a BUILD-TIME HINT: it's written into the descriptor's sign_in_url: frontmatter
// on first build so DuckDB immediately has the correct login form URL. After first build, DuckDB
// owns sign_in_url: and validate_agent can correct it. signInUrl here is never read at runtime
// (resolveBrowserMeta priorities: DuckDB descriptor → DuckDB meta cache → this seed map).
const KNOWN_BROWSER_SERVICES = {
  gmail:     { startUrl: 'https://mail.google.com',                       signInUrl: 'https://accounts.google.com/signin/v2/identifier', authSuccessPattern: 'mail.google.com',        capabilities: ['read_emails', 'send_email', 'manage_labels'],             isOAuth: true },
  google:    { startUrl: 'https://accounts.google.com',                   signInUrl: 'https://accounts.google.com/signin/v2/identifier', authSuccessPattern: 'myaccount.google.com',   capabilities: ['authenticate'],                                            isOAuth: true },
  slack:     { startUrl: 'https://app.slack.com',                         signInUrl: 'https://slack.com/signin',                         authSuccessPattern: 'app.slack.com/client',   capabilities: ['send_message', 'read_messages', 'manage_channels'] },
  discord:   { startUrl: 'https://discord.com/channels/@me',              signInUrl: 'https://discord.com/login',                        authSuccessPattern: 'discord.com/channels',   capabilities: ['send_message', 'read_messages', 'manage_servers'] },
  notion:    { startUrl: 'https://www.notion.so',                         signInUrl: 'https://www.notion.so/login',                      authSuccessPattern: 'notion.so/',             capabilities: ['create_page', 'read_page', 'manage_databases'] },
  figma:     { startUrl: 'https://www.figma.com',                         signInUrl: 'https://www.figma.com/login',                      authSuccessPattern: 'figma.com/files',        capabilities: ['read_files', 'manage_projects'] },
  linear:    { startUrl: 'https://linear.app',                            signInUrl: 'https://linear.app/login',                         authSuccessPattern: 'linear.app/',            capabilities: ['create_issue', 'list_issues', 'manage_projects'] },
  jira:      { startUrl: 'https://id.atlassian.com',                      signInUrl: 'https://id.atlassian.com/login',                   authSuccessPattern: 'atlassian.net',          capabilities: ['create_issue', 'list_issues', 'manage_sprints'] },
  confluence:{ startUrl: 'https://id.atlassian.com',                      signInUrl: 'https://id.atlassian.com/login',                   authSuccessPattern: 'atlassian.net/wiki',     capabilities: ['create_page', 'read_page', 'manage_spaces'] },
  airtable:  { startUrl: 'https://airtable.com',                          signInUrl: 'https://airtable.com/login',                       authSuccessPattern: 'airtable.com/',          capabilities: ['read_records', 'create_records', 'manage_bases'] },
  hubspot:   { startUrl: 'https://app.hubspot.com',                       signInUrl: 'https://app.hubspot.com/login',                    authSuccessPattern: 'app.hubspot.com/',       capabilities: ['manage_contacts', 'manage_deals', 'send_email'] },
  salesforce:{ startUrl: 'https://login.salesforce.com',                  signInUrl: 'https://login.salesforce.com',                     authSuccessPattern: 'lightning.force.com',    capabilities: ['manage_leads', 'manage_opportunities', 'run_reports'] },
  twitter:   { startUrl: 'https://twitter.com',                           signInUrl: 'https://twitter.com/i/flow/login',                 authSuccessPattern: 'twitter.com/home',       capabilities: ['post_tweet', 'read_timeline', 'manage_dms'] },
  facebook:  { startUrl: 'https://www.facebook.com',                      signInUrl: 'https://www.facebook.com/login',                   authSuccessPattern: 'facebook.com/',          capabilities: ['post_content', 'read_feed', 'manage_pages'] },
  instagram: { startUrl: 'https://www.instagram.com',                     signInUrl: 'https://www.instagram.com/accounts/login',         authSuccessPattern: 'instagram.com/',         capabilities: ['post_content', 'read_feed'] },
  linkedin:  { startUrl: 'https://www.linkedin.com',                      signInUrl: 'https://www.linkedin.com/login',                   authSuccessPattern: 'linkedin.com/feed',      capabilities: ['post_content', 'manage_connections', 'read_messages'] },
  openai:    { startUrl: 'https://platform.openai.com/api-keys',          signInUrl: 'https://platform.openai.com/api-keys',             authSuccessPattern: 'platform.openai.com',    capabilities: ['get_api_key', 'manage_usage'] },
  sendgrid:  { startUrl: 'https://app.sendgrid.com/settings/api_keys',    signInUrl: 'https://app.sendgrid.com/settings/api_keys',       authSuccessPattern: 'app.sendgrid.com',       capabilities: ['get_api_key', 'send_email'] },
  mailgun:   { startUrl: 'https://app.mailgun.com/settings/api_security', signInUrl: 'https://app.mailgun.com/settings/api_security',    authSuccessPattern: 'app.mailgun.com',        capabilities: ['get_api_key', 'send_email'] },
};

function lookupBrowserService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return KNOWN_BROWSER_SERVICES[key] || null;
}

// ---------------------------------------------------------------------------
// LLM-driven browser service meta resolution — for services not in seed map.
// Result cached in DuckDB so LLM is called at most once per service.
// ---------------------------------------------------------------------------

const BROWSER_DISCOVERY_SYSTEM_PROMPT = `You are a web service knowledge base. Given a service/product name, return structured JSON describing how to interact with it via a browser.

Output ONLY valid JSON:
{
  "startUrl": "<full URL of the service home/dashboard after login>",
  "signInUrl": "<full URL of the actual login/sign-in form page — NOT the marketing homepage>",
  "authSuccessPattern": "<URL substring that appears after successful login>",
  "capabilities": ["<verb_noun capability 1>", "<verb_noun capability 2>"],
  "apiKeyUrl": "<URL of the API key settings page, or null if OAuth only>",
  "isOAuth": true | false,
  "notes": "<one sentence about auth>"
}

CRITICAL: signInUrl must be the actual sign-in form URL (e.g. accounts.google.com/signin for Gmail, not gmail.com which is the marketing page).`;

async function resolveBrowserMeta(service) {
  const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. DuckDB agent descriptor — highest priority (validate_agent writes corrections here).
  //    Extract startUrl and signInUrl from the stored descriptor frontmatter so any
  //    URL corrections validate_agent made are immediately visible to callers.
  try {
    const db = await getDb();
    if (db) {
      const rows = await db.all(
        'SELECT descriptor, capabilities FROM agents WHERE id = ?', `${seedKey}.agent`
      ).catch(() => null);
      if (rows && rows.length > 0 && rows[0].descriptor) {
        const desc = rows[0].descriptor;
        const startUrl  = extractDescriptorUrl(desc, 'start_url');
        const signInUrl = extractDescriptorUrl(desc, 'sign_in_url');
        const authSuccessPattern = extractDescriptorUrl(desc, 'auth_success_pattern');
        if (startUrl) {
          // Merge with seed map for fields not in descriptor (capabilities, isOAuth)
          const seed = KNOWN_BROWSER_SERVICES[seedKey] || {};
          return {
            ...seed,
            startUrl,
            signInUrl: signInUrl || seed.signInUrl || startUrl,
            authSuccessPattern: authSuccessPattern || seed.authSuccessPattern || seedKey,
          };
        }
      }
    }
  } catch {}

  // 2. DuckDB meta cache (LLM discovery result cached here for unknown services)
  try {
    const db = await getDb();
    if (db) {
      const rows = await db.all(
        "SELECT meta_json FROM browser_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { return JSON.parse(rows[0].meta_json); } catch {}
      }
    }
  } catch {}

  // 3. Seed map — bootstrap fallback only (cold-start before any agent has been built)
  const fromSeed = KNOWN_BROWSER_SERVICES[seedKey];
  if (fromSeed) return fromSeed;

  // 4. LLM discovery
  logger.info(`[browser.agent] resolveBrowserMeta: LLM lookup for "${service}"`);
  const raw = await callLLM(
    BROWSER_DISCOVERY_SYSTEM_PROMPT,
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

  if (!meta || !meta.startUrl) {
    meta = {
      startUrl: `https://${seedKey}.com`,
      authSuccessPattern: `${seedKey}.com`,
      capabilities: ['navigate', 'interact'],
      isOAuth: false,
    };
  }

  // 4. cache in DuckDB
  try {
    const db = await getDb();
    if (db) {
      await db.run(`
        CREATE TABLE IF NOT EXISTS browser_meta_cache (
          service     TEXT PRIMARY KEY,
          meta_json   TEXT NOT NULL,
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).catch(() => {});
      await db.run(
        "INSERT OR REPLACE INTO browser_meta_cache (service, meta_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        seedKey, JSON.stringify(meta)
      );
    }
  } catch {}

  return meta;
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

function buildBrowserDescriptorMd({ id, service, startUrl, signInUrl, authSuccessPattern, capabilities }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  // sign_in_url is the actual login form — distinct from start_url (the post-login dashboard).
  // validate_agent will correct it if wrong; scan_page and actionRun prefer it over start_url.
  const effectiveSignInUrl = signInUrl || startUrl;
  return [
    '---',
    `id: ${id}`,
    `type: browser`,
    `service: ${service}`,
    `start_url: ${startUrl}`,
    `sign_in_url: ${effectiveSignInUrl}`,
    `auth_success_pattern: ${authSuccessPattern}`,
    `capabilities:`,
    capYaml,
    '---',
    `# sign_in_url is the actual login form URL — validate_agent will correct this if wrong.`,
    `# start_url is the service home/dashboard (used after auth).`,
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

  // Resolve via LLM if not in seed map — never hard-fail on unknown service
  const meta = await resolveBrowserMeta(service);

  const startUrl           = explicitUrl || meta?.startUrl;
  const signInUrl          = meta?.signInUrl || null;
  const authSuccessPattern = meta?.authSuccessPattern || serviceKey;
  const capabilities       = meta?.capabilities || ['navigate', 'interact'];

  if (!startUrl) {
    return {
      ok: false,
      error: `Could not determine start URL for service "${service}". Pass startUrl: explicitly.`,
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

  const descriptor = buildBrowserDescriptorMd({ id: agentId, service: serviceKey, startUrl, signInUrl, authSuccessPattern, capabilities });

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
// Shared: lightweight LLM caller via the VSCode WebSocket backend (port 4000)
// ---------------------------------------------------------------------------

const LLM_WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
const LLM_API_KEY = process.env.VSCODE_API_KEY || '';

async function callLLM(systemPrompt, userQuery, { temperature = 0.2, maxTokens = 1400 } = {}) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return null; }

  const url = new URL(LLM_WS_URL);
  if (LLM_API_KEY) url.searchParams.set('apiKey', LLM_API_KEY);
  url.searchParams.set('userId', 'browser_agent_validator');
  url.searchParams.set('clientId', `browser_agent_${Date.now()}`);

  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url.toString()); } catch { return resolve(null); }

    let accumulated = '';
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
        metadata: { source: 'browser_agent_validator' },
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_chunk') { accumulated += (msg.payload?.text || msg.payload?.chunk || ''); }
        else if (msg.type === 'llm_stream_end') { clearTimeout(respTimeout); ws.close(); resolve(accumulated); }
        else if (msg.type === 'error') { clearTimeout(respTimeout); ws.close(); resolve(accumulated || null); }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
    ws.on('close', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
  });
}

// ---------------------------------------------------------------------------
// Action: validate_agent — LLM-powered DOM/flow change detection + auto-fix
// ---------------------------------------------------------------------------

// Phase 1: DOM health check — are selectors + auth flow still valid?
const BROWSER_VALIDATOR_SYSTEM_PROMPT = `You are ThinkDrop's Browser Agent Validator. Your job is to assess whether a browser agent descriptor is still accurate given the current live state of the page it navigates.

You will receive:
1. The agent's current descriptor (.md with navigation patterns, selectors, capabilities, auth flow)
2. A DOM snapshot of the current live page (title, URL, visible elements with selectors)
3. Any HTTP status / reachability info

Your analysis must cover:
- Do the documented navigation selectors still exist in the current DOM?
- Are any critical buttons, forms, or nav items missing or renamed?
- Did the page structure change significantly (e.g. redesign, new auth flow, modal dialogs)?
- Are there new navigation paths or features visible in the DOM that should be added to the descriptor?
- Are timing issues likely? (e.g. heavy SPAs, lazy-loaded elements that may need waitFor)
- Did the auth flow or login URL change?

Output ONLY valid JSON:
{
  "verdict": "healthy" | "degraded" | "needs_update",
  "missingSelectors": ["<selector from descriptor that is no longer in DOM>"],
  "changedSelectors": [{ "old": "<old selector>", "new": "<new selector or description of change>" }],
  "newElements": ["<new important element found in DOM not in descriptor>"],
  "authFlowChanged": true | false,
  "timingRisk": true | false,
  "timingAdvice": "<specific waitFor hint or null>",
  "fixes": ["<precise fix — exact new selector, updated navigation step, or updated auth URL>"],
  "updatedInstructionsPatch": "<updated ## Navigation Patterns section text, or null if no change>",
  "summary": "<one sentence overall assessment>"
}

IMPORTANT: Be conservative — only flag selectors as missing if they are clearly gone from the DOM snapshot. A selector not visible in a partial snapshot may just not be on this specific page. Focus on login pages, main nav, and primary action elements.`;

// Phase 2: pipeline review — is the descriptor complete and correct for every node that consumes it?
const BROWSER_PIPELINE_REVIEW_PROMPT = `You are ThinkDrop's Pipeline Review Agent. You perform a deep review of a browser agent descriptor — not just checking if selectors work, but whether the descriptor is COMPLETE and CORRECT for all the real-world cases the autonomous pipeline will encounter.

The ThinkDrop pipeline works like this:
- planSkills reads agent descriptors to decide if credentials/auth are already resolved
- buildSkill injects agent descriptors so generated skill code uses proven navigation patterns
- installSkill calls browser.agent to handle OAuth flows before prompting the user
- browser.agent routes services based on: isOAuth (needs OAuth flow) vs direct API key

You must reason as a senior engineer reviewing this descriptor. Ask yourself:

1. ROUTING CORRECTNESS
   - Is this service correctly handled by browser.agent, or does a CLI tool exist that would be better?
   - Example: if himalaya CLI exists for Gmail, browser.agent may be redundant for credential extraction
   - Is the auth flow described correctly (OAuth2 vs API key vs session cookie vs SSO)?

2. CAPABILITY COMPLETENESS
   - Do the listed capabilities match what skills will actually need?
   - Are common operations missing for this service?
   - Are capabilities listed that browser automation cannot reliably perform?

3. AUTH FLOW ACCURACY
   - Is the startUrl the correct entry point for auth?
   - Is authSuccessPattern reliable? (some SPAs never change URL after login)
   - Is session persistence documented? (does the session survive app restarts?)
   - Are there MFA/2FA flows not documented that will block automation?

4. SKILL CODE QUALITY RISK
   - If a skill is built using this descriptor, will the generated Playwright code be correct?
   - Are the navigation patterns precise enough? (exact selectors, wait conditions, timing)
   - Are error states documented (rate limits, session expiry, CAPTCHA, consent dialogs)?

5. PIPELINE GAPS
   - Is there anything installSkill will need to do that the descriptor doesn't explain?
   - Are there one-time setup steps (app registration, OAuth consent screen, permission grants)?
   - Are there platform-specific requirements (macOS only, requires specific browser profile)?

Output ONLY valid JSON:
{
  "routingCorrect": true | false,
  "routingIssues": ["<precise description and fix>"],
  "betterAlternative": { "type": "cli", "name": "<cli name>", "reason": "<why it is better>" } | null,
  "missingCapabilities": ["<capability missing>"],
  "incorrectCapabilities": ["<capability that cannot reliably be done via browser>"],
  "authFlowIssues": ["<problem with auth flow>"],
  "skillCodeRisks": ["<thing that will cause generated skill code to be wrong>"],
  "pipelineGaps": ["<gap the pipeline will hit but descriptor doesn't cover>"],
  "setupStepsRequired": ["<one-time setup step the user must complete>"],
  "correctedUrls": {
    "sign_in_url": "<corrected actual login form URL, or null if current is correct>",
    "start_url": "<corrected post-login dashboard URL, or null if current is correct>"
  } | null,
  "descriptorPatch": "<updated ## Auth or ## Navigation Patterns or ## Instructions section, or null>",
  "verdict": "complete" | "has_gaps" | "needs_rebuild",
  "summary": "<2-3 sentence assessment written like a senior engineer code review comment>"
}

CRITICAL: If the start_url in the descriptor is a marketing/landing page instead of the actual login form, set correctedUrls.sign_in_url to the real login URL. Example: Gmail descriptor start_url=https://mail.google.com is the dashboard, so sign_in_url should be https://accounts.google.com/signin/v2/identifier. Always correct this — scan_page and waitForAuth depend on sign_in_url being the actual form.`;

async function actionValidateAgent({ id, sessionId: explicitSession }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  const lines    = (existing.descriptor || '').split('\n');
  const urlLine  = lines.find(l => l.startsWith('start_url:'));
  const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : null;

  if (!startUrl) {
    await _updateStatus(id, 'needs_update', 'No start_url found in descriptor');
    return { ok: true, agentId: id, healthy: false, issue: 'missing_start_url' };
  }

  // Step 1: quick reachability probe (HEAD request)
  const reachable = await new Promise(resolve => {
    try {
      const parsed = new URL(startUrl);
      const mod    = parsed.protocol === 'https:' ? require('https') : http;
      const req    = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname || '/', method: 'HEAD', timeout: 8000 },
        res => resolve(res.statusCode < 500)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });

  if (!reachable) {
    const note = `Service URL not reachable: ${startUrl}`;
    await _updateStatus(id, 'needs_update', note);
    return { ok: true, agentId: id, healthy: false, verdict: 'needs_update', issue: 'url_unreachable', startUrl, summary: note };
  }

  // Step 2: use browser.act scanCurrentPage to get live DOM snapshot
  const profile   = `${id.replace('.agent', '')}_validator`;
  const sessionId = explicitSession || `${id}_validate_${Date.now()}`;
  let domSnapshot = null;

  try {
    const scanResult = await callBrowserAct({
      action: 'scanCurrentPage',
      sessionId,
      profile,
      url: startUrl,
      timeoutMs: 20000,
    }, 30000);

    if (scanResult?.ok !== false) {
      domSnapshot = {
        title:    scanResult?.title || '',
        url:      scanResult?.url || startUrl,
        elements: (scanResult?.elements || []).slice(0, 80),
      };
    }
  } catch (err) {
    logger.warn(`[browser.agent] validate_agent scanCurrentPage failed for ${id}: ${err.message}`);
  }

  // Step 3: build LLM query — descriptor + live DOM snapshot
  const elementsSummary = domSnapshot
    ? domSnapshot.elements.map(el =>
        `[${el.tag}${el.type ? ' type=' + el.type : ''}] label="${el.label || ''}" selector="${el.selector || ''}"${el.href ? ' href=' + el.href : ''}`
      ).join('\n')
    : '(DOM snapshot unavailable — only reachability was checked)';

  const userQuery = [
    `## Agent: ${id}`,
    `## Service start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 3000),
    '```',
    ``,
    `## Live DOM Snapshot`,
    `Page title: ${domSnapshot?.title || 'unknown'}`,
    `Current URL: ${domSnapshot?.url || startUrl}`,
    ``,
    `### Visible Elements (up to 80):`,
    elementsSummary,
  ].join('\n');

  // ── Phase 1: DOM health check — are selectors + auth flow still valid? ──────
  let healthDiagnosis = null;
  const healthRaw = await callLLM(BROWSER_VALIDATOR_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 1400 });
  if (healthRaw) {
    try {
      const m = healthRaw.match(/\{[\s\S]*\}/);
      if (m) healthDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent health parse failed for ${id}`);
    }
  }

  // Fallback if LLM unavailable
  if (!healthDiagnosis) {
    healthDiagnosis = {
      verdict: 'healthy', missingSelectors: [], changedSelectors: [],
      newElements: [], authFlowChanged: false, timingRisk: false,
      timingAdvice: null, fixes: [], updatedInstructionsPatch: null,
      summary: 'Service reachable (LLM validation unavailable)',
    };
  }

  // ── Phase 2: pipeline review — is the descriptor complete for the full pipeline? ─
  // Senior-engineer pass: routing correctness, missing capabilities, auth flow accuracy,
  // skill code risks, setup steps installSkill must surface to the user.
  let reviewDiagnosis = null;
  const reviewQuery = [
    `## Agent: ${id}  (service: ${existing.service || id.replace('.agent', '')})`,
    `## Type: browser`,
    `## start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 4000),
    '```',
    ``,
    `## Live page title: ${domSnapshot?.title || 'unknown'}`,
    `## Live page URL: ${domSnapshot?.url || startUrl}`,
  ].join('\n');

  const reviewRaw = await callLLM(BROWSER_PIPELINE_REVIEW_PROMPT, reviewQuery, { temperature: 0.15, maxTokens: 1600 });
  if (reviewRaw) {
    try {
      const m = reviewRaw.match(/\{[\s\S]*\}/);
      if (m) reviewDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent review parse failed for ${id}`);
    }
  }

  // ── Combine verdicts (worst-case wins) ────────────────────────────────────
  const HEALTH_RANK = { healthy: 0, degraded: 1, needs_update: 2 };
  const REVIEW_MAP  = { complete: 'healthy', has_gaps: 'degraded', needs_rebuild: 'needs_update' };
  const healthVerdict = healthDiagnosis.verdict || 'healthy';
  const reviewVerdict = reviewDiagnosis?.verdict || 'complete';
  const reviewStatus  = REVIEW_MAP[reviewVerdict] || 'healthy';
  const finalStatus   = (HEALTH_RANK[healthVerdict] >= HEALTH_RANK[reviewStatus]) ? healthVerdict : reviewStatus;

  const failureParts = [];
  if (healthVerdict !== 'healthy') failureParts.push(`Health: ${healthDiagnosis.summary}`);
  if (reviewVerdict !== 'complete' && reviewDiagnosis?.summary) failureParts.push(`Review: ${reviewDiagnosis.summary}`);
  if (reviewDiagnosis?.pipelineGaps?.length) failureParts.push(`Gaps: ${reviewDiagnosis.pipelineGaps.join(' | ')}`);
  if (reviewDiagnosis?.betterAlternative)
    failureParts.push(`Alternative: ${reviewDiagnosis.betterAlternative.name} (${reviewDiagnosis.betterAlternative.reason})`);
  const failureLog = failureParts.length > 0 ? failureParts.join('\n') : null;

  // ── Auto-patch descriptor from both phases ────────────────────────────────
  let patchedDescriptor = existing.descriptor;
  let descriptorPatched = false;

  // Phase 2: correct frontmatter URLs if validate_agent found them wrong.
  // This is the primary self-healing path — no human needed.
  if (reviewDiagnosis?.correctedUrls) {
    const { sign_in_url: newSignIn, start_url: newStart } = reviewDiagnosis.correctedUrls;
    if (newSignIn || newStart) {
      patchedDescriptor = rewriteDescriptorFrontmatter(patchedDescriptor, {
        ...(newSignIn ? { sign_in_url: newSignIn } : {}),
        ...(newStart  ? { start_url:   newStart  } : {}),
      });
      descriptorPatched = true;
      logger.info(`[browser.agent] validate_agent: corrected URLs for ${id} — sign_in_url=${newSignIn || '(unchanged)'} start_url=${newStart || '(unchanged)'}`);
    }
  }

  if (healthVerdict === 'needs_update' && healthDiagnosis.updatedInstructionsPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        healthDiagnosis.updatedInstructionsPatch,
      timingAdvice: healthDiagnosis.timingAdvice,
    });
    descriptorPatched = true;
  }
  if (reviewDiagnosis?.descriptorPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        reviewDiagnosis.descriptorPatch,
      timingAdvice: null,
    });
    descriptorPatched = true;
  }

  if (descriptorPatched) {
    const mdPath = path.join(AGENTS_DIR, `${id}.md`);
    fs.writeFileSync(mdPath, patchedDescriptor, 'utf8');
    const db = await getDb();
    if (db) {
      await db.run(
        `UPDATE agents SET descriptor = ?, status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?`,
        patchedDescriptor, finalStatus, failureLog, id
      );
    }
    logger.info(`[browser.agent] validate_agent auto-patched descriptor for ${id}`);
  } else {
    await _updateStatus(id, finalStatus, failureLog);
  }

  logger.info(`[browser.agent] validate_agent ${id} → health:${healthVerdict} review:${reviewVerdict} final:${finalStatus}`);

  return {
    ok: true,
    agentId: id,
    healthy: finalStatus === 'healthy',
    verdict: finalStatus,
    startUrl,
    domSnapshot: !!domSnapshot,
    // Phase 1
    missingSelectors:  healthDiagnosis.missingSelectors  || [],
    changedSelectors:  healthDiagnosis.changedSelectors  || [],
    newElements:       healthDiagnosis.newElements       || [],
    authFlowChanged:   healthDiagnosis.authFlowChanged   || false,
    timingRisk:        healthDiagnosis.timingRisk        || false,
    timingAdvice:      healthDiagnosis.timingAdvice      || null,
    fixes:             healthDiagnosis.fixes             || [],
    healthSummary:     healthDiagnosis.summary,
    // Phase 2
    reviewVerdict,
    routingCorrect:      reviewDiagnosis?.routingCorrect ?? true,
    routingIssues:       reviewDiagnosis?.routingIssues || [],
    betterAlternative:   reviewDiagnosis?.betterAlternative || null,
    missingCapabilities: reviewDiagnosis?.missingCapabilities || [],
    pipelineGaps:        reviewDiagnosis?.pipelineGaps || [],
    setupStepsRequired:  reviewDiagnosis?.setupStepsRequired || [],
    skillCodeRisks:      reviewDiagnosis?.skillCodeRisks || [],
    reviewSummary:       reviewDiagnosis?.summary,
    // Meta
    descriptorPatched,
  };
}


// Rewrite specific frontmatter key: value lines in-place.
// fieldMap = { sign_in_url: 'https://...', start_url: 'https://...' }
function rewriteDescriptorFrontmatter(descriptor, fieldMap) {
  const lines = descriptor.split('\n');
  const rewritten = lines.map(line => {
    for (const [field, value] of Object.entries(fieldMap)) {
      if (line.startsWith(`${field}:`)) {
        return `${field}: ${value}`;
      }
    }
    return line;
  });
  // If a field wasn't present in frontmatter at all, insert it after the last known field
  for (const [field, value] of Object.entries(fieldMap)) {
    if (!rewritten.some(l => l.startsWith(`${field}:`))) {
      const insertAfter = rewritten.findIndex(l => l.startsWith('start_url:') || l.startsWith('service:'));
      if (insertAfter >= 0) {
        rewritten.splice(insertAfter + 1, 0, `${field}: ${value}`);
      }
    }
  }
  return rewritten.join('\n');
}

function patchBrowserDescriptor(descriptor, { patch, timingAdvice }) {
  const lines = descriptor.split('\n');

  // Append patch notes at the end
  const patchLines = [
    ``,
    `## Validator Notes (${new Date().toISOString().slice(0, 10)})`,
    patch,
  ];

  if (timingAdvice) {
    patchLines.push(``, `### Timing Notes`, timingAdvice);
  }

  return lines.join('\n') + '\n' + patchLines.join('\n');
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
// Action: run — executes a task using the agent's descriptor as context.
// Supports two paths based on agent type:
//   api_key / bearer: LLM infers curl command → inject creds → shell exec
//   browser / oauth:  waitForAuth → playwright.agent agentic loop
// ---------------------------------------------------------------------------

const BROWSER_RUN_CURL_PROMPT = `You are a REST API command inference engine. Given an agent descriptor and a task, output the curl command to accomplish that task.

Use EXACTLY these shell variable names for credentials (they will be substituted before execution):
  $CRED_PRIMARY    — the API key, auth token, or password
  $CRED_USERNAME   — the username or account SID (for Basic auth)
  $CRED_DOMAIN     — the domain or secondary identifier (if required, e.g. Mailgun sending domain)

Output ONLY valid JSON:
{
  "curlArgs": ["-s", "-f", "-X", "POST", "<url>", ...],
  "credVars": ["PRIMARY"],
  "reasoning": "<one sentence>"
}

curlArgs must NOT include the word "curl" itself. Always use -s flag. Use -f to fail on HTTP errors.
credVars = which of ["PRIMARY", "USERNAME", "DOMAIN"] are actually referenced in curlArgs.`;

// Resolve a named credential: env var → keytar → null
async function resolveCredential(agentId, credName) {
  const serviceKey = agentId.replace('.agent', '');

  // 1. Try env var patterns (CLICKSEND_API_KEY, CLICKSEND_USERNAME, etc.)
  const candidates = [
    `${serviceKey.toUpperCase()}_${credName}`,
    `${serviceKey.toUpperCase()}_API_KEY`,
    `${serviceKey.toUpperCase()}_TOKEN`,
  ];
  for (const envVar of candidates) {
    if (process.env[envVar]) return process.env[envVar];
  }

  // 2. Try keytar (macOS Keychain)
  try {
    const { execFile } = require('child_process');
    const accounts = [
      `browser_agent:${agentId}:${credName}`,
      `skill:${agentId}:${credName}`,
      `browser_agent:${serviceKey}:${credName}`,
    ];
    for (const account of accounts) {
      const val = await new Promise(resolve => {
        execFile('security', ['find-generic-password', '-s', 'thinkdrop', '-a', account, '-w'], (err, stdout) => {
          resolve(err ? null : stdout.trim());
        });
      });
      if (val) return val;
    }
  } catch {}

  return null;
}

// HTTP helper to call another skill in this command-service process
function callSkill(skillName, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: skillName, args } });
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
        catch (e) { reject(new Error(`skill(${skillName}) parse error: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`skill(${skillName}) timeout`)); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function actionRun({ agentId, task, context }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task)    return { ok: false, error: 'task is required' };

  const existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.`, needsBuild: true };
  }

  const agentType = (() => {
    const m = (existing.descriptor || '').match(/^type:\s*(\S+)/m);
    return m ? m[1].toLowerCase() : existing.type || 'browser';
  })();

  logger.info(`[browser.agent] run agentId=${agentId} type=${agentType} task="${task}"`);

  // ── REST API path (api_key, bearer, basic) ─────────────────────────────
  if (agentType === 'api_key' || agentType === 'bearer' || agentType === 'basic') {
    const inferenceQuery = `Agent descriptor:\n${existing.descriptor || '(no descriptor)'}\n\nTask: ${task}`;
    const raw = await callLLM(BROWSER_RUN_CURL_PROMPT, inferenceQuery, { temperature: 0.1, maxTokens: 600 });

    let curlArgs = [];
    let credVars = [];
    let reasoning = '';

    if (raw) {
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          curlArgs  = Array.isArray(parsed.curlArgs)  ? parsed.curlArgs  : [];
          credVars  = Array.isArray(parsed.credVars)  ? parsed.credVars  : [];
          reasoning = parsed.reasoning || '';
        }
      } catch {}
    }

    if (curlArgs.length === 0) {
      return { ok: false, agentId, task, error: `Could not infer curl command. Reasoning: ${reasoning || 'LLM returned no curlArgs'}` };
    }

    // Resolve credentials
    const creds = {
      PRIMARY:  await resolveCredential(agentId, 'PRIMARY')  || await resolveCredential(agentId, 'API_KEY')  || '',
      USERNAME: await resolveCredential(agentId, 'USERNAME') || await resolveCredential(agentId, 'USER')     || '',
      DOMAIN:   await resolveCredential(agentId, 'DOMAIN')   || '',
    };

    if (credVars.includes('PRIMARY') && !creds.PRIMARY) {
      return {
        ok: false, agentId, task,
        error: `Missing credential for ${agentId}. Store API key in Keychain: security add-generic-password -s thinkdrop -a "browser_agent:${agentId}:PRIMARY" -w "<your-key>"`,
        needsCredentials: true,
      };
    }

    // Substitute credential placeholders in curlArgs
    const resolvedArgs = curlArgs.map(a =>
      a.replace(/\$CRED_PRIMARY/g,  creds.PRIMARY)
       .replace(/\$CRED_USERNAME/g, creds.USERNAME)
       .replace(/\$CRED_DOMAIN/g,   creds.DOMAIN)
    );

    logger.info(`[browser.agent] api_key run: curl ${resolvedArgs.slice(0, 4).join(' ')} ...`, { agentId, reasoning });

    const { execFile } = require('child_process');
    const result = await new Promise(resolve => {
      execFile('curl', resolvedArgs, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) => {
        resolve({ ok: !err || err.code === 0, stdout: out, stderr: errOut, exitCode: err?.code ?? 0, error: err?.message });
      });
    });

    return {
      ok: result.ok,
      agentId,
      task,
      reasoning,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      error: result.error,
    };
  }

  // ── Browser / OAuth path ───────────────────────────────────────────────
  const startUrl           = extractDescriptorUrl(existing.descriptor, 'start_url');
  const signInUrl          = extractDescriptorUrl(existing.descriptor, 'sign_in_url');
  const authSuccessPattern = extractDescriptorUrl(existing.descriptor, 'auth_success_pattern');
  const authTarget         = signInUrl || startUrl;

  if (!startUrl) return { ok: false, error: 'Agent descriptor missing start_url' };

  const profile   = `${agentId.replace('.agent', '')}_agent`;
  const sessionId = `${agentId}_${Date.now()}`;

  // Step 1: ensure auth session exists
  let authResult;
  try {
    authResult = await callBrowserAct({
      action: 'waitForAuth',
      sessionId,
      profile,
      url: authTarget,
      authSuccessUrl: authSuccessPattern,
      authTimeoutMs: 2 * 60 * 1000,
      timeoutMs: 15000,
    }, 3 * 60 * 1000);
  } catch (err) {
    const failureNote = `[${new Date().toISOString()}] waitForAuth threw: ${err.message} | url=${startUrl} | task=${task}`;
    logger.warn(`[browser.agent] run: waitForAuth threw — triggering self-heal for ${agentId}`);
    (async () => {
      try {
        await actionRecordFailure({ id: agentId, failureEntry: failureNote });
        const healResult = await actionValidateAgent({ id: agentId });
        logger.info(`[browser.agent] self-heal (throw): validate_agent verdict=${healResult?.verdict} for ${agentId}`);
      } catch (healErr) {
        logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
      }
    })();
    return { ok: false, error: `waitForAuth failed: ${err.message}` };
  }

  if (!authResult?.ok) {
    const failureNote = `[${new Date().toISOString()}] waitForAuth failed: ${authResult?.error || 'timeout'} | url=${startUrl} | task=${task}`;
    logger.warn(`[browser.agent] run: auth failed — recording failure + triggering self-heal for ${agentId}`);
    (async () => {
      try {
        await actionRecordFailure({ id: agentId, failureEntry: failureNote });
        const healResult = await actionValidateAgent({ id: agentId });
        logger.info(`[browser.agent] self-heal: validate_agent verdict=${healResult?.verdict} for ${agentId}`);
      } catch (healErr) {
        logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
      }
    })();
    return { ok: false, error: `Auth failed for ${agentId}: ${authResult?.error}` };
  }

  // Step 2: delegate to playwright.agent with the authenticated session
  logger.info(`[browser.agent] run: auth ok — delegating to playwright.agent for "${task}"`);
  try {
    const agentResult = await callSkill('playwright.agent', {
      goal: `${task}\n\nAgent context: ${existing.descriptor ? existing.descriptor.slice(0, 800) : ''}`,
      url: startUrl,
      sessionId,
      maxTurns: 15,
      timeoutMs: 120000,
    }, 130000);

    return {
      ok: agentResult?.ok ?? false,
      agentId,
      task,
      sessionId,
      authenticated: true,
      result: agentResult?.result || agentResult?.stdout || '',
      transcript: agentResult?.transcript || [],
      turns: agentResult?.turns,
      done: agentResult?.done,
      error: agentResult?.error,
    };
  } catch (err) {
    return { ok: false, agentId, task, error: `playwright.agent delegation failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: scan_page — headless DOM scan of login/setup page
// Returns structured field list so the UI card can render actual inputs.
// ---------------------------------------------------------------------------

const SCAN_PAGE_SYSTEM_PROMPT = `You are a web page analyzer. Given a DOM snapshot of a login or credential setup page, extract all the input fields the user needs to fill in to authenticate or get an API key.

Output ONLY valid JSON:
{
  "pageType": "login" | "api_key" | "oauth_setup" | "unknown",
  "fields": [
    {
      "name": "<machine-readable key name, e.g. GMAIL_EMAIL>",
      "label": "<human-readable label from page, e.g. Email or phone>",
      "type": "email" | "password" | "text" | "url",
      "placeholder": "<placeholder text if any>",
      "required": true | false
    }
  ],
  "submitLabel": "<text on the submit button, e.g. Next or Sign in>",
  "pageTitle": "<title of the page>",
  "notes": "<one sentence about what this page is asking for>"
}

Rules:
- For Google/Gmail login pages: fields = [{name:"GMAIL_EMAIL", label:"Email or phone", type:"email", required:true}]
- For password step: fields = [{name:"GMAIL_PASSWORD", label:"Password", type:"password", required:true}]
- For API key pages: fields = [{name:"API_KEY", label:"API Key", type:"text", required:true}]
- For OAuth setup (Client ID + Secret): fields = [{name:"CLIENT_ID", label:"Client ID", type:"text"}, {name:"CLIENT_SECRET", label:"Client Secret", type:"password"}]
- Map field names to SCREAMING_SNAKE_CASE with service prefix where appropriate
- Only include fields actually visible in the DOM, not hidden/disabled ones`;

// Extract sign_in_url: or start_url: from a descriptor frontmatter string
function extractDescriptorUrl(descriptor, field) {
  if (!descriptor) return null;
  const line = descriptor.split('\n').find(l => l.startsWith(`${field}:`));
  return line ? line.replace(`${field}:`, '').trim() : null;
}

async function actionScanPage({ service, url: explicitUrl, secretKey }) {
  const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  let scanUrl = explicitUrl;
  if (!scanUrl && serviceKey) {
    // Priority 1: DuckDB descriptor sign_in_url: (written/corrected by validate_agent)
    const agentId = `${serviceKey}.agent`;
    const stored = await actionQueryAgent({ id: agentId }).catch(() => null);
    const storedSignIn = stored?.found ? extractDescriptorUrl(stored.descriptor, 'sign_in_url') : null;
    if (storedSignIn) {
      scanUrl = storedSignIn;
      logger.info(`[browser.agent] scan_page: using DuckDB sign_in_url for ${service}: ${scanUrl}`);
    } else {
      // Priority 2: seed map startUrl (bootstrap fallback only)
      const meta = await resolveBrowserMeta(service).catch(() => null);
      scanUrl = meta?.startUrl || `https://${serviceKey}.com`;
      logger.info(`[browser.agent] scan_page: no stored sign_in_url — using seed startUrl: ${scanUrl}`);
    }
  }
  if (!scanUrl) return { ok: false, error: 'url or service is required for scan_page' };

  logger.info(`[browser.agent] scan_page: scanning ${scanUrl} for service="${service}"`);

  // Use headless browser.act scanCurrentPage (isolated, no cookies)
  let domSnapshot = '';
  try {
    const scanResult = await callBrowserAct({
      action: 'scanCurrentPage',
      url: scanUrl,
      sessionId: `scan_${serviceKey}_${Date.now()}`,
      isolated: true,
      timeoutMs: 20000,
    }, 30000);
    if (scanResult?.elements) {
      // Flatten elements to a readable text snapshot for the LLM
      domSnapshot = (scanResult.elements || [])
        .slice(0, 60)
        .map(el => `[${el.tag}] label="${el.label || ''}" placeholder="${el.placeholder || ''}" type="${el.type || ''}" id="${el.id || ''}" name="${el.name || ''}"`)
        .join('\n');
    } else if (scanResult?.html) {
      domSnapshot = scanResult.html.slice(0, 4000);
    } else if (typeof scanResult === 'string') {
      domSnapshot = scanResult.slice(0, 4000);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: DOM scan failed (${err.message}), using LLM knowledge only`);
  }

  // Ask LLM to interpret what fields this page needs
  const userQuery = [
    `Service: ${service}`,
    `URL: ${scanUrl}`,
    secretKey ? `We need to collect: ${secretKey}` : '',
    domSnapshot ? `\nDOM snapshot:\n${domSnapshot}` : '\n(DOM scan unavailable — use your knowledge of this service\'s login page)',
  ].filter(Boolean).join('\n');

  let parsed = null;
  try {
    const raw = await callLLM(SCAN_PAGE_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 600 });
    if (raw) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: LLM parse failed: ${err.message}`);
  }

  // Hard fallback: return sensible defaults based on secretKey naming
  if (!parsed || !parsed.fields || parsed.fields.length === 0) {
    const key = (secretKey || '').toUpperCase();
    const isPassword = key.includes('PASSWORD') || key.includes('SECRET');
    const isEmail    = key.includes('EMAIL') || key.includes('USER');
    parsed = {
      pageType: 'unknown',
      fields: [{
        name: secretKey || `${serviceKey.toUpperCase()}_KEY`,
        label: (secretKey || 'API Key').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        type: isPassword ? 'password' : isEmail ? 'email' : 'text',
        placeholder: '',
        required: true,
      }],
      pageTitle: service,
      notes: `Credential required for ${service}`,
    };
  }

  logger.info(`[browser.agent] scan_page: found ${parsed.fields.length} field(s) for ${service} (${parsed.pageType})`);
  return {
    ok: true,
    service,
    url: scanUrl,
    pageType: parsed.pageType,
    fields: parsed.fields,
    submitLabel: parsed.submitLabel || 'Submit',
    pageTitle: parsed.pageTitle || service,
    notes: parsed.notes || '',
  };
}

// ---------------------------------------------------------------------------
// Action: record_failure — append a runtime error to failure_log
// ---------------------------------------------------------------------------

async function actionRecordFailure({ id, failureEntry }) {
  if (!id || !failureEntry) return { ok: false, error: 'id and failureEntry are required' };
  const db = await getDb();
  if (!db) return { ok: false, error: 'DB unavailable' };
  try {
    const row = await db.get('SELECT failure_log FROM agents WHERE id = ?', id);
    if (!row) return { ok: false, error: `Agent not found: ${id}` };
    const existing = row.failure_log || '';
    const entries = existing ? existing.split('\n---\n') : [];
    entries.unshift(failureEntry);
    const trimmed = entries.slice(0, 5).join('\n---\n');
    await db.run(
      'UPDATE agents SET failure_log = ?, status = CASE WHEN status = \'healthy\' THEN \'degraded\' ELSE status END WHERE id = ?',
      trimmed, id
    );
    logger.info(`[browser.agent] record_failure: appended runtime error for ${id}`);
    return { ok: true, agentId: id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

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

    case 'scan_page':
      return await actionScanPage(args);

    case 'record_failure':
      return await actionRecordFailure(args);

    default:
      return {
        ok: false,
        error: `Unknown action: "${action}". Valid: build_agent | query_agent | list_agents | validate_agent | run | scan_page | record_failure`,
      };
  }
}

module.exports = { browserAgent, KNOWN_BROWSER_SERVICES };
