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
// Shared action schema constants — injected into multiple prompts so all LLMs
// use identical field names (selector not ref, etc.)
// ---------------------------------------------------------------------------

// Full action menu — used by PLAN_SYSTEM_PROMPT only.
const BROWSER_ACTIONS_FULL = `Available actions:
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
  find-role       { role, name?, findAction, value? } — find by ARIA role (e.g. "textbox") + optional name; findAction is "click"|"fill"
  find-label      { label, findAction, value? }       — find by label text; findAction is "click"|"fill"
  find-text       { text }                            — click the first visible element containing this text
  wait            { ms }                              — pause execution for up to 5000ms (use sparingly)
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
  dialog-dismiss  {}`;

// Interactive-only action menu — used by ORIENTATION_SYSTEM_PROMPT.
// Excludes data-extraction actions (run-code, getPageText, evaluate, screenshot,
// snapshot, return, waitForSelector, waitForContent) that are never needed to clear
// an interstitial, and would confuse the orientation LLM into generating data steps.
const BROWSER_ACTIONS_INTERACT = `Available actions (interstitial-clearing only):
  navigate        { url }              — LAST RESORT only; STAY ON SERVICE domain
  click           { selector }         — use snapshot ref (e12); MUST use "selector", NEVER "ref"
  dblclick        { selector }
  fill            { selector, text }   — for <input> / <textarea> fields
  type            { text }             — types into currently focused element
  press           { key }              — "Escape", "Enter", "Tab"
  select          { selector, value }  — dropdown option (e.g. onboarding "How will you use this?")
  check           { selector }         — tick a checkbox (e.g. terms agreement)
  uncheck         { selector }
  hover           { selector }
  scroll          { direction, distance }
  drag            { selector, targetSelector }
  dialog-accept   { prompt? }
  dialog-dismiss  {}`;

// Step format rules — shared by PLAN and ORIENTATION so both LLMs use correct field names.
const STEP_FORMAT_CRITICAL = `CRITICAL: each step MUST use this exact format: { "action": "<name>", ...args }
CORRECT:  { "action": "navigate", "url": "https://mail.google.com/mail/u/0/#inbox" }
CORRECT:  { "action": "click", "selector": "e24" }  — MUST use "selector", NEVER "ref" or "element"
CORRECT:  { "action": "fill", "selector": "e12", "text": "user@example.com" }
CORRECT:  { "action": "press", "key": "Escape" }
WRONG:    { "navigate": { "url": "..." } }
WRONG:    { "click": "Compose" }
WRONG:    { "action": "click", "ref": "e24" }        — "ref" is NOT a valid field`;

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

⚠ FORBIDDEN inside page.evaluate() — Playwright pseudo-selectors CRASH native browser querySelector:
  NEVER use: :has-text("...")  :text("...")  :contains("...")  :visible  :enabled  :checked
  NEVER use: generic:has(button:contains(...))  — :contains() is NOT valid CSS
  NEVER use: 'generic', 'heading', 'paragraph', 'link' as CSS tag names — these are ARIA roles in the snapshot,
             NOT real HTML tags. document.querySelectorAll('generic') returns NOTHING.
  SAFE selectors inside page.evaluate(): 'article', 'h1','h2','h3', 'a[href]', '[role="article"]',
             '[data-testid="..."]', '.className', 'div > span', '[href*="comments"]'
  When snapshot shows ARIA roles (generic/heading/link), use innerHTML/textContent on real tags like h3, a, p.

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

${BROWSER_ACTIONS_FULL}

${STEP_FORMAT_CRITICAL}

Rules:
- PAGE ORIENTATION RULE: Before writing any task steps, assess the snapshot — ask "Is this page where I can accomplish the goal?" If blocked by an interstitial (onboarding, cookie wall, paywall, 404, setup screen, or anything that prevents completing the task), FIRST ask: "Is there a clickable element in this snapshot that moves me TOWARD the goal?" — e.g. 'Continue', 'Skip', 'Get started', 'Go to my workspace', 'Accept', 'Dismiss', 'Enter workspace'. If YES, your FIRST step MUST be a click on that element, immediately followed by { "action": "snapshot" }. Only use navigate as a last resort when no bypass element exists in the snapshot. STAY ON SERVICE: any navigate MUST stay within the same service domain — never navigate to Google or external sites.
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
// Phase 1.2 prompt — orientation loop.
// Called BEFORE plan generation when an interstitial is detected.
// Asks: is there ONE action that moves toward the goal? Or is the page clear?
// ---------------------------------------------------------------------------
const ORIENTATION_SYSTEM_PROMPT = `You are a browser automation assistant. The current page may be blocking a task.
Your job: decide ONE thing — is there a SINGLE action you can take RIGHT NOW on this page that moves toward the goal?

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

If the page IS the right starting point (workspace, inbox, chat interface, dashboard, etc.):
{ "oriented": true }

If there IS an action that moves toward the goal:
{ "oriented": false, "step": { "action": "<action>", ...args } }

${BROWSER_ACTIONS_INTERACT}

${STEP_FORMAT_CRITICAL}

DECISION RULES — apply in this priority order:
1. PREFER CLICK: If there is a visible button or link like "Continue", "Skip", "Get started", "Go to my workspace", "Accept", "Dismiss", "Maybe later", "Enter workspace", "Open workspace", or any element that leads INTO the main app — click it using its snapshot ref (e.g. "e24").
2. PRESS Escape: If a modal/dialog blocks the page and there is no obvious dismiss button, try { "action": "press", "key": "Escape" }.
3. NAVIGATE (absolute last resort): If no clickable path exists anywhere in the snapshot, navigate to the service's direct workspace URL. STAY ON SERVICE — never navigate to Google or any external site.
4. If the page IS already the right starting point — return { "oriented": true } immediately. Do not invent unnecessary steps.

GOAL ALIGNMENT: The action must move TOWARD the goal. Ask: "After this action, will I be on a page where I can accomplish the goal?"`;

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
  from the task description instead.
- If the error contains "Timeout" and the failed step was navigate or click, a browser dialog (e.g. "Leave site?", "Leave page?") may be blocking. In that case start the repair with { "action": "dialog-accept" } before retrying the original step.`;

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
- AI CHAT EXTRACTION RULE: If ANY stale remaining step was waitForStableText or getPageText, you MUST preserve BOTH in the re-plan — in order: first { "action": "waitForStableText" }, then { "action": "getPageText" }. NEVER collapse them into a single getText or omit waitForStableText. The AI response is still streaming when the DOM changes; skipping waitForStableText captures an incomplete response.

${STEP_FORMAT_CRITICAL}`;

// ---------------------------------------------------------------------------
// Post-task completion verification prompt — called once after all steps finish.
// Asks the LLM whether the goal was actually achieved based on the final page state.
// Catches silent completion failures: keyboard shortcuts that fired to the wrong focus,
// form submits that didn't register, modal dismissals that didn't close, etc.
// ---------------------------------------------------------------------------
const VERIFY_SYSTEM_PROMPT = `You are verifying whether a browser automation task was truly completed.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):
{
  "completed": true | false,
  "confidence": 0.0 to 1.0,
  "evidence": "<one sentence: what you see on the page that supports your verdict>"
}

Signs the task is INCOMPLETE:
- A compose / draft window is still visible and contains the message that was supposed to be sent
- A form is still present and filled with data that was supposed to be submitted
- A modal, dialog, or overlay is still open when it should have been dismissed
- An item that was supposed to be deleted is still in the list
- The URL is unchanged when a navigation was the last action
- A progress indicator, toast, or error message indicates failure

Signs the task is COMPLETE:
- Page transitioned to a sent / confirmation / success view
- The targeted element (compose window, modal, form) is no longer visible
- A success toast, banner, or message is visible
- The URL changed to confirm navigation succeeded
- Content that was supposed to appear is now present

Be conservative: if you see clear evidence of incompletion, prefer completed:false.
Only mark completed:false when confidence >= 0.75 — minor UI ambiguities are not failures.`;

// Regex to detect login-wall evidence in VERIFY output.
// When the LLM reports the page is a login/signup wall, skip inline repair and
// return loginWallDetected:true so browser.agent's waitForAuth + auto-retry fires.
const VERIFY_LOGIN_WALL_RE = /sign[\s-]*(in|up|into)|log[\s-]*(in|into)|not[\s-]*(logged|authenticated)|login[\s-]*(required|wall|page)|continue[\s-]*with[\s-]*(google|apple|microsoft|github|facebook|email)|email[\s-]*(entry|input|field|address|address\s*required)|create[\s-]*account|authentication[\s-]*required|please[\s-]+log[\s-]*(in|into)|welcome[\s-]*back|enter[\s-]*(your[\s-]*)?email|your[\s-]*email[\s-]*address|[@][^\s]+[\s-]*required/i;

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
// Detect HTTP error pages in getPageText output.
// Three-factor detection — all three must pass to avoid false positives:
//   1. Contains an HTTP 5xx/429 status code number in the page text
//   2. Contains error-page phrasing ("That's an error", "Bad Gateway", etc.)
//   3. Does NOT contain AI service UI chrome ("New chat", "Enter a prompt", etc.)
//      — a page with AI chrome cannot be a bare error page regardless of length
// NOTE: No length guard — short factual AI answers are valid content. Detection
// relies on the combination of all three signals, not response size.
// ---------------------------------------------------------------------------
function _detectHttpErrorPage(text) {
  if (!text) return null;
  const t = text.slice(0, 4000);
  // Signal 1: must contain an HTTP error status code number
  const statusMatch = t.match(/\b(500|502|503|504|429)\b/);
  if (!statusMatch) return null;
  // Signal 2: must contain error-page phrasing
  const hasErrorPhrases = /that'?s an error|server error|temporarily unavailable|bad gateway|service unavailable|too many requests|please try again(?: later)?|error occurred|couldn'?t process|unexpected error/i.test(t);
  if (!hasErrorPhrases) return null;
  // Signal 3: must NOT look like a real AI chat/response page — these phrases
  // appear in ChatGPT/Gemini/Claude page chrome and are mutually exclusive with error pages
  const looksLikeAIPage = /new chat|start a new conversation|ask me anything|enter a prompt|how can i help|what can i help|ask gemini|message chatgpt/i.test(t);
  if (looksLikeAIPage) return null;
  return statusMatch[1];
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
// Detect whether a snapshot looks like an interstitial blocking the task.
// High-precision / low-recall — false negatives fall through to the PAGE
// ORIENTATION RULE in the plan prompt. False positives waste one LLM call
// but never break the agent. Zero LLM calls — pure regex.
// ---------------------------------------------------------------------------
function looksLikeInterstitial(snapshotText) {
  if (!snapshotText) return false;
  const t = snapshotText.slice(0, 6000).toLowerCase();
  return (
    // Onboarding / setup wizards
    /how (do |will )?(you|we) (want to |plan to )?use|how are you planning to use/.test(t) ||
    /set up your (workspace|account|profile)|complete your (setup|profile|onboarding)/.test(t) ||
    /welcome to (your )?(notion|workspace|app)|let's get (you )?started|get started with/.test(t) ||
    /create your first (page|project|task|workspace)|tell us about yourself/.test(t) ||
    /personali(z|s)e your (experience|workspace)|choose a (template|plan|workspace)/.test(t) ||
    // Cookie / consent walls
    /\b(accept|agree to) (all )?(cookies|terms|privacy)|cookie (consent|policy|notice|banner)/.test(t) ||
    /we use cookies|by (continuing|using this site) you agree/.test(t) ||
    // Paywall / upsell overlays
    /upgrade (your plan|to pro|to (a )?paid)|start (your )?free trial|choose a plan/.test(t) ||
    // Generic blocking overlays
    /sign in to continue|log in to (view|access|continue)|you (must|need to) (be logged in|sign in)/.test(t) ||
    // Notion workspace join / onboarding flow
    /\bjoin (workspace|space|team)\b|you('ve| have) been invited to join|join [a-z].{0,40}'?s (workspace|space)/.test(t) ||
    /\bonboarding\b.*\b(skip|continue|join|get started)\b/.test(t) ||
    // Login / sign-up gates blocking content access (Reddit, news sites, social media, etc.)
    // Matches patterns where auth is required to view the requested content.
    /sign.?in to (view|see|access|read|continue|comment|vote|post|download)/i.test(t) ||
    /log.?in to (view|see|access|read|continue|comment|vote|post|download)/i.test(t) ||
    /you('ll)? need to (sign.?in|log.?in|create an account)|must be (signed in|logged in) to/i.test(t) ||
    /join.{0,30}to (access|view|read|see|comment|vote|post)/i.test(t) ||
    /create (a |an )?(free )?account to (access|view|read|comment|post)/i.test(t)
  );
}

// ---------------------------------------------------------------------------
// Orientation loop — runs up to MAX_ORIENT_STEPS iterations BEFORE plan
// generation, clicking past interstitials one step at a time.
// Returns the updated snapshot (cleared page) or the original (if no change).
// Fully non-fatal: any LLM/browser error causes graceful fall-through.
// ---------------------------------------------------------------------------
const MAX_ORIENT_STEPS = 3;

async function orientPage({ goal, snapshot, sessionId, headed, timeoutMs, learnedRulesBlock, domainLockBlock = '' }) {
  let currentSnapshot = snapshot;
  for (let i = 0; i < MAX_ORIENT_STEPS; i++) {
    let orientRaw;
    try {
      orientRaw = await askWithMessages([
        { role: 'system', content: ORIENTATION_SYSTEM_PROMPT + domainLockBlock },
        { role: 'user', content: `GOAL: ${goal}\n\nSNAPSHOT:\n${trimSnapshot(currentSnapshot, 8000)}${learnedRulesBlock || ''}` },
      ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });
    } catch (err) {
      logger.warn(`[playwright.agent] orientation LLM error (step ${i + 1}/${MAX_ORIENT_STEPS}): ${err.message} — skipping`);
      break;
    }

    const parsed = parseJson(orientRaw);
    if (!parsed) {
      logger.warn(`[playwright.agent] orientation response unparseable (step ${i + 1}/${MAX_ORIENT_STEPS}) — skipping`);
      break;
    }

    if (parsed.oriented === true) {
      logger.info(`[playwright.agent] orientation: page is already the right starting point (after ${i} step(s))`);
      break;
    }

    if (!parsed.step || typeof parsed.step.action !== 'string') {
      logger.warn(`[playwright.agent] orientation: no valid step returned (step ${i + 1}/${MAX_ORIENT_STEPS}) — skipping`);
      break;
    }

    const orientStep = parsed.step;
    logger.info(`[playwright.agent] orientation step ${i + 1}/${MAX_ORIENT_STEPS}: ${JSON.stringify(orientStep)}`);

    let outcome;
    try {
      outcome = await browserAct({ ...orientStep, sessionId, headed, timeoutMs });
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }

    if (!outcome.ok) {
      logger.warn(`[playwright.agent] orientation step ${i + 1} failed: ${outcome.error} — stopping orientation`);
      break;
    }

    // Wait for navigation/animation to settle, then re-snapshot
    await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 8000) }).catch(() => {});
    const reSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
    if (reSnap.ok && reSnap.result) {
      currentSnapshot = reSnap.result;
      logger.info(`[playwright.agent] orientation: re-snapshotted after step ${i + 1} (${countRefs(currentSnapshot)} refs)`);
    }

    // If interstitial cleared, we're done
    if (!looksLikeInterstitial(currentSnapshot)) {
      logger.info(`[playwright.agent] orientation: interstitial cleared after ${i + 1} step(s) ✓`);
      break;
    }
  }
  return currentSnapshot;
}

// ---------------------------------------------------------------------------
// Normalize LLM step output — handles verb-as-key format the LLM sometimes returns:
//   { "navigate": { "url": "..." } }  →  { "action": "navigate", "url": "..." }
//   { "click": "Compose" }            →  { "action": "click", "selector": "Compose" }
// ---------------------------------------------------------------------------
function normalizeStep(step) {
  if (!step || typeof step !== 'object') return step;
  // Defensive alias: some LLM outputs (especially from REPLAN) use "ref" instead of
  // "selector". browser.act's click/fill handlers read args.selector — if only ref is
  // present the handler gets undefined and throws "Cannot read properties of undefined
  // (reading 'trim')". Alias here as defense-in-depth alongside STEP_FORMAT_CRITICAL.
  if (typeof step.action === 'string' && step.ref && !step.selector) {
    step = { ...step, selector: step.ref };
  }
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

  // ── Phase 1: Wait for SPA to stabilise, then snapshot ────────────────────
  // Many SPAs (Gemini, ChatGPT, etc.) render a skeleton immediately after navigate,
  // then populate the interactive DOM 500-2000ms later. Snapshotting too early
  // captures a mostly-empty tree (e.g. 12 refs instead of 62), causing the LLM to
  // pick wrong elements and triggering a costly navigate→re-snapshot cascade.
  if (url) {
    logger.info(`[playwright.agent] phase 1: waiting for page to stabilise before snapshot`);
    await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
  }
  logger.info(`[playwright.agent] phase 1: snapshot`);
  const initSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
  let currentSnapshot = (initSnap.ok && initSnap.result) ? initSnap.result : '';

  // Compute hostname once — used for domain-lock block injected into all LLM calls
  const hostname = url ? (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return null; } })() : null;
  const domainLockBlock = hostname
    ? `\n\nDOMAIN LOCK — ABSOLUTE:\nYou are automating '${hostname}'. NEVER navigate to any external site (not Google, Bing, DuckDuckGo, or anywhere outside ${hostname}). Any navigate step MUST stay on '${hostname}'.`
    : '';

  // ── Phase 1.2: Orientation loop — clear interstitials before plan generation ─
  // Fires ONLY when the snapshot matches a known interstitial pattern (zero LLM
  // calls on normal pages). Clicks past onboarding, cookie walls, setup wizards,
  // etc. so Phase 2 plan generation always sees a clean starting page.
  if (looksLikeInterstitial(currentSnapshot)) {
    logger.info(`[playwright.agent] phase 1.2: interstitial detected — running orientation loop (up to ${MAX_ORIENT_STEPS} steps)`);
    currentSnapshot = await orientPage({ goal, snapshot: currentSnapshot, sessionId, headed, timeoutMs, learnedRulesBlock: '', domainLockBlock });

    // Post-orientation check: if a login/signup gate is STILL blocking after the
    // orientation loop ran, bail immediately with loginWallDetected rather than
    // generating a plan against a gated page (it always fails or gets degraded
    // content). recoverSkill's auth fast-path surfaces this as ASK_USER.
    const _loginGateRe = /sign.?in to (view|see|access|read|continue|comment|vote|post)|log.?in to (view|see|access|read|continue|comment|vote|post)|you('ll)? need to (sign.?in|log.?in|create an account)|must be (signed in|logged in) to|join.{0,30}to (access|view|read|see|comment|vote)/i;
    if (looksLikeInterstitial(currentSnapshot) && _loginGateRe.test(currentSnapshot.slice(0, 6000))) {
      logger.warn(`[playwright.agent] login-gate still blocking after orientation — returning loginWallDetected immediately`);
      return {
        ok: false, goal, sessionId,
        turns: 0, done: false,
        loginWallDetected: true,
        result: 'This site requires authentication to access the requested content',
        transcript: [],
        executionTime: Date.now() - start,
      };
    }
  }

  // ── Phase 1.5: Load learned rules for this agent/hostname ──────────────────
  let learnedRulesBlock = '';
  try {
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
    { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
    { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${extractInteractiveRefs(currentSnapshot)}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
  ];
  // Dynamic token cap: short focused tasks (< 400 chars) seldom produce > 3 steps
  // so 800 tokens avoids wasting 1-2s on padding. Complex multi-site goals get 2048.
  const _planMaxTokens = goal.length < 400 ? 800 : 2048;
  let planRaw;
  try {
    planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: _planMaxTokens, responseTimeoutMs: 30000 });
  } catch (err) {
    logger.error(`[playwright.agent] plan LLM error: ${err.message}`);
    return { ok: false, goal, sessionId, turns: 0, done: false, result: `LLM unavailable: ${err.message}`, transcript: [], error: err.message, executionTime: Date.now() - start };
  }

  let planParsed = parseJson(planRaw);
  if (!planParsed || !Array.isArray(planParsed.plan)) {
    // Retry once — the first response may have been truncated mid-JSON
    logger.warn(`[playwright.agent] plan response unparseable on first attempt — retrying: ${planRaw?.slice(0, 200)}`);
    try {
      planRaw = await askWithMessages(planMessages, { temperature: 0.1, maxTokens: _planMaxTokens, responseTimeoutMs: 30000 });
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
      // ── Semantic fallback actions — translate to Playwright locator API ──────
      if (step.action === 'find-role') {
        const { role, name, findAction = 'click', value, text } = step;
        const nameArg = name ? `, { name: ${JSON.stringify(name)} }` : '';
        const loc = `page.getByRole(${JSON.stringify(role)}${nameArg})`;
        const code = findAction === 'fill'
          ? `async page => { await ${loc}.fill(${JSON.stringify(value ?? text ?? '')}); }`
          : `async page => { await ${loc}.${findAction}(); }`;
        outcome = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
      } else if (step.action === 'find-label') {
        const { label, findAction = 'click', value, text } = step;
        const loc = `page.getByLabel(${JSON.stringify(label)})`;
        const code = findAction === 'fill'
          ? `async page => { await ${loc}.fill(${JSON.stringify(value ?? text ?? '')}); }`
          : `async page => { await ${loc}.${findAction}(); }`;
        outcome = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
      } else if (step.action === 'find-text') {
        const code = `async page => { await page.getByText(${JSON.stringify(step.text)}).first().click(); }`;
        outcome = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
      } else if (step.action === 'wait') {
        const ms = Math.min(parseInt(step.ms || step.duration || 2000, 10), 5000);
        await new Promise(r => setTimeout(r, ms));
        outcome = { ok: true, result: `waited ${ms}ms` };
      } else {
        outcome = await browserAct({ ...step, sessionId, headed, timeoutMs });
      }
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

        // ── HTTP error page detection ─────────────────────────────────────
        // If getPageText captured an HTTP error page instead of real AI content,
        // navigate back to the start URL and re-plan the full task rather than
        // letting the garbage text flow downstream into synthesize.
        const _httpErr = _detectHttpErrorPage(outcome.result);
        if (_httpErr && totalRepairs < maxRepairs && url) {
          totalRepairs++;
          logger.warn(`[playwright.agent] HTTP ${_httpErr} error page detected in getPageText — full retry ${totalRepairs}/${maxRepairs}`);
          try {
            await browserAct({ action: 'navigate', url, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) });
            await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 15000 });
            const retrySnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
            if (retrySnap.ok && retrySnap.result) currentSnapshot = retrySnap.result;
            const retryPlanRaw = await askWithMessages([
              { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
              { role: 'user', content: `GOAL: ${goal}\n\nNOTE: A previous attempt failed because the page returned an HTTP ${_httpErr} error. The page has been refreshed — please re-plan the full task from the current snapshot.\n\nSNAPSHOT:\n${extractInteractiveRefs(currentSnapshot)}${agentContext ? `\n\nAGENT CONTEXT:\n${agentContext}` : ''}` },
            ], { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
            const retryPlanParsed = parseJson(retryPlanRaw);
            if (retryPlanParsed && Array.isArray(retryPlanParsed.plan) && retryPlanParsed.plan.length > 0) {
              logger.info(`[playwright.agent] HTTP error retry: re-planned ${retryPlanParsed.plan.length} step(s) — ${retryPlanParsed.thoughts || ''}`);
              plan = retryPlanParsed.plan;
              stepIndex = 0;
              lastGetPageTextResult = null;
              continue;
            }
          } catch (retryErr) {
            logger.warn(`[playwright.agent] HTTP error retry re-plan failed: ${retryErr.message}`);
          }
        } else if (_httpErr) {
          logger.warn(`[playwright.agent] HTTP ${_httpErr} error page in getPageText — repair budget exhausted or no start URL, proceeding with error content`);
        }
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
          // Trigger re-plan if:
          //   navigate/goto: ANY ref change (even 1) — SPAs always invalidate refs on navigate,
          //     so a plan using e178 from a pre-navigate snapshot will fail (Ref not found).
          //   other actions: ≥30% change OR ≥20 new absolute refs (modal opened, inbox load, etc.)
          const isNavStep = step.action === 'navigate' || step.action === 'goto';
          const significantChange = isNavStep
            ? (preRefCount > 0 || postRefCount > 0) && (changeFraction > 0 || absoluteDelta !== 0)
            : (changeFraction >= 0.15 || absoluteDelta >= 10) && (preRefCount > 0 || postRefCount > 0);

          if (significantChange && remaining.length > 0) {
            // If the snapshot captured only a skeleton (<20 refs), the page is still loading.
            // Wait for it to stabilise before handing the tiny snapshot to the re-plan LLM —
            // a 12-ref snapshot produces a bad plan (e.g. picks a nav link instead of the
            // chat input). The threshold of 20 covers typical SPA loading states.
            if (postRefCount < 10) {
              logger.info(`[playwright.agent] post-nav snapshot too small (${postRefCount} refs) — waiting for page to stabilise`);
              const stableSnap = await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 12000 });
              const reSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
              if (reSnap.ok && reSnap.result) {
                currentSnapshot = reSnap.result;
                logger.info(`[playwright.agent] re-snaphotted after stabilise: ${countRefs(currentSnapshot)} refs`);
              }
            }
            logger.info(`[playwright.agent] structural DOM change — re-planning ${remaining.length} remaining step(s) with fresh refs`);

            // ── Login-wall interceptor: never let the LLM plan against a login page ──
            // If the fresh snapshot contains an OAuth provider button ("Continue with
            // Google / Apple / Microsoft"), this is definitely a login wall — escalate to
            // browser.agent's waitForAuth immediately instead of asking the LLM to
            // fill the email field (the LLM always does this and it is always wrong).
            const OAUTH_BUTTON_SNAP_RE = /Continue with Google|Sign in with Google|Log in with Google|Continue with Apple|Sign in with Apple|Continue with Microsoft|Sign in with Microsoft|Continue with GitHub/i;
            if (OAUTH_BUTTON_SNAP_RE.test(currentSnapshot)) {
              logger.warn(`[playwright.agent] REPLAN blocked: OAuth login page detected in snapshot — returning loginWallDetected immediately`);
              return {
                ok: false, goal, sessionId,
                turns: transcript.length, done: false,
                loginWallDetected: true,
                result: 'OAuth login page detected during navigation — escalating to waitForAuth',
                transcript, executionTime: Date.now() - start,
              };
            }

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

    // Dismiss any pending browser dialog (e.g. "Leave site?") that may be blocking the
    // session before we snapshot — otherwise the snapshot sees a dialog-blocked page and
    // every subsequent repair step also times out (burning all repair credits).
    await browserAct({ action: 'dialog-accept', sessionId, headed, timeoutMs: 3000 }).catch(() => {});

    // Fresh snapshot for repair context
    const repairSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
    if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;

    const remainingSteps = plan.slice(stepIndex + 1);
    let repairRaw;
    try {
      repairRaw = await askWithMessages([
        { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
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

  // ── Post-task completion verification ────────────────────────────────────────
  // Takes a final snapshot after all steps complete and asks the LLM whether the
  // goal was actually achieved. Catches silent completion failures where a step
  // exits 0 but nothing happened: focus-wrong keyboard shortcuts, form submits that
  // didn't register, modals that didn't close, etc.
  //
  // If verification fails (completed:false, confidence >= 0.75):
  //   1. Run one targeted repair inline using the verify evidence as error context.
  //   2. If repair steps execute cleanly → remove warning.
  //   3. If repair also fails → return ok:true + verificationWarning (non-blocking).
  // Entire block is non-fatal — any thrown error is caught and ignored.
  // Skip for extraction tasks: when finalResult is long (> 100 chars), the agent
  // already captured explicit content — verify would re-trigger a 9-39s LLM round-trip
  // for no benefit. Only run for short/absent results (action tasks, form submits, etc.).
  // ---------------------------------------------------------------------------
  if (!finalResult || finalResult.length <= 100) {
  try {
    await new Promise(r => setTimeout(r, 1000)); // 1s post-action settle
    const _verifySnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 });
    if (_verifySnap.ok && _verifySnap.result) {
      const _lastActions = transcript.slice(-5).map(t => JSON.stringify(t.action)).join('\n');
      const _verifyMsg = [
        `GOAL: ${goal}`,
        `LAST_ACTIONS:\n${_lastActions}`,
        `CURRENT_PAGE:\n${trimSnapshot(_verifySnap.result, 3000)}`,
      ].join('\n\n');

      const _verifyRaw = await askWithMessages([
        { role: 'system', content: VERIFY_SYSTEM_PROMPT },
        { role: 'user', content: _verifyMsg },
      ], { temperature: 0, maxTokens: 128, responseTimeoutMs: 12000 });

      const _verifyParsed = parseJson(_verifyRaw);
      if (_verifyParsed && _verifyParsed.completed === false && (_verifyParsed.confidence ?? 1) >= 0.75) {
        logger.warn(`[playwright.agent] POST-TASK VERIFY FAILED (confidence=${_verifyParsed.confidence}): ${_verifyParsed.evidence || 'task incomplete'}`);

        // If verification evidence describes a login/auth wall, skip inline repair —
        // the repair LLM will just suggest clicking UI buttons (wrong approach).
        // Return loginWallDetected:true so browser.agent's waitForAuth + auto-retry
        // path fires, which is the only correct fix for an auth wall.
        if (VERIFY_LOGIN_WALL_RE.test(_verifyParsed.evidence || '')) {
          logger.warn(`[playwright.agent] verify: login wall detected in evidence — escalating to browser.agent waitForAuth (skipping repair)`);
          return {
            ok: false, done: false, goal, sessionId,
            turns: transcript.length,
            result: _verifyParsed.evidence,
            transcript,
            executionTime: Date.now() - start,
            loginWallDetected: true,
          };
        }

        let _verifyWarning = _verifyParsed.evidence || 'task may be incomplete';
        try {
          const _vRepairRaw = await askWithMessages([
            { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
            { role: 'user', content: [
              `GOAL: ${goal}`,
              `FAILED_STEP: ${JSON.stringify(transcript[transcript.length - 1]?.action || {})}`,
              `ERROR: Post-task verification failed — ${_verifyParsed.evidence || 'task appears incomplete based on final page state'}`,
              `REMAINING_PLAN: []`,
              ``,
              `SNAPSHOT:`,
              trimSnapshot(_verifySnap.result),
            ].join('\n') },
          ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });

          const _vRepairParsed = parseJson(_vRepairRaw);
          if (_vRepairParsed && Array.isArray(_vRepairParsed.repair) && _vRepairParsed.repair.length > 0) {
            logger.info(`[playwright.agent] verify-repair: ${_vRepairParsed.repair.length} corrective steps — ${_vRepairParsed.thoughts || ''}`);
            for (const _vStep of _vRepairParsed.repair.slice(0, 3)) {
              const _vNorm = normalizeStep(_vStep);
              // Intercept 'wait' — not a browser action, handled locally
              if (_vNorm?.action === 'wait') {
                const _waitMs = Math.min(parseInt(_vNorm.ms || _vNorm.duration || 2000, 10), 5000);
                await new Promise(r => setTimeout(r, _waitMs));
                transcript.push({ step: transcript.length + 1, action: _vNorm, outcome: { ok: true, result: `waited ${_waitMs}ms` }, thoughts: 'verify-repair' });
                continue;
              }
              const _vOut = await browserAct({ ...(_vNorm || {}), sessionId, headed, timeoutMs });
              transcript.push({ step: transcript.length + 1, action: _vNorm, outcome: _vOut, thoughts: 'verify-repair' });
              if (_vOut.ok) _verifyWarning = null; // repair step succeeded — clear warning
            }
          }
        } catch (_vRepairErr) {
          logger.warn(`[playwright.agent] verify-repair LLM error: ${_vRepairErr.message}`);
        }

        if (_verifyWarning) {
          // Non-login-wall verify failure: surface the warning but keep ok:false
          // so the step shows as failed in the panel rather than silently green.
          return {
            ok: false, goal, sessionId,
            turns: transcript.length, done: false,
            result: finalResult !== null ? finalResult : `Completed: ${goal}`,
            transcript,
            executionTime: Date.now() - start,
            verificationWarning: _verifyWarning,
            error: `Task completion could not be verified: ${_verifyWarning}`,
          };
        }
      }
    }
  } catch (_verifyErr) {
    logger.warn(`[playwright.agent] post-task verification error (non-fatal): ${_verifyErr.message}`);
  }
  } // end verify gate

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
