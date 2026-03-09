'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const logger = require('../logger.cjs');
const { getDb } = require('./agents-db.cjs');

const PROJECTS_DIR = path.join(os.homedir(), '.thinkdrop', 'projects');
let _llmCallSeq = 0;

async function callLLM(systemPrompt, userPrompt, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  try {
    const WebSocket = require('ws');
    const WS_BASE = process.env.LLM_WS_URL || process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
    const url = new URL(WS_BASE);
    const apiKey = process.env.VSCODE_API_KEY || process.env.BACKEND_API_KEY || process.env.BASE_API_KEY || '';
    if (apiKey) url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('userId', 'creator_agent');
    url.searchParams.set('clientId', 'creator_' + Date.now() + '_' + (++_llmCallSeq));
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(url.toString());
      let answer = '';
      const timer = setTimeout(() => { ws.close(); reject(new Error('LLM timeout')); }, timeoutMs);
      ws.on('open', () => ws.send(JSON.stringify({
        id: 'cre_' + Date.now(), type: 'llm_request',
        payload: { prompt: userPrompt, provider: 'openai', options: { temperature: 0.2, stream: true, taskType: 'ask' },
          context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] } },
        timestamp: Date.now(), metadata: { source: 'creator_agent' },
      })));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'llm_stream_chunk') answer += msg.payload?.chunk || msg.payload?.text || '';
          else if (msg.type === 'llm_stream_end') { clearTimeout(timer); ws.close(); resolve(answer); }
          else if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.payload?.message || 'LLM error')); }
          // ignore: connection_status, llm_stream_start, and other control messages
        } catch { /* ignore non-JSON frames */ }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => {
        clearTimeout(timer);
        if (answer.trim().length > 0) resolve(answer);
        else reject(new Error('LLM WS closed before sending any content'));
      });
    });
  } catch {
    const http = require('http');
    const body = JSON.stringify({ payload: { skill: 'llm.generate', args: { systemPrompt, userPrompt } } });
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10),
        path: '/command.automate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)?.data?.answer || raw); } catch { resolve(raw); } });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.write(body); req.end();
    });
  }
}

function slugify(t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
function makeId(prompt, name) { return (name ? slugify(name) : slugify(prompt.slice(0, 50))) + '-' + Date.now().toString(36); }
function projectDir(id) { return path.join(PROJECTS_DIR, id); }
function writeFile(id, rel, content) {
  const full = path.join(projectDir(id), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}
async function dbSave(db, r) {
  if (!db) return;
  await db.run(
    `INSERT INTO projects (id,prompt,name,bdd_tests,agents_plan,tech_stack,prototype_path,reviewer_verdict,reviewer_notes,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET bdd_tests=excluded.bdd_tests,agents_plan=excluded.agents_plan,
     tech_stack=excluded.tech_stack,prototype_path=excluded.prototype_path,
     reviewer_verdict=excluded.reviewer_verdict,reviewer_notes=excluded.reviewer_notes,
     status=excluded.status,updated_at=excluded.updated_at`,
    r.id, r.prompt, r.name||null, r.bdd_tests||null, r.agents_plan||null,
    r.tech_stack||null, r.prototype_path||null, r.reviewer_verdict||'pending',
    r.reviewer_notes||null, r.status||'planning', new Date().toISOString(), new Date().toISOString()
  );
}

// ── Phase 1: BDD tests ────────────────────────────────────────────────────────
const P1_SYS = `You are a senior QA engineer writing Gherkin BDD acceptance tests.
Write FAILING tests that define success BEFORE any code exists.
Cover: happy path, empty results, auth failure, rate limits, timeouts, bad input, permission errors.
Each Scenario must be independently runnable.
Output raw Gherkin only (Feature/Scenario/Given/When/Then/And). No markdown fences, no prose.`;

async function phase1(id, prompt) {
  logger.info('[creator.agent] Phase 1: BDD tests', { id });
  const gherkin = await callLLM(P1_SYS, 'Write BDD acceptance tests for:\n\n' + prompt);
  if (!gherkin || gherkin.trim().length < 20) throw new Error('Phase 1: empty BDD response (len=' + (gherkin || '').length + ')');
  writeFile(id, 'tests/acceptance.feature', gherkin.trim());
  return gherkin.trim();
}

// ── Phase 2: plan.md + agents.md ─────────────────────────────────────────────
const P2_PLAN_SYS = `You are a solution architect. Output a Markdown project plan with exactly these sections:
## Overview
## Tech Stack
(every npm package, CLI tool, system dependency; flag ones needing API keys or network)
## API Surface
(each external endpoint: URL, auth method, rate limits, known failure modes)
## Risk Notes
(what breaks at runtime; how to handle each: rate limits, auth expiry, flaky selectors, OS differences)
## Agents Needed
For each agent:
### <agent-id>
- type: cli | browser
- role: what it does in this project
- capabilities: bullet list
- auth: how it authenticates
## Skill Interface
This section is REQUIRED. It defines the machine-readable interface for the generated skill.
- skill_name: kebab-case name (e.g. gmail-daily-summary)
- trigger: comma-separated natural language phrases that invoke this skill
- inputs: YAML-style key: type pairs for runtime args (e.g. phone_number: string, timezone: string)
- outputs: YAML-style key: type pairs returned after execution (e.g. sms_sent: boolean, message_count: integer)
- secrets: EXHAUSTIVE list of every environment variable the skill needs at runtime — include ALL of: OAuth client IDs, client secrets, redirect URIs, refresh tokens, API keys, account SIDs, auth tokens, encryption keys, phone numbers, service usernames/account logins, and any other service credential. Do NOT omit any. IMPORTANT: Many REST APIs require BOTH a username AND an API key for Basic auth — list BOTH as separate secrets. Example: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_REFRESH_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, MY_PHONE_NUMBER, ENCRYPTION_KEY, CLICKSEND_USERNAME, CLICKSEND_API_KEY
- schedule: cron expression OR special pattern (see SCHEDULE RULES below) if this runs on a schedule, or "on_demand" if triggered manually
- runtime: node | python | shell

SCHEDULE RULES — CRITICAL. The schedule field must contain one of:
1. A standard 5-part cron expression: "MIN HOUR DOM MON DOW"
   - "daily at 9pm"          → "0 21 * * *"
   - "every day at 8am"      → "0 8 * * *"
   - "every hour"            → "0 * * * *"
   - "weekdays at 6pm"       → "0 18 * * 1-5"
   - "every 30 minutes"      → "*/30 * * * *"
2. A RANDOM_WINDOW pattern for randomized or spread-out firing:
   Format: RANDOM_WINDOW(count=N,start=HH:MM,end=HH:MM,min_gap_minutes=M,days=DOW)
   - "3 times a day randomly between 8am-5pm, at least 30min apart on weekdays"
     → RANDOM_WINDOW(count=3,start=08:00,end=17:00,min_gap_minutes=30,days=1-5)
   - "twice daily between 9am and 6pm with 2 hours between each"
     → RANDOM_WINDOW(count=2,start=09:00,end=18:00,min_gap_minutes=120,days=*)
3. "on_demand" — skill is only triggered manually, never on a schedule

NEVER use vague strings like "daily", "nightly", "every day". Always convert to an exact cron or RANDOM_WINDOW.

SKILL RUNTIME CAPABILITIES — every generated skill receives these in its context object at runtime:
- context.db — persistent KV store + semantic memory (HTTP to user-memory MCP port 3001):
  - context.db.set(skillName, key, value) / get / del / list — for deduplication, caching, last-run timestamps
  - context.db.remember(skillName, text) / recall(skillName, query) — semantic memory search via embeddings
  - Use db for: deduplication (track seen email IDs, notification IDs), caching API responses, storing user preferences
- context.llm — LLM reasoning (WebSocket to LLM backend):
  - context.llm.ask(prompt) — single question
  - context.llm.askWithMessages([{role,content}]) — multi-turn with system prompt
  - Use llm for: summarizing content, classifying/categorizing data, generating text from structured data
- When the project requires summarization, classification, or stateful memory between runs — plan for context.db and context.llm usage. Skills do NOT need to require() any external db or LLM library.

DEPENDENCY RULES — CRITICAL. The plan MUST follow these or it will be rejected:
- NEVER invent CLI tools that don't exist on npm or homebrew as real, published packages. Every CLI or npm package listed in Tech Stack must be a real, publicly available package.
- Known fake/non-existent CLIs that must NEVER appear: gmail-cli, imessage-cli, messages-cli, apple-messages, mail-cli, outlook-cli.
- All phone numbers, recipient addresses, and other service credentials are secrets stored in keytar — list them in the secrets field (e.g. CLICKSEND_TO_PHONE, TWILIO_TO_NUMBER), never as hardcoded values or runtime args.
- REST APIs using HTTP Basic Auth require BOTH parts: the account username AND the API key/password. Both are secrets. For ClickSend: CLICKSEND_USERNAME (the account email/login) + CLICKSEND_API_KEY. For any Basic Auth API, always declare both separately in secrets.
Output: Markdown only.`;

const P2_AGENTS_SYS = `You are a senior engineer designing the agent roster for a software project.
List every agent needed to deliver the project. For each agent produce a planning spec.

Use EXACTLY this format for each agent — the ## heading MUST be the agent's machine ID (lowercase, dots/hyphens only):

## github.agent
- type: cli
- role: what this agent does in the project
- capabilities:
  - capability_one
  - capability_two
- auth: how it authenticates (e.g. OAuth2, API key via env var, gh auth login)
- validate_agent:
  - version_check: command to check CLI/tool version
  - auth_health: how to verify auth without a live API call
  - smoke_test: one command to confirm it works end-to-end
  - self_heal: what to do if auth is expired or tool is missing

Use real agent IDs that match the service: github.agent, gmail.agent, slack.agent, browser.agent, etc.

AGENT RULES — CRITICAL. These are hard constraints, not suggestions:
- NEVER create agents that use fake or non-existent CLI tools. Every CLI in validate_agent commands must be a real, published tool.
- Known fake CLIs that must NEVER appear in any agent spec: gmail-cli, imessage-cli, messages-cli, apple-messages, mail-cli, outlook-cli.
- Real CLI agents that DO exist: gh (GitHub), aws, gcloud, stripe, heroku, fly, railway, vercel, netlify, npm, yarn, twilio (Twilio CLI).
Output: Markdown only. No prose before or after the agent sections.`;

// Validate.agent spec system prompt — one per agent, focused on that agent only
const VALIDATE_AGENT_SYS = `You are a senior reliability engineer writing a validate.agent specification.
A validate.agent is paired 1:1 with a specific agent. It is the reviewer for that agent — it runs checks,
detects failures, applies self-healing actions, and reports back. Think of it as the reviewer.agent
relationship but scoped entirely to one agent's health and capabilities.

You will receive: the agent's ID, type (cli|browser), role, capabilities, and auth method.

Write a complete validate.agent spec in Markdown covering:

## Identity
- agent_id: <id>
- validates: <agent being validated>
- type: cli | browser
- trigger: on_use | scheduled | on_failure

## 1. Pre-flight Checks
- Tool/binary existence check (exact command)
- Version check (minimum required, detection command, auto-upgrade action if stale)
- Auth validity check (no real API call if possible — check token file, env var, or dry-run command)

## 2. Capability Smoke Tests
For EACH capability listed:
- Command or action to run
- Expected output pattern (regex or string)
- How to distinguish real success from false-positive

## 3. Failure Detection
For each of these failure modes, exact detection method + self-heal action:
- Auth expired / token revoked
- Rate limited
- Missing scope / permission denied
- CLI version too old / selector changed
- Network timeout or unreachable
- Silent failure (exit 0 but broken output)

## 4. Self-Heal Runbook
Ordered steps validate.agent takes before escalating to the user:
1. Detect failure mode
2. Attempt auto-fix (re-auth, update descriptor, retry with backoff)
3. If still failing: patch the agent descriptor in DuckDB with updated instructions
4. Escalate to user only if auto-fix exhausted

## 5. Log Scan Patterns
Regex patterns in stdout/stderr/browser console that signal silent failure.

## 6. Health Report Schema
JSON schema for what validate.agent writes back to DuckDB after each run:
{ status, last_checked, capabilities_ok, failures, self_healed, escalation_needed }

Output: Markdown only.`;

async function generateValidateAgentSpec(agentId, agentSection, prompt) {
  const userCtx = [
    'Agent ID: ' + agentId,
    'Project context: ' + prompt.slice(0, 400),
    '',
    'Agent spec from agents.md:',
    agentSection.slice(0, 2000),
  ].join('\n');
  return callLLM(VALIDATE_AGENT_SYS, userCtx, 90000);
}

// ── Detect service names from a free-text project description ──────────────────
const PROMPT_SERVICE_DETECTORS = [
  { pattern: /clicksend/i,                       service: 'clicksend' },
  { pattern: /twilio/i,                          service: 'twilio' },
  { pattern: /stripe/i,                          service: 'stripe' },
  { pattern: /sendgrid/i,                        service: 'sendgrid' },
  { pattern: /mailgun/i,                         service: 'mailgun' },
  { pattern: /gmail|google mail|googleapis/i,    service: 'gmail' },
  { pattern: /github/i,                          service: 'github' },
  { pattern: /slack/i,                           service: 'slack' },
  { pattern: /notion/i,                          service: 'notion' },
  { pattern: /airtable/i,                        service: 'airtable' },
  { pattern: /hubspot/i,                         service: 'hubspot' },
  { pattern: /salesforce/i,                      service: 'salesforce' },
  { pattern: /openai/i,                          service: 'openai' },
  { pattern: /anthropic/i,                       service: 'anthropic' },
  { pattern: /dropbox/i,                         service: 'dropbox' },
  { pattern: /discord/i,                         service: 'discord' },
  { pattern: /spotify/i,                         service: 'spotify' },
  { pattern: /zoom/i,                            service: 'zoom' },
  { pattern: /jira|atlassian/i,                  service: 'atlassian' },
  { pattern: /aws |amazon web|s3\b|lambda|ec2/i, service: 'aws' },
  { pattern: /azure/i,                           service: 'azure' },
  { pattern: /vonage|messagebird/i,              service: 'vonage' },
  { pattern: /plaid/i,                           service: 'plaid' },
  { pattern: /shopify/i,                         service: 'shopify' },
  { pattern: /sms|text message/i,                service: 'clicksend' },
];

function detectServicesFromPrompt(text) {
  const found = new Set();
  for (const { pattern, service } of PROMPT_SERVICE_DETECTORS) {
    if (pattern.test(text)) found.add(service);
  }
  return [...found];
}

async function fetchApiRulesForPrompt(promptText) {
  const services = detectServicesFromPrompt(promptText);
  if (!services.length) return '';
  try {
    const http = require('http');
    const MEM_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
    const body = JSON.stringify({ payload: { services }, requestId: 'creator-agent-' + Date.now() });
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
    const lines = results.map(r => `- [${r.service}:${r.ruleType}] ${r.ruleText}`);
    return `\n\nKNOWN API CONSTRAINTS (from api_rules DB — these are hard requirements, not suggestions):\n${lines.join('\n')}`;
  } catch (_) {
    return '';
  }
}

async function phase2(id, prompt, bddTests) {
  logger.info('[creator.agent] Phase 2: agent plan', { id });

  // Inject api_rules constraints for detected services into the plan context
  const apiConstraints = await fetchApiRulesForPrompt(prompt).catch(() => '');
  const ctx = 'Project:\n' + prompt + (apiConstraints ? apiConstraints : '') + '\n\nAcceptance tests:\n' + bddTests;

  if (apiConstraints) {
    logger.info('[creator.agent] Phase 2: injecting api_rules constraints into plan prompt', { id });
  }

  const [planMd, agentsMd] = await Promise.all([
    callLLM(P2_PLAN_SYS, ctx, 120000),
    callLLM(P2_AGENTS_SYS, ctx, 120000),
  ]);
  if (!planMd || planMd.trim().length < 20) throw new Error('Phase 2: empty plan.md response (len=' + (planMd || '').length + ')');
  if (!agentsMd || agentsMd.trim().length < 20) throw new Error('Phase 2: empty agents.md response (len=' + (agentsMd || '').length + ')');

  // Ensure ## Skill Interface is present — if the LLM omitted it, generate it now with a
  // dedicated focused call before writing plan.md. This is creator.agent's responsibility.
  let finalPlanMd = planMd.trim();
  if (!finalPlanMd.includes('## Skill Interface')) {
    logger.warn('[creator.agent] Phase 2: plan.md missing ## Skill Interface — generating dedicated section', { id });
    const siSys = `You are a solution architect. Given a project plan and description, output ONLY the "## Skill Interface" markdown section with exactly these fields and no other text:

## Skill Interface
- skill_name: kebab-case name (e.g. gmail-daily-summary)
- trigger: comma-separated natural language phrases that invoke this skill
- inputs: YAML-style key: type pairs for runtime args
- outputs: YAML-style key: type pairs
- secrets: comma-separated list of ALL environment variable names needed (OAuth tokens, API keys, account SIDs, phone numbers, etc.)
- schedule: cron expression or "on_demand"
- runtime: node`;
    const siPrompt = 'Project description: ' + prompt + '\n\nProject plan:\n' + finalPlanMd.slice(0, 2000);
    try {
      const siRaw = await callLLM(siSys, siPrompt, 60000);
      const siClean = siRaw.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      if (siClean.includes('skill_name')) {
        finalPlanMd = finalPlanMd + '\n\n' + siClean;
        logger.info('[creator.agent] Phase 2: ## Skill Interface appended to plan.md', { id });
      }
    } catch (e) {
      logger.warn('[creator.agent] Phase 2: ## Skill Interface generation failed', { id, error: e.message });
    }
  }

  writeFile(id, 'plan.md', finalPlanMd);
  writeFile(id, 'agents.md', agentsMd.trim());
  const agentIds = (agentsMd.match(/^## ([a-zA-Z0-9._-]+)/gm) || []).map(m => m.replace('## ', '').trim());
  const techSection = (finalPlanMd.match(/## Tech Stack\n([\s\S]*?)(?=\n##|$)/) || [])[1] || '';

  // Generate a paired validate.agent spec for every agent planned in agents.md
  // Each spec is written to agents/<agentId>.validate.md alongside the project
  if (agentIds.length > 0) {
    logger.info('[creator.agent] Phase 2: generating validate.agent specs', { id, agentIds });
    // Extract each agent's section from agents.md for focused spec generation
    const agentSections = {};
    for (const aid of agentIds) {
      const match = agentsMd.match(new RegExp('## ' + aid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?=\\n## |$)'));
      agentSections[aid] = match ? match[0] : '## ' + aid + '\n(no spec found)';
    }
    // Generate all validate.agent specs in parallel
    const specs = await Promise.all(
      agentIds.map(aid => generateValidateAgentSpec(aid, agentSections[aid], prompt)
        .catch(e => '# validate.agent spec generation failed\nError: ' + e.message))
    );
    for (let i = 0; i < agentIds.length; i++) {
      writeFile(id, path.join('agents', agentIds[i] + '.validate.md'), specs[i].trim());
      logger.info('[creator.agent] Phase 2: validate.agent spec written', { id, agent: agentIds[i] });
    }
  }

  logger.info('[creator.agent] Phase 2 done', { id, agentIds });
  return { planMd: finalPlanMd, agentsMd: agentsMd.trim(), agentIds, techStack: techSection.trim() };
}

// ── Phase 3: Runnable prototype (one file per LLM call to avoid truncation) ───
// Each call generates a single file — small output, no truncation risk.

function makeFileCtx(prompt, planMd, bddTests) {
  return [
    'Project: ' + prompt,
    '\nTech stack and API surface (from plan.md):\n' + planMd.slice(0, 1200),
    '\nBDD tests:\n' + bddTests.slice(0, 600),
  ].join('\n');
}

function stripFences(content) {
  // Remove ```lang ... ``` or ``` ... ``` wrappers that LLM adds despite instructions
  return content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

async function genFile(filePath, instruction, ctx) {
  const sys = `You are a senior developer. Output ONLY the raw file content for "${filePath}". No markdown fences, no explanation, no JSON wrapper — just the file content itself.`;
  const raw = await callLLM(sys, instruction + '\n\n' + ctx, 90000);
  return stripFences(raw);
}

async function phase3(id, prompt, bddTests, planMd, agentsMd) {
  logger.info('[creator.agent] Phase 3: prototype scaffold', { id });
  const ctx = makeFileCtx(prompt, planMd, bddTests);
  const written = [];

  // package.json first — index.js imports depend on knowing the deps
  try {
    const pkgContent = await genFile('package.json',
      'Write a complete package.json with: name, version, description, "start" script (node index.js), all required npm dependencies pinned to exact versions, and devDependencies including jest.',
      ctx);
    writeFile(id, 'prototype/package.json', pkgContent.trim());
    written.push('package.json');
  } catch (e) { logger.warn('[creator.agent] Phase 3 package.json failed', { error: e.message }); }

  // index.js — the main entry point
  try {
    const indexContent = await genFile('index.js',
      'Write a complete, runnable index.js entry point. Mock all HTTP calls and OAuth flows using inline stubs or __mocks__/. Use process.env for credentials. Must run without hitting the network.',
      ctx);
    writeFile(id, 'prototype/index.js', indexContent.trim());
    written.push('index.js');
  } catch (e) { logger.warn('[creator.agent] Phase 3 index.js failed', { error: e.message }); }

  // run.sh
  try {
    writeFile(id, 'prototype/run.sh', '#!/usr/bin/env bash\nset -e\nnpm install\nnpm start\n');
    fs.chmodSync(path.join(projectDir(id), 'prototype', 'run.sh'), 0o755);
    written.push('run.sh');
  } catch (_) {}

  // tests/acceptance.test.js
  try {
    const testContent = await genFile('tests/acceptance.test.js',
      'Write unit tests using jest (describe/it/expect) that cover each BDD scenario. Mock all external calls. Each test must be independently runnable.',
      ctx);
    writeFile(id, 'prototype/tests/acceptance.test.js', testContent.trim());
    written.push('tests/acceptance.test.js');
  } catch (e) { logger.warn('[creator.agent] Phase 3 test file failed', { error: e.message }); }

  logger.info('[creator.agent] Phase 3 done', { id, fileCount: written.length, written });
  return { ok: written.length > 0, files: written, protoDir: path.join(projectDir(id), 'prototype') };
}

// ── action: create_project ────────────────────────────────────────────────────
async function actionCreateProject({ prompt, name } = {}) {
  if (!prompt?.trim()) return { ok: false, error: 'prompt is required' };
  const db = await getDb();
  const id = makeId(prompt, name);
  fs.mkdirSync(projectDir(id), { recursive: true });
  logger.info('[creator.agent] create_project', { id });
  const rec = { id, prompt, name: name || id, status: 'planning',
    bdd_tests: null, agents_plan: null, tech_stack: null,
    prototype_path: null, reviewer_verdict: 'pending', reviewer_notes: null };
  await dbSave(db, rec);
  try {
    // Phase 1
    rec.bdd_tests = await phase1(id, prompt);
    await dbSave(db, rec);
    // Phase 2
    const { planMd, agentsMd, agentIds, techStack } = await phase2(id, prompt, rec.bdd_tests);
    rec.agents_plan = JSON.stringify({ planMd, agentsMd, agentIds });
    rec.tech_stack = techStack;
    rec.status = 'prototype';
    await dbSave(db, rec);
    // Phase 3
    const p3 = await phase3(id, prompt, rec.bdd_tests, planMd, agentsMd);
    rec.prototype_path = p3.protoDir;
    rec.status = 'review';
    await dbSave(db, rec);
    logger.info('[creator.agent] create_project complete', { id, status: 'review' });
    return {
      ok: true, id, dir: projectDir(id), status: 'review', agentIds,
      protoDir: p3.protoDir,
      files: {
        bddTests: path.join(projectDir(id), 'tests', 'acceptance.feature'),
        plan:     path.join(projectDir(id), 'plan.md'),
        agents:   path.join(projectDir(id), 'agents.md'),
        prototype: p3.protoDir,
      },
      message: 'Project "' + id + '" ready for reviewer.agent. Run validate_project to gate it.',
    };
  } catch (err) {
    rec.status = 'error';
    rec.reviewer_notes = err.message;
    await dbSave(db, rec);
    logger.error('[creator.agent] create_project failed', { id, error: err.message });
    return { ok: false, id, error: err.message };
  }
}

// ── action: run_prototype ─────────────────────────────────────────────────────
async function actionRunPrototype({ id } = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  const db = await getDb();
  let protoDir;
  if (db) {
    const row = await db.get('SELECT prototype_path FROM projects WHERE id = ?', id);
    protoDir = row?.prototype_path;
  }
  if (!protoDir) protoDir = path.join(projectDir(id), 'prototype');
  if (!fs.existsSync(protoDir)) return { ok: false, error: 'Prototype not found: ' + protoDir };
  if (!fs.existsSync(path.join(protoDir, 'package.json'))) return { ok: false, error: 'No package.json in prototype' };
  try { execSync('npm install', { cwd: protoDir, stdio: 'pipe', timeout: 120000 }); }
  catch (e) { return { ok: false, error: 'npm install failed: ' + e.message }; }
  const child = spawn('npm', ['start'], { cwd: protoDir, detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, id, protoDir, message: 'Prototype started (pid ' + child.pid + '). cd "' + protoDir + '" to inspect.' };
}

// ── action: query_project ─────────────────────────────────────────────────────
async function actionQueryProject({ id } = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  const db = await getDb();
  if (!db) return { ok: false, error: 'DuckDB not available' };
  const row = await db.get('SELECT * FROM projects WHERE id = ?', id);
  if (!row) return { ok: false, error: 'Project not found: ' + id };
  const dir = projectDir(id);
  return {
    ok: true, project: row, dir,
    files: {
      bddTests: fs.existsSync(path.join(dir, 'tests', 'acceptance.feature')) ? path.join(dir, 'tests', 'acceptance.feature') : null,
      plan:     fs.existsSync(path.join(dir, 'plan.md'))   ? path.join(dir, 'plan.md')   : null,
      agents:   fs.existsSync(path.join(dir, 'agents.md')) ? path.join(dir, 'agents.md') : null,
    },
  };
}

// ── action: list_projects ─────────────────────────────────────────────────────
async function actionListProjects() {
  const db = await getDb();
  if (!db) return { ok: false, error: 'DuckDB not available' };
  const rows = await db.all('SELECT id, name, status, reviewer_verdict, created_at FROM projects ORDER BY created_at DESC');
  return { ok: true, projects: rows };
}

// ── action: validate_project — calls reviewer.agent ──────────────────────────
async function actionValidateProject({ id } = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  const db = await getDb();
  const row = db ? await db.get('SELECT * FROM projects WHERE id = ?', id) : null;
  if (!row) return { ok: false, error: 'Project not found: ' + id };

  const dir = projectDir(id);
  const planExists    = fs.existsSync(path.join(dir, 'plan.md'));
  const agentsExists  = fs.existsSync(path.join(dir, 'agents.md'));
  const testsExist    = fs.existsSync(path.join(dir, 'tests', 'acceptance.feature'));
  const protoExists   = fs.existsSync(path.join(dir, 'prototype', 'index.js'));
  const pkgExists     = fs.existsSync(path.join(dir, 'prototype', 'package.json'));

  // Try to delegate to reviewer.agent if available
  try {
    const http = require('http');
    const body = JSON.stringify({ payload: { skill: 'reviewer.agent', args: { action: 'review', projectId: id, projectDir: dir } } });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: parseInt(process.env.COMMAND_SERVICE_PORT || '3001', 10),
        path: '/command.automate', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ ok: false }); } });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('reviewer.agent timeout')); });
      req.on('error', reject);
      req.write(body); req.end();
    });
    if (result?.data?.ok || result?.ok) {
      const verdict = result?.data?.verdict || result?.verdict || 'pass';
      const notes   = result?.data?.notes   || result?.notes   || '';
      if (db) {
        await db.run('UPDATE projects SET reviewer_verdict=?, reviewer_notes=?, status=?, updated_at=? WHERE id=?',
          verdict, notes, verdict === 'pass' ? 'ready' : 'review', new Date().toISOString(), id);
      }
      return { ok: true, id, verdict, notes };
    }
  } catch (_) { /* reviewer.agent not yet available — fall through to built-in checklist */ }

  // Built-in lightweight checklist (pre-reviewer.agent)
  const issues = [];
  if (!planExists)   issues.push({ severity: 'error',   msg: 'plan.md missing' });
  if (!agentsExists) issues.push({ severity: 'error',   msg: 'agents.md missing' });
  if (!testsExist)   issues.push({ severity: 'error',   msg: 'tests/acceptance.feature missing' });
  if (!protoExists)  issues.push({ severity: 'warning', msg: 'prototype/index.js missing' });
  if (!pkgExists)    issues.push({ severity: 'warning', msg: 'prototype/package.json missing' });

  // Try running prototype tests
  const protoDir = path.join(dir, 'prototype');
  if (pkgExists) {
    try {
      const result = execSync('npm test --if-present 2>&1', { cwd: protoDir, timeout: 60000, encoding: 'utf8' });
      if (/failed|error/i.test(result)) {
        issues.push({ severity: 'warning', msg: 'Prototype tests have failures', detail: result.slice(0, 500) });
      }
    } catch (e) {
      issues.push({ severity: 'warning', msg: 'Prototype test run failed: ' + e.message.slice(0, 200) });
    }
  }

  const hasErrors = issues.some(i => i.severity === 'error');
  const verdict   = hasErrors ? 'fail' : issues.length === 0 ? 'pass' : 'pass-with-warnings';
  const notes     = issues.map(i => '[' + i.severity + '] ' + i.msg).join('\n');

  if (db) {
    await db.run('UPDATE projects SET reviewer_verdict=?, reviewer_notes=?, status=?, updated_at=? WHERE id=?',
      verdict, notes, verdict === 'pass' || verdict === 'pass-with-warnings' ? 'ready' : 'review', new Date().toISOString(), id);
  }

  return { ok: true, id, verdict, issues, notes };
}

// ── action: patch_project — applies reviewer feedback iteratively ─────────────
// Called by creatorPlanning node after a reviewer 'fail' or 'pass-with-warnings'
// with concrete blockers/patches. Fixes each affected file via a targeted LLM call.
async function actionPatchProject({ id, reviewVerdict, blockers = [], warnings = [], patches = [], dimensions = {}, summary = '' } = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  const db = await getDb();
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) return { ok: false, error: 'Project dir not found: ' + dir };

  logger.info('[creator.agent] patch_project start', { id, blockers: blockers.length, patches: patches.length });

  // Build a concise feedback brief for the LLM
  const feedbackBrief = [
    'Reviewer verdict: ' + reviewVerdict,
    summary ? 'Summary: ' + summary : '',
    blockers.length  ? 'BLOCKERS (must fix):\n' + blockers.map(b => '- ' + b).join('\n') : '',
    warnings.length  ? 'WARNINGS (should fix):\n' + warnings.map(w => '- ' + w).join('\n') : '',
    patches.length   ? 'SUGGESTED PATCHES:\n' + patches.map(p => '- ' + p).join('\n') : '',
    dimensions?.security?.findings?.length    ? 'Security issues:\n' + dimensions.security.findings.map(f => '- ' + f).join('\n') : '',
    dimensions?.technicalSoundness?.findings?.length ? 'Technical issues:\n' + dimensions.technicalSoundness.findings.map(f => '- ' + f).join('\n') : '',
    dimensions?.completeness?.findings?.length ? 'Completeness gaps:\n' + dimensions.completeness.findings.map(f => '- ' + f).join('\n') : '',
  ].filter(Boolean).join('\n\n');

  // Determine which files need patching based on feedback content
  const filesToPatch = [];
  const lower = (feedbackBrief + ' ' + patches.join(' ')).toLowerCase();

  if (lower.includes('index.js') || lower.includes('technical') || lower.includes('runtime') || lower.includes('bug') || lower.includes('loop') || lower.includes('await') || lower.includes('import') || lower.includes('prototype')) {
    filesToPatch.push('prototype/index.js');
  }
  if (lower.includes('package.json') || lower.includes('dep') || lower.includes('script') || lower.includes('version')) {
    filesToPatch.push('prototype/package.json');
  }
  if (lower.includes('plan.md') || lower.includes('completeness') || lower.includes('api surface') || lower.includes('risk') || lower.includes('missing section') || lower.includes('agent coverage')) {
    filesToPatch.push('plan.md');
  }
  if (lower.includes('agents.md') || lower.includes('agent coverage') || lower.includes('validate_agent') || lower.includes('agent spec')) {
    filesToPatch.push('agents.md');
  }
  if (lower.includes('acceptance') || lower.includes('bdd') || lower.includes('scenario') || lower.includes('test')) {
    filesToPatch.push('tests/acceptance.feature');
  }
  if (lower.includes('run.sh') || lower.includes('usability') || lower.includes('runnable')) {
    filesToPatch.push('prototype/run.sh');
  }
  // Only auto-add prototype/index.js + package.json if there are HARD blockers
  // (fake CLIs, hardcoded secrets, missing plan sections) — NOT prototype-only soft issues
  // like missing retry logic, mocked calls, incomplete error handling, etc.
  // Patching prototype files for soft issues causes the same issues to re-appear next round.
  const SOFT_BLOCKER_PATCH_RE = /register|registry|monitoring|logging|readme|retry|retries|backoff|error handling|graceful|edge case|timeout|rate limit|mock|mocked|stub|stubbed|placeholder|unit test|test coverage|test file|incomplete function|todo|missing await|console\.log|unpinned|devdependency|dev dependency|agent registration|not in registry|deploy time|deployment step|validate_agent|validate\.agent|validation spec|production standard|production quality/i;
  const hasHardBlockers = blockers.some(b => !SOFT_BLOCKER_PATCH_RE.test(b));
  if (hasHardBlockers) {
    if (!filesToPatch.includes('prototype/index.js'))    filesToPatch.push('prototype/index.js');
    if (!filesToPatch.includes('prototype/package.json')) filesToPatch.push('prototype/package.json');
  }
  // Always patch plan.md + agents.md when banned patterns are detected
  const bannedKeywords = ['gmail-cli', 'imessage-cli', 'imessage', 'osascript', 'applescript', 'messages.app', 'fake cli', 'banned_patterns', 'mail-cli', 'messages-cli'];
  if (bannedKeywords.some(kw => lower.includes(kw))) {
    if (!filesToPatch.includes('plan.md'))    filesToPatch.push('plan.md');
    if (!filesToPatch.includes('agents.md')) filesToPatch.push('agents.md');
    if (!filesToPatch.includes('prototype/index.js')) filesToPatch.push('prototype/index.js');
  }

  const patchedFiles = [];
  for (const rel of filesToPatch) {
    const fullPath = path.join(dir, rel);
    const existing = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf8') : '(file did not exist — create it from scratch)';
    const sys = `You are a senior developer applying code review feedback. You will receive:
1. The current file content
2. Reviewer feedback (blockers, warnings, patches)

Apply ALL the reviewer feedback that is relevant to this file. Output ONLY the complete corrected file content.
No markdown fences, no explanation, no JSON wrapper — just the corrected file content.
Preserve everything that is already correct. Only fix what the reviewer flagged.
CRITICAL: If the file is plan.md, you MUST preserve the ## Skill Interface section EXACTLY as-is. Never remove or modify it.

DEPENDENCY RULES — these MUST be enforced in every patched file:
- NEVER invent CLI packages. Known fake CLIs to remove: gmail-cli, imessage-cli, messages-cli, apple-messages, mail-cli, outlook-cli.
- All phone numbers, recipient addresses, and service credentials must come from context.secrets (stored in keytar), never hardcoded or runtime args.`;
    const prompt = [
      'File: ' + rel,
      '',
      '--- CURRENT CONTENT ---',
      existing.slice(0, 3000),
      existing.length > 3000 ? '...(truncated, fix the issues you can see)' : '',
      '',
      '--- REVIEWER FEEDBACK ---',
      feedbackBrief,
    ].join('\n');

    // For plan.md: snapshot the ## Skill Interface block before patching so we can
    // restore it if the LLM accidentally drops it (a common regression during patching).
    let skillInterfaceBlock = null;
    if (rel === 'plan.md') {
      // Greedy match to EOF — lazy quantifier misses when section is last in file.
      // Preserve the SI block even if skill_name is absent — skillCreator can derive it.
      // Only skip preservation if there's NO ## Skill Interface section at all.
      const siMatch = existing.match(/## Skill Interface[\s\S]*/);
      if (siMatch) skillInterfaceBlock = siMatch[0].trimEnd();
    }

    try {
      logger.info('[creator.agent] patch_project patching file', { id, file: rel });
      const patched = await callLLM(sys, prompt, 90000);
      let patchedClean = stripFences(patched || '');
      if (patchedClean.length > 10) {
        // Always strip any ## Skill Interface block the LLM wrote and re-append the
        // snapshotted original — this is the only way to guarantee it is never corrupted.
        if (rel === 'plan.md' && skillInterfaceBlock) {
          const stripped = patchedClean.replace(/\n## Skill Interface[\s\S]*$/, '').trimEnd();
          patchedClean = stripped + '\n\n' + skillInterfaceBlock;
          logger.info('[creator.agent] patch_project: ## Skill Interface enforced from snapshot', { id });
        }
        writeFile(id, rel, patchedClean);
        patchedFiles.push(rel);
        logger.info('[creator.agent] patch_project file patched', { id, file: rel });
      }
    } catch (e) {
      logger.warn('[creator.agent] patch_project file patch failed', { id, file: rel, error: e.message });
    }
  }

  // Update DB record
  if (db) {
    await db.run(
      'UPDATE projects SET status=?, reviewer_verdict=?, updated_at=? WHERE id=?',
      'review', 'pending', new Date().toISOString(), id
    ).catch(() => {});
  }

  logger.info('[creator.agent] patch_project done', { id, patchedFiles });
  return { ok: true, id, patchedFiles, feedbackApplied: feedbackBrief.slice(0, 300) };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function creatorAgent(args) {
  const { action } = args || {};
  logger.info('[creator.agent] invoked', { action });
  switch (action) {
    case 'create_project':   return actionCreateProject(args);
    case 'patch_project':    return actionPatchProject(args);
    case 'run_prototype':    return actionRunPrototype(args);
    case 'query_project':    return actionQueryProject(args);
    case 'list_projects':    return actionListProjects();
    case 'validate_project': return actionValidateProject(args);
    default:
      return { ok: false, error: 'Unknown action: "' + action + '". Valid: create_project | patch_project | run_prototype | query_project | list_projects | validate_project' };
  }
}

module.exports = creatorAgent;
