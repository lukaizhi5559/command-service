'use strict';
/**
 * skill.reviewer.cjs
 *
 * Post-generation skill validator and auto-patcher.
 *
 * Called by skillCreator AFTER static checks pass but BEFORE the skill is
 * written to disk. Also called at runtime by external.skill on failures to
 * write learned rules back to api_rules.
 *
 * Two actions:
 *   review_skill  — validate generated code against api_rules + auto-patch violations
 *   report_failure — learn from a runtime failure and write a new api_rule row
 *
 * Querying api_rules:
 *   POST http://127.0.0.1:3001/api_rule.search  { services: [...] }
 *   POST http://127.0.0.1:3001/api_rule.upsert  { service, ruleType, ruleText, codePattern, fixHint, source }
 *
 * Auto-patch strategy:
 *   1. Load all api_rules for services detected in the skill code.
 *   2. For each rule with a code_pattern: test against the code.
 *   3. On violation: ask LLM to fix with fix_hint injected into prompt.
 *   4. Re-validate after patch (max 2 rounds).
 *   5. Return { ok, code, violations, patched }.
 */

const http    = require('http');
const logger  = require('../logger.cjs');

const MEM_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

// ── HTTP helper for user-memory MCP ──────────────────────────────────────────
function memPost(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: MEM_PORT,
      path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(MEM_API_KEY ? { 'Authorization': `Bearer ${MEM_API_KEY}` } : {}),
      },
      timeout: 6000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data); req.end();
  });
}

// ── Detect which services are used in the skill code ─────────────────────────
// Maps npm package / API hostname patterns → canonical service name.
const SERVICE_DETECTORS = [
  { pattern: /clicksend|rest\.clicksend\.com/i,               service: 'clicksend' },
  { pattern: /twilio/i,                                       service: 'twilio' },
  { pattern: /stripe/i,                                       service: 'stripe' },
  { pattern: /sendgrid/i,                                     service: 'sendgrid' },
  { pattern: /mailgun/i,                                      service: 'mailgun' },
  { pattern: /googleapis|google\.auth|google-auth/i,          service: 'gmail' },
  { pattern: /github\.com|@octokit|octokit/i,                 service: 'github' },
  { pattern: /slack\.com|@slack\//i,                          service: 'slack' },
  { pattern: /notion\.com|@notionhq/i,                        service: 'notion' },
  { pattern: /airtable/i,                                     service: 'airtable' },
  { pattern: /hubspot/i,                                      service: 'hubspot' },
  { pattern: /salesforce|jsforce/i,                           service: 'salesforce' },
  { pattern: /openai/i,                                       service: 'openai' },
  { pattern: /anthropic/i,                                    service: 'anthropic' },
  { pattern: /dropbox/i,                                      service: 'dropbox' },
  { pattern: /discord/i,                                      service: 'discord' },
  { pattern: /spotify/i,                                      service: 'spotify' },
  { pattern: /zoom\.us|zoomus/i,                              service: 'zoom' },
  { pattern: /jira|atlassian/i,                               service: 'atlassian' },
  { pattern: /aws\.|amazonaws|@aws-sdk/i,                     service: 'aws' },
  { pattern: /azure|@azure\//i,                               service: 'azure' },
  { pattern: /vonage|messagebird/i,                           service: 'vonage' },
  { pattern: /plaid/i,                                        service: 'plaid' },
  { pattern: /shopify/i,                                      service: 'shopify' },
];

function detectServices(code) {
  const found = new Set();
  for (const { pattern, service } of SERVICE_DETECTORS) {
    if (pattern.test(code)) found.add(service);
  }
  return [...found];
}

// ── Load api_rules for detected services ─────────────────────────────────────
async function loadApiRules(services) {
  if (!services.length) return [];
  const res = await memPost('/api_rule.search', {
    payload: { services },
    requestId: 'reviewer-' + Date.now(),
  });
  return res?.payload?.results || [];
}

// ── Check code against a single rule's code_pattern ──────────────────────────
function checkRule(code, rule) {
  if (!rule.codePattern) return false;
  try {
    const re = new RegExp(rule.codePattern);
    return re.test(code);
  } catch (_) {
    return false;
  }
}

// ── LLM call to patch violations ─────────────────────────────────────────────
let _seq = 0;
async function callLLM(systemPrompt, userPrompt) {
  const WebSocket = require('ws');
  const WS_BASE = process.env.LLM_WS_URL || process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
  const url = new URL(WS_BASE);
  const apiKey = process.env.VSCODE_API_KEY || process.env.BACKEND_API_KEY || process.env.BASE_API_KEY || '';
  if (apiKey) url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('userId', 'skill_reviewer');
  url.searchParams.set('clientId', 'rev_' + Date.now() + '_' + (++_seq));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.toString());
    let answer = '';
    const timer = setTimeout(() => { ws.close(); reject(new Error('LLM timeout')); }, 90000);
    ws.on('open', () => ws.send(JSON.stringify({
      id: 'rev_' + Date.now(), type: 'llm_request',
      payload: { prompt: userPrompt, provider: 'openai', options: { temperature: 0.1, stream: true, taskType: 'ask' },
        context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] } },
      timestamp: Date.now(), metadata: { source: 'skill_reviewer' },
    })));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_chunk') answer += msg.payload?.chunk || msg.payload?.text || '';
        else if (msg.type === 'llm_stream_end') { clearTimeout(timer); ws.close(); resolve(answer); }
        else if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.payload?.message || 'LLM error')); }
      } catch { /* ignore */ }
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('close', () => { clearTimeout(timer); if (answer.trim()) resolve(answer); else reject(new Error('WS closed early')); });
  });
}

function stripFences(content) {
  return (content || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

const PATCH_SYS = `You are an expert Node.js developer reviewing a ThinkDrop skill file for API correctness.
You will be given a skill file and a list of specific violations found by automated checks.
Fix EVERY violation listed. Output ONLY the corrected CommonJS code — no explanation, no fences.
Rules:
- Do NOT change any logic that is not related to the listed violations.
- All secrets must come from context.secrets — never hardcode credentials.
- Preserve the full module.exports = async function run(args, context) structure.`;

// ── Main: review_skill ────────────────────────────────────────────────────────
async function actionReviewSkill({ code, skillName }) {
  if (!code) return { ok: false, error: 'code is required' };

  const services  = detectServices(code);
  const rules     = await loadApiRules(services);
  const violations = [];

  for (const rule of rules) {
    if (checkRule(code, rule)) {
      violations.push({
        ruleId:    rule.id,
        service:   rule.service,
        ruleType:  rule.ruleType,
        ruleText:  rule.ruleText,
        fixHint:   rule.fixHint || rule.ruleText,
      });
    }
  }

  if (violations.length === 0) {
    logger.info(`[skill.reviewer] ${skillName || 'skill'} passed all api_rules checks (${rules.length} rules, ${services.join(', ') || 'no services detected'})`);
    return { ok: true, code, violations: [], patched: false };
  }

  logger.warn(`[skill.reviewer] ${skillName || 'skill'} has ${violations.length} api_rules violation(s)`, {
    violations: violations.map(v => `${v.service}:${v.ruleType} — ${v.ruleText.slice(0, 80)}`),
  });

  // Auto-patch: ask LLM to fix all violations in one pass
  let patchedCode = code;
  let patchRound  = 0;
  const MAX_PATCH_ROUNDS = 2;

  while (violations.length > 0 && patchRound < MAX_PATCH_ROUNDS) {
    patchRound++;
    const violationList = violations
      .map((v, i) => `${i + 1}. [${v.service}:${v.ruleType}] ${v.fixHint}`)
      .join('\n');

    try {
      const raw = await callLLM(
        PATCH_SYS,
        `Skill file:\n\`\`\`js\n${patchedCode}\n\`\`\`\n\nViolations to fix:\n${violationList}\n\nReturn the corrected skill code only.`
      );
      const candidate = stripFences(raw);
      if (!candidate || candidate.length < 50) {
        logger.warn('[skill.reviewer] LLM patch returned empty code, keeping original');
        break;
      }

      // Re-check the patched code
      const remaining = violations.filter(v => {
        const rule = rules.find(r => r.id === v.ruleId);
        return rule ? checkRule(candidate, rule) : false;
      });

      patchedCode = candidate;
      logger.info(`[skill.reviewer] patch round ${patchRound}: ${violations.length} → ${remaining.length} violations`);
      violations.length = 0;
      violations.push(...remaining);
    } catch (e) {
      logger.warn('[skill.reviewer] LLM patch failed', { error: e.message });
      break;
    }
  }

  const stillViolating = violations.filter(v => {
    const rule = rules.find(r => r.id === v.ruleId);
    return rule ? checkRule(patchedCode, rule) : false;
  });

  if (stillViolating.length > 0) {
    logger.warn(`[skill.reviewer] ${stillViolating.length} violation(s) remain after patching — recoverSkill will handle at runtime`);
  }

  return {
    ok: true,
    code: patchedCode,
    violations: stillViolating,
    patched: patchedCode !== code,
  };
}

// ── Main: report_failure ──────────────────────────────────────────────────────
// Called by external.skill when a skill returns a non-missing-secrets runtime error.
// Writes a new learned api_rule so future skills using the same service don't repeat it.
async function actionReportFailure({ skillName, errorMessage, skillCode }) {
  if (!errorMessage || !skillCode) return { ok: false, error: 'errorMessage and skillCode are required' };

  const services = detectServices(skillCode);
  if (!services.length) {
    logger.debug('[skill.reviewer] report_failure: no services detected in skill code');
    return { ok: true, learned: false };
  }

  // Parse the error to determine service + rule type
  const errLower = errorMessage.toLowerCase();
  let service   = services[0];
  let ruleType  = 'gotcha';
  let ruleText  = null;
  let fixHint   = null;
  let codePattern = null;

  // ClickSend-specific patterns
  if (/clicksend|rest\.clicksend/.test(skillCode)) {
    service = 'clicksend';
    if (/invalid_request/i.test(errLower) || /empty.*username|unauthorized/i.test(errLower)) {
      ruleType    = 'auth';
      ruleText    = 'ClickSend Basic auth MUST include the account username. Use Buffer.from(secrets.CLICKSEND_USERNAME + ":" + secrets.CLICKSEND_API_KEY).toString("base64"). Empty username (":api_key") always returns invalid_request.';
      codePattern = 'Buffer\\.from\\s*\\([`\'"]?:\\s*[`\'"]?\\$?\\{?\\s*\\w*(?:API_KEY|api_key)';
      fixHint     = 'Replace Buffer.from(":" + ...) with Buffer.from(secrets.CLICKSEND_USERNAME + ":" + secrets.CLICKSEND_API_KEY).toString("base64")';
    } else if (/invalid.*payload|messages.*required/i.test(errLower)) {
      ruleType    = 'payload';
      ruleText    = 'ClickSend SMS API requires payload { messages: [{ to, body, source }] } — not a flat { to, message } object.';
      codePattern = '"to"\\s*:\\s*(?:secrets|RECIPIENT|phone)(?!.*messages\\s*:)';
      fixHint     = 'Use payload: { messages: [{ to: secrets.RECIPIENT_PHONE_NUMBER, body: summary, source: "thinkdrop" }] }';
    }
  }

  // Generic 401/403 — auth rule
  if (!ruleText && (/401|403|unauthorized|forbidden/i.test(errLower))) {
    ruleType = 'auth';
    ruleText = `Runtime auth failure for ${service}: "${errorMessage.slice(0, 120)}". Verify all auth credentials are correctly passed and the auth header format matches the API spec.`;
    fixHint  = `Check that Basic/Bearer auth headers use the correct format for ${service}. Ensure all required credentials (username, key, token) are declared in secrets and read from context.secrets.`;
  }

  if (!ruleText) {
    ruleText = `Runtime failure for ${service}: "${errorMessage.slice(0, 200)}". Investigate API usage in generated skills.`;
    fixHint  = `Verify the ${service} API call matches the official API spec for authentication, endpoint URL, and payload format.`;
  }

  const result = await memPost('/api_rule.upsert', {
    payload: { service, ruleType, ruleText, codePattern, fixHint, source: 'learned' },
    requestId: 'report-failure-' + Date.now(),
  });

  const learned = result?.payload?.created !== false;
  logger.info(`[skill.reviewer] report_failure: wrote api_rule for ${service}:${ruleType} (learned=${learned})`, { skillName });
  return { ok: true, learned, service, ruleType };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
async function skillReviewer(args) {
  const { action } = args || {};
  logger.info('[skill.reviewer] invoked', { action });
  switch (action) {
    case 'review_skill':    return actionReviewSkill(args);
    case 'report_failure':  return actionReportFailure(args);
    default:
      return { ok: false, error: `Unknown action: "${action}". Valid: review_skill, report_failure` };
  }
}

module.exports = skillReviewer;
