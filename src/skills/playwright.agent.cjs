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
const http   = require('http');
const logger = require('../logger.cjs');
const { browserAct, getDebuggingContext, invalidateEngineSnapshot } = require('./browser.act.cjs');
const engine = require('./browser-engine.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const skillDb = require('../skill-helpers/skill-db.cjs');

const _COMMAND_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

// Call an installed external skill by name, passing args and the current sessionId
// so the skill can share the authenticated browser session.
function callExternalSkill(name, args = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'external.skill', args: { name, ...args } } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: _COMMAND_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('external.skill parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('external.skill timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Engine fast-path helpers — use Playwright Node API directly when engine is
// active, bypassing browserAct → cliRun subprocess overhead.
// Falls back to browserAct (which has its own CLI fallback) on any error.
// ---------------------------------------------------------------------------

async function _engineEval(sessionId, expr, timeoutMs = 5000) {
  const page = engine.getPage(sessionId);
  if (!page) return null;
  try {
    const result = await page.evaluate(expr);
    return { ok: true, result, stdout: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (e) {
    logger.debug(`[playwright.agent] _engineEval failed: ${e.message}`);
    return null;
  }
}

async function _engineNavigate(sessionId, url, timeoutMs = 30000) {
  const page = engine.getPage(sessionId);
  if (!page) return null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { ok: true };
  } catch (e) {
    logger.debug(`[playwright.agent] _engineNavigate failed: ${e.message}`);
    return null;
  }
}

// Lightweight engine snapshot — returns yaml + refMap but does NOT populate
// _engineSnapshots in browser.act.cjs. Use only when you need the yaml text
// without ref binding (e.g., orientation steps). For action-bound refs, use
// _fastSnapshot() which goes through browserAct({ action: 'snapshot' }).
async function _engineSnapshot(sessionId) {
  const page = engine.getPage(sessionId);
  if (!page) return null;
  try {
    const { yaml, refMap, activeElement, scannerUsed } = await engine.buildRefTree(page);
    return { ok: true, result: yaml, refMap, activeElement, scannerUsed };
  } catch (e) {
    logger.debug(`[playwright.agent] _engineSnapshot failed: ${e.message}`);
    return null;
  }
}

async function _fastSnapshot(sessionId, headed, timeoutMs = 15000) {
  return browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
}

// ---------------------------------------------------------------------------
// Hybrid scoped snapshot — DOM query confirms modal, then text filter on the
// full-page ARIA snapshot (which HAS refs from buildRefTree) extracts only the
// dialog section by tracking YAML indentation. Preserves refs (e24, e93) so
// the click engine resolves them correctly. Replaces the old _scopedModalSnapshot
// which used locator.ariaSnapshot() (no refs → LLM emitted CSS selectors).
// Returns { ok, result, hasCompose } or { ok: false } if no modal/no interactive.
// ---------------------------------------------------------------------------
async function _filterSnapshotToModal(sessionId, fullSnapshot) {
  if (!fullSnapshot) return { ok: false, error: 'no snapshot provided' };
  const page = engine.getPage(sessionId);
  if (!page) return { ok: false, error: 'no engine page' };

  // ── Step 1: DOM query to confirm modal exists and check for compose element ──
  let _modalInfo = null;
  try {
    _modalInfo = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]');
      if (!modal) return null;
      const hasCompose = !!modal.querySelector('[contenteditable], [role="textbox"], textarea');
      const interactiveCount = modal.querySelectorAll('button, [role="button"], [contenteditable], [role="textbox"], textarea, input, select, a[href]').length;
      return { hasCompose, interactiveCount };
    });
  } catch (err) {
    logger.debug(`[playwright.agent] filterSnapshotToModal: DOM query failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
  if (!_modalInfo) return { ok: false, error: 'no modal/dialog found in DOM' };

  // ── Step 2: Text filter on the full-page snapshot to extract the dialog section ──
  // If the snapshot is from the DOM scanner (tdN refs, flat list), the scanner already
  // filters by visibility and occlusion — elements behind the modal are flagged occluded.
  // Skip indentation-based filtering and return the snapshot as-is.
  if (/\[td\d+\]/.test(fullSnapshot)) {
    logger.info(`[playwright.agent] filterSnapshotToModal: scanner format detected — skipping YAML indent filter (scanner handles visibility)`);
    return { ok: true, result: fullSnapshot, hasCompose: _modalInfo.hasCompose };
  }

  // The ARIA snapshot is YAML-like with indentation. Find the LAST dialog/alertdialog
  // line (topmost modal = highest z-index = last in DOM order), then include it + all
  // lines with deeper indentation (children). Stop at same/shallower indentation.
  const lines = fullSnapshot.split('\n');
  let _dialogLineIdx = -1;
  let _dialogIndent = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const _indentMatch = line.match(/^(\s*)-/);
    if (!_indentMatch) continue;
    const _rest = line.slice(_indentMatch[0].length).trimStart();
    if (/^(dialog|alertdialog)\b/i.test(_rest)) {
      _dialogLineIdx = i;
      _dialogIndent = _indentMatch[1].length;
      break;
    }
  }
  if (_dialogLineIdx < 0) {
    logger.info(`[playwright.agent] filterSnapshotToModal: modal in DOM but no dialog/alertdialog line in snapshot — using full snapshot`);
    return { ok: false, error: 'dialog not found in snapshot text' };
  }

  // Collect the dialog line + all deeper-indented children
  const _scopedLines = [];
  for (let i = _dialogLineIdx; i < lines.length; i++) {
    const line = lines[i];
    if (i === _dialogLineIdx) {
      _scopedLines.push(line);
      continue;
    }
    const _indentMatch = line.match(/^(\s*)-/);
    if (!_indentMatch) {
      // Continuation lines (e.g. "  /url: ...") — include if we're still inside the dialog
      if (line.trim() && _scopedLines.length > 0) _scopedLines.push(line);
      continue;
    }
    const _indent = _indentMatch[1].length;
    if (_indent > _dialogIndent) {
      _scopedLines.push(line);
    } else {
      break; // same or shallower indent — we've exited the dialog
    }
  }

  const _scopedText = _scopedLines.join('\n');
  // Check if the scoped section has interactive elements with refs
  const _hasInteractive = /\b(textbox|searchbox|combobox|input|textarea|button|link|checkbox|radio|menuitem|option|tab|switch|contenteditable)\b/i.test(_scopedText);
  const _hasRefs = /\[e\d+\]/.test(_scopedText);
  if (!_hasInteractive || !_hasRefs) {
    logger.info(`[playwright.agent] filterSnapshotToModal: scoped section has no interactive elements or no refs — using full snapshot`);
    return { ok: false, error: 'scoped section has no interactive refs' };
  }

  logger.info(`[playwright.agent] filterSnapshotToModal: ${_scopedText.length} chars, ${_scopedLines.length} lines, hasCompose=${_modalInfo.hasCompose}, interactive=${_modalInfo.interactiveCount} — refs preserved`);
  return { ok: true, result: _scopedText, hasCompose: _modalInfo.hasCompose, scoped: true };
}

// ---------------------------------------------------------------------------
// Shared action schema constants — injected into multiple prompts so all LLMs
// use identical field names (selector not ref, etc.)
// ---------------------------------------------------------------------------

// Full action menu — used by PLAN_SYSTEM_PROMPT only.
const BROWSER_ACTIONS_FULL = `Available actions:
  navigate        { url }
  click           { selector, purpose? }  — purpose: 'search' | 'submit' | 'navigate' | 'voice' | 'general'. ALWAYS use 'search' when clicking a search button after typing in a search box.
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
  // waitForSelector, waitForContent - implemented as compatibility layers in browser.act.cjs
  getPageText     {}                   — returns ALL visible text from the page (body.innerText, up to 50k chars). Use this as the universal, site-agnostic way to read any page. Works on ChatGPT, Perplexity, Claude, Grok, and any other site without knowing site-specific CSS. Result auto-captured as task output.
  evaluate        { text: "<JS expression>" }  — single-expression JS returning a primitive (e.g. document.title)
  run-code        { code: "async page => { return await page.evaluate(() => { ...browser JS... }); }" }
                  — Node.js VM with real Playwright page object. Use page.evaluate() to reach browser DOM.
                  ⚠ require() does NOT exist. Use dynamic import: const { fn } = await import('module')
                  ⚠ NEVER read files inside run-code — file content is already in the task as [DATA FROM PRIOR STEP].
                  ⚠ SCOPE: only \`page\` exists in the function — \`task\`, \`task.results\`, \`results\`, \`context\`, \`globalState\` do NOT exist and will throw ReferenceError.
                  Gmail inbox example (use getPageText — universal, no site-specific CSS):
                  { "action": "getPageText" }
  external_skill  { name: "<skill-name>", args?: {...} } — run an installed atomic skill (e.g. mail_google_com_compose). The skill executes in the SAME browser session. Use ONLY when AVAILABLE ATOMIC SKILLS lists this exact name. Never guess a skill name.
  screenshot      { filePath }
  snapshot        {}                   — re-read the page (ONLY when page changes significantly)
  upload          { selector, files }  — attach file(s): clicks selector to open chooser, then uses engine file chooser. selector = button/input ref; files = array of real absolute paths from the task/request. IMPORTANT: always use "files" (array), NEVER use "path". NEVER invent placeholders like /path/to/file.pdf.
  pasteAttachment { selector?, uploadWaitMs? } — PREFERRED for Gmail/chat attachments. Assumes the file is already on the clipboard (a prior shell.run osascript step put it there). Finds the compose body textbox, focuses it, and presses Meta+V (macOS) / Ctrl+V (else). DO NOT click the paperclip/Attach button before this — the native file chooser modal blocks keyboard events. Optional selector pins the body ref if auto-detection picks the wrong textbox. uploadWaitMs overrides the upload settle timeout (default 120000ms/2min): pass uploadWaitMs:300000 for video files, uploadWaitMs:180000 for audio or multiple files.
  return          { data: "<string>" } — MUST be LAST step; plain string output, max 2000 chars.
  dialog-accept   { prompt? }
  dialog-dismiss  {}
  tab-new         { url? }             — open a new tab; if url provided, navigates to it. Returns new tab index.
  tab-list        {}                   — list all open tabs with their indices and URLs. Use to audit tabs.
  tab-select      { tabIndex }         — switch active focus to the tab at tabIndex
  tab-close       { tabIndex }         — close tab at tabIndex and free its resources. NEVER close tab 0.

INJECTION ACTIONS (React-aware — PREFERRED for compose boxes, modals, React-controlled inputs):
  reactFill       { selector, text, clearFirst? }  — set text on React inputs/textareas/contenteditable via native setter + event dispatch. selector = CSS selector (NOT ref). PREFERRED over fill/type for compose boxes.
  clickByText     { text, tag?, exact? }            — click visible element by text (e.g. "Post", "Send"). PREFERRED over click for submit buttons — no ref dependency.
  clickBySelector { selector, force? }              — click by CSS selector directly. Bypasses ref resolution. Use when stable CSS selector is known.

PURPOSE FIELD GUIDE (for click action):
When including a click step, ALWAYS specify the purpose to help the browser automation avoid clicking the wrong element:
- "search": Clicking a search button after typing in a search box (e.g., YouTube search, Google search, Amazon search). CRITICAL: Use this to avoid accidentally clicking the microphone/voice search icon which triggers permission dialogs.
- "submit": Clicking a form submit button (login, signup, contact forms)
- "navigate": Clicking a link, menu item, or navigation element to go to a different page
- "voice": Intentionally clicking a voice/microphone button when the task explicitly requires audio input
- "general": Any other click (buttons, toggles, expand/collapse, etc.)

⚠️ CRITICAL FOR SEARCH TASKS: When the goal involves searching (finding YouTube videos, searching Google, etc.), after filling the search box, click the SEARCH BUTTON (magnifying glass icon) not the MICROPHONE icon, and include "purpose": "search". The microphone button triggers browser permission dialogs that cannot be automated and will cause the task to fail.`;

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
CORRECT:  { "action": "click", "selector": "e24", "expected": { "type": "element_visible", "selector": "#search-results", "timeout": 5000, "description": "Search results should appear" } }
WRONG:    { "navigate": { "url": "..." } }
WRONG:    { "click": "Compose" }
WRONG:    { "action": "click", "ref": "e24" }        — "ref" is NOT a valid field

EXPECTATION FIELD (optional but recommended for critical steps):
- "expected": { "type": "element_visible|element_gone|url_change|text_present", "selector": "CSS selector or @eXX ref", "timeout": 5000, "description": "What should happen" }
- Types: element_visible (element appears), element_gone (element disappears), url_change (URL matches pattern), text_present (text appears on page)
- Use expectations for important actions to ensure they worked before continuing
- Examples: clicking "Search" should make results visible, clicking "Send" should make compose window disappear`;

// ---------------------------------------------------------------------------
// Phase 1 prompt — sent once, LLM returns the full step plan
// ---------------------------------------------------------------------------
const PLAN_SYSTEM_PROMPT = `You are a browser automation expert controlling a real Chrome browser via the Playwright Node API.

HOW IT WORKS — read this carefully:
Each step in your plan is executed as a browser action via the Playwright Node API engine:
  { "action": "navigate", "url": "https://..." }             →  engine page.goto(url)
  { "action": "click", "selector": "td5" }                   →  engine [data-td-ref] + click (with occlusion check)
  { "action": "fill", "selector": "td3", "text": "hello" }   →  engine [data-td-ref] + fill
  { "action": "run-code", "code": "async page => {...}" }     →  engine page.evaluate(code)

The SNAPSHOT is a filtered list of real interactive DOM elements. Refs like td5, td12 are stable element handles tagged with data-td-ref attributes —
use them directly in click/fill/hover/select. They are the most reliable selectors for DOM actions.
If the snapshot shows refs like e12, e83 (ARIA fallback), those also work — use them the same way.
For run-code + page.evaluate(), refs do NOT exist in the browser — use real CSS selectors (e.g. 'tr.zA', '.bog').
If the snapshot includes an "# Active element" line with [primary-input], the page already has focus in an input field — you can type directly without clicking first.

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
- Use element refs (td5, e12, etc.) from the snapshot for click/fill/hover — most reliable for DOM actions. Not valid inside page.evaluate(). If an element is marked [occluded], it is blocked by another element — try a different element or use force:true.
- Autocomplete inputs (e.g. Gmail To:, CC:, BCC:): fill then press Enter to confirm the recipient as a chip. Do NOT use Tab — Tab moves focus without creating the chip.
- Contenteditable areas: click first, then type (not fill).
- CODE_EDITOR_RULE: When writing into a code editor (CodeMirror, Monaco, ACE, textareawrapper, or any editor where clicking places a cursor rather than selecting all), ALWAYS clear existing content first before typing. Preferred approach: use run-code with page.evaluate() to call the editor's JS API (e.g. editor.setValue(newHtml) for CodeMirror, monaco.editor.getModels()[0].setValue(content) for Monaco). If no JS API is available: click the editor → press Meta+a → press Delete → then type. NEVER type directly into a code editor without clearing first — the cursor position appends text rather than replacing.
- Do NOT include auth steps — assume already logged in.
- CREDENTIALS RULE: If credentials not in goal text are required, return empty plan.
- NEVER emit credential template tokens like {{gmail:username}} or {{service:password}} in any step arg.
- Keep plan concise — no unnecessary waits or redundant snapshots.
- MULTI-ITEM EXTRACTION: Use one run-code step with page.evaluate() + document.querySelectorAll(). Never click per-item.
- RUN-CODE RETURN: run-code result is auto-captured as task output — do NOT add a placeholder return step after it.
- RUN-CODE CHAINING: To use a run-code result in a LATER step, combine both operations into ONE run-code (extract + act in same function). NEVER reference\`task\`, \`task.results\`, \`results\`, \`context\`, or any variable not in the \`async page =>\` signature — only \`page\` is available. These variables do NOT exist and will throw ReferenceError.
- DIALOG RULE: If a confirmation dialog may appear, add dialog-accept/dismiss immediately after the triggering action.
- MODAL/OVERLAY RULE: When clicking a button that opens a modal or overlay (Compose, New, Reply, etc.), add { "action": "snapshot" } as the very next step. This forces a DOM re-read so all following steps use fresh refs from the new modal. Without this, refs from the original page will fail inside the modal.
- AI CHAT EXTRACTION RULE: When sending a message to an AI assistant (ChatGPT, Claude, Grok, Perplexity, etc.), after pressing Enter add: (1) { "action": "waitForStableText" } to wait for the streamed response to finish, (2) { "action": "getPageText" } to read all visible page text. This is the UNIVERSAL, site-agnostic approach — works on any AI chat site without CSS class knowledge. NEVER use run-code + page.evaluate() with site-specific CSS selectors (like .prose, .generic, [data-testid=...]) for AI chat extraction — these selectors break across sites and page updates. Do NOT add a return step — the getPageText result is automatically captured as task output and will be consumed by the synthesis step downstream.
- CONTENT EXTRACTION RULE (CRITICAL): When extracting content from ANY page (search results, YouTube, news, documentation, etc.), use { "action": "getPageText" } and let the result flow through automatically. Do NOT add a { "action": "return" } step after getPageText. The getPageText result is automatically captured as the task output. Adding a return step with placeholder text or summary text like "Successfully searched..." will BLOCK the actual content from reaching the synthesis step and cause a "no useful content" failure. NEVER add a return step after getPageText — the system handles output automatically.
- SESSION ISOLATION RULE: When accessing an AI chat service, ALWAYS start with a navigate action to its fresh/new-chat URL to ensure getPageText reads ONLY the current query response, not old conversation history from previous sessions. EXCEPTION: If the task explicitly involves a follow-up or continuation of a previous AI response (keywords: "follow up", "continue", "based on that", "expand on", "now ask it"), stay on the current page and do NOT navigate away.
- NO PLACEHOLDER RULE: NEVER write literal template placeholder text like [ChatGPT response], [Perplexity response], [AI answer], [SEARCH RESULTS], [VIDEO RESULTS], [CONTENT], [insert content here], or any bracketed placeholder in any step args (task, body, text, data, etc.). These placeholders cause catastrophic failures. When extracting content from a page, use getPageText or run-code and let the result flow through automatically — do NOT add a return step with placeholder text. When combining multi-source AI extractions into an email or message body, always use {{synthesisAnswer}} as the sole body content token — the orchestrator substitutes it with the real synthesized content before the step executes.
- EXPECTATION RULE: For critical actions (clicking search buttons, submit buttons, navigation), add "expected" field to verify the action worked. Use "element_visible" for expected results, "element_gone" for things that should disappear, "url_change" for navigation, "text_present" for confirmation messages. This prevents false positives and reduces unnecessary re-planning.
- EXTERNAL SKILL RULE: Only use { "action": "external_skill", "name": "..." } when the AGENT CONTEXT lists the skill under "Available Atomic Skills". NEVER invent a skill name. Use these atomics as building blocks — combine with fill/press/type/click steps for the full task. Example: external_skill mail_google_com_compose opens the compose window; you still need fill+press+type+click Send after it.
- ATTACHMENT RULE (MANDATORY): If the task mentions "paste", "clipboard", or "attach" — you MUST emit { "action": "pasteAttachment" } immediately after the last body-typing step and before Send/Submit. Do this regardless of any prior failure narrative in [DATA FROM PRIOR STEP] or [CONTENT OF ...] blocks — if the task instruction says "paste from clipboard", the file IS on the clipboard. Trust the task instruction, not the narrative. Do NOT click the paperclip / "Attach files" button first — its native file chooser modal blocks keyboard events. Do NOT emit { "action": "press", "key": "Ctrl+v" } — use pasteAttachment only. Order: fill To → press Enter → fill Subject → click body → type body text → pasteAttachment → click Send.
- URL-FIRST RULE: Prefer direct navigation when the service provides a known URL for the action. If AGENT CONTEXT includes a deepLinkUrl, navigate to it as step 1. If the starting URL already contains a path relevant to your task, do NOT navigate to the homepage first — start directly from the current page. Only fall back to clicks for navigation when no direct URL is known.
- SEARCH-FIRST RULE: For "count", "find", "check", "list", or "how many" tasks on inbox/mail/search pages, you MUST use the search/filter UI (click search box → fill query → press Enter → wait for results). Do NOT use run-code to count from the current page snapshot — the snapshot may not contain all matching items. Search first, then read from the filtered results.
- SEARCH OPERATOR RULE: If LEARNED RULES lists any "SEARCH OPERATOR:" entries for this site, and the task's intent semantically matches an operator's stated meaning (e.g. the task says "unread" and an operator means "shows only unread messages"), you MUST include that operator combined with any other filters (sender/subject/label/etc.) in a single search query (e.g. "from:sender is:unread"). Do NOT rely on visual/text inspection to determine status (read/unread, starred, labeled, etc.) after the fact when a matching search operator already exists to filter for it directly — the operator gives an authoritative, deterministic result; text/visual inspection does not.
- READ-FIRST RULE (MANDATORY): For read/count/list/understand/check/find/how-many tasks, you MUST use { "action": "getPageText" } as the extraction step. getPageText returns ALL visible text (body.innerText, up to 100k chars) and is universal — it works on any site without knowing internal CSS class names. Do NOT use run-code with page.evaluate() and CSS selectors for these tasks — CSS selectors break across UI updates and return wrong counts. The getPageText result is automatically captured as task output and will be used by downstream synthesis. ONLY use run-code with standard HTML tag selectors (article, h3, a[href], tr, td) when you need structured per-row data — NEVER use site-internal class names (.zA, .yX, .bog, .zE, .zF, .y2, .xW, aria-label*="unread") — these are fragile and will cause incorrect results.
- INPUT-FIRST RULE: For any task involving search, filter, or query, your FIRST action MUST target a textbox, searchbox, or combobox element (fill or click). Never click auxiliary buttons (Refresh, Settings, Menu, etc.) before interacting with the input field. The input element ref is listed first in the snapshot.
- RUN-CODE EXTRACTION RULE: For counting/reading tasks, use { "action": "getPageText" } — NOT run-code with CSS selectors. run-code with site-specific CSS selectors (tr.zA, .zE, aria-label*="unread") returns wrong counts when the DOM structure changes. getPageText captures all visible text reliably. Only use run-code AFTER a search/filter has been applied AND you need structured per-field extraction with standard HTML tag selectors. For counting tasks: search first → snapshot → getPageText to read visible results.
- DUPLICATE GUARD: Before typing content into any field, check the current page snapshot. If text matching your planned content already exists on the page (e.g., the title is already typed, the body is already filled), do NOT type it again. Take a snapshot and verify the existing content instead. This prevents duplicate content from re-planning or verify-repair loops.
- IDEMPOTENCY RULE: For create actions (new page, new post, new issue, new email), if the URL has already changed to a new entity URL (e.g., /p/<id>, /issues/<number>, /compose/<id>), the create action succeeded — do NOT click "New" or "Create" again. If a compose window or editor is already open with content matching what you planned to type, do NOT open a new one.
- TAB STRATEGY RULE: You are a smart tabbing agent. Use as many tabs as the task requires to hold page state or extracted content while working across multiple pages WITHIN THE SAME AGENT SESSION (same domain/service). Open tabs dynamically, track them with tab-list, switch context with tab-select, and clean up with tab-close when a tab's work is done. 2-tab pattern (hold + act): tab 0 = Page A open (compose/form/draft/result); tab-new → Page B → getPageText → tab-select 0 → use extracted content in Page A → tab-close 1. 3-tab pattern (gather from multiple sources, act on one): tab 0 = destination; tab-new → Source B → getPageText; tab-new → Source C → getPageText; tab-select 0 → combine B+C → act → tab-close 2, tab-close 1. 5-tab pattern (parallel research, single synthesis): tab 0 = output/synthesis page; tabs 1–4 = tab-new per source → getPageText each; tab-select 0 → synthesize all results → act → close extra tabs in reverse order. Rules: (1) Always getPageText BEFORE switching away from a tab — result carries forward as [DATA FROM PRIOR STEP] context. (2) Use tab-list to audit open tabs when managing many. (3) tab-close completed tabs to keep the session clean. (4) NEVER use tabs to reach a different service — each agent owns its own Chrome session and cookie store.`;

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
// Phase 1.7 prompt — page study (understand the page before planning)
// Called AFTER orientation, BEFORE plan generation.
// Asks: what page is this, what elements matter, what's the expected flow?
// ---------------------------------------------------------------------------
const PAGE_STUDY_PROMPT = `You are a browser automation analyst. Given a page snapshot and a task goal, analyze the page and return a structured assessment. Do NOT generate action steps — only analyze.

Respond with EXACTLY ONE JSON object (no markdown fences, no explanation):

{
  "pageType": "<free-text short description — e.g. 'create', 'settings', 'inbox', 'login', 'homepage', 'dashboard', 'search-results', 'profile', 'feed', 'list', 'detail', 'editor', 'onboarding', 'checkout', 'error', 'landing'>",
  "rightPage": true | false,
  "confidence": 0.0,
  "keyElements": [
    { "ref": "td5", "role": "textbox", "label": "Primary input", "purpose": "where main content/prompt goes" }
  ],
  "expectedFlow": ["fill primary input", "select options", "click submit/generate", "wait for result"],
  "potentialBlockers": ["may require option selection", "may show confirmation dialog"],
  "wrongPageReason": null
}

Rules:
- pageType is free-text — use the most descriptive short label for the page. The suggested values above cover common cases but you may encounter any page type.
- rightPage: true if this page can accomplish the goal, false if we are on the wrong page.
- confidence: how sure you are that this page can accomplish the goal (0.0 = definitely wrong, 1.0 = definitely right).
- keyElements: list the interactive elements (from the snapshot refs) that are relevant to the goal. Include ref, role, label, and purpose (how it relates to the task).
- expectedFlow: high-level logical steps to accomplish the goal on this page (NOT playwright actions — just the conceptual flow).
- potentialBlockers: anything that might complicate execution (dialogs, required fields, auth gates, dynamic content).
- wrongPageReason: if rightPage is false, explain why and what page we should be on instead.`;

// ---------------------------------------------------------------------------
// Phase 2 prompt — called only when a step fails
// ---------------------------------------------------------------------------
const REPAIR_SYSTEM_PROMPT = `You are a browser automation expert. One step in an automation plan has failed.

You will receive the failed step, its error, the remaining plan, the current page snapshot, and debugging context from tracing/video analysis.
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
- If a run-code step failed with "task is not defined", "results is not defined", or "ReferenceError" on any cross-step variable: the run-code VM only has \`page\` in scope. Check PRIOR_STEP_RESULT in context — if it contains a URL, emit { "action": "navigate", "url": "<that url>" } directly. Otherwise combine the extraction and usage into one run-code step that does both.
- If the error contains "Timeout" and the failed step was navigate or click, a browser dialog (e.g. "Leave site?", "Leave page?") may be blocking. In that case start the repair with { "action": "dialog-accept" } before retrying the original step.
- CHIP INPUT RULE (MANDATORY): For any To:, CC:, BCC:, recipient, tag, label, or assignee field that creates chips/tokens — the correct sequence is ALWAYS: fill → press Enter → snapshot → VERIFY chip appeared. NEVER use Tab to confirm (Tab moves focus without creating the chip). If chip not confirmed in snapshot, press Enter again. Never skip the verify snapshot step.
- If the failed step is an upload action: the ONLY valid param for file paths is "files" (array of absolute paths). NEVER use "path". Correct form: { "action": "upload", "selector": "<ref>", "files": ["/absolute/path/to/file"] }
- If a \`press\` step with "Ctrl+v" or "Meta+v" fails with "does not handle the modal state", or if any paste/press step fails after clicking a paperclip/Attach button: a native file chooser modal is blocking keyboard events. Replace the failed step with { "action": "pasteAttachment" } — it focuses the compose body (contentEditable) and pastes there, bypassing the modal entirely. If an attach-button modal is still open, first emit { "action": "press", "key": "Escape" } to dismiss it, then pasteAttachment.
- FORM SUBMISSION FAILURE PATTERN: When a "press Enter" step fails to submit a form or the page doesn't change after submission:
  1. First try: Click the input field, then press Enter (ensure focus is in the field before submit)
  2. Second try: Look for and click the explicit submit/search button (often has text like "Search", "Submit", "Ask", or a magnifying glass icon)
  3. Third try: Check if the form needs a modifier key (Ctrl+Enter, Shift+Enter) or if there's a button with type="submit"
  - The repair should try the NEXT method, not just retry the same failed action
  - Use the snapshot to identify submit buttons by their text, aria-label, or icon (e.g., "Search", "Ask", "Go", "→", "🔍")

DEBUGGING CONTEXT USAGE:
- Use network errors to identify blocked resources or failed API calls
- Use console errors to detect JavaScript failures or timing issues  
- Use video analysis to identify visual indicators like error dialogs, loading states, or modal interference
- Use action history to understand sequence of events that led to failure
- Use timing data to add appropriate waits if operations were too fast
- Prioritize fixes that address the root cause shown in debugging data over generic workarounds
- CODE_EDITOR_RULE: When writing into a code editor (CodeMirror, Monaco, ACE, or any editor where clicking places a cursor), NEVER use type/fill to insert content. Use run-code with page.evaluate() to call the JS API: editor.setValue(fullHtmlString) for CodeMirror (sets ALL content atomically), monaco.editor.getModels()[0].setValue(content) for Monaco. One single run-code step should BOTH set the content AND handle the full replacement — do NOT split into clear+type.
- SUPPORTED ACTIONS: Only use these actions in repair steps: click, dblclick, fill, type, press, keyboard, hover, select, scroll, navigate, goto, forward, reload, close, snapshot, evaluate, run-code, getPageText, getText, upload, drag, dialog-accept, dialog-dismiss, pasteAttachment, waitForStableText, waitForNavigation, waitForAuth, wait. Do NOT use unsupported actions like waitForText, waitForElementNotVisible, waitForElementVisible, or waitForSelector — they will fail and cascade into more repairs.`;

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
- CURRENT_PAGE_CONTENT: existing text content already on the page (if any)

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
- Use element refs (td5, e12, etc.) from FRESH_SNAPSHOT for click/fill/hover
- EXISTING CONTENT RULE: If CURRENT_PAGE_CONTENT shows that the goal's target content already exists on the page (e.g. title, list items, form fields), do NOT recreate or duplicate it. Only fix what is missing or incorrect. Never navigate to a new page or click "New" if the current page already has the content being created.
- CHIP INPUT RULE (MANDATORY): For any To:, CC:, BCC:, recipient, tag, label, or assignee field that creates chips/tokens — the correct sequence is ALWAYS: fill → press Enter → snapshot → VERIFY chip appeared. NEVER use Tab to confirm (Tab moves focus without creating the chip). If chip not confirmed in snapshot, press Enter again. Never skip the verify snapshot step.
- Contenteditable areas: click first, then type (not fill)
- CREDENTIALS RULE: NEVER use placeholder text like 'your-email@gmail.com', 'user@example.com', '<email>', '<password>' in fill/type steps.
- NEVER emit credential template tokens like {{gmail:username}} / {{service:password}}.
- If FRESH_SNAPSHOT is an auth/login wall, return an empty plan and explain auth is required.
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
  "evidence": "<one sentence: what you see on the page that supports your verdict>",
  "dialog_blocking": true | false,
  "dialog_text": "<text of the dialog if one is visible, else empty string>"
}

DIALOG RULE (check FIRST before everything else):
- If a modal dialog, alert, confirmation prompt, or browser dialog is visibly blocking the page
  (e.g. "Send anyway?", "Send without subject?", "Leave page?", "Are you sure?", cookie banners,
  onboarding modals, "Discard draft?"), set dialog_blocking:true and completed:false.
- A blocking dialog is NOT a task failure — it is an intermediate state requiring a decision.
- Do NOT count a blocking dialog as evidence of incompletion on the underlying task.
- Only evaluate task completion AFTER mentally dismissing the dialog.

AUTOSAVE RULE (do NOT confuse with failure):
- Transient save/sync indicators ("Saving…", "Syncing…", "Uploading…", "Saving changes…") are NORMAL autosave states.
- They are NOT evidence of incompletion. Do NOT report completed:false because you see "Saving…".
- A "Saving…" or "Saved" indicator on a document editor means the action was accepted and is being persisted.

RICH TEXT EDITOR RULE:
- Google Docs, Notion, Confluence, and similar editors use canvas/custom rendering.
- Content typed via a prior 'type' or 'fill' action may NOT appear in the DOM snapshot even though it was entered successfully.
- If the action history includes a successful type/fill into a contenteditable or editor area, do NOT report incompletion solely because the typed text is absent from the snapshot.

Signs the task is INCOMPLETE (only applies when NO dialog is blocking):
- A compose / draft window is still visible and contains the message that was supposed to be sent
- A form is still present and filled with data that was supposed to be submitted
- An item that was supposed to be deleted is still in the list
- The URL is unchanged when a navigation was the last action
- An error message or validation error is shown (NOT a transient "Saving…" indicator)
- An "address not recognized" or validation error is shown in the compose window

Signs the task is COMPLETE:
- Page transitioned to a sent / confirmation / success view
- The targeted element (compose window, modal, form) is no longer visible
- A success toast, banner, or message is visible ("Message sent", "Saved", "Done", etc.)
- The URL changed to confirm navigation succeeded
- Content that was supposed to appear is now present
- A document editor shows the expected title/content with a "Saving…" or "Saved" status

Be conservative: if you see clear evidence of incompletion, prefer completed:false.
Only mark completed:false when confidence >= 0.75 — minor UI ambiguities are not failures.`;

// Regex to detect login-wall evidence in VERIFY output.
// When the LLM reports the page is a login/signup wall, skip inline repair and
// return loginWallDetected:true so browser.agent's waitForAuth + auto-retry fires.
const VERIFY_LOGIN_WALL_RE = /sign[\s-]*(in|up|into)|log[\s-]*(in|into)|not[\s-]*(logged|authenticated)|login[\s-]*(required|wall|page)|continue[\s-]*with[\s-]*(google|apple|microsoft|github|facebook|email)|email[\s-]*(entry|input|field|address|address\s*required)|create[\s-]*account|authentication[\s-]*required|please[\s-]+log[\s-]*(in|into)|welcome[\s-]*back|enter[\s-]*(your[\s-]*)?email|your[\s-]*email[\s-]*address|[@][^\s]+[\s-]*required/i;

// ---------------------------------------------------------------------------
// Strip JS-style // comments from a string (LLMs sometimes emit these inside JSON)
// ---------------------------------------------------------------------------
function stripJsonComments(s) {
  return s
    .replace(/^\s*\/\/[^\n]*/gm, '')               // remove pure comment lines
    .replace(/([}\],\d"'])\s*\/\/[^\n]*/g, '$1');  // remove trailing inline comments after tokens
}

// ---------------------------------------------------------------------------
// Normalize smart/curly quotes in verify eval expressions.
// Many rich-text editors (Notion, Google Docs, etc.) auto-convert straight
// quotes (' ") to typographic quotes (' ' " ") as the user types. LLM-generated
// verify evals embed the ORIGINAL straight-quote text as the expected substring,
// so a literal document.body.innerText.includes("...") comparison falsely fails
// for any content containing an apostrophe or quote. Rewrite the eval so the
// PAGE TEXT side of the comparison is normalized back to straight quotes before
// the substring check — the expected literal is left untouched since it already
// came from the user's original (straight-quote) text.
// ---------------------------------------------------------------------------
function normalizeQuotesInEvalExpr(evalStr) {
  if (!evalStr || typeof evalStr !== 'string') return evalStr;
  const NORMALIZE_SUFFIX = `.replace(/[\\u2018\\u2019]/g,"'").replace(/[\\u201C\\u201D]/g,'"')`;
  return evalStr
    .replace(/document\.body\.innerText/g, `document.body.innerText${NORMALIZE_SUFFIX}`)
    .replace(/document\.title/g, `document.title${NORMALIZE_SUFFIX}`);
}

// ---------------------------------------------------------------------------
// Parse LLM JSON response — tolerant of markdown fences, prose wrappers, and
// JS-style // comments that some models emit inside plan arrays.
// ---------------------------------------------------------------------------
function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text.trim()); } catch (_) {}
  const stripped = text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch (_) {}
  // Strip // comments and retry — handles "{ "plan": [ // do X\n { ... } ] }"
  const commentStripped = stripJsonComments(stripped);
  try { return JSON.parse(commentStripped); } catch (_) {}
  const match = commentStripped.match(/\{[\s\S]*\}/);
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
  const HAS_REF         = /\[?(?:e|td)\d+\]|\[ref=(?:e|td)\d+\]/;
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
  return (snapshotText.match(/\bref=(?:e|td)\d+\b|\[(?:e|td)\d+\]/g) || []).length;
}

function isAboutBlankSnapshot(snapshotText) {
  if (!snapshotText) return false;
  const t = String(snapshotText).slice(0, 3000);
  return /about:blank/i.test(t);
}

function looksLikeLoginWallSnapshot(snapshotText) {
  if (!snapshotText) return false;
  const t = String(snapshotText).slice(0, 8000);
  const oauthProvider = /Continue with Google|Sign in with Google|Log in with Google|Continue with Apple|Sign in with Apple|Continue with Microsoft|Sign in with Microsoft|Continue with GitHub/i.test(t);
  const authCopy = /\b(sign\s*in|log\s*in|create\s*account|forgot\s*email|forgot\s*password|use\s*your\s*google\s*account|to\s*continue\s*to|identifier)\b/i.test(t);
  const credentialUi = /\b(email|phone|username|password)\b/i.test(t);
  return oauthProvider || (authCopy && credentialUi);
}

function findUnresolvedCredentialToken(step) {
  if (!step || typeof step !== 'object') return null;
  const TOKEN_RE = /\{\{[a-z0-9_.-]+:[a-z0-9_]+\}\}/i;
  const fields = ['text', 'value', 'label', 'name'];
  for (const key of fields) {
    const v = step[key];
    if (typeof v === 'string') {
      const m = v.match(TOKEN_RE);
      if (m) return m[0];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Expectation-Driven Execution Functions
// ---------------------------------------------------------------------------

// Verify that an action achieved its expected outcome
async function verifyExpectation(step, sessionId, headed, timeoutMs) {
  if (!step.expected) {
    return { satisfied: true, reason: 'No expectation defined' };
  }

  const { type, selector, timeout = 5000 } = step.expected;
  const startTime = Date.now();

  try {
    switch (type) {
      case 'element_visible':
        const visibleResult = await browserAct({ 
          action: 'waitForSelector', 
          selector, 
          sessionId, 
          headed, 
          timeoutMs: Math.min(timeout, timeoutMs) 
        });
        return { 
          satisfied: visibleResult.ok, 
          reason: visibleResult.ok ? 'Element visible' : visibleResult.error 
        };

      case 'element_gone':
        // Aria snapshot refs (e.g. e1491) are not valid CSS selectors —
        // document.querySelector('e1491') always returns null so !null === true,
        // creating a permanent false-positive. Skip the check; rely on the
        // goal-achievement judge for actual confirmation.
        if (/^e\d+$/i.test((selector || '').trim())) {
          return { satisfied: true, reason: 'Aria ref selector — skipping element_gone querySelector check' };
        }
        const goneResult = await browserAct({
          action: 'evaluate',
          text: `!document.querySelector(${JSON.stringify(selector)})`,
          sessionId,
          headed,
          timeoutMs: Math.min(timeout, timeoutMs)
        });
        return { 
          satisfied: goneResult.ok && goneResult.result === 'true', 
          reason: goneResult.ok && goneResult.result === 'true' ? 'Element gone' : 'Element still present' 
        };

      case 'url_change':
        const urlResult = await browserAct({ 
          action: 'evaluate', 
          text: 'window.location.href', 
          sessionId, 
          headed, 
          timeoutMs: 3000 
        });
        if (urlResult.ok && selector) {
          const urlMatches = new RegExp(selector).test(urlResult.result);
          return { satisfied: urlMatches, reason: urlMatches ? 'URL matches pattern' : 'URL does not match pattern' };
        }
        return { satisfied: false, reason: 'Failed to check URL' };

      case 'text_present':
        // Aria refs (e.g. e18, e3) are ARIA accessibility refs, never visible page text
        if (/^e\d+$/.test(selector)) {
          return { satisfied: true, reason: 'Aria ref selector — skipping text_present check' };
        }
        const textResult = await browserAct({
          action: 'evaluate',
          text: `document.body.innerText.includes(${JSON.stringify(selector)})`,
          sessionId,
          headed,
          timeoutMs: 3000
        });
        return { 
          satisfied: textResult.ok && textResult.result === 'true', 
          reason: textResult.ok && textResult.result === 'true' ? 'Text present' : 'Text not found' 
        };

      default:
        return { satisfied: true, reason: `Unknown expectation type: ${type}, assuming satisfied` };
    }
  } catch (error) {
    return { satisfied: false, reason: `Expectation verification failed: ${error.message}` };
  } finally {
    logger.debug(`[playwright.agent] Expectation verification for ${type} took ${Date.now() - startTime}ms`);
  }
}

// ---------------------------------------------------------------------------
// Auto-verify submit-like clicks via state change detection (deterministic)
// ---------------------------------------------------------------------------

// Detect if a click step is a "submit-like" action that should be verified.
// Uses the LLM-provided purpose field, selector text, and whether it follows
// a fill/type step (the _hasFillOrType flag from the execution loop).
function _isSubmitLikeClick(step, hasFillOrType) {
  if (!step || step.action !== 'click') return false;
  const _purpose = String(step.purpose || '').toLowerCase();
  if (_purpose === 'submit') return true;
  const _selHint = String(step.selector || step.ref || step['aria-label'] || '').toLowerCase();
  if (/post|submit|send|tweet|publish|create|save|reply|share|confirm|apply|update|delete|remove/i.test(_selHint)) return true;
  // If a fill/type preceded this click and the selector hints at an action button,
  // treat it as submit-like. Don't trigger on ALL clicks after fill/type — only
  // those whose selector contains action-like text.
  if (hasFillOrType && /post|submit|send|tweet|publish|reply|share|confirm|apply/i.test(_selHint)) return true;
  return false;
}

// Verify that a submit-like click caused an observable state change.
// Uses page.waitForFunction (MutationObserver-based) — fires instantly when
// state changes, timeout is the max wait (not the actual wait).
// preClickState: { url, modalCount, bodyLen } captured BEFORE the click.
// Returns { verified: boolean, reason: string }.
async function _verifySubmitStateChange(sessionId, preClickState, timeoutMs = 3000) {
  const page = engine.getPage(sessionId);
  if (!page) return { verified: true, reason: 'No engine page — skipping verification' };

  // If no pre-click state was captured, we can't verify — skip (don't false-positive)
  if (!preClickState || (!preClickState.url && preClickState.modalCount === 0 && preClickState.bodyLen === 0)) {
    return { verified: true, reason: 'No before-state captured — skipping verification' };
  }

  // Wait for state change using waitForFunction (event-based, not polling)
  try {
    const _before = {
      url: preClickState.url || '',
      modalCount: preClickState.modalCount || 0,
      bodyLen: preClickState.bodyLen || 0,
    };
    const _changed = await page.waitForFunction((before) => {
      const modalCount = document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length;
      const url = window.location.href;
      const bodyLen = (document.body?.innerText || '').length;
      return url !== before.url                    // URL changed (navigation)
        || modalCount < before.modalCount          // modal/dialog closed
        || Math.abs(bodyLen - before.bodyLen) > 50; // content changed significantly
    }, _before, { timeout: timeoutMs }).then(() => true).catch(() => false);

    if (_changed) {
      // Determine what changed for logging
      const _afterState = await page.evaluate(() => ({
        url: window.location.href,
        modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
        bodyLen: (document.body?.innerText || '').length,
      })).catch(() => null);
      if (_afterState) {
        const _urlChanged = _afterState.url !== _before.url;
        const _modalClosed = _afterState.modalCount < _before.modalCount;
        const _contentChanged = Math.abs(_afterState.bodyLen - _before.bodyLen) > 50;
        const _reasons = [];
        if (_urlChanged) _reasons.push('URL changed');
        if (_modalClosed) _reasons.push('modal closed');
        if (_contentChanged) _reasons.push('content changed');
        return { verified: true, reason: _reasons.join(', ') || 'state changed' };
      }
      return { verified: true, reason: 'state changed' };
    }
    return { verified: false, reason: 'no observable state change within timeout — the button may be disabled, the form may have validation errors, or the wrong button was clicked' };
  } catch (err) {
    return { verified: false, reason: `verification error: ${err.message}` };
  }
}

// Tier 1: Safe pattern recognition (no URL patterns for login)
function handleKnownFailures(step, currentState, snapshot) {
  // Network-based error detection (from browser network monitoring)
  // Note: This would need to be implemented by calling browserAct with 'network' action
  // For now, we'll focus on content-based detection
  
  // Error page detection (content analysis - reliable)
  if (hasErrorElements(snapshot)) {
    return { cause: 'error_page', action: 'retry' };
  }
  
  // Loading state detection (reliable indicators)
  if (hasLoadingSpinner(snapshot) || hasSkeletonLoader(snapshot)) {
    return { cause: 'still_loading', action: 'wait' };
  }
  
  // AVOID: URL pattern matching for login (too many false positives/negatives)
  // Login detection handled in Tier 2 with element-based checks
  
  return null; // Unknown - proceed to Tier 2
}

// Tier 2: Element-based logic (reliable login detection)
function handleElementBasedFailures(step, snapshot) {
  // Login form detection (ONLY with concrete evidence - no URL patterns)
  if (!step.action.includes('login') && hasPasswordFields(snapshot) && hasLoginButton(snapshot)) {
    return { cause: 'login_wall', action: 'auth' };
  }
  
  // Modal/popup detection
  if (hasModalOverlay(snapshot) && !step.action.includes('modal')) {
    return { cause: 'modal_blocking', action: 'handle_modal' };
  }
  
  // Expected content missing
  if (step.expected && !elementExists(snapshot, step.expected.selector)) {
    return { cause: 'expected_missing', action: 'investigate' };
  }
  
  return null; // Unknown - proceed to Tier 3
}

// RELIABLE login detection - requires multiple signals
function hasPasswordFields(snapshot) {
  if (!snapshot) return false;
  return snapshot.includes('type="password"') || snapshot.includes('name="password"');
}

function hasLoginButton(snapshot) {
  if (!snapshot) return false;
  const t = snapshot.toLowerCase();
  return t.includes('login') || t.includes('signin') || 
         t.includes('sign in') || t.includes('log in');
}

function hasErrorElements(snapshot) {
  if (!snapshot) return false;
  const t = snapshot.toLowerCase();
  return t.includes('error') || t.includes('404') || t.includes('500') || 
         t.includes('page not found') || t.includes('something went wrong');
}

function hasLoadingSpinner(snapshot) {
  if (!snapshot) return false;
  const t = snapshot.toLowerCase();
  return t.includes('loading') || t.includes('spinner') || t.includes('loading...') ||
         t.includes('please wait') || t.includes('processing');
}

function hasSkeletonLoader(snapshot) {
  if (!snapshot) return false;
  const t = snapshot.toLowerCase();
  return t.includes('skeleton') || (t.includes('placeholder') && t.includes('loading'));
}

function hasModalOverlay(snapshot) {
  if (!snapshot) return false;
  const t = snapshot.toLowerCase();
  return t.includes('modal') || t.includes('dialog') || t.includes('overlay') ||
         t.includes('popup') || t.includes('lightbox');
}

function elementExists(snapshot, selector) {
  if (!snapshot || !selector) return false;
  // Simple check - in a full implementation, this would be more sophisticated
  return snapshot.includes(selector) || snapshot.includes(`"${selector}"`);
}

// Tier 3: LLM analysis (rare, last resort)
async function handleUnknownFailure(step, snapshot, error) {
  logger.info(`[playwright.agent] Tier 3: Using LLM to analyze unknown failure`);
  
  try {
    const analysis = await askWithMessages([
      { role: 'system', content: 'You are a browser automation expert analyzing failures. Respond with JSON only.' },
      { role: 'user', content: `
Action taken: ${JSON.stringify(step)}
Expected: ${JSON.stringify(step.expected || {})}
Actual error: ${error.message || 'No error message'}
Current state: ${extractInteractiveRefs(snapshot || '')}

What happened and what should I do next?
Respond with: {"cause": "...", "action": "...", "reason": "..."}
` }
    ], { temperature: 0.1, maxTokens: 300, responseTimeoutMs: 15000 });
    
    const parsed = parseJson(analysis);
    if (parsed && parsed.cause && parsed.action) {
      logger.info(`[playwright.agent] LLM analysis: ${parsed.cause} -> ${parsed.action} (${parsed.reason})`);
      return parsed;
    }
  } catch (llmError) {
    logger.warn(`[playwright.agent] LLM analysis failed: ${llmError.message}`);
  }
  
  // Fallback: generic retry
  return { cause: 'unknown_failure', action: 'retry', reason: 'Unknown failure, will retry' };
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
  let _lastHash = snapshotHash(currentSnapshot);
  let _noChangeCount = 0;
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

    const orientStep = normalizeStep(parsed.step);
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
    const reSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
    if (reSnap.ok && reSnap.result) {
      currentSnapshot = reSnap.result;
      const _newHash = snapshotHash(currentSnapshot);
      logger.info(`[playwright.agent] orientation: re-snapshotted after step ${i + 1} (${countRefs(currentSnapshot)} refs, hash=${_newHash})`);
      // Phase 7: Detect no-change to prevent infinite orientation loop
      if (_newHash === _lastHash) {
        _noChangeCount++;
        if (_noChangeCount >= 2) {
          logger.warn(`[playwright.agent] orientation: snapshot unchanged after 2 consecutive steps — stopping (infinite loop guard)`);
          break;
        }
      } else {
        _noChangeCount = 0;
        _lastHash = _newHash;
      }
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
  if (typeof step.action === 'string') {
    // Phase 7: Validate and auto-fix malformed selectors (e.g. button[ref=e24] → e24)
    if (step.selector) {
      const _selCheck = validateSelector(step.selector);
      if (!_selCheck.valid) {
        // Try to extract bare ref from malformed selector
        const _refMatch = String(step.selector).match(/e\d+/);
        if (_refMatch) {
          logger.warn(`[playwright.agent] normalizeStep: auto-fixing selector "${step.selector}" → "${_refMatch[0]}" (${_selCheck.reason})`);
          step = { ...step, selector: _refMatch[0] };
        } else {
          logger.warn(`[playwright.agent] normalizeStep: invalid selector "${step.selector}" — ${_selCheck.reason}`);
        }
      }
    }
    return step;
  }
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
// Phase 7: Snapshot hash — for orientation loop change detection
// ---------------------------------------------------------------------------
function snapshotHash(snapshotText) {
  if (!snapshotText) return '0';
  return String(snapshotText.length) + ':' + String(countRefs(snapshotText));
}

// ---------------------------------------------------------------------------
// Phase 7: Validate selector — reject malformed ref/CSS hybrid selectors
// ---------------------------------------------------------------------------
function validateSelector(selector) {
  if (!selector || typeof selector !== 'string') return { valid: false, reason: 'missing or non-string selector' };
  const s = selector.trim();
  if (!s) return { valid: false, reason: 'empty selector' };
  // Reject button[ref=eN] or button[ref=tdN] — ref/CSS syntax confusion
  if (/button\[ref=(?:e|td)\d+\]|\[ref=(?:e|td)\d+\]/i.test(s)) {
    return { valid: false, reason: `malformed ref/CSS hybrid selector: "${s}" — refs should be bare (e.g. "e24" or "td5"), not wrapped in CSS attribute selectors` };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Phase 6: Snapshot pruning — filter noise from ARIA snapshot before LLM
// Removes role: generic nodes with no interactive children or text, caps at ~50 refs
// ---------------------------------------------------------------------------
function pruneSnapshot(snapshotText, maxRefs = 50) {
  if (!snapshotText) return '(no snapshot available)';
  const lines = snapshotText.split('\n');
  const INTERACTIVE = /\b(textbox|searchbox|combobox|input|textarea|button|link|checkbox|radio|menuitem|option|tab|treeitem|switch|dialog|alertdialog)\b/i;
  const CONTENTEDITABLE = /\[contenteditable\]|contenteditable=["']?true/i;
  const HAS_REF = /\[?(?:e|td)\d+\]|\[ref=(?:e|td)\d+\]/;
  const GENERIC = /\bgeneric\b/i;
  const added = new Set();
  const out = [];

  const push = (line) => {
    if (!added.has(line)) { added.add(line); out.push(line); }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Always keep interactive elements and contenteditable
    if ((INTERACTIVE.test(line) || CONTENTEDITABLE.test(line)) && HAS_REF.test(line)) {
      // Walk backwards to find nearest meaningful parent
      for (let p = i - 1; p >= Math.max(0, i - 3); p--) {
        const candidate = lines[p];
        if (candidate && candidate.trim() && candidate.trim() !== '-' && candidate.trim() !== ':') {
          push(candidate);
          break;
        }
      }
      push(line);
      continue;
    }
    // Keep lines with text content (quoted strings) even if generic
    if (HAS_REF.test(line) && !GENERIC.test(line)) {
      push(line);
      continue;
    }
    // Keep generic lines that have text labels (quoted strings)
    if (GENERIC.test(line) && HAS_REF.test(line) && /"[^"]{3,}"/.test(line)) {
      push(line);
      continue;
    }
  }

  if (out.length === 0) return trimSnapshot(snapshotText, 8000);

  // Boost input-like elements (textbox/searchbox/combobox) to the top so LLMs
  // see actionable targets first — generic across all sites, not site-specific.
  const INPUT_ROLE = /\b(textbox|searchbox|combobox)\b/i;
  const boosted = [];
  const rest = [];
  for (const line of out) {
    if (INPUT_ROLE.test(line) && HAS_REF.test(line)) {
      boosted.push(line);
    } else {
      rest.push(line);
    }
  }
  const sorted = [...boosted, ...rest];

  // Cap at maxRefs lines (not exact ref count, but close enough)
  const capped = sorted.slice(0, maxRefs * 2); // ~2 lines per ref (parent + element)
  return `[Pruned snapshot: ${countRefs(snapshotText)} refs → ${countRefs(capped.join('\n'))} meaningful refs]\n` + capped.join('\n');
}

// ---------------------------------------------------------------------------
// Phase 1: Page probe — lightweight eval, no LLM call
// Runs after URL-first navigation settles, classifies page structure
// ---------------------------------------------------------------------------
async function pageProbe(sessionId, headed, timeoutMs = 5000) {
  const probeCode = `JSON.stringify({
    hasContentEditable: document.querySelector('[contenteditable]') !== null,
    contentEditableCount: document.querySelectorAll('[contenteditable]').length,
    hasRoleTextbox: document.querySelector('[role="textbox"]') !== null,
    roleTextboxCount: document.querySelectorAll('[role="textbox"]').length,
    hasTextarea: document.querySelector('textarea') !== null,
    textareaCount: document.querySelectorAll('textarea').length,
    hasTextInput: document.querySelector('input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="number"]') !== null,
    textInputCount: document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="password"], input[type="number"]').length,
    hasPlaceholder: document.querySelector('[placeholder]') !== null,
    hasAriaPlaceholder: document.querySelector('[aria-placeholder]') !== null,
    composeElementCount: document.querySelectorAll('[contenteditable], [role="textbox"], textarea, input[type="text"], input[type="search"]').length,
    hasComposeInModal: document.querySelector('[role="dialog"] [contenteditable], [role="dialog"] [role="textbox"], [role="dialog"] textarea, [role="dialog"] input[type="text"]') !== null,
    activeElementEditable: document.activeElement?.isContentEditable || false,
    activeElementTag: document.activeElement?.tagName || null,
    activeElementRole: document.activeElement?.getAttribute('role') || null,
    activeElementIsInput: ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable || ['textbox','searchbox','combobox'].includes(document.activeElement?.getAttribute('role')),
    buttonCount: document.querySelectorAll('button, [role="button"]').length,
    linkCount: document.querySelectorAll('a[href], [role="link"]').length,
    tabCount: document.querySelectorAll('[role="tab"]').length,
    checkboxCount: document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length,
    radioCount: document.querySelectorAll('input[type="radio"], [role="radio"]').length,
    switchCount: document.querySelectorAll('[role="switch"]').length,
    selectCount: document.querySelectorAll('select, [role="combobox"], [role="listbox"]').length,
    menuitemCount: document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]').length,
    optionCount: document.querySelectorAll('[role="option"]').length,
    sliderCount: document.querySelectorAll('input[type="range"], [role="slider"]').length,
    interactiveCount: document.querySelectorAll('button, input, select, textarea, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], [contenteditable], [onclick], [tabindex]:not([tabindex="-1"])').length,
    ariaGenericCount: document.querySelectorAll('[role="generic"], div:not([role])').length,
    hasCanvas: document.querySelector('canvas') !== null,
    bodyTextLength: document.body?.innerText?.length || 0,
    hostname: window.location.hostname,
    hasModalDialog: document.querySelector('[role="dialog"], [data-testid*="modal"], [data-testid*="share"], [aria-modal="true"]') !== null,
    modalCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length,
    hasDraggable: document.querySelector('[draggable="true"]') !== null,
    hasTabindex: document.querySelector('[tabindex]:not([tabindex="-1"])') !== null,
    hasContentEditableTrue: document.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"]') !== null
  })`;
  try {
    const result = await browserAct({ action: 'evaluate', text: probeCode, sessionId, headed, timeoutMs });
    if (result.ok && result.result) {
      const parsed = JSON.parse(result.result.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
      logger.info(`[playwright.agent] page probe: ${JSON.stringify(parsed)}`);
      return parsed;
    }
  } catch (err) {
    logger.warn(`[playwright.agent] page probe failed (non-fatal): ${err.message}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 1: Classify page type — deterministic, no LLM
// ---------------------------------------------------------------------------
function classifyPageType(probe) {
  if (!probe) return 'sparse';
  const { hasContentEditable, contentEditableCount, interactiveCount } = probe;

  // Canvas app: contenteditable dominates, few semantic interactive elements
  if (hasContentEditable && contentEditableCount >= 1 && interactiveCount < 20) {
    return 'canvas';
  }

  // Hybrid: has contenteditable AND rich interactive elements
  if (hasContentEditable && interactiveCount >= 20) {
    return 'hybrid';
  }

  // Traditional DOM: no contenteditable, rich interactive elements
  if (!hasContentEditable && interactiveCount >= 5) {
    return 'traditional';
  }

  // Sparse/unknown: very few elements — could be loading, login wall, or SPA shell
  return 'sparse';
}

// ---------------------------------------------------------------------------
// Phase 4: Script DB helpers — store/retrieve interaction scripts via skill-db KV
// Uses KV store with key prefix 'interaction_script:'
// ---------------------------------------------------------------------------
const SCRIPT_KV_PREFIX = 'interaction_script';

async function getInteractionScript(service, pageType, taskKeywords = []) {
  try {
    // Try exact match: service + page_type
    const exactKey = `${SCRIPT_KV_PREFIX}:${service}:${pageType}`;
    const exact = await skillDb.get('_playwright_agent', exactKey);
    if (exact && exact.script_yaml && (exact.status === 'healthy' || exact.status === 'degraded')) {
      logger.info(`[playwright.agent] script DB: found exact match for ${service}:${pageType} (status=${exact.status})`);
      return exact;
    }
    // Try fallback: any script for this service
    const all = await skillDb.list('_playwright_agent');
    for (const entry of all) {
      if (!entry.key.startsWith(SCRIPT_KV_PREFIX + ':' + service)) continue;
      const val = entry.value;
      if (!val || !val.script_yaml) continue;
      if (val.status !== 'healthy' && val.status !== 'degraded') continue;
      // Keyword matching if trigger_keywords present
      if (val.trigger_keywords && taskKeywords.length > 0) {
        const overlap = val.trigger_keywords.filter(k => taskKeywords.some(t => t.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(t.toLowerCase())));
        if (overlap.length > 0) {
          logger.info(`[playwright.agent] script DB: keyword match for ${service} (keywords: ${overlap.join(',')})`);
          return val;
        }
      } else {
        // No keywords to match — return first found
        logger.info(`[playwright.agent] script DB: fallback match for ${service} (key=${entry.key})`);
        return val;
      }
    }
  } catch (err) {
    logger.warn(`[playwright.agent] script DB lookup failed (non-fatal): ${err.message}`);
  }
  return null;
}

async function saveInteractionScript(service, action, pageType, scriptYaml, triggerKeywords = []) {
  try {
    const key = `${SCRIPT_KV_PREFIX}:${service}:${action}`;
    const script = {
      id: `${service}.${action}`,
      service,
      action,
      page_type: pageType,
      trigger_keywords: triggerKeywords,
      script_yaml: scriptYaml,
      status: 'healthy',
      last_validated: Date.now(),
      failure_count: 0,
      success_count: 1,
      created_at: Date.now(),
    };
    await skillDb.set('_playwright_agent', key, script);
    logger.info(`[playwright.agent] script DB: saved ${key} (status=healthy)`);
    return true;
  } catch (err) {
    logger.warn(`[playwright.agent] script DB save failed (non-fatal): ${err.message}`);
    return false;
  }
}

async function incrementScriptSuccess(service, action) {
  try {
    const key = `${SCRIPT_KV_PREFIX}:${service}:${action}`;
    const existing = await skillDb.get('_playwright_agent', key);
    if (existing) {
      existing.success_count = (existing.success_count || 0) + 1;
      existing.last_validated = Date.now();
      await skillDb.set('_playwright_agent', key, existing);
    }
  } catch (_) {}
}

async function incrementScriptFailure(service, action) {
  try {
    const key = `${SCRIPT_KV_PREFIX}:${service}:${action}`;
    const existing = await skillDb.get('_playwright_agent', key);
    if (existing) {
      existing.failure_count = (existing.failure_count || 0) + 1;
      if (existing.failure_count > 3) {
        existing.status = 'degraded';
        logger.warn(`[playwright.agent] script DB: ${key} marked degraded (failure_count=${existing.failure_count})`);
      }
      await skillDb.set('_playwright_agent', key, existing);
    }
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tier 1.5: Deterministic selector maps for URL-first form interactions
// Cached per hostname:pagePattern. LLM-generated, self-healing on failure.
// ---------------------------------------------------------------------------
const SELECTOR_MAP_KV_PREFIX = 'selector_map';

async function getSelectorMap(hostname, pagePattern) {
  try {
    const key = `${SELECTOR_MAP_KV_PREFIX}:${hostname}:${pagePattern}`;
    const existing = await skillDb.get('_playwright_agent', key);
    if (existing && existing.fields && (existing.status === 'healthy' || existing.status === 'degraded')) {
      logger.info(`[playwright.agent] selector map: cache hit for ${hostname}:${pagePattern} (status=${existing.status})`);
      return existing;
    }
  } catch (err) {
    logger.warn(`[playwright.agent] selector map lookup failed (non-fatal): ${err.message}`);
  }
  return null;
}

async function saveSelectorMap(hostname, pagePattern, map) {
  try {
    const key = `${SELECTOR_MAP_KV_PREFIX}:${hostname}:${pagePattern}`;
    const entry = {
      hostname,
      pagePattern,
      fields: map.fields,
      submitSelectors: map.submitSelectors || [],
      submitVerify: map.submitVerify || null,
      status: 'healthy',
      success_count: 0,
      failure_count: 0,
      last_validated: Date.now(),
      created_at: Date.now(),
    };
    await skillDb.set('_playwright_agent', key, entry);
    logger.info(`[playwright.agent] selector map: saved ${key} (status=healthy, ${entry.fields.length} fields)`);
    return true;
  } catch (err) {
    logger.warn(`[playwright.agent] selector map save failed (non-fatal): ${err.message}`);
    return false;
  }
}

async function incrementSelectorMapSuccess(hostname, pagePattern) {
  try {
    const key = `${SELECTOR_MAP_KV_PREFIX}:${hostname}:${pagePattern}`;
    const existing = await skillDb.get('_playwright_agent', key);
    if (existing) {
      existing.success_count = (existing.success_count || 0) + 1;
      existing.last_validated = Date.now();
      if (existing.status === 'degraded' && existing.success_count > existing.failure_count) {
        existing.status = 'healthy';
        logger.info(`[playwright.agent] selector map: ${key} restored to healthy`);
      }
      await skillDb.set('_playwright_agent', key, existing);
    }
  } catch (_) {}
}

async function incrementSelectorMapFailure(hostname, pagePattern) {
  try {
    const key = `${SELECTOR_MAP_KV_PREFIX}:${hostname}:${pagePattern}`;
    const existing = await skillDb.get('_playwright_agent', key);
    if (existing) {
      existing.failure_count = (existing.failure_count || 0) + 1;
      if (existing.failure_count > 2 && existing.status !== 'degraded') {
        existing.status = 'degraded';
        logger.warn(`[playwright.agent] selector map: ${key} marked degraded (failure_count=${existing.failure_count})`);
      }
      if (existing.failure_count > 4) {
        existing.status = 'broken';
        logger.warn(`[playwright.agent] selector map: ${key} marked broken — will regenerate on next run`);
      }
      await skillDb.set('_playwright_agent', key, existing);
    }
  } catch (_) {}
}

function derivePagePattern(url) {
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const composeMatch = path.match(/compose=new|compose\/post|\/compose\b|posting\?compose=true/i);
    if (composeMatch) return composeMatch[0];
    const segments = u.pathname.split('/').filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];
    return 'root';
  } catch (_) {
    return 'unknown';
  }
}

function isFormUrl(url) {
  if (!url) return false;
  return /compose=new|compose\/post|\/compose\b|posting\?compose=true|\/share\b|\/post\b|\/create\b/i.test(url);
}

// ---------------------------------------------------------------------------
// Phase 10: Async script generation queue
// When a canvas/hybrid page has no script in DB, queue background generation
// so the next run can use Tier 2 instead of falling through to Tier 3.
// ---------------------------------------------------------------------------
const _scriptGenQueue = new Set(); // dedup by service:action
let _scriptGenProcessing = false;

function queueAsyncScriptGeneration(service, pageType, goal, taskKeywords) {
  const action = deriveActionFromGoal(goal);
  const queueKey = `${service}:${action}`;
  if (_scriptGenQueue.has(queueKey)) return; // already queued
  _scriptGenQueue.add(queueKey);

  // Fire-and-forget — process asynchronously
  _processAsyncScriptGen(service, action, pageType, goal, taskKeywords, queueKey).catch(() => {
    _scriptGenQueue.delete(queueKey);
  });
}

async function _processAsyncScriptGen(service, action, pageType, goal, taskKeywords, queueKey) {
  // Check if script already exists (maybe another run created it)
  const existing = await getInteractionScript(service, pageType, taskKeywords);
  if (existing) {
    _scriptGenQueue.delete(queueKey);
    return;
  }

  logger.info(`[playwright.agent] Phase 10: async script gen queued for ${queueKey} (pageType=${pageType})`);

  try {
    // Use the sync script generation prompt to generate a script without executing it
    const raw = await askWithMessages([
      { role: 'system', content: SYNC_SCRIPT_GEN_PROMPT },
      { role: 'user', content: `GOAL: ${goal}\nPAGE_TYPE: ${pageType}\nSERVICE: ${service}\n\nGenerate a keyboard-first script:` },
    ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 20000 });

    const parsed = parseJson(raw);
    if (!parsed || !parsed.script || !Array.isArray(parsed.script.steps)) {
      logger.warn(`[playwright.agent] Phase 10: async script gen failed — no valid script for ${queueKey}`);
      _scriptGenQueue.delete(queueKey);
      return;
    }

    // Save to script DB with status 'healthy' but success_count=0 (untested)
    const script = {
      id: `${service}.${action}`,
      service,
      action,
      page_type: pageType,
      trigger_keywords: taskKeywords || [],
      script_yaml: parsed.script,
      status: 'healthy',
      last_validated: Date.now(),
      failure_count: 0,
      success_count: 0,
      created_at: Date.now(),
      auto_generated: true,
    };
    const key = `${SCRIPT_KV_PREFIX}:${service}:${action}`;
    await skillDb.set('_playwright_agent', key, script);
    logger.info(`[playwright.agent] Phase 10: async script gen saved ${queueKey} (${parsed.script.steps.length} steps, untested)`);
  } catch (err) {
    logger.warn(`[playwright.agent] Phase 10: async script gen error for ${queueKey} (non-fatal): ${err.message}`);
  } finally {
    _scriptGenQueue.delete(queueKey);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Seed scripts — curated keyboard-first scripts for top canvas apps
// ---------------------------------------------------------------------------
const SEED_SCRIPTS = [
  {
    service: 'notion',
    action: 'create_page_with_todos',
    page_type: 'canvas',
    trigger_keywords: ['create', 'page', 'todo', 'list', 'weekly', 'goals', 'tasks', 'notion'],
    script_yaml: {
      preconditions: { url_pattern: 'app.notion.com/p/.*' },
      params: ['title', 'items'],
      steps: [
        { assert_focus: { check: 'document.activeElement.isContentEditable', fix: 'click', fix_locator: "getByRole('textbox')", on_fail: 'fallback' } },
        { type: '{{title}}' },
        { press: 'Enter' },
        { for_each: 'items', do: [
          { type: '[] {{item}}' },
          { press: 'Enter' },
        ]},
      ],
      verify: [
        { eval: "document.body.innerText.includes('{{title}}')" },
      ],
    },
  },
  {
    service: 'chatgpt',
    action: 'new_chat',
    page_type: 'canvas',
    trigger_keywords: ['chatgpt', 'send', 'message', 'chat', 'ask', 'prompt', 'new'],
    script_yaml: {
      preconditions: { url_pattern: 'chatgpt.com.*' },
      params: ['message'],
      steps: [
        { assert_focus: { check: "document.activeElement.id === 'prompt-textarea' || document.activeElement.tagName === 'TEXTAREA'", fix: 'click', fix_locator: "getByRole('textbox', { name: 'Message ChatGPT' })", on_fail: 'fallback' } },
        { type: '{{message}}' },
        { press: 'Enter' },
      ],
      verify: [
        { eval: "document.body.innerText.length > 100" },
      ],
    },
  },
  {
    service: 'gemini',
    action: 'new_chat',
    page_type: 'canvas',
    trigger_keywords: ['gemini', 'send', 'message', 'chat', 'ask', 'prompt', 'new'],
    script_yaml: {
      preconditions: { url_pattern: 'gemini.google.com.*' },
      params: ['message'],
      steps: [
        { assert_focus: { check: "document.activeElement.tagName === 'TEXTAREA'", fix: 'click', fix_locator: "getByRole('textbox')", on_fail: 'fallback' } },
        { type: '{{message}}' },
        { press: 'Enter' },
      ],
      verify: [
        { eval: "document.body.innerText.length > 100" },
      ],
    },
  },
];

async function ensureSeedScripts() {
  for (const seed of SEED_SCRIPTS) {
    try {
      const key = `${SCRIPT_KV_PREFIX}:${seed.service}:${seed.action}`;
      const existing = await skillDb.get('_playwright_agent', key);
      if (!existing) {
        await skillDb.set('_playwright_agent', key, {
          id: `${seed.service}.${seed.action}`,
          ...seed,
          status: 'healthy',
          last_validated: Date.now(),
          failure_count: 0,
          success_count: 0,
          created_at: Date.now(),
        });
        logger.info(`[playwright.agent] script DB: seeded ${key}`);
      }
    } catch (_) {}
  }
}

// ── Slash-command settle wait ──────────────────────────────────────────────
// After pressing Enter to confirm a slash command (e.g. "/todo" in Notion),
// the app unmounts the slash-menu popup and remounts a new contenteditable block.
// If the next step types immediately, the first character can be dropped because
// the new block isn't ready yet. This polls until activeElement is contenteditable
// (meaning focus has returned to the editor) or times out as a safety net.
async function _waitForSlashCommandSettled(sessionId, headed) {
  const _SLASH_SETTLE_EVAL = 'document.activeElement && document.activeElement.isContentEditable';
  const _POLL_INTERVAL = 50;
  const _MAX_WAIT = 500;
  try {
    let _elapsed = 0;
    while (_elapsed < _MAX_WAIT) {
      const _r = await browserAct({ action: 'evaluate', text: _SLASH_SETTLE_EVAL, sessionId, headed, timeoutMs: 2000 });
      if (_r.ok && (_r.result === true || _r.result === 'true')) {
        logger.info(`[playwright.agent] slash-command settle: activeElement editable after ${_elapsed}ms`);
        return;
      }
      await new Promise(r => setTimeout(r, _POLL_INTERVAL));
      _elapsed += _POLL_INTERVAL;
    }
    logger.info(`[playwright.agent] slash-command settle: timeout after ${_MAX_WAIT}ms — proceeding anyway`);
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Phase 2: Script-first executor — runs script steps deterministically
// ---------------------------------------------------------------------------
async function executeScript(script, params, sessionId, headed, timeoutMs) {
  const yaml = script.script_yaml;
  if (!yaml || !yaml.steps) return { ok: false, error: 'Script has no steps' };

  const transcript = [];
  const steps = yaml.steps;

  // Template variable substitution
  function substitute(val) {
    if (typeof val !== 'string') return val;
    let result = val;
    for (const [key, value] of Object.entries(params || {})) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }
    return result;
  }

  let _awaitSlashSettle = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    logger.info(`[playwright.agent] script step ${i + 1}/${steps.length}: ${JSON.stringify(step)}`);

    // Detect slash-command pattern: type "/..." followed by press Enter
    // After that Enter confirms the slash command, the app remounts a new block —
    // we must wait for it to be ready before the next step types into it.
    if (step.type && typeof step.type === 'string' && step.type.trim().startsWith('/')) {
      const _nextStep = steps[i + 1];
      if (_nextStep && _nextStep.press && String(_nextStep.press).toLowerCase() === 'enter') {
        _awaitSlashSettle = true;
      }
    }

    // Handle for_each loops
    if (step.for_each) {
      const arrName = step.for_each;
      const arr = params[arrName];
      if (!Array.isArray(arr)) {
        return { ok: false, error: `for_each: "${arrName}" is not an array`, transcript, stepIndex: i };
      }
      const doSteps = step.do || [];
      for (let j = 0; j < arr.length; j++) {
        // Set {{item}} to current array element
        const itemParams = { ...params, item: arr[j], item_index: j };
        for (const doStep of doSteps) {
          const expandedStep = {};
          for (const [k, v] of Object.entries(doStep)) {
            if (typeof v === 'string') {
              expandedStep[k] = substitute(v.replace(/\{\{item\}\}/g, String(arr[j])));
            } else if (typeof v === 'object') {
              expandedStep[k] = JSON.parse(substitute(JSON.stringify(v).replace(/\{\{item\}\}/g, String(arr[j]))));
            } else {
              expandedStep[k] = v;
            }
          }
          let loopResult;
          try {
            loopResult = await executeScriptStep(expandedStep, itemParams, sessionId, headed, timeoutMs, substitute);
          } catch (stepErr) {
            loopResult = { ok: false, error: stepErr.message };
          }
          transcript.push({ step: `${i + 1}.${j + 1}`, action: expandedStep, outcome: loopResult });
          if (!loopResult.ok) {
            return { ok: false, error: `Script step ${i + 1}.${j + 1} failed: ${loopResult.error}`, transcript, stepIndex: i };
          }
        }
      }
      continue;
    }

    let result;
    try {
      result = await executeScriptStep(step, params, sessionId, headed, timeoutMs, substitute);
    } catch (stepErr) {
      result = { ok: false, error: stepErr.message };
    }
    transcript.push({ step: i + 1, action: step, outcome: result });
    if (!result.ok) {
      return { ok: false, error: `Script step ${i + 1} failed: ${result.error}`, transcript, stepIndex: i };
    }

    // After a slash-command-confirming Enter, wait for the new block to be ready
    if (_awaitSlashSettle && step.press && String(step.press).toLowerCase() === 'enter') {
      _awaitSlashSettle = false;
      await _waitForSlashCommandSettled(sessionId, headed);
    }
  }

  // Run verify block if present
  if (yaml.verify) {
    for (const vStep of yaml.verify) {
      if (vStep.eval) {
        const evalCode = normalizeQuotesInEvalExpr(substitute(vStep.eval));
        try {
          const vResult = await browserAct({ action: 'evaluate', text: evalCode, sessionId, headed, timeoutMs: 5000 });
          if (!vResult.ok || (vResult.result !== true && vResult.result !== 'true')) {
            logger.warn(`[playwright.agent] script verify failed: ${evalCode} → ${vResult.result}`);
            return { ok: false, error: `Verification failed: ${evalCode}`, transcript, verified: false };
          }
        } catch (err) {
          logger.warn(`[playwright.agent] script verify error: ${err.message}`);
          return { ok: false, error: `Verification error: ${err.message}`, transcript, verified: false };
        }
      }
    }
  }

  return { ok: true, transcript, verified: true };
}

async function executeScriptStep(step, params, sessionId, headed, timeoutMs, substituteFn) {
  const sub = substituteFn || ((v) => typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => params[k] ?? '') : v);

  // assert_focus
  if (step.assert_focus) {
    const check = sub(step.assert_focus.check);
    try {
      const result = await browserAct({ action: 'evaluate', text: check, sessionId, headed, timeoutMs: 3000 });
      if (result.ok && result.result === 'true') {
        return { ok: true, result: 'focus check passed' };
      }
      // Focus check failed — try fix
      if (step.assert_focus.fix === 'click' && step.assert_focus.fix_locator) {
        const locator = step.assert_focus.fix_locator;
        const code = `async page => { await ${locator}.click(); }`;
        const fixResult = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
        if (fixResult.ok) {
          // Re-check focus
          const recheck = await browserAct({ action: 'evaluate', text: check, sessionId, headed, timeoutMs: 3000 });
          if (recheck.ok && recheck.result === 'true') {
            return { ok: true, result: 'focus fixed via click' };
          }
        }
      }
      if (step.assert_focus.on_fail === 'fallback') {
        return { ok: false, error: `Focus assertion failed: ${check}` };
      }
      return { ok: false, error: `Focus assertion failed: ${check}` };
    } catch (err) {
      return { ok: false, error: `Focus check error: ${err.message}` };
    }
  }

  // type
  if (step.type) {
    const text = sub(step.type);
    const result = await browserAct({ action: 'type', text, sessionId, headed, timeoutMs });
    return result;
  }

  // press
  if (step.press) {
    const key = sub(step.press);
    const result = await browserAct({ action: 'press', key, sessionId, headed, timeoutMs });
    return result;
  }

  // click (via Playwright semantic locator)
  if (step.click) {
    const locator = sub(step.click);
    const code = `async page => { await ${locator}.click(); }`;
    const result = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
    return result;
  }

  // wait (via Playwright locator)
  if (step.wait) {
    const locator = sub(step.wait);
    const code = `async page => { await ${locator}.waitFor({ timeout: ${timeoutMs} }); }`;
    const result = await browserAct({ action: 'run-code', code, sessionId, headed, timeoutMs });
    return result;
  }

  // eval
  if (step.eval) {
    const code = sub(step.eval);
    const result = await browserAct({ action: 'evaluate', text: code, sessionId, headed, timeoutMs });
    return result;
  }

  return { ok: false, error: `Unknown script step type: ${JSON.stringify(Object.keys(step))}` };
}

// ---------------------------------------------------------------------------
// Shared, app-agnostic behavior patterns for keyboard-only interaction.
// Named apps are deliberately excluded — these describe structural/behavioral
// patterns common across many editors and chat UIs, so the LLM can apply them
// to any service based on page context rather than a hardcoded per-app list.
// ---------------------------------------------------------------------------
const GENERIC_EDITOR_PATTERNS = `MARKDOWN-SHORTCUT LIST PATTERN:
- Many rich-text editors auto-convert a markdown shortcut ("[] ", "# ", "- ", "1. ", "> ") typed at the START of an empty line into a formatted block (checkbox, heading, bullet, numbered, quote).
- Once that block is created, pressing Enter typically continues the SAME block type automatically for the next line — do NOT repeat the shortcut prefix on subsequent items, it will appear as literal unconverted text instead of being interpreted.
- Use the shortcut ONCE (for the first item only) if no explicit slash-command / toolbar action already created the block. If a slash-command equivalent (e.g. "/todo", "/checklist") was already used to create the block, never type the shortcut at all — just type item text and press Enter between items.

CHAT-SUBMIT PATTERN:
- Many chat-style inputs (AI assistants, messaging apps) submit the message on Enter and insert a newline on Shift+Enter (or vice versa depending on the app). Default to Enter to submit unless page context indicates otherwise.`;

// ---------------------------------------------------------------------------
// Phase 3: Tier 2.5 — Best-effort keyboard mode
// LLM generates keyboard-only steps (type/press, no clicks/refs) from goal
// ---------------------------------------------------------------------------
const BEST_EFFORT_KEYBOARD_PROMPT = `You are a keyboard automation expert. Given a task goal and page type, generate keyboard-only steps to accomplish the task. NO clicks, NO element targeting — just keyboard events to whatever has focus.

Respond with EXACTLY ONE JSON object (no markdown fences):
{
  "thoughts": "<one sentence>",
  "steps": [
    { "type": "<text to type>" },
    { "press": "<key>" }
  ]
}

Rules:
- Use ONLY type and press steps — no clicks, no selectors, no refs
- Assume focus is already in the right place (URL-first navigation handled targeting)
- Keep steps minimal — just the keyboard sequence needed

${GENERIC_EDITOR_PATTERNS}`;

async function bestEffortKeyboard(goal, pageType, sessionId, headed, timeoutMs) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: BEST_EFFORT_KEYBOARD_PROMPT },
      { role: 'user', content: `GOAL: ${goal}\nPAGE_TYPE: ${pageType}\n\nGenerate keyboard-only steps:` },
    ], { temperature: 0.1, maxTokens: 600, responseTimeoutMs: 15000 });

    const parsed = parseJson(raw);
    if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      return { ok: false, error: 'Best-effort keyboard: no steps generated', transcript: [] };
    }

    logger.info(`[playwright.agent] Tier 2.5 best-effort: ${parsed.steps.length} keyboard steps — ${parsed.thoughts}`);
    const transcript = [];

    for (let i = 0; i < parsed.steps.length; i++) {
      const step = parsed.steps[i];
      let result;
      if (step.type) {
        result = await browserAct({ action: 'type', text: step.type, sessionId, headed, timeoutMs });
      } else if (step.press) {
        result = await browserAct({ action: 'press', key: step.press, sessionId, headed, timeoutMs });
      } else {
        continue;
      }
      transcript.push({ step: i + 1, action: step, outcome: result });
      if (!result.ok) {
        return { ok: false, error: `Best-effort step ${i + 1} failed: ${result.error}`, transcript };
      }
      // Small delay between steps for page to react
      await new Promise(r => setTimeout(r, 300));
    }

    return { ok: true, transcript, thoughts: parsed.thoughts };
  } catch (err) {
    return { ok: false, error: `Best-effort keyboard error: ${err.message}`, transcript: [] };
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Tier 2.5 — Sync script generation
// LLM generates a grounded script from page type + goal (no web search yet)
// ---------------------------------------------------------------------------
const SYNC_SCRIPT_GEN_PROMPT = `You are a browser automation script generator. Given a task goal, page type, and service name, generate a keyboard-first interaction script.

The script should use keyboard shortcuts and markdown syntax that are stable across page reloads. NO element refs (eN), NO CSS selectors for targeting — use keyboard events and Playwright semantic locators only.

Respond with EXACTLY ONE JSON object (no markdown fences):
{
  "thoughts": "<one sentence>",
  "script": {
    "steps": [
      { "type": "<text>" },
      { "press": "<key>" },
      { "assert_focus": { "check": "<JS expression>", "fix": "click", "fix_locator": "<Playwright locator>", "on_fail": "fallback" } }
    ],
    "verify": [
      { "eval": "<JS expression that returns true/false>" }
    ]
  }
}

Rules:
- Use type/press for keyboard input — these go to whatever has focus
- Use assert_focus ONLY when you need to verify focus before typing
- Verify should check page content (document.body.innerText.includes(...))
- Keep steps minimal and deterministic

${GENERIC_EDITOR_PATTERNS}`;

async function syncScriptGeneration(goal, pageType, service, sessionId, headed, timeoutMs) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: SYNC_SCRIPT_GEN_PROMPT },
      { role: 'user', content: `GOAL: ${goal}\nPAGE_TYPE: ${pageType}\nSERVICE: ${service}\n\nGenerate a keyboard-first script:` },
    ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 20000 });

    const parsed = parseJson(raw);
    if (!parsed || !parsed.script || !Array.isArray(parsed.script.steps)) {
      return { ok: false, error: 'Sync script gen: no valid script generated' };
    }

    logger.info(`[playwright.agent] Tier 2.5 sync gen: ${parsed.script.steps.length} steps — ${parsed.thoughts}`);

    // Execute the generated script
    const scriptObj = {
      script_yaml: parsed.script,
      service,
      action: 'auto_generated',
      status: 'healthy',
    };

    // Extract params from goal (simple heuristic)
    const params = extractParamsFromGoal(goal);
    const result = await executeScript(scriptObj, params, sessionId, headed, timeoutMs);

    if (result.ok) {
      // Cache the successful script
      const action = deriveActionFromGoal(goal);
      await saveInteractionScript(service, action, pageType, parsed.script, extractKeywordsFromGoal(goal));
    }

    return result;
  } catch (err) {
    return { ok: false, error: `Sync script gen error: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Tier 1.5: LLM selector map generation + goal field extraction + execution
// ---------------------------------------------------------------------------

const SELECTOR_MAP_GEN_PROMPT = `You are a browser automation expert. Analyze the provided page HTML and generate a CSS selector map for form fields.

Output ONLY a JSON object (no markdown, no explanation) with:
- "fields": array of field objects, each with:
  - "name": semantic field name (e.g. "to", "subject", "body", "title", "description", "content")
  - "selectors": array of CSS selector strings to try in order (most specific first)
  - "type": one of "input", "textarea", "contenteditable", "chip", "select"
  - "verifySelector": CSS selector to check after typing (may differ from input selector)
  - "verifyType": one of "value" (check .value), "innerText" (check .innerText), "chip_count" (count chip elements)
- "submitSelectors": array of CSS selectors for submit/send buttons to try in order
- "submitVerify": object with:
  - "type": "compose_gone" (compose dialog disappeared), "snackbar" (success message appeared), "url_change" (URL changed away from compose)
  - "pattern": regex string to match in page text for success confirmation (optional)

Rules:
- Use real CSS selectors that exist on the page. Prefer [name="..."], [aria-label="..."], [data-testid="..."] over generic tags.
- For chip/badge fields (like Gmail To), set type="chip" and verifyType="chip_count".
- For contenteditable bodies, set type="contenteditable" and verifyType="innerText".
- Keep selectors robust: avoid nth-child, avoid auto-generated class names.
- Output ONLY the JSON object.`;

const FIELD_EXTRACTION_PROMPT = `You are a goal parser. Extract field values from the user's goal for form filling.

Output ONLY a JSON object mapping field names to their values. Field names should match common form field names: "to", "subject", "body", "title", "description", "content", "cc", "bcc", "tags", "category".

Rules:
- Email addresses go in "to" (comma-separated if multiple).
- Text after "subject" or "titled" goes in "subject".
- Text after "body" or "message" or "saying" goes in "body".
- If the goal is a single text with no clear field mapping, put it in "body".
- Output ONLY the JSON object, no explanation.`;

async function _generateSelectorMap(sessionId, hostname, goal, timeoutMs) {
  try {
    const page = engine.getPage(sessionId);
    if (!page) return null;

    // Gather page HTML structure for LLM analysis
    const pageHtml = await page.evaluate(() => {
      // Collect form-related elements with their attributes
      const elements = [];
      const inputs = document.querySelectorAll('input, textarea, select, [contenteditable], [role="combobox"], [role="textbox"]');
      for (const el of inputs) {
        if (el.offsetParent === null && el.getClientRects().length === 0) continue; // skip hidden
        const info = {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.getAttribute('id'),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          role: el.getAttribute('role'),
          contentEditable: el.isContentEditable,
          className: (el.className || '').toString().slice(0, 100),
          dataTestId: el.getAttribute('data-testid'),
        };
        elements.push(info);
      }
      // Also collect buttons that might be submit
      const buttons = [];
      const btns = document.querySelectorAll('button, [role="button"], div[aria-label*="send" i], div[aria-label*="submit" i], div[aria-label*="post" i], input[type="submit"]');
      for (const btn of btns) {
        if (btn.offsetParent === null && btn.getClientRects().length === 0) continue;
        buttons.push({
          tag: btn.tagName.toLowerCase(),
          text: (btn.innerText || btn.textContent || '').slice(0, 50),
          ariaLabel: btn.getAttribute('aria-label'),
          type: btn.getAttribute('type'),
          role: btn.getAttribute('role'),
          dataTestId: btn.getAttribute('data-testid'),
        });
      }
      return JSON.stringify({ url: location.href, title: document.title, fields: elements, buttons });
    });

    const raw = await askWithMessages([
      { role: 'system', content: SELECTOR_MAP_GEN_PROMPT },
      { role: 'user', content: `HOSTNAME: ${hostname}\nGOAL: ${goal}\n\nPAGE STRUCTURE:\n${pageHtml}\n\nGenerate the selector map JSON:` },
    ], { temperature: 0.1, maxTokens: 1200, responseTimeoutMs: 20000 });

    const parsed = parseJson(raw);
    if (!parsed || !Array.isArray(parsed.fields) || parsed.fields.length === 0) {
      logger.warn(`[playwright.agent] selector map gen: no valid map generated`);
      return null;
    }
    logger.info(`[playwright.agent] selector map gen: ${parsed.fields.length} fields, ${parsed.submitSelectors?.length || 0} submit selectors`);
    return parsed;
  } catch (err) {
    logger.warn(`[playwright.agent] selector map gen error: ${err.message}`);
    return null;
  }
}

async function _extractFieldValues(goal) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: FIELD_EXTRACTION_PROMPT },
      { role: 'user', content: `GOAL: ${goal}\n\nExtract field values JSON:` },
    ], { temperature: 0.1, maxTokens: 600, responseTimeoutMs: 15000 });

    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      logger.warn(`[playwright.agent] field extraction: no valid JSON`);
      return null;
    }
    logger.info(`[playwright.agent] field extraction: ${Object.keys(parsed).join(', ')}`);
    return parsed;
  } catch (err) {
    logger.warn(`[playwright.agent] field extraction error: ${err.message}`);
    return null;
  }
}

// Verify a single field after typing (post-interaction verification)
async function _verifyField(page, field, expectedValue) {
  try {
    if (!field.verifySelector) return { ok: true, reason: 'no verifySelector' };

    if (field.verifyType === 'chip_count') {
      // For chip fields: check that at least one chip element exists
      const chipCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, field.verifySelector);
      if (chipCount > 0) {
        return { ok: true, reason: `chip_count=${chipCount}` };
      }
      return { ok: false, reason: 'no chips found after typing' };
    }

    if (field.verifyType === 'value') {
      const val = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.value : null;
      }, field.verifySelector);
      if (val && val.includes(expectedValue)) {
        return { ok: true, reason: `value matches` };
      }
      return { ok: false, reason: `value="${val}" expected to contain "${expectedValue}"` };
    }

    if (field.verifyType === 'innerText') {
      const text = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || '') : null;
      }, field.verifySelector);
      if (text && text.includes(expectedValue)) {
        return { ok: true, reason: 'innerText matches' };
      }
      return { ok: false, reason: `innerText does not contain expected value` };
    }

    // Default: just check element exists
    const exists = await page.evaluate((sel) => !!document.querySelector(sel), field.verifySelector);
    return { ok: exists, reason: exists ? 'element exists' : 'element not found' };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}

// Execute a selector map: type each field, verify, submit, verify submit
async function _executeSelectorMap(sessionId, fieldValues, selectorMap, timeoutMs) {
  const page = engine.getPage(sessionId);
  if (!page) return { ok: false, error: 'no engine page' };

  const transcript = [];
  const fieldTimeout = Math.min(timeoutMs, 15000);

  // Phase 1: Type each field and verify
  for (const field of selectorMap.fields) {
    const value = fieldValues[field.name];
    if (!value) {
      logger.info(`[playwright.agent] selector map: skipping field "${field.name}" — no value in goal`);
      continue;
    }

    let typed = false;
    for (const sel of field.selectors) {
      try {
        // Click to focus
        await page.click(sel, { timeout: fieldTimeout });

        // Detect chip/combobox field
        const isChip = field.type === 'chip';
        if (isChip) {
          await page.keyboard.type(value, { timeout: fieldTimeout });
          // Press Enter or Tab to confirm chip
          await page.keyboard.press('Enter');
        } else if (field.type === 'contenteditable') {
          // Select all and replace
          await page.keyboard.press('Meta+a');
          await page.keyboard.type(value, { timeout: fieldTimeout });
        } else {
          // input/textarea/select
          await page.keyboard.press('Meta+a');
          await page.keyboard.type(value, { timeout: fieldTimeout });
        }

        typed = true;
        logger.info(`[playwright.agent] selector map: typed "${field.name}" via "${sel}"`);
        transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: sel } });
        break;
      } catch (typeErr) {
        logger.warn(`[playwright.agent] selector map: field "${field.name}" selector "${sel}" failed: ${typeErr.message}`);
      }
    }

    if (!typed) {
      logger.warn(`[playwright.agent] selector map: all selectors failed for field "${field.name}"`);
      transcript.push({ action: { type: value }, outcome: { ok: false, field: field.name, error: 'all selectors failed' } });
      return { ok: false, error: `field "${field.name}" could not be typed`, transcript, failedField: field.name };
    }

    // Post-interaction verification
    if (field.verifySelector) {
      await new Promise(r => setTimeout(r, 300)); // brief settle
      const verifyResult = await _verifyField(page, field, value);
      if (!verifyResult.ok) {
        logger.warn(`[playwright.agent] selector map: field "${field.name}" verification failed: ${verifyResult.reason}`);
        transcript.push({ action: { verify: field.name }, outcome: { ok: false, reason: verifyResult.reason } });
        return { ok: false, error: `field "${field.name}" verification failed: ${verifyResult.reason}`, transcript, failedField: field.name };
      }
      logger.info(`[playwright.agent] selector map: field "${field.name}" verified — ${verifyResult.reason}`);
      transcript.push({ action: { verify: field.name }, outcome: { ok: true, reason: verifyResult.reason } });
    }
  }

  // Phase 2: Click submit
  let submitted = false;
  for (const sel of (selectorMap.submitSelectors || [])) {
    try {
      await page.click(sel, { timeout: fieldTimeout });
      submitted = true;
      logger.info(`[playwright.agent] selector map: submit clicked via "${sel}"`);
      transcript.push({ action: { click: sel }, outcome: { ok: true, intent: 'submit' } });
      break;
    } catch (clickErr) {
      logger.warn(`[playwright.agent] selector map: submit selector "${sel}" failed: ${clickErr.message}`);
    }
  }

  if (!submitted) {
    // Try Ctrl+Enter as fallback
    try {
      await page.keyboard.press('Control+Enter');
      submitted = true;
      logger.info(`[playwright.agent] selector map: submit via Ctrl+Enter`);
      transcript.push({ action: { press: 'Control+Enter' }, outcome: { ok: true, intent: 'submit' } });
    } catch (_) {}
  }

  if (!submitted) {
    return { ok: false, error: 'could not click any submit selector', transcript };
  }

  // Phase 3: Verify submit success
  if (selectorMap.submitVerify) {
    await new Promise(r => setTimeout(r, 1000)); // wait for submit to take effect
    const sv = selectorMap.submitVerify;

    if (sv.type === 'compose_gone') {
      // Check if compose dialog disappeared
      const composeGone = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const composeArea = document.querySelector('[aria-label*="Message Body" i], [aria-label*="Compose" i]');
        return !dialog && !composeArea;
      });
      if (composeGone) {
        logger.info(`[playwright.agent] selector map: submit verified — compose gone`);
        return { ok: true, transcript, result: 'Submitted (compose dialog closed)' };
      }
      // Check snackbar as fallback
      if (sv.pattern) {
        const bodyText = await page.evaluate(() => document.body.innerText);
        if (new RegExp(sv.pattern, 'i').test(bodyText)) {
          logger.info(`[playwright.agent] selector map: submit verified — snackbar pattern matched`);
          return { ok: true, transcript, result: 'Submitted (success message detected)' };
        }
      }
      return { ok: false, error: 'submit verification failed: compose still visible', transcript };
    }

    if (sv.type === 'snackbar' && sv.pattern) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (new RegExp(sv.pattern, 'i').test(bodyText)) {
        logger.info(`[playwright.agent] selector map: submit verified — snackbar matched`);
        return { ok: true, transcript, result: 'Submitted (success message detected)' };
      }
      return { ok: false, error: 'submit verification failed: no success message', transcript };
    }

    if (sv.type === 'url_change') {
      const currentUrl = await page.evaluate(() => location.href);
      if (isFormUrl(currentUrl)) {
        return { ok: false, error: 'submit verification failed: still on compose URL', transcript };
      }
      logger.info(`[playwright.agent] selector map: submit verified — URL changed`);
      return { ok: true, transcript, result: 'Submitted (URL changed)' };
    }
  }

  // No submit verification configured — assume success
  logger.info(`[playwright.agent] selector map: no submit verification configured — assuming success`);
  return { ok: true, transcript, result: 'Submitted (no verification configured)' };
}

// Main Tier 1.5 entry point: try cached map, or generate + cache new one
async function _deterministicSelectorPath(sessionId, url, goal, hostname, timeoutMs) {
  if (!isFormUrl(url)) return null;

  const pagePattern = derivePagePattern(url);
  logger.info(`[playwright.agent] Tier 1.5: checking selector map for ${hostname}:${pagePattern}`);

  // Try cached map first
  let selectorMap = await getSelectorMap(hostname, pagePattern);

  if (!selectorMap) {
    logger.info(`[playwright.agent] Tier 1.5: no cached map — generating via LLM`);
    const generated = await _generateSelectorMap(sessionId, hostname, goal, timeoutMs);
    if (!generated) return null; // fall through to Tier 2/3
    selectorMap = generated;
    // Cache it
    await saveSelectorMap(hostname, pagePattern, generated);
  }

  // Extract field values from goal
  const fieldValues = await _extractFieldValues(goal);
  if (!fieldValues || Object.keys(fieldValues).length === 0) {
    logger.warn(`[playwright.agent] Tier 1.5: could not extract field values from goal — falling back`);
    return null;
  }

  // Execute: type → verify → submit → verify
  const result = await _executeSelectorMap(sessionId, fieldValues, selectorMap, timeoutMs);

  if (result.ok) {
    await incrementSelectorMapSuccess(hostname, pagePattern);
    return {
      ok: true,
      goal,
      sessionId,
      turns: result.transcript.length,
      done: true,
      result: result.result || 'Completed via selector map',
      transcript: result.transcript,
      routingDecision: 'tier1_5_selector_map',
      executionTime: 0, // set by caller
    };
  }

  // Failure — increment failure count and fall through
  await incrementSelectorMapFailure(hostname, pagePattern);
  logger.warn(`[playwright.agent] Tier 1.5: selector map failed: ${result.error} — falling back to Tier 2/3`);

  // If the map was cached and failed, try regenerating once
  if (selectorMap.status === 'healthy' && selectorMap.failure_count === undefined) {
    logger.info(`[playwright.agent] Tier 1.5: attempting one-shot regeneration`);
    const regenerated = await _generateSelectorMap(sessionId, hostname, goal, timeoutMs);
    if (regenerated) {
      await saveSelectorMap(hostname, pagePattern, regenerated);
      const retryResult = await _executeSelectorMap(sessionId, fieldValues, regenerated, timeoutMs);
      if (retryResult.ok) {
        await incrementSelectorMapSuccess(hostname, pagePattern);
        return {
          ok: true,
          goal,
          sessionId,
          turns: retryResult.transcript.length,
          done: true,
          result: retryResult.result || 'Completed via regenerated selector map',
          transcript: retryResult.transcript,
          routingDecision: 'tier1_5_selector_map_regen',
          executionTime: 0,
        };
      }
      await incrementSelectorMapFailure(hostname, pagePattern);
    }
  }

  return null; // fall through to Tier 2/3
}

// Simple heuristic param extraction from goal text
function extractParamsFromGoal(goal) {
  const params = {};
  // Extract title (text in quotes or after "called/named/titled")
  const titleMatch = goal.match(/(?:called|named|titled)\s+["']([^"']+)["']/i) || goal.match(/["']([^"']{3,50})["']/);
  if (titleMatch) params.title = titleMatch[1];
  // Extract items (text after "with" or "containing" or listed items)
  const itemsMatch = goal.match(/(?:with|containing|including)\s+(.+)/i);
  if (itemsMatch) {
    const itemsText = itemsMatch[1];
    // Split by commas, "and", or numbered lists
    const items = itemsText.split(/,\s*|\s+and\s+|;\s*/).map(s => s.trim().replace(/^(?:\d+[.)]\s*|\[\]\s*)/, '')).filter(s => s.length > 0);
    if (items.length > 0) params.items = items;
  }
  // Extract message (for chat apps)
  const msgMatch = goal.match(/(?:send|say|ask|message|prompt)\s+["']([^"']+)["']/i) || goal.match(/(?:send|say|ask|message|prompt)\s+(.+)/i);
  if (msgMatch) params.message = msgMatch[1];
  return params;
}

function deriveActionFromGoal(goal) {
  const g = goal.toLowerCase();
  if (/create.*page.*todo|todo.*page|create.*todo/i.test(g)) return 'create_page_with_todos';
  if (/send.*message|new.*chat|ask/i.test(g)) return 'new_chat';
  if (/create.*page|new.*page/i.test(g)) return 'create_page';
  return 'auto_' + Date.now().toString(36);
}

function extractKeywordsFromGoal(goal) {
  return goal.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Phase 1: Extract service name from hostname
// ---------------------------------------------------------------------------
function serviceFromHostname(hostname) {
  if (!hostname) return null;
  // Strip TLD and subdomains: app.notion.com → notion, chatgpt.com → chatgpt
  const parts = hostname.split('.');
  // Handle co.uk, co.jp etc
  if (parts.length >= 3 && parts[parts.length - 2].length <= 3) {
    return parts[parts.length - 3];
  }
  if (parts.length >= 2) {
    return parts[parts.length - 2];
  }
  return hostname;
}

// ---------------------------------------------------------------------------
// Phase 11: VLM screenshot verification — calls /api/vision/verify on backend
// Reads screenshot file → base64 → POST to vision API → returns graded result
// ---------------------------------------------------------------------------
const _VLM_BACKEND_HOST = process.env.THINKDROP_BACKEND_HOST || '127.0.0.1';
const _VLM_BACKEND_PORT = parseInt(process.env.THINKDROP_BACKEND_PORT || '4000', 10);
const _VLM_TIMEOUT_MS = 20000;

function _vlmHttpPost(host, port, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: host,
      port,
      path: urlPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) {
          reject(new Error(`Invalid JSON from vision API: ${data.slice(0, 200)}`));
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Vision API request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function _vlmVerifyScreenshot(screenshotPath, goal, pageType) {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) return null;

  // Read screenshot file and convert to base64
  let base64;
  try {
    const buffer = fs.readFileSync(screenshotPath);
    base64 = buffer.toString('base64');
  } catch (err) {
    logger.warn(`[playwright.agent] VLM: failed to read screenshot file: ${err.message}`);
    return null;
  }

  // Resize large screenshots to reduce payload (max 1280px wide via sips on macOS)
  let effectiveBase64 = base64;
  let mimeType = 'image/png';
  try {
    const { execSync } = require('child_process');
    const tempResized = path.join(os.tmpdir(), `vlm_verify_${Date.now()}.jpg`);
    execSync(`sips -Z 1280 -s format jpeg "${screenshotPath}" --out "${tempResized}"`, { timeout: 5000 });
    if (fs.existsSync(tempResized)) {
      effectiveBase64 = fs.readFileSync(tempResized).toString('base64');
      mimeType = 'image/jpeg';
      try { fs.unlinkSync(tempResized); } catch (_) {}
    }
  } catch (_) { /* sips not available or failed — use original */ }

  // Construct verification prompt
  const verifyPrompt = `Verify whether this browser automation task was completed successfully.

TASK GOAL: ${goal}
PAGE TYPE: ${pageType}

Look at the screenshot and determine if the goal appears to have been achieved. For canvas apps (Notion, ChatGPT, etc.), check if the expected content is visible on the page. Respond with whether the task is complete and your confidence level.`;

  try {
    const result = await _vlmHttpPost(
      _VLM_BACKEND_HOST,
      _VLM_BACKEND_PORT,
      '/api/vision/verify',
      {
        screenshot: { base64: effectiveBase64, mimeType },
        prompt: verifyPrompt,
        stepDescription: `Automation goal: ${goal}`,
        context: { pageType, goal },
      },
      _VLM_TIMEOUT_MS
    );

    if (!result?.success) {
      logger.warn(`[playwright.agent] VLM: API returned failure: ${result?.error || 'unknown'}`);
      return null;
    }

    return {
      verified: result.verified,
      confidence: result.confidence || 0,
      reasoning: result.reasoning || '',
      suggestion: result.suggestion || '',
      provider: result.provider || 'unknown',
    };
  } catch (err) {
    logger.warn(`[playwright.agent] VLM: request failed (non-fatal): ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 8: Verification layer — eval check + screenshot after any tier
// ---------------------------------------------------------------------------
async function verifyTierCompletion(goal, pageType, routingDecision, script, sessionId, headed, timeoutMs) {
  const result = { pass: false, warn: false, fail: false, reason: '', screenshot: null, evalResults: [] };

  // 1. Eval check — run script verify block if available, otherwise goal-derived eval
  if (script && script.script_yaml && script.script_yaml.verify) {
    for (const vStep of script.script_yaml.verify) {
      if (vStep.eval) {
        try {
          const vRes = await browserAct({ action: 'evaluate', text: normalizeQuotesInEvalExpr(vStep.eval), sessionId, headed, timeoutMs: 5000 });
          const passed = vRes.ok && (vRes.result === 'true' || vRes.result === true);
          result.evalResults.push({ eval: vStep.eval, passed });
          if (!passed) {
            result.fail = true;
            result.reason = `Verify eval failed: ${vStep.eval} → ${vRes.result}`;
            logger.warn(`[playwright.agent] verification layer: eval fail — ${vStep.eval}`);
          }
        } catch (err) {
          result.evalResults.push({ eval: vStep.eval, passed: false, error: err.message });
          result.warn = true;
          result.reason = `Verify eval error: ${err.message}`;
        }
      }
    }
  } else {
    // Goal-derived eval: check if page text, document.title, and contenteditable
    // text contain expected keywords from goal. Combining all three signals is
    // critical for canvas/contenteditable apps (e.g. Google Docs) where the
    // document title lives in a separate input, not in document.body.innerText.
    try {
      const pageTextRes = await browserAct({ action: 'evaluate', text: 'document.body?.innerText?.slice(0, 2000) || ""', sessionId, headed, timeoutMs: 5000 });
      const pageText = pageTextRes.ok ? String(pageTextRes.result || '').toLowerCase() : '';

      // Also check document.title and first contenteditable element's text
      const _extraSignalsRes = await browserAct({ action: 'evaluate', text: `(() => {
        const parts = [];
        parts.push('title:' + (document.title || ''));
        const ce = document.querySelector('[contenteditable="true"]') || document.querySelector('[contenteditable]');
        if (ce) parts.push('ce:' + (ce.innerText || ce.textContent || '').slice(0, 500));
        const ariaTitleEl = document.querySelector('[aria-label*="title" i], [aria-label*="document" i]');
        if (ariaTitleEl) parts.push('aria:' + (ariaTitleEl.value || ariaTitleEl.innerText || ariaTitleEl.textContent || '').slice(0, 500));
        return parts.join('\\n');
      })()`, sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
      const _extraText = _extraSignalsRes.ok ? String(_extraSignalsRes.result || '').toLowerCase() : '';

      const goalKeywords = goal.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5);
      const matched = goalKeywords.filter(k => pageText.includes(k));
      const matchRatio = goalKeywords.length > 0 ? matched.length / goalKeywords.length : 0;

      // Check extra signals (document.title, contenteditable text, aria-label elements)
      const _extraMatched = goalKeywords.filter(k => _extraText.includes(k));
      const _extraMatchRatio = goalKeywords.length > 0 ? _extraMatched.length / goalKeywords.length : 0;

      // Combined signal: best ratio across all sources
      const _bestRatio = Math.max(matchRatio, _extraMatchRatio);
      const _bestMatched = _extraMatchRatio > matchRatio ? _extraMatched : matched;
      const _bestSource = _extraMatchRatio > matchRatio ? 'document.title/contenteditable' : 'page text';

      if (_bestRatio >= 0.4) {
        result.evalResults.push({ type: 'goal_keyword_match', ratio: _bestRatio, matched: _bestMatched, source: _bestSource });
        result.pass = true;
        result.reason = `Goal keyword match (${_bestSource}): ${_bestMatched.join(', ')} (${(_bestRatio * 100).toFixed(0)}%)`;
      } else if (_bestRatio > 0) {
        result.warn = true;
        result.reason = `Partial goal keyword match (${_bestSource}): ${_bestMatched.join(', ')} (${(_bestRatio * 100).toFixed(0)}%)`;
      } else {
        // For canvas apps, page text may not contain goal keywords (contenteditable)
        if (pageType === 'canvas' || pageType === 'hybrid') {
          result.warn = true;
          result.reason = `Canvas app — page text doesn't contain goal keywords (expected for contenteditable)`;
        } else {
          result.fail = true;
          result.reason = `No goal keywords found in page text, document.title, or contenteditable`;
        }
      }
    } catch (err) {
      result.warn = true;
      result.reason = `Goal-derived eval error: ${err.message}`;
    }
  }

  // 2. Screenshot capture (non-fatal — for debugging and future VLM grading)
  try {
    const screenshotRes = await browserAct({ action: 'screenshot', sessionId, headed, timeoutMs: 5000 });
    if (screenshotRes.ok && screenshotRes.result) {
      result.screenshot = screenshotRes.result;

      // Phase 11: VLM screenshot grading — especially for canvas apps where eval is insufficient
      // Only run VLM if eval was inconclusive (warn) or page is canvas/hybrid (eval unreliable)
      const _shouldVlm = result.warn || ((pageType === 'canvas' || pageType === 'hybrid') && !result.pass);
      if (_shouldVlm) {
        try {
          const _vlmResult = await _vlmVerifyScreenshot(screenshotRes.result, goal, pageType);
          if (_vlmResult) {
            result.vlm = _vlmResult;
            if (_vlmResult.verified === true) {
              // VLM says pass — upgrade from warn/fail to pass
              result.pass = true;
              result.fail = false;
              result.warn = false;
              result.reason = `VLM verified: ${_vlmResult.reasoning || 'screenshot matches goal'}`;
              logger.info(`[playwright.agent] verification layer: VLM PASS (confidence=${_vlmResult.confidence}, provider=${_vlmResult.provider})`);
            } else if (_vlmResult.verified === false) {
              // VLM says fail — downgrade to fail
              result.pass = false;
              result.fail = true;
              result.warn = false;
              result.reason = `VLM failed: ${_vlmResult.reasoning || 'screenshot does not match goal'}`;
              logger.warn(`[playwright.agent] verification layer: VLM FAIL (confidence=${_vlmResult.confidence}, provider=${_vlmResult.provider})`);
            }
            // verified === null means VLM was uncertain/unavailable — keep existing eval result
          }
        } catch (_vlmErr) {
          logger.warn(`[playwright.agent] verification layer: VLM error (non-fatal): ${_vlmErr.message}`);
        }
      }
    }
  } catch (_) {}

  // 3. If eval checks all passed and no fail, mark as pass
  if (!result.fail && !result.warn && result.evalResults.length > 0) {
    const allPassed = result.evalResults.every(r => r.passed);
    if (allPassed) {
      result.pass = true;
      result.reason = result.reason || 'All eval checks passed';
    }
  }

  // 4. If eval fail but no warn, mark fail
  if (result.fail && !result.warn) {
    result.pass = false;
  }

  logger.info(`[playwright.agent] verification layer: pass=${result.pass} warn=${result.warn} fail=${result.fail} reason="${result.reason}"`);
  return result;
}

// ---------------------------------------------------------------------------
// Script-URL fast path — deterministic compose-and-submit (no LLM needed)
// Called when URL matches a compose pattern and goal has extractable text.
// Uses Playwright Node API directly for speed (2-5s vs 30-120s LLM path).
// Returns a result object on success/failure, or null to fall through to LLM.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// OCR-based verification — uses screen-intelligence-service (screen.analyze)
// and user-memory-service (getRecentOcr) to verify what's visible on screen.
// Two-tier: getRecentOcr (free, may be stale) → screen.analyze (fresh, 2-5s).
// ---------------------------------------------------------------------------
async function _ocrVerify(expectText, typeTs) {
  const _expectSnippet = expectText.slice(0, 30).toLowerCase();
  const _composeIndicators = ['create a post', 'what do you want to talk about', 'start a post', 'write a post'];

  // Tier 1: Quick check getRecentOcr — maybe monitor already captured Chrome with our text
  try {
    const memHost = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
    const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const http = require('http');
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'user-memory',
      action: 'memory.getRecentOcr',
      payload: { maxAgeSeconds: 15 },
      context: { userId: 'local_user' }
    });
    const result = await new Promise((resolve) => {
      const req = http.request({ hostname: memHost, port: memPort, path: '/memory.getRecentOcr',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 3000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } }); });
      req.on('error', () => resolve({})); req.on('timeout', () => { req.destroy(); resolve({}); });
      req.write(body); req.end();
    });
    const capture = result?.data?.capture || result?.result?.capture;
    if (capture && capture.url && capture.url.includes('linkedin.com')) {
      const capturedAtTs = new Date(capture.capturedAt).getTime();
      const isFresh = capturedAtTs > typeTs;
      const ocrText = (capture.text || '').toLowerCase();
      const hasText = ocrText.includes(_expectSnippet);
      const hasModal = _composeIndicators.some(ind => ocrText.includes(ind));
      logger.info(`[playwright.agent] OCR verify (getRecentOcr): fresh=${isFresh} hasText=${hasText} hasModal=${hasModal} ocrLen=${ocrText.length} url=${capture.url}`);
      if (isFresh && hasText) {
        return { success: true, verified: true, hasText: true, hasModal, source: 'getRecentOcr' };
      }
    }
  } catch (e) { /* non-fatal — fall through to screen.analyze */ }

  // Tier 2: Fresh screen.analyze with overlay hidden
  try {
    const { hideOverlay, showOverlay } = require('./deprecated/overlayControl.cjs');
    const SCREEN_HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
    const SCREEN_PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
    const http = require('http');
    await hideOverlay();
    await new Promise(r => setTimeout(r, 80)); // wait for OS to composite
    try {
      const body = JSON.stringify({});
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: SCREEN_HOST, port: SCREEN_PORT, path: '/screen.analyze',
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 15000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } }); });
        req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('screen.analyze timeout')); });
        req.write(body); req.end();
      });
      if (!result?.success) return { success: false, error: result?.error || 'screen.analyze failed' };
      const text = (result.text || '').toLowerCase();
      const hasText = text.includes(_expectSnippet);
      const hasModal = _composeIndicators.some(ind => text.includes(ind));
      logger.info(`[playwright.agent] OCR verify (screen.analyze): hasText=${hasText} hasModal=${hasModal} app=${result.appName} url=${result.url} conf=${result.confidence} textLen=${text.length}`);
      return { success: true, verified: hasText, hasText, hasModal, source: 'screen.analyze' };
    } finally {
      await showOverlay();
    }
  } catch (e) {
    logger.warn(`[playwright.agent] OCR verify (screen.analyze) failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function _scriptUrlFastPath(sessionId, text, goal, startTs, deadline, heartbeat) {
  const page = engine.getPage(sessionId);
  if (!page) return null;

  const transcript = [];
  const MODAL_SEL = '[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]';

  // ── OCR-based fast path ──
  // Instead of polling for DOM compose elements (which fails because LinkedIn's
  // SPA dismisses modals and uses non-standard selectors), we:
  // 1. Wait 8s for the modal to load
  // 2. Type text via keyboard.type() (deterministic — types into focused element)
  // 3. Verify via OCR (getRecentOcr first, then screen.analyze with overlay hidden)
  // 4. If verified → return _textEntered:true → fall through to turn-loop for submit

  logger.info(`[playwright.agent] fast path: waiting 8s for modal to load`);
  await page.waitForTimeout(8000);

  let _textVerified = false;
  const MAX_TYPE_ATTEMPTS = 3;

  for (let _attempt = 1; _attempt <= MAX_TYPE_ATTEMPTS; _attempt++) {
    if (Date.now() > deadline) {
      logger.warn(`[playwright.agent] fast path: deadline exceeded during type retry loop`);
      break;
    }
    logger.info(`[playwright.agent] fast path: type attempt ${_attempt}/${MAX_TYPE_ATTEMPTS} via keyboard.type`);

    // Click center of modal (if visible) to ensure focus is in compose box
    try {
      const _modalBox = await page.locator(MODAL_SEL).last().boundingBox().catch(() => null);
      if (_modalBox) {
        await page.mouse.click(_modalBox.x + _modalBox.width / 2, _modalBox.y + 100);
        await page.waitForTimeout(200);
      } else {
        // No modal found via selector — click center of viewport as fallback
        const _vp = page.viewportSize();
        if (_vp) await page.mouse.click(_vp.width / 2, _vp.height / 3);
        await page.waitForTimeout(200);
      }
    } catch (_) {}

    // Clear any existing text (Cmd+A, Delete — works on macOS; Ctrl+A on other OS)
    await page.keyboard.press('Meta+A').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});

    // Type the text — keyboard.type types into whatever element has focus
    await page.keyboard.type(text, { delay: 5 });
    await page.waitForTimeout(1000);

    // ── OCR verify: is the typed text visible on screen? ──
    const _typeTs = Date.now();
    const _ocrResult = await _ocrVerify(text, _typeTs);
    if (_ocrResult.verified) {
      logger.info(`[playwright.agent] fast path: text verified via OCR (source=${_ocrResult.source}, hasModal=${_ocrResult.hasModal}) — falling through to turn-loop for submit`);
      _textVerified = true;
      transcript.push({ step: 1, action: { action: 'type', text: text.slice(0, 80) + '...' }, outcome: { ok: true }, thoughts: `fast path: keyboard.type attempt ${_attempt} verified via OCR (${_ocrResult.source})` });
      break;
    }
    logger.warn(`[playwright.agent] fast path: text not verified via OCR (attempt ${_attempt}) — retrying`);
    if (_attempt < MAX_TYPE_ATTEMPTS) await page.waitForTimeout(2000);
  }

  if (!_textVerified) {
    logger.warn(`[playwright.agent] fast path: could not type+verify via OCR after ${MAX_TYPE_ATTEMPTS} attempts — falling back to LLM`);
    transcript.push({ step: 1, action: { action: 'type' }, outcome: { ok: false, error: 'OCR verify failed' }, thoughts: 'fast path: all retries failed' });
    return null;
  }

  // Return _textEntered:true — tells playwrightAgent() to fall through to turn-loop
  // The turn-loop LLM will see the text is entered (via heartbeat + page state) and click "Post"
  const execTime = Date.now() - startTs;
  const result = {
    ok: true,
    _textEntered: true,
    goal,
    sessionId,
    turns: transcript.length,
    done: false, // not done — turn-loop still needs to click submit
    result: `Text entered via keyboard.type and verified via OCR — falling through to turn-loop for submit`,
    transcript,
    routingDecision: 'fast_path_ocr',
    executionTime: execTime,
  };

  logger.info(`[playwright.agent] fast path: text entered + OCR verified — returning _textEntered=true for turn-loop fallback (time=${execTime}ms)`);
  return result;
}

// ---------------------------------------------------------------------------
// Semantic plan validation guard — rejects plans that contradict the stated goal
// ---------------------------------------------------------------------------
function _validatePlanSemantics(goal, plan, planThoughts, currentUrl) {
  const _isSearchCountTask = /\b(count|find|check|list|how many|search|filter|unread|look\s*up)\b/i.test(goal);
  if (!_isSearchCountTask) return null;

  const _EXTRACT_ACTIONS = new Set(['run-code', 'getPageText', 'evaluate', 'return']);
  const _INPUT_ACTIONS = new Set(['fill', 'type', 'click', 'press']);

  const _urlHasSearchQuery = (() => {
    try {
      const u = new URL(currentUrl || '');
      const search = u.search + (u.hash || '');
      return /[?&#]search=|[?&#]q=|[?&#]query=|from:|is:unread|is:read|#search\//i.test(search);
    } catch { return false; }
  })();

  const _firstExtractIdx = plan.findIndex(s => _EXTRACT_ACTIONS.has(normalizeStep(s)?.action));
  const _firstInputIdx = plan.findIndex(s => {
    const a = normalizeStep(s)?.action;
    return _INPUT_ACTIONS.has(a);
  });

  if (_firstExtractIdx >= 0 && _firstInputIdx < 0 && !_urlHasSearchQuery) {
    return {
      violated: 'extraction_without_search',
      message: 'Plan extracts data before any search/filter interaction. For count/find/check tasks, you MUST first use the search/filter UI (fill search box → press Enter or click search) before extracting results. The current URL does not contain an active search query.',
    };
  }

  if (_firstExtractIdx >= 0 && _firstInputIdx >= 0 && _firstExtractIdx < _firstInputIdx && !_urlHasSearchQuery) {
    return {
      violated: 'extraction_before_search',
      message: 'Plan extracts data before the search/filter interaction. Move the search/filter steps (fill, press/click) before any extraction step.',
    };
  }

  const _thoughtsLower = String(planThoughts || '').toLowerCase();
  if (/search|filter|query/.test(_thoughtsLower)) {
    const _hasInputStep = plan.some(s => {
      const a = normalizeStep(s)?.action;
      return a === 'fill' || a === 'type' || (a === 'click' && /search|filter|submit/i.test(String(s.purpose || s.selector || '')));
    });
    if (!_hasInputStep && !_urlHasSearchQuery) {
      return {
        violated: 'thoughts_search_no_action',
        message: 'Plan thoughts mention search/filter but no step fills a search box or clicks a search button. Add a fill+press/click sequence to perform the search before extraction.',
      };
    }
  }

  // ── CSS selector ban for read/count tasks ──────────────────────────────────
  // run-code with site-internal CSS selectors (tr.zA, .zE, aria-label*="unread")
  // returns wrong counts when the DOM structure changes. Force getPageText instead.
  const _SITE_CSS_PATTERN = /\.(zA|zE|yX|bog|bqe|zF|y2|xW)\b|aria-label\s*\*\s*=\s*["']unread/i;
  for (const step of plan) {
    const _norm = normalizeStep(step);
    if (!_norm) continue;
    if (_norm.action === 'run-code' && typeof step.code === 'string') {
      if (_SITE_CSS_PATTERN.test(step.code)) {
        return {
          violated: 'brittle_css_selector',
          message: 'Plan uses run-code with site-internal CSS selectors (e.g. tr.zA, .zE, .yX, aria-label*="unread") for a read/count task. These selectors break across UI updates and return wrong counts. Use { "action": "getPageText" } instead — it captures all visible text reliably without site-specific CSS.',
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Canonical redirect detection — prevents double-navigation when a shortcut URL
// (e.g. notion.new) has already redirected to the final URL (e.g. app.notion.com/<page-id>).
// Returns true if currentUrl is a canonical redirect from targetUrl.
// ---------------------------------------------------------------------------
function _isCanonicalRedirect(targetUrl, currentUrl) {
  if (!targetUrl || !currentUrl) return false;
  try {
    const _t = new URL(targetUrl);
    const _c = new URL(currentUrl);
    // Exact match is trivially canonical
    if (_t.hostname === _c.hostname && _t.pathname === _c.pathname) return true;

    // *.new shortcut domains (e.g., notion.new, docs.new, sheets.new)
    // These redirect to the brand's main domain (notion.new → app.notion.com/<page-id>).
    // BUT: existing pages on the same domain (e.g. app.notion.com/p/Yearly-Goals-<id>)
    // must NOT be treated as canonical redirects — only fresh pages with raw IDs or
    // "Untitled" slugs qualify.
    if (_t.hostname.endsWith('.new') || _t.hostname === 'new') {
      const _brand = _t.hostname.split('.').slice(-2, -1)[0]; // "notion" from "notion.new"
      if (!_brand || !_c.hostname.includes(_brand)) return false;
      // Check the last path segment for a readable slug
      const _lastSegment = _c.pathname.split('/').pop() || '';
      const _slugParts = _lastSegment.split('-');
      const _hasReadableSlug = _slugParts.length >= 2
        && /^[a-z]{4,}$/i.test(_slugParts[0])
        && _slugParts[0].toLowerCase() !== 'untitled';
      if (_hasReadableSlug) {
        // Existing page with a human-readable title in the URL — NOT a fresh redirect
        return false;
      }
      // Path looks like a raw ID or "Untitled" — treat as canonical redirect
      return true;
    }

    // Regular URLs: same hostname + deeper path = canonical (e.g. /create → /document/d/<id>)
    if (_t.hostname === _c.hostname && _c.pathname.length > _t.pathname.length) {
      return true;
    }

    // Same base domain (last 2 labels), different hostname (e.g. mail.google.com → accounts.google.com)
    const _tBase = _t.hostname.split('.').slice(-2).join('.');
    const _cBase = _c.hostname.split('.').slice(-2).join('.');
    if (_tBase === _cBase && _t.hostname !== _c.hostname) {
      return true;
    }

    return false;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Script-Generation Mode — injection-first execution for compose/post/form tasks
//
// Instead of Plan-Execute (one snapshot → one plan → blind execution), this mode
// asks the LLM to generate a single run-code script that programmatically
// completes the task using the React-aware action types (reactFill, clickByText,
// clickBySelector). The script includes waitForElement guards and deterministic
// verification after each sub-step.
//
// Falls through to Plan-Execute on failure.
// ---------------------------------------------------------------------------

const SCRIPT_GEN_SYSTEM_PROMPT = `You are a browser automation expert. Generate a SINGLE JavaScript function that completes the user's task.

You have access to the Playwright page object AND helper functions. Your function receives page and must return a result string.

AVAILABLE HELPER FUNCTIONS (call these directly as regular function calls - they are Node-side functions that close over page and internally call page.evaluate() for DOM manipulation. Do NOT wrap them inside page.evaluate() - call them directly.):

  reactFill(selector, text, clearFirst=true)
    - Sets text on React-controlled inputs/textareas (native setter + input event)
      AND contenteditable divs (focus + execCommand insertText).
      Use for compose boxes, post textareas, message inputs.
      ALWAYS prefer this over page.keyboard.type() for setting known text.
      selector = CSS selector (e.g. '[role="textbox"]', 'textarea[name="body"]')
      Returns { ok, method, verified, actualValue }

  clickByText(text, tag=null, exact=false, scope=null)
    - Clicks a visible element matching visible text (case-insensitive substring).
      Use for buttons whose text is stable: "Post", "Send", "Submit", "Tweet".
      tag = optional tag filter ('button', 'a'); exact = require exact match.
      scope = optional CSS selector to limit search to a container (e.g. '[role="dialog"]').
      Returns { ok, clickedText, tag, matchCount }

  clickBySelector(selector, force=false)
    - Clicks by CSS selector directly. Bypasses ref resolution.
      Use when a stable CSS selector is known.
      Returns { ok, result, method? }

  waitForElement(selector, timeoutMs=10000)
    - Polls until selector exists in DOM. Use before interacting with modals/dynamic content.
      Returns { ok, error? }

CORRECT example (call helpers directly):
  async page => {
    await waitForElement('[role="textbox"]', 5000);
    const result = await reactFill('[role="textbox"]', 'Hello world!');
    if (!result.verified) throw new Error('Text not set');
    await clickByText('Post', 'button', true, '[role="dialog"]');
    return 'Posted successfully';
  }

WRONG (helpers are NOT available inside page.evaluate - they are Node-side):
  async page => {
    await page.evaluate(() => {
      reactFill(...)  // ReferenceError! reactFill is not in browser scope
    });
  }

PATTERN FOR COMPOSE/POST TASKS:
  1. waitForElement for the compose box selector
  2. reactFill to set the text content
  3. Verify the text was set (check return.verified or query the element)
  4. clickByText or clickBySelector to click the submit button
  5. Verify submission (modal closed, URL changed, or success message appeared)
  6. return a result string

CRITICAL RULES:
- Call helper functions DIRECTLY - do NOT wrap them inside page.evaluate().
- Use REAL CSS selectors - NOT Playwright pseudo-selectors.
  SAFE: '[role="textbox"]', 'textarea[name="body"]', 'div[contenteditable="true"]', 'button[type="submit"]'
  FORBIDDEN: :has-text(), :text(), :contains(), :visible
- For contenteditable compose boxes (LinkedIn, Twitter, Facebook), use reactFill with
  selector '[role="textbox"], div[contenteditable="true"]'.
- For submit buttons inside modals, use clickByText with scope='[role="dialog"]' to
  avoid matching buttons outside the modal (e.g. "Repost" on the feed).
- The function signature MUST be: async page => { ... return "result string"; }
- Keep the script focused - do NOT add navigation steps (the URL-first path already navigated).
- If an element might not be ready, wrap in waitForElement first.
- Return a human-readable result string describing what happened.

Output ONLY the JavaScript function, no markdown fences, no explanation.`;

// ---------------------------------------------------------------------------
// Script-Gen Helper Injection
//
// The LLM generates `async page => { reactFill(...); clickByText(...); ... }`,
// but run-code evals that function in Node.js scope where reactFill/clickByText
// don't exist. This wrapper injects Node-side helper definitions that close over
// `page` and internally call page.evaluate() with the browser-side DOM code.
// The browser-side code is identical to the action handlers in browser.act.cjs.
// ---------------------------------------------------------------------------

// Browser-side code for reactFill (runs inside page.evaluate)
const _REACT_FILL_BROWSER_FN = `({ selector, text, clearFirst }) => {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, error: 'Element not found: ' + selector };

  // Path 1: <input> / <textarea> — native setter + input event
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'INPUT'
      ? window.HTMLInputElement.prototype
      : window.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, clearFirst ? text : (el.value + text));
    } else {
      el.value = clearFirst ? text : (el.value + text);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    const actual = el.value || '';
    return { ok: true, method: 'native-setter', verified: actual.includes(text), actualValue: actual.slice(0, 200) };
  }

  // Path 2: contenteditable — focus + execCommand insertText
  if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('role') === 'textbox') {
    el.focus();
    if (clearFirst) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete');
    }
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted) {
      el.dispatchEvent(new InputEvent('beforeinput', {
        data: text, inputType: 'insertText', bubbles: true, cancelable: true,
      }));
      el.dispatchEvent(new InputEvent('input', {
        data: text, inputType: 'insertText', bubbles: true,
      }));
      if (!el.textContent || el.textContent.length === 0) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const actual = el.textContent || el.innerText || '';
    return { ok: true, method: 'contenteditable', verified: actual.includes(text), actualValue: actual.slice(0, 200) };
  }

  // Path 3: unknown element type — textContent fallback
  el.focus();
  if (clearFirst) el.textContent = '';
  el.textContent = (clearFirst ? '' : (el.textContent || '')) + text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const actual = el.textContent || '';
  return { ok: true, method: 'textcontent-fallback', verified: actual.includes(text), actualValue: actual.slice(0, 200) };
}`;

// Browser-side code for clickByText (runs inside page.evaluate)
const _CLICK_BY_TEXT_BROWSER_FN = `({ text, tag, exact, scope }) => {
  const lower = text.toLowerCase();
  const candidates = [];
  const baseSelector = tag ? tag.toLowerCase() : 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], div, span';
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return { ok: false, error: 'Scope element not found: ' + scope };
  const els = Array.from(root.querySelectorAll(baseSelector));
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const elText = (el.innerText || el.textContent || '').trim();
    if (!elText) continue;
    const isExact = elText.toLowerCase() === lower;
    const isSub = elText.toLowerCase().includes(lower);
    if (exact ? isExact : isSub) candidates.push({ el, text: elText, len: elText.length, isExact });
  }
  if (candidates.length === 0) return { ok: false, error: 'No visible element with text "' + text + '"' };
  // Sort: exact match first, then button/submit, then shortest length
  candidates.sort((a, b) => {
    if (a.isExact && !b.isExact) return -1;
    if (!a.isExact && b.isExact) return 1;
    const aIsButton = a.el.tagName === 'BUTTON' || a.el.getAttribute('role') === 'button' || (a.el.tagName === 'INPUT' && (a.el.type === 'submit' || a.el.type === 'button'));
    const bIsButton = b.el.tagName === 'BUTTON' || b.el.getAttribute('role') === 'button' || (b.el.tagName === 'INPUT' && (b.el.type === 'submit' || b.el.type === 'button'));
    if (aIsButton && !bIsButton) return -1;
    if (!aIsButton && bIsButton) return 1;
    return a.len - b.len;
  });
  const target = candidates[0].el;
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  target.click();
  return { ok: true, clickedText: candidates[0].text, tag: target.tagName, matchCount: candidates.length };
}`;

// Build the wrapped script with injected helper functions.
// Takes the LLM-generated `async page => { ... }` code, extracts the body,
// and wraps it with Node-side helper definitions that close over `page`.
function _buildScriptGenWrapper(llmCode) {
  // Extract the body from `async page => { ... }`, `async (page) => { ... }`,
  // or `async function(page) { ... }` / `async function (page) { ... }`
  let body = llmCode;
  // Match any of the supported function signatures
  const sigMatch = body.match(/^async\s+(?:\(\s*page\s*\)|page)\s*=>\s*\{/) ||
                   body.match(/^async\s+function\s*\(\s*page\s*\)\s*\{/);
  if (sigMatch) {
    const startIdx = sigMatch[0].length - 1; // index of the opening `{`
    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx > startIdx) {
      body = body.slice(startIdx + 1, endIdx);
    }
    // If brace matching failed, just strip the signature and use the rest
    else {
      body = body.replace(/^async\s+(?:\(\s*page\s*\)|page)\s*=>\s*\{/, '')
                 .replace(/^async\s+function\s*\(\s*page\s*\)\s*\{/, '')
                 .replace(/\}\s*$/, '');
    }
  }

  // Build the wrapped function with injected helpers
  return `async page => {
  // === AUTO-INJECTED HELPERS (close over page) ===
  const _REACT_FILL_FN = ${_REACT_FILL_BROWSER_FN};
  async function reactFill(selector, text, clearFirst = true) {
    return await page.evaluate(_REACT_FILL_FN, { selector, text, clearFirst });
  }
  const _CLICK_BY_TEXT_FN = ${_CLICK_BY_TEXT_BROWSER_FN};
  async function clickByText(text, tag = null, exact = false, scope = null) {
    return await page.evaluate(_CLICK_BY_TEXT_FN, { text, tag, exact, scope });
  }
  async function clickBySelector(selector, force = false) {
    if (force) {
      return await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Element not found: ' + sel };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, method: 'eval-click' };
      }, selector);
    }
    try {
      await page.click(selector, { timeout: 5000 });
      return { ok: true, method: 'playwright-click' };
    } catch (e) {
      // Fallback: eval-click
      return await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, error: 'Element not found: ' + sel };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { ok: true, method: 'eval-click' };
      }, selector);
    }
  }
  async function waitForElement(selector, timeoutMs = 10000) {
    try {
      await page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  // === USER SCRIPT BODY BELOW ===
${body}
}`;
}

// Detect whether a task is a compose/post/form task suitable for script-generation.
function _isInjectionCandidate(goal, probeResult) {
  if (!goal) return false;
  const _goalLower = goal.toLowerCase();
  // Compose/post/share/tweet/publish tasks
  const _composePatterns = [
    /\bpost\b/, /\bshare\b/, /\btweet\b/, /\bpublish\b/, /\bcompose\b/,
    /\bsend\s+(?:a\s+)?(?:email|mail|message)\b/, /\bwrite\s+(?:a\s+)?(?:email|message|post|tweet)\b/,
    /\bsubmit\b/, /\bcreate\s+(?:a\s+)?(?:post|update|tweet|message)\b/,
    /\bupdate\b.*\b(?:post|share|status)\b/,
  ];
  const _isCompose = _composePatterns.some(re => re.test(_goalLower));
  // Form submission tasks
  const _isForm = /\bfill\s+(?:out|in)\s+(?:the\s+)?form|\bsubmit\s+(?:the\s+)?form\b/.test(_goalLower);
  // Modal/compose element present in probe
  const _hasComposeElement = probeResult?.hasContentEditable || probeResult?.hasRoleTextbox ||
    probeResult?.hasTextarea || probeResult?.hasComposeInModal || probeResult?.hasModalDialog;
  return _isCompose || _isForm || (_hasComposeElement && /\b(?:type|write|enter|fill)\b/.test(_goalLower));
}

// Execute the script-generation mode.
// Returns { ok, result, script } on success, or { ok: false, error } on failure (caller falls through).
async function _executeScriptGeneration({ goal, sessionId, headed, timeoutMs, agentContext, probeResult, pageStudy, deadline }) {
  const _start = Date.now();
  logger.info(`[playwright.agent] script-gen: starting for goal="${goal.slice(0, 80)}"`);

  // Build a lightweight page context for the LLM (probe data + key selectors)
  const _probeBlock = probeResult
    ? `PAGE PROBE:
- contentEditable elements: ${probeResult.contentEditableCount || 0}
- role=textbox elements: ${probeResult.roleTextboxCount || 0}
- textarea elements: ${probeResult.textareaCount || 0}
- text inputs: ${probeResult.textInputCount || 0}
- modal dialog open: ${probeResult.hasModalDialog || false}
- compose element in modal: ${probeResult.hasComposeInModal || false}
- active element editable: ${probeResult.activeElementEditable || false}
- active element tag: ${probeResult.activeElementTag || 'unknown'}
- buttons on page: ${probeResult.buttonCount || 0}`
    : 'PAGE PROBE: unavailable';

  // Try to extract key selectors from the page for the LLM
  let _selectorHints = '';
  try {
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      const _hints = await _ePage.evaluate(() => {
        const hints = [];
        // Compose boxes
        const compose = document.querySelector('[role="textbox"], div[contenteditable="true"], textarea[name="body"], textarea[name="message"]');
        if (compose) {
          const sel = compose.getAttribute('role') === 'textbox'
            ? '[role="textbox"]'
            : compose.tagName === 'TEXTAREA'
              ? `textarea[name="${compose.name || 'body'}"]`
              : 'div[contenteditable="true"]';
          hints.push(`COMPOSE_BOX: ${sel}`);
        }
        // Submit buttons (by text)
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const submitBtn = buttons.find(b => {
          const t = (b.innerText || b.textContent || '').trim().toLowerCase();
          return /^(post|send|submit|tweet|publish|share|reply|comment)$/i.test(t);
        });
        if (submitBtn) {
          hints.push(`SUBMIT_BUTTON_TEXT: "${(submitBtn.innerText || submitBtn.textContent || '').trim()}"`);
        }
        // Modal presence
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (modal) hints.push('MODAL_OPEN: true');
        return hints.join('\n');
      }).catch(() => '');
      if (_hints) _selectorHints = `\nSELECTOR HINTS (from live DOM):\n${_hints}`;
    }
  } catch (_) { /* non-fatal */ }

  const _userContent = `GOAL: ${goal}

${_probeBlock}${_selectorHints}
${pageStudy ? `\nPAGE ANALYSIS:\n- Page type: ${pageStudy.pageType || 'unknown'}\n- Key elements: ${JSON.stringify((pageStudy.keyElements || []).slice(0, 8))}` : ''}
${agentContext ? `\nAGENT CONTEXT:\n${agentContext}` : ''}

Generate the JavaScript function to complete this task:`;

  let _scriptRaw;
  try {
    _scriptRaw = await askWithMessages([
      { role: 'system', content: SCRIPT_GEN_SYSTEM_PROMPT },
      { role: 'user', content: _userContent },
    ], { temperature: 0.1, maxTokens: 1200, responseTimeoutMs: 30000 });
  } catch (_llmErr) {
    logger.warn(`[playwright.agent] script-gen: LLM call failed: ${_llmErr.message}`);
    return { ok: false, error: `script-gen LLM error: ${_llmErr.message}` };
  }

  if (!_scriptRaw || _scriptRaw.trim().length < 20) {
    logger.warn(`[playwright.agent] script-gen: empty or too-short LLM response`);
    return { ok: false, error: 'script-gen: empty LLM response' };
  }

  // Extract the function from the response (strip markdown fences if present)
  let _scriptCode = _scriptRaw.trim();
  const _fenceMatch = _scriptCode.match(/```(?:javascript|js)?\s*\n?([\s\S]*?)\n?```/);
  if (_fenceMatch) _scriptCode = _fenceMatch[1].trim();
  // Ensure it starts with async page =>
  if (!/^async\s+page\s*=>/.test(_scriptCode) && !/^async\s+function\s*\(\s*page\s*\)/.test(_scriptCode)) {
    // Try to extract just the function part
    const _fnMatch = _scriptCode.match(/(async\s+page\s*=>\s*\{[\s\S]*\})/);
    if (_fnMatch) {
      _scriptCode = _fnMatch[1];
    } else {
      logger.warn(`[playwright.agent] script-gen: LLM response is not a valid async function — falling through`);
      return { ok: false, error: 'script-gen: invalid function format' };
    }
  }

  // Wrap the LLM script with injected helper functions (reactFill, clickByText, etc.)
  // so they're in scope when run-code evals the function in Node.js context.
  const _wrappedCode = _buildScriptGenWrapper(_scriptCode);
  logger.info(`[playwright.agent] script-gen: generated ${_scriptCode.length} chars (wrapped: ${_wrappedCode.length} chars), executing...`);

  // Execute the script via browserAct run-code
  let _execResult;
  try {
    _execResult = await browserAct({
      action: 'run-code',
      code: _wrappedCode,
      sessionId,
      headed,
      timeoutMs: Math.min(timeoutMs * 4, 60000), // scripts need more time
    });
  } catch (_execErr) {
    logger.warn(`[playwright.agent] script-gen: execution threw: ${_execErr.message}`);
    return { ok: false, error: `script-gen execution error: ${_execErr.message}`, script: _scriptCode };
  }

  if (!_execResult.ok) {
    logger.warn(`[playwright.agent] script-gen: execution failed: ${_execResult.error || 'unknown'}`);
    return { ok: false, error: _execResult.error || 'script-gen execution failed', script: _scriptCode };
  }

  const _result = String(_execResult.result || _execResult.stdout || '').slice(0, 2000);
  logger.info(`[playwright.agent] script-gen: succeeded in ${Date.now() - _start}ms — result="${_result.slice(0, 100)}"`);

  // Deterministic post-execution verification: check if the goal was likely achieved
  // by probing for common success indicators (modal closed, success text, etc.)
  let _verified = false;
  try {
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      const _verifyResult = await _ePage.evaluate(() => {
        // Modal closed = success for compose/post tasks
        const _modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!_modal) return { verified: true, reason: 'modal closed' };
        // Success toast/message
        const _successText = document.body?.innerText?.match(/posted|shared|sent|published|submitted/i);
        if (_successText) return { verified: true, reason: `success text: ${_successText[0]}` };
        return { verified: false, reason: 'modal still open and no success text' };
      }).catch(() => null);
      if (_verifyResult) {
        _verified = _verifyResult.verified;
        logger.info(`[playwright.agent] script-gen: deterministic verify=${_verified} (${_verifyResult.reason})`);
      }
    }
  } catch (_) { /* non-fatal */ }

  return {
    ok: true,
    result: _result,
    script: _scriptCode,
    verified: _verified,
    routingDecision: 'script_gen',
    executionTime: Date.now() - _start,
  };
}

// ---------------------------------------------------------------------------
// Turn Loop Fallback — observe→act→verify recovery when Plan-Execute fails
//
// When the Plan-Execute repair limit is reached, instead of immediately surfacing
// ask_user, run a lightweight turn loop: take a fresh snapshot, ask the LLM for
// ONE action (from the injection action vocabulary), execute it, verify, repeat.
// Max 8 turns. Uses the new reactFill/clickByText/clickBySelector actions for
// deterministic interaction.
// ---------------------------------------------------------------------------

const TURN_LOOP_SYSTEM_PROMPT = `You are a browser automation agent recovering from a failed plan. The previous plan failed partway. You are now in a turn-by-turn mode: output ONE action per turn, observe the result, then output the next.

AVAILABLE ACTIONS (injection-first - prefer these over snapshot-ref actions):
  reactFill       { "action": "reactFill", "selector": "[role='textbox']", "text": "..." }
                  - Sets text on React-controlled inputs/contenteditable. PREFERRED for compose boxes.
                    Uses native setter + event dispatch to trigger React state updates.
  clickByText     { "action": "clickByText", "text": "Post", "tag": "button", "exact": true, "scope": "[role='dialog']" }
                  - Click by visible button text. PREFERRED for submit buttons.
                    Use scope to limit search to a container (e.g. modal) to avoid wrong matches.
  clickBySelector { "action": "clickBySelector", "selector": "button[type='submit']" }
                  - Click by CSS selector directly.
  waitForElement  { "action": "waitForSelector", "selector": "..." }
                  - Wait for an element to appear.
  snapshot        { "action": "snapshot" }
                  - Re-read the page if you need to see updated state. RARELY needed.
  navigate        { "action": "navigate", "url": "..." }
                  - Only if you're on the wrong page.
  return          { "action": "return", "data": "result summary" }
                  - When the goal is achieved. MUST be the last action.

RULES:
- Output ONE action per turn as JSON: { "action": "...", ... }
- DO NOT output snapshot unless you need to reassess. Snapshot wastes a turn.
- If the goal involves typing, use reactFill FIRST. Do NOT wait or snapshot first.
- If the goal involves clicking a button, use clickByText FIRST.
- Use reactFill for compose boxes (NOT type or fill - those depend on focus state).
- Use clickByText for submit buttons (NOT click with refs - refs may be stale).
- For submit buttons inside modals, use scope='[role="dialog"]' to avoid matching
  buttons outside the modal (e.g. "Repost" on a feed when you want "Post" in the modal).
- After each action, you'll see the result. Adapt based on what happened.
- When the goal is achieved, output { "action": "return", "data": "what you did" }.
- The ARIA snapshot may NOT show contenteditable elements. If the PAGE TEXT or PROBE
  shows a compose box (contenteditable=true, role=textbox), use reactFill with the
  indicated selector even if it's not in the ARIA snapshot.

Output ONLY the JSON action object, no markdown, no explanation.`;

async function _executeTurnLoopFallback({ goal, sessionId, headed, timeoutMs, agentContext, transcript, deadline, start, extractedText, heartbeat, textAlreadyEntered }) {
  const MAX_TURNS = 12;
  const _loopTranscript = [...transcript];
  logger.info(`[playwright.agent] turn-loop fallback: starting (max ${MAX_TURNS} turns) for goal="${goal.slice(0, 80)}"`);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      logger.warn(`[playwright.agent] turn-loop: deadline exceeded at turn ${turn}`);
      break;
    }

    // ── Observe: take a fresh snapshot + page text + probe ──
    const _snap = await _fastSnapshot(sessionId, headed, timeoutMs);
    let _currentSnapshot = '';
    if (_snap.ok && _snap.result) {
      _currentSnapshot = _snap.result;
    }
    const _prunedSnap = pruneSnapshot(extractInteractiveRefs(_currentSnapshot));

    // Get visible page text (ARIA snapshot may not show contenteditable elements)
    let _pageText = '';
    try {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        _pageText = await _ePage.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
      }
    } catch (_) {}

    // Get probe data for compose elements
    let _probeInfo = '';
    try {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const _probe = await _ePage.evaluate(() => {
          // Iterate ALL dialogs — querySelector returns the first (may be hidden video.js)
          const _modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
          let _hasVisibleModal = false;
          let _hasModal = false;
          for (const m of _modals) {
            _hasModal = true;
            if (m.getAttribute('aria-hidden') === 'true') continue;
            if (m.classList.contains('vjs-hidden')) continue;
            const rect = m.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) _hasVisibleModal = true;
          }
          // Check for compose element inside a VISIBLE modal only
          let _composeInVisibleModal = false;
          if (_hasVisibleModal) {
            for (const m of _modals) {
              if (m.getAttribute('aria-hidden') === 'true') continue;
              if (m.classList.contains('vjs-hidden')) continue;
              const rect = m.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                if (m.querySelector('[contenteditable="true"], [role="textbox"], textarea')) {
                  _composeInVisibleModal = true;
                  break;
                }
              }
            }
          }
          return {
            hasContentEditable: document.querySelector('[contenteditable="true"]') !== null,
            hasRoleTextbox: document.querySelector('[role="textbox"]') !== null,
            hasTextarea: document.querySelector('textarea') !== null,
            hasModal: _hasVisibleModal,  // only count visible modals
            hasAnyModal: _hasModal,  // for debugging
            composeInModal: _composeInVisibleModal,
            activeElementTag: document.activeElement?.tagName || 'unknown',
            activeElementEditable: document.activeElement?.isContentEditable || false,
            activeElementRole: document.activeElement?.getAttribute('role') || null,
          };
        }).catch(() => null);
        if (_probe) {
          const _composeSel = _probe.hasContentEditable ? 'div[contenteditable="true"]'
            : _probe.hasRoleTextbox ? '[role="textbox"]'
            : _probe.hasTextarea ? 'textarea' : null;
          _probeInfo = `PAGE PROBE:
- Modal open: ${_probe.hasModal}
- Contenteditable: ${_probe.hasContentEditable}
- Role textbox: ${_probe.hasRoleTextbox}
- Textarea: ${_probe.hasTextarea}
- Compose in modal: ${_probe.composeInModal}
- Active element: <${_probe.activeElementTag}> editable=${_probe.activeElementEditable} role=${_probe.activeElementRole}
${_composeSel ? `- SUGGESTED COMPOSE SELECTOR: ${_composeSel}` : ''}`;
        }
      }
    } catch (_) {}

    // Build action history summary (last 5 actions)
    const _recentActions = _loopTranscript.slice(-5).map((t, i) => {
      const a = t.action?.action || 'unknown';
      const ok = t.outcome?.ok ? 'ok' : 'FAIL';
      const err = t.outcome?.error ? ` (${t.outcome.error.slice(0, 60)})` : '';
      return `${i + 1}. ${a} -> ${ok}${err}`;
    }).join('\n');

    // ── Check if we're already on the target page ──
    // If so, inject a "DO NOT NAVIGATE" note so the LLM doesn't waste turns
    // re-navigating to the same URL (which reloads the page and dismisses modals).
    let _onTargetPage = false;
    try {
      const _curUrl = await _engineEval(sessionId, 'window.location.href');
      if (_curUrl?.ok) {
        const _cur = String(_curUrl.result).trim().replace(/^"|"$/g, '');
        const _urlMatch = goal.match(/https?:\/\/[^\s"')]+/);
        if (_urlMatch) {
          // Compare base URL (strip query params and hash)
          const _targetBase = _urlMatch[0].replace(/[?#].*$/, '').replace(/\/$/, '');
          const _curBase = _cur.replace(/[?#].*$/, '').replace(/\/$/, '');
          if (_curBase === _targetBase || _cur.startsWith(_targetBase)) {
            _onTargetPage = true;
          }
        }
      }
    } catch (_) {}

    // ── Strip "Navigate to..." prefix from goal ──
    // The goal often starts with "Navigate to the LinkedIn homepage..." — the LLM
    // sees this as step 1 and keeps navigating. Strip it so the LLM focuses on the
    // actual task (type, click, etc.).
    const _actionGoal = goal
      .replace(/^.*?Navigate to .*?(?:homepage|page|site|dashboard|feed|inbox)\b[^.]*\.\s*/i, '')
      .replace(/^.*?Open (?:LinkedIn|Twitter|Gmail|ChatGPT|Claude|Bluesky|Threads|Facebook|Instagram)\b[^.]*\.\s*/i, '')
      .replace(/^.*?Go to (?:LinkedIn|Twitter|Gmail|ChatGPT|Claude|Bluesky|Threads|Facebook|Instagram)\b[^.]*\.\s*/i, '')
      .trim();
    // If stripping removed everything, use the original goal
    const _effectiveGoal = _actionGoal.length > 10 ? _actionGoal : goal;

    // ── Build turn prompt ──
    const _heartbeatHistory = heartbeat ? heartbeat.getHistoryString(10) : '';
    // Build selector hints based on what the heartbeat detected
    let _selectorHints = '';
    if (heartbeat && heartbeat.buffer.length > 0) {
      const _hasPostBtn = heartbeat.buffer.some(t => t.postButtonCount > 0);
      const _hasAriaPost = heartbeat.buffer.some(t => t.ariaPostEls && t.ariaPostEls.length > 0);
      const _lastWithCompose = heartbeat.getLastComposeTick();
      if (_hasPostBtn || _hasAriaPost || _lastWithCompose) {
        const _hints = [];
        if (_lastWithCompose && _lastWithCompose.composeDetails[0]) {
          const c = _lastWithCompose.composeDetails[0];
          if (c.ariaLabel) _hints.push(`reactFill { "action": "reactFill", "selector": "[aria-label='${c.ariaLabel}']", "text": "<TEXT>" }`);
          if (c.role) _hints.push(`reactFill { "action": "reactFill", "selector": "[role='${c.role}']", "text": "<TEXT>" }`);
          if (c.ce) _hints.push(`reactFill { "action": "reactFill", "selector": "[contenteditable='${c.ce}']", "text": "<TEXT>" }`);
        }
        if (_hasAriaPost) {
          const _ariaLabels = [...new Set(heartbeat.buffer.flatMap(t => (t.ariaPostEls || []).map(e => e.label)))].slice(0, 3);
          for (const label of _ariaLabels) {
            _hints.push(`clickBySelector { "action": "clickBySelector", "selector": "[aria-label='${label}']" }`);
          }
        }
        if (_hasPostBtn) {
          const _btnTexts = [...new Set(heartbeat.buffer.flatMap(t => t.postButtonTexts || []))].slice(0, 3);
          for (const text of _btnTexts) {
            _hints.push(`clickByText { "action": "clickByText", "text": "${text}" }`);
          }
        }
        // Always include generic fallbacks
        _hints.push(`clickBySelector { "action": "clickBySelector", "selector": "button[aria-label*='post' i]" }`);
        _hints.push(`clickByText { "action": "clickByText", "text": "Post" }`);
        _hints.push(`clickByText { "action": "clickByText", "text": "Write a post" }`);
        _hints.push(`clickByText { "action": "clickByText", "text": "Create a post" }`);
        _selectorHints = `\nSELECTOR HINTS (based on heartbeat detection — try these):\n${_hints.map(h => '  ' + h).join('\n')}\n`;
      }
    }
    const _turnUser = `GOAL: ${_effectiveGoal}
${agentContext ? `\nAGENT CONTEXT:\n${agentContext}` : ''}
${_onTargetPage ? '\n⚠️ YOU ARE ALREADY ON THE CORRECT PAGE. DO NOT navigate. Start typing or clicking NOW.\n' : ''}
${textAlreadyEntered ? '\n✅ TEXT ALREADY ENTERED via keyboard.type and verified via OCR. Do NOT type again. Just click the submit/Post button NOW.\n' : ''}
${extractedText && !textAlreadyEntered ? `\n📝 TEXT TO TYPE (use this EXACT text in reactFill): "${extractedText}"\n` : ''}
${_probeInfo ? _probeInfo + '\n' : ''}
${_heartbeatHistory ? `\nPAGE STATE HISTORY (last ${Math.min(10, heartbeat.buffer.length)} heartbeat ticks, oldest first — use this to see what appeared/disappeared on the page):\n${_heartbeatHistory}\n` : ''}
${_selectorHints}
VISIBLE PAGE TEXT (first 2000 chars):
${_pageText.slice(0, 2000)}

CURRENT SNAPSHOT (ARIA - may not show contenteditable elements):
${_prunedSnap}

${_recentActions ? `RECENT ACTIONS:\n${_recentActions}\n` : ''}
Turn ${turn}/${MAX_TURNS}. What is your next action? (DO NOT snapshot - act directly)`;

    let _actionRaw;
    try {
      _actionRaw = await askWithMessages([
        { role: 'system', content: TURN_LOOP_SYSTEM_PROMPT },
        { role: 'user', content: _turnUser },
      ], { temperature: 0.1, maxTokens: 400, responseTimeoutMs: 20000 });
    } catch (_llmErr) {
      logger.warn(`[playwright.agent] turn-loop: LLM call failed at turn ${turn}: ${_llmErr.message}`);
      break;
    }

    // Parse the action
    let _action = null;
    if (_actionRaw) {
      try {
        const _m = _actionRaw.match(/\{[\s\S]*\}/);
        if (_m) _action = JSON.parse(_m[0]);
      } catch (_) { /* parse error */ }
    }

    if (!_action || !_action.action) {
      logger.warn(`[playwright.agent] turn-loop: unparseable action at turn ${turn}: ${(_actionRaw || '').slice(0, 100)}`);
      _loopTranscript.push({ action: { action: 'parse_error' }, outcome: { ok: false, error: 'unparseable' } });
      continue;
    }

    logger.info(`[playwright.agent] turn-loop turn ${turn}/${MAX_TURNS}: action=${_action.action}`);

    // ── Done check ──
    if (_action.action === 'return') {
      const _result = String(_action.data || '').slice(0, 2000);
      logger.info(`[playwright.agent] turn-loop: done at turn ${turn} — result="${_result.slice(0, 100)}"`);
      return {
        ok: true,
        goal,
        sessionId,
        turns: _loopTranscript.length,
        done: true,
        result: _result || 'Completed via turn-loop fallback',
        transcript: _loopTranscript,
        routingDecision: 'turn_loop_fallback',
        executionTime: Date.now() - start,
      };
    }

    // ── Anti-repeat: skip duplicate actions ──
    // If the last action was the same type and succeeded, skip this one.
    // This prevents the LLM from navigating 12 times to the same URL.
    if (_loopTranscript.length > 0) {
      const _last = _loopTranscript[_loopTranscript.length - 1];
      if (_last.action?.action === _action.action && _last.outcome?.ok) {
        // For navigate: skip if same URL
        if (_action.action === 'navigate' && _last.action?.url === _action.url) {
          logger.warn(`[playwright.agent] turn-loop: skipping duplicate navigate to ${_action.url} — already done`);
          _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate navigate' } });
          continue;
        }
        // For snapshot: skip if last was also snapshot
        if (_action.action === 'snapshot') {
          logger.warn(`[playwright.agent] turn-loop: skipping duplicate snapshot`);
          _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate snapshot' } });
          continue;
        }
      }
    }

    // ── Execute the action ──
    let _outcome;
    try {
      _outcome = await browserAct({ ..._action, sessionId, headed, timeoutMs });
    } catch (_execErr) {
      _outcome = { ok: false, error: _execErr.message };
    }

    _loopTranscript.push({ action: _action, outcome: _outcome });

    if (!_outcome.ok) {
      logger.warn(`[playwright.agent] turn-loop: action ${_action.action} failed at turn ${turn}: ${_outcome.error}`);
      // Continue to next turn — the loop will reassess from a fresh snapshot
    } else {
      logger.info(`[playwright.agent] turn-loop: action ${_action.action} succeeded at turn ${turn}`);
      // Invalidate snapshot cache after DOM-mutating actions
      const _domMutating = ['reactFill', 'clickByText', 'clickBySelector', 'click', 'fill', 'type', 'navigate', 'press'].includes(_action.action);
      if (_domMutating) {
        invalidateEngineSnapshot(sessionId);
      }

      // ── Wait for page to stabilize after navigate ──
      // Navigating reloads the page, which dismisses modals and resets SPA state.
      // Wait for networkidle + a short settle delay so the next snapshot sees the
      // settled page (with modal/compose element if applicable).
      if (_action.action === 'navigate') {
        try {
          const _page = engine.getPage(sessionId);
          if (_page) {
            logger.info(`[playwright.agent] turn-loop: waiting for page to stabilize after navigate`);
            await _page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await _page.waitForTimeout(2000);  // SPA settle time
          }
        } catch (_) {}
      }
    }
  }

  // Max turns reached without completion
  logger.warn(`[playwright.agent] turn-loop: reached max turns (${MAX_TURNS}) without completing`);
  return {
    ok: false,
    goal,
    sessionId,
    turns: _loopTranscript.length,
    done: false,
    result: `Turn-loop fallback exhausted (${MAX_TURNS} turns) without completing the goal`,
    transcript: _loopTranscript,
    error: 'turn_loop_exhausted',
    routingDecision: 'turn_loop_fallback',
    executionTime: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Page Heartbeat — continuous page state capture (inspired by monitorService.js tick())
// Runs a setInterval every 2s, captures lightweight page state into a rolling buffer.
// The buffer is fed to the turn-loop LLM so it can see the TIMELINE of page changes
// (e.g., "modal appeared at t=3, dismissed at t=5") instead of a single snapshot.
// The fast path also checks the buffer to detect compose elements that appeared
// and disappeared during polling.
// ---------------------------------------------------------------------------
class _PageHeartbeat {
  constructor(sessionId, intervalMs = 2000, maxTicks = 15) {
    this.sessionId = sessionId;
    this.intervalMs = intervalMs;
    this.maxTicks = maxTicks;
    this.buffer = [];
    this.intervalId = null;
    this.tickCount = 0;
  }

  start() {
    if (this.intervalId) return;
    this._tick().catch(() => {});
    this.intervalId = setInterval(() => this._tick().catch(() => {}), this.intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async _tick() {
    const page = engine.getPage(this.sessionId);
    if (!page) return;
    this.tickCount++;
    const _tickNum = this.tickCount;
    try {
      const state = await page.evaluate(() => {
        // Broadened modal detection — LinkedIn may use various selectors
        const modals = Array.from(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"], ' +
          '[class*="modal"][class*="share"], [class*="compose"][class*="modal"], .share-creation, ' +
          '#interop-outlet > div, [aria-labelledby*="share"], [aria-labelledby*="compose"]'
        ));
        const visibleModals = modals.filter(m => {
          if (m.getAttribute('aria-hidden') === 'true') return false;
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const composeEls = Array.from(document.querySelectorAll(
          '[contenteditable], .ql-editor, [role="textbox"], [role="combobox"], [role="searchbox"], textarea, input[type="text"], input[type="search"]'
        ));
        const visibleCompose = composeEls.filter(el => {
          if (el.getAttribute('aria-hidden') === 'true') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const postButtons = Array.from(document.querySelectorAll(
          'button, [role="button"], a[role="button"]'
        )).filter(b => {
          const r = b.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const text = (b.innerText || b.textContent || '').toLowerCase().trim();
          return /^(start a post|post|share|compose|create.*post|write.*post)\b/.test(text);
        });
        const ariaPostEls = Array.from(document.querySelectorAll('[aria-label]')).filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          return /\b(post|compose|write|share|what.*mind)\b/.test(label);
        }).slice(0, 5).map(el => ({
          tag: el.tagName,
          label: el.getAttribute('aria-label'),
          role: el.getAttribute('role'),
          ce: el.getAttribute('contenteditable'),
        }));
        return {
          t: 0, // placeholder — set by caller (page.evaluate can't access outer scope)
          url: window.location.href.slice(0, 100),
          bodyLen: (document.body?.innerText || '').length,
          modalCount: modals.length,
          visibleModalCount: visibleModals.length,
          modalTexts: visibleModals.slice(0, 2).map(m => (m.innerText || '').slice(0, 150)),
          composeCount: composeEls.length,
          visibleComposeCount: visibleCompose.length,
          composeDetails: visibleCompose.slice(0, 3).map(el => ({
            tag: el.tagName,
            ce: el.getAttribute('contenteditable'),
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'),
          })),
          postButtonCount: postButtons.length,
          postButtonTexts: postButtons.slice(0, 3).map(b => (b.innerText || '').trim().slice(0, 50)),
          ariaPostEls,
        };
      });
      state.t = _tickNum;
      this.buffer.push(state);
      if (this.buffer.length > this.maxTicks) this.buffer.shift();
      // Log summary on every tick
      const _summary = `modals=${state.visibleModalCount} compose=${state.visibleComposeCount} postBtns=${state.postButtonCount} bodyLen=${state.bodyLen}`;
      // Log full details on first 3 ticks and when state changes
      const _prev = this.buffer[this.buffer.length - 2];
      const _changed = !_prev || _prev.visibleModalCount !== state.visibleModalCount ||
        _prev.visibleComposeCount !== state.visibleComposeCount || _prev.postButtonCount !== state.postButtonCount ||
        _prev.bodyLen !== state.bodyLen;
      if (this.tickCount <= 3 || _changed) {
        logger.info(`[playwright.agent] heartbeat tick ${_tickNum} DETAIL: ${JSON.stringify({
          postButtonTexts: state.postButtonTexts,
          ariaPostEls: state.ariaPostEls,
          composeDetails: state.composeDetails,
          modalTexts: state.modalTexts,
          url: state.url,
          modalCount: state.modalCount,
        })}`);
      }
      logger.info(`[playwright.agent] heartbeat tick ${_tickNum}: ${_summary}`);
    } catch (e) {
      // Non-fatal — page may be navigating
    }
  }

  getHistoryString(maxTicks = 10) {
    if (this.buffer.length === 0) return '';
    const ticks = this.buffer.slice(-maxTicks);
    const lines = ticks.map(t => {
      const parts = [`t=${t.t}: modals=${t.visibleModalCount} compose=${t.visibleComposeCount} postBtns=${t.postButtonCount} bodyLen=${t.bodyLen}`];
      if (t.visibleModalCount > 0 && t.modalTexts[0]) parts.push(`  modal: "${t.modalTexts[0].slice(0, 100)}"`);
      if (t.visibleComposeCount > 0 && t.composeDetails[0]) {
        const c = t.composeDetails[0];
        parts.push(`  compose: <${c.tag}> ce=${c.ce} role=${c.role} label="${c.ariaLabel || c.placeholder || ''}"`);
      }
      if (t.postButtonCount > 0) parts.push(`  postButtons: ${JSON.stringify(t.postButtonTexts)}`);
      if (t.ariaPostEls.length > 0) parts.push(`  ariaPostEls: ${JSON.stringify(t.ariaPostEls)}`);
      return parts.join('\n');
    });
    return lines.join('\n');
  }

  sawComposeElement() {
    return this.buffer.some(t => t.visibleComposeCount > 0);
  }

  getLastComposeTick() {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].visibleComposeCount > 0) return this.buffer[i];
    }
    return null;
  }
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
    maxRepairs            = 2,
    timeoutMs             = 15000,
    headed                = true,
    url,
    recipeWasUsed         = false,
    authConfirmedAt       = null,
    overallTimeoutMs      = 120000,
    _progressCallbackUrl,
    _stepIndex            = 0,
  } = args || {};

  const start = Date.now();
  const _deadline = start + overallTimeoutMs;
  function _checkDeadline() {
    if (Date.now() > _deadline) {
      logger.warn(`[playwright.agent] overall timeout (${overallTimeoutMs}ms) exceeded — aborting`);
      throw new Error(`Overall timeout (${overallTimeoutMs}ms) exceeded`);
    }
  }

  if (!goal) {
    return { ok: false, error: 'goal is required', executionTime: 0 };
  }

  logger.info(`[playwright.agent] start goal="${goal}" session=${sessionId} maxRepairs=${maxRepairs}`);

  // Start page heartbeat — continuous page state capture for LLM context
  const _heartbeat = new _PageHeartbeat(sessionId, 1000, 30);
  _heartbeat.start();

  const transcript = [];
  let finalResult = null; // set by a 'return' step if present

  // ── Failure → askUser helper ──────────────────────────────────────────────
  // Surfaces a hard failure as an agent-aware ask_user so the user can either
  // retry, train from the current page, or train from the beginning. Keeps the
  // browser session alive so "train from current page" can attach to it.
  // Mirrors the goal-judge askUser shape (see ~line 5379) so executeCommand and
  // main.js route free-text answers through the _isAgentAskUser resume path
  // (re-running the SAME agent step with [Resume context: Q&A]) instead of
  // treating the answer as a brand-new task.
  function _failureAskUser(reason) {
    return {
      ok: false,
      askUser: true,
      trainingHandoff: true,
      question: `I wasn't able to complete this step automatically.\n\nReason: ${reason}\n\nWhat would you like to do? You can also type what went wrong and I'll retry with your correction.`,
      options: [
        { label: 'Try again', value: 'try_again' },
        { label: 'Correct and retry (tell me what was missed)', value: 'correct_and_retry' },
        { label: 'Record recipe from beginning', value: 'record_recipe' },
      ],
      goal,
      agentId,
      sessionId,
      // Keep the session alive so train-from-current-page can attach.
      keepSession: true,
      executionTime: Date.now() - start,
    };
  }

  // ── Pre-navigation (engine fast path first, CLI fallback) ──────────────────
  if (url) {
    // Check if browser is already on the target URL — browser.agent may have already
    // navigated there during the auth probe. Skip redundant re-navigation to avoid
    // a full page reload (~8s saved) and preserve page state.
    let _alreadyOnTarget = false;
    try {
      const _engineUrlRes = await _engineEval(sessionId, 'window.location.href');
      if (_engineUrlRes?.ok && _engineUrlRes.result) {
        const _curUrl = String(_engineUrlRes.result).trim().replace(/^"|"$/g, '');
        const _normCur = _curUrl.replace(/\/+$/, '').split('?')[0];
        const _normTarget = url.replace(/\/+$/, '').split('?')[0];
        if (_normCur === _normTarget) {
          _alreadyOnTarget = true;
          logger.info(`[playwright.agent] already on target URL ${_curUrl} — skipping redundant navigation`);
        } else if (_isCanonicalRedirect(url, _curUrl)) {
          _alreadyOnTarget = true;
          logger.info(`[playwright.agent] on canonical redirect of target URL — ${_curUrl} (target=${url}) — skipping redundant navigation`);
        }
      } else if (_engineUrlRes === null) {
        // Engine is not active — do NOT fall back to CLI evaluate, which would
        // launch a CLI Chrome with the same profile and conflict with the engine
        // launch in navigate(). Just proceed to navigate which will start the engine.
        logger.info(`[playwright.agent] engine not active for URL pre-check — skipping CLI fallback to avoid profile conflict`);
      } else {
        // Engine is active but eval failed — CLI fallback is safe (engine already holds the profile)
        if (!_alreadyOnTarget) {
          const _curUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 });
          if (_curUrlRes?.ok && _curUrlRes?.result) {
            const _curUrl = String(_curUrlRes.result).trim().replace(/^"|"$/g, '');
            const _normCur = _curUrl.replace(/\/+$/, '').split('?')[0];
            const _normTarget = url.replace(/\/+$/, '').split('?')[0];
            if (_normCur === _normTarget) {
              _alreadyOnTarget = true;
              logger.info(`[playwright.agent] already on target URL ${_curUrl} — skipping redundant navigation`);
            } else if (_isCanonicalRedirect(url, _curUrl)) {
              _alreadyOnTarget = true;
              logger.info(`[playwright.agent] on canonical redirect of target URL — ${_curUrl} (target=${url}) — skipping redundant navigation`);
            }
          }
        }
      }
    } catch (_) {}

    if (!_alreadyOnTarget) {
      logger.info(`[playwright.agent] navigating to: ${url}`);
      // Engine fast path: direct page.goto() — no subprocess
      const _engineNav = await _engineNavigate(sessionId, url, Math.max(timeoutMs, 30000));
      if (!_engineNav?.ok) {
        // CLI fallback
        const navResult = await browserAct({ action: 'navigate', sessionId, url, headed, timeoutMs: Math.max(timeoutMs, 30000) });
        if (!navResult.ok) {
          return {
            ok: false, goal, sessionId, turns: 0, done: false,
            result: `Failed to navigate to starting URL: ${navResult.error}`,
            transcript: [], error: navResult.error, executionTime: Date.now() - start,
          };
        }
      }
    }
  }

  // ── Script-URL fast path: compose-and-submit tasks (no LLM needed) ──────────
  // When the URL matches a compose pattern AND the goal contains text to post/type,
  // execute a deterministic type → submit → verify-network flow (2-5s) instead of
  // the full snapshot → LLM plan → execute loop (30-120s).
  let _composerModalOpen = false;  // set by fast path when modal opened but no compose element
  let _extractedComposeText = null;  // set by fast path text extraction (for turn-loop fallback)
  let _textAlreadyEntered = false;  // set by fast path when text was typed + OCR verified (turn-loop just needs to click submit)
  if (url && engine.isSessionActive(sessionId)) {
    const _composeRe = /shareActive=true|compose\/post|compose=new|\/compose\b|posting\?compose=true/i;
    if (_composeRe.test(url)) {
      // Gmail multi-field compose is handled by Tier 1.5 selector map (below).
      // The single-text fast path cannot handle it.
      if (/mail\.google\.com.*compose=new/.test(url)) {
        logger.info(`[playwright.agent] Script-URL fast path: skipping Gmail multi-field compose — Tier 1.5 selector map will handle`);
      } else {
        // Extract the text to type from the goal.
        // Strategy: find the LAST quoted string in the goal — the post text is
        // always at the end (e.g., "...with the text: 'Thank you to my amazing team...'")
        // The old regex `goal.match(/["'](.{3,5000})["']/)` was greedy and matched
        // from the first quote ('Start a post') to the last quote, capturing
        // everything in between — including button labels and navigation instructions.
        let _composeText = null;
        const _allQuotes = [...goal.matchAll(/["']([^"']{3,5000})["']/g)].map(m => m[1]);
        if (_allQuotes.length > 0) {
          // Use the last quoted string — it's the actual post text
          _composeText = _allQuotes[_allQuotes.length - 1].trim();
        } else {
          // Fallback: text after "post:" / "type:" / "write:" / "share:"
          const _textMatch = goal.match(/(?:post|type|write|share)[:\s]+(.{3,5000})$/i);
          if (_textMatch) _composeText = _textMatch[1].trim();
        }
        if (_composeText) {
          logger.info(`[playwright.agent] Script-URL fast path: compose URL detected + text extracted (${_composeText.length} chars) — deterministic flow`);
          // Store extracted text for turn-loop fallback (in case fast path fails)
          _extractedComposeText = _composeText;
          try {
            const _fastResult = await _scriptUrlFastPath(sessionId, _composeText, goal, start, _deadline, _heartbeat);
            if (_fastResult && _fastResult._textEntered) {
              // Text was entered + OCR verified — fall through to turn-loop for submit
              _textAlreadyEntered = true;
              logger.info(`[playwright.agent] Script-URL fast path: text entered + OCR verified — falling through to turn-loop for submit click`);
            } else if (_fastResult && !_fastResult._modalOpenNoCompose) {
              _heartbeat.stop(); return _fastResult;
            } else {
              // If fast path returns null or _modalOpenNoCompose, fall through to normal LLM flow.
              // _modalOpenNoCompose signals the modal IS open but no compose element was found —
              // the LLM should NOT click "Start a post" (handled by the compose-open note below).
              if (_fastResult?._modalOpenNoCompose) {
                _composerModalOpen = true;  // flag for the planning note
              }
              logger.info(`[playwright.agent] Script-URL fast path: could not complete — falling back to LLM plan${_fastResult?._modalOpenNoCompose ? ' (modal is open)' : ''}`);
            }
          } catch (_fastErr) {
            logger.warn(`[playwright.agent] Script-URL fast path error (non-fatal): ${_fastErr.message} — falling back to LLM plan`);
          }
        }
      }
    }
  }

  // ── Phase 1: Wait for redirect to settle, then for SPA to stabilise ──────
  // page.goto() with waitUntil:'domcontentloaded' already handles HTTP redirects.
  // JS-based redirects (e.g. notion.new → notion.so/...) need a short settle.
  // Reduced from 15×1s polls to 3×500ms — domcontentloaded covers most cases.
  if (url) {
    let _prevHref = '';
    let _hrefStable = false;
    for (let _i = 0; _i < 3; _i++) {
      _checkDeadline();
      // Engine fast path for URL check
      const _engineHrefRes = await _engineEval(sessionId, 'window.location.href');
      let _curHref = '';
      if (_engineHrefRes?.ok && _engineHrefRes.result) {
        _curHref = String(_engineHrefRes.result).trim().replace(/^"|"$/g, '');
      } else {
        const _hrefRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
        _curHref = _hrefRes?.ok ? String(_hrefRes.result || '').replace(/^"|"$/g, '') : '';
      }
      if (_curHref && _curHref === _prevHref) {
        _hrefStable = true;
        logger.info(`[playwright.agent] phase 1: redirect settled on ${_curHref} after ${_i + 1} check(s)`);
        break;
      }
      _prevHref = _curHref;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!_hrefStable) {
      logger.warn(`[playwright.agent] phase 1: redirect did not stabilize after 1.5s — proceeding with current page`);
    }
    logger.info(`[playwright.agent] phase 1: waiting for page to stabilise before snapshot`);
    await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
  }
  logger.info(`[playwright.agent] phase 1: snapshot`);
  const initSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
  let currentSnapshot = (initSnap.ok && initSnap.result) ? initSnap.result : '';
  let _activeElementInfo = initSnap.activeElement || null;

  // Compute hostname from the actual post-navigation browser URL.
  // This handles shortcut domains (e.g. notion.new → app.notion.com) generically —
  // no hardcoded mapping needed, we just read where the browser ended up.
  let hostname = null;
  if (url) {
    try {
      // Engine fast path for hostname
      const _engineHostRes = await _engineEval(sessionId, 'window.location.hostname');
      if (_engineHostRes?.ok && _engineHostRes.result) {
        hostname = String(_engineHostRes.result).trim().replace(/^"|"$/g, '').replace(/^www\./, '').toLowerCase();
      }
      if (!hostname) {
        const navResult = await browserAct({ action: 'evaluate', text: 'window.location.hostname', sessionId, headed, timeoutMs: 5000 });
        if (navResult.ok && navResult.result) {
          hostname = String(navResult.result).replace(/^www\./, '').toLowerCase();
        }
      }
    } catch (_) { /* fall back to URL-derived hostname */ }
    if (!hostname) {
      try { hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
      catch (_) { /* hostname stays null */ }
    }
  }
  const domainLockBlock = hostname
    ? `\n\nDOMAIN LOCK — ABSOLUTE:\nYou are automating '${hostname}'. NEVER navigate to any external site (not Google, Bing, DuckDuckGo, or anywhere outside ${hostname}). Any navigate step MUST stay on '${hostname}'.`
    : '';

  // ── Verify gate: deterministic checks before any routing/planning ──────────
  // Ensures the page is actually loaded and on the right domain before we
  // attempt Tier 1.5/2/2.5/3. Prevents planning against about:blank or broken pages.
  if (url && hostname) {
    let _verifyOk = false;
    let _verifyRetry = false;
    try {
      const _vgUrl = await _engineEval(sessionId, 'window.location.href');
      const _vgTextLen = await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText.length : 0)');
      const _vgActualUrl = _vgUrl?.ok ? String(_vgUrl.result).trim().replace(/^"|"$/g, '') : '';
      const _vgTextNum = _vgTextLen?.ok ? Number(_vgTextLen.result) : 0;

      if (/about:blank/i.test(_vgActualUrl)) {
        logger.warn(`[playwright.agent] verify gate: page is about:blank — navigating back to ${url}`);
        _verifyRetry = true;
      } else if (_vgTextNum < 100) {
        logger.warn(`[playwright.agent] verify gate: page has ${_vgTextNum} chars of text — waiting for stabilisation`);
        _verifyRetry = true;
      } else {
        // Check hostname match (or canonical redirect from target URL)
        try {
          const _vgHost = new URL(_vgActualUrl).hostname.replace(/^www\./, '').toLowerCase();
          if (_vgHost !== hostname && !_vgHost.endsWith('.' + hostname) && !hostname.endsWith('.' + _vgHost)
              && !_isCanonicalRedirect(url, _vgActualUrl)) {
            logger.warn(`[playwright.agent] verify gate: hostname mismatch — expected ${hostname}, got ${_vgHost}`);
            _verifyRetry = true;
          } else {
            _verifyOk = true;
            logger.info(`[playwright.agent] verify gate: OK (host=${_vgHost}, textLen=${_vgTextNum})`);
          }
        } catch (_) {
          _verifyOk = true; // URL parse failed — don't block on this
        }
      }

      if (_verifyRetry) {
        // Recovery: navigate back to start URL, wait for stabilisation, re-check
        const _engineNav = await _engineNavigate(sessionId, url, Math.max(timeoutMs, 30000));
        if (!_engineNav?.ok) {
          await browserAct({ action: 'navigate', url, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) }).catch(() => {});
        }
        await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 10000 }).catch(() => {});
        // Re-check
        const _vgUrl2 = await _engineEval(sessionId, 'window.location.href');
        const _vgTextLen2 = await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText.length : 0)');
        const _vgActualUrl2 = _vgUrl2?.ok ? String(_vgUrl2.result).trim().replace(/^"|"$/g, '') : '';
        const _vgTextNum2 = _vgTextLen2?.ok ? Number(_vgTextLen2.result) : 0;

        if (/about:blank/i.test(_vgActualUrl2) || _vgTextNum2 < 100) {
          logger.error(`[playwright.agent] verify gate: page still broken after recovery — aborting`);
          return {
            ok: false, goal, sessionId,
            turns: 0, done: false,
            result: `Page verification failed — could not load ${url}`,
            error: `Verify gate: page is about:blank or empty after recovery attempt`,
            transcript: [],
            executionTime: Date.now() - start,
          };
        }
        // Re-snapshot after recovery
        const _vgSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
        if (_vgSnap.ok && _vgSnap.result) currentSnapshot = _vgSnap.result;
        logger.info(`[playwright.agent] verify gate: recovered after re-navigation (textLen=${_vgTextNum2})`);
      }
    } catch (_vgErr) {
      logger.warn(`[playwright.agent] verify gate error (non-fatal): ${_vgErr.message} — proceeding`);
    }
  }

  // ── Tier 1.5: Deterministic selector map for form/compose URLs ──────────────
  // After URL-first navigation + waitForStableText, try cached or LLM-generated
  // selector map for type→verify→submit→verify. Falls through to Tier 2/3 on failure.
  if (url && hostname && engine.isSessionActive(sessionId)) {
    try {
      const _curUrl = await _engineEval(sessionId, 'window.location.href');
      const _actualUrl = _curUrl?.ok ? String(_curUrl.result).trim().replace(/^"|"$/g, '') : url;
      if (isFormUrl(url) || isFormUrl(_actualUrl)) {
        logger.info(`[playwright.agent] Tier 1.5: form URL detected (url=${url} actualUrl=${_actualUrl}) — trying deterministic selector map`);
        const _tier15Result = await _deterministicSelectorPath(sessionId, url, goal, hostname, timeoutMs);
        if (_tier15Result) {
          _tier15Result.executionTime = Date.now() - start;
          return _tier15Result;
        }
        logger.info(`[playwright.agent] Tier 1.5: selector map did not complete — falling through to Tier 2/3`);
      }
    } catch (_tier15Err) {
      logger.warn(`[playwright.agent] Tier 1.5 error (non-fatal): ${_tier15Err.message} — falling through`);
    }
  }

  // ── Tier 1.7: Focus-aware fast-path (no LLM for simple goals) ──────────────
  // When URL-first navigation already focused the primary input (Gmail compose body,
  // ChatGPT prompt, LinkedIn compose area), and the goal is a simple single-action
  // (post a message, ask a question, search for X), skip the LLM plan entirely:
  // type → find submit button → click → verify. Saves 5-15s of LLM plan generation.
  try {
    const _tier17Snap = await _fastSnapshot(sessionId, headed, timeoutMs);
    const _activeEl = _tier17Snap?.activeElement;
    if (_activeEl && _activeEl.isPrimaryInput) {
      logger.info(`[playwright.agent] Tier 1.7: activeElement is primary input (tag=${_activeEl.tag}, type=${_activeEl.type}, placeholder="${_activeEl.placeholder}") — checking if goal is simple single-action`);

      // Extract the text payload from the goal — strip action verbs and service context
      // to find the actual content to type. This is intentionally conservative: only
      // trigger for goals that look like "post: <text>", "ask <AI> about <text>", "search for <text>"
      const _goalLower = goal.toLowerCase();
      const _isSimpleGoal = !/\bto\s+[\w.+-]+@|subject|recipient|cc|bcc|attach|file|upload\b/i.test(goal) &&
        (/\b(post|share|update|tweet|send|write|say|ask|tell|search|query|look\s+up|find|message)\b/i.test(_goalLower));

      if (_isSimpleGoal) {
        // Extract text payload: remove leading action verbs and service names
        let _textPayload = goal
          .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:I\s+want\s+to\s+|I'd\s+like\s+to\s+)?/i, '')
          .replace(/^(?:post|share|update|tweet|send|write|say|ask|tell|search\s+for|query|look\s+up|find|message)\s+/i, '')
          .replace(/^(?:on\s+|to\s+|in\s+)?(?:linkedin|twitter|x\.com|chatgpt|claude|grok|perplexity|gmail|outlook|notion|slack|discord|bluesky|threads|facebook|instagram)\s+/i, '')
          .replace(/^(?:that|about|regarding|saying)\s+/i, '')
          .replace(/^(?:to\s+|with\s+|for\s+)/i, '')
          .trim();

        // If the payload is too short or looks like it has multi-field intent, skip
        if (_textPayload.length >= 3 && _textPayload.length <= 2000) {
          logger.info(`[playwright.agent] Tier 1.7: simple goal detected — text payload="${_textPayload.slice(0, 80)}..." — attempting type→submit→verify without LLM`);

          const _tier17Transcript = [];
          const _tier17Start = Date.now();

          // Step 1: Type the text payload
          const _typeRes = await browserAct({ action: 'type', text: _textPayload, sessionId, headed, timeoutMs: Math.min(timeoutMs, 30000) });
          _tier17Transcript.push({ action: { type: _textPayload.slice(0, 100) }, outcome: { ok: _typeRes.ok, error: _typeRes.error } });

          if (!_typeRes.ok) {
            logger.warn(`[playwright.agent] Tier 1.7: type failed (${_typeRes.error}) — falling through to Tier 3`);
          } else {
            // Step 2: Find and click the submit button
            // Look for buttons with submit-like text in the scanner's element list
            const _snapResult = await _fastSnapshot(sessionId, headed, timeoutMs);
            const _snapYaml = _snapResult?.result || _snapResult?.stdout || '';
            let _submitRef = null;

            // Parse the snapshot text for buttons with submit-like labels
            const _submitRe = /\[(td\d+|e\d+)\]\s+(?:button|link|generic)\s+"([^"]*(?:post|send|submit|ask|search|share|tweet|publish|create|go|enter|continue)[^"]*)"/gi;
            let _m;
            while ((_m = _submitRe.exec(_snapYaml)) !== null) {
              _submitRef = _m[1];
              logger.info(`[playwright.agent] Tier 1.7: found submit button ref=${_submitRef} label="${_m[2]}"`);
              break;
            }

            if (_submitRef) {
              // Step 3: Click submit
              const _clickRes = await browserAct({ action: 'click', selector: _submitRef, sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
              _tier17Transcript.push({ action: { click: _submitRef }, outcome: { ok: _clickRes.ok, error: _clickRes.error } });

              if (_clickRes.ok) {
                // Step 4: Verify — wait for state change
                await new Promise(r => setTimeout(r, 1500));
                const _verifyUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
                const _verifyTextRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));

                // Check if the typed text appears in the page (post was created)
                const _pageText = _verifyTextRes?.ok ? String(_verifyTextRes.result || '') : '';
                const _textOnPage = _pageText.includes(_textPayload.slice(0, 50));
                const _urlChanged = _verifyUrlRes?.ok && String(_verifyUrlRes.result || '').replace(/^"|"$/g, '') !== url;

                if (_textOnPage || _urlChanged) {
                  logger.info(`[playwright.agent] Tier 1.7: SUCCESS — textOnPage=${_textOnPage}, urlChanged=${_urlChanged}`);
                  return {
                    ok: true, goal, sessionId,
                    turns: 2, done: true,
                    result: `Completed via Tier 1.7 fast-path (type→submit→verify)${_textOnPage ? ' — content verified on page' : ' — URL changed'}`,
                    transcript: _tier17Transcript,
                    routingDecision: 'tier1_7_fastpath',
                    pageType: _pageType,
                    executionTime: Date.now() - start,
                  };
                } else {
                  logger.warn(`[playwright.agent] Tier 1.7: submit clicked but no verification — falling through to Tier 3`);
                }
              } else {
                logger.warn(`[playwright.agent] Tier 1.7: submit click failed (${_clickRes.error}) — falling through to Tier 3`);
              }
            } else {
              // No submit button found — try pressing Enter
              logger.info(`[playwright.agent] Tier 1.7: no submit button found — trying Enter key`);
              const _enterRes = await browserAct({ action: 'press', key: 'Enter', sessionId, headed, timeoutMs: 5000 });
              _tier17Transcript.push({ action: { press: 'Enter' }, outcome: { ok: _enterRes.ok } });

              if (_enterRes.ok) {
                await new Promise(r => setTimeout(r, 1500));
                const _verifyTextRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
                const _pageText = _verifyTextRes?.ok ? String(_verifyTextRes.result || '') : '';
                const _textOnPage = _pageText.includes(_textPayload.slice(0, 50));

                if (_textOnPage) {
                  logger.info(`[playwright.agent] Tier 1.7: SUCCESS via Enter — content verified on page`);
                  return {
                    ok: true, goal, sessionId,
                    turns: 2, done: true,
                    result: 'Completed via Tier 1.7 fast-path (type→Enter→verify)',
                    transcript: _tier17Transcript,
                    routingDecision: 'tier1_7_fastpath',
                    pageType: _pageType,
                    executionTime: Date.now() - start,
                  };
                }
              }
              logger.warn(`[playwright.agent] Tier 1.7: Enter key did not produce verifiable result — falling through to Tier 3`);
            }
          }
        } else {
          logger.info(`[playwright.agent] Tier 1.7: text payload too short/long or multi-field — falling through to Tier 3 (payload length=${_textPayload.length})`);
        }
      } else {
        logger.info(`[playwright.agent] Tier 1.7: goal does not match simple single-action pattern — falling through to Tier 3`);
      }
    } else if (_tier17Snap?.ok) {
      // ── Tier 1.7 secondary trigger: compose URL + text input detected but not focused ──
      // If the URL is a compose URL and the snapshot contains text input elements,
      // try clicking the compose element to focus it, then proceed with type→submit→verify.
      const _snapYaml = _tier17Snap?.result || _tier17Snap?.stdout || '';
      const _curUrl = await _engineEval(sessionId, 'window.location.href').catch(() => null);
      const _actualUrl = _curUrl?.ok ? String(_curUrl.result).trim().replace(/^"|"$/g, '') : url;
      const _isComposeUrl = isFormUrl(url) || isFormUrl(_actualUrl) ||
        /shareActive=true|compose\/post|compose=new|\/compose\b|posting\?compose=true/i.test(_actualUrl || url || '');

      if (_isComposeUrl) {
        // Find text input elements in the snapshot YAML
        const _composeRe = /\[(td\d+|e\d+)\]\s+(?:textbox|combobox|searchbox)\s+"([^"]*)"/gi;
        let _composeRef = null;
        let _composeLabel = '';
        let _m;
        while ((_m = _composeRe.exec(_snapYaml)) !== null) {
          // Prefer elements with placeholder/label that look like compose areas
          const _label = _m[2].toLowerCase();
          if (!/_composeRef/.length || /post|share|write|compose|message|what|comment|reply|ask|search|type/i.test(_label) || _m[1].startsWith('td')) {
            _composeRef = _m[1];
            _composeLabel = _m[2];
            break;
          }
        }
        // Also try contenteditable elements
        if (!_composeRef) {
          const _ceRe = /\[(td\d+|e\d+)\]\s+\w+\s+"[^"]*"\s*\[contenteditable\]/i;
          const _ceM = _ceRe.exec(_snapYaml);
          if (_ceM) {
            _composeRef = _ceM[1];
            _composeLabel = '(contenteditable)';
          }
        }

        if (_composeRef) {
          logger.info(`[playwright.agent] Tier 1.7 secondary: compose URL detected, clicking compose element ref=${_composeRef} label="${_composeLabel}" to focus it`);

          // Click the compose element to focus it
          const _focusClick = await browserAct({ action: 'click', selector: _composeRef, sessionId, headed, timeoutMs: Math.min(timeoutMs, 10000) });
          if (_focusClick?.ok) {
            // Take a fresh snapshot to check if focus shifted to the compose element
            await new Promise(r => setTimeout(r, 500));
            const _reSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
            const _reActiveEl = _reSnap?.activeElement;
            if (_reActiveEl && _reActiveEl.isPrimaryInput) {
              logger.info(`[playwright.agent] Tier 1.7 secondary: focus shifted to primary input (tag=${_reActiveEl.tag}, role=${_reActiveEl.role}) — proceeding with type→submit→verify`);

              // Now run the same type→submit→verify logic as the primary path
              const _goalLower = goal.toLowerCase();
              const _isSimpleGoal = !/\bto\s+[\w.+-]+@|subject|recipient|cc|bcc|attach|file|upload\b/i.test(goal) &&
                (/\b(post|share|update|tweet|send|write|say|ask|tell|search|query|look\s+up|find|message)\b/i.test(_goalLower));

              if (_isSimpleGoal) {
                let _textPayload = goal
                  .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:I\s+want\s+to\s+|I'd\s+like\s+to\s+)?/i, '')
                  .replace(/^(?:post|share|update|tweet|send|write|say|ask|tell|search\s+for|query|look\s+up|find|message)\s+/i, '')
                  .replace(/^(?:on\s+|to\s+|in\s+)?(?:linkedin|twitter|x\.com|chatgpt|claude|grok|perplexity|gmail|outlook|notion|slack|discord|bluesky|threads|facebook|instagram)\s+/i, '')
                  .replace(/^(?:that|about|regarding|saying)\s+/i, '')
                  .replace(/^(?:to\s+|with\s+|for\s+)/i, '')
                  .trim();

                if (_textPayload.length >= 3 && _textPayload.length <= 2000) {
                  logger.info(`[playwright.agent] Tier 1.7 secondary: simple goal — text payload="${_textPayload.slice(0, 80)}..." — attempting type→submit→verify`);

                  const _tier17Transcript = [];
                  const _typeRes = await browserAct({ action: 'type', text: _textPayload, sessionId, headed, timeoutMs: Math.min(timeoutMs, 30000) });
                  _tier17Transcript.push({ action: { type: _textPayload.slice(0, 100) }, outcome: { ok: _typeRes.ok, error: _typeRes.error } });

                  if (_typeRes.ok) {
                    const _snapResult2 = await _fastSnapshot(sessionId, headed, timeoutMs);
                    const _snapYaml2 = _snapResult2?.result || _snapResult2?.stdout || '';
                    let _submitRef = null;
                    const _submitRe = /\[(td\d+|e\d+)\]\s+(?:button|link|generic)\s+"([^"]*(?:post|send|submit|ask|search|share|tweet|publish|create|go|enter|continue)[^"]*)"/gi;
                    let _m2;
                    while ((_m2 = _submitRe.exec(_snapYaml2)) !== null) {
                      _submitRef = _m2[1];
                      logger.info(`[playwright.agent] Tier 1.7 secondary: found submit button ref=${_submitRef} label="${_m2[2]}"`);
                      break;
                    }

                    if (_submitRef) {
                      const _clickRes = await browserAct({ action: 'click', selector: _submitRef, sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
                      _tier17Transcript.push({ action: { click: _submitRef }, outcome: { ok: _clickRes.ok, error: _clickRes.error } });

                      if (_clickRes.ok) {
                        await new Promise(r => setTimeout(r, 1500));
                        const _verifyUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
                        const _verifyTextRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
                        const _pageText = _verifyTextRes?.ok ? String(_verifyTextRes.result || '') : '';
                        const _textOnPage = _pageText.includes(_textPayload.slice(0, 50));
                        const _urlChanged = _verifyUrlRes?.ok && String(_verifyUrlRes.result || '').replace(/^"|"$/g, '') !== url;

                        if (_textOnPage || _urlChanged) {
                          logger.info(`[playwright.agent] Tier 1.7 secondary: SUCCESS — textOnPage=${_textOnPage}, urlChanged=${_urlChanged}`);
                          return {
                            ok: true, goal, sessionId,
                            turns: 2, done: true,
                            result: `Completed via Tier 1.7 secondary fast-path (click-compose→type→submit→verify)${_textOnPage ? ' — content verified on page' : ' — URL changed'}`,
                            transcript: _tier17Transcript,
                            routingDecision: 'tier1_7_secondary',
                            pageType: _pageType,
                            executionTime: Date.now() - start,
                          };
                        }
                      }
                    } else {
                      logger.info(`[playwright.agent] Tier 1.7 secondary: no submit button found — trying Enter key`);
                      const _enterRes = await browserAct({ action: 'press', key: 'Enter', sessionId, headed, timeoutMs: 5000 });
                      if (_enterRes?.ok) {
                        await new Promise(r => setTimeout(r, 1500));
                        const _verifyTextRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
                        const _pageText = _verifyTextRes?.ok ? String(_verifyTextRes.result || '') : '';
                        if (_pageText.includes(_textPayload.slice(0, 50))) {
                          logger.info(`[playwright.agent] Tier 1.7 secondary: SUCCESS via Enter — content verified on page`);
                          return {
                            ok: true, goal, sessionId,
                            turns: 2, done: true,
                            result: 'Completed via Tier 1.7 secondary fast-path (click-compose→type→Enter→verify)',
                            transcript: _tier17Transcript,
                            routingDecision: 'tier1_7_secondary',
                            pageType: _pageType,
                            executionTime: Date.now() - start,
                          };
                        }
                      }
                    }
                  }
                  logger.warn(`[playwright.agent] Tier 1.7 secondary: type→submit→verify did not complete — falling through to Tier 3`);
                } else {
                  logger.info(`[playwright.agent] Tier 1.7 secondary: text payload too short/long (length=${_textPayload.length}) — falling through`);
                }
              } else {
                logger.info(`[playwright.agent] Tier 1.7 secondary: goal does not match simple single-action — falling through`);
              }
            } else {
              logger.info(`[playwright.agent] Tier 1.7 secondary: click did not focus a primary input — falling through to Tier 3`);
            }
          } else {
            logger.info(`[playwright.agent] Tier 1.7 secondary: click on compose element failed (${_focusClick?.error}) — falling through to Tier 3`);
          }
        } else {
          logger.info(`[playwright.agent] Tier 1.7 secondary: compose URL but no text input element found in snapshot — falling through to Tier 3`);
        }
      }
    }
  } catch (_tier17Err) {
    logger.warn(`[playwright.agent] Tier 1.7 error (non-fatal): ${_tier17Err.message} — falling through`);
  }

  // ── Phase 1.1: Page probe + intelligent routing ─────────────────────────────
  // Lightweight eval to classify page structure (canvas, traditional, hybrid, sparse).
  // Routes to Tier 2 (script-first), Tier 2.5 (best-effort keyboard), or Tier 3 (LLM).
  let _pageType = 'sparse';
  let _routingDecision = 'tier3_llm';
  let _probeResult = null;
  let _scriptResult = null;
  let _partialProgressNote = '';
  // Build a generic note from a failed tier's transcript so the next tier
  // doesn't repeat actions that already executed (e.g. re-type a title).
  function _buildPartialProgressNote(transcript, tierLabel) {
    if (!Array.isArray(transcript) || transcript.length === 0) return '';
    const doneActions = [];
    for (const t of transcript) {
      const outcome = t.outcome || t;
      if (!outcome || outcome.ok === false) continue;
      const action = t.action || {};
      if (action.type) doneActions.push(`typed "${String(action.type).slice(0, 60)}"`);
      else if (action.press) doneActions.push(`pressed ${action.press}`);
      else if (action.click) doneActions.push(`clicked ${String(action.click).slice(0, 60)}`);
    }
    if (doneActions.length === 0) return '';
    return `\n\nNOTE: A previous ${tierLabel} attempt already executed these actions on the current page before failing: ${doneActions.join('; ')}. Do NOT repeat completed actions — inspect the current page state and continue from where it left off.`;
  }
  try {
    // Ensure seed scripts exist in DB (fire-and-forget, non-blocking)
    ensureSeedScripts().catch(() => {});

    _probeResult = await pageProbe(sessionId, headed, 5000);
    _pageType = classifyPageType(_probeResult);
    const _service = serviceFromHostname(hostname) || serviceFromHostname(_probeResult?.hostname);

    logger.info(`[playwright.agent] phase 1.1: page probe → type=${_pageType}, service=${_service || 'unknown'}, interactive=${_probeResult?.interactiveCount ?? '?'}, contentEditable=${_probeResult?.contentEditableCount ?? '?'}`);

    // Script DB lookup for (service, page_type) — SKIPPED when URL-first is used
    // The script DB's service extraction is too coarse (mail.google.com → "google")
    // and causes false matches. When URL-first already delivered us to the right page,
    // we go directly to Tier 2.5 (canvas) or Tier 3 (LLM plan).
    const _taskKeywords = extractKeywordsFromGoal(goal);
    const _urlFirst = !!url;
    const _matchedScript = (!_urlFirst && _service) ? await getInteractionScript(_service, _pageType, _taskKeywords) : null;
    if (_urlFirst) {
      logger.info(`[playwright.agent] routing: URL-first path — skipping Tier 2 script DB, using Tier 2.5 (canvas) or Tier 3 (LLM) directly`);
    }

    if (_matchedScript && (_pageType === 'canvas' || _pageType === 'hybrid')) {
      // Tier 2: Script-first execution
      _routingDecision = 'tier2_script';
      logger.info(`[playwright.agent] routing: Tier 2 (script-first) — service=${_service}, script=${_matchedScript.id || 'unknown'}`);

      const _params = extractParamsFromGoal(goal);
      _scriptResult = await executeScript(_matchedScript, _params, sessionId, headed, timeoutMs);

      if (_scriptResult.ok) {
        logger.info(`[playwright.agent] Tier 2 script succeeded — ${_scriptResult.transcript.length} steps, verified=${_scriptResult.verified}`);
        await incrementScriptSuccess(_service, _matchedScript.action).catch(() => {});
        // Phase 8: Verification layer
        const _verify = await verifyTierCompletion(goal, _pageType, _routingDecision, _matchedScript, sessionId, headed, timeoutMs);
        if (_verify.fail) {
          logger.warn(`[playwright.agent] verification layer: FAIL after Tier 2 — ${_verify.reason} — falling back`);
          await incrementScriptFailure(_service, _matchedScript.action).catch(() => {});
          // Fall through to Tier 2.5 or Tier 3
        } else {
          return {
            ok: true, goal, sessionId,
            turns: _scriptResult.transcript.length, done: true,
            result: `Completed via script: ${_matchedScript.id}${_verify.warn ? ' (warning: ' + _verify.reason + ')' : ''}`,
            transcript: _scriptResult.transcript,
            routingDecision: _routingDecision,
            pageType: _pageType,
            verification: _verify,
            executionTime: Date.now() - start,
          };
        }
      } else {
        logger.warn(`[playwright.agent] Tier 2 script failed: ${_scriptResult.error} — falling back`);
        await incrementScriptFailure(_service, _matchedScript.action).catch(() => {});
        _partialProgressNote = _buildPartialProgressNote(_scriptResult.transcript, 'script');
        if (_partialProgressNote) logger.info(`[playwright.agent] partial-progress note built from ${_scriptResult.transcript?.length || 0} Tier 2 steps`);
        // Fall through to Tier 2.5 or Tier 3
      }
    }

    if (_pageType === 'canvas' && !_scriptResult?.ok) {
      // Tier 2.5: Best-effort keyboard mode (no script or script failed)
      _routingDecision = 'tier2_5_keyboard';
      logger.info(`[playwright.agent] routing: Tier 2.5 (best-effort keyboard) — service=${_service || 'unknown'}, pageType=${_pageType}`);

      // Phase 10: Queue async script generation for this service so next run can use Tier 2
      if (_service && !_matchedScript) {
        queueAsyncScriptGeneration(_service, _pageType, goal, _taskKeywords);
      }

      // Try sync script generation first (generates + caches a script)
      if (_service) {
        _scriptResult = await syncScriptGeneration(goal + _partialProgressNote, _pageType, _service, sessionId, headed, timeoutMs);
        if (_scriptResult.ok) {
          logger.info(`[playwright.agent] Tier 2.5 sync gen succeeded — ${_scriptResult.transcript?.length || 0} steps`);
          // Phase 8: Verification layer
          const _verify = await verifyTierCompletion(goal, _pageType, _routingDecision, null, sessionId, headed, timeoutMs);
          if (_verify.fail) {
            logger.warn(`[playwright.agent] verification layer: FAIL after Tier 2.5 sync gen — ${_verify.reason} — trying best-effort keyboard`);
          } else {
            return {
              ok: true, goal, sessionId,
              turns: _scriptResult.transcript?.length || 0, done: true,
              result: `Completed via sync-generated script${_verify.warn ? ' (warning: ' + _verify.reason + ')' : ''}`,
              transcript: _scriptResult.transcript || [],
              routingDecision: _routingDecision,
              pageType: _pageType,
              verification: _verify,
              executionTime: Date.now() - start,
            };
          }
        }
        logger.warn(`[playwright.agent] Tier 2.5 sync gen failed: ${_scriptResult.error} — trying best-effort keyboard`);
        if (!_partialProgressNote) _partialProgressNote = _buildPartialProgressNote(_scriptResult?.transcript, 'keyboard-script');
      }

      // Fall back to best-effort keyboard
      // ── Fresh-line guard: if this is a retry continuing a prior partial attempt,
      // the cursor may be left mid-line (prior tier's last typed step had no
      // trailing Enter). Typing here would concatenate onto that existing text,
      // producing corrupted merged lines. Press Enter first to guarantee a fresh
      // line — a safe no-op if the cursor is already on an empty line (list-style
      // blocks in most editors collapse/ignore a stray empty trailing item).
      if (_partialProgressNote) {
        logger.info(`[playwright.agent] fresh-line guard: continuing prior partial attempt — pressing Enter before best-effort retry`);
        await browserAct({ action: 'press', key: 'Enter', sessionId, headed, timeoutMs: 5000 }).catch(() => {});
      }
      const _bestEffort = await bestEffortKeyboard(goal + _partialProgressNote, _pageType, sessionId, headed, timeoutMs);
      if (_bestEffort.ok) {
        logger.info(`[playwright.agent] Tier 2.5 best-effort keyboard succeeded — ${_bestEffort.transcript.length} steps`);
        // Phase 8: Verification layer
        const _verify = await verifyTierCompletion(goal, _pageType, _routingDecision, null, sessionId, headed, timeoutMs);
        if (_verify.fail) {
          logger.warn(`[playwright.agent] verification layer: FAIL after Tier 2.5 best-effort — ${_verify.reason} — falling back to Tier 3 (LLM)`);
        } else {
          return {
            ok: true, goal, sessionId,
            turns: _bestEffort.transcript.length, done: true,
            result: `Completed via best-effort keyboard${_verify.warn ? ' (warning: ' + _verify.reason + ')' : ''}`,
            transcript: _bestEffort.transcript,
            routingDecision: _routingDecision,
            pageType: _pageType,
            verification: _verify,
            executionTime: Date.now() - start,
          };
        }
      }
      logger.warn(`[playwright.agent] Tier 2.5 best-effort failed: ${_bestEffort.error} — falling back to Tier 3 (LLM)`);
      if (!_partialProgressNote) _partialProgressNote = _buildPartialProgressNote(_bestEffort?.transcript, 'keyboard');
      // Fall through to Tier 3
    }

    if (_pageType === 'traditional' || _pageType === 'sparse' || _pageType === 'hybrid') {
      _routingDecision = 'tier3_llm';
      logger.info(`[playwright.agent] routing: Tier 3 (LLM snapshot loop) — pageType=${_pageType}`);
    }
  } catch (_probeErr) {
    logger.warn(`[playwright.agent] phase 1.1: page probe + routing error (non-fatal): ${_probeErr.message} — defaulting to Tier 3`);
    _routingDecision = 'tier3_llm';
  }

  // ── Phase 1.2: Orientation loop — clear interstitials before plan generation ─
  // Fires ONLY when the snapshot matches a known interstitial pattern (zero LLM
  // calls on normal pages). Clicks past onboarding, cookie walls, setup wizards,
  // etc. so Phase 2 plan generation always sees a clean starting page.
  // Skip orientation if the page probe showed an active editable element — if focus is
  // already inside an editor (contenteditable, textarea, input), the page is not blocked
  // by an interstitial by definition. This prevents false positives on ready editor pages
  // (e.g. Notion's "Get started with..." text matching interstitial regex on a blank page).
  const _skipOrientationForEditable = _probeResult?.activeElementEditable === true;

  if (!_skipOrientationForEditable && looksLikeInterstitial(currentSnapshot)) {
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
  // First, purge any existing ref-based learned rules (e.g. "click e12 instead of e5")
  // that were saved by a bug in prior runs. These rules contain ephemeral element refs
  // that are snapshot-specific and will be wrong on every future page load.
  let learnedRulesBlock = '';
  try {
    const ruleKeys = [agentId];
    if (hostname) ruleKeys.push(hostname);
    // Purge ref-based rules fire-and-forget
    (async () => {
      try {
        const _allRules = await skillDb.listAllContextRules();
        const _refRuleRe = /\be\d+\b/i;
        let _purgedCount = 0;
        for (const [_ctxKey, _rules] of Object.entries(_allRules || {})) {
          if (!ruleKeys.includes(_ctxKey)) continue;
          if (!Array.isArray(_rules)) continue;
          for (const _rule of _rules) {
            const _text = _rule.ruleText || _rule.rule_text || '';
            if (_refRuleRe.test(_text) && _rule.id) {
              await skillDb.deleteContextRuleById(_rule.id);
              _purgedCount++;
              logger.info(`[playwright.agent] purged ref-based learned rule for ${_ctxKey}: "${_text.slice(0, 80)}"`);
            }
          }
        }
        if (_purgedCount > 0) {
          logger.info(`[playwright.agent] purged ${_purgedCount} ref-based learned rule(s) for [${ruleKeys.join(', ')}]`);
        }
      } catch (_) { /* non-fatal */ }
    })();
    const rules = await skillDb.getContextRulesByKeys(ruleKeys);
    // Double-filter: also skip any ref-based rules that slip through between purge and read
    const _safeRules = rules.filter(r => !/\be\d+\b/i.test(r));
    if (_safeRules.length > 0) {
      learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — advisory, not absolute):\n${_safeRules.map(r => `- ${r}`).join('\n')}\n- Never use tutorial placeholders (example@domain.com, /path/to/...) unless the user explicitly asked for an example.`;
      logger.info(`[playwright.agent] ${_safeRules.length} learned rule(s) injected for [${ruleKeys.join(', ')}]${rules.length !== _safeRules.length ? ` (${rules.length - _safeRules.length} ref-based rules filtered)` : ''}`);
    }
  } catch (_) { /* non-fatal — proceed without rules */ }

  // ── Phase 1.6: Stale compose-window guard for mail agents ─────────────────
  // If a previous cron fire failed mid-compose, the browser session may have a
  // compose window left open. The LLM will try to fill fields in it rather than
  // opening a fresh one, causing "address in body" and send failures.
  // Append a NOTE to the goal so the LLM closes any open compose/draft first.
  const _isComposeTask = /send.*(email|mail)|compose|write.*to\s+\S+@/i.test(goal);
  const _isMailAgentTask = ['gmail.agent', 'outlook.agent', 'yahoo.agent'].includes(agentId);
  const effectiveGoal = (_isComposeTask && _isMailAgentTask)
    ? `${goal}\n\nNOTE: If a compose or draft window is currently visible on the page, close it first (click its X button or press Escape) before opening a fresh Compose window.`
    : goal;

  // ── Phase 1.7: Goal-state pre-check ───────────────────────────────────────
  // Before generating a full plan, check if prerequisite state is already satisfied.
  // This avoids: re-clicking Compose when compose window is already open, re-searching
  // when results are already displayed, re-navigating when already on target URL.
  // Injected as a NOTE in effectiveGoal so the LLM skips already-done steps.
  let _goalStateNote = '';

  // ── Compose-URL note: prevent LLM from clicking "Start a post" behind an open modal ──
  // When the URL contains a compose param (shareActive=true, compose/post, etc.) OR
  // the fast path detected an open modal OR the page probe detected a modal dialog,
  // inject an imperative note so the LLM types directly into the composer instead
  // of planning a click to open it.
  if (url && /shareActive=true|compose\/post|compose=new|\/compose\b|posting\?compose=true/i.test(url)) {
    _goalStateNote = '\n\nIMPORTANT: The composer/modal is ALREADY OPEN (opened by the URL deep-link). Do NOT click "Start a post" or any button to open a composer — it is already open. Type directly into the composer text area (contenteditable or textarea) using refs from the snapshot above.';
    logger.info(`[playwright.agent] goal-state: compose URL detected — injecting "composer already open" note`);
  } else if (_composerModalOpen || _probeResult?.hasModalDialog) {
    _goalStateNote = '\n\nIMPORTANT: A composer/modal is ALREADY OPEN on the page. Do NOT click "Start a post" or any button to open a composer — it is already open. Type directly into the composer text area (contenteditable or textarea) using refs from the snapshot above.';
    logger.info(`[playwright.agent] goal-state: modal open (${_composerModalOpen ? 'fast-path' : 'page-probe'}) — injecting "composer already open" note`);
  }

  try {
    if (_isComposeTask && _isMailAgentTask) {
      // Require a real compose form, not just the sidebar "Compose" button. The inbox has a Compose
      // button but lacks To + Subject + message body fields together.
      const _snapshotLower = currentSnapshot.toLowerCase();
      const _hasToField = /\bto\b/.test(_snapshotLower);
      const _hasSubjectField = /\bsubject\b/.test(_snapshotLower);
      const _hasBodyField = /message body|compose|contenteditable|draft/i.test(_snapshotLower);
      const _composeAlreadyOpen = _hasToField && _hasSubjectField && _hasBodyField;
      if (_composeAlreadyOpen) {
        _goalStateNote = '\n\nNOTE: A compose/draft window is ALREADY OPEN in the browser. Do NOT navigate to compose URL or click Compose again — start directly by filling the To field using refs from the snapshot above.';
        logger.info('[playwright.agent] goal-state: compose window already open — injecting skip-compose note');
      }
    }
    // Generic: if we're already on the task's target URL, skip navigate steps
    if (!_goalStateNote && url) {
      const _curUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
      const _curUrl = _curUrlRes?.ok ? String(_curUrlRes.result || '').replace(/^"|"$/g, '') : '';
      if (_curUrl && url) {
        try {
          const _cur = new URL(_curUrl);
          const _tgt = new URL(url);
          const _tgtPath = _tgt.pathname.replace(/\/$/, '') || '/';
          const _curPath = _cur.pathname.replace(/\/$/, '') || '/';
          const _sameOrigin = _cur.origin === _tgt.origin;
          // For root targets (/), require exact path match — SPA redirects to sub-pages must NOT match
          // For specific targets, allow startsWith on pathname (e.g. /workspace matches /workspace/team)
          const _pathMatch = _tgtPath === '/' ? _curPath === '/' : _curPath.startsWith(_tgtPath);
          if (_sameOrigin && _pathMatch) {
            _goalStateNote = `\n\nNOTE: The browser is ALREADY on ${_curUrl}. Do NOT add a navigate step — start directly with the task actions using refs from the snapshot above.`;
            logger.info(`[playwright.agent] goal-state: already on target URL ${_curUrl} — injecting skip-navigate note`);
          }
        } catch (_) {
          // URL parse fallback — use startsWith for non-standard URLs
          if (_curUrl.startsWith(url.replace(/#.*$/, ''))) {
            _goalStateNote = `\n\nNOTE: The browser is ALREADY on ${_curUrl}. Do NOT add a navigate step — start directly with the task actions using refs from the snapshot above.`;
            logger.info(`[playwright.agent] goal-state: already on target URL ${_curUrl} — injecting skip-navigate note`);
          }
        }
      }
    }
  } catch (_gsErr) {
    logger.warn(`[playwright.agent] goal-state pre-check failed (non-fatal): ${_gsErr.message}`);
  }

  const _finalGoal = (effectiveGoal + (_goalStateNote || '') + (_partialProgressNote || ''));

  // ── Phase 1.7: Page study — understand the page before planning ──────────
  // A lightweight LLM call that analyzes the current page snapshot and returns
  // a structured assessment (page type, key elements, expected flow, blockers).
  // This is injected into the plan generation prompt to produce more accurate plans.
  let _pageStudy = null;
  let _studyBlock = '';
  try {
    const _studyRaw = await askWithMessages([
      { role: 'system', content: PAGE_STUDY_PROMPT + domainLockBlock },
      { role: 'user',   content: `GOAL: ${_finalGoal}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}` },
    ], { temperature: 0.1, maxTokens: 600, responseTimeoutMs: 15000 });
    _pageStudy = parseJson(_studyRaw);
    if (_pageStudy && typeof _pageStudy === 'object') {
      logger.info(`[playwright.agent] phase 1.7: page study — pageType=${_pageStudy.pageType}, rightPage=${_pageStudy.rightPage}, confidence=${_pageStudy.confidence}, elements=${_pageStudy.keyElements?.length || 0}`);
      if (_pageStudy.rightPage === false && (_pageStudy.confidence || 0) < 0.3) {
        logger.warn(`[playwright.agent] phase 1.7: wrong page detected — ${_pageStudy.wrongPageReason || 'no reason given'}`);
      }
      _studyBlock = `\nPAGE ANALYSIS (from pre-plan study phase — use this to guide your plan):\n- Page type: ${_pageStudy.pageType || 'unknown'}\n- Right page: ${_pageStudy.rightPage}\n- Confidence: ${_pageStudy.confidence}\n- Key elements: ${JSON.stringify((_pageStudy.keyElements || []).slice(0, 10))}\n- Expected flow: ${(_pageStudy.expectedFlow || []).join(' → ')}\n- Potential blockers: ${(_pageStudy.potentialBlockers || []).join('; ')}\n`;
    } else {
      logger.warn(`[playwright.agent] phase 1.7: page study response unparseable — proceeding without`);
    }
  } catch (_studyErr) {
    logger.warn(`[playwright.agent] phase 1.7: page study failed (non-fatal): ${_studyErr.message}`);
  }

  // ── Phase 2: Turn-loop (URL-first tiers did not complete) ──────────────
  // NOTE: Script-gen (phase 1.9) and Plan-Execute (phase 2+3) are commented out
  // below. They had too many failure modes (false success reporting, stale refs,
  // blind to contenteditable elements, LLM making wrong decisions about modal state).
  // The turn-loop is more robust: fresh snapshot + page text + probe each turn,
  // adapts after each action. Uses reactFill/clickByText/clickBySelector.
  // If simple tasks are too slow (too many LLM calls per turn), we can re-enable
  // Plan-Execute with a simple-task router for type→submit→read tasks.
  logger.info(`[playwright.agent] phase 2: URL-first tiers did not complete - starting turn-loop`);
  try {
    const _turnLoopResult = await _executeTurnLoopFallback({
      goal: _finalGoal,
      extractedText: _extractedComposeText,
      textAlreadyEntered: _textAlreadyEntered,
      heartbeat: _heartbeat,
      sessionId,
      headed,
      timeoutMs,
      agentContext,
      transcript: [],
      deadline: _deadline,
      start,
    });
    if (_turnLoopResult.ok) {
      _turnLoopResult.executionTime = Date.now() - start;
      _heartbeat.stop();
      return _turnLoopResult;
    }
    logger.warn(`[playwright.agent] turn-loop failed: ${_turnLoopResult.error || 'unknown'} - surfacing ask_user`);
    _heartbeat.stop();
    return { ..._failureAskUser(`Turn-loop failed: ${_turnLoopResult.error || 'could not complete task'}`), executionTime: Date.now() - start };
  } catch (_turnLoopErr) {
    logger.warn(`[playwright.agent] turn-loop threw: ${_turnLoopErr.message} - surfacing ask_user`);
    _heartbeat.stop();
    return { ..._failureAskUser(`Turn-loop error: ${_turnLoopErr.message}`), executionTime: Date.now() - start };
  }

  // ── [DISABLED] Phase 1.9: Script-Generation Mode ───────────────────────
  // For compose/post/form tasks, try the injection-first path BEFORE Plan-Execute.
  // The LLM generates a single run-code script using reactFill/clickByText/clickBySelector
  // that programmatically completes the task. More deterministic than snapshot-ref planning
  // for modal interactions. Falls through to Plan-Execute on failure.
  // DISABLED — see note above. This code is unreachable because the turn-loop
  // call above returns before reaching here. Kept for potential future re-enablement.
  if (false && _isInjectionCandidate(_finalGoal, _probeResult)) {
    logger.info(`[playwright.agent] phase 1.9: task is injection candidate — trying script-generation mode`);
    try {
      const _scriptResult = await _executeScriptGeneration({
        goal: _finalGoal,
        sessionId,
        headed,
        timeoutMs,
        agentContext,
        probeResult: _probeResult,
        pageStudy: _pageStudy,
        deadline: _deadline,
      });
      if (_scriptResult.ok) {
        logger.info(`[playwright.agent] script-gen succeeded — returning early (verified=${_scriptResult.verified})`);
        return {
          ok: true,
          goal,
          sessionId,
          turns: 1,
          done: true,
          result: _scriptResult.result || 'Completed via script-generation',
          transcript: [{
            action: 'script-gen',
            outcome: { ok: true, verified: _scriptResult.verified },
            script: _scriptResult.script,
          }],
          routingDecision: 'script_gen',
          pageType: _pageType,
          executionTime: Date.now() - start,
        };
      }
      logger.warn(`[playwright.agent] script-gen failed: ${_scriptResult.error} — falling through to Plan-Execute`);
      _partialProgressNote = `\n\nNOTE: A script-generation attempt was made but failed (${_scriptResult.error}). Inspect the current page state — the script may have partially executed. Do NOT repeat completed actions.`;
    } catch (_scriptGenErr) {
      logger.warn(`[playwright.agent] script-gen threw: ${_scriptGenErr.message} — falling through to Plan-Execute`);
    }
  } else {
    logger.info(`[playwright.agent] phase 1.9: task is not an injection candidate — using Plan-Execute`);
  }

  // ── Phase 2: Plan generation ───────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 2: generating plan`);

  // ── Scoped snapshot: when a modal/dialog is open, filter the full-page snapshot
  // (which HAS refs from buildRefTree) to only show the dialog section. This
  // prevents the LLM from planning clicks on elements behind the modal (e.g.
  // "Start a post" behind the composer) while preserving refs for the click engine.
  let _planningSnapshot = currentSnapshot;
  let _useConstrainedComposePrompt = false;
  if (_probeResult?.hasModalDialog) {
    const _scopedSnap = await _filterSnapshotToModal(sessionId, currentSnapshot);
    if (_scopedSnap.ok && _scopedSnap.result) {
      _planningSnapshot = _scopedSnap.result;
      // Use the constrained compose prompt when the modal has a compose element
      // AND the task is a compose/post/update task (detected via URL pattern or goal text)
      const _composeUrl = /shareActive=true|compose\/post|compose=new|\/compose\b|posting\?compose=true/i.test(url || '');
      const _composeGoal = /post|update|share|tweet|publish|send|write|message/i.test(_finalGoal || '');
      if (_scopedSnap.hasCompose && (_composeUrl || _composeGoal)) {
        _useConstrainedComposePrompt = true;
      }
      logger.info(`[playwright.agent] phase 2: using scoped modal snapshot for planning (${_planningSnapshot.length} chars, constrained=${_useConstrainedComposePrompt})`);
    } else {
      logger.info(`[playwright.agent] phase 2: scoped snapshot unavailable — using full snapshot`);
    }
  }

  // ── Constrained compose prompt: when a composer modal is open with a text input,
  // use a simpler prompt that constrains the LLM to type + click submit. This
  // reduces the LLM's degrees of freedom and prevents it from planning wrong
  // actions (navigate, click "Start a post", etc.).
  const COMPOSE_PLAN_PROMPT = `You are a browser automation expert. A COMPOSER MODAL IS OPEN on the page.
The snapshot below shows ONLY the interactive elements inside the modal — they all have refs (e1, e2, etc.).

Your task is simple:
1. Find the text input (textbox, contenteditable, or textarea) in the snapshot — type the update text into it
2. Find the submit button (Post, Publish, Send, Share, Tweet) in the snapshot — click it to submit

DO NOT navigate anywhere. DO NOT click "Start a post" or any button to open a composer — it is ALREADY OPEN.
DO NOT click elements outside the modal — the snapshot only shows modal elements.
Use refs (e1, e2, etc.) from the snapshot for all actions.

Output a JSON plan: { "plan": [ { "action": "type", "selector": "eXX", "text": "..." }, { "action": "click", "selector": "eYY" } ] }`;

  const _planSystemPrompt = _useConstrainedComposePrompt
    ? COMPOSE_PLAN_PROMPT + domainLockBlock
    : PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock;

  // Build active element context block for the plan prompt
  let _activeElBlock = '';
  if (_activeElementInfo) {
    const _aeTag = _activeElementInfo.tag || 'unknown';
    const _aeType = _activeElementInfo.type || '';
    const _aePlaceholder = _activeElementInfo.placeholder || '';
    const _aeRole = _activeElementInfo.role || '';
    const _aePrimary = _activeElementInfo.isPrimaryInput;
    if (_aePrimary) {
      _activeElBlock = `\n# Active element: <${_aeTag}${_aeType ? ` type="${_aeType}"` : ''}${_aeRole ? ` role="${_aeRole}"` : ''}${_aePlaceholder ? ` placeholder="${_aePlaceholder}"` : ''}> [primary-input] — focus is already in this input; type directly without clicking first.\n`;
    } else if (_aeTag && _aeTag !== 'body') {
      _activeElBlock = `\n# Active element: <${_aeTag}${_aeType ? ` type="${_aeType}"` : ''}${_aeRole ? ` role="${_aeRole}"` : ''}>\n`;
    }
  }

  const planMessages = [
    { role: 'system', content: _planSystemPrompt },
    { role: 'user',   content: `GOAL: ${_finalGoal}${_studyBlock}${_activeElBlock}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(_planningSnapshot))}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
  ];
  // Dynamic token cap: short focused tasks (< 400 chars) seldom produce > 3 steps
  // so 800 tokens avoids wasting 1-2s on padding. Complex multi-site goals get 2048.
  const _planMaxTokens = _finalGoal.length < 400 ? 800 : 2048;
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
      planRaw = await askWithMessages(planMessages, { temperature: 0.15, maxTokens: _planMaxTokens, responseTimeoutMs: 30000 });
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

  // ── Semantic plan validation guard ────────────────────────────────────────
  // Reject plans that extract data before performing a search/filter for
  // count/find/check tasks. Retry once with the violated invariant appended.
  {
    let _currentUrlForValidation = url || '';
    try {
      const _urlEval = await _engineEval(sessionId, 'window.location.href');
      if (_urlEval?.ok && _urlEval.result) {
        _currentUrlForValidation = String(_urlEval.result).trim().replace(/^"|"$/g, '');
      }
    } catch (_) {}

    let _semViolation = _validatePlanSemantics(goal, plan, planParsed.thoughts, _currentUrlForValidation);
    if (_semViolation) {
      logger.warn(`[playwright.agent] semantic plan validation FAILED: ${_semViolation.violated} — retrying with invariant`);
      try {
        const _retryRaw = await askWithMessages([
          ...planMessages,
          { role: 'user', content: `PLAN VALIDATION ERROR: ${_semViolation.message}\n\nRegenerate the plan fixing this issue. Ensure search/filter steps come BEFORE any extraction step.` },
        ], { temperature: 0.15, maxTokens: _planMaxTokens, responseTimeoutMs: 30000 });
        const _retryParsed = parseJson(_retryRaw);
        if (_retryParsed && Array.isArray(_retryParsed.plan) && _retryParsed.plan.length > 0) {
          const _retryViolation = _validatePlanSemantics(goal, _retryParsed.plan, _retryParsed.thoughts, _currentUrlForValidation);
          if (!_retryViolation) {
            logger.info(`[playwright.agent] semantic plan validation PASSED on retry: ${_retryParsed.plan.length} steps`);
            plan = _retryParsed.plan;
            planParsed.thoughts = _retryParsed.thoughts;
          } else {
            logger.warn(`[playwright.agent] semantic plan validation FAILED on retry too: ${_retryViolation.violated} — proceeding with corrected plan anyway`);
            plan = _retryParsed.plan;
            planParsed.thoughts = _retryParsed.thoughts;
          }
        }
      } catch (_retryErr) {
        logger.warn(`[playwright.agent] semantic plan validation retry failed: ${_retryErr.message}`);
      }
    }
  }

  // Emit initial plan thoughts so the UI can show them under the step card
  if (planParsed.thoughts && _progressCallbackUrl) {
    postProgress(_progressCallbackUrl, {
      type: 'agent:thought',
      stepIndex: _stepIndex ?? 0,
      thoughts: planParsed.thoughts,
      phase: 'plan',
    });
  }

  if (plan.length === 0) {
    // Goal already satisfied (LLM said "already on the page / no action needed")
    return { ok: true, goal, sessionId, turns: 0, done: true, result: planParsed.thoughts || 'Goal already satisfied', transcript: [], executionTime: Date.now() - start };
  }

  // ── Post-plan attachment guard ────────────────────────────────────────────
  // If the task mentions paste/clipboard/attach but the generated plan has no
  // pasteAttachment step, auto-inject it after the last type/fill (body) step
  // and before the final click (Send). This is a hard structural guarantee —
  // LLM hallucination or contradictory task narratives cannot bypass it.
  {
    const _mentionsAttach = /paste|clipboard|attach/i.test(goal);
    if (_mentionsAttach) {
      const _hasPaste = plan.some(s => s.action === 'pasteAttachment');
      if (!_hasPaste) {
        let _lastTypeIdx = -1;
        for (let _i = plan.length - 1; _i >= 0; _i--) {
          if (plan[_i].action === 'type' || plan[_i].action === 'fill') {
            _lastTypeIdx = _i;
            break;
          }
        }
        if (_lastTypeIdx >= 0) {
          plan.splice(_lastTypeIdx + 1, 0, { action: 'pasteAttachment' });
          logger.info('[playwright.agent] attachment guard: injected pasteAttachment after body type/fill step');
        }
      }
    }
  }

  // ── Post-plan send guard for mail compose tasks ───────────────────────────
  // The LLM always emits { "action": "click", "selector": "eNNN" } for the Send
  // button, never { "action": "sendEmailWithVerification" }. This guard replaces
  // the last Send/Submit click with the robust native action that includes
  // pre-send validation, multi-strategy click, dialog handling, and sent
  // confirmation — a hard structural guarantee, no LLM dependency.
  function replaceSendWithVerification(_plan) {
    if (!(_isComposeTask && _isMailAgentTask)) return;
    // First pass: try to find a click whose selector/aria-label clearly says Send/Submit.
    for (let _i = _plan.length - 1; _i >= 0; _i--) {
      const _s = _plan[_i];
      const _selStr = String(_s.selector || _s.ref || _s['aria-label'] || '');
      const _isSendClick = _s.action === 'click' && /send|submit/i.test(_selStr);
      if (_isSendClick) {
        _plan[_i] = { action: 'sendEmailWithVerification', selector: _s.selector };
        logger.info(`[playwright.agent] send guard: replaced click with sendEmailWithVerification at step ${_i + 1} (was: ${_selStr})`);
        return;
      }
    }
    // Fallback: after re-planning, the LLM may emit a numeric ref (e.g., e1839) with no
    // descriptive text. For mail compose tasks, the final click of the plan is structurally
    // the send action, so replace it as a last resort.
    for (let _i = _plan.length - 1; _i >= 0; _i--) {
      const _s = _plan[_i];
      if (_s.action === 'click') {
        _plan[_i] = { action: 'sendEmailWithVerification', selector: _s.selector };
        logger.info(`[playwright.agent] send guard: replaced final click with sendEmailWithVerification at step ${_i + 1} (selector: ${_s.selector || _s.ref || 'none'})`);
        return;
      }
    }
  }
  replaceSendWithVerification(plan);

  // ── Phase 3: Execute plan ──────────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 3: executing ${plan.length} steps`);
  let stepIndex  = 0;
  let totalRepairs = 0;
  let lastRunCodeResult = null; // captures last successful run-code output for implicit return
  let lastGetPageTextResult = null; // captures last successful getPageText output for implicit return
  let placeholderWarnings = new Set(); // Track substituted placeholders to warn LLM (rate-limited: once per type per session)
  const _typedTexts = new Set(); // Track typed texts to prevent duplicate typing in same session
  let _emailSendVerification = null; // captures verified email send outcome for the judge
  let _emailAlreadySent = false; // true once sendEmailWithVerification succeeds; prevents duplicate sends
  let _mutationClickTs = null; // timestamp of last submit click after fill/type (mutation tracking)
  let _hasFillOrType = false; // true if a fill/type step succeeded in the current plan iteration

  // ── Page-content fetcher for re-plan prompts ──────────────────────────────
  // Fetches document.body.innerText (truncated) so the re-plan LLM can see what
  // content already exists on the page. Without this, the LLM only sees interactive
  // element refs and may hallucinate "create new page" instead of fixing in-place.
  async function _fetchPageContentForReplan() {
    try {
      const _pc = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 5000 });
      if (_pc.ok && _pc.result) {
        const text = String(_pc.result).slice(0, 1000);
        return `\nCURRENT_PAGE_CONTENT (first 1000 chars of existing page text — use this to avoid recreating content that already exists):\n${text}\n`;
      }
    } catch (_) { /* non-fatal — re-plan proceeds without content */ }
    return '';
  }

  // Actions that can mutate the DOM structure (open modals, navigate pages, reveal
  // new elements via lazy-load, toggle conditional sections, etc.).  After any of these
  // succeeds we automatically re-snapshot so snapshotCache stays current, and if ≥30%
  // of refs changed we re-plan the remaining steps with fresh refs (one LLM call).
  const DOM_MUTATING_ACTIONS = new Set([
    'click', 'dblclick',   // modals, dropdowns, SPA navigation
    'navigate', 'goto',    // full page change
    'fill', 'type',        // chip/token creation; contenteditable content changes
    'press',               // Enter=submit, Escape=close dialog, Tab=autocomplete
    'select',              // conditional form sections show/hide
    'drag',                // reorders DOM nodes
    'check', 'uncheck',    // conditional field groups
    'scroll',              // lazy-load / infinite scroll injects new refs
  ]);

  // ── Main execution loop (supports adaptive replanning restart) ───────────────
  try {
  executionLoop: while (true) {
    while (stepIndex < plan.length) {
      _checkDeadline();
      // Circuit breaker: if remaining time < per-action timeout, don't start a doomed action
      const _remaining = _deadline - Date.now();
      if (_remaining < timeoutMs) {
        logger.warn(`[playwright.agent] circuit breaker: remaining ${_remaining}ms < timeoutMs ${timeoutMs}ms — aborting before step ${stepIndex}`);
        return {
          ok: false, goal, sessionId,
          turns: transcript.length, done: false,
          result: `Circuit breaker: insufficient time (${_remaining}ms) for next action (needs ${timeoutMs}ms)`,
          transcript, error: 'Circuit breaker tripped', executionTime: Date.now() - start,
        };
      }
      let step = normalizeStep(plan[stepIndex]);

      // Inline return step — LLM returns extracted data as the final result
      if (step.action === 'return') {
        let data = String(step.data || '').trim();
        // Model-agnostic placeholder detection: if return data looks like a placeholder
        // (<string>, {{result}}, [SEARCH RESULTS], [CONTENT], etc.), substitute with actual captured content
        // Also catch short "success" messages when we have substantial captured content
        const hasBracketedPlaceholder = /^[<{\[][^>}\]]+[>}\]]$/.test(data) || 
          /\[SEARCH RESULTS\]|\[VIDEO RESULTS\]|\[CONTENT\]|\[RESULT\]|\[DATA\]/i.test(data);
        const hasSuccessMessage = data && data.length < 100 && 
          /successfully|completed|done|finished/i.test(data) &&
          lastGetPageTextResult && lastGetPageTextResult.length > 500;
        const isPlaceholder = !data || hasBracketedPlaceholder || hasSuccessMessage;
        logger.info(`[playwright.agent] return step: data="${data?.substring(0, 50)}..." (${data?.length || 0} chars), lastGetPageTextResult=${lastGetPageTextResult?.length || 0} chars, isPlaceholder=${isPlaceholder}`);
        if (isPlaceholder) {
          // Prefer page text (most common for search/browse tasks), fall back to run-code result
          const originalPlaceholder = step.data;
          data = lastGetPageTextResult || lastRunCodeResult || data;
          if (lastGetPageTextResult || lastRunCodeResult) {
            logger.info(`[playwright.agent] substituted placeholder "${originalPlaceholder}" with captured content (${data.length} chars)`);
            // Track for feedback loop: warn LLM on next replan (rate-limited: once per placeholder type)
            const placeholderType = originalPlaceholder.replace(/[^a-zA-Z]/g, '').toUpperCase();
            if (!placeholderWarnings.has(placeholderType)) {
              placeholderWarnings.add(placeholderType);
              logger.warn(`[playwright.agent] PLACEHOLDER WARNING: "${originalPlaceholder}" will be flagged for LLM education (first occurrence)`);
            }
          }
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
        const snap = await _fastSnapshot(sessionId, headed, timeoutMs);
        if (snap.ok && snap.result) currentSnapshot = snap.result;

        const remainingAfterSnap = plan.slice(stepIndex + 1);
        if (remainingAfterSnap.length > 0) {
          if (looksLikeLoginWallSnapshot(currentSnapshot)) {
            // Suppress false-positive: if auth was confirmed < 120s ago, the "login wall"
            // is likely the Google/OAuth redirect from waitForAuth itself, not a real logout.
            const _authAge = authConfirmedAt ? Date.now() - authConfirmedAt : Infinity;
            if (_authAge < 120_000) {
              logger.warn(`[playwright.agent] snapshot re-plan: login-wall suppressed — auth confirmed ${Math.round(_authAge / 1000)}s ago (< 120s threshold). Continuing with fresh snapshot.`);
            } else {
              logger.warn(`[playwright.agent] snapshot re-plan blocked: login wall detected — escalating to waitForAuth`);
              return {
                ok: false, goal, sessionId,
                turns: transcript.length, done: false,
                loginWallDetected: true,
                result: 'Login wall detected during snapshot re-plan — escalating to waitForAuth',
                transcript, executionTime: Date.now() - start,
              };
            }
          }
          if (isAboutBlankSnapshot(currentSnapshot) || countRefs(currentSnapshot) === 0) {
            logger.warn(`[playwright.agent] snapshot re-plan blocked: empty/about:blank snapshot (${countRefs(currentSnapshot)} refs)`);
            return {
              ok: false, goal, sessionId,
              turns: transcript.length, done: false,
              sessionRecoverNeeded: true,
              result: 'Snapshot became empty/about:blank during re-plan — session recovery required',
              transcript, executionTime: Date.now() - start,
            };
          }
          logger.info(`[playwright.agent] snapshot step: re-planning ${remainingAfterSnap.length} step(s) with fresh refs`);
          // Build placeholder warning for self-healing feedback loop (rate-limited: once per type per session)
          const placeholderWarningBlock = placeholderWarnings.size > 0
            ? `\n\n⚠️ PLACEHOLDER VIOLATION WARNING: The previous plan used bracketed placeholders like [${Array.from(placeholderWarnings).join('], [')}]. These placeholders cause catastrophic failures because they return literal text instead of actual content. NEVER use bracketed placeholders like [SEARCH RESULTS], [CONTENT], [DATA], etc. Use getPageText or run-code and let the result flow through automatically. Do NOT add a return step with placeholder text.`
            : '';
          const _snapReplanContent = await _fetchPageContentForReplan();
          try {
            const snapReplanRaw = await askWithMessages([
              { role: 'system', content: REPLAN_SYSTEM_PROMPT },
              { role: 'user', content: [
                `GOAL: ${_finalGoal || effectiveGoal}`,
                `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
                `STALE_REMAINING_PLAN: ${JSON.stringify(remainingAfterSnap)}`,
                ``,
                `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`,
                pruneSnapshot(extractInteractiveRefs(currentSnapshot)),
                _snapReplanContent,
                learnedRulesBlock,
                placeholderWarningBlock,
                ...(agentContext ? [
                  ``,
                  `AGENT CONTEXT (site-specific instructions — follow these for this service):`,
                  agentContext,
                ] : []),
              ].join('\n') },
            ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
            const snapReplanParsed = parseJson(snapReplanRaw);
            if (snapReplanParsed && Array.isArray(snapReplanParsed.plan) && snapReplanParsed.plan.length > 0) {
              logger.info(`[playwright.agent] snapshot re-plan: ${snapReplanParsed.plan.length} fresh steps — ${snapReplanParsed.thoughts || ''}`);
              if (snapReplanParsed.thoughts && _progressCallbackUrl) {
                postProgress(_progressCallbackUrl, {
                  type: 'agent:thought',
                  stepIndex: _stepIndex ?? 0,
                  thoughts: snapReplanParsed.thoughts,
                  phase: 'replan',
                });
              }
              plan = [...plan.slice(0, stepIndex + 1), ...snapReplanParsed.plan];
              replaceSendWithVerification(plan);
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
        agentId,
        stepIndex: _stepIndex,
        turn: stepIndex + 1,
        maxTurns: plan.length,
        action: step,
      });

      logger.info(`[playwright.agent] step ${stepIndex + 1}/${plan.length}: ${JSON.stringify(step)}`);
      let outcome;

      // ── external_skill step — delegate to an installed atomic skill ──────────
      if (step.action === 'external_skill') {
        const skillName = step.name;
        if (!skillName) {
          outcome = { ok: false, error: 'external_skill step missing required "name" field' };
        } else {
          try {
            const { name: _n, action: _a, ...skillArgs } = step;
            const result = await callExternalSkill(skillName, { sessionId, ...skillArgs }, 30000);
            const ok = result?.ok !== false && !result?.error;
            outcome = { ok, result: result?.stdout || result?.result || (ok ? `${skillName} completed` : ''), error: result?.error };
            logger.info(`[playwright.agent] external_skill ${skillName} ok=${ok}${outcome.error ? ' err=' + outcome.error : ''}`);
          } catch (err) {
            outcome = { ok: false, error: `external_skill ${skillName} threw: ${err.message}` };
          }
        }
        transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts: '' });
        postProgress(_progressCallbackUrl, {
          type: 'agent:turn', stepIndex: _stepIndex,
          turn: stepIndex + 1, maxTurns: plan.length,
          action: step, outcome: { ok: outcome.ok, result: outcome.result, error: outcome.error }, thoughts: '',
        });
        if (!outcome.ok) {
          if (totalRepairs >= maxRepairs) {
            logger.warn(`[playwright.agent] external_skill ${skillName} failed — repair limit (${maxRepairs}) reached; surfacing ask_user`);
            return { ..._failureAskUser(`External skill "${skillName}" failed: ${outcome.error}`), transcript };
          }
          totalRepairs++;
          logger.info(`[playwright.agent] external_skill ${skillName} failed — repair ${totalRepairs}/${maxRepairs}: ${outcome.error}`);
          // Take a fresh snapshot to give repair LLM current page state
          const repairSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
          if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;
          try {
            const repairRaw = await askWithMessages([
              { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
              { role: 'user', content: [`GOAL: ${_finalGoal || effectiveGoal}`, `FAILED_STEP: ${JSON.stringify(step)}`, `ERROR: ${outcome.error}`, `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex + 1))}`, ``, `SNAPSHOT:`, trimSnapshot(currentSnapshot)].join('\n') },
            ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
            const repairParsed = parseJson(repairRaw);
            if (repairParsed && Array.isArray(repairParsed.repair) && repairParsed.repair.length > 0) {
              plan = [...plan.slice(0, stepIndex), ...repairParsed.repair, ...plan.slice(stepIndex + 1)];
              logger.info(`[playwright.agent] external_skill repair: ${repairParsed.repair.length} corrective steps`);
            } else {
              stepIndex++;
            }
          } catch (_) { stepIndex++; }
        } else {
          // Re-snapshot after a successful external_skill — DOM may have changed (e.g. compose window opened)
          const postSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
          if (postSnap.ok && postSnap.result) {
            currentSnapshot = postSnap.result;
            // Re-plan remaining steps with fresh refs if DOM changed significantly
            const remaining = plan.slice(stepIndex + 1);
            if (remaining.length > 0 && countRefs(currentSnapshot) > 0) {
              try {
                // Build placeholder warning for self-healing feedback loop (rate-limited: once per type per session)
                const extPlaceholderWarning = placeholderWarnings.size > 0
                  ? `\n\n⚠️ PLACEHOLDER VIOLATION WARNING: The previous plan used bracketed placeholders like [${Array.from(placeholderWarnings).join('], [')}]. These placeholders cause catastrophic failures because they return literal text instead of actual content. NEVER use bracketed placeholders like [SEARCH RESULTS], [CONTENT], [DATA], etc. Use getPageText or run-code and let the result flow through automatically. Do NOT add a return step with placeholder text.`
                  : '';
                const snapReplanRaw = await askWithMessages([
                  { role: 'system', content: REPLAN_SYSTEM_PROMPT },
                  { role: 'user', content: [`GOAL: ${_finalGoal || effectiveGoal}`, `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`, `STALE_REMAINING_PLAN: ${JSON.stringify(remaining)}`, ``, `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`, extractInteractiveRefs(currentSnapshot), learnedRulesBlock, extPlaceholderWarning, ...(agentContext ? [``, `AGENT CONTEXT (site-specific instructions — follow these for this service):`, agentContext] : [])].join('\n') },
                ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
                const snapReplanParsed = parseJson(snapReplanRaw);
                if (snapReplanParsed && Array.isArray(snapReplanParsed.plan) && snapReplanParsed.plan.length > 0) {
                  plan = [...plan.slice(0, stepIndex + 1), ...snapReplanParsed.plan];
                  logger.info(`[playwright.agent] external_skill re-plan: ${snapReplanParsed.plan.length} fresh steps after ${skillName}`);
                  replaceSendWithVerification(plan);
                }
              } catch (_) { /* non-fatal — continue with stale plan */ }
            }
          }
          stepIndex++;
        }
        continue;
      }

      const unresolvedCredToken = findUnresolvedCredentialToken(step);
      if (
        unresolvedCredToken &&
        ['fill', 'type', 'find-label', 'find-role'].includes(step.action)
      ) {
        logger.warn(`[playwright.agent] refusing unresolved credential token in step ${stepIndex + 1}: ${unresolvedCredToken}`);
        return {
          ok: false, goal, sessionId,
          turns: transcript.length, done: false,
          loginWallDetected: true,
          needsCredentials: true,
          result: `Unresolved credential token ${unresolvedCredToken} in ${step.action} step — escalating to auth flow`,
          transcript, executionTime: Date.now() - start,
        };
      }

      // ── Page-ready pre-condition: lightweight about:blank check ──────────────
      // page.goto() with waitUntil:'domcontentloaded' already ensures the page is loaded.
      // With direct Playwright handles, wrong-element risk is eliminated — no need for
      // body.innerText.length heuristic. Keep only about:blank detection as safety net.
      if ((step.action === 'fill' || step.action === 'type') && (step.text || step.value)) {
        _checkDeadline();
        let _isBlank = false;
        const _engineReady = await _engineEval(sessionId, 'window.location.href');
        if (_engineReady?.ok && _engineReady.result) {
          _isBlank = /about:blank/i.test(String(_engineReady.result));
        } else {
          const _readyCheck = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
          _isBlank = _readyCheck?.ok && /about:blank/i.test(String(_readyCheck.result || ''));
        }
        if (_isBlank) {
            logger.warn(`[playwright.agent] page-ready guard: page is about:blank before ${step.action} — recovering by navigating to ${url || 'start URL'}`);
            // Recovery: navigate back to start URL, wait for stabilisation, re-snapshot
            if (url) {
              const _engineNav = await _engineNavigate(sessionId, url, Math.max(timeoutMs, 30000));
              if (!_engineNav?.ok) {
                await browserAct({ action: 'navigate', url, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) }).catch(() => {});
              }
              await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 10000 }).catch(() => {});
              const _recoverSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
              if (_recoverSnap.ok && _recoverSnap.result) currentSnapshot = _recoverSnap.result;
              // Check if page is still blank after recovery
              const _recoverUrl = await _engineEval(sessionId, 'window.location.href');
              const _stillBlank = _recoverUrl?.ok && /about:blank/i.test(String(_recoverUrl.result));
              if (!_stillBlank) {
                logger.info(`[playwright.agent] page-ready guard: recovered from about:blank — invalidating refs and re-planning`);
                // Invalidate engine snapshot so stale refs are not reused
                invalidateEngineSnapshot(sessionId);
                // Re-plan from the fresh snapshot instead of retrying with potentially stale refs
                if (totalRepairs < maxRepairs) {
                  totalRepairs++;
                  try {
                    const _recoverRepairRaw = await askWithMessages([
                      { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
                      { role: 'user', content: [
                        `GOAL: ${_finalGoal || effectiveGoal}`,
                        `FAILED_STEP: ${JSON.stringify(step)}`,
                        `ERROR: Page was about:blank but has been recovered. Re-plan from the current page state.`,
                        `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex))}`,
                        ``,
                        `SNAPSHOT:`,
                        trimSnapshot(currentSnapshot),
                      ].join('\n') },
                    ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
                    const _recoverRepairParsed = parseJson(_recoverRepairRaw);
                    if (_recoverRepairParsed && Array.isArray(_recoverRepairParsed.repair) && _recoverRepairParsed.repair.length > 0) {
                      plan = [...plan.slice(0, stepIndex), ..._recoverRepairParsed.repair, ...plan.slice(stepIndex + 1)];
                      logger.info(`[playwright.agent] page-ready guard recovery re-plan: ${_recoverRepairParsed.repair.length} steps`);
                    } else { stepIndex++; }
                  } catch (_) { stepIndex++; }
                } else {
                  stepIndex++;
                }
                continue;
              }
            }
            // Recovery failed or no URL — fall through to repair path
            logger.warn(`[playwright.agent] page-ready guard: recovery failed — falling back to repair`);
            outcome = { ok: false, error: `Page is about:blank — cannot safely ${step.action} into unknown element` };
            transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts: 'page-ready guard: blank page' });
            postProgress(_progressCallbackUrl, {
              type: 'agent:turn', stepIndex: _stepIndex,
              turn: stepIndex + 1, maxTurns: plan.length,
              action: step, outcome: { ok: false, error: outcome.error }, thoughts: 'page-ready guard: blank page',
            });
            // Force repair path
            if (totalRepairs >= maxRepairs) {
              logger.warn(`[playwright.agent] page-ready guard: repair limit (${maxRepairs}) reached; surfacing ask_user`);
              return { ..._failureAskUser(`Page stayed blank — cannot execute ${step.action}`), transcript };
            }
            totalRepairs++;
            const _guardSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
            if (_guardSnap.ok && _guardSnap.result) currentSnapshot = _guardSnap.result;
            try {
              const _guardRepairRaw = await askWithMessages([
                { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
                { role: 'user', content: [`GOAL: ${_finalGoal || effectiveGoal}`, `FAILED_STEP: ${JSON.stringify(step)}`, `ERROR: Page was about:blank — the page may still be loading or redirecting. Wait for the page to fully load before retrying.`, `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex + 1))}`, ``, `SNAPSHOT:`, trimSnapshot(currentSnapshot)].join('\n') },
              ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
              const _guardRepairParsed = parseJson(_guardRepairRaw);
              if (_guardRepairParsed && Array.isArray(_guardRepairParsed.repair) && _guardRepairParsed.repair.length > 0) {
                plan = [...plan.slice(0, stepIndex), ..._guardRepairParsed.repair, ...plan.slice(stepIndex + 1)];
                logger.info(`[playwright.agent] page-ready guard repair: ${_guardRepairParsed.repair.length} corrective steps`);
              } else { stepIndex++; }
            } catch (_) { stepIndex++; }
            continue;
        }
      }

      // ── Deduplication: skip redundant fill/type of same text ───────────────
      // Check both 'value' (fill) and 'text' (type) properties for deduplication
      // NOTE: Text is only marked as typed AFTER a confirmed successful action.
      // Marking before execution would prevent retries on failure.
      const _pendingDedupText = (step.action === 'fill' || step.action === 'type') && typeof (step.value || step.text) === 'string'
        ? (step.value || step.text).trim().toLowerCase()
        : null;
      if (_pendingDedupText && _pendingDedupText.length > 0 && _typedTexts.has(_pendingDedupText)) {
        logger.info(`[playwright.agent] deduplication: skipping duplicate ${step.action} for "${(step.value || step.text).slice(0, 40)}..."`);
        stepIndex++;
        continue;
      }

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
        } else if (step.action === 'getPageText') {
          // ── Universal waitForStableText guard ─────────────────────────────────
          // Ensure the page has stopped changing before we read it.
          // If the last executed step was already waitForStableText (or waitForNavigation),
          // skip the auto-inject to avoid double-polling.
          // This is intentionally unconditional — works for AI chat, search results,
          // stock filters, form submissions, or any page where response time is unknown.
          const _lastAction = transcript.length > 0 ? transcript[transcript.length - 1].action?.action : null;
          let stableTextResult = null;
          if (_lastAction !== 'waitForStableText' && _lastAction !== 'waitForNavigation') {
            logger.info(`[playwright.agent] auto-injecting waitForStableText before getPageText (last step: ${_lastAction || 'none'})`);
            const stableOutcome = await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 30000 });
            // Capture the stable text result — this is the content we waited for
            if (stableOutcome.ok && stableOutcome.result && stableOutcome.result.length > 1000) {
              stableTextResult = stableOutcome.result;
              logger.info(`[playwright.agent] captured ${stableTextResult.length} chars from waitForStableText, skipping redundant getPageText`);
            }
          }
          
          // Try extractContent first for rich content extraction
          logger.info(`[playwright.agent] attempting extractContent for rich content extraction`);
          const extractOutcome = await browserAct({ action: 'extractContent', sessionId, headed, timeoutMs: 25000 });

          const extractLinks = extractOutcome.extractedContent?.links?.length || 0;
          const extractImages = extractOutcome.extractedContent?.images?.length || 0;
          const extractVideos = extractOutcome.extractedContent?.videos?.length || 0;
          const extractDocs = extractOutcome.extractedContent?.documents?.length || 0;
          const hasRichStructure = extractLinks > 0 || extractImages > 0 || extractVideos > 0 || extractDocs > 0;
          const isSubstantialText = extractOutcome.result && extractOutcome.result.length >= 1000;
          const useExtractContent = extractOutcome.ok && extractOutcome.result && (hasRichStructure || isSubstantialText);

          if (useExtractContent) {
            outcome = extractOutcome;
            logger.info(`[playwright.agent] extractContent succeeded: ${outcome.result.length} chars with ${extractLinks} links, ${extractImages} images`);
          } else if (stableTextResult) {
            // extractContent returned sparse/unstructured content but waitForStableText captured a rich page snapshot.
            logger.info(`[playwright.agent] extractContent sparse or unstructured — falling back to waitForStableText result (${stableTextResult.length} chars)`);
            outcome = { ok: true, action: 'getPageText', sessionId, result: stableTextResult, executionTime: 0 };
          } else {
            // Fallback to regular getPageText if extractContent fails
            logger.info(`[playwright.agent] extractContent failed or returned minimal content, falling back to getPageText`);
            outcome = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs });
          }
          
          // If both extractContent and getPageText came back empty but waitForStableText had content, use that as fallback
          if ((!outcome.result || outcome.result.length < 100) && stableTextResult) {
            outcome = { ok: true, action: 'getPageText', sessionId, result: stableTextResult, executionTime: 0 };
            logger.info(`[playwright.agent] content extraction returned empty — falling back to waitForStableText result (${stableTextResult.length} chars)`);
          }
          // CRITICAL: Set lastGetPageTextResult so return step can substitute it
          if (outcome.result) {
            lastGetPageTextResult = outcome.result;
            logger.info(`[playwright.agent] set lastGetPageTextResult: ${lastGetPageTextResult.length} chars`);
          }
        } else if (step.action === 'wait') {
          const ms = Math.min(parseInt(step.ms || step.duration || 2000, 10), 5000);
          await new Promise(r => setTimeout(r, ms));
          outcome = { ok: true, result: `waited ${ms}ms` };
        } else if (
          // ── Mail recipient fill — bypass browser.act's click+Meta+a+type sequence.
          // Gmail's To field is a chip/token widget: Meta+a (⌘A) triggers Gmail's
          // global "Select All messages" shortcut, killing focus on the To input before
          // `type` fires — nothing gets typed.  Fix: click to focus, type keystrokes
          // directly (no Meta+a), then Tab to confirm the chip and move to Subject.
          step.action === 'fill' &&
          typeof step.text === 'string' &&
          /\S+@\S+\.\S+/.test(step.text) &&
          (['gmail.agent', 'outlook.agent', 'yahoo.agent'].includes(agentId) ||
            (hostname || '').includes('mail.google.com') ||
            (hostname || '').includes('outlook.live.com') ||
            (hostname || '').includes('mail.yahoo.com'))
        ) {
          logger.info(`[playwright.agent] mail recipient fill — using click+type+Tab to bypass Meta+a focus loss`);
          await browserAct({ action: 'click', selector: step.selector, sessionId, headed, timeoutMs });
          await new Promise(r => setTimeout(r, 200));
          await browserAct({ action: 'type', text: step.text, sessionId, headed, timeoutMs });
          await new Promise(r => setTimeout(r, 400));
          await browserAct({ action: 'press', key: 'Tab', sessionId, headed, timeoutMs: 3000 });
          await new Promise(r => setTimeout(r, 600));
          outcome = { ok: true, action: 'fill', sessionId, result: 'recipient entered via click+type+Tab' };
        } else {
          // ── Platform-correct clipboard shortcut scrubber ───────────────────
          // LLMs routinely emit { action: 'press', key: 'Ctrl+v' } on macOS.
          // On macOS, paste is Meta+V (⌘V) — Ctrl+v does nothing. Auto-rewrite
          // so we don't silently fail and burn a repair cycle. Mirror the
          // rewrite for non-macOS in case a plan emits Cmd+* / Meta+*.
          if (step.action === 'press' && typeof step.key === 'string') {
            const k = step.key.trim();
            if (process.platform === 'darwin') {
              const fixed = k.replace(/^(Ctrl|Control)\+/i, 'Meta+');
              if (fixed !== k) {
                logger.info(`[playwright.agent] scrubbing clipboard shortcut on macOS: "${k}" → "${fixed}"`);
                step = { ...step, key: fixed };
              }
            } else {
              const fixed = k.replace(/^(Meta|Cmd|Command)\+/i, 'Control+');
              if (fixed !== k) {
                logger.info(`[playwright.agent] scrubbing clipboard shortcut on ${process.platform}: "${k}" → "${fixed}"`);
                step = { ...step, key: fixed };
              }
            }
          }
          // Capture pre-click state for submit verification (used after click succeeds)
          let _preClickState = null;
          if (step.action === 'click' && _isSubmitLikeClick(step, _hasFillOrType)) {
            try {
              const _page = engine.getPage(sessionId);
              if (_page) {
                _preClickState = await _page.evaluate(() => ({
                  url: window.location.href,
                  modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
                  bodyLen: (document.body?.innerText || '').length,
                }));
              }
            } catch (_) {}
          }
          outcome = await browserAct({ ...step, sessionId, headed, timeoutMs });
          // Attach pre-click state for submit verification below
          if (_preClickState) outcome._preClickState = _preClickState;
        }
      } catch (err) {
        outcome = { ok: false, error: err.message };
      }

      // ── iframe fallback: retry in first visible iframe when main frame fails ──
      // Sites like w3schools TryIt embed content in iframes; page.evaluate() runs
      // in the main frame which may not have the DOM the LLM targeted.
      const _iframeError = !outcome.ok && outcome.error &&
        (/document is not defined|Cannot read properties of null|execution context was destroyed/i.test(outcome.error));
      const _iframeEligible = _iframeError && ['evaluate', 'run-code', 'getPageText'].includes(step.action);
      if (_iframeEligible) {
        logger.info(`[playwright.agent] iframe fallback: "${step.action}" failed with "${outcome.error.slice(0, 60)}" — retrying inside first iframe`);
        try {
          let iframeCode;
          if (step.action === 'getPageText') {
            iframeCode = `async page => {
              const frames = page.frames();
              const contentFrame = frames.find(f => f !== page.mainFrame() && f.url() !== 'about:blank') || frames[1];
              if (!contentFrame) return 'No iframe found';
              return await contentFrame.evaluate(() => document.body ? document.body.innerText.substring(0, 50000) : '');
            }`;
          } else if (step.action === 'evaluate') {
            iframeCode = `async page => {
              const frames = page.frames();
              const contentFrame = frames.find(f => f !== page.mainFrame() && f.url() !== 'about:blank') || frames[1];
              if (!contentFrame) return 'No iframe found';
              return await contentFrame.evaluate(() => ${step.text || 'document.title'});
            }`;
          } else {
            // run-code: wrap user code to target first content iframe
            const userCode = step.code || '';
            iframeCode = `async page => {
              const frames = page.frames();
              const contentFrame = frames.find(f => f !== page.mainFrame() && f.url() !== 'about:blank') || frames[1];
              if (!contentFrame) return 'No iframe found';
              const iframeFn = ${userCode.replace(/^async\s*page\s*=>/, 'async frame =>')};
              return await iframeFn(contentFrame);
            }`;
          }
          const iframeOutcome = await browserAct({ action: 'run-code', code: iframeCode, sessionId, headed, timeoutMs });
          if (iframeOutcome.ok) {
            outcome = iframeOutcome;
            logger.info(`[playwright.agent] iframe fallback succeeded: ${(outcome.result || '').length} chars`);
          }
        } catch (_iframeErr) {
          logger.warn(`[playwright.agent] iframe fallback threw: ${_iframeErr.message}`);
        }
      }

      logger.info(`[playwright.agent] step ${stepIndex + 1} ok=${outcome.ok}${outcome.error ? ' err=' + outcome.error : ''}`);
      const thoughts = outcome.ok ? '' : (outcome.error || 'failed');
      transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts });

      // ── Mutation submit tracking + auto-verify state change ────────────────
      // Record _mutationClickTs when a click with purpose:'submit' succeeds after
      // a fill/type step. Used by the goal judge and replan guard to prevent
      // duplicate mutations (e.g. double-posting a tweet).
      //
      // AUTO-VERIFY: For submit-like clicks, verify the action actually happened
      // by checking for observable state change (modal closed, URL changed, content
      // changed). If no state change within 3s, mark as failed — the button may be
      // disabled, form may have validation errors, or wrong button was clicked.
      // This is deterministic — no LLM-generated "expected" field needed.
      if (outcome.ok) {
        if (step.action === 'fill' || step.action === 'type') {
          _hasFillOrType = true;
          if (_pendingDedupText) {
            _typedTexts.add(_pendingDedupText);
          }
        }
        if (step.action === 'click' && _isSubmitLikeClick(step, _hasFillOrType)) {
          const _purpose = String(step.purpose || '').toLowerCase();
          const _selHint = String(step.selector || step.ref || step['aria-label'] || '').toLowerCase();
          // Capture state before verification (the click already happened,
          // so we read current state as "before" — the verification function
          // will wait for FURTHER state change from this point)
          const _verifyResult = await _verifySubmitStateChange(sessionId, outcome._preClickState, 3000);
          if (_verifyResult.verified) {
            _mutationClickTs = Date.now();
            logger.info(`[playwright.agent] mutation submit verified: click at ${_mutationClickTs} (purpose=${_purpose || 'inferred'}, selector=${_selHint.slice(0, 40)}, change=${_verifyResult.reason})`);
          } else {
            // Submit click succeeded but no state change — likely a false positive
            outcome = { ok: false, error: `Submit verification failed: ${_verifyResult.reason}` };
            logger.warn(`[playwright.agent] submit verification FAILED: click succeeded but no state change — ${_verifyResult.reason} (purpose=${_purpose || 'inferred'}, selector=${_selHint.slice(0, 40)})`);
          }
        }
      }

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
        if (step.action === 'run-code' && outcome.result != null) {
          lastRunCodeResult = typeof outcome.result === 'string' ? outcome.result : (outcome.stdout || String(outcome.result));
        }
        if (step.action === 'getPageText' && outcome.result) {
          lastGetPageTextResult = outcome.result;
          logger.info(`[playwright.agent] set lastGetPageTextResult: ${lastGetPageTextResult?.length || 0} chars`);

          // ── HTTP error page detection ─────────────────────────────────────
          // If getPageText captured an HTTP error page instead of real AI content,
          // navigate back to the start URL and re-plan the full task rather than
          // letting the garbage text flow downstream into synthesize.
          const _httpErr = _detectHttpErrorPage(outcome.result);
          let _httpRetryPlan = null;
          if (_httpErr && totalRepairs < maxRepairs && url) {
            totalRepairs++;
            logger.warn(`[playwright.agent] HTTP ${_httpErr} error page detected in getPageText — full retry ${totalRepairs}/${maxRepairs}`);
            try {
              await browserAct({ action: 'navigate', url, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) });
              await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 15000 });
              const retrySnap = await _fastSnapshot(sessionId, headed, timeoutMs);
              if (retrySnap.ok && retrySnap.result) currentSnapshot = retrySnap.result;
              // Build placeholder warning for self-healing feedback loop
              const httpPlaceholderWarning = placeholderWarnings.size > 0
                ? `\n\n⚠️ PLACEHOLDER VIOLATION WARNING: The previous plan used bracketed placeholders like [${Array.from(placeholderWarnings).join('], [')}]. These placeholders cause catastrophic failures because they return literal text instead of actual content. NEVER use bracketed placeholders like [SEARCH RESULTS], [CONTENT], [DATA], etc. Use getPageText or run-code and let the result flow through automatically. Do NOT add a return step with placeholder text.`
                : '';
              const retryPlanRaw = await askWithMessages([
                { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
                { role: 'user', content: `GOAL: ${effectiveGoal}\n\nNOTE: A previous attempt failed because the page returned an HTTP ${_httpErr} error. The page has been refreshed — please re-plan the full task from the current snapshot.${httpPlaceholderWarning}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}${agentContext ? `\n\nAGENT CONTEXT:\n${agentContext}` : ''}` },
              ], { temperature: 0.1, maxTokens: 2048, responseTimeoutMs: 30000 });
              const retryPlanParsed = parseJson(retryPlanRaw);
              if (retryPlanParsed && Array.isArray(retryPlanParsed.plan) && retryPlanParsed.plan.length > 0) {
                logger.info(`[playwright.agent] HTTP error retry: re-planned ${retryPlanParsed.plan.length} step(s) — ${retryPlanParsed.thoughts || ''}`);
                // Store plan for restart outside try-catch (continue can't cross function boundary)
                _httpRetryPlan = retryPlanParsed.plan;
              }
            } catch (retryErr) {
              logger.warn(`[playwright.agent] HTTP error retry re-plan failed: ${retryErr.message}`);
            }
            // Execute retry restart outside try-catch to allow continue
            if (_httpRetryPlan) {
              plan = _httpRetryPlan;
              stepIndex = 0;
              lastGetPageTextResult = null;
              _typedTexts.clear();
              replaceSendWithVerification(plan);
              continue;
            }
          } else if (_httpErr) {
            logger.warn(`[playwright.agent] HTTP ${_httpErr} error page in getPageText — repair budget exhausted or no start URL, proceeding with error content`);
          }
        }
        if (step.action === 'sendEmailWithVerification' && !_emailAlreadySent) {
          _emailAlreadySent = true;
          finalResult = outcome.result != null ? String(outcome.result) : 'Email sent and verified successfully';
          const _emailRecipient = (goal.match(/\b([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})\b/) || [])[1] || null;
          const _emailSubjectMatch = goal.match(/subject\s*['"]\s*([^'"]+)['"]/i) || goal.match(/subject\s+([^,]+)/i);
          const _emailSubject = _emailSubjectMatch ? _emailSubjectMatch[1].trim() : null;
          _emailSendVerification = {
            sent: true,
            recipient: _emailRecipient,
            subject: _emailSubject,
            result: finalResult,
            timestamp: new Date().toISOString(),
          };
          logger.info(`[playwright.agent] email send verified — recipient=${_emailRecipient || 'unknown'}, subject=${_emailSubject || 'unknown'}`);
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
        if (_isMailAgentTask && _isComposeTask && step.action === 'fill' && typeof step.text === 'string' && step.text.length > 80) {
          try {
            const _needleJson = JSON.stringify(step.text.slice(0, 40));
            const verifySnap = await browserAct({
              action: 'run-code',
              code: `async page => { return await page.evaluate(function(){
                var needle = ${_needleJson};
                var bodies = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'));
                return bodies.some(function(el){ return (el.innerText || el.value || '').includes(needle); }) ? 'ok' : 'empty';
              }); }`,
              sessionId, headed, timeoutMs,
            });
            if (verifySnap.ok && verifySnap.result === 'empty') {
              logger.warn(`[playwright.agent] post-fill body verification: text not found in contenteditable/textarea — triggering repair to learn correct approach`);
              outcome = { ok: false, error: 'fill succeeded but body text not found in page — element is likely a contenteditable div; use run-code with page.keyboard.type() or page.getByRole("textbox").fill() instead of a plain fill step' };
            }
          } catch (_) { /* verification failure is non-fatal — proceed */ }
        }

        // (recipient chip confirmation handled pre-emptively in the
        //  mail recipient fill interceptor above via click+type+Tab)

        // ── Invalidate engine snapshot after DOM-mutating actions ──────────────
        // The plan-bound refs are no longer valid after the DOM changes.
        // The post-action snapshot below will create a fresh generation.
        if (isDomMutating && outcome.ok) {
          invalidateEngineSnapshot(sessionId);
        }

        // ── Expectation-Driven Execution: Verify action achieved expected outcome ─────
        // Instead of blind DOM change detection, we verify that the action achieved its goal
        // For recipe-driven tasks, skip automatic post-snapshot for fill/type/press —
        // the recipe already navigated to the target page, these actions don't need re-planning.
        const _skipAutoReplan = recipeWasUsed && ['fill', 'type', 'press', 'press-key', 'select', 'check', 'uncheck'].includes(step.action);
        if ((step.expected || (isDomMutating && !_skipAutoReplan))) {
          // Capture pre-snapshot before updating currentSnapshot (used by confidence scoring below)
          const _preStepSnapshot = currentSnapshot;
          // Take a fresh snapshot after the action
          const postSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
          if (postSnap.ok && postSnap.result) {
            currentSnapshot = postSnap.result;
          }
          // Attach pre/post to outcome so confidence scoring can use them without extra snapshot calls
          outcome._preStepSnapshot  = _preStepSnapshot;
          outcome._postStepSnapshot = currentSnapshot;

          // Verify expectation if defined
          if (step.expected) {
            const expectationResult = await verifyExpectation(step, sessionId, headed, timeoutMs);
            
            if (!expectationResult.satisfied) {
              logger.warn(`[playwright.agent] Expectation failed for ${step.action}: ${expectationResult.reason}`);
              
              // Apply tiered failure handling
              const tier1Result = handleKnownFailures(step, {}, currentSnapshot);
              let failureAnalysis = tier1Result;
              
              if (!failureAnalysis) {
                const tier2Result = handleElementBasedFailures(step, currentSnapshot);
                failureAnalysis = tier2Result;
              }
              
              if (!failureAnalysis) {
                failureAnalysis = await handleUnknownFailure(step, currentSnapshot, { message: expectationResult.reason });
              }
              
              // Handle the failure based on analysis
              if (failureAnalysis.cause === 'login_wall') {
                logger.warn(`[playwright.agent] Login wall detected via expectation failure — escalating to waitForAuth`);
                return {
                  ok: false, goal, sessionId,
                  turns: transcript.length, done: false,
                  loginWallDetected: true,
                  result: 'Login wall detected during expectation verification — escalating to waitForAuth',
                  transcript, executionTime: Date.now() - start,
                };
              } else if (failureAnalysis.cause === 'still_loading') {
                logger.info(`[playwright.agent] Page still loading — waiting and retrying expectation`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
                
                // Retry expectation verification
                const retryResult = await verifyExpectation(step, sessionId, headed, timeoutMs);
                if (retryResult.satisfied) {
                  logger.info(`[playwright.agent] Expectation satisfied after wait`);
                } else {
                  logger.warn(`[playwright.agent] Expectation still failed after wait: ${retryResult.reason}`);
                  // Continue with the step but mark as having issues
                  outcome.warning = `Expectation not fully satisfied: ${retryResult.reason}`;
                }
              } else if (failureAnalysis.cause === 'error_page' || failureAnalysis.cause === 'server_error') {
                if (totalRepairs < maxRepairs) {
                  totalRepairs++;
                  logger.warn(`[playwright.agent] ${failureAnalysis.cause} detected — attempting repair ${totalRepairs}/${maxRepairs}`);
                  // Trigger repair logic similar to existing error handling
                  outcome = { ok: false, error: `${failureAnalysis.cause}: ${expectationResult.reason}` };
                } else {
                  logger.warn(`[playwright.agent] Repair budget exhausted for ${failureAnalysis.cause}`);
                  outcome.warning = `Possible ${failureAnalysis.cause}: ${expectationResult.reason}`;
                }
              } else {
                logger.info(`[playwright.agent] Unknown failure handled: ${failureAnalysis.reason}`);
                outcome.warning = `Unexpected issue: ${failureAnalysis.reason}`;
              }
            } else {
              logger.info(`[playwright.agent] Expectation satisfied for ${step.action}: ${expectationResult.reason}`);
            }
          }
          
        }

        // ── Per-step confidence scoring ───────────────────────────────────────────
        // After any DOM-mutating step succeeds, compute a heuristic confidence score
        // without an LLM call. If score < 0.5, fire a micro-replan for remaining steps.
        // This catches compounding errors early before they spiral into unrecoverable state.
        // Skip for recipe-driven fill/type/press — no post-snapshot was taken.
        if (DOM_MUTATING_ACTIONS.has(step.action) && outcome._postStepSnapshot && !_skipAutoReplan) {
          const _preSnap  = outcome._preStepSnapshot || '';
          const _postSnap = outcome._postStepSnapshot || '';
          let _stepConf = 1.0;
          const _preRefs  = countRefs(_preSnap);
          const _postRefs = countRefs(_postSnap);

          // Session loss: login page appeared during a non-navigate action
          if (!['navigate', 'goto'].includes(step.action) &&
              /accounts\.google\.com|\/login|\/signin|\/auth\b/i.test(_postSnap)) {
            _stepConf -= 0.5;
            logger.warn(`[playwright.agent] step-confidence: login redirect detected during ${step.action} (conf=${_stepConf.toFixed(2)})`);
          }
          // Compose window closed unexpectedly during a non-click action on a compose task
          if (_isComposeTask && _isMailAgentTask &&
              /new message|compose/i.test(_preSnap) &&
              !/new message|compose/i.test(_postSnap) &&
              !['click', 'navigate', 'goto'].includes(step.action)) {
            _stepConf -= 0.4;
            logger.warn(`[playwright.agent] step-confidence: compose window closed unexpectedly after ${step.action} (conf=${_stepConf.toFixed(2)})`);
          }
          // Sharp ref count drop — page navigated away unexpectedly
          if (_preRefs > 10 && _postRefs < 3) {
            _stepConf -= 0.3;
            logger.warn(`[playwright.agent] step-confidence: ref count dropped ${_preRefs}→${_postRefs} (conf=${_stepConf.toFixed(2)})`);
          }

          _stepConf = Math.max(0, _stepConf);
          if (_stepConf < 0.5 && totalRepairs < maxRepairs && stepIndex < plan.length - 1) {
            logger.warn(`[playwright.agent] step-confidence ${_stepConf.toFixed(2)} < 0.5 after step ${stepIndex + 1} (${step.action}) — triggering micro-replan for remaining ${plan.length - stepIndex - 1} step(s)`);
            const _microSnap = await _fastSnapshot(sessionId, headed, timeoutMs).catch(() => ({ ok: false }));
            if (_microSnap.ok && _microSnap.result) {
              currentSnapshot = _microSnap.result;
              const _microRemaining = plan.slice(stepIndex + 1);
              const _microContent = await _fetchPageContentForReplan();
              const _microRaw = await askWithMessages([
                { role: 'system', content: REPLAN_SYSTEM_PROMPT + domainLockBlock },
                { role: 'user', content: `GOAL: ${_finalGoal || effectiveGoal}\nSTALE_REMAINING:\n${JSON.stringify(_microRemaining)}\nFRESH_SNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}${_microContent}${agentContext ? `\n\nAGENT CONTEXT (site-specific instructions — follow these for this service):\n${agentContext}` : ''}` },
              ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 20000 }).catch(() => null);
              const _microParsed = _microRaw ? parseJson(_microRaw) : null;
              if (_microParsed && Array.isArray(_microParsed.plan) && _microParsed.plan.length > 0) {
                plan = [...plan.slice(0, stepIndex + 1), ..._microParsed.plan];
                logger.info(`[playwright.agent] step-confidence micro-replan: replaced ${_microRemaining.length} stale step(s) with ${_microParsed.plan.length} fresh step(s)`);
              }
            }
          }
        }

        // ── Chip input guard ─────────────────────────────────────────────────────
        // After a successful fill on a recipient/tag/chip field, ensure the next
        // planned steps include press Enter + snapshot to confirm chip creation.
        // This is a code-level guarantee — no LLM dependency, no rule-recall needed.
        // Applies to: Gmail To/CC/BCC, Slack DM recipient, Notion mention, Linear assignee, etc.
        if (step.action === 'fill') {
          const _chipFieldRe = /\b(to|cc|bcc|recipient|email|tag|label|member|assign|people|participants|invite)\b/i;
          const _selectorStr = String(step.selector || step.ref || '');
          const _ariaLabelStr = String(step['aria-label'] || '');
          const _isChipField = _chipFieldRe.test(_selectorStr) || _chipFieldRe.test(_ariaLabelStr) ||
            /input\[name=['"]?(to|cc|bcc)['"]?\]/i.test(_selectorStr) ||
            /textarea\[name=['"]?(to|cc|bcc)['"]?\]/i.test(_selectorStr);
          if (_isChipField) {
            const _nextStep = plan[stepIndex + 1];
            const _nextIsEnter = _nextStep?.action === 'press' && String(_nextStep?.key || '').toLowerCase() === 'enter';
            const _nextIsSnapshot = _nextStep?.action === 'snapshot';
            if (!_nextIsEnter && !_nextIsSnapshot) {
              plan.splice(stepIndex + 1, 0,
                { action: 'press', key: 'Enter' },
                { action: 'snapshot' }
              );
              logger.info('[playwright.agent] chip guard: injected Enter+snapshot after fill on chip/recipient field');
            } else if (_nextIsEnter) {
              // Enter is there but no snapshot after it — inject snapshot after the Enter
              const _stepAfterEnter = plan[stepIndex + 2];
              if (!_stepAfterEnter || _stepAfterEnter.action !== 'snapshot') {
                plan.splice(stepIndex + 2, 0, { action: 'snapshot' });
                logger.info('[playwright.agent] chip guard: injected snapshot after Enter on chip/recipient field');
              }
            }
          }
        }

        stepIndex++;
        continue;
      }

      // ── Step failed → repair ─────────────────────────────────────────────────
      // Check for Chrome crash and handle specially
      if (outcome.chromeCrash) {
        logger.error(`[playwright.agent] Chrome crash detected during step ${stepIndex + 1} — using debugging repair`);
        
        // Return special crash result to trigger debugging repair instead of generic recovery
        return {
          ok: false, goal, sessionId,
          turns: transcript.length, done: false,
          chromeCrash: true,
          result: `Chrome browser crashed during step ${stepIndex + 1} (${step.action}): ${outcome.error}`,
          transcript, error: outcome.error, executionTime: Date.now() - start,
          debugContext: outcome.debugContext
        };
      }

      if (totalRepairs >= maxRepairs) {
        logger.warn(`[playwright.agent] step ${stepIndex + 1} failed — repair limit (${maxRepairs}) reached; trying turn-loop fallback before ask_user`);
        // ── Turn-loop fallback: observe→act→verify recovery ──
        // Instead of immediately surfacing ask_user, try a lightweight turn loop
        // that uses the injection action types (reactFill, clickByText, etc.)
        // for more deterministic interaction. Falls back to ask_user if it fails.
        try {
          const _turnLoopResult = await _executeTurnLoopFallback({
            goal: _finalGoal,
            sessionId,
            headed,
            timeoutMs,
            agentContext,
            transcript,
            deadline: _deadline,
            start,
          });
          if (_turnLoopResult.ok) {
            logger.info(`[playwright.agent] turn-loop fallback succeeded — returning`);
            return _turnLoopResult;
          }
          logger.warn(`[playwright.agent] turn-loop fallback failed: ${_turnLoopResult.error} — surfacing ask_user`);
        } catch (_turnLoopErr) {
          logger.warn(`[playwright.agent] turn-loop fallback threw: ${_turnLoopErr.message} — surfacing ask_user`);
        }
        return { ..._failureAskUser(`Step ${stepIndex + 1} (${step.action}) failed: ${outcome.error}`), transcript };
      }

      totalRepairs++;
      logger.info(`[playwright.agent] step ${stepIndex + 1} failed — repair ${totalRepairs}/${maxRepairs}: ${outcome.error}`);

      // ── Overlay-blocked click recovery (force-click → eval-click → Escape) ────
      // When a click fails because another element intercepts pointer events, try
      // in order:
      //   1. Force-click: bypass Playwright's pointer-events check, dispatch click
      //      event directly. Works when the overlay is a transparent Shadow DOM host
      //      (e.g. LinkedIn's #interop-outlet) that doesn't actually block the click.
      //   2. Eval-click: dispatch a synthetic click() via page.evaluate. Works even
      //      when force-click fails (e.g. element is covered by a real overlay).
      //   3. Escape: ONLY if no modal/dialog is present. Pressing Escape closes
      //      modals — which is catastrophic when the "overlay" IS the composer modal
      //      we want to interact with (the root cause of the LinkedIn whack-a-mole).
      if (/intercepts pointer events/i.test(outcome.error || '') && (step.action === 'click' || step.action === 'fill')) {
        logger.info(`[playwright.agent] overlay-blocked click detected — trying force-click/eval before Escape`);
        const _overlaySelector = step.selector || step.ref || '';
        try {
          // ── Step 1: Force-click via engine ──────────────────────────────────
          // Retry the same action with force:true — bypasses actionability checks.
          const _forceOutcome = await browserAct({ ...step, action: step.action, sessionId, headed, timeoutMs, snapshot: currentSnapshot, force: true }).catch(e => ({ ok: false, error: e.message }));
          if (_forceOutcome.ok) {
            logger.info(`[playwright.agent] overlay recovery: force-click succeeded — continuing without LLM repair`);
            transcript.push({ step, result: 'ok (force-click bypassed overlay)', phase: 'repair' });
            stepIndex++;
            continue;
          }
          logger.info(`[playwright.agent] overlay recovery: force-click failed — trying eval-click`);

          // ── Step 2: Eval-click via page.evaluate ────────────────────────────
          // Dispatch a synthetic click event on the resolved element. This bypasses
          // all Playwright actionability checks and works even when the element is
          // fully covered by an overlay.
          const _ePage = engine.getPage(sessionId);
          if (_ePage && _overlaySelector) {
            // Resolve the ref to a DOM element and click it via JS
            const _evalClickRes = await _ePage.evaluate((sel) => {
              // Try ariaSnapshot ref → element via aria-ref attribute
              let el = document.querySelector(`[aria-ref="${sel}"]`);
              // Try by ref number in snapshot (Playwright aria refs)
              if (!el && /^e\d+$/i.test(sel)) {
                // Walk interactive elements and try to match by ref order
                const interactive = document.querySelectorAll('[role="button"], [role="link"], [role="textbox"], button, a, input, [contenteditable="true"]');
                // Playwright aria refs are assigned in DOM order — try to find by data-testid or aria-label match
                // Fallback: try clicking the element directly via document.elementFromPoint or known selectors
              }
              if (el) { el.click(); return 'clicked:' + sel; }
              return 'not-found:' + sel;
            }, _overlaySelector).catch(() => null);
            if (_evalClickRes && _evalClickRes.startsWith('clicked:')) {
              logger.info(`[playwright.agent] overlay recovery: eval-click succeeded (${_evalClickRes}) — continuing`);
              transcript.push({ step, result: 'ok (eval-click bypassed overlay)', phase: 'repair' });
              stepIndex++;
              continue;
            }
          }

          // ── Step 3: Escape — ONLY if no modal/dialog is present ─────────────
          // Pressing Escape closes modals. When the "overlay" IS the composer modal
          // (e.g. LinkedIn's #interop-outlet), Escape destroys the very modal we
          // want to interact with — causing the whack-a-mole loop.
          const _ePage2 = engine.getPage(sessionId);
          let _hasModal = false;
          if (_ePage2) {
            try {
              _hasModal = await _ePage2.evaluate(() => !!document.querySelector('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]'));
            } catch (_) {}
          }
          if (_hasModal) {
            logger.warn(`[playwright.agent] overlay recovery: modal/dialog detected — NOT pressing Escape (would close the composer). Falling through to LLM repair.`);
          } else {
            logger.info(`[playwright.agent] overlay recovery: no modal — pressing Escape and retrying once`);
            await browserAct({ action: 'press', key: 'Escape', sessionId, headed, timeoutMs: 3000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
            invalidateEngineSnapshot(sessionId);
            const _overlaySnap = await _fastSnapshot(sessionId, headed, timeoutMs);
            if (_overlaySnap.ok && _overlaySnap.result) currentSnapshot = _overlaySnap.result;
            const _retryOutcome = await browserAct({ ...step, action: step.action, sessionId, headed, timeoutMs, snapshot: currentSnapshot }).catch(e => ({ ok: false, error: e.message }));
            if (_retryOutcome.ok) {
              logger.info(`[playwright.agent] overlay recovery: retry succeeded after Escape — continuing without LLM repair`);
              transcript.push({ step, result: 'ok (retried after Escape)', phase: 'repair' });
              stepIndex++;
              continue;
            }
            logger.warn(`[playwright.agent] overlay recovery: retry still failed — falling through to LLM repair`);
          }
        } catch (_overlayErr) {
          logger.warn(`[playwright.agent] overlay recovery failed: ${_overlayErr.message} — falling through`);
        }
      }

      // ── Stale-ref fast-path: take a fresh snapshot and re-plan ──────────────
      // When browser.act returns a staleRef failure, the plan-bound refs are no
      // longer valid. Skip the generic repair LLM and directly re-plan from a
      // fresh snapshot with the remaining steps.
      if (outcome.staleRef) {
        logger.info(`[playwright.agent] stale-ref detected — taking fresh snapshot and re-planning remaining steps`);
        invalidateEngineSnapshot(sessionId);
        const _staleSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
        if (_staleSnap.ok && _staleSnap.result) currentSnapshot = _staleSnap.result;
        const _staleContent = await _fetchPageContentForReplan();
        try {
          const _staleRepairRaw = await askWithMessages([
            { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
            { role: 'user', content: [
              `GOAL: ${goal}`,
              `FAILED_STEP: ${JSON.stringify(step)}`,
              `ERROR: Stale ref — the element ref from the previous snapshot no longer resolves. Re-plan from the current page state.`,
              `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex))}`,
              ``,
              `SNAPSHOT:`,
              trimSnapshot(currentSnapshot),
              _staleContent,
            ].join('\n') },
          ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
          const _staleRepairParsed = parseJson(_staleRepairRaw);
          if (_staleRepairParsed && Array.isArray(_staleRepairParsed.repair) && _staleRepairParsed.repair.length > 0) {
            plan = [...plan.slice(0, stepIndex), ..._staleRepairParsed.repair, ...plan.slice(stepIndex + 1)];
            logger.info(`[playwright.agent] stale-ref re-plan: ${_staleRepairParsed.repair.length} corrective steps`);
          } else {
            stepIndex++;
          }
        } catch (_) { stepIndex++; }
        continue;
      }

      // ── Engine-health failure: abort immediately, do not feed to LLM repair ──
      if (outcome.engineHealthFailure) {
        logger.error(`[playwright.agent] engine health failure — aborting: ${outcome.error}`);
        return {
          ok: false, goal, sessionId,
          turns: transcript.length, done: false,
          result: `Engine health failure: ${outcome.error}`,
          transcript, error: outcome.error, executionTime: Date.now() - start,
          engineHealthFailure: true,
        };
      }

      // ── Check for login wall on failure ─────────────────────────────────────
      // Only check for login walls when a step actually fails (not after every action)
      if (hasPasswordFields(currentSnapshot) && hasLoginButton(currentSnapshot)) {
        logger.warn(`[playwright.agent] Login wall detected on failed step — escalating to waitForAuth`);
        return {
          ok: false, goal, sessionId,
          turns: transcript.length, done: false,
          loginWallDetected: true,
          result: `Step ${stepIndex + 1} failed and login wall detected — escalating to waitForAuth`,
          transcript, error: outcome.error, executionTime: Date.now() - start,
        };
      }

      // ── Fast-path: clipboard-paste failed because of a native file-chooser modal.
      // Known signature: step is `press` with Ctrl+v / Meta+v, and the error (or
      // outcome.result) contains "does not handle the modal state". Skip the repair
      // LLM entirely — the correct fix is always the same: Escape to dismiss the
      // modal, then pasteAttachment which focuses the compose body and pastes there.
      {
        const _errText = `${outcome.error || ''} ${outcome.result || ''} ${outcome.stdout || ''}`;
        const _isClipboardPress =
          step.action === 'press' &&
          typeof step.key === 'string' &&
          /^(Meta|Ctrl|Control|Cmd|Command)\+v$/i.test(step.key.trim());
        const _isModalStateErr = /does not handle the modal state/i.test(_errText);
        if (_isClipboardPress && _isModalStateErr) {
          logger.info(`[playwright.agent] fast-path repair: modal-state on clipboard press → Escape + pasteAttachment`);
          // Inject the deterministic repair: dismiss the file chooser, then paste into body.
          const fastRepair = [
            { action: 'press', key: 'Escape' },
            { action: 'pasteAttachment' },
          ];
          plan.splice(stepIndex, 1, ...fastRepair);
          // Save the learned rule so future plans avoid the anti-pattern.
          try {
            const ruleText = `Attachments: use { "action": "pasteAttachment" } on the already-filled compose body — never press Ctrl+v / Meta+v after clicking the Attach/paperclip button (its native file chooser blocks keys).`;
            await skillDb.setContextRule(agentId, ruleText, 'agent').catch(() => {});
            logger.info(`[playwright.agent] learned rule saved for ${agentId}: "${ruleText.slice(0, 80)}..."`);
          } catch (_) { /* non-fatal */ }
          continue; // re-enter loop with injected steps at same index
        }
      }

      // Dismiss any pending browser dialog (e.g. "Leave site?") that may be blocking the
      // session before we snapshot — otherwise the snapshot sees a dialog-blocked page and
      // every subsequent repair step also times out (burning all repair credits).
      await browserAct({ action: 'dialog-accept', sessionId, headed, timeoutMs: 3000 }).catch(() => {});

      // Fresh snapshot for repair context
      const repairSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
      if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;

      // Get debugging context for enhanced repair
      const debugContext = getDebuggingContext(sessionId, {
        action: step.action,
        args: step,
        error: outcome.error,
        executionTime: outcome.executionTime
      });

      const remainingSteps = plan.slice(stepIndex + 1);
      let repairRaw;
      try {
        const repairUserContent = [
          `GOAL: ${goal}`,
          `FAILED_STEP: ${JSON.stringify(step)}`,
          `ERROR: ${outcome.error}`,
          `REMAINING_PLAN: ${JSON.stringify(remainingSteps)}`,
        ];

        // Inject last successful run-code result (smart truncation: full if ≤200 chars, summary if larger)
        if (lastRunCodeResult) {
          const _priorLen = lastRunCodeResult.length;
          const _priorPreview = _priorLen <= 200
            ? lastRunCodeResult
            : lastRunCodeResult.slice(0, 200) + `...(${_priorLen} chars total, large data blob)`;
          repairUserContent.push(``, `PRIOR_STEP_RESULT (last successful run-code): ${_priorPreview}`);
        }

        repairUserContent.push(``, `SNAPSHOT:`, trimSnapshot(currentSnapshot));

        // Add debugging context if available
        if (debugContext) {
          repairUserContent.push(
            ``,
            `DEBUGGING CONTEXT:`,
            `- Session duration: ${debugContext.sessionDuration}ms`,
            `- Action history: ${debugContext.actionHistory.length} previous actions`,
            `- Snapshots captured: ${debugContext.snapshots.length}`,
            `- Network errors: ${debugContext.networkErrors.length}`,
            `- Console errors: ${debugContext.consoleErrors.length}`,
            `- Trace file: ${debugContext.traceFile || 'Not available'}`,
            `- Video file: ${debugContext.videoFile || 'Not available'}`,
            ``,
            `RECENT ACTIONS:`,
            ...debugContext.actionHistory.slice(-3).map(action => 
              `• ${action.label}: ${action.ok ? 'SUCCESS' : 'FAILED'} (${action.executionTime}ms)`
            ),
            ``,
            `ERRORS DETECTED:`,
            ...debugContext.networkErrors.map(err => `• Network: ${err}`),
            ...debugContext.consoleErrors.map(err => `• Console: ${err}`)
          );
        }

        repairRaw = await askWithMessages([
          { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
          { role: 'user', content: repairUserContent.join('\n') },
        ], { temperature: 0.1, maxTokens: 1024, responseTimeoutMs: 20000 });
      } catch (err) {
        return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Repair LLM unavailable: ${err.message}`, transcript, error: err.message, executionTime: Date.now() - start };
      }

      const repairParsed = parseJson(repairRaw);
      if (!repairParsed || !Array.isArray(repairParsed.repair)) {
        logger.warn(`[playwright.agent] repair response unparseable — trying turn-loop fallback before aborting`);
        // ── Turn-loop fallback for unparseable repair ──
        try {
          const _turnLoopResult = await _executeTurnLoopFallback({
            goal: _finalGoal,
            sessionId,
            headed,
            timeoutMs,
            agentContext,
            transcript,
            deadline: _deadline,
            start,
          });
          if (_turnLoopResult.ok) {
            logger.info(`[playwright.agent] turn-loop fallback succeeded after unparseable repair — returning`);
            return _turnLoopResult;
          }
          logger.warn(`[playwright.agent] turn-loop fallback failed after unparseable repair: ${_turnLoopResult.error}`);
        } catch (_turnLoopErr) {
          logger.warn(`[playwright.agent] turn-loop fallback threw: ${_turnLoopErr.message}`);
        }
        return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Step ${stepIndex + 1} failed and repair was unparseable`, transcript, error: outcome.error, executionTime: Date.now() - start };
      }

      logger.info(`[playwright.agent] repair: ${repairParsed.repair.length} corrective steps — ${repairParsed.thoughts}`);

      // Emit repair thoughts to UI
      if (repairParsed.thoughts && _progressCallbackUrl) {
        postProgress(_progressCallbackUrl, {
          type: 'agent:thought',
          stepIndex: _stepIndex ?? 0,
          thoughts: repairParsed.thoughts,
          phase: 'repair',
        });
      }

      // Fire-and-forget: derive a ≤150-char rule from this failure+repair and store it in context_rules
      // so future plan generations for this agent automatically avoid the same mistake.
      // Skip rule learning for hallucinated-variable errors — the derived rule would be factually wrong
      // and would poison future planning sessions (e.g. "use page.url() instead of task" is incorrect).
      const _skipRuleLearning = ['task is not defined', 'results is not defined', 'globalState'].some(
        s => (outcome.error || '').includes(s)
      ) || (step.action === 'run-code' && typeof step.code === 'string' && /\.(zA|zE|yX|bog|bqe|zF|y2|xW)\b|aria-label\s*\*\s*=\s*["']unread/i.test(step.code));
      // Also skip rule learning when the derived rule would contain ephemeral element refs
      // (e.g. "click e12 instead of e5") — these refs are snapshot-specific and will be
      // wrong on every future page load, poisoning plan generation with stale instructions.
      const _refInError = /\be\d+\b/i.test(outcome.error || '') || /\be\d+\b/i.test(JSON.stringify(repairParsed?.repair || []));
      if (!_skipRuleLearning && !_refInError && !repairParsed.skip_original && repairParsed.repair.length > 0) {
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
    // Also skip when the email has already been verified sent via sendEmailWithVerification.
    // ---------------------------------------------------------------------------
    if (!_emailAlreadySent && (!finalResult || finalResult.length <= 100)) {
    try {
      await new Promise(r => setTimeout(r, 1000)); // 1s post-action settle
      const _verifySnap = await _fastSnapshot(sessionId, headed, 10000);
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
        ], { temperature: 0, maxTokens: 200, responseTimeoutMs: 12000 });

        const _verifyParsed = parseJson(_verifyRaw);

        // ── Dialog-blocking auto-dismiss ─────────────────────────────────────
        // If a dialog is blocking the page, dismiss it and re-verify ONCE.
        // This prevents a "send without subject?" dialog from being counted as a failure.
        if (_verifyParsed && _verifyParsed.dialog_blocking === true) {
          logger.info(`[playwright.agent] verify: dialog blocking detected — auto-dismissing: "${(_verifyParsed.dialog_text || '').slice(0, 80)}"`);
          // ── Duplicate-content rejection = proof of prior success ─────────────
          // "Whoops! You already said that." / "duplicate" dialogs mean the exact
          // content is ALREADY live — the original mutation succeeded. Treat as
          // achieved; never modify the user's message and re-post.
          const _dupDialogRe = /already said that|already posted|duplicate (content|post|tweet|message)|already exists|whoops!?\s*you already/i;
          if (_mutationClickTs && _dupDialogRe.test(_verifyParsed.dialog_text || '')) {
            logger.info(`[playwright.agent] verify: duplicate-content rejection detected — content is already live, treating as SUCCESS`);
            await browserAct({ action: 'dialog-accept', sessionId, headed, timeoutMs: 3000 }).catch(() => {});
            transcript.push({ step: transcript.length + 1, action: { action: 'verify' }, outcome: { ok: true, result: 'duplicate-content rejection — content already posted (prior mutation succeeded)' }, thoughts: 'duplicate dialog = idempotent success' });
            break executionLoop; // Task done — the content is already posted
          }
          await browserAct({ action: 'dialog-accept', sessionId, headed, timeoutMs: 3000 }).catch(() => {});
          // Brief settle then re-snapshot + re-verify (only once, non-fatal if it fails)
          await new Promise(r => setTimeout(r, 800));
          try {
            const _reVerifySnap = await _fastSnapshot(sessionId, headed, 8000);
            if (_reVerifySnap.ok && _reVerifySnap.result) {
              const _reVerifyRaw = await askWithMessages([
                { role: 'system', content: VERIFY_SYSTEM_PROMPT },
                { role: 'user', content: [`GOAL: ${goal}`, `LAST_ACTIONS:\n${_lastActions}`, `CURRENT_PAGE:\n${trimSnapshot(_reVerifySnap.result, 3000)}`].join('\n\n') },
              ], { temperature: 0, maxTokens: 128, responseTimeoutMs: 12000 });
              const _reVerifyParsed = parseJson(_reVerifyRaw);
              if (_reVerifyParsed && _reVerifyParsed.completed === true) {
                logger.info(`[playwright.agent] verify: task confirmed complete after dialog dismiss`);
                break executionLoop; // Task done — exit cleanly
              }
              // Use the re-verify result for the rest of the flow below
              if (_reVerifyParsed) Object.assign(_verifyParsed, _reVerifyParsed, { dialog_blocking: false });
            }
          } catch (_rdErr) {
            logger.warn(`[playwright.agent] verify: re-verify after dialog dismiss failed (non-fatal): ${_rdErr.message}`);
          }
        }

        if (_verifyParsed && _verifyParsed.completed === false && (_verifyParsed.confidence ?? 1) >= 0.75) {
          logger.warn(`[playwright.agent] POST-TASK VERIFY FAILED (confidence=${_verifyParsed.confidence}): ${_verifyParsed.evidence || 'task incomplete'}`);

          // ── Duplicate-content rejection in verify evidence = prior success ──
          const _dupEvidenceRe = /already said that|already posted|duplicate (content|post|tweet|message)|whoops!?\s*you already/i;
          if (_mutationClickTs && _dupEvidenceRe.test(_verifyParsed.evidence || '')) {
            logger.info(`[playwright.agent] verify: duplicate-content rejection in evidence — content is already live, treating as SUCCESS`);
            transcript.push({ step: transcript.length + 1, action: { action: 'verify' }, outcome: { ok: true, result: 'duplicate-content rejection — content already posted (prior mutation succeeded)' }, thoughts: 'duplicate evidence = idempotent success' });
            break executionLoop; // Task done — the content is already posted
          }

          // ── URL-based idempotency check ──────────────────────────────────────
          // Before re-planning, check if the current URL indicates the action already
          // succeeded. This prevents duplicate content from re-typing during repair.
          try {
            const _urlCheck = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 });
            if (_urlCheck?.ok) {
              const _curUrl = String(_urlCheck.result || _urlCheck.stdout || '').trim();
              // Patterns that indicate a create action already succeeded
              const _createSuccessPatterns = [
                /\/p\/[a-f0-9]{32}/i,           // Notion: /p/<page-id>
                /\/issues\/\d+/i,                // GitHub: /issues/<number>
                /\/pull\/\d+/i,                  // GitHub: /pull/<number>
                /\/status\/\d+/i,                // Twitter/X: /status/<id>
                /\/comments\/\w+/i,              // Reddit: /comments/<id>
                /\/posts\/\d+/i,                 // Generic: /posts/<id>
                /\/drafts\/\w+/i,                // Email drafts
              ];
              const _urlIndicatesSuccess = _createSuccessPatterns.some(p => p.test(_curUrl));
              if (_urlIndicatesSuccess) {
                logger.info(`[playwright.agent] verify: URL indicates create action already succeeded (${_curUrl}) — skipping repair to prevent duplicates`);
                _verifyWarning = null;
                // Force completion — the URL change is deterministic evidence
                _verifyParsed.completed = true;
                _verifyParsed.confidence = 0.9;
                _verifyParsed.evidence = `URL changed to ${_curUrl} — action appears to have succeeded`;
              }
            }
          } catch (_urlCheckErr) {
            logger.debug(`[playwright.agent] verify: URL idempotency check failed (non-fatal): ${_urlCheckErr.message}`);
          }
          if (_verifyParsed.completed === true) {
            logger.info(`[playwright.agent] verify: URL idempotency check passed — treating as completed`);
            // Skip repair — fall through to success path
          } else {

          // If verification evidence describes a login/auth wall, skip inline repair —
          // the repair LLM will just suggest clicking UI buttons (wrong approach).
          // Return loginWallDetected:true so browser.agent's waitForAuth + auto-retry
          // path fires, which is the only correct fix for an auth wall.
          if (VERIFY_LOGIN_WALL_RE.test(_verifyParsed.evidence || '')) {
            // Suppress false-positive: if auth was confirmed < 120s ago, the verify LLM
            // may have seen an OAuth redirect URL in the snapshot, not an actual logout.
            const _authAgeVerify = authConfirmedAt ? Date.now() - authConfirmedAt : Infinity;
            if (_authAgeVerify < 120_000) {
              logger.warn(`[playwright.agent] verify: login-wall in evidence suppressed — auth confirmed ${Math.round(_authAgeVerify / 1000)}s ago (< 120s). Treating as incomplete, not auth failure.`);
              // Fall through to normal repair path instead of escalating to waitForAuth
            } else {
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
              const _SUPPORTED_REPAIR_ACTIONS = new Set([
                'click', 'dblclick', 'fill', 'type', 'press', 'keyboard', 'hover', 'select',
                'scroll', 'navigate', 'goto', 'forward', 'reload', 'close', 'snapshot',
                'evaluate', 'run-code', 'getPageText', 'getText', 'upload', 'drag',
                'dialog-accept', 'dialog-dismiss', 'pasteAttachment', 'waitForStableText',
                'waitForNavigation', 'waitForAuth',
              ]);
              const _filteredRepair = _vRepairParsed.repair.slice(0, 3).filter(s => {
                const _a = normalizeStep(s)?.action;
                if (!_a) return false;
                if (_a === 'wait') return true; // handled locally
                if (!_SUPPORTED_REPAIR_ACTIONS.has(_a)) {
                  logger.warn(`[playwright.agent] verify-repair: skipping unsupported action "${_a}"`);
                  return false;
                }
                return true;
              });
              if (_filteredRepair.length === 0) {
                logger.warn(`[playwright.agent] verify-repair: all repair steps were unsupported actions — skipping repair`);
              }
              logger.info(`[playwright.agent] verify-repair: ${_vRepairParsed.repair.length} corrective steps — ${_vRepairParsed.thoughts || ''}`);
              for (const _vStep of _filteredRepair) {
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
                if (_vOut.ok) {
                  _verifyWarning = null; // repair step succeeded — clear warning
                  // ── Stale result propagation fix ──────────────────────────────
                  // When a repair step produces extraction output, replace the stale
                  // finalResult/lastRunCodeResult/lastGetPageTextResult so downstream
                  // synthesis sees the corrected value, not the earlier wrong one.
                  const _vAction = _vNorm?.action;
                  const _vResultStr = _vOut.result != null ? String(_vOut.result) : '';
                  if (_vResultStr && (_vAction === 'run-code' || _vAction === 'getPageText' || _vAction === 'evaluate')) {
                    if (_vAction === 'getPageText') {
                      lastGetPageTextResult = _vResultStr;
                    } else {
                      lastRunCodeResult = _vResultStr;
                    }
                    finalResult = _vResultStr;
                    logger.info(`[playwright.agent] verify-repair: replaced stale finalResult with ${_vAction} output (${_vResultStr.length} chars)`);
                  }
                }
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
              result: finalResult !== null ? String(finalResult) : `Completed: ${goal}`,
              transcript,
              executionTime: Date.now() - start,
              verificationWarning: _verifyWarning,
              error: `Task completion could not be verified: ${_verifyWarning}`,
            };
          }
          } // end else (URL idempotency check didn't indicate success — ran repair)
        }
      }
    } catch (_verifyErr) {
      logger.warn(`[playwright.agent] post-task verification error (non-fatal): ${_verifyErr.message}`);
    }
    } // end verify gate

    // ── LLM Goal-Achievement Judge ────────────────────────────────────────────
    // Ask the LLM whether the goal was actually achieved based on the transcript
    // and current page state. This replaces the old word-count _isSparse heuristic
    // which falsely triggered on code editors, dashboards, forms, and other
    // UI-heavy pages that have little prose but a fully completed goal.
    if (_emailAlreadySent) {
      logger.info(`[playwright.agent] skipping goal-achievement judge — email already verified sent`);
      break executionLoop;
    }
    let _shouldReplan = false;
    let _replanPlan = null;
    try {
      const _judgeSnap = await _fastSnapshot(sessionId, headed, 10000);
      const _judgePageText = (_judgeSnap.ok && _judgeSnap.result) ? _judgeSnap.result : currentSnapshot;
      if (_judgeSnap.ok && _judgeSnap.result) currentSnapshot = _judgeSnap.result;

      // ── For read/count tasks, fetch getPageText so the judge sees visible page text ──
      // The ARIA snapshot is designed for interaction (refs), not content reading.
      // Gmail email rows show as sparse generic elements without sender/subject text.
      // getPageText captures body.innerText — all visible text the user can see.
      const _isReadCountTask = /\b(count|find|check|list|how many|unread|read|search|filter|look\s*up)\b/i.test(goal);
      let _judgeVisibleText = '';
      if (_isReadCountTask) {
        try {
          const _judgeGpt = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 });
          if (_judgeGpt.ok && _judgeGpt.result) {
            _judgeVisibleText = String(_judgeGpt.result);
            // Also update lastGetPageTextResult so downstream synthesis has fresh text
            lastGetPageTextResult = _judgeVisibleText;
            if (finalResult === null || finalResult.length < 50) {
              finalResult = _judgeVisibleText;
            }
            logger.info(`[playwright.agent] goal-judge: getPageText fetched (${_judgeVisibleText.length} chars) for read/count task`);
          }
        } catch (_gptErr) {
          logger.warn(`[playwright.agent] goal-judge: getPageText fetch failed (non-fatal): ${_gptErr.message}`);
        }
      }

      // Fetch current URL — the most reliable signal for whether an action executed
      // (e.g. search_query param proves search ran regardless of which UI mechanism was used)
      let _judgeCurrentUrl = '';
      try {
        const _engineUrlRes = await _engineEval(sessionId, 'window.location.href');
        if (_engineUrlRes?.ok && _engineUrlRes.result) {
          _judgeCurrentUrl = String(_engineUrlRes.result).trim().replace(/^"|"$/g, '');
        } else {
          const _urlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 });
          if (_urlRes.ok && _urlRes.result) {
            _judgeCurrentUrl = String(_urlRes.result).trim().replace(/^"|"$/g, '');
          }
        }
      } catch (_) {}

      // ── Network mutation evidence (Issue 2c) ────────────────────────────────
      // Use engine.getNetLog() (Playwright response event listeners) instead of
      // evaluating window.__tdNetLog in the browser. Falls back to eval if engine inactive.
      let _mutationNetEvidence = '';
      if (_mutationClickTs) {
        try {
          let _netLog = null;

          // Engine fast path: get net log from Playwright response listeners
          if (engine.isSessionActive(sessionId)) {
            const engineLog = engine.getNetLog(sessionId);
            if (engineLog && engineLog.length > 0) {
              _netLog = engineLog;
              logger.info(`[playwright.agent] mutation net evidence: via engine.getNetLog (${engineLog.length} entries)`);
            }
          }

          // CLI fallback: evaluate window.__tdNetLog in the browser
          if (!_netLog) {
            const _netRes = await browserAct({ action: 'evaluate', text: 'JSON.stringify(window.__tdNetLog || [])', sessionId, headed, timeoutMs: 3000 });
            if (_netRes?.ok && _netRes?.result) {
              let _rawNetResult = typeof _netRes.result === 'string' ? _netRes.result : JSON.stringify(_netRes.result);
              if (Array.isArray(_netRes.result)) {
                _netLog = _netRes.result;
                logger.info(`[playwright.agent] mutation net evidence: parsed via pre-parsed array`);
              } else {
                let _netLogStr = _rawNetResult.replace(/^"|"$/g, '');
                try {
                  _netLog = JSON.parse(_netLogStr || '[]');
                  logger.info(`[playwright.agent] mutation net evidence: parsed directly`);
                } catch (_) {
                  _netLog = JSON.parse(_netLogStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\') || '[]');
                  logger.info(`[playwright.agent] mutation net evidence: parsed via unescape fallback`);
                }
              }
            }
          }

          if (_netLog && _netLog.length > 0) {
            const _relevant = _netLog.filter(e => e.ts >= _mutationClickTs - 500);
            if (_relevant.length > 0) {
              const _summarized = _relevant.map(e => `${e.method} ${e.url.slice(0, 80)} → ${e.status}`).join('\n');
              const _has2xx = _relevant.some(e => e.status >= 200 && e.status < 300);
              const _has4xx = _relevant.some(e => e.status >= 400 && e.status < 600);
              _mutationNetEvidence = `\nMUTATION_NETWORK_EVIDENCE:\n${_summarized}\nNetworkStatus: ${_has2xx ? '2xx-success' : _has4xx ? 'error-status' : 'no-clear-status'}`;
              logger.info(`[playwright.agent] mutation network evidence: ${_relevant.length} entries, has2xx=${_has2xx}, has4xx=${_has4xx}`);
            } else {
              logger.info(`[playwright.agent] mutation network evidence: no entries after _mutationClickTs=${_mutationClickTs}`);
            }
          }
        } catch (_netErr) {
          logger.warn(`[playwright.agent] mutation network evidence collection failed (non-fatal): ${_netErr.message}`);
        }
      }

      const _stepSummary = transcript.map(t => `${t.action.action}:${t.outcome.ok ? 'ok' : 'fail'}`).join('; ');
      const _stepResults = transcript.slice(-3).map(t => {
        const _res = String(t.outcome.result ?? t.outcome.error ?? '');
        return `${t.action.action}:${t.outcome.ok ? 'ok' : 'fail'}${_res ? ` (${_res.slice(0, 120)})` : ''}`;
      }).join('; ');
      // Page content (lastGetPageTextResult) is the strongest signal for goal relevance —
      // it contains actual titles/descriptions that can be matched against the goal topic.
      const _judgeContentSample = lastGetPageTextResult ? lastGetPageTextResult.slice(0, 800) : '';
      const _emailVerifyBlock = _emailSendVerification
        ? `\nEMAIL_SEND_VERIFICATION: ${JSON.stringify(_emailSendVerification)}`
        : '';
      const _judgePrompt = `GOAL: ${goal}

STEPS EXECUTED: ${_stepSummary}
RECENT STEP RESULTS: ${_stepResults}${_emailVerifyBlock}${_mutationNetEvidence}
${_judgeCurrentUrl ? `\nCURRENT URL: ${_judgeCurrentUrl}` : ''}
${_judgeContentSample ? `\nPAGE CONTENT (sample):\n${_judgeContentSample}` : ''}
${_judgeVisibleText ? `\nVISIBLE PAGE TEXT (body.innerText, first 2000 chars):\n${_judgeVisibleText.slice(0, 2000)}` : ''}

CURRENT PAGE SNAPSHOT (first 800 chars):
${_judgePageText.slice(0, 800)}

Judge whether the goal was accomplished. Consider BOTH the action history and the current page state.

IMPORTANT RULES:
- PAGE CONTENT IS PRIMARY EVIDENCE: The page content/URL/snapshot must show evidence that the goal was achieved. Action history alone (e.g. "type:ok" or "click:ok") is NOT sufficient — a successful action does not mean the goal was accomplished. You must find concrete evidence in the page state.
- If the action history includes ">sendEmailWithVerification:ok", the email was successfully sent and verified. This is conclusive evidence. The mail inbox is the expected page after a successful send. The absence of a compose window means the email was sent, not that it failed.
- If EMAIL_SEND_VERIFICATION is provided, it is authoritative proof of completion.
- MUTATION_NETWORK_EVIDENCE RULE: If MUTATION_NETWORK_EVIDENCE is provided with NetworkStatus=2xx-success, this is strong evidence that a mutation (post/create/submit) succeeded. Combined with the action history showing a fill+submit sequence, set achieved=true unless the page explicitly shows an error message. If NetworkStatus=error-status (4xx/5xx), set achieved=false and canRetry=true. If NetworkStatus=no-clear-status, fall back to page content analysis.
- SUBMIT_CLICK_FAILED RULE: If the action history shows ANY click step with ok=false that has submit intent (selector/purpose containing post, submit, send, publish, create, save, reply), then MUTATION_NETWORK_EVIDENCE MUST be ignored entirely — 2xx responses may be autosave/draft-save, not the actual submission. In this case, set achieved=false and canRetry=true.
- For non-mail tasks, focus on the END STATE — does the page content/URL show the goal was accomplished? If the page content does not contain expected text/elements matching the goal, achieved MUST be false.
- RICH TEXT EDITOR RULE: Google Docs, Notion, Confluence, and similar editors use canvas/custom rendering. Content typed via a prior 'type' or 'fill' action may NOT appear in the DOM snapshot even though it was entered successfully. If the action history includes type:ok or fill:ok with text content matching the goal, and the page is a rich text editor / contenteditable, consider the content as entered even if it doesn't appear in the page snapshot.
- AUTOSAVE RULE: Transient save/sync indicators ("Saving…", "Syncing…", "Uploading…") are NORMAL autosave states and are NOT evidence of goal non-achievement. A "Saving…" or "Saved" indicator on a document editor means the action was accepted and is being persisted.
- CANVAS APP RULE: For canvas apps (Notion, Google Docs, etc.), if page content is sparse but action history shows successful type/press steps matching the goal text, AND the page type was classified as 'canvas' or 'hybrid', consider the goal achieved. The ARIA tree cannot represent canvas content.
- VISIBLE PAGE TEXT RULE: For read/count/find/check/list tasks, if VISIBLE PAGE TEXT is provided, use it as the PRIMARY evidence source — not the ARIA snapshot. The ARIA snapshot is designed for interaction (element refs), not content reading. Email rows, search results, and list items may not appear in the ARIA tree with their full text. If the VISIBLE PAGE TEXT contains the data the user asked for (e.g. email subjects, sender names, counts), the goal IS achieved even if the ARIA snapshot is sparse.

Respond with JSON only — no markdown, no explanation outside the JSON:
{ "achieved": true, "reason": "one sentence citing page evidence" }
or
{ "achieved": false, "reason": "one sentence citing missing evidence", "canRetry": true|false }

Set canRetry:false only if the goal is fundamentally impossible on this page/site.`;

      const _judgeRaw = await askWithMessages([
        { role: 'system', content: 'You are a browser automation judge. Evaluate whether the user\'s goal was accomplished by considering BOTH the action history (including verified outcomes) and the current page state. Respond with JSON only.' },
        { role: 'user', content: _judgePrompt },
      ], { temperature: 0.0, maxTokens: 120, responseTimeoutMs: 20000 });

      const _judgeResult = parseJson(_judgeRaw);
      logger.info(`[playwright.agent] Goal-achievement judge: achieved=${_judgeResult?.achieved} reason="${_judgeResult?.reason}" recipeWasUsed=${recipeWasUsed}`);

      if (_judgeResult && _judgeResult.achieved === false) {
        if (recipeWasUsed) {
          // ── Recipe path: never replan internally — surface ask_user ──────────
          // The recipe already navigated correctly. If the LLM task still failed,
          // the user should retry or retrain the recipe.
          logger.warn(`[playwright.agent] Goal not achieved after recipe execution — surfacing ask_user`);
          return {
            ok: false,
            askUser: true,
            question: `The recipe navigated to the target page, but the task wasn't completed successfully.\n\nReason: ${_judgeResult.reason}\n\nWhat would you like to do?`,
            options: ['Try again', 'Retrain recipe'],
            goal,
            sessionId,
            executionTime: Date.now() - start,
          };
        } else {
          // ── Non-recipe path: exhaust adaptive replanning until LLM says stuck ─
          let _canRetry = _judgeResult.canRetry !== false; // default true unless LLM says false

          // ── Hard guard against duplicate mutation (Issue 2d) ────────────────
          // If a mutation submit was detected (_mutationClickTs set) and network
          // evidence shows 2xx or no-clear-status (ambiguous), do NOT replan —
          // the mutation likely succeeded and re-executing fill+submit risks
          // duplicate posts/creates/submits. Surface ask_user instead.
          if (_mutationClickTs && _canRetry && totalRepairs < maxRepairs) {
            const _netStatus = _mutationNetEvidence.match(/NetworkStatus:\s*(\S+)/);
            const _status = _netStatus ? _netStatus[1] : 'no-evidence';
            if (_status === 'error-status') {
              // Explicit 4xx/5xx — the mutation definitively failed, safe to retry
              logger.info(`[playwright.agent] Mutation guard: network=${_status} — allowing replan (mutation definitively failed)`);
            } else {
              // 2xx-success, no-clear-status, or missing evidence: the mutation may
              // have succeeded — NEVER blindly re-run fill+submit (duplicate risk).
              // Surface ask_user instead.
              logger.warn(`[playwright.agent] Mutation guard: _mutationClickTs set + network=${_status} — prohibiting replan to prevent duplicate mutation`);
              _canRetry = false;
            }
          }

          if (_canRetry && totalRepairs < maxRepairs) {
            totalRepairs++;
            logger.warn(`[playwright.agent] Goal not achieved — adaptive replan ${totalRepairs}/${maxRepairs}: ${_judgeResult.reason}`);

            const _replanSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
            if (_replanSnap.ok && _replanSnap.result) currentSnapshot = _replanSnap.result;

            const _replanPrompt = `ORIGINAL GOAL: ${goal}

PREVIOUS ATTEMPT SUMMARY: ${_stepSummary}

REASON GOAL NOT MET: ${_judgeResult.reason}

CURRENT PAGE STATE:
${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}

Generate a COMPLETELY NEW plan to achieve the goal. Try a DIFFERENT approach than before.
Return JSON: { "thoughts": "strategy explanation", "plan": [...steps] }`;

            const _replanRaw = await askWithMessages([
              { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
              { role: 'user', content: _replanPrompt },
            ], { temperature: 0.2, maxTokens: _planMaxTokens, responseTimeoutMs: 30000 });

            const _replanParsed = parseJson(_replanRaw);
            if (_replanParsed && Array.isArray(_replanParsed.plan) && _replanParsed.plan.length > 0) {
              logger.info(`[playwright.agent] Adaptive replanning: new approach with ${_replanParsed.plan.length} step(s) — ${_replanParsed.thoughts || 'retrying'}`);
              _shouldReplan = true;
              _replanPlan = _replanParsed.plan;
            } else {
              logger.warn(`[playwright.agent] Adaptive replanning: LLM returned no parseable plan — surfacing ask_user`);
            }
          }

          // If replan budget exhausted or LLM says canRetry:false, surface ask_user
          if (!_shouldReplan) {
            logger.warn(`[playwright.agent] Goal not achievable — surfacing ask_user (canRetry=${_canRetry}, repairs=${totalRepairs}/${maxRepairs})`);
            return {
              ok: false,
              askUser: true,
              trainingHandoff: true,
              question: `I wasn't able to complete the task after ${totalRepairs} attempt(s).\n\nReason: ${_judgeResult.reason}\n\nWhat would you like to do? You can also type what went wrong and I'll retry with your correction.`,
              options: [
                { label: 'Try again', value: 'try_again' },
                { label: 'Correct and retry (tell me what was missed)', value: 'correct_and_retry' },
                { label: 'Record recipe from beginning', value: 'record_recipe' },
              ],
              goal,
              agentId,
              sessionId,
              keepSession: true,
              executionTime: Date.now() - start,
            };
          }
        }
      }
    } catch (_judgeErr) {
      logger.warn(`[playwright.agent] goal-achievement judge error (non-fatal): ${_judgeErr.message}`);
    }

    // Execute replanning if flag was set (outside try-catch to allow continue)
    if (_shouldReplan && _replanPlan) {
      plan = _replanPlan;
      stepIndex = 0;
      lastGetPageTextResult = null;
      lastRunCodeResult = null;
      _typedTexts.clear(); // Reset dedup set so re-fills on the new plan are not skipped
      _mutationClickTs = null; // Reset mutation tracking so the guard doesn't block the retry
      _hasFillOrType = false;
      replaceSendWithVerification(plan);
      _shouldReplan = false;
      _replanPlan = null;
      continue executionLoop; // Restart execution loop with completely new plan
    }

    // Exit outer execution loop on successful completion
    break executionLoop;
  } // end executionLoop
  } catch (_deadlineErr) {
    if (/Overall timeout/.test(_deadlineErr.message)) {
      logger.warn(`[playwright.agent] aborted due to overall timeout — trying turn-loop fallback before ask_user`);
      // Give the turn-loop a fresh 30s budget regardless of the overall timeout
      try {
        const _turnLoopResult = await _executeTurnLoopFallback({
          goal: _finalGoal || goal,
          sessionId,
          headed,
          timeoutMs: 30000,
          agentContext,
          transcript,
          deadline: Date.now() + 30000,
          start,
        });
        if (_turnLoopResult.ok) {
          logger.info(`[playwright.agent] turn-loop fallback succeeded after overall timeout — returning`);
          return _turnLoopResult;
        }
        logger.warn(`[playwright.agent] turn-loop fallback failed after timeout: ${_turnLoopResult.error} — surfacing ask_user`);
      } catch (_turnLoopErr) {
        logger.warn(`[playwright.agent] turn-loop fallback threw after timeout: ${_turnLoopErr.message} — surfacing ask_user`);
      }
      _heartbeat.stop();
      return { ..._failureAskUser(`Task timed out after ${overallTimeoutMs}ms`), transcript };
    }
    throw _deadlineErr;
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  logger.info(`[playwright.agent] DONE — ${transcript.length} steps executed (${totalRepairs} repairs)`);
  postProgress(_progressCallbackUrl, {
    type: 'agent:complete',
    stepIndex: _stepIndex,
    agentId,
    task: goal,
    totalTurns: transcript.length,
    done: true,
    ok: true,
    result: finalResult !== null ? String(finalResult) : `Completed: ${goal}`,
  });
  // Phase 8: Verification layer for Tier 3
  let _tier3Verification = null;
  try {
    _tier3Verification = await verifyTierCompletion(goal, _pageType, _routingDecision, null, sessionId, headed, timeoutMs);
    if (_tier3Verification.fail) {
      logger.warn(`[playwright.agent] verification layer: FAIL after Tier 3 — ${_tier3Verification.reason}`);
    }
  } catch (_vErr) {
    logger.warn(`[playwright.agent] verification layer error (non-fatal): ${_vErr.message}`);
  }

  // Phase 10: Learning layer — distill successful Tier 3 canvas/hybrid runs into keyboard scripts
  if (!_tier3Verification?.fail && (_pageType === 'canvas' || _pageType === 'hybrid') && transcript.length >= 2) {
    const _distillService = serviceFromHostname(hostname) || (agentId || '').replace(/\.agent$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (_distillService) {
      try {
        const { distillKeyboardScript } = require('./trainer.agent.cjs');
        distillKeyboardScript(agentId, goal, transcript, _pageType, _distillService)
          .then(_r => { if (_r) logger.info(`[playwright.agent] Phase 10: distilled script ${_r.service}.${_r.action} (${_r.steps} steps)`); })
          .catch(_e => logger.warn(`[playwright.agent] Phase 10: distill error (non-fatal): ${_e.message}`));
      } catch (_) { /* non-fatal */ }
    }
  }

  // ── Save-as-named-skill offer (Phase 3) ────────────────────────────────────
  // After a verified-successful mutation run that wasn't already recipe-driven,
  // offer to save the flow as a named, URL-first recipe (e.g. linkedin.post.update)
  // so the next invocation is deterministic. The user confirms + names it; we don't
  // auto-save (avoids cementing hollow successes). Only for runs that performed a
  // DOM mutation (click/submit/fill) — pure extractions don't benefit from recipes.
  let _saveSkillOffer = null;
  const _isMutationRun = !recipeWasUsed
    && transcript.length >= 2
    && !_tier3Verification?.fail
    && transcript.some(t => {
      const _a = t.action?.action || t.action?.type || t.step?.action || '';
      return /click|submit|fill|check|select/i.test(typeof _a === 'string' ? _a : '');
    });
  if (_isMutationRun) {
    // Suggest a dot-name from the agentId + goal keywords (e.g. linkedin.post.update)
    const _svc = (agentId || '').replace(/\.agent$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'agent';
    const _goalWords = (goal || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !['the','and','for','with','from','your','this','that','into','open','send','post','create'].includes(w)).slice(0, 2);
    const _suggestedName = _goalWords.length > 0 ? `${_svc}.${_goalWords.join('.')}` : `${_svc}.custom`;
    _saveSkillOffer = {
      suggestedName: _suggestedName,
      task: goal,
      transcriptLength: transcript.length,
    };
    logger.info(`[playwright.agent] Phase 3: saveSkillOffer — suggested "${_suggestedName}" (${transcript.length} steps)`);
  }

  _heartbeat.stop();
  return {
    ok: true, goal, sessionId,
    turns: transcript.length, done: true,
    result: finalResult !== null ? String(finalResult) : `Completed: ${goal}`,
    transcript,
    routingDecision: _routingDecision,
    pageType: _pageType,
    verification: _tier3Verification,
    executionTime: Date.now() - start,
    saveSkillOffer: _saveSkillOffer,
    extractionProvenance: finalResult !== null ? {
      source: lastGetPageTextResult === finalResult ? 'getPageText' : lastRunCodeResult === finalResult ? 'run-code' : 'return',
      verifyRepaired: transcript.some(t => t.thoughts === 'verify-repair' && t.outcome?.ok),
    } : null,
  };
  // END DISABLED — script-gen + Plan-Execute (unreachable: turn-loop returns above)
}

module.exports = {
  playwrightAgent,
  _validatePlanSemantics,
  // Exported for testing and Phase 8 verification layer
  pageProbe,
  classifyPageType,
  serviceFromHostname,
  pruneSnapshot,
  snapshotHash,
  validateSelector,
  verifyTierCompletion,
  getInteractionScript,
  saveInteractionScript,
  incrementScriptSuccess,
  incrementScriptFailure,
  ensureSeedScripts,
  executeScript,
  bestEffortKeyboard,
  syncScriptGeneration,
  extractParamsFromGoal,
  deriveActionFromGoal,
  extractKeywordsFromGoal,
  queueAsyncScriptGeneration,
  // Tier 1.5: Deterministic selector maps
  getSelectorMap,
  saveSelectorMap,
  incrementSelectorMapSuccess,
  incrementSelectorMapFailure,
  derivePagePattern,
  isFormUrl,
};
