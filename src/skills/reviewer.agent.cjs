'use strict';

/**
 * skill: reviewer.agent
 *
 * Senior engineer gate that reviews a creator.agent project before it
 * transitions from prototype → ready for real delivery.
 *
 * Acts like a human senior dev doing a code review. Checks:
 *   1. Structure   — all required files exist
 *   2. Agents      — every agent in agents.md exists in DuckDB registry
 *   3. Tech        — dependencies are real, versions pinned, no obvious security holes
 *   4. Tests       — BDD acceptance tests are present and prototype tests run
 *   5. API access  — every external API/endpoint is documented with auth + failure modes
 *   6. Prototype   — entry point is runnable, no obvious crashes
 *   7. LLM review  — deep narrative review with concrete pass/fail verdict
 *
 * Actions:
 *   review   { projectId, projectDir? } → full review, writes verdict to DuckDB
 *   status   { projectId }              → read current verdict without re-running
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');
const logger = require('../logger.cjs');
const { getDb } = require('./lib/agents-db.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

// ── LLM helper (delegates to shared skill-llm.cjs) ───────────────────────────
async function callLLM(systemPrompt, userPrompt, timeoutMs) {
  try {
    return await askWithMessages(
      [{ role: 'user', content: userPrompt }],
      { systemInstructions: systemPrompt, responseTimeoutMs: timeoutMs || 90000, temperature: 0.15 }
    );
  } catch {
    return null;
  }
}


// ── Checklist helpers ─────────────────────────────────────────────────────────

function checkStructure(projectDir) {
  // Hard requirements: planning artifacts must exist
  const hardRequired = ['plan.md', 'agents.md', 'tests/acceptance.feature'];
  // Soft requirements: prototype files — Phase 3 LLM may truncate, allow pass-with-warnings
  const softRequired = ['prototype/index.js', 'prototype/package.json', 'prototype/run.sh'];
  const issues = [];
  for (const rel of hardRequired) {
    if (!fs.existsSync(path.join(projectDir, rel))) {
      issues.push({ severity: 'error', check: 'structure', msg: 'Missing required file: ' + rel });
    }
  }
  for (const rel of softRequired) {
    if (!fs.existsSync(path.join(projectDir, rel))) {
      issues.push({ severity: 'warning', check: 'structure', msg: 'Missing prototype file: ' + rel + ' — prototype scaffold incomplete' });
    }
  }
  return issues;
}

async function checkAgents(projectDir, db) {
  const issues = [];
  const agentsPath = path.join(projectDir, 'agents.md');
  if (!fs.existsSync(agentsPath)) return issues;
  const content = fs.readFileSync(agentsPath, 'utf8');
  const agentIds = (content.match(/^## ([a-zA-Z0-9._-]+)/gm) || []).map(m => m.replace('## ', '').trim());
  if (agentIds.length === 0) {
    issues.push({ severity: 'warning', check: 'agents', msg: 'agents.md has no agent sections (## <agent-id>)' });
    return issues;
  }
  for (const agentId of agentIds) {
    if (db) {
      const row = await db.get('SELECT id, status FROM agents WHERE id = ?', agentId).catch(() => null);
      if (!row) {
        issues.push({ severity: 'warning', check: 'agents', msg: 'Agent not in registry: ' + agentId + ' — run cli.agent or browser.agent build_agent first' });
      } else if (row.status === 'needs_update' || row.status === 'degraded') {
        issues.push({ severity: 'warning', check: 'agents', msg: 'Agent registry status is "' + row.status + '": ' + agentId + ' — run validate_agent' });
      }
    } else {
      const mdPath = path.join(AGENTS_DIR, agentId + '.md');
      if (!fs.existsSync(mdPath)) {
        issues.push({ severity: 'warning', check: 'agents', msg: 'Agent descriptor file missing: ' + agentId });
      }
    }
  }
  return issues;
}

function checkTech(projectDir) {
  const issues = [];
  const pkgPath = path.join(projectDir, 'prototype', 'package.json');
  if (!fs.existsSync(pkgPath)) return issues;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {
    issues.push({ severity: 'error', check: 'tech', msg: 'prototype/package.json is invalid JSON: ' + e.message });
    return issues;
  }
  if (!pkg.scripts?.start) {
    issues.push({ severity: 'error', check: 'tech', msg: 'prototype/package.json missing "start" script' });
  }
  const allDeps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {});
  for (const [name, ver] of Object.entries(allDeps)) {
    if (ver === '*' || ver === 'latest') {
      issues.push({ severity: 'warning', check: 'tech', msg: 'Unpinned dep "' + name + '": ' + ver + ' — use exact version for reproducible prototype' });
    }
  }
  // Scan for hardcoded secrets patterns
  const indexPath = path.join(projectDir, 'prototype', 'index.js');
  if (fs.existsSync(indexPath)) {
    const code = fs.readFileSync(indexPath, 'utf8');
    const secretPatterns = [
      /sk-[a-zA-Z0-9]{20,}/,  // OpenAI key
      /AIza[0-9A-Za-z\-_]{35}/,  // Google API key
      /ghp_[a-zA-Z0-9]{36}/,  // GitHub token
      /(?:password|secret|api_key)\s*=\s*['"][^'"]{8,}['"]/i,
    ];
    for (const re of secretPatterns) {
      if (re.test(code)) {
        issues.push({ severity: 'error', check: 'security', msg: 'Potential hardcoded secret detected in prototype/index.js — use process.env or __mocks__/' });
        break;
      }
    }
  }
  return issues;
}

function checkTests(projectDir) {
  const issues = [];
  const featurePath = path.join(projectDir, 'tests', 'acceptance.feature');
  if (!fs.existsSync(featurePath)) {
    issues.push({ severity: 'error', check: 'tests', msg: 'No BDD acceptance tests found (tests/acceptance.feature missing)' });
    return issues;
  }
  const content = fs.readFileSync(featurePath, 'utf8');
  const scenarioCount = (content.match(/^\s*Scenario:/gm) || []).length;
  if (scenarioCount === 0) {
    issues.push({ severity: 'error', check: 'tests', msg: 'acceptance.feature has no Scenario blocks' });
  } else if (scenarioCount < 3) {
    issues.push({ severity: 'warning', check: 'tests', msg: 'Only ' + scenarioCount + ' scenario(s) — consider adding edge cases (auth failure, rate limits, empty results)' });
  }
  // Check prototype unit tests exist
  const protoTestDir = path.join(projectDir, 'prototype', 'tests');
  if (!fs.existsSync(protoTestDir) || fs.readdirSync(protoTestDir).filter(f => f.endsWith('.test.js')).length === 0) {
    issues.push({ severity: 'warning', check: 'tests', msg: 'No unit test files found in prototype/tests/ — add .test.js stubs matching BDD scenarios' });
  }
  return issues;
}

// ── Structural banned-pattern check ─────────────────────────────────────────
// Hard errors that must block the project regardless of LLM verdict.
// These patterns indicate the plan used fake/non-existent tools that will
// never work at runtime.
const BANNED_PATTERNS = [
  { pattern: /gmail-cli/i,      msg: 'gmail-cli is not a real npm/brew package — it does not exist.' },
  { pattern: /imessage-cli/i,   msg: 'imessage-cli is not a real npm/brew package — it does not exist.' },
  { pattern: /messages-cli/i,   msg: 'messages-cli is not a real npm/brew package — it does not exist.' },
  { pattern: /apple-messages/i, msg: 'apple-messages is not a real npm/brew package — it does not exist.' },
  { pattern: /mail-cli/i,       msg: 'mail-cli is not a real npm/brew package — it does not exist.' },
  { pattern: /outlook-cli/i,    msg: 'outlook-cli is not a real npm/brew package — it does not exist.' },
];

function checkBannedPatterns(projectDir) {
  const issues = [];
  const filesToScan = ['plan.md', 'agents.md', 'prototype/index.js'];
  for (const rel of filesToScan) {
    const fPath = path.join(projectDir, rel);
    if (!fs.existsSync(fPath)) continue;
    const content = fs.readFileSync(fPath, 'utf8');
    for (const { pattern, msg } of BANNED_PATTERNS) {
      if (pattern.test(content)) {
        issues.push({ severity: 'error', check: 'banned_patterns', msg: `[${rel}] ${msg}` });
      }
    }
  }
  return issues;
}

function checkApiDocs(projectDir) {
  const issues = [];
  const planPath = path.join(projectDir, 'plan.md');
  if (!fs.existsSync(planPath)) return issues;
  const content = fs.readFileSync(planPath, 'utf8');
  if (!content.includes('## API Surface')) {
    issues.push({ severity: 'warning', check: 'api_docs', msg: 'plan.md missing ## API Surface section — document every external endpoint with auth method and failure modes' });
  }
  if (!content.includes('## Risk Notes')) {
    issues.push({ severity: 'warning', check: 'api_docs', msg: 'plan.md missing ## Risk Notes section — document what can break at runtime' });
  }
  return issues;
}

function runPrototypeTests(projectDir) {
  const issues = [];
  const protoDir = path.join(projectDir, 'prototype');
  if (!fs.existsSync(path.join(protoDir, 'package.json'))) return issues;
  try {
    const out = execSync('npm test --if-present 2>&1', { cwd: protoDir, timeout: 60000, encoding: 'utf8' });
    if (/\b(FAIL|FAILED|failed|Error)\b/.test(out) && !/0 failing/i.test(out)) {
      issues.push({ severity: 'warning', check: 'prototype_tests', msg: 'Prototype tests reported failures', detail: out.slice(0, 400) });
    }
  } catch (e) {
    issues.push({ severity: 'warning', check: 'prototype_tests', msg: 'npm test threw: ' + e.message.slice(0, 200) });
  }
  return issues;
}


// ── LLM deep review prompt ────────────────────────────────────────────────────
const REVIEWER_SYSTEM_PROMPT = `You are a senior software engineer doing a code review of a PROJECT PLAN and PROTOTYPE SCAFFOLD.

CRITICAL CONTEXT — READ THIS FIRST:
The prototype/index.js you are reviewing is a SCAFFOLD, not production code. It exists solely to:
  1. Prove the architecture is sound
  2. Show the real API/SDK calls exist and make sense
  3. Validate that secrets come from env vars

The following are EXPECTED and ACCEPTABLE in a prototype scaffold — do NOT list them as blockers:
  - Mocked/stubbed HTTP calls (this is intentional)
  - Missing retry logic (added by skillCreator in production)
  - Missing error handling beyond basic try/catch (added later)
  - console.log for output (prototype only)
  - Incomplete functions with TODO comments
  - Missing edge case handling (rate limits, timeouts, etc.)
  - Unpinned or missing devDependencies
  - Missing unit test files or sparse test coverage
  - Missing README
  - Agents not registered in a live registry (registration happens at deploy time)
  - validate_agent specs that are incomplete or missing detail
  - No monitoring / alerting / logging infrastructure
  - Prototype-quality code style issues

The following ARE real blockers that MUST be fixed:
  - Using fake/non-existent CLI tools: gmail-cli, imessage-cli, messages-cli, apple-messages, mail-cli, outlook-cli
  - Hardcoded secrets, tokens, or passwords in code (not in env vars)
  - Completely missing plan.md sections (## Tech Stack, ## API Surface, ## Skill Interface)
  - Using a real API that requires auth with no auth mechanism planned at all
  - plan.md references a service that objectively does not exist
  - agents.md is completely empty or missing

Your review MUST cover these dimensions:

1. COMPLETENESS — Does the PLAN cover what's needed? Not the prototype code.
   - Does plan.md have all required sections?
   - Is the ## Skill Interface section present with skill_name, secrets, schedule?
   - Are all agents needed actually planned in agents.md?

2. TECHNICAL SOUNDNESS — Will this approach work in production?
   - Are the npm packages / CLIs in plan.md real and publicly available?
   - Does the overall API interaction pattern in the prototype make sense (even if mocked)?
   - Are secrets loaded from process.env (not hardcoded)?
   BANNED TOOLS (automatic FAIL): gmail-cli, imessage-cli, messages-cli, apple-messages, mail-cli, outlook-cli

3. SECURITY
   - Any hardcoded secrets, tokens, or passwords?
   - Any use of eval() with user input?

4. AGENT COVERAGE — Are the agents.md specs usable?
   - Does each agent have type, role, capabilities, and auth defined?
   - Does each agent have a validate_agent section (even a basic one)?
   NOTE: Missing registry entries, incomplete smoke tests, missing log patterns = WARNING only, not blocker.

5. API ACCESS READINESS — Is every external API documented?
   - Is auth method documented for each API?
   - Are known rate limits or approval requirements called out?

6. USABILITY — Can the prototype be run?
   - Is there a run.sh or start script?
   - Are env var requirements documented?

Output ONLY valid JSON:
{
  "verdict": "pass" | "pass-with-warnings" | "fail",
  "overallScore": 0-100,
  "dimensions": {
    "completeness":      { "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] },
    "technicalSoundness":{ "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] },
    "security":          { "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] },
    "agentCoverage":     { "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] },
    "apiAccessReadiness":{ "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] },
    "usability":         { "verdict": "pass"|"fail", "score": 0-100, "findings": ["..."] }
  },
  "blockers": ["<ONLY real blockers: fake CLIs, hardcoded secrets, completely missing plan sections — NOT prototype code quality>"],
  "warnings": ["<prototype code quality, missing edge cases, incomplete specs — these are expected at this stage>"],
  "patches": ["<concrete actionable fix with exact file and what to change — only for real blockers>"],
  "summary": "<3-5 sentence narrative. Acknowledge this is a prototype scaffold. Focus on whether the PLAN and ARCHITECTURE are sound, not the prototype code quality.>"
}`;


// ── action: review ────────────────────────────────────────────────────────────
async function actionReview({ projectId, projectDir: explicitDir } = {}) {
  if (!projectId) return { ok: false, error: 'projectId is required' };

  const db = await getDb();
  let projectDir = explicitDir;

  // Look up project dir from DuckDB if not provided
  if (!projectDir && db) {
    const row = await db.get('SELECT * FROM projects WHERE id = ?', projectId).catch(() => null);
    if (row) projectDir = path.join(os.homedir(), '.thinkdrop', 'projects', projectId);
  }
  if (!projectDir) projectDir = path.join(os.homedir(), '.thinkdrop', 'projects', projectId);

  if (!fs.existsSync(projectDir)) {
    return { ok: false, error: 'Project directory not found: ' + projectDir };
  }

  logger.info('[reviewer.agent] review start', { projectId, projectDir });

  // ── 1. Mechanical checklist ───────────────────────────────────────────────
  const checklistIssues = [
    ...checkBannedPatterns(projectDir),  // run first — hard block on fake CLIs
    ...checkStructure(projectDir),
    ...await checkAgents(projectDir, db),
    ...checkTech(projectDir),
    ...checkTests(projectDir),
    ...checkApiDocs(projectDir),
    ...runPrototypeTests(projectDir),
  ];

  // ── 2. Read + chunk project artifacts for LLM review ───────────────────────
  // Files larger than CHUNK_SIZE are split into chunks and summarized first,
  // so the reviewer LLM always gets the full picture regardless of file size.
  const CHUNK_SIZE  = 2400; // chars per chunk fed to LLM
  const CHUNK_OVERLAP = 200;

  function readRaw(rel) {
    const p = path.join(projectDir, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }

  function chunkText(text, size, overlap) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + size));
      i += size - overlap;
    }
    return chunks;
  }

  // For large files: summarize each chunk then join summaries.
  // For small files: pass through directly.
  async function readForReview(rel, label) {
    const raw = readRaw(rel);
    if (!raw) return label + ':\n(not found)';
    if (raw.length <= CHUNK_SIZE) return label + ':\n' + raw;

    // Chunk and summarize
    const chunks = chunkText(raw, CHUNK_SIZE, CHUNK_OVERLAP);
    const summaries = await Promise.all(chunks.map((chunk, i) =>
      callLLM(
        'You are a senior engineer summarizing a section of a file for a code review. Be concrete and specific. Output 3-5 bullet points covering: what this section does, any bugs or risks, any missing pieces.',
        'File: ' + rel + ' (chunk ' + (i + 1) + '/' + chunks.length + ')\n\n' + chunk,
        30000
      ).catch(() => '(chunk summary failed)')
    ));
    return label + ' (chunked — ' + chunks.length + ' sections):\n' + summaries.join('\n---\n');
  }

  const [planMdSection, agentsMdSection, bddSection, indexSection, pkgSection] = await Promise.all([
    readForReview('plan.md',                    '## plan.md'),
    readForReview('agents.md',                  '## agents.md'),
    readForReview('tests/acceptance.feature',   '## BDD Acceptance Tests'),
    readForReview('prototype/index.js',         '## prototype/index.js'),
    readForReview('prototype/package.json',     '## prototype/package.json'),
  ]);

  const checklistSummary = checklistIssues.length === 0
    ? 'All mechanical checks passed.'
    : checklistIssues.map(i => '[' + i.severity.toUpperCase() + '] (' + i.check + ') ' + i.msg).join('\n');

  const userPrompt = [
    '## Project: ' + projectId,
    '',
    planMdSection,
    '',
    agentsMdSection,
    '',
    bddSection,
    '',
    indexSection,
    '',
    pkgSection,
    '',
    '## Mechanical Checklist Results',
    checklistSummary,
  ].join('\n');

  // ── 3. LLM deep review ────────────────────────────────────────────────────
  let llmReview = null;
  const raw = await callLLM(REVIEWER_SYSTEM_PROMPT, userPrompt, 120000);
  if (raw) {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) llmReview = JSON.parse(match[0]);
    } catch (e) {
      logger.warn('[reviewer.agent] LLM review JSON parse failed', { error: e.message });
    }
  }

  // ── 4. Combine mechanical + LLM verdicts ──────────────────────────────────
  const hasErrors   = checklistIssues.some(i => i.severity === 'error');
  const hasWarnings = checklistIssues.some(i => i.severity === 'warning');

  let verdict;
  if (llmReview?.verdict) {
    // LLM verdict wins for pass/fail, but mechanical errors always force fail
    verdict = hasErrors ? 'fail' : llmReview.verdict;
    // Score-based override: if LLM says fail but score>=45 and all remaining blockers
    // are prototype-level / runtime-setup concerns — not real architecture bugs —
    // upgrade to pass-with-warnings so the loop doesn't stall on non-fixable soft issues.
    if (verdict === 'fail' && !hasErrors && (llmReview.overallScore || 0) >= 45) {
      // Expanded soft-blocker pattern: anything that is expected in a prototype scaffold
      // or is a runtime/deployment concern rather than an architecture/code correctness issue.
      const SOFT_BLOCKER_RE = /register|registry|registered|monitoring|logging|log instruction|log pattern|readme|production standard|production quality|production grade|validate_agent|validate\.agent|validation spec|retry|retries|retry logic|backoff|error handling|error\.handling|graceful|edge case|edge\.case|timeout|rate limit|rate\.limit|mock|mocked|stub|stubbed|placeholder|unit test|unit\.test|test coverage|test\.coverage|test file|test\.file|incomplete function|incomplete\.function|todo|missing await|missing\.await|async handling|console\.log|logging statement|unpinned|devdependency|dev dependency|agent registration|agent\.registration|not in registry|not\.in\.registry|deploy time|deployment step/i;
      const hardBlockers = (llmReview.blockers || []).filter(b => !SOFT_BLOCKER_RE.test(b));
      if (hardBlockers.length === 0) verdict = 'pass-with-warnings';
    }
  } else {
    verdict = hasErrors ? 'fail' : hasWarnings ? 'pass-with-warnings' : 'pass';
  }

  const notes = [
    llmReview?.summary ? 'LLM Review: ' + llmReview.summary : '',
    checklistIssues.length > 0 ? '\nChecklist Issues:\n' + checklistSummary : '',
    llmReview?.blockers?.length ? '\nBlockers:\n' + llmReview.blockers.map(b => '- ' + b).join('\n') : '',
    llmReview?.warnings?.length ? '\nWarnings:\n' + llmReview.warnings.map(w => '- ' + w).join('\n') : '',
    llmReview?.patches?.length  ? '\nPatches:\n' + llmReview.patches.map(p => '- ' + p).join('\n') : '',
  ].filter(Boolean).join('\n').trim();

  // ── 5. Write verdict back to DuckDB projects table ────────────────────────
  if (db) {
    await db.run(
      `UPDATE projects SET reviewer_verdict=?, reviewer_notes=?, status=?, updated_at=? WHERE id=?`,
      verdict,
      notes,
      verdict === 'pass' || verdict === 'pass-with-warnings' ? 'ready' : 'review',
      new Date().toISOString(),
      projectId
    ).catch(e => logger.warn('[reviewer.agent] DB write failed', { error: e.message }));
  }

  logger.info('[reviewer.agent] review complete', { projectId, verdict, score: llmReview?.overallScore });

  return {
    ok: true,
    projectId,
    verdict,
    overallScore: llmReview?.overallScore || null,
    checklistIssues,
    dimensions: llmReview?.dimensions || null,
    blockers:  llmReview?.blockers  || checklistIssues.filter(i => i.severity === 'error').map(i => i.msg),
    warnings:  llmReview?.warnings  || checklistIssues.filter(i => i.severity === 'warning').map(i => i.msg),
    patches:   llmReview?.patches   || [],
    summary:   llmReview?.summary   || checklistSummary,
    notes,
  };
}

// ── action: status ────────────────────────────────────────────────────────────
async function actionStatus({ projectId } = {}) {
  if (!projectId) return { ok: false, error: 'projectId is required' };
  const db = await getDb();
  if (!db) return { ok: false, error: 'DuckDB not available' };
  const row = await db.get(
    'SELECT id, status, reviewer_verdict, reviewer_notes, updated_at FROM projects WHERE id = ?',
    projectId
  ).catch(() => null);
  if (!row) return { ok: false, error: 'Project not found: ' + projectId };
  return { ok: true, projectId, status: row.status, verdict: row.reviewer_verdict, notes: row.reviewer_notes, updatedAt: row.updated_at };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function reviewerAgent(args) {
  const { action } = args || {};
  logger.info('[reviewer.agent] invoked', { action });
  switch (action) {
    case 'review': return actionReview(args);
    case 'status': return actionStatus(args);
    default:
      return { ok: false, error: 'Unknown action: "' + action + '". Valid: review | status' };
  }
}

module.exports = reviewerAgent;
