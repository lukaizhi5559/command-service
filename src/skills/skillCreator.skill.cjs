'use strict';
/**
 * skillCreator.skill.cjs
 *
 * Converts a completed creator.agent project into a production ThinkDrop skill.
 *
 * Inputs (from creatorPlanning node after reviewer passes):
 *   projectId  — creator.agent project id
 *   projectDir — full path to ~/.thinkdrop/projects/<id>/
 *
 * Reads:
 *   plan.md              — tech stack, API surface, risk notes, ## Skill Interface
 *   agents.md            — agent roster with capabilities + auth
 *   agents/*.validate.md — validate.agent specs for each agent
 *
 * Outputs:
 *   <skill_name>.skill.cjs  — written to command-service/src/skills/
 *   DuckDB skills table row — registered and available to executeCommand
 *
 * The prototype/ directory is NOT used — it's a dev artifact only.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const logger = require('../logger.cjs');
const { getDb } = require('./agents-db.cjs');

const USER_SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');
const PROJECTS_DIR    = path.join(os.homedir(), '.thinkdrop', 'projects');

// ── Dep detection / install / smoke-test (replaces dead installSkill.js node) ─

const NODE_BUILTINS = new Set([
  'assert','async_hooks','buffer','child_process','cluster','console','constants',
  'crypto','dgram','diagnostics_channel','dns','domain','events','fs','fs/promises',
  'http','http2','https','inspector','module','net','os','path','perf_hooks',
  'process','punycode','querystring','readline','repl','stream','stream/promises',
  'string_decoder','timers','timers/promises','tls','trace_events','tty','url',
  'util','v8','vm','wasi','worker_threads','zlib',
]);
// Packages always available in command-service process — no per-skill install needed
const CMD_PROVIDED = new Set(['keytar']);
// Broken TS-only packages — never install
const BROKEN_DEPS  = new Set(['clicksend', 'node-cron']);

const KNOWN_VERSIONS = {
  'twilio': '^5.0.0', 'googleapis': '^144.0.0', 'nodemailer': '^6.9.0',
  'axios': '^1.6.0', 'openai': '^4.0.0', '@slack/web-api': '^7.0.0',
  'node-fetch': '^2.7.0', 'cheerio': '^1.0.0', 'uuid': '^9.0.0',
  'lodash': '^4.17.21', 'date-fns': '^3.0.0', 'keytar': '^7.9.0',
};

function detectSkillDeps(code) {
  const deps = {};
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const pkg = m[1];
    if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
    const root = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    if (NODE_BUILTINS.has(root) || CMD_PROVIDED.has(root) || BROKEN_DEPS.has(root)) continue;
    if (!deps[root]) deps[root] = KNOWN_VERSIONS[root] || 'latest';
  }
  return deps;
}

function installSkillDeps(skillDir, deps) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const pkgPath = path.join(skillDir, 'package.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    // Always include keytar baseline; strip broken deps
    const merged = Object.assign({}, existing.dependencies || {}, { keytar: '^7.9.0' }, deps);
    for (const bad of BROKEN_DEPS) delete merged[bad];
    const pkg = Object.assign({ name: path.basename(skillDir), version: '1.0.0', private: true, main: 'index.cjs' }, existing, { dependencies: merged });
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');

    const pkgList = Object.keys(merged);
    if (pkgList.length === 0) return resolve({ ok: true });

    logger.info(`[skillCreator] npm install: ${pkgList.join(', ')}`, { skillDir });
    const child = spawn('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: skillDir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'npm install timed out' }); }, 120000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) { logger.info(`[skillCreator] npm install ok`); resolve({ ok: true }); }
      else { logger.warn(`[skillCreator] npm install failed: ${stderr.slice(0, 300)}`); resolve({ ok: false, error: stderr.slice(0, 300) }); }
    });
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
  });
}

function runSmokeTest(skillPath) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const script = `(async()=>{try{const s=require(${JSON.stringify(skillPath)});const fn=typeof s==='function'?s:s.default||s.run;if(typeof fn!=='function'){process.stdout.write(JSON.stringify({ok:false,error:'not a function'}));process.exit(0);}const ctx={logger:{info:()=>{},warn:()=>{},error:()=>{},debug:()=>{}},secrets:{},skillName:'smoke-test'};const r=await Promise.race([fn({dryRun:true},ctx),new Promise((_,j)=>setTimeout(()=>j(new Error('timeout')),8000))]);process.stdout.write(JSON.stringify({ok:true,output:typeof r==='string'?r:JSON.stringify(r)}));}catch(e){const msg=e.message||String(e);const exp=/not set|not configured|API key|keytar|getPassword|Missing.*secret/i.test(msg);process.stdout.write(JSON.stringify({ok:exp,error:msg,expected:exp}));}process.exit(0);})();`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, error: 'smoke test timed out' }); }, 11000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const p = JSON.parse(stdout.trim() || '{}');
        // Missing secrets before keys are stored = expected — treat as pass
        resolve(p.expected ? { ok: true, output: 'secrets not yet stored (expected)' } : p);
      } catch (_) {
        const err = stderr.slice(0, 300) || stdout.slice(0, 300) || 'no output';
        // Cannot find module = missing dep — caller should handle
        resolve({ ok: false, error: err });
      }
    });
  });
}

let _seq = 0;

async function callLLM(systemPrompt, userPrompt, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  const WebSocket = require('ws');
  const WS_BASE = process.env.LLM_WS_URL || process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
  const url = new URL(WS_BASE);
  const apiKey = process.env.VSCODE_API_KEY || process.env.BACKEND_API_KEY || process.env.BASE_API_KEY || '';
  if (apiKey) url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('userId', 'skill_creator');
  url.searchParams.set('clientId', 'sc_' + Date.now() + '_' + (++_seq));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    let answer = '';
    const timer = setTimeout(() => { ws.close(); reject(new Error('LLM timeout')); }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify({
      id: 'sc_' + Date.now(), type: 'llm_request',
      payload: { prompt: userPrompt, provider: 'openai', options: { temperature: 0.2, stream: true, taskType: 'ask' },
        context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] } },
      timestamp: Date.now(), metadata: { source: 'skill_creator' },
    })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_chunk') answer += msg.payload?.chunk || msg.payload?.text || '';
        else if (msg.type === 'llm_stream_end') { clearTimeout(timer); ws.close(); resolve(answer); }
        else if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.payload?.message || 'LLM error')); }
      } catch { /* ignore non-JSON frames */ }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('close', () => {
      clearTimeout(timer);
      if (answer.trim().length > 0) resolve(answer);
      else reject(new Error('LLM WS closed before sending any content'));
    });
  });
}

function stripFences(content) {
  return (content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return null; }
}

// ── Parse ## Skill Interface section from plan.md ──────────────────────────────
function parseSkillInterface(planMd) {
  const section = (planMd.match(/## Skill Interface\n([\s\S]*?)(?=\n##|$)/) || [])[1] || '';
  function field(key) {
    const m = section.match(new RegExp('-\\s*' + key + '\\s*:\\s*(.+)'));
    return m ? m[1].trim() : null;
  }
  function listField(key) {
    const m = section.match(new RegExp('-\\s*' + key + '\\s*:\\s*([^\\n]+(?:\\n\\s+-[^\\n]+)*)'));
    if (!m) return [];
    return m[1].split(/[\n,]/).map(s => s.replace(/^[-\s]+/, '').trim()).filter(Boolean);
  }

  const skillName  = field('skill_name') || null;
  const trigger    = field('trigger') || '';
  const schedule   = field('schedule') || 'on_demand';
  const runtime    = field('runtime') || 'node';
  const secrets    = listField('secrets');

  // Parse inputs: "key: type" pairs
  const inputsRaw = (section.match(/-\s*inputs:([\s\S]*?)(?=\n\s*-\s*\w+:|$)/) || [])[1] || '';
  const inputs = {};
  for (const line of inputsRaw.split('\n')) {
    const m = line.match(/([a-z_]+)\s*:\s*(\w+)/i);
    if (m) inputs[m[1]] = m[2];
  }

  // Parse outputs similarly
  const outputsRaw = (section.match(/-\s*outputs:([\s\S]*?)(?=\n\s*-\s*\w+:|$)/) || [])[1] || '';
  const outputs = {};
  for (const line of outputsRaw.split('\n')) {
    const m = line.match(/([a-z_]+)\s*:\s*(\w+)/i);
    if (m) outputs[m[1]] = m[2];
  }

  return { skillName, trigger, schedule, runtime, secrets, inputs, outputs };
}

// ── Parse agents from agents.md ────────────────────────────────────────────────
function parseAgents(agentsMd) {
  const agents = [];
  const sections = agentsMd.split(/\n(?=## )/);
  for (const sec of sections) {
    const idMatch = sec.match(/^## ([a-zA-Z0-9._-]+)/);
    if (!idMatch) continue;
    const id   = idMatch[1];
    const type = (sec.match(/-\s*type\s*:\s*(\w+)/) || [])[1] || 'api';
    const role = (sec.match(/-\s*role\s*:\s*(.+)/) || [])[1] || '';
    const caps = (sec.match(/capabilities:\s*([\s\S]*?)(?=\n-\s*\w+:|$)/) || [])[1] || '';
    const capabilities = caps.split('\n').map(l => l.replace(/^[\s-]+/, '').trim()).filter(Boolean);
    const auth = (sec.match(/-\s*auth\s*:\s*(.+)/) || [])[1] || '';
    agents.push({ id, type, role, capabilities, auth });
  }
  return agents;
}

// ── Read all validate.agent specs ─────────────────────────────────────────────
function readValidateSpecs(projectDir) {
  const agentsDir = path.join(projectDir, 'agents');
  const specs = {};
  if (!fs.existsSync(agentsDir)) return specs;
  for (const file of fs.readdirSync(agentsDir)) {
    if (!file.endsWith('.validate.md')) continue;
    const agentId = file.replace('.validate.md', '');
    specs[agentId] = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  }
  return specs;
}

// ── System prompt for skill generation ────────────────────────────────────────
const SKILL_GEN_SYS = `You are an expert Node.js developer generating a ThinkDrop MCP skill file.

A ThinkDrop skill is a CommonJS module (.skill.cjs) that exports an async function with this signature:
  module.exports = async function run(args, context) { ... }

Where:
- args: object with runtime inputs (phone_number, timezone, etc.)
- context: {
    logger,           // logging (context.logger.info/warn/error)
    secrets,          // env var values loaded from keytar (context.secrets.MY_API_KEY)
    db,               // persistent storage + semantic memory (see DB RULES below)
    llm,              // LLM reasoning access (see LLM RULES below)
    skillName,        // this skill's registered name (string)
    oauth,            // OAuth token map (context.oauth.google, etc.)
  }

DB RULES — context.db (HTTP client to user-memory MCP on port 3001):
- Persist state between runs:   await context.db.set(skillName, 'last_run', Date.now())
- Read persisted state:         await context.db.get(skillName, 'last_run')
- Delete a value:               await context.db.del(skillName, 'key')
- List all KV for this skill:   await context.db.list(skillName)
- Store semantic memory:        await context.db.remember(skillName, 'User prefers dark mode')
- Search semantic memory:       await context.db.recall(skillName, 'user preferences', topK=5)
- All db methods return null/[] on error — always degrade gracefully, never throw on db failure.
- Use context.db to: deduplicate (track seen IDs), store last-run timestamps, cache API results, remember user preferences across runs.

LLM RULES — context.llm (WebSocket connection to LLM backend):
- Simple question:              await context.llm.ask('Summarize this email thread: ...')
- Multi-turn with system prompt: await context.llm.askWithMessages([{ role: 'system', content: '...' }, { role: 'user', content: '...' }])
- Check availability:           await context.llm.isAvailable()
- Use context.llm to: summarize content, classify/categorize data, generate text, make decisions from unstructured input.
- Always wrap in try/catch — LLM may be unavailable during offline runs.

The skill must:
1. Validate all required secrets/args at the top, return { ok: false, error: '...' } if missing
2. Implement the core logic cleanly using the agents/APIs described in plan.md and agents.md
3. Use only dependencies already listed in the project's package.json
4. Include a validate() export: async function validate(context) that runs a lightweight health check
5. Include an install() export: async function install(context) that ensures deps are available
6. Store OAuth tokens locally in ~/.thinkdrop/tokens/<skill_name>.json (NOT Google Secret Manager)
7. Handle all error cases with descriptive messages
8. Return { ok: true, ...outputs } on success, { ok: false, error: '...' } on failure

CRITICAL RULES — NEVER VIOLATE:
- NEVER hardcode any credential, username, password, API key, token, or secret value in the code.
- ALL secrets (usernames, API keys, tokens, passwords) MUST come from context.secrets ONLY.
- Example: use \`secrets.CLICKSEND_USERNAME\` not a string literal like 'your_username'.
- If a secret name is not in the ## Skill Interface secrets list, add it there and read it from context.secrets.

DEPENDENCY RULES — CRITICAL:
- NEVER use npm packages that ship only TypeScript source without compiled JavaScript (no \`api.js\`, \`index.js\`, etc. in package root).
- Known broken packages (TS-only, DO NOT USE): \`clicksend\`, any package whose main entry is \`.ts\`.
- For HTTP/REST APIs (ClickSend, Twilio, Stripe, etc.) use Node.js built-in \`https\` module directly — no SDK needed.
- Only use npm packages that are known to ship compiled CommonJS: \`googleapis\`, \`axios\`, \`node-fetch\`, \`nodemailer\`, \`twilio\`, \`@slack/web-api\`.
- If an API has a REST endpoint, ALWAYS prefer \`https.request()\` over an SDK unless the SDK is in the approved list above.
- NEVER add placeholder values like 'your_username', 'recipient_phone_number', 'sender_id' — all such values MUST come from context.secrets.

BASIC AUTH RULES — CRITICAL:
- HTTP Basic Auth encodes BOTH a username and a password/key: Buffer.from(username + ':' + password).toString('base64')
- NEVER use an empty username: Buffer.from(':' + apiKey) is WRONG — it will always return invalid_request.
- ClickSend REQUIRES: Buffer.from(secrets.CLICKSEND_USERNAME + ':' + secrets.CLICKSEND_API_KEY).toString('base64')
  where CLICKSEND_USERNAME is the account email and CLICKSEND_API_KEY is the API key from app.clicksend.com.
- ClickSend SMS payload format: { messages: [{ to: '+1...', body: '...', source: 'thinkdrop' }] }
  NOT { to, message } — that format will return invalid_request.
- Any API using HTTP Basic Auth: always declare BOTH the username/login AND the key as separate secrets.

SCHEDULING RULES — CRITICAL:
- The skill MUST NOT implement its own scheduling. Do NOT require('node-cron'), do NOT use setInterval, do NOT call cron.schedule().
- Scheduling is handled entirely by the ThinkDrop command-service skill-scheduler daemon, which reads the skill's schedule field from contract_md and fires run() at the right time.
- The schedule field in the Skill Interface is either a 5-part cron expression ("0 21 * * *") or a RANDOM_WINDOW pattern (e.g. RANDOM_WINDOW(count=3,start=08:00,end=17:00,min_gap_minutes=30,days=1-5)).
- The skill's run() function must just execute the core logic once and return. The scheduler handles repetition.
- Example: for "daily at 9pm", schedule = "0 21 * * *". run() fetches emails and sends SMS once. Done.

BROWSER.ACT RULES — CRITICAL (browser.act is backed by playwright-cli):
- browser.act is a function call: const { browserAct } = require('./browser.act.cjs');
- playwright-cli keeps a persistent headed Chromium session per sessionId. After every action it returns
  a snapshot of the accessibility tree with element refs (e1, e21, etc.) cached per session.
- ALWAYS call snapshot before the first click/fill on a new page to ensure the ref cache is fresh:
    await browserAct({ action: 'navigate', url: '...', sessionId: 'mySession' });
    await browserAct({ action: 'snapshot', sessionId: 'mySession' });
    await browserAct({ action: 'click', selector: 'Sign in', sessionId: 'mySession' });
- Pass the VISIBLE LABEL or aria-name as selector (e.g. 'Sign in', 'Email', 'Search') — playwright-cli
  resolves it to the correct eN ref automatically via the cached snapshot.
- CSS selectors (#id, .class, button:has-text()) still work as a fallback.
- For text input: use fill (selector + text) or smartType (auto-discovers best visible input):
    await browserAct({ action: 'fill', selector: 'Email', text: 'user@example.com', sessionId });
    await browserAct({ action: 'smartType', text: 'search query', sessionId });
- For key press: use press (not keyboard) with playwright key names: 'Enter', 'Tab', 'Escape':
    await browserAct({ action: 'press', key: 'Enter', sessionId });
- For reading page content: use waitForStableText (polls until content stable) or getPageText.
- NEVER call waitForSelector before click/fill — snapshot + label resolution handles element discovery.
- NEVER use evaluate for DOM reads when getPageText/waitForStableText/snapshot covers the need.
- Use the same sessionId across ALL steps for a given site — mixing sessionIds targets different tabs.

Output: raw CommonJS code only. No markdown fences, no explanation.`;

// ── Fetch api_rules from user-memory MCP for detected services ───────────────
const SKILL_SERVICE_DETECTORS = [
  { pattern: /clicksend|rest\.clicksend\.com/i,    service: 'clicksend' },
  { pattern: /twilio/i,                            service: 'twilio' },
  { pattern: /stripe/i,                            service: 'stripe' },
  { pattern: /sendgrid/i,                          service: 'sendgrid' },
  { pattern: /mailgun/i,                           service: 'mailgun' },
  { pattern: /googleapis|google\.auth/i,           service: 'gmail' },
  { pattern: /github/i,                            service: 'github' },
  { pattern: /slack/i,                             service: 'slack' },
  { pattern: /notion/i,                            service: 'notion' },
  { pattern: /airtable/i,                          service: 'airtable' },
  { pattern: /shopify/i,                           service: 'shopify' },
  { pattern: /discord/i,                           service: 'discord' },
  { pattern: /vonage|messagebird/i,                service: 'vonage' },
];

async function fetchApiRulesForSkillGen(combinedText) {
  const services = new Set();
  for (const { pattern, service } of SKILL_SERVICE_DETECTORS) {
    if (pattern.test(combinedText)) services.add(service);
  }
  if (!services.size) return '';
  try {
    const http = require('http');
    const MEM_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
    const body = JSON.stringify({ payload: { services: [...services] }, requestId: 'skillgen-' + Date.now() });
    const raw = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: MEM_PORT, path: '/api_rule.search', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          ...(MEM_API_KEY ? { 'Authorization': `Bearer ${MEM_API_KEY}` } : {}) },
        timeout: 5000,
      }, (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d)); });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write(body); req.end();
    });
    const parsed = raw ? JSON.parse(raw) : null;
    const results = parsed?.payload?.results || [];
    if (!results.length) return '';
    const lines = results.map(r =>
      `- [${r.service}:${r.ruleType}] ${r.ruleText}` +
      (r.fixHint ? `\n  FIX: ${r.fixHint}` : '')
    );
    return `\n\nAPI_RULES_FROM_DB (HARD REQUIREMENTS — violations will fail at runtime):\n${lines.join('\n')}`;
  } catch (_) {
    return '';
  }
}

// ── Generate the skill file via LLM ───────────────────────────────────────────
async function generateSkillCode(iface, agents, validateSpecs, planMd, agentsMd) {
  const validateSpecsSummary = Object.entries(validateSpecs)
    .map(([id, spec]) => '### ' + id + ' validate.agent spec\n' + spec.slice(0, 800))
    .join('\n\n');

  const secretsDestructure = iface.secrets.length > 0
    ? 'const { ' + iface.secrets.join(', ') + ' } = secrets;'
    : '// no secrets required';

  // Fetch dynamic api_rules for any services detected in plan + skill name
  const combinedText = [iface.skillName, planMd, agentsMd].join(' ');
  const apiRulesSection = await fetchApiRulesForSkillGen(combinedText).catch(() => '');

  const userPrompt = [
    '## Skill Interface',
    'skill_name: ' + iface.skillName,
    'trigger: ' + iface.trigger,
    'schedule: ' + iface.schedule,
    'runtime: ' + iface.runtime,
    'secrets: ' + iface.secrets.join(', '),
    'inputs: ' + JSON.stringify(iface.inputs),
    'outputs: ' + JSON.stringify(iface.outputs),
    '',
    '## Required secrets destructuring (use exactly this pattern at the top of run() and validate())',
    secretsDestructure,
    'NEVER use string literals for any of these values. Always read from context.secrets.',
    '',
    '## plan.md',
    planMd.slice(0, 3000),
    '',
    '## agents.md',
    agentsMd.slice(0, 2000),
    '',
    '## validate.agent specs',
    validateSpecsSummary.slice(0, 2000),
    ...(apiRulesSection ? ['', apiRulesSection] : []),
    '',
    'Generate the complete .skill.cjs for: ' + iface.skillName,
    'Use local token storage at ~/.thinkdrop/tokens/' + iface.skillName + '.json for OAuth.',
    'Do NOT use Google Secret Manager or AWS Secrets Manager.',
    ...(iface._fixFeedback ? ['', '## ERRORS FROM PREVIOUS ATTEMPT — FIX ALL OF THESE:', iface._fixFeedback] : []),
  ].join('\n');

  return callLLM(SKILL_GEN_SYS, userPrompt, 180000);
}

// ── Register skill in DuckDB ───────────────────────────────────────────────────
async function registerSkill(db, skillName, skillPath, iface, projectId) {
  if (!db) return;
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY,
        file_path TEXT,
        project_id TEXT,
        trigger TEXT,
        schedule TEXT,
        runtime TEXT,
        secrets TEXT,                                                                                                                                                                                                                                
        inputs TEXT,
        outputs TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    await db.run(
      `INSERT INTO skills (name, file_path, project_id, trigger, schedule, runtime, secrets, inputs, outputs, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         file_path=excluded.file_path, trigger=excluded.trigger,
         schedule=excluded.schedule, status=excluded.status, updated_at=excluded.updated_at`,
      skillName,
      skillPath,
      projectId || null,
      iface.trigger,
      iface.schedule,
      iface.runtime,
      JSON.stringify(iface.secrets),
      JSON.stringify(iface.inputs),
      JSON.stringify(iface.outputs),
      'ready',
      new Date().toISOString(),
      new Date().toISOString()
    );
    logger.info('[skillCreator] registered skill in DuckDB', { skillName });
  } catch (e) {
    logger.warn('[skillCreator] DuckDB skill registration failed', { error: e.message });
  }
}

// ── Also register in user-memory MCP skills list ──────────────────────────────
// user-memory /skill.install requires:
//   - exec_path inside ~/.thinkdrop/skills/
//   - dot-notation skill name (e.g. gmail.daily.summary, not gmail-daily-summary)
//   - contractMd with valid YAML frontmatter block
async function registerInMemoryMCP(skillName, iface, sourceSkillPath, planMd) {
  try {
    const http  = require('http');
    const osMod = require('os');

    // skillName is already dot-notation and sourceSkillPath already points to
    // ~/.thinkdrop/skills/<dotName>/index.cjs — no copy needed, just register.
    const dotName = skillName;
    const skillUserPath = sourceSkillPath;
    logger.info('[skillCreator] registering skill in user-memory MCP', { skillUserPath });

    // Build a meaningful description from plan.md for semantic skill matching.
    // Priority: ## Overview section > first non-heading paragraph > fallback.
    let description = '';
    if (planMd) {
      const overviewMatch = planMd.match(/##\s+Overview\s*\n+([\s\S]*?)(?=\n##|\n---|\z)/i);
      if (overviewMatch) {
        description = overviewMatch[1].replace(/\n+/g, ' ').trim().slice(0, 200);
      }
      if (!description) {
        // First non-empty, non-heading line
        const firstPara = planMd.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
        if (firstPara) description = firstPara.trim().slice(0, 200);
      }
    }
    if (!description) {
      description = dotName.replace(/\./g, ' ') + (iface.trigger ? ' — ' + iface.trigger : '');
    }
    // Detect OAuth providers from iface or skill code patterns
    let oauthProviders = iface.oauth || [];
    if (iface._skillCode) {
      const code = iface._skillCode;
      if (/googleapis|google\.auth|google-auth/i.test(code))            oauthProviders = [...oauthProviders, 'google'];
      if (/octokit|github\.com\/login\/oauth|@octokit/i.test(code))     oauthProviders = [...oauthProviders, 'github'];
      if (/microsoft\.com|msal|@azure|graph\.microsoft/i.test(code))    oauthProviders = [...oauthProviders, 'microsoft'];
      if (/facebook\.com|graph\.facebook|fb-sdk|meta\.com/i.test(code)) oauthProviders = [...oauthProviders, 'facebook'];
      if (/twitter\.com|api\.twitter|twit\b|twitter-api/i.test(code))   oauthProviders = [...oauthProviders, 'twitter'];
      if (/linkedin\.com|linkedin-api/i.test(code))                     oauthProviders = [...oauthProviders, 'linkedin'];
      if (/slack\.com|@slack\/web-api|@slack\/bolt/i.test(code))        oauthProviders = [...oauthProviders, 'slack'];
      if (/notion\.com|@notionhq\/client/i.test(code))                  oauthProviders = [...oauthProviders, 'notion'];
      if (/spotify\.com|spotify-web-api/i.test(code))                   oauthProviders = [...oauthProviders, 'spotify'];
      if (/dropbox\.com|dropbox-sdk|Dropbox\(/i.test(code))             oauthProviders = [...oauthProviders, 'dropbox'];
      if (/discord\.com|discord\.js|@discordjs/i.test(code))            oauthProviders = [...oauthProviders, 'discord'];
      if (/zoom\.us|zoomus/i.test(code))                                 oauthProviders = [...oauthProviders, 'zoom'];
      if (/atlassian\.com|jira\.com|atlassian-sdk/i.test(code))         oauthProviders = [...oauthProviders, 'atlassian'];
      if (/salesforce\.com|jsforce|@salesforce/i.test(code))            oauthProviders = [...oauthProviders, 'salesforce'];
      if (/hubspot\.com|@hubspot\/api-client/i.test(code))              oauthProviders = [...oauthProviders, 'hubspot'];
      oauthProviders = [...new Set(oauthProviders)];
    }

    // Build per-provider scope map from iface.oauthScopes or by scanning the skill code
    // for specific Google API scope URLs / provider-specific resource identifiers.
    // Format written to contract: oauth_scopes: google=<scopes>, slack=<scopes>
    const oauthScopesMap = Object.assign({}, iface.oauthScopes || {});
    if (iface._skillCode) {
      const code = iface._skillCode;
      // Google: detect which Google APIs are used and build a minimal scope list
      if (oauthProviders.includes('google') && !oauthScopesMap.google) {
        const googleScopes = new Set(['https://www.googleapis.com/auth/userinfo.email']);
        if (/gmail/i.test(code))           googleScopes.add('https://www.googleapis.com/auth/gmail.modify');
        if (/calendar/i.test(code))        googleScopes.add('https://www.googleapis.com/auth/calendar');
        if (/drive/i.test(code))           googleScopes.add('https://www.googleapis.com/auth/drive');
        if (/sheets/i.test(code))          googleScopes.add('https://www.googleapis.com/auth/spreadsheets');
        if (/docs/i.test(code))            googleScopes.add('https://www.googleapis.com/auth/documents');
        if (/youtube/i.test(code))         googleScopes.add('https://www.googleapis.com/auth/youtube.readonly');
        if (/admin.*sdk|directory/i.test(code)) googleScopes.add('https://www.googleapis.com/auth/admin.directory.user.readonly');
        oauthScopesMap.google = [...googleScopes].join(' ');
      }
      // GitHub: detect read-only vs write usage
      if (oauthProviders.includes('github') && !oauthScopesMap.github) {
        const ghScopes = new Set(['read:user', 'user:email']);
        if (/createPull|pulls\.create|repo\.create|push|commit/i.test(code)) ghScopes.add('repo');
        if (/issues\.create|createIssue/i.test(code)) ghScopes.add('repo');
        if (/gists/i.test(code)) ghScopes.add('gist');
        oauthScopesMap.github = [...ghScopes].join(' ');
      }
      // Slack: detect which scopes are needed
      if (oauthProviders.includes('slack') && !oauthScopesMap.slack) {
        const slackScopes = new Set(['openid', 'profile', 'email']);
        if (/chat\.postMessage|sendMessage/i.test(code)) slackScopes.add('chat:write');
        if (/channels\.list|conversations\.list/i.test(code)) slackScopes.add('channels:read');
        if (/users\.list|users\.info/i.test(code)) slackScopes.add('users:read');
        if (/files\.upload/i.test(code)) slackScopes.add('files:write');
        oauthScopesMap.slack = [...slackScopes].join(' ');
      }
      // Microsoft: detect Graph API resources
      if (oauthProviders.includes('microsoft') && !oauthScopesMap.microsoft) {
        const msScopes = new Set(['openid', 'profile', 'email', 'offline_access']);
        if (/\/mail|messages|sendMail/i.test(code)) msScopes.add('Mail.ReadWrite');
        if (/\/calendar|events/i.test(code)) msScopes.add('Calendars.ReadWrite');
        if (/\/files|driveItem/i.test(code)) msScopes.add('Files.ReadWrite');
        if (/\/contacts/i.test(code)) msScopes.add('Contacts.ReadWrite');
        if (/\/teams|channels/i.test(code)) msScopes.add('ChannelMessage.Send');
        oauthScopesMap.microsoft = [...msScopes].join(' ');
      }
    }

    const contractLines = [
      '---',
      'name: ' + dotName,
      'description: ' + description,
      'exec_path: ' + skillUserPath,
      'exec_type: node',
      'version: 1.0.0',
      'trigger: ' + (iface.trigger || dotName),
      'schedule: ' + (iface.schedule || 'on_demand'),
      'secrets: ' + (iface.secrets || []).join(', '),
    ];
    if (oauthProviders.length > 0) contractLines.push('oauth: ' + oauthProviders.join(', '));
    // Write per-provider scopes so Skills tab shows accurate permission hints
    if (Object.keys(oauthScopesMap).length > 0) {
      const scopeStr = Object.entries(oauthScopesMap)
        .map(([p, s]) => `${p}=${s}`)
        .join(', ');
      contractLines.push('oauth_scopes: ' + scopeStr);
    }
    contractLines.push('---');
    const contractMd = [
      ...contractLines,
      '',
      '# ' + dotName,
      '',
      description,
    ].join('\n');

    const body = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'skill.install', payload: { contractMd }, requestId: 'skillCreator-' + Date.now() });
    const memApiKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10),
        path: '/skill.install', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(memApiKey ? { 'Authorization': `Bearer ${memApiKey}` } : {}),
        },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed?.status === 'ok') {
              logger.info('[skillCreator] registered skill in user-memory', { dotName });
            } else {
              logger.warn('[skillCreator] user-memory skill.install response', { dotName, data: data.slice(0, 200) });
            }
          } catch (_) {}
          resolve();
        });
      });
      req.on('error', resolve);
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.write(body); req.end();
    });

    return dotName; // return the dot-notation name so caller can update state
  } catch (e) {
    logger.warn('[skillCreator] user-memory registration failed (non-fatal)', { error: e.message });
    return null;
  }
}

// ── Main action: generate_skill ────────────────────────────────────────────────
async function actionGenerateSkill({ projectId, projectDir: projDir } = {}) {
  if (!projectId) return { ok: false, error: 'projectId is required' };

  const dir = projDir || path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Project dir not found: ' + dir };

  const planMd   = readFile(path.join(dir, 'plan.md'));
  const agentsMd = readFile(path.join(dir, 'agents.md'));

  if (!planMd)   return { ok: false, error: 'plan.md not found in ' + dir };
  if (!agentsMd) return { ok: false, error: 'agents.md not found in ' + dir };

  // Parse Skill Interface from plan.md
  const siIdx = planMd.indexOf('## Skill Interface');
  logger.info('[skillCreator] plan.md Skill Interface section', {
    projectId,
    hasSI: siIdx !== -1,
    preview: siIdx !== -1 ? planMd.slice(siIdx, siIdx + 300) : planMd.slice(-500),
  });
  const iface = parseSkillInterface(planMd);
  if (!iface.skillName) {
    // Derive skill_name from projectId (strip trailing random suffix like -mmbftg67)
    const derived = projectId
      .replace(/-[a-z0-9]{7,}$/, '')  // strip random suffix
      .replace(/^i-need-you-to-/, '') // strip verbose prefix
      .replace(/^i-want-to-/, '')
      .replace(/-+/g, '.')            // hyphens → dots (registry format)
      .replace(/\.+/g, '.')          // collapse multiple dots
      .replace(/^\.|\.$/g, '')       // trim leading/trailing dots
      .slice(0, 40)                   // max length
      .toLowerCase();
    iface.skillName = derived || 'generated.skill';
    logger.warn('[skillCreator] skill_name missing from plan.md — derived from projectId', { projectId, derived: iface.skillName });
  }
  if (!iface.trigger) {
    iface.trigger = iface.skillName.replace(/\./g, ' ');
  }

  logger.info('[skillCreator] generating skill', { projectId, skillName: iface.skillName });

  const agents        = parseAgents(agentsMd);
  const validateSpecs = readValidateSpecs(dir);

  // Generate skill code via LLM
  let raw;
  try {
    raw = await generateSkillCode(iface, agents, validateSpecs, planMd, agentsMd);
  } catch (e) {
    return { ok: false, error: 'LLM skill generation failed: ' + e.message };
  }

  let skillCode = stripFences(raw);
  if (!skillCode || skillCode.length < 50) {
    return { ok: false, error: 'LLM returned empty skill code' };
  }

  // ── Static validation before writing ──────────────────────────────────────
  // Full rule set absorbed from dead validateSkill.js node.
  // One auto-retry with fix feedback if any errors found.
  function staticCheckSkill(code) {
    const issues = [];
    // Blocked TS-only packages (no compiled JS, require() will fail at runtime)
    if (/require\s*\(\s*['"]clicksend['"]\s*\)/.test(code)) {
      issues.push(`BLOCKED_PKG: require('clicksend') — TS-only package. Use https.request() with Basic Auth (Buffer.from(secrets.CLICKSEND_USERNAME+':'+secrets.CLICKSEND_API_KEY).toString('base64')) to call the ClickSend REST API directly.`);
    }
    // ClickSend empty-username Basic auth — always returns invalid_request
    if (/clicksend|rest\.clicksend\.com/i.test(code)) {
      if (/Buffer\.from\s*\(`?['"]?:\s*\$\{/.test(code) || /Buffer\.from\s*\(':/.test(code) || /Buffer\.from\s*\(`:\s*/.test(code)) {
        issues.push(`CLICKSEND_BAD_AUTH: ClickSend Basic auth uses empty username (Buffer.from(':'+key)). This always fails. Use Buffer.from(secrets.CLICKSEND_USERNAME+':'+secrets.CLICKSEND_API_KEY).toString('base64') instead.`);
      }
      // ClickSend wrong payload format
      if (/["']to["']\s*:\s*(?:secrets|RECIPIENT|phone)/i.test(code) && !/messages\s*:/i.test(code)) {
        issues.push(`CLICKSEND_BAD_PAYLOAD: ClickSend SMS API requires payload { messages: [{ to, body, source }] } — not { to, message }. Fix the request body.`);
      }
    }
    // node-cron inside skill — scheduling is command-service skill-scheduler's job
    if (/require\s*\(\s*['"]node-cron['"]\s*\)/.test(code)) {
      issues.push(`NO_NODE_CRON: Do NOT require('node-cron') inside a skill. Scheduling is handled by the ThinkDrop command-service skill-scheduler daemon. The skill must only implement run() with core logic — no cron setup.`);
    }
    // Hardcoded secrets (real credential-length strings, not placeholder text)
    const hardcoded = code.match(/(?:const|let|var)\s+\w*(?:key|token|secret|password|api_key|apikey)\w*\s*=\s*['"`][A-Za-z0-9_\-]{20,}['"`]/i);
    if (hardcoded && !code.includes('keytar')) {
      issues.push(`HARDCODED_SECRET: Hardcoded credential detected. Use keytar.getPassword('thinkdrop', key) or context.secrets instead.`);
    }
    // Hardcoded placeholder values
    if (/['"](your_username|your_api_key|your_password|recipient_phone|sender_id|YOUR_[A-Z]|PLACEHOLDER)/i.test(code)) {
      issues.push(`HARDCODED_PLACEHOLDER: Placeholder literal found. All such values must come from context.secrets.`);
    }
    // eval / new Function — security violations
    if (/\beval\s*\(/.test(code)) {
      issues.push(`NO_EVAL: eval() is forbidden in ThinkDrop skills — security violation.`);
    }
    if (/new\s+Function\s*\(/.test(code)) {
      issues.push(`NO_NEW_FUNCTION: new Function() is forbidden — security violation.`);
    }
    // Must export a function
    if (!/module\.exports\s*=/.test(code)) {
      issues.push(`MUST_EXPORT: Skill must export a function via module.exports = async function run(args, context) { ... }`);
    }
    // process.exit() kills the host process
    if (/process\.exit\s*\(/.test(code)) {
      issues.push(`NO_PROCESS_EXIT: Do not call process.exit() — it will kill the ThinkDrop process.`);
    }
    // Placeholder hostnames
    if (/example\.com|placeholder\.com|your-api\.com|api\.example|sms-api\.|fake-api\.|dummy\.api/i.test(code)) {
      issues.push(`PLACEHOLDER_HOSTNAME: Fake hostname detected (e.g. example.com). Replace with the real API endpoint.`);
    }
    // TODO stubs
    if (/\/\/\s*TODO|\/\*\s*TODO|\/\/\s*FIXME|\/\/\s*implement this|\/\/\s*add your/i.test(code)) {
      issues.push(`TODO_STUB: TODO/FIXME comment found — implementation is incomplete. Replace all stubs with working code.`);
    }
    // fetch() without node-fetch
    if (/\bfetch\s*\(/.test(code) && !code.includes("require('node-fetch')") && !code.includes('require("node-fetch")')) {
      issues.push(`NO_FETCH_IN_CJS: fetch() is not available in Node CJS. Use const https = require('https') instead.`);
    }
    // Fake/non-existent CLIs invoked via execSync/spawn/exec — these don't exist as npm packages
    const fakeClis = ['gmail-cli', 'imessage-cli', 'imessage', 'messages-cli', 'apple-messages', 'mail-cli', 'outlook-cli', 'gmail-send', 'send-imessage', 'imessage-send'];
    for (const cli of fakeClis) {
      if (code.includes(cli)) {
        issues.push(`FAKE_CLI: "${cli}" is not a real npm package or CLI tool — it does not exist. Use a real published npm package or the service's official REST API instead.`);
      }
    }
    // execSync/spawn used for messaging (never acceptable — use real APIs)
    if (/execSync|spawnSync|exec\(|spawn\(/.test(code)) {
      const shellCalls = code.match(/(?:execSync|spawnSync|exec|spawn)\s*\([^)]*(?:mail|message|sms|imessage|gmail|send|curl)[^)]*\)/gi) || [];
      if (shellCalls.length > 0) {
        issues.push(`NO_SHELL_FOR_MESSAGING: Do not use execSync/spawn to invoke mail/messaging commands. Instead, use a suitable API or library for the service.`);
      }
    }
    // osascript / AppleScript for messaging — unreliable, not supported
    if (/osascript|applescript|tell application/i.test(code)) {
      issues.push(`NO_OSASCRIPT: Do not use osascript or AppleScript — these are platform-specific and unreliable in production. Instead, use a suitable API or library for the service.`);
    }
    return issues;
  }

  const staticIssues = staticCheckSkill(skillCode);
  if (staticIssues.length > 0) {
    logger.warn('[skillCreator] static checks failed, regenerating', { issues: staticIssues });
    try {
      const fixFeedback = 'The following errors were found in the generated code. Fix ALL of them:\n' +
        staticIssues.map(i => '- ' + i).join('\n');
      const retryRaw = await generateSkillCode(
        { ...iface, _fixFeedback: fixFeedback },
        agents, validateSpecs, planMd, agentsMd
      );
      const retryCode = stripFences(retryRaw);
      if (retryCode && retryCode.length > 50) {
        const retryIssues = staticCheckSkill(retryCode);
        if (retryIssues.length === 0) {
          skillCode = retryCode;
          logger.info('[skillCreator] retry passed static checks');
        } else {
          logger.warn('[skillCreator] retry still has issues (proceeding, recoverSkill will handle)', { retryIssues });
          skillCode = retryCode; // still use the retry — it may be partially better
        }
      }
    } catch (e) {
      logger.warn('[skillCreator] retry generation failed (using original)', { error: e.message });
    }
  }

  // ── skill.reviewer: post-gen validator + auto-patcher ───────────────────────
  // Queries api_rules for the services used in the generated code.
  // Auto-patches violations via a targeted LLM call before writing to disk.
  try {
    const skillReviewer = require('./skill.reviewer.cjs');
    const reviewResult  = await skillReviewer({ action: 'review_skill', code: skillCode, skillName: iface.skillName });
    if (reviewResult.ok && reviewResult.patched) {
      logger.info('[skillCreator] skill.reviewer auto-patched violations', {
        skillName: iface.skillName,
        remaining: reviewResult.violations?.length || 0,
      });
      skillCode = reviewResult.code;
    } else if (!reviewResult.ok) {
      logger.warn('[skillCreator] skill.reviewer error (non-fatal, proceeding)', { error: reviewResult.error });
    }
  } catch (e) {
    logger.warn('[skillCreator] skill.reviewer not available (non-fatal)', { error: e.message });
  }

  // Write the skill file directly to ~/.thinkdrop/skills/<dotName>/index.cjs
  // This is the canonical location — do NOT write to command-service/src/skills/
  const dotName    = iface.skillName.replace(/-/g, '.');
  const skillDir   = path.join(USER_SKILLS_DIR, dotName);
  const skillPath  = path.join(skillDir, 'index.cjs');
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, skillCode, 'utf8');
    logger.info('[skillCreator] skill file written to user skills dir', { skillPath });
  } catch (e) {
    return { ok: false, error: 'Failed to write skill file: ' + e.message };
  }

  // ── Detect deps from generated code, write package.json, run npm install ──
  // detectSkillDeps scans all require() calls, skips builtins + broken packages.
  // installSkillDeps merges into package.json (always adds keytar baseline) and
  // runs npm install --prefer-offline so external.skill can require() cleanly.
  const detectedDeps = detectSkillDeps(skillCode);
  const installResult = await installSkillDeps(skillDir, detectedDeps);
  if (!installResult.ok) {
    logger.warn('[skillCreator] npm install failed (non-fatal — recoverSkill will handle missing modules)', { error: installResult.error });
  }

  // ── Smoke test — require + invoke with dryRun:true in isolated child process ─
  // Confirms the module loads and exports a function. Missing-secret errors are
  // expected at this stage and treated as a pass.
  const smokeResult = await runSmokeTest(skillPath);
  if (!smokeResult.ok) {
    logger.warn('[skillCreator] smoke test failed', { error: smokeResult.error });
    // Non-fatal: skill is installed, recoverSkill handles runtime errors
  } else {
    logger.info('[skillCreator] smoke test passed', { output: smokeResult.output });
  }

  // Register in DuckDB + memory MCP
  const db = await getDb();
  await registerSkill(db, dotName, skillPath, iface, projectId);
  // registerInMemoryMCP calls /skill.install on user-memory MCP (skill already at skillPath)
  // Pass _skillCode so oauth providers can be auto-detected from require() patterns
  const registeredName = await registerInMemoryMCP(dotName, { ...iface, _skillCode: skillCode }, skillPath, planMd) || dotName;

  // If this skill has a recurring schedule, register it with the command-service skill-scheduler
  // (NOT the Electron overlay server — scheduling is owned by command-service, decoupled from Electron)
  if (iface.schedule && iface.schedule !== 'on_demand') {
    try {
      const cmdPort  = parseInt(process.env.PORT || process.env.COMMAND_SERVICE_PORT || '3007', 10);
      const schedBody = JSON.stringify({ skillName: dotName, schedule: iface.schedule, execPath: skillPath });
      await new Promise((resolve) => {
        const req = require('http').request({
          hostname: '127.0.0.1', port: cmdPort,
          path: '/skill.schedule', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(schedBody) },
          timeout: 4000,
        }, (res) => { res.resume(); res.on('end', resolve); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(schedBody); req.end();
      });
      logger.info('[skillCreator] registered schedule with command-service skill-scheduler', { skillName: dotName, schedule: iface.schedule });
    } catch (e) {
      logger.warn('[skillCreator] skill-scheduler registration failed (non-fatal, will sync on next interval)', { error: e.message });
    }
  }

  // Update project status in DuckDB
  if (db) {
    await db.run(
      'UPDATE projects SET status=?, updated_at=? WHERE id=?',
      'skill_ready', new Date().toISOString(), projectId
    ).catch(() => {});
  }

  return {
    ok: true,
    projectId,
    skillName:  registeredName,
    skillPath,
    trigger:    iface.trigger,
    schedule:   iface.schedule,
    secrets:    iface.secrets,
    agents:     agents.map(a => a.id),
    message:    'Skill "' + registeredName + '" generated and registered. Trigger: "' + iface.trigger + '"',
  };
}

// ── Main dispatcher ────────────────────────────────────────────────────────────
async function skillCreator(args) {
  const { action } = args || {};
  logger.info('[skillCreator] invoked', { action });
  switch (action) {
    case 'generate_skill': return actionGenerateSkill(args);
    default:
      return { ok: false, error: 'Unknown action: "' + action + '". Valid: generate_skill' };
  }
}

module.exports = skillCreator;
