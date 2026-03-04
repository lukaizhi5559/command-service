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

const SKILLS_DIR  = path.join(__dirname);
const PROJECTS_DIR = path.join(os.homedir(), '.thinkdrop', 'projects');

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
- context: { logger, secrets } — secrets is an object with env var values

The skill must:
1. Validate all required secrets/args at the top, return { ok: false, error: '...' } if missing
2. Implement the core logic cleanly using the agents/APIs described in plan.md and agents.md
3. Use only dependencies already listed in the project's package.json
4. Include a validate() export: async function validate(context) that runs a lightweight health check
5. Include an install() export: async function install(context) that ensures deps are available
6. Store OAuth tokens locally in ~/.thinkdrop/tokens/<skill_name>.json (NOT Google Secret Manager)
7. Handle all error cases with descriptive messages
8. Return { ok: true, ...outputs } on success, { ok: false, error: '...' } on failure

Output: raw CommonJS code only. No markdown fences, no explanation.`;

// ── Generate the skill file via LLM ───────────────────────────────────────────
async function generateSkillCode(iface, agents, validateSpecs, planMd, agentsMd) {
  const validateSpecsSummary = Object.entries(validateSpecs)
    .map(([id, spec]) => '### ' + id + ' validate.agent spec\n' + spec.slice(0, 800))
    .join('\n\n');

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
    '## plan.md',
    planMd.slice(0, 3000),
    '',
    '## agents.md',
    agentsMd.slice(0, 2000),
    '',
    '## validate.agent specs',
    validateSpecsSummary.slice(0, 2000),
    '',
    'Generate the complete .skill.cjs for: ' + iface.skillName,
    'Use local token storage at ~/.thinkdrop/tokens/' + iface.skillName + '.json for OAuth.',
    'Do NOT use Google Secret Manager or AWS Secrets Manager.',
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

    // Convert kebab-case → dot-notation (registry requirement: min 2 parts, lowercase)
    const dotName = skillName.replace(/-/g, '.');

    // Copy skill file into ~/.thinkdrop/skills/<dotName>/index.cjs
    const skillUserDir  = path.join(osMod.homedir(), '.thinkdrop', 'skills', dotName);
    const skillUserPath = path.join(skillUserDir, 'index.cjs');
    fs.mkdirSync(skillUserDir, { recursive: true });
    fs.copyFileSync(sourceSkillPath, skillUserPath);
    logger.info('[skillCreator] skill copied to user skills dir', { skillUserPath });

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
    const contractMd = [
      '---',
      'name: ' + dotName,
      'description: ' + description,
      'exec_path: ' + skillUserPath,
      'exec_type: node',
      'version: 1.0.0',
      '---',
      '',
      '# ' + dotName,
      '',
      description,
    ].join('\n');

    const body = JSON.stringify({ payload: { contractMd }, requestId: 'skillCreator-' + Date.now() });
    await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10),
        path: '/skill.install', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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
    return { ok: false, error: 'plan.md is missing ## Skill Interface section with skill_name' };
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

  const skillCode = stripFences(raw);
  if (!skillCode || skillCode.length < 50) {
    return { ok: false, error: 'LLM returned empty skill code' };
  }

  // Write the skill file
  const skillFileName = iface.skillName + '.skill.cjs';
  const skillPath     = path.join(SKILLS_DIR, skillFileName);
  try {
    fs.writeFileSync(skillPath, skillCode, 'utf8');
    logger.info('[skillCreator] skill file written', { skillPath });
  } catch (e) {
    return { ok: false, error: 'Failed to write skill file: ' + e.message };
  }

  // Register in DuckDB + memory MCP
  const db = await getDb();
  await registerSkill(db, iface.skillName, skillPath, iface, projectId);
  // registerInMemoryMCP copies to ~/.thinkdrop/skills/ and calls /skill.install
  // It returns the dot-notation name that external.skill will look up (e.g. gmail.daily.summary)
  const registeredName = await registerInMemoryMCP(iface.skillName, iface, skillPath, planMd) || iface.skillName;

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
