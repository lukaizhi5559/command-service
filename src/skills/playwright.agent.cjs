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
const { browserAct, getDebuggingContext } = require('./browser.act.cjs');
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
  find-role       { role, name?, findAction, value? } — find by ARIA role (e.g. "textbox") + optional name; findAction is "click"|"fill"
  find-label      { label, findAction, value? }       — find by label text; findAction is "click"|"fill"
  find-text       { text }                            — click the first visible element containing this text
  wait            { ms }                              — pause execution for up to 5000ms (use sparingly)
  // REMOVED: waitForSelector, waitForContent - not available in playwright-cli, implemented as compatibility layers in browser.act.cjs
  getPageText     {}                   — returns ALL visible text from the page (body.innerText, up to 50k chars). Use this as the universal, site-agnostic way to read any page. Works on ChatGPT, Perplexity, Claude, Grok, and any other site without knowing site-specific CSS. Result auto-captured as task output.
  evaluate        { text: "<JS expression>" }  — single-expression JS returning a primitive (e.g. document.title)
  run-code        { code: "async page => { return await page.evaluate(() => { ...browser JS... }); }" }
                  — Node.js VM with real Playwright page object. Use page.evaluate() to reach browser DOM.
                  ⚠ require() does NOT exist. Use dynamic import: const { fn } = await import('module')
                  ⚠ NEVER read files inside run-code — file content is already in the task as [DATA FROM PRIOR STEP].
                  ⚠ SCOPE: only \`page\` exists in the function — \`task\`, \`task.results\`, \`results\`, \`context\`, \`globalState\` do NOT exist and will throw ReferenceError.
                  Gmail inbox example (sender=.yX span/.zF  subject=.bog/.bqe  snippet=.y2  time=.xW span):
                  { "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows = Array.from(document.querySelectorAll('tr.zA')).slice(0,5); if(!rows.length) return 'No emails found'; return rows.map((r,i)=>{ const s=r.querySelector('.yX span,.zF')?.innerText||''; const sub=r.querySelector('.bog,.bqe')?.innerText||''; const snip=r.querySelector('.y2')?.innerText||''; const t=r.querySelector('.xW span')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip+' | Time='+t; }).join('\\n'); }); }" }
  external_skill  { name: "<skill-name>", args?: {...} } — run an installed atomic skill (e.g. mail_google_com_compose). The skill executes in the SAME browser session. Use ONLY when AVAILABLE ATOMIC SKILLS lists this exact name. Never guess a skill name.
  screenshot      { filePath }
  snapshot        {}                   — re-read the page (ONLY when page changes significantly)
  upload          { selector, files }  — attach file(s): clicks selector to open chooser, then uses playwright-cli upload command. selector = button/input ref; files = array of real absolute paths from the task/request. IMPORTANT: always use "files" (array), NEVER use "path". NEVER invent placeholders like /path/to/file.pdf.
  pasteAttachment { selector?, uploadWaitMs? } — PREFERRED for Gmail/chat attachments. Assumes the file is already on the clipboard (a prior shell.run osascript step put it there). Finds the compose body textbox, focuses it, and presses Meta+V (macOS) / Ctrl+V (else). DO NOT click the paperclip/Attach button before this — the native file chooser modal blocks keyboard events. Optional selector pins the body ref if auto-detection picks the wrong textbox. uploadWaitMs overrides the upload settle timeout (default 120000ms/2min): pass uploadWaitMs:300000 for video files, uploadWaitMs:180000 for audio or multiple files.
  return          { data: "<string>" } — MUST be LAST step; plain string output, max 2000 chars.
  dialog-accept   { prompt? }
  dialog-dismiss  {}
  tab-new         { url? }             — open a new tab; if url provided, navigates to it. Returns new tab index.
  tab-list        {}                   — list all open tabs with their indices and URLs. Use to audit tabs.
  tab-select      { tabIndex }         — switch active focus to the tab at tabIndex
  tab-close       { tabIndex }         — close tab at tabIndex and free its resources. NEVER close tab 0.

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
    { "ref": "e42", "role": "textbox", "label": "Primary input", "purpose": "where main content/prompt goes" }
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
          text: `!document.querySelector('${selector}')`, 
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
        // Aria refs (e.g. e18, e3) are playwright-cli accessibility IDs, never visible page text
        if (/^e\d+$/.test(selector)) {
          return { satisfied: true, reason: 'Aria ref selector — skipping text_present check' };
        }
        const textResult = await browserAct({ 
          action: 'evaluate', 
          text: `document.body.innerText.includes('${selector.replace(/'/g, "\\'")}')`, 
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

// Tier 1: Safe pattern recognition (no URL patterns for login)
function handleKnownFailures(step, currentState, snapshot) {
  // Network-based error detection (from playwright-cli network command)
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
    const reSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
  // Reject button[ref=eN] — ref/CSS syntax confusion
  if (/button\[ref=e\d+\]|\[ref=e\d+\]/i.test(s)) {
    return { valid: false, reason: `malformed ref/CSS hybrid selector: "${s}" — refs should be bare (e.g. "e24"), not wrapped in CSS attribute selectors` };
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
  const HAS_REF = /\[?e\d+\]|\[ref=e\d+\]/;
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
  // Cap at maxRefs lines (not exact ref count, but close enough)
  const capped = out.slice(0, maxRefs * 2); // ~2 lines per ref (parent + element)
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
    activeElementEditable: document.activeElement?.isContentEditable || false,
    activeElementTag: document.activeElement?.tagName || null,
    activeElementRole: document.activeElement?.getAttribute('role') || null,
    interactiveCount: document.querySelectorAll('button, input, select, textarea, a[href]').length,
    ariaGenericCount: document.querySelectorAll('[role="generic"], div:not([role])').length,
    hasCanvas: document.querySelector('canvas') !== null,
    bodyTextLength: document.body?.innerText?.length || 0,
    hostname: window.location.hostname
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

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    logger.info(`[playwright.agent] script step ${i + 1}/${steps.length}: ${JSON.stringify(step)}`);

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
  }

  // Run verify block if present
  if (yaml.verify) {
    for (const vStep of yaml.verify) {
      if (vStep.eval) {
        const evalCode = substitute(vStep.eval);
        try {
          const vResult = await browserAct({ action: 'evaluate', text: evalCode, sessionId, headed, timeoutMs: 5000 });
          if (!vResult.ok || vResult.result !== 'true') {
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
- For Notion: type title, press Enter (moves to body), type "[] item" for todos, press Enter between items
- For ChatGPT/Gemini: type the message, press Enter to send
- Keep steps minimal — just the keyboard sequence needed
- For markdown shortcuts: "[]" for todo checkbox, "# " for heading, "- " for bullet, "> " for quote`;

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
- For Notion: "[]" creates a todo checkbox, Enter after title moves to body, "/todo" creates a todo block
- For ChatGPT: type message, press Enter to send
- For Gemini: type message, press Enter to send
- Verify should check page content (document.body.innerText.includes(...))
- Keep steps minimal and deterministic`;

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
          const vRes = await browserAct({ action: 'evaluate', text: vStep.eval, sessionId, headed, timeoutMs: 5000 });
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
    // Goal-derived eval: check if page text contains expected keywords from goal
    try {
      const pageTextRes = await browserAct({ action: 'evaluate', text: 'document.body?.innerText?.slice(0, 2000) || ""', sessionId, headed, timeoutMs: 5000 });
      const pageText = pageTextRes.ok ? String(pageTextRes.result || '').toLowerCase() : '';
      const goalKeywords = goal.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3)
        .slice(0, 5);
      const matched = goalKeywords.filter(k => pageText.includes(k));
      const matchRatio = goalKeywords.length > 0 ? matched.length / goalKeywords.length : 0;

      if (matchRatio >= 0.4) {
        result.evalResults.push({ type: 'goal_keyword_match', ratio: matchRatio, matched });
        result.pass = true;
        result.reason = `Goal keyword match: ${matched.join(', ')} (${(matchRatio * 100).toFixed(0)}%)`;
      } else if (matchRatio > 0) {
        result.warn = true;
        result.reason = `Partial goal keyword match: ${matched.join(', ')} (${(matchRatio * 100).toFixed(0)}%)`;
      } else {
        // For canvas apps, page text may not contain goal keywords (contenteditable)
        if (pageType === 'canvas' || pageType === 'hybrid') {
          result.warn = true;
          result.reason = `Canvas app — page text doesn't contain goal keywords (expected for contenteditable)`;
        } else {
          result.fail = true;
          result.reason = `No goal keywords found in page text`;
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

  const transcript = [];
  let finalResult = null; // set by a 'return' step if present

  // ── Pre-navigation ─────────────────────────────────────────────────────────
  if (url) {
    // Check if browser is already on the target URL — browser.agent may have already
    // navigated there during the auth probe. Skip redundant re-navigation to avoid
    // a full page reload (~8s saved) and preserve page state.
    let _alreadyOnTarget = false;
    try {
      const _curUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 });
      if (_curUrlRes?.ok && _curUrlRes?.result) {
        const _curUrl = String(_curUrlRes.result).trim().replace(/^"|"$/g, '');
        const _normCur = _curUrl.replace(/\/+$/, '').split('?')[0];
        const _normTarget = url.replace(/\/+$/, '').split('?')[0];
        if (_normCur === _normTarget) {
          _alreadyOnTarget = true;
          logger.info(`[playwright.agent] already on target URL ${_curUrl} — skipping redundant navigation`);
        }
      }
    } catch (_) {}

    if (!_alreadyOnTarget) {
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
  }

  // ── Phase 1: Wait for redirect to settle, then for SPA to stabilise ──────
  // Shortcut URLs (e.g. notion.new) redirect through one or more intermediate URLs
  // before landing on the final destination. If we snapshot during the redirect,
  // we capture a blank/interstitial page and the LLM generates a plan against
  // zero elements — causing wrong-element clicks and mistyped content.
  if (url) {
    let _prevHref = '';
    let _hrefStable = false;
    for (let _i = 0; _i < 15; _i++) {
      _checkDeadline();
      const _hrefRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
      const _curHref = _hrefRes?.ok ? String(_hrefRes.result || '').replace(/^"|"$/g, '') : '';
      if (_curHref && _curHref === _prevHref) {
        _hrefStable = true;
        logger.info(`[playwright.agent] phase 1: redirect settled on ${_curHref} after ${_i + 1} check(s)`);
        break;
      }
      _prevHref = _curHref;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!_hrefStable) {
      logger.warn(`[playwright.agent] phase 1: redirect did not stabilize after 15s — proceeding with current page`);
    }
    logger.info(`[playwright.agent] phase 1: waiting for page to stabilise before snapshot`);
    await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
  }
  logger.info(`[playwright.agent] phase 1: snapshot`);
  const initSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
  let currentSnapshot = (initSnap.ok && initSnap.result) ? initSnap.result : '';

  // Compute hostname from the actual post-navigation browser URL.
  // This handles shortcut domains (e.g. notion.new → app.notion.com) generically —
  // no hardcoded mapping needed, we just read where the browser ended up.
  let hostname = null;
  if (url) {
    try {
      const navResult = await browserAct({ action: 'evaluate', text: 'window.location.hostname', sessionId, headed, timeoutMs: 5000 });
      if (navResult.ok && navResult.result) {
        hostname = String(navResult.result).replace(/^www\./, '').toLowerCase();
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

    // Script DB lookup for (service, page_type)
    const _taskKeywords = extractKeywordsFromGoal(goal);
    const _matchedScript = _service ? await getInteractionScript(_service, _pageType, _taskKeywords) : null;

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
      learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — advisory, not absolute):\n${rules.map(r => `- ${r}`).join('\n')}\n- Never use tutorial placeholders (example@domain.com, /path/to/...) unless the user explicitly asked for an example.`;
      logger.info(`[playwright.agent] ${rules.length} learned rule(s) injected for [${ruleKeys.join(', ')}]`);
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

  // ── Phase 2: Plan generation ───────────────────────────────────────────────
  logger.info(`[playwright.agent] phase 2: generating plan`);
  const planMessages = [
    { role: 'system', content: PLAN_SYSTEM_PROMPT + learnedRulesBlock + domainLockBlock },
    { role: 'user',   content: `GOAL: ${_finalGoal}${_studyBlock}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
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
        const snap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
          try {
            const snapReplanRaw = await askWithMessages([
              { role: 'system', content: REPLAN_SYSTEM_PROMPT },
              { role: 'user', content: [
                `GOAL: ${goal}`,
                `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`,
                `STALE_REMAINING_PLAN: ${JSON.stringify(remainingAfterSnap)}`,
                ``,
                `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`,
                pruneSnapshot(extractInteractiveRefs(currentSnapshot)),
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
            return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `external_skill ${skillName} failed: ${outcome.error}`, transcript, error: outcome.error, executionTime: Date.now() - start };
          }
          totalRepairs++;
          logger.info(`[playwright.agent] external_skill ${skillName} failed — repair ${totalRepairs}/${maxRepairs}: ${outcome.error}`);
          // Take a fresh snapshot to give repair LLM current page state
          const repairSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
          if (repairSnap.ok && repairSnap.result) currentSnapshot = repairSnap.result;
          try {
            const repairRaw = await askWithMessages([
              { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
              { role: 'user', content: [`GOAL: ${goal}`, `FAILED_STEP: ${JSON.stringify(step)}`, `ERROR: ${outcome.error}`, `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex + 1))}`, ``, `SNAPSHOT:`, trimSnapshot(currentSnapshot)].join('\n') },
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
          const postSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
                  { role: 'user', content: [`GOAL: ${goal}`, `COMPLETED_STEPS: ${JSON.stringify(plan.slice(0, stepIndex + 1))}`, `STALE_REMAINING_PLAN: ${JSON.stringify(remaining)}`, ``, `FRESH_SNAPSHOT (interactive elements only — full ${countRefs(currentSnapshot)}-ref page):`, extractInteractiveRefs(currentSnapshot), learnedRulesBlock, extPlaceholderWarning, ...(agentContext ? [``, `AGENT CONTEXT (site-specific instructions — follow these for this service):`, agentContext] : [])].join('\n') },
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

      // ── Page-ready pre-condition: verify page is not blank before type/fill ──
      // Prevents typing into wrong element when page is still loading/about:blank.
      // This was the root cause of "Item 1" being typed into the Notion title: the
      // page was blank when the plan was generated, so the LLM picked the wrong ref.
      if ((step.action === 'fill' || step.action === 'type') && (step.text || step.value)) {
        _checkDeadline();
        const _readyCheck = await browserAct({ action: 'evaluate', text: 'window.location.href + "|" + document.body.innerText.length', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
        if (_readyCheck?.ok) {
          const [_curHref, _bodyLen] = String(_readyCheck.result || '').split('|');
          if (/about:blank/i.test(_curHref) || parseInt(_bodyLen || '0', 10) < 10) {
            logger.warn(`[playwright.agent] page-ready guard: page is blank/about:blank before ${step.action} — waiting 3s and re-checking`);
            await new Promise(r => setTimeout(r, 3000));
            const _reCheck = await browserAct({ action: 'evaluate', text: 'window.location.href + "|" + document.body.innerText.length', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
            if (_reCheck?.ok) {
              const [_reHref, _reBodyLen] = String(_reCheck.result || '').split('|');
              if (/about:blank/i.test(_reHref) || parseInt(_reBodyLen || '0', 10) < 10) {
                logger.warn(`[playwright.agent] page-ready guard: page still blank after 3s wait — skipping ${step.action} to prevent wrong-element typing`);
                outcome = { ok: false, error: `Page is blank/about:blank — cannot safely ${step.action} into unknown element` };
                transcript.push({ step: stepIndex + 1, action: step, outcome, thoughts: 'page-ready guard: blank page' });
                postProgress(_progressCallbackUrl, {
                  type: 'agent:turn', stepIndex: _stepIndex,
                  turn: stepIndex + 1, maxTurns: plan.length,
                  action: step, outcome: { ok: false, error: outcome.error }, thoughts: 'page-ready guard: blank page',
                });
                // Force repair path
                if (totalRepairs >= maxRepairs) {
                  return { ok: false, goal, sessionId, turns: transcript.length, done: false, result: `Page stayed blank — cannot execute ${step.action}`, transcript, error: outcome.error, executionTime: Date.now() - start };
                }
                totalRepairs++;
                const _guardSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
                if (_guardSnap.ok && _guardSnap.result) currentSnapshot = _guardSnap.result;
                try {
                  const _guardRepairRaw = await askWithMessages([
                    { role: 'system', content: REPAIR_SYSTEM_PROMPT + domainLockBlock },
                    { role: 'user', content: [`GOAL: ${goal}`, `FAILED_STEP: ${JSON.stringify(step)}`, `ERROR: Page was blank/about:blank — the page may still be loading or redirecting. Wait for the page to fully load before retrying.`, `REMAINING_PLAN: ${JSON.stringify(plan.slice(stepIndex + 1))}`, ``, `SNAPSHOT:`, trimSnapshot(currentSnapshot)].join('\n') },
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
          }
        }
      }

      // ── Deduplication: skip redundant fill/type of same text ───────────────
      // Check both 'value' (fill) and 'text' (type) properties for deduplication
      if ((step.action === 'fill' || step.action === 'type')) {
        const textToType = step.value || step.text;
        if (typeof textToType === 'string') {
          // Normalize: trim whitespace and lowercase for comparison
          const normalizedText = textToType.trim().toLowerCase();
          if (normalizedText.length > 0 && _typedTexts.has(normalizedText)) {
            logger.info(`[playwright.agent] deduplication: skipping duplicate ${step.action} for "${textToType.slice(0, 40)}..."`);
            stepIndex++;
            continue;
          }
          _typedTexts.add(normalizedText);
        }
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
          outcome = await browserAct({ ...step, sessionId, headed, timeoutMs });
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

      // ── Mutation submit tracking (Issue 2b) ────────────────────────────────
      // Record _mutationClickTs when a click with purpose:'submit' succeeds after
      // a fill/type step. Used by the goal judge and replan guard to prevent
      // duplicate mutations (e.g. double-posting a tweet).
      if (outcome.ok) {
        if (step.action === 'fill' || step.action === 'type') {
          _hasFillOrType = true;
        }
        if (step.action === 'click' && _hasFillOrType) {
          const _purpose = String(step.purpose || '').toLowerCase();
          const _selHint = String(step.selector || step.ref || step['aria-label'] || '').toLowerCase();
          if (_purpose === 'submit' || /post|submit|send|tweet|publish|create|save|reply/i.test(_selHint)) {
            _mutationClickTs = Date.now();
            logger.info(`[playwright.agent] mutation submit detected: click at ${_mutationClickTs} (purpose=${_purpose || 'inferred'}, selector=${_selHint.slice(0, 40)})`);
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
        if (step.action === 'run-code' && outcome.result) {
          lastRunCodeResult = outcome.result;
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
              const retrySnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
          finalResult = outcome.result || 'Email sent and verified successfully';
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

        // ── Expectation-Driven Execution: Verify action achieved expected outcome ─────
        // Instead of blind DOM change detection, we verify that the action achieved its goal
        // For recipe-driven tasks, skip automatic post-snapshot for fill/type/press —
        // the recipe already navigated to the target page, these actions don't need re-planning.
        const _skipAutoReplan = recipeWasUsed && ['fill', 'type', 'press', 'press-key', 'select', 'check', 'uncheck'].includes(step.action);
        if ((step.expected || (isDomMutating && !_skipAutoReplan))) {
          // Capture pre-snapshot before updating currentSnapshot (used by confidence scoring below)
          const _preStepSnapshot = currentSnapshot;
          // Take a fresh snapshot after the action
          const postSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
            const _microSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs }).catch(() => ({ ok: false }));
            if (_microSnap.ok && _microSnap.result) {
              currentSnapshot = _microSnap.result;
              const _microRemaining = plan.slice(stepIndex + 1);
              const _microRaw = await askWithMessages([
                { role: 'system', content: REPLAN_SYSTEM_PROMPT + domainLockBlock },
                { role: 'user', content: `GOAL: ${_finalGoal || effectiveGoal}\nSTALE_REMAINING:\n${JSON.stringify(_microRemaining)}\nFRESH_SNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot))}${agentContext ? `\n\nAGENT CONTEXT (site-specific instructions — follow these for this service):\n${agentContext}` : ''}` },
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
      const repairSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
        logger.warn(`[playwright.agent] repair response unparseable — aborting`);
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
      );
      if (!_skipRuleLearning && !repairParsed.skip_original && repairParsed.repair.length > 0) {
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
        ], { temperature: 0, maxTokens: 200, responseTimeoutMs: 12000 });

        const _verifyParsed = parseJson(_verifyRaw);

        // ── Dialog-blocking auto-dismiss ─────────────────────────────────────
        // If a dialog is blocking the page, dismiss it and re-verify ONCE.
        // This prevents a "send without subject?" dialog from being counted as a failure.
        if (_verifyParsed && _verifyParsed.dialog_blocking === true) {
          logger.info(`[playwright.agent] verify: dialog blocking detected — auto-dismissing: "${(_verifyParsed.dialog_text || '').slice(0, 80)}"`);
          await browserAct({ action: 'dialog-accept', sessionId, headed, timeoutMs: 3000 }).catch(() => {});
          // Brief settle then re-snapshot + re-verify (only once, non-fatal if it fails)
          await new Promise(r => setTimeout(r, 800));
          try {
            const _reVerifySnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 8000 });
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
      const _judgeSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 });
      const _judgePageText = (_judgeSnap.ok && _judgeSnap.result) ? _judgeSnap.result : currentSnapshot;
      if (_judgeSnap.ok && _judgeSnap.result) currentSnapshot = _judgeSnap.result;

      // Fetch current URL — the most reliable signal for whether an action executed
      // (e.g. search_query param proves search ran regardless of which UI mechanism was used)
      let _judgeCurrentUrl = '';
      try {
        const _urlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 });
        if (_urlRes.ok && _urlRes.result) {
          _judgeCurrentUrl = String(_urlRes.result).trim().replace(/^"|"$/g, '');
        }
      } catch (_) {}

      // ── Network mutation evidence (Issue 2c) ────────────────────────────────
      // Collect window.__tdNetLog entries that occurred after _mutationClickTs to
      // provide ground-truth network evidence to the goal-achievement judge.
      let _mutationNetEvidence = '';
      if (_mutationClickTs) {
        try {
          const _netRes = await browserAct({ action: 'evaluate', text: 'JSON.stringify(window.__tdNetLog || [])', sessionId, headed, timeoutMs: 3000 });
          if (_netRes?.ok && _netRes?.result) {
            let _rawNetResult = String(_netRes.result);
            let _netLogStr;
            try {
              _netLogStr = JSON.parse(_rawNetResult); // unwrap outer string encoding from evaluate
            } catch(_) {
              _netLogStr = _rawNetResult.replace(/^"|"$/g, ''); // fallback: strip quotes
            }
            const _netLog = JSON.parse(_netLogStr || '[]');
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
        const _res = t.outcome.result || t.outcome.error || '';
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

CURRENT PAGE SNAPSHOT (first 800 chars):
${_judgePageText.slice(0, 800)}

Judge whether the goal was accomplished. Consider BOTH the action history and the current page state.

IMPORTANT RULES:
- PAGE CONTENT IS PRIMARY EVIDENCE: The page content/URL/snapshot must show evidence that the goal was achieved. Action history alone (e.g. "type:ok" or "click:ok") is NOT sufficient — a successful action does not mean the goal was accomplished. You must find concrete evidence in the page state.
- If the action history includes ">sendEmailWithVerification:ok", the email was successfully sent and verified. This is conclusive evidence. The mail inbox is the expected page after a successful send. The absence of a compose window means the email was sent, not that it failed.
- If EMAIL_SEND_VERIFICATION is provided, it is authoritative proof of completion.
- MUTATION_NETWORK_EVIDENCE RULE: If MUTATION_NETWORK_EVIDENCE is provided with NetworkStatus=2xx-success, this is strong evidence that a mutation (post/create/submit) succeeded. Combined with the action history showing a fill+submit sequence, set achieved=true unless the page explicitly shows an error message. If NetworkStatus=error-status (4xx/5xx), set achieved=false and canRetry=true. If NetworkStatus=no-clear-status, fall back to page content analysis.
- For non-mail tasks, focus on the END STATE — does the page content/URL show the goal was accomplished? If the page content does not contain expected text/elements matching the goal, achieved MUST be false.
- RICH TEXT EDITOR RULE: Google Docs, Notion, Confluence, and similar editors use canvas/custom rendering. Content typed via a prior 'type' or 'fill' action may NOT appear in the DOM snapshot even though it was entered successfully. If the action history includes type:ok or fill:ok with text content matching the goal, and the page is a rich text editor / contenteditable, consider the content as entered even if it doesn't appear in the page snapshot.
- AUTOSAVE RULE: Transient save/sync indicators ("Saving…", "Syncing…", "Uploading…") are NORMAL autosave states and are NOT evidence of goal non-achievement. A "Saving…" or "Saved" indicator on a document editor means the action was accepted and is being persisted.
- CANVAS APP RULE: For canvas apps (Notion, Google Docs, etc.), if page content is sparse but action history shows successful type/press steps matching the goal text, AND the page type was classified as 'canvas' or 'hybrid', consider the goal achieved. The ARIA tree cannot represent canvas content.

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
            const _status = _netStatus ? _netStatus[1] : 'no-clear-status';
            if (_status === '2xx-success' || _status === 'no-clear-status') {
              logger.warn(`[playwright.agent] Mutation guard: _mutationClickTs set + network=${_status} — prohibiting replan to prevent duplicate mutation`);
              _canRetry = false;
            }
          }

          if (_canRetry && totalRepairs < maxRepairs) {
            totalRepairs++;
            logger.warn(`[playwright.agent] Goal not achieved — adaptive replan ${totalRepairs}/${maxRepairs}: ${_judgeResult.reason}`);

            const _replanSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs });
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
              question: `I wasn't able to complete the task after ${totalRepairs} attempt(s).\n\nReason: ${_judgeResult.reason}\n\nWhat would you like to do?`,
              options: [
                { label: 'Try again', value: 'try_again' },
                { label: 'Train me to navigate this path', value: 'open_agents_training' },
              ],
              goal,
              sessionId,
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
      logger.warn(`[playwright.agent] aborted due to overall timeout — returning partial result`);
      return {
        ok: false, goal, sessionId,
        turns: transcript.length, done: false,
        result: `Task timed out after ${overallTimeoutMs}ms`,
        transcript, error: _deadlineErr.message, executionTime: Date.now() - start,
      };
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
    result: finalResult !== null ? finalResult : `Completed: ${goal}`,
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

  return {
    ok: true, goal, sessionId,
    turns: transcript.length, done: true,
    result: finalResult !== null ? finalResult : `Completed: ${goal}`,
    transcript,
    routingDecision: _routingDecision,
    pageType: _pageType,
    verification: _tier3Verification,
    executionTime: Date.now() - start,
  };
}

module.exports = {
  playwrightAgent,
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
};
