'use strict';

/**
 * skill: agentbrowser.agent
 *
 * Plan-Execute browser agent using Vercel's agent-browser CLI.
 * Token-efficient: snapshots are compact interactive-only text (~200-500 tokens)
 * with @eN refs — not YAML files requiring 27k tokens.
 *
 *   Phase 1   — Snapshot: capture current page state via agent-browser snapshot -i
 *   Phase 1.2 — Orientation: clear interstitials before plan generation
 *   Phase 1.5 — Load learned rules from skillDb
 *   Phase 2   — Plan: LLM generates a full ordered list of agentbrowserAct steps
 *   Phase 3   — Execute: run each step in sequence via agentbrowserAct
 *               on failure → snapshot + LLM repairs just that step → continue
 *
 * Key differences from playwright.agent:
 *   - Refs use @eN format (@ prefix required) — plain eN is normalised automatically
 *   - keyboard-type replaces run-code+page.keyboard.type() for contenteditable
 *   - eval = browser-side JS only (document/window/fetch; NO page, NO require())
 *   - Snapshots passed directly to LLM — already compact, no trimming/preprocess
 *   - Replan threshold: 15% (not 30%) — snapshots are tiny so ref deltas are sharper
 *   - find-role/label/text provide semantic fallbacks when refs are stale
 *   - Auth integrated: pass authSignInUrl to trigger waitForAuth before task steps
 *
 * Args:
 *   goal            {string}  — plain-language description of what to accomplish
 *   sessionId       {string}  — browser session id (default: 'agentbrowser_agent')
 *   agentId         {string}  — agent id for rule storage (default: sessionId)
 *   agentContext    {string}  — optional: agent descriptor context injected into plan prompt
 *   authSignInUrl   {string}  — optional: if set, calls waitForAuth before task steps
 *   authSuccessPattern {string} — optional: URL pattern that signals auth success
 *   maxRepairs      {number}  — max total repair LLM calls before giving up (default: 4)
 *   timeoutMs       {number}  — per-action timeout ms (default: 15000)
 *   headed          {boolean} — show browser window (default: true)
 *   url             {string}  — optional: navigate here before starting
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const logger = require('../logger.cjs');
const { agentbrowserAct } = require('./agentbrowser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const skillDb = require('../skill-helpers/skill-db.cjs');

// Tracks in-progress sessions so the stealth daemon restart never kills a Chrome window
// that is currently mid-auth or mid-execution. Checked by the close-all guard below.
const _activeSessions = new Set();

// ---------------------------------------------------------------------------
// Action schema constants — agent-browser CLI semantics
// Refs use @eN format. keyboard-type for contenteditable. eval for browser JS.
// ---------------------------------------------------------------------------

const AB_ACTIONS_FULL = `Available actions:
  navigate        { url }
  click           { selector }         — use snapshot ref (@e12) directly; never omit the @
  dblclick        { selector }
  fill            { selector, text }   — for <input> / <textarea> fields ONLY (NOT contenteditable)
  keyboard-type   { text }             — type into currently focused element (contenteditable, rich-text, AI chat body)
                                         Click the element first to focus it, THEN use keyboard-type.
  press           { key }              — "Enter", "Tab", "Escape", "Meta+a", "Meta+Enter", etc.
  select          { selector, value }  — dropdown option
  check           { selector }
  uncheck         { selector }
  hover           { selector }
  scroll          { direction, dy }    — direction: up|down|left|right; dy: pixels (e.g. 300)
  drag            { selector, target } — drag from selector to target element ref
  find-role       { role, findAction, name? } — semantic: find element by ARIA role and click/fill it
  find-label      { label, findAction, value? } — semantic: find element by label text
  find-text       { text }             — semantic: find visible text and click it
  wait-url        { pattern }          — wait until current URL contains pattern
  wait-text       { text }             — wait until text appears on page
  waitForContent  { text }             — alias for wait-text
  eval            { code }             — browser-side JavaScript (document, window, fetch available)
                                         NO page object. NO require(). Returns plain stdout.
                                         Example: { "action": "eval", "code": "document.title" }
                                         Example: { "action": "eval", "code": "document.querySelector('h1')?.textContent" }
  getPageText     {}                   — returns document.body.innerText (up to 50k chars).
                                         Universal page reader — works on any site without CSS knowledge.
                                         Use after AI-chat prompts: click → keyboard-type → press Enter →
                                         waitForContent/wait-text → getPageText. Result auto-captured as output.
  screenshot      { filePath }
  snapshot        {}                   — re-read the page (ONLY when page changes significantly)
  return          { data: "<string>" } — MUST be LAST step; plain string output, max 2000 chars.
  dialog-accept   { prompt? }
  dialog-dismiss  {}`;

const AB_ACTIONS_INTERACT = `Available actions (interstitial-clearing only):
  navigate        { url }              — LAST RESORT only; STAY ON SERVICE domain
  click           { selector }         — use snapshot ref (@e12) with @ prefix
  dblclick        { selector }
  fill            { selector, text }   — for <input> / <textarea> fields
  keyboard-type   { text }             — types into currently focused element
  press           { key }              — "Escape", "Enter", "Tab"
  select          { selector, value }  — dropdown option (e.g. onboarding "How will you use this?")
  check           { selector }         — tick a checkbox (e.g. terms agreement)
  uncheck         { selector }
  hover           { selector }
  scroll          { direction, dy }
  drag            { selector, target }
  dialog-accept   { prompt? }
  dialog-dismiss  {}`;

// Step format rules — injected into all prompts so every LLM uses correct field names and @eN refs
const AB_STEP_FORMAT = `CRITICAL: each step MUST use this exact format: { "action": "<name>", ...args }
CORRECT:  { "action": "navigate", "url": "https://mail.google.com/mail/u/0/#inbox" }
CORRECT:  { "action": "click", "selector": "@e24" }   — refs MUST have @ prefix
CORRECT:  { "action": "fill", "selector": "@e12", "text": "user@example.com" }
CORRECT:  { "action": "keyboard-type", "text": "Hello world" }
CORRECT:  { "action": "eval", "code": "document.title" }
WRONG:    { "navigate": { "url": "..." } }
WRONG:    { "click": "Compose" }
WRONG:    { "action": "click", "selector": "e24" }   — MISSING @ — will fail (Ref not found)
WRONG:    { "action": "run-code", ... }              — run-code is playwright-cli only; use eval instead`;

// Phase 1 prompt — plan generation
const AB_PLAN_SYSTEM_PROMPT = `You are a browser automation expert controlling a real Chrome browser via the agent-browser CLI.

HOW IT WORKS — read this carefully:
Each step in your plan maps 1:1 to one agent-browser command:
  { "action": "navigate", "url": "https://..." }               →  agent-browser --session S open https://...
  { "action": "click", "selector": "@e24" }                    →  agent-browser --session S click @e24
  { "action": "fill", "selector": "@e12", "text": "hello" }    →  agent-browser --session S fill @e12 hello
  { "action": "keyboard-type", "text": "Dear team..." }        →  agent-browser --session S keyboard type "Dear team..."
  { "action": "eval", "code": "document.title" }               →  agent-browser --session S eval "document.title"

The SNAPSHOT is a COMPACT accessibility text listing interactive elements only.
Format: - [role] "label" [ref=eN]  e.g.  - button "Compose" [ref=e1]  - textbox "To" [ref=e3]
Refs appear as [ref=eN] in the snapshot. Use @eN as the selector in commands — e.g. [ref=e12] → "selector": "@e12".
The @ prefix is REQUIRED in selectors (@e12 not e12 — missing @ causes "Ref not found" errors).

contenteditable / rich-text areas (Gmail body, Notion, AI chat inputs):
  - Do NOT use fill — fill only works on standard <input>/<textarea> elements
  - Pattern: click the editor ref to focus it, THEN use keyboard-type to type text
  - Example: { "action": "click", "selector": "@e18" }, { "action": "keyboard-type", "text": "Dear..." }

eval context — browser-side JavaScript (NOT Node.js):
  - document/window/fetch ARE available
  - NO page object — this is browser context, not Playwright Node.js
  - NO require() — browser-side only. Use fetch() for network calls.
  - result is returned as plain stdout text (no ### Result wrapper)

You will receive the current page snapshot (compact interactive accessibility text) and a goal.
Output the complete ordered list of browser actions needed to accomplish the goal.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "thoughts": "<one sentence: what you see and your approach>",
  "plan": [
    { "action": "<action>", ...args },
    ...
  ]
}

${AB_ACTIONS_FULL}

${AB_STEP_FORMAT}

Rules:
- PAGE ORIENTATION RULE: Before writing any task steps, assess the snapshot — ask "Is this page where I can accomplish the goal?" If blocked by an interstitial (onboarding, cookie wall, paywall, 404, setup screen), FIRST ask: "Is there a clickable element in this snapshot that moves me TOWARD the goal?" — e.g. 'Continue', 'Skip', 'Get started', 'Accept', 'Dismiss'. If YES, your FIRST step MUST be a click on that element, immediately followed by { "action": "snapshot" }. Only use navigate as a last resort. STAY ON SERVICE — any navigate MUST stay within the same service domain.
- Use element refs (@e12, @e83) from the snapshot for click/fill/hover — they MUST include the @ prefix.
- Autocomplete inputs (e.g. Gmail To:): fill then press Tab.
- Contenteditable/rich-text areas: click first to focus, then keyboard-type (NOT fill).
- Do NOT include auth steps — assume already logged in.
- CREDENTIALS RULE: If credentials not in goal text are required, return empty plan.
- Keep plan concise — no unnecessary waits or redundant snapshots.
- MULTI-ITEM EXTRACTION: Use one eval step with document.querySelectorAll(). Never click per-item.
- EVAL RETURN: eval result is auto-captured as task output — do NOT add a placeholder return step after it.
- DIALOG RULE: If a confirmation dialog may appear, add dialog-accept/dismiss immediately after the triggering action.
- MODAL/OVERLAY RULE: When clicking a button that opens a modal or overlay (Compose, New, Reply, etc.), add { "action": "snapshot" } as the very next step. This forces a DOM re-read so all following steps use fresh refs from the new modal.
- AI CHAT EXTRACTION RULE: When sending a message to an AI assistant (ChatGPT, Claude, Grok, Perplexity, etc.), after pressing Enter add: (1) { "action": "wait-text", "text": "..." } or { "action": "waitForContent", "text": "..." } to wait for the response, (2) { "action": "getPageText" } to read all visible page text. This is the UNIVERSAL approach — works on any AI site. NEVER use eval with site-specific CSS selectors for AI chat extraction. Do NOT add a return step — getPageText result is automatically captured.
- SESSION ISOLATION RULE: When accessing an AI chat service (ChatGPT, Perplexity, Gemini, Claude, etc.), ALWAYS start with a navigate to its fresh/new-chat URL. EXCEPTION: If the task explicitly involves a follow-up or continuation of a previous AI response (keywords: "follow up", "continue", "based on that", "expand on"), stay on the current page.
- NO PLACEHOLDER RULE: NEVER write literal template placeholder text like [ChatGPT response] in any step args. Always use {{synthesisAnswer}} as the sole body content token when combining multi-source AI extractions.`;

// Phase 1.2 prompt — orientation loop
const AB_ORIENTATION_SYSTEM_PROMPT = `You are a browser automation assistant. The current page may be blocking a task.
Your job: decide ONE thing — is there a SINGLE action you can take RIGHT NOW on this page that moves toward the goal?

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

If the page IS the right starting point (workspace, inbox, chat interface, dashboard, etc.):
{ "oriented": true }

If there IS an action that moves toward the goal:
{ "oriented": false, "step": { "action": "<action>", ...args } }

${AB_ACTIONS_INTERACT}

${AB_STEP_FORMAT}

DECISION RULES — apply in this priority order:
1. PREFER CLICK: If there is a visible button or link like "Continue", "Skip", "Get started", "Go to my workspace", "Accept", "Dismiss", "Maybe later", "Enter workspace", or any element that leads INTO the main app — click it using its snapshot ref (e.g. "@e24"). REFS MUST include the @ prefix.
2. PRESS Escape: If a modal/dialog blocks the page and there is no obvious dismiss button, try { "action": "press", "key": "Escape" }.
3. NAVIGATE (absolute last resort): If no clickable path exists anywhere in the snapshot, navigate to the service's direct workspace URL. STAY ON SERVICE — never navigate to Google or any external site.
4. If the page IS already the right starting point — return { "oriented": true } immediately. Do not invent unnecessary steps.

GOAL ALIGNMENT: The action must move TOWARD the goal. Ask: "After this action, will I be on a page where I can accomplish the goal?"`;

// Phase 3 failure prompt — called only when a step fails
const AB_REPAIR_SYSTEM_PROMPT = `You are a browser automation expert. One step in an automation plan has failed.

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
- Snapshot refs use @eN format — MUST include @ prefix (@e12 not e12)
- contenteditable areas: use keyboard-type (not fill), click first to focus
- eval = browser-side JS only (document/window/fetch available; NO page object, NO require())
- If an eval step failed due to missing page object: rewrite it using document.querySelectorAll() directly
- find-role/find-label/find-text: use as fallbacks when refs are stale`;

// DOM change re-plan prompt — called when structural DOM change detected after a mutating action
const AB_REPLAN_SYSTEM_PROMPT = `You are a browser automation expert. A DOM-mutating action just succeeded and the page structure has changed significantly (new modal, panel, or page navigation). The remaining plan steps use stale @eN refs that are now invalid.

You will receive:
- GOAL: the overall task
- COMPLETED_STEPS: steps already executed successfully
- STALE_REMAINING_PLAN: remaining steps from original plan (refs are stale — do NOT reuse them)
- FRESH_SNAPSHOT: current compact accessibility text with new valid refs

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
- Preserve the original INTENT of each stale step — just use correct fresh @eN refs
- Refs MUST include @ prefix (@e12 not e12)
- Autocomplete inputs (Gmail To:): fill then press Tab
- Contenteditable areas: click first to focus, then keyboard-type (not fill)
- Keep plan concise — no unnecessary waits or redundant snapshots
- DIALOG RULE: If a confirmation dialog may appear, add dialog-accept/dismiss after the triggering action
- AI CHAT EXTRACTION RULE: If ANY stale remaining step was waitForContent/wait-text or getPageText, you MUST preserve BOTH in the re-plan — in order: first wait-text/waitForContent, then getPageText. NEVER omit wait-text before getPageText.`;

// ---------------------------------------------------------------------------
// Parse LLM JSON response — tolerant of markdown fences and prose wrappers
// (copied verbatim from playwright.agent — format-agnostic utility)
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
// Detect HTTP error pages in getPageText output.
// (copied verbatim from playwright.agent — works on any page content)
// ---------------------------------------------------------------------------
function _detectHttpErrorPage(text) {
  if (!text) return null;
  const t = text.slice(0, 4000);
  const statusMatch = t.match(/\b(500|502|503|504|429)\b/);
  if (!statusMatch) return null;
  const hasErrorPhrases = /that'?s an error|server error|temporarily unavailable|bad gateway|service unavailable|too many requests|please try again(?: later)?|error occurred|couldn'?t process|unexpected error/i.test(t);
  if (!hasErrorPhrases) return null;
  const looksLikeAIPage = /new chat|start a new conversation|ask me anything|enter a prompt|how can i help|what can i help|ask gemini|message chatgpt/i.test(t);
  if (looksLikeAIPage) return null;
  return statusMatch[1];
}

// ---------------------------------------------------------------------------
// Trim snapshot for LLM context window.
// agent-browser -i snapshots are already compact (~200-500 tokens typically)
// so this rarely triggers, but we cap at 32k chars as a safety limit.
// ---------------------------------------------------------------------------
function trimSnapshotAB(text, limit = 32000) {
  if (!text) return '(no snapshot available)';
  return text.length > limit ? text.slice(0, limit) + '\n[...snapshot truncated]' : text;
}

// ---------------------------------------------------------------------------
// Count [ref=eN] entries in an agent-browser snapshot.
// agent-browser snapshot -i outputs: - role "label" [ref=eN]
// Selectors in commands use @eN format (e.g. click @e12).
// ---------------------------------------------------------------------------
function countRefsAB(snapshotText) {
  if (!snapshotText) return 0;
  return (snapshotText.match(/\[ref=e\d+\]/g) || []).length;
}

// ---------------------------------------------------------------------------
// Detect whether a snapshot looks like an interstitial blocking the task.
// (copied verbatim from playwright.agent — heuristic works on any text format)
// ---------------------------------------------------------------------------
function looksLikeInterstitial(snapshotText) {
  if (!snapshotText) return false;
  const t = snapshotText.slice(0, 6000).toLowerCase();
  return (
    /how (do |will )?(you|we) (want to |plan to )?use|how are you planning to use/.test(t) ||
    /set up your (workspace|account|profile)|complete your (setup|profile|onboarding)/.test(t) ||
    /welcome to (your )?(notion|workspace|app)|let's get (you )?started|get started with/.test(t) ||
    /create your first (page|project|task|workspace)|tell us about yourself/.test(t) ||
    /personali(z|s)e your (experience|workspace)|choose a (template|plan|workspace)/.test(t) ||
    /\b(accept|agree to) (all )?(cookies|terms|privacy)|cookie (consent|policy|notice|banner)/.test(t) ||
    /we use cookies|by (continuing|using this site) you agree/.test(t) ||
    /upgrade (your plan|to pro|to (a )?paid)|start (your )?free trial|choose a plan/.test(t) ||
    /sign in to continue|log in to (view|access|continue)|you (must|need to) (be logged in|sign in)/.test(t) ||
    // Notion workspace join / onboarding flow
    /\bjoin (workspace|space|team)\b|you('ve| have) been invited to join|join [a-z].{0,40}'?s (workspace|space)/.test(t) ||
    /\bonboarding\b.*\b(skip|continue|join|get started)\b/.test(t)
  );
}

// ---------------------------------------------------------------------------
// Orientation loop — runs up to MAX_ORIENT_STEPS iterations BEFORE plan
// generation, clicking past interstitials one step at a time.
// ---------------------------------------------------------------------------
const MAX_ORIENT_STEPS = 3;

async function orientPage({ goal, snapshot, sessionId, headed, timeoutMs, learnedRulesBlock, autoConnect = false, stealth = false, provider = null }) {
  // Build a local act helper bound to the same browser context as the caller.
  const _orientAct = autoConnect
    ? (a) => agentbrowserAct({ ...a, autoConnect: true, stealth, provider })
    : (a) => agentbrowserAct({ ...a, stealth, provider });

  let currentSnapshot = snapshot;
  for (let i = 0; i < MAX_ORIENT_STEPS; i++) {
    let orientRaw;
    try {
      orientRaw = await askWithMessages([
        { role: 'system', content: AB_ORIENTATION_SYSTEM_PROMPT },
        { role: 'user', content: `GOAL: ${goal}\n\nSNAPSHOT:\n${trimSnapshotAB(currentSnapshot, 8000)}${learnedRulesBlock || ''}` },
      ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });
    } catch (err) {
      logger.warn(`[agentbrowser.agent] orientation LLM error (step ${i + 1}/${MAX_ORIENT_STEPS}): ${err.message} — skipping`);
      break;
    }

    const parsed = parseJson(orientRaw);
    if (!parsed) {
      logger.warn(`[agentbrowser.agent] orientation response unparseable (step ${i + 1}/${MAX_ORIENT_STEPS}) — skipping`);
      break;
    }

    if (parsed.oriented === true) {
      logger.info(`[agentbrowser.agent] orientation: page is already the right starting point (after ${i} step(s))`);
      break;
    }

    if (!parsed.step || typeof parsed.step.action !== 'string') {
      logger.warn(`[agentbrowser.agent] orientation: no valid step returned (step ${i + 1}/${MAX_ORIENT_STEPS}) — skipping`);
      break;
    }

    const orientStep = parsed.step;
    logger.info(`[agentbrowser.agent] orientation step ${i + 1}/${MAX_ORIENT_STEPS}: ${JSON.stringify(orientStep)}`);

    let outcome;
    try {
      outcome = await _orientAct({ ...orientStep, sessionId, headed, timeoutMs });
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    if (!outcome.ok) {
      logger.warn(`[agentbrowser.agent] orientation step ${i + 1} failed: ${outcome.error} — stopping orientation`);
      break;
    }

    await _orientAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 8000) }).catch(() => {});
    const reSnap = await _orientAct({ action: 'snapshot', sessionId, headed, timeoutMs });
    if (reSnap.ok && reSnap.result) {
      currentSnapshot = reSnap.result;
      logger.info(`[agentbrowser.agent] orientation: re-snapshotted after step ${i + 1} (${countRefsAB(currentSnapshot)} refs)`);
    }

    if (!looksLikeInterstitial(currentSnapshot)) {
      logger.info(`[agentbrowser.agent] orientation: interstitial cleared after ${i + 1} step(s) ✓`);
      break;
    }
  }
  return currentSnapshot;
}

// ---------------------------------------------------------------------------
// Normalize LLM step output — handles verb-as-key format:
//   { "navigate": { "url": "..." } }  →  { "action": "navigate", "url": "..." }
//   { "click": "@e24" }               →  { "action": "click", "selector": "@e24" }
// (copied verbatim from playwright.agent — same normalization needed)
// ---------------------------------------------------------------------------
function normalizeStep(step) {
  if (!step || typeof step !== 'object') return step;
  if (typeof step.action === 'string') return step;
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
// Fire-and-forget progress event POST
// (copied verbatim from playwright.agent)
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
async function agentbrowserAgent(args) {
  const {
    goal,
    sessionId             = 'agentbrowser_agent',
    agentId               = sessionId,
    agentContext,
    authSignInUrl,
    authSuccessPattern,
    maxRepairs            = 4,
    timeoutMs             = 15000,
    headed                = true,
    url,
    chromeProfile         = null,
    autoConnect           = false,  // --auto-connect: attach to user's running Chrome
    stealth               = (process.env.THINKDROP_STEALTH !== 'false'),  // env-driven default: true unless THINKDROP_STEALTH=false
    provider              = null,   // cloud browser provider: 'browserless' | 'kernel' | etc.
    _progressCallbackUrl,
    _stepIndex            = 0,
  } = args || {};

  const start = Date.now();
  // Partial-bind autoConnect/chromeProfile so every internal agentbrowserAct call uses
  // the same browser context.
  //   autoConnect=true  → --auto-connect (attach to user's real running Chrome)
  //   chromeProfile set → --profile <name> (persistent Chrome profile, Google OAuth)
  //   neither           → --session isolation (default sandboxed session)
  const _act = autoConnect
    ? (a) => agentbrowserAct({ ...a, autoConnect: true, stealth, provider })
    : (chromeProfile
        ? (a) => agentbrowserAct({ ...a, chromeProfile, stealth, provider })
        : (a) => agentbrowserAct({ ...a, stealth, provider }));

  if (stealth) {
    logger.info(`[agentbrowser.agent] stealth mode active${provider ? ` via provider=${provider}` : ' (local: real Chrome binary + navigator.webdriver suppression)'}`);
    if (provider === 'browserless' && !process.env.BROWSERLESS_API_KEY) {
      logger.warn('[agentbrowser.agent] BROWSERLESS_API_KEY not set — provider=browserless will fail');
    }
    if (provider === 'kernel' && !process.env.KERNEL_API_KEY) {
      logger.warn('[agentbrowser.agent] KERNEL_API_KEY not set — provider=kernel will fail');
    }
    if (!autoConnect && !provider) {
      // Kill any stale daemon — stealth flags (--executable-path, --args) are only
      // honoured at daemon start time. If the daemon is already running it silently
      // ignores them. Force a clean restart so the next 'open' launches Chrome with
      // the real binary + anti-detection args.
      // Guard: if any session is already executing (e.g. a concurrent retry fired by
      // recoverSkill), skip close-all to avoid killing the active auth/browser window.
      if (_activeSessions.size === 0) {
        logger.info('[agentbrowser.agent] stealth: closing stale daemon so it restarts with anti-detection flags');
        await agentbrowserAct({ action: 'close-all' }).catch(() => {});
      } else {
        logger.info(`[agentbrowser.agent] stealth: skipping close-all — ${_activeSessions.size} active session(s) in progress: ${[..._activeSessions].join(', ')}`);
      }
    }
  }

  if (!goal) {
    return { ok: false, error: 'goal is required', executionTime: 0 };
  }

  // Track this session so concurrent retries know not to call close-all while Chrome is active.
  // try/finally ensures cleanup on every exit path (auth failure, plan failure, success).
  _activeSessions.add(sessionId);
  try {
  logger.info(`[agentbrowser.agent] start goal="${goal}" session=${sessionId} maxRepairs=${maxRepairs}`);

  const transcript = [];
  let finalResult = null;

  // ── Pre-navigation ─────────────────────────────────────────────────────────
  // Always navigate to the site first. If authSignInUrl is set but no explicit
  // start url, use the site root (origin of authSignInUrl) so we land on the
  // real page — not the sign-in page — and can detect whether auth is needed.
  const _navUrl = url || (authSignInUrl ? (() => { try { return new URL(authSignInUrl).origin; } catch (_) { return null; } })() : null);
  if (_navUrl) {
    logger.info(`[agentbrowser.agent] navigating to: ${_navUrl}`);
    const navResult = await _act({ action: 'navigate', sessionId, url: _navUrl, headed, timeoutMs: Math.max(timeoutMs, 30000) });
    if (!navResult.ok) {
      return {
        ok: false, goal, sessionId, turns: 0, done: false,
        result: `Failed to navigate to starting URL: ${navResult.error}`,
        transcript: [], error: navResult.error, executionTime: Date.now() - start,
      };
    }
  }

  // ── Phase 1: Wait for SPA to stabilise, then snapshot ────────────────────
  if (_navUrl) {
    logger.info(`[agentbrowser.agent] phase 1: waiting for page to stabilise before snapshot`);
    await _act({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) }).catch(() => {});
  }

  // ── Lazy auth gate — only trigger if site actually redirected to login ─────
  // Check current URL after navigation. Only call waitForAuth if the site
  // redirected to a sign-in path (session expired / first visit). This avoids
  // blocking for 120s on sites that work without login (Perplexity basic use)
  // and avoids navigating to 404 sign-in URLs that don't exist.
  if (authSignInUrl) {
    const hrefResult = await _act({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 }).catch(() => ({}));
    const currentHref = String(hrefResult?.result ?? hrefResult?.output ?? '');
    const isLoginPage = currentHref.length > 0 && /sign.?in|log.?in|\/auth\b|\/login\b/i.test(currentHref);
    if (isLoginPage) {
      logger.info(`[agentbrowser.agent] auth required — site redirected to login page: ${currentHref}`);
      let authResult;
      try {
        authResult = await _act({
          action:            'waitForAuth',
          sessionId,
          url:               authSignInUrl,
          authSuccessUrl:    authSuccessPattern,
          headed,
          timeoutMs:         120000,
          _progressCallbackUrl,
        });
      } catch (err) {
        return { ok: false, goal, sessionId, error: `waitForAuth threw: ${err.message}`, executionTime: Date.now() - start };
      }
      if (!authResult?.ok) {
        return { ok: false, goal, sessionId, error: `Auth failed: ${authResult?.error || 'timed out'}`, executionTime: Date.now() - start };
      }
      logger.info(`[agentbrowser.agent] auth resolved — proceeding with task`);
    } else {
      logger.info(`[agentbrowser.agent] auth-check: site did not redirect to login${currentHref ? ` (${currentHref})` : ''} — skipping waitForAuth`);
    }
  }
  logger.info(`[agentbrowser.agent] phase 1: snapshot`);
  const initSnap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
  let currentSnapshot = (initSnap.ok && initSnap.result) ? initSnap.result : '';

  // ── Phase 1.2: Orientation loop — clear interstitials before plan generation
  if (looksLikeInterstitial(currentSnapshot)) {
    logger.info(`[agentbrowser.agent] phase 1.2: interstitial detected — running orientation loop (up to ${MAX_ORIENT_STEPS} steps)`);
    currentSnapshot = await orientPage({ goal, snapshot: currentSnapshot, sessionId, headed, timeoutMs, learnedRulesBlock: '', autoConnect, stealth, provider });
  }

  // ── Phase 1.5: Load learned rules for this agent/hostname ─────────────────
  let learnedRulesBlock = '';
  try {
    const hostname = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })() : null;
    const ruleKeys = [agentId];
    if (hostname) ruleKeys.push(hostname);
    const rules = await skillDb.getContextRulesByKeys(ruleKeys);
    if (rules.length > 0) {
      learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — follow exactly):\n${rules.map(r => `- ${r}`).join('\n')}`;
      logger.info(`[agentbrowser.agent] ${rules.length} learned rule(s) injected for [${ruleKeys.join(', ')}]`);
    }
  } catch (_) { /* non-fatal */ }

  // ── Phase 1.6: Build domain-lock block ──────────────────────────────────────
  // Inject the service hostname so the planner and all re-plan/repair prompts
  // know EXACTLY which domain they must stay on — LLM instruction only is
  // insufficient when the goal wording is ambiguous (e.g. "search for X").
  const hostname = url
    ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })()
    : null;
  const domainLockBlock = hostname
    ? `\n\nDOMAIN LOCK — ABSOLUTE:\nYou are automating '${hostname}'. NEVER navigate to any external site (not Google, Bing, DuckDuckGo, or any other place outside ${hostname}). If the goal involves searching, use ONLY the search/find features built into ${hostname} itself. Any navigate step MUST stay on '${hostname}' — violating this is a critical failure.`
    : '';

  // ── Phase 2: Plan generation ───────────────────────────────────────────────
  // Pass snapshot directly to LLM — agent-browser -i snapshots are already
  // compact interactive-only text (~200-500 tokens), no preprocessing needed.
  logger.info(`[agentbrowser.agent] phase 2: generating plan (snapshot=${currentSnapshot.length} chars, ${countRefsAB(currentSnapshot)} refs)`);
  const snapshotForPlan = trimSnapshotAB(currentSnapshot, 32000);
  const _serviceUrlLine = url ? `SERVICE URL: ${url}\n` : '';
  const planMessages = [
    { role: 'system', content: AB_PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
    { role: 'user',   content: `${_serviceUrlLine}GOAL: ${goal}\n\nSNAPSHOT:\n${snapshotForPlan}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
  ];
  let planRaw;
  try {
    planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
  } catch (err) {
    logger.error(`[agentbrowser.agent] plan LLM error: ${err.message}`);
    return { ok: false, goal, sessionId, turns: 0, done: false, result: `LLM unavailable: ${err.message}`, transcript: [], error: err.message, executionTime: Date.now() - start };
  }

  let planParsed = parseJson(planRaw);
  if (!planParsed || !Array.isArray(planParsed.plan)) {
    logger.warn(`[agentbrowser.agent] plan response unparseable on first attempt — retrying: ${planRaw?.slice(0, 200)}`);
    try {
      planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
      planParsed = parseJson(planRaw);
    } catch (retryErr) {
      logger.error(`[agentbrowser.agent] plan retry LLM error: ${retryErr.message}`);
    }
  }
  if (!planParsed || !Array.isArray(planParsed.plan)) {
    logger.error(`[agentbrowser.agent] plan response unparseable after retry: ${planRaw?.slice(0, 200)}`);
    return { ok: false, goal, sessionId, turns: 0, done: false, result: 'LLM did not return a valid plan', transcript: [], error: 'invalid plan', executionTime: Date.now() - start };
  }

  let plan = planParsed.plan;
  logger.info(`[agentbrowser.agent] plan generated: ${plan.length} steps — ${planParsed.thoughts}`);

  if (plan.length === 0) {
    return { ok: false, goal, sessionId, turns: 0, done: false, result: planParsed.thoughts || 'LLM returned empty plan', transcript: [], error: planParsed.thoughts, executionTime: Date.now() - start };
  }

  // ── Phase 3: Execute plan ──────────────────────────────────────────────────
  logger.info(`[agentbrowser.agent] phase 3: executing ${plan.length} steps`);
  let stepIndex        = 0;
  let totalRepairs     = 0;
  let lastEvalResult   = null;
  let lastGetPageTextResult = null;

  // Actions that can mutate the DOM structure — auto-resnapshot after these succeed.
  // Replan threshold is 15% (not 30%) — agent-browser snapshots are compact
  // (20-150 refs typically) so a smaller absolute change is still semantically significant.
  const DOM_MUTATING_ACTIONS = new Set([
    'click', 'dblclick',
    'navigate', 'goto',
    'press',
    'select',
    'drag',
    'check', 'uncheck',
    'scroll',
    'keyboard-type',
  ]);
  const REPLAN_FRACTION_THRESHOLD = 0.15;

  while (stepIndex < plan.length) {
    const step = normalizeStep(plan[stepIndex]);

    // Inline return step
    if (step.action === 'return') {
      let data = String(step.data || '').trim();
      if (!data || /^[<{][^>}]+[>}]$/.test(data)) {
        data = lastEvalResult || lastGetPageTextResult || data;
      }
      data = data.slice(0, 2000);
      logger.info(`[agentbrowser.agent] step ${stepIndex + 1}/${plan.length}: return (${data.length} chars)`);
      transcript.push({ step: stepIndex + 1, action: step, outcome: { ok: true, result: data }, thoughts: '' });
      postProgress(_progressCallbackUrl, {
        type: 'agent:turn', stepIndex: _stepIndex,
        turn: stepIndex + 1, maxTurns: plan.length,
        action: step, outcome: { ok: true, result: data }, thoughts: '',
      });
      finalResult = data;
      break;
    }

    // Inline snapshot step — refresh snapshot AND re-plan remaining steps with fresh refs
    if (step.action === 'snapshot') {
      logger.info(`[agentbrowser.agent] step ${stepIndex + 1}/${plan.length}: snapshot + re-plan`);
      const snap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
      if (snap.ok && snap.result) currentSnapshot = snap.result;

      const remainingAfterSnap = plan.slice(stepIndex + 1);
      if (remainingAfterSnap.length > 0) {
        logger.info(`[agentbrowser.agent] snapshot step: re-planning ${remainingAfterSnap.length} step(s) with fresh refs`);
        try {
          const snapReplanRaw = await askWithMessages([
            { role: 'system', content: AB_REPLAN_SYSTEM_PROMPT + domainLockBlock },
            { role: 'user', content: [
              url ? `SERVICE URL: ${url}` : '',
              `GOAL: ${goal}`,
              `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
              `STALE_REMAINING_PLAN: ${JSON.stringify(remainingAfterSnap)}`,
              ``,
              `FRESH_SNAPSHOT (interactive elements, full ${countRefsAB(currentSnapshot)}-ref compact text):`,
              trimSnapshotAB(currentSnapshot, 32000),
              learnedRulesBlock,
            ].filter(Boolean).join('\n') },
          ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
          const snapReplanParsed = parseJson(snapReplanRaw);
          if (snapReplanParsed && Array.isArray(snapReplanParsed.plan) && snapReplanParsed.plan.length > 0) {
            logger.info(`[agentbrowser.agent] snapshot re-plan: ${snapReplanParsed.plan.length} fresh steps — ${snapReplanParsed.thoughts || ''}`);
            plan = [...plan.slice(0, stepIndex + 1), ...snapReplanParsed.plan];
          } else {
            logger.warn(`[agentbrowser.agent] snapshot re-plan unparseable — continuing with stale plan`);
          }
        } catch (snapReplanErr) {
          logger.warn(`[agentbrowser.agent] snapshot re-plan LLM error: ${snapReplanErr.message} — continuing`);
        }
      }

      transcript.push({ step: stepIndex + 1, action: step, outcome: { ok: true }, thoughts: 'snapshot + re-plan' });
      postProgress(_progressCallbackUrl, {
        type: 'agent:turn', stepIndex: _stepIndex,
        turn: stepIndex + 1, maxTurns: plan.length,
        action: step, outcome: { ok: true, result: 'page re-read + steps re-planned' }, thoughts: 'snapshot + re-plan',
      });
      stepIndex++;
      continue;
    }

    const isDomMutating = DOM_MUTATING_ACTIONS.has(step.action);
    const preRefCount   = isDomMutating ? countRefsAB(currentSnapshot) : 0;

    postProgress(_progressCallbackUrl, {
      type: 'agent:turn_live', stepIndex: _stepIndex,
      turn: stepIndex + 1, maxTurns: plan.length, action: step,
    });

    logger.info(`[agentbrowser.agent] step ${stepIndex + 1}/${plan.length}: ${JSON.stringify(step)}`);
    let outcome;
    try {
      outcome = await _act({ ...step, sessionId, headed, timeoutMs });
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    logger.info(`[agentbrowser.agent] step ${stepIndex + 1} ok=${outcome.ok}${outcome.error ? ' err=' + outcome.error : ''}`);
    const thoughts = outcome.ok ? '' : (outcome.error || 'failed');
    transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts });

    postProgress(_progressCallbackUrl, {
      type: 'agent:turn', stepIndex: _stepIndex,
      turn: stepIndex + 1, maxTurns: plan.length,
      action: step, outcome: { ok: outcome.ok, result: outcome.result, error: outcome.error }, thoughts,
    });

    if (outcome.ok) {
      if ((step.action === 'eval' || step.action === 'evaluate') && outcome.result) {
        lastEvalResult = outcome.result;
      }
      if (step.action === 'getPageText' && outcome.result) {
        lastGetPageTextResult = outcome.result;

        // HTTP error page detection
        const _httpErr = _detectHttpErrorPage(outcome.result);
        if (_httpErr && totalRepairs < maxRepairs && url) {
          totalRepairs++;
          logger.warn(`[agentbrowser.agent] HTTP ${_httpErr} error page detected in getPageText — full retry ${totalRepairs}/${maxRepairs}`);
          try {
            await _act({ action: 'navigate', url, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) });
            await _act({ action: 'waitForStableText', sessionId, headed, timeoutMs: 15000 }).catch(() => {});
            const retrySnap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
            if (retrySnap.ok && retrySnap.result) currentSnapshot = retrySnap.result;
            const retryPlanRaw = await askWithMessages([
              { role: 'system', content: AB_PLAN_SYSTEM_PROMPT + learnedRulesBlock },
              { role: 'user', content: `GOAL: ${goal}\n\nNOTE: A previous attempt failed because the page returned an HTTP ${_httpErr} error. The page has been refreshed — please re-plan the full task from the current snapshot.\n\nSNAPSHOT:\n${trimSnapshotAB(currentSnapshot, 32000)}${agentContext ? `\n\nAGENT CONTEXT:\n${agentContext}` : ''}` },
            ], { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
            const retryPlanParsed = parseJson(retryPlanRaw);
            if (retryPlanParsed && Array.isArray(retryPlanParsed.plan) && retryPlanParsed.plan.length > 0) {
              logger.info(`[agentbrowser.agent] HTTP error retry: re-planned ${retryPlanParsed.plan.length} step(s)`);
              plan = retryPlanParsed.plan;
              stepIndex = 0;
              lastGetPageTextResult = null;
              continue;
            }
          } catch (retryErr) {
            logger.warn(`[agentbrowser.agent] HTTP error retry re-plan failed: ${retryErr.message}`);
          }
        }
      }

      // ── Post-fill body verification (self-healing + rule learning) ─────────
      // For long text fills — verify text actually landed. keyboard-type is the
      // correct approach for contenteditable; if fill silently fails, repair
      // loop learns to use keyboard-type instead.
      if (step.action === 'fill' && typeof step.text === 'string' && step.text.length > 80) {
        try {
          const needle = step.text.slice(0, 40);
          const verifyRes = await _act({
            action:    'eval',
            code:      `(function(){var n=${JSON.stringify(needle)};return [...document.querySelectorAll('[contenteditable="true"],textarea')].some(function(el){return (el.innerText||el.value||'').includes(n);})?'ok':'empty';})()`,
            sessionId, headed, timeoutMs,
          });
          if (verifyRes.ok && (verifyRes.result || '').trim() === 'empty') {
            logger.warn(`[agentbrowser.agent] post-fill body verification: text not found in contenteditable/textarea — triggering repair to learn keyboard-type`);
            outcome = {
              ok: false,
              error: 'fill succeeded but body text not found in page — element is likely a contenteditable div; use keyboard-type (click to focus, then keyboard-type) instead of fill',
            };
          }
        } catch (_) { /* non-fatal */ }
      }

      // ── Auto re-snapshot after DOM-mutating actions ────────────────────────
      // Replan threshold: 15% (smaller than playwright.agent's 30%) because
      // agent-browser snapshots have fewer absolute refs, so proportional changes
      // are more meaningful.
      if (isDomMutating && outcome.ok) {
        const postSnap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
        if (postSnap.ok && postSnap.result) {
          currentSnapshot = postSnap.result;
          const postRefCount   = countRefsAB(currentSnapshot);
          const maxRefs        = Math.max(preRefCount, postRefCount, 1);
          const changeFraction = Math.abs(postRefCount - preRefCount) / maxRefs;
          const absoluteDelta  = postRefCount - preRefCount;
          logger.info(`[agentbrowser.agent] auto-resnapshot after ${step.action}: refs ${preRefCount}→${postRefCount} (${(changeFraction * 100).toFixed(0)}% change, Δ${absoluteDelta})`);

          const remaining = plan.slice(stepIndex + 1);
          const isNavStep = step.action === 'navigate' || step.action === 'goto';
          const significantChange = isNavStep
            ? (preRefCount > 0 || postRefCount > 0) && (changeFraction > 0 || absoluteDelta !== 0)
            : (changeFraction >= REPLAN_FRACTION_THRESHOLD || absoluteDelta >= 10) && (preRefCount > 0 || postRefCount > 0);

          if (significantChange && remaining.length > 0) {
            if (postRefCount < 10) {
              logger.info(`[agentbrowser.agent] post-nav snapshot too small (${postRefCount} refs) — waiting for page to stabilise`);
              await _act({ action: 'waitForStableText', sessionId, headed, timeoutMs: 12000 }).catch(() => {});
              const reSnap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
              if (reSnap.ok && reSnap.result) {
                currentSnapshot = reSnap.result;
                logger.info(`[agentbrowser.agent] re-snapshotted after stabilise: ${countRefsAB(currentSnapshot)} refs`);
              }
            }
            logger.info(`[agentbrowser.agent] structural DOM change — re-planning ${remaining.length} remaining step(s)`);
            try {
              const replanRaw = await askWithMessages([
                { role: 'system', content: AB_REPLAN_SYSTEM_PROMPT + domainLockBlock },
                { role: 'user', content: [
                  url ? `SERVICE URL: ${url}` : '',
                  `GOAL: ${goal}`,
                  `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
                  `STALE_REMAINING_PLAN: ${JSON.stringify(remaining)}`,
                  ``,
                  `FRESH_SNAPSHOT (interactive elements, full ${countRefsAB(currentSnapshot)}-ref compact text):`,
                  trimSnapshotAB(currentSnapshot, 32000),
                  learnedRulesBlock,
                ].filter(Boolean).join('\n') },
              ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
              const replanParsed = parseJson(replanRaw);
              if (replanParsed && Array.isArray(replanParsed.plan) && replanParsed.plan.length > 0) {
                logger.info(`[agentbrowser.agent] re-plan: ${replanParsed.plan.length} fresh steps — ${replanParsed.thoughts || ''}`);
                plan = [...plan.slice(0, stepIndex + 1), ...replanParsed.plan];
              } else {
                logger.warn(`[agentbrowser.agent] re-plan response unparseable or empty — continuing with stale plan`);
              }
            } catch (replanErr) {
              logger.warn(`[agentbrowser.agent] re-plan LLM error: ${replanErr.message} — continuing`);
            }
          }
        }
      }

      if (outcome.ok) {
        stepIndex++;
        continue;
      }
    }

    // ── Step failed → repair ─────────────────────────────────────────────────
    if (totalRepairs >= maxRepairs) {
      logger.warn(`[agentbrowser.agent] step ${stepIndex + 1} failed — repair limit (${maxRepairs}) reached`);
      return {
        ok: false, goal, sessionId,
        turns: transcript.length, done: false,
        result: `Step ${stepIndex + 1} (${step.action}) failed: ${outcome.error}`,
        transcript, error: outcome.error, executionTime: Date.now() - start,
      };
    }

    totalRepairs++;
    logger.info(`[agentbrowser.agent] step ${stepIndex + 1} failed — repair ${totalRepairs}/${maxRepairs}: ${outcome.error}`);

    const repairSnap = await _act({ action: 'snapshot', sessionId, headed, timeoutMs });
    if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;

    const remainingSteps = plan.slice(stepIndex + 1);
    let repairRaw;
    try {
      repairRaw = await askWithMessages([
        { role: 'system', content: AB_REPAIR_SYSTEM_PROMPT + domainLockBlock },
        { role: 'user', content: [
          url ? `SERVICE URL: ${url}` : '',
          `GOAL: ${goal}`,
          `FAILED_STEP: ${JSON.stringify(step)}`,
          `ERROR: ${outcome.error}`,
          `REMAINING_PLAN: ${JSON.stringify(remainingSteps)}`,
          ``,
          `SNAPSHOT:`,
          trimSnapshotAB(currentSnapshot, 32000),
        ].filter(Boolean).join('\n') },
      ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
    } catch (err) {
      return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Repair LLM unavailable: ${err.message}`, transcript, error: err.message, executionTime: Date.now() - start };
    }

    const repairParsed = parseJson(repairRaw);
    if (!repairParsed || !Array.isArray(repairParsed.repair)) {
      logger.warn(`[agentbrowser.agent] repair response unparseable — aborting`);
      return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Step ${stepIndex + 1} failed and repair was unparseable`, transcript, error: outcome.error, executionTime: Date.now() - start };
    }

    logger.info(`[agentbrowser.agent] repair: ${repairParsed.repair.length} corrective steps — ${repairParsed.thoughts}`);

    // Fire-and-forget: derive a ≤150-char rule from this failure+repair and store it
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
            logger.info(`[agentbrowser.agent] learned rule saved for ${agentId}: "${ruleText}"`);
          }
        } catch (_) { /* non-fatal */ }
      })();
    }

    if (repairParsed.skip_original) {
      stepIndex++;
    } else {
      plan = [
        ...plan.slice(0, stepIndex),
        ...repairParsed.repair,
        ...plan.slice(stepIndex + 1),
      ];
    }
  }

  // Implicit result from last eval or getPageText
  if (finalResult === null && lastEvalResult !== null) {
    finalResult = lastEvalResult;
  }
  if (finalResult === null && lastGetPageTextResult !== null) {
    finalResult = lastGetPageTextResult;
  }

  logger.info(`[agentbrowser.agent] DONE — ${transcript.length} steps executed (${totalRepairs} repairs)`);
  postProgress(_progressCallbackUrl, {
    type: 'agent:complete',
    stepIndex: _stepIndex,
    agentId: 'agentbrowser.agent',
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
  } finally {
    _activeSessions.delete(sessionId);
  }
}

// ---------------------------------------------------------------------------
// agentbrowserAgentSkill — action-based dispatcher (mirrors browser.agent API)
// ---------------------------------------------------------------------------
// Routes action: to the correct engine:
//   build_agent / list_agents / validate_agent — DuckDB registry (browser.agent.cjs, no browser)
//   run                                        — query registry → agentbrowserAgent
//   explore                                    — agentbrowserAgent with goal+url, no descriptor
//   (default)                                  — agentbrowserAgent passthrough (backward compat)
//
// Lazily requires browser.agent.cjs to avoid circular dependency at module init.
// ---------------------------------------------------------------------------

function _extractDescriptorField(descriptor, field) {
  if (!descriptor) return null;
  const m = descriptor.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

async function agentbrowserAgentSkill(args) {
  const {
    action = 'run', agentId, task, service, goal, url, sessionId, headed, ...rest
  } = args;

  // DuckDB registry operations — no browser needed; delegate to browser.agent
  if (action === 'build_agent' || action === 'list_agents' || action === 'validate_agent') {
    const { browserAgent } = require('./browser.agent.cjs');
    return await browserAgent(args);
  }

  if (action === 'explore') {
    return await agentbrowserAgent({
      goal: goal || task || 'Explore this page',
      url,
      sessionId: sessionId || 'agentbrowser_explore',
      headed: headed !== false,
      ...rest,
    });
  }

  if (action === 'run') {
    if (!agentId) {
      return { ok: false, error: 'agentbrowserAgentSkill action:run requires agentId' };
    }
    const { browserAgent } = require('./browser.agent.cjs');
    const queryResult = await browserAgent({ action: 'query_agent', id: agentId });
    if (!queryResult.ok || !queryResult.found) {
      return {
        ok: false,
        error: `agentbrowserAgentSkill: agent "${agentId}" not found in registry. Build it first with action:build_agent.`,
        queryResult,
      };
    }
    const { descriptor, service: agentService } = queryResult;
    const startUrl  = _extractDescriptorField(descriptor, 'start_url');
    const signInUrl = _extractDescriptorField(descriptor, 'sign_in_url');
    return await agentbrowserAgent({
      goal: task || goal || `Complete the requested task on ${agentService}`,
      sessionId: sessionId || agentId,
      agentId,
      agentContext: descriptor,
      url: startUrl || url,
      authSignInUrl: signInUrl,
      headed: headed !== false,
      ...rest,
    });
  }

  // Default: pass through to agentbrowserAgent (backward compat)
  return await agentbrowserAgent(args);
}

module.exports = { agentbrowserAgent, agentbrowserAgentSkill };
