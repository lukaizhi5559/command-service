'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const logger = require('../logger.cjs');

const PROJECTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const PROJECTS_DIR = path.join(os.homedir(), '.thinkdrop', 'projects');

let _db = null;
async function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(PROJECTS_DB_PATH), { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  try {
    const duckdbAsync = require('duckdb-async');
    _db = await duckdbAsync.Database.create(PROJECTS_DB_PATH);
  } catch {
    try {
      const { Database } = require('duckdb');
      const raw = await new Promise((resolve, reject) => {
        const db = new Database(PROJECTS_DB_PATH, (err) => { if (err) reject(err); else resolve(db); });
      });
      _db = {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise((res) => raw.close(() => res())),
      };
    } catch { return null; }
  }
  await _db.run(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, prompt TEXT NOT NULL, name TEXT,
    bdd_tests TEXT, agents_plan TEXT, tech_stack TEXT, prototype_path TEXT,
    reviewer_verdict TEXT DEFAULT 'pending', reviewer_notes TEXT,
    status TEXT NOT NULL DEFAULT 'planning',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  return _db;
}

async function callLLM(systemPrompt, userPrompt, timeoutMs) {
  timeoutMs = timeoutMs || 120000;
  try {
    const WebSocket = require('ws');
    const WS_URL = process.env.LLM_WS_URL || 'ws://127.0.0.1:3010/llm';
    return await new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      let answer = '';
      const timer = setTimeout(() => { ws.close(); reject(new Error('LLM timeout')); }, timeoutMs);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'generate', systemPrompt, userPrompt })));
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'chunk') answer += msg.text || '';
          else if (msg.type === 'done') { clearTimeout(timer); ws.close(); resolve(answer); }
          else if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.error)); }
        } catch { answer += data.toString(); }
      });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } catch {
    const http = require('http');
    const body = JSON.stringify({ payload: { skill: 'llm.generate', args: { systemPrompt, userPrompt } } });
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: parseInt(process.env.COMMAND_SERVICE_PORT || '3001', 10),
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
    `INSERT INTO projects (id,prompt,name,bdd_tests,agents_plan,tech_stack,prototype_path,reviewer_verdict,reviewer_notes,status,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET bdd_tests=excluded.bdd_tests,agents_plan=excluded.agents_plan,
     tech_stack=excluded.tech_stack,prototype_path=excluded.prototype_path,
     reviewer_verdict=excluded.reviewer_verdict,reviewer_notes=excluded.reviewer_notes,
     status=excluded.status,updated_at=CURRENT_TIMESTAMP`,
    r.id, r.prompt, r.name||null, r.bdd_tests||null, r.agents_plan||null,
    r.tech_stack||null, r.prototype_path||null, r.reviewer_verdict||'pending',
    r.reviewer_notes||null, r.status||'planning'
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
Output: Markdown only.`;

const P2_AGENTS_SYS = `You are a senior engineer writing deep validate_agent specifications.
For EACH agent produce a thorough spec. Think like a human reviewer doing a real health check.

For each agent use this format:
## <agent-id>
### validate_agent Spec
#### 1. Version Check
- Minimum required version and detection command
- What to do if version is too old (auto-upgrade or error)
#### 2. Auth Health
- How to detect token/session validity without a real API call if possible
- Token expiry detection, re-auth procedure if expired
- Silent auth failure patterns to watch for in logs
#### 3. Capability Smoke Tests
- One real command per capability to confirm it actually works end-to-end
- Expected output pattern to verify success
- What a false-positive success looks like and how to rule it out
#### 4. Edge Case Probes
- Rate limit: how to detect it, backoff strategy
- Empty results: differentiate "no data" vs "broken query"
- Permission denied: distinguish auth error vs missing scope
- Network timeout: detect vs hang, retry policy
- Partial failure: command exits 0 but output indicates error
#### 5. Log Scan Patterns
- Regex or string patterns in CLI stdout/stderr or browser console that indicate silent failure
- Example: "deprecated", "fallback", "retry", HTTP 4xx/5xx in logs
#### 6. Self-Heal Actions
- For each failure mode above: what validate_agent DOES (not just reports)
- Examples: re-auth, update descriptor, patch capability list, escalate to user
Output: Markdown only.`;

async function phase2(id, prompt, bddTests) {
  logger.info('[creator.agent] Phase 2: agent plan', { id });
  const ctx = 'Project:\n' + prompt + '\n\nAcceptance tests:\n' + bddTests;
  const [planMd, agentsMd] = await Promise.all([
    callLLM(P2_PLAN_SYS, ctx, 120000),
    callLLM(P2_AGENTS_SYS, ctx, 120000),
  ]);
  writeFile(id, 'plan.md', planMd.trim());
  writeFile(id, 'agents.md', agentsMd.trim());
  const agentIds = (agentsMd.match(/^## ([a-zA-Z0-9._-]+)/gm) || []).map(m => m.replace('## ', '').trim());
  const techSection = (planMd.match(/## Tech Stack\n([\s\S]*?)(?=\n##|$)/) || [])[1] || '';
  logger.info('[creator.agent] Phase 2 done', { id, agentIds });
  return { planMd: planMd.trim(), agentsMd: agentsMd.trim(), agentIds, techStack: techSection.trim() };
}

// ── Phase 3: Runnable prototype ───────────────────────────────────────────────
const P3_SYS = `You are a senior developer building a runnable prototype.

Rules:
- Use REAL npm packages wherever they work without hitting the network (fs, path, lodash, date-fns, chalk, etc.)
- ONLY mock: HTTP calls, OAuth flows, API endpoints, anything needing credentials
- Mocks go in __mocks__/ as named exports matching the real module interface exactly
- prototype/index.js must be a complete, runnable entry point
- package.json must have a "start" script and all deps listed
- run.sh: #!/usr/bin/env bash\nset -e\nnpm install\nnpm start
- tests/ must have one unit test file per BDD scenario using jest or node:test
- This is as close to production as possible — not a throwaway

Output a single JSON object:
{
  "files": [
    { "path": "index.js", "content": "..." },
    { "path": "package.json", "content": "..." },
    { "path": "run.sh", "content": "..." },
    { "path": "__mocks__/api.js", "content": "..." },
    { "path": "tests/acceptance.test.js", "content": "..." }
  ]
}
Paths are relative to prototype/. Output valid JSON only. No markdown fences, no explanation.`;

async function phase3(id, prompt, bddTests, planMd, agentsMd) {
  logger.info('[creator.agent] Phase 3: prototype scaffold', { id });
  const ctx = [
    'Project:\n' + prompt,
    '\nBDD tests:\n' + bddTests,
    '\nPlan:\n' + planMd,
    '\nAgents:\n' + agentsMd,
  ].join('\n');
  const raw = await callLLM(P3_SYS, ctx, 180000);
  let files = [];
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();
    files = JSON.parse(cleaned).files || [];
  } catch (e) {
    logger.warn('[creator.agent] Phase 3 JSON parse failed', { error: e.message });
    writeFile(id, 'prototype/index.js', '// creator.agent parse error: ' + e.message + '\n\n' + raw);
    return { ok: false, error: 'JSON parse failed: ' + e.message, protoDir: path.join(projectDir(id), 'prototype') };
  }
  for (const f of files) {
    if (f.path && f.content != null) writeFile(id, path.join('prototype', f.path), f.content);
  }
  const runSh = path.join(projectDir(id), 'prototype', 'run.sh');
  if (fs.existsSync(runSh)) { try { fs.chmodSync(runSh, 0o755); } catch (_) {} }
  logger.info('[creator.agent] Phase 3 done', { id, fileCount: files.length });
  return { ok: true, files: files.map(f => f.path), protoDir: path.join(projectDir(id), 'prototype') };
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
        await db.run('UPDATE projects SET reviewer_verdict=?, reviewer_notes=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
          verdict, notes, verdict === 'pass' ? 'ready' : 'review', id);
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
    await db.run('UPDATE projects SET reviewer_verdict=?, reviewer_notes=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      verdict, notes, verdict === 'pass' || verdict === 'pass-with-warnings' ? 'ready' : 'review', id);
  }

  return { ok: true, id, verdict, issues, notes };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function creatorAgent(args) {
  const { action } = args || {};
  logger.info('[creator.agent] invoked', { action });
  switch (action) {
    case 'create_project':   return actionCreateProject(args);
    case 'run_prototype':    return actionRunPrototype(args);
    case 'query_project':    return actionQueryProject(args);
    case 'list_projects':    return actionListProjects();
    case 'validate_project': return actionValidateProject(args);
    default:
      return { ok: false, error: 'Unknown action: "' + action + '". Valid: create_project | run_prototype | query_project | list_projects | validate_project' };
  }
}

module.exports = creatorAgent;
