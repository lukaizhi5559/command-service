'use strict';

/**
 * skill: playwright.agent
 *
 * Plan-Execute browser agent:
 *
 *   Phase 1 — Snapshot: capture current page state (once)
 *   Phase 2 — Plan:     LLM generates a full ordered list of browser.act steps
 *   Phase 3 — Execute:  run each step in sequence via browser.act
 *                       on failure → snapshot + LLM repairs just that step → continue
 *
 * LLM is called ONCE per task (plan generation). A second LLM call only happens
 * when a specific step fails and needs a targeted repair. This avoids the N-LLM-per-N-
 * actions overhead of the old turn loop, eliminates timeout risk from accumulated latency,
 * and means a concurrent session restart can never hijack mid-task execution.
 *
 * For inherently interactive/unpredictable pages, the LLM can include explicit
 * { action: "snapshot" } steps in the plan at points where it needs to re-read the
 * page before continuing (e.g. after a modal opens).
 *
 * Args:
 *   goal        {string}  — plain-language description of what to accomplish
 *   sessionId   {string}  — browser session id (default: 'playwright_agent')
 *   maxRepairs  {number}  — max total repair LLM calls before giving up (default: 4)
 *   timeoutMs   {number}  — per-action timeout ms passed to browser.act (default: 15000)
 *   headed      {boolean} — show browser window (default: true)
 *   url         {string}  — optional: navigate here before starting
 *
 * Returns:
 * {
 *   ok:            boolean,
 *   goal:          string,
 *   sessionId:     string,
 *   turns:         number,        — total steps executed (including repairs)
 *   done:          boolean,
 *   result:        string,
 *   transcript:    Array<Step>,
 *   error?:        string,
 *   executionTime: number,
 * }
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const skillDb = require('../skill-helpers/skill-db.cjs');

// ---------------------------------------------------------------------------
// Phase 1 prompt — sent once, LLM returns the full step plan
// ---------------------------------------------------------------------------
const PLAN_SYSTEM_PROMPT = `You are a browser automation expert controlling a real Chrome browser via playwright-cli.

HOW IT WORKS — read this carefully:
Each step in your plan maps 1:1 to one playwright-cli subcommand call:
  { "action": "navigate", "url": "https://..." }             →  playwright-cli -s=SESSION navigate https://...
  { "action": "click", "selector": "e24" }                   →  playwright-cli -s=SESSION click e24
  { "action": "fill", "selector": "e12", "text": "hello" }   →  playwright-cli -s=SESSION fill e12 hello
  { "action": "run-code", "code": "async page => {...}" }     →  playwright-cli -s=SESSION run-code "async page => {...}"

The SNAPSHOT is a YAML-formatted ARIA accessibility tree. Refs like e12, e83 are stable element handles —
use them directly in click/fill/hover/select. They are the most reliable selectors for DOM actions.
For run-code + page.evaluate(), refs do NOT exist in the browser — use real CSS selectors (e.g. 'tr.zA', '.bog').

run-code context — Node.js VM (NOT the browser):
  - \`page\` is a real Playwright Page object (Node.js side)
  - document/window/fetch do NOT exist in this context — this is Node.js, not a browser
  - To reach the real browser DOM: use page.evaluate(() => { ...browser code here... })
    page.evaluate() sends a function into Chrome where document.querySelectorAll works
  - NEVER use page.locator(sel).innerText() in a loop — throws TimeoutError after 5000ms if selector is absent
  - SAFE extraction pattern: return await page.evaluate(() => Array.from(document.querySelectorAll('css')).map(...))
  - MODULE SYSTEM: ES modules only — \`require\` does NOT exist. Use dynamic import if needed: const { fn } = await import('module')
  - FILE I/O IN run-code: NEVER read files inside run-code. Any file content needed for the task is already
    pre-injected into the task description as [DATA FROM PRIOR STEP]. Use \`type\` to paste that content.
You will receive the current page snapshot (YAML-formatted ARIA accessibility tree) and a goal.
Output the complete ordered list of browser actions needed to accomplish the goal.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "thoughts": "<one sentence: what you see and your approach>",
  "plan": [
    { "action": "<action>", ...args },
    ...
  ]
}

Available actions:
  navigate        { url }
  click           { selector }         — use snapshot ref (e12) when visible; label otherwise
  dblclick        { selector }
  fill            { selector, text }   — for <input> / <textarea> fields
  type            { text }             — types into currently focused element (contenteditable, e.g. Gmail body)
  press           { key }              — "Enter", "Tab", "Escape", "Meta+a", etc.
  select          { selector, value }  — dropdown option
  check           { selector }
  uncheck         { selector }
  hover           { selector }
  scroll          { direction, distance }
  drag            { selector, targetSelector }
  waitForSelector { selector }
  waitForContent  { text }
  getPageText     {}                   — returns ALL visible text from the page (body.innerText, up to 50k chars). Use this as the universal, site-agnostic way to read any page. Works on ChatGPT, Perplexity, Claude, Grok, and any other site without knowing site-specific CSS. Result auto-captured as task output.
  evaluate        { text: "<JS expression>" }  — single-expression JS returning a primitive (e.g. document.title)
  run-code        { code: "async page => { return await page.evaluate(() => { ...browser JS... }); }" }
                  — Node.js VM with real Playwright page object. Use page.evaluate() to reach browser DOM.
                  ⚠ require() does NOT exist. Use dynamic import: const { fn } = await import('module')
                  ⚠ NEVER read files inside run-code — file content is already in the task as [DATA FROM PRIOR STEP].
                  Gmail inbox example (sender=.yX span/.zF  subject=.bog/.bqe  snippet=.y2  time=.xW span):
                  { "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('tr.zA')).slice(0,5); if(!rows.length) return 'No emails found'; return rows.map((r,i)=>{ const s=r.querySelector('.yX span,.zF')?.innerText||''; const sub=r.querySelector('.bog,.bqe')?.innerText||''; const snip=r.querySelector('.y2')?.innerText||''; const t=r.querySelector('.xW span')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip+' | Time='+t; }).join('\\n'); }); }" }
  screenshot      { filePath }
  snapshot        {}                   — re-read the page (ONLY when page changes significantly)
  return          { data: "<string>" } — MUST be LAST step; plain string output, max 2000 chars.
  dialog-accept   { prompt? }
  dialog-dismiss  {}

CRITICAL: each step MUST use this exact format: { "action": "<name>", ...args }
CORRECT:  { "action": "navigate", "url": "https://mail.google.com/mail/u/0/#inbox" }
CORRECT:  { "action": "click", "selector": "e24" }
CORRECT:  { "action": "fill", "selector": "e12", "text": "user@example.com" }
WRONG:    { "navigate": { "url": "..." } }
WRONG:    { "click": "Compose" }

Rules:
- Use element refs (e12, e83) from the snapshot for click/fill/hover — most reliable for DOM actions. Not valid inside page.evaluate().
- Autocomplete inputs (e.g. Gmail To:): fill then press Tab.
- Contenteditable areas: click first, then type (not fill).
- Do NOT include auth steps — assume already logged in.
- CREDENTIALS RULE: If credentials not in goal text are required, return empty plan.
- Keep plan concise — no unnecessary waits or redundant snapshots.
- MULTI-ITEM EXTRACTION: Use one run-code step with page.evaluate() + document.querySelectorAll(). Never click per-item.
- RUN-CODE RETURN: run-code result is auto-captured as task output — do NOT add a placeholder return step after it.
- DIALOG RULE: If a confirmation dialog may appear, add dialog-accept/dismiss immediately after the triggering action.
- MODAL/OVERLAY RULE: When clicking a button that opens a modal or overlay (Compose, New, Reply, etc.), add { "action": "snapshot" } as the very next step. This forces a DOM re-read so all following steps use fresh refs from the new modal. Without this, refs from the original page will fail inside the modal.
- AI CHAT EXTRACTION RULE: When sending a message to an AI assistant (ChatGPT, Claude, Grok, Perplexity, etc.), after pressing Enter add: (1) { "action": "waitForStableText" } to wait for the streamed response to finish, (2) { "action": "getPageText" } to read all visible page text. This is the UNIVERSAL, site-agnostic approach — works on any AI chat site without CSS class knowledge. NEVER use run-code + page.evaluate() with site-specific CSS selectors (like .prose, .generic, [data-testid=...]) for AI chat extraction — these selectors break across sites and page updates. Do NOT add a return step — the getPageText result is automatically captured as task output and will be consumed by the synthesis step downstream.
- SESSION ISOLATION RULE: When accessing an AI chat service (ChatGPT, Perplexity, Gemini, Claude, etc.), ALWAYS start with a navigate action to its fresh/new-chat URL — ChatGPT: https://chatgpt.com/, Perplexity: https://www.perplexity.ai/, Gemini: https://gemini.google.com/app, Claude: https://claude.ai/new. This ensures getPageText reads ONLY the current query response, not old conversation history from previous sessions. EXCEPTION: If the task explicitly involves a follow-up or continuation of a previous AI response (keywords: "follow up", "continue", "based on that", "expand on", "now ask it"), stay on the current page and do NOT navigate away.
- NO PLACEHOLDER RULE: NEVER write literal template placeholder text like [ChatGPT response], [Perplexity response], [AI answer], or [insert content here] in any step args (task, body, text, etc.). When combining multi-source AI extractions into an email or message body, always use {{synthesisAnswer}} as the sole body content token — the orchestrator substitutes it with the real synthesized content before the step executes.`;

// ---------------------------------------------------------------------------
// Phase 2 prompt — called only when a step fails
// ---------------------------------------------------------------------------
const REPAIR_SYSTEM_PROMPT = `You are a browser automation expert. One step in an automation plan has failed.

You will receive the failed step, its error, the remaining plan, and the current page snapshot.
Output corrective steps that replace the failed step and get the plan back on track.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "thoughts": "<why it failed and how to fix it>",
  "repair": [
    { "action": "<action>", ...args },
    ...
  ],
  "skip_original": false
}

- "repair" is 1–3 steps that replace the failed step (use refs from the NEW snapshot)
- Set "skip_original": true if the step actually succeeded (false-negative) — repair will be empty []
- The remaining plan steps after the failed one are preserved automatically
- run-code MODULE SYSTEM: \`require\` does NOT exist — ES modules only. Use dynamic import if needed:
  const fs = await import('node:fs/promises'); const content = await fs.readFile(path, 'utf8');
  But PREFER to avoid file I/O entirely — any needed content is already in the task as [DATA FROM PRIOR STEP].
- If a run-code step failed due to require/file-reading: replace it with a \`type\` action using content
  from the task description instead.`;

// ---------------------------------------------------------------------------
// Replan prompt — called when a DOM-mutating step caused a structural DOM change.
// The LLM re-generates only the REMAINING steps using a fresh snapshot.
// ---------------------------------------------------------------------------
const REPLAN_SYSTEM_PROMPT = `You are a browser automation expert. A DOM-mutating action just succeeded and the page structure has changed significantly (new modal, panel, or page). The remaining plan steps use stale element refs that are now invalid.

You will receive:
- GOAL: the overall task
- COMPLETED_STEPS: steps already executed successfully
- STALE_REMAINING_PLAN: remaining steps from original plan (refs are stale — do NOT reuse them)
- FRESH_SNAPSHOT: current accessible DOM with new valid refs

Your job: re-generate the remaining steps using ONLY refs from FRESH_SNAPSHOT.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "thoughts": "<one sentence: what changed and how you adapted>",
  "plan": [
    { "action": "<action>", ...args },
    ...
  ]
}

Rules:
- Preserve the original INTENT of each stale step — just use correct fresh refs
- Use element refs (e12, e83) from FRESH_SNAPSHOT for click/fill/hover
- Autocomplete inputs (Gmail To:): fill then press Tab
- Contenteditable areas: click first, then type (not fill)
- Keep plan concise — no unnecessary waits or redundant snapshots
- DIALOG RULE: If a confirmation dialog may appear, add dialog-accept/dismiss after the triggering action
- AI CHAT EXTRACTION RULE: If ANY stale remaining step was waitForStableText or getPageText, you MUST preserve BOTH in the re-plan — in order: first { "action": "waitForStableText" }, then { "action": "getPageText" }. NEVER collapse them into a single getText or omit waitForStableText. The AI response is still streaming when the DOM changes; skipping waitForStableText captures an incomplete response.`;

// ---------------------------------------------------------------------------
// Parse LLM JSON response — tolerant of markdown fences and prose wrappers
// ---------------------------------------------------------------------------
function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const stripped = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) {} }
  return null;
}

// ---------------------------------------------------------------------------
// Trim snapshot for LLM context window
// ---------------------------------------------------------------------------
function trimSnapshot(text, limit = 8000) {
  if (!text) return '(no snapshot available)';
  return text.length > limit ? text.slice(0, limit) + '\n[...snapshot truncated]' : text;
}

// ---------------------------------------------------------------------------
// Extract only interactive element lines from a full snapshot.
// Scans the ENTIRE text (no size limit) line-by-line, keeping only lines
// that have both an interactive ARIA role AND a ref.  One parent context
// line is preserved above each match so the LLM can see nesting (e.g.
// "dialog New Message" before the To/Subject/body refs).
// Falls back to trimSnapshot if no interactive elements are found.
// ---------------------------------------------------------------------------
function extractInteractiveRefs(snapshotText) {
  if (!snapshotText) return '(no snapshot available)';
  // Standard interactive ARIA roles
  const INTERACTIVE   = /\b(textbox|searchbox|combobox|input|textarea|button|link|checkbox|radio|menuitem|option|tab|treeitem|switch|dialog|alertdialog)\b/i;
  // Also capture contenteditable divs (Gmail body, rich-text editors) whose ARIA role is
  // "generic" — they won't match INTERACTIVE but they DO have a ref and are fillable via type.
  const CONTENTEDITABLE = /\[contenteditable\]|contenteditable=["']?true/i;
  const HAS_REF         = /\[?e\d+\]|\[ref=e\d+\]/;
  const lines = snapshotText.split('\n');
  const added = new Set(); // track all pushed lines to prevent any duplicate
  const out   = [];

  const push = (line) => {
    if (!added.has(line)) { added.add(line); out.push(line); }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isInteractive = (INTERACTIVE.test(line) || CONTENTEDITABLE.test(line)) && HAS_REF.test(line);
    if (!isInteractive) continue;

    // Walk backwards to find the nearest ancestor line that carries a meaningful label
    // (quoted string) or a container role — skip blank/punctuation-only lines.
    for (let p = i - 1; p >= Math.max(0, i - 5); p--) {
      const candidate = lines[p];
      if (candidate && candidate.trim() && candidate.trim() !== '-' && candidate.trim() !== ':') {
        push(candidate);
        break;
      }
    }
    push(line);
  }

  if (out.length === 0) return trimSnapshot(snapshotText, 8000); // fallback
  return `[Interactive elements extracted from ${lines.length}-line snapshot]\n` + out.join('\n');
}

// ---------------------------------------------------------------------------
// Count ARIA element refs (e1, e21, …) in a snapshot.
// Used to measure structural DOM change after a mutating action.
// ---------------------------------------------------------------------------
function countRefs(snapshotText) {
  if (!snapshotText) return 0;
  return (snapshotText.match(/\bref=e\d+\b|\[e\d+\]/g) || []).length;
}

// ---------------------------------------------------------------------------
// Normalize LLM step output — handles verb-as-key format the LLM sometimes returns:
//   { "navigate": { "url": "..." } }  →  { "action": "navigate", "url": "..." }
//   { "click": "Compose" }            →  { "action": "click", "selector": "Compose" }
// ---------------------------------------------------------------------------
function normalizeStep(step) {
  if (!step || typeof step !== 'object') return step;
  if (typeof step.action === 'string') return step; // already correct format
  const keys = Object.keys(step);
  if (keys.length === 1) {
    const action = keys[0];
    const inner = step[action];
    if (inner && typeof inner === 'object') return { action, ...inner };
    if (typeof inner === 'string') return { action, selector: inner };
  }
  return step;
}

// ---------------------------------------------------------------------------
// Fire-and-forget progress event POST to _progressCallbackUrl
// ---------------------------------------------------------------------------
function postProgress(callbackUrl, evt) {
  if (!callbackUrl) return;
  try {
    const http = require('http');
    const payload = JSON.stringify(evt);
    const parsed = new URL(callbackUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parseInt(parsed.port, 10),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  2000,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function playwrightAgent(args) {
  const {
    goal,
    sessionId             = 'playwright_agent',
    agentId               = sessionId,
    agentContext,
    maxRepairs            = 4,
    timeoutMs             = 15000,
    headed                = true,
    url,
    _progressCallbackUrl,
    _stepIndex            = 0,
  } = args || {};

  const start = Date.now();

  if (!goal) {
    return { ok: false, error: 'goal is required', executionTime: 0 };
  }

  logger.info(`[playwright.agent] start goal="${goal}" session=${sessionId} maxRepairs=${maxRepairs}`);

  const transcript = [];
  let finalResult = null; // set by a 'return' step if present

  // ── Pre-navigation ─────────────────────────────────────────────────────────
  if (url) {
    logger.info(`[playwright.agent] navigating to: ${url}`);
    const navResult = await browserAct({ action: 'navigate', sessionId, url, headed, timeoutMs: Math.max(timeoutMs, 30000) });
    if (!navResult.ok) {
      return {
        ok: false, goal, sessionId, turns: 0, done: false,
        result: `Failed to navigate to starting URL: ${navResult.error}`,
        transcript: [], error: navResult.error, executionTime: Date.now() - start,
      };
    }
  }

  // ── Phase 1: Snapshot ──────────────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 1: snapshot`);
  const initSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
  let currentSnapshot = (initSnap.ok && initSnap.result) ? initSnap.result : '';

  // ── Phase 1.5: Load learned rules for this agent/hostname ──────────────────
  let learnedRulesBlock = '';
  try {
    const hostname = url ? (() => { try { return new URL(url).hostname.replace(/^\.www\./, ''); } catch (_) { return null; } })() : null;
    const ruleKeys = [agentId];
    if (hostname) ruleKeys.push(hostname);
    const rules = await skillDb.getContextRulesByKeys(ruleKeys);
    if (rules.length > 0) {
      learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — follow exactly):\n${rules.map(r => `- ${r}`).join('\n')}`;
      logger.info(`[playwright.agent] ${rules.length} learned rule(s) injected for [${ruleKeys.join(', ')}]`);
    }
  } catch (_) { /* non-fatal — proceed without rules */ }

  // ── Phase 2: Plan generation ───────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 2: generating plan`);
  const planMessages = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock },
    { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${trimSnapshot(currentSnapshot, 16000)}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
  ];
  let planRaw;
  try {
    planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
  } catch (err) {
    logger.error(`[playwright.agent] plan LLM error: ${err.message}`);
    return { ok: false, goal, sessionId, turns: 0, done: false, result: `LLM unavailable: ${err.message}`, transcript: [], error: err.message, executionTime: Date.now() - start };
  }

  let planParsed = parseJson(planRaw);
  if (!planParsed || !Array.isArray(planParsed.plan)) {
    // Retry once — the first response may have been truncated mid-JSON
    logger.warn(`[playwright.agent] plan response unparseable on first attempt — retrying: ${planRaw?.slice(0, 200)}`);
    try {
      planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
      planParsed = parseJson(planRaw);
    } catch (retryErr) {
      logger.error(`[playwright.agent] plan retry LLM error: ${retryErr.message}`);
    }
  }
  if (!planParsed || !Array.isArray(planParsed.plan)) {
    logger.error(`[playwright.agent] plan response unparseable after retry: ${planRaw?.slice(0, 200)}`);
    return { ok: false, goal, sessionId, turns: 0, done: false, result: 'LLM did not return a valid plan', transcript: [], error: 'invalid plan', executionTime: Date.now() - start };
  }

  let plan = planParsed.plan;
  logger.info(`[playwright.agent] plan generated: ${plan.length} steps — ${planParsed.thoughts}`);

  if (plan.length === 0) {
    return { ok: false, goal, sessionId, turns: 0, done: false, result: planParsed.thoughts || 'LLM returned empty plan', transcript: [], error: planParsed.thoughts, executionTime: Date.now() - start };
  }

  // ── Phase 3: Execute plan ──────────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 3: executing ${plan.length} steps`);
  let stepIndex  = 0;
  let totalRepairs = 0;
  let lastRunCodeResult = null; // captures last successful run-code output for implicit return
  let lastGetPageTextResult = null; // captures last successful getPageText output for implicit return

  // Actions that can mutate the DOM structure (open modals, navigate pages, reveal
  // new elements via lazy-load, toggle conditional sections, etc.).  After any of these
  // succeeds we automatically re-snapshot so snapshotCache stays current, and if ≥30%
  // of refs changed we re-plan the remaining steps with fresh refs (one LLM call).
  const DOM_MUTATING_ACTIONS = new Set([
    'click', 'dblclick',   // modals, dropdowns, SPA navigation
    'navigate', 'goto',    // full page change
    'press',               // Enter=submit, Escape=close dialog, Tab=autocomplete
    'select',              // conditional form sections show/hide
    'drag',                // reorders DOM nodes
    'check', 'uncheck',    // conditional field groups
    'scroll',              // lazy-load / infinite scroll injects new refs
  ]);

  while (stepIndex < plan.length) {
    const step = normalizeStep(plan[stepIndex]);

    // Inline return step — LLM returns extracted data as the final result
    if (step.action === 'return') {
      let data = String(step.data || '').trim();
      // If data is a type placeholder (<string>, {{result}}, etc.) substitute the last run-code result
      if (!data || /^[<{][^>}]+[>}]$/.test(data)) {
        data = lastRunCodeResult || data;
      }
      data = data.slice(0, 2000);
      logger.info(`[playwright.agent] step ${stepIndex + 1}/${plan.length}: return (${data.length} chars)`);
      transcript.push({ step: stepIndex + 1, action: step, outcome: { ok: true, result: data }, thoughts: '' });
      postProgress(_progressCallbackUrl, {
        type: 'agent:turn',
        stepIndex: _stepIndex,
        turn: stepIndex + 1,
        maxTurns: plan.length,
        action: step,
        outcome: { ok: true, result: data },
        thoughts: '',
      });
      finalResult = data;
      break;
    }

    // Inline snapshot step — refresh snapshot AND re-plan remaining steps with fresh refs.
    // The LLM puts an explicit snapshot step when it knows the DOM will change (e.g. after
    // clicking Compose, opening a modal, SPA navigation) but can't predict the new refs upfront.
    // We MUST re-plan the subsequent steps from the new snapshot or they will use stale refs.
    if (step.action === 'snapshot') {
      logger.info(`[playwright.agent] step ${stepIndex + 1}/${plan.length}: snapshot + re-plan`);
      const snap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
      if (snap.ok && snap.result) currentSnapshot = snap.result;

      const remainingAfterSnap = plan.slice(stepIndex + 1);
      if (remainingAfterSnap.length > 0) {
        logger.info(`[playwright.agent] snapshot step: re-planning ${remainingAfterSnap.length} step(s) with fresh refs`);
        try {
          const snapReplanRaw = await askWithMessages([
            { role: 'system', content: REPLAN_SYSTEM_PROMPT },
            { role: 'user', content: [
              `GOAL: ${goal}`,
              `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
              `STALE_REMAINING_PLAN: ${JSON.stringify(remainingAfterSnap)}`,
              ``,
              `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`,
              extractInteractiveRefs(currentSnapshot),
              learnedRulesBlock,
            ].join('\n') },
          ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
          const snapReplanParsed = parseJson(snapReplanRaw);
          if (snapReplanParsed && Array.isArray(snapReplanParsed.plan) && snapReplanParsed.plan.length > 0) {
            logger.info(`[playwright.agent] snapshot re-plan: ${snapReplanParsed.plan.length} fresh steps — ${snapReplanParsed.thoughts || ''}`);
            plan = [...plan.slice(0, stepIndex + 1), ...snapReplanParsed.plan];
          } else {
            logger.warn(`[playwright.agent] snapshot re-plan unparseable — continuing with stale plan`);
          }
        } catch (snapReplanErr) {
          logger.warn(`[playwright.agent] snapshot re-plan LLM error: ${snapReplanErr.message} — continuing with stale plan`);
        }
      }

      transcript.push({ step: stepIndex + 1, action: step, outcome: { ok: true }, thoughts: 'snapshot + re-plan' });
      postProgress(_progressCallbackUrl, {
        type: 'agent:turn',
        stepIndex: _stepIndex,
        turn: stepIndex + 1,
        maxTurns: plan.length,
        action: step,
        outcome: { ok: true, result: 'page re-read + steps re-planned' },
        thoughts: 'snapshot + re-plan',
      });
      stepIndex++;
      continue;
    }

    // Capture structural state before DOM-mutating actions for change detection
    const isDomMutating = DOM_MUTATING_ACTIONS.has(step.action);
    const preRefCount   = isDomMutating ? countRefs(currentSnapshot) : 0;

    // Notify frontend — step starting
    postProgress(_progressCallbackUrl, {
      type: 'agent:turn_live',
      stepIndex: _stepIndex,
      turn: stepIndex + 1,
      maxTurns: plan.length,
      action: step,
    });

    logger.info(`[playwright.agent] step ${stepIndex + 1}/${plan.length}: ${JSON.stringify(step)}`);
    let outcome;
    try {
      outcome = await browserAct({ ...step, sessionId, headed, timeoutMs });
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    logger.info(`[playwright.agent] step ${stepIndex + 1} ok=${outcome.ok}${outcome.error ? ' err=' + outcome.error : ''}`);
    const thoughts = outcome.ok ? '' : (outcome.error || 'failed');
    transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts });

    // Notify frontend — step completed
    postProgress(_progressCallbackUrl, {
      type: 'agent:turn',
      stepIndex: _stepIndex,
      turn: stepIndex + 1,
      maxTurns: plan.length,
      action: step,
      outcome: { ok: outcome.ok, result: outcome.result, error: outcome.error },
      thoughts,
    });

    if (outcome.ok) {
      if (step.action === 'run-code' && outcome.result) {
        lastRunCodeResult = outcome.result;
      }
      if (step.action === 'getPageText' && outcome.result) {
        lastGetPageTextResult = outcome.result;
      }

      // ── Post-fill body verification (self-healing + rule learning) ────────
      // When filling a long text value (>80 chars — clearly email body content,
      // not a short email address or subject line), verify the text actually
      // landed in the page.  Gmail reply/compose bodies are contenteditable divs;
      // a plain `fill` on the wrong ref silently succeeds (exit 0) but leaves the
      // body empty.  If the text is not found in the page, override outcome to
      // ok=false with a descriptive error so the existing repair→deriveRule
      // pipeline fires and LEARNS the correct approach (keyboard.type / run-code).
      // After the first repair the rule is stored in context_rules for gmail.agent
      // and injected into every future plan, so this verification never fires again.
      if (step.action === 'fill' && typeof step.text === 'string' && step.text.length > 80) {
        try {
          const verifySnap = await browserAct({
            action: 'run-code',
            code: `
              const needle = ${JSON.stringify(step.text.slice(0, 40))};
              const bodies = [...document.querySelectorAll('[contenteditable="true"], textarea')];
              const found = bodies.some(el => (el.innerText || el.value || '').includes(needle));
              return found ? 'ok' : 'empty';
            `,
            sessionId, headed, timeoutMs,
          });
          if (verifySnap.ok && verifySnap.result === 'empty') {
            logger.warn(`[playwright.agent] post-fill body verification: text not found in contenteditable/textarea — triggering repair to learn correct approach`);
            outcome = { ok: false, error: 'fill succeeded but body text not found in page — element is likely a contenteditable div; use run-code with page.keyboard.type() or page.getByRole("textbox").fill() instead of a plain fill step' };
          }
        } catch (_) { /* verification failure is non-fatal — proceed */ }
      }

      // ── Auto re-snapshot after DOM-mutating actions ──────────────────────
      // Keeps snapshotCache live so subsequent fill/click use fresh refs.
      // If ≥30% of refs changed (modal opened, page navigated, etc.) also
      // fire one targeted LLM call to re-plan the remaining steps.
      if (isDomMutating) {
        const postSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
        if (postSnap.ok && postSnap.result) {
          currentSnapshot = postSnap.result;
          const postRefCount   = countRefs(currentSnapshot);
          const maxRefs        = Math.max(preRefCount, postRefCount, 1);
          const changeFraction = Math.abs(postRefCount - preRefCount) / maxRefs;
          const absoluteDelta  = postRefCount - preRefCount;
          logger.info(`[playwright.agent] auto-resnapshot after ${step.action}: refs ${preRefCount}→${postRefCount} (${(changeFraction * 100).toFixed(0)}% change, +${absoluteDelta} absolute)`);

          const remaining = plan.slice(stepIndex + 1);
          // Trigger re-plan if ≥30% of refs changed OR ≥20 new refs appeared in absolute terms.
          // The absolute check catches large pages (e.g. Gmail inbox = 993 refs) where opening
          // the Compose modal adds ~75 refs — only 7% change but clearly a new modal overlay.
          const significantChange = (changeFraction >= 0.30 || absoluteDelta >= 20) && (preRefCount > 0 || postRefCount > 0);

          if (significantChange && remaining.length > 0) {
            logger.info(`[playwright.agent] structural DOM change — re-planning ${remaining.length} remaining step(s) with fresh refs`);
            try {
              const replanRaw = await askWithMessages([
                { role: 'system', content: REPLAN_SYSTEM_PROMPT },
                { role: 'user', content: [
                  `GOAL: ${goal}`,
                  `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
                  `STALE_REMAINING_PLAN: ${JSON.stringify(remaining)}`,
                  ``,
                  `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`,
                  extractInteractiveRefs(currentSnapshot),
                  learnedRulesBlock,
                ].join('\n') },
              ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
              const replanParsed = parseJson(replanRaw);
              if (replanParsed && Array.isArray(replanParsed.plan) && replanParsed.plan.length > 0) {
                logger.info(`[playwright.agent] re-plan: ${replanParsed.plan.length} fresh steps — ${replanParsed.thoughts || ''}`);
                plan = [...plan.slice(0, stepIndex + 1), ...replanParsed.plan];
              } else {
                logger.warn(`[playwright.agent] re-plan response unparseable or empty — continuing with stale plan`);
              }
            } catch (replanErr) {
              logger.warn(`[playwright.agent] re-plan LLM error: ${replanErr.message} — continuing with stale plan`);
            }
          }
        }
      }

      stepIndex++;
      continue;
    }

    // ── Step failed → repair ─────────────────────────────────────────────────
    if (totalRepairs >= maxRepairs) {
      logger.warn(`[playwright.agent] step ${stepIndex + 1} failed — repair limit (${maxRepairs}) reached`);
      return {
        ok: false, goal, sessionId,
        turns: transcript.length, done: false,
        result: `Step ${stepIndex + 1} (${step.action}) failed: ${outcome.error}`,
        transcript, error: outcome.error, executionTime: Date.now() - start,
      };
    }

    totalRepairs++;
    logger.info(`[playwright.agent] step ${stepIndex + 1} failed — repair ${totalRepairs}/${maxRepairs}: ${outcome.error}`);

    // Fresh snapshot for repair context
    const repairSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
    if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;

    const remainingSteps = plan.slice(stepIndex + 1);
    let repairRaw;
    try {
      repairRaw = await askWithMessages([
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        { role: 'user', content: [
          `GOAL: ${goal}`,
          `FAILED_STEP: ${JSON.stringify(step)}`,
          `ERROR: ${outcome.error}`,
          `REMAINING_PLAN: ${JSON.stringify(remainingSteps)}`,
          ``,
          `SNAPSHOT:`,
          trimSnapshot(currentSnapshot),
        ].join('\n') },
      ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
    } catch (err) {
      return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Repair LLM unavailable: ${err.message}`, transcript, error: err.message, executionTime: Date.now() - start };
    }

    const repairParsed = parseJson(repairRaw);
    if (!repairParsed || !Array.isArray(repairParsed.repair)) {
      logger.warn(`[playwright.agent] repair response unparseable — aborting`);
      return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Step ${stepIndex + 1} failed and repair was unparseable`, transcript, error: outcome.error, executionTime: Date.now() - start };
    }

    logger.info(`[playwright.agent] repair: ${repairParsed.repair.length} corrective steps — ${repairParsed.thoughts}`);

    // Fire-and-forget: derive a ≤150-char rule from this failure+repair and store it in context_rules
    // so future plan generations for this agent automatically avoid the same mistake.
    if (!repairParsed.skip_original && repairParsed.repair.length > 0) {
      (async () => {
        try {
          const ruleRaw = await askWithMessages([
            { role: 'system', content: 'You derive short browser automation rules from failures. Reply with ONLY the rule text (≤150 chars), no preamble or quotes.' },
            { role: 'user', content: `Failed step: ${JSON.stringify(step)}\nError: ${outcome.error}\nFixed by: ${JSON.stringify(repairParsed.repair)}\n\nWrite a single rule that prevents this failure next time.` },
          ], { temperature: 0.1, maxTokens: 80, responseTimeoutMs: 10000 });
          const ruleText = (ruleRaw || '').trim().replace(/^["'`]|["'`]$/g, '').slice(0, 150);
          if (ruleText && ruleText.length > 10) {
            await skillDb.setContextRule(agentId, ruleText, 'agent');
            const hostname = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })() : null;
            if (hostname) await skillDb.setContextRule(hostname, ruleText, 'site');
            logger.info(`[playwright.agent] learned rule saved for ${agentId}: "${ruleText}"`);
          }
        } catch (_) { /* non-fatal */ }
      })();
    }

    if (repairParsed.skip_original) {
      // LLM says the step actually succeeded (false-negative) — skip it
      stepIndex++;
    } else {
      // Splice repair steps in place of the failed step; remaining plan is preserved
      plan = [
        ...plan.slice(0, stepIndex),        // steps already done
        ...repairParsed.repair,             // replacement for failed step
        ...plan.slice(stepIndex + 1),       // original remaining steps
      ];
      // stepIndex stays — now points to first repair step
    }
  }

  // If plan ended without an explicit return step, use the last run-code result
  if (finalResult === null && lastRunCodeResult !== null) {
    finalResult = lastRunCodeResult;
  }
  if (finalResult === null && lastGetPageTextResult !== null) {
    finalResult = lastGetPageTextResult;
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  logger.info(`[playwright.agent] DONE — ${transcript.length} steps executed (${totalRepairs} repairs)`);
  postProgress(_progressCallbackUrl, {
    type: 'agent:complete',
    stepIndex: _stepIndex,
    agentId: 'playwright.agent',
    task: goal,
    totalTurns: transcript.length,
    done: true,
    ok: true,
    result: finalResult !== null ? finalResult : `Completed: ${goal}`,
  });
  return {
    ok: true, goal, sessionId,
    turns: transcript.length, done: true,
    result: finalResult !== null ? finalResult : `Completed: ${goal}`,
    transcript,
    executionTime: Date.now() - start,
  };
}

module.exports = { playwrightAgent };
