'use strict';

/**
 * skill: browser.agent
 *
 * Factory skill that discovers, builds, and manages Playwright-backed narrow agents.
 * Each generated agent is stored as a structured .md descriptor in DuckDB at
 * ~/.thinkdrop/agents.db and as a .md file under ~/.thinkdrop/agents/.
 *
 * These agents are purpose-built for specific web services (slack.agent,
 * discord.agent, notion.agent, etc.) that have no CLI. They understand the
 * DOM layout and navigation patterns of their target service.
 *
 * Actions:
 *   build_agent    { service, startUrl?, force? } → generates .md descriptor,
 *                                                    stores in DuckDB
 *   query_agent    { service?, id? }              → retrieves agent descriptor
 *   list_agents    {}                             → all browser agents in registry
 *   validate_agent { id }                         → checks if service URL is reachable,
 *                                                    updates status
 *   run            { agentId, task, context? }    → executes a task using the agent's
 *                                                    descriptor as LLM context + browser.act
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const http = require('http');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// WALT: Build JavaScript extraction code for different extract types
// ---------------------------------------------------------------------------
function _buildExtractionCode(selector, extractType, extractOptions = {}) {
  const escapedSelector = selector.replace(/"/g, '\\"');
  const { dataAttr, attrName } = extractOptions;
  
  switch (extractType) {
    case 'text':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.textContent.trim();
      })()`;
    case 'href':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.href || el.getAttribute('href') || null;
      })()`;
    case 'value':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.value || el.getAttribute('value') || null;
      })()`;
    case 'html':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.outerHTML;
      })()`;
    case 'src':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.src || el.getAttribute('src') || null;
      })()`;
    case 'data':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const dataAttr = "${dataAttr || 'id'}";
        return el.getAttribute('data-' + dataAttr) || el.dataset[dataAttr] || null;
      })()`;
    case 'attr':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const attrName = "${attrName || 'id'}";
        return el.getAttribute(attrName) || null;
      })()`;
    case 'json':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        try {
          const text = el.textContent.trim();
          return JSON.parse(text);
        } catch (e) {
          return null;
        }
      })()`;
    case 'table':
      return `(function() {
        const table = document.querySelector("${escapedSelector}");
        if (!table) return null;
        const rows = [];
        const headers = [];
        const ths = table.querySelectorAll('th');
        ths.forEach(th => headers.push(th.textContent.trim()));
        const trs = table.querySelectorAll('tr');
        trs.forEach(tr => {
          const tds = tr.querySelectorAll('td');
          if (tds.length === 0) return;
          const row = {};
          tds.forEach((td, i) => {
            const key = headers[i] || 'col' + i;
            row[key] = td.textContent.trim();
          });
          rows.push(row);
        });
        return rows;
      })()`;
    case 'list':
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        const items = el.querySelectorAll('li');
        if (items.length === 0) return [el.textContent.trim()];
        return Array.from(items).map(li => li.textContent.trim());
      })()`;
    default:
      return `(function() {
        const el = document.querySelector("${escapedSelector}");
        if (!el) return null;
        return el.textContent.trim();
      })()`;
  }
}

// ---------------------------------------------------------------------------
// LLM-based auth detection prompt — semantic analysis of page content
// ---------------------------------------------------------------------------
const AUTH_CHECK_PROMPT = `You are analyzing a web page to determine if the user is authenticated.
Given the page TITLE and BODY TEXT, return ONLY a single number:
0 = authenticated (user is logged in — page shows real app content: calendar events, emails, files, dashboard data)
1 = auth required (page is a login form, sign-in page, marketing/landing page, or "create account" page)

Rules:
- 1 (auth required): login forms, "Sign in" buttons, marketing pages, "Get started", "Create account", "Sign in to continue", "Workspace not found"
- 0 (authenticated): page shows actual app content (calendar with events, inbox with emails, dashboard with data, documents)
- When in doubt, return 1 (auth required — safer to re-authenticate)
Return ONLY the number.`;

// ---------------------------------------------------------------------------
// Auth-check result cache — avoids repeated navigate+evaluate probes
// Key: agentId  Value: { ts: Date.now(), authNeeded: bool }
// TTL: 120s — re-probe if the last confirmed-ok check is older than this.
// ---------------------------------------------------------------------------
const AUTH_CHECK_CACHE_TTL_MS = 120_000;
const _authCheckCache = new Map(); // agentId → { ts, authNeeded }

// ---------------------------------------------------------------------------
// Session mutex — prevents concurrent playwright.agent + waitForAuth calls
// on the same browser session. Key: sessionId  Value: Promise (running task)
// When waitForAuth is needed, the current playwright.agent run MUST have
// already returned (loginWallDetected:true) before waitForAuth fires —
// the mutex enforces this and provides a guard for any future parallel calls.
// ---------------------------------------------------------------------------
const _sessionMutex = new Map(); // sessionId → Promise

async function _withSessionMutex(sessionId, fn) {
  // Wait for any in-progress operation on this session to finish first
  const _existing = _sessionMutex.get(sessionId);
  if (_existing) {
    logger.warn(`[browser.agent] session mutex: waiting for prior operation on ${sessionId} to finish`);
    await _existing.catch(() => {}); // wait but don't rethrow prior errors
  }
  let _resolve;
  const _lock = new Promise(r => { _resolve = r; });
  _sessionMutex.set(sessionId, _lock);
  try {
    return await fn();
  } finally {
    _resolve();
    if (_sessionMutex.get(sessionId) === _lock) _sessionMutex.delete(sessionId);
  }
}

function _getCachedAuthCheck(agentId) {
  const entry = _authCheckCache.get(agentId);
  if (!entry) return null;
  if (Date.now() - entry.ts > AUTH_CHECK_CACHE_TTL_MS) {
    _authCheckCache.delete(agentId);
    return null;
  }
  return entry;
}

function _setCachedAuthCheck(agentId, authNeeded) {
  _authCheckCache.set(agentId, { ts: Date.now(), authNeeded });
}

// ---------------------------------------------------------------------------
// LLM-based auth detection — semantic analysis (number return for fast light-model use)
// Returns: 0 = authenticated, 1 = auth required
// ---------------------------------------------------------------------------
async function _detectAuthViaLLM(title, body, agentId) {
  try {
    const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
    const raw = await askWithMessages([
      { role: 'system', content: AUTH_CHECK_PROMPT },
      { role: 'user', content: `TITLE: ${(title || '').slice(0, 200)}\n\nBODY: ${(body || '').slice(0, 1000)}` }
    ], { temperature: 0, maxTokens: 5, responseTimeoutMs: 5000 });

    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num === 0 || num === 1) {
      logger.info(`[browser.agent] LLM auth detection: ${num === 1 ? 'auth required' : 'authenticated'} for ${agentId}`);
      return num; // 0 = authed, 1 = auth required
    }
    logger.info(`[browser.agent] LLM auth detection: invalid "${raw}" → defaulting to 1 (auth required) for ${agentId}`);
    return 1; // default: auth required (safer)
  } catch (err) {
    logger.warn(`[browser.agent] LLM auth detection failed (non-fatal): ${err.message}`);
    return 1; // default: auth required (safer)
  }
}

// ---------------------------------------------------------------------------
// Domain Map helpers — content extraction discovery from explore.agent scan mode
// ---------------------------------------------------------------------------

const DOMAIN_MAPS_DIR = path.join(os.homedir(), '.thinkdrop', 'domain-maps');

function _loadDomainMap(hostname) {
  try {
    const p = path.join(DOMAIN_MAPS_DIR, `${hostname}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
}

/**
 * Get content extraction config from domain map for a hostname.
 * Returns { primary_selector, fallback_selector, content_type } or null.
 */
function getContentExtractionConfig(hostname) {
  if (!hostname) return null;
  const map = _loadDomainMap(hostname.replace(/^www\./, ''));
  return map?.content_extraction || null;
}

// ---------------------------------------------------------------------------
// Tab-Map helper: Convert a free-text task into instruction.runner-format
// text instructions via a single LLM call. The browser is already on the
// target page (URL-first navigation done), so no Navigate step is emitted
// unless the task explicitly requires a different URL.
// instruction.runner's tab-map scan discovers the real elements at runtime
// and the LLM pick matches them — so exact button labels don't need to be
// perfect, just close enough for fuzzy matching.
// ---------------------------------------------------------------------------
async function _convertGoalToInstructions(task, startUrl, agentContext, hostname) {
  if (!task || typeof task !== 'string') return null;

  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext
    ? `\n\nAgent context (service descriptor / playbook — use these labels if relevant):\n${String(agentContext).slice(0, 2000)}`
    : '';
  const _urlBlock = startUrl ? `\n\nCurrent page URL: ${startUrl}` : '';
  const _hostBlock = hostname ? `\nService hostname: ${hostname}` : '';

  const systemPrompt = `You convert a browser automation task into step-by-step keyboard navigation instructions.
The browser has ALREADY navigated to the target URL (URL-first navigation is done).
Look at the "Current page URL" below — if it contains an action hash or path like
"#inbox?compose=new", "/new", "/create", "?action=edit", the action is ALREADY TRIGGERED.
A modal/dialog/popup/dropdown may be open on screen with fields ready to fill.
Do NOT click a button to open it — that would dismiss the existing overlay.
Start directly with typing into the fields.

The task text may say "Compose a new email" or "Create a new document" — this describes
the GOAL, not a button to click. If the URL already triggered this action, skip the click.

Output ONLY instructions, one per line. No preamble, no explanation, no numbering, no markdown.

Instruction formats (use EXACTLY these verb forms):
  Click "button text"
  Type "value" into the "field label" field
  Press Enter
  Press Tab
  Press Escape
  Navigate to https://url

Rules:
- CRITICAL: Use ONLY these verb forms — Click, Type, Press Enter, Press Tab, Press Escape, Navigate. Do NOT use "Fill", "Enter text", "Input", "Select text", or any other verb.
- CRITICAL: NEVER use CSS selectors (div[...], input[...], [aria-label=...], [gh=...]). Use ONLY the visible text/label of buttons and fields as they appear on the page. The system finds elements by their visible text, NOT by CSS selectors.
- Look at the Current page URL. If it already contains the action (e.g. compose=new, /new, /create, ?action=edit), the action window is ALREADY OPEN — do NOT add a click step to open it. Start directly with Type steps.
- The task text may say "Compose a new email" or "Create a new document" — this describes the GOAL, not a button to click. If the URL already triggered this action, skip the click.
- The browser is ALREADY on the target page (URL-first navigation done). Do NOT add a Navigate step unless the task explicitly requires going to a different URL than the current one.
- Use the EXACT text/label of buttons and fields as they appear on the page. If unsure, use the most likely label based on the service.
- Extract values to type from the task text (quoted strings, names, search queries, message bodies).
- Keep it minimal — only the steps needed to accomplish the task, in order.
- For dropdowns/menus: Click the trigger button, then Click the menu item.
- End with Press Enter or Click "Submit"/"Send"/"Save" if the action requires confirmation.
- If the task is a read/extract task (search, list, read), end with the navigation to results — no extract step needed.
- Do NOT wrap values in {{param}} — use the literal value from the task.
- CHIP / TOKEN FIELDS (email To, Recipients, CC, BCC, Gmail, Outlook, any recipient input): After every "Type \\"...\\" into the \\"To/Recipients/CC/BCC\\" field" step, you MUST add a separate "Press Enter" step to confirm the chip/token. If the address is still in the input after one Enter, add another "Press Enter" step before continuing to Subject.
- AI CHAT SUBMIT (ChatGPT, Claude, Gemini, Grok, Perplexity): After "Type \\"...\\" into the \\"message\\" field", add "Press Enter" to submit the prompt. The system waits for the streamed response automatically.
- LIST ITEM CREATION (Notion todos, checklist items): After typing each item, add "Press Enter" to create the next item.
- Use the literal field labels shown by the page — for Gmail compose use "To" or "Recipients", not the generic search box.
- For Gmail compose: the recipient field label is "To", the subject field label is "Subject", the body field label is "Message Body", the send button text is "Send", the compose button text is "Compose".`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Task: ${task}${_urlBlock}${_hostBlock}${_contextBlock}` },
    ], { maxTokens: 600, temperature: 0.1, responseTimeoutMs: 15000 });

    const text = (raw || '').trim();
    if (!text) {
      logger.warn(`[browser.agent] tab-map: task→instructions LLM returned empty`);
      return null;
    }
    const cleaned = text.replace(/^```(?:text|plaintext)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    logger.info(`[browser.agent] tab-map: converted task to instructions:\n${cleaned.split('\n').map(l => '  ' + l).join('\n')}`);
    return cleaned;
  } catch (e) {
    logger.warn(`[browser.agent] tab-map: task→instructions LLM failed: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Three-tier iterative navigation: decision call + strategies
// ---------------------------------------------------------------------------
// Tier 2: Decision call — LLM returns 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Tab-Map)
// Tier 3: Strategy execution with fallback to Tab-Map

// Decision call: returns 0, 1, 2, or 3 based on page state and goal.
async function _decisionCall(goal, actionHistory, currentUrl, focusedElement, overlayActive, pageCategory, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext
    ? `\n\nAgent context (service descriptor / playbook — use these labels if relevant):\n${String(agentContext).slice(0, 1000)}`
    : '';

  const _focusedStr = focusedElement
    ? _buildFocusedStr(focusedElement)
    : 'none (body/no focus)';

  const _isFillable = focusedElement
    ? (['input', 'textarea'].includes(focusedElement.tag) ||
       ['combobox', 'textbox'].includes(focusedElement.role))
    : false;

  const systemPrompt = `You decide the next navigation strategy for a browser automation task.
Look at the goal, what's been done, and the current page state.
Return ONLY a single number — nothing else:
  0 = DONE (goal achieved)
  1 = Just-type (focused element is the right field, just type into it)
  2 = Meta+F search (find specific text on the page, then click it)
  3 = App Shortcuts (press an app-specific keyboard shortcut from Agent context)
  4 = Tab-Map scan (scan all elements, pick one to interact with)

Decision rules:
- If the focused element is a fillable input AND the goal requires typing into it → return 1
- If the Agent context contains app shortcuts that match the next sub-goal (e.g. "c" for create event in Calendar, "Cmd+K" for search in Slack/Spotify) → return 3
- Prefer 3 (shortcuts) over 4 (Tab-Map) when a shortcut directly accomplishes the next sub-goal — shortcuts are faster
- If the goal requires finding a specific item on the page (conversation name, email subject, menu item, list entry) → return 2
- If the goal requires interacting with multiple elements (form filling, toolbar buttons, multi-field modal) → return 4
- If the goal requires creating blocks/list items/headings in a block-based editor (Notion, Google Docs) → return 4 (needs multi-step slash command sequences)
- If everything in the goal has been accomplished (see action history) → return 0
- If a modal/dialog is open with multiple fields to fill → return 4
- If the page just loaded and you're not sure what's available → return 4
- Check the Agent context for app-specific patterns (shortcuts, slash commands, UI quirks) that might affect the strategy choice
- When in doubt → return 4`;

  const historyStr = actionHistory.length > 0
    ? actionHistory.slice(-10).map((a, i) => `  ${i + 1}. ${a}`).join('\n')
    : '  (none)';

  const userPrompt = `Goal: ${goal}
Current URL: ${currentUrl}
Page category: ${pageCategory || 'unknown'}
Focused element: ${_focusedStr} (fillable: ${_isFillable ? 'yes' : 'no'})
Overlay/modal active: ${overlayActive ? 'yes' : 'no'}
Actions taken so far:
${historyStr}${_contextBlock}

Strategy? (0, 1, 2, or 3)`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 10, temperature: 0.1, responseTimeoutMs: 10000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    const result = [0, 1, 2, 3, 4].includes(num) ? num : 4;
    logger.info(`[browser.agent] _decisionCall: strategy=${result} (raw="${(raw || '').trim()}")`);
    return result;
  } catch (e) {
    logger.warn(`[browser.agent] _decisionCall failed: ${e.message} — defaulting to 4 (Tab-Map)`);
    return 4;
  }
}

// ── Canvas layout scan ─────────────────────────────────────────────────
// Lightweight DOM scan that identifies editable regions and their structure.
// Returns a compact layout overview for the LLM so it can "see" the page layout.
// Generic — uses ARIA roles, element types, and layout heuristics (not app-specific).
// Works for: document editors (Notion, Google Docs), code editors (StackBlitz),
// design canvas (Figma, Mermaid), spreadsheets (Google Sheets, Airtable).
async function _scanCanvasLayout(sessionId) {
  try {
    const res = await callBrowserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      // ── Region classifier: maps a DOM element to a region type ──
      function _classifyRegion(el) {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        const ariaRoleDesc = el.getAttribute('aria-roledescription') || '';
        const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const ce = el.isContentEditable;
        const r = el.getBoundingClientRect();

        // 1. Title: explicit aria-roledescription, placeholder, or h1 contenteditable
        if (ariaRoleDesc.includes('page title') || ariaRoleDesc.includes('title')) return 'title';
        if (placeholder.includes('untitled') || placeholder.includes('new page')) return 'title';
        if (tag === 'h1' && ce) return 'title';

        // 2. Code editor: CodeMirror, Monaco, or textarea with code
        if (cls.includes('cm-editor') || cls.includes('monaco-editor') || el.closest('.cm-editor, .monaco-editor')) return 'editor';
        if (tag === 'textarea' && (cls.includes('code') || el.closest('[class*="editor"]'))) return 'editor';

        // 3. Preview: iframe
        if (tag === 'iframe') return 'preview';

        // 4. Terminal: xterm, .terminal, role=log
        if (cls.includes('xterm') || cls.includes('terminal') || el.closest('.xterm, .terminal, [class*="terminal"]')) return 'terminal';
        if (role === 'log') return 'terminal';

        // 5. Spreadsheet: role=grid, or canvas with grid pattern (Google Sheets)
        if (role === 'grid' || el.closest('[role="grid"]')) return 'spreadsheet';
        if (tag === 'canvas' && r.width > 400 && r.height > 200) {
          // Heuristic: large canvas in a spreadsheet context
          if (el.closest('[class*="sheet"], [class*="spreadsheet"], [class*="grid"]')) return 'spreadsheet';
          return 'canvas'; // Figma, Mermaid, Excalidraw
        }

        // 6. Formula bar / name box: input with formula/cell labels
        if (tag === 'input') {
          const al = (el.getAttribute('aria-label') || '').toLowerCase();
          if (al.includes('formula') || al.includes('fx')) return 'formula_bar';
          if (al.includes('name') && r.width < 100) return 'name_box';
        }

        // 7. SVG canvas (Figma, Mermaid)
        if (tag === 'svg' && r.width > 200 && r.height > 200) return 'canvas';

        // 8. Sidebar: narrow panel on left/right edge with nav items
        if (r.width > 0 && r.width < 300 && (r.x < 50 || r.x + r.width > window.innerWidth - 50)) {
          if (el.querySelector('a, [role="treeitem"], [role="link"], .file-tree, [class*="layer"]')) return 'sidebar';
        }

        // 9. Toolbar: horizontal bar with many buttons
        if (r.height < 80 && r.width > 200) {
          const btns = el.querySelectorAll('[role="button"], button');
          if (btns.length >= 3 && !ce) return 'toolbar';
        }

        // 10. Sheet tabs: tablist at bottom of page
        if (role === 'tablist' && r.y > window.innerHeight * 0.6) return 'sheet_tabs';

        // 11. Properties/inspector: small panel with multiple inputs
        if (r.width < 350 && r.x + r.width > window.innerWidth - 350) {
          if (el.querySelectorAll('input, select').length >= 2) return 'properties';
        }

        // 12. Body: contenteditable that's not title, in main content area
        if (ce && role === 'textbox') {
          // Check if parent has page-content or similar
          const parent = el.closest('[class*="page-content"], [class*="content"], [class*="body"], [class*="block"]');
          if (parent) return 'body';
          // Fallback: contenteditable textbox without title signals
          if (!ariaRoleDesc.includes('title')) return 'body';
        }

        // 13. Generic contenteditable
        if (ce) return 'body';

        return null; // not a recognized region
      }

      // ── Get scoped text (not flattened innerText) ──
      function _getScopedText(el) {
        // For inputs/textarea, use .value
        if (el.value !== undefined && el.value !== '') return String(el.value).slice(0, 150);
        // For contenteditable, try selection-based text first
        if (el.isContentEditable) {
          try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              let node = sel.getRangeAt(0).startContainer;
              if (node.nodeType === 3) node = node.parentElement;
              while (node && node !== el && node.parentElement !== el) node = node.parentElement;
              const t = (node?.innerText || node?.textContent || '').trim();
              if (t) return t.slice(0, 150);
            }
          } catch (_) {}
        }
        // Fallback: first-level child text only (not deeply nested)
        let text = '';
        for (const child of el.childNodes) {
          if (child.nodeType === 3) text += child.textContent + ' ';
          else if (child.nodeType === 1 && !child.querySelector('svg, [role="button"], button')) {
            text += (child.innerText || child.textContent || '').slice(0, 80) + ' ';
          }
          if (text.length > 150) break;
        }
        return text.trim().replace(/\\s+/g, ' ').slice(0, 150);
      }

      // ── Find all candidate region elements ──
      const candidates = new Set();
      // Contenteditable elements
      document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Inputs and textareas (excluding hidden/checkbox/radio)
      document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Code editors
      document.querySelectorAll('.cm-editor, .monaco-editor, [class*="cm-editor"], [class*="monaco-editor"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Iframes (preview)
      document.querySelectorAll('iframe').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Terminals
      document.querySelectorAll('.xterm, .terminal, [class*="terminal"], [role="log"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Spreadsheets
      document.querySelectorAll('[role="grid"], canvas').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // SVGs (canvas apps)
      document.querySelectorAll('svg').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 200 && r.height > 200) candidates.add(el);
      });
      // Toolbars: containers with many buttons
      document.querySelectorAll('[class*="toolbar"], [class*="page-controls"], [role="toolbar"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });
      // Tablists at bottom (sheet tabs)
      document.querySelectorAll('[role="tablist"]').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) candidates.add(el);
      });

      // ── Classify and build region list ──
      // Deduplicate: remove elements contained within other candidates of same type
      const regions = [];
      let id = 0;
      const seen = new WeakSet();
      for (const el of candidates) {
        if (seen.has(el)) continue;
        // Skip if parent candidate already covers this (avoid nested duplicates)
        let dominated = false;
        for (const other of candidates) {
          if (other === el) continue;
          if (other.contains(el) && !seen.has(other)) {
            // Keep the more specific (inner) element for contenteditable, outer for containers
            const otherType = _classifyRegion(other);
            const elType = _classifyRegion(el);
            if (otherType === elType && otherType !== 'toolbar' && otherType !== 'preview') {
              dominated = true;
              break;
            }
          }
        }
        if (dominated) continue;
        seen.add(el);

        const type = _classifyRegion(el);
        if (!type) continue;

        const r = el.getBoundingClientRect();
        const text = _getScopedText(el);
        const editable = el.isContentEditable || ['input', 'textarea'].includes(el.tagName.toLowerCase());
        const role = el.getAttribute('role') || '';

        // State
        let state = editable ? (text ? 'filled' : 'empty') : 'not editable';
        if (type === 'preview') state = 'iframe';
        if (type === 'spreadsheet') state = 'grid';
        if (type === 'canvas') state = 'graphic';

        // For body regions, count sub-blocks (Notion-style)
        let blockCount = 0;
        if (type === 'body') {
          const blocks = el.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
          blockCount = blocks.length;
          if (blockCount === 0 && el.isContentEditable) blockCount = 1; // single block
        }

        regions.push({
          id: ++id,
          type,
          text,
          state,
          editable,
          role,
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          blockCount,
        });
      }

      // Sort by position (y, then x)
      regions.sort((a, b) => a.y - b.y || a.x - b.x);

      // ── Detect focused region ──
      let focusedId = -1;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          let node = sel.getRangeAt(0).startContainer;
          if (node.nodeType === 3) node = node.parentElement;
          for (const reg of regions) {
            // Find the element for this region by matching position
            // (we don't store element refs in the return value)
          }
        }
      } catch (_) {}
      // Fallback: use document.activeElement
      const active = document.activeElement;
      if (active && active !== document.body) {
        for (let i = 0; i < regions.length; i++) {
          const reg = regions[i];
          // Match by checking if active element has same position
          const ar = active.getBoundingClientRect();
          if (Math.abs(ar.y - reg.y) < 20 && Math.abs(ar.x - reg.x) < 20) {
            focusedId = reg.id;
            break;
          }
          // Or if active is contenteditable and matches text
          if (active.isContentEditable && reg.editable && reg.type === 'body') {
            const activeText = (active.innerText || '').trim().slice(0, 40);
            if (activeText && reg.text.includes(activeText)) {
              focusedId = reg.id;
              break;
            }
          }
        }
      }

      // ── Format as compact markup ──
      const lines = regions.map(reg => {
        const pos = reg.x > 0 ? \`x=\${reg.x}\` : \`y=\${reg.y}\`;
        const focus = reg.id === focusedId ? ' ← FOCUSED' : '';
        let content;
        if (reg.type === 'toolbar') {
          const btns = [];
          // Re-find element to count buttons
          content = '[buttons]';
        } else if (reg.type === 'preview') {
          content = '(iframe)';
        } else if (reg.type === 'spreadsheet') {
          content = \`grid \${reg.w}x\${reg.h}\`;
        } else if (reg.type === 'canvas') {
          content = '(graphic)';
        } else if (reg.blockCount > 1) {
          content = \`\${reg.blockCount} blocks\`;
        } else {
          content = reg.text ? \`"\${reg.text.slice(0, 60)}"\` : '""';
        }
        return \`  #\${reg.id} [\${reg.type}] \${pos}  \${content}\${focus}, \${reg.state}\`;
      });
      const layoutText = 'LAYOUT:\\n' + lines.join('\\n');

      return { regions, focusedId, layoutText };
    })()`,
    });

    // callBrowserAct returns { result, stdout, ... } — extract the JSON result
    let raw = '';
    if (res?.stdout) {
      const _m = res.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      raw = _m ? _m[1].trim() : res.stdout.trim();
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
    } else {
      raw = String(res?.result || '').replace(/^"|"$/g, '');
    }
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { parsed = null; }
    if (parsed?.regions?.length > 0) {
      logger.info(`[browser.agent] _scanCanvasLayout: ${parsed.regions.length} regions, focused=#${parsed.focusedId} — ${parsed.layoutText.replace(/\\n/g, ' | ')}`);
    }
    return parsed || { regions: [], focusedId: -1, layoutText: '' };
  } catch (e) {
    logger.warn(`[browser.agent] _scanCanvasLayout failed: ${e.message}`);
    return { regions: [], focusedId: -1, layoutText: '' };
  }
}

// ---------------------------------------------------------------------------
// _readEditorState — unified editor state reader for canvas-based editors.
//
// Gives Just-type "total awareness" of where the cursor is in the document:
//   region (title/body/subject/code/cell), block index, block type, block text,
//   cursor offset, and all blocks for context.
//
// Multi-strategy:
//   1. DOM-ContentEditable (Notion, Confluence, Gmail, Outlook) — reads from DOM
//   2. DOM-CodeEditor (CodeMirror, Monaco) — reads editor-specific DOM structure
//   3. DOM-Spreadsheet (Google Sheets) — reads aria-label cell address
//   4. OCR-Hybrid (Google Docs canvas) — OCR line clustering + DOM active-element y
//
// Returns unified shape:
//   { region, blockIndex, totalBlocks, blockType, blockText, cursorOffset,
//     titleText, allBlocks, source }
// Or null if state can't be determined.
// ---------------------------------------------------------------------------

// Strategy 1: DOM for contenteditable editors (Notion, Confluence, Gmail, etc.)
async function _readEditorStateDOM(sessionId) {
  try {
    const res = await callBrowserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      const active = document.activeElement;
      if (!active || active === document.body) return null;

      // ── Leaf detection (same as _readActiveElement) ──
      let el = active;
      if (el.isContentEditable) {
        try {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            let node = sel.getRangeAt(0).startContainer;
            if (node.nodeType === 3) node = node.parentElement;
            while (node && !node.isContentEditable) node = node.parentElement;
            if (node && node !== el && el.contains(node)) el = node;
          }
        } catch (_) {}
      }

      // ── Region detection (multi-app, not Notion-specific) ──
      const tag = el.tagName.toLowerCase();
      const ariaRoleDesc = el.getAttribute('aria-roledescription') || '';
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '').toLowerCase();
      const name = el.getAttribute('name') || '';
      const isTitle = ariaRoleDesc.includes('title') ||
                      (tag === 'h1' && el.isContentEditable) ||
                      placeholder.includes('untitled') || placeholder.includes('new page');
      const isSubject = (name === 'subject' || ariaLabel.includes('subject')) && !isTitle;
      const region = isTitle ? 'title' : isSubject ? 'subject' : 'body';

      // ── Cursor position ──
      let cursorOffset = 0;
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) cursorOffset = sel.anchorOffset || 0;
      } catch (_) {}

      // ── Current block text ──
      const blockText = (el.innerText || el.value || '').trim().slice(0, 200);

      // ── Title text (from any title element on page) ──
      const titleEl = document.querySelector(
        'h1[contenteditable], [aria-roledescription*="title" i], [aria-roledescription*="page title" i]'
      );
      const titleText = titleEl ? (titleEl.innerText || '').trim().slice(0, 100) : '';
      const subjectEl = document.querySelector('input[name="subject"], [aria-label*="subject" i]');
      const subjectText = subjectEl ? (subjectEl.value || '').trim().slice(0, 100) : '';

      // ── Block enumeration (app-specific → generic fallback) ──
      if (isTitle || isSubject) {
        return {
          region, blockIndex: 1, totalBlocks: 1,
          blockType: region, blockText, cursorOffset,
          titleText: isTitle ? blockText : titleText,
          allBlocks: [{ index: 1, type: region, text: blockText }],
          source: 'dom',
        };
      }

      // Body region — enumerate all blocks
      // Strategy A: app-specific block containers (Notion [data-block-id])
      let blockEls = document.querySelectorAll(
        '[data-block-id] [contenteditable="true"], [data-block-id] [contenteditable=""], [data-block-id][contenteditable="true"]'
      );
      // Strategy B: generic — all contenteditable in main content area
      if (blockEls.length === 0) {
        const main = document.querySelector(
          '[class*="page-content"], [class*="editor-content"], [class*="document-content"], [role="main"], main, [class*="compose"] [class*="body"]'
        );
        blockEls = (main || document).querySelectorAll('[contenteditable="true"], [contenteditable=""]');
      }

      // Deduplicate nested contenteditable (parent + child both contenteditable)
      const deduped = [];
      const seen = new Set();
      blockEls.forEach(b => {
        if (seen.has(b)) return;
        // Skip if parent is already in list (avoid nested duplicates)
        let dominated = false;
        blockEls.forEach(other => {
          if (other !== b && other.contains(b) && !seen.has(other)) dominated = true;
        });
        if (!dominated) { deduped.push(b); seen.add(b); }
      });

      // Build block list
      const blocks = deduped.map((b, i) => {
        const text = (b.innerText || '').trim().slice(0, 80);
        const hasCheckbox = !!b.closest('[role="checkbox"], [class*="todo"], [data-type="todo"]');
        const isHeading = !!b.closest('h1, h2, h3, [class*="heading"], [data-type="heading"]');
        const isBullet = !!b.closest('[class*="bullet"], [data-type="bullet"], [class*="list-item"]');
        const isNumbered = !!b.closest('[class*="numbered"], [data-type="numbered"], [class*="ordered"]');
        const type = hasCheckbox ? 'todo' : isHeading ? 'heading' : isBullet ? 'bullet' : isNumbered ? 'numbered' : 'paragraph';
        return { index: i + 1, type, text: text || '' };
      });

      // Find active block index
      const activeRect = el.getBoundingClientRect();
      let activeIdx = -1;
      deduped.forEach((b, i) => {
        const r = b.getBoundingClientRect();
        if (Math.abs(r.y - activeRect.y) < 20 && Math.abs(r.x - activeRect.x) < 20) {
          activeIdx = i;
        }
      });
      // Fallback: match by text
      if (activeIdx < 0 && blockText) {
        deduped.forEach((b, i) => {
          if (activeIdx >= 0) return;
          if ((b.innerText || '').includes(blockText.slice(0, 40))) activeIdx = i;
        });
      }
      // Fallback: use activeElement directly
      if (activeIdx < 0) {
        activeIdx = deduped.findIndex(b => b === el);
      }

      return {
        region, blockIndex: activeIdx + 1, totalBlocks: deduped.length,
        blockType: blocks[activeIdx]?.type || 'paragraph',
        blockText, cursorOffset,
        titleText: titleText || subjectText,
        allBlocks: blocks.slice(0, 15), source: 'dom',
      };
    })()`,
    });

    let raw = '';
    if (res?.stdout) {
      const _m = res.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      raw = _m ? _m[1].trim() : res.stdout.trim();
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
    } else {
      raw = String(res?.result || '').replace(/^"|"$/g, '');
    }
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { parsed = null; }
    return parsed || null;
  } catch (e) {
    logger.warn(`[browser.agent] _readEditorStateDOM failed: ${e.message}`);
    return null;
  }
}

// Strategy 2: DOM for code editors (CodeMirror, Monaco)
async function _readEditorStateCode(sessionId) {
  try {
    const res = await callBrowserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      // Detect editor type
      const cmEditor = document.querySelector('.cm-editor, [class*="cm-editor"]');
      const monacoEditor = document.querySelector('.monaco-editor, [class*="monaco-editor"]');

      if (cmEditor) {
        // CodeMirror
        const lines = document.querySelectorAll('.cm-line');
        const activeLine = document.querySelector('.cm-activeLine');
        const cursor = document.querySelector('.cm-cursor');
        const lineTexts = [];
        lines.forEach((l, i) => {
          lineTexts.push({ index: i + 1, type: 'code_line', text: (l.textContent || '').slice(0, 80) });
        });
        const activeIdx = activeLine ? [...lines].indexOf(activeLine) : -1;
        return {
          region: 'code', blockIndex: activeIdx + 1, totalBlocks: lines.length,
          blockType: 'code_line',
          blockText: activeLine ? (activeLine.textContent || '').slice(0, 200) : '',
          cursorOffset: 0, // CodeMirror cursor offset is complex — skip for now
          titleText: '',
          allBlocks: lineTexts.slice(0, 15), source: 'dom',
        };
      }

      if (monacoEditor) {
        // Monaco
        const lines = document.querySelectorAll('.monaco-editor .view-line');
        const activeLine = document.querySelector('.monaco-editor .current-line');
        const lineTexts = [];
        lines.forEach((l, i) => {
          lineTexts.push({ index: i + 1, type: 'code_line', text: (l.textContent || '').slice(0, 80) });
        });
        const activeIdx = activeLine ? [...lines].indexOf(activeLine) : -1;
        return {
          region: 'code', blockIndex: activeIdx + 1, totalBlocks: lines.length,
          blockType: 'code_line',
          blockText: activeLine ? (activeLine.textContent || '').slice(0, 200) : '',
          cursorOffset: 0,
          titleText: '',
          allBlocks: lineTexts.slice(0, 15), source: 'dom',
        };
      }

      return null;
    })()`,
    });

    let raw = '';
    if (res?.stdout) {
      const _m = res.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      raw = _m ? _m[1].trim() : res.stdout.trim();
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
    } else {
      raw = String(res?.result || '').replace(/^"|"$/g, '');
    }
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { parsed = null; }
    return parsed || null;
  } catch (e) {
    logger.warn(`[browser.agent] _readEditorStateCode failed: ${e.message}`);
    return null;
  }
}

// Strategy 3: DOM for spreadsheets (Google Sheets, Airtable)
async function _readEditorStateSheet(sessionId) {
  try {
    const res = await callBrowserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      const active = document.activeElement;
      if (!active) return null;

      // Google Sheets: active cell has aria-label like "Cell A1 selected"
      const ariaLabel = active.getAttribute('aria-label') || '';
      const cellMatch = ariaLabel.match(/cell\\s+([A-Z]+)(\\d+)\\s+selected/i);

      // Formula bar
      const formulaBar = document.querySelector('input[aria-label*="formula" i], input[aria-label*="fx" i], textarea[aria-label*="formula" i]');
      const formulaValue = formulaBar ? (formulaBar.value || '') : '';

      // Cell content from active element
      const cellText = (active.innerText || active.value || '').trim().slice(0, 200);

      if (cellMatch) {
        const col = cellMatch[1];
        const row = parseInt(cellMatch[2], 10);
        return {
          region: 'cell', blockIndex: 1, totalBlocks: 1,
          blockType: 'cell',
          blockText: cellText,
          cursorOffset: 0,
          titleText: '',
          allBlocks: [{ index: 1, type: 'cell', text: \`Cell \${col}\${row}: "\${cellText}"\` }],
          source: 'dom',
          cellAddress: \`\${col}\${row}\`,
          formulaBar: formulaValue,
        };
      }

      // Fallback: check for role=gridcell
      const gridCell = active.closest('[role="gridcell"]');
      if (gridCell) {
        const cellText2 = (gridCell.innerText || '').trim().slice(0, 200);
        return {
          region: 'cell', blockIndex: 1, totalBlocks: 1,
          blockType: 'cell',
          blockText: cellText2,
          cursorOffset: 0,
          titleText: '',
          allBlocks: [{ index: 1, type: 'cell', text: cellText2 }],
          source: 'dom',
        };
      }

      return null;
    })()`,
    });

    let raw = '';
    if (res?.stdout) {
      const _m = res.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      raw = _m ? _m[1].trim() : res.stdout.trim();
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
    } else {
      raw = String(res?.result || '').replace(/^"|"$/g, '');
    }
    let parsed;
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (_) { parsed = null; }
    return parsed || null;
  } catch (e) {
    logger.warn(`[browser.agent] _readEditorStateSheet failed: ${e.message}`);
    return null;
  }
}

// Strategy 4: OCR-Hybrid for canvas editors (Google Docs, Excalidraw, etc.)
// Uses OCR to get text lines, DOM to get active element position for active-line detection.
async function _readEditorStateOCR(sessionId) {
  try {
    const { structureOcrOverlayItems } = require('./ocrOverlayStructure.cjs');
    let engine;
    try { engine = require('./browser-engine.cjs'); } catch (_) { return null; }
    const page = engine.getPage(sessionId);
    if (!page) return null;

    // 1. OCR capture
    const cap = await _liteparseCapture(page);
    if (!cap?.ok || !cap.textItems || cap.textItems.length === 0) return null;

    // 2. Cluster into rows
    let rows = structureOcrOverlayItems(cap.textItems);
    if (rows.length === 0) return null;

    // 3. Filter to content rows (drop buttons, dividers, menu items)
    //    Content rows are typically in the center-left of the page, not in toolbars
    const contentRows = rows.filter(r => {
      if (r.type === 'button' || r.type === 'divider') return false;
      // Drop rows in toolbar area (y < 80px typically)
      if ((r.y || 0) < 80) return false;
      // Drop rows in sidebar (x < 200 and narrow width)
      if ((r.x || 0) < 200 && (r.width || 0) < 300) return false;
      return true;
    });
    if (contentRows.length === 0) return null;

    // 4. Detect title: first row with large height (title font is bigger)
    const avgHeight = contentRows.reduce((s, r) => s + (r.height || 0), 0) / contentRows.length;
    const titleRow = contentRows.find(r => (r.height || 0) > avgHeight * 1.3 && (r.y || 0) < 200);
    const titleText = titleRow ? (titleRow.text || '').slice(0, 100) : '';

    // 5. Body blocks = content rows after title
    const bodyRows = titleRow
      ? contentRows.filter(r => (r.y || 0) > (titleRow.y || 0) + (titleRow.height || 0))
      : contentRows;
    const allBlocks = bodyRows.map((r, i) => ({
      index: i + 1,
      type: (r.height || 0) > avgHeight * 1.1 ? 'heading' : 'paragraph',
      text: (r.text || '').slice(0, 80),
    }));

    // 6. Detect active line (hybrid: DOM active element y → match to nearest OCR row)
    let activeIndex = -1;
    try {
      const activeRes = await callBrowserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), h: Math.round(r.height) };
        })()`,
      });
      let activeRaw = '';
      if (activeRes?.stdout) {
        const _m = activeRes.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
        activeRaw = _m ? _m[1].trim() : activeRes.stdout.trim();
        if (activeRaw.startsWith('"') && activeRaw.endsWith('"')) activeRaw = activeRaw.slice(1, -1).replace(/\\"/g, '"');
      } else {
        activeRaw = String(activeRes?.result || '').replace(/^"|"$/g, '');
      }
      let activePos;
      try { activePos = typeof activeRaw === 'string' ? JSON.parse(activeRaw) : activeRaw; }
      catch (_) { activePos = null; }

      if (activePos && activePos.y != null) {
        // Find nearest body row by y-coordinate
        let minDist = Infinity;
        bodyRows.forEach((r, i) => {
          const dist = Math.abs((r.y || 0) - activePos.y);
          if (dist < minDist) { minDist = dist; activeIndex = i; }
        });
      }
    } catch (_) {}

    // 7. Build result
    const activeBlock = activeIndex >= 0 ? allBlocks[activeIndex] : null;
    const cursorOffset = activeBlock ? (activeBlock.text || '').length : 0;

    return {
      region: activeIndex >= 0 ? 'body' : (titleRow ? 'title' : 'body'),
      blockIndex: activeIndex >= 0 ? activeIndex + 1 : 0,
      totalBlocks: allBlocks.length,
      blockType: activeBlock?.type || 'paragraph',
      blockText: activeBlock?.text || '',
      cursorOffset,
      titleText,
      allBlocks: allBlocks.slice(0, 15),
      source: 'ocr',
    };
  } catch (e) {
    logger.warn(`[browser.agent] _readEditorStateOCR failed: ${e.message}`);
    return null;
  }
}

// Main dispatcher: picks the right strategy based on pageCategory
async function _readEditorState(sessionId, pageCategory) {
  // Strategy 1: DOM for contenteditable editors
  if (['document_editor', 'email_compose'].includes(pageCategory)) {
    const dom = await _readEditorStateDOM(sessionId);
    // Only accept DOM result if it's useful (has blocks, title, content, or is in title/subject region).
    // For canvas editors like Google Docs, DOM returns empty blocks and no text — fall through to OCR.
    if (dom && (dom.totalBlocks > 0 || dom.titleText || dom.blockText || dom.region === 'title' || dom.region === 'subject')) {
      logger.info(`[browser.agent] _readEditorState: region=${dom.region}, block=${dom.blockIndex}/${dom.totalBlocks}, type=${dom.blockType}, text="${(dom.blockText || '').slice(0, 40)}" (source=${dom.source})`);
      return dom;
    }
  }

  // Strategy 2: DOM for code editors
  if (pageCategory === 'code_editor') {
    const code = await _readEditorStateCode(sessionId);
    if (code) {
      logger.info(`[browser.agent] _readEditorState: region=${code.region}, line=${code.blockIndex}/${code.totalBlocks} (source=${code.source})`);
      return code;
    }
  }

  // Strategy 3: DOM for spreadsheets
  if (pageCategory === 'spreadsheet') {
    const sheet = await _readEditorStateSheet(sessionId);
    if (sheet) {
      logger.info(`[browser.agent] _readEditorState: region=${sheet.region}, cell="${sheet.blockText.slice(0, 40)}" (source=${sheet.source})`);
      return sheet;
    }
  }

  // Strategy 4: OCR fallback (canvas editors only — Google Docs, Excalidraw, etc.)
  // Only run for canvas-prone categories to avoid 1-2s OCR latency on regular web pages.
  const _ocrEligibleCategories = ['document_editor', 'code_editor', 'design_canvas', 'spreadsheet'];
  if (_ocrEligibleCategories.includes(pageCategory)) {
    const ocr = await _readEditorStateOCR(sessionId);
    if (ocr) {
      logger.info(`[browser.agent] _readEditorState: region=${ocr.region}, block=${ocr.blockIndex}/${ocr.totalBlocks} (source=${ocr.source})`);
      return ocr;
    }
  }

  logger.info(`[browser.agent] _readEditorState: no state available (category=${pageCategory})`);
  return null;
}

// Format editor state into a compact LLM-readable block
function _formatEditorStateForLLM(editorState) {
  if (!editorState) return '';

  const lines = [];
  lines.push('Current position:');
  lines.push(`  Region: ${editorState.region}`);
  const _blockStr = editorState.blockIndex > 0
    ? `${editorState.blockIndex} of ${editorState.totalBlocks} blocks`
    : `unknown (of ${editorState.totalBlocks} blocks)`;
  lines.push(`  Block: ${_blockStr}`);
  lines.push(`  Block type: ${editorState.blockType}`);
  lines.push(`  Current text: "${(editorState.blockText || '').slice(0, 60)}" ${editorState.blockText ? '(filled)' : '(empty)'}`);
  lines.push(`  Cursor: position ${editorState.cursorOffset}`);

  if (editorState.titleText) {
    lines.push('');
    lines.push(`Document title: "${editorState.titleText}" (filled)`);
  }

  if (editorState.allBlocks && editorState.allBlocks.length > 0) {
    lines.push('');
    lines.push(editorState.region === 'body' ? 'Body blocks:' : 'All blocks:');
    editorState.allBlocks.forEach(b => {
      const marker = b.index === editorState.blockIndex ? ' ← YOU ARE HERE' : '';
      const textStr = b.text ? `"${b.text.slice(0, 50)}"` : '""';
      lines.push(`    #${b.index} [${b.type}] ${textStr}${marker}`);
    });
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared focused-element descriptor builder.
// Used by all LLM callers (_extractValue, _extractFieldType, _extractCommandPlan,
// _extractSearchPlan, _decisionCall) so every LLM sees the same rich field info:
//   tag[contenteditable][aria-roledescription] label="..." placeholder="..."
// Exported for use by instruction.runner.cjs (_selectTierLLM).
// ---------------------------------------------------------------------------
function _buildFocusedStr(focusedElement) {
  if (!focusedElement) return 'unknown';
  const ce = focusedElement.isContentEditable ? '[contenteditable]' : '';
  const ard = focusedElement.ariaRoleDescription ? `[${focusedElement.ariaRoleDescription}]` : '';
  const label = (focusedElement.text || focusedElement.ariaLabel || '').slice(0, 60);
  const ph = (focusedElement.placeholder || focusedElement.dataPlaceholder || '').slice(0, 60);
  return `${focusedElement.tag}${ce}${ard} label="${label}" placeholder="${ph}"`;
}

// Value extraction: what to type into the focused field.
// Returns the value, "PRESS_ENTER", or "SKIP".
async function _extractValue(goal, focusedElement, actionHistory, agentContext, currentValue = '', pageContext = {}) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');


  const _contextBlock = agentContext
    ? `\n\nAgent context (service descriptor / playbook — use these labels if relevant):\n${String(agentContext).slice(0, 1000)}`
    : '';

  const _focusedStr = _buildFocusedStr(focusedElement);

  const _layoutBlock = pageContext.layoutText
    ? `\nPage layout (regions, top to bottom):\n${pageContext.layoutText}\n\nThe ← FOCUSED marker shows which region is currently focused.\n- If the focused region's value is already correct AND other regions need content, return PRESS_ENTER or PRESS_TAB to move to the next region.\n- If the focused region is wrong for the current goal, return PRESS_TAB to move to the next region.\n- If a dropdown/menu is open and you need to select an item, return PRESS_ARROW_DOWN then PRESS_ENTER.\n- If a block needs to be exited, return PRESS_ESCAPE.\n`
    : '';

  const _editorStateBlock = pageContext.editorStateText
    ? `\n${pageContext.editorStateText}\n`
    : '';

  const systemPrompt = `You extract the value to type into a focused field on a web page.
Look at the goal, the editor state, and what's been done. Return ONLY the NEXT value to type — nothing else.
- Return ONLY the NEXT value to type. The system will call you again for the next value. Do NOT return multiple items at once.
- Extract values ONLY from the goal text. Do NOT invent or hallucinate values that are not in the goal.
- EXCEPTION: If the goal asks for N items/blocks but doesn't specify what they are (e.g. "add a todo list with three items"), generate generic placeholder items (Item 1, Item 2, ... Item N). The user can edit them later.
- If the field is empty and the goal specifies a value (email address, name, search query, message body), type that value — do NOT return PRESS_ENTER for an empty field.
- If the field already contains the exact value needed, return PRESS_ENTER (if Enter confirms/submits) or SKIP (if no action needed)
- If the focused field already contains the correct value AND the goal has more to do on this page (e.g. title is filled, goal also asks for body content), return PRESS_ENTER to move focus to the next field
- If the focused field is the wrong field for this goal (e.g. focus is in title, goal is about body content), return PRESS_ENTER to try moving to the next field
- Do NOT return the same value that's already in the field — either return PRESS_ENTER, SKIP, or a different value
- If this isn't the right field to type into AND PRESS_ENTER would submit instead of moving focus → return SKIP
- Otherwise return the exact value to type (no quotes, no explanation)
- Extract values from the goal text (quoted strings, names, search queries, message bodies)
- ONE VALUE AT A TIME RULE: For block-based editors (Notion, Google Docs, Confluence), return ONLY the next single value to type — NOT all items at once.
  Use the editor state to determine what's next:
  - If in title and title is empty → type the title text from the goal
  - If in title and title is filled → return PRESS_ENTER to move to body
  - If in body and current block is empty → type the next item from the goal (or the block command like /todo first)
  - If in body and current block is filled → return PRESS_ENTER to create the next block
  Use the action history to know what's already been done.
  Example: goal "add a todo list with: Read, Study, Pray"
  - Call 1 (in empty body): return "/todo"
  - Call 2 (in empty todo block): return "Read"
  - Call 3 (in filled todo block "Read"): return PRESS_ENTER
  - Call 4 (in empty todo block): return "Study"
  - Call 5 (in filled todo block "Study"): return PRESS_ENTER
  - Call 6 (in empty todo block): return "Pray"
- For block-based editors with a command system (see Agent context for prefix and commands):
  if the goal requires creating blocks (todo, heading, bullet), return the command for the FIRST block only (e.g. "/todo").
  The system will type the command, select from dropdown, then type each item in subsequent calls.
- Do NOT use markdown shortcuts ([] , ##, -) when the app has a command system. Commands are preferred because they create blocks properly and handle continuation.
- Only use markdown shortcuts ([] , ##, -) for apps WITHOUT a command system (plain markdown editors, GitHub, HackMD).
- Check the Agent context for the app's specific command prefix and available commands.
- If the command list is incomplete, infer the command from the goal (e.g. "todo" → "/todo", "heading" → "/h1").
- KEY ACTIONS: You can return special key commands to navigate between regions:
  PRESS_ENTER — confirm/create block, run command, submit
  PRESS_TAB — move to next region, indent in code, next cell in spreadsheets
  PRESS_ESCAPE — exit dropdown/menu/overlay, exit block
  PRESS_SPACE — toggle checkbox, expand/collapse
  PRESS_ARROW_DOWN / PRESS_ARROW_UP / PRESS_ARROW_LEFT / PRESS_ARROW_RIGHT — navigate
  PRESS_BACKSPACE — delete character/block
  Key combinations: PRESS_SHIFT+ENTER (soft line break), PRESS_SHIFT+TAB (outdent), PRESS_META+Z (undo), PRESS_META+A (select all)
- Use the Page layout (if provided) to decide which region needs content and which key to press to navigate.
- Use the Editor state (if provided) to see exactly which block you're in, what's already typed, and what's next.
- TITLE FIELD GUARD: If the focused field is a title field (aria-roledescription includes "title", or placeholder includes "New page" or "Untitled", or it's an h1), return the LITERAL title text from the goal — never a command (no leading /). Commands (like /todo) are for body blocks only. If the title is already filled correctly, return PRESS_ENTER to move to the body.
- FIELD-ORDER RULE (canvas editors): If the focused region is the title (see ← FOCUSED marker in Page layout) and it already contains the correct title, return PRESS_ENTER to move focus to the body. Do NOT return body commands while the title is focused — the title is for the page name only. Body commands (like /todo) must be typed into the body region, not the title.`;

  const historyStr = actionHistory.slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const _ocrBlock = pageContext.ocrContext
    ? `\nOCR visual text (may include content not in DOM): ${pageContext.ocrContext}\n`
    : '';

  const userPrompt = `Goal: ${goal}
Page title: ${pageContext.title || 'unknown'}
Visible text: ${(pageContext.visibleText || '').slice(0, 150)}${_editorStateBlock}${_layoutBlock}${_ocrBlock}
Focused field: ${_focusedStr}
Current field value: "${(currentValue || '').slice(0, 80)}"
Actions taken:
${historyStr}${_contextBlock}

Value to type?`;

  // ── Deterministic title pre-check (skip LLM for obvious cases) ──
  // If the focused field is a title with existing content AND the goal doesn't
  // explicitly mention changing the title, return PRESS_ENTER to move to the body.
  // This prevents the LLM from returning body content (e.g. "Favorite Pizza") for
  // the title field — a common failure that overwrites the title.
  const _ard = (focusedElement?.ariaRoleDescription || '').toLowerCase();
  const _tag = focusedElement?.tag || '';
  const _ph = (focusedElement?.placeholder || '').toLowerCase();
  const _isTitle = _ard.includes('title') ||
                   (_tag === 'h1' && focusedElement?.isContentEditable) ||
                   _ph.includes('untitled') || _ph.includes('new page');

  // Title "content" should not include placeholder text like "New page" or "Untitled".
  // If the value equals the placeholder, the field is effectively empty.
  const _cv = (currentValue || '').trim();
  const _phText = (focusedElement?.placeholder || '').trim();
  const _titleHasContent = _cv.length > 0 &&
                           !(_phText && _cv.toLowerCase() === _phText.toLowerCase());

  // Goal wants title change if it mentions title/name/renaming OR says the page is
  // "called", "named", "entitled", or "titled" something.
  const _goalWantsTitleChange = /\b(title|name of the page|page name|rename|call the page|name this page|called|named|entitled|titled)\b/i.test(goal || '');

  // Fire whenever the focused field is a title and the goal is NOT about the title,
  // AND the title already has content. If the title is empty/placeholder, fall through
  // to the LLM call so it can decide whether to type a title from context.
  // This protects a filled title from body commands, but allows typing into an empty title.
  if (_isTitle && !_goalWantsTitleChange && _titleHasContent) {
    logger.info(`[browser.agent] _extractValue: title field focused + has content + goal not about title → PRESS_ENTER`);
    return 'PRESS_ENTER';
  }

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 300, temperature: 0.1, responseTimeoutMs: 10000 });
    const val = (raw || '').trim().replace(/^```(?:text|plaintext)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    logger.info(`[browser.agent] _extractValue: "${val.slice(0, 60)}" for field "${_focusedStr}"`);
    return val;
  } catch (e) {
    logger.warn(`[browser.agent] _extractValue failed: ${e.message}`);
    return 'SKIP';
  }
}

// After-action decision: what key to press AFTER typing the value.
// Returns a number: 0=nothing, 1=Enter, 2=Tab, 3=Escape, 4=Shift+Enter, 5=ArrowDown
// Separate from _extractValue so _extractValue stays a plain-string return
// (reliable with light models). This is a tiny single-number call.
// Deterministic pre-checks skip the LLM for obvious cases.
async function _extractAfterAction(goal, focusedElement, value, actionHistory, pageContext = {}, agentContext = {}) {
  // ── Deterministic pre-checks (skip LLM for obvious cases) ──

  // No value or special key → no after-action
  if (!value || value === 'SKIP' || String(value).startsWith('PRESS_')) return 0;

  // AI chat page → always Enter after typing (form submit)
  if (pageContext.pageCategory === 'ai_chat') return 1;

  // Title region → Enter to move to body (structural navigation).
  // Detect title by regionType OR by aria-roledescription/h1 tag. The tag/role
  // fallback runs even when regionType is set (e.g. OCR misreported 'body' while
  // the title h1 was actually focused), so Enter is reliably pressed after the
  // title and focus moves to the body.
  const _ariaRoleDesc = focusedElement?.ariaRoleDescription || '';
  const _tag = focusedElement?.tag || '';
  if (focusedElement?.regionType === 'title' ||
      _ariaRoleDesc.includes('title') ||
      (_tag === 'h1' && focusedElement?.isContentEditable)) {
    return 1;
  }

  // Multi-line content (has newlines) → no after-action (content has its own structure)
  if (String(value).includes('\n')) return 0;

  // Value starts with / (block command) → ArrowDown to select first dropdown item
  if (String(value).startsWith('/')) return 5;

  // Value starts with @ (mention/search command) → ArrowDown to select first match
  if (String(value).startsWith('@')) return 5;

  // ── LLM call for ambiguous cases ──
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const _focusedStr = _buildFocusedStr(focusedElement);

  const systemPrompt = `You decide what key to press AFTER typing a value into a field.
Return ONLY a single number — nothing else:
0 = nothing (just type the value, no key after)
1 = press Enter after typing
2 = press Tab after typing
3 = press Escape after typing
4 = press Shift+Enter after typing (soft line break within a block)
5 = press Arrow Down after typing (select first item in dropdown)

Rules:
- 1 (Enter): search submit, single-field form submit, chat message send, title→body navigation
- 0 (nothing): form fields with more fields to fill, multi-line content, just filling a value
- 2 (Tab): moving to next form field where Tab is the navigation key
- 3 (Escape): exit dropdown/menu/overlay after typing a filter
- 4 (Shift+Enter): soft line break within a block (not a new block)
- 5 (Arrow Down): select first dropdown item after typing a filter (@mentions, slash commands)
- When in doubt, return 0 — the next iteration will re-evaluate
Return ONLY the number.`;

  const historyStr = (actionHistory || []).slice(-3).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const _editorStateBlock = pageContext.editorStateText
    ? `\n${pageContext.editorStateText}\n`
    : '';

  const userPrompt = `Goal: ${goal}
Page title: ${pageContext.title || 'unknown'}${_editorStateBlock}
Focused field: ${_focusedStr}
Value to type: "${String(value || '').slice(0, 80)}"
Current field value: "${(focusedElement?.currentValue || '').slice(0, 80)}"
Actions taken:
${historyStr}

Number (0-5)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim(), 10);
    if (num >= 0 && num <= 5) {
      logger.info(`[browser.agent] _extractAfterAction: ${num} for value="${String(value || '').slice(0, 40)}" field="${_focusedStr}"`);
      return num;
    }
    logger.info(`[browser.agent] _extractAfterAction: invalid "${raw}" → defaulting to 0`);
    return 0;
  } catch (e) {
    logger.warn(`[browser.agent] _extractAfterAction failed: ${e.message}`);
    return 0;
  }
}

// Gesture type detection: returns a number indicating what kind of gesture is needed.
// 0 = no gesture, 1 = drag-drop, 2 = slider horizontal, 3 = slider vertical
// Deterministic pre-checks skip the LLM for obvious non-gesture goals.
async function _extractGestureType(goal, focusedElement, actionHistory, pageContext = {}) {
  // ── Deterministic pre-checks ──
  const _hasGestureKeyword = /\b(drag|slide|slider|rearrange|reorder|move.*to|pull|push|adjust)\b/i.test(goal || '');
  if (!_hasGestureKeyword) return 0;

  // ── LLM call for ambiguous cases ──
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const _focusedStr = _buildFocusedStr(focusedElement);

  const systemPrompt = `You decide what kind of gesture (if any) is needed for this task.
Return ONLY a single number — nothing else:
0 = no gesture needed (regular typing/clicking)
1 = drag-drop (drag an element to another element)
2 = slider horizontal (drag a handle left or right)
3 = slider vertical (drag a handle up or down)

Rules:
- 1 (drag-drop): "drag X to Y", "move X into Y", "rearrange", "reorder"
- 2 (slider horizontal): "set slider to", "adjust to N%", horizontal sliders
- 3 (slider vertical): vertical sliders, volume controls that go up/down
- 0 (no gesture): typing, clicking buttons, filling forms, navigating
- When in doubt, return 0
Return ONLY the number.`;

  const historyStr = (actionHistory || []).slice(-3).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Page title: ${pageContext.title || 'unknown'}
Focused element: ${_focusedStr}
Actions taken:
${historyStr}

Number (0-3)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num >= 0 && num <= 3) {
      logger.info(`[browser.agent] _extractGestureType: ${num} for goal="${String(goal || '').slice(0, 60)}"`);
      return num;
    }
    logger.info(`[browser.agent] _extractGestureType: invalid "${raw}" → defaulting to 0`);
    return 0;
  } catch (e) {
    logger.warn(`[browser.agent] _extractGestureType failed: ${e.message}`);
    return 0;
  }
}

// Gesture target selection: picks source and target (or offset) from a Tab-Map.
// Returns { sourceEntry, targetEntry, offset } or null.
// - drag-drop (type=1): sourceEntry + targetEntry from Tab-Map (2 numbers)
// - slider (type=2/3): sourceEntry from Tab-Map + offset (pixels, from goal % or default)
async function _extractGestureTargets(gestureType, goal, tabMap, actionHistory = []) {
  if (!tabMap || tabMap.length === 0) return null;
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  // Build simplified list (same format as _llmPickFromTabMap in instruction.runner)
  const listStr = tabMap.map(e =>
    `${e.id} - ${e.tag || 'element'}${e.text ? ` "${String(e.text).substring(0, 50)}"` : ''}${e.ariaLabel ? ` [${String(e.ariaLabel).substring(0, 40)}]` : ''}${e.placeholder ? ` placeholder="${String(e.placeholder).substring(0, 40)}"` : ''}`
  ).join('\n');

  if (gestureType === 1) {
    // Drag-drop: pick source + target (2 numbers, space-separated)
    const prompt = `Task: ${goal}

Available elements:
${listStr}

Which element to DRAG, and which element to DROP IT ON?
Output TWO numbers separated by a space: source target
Example: 5 12
If either element is not in the list, use 0 for it.
Output ONLY the two numbers.`;

    try {
      const raw = await askWithMessages([
        { role: 'system', content: 'You pick two elements from a list. Output ONLY two numbers separated by a space: source target. Use 0 if not found.' },
        { role: 'user', content: prompt },
      ], { maxTokens: 10, temperature: 0, responseTimeoutMs: 8000 });
      const nums = (raw || '').trim().split(/\s+/).map(n => parseInt(n.replace(/\D/g, ''), 10) || 0);
      const srcId = nums[0] || 0;
      const tgtId = nums[1] || 0;
      const sourceEntry = srcId > 0 ? tabMap.find(e => e.id === srcId) : null;
      const targetEntry = tgtId > 0 ? tabMap.find(e => e.id === tgtId) : null;
      logger.info(`[browser.agent] _extractGestureTargets (drag-drop): src=#${srcId}, tgt=#${tgtId}`);
      return { sourceEntry, targetEntry, offset: 0 };
    } catch (e) {
      logger.warn(`[browser.agent] _extractGestureTargets (drag-drop) failed: ${e.message}`);
      return null;
    }
  }

  if (gestureType === 2 || gestureType === 3) {
    // Slider: pick handle (1 number) + compute offset from percentage in goal
    const pctMatch = (goal || '').match(/(\d+(?:\.\d+)?)\s*%/);

    const prompt = `Task: ${goal}

Available elements:
${listStr}

Which element is the slider handle to drag?
Output ONLY the element number, or 0 if not found.`;

    try {
      const raw = await askWithMessages([
        { role: 'system', content: 'You pick the slider handle from a list. Output ONLY the number, or 0 if not found.' },
        { role: 'user', content: prompt },
      ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
      const srcId = parseInt((raw || '').trim().replace(/\D/g, ''), 10) || 0;
      const sourceEntry = srcId > 0 ? tabMap.find(e => e.id === srcId) : null;

      // Compute offset from percentage if found, else default 100px
      let finalOffset = 100;
      if (pctMatch && sourceEntry) {
        const pct = parseFloat(pctMatch[1]);
        const sliderWidth = sourceEntry.w || 200;
        // Offset from center to target percentage position
        finalOffset = Math.round((pct / 100) * sliderWidth - sliderWidth / 2);
      }

      logger.info(`[browser.agent] _extractGestureTargets (slider): handle=#${srcId}, offset=${finalOffset}px${pctMatch ? ` (from ${pctMatch[1]}%)` : ' (default)'}`);
      return { sourceEntry, targetEntry: null, offset: finalOffset };
    } catch (e) {
      logger.warn(`[browser.agent] _extractGestureTargets (slider) failed: ${e.message}`);
      return null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// OCR Observation Layer — number-returning visual decisions via LiteParser OCR
// All return a single number (reliable with light models). Used as pre-tier
// gatekeepers and during-tier pickers in the iteration loop.
// ---------------------------------------------------------------------------

// Visual goal verification using OCR text.
// Returns: 0 = failure (goal not achieved), 1 = done (goal achieved), 2 = wait (page processing)
async function _ocrVerifyGoal(ocrText, goal, actionHistory = []) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const systemPrompt = `You verify if a browser automation goal has been achieved by looking at the OCR text captured from the page.
Return ONLY a single number — nothing else:
0 = failure (goal NOT achieved — page is a marketing/landing page, login page, or expected content is missing)
1 = done (goal achieved — expected result is visible, e.g., event title visible, confirmation message shown)
2 = wait (page is loading/processing — retry later)

COUNT QUESTION RULE (OVERRIDES ALL OTHER RULES): If the goal asks "how many", "count", "tell me how many", or "number of":
- Do NOT check whether the search query, filter text, or named items are visible in the OCR — OCR often truncates filter text.
- The ONLY thing that matters is a pagination, summary, or total count label in the OCR text.
- Valid count labels include: "1-50 of many", "1-50 of 127", "Showing 1-50 of many", "X of N", "N items", "N matches", "No results", "Zero items", "About N results".
- "1-50 of many" IS a valid count label — return 1 (done). "many" means the total is large but the count label IS visible.
- If ANY count/pagination/total label is visible, return 1 (done) immediately.
- If "No results" or "Zero items" is visible, return 1 (done) — the count (0) is visible.
- If NO count/pagination/total label is visible, return 0 (fail) — the page may need to scroll or wait.
- Do NOT return 1 (done) just because some rows/items are visible — the total count label must be visible.

Rules:
- 1 (done): the OCR text shows the expected result (e.g., created content is visible, confirmation message, success toast)
- 0 (fail): the OCR text does NOT show the expected result (e.g., marketing page text, login form, "Sign in" button, "Get started", content missing)
- 2 (wait): ONLY return 2 if the OCR text shows EXPLICIT loading indicators ("Loading...", "Please wait", "Searching...", spinner, progress bar, "Saving...")
- Do NOT return 2 just because a dropdown, dialog, menu, or form is open — that is a stable state, not loading.
- If the page is stable (dropdown open, form visible, calendar rendered), return 0 or 1, NOT 2.
- If the page text looks like a marketing/landing page (e.g., "Try Google Calendar", "Sign up for free", product features), return 0
- Check the action history for context on what was attempted
- When in doubt, return 0 (the tier system will try to fix it)

NAMED ITEM RULE: If the goal specifies a name, title, or list of items (e.g., "called X", "titled X", "named X", "with three items: A, B, C"), the EXACT name/items MUST appear in the OCR text for the goal to be achieved (1). A blank/empty/placeholder title (e.g., "Untitled", "New page") is NOT achieved. If the named items are not in the OCR text, return 0 (fail). NOTE: This rule does NOT apply to count questions — count questions are governed by the COUNT QUESTION RULE above.

Return ONLY the number.`;

  const userPrompt = `Goal: ${goal}
OCR text from page:
${(ocrText || '').slice(0, 500)}
Actions taken:
${historyStr}

Number (0-2)?`;

  try {
    // ── Deterministic count/pagination pre-check ────────────────────────
    // For count questions, check if a pagination/count label is already
    // visible in the OCR text. If so, declare done immediately — skip the
    // LLM which has proven unreliable for count verification (it ignores
    // "1-50 of many" and fixates on missing filter text due to OCR truncation).
    const _isCountGoal = /\b(how many|count|tell me how many|number of)\b/i.test(goal);
    if (_isCountGoal) {
      // Conservative patterns — only match unambiguous pagination/count labels.
      // Does NOT match generic "N emails" / "N messages" (those appear in
      // sidebars/promos and would cause false positives).
      const _countRe = new RegExp(
        // 1. Range pagination: "1-50 of many", "1-50 of 127", "1–50 of 1,234"
        //    Handles all common dash chars: - – — ‐ and Unicode dash variants
        '\\b\\d+\\s*[-\\u2010-\\u2015]\\s*\\d+\\s+of\\s+(?:many|[\\d,]+)\\b'
        // 2. "Showing X-Y of N" (explicit prefix for logging clarity)
        + '|\\bshowing\\s+\\d+\\s*[-\\u2010-\\u2015]\\s*\\d+\\s+of\\s+(?:many|[\\d,]+)\\b'
        // 3. Single-number total: "Page 1 of 5", "1 of 50"
        + '|\\b\\d+\\s+of\\s+[\\d,]+\\b'
        // 4. Zero results — unambiguous
        + '|\\b(no\\s+results?|zero\\s+(?:items?|matches?|messages?|emails?)|0\\s+results?)\\b'
        // 5. "About N results" (Google Search style)
        + '|\\babout\\s+[\\d,]+\\s+results?\\b',
        'gi'
      );
      if (_countRe.test(ocrText || '')) {
        logger.info(`[browser.agent] _ocrVerifyGoal: count/pagination label found in OCR — skipping LLM (count question) for goal="${String(goal || '').slice(0, 60)}"`);
        return { num: 1, reason: 'count-label-detected' };
      }
    }

    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num >= 0 && num <= 2) {
      // For failures (0), ask LLM for a descriptive reason
      let _reason = num === 1 ? 'goal-achieved' : (num === 2 ? 'loading' : 'ocr-failed');
      if (num === 0) {
        try {
          const reasonRaw = await askWithMessages([
            { role: 'system', content: 'In one sentence, explain why the browser automation goal was NOT achieved based on the OCR text. Be specific about what is missing or wrong. Return ONLY the explanation.' },
            { role: 'user', content: `Goal: ${goal}\nOCR text: ${(ocrText || '').slice(0, 400)}\nActions: ${(actionHistory || []).slice(-5).join('; ')}` }
          ], { maxTokens: 60, temperature: 0, responseTimeoutMs: 5000 });
          _reason = (reasonRaw || '').trim().slice(0, 120) || 'goal-not-visible-in-ocr';
        } catch (_) { _reason = 'goal-not-visible-in-ocr'; }
      }
      logger.info(`[browser.agent] _ocrVerifyGoal: ${num} reason="${_reason}" for goal="${String(goal || '').slice(0, 60)}"`);
      return { num, reason: _reason };
    }
    logger.info(`[browser.agent] _ocrVerifyGoal: invalid "${raw}" → defaulting to 0`);
    return { num: 0, reason: 'invalid-llm-response' };
  } catch (e) {
    logger.warn(`[browser.agent] _ocrVerifyGoal failed: ${e.message}`);
    return { num: 0, reason: 'llm-error' };
  }
}

// ── OCR goal verification wrapper ──────────────────────────────────
// Called at the end of browser.agent run before returning ok:true.
// Captures OCR text from the page and verifies the goal was achieved.
// Returns: { verified: bool, reason: string, ocrText?: string }
// DOM-state + network verification for modal/overlay goals.
// Checks: (1) submit button was clicked, (2) POST/PUT CRUD call with 2xx in netLog,
// (3) dialog/overlay closed, (4) no error toast after close.
// Returns { verified: true/false, reason: string }
async function _verifyGoalViaDomState(goal, sessionId, actionHistory, tabMapResult) {
  // 1. Check if the last action was a click on a submit/save/send button
  const _lastActions = actionHistory.slice(-3);
  const _hasSubmitClick = _lastActions.some(a => /Click "(Save|Send|Submit|Create|Done|Confirm|OK|Post|Publish)"/i.test(a));
  if (!_hasSubmitClick) return { verified: false, reason: 'no-submit-click' };

  // 2. Check netLog for POST/PUT with 2xx status (API call triggered by the click)
  let _netOk = false;
  let _netInfo = null;
  try {
    const _entries = browserEngine?.getNetLog(sessionId) || [];
    const _crudEntries = _entries.filter(e => /^(POST|PUT|PATCH|DELETE)$/.test(e.method));
    if (_crudEntries.length > 0) {
      const _successEntries = _crudEntries.filter(e => e.status >= 200 && e.status < 300);
      if (_successEntries.length > 0) {
        _netOk = true;
        _netInfo = `${_successEntries[0].method} ${_successEntries[0].status} ${_successEntries[0].url.slice(0, 80)}`;
      } else {
        // CRUD call happened but failed (4xx/5xx) — include response body for context
        const _failed = _crudEntries[0];
        let _errDetail = '';
        if (_failed.responseBody) {
          try {
            const _parsed = JSON.parse(_failed.responseBody);
            _errDetail = _parsed?.error?.message || _parsed?.error || _parsed?.message || _failed.responseBody.slice(0, 200);
          } catch (_) {
            _errDetail = _failed.responseBody.slice(0, 200);
          }
        }
        return { verified: false, reason: `API ${_failed.method} ${_failed.status}: ${_errDetail || 'no error body'}` };
      }
    }
  } catch (_) {}

  // 3. Check if dialog/overlay is now closed + no error toast
  let _state = null;
  try {
    const _overlayCheck = await callBrowserAct({
      action: 'evaluate', sessionId, timeoutMs: 3000,
      text: `(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
        const alert = document.querySelector('[role="alert"], .toast-error, .error-message');
        const alertText = alert ? (alert.textContent || '').toLowerCase() : '';
        const hasError = /error|failed|could not|unable|invalid/.test(alertText);
        return { dialogOpen: !!dialog, hasErrorAlert: hasError, alertText: alertText.slice(0, 100) };
      })()`
    }, 5000);
    if (_overlayCheck?.ok) _state = _overlayCheck.result;
  } catch (_) {}

  if (!_state) return { verified: false, reason: 'overlay-check-failed' };

  // 4. Dialog closed + no error → success
  if (!_state.dialogOpen) {
    if (_state.hasErrorAlert) {
      return { verified: false, reason: `error-after-save: "${_state.alertText}"` };
    }
    const _netNote = _netOk ? ` + API ${_netInfo}` : ' (no API call captured)';
    logger.info(`[browser.agent] _verifyGoalViaDomState: verified — dialog closed, no error${_netNote}`);
    return { verified: true, reason: `dialog-closed-no-error${_netNote}` };
  }

  return { verified: false, reason: 'dialog-still-open-after-submit' };
}

async function _verifyGoalWithOcr(goal, sessionId, actionHistory) {
  try {
    const _ocrPage = browserEngine && typeof browserEngine.getPage === 'function'
      ? browserEngine.getPage(sessionId) : null;
    if (!_ocrPage) return { verified: true, reason: 'no-page-available' };
    const _cap = await _liteparseCapture(_ocrPage);
    if (!_cap?.ok || !_cap.fullText) return { verified: true, reason: 'ocr-unavailable' };
    const _ocrText = _cap.fullText.slice(0, 800);
    const _ocrResult = await _ocrVerifyGoal(_ocrText, goal, actionHistory);
    const _num = _ocrResult.num;
    const _reason = _ocrResult.reason || 'ocr-failed';
    if (_num === 1) return { verified: true, reason: 'ocr-confirmed', ocrText: _ocrText.slice(0, 200) };
    if (_num === 2) return { verified: false, reason: 'ocr-loading', wait: true, ocrText: _ocrText.slice(0, 200) };
    return { verified: false, reason: _reason, ocrText: _ocrText.slice(0, 200) };
  } catch (e) {
    return { verified: true, reason: 'ocr-error', error: e.message };
  }
}

// Loading detection using OCR text.
// Returns: 0 = not loading (page is ready), 1 = loading (page is still processing)
async function _ocrDetectLoading(ocrText, goal) {
  // ── Deterministic pre-checks ──
  const _loadingKeywords = /\b(loading|please wait|searching|processing|fetching|spinner|refreshing|updating|saving\.\.\.|submitting)\b/i;
  if (_loadingKeywords.test(ocrText || '')) return 1;
  if (!ocrText || ocrText.trim().length < 10) return 0;

  // ── LLM call for ambiguous cases ──
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const systemPrompt = `You detect if a web page is still loading or processing by looking at the OCR text.
Return ONLY a single number — nothing else:
0 = not loading (page content is fully rendered and ready for interaction)
1 = loading (page is still processing — spinner, progress bar, "loading" text, partial content)

Rules:
- 1 (loading): OCR text contains loading indicators, spinners, "please wait", partial/skeleton content
- 0 (not loading): OCR text shows full content, no loading indicators
- When in doubt, return 0 (proceed with interaction)
Return ONLY the number.`;

  const userPrompt = `Goal: ${goal}
OCR text from page:
${(ocrText || '').slice(0, 300)}

Number (0-1)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 3000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num === 0 || num === 1) {
      logger.info(`[browser.agent] _ocrDetectLoading: ${num}`);
      return num;
    }
    return 0;
  } catch (e) {
    logger.warn(`[browser.agent] _ocrDetectLoading failed: ${e.message}`);
    return 0;
  }
}

// Pick an OCR row by number — replaces JSON-based pickOverlayAction for simple selection.
// ocrRows: array of { id, text, type?, x, y, width, height } from structureOcrOverlayItems
// Returns: 0 = no match, 1..N = row id that best matches the goal
async function _ocrPickRow(ocrRows, goal) {
  if (!ocrRows || ocrRows.length === 0) return 0;
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const listStr = ocrRows.map(r => `${r.id} - "${r.text || ''}"${r.type ? ` [${r.type}]` : ''}`).join('\n');

  const systemPrompt = `You pick the matching item from a list of OCR text rows.
Return ONLY a single number — nothing else.
The number is the row ID that best matches the goal.
If no row matches, return 0.
Output ONLY the number.`;

  const userPrompt = `Goal: ${goal}

Available rows:
${listStr}

Which row number matches the goal? (0 if none)`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10) || 0;
    if (num > 0) {
      const row = ocrRows.find(r => r.id === num);
      if (row) {
        logger.info(`[browser.agent] _ocrPickRow: ${num} ("${row.text}") for goal="${String(goal || '').slice(0, 60)}"`);
        return num;
      }
    }
    logger.info(`[browser.agent] _ocrPickRow: ${num} (no match) for goal="${String(goal || '').slice(0, 60)}"`);
    return 0;
  } catch (e) {
    logger.warn(`[browser.agent] _ocrPickRow failed: ${e.message}`);
    return 0;
  }
}

// Page state classification using OCR text.
// Returns: 0=error, 1=done, 2=loading, 3=ready, 4=unexpected
async function _ocrClassifyState(ocrText, goal, actionHistory = []) {
  // ── Deterministic pre-checks ──
  if (!ocrText || ocrText.trim().length < 5) return 3; // empty OCR → assume ready
  const _loadingKeywords = /\b(loading|please wait|searching|processing|fetching|spinner|refreshing)\b/i;
  if (_loadingKeywords.test(ocrText)) return 2;
  const _errorKeywords = /\b(error|failed|something went wrong|try again|invalid|not found|404|500|forbidden)\b/i;
  if (_errorKeywords.test(ocrText)) return 0;

  // ── LLM call for ambiguous cases ──
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const historyStr = (actionHistory || []).slice(-3).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const systemPrompt = `You classify the state of a web page based on OCR text.
Return ONLY a single number — nothing else:
0 = error (validation errors, "something went wrong", error messages visible)
1 = done (the goal appears to be achieved — expected content is visible)
2 = loading (page is still processing — spinner, "please wait", partial content)
3 = ready (page is ready for interaction — form open, content loaded, no errors)
4 = unexpected (modal, redirect, login wall, unexpected dialog that blocks the goal)

COUNT QUESTION RULE (OVERRIDES ALL OTHER RULES): If the goal asks "how many", "count", "tell me how many", or "number of":
- Do NOT check whether the search query, filter text, or named items are visible in the OCR — OCR often truncates filter text.
- The ONLY thing that matters is a pagination, summary, or total count label in the OCR text.
- Valid count labels include: "1-50 of many", "1-50 of 127", "Showing 1-50 of many", "X of N", "N items", "N matches", "No results", "Zero items", "About N results".
- "1-50 of many" IS a valid count label — return 1 (done). "many" means the total is large but the count label IS visible.
- If ANY count/pagination/total label is visible, return 1 (done) immediately.
- If "No results" or "Zero items" is visible, return 1 (done) — the count (0) is visible.
- If NO count/pagination/total label is visible, return 3 (ready) — the page may need to scroll or wait.
- Do NOT return 1 (done) just because some rows/items are visible — the total count label must be visible.

Rules:
- 0 (error): OCR text shows error messages, validation failures
- 1 (done): OCR text shows the expected result of the goal (e.g., created content is visible)
- 2 (loading): OCR text shows loading indicators
- 3 (ready): OCR text shows normal page content, ready for the next action
- 4 (unexpected): OCR text shows something blocking (login wall, unexpected modal, redirect to wrong page)
- When in doubt, return 3 (proceed with tier selection)

NAMED ITEM RULE: If the goal specifies a name, title, or list of items (e.g., "called X", "titled X", "named X", "with three items: A, B, C"), the EXACT name/items MUST appear in the OCR text for the goal to be "done" (1). A blank/empty/placeholder title (e.g., "Untitled", "New page") is NOT done. If the named items are not in the OCR text, return 3 (ready) or 0 (fail), NOT 1 (done). NOTE: This rule does NOT apply to count questions — count questions are governed by the COUNT QUESTION RULE above.

Return ONLY the number.`;

  const userPrompt = `Goal: ${goal}
OCR text from page:
${(ocrText || '').slice(0, 400)}
Actions taken:
${historyStr}

Number (0-4)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num >= 0 && num <= 4) {
      logger.info(`[browser.agent] _ocrClassifyState: ${num} for goal="${String(goal || '').slice(0, 60)}"`);
      return num;
    }
    logger.info(`[browser.agent] _ocrClassifyState: invalid "${raw}" → defaulting to 3`);
    return 3;
  } catch (e) {
    logger.warn(`[browser.agent] _ocrClassifyState failed: ${e.message}`);
    return 3;
  }
}

// Field-type decision: determines WHAT KIND of typing a field needs.
// Called after _extractValue returns a value, before typing it.
// Returns one of: 'type-plain', 'type-edit', 'type-commands', 'type-search'
// Deterministic pre-checks skip the LLM for obvious cases.
async function _extractFieldType(goal, focusedElement, value, actionHistory, pageContext = {}, agentContext) {
  const _val = String(value || '');
  const _tag = focusedElement?.tag || '';
  const _role = focusedElement?.role || '';

  // ── Deterministic pre-checks (skip LLM) ──

  // Value starts with / → type-commands (Notion blocks, Slack commands)
  if (_val.startsWith('/')) {
    logger.info(`[browser.agent] _extractFieldType: → type-commands (value starts with /)`);
    return 'type-commands';
  }
  // Value starts with @ → type-search (@mentions, assignee pickers)
  if (_val.startsWith('@')) {
    logger.info(`[browser.agent] _extractFieldType: → type-search (value starts with @)`);
    return 'type-search';
  }
  // Short single-line <input> → type-plain (search, chat, simple form fields)
  if (_tag === 'input' && _val.length < 200 && !_val.includes('\n')
      && !/^[/@\[#]/.test(_val)) {
    logger.info(`[browser.agent] _extractFieldType: → type-plain (input + short single-line)`);
    return 'type-plain';
  }
  // Contenteditable or textarea with long/multi-line content → type-edit
  // BUT exclude markdown prefixes ([] , ##, -) which are block shortcuts, not long-form content
  if ((_role === 'textbox' || _tag === 'textarea' || _tag === 'div')
      && (_val.length > 200 || _val.includes('\n'))
      && !/^[/@]/.test(_val)
      && !/^(##\s|###\s|####\s|- \s|\[\]\s|\* \s|> \s|1\. \s)/.test(_val)) {
    logger.info(`[browser.agent] _extractFieldType: → type-edit (canvas/textarea + long/multi-line)`);
    return 'type-edit';
  }
  // Markdown shortcuts in block editors → type-plain (no dropdown, direct block creation)
  // These are fallbacks for apps WITHOUT slash commands (GitHub, HackMD, plain markdown editors)
  if (/^(##\s|###\s|####\s|- \s|\[\]\s|\* \s|> \s|1\. \s)/.test(_val)
      && (_role === 'textbox' || _tag === 'textarea' || _tag === 'div')) {
    logger.info(`[browser.agent] _extractFieldType: → type-plain (markdown prefix in block editor — no dropdown)`);
    return 'type-plain';
  }

  // ── LLM fallback for ambiguous cases ──
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _focusedStr = _buildFocusedStr(focusedElement);

  const _contextBlock = agentContext
    ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}`
    : '';

  const systemPrompt = `You decide what KIND of typing a field needs.
Look at the focused field, the value to type, and the goal. Return ONLY one of:
- type-plain: single-line text + Enter (search, chat, simple form fields)
- type-edit: long-form content (documents, code, essays — generate or edit)
- type-commands: typing with / or @ commands that open a dropdown (Notion blocks, Slack commands)
- type-search: typing to filter a dynamic dropdown (@mentions, assignee pickers, page pickers)

Rules:
- <input> with short single-line value → type-plain
- contenteditable/textarea with multi-line or long value → type-edit
- value starts with / and field is a block editor → type-commands
- value starts with @ and field has a combobox/listbox → type-search
- TITLE FIELD GUARD: If the focused field is a title (aria-roledescription includes "title", placeholder includes "New page" or "Untitled", or it's an h1/h2), and the value does NOT start with / or @, return type-plain. Titles are never command fields.
- If unsure → type-plain (safest default)
Return ONLY the type name, nothing else.`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Page title: ${pageContext.title || 'unknown'}
Focused field: ${_focusedStr}
Value to type: "${_val.slice(0, 100)}"${_contextBlock}

Field type?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 20, temperature: 0.1, responseTimeoutMs: 8000 });
    const val = (raw || '').trim().toLowerCase();
    const valid = ['type-plain', 'type-edit', 'type-commands', 'type-search'];
    const match = valid.find(v => val.includes(v));
    const result = match || 'type-plain';
    logger.info(`[browser.agent] _extractFieldType: LLM → ${result} (raw="${val}")`);
    return result;
  } catch (e) {
    logger.warn(`[browser.agent] _extractFieldType LLM failed: ${e.message} — defaulting to type-plain`);
    return 'type-plain';
  }
}

// Command plan extraction: for type-commands (e.g. "/todo Buy milk" → trigger="/todo", commandLabel="To-do list", content="Buy milk")
// Returns { trigger, commandLabel, content } or null on failure.
async function _extractCommandPlan(goal, focusedElement, value, actionHistory, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _focusedStr = _buildFocusedStr(focusedElement);

  const _contextBlock = agentContext
    ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}`
    : '';

  const systemPrompt = `You extract a command plan from a value to type into a block-based editor.
The value contains a command trigger (like /todo, /h1, @mention) and possibly content after it.
Return ONLY JSON: {"trigger": "/todo", "commandLabel": "To-do list", "content": "Buy milk"}
- trigger: the command prefix (e.g. "/todo", "/h1", "/page", "@")
- commandLabel: the human-readable label of the dropdown option to select (e.g. "To-do list", "Heading 1")
- content: the text to type AFTER selecting the command (empty string if none)
If the value is just a trigger with no content, set content to "".
If the value has multiple lines (e.g. "[] Item 1\\n[] Item 2"), set trigger to the first line's prefix,
commandLabel to the matching option, and content to the full multi-line value.
- TITLE FIELD GUARD: If the focused field is a title (h1/h2, aria-roledescription includes "title", placeholder includes "New page" or "Untitled"), return null — titles never use commands.
- VALIDATION: The trigger MUST appear at the start of the value. If the value does not start with the trigger, return null.`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Focused field: ${_focusedStr}
Value to type: "${String(value || '').slice(0, 200)}"
${_contextBlock}

Command plan?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 200, temperature: 0.1, responseTimeoutMs: 10000 });
    const cleaned = (raw || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.trigger) return null;
    // Validate: trigger must actually appear at the start of the value.
    // Prevents hallucinated /h1 for a literal title like "Weekly Goals".
    if (!value || !String(value).trim().toLowerCase().startsWith(parsed.trigger.toLowerCase())) {
      logger.info(`[browser.agent] _extractCommandPlan: trigger "${parsed.trigger}" not at start of value — discarding`);
      return null;
    }
    logger.info(`[browser.agent] _extractCommandPlan: trigger="${parsed.trigger}", commandLabel="${parsed.commandLabel}", content="${(parsed.content || '').slice(0, 50)}"`);
    return parsed;
  } catch (e) {
    logger.warn(`[browser.agent] _extractCommandPlan failed: ${e.message}`);
    return null;
  }
}

// Search plan extraction: for type-search (e.g. "@John" → trigger="@", query="John", targetLabel="John Smith")
// Returns { trigger, query, targetLabel } or null on failure.
async function _extractSearchPlan(goal, focusedElement, value, actionHistory, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _focusedStr = _buildFocusedStr(focusedElement);

  const _contextBlock = agentContext
    ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}`
    : '';

  const systemPrompt = `You extract a search plan from a value to type into a search/mention field.
The value contains a trigger character (like @) and a query to filter a dropdown.
Return ONLY JSON: {"trigger": "@", "query": "John", "targetLabel": "John Smith"}
- trigger: the trigger character (e.g. "@", "#")
- query: the text to type after the trigger to filter the dropdown
- targetLabel: the exact label of the option to select from the filtered dropdown (from the goal)`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Focused field: ${_focusedStr}
Value to type: "${String(value || '').slice(0, 200)}"
${_contextBlock}

Search plan?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 200, temperature: 0.1, responseTimeoutMs: 10000 });
    const cleaned = (raw || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed.trigger) return null;
    logger.info(`[browser.agent] _extractSearchPlan: trigger="${parsed.trigger}", query="${parsed.query}", targetLabel="${parsed.targetLabel}"`);
    return parsed;
  } catch (e) {
    logger.warn(`[browser.agent] _extractSearchPlan failed: ${e.message}`);
    return null;
  }
}

// Edit mode decision: determines whether a type-edit goal is "generate" (create new content)
// or "edit" (modify existing content). Returns 'generate' or 'edit'.
async function _extractEditMode(goal, focusedElement, currentValue, agentContext) {
  // Deterministic pre-checks based on goal keywords
  const _goalLower = (goal || '').toLowerCase();
  const _editKeywords = /\b(edit|fix|update|modify|refactor|change|replace|add a (section|paragraph|conclusion)|rewrite|revise|correct)\b/i;
  const _generateKeywords = /\b(write|draft|compose|create|generate|make|build|produce|add)\b/i;

  // If the field already has content and the goal says edit/fix/update → edit mode
  if (currentValue && currentValue.length > 10 && _editKeywords.test(goal)) {
    logger.info(`[browser.agent] _extractEditMode: → edit (field has content + goal has edit keyword)`);
    return 'edit';
  }
  // If the field is empty and the goal says write/draft/create → generate mode
  if ((!currentValue || currentValue.length < 10) && _generateKeywords.test(goal)) {
    logger.info(`[browser.agent] _extractEditMode: → generate (field empty + goal has generate keyword)`);
    return 'generate';
  }
  // If goal has edit keyword but field is empty → still generate (can't edit nothing)
  if (_editKeywords.test(goal) && (!currentValue || currentValue.length < 10)) {
    logger.info(`[browser.agent] _extractEditMode: → generate (edit keyword but field empty)`);
    return 'generate';
  }
  // If goal has generate keyword and field has content → generate (overwrite)
  if (_generateKeywords.test(goal)) {
    logger.info(`[browser.agent] _extractEditMode: → generate (generate keyword)`);
    return 'generate';
  }

  // LLM fallback for ambiguous cases
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 500)}` : '';

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'Determine if the goal is about generating new content or editing existing content. Return ONLY "generate" or "edit".' },
      { role: 'user', content: `Goal: ${goal}\nField has existing content: ${currentValue ? `yes (${currentValue.length} chars)` : 'no'}${_contextBlock}\n\nMode?` },
    ], { maxTokens: 10, temperature: 0.1, responseTimeoutMs: 5000 });
    const mode = (raw || '').trim().toLowerCase().startsWith('edit') ? 'edit' : 'generate';
    logger.info(`[browser.agent] _extractEditMode: LLM → ${mode} (raw="${(raw || '').trim()}")`);
    return mode;
  } catch (e) {
    logger.warn(`[browser.agent] _extractEditMode LLM failed: ${e.message} — defaulting to generate`);
    return 'generate';
  }
}

// Search text extraction: what text to search for via Meta+F.
async function _extractSearchText(goal, actionHistory) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const systemPrompt = `You extract the text to search for on a web page using browser find (Ctrl+F).
The search will find and focus the element containing this text, then click it.
Look at the goal and what's been done. Return ONLY the search text — nothing else.
- Return a short, distinctive text snippet that would appear on the page (conversation name, email subject, menu item text)
- Do NOT include quotes unless they are part of the actual text
- Keep it concise (2-6 words typically)`;

  const historyStr = actionHistory.slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Actions taken:
${historyStr}

Search text?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 100, temperature: 0.1, responseTimeoutMs: 10000 });
    const val = (raw || '').trim().replace(/^["']|["']$/g, '').replace(/^```(?:text|plaintext)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    logger.info(`[browser.agent] _extractSearchText: "${val}" for goal "${String(goal).slice(0, 50)}"`);
    return val;
  } catch (e) {
    logger.warn(`[browser.agent] _extractSearchText failed: ${e.message}`);
    return '';
  }
}

// Shortcut selection: pick the best keyboard shortcut from appKnowledge.
// LLM sees a numbered list of natural-language descriptions (no key combos),
// returns just a number. Number maps to index in shortcuts array for the
// actual key combo. Returns key combo string or null.
async function _extractShortcut(goal, actionHistory, hostname, agentContext, currentUrl, overlayActive, focusedElement) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const { loadAppKnowledge } = require('./lib/appKnowledge.cjs');

  // Load shortcut entries from appKnowledge
  const entries = loadAppKnowledge(hostname);
  const shortcuts = entries.filter(e => e.type === 'shortcut' && e.details?.shortcut);

  if (shortcuts.length === 0) {
    logger.info(`[browser.agent] _extractShortcut: no shortcuts in appKnowledge for ${hostname}`);
    return null;
  }

  // Build numbered list with natural-language descriptions ONLY (no key combos)
  const shortcutList = shortcuts.map((s, i) => {
    // Extract action description from summary (remove "Press X to " prefix)
    const action = s.summary
      .replace(/^.*?\bto\s+/i, '')
      .replace(/\.$/, '')
      .slice(0, 80);
    return `${i + 1}. ${action}`;
  }).join('\n');

  // Build context from URL, overlay state, and focused element
  const _viewHint = currentUrl.includes('/month/') ? 'Current view: MONTH (n/j jumps months, not days — do NOT use n/j for "go to tomorrow")'
    : currentUrl.includes('/week/') ? 'Current view: WEEK.'
    : currentUrl.includes('/day/') ? 'Current view: DAY.'
    : '';
  const _overlayHint = overlayActive
    ? 'A dialog/overlay is ALREADY OPEN. Do NOT pick shortcuts that open dialogs (create, edit, search dialogs). Return 0 if no shortcut applies to the open dialog.'
    : 'No dialog is open.';
  const _focusHint = focusedElement
    ? `Focused element: "${focusedElement.text || focusedElement.tag || 'unknown'}" (${focusedElement.tag || 'unknown'}, role=${focusedElement.role || 'none'}).`
    : 'No element is focused.';

  const systemPrompt = `You pick the best keyboard shortcut to press for the current goal.
Look at the goal, what's been done, the available shortcuts, and the current page context.
Return ONLY a number — nothing else.
- Pick the shortcut that directly accomplishes the NEXT sub-goal (not the entire goal)
- Do NOT pick shortcuts for actions already done (see action history)
- If no shortcut matches the goal → return 0
- If a dialog is already open, do NOT pick shortcuts that open dialogs
- If the view is MONTH, "next period" shortcuts jump months, not days

PRIORITY RULE for create/add/schedule goals:
- If the goal says "create", "add", or "schedule" something → pick the CREATE shortcut (e.g., "create a new event", "open the create dialog for a timed event")
- Prefer the GENERIC create shortcut (e.g., "c — create a new event") over specialized ones like "Shift+c — timed event" or "q — all-day event" unless the goal explicitly asks for a timed/all-day/appointment-schedule event
- Do NOT pick navigation shortcuts (go to today, next period) for create goals — the date can be set inside the create dialog
- "Navigate to tomorrow" in a create goal means "set the date to tomorrow in the form", NOT "press n to jump to next month"`;

  const historyStr = actionHistory.slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
Actions taken:
${historyStr}

Page context: ${_overlayHint} ${_focusHint} ${_viewHint}

Available app shortcuts:
${shortcutList}

Which shortcut? (return number or 0 for none)`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 10, temperature: 0.1, responseTimeoutMs: 10000 });
    const val = (raw || '').trim();
    const num = parseInt(val);
    logger.info(`[browser.agent] _extractShortcut: LLM picked "${val}" (parsed: ${num}) from ${shortcuts.length} shortcuts`);
    if (!num || num < 1 || num > shortcuts.length) return null;
    const picked = shortcuts[num - 1];
    logger.info(`[browser.agent] _extractShortcut: → "${picked.details.shortcut}" (${picked.summary.slice(0, 60)})`);
    return { key: picked.details.shortcut, entryId: picked.id };
  } catch (e) {
    logger.warn(`[browser.agent] _extractShortcut failed: ${e.message}`);
    return null;
  }
}

// Parse JSON from LLM output — tries </reasoning> tag, then [{, then [...], then JSON.parse.
// Returns array or null.
function _parseStepsJson(raw) {
  let jsonStr = (raw || '').trim();
  if (!jsonStr) return null;
  const reasoningEnd = jsonStr.indexOf('</reasoning>');
  if (reasoningEnd !== -1) {
    jsonStr = jsonStr.slice(reasoningEnd + '</reasoning>'.length).trim();
  } else {
    const bracketStart = jsonStr.indexOf('[{');
    if (bracketStart >= 0) jsonStr = jsonStr.slice(bracketStart);
  }
  const cleaned = jsonStr.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      try { return JSON.parse(arrMatch[0]); } catch { return null; }
    }
    return null;
  }
}

// Regex fallback — extract steps from prose (fragile but better than nothing).
// Looks for "type X into Y", "click Z", "press Enter" patterns and matches to tabMap.
function _regexExtractSteps(raw, goal, tabMap) {
  if (!raw) return null;
  const text = String(raw);

  // Look for JSON-like arrays embedded in prose (e.g., "Here are the steps: [{...}]")
  const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.info(`[browser.agent] _regexExtractSteps: found JSON array in prose (${parsed.length} steps)`);
        return parsed;
      }
    } catch {}
  }

  // Look for action patterns: "type X into Y", "click Z", "press Enter"
  const steps = [];
  const lines = text.split(/[\n.]+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const typeMatch = line.match(/(?:type|enter|input|fill)\s+["']?([^"']+?)["']?\s+(?:into|in|on)\s+["']?([^"']+?)["']?(?:\s|$)/i);
    const clickMatch = line.match(/(?:click|press|select)\s+(?:the\s+)?["']?([^"']+?)["']?(?:\s|$)/i);
    const pressMatch = line.match(/press\s+(?:the\s+)?["']?([^"']+?)["']?\s+key/i);

    if (typeMatch) {
      const target = typeMatch[2];
      const value = typeMatch[1];
      const el = (tabMap || []).find(e => (e.text || e.ariaLabel || '').toLowerCase().includes(target.toLowerCase()));
      if (el) steps.push({ action: 'type', target, value });
    } else if (pressMatch) {
      steps.push({ action: 'press', key: pressMatch[1] });
    } else if (clickMatch) {
      const target = clickMatch[1];
      if (/enter|tab|escape|shift/i.test(target) && /key/i.test(line)) continue;
      const el = (tabMap || []).find(e => (e.text || e.ariaLabel || '').toLowerCase().includes(target.toLowerCase()));
      if (el) steps.push({ action: 'click', target });
    }
  }

  if (steps.length > 0) {
    logger.info(`[browser.agent] _regexExtractSteps: extracted ${steps.length} step(s) from prose`);
    return steps;
  }
  return null;
}

// Step-based Tab-Map: extract ordered steps from goal + available elements in one LLM call.
// Returns array of { action, target?, value?, key? } or null on failure.
// Caller executes steps in order; on page change, re-extract for new page.
// If null or <=1 step, caller falls back to per-step _llmNextAction (browse-and-report).
// 3-layer fallback: (1) planning model, (2) complex model with sharper prompt, (3) regex.
async function _extractSteps(goal, currentUrl, tabMap, pageCategory, agentContext, overlayActive = false, actionHistory = []) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext
    ? `\n\nAgent context (service descriptor / playbook — use these labels if relevant):\n${String(agentContext).slice(0, 1200)}`
    : '';

  // Build element list with [FILLABLE]/[CLICKABLE] markers
  // Include ariaRoleDescription and placeholder so the LLM can identify title fields
  // (e.g. aria-roledescription="page title", placeholder="Untitled") and avoid typing
  // block commands into them.
  const elementList = (tabMap || []).map(e => {
    const _tag = e.tag || '';
    const _role = e.role || '';
    const _label = e.text || e.ariaLabel || '';
    const _isFillable = ['input', 'textarea'].includes(_tag) ||
                        _role === 'combobox' || _role === 'textbox';
    const _marker = _isFillable ? '[FILLABLE]' : '[CLICKABLE]';
    const _ariaRoleDesc = e.ariaRoleDescription || '';
    const _placeholder = e.placeholder || '';
    const _extras = [
      _ariaRoleDesc ? `aria-roledescription="${_ariaRoleDesc}"` : '',
      _placeholder ? `placeholder="${_placeholder}"` : '',
    ].filter(Boolean).join(' ');
    return `${e.id} - ${_tag} "${_label}" ${_role ? `role=${_role} ` : ''}${_extras ? `${_extras} ` : ''}${_marker}`;
  }).join('\n');

  const systemPrompt = `You are planning the steps to achieve a goal on a web page.
Look at the goal, the current URL, and the available elements.
Extract the ordered steps needed to achieve the goal ON THIS PAGE ONLY.

Output ONLY a JSON array. No reasoning, no prose, no markdown, no commentary.
The array MUST start with [ and end with ].

Allowed actions (use ONLY these exact words):
  type             — for entering text into [FILLABLE] elements
  click            — for pressing [CLICKABLE] elements (buttons, links)
  press            — for keyboard keys (Enter, Tab, Escape)
  navigate         — to navigate to a URL
  waitForStableText — wait for page content to stabilize (use after search, navigation, or pressing Enter on dynamic pages)
  getPageText      — read all visible page text (use to capture search results, listings, email counts, or content)
  scroll           — scroll the page (use when results are below the fold)
  screenshot       — capture a visual screenshot
  run-code         — execute custom JavaScript for targeted data extraction
  done             — when the goal is already achieved

NEVER use "fill", "input", "enter", or any other action name. Only type, click, press, navigate, waitForStableText, getPageText, scroll, screenshot, run-code, done.

Step formats (use EXACTLY these):
  { "action": "type", "target": "field label", "value": "text to type" }
  { "action": "click", "target": "button text" }
  { "action": "press", "key": "Enter" }
  { "action": "navigate", "url": "https://..." }
  { "action": "waitForStableText" }
  { "action": "getPageText" }
  { "action": "scroll", "direction": "down" }
  { "action": "screenshot" }
  { "action": "run-code", "code": "async page => { return await page.evaluate(() => { ... }) }" }
  { "action": "done" }

Rules:
- Use the EXACT text/label of elements from the available elements list for "target".
- Use "type" for [FILLABLE] elements, "click" for [CLICKABLE] elements.
- Extract values to type from the goal text (email addresses, subjects, message bodies, search queries, names).
- Only include steps that can be done ON THIS PAGE with the available elements.
- If the page has [FILLABLE] form fields, fill ALL of them before clicking any submit button (Send, Submit, Post, Save, etc.).
- Do NOT include steps for actions that require a different page (e.g., don't plan clicking a search result if the search hasn't been submitted yet — that's a future page).
- If the goal is already achieved on this page, return [{ "action": "done" }].
- If no action on this page gets closer to the goal, return [{ "action": "done" }].
- For chip/token fields (email To, Recipients, CC, BCC): the system auto-confirms with Enter after Type. Do NOT add a separate press Enter step for chip confirmation.
- For AI chat (ChatGPT, Claude, etc.): after typing the prompt, add { "action": "press", "key": "Enter" } to submit.
- Maximum 8 steps per page.
- If there is only one step, still return an array: [{ "action": "..." }]
- Output ONLY the JSON array, starting with [ and ending with ]. No other text.

CONTENT EXTRACTION RULE: For any goal that involves searching, reading, counting, listing, or checking content (e.g., "search for unread emails", "count messages from X", "list items", "check how many"), ALWAYS end the plan with { "action": "waitForStableText" } followed by { "action": "getPageText" } so the results are captured and returned. Without getPageText, the task result will be empty.

Conflict resolution (common with deep-links that pre-create content):
- If the goal says "create a new document" but the page already shows a new/blank document (URL contains /document/d/.../edit, title is "Untitled"), the document is already created. Do NOT try to click "New" or "Blank" again. Instead, rename it: find the title/rename field and type the new title from the goal.
- If an overlay or template picker is open and the document is already created, dismiss it (press Escape) and then rename the document.
- If the goal mentions multiple actions but some are already done (see page state), only plan the remaining actions.

TITLE FIELD GUARD (canvas editors like Notion, Google Docs):
- Title fields are identifiable by aria-roledescription containing "title" or placeholder containing "Untitled"/"New page".
- Do NOT generate Type steps with block commands (e.g. /todo, /heading, /bullet) targeting title fields. Title fields are for the page name only.
- If a step would type a command into a title field, add a press Enter step first to move focus to the body, then type the command into the body.
- Example: goal "create page called X and add a todo list" → [{ "action": "type", "target": "title", "value": "X" }, { "action": "press", "key": "Enter" }, { "action": "type", "target": "body", "value": "/todo\\nItem 1" }].

OVERLAY/DIALOG STATE RULES (critical — check the Overlay/dialog state in the user prompt):
- If the Overlay/dialog is OPEN, do NOT generate "navigate" steps — the dialog is already open; fill its fields or click its buttons instead. Navigating will close the dialog and destroy progress.
- If the Overlay/dialog is OPEN, do NOT generate steps to open it again (e.g., "Click Create", "Click Event", "Click New", "Click +"). The dialog is already open.
- If the Overlay/dialog is OPEN, the form fields in the available elements list are the relevant ones — plan to fill them and then click the submit/save button.
- If the Overlay/dialog is CLOSED and the goal requires creating something, you may need to click a "Create" button or use a shortcut to open the dialog first.
- Use the Actions already taken to determine what's been done. Do NOT repeat actions already taken (e.g., if a shortcut was pressed to open the create dialog, don't plan to open it again).
- If a "navigate" step would go to the same or a parent of the current URL, skip it — it's redundant.`;

  const _overlayStr = overlayActive ? 'OPEN' : 'CLOSED';
  const _historyStr = (actionHistory && actionHistory.length > 0)
    ? actionHistory.slice(-10).map((a, i) => `  ${i + 1}. ${a}`).join('\n')
    : '  (none)';

  const userPrompt = `Goal: ${goal}
Current URL: ${currentUrl}
Page category: ${pageCategory || 'unknown'}
Overlay/dialog: ${_overlayStr}
Actions already taken:
${_historyStr}${_contextBlock}

Available elements on this page:
${elementList}

Extract the ordered steps:`;

  // Helper: call LLM with given taskType + maxTokens
  const _callLlm = async (sysPrompt, opts) => {
    try {
      return await askWithMessages([
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userPrompt },
      ], { maxTokens: opts.maxTokens || 2500, temperature: 0.1, responseTimeoutMs: 20000, taskType: opts.taskType || 'planning' });
    } catch (e) {
      logger.warn(`[browser.agent] _extractSteps call failed (${opts.taskType}): ${e.message}`);
      return '';
    }
  };

  // Helper: normalize parsed JSON to steps array + post-process
  const _normalizeSteps = (parsed) => {
    if (!parsed) return null;
    let steps;
    if (Array.isArray(parsed)) {
      steps = parsed;
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.steps)) steps = parsed.steps;
      else if (Array.isArray(parsed.actions)) steps = parsed.actions;
      else if (Array.isArray(parsed.plan)) steps = parsed.plan;
      else if (Array.isArray(parsed.result)) steps = parsed.result;
      else if (Array.isArray(parsed.data)) steps = parsed.data;
      else if (Array.isArray(parsed.output)) steps = parsed.output;
      else if (parsed.action) steps = [parsed];
      else {
        const _arrVal = Object.values(parsed).find(v => Array.isArray(v) && v.length > 0 &&
          v.every(s => s && typeof s === 'object' && typeof s.action === 'string'));
        if (_arrVal) {
          steps = _arrVal;
          logger.info(`[browser.agent] _extractSteps: extracted steps from unknown array property — ${steps.length} step(s)`);
        } else {
          logger.warn(`[browser.agent] _extractSteps: response is object without steps array. Raw: ${JSON.stringify(parsed).slice(0, 500)}`);
          return null;
        }
      }
      logger.info(`[browser.agent] _extractSteps: normalized ${Array.isArray(parsed) ? 'array' : 'object'} to ${steps.length} step(s)`);
    } else {
      logger.warn(`[browser.agent] _extractSteps: response not an array or object. Raw: ${String(parsed).slice(0, 500)}`);
      return null;
    }

    // Post-process: normalize action names and filter invalid steps (defense in depth)
    const _actionAliases = { fill: 'type', input: 'type', enter: 'type', write: 'type', set: 'type' };
    const _observationActions = ['waitforstabletext', 'getpagetext', 'scroll', 'screenshot', 'run-code', 'navigate'];
    steps = steps.map(s => {
      const normalized = { ...s };
      const _act = (normalized.action || '').toLowerCase();
      if (_actionAliases[_act]) normalized.action = _actionAliases[_act];
      return normalized;
    }).filter(s => {
      const _act = (s.action || '').toLowerCase();
      // Observation actions: no target needed, but validate their specific fields
      if (_observationActions.includes(_act)) {
        if (_act === 'navigate') {
          if (!s.url || !/^https?:\/\//i.test(s.url)) {
            logger.warn(`[browser.agent] _extractSteps: dropping navigate step with invalid url "${s.url}"`);
            return false;
          }
          return true;
        }
        if (_act === 'scroll') {
          if (!s.direction || !['up', 'down', 'left', 'right'].includes(s.direction)) {
            s.direction = 'down'; // default
          }
          return true;
        }
        if (_act === 'run-code') {
          if (!s.code || typeof s.code !== 'string') {
            logger.warn(`[browser.agent] _extractSteps: dropping run-code step with no code`);
            return false;
          }
          return true;
        }
        // waitForStableText, getPageText, screenshot — no validation needed
        return true;
      }
      if (!['type', 'click', 'press', 'done'].includes(s.action)) {
        logger.warn(`[browser.agent] _extractSteps: dropping step with invalid action "${s.action}"`);
        return false;
      }
      if (s.action === 'done') return true;
      if (s.action === 'press') return !!s.key;
      const _t = (s.target || '').trim();
      if (!_t || /^div$/i.test(_t) || /^div\s+""$/i.test(_t)) {
        logger.warn(`[browser.agent] _extractSteps: dropping step with invalid target "${s.target}"`);
        return false;
      }
      return true;
    });

    if (steps.length === 0) {
      logger.warn(`[browser.agent] _extractSteps: all steps filtered out — returning null`);
      return null;
    }
    return steps;
  };

  try {
    // Layer 1: planning model (current behavior, but with higher maxTokens)
    let raw = await _callLlm(systemPrompt, { taskType: 'planning', maxTokens: 2500 });
    let parsed = _parseStepsJson(raw);
    let steps = _normalizeSteps(parsed);
    if (steps) {
      logger.info(`[browser.agent] _extractSteps: Layer 1 (planning) extracted ${steps.length} step(s) — ${steps.map(s => s.action + (s.target ? ` "${s.target}"` : '')).join(', ')}`);
      return steps;
    }

    // Layer 2: complex model retry with sharper prompt (same taskType as planSkillsV2.js)
    logger.warn(`[browser.agent] _extractSteps: Layer 1 (planning) produced no JSON — retrying with complex model`);
    const _sharperPrompt = systemPrompt + '\n\nCRITICAL: Your previous response contained reasoning but NO JSON array. Output ONLY the JSON array now. Start with [ and end with ]. No reasoning, no prose, no commentary.';
    raw = await _callLlm(_sharperPrompt, { taskType: 'complex', maxTokens: 2500 });
    parsed = _parseStepsJson(raw);
    steps = _normalizeSteps(parsed);
    if (steps) {
      logger.info(`[browser.agent] _extractSteps: Layer 2 (complex) extracted ${steps.length} step(s) — ${steps.map(s => s.action + (s.target ? ` "${s.target}"` : '')).join(', ')}`);
      return steps;
    }

    // Layer 3: regex fallback — extract steps from prose (fragile but better than nothing)
    logger.warn(`[browser.agent] _extractSteps: Layer 2 (complex) also failed — trying regex fallback`);
    const regexSteps = _regexExtractSteps(raw, goal, tabMap);
    if (regexSteps) {
      const normalized = _normalizeSteps(regexSteps);
      if (normalized) {
        logger.info(`[browser.agent] _extractSteps: Layer 3 (regex) extracted ${normalized.length} step(s) — ${normalized.map(s => s.action + (s.target ? ` "${s.target}"` : '')).join(', ')}`);
        return normalized;
      }
    }

    logger.warn(`[browser.agent] _extractSteps: all 3 layers failed — returning null`);
    return null;
  } catch (e) {
    logger.warn(`[browser.agent] _extractSteps failed: ${e.message}`);
    return null;
  }
}

// Tab-Map strategy: LLM decides one action per step based on available elements.
// Updated with [FILLABLE]/[CLICKABLE] markers, filled field tracking, and label fixes.
async function _llmNextAction(goal, currentUrl, tabMap, actionHistory, pageCategory, agentContext, lastVerifyFailed, consumedRefs, filledFields, extractedPageText) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext
    ? `\n\nAgent context (service descriptor / playbook — use these labels if relevant):\n${String(agentContext).slice(0, 1500)}`
    : '';

  const _pageTextBlock = extractedPageText && extractedPageText.trim().length > 0
    ? `\n\nPage text captured (from previous Get page text / Wait for stable text):\n${extractedPageText.slice(0, 3000)}`
    : '';

  // Build element list with [FILLABLE]/[REQUIRED]/[FILLED]/[SUBMIT] markers.
  // Show ALL elements (don't filter out filled ones) so LLM has full context.
  // Match filled state by ref OR label (handles rescan case where ref changed).
  const _submitKeywords = /\b(send|submit|post|publish|save|create|delete|confirm|ok|apply|done|finish|complete|next|continue|yes|update|sign\s*up|register|log\s*in|sign\s*in|place\s*order|buy|checkout|book|reserve|schedule|subscribe)\b/i;

  const _filledMap = new Map();
  if (filledFields && filledFields.length > 0) {
    for (const f of filledFields) {
      if (f.ref) _filledMap.set(f.ref, f.value);
      if (f.label) _filledMap.set(`label:${String(f.label).toLowerCase()}`, f.value);
    }
  }

  const elementList = (tabMap || []).map(e => {
    const _tag = e.tag || '';
    const _role = e.role || '';
    const _label = e.text || e.ariaLabel || '';
    const _isFillable = ['input', 'textarea'].includes(_tag) ||
                        _role === 'combobox' || _role === 'textbox';
    const _filledValue = _filledMap.get(e.ref) || _filledMap.get(`label:${String(_label).toLowerCase()}`);

    const markers = [];
    if (_isFillable) {
      markers.push('[FILLABLE]');
      if (_filledValue) {
        markers.push(`[FILLED: "${String(_filledValue).slice(0, 40)}"]`);
      } else {
        markers.push('[REQUIRED]');
      }
    } else {
      markers.push('[CLICKABLE]');
      if (_submitKeywords.test(_label)) {
        markers.push('[SUBMIT]');
      }
    }

    return `${e.id} - ${_tag} "${_label}" ${_role ? `role=${_role} ` : ''}${markers.join(' ')}`;
  }).join('\n');

  // Build "Fields already filled" section
  const filledStr = (filledFields && filledFields.length > 0)
    ? filledFields.map(f => `  ${f.label}: ${String(f.value).slice(0, 60)}`).join('\n')
    : '  (none)';

  const historyStr = actionHistory.length > 0
    ? actionHistory.slice(-10).map((a, i) => `  ${i + 1}. ${a}`).join('\n')
    : '  (none)';

  const verifyNote = lastVerifyFailed
    ? '\n\nNOTE: You previously said DONE but verification failed — the goal is NOT yet achieved. Try another action.'
    : '';

  const systemPrompt = `You are navigating a web page to achieve a goal.
Look at the goal, the current URL, the actions you've already taken, the fields already filled, and the available elements.
Decide the SINGLE next action that gets closest to achieving the goal.

Output ONLY one action, one line. No preamble, no explanation, no numbering, no markdown.

Action formats (use EXACTLY these verb forms):
  Click "button text"
  Type "value" into the "field label" field
  Press Enter
  Press Tab
  Press Escape
  Navigate to https://url
  Wait for stable text
  Get page text
  Scroll down
  Scroll up
  Screenshot
  Run code: <javascript>
  DONE

Rules:
- Use ONLY these verb forms — Click, Type, Press Enter, Press Tab, Press Escape, Navigate, Wait for stable text, Get page text, Scroll down, Scroll up, Screenshot, Run code, DONE.
- Use the EXACT text/label of elements as shown in the available elements list.
- Use Type for [FILLABLE] elements and Click for [CLICKABLE] elements. Do NOT click a [FILLABLE] field — type into it directly.
- Elements marked [FILLED: "value"] are already done — do NOT type into them again. Skip to the next [REQUIRED] field.
- Elements marked [REQUIRED] are form fields that must be filled. Fill all [REQUIRED] fields first.
- WHILE any [REQUIRED] field is NOT [FILLED], your ONLY allowed actions are:
    (1) Type into a [REQUIRED] field
    (2) Click a button that expands/opens the form (e.g., Attach, CC/BCC toggle, formatting toolbar)
  Do NOT click any other button (Send, Submit, OK, Cancel, Close, etc.) until ALL [REQUIRED] fields are [FILLED].
- When ALL [REQUIRED] fields are [FILLED], you may click a [SUBMIT] button if the goal requires submission.
- If all [REQUIRED] fields are [FILLED] and no submission is needed, output DONE.
- If the goal is already achieved (form submitted, email sent, search results shown), output DONE.
- If no available element gets closer to the goal, output DONE.
- For chip/token fields (email To, Recipients, CC, BCC): after Type, the system auto-confirms with Enter. Do NOT add a separate Press Enter for chip confirmation.
- For AI chat (ChatGPT, Claude, etc.): after typing the prompt, add Press Enter to submit.
- Extract values to type from the goal text (quoted strings, names, search queries, message bodies).
- If the current URL already has the action triggered (compose=new, /new, /create), start with Type steps directly.
- If a modal/dialog is open (elements like "To", "Subject", "Body", "Send" are visible), work within it.
- Do NOT repeat actions you've already taken (see action history). Try a different approach.
- If you've already clicked an element and the page didn't change (see action results), try a different action.
- APP KNOWLEDGE RULE: Check the Agent context below for app-specific patterns — slash commands, block creation shortcuts, UI quirks, keyboard shortcuts. Use them when the goal requires app-specific interactions.
- BLOCK-CREATION RULE: When creating lists/todos/headings in block-based editors (Notion, Google Docs), do NOT type raw markdown. Create each block as a separate step: (1) Type the block-creation shortcut (e.g. "/todo" or "[]" + Space — check Agent context for the app's specific shortcuts), (2) Press Enter if a slash menu appeared, (3) Type the item text, (4) Press Enter to create the next block. Repeat for each item.
- SEARCH-THEN-CLICK RULE: When clicking search results, skip ads/sponsored results — click the first ORGANIC result.
- CONTENT EXTRACTION RULE: For any goal that involves searching, reading, counting, listing, or checking content (e.g., "search for unread emails", "count messages from X", "list items", "check how many"), after pressing Enter or navigating to trigger a search, use "Wait for stable text" then "Get page text" to capture the results before outputting DONE. Without Get page text, the task result will be empty.
- PAGE TEXT CAPTURED RULE: If "Page text captured" is shown below and it contains the information needed to answer the goal (e.g., email subjects, counts, search results), output DONE immediately. Do NOT call "Get page text" again — the text is already captured.`;

  const userPrompt = `Goal: ${goal}
Current URL: ${currentUrl}
Page category: ${pageCategory || 'unknown'}
Actions taken so far:
${historyStr}
Fields already filled:
${filledStr}${verifyNote}${_contextBlock}${_pageTextBlock}

Available elements on the current page:
${elementList}

What is the next action?`;

  // Retry on transient LLM provider failures (e.g. "All LLM providers failed").
  // 3 attempts total: initial + 2 retries with 500ms / 1500ms backoff.
  const _MAX_ATTEMPTS = 3;
  const _BACKOFF_MS = [0, 500, 1500];
  for (let _attempt = 0; _attempt < _MAX_ATTEMPTS; _attempt++) {
    if (_BACKOFF_MS[_attempt] > 0) {
      logger.info(`[browser.agent] _llmNextAction: retrying after ${_BACKOFF_MS[_attempt]}ms (attempt ${_attempt + 1}/${_MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, _BACKOFF_MS[_attempt]));
    }
    try {
      const raw = await askWithMessages([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { maxTokens: 100, temperature: 0.1, responseTimeoutMs: 15000 });
      const _clean = (raw || '').trim().replace(/^```(?:text|plaintext)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
      if (_clean) return _clean;
      logger.warn(`[browser.agent] _llmNextAction: empty response on attempt ${_attempt + 1}/${_MAX_ATTEMPTS}`);
    } catch (e) {
      logger.warn(`[browser.agent] _llmNextAction failed (attempt ${_attempt + 1}/${_MAX_ATTEMPTS}): ${e.message}`);
    }
  }
  logger.warn(`[browser.agent] _llmNextAction: all ${_MAX_ATTEMPTS} attempts failed — returning null`);
  return null;
}

// ---------------------------------------------------------------------------
// Fire-and-forget progress event POST to _progressCallbackUrl
// Same pattern as playwright.agent.cjs postProgress (line 1913)
// ---------------------------------------------------------------------------
function _postProgress(callbackUrl, evt) {
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

const { userAgent } = require('./user.agent.cjs');

const { resolveDestination, recordCorrection, classifyTaskIntent, classifyUrlType, getLearnedCorrection, deleteLearnedCorrection, suggestTaskUrl, getTaskKeywords, getCachedDeepLink, recordDeepLinkCache, deleteDeepLinkCache, getSearchUrlPattern, recordSearchUrlPattern, INTENTS, SERVICE_CHAT_URLS, isAuthFlowUrl, _isValidDeepLinkUrl } = require('../skill-helpers/destination-resolver.cjs');
const { killExistingChromeForProfile, clearProfileLock, findCli, shortSessionId, _sniffAuthCookies, engine: browserEngine } = require('./browser.act.cjs');
const { loadAppKnowledge, saveAppKnowledge, loadAndFormat, isCacheStale, isShortcutCoverageStale, recordVerification } = require('./lib/appKnowledge.cjs');

const BROWSER_ACT_PORT = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);

// Import shared database module
const { withDb, AGENTS_DB_PATH, AGENTS_DIR } = require('@thinkdrop/agents-db');

// Lazy-loaded to avoid circular require — only pulled in when auto-connect is active
let _ensureChromeCDP = null;
function getEnsureChromeCDP() {
  if (!_ensureChromeCDP) _ensureChromeCDP = require('./agentbrowser.act.cjs').ensureChromeCDP;
  return _ensureChromeCDP;
}

// ---------------------------------------------------------------------------
// Video platforms list — services that have video content and need video.agent delegation
// ---------------------------------------------------------------------------
const VIDEO_PLATFORMS = new Set([
  'youtube', 'vimeo', 'rumble', 'tiktok', 'facebook', 'fb', 'instagram', 'ig',
  'twitch', 'kick', 'dailymotion', 'bilibili', 'youku', 'tudou', 'peertube',
  'odysee', 'lbry', 'bitchute', 'brighteon', 'bannedvideo', 'bandcamp',
  'spotify', 'soundcloud', 'mixcloud', 'anchor', 'podcast', 'applepodcasts',
  'netflix', 'hulu', 'disneyplus', 'hbomax', 'primevideo', 'appletv', 'peacock',
  'crunchyroll', 'funimation', 'vrv', 'tubi', 'pluto', 'roku', 'plex',
  'wistia', 'loom', 'vidyard', 'brightcove', 'kaltura', 'jwplayer',
  'coursera', 'udemy', 'skillshare', 'masterclass', 'edx', 'khanacademy',
  'ted', 'tedtalks', 'bigthink', 'vsauce', 'veritasium', 'kurzgesagt',
  'foodnetwork', 'allrecipes', 'seriouseats', 'natashaskitchen', 'tasty',
  'bonappetit', 'chefsteps', 'americastestkitchen', 'cookingchannel',
]);

// ---------------------------------------------------------------------------
// Known browser-only services map
// ---------------------------------------------------------------------------

// Bootstrap seed map — cold-start anchors for first build_agent call before DuckDB has an entry.
// Three fields only: startUrl (post-login dashboard), authSuccessPattern (URL substring after auth),
// isOAuth (true = browser OAuth session required; false = API key settings page).
// After first build, DuckDB owns the descriptor and validate_agent can self-correct any entry.
// (resolveBrowserMeta priorities: DuckDB descriptor → DuckDB meta cache → this seed map → LLM+web_search)
const KNOWN_BROWSER_SERVICES = {
  // ── Core social / collaboration ─────────────────────────────────────────────────────────────────────
  gmail:          { startUrl: 'https://mail.google.com',                         signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'mail.google.com',              isOAuth: true,
                   intentUrls: {
                     mail: 'https://mail.google.com/mail/u/0/#inbox?compose=new',
                     search: { buildUrl: (task, ctx) => `https://mail.google.com/mail/u/0/#search/${ctx.encodedQuery}` },
                     contacts: 'https://contacts.google.com',
                   } },
  google:         { startUrl: 'https://accounts.google.com',                     signInUrl: 'https://accounts.google.com',                       authSuccessPattern: 'myaccount.google.com',         isOAuth: true,
                   intentUrls: { search: { buildUrl: (task, ctx) => `https://www.google.com/search?q=${ctx.encodedQuery}` } } },
  googledocs:     { startUrl: 'https://docs.google.com',                         signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'docs.google.com/document',     isOAuth: true, hostAliases: ['docs.google.com'],
                   intentUrls: {
                     content_create: 'https://docs.google.com/document/create',
                     open_existing: { buildUrl: (task, ctx) => `https://docs.google.com/document/u/0/?q=${ctx.encodedQuery}` },
                   } },
  googlesheets:   { startUrl: 'https://sheets.google.com',                       signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'docs.google.com/spreadsheets', isOAuth: true, hostAliases: ['sheets.google.com', 'docs.google.com'],
                   intentUrls: {
                     content_create: 'https://docs.google.com/spreadsheets/create',
                     open_existing: { buildUrl: (task, ctx) => `https://docs.google.com/spreadsheets/u/0/?q=${ctx.encodedQuery}` },
                   } },
  googlecalendar: { startUrl: 'https://calendar.google.com',                     signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'calendar.google.com',          isOAuth: true, hostAliases: ['calendar.google.com'],
                   intentUrls: { scheduling: 'https://calendar.google.com/calendar/u/0/r' } },
  slack:          { startUrl: 'https://app.slack.com',                           signInUrl: 'https://slack.com/signin',                          authSuccessPattern: 'app.slack.com/client',         isOAuth: true  },
  discord:        { startUrl: 'https://discord.com/channels/@me',                signInUrl: 'https://discord.com/login',                         authSuccessPattern: 'discord.com/channels',         isOAuth: true  },
  notion:         { startUrl: 'https://app.notion.com',                           signInUrl: 'https://www.notion.com/login',                       authSuccessPattern: 'app.notion.com',                    isOAuth: true, preferAgentBrowser: true, postAuthUrl: 'https://app.notion.com', usePersistentProfile: true, hostAliases: ['www.notion.so', 'www.notion.com', 'notion.so', 'notion.com', 'notion.new'], _metaRevision: 2,
                   intentUrls: {
                     content_create: 'https://notion.new',
                     open_existing: { buildUrl: (task, ctx) => `https://app.notion.com/search?q=${ctx.encodedQuery}` },
                   } },
  figma:          { startUrl: 'https://www.figma.com',                           signInUrl: 'https://www.figma.com/login',                       authSuccessPattern: 'figma.com/files',              isOAuth: true  },
  linear:         { startUrl: 'https://linear.app',                              signInUrl: 'https://linear.app/login',                          authSuccessPattern: 'linear.app/',                  isOAuth: true  },
  jira:           { startUrl: 'https://id.atlassian.com',                        signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'atlassian.net',                isOAuth: true  },
  confluence:     { startUrl: 'https://id.atlassian.com',                        signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'atlassian.net/wiki',           isOAuth: true  },
  airtable:       { startUrl: 'https://airtable.com',                            signInUrl: 'https://airtable.com/login',                        authSuccessPattern: 'airtable.com/',                isOAuth: true  },
  hubspot:        { startUrl: 'https://app.hubspot.com',                         signInUrl: 'https://app.hubspot.com/login',                     authSuccessPattern: 'app.hubspot.com/',             isOAuth: true  },
  salesforce:     { startUrl: 'https://login.salesforce.com',                    signInUrl: 'https://login.salesforce.com',                      authSuccessPattern: 'lightning.force.com',          isOAuth: true  },
  twitter:        { startUrl: 'https://twitter.com',                             signInUrl: 'https://twitter.com/i/flow/login',                  authSuccessPattern: 'twitter.com/home',             isOAuth: true, hostAliases: ['x.com'],
                   intentUrls: { social: 'https://x.com/compose/post', content_create: 'https://x.com/compose/post', notifications: 'https://x.com/notifications' } },
  facebook:       { startUrl: 'https://www.facebook.com',                        signInUrl: 'https://www.facebook.com/login',                    authSuccessPattern: 'facebook.com/',                isOAuth: true  },
  instagram:      { startUrl: 'https://www.instagram.com',                       signInUrl: 'https://www.instagram.com/accounts/login',          authSuccessPattern: 'instagram.com/',               isOAuth: true  },
  linkedin:       { startUrl: 'https://www.linkedin.com',                        signInUrl: 'https://www.linkedin.com/login',                    authSuccessPattern: 'linkedin.com/feed',            isOAuth: true,
                   intentUrls: { social: 'https://www.linkedin.com/feed/?shareActive=true', content_create: 'https://www.linkedin.com/post/new', notifications: 'https://www.linkedin.com/notifications/', contacts: 'https://www.linkedin.com/mynetwork/contacts/' } },
  // ── Email ───────────────────────────────────────────────────────────────────────────────────────────
  outlook:        { startUrl: 'https://outlook.live.com',                        signInUrl: 'https://login.live.com',                            authSuccessPattern: 'outlook.live.com/mail',        isOAuth: true,
                   intentUrls: { mail: 'https://outlook.live.com/mail/0/deeplink/compose' } },
  yahoo:          { startUrl: 'https://mail.yahoo.com',                          signInUrl: 'https://login.yahoo.com',                           authSuccessPattern: 'mail.yahoo.com',               isOAuth: true  },
  protonmail:     { startUrl: 'https://mail.proton.me',                          signInUrl: 'https://account.proton.me/login',                   authSuccessPattern: 'mail.proton.me',               isOAuth: true  },
  fastmail:       { startUrl: 'https://www.fastmail.com',                        signInUrl: 'https://www.fastmail.com/login/',                   authSuccessPattern: 'fastmail.com',                 isOAuth: true  },
  zohomail:       { startUrl: 'https://mail.zoho.com',                           signInUrl: 'https://accounts.zoho.com/signin',                  authSuccessPattern: 'mail.zoho.com',                isOAuth: true  },
  // ── Social media ────────────────────────────────────────────────────────────────────────────────────
  tiktok:         { startUrl: 'https://www.tiktok.com',                          signInUrl: 'https://www.tiktok.com/login',                      authSuccessPattern: 'tiktok.com/foryou',            isOAuth: true  },
  pinterest:      { startUrl: 'https://www.pinterest.com',                       signInUrl: 'https://www.pinterest.com/login',                   authSuccessPattern: 'pinterest.com/',               isOAuth: true  },
  reddit:         { startUrl: 'https://www.reddit.com',                          signInUrl: 'https://www.reddit.com/login',                      authSuccessPattern: 'reddit.com/',                  isOAuth: true,
                   intentUrls: {
                     social: { buildUrl: (task) => { const m = task.match(/r\/([\w-]+)/i); return m ? `https://www.reddit.com/r/${m[1]}/submit` : 'https://www.reddit.com/submit'; } },
                     content_create: { buildUrl: (task) => { const m = task.match(/r\/([\w-]+)/i); return m ? `https://www.reddit.com/r/${m[1]}/submit` : 'https://www.reddit.com/submit'; } },
                     search: { buildUrl: (task, ctx) => `https://www.reddit.com/search/?q=${ctx.encodedQuery}` },
                   } },
  snapchat:       { startUrl: 'https://accounts.snapchat.com',                   signInUrl: 'https://accounts.snapchat.com',                     authSuccessPattern: 'accounts.snapchat.com',        isOAuth: true  },
  mastodon:       { startUrl: 'https://mastodon.social',                         signInUrl: 'https://mastodon.social/auth/sign_in',              authSuccessPattern: 'mastodon.social/home',         isOAuth: true  },
  bluesky:        { startUrl: 'https://bsky.app',                                signInUrl: 'https://bsky.app/login',                            authSuccessPattern: 'bsky.app',                     isOAuth: true  },
  threads:        { startUrl: 'https://www.threads.net',                         signInUrl: 'https://www.threads.net/login',                     authSuccessPattern: 'threads.net',                  isOAuth: true  },
  youtube:        { startUrl: 'https://www.youtube.com',                         signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'youtube.com',                  isOAuth: false,
                   intentUrls: {
                     media_play: { buildUrl: (task) => { const m = task.match(/(?:play|watch|search)\s+(?:for\s+)?(.+)/i); return m ? `https://www.youtube.com/results?search_query=${encodeURIComponent(m[1].trim())}` : 'https://www.youtube.com'; } },
                     content_create: 'https://studio.youtube.com/videos/upload',
                     search: { buildUrl: (task, ctx) => `https://www.youtube.com/results?search_query=${ctx.encodedQuery}` },
                   } },
  twitch:         { startUrl: 'https://www.twitch.tv',                           signInUrl: 'https://www.twitch.tv/login',                       authSuccessPattern: 'twitch.tv',                    isOAuth: true  },
  // ── Music streaming ──────────────────────────────────────────────────────────────────────────────────
  spotify:        { startUrl: 'https://open.spotify.com',                        signInUrl: 'https://accounts.spotify.com/en/login',             authSuccessPattern: 'open.spotify.com/collection,open.spotify.com/playlist,open.spotify.com/album,open.spotify.com/artist',  isOAuth: true,
                   intentUrls: {
                     media_play: 'https://open.spotify.com',
                     content_create: { url: 'https://open.spotify.com', when: /\b(create|make|new)\b.*\bplaylist\b/i },
                   } },
  // ── Developer tools ─────────────────────────────────────────────────────────────────────────────────
  github:         { startUrl: 'https://github.com',                              signInUrl: 'https://github.com/login',                          authSuccessPattern: 'github.com/',                  isOAuth: true,
                   intentUrls: {
                     content_create: { buildUrl: (task) => { const m = task.match(/(?:in|on)\s+([\w-]+\/[\w-]+)/i); return m ? `https://github.com/${m[1]}/issues/new` : null; } },
                     search: { buildUrl: (task, ctx) => { const m = task.match(/(?:in|on)\s+([\w-]+\/[\w-]+)/i); return m ? `https://github.com/${m[1]}/issues?q=${ctx.encodedQuery}` : `https://github.com/search?q=${ctx.encodedQuery}`; } },
                   } },
  gitlab:         { startUrl: 'https://gitlab.com',                              signInUrl: 'https://gitlab.com/users/sign_in',                  authSuccessPattern: 'gitlab.com/',                  isOAuth: true  },
  bitbucket:      { startUrl: 'https://bitbucket.org',                           signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'bitbucket.org/',               isOAuth: true  },
  shortcut:       { startUrl: 'https://app.shortcut.com',                        signInUrl: 'https://app.shortcut.com/login',                    authSuccessPattern: 'app.shortcut.com/',            isOAuth: true  },
  azuredevops:    { startUrl: 'https://dev.azure.com',                           signInUrl: 'https://login.microsoftonline.com',                 authSuccessPattern: 'dev.azure.com/',               isOAuth: true  },
  // ── Productivity ────────────────────────────────────────────────────────────────────────────────────
  trello:         { startUrl: 'https://trello.com',                              signInUrl: 'https://id.atlassian.com',                          authSuccessPattern: 'trello.com/',                  isOAuth: true  },
  asana:          { startUrl: 'https://app.asana.com',                           signInUrl: 'https://app.asana.com/-/login',                     authSuccessPattern: 'app.asana.com/',               isOAuth: true  },
  monday:         { startUrl: 'https://monday.com',                              signInUrl: 'https://auth.monday.com',                           authSuccessPattern: 'monday.com',                   isOAuth: true  },
  clickup:        { startUrl: 'https://app.clickup.com',                         signInUrl: 'https://app.clickup.com/login',                     authSuccessPattern: 'app.clickup.com/',             isOAuth: true  },
  basecamp:       { startUrl: 'https://launchpad.37signals.com',                 signInUrl: 'https://launchpad.37signals.com',                   authSuccessPattern: '37signals.com',                isOAuth: true  },
  coda:           { startUrl: 'https://coda.io',                                 signInUrl: 'https://coda.io/login',                             authSuccessPattern: 'coda.io/d/',                   isOAuth: true  },
  todoist:        { startUrl: 'https://todoist.com',                             signInUrl: 'https://todoist.com/auth/login',                    authSuccessPattern: 'todoist.com/',                 isOAuth: true  },
  canva:          { startUrl: 'https://www.canva.com',                           signInUrl: 'https://www.canva.com/login',                       authSuccessPattern: 'canva.com/',                   isOAuth: true  },
  miro:           { startUrl: 'https://miro.com',                                signInUrl: 'https://miro.com/login/',                           authSuccessPattern: 'miro.com/app/',                isOAuth: true  },
  // ── Cloud / hosting ─────────────────────────────────────────────────────────────────────────────────
  vercel:         { startUrl: 'https://vercel.com/dashboard',                    signInUrl: 'https://vercel.com/login',                          authSuccessPattern: 'vercel.com/',                  isOAuth: true  },
  netlify:        { startUrl: 'https://app.netlify.com',                         signInUrl: 'https://app.netlify.com/login',                     authSuccessPattern: 'app.netlify.com/',             isOAuth: true  },
  render:         { startUrl: 'https://dashboard.render.com',                    signInUrl: 'https://dashboard.render.com/login',                authSuccessPattern: 'dashboard.render.com/',        isOAuth: true  },
  railway:        { startUrl: 'https://railway.app/dashboard',                   signInUrl: 'https://railway.app/login',                         authSuccessPattern: 'railway.app/',                 isOAuth: true  },
  flyio:          { startUrl: 'https://fly.io/dashboard',                        signInUrl: 'https://fly.io/app/sign-in',                        authSuccessPattern: 'fly.io/',                      isOAuth: true  },
  heroku:         { startUrl: 'https://dashboard.heroku.com',                    signInUrl: 'https://id.heroku.com/login',                       authSuccessPattern: 'dashboard.heroku.com/',        isOAuth: true  },
  digitalocean:   { startUrl: 'https://cloud.digitalocean.com',                  signInUrl: 'https://cloud.digitalocean.com/login',              authSuccessPattern: 'cloud.digitalocean.com/',      isOAuth: true  },
  cloudflare:     { startUrl: 'https://dash.cloudflare.com',                     signInUrl: 'https://dash.cloudflare.com/login',                 authSuccessPattern: 'dash.cloudflare.com/',         isOAuth: true  },
  awsconsole:     { startUrl: 'https://console.aws.amazon.com',                  signInUrl: 'https://signin.aws.amazon.com/signin',              authSuccessPattern: 'console.aws.amazon.com/',      isOAuth: true  },
  gcpconsole:     { startUrl: 'https://console.cloud.google.com',                signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'console.cloud.google.com',     isOAuth: true  },
  azureportal:    { startUrl: 'https://portal.azure.com',                        signInUrl: 'https://login.microsoftonline.com',                 authSuccessPattern: 'portal.azure.com/',            isOAuth: true  },
  // ── AI platforms ────────────────────────────────────────────────────────────────────────────────────
  openai:         { startUrl: 'https://platform.openai.com/api-keys',            authSuccessPattern: 'platform.openai.com',          isOAuth: false },
  anthropic:      { startUrl: 'https://console.anthropic.com',                   authSuccessPattern: 'console.anthropic.com',        isOAuth: false },
  mistral:        { startUrl: 'https://console.mistral.ai',                      authSuccessPattern: 'console.mistral.ai',           isOAuth: false },
  cohere:         { startUrl: 'https://dashboard.cohere.com',                    authSuccessPattern: 'dashboard.cohere.com',         isOAuth: false },
  groq:           { startUrl: 'https://console.groq.com',                        authSuccessPattern: 'console.groq.com',             isOAuth: false },
  replicate:      { startUrl: 'https://replicate.com',                           signInUrl: 'https://replicate.com/signin',                      authSuccessPattern: 'replicate.com/',               isOAuth: true  },
  huggingface:    { startUrl: 'https://huggingface.co/settings/tokens',          authSuccessPattern: 'huggingface.co/',              isOAuth: false },
  together:       { startUrl: 'https://api.together.xyz',                        authSuccessPattern: 'api.together.xyz',             isOAuth: false },
  // perplexity defaults to the chat/research interface; use perplexityplatform for API keys
  perplexity:       { startUrl: 'https://www.perplexity.ai/',                      authSuccessPattern: 'perplexity.ai',                isOAuth: false },
  perplexityplatform: { startUrl: 'https://www.perplexity.ai/settings/api',        authSuccessPattern: 'perplexity.ai/',               isOAuth: false },
  fireworks:      { startUrl: 'https://fireworks.ai/account/api-keys',           authSuccessPattern: 'fireworks.ai/',                isOAuth: false },
  // deepseek defaults to the chat interface; use deepseekplatform for the API console
  deepseek:         { startUrl: 'https://chat.deepseek.com/',                      authSuccessPattern: 'chat.deepseek.com',            isOAuth: false },
  deepseekplatform: { startUrl: 'https://platform.deepseek.com/api_keys',          authSuccessPattern: 'platform.deepseek.com/',       isOAuth: false },
  // ── AI consumer apps ─────────────────────────────────────────────────────────────────────────────────
  // All anonymous-first (isOAuth: false). Only trigger waitForAuth if a login wall appears.
  // IMPORTANT: these are CONSUMER WEBSITES — NOT the developer API consoles above in // ── AI platforms ──
  // AI Chat
  chatgpt:        { startUrl: 'https://chatgpt.com/',                            authSuccessPattern: 'chatgpt.com',                  isOAuth: false },
  geminiai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  gemini:         { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  googleai:       { startUrl: 'https://gemini.google.com',                       authSuccessPattern: 'gemini.google.com',             isOAuth: false },
  // Google AI Mode — distinct from Gemini; navigate to google.com and click the AI Mode button
  googleaimode:   { startUrl: 'https://www.google.com',                           authSuccessPattern: 'google.com',                   isOAuth: false,
                    preTaskGoal: 'First locate and click the "AI Mode" tab or button near the top of the Google search page. Do NOT type anything yet — click AI Mode first, then in the AI Mode interface type the search query.' },
  claude:         { startUrl: 'https://claude.ai/new', signInUrl: 'https://claude.ai/login', postAuthUrl: 'https://claude.ai/new', authSuccessPattern: 'claude.ai',      isOAuth: true  },
  perplexitychat: { startUrl: 'https://www.perplexity.ai/',                      authSuccessPattern: 'perplexity.ai',                isOAuth: false },
  grok:           { startUrl: 'https://grok.com/',                               authSuccessPattern: 'grok.com',                     isOAuth: false },
  copilotmsft:    { startUrl: 'https://copilot.microsoft.com/',                  authSuccessPattern: 'copilot.microsoft.com',        isOAuth: false },
  deepseekchat:   { startUrl: 'https://chat.deepseek.com/',                      authSuccessPattern: 'chat.deepseek.com',            isOAuth: false },
  mistralchat:    { startUrl: 'https://chat.mistral.ai/',                        authSuccessPattern: 'chat.mistral.ai',              isOAuth: false },
  qwen:           { startUrl: 'https://chat.qwenlm.ai/',                         authSuccessPattern: 'chat.qwenlm.ai',               isOAuth: false },
  // AI Image & Art
  midjourney:     { startUrl: 'https://www.midjourney.com/',                     authSuccessPattern: 'midjourney.com',               isOAuth: false },
  ideogram:       { startUrl: 'https://ideogram.ai/',                            authSuccessPattern: 'ideogram.ai',                  isOAuth: false },
  stablechat:     { startUrl: 'https://dreamstudio.ai/generate',                 authSuccessPattern: 'dreamstudio.ai',               isOAuth: false },
  firefly:        { startUrl: 'https://firefly.adobe.com/',                      authSuccessPattern: 'firefly.adobe.com',            isOAuth: false },
  playground:     { startUrl: 'https://playground.com/',                         authSuccessPattern: 'playground.com',               isOAuth: false },
  imagenfx:       { startUrl: 'https://labs.google/fx/tools/image-fx',           authSuccessPattern: 'labs.google',                  isOAuth: false },
  craiyon:        { startUrl: 'https://www.craiyon.com/',                        authSuccessPattern: 'craiyon.com',                  isOAuth: false },
  nightcafe:      { startUrl: 'https://creator.nightcafe.studio/',               authSuccessPattern: 'nightcafe.studio',             isOAuth: false },
  leonardoai:     { startUrl: 'https://app.leonardo.ai/',                        authSuccessPattern: 'app.leonardo.ai',              isOAuth: false },
  krea:           { startUrl: 'https://krea.ai/',                                authSuccessPattern: 'krea.ai',                      isOAuth: false },
  // AI Music
  suno:           { startUrl: 'https://suno.com/',                               authSuccessPattern: 'suno.com',                     isOAuth: false },
  udio:           { startUrl: 'https://www.udio.com/',                           authSuccessPattern: 'udio.com',                     isOAuth: false },
  soundraw:       { startUrl: 'https://soundraw.io/',                            authSuccessPattern: 'soundraw.io',                  isOAuth: false },
  boomy:          { startUrl: 'https://boomy.com/',                              authSuccessPattern: 'boomy.com',                    isOAuth: false },
  mubert:         { startUrl: 'https://mubert.com/',                             authSuccessPattern: 'mubert.com',                   isOAuth: false },
  aiva:           { startUrl: 'https://www.aiva.ai/',                            authSuccessPattern: 'aiva.ai',                      isOAuth: false },
  beatoven:       { startUrl: 'https://www.beatoven.ai/',                        authSuccessPattern: 'beatoven.ai',                  isOAuth: false },
  stableaudio:    { startUrl: 'https://stableaudio.com/',                        authSuccessPattern: 'stableaudio.com',              isOAuth: false },
  // AI Video
  runwayml:       { startUrl: 'https://app.runwayml.com/',                       authSuccessPattern: 'runwayml.com',                 isOAuth: false },
  pikaai:         { startUrl: 'https://pika.art/',                               authSuccessPattern: 'pika.art',                     isOAuth: false },
  kling:          { startUrl: 'https://klingai.com/',                            authSuccessPattern: 'klingai.com',                  isOAuth: false },
  heygen:         { startUrl: 'https://app.heygen.com/',                         authSuccessPattern: 'heygen.com',                   isOAuth: false },
  synthesia:      { startUrl: 'https://app.synthesia.io/',                       authSuccessPattern: 'synthesia.io',                 isOAuth: false },
  sora:           { startUrl: 'https://sora.com/',                               authSuccessPattern: 'sora.com',                     isOAuth: false },
  lumai:          { startUrl: 'https://lumalabs.ai/dream-machine',               authSuccessPattern: 'lumalabs.ai',                  isOAuth: false },
  kaiber:         { startUrl: 'https://kaiber.ai/',                              authSuccessPattern: 'kaiber.ai',                    isOAuth: false },
  invideio:       { startUrl: 'https://invideo.io/',                             authSuccessPattern: 'invideo.io',                   isOAuth: false },
  pictory:        { startUrl: 'https://pictory.ai/',                             authSuccessPattern: 'pictory.ai',                   isOAuth: false },
  descript:       { startUrl: 'https://web.descript.com/',                       authSuccessPattern: 'descript.com',                 isOAuth: false },
  // AI Writing
  jasperai:       { startUrl: 'https://app.jasper.ai/',                          authSuccessPattern: 'app.jasper.ai',                isOAuth: false },
  copyai:         { startUrl: 'https://app.copy.ai/',                            authSuccessPattern: 'app.copy.ai',                  isOAuth: false },
  writesonic:     { startUrl: 'https://writesonic.com/',                         authSuccessPattern: 'writesonic.com',               isOAuth: false },
  rytr:           { startUrl: 'https://rytr.me/',                                authSuccessPattern: 'rytr.me',                      isOAuth: false },
  anyword:        { startUrl: 'https://app.anyword.com/',                        authSuccessPattern: 'app.anyword.com',              isOAuth: false },
  sudowrite:      { startUrl: 'https://sudowrite.com/',                          authSuccessPattern: 'sudowrite.com',                isOAuth: false },
  quillbot:       { startUrl: 'https://quillbot.com/',                           authSuccessPattern: 'quillbot.com',                 isOAuth: false },
  grammarly:      { startUrl: 'https://app.grammarly.com/',                      authSuccessPattern: 'app.grammarly.com',            isOAuth: false },
  // AI Comics & Books
  comicai:        { startUrl: 'https://comicai.com/',                            authSuccessPattern: 'comicai.com',                  isOAuth: false },
  novelai:        { startUrl: 'https://novelai.net/',                            authSuccessPattern: 'novelai.net',                  isOAuth: false },
  webtooncanvas:  { startUrl: 'https://www.webtoons.com/en/canvas',              authSuccessPattern: 'webtoons.com',                 isOAuth: false },
  pixton:         { startUrl: 'https://pixton.com/',                             authSuccessPattern: 'pixton.com',                   isOAuth: false },
  // AI Science & Research
  wolframalpha:   { startUrl: 'https://www.wolframalpha.com/',                   authSuccessPattern: 'wolframalpha.com',             isOAuth: false },
  elicit:         { startUrl: 'https://elicit.com/',                             authSuccessPattern: 'elicit.com',                   isOAuth: false },
  consensus:      { startUrl: 'https://consensus.app/',                          authSuccessPattern: 'consensus.app',                isOAuth: false },
  semanticscholar:{ startUrl: 'https://www.semanticscholar.org/',                authSuccessPattern: 'semanticscholar.org',          isOAuth: false },
  scite:          { startUrl: 'https://scite.ai/',                               authSuccessPattern: 'scite.ai',                     isOAuth: false },
  connectedpapers:{ startUrl: 'https://www.connectedpapers.com/',                authSuccessPattern: 'connectedpapers.com',          isOAuth: false },
  researchrabbit: { startUrl: 'https://www.researchrabbit.ai/',                  authSuccessPattern: 'researchrabbit.ai',            isOAuth: false },
  litmaps:        { startUrl: 'https://www.litmaps.com/',                        authSuccessPattern: 'litmaps.com',                  isOAuth: false },
  scholarcy:      { startUrl: 'https://app.scholarcy.com/',                      authSuccessPattern: 'app.scholarcy.com',            isOAuth: false },
  explainpaper:   { startUrl: 'https://www.explainpaper.com/',                   authSuccessPattern: 'explainpaper.com',             isOAuth: false },
  chatpdf:        { startUrl: 'https://www.chatpdf.com/',                        authSuccessPattern: 'chatpdf.com',                  isOAuth: false },
  humata:         { startUrl: 'https://www.humata.ai/',                          authSuccessPattern: 'humata.ai',                    isOAuth: false },
  scispace:       { startUrl: 'https://typeset.io/',                             authSuccessPattern: 'typeset.io',                   isOAuth: false },
  paperpal:       { startUrl: 'https://paperpal.com/',                           authSuccessPattern: 'paperpal.com',                 isOAuth: false },
  notebooklm:     { startUrl: 'https://notebooklm.google/',                      authSuccessPattern: 'notebooklm.google',            isOAuth: false },
  undermind:      { startUrl: 'https://www.undermind.ai/',                       authSuccessPattern: 'undermind.ai',                 isOAuth: false },
  openalex:       { startUrl: 'https://openalex.org/',                           authSuccessPattern: 'openalex.org',                 isOAuth: false },
  jenni:          { startUrl: 'https://jenni.ai/',                               authSuccessPattern: 'jenni.ai',                     isOAuth: false },
  askyourpdf:     { startUrl: 'https://askyourpdf.com/',                         authSuccessPattern: 'askyourpdf.com',               isOAuth: false },
  inciteful:      { startUrl: 'https://inciteful.xyz/',                          authSuccessPattern: 'inciteful.xyz',                isOAuth: false },
  // ── Email delivery APIs ──────────────────────────────────────────────────────────────────────────────
  sendgrid:       { startUrl: 'https://app.sendgrid.com/settings/api_keys',      authSuccessPattern: 'app.sendgrid.com',             isOAuth: false },
  mailgun:        { startUrl: 'https://app.mailgun.com/settings/api_security',   authSuccessPattern: 'app.mailgun.com',              isOAuth: false },
  postmark:       { startUrl: 'https://account.postmarkapp.com/api_tokens',      authSuccessPattern: 'postmarkapp.com',              isOAuth: false },
  resend:         { startUrl: 'https://resend.com/api-keys',                     authSuccessPattern: 'resend.com/',                  isOAuth: false },
  mailchimp:      { startUrl: 'https://login.mailchimp.com',                     signInUrl: 'https://login.mailchimp.com',                       authSuccessPattern: 'mailchimp.com/',               isOAuth: true  },
  brevo:          { startUrl: 'https://app.brevo.com',                           authSuccessPattern: 'app.brevo.com/',               isOAuth: false },
  sparkpost:      { startUrl: 'https://app.sparkpost.com/account/api-keys',      authSuccessPattern: 'app.sparkpost.com/',           isOAuth: false },
  convertkit:     { startUrl: 'https://app.convertkit.com/account_settings/advanced', authSuccessPattern: 'app.convertkit.com/',     isOAuth: false },
  klaviyo:        { startUrl: 'https://www.klaviyo.com/account#api-keys-tab',    authSuccessPattern: 'klaviyo.com/',                 isOAuth: false },
  // ── Payments / finance ───────────────────────────────────────────────────────────────────────────────
  stripe:         { startUrl: 'https://dashboard.stripe.com/apikeys',            authSuccessPattern: 'dashboard.stripe.com/',        isOAuth: false },
  paypal:         { startUrl: 'https://developer.paypal.com/dashboard',          signInUrl: 'https://www.paypal.com/signin',                     authSuccessPattern: 'developer.paypal.com/',        isOAuth: true  },
  square:         { startUrl: 'https://developer.squareup.com/apps',             signInUrl: 'https://squareup.com/login',                        authSuccessPattern: 'developer.squareup.com/',      isOAuth: true  },
  braintree:      { startUrl: 'https://sandbox.braintreegateway.com',            authSuccessPattern: 'braintreegateway.com/',        isOAuth: false },
  plaid:          { startUrl: 'https://dashboard.plaid.com',                     signInUrl: 'https://dashboard.plaid.com/signin',                authSuccessPattern: 'dashboard.plaid.com/',         isOAuth: true  },
  quickbooks:     { startUrl: 'https://app.qbo.intuit.com',                      signInUrl: 'https://accounts.intuit.com/app/sign-in',           authSuccessPattern: 'app.qbo.intuit.com/',          isOAuth: true  },
  xero:           { startUrl: 'https://go.xero.com/app/dashboard',               signInUrl: 'https://login.xero.com',                            authSuccessPattern: 'go.xero.com/',                 isOAuth: true  },
  // ── CRM / support ────────────────────────────────────────────────────────────────────────────────────
  zohocrm:        { startUrl: 'https://crm.zoho.com',                            signInUrl: 'https://accounts.zoho.com/signin',                  authSuccessPattern: 'crm.zoho.com/',                isOAuth: true  },
  pipedrive:      { startUrl: 'https://app.pipedrive.com',                       signInUrl: 'https://app.pipedrive.com/auth/login',              authSuccessPattern: 'app.pipedrive.com/',           isOAuth: true  },
  activecampaign: { startUrl: 'https://www.activecampaign.com',                  authSuccessPattern: 'activecampaign.com/',          isOAuth: false },
  freshdesk:      { startUrl: 'https://freshdesk.com',                           authSuccessPattern: 'freshdesk.com/',               isOAuth: false },
  helpscout:      { startUrl: 'https://secure.helpscout.net',                    authSuccessPattern: 'secure.helpscout.net/',        isOAuth: false },
  // ── Analytics ───────────────────────────────────────────────────────────────────────────────────────
  mixpanel:       { startUrl: 'https://mixpanel.com',                            authSuccessPattern: 'mixpanel.com/',                isOAuth: false },
  amplitude:      { startUrl: 'https://analytics.amplitude.com',                 authSuccessPattern: 'analytics.amplitude.com',      isOAuth: false },
  posthog:        { startUrl: 'https://app.posthog.com',                         authSuccessPattern: 'app.posthog.com/',             isOAuth: false },
  segment:        { startUrl: 'https://app.segment.com',                         signInUrl: 'https://app.segment.com/login',                     authSuccessPattern: 'app.segment.com/',             isOAuth: true  },
  plausible:      { startUrl: 'https://plausible.io',                            authSuccessPattern: 'plausible.io/',                isOAuth: false },
  // ── Monitoring / observability ───────────────────────────────────────────────────────────────────────
  datadog:        { startUrl: 'https://app.datadoghq.com',                       authSuccessPattern: 'app.datadoghq.com/',           isOAuth: false },
  newrelic:       { startUrl: 'https://login.newrelic.com',                      authSuccessPattern: 'one.newrelic.com/',            isOAuth: false },
  grafana:        { startUrl: 'https://grafana.com/auth/sign-in',                signInUrl: 'https://grafana.com/auth/sign-in',                  authSuccessPattern: 'grafana.com/',                 isOAuth: true  },
  sentry:         { startUrl: 'https://sentry.io',                               authSuccessPattern: 'sentry.io/',                   isOAuth: false },
  pagerduty:      { startUrl: 'https://app.pagerduty.com',                       signInUrl: 'https://app.pagerduty.com/sign_in',                authSuccessPattern: 'app.pagerduty.com/',           isOAuth: true  },
  // ── Databases / data ─────────────────────────────────────────────────────────────────────────────────
  supabase:       { startUrl: 'https://app.supabase.com',                        signInUrl: 'https://supabase.com/dashboard/sign-in',            authSuccessPattern: 'app.supabase.com/',            isOAuth: true  },
  neon:           { startUrl: 'https://console.neon.tech',                       signInUrl: 'https://console.neon.tech/login',                   authSuccessPattern: 'console.neon.tech/',           isOAuth: true  },
  mongoatlas:     { startUrl: 'https://cloud.mongodb.com',                       signInUrl: 'https://account.mongodb.com/account/login',         authSuccessPattern: 'cloud.mongodb.com/',           isOAuth: true  },
  firebase:       { startUrl: 'https://console.firebase.google.com',             signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'console.firebase.google.com',  isOAuth: true  },
  snowflake:      { startUrl: 'https://app.snowflake.com',                       signInUrl: 'https://app.snowflake.com',                         authSuccessPattern: 'app.snowflake.com/',           isOAuth: true  },
  // ── Communications ───────────────────────────────────────────────────────────────────────────────────
  twilio:         { startUrl: 'https://console.twilio.com',                      authSuccessPattern: 'console.twilio.com/',          isOAuth: false },
  vonage:         { startUrl: 'https://dashboard.nexmo.com',                     authSuccessPattern: 'dashboard.nexmo.com/',         isOAuth: false },
  pusher:         { startUrl: 'https://dashboard.pusher.com',                    authSuccessPattern: 'dashboard.pusher.com/',        isOAuth: false },
  zoom:           { startUrl: 'https://zoom.us/signin',                          signInUrl: 'https://zoom.us/signin',                            authSuccessPattern: 'zoom.us/',                     isOAuth: true  },
  loom:           { startUrl: 'https://www.loom.com/looms/videos',               signInUrl: 'https://www.loom.com/login',                        authSuccessPattern: 'loom.com/',                    isOAuth: true  },
  // ── Identity / auth platforms ────────────────────────────────────────────────────────────────────────
  auth0:          { startUrl: 'https://manage.auth0.com',                        authSuccessPattern: 'manage.auth0.com/',            isOAuth: false },
  okta:           { startUrl: 'https://developer.okta.com',                      authSuccessPattern: 'developer.okta.com/',          isOAuth: false },
  clerk:          { startUrl: 'https://dashboard.clerk.com',                     authSuccessPattern: 'dashboard.clerk.com/',         isOAuth: false },
  // ── Storage ──────────────────────────────────────────────────────────────────────────────────────────
  dropbox:        { startUrl: 'https://www.dropbox.com/home',                    signInUrl: 'https://www.dropbox.com/login',                     authSuccessPattern: 'dropbox.com/',                 isOAuth: true  },
  box:            { startUrl: 'https://app.box.com',                             signInUrl: 'https://account.box.com/login',                     authSuccessPattern: 'app.box.com/',                 isOAuth: true  },
  // ── CMS / e-commerce ─────────────────────────────────────────────────────────────────────────────────
  shopify:        { startUrl: 'https://partners.shopify.com',                    signInUrl: 'https://accounts.shopify.com/lookup',               authSuccessPattern: 'partners.shopify.com/',        isOAuth: true  },
  contentful:     { startUrl: 'https://app.contentful.com',                      authSuccessPattern: 'app.contentful.com/',          isOAuth: false },
  sanity:         { startUrl: 'https://www.sanity.io/manage',                    signInUrl: 'https://www.sanity.io/login',                       authSuccessPattern: 'sanity.io/manage/',            isOAuth: true  },
  webflow:        { startUrl: 'https://webflow.com/dashboard',                   signInUrl: 'https://webflow.com/dashboard/login',               authSuccessPattern: 'webflow.com/',                 isOAuth: true  },
  ghost:          { startUrl: 'https://ghost.org/dashboard',                     signInUrl: 'https://ghost.org/dashboard/signin',                authSuccessPattern: 'ghost.org/',                   isOAuth: true  },
  // ── Social media management ──────────────────────────────────────────────────────────────────────────
  buffer:         { startUrl: 'https://app.buffer.com',                          signInUrl: 'https://app.buffer.com/login',                      authSuccessPattern: 'app.buffer.com/',              isOAuth: true  },
  hootsuite:      { startUrl: 'https://hootsuite.com/dashboard',                 signInUrl: 'https://hootsuite.com/login',                       authSuccessPattern: 'hootsuite.com/',               isOAuth: true  },
  // ── IoT / Smart Home ─────────────────────────────────────────────────────────────────────────────────
  ifttt:          { startUrl: 'https://ifttt.com/home',                          signInUrl: 'https://ifttt.com/login',                           authSuccessPattern: 'ifttt.com/',                   isOAuth: true  },
  homeassistant:  { startUrl: 'https://my.home-assistant.io',                    signInUrl: 'https://my.home-assistant.io',                      authSuccessPattern: 'home-assistant.io/',           isOAuth: true  },
  smartthings:    { startUrl: 'https://account.smartthings.com',                 signInUrl: 'https://account.smartthings.com',                   authSuccessPattern: 'account.smartthings.com/',     isOAuth: true  },
  nest:           { startUrl: 'https://home.nest.com',                           signInUrl: 'https://accounts.google.com/signin/v2/identifier',  authSuccessPattern: 'home.nest.com/',               isOAuth: true  },
  ring:           { startUrl: 'https://account.ring.com',                        signInUrl: 'https://account.ring.com/sign-in',                  authSuccessPattern: 'account.ring.com/',            isOAuth: true  },
  wyze:           { startUrl: 'https://app.wyzecam.com',                         signInUrl: 'https://app.wyzecam.com',                           authSuccessPattern: 'wyzecam.com/',                 isOAuth: true  },
  tuya:           { startUrl: 'https://iot.tuya.com',                            signInUrl: 'https://iot.tuya.com',                              authSuccessPattern: 'iot.tuya.com/',                isOAuth: true  },
  particle:       { startUrl: 'https://console.particle.io',                     signInUrl: 'https://login.particle.io',                         authSuccessPattern: 'console.particle.io/',         isOAuth: true  },
  blynk:          { startUrl: 'https://blynk.cloud',                             authSuccessPattern: 'blynk.cloud/',                 isOAuth: false },
  adafruitio:     { startUrl: 'https://io.adafruit.com',                         authSuccessPattern: 'io.adafruit.com/',             isOAuth: false },
  arduino:        { startUrl: 'https://app.arduino.cc',                          signInUrl: 'https://login.arduino.cc',                          authSuccessPattern: 'app.arduino.cc/',              isOAuth: true  },
  balena:         { startUrl: 'https://dashboard.balena-cloud.com',              signInUrl: 'https://dashboard.balena-cloud.com/login',          authSuccessPattern: 'dashboard.balena-cloud.com/',  isOAuth: true  },
  ubidots:        { startUrl: 'https://industrial.ubidots.com',                  authSuccessPattern: 'industrial.ubidots.com/',      isOAuth: false },
  thingsboard:    { startUrl: 'https://thingsboard.cloud/home',                  authSuccessPattern: 'thingsboard.cloud/',           isOAuth: false },
  philipshue:     { startUrl: 'https://account.meethue.com',                     signInUrl: 'https://account.meethue.com/login',                 authSuccessPattern: 'meethue.com/',                 isOAuth: true  },
  ecobee:         { startUrl: 'https://www.ecobee.com/home',                     signInUrl: 'https://www.ecobee.com/home/authorizationForm.jsp', authSuccessPattern: 'ecobee.com/',                  isOAuth: true  },
  honeywell:      { startUrl: 'https://www.resideo.com',                         authSuccessPattern: 'resideo.com/',                 isOAuth: false },
  switchbot:      { startUrl: 'https://account.switch-bot.com',                  signInUrl: 'https://account.switch-bot.com/login',              authSuccessPattern: 'switch-bot.com/',              isOAuth: true  },
  govee:          { startUrl: 'https://developer.govee.com',                     authSuccessPattern: 'developer.govee.com/',         isOAuth: false },
  lifx:           { startUrl: 'https://cloud.lifx.com',                          signInUrl: 'https://cloud.lifx.com/sign_in',                    authSuccessPattern: 'cloud.lifx.com/',              isOAuth: true  },
  shelly:         { startUrl: 'https://my.shelly.cloud',                         authSuccessPattern: 'my.shelly.cloud/',             isOAuth: false },
  meross:         { startUrl: 'https://www.meross.com/web/profile',              authSuccessPattern: 'meross.com/',                  isOAuth: false },
  nanoleaf:       { startUrl: 'https://my.nanoleaf.me',                          signInUrl: 'https://my.nanoleaf.me/login',                      authSuccessPattern: 'nanoleaf.me/',                 isOAuth: true  },
  wemo:           { startUrl: 'https://www.wemo.com/setup',                      authSuccessPattern: 'wemo.com/',                    isOAuth: false },
  lutron:         { startUrl: 'https://www.casetawireless.com',                  signInUrl: 'https://www.casetawireless.com',                    authSuccessPattern: 'casetawireless.com/',          isOAuth: true  },
  // ── Automotive / car connectivity ────────────────────────────────────────────────────────────────────
  tesla:          { startUrl: 'https://auth.tesla.com/oauth2/v3/authorize',      signInUrl: 'https://auth.tesla.com/oauth2/v3/authorize',        authSuccessPattern: 'tesla.com/',                   isOAuth: true  },
  smartcar:       { startUrl: 'https://dashboard.smartcar.com',                  signInUrl: 'https://dashboard.smartcar.com/login',              authSuccessPattern: 'dashboard.smartcar.com/',      isOAuth: true  },
  ford:           { startUrl: 'https://fordpass.ford.com',                       signInUrl: 'https://fordpass.ford.com',                         authSuccessPattern: 'ford.com/',                    isOAuth: true  },
  bmw:            { startUrl: 'https://www.bmwconnecteddrive.com',               signInUrl: 'https://www.bmwconnecteddrive.com',                 authSuccessPattern: 'bmwconnecteddrive.com/',        isOAuth: true  },
  rivian:         { startUrl: 'https://rivian.com/account',                      signInUrl: 'https://rivian.com/account/sign-in',                authSuccessPattern: 'rivian.com/',                  isOAuth: true  },
  onstar:         { startUrl: 'https://my.onstar.com',                           signInUrl: 'https://my.onstar.com/account/login',               authSuccessPattern: 'my.onstar.com/',               isOAuth: true  },
  // ── Drone / aerial ──────────────────────────────────────────────────────────────────────────────────
  dji:            { startUrl: 'https://developer.dji.com',                       signInUrl: 'https://account.dji.com/login',                     authSuccessPattern: 'developer.dji.com/',           isOAuth: true  },
  dronedeploy:    { startUrl: 'https://www.dronedeploy.com/app2/',               signInUrl: 'https://www.dronedeploy.com/app2/login',            authSuccessPattern: 'dronedeploy.com/',             isOAuth: true  },
  skydio:         { startUrl: 'https://www.skydio.com/login',                    signInUrl: 'https://www.skydio.com/login',                      authSuccessPattern: 'skydio.com/',                  isOAuth: true  },
  autel:          { startUrl: 'https://passport.autelrobotics.com',              signInUrl: 'https://passport.autelrobotics.com',                authSuccessPattern: 'autelrobotics.com/',           isOAuth: true  },
  airmap:         { startUrl: 'https://app.airmap.com',                          signInUrl: 'https://app.airmap.com/login',                      authSuccessPattern: 'app.airmap.com/',              isOAuth: true  },
  dronelogbook:   { startUrl: 'https://dronelogbook.com',                        signInUrl: 'https://dronelogbook.com/login',                    authSuccessPattern: 'dronelogbook.com/',            isOAuth: true  },
  // ── Public reference / search / e-commerce (no auth required) ─────────────────────────────────────
  stackoverflow:  { startUrl: 'https://stackoverflow.com',                      authSuccessPattern: 'stackoverflow.com',            isOAuth: false },
  stackexchange:  { startUrl: 'https://stackexchange.com',                      authSuccessPattern: 'stackexchange.com',            isOAuth: false },
  wikipedia:      { startUrl: 'https://en.wikipedia.org',                       authSuccessPattern: 'wikipedia.org',                isOAuth: false },
  amazon:         { startUrl: 'https://www.amazon.com',                         authSuccessPattern: 'amazon.com',                   isOAuth: false },
  ebay:           { startUrl: 'https://www.ebay.com',                           authSuccessPattern: 'ebay.com',                     isOAuth: false },
  imdb:           { startUrl: 'https://www.imdb.com',                           authSuccessPattern: 'imdb.com',                     isOAuth: false },
  yelp:           { startUrl: 'https://www.yelp.com',                           authSuccessPattern: 'yelp.com',                     isOAuth: false },
  tripadvisor:    { startUrl: 'https://www.tripadvisor.com',                    authSuccessPattern: 'tripadvisor.com',              isOAuth: false },
  biblegateway:   { startUrl: 'https://www.biblegateway.com',                   authSuccessPattern: 'biblegateway.com',             isOAuth: false },
  duckduckgo:     { startUrl: 'https://duckduckgo.com',                         authSuccessPattern: 'duckduckgo.com',               isOAuth: false },
  bing:           { startUrl: 'https://www.bing.com',                           authSuccessPattern: 'bing.com',                     isOAuth: false },
  medium:         { startUrl: 'https://medium.com',                             authSuccessPattern: 'medium.com',                   isOAuth: false,
                   intentUrls: { content_create: 'https://medium.com/new-story' } },
  quora:          { startUrl: 'https://www.quora.com',                          authSuccessPattern: 'quora.com',                    isOAuth: false },
  hackernews:     { startUrl: 'https://news.ycombinator.com',                   authSuccessPattern: 'news.ycombinator.com',         isOAuth: false },
  arxiv:          { startUrl: 'https://arxiv.org',                              authSuccessPattern: 'arxiv.org',                    isOAuth: false },
  npm:            { startUrl: 'https://www.npmjs.com',                          authSuccessPattern: 'npmjs.com',                    isOAuth: false },
  pypi:           { startUrl: 'https://pypi.org',                               authSuccessPattern: 'pypi.org',                     isOAuth: false },
  craigslist:     { startUrl: 'https://www.craigslist.org',                     authSuccessPattern: 'craigslist.org',               isOAuth: false },
  zillow:         { startUrl: 'https://www.zillow.com',                         authSuccessPattern: 'zillow.com',                   isOAuth: false },
  weather:        { startUrl: 'https://weather.com',                            authSuccessPattern: 'weather.com',                  isOAuth: false },
  googlemaps:     { startUrl: 'https://www.google.com/maps',                    authSuccessPattern: 'google.com/maps',              isOAuth: false,
                   intentUrls: { maps: { buildUrl: (task, ctx) => ctx.dest ? `https://www.google.com/maps/search/${encodeURIComponent(ctx.dest)}` : null } } },
  // ── Services referenced by intent templates but missing from registry ───────────────────────────────
  applemaps:      { startUrl: 'https://maps.apple.com',                          authSuccessPattern: 'maps.apple.com',              isOAuth: false,
                   intentUrls: { maps: { buildUrl: (task, ctx) => ctx.dest ? `https://maps.apple.com/?q=${encodeURIComponent(ctx.dest)}` : null } } },
  calendly:       { startUrl: 'https://calendly.com',                           signInUrl: 'https://calendly.com/login',                       authSuccessPattern: 'calendly.com',                isOAuth: true,
                   intentUrls: { scheduling: 'https://calendly.com/events/new' } },
  youtubemusic:   { startUrl: 'https://music.youtube.com',                      authSuccessPattern: 'music.youtube.com',           isOAuth: false,
                   intentUrls: { media_play: { buildUrl: (task) => { const m = task.match(/(?:play|search)\s+(?:for\s+)?(.+)/i); return m ? `https://music.youtube.com/search?q=${encodeURIComponent(m[1].trim())}` : 'https://music.youtube.com'; } } } },
  applemusic:     { startUrl: 'https://music.apple.com',                        authSuccessPattern: 'music.apple.com',             isOAuth: false,
                   intentUrls: { media_play: 'https://music.apple.com' } },
  youtubekids:    { startUrl: 'https://www.youtubekids.com',                    authSuccessPattern: 'youtubekids.com',             isOAuth: false,
                   intentUrls: { media_play: 'https://www.youtubekids.com' } },
  w3schools:      { startUrl: 'https://www.w3schools.com',                      authSuccessPattern: 'w3schools.com',               isOAuth: false,
                   intentUrls: {
                     search: { buildUrl: (task, ctx) => `https://www.w3schools.com/search/search.asp?q=${ctx.encodedQuery}` },
                     docs: '/',
                   } },
};

function lookupBrowserService(service) {
  const key = (service || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const entry = KNOWN_BROWSER_SERVICES[key];
  if (!entry) return null;
  // All seed-map entries are browser-navigable services — inject default capabilities so that
  // deriveAgentType() returns 'browser' for any isOAuth:false entry without an explicit type.
  if (!entry.capabilities) return { ...entry, capabilities: ['navigate', 'interact'] };
  return entry;
}

/**
 * Seed appKnowledge with known intent→URL mappings from KNOWN_BROWSER_SERVICES.
 * Called when appKnowledge is empty for a hostname, so the first run benefits
 * from deterministic templates (e.g. googledocs.content_create → /document/create)
 * without needing prior verification. Entries start at confidence 0.8 and are
 * reinforced/decayed via recordVerification on subsequent runs.
 */
function _seedIntentUrlsFromKnownServices(hostname, serviceKey) {
  try {
    const svcEntry = lookupBrowserService(serviceKey);
    if (!svcEntry?.intentUrls) return;
    const { saveIntentUrl } = require('./lib/appKnowledge.cjs');
    let seeded = 0;
    for (const [intentKey, urlOrBuilder] of Object.entries(svcEntry.intentUrls)) {
      // intentUrls values can be strings or { buildUrl } functions; only seed strings
      if (typeof urlOrBuilder !== 'string') continue;
      saveIntentUrl(hostname, intentKey, urlOrBuilder);
      seeded++;
    }
    if (seeded > 0) {
      logger.info(`[browser.agent] app-knowledge: seeded ${seeded} intent_url entries for ${hostname} from KNOWN_BROWSER_SERVICES`);
    }
  } catch (_) { /* non-fatal */ }
}

// Check if currentHost is equivalent to expectedHost, considering configured host aliases.
// Aliases are normalized to hostnames only (no scheme/path). Only configured aliases may
// bypass cross-host rejection — redirects to unconfigured hosts are still treated as mismatches.
function isHostAlias(currentHost, expectedHost, aliases) {
  if (!currentHost || !expectedHost) return false;
  const ch = currentHost.toLowerCase();
  const eh = expectedHost.toLowerCase();
  if (ch === eh) return true;
  // Compare base domains (last two labels) as a baseline
  const cb = ch.split('.').slice(-2).join('.');
  const eb = eh.split('.').slice(-2).join('.');
  if (cb === eb) return true;
  // Check explicit aliases
  if (aliases && aliases.length > 0) {
    const aliasSet = new Set(aliases.map(a => a.toLowerCase()));
    if (aliasSet.has(ch) || aliasSet.has(eh)) return true;
    // Also check base-domain of aliases
    for (const a of aliasSet) {
      const ab = a.split('.').slice(-2).join('.');
      if (ab === cb || ab === eb) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auth-success pattern matching — alias-aware URL comparison.
// Parses each pattern as a URL; if it parses, compares hostname via isHostAlias
// and checks the path component as a substring. Falls back to literal substring
// for non-URL patterns (backward compatible).
// ---------------------------------------------------------------------------
function _authPatternMatches(href, pattern, hostAliases) {
  if (!href || !pattern) return false;
  const hrefLower = href.toLowerCase();

  // Try to parse both as URLs for hostname-aware comparison
  let hrefUrl, patternUrl;
  try { hrefUrl = new URL(href); } catch (_) { hrefUrl = null; }
  try { patternUrl = new URL(pattern.includes('://') ? pattern : `https://${pattern}`); } catch (_) { patternUrl = null; }

  if (hrefUrl && patternUrl) {
    const hrefHost = hrefUrl.hostname.replace(/^www\./, '');
    const patternHost = patternUrl.hostname.replace(/^www\./, '');
    if (isHostAlias(hrefHost, patternHost, hostAliases)) {
      // Host matches (or is an alias) — check path component as substring
      const patternPath = patternUrl.pathname || '/';
      const hrefPath = hrefUrl.pathname || '/';
      if (patternPath === '/' || hrefPath.includes(patternPath)) return true;
      // Also check the raw pattern string against the full href for cases like
      // "twitter.com/home" where the path is /home but pattern has no scheme
      if (hrefLower.includes(pattern)) return true;
    }
    return false;
  }

  // Fallback: literal substring (backward compatible for non-URL patterns)
  return hrefLower.includes(pattern);
}

// ---------------------------------------------------------------------------
// LLM-driven browser service meta resolution — for services not in seed map.
// Result cached in DuckDB so LLM is called at most once per service.
// ---------------------------------------------------------------------------

const BROWSER_DISCOVERY_SYSTEM_PROMPT = `You are a web service knowledge base. Given a service/product name, return structured JSON with exactly four fields.

Output ONLY valid JSON:
{
  "signInUrl": "<URL of the actual login/sign-in form — the page where the user types credentials or clicks OAuth. Set to null for isOAuth=false services.>",
  "startUrl": "<URL of the post-login dashboard or API key settings page>",
  "authSuccessPattern": "<URL substring that reliably appears AFTER successful login>",
  "isOAuth": true | false
}

CRITICAL rules:
- isOAuth=true means the service requires an OAuth browser session (social login, SSO, consent screen). isOAuth=false means the service uses an API key / token from a settings page.
- signInUrl MUST be the actual login form URL, NOT the dashboard. Example: Dropbox signInUrl=https://www.dropbox.com/login (NOT www.dropbox.com). If the service redirects to a separate identity provider (Google, Microsoft, Okta), use that IdP's login page URL.
- For isOAuth=false services, set signInUrl to null.
- startUrl is where the agent navigates AFTER login (dashboard, API keys page, etc.).
- Getting isOAuth or signInUrl wrong causes auth flow failures — the agent will navigate to the wrong page and loop forever.

FORBIDDEN — OAuth authorization endpoints:
- signInUrl must be a page that LOADS IN A BROWSER and shows a login form to the user.
- signInUrl must NEVER be an OAuth 2.0 authorization endpoint. Any URL containing these path segments is FORBIDDEN as signInUrl:
  /oauth2/auth, /oauth2/authorize, /o/oauth2/auth, /oauth/authorize, /connect/authorize
  These endpoints require client_id, redirect_uri, response_type, and scope parameters that the agent does not have. Navigating to them bare produces HTTP 400 errors.
- For services that delegate to a known identity provider (IdP), use the IdP's LOGIN PAGE, not its OAuth endpoint:
  Google:      https://accounts.google.com/signin/v2/identifier
  Microsoft:   https://login.live.com  (consumer) or https://login.microsoftonline.com (enterprise)
  Okta:        https://<tenant>.okta.com
  GitHub:      https://github.com/login
  Apple:       https://appleid.apple.com

FORBIDDEN — OAuth parameters as authSuccessPattern:
- authSuccessPattern must be a URL substring from the TARGET SERVICE's domain (e.g. "sheets.google.com", "mail.google.com", "app.slack.com/client").
- authSuccessPattern must NEVER be an OAuth redirect parameter such as "code=", "token=", "access_token=", "state=". These are query-string fragments that appear on the IdP's redirect, not on the target service's post-login URL.`;

// ---------------------------------------------------------------------------
// PLAYBOOK_SEED_MAP — battle-tested task playbooks for known services.
// Keys match the serviceKey (lowercase, alphanumeric only).
// Values are markdown strings using ONLY real action names.
// Available actions (full vocabulary):
//   INPUT:       fill (inputs), type (contenteditable), select (dropdowns),
//                check, uncheck, upload
//   INTERACTION: click, dblclick, hover, drag
//   KEYBOARD:    press, keydown, keyup
//   NAVIGATION:  navigate, go-back, reload, tab-new, tab-select, tab-close
//   OBSERVATION: snapshot (after every DOM change), screenshot, eval
//   EXTRACTION:  run-code (full page.evaluate)
//   DIALOGS:     dialog-accept, dialog-dismiss
//   SCROLL:      mousewheel (dx, dy)
//   RESULT:      return
// Each ### section header contains task keywords used by _resolvePlaybook() for matching.
// ---------------------------------------------------------------------------
const PLAYBOOK_SEED_MAP = {
  gmail: `### Compose & Send Email (compose, send, email, draft, write, message)
1. Navigate to compose URL: { "action": "navigate", "url": "https://mail.google.com/mail/u/0/#inbox?compose=new" }
2. Wait for compose window: { "action": "snapshot" }
3. Fill recipient — CHIP CONFIRMATION REQUIRED:
   { "action": "fill", "selector": "input[name='to'],textarea[name='to']", "text": "<recipient email>" }
   { "action": "press", "key": "Enter" }
   { "action": "snapshot" }
   RULE: After fill+Enter on To field, always snapshot. If the address is still in the input field (not converted to a chip/token), press Enter again and snapshot again before continuing to Subject.
4. Fill subject: { "action": "fill", "selector": "input[name='subjectbox']", "text": "<subject>" }
5. Click body to focus: { "action": "click", "selector": "div[aria-label='Message Body']" }
6. Type body text: { "action": "type", "text": "<body>" }
7. Safety snapshot before sending: { "action": "snapshot" }
8. Click Send with verification: { "action": "sendEmailWithVerification", "selector": "div[data-tooltip*='Send'],div[aria-label*='Send']" }

### Read Inbox (read, inbox, emails, messages, check, list, unread)
Extract up to 15 inbox rows using page.evaluate with Gmail's stable CSS selectors:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows=Array.from(document.querySelectorAll('tr.zA')).slice(0,5); if(!rows.length) return 'No emails found'; return rows.map((r,i)=>{ const s=r.querySelector('.yX span,.zF')?.innerText||''; const sub=r.querySelector('.bog,.bqe')?.innerText||''; const snip=r.querySelector('.y2')?.innerText||''; const t=r.querySelector('.xW span')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip+' | Time='+t; }).join('\\n'); }); }" }

### Search Emails (search, find, look for, from, subject, filter, count, unread)
IMPORTANT: Type directly into the main search input at the top of the page. DO NOT click "Show search options" or "Advanced search options" — it opens a dropdown that changes the DOM and breaks subsequent steps.
1. Click search box: { "action": "click", "selector": "input[aria-label*='Search']" }
2. Type query: { "action": "type", "text": "<search query>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Wait for results: { "action": "snapshot" }
5. Extract results: { "action": "getPageText" }`,

  outlook: `### Compose & Send Email (compose, send, email, draft, write, message)
1. Navigate to compose URL: { "action": "navigate", "url": "https://outlook.live.com/mail/0/deeplink/compose" }
2. Wait for compose: { "action": "snapshot" }
3. Fill recipient — press Enter to confirm chip:
   { "action": "fill", "selector": "div[aria-label='To']", "text": "<recipient>" }
   { "action": "press", "key": "Enter" }
   { "action": "snapshot" }
4. Fill subject: { "action": "fill", "selector": "input[aria-label='Subject']", "text": "<subject>" }
5. Click body: { "action": "click", "selector": "div[aria-label*='Message body']" }
6. Type body: { "action": "type", "text": "<body>" }
7. Click Send: { "action": "click", "selector": "button[aria-label='Send']" }

### Read Inbox (read, inbox, emails, check, list, unread)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const rows=Array.from(document.querySelectorAll('div[role=listitem]')).slice(0,5); return rows.map((r,i)=>{ const s=r.querySelector('.luvU6')?.innerText||''; const sub=r.querySelector('.nDYNg')?.innerText||''; const snip=r.querySelector('.SibTc')?.innerText||''; return 'Email '+(i+1)+': From='+s+' | Subject='+sub+' | Preview='+snip; }).join('\\n'); }); }" }`,

  notion: `### Create New Page (create, new page, add page, write)
1. Start on the new page directly: navigate to https://notion.new (Notion shortcut that creates a blank page in the Private section). If already on a Notion page editor with a blank title, skip navigation.
2. Wait for the page/editor to stabilise, then snapshot: { "action": "snapshot" }
3. Type the page title: { "action": "type", "text": "<page title>" }
4. Press Enter to move to the body: { "action": "press", "key": "Enter" }
5. For each todo item, create a checkbox — NEVER a bullet list. Use ONE of these methods per item:
   PREFERRED: { "action": "type", "text": "[]" } then { "action": "press", "key": "Space" } then type the todo item text, then { "action": "press", "key": "Enter" }
   ALTERNATIVE: { "action": "type", "text": "/todo" } then { "action": "press", "key": "Enter" }, wait briefly, then type the todo item text, then { "action": "press", "key": "Enter" }
   RULE: Do NOT type "- Item 1" or use "*"/"-" (that creates bullets, not checkboxes). Each todo must be created with [] (Space) or /todo.
   RULE: After creating each todo, take a snapshot to confirm a checkbox block appeared before typing the text. If a checkbox did not appear, retry with [] + Space.
   Repeat for each todo item.
6. Verify completion: { "action": "eval", "expression": "document.title" } — the title should be "<page title>".

### Search Workspace (search, find, look for, page)
1. Click search: { "action": "click", "selector": "div[aria-label='Search'],button[data-testid='search-button']" }
2. Fill search: { "action": "fill", "selector": "input[placeholder*='Search']", "text": "<query>" }
3. Snapshot results: { "action": "snapshot" }`,

  slack: `### Send Message to Channel (send, message, post, write, channel, dm, direct)
1. Navigate to channel (or use sidebar): { "action": "click", "selector": "a[data-qa*='channel_sidebar_name']" }
2. Click message composer: { "action": "click", "selector": "div[data-qa='message_input']" }
3. Type message: { "action": "type", "text": "<message>" }
4. Press Enter to send: { "action": "press", "key": "Enter" }

### Read Channel Messages (read, messages, check, latest, history)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('.c-message__body')).slice(-5); return msgs.map((m,i)=>'Msg '+(i+1)+': '+m.innerText).join('\\n'); }); }" }`,

  github: `### Navigate to Repository (navigate, open, go to, repo, repository)
1. Navigate directly: { "action": "navigate", "url": "https://github.com/<owner>/<repo>" }
2. Snapshot: { "action": "snapshot" }

### Create Issue (create, issue, bug, report, ticket, open issue)
1. Navigate to new issue: { "action": "navigate", "url": "https://github.com/<owner>/<repo>/issues/new" }
2. Fill title: { "action": "fill", "selector": "input#issue_title", "text": "<title>" }
3. Click body area: { "action": "click", "selector": "div.CodeMirror,textarea#issue_body" }
4. Type body: { "action": "type", "text": "<body>" }
5. Submit: { "action": "click", "selector": "button[data-disable-with*='Submitting']" }
NOTE: Prefer gh CLI for most GitHub operations — use browser only when CLI is unavailable.`,

  reddit: `### Submit Text Post (submit, post, create, write, share)
1. Navigate to submit: { "action": "navigate", "url": "https://www.reddit.com/r/<subreddit>/submit" }
2. Click Text tab: { "action": "click", "selector": "button[id*='post-type-link-text'],button[aria-label='Text']" }
3. Fill title: { "action": "fill", "selector": "textarea[placeholder='Title']", "text": "<title>" }
4. Click body editor: { "action": "click", "selector": "div.public-DraftEditor-content,div[contenteditable=true]" }
5. Type body: { "action": "type", "text": "<body>" }
6. Submit: { "action": "click", "selector": "button[data-testid='submit-button'],button:has-text('Post')" }

### Read Feed / Posts (read, feed, posts, subreddit, list, browse)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const posts=Array.from(document.querySelectorAll('article,shreddit-post')).slice(0,5); return posts.map((p,i)=>{ const t=p.querySelector('a[slot=full-post-link],[data-testid=post-title]')?.innerText||''; return 'Post '+(i+1)+': '+t; }).join('\\n'); }); }" }`,

  todoist: `### Add Task (add, create, task, todo, reminder, new task)
1. Click add task: { "action": "click", "selector": "button[data-testid='add-task-button'],button[aria-label*='Add task']" }
2. Snapshot: { "action": "snapshot" }
3. Fill task name: { "action": "fill", "selector": "div[aria-label='Task name'],input[data-testid='task-editor-field']", "text": "<task name>" }
4. Press Enter to save: { "action": "press", "key": "Enter" }

### List Tasks (list, tasks, show, view, today)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { return Array.from(document.querySelectorAll('.task_content,[data-testid=task-content]')).map((t,i)=>'Task '+(i+1)+': '+t.innerText).join('\\n'); }); }" }`,

  twitter: `### Compose Tweet (tweet, post, write, share, compose)
1. Navigate to compose URL: { "action": "navigate", "url": "https://x.com/compose/post" }
2. Snapshot: { "action": "snapshot" }
3. Click tweet textarea: { "action": "click", "selector": "div[data-testid='tweetTextarea_0']" }
4. Type tweet: { "action": "type", "text": "<tweet text>" }
5. Submit: { "action": "click", "selector": "button[data-testid='tweetButton'],button[data-testid='tweetButtonInline']" }

### Read Timeline / Feed (read, timeline, feed, tweets, posts)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const tweets=Array.from(document.querySelectorAll('article[data-testid=tweet]')).slice(0,5); return tweets.map((t,i)=>{ const u=t.querySelector('div[data-testid=User-Name]')?.innerText||''; const body=t.querySelector('div[data-testid=tweetText]')?.innerText||''; return 'Tweet '+(i+1)+': '+u+' → '+body; }).join('\\n'); }); }" }`,

  chatgpt: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate, write, help)
1. Click prompt input: { "action": "click", "selector": "div#prompt-textarea,div[contenteditable][data-id]" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter to submit: { "action": "press", "key": "Enter" }
4. Snapshot to wait for response to begin: { "action": "snapshot" }
5. Extract last assistant response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('[data-message-author-role=assistant]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  claude: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate, write, help)
1. Click input area: { "action": "click", "selector": "div.ProseMirror[contenteditable=true],div[data-testid='chat-input']" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('[data-testid=assistant-message],[data-is-streaming=false]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  grok: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate)
1. Click input: { "action": "click", "selector": "textarea[placeholder*='Ask'],div[contenteditable=true]" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('.response-content,.message-content,[data-message-role=assistant]')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  gemini: `### Submit Prompt & Read Response (ask, prompt, query, chat, generate)
1. Click input: { "action": "click", "selector": "div[contenteditable=true][aria-label*='Enter'],div.ql-editor" }
2. Type prompt: { "action": "type", "text": "<prompt>" }
3. Press Enter: { "action": "press", "key": "Enter" }
4. Snapshot: { "action": "snapshot" }
5. Extract response:
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { const msgs=Array.from(document.querySelectorAll('model-response,message-content')); return msgs[msgs.length-1]?.innerText||'Response not yet loaded'; }); }" }`,

  youtube: `### Search Videos (search, find, lookup, video, sourdough, tutorial, how to)
1. Navigate directly to search results: { "action": "navigate", "url": "https://www.youtube.com/results?search_query=<encoded_query>" }
2. Wait for results to load: { "action": "waitForStableText" }
3. Read search results: { "action": "getPageText" }
4. Extract video links: { "action": "getPageLinks" }
NOTE: Use /results?search_query= URL directly — it is more reliable than click+fill+Enter (avoids autocomplete dropdown timing issues). Encode spaces as + in the query.

### Watch Video (watch, play, view, open, specific video)
1. Navigate to video URL: { "action": "navigate", "url": "<video_url>" }
2. Wait for page to load: { "action": "waitForStableText" }
3. Read video page content: { "action": "getPageText" }
4. Extract video metadata and links: { "action": "getPageLinks" }

### Extract Video Content (watch and tell me about it, tell me about, tell me what, describe it, describe the video, explain it, give me a summary, watch and summarize, extract, steps, transcript, tutorial, learn, summarize, content, analyze)
DELEGATE_TO: video.agent
PLATFORM: youtube
INSTRUCTION: Use video.agent to find and watch tutorial videos, extracting actionable steps and content via page metadata + audio transcription.

### Browse Feed / Subscriptions (subscriptions, feed, home, browse, latest)
1. Navigate to YouTube feed: { "action": "navigate", "url": "https://www.youtube.com/feed/subscriptions" }
2. Wait for feed to load: { "action": "waitForStableText" }
3. Read feed content: { "action": "getPageText" }`,
};

// ---------------------------------------------------------------------------
// PLAYBOOK_BUILD_PROMPT — LLM prompt for generating playbooks for unknown
// services at build time. Fires once, cached in DuckDB. ~600 tokens output.
// ---------------------------------------------------------------------------
const PLAYBOOK_BUILD_PROMPT = `You are a browser automation expert. Generate step-by-step playbooks for automating a web service using the Playwright Node API.

URL-FIRST RULE: Prefer direct navigation when the service provides a known URL for the action. If a deepLinkUrl is provided in the agent context, use it as the first navigate step. Only fall back to clicks for navigation when no direct URL is known.

You MUST use ONLY these action names in your steps (no others):

INPUT
  fill        — { "action": "fill", "selector": "...", "text": "..." }           — standard <input> / <textarea>
  type        — { "action": "type", "text": "..." }                              — contenteditable / rich-text (no selector)
  select      — { "action": "select", "selector": "...", "value": "..." }        — <select> dropdowns
  check       — { "action": "check", "selector": "..." }                         — checkboxes / radio buttons
  uncheck     — { "action": "uncheck", "selector": "..." }                       — uncheck a checkbox
  upload      — { "action": "upload", "selector": "...", "files": ["/abs/path"] } — attach file(s): clicks selector to open the chooser, then uses engine file chooser for each file. selector = attach button ref from snapshot; files = absolute local file paths array.

DOM INTERACTION
  click       — { "action": "click", "selector": "..." }
  dblclick    — { "action": "dblclick", "selector": "..." }                      — double-click (inline edit, expand)
  hover       — { "action": "hover", "selector": "..." }                         — reveal hover menus / tooltips
  drag        — { "action": "drag", "startSelector": "...", "endSelector": "..." } — drag-and-drop

KEYBOARD
  press       — { "action": "press", "key": "Enter" }                            — Enter, Escape, Tab, ArrowDown, etc.
  keydown     — { "action": "keydown", "key": "Shift" }                          — hold modifier before click
  keyup       — { "action": "keyup", "key": "Shift" }                            — release modifier

NAVIGATION
  navigate    — { "action": "navigate", "url": "..." }
  go-back     — { "action": "go-back" }                                          — browser back
  reload      — { "action": "reload" }                                           — reload current page
  tab-new     — { "action": "tab-new", "url": "..." }                            — open new tab
  tab-select  — { "action": "tab-select", "index": 0 }                           — switch tab
  tab-close   — { "action": "tab-close", "index": 0 }                            — close tab

OBSERVATION  (ALWAYS snapshot after any DOM change before the next action)
  snapshot          — { "action": "snapshot" }                                         — re-reads live DOM / ARIA tree
  screenshot        — { "action": "screenshot" }                                       — capture visual screenshot
  eval              — { "action": "eval", "expression": "document.title" }             — lightweight JS (no page.evaluate wrapper)
  waitForStableText — { "action": "waitForStableText" }                                — wait until page text stops changing (use after navigate on dynamic/JS-rendered pages, after search, after pressing Enter)
  getPageText       — { "action": "getPageText" }                                      — read all visible page text as plain string (use after waitForStableText to capture search results, listings, or content)

DATA EXTRACTION
  run-code    — { "action": "run-code", "code": "async page => { return await page.evaluate(() => ...) }" }

CONTENT EXTRACTION RULE: For any playbook that navigates to a search results page or a dynamic content page, ALWAYS end with { "action": "waitForStableText" } followed by { "action": "getPageText" } so the results are captured and returned to the user. Without getPageText, the task result will be empty.

DIALOGS
  dialog-accept  — { "action": "dialog-accept" }                                 — confirm / OK dialogs
  dialog-dismiss — { "action": "dialog-dismiss" }                                — cancel / dismiss dialogs

SCROLL
  mousewheel  — { "action": "mousewheel", "dx": 0, "dy": 500 }                  — scroll down (positive dy); up (negative dy)

RESULT
  return      — { "action": "return", "data": "..." }                            — emit final result

Generate 2-4 playbooks covering the most common tasks for this service.
Format each playbook as a ### section with task keywords in parentheses in the header.

Example format:
### Send Message (send, message, post, write)
1. Navigate to compose URL: { "action": "navigate", "url": "https://<service>/compose" }
2. Wait for page load: { "action": "snapshot" }
3. Fill recipient: { "action": "fill", "selector": "input[placeholder='To']", "text": "<recipient>" }
4. Type body: { "action": "type", "text": "<message>" }
5. Click Send: { "action": "click", "selector": "button:has-text('Send')" }

### Read Messages (read, messages, inbox, check)
{ "action": "run-code", "code": "async page => { return await page.evaluate(() => { return Array.from(document.querySelectorAll('.message')).slice(0,5).map(m=>m.innerText).join('\\n'); }); }" }

IMPORTANT:
- Prefer navigate to a direct URL as the first step when a deepLinkUrl is provided or the service has a known URL for the action. Only use click to navigate when no direct URL is known.
- Use CSS attribute selectors and ARIA labels — they are more stable than class names
- For form fields that create chips/tokens (like email To fields), always fill + press Enter + snapshot before continuing
- For contenteditable rich-text areas use type, not fill
- After hover/dblclick/click that opens a menu or modal, always snapshot before the next action
- Keep selectors as generic/semantic as possible since you don't have a live DOM
- Output ONLY the ### playbook sections — no preamble, no explanation`;

// ---------------------------------------------------------------------------
// PLAYBOOK_RUNTIME_COT_PROMPT — LLM prompt for generating a single playbook
// for a novel goal at runtime (Chain-of-Thought with few-shot examples).
// Output is one ### section; appended to descriptor for future reuse.
// ---------------------------------------------------------------------------
const PLAYBOOK_RUNTIME_COT_PROMPT = `You are a browser automation expert. A user wants to accomplish a specific goal on a web service.

You will receive:
- SERVICE: the service name
- START_URL: the service's base URL
- GOAL: what the user wants to accomplish
- EXISTING_PLAYBOOKS: 1-2 example playbooks for OTHER tasks on this service (use these as FORMAT REFERENCES only)
- EXECUTION_RESULT (optional): what the agent actually observed/did when it ran this goal successfully.
  If present, use it to ground your selectors and steps — it reflects the real DOM.

Your job: generate ONE new playbook for the GOAL using the exact same format and action vocabulary as the examples.

You MUST use ONLY these action names (full action vocabulary):
  INPUT:       fill (inputs), type (contenteditable), select (dropdowns), check, uncheck, upload
  INTERACTION: click, dblclick, hover, drag
  KEYBOARD:    press, keydown, keyup
  NAVIGATION:  navigate, go-back, reload, tab-new, tab-select, tab-close
  OBSERVATION: snapshot (after EVERY DOM change), screenshot, eval
  EXTRACTION:  run-code (async page => { return await page.evaluate(() => ...) })
  DIALOGS:     dialog-accept, dialog-dismiss
  SCROLL:      mousewheel (dx, dy)
  RESULT:      return

Chain-of-thought approach:
1. What page/view does this goal start from?
2. Is there a direct URL for this goal? If a deepLinkUrl is provided, start with { "action": "navigate", "url": "..." } to that URL.
3. Does the DOM change after that action? If yes → snapshot.
4. What fields need filling? Use fill for <input>/<textarea>, type for contenteditable.
5. Are there chip/token confirmation steps? Fill + press Enter + snapshot + verify chip exists.
6. Does the task involve drag, scroll-to-load, multi-select, or dialog confirmation?
7. What is the final action (submit, press Enter, click Save)?
8. Does the goal require reading data back? If yes → run-code with page.evaluate.

Format your response as a single ### section:
### <Task Name> (<keyword1>, <keyword2>, <keyword3>)
<numbered steps or single run-code block>

IMPORTANT:
- The ### header keywords are used for future matching — make them comprehensive and relevant
- Do NOT repeat steps from the existing playbooks — generate only what GOAL requires
- Prefer URL-first navigation over DOM clicks when a deepLinkUrl is provided or the service has a known URL for the action
- Output ONLY the ### section — no preamble, no explanation`;

// ---------------------------------------------------------------------------
// _resolvePlaybook — 3-tier goal-aware playbook selection.
// Returns: { tier, section, subsections }
//   tier 1: keyword match found     — section = matched ### block
//   tier 3: no match                — section = null, subsections = all ### blocks (for COT)
// ---------------------------------------------------------------------------
function _resolvePlaybook(descriptor, task, agentId) {
  if (!descriptor || !task) return { tier: 3, section: null, subsections: [] };

  // No `m` flag — `$` must match end-of-string to capture the full Playbooks block
  const playbookMatch = descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
  if (!playbookMatch) return { tier: 3, section: null, subsections: [] };

  const playbookBody = playbookMatch[1].trim();
  // Split into ### subsections, keeping the header with each block
  const subsections = playbookBody.split(/(?=### )/).map(s => s.trim()).filter(Boolean);
  if (subsections.length === 0) return { tier: 3, section: null, subsections: [] };

  const taskLower = task.toLowerCase();
  const matched = [];
  for (const sub of subsections) {
    const headerLine = sub.split('\n')[0]; // e.g. "### Compose & Send Email (compose, send, email, ...)"
    // Extract keywords from parentheses in header, plus individual words from the header title
    const parenMatch = headerLine.match(/\(([^)]+)\)/);
    const keywords   = parenMatch
      ? parenMatch[1].split(',').map(k => k.trim().toLowerCase())
      : headerLine.replace(/^###\s*/, '').toLowerCase().split(/\W+/).filter(k => k.length > 3);

    if (keywords.some(kw => kw && taskLower.includes(kw))) {
      matched.push(sub);
    }
  }

  if (matched.length > 0) {
    const isMutationTask = /\b(create|add|write|send|post|publish|upload|schedule|book|buy|delete|update)\b/i.test(task);
    return { tier: 1, section: isMutationTask ? matched[0] : matched.join('\n\n'), subsections };
  }

  return { tier: 3, section: null, subsections };
}

// ---------------------------------------------------------------------------
// _isPureSearchTask — true when the task is just a search/lookup and does not
// ask to watch, play, summarize, extract, or otherwise consume a video.
// ---------------------------------------------------------------------------
function _isPureSearchTask(task) {
  if (!task) return false;
  const t = task.toLowerCase();
  // Must be a search/lookup request
  const hasSearchVerb = /\b(search|find|look up|lookup)\b/.test(t);
  if (!hasSearchVerb) return false;
  // Must NOT ask for video consumption/extraction/analysis
  const videoExtraction = /\b(watch|play|view|open|summarize|summarise|extract|describe|explain|analyze|analyse|learn from|transcript|steps|content)\b/.test(t);
  if (videoExtraction) return false;
  return true;
}

// ---------------------------------------------------------------------------
// _cosineSim — dot-product cosine similarity between two equal-length vectors.
// ---------------------------------------------------------------------------
function _cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// _resolvePlaybookSemantic — semantic embedding-based playbook selection.
// Calls /memory.embed on the user-memory service (port 3001) to get vectors
// for the task + all playbook headers, computes cosine similarity in-process,
// and returns the best-matching section(s).
// Falls back to keyword-based _resolvePlaybook() if the embedding service is
// unreachable or returns no results.
// ---------------------------------------------------------------------------
const _MEMORY_EMBED_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const _MEMORY_EMBED_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const _MEMORY_EMBED_KEY  = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

async function _resolvePlaybookSemantic(agentId, descriptor, task) {
  if (!descriptor || !task) return _resolvePlaybook(descriptor, task, agentId);

  // Sanitize: strip DELEGATE_TO: video.agent playbook blocks from non-video agents.
  // This cleans up descriptors that were polluted by old LLM prompts without a DB migration.
  const _serviceKey = (agentId || '').replace('.agent', '').toLowerCase();
  if (!VIDEO_PLATFORMS.has(_serviceKey) && descriptor.includes('DELEGATE_TO: video.agent')) {
    descriptor = descriptor
      .split(/(?=\n### )/)
      .filter(block => !block.includes('DELEGATE_TO: video.agent'))
      .join('');
    logger.debug(`[browser.agent] _resolvePlaybookSemantic: stripped video.agent DELEGATE_TO from non-video descriptor for ${agentId}`);
  }

  const playbookMatch = descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
  if (!playbookMatch) return _resolvePlaybook(descriptor, task, agentId);

  const subsections = playbookMatch[1].trim()
    .split(/(?=### )/).map(s => s.trim()).filter(Boolean);
  if (subsections.length === 0) return _resolvePlaybook(descriptor, task, agentId);

  const headers = subsections.map(s => s.split('\n')[0]);

  try {
    const body = JSON.stringify({
      version: 'mcp.v1',
      requestId: `embed_${Date.now()}`,
      action: 'memory.embed',
      payload: { texts: [task, ...headers] },
    });

    const embedResult = await new Promise((resolve) => {
      const req = http.request({
        hostname: _MEMORY_EMBED_HOST,
        port: _MEMORY_EMBED_PORT,
        path: '/memory.embed',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${_MEMORY_EMBED_KEY}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(5000, () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    const vectors = embedResult?.result?.embeddings || embedResult?.embeddings;
    if (!Array.isArray(vectors) || vectors.length < 2) {
      return _resolvePlaybook(descriptor, task, agentId);
    }

    const [taskVec, ...headerVecs] = vectors;

    const scored = headers.map((h, i) => ({
      score:         _cosineSim(taskVec, headerVecs[i] || []),
      section:       subsections[i],
      hasDelegation: subsections[i].includes('DELEGATE_TO:'),
    })).sort((a, b) => b.score - a.score);

    logger.info(`[browser.agent] _resolvePlaybookSemantic: top scores for ${agentId} — ${scored.slice(0, 3).map(s => `"${s.section.split('\n')[0].slice(0, 50)}" (${s.score.toFixed(3)})`).join(', ')}`);

    // Delegate only if the best-scoring DELEGATE_TO playbook is for a video platform
    const delegateMatch = scored.find(s => s.hasDelegation && s.score >= 0.30);
    if (delegateMatch) {
      const _delegatePlatform = (delegateMatch.section.match(/PLATFORM:\s*(\S+)/) || [])[1] || '';
      const _serviceKey = (agentId || '').replace('.agent', '').toLowerCase();
      if (VIDEO_PLATFORMS.has(_delegatePlatform.toLowerCase()) || VIDEO_PLATFORMS.has(_serviceKey)) {
        logger.info(`[browser.agent] _resolvePlaybookSemantic: delegation match → "${delegateMatch.section.split('\n')[0]}" (score=${delegateMatch.score.toFixed(3)})`);
        return { tier: 1, section: delegateMatch.section, subsections };
      }
      logger.info(`[browser.agent] _resolvePlaybookSemantic: ignored DELEGATE_TO for non-video agent ${agentId} (score=${delegateMatch.score.toFixed(3)})`);
    }

    // Collect all sections above threshold (compound tasks get multiple sections)
    const matched = scored.filter(s => s.score >= 0.35).map(s => s.section);
    if (matched.length > 0) {
      const isMutationTask = /\b(create|add|write|send|post|publish|upload|schedule|book|buy|delete|update)\b/i.test(task);
      return { tier: 1, section: isMutationTask ? matched[0] : matched.join('\n\n'), subsections };
    }

    return { tier: 3, section: null, subsections };

  } catch (_semErr) {
    logger.warn(`[browser.agent] _resolvePlaybookSemantic: embedding call failed (${_semErr.message}) — falling back to keyword scan`);
    return _resolvePlaybook(descriptor, task, agentId);
  }
}

// ---------------------------------------------------------------------------
// _generateAndCachePlaybook — COT runtime playbook generation.
// Generates one ### section for a novel goal, appends to descriptor in DuckDB + disk.
// Non-blocking write-back; returns the generated section (or null on failure).
// ---------------------------------------------------------------------------
async function _generateAndCachePlaybook(agentId, descriptor, task, subsections, executionResult) {
  try {
    // Pick up to 2 shortest subsections as few-shot examples
    const examples = [...subsections]
      .sort((a, b) => a.length - b.length)
      .slice(0, 2)
      .join('\n\n');

    // Extract startUrl from descriptor frontmatter
    const urlLine  = (descriptor || '').split('\n').find(l => l.startsWith('start_url:'));
    const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : '';
    const serviceLine = (descriptor || '').split('\n').find(l => l.startsWith('service:'));
    const service  = serviceLine ? serviceLine.replace('service:', '').trim() : agentId;

    // If we have a real execution result (post-execution write-back path), include it as
    // grounding context. The LLM can generate selectors from what the agent actually observed.
    const resultCtx = executionResult
      ? `\n\nEXECUTION_RESULT (what the agent observed/did successfully):\n${String(executionResult).slice(0, 800)}`
      : '';

    const userQuery = `SERVICE: ${service}\nSTART_URL: ${startUrl}\nGOAL: ${task}\n\nEXISTING_PLAYBOOKS:\n${examples}${resultCtx}`;
    const raw = await callLLM(PLAYBOOK_RUNTIME_COT_PROMPT, userQuery, { temperature: 0.2, maxTokens: 500 });
    if (!raw || !raw.includes('###')) return null;

    // Extract the ### block
    const sectionMatch = raw.match(/(###[\s\S]+)/);
    if (!sectionMatch) return null;
    const newSection = sectionMatch[1].trim();

    // Append to descriptor — fire-and-forget write-back (non-blocking for caller)
    setImmediate(async () => {
      try {
        let updatedDescriptor;
        if (descriptor.includes('\n## Playbooks\n')) {
          updatedDescriptor = descriptor.trimEnd() + '\n\n' + newSection;
        } else {
          updatedDescriptor = descriptor.trimEnd() + '\n\n## Playbooks\n' + newSection;
        }
        const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
        fs.writeFileSync(mdPath, updatedDescriptor, 'utf8');
        await withDb(async (db) => {
          await db.run('UPDATE agents SET descriptor = ? WHERE id = ?', updatedDescriptor, agentId);
        });
        logger.info(`[browser.agent] _generateAndCachePlaybook: cached new playbook for ${agentId} — goal="${task}"`);
      } catch (writeErr) {
        logger.warn(`[browser.agent] _generateAndCachePlaybook: write-back failed for ${agentId}: ${writeErr.message}`);
      }
    });

    return newSection;
  } catch (err) {
    logger.warn(`[browser.agent] _generateAndCachePlaybook: LLM error for ${agentId}: ${err.message}`);
    return null;
  }
}

// ── Browser meta sanitization helpers ──────────────────────────────────────────
// Applied to ALL resolveBrowserMeta return paths so cached/seed/LLM values are
// always checked for bare OAuth endpoints and OAuth-parameter authSuccessPattern.
const OAUTH_ENDPOINT_RE = /\/(o\/)?oauth2?\/(auth|authorize)|\/connect\/authorize/i;
const IDP_LOGIN_MAP = {
  'accounts.google.com': 'https://accounts.google.com/signin/v2/identifier',
  'login.microsoftonline.com': 'https://login.microsoftonline.com',
  'login.live.com': 'https://login.live.com',
  'github.com': 'https://github.com/login',
  'appleid.apple.com': 'https://appleid.apple.com',
};

function _sanitizeBrowserMeta(meta, service) {
  if (!meta) return meta;

  // Fix bare OAuth authorization endpoints in signInUrl
  if (meta.signInUrl && OAUTH_ENDPOINT_RE.test(meta.signInUrl)) {
    const badUrl = meta.signInUrl;
    logger.warn(`[browser.agent] _sanitizeBrowserMeta: detected bare OAuth endpoint as signInUrl for "${service}": ${badUrl}`);
    let fixed = false;
    try {
      const idpHost = new URL(badUrl).hostname;
      if (IDP_LOGIN_MAP[idpHost]) {
        meta.signInUrl = IDP_LOGIN_MAP[idpHost];
        fixed = true;
        logger.info(`[browser.agent] _sanitizeBrowserMeta: mapped IdP "${idpHost}" → ${meta.signInUrl}`);
      }
    } catch {}
    if (!fixed) {
      meta.signInUrl = meta.startUrl || null;
      logger.warn(`[browser.agent] _sanitizeBrowserMeta: could not fix OAuth endpoint — falling back to startUrl: ${meta.signInUrl}`);
    }
  }

  // Fix OAuth redirect parameters in authSuccessPattern
  if (meta.authSuccessPattern && /^(code|token|access_token|state)=/i.test(meta.authSuccessPattern)) {
    const badPattern = meta.authSuccessPattern;
    logger.warn(`[browser.agent] _sanitizeBrowserMeta: detected OAuth parameter as authSuccessPattern for "${service}": ${badPattern}`);
    try {
      const startHost = new URL(meta.startUrl).hostname;
      meta.authSuccessPattern = startHost;
      logger.info(`[browser.agent] _sanitizeBrowserMeta: replaced authSuccessPattern with startUrl hostname: ${startHost}`);
    } catch {
      const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');
      meta.authSuccessPattern = seedKey;
      logger.info(`[browser.agent] _sanitizeBrowserMeta: replaced authSuccessPattern with serviceKey: ${seedKey}`);
    }
  }

  return meta;
}

async function resolveBrowserMeta(service) {
  const seedKey = service.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. DuckDB agent descriptor — highest priority (validate_agent writes corrections here).
  //    Extract startUrl and signInUrl from the stored descriptor frontmatter so any
  //    URL corrections validate_agent made are immediately visible to callers.
  try {
    const agentResult = await withDb(async (db) => {
      const rows = await db.all(
        'SELECT descriptor, capabilities FROM agents WHERE id = ?', `${seedKey}.agent`
      ).catch(() => null);
      if (rows && rows.length > 0 && rows[0].descriptor) {
        const desc = rows[0].descriptor;
        const startUrl  = extractDescriptorUrl(desc, 'start_url');
        const signInUrl = extractDescriptorUrl(desc, 'sign_in_url');
        const authSuccessPattern = extractDescriptorUrl(desc, 'auth_success_pattern');
        const hostAliasesDesc = extractDescriptorUrl(desc, 'host_aliases');
        if (startUrl) {
          const seed = KNOWN_BROWSER_SERVICES[seedKey] || {};
          const isOAuthFromDesc = /^is_oauth:\s*true/m.test(desc);
          const hostAliases = hostAliasesDesc
            ? hostAliasesDesc.split(',').map(h => h.trim()).filter(Boolean)
            : (seed.hostAliases || undefined);
          return {
            ...seed,
            startUrl,
            ...(signInUrl ? { signInUrl } : {}),
            authSuccessPattern: authSuccessPattern || seed.authSuccessPattern || seedKey,
            ...(hostAliases && hostAliases.length > 0 ? { hostAliases } : {}),
            ...(isOAuthFromDesc ? { isOAuth: true } : {}),
          };
        }
      }
      return null;
    });
    if (agentResult) return _sanitizeBrowserMeta(agentResult, service);
  } catch {}

  // 2. DuckDB meta cache (LLM discovery result cached here for unknown services)
  try {
    const cachedMeta = await withDb(async (db) => {
      const rows = await db.all(
        "SELECT meta_json FROM browser_meta_cache WHERE service = ?", seedKey
      ).catch(() => null);
      if (rows && rows.length > 0) {
        try { return JSON.parse(rows[0].meta_json); } catch {}
      }
      return null;
    });
    if (cachedMeta) return _sanitizeBrowserMeta(cachedMeta, service);
  } catch {}

  // 3. Seed map — bootstrap fallback only (cold-start before any agent has been built)
  const fromSeed = KNOWN_BROWSER_SERVICES[seedKey];
  if (fromSeed) return _sanitizeBrowserMeta(fromSeed, service);

  // 4. LLM discovery with web_search grounding
  logger.info(`[browser.agent] resolveBrowserMeta: LLM lookup for "${service}"`);

  // 4a. web_search grounding (non-blocking, 5s cap) — gives LLM real signal about auth type
  let searchSnippets = '';
  try {
    searchSnippets = await Promise.race([
      agentWebSearch(`${service} sign in login page URL site`),
      new Promise(r => setTimeout(() => r(''), 5000))
    ]);
  } catch {}

  // 4b. Keyword heuristic vote — OAuth vs API key based on search snippet text
  const snippetLower = (searchSnippets || '').toLowerCase();
  const oauthKeywords  = ['oauth', 'sign in with', 'sso', 'openid connect', 'social login'];
  const apikeyKeywords = ['api key', 'api token', 'bearer token', '/settings/api', 'access token', 'secret key'];
  const votesOAuth   = oauthKeywords.filter(kw => snippetLower.includes(kw)).length;
  const votesApiKey  = apikeyKeywords.filter(kw => snippetLower.includes(kw)).length;

  // 4c. Grounded LLM call — search snippets injected as context when available
  const groundedQuery = searchSnippets
    ? `Web search results:\n${searchSnippets.slice(0, 800)}\n\nService: ${service}`
    : `Service: ${service}`;
  const raw = await callLLM(
    BROWSER_DISCOVERY_SYSTEM_PROMPT,
    groundedQuery,
    { temperature: 0.1, maxTokens: 300 }
  );

  let meta = null;
  if (raw) {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) meta = JSON.parse(match[0]);
    } catch {}
  }

  // 4d. Cross-validate isOAuth: trust keyword heuristic over LLM when they conflict
  if (meta && searchSnippets && (votesOAuth > 0 || votesApiKey > 0)) {
    const heuristicSaysApiKey = votesApiKey > votesOAuth;
    const heuristicSaysOAuth  = votesOAuth  > votesApiKey;
    if (heuristicSaysApiKey && meta.isOAuth === true) {
      meta.isOAuth = false;
      logger.warn(`[browser.agent] isOAuth conflict for "${service}": LLM=true but search suggests api_key → correcting to false`);
    } else if (heuristicSaysOAuth && meta.isOAuth === false) {
      meta.isOAuth = true;
      logger.warn(`[browser.agent] isOAuth conflict for "${service}": LLM=false but search suggests OAuth → correcting to true`);
    }
  }

  // 4e. Post-discovery validation guard — reject bare OAuth authorization endpoints
  // The LLM sometimes returns /o/oauth2/auth or /oauth2/authorize as signInUrl.
  // _sanitizeBrowserMeta handles IdP mapping and authSuccessPattern fix.
  // For LLM output, we also try a correction re-prompt before falling back to startUrl.
  if (meta && meta.signInUrl && OAUTH_ENDPOINT_RE.test(meta.signInUrl)) {
    const badUrl = meta.signInUrl;
    logger.warn(`[browser.agent] resolveBrowserMeta: detected bare OAuth endpoint as signInUrl for "${service}": ${badUrl}`);

    // Step 1: Try deterministic IdP login page mapping (from _sanitizeBrowserMeta's map)
    let fixed = false;
    try {
      const idpHost = new URL(badUrl).hostname;
      if (IDP_LOGIN_MAP[idpHost]) {
        meta.signInUrl = IDP_LOGIN_MAP[idpHost];
        fixed = true;
        logger.info(`[browser.agent] resolveBrowserMeta: mapped IdP "${idpHost}" → ${meta.signInUrl}`);
      }
    } catch {}

    // Step 2: LLM re-prompt with correction instruction
    if (!fixed) {
      try {
        const correctionQuery = `${groundedQuery}\n\nCORRECTION: The signInUrl you returned ("${badUrl}") is an OAuth authorization endpoint that requires client parameters (client_id, redirect_uri, response_type). It CANNOT be used as a login page. Return the actual login PAGE URL — the page where a user types their email/password in a browser. For Google services use https://accounts.google.com/signin/v2/identifier. Try again.`;
        const retryRaw = await callLLM(
          BROWSER_DISCOVERY_SYSTEM_PROMPT,
          correctionQuery,
          { temperature: 0.1, maxTokens: 300 }
        );
        if (retryRaw) {
          const retryMatch = retryRaw.match(/\{[\s\S]*\}/);
          if (retryMatch) {
            const retryMeta = JSON.parse(retryMatch[0]);
            if (retryMeta.signInUrl && !OAUTH_ENDPOINT_RE.test(retryMeta.signInUrl)) {
              meta.signInUrl = retryMeta.signInUrl;
              fixed = true;
              logger.info(`[browser.agent] resolveBrowserMeta: LLM re-prompt corrected signInUrl → ${meta.signInUrl}`);
            }
          }
        }
      } catch (retryErr) {
        logger.warn(`[browser.agent] resolveBrowserMeta: LLM re-prompt failed: ${retryErr.message}`);
      }
    }

    // Step 3: Fall back to startUrl — the service itself will redirect to its IdP login page
    if (!fixed) {
      meta.signInUrl = meta.startUrl || null;
      logger.warn(`[browser.agent] resolveBrowserMeta: could not fix OAuth endpoint — falling back to startUrl as signInUrl: ${meta.signInUrl}`);
    }
  }

  // 4f. Validate authSuccessPattern — reject OAuth redirect parameters
  if (meta && meta.authSuccessPattern && /^(code|token|access_token|state)=/i.test(meta.authSuccessPattern)) {
    const badPattern = meta.authSuccessPattern;
    logger.warn(`[browser.agent] resolveBrowserMeta: detected OAuth parameter as authSuccessPattern for "${service}": ${badPattern}`);
    try {
      const startHost = new URL(meta.startUrl).hostname;
      meta.authSuccessPattern = startHost;
      logger.info(`[browser.agent] resolveBrowserMeta: replaced authSuccessPattern with startUrl hostname: ${startHost}`);
    } catch {
      meta.authSuccessPattern = seedKey;
      logger.info(`[browser.agent] resolveBrowserMeta: replaced authSuccessPattern with serviceKey: ${seedKey}`);
    }
  }

  if (!meta || !meta.startUrl) {
    meta = {
      startUrl: `https://${seedKey}.com`,
      authSuccessPattern: `${seedKey}.com`,
      capabilities: ['navigate', 'interact'],
      isOAuth: false,
    };
  }

  // 5. cache in DuckDB
  try {
    await withDb(async (db) => {
      await db.run(`
        CREATE TABLE IF NOT EXISTS browser_meta_cache (
          service     TEXT PRIMARY KEY,
          meta_json   TEXT NOT NULL,
          created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).catch(() => {});
      await db.run(
        "INSERT OR REPLACE INTO browser_meta_cache (service, meta_json, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
        seedKey, JSON.stringify(meta)
      );
    });
  } catch {}

  return meta;
}

// ---------------------------------------------------------------------------
// browser.act HTTP helper (calls the same command-service, avoids circular dep
// by using HTTP since we are already inside command-service process)
// ---------------------------------------------------------------------------

function callBrowserAct(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'browser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('browser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('browser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// agentbrowser.act HTTP helper — same transport, different skill name
function callAgentbrowserAct(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'agentbrowser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('agentbrowser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('agentbrowser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// ---------------------------------------------------------------------------
// Agent type derivation — pure function, priority order:
//   1. meta.type           (explicit override from descriptor or seed map)
//   2. isOAuth: true        (OAuth-gated session services — always need browser)
//   3. navigate/interact caps (browser UI signal — any web app that is navigated)
//   4. default: 'api_key'  (safe fallback for pure REST endpoints with no browser UI)
// NOTE: isOAuth:false alone does NOT imply api_key — it only controls _skipInitialAuth.
// ---------------------------------------------------------------------------
function deriveAgentType(meta) {
  if (meta?.type) return meta.type;
  if (meta?.isOAuth === true) return 'browser';
  const caps = Array.isArray(meta?.capabilities) ? meta.capabilities : [];
  if (caps.some(c => c === 'navigate' || c === 'interact')) return 'browser';
  return 'api_key';
}

// ---------------------------------------------------------------------------
// Action: build_agent
// ---------------------------------------------------------------------------

function buildBrowserDescriptorMd({ id, service, startUrl, signInUrl, authSuccessPattern, capabilities, type = 'browser', playbooks = null, goals = null, hostAliases = null, metaRevision = null }) {
  const capYaml = capabilities.map(c => `  - ${c}`).join('\n');
  const goalsYaml = goals && goals.length > 0
    ? goals.map(g => `  - "${g.replace(/"/g, '\\"')}"`).join('\n')
    : '  - "General task automation"';
  const parts = [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `service: ${service}`,
    ...(signInUrl ? [`sign_in_url: ${signInUrl}`] : []),
    `start_url: ${startUrl}`,
    `auth_success_pattern: ${authSuccessPattern}`,
    ...(hostAliases && hostAliases.length > 0 ? [`host_aliases: ${hostAliases.join(', ')}`] : []),
    ...(metaRevision ? [`meta_revision: ${metaRevision}`] : []),
    `capabilities:`,
    capYaml,
    `user_goals:`,
    goalsYaml,
    `learned_states: []`,
    `trained_skills: []`,
    '---',
    `# start_url is the service home/dashboard (used as auth entry point and post-auth navigation target).`,
    '',
    `## Instructions`,
    `Use Playwright via browser.act skill for all ${service} operations.`,
    `Session is persistent — use profile: "${service}_agent" so the user logs in once.`,
    `Always start navigation from: ${startUrl}`,
    '',
    `## Auth`,
    `Use action:waitForAuth with url="${signInUrl || startUrl}" and authSuccessUrl="${authSuccessPattern}".`,
    `Once authenticated, the session is stored at ~/.thinkdrop/browser-sessions/${service}_agent/`,
    '',
    `## Navigation Patterns`,
    `Use { "action": "snapshot" } to read the current DOM state before interacting.`,
    `Use { "action": "navigate", "url": "..." } to go to specific URLs.`,
    `Use { "action": "click", "selector": "..." } with ref from snapshot.`,
    `Use { "action": "fill", "selector": "...", "text": "..." } for standard text inputs and form fields.`,
    `Use { "action": "type", "text": "..." } for contenteditable areas (email body, chat prompts, rich-text editors).`,
    `Use { "action": "press", "key": "..." } for keyboard actions (Enter=confirm/submit, Escape=close, Tab=autocomplete).`,
    `Use { "action": "run-code", "code": "async page => { return await page.evaluate(() => ...) }" } to extract DOM data.`,
  ];
  if (playbooks) {
    parts.push('', '## Playbooks', playbooks);
  }
  return parts.join('\n');
}

async function actionBuildAgent({ service, startUrl: explicitUrl, force = false, goals = null }) {
  if (!service) return { ok: false, error: 'service is required' };

  const serviceKey = service.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const agentId    = `${serviceKey}.agent`;

  // Resolve via LLM if not in seed map — never hard-fail on unknown service
  const meta = await resolveBrowserMeta(service);

  const startUrl           = explicitUrl || meta?.startUrl;
  const signInUrl          = meta?.signInUrl || null;
  const authSuccessPattern = meta?.authSuccessPattern || serviceKey;
  const capabilities       = meta?.capabilities || ['navigate', 'interact'];
  // Derive agent type using priority-ordered signals. isOAuth:false alone no longer implies
  // api_key — consumer web apps (chatgpt, gemini, etc.) are always type=browser regardless.
  const agentType = deriveAgentType({ ...meta, capabilities });

  if (!startUrl) {
    return {
      ok: false,
      error: `Could not determine start URL for service "${service}". Pass startUrl: explicitly.`,
    };
  }

  // Check registry — skip rebuild unless forced.
  // Always rebuild if the stored type differs from the computed agentType so stale descriptors
  // (e.g. Mailgun previously stored as type=browser) are corrected on the next build_agent call.
  if (!force) {
    const existsResult = await withDb(async (db) => {
      const rows = await db.all('SELECT id, type, status FROM agents WHERE id = ?', agentId);
      if (rows && rows.length > 0 && rows[0].status !== 'needs_update' && rows[0].type === agentType) {
        return { alreadyExists: true, status: rows[0].status };
      }
      return null;
    });
    if (existsResult) {
      return { ok: true, agentId, ...existsResult };
    }
  }

  // Resolve playbooks: seed map first, then LLM generation for unknown services.
  // LLM-generated playbooks are marked with a comment so validate_agent can refine them later.
  let playbooks = PLAYBOOK_SEED_MAP[serviceKey] || null;
  let playbooksSource = playbooks ? 'seeded' : null;
  if (!playbooks) {
    try {
      const capList = capabilities.join(', ');
      const buildQuery = `SERVICE: ${serviceKey}\nSTART_URL: ${startUrl}${signInUrl ? '\nSIGN_IN_URL: ' + signInUrl : ''}\nCAPS: ${capList}`;
      const rawPlaybooks = await callLLM(PLAYBOOK_BUILD_PROMPT, buildQuery, { temperature: 0.2, maxTokens: 700 });
      if (rawPlaybooks && rawPlaybooks.includes('###')) {
        // Extract only the ### sections
        const sectionsMatch = rawPlaybooks.match(/(###[\s\S]+)/);
        playbooks = sectionsMatch ? sectionsMatch[1].trim() : null;
        playbooksSource = 'generated';
      }
    } catch (pbErr) {
      logger.warn(`[browser.agent] build_agent: playbook LLM generation failed for ${serviceKey}: ${pbErr.message}`);
    }
  }
  logger.info(`[browser.agent] build_agent: playbooks for ${agentId} — source=${playbooksSource || 'none'}`);

  // Inject video extraction playbook for video-capable platforms (fallback for LLM not generating it)
  if (VIDEO_PLATFORMS.has(serviceKey) && !playbooks?.includes('DELEGATE_TO: video.agent')) {
    const videoPlaybook = `\n\n### Extract Video Content (watch and tell me about it, tell me about, tell me what, describe it, describe the video, explain it, give me a summary, watch and summarize, extract, steps, transcript, tutorial, learn, summarize, content, analyze)\nDELEGATE_TO: video.agent\nPLATFORM: ${serviceKey}\nINSTRUCTION: Use video.agent to find and watch tutorial videos, extracting actionable steps and content via page metadata + audio transcription.`;
    playbooks = (playbooks || '') + videoPlaybook;
    logger.info(`[browser.agent] build_agent: injected video extraction playbook for ${agentId}`);
  }

  // Agent status: LLM-generated playbooks are unverified — mark needs_validation so the first
  // successful run can upgrade to 'healthy'. Seeded playbooks are battle-tested — healthy directly.
  const initialStatus = playbooksSource === 'generated' ? 'needs_validation' : 'healthy';

  const descriptor = buildBrowserDescriptorMd({ id: agentId, service: serviceKey, startUrl, signInUrl, authSuccessPattern, capabilities, type: agentType, playbooks, goals, hostAliases: meta?.hostAliases, metaRevision: meta?._metaRevision });

  // Write .md to disk
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');

  // Upsert into DuckDB
  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
      agentId,
      agentType,
      serviceKey,
      JSON.stringify(capabilities),
      descriptor,
      initialStatus
    );
    // Clear any stale auth timestamps from a previous build. A rebuild resets the
    // agent, so previous authentication is no longer implicitly valid.
    await db.run(
      'UPDATE agents SET authed_at = NULL, auth_expires_at = NULL WHERE id = ?',
      agentId
    );
  });

  logger.info(`[browser.agent] built agent: ${agentId}`, { capabilities });
  return {
    ok: true,
    agentId,
    alreadyExists: false,
    service: serviceKey,
    startUrl,
    capabilities,
    mdPath,
    descriptor,
  };
}

// ---------------------------------------------------------------------------
// Migrate stale built-in browser-agent descriptors to current seed metadata.
// Compares the descriptor's meta_revision against the seed's _metaRevision.
// If the seed is newer, patches only metadata fields (start_url, sign_in_url,
// auth_success_pattern, host_aliases, meta_revision) while preserving
// playbooks, capabilities, goals, and all other descriptor content.
// Returns the patched descriptor string if migrated, or null if up-to-date.
// ---------------------------------------------------------------------------
async function migrateStaleDescriptor(agentId, existing) {
  const serviceKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const seed = KNOWN_BROWSER_SERVICES[serviceKey];
  if (!seed || !seed._metaRevision) return null;

  const descRevisionStr = extractDescriptorUrl(existing.descriptor, 'meta_revision');
  const currentRevision = parseInt(descRevisionStr, 10) || 0;
  const seedRevision = parseInt(seed._metaRevision, 10) || 0;

  if (currentRevision >= seedRevision) return null;

  logger.info(`[browser.agent] migrate: ${agentId} descriptor revision ${currentRevision} < seed revision ${seedRevision} — upgrading metadata`);

  let patched = existing.descriptor;

  const fields = [
    ['start_url', seed.startUrl],
    ['sign_in_url', seed.signInUrl],
    ['auth_success_pattern', seed.authSuccessPattern],
  ];
  if (seed.hostAliases && seed.hostAliases.length > 0) {
    fields.push(['host_aliases', seed.hostAliases.join(', ')]);
  }

  for (const [field, value] of fields) {
    if (!value) continue;
    const re = new RegExp(`^${field}:.*$`, 'm');
    if (re.test(patched)) {
      patched = patched.replace(re, `${field}: ${value}`);
    } else {
      patched = patched.replace(/^(service:.*)$/m, `$1\n${field}: ${value}`);
    }
  }

  const revRe = /^meta_revision:.*$/m;
  if (revRe.test(patched)) {
    patched = patched.replace(revRe, `meta_revision: ${seedRevision}`);
  } else {
    patched = patched.replace(/^(service:.*)$/m, `$1\nmeta_revision: ${seedRevision}`);
  }

  try {
    const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
    fs.writeFileSync(mdPath, patched, 'utf8');
  } catch (e) {
    logger.warn(`[browser.agent] migrate: failed to write .md for ${agentId}: ${e.message}`);
  }

  try {
    await withDb(async (db) => {
      await db.run('UPDATE agents SET descriptor = ? WHERE id = ?', patched, agentId);
    });
  } catch (e) {
    logger.warn(`[browser.agent] migrate: failed to update DuckDB for ${agentId}: ${e.message}`);
  }

  try {
    await withDb(async (db) => {
      await db.run('DELETE FROM browser_meta_cache WHERE service = ?', serviceKey).catch(() => {});
    });
  } catch {}

  logger.info(`[browser.agent] migrate: ${agentId} upgraded to revision ${seedRevision}`);
  return patched;
}


// ---------------------------------------------------------------------------
// Action: query_agent
// ---------------------------------------------------------------------------

async function actionQueryAgent({ service, id }) {
  if (!service && !id) return { ok: false, error: 'service or id is required' };

  return await withDb(async (db) => {
    let rows;
    if (id) {
      rows = await db.all("SELECT * FROM agents WHERE id = ?", id);
    } else {
      const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
      rows = await db.all("SELECT * FROM agents WHERE service = ? AND type IN ('browser', 'api_key', 'bearer', 'basic')", serviceKey);
    }

    if (!rows || rows.length === 0) return { ok: true, found: false };

    const row = rows[0];
    let _caps = [];
    if (row.capabilities) {
      try { _caps = JSON.parse(row.capabilities); } catch (_parseErr) {
        logger.warn(`[browser.agent] actionQueryAgent: corrupted capabilities for "${row.id}" — resetting to []. Value: ${String(row.capabilities).slice(0, 80)}`);
        await db.run('UPDATE agents SET capabilities = ? WHERE id = ?', '[]', row.id).catch(() => {});
      }
    }
    return {
      ok: true,
      found: true,
      agentId: row.id,
      service: row.service,
      capabilities: _caps,
      status: row.status,
      lastValidated: row.last_validated,
      descriptor: row.descriptor,
    };
  });
}

// ---------------------------------------------------------------------------
// Action: list_agents
// ---------------------------------------------------------------------------

async function actionListAgents() {
  let dbAgents = [];
  try {
    await withDb(async (db) => {
      // Unconditional: delete all legacy bare-id rows (e.g. 'youtube', 'gmail')
      // that don't have the canonical '.agent' suffix. Safe to run every call.
      await db.run("DELETE FROM agents WHERE id NOT LIKE '%.agent'").catch(() => {});

      const rows = await db.all("SELECT id, type, service, capabilities, status, last_validated, descriptor FROM agents WHERE type IN ('browser', 'api_key', 'bearer', 'basic') ORDER BY created_at DESC");
      dbAgents = (rows || []).map(r => ({
        id: r.id,
        type: r.type,
        service: r.service,
        capabilities: r.capabilities ? (() => { try { return JSON.parse(r.capabilities); } catch (_) { return []; } })() : [],
        status: r.status,
        lastValidated: r.last_validated,
        start_url: extractDescriptorUrl(r.descriptor, 'start_url') || null,
      }));
    });
  } catch (_) {}
  // Merge .md file agents not yet in DB (e.g. gmail.agent created by explore.agent before DB registration)
  if (fs.existsSync(AGENTS_DIR)) {
    try {
      const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
      const dbIds = new Set(dbAgents.map(a => a.id));
      for (const f of files) {
        const id = f.replace('.md', '');
        if (dbIds.has(id)) continue;
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
          const statusMatch  = content.match(/^status:\s*(\S+)/m);
          const typeMatch    = content.match(/^type:\s*(\S+)/m);
          const serviceMatch = content.match(/^service:\s*(\S+)/m);
          const rawStatus = statusMatch?.[1] || 'healthy';
          // Normalize non-standard statuses to 'healthy' so planSkills includes them
          const HEALTHY_STATUSES = new Set(['healthy', 'learned', 'degraded', 'needs_auth', 'needs_validation']);
          const normalStatus = HEALTHY_STATUSES.has(rawStatus) ? 'healthy' : rawStatus;
          const type    = typeMatch?.[1]    || 'browser';
          const service = serviceMatch?.[1] || id.replace('.agent', '');
          const startUrlMatch = content.match(/^start_url:\s*(.+)/m);
          dbAgents.push({ id, type, service, capabilities: [], status: normalStatus, start_url: startUrlMatch ? startUrlMatch[1].trim() : null });
          logger.info(`[browser.agent] list_agents: merged .md-only agent ${id} (status=${normalStatus})`);
        } catch (_) {}
      }
    } catch (_) {}
  }
  return { ok: true, agents: dbAgents };
}

// ---------------------------------------------------------------------------
// Shared: lightweight LLM caller via the VSCode WebSocket backend (port 4000)
// ---------------------------------------------------------------------------

const LLM_WS_URL = process.env.WEBSOCKET_URL || 'ws://localhost:4000/ws/stream';
const LLM_API_KEY = process.env.VSCODE_API_KEY || '';

async function callLLM(systemPrompt, userQuery, { temperature = 0.2, maxTokens = 1400 } = {}) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return null; }

  const url = new URL(LLM_WS_URL);
  if (LLM_API_KEY) url.searchParams.set('apiKey', LLM_API_KEY);
  url.searchParams.set('userId', 'browser_agent_validator');
  url.searchParams.set('clientId', `browser_agent_${Date.now()}`);

  return new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url.toString()); } catch { return resolve(null); }

    let accumulated = '';
    const connTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(null); }, 8000);
    const respTimeout = setTimeout(() => { try { ws.terminate(); } catch {} resolve(accumulated || null); }, 60000);

    ws.on('open', () => {
      clearTimeout(connTimeout);
      ws.send(JSON.stringify({
        id: `val_${Date.now()}`,
        type: 'llm_request',
        payload: {
          prompt: userQuery,
          provider: 'auto',
          options: { temperature, stream: true, taskType: 'skill_step' },
          context: { systemInstructions: systemPrompt, recentContext: [], sessionFacts: [], memories: [] },
        },
        timestamp: Date.now(),
        metadata: { source: 'browser_agent_validator' },
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'llm_stream_chunk') { accumulated += (msg.payload?.text || msg.payload?.chunk || ''); }
        else if (msg.type === 'llm_stream_end') { clearTimeout(respTimeout); ws.close(); resolve(accumulated); }
        else if (msg.type === 'error') { clearTimeout(respTimeout); ws.close(); resolve(accumulated || null); }
      } catch {}
    });

    ws.on('error', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
    ws.on('close', () => { clearTimeout(respTimeout); resolve(accumulated || null); });
  });
}

// ---------------------------------------------------------------------------
// Action: validate_agent — LLM-powered DOM/flow change detection + auto-fix
// ---------------------------------------------------------------------------

// Phase 1: DOM health check — are selectors + auth flow still valid?
const BROWSER_VALIDATOR_SYSTEM_PROMPT = `You are ThinkDrop's Browser Agent Validator. Your job is to assess whether a browser agent descriptor is still accurate given the current live state of the page it navigates.

You will receive:
1. The agent's current descriptor (.md with navigation patterns, selectors, capabilities, auth flow)
2. An accessibility snapshot of the current live page (title, URL, visible interactive elements)
3. Any HTTP status / reachability info

Your analysis must cover:
- Do the documented navigation patterns still work on the current page?
- Are any critical buttons, forms, or nav items missing or renamed?
- Did the page structure change significantly (e.g. redesign, new auth flow, modal dialogs)?
- Are there new navigation paths or features visible that should be added to the descriptor?
- Are timing issues likely? (e.g. heavy SPAs, lazy-loaded elements that may need a wait step)
- Did the auth flow or login URL change?

Output ONLY valid JSON:
{
  "verdict": "healthy" | "degraded" | "needs_update",
  "missingSelectors": ["<element from descriptor that is no longer on page>"],
  "changedSelectors": [{ "old": "<old selector>", "new": "<new selector or description of change>" }],
  "newElements": ["<new important element found not in descriptor>"],
  "authFlowChanged": true | false,
  "timingRisk": true | false,
  "timingAdvice": "<specific wait hint or null>",
  "fixes": ["<precise fix — exact new selector, updated navigation step, or updated auth URL>"],
  "updatedInstructionsPatch": "<updated ## Navigation Patterns section text, or null if no change>",
  "summary": "<one sentence overall assessment>"
}

IMPORTANT: Be conservative — only flag elements as missing if they are clearly gone from the snapshot. An element not visible in a partial snapshot may just not be on this specific page. Focus on login pages, main nav, and primary action elements.`;

// Phase 2: pipeline review — is the descriptor complete and correct for every node that consumes it?
const BROWSER_PIPELINE_REVIEW_PROMPT = `You are ThinkDrop's Pipeline Review Agent. You perform a deep review of a browser agent descriptor — not just checking if selectors work, but whether the descriptor is COMPLETE and CORRECT for all the real-world cases the autonomous pipeline will encounter.

The ThinkDrop pipeline works like this:
- planSkills reads agent descriptors to decide if credentials/auth are already resolved
- buildSkill injects agent descriptors so generated skill code uses proven navigation patterns
- installSkill calls browser.agent to handle OAuth flows before prompting the user
- browser.agent routes services based on: isOAuth (needs OAuth flow) vs direct API key

You must reason as a senior engineer reviewing this descriptor. Ask yourself:

1. ROUTING CORRECTNESS
   - Is this service correctly handled by browser.agent, or does a CLI tool exist that would be better?
   - Example: if himalaya CLI exists for Gmail, browser.agent may be redundant for credential extraction
   - Is the auth flow described correctly (OAuth2 vs API key vs session cookie vs SSO)?

2. CAPABILITY COMPLETENESS
   - Do the listed capabilities match what skills will actually need?
   - Are common operations missing for this service?
   - Are capabilities listed that browser automation cannot reliably perform?

3. AUTH FLOW ACCURACY
   - Is the startUrl the correct entry point for auth?
   - Is authSuccessPattern reliable? (some SPAs never change URL after login)
   - Is session persistence documented? (does the session survive app restarts?)
   - Are there MFA/2FA flows not documented that will block automation?

4. SKILL CODE QUALITY RISK
   - If a skill is built using this descriptor, will the generated automation code be correct?
   - Are the navigation patterns precise enough? (exact element identifiers, wait conditions, timing)
   - Are error states documented (rate limits, session expiry, CAPTCHA, consent dialogs)?

5. PIPELINE GAPS
   - Is there anything installSkill will need to do that the descriptor doesn't explain?
   - Are there one-time setup steps (app registration, OAuth consent screen, permission grants)?
   - Are there platform-specific requirements (macOS only, requires specific browser profile)?

Output ONLY valid JSON:
{
  "routingCorrect": true | false,
  "routingIssues": ["<precise description and fix>"],
  "betterAlternative": { "type": "cli", "name": "<cli name>", "reason": "<why it is better>" } | null,
  "missingCapabilities": ["<capability missing>"],
  "incorrectCapabilities": ["<capability that cannot reliably be done via browser>"],
  "authFlowIssues": ["<problem with auth flow>"],
  "skillCodeRisks": ["<thing that will cause generated automation code to be wrong>"],
  "pipelineGaps": ["<gap the pipeline will hit but descriptor doesn't cover>"],
  "setupStepsRequired": ["<one-time setup step the user must complete>"],
  "correctedUrls": {
    "sign_in_url": "<corrected actual login form URL, or null if current is correct>",
    "start_url": "<corrected post-login dashboard URL, or null if current is correct>"
  } | null,
  "descriptorPatch": "<updated ## Auth or ## Navigation Patterns or ## Instructions section, or null>",
  "verdict": "complete" | "has_gaps" | "needs_rebuild",
  "summary": "<2-3 sentence assessment written like a senior engineer code review comment>"
}

CRITICAL: If the start_url in the descriptor is a marketing/landing page instead of the actual login form, set correctedUrls.sign_in_url to the real login URL. Example: Gmail descriptor start_url=https://mail.google.com is the dashboard, so sign_in_url should be https://accounts.google.com/signin/v2/identifier. Always correct this — scan_page and waitForAuth depend on sign_in_url being the actual form.`;

async function actionValidateAgent({ id, sessionId: explicitSession }) {
  if (!id) return { ok: false, error: 'id is required' };

  const existing = await actionQueryAgent({ id });
  if (!existing.found) return { ok: false, error: `Agent not found: ${id}` };

  const lines    = (existing.descriptor || '').split('\n');
  const urlLine  = lines.find(l => l.startsWith('start_url:'));
  const startUrl = urlLine ? urlLine.replace('start_url:', '').trim() : null;

  if (!startUrl) {
    await _updateStatus(id, 'needs_update', 'No start_url found in descriptor');
    return { ok: true, agentId: id, healthy: false, issue: 'missing_start_url' };
  }

  // Step 1: quick reachability probe (HEAD request)
  const reachable = await new Promise(resolve => {
    try {
      const parsed = new URL(startUrl);
      const mod    = parsed.protocol === 'https:' ? require('https') : http;
      const req    = mod.request(
        { hostname: parsed.hostname, path: parsed.pathname || '/', method: 'HEAD', timeout: 8000 },
        res => resolve(res.statusCode < 500)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch { resolve(false); }
  });

  if (!reachable) {
    const note = `Service URL not reachable: ${startUrl}`;
    await _updateStatus(id, 'needs_update', note);
    return { ok: true, agentId: id, healthy: false, verdict: 'needs_update', issue: 'url_unreachable', startUrl, summary: note };
  }

  // Step 2: use browser.act scanCurrentPage to get live DOM snapshot
  const profile   = `${id.replace('.agent', '')}_validator`;
  const sessionId = explicitSession || `${id}_validate_${Date.now()}`;
  let domSnapshot = null;

  try {
    const scanResult = await callBrowserAct({
      action: 'scanCurrentPage',
      sessionId,
      profile,
      url: startUrl,
      timeoutMs: 20000,
    }, 30000);

    if (scanResult?.ok !== false) {
      domSnapshot = {
        title:    scanResult?.title || '',
        url:      scanResult?.url || startUrl,
        elements: (scanResult?.elements || []).slice(0, 80),
      };
    }
  } catch (err) {
    logger.warn(`[browser.agent] validate_agent scanCurrentPage failed for ${id}: ${err.message}`);
  }

  // Step 3: build LLM query — descriptor + live DOM snapshot
  const elementsSummary = domSnapshot
    ? domSnapshot.elements.map(el =>
        `[${el.tag}${el.type ? ' type=' + el.type : ''}] label="${el.label || ''}" selector="${el.selector || ''}"${el.href ? ' href=' + el.href : ''}`
      ).join('\n')
    : '(DOM snapshot unavailable — only reachability was checked)';

  const userQuery = [
    `## Agent: ${id}`,
    `## Service start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 3000),
    '```',
    ``,
    `## Live DOM Snapshot`,
    `Page title: ${domSnapshot?.title || 'unknown'}`,
    `Current URL: ${domSnapshot?.url || startUrl}`,
    ``,
    `### Visible Elements (up to 80):`,
    elementsSummary,
  ].join('\n');

  // ── Phase 1: DOM health check — are selectors + auth flow still valid? ──────
  let healthDiagnosis = null;
  const healthRaw = await callLLM(BROWSER_VALIDATOR_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 1400 });
  if (healthRaw) {
    try {
      const m = healthRaw.match(/\{[\s\S]*\}/);
      if (m) healthDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent health parse failed for ${id}`);
    }
  }

  // Fallback if LLM unavailable
  if (!healthDiagnosis) {
    healthDiagnosis = {
      verdict: 'healthy', missingSelectors: [], changedSelectors: [],
      newElements: [], authFlowChanged: false, timingRisk: false,
      timingAdvice: null, fixes: [], updatedInstructionsPatch: null,
      summary: 'Service reachable (LLM validation unavailable)',
    };
  }

  // ── Phase 2: pipeline review — is the descriptor complete for the full pipeline? ─
  // Senior-engineer pass: routing correctness, missing capabilities, auth flow accuracy,
  // skill code risks, setup steps installSkill must surface to the user.
  let reviewDiagnosis = null;
  const reviewQuery = [
    `## Agent: ${id}  (service: ${existing.service || id.replace('.agent', '')})`,
    `## Type: browser`,
    `## start_url: ${startUrl}`,
    ``,
    `## Current Descriptor`,
    '```',
    (existing.descriptor || '').slice(0, 4000),
    '```',
    ``,
    `## Live page title: ${domSnapshot?.title || 'unknown'}`,
    `## Live page URL: ${domSnapshot?.url || startUrl}`,
  ].join('\n');

  const reviewRaw = await callLLM(BROWSER_PIPELINE_REVIEW_PROMPT, reviewQuery, { temperature: 0.15, maxTokens: 1600 });
  if (reviewRaw) {
    try {
      const m = reviewRaw.match(/\{[\s\S]*\}/);
      if (m) reviewDiagnosis = JSON.parse(m[0]);
    } catch {
      logger.warn(`[browser.agent] validate_agent review parse failed for ${id}`);
    }
  }

  // ── Combine verdicts (worst-case wins) ────────────────────────────────────
  const HEALTH_RANK = { healthy: 0, degraded: 1, needs_update: 2 };
  const REVIEW_MAP  = { complete: 'healthy', has_gaps: 'degraded', needs_rebuild: 'needs_update' };
  const healthVerdict = healthDiagnosis.verdict || 'healthy';
  const reviewVerdict = reviewDiagnosis?.verdict || 'complete';
  const reviewStatus  = REVIEW_MAP[reviewVerdict] || 'healthy';
  const finalStatus   = (HEALTH_RANK[healthVerdict] >= HEALTH_RANK[reviewStatus]) ? healthVerdict : reviewStatus;

  const failureParts = [];
  if (healthVerdict !== 'healthy') failureParts.push(`Health: ${healthDiagnosis.summary}`);
  if (reviewVerdict !== 'complete' && reviewDiagnosis?.summary) failureParts.push(`Review: ${reviewDiagnosis.summary}`);
  if (reviewDiagnosis?.pipelineGaps?.length) failureParts.push(`Gaps: ${reviewDiagnosis.pipelineGaps.join(' | ')}`);
  if (reviewDiagnosis?.betterAlternative)
    failureParts.push(`Alternative: ${reviewDiagnosis.betterAlternative.name} (${reviewDiagnosis.betterAlternative.reason})`);
  const failureLog = failureParts.length > 0 ? failureParts.join('\n') : null;

  // ── Auto-patch descriptor from both phases ────────────────────────────────
  let patchedDescriptor = existing.descriptor;
  let descriptorPatched = false;

  // Phase 2: correct frontmatter URLs if validate_agent found them wrong.
  // This is the primary self-healing path — no human needed.
  if (reviewDiagnosis?.correctedUrls) {
    const { sign_in_url: newSignIn, start_url: newStart } = reviewDiagnosis.correctedUrls;
    if (newSignIn || newStart) {
      patchedDescriptor = rewriteDescriptorFrontmatter(patchedDescriptor, {
        ...(newSignIn ? { sign_in_url: newSignIn } : {}),
        ...(newStart  ? { start_url:   newStart  } : {}),
      });
      descriptorPatched = true;
      logger.info(`[browser.agent] validate_agent: corrected URLs for ${id} — sign_in_url=${newSignIn || '(unchanged)'} start_url=${newStart || '(unchanged)'}`);
    }
  }

  if (healthVerdict === 'needs_update' && healthDiagnosis.updatedInstructionsPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        healthDiagnosis.updatedInstructionsPatch,
      timingAdvice: healthDiagnosis.timingAdvice,
    });
    descriptorPatched = true;
  }
  if (reviewDiagnosis?.descriptorPatch) {
    patchedDescriptor = patchBrowserDescriptor(patchedDescriptor, {
      patch:        reviewDiagnosis.descriptorPatch,
      timingAdvice: null,
    });
    descriptorPatched = true;
  }

  if (descriptorPatched) {
    const mdPath = path.join(AGENTS_DIR, `${id}.md`);
    fs.writeFileSync(mdPath, patchedDescriptor, 'utf8');
    await withDb(async (db) => {
      await db.run(
        `UPDATE agents SET descriptor = ?, status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?`,
        patchedDescriptor, finalStatus, failureLog, id
      );
    });
    logger.info(`[browser.agent] validate_agent auto-patched descriptor for ${id}`);
  } else {
    await _updateStatus(id, finalStatus, failureLog);
  }

  logger.info(`[browser.agent] validate_agent ${id} → health:${healthVerdict} review:${reviewVerdict} final:${finalStatus}`);

  return {
    ok: true,
    agentId: id,
    healthy: finalStatus === 'healthy',
    verdict: finalStatus,
    startUrl,
    domSnapshot: !!domSnapshot,
    // Phase 1
    missingSelectors:  healthDiagnosis.missingSelectors  || [],
    changedSelectors:  healthDiagnosis.changedSelectors  || [],
    newElements:       healthDiagnosis.newElements       || [],
    authFlowChanged:   healthDiagnosis.authFlowChanged   || false,
    timingRisk:        healthDiagnosis.timingRisk        || false,
    timingAdvice:      healthDiagnosis.timingAdvice      || null,
    fixes:             healthDiagnosis.fixes             || [],
    healthSummary:     healthDiagnosis.summary,
    // Phase 2
    reviewVerdict,
    routingCorrect:      reviewDiagnosis?.routingCorrect ?? true,
    routingIssues:       reviewDiagnosis?.routingIssues || [],
    betterAlternative:   reviewDiagnosis?.betterAlternative || null,
    missingCapabilities: reviewDiagnosis?.missingCapabilities || [],
    pipelineGaps:        reviewDiagnosis?.pipelineGaps || [],
    setupStepsRequired:  reviewDiagnosis?.setupStepsRequired || [],
    skillCodeRisks:      reviewDiagnosis?.skillCodeRisks || [],
    reviewSummary:       reviewDiagnosis?.summary,
    // Meta
    descriptorPatched,
  };
}


// Rewrite specific frontmatter key: value lines in-place.
// fieldMap = { sign_in_url: 'https://...', start_url: 'https://...' }
function rewriteDescriptorFrontmatter(descriptor, fieldMap) {
  const lines = descriptor.split('\n');
  const rewritten = lines.map(line => {
    for (const [field, value] of Object.entries(fieldMap)) {
      if (line.startsWith(`${field}:`)) {
        return `${field}: ${value}`;
      }
    }
    return line;
  });
  // If a field wasn't present in frontmatter at all, insert it after the last known field
  for (const [field, value] of Object.entries(fieldMap)) {
    if (!rewritten.some(l => l.startsWith(`${field}:`))) {
      const insertAfter = rewritten.findIndex(l => l.startsWith('start_url:') || l.startsWith('service:'));
      if (insertAfter >= 0) {
        rewritten.splice(insertAfter + 1, 0, `${field}: ${value}`);
      }
    }
  }
  return rewritten.join('\n');
}

function patchBrowserDescriptor(descriptor, { patch, timingAdvice }) {
  const lines = descriptor.split('\n');

  // Append patch notes at the end
  const patchLines = [
    ``,
    `## Validator Notes (${new Date().toISOString().slice(0, 10)})`,
    patch,
  ];

  if (timingAdvice) {
    patchLines.push(``, `### Timing Notes`, timingAdvice);
  }

  return lines.join('\n') + '\n' + patchLines.join('\n');
}

async function _updateStatus(id, status, failureNote) {
  await withDb(async (db) => {
    if (failureNote) {
      await db.run(
        'UPDATE agents SET status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, failureNote, id
      );
    } else {
      await db.run(
        'UPDATE agents SET status = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?',
        status, id
      );
    }
  });
}


// ---------------------------------------------------------------------------
// Agentic loop helpers (api_key path) — mirrors cli.agent pattern
// ---------------------------------------------------------------------------

async function agentWebSearch(query) {
  const { URL } = require('url');
  const wsUrl = new URL(process.env.MCCP_WEB_SEARCH_API_URL || 'http://127.0.0.1:3002');
  const wsApiKey = process.env.MCP_WEB_SEARCH_API_KEY || '';
  return new Promise((resolve) => {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'web-search',
      requestId: `ws_${Date.now()}`, action: 'search',
      payload: { query, maxResults: 3 },
    });
    const req = http.request({
      hostname: wsUrl.hostname, port: parseInt(wsUrl.port) || 3002,
      path: '/web.search', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${wsApiKey}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const results = parsed?.data?.results || parsed?.results || [];
          if (results.length === 0) { resolve(`web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); return; }
          resolve(results.slice(0, 3).map(r => `${r.title}\n${r.description}`).join('\n---\n'));
        } catch { resolve(data.slice(0, 600) || `web_search returned no results for: "${query}" — try web_fetch with a direct docs URL instead`); }
      });
    });
    req.on('error', (e) => resolve(`web_search failed: ${e.message || 'connection error'} — try web_fetch with a direct docs URL instead`));
    req.setTimeout(5000, () => { req.destroy(); resolve(`web_search timed out for: "${query}" — try web_fetch with a direct docs URL instead`); });
    req.write(body);
    req.end();
  });
}

async function agentWebFetch(url) {
  const WEB_FETCH_CHARS = 2000;
  const { execFile: _execFileWF } = require('child_process');
  const pcResult = await new Promise(resolve => {
    _execFileWF('/opt/homebrew/bin/playwright-cli', ['fetch', url], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve({ ok: !err, stdout: out || '' });
    });
  });
  if (pcResult.ok && pcResult.stdout.trim()) return pcResult.stdout.slice(0, WEB_FETCH_CHARS);
  const curlResult = await new Promise(resolve => {
    _execFileWF('curl', ['-sL', '--max-time', '10', url], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, out) => {
      resolve({ stdout: out || '' });
    });
  });
  if (curlResult.stdout) return curlResult.stdout.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, WEB_FETCH_CHARS);
  return '';
}

// ---------------------------------------------------------------------------
// Recipe Doctor — diagnoseAndPatchRecipe()
//
// Called when a recipe-driven task fails goal verification.
// Automatically:
//   1. Probes the last recipe step's target element via page.evaluate()
//   2. Detects known JS frameworks (CodeMirror, Monaco, ACE, Quill, etc.)
//   3. If framework unknown, calls web search MCP for interaction hints
//   4. LLM generates a patched waypoint (e.g. evaluate instead of focus)
//   5. Writes the patched recipe JSON to disk
//
// Returns { patched: true, summary, patchedWaypoint } on success
// or      { patched: false, reason } on any failure (always non-fatal)
// ---------------------------------------------------------------------------

async function diagnoseAndPatchRecipe({ agentId, recipeName, recipe, failureReason, sessionId }) {
  const SKILLS_DIR = path.join(os.homedir(), '.thinkdrop', 'skills');

  try {
    if (!recipe || !recipe.waypoints || !Array.isArray(recipe.waypoints)) {
      return { patched: false, reason: 'No recipe waypoints to inspect' };
    }

    // Identify the last substantive waypoint (the handoff step — usually focus/fill/click on the editor)
    const _interactionTypes = ['focus', 'fill', 'click', 'evaluate', 'keycombo', 'paste'];
    const lastWp = [...recipe.waypoints].reverse().find(wp => _interactionTypes.includes(wp.type));
    if (!lastWp) {
      return { patched: false, reason: 'No interaction waypoint found to diagnose' };
    }

    // Skip re-patching if waypoint is already an evaluate with a setValue call.
    // In that case the recipe step itself is correct — the failure is that playwright.agent
    // ignored the targetDescription and used type instead of run-code+editor.setValue().
    // Re-patching the same evaluate step again just thrashes the recipe file with no benefit.
    if (lastWp.type === 'evaluate' && lastWp.code && /setValue/i.test(lastWp.code)) {
      logger.info(`[browser.agent] recipe-doctor: step ${lastWp.step} already has evaluate+setValue — recipe is correct, skipping re-patch (failure is in LLM plan, not recipe)`);
      return { patched: false, reason: 'Recipe step already correct (evaluate+setValue) — LLM plan generation issue, not recipe issue' };
    }

    logger.info(`[browser.agent] recipe-doctor: diagnosing step ${lastWp.step} (${lastWp.type} on "${lastWp.selector || 'no selector'}")`);

    // ── Step 1: DOM probe ──────────────────────────────────────────────────
    let elementProfile = null;
    if (lastWp.selector) {
      const probeCode = `(function() {
        const sel = ${JSON.stringify(lastWp.selector)};
        const el = document.querySelector(sel);
        if (!el) return JSON.stringify({ found: false, selector: sel });
        const style = window.getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        const framework =
          (window.editor && typeof window.editor.setValue === 'function') ? 'codemirror' :
          (window.monaco) ? 'monaco' :
          (window.ace && typeof window.ace.edit === 'function') ? 'ace' :
          (window.Quill) ? 'quill' :
          (window.CodeMirror) ? 'codemirror' :
          null;
        const globalApi =
          framework === 'codemirror' ? 'editor.setValue(content)' :
          framework === 'monaco' ? 'monaco.editor.getModels()[0].setValue(content)' :
          framework === 'ace' ? 'ace.edit(el).setValue(content)' :
          framework === 'quill' ? 'new Quill(el).setText(content)' :
          null;
        const editableChild = el.querySelector('[contenteditable="true"], textarea:not([style*="display:none"])');
        return JSON.stringify({
          found: true,
          selector: sel,
          tagName: el.tagName.toLowerCase(),
          visible,
          contenteditable: el.contentEditable,
          role: el.getAttribute('role'),
          framework,
          globalApi,
          editableChildTag: editableChild ? editableChild.tagName.toLowerCase() : null,
          classes: el.className.slice(0, 100),
        });
      })()`;

      const probeRes = await callBrowserAct({ action: 'evaluate', text: probeCode, sessionId }).catch(() => null);
      if (probeRes) {
        // browser.act evaluate already extracts the result, but for complex JSON strings
        // the outer-quote strip can mangle content — extract directly from stdout as the reliable path.
        // playwright-cli output format: <result>\n### Ran Playwright code\n...
        let raw = '';
        if (probeRes.stdout) {
          const _m = probeRes.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
          raw = _m ? _m[1].trim() : probeRes.stdout.trim();
          if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/\\"/g, '"');
        } else {
          raw = String(probeRes?.result || '').replace(/^"|"$/g, '');
        }
        try { elementProfile = JSON.parse(raw); } catch (_) { /* non-fatal */ }
      }
      logger.info(`[browser.agent] recipe-doctor: element profile: ${JSON.stringify(elementProfile)}`);
    }

    // ── Step 2: Web search for unknown elements ────────────────────────────
    let webHints = '';
    if (elementProfile && elementProfile.found && !elementProfile.framework) {
      // Unknown element type — search for how to interact with it
      try {
        let hostname = 'unknown';
        try { hostname = new URL(recipe.targetUrl || '').hostname; } catch (_) {}
        const searchQuery = `how to programmatically set content in ${elementProfile.tagName} ${elementProfile.classes.split(' ')[0]} editor on ${hostname}`;
        logger.info(`[browser.agent] recipe-doctor: web search for unknown element: "${searchQuery.slice(0, 80)}"`);
        webHints = await agentWebSearch(searchQuery);
        logger.info(`[browser.agent] recipe-doctor: web hints: ${webHints.slice(0, 200)}`);
      } catch (_) { /* non-fatal */ }
    }

    // ── Step 3: LLM generates a patch ─────────────────────────────────────
    const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

    const patchPrompt = `A recipe step failed. Your job is to generate a REPLACEMENT waypoint that correctly interacts with the target element.

FAILED WAYPOINT:
${JSON.stringify(lastWp, null, 2)}

FAILURE REASON: ${failureReason}

ELEMENT PROFILE (from live DOM inspection):
${elementProfile ? JSON.stringify(elementProfile, null, 2) : 'Could not probe element'}

${webHints ? `WEB SEARCH HINTS (advisory — use only if directly relevant):\n${webHints.slice(0, 400)}` : ''}

RULES:
- If framework is "codemirror" and globalApi is "editor.setValue(content)": use type "evaluate" with code that calls editor.setValue('') to CLEAR the editor. The playwright.agent will then use run-code to SET the content.
- If framework is "monaco": use type "evaluate" with code calling monaco.editor.getModels()[0].setValue('').
- If element tagName is "div" and not visible or contenteditable is "false": the selector is wrong — suggest using ".CodeMirror-code" or the editableChild instead.
- If no framework detected: use type "keycombo" with key "Meta+a" then type "evaluate" with document.execCommand('delete') OR suggest a "fill" on the editableChild.
- The patched waypoint should be a SINGLE JSON object (one step).
- Use type "evaluate" for JS API calls. The "code" field is raw JS expression (not async).
- Keep the same step number as the failed waypoint.

Respond with ONLY a valid JSON object — no markdown, no explanation:
{
  "step": <number>,
  "type": "evaluate" | "fill" | "keycombo" | "focus",
  "code": "<JS expression if type=evaluate>",
  "selector": "<CSS selector if needed>",
  "description": "<what this step does>",
  "patchReason": "<one sentence explaining why the original step failed>"
}`;

    const patchRaw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation expert. Respond with JSON only. No markdown fences.' },
      { role: 'user', content: patchPrompt },
    ], { temperature: 0.0, maxTokens: 400, responseTimeoutMs: 20000 });

    let patchedWaypoint = null;
    try {
      const cleaned = (patchRaw || '').trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '');
      patchedWaypoint = JSON.parse(cleaned);
    } catch (_) {
      logger.warn(`[browser.agent] recipe-doctor: LLM returned unparseable patch — aborting`);
      return { patched: false, reason: 'LLM patch parse failed' };
    }

    if (!patchedWaypoint || !patchedWaypoint.type) {
      return { patched: false, reason: 'LLM patch missing required fields' };
    }

    logger.info(`[browser.agent] recipe-doctor: patch generated: ${JSON.stringify(patchedWaypoint)}`);

    // ── Step 4: Apply patch + update targetDescription ────────────────────
    const patchedWaypoints = recipe.waypoints.map(wp =>
      wp.step === lastWp.step ? { ...patchedWaypoint } : wp
    );

    // Derive improved targetDescription if we found a framework
    let patchedTargetDescription = recipe.targetDescription || '';
    if (elementProfile?.framework === 'codemirror' && elementProfile?.globalApi) {
      patchedTargetDescription = `${patchedTargetDescription.split('.')[0]}. IMPORTANT: Editor uses CodeMirror. To write content use run-code: page.evaluate(() => editor.setValue(htmlString)). The editor has been cleared by the recipe — do NOT use type or fill on the editor directly.`;
    } else if (elementProfile?.framework && elementProfile?.globalApi) {
      patchedTargetDescription = `${patchedTargetDescription.split('.')[0]}. IMPORTANT: Editor uses ${elementProfile.framework}. To write content use run-code: page.evaluate(() => ${elementProfile.globalApi.replace('content', 'newContent')}). Do NOT use raw type or fill.`;
    } else if (patchedWaypoint.patchReason) {
      patchedTargetDescription = `${patchedTargetDescription} [Auto-patched: ${patchedWaypoint.patchReason}]`;
    }

    const patchedRecipe = {
      ...recipe,
      waypoints: patchedWaypoints,
      targetDescription: patchedTargetDescription,
      _autoPatchedAt: new Date().toISOString(),
      _autoPatchReason: patchedWaypoint.patchReason || failureReason,
    };

    // ── Step 5: Write patched recipe to disk ──────────────────────────────
    const _skillDirId = (id) => id.replace(/\.agent$/, '').replace(/[^a-z0-9_]/gi, '_');
    const skillDir = path.join(SKILLS_DIR, _skillDirId(agentId));
    const recipePath = path.join(skillDir, `${recipeName}.skill.json`);

    if (!fs.existsSync(skillDir)) {
      logger.warn(`[browser.agent] recipe-doctor: skill dir not found: ${skillDir}`);
      return { patched: false, reason: 'Skill directory not found' };
    }

    fs.writeFileSync(recipePath, JSON.stringify(patchedRecipe, null, 2), 'utf8');
    logger.info(`[browser.agent] recipe-doctor: patched recipe written to ${recipePath}`);

    const summary = `Auto-patched step ${lastWp.step}: changed "${lastWp.type}" → "${patchedWaypoint.type}"${elementProfile?.framework ? ` (detected ${elementProfile.framework})` : ''}. ${patchedWaypoint.patchReason || ''}`;
    logger.info(`[browser.agent] recipe-doctor: ${summary}`);

    return { patched: true, summary, patchedWaypoint, recipePath };

  } catch (err) {
    logger.warn(`[browser.agent] recipe-doctor: diagnosis failed (non-fatal): ${err.message}`);
    return { patched: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Action: run — executes a task using the agent's descriptor as context.
// Supports two paths based on agent type:
//   api_key / bearer: multi-turn agentic loop (run_curl/web_search/web_fetch/done/ask_user)
//   browser / oauth:  waitForAuth → playwright.agent agentic loop
// ---------------------------------------------------------------------------

const BROWSER_RUN_CURL_PROMPT = `You are a REST API command inference engine. Given an agent descriptor and a task, output the curl command to accomplish that task.

Use EXACTLY these shell variable names for credentials (they will be substituted before execution):
  $CRED_PRIMARY    — the API key, auth token, or password
  $CRED_USERNAME   — the username or account SID (for Basic auth)
  $CRED_DOMAIN     — the domain or secondary identifier (if required, e.g. Mailgun sending domain)

Output ONLY valid JSON:
{
  "curlArgs": ["-s", "-f", "-X", "POST", "<url>", ...],
  "credVars": ["PRIMARY"],
  "reasoning": "<one sentence>"
}

curlArgs must NOT include the word "curl" itself. Always use -s flag. Use -f to fail on HTTP errors.
credVars = which of ["PRIMARY", "USERNAME", "DOMAIN"] are actually referenced in curlArgs.`;

const BROWSER_AGENTIC_LOOP_PROMPT = `You are an expert REST API automation agent executing a user task step-by-step.
You have access to the API service described in the Agent Descriptor below.
Each turn you output exactly ONE JSON action object from this palette:

  run_curl   – execute API call:           { "action": "run_curl", "curlArgs": [...], "credVars": [...] }
  web_search – search for API docs:        { "action": "web_search", "query": "..." }
  web_fetch  – read an API docs/ref URL:   { "action": "web_fetch", "url": "..." }
  done       – task complete:              { "action": "done", "summary": "..." }
  ask_user   – need user clarification:    { "action": "ask_user", "question": "...", "options": [] }

Rules:
- curlArgs must NOT include the word "curl" itself. Always use -s flag. Do NOT use -f (you need to read error bodies on failure).
- credVars lists which of ["PRIMARY", "USERNAME", "DOMAIN"] are referenced in curlArgs as $CRED_PRIMARY / $CRED_USERNAME / $CRED_DOMAIN.
- On HTTP 4xx or 5xx: read the response body carefully for error details, then retry with corrected parameters or endpoint.
- Use web_search or web_fetch to find the correct endpoint, required headers, or request body format when uncertain.
- Use done immediately when HTTP 2xx is received and the task is confirmed complete.
- On HTTP 4xx/5xx, diagnose before retrying:
  401/403 → auth issue: verify credential format matches descriptor (Bearer vs Basic vs header name), retry with corrected auth header
  404     → bad endpoint: use web_fetch to find correct URL path from API docs, then retry
  400/422 → bad request body: use web_fetch to check required fields and format, then retry
  5xx     → server error: retry once; if persists, use ask_user
  Never use ask_user for 4xx without first attempting one web_fetch diagnostic probe.
- Use ask_user only when genuinely blocked by missing information that cannot be resolved with the tools above.
- Output JSON only. No prose. No markdown fences.`;

// Resolve a named credential from user-memory profile.
// Returns plaintext valueRef (SAFE:/KEYTAR: refs are decrypted by user-memory).
async function _profileGetValue(key) {
  if (!key) return null;
  const memUrl = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
  const memKey = process.env.MCP_USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';
  let parsed;
  try { parsed = new URL(memUrl); } catch (_) { return null; }
  const body = JSON.stringify({
    version: 'mcp.v1',
    service: 'user-memory',
    action: 'profile.get',
    payload: { key },
    requestId: `browser-agent-${Date.now()}`,
  });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (memKey) headers.Authorization = `Bearer ${memKey}`;
  return new Promise((resolve) => {
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || 3001,
      path: '/profile.get',
      method: 'POST',
      headers,
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const val = json?.data?.valueRef || null;
          // If the crypto bridge is unavailable, the service may return the raw ref.
          // Treat those as missing so we fall back to keytar rather than leaking a ref.
          if (val && !String(val).startsWith('SAFE:') && !String(val).startsWith('KEYTAR:')) {
            resolve(val);
            return;
          }
        } catch (_) {}
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolve(null); });
    req.write(body);
    req.end();
  });
}

// Resolve a named credential: env var → user-memory profile → keytar → null
async function resolveCredential(agentId, credName) {
  const serviceKey = agentId.replace('.agent', '');

  // 1. Try env var patterns (CLICKSEND_API_KEY, CLICKSEND_USERNAME, etc.)
  const candidates = [
    `${serviceKey.toUpperCase()}_${credName}`,
    `${serviceKey.toUpperCase()}_API_KEY`,
    `${serviceKey.toUpperCase()}_TOKEN`,
  ];
  for (const envVar of candidates) {
    if (process.env[envVar]) return process.env[envVar];
  }

  // 2. Try user-memory profile (canonical credential keys used by gatherCredentialCallback)
  const profileKeys = [
    `credential:${serviceKey}.agent:${credName}`,
    `credential:${agentId}:${credName}`,
    `credential:${serviceKey}:${credName}`,
  ];
  for (const key of profileKeys) {
    const val = await _profileGetValue(key);
    if (val) return val;
  }

  // 3. Try keytar (macOS Keychain)
  try {
    const { execFile } = require('child_process');
    const accounts = [
      `browser_agent:${agentId}:${credName}`,
      `skill:${agentId}:${credName}`,
      `browser_agent:${serviceKey}:${credName}`,
    ];
    for (const account of accounts) {
      const val = await new Promise(resolve => {
        execFile('security', ['find-generic-password', '-s', 'thinkdrop', '-a', account, '-w'], (err, stdout) => {
          resolve(err ? null : stdout.trim());
        });
      });
      if (val) return val;
    }
  } catch {}

  return null;
}

/**
 * Quick validation that a discovered deep-link URL is reachable and stays on the
 * expected service domain. Used before overriding startUrl. Returns true only if
 * navigation succeeds and the resulting page shows no obvious error.
 */
function _isUnsafeDeepLinkUrl(candidateUrl, expectedHost = '') {
  const candidate = String(candidateUrl || '');
  const lower = candidate.toLowerCase();
  if (!candidate) return true;
  if (lower.includes('chrome-extension://') || lower.includes('chrome-extension%3a%2f%2f')) {
    return true;
  }
  // Reject URLs containing PII redaction/placeholder tokens — these are search-index
  // artifacts (e.g. %5BPII_EMAIL_...%5D) and are never valid deep-links.
  if (/\bpii_|%5bpii|\[redacted\]|\[placeholder\]/i.test(candidate)) {
    return true;
  }
  // Reject URLs with prefilled-message query params — discovered prefill URLs
  // always carry stale third-party data (subjects, recipients, body text).
  // Template deep-links like #inbox?compose=new use fragments, not query params.
  if (/[?&](su|to|body|subject|bcc|cc)=/i.test(candidate) && /[?&](view=cm|tf=cm|tf=1)/i.test(candidate)) {
    return true;
  }
  if (String(expectedHost || '').replace(/^www\./, '') === 'mail.google.com') {
    if (/mail\.google\.com\/mail(?:\/u\/\d+)?\/?\?body=/i.test(candidate)) {
      return true;
    }
  }
  // Reject auth-flow URLs (login, magic-link, oauth, authorize, callback, signup,
  // verify, logout, …). These are identity-flow pages, never valid task deep-links —
  // promoting them sends the agent to an auth error/landing page instead of the app
  // surface (e.g. claude.ai/magic-link instead of claude.ai/new).
  if (isAuthFlowUrl(candidate)) {
    return true;
  }
  return false;
}

async function verifyDeepLinkUrl(url, sessionId, expectedHost, timeoutMs = 15000, hostAliases = []) {
  try {
    if (_isUnsafeDeepLinkUrl(url, expectedHost)) {
      logger.warn(`[browser.agent] verifyDeepLinkUrl: rejected unsafe candidate for ${expectedHost}: ${url}`);
      return false;
    }

    const nav = await callSkill('browser.act', { action: 'navigate', url, sessionId, timeoutMs }, timeoutMs + 3000).catch(() => ({ ok: false }));
    if (!nav?.ok) return false;

    const loc = await callSkill('browser.act', { action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
    if (!loc?.ok) return false;
    const curHref = String(loc?.result ?? loc?.stdout ?? '').trim().replace(/^"|"$/g, '');
    if (!curHref) return false;

    const curHost = (() => { try { return new URL(curHref).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
    if (!curHost || (curHost !== expectedHost && !curHost.endsWith('.' + expectedHost) && !isHostAlias(curHost, expectedHost, hostAliases))) {
      logger.warn(`[browser.agent] verifyDeepLinkUrl: host mismatch expected=${expectedHost} actual=${curHost} for ${url}`);
      return false;
    }

    const body = await callSkill('browser.act', { action: 'evaluate', text: 'document.title + " " + ((document.body && document.body.innerText) ? document.body.innerText.slice(0, 500) : "")', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
    if (!body?.ok) return false;
    const text = String(body?.result ?? body?.stdout ?? '').toLowerCase();
    if (/\b404\b|\bnot found\b|\bsomething went wrong\b|\berror\b|\bunavailable\b/.test(text)) {
      logger.warn(`[browser.agent] verifyDeepLinkUrl: error indicator found on ${url}`);
      return false;
    }

    return true;
  } catch (err) {
    logger.warn(`[browser.agent] verifyDeepLinkUrl error for ${url}: ${err.message}`);
    return false;
  }
}

// HTTP helper to call another skill in this command-service process
function callSkill(skillName, args, timeoutMs = 120000, signal) {
  return new Promise((resolve, reject) => {
    // Fast-fail if already aborted (avoids opening a socket).
    if (signal && signal.aborted) { reject(new Error('aborted')); return; }
    const body = JSON.stringify({ payload: { skill: skillName, args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error(`skill(${skillName}) parse error: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`skill(${skillName}) timeout`)); });
    // AbortSignal: destroy the loopback socket when the caller cancels. This
    // closes the inner command.automate request (browser.agent → playwright.agent)
    // so the server-side loop stops too.
    const onAbort = () => { req.destroy(new Error('aborted')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    req.on('error', (err) => { cleanup(); reject(err); });
    req.on('close', cleanup);
    req.write(body);
    req.end();
  });
}

function _isMutationIntent(intent) {
  return [INTENTS.CONTENT_CREATE, INTENTS.SOCIAL, INTENTS.MAIL, INTENTS.SCHEDULING, INTENTS.COMMERCE].includes(intent);
}

// ── Read-only task detection (generalized across all mutation intents) ───────
// A mutation-intent task (MAIL, SOCIAL, CONTENT_CREATE, SCHEDULING, COMMERCE)
// can be either a read-only operation (check, list, show, count, search) or an
// actual mutation (send, compose, create, post, book). This function detects
// read-only tasks so they can go through URL-first discovery (e.g., to find a
// search/filter URL) instead of getting a compose/create template URL.

// Per-intent mutation verbs — if any of these are present, the task is NOT read-only.
const _MUTATION_VERBS = {
  [INTENTS.MAIL]:           /\b(send|compose|write|draft|forward|reply|new email|new message|email to|newsletter)\b/i,
  [INTENTS.SOCIAL]:         /\b(post|tweet|retweet|share|comment|like|follow|message|dm|reply|respond)\b/i,
  [INTENTS.CONTENT_CREATE]: /\b(create|new|upload|publish|write|delete|remove|add|submit|post)\b/i,
  [INTENTS.SCHEDULING]:     /\b(book|schedule|add event|create event|cancel|reschedule|invite|set up)\b/i,
  [INTENTS.COMMERCE]:       /\b(add to cart|checkout|buy|purchase|order|place order|pay for)\b/i,
};

// Read verbs (intent-agnostic) — if present and no mutation verbs, the task IS read-only.
const _READ_VERBS = /\b(read|check|list|show|show me|count|how many|see|get|fetch|find|search|look\s*up|browse|summarize|extract|monitor|track|unread|recent|latest|view|scan|review|tell me|what are|what's on)\b/i;

function _isReadOnlyTask(task, intent) {
  const t = String(task || '').toLowerCase();
  if (!t) return false;
  const mutationRe = _MUTATION_VERBS[intent];
  const hasMutation = mutationRe ? mutationRe.test(t) : false;
  const hasRead = _READ_VERBS.test(t);
  return hasRead && !hasMutation;
}

// ── Sub-class: passive read (extract content from current page, no search needed) ──
// True for "read", "summarize this page", "how many", "count" — no filter criteria.
// These should use the browse shortcut (extract body.innerText, return done).
const _PASSIVE_READ_VERBS = /\b(summarize|read|how many|count|tell me what's on|tell me what is on|what's on this page|what is on this page|extract content|get page text)\b/i;

function _isPassiveReadTask(task) {
  const t = String(task || '').toLowerCase();
  if (!t) return false;
  return _PASSIVE_READ_VERBS.test(t);
}

// ── Sub-class: search-criteria task (needs a search URL or search-box interaction) ──
// True when the task names filter criteria: unread, from:X, subject:X, label:X,
// starred, is:unread, "from X", "not from Y", date ranges, etc.
// These should NOT use the browse shortcut — they need to apply the filter first.
const _SEARCH_CRITERIA_RE = /\b(unread|read|starred|label|tag|from:|to:|subject:|is:unread|is:read|has:|since:|before:|after:|category:|size:|attachment|filename|cc:|bcc:|not from|doesn't have|exclude)\b/i;
const _SEARCH_CRITERIA_PHRASE_RE = /\b(?:from|by|sent by|written by|about|regarding|with subject|containing|matching)\s+[A-Z]/i;

/**
 * Strip payload noise from task string before regex extraction.
 * Removes (Context from prior turn: ...), [DATA FROM PRIOR STEP], [CONTENT OF],
 * body: blocks, [Resume context: ...] — these contain arbitrary text that
 * confuses the from:/subject:/etc. regexes (e.g., the `(` in the context suffix
 * breaks the from: character class and causes the entire match to fail).
 */
function _stripTaskNoise(task) {
  let t = String(task || '');
  // Strip "(Context from prior turn: ...)" suffix (injected by preflightAgents.js)
  t = t.replace(/\n*\(Context from prior turn:[^)]*\)\s*$/i, ' ');
  // Strip [Resume context: ...] blocks
  t = t.replace(/\[Resume context:[^\]]*\]/gi, ' ');
  // Strip [DATA FROM PRIOR STEP] ... [/DATA FROM PRIOR STEP] blocks
  t = t.replace(/\[DATA FROM PRIOR STEP\][\s\S]*?(?:\[\/DATA FROM PRIOR STEP\]|$)/gi, ' ');
  // Strip [CONTENT OF ...] blocks
  t = t.replace(/\[CONTENT OF[^\]]*\][\s\S]*?(?=\[|$)/gi, ' ');
  // Strip body: ... multiline blocks
  t = t.replace(/\bbody:\s*[\s\S]{0,3000}/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function _isSearchCriteriaTask(task) {
  const t = _stripTaskNoise(task);
  if (!t) return false;
  return _SEARCH_CRITERIA_RE.test(t) || _SEARCH_CRITERIA_PHRASE_RE.test(t);
}

// Backward-compat alias (used by any callers that haven't been updated yet)
function _isReadOnlyMailTask(task) {
  return _isReadOnlyTask(task, INTENTS.MAIL);
}

// ── Search query extraction ──────────────────────────────────────────────────
// Parse filter criteria from a task string and build a service-appropriate
// search query. Maps common criteria patterns (unread, from:X, not from:Y,
// subject:X, label:X, starred) to the service's query operators.
//
// For Gmail: is:unread from:wendall -from:boss
// For GitHub: is:open <keywords>
// For generic services: raw keywords (unread pastor wendall) — no operator prefixes
//
// Returns { query: string, hasCriteria: boolean }.

// Regex for "from X" / "sent by X" / "written by X" → captures the sender name.
// Limits name to 1-5 words (typical name length) and uses a negative lookahead
// to stop capturing at common action verbs / prepositions (give, show, tell,
// extract, summarize, and, then, on, with, for, about, ...) so we don't capture
// the action phrase along with the name.
// Negative lookbehind on "from" prevents matching "not from X" / "but not from X"
// (those are handled by _NOT_FROM_RE separately).
const _FROM_TERMINATORS = 'give|show|tell|extract|summarize|and|then|with|for|about|regarding|please|also|now|just|only|but|not|excluding|or|so|because|if|when|while|after|before|since|until|on|in|at|from|to|by|my|our|the|a|an';
const _FROM_RE = new RegExp('(?<!not |but not )\\b(?:from|sent by|written by)\\s+([A-Za-z][\\w.-]*(?:\\s+(?!' + _FROM_TERMINATORS + '\\b)[A-Za-z][\\w.-]*){0,4})(?:\\s|$|[,.;])', 'i');

// Regex for "not from X" / "but not from X" / "excluding X" → captures excluded name.
const _NOT_FROM_RE = new RegExp('\\b(?:not from|but not from|excluding|but not|not boss)\\s+([A-Za-z][\\w.-]*(?:\\s+(?!' + _FROM_TERMINATORS + '\\b)[A-Za-z][\\w.-]*){0,4})(?:\\s|$|[,.;])', 'i');

// ── LLM-based search query extraction ──────────────────────────────────────
// Primary path: ask the LLM to extract structured search criteria from the task.
// Returns { query, hasCriteria } or null on failure. Cached per task+service.
const _searchQueryCache = new Map();

async function _extractSearchQueryLLM(task, serviceKey) {
  const t = _stripTaskNoise(task);
  if (!t || t.trim().length < 3) return null;
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _cacheKey = `${svc}:${t.slice(0, 200)}`;
  if (_searchQueryCache.has(_cacheKey)) return _searchQueryCache.get(_cacheKey);

  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  // Build service-specific operator hints
  const _serviceHints = {
    gmail: 'Gmail operators: is:unread, is:read, is:starred, from:NAME, -from:NAME, subject:TEXT, label:NAME, has:attachment, category:NAME. Combine with spaces.',
    outlook: 'Outlook operators: from:NAME, subject:TEXT, has:attachments, category:NAME. Combine with spaces.',
    github: 'GitHub operators: is:open, is:closed, label:NAME, author:NAME. Plus free-text keywords.',
  };
  const _hint = _serviceHints[svc] || 'Use the site\'s native search operators if known, otherwise return plain keywords.';

  const _prompt = `Extract search criteria from this task and return ONLY the search query string.

Service: ${svc || 'generic'}
${_hint}

Rules:
- Strip filler/possessive words (my, our, the, a, an) from names — "from my pastor wendal" → from:pastor wendal
- If the task mentions "unread", include the unread operator (e.g. is:unread)
- If the task mentions a sender, use from:SENDER_NAME (without filler words)
- If the task mentions a subject, use subject:SUBJECT_TEXT
- If the task mentions "not from X" or "excluding X", use -from:X
- Combine multiple criteria with spaces
- Return ONLY the query string on one line. No explanation, no quotes, no markdown.
- If no criteria can be extracted, return an empty line.

Task: ${t}
Query:`;

  try {
    const raw = await askWithMessages([
      { role: 'user', content: _prompt },
    ], { maxTokens: 200, temperature: 0.0, responseTimeoutMs: 5000 });
    const query = (raw || '').trim().replace(/^```.*\n?/i, '').replace(/\n?```$/i, '').trim();
    if (!query) {
      _searchQueryCache.set(_cacheKey, null);
      return null;
    }
    const result = { query, hasCriteria: true };
    _searchQueryCache.set(_cacheKey, result);
    logger.info(`[browser.agent] _extractSearchQueryLLM: "${query}" for task="${t.slice(0, 60)}..." (svc=${svc})`);
    return result;
  } catch (e) {
    logger.debug(`[browser.agent] _extractSearchQueryLLM failed: ${e.message} — falling back to regex`);
    _searchQueryCache.set(_cacheKey, null);
    return null;
  }
}

async function _extractSearchQuery(task, serviceKey) {
  const t = _stripTaskNoise(task);
  if (!t) return { query: '', hasCriteria: false };

  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // ── Primary: LLM extraction ──
  const _llmResult = await _extractSearchQueryLLM(task, serviceKey);
  if (_llmResult && _llmResult.hasCriteria && _llmResult.query) {
    return _llmResult;
  }

  // ── Fallback: regex extraction (improved with _FROM_TERMINATORS fix) ──
  const parts = [];

  // ── Common criteria extraction ──
  // "unread" / "read" → is:unread / is:read
  if (/\bunread\b/i.test(t)) parts.push('is:unread');
  else if (/\bread\b/i.test(t) && !/\breading\b/i.test(t)) parts.push('is:read');

  // "starred" → is:starred
  if (/\bstarred\b/i.test(t)) parts.push('is:starred');

  // "from X" / "sent by X" → from:X
  const fromMatch = t.match(_FROM_RE);
  if (fromMatch) {
    const sender = fromMatch[1].trim().replace(/\s+/g, ' ');
    parts.push(`from:${sender}`);
  }

  // "not from X" / "but not from X" / "excluding X" → -from:X
  const notFromMatch = t.match(_NOT_FROM_RE);
  if (notFromMatch) {
    const excluded = notFromMatch[1].trim().replace(/\s+/g, ' ');
    parts.push(`-from:${excluded}`);
  }

  // "subject X" / "with subject X" → subject:X
  const subjectMatch = t.match(/\b(?:subject|with subject|re:)\s*[:\-]?\s*(.+?)(?:\s+from\s|[,.;]|$)/i);
  if (subjectMatch) {
    parts.push(`subject:${subjectMatch[1].trim()}`);
  }

  // "label X" / "in X" → label:X
  const labelMatch = t.match(/\b(?:label|in)\s+([A-Za-z][\w-]+)(?:\s|$|[,.;])/i);
  if (labelMatch) {
    parts.push(`label:${labelMatch[1].trim()}`);
  }

  // "has attachment" → has:attachment
  if (/\bhas\s+attachment\b/i.test(t)) parts.push('has:attachment');

  // ── Service-specific formatting ──
  if (svc === 'gmail' || svc === 'mailgooglecom') {
    // Gmail uses space-separated operators
    return { query: parts.join(' '), hasCriteria: parts.length > 0 };
  }

  if (svc === 'github') {
    // GitHub: is:open + keywords
    const ghParts = [];
    if (/\bopen\b/i.test(t)) ghParts.push('is:open');
    if (/\bclosed\b/i.test(t)) ghParts.push('is:closed');
    // Extract general keywords (words after "about" or "for")
    const kwMatch = t.match(/\b(?:about|for|regarding)\s+(.+?)(?:\s+from\s|[,.;]|$)/i);
    if (kwMatch) ghParts.push(kwMatch[1].trim());
    return { query: ghParts.join(' '), hasCriteria: ghParts.length > 0 };
  }

  // Generic (non-mail, non-GitHub): extract raw keywords without mail-specific
  // operator prefixes. A generic site's search form doesn't understand "is:unread"
  // or "from:X" — it just wants the search terms (e.g., "pastor wendall unread").
  const _genericParts = [];

  // "unread" → just the word "unread" (not "is:unread")
  if (/\bunread\b/i.test(t)) _genericParts.push('unread');

  // "from X" → just the name "X" (not "from:X")
  if (fromMatch) _genericParts.push(fromMatch[1].trim().replace(/\s+/g, ' '));

  // "subject X" → just "X"
  if (subjectMatch) _genericParts.push(subjectMatch[1].trim());

  // "about X" / "for X" / "regarding X" → just "X"
  // Only add if we don't already have enough criteria (avoids duplicates like
  // "unread pastor wendall unread messages" when "for" matches "search for ...")
  if (_genericParts.length === 0) {
    const kwMatch = t.match(/\b(?:about|for|regarding)\s+(.+?)(?:\s+from\s|[,.;]|$)/i);
    if (kwMatch) _genericParts.push(kwMatch[1].trim());
  }

  return { query: _genericParts.join(' '), hasCriteria: _genericParts.length > 0 };
}

function _canPromoteDeepLink(candidate, source, intent, baseHost, serviceKey = '') {
  if (!candidate || _isUnsafeDeepLinkUrl(candidate, baseHost)) return false;
  let parsed;
  try { parsed = new URL(candidate); } catch (_) { return false; }
  const host = parsed.hostname.replace(/^www\./, '');

  // Check if candidate is on-domain (exact, subdomain, or configured host alias)
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const svcEntry = lookupBrowserService(svc);
  const aliases = svcEntry?.hostAliases;
  const isOnDomain = isHostAlias(host, baseHost, aliases);

  // Off-domain candidates from crawl are untrusted — reject.
  // Off-domain from llm/suggestion/search/template/authenticated/caller are allowed through
  // to verification (verifyDeepLinkUrl navigates and checks the redirect target).
  if (!isOnDomain && source === 'crawl') return false;

  if (_isMutationIntent(intent) && !['caller', 'template', 'authenticated', 'suggestion'].includes(source)) return false;
  if (source === 'search' && /\/(support|help|docs|documentation|community|forum|p|page|post|article|blog|item)\//i.test(parsed.pathname)) return false;
  return true;
}

/**
 * Build a deterministic search-criteria URL for a task that names filter criteria
 * (unread, from:X, subject:X, etc.). Extracted from _buildIntentTemplateUrl so it
 * can be called BEFORE the keyword-cache check in _resolveTaskDeepLink (defense-in-depth:
 * a generic cached destination like the inbox can't encode filter criteria, so the
 * template must win for criteria tasks).
 *
 * Returns the search URL string, or null if the task has no extractable criteria or
 * the service doesn't support URL-based search.
 */
async function _buildSearchCriteriaUrl(intent, serviceKey, baseStartUrl, baseHost, task) {
  if (!_isSearchCriteriaTask(task)) return null;
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _sq = await _extractSearchQuery(task, svc);
  if (!_sq.hasCriteria) return null;

  // ── MAIL ──
  if (intent === INTENTS.MAIL) {
    if (svc === 'gmail' || baseHost === 'mail.google.com') {
      return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(_sq.query)}`;
    }
    if (svc === 'outlook' || baseHost === 'outlook.live.com' || baseHost === 'outlook.office.com') {
      return `https://outlook.live.com/mail/0/deeplink/search?q=${encodeURIComponent(_sq.query)}`;
    }
  }
  // Future: add search-criteria URL templates for other services here.
  return null;
}

/**
 * Build a search URL from a cached search URL pattern + the task's extracted criteria.
 * The pattern cache stores URL templates with a {query} placeholder per service
 * (e.g., "https://example.com/search?q={query}"), discovered by the form-extraction
 * / web.agent / web.crawl steps. This lets any site reuse a previously discovered
 * search URL pattern without re-running the full discovery pipeline.
 *
 * Returns the search URL string, or null if no pattern is cached or the task has
 * no extractable criteria.
 */
async function _buildSearchUrlFromPattern(serviceKey, task) {
  if (!_isSearchCriteriaTask(task)) return null;
  const pattern = await getSearchUrlPattern(serviceKey);
  if (!pattern?.urlTemplate) return null;
  const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _sq = await _extractSearchQuery(task, svc);
  if (!_sq.hasCriteria) return null;
  const _url = pattern.urlTemplate.replace('{query}', encodeURIComponent(_sq.query));
  logger.info(`[browser.agent] search-pattern cache hit for ${serviceKey}: ${_url} (pattern hitCount=${pattern.hitCount || 1})`);
  return _url;
}

async function _resolveTaskDeepLink(agentId, serviceKey, baseStartUrl, task, existingDeepLinkUrl, sessionId) {
  try {
    // If a deep-link was already resolved (e.g., by preflight), skip resolution.
    if (existingDeepLinkUrl) {
      const _existingHost = (() => {
        try { return new URL(existingDeepLinkUrl).hostname.replace(/^www\./, ''); }
        catch (_) { return ''; }
      })();
      const _baseHost = (() => {
        try { return new URL(baseStartUrl).hostname.replace(/^www\./, ''); }
        catch (_) { return serviceKey; }
      })();
      if (_existingHost && (_existingHost === _baseHost || _existingHost.endsWith('.' + _baseHost) || _baseHost.endsWith('.' + _existingHost))) {
        logger.info(`[browser.agent] deep-link: using pre-resolved deepLinkUrl for ${agentId}: ${existingDeepLinkUrl}`);
        return { url: existingDeepLinkUrl, source: 'preflight' };
      }
    }

    const intent = await classifyTaskIntent(task, serviceKey);
    const _taskKeywords = getTaskKeywords(task, serviceKey); // LLM-extracted keywords from classifyTaskIntent
    const isSearchLike = intent === INTENTS.SEARCH || /\b(search|look\s*up|google|find)\b/i.test(task);

    const baseHost = (() => {
      try { return new URL(baseStartUrl).hostname.replace(/^www\./, ''); }
      catch (_) { return serviceKey; }
    })();

    // Compute criteria-task status before the appKnowledge/keyword checks reference it.
    const _isCriteriaTask = _isSearchCriteriaTask(task);

    // Step -1: appKnowledge intent_url check (highest priority, verified cache).
    // If we have a verified intent→URL mapping for this hostname+intent, use it
    // directly. This skips the keyword cache and discovery pipeline entirely.
    // Entries are seeded from KNOWN_BROWSER_SERVICES.intentUrls and updated via
    // recordVerification after each run (success bumps confidence, failure decays).
    if (!_isCriteriaTask && intent && intent !== INTENTS.HOME) {
      try {
        const { loadIntentUrl } = require('./lib/appKnowledge.cjs');
        const _akUrl = loadIntentUrl(baseHost, intent);
        if (_akUrl?.url && _isValidDeepLinkUrl(_akUrl.url)) {
          logger.info(`[browser.agent] deep-link: appKnowledge intent_url hit for ${baseHost}/${intent}: ${_akUrl.url} (confidence=${_akUrl.confidence}, verifiedRuns=${_akUrl.verifiedRuns})`);
          return { url: _akUrl.url, source: 'appKnowledge', intent };
        }
      } catch (_) { /* non-fatal */ }
    }

    // Step 0: For search-criteria tasks, build the deterministic search URL FIRST —
    // before checking the keyword cache. A generic cached destination (e.g. the inbox)
    // can't encode filter criteria (unread, from:X, subject:X), so letting the cache win
    // would land the agent on the wrong page. The template must win for criteria tasks.
    // (Defense-in-depth: protects against stale/polluted cache entries.)
    const _criteriaUrl = await _buildSearchCriteriaUrl(intent, serviceKey, baseStartUrl, baseHost, task);
    if (_criteriaUrl) {
      logger.info(`[browser.agent] deep-link: search-criteria template for ${agentId}: ${_criteriaUrl}`);
      return { url: _criteriaUrl, source: 'template' };
    }

    // Step 0.5: Search URL pattern cache — for criteria tasks on sites without a hardcoded
    // template, check if we've previously discovered a search URL pattern (e.g., via form
    // extraction or web.agent). This lets any site reuse a discovered search form pattern
    // without re-running the full discovery pipeline.
    if (_isCriteriaTask) {
      const _patternUrl = await _buildSearchUrlFromPattern(serviceKey, task);
      if (_patternUrl) {
        logger.info(`[browser.agent] deep-link: search-pattern cache hit for ${agentId}: ${_patternUrl}`);
        return { url: _patternUrl, source: 'search-pattern' };
      }
    }

    // Step 0.7: CHAT/RESEARCH intent template — for chatbot services, go directly to
    // the chat interface URL BEFORE consulting the keyword cache. The keyword cache can
    // hold polluted entries (e.g. claude.ai/public/artifacts/<id> from a previous run that
    // ended on a view-only public page), and for "ask the AI" tasks the chat URL is always
    // the correct starting point. Without this pre-cache check, a cache hit short-circuits
    // and the template below (_buildIntentTemplateUrl) is never reached.
    // (Only CHAT/RESEARCH is hoisted; other intents still consult the cache first.)
    if (intent === INTENTS.CHAT || intent === INTENTS.RESEARCH) {
      const _svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const _chatUrl = SERVICE_CHAT_URLS[_svc];
      if (_chatUrl) {
        logger.info(`[browser.agent] deep-link: CHAT/RESEARCH template (pre-cache) for ${agentId}: ${_chatUrl}`);
        return { url: _chatUrl, source: 'template' };
      }
      // Fallback: if the service startUrl IS a chat URL, use it directly
      if (/chat\.|claude\.ai|chatgpt\.com|gemini\.google|grok\.com/i.test(baseStartUrl)) {
        logger.info(`[browser.agent] deep-link: CHAT/RESEARCH startUrl fallback (pre-cache) for ${agentId}: ${baseStartUrl}`);
        return { url: baseStartUrl, source: 'template' };
      }
    }

    // Step 1: Check keyword-indexed deep-link cache.
    // For search-criteria tasks, SKIP the keyword cache — a generic cached destination
    // (e.g. inbox) can't encode filter criteria, and the discovery pipeline below will
    // find the site's search form/URL pattern (and cache it for future use).
    if (!_isCriteriaTask) {
      const _cachedDeepLink = await getCachedDeepLink(serviceKey, _taskKeywords);
      if (_cachedDeepLink?.url) {
        // Guard: skip cached Messenger URLs for post/share tasks (not message tasks).
        // A stale cached Messenger URL (e.g. facebook.com/messages/t/...) causes the
        // agent to post into a chat instead of the feed. Fall through to discovery.
        const _taskLower = String(task || '').toLowerCase();
        const _isPostShareTask = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLower);
        const _isMessageTask = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLower);
        if (_isPostShareTask && !_isMessageTask && /\/(messages|messenger)\b/i.test(_cachedDeepLink.url)) {
          logger.warn(`[browser.agent] deep-link: skipping cached Messenger URL for post/share task: ${_cachedDeepLink.url} — falling through to discovery`);
        } else {
          logger.info(`[browser.agent] deep-link: keyword cache hit for ${agentId}: ${_cachedDeepLink.url} (score=${_cachedDeepLink.score.toFixed(2)})`);
          return { url: _cachedDeepLink.url, source: 'keyword-cache' };
        }
      }
    }

    // ── Helper: extract encoded search query from task text ────────────────
    const _getEncodedQuery = async (taskText, svcKey) => {
      const _sq = await _extractSearchQuery(taskText, svcKey);
      if (_sq.hasCriteria) return encodeURIComponent(_sq.query);
      const qMatch = taskText.match(/\b(?:search|find|look\s*up|google)\s+(?:for\s+)?(.+?)$/i);
      if (qMatch?.[1]) return encodeURIComponent(String(qMatch[1]).trim().replace(/[?.!]+$/g, ''));
      // "open existing" patterns: "titled X", "called X", "named X", "entitled X",
      // "document/doc/page/sheet/note X", "for X" in open/find/edit context
      const _titleMatch = taskText.match(/\b(?:titled|called|named|entitled)\s+["']?([^"'.]+?)["']?(?:\s+and\s+|$)/i);
      if (_titleMatch?.[1]) return encodeURIComponent(_titleMatch[1].trim().replace(/[?.!]+$/g, ''));
      const _forMatch = taskText.match(/\b(?:open|find|edit|view|navigate\s+to)\s+(?:the\s+)?(?:edit\s+panel\s+(?:in|for)\s+)?(?:google\s+doc(?:ument)?|doc(?:ument)?|page|sheet|spreadsheet|note|file)\s+(?:for\s+)?["']?([^"'.]+?)["']?(?:\s+and\s+|$)/i);
      if (_forMatch?.[1]) return encodeURIComponent(_forMatch[1].trim().replace(/[?.!]+$/g, ''));
      return '';
    };

    // ── Helper: resolve an intentUrls template entry to a URL (or null) ────
    const _resolveIntentTemplate = (template, taskText, ctx) => {
      if (!template) return null;
      if (typeof template === 'string') return template;
      if (template.when && !template.when.test(taskText)) return null;
      if (template.buildUrl) return template.buildUrl(taskText, ctx);
      if (template.url) return template.url;
      return null;
    };

    // ── Generic intent URL builder (data-driven via KNOWN_BROWSER_SERVICES.intentUrls) ──
    const _buildIntentTemplateUrl = async () => {
      const svc = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const startUrlBase = baseStartUrl.replace(/\/$/, '');
      const svcEntry = lookupBrowserService(svc);

      // 1. CHAT/RESEARCH — use SERVICE_CHAT_URLS (already data-driven)
      if (intent === INTENTS.CHAT || intent === INTENTS.RESEARCH) {
        const _chatUrl = SERVICE_CHAT_URLS[svc];
        if (_chatUrl) return _chatUrl;
        // Fallback: if the service startUrl IS a chat URL, use it directly
        if (/chat\.|claude\.ai|chatgpt\.com|gemini\.google|grok\.com/i.test(baseStartUrl)) {
          return baseStartUrl;
        }
      }

      // 2. Read-only check — skip template for read-only tasks on write intents
      const _WRITE_INTENTS = [INTENTS.MAIL, INTENTS.SOCIAL, INTENTS.CONTENT_CREATE, INTENTS.SCHEDULING, INTENTS.COMMERCE];
      if (_WRITE_INTENTS.includes(intent) && _isReadOnlyTask(task, intent)) {
        // Special case: MAIL read-only tries search-criteria URL first
        if (intent === INTENTS.MAIL) {
          const _searchUrl = await _buildSearchCriteriaUrl(intent, serviceKey, baseStartUrl, baseHost, task);
          if (_searchUrl) return _searchUrl;
        }
        return null; // let discovery pipeline run
      }

      // 3. MAPS — extract destination, then use intentUrls
      if (intent === INTENTS.MAPS) {
        const _destMatch = task.match(/(?:directions\s+to|navigate\s+to|find\s+nearby|locate(?:\s+a|\s+the)?|route\s+to)\s+(.+)/i);
        const _dest = _destMatch?.[1]?.trim().replace(/[?.!]+$/g, '');
        const _mapsCtx = { dest: _dest, task, encodedQuery: '' };
        const _mapsResult = _resolveIntentTemplate(svcEntry?.intentUrls?.maps, task, _mapsCtx);
        if (_mapsResult) return _mapsResult;
        // Fallback: if no dest and service is googlemaps, use startUrl
        if (!_dest && (svc === 'googlemaps' || baseStartUrl.includes('google.com/maps'))) return baseStartUrl;
        return null;
      }

      // 3b. OPEN_EXISTING — use per-service open_existing URL if available (optimization).
      // Otherwise return null → fall through to discovery pipeline (authenticated eval,
      // web.agent, web.crawl) which uses SEARCH patterns to find search links on ANY site.
      // Fallback: use the service's start URL (landing page) — NOT the create URL.
      if (intent === INTENTS.OPEN_EXISTING) {
        if (svcEntry?.intentUrls?.open_existing) {
          const _ctx = { task, encodedQuery: await _getEncodedQuery(task, svc), dest: null };
          const _result = _resolveIntentTemplate(svcEntry.intentUrls.open_existing, task, _ctx);
          if (_result) return _result;
        }
        // No per-service open_existing URL → let discovery pipeline find a search link
        return null;
      }

      // 4. Per-service intentUrls lookup
      if (svcEntry?.intentUrls) {
        const _ctx = { task, encodedQuery: await _getEncodedQuery(task, svc), dest: null };
        const _result = _resolveIntentTemplate(svcEntry.intentUrls[intent], task, _ctx);
        if (_result) return _result;
      }

      // 5. Generic path-based intents (settings, support, dashboard, console, notifications, contacts)
      const _GENERIC_PATH_INTENTS = {
        [INTENTS.SETTINGS]:      '/settings',
        [INTENTS.SUPPORT]:       '/help',
        [INTENTS.DASHBOARD]:     '/dashboard',
        [INTENTS.CONSOLE]:       '/console',
        [INTENTS.NOTIFICATIONS]: '/notifications',
        [INTENTS.CONTACTS]:      '/contacts',
      };
      if (_GENERIC_PATH_INTENTS[intent]) {
        return `${startUrlBase}${_GENERIC_PATH_INTENTS[intent]}`;
      }

      // 6. DOCS
      if (intent === INTENTS.DOCS) {
        if (svcEntry?.intentUrls?.docs) return _resolveIntentTemplate(svcEntry.intentUrls.docs, task, {});
        if (baseHost === 'w3schools.com') return `${startUrlBase}/`;
        if (baseHost.startsWith('docs.')) return startUrlBase;
        return `https://docs.${baseHost}`;
      }

      // 7. SEARCH — per-service handled in step 4; generic fallback to discovery
      if (intent === INTENTS.SEARCH || isSearchLike) {
        const _q = await _getEncodedQuery(task, svc);
        if (!_q) return null;
        // Per-service search URL already handled in step 4 via intentUrls.search
        // If we reach here, no per-service search template matched — let discovery find it
        return null;
      }

      return null;
    };

    // 1. Prefer service intent templates for deterministic URL-first starts.
    let candidate = await _buildIntentTemplateUrl();
    let candidateSource = candidate ? 'template' : null;
    if (candidate) {
      if (!_isValidDeepLinkUrl(candidate)) {
        logger.warn(`[browser.agent] deep-link: rejecting invalid template URL for ${agentId}: ${candidate} — falling through to discovery`);
        candidate = null;
        candidateSource = null;
      } else {
        logger.info(`[browser.agent] deep-link: using intent template for ${agentId}: ${candidate}`);
      }
    }

    // 1.5. Authenticated eval — extract <a href> links from the live browser session.
    // This discovers action URLs only visible to logged-in users (e.g., app menus, dashboards).
    // Also extracts <form> search patterns for read-only/search-criteria tasks.
    if (!candidate && sessionId) {
      try {
        const evalResult = await callSkill('browser.act', {
          action: 'evaluate',
          sessionId,
          text: 'JSON.stringify(Array.from(document.querySelectorAll("a[href]")).map(a=>({href:a.href,text:(a.innerText||"").trim().slice(0,80)})).filter(l=>l.href.startsWith("http")).slice(0,150))',
        }, 10000);
        const evalRaw = String(evalResult?.result || evalResult?.stdout || '').trim();
        let evalLinks = null;
        try { evalLinks = JSON.parse(evalRaw); } catch (_) { const m = evalRaw.match(/\[[\s\S]*\]/); if (m) try { evalLinks = JSON.parse(m[0]); } catch (_) {} }
        if (Array.isArray(evalLinks) && evalLinks.length > 0) {
          const _INTENT_EVAL_PATTERNS = {
            [INTENTS.CONTENT_CREATE]: /\/(new|create|compose|upload|publish|submit|add|draft|editor|write)/i,
            [INTENTS.OPEN_EXISTING]:  /\/(search|find|browse|explore|discover|docs|document|page|file|recent|home)/i,
            [INTENTS.SOCIAL]:         /\/(compose|post|share|submit|tweet|message|comment|reply|feed)/i,
            [INTENTS.MAIL]:           /\/(compose|draft|new|mail)/i,
            [INTENTS.SETTINGS]:       /\/(settings|account|preferences|profile|billing|subscription|security|privacy)/i,
            [INTENTS.SUPPORT]:        /\/(help|support|contact|ticket|faq|community|forum)/i,
            [INTENTS.DASHBOARD]:      /\/(dashboard|admin|overview|home|console|analytics|stats|reports)/i,
            [INTENTS.DOCS]:           /\/(docs|documentation|guide|tutorial|help|reference|manual|learn|wiki)/i,
            [INTENTS.CONSOLE]:        /\/(console|developer|api|platform|settings|keys|tokens)/i,
            [INTENTS.SCHEDULING]:     /\/(calendar|schedule|book|event|new|appointment|reserve|meeting)/i,
            [INTENTS.SEARCH]:         /\/(search|find|browse|explore|discover)/i,
            [INTENTS.CHAT]:           /\/(chat|conversation|prompt|ask|new)/i,
            [INTENTS.RESEARCH]:       /\/(chat|conversation|prompt|ask|new|search)/i,
            [INTENTS.DOWNLOAD]:       /\/(download|export|save|archive)/i,
            [INTENTS.COMMERCE]:       /\/(cart|checkout|order|product|buy|shop|store|wishlist)/i,
            [INTENTS.MEDIA_PLAY]:     /\/(watch|listen|player|now-playing|queue|album|track|playlist|episode|stream)/i,
            [INTENTS.NOTIFICATIONS]:  /\/(notifications?|alerts?|activity)/i,
            [INTENTS.CONTACTS]:       /\/(contacts?|people|addressbook|address-book)/i,
          };
          const _evalPattern = _INTENT_EVAL_PATTERNS[intent];
          if (_evalPattern) {
            // For SOCIAL intent, exclude Messenger/messages paths when the task is about
            // posting/sharing (not messaging). Otherwise the deep-link resolver picks
            // facebook.com/messages/t/... (Messenger) instead of the feed composer.
            const _taskLower = String(task || '').toLowerCase();
            const _isPostShareTask = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLower);
            const _isMessageTask = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLower);
            const _excludeMessenger = intent === INTENTS.SOCIAL && _isPostShareTask && !_isMessageTask;
            const _evalMatches = evalLinks
              .filter(l => {
                try {
                  const linkHost = new URL(l.href).hostname.replace(/^www\./, '');
                  if (!(linkHost === baseHost || linkHost.endsWith('.' + baseHost))) return false;
                  if (!_evalPattern.test(l.href)) return false;
                  // Exclude Messenger/messages paths for post/share tasks
                  if (_excludeMessenger && /\/(messages|messenger)\b/i.test(l.href)) return false;
                  return true;
                } catch (_) { return false; }
              })
              .map(l => ({ ...l, _score: (l.text || '').toLowerCase().split(/\s+/).filter(w => w.length > 2 && task.toLowerCase().includes(w)).length }))
              .sort((a, b) => b._score - a._score);
            if (_evalMatches.length > 0) {
              candidate = _evalMatches[0].href;
              candidateSource = 'authenticated';
              logger.info(`[browser.agent] deep-link: authenticated eval discovered ${candidate} (text="${_evalMatches[0].text}", score=${_evalMatches[0]._score}) for ${agentId}`);
            }
          }
        }

        // 1.5b. Search form extraction — for read-only/search-criteria tasks, look for
        // <form> elements with search role/action and extract the search URL pattern.
        // This catches ?q=, ?filter=, #search/ style search URLs that aren't in <a href> links.
        if (!candidate && _isReadOnlyTask(task, intent) && _isSearchCriteriaTask(task)) {
          try {
            const formEvalResult = await callSkill('browser.act', {
              action: 'evaluate',
              sessionId,
              text: 'JSON.stringify(Array.from(document.querySelectorAll("form")).map(f=>({action:f.action,method:f.method,role:f.getAttribute("role"),ariaLabel:f.getAttribute("aria-label"),inputs:Array.from(f.querySelectorAll("input,textarea")).map(i=>({name:i.name,type:i.type,placeholder:i.placeholder,role:i.getAttribute("role")}))})).filter(f=>f.action&&f.action.startsWith("http")).slice(0,30))',
            }, 8000);
            const formRaw = String(formEvalResult?.result || formEvalResult?.stdout || '').trim();
            let formList = null;
            try { formList = JSON.parse(formRaw); } catch (_) { const fm = formRaw.match(/\[[\s\S]*\]/); if (fm) try { formList = JSON.parse(fm[0]); } catch (_) {} }
            if (Array.isArray(formList) && formList.length > 0) {
              // Look for search-like forms: role=search, aria-label contains "search", or inputs named q/query/search/filter
              const _searchForms = formList.filter(f => {
                if (f.role === 'search' || /search/i.test(f.ariaLabel || '')) return true;
                if (Array.isArray(f.inputs) && f.inputs.some(i => /^(q|query|search|filter|s|term|keywords?)$/i.test(i.name || ''))) return true;
                return false;
              });
              if (_searchForms.length > 0) {
                const _sf = _searchForms[0];
                // Build a search URL from the form action + the first search input name
                const _searchInput = Array.isArray(_sf.inputs) ? _sf.inputs.find(i => /^(q|query|search|filter|s|term|keywords?)$/i.test(i.name || '')) : null;
                if (_searchInput) {
                  const _sq = await _extractSearchQuery(task, String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
                  const _queryVal = _sq.hasCriteria ? _sq.query : '';
                  const _searchUrl = `${_sf.action}${_sf.action.includes('?') ? '&' : '?'}${_searchInput.name}=${encodeURIComponent(_queryVal)}`;
                  // Verify the form action is on-domain
                  try {
                    const formHost = new URL(_sf.action).hostname.replace(/^www\./, '');
                    if (formHost === baseHost || formHost.endsWith('.' + baseHost)) {
                      candidate = _searchUrl;
                      candidateSource = 'authenticated-form';
                      logger.info(`[browser.agent] deep-link: search form discovered ${candidate} (input=${_searchInput.name}, label="${_sf.ariaLabel || ''}") for ${agentId}`);
                      // Part C: Record the search URL pattern (with {query} placeholder)
                      // for future criteria tasks on this service — avoids re-running
                      // the full discovery pipeline next time.
                      const _patternTemplate = `${_sf.action}${_sf.action.includes('?') ? '&' : '?'}${_searchInput.name}={query}`;
                      setImmediate(() => {
                        recordSearchUrlPattern(serviceKey, _patternTemplate, _searchInput.name, 'form-extraction').catch(() => {});
                      });
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (formErr) {
            logger.debug(`[browser.agent] deep-link: search form eval failed: ${formErr.message}`);
          }
        }
      } catch (evalErr) {
        logger.debug(`[browser.agent] deep-link: authenticated eval failed: ${evalErr.message}`);
      }
    }

    // 2. Try web.agent discover_task_url
    if (!candidate && !(_isMutationIntent(intent) && !_isReadOnlyTask(task, intent))) {
      try {
        const webResult = await callSkill('web.agent', {
          action: 'discover_task_url',
          domain: baseHost,
          task,
        }, 15000);
        if (webResult?.ok && webResult?.taskUrl) {
          candidate = webResult.taskUrl;
          candidateSource = 'search';
        }
        // Collect keywords from web.agent result
        var _webAgentKeywords = webResult?.taskKeywords || [];
      } catch (webErr) {
        logger.debug(`[browser.agent] deep-link: web.agent failed: ${webErr.message}`);
      }
    }

    // 2.5. Try web.crawl link extraction — crawl the service's start URL and
    // extract <a href> links to discover action URLs not indexed by search engines.
    if (!candidate && !(_isMutationIntent(intent) && !_isReadOnlyTask(task, intent))) {
      try {
        const crawlResult = await callSkill('web.crawl', {
          url: baseStartUrl,
          extractLinks: true,
          maxChars: 1000,
          timeoutMs: 15000,
          waitMs: 2000,
        }, 20000);
        if (crawlResult?.ok && Array.isArray(crawlResult.links) && crawlResult.links.length > 0) {
          // Intent-based path patterns to filter links
          const _INTENT_LINK_PATTERNS = {
            [INTENTS.CONTENT_CREATE]: /\/(new|create|compose|upload|publish|submit|add)/i,
            [INTENTS.SOCIAL]:         /\/(compose|post|share|submit|tweet)/i,
            [INTENTS.MAIL]:           /\/(compose|draft|new|mail)/i,
            [INTENTS.SETTINGS]:       /\/(settings|account|preferences|profile)/i,
            [INTENTS.SUPPORT]:        /\/(help|support|contact|ticket)/i,
            [INTENTS.DASHBOARD]:      /\/(dashboard|admin|overview|home|console)/i,
            [INTENTS.DOCS]:           /\/(docs|documentation|guide|tutorial|help)/i,
            [INTENTS.CONSOLE]:        /\/(console|developer|api|platform|settings)/i,
            [INTENTS.SCHEDULING]:     /\/(calendar|schedule|book|event|new)/i,
            [INTENTS.SEARCH]:         /\/(search|find)/i,
          };
          const _linkPattern = _INTENT_LINK_PATTERNS[intent];
          if (_linkPattern) {
            // Reuse the same Messenger-exclusion heuristic as the eval path above
            const _taskLower2 = String(task || '').toLowerCase();
            const _isPostShareTask2 = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLower2);
            const _isMessageTask2 = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLower2);
            const _excludeMessenger2 = intent === INTENTS.SOCIAL && _isPostShareTask2 && !_isMessageTask2;
            // Filter on-domain links matching the intent pattern
            const _matchingLinks = crawlResult.links
              .filter(l => {
                try {
                  const linkHost = new URL(l.href).hostname.replace(/^www\./, '');
                  if (!(linkHost === baseHost || linkHost.endsWith('.' + baseHost))) return false;
                  if (!_linkPattern.test(l.href)) return false;
                  if (_excludeMessenger2 && /\/(messages|messenger)\b/i.test(l.href)) return false;
                  return true;
                } catch (_) { return false; }
              })
              .map(l => ({ ...l, _score: (l.text || '').toLowerCase().split(/\s+/).filter(w => task.toLowerCase().includes(w)).length }))
              .sort((a, b) => b._score - a._score);

            if (_matchingLinks.length > 0) {
              candidate = _matchingLinks[0].href;
              candidateSource = 'crawl';
              logger.info(`[browser.agent] deep-link: web.crawl discovered ${candidate} (text="${_matchingLinks[0].text}", score=${_matchingLinks[0]._score}) for ${agentId}`);
            }
          }
        }
      } catch (crawlErr) {
        logger.debug(`[browser.agent] deep-link: web.crawl failed: ${crawlErr.message}`);
      }
    }

    // 3. Fallback to LLM-suggested URL
    var _suggestKeywords = [];
    if (!candidate) {
      const suggestion = await suggestTaskUrl(serviceKey, baseStartUrl, intent, task);
      if (suggestion?.ok && suggestion?.url) {
        candidate = suggestion.url;
        candidateSource = 'suggestion';
      }
      _suggestKeywords = suggestion?.keywords || [];
    }

    if (!candidate) return null;

    const _svcKeyNorm = String(serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (!_canPromoteDeepLink(candidate, candidateSource, intent, baseHost, _svcKeyNorm)) {
      logger.warn(`[browser.agent] deep-link: rejected ${candidateSource || 'unknown'} candidate for ${agentId}: ${candidate}`);
      return null;
    }

    // Reject poisoned deep-links that include extension pages/options URLs in query params.
    // These can leak from browser extensions and break deterministic recipe execution.
    const _candidateLower = String(candidate).toLowerCase();
    if (_candidateLower.includes('chrome-extension://') || _candidateLower.includes('chrome-extension%3a%2f%2f')) {
      logger.warn(`[browser.agent] deep-link: rejected extension-origin candidate for ${agentId}: ${candidate}`);
      return null;
    }

    // 4. Security: on-domain candidates pass through. Off-domain candidates must be
    // verified by navigation (verifyDeepLinkUrl) — shortcut domains like notion.new
    // redirect to the canonical service host.
    const candidateHost = (() => {
      try { return new URL(candidate).hostname.replace(/^www\./, ''); }
      catch (_) { return ''; }
    })();
    const _svcEntry = lookupBrowserService(_svcKeyNorm);
    const _svcAliases = _svcEntry?.hostAliases;
    const _isOnDomain = isHostAlias(candidateHost, baseHost, _svcAliases);
    if (!_isOnDomain) {
      if (!sessionId) {
        logger.warn(`[browser.agent] deep-link: off-domain candidate rejected (no sessionId for verification): ${candidate}`);
        return null;
      }
      const _verified = await verifyDeepLinkUrl(candidate, sessionId, baseHost, 15000, _svcAliases);
      if (!_verified) {
        logger.warn(`[browser.agent] deep-link: off-domain candidate failed verification: ${candidate}`);
        return null;
      }
      logger.info(`[browser.agent] deep-link: off-domain candidate verified via redirect: ${candidate}`);
    }

    // Gmail-specific hardening: avoid malformed compose links with extension payloads.
    if (serviceKey === 'gmail' && /mail\.google\.com\/mail\?body=/i.test(candidate)) {
      logger.warn(`[browser.agent] deep-link: rejected malformed Gmail compose candidate for ${agentId}: ${candidate}`);
      return null;
    }

    logger.info(`[browser.agent] deep-link: ${agentId} → ${candidate} (source=${candidateSource})`);

    // Merge keywords from all sources and cache.
    // Layer 2: Skip caching for search-criteria tasks — the resolved URL is either too
    // specific (encodes the exact query, won't match future tasks) or too generic (inbox
    // fallback, harmful). Criteria tasks should always re-derive their #search/ URL.
    // Also skip caching Messenger URLs for post/share tasks — they're the wrong destination
    // (chat instead of feed) and would pollute the cache for future post/share tasks.
    const _mergedKeywords = [...new Set([..._taskKeywords, ...(_webAgentKeywords || []), ..._suggestKeywords])].slice(0, 20);
    const _taskLowerCache = String(task || '').toLowerCase();
    const _isPostShareTaskCache = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLowerCache);
    const _isMessageTaskCache = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLowerCache);
    const _skipCacheForMessenger = _isPostShareTaskCache && !_isMessageTaskCache && /\/(messages|messenger)\b/i.test(candidate);
    if (_mergedKeywords.length > 0 && !_isSearchCriteriaTask(task) && !_skipCacheForMessenger) {
      setImmediate(() => {
        recordDeepLinkCache(serviceKey, candidate, _mergedKeywords, intent).catch(() => {});
      });
    }

    // Part B.5: Cache intent→URL in appKnowledge for future runs.
    // This is the verified intent_url cache — future runs with the same
    // hostname+intent will hit the appKnowledge check (Step -1) and skip
    // the LLM classification + discovery pipeline entirely.
    if (candidate && intent && intent !== INTENTS.HOME && baseHost && !_isCriteriaTask) {
      setImmediate(() => {
        try {
          const { saveIntentUrl } = require('./lib/appKnowledge.cjs');
          saveIntentUrl(baseHost, intent, candidate);
          logger.info(`[browser.agent] deep-link: cached intent_url ${intent} → ${candidate} in appKnowledge for ${baseHost}`);
        } catch (_) {}
      });
    }

    // Part C: For criteria tasks, if the discovered candidate is a search URL (has a
    // query param like ?q=, ?query=, ?search=, ?filter=, or #search/), extract and cache
    // the URL pattern (with {query} placeholder) for future criteria tasks on this service.
    // This lets any site reuse a discovered search URL pattern without re-running discovery.
    // (Form-extraction already records its own pattern above — this covers web.agent/web.crawl.)
    if (_isCriteriaTask && candidateSource !== 'authenticated-form') {
      try {
        const _cUrl = new URL(candidate);
        // Check if the URL has a search query parameter
        const _searchParams = ['q', 'query', 'search', 'filter', 's', 'term', 'keywords'];
        let _searchParamName = null;
        for (const _p of _searchParams) {
          if (_cUrl.searchParams.has(_p)) { _searchParamName = _p; break; }
        }
        // Also check for #search/ hash pattern (Gmail-style)
        const _hashSearchMatch = _cUrl.hash.match(/^#search\/(.+)$/);
        if (_searchParamName) {
          // Build pattern: replace the query value with {query} placeholder
          const _patternUrl = new URL(candidate);
          _patternUrl.searchParams.set(_searchParamName, '{query}');
          const _patternTemplate = _patternUrl.toString();
          setImmediate(() => {
            recordSearchUrlPattern(serviceKey, _patternTemplate, _searchParamName, candidateSource).catch(() => {});
          });
          logger.info(`[browser.agent] deep-link: recording search URL pattern for ${serviceKey}: ${_patternTemplate} (source=${candidateSource})`);
        } else if (_hashSearchMatch) {
          // Gmail-style #search/{query} — build pattern by replacing the hash content
          const _patternTemplate = `${_cUrl.origin}${_cUrl.pathname}#search/{query}`;
          setImmediate(() => {
            recordSearchUrlPattern(serviceKey, _patternTemplate, 'hash', candidateSource).catch(() => {});
          });
          logger.info(`[browser.agent] deep-link: recording hash search URL pattern for ${serviceKey}: ${_patternTemplate} (source=${candidateSource})`);
        }
      } catch (_) {}
    }

    return { url: candidate, source: candidateSource };
  } catch (err) {
    logger.warn(`[browser.agent] deep-link resolution error: ${err.message}`);
    return null;
  }
}

// Matches tasks that involve searching/filtering content (check/count/find/unread/etc.)
// where a service-specific query operator (e.g. Gmail's "is:unread") would help.
const _SEARCH_SYNTAX_TASK_RE = /\b(search|filter|find|unread|read|starred|label|tag|has:|from:|to:|count|how many|list|check)\b/i;
const SEARCH_OPERATOR_RULE_PREFIX = 'SEARCH OPERATOR:';

/**
 * Proactively discover a service's search/filter query operators (e.g. Gmail's
 * "is:unread") via web.agent + web.crawl, and cache them as advisory context
 * rules keyed by hostname. Mirrors the URL-first deep-link discovery pattern,
 * but reuses the existing context_rule / learnedRulesBlock pipeline in
 * playwright.agent.cjs for injection — no new cache or prompt-injection code needed.
 *
 * No-op (fast) once operators are cached for a given host.
 */
async function _discoverSearchSyntax(serviceKey, baseHost, task) {
  if (!baseHost || !task || !_SEARCH_SYNTAX_TASK_RE.test(task)) return;
  try {
    const skillDb = require('../skill-helpers/skill-db.cjs');
    const existingRules = await skillDb.getContextRulesByKeys([baseHost], 'site').catch(() => []);
    const alreadyDiscovered = Array.isArray(existingRules) && existingRules.some(r => String(r).startsWith(SEARCH_OPERATOR_RULE_PREFIX));
    if (alreadyDiscovered) return; // cache hit — nothing to do

    logger.info(`[browser.agent] search-syntax: no cached operators for ${baseHost} — discovering via web.agent`);
    const discoverResult = await callSkill('web.agent', { action: 'discover_search_syntax', domain: baseHost, task }, 25000).catch(err => {
      logger.debug(`[browser.agent] search-syntax: discovery failed: ${err.message}`);
      return null;
    });

    if (!discoverResult?.ok || !Array.isArray(discoverResult.operators) || discoverResult.operators.length === 0) {
      logger.info(`[browser.agent] search-syntax: no operators discovered for ${baseHost}`);
      return;
    }

    for (const op of discoverResult.operators.slice(0, 8)) {
      await skillDb.setContextRule(baseHost, `${SEARCH_OPERATOR_RULE_PREFIX} ${op}`, 'site').catch(() => {});
    }
    logger.info(`[browser.agent] search-syntax: cached ${discoverResult.operators.length} operator(s) for ${baseHost} (source: ${discoverResult.sourceUrl || 'unknown'})`);
  } catch (err) {
    logger.debug(`[browser.agent] search-syntax discovery error (non-fatal): ${err.message}`);
  }
}

// Helper: detect a sign-in wall URL. Covers path-based patterns (/login, /signin,
// /auth, /oauth, /authorize) AND Google's accounts.google.com hostname which uses
// URL structures like /v3/signin/identifier that don't match path patterns.
// Also catches logged-out Google Workspace product landing pages (e.g.
// workspace.google.com/intl/en-US/gmail/) that are often served instead of
// mail.google.com when the session has expired server-side.
function _isSigninWall(href) {
  if (!href || href.length <= 4) return false;
  if (/\/(login|signin|sign[-_]in|auth|oauth|authorize)\b/i.test(href)) return true;
  if (/\baccounts\.google\.com\b/i.test(href)) return true;
  // Google Workspace logged-out marketing pages for Gmail/Workspace apps
  if (/\bworkspace\.google\.com\b/i.test(href)) return true;
  // Any non-mail.google.com host showing a /gmail/ path is a marketing/landing page
  if (/\/gmail\//i.test(href) && !/\bmail\.google\.com\b/i.test(href)) return true;
  return false;
}

async function actionRun({ agentId: _agentIdArg, task, url, context, requiresAuth, skipAuth, manualLogin = false, preflightProbe = false, forceAuthProbe = false, requireCookieConfirmation = false, _progressCallbackUrl, _stepIndex, _loginWallRetried = false, _emitThinking = null, _authOnly = false, planExtend = false, sessionId: _planExtendSessionId = null, _abortSignal = null }) {
  // Derive agentId from url hostname when caller omits it (LLM sometimes emits only url)
  let agentId = _agentIdArg;
  if (!agentId && url) {
    try {
      const _host = new URL(url).hostname.replace(/^www\./, '');
      const _svc  = _host.split('.')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
      agentId = `${_svc}.agent`;
      logger.info(`[browser.agent] run: derived agentId="${agentId}" from url="${url}"`);
    } catch (_) { /* malformed url — fall through to error below */ }
  }
  if (agentId && !agentId.endsWith('.agent')) {
    const normalizedAgentId = `${agentId}.agent`;
    logger.info(`[browser.agent] run: normalized bare agentId "${agentId}" → "${normalizedAgentId}"`);
    agentId = normalizedAgentId;
  }
  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (!task)    return { ok: false, error: 'task is required' };

  // ── Plan Extension: "Try to finish" from partial-failure QuestionCard ──────
  // When the user clicks "Try to finish", main.js re-invokes browser.agent with
  // planExtend: true and the existing sessionId. Skip the full auth/probe/deeplink
  // flow (the session is already authed and on the target page) and go directly
  // to playwright.agent with a focused goal built from the remaining work.
  if (planExtend && _planExtendSessionId) {
    logger.info(`[browser.agent] run: planExtend mode — skipping auth/probe/deeplink, delegating to playwright.agent on existing session ${_planExtendSessionId}`);
    try {
      const { playwrightAgent } = require('./playwright.agent.cjs');
      const _extendResult = await playwrightAgent({
        agentId,
        goal: task,            // playwrightAgent expects `goal`, not `task`
        sessionId: _planExtendSessionId,
        url: null,             // don't navigate — stay on current page
        skipAuth: true,
        headed: true,
        timeoutMs: 120000,
        overallTimeoutMs: 120000,
        _progressCallbackUrl,
        _stepIndex,
        _abortSignal: _abortSignal,
      });
      logger.info(`[browser.agent] run: planExtend result — ok=${_extendResult?.ok}, error=${_extendResult?.error || 'n/a'}`);
      return _extendResult;
    } catch (_extendErr) {
      logger.warn(`[browser.agent] run: planExtend error: ${_extendErr.message}`);
      return { ok: false, error: `Plan extension failed: ${_extendErr.message}`, agentId, task };
    }
  }

  // Domain-continuity flag: set in the playwright auth path, read later during
  // deep-link discovery. Declared at function scope so it is visible outside the
  // if/else branch that populates it.
  let _domainContinuitySkip = false;

  // URL-first navigation flags: set in the playwright auth path, read later
  // during deep-link discovery and playwright.agent delegation. Declared at
  // function scope so they are visible outside the if/else branch that populates them.
  let _urlFirstNavigationSelected = false;
  let _deepLinkSource = null;
  let _deepLinkIntent = null; // intent from _resolveTaskDeepLink (for appKnowledge verification)
  let _urlFirstProbeUsed = false;

  const _fs = require('fs');

  // ── AGENT THINKING PHASE ─────────────────────────────────────────────────
  // Emit thinking event to provide user insight into agent's reasoning process
  const thinkingContext = {
    agentId,
    task: task.slice(0, 200),
    hasUrl: !!url,
    requiresAuth: !!requiresAuth,
    timestamp: Date.now()
  };

  // Generate agent's initial reasoning about the task
  const thinking = _generateAgentThinking('browser.agent', thinkingContext);

  // Emit thinking event via callback if provided
  if (typeof _emitThinking === 'function') {
    _emitThinking({
      type: 'agent:thinking',
      agent: 'browser.agent',
      agentId,
      phase: 'preparation',
      thought: thinking,
      context: thinkingContext
    });
  }

  // If the caller passed a full-content buffer file from a prior pipeline step, append it to the task
  const _dataFile = context?._dataFile;
  if (_dataFile) {
    try {
      const fileContent = _fs.readFileSync(_dataFile, 'utf8');
      task = `${task}\n\n[DATA FROM PRIOR STEP]:\n${fileContent.slice(0, 8000)}`;
    } catch (_) { /* non-fatal — file may not exist */ }
  }

  // Scan the task string for absolute file paths mentioned inline (e.g. "content of /tmp/foo.txt").
  // Pre-read each file and replace the path reference with the actual content so the LLM never
  // needs to generate run-code that tries require('fs') or fs.readFile inside playwright.
  const FILE_PATH_RE = /(\/(?:tmp|var|home|Users|root|etc)[^\s"'`,;)]+)/g;
  const mentionedPaths = [...new Set((task.match(FILE_PATH_RE) || []))];
  for (const filePath of mentionedPaths) {
    try {
      const fileContent = _fs.readFileSync(filePath, 'utf8');
      logger.info(`[browser.agent] pre-injecting file content from ${filePath} (${fileContent.length} chars)`);
      task = task.replace(filePath, `[CONTENT OF ${filePath}]`) +
             `\n\n[CONTENT OF ${filePath}]:\n${fileContent.slice(0, 8000)}`;
    } catch (_) { /* file may not exist — leave path in task as-is */ }
  }

  let existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    // Auto-build the agent transparently — no plan step required for known services.
    // actionBuildAgent already resolves service metadata from KNOWN_BROWSER_SERVICES so
    // gemini / googleai / geminiai aliases all work without any extra config.
    const serviceKey = agentId.replace(/\.agent$/, '');
    logger.info(`[browser.agent] run: agent "${agentId}" not found — attempting auto-build for service "${serviceKey}"`);
    try {
      const buildResult = await actionBuildAgent({ service: serviceKey });
      if (buildResult.ok) {
        logger.info(`[browser.agent] run: auto-built "${agentId}" (alreadyExists=${buildResult.alreadyExists}) — re-querying`);
        existing = await actionQueryAgent({ id: agentId });
      } else {
        logger.warn(`[browser.agent] run: auto-build failed for "${agentId}": ${buildResult.error}`);
      }
    } catch (buildErr) {
      logger.warn(`[browser.agent] run: auto-build threw for "${agentId}": ${buildErr.message}`);
    }
    // If still not found after auto-build attempt, return the original error with needsBuild:true
    // so recoverSkill.js fast-path can REPLAN instead of falling through to ASK_USER.
    if (!existing.found) {
      return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.`, needsBuild: true };
    }
  }

  // Self-heal: .md file was deleted (e.g. to force a playbook refresh) but DuckDB entry still
  // has the old descriptor. When the service has a PLAYBOOK_SEED_MAP entry, force-rebuild so
  // the new seed playbook replaces the stale DB record.
  if (existing.found) {
    const _mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
    const _serviceKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const _hasSeed = Object.prototype.hasOwnProperty.call(PLAYBOOK_SEED_MAP, _serviceKey);
    if (!_fs.existsSync(_mdPath) && _hasSeed) {
      logger.info(`[browser.agent] run: "${agentId}" .md missing but has seed — force-rebuilding from PLAYBOOK_SEED_MAP`);
      try {
        const _seedRebuild = await actionBuildAgent({ service: _serviceKey, force: true });
        if (_seedRebuild.ok) {
          existing = await actionQueryAgent({ id: agentId });
          logger.info(`[browser.agent] run: seed-rebuild complete for "${agentId}"`);
        } else {
          logger.warn(`[browser.agent] run: seed-rebuild failed for "${agentId}": ${_seedRebuild.error}`);
        }
      } catch (_seedErr) {
        logger.warn(`[browser.agent] run: seed-rebuild threw for "${agentId}": ${_seedErr.message}`);
      }
    }
  }

  // Self-heal stale wrong-type entries (e.g. gemini.agent previously built as api_key).
  // Happens when auto-build ran in a prior session before deriveAgentType() was introduced.
  // Only triggers when stored type=api_key but the seed map says this is a browser UI service.
  if (existing.found && (existing.type === 'api_key' || (existing.descriptor || '').match(/^type:\s*api_key/m))) {
    const _selfHealKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const _seedMeta    = lookupBrowserService(_selfHealKey);
    if (_seedMeta !== null && deriveAgentType(_seedMeta) === 'browser') {
      logger.info(`[browser.agent] run: type mismatch "${agentId}" stored=api_key expected=browser — force-rebuilding`);
      try {
        const _rebuildResult = await actionBuildAgent({ service: _selfHealKey, force: true });
        if (_rebuildResult.ok) {
          existing = await actionQueryAgent({ id: agentId });
          logger.info(`[browser.agent] run: self-healed "${agentId}" — new type=${_rebuildResult.descriptor?.match(/^type:\s*(\S+)/m)?.[1] || 'browser'}`);
        }
      } catch (_rebuildErr) {
        logger.warn(`[browser.agent] run: self-heal rebuild threw for "${agentId}": ${_rebuildErr.message}`);
      }
    }
  }

  // Self-heal stale built-in metadata (e.g. Notion changed from notion.so to app.notion.com).
  // Compares the descriptor's meta_revision against the seed's _metaRevision. If the seed
  // is newer, patches only the metadata fields (start_url, sign_in_url, auth_success_pattern,
  // host_aliases, meta_revision) while preserving playbooks, capabilities, and goals.
  if (existing.found) {
    const _migratedDesc = await migrateStaleDescriptor(agentId, existing);
    if (_migratedDesc) {
      existing.descriptor = _migratedDesc;
    }
  }

  const agentType = (() => {
    const m = (existing.descriptor || '').match(/^type:\s*(\S+)/m);
    return m ? m[1].toLowerCase() : existing.type || 'browser';
  })();

  logger.info(`[browser.agent] run agentId=${agentId} type=${agentType} task="${task}"`);
  const _silentPreflightProbe = _authOnly && preflightProbe === true;

  // ── REST API path (api_key, bearer, basic) — multi-turn agentic loop ──
  if (agentType === 'api_key' || agentType === 'bearer' || agentType === 'basic') {
    // Auth-only mode: just verify credentials are present.
    if (_authOnly) {
      const primary = await resolveCredential(agentId, 'PRIMARY') || await resolveCredential(agentId, 'API_KEY') || '';
      if (!primary) {
        return {
          ok: false,
          agentId,
          askUser: true,
          needsCredentials: true,
          authType: agentType,
          question: `What API key or token do you use for ${agentId}? (It will be stored securely for future requests.)`,
          credentialKey: `credential:${agentId.toLowerCase().replace(/\.agent$/, '')}.agent:PRIMARY`,
        };
      }
      return { ok: true, agentId, authed: true, authVerified: true };
    }

    const MAX_TURNS = 8;
    const OBSERVATION_CHARS = 600;
    const loopHistory = [];

    // Resolve credentials once before the loop starts
    const creds = {
      PRIMARY:  await resolveCredential(agentId, 'PRIMARY')  || await resolveCredential(agentId, 'API_KEY')  || '',
      USERNAME: await resolveCredential(agentId, 'USERNAME') || await resolveCredential(agentId, 'USER')     || '',
      DOMAIN:   await resolveCredential(agentId, 'DOMAIN')   || '',
    };

    // Build system prompt with descriptor embedded (descriptor stays in system, not per-turn)
    const DESCRIPTOR_LIMIT = 3000;
    const trimmedDescriptor = (existing.descriptor || '(none)').slice(0, DESCRIPTOR_LIMIT);
    const loopSystemPrompt = `${BROWSER_AGENTIC_LOOP_PROMPT}\n\n## Agent Descriptor\n${trimmedDescriptor}`;

    // Helper: substitute credential placeholders and run curl
    const { execFile: _execFileCurl } = require('child_process');
    const execCurlWithCreds = (curlArgs) => {
      const resolvedArgs = curlArgs.map(a =>
        a.replace(/\$CRED_PRIMARY/g,  creds.PRIMARY)
         .replace(/\$CRED_USERNAME/g, creds.USERNAME)
         .replace(/\$CRED_DOMAIN/g,   creds.DOMAIN)
      );
      logger.info(`[browser.agent] api_key loop: curl ${resolvedArgs.filter(a => !creds.PRIMARY || !a.includes(creds.PRIMARY)).slice(0, 5).join(' ')} ...`);
      return new Promise(resolve => {
        _execFileCurl('curl', resolvedArgs, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (err, out, errOut) => {
          resolve({ ok: !err || err.code === 0, stdout: out || '', stderr: errOut || '', exitCode: err?.code ?? 0, error: err?.message });
        });
      });
    };

    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      // Build per-turn user prompt
      const histLines = loopHistory.length === 0
        ? '(none — this is turn 1)'
        : loopHistory.map(h => {
            const parts = Object.entries(h)
              .filter(([k]) => k !== 'turn' && k !== 'observation')
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
            return `  Turn ${h.turn}: ${parts}\n    Observation: ${h.observation}`;
          }).join('\n\n');
      const turnUser = `## Task\n${task}\n\n## Turn History\n${histLines}\n\n## Next Action\nOutput a single JSON action object.`;

      const llmRaw = await callLLM(loopSystemPrompt, turnUser, { temperature: 0.1, maxTokens: 400 });

      let action = null;
      if (llmRaw) {
        try {
          const m = llmRaw.match(/\{[\s\S]*\}/);
          if (m) action = JSON.parse(m[0]);
        } catch {}
      }

      if (!action || !action.action) {
        loopHistory.push({ turn, action: 'parse_error', observation: `LLM output unparseable: ${(llmRaw || '').slice(0, 200)}` });
        continue;
      }

      logger.info(`[browser.agent] api_key loop turn ${turn}/${MAX_TURNS}: action=${action.action}`);

      if (action.action === 'done') {
        return { ok: true, agentId, task, stdout: action.summary || '', agentTurns: turn, loopHistory };
      }

      if (action.action === 'ask_user') {
        return { ok: false, agentId, task, askUser: true, question: action.question, options: action.options || [], agentTurns: turn, loopHistory };
      }

      let observation = '';

      if (action.action === 'run_curl') {
        const curlArgs = Array.isArray(action.curlArgs) ? action.curlArgs : [];
        const credVars = Array.isArray(action.credVars) ? action.credVars : [];
        if (credVars.includes('PRIMARY') && !creds.PRIMARY) {
          return {
            ok: false, agentId, task,
            error: `Missing credential for ${agentId}. Store API key in Keychain: security add-generic-password -s thinkdrop -a "browser_agent:${agentId}:PRIMARY" -w "<your-key>"`,
            needsCredentials: true,
          };
        }
        if (curlArgs.length === 0) {
          observation = 'run_curl: no curlArgs provided';
        } else {
          const result = await execCurlWithCreds(curlArgs);
          observation = (result.stdout || result.stderr || result.error || '').slice(0, OBSERVATION_CHARS);
          // Auto-done on HTTP success (exitCode 0 = 2xx when -f is omitted)
          if (result.ok && result.exitCode === 0) {
            return {
              ok: true, agentId, task,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              agentTurns: turn,
              loopHistory,
            };
          }
        }
      } else if (action.action === 'web_search') {
        const snippets = await agentWebSearch(action.query || '');
        observation = snippets.slice(0, OBSERVATION_CHARS);
      } else if (action.action === 'web_fetch') {
        const page = await agentWebFetch(action.url || '');
        observation = page.slice(0, OBSERVATION_CHARS);
      } else {
        observation = `Unknown action: ${action.action}`;
      }

      loopHistory.push({ turn, ...action, observation });
    }

    return { ok: false, agentId, task, error: `Agentic loop reached MAX_TURNS (${MAX_TURNS}) without completing`, loopHistory };
  }

  // ── Browser / OAuth path ───────────────────────────────────────────────
  const _svcKey          = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const _svcInfo         = lookupBrowserService(_svcKey);

  let startUrl             = extractDescriptorUrl(existing.descriptor, 'start_url');
  const _rawSignInUrl      = extractDescriptorUrl(existing.descriptor, 'sign_in_url');
  // Sanitize bare OAuth endpoints (e.g. accounts.google.com/o/oauth2/auth) to proper
  // sign-in URLs. _sanitizeBrowserMeta does this in resolveBrowserMeta, but actionRun
  // reads directly from the descriptor — bypassing that fix. Without this, waitForAuth
  // navigates to a bare OAuth endpoint that always errors ("Required parameter is missing:
  // response_type"), causing a 120s timeout even when the user is already authenticated.
  const signInUrl = (() => {
    if (!_rawSignInUrl) return _rawSignInUrl;
    if (!OAUTH_ENDPOINT_RE.test(_rawSignInUrl)) return _rawSignInUrl;
    try {
      const _idpHost = new URL(_rawSignInUrl).hostname;
      if (IDP_LOGIN_MAP[_idpHost]) {
        logger.warn(`[browser.agent] run: sanitized bare OAuth signInUrl for ${agentId}: ${_rawSignInUrl} → ${IDP_LOGIN_MAP[_idpHost]}`);
        return IDP_LOGIN_MAP[_idpHost];
      }
    } catch (_) {}
    logger.warn(`[browser.agent] run: could not sanitize OAuth signInUrl for ${agentId} — falling back to startUrl`);
    return null; // waitForAuth uses (signInUrl || startUrl) — fall back to startUrl
  })();
  const authSuccessPattern = extractDescriptorUrl(existing.descriptor, 'auth_success_pattern');
  const _hostAliasesDesc   = extractDescriptorUrl(existing.descriptor, 'host_aliases');
  const hostAliases        = _hostAliasesDesc
    ? _hostAliasesDesc.split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    : (_svcInfo?.hostAliases || []);
  const postAuthUrl        = _svcInfo?.postAuthUrl || null;
  if (!startUrl) return { ok: false, error: 'Agent descriptor missing start_url' };

  // Strip any path from the stored descriptor start_url — always navigate to the
  // landing page (scheme + hostname only). This is a data-quality rule on static
  // defaults; resolveDestination corrections below are intentionally NOT stripped
  // because they are dynamic, intent-aware overrides that may need a deep path.
  try { const _u = new URL(startUrl); startUrl = `${_u.protocol}//${_u.hostname}`; } catch (_) {}

  const profile   = `${agentId.replace('.agent', '')}_agent`;
  // Use the stable profile name as sessionId so browser-profiles/<sessionId>/ persists
  // cookies across all invocations. A timestamped suffix creates a fresh dir each run
  // → Chrome shows the login page every time. 'gmail_agent' ≈ 94-char socket path,
  // safely under macOS's 104-char Unix socket limit.
  const sessionId = profile;

  // ── Destination intent mismatch correction ────────────────────────────────────
  // Pre-navigation: detect when the configured startUrl (e.g. developer API console)
  // does not match the task's intent (e.g. research/chat). Correct silently on high
  // confidence; ask the user when ambiguous. Entirely non-blocking on error.
  try {
    const _destResult = await resolveDestination(_svcKey, task, startUrl, agentId);
    if (_destResult.action === 'auto_correct') {
      logger.info(`[browser.agent] run: destination auto-correct for "${agentId}": "${startUrl}" → "${_destResult.correctedUrl}" (${_destResult.reason})`);
      startUrl = _destResult.correctedUrl;
      // Record the correction so future runs use it without re-checking,
      // but only when this isn't already a resume (avoid echoing learned corrections).
      if (!_destResult.fromResumeContext) {
        setImmediate(() => {
          recordCorrection(_svcKey, _destResult.intent, _destResult.correctedUrl).catch(() => {});
        });
      }
    } else if (_destResult.action === 'ask_user') {
      logger.info(`[browser.agent] run: destination ambiguous for "${agentId}" — surfacing ASK_USER`);
      return {
        ok:               false,
        agentId,
        task,
        askUser:          true,
        wrongDestination: true,
        question:         _destResult.question,
        options:          _destResult.options || [],
      };
    }
    // action === 'ok': no change needed
  } catch (_destErr) {
    logger.warn(`[browser.agent] run: destination-resolver error (non-fatal): ${_destErr.message}`);
  }

  // ── App Knowledge: start research in parallel with auth check ─────────────
  // The research uses web search + separate crawl browsers (independent from the
  // auth check's browser session), so it can run concurrently. By the time we
  // await the promise (after auth + nav hints), it's likely already resolved.
  // No artificial timeout — each operation has its own internal timeout.
  let _appKnowledgePromise = null;
  let _appKnowledgeHost = null;
  let _appKnowledgeEntries = [];
  try {
    _appKnowledgeHost = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
    if (_appKnowledgeHost) {
      const _cachedEntries = loadAppKnowledge(_appKnowledgeHost);
      // Use isCacheStale to detect worthless caches (all low-confidence snippet-based entries).
      // Use isShortcutCoverageStale to detect sparse shortcut data (e.g. twitter.com with
      // 1 wrong Slack shortcut that never gets re-researched because isCacheStale sees one
      // high-confidence entry and returns false).
      const _cacheStale = isCacheStale(_appKnowledgeHost);
      const _shortcutStale = isShortcutCoverageStale(_appKnowledgeHost);
      if (_cachedEntries.length > 0 && !_cacheStale && !_shortcutStale) {
        _appKnowledgeEntries = _cachedEntries;
        logger.info(`[browser.agent] app-knowledge: loaded ${_cachedEntries.length} cached entries for ${_appKnowledgeHost}`);
      } else {
        // Cache empty or stale — seed intent_url entries from KNOWN_BROWSER_SERVICES
        // so the first run benefits from deterministic templates (e.g. googledocs
        // content_create → /document/create) without needing prior verification.
        _seedIntentUrlsFromKnownServices(_appKnowledgeHost, _svcKey);
        // Reload after seeding so intent_url entries are available for this run
        const _seededEntries = loadAppKnowledge(_appKnowledgeHost);
        if (_seededEntries.length > 0) {
          _appKnowledgeEntries = _seededEntries;
          logger.info(`[browser.agent] app-knowledge: loaded ${_seededEntries.length} entries (after seeding) for ${_appKnowledgeHost}`);
        }
        // Cache empty or stale (all low-confidence) — start research now (parallel with auth check below)
        const _akDomain = existing?.service || _appKnowledgeHost;
        const _akQuery = task ? task.slice(0, 80) : null;
        _appKnowledgePromise = callSkill('web.agent', {
          action: 'research_app_behavior',
          domain: _akDomain,
          query: _akQuery,
          maxResults: 4,
        }).catch(() => null);
        const _staleReason = _cacheStale
          ? 'stale (all low-confidence snippet entries)'
          : (_shortcutStale ? 'stale (sparse shortcut coverage — < 5 shortcuts and older than 7 days)' : 'empty');
        logger.info(`[browser.agent] app-knowledge: cache ${_staleReason} for ${_appKnowledgeHost} — research started in parallel with auth check`);
      }
    }
  } catch (_akEarlyErr) {
    logger.warn(`[browser.agent] app-knowledge: early init failed (non-fatal): ${_akEarlyErr.message}`);
  }

  // Use the registered Playwright driver until an agent-browser agent implementation is available.
  const _useAgentBrowser = false;
  const _agentSkill = 'playwright.agent';
  if (_svcInfo?.preferAgentBrowser === true || process.env.THINKDROP_CLI_DRIVER === 'agentbrowser') {
    logger.warn(`[browser.agent] run: agentbrowser requested for ${agentId}, but no agentbrowser.agent skill is registered — using playwright.agent`);
  }

  // When auto-connect is enabled, agentbrowser attaches to the user's already-running
  // Chrome via CDP. No playwright waitForAuth / state-bridging needed — Chrome already
  // has all auth cookies. Activate per service (useAutoConnect) or globally via env var.
  const _useAutoConnect = _useAgentBrowser && (
    _svcInfo?.useAutoConnect === true ||
    process.env.THINKDROP_AUTO_CONNECT === 'true'
  );
  if (_useAutoConnect) {
    logger.info(`[browser.agent] run: auto-connect mode for ${agentId} — skipping playwright auth, attaching to running Chrome`);
  }

  // Persistent-profile mode: agent-browser opens Chrome with a persistent profile dir so
  // cookies survive between runs. User logs in once (headed), then auth is automatic.
  const AGENT_BROWSER_PROFILE = path.join(os.homedir(), '.thinkdrop', 'agent-profile');
  const _usePersistentProfile = _useAgentBrowser && (_svcInfo?.usePersistentProfile === true);
  if (_usePersistentProfile) {
    logger.info(`[browser.agent] run: persistent-profile mode for ${agentId} — profile=${AGENT_BROWSER_PROFILE}`);
  }

  // ── Step 1: Auth — lazy navigate-first ────────────────────────────────────
  // Rule: go to the site first; only call waitForAuth if the site itself redirects
  // to a login/auth page. Never navigate to sign-in upfront.
  //
  // agentbrowser path: fully independent — agentbrowser.agent handles its own lazy
  //   auth gate; playwright-cli is never involved for this stack.
  // playwright path: navigate to startUrl, probe current URL, call waitForAuth only
  //   if redirected to a login path. Applies uniformly to all services.

  let _effectiveAutoConnect = _useAutoConnect && !_usePersistentProfile;

  if (_useAgentBrowser) {
    // agentbrowser.agent handles its own auth lazily — no playwright-cli involvement.
    if (_usePersistentProfile) {
      // Daemon restart forces --profile/--headed flags on next launch.
      await callAgentbrowserAct({ action: 'close-all' }, 8000).catch(() => {});
      logger.info(`[browser.agent] persistent-profile: cleared sessions for ${agentId} — profile=${AGENT_BROWSER_PROFILE}`);
    } else if (_useAutoConnect) {
      try {
        const cdpResult = await getEnsureChromeCDP()();
        if (cdpResult.launched) {
          logger.info(`[browser.agent] Chrome CDP launched for ${agentId} auto-connect ✓`);
        } else if (!cdpResult.ok) {
          logger.warn(`[browser.agent] CDP unavailable: ${cdpResult.error} — falling back to --profile Default for ${agentId}`);
          _effectiveAutoConnect = false;
        } else {
          logger.info(`[browser.agent] Chrome CDP already available for ${agentId}`);
        }
      } catch (cdpErr) {
        logger.warn(`[browser.agent] ensureChromeCDP threw (non-fatal) — falling back to --profile Default: ${cdpErr.message}`);
        _effectiveAutoConnect = false;
      }
    }
    // agentbrowser.agent navigates to startUrl + lazy-checks auth itself.
    logger.info(`[browser.agent] run: agentbrowser path — auth delegated to agentbrowser.agent for ${agentId}`);
  } else {
    // playwright path: navigate to startUrl first, probe URL, call waitForAuth only if
    // the site redirects to a login path. Applies to ALL services uniformly.
    // skipAuth: true bypasses all auth checks (used for "Try without logging in" in parallel groups).
    if (skipAuth) {
      logger.info(`[browser.agent] run: skipAuth=true for ${agentId} — bypassing waitForAuth`);
    }
    let _authNeeded = false;
    let _skipNavigate = false;
    let _curHref = '';

    // ── Auth state persistence strategy ──────────────────────────────────────
    // Persistent-profile sessions (*_agent) use Chrome's own cookie store at
    // ~/.thinkdrop/browser-profiles/<sessionId>/. This preserves HttpOnly,
    // SameSite=Strict, and cross-domain cookies (e.g. Google's accounts.google.com
    // session tokens) that cannot be captured by playwright's JSON storageState.
    //
    // JSON state-load (browser-sessions/<sessionId>.json) is kept ONLY for
    // non-persistent sessions where no profile dir exists — it works fine for
    // simple sites but fails consistently for Google/Slack/Notion.
    const _hasPersistentProfile = sessionId.includes('agent');
    const _stateFile = path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
    if (_hasPersistentProfile) {
      // ── Auth-check cache hit — skip navigate+evaluate if recently confirmed ──
      const _cachedAuth = _getCachedAuthCheck(agentId);
      if (!forceAuthProbe && _cachedAuth && !_cachedAuth.authNeeded) {
        logger.info(`[browser.agent] run: auth-check cache hit for ${agentId} (${Math.round((Date.now() - _cachedAuth.ts) / 1000)}s ago) — skipping auth probe`);
        _skipNavigate = true;
      } else {
        // ── DuckDB persistent auth fast-path ─────────────────────────────────
        // Check if agent has a recorded auth that hasn't expired yet. This survives
        // process restarts (in-memory cache doesn't). Non-fatal: falls through to
        // full probe if DuckDB read fails or record is missing/expired.
        try {
          const _dbAuthRow = await withDb(async (db) => db.get(
            `SELECT authed_at, auth_expires_at FROM agents WHERE id = ?`, agentId
          ));
          if (_dbAuthRow?.auth_expires_at) {
            const _expiresMs = new Date(_dbAuthRow.auth_expires_at).getTime();
            if (!forceAuthProbe && _expiresMs > Date.now()) {
              logger.info(`[browser.agent] run: DuckDB auth fast-path for ${agentId} — auth valid until ${_dbAuthRow.auth_expires_at} — skipping preflight probe`);
              _setCachedAuthCheck(agentId, false);
              _skipNavigate = true;
            } else {
              logger.info(`[browser.agent] run: DuckDB auth expired for ${agentId} (was ${_dbAuthRow.auth_expires_at}) — running preflight probe`);
            }
          }
        } catch (_dbFastPathErr) {
          logger.debug(`[browser.agent] run: DuckDB auth fast-path check failed (non-fatal): ${_dbFastPathErr.message}`);
        }
        if (!_skipNavigate) {
          logger.info(`[browser.agent] run: persistent-profile session — skipping JSON state-load, Chrome cookie store handles auth for ${agentId}`);
        }
      }
    } else if (fs.existsSync(_stateFile)) {
      logger.info(`[browser.agent] run: state file found for ${agentId} — loading persisted auth state`);
      const _loadRes = await callBrowserAct({ action: 'state-load', sessionId, timeoutMs: 10000 }, 12000).catch(() => ({ ok: false }));
      if (_loadRes?.ok !== false) {
        // Navigate after injecting cookies — probe whether the session is still valid
        const _stateNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000, headed: _silentPreflightProbe ? false : undefined }, 35000).catch(() => ({ ok: false }));
        const _stateHrefRes = _stateNav?.ok !== false
          ? await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000, headed: _silentPreflightProbe ? false : undefined }, 8000).catch((err) => {
              logger.error(`[browser.agent] auth-check eval failed (state persistence): ${err.message}`);
              return { ok: false, error: err.message };
            })
          : { ok: false, error: 'navigation failed' };
        let _stateCurHref = _stateHrefRes?.ok === false ? '' : String(_stateHrefRes?.result ?? _stateHrefRes?.stdout ?? '').trim();
        let _stateOnLogin = _isSigninWall(_stateCurHref);
        _skipNavigate = true; // already navigated above — skip the auth-check navigate below

        if (_stateOnLogin) {
          logger.info(`[browser.agent] run: state-load: initial redirect to signin for ${agentId} — waiting 3s and re-checking`);
          await new Promise(r => setTimeout(r, 3000));
          const _recheckRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
          const _recheckHref = _recheckRes?.ok === false ? '' : String(_recheckRes?.result ?? _recheckRes?.stdout ?? '').trim();
          if (!_isSigninWall(_recheckHref)) {
            logger.info(`[browser.agent] run: state-load: grace-period recheck cleared auth for ${agentId} (${_recheckHref})`);
            _stateCurHref = _recheckHref;
            _stateOnLogin = false;
          }
        }

        if (!_stateOnLogin) {
          logger.info(`[browser.agent] run: state-load: auth cleared for ${agentId} (${_stateCurHref}) — skipping waitForAuth`);
        } else {
          logger.warn(`[browser.agent] run: state-load: auth wall still present for ${agentId} after grace period — deleting stale state, re-authenticating`);
          try { fs.unlinkSync(_stateFile); } catch (_) {}
          _authNeeded = true;
        }
      } else {
        logger.warn(`[browser.agent] run: state-load failed for ${agentId} — falling back to fresh auth check`);
      }
    }

    // ── Domain continuity check: skip restart if already on target ─────────
    // Query user-memory to check if we're already on the target domain/page.
    // If so, skip daemon restart, auth checks, and recipe waypoints entirely.
    _domainContinuitySkip = false;
    let _currentBrowserUrl = null;
    try {
      const memHost = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
      const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
      const memBody = JSON.stringify({
        version: 'mcp.v1',
        service: 'user-memory',
        action: 'memory.getRecentOcr',
        payload: { maxAgeSeconds: 15 },
        context: { userId: 'local_user' }
      });
      const memRes = await new Promise((resolve, reject) => {
        const http = require('http');
        const req = http.request({ hostname: memHost, port: memPort, path: '/memory.getRecentOcr', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(memBody) }, timeout: 3000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } }); });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(memBody);
        req.end();
      });
      // MCP response format: { data: { available: true, capture: { url, appName, ... } } }
      logger.debug(`[browser.agent] domain-continuity: raw memRes keys=${Object.keys(memRes || {}).join(',')}`);
      const captureData = memRes?.data?.capture || memRes?.result?.capture;
      const isAvailable = memRes?.data?.available || memRes?.result?.available;
      logger.debug(`[browser.agent] domain-continuity: captureData=${!!captureData}, isAvailable=${isAvailable}`);
      if (isAvailable && captureData?.url) {
        _currentBrowserUrl = captureData.url;
        const currentHostname = new URL(_currentBrowserUrl).hostname;
        const startHostname = new URL(startUrl).hostname;
        logger.info(`[browser.agent] domain-continuity check: current=${currentHostname} vs start=${startHostname} (aliases=${hostAliases.join(',')})`);
        // If on same host or a configured alias, skip restart
        if (isHostAlias(currentHostname, startHostname, hostAliases)) {
          _domainContinuitySkip = true;
          logger.info(`[browser.agent] domain-continuity: MATCH - skipping browser restart`);
        } else {
          logger.info(`[browser.agent] domain-continuity: NO MATCH - will restart browser`);
        }
      } else {
        logger.info(`[browser.agent] domain-continuity: no current browser URL available (available=${isAvailable}, hasUrl=${!!captureData?.url})`);
      }
    } catch (_memErr) {
      logger.info(`[browser.agent] domain-continuity: user-memory query failed: ${_memErr.message}`);
    }

    // ── Engine-level domain continuity check ─────────────────────────────
    // User-memory OCR may be stale or unavailable, but the engine session is the
    // authoritative source of the current URL. If the engine is already on the
    // target domain, preserve it instead of restarting.
    if (!_domainContinuitySkip) {
      try {
        const _engineHrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
        if (_engineHrefRes?.ok && _engineHrefRes?.result) {
          const _engineHref = String(_engineHrefRes.result).trim().replace(/^"|"$/g, '');
          const _engineHost = (() => { try { return new URL(_engineHref).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } })();
          const _startHost = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return ''; } })();
          if (_engineHost && _startHost && isHostAlias(_engineHost, _startHost, hostAliases)) {
            _domainContinuitySkip = true;
            logger.info(`[browser.agent] domain-continuity: engine session already on ${_engineHref} for session=${sessionId} — skipping restart`);
          }
        }
      } catch (_engineContinuityErr) {
        logger.debug(`[browser.agent] domain-continuity: engine session check failed (non-fatal): ${_engineContinuityErr.message}`);
      }
    }

    // ── Skip browser restart if domain continuity detected ────────────────
    if (!_domainContinuitySkip) {
      // ── Close any existing engine session for this session ──────────────
      // Ensures the Playwright Node API engine's Chrome is properly closed,
      // not just the CLI daemon. Prevents "Opening in existing browser session"
      // when the engine tries to launch with the same profile.
      try {
        const _engineCloseRes = await callBrowserAct({ action: 'close', sessionId }, 8000).catch(() => ({ ok: false }));
        if (_engineCloseRes?.ok) logger.info(`[browser.agent] closed existing engine session for session=${sessionId}`);
      } catch (_) {}

      // ── Close any existing playwright-cli daemon for this session ──────────
      const _shortSid = shortSessionId(sessionId);
      try {
        const { spawnSync } = require('child_process');
        const _closeRes = spawnSync(findCli(), ['-s=' + _shortSid, 'close'], { timeout: 5000, encoding: 'utf8' });
        if (_closeRes.status === 0) logger.info(`[browser.agent] closed existing playwright-cli daemon for session=${sessionId} (sid=${_shortSid})`);
      } catch (_) {}

      // ── Kill existing Chrome for this profile — prevents .sock EINVAL ──────
      try {
        const _killed = killExistingChromeForProfile(sessionId);
        if (_killed) logger.info(`[browser.agent] killed existing Chrome for session=${sessionId}`);
      } catch (_killErr) {
        logger.warn(`[browser.agent] killExistingChromeForProfile error (non-fatal): ${_killErr.message}`);
      }

      // ── Clear profile lock + crash markers so fresh launch succeeds ───────
      try { clearProfileLock(sessionId); } catch (_) {}

      // ── Stale .sock cleanup — prevents EINVAL on first navigate ──────────
      try {
        const _sockDir = path.join(os.tmpdir(), 'playwright-cli');
        if (fs.existsSync(_sockDir)) {
          const _sockFiles = fs.readdirSync(_sockDir, { recursive: true }).filter(f => String(f).endsWith('.sock') && (String(f).includes(sessionId) || String(f).includes(_shortSid)));
          for (const sf of _sockFiles) {
            try { fs.unlinkSync(path.join(_sockDir, String(sf))); logger.info(`[browser.agent] cleaned stale .sock: ${sf}`); } catch (_) {}
          }
        }
      } catch (_) {}

      // ── Helper: detect Chrome session conflict errors ─────────────────────
      const _isChromeSessionConflict = (result) => {
        const errStr = String(result?.error || result?.stderr || result?.stdout || '');
        return /Opening in existing browser session/i.test(errStr) ||
               /Failed to launch the browser process/i.test(errStr) ||
               /EINVAL.*\.sock/i.test(errStr);
      };

      // UI-driven "Sign in" card (manualLogin) is an explicit auth request.
      // Set _authNeeded=true so waitForAuth is always called regardless of probe
      // result, but DON'T skip navigation — let the probe navigate to startUrl
      // first. For Google services, navigating to startUrl (e.g. calendar.google.com)
      // triggers Google's redirect to accounts.google.com/signin?continue=<startUrl>,
      // which preserves the continue parameter so Google redirects back to the
      // service after sign-in. waitForAuth then detects the browser is already on
      // the auth host and skips re-navigation, preserving the continue param.
      if (_authOnly && manualLogin === true && !_silentPreflightProbe) {
        _authNeeded = true;
      }

      // ── URL-first: resolve caller-provided URL before auth probe ──────────
      // When planSkills injects a deep-link URL (e.g. https://x.com/compose/post),
      // navigate to the TASK URL for the auth probe instead of the service homepage.
      // If the task URL loads without a login wall, the user is authenticated —
      // skip waitForAuth entirely. This is the general override mechanism that
      // prevents descriptor auth_success_pattern mismatches from blocking tasks.
      if (url && !_skipNavigate && !_authOnly && !_silentPreflightProbe) {
        try {
          const _callerUrl = new URL(url, startUrl).href;
          logger.info(`[browser.agent] run: URL-first auth probe — using caller URL ${_callerUrl} instead of ${startUrl} for ${agentId}`);
          startUrl = _callerUrl;
          _urlFirstNavigationSelected = true;
          _deepLinkSource = 'caller';
          _urlFirstProbeUsed = true;
        } catch (_) {
          logger.warn(`[browser.agent] run: caller-provided url "${url}" is invalid for auth probe — falling back to ${startUrl}`);
        }
      }

      if (!_skipNavigate) try {
        logger.info(`[browser.agent] run: playwright auth-check — navigating to ${startUrl} for ${agentId}`);
        const _probeNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000, headed: _silentPreflightProbe ? false : undefined }, 35000);

        // ── Chrome session conflict detection — fail fast ──────────────────
        if (_isChromeSessionConflict(_probeNav)) {
          logger.error(`[browser.agent] run: Chrome session conflict detected for ${agentId} — aborting (no retry)`);
          return { ok: false, agentId, task, error: 'Browser session conflict: Chrome is already running with this profile. Close existing Chrome windows for this agent or restart the app.' };
        }

        // ── SPA settle wait — give heavy SPAs time to render before auth check ──
        // domcontentloaded fires before Gmail/Notion/etc. render the inbox/app.
        // Without this wait, the LLM auth check sees an empty body and falsely
        // reports "auth required" even when auth cookies are present.
        // Wait for networkidle (preferred) or fall back to a 3s settle delay.
        if (_probeNav?.ok !== false) {
          try {
            const _settlePage = browserEngine && typeof browserEngine.getPage === 'function' ? browserEngine.getPage(sessionId) : null;
            if (_settlePage && typeof _settlePage.waitForLoadState === 'function') {
              await _settlePage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
            } else {
              await new Promise(r => setTimeout(r, 3000));
            }
          } catch (_) { /* non-fatal — proceed with eval */ }
        }

        if (_probeNav?.ok !== false) {
          const _hrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 10000, headed: _silentPreflightProbe ? false : undefined }, 13000).catch((err) => {
            logger.error(`[browser.agent] auth-check eval failed (fresh check): ${err.message}`);
            return { ok: false, error: err.message };
          });

          // ── Session health check: if eval also fails, browser is not running ──
          if (_hrefRes?.ok === false || _isChromeSessionConflict(_hrefRes)) {
            logger.error(`[browser.agent] run: browser session crashed for ${agentId} — flagging for retry`);
            return {
              ok: false,
              chromeCrash: true,
              agentId,
              task,
              error: 'Browser session crashed, will retry once',
              result: null,
              stdout: null,
            };
          }

          _curHref = String(_hrefRes?.result ?? _hrefRes?.stdout ?? '').trim();
          let _onLoginPage = _isSigninWall(_curHref);
          // Also detect domain mismatch — e.g. redirect to workspace.google.com instead of mail.google.com
          // Uses isHostAlias to allow configured host aliases (e.g. notion.so ↔ notion.com) to pass.
          let _wrongDomain = false;
          let _curHost = '';
          try {
            const _startHost = new URL(startUrl).hostname;
            _curHost   = new URL(_curHref.match(/https?:\/\//) ? _curHref : `https://${_curHref}`).hostname;
            _wrongDomain = !!_startHost && !!_curHost && !isHostAlias(_curHost, _startHost, hostAliases);
          } catch (_) {}

          // ── Auth success pattern mismatch detection ─────────────────────────────
          // The service descriptor defines the URL substring that proves the user is
          // logged in (e.g. app.slack.com/client for Slack). If the browser did not end
          // up on that URL after navigating to startUrl, auth is required — even when
          // the base domain is the same.
          let _authSuccessMismatch = false;
          if (authSuccessPattern && _curHref) {
            const _patterns = authSuccessPattern.split(/[,|]/).map(p => p.trim().toLowerCase()).filter(Boolean);
            _authSuccessMismatch = !_patterns.some(p => _authPatternMatches(_curHref, p, hostAliases));
            if (_authSuccessMismatch) {
              logger.info(`[browser.agent] run: auth-check: auth_success_pattern mismatch for ${agentId} (expected ${authSuccessPattern}, got ${_curHref})`);
            }
          }

          // ── Parking/squatter detection via live page content ───────────────────
          // Checks page title + body text for broker/parking language. This is
          // content-based (not a hostname list) so it catches any parking provider.
          let _isParkingPage = false;
          let _pageMetaLoginWall = false;
          let _pageMetaAuthed = false;
          let _pageInfo = {};
          try {
            const _pageInfoRes = await callBrowserAct({
              action: 'evaluate',
              text: `(() => {
                const title = document.title || '';
                const body   = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 800) : '';
                const links  = document.querySelectorAll('a').length;
                const titleLower = title.toLowerCase();
                const titleIsLogin = /sign.?in|log.?in|\\blogin\\b|authenticate|verify|two.factor|2fa/.test(titleLower);
                const robotsMeta = document.querySelector('meta[name="robots"]');
                const robotsContent = (robotsMeta ? robotsMeta.getAttribute('content') : '').toLowerCase();
                const isNoIndex = robotsContent.includes('noindex');
                const hasUserGlobal = !!(window.__user || window.currentUser ||
                  (window.App && window.App.user) ||
                  (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user));
                const signInLinks = document.querySelectorAll(
                  'a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="signup"], a[href*="register"]'
                );
                const signInButtons = Array.from(
                  document.querySelectorAll('button, a[role="button"], [data-testid]')
                ).filter(el => {
                  const text = (el.textContent || el.innerText || '').toLowerCase().trim();
                  return /^(sign\s*in|log\s*in|sign\s*up|register)\b/.test(text);
                });
                const hasSignInButton = signInLinks.length > 0 || signInButtons.length > 0;
                return JSON.stringify({ title, body, links, titleIsLogin, isNoIndex, hasUserGlobal, hasSignInButton });
              })()`,
              sessionId,
              timeoutMs: 5000,
              headed: _silentPreflightProbe ? false : undefined,
            }, 8000).catch(() => null);
            // browser.act evaluate auto-parses JSON, so result may already be an object.
            // JSON.parse(object) throws — handle both object and string cases.
            // Hoisted to outer scope so the tier-based fallback can read _pageInfo.hasSignInButton.
            _pageInfo = (_pageInfoRes?.ok !== false)
              ? (typeof _pageInfoRes?.result === 'object' && _pageInfoRes.result !== null)
                ? _pageInfoRes.result
                : (() => { try { return JSON.parse(String(_pageInfoRes?.result ?? '{}')); } catch (_) { return {}; } })()
              : {};
            if (_pageInfoRes?.ok !== false) {
              const _pageText = `${_pageInfo.title || ''} ${_pageInfo.body || ''}`.toLowerCase();
              const _PARKING_RE = /\bdomain\s+(for\s+sale|is\s+for\s+sale|available\s+for\s+sale)\b|\bbuy\s+this\s+domain\b|\bmake\s+an?\s+offer\b|\bparked\s+(by|domain|page)\b|\binquire\s+about\s+this\s+domain\b|\bthis\s+domain\s+(may\s+be|is)\s+(for\s+sale|available)\b/;
              if (_PARKING_RE.test(_pageText) || (Number(_pageInfo.links) < 10 && /for\s+sale|buy\s+this\s+domain|make\s+an?\s+offer|parked\s+domain/i.test(_pageText))) {
                _isParkingPage = true;
                logger.warn(`[browser.agent] run: parking/squatter content detected on ${_curHost} for ${agentId}`);
              }

              // ── Metadata-based login-wall / auth detection ────────────────────
              // Reuses the same signals already validated in browser.act waitForAuth:
              // title keywords + robots:noindex strongly indicate a login wall; a JS user
              // global strongly indicates an authenticated app. This catches marketing
              // homepages that redirect within the same base domain (e.g. Slack).
              // NOTE: This is the FALLBACK path (CDP cookie sniff unavailable). When
              // cookies are available, the cookie-first check above is authoritative.
              if (!_onLoginPage && !_wrongDomain) {
                if (_pageInfo.hasUserGlobal && !_pageInfo.hasSignInButton) {
                  // JS user global is only trustworthy when there's no "Log in" button visible.
                  // Some sites (e.g. Spotify) expose an anonymous/guest user object in
                  // __INITIAL_STATE__ even when logged out, while showing "Log in" buttons.
                  _pageMetaAuthed = true;
                  logger.info(`[browser.agent] run: auth-check JS user global detected (no sign-in button) — authenticated for ${agentId}`);
                } else if (_pageInfo.titleIsLogin || _pageInfo.isNoIndex || _pageInfo.hasSignInButton) {
                  _pageMetaLoginWall = true;
                  logger.info(`[browser.agent] run: auth-check metadata login wall for ${agentId} (title="${_pageInfo.title}" titleIsLogin=${_pageInfo.titleIsLogin} isNoIndex=${_pageInfo.isNoIndex} hasSignInButton=${_pageInfo.hasSignInButton})`);
                }
              }

              // ── LLM-based auth detection — catches landing pages not detected by URL patterns ──
              // If URL check passed but page content shows auth indicators (landing page, "sign in to continue", etc.)
              // use LLM semantic analysis to confirm before skipping auth.
              if (!_onLoginPage) {
                // Quick keyword pre-filter to avoid unnecessary LLM calls
                const _authIndicators = /sign\s*in|log\s*in|enter\s*your\s*email|workspace\s*not\s+found|where\s+should\s+we\s+begin|get\s+started|create\s+workspace|sign\s*in\s*to\s*continue/i;
                if (_authIndicators.test(_pageText)) {
                  logger.info(`[browser.agent] Auth indicators found in page content, confirming with LLM...`);
                  const _llmDetected = await _detectAuthViaLLM(_pageInfo.title || '', _pageInfo.body || '', agentId);
                  if (_llmDetected === 1) {
                    _onLoginPage = true;
                    logger.info(`[browser.agent] LLM confirmed auth required — treating as login page`);
                  }
                }
              }

              // ── Blank-page crash detection (SPA-aware) ──────────────────────────
              // If the page loaded with zero content, it could be:
              //   (a) a genuine Chrome crash — page is dead or truly blank, OR
              //   (b) a client-side SPA (React/Vue/Next.js) that hasn't hydrated yet.
              // We distinguish by checking for SPA mount points. If present, we poll
              // for content before declaring a crash. If absent, instant crash.
              if (!_pageInfo.body && Number(_pageInfo.links) === 0) {
                // ── Tier 2: Check for SPA mount points ──
                let _isSPA = false;
                try {
                  const _spaRes = await callBrowserAct({
                    action: 'evaluate',
                    text: `(() => {
                      const mount = document.querySelector('#root, #app, #__next, [data-reactroot], #___gatsby');
                      const scripts = document.querySelectorAll('script[src]').length;
                      return JSON.stringify({ hasMount: !!mount, scriptCount: scripts });
                    })()`,
                    sessionId,
                    timeoutMs: 5000,
                    headed: _silentPreflightProbe ? false : undefined,
                  }, 8000).catch(() => null);
                  const _spaInfo = (_spaRes?.ok !== false)
                    ? (typeof _spaRes?.result === 'object' && _spaRes?.result !== null)
                      ? _spaRes.result
                      : (() => { try { return JSON.parse(String(_spaRes?.result ?? '{}')); } catch (_) { return {}; } })()
                    : {};
                  _isSPA = !!(_spaInfo.hasMount || (Number(_spaInfo.scriptCount) > 0));
                  logger.info(`[browser.agent] run: blank page SPA check for ${agentId} — hasMount=${_spaInfo.hasMount} scriptCount=${_spaInfo.scriptCount} isSPA=${_isSPA}`);
                } catch (_) {}

                if (!_isSPA) {
                  // No SPA indicators — genuine blank page, declare crash immediately
                  logger.warn(`[browser.agent] run: blank page after navigation for ${agentId} (href=${_curHref}) — no SPA indicators, flagging for retry`);
                  return {
                    ok: false,
                    chromeCrash: true,
                    agentId,
                    task,
                    error: 'Browser page blank after navigation, will retry once',
                    result: null,
                    stdout: null,
                  };
                }

                // ── Tier 3: Poll for SPA hydration (up to 10s, 5 × 2s intervals) ──
                logger.info(`[browser.agent] run: SPA detected for ${agentId} — polling for hydration (up to 10s)`);
                let _hydrated = false;
                for (let _poll = 0; _poll < 5; _poll++) {
                  await new Promise(r => setTimeout(r, 2000));
                  try {
                    const _pollRes = await callBrowserAct({
                      action: 'evaluate',
                      text: `(() => {
                        const bodyText = (document.body && document.body.innerText) ? document.body.innerText.trim() : '';
                        const linkCount = document.querySelectorAll('a').length;
                        return JSON.stringify({ hasContent: bodyText.length > 0, linkCount });
                      })()`,
                      sessionId,
                      timeoutMs: 5000,
                      headed: _silentPreflightProbe ? false : undefined,
                    }, 8000);
                    const _pollInfo = (_pollRes?.ok !== false)
                      ? (typeof _pollRes?.result === 'object' && _pollRes?.result !== null)
                        ? _pollRes.result
                        : (() => { try { return JSON.parse(String(_pollRes?.result ?? '{}')); } catch (_) { return {}; } })()
                      : {};
                    if (_pollInfo.hasContent || Number(_pollInfo.linkCount) > 0) {
                      _hydrated = true;
                      logger.info(`[browser.agent] run: SPA hydrated for ${agentId} after ${(_poll + 1) * 2}s — body has content, links=${_pollInfo.linkCount}`);
                      // Re-evaluate page info so downstream auth/parking checks use hydrated content
                      const _reEvalRes = await callBrowserAct({
                        action: 'evaluate',
                        text: `(() => {
                          const title = document.title || '';
                          const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 800) : '';
                          const links = document.querySelectorAll('a').length;
                          const titleLower = title.toLowerCase();
                          const titleIsLogin = /sign.?in|log.?in|\\blogin\\b|authenticate|verify|two.factor|2fa/.test(titleLower);
                          const robotsMeta = document.querySelector('meta[name="robots"]');
                          const robotsContent = (robotsMeta ? robotsMeta.getAttribute('content') : '').toLowerCase();
                          const isNoIndex = robotsContent.includes('noindex');
                          const hasUserGlobal = !!(window.__user || window.currentUser ||
                            (window.App && window.App.user) ||
                            (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user));
                          const signInLinks = document.querySelectorAll(
                            'a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="signup"], a[href*="register"]'
                          );
                          const signInButtons = Array.from(
                            document.querySelectorAll('button, a[role="button"], [data-testid]')
                          ).filter(el => {
                            const text = (el.textContent || el.innerText || '').toLowerCase().trim();
                            return /^(sign\\s*in|log\\s*in|sign\\s*up|register)\\b/.test(text);
                          });
                          const hasSignInButton = signInLinks.length > 0 || signInButtons.length > 0;
                          return JSON.stringify({ title, body, links, titleIsLogin, isNoIndex, hasUserGlobal, hasSignInButton });
                        })()`,
                        sessionId,
                        timeoutMs: 5000,
                        headed: _silentPreflightProbe ? false : undefined,
                      }, 8000).catch(() => null);
                      _pageInfo = (_reEvalRes?.ok !== false)
                        ? (typeof _reEvalRes?.result === 'object' && _reEvalRes.result !== null)
                          ? _reEvalRes.result
                          : (() => { try { return JSON.parse(String(_reEvalRes?.result ?? '{}')); } catch (_) { return {}; } })()
                        : _pageInfo;
                      break;
                    }
                  } catch (_pollErr) {
                    // Eval threw during polling — page died, genuine crash
                    logger.warn(`[browser.agent] run: eval failed during SPA hydration poll for ${agentId} — ${_pollErr.message} — flagging crash`);
                    return {
                      ok: false,
                      chromeCrash: true,
                      agentId,
                      task,
                      error: 'Browser page crashed during SPA hydration wait, will retry once',
                      result: null,
                      stdout: null,
                    };
                  }
                }

                if (!_hydrated) {
                  // SPA never hydrated within 10s — treat as crash
                  logger.warn(`[browser.agent] run: SPA did not hydrate within 10s for ${agentId} (href=${_curHref}) — flagging for retry`);
                  return {
                    ok: false,
                    chromeCrash: true,
                    agentId,
                    task,
                    error: 'Browser page blank after 10s SPA hydration wait, will retry once',
                    result: null,
                    stdout: null,
                  };
                }
              }
            }
          } catch (_pageErr) {
            logger.warn(`[browser.agent] run: parking content check failed (non-fatal): ${_pageErr.message}`);
          }

          // ── PRIMARY: LLM-based auth detection (semantic, observation-based) ──────
          // Cookies and DOM regex are hints, not ground truth. NID (Google tracking
          // cookie) is HttpOnly but doesn't mean logged-in. "Sign in" button regex
          // doesn't match "Sign in" with a space. The LLM reads the page content
          // and semantically determines: "Is this a login/marketing page, or the
          // authenticated app?" This is the authoritative signal.
          // Cookie sniff is used as a fast-path hint — if no cookies AND LLM says
          // authed, that's fine (SPA with JS-only sessions). If cookies present but
          // LLM says auth required, the cookies are stale/tracking (e.g. NID).
          let _cookieAuthed = null; // null = unknown (CDP unavailable), true/false = result
          try {
            const _csPage = browserEngine && typeof browserEngine.getPage === 'function' ? browserEngine.getPage(sessionId) : null;
            let _csDomain = '';
            try {
              const _hrefForDomain = _curHref && _curHref.match(/^https?:\/\//) ? _curHref : startUrl;
              _csDomain = new URL(_hrefForDomain).hostname.replace(/^www\./, '');
            } catch (_) {}
            if (_csPage && _csDomain) {
              const _csResult = await _sniffAuthCookies(browserEngine, sessionId, _csPage, _csDomain);
              if (_csResult.ok) {
                _cookieAuthed = _csResult.authed;
                if (_cookieAuthed) {
                  logger.info(`[browser.agent] run: auth-check: cookie hint: auth cookies present (${_csResult.cookies.join(',')}) — confirming with LLM for ${agentId}`);
                } else {
                  logger.info(`[browser.agent] run: auth-check: cookie hint: no auth cookies (${_csResult.reason}) — checking with LLM for ${agentId}`);
                }
              }
            }
          } catch (_csErr) {
            logger.debug(`[browser.agent] run: auth-check: cookie sniff failed (non-fatal): ${_csErr.message}`);
          }

          // ── LLM auth detection (authoritative) ──────────────────────────────
          // Returns 0 = authenticated, 1 = auth required. Uses page title + body text.
          // This catches marketing pages (workspace.google.com), login walls, and
          // sign-in buttons that regex/cookie heuristics miss.
          logger.info(`[browser.agent] run: auth-check: LLM input — title="${(_pageInfo.title || '').slice(0, 100)}" bodyLen=${(_pageInfo.body || '').length} body="${(_pageInfo.body || '').slice(0, 200)}" for ${agentId}`);
          const _llmAuthResult = await _detectAuthViaLLM(_pageInfo.title || '', _pageInfo.body || '', agentId);

          if (_llmAuthResult === 0) {
            // LLM says authenticated — skip waitForAuth regardless of cookie/regex signals
            logger.info(`[browser.agent] run: auth-check: LLM says authenticated — skipping waitForAuth for ${agentId}`);
            _pageMetaAuthed = true;
            _onLoginPage = false;
            _pageMetaLoginWall = false;
            _setCachedAuthCheck(agentId, false);
          } else {
            // LLM says auth required (1) — auth needed, regardless of cookie hints
            logger.info(`[browser.agent] run: auth-check: LLM says auth required — calling waitForAuth for ${agentId}`);
            _authNeeded = true;
          }
          // Cookie hint is logged but no longer overrides the LLM decision.
          // DOM heuristic decision tree below is skipped — LLM is authoritative.

          if (!_authNeeded)
          // ── FALLBACK: DOM heuristic decision tree (only if LLM said authed) ──
          // This block handles self-heal for parking pages and domain mismatch.
          // It only runs when the LLM said authenticated (no auth needed).
          {
          // ── Internal web.agent self-heal ───────────────────────────────────────
          // Trigger ONLY for parking/squatter pages — domain mismatch (cross-domain redirect)
          // is treated as an auth redirect and goes to waitForAuth instead.
          //
          // AUTH BYPASS: If the LLM confirmed authenticated AND auth cookies are present,
          // skip the parking self-heal entirely. A real parking/squatter page cannot have
          // valid session cookies (token_v2, SID, etc.) — the user is logged in, so the
          // page is a legitimate app page that was falsely flagged by the regex.
          const _needsHeal = _isParkingPage && !(_pageMetaAuthed && _cookieAuthed === true);
          if (_isParkingPage && _pageMetaAuthed && _cookieAuthed === true) {
            logger.info(`[browser.agent] run: parking flag bypassed — LLM confirmed authenticated and auth cookies present for ${agentId} at ${_curHost}`);
          }
          if (_needsHeal && !_onLoginPage) {
            const _svcName = existing?.service || agentId.replace('.agent', '');
            const _healReason = _isParkingPage ? `parking content on ${_curHost}` : `domain mismatch (expected ${(() => { try { return new URL(startUrl).hostname; } catch(_){return startUrl;} })()}, got ${_curHost})`;
            logger.warn(`[browser.agent] run: ${_healReason} — attempting web.agent self-heal for ${agentId}`);
            let _healedUrl = null;
            try {
              const _webResult = await callSkill('web.agent', {
                action: 'search_and_navigate',
                query: `${_svcName} official website`,
                preferDomain: _svcName,
              }, 10000);
              if (_webResult?.ok && _webResult?.bestUrl) {
                _healedUrl = _webResult.bestUrl;
                logger.info(`[browser.agent] self-heal: web.agent found ${_healedUrl} for ${agentId}`);
              }
            } catch (_healErr) {
              logger.warn(`[browser.agent] self-heal: web.agent call failed: ${_healErr.message}`);
            }

            if (_healedUrl) {
              // Update startUrl and invalidate DuckDB meta cache so next run uses the correct URL
              startUrl = _healedUrl;
              try {
                await withDb(async (_db) => {
                  const _seedKey = _svcName.toLowerCase().replace(/[^a-z0-9]/g, '');
                  await _db.run('DELETE FROM browser_meta_cache WHERE service = ?', _seedKey).catch(() => {});
                });
              } catch (_) {}
              logger.info(`[browser.agent] self-heal: retrying with corrected startUrl=${startUrl}`);
              const _retryNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000).catch(() => ({ ok: false }));
              if (_retryNav?.ok !== false) {
                // Re-probe the landed URL — self-heal may have landed on a marketing/landing page
                // (e.g. proton.me/mail) rather than the authenticated inbox. Never assume
                // navigate success = auth success.
                let _healAuthNeeded = false;
                try {
                  const _healHrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
                  const _healHref = String(_healHrefRes?.result ?? _healHrefRes?.stdout ?? '').trim();
                  if (_healHref) {
                    _curHref = _healHref;
                    if (_isSigninWall(_healHref)) {
                      _healAuthNeeded = true;
                      logger.info(`[browser.agent] self-heal: corrected URL is a sign-in page by URL pattern (${_healHref}) — calling waitForAuth`);
                    } else {
                      // URL pattern didn't flag it — check page body via keyword + LLM (catches marketing/landing pages)
                      const _healPageRes = await callBrowserAct({ action: 'evaluate', text: '(() => { const title = document.title || \'\'; const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 800) : \'\'; return JSON.stringify({ title, body }); })()', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
                      // browser.act evaluate auto-parses JSON, so result may already be an object.
                      // JSON.parse(object) throws — handle both object and string cases.
                      const _healPageInfo = (typeof _healPageRes?.result === 'object' && _healPageRes.result !== null)
                        ? _healPageRes.result
                        : (() => { try { return JSON.parse(String(_healPageRes?.result ?? _healPageRes?.stdout ?? '{}')); } catch (_) { return {}; } })();
                      const _healText = `${_healPageInfo.title || ''} ${_healPageInfo.body || ''}`;
                      const _authIndicatorsRe = /sign\s*in|log\s*in|enter\s*your\s*email|workspace\s*not\s+found|where\s+should\s+we\s+begin|get\s+started|create\s+workspace|sign\s*in\s*to\s*continue|create\s+a\s+free\s+account/i;
                      if (_authIndicatorsRe.test(_healText)) {
                        logger.info(`[browser.agent] self-heal: auth indicators in page content after corrected nav — confirming with LLM for ${agentId}`);
                        const _llmDetected = await _detectAuthViaLLM(_healPageInfo.title || '', _healPageInfo.body || '', agentId);
                        if (_llmDetected === 1) {
                          _healAuthNeeded = true;
                          logger.info(`[browser.agent] self-heal: LLM confirmed auth still required after corrected nav (${_healHref}) — calling waitForAuth`);
                        }
                      }
                    }
                  }
                } catch (_healProbeErr) {
                  logger.warn(`[browser.agent] self-heal: re-probe after corrected nav failed (non-fatal): ${_healProbeErr.message}`);
                }
                if (_healAuthNeeded) {
                  _authNeeded = true;
                } else {
                  logger.info(`[browser.agent] self-heal: navigate to corrected URL succeeded and auth confirmed cleared — skipping waitForAuth`);
                  _setCachedAuthCheck(agentId, false);
                }
              } else {
                logger.warn(`[browser.agent] self-heal: corrected URL navigate failed — failing fast`);
                return { ok: false, agentId, task, wrongDomain: true, landedUrl: _curHref, expectedService: agentId, error: `Navigated to corrected URL ${startUrl} but browser failed to load it.` };
              }
            } else if (_isParkingPage) {
              // Parking page + web.agent found nothing → fail fast, recoverSkill handles it
              logger.warn(`[browser.agent] self-heal: parking page detected but no corrected URL found — returning wrongDomain error`);
              return { ok: false, agentId, task, wrongDomain: true, landedUrl: _curHref, expectedService: agentId, error: `${agentId} loaded a domain parking/squatter page at ${_curHref}. Could not automatically resolve the correct URL for "${_svcName}".` };
            } else {
              // Domain mismatch but web.agent found nothing better → this may be a valid redirect (e.g. workspace.google.com)
              // Fall through to waitForAuth as before
              logger.info(`[browser.agent] self-heal: no better URL found for domain mismatch — falling back to waitForAuth`);
              _authNeeded = true;
            }
          } else if ((_onLoginPage || _pageMetaLoginWall) && !_wrongDomain) {
            // ── CDP cookie-sniff tiebreaker ───────────────────────────────────
            // URL/title heuristics say "login wall", but the persistent profile
            // may already have valid session cookies (e.g. SPA that renders a
            // sign-in button on the dashboard even when authenticated). Sniff
            // HttpOnly cookies via CDP before declaring auth_required — avoids
            // spurious "needs login" banners. Skipped on _wrongDomain (cookies
            // for the wrong domain are irrelevant). Non-fatal on any CDP failure.
            let _cookieOverride = false;
            try {
              const _csPage = browserEngine && typeof browserEngine.getPage === 'function' ? browserEngine.getPage(sessionId) : null;
              let _csDomain = '';
              // Use actual page URL (after redirect) for cookie domain — same fix as primary sniff above.
              try {
                const _hrefForDomain = _curHref && _curHref.match(/^https?:\/\//) ? _curHref : startUrl;
                _csDomain = new URL(_hrefForDomain).hostname.replace(/^www\./, '');
              } catch (_) {}
              if (_csPage && _csDomain) {
                const _csResult = await _sniffAuthCookies(browserEngine, sessionId, _csPage, _csDomain);
                if (_csResult.ok && _csResult.authed) {
                  logger.info(`[browser.agent] run: auth-check: CDP auth cookies detected (${_csResult.cookies.join(',')}) — overriding login-wall heuristic for ${agentId}`);
                  _cookieOverride = true;
                  _pageMetaAuthed = true;
                  _onLoginPage = false;
                  _pageMetaLoginWall = false;
                }
              }
            } catch (_csErr) {
              logger.debug(`[browser.agent] run: auth-check: cookie sniff failed (non-fatal): ${_csErr.message}`);
            }
            if (_cookieOverride) {
              logger.info(`[browser.agent] run: auth-check: cookie override — skipping waitForAuth for ${agentId}`);
              _setCachedAuthCheck(agentId, false);
            } else {
              const _reason = _onLoginPage ? 'login redirect'
                : 'metadata login wall';
              logger.info(`[browser.agent] run: auth-check: ${_reason} — calling waitForAuth for ${agentId}`);
              _authNeeded = true;
            }
          } else if (_wrongDomain) {
            const _reason = _onLoginPage ? 'login redirect'
              : `domain mismatch (expected ${(() => { try { return new URL(startUrl).hostname; } catch(_){return startUrl;} })()}, got ${_curHost || _curHref})`;
            logger.info(`[browser.agent] run: auth-check: ${_reason} — calling waitForAuth for ${agentId}`);
            _authNeeded = true;
          } else if (_authSuccessMismatch && _urlFirstProbeUsed && !_pageInfo.hasSignInButton) {
            logger.info(`[browser.agent] run: auth-check: URL-first probe clean — ignoring auth_success_pattern mismatch (expected ${authSuccessPattern}, got ${_curHref}) for ${agentId}`);
            _setCachedAuthCheck(agentId, false);
          } else if (_authSuccessMismatch) {
            logger.info(`[browser.agent] run: auth-check: auth_success_pattern mismatch (expected ${authSuccessPattern}, got ${_curHref}) — calling waitForAuth for ${agentId}`);
            _authNeeded = true;
          } else if (_pageMetaAuthed) {
            logger.info(`[browser.agent] run: auth-check: metadata indicates authenticated app — skipping waitForAuth for ${agentId}`);
            _setCachedAuthCheck(agentId, false);
          } else if (_silentPreflightProbe || forceAuthProbe) {
            if (_pageInfo.hasSignInButton) {
              logger.info(`[browser.agent] run: auth-check: sign-in button detected — auth needed for ${agentId}`);
              _authNeeded = true;
            } else if (_authSuccessMismatch) {
              logger.info(`[browser.agent] run: auth-check: URL does not match auth_success_pattern — auth needed for ${agentId}`);
              _authNeeded = true;
            } else {
              logger.info(`[browser.agent] run: auth-check: no sign-in button, URL matches auth_success_pattern — authenticated for ${agentId}`);
              _setCachedAuthCheck(agentId, false);
            }
          } else {
            logger.info(`[browser.agent] run: auth-check: no login redirect${_curHref ? ` (${_curHref})` : ''} — skipping waitForAuth for ${agentId}`);
            _setCachedAuthCheck(agentId, false);
          }
          } // end DOM heuristic fallback (else block of cookie-first check)
        }
      } catch (_probeErr) {
        // Check if the thrown error is a Chrome conflict — fail fast instead of falling to waitForAuth
        if (/Opening in existing browser session/i.test(_probeErr.message) || /Failed to launch/i.test(_probeErr.message)) {
          logger.error(`[browser.agent] run: Chrome session conflict (thrown) for ${agentId} — aborting`);
          return { ok: false, agentId, task, error: 'Browser session conflict: Chrome is already running with this profile. Close existing Chrome windows for this agent or restart the app.' };
        }
        logger.warn(`[browser.agent] run: auth-check probe failed — falling back to waitForAuth: ${_probeErr.message}`);
        _authNeeded = true;
      }
    } else {
      // Domain continuity: skip auth checks and proceed directly to task
      logger.info(`[browser.agent] domain-continuity: skipping auth checks, proceeding directly to task execution`);
    }

    // ── Cookie confirmation gate for never-authenticated agents ────────────
    // When requireCookieConfirmation is set (agent has authed_at=NULL but is
    // not newly created), the URL/title heuristics may pass on a public
    // landing page even though the user is not logged in. Require CDP auth
    // cookies before allowing the probe to declare the agent authenticated.
    // This replaces the old _forceAuth guard that skipped the probe entirely.
    if (_silentPreflightProbe && !_authNeeded && requireCookieConfirmation) {
      try {
        const _csPage = browserEngine && typeof browserEngine.getPage === 'function' ? browserEngine.getPage(sessionId) : null;
        let _csDomain = '';
        try { _csDomain = new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) {}
        if (_csPage && _csDomain) {
          const _csResult = await _sniffAuthCookies(browserEngine, sessionId, _csPage, _csDomain);
          if (!_csResult.ok || !_csResult.authed) {
            logger.info(`[browser.agent] run: auth-check: no auth cookies found (requireCookieConfirmation) — auth needed for ${agentId} (reason: ${_csResult.reason || 'no-cookies'})`);
            _authNeeded = true;
          } else {
            logger.info(`[browser.agent] run: auth-check: auth cookies confirmed (${_csResult.cookies.join(',')}) — authenticated for ${agentId}`);
          }
        } else {
          logger.info(`[browser.agent] run: auth-check: cookie confirmation required but CDP unavailable — auth needed for ${agentId}`);
          _authNeeded = true;
        }
      } catch (_csErr) {
        logger.warn(`[browser.agent] run: auth-check: cookie confirmation failed — auth needed for ${agentId}: ${_csErr.message}`);
        _authNeeded = true;
      }
    }

    if (_authNeeded && skipAuth) {
      logger.info(`[browser.agent] run: login wall detected but skipAuth=true for ${agentId} — proceeding as guest`);
      _authNeeded = false;
    }

    // Silent preflight probe should never run interactive login. Signal auth needed and exit.
    if (_authNeeded && _silentPreflightProbe) {
      logger.info(`[browser.agent] run: preflightProbe detected auth-needed for ${agentId} — skipping interactive waitForAuth`);
      await callBrowserAct({ action: 'close', sessionId, headed: false }, 8000).catch(() => {});
      return { ok: false, agentId, authed: false, authRequired: true, error: 'auth required' };
    }

    if (_authNeeded) {
      let _credentials = {};
      const _manualLogin = manualLogin === true;
      if (_manualLogin) {
        logger.info(`[browser.agent] manualLogin=true for ${agentId} — skipping credential resolution/autofill`);
      } else {
        // ── Resolve stored credentials via user.agent before opening auth form ──────
        // user.agent calls profile.get which transparently decrypts SAFE: blobs so
        // waitForAuth receives plaintext email + password for form auto-fill.
        try {
          const credResult = await userAgent({ action: 'resolve_credentials', agentId });
          if (credResult?.ok && credResult.resolved) {
            _credentials = credResult.resolved;
            const emailOk = !!_credentials.email;
            const passOk  = !!_credentials.password;
            logger.info(`[browser.agent] resolved credentials for ${agentId} (email ${emailOk ? '✓' : '✗'}, password ${passOk ? '✓' : '✗'})`);
          }
        } catch (_credErr) {
          logger.warn(`[browser.agent] user.agent resolve_credentials failed (non-fatal): ${_credErr.message}`);
        }

        // ── Credential gate: prompt user if no email stored ─────────────────────
        // Fires the existing ask_user short-circuit in executeCommand.js which
        // surfaces the credential gather card and stores email/password securely.
        // The user can type "skip" to proceed with manual login instead.
        if (!_credentials.email) {
          const _credNorm = agentId.toLowerCase().replace(/\.agent$/, '');
          return {
            ok:              false,
            agentId,
            task,
            askUser:         true,
            authType:        'browser_oauth',
            question:        `What email or username do you use for ${agentId}? (It will be stored securely for future logins. Type "skip" to log in manually.)`,
            options:         [],
            needsCredentials: true,
            credentialKey:   `credential:${_credNorm}.agent:email`,
          };
        }
      }

      let authResult;
      try {
        authResult = await callBrowserAct({
          action: 'waitForAuth',
          sessionId,
          url: signInUrl || startUrl,
          currentUrl: _curHref,
          authSuccessUrl: authSuccessPattern,
          hostAliases,
          postAuthUrl,
          credentials: _credentials,
          noAutofill: _manualLogin,
          timeoutMs: _urlFirstProbeUsed ? 30 * 1000 : 2 * 60 * 1000,
          _progressCallbackUrl,
        }, _urlFirstProbeUsed ? 60 * 1000 : 3 * 60 * 1000);
      } catch (err) {
        const failureNote = `[${new Date().toISOString()}] waitForAuth threw: ${err.message} | url=${startUrl} | task=${task}`;
        logger.warn(`[browser.agent] run: waitForAuth threw for ${agentId}`);
        if (!_authOnly) {
          (async () => {
            try {
              await actionRecordFailure({ id: agentId, failureEntry: failureNote });
              const healResult = await actionValidateAgent({ id: agentId });
              logger.info(`[browser.agent] self-heal (throw): validate_agent verdict=${healResult?.verdict} for ${agentId}`);
            } catch (healErr) {
              logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
            }
          })();
        }
        if (_authOnly) {
          await callBrowserAct({ action: 'close', sessionId, headed: false }, 8000).catch(() => {});
        }
        return { ok: false, error: `waitForAuth failed: ${err.message}` };
      }
      if (!authResult?.ok) {
        const failureNote = `[${new Date().toISOString()}] waitForAuth failed: ${authResult?.error || 'timeout'} | url=${startUrl} | task=${task}`;
        logger.warn(`[browser.agent] run: auth failed for ${agentId}`);
        if (!_authOnly) {
          (async () => {
            try {
              await actionRecordFailure({ id: agentId, failureEntry: failureNote });
              const healResult = await actionValidateAgent({ id: agentId });
              logger.info(`[browser.agent] self-heal: validate_agent verdict=${healResult?.verdict} for ${agentId}`);
            } catch (healErr) {
              logger.warn(`[browser.agent] self-heal error: ${healErr.message}`);
            }
          })();
        }
        if (_authOnly) {
          await callBrowserAct({ action: 'close', sessionId, headed: false }, 8000).catch(() => {});
        }
        return { ok: false, error: `Auth failed for ${agentId}: ${authResult?.error}` };
      }
      // Persistent-profile sessions: the Chrome profile dir already persists cookies/IndexedDB.
      // JSON state-save is redundant for *_agent sessions and creates stale files that
      // interfere on next run (Google rejects injected JSON cookies). Skip it.
      _setCachedAuthCheck(agentId, false);
      // Persist auth timestamp to DuckDB so future runs can fast-path past the preflight probe.
      // Use a long expiry (365 days) — the Chrome persistent profile is the source of truth.
      // The service itself will serve a login wall when the session expires server-side,
      // which the run-path probe detects during task execution.
      (async () => {
        try {
          const _now = new Date().toISOString();
          const _expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
          await withDb(async (db) => {
            await db.run(
              `UPDATE agents SET authed_at = ?, auth_expires_at = ? WHERE id = ?`,
              _now, _expires, agentId
            );
          });
          logger.info(`[browser.agent] run: DuckDB auth record updated for ${agentId} (expires ${_expires})`);
        } catch (_dbErr) {
          logger.warn(`[browser.agent] run: DuckDB auth record update failed (non-fatal): ${_dbErr.message}`);
        }
      })();
      if (!_hasPersistentProfile) {
        logger.info(`[browser.agent] run: auth succeeded — saving browser state for ${agentId}`);
        await callBrowserAct({ action: 'state-save', sessionId, timeoutMs: 10000 }, 12000).catch(e => {
          logger.warn(`[browser.agent] run: state-save failed (non-fatal): ${e.message}`);
        });
      } else {
        logger.info(`[browser.agent] run: auth succeeded for ${agentId} — profile dir persists auth (skipping JSON state-save)`);
      }
    }
  }

  // If this is an auth-only call, stop here.
  if (_authOnly) {
    // Headless preflight probes must close the browser so it doesn't stay open between
    // preflight and actual plan execution. The persistent profile keeps cookies.
    if (_silentPreflightProbe) {
      await callBrowserAct({ action: 'close', sessionId, headed: false }, 8000).catch(() => {});
    }
    logger.info(`[browser.agent] run: auth-only call complete for ${agentId}`);
    return { ok: true, agentId, authed: true, authVerified: true, startUrl };
  }

  const _allowAutoGeneratedRecipes = process.env.THINKDROP_ALLOW_AUTOGENERATED_RECIPES === 'true';

  // ── Caller-provided URL already resolved during auth probe (URL-first) ──────
  // If _urlFirstNavigationSelected was set during the auth probe, skip the
  // redundant caller URL / deep-link resolution here. Only run deep-link
  // discovery when no caller URL was provided.
  if (!_urlFirstNavigationSelected) {
    if (url) {
      try {
        const _callerUrl = new URL(url, startUrl).href;
        logger.info(`[browser.agent] run: using caller-provided url ${_callerUrl} for ${agentId} (post-auth path)`);
        startUrl = _callerUrl;
        _urlFirstNavigationSelected = true;
        _deepLinkSource = 'caller';
      } catch (_) {
        logger.warn(`[browser.agent] run: caller-provided url "${url}" is invalid — ignoring`);
      }
    } else {
    // ── Task-specific deep-link resolution ─────────────────────────────────────
    const _deepLinkResult = await _resolveTaskDeepLink(agentId, _svcKey, startUrl, task, null, sessionId);
    const _deepLink = _deepLinkResult?.url || (typeof _deepLinkResult === 'string' ? _deepLinkResult : null);
    _deepLinkSource = _deepLinkResult?.source || null;
    _deepLinkIntent = _deepLinkResult?.intent || null;
    if (_deepLink) {
      startUrl = _deepLink;
      _urlFirstNavigationSelected = true;
    } else {
      const _taskIntent = await classifyTaskIntent(task, _svcKey);
      if (_isMutationIntent(_taskIntent)) {
        const trainerAgent = require('./trainer.agent.cjs');
        const recipe = trainerAgent.findMatchingRecipe(agentId.replace('.agent', ''), task, { allowAutoGenerated: _allowAutoGeneratedRecipes });
        if (!recipe) return {
          ok: false,
          agentId,
          task,
          sessionId,
          askUser: true,
          trainingHandoff: true,
          question: `I couldn't find a direct route for this task in ${_svcKey}. Would you like to train a recipe?`,
          options: [
            { label: `Record ${_svcKey} recipe from beginning`, value: 'record_recipe' },
            { label: 'Cancel', value: 'cancel' },
          ],
        };
      }
    }
  }
  }

  // ── URL-first: enforce navigation to resolved deep-link ──────────────────────
  // After the auth probe + deep-link resolution, the browser may still be on the
  // auth-probe URL (e.g. app.notion.com) instead of the resolved deep-link (e.g.
  // notion.new). If URL-first was selected, check the current URL and navigate to
  // startUrl unless the current page is genuinely a fresh redirect from the shortcut.
  let _postEnforcementUrl = undefined;
  if (_urlFirstNavigationSelected && startUrl) {
    try {
      const _curUrlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
      const _curUrl = _curUrlRes?.ok ? String(_curUrlRes.result || _curUrlRes.stdout || '').trim().replace(/^"|"$/g, '') : '';

      if (_curUrl) {
        let _isCanonicalRedirect = false;
        try {
          const _startU = new URL(startUrl);
          const _curU = new URL(_curUrl);
          // Exact match — must include hash fragment so that SPA hash-router URLs
          // like #inbox and #inbox?compose=new are NOT treated as identical.
          if (_startU.hostname === _curU.hostname
              && _startU.pathname === _curU.pathname
              && _startU.hash === _curU.hash) {
            _isCanonicalRedirect = true;
          } else if (_startU.hostname.endsWith('.new') || _startU.hostname === 'new') {
            // *.new shortcut domains (notion.new → app.notion.com/<page-id>)
            // Must verify this is actually a fresh page from the shortcut, not an
            // existing page the auth probe happened to land on.
            const _brand = _startU.hostname.split('.').slice(-2, -1)[0];
            if (_brand && _curU.hostname.includes(_brand)) {
              // URL-shape check: existing pages have readable slugs (e.g., /p/Yearly-Goals-<id>)
              // Fresh pages have raw IDs or "Untitled" in the path
              const _lastSegment = _curU.pathname.split('/').pop() || '';
              const _slugParts = _lastSegment.split('-');
              const _hasReadableSlug = _slugParts.length >= 2
                && /^[a-z]{4,}$/i.test(_slugParts[0])
                && _slugParts[0].toLowerCase() !== 'untitled';
              if (_hasReadableSlug) {
                // Readable slug means the page already exists (e.g., /p/Weekly-Goals-<id>).
                // Check if the slug matches the goal/task name — if so, stay on this page
                // instead of re-navigating to the creation URL (which would create a duplicate).
                const _goalWords = (task || '').toLowerCase()
                  .replace(/['"]/g, '').replace(/[^\w\s]/g, ' ')
                  .split(/\s+/).filter(w => w.length >= 4 && !['with', 'under', 'page', 'list', 'block', 'items', 'three', 'sample', 'create', 'titled', 'called'].includes(w));
                const _slugLower = _lastSegment.toLowerCase();
                const _slugMatchesGoal = _goalWords.some(w => _slugLower.includes(w));
                if (_slugMatchesGoal) {
                  _isCanonicalRedirect = true; // already on the created page — skip navigation
                  logger.info(`[browser.agent] run: URL-first enforcement — current URL slug matches goal ("${_slugParts[0]}"), staying on ${_curUrl} (not re-navigating to ${startUrl})`);
                } else {
                  _isCanonicalRedirect = false;
                  logger.info(`[browser.agent] run: URL-first enforcement — current URL has readable slug "${_slugParts[0]}" but doesn't match goal — navigating to ${startUrl}`);
                }
              } else {
                // URL looks like a fresh page, but also check the page title to be sure
                const _titleRes = await callBrowserAct({ action: 'evaluate', text: '(document.title || "")', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
                const _pageTitle = _titleRes?.ok ? String(_titleRes.result || '').trim().replace(/^"|"$/g, '') : '';
                // Browser tab titles often include the app name suffix: "New page | Notion",
                // "Untitled document - Google Docs", "Untitled spreadsheet - Google Sheets".
                // Match the prefix, not the full title.
                const _titleLower = _pageTitle.toLowerCase();
                const _isFreshTitle = !_pageTitle
                  || _titleLower === 'untitled'
                  || _titleLower === 'new page'
                  || _titleLower.startsWith('new page ')
                  || _titleLower.startsWith('new page|')
                  || _titleLower.startsWith('new page |')
                  || _titleLower.startsWith('untitled ')        // "Untitled document - Google Docs"
                  || _titleLower.startsWith('untitled-')        // "Untitled-document"
                  || _titleLower.startsWith('untitled|')        // "Untitled|Google Docs"
                  || _titleLower.startsWith('untitled |')       // "Untitled | Google Docs"
                  || _titleLower === _brand;
                _isCanonicalRedirect = _isFreshTitle;
                if (!_isFreshTitle) {
                  logger.info(`[browser.agent] run: URL-first enforcement — page title "${_pageTitle}" indicates existing page, not a fresh redirect from ${startUrl}`);
                }
              }
            }
          } else {
            const _startBase = _startU.hostname.split('.').slice(-2).join('.');
            const _curBase = _curU.hostname.split('.').slice(-2).join('.');
            if (_startBase === _curBase) {
              if (_startU.hostname !== _curU.hostname) {
                _isCanonicalRedirect = true;
              } else if (_curU.pathname.length > _startU.pathname.length) {
                _isCanonicalRedirect = true;
              }
            }
          }
        } catch (_) {}

        // Check if already on target (exact match after normalizing trailing slashes).
        // IMPORTANT: Preserve hash fragments — Gmail uses hash-router SPA URLs like
        // #inbox?compose=new where the query param is INSIDE the hash. Stripping all
        // query strings (split('?')[0])) would incorrectly make #inbox and
        // #inbox?compose=new look identical, skipping navigation to the compose view.
        // Use URL parsing to compare origin + pathname + hash, ignoring only top-level
        // search params (tracking tokens, session params) that don't affect page state.
        //
        // This block can BOTH set and clear _isCanonicalRedirect — if the first block
        // (hostname+pathname only) incorrectly set it to true for URLs that differ in
        // hash, this block overrides it to false so navigation still occurs.
        try {
          const _neCur = new URL(_curUrl);
          const _neStart = new URL(startUrl);
          const _normPath = (u) => u.pathname.replace(/\/+$/, '') || '/';
          if (_neCur.origin === _neStart.origin
              && _normPath(_neCur) === _normPath(_neStart)
              && _neCur.hash === _neStart.hash) {
            _isCanonicalRedirect = true;
          } else if (_neCur.origin === _neStart.origin
              && _normPath(_neCur) === _normPath(_neStart)
              && _neCur.hash !== _neStart.hash) {
            // Same origin + path but DIFFERENT hash — the first block may have
            // incorrectly set _isCanonicalRedirect=true (it only checked
            // hostname+pathname). Override to false so we navigate to the
            // correct hash-route (e.g. #inbox → #inbox?compose=new).
            _isCanonicalRedirect = false;
          }
        } catch (_) {
          // Fallback: raw comparison without stripping query (preserves hash params)
          if (_curUrl.replace(/\/+$/, '') === startUrl.replace(/\/+$/, '')) {
            _isCanonicalRedirect = true;
          }
        }

        if (!_isCanonicalRedirect) {
          logger.info(`[browser.agent] run: URL-first enforcement — navigating from ${_curUrl} to ${startUrl} for ${agentId}`);
          const _enforceNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000);
          if (_enforceNav?.ok !== false) {
            // Wait for SPA hydration (up to 6s, 3 × 2s polls)
            let _hydrated = false;
            for (let _poll = 0; _poll < 3; _poll++) {
              await new Promise(r => setTimeout(r, 2000));
              const _pollTextRes = await callBrowserAct({ action: 'evaluate', text: '(document.body && document.body.innerText ? document.body.innerText.length : 0)', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
              const _pollTextLen = _pollTextRes?.ok ? Number(_pollTextRes.result) : 0;
              if (_pollTextLen > 50) { _hydrated = true; break; }
            }
            logger.info(`[browser.agent] run: URL-first enforcement — navigation complete${_hydrated ? ' (SPA hydrated)' : ' (hydration uncertain)'} for ${agentId}`);

            // ── Gmail compose dialog readiness check ─────────────────────────────
            // Gmail is a hash-router SPA. Navigating to #inbox?compose=new should
            // open a compose dialog, but Gmail may silently drop the ?compose=new
            // param or fail to render the dialog. Verify the compose dialog is
            // actually present before handing off to playwright.agent. If not, retry
            // navigation once. This prevents the agent from spending its entire
            // timeout trying to fill a To field that doesn't exist on the inbox.
            const _isGmailComposeUrl = /mail\.google\.com.*compose=new/.test(startUrl);
            if (_isGmailComposeUrl) {
              const _composeCheckExpr = "(!!(document.querySelector('div[role=dialog] [contenteditable], div[role=dialog] [role=textbox], div[role=dialog] textarea, div[role=dialog] input[name=to], textarea[name=to]') || document.querySelector('div[role=dialog] form')))";
              let _composeReady = false;
              for (let _cPoll = 0; _cPoll < 5; _cPoll++) {
                const _composeRes = await callBrowserAct({ action: 'evaluate', text: _composeCheckExpr, sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
                if (_composeRes?.ok && (_composeRes.result === true || _composeRes.result === 'true')) {
                  _composeReady = true;
                  break;
                }
                await new Promise(r => setTimeout(r, 1000));
              }
              if (!_composeReady) {
                logger.warn(`[browser.agent] run: URL-first enforcement — Gmail compose dialog not detected after navigation, retrying once for ${agentId}`);
                await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000).catch(() => {});
                await new Promise(r => setTimeout(r, 3000));
                const _retryRes = await callBrowserAct({ action: 'evaluate', text: _composeCheckExpr, sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
                _composeReady = _retryRes?.ok && (_retryRes.result === true || _retryRes.result === 'true');
              }
              logger.info(`[browser.agent] run: URL-first enforcement — Gmail compose dialog ${_composeReady ? 'ready' : 'NOT detected (proceeding anyway)'} for ${agentId}`);
            }

            // Read the actual post-navigation URL (may differ from startUrl due to redirect)
            const _postUrlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
            const _actualPostUrl = _postUrlRes?.ok ? String(_postUrlRes.result || _postUrlRes.stdout || '').trim().replace(/^"|"$/g, '') : startUrl;
            // For compose deep-links, always pass the intended startUrl to playwright.agent
            // (not the post-navigation URL which Gmail may have normalized by stripping
            // ?compose=new from the hash). This ensures playwright.agent knows the compose
            // intent and can verify the dialog is open.
            _postEnforcementUrl = _isGmailComposeUrl ? startUrl : _actualPostUrl;
          } else {
            logger.warn(`[browser.agent] run: URL-first enforcement — navigation to ${startUrl} failed for ${agentId}`);
            _postEnforcementUrl = startUrl;
          }
        } else {
          // URL looks canonical — but verify with LLM that this is actually the
          // authenticated app, not a marketing/landing redirect (e.g. calendar.google.com
          // redirects to workspace.google.com/products/calendar/ which looks canonical
          // but is a marketing page, not the app).
          let _llmSaysAuthRequired = false;
          try {
            const _enforcePageRes = await callBrowserAct({
              action: 'evaluate', sessionId, timeoutMs: 5000,
              text: `(() => { return JSON.stringify({ title: document.title || '', body: (document.body && document.body.innerText ? document.body.innerText.slice(0, 800) : '') }); })()`
            }, 8000).catch(() => ({ ok: false }));
            const _enforcePageData = (typeof _enforcePageRes?.result === 'object' && _enforcePageRes.result !== null)
              ? _enforcePageRes.result
              : (() => { try { return JSON.parse(String(_enforcePageRes?.result ?? '{}')); } catch (_) { return {}; } })();
            const _enforceLlmResult = await _detectAuthViaLLM(_enforcePageData.title || '', _enforcePageData.body || '', agentId);
            if (_enforceLlmResult === 1) {
              _llmSaysAuthRequired = true;
              logger.info(`[browser.agent] run: URL-first enforcement — LLM detected marketing/login page at ${_curUrl} — will navigate to ${startUrl} for ${agentId}`);
            }
          } catch (_) {}

          if (_llmSaysAuthRequired) {
            // Page is a marketing/login redirect — navigate to the real startUrl
            logger.info(`[browser.agent] run: URL-first enforcement — navigating from marketing page ${_curUrl} to ${startUrl} for ${agentId}`);
            const _enforceNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000);
            if (_enforceNav?.ok !== false) {
              await new Promise(r => setTimeout(r, 2000));
              const _postUrlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
              _postEnforcementUrl = _postUrlRes?.ok ? String(_postUrlRes.result || '').trim().replace(/^"|"$/g, '') : startUrl;
            } else {
              _postEnforcementUrl = startUrl;
            }
          } else {
            logger.info(`[browser.agent] run: URL-first enforcement — already on canonical URL ${_curUrl} (LLM confirmed authenticated app) — skipping re-navigation for ${agentId}`);
            _postEnforcementUrl = _curUrl;
          }
        }
      } else {
        // Engine is not active (closed after auth) — navigate to startUrl
        // which will re-launch the engine via _ensureEngine.
        // Without this, URL-first sets the flag but never navigates, leaving
        // tab-map and playwright.agent fallthrough with no browser open.
        logger.info(`[browser.agent] run: URL-first enforcement — engine not active (no current URL), navigating to ${startUrl} for ${agentId}`);
        const _enforceNav = await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000);
        if (_enforceNav?.ok !== false) {
          // Wait for SPA hydration (up to 6s, 3 × 2s polls)
          let _hydrated = false;
          for (let _poll = 0; _poll < 3; _poll++) {
            await new Promise(r => setTimeout(r, 2000));
            const _pollTextRes = await callBrowserAct({ action: 'evaluate', text: '(document.body && document.body.innerText ? document.body.innerText.length : 0)', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
            const _pollTextLen = _pollTextRes?.ok ? Number(_pollTextRes.result) : 0;
            if (_pollTextLen > 50) { _hydrated = true; break; }
          }
          logger.info(`[browser.agent] run: URL-first enforcement — navigation complete${_hydrated ? ' (SPA hydrated)' : ' (hydration uncertain)'} for ${agentId}`);

          // Gmail compose dialog readiness check (same as _curUrl branch)
          const _isGmailComposeUrl = /mail\.google\.com.*compose=new/.test(startUrl);
          if (_isGmailComposeUrl) {
            const _composeCheckExpr = "(!!(document.querySelector('div[role=dialog] [contenteditable], div[role=dialog] [role=textbox], div[role=dialog] textarea, div[role=dialog] input[name=to], textarea[name=to]') || document.querySelector('div[role=dialog] form')))";
            let _composeReady = false;
            for (let _cPoll = 0; _cPoll < 5; _cPoll++) {
              const _composeRes = await callBrowserAct({ action: 'evaluate', text: _composeCheckExpr, sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
              if (_composeRes?.ok && (_composeRes.result === true || _composeRes.result === 'true')) {
                _composeReady = true;
                break;
              }
              await new Promise(r => setTimeout(r, 1000));
            }
            if (!_composeReady) {
              logger.warn(`[browser.agent] run: URL-first enforcement — Gmail compose dialog not detected after navigation, retrying once for ${agentId}`);
              await callBrowserAct({ action: 'navigate', sessionId, url: startUrl, timeoutMs: 30000 }, 35000).catch(() => {});
              await new Promise(r => setTimeout(r, 3000));
              const _retryRes = await callBrowserAct({ action: 'evaluate', text: _composeCheckExpr, sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
              _composeReady = _retryRes?.ok && (_retryRes.result === true || _retryRes.result === 'true');
            }
            logger.info(`[browser.agent] run: URL-first enforcement — Gmail compose dialog ${_composeReady ? 'ready' : 'NOT detected (proceeding anyway)'} for ${agentId}`);
          }

          _postEnforcementUrl = startUrl;
        } else {
          logger.warn(`[browser.agent] run: URL-first enforcement — navigation to ${startUrl} failed for ${agentId}`);
          _postEnforcementUrl = startUrl;
        }
      }
    } catch (_enforceErr) {
      logger.warn(`[browser.agent] run: URL-first enforcement error (non-fatal): ${_enforceErr.message}`);
    }
  }

  // ── URL-first validation: reject non-app subdomains ────────────────────────
  // If URL-first navigation landed on a blog/newsroom/support subdomain instead
  // of the service's app domain, fall back to the canonical app domain. This
  // prevents web search from sending the agent to newsroom.spotify.com when the
  // task is to create a playlist on open.spotify.com.
  if (_urlFirstNavigationSelected && _postEnforcementUrl) {
    try {
      const _postHost = new URL(_postEnforcementUrl).hostname.replace(/^www\./, '');
      const _svcEntry = lookupBrowserService(_svcKey || '');
      const _appDomain = _svcEntry?.start_url ? new URL(_svcEntry.start_url).hostname.replace(/^www\./, '') : null;
      const _nonAppSubdomains = ['newsroom', 'blog', 'support', 'help', 'docs', 'developer', 'fortherecord', 'investor', 'press', 'news', 'community'];
      const _subdomain = _postHost.split('.')[0].toLowerCase();
      if (_appDomain && _postHost !== _appDomain && !_postHost.endsWith('.' + _appDomain) && _nonAppSubdomains.includes(_subdomain)) {
        logger.warn(`[browser.agent] URL-first validation: ${_postHost} is a non-app subdomain — falling back to https://${_appDomain}`);
        const _fallbackUrl = `https://${_appDomain}`;
        try {
          await callBrowserAct({ action: 'navigate', url: _fallbackUrl, sessionId, timeoutMs: 30000 }, 60000);
          _postEnforcementUrl = _fallbackUrl;
          startUrl = _fallbackUrl;
          logger.info(`[browser.agent] URL-first validation: navigated to canonical app domain ${_fallbackUrl}`);
        } catch (_navErr) {
          logger.warn(`[browser.agent] URL-first validation: fallback navigation failed: ${_navErr.message}`);
        }
      }
    } catch (_) {}
  }

  // ── Proactive search-syntax discovery ───────────────────────────────────────
  // For search/filter/count-style tasks, discover the service's query operators
  // (e.g. Gmail's "is:unread") ahead of planning so the LLM can compose an
  // accurate filtered query instead of guessing read/unread state from text.
  // No-op (fast) once cached for this hostname.
  {
    const _searchSyntaxHost = (() => {
      try { return new URL(startUrl).hostname.replace(/^www\./, ''); }
      catch (_) { return null; }
    })();
    if (_searchSyntaxHost) {
      await _discoverSearchSyntax(_svcKey, _searchSyntaxHost, task);
    }
  }

  // Emit tier progress: URL-first navigation complete
  _postProgress(_progressCallbackUrl, {
    type: 'agent:tier',
    stepIndex: _stepIndex ?? 0,
    tier: 'url-first',
    message: `URL-first: navigated to ${startUrl}`,
    agentId,
    sessionId,
  });

  // Phase 5: Recipe replay and URL-first navigation are no longer mutually exclusive.
  // URL-first provides the initial URL; recipe replay can still run for non-navigation
  // waypoints (clicks, fills, etc.). The recipe's navigate waypoints are skipped if
  // URL-first already landed on the right page (domain continuity check handles this).
  const _skipDeterministicRecipeReplay = false;
  if (_urlFirstNavigationSelected) {
    logger.info(`[browser.agent] run: URL-first selected for ${agentId} — recipe replay will run for non-navigation waypoints`);
  }

  // Step 2: delegate to playwright.agent or agentbrowser.agent with the authenticated session
  logger.info(`[browser.agent] run: auth ok — delegating to ${_agentSkill} for "${task}"`);

  // ── Dynamic turn budget ──────────────────────────────────────────────────────
  // Calculate maxTurns based on task complexity instead of a hardcoded 15.
  // Formula: base 8 + (sub-task indicators × 6) + (quoted search terms × 4), capped at 40.
  // Sub-task indicators: "then", "next", "finally", numbered steps, semicolons in instructions.
  // Quoted terms: each quoted string is a search/entry action needing ~4 turns.
  function _calcMaxTurns(taskText) {
    const _base = 8;
    // Count sub-task indicators (transition words + semicolons + numbered steps)
    const _transitionWords = (taskText.match(/\bthen\b|\bnext\b|\bfinally\b|\bafter\b/gi) || []).length;
    const _semicolons = (taskText.match(/;/g) || []).length;
    const _numberedSteps = (taskText.match(/\b\d+\.\s/g) || []).length;
    const _subTaskIndicators = Math.max(_transitionWords, _semicolons, _numberedSteps);
    // Count quoted search terms (each needs ~4 turns: type, enter, click result, interact)
    const _quotedTerms = (taskText.match(/["'][^"']{2,80}["']/g) || []).length;
    const _turns = Math.min(_base + (_subTaskIndicators * 6) + (_quotedTerms * 4), 40);
    logger.info(`[browser.agent] dynamic turn budget: base=${_base} subTasks=${_subTaskIndicators} quotedTerms=${_quotedTerms} → maxTurns=${_turns}`);
    return _turns;
  }
  const _dynamicMaxTurns = _calcMaxTurns(task);

  // ── preTaskGoal injection + startUrl recovery anchor ────────────────────────
  // Some services (e.g. googleaimode) require a UI interaction BEFORE the main task.
  // All services get a recovery anchor so playwright.agent knows where to return if
  // the session goes blank (about:blank) — it must navigate back to startUrl, NOT
  // invent its own fallback destination (e.g. google.com search).
  const _recoveryAnchor = startUrl
    ? `IMPORTANT: You are working on ${startUrl} (browser session: ${sessionId}). If the page ever shows about:blank, a blank page, a 404 / "Page not found" error, or you lose the site, navigate back to ${startUrl} immediately — do NOT navigate to any other website as a fallback.`
    : null;
  const _effectiveTask = _svcInfo?.preTaskGoal
    ? `${_svcInfo.preTaskGoal}\n\nTask: ${task}`
    : _recoveryAnchor
      ? `${_recoveryAnchor}\n\nTask: ${task}`
      : task;

  // ── Goal-aware playbook injection ────────────────────────────────────────────
  // Tier 1: semantic embedding match → best ### section(s) injected directly.
  //         Uses /memory.embed (user-memory service) + local cosine similarity.
  //         Falls back to keyword scan if embedding service is unavailable.
  //         Compound tasks get all sections above the similarity threshold.
  // Tier 2: no match → inject 2 seeded sections as FORMAT EXAMPLES + a NOVEL TASK
  //         comment so playwright.agent reasons from the live snapshot. 0 LLM calls,
  //         0 added latency. Async COT write-back fires after success to cache for next run.
  // Tier 3: no playbook sections exist yet → inject core descriptor only (bare agent).
  let _agentContext   = undefined;
  let _playbookTier   = 3;        // tracked for post-execution write-back decision
  if (existing.descriptor) {
    const _coreDescriptor = existing.descriptor.replace(/\n## Playbooks[\s\S]*/m, '').trim();
    const _playbook = await _resolvePlaybookSemantic(agentId, existing.descriptor, task);
    let _matchedPlaybook = null;

    if (_playbook.tier === 1) {
      // Tier 1: direct match (possibly multiple sections for compound tasks)
      _matchedPlaybook = _playbook.section;
      _playbookTier    = 1;
      const headers = _playbook.section.match(/^### .+/gm) || [];
      logger.info(`[browser.agent] playbook: tier-1 match (${headers.length} section(s)) for ${agentId} — ${headers.map(h => `"${h}"`).join(', ')}`);

      // Check for DELEGATE_TO directive — special playbooks that delegate to other skills
      const delegateMatch = _matchedPlaybook.match(/DELEGATE_TO:\s*(\S+)/);
      if (delegateMatch) {
        const delegateSkill = delegateMatch[1];
        const platformMatch = _matchedPlaybook.match(/PLATFORM:\s*(\S+)/);
        const platform = platformMatch ? platformMatch[1] : serviceKey;

        // Pure search/lookup tasks should stay in browser.agent instead of being handed to video.agent.
        // e.g. "search YouTube for sourdough bread tutorials" should use the Search Videos playbook.
        if (delegateSkill === 'video.agent' && _isPureSearchTask(task)) {
          logger.info(`[browser.agent] run: pure search task detected for ${agentId} — keeping in browser.agent, skipping video.agent delegation`);
          _matchedPlaybook = _matchedPlaybook
            .split(/(?=\n### )/)
            .filter(block => !block.includes('DELEGATE_TO: video.agent'))
            .join('');
        } else if (delegateSkill === 'video.agent') {
          // Strip instruction noise before passing to video.agent.
          // Task like "watch X, extract the key steps, then summarize" → "X"
          // Only the video identity part (title/creator) should reach the search.
          const _videoQuery = task
            .replace(/,.*$/s, '')                                   // drop everything after first comma
            .replace(/;\s*.*/s, '')                                  // drop everything after semicolon
            .replace(/^(?:watch|find|play|open|show|get|look up|navigate to|go to)\s+/i, '') // leading verb
            .replace(/\s+(?:and|then)\s+.*$/i, '')                  // trailing "and/then ..."
            .trim() || task;
          logger.info(`[browser.agent] run: delegating to video.agent for ${agentId} — query="${_videoQuery.slice(0, 80)}"`);
          try {
            const videoResult = await callSkill('video.agent', {
              action: 'find_and_watch_tutorial',
              platform: platform,
              query: _videoQuery,
              goal: task,
            }, 120000);

            if (videoResult?.ok) {
              logger.info(`[browser.agent] run: video.agent completed successfully`);
              return {
                ok: true,
                agentId,
                task,
                result: videoResult.result || videoResult.data || videoResult,
                delegated: 'video.agent',
              };
            } else {
              logger.warn(`[browser.agent] run: video.agent failed — ${videoResult?.error || 'unknown error'}`);
              return {
                ok: false,
                agentId,
                task,
                error: videoResult?.error || 'video.agent delegation failed',
                delegated: 'video.agent',
              };
            }
          } catch (videoErr) {
            logger.error(`[browser.agent] run: video.agent error — ${videoErr.message}`);
            return {
              ok: false,
              agentId,
              task,
              error: `video.agent error: ${videoErr.message}`,
              delegated: 'video.agent',
            };
          }
        }
      }

    } else if (_playbook.subsections.length > 0) {
      // Tier 2: no keyword match but we have seed sections to use as format references.
      // Inject the 2 shortest (most focused) sections as few-shot examples so playwright.agent
      // understands action vocabulary and output format — then let it reason from the live snapshot.
      const formatExamples = [..._playbook.subsections]
        .sort((a, b) => a.length - b.length)
        .slice(0, 2)
        .join('\n\n');
      _matchedPlaybook = `<!-- NOVEL TASK: no direct playbook match for this goal.\n` +
        `Take a snapshot first, then reason from the live DOM to accomplish the goal.\n` +
        `The sections below are FORMAT EXAMPLES ONLY — do not follow their steps literally.\n` +
        `Available actions: click, dblclick, hover, drag, fill, type, select, check, uncheck, upload,\n` +
        `press, keydown, keyup, navigate, go-back, reload, tab-new, tab-select, tab-close,\n` +
        `snapshot (after every DOM change), screenshot, eval, run-code, dialog-accept, dialog-dismiss,\n` +
        `mousewheel (scroll), return -->\n\n` +
        formatExamples;
      _playbookTier = 2;
      logger.info(`[browser.agent] playbook: tier-2 format-reference for ${agentId} — novel goal="${task.slice(0, 60)}"`);

    } else {
      // Tier 3: no playbook sections at all — bare core descriptor
      _playbookTier = 3;
      logger.info(`[browser.agent] playbook: tier-3 core-only for ${agentId} — no playbook sections exist yet`);
    }

    // ── Substitute playbook placeholders (e.g., <encoded_query>) ─────────────
    // Extract query from task and substitute into playbook templates
    if (_matchedPlaybook && task) {
      // Extract query from patterns like "search youtube for X", "find X videos", etc.
      const queryMatch = task.match(/(?:search|find|lookup)\s+(?:youtube|videos?\s+(?:about|for|on))\s+for\s+(.+)$/i) ||
                         task.match(/(?:search|find|lookup)\s+(?:youtube|videos?\s+(?:about|for|on))\s+(.+)$/i) ||
                         task.match(/(?:search|find)\s+for\s+(.+?)\s+(?:on\s+youtube|videos)/i) ||
                         task.match(/(?:watch|find)\s+(.+?)\s+(?:video|tutorial)/i) ||
                         task.match(/(?:how\s+to|what\s+is)\s+(.+)$/i);
      
      if (queryMatch) {
        const rawQuery = queryMatch[1].trim();
        // Remove trailing punctuation and common suffixes
        const cleanQuery = rawQuery
          .replace(/\s+(?:video|videos|tutorial|tutorials)\s*$/i, '')
          .replace(/[?.!]+$/, '')
          .trim();
        
        if (cleanQuery) {
          const encodedQuery = encodeURIComponent(cleanQuery).replace(/%20/g, '+');
          const originalPlaybook = _matchedPlaybook;
          _matchedPlaybook = _matchedPlaybook.replace(/<encoded_query>/g, encodedQuery);
          
          if (_matchedPlaybook !== originalPlaybook) {
            logger.info(`[browser.agent] playbook: substituted <encoded_query> with "${cleanQuery.slice(0, 40)}"`);
          }
        }
      }
    }

    _agentContext = (_coreDescriptor + (_matchedPlaybook ? '\n\n## Playbooks\n' + _matchedPlaybook : '')).slice(0, 3000);
  }

  // ── Inject installed domain skills into _agentContext ───────────────────────
  // Load atomic skills for this agent's service domain and surface them to playwright.agent
  // so it can plan external_skill steps alongside browser.act steps.
  const _domainForSkills = existing?.service || agentId.replace('.agent', '');
  try {
    const SKILLS_BASE = path.join(os.homedir(), '.thinkdrop', 'skills');
    if (fs.existsSync(SKILLS_BASE)) {
      const skillDirs = fs.readdirSync(SKILLS_BASE).filter(d =>
        fs.existsSync(path.join(SKILLS_BASE, d, 'skill.json'))
      );
      const domainSkills = [];
      for (const d of skillDirs) {
        try {
          const sj = JSON.parse(fs.readFileSync(path.join(SKILLS_BASE, d, 'skill.json'), 'utf8'));
          const skillDomain = sj.source_domain || sj.agent_id?.replace('.agent', '') || '';
          if (!skillDomain) continue;
          // Match if skill's domain contains the agent service name or vice-versa
          if (skillDomain.includes(_domainForSkills) || _domainForSkills.includes(skillDomain)) {
            if (!sj.goal_tied) continue; // only surface goal_tied atomics as building blocks
            domainSkills.push({ name: d, description: sj.description || sj.source_action || d, sourceAction: sj.source_action || '' });
          }
        } catch (_) {}
      }
      if (domainSkills.length > 0) {
        const skillsNote = `\n\n## Available Atomic Skills (use external_skill action for these exact sub-tasks)\n` +
          domainSkills.map(s => `- ${s.name}: ${s.description}`).join('\n');
        _agentContext = (_agentContext + skillsNote).slice(0, 3500);
        logger.info(`[browser.agent] run: injected ${domainSkills.length} domain skill(s) for ${_domainForSkills} into context`);
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Trained recipe injection (guided agentic mode) ──────────────────────────
  // If the user's task matches a trained skill recipe (fuzzy: dots/spaces/underscores),
  // inject the waypoint recipe as navigation guidance for playwright.agent.
  // The recipe provides ordered waypoints so the agent knows WHERE to navigate,
  // then the user's actual task tells it WHAT to do once there.
  let _trainedRecipeInjected = false;
  try {
    const trainerAgent = require('./trainer.agent.cjs');
    const _agentIdClean = agentId.replace('.agent', '');
    // Try fuzzy match on task text first, then fall back to single-recipe auto-inject
    let recipe = trainerAgent.findMatchingRecipe(_agentIdClean, task, { allowAutoGenerated: _allowAutoGeneratedRecipes });
    if (!recipe) {
      // Fallback: if this agent has exactly 1 trained recipe, auto-inject it
      const allSkills = trainerAgent.actionListSkills({ agentId: _agentIdClean });
      const eligibleSkills = (allSkills?.skills || []).filter(s => _allowAutoGeneratedRecipes || s?.userConfirmed === true || s?.autoGenerated !== true);
      if (allSkills.ok && eligibleSkills.length === 1) {
        recipe = trainerAgent.loadRecipe(_agentIdClean, eligibleSkills[0].name);
        if (recipe) logger.info(`[browser.agent] run: auto-injecting sole trained recipe "${recipe.name}" for ${agentId}`);
      }
    }
    if (recipe && recipe.waypoints && recipe.waypoints.length > 0) {
      const waypointSteps = recipe.waypoints.map(wp => {
        if (wp.type === 'navigate') return `  ${wp.step}. NAVIGATE to ${wp.url} (checkpoint: ${wp.checkpoint || wp.pageTitle || ''})`;
        if (wp.type === 'click') return `  ${wp.step}. CLICK "${wp.elementText || ''}" selector: ${wp.selector}${wp.altSelectors?.length ? ` (alt: ${wp.altSelectors[0]})` : ''}`;
        if (wp.type === 'fill') return `  ${wp.step}. FILL ${wp.selector} with "${wp.value || '<from task>'}"${wp.altSelectors?.length ? ` (alt: ${wp.altSelectors[0]})` : ''}`;
        if (wp.type === 'check') return `  ${wp.step}. CHECK "${wp.label || ''}" selector: ${wp.selector} → ${wp.checked ? 'on' : 'off'}`;
        if (wp.type === 'drag') return `  ${wp.step}. DRAG from ${wp.fromSelector} by (${(wp.toX || 0) - (wp.fromX || 0)}, ${(wp.toY || 0) - (wp.fromY || 0)})px`;
        if (wp.type === 'scroll') return `  ${wp.step}. SCROLL ${wp.deltaY > 0 ? 'down' : 'up'} ${Math.abs(wp.deltaY || 0)}px to reveal content`;
        if (wp.type === 'select') return `  ${wp.step}. SELECT ${wp.selector} value: "${wp.value || ''}"`;
        if (wp.type === 'submit') return `  ${wp.step}. SUBMIT ${wp.selector}`;
        if (wp.type === 'keycombo') return `  ${wp.step}. KEYCOMBO ${[wp.ctrl?'Ctrl':'',wp.shift?'Shift':'',wp.alt?'Alt':'',wp.key].filter(Boolean).join('+')} on ${wp.selector}`;
        if (wp.type === 'hover') return `  ${wp.step}. HOVER ${wp.selector}${wp.altSelectors?.length ? ` (alt: ${wp.altSelectors[0]})` : ''}`;
        return `  ${wp.step}. ${wp.type.toUpperCase()} ${wp.selector || wp.url || ''}`;
      }).join('\n');

      const recipeBlock = `\n\n## Trained Navigation Recipe: ${recipe.name}\n` +
        `TARGET: ${recipe.targetUrl || ''}\n` +
        (recipe.targetDescription ? `EDITOR/PAGE RULES: ${recipe.targetDescription}\n` : '') +
        `Follow these waypoints IN ORDER to reach the target page. After reaching the target, execute the user's task.\n` +
        `WAYPOINTS:\n${waypointSteps}\n\n` +
        `RULES:\n` +
        `- Follow waypoints sequentially — verify each checkpoint before advancing\n` +
        `- If a waypoint selector fails, try altSelectors or reason from the live snapshot\n` +
        `- Once at the TARGET page, stop navigating and execute the user's actual task\n` +
        `- The recipe is GUIDANCE — if the site layout changed, adapt using the snapshot`;

      _agentContext = (_agentContext + recipeBlock).slice(0, 5000);
      _trainedRecipeInjected = true;
      logger.info(`[browser.agent] run: injected trained recipe "${recipe.name}" (${recipe.waypoints.length} waypoints) for ${agentId}`);
    }
  } catch (_recipeErr) {
    logger.warn(`[browser.agent] trained recipe lookup failed (non-fatal): ${_recipeErr.message}`);
  }

  // ── Query current browser state from user-memory monitor ──────────────────
  // Use the background screen monitor (running every 5s) to check if we're already
  // on the target domain. This enables "do it" / "now look up X" style follow-ups
  // without re-navigating from scratch.
  let _currentBrowserState = null;
  let _skipNavigation = false;
  try {
    const memHost = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
    const memPort = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
    const memBody = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'memory.getRecentOcr',
      payload: { maxAgeSeconds: 15 },
      context: { userId: 'local_user' }
    });
    const memRes = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: memHost, port: memPort, path: '/memory.getRecentOcr', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(memBody) }, timeout: 3000 }, res => { let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } }); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(memBody);
      req.end();
    });
    // MCP response format: { data: { available: true, capture: { url, appName, ... } } }
    const captureData = memRes?.data?.capture || memRes?.result?.capture;
    const isAvailable = memRes?.data?.available || memRes?.result?.available;
    if (isAvailable && captureData) {
      _currentBrowserState = { appName: captureData.appName, windowTitle: captureData.windowTitle, url: captureData.url, text: captureData.text };
      logger.info(`[browser.agent] current browser state: ${captureData.windowTitle} @ ${captureData.url}`);
    }
  } catch (_memErr) {
    // Non-fatal, proceed without current state
    logger.debug(`[browser.agent] could not fetch current browser state: ${_memErr.message}`);
  }

  // ── Deterministic recipe execution ─────────────────────────────────────────
  // Instead of relying on the LLM to interpret recipe waypoints from prompt text,
  // execute them programmatically using browser.act. Once at the target page,
  // playwright.agent only needs to handle the user's actual creative task.
  let _recipeExecutedOk = false;
  let _activeRecipe = null;   // hoisted so recipe-doctor can access it at askUser time
  let _activeAgentIdClean = agentId.replace('.agent', '');
  let _extractedData = null; // WALT: stores extraction waypoint results
  if (_trainedRecipeInjected && !_skipDeterministicRecipeReplay) {
    try {
      const trainerAgent = require('./trainer.agent.cjs');
      const _agentIdClean = _activeAgentIdClean;
      const _execRecipe = trainerAgent.findMatchingRecipe(_agentIdClean, task, { allowAutoGenerated: _allowAutoGeneratedRecipes })
        || (() => {
          const ls = trainerAgent.actionListSkills({ agentId: _agentIdClean });
          const eligible = (ls?.skills || []).filter(s => _allowAutoGeneratedRecipes || s?.autoGenerated !== true);
          return (ls.ok && eligible.length === 1) ? trainerAgent.loadRecipe(_agentIdClean, eligible[0].name) : null;
        })();

      if (_execRecipe && _execRecipe.skills && Array.isArray(_execRecipe.skills) && _execRecipe.skills.length > 0) {
        // ── RECIPE (skill chain) execution ──────────────────────────────────
        _activeRecipe = _execRecipe;
        logger.info(`[browser.agent] recipe-chain: executing recipe "${_execRecipe.name}" with ${_execRecipe.skills.length} skills`);

        // Extract recipe-level params
        let _recipeParams = {};
        if (_execRecipe.params && Array.isArray(_execRecipe.params) && _execRecipe.params.length > 0) {
          const requiredParams = _execRecipe.params.filter(p => p.required);
          const paramPrompt = `Extract parameter values from this user task.
TASK: "${task}"
PARAMS:
${_execRecipe.params.map(p => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): "${p.description}"`).join('\n')}

Output ONLY valid JSON: {${_execRecipe.params.map(p => `"${p.name}": "<extracted value or null>"`).join(', ')}}`;

          try {
            const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
            const paramResponse = await askWithMessages([
              { role: 'system', content: 'You extract parameter values from user tasks. Output ONLY valid JSON.' },
              { role: 'user', content: paramPrompt },
            ], { maxTokens: 500, temperature: 0.1 });
            let paramJson = (paramResponse || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
            _recipeParams = JSON.parse(paramJson);
            logger.info(`[browser.agent] recipe-chain: params extracted: ${JSON.stringify(_recipeParams)}`);
          } catch (e) {
            logger.warn(`[browser.agent] recipe-chain: param extraction failed: ${e.message}`);
          }

          // Check for missing required params → ask_user
          const missing = requiredParams.filter(p => !_recipeParams[p.name]);
          if (missing.length > 0) {
            logger.info(`[browser.agent] recipe-chain: missing required params: ${missing.map(p => p.name).join(', ')}`);
            return {
              ok: false, agentId, task,
              askUser: true,
              question: missing.length === 1
                ? `What's the ${missing[0].description || missing[0].name}?`
                : `I need a few details: ${missing.map(p => p.description || p.name).join(', ')}`,
              options: [],
              freeText: true,
              paramPrompt: true,
              _missingParams: missing.map(p => p.name),
            };
          }
        }

        // Execute each skill in the recipe chain
        let _chainFailed = false;
        for (const skillRef of _execRecipe.skills) {
          if (_chainFailed) break;
          const childSkill = trainerAgent.loadRecipe(_agentIdClean, skillRef.skill);
          if (!childSkill) {
            logger.warn(`[browser.agent] recipe-chain: could not load skill "${skillRef.skill}", skipping`);
            continue;
          }
          // Agent-based child skill — delegate to instruction.runner (keyboard nav)
          if (childSkill.execType === 'agent' || (childSkill.instructions && (!childSkill.waypoints || childSkill.waypoints.length === 0))) {
            logger.info(`[browser.agent] recipe-chain: agent skill "${skillRef.skill}" — delegating to instruction.runner`);
            // Distribute params via paramFlow
            const _agentChildParams = {};
            if (_execRecipe.paramFlow) {
              for (const [paramName, skillNames] of Object.entries(_execRecipe.paramFlow)) {
                if (skillNames.includes(skillRef.skill) && _recipeParams[paramName]) {
                  _agentChildParams[paramName] = _recipeParams[paramName];
                }
              }
            }
            try {
              const { runInstructionSkill } = require('./instruction.runner.cjs');
              const _childResult = await runInstructionSkill({
                instructions: childSkill.instructions,
                keyPath: childSkill.keyPath || null,
                params: childSkill.params || [],
                skillArgs: { sessionId, ..._agentChildParams },
                startUrl: childSkill.startUrl,
                sessionId,
                timeoutMs: 120000,
              });
              if (!_childResult?.ok) {
                _chainFailed = true;
                logger.warn(`[browser.agent] recipe-chain: agent skill "${skillRef.skill}" failed: ${_childResult?.error}`);
              } else {
                logger.info(`[browser.agent] recipe-chain: agent skill "${skillRef.skill}" completed ✓`);
                // Cache keyPath if discovered
                if (_childResult.discoveredKeyPath && _childResult.discoveredKeyPath.length > 0 && !childSkill.keyPath) {
                  try {
                    childSkill.keyPath = _childResult.discoveredKeyPath;
                    const skillDir = path.join(trainerAgent.SKILLS_DIR || path.join(require('os').homedir(), '.thinkdrop', 'skills'), _agentIdClean);
                    const skillPath = path.join(skillDir, `${childSkill.name}.skill.json`);
                    if (fs.existsSync(skillPath)) {
                      fs.writeFileSync(skillPath, JSON.stringify(childSkill, null, 2));
                      logger.info(`[browser.agent] recipe-chain: cached keyPath for "${childSkill.name}" to ${skillPath}`);
                    }
                  } catch (e) {
                    logger.warn(`[browser.agent] recipe-chain: could not cache keyPath for "${childSkill.name}": ${e.message}`);
                  }
                }
              }
            } catch (_childErr) {
              _chainFailed = true;
              logger.warn(`[browser.agent] recipe-chain: agent skill "${skillRef.skill}" error: ${_childErr.message}`);
            }
            continue;
          }
          if (!childSkill.waypoints || childSkill.waypoints.length === 0) {
            logger.warn(`[browser.agent] recipe-chain: skill "${skillRef.skill}" has no waypoints and is not agent-based, skipping`);
            continue;
          }

          // Distribute params via paramFlow
          const skillParams = {};
          if (_execRecipe.paramFlow) {
            for (const [paramName, skillNames] of Object.entries(_execRecipe.paramFlow)) {
              if (skillNames.includes(skillRef.skill) && _recipeParams[paramName]) {
                skillParams[paramName] = _recipeParams[paramName];
              }
            }
          }
          logger.info(`[browser.agent] recipe-chain: executing skill "${skillRef.skill}" with params: ${JSON.stringify(skillParams)}`);

          // Domain continuity check between skills
          let _skipSkillNav = false;
          if (_currentBrowserState?.url && childSkill.targetUrl) {
            try {
              const currentHostname = new URL(_currentBrowserState.url).hostname;
              const targetHostname = new URL(childSkill.targetUrl).hostname;
              const currentBaseDomain = currentHostname.split('.').slice(-2).join('.');
              const targetBaseDomain = targetHostname.split('.').slice(-2).join('.');
              const targetPath = new URL(childSkill.targetUrl).pathname;
              if (currentBaseDomain === targetBaseDomain && _currentBrowserState.url.includes(targetPath.replace(/\/$/, ''))) {
                _skipSkillNav = true;
                logger.info(`[browser.agent] recipe-chain: already at target for "${skillRef.skill}", skipping nav`);
              }
            } catch {}
          }

          // Execute child skill waypoints (inline, reusing the waypoint execution logic)
          let _wpFailed = false;
          for (const wp of childSkill.waypoints) {
            if (_wpFailed) break;
            try {
              if (wp.type === 'navigate' && !_skipSkillNav) {
                const navRes = await callBrowserAct({ action: 'navigate', url: wp.url, sessionId });
                if (navRes?.exitCode !== 0 && navRes?.ok !== true) {
                  logger.warn(`[browser.agent] recipe-chain: nav failed for "${skillRef.skill}" step ${wp.step}`);
                }
                _skipSkillNav = false; // only skip the first nav
              } else if (wp.type === 'click') {
                const clickSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let clicked = false;
                for (const sel of clickSelectors) {
                  const clickRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (clickRes?.exitCode === 0 || clickRes?.ok === true) { clicked = true; break; }
                }
                if (!clicked) logger.warn(`[browser.agent] recipe-chain: click failed step ${wp.step} (non-fatal)`);
              } else if (wp.type === 'fill') {
                let _fillValue = wp.value || '';
                if (wp.paramRef && skillParams[wp.paramRef]) {
                  _fillValue = skillParams[wp.paramRef];
                  logger.info(`[browser.agent] recipe-chain: param sub ${wp.paramRef}="${_fillValue.substring(0, 50)}"`);
                }
                const fillSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let filled = false;
                for (const sel of fillSelectors) {
                  const fillRes = await callBrowserAct({ action: 'type', selector: sel, text: _fillValue, sessionId });
                  if (fillRes?.exitCode === 0 || fillRes?.ok === true) { filled = true; break; }
                }
                if (!filled) { logger.warn(`[browser.agent] recipe-chain: fill failed step ${wp.step}`); _wpFailed = true; }
              } else if (wp.type === 'paste') {
                let pasteText = wp.text || wp.value || '';
                if (wp.paramRef && skillParams[wp.paramRef]) pasteText = skillParams[wp.paramRef];
                const pasteSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let pasted = false;
                for (const sel of pasteSelectors) {
                  const pasteCode = `(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); document.execCommand('insertText', false, ${JSON.stringify(pasteText)}); return true; })()`;
                  const pasteRes = await callBrowserAct({ action: 'evaluate', text: pasteCode, sessionId });
                  const result = String(pasteRes?.result || pasteRes?.data || '').replace(/^"|"$/g, '');
                  if (result === 'true' || pasteRes?.exitCode === 0) { pasted = true; break; }
                }
                if (!pasted) logger.warn(`[browser.agent] recipe-chain: paste failed step ${wp.step} (non-fatal)`);
              } else if (wp.type === 'submit') {
                const submitSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let submitted = false;
                for (const sel of submitSelectors) {
                  const submitRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (submitRes?.exitCode === 0 || submitRes?.ok === true) { submitted = true; break; }
                }
                if (!submitted) logger.warn(`[browser.agent] recipe-chain: submit failed step ${wp.step} (non-fatal)`);
              } else if (wp.type === 'select') {
                let _selectValue = wp.value || '';
                if (wp.paramRef && skillParams[wp.paramRef]) _selectValue = skillParams[wp.paramRef];
                const selectSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let selected = false;
                for (const sel of selectSelectors) {
                  const selectRes = await callBrowserAct({ action: 'select', selector: sel, value: _selectValue, sessionId });
                  if (selectRes?.exitCode === 0 || selectRes?.ok === true) { selected = true; break; }
                }
                if (!selected) logger.warn(`[browser.agent] recipe-chain: select failed step ${wp.step} (non-fatal)`);
              } else if (wp.type === 'keycombo') {
                const key = [wp.ctrl ? 'Control' : '', wp.shift ? 'Shift' : '', wp.alt ? 'Alt' : '', wp.key].filter(Boolean).join('+') || wp.key || 'Enter';
                await callBrowserAct({ action: 'press', key, selector: wp.selector, sessionId });
              } else if (wp.type === 'check') {
                const checkSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                for (const sel of checkSelectors) {
                  const checkRes = await callBrowserAct({ action: 'check', selector: sel, sessionId });
                  if (checkRes?.exitCode === 0 || checkRes?.ok === true) break;
                }
              } else if (wp.type === 'hover') {
                const hoverSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                for (const sel of hoverSelectors) {
                  const hoverRes = await callBrowserAct({ action: 'hover', selector: sel, sessionId });
                  if (hoverRes?.exitCode === 0 || hoverRes?.ok === true) break;
                }
              } else if (wp.type === 'dblclick') {
                const dblSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                for (const sel of dblSelectors) {
                  const dblRes = await callBrowserAct({ action: 'dblclick', selector: sel, sessionId });
                  if (dblRes?.exitCode === 0 || dblRes?.ok === true) break;
                }
              }
            } catch (wpErr) {
              logger.warn(`[browser.agent] recipe-chain: waypoint ${wp.step} error: ${wpErr.message}`);
            }
          }

          if (_wpFailed) {
            _chainFailed = true;
            logger.warn(`[browser.agent] recipe-chain: skill "${skillRef.skill}" failed, aborting chain`);
          } else {
            logger.info(`[browser.agent] recipe-chain: skill "${skillRef.skill}" completed ✓`);
          }
        }

        if (!_chainFailed) {
          _recipeExecutedOk = true;
          logger.info(`[browser.agent] recipe-chain: all skills completed ✓`);
        }

      } else if (_execRecipe && (_execRecipe.execType === 'agent' ||
                 (_execRecipe.instructions && (!_execRecipe.waypoints || _execRecipe.waypoints.length === 0)))) {
        // ── AGENT SKILL execution (instructions-based, keyboard nav) ──────────
        // Agent-based skills have execType:'agent' with text instructions and no
        // waypoints. Delegate to instruction.runner.cjs which uses keyboard
        // navigation (Tab/Arrow/Enter/Type) to execute the steps.
        _activeRecipe = _execRecipe;
        logger.info(`[browser.agent] agent-skill: executing "${_execRecipe.name}" via instruction.runner`);

        // ── Param extraction ──────────────────────────────────────────────────
        let _agentSkillParams = {};
        if (_execRecipe.params && Array.isArray(_execRecipe.params) && _execRecipe.params.length > 0) {
          const requiredParams = _execRecipe.params.filter(p => p.required);
          const paramPrompt = `Extract parameter values from this user task.
TASK: "${task}"
PARAMS:
${_execRecipe.params.map(p => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): "${p.description}"`).join('\n')}

Output ONLY valid JSON: {${_execRecipe.params.map(p => `"${p.name}": "<extracted value or null>"`).join(', ')}}`;

          try {
            const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
            const paramResponse = await askWithMessages([
              { role: 'system', content: 'You extract parameter values from user tasks. Output ONLY valid JSON.' },
              { role: 'user', content: paramPrompt },
            ], { maxTokens: 500, temperature: 0.1 });
            let paramJson = (paramResponse || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
            _agentSkillParams = JSON.parse(paramJson);
            logger.info(`[browser.agent] agent-skill: params extracted: ${JSON.stringify(_agentSkillParams)}`);
          } catch (e) {
            logger.warn(`[browser.agent] agent-skill: param extraction failed: ${e.message}`);
          }

          // Check for missing required params → ask_user
          const missing = requiredParams.filter(p => !_agentSkillParams[p.name]);
          if (missing.length > 0) {
            logger.info(`[browser.agent] agent-skill: missing required params: ${missing.map(p => p.name).join(', ')}`);
            return {
              ok: false, agentId, task,
              askUser: true,
              question: missing.length === 1
                ? `What's the ${missing[0].description || missing[0].name}?`
                : `I need a few details: ${missing.map(p => p.description || p.name).join(', ')}`,
              options: [],
              freeText: true,
              paramPrompt: true,
              _missingParams: missing.map(p => p.name),
            };
          }
        }

        // Delegate to instruction.runner.cjs (keyboard nav)
        try {
          const { runInstructionSkill } = require('./instruction.runner.cjs');
          const _agentSkillResult = await runInstructionSkill({
            instructions: _execRecipe.instructions,
            keyPath: _execRecipe.keyPath || null,
            params: _execRecipe.params || [],
            skillArgs: { sessionId, ..._agentSkillParams },
            startUrl: _execRecipe.startUrl,
            sessionId,
            timeoutMs: 120000,
          });

          if (_agentSkillResult?.ok) {
            _recipeExecutedOk = true;
            logger.info(`[browser.agent] agent-skill: "${_execRecipe.name}" completed ✓`);

            // Cache keyPath back to the skill file for fast subsequent runs
            if (_agentSkillResult.discoveredKeyPath && _agentSkillResult.discoveredKeyPath.length > 0 && !_execRecipe.keyPath) {
              try {
                _execRecipe.keyPath = _agentSkillResult.discoveredKeyPath;
                const trainerAgent = require('./trainer.agent.cjs');
                const skillDir = path.join(trainerAgent.SKILLS_DIR || path.join(require('os').homedir(), '.thinkdrop', 'skills'), _agentIdClean);
                const skillPath = path.join(skillDir, `${_execRecipe.name}.skill.json`);
                if (fs.existsSync(skillPath)) {
                  fs.writeFileSync(skillPath, JSON.stringify(_execRecipe, null, 2));
                  logger.info(`[browser.agent] agent-skill: cached keyPath (${_agentSkillResult.discoveredKeyPath.length} steps) to ${skillPath}`);
                }
              } catch (e) {
                logger.warn(`[browser.agent] agent-skill: could not cache keyPath: ${e.message}`);
              }
            }

            return {
              ok: true, agentId, task,
              result: _agentSkillResult.output || `Completed skill ${_execRecipe.name}`,
              sessionId,
              recipeUsed: true,
              routingDecision: 'agent_skill_delegate',
            };
          } else {
            logger.warn(`[browser.agent] agent-skill: "${_execRecipe.name}" failed: ${_agentSkillResult?.error} — falling through to playwright.agent`);
            // Fall through to playwrightAgent (don't return)
          }
        } catch (_agentSkillErr) {
          logger.warn(`[browser.agent] agent-skill: execution error: ${_agentSkillErr.message} — falling through to playwright.agent`);
        }

      } else if (_execRecipe && _execRecipe.waypoints && _execRecipe.waypoints.length > 0) {
        _activeRecipe = _execRecipe; // hoist for recipe-doctor access at askUser time
        // ── Domain continuity check ─────────────────────────────────────────
        // Check if we're already on the target domain (trained recipe target)
        if (_currentBrowserState?.url && _execRecipe.targetUrl) {
          try {
            const currentHostname = new URL(_currentBrowserState.url).hostname;
            const targetHostname = new URL(_execRecipe.targetUrl).hostname;
            // Extract base domain (e.g., w3schools.com from www.w3schools.com or my-learning.w3schools.com)
            const currentBaseDomain = currentHostname.split('.').slice(-2).join('.');
            const targetBaseDomain = targetHostname.split('.').slice(-2).join('.');
            const targetPath = new URL(_execRecipe.targetUrl).pathname;
            // If same base domain AND current URL contains the target path → skip navigation
            if (currentBaseDomain === targetBaseDomain && _currentBrowserState.url.includes(targetPath.replace(/\/$/, ''))) {
              _skipNavigation = true;
              _recipeExecutedOk = true;
              logger.info(`[browser.agent] domain-continuity: already at target (${_currentBrowserState.url}), skipping recipe navigation`);
            }
          } catch {}
        }

        // ── Param extraction ──────────────────────────────────────────────────
        // If the skill/recipe has a params schema, extract values from the task
        // text using LLM. Missing required params → return ask_user.
        let _extractedParams = {};
        if (_execRecipe.params && Array.isArray(_execRecipe.params) && _execRecipe.params.length > 0) {
          const requiredParams = _execRecipe.params.filter(p => p.required);
          const paramPrompt = `Extract parameter values from this user task.
TASK: "${task}"
PARAMS:
${_execRecipe.params.map(p => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): "${p.description}"`).join('\n')}

Output ONLY valid JSON: {${_execRecipe.params.map(p => `"${p.name}": "<extracted value or null>"`).join(', ')}}`;

          try {
            const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
            const paramResponse = await askWithMessages([
              { role: 'system', content: 'You extract parameter values from user tasks. Output ONLY valid JSON.' },
              { role: 'user', content: paramPrompt },
            ], { maxTokens: 500, temperature: 0.1 });
            let paramJson = (paramResponse || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
            _extractedParams = JSON.parse(paramJson);
            logger.info(`[browser.agent] skill params extracted: ${JSON.stringify(_extractedParams)}`);
          } catch (e) {
            logger.warn(`[browser.agent] param extraction failed: ${e.message}`);
          }

          // Check for missing required params → ask_user
          const missing = requiredParams.filter(p => !_extractedParams[p.name]);
          if (missing.length > 0) {
            logger.info(`[browser.agent] missing required params: ${missing.map(p => p.name).join(', ')}`);
            return {
              ok: false, agentId, task,
              askUser: true,
              question: missing.length === 1
                ? `What's the ${missing[0].description || missing[0].name}?`
                : `I need a few details: ${missing.map(p => p.description || p.name).join(', ')}`,
              options: [],
              freeText: true,
              paramPrompt: true,
              _missingParams: missing.map(p => p.name),
            };
          }
        }

        if (!_skipNavigation) {
          logger.info(`[browser.agent] recipe-exec: executing ${_execRecipe.waypoints.length} waypoints deterministically for "${_execRecipe.name}"`);
          let _wpFailed = false;

          for (const wp of _execRecipe.waypoints) {
            if (_wpFailed) break;
            try {
              if (wp.type === 'navigate') {
                const navRes = await callBrowserAct({ action: 'navigate', url: wp.url, sessionId });
                if (!navRes?.ok && navRes?.error) { logger.warn(`[browser.agent] recipe-exec: navigate failed — ${navRes.error}`); _wpFailed = true; }
                else { logger.info(`[browser.agent] recipe-exec: step ${wp.step} navigate → ${wp.url} ✓`); }
              } else if (wp.type === 'click') {
                // Build selector fallback chain with priorities
                let selectors = [];
                
                // Priority 1: Combined href + text (most specific from new CDP recorder)
                if (wp.altSelectors) {
                  const combined = wp.altSelectors.find(s => s.includes('[href*="') && s.includes(':has-text('));
                  if (combined) selectors.push(combined);
                }
                
                // Priority 2: href-based selector (most reliable for links)
                if (wp.href) {
                  try {
                    const hrefPath = new URL(wp.href).pathname;
                    selectors.push(`a[href="${wp.href}"]`);
                    selectors.push(`a[href*="${hrefPath}"]`);
                    // Also try just the filename
                    const filename = hrefPath.split('/').pop();
                    if (filename) selectors.push(`a[href*="${filename}"]`);
                  } catch {}
                }
                
                // Priority 3: primary selector
                if (wp.selector) selectors.push(wp.selector);
                
                // Priority 4: alt selectors from new CDP format (href-exact, href-partial, text, class+text)
                if (wp.altSelectors) {
                  // href-exact
                  const hrefExact = wp.altSelectors.find(s => s.match(/\[href="[^"]+"\]$/));
                  if (hrefExact && !selectors.includes(hrefExact)) selectors.push(hrefExact);
                  // href-partial
                  const hrefPartial = wp.altSelectors.find(s => s.includes('[href*="') && !s.includes(':has-text('));
                  if (hrefPartial && !selectors.includes(hrefPartial)) selectors.push(hrefPartial);
                  // class+text
                  const classText = wp.altSelectors.find(s => s.match(/\.[a-z][a-z0-9_-]*.*:has-text/));
                  if (classText && !selectors.includes(classText)) selectors.push(classText);
                  // has-text
                  const hasText = wp.altSelectors.find(s => s.includes(':has-text('));
                  if (hasText && !selectors.includes(hasText)) selectors.push(hasText);
                  // text-is (exact match)
                  const textIs = wp.altSelectors.find(s => s.includes(':text-is('));
                  if (textIs && !selectors.includes(textIs)) selectors.push(textIs);
                }
                
                // Priority 5: text-based fallback (last resort)
                if (wp.elementText) {
                  selectors.push(`text="${wp.elementText.substring(0, 40)}"`);
                }
                
                // Priority 6: ARIA-based from altSelectors
                if (wp.altSelectors) {
                  const ariaSel = wp.altSelectors.find(s => s.includes('[aria-label=') || s.includes('[aria-labelledby='));
                  if (ariaSel && !selectors.includes(ariaSel)) selectors.push(ariaSel);
                }

                let clicked = false;
                let lastError = '';
                let successSelector = '';
                for (const sel of selectors) {
                  const clickRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  // Use exitCode for consistent success checking
                  if (clickRes?.exitCode === 0 || clickRes?.ok === true) {
                    clicked = true;
                    successSelector = sel;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} click "${wp.elementText || sel}" ✓ (selector: ${sel.substring(0, 50)})`);
                    break;
                  } else {
                    lastError = clickRes?.stderr || clickRes?.error || 'unknown';
                    logger.debug(`[browser.agent] recipe-exec: step ${wp.step} click failed with selector "${sel.substring(0, 40)}" — ${lastError}`);
                  }
                }
                if (!clicked) {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} click failed for all selectors (last error: ${lastError})`);
                  _wpFailed = true;
                } else {
                  // After successful click, check if the target URL was reached.
                  // Links that open in a new tab will leave the current tab unchanged —
                  // detect this and navigate directly to wp.href to stay on track.
                  if (wp.href) {
                    try {
                      await new Promise(r => setTimeout(r, 800)); // Brief wait for any navigation to start
                      const urlCheck = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId });
                      const currentUrl = (urlCheck?.result || urlCheck?.data || '').replace(/"/g, '').replace(/^"|"$/g, '');
                      
                      // Determine expected destination: wp.href itself or the recipe targetUrl
                      const _destUrl  = wp.href;
                      const _destPath = new URL(_destUrl).pathname.split('?')[0];
                      if (currentUrl && !currentUrl.includes(_destPath)) {
                        logger.info(`[browser.agent] recipe-exec: step ${wp.step} click opened new tab or didn't navigate — navigating directly to ${_destUrl}`);
                        const navRes = await callBrowserAct({ action: 'navigate', url: _destUrl, sessionId });
                        if (navRes?.exitCode === 0 || navRes?.ok === true) {
                          logger.info(`[browser.agent] recipe-exec: direct navigation to ${_destUrl} ✓`);
                          _currentBrowserState = { ..._currentBrowserState, url: _destUrl };
                        } else {
                          logger.warn(`[browser.agent] recipe-exec: direct navigation failed — ${navRes?.error || 'unknown'}`);
                        }
                      }
                    } catch (navErr) {
                      logger.debug(`[browser.agent] recipe-exec: post-click navigation check failed (non-fatal): ${navErr.message}`);
                    }
                  }
                }
              } else if (wp.type === 'check') {
                // Try primary selector, then alt selectors
                let checkSelectors = [wp.selector];
                if (wp.altSelectors) {
                  checkSelectors.push(...wp.altSelectors.filter(s => !s.startsWith('text=')));
                }
                
                let checked = false;
                for (const sel of checkSelectors) {
                  const checkRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (checkRes?.exitCode === 0) {
                    checked = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} check "${wp.label}" ✓`);
                    break;
                  }
                }
                if (!checked) { 
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} check failed for all selectors`);
                  _wpFailed = true; 
                }
              } else if (wp.type === 'extract') {
                // Data extraction waypoint - WALT tool returns
                try {
                  const extractOptions = { dataAttr: wp.dataAttr, attrName: wp.attrName };
                  const extractCode = _buildExtractionCode(wp.selector, wp.extractType || 'text', extractOptions);
                  const extractRes = await callBrowserAct({ action: 'evaluate', text: extractCode, sessionId });
                  
                  if (extractRes?.exitCode === 0) {
                    const extractedValue = (extractRes?.result || extractRes?.data || '').replace(/^["']|["']$/g, '');
                    
                    // Store in agent context for LLM to use
                    if (!_extractedData) _extractedData = {};
                    _extractedData[wp.extractName] = extractedValue;
                    
                    // Also add to _agentContext so LLM sees it
                    const extractInfo = `\n[EXTRACTION] ${wp.extractName}: "${extractedValue.substring(0, 200)}${extractedValue.length > 200 ? '...' : ''}"`;
                    _agentContext = (_agentContext + extractInfo).slice(0, 5000);
                    
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} extract "${wp.extractName}" ✓ (${extractedValue.length} chars)`);
                  } else {
                    logger.warn(`[browser.agent] recipe-exec: step ${wp.step} extract failed — ${extractRes?.stderr || 'unknown error'}`);
                    // Don't fail the recipe for extraction errors, just log
                  }
                } catch (extractErr) {
                  logger.debug(`[browser.agent] recipe-exec: extract error (non-fatal): ${extractErr.message}`);
                }

              } else if (wp.type === 'scroll') {
                // Scroll the page — non-fatal
                const scrollCode = `window.scrollBy(0, ${wp.deltaY || 0})`;
                await callBrowserAct({ action: 'evaluate', text: scrollCode, sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} scroll ${wp.deltaY || 0}px ✓`);

              } else if (wp.type === 'focus') {
                // Focus an element (e.g. textarea, input) — non-fatal
                const focusSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let focused = false;
                for (const sel of focusSelectors) {
                  const focusCode = `(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (el) { el.focus(); return true; } return false; })()`;
                  const focusRes = await callBrowserAct({ action: 'evaluate', text: focusCode, sessionId });
                  const result = String(focusRes?.result || focusRes?.data || '').replace(/^"|"$/g, '');
                  if (result === 'true' || focusRes?.exitCode === 0) {
                    focused = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} focus "${sel}" ✓`);
                    break;
                  }
                }
                if (!focused) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} focus — element not found (non-fatal)`);

              } else if (wp.type === 'evaluate') {
                // Run arbitrary JS on the page — non-fatal
                // Used by patched recipes to call JS APIs (e.g. editor.setValue('') for CodeMirror)
                if (wp.code) {
                  const evalRes = await callBrowserAct({ action: 'evaluate', text: wp.code, sessionId });
                  const evalResult = String(evalRes?.result || evalRes?.data || '').replace(/^"|"$/g, '');
                  logger.info(`[browser.agent] recipe-exec: step ${wp.step} evaluate → ${evalResult.slice(0, 80) || 'ok'}`);
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} evaluate — no code provided (skipped)`);
                }

              } else if (wp.type === 'fill') {
                // Fill an input/textarea — fatal if all selectors fail
                let _fillValue = wp.value || '';
                if (wp.paramRef && _extractedParams[wp.paramRef]) {
                  _fillValue = _extractedParams[wp.paramRef];
                  logger.info(`[browser.agent] recipe-exec: param substitution ${wp.paramRef}="${_fillValue.substring(0, 50)}"`);
                }
                const fillSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let filled = false;
                for (const sel of fillSelectors) {
                  const fillRes = await callBrowserAct({ action: 'type', selector: sel, text: _fillValue, sessionId });
                  if (fillRes?.exitCode === 0 || fillRes?.ok === true) {
                    filled = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} fill "${sel}" ✓`);
                    break;
                  }
                }
                if (!filled) {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} fill failed for all selectors`);
                  _wpFailed = true;
                }

              } else if (wp.type === 'keycombo') {
                // Press a key combination (e.g. Enter, Ctrl+A) — non-fatal
                const key = [wp.ctrl ? 'Control' : '', wp.shift ? 'Shift' : '', wp.alt ? 'Alt' : '', wp.key].filter(Boolean).join('+') || wp.key || 'Enter';
                const keySel = wp.selector;
                const keyRes = keySel
                  ? await callBrowserAct({ action: 'press-key', selector: keySel, key, sessionId })
                  : await callBrowserAct({ action: 'press-key', key, sessionId });
                if (keyRes?.exitCode === 0 || keyRes?.ok === true) {
                  logger.info(`[browser.agent] recipe-exec: step ${wp.step} keycombo ${key} ✓`);
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} keycombo ${key} failed (non-fatal)`);
                }

              } else if (wp.type === 'select') {
                // Select a dropdown option — non-fatal
                let _selectValue = wp.value || '';
                if (wp.paramRef && _extractedParams[wp.paramRef]) {
                  _selectValue = _extractedParams[wp.paramRef];
                  logger.info(`[browser.agent] recipe-exec: param substitution ${wp.paramRef}="${_selectValue.substring(0, 50)}"`);
                }
                const selectSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let selected = false;
                for (const sel of selectSelectors) {
                  const selectRes = await callBrowserAct({ action: 'select', selector: sel, value: _selectValue, sessionId });
                  if (selectRes?.exitCode === 0 || selectRes?.ok === true) {
                    selected = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} select "${_selectValue}" on "${sel}" ✓`);
                    break;
                  }
                }
                if (!selected) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} select failed (non-fatal)`);

              } else if (wp.type === 'dblclick') {
                // Double-click an element — non-fatal
                const dblSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let dblClicked = false;
                for (const sel of dblSelectors) {
                  const dblRes = await callBrowserAct({ action: 'dblclick', selector: sel, sessionId });
                  if (dblRes?.exitCode === 0 || dblRes?.ok === true) {
                    dblClicked = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} dblclick "${sel}" ✓`);
                    break;
                  }
                }
                if (!dblClicked) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} dblclick failed (non-fatal)`);

              } else if (wp.type === 'submit') {
                // Form submit — treat as click on the submit button selector — non-fatal
                const submitSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let submitted = false;
                for (const sel of submitSelectors) {
                  const submitRes = await callBrowserAct({ action: 'click', selector: sel, sessionId });
                  if (submitRes?.exitCode === 0 || submitRes?.ok === true) {
                    submitted = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} submit "${sel}" ✓`);
                    break;
                  }
                }
                if (!submitted) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} submit failed (non-fatal)`);

              } else if (wp.type === 'paste') {
                // Paste text into an element — non-fatal
                const pasteSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                let pasteText = wp.text || wp.value || '';
                if (wp.paramRef && _extractedParams[wp.paramRef]) {
                  pasteText = _extractedParams[wp.paramRef];
                  logger.info(`[browser.agent] recipe-exec: param substitution ${wp.paramRef}="${pasteText.substring(0, 50)}"`);
                }
                let pasted = false;
                for (const sel of pasteSelectors) {
                  const pasteCode = `(function(){ const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); document.execCommand('insertText', false, ${JSON.stringify(pasteText)}); return true; })()`;
                  const pasteRes = await callBrowserAct({ action: 'evaluate', text: pasteCode, sessionId });
                  const result = String(pasteRes?.result || pasteRes?.data || '').replace(/^"|"$/g, '');
                  if (result === 'true' || pasteRes?.exitCode === 0) {
                    pasted = true;
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} paste into "${sel}" ✓`);
                    break;
                  }
                }
                if (!pasted) logger.warn(`[browser.agent] recipe-exec: step ${wp.step} paste failed (non-fatal)`);

              } else if (wp.type === 'drag') {
                // Drag-and-drop — non-fatal
                if (wp.fromSelector && (wp.toX !== undefined || wp.toSelector)) {
                  const dragArgs = wp.toSelector
                    ? { action: 'drag', fromSelector: wp.fromSelector, toSelector: wp.toSelector, sessionId }
                    : { action: 'drag', fromSelector: wp.fromSelector, toX: wp.toX, toY: wp.toY, sessionId };
                  const dragRes = await callBrowserAct(dragArgs);
                  if (dragRes?.exitCode === 0 || dragRes?.ok === true) {
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} drag ✓`);
                  } else {
                    logger.warn(`[browser.agent] recipe-exec: step ${wp.step} drag failed (non-fatal): ${dragRes?.stderr || 'unknown'}`);
                  }
                } else {
                  logger.warn(`[browser.agent] recipe-exec: step ${wp.step} drag skipped — missing fromSelector/toX`);
                }

              } else if (wp.type === 'hover') {
                // Hover over an element (menu reveals, tooltips) — non-fatal
                const hoverSelectors = [wp.selector, ...(wp.altSelectors || [])].filter(Boolean);
                for (const sel of hoverSelectors) {
                  const hoverRes = await callBrowserAct({ action: 'hover', selector: sel, sessionId });
                  if (hoverRes?.exitCode === 0 || hoverRes?.ok === true) {
                    logger.info(`[browser.agent] recipe-exec: step ${wp.step} hover "${sel}" ✓`);
                    break;
                  }
                }

              } else if (wp.type === 'back') {
                // Browser back navigation — non-fatal
                await callBrowserAct({ action: 'evaluate', text: 'window.history.back()', sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} back ✓`);
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});

              } else if (wp.type === 'forward') {
                // Browser forward navigation — non-fatal
                await callBrowserAct({ action: 'evaluate', text: 'window.history.forward()', sessionId });
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} forward ✓`);
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});

              } else if (wp.type === 'rightclick' || wp.type === 'tab-new') {
                // rightclick: context menus can't be replayed deterministically — skip gracefully
                // tab-new: tab management is handled by post-click URL check — skip gracefully
                logger.info(`[browser.agent] recipe-exec: step ${wp.step} ${wp.type} — skipped gracefully (not replayable)`);
              }

              // ── Smart per-type wait after each waypoint ───────────────────────────────
              // navigate/click-with-href: waitForStableText confirms rendered content
              // submit/dblclick with potential navigation: short waitForStableText
              // back/forward: already waited above
              // fill/select/keycombo/paste/drag/hover/scroll/focus/rightclick/tab-new: short fixed pause
              if (wp.type === 'navigate') {
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});
              } else if (wp.type === 'click' && wp.href) {
                // Post-click URL resolution already ran above; wait for content to stabilise
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 8000 }).catch(() => {});
              } else if (wp.type === 'submit' || wp.type === 'dblclick') {
                // May trigger navigation — short waitForStableText
                await callBrowserAct({ action: 'waitForStableText', sessionId, timeoutMs: 5000 }).catch(() => {});
              } else if (wp.type === 'back' || wp.type === 'forward') {
                // Already waited in handler above — no extra wait needed
              } else if (wp.type === 'fill' || wp.type === 'keycombo' || wp.type === 'select') {
                await new Promise(r => setTimeout(r, 500));
              } else {
                // scroll, focus, evaluate, hover, drag, paste, check, extract, rightclick, tab-new
                await new Promise(r => setTimeout(r, 300));
              }
            } catch (wpErr) {
              logger.warn(`[browser.agent] recipe-exec: step ${wp.step} error — ${wpErr.message}`);
              _wpFailed = true;
            }
          }

          if (!_wpFailed) {
            // Verify we reached the target by checking current URL
            try {
              const urlCheck = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId });
              const currentUrl = (urlCheck?.result || urlCheck?.data || '').replace(/"/g, '');
              if (_execRecipe.targetUrl && currentUrl.includes(new URL(_execRecipe.targetUrl).pathname.split('?')[0])) {
                _recipeExecutedOk = true;
                logger.info(`[browser.agent] recipe-exec: target reached ✓ — ${currentUrl}`);
              } else if (_execRecipe.targetUrl) {
                logger.warn(`[browser.agent] recipe-exec: target URL mismatch — got "${currentUrl}", expected path from "${_execRecipe.targetUrl}"`);
                // Target mismatch - don't strip recipe context so LLM can recover
                _recipeExecutedOk = false;
                _wpFailed = true;
              } else {
                // No targetUrl specified in recipe, assume success
                _recipeExecutedOk = true;
              }
            } catch { 
              // Verification failed, but waypoints completed - be optimistic
              _recipeExecutedOk = true; 
            }
          } else {
            logger.warn(`[browser.agent] recipe-exec: waypoint failed — falling back to LLM-guided recipe`);
          }
        }

        // If execution succeeded (or skipped due to continuity), strip recipe nav steps from context
        // but PRESERVE targetDescription as a standalone Editor Context block so playwright.agent
        // still sees critical editor rules (e.g. CRITICAL RULE: use run-code+editor.setValue()) even
        // after the navigation waypoints are gone.
        if (_recipeExecutedOk) {
          _agentContext = _agentContext.replace(/\n\n## Trained Navigation Recipe:[\s\S]*?— if the site layout changed, adapt using the snapshot/, '');
          if (_activeRecipe?.targetDescription) {
            _agentContext = (_agentContext + `\n\n## Editor Context (from trained recipe)\n${_activeRecipe.targetDescription}`).slice(0, 5500);
          }
          logger.info(`[browser.agent] recipe-exec: stripped recipe from context — playwright.agent will only handle the user task`);
        }
      }
    } catch (_execErr) {
      logger.warn(`[browser.agent] recipe-exec: deterministic execution failed (non-fatal): ${_execErr.message}`);
    }
  } else if (_trainedRecipeInjected && _urlFirstNavigationSelected) {
    logger.info(`[browser.agent] recipe-exec: URL-first navigation was selected for ${agentId} — recipe waypoints may be skipped via domain continuity check`);
  }

  // ── Step 1c: Tier 2/3 nav context enrichment via web.agent / video.agent ──
  // When playwright.agent has no keyword-matched playbook (Tier 2 or 3), it reasons
  // purely from the live DOM. Inject web-researched navigation hints to guide it.
  // Skip if a trained recipe was already injected (recipe provides the navigation path).
  if (_playbookTier >= 2 && !_trainedRecipeInjected) {
    try {
      const _navSvcName = existing?.service || agentId.replace('.agent', '');
      const _navQuery   = `how to navigate to ${task} on ${_navSvcName}`;
      logger.info(`[browser.agent] tier-${_playbookTier}: fetching web.agent nav hints for "${_navQuery.slice(0, 80)}"`);
      const _navHints = await callSkill('web.agent', {
        action: 'research_domain',
        domain: _navSvcName,
        query: _navQuery,
        maxResults: 3,
      }, 8000).catch(() => null);

      if (_navHints?.ok && _navHints?.insightsText) {
        _agentContext = (_agentContext + `\n\n## Web-Researched Navigation Hints\n${_navHints.insightsText.slice(0, 600)}`).slice(0, 4000);
        logger.info(`[browser.agent] tier-${_playbookTier}: injected web.agent nav hints (confidence=${_navHints.confidence}) for ${agentId}`);

        // Escalate to video.agent only for Tier 3 (no playbook at all) with low web.agent confidence
        if (_playbookTier === 3 && (_navHints.confidence || 0) < 0.5) {
          logger.info(`[browser.agent] tier-3: web.agent confidence low (${_navHints.confidence}) — escalating to video.agent`);
          const _videoHints = await callSkill('video.agent', {
            action: 'find_and_watch_tutorial',
            platform: 'youtube',
            query: `${_navSvcName} ${task} tutorial`,
            goal: task,
          }, 30000).catch(() => null);

          if (_videoHints?.ok && Array.isArray(_videoHints?.steps) && _videoHints.steps.length > 0) {
            const _videoSteps = _videoHints.steps.map(s => `${s.step}. ${s.text}`).join('\n');
            _agentContext = (_agentContext + `\n\n## Video Tutorial Steps\n${_videoSteps}`).slice(0, 4500);
            logger.info(`[browser.agent] tier-3: injected video.agent tutorial steps (${_videoHints.steps.length} steps) for ${agentId}`);
          }
        }
      } else {
        logger.info(`[browser.agent] tier-${_playbookTier}: web.agent nav hints unavailable or empty — proceeding without`);
      }
    } catch (_navErr) {
      logger.warn(`[browser.agent] tier-${_playbookTier}: nav enrichment failed (non-fatal): ${_navErr.message}`);
    }
  }

  // ── App Knowledge: await the research started in parallel with auth ───────
  // The research promise was started before the auth check. By now it's likely
  // already resolved (auth + nav hints took ~10-13s, research takes ~17s).
  // Await here to get the results, then inject into _agentContext.
  try {
    let _usedSnippetEntries = false;
    if (_appKnowledgePromise) {
      const _research = await _appKnowledgePromise;
      if (_research?.ok && Array.isArray(_research.entries) && _research.entries.length > 0) {
        // Cache LLM-synthesized entries (confidence >= 0.7) AND snippet entries
        // that have actionable details (shortcut or selector). Snippet entries
        // without shortcut/selector are just article titles — not actionable, so
        // they're used for this run only (not saved to disk).
        const _cacheableEntries = _research.entries.filter(e =>
          (e.confidence || 0) >= 0.7 || (e.details?.shortcut || e.details?.selector)
        );
        const _snippetOnlyEntries = _research.entries.filter(e =>
          (e.confidence || 0) < 0.7 && !(e.details?.shortcut || e.details?.selector)
        );
        if (_cacheableEntries.length > 0) {
          saveAppKnowledge(_appKnowledgeHost, _cacheableEntries);
          _appKnowledgeEntries = loadAppKnowledge(_appKnowledgeHost);
          // If there are also non-cacheable snippet entries, merge them in-memory
          if (_snippetOnlyEntries.length > 0) {
            _appKnowledgeEntries = [..._appKnowledgeEntries, ..._snippetOnlyEntries];
            _usedSnippetEntries = true;
          }
          const _cachedCount = _cacheableEntries.length;
          const _snippetCachedCount = _cacheableEntries.filter(e => (e.confidence || 0) < 0.7).length;
          logger.info(`[browser.agent] app-knowledge: researched + cached ${_cachedCount} entries for ${_appKnowledgeHost} (LLM: ${_cachedCount - _snippetCachedCount}, snippet-with-shortcut: ${_snippetCachedCount}, confidence=${_research.confidence})${_snippetOnlyEntries.length > 0 ? `, ${_snippetOnlyEntries.length} snippet-only entries in-memory` : ''}`);
        } else {
          // Use snippet-based entries for this run only (don't cache — they're not actionable)
          _appKnowledgeEntries = _research.entries;
          _usedSnippetEntries = true;
          logger.info(`[browser.agent] app-knowledge: ${_research.entries.length} snippet entries for ${_appKnowledgeHost} (NOT cached — no actionable shortcut/selector, will re-research next run)`);
        }
      } else {
        logger.info(`[browser.agent] app-knowledge: research returned no entries for ${_appKnowledgeHost} — proceeding without`);
      }
    }

    if (_appKnowledgeEntries.length > 0) {
      let _akBlock;
      if (_usedSnippetEntries) {
        // Snippet-based entries not in cache — format directly
        const { formatForContext } = require('./lib/appKnowledge.cjs');
        const _h = _appKnowledgeHost || '';
        _appKnowledgeEntries.forEach(e => { e._hostname = _h; });
        _akBlock = formatForContext(_appKnowledgeEntries, 1200);
      } else {
        _akBlock = loadAndFormat(_appKnowledgeHost, 1200);
      }
      if (_akBlock) {
        _agentContext = (_agentContext + `\n\n${_akBlock}`).slice(0, 5800);
        logger.info(`[browser.agent] app-knowledge: injected ${_appKnowledgeEntries.length} entries into _agentContext for ${agentId}`);
      }
    }
  } catch (_akErr) {
    logger.warn(`[browser.agent] app-knowledge: enrichment failed (non-fatal): ${_akErr.message}`);
  }

  // ── Deep-link discovery: find the most direct URL for this task ────────────
  // Three-layer URL-first approach:
  //   Layer 0: Cached verified correction (from prior successful runs)
  //   Layer 1: LLM-suggested direct URL for this service+task
  //   Layer 2: web.agent discover_task_url (site-scoped + broad web search)
  //   Fallback: startUrl (service home/dashboard)
  let _deepLinkOverride = null;
  if (!_trainedRecipeInjected && !_urlFirstNavigationSelected) {
    try {
      const _serviceKey = (existing?.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
      const _intent = await classifyTaskIntent(task, _serviceKey);
      const _baseHost = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
      if (!_baseHost) throw new Error('could not derive hostname from startUrl');
      const _svcEntry3 = lookupBrowserService(_serviceKey);
      const _hostAliases = _svcEntry3?.hostAliases || [];

      // Layer 0: Cached verified correction (from prior successful runs)
      const _cached = await getLearnedCorrection(_serviceKey, _intent);
      if (_cached?.correctedUrl) {
        logger.info(`[browser.agent] deep-link: cached correction ${_cached.correctedUrl} (conf=${_cached.confidence.toFixed(2)}) for ${_serviceKey}:${_intent}`);
        // Guard: skip cached Messenger URLs for post/share tasks (not message tasks)
        const _taskLower0 = String(task || '').toLowerCase();
        const _isPostShareTask0 = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLower0);
        const _isMessageTask0 = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLower0);
        if (_isPostShareTask0 && !_isMessageTask0 && /\/(messages|messenger)\b/i.test(_cached.correctedUrl)) {
          logger.warn(`[browser.agent] deep-link: dropping cached Messenger correction for post/share task ${_serviceKey}:${_intent}: ${_cached.correctedUrl}`);
          setImmediate(() => {
            deleteLearnedCorrection(_serviceKey, _intent).catch(() => {});
          });
        } else if (_isUnsafeDeepLinkUrl(_cached.correctedUrl, _baseHost)) {
          logger.warn(`[browser.agent] deep-link: dropping unsafe cached correction for ${_serviceKey}:${_intent}: ${_cached.correctedUrl}`);
          setImmediate(() => {
            deleteLearnedCorrection(_serviceKey, _intent).catch(() => {});
          });
        } else if (_cached.confidence >= 0.6) {
          const _cachedValid = await verifyDeepLinkUrl(_cached.correctedUrl, sessionId, _baseHost, 15000, _hostAliases);
          if (_cachedValid) {
            _deepLinkOverride = _cached.correctedUrl;
            logger.info(`[browser.agent] deep-link: using cached URL ${_cached.correctedUrl} — overriding startUrl from ${startUrl}`);
          } else {
            logger.warn(`[browser.agent] deep-link: cached URL ${_cached.correctedUrl} failed validation — falling through to LLM/web search`);
            setImmediate(() => {
              deleteLearnedCorrection(_serviceKey, _intent).catch(() => {});
            });
          }
        }
      }

      // Layer 1: LLM-suggested direct URL for this service+task
      if (!_deepLinkOverride) {
        const _llmSuggest = await suggestTaskUrl(_serviceKey, startUrl, _intent, task);
        if (_llmSuggest?.ok && _llmSuggest.url) {
          logger.info(`[browser.agent] deep-link: LLM suggested URL for ${_serviceKey}:${_intent} → ${_llmSuggest.url}`);
          if (_isUnsafeDeepLinkUrl(_llmSuggest.url, _baseHost)) {
            logger.warn(`[browser.agent] deep-link: rejected unsafe LLM URL for ${_serviceKey}:${_intent}: ${_llmSuggest.url}`);
          } else {
            const _llmValid = await verifyDeepLinkUrl(_llmSuggest.url, sessionId, _baseHost, 15000, _hostAliases);
            if (_llmValid) {
            _deepLinkOverride = _llmSuggest.url;
            logger.info(`[browser.agent] deep-link: verified LLM URL ${_llmSuggest.url} — overriding startUrl from ${startUrl}`);
            if (!_isSearchCriteriaTask(task)) {
              setImmediate(() => { recordCorrection(_serviceKey, _intent, _llmSuggest.url).catch(() => {}); });
            }
            } else {
              logger.warn(`[browser.agent] deep-link: LLM URL ${_llmSuggest.url} failed validation — falling through to web search`);
            }
          }
        }
      }

      // Layer 2: web.agent discovery (final fallback)
      if (!_deepLinkOverride) {
        let _dlResult = null;
        _dlResult = await callSkill('web.agent', {
        action: 'discover_task_url',
        domain: _baseHost,
        task: task.slice(0, 200),
        candidateUrl: _cached?.correctedUrl,
        }, 10000).catch(() => null);

        // Pick best candidate from web.agent discovery (seed any existing cached URL as a fallback)
        let _bestUrl = null;
        let _bestScore = 0;
        let _bestSource = 'none';
        if (_cached?.correctedUrl) {
        _bestUrl = _cached.correctedUrl;
        _bestScore = 100; // high baseline for previously verified URLs
        _bestSource = 'cache';
        }
        if (_dlResult?.ok && _dlResult.taskUrl && (_dlResult.score || 0) > _bestScore) {
        _bestUrl = _dlResult.taskUrl;
        _bestScore = _dlResult.score;
        _bestSource = `discovery:${_dlResult.confidence?.toFixed?.(2) || '?'}`;
        }

        if (_bestUrl) {
        if (_isUnsafeDeepLinkUrl(_bestUrl, _baseHost)) {
          logger.warn(`[browser.agent] deep-link: rejected unsafe discovery candidate for ${_serviceKey}:${_intent}: ${_bestUrl}`);
          if (_bestSource === 'cache') {
            setImmediate(() => {
              deleteLearnedCorrection(_serviceKey, _intent).catch(() => {});
            });
          }
        } else {
        // 4. Security: verify candidate by navigation. Off-domain candidates are allowed
        // through to verification — shortcut domains (e.g. notion.new) redirect to canonical host.
        const _valid = await verifyDeepLinkUrl(_bestUrl, sessionId, _baseHost, 15000, _hostAliases);
          if (_valid) {
            _deepLinkOverride = _bestUrl;
            logger.info(`[browser.agent] deep-link: verified ${_bestUrl} (source=${_bestSource}, score=${_bestScore}) for task "${task.slice(0, 60)}" — overriding startUrl from ${startUrl}`);
            // Record this working URL so future runs benefit immediately.
            // Skip for search-criteria tasks — criteria URLs are too specific to be
            // useful as generic intent corrections (see _resolveTaskDeepLink).
            if (!_isSearchCriteriaTask(task)) {
              setImmediate(() => {
                recordCorrection(_serviceKey, _intent, _bestUrl).catch(() => {});
              });
            }
            // Also record in keyword-indexed deep-link cache.
            // Layer 2: Skip for search-criteria tasks — criteria URLs are too specific
            // or too generic to be useful for keyword matching (see _resolveTaskDeepLink).
            // Also skip Messenger URLs for post/share tasks — they're the wrong destination.
            const _secondaryKeywords = getTaskKeywords(task, _svcKey);
            const _taskLowerSec = String(task || '').toLowerCase();
            const _isPostShareSec = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(_taskLowerSec);
            const _isMessageSec = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(_taskLowerSec);
            const _skipCacheMsgSec = _isPostShareSec && !_isMessageSec && /\/(messages|messenger)\b/i.test(_bestUrl);
            if (_secondaryKeywords.length > 0 && !_isSearchCriteriaTask(task) && !_skipCacheMsgSec) {
              setImmediate(() => {
                recordDeepLinkCache(_serviceKey, _bestUrl, _secondaryKeywords, _intent).catch(() => {});
              });
            }
            // Also cache in appKnowledge intent_url for future runs
            if (_intent && _intent !== INTENTS.HOME && !_isSearchCriteriaTask(task)) {
              setImmediate(() => {
                try {
                  const { saveIntentUrl } = require('./lib/appKnowledge.cjs');
                  const _host = (() => { try { return new URL(_bestUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
                  if (_host) saveIntentUrl(_host, _intent, _bestUrl);
                } catch (_) {}
              });
            }
          } else {
            logger.warn(`[browser.agent] deep-link: candidate ${_bestUrl} failed validation — using startUrl ${startUrl}`);
            // If cached URL failed, clear it so we rediscover next time
            if (_bestSource === 'cache') {
              setImmediate(() => {
                deleteLearnedCorrection(_serviceKey, _intent).catch(() => {});
              });
            }
          }
        }
        } else {
        logger.info(`[browser.agent] deep-link: no suitable URL found${_dlResult?.error ? ' (' + _dlResult.error + ')' : ''} — using startUrl ${startUrl}`);
        }
      } // end if (!_deepLinkOverride) — skip LLM/web search if cache already resolved
    } catch (_dlErr) {
      logger.warn(`[browser.agent] deep-link discovery failed (non-fatal): ${_dlErr.message}`);
    }
  } else if (_urlFirstNavigationSelected) {
    logger.info(`[browser.agent] deep-link: skipping secondary discovery because URL-first navigation is already selected for ${agentId}`);
  }

  if (_deepLinkOverride) {
    startUrl = _deepLinkOverride;
  }

  // ── Inject domain map content extraction hints if available ───────────────
  // explore.agent scan mode discovers optimal CSS selectors for content extraction.
  // These hints help playwright.agent extract substantive content instead of UI chrome.
  const _hostname = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
  const _contentExtraction = _hostname ? getContentExtractionConfig(_hostname) : null;
  if (_contentExtraction?.primary_selector) {
    const extractionHint = `
\n## Content Extraction (discovered via scan mode)
When extracting page content with run-code, prioritize these selectors over generic document.body:
- Primary:   ${_contentExtraction.primary_selector}${_contentExtraction.fallback_selector ? `\n- Fallback:  ${_contentExtraction.fallback_selector}` : ''}
- Type:      ${_contentExtraction.content_type}
- Confidence: ${Math.round((_contentExtraction.confidence || 0) * 100)}%
`;
    _agentContext = (_agentContext + extractionHint).slice(0, 3200);
    logger.info(`[browser.agent] run: injected content extraction hints for ${_hostname} (${_contentExtraction.primary_selector})`);
  }

  // ── Inject deep-link provenance into agentContext ────────────────────────
  // Tell playwright.agent that the start URL was verified and its source,
  // so the planner doesn't second-guess the navigation or try to re-discover it.
  if (_urlFirstNavigationSelected && !_recipeExecutedOk) {
    const _provenanceSource = _deepLinkSource || (url ? 'caller' : 'resolved');
    let _provenanceNote = `\n\n## Verified Destination URL\nThe navigation URL (${startUrl}) has been verified (source: ${_provenanceSource}).\nDo NOT search for or navigate to alternative URLs. Use this URL as the first navigation step. If the page loads correctly, proceed directly with the user's task.`;

    // ── Creation deep-link detection ────────────────────────────────────────
    // When the resolved URL is a creation deep-link (e.g. notion.new, docs.google.com/document/create),
    // the entity has ALREADY been created by navigating to it. Append a note so downstream
    // tiers don't try to create another entity (pressing Ctrl+N, clicking "New page", etc.).
    // Generic pattern-based detection — no app-specific hardcoding.
    const _isCreationDeepLink = (() => {
      try {
        const _u = new URL(startUrl);
        const _host = _u.hostname.replace(/^www\./, '');
        // *.new shortcut domains (notion.new, docs.new, sheets.new, slides.new, etc.)
        if (_host.endsWith('.new') || _host === 'new') return true;
        // Paths containing /new, /create, /compose
        if (/\/(new|create|compose)(\/|$|\?)/i.test(_u.pathname)) return true;
        return false;
      } catch (_) { return false; }
    })();

    if (_isCreationDeepLink) {
      _provenanceNote += `\n\n## URL-FIRST NOTE: Creation Deep-Link\nNavigation to this creation URL has ALREADY created the new entity (page/document/draft). Do NOT create another one — do NOT press New/Create buttons or shortcuts (Ctrl+N, Cmd+N). The entity is ready for input — begin typing into the focused field, or click the appropriate field first if focus is not yet in an editor.`;
      logger.info(`[browser.agent] run: injected creation deep-link note for ${agentId} (URL=${startUrl})`);
    }

    _agentContext = (_agentContext + _provenanceNote).slice(0, 5800);
    logger.info(`[browser.agent] run: injected deep-link provenance for ${agentId} (source=${_provenanceSource})`);
  }

  // ── Tab-Map: prompt → instructions → instruction.runner ────────────────────
  // After URL-first navigation + auth, convert the task into instruction.runner-
  // format text instructions via LLM, then execute via runInstructionSkill
  // (tab-map scan + LLM pick + Playwright click). This is a peer to URL-first:
  // deterministic keyboard navigation instead of LLM-per-action turn-loop.
  // Gated behind THINKDROP_PROMPT_TABMAP=true for A/B testing.
  // Falls through to playwright.agent on failure.
  if (process.env.THINKDROP_PROMPT_TABMAP === 'true' && !_recipeExecutedOk) {
    try {
      const _tabMapHostname = (() => {
        try { return new URL(startUrl).hostname.replace(/^www\./, ''); }
        catch (_) { return null; }
      })();

      // Emit tier progress: tab-map starting
      _postProgress(_progressCallbackUrl, {
        type: 'agent:tier',
        stepIndex: _stepIndex ?? 0,
        tier: 'tab-map',
        message: `Tab-map: three-tier iterative navigation`,
        agentId,
        sessionId,
      });

      // Fail-fast: verify engine is active before proceeding with tab-map.
      // URL-first enforcement should have navigated and re-launched the engine.
      // If it didn't (or failed), don't waste time on 50+ key presses that will
      // all fail — fall through to playwright.agent which has its own engine launch.
      const _engineCheckRes = await callBrowserAct({ action: 'evaluate', text: 'document.readyState', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
      if (!_engineCheckRes?.ok) {
        logger.warn(`[browser.agent] tab-map: engine not active (evaluate failed) — skipping tab-map, falling through to playwright.agent`);
        throw new Error('tab-map skipped: engine not active');
      }
      logger.info(`[browser.agent] tab-map: engine active (readyState=${_engineCheckRes.result}) — proceeding`);

      // ── URL-first short-circuit for read-only search tasks ────────────────
      // If the URL already encodes search/filter criteria (e.g. Gmail #search/is:unread+from:pastor)
      // and the goal is a read/count/list task, skip the entire iterative navigation loop
      // and just waitForStableText + getPageText + return. This avoids unnecessary Tab-Map
      // scanning, Tab/ArrowRight pressing, and LLM calls for the common case.
      try {
        const { _isReadCountListGoal } = require('./instruction.runner.cjs');
        const _isReadOnlyGoal = _isReadCountListGoal(task);
        const _urlHasSearchCriteria = /(#search|\?q=|&q=|#query=|&filter=|#filter|is:unread|is:starred|from:|to:|subject:|label:|in:|has:)/i.test(startUrl || '');
        if (_isReadOnlyGoal && _urlHasSearchCriteria && _urlFirstNavigationSelected) {
          logger.info(`[browser.agent] tab-map: URL-first short-circuit — read-only goal + URL has search criteria, skipping iterative navigation`);
          // Wait for page to stabilize (Gmail SPA needs time after #search navigation)
          const _wstRes = await callBrowserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 10000 }, 12000).catch(e => ({ ok: false, error: e.message }));
          logger.info(`[browser.agent] tab-map: short-circuit waitForStableText ok=${_wstRes?.ok} (${_wstRes?.result?.length || 0} chars)`);
          // Extract page text
          const _gtRes = await callBrowserAct({ action: 'getPageText', sessionId, headed: true, timeoutMs: 10000 }, 12000).catch(e => ({ ok: false, error: e.message }));
          const _pageText = _gtRes?.ok ? (_gtRes.result || _gtRes.stdout || '') : '';
          logger.info(`[browser.agent] tab-map: short-circuit getPageText ok=${_gtRes?.ok} (${_pageText.length} chars)`);
          // Capture final URL for downstream steps
          let _shortCircuitUrl = '';
          try {
            const _urlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 3000 }, 5000).catch(() => ({ ok: false }));
            _shortCircuitUrl = _urlRes?.ok ? String(_urlRes.result || '').trim().replace(/^"|"$/g, '') : '';
          } catch (_) {}
          // Emit tier progress: tab-map completed
          _postProgress(_progressCallbackUrl, {
            type: 'agent:tier',
            stepIndex: _stepIndex ?? 0,
            tier: 'tab-map',
            message: `Tab-map: completed via URL-first short-circuit`,
            agentId,
            sessionId,
          });
          const _shortCircuitResult = `Goal achieved via URL-first short-circuit. Page content: ${_pageText.slice(0, 10000)}`;
          // ── OCR goal verification before returning success ────────────────
          const _scOcrVerify = await _verifyGoalWithOcr(task, sessionId, []);
          if (!_scOcrVerify.verified) {
            logger.warn(`[browser.agent] tab-map: URL-first short-circuit OCR verification failed: ${_scOcrVerify.reason} (OCR: "${_scOcrVerify.ocrText || ''}") — proceeding to iterative navigation instead`);
          } else {
            logger.info(`[browser.agent] tab-map: URL-first short-circuit OCR verification passed: ${_scOcrVerify.reason}`);
            return {
              ok: true, agentId, task,
              result: _shortCircuitResult,
              url: _shortCircuitUrl,
              sessionId,
              recipeUsed: false,
              routingDecision: 'browser_urlfirst_shortcircuit',
            };
          }
        }
      } catch (_scErr) {
        logger.warn(`[browser.agent] tab-map: URL-first short-circuit error (non-fatal): ${_scErr.message} — proceeding to iterative navigation`);
      }

      // ── Three-tier iterative navigation ──────────────────────────────
      // Tier 1: URL-first (already done above)
      // Tier 2: Decision call → 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Tab-Map)
      // Tier 3: Strategy execution with fallback to Tab-Map
      const _pageCategory = _inferPageCategory(_svcKey, startUrl, task, _appKnowledgeEntries);
      const _shortcutEntries = _appKnowledgeEntries.filter(e => e.type === 'shortcut' && e.details?.shortcut);
      const _shortcutCount = _shortcutEntries.length;
      // Build compact shortcut list: "c — create a new event" (max 800 chars)
      const _shortcutLabels = _shortcutEntries.map(s => {
        const key = s.details?.shortcut || '';
        const action = (s.summary || '').replace(/^.*?\bto\s+/i, '').replace(/\.$/, '').slice(0, 60);
        return `${key} — ${action}`;
      }).join('\n').slice(0, 800);
      logger.info(`[browser.agent] tab-map: starting three-tier iterative navigation (category=${_pageCategory}, appKnowledge=${_appKnowledgeEntries?.length || 0} entries, shortcuts=${_shortcutCount})`);
      const { runIterativeNavigation } = require('./instruction.runner.cjs');
      const _tabMapResult = await runIterativeNavigation({
        goal: task,
        sessionId,
        startUrl: _urlFirstNavigationSelected ? startUrl : null,
        urlFirstNav: _urlFirstNavigationSelected,
        pageCategory: _pageCategory,
        agentContext: _agentContext,
        shortcutCount: _shortcutCount,
        shortcutLabels: _shortcutLabels,
        timeoutMs: 120000,
        progressCallbackUrl: _progressCallbackUrl,
        stepIndex: _stepIndex,
        agentId: _agentIdArg,
      });
      if (_tabMapResult?.askUser) {
        // Alert handler surfaced an unfixable error — propagate to user
        logger.info(`[browser.agent] tab-map: surfacing askUser: "${_tabMapResult.question}"`);
        return {
          ok: false, agentId, task,
          askUser: true,
          question: _tabMapResult.question,
          options: _tabMapResult.options || [],
          agentTurns: 0,
          loopHistory: [],
        };
      }
      if (_tabMapResult?.ok) {
        logger.info(`[browser.agent] tab-map: completed ✓ via iterative navigation`);

        // ── DOM-state + network verification (primary for modal/overlay goals) ──
        // Checks: submit clicked + POST/PUT 2xx in netLog + dialog closed + no error toast.
        // If verified, skip OCR entirely (OCR can't see modals reliably).
        const _domVerify = await _verifyGoalViaDomState(task, sessionId, _tabMapResult.actionHistory || [], _tabMapResult);
        if (_domVerify.verified) {
          logger.info(`[browser.agent] tab-map: DOM-state verification passed: ${_domVerify.reason}`);
          // Skip OCR — DOM state + network is sufficient. Continue to success return below.
        } else if (_domVerify.reason !== 'no-submit-click' && _domVerify.reason !== 'overlay-check-failed') {
          // Submit was clicked but dialog still open, error toast, or API failure
          logger.warn(`[browser.agent] tab-map: DOM-state verification failed: ${_domVerify.reason}`);
          return { ok: false, agentId, task, error: `Goal not achieved — ${_domVerify.reason}` };
        }
        // else: no-submit-click or overlay-check-failed → fall through to OCR verification

        // ── OCR goal verification (fallback for non-modal goals) ──────────
        // Prevents false positives: if the page is a marketing page or the goal
        // was not actually achieved, return ok:false instead of hallucinating success.
        if (!_domVerify.verified) {
        const _ocrVerify = await _verifyGoalWithOcr(task, sessionId, _tabMapResult.actionHistory || []);
        if (!_ocrVerify.verified) {
          if (_ocrVerify.wait) {
            // Page loading — wait and retry once
            logger.info(`[browser.agent] tab-map: OCR verification says loading — waiting 5s and retrying`);
            await new Promise(r => setTimeout(r, 5000));
            const _retryVerify = await _verifyGoalWithOcr(task, sessionId, _tabMapResult.actionHistory || []);
            if (!_retryVerify.verified) {
              logger.warn(`[browser.agent] tab-map: OCR goal verification failed (after retry): ${_retryVerify.reason} (OCR: "${_retryVerify.ocrText || ''}")`);
              return { ok: false, agentId, task, error: `Goal not achieved — OCR verification failed: ${_retryVerify.reason}` };
            }
            logger.info(`[browser.agent] tab-map: OCR goal verification passed on retry: ${_retryVerify.reason}`);
          } else {
            logger.warn(`[browser.agent] tab-map: OCR goal verification failed: ${_ocrVerify.reason} (OCR: "${_ocrVerify.ocrText || ''}")`);
            return { ok: false, agentId, task, error: `Goal not achieved — OCR verification failed: ${_ocrVerify.reason}` };
          }
        } else {
          logger.info(`[browser.agent] tab-map: OCR goal verification passed: ${_ocrVerify.reason}`);
        }
        } // end if (!_domVerify.verified)
        // Emit tier progress: tab-map completed
        _postProgress(_progressCallbackUrl, {
          type: 'agent:tier',
          stepIndex: _stepIndex ?? 0,
          tier: 'tab-map',
          message: `Tab-map: completed via iterative navigation`,
          agentId,
          sessionId,
        });
        // Capture final URL for downstream steps (executeCommand auto-injects it)
        let _finalUrl = '';
        try {
          const _urlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 3000 }, 5000).catch(() => ({ ok: false }));
          _finalUrl = _urlRes?.ok ? String(_urlRes.result || '').trim().replace(/^"|"$/g, '') : '';
        } catch (_) {}
        return {
          ok: true, agentId, task,
          result: _tabMapResult.output || `Completed via tab-map`,
          url: _finalUrl,
          sessionId,
          recipeUsed: false,
          routingDecision: 'browser_tabmap',
        };
      }
      logger.warn(`[browser.agent] tab-map: iterative navigation failed: ${_tabMapResult?.error} — falling through to playwright.agent`);
    } catch (_tabMapErr) {
      logger.warn(`[browser.agent] tab-map: execution error (non-fatal): ${_tabMapErr.message} — falling through to playwright.agent`);
    }
  }

  // Emit tier progress: falling through to playwright.agent (turn-loop)
  _postProgress(_progressCallbackUrl, {
    type: 'agent:tier',
    stepIndex: _stepIndex ?? 0,
    tier: 'turn-loop',
    message: `Playwright: delegating to turn-loop agent`,
    agentId,
    sessionId,
  });

  try {
    // If recipe was successfully executed, we're already on the target page - don't navigate.
    // When URL-first is selected, pass the actual post-enforcement URL (which may be a
    // redirect from startUrl, e.g. notion.new → app.notion.com/<new-page-id>) so
    // playwright.agent can recognize it's already on the right page and skip navigation.
    // The recovery anchor in the goal still uses startUrl for blank-page recovery.
    const _playwrightUrl = _recipeExecutedOk
      ? undefined
      : (_useAgentBrowser ? startUrl : (_urlFirstNavigationSelected ? (_postEnforcementUrl || startUrl) : undefined));
    if (_recipeExecutedOk && url) {
        logger.info(`[browser.agent] run: recipe executed successfully - NOT passing URL to playwright.agent to stay on target page`);
    }
    if (!_recipeExecutedOk && _urlFirstNavigationSelected && !_useAgentBrowser) {
        logger.info(`[browser.agent] run: passing URL-first post-enforcement URL ${_playwrightUrl} to playwright.agent for ${agentId}`);
    }
    const agentResult = await _withSessionMutex(sessionId, () => callSkill(_agentSkill, {
        goal: _effectiveTask,
        agentContext: _agentContext,
        appKnowledgeEntries: _appKnowledgeEntries,
        url: _playwrightUrl,
        authSignInUrl: _useAgentBrowser ? (signInUrl || undefined) : undefined,
        sessionId,
        agentId,
        autoConnect: _effectiveAutoConnect,
        chromeProfile: _usePersistentProfile ? AGENT_BROWSER_PROFILE
        : (!_effectiveAutoConnect && _useAutoConnect ? 'Default' : undefined),
        headed: _usePersistentProfile ? true : undefined,
        maxTurns: _dynamicMaxTurns,
        timeoutMs: 30000,
        overallTimeoutMs: Math.max(180000, _dynamicMaxTurns * 10000),
        recipeWasUsed: _recipeExecutedOk,
        authConfirmedAt: (_getCachedAuthCheck(agentId)?.ts ?? null),
        _progressCallbackUrl,
        _stepIndex,
        _abortSignal: _abortSignal,
    }, 600000, _abortSignal));

    let agentResultText = String(agentResult?.result ?? agentResult?.stdout ?? '');

    // ── Deep-link cache invalidation on verify-gate / 404 failure ───────────────
    // If the run failed because the page was broken (about:blank, empty after
    // recovery, or a 404 "page not found") AND the navigation URL came from the
    // keyword deep-link cache, remove that cached entry so the next run falls
    // back to the start URL or re-discovers a working deep-link. This is generic
    // for ALL browser agents — not just Spotify — so any stale cached URL that
    // leads to a broken page gets purged automatically.
    if (agentResult?.ok === false && _deepLinkSource === 'keyword-cache' && startUrl && _svcKey) {
      const _errText = String(agentResult?.error || '');
      const _resultText = agentResultText || '';
      const _verifyGateFailed = /verify gate|about:blank|page is about:blank|empty after recovery/i.test(_errText)
        || /404|page not found/i.test(_errText)
        || /404|page not found/i.test(_resultText);
      if (_verifyGateFailed) {
        logger.info(`[browser.agent] deep-link: invalidating cached URL ${startUrl} for ${agentId} after verify-gate/404 failure (source=${_deepLinkSource})`);
        deleteDeepLinkCache(_svcKey, startUrl).catch(_e => {
          logger.warn(`[browser.agent] deep-link: cache invalidation failed for ${_svcKey} → ${startUrl}: ${_e.message}`);
        });
      }
    }

    // ── Bubble up askUser from playwright.agent ────────────────────────────────
    // If playwright.agent surfaced an ask_user (goal not achieved after recipe
    // or after exhausting replanning), propagate it directly to the caller
    // so recoverSkill / executeCommand can surface the choice to the user.
    if (agentResult?.askUser === true) {
        logger.info(`[browser.agent] propagating askUser from playwright.agent: "${agentResult.question}"`);

        // ── Recipe Doctor: auto-diagnose and patch the recipe before asking user ──
        // When a recipe-driven task fails, attempt to auto-diagnose why the last
        // recipe step didn't work and patch it — so the next run just works.
        let _doctorSummary = null;
        if (_recipeExecutedOk && _activeRecipe && sessionId) {
        logger.info(`[browser.agent] recipe-doctor: goal not achieved after recipe — running diagnosis`);
        try {
          const _doctorResult = await diagnoseAndPatchRecipe({
            agentId,
            recipeName: _activeRecipe.name,
            recipe: _activeRecipe,
            failureReason: agentResult.question || 'Task goal not achieved',
            sessionId,
          });
          if (_doctorResult.patched) {
            _doctorSummary = _doctorResult.summary;
            logger.info(`[browser.agent] recipe-doctor: patch applied — "${_doctorSummary}"`);
          } else {
            logger.info(`[browser.agent] recipe-doctor: no patch applied — ${_doctorResult.reason}`);
          }
        } catch (_docErr) {
          logger.warn(`[browser.agent] recipe-doctor: non-fatal error: ${_docErr.message}`);
        }
        }

        const _questionText = _doctorSummary
        ? `${agentResult.question}\n\n✅ Recipe auto-fixed: ${_doctorSummary}\n\nTry again to use the patched recipe.`
        : agentResult.question;
        const _options = _doctorSummary
        ? ['Try again with patched recipe', ...( agentResult.options || []).filter(o => !/try again/i.test(o))]
        : (agentResult.options || []);

        // Capture current page URL so "Train from current page" can attach to
        // the exact page the failure occurred on (e.g. the LinkedIn composer).
        let _currentUrl = null;
        try {
          const _hrefRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 5000 }, 8000).catch(() => ({ ok: false }));
          if (_hrefRes?.ok && _hrefRes.result) _currentUrl = String(_hrefRes.result).replace(/^"|"$/g, '');
        } catch (_) { /* non-fatal */ }

        return {
        ok: false,
        agentId,
        task,
        sessionId,
        askUser: true,
        trainingHandoff: agentResult.trainingHandoff === true,
        question: _questionText,
        options: _options,
        // Partial-progress summary (from playwright.agent's _summarizePartialProgress).
        // When present, the renderer shows a partial-failure QuestionCard with
        // "Try to finish" / "Train me with a recipe" / "Other" instead of the
        // generic failure banner.
        partialProgress: agentResult.partialProgress || null,
        recipeWasUsed: _recipeExecutedOk,
        recipePatched: !!_doctorSummary,
        // Preserve session for train-from-current-page; pass current URL + the
        // original task so the trainer can attach in-place and distill later.
        keepSession: agentResult.keepSession === true,
        currentUrl: _currentUrl,
        originalTask: task,
        };
    }

    // ── Tier-2 post-execution write-back ──────────────────────────────────────
    // When a novel-goal task (tier-2 format-reference) succeeds, fire an async COT
    // call to generate a grounded ### playbook section from the actual execution
    // result. On the next identical task, _resolvePlaybook will hit tier-1 directly.
    if (_playbookTier === 2 && agentResult?.ok === true && existing.descriptor) {
        // Parse only the ## Playbooks section — avoid matching ### headers in other sections
        const _pbMatch = existing.descriptor.match(/\n## Playbooks\n([\s\S]*)$/);
        const _existingSubsections = _pbMatch
        ? _pbMatch[1].trim().split(/(?=### )/).map(s => s.trim()).filter(Boolean)
        : [];
        setImmediate(() => {
        _generateAndCachePlaybook(
          agentId,
          existing.descriptor,
          task,
          _existingSubsections,
          agentResultText.slice(0, 1200),
        ).catch(() => {/* silent — write-back is best-effort */});
        });
        logger.info(`[browser.agent] playbook: tier-2 success — async COT write-back queued for ${agentId}`);
    }

    // ── Dynamic login-wall detector ───────────────────────────────────────────
    // If playwright.agent returned content that looks like a login/auth wall,
    // the service has changed from anonymous-first to requiring login. Auto-patch
    // the agent descriptor (DuckDB + disk) so future runs call waitForAuth and
    // properly prompt the user to authenticate once.
    //
    // Two signal tiers:
    //   Strong: OAuth provider button text ("Continue with Google", etc.) — single
    //           match is definitive; these only appear on login walls.
    //   Weak:   Generic auth phrases ("Sign in", "Log in", etc.) — require >= 2
    //           matches AND sparse page (< 50 lines) to avoid false positives on
    //           pages that merely show a nav-bar "Sign in" link alongside real content.
    const _LOGIN_WALL_RE = /\b(sign[\s-]+in|log[\s-]+in|log[\s-]+into|create[\s-]+account|sign[\s-]+up|please[\s-]+log|welcome[\s-]+back|get[\s-]+started[\s-]+free)\b/gi;
    const _OAUTH_PROVIDERS_RE = /\b(continue[\s-]+with[\s-]+(google|microsoft|apple|github|facebook|linkedin|twitter|x\.com|slack)|sign[\s-]+in[\s-]+with[\s-]+(google|microsoft|apple|github|facebook|linkedin|twitter)|google[\s-]+login)\b/i;
    const _loginWallMatches = (agentResultText.match(_LOGIN_WALL_RE) || []).length;
    const _hasOAuthProvider  = _OAUTH_PROVIDERS_RE.test(agentResultText);
    const _isLoginWall       = _loginWallMatches >= 2 && agentResultText.trim().split(/\n+/).length < 50;

    if (_isLoginWall || _hasOAuthProvider || agentResult?.loginWallDetected) {
        logger.warn(`[browser.agent] Login wall detected for ${agentId} (signals=${_loginWallMatches}, oauthProvider=${_hasOAuthProvider}, explicitFlag=${!!agentResult?.loginWallDetected}) — auto-upgrading to isOAuth:true`);
        try {
        await withDb(async (_patchDb) => {
          const _existingRows = _patchDb
            ? await _patchDb.all('SELECT descriptor FROM agents WHERE id = ?', agentId).catch(() => null)
            : null;
          const _existingDesc = _existingRows?.[0]?.descriptor || '';
          if (_existingDesc) {
            // Patch descriptor frontmatter: mark is_oauth:true so lookupBrowserService
            // picks it up on the next run and routes through waitForAuth.
            // Also ensure sign_in_url is set — fall back to startUrl if not already present.
            const _patchedDesc = rewriteDescriptorFrontmatter(_existingDesc, {
              is_oauth: 'true',
              ...(signInUrl ? {} : { sign_in_url: startUrl }),
            });
            const _mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
            fs.writeFileSync(_mdPath, _patchedDesc, 'utf8');
            if (_patchDb) {
              await _patchDb.run(
                'UPDATE agents SET descriptor = ?, status = ? WHERE id = ?',
                _patchedDesc, 'needs_auth', agentId
              );
            }
            logger.info(`[browser.agent] ${agentId} patched: is_oauth=true${_hasOAuthProvider ? ' (OAuth provider buttons detected)' : ''} — attempting auto-retry with waitForAuth`);
          }
        })
        } catch (patchErr) {
        logger.warn(`[browser.agent] login-wall patch failed for ${agentId}: ${patchErr.message}`);
        }

        // ── Auto-retry: trigger waitForAuth inline and re-run the agent once ──────
        // This avoids requiring a manual re-run after the DB patch. The _loginWallRetried
        // flag (passed via args) prevents an infinite retry loop if the second run also
        // sees a wall (e.g. waitForAuth timed out, user didn't sign in).
        if (!_loginWallRetried && !_useAgentBrowser) {
        logger.info(`[browser.agent] auto-retry: calling waitForAuth for ${agentId} then re-delegating to ${_agentSkill}`);

        // ── Emit task:auth_required so the UI shows the full auth overlay ────
        const _svcDisplay = agentId.replace('.agent', '').replace(/_/g, ' ');
        if (_progressCallbackUrl) {
          try {
            const http = require('http');
            const _authPayload = JSON.stringify({
              type: 'task:auth_required',
              agentId,
              serviceDisplay: _svcDisplay,
              loginUrl: signInUrl || startUrl,
              sessionId,
              stepIndex: _stepIndex ?? 0,
              message: `Sign in to ${_svcDisplay} in the browser window that just opened.`,
            });
            const _authReq = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_authPayload) }, timeout: 3000 });
            _authReq.on('error', () => {});
            _authReq.write(_authPayload);
            _authReq.end();
          } catch (_notifyErr) { /* fire-and-forget */ }
        }

        try {
          const _wallAuthResult = await callBrowserAct({
            action: 'waitForAuth',
            sessionId,
            url: signInUrl || startUrl,
            authSuccessUrl: authSuccessPattern,
            hostAliases,
            postAuthUrl,
            timeoutMs: 5 * 60 * 1000,
            _progressCallbackUrl,
          }, 6 * 60 * 1000);

          if (_wallAuthResult?.ok) {
            logger.info(`[browser.agent] waitForAuth succeeded after login-wall upgrade for ${agentId} — retrying ${_agentSkill}`);
            // ── Emit task:auth_resolved so the UI dismisses the auth overlay ──
            if (_progressCallbackUrl) {
              try {
                const http = require('http');
                const _resolvedPayload = JSON.stringify({ type: 'task:auth_resolved', agentId, sessionId, stepIndex: _stepIndex ?? 0 });
                const _resolvedReq = http.request({ hostname: '127.0.0.1', port: parseInt(new URL(_progressCallbackUrl).port, 10), path: new URL(_progressCallbackUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_resolvedPayload) }, timeout: 3000 });
                _resolvedReq.on('error', () => {});
                _resolvedReq.write(_resolvedPayload);
                _resolvedReq.end();
              } catch (_) { /* fire-and-forget */ }
            }
            // Restore status to 'healthy' now that auth is confirmed working — ensures
            // planSkills re-includes this agent in the AVAILABLE AGENTS list for future plans.
            try {
              await withDb(async (_healDb) => {
                await _healDb.run('UPDATE agents SET status=? WHERE id=? AND status=?', 'healthy', agentId, 'needs_auth').catch(() => {});
              });
            } catch (_) {}
            const _retryResult = await _withSessionMutex(sessionId, () => callSkill(_agentSkill, {
              goal: _effectiveTask,
              agentContext: _agentContext,
              url: startUrl,
              sessionId,
              agentId,
              autoConnect: _effectiveAutoConnect,
              chromeProfile: _usePersistentProfile ? AGENT_BROWSER_PROFILE
                : (!_effectiveAutoConnect && _useAutoConnect ? 'Default' : undefined),
              headed: _usePersistentProfile ? true : undefined,
              maxTurns: _dynamicMaxTurns,
              timeoutMs: 30000,
              overallTimeoutMs: Math.max(180000, _dynamicMaxTurns * 10000),
              authConfirmedAt: Date.now(),
              _progressCallbackUrl,
              _stepIndex,
              _loginWallRetried: true,  // prevent recursive retry
              _abortSignal: _abortSignal,
            }, 600000, _abortSignal));
            return {
              ok: _retryResult?.ok ?? false,
              agentId,
              task,
              sessionId,
              authenticated: true,
              result: _retryResult?.result || _retryResult?.stdout || '',
              transcript: _retryResult?.transcript || [],
              turns: _retryResult?.turns,
              done: _retryResult?.done,
              error: _retryResult?.error,
              autoRetriedAfterLoginWall: true,
            };
          } else {
            logger.warn(`[browser.agent] waitForAuth did not complete for ${agentId} (user may not have signed in) — surfacing ASK_USER`);
          }
        } catch (retryErr) {
          logger.warn(`[browser.agent] auto-retry after login-wall threw: ${retryErr.message}`);
        }
        }

        const _svcDisplayFinal = agentId.replace('.agent', '').replace(/_/g, ' ');
        return {
        ok: false,
        agentId,
        task,
        askUser: true,
        sessionExpired: true,
        question: `${_svcDisplayFinal} session has expired. Please re-authenticate in the Agents tab to resume scheduled tasks.`,
        options: [],
        error: `Login wall detected for ${agentId} — service requires authentication.`,
        loginWallDetected: true,
        oauthUpgraded: true,
        };
    }
    // ─────────────────────────────────────────────────────────────────────────

    // When the run succeeded and startUrl was auto-corrected by the destination resolver,
    // reinforce the correction memory so future runs auto-correct with full confidence.
    // Skip for search-criteria tasks — the startUrl encodes task-specific filter criteria
    // (e.g., #search/is:unread from:pastor wendall) and should NOT be recorded as a
    // generic intent correction. Otherwise future "check gmail" tasks (without criteria)
    // would be auto-corrected to the criteria-specific search URL.
    if (agentResult?.ok === true && !_isSearchCriteriaTask(task)) {
        try {
        const _confirmedIntent = await classifyTaskIntent(task, _svcKey);
        const _origUrl = extractDescriptorUrl(existing.descriptor, 'start_url');
        if (_origUrl && startUrl !== _origUrl) {
          setImmediate(() => {
            recordCorrection(_svcKey, _confirmedIntent, startUrl).catch(() => {});
          });
        }
        } catch (_) {}
    }

    // ── Research content quality gate ─────────────────────────────────────────
    // Catches pages that passed the login-wall detector above (e.g. Qwen welcome
    // screen, Perplexity nav-only result) but returned no substantive research
    // content.  Criteria for "empty research":
    //   • task intent is research or chat
    //   • result is sparse (< 40 lines)
    //   • no keyword overlap with the task topic (< 2 words from task in result)
    //   • result does NOT contain multi-sentence prose (< 3 sentences)
    // When detected, return a structured failure so executeCommand / recoverSkill
    // can surface ASK_USER with alternative source options instead of silently
    // passing an empty result to the synthesize step.
    if (agentResult?.ok === true) {
        // Use classifyTaskIntent (LLM + ordered regex) instead of a single regex.
        // A single regex like /\bwhat\s+is\b/i matches "what is" inside post titles
        // (e.g. "Create a post with title 'What is a favorite tradition?'") and
        // falsely classifies a CONTENT_CREATE/SOCIAL task as research → false
        // positive quality-gate failure. classifyTaskIntent properly prioritizes
        // "create a post" (CONTENT_CREATE) over "what is" (RESEARCH) in the title.
        const _MUTATION_INTENTS = new Set([INTENTS.CONTENT_CREATE, INTENTS.SOCIAL, INTENTS.MAIL, INTENTS.SCHEDULING, INTENTS.COMMERCE]);
        const _taskIntent = await classifyTaskIntent(task, _svcKey).catch(() => INTENTS.HOME);
        const _taskIsResearch = !_MUTATION_INTENTS.has(_taskIntent);
        logger.info(`[browser.agent] Research quality gate: intent=${_taskIntent} isResearch=${_taskIsResearch} for task="${String(task).slice(0, 60)}"`);
        if (_taskIsResearch) {
        const _httpStatus = Number.isInteger(agentResult?.httpStatus) ? agentResult.httpStatus : null;
        if (_httpStatus !== null && _httpStatus >= 400) {
          logger.warn(`[browser.agent] Research quality gate: http error for ${agentId} (status=${_httpStatus}) — marking serviceUnavailable`);
          return {
            ok: false,
            agentId,
            task,
            error: `${agentId} could not fulfill the research step because the service returned HTTP ${_httpStatus}.`,
            researchContentEmpty: true,
            serviceUnavailable: true,
            unavailableReason: `HTTP ${_httpStatus}`,
            httpStatus: _httpStatus,
          };
        }
        const _lines = agentResultText.trim().split(/\n+/).filter(l => l.trim().length > 2);
        // Content density scoring — nav/welcome pages have few long sentences;
        // research pages have many lines with >6 words. Avoids fragile topic-word
        // matching which causes false positives on synonyms / paraphrased results.
        const _longLines = _lines.filter(l => l.trim().split(/\s+/).length > 6).length;
        const _totalWords = agentResultText.trim().split(/\s+/).filter(Boolean).length;
        const _isSparse = _longLines < 3 && _totalWords < 60;
        // URL-based no-results detection — a search URL with sparse content is a
        // legitimate "no results" page, NOT a navigation/welcome page. This is more
        // robust than regex-matching phrases because the URL is deterministic.
        const _currentUrl = (() => {
          try { return new URL(startUrl || '').href.toLowerCase(); } catch (_) { return ''; }
        })();
        const _isSearchUrl = /#search\/|\?q=|\?search=|\?filter=|\?query=|\/search\?/i.test(_currentUrl);
        // Transcript-based fallback — check if any getPageText result contains
        // "no results" text. Catches cases where the URL check doesn't apply but
        // the transcript has the actual page text.
        const _transcriptHasNoResults = agentResult?.transcript?.some(step => {
          const stepResult = step.outcome?.result || step.result?.text || step.result;
          const text = String(stepResult || '').toLowerCase();
          return /\b(no messages matched|no results?\s*(?:found|matched)?|nothing (?:found|matched)|no matching)\b/i.test(text);
        });
        // Check if we have video links or comprehensive content extracted - if so, don't fail on sparse content
        const _hasVideoLinks = agentResult?.transcript?.some(step => 
          step.action === 'getPageLinks' && step.result && step.result.length > 0
        );
        const _hasExtractedContent = agentResult?.transcript?.some(step =>
          step.action === 'extractContent' && step.result && 
          (step.result.text || step.result.links) && 
          ((step.result.text?.length || 0) > 100 || (step.result.links?.length || 0) > 0)
        );
        if (_isSparse && !_hasVideoLinks && !_hasExtractedContent && !_isSearchUrl && !_transcriptHasNoResults) {
          // ── Capture-timing miss retry ────────────────────────────────────────
          // If the result looks like a premature capture (sentinel string from
          // playwright.agent's "assuming success" fallback, or generic sparse text),
          // the AI response may still be streaming. Do ONE bounded re-extraction:
          // wait for text stability on the live session, then re-check.
          const _looksLikeCaptureMiss = /^Submitted \(|Completed via field map|no verification configured/i.test(agentResultText)
            || agentResultText.trim().split(/\s+/).filter(Boolean).length < 10;
          if (_looksLikeCaptureMiss && sessionId) {
            logger.info(`[browser.agent] Research quality gate: sparse result looks like capture-timing miss — re-extracting from live session (up to 15s)`);
            try {
              // Wait for text stability: poll innerText length, exit after 2s no-growth
              const _reExtractDeadline = Date.now() + 15000;
              let _prevLen = 0;
              let _lastChange = Date.now();
              while (Date.now() < _reExtractDeadline) {
                const _lenRes = await callBrowserAct({ action: 'evaluate', text: '(document.body?.innerText || "").length', sessionId, headed: true }, 10000).catch(() => null);
                const _curLen = Number(_lenRes?.result ?? _lenRes?.ok ?? 0) || 0;
                if (_curLen !== _prevLen) { _lastChange = Date.now(); _prevLen = _curLen; }
                if (_prevLen > 200 && (Date.now() - _lastChange) > 2000) break;
                await new Promise(r => setTimeout(r, 500));
              }
              // Re-extract page text
              const _freshRes = await callBrowserAct({ action: 'getPageText', sessionId, headed: true, timeoutMs: 10000 }).catch(() => null);
              const _freshText = String(_freshRes?.result || '').trim();
              if (_freshText) {
                const _freshLines = _freshText.trim().split(/\n+/).filter(l => l.trim().length > 2);
                const _freshLongLines = _freshLines.filter(l => l.trim().split(/\s+/).length > 6).length;
                const _freshTotalWords = _freshText.trim().split(/\s+/).filter(Boolean).length;
                const _freshIsSparse = _freshLongLines < 3 && _freshTotalWords < 60;
                logger.info(`[browser.agent] Research quality gate: re-extraction got ${_freshText.length} chars (longLines=${_freshLongLines}, totalWords=${_freshTotalWords}, sparse=${_freshIsSparse})`);
                if (!_freshIsSparse) {
                  // Substantive content found — update result and skip the failure
                  agentResultText = _freshText;
                  if (agentResult) agentResult.result = _freshText;
                  logger.info(`[browser.agent] Research quality gate: re-extraction recovered substantive content — proceeding`);
                  // Skip the sparse failure below by re-evaluating
                } else {
                  logger.warn(`[browser.agent] Research quality gate: sparse content for ${agentId} (longLines=${_longLines}, totalWords=${_totalWords}) — marking researchContentEmpty`);
                  return {
                    ok: false,
                    agentId,
                    task,
                    error: `${agentId} returned navigation/welcome content instead of research data (${_longLines} content lines, ${_totalWords} total words). The service may require login or the URL landed on the wrong page.`,
                    researchContentEmpty: true,
                  };
                }
              } else {
                logger.warn(`[browser.agent] Research quality gate: re-extraction returned empty — marking researchContentEmpty`);
                return {
                  ok: false,
                  agentId,
                  task,
                  error: `${agentId} returned navigation/welcome content instead of research data (${_longLines} content lines, ${_totalWords} total words). The service may require login or the URL landed on the wrong page.`,
                  researchContentEmpty: true,
                };
              }
            } catch (_reExtractErr) {
              logger.warn(`[browser.agent] Research quality gate: re-extraction failed: ${_reExtractErr.message} — marking researchContentEmpty`);
              return {
                ok: false,
                agentId,
                task,
                error: `${agentId} returned navigation/welcome content instead of research data (${_longLines} content lines, ${_totalWords} total words). The service may require login or the URL landed on the wrong page.`,
                researchContentEmpty: true,
              };
            }
          } else {
            logger.warn(`[browser.agent] Research quality gate: sparse content for ${agentId} (longLines=${_longLines}, totalWords=${_totalWords}) — marking researchContentEmpty`);
            return {
              ok: false,
              agentId,
              task,
              error: `${agentId} returned navigation/welcome content instead of research data (${_longLines} content lines, ${_totalWords} total words). The service may require login or the URL landed on the wrong page.`,
              researchContentEmpty: true,
            };
          }
        }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Declare _saveSkillOffer and _autoRecipeCreated BEFORE _runResult construction
    // to avoid a TDZ (Temporal Dead Zone) crash: _runResult references _saveSkillOffer
    // but the offer logic that sets it runs AFTER _runResult is built. We set
    // _runResult.saveSkillOffer after the offer block completes.
    let _autoRecipeCreated = false;
    let _saveSkillOffer = null;

    // Capture final URL for downstream steps (executeCommand auto-injects it
    // into subsequent browser.agent steps, replacing creation URLs like notion.new/)
    let _finalUrl = '';
    try {
        const _urlRes = await callBrowserAct({ action: 'evaluate', text: 'window.location.href', sessionId, timeoutMs: 3000 }, 5000).catch(() => ({ ok: false }));
        _finalUrl = _urlRes?.ok ? String(_urlRes.result || '').trim().replace(/^"|"$/g, '') : '';
    } catch (_) {}

    const _runResult = {
        ok: agentResult?.ok ?? false,
        agentId,
        task,
        sessionId,
        authenticated: true,
        result: agentResultText,
        url: _finalUrl,
        transcript: agentResult?.transcript || [],
        turns: agentResult?.turns,
        done: agentResult?.done,
        httpStatus: Number.isInteger(agentResult?.httpStatus) ? agentResult.httpStatus : undefined,
        error: agentResult?.error,
        // Phase 3: set below after the offer block computes _saveSkillOffer
        saveSkillOffer: null,
    };

    // ── App Knowledge: success verification write-back ──────────────────────
    // On a successful run, bump verifiedRuns for any app-knowledge entries whose
    // shortcut/selector appeared in the transcript. This reinforces high-quality
    // entries and lets bad entries decay via recordVerification(false) on failure.
    if (_runResult.ok === true && _appKnowledgeEntries.length > 0) {
        try {
            const _akHost = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
            if (_akHost) {
                const _transcriptText = JSON.stringify(_runResult.transcript || []).toLowerCase();
                for (const _entry of _appKnowledgeEntries) {
                    const _sig = (_entry.details?.shortcut || '').toLowerCase()
                        + ' ' + (_entry.details?.selector || '').toLowerCase();
                    if (_sig.trim() && _transcriptText.includes(_sig.trim().split(/\s+/)[0])) {
                        // recordVerification is synchronous (returns undefined, not a Promise),
                        // so .catch() must NOT be used — wrap in try/catch inside setImmediate
                        // so a failure here can never crash the command-service process.
                        setImmediate(() => { try { recordVerification(_akHost, _entry.id, true); } catch (_) { /* non-fatal */ } });
                    }
                }
            }
        } catch (_) { /* non-fatal */ }
    }

    // ── appKnowledge intent_url verification ─────────────────────────────────
    // If the deep-link came from appKnowledge, record success/failure so the
    // entry's confidence is bumped (success) or decayed (failure). Bad URLs
    // self-clean: confidence < 0.2 gets dropped by recordVerification.
    if (_deepLinkSource === 'appKnowledge' && _deepLinkIntent) {
        const _akHost = (() => { try { return new URL(startUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
        if (_akHost) {
            const _intentUrlId = `${_akHost}.intent_url.${_deepLinkIntent}`;
            setImmediate(() => {
                try { recordVerification(_akHost, _intentUrlId, _runResult.ok === true); } catch (_) { /* non-fatal */ }
            });
        }
    }

    // ── Save-as-named-skill offer (Phase 3) ────────────────────────────────────
    // After a successful mutation run that was NOT recipe-driven, offer to save
    // the flow as a named, URL-first recipe — but ASK the user first (don't
    // auto-save, which risks cementing hollow successes). The user confirms +
    // names it (e.g. linkedin.post.update); on resume, main.js calls
    // trainerAgent.saveAutoRecipe with the chosen name.
    if (_runResult.ok === true && !_trainedRecipeInjected && _runResult.transcript.length >= 2) {
        // Only offer for mutation runs (click/submit/fill), not pure extractions
        const _isMutationRun = _runResult.transcript.some(t => {
          const _a = t.action?.action || t.step?.action || '';
          return /click|submit|fill|check|select/i.test(typeof _a === 'string' ? _a : '');
        });
        if (_isMutationRun) {
          // Stash the transcript to a temp file so it survives the ASK_USER pause.
          // The resume handler reads it back when the user confirms a name.
          try {
            const _os = require('os');
            const _stashPath = path.join(_os.tmpdir(), `thinkdrop-recipe-${agentId}-${Date.now()}.json`);
            fs.writeFileSync(_stashPath, JSON.stringify({
              transcript: _runResult.transcript,
              task,
              targetUrl: startUrl,
              agentContext: _agentContext,
            }), 'utf8');
            // Suggest a dot-name from the agentId + task keywords
            const _svc = (agentId || '').replace(/\.agent$/, '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'agent';
            const _goalWords = (task || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
              .filter(w => w.length > 2 && !['the','and','for','with','from','your','this','that','into','open','send','post','create'].includes(w)).slice(0, 2);
            const _suggestedName = _goalWords.length > 0 ? `${_svc}.${_goalWords.join('.')}` : `${_svc}.custom`;
            _saveSkillOffer = { suggestedName: _suggestedName, transcriptPath: _stashPath, task, agentId };
            logger.info(`[browser.agent] Phase 3: saveSkillOffer — suggested "${_suggestedName}" (transcript stashed at ${_stashPath})`);
          } catch (_stashErr) {
            logger.warn(`[browser.agent] saveSkillOffer stash failed (non-fatal): ${_stashErr.message}`);
          }
        }
    }
    // Now that _saveSkillOffer is computed, attach it to _runResult
    _runResult.saveSkillOffer = _saveSkillOffer;

    // ── Post-run background rescan ────────────────────────────────────────────
    // After a successful run, enqueue a background scan to rebuild domain maps
    // and navigate_history skills with fresh data. This ensures the history index
    // stays current without blocking the current task.
    // Skip when a recipe was used or just created — the workflow is already cached.
    if (_runResult.ok === true && !_trainedRecipeInjected && !_autoRecipeCreated) {
        try {
        const { enqueueScan } = require('./explore.agent.cjs');
        enqueueScan({ url: startUrl, agentId }, 'post_automation');
        } catch (_enqueuErr) {
        // Non-fatal — scan will be triggered on next periodic heartbeat
        }
    }

    // ── Discovered tool playbook write-back ────────────────────────────────────
    // When a discovered external AI tool was used successfully, cache it in
    // semantic memory via tool.discover's namespace so future runs can recall
    // it instantly without re-searching. The agent descriptor already contains
    // the tool URL and capabilities — we write a memory entry with metadata.
    if (_runResult.ok === true && existing?.start_url) {
        try {
        const toolDb = require('../skill-helpers/skill-db.cjs');
        const _svcKey = (existing.service || agentId.replace(/\.agent$/, '')).toLowerCase().replace(/[^a-z0-9]/g, '');
        const _memText = `TOOL_NAME: ${agentId}\nTOOL_URL: ${existing.start_url}\nTOOL_TYPE: browser\nTOOL_TIER: ${existing.is_oauth ? 'free_account' : 'free_no_account'}\nINSTRUCTION: Use browser.agent { action: 'run', agentId: '${agentId}', task: '...' } for tasks on this service.\nSERVICE: ${_svcKey}`;
        toolDb.remember('tool.discover', _memText, { agentId, url: existing.start_url, service: _svcKey }).catch(() => {});
        logger.info(`[browser.agent] Discovered tool write-back: cached ${agentId} for future recall`);
        } catch (_writeBackErr) {
        // Non-fatal — best-effort caching
        }
    }

    // ── Minimize browser window after successful completion ───────────────────
    if (_runResult.ok === true && _usePersistentProfile) {
        try {
        await browserAct({ action: 'minimize', sessionId, headed: true });
        } catch (minimizeErr) {
        logger.debug(`[browser.agent] minimize failed (non-critical): ${minimizeErr.message}`);
        }
    }

    return _runResult;
  } catch (err) {
    // If the user cancelled, surface a clean cancelled result instead of a
    // generic delegation-failure error (which would trigger LLM recovery).
    if (_abortSignal?.aborted || /aborted/i.test(err.message || '')) {
      logger.info(`[browser.agent] run: cancelled by user for ${agentId}`);
      return { ok: false, agentId, task, error: 'Cancelled by user', cancelled: true };
    }
    return { ok: false, agentId, task, error: `playwright.agent delegation failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: scan_page — headless DOM scan of login/setup page
// Returns structured field list so the UI card can render actual inputs.
// ---------------------------------------------------------------------------

const SCAN_PAGE_SYSTEM_PROMPT = `You are a web page analyzer. Given a DOM snapshot of a login or credential setup page, extract all the input fields the user needs to fill in to authenticate or get an API key.

Output ONLY valid JSON:
{
  "pageType": "login" | "api_key" | "oauth_setup" | "unknown",
  "fields": [
    {
        "name": "<machine-readable key name, e.g. GMAIL_EMAIL>",
        "label": "<human-readable label from page, e.g. Email or phone>",
        "type": "email" | "password" | "text" | "url",
        "placeholder": "<placeholder text if any>",
        "required": true | false
    }
  ],
  "submitLabel": "<text on the submit button, e.g. Next or Sign in>",
  "pageTitle": "<title of the page>",
  "notes": "<one sentence about what this page is asking for>"
}

Rules:
- For Google/Gmail login pages: fields = [{name:"GMAIL_EMAIL", label:"Email or phone", type:"email", required:true}]
- For password step: fields = [{name:"GMAIL_PASSWORD", label:"Password", type:"password", required:true}]
- For API key pages: fields = [{name:"API_KEY", label:"API Key", type:"text", required:true}]
- For OAuth setup (Client ID + Secret): fields = [{name:"CLIENT_ID", label:"Client ID", type:"text"}, {name:"CLIENT_SECRET", label:"Client Secret", type:"password"}]
- Map field names to SCREAMING_SNAKE_CASE with service prefix where appropriate
- Only include fields actually visible in the DOM, not hidden/disabled ones`;

// Extract sign_in_url: or start_url: from a descriptor frontmatter string
function extractDescriptorUrl(descriptor, field) {
  if (!descriptor) return null;
  const line = descriptor.split('\n').find(l => l.startsWith(`${field}:`));
  return line ? line.replace(`${field}:`, '').trim() : null;
}

async function actionScanPage({ service, url: explicitUrl, secretKey }) {
  const serviceKey = (service || '').toLowerCase().replace(/[^a-z0-9_]/g, '');

  let scanUrl = explicitUrl;
  if (!scanUrl && serviceKey) {
    // Priority 1: DuckDB descriptor sign_in_url: (written/corrected by validate_agent)
    const agentId = `${serviceKey}.agent`;
    const stored = await actionQueryAgent({ id: agentId }).catch(() => null);
    const storedSignIn = stored?.found ? extractDescriptorUrl(stored.descriptor, 'sign_in_url') : null;
    if (storedSignIn) {
        scanUrl = storedSignIn;
        logger.info(`[browser.agent] scan_page: using DuckDB sign_in_url for ${service}: ${scanUrl}`);
    } else {
        // Priority 2: seed map startUrl (bootstrap fallback only)
        const meta = await resolveBrowserMeta(service).catch(() => null);
        scanUrl = meta?.startUrl || `https://${serviceKey}.com`;
        logger.info(`[browser.agent] scan_page: no stored sign_in_url — using seed startUrl: ${scanUrl}`);
    }
  }
  if (!scanUrl) return { ok: false, error: 'url or service is required for scan_page' };

  logger.info(`[browser.agent] scan_page: scanning ${scanUrl} for service="${service}"`);

  // Use headless browser.act scanCurrentPage (isolated, no cookies)
  let domSnapshot = '';
  try {
    const scanResult = await callBrowserAct({
        action: 'scanCurrentPage',
        url: scanUrl,
        sessionId: `scan_${serviceKey}_${Date.now()}`,
        isolated: true,
        timeoutMs: 20000,
    }, 30000);
    if (scanResult?.elements) {
        // Flatten elements to a readable text snapshot for the LLM
        domSnapshot = (scanResult.elements || [])
        .slice(0, 60)
        .map(el => `[${el.tag}] label="${el.label || ''}" placeholder="${el.placeholder || ''}" type="${el.type || ''}" id="${el.id || ''}" name="${el.name || ''}"`)
        .join('\n');
    } else if (scanResult?.html) {
        domSnapshot = scanResult.html.slice(0, 4000);
    } else if (typeof scanResult === 'string') {
        domSnapshot = scanResult.slice(0, 4000);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: DOM scan failed (${err.message}), using LLM knowledge only`);
  }

  // Ask LLM to interpret what fields this page needs
  const userQuery = [
    `Service: ${service}`,
    `URL: ${scanUrl}`,
    secretKey ? `We need to collect: ${secretKey}` : '',
    domSnapshot ? `\nDOM snapshot:\n${domSnapshot}` : '\n(DOM scan unavailable — use your knowledge of this service\'s login page)',
  ].filter(Boolean).join('\n');

  let parsed = null;
  try {
    const raw = await callLLM(SCAN_PAGE_SYSTEM_PROMPT, userQuery, { temperature: 0.1, maxTokens: 600 });
    if (raw) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
    }
  } catch (err) {
    logger.warn(`[browser.agent] scan_page: LLM parse failed: ${err.message}`);
  }

  // Hard fallback: return sensible defaults based on secretKey naming
  if (!parsed || !parsed.fields || parsed.fields.length === 0) {
    const key = (secretKey || '').toUpperCase();
    const isPassword = key.includes('PASSWORD') || key.includes('SECRET');
    const isEmail    = key.includes('EMAIL') || key.includes('USER');
    parsed = {
        pageType: 'unknown',
        fields: [{
        name: secretKey || `${serviceKey.toUpperCase()}_KEY`,
        label: (secretKey || 'API Key').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        type: isPassword ? 'password' : isEmail ? 'email' : 'text',
        placeholder: '',
        required: true,
        }],
        pageTitle: service,
        notes: `Credential required for ${service}`,
    };
  }

  logger.info(`[browser.agent] scan_page: found ${parsed.fields.length} field(s) for ${service} (${parsed.pageType})`);
  return {
    ok: true,
    service,
    url: scanUrl,
    pageType: parsed.pageType,
    fields: parsed.fields,
    submitLabel: parsed.submitLabel || 'Submit',
    pageTitle: parsed.pageTitle || service,
    notes: parsed.notes || '',
  };
}

// ---------------------------------------------------------------------------
// Action: delete_agent — remove all artifacts tied to an agent
// ---------------------------------------------------------------------------

async function actionDeleteAgent({ id }) {
  if (!id) return { ok: false, error: 'id is required' };

  const deleted = [];
  const errors  = [];

  logger.info(`[browser.agent] delete_agent: starting delete for ${id}`);
  logger.info(`[browser.agent] delete_agent: AGENTS_DIR = ${AGENTS_DIR}`);
  logger.info(`[browser.agent] delete_agent: AGENTS_DB_PATH = ${AGENTS_DB_PATH}`);

  // ── 1. Read descriptor before deleting (need hostname for domain-map) ──────
  let hostname = null;
  
  // Try multiple file naming patterns
  const possiblePaths = [
    path.join(AGENTS_DIR, `${id}.agent.md`),  // w3schools.agent.md
    path.join(AGENTS_DIR, `${id}.md`),         // w3schools.agent.md (if id already has .agent)
    path.join(AGENTS_DIR, `${id.replace(/\.agent$/, '')}.agent.md`), // w3schools.agent.md
  ];
  
  logger.info(`[browser.agent] delete_agent: checking paths: ${JSON.stringify(possiblePaths)}`);

  // Debug: list actual files in AGENTS_DIR
  try {
    const files = fs.readdirSync(AGENTS_DIR);
    logger.info(`[browser.agent] delete_agent: files in AGENTS_DIR: ${JSON.stringify(files)}`);
  } catch (e) {
    logger.error(`[browser.agent] delete_agent: cannot read AGENTS_DIR: ${e.message}`);
  }

  let agentMdPath = null;
  for (const tryPath of possiblePaths) {
    const exists = fs.existsSync(tryPath);
    logger.info(`[browser.agent] delete_agent: checking ${tryPath}: ${exists}`);
    if (exists) {
        agentMdPath = tryPath;
        break;
    }
  }

  // Fuzzy fallback: normalize both the requested id and each filename to find closest match.
  // Handles mismatches where UI sends display id (e.g. 'w3schoolsagent') but file is
  // stored as 'w3schools.agent.md' (canonical id 'w3schools.agent').
  if (!agentMdPath) {
    try {
        const _norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const _idNorm = _norm(id);
        const _allFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.agent.md'));
        const _match = _allFiles.find(f => {
        const base = f.replace(/\.agent\.md$/, '');
        return _norm(base) === _idNorm || _norm(f.replace(/\.md$/, '')) === _idNorm;
        });
        if (_match) {
        agentMdPath = path.join(AGENTS_DIR, _match);
        logger.info(`[browser.agent] delete_agent: fuzzy match found: ${_match} for id=${id}`);
        } else {
        logger.warn(`[browser.agent] delete_agent: no .md file found for ${id} (fuzzy scan also failed)`);
        }
    } catch (_fuzzyErr) {
        logger.warn(`[browser.agent] delete_agent: no .md file found for ${id}`);
    }
  }

  if (agentMdPath) {
    try {
        const desc = fs.readFileSync(agentMdPath, 'utf8');
        const urlMatch = desc.match(/^start_url:\s*(.+)$/m);
        if (urlMatch) {
        try { hostname = new URL(urlMatch[1].trim()).hostname.replace(/^www\./, ''); } catch (_) {}
        }
    } catch (_) {}
    try { fs.rmSync(agentMdPath, { force: true }); deleted.push(agentMdPath); logger.info(`[browser.agent] delete_agent: removed file ${agentMdPath}`); } catch (e) { errors.push(e.message); }
  }

  // ── 2. DuckDB: agents table + browser_meta_cache ────────────────────────────
  try {
    await withDb(async (db) => {
        const service = id.replace(/\.agent$/, '');
        logger.info(`[browser.agent] delete_agent: looking for service = ${service}`);
        
        // Check if agent exists before delete
        const beforeRows = await db.all('SELECT id FROM agents WHERE id = ?', id).catch((e) => {
        logger.error(`[browser.agent] delete_agent: SELECT error: ${e.message}`);
        return [];
        });
        logger.info(`[browser.agent] delete_agent: found ${beforeRows.length} rows for id = ${id}`);
        if (beforeRows.length > 0) {
        await db.run('DELETE FROM agents WHERE id = ?', id);
        deleted.push(`DuckDB agents row: ${id}`);
        logger.info(`[browser.agent] delete_agent: removed ${id} from DuckDB agents table`);
        } else {
        // Fuzzy fallback: match by normalized service name so 'w3schoolsagent' finds 'w3schools.agent'
        const _norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const _idNorm = _norm(id);
        const allAgents = await db.all('SELECT id, service FROM agents').catch(() => []);
        const _fuzzyRow = allAgents.find(r =>
          _norm(r.id) === _idNorm ||
          _norm(r.service || '') === _idNorm ||
          _norm(r.id.replace(/\.agent$/, '')) === _idNorm
        );
        if (_fuzzyRow) {
          await db.run('DELETE FROM agents WHERE id = ?', _fuzzyRow.id);
          deleted.push(`DuckDB agents row: ${_fuzzyRow.id}`);
          logger.info(`[browser.agent] delete_agent: fuzzy-removed ${_fuzzyRow.id} from DuckDB (matched id=${id})`);
        } else {
          logger.warn(`[browser.agent] delete_agent: agent ${id} not found in DuckDB. Available: ${JSON.stringify(allAgents.map(r => r.id))}`);
        }
        }
        
        // Delete from meta cache — normalize service key to match resolveBrowserMeta's seedKey
        const normalizedService = service.toLowerCase().replace(/[^a-z0-9]/g, '');
        const metaRows = await db.all('SELECT service FROM browser_meta_cache WHERE service = ?', normalizedService).catch(() => []);
        if (metaRows.length > 0) {
        await db.run('DELETE FROM browser_meta_cache WHERE service = ?', normalizedService);
        deleted.push(`DuckDB meta_cache row: ${normalizedService}`);
        }
        
        // Note: withDb closes connection automatically, no need for CHECKPOINT
    });
  } catch (e) { 
    logger.error(`[browser.agent] delete_agent: DuckDB error: ${e.message}`);
    errors.push(`DuckDB: ${e.message}`); 
  }

  // ── 3. Domain map JSON ───────────────────────────────────────────────────────
  if (hostname) {
    const domainMapPath = path.join(os.homedir(), '.thinkdrop', 'domain-maps', `${hostname}.json`);
    if (fs.existsSync(domainMapPath)) {
        try { fs.rmSync(domainMapPath, { force: true }); deleted.push(domainMapPath); } catch (e) { errors.push(e.message); }
    }
  }

  // ── 4. Browser profile dir (persistent Chrome cookies) ──────────────────────
  const service = id.replace(/\.agent$/, '');
  const profileName = `${service}_agent`;
  const profileDir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', profileName);
  if (fs.existsSync(profileDir)) {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); deleted.push(profileDir); }
    catch (e) {
      // Retry after 1s — Chrome may still be releasing file handles
      await new Promise(r => setTimeout(r, 1000));
      try { fs.rmSync(profileDir, { recursive: true, force: true }); deleted.push(profileDir); }
      catch (e2) { errors.push(`Profile dir: ${e2.message}`); }
    }
  }

  // ── 5. AB-sessions auth JSON ─────────────────────────────────────────────────
  const abSessionFile = path.join(os.homedir(), '.thinkdrop', 'ab-sessions', `${profileName}.json`);
  if (fs.existsSync(abSessionFile)) {
    try { fs.rmSync(abSessionFile, { force: true }); deleted.push(abSessionFile); } catch (e) { errors.push(e.message); }
  }

  // ── 6. agent-profile sessions JSON ──────────────────────────────────────────
  const agentProfileFile = path.join(os.homedir(), '.thinkdrop', 'agent-profile', `${profileName}.json`);
  if (fs.existsSync(agentProfileFile)) {
    try { fs.rmSync(agentProfileFile, { force: true }); deleted.push(agentProfileFile); } catch (e) { errors.push(e.message); }
  }

  // ── 7. Temp validate/scan dirs in ab-sessions ────────────────────────────────
  const abDir = path.join(os.homedir(), '.thinkdrop', 'ab-sessions');
  if (fs.existsSync(abDir)) {
    try {
        const entries = fs.readdirSync(abDir);
        for (const entry of entries) {
        if (entry.startsWith(`${id}_`) || entry.startsWith(`${service}.agent_`) || entry.startsWith(`${profileName}_`)) {
          const fullPath = path.join(abDir, entry);
          try { fs.rmSync(fullPath, { recursive: true, force: true }); deleted.push(fullPath); } catch (e) { errors.push(e.message); }
        }
        }
    } catch (_) {}
  }

  // ── 8. scan-state.json — remove from lastRunAgents ───────────────────────────
  const scanStatePath = path.join(os.homedir(), '.thinkdrop', 'scan-state.json');
  if (fs.existsSync(scanStatePath)) {
    try {
        const scanState = JSON.parse(fs.readFileSync(scanStatePath, 'utf8'));
        if (Array.isArray(scanState.lastRunAgents)) {
        const before = scanState.lastRunAgents.length;
        scanState.lastRunAgents = scanState.lastRunAgents.filter(a => a !== id && a !== `${service}.agent`);
        if (scanState.lastRunAgents.length !== before) {
          fs.writeFileSync(scanStatePath, JSON.stringify(scanState, null, 2), 'utf8');
          deleted.push(`scan-state.json entry: ${id}`);
        }
        }
    } catch (e) { errors.push(`scan-state.json: ${e.message}`); }
  }

  // ── 9. Skills directory (trained recipes and atomic skills) ────────────────
  // Skill dirs use domain-based prefixes: e.g. "amazon_com_amazon_homepage_logged_o_*"
  // Delete all dirs that start with the service prefix or domain-derived prefix.
  const skillsBaseDir = path.join(os.homedir(), '.thinkdrop', 'skills');
  if (fs.existsSync(skillsBaseDir)) {
    try {
        const allSkillDirs = fs.readdirSync(skillsBaseDir).filter(f =>
        fs.statSync(path.join(skillsBaseDir, f)).isDirectory()
        );
        const servicePrefix = service.toLowerCase();
        const idPrefix = id.replace(/\./g, '_').toLowerCase();
        for (const dir of allSkillDirs) {
        const dirLower = dir.toLowerCase();
        if (dirLower.startsWith(servicePrefix + '_') ||
            dirLower.startsWith(idPrefix + '_') ||
            dirLower === servicePrefix || dirLower === idPrefix) {
          const fullPath = path.join(skillsBaseDir, dir);
          try { fs.rmSync(fullPath, { recursive: true, force: true }); deleted.push(fullPath); }
          catch (e) { errors.push(e.message); }
        }
        }
    } catch (e) { errors.push(`skills dir scan: ${e.message}`); }
  }

  // ── 10. installed_skills in user-memory service (HTTP API on port 3001) ────
  // Delete rows where source_domain matches the agent's service.
  try {
    const userMemPort = process.env.USER_MEMORY_PORT || '3001';
    const removePayload = JSON.stringify({ payload: { sourceDomain: service } });
    await new Promise((resolve) => {
        const req = http.request(
        { hostname: '127.0.0.1', port: parseInt(userMemPort), path: '/skill.removeByDomain', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(removePayload) } },
        (res) => { res.on('data', () => {}); res.on('end', () => resolve()); }
        );
        req.on('error', () => resolve());
        req.setTimeout(3000, () => { req.destroy(); resolve(); });
        req.end(removePayload);
    });
    deleted.push(`installed_skills rows for domain: ${service}`);
  } catch (e) { errors.push(`installed_skills cleanup: ${e.message}`); }

  // ── 11. Clear in-memory auth check cache ───────────────────────────────────
  _authCheckCache.delete(id.toLowerCase());
  _authCheckCache.delete(id.replace(/\.agent$/, '').toLowerCase());
  logger.info(`[browser.agent] delete_agent: cleared auth check cache for ${id}`);

  logger.info(`[browser.agent] delete_agent: removed ${deleted.length} artifacts for ${id}`, { deleted, errors });
  return { ok: true, deleted, errors };
}

// ---------------------------------------------------------------------------
// Action: record_failure — append a runtime error to failure_log
// ---------------------------------------------------------------------------

async function actionRecordFailure({ id, failureEntry }) {
  if (!id || !failureEntry) return { ok: false, error: 'id and failureEntry are required' };
  return await withDb(async (db) => {
    const row = await db.get('SELECT failure_log FROM agents WHERE id = ?', id);
    if (!row) return { ok: false, error: `Agent not found: ${id}` };
    const existing = row.failure_log || '';
    const entries = existing ? existing.split('\n---\n') : [];
    entries.unshift(failureEntry);
    const trimmed = entries.slice(0, 5).join('\n---\n');
    await db.run(
        'UPDATE agents SET failure_log = ?, status = CASE WHEN status = \'healthy\' THEN \'degraded\' ELSE status END WHERE id = ?',
        trimmed, id
    );
    logger.info(`[browser.agent] record_failure: appended runtime error for ${id}`);
    return { ok: true, agentId: id };
  });
}

// ---------------------------------------------------------------------------
// Action: authenticate
// ---------------------------------------------------------------------------
// Ensures a browser or API-key agent has valid credentials/session before the
// plan runs. Reuses actionRun's agent lookup + auth flow but stops as soon as
// auth succeeds. Called from preflightAgents.
async function actionAuthenticate({ agentId, task, url, skipAuth, manualLogin = false, preflightProbe = false, forceAuthProbe = false, requireCookieConfirmation = false, _progressCallbackUrl }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };
  const authTask = task || `Authenticate to ${agentId}`;
  return await actionRun({
    agentId,
    task: authTask,
    url,
    skipAuth,
    manualLogin,
    preflightProbe,
    forceAuthProbe,
    requireCookieConfirmation,
    _progressCallbackUrl,
    _authOnly: true,
  });
}

// ---------------------------------------------------------------------------
// actionExplore — resolve agent URL then invoke explore.agent
// ---------------------------------------------------------------------------
async function actionExplore({ agentId, goal, url, sessionId, maxDepth, maxNavItems, mode, _progressCallbackUrl }) {
  if (!agentId) return { ok: false, error: 'agentId is required' };

  // scan mode does not require a goal
  const resolvedMode = mode || 'execute';
  if (resolvedMode === 'execute' && !goal) return { ok: false, error: 'goal is required' };

  // Resolve start URL from agent descriptor (same pattern as actionRun)
  let existing = await actionQueryAgent({ id: agentId });
  if (!existing.found) {
    const serviceKey = agentId.replace(/\.agent$/, '');
    logger.info(`[browser.agent] explore: agent "${agentId}" not found — attempting auto-build for "${serviceKey}"`);
    try {
        const buildResult = await actionBuildAgent({ service: serviceKey });
        if (buildResult.ok) existing = await actionQueryAgent({ id: agentId });
    } catch (_) {}
    if (!existing.found) {
        return { ok: false, error: `Agent not found: ${agentId}. Build it first with action:build_agent.`, needsBuild: true };
    }
  }

  const startUrl = url || existing.startUrl || existing.descriptor?.match(/start_url:\s*(.+)/)?.[1]?.trim();
  if (!startUrl) return { ok: false, error: `No start URL for agent ${agentId}` };

  const exploreSessionId = sessionId || `${agentId}_explore`;

  // scan mode — route directly to scanDomain (no goal needed)
  if (resolvedMode === 'scan') {
    logger.info(`[browser.agent] explore: scan mode — probing ${startUrl}`);
    const { scanDomain } = require('./explore.agent.cjs');
    return await scanDomain({ url: startUrl, agentId, sessionId: exploreSessionId, _progressCallbackUrl });
  }

  logger.info(`[browser.agent] explore: goal="${goal}" url=${startUrl} session=${exploreSessionId}`);

  const { exploreAgent, enqueueScan } = require('./explore.agent.cjs');
  const result = await exploreAgent({
    goal,
    url: startUrl,
    agentId,
    sessionId: exploreSessionId,
    maxDepth: maxDepth || 4,
    maxNavItems: maxNavItems || 20,
    mode: resolvedMode,
    _progressCallbackUrl,
  });

  // After a successful execute run, enqueue a background post-automation scan
  // Only if the run succeeded and the map hasn't been updated in the last 24h
  if (result?.ok && result?.done) {
    try {
        enqueueScan({ url: startUrl, agentId, _progressCallbackUrl }, 'post_automation');
    } catch (_) { /* non-fatal */ }
  }

  return result;
}

// ---------------------------------------------------------------------------

async function browserAgent(args) {
  const { action } = args || {};

  logger.info('[browser.agent] invoked', { action });

  switch (action) {
    case 'build_agent':
        return await actionBuildAgent(args);

    case 'query_agent':
        return await actionQueryAgent(args);

    case 'list_agents':
        return await actionListAgents();

    case 'validate_agent':
        return await actionValidateAgent(args);

    case 'run':
        return await actionRun(args);

    case 'authenticate':
        return await actionAuthenticate(args);

    case 'explore':
        return await actionExplore(args);

    case 'scan_domain':
        // Shortcut for mode:scan — background probe without a goal
        return await actionExplore({ ...args, mode: 'scan' });

    case 'scan_page':
        return await actionScanPage(args);

    case 'delete_agent':
        return await actionDeleteAgent(args);

    case 'record_failure':
        return await actionRecordFailure(args);

    case 'resolve_deep_link': {
        const { agentId: _aId, serviceKey: _svcKey, startUrl: _startUrl, task: _task, sessionId: _sid, existingDeepLinkUrl: _existing } = args;
        if (!_startUrl || !_task) return { ok: false, error: 'startUrl and task are required for resolve_deep_link' };
        const _result = await _resolveTaskDeepLink(_aId || 'unknown', _svcKey || '', _startUrl, _task, _existing, _sid);
        const _dlUrl = _result?.url || (typeof _result === 'string' ? _result : null);
        // Close any browser session opened during deep-link resolution (authenticated eval)
        if (_sid) {
          await callBrowserAct({ action: 'close', sessionId: _sid, headed: false }, 8000).catch(() => {});
        }
        return { ok: !!_dlUrl, deepLinkUrl: _dlUrl, deepLinkSource: _result?.source || null };
    }

    default:
        return {
        ok: false,
        error: `Unknown action: "${action}". Valid: build_agent | query_agent | list_agents | validate_agent | run | authenticate | explore | scan_domain | scan_page | delete_agent | record_failure | resolve_deep_link`,
        };
  }
}

// ---------------------------------------------------------------------------
// Agent Thinking Helper — generates reasoning text for UI display
// ---------------------------------------------------------------------------

/**
 * Generate agent thinking/reasoning text for user insight.
 * This provides transparency into what the agent is about to do.
 */
function _generateAgentThinking(agentType, context) {
  const { agentId, task, hasUrl, requiresAuth } = context;

  const thoughts = [];

  // Opening statement based on agent type
  thoughts.push(`I'm ${agentType} preparing to execute a task.`);

  // Task analysis
  if (task) {
    const taskSummary = task.length > 100 ? task.slice(0, 100) + '...' : task;
    thoughts.push(`Task: "${taskSummary}"`);
  }

  // URL context
  if (hasUrl) {
    thoughts.push(`I'll navigate to the specified URL.`);
  } else if (agentId) {
    thoughts.push(`I'll work with the ${agentId} agent configuration.`);
  }

  // Auth consideration
  if (requiresAuth) {
    thoughts.push(`Authentication may be required — I'll check for login pages.`);
  }

  // Plan statement
  thoughts.push(`My approach: analyze the page, identify elements, and execute the task step by step.`);

  return thoughts.join(' ');
}

// ---------------------------------------------------------------------------
// LiteParse CLI resolution + auto-install
// (follows the playwright-cli pattern in browser.act.cjs)
// ---------------------------------------------------------------------------
const LIT_CANDIDATES = [
  '/opt/homebrew/bin/lit',
  '/usr/local/bin/lit',
  path.join(os.homedir(), '.npm-global', 'bin', 'lit'),
  path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'lit'),
];

function _findLitCli() {
  for (const c of LIT_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  try {
    const { execSync } = require('child_process');
    execSync('which lit', { timeout: 3000, stdio: 'pipe' });
    return 'lit';
  } catch (_) {}
  return null;
}

let LIT_BIN = _findLitCli();
let LIT_AVAILABLE = !!LIT_BIN;
logger.info(`[browser.agent] LiteParse CLI: ${LIT_BIN || 'not found'} (available=${LIT_AVAILABLE})`);

async function ensureLitAvailable() {
  if (LIT_AVAILABLE) return true;
  logger.info('[browser.agent] LiteParse CLI not found — attempting auto-install');
  try {
    const { execSync } = require('child_process');
    execSync('npm i -g @llamaindex/liteparse', { timeout: 60000, stdio: 'pipe' });
    LIT_BIN = _findLitCli();
    LIT_AVAILABLE = !!LIT_BIN;
    if (LIT_AVAILABLE) logger.info('[browser.agent] LiteParse CLI installed successfully');
    return LIT_AVAILABLE;
  } catch (e) {
    logger.warn(`[browser.agent] LiteParse auto-install failed: ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Web-specific UI element inference (separate from app.agent.cjs desktop schemas)
// ---------------------------------------------------------------------------
const ACTION_TYPES = {
  // Submit actions — complete the task (final action)
  submit: [
    'post', 'share', 'tweet', 'publish',                 // social media
    'send', 'reply', 'forward',                          // email/messaging
    'submit', 'apply', 'confirm', 'update', 'save changes',  // forms
    'create', 'save',                                    // docs/productivity
    'add to cart', 'checkout', 'buy now', 'purchase', 'place order',  // shopping
    'book', 'reserve', 'schedule',                       // booking
    'invite', 'join', 'register', 'sign up',             // membership
    'play', 'like', 'follow', 'subscribe',               // media/social
    'comment', 'react', 'vote', 'rate',                  // engagement
    'download', 'export',                                // data
    'delete', 'archive', 'remove', 'cancel',             // destructive (still submit)
    'log in', 'sign in', 'log out',                      // auth
  ],
  // Start/navigation actions — open something (NOT final action)
  start: [
    'start', 'new', 'open', 'compose', 'begin',
    'add', 'create new', 'new post', 'new message',      // navigation to compose
    'browse', 'view', 'show', 'see',                     // navigation to view
    'edit', 'modify', 'change',                          // navigation to edit
  ],
  // Draft/intermediate actions — save progress but don't complete
  draft: [
    'draft', 'preview', 'save draft', 'save as draft',
  ],
};

// Classify a text item as submit/start/draft/unknown action
// Matches longest phrases first to handle ambiguity ("add to cart" before "add")
function classifyAction(text, goal) {
  const _text = text.trim().toLowerCase();
  const _goal = (goal || '').toLowerCase();
  if (!_text || _text.length > 30) return { type: 'unknown', confidence: 0.3 };

  // Build sorted keyword list (longest first) so "add to cart" matches before "add"
  const _allKeywords = [
    ...ACTION_TYPES.submit.map(kw => ({ kw, type: 'submit' })),
    ...ACTION_TYPES.start.map(kw => ({ kw, type: 'start' })),
    ...ACTION_TYPES.draft.map(kw => ({ kw, type: 'draft' })),
  ].sort((a, b) => b.kw.length - a.kw.length);

  for (const { kw, type } of _allKeywords) {
    if (_text === kw) {
      const _goalMatch = _goal.includes(kw) ? 0.95 : 0.7;
      return { type, confidence: _goalMatch, keyword: kw };
    }
    // Only match startsWith for short keywords (<= 10 chars) to avoid false positives
    if (kw.length <= 10 && _text.startsWith(kw + ' ')) {
      const _goalMatch = _goal.includes(kw) ? 0.85 : 0.6;
      return { type, confidence: _goalMatch, keyword: kw };
    }
  }

  return { type: 'unknown', confidence: 0.3 };
}

// Web-specific UI element schemas with comprehensive element type inference
const BROWSER_CATEGORY_SCHEMAS = {
  // Generic web element inference (applies to all pages)
  web_generic: {
    inferElementType: (textItem, allItems, viewport) => {
      const _w = textItem.width;
      const _h = textItem.height;
      const _text = textItem.text || '';
      const _textLen = _text.length;
      const _area = _w * _h;

      // Button: small text, short text, not full width
      if (_w < 250 && _h < 60 && _textLen <= 30 && _textLen > 0) {
        return { type: 'button', confidence: 0.7 };
      }

      // Input field: wide, short, empty or placeholder text
      if (_w > 200 && _h < 50 && (_textLen < 20 || /^(enter|type|search|placeholder)/i.test(_text))) {
        return { type: 'input', confidence: 0.6 };
      }

      // Dropdown/select: small width, contains ▼ or "select"
      if (_w < 300 && _h < 50 && (/▼|▾|select|choose|dropdown/i.test(_text))) {
        return { type: 'dropdown', confidence: 0.7 };
      }

      // Tab: short text, top of page, in a row with other tabs
      if (_h < 40 && textItem.y < viewport.height * 0.15 && _textLen < 20) {
        const _siblings = allItems.filter(i => Math.abs(i.y - textItem.y) < 20 && i !== textItem);
        if (_siblings.length >= 1) {
          return { type: 'tab', confidence: 0.6 };
        }
      }

      // Menu item: short text, in a vertical list
      if (_textLen < 40 && _h < 40) {
        const _verticalNeighbors = allItems.filter(i =>
          Math.abs(i.x - textItem.x) < 50 &&
          Math.abs(i.y - textItem.y) > 20 && Math.abs(i.y - textItem.y) < 80
        );
        if (_verticalNeighbors.length >= 2) {
          return { type: 'menu_item', confidence: 0.5 };
        }
      }

      // Toolbar: top of page, wide
      if (textItem.y < 80 && _w > 400) {
        return { type: 'toolbar', confidence: 0.6 };
      }

      // Card: medium size, contains multiple text lines
      if (_w > 200 && _h > 100 && _area > 20000) {
        const _contained = allItems.filter(i =>
          i.x >= textItem.x && i.x + i.width <= textItem.x + _w &&
          i.y >= textItem.y && i.y + i.height <= textItem.y + _h && i !== textItem
        );
        if (_contained.length >= 2) {
          return { type: 'card', confidence: 0.5 };
        }
      }

      // List item: medium width, in a vertical sequence
      if (_w > 100 && _h > 30 && _h < 100) {
        const _verticalSequence = allItems.filter(i =>
          Math.abs(i.x - textItem.x) < 100 &&
          Math.abs(i.y - textItem.y) > 50 && Math.abs(i.y - textItem.y) < 200
        );
        if (_verticalSequence.length >= 2) {
          return { type: 'list_item', confidence: 0.5 };
        }
      }

      // Heading: larger text, short
      if (_textLen < 80 && _h > 25 && _h < 60 && _w > 100) {
        if (textItem.fontSize && textItem.fontSize > 16) {
          return { type: 'heading', confidence: 0.7 };
        }
      }

      // Link: short text, small width
      if (_textLen < 60 && _w < 400 && _h < 30) {
        return { type: 'link', confidence: 0.4 };
      }

      return { type: 'text', confidence: 0.3 };
    },

    // Infer modal/container from a group of items
    inferContainer: (items, viewport) => {
      if (items.length < 2) return null;
      const _minX = Math.min(...items.map(i => i.x));
      const _minY = Math.min(...items.map(i => i.y));
      const _maxX = Math.max(...items.map(i => i.x + i.width));
      const _maxY = Math.max(...items.map(i => i.y + i.height));
      const _width = _maxX - _minX;
      const _height = _maxY - _minY;

      // Modal: centered, smaller than viewport, has padding from edges
      const _centered = _minX > viewport.width * 0.1 && _minY > viewport.height * 0.1;
      const _smallerThanViewport = _width < viewport.width * 0.9 && _height < viewport.height * 0.9;
      const _hasPadding = _minX > 50 && _minY > 50;

      if (_centered && _smallerThanViewport && _hasPadding && items.length >= 3) {
        return { type: 'modal', x: _minX, y: _minY, width: _width, height: _height, confidence: 0.7 };
      }

      // Sidebar: left side, tall, narrow
      if (_minX < viewport.width * 0.25 && _height > viewport.height * 0.5 && _width < viewport.width * 0.3) {
        return { type: 'sidebar', x: _minX, y: _minY, width: _width, height: _height, confidence: 0.7 };
      }

      // Header/toolbar: top, wide, short
      if (_minY < viewport.height * 0.15 && _width > viewport.width * 0.5 && _height < viewport.height * 0.2) {
        return { type: 'header', x: _minX, y: _minY, width: _width, height: _height, confidence: 0.7 };
      }

      return null;
    }
  },

  // Social media feed (LinkedIn, Twitter, Facebook, Reddit)
  social_feed: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /like|comment|share|react|vote/i.test(textItem.text)) {
        return { type: 'engagement_button', confidence: 0.8 };
      }
      return _generic;
    }
  },

  // Email compose (Gmail, Outlook, ProtonMail)
  email_compose: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /send|reply|forward|attach|discard/i.test(textItem.text)) {
        return { type: 'email_action_button', confidence: 0.85 };
      }
      if (_generic.type === 'input' && /^(to|cc|bcc|subject|from)/i.test(textItem.text)) {
        return { type: 'email_field', confidence: 0.8 };
      }
      return _generic;
    }
  },

  // Document editor (Google Docs, Notion, Word Online)
  document_editor: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /save|create|share|export|download|print/i.test(textItem.text)) {
        return { type: 'doc_action_button', confidence: 0.85 };
      }
      if (textItem.width > 400 && textItem.height > 200) {
        return { type: 'editor_body', confidence: 0.7 };
      }
      return _generic;
    }
  },

  // Calendar (Google Calendar, Outlook Calendar)
  calendar: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /save|create|add|delete|yes|no|maybe/i.test(textItem.text)) {
        return { type: 'calendar_action_button', confidence: 0.85 };
      }
      if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(textItem.text)) {
        return { type: 'time_slot', confidence: 0.8 };
      }
      return _generic;
    }
  },

  // Shopping (Amazon, eBay, Etsy)
  shopping: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /add to cart|buy now|checkout|purchase|place order/i.test(textItem.text)) {
        return { type: 'shopping_action_button', confidence: 0.9 };
      }
      if (/^\$?\d+\.?\d*$/.test(textItem.text)) {
        return { type: 'price', confidence: 0.7 };
      }
      return _generic;
    }
  },

  // AI chat (ChatGPT, Claude, Perplexity)
  ai_chat: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (textItem.y > viewport.height * 0.7 && textItem.width > 300) {
        return { type: 'chat_input', confidence: 0.8 };
      }
      return _generic;
    }
  },

  // Music/media player (Spotify, YouTube, Apple Music)
  media_player: {
    inferElementType: (textItem, allItems, viewport) => {
      const _generic = BROWSER_CATEGORY_SCHEMAS.web_generic.inferElementType(textItem, allItems, viewport);
      if (_generic.type === 'button' && /play|pause|next|previous|shuffle|repeat/i.test(textItem.text)) {
        return { type: 'media_control', confidence: 0.85 };
      }
      return _generic;
    }
  },
};

// ---------------------------------------------------------------------------
// Infer page category from service key, URL, task text, and appKnowledge entries.
// Used to pass proactive hints to instruction.runner so it knows upfront what
// nuances are needed (chip confirmation, submit verification, pressAfter, etc.)
// Priority: KNOWN_BROWSER_SERVICES → appKnowledge entries → URL patterns → task text
// ---------------------------------------------------------------------------
function _inferPageCategory(serviceKey, url, task, appKnowledgeEntries = []) {
  const _svc = (serviceKey || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const _url = (url || '').toLowerCase();
  const _task = (task || '').toLowerCase();

  // 1. Direct service → category mapping (KNOWN_BROWSER_SERVICES)
  const _SERVICE_CATEGORIES = {
    gmail: 'email_compose', outlook: 'email_compose', protonmail: 'email_compose',
    yahoo: 'email_compose', mailgooglecom: 'email_compose',
    chatgpt: 'ai_chat', openai: 'ai_chat', claude: 'ai_chat', anthropic: 'ai_chat',
    gemini: 'ai_chat', googleai: 'ai_chat', grok: 'ai_chat', perplexity: 'ai_chat',
    notion: 'document_editor', googledocs: 'document_editor', googlesheets: 'document_editor',
    twitter: 'social_feed', x: 'social_feed', facebook: 'social_feed',
    linkedin: 'social_feed', reddit: 'social_feed',
    amazon: 'shopping', ebay: 'shopping', etsy: 'shopping',
    spotify: 'media_player', youtube: 'media_player', applemusic: 'media_player',
    googlecalendar: 'calendar', outlookcalendar: 'calendar',
  };
  if (_SERVICE_CATEGORIES[_svc]) return _SERVICE_CATEGORIES[_svc];

  // 2. appKnowledge entries → category inference
  //    Look for signals in entry type + summary that indicate page category
  if (appKnowledgeEntries && appKnowledgeEntries.length > 0) {
    const _summaries = appKnowledgeEntries.map(e => `${e.type} ${e.summary || ''}`.toLowerCase()).join(' ');
    const _hasShortcut = appKnowledgeEntries.some(e => e.type === 'shortcut');
    const _hasWorkflow = appKnowledgeEntries.some(e => e.type === 'workflow');
    const _hasCommandSystem = appKnowledgeEntries.some(e => e.type === 'command_system');

    // AI chat: shortcut says "Enter" + "message" + "send"
    if (_hasShortcut && /enter.*message.*send|send.*message.*enter/i.test(_summaries)) return 'ai_chat';
    // Email compose: workflow/quirk mentions "compose", "recipient", "To field"
    if ((_hasWorkflow || _summaries.includes('quirk')) && /compose|recipient|to field|cc|bcc|email.*send/i.test(_summaries)) return 'email_compose';
    // Document editor: command_system with "/" prefix, or shortcut with "Cmd+N" (new page)
    if (_hasCommandSystem && /slash|\/.*prefix|block insertion/i.test(_summaries)) return 'document_editor';
    if (_hasShortcut && /cmd\+n|ctrl\+n.*new page/i.test(_summaries)) return 'document_editor';
    // Media player: shortcut with "play", "pause", "next", "previous"
    if (_hasShortcut && /play|pause|next track|previous track/i.test(_summaries)) return 'media_player';
    // Social feed: workflow/quirk mentions "post", "share", "feed"
    if ((_hasWorkflow || _summaries.includes('quirk')) && /\bpost\b|share.*feed|news feed/i.test(_summaries)) return 'social_feed';
  }

  // 3. URL-based inference
  if (/mail\.google\.com|outlook\.live\.com\/mail|proton\.mail/i.test(_url)) return 'email_compose';
  if (/chat\.openai\.com|claude\.ai|gemini\.google\.com|grok\.com|perplexity\.ai/i.test(_url)) return 'ai_chat';
  if (/notion\.so|notion\.com|docs\.google\.com/i.test(_url)) return 'document_editor';
  if (/twitter\.com|x\.com\/compose|facebook\.com\/sharer|linkedin\.com\/feed/i.test(_url)) return 'social_feed';

  // 4. Task-based inference (weakest signal)
  if (/\b(send|compose|email|reply|forward)\b.*\b(to|recipient|subject|body)\b/i.test(_task)) return 'email_compose';
  if (/\b(ask|chat|message|prompt)\b.*\b(chatgpt|claude|gemini|grok|perplexity|ai)\b/i.test(_task)) return 'ai_chat';
  if (/\b(post|tweet|share|update status)\b/i.test(_task)) return 'social_feed';

  return 'web_generic';
}

// ---------------------------------------------------------------------------
// LiteParse capture + verify + submit (Playwright screenshot → LiteParse → coordinates)
// ---------------------------------------------------------------------------

// Capture Playwright screenshot + run LiteParse → text items with bounding boxes
async function _liteparseCapture(page, options = {}) {
  if (!LIT_AVAILABLE) {
    const _ok = await ensureLitAvailable();
    if (!_ok) return { ok: false, error: 'LiteParse CLI not available' };
  }

  const _screenshotPath = path.join(os.tmpdir(), `playwright_${Date.now()}.png`);
  try {
    // Support optional clipping region (for Tier 1.8 visual discovery — examining
    // just an opened menu instead of the full page). `clip` follows Playwright's
    // screenshot clip shape: { x, y, width, height } in CSS pixels.
    const _shotOpts = { path: _screenshotPath, fullPage: false };
    if (options && options.clip && typeof options.clip === 'object') {
      _shotOpts.clip = options.clip;
    }
    await page.screenshot(_shotOpts);
  } catch (e) {
    return { ok: false, error: `screenshot failed: ${e.message}` };
  }

  const _outputPath = path.join(os.tmpdir(), `liteparse_${Date.now()}.json`);
  const { spawn } = require('child_process');

  return new Promise((resolve) => {
    const lit = spawn(LIT_BIN, ['parse', _screenshotPath, '--format', 'json', '-o', _outputPath], { timeout: 30000 });
    let stderr = '';
    lit.stderr.on('data', (d) => { stderr += d.toString(); });

    lit.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(_screenshotPath); } catch (_) {}
        resolve({ ok: false, error: `LiteParse exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        if (!fs.existsSync(_outputPath)) {
          resolve({ ok: false, error: 'LiteParse output file not created' });
          return;
        }
        const output = JSON.parse(fs.readFileSync(_outputPath, 'utf8'));

        // Extract text items with bounding boxes (handle both LiteParse and Docling formats)
        const textItems = [];
        const _rawItems = output.pages?.[0]?.textItems || output.texts || [];
        for (const item of _rawItems) {
          if (!item.text) continue;
          // LiteParse format: { text, x, y, width, height }
          if (item.x !== undefined && item.y !== undefined) {
            textItems.push({
              text: item.text,
              x: item.x || 0,
              y: item.y || 0,
              width: item.width || 0,
              height: item.height || 0,
              confidence: item.confidence || 1.0
            });
          }
          // Docling format: { text, prov: [{ bbox: { l, t, r, b } }] }
          else if (item.prov && item.prov[0] && item.prov[0].bbox) {
            const bbox = item.prov[0].bbox;
            textItems.push({
              text: item.text,
              x: bbox.l,
              y: bbox.t,
              width: bbox.r - bbox.l,
              height: bbox.b - bbox.t,
              confidence: 1.0
            });
          }
        }

        // Get screenshot dimensions for coordinate calibration
        let imageWidth = 1280, imageHeight = 800;
        try {
          const { PNG } = require('pngjs');
          const png = PNG.sync.read(fs.readFileSync(_screenshotPath));
          imageWidth = png.width;
          imageHeight = png.height;
        } catch (_) {}

        // Clean up temp files
        try { fs.unlinkSync(_screenshotPath); fs.unlinkSync(_outputPath); } catch (_) {}

        const fullText = textItems.map(i => i.text).join(' ');
        logger.info(`[browser.agent] LiteParse capture: ${textItems.length} text items, ${imageWidth}x${imageHeight}, ${fullText.length} chars`);
        resolve({ ok: true, textItems, imageWidth, imageHeight, fullText });
      } catch (e) {
        try { fs.unlinkSync(_screenshotPath); fs.unlinkSync(_outputPath); } catch (_) {}
        resolve({ ok: false, error: `parse failed: ${e.message}` });
      }
    });

    lit.on('error', () => {
      try { fs.unlinkSync(_screenshotPath); } catch (_) {}
      resolve({ ok: false, error: 'LiteParse spawn failed' });
    });
  });
}

// Verify typed text appears in LiteParse output
async function _liteparseVerify(page, expectText) {
  const _cap = await _liteparseCapture(page);
  if (!_cap.ok) return { verified: false, error: _cap.error };

  const _fullText = (_cap.fullText || '').toLowerCase();
  const _expectSnippet = expectText.slice(0, 30).toLowerCase();

  // Exact snippet match
  if (_fullText.includes(_expectSnippet)) {
    logger.info(`[browser.agent] LiteParse verify: exact match — verified`);
    return { verified: true, source: 'exact', textItems: _cap.textItems, imageWidth: _cap.imageWidth, imageHeight: _cap.imageHeight };
  }

  // Fuzzy word matching (>40% of significant words)
  const _words = expectText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  if (_words.length > 0) {
    const _matched = _words.filter(w => _fullText.includes(w));
    const _ratio = _matched.length / _words.length;
    if (_ratio > 0.4) {
      logger.info(`[browser.agent] LiteParse verify: fuzzy match ${_matched.length}/${_words.length} (${Math.round(_ratio * 100)}%) — verified`);
      return { verified: true, source: 'fuzzy', textItems: _cap.textItems, imageWidth: _cap.imageWidth, imageHeight: _cap.imageHeight };
    }
  }

  // Note: Modal presence is now detected via DOM (in _ocrVerify), not OCR text patterns.
  // LiteParse verify relies on text matching only — site-agnostic.

  logger.info(`[browser.agent] LiteParse verify: not verified (textLen=${_fullText.length})`);
  return { verified: false, source: 'none', textItems: _cap.textItems, imageWidth: _cap.imageWidth, imageHeight: _cap.imageHeight };
}

// DOM-first submit button finder. Collects visible button-like elements, scopes to the
// modal if one is open, classifies each via classifyAction, and ranks by exact match >
// bottom-right-most (submit buttons sit at the modal footer) > shorter text.
// Returns { ok, x, y, text, rect, method } or { ok: false, reason }.
// `frameOrPage` may be a Page or a Frame — both expose .evaluate with the same signature.
async function _domFindSubmitTarget(frameOrPage, goal) {
  const _goalLower = (goal || '').toLowerCase();
  try {
    const _result = await frameOrPage.evaluate((goalLower) => {
      const _modalSel = '[role="dialog"], [aria-modal="true"], [role="alertdialog"], .artdeco-modal, [data-testid*="modal"], [data-testid*="share"], .share-creation, #interop-outlet';
      const modals = Array.from(document.querySelectorAll(_modalSel)).filter(m => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && m.getAttribute('aria-hidden') !== 'true';
      });
      const modal = modals[0];
      const modalRect = modal ? modal.getBoundingClientRect() : null;

      // Collect button-like elements
      const _btnSel = 'button, [role="button"], a[role="button"], input[type="submit"]';
      let candidates = Array.from(document.querySelectorAll(_btnSel));
      // Scope to modal if present
      if (modal) {
        candidates = candidates.filter(b => {
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          if (b.getAttribute('aria-hidden') === 'true') return false;
          const cs = getComputedStyle(b);
          if (cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.1) return false;
          // Inside modal rect?
          return r.x >= modalRect.x - 2 && r.y >= modalRect.y - 2 &&
                 (r.x + r.width) <= (modalRect.x + modalRect.width + 2) &&
                 (r.y + r.height) <= (modalRect.y + modalRect.height + 2);
        });
      } else {
        candidates = candidates.filter(b => {
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          if (b.getAttribute('aria-hidden') === 'true') return false;
          const cs = getComputedStyle(b);
          if (cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') < 0.1) return false;
          return true;
        });
      }

      // Classify each candidate. We can't call classifyAction (it's in Node), so we
      // replicate the keyword matching inline. The caller will re-validate via
      // classifyAction on the chosen text.
      const _submitKw = ['post', 'share', 'tweet', 'publish', 'send', 'submit', 'create', 'save', 'add to cart', 'add', 'reply', 'comment'];
      const _startKw = ['start a post', 'start', 'new', 'compose', 'write', 'log in', 'sign in', 'cancel', 'close', 'discard', 'go back'];
      const scored = [];
      for (const b of candidates) {
        const text = ((b.innerText || b.textContent || b.value || '').trim() || (b.getAttribute('aria-label') || '').trim()).toLowerCase();
        if (!text || text.length > 30) continue;
        if (b.disabled) continue;
        // Exclude start/navigation actions
        if (_startKw.some(kw => text === kw || text.startsWith(kw))) continue;
        // Match submit keywords
        let isExact = false, keyword = null;
        for (const kw of _submitKw) {
          if (text === kw) { isExact = true; keyword = kw; break; }
          if (text.includes(kw) || text.startsWith(kw)) { keyword = kw; }
        }
        if (!keyword) continue;
        const r = b.getBoundingClientRect();
        scored.push({ text, keyword, isExact, x: r.x + r.width / 2, y: r.y + r.height / 2, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, inModal: !!modal });
      }
      if (scored.length === 0) return { ok: false, reason: 'no-submit-candidate', inModal: !!modal };
      // Rank: exact first, then bottom-right-most (highest y, then highest x), then shorter text
      scored.sort((a, b) => {
        if (a.isExact !== b.isExact) return b.isExact - a.isExact;
        if (Math.abs(a.y - b.y) > 20) return b.y - a.y; // lower (higher y) first
        if (Math.abs(a.x - b.x) > 20) return b.x - a.x; // righter first
        return a.text.length - b.text.length;
      });
      const best = scored[0];
      return { ok: true, x: best.x, y: best.y, text: best.text, keyword: best.keyword, isExact: best.isExact, rect: best.rect, inModal: best.inModal, method: 'dom-find', candidateCount: scored.length };
    }, _goalLower);
    if (_result?.ok) {
      logger.info(`[browser.agent] DOM find submit: found "${_result.text}" at (${Math.round(_result.x)}, ${Math.round(_result.y)}) keyword="${_result.keyword}" exact=${_result.isExact} inModal=${_result.inModal} candidates=${_result.candidateCount}`);
    } else {
      logger.info(`[browser.agent] DOM find submit: ${_result?.reason || 'no match'} inModal=${_result?.inModal}`);
    }
    return _result || { ok: false, reason: 'evaluate-failed' };
  } catch (e) {
    logger.warn(`[browser.agent] DOM find submit error: ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// Validate that a click point actually hits a button-like element matching expectedText.
// Uses document.elementFromPoint, walks up to nearest button/[role=button], checks text.
// Rejects if nothing button-like is found, text doesn't match, or element is outside modal.
// `frameOrPage` may be a Page or a Frame — coordinates must be in that frame's space.
async function _validateClickPoint(frameOrPage, x, y, expectedText) {
  const _expectedLower = (expectedText || '').toLowerCase();
  try {
    const _valid = await frameOrPage.evaluate(({ px, py, expectedLower }) => {
      const el = document.elementFromPoint(px, py);
      if (!el) return { ok: false, reason: 'no-element-at-point' };
      // Walk up to nearest button-like element
      let node = el;
      for (let i = 0; i < 5 && node; i++) {
        if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button' ||
            (node.tagName === 'A' && node.getAttribute('role') === 'button') ||
            (node.tagName === 'INPUT' && node.type === 'submit')) break;
        node = node.parentElement;
      }
      if (!node || (node.tagName !== 'BUTTON' && node.getAttribute('role') !== 'button' &&
          !(node.tagName === 'A' && node.getAttribute('role') === 'button') &&
          !(node.tagName === 'INPUT' && node.type === 'submit'))) {
        return { ok: false, reason: 'no-button-at-point', actualTag: el.tagName };
      }
      const text = ((node.innerText || node.textContent || node.value || '').trim() || (node.getAttribute('aria-label') || '').trim()).toLowerCase();
      if (expectedLower && text !== expectedLower && !text.includes(expectedLower) && !expectedLower.includes(text)) {
        return { ok: false, reason: 'text-mismatch', actualText: text, expectedText: expectedLower };
      }
      // Check modal containment
      const _modalSel = '[role="dialog"], [aria-modal="true"], [role="alertdialog"], .artdeco-modal, [data-testid*="modal"], [data-testid*="share"], .share-creation, #interop-outlet';
      const modal = document.querySelector(_modalSel);
      if (modal) {
        const mR = modal.getBoundingClientRect();
        const nR = node.getBoundingClientRect();
        const inside = nR.x >= mR.x - 2 && nR.y >= mR.y - 2 &&
                       (nR.x + nR.width) <= (mR.x + mR.width + 2) &&
                       (nR.y + nR.height) <= (mR.y + mR.height + 2);
        if (!inside) return { ok: false, reason: 'outside-modal', actualText: text };
      }
      if (node.disabled) return { ok: false, reason: 'disabled', actualText: text };
      return { ok: true, text, tag: node.tagName };
    }, { px: x, py: y, expectedLower: _expectedLower });
    if (_valid?.ok) {
      logger.info(`[browser.agent] validate click point (${Math.round(x)}, ${Math.round(y)}): OK text="${_valid.text}" tag=${_valid.tag}`);
    } else {
      logger.warn(`[browser.agent] validate click point (${Math.round(x)}, ${Math.round(y)}): REJECTED reason=${_valid?.reason} actual="${_valid?.actualText || 'n/a'}" expected="${_expectedLower}"`);
    }
    return _valid || { ok: false, reason: 'evaluate-failed' };
  } catch (e) {
    logger.warn(`[browser.agent] validate click point error: ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// Find submit button in LiteParse text items + click at its coordinates
async function _liteparseSubmit(page, goal, textItems, imageWidth, imageHeight) {
  const _goalLower = (goal || '').toLowerCase();

  // Scale factor: LiteParse coordinates are in screenshot pixels.
  // Playwright screenshot defaults to viewport size.
  // page.mouse.click uses viewport coordinates.
  const _viewportWidth = page.viewportSize()?.width || 1280;
  const _viewportHeight = page.viewportSize()?.height || 800;
  const _scaleX = _viewportWidth / imageWidth;
  const _scaleY = _viewportHeight / imageHeight;

  // Find text items that classify as submit actions (NOT start/navigation)
  const _matches = [];
  for (const item of textItems) {
    const _text = (item.text || '').trim().toLowerCase();
    if (!_text || _text.length > 30) continue; // submit buttons are short
    const _action = classifyAction(_text, _goalLower);
    if (_action.type === 'submit') {
      const _isExact = _text === _action.keyword;
      _matches.push({
        ...item,
        keyword: _action.keyword,
        confidence: _action.confidence,
        isExact: _isExact,
        actionType: 'submit'
      });
    }
  }

  if (_matches.length === 0) {
    logger.info(`[browser.agent] LiteParse submit: no submit-action text items found`);
    return { ok: false, reason: 'no-submit-action-found' };
  }

  // Sort by: exact match first, then shorter text wins (submit buttons are short)
  _matches.sort((a, b) => {
    if (a.isExact !== b.isExact) return b.isExact - a.isExact;
    return a.text.length - b.text.length;
  });

  const _best = _matches[0];
  const _clickX = Math.round((_best.x + _best.width / 2) * _scaleX);
  const _clickY = Math.round((_best.y + _best.height / 2) * _scaleY);

  logger.info(`[browser.agent] LiteParse submit: clicking "${_best.text}" at (${_clickX}, ${_clickY}) — actionType=submit keyword="${_best.keyword}" exact=${_best.isExact} (scaled from ${_best.x + _best.width / 2},${_best.y + _best.height / 2} scaleX=${_scaleX} scaleY=${_scaleY})`);

  try {
    await page.mouse.click(_clickX, _clickY);
    return { ok: true, text: _best.text, x: _clickX, y: _clickY, keyword: _best.keyword };
  } catch (e) {
    return { ok: false, error: `click failed: ${e.message}` };
  }
}

module.exports = { browserAgent, KNOWN_BROWSER_SERVICES, actionDeleteAgent, _generateAgentThinking, clearAuthCaches: (agentId) => {
  _authCheckCache.delete((agentId || '').toLowerCase());
} };
module.exports._deriveAgentType = deriveAgentType;
module.exports.resolveCredential = resolveCredential;
module.exports._profileGetValue = _profileGetValue;
module.exports._isSigninWall = _isSigninWall;
module.exports._canPromoteDeepLink = _canPromoteDeepLink;
module.exports._isMutationIntent = _isMutationIntent;
module.exports._isUnsafeDeepLinkUrl = _isUnsafeDeepLinkUrl;
module.exports._resolvePlaybook = _resolvePlaybook;
// LiteParse-based verify + submit
module.exports.ensureLitAvailable = ensureLitAvailable;
module.exports.classifyAction = classifyAction;
module.exports.BROWSER_CATEGORY_SCHEMAS = BROWSER_CATEGORY_SCHEMAS;
module.exports.ACTION_TYPES = ACTION_TYPES;
module.exports._liteparseCapture = _liteparseCapture;
module.exports._liteparseVerify = _liteparseVerify;
module.exports._liteparseSubmit = _liteparseSubmit;
module.exports._domFindSubmitTarget = _domFindSubmitTarget;
module.exports._validateClickPoint = _validateClickPoint;
module.exports._llmNextAction = _llmNextAction;
module.exports._extractSteps = _extractSteps;
module.exports._decisionCall = _decisionCall;
module.exports._buildFocusedStr = _buildFocusedStr;
module.exports._extractValue = _extractValue;
module.exports._extractAfterAction = _extractAfterAction;
module.exports._extractGestureType = _extractGestureType;
module.exports._extractGestureTargets = _extractGestureTargets;
module.exports._ocrVerifyGoal = _ocrVerifyGoal;
module.exports._ocrDetectLoading = _ocrDetectLoading;
module.exports._ocrPickRow = _ocrPickRow;
module.exports._ocrClassifyState = _ocrClassifyState;
module.exports._scanCanvasLayout = _scanCanvasLayout;
module.exports._readEditorState = _readEditorState;
module.exports._formatEditorStateForLLM = _formatEditorStateForLLM;
module.exports._extractFieldType = _extractFieldType;
module.exports._extractCommandPlan = _extractCommandPlan;
module.exports._extractSearchPlan = _extractSearchPlan;
module.exports._extractEditMode = _extractEditMode;
module.exports._extractSearchText = _extractSearchText;
module.exports._extractShortcut = _extractShortcut;
