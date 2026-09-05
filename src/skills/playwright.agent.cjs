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
const { _liteparseVerify, _liteparseSubmit, _liteparseCapture, _domFindSubmitTarget, _validateClickPoint, ensureLitAvailable } = require('./browser.agent.cjs');
// Lazy-require keyboard nav helpers from instruction.runner.cjs to avoid circular dep
const _getKbHelpers = () => {
  try { return require('./instruction.runner.cjs'); } catch { return {}; }
};

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
// URL equality check — preserves hash fragments (critical for SPA hash-routers
// like Gmail where #inbox?compose=new is a different page state than #inbox).
// Stripping all query strings via split('?')[0] would incorrectly treat these
// as identical, skipping navigation to the compose view.
// Compares origin + pathname + hash, ignoring only top-level search params
// (tracking tokens, session params) that don't affect page state.
// ---------------------------------------------------------------------------
function _urlsEqual(urlA, urlB) {
  if (!urlA || !urlB) return false;
  try {
    const _a = new URL(urlA);
    const _b = new URL(urlB);
    const _normPath = (u) => u.pathname.replace(/\/+$/, '') || '/';
    return _a.origin === _b.origin
      && _normPath(_a) === _normPath(_b)
      && _a.hash === _b.hash;
  } catch (_) {
    if (!urlA || !urlB) return false;
    return urlA.replace(/\/+$/, '') === urlB.replace(/\/+$/, '');
  }
}

// ---------------------------------------------------------------------------
// Engine fast-path helpers — use Playwright Node API directly when engine is
// active, bypassing browserAct → cliRun subprocess overhead.
// Falls back to browserAct (which has its own CLI fallback) on any error.
// ---------------------------------------------------------------------------

async function _engineEval(sessionId, expr, timeoutMs = 5000) {
  const page = engine.getPage(sessionId);
  if (page) {
    try {
      const result = await page.evaluate(expr);
      return { ok: true, result, stdout: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (e) {
      logger.debug(`[playwright.agent] _engineEval failed (engine): ${e.message}`);
    }
  }
  // Fallback: session not engine-owned (e.g. turn-loop sessions created via browserAct).
  // browserAct can interact with ANY session — send the eval expression to the browser.act layer.
  try {
    const _baRes = await browserAct({ action: 'evaluate', text: expr, sessionId, headed: true, timeoutMs });
    if (_baRes?.ok) {
      const _raw = _baRes.result ?? _baRes.stdout;
      const _result = typeof _raw === 'string' ? _raw.replace(/^"|"$/g, '') : _raw;
      return { ok: true, result: _result, stdout: typeof _raw === 'string' ? _raw : JSON.stringify(_raw) };
    }
  } catch (e) {
    logger.debug(`[playwright.agent] _engineEval fallback (browserAct) failed: ${e.message}`);
  }
  return null;
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
// _detectOpenMenus — detect open menus/dialogs and capture their contents.
// Uses standard ARIA roles (role='menu', role='dialog', role='listbox') plus
// class-name heuristics (menu, dropdown, popover) for non-ARIA sites.
// Returns an array of { selector, role, label, class, items: [{tag, text, role}] }
// General — works for any website with menus/dialogs.
// ---------------------------------------------------------------------------
async function _detectOpenMenus(sessionId, headed, timeoutMs = 5000) {
  try {
    const _page = engine?.getPage?.(sessionId);
    if (!_page) return [];
    const _menus = await _page.evaluate(() => {
      function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (parseFloat(s.opacity) === 0) return false;
        // Must be in viewport (at least partially)
        if (r.bottom < 0 || r.top > window.innerHeight) return false;
        if (r.right < 0 || r.left > window.innerWidth) return false;
        // Must be interactive (not behind pointer-events: none)
        if (s.pointerEvents === 'none') return false;
        return true;
      }
      // Check if element is actually visible to the user (not just in DOM).
      // Uses elementFromPoint to verify the element is on top at its center.
      function isOnTop(el) {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
        const top = document.elementFromPoint(cx, cy);
        if (!top) return false;
        // The element itself or a descendant should be on top
        return top === el || el.contains(top);
      }
      // Compliance / non-interactive dialog exclusion patterns.
      // These are dialogs that exist in the DOM but are NOT interactive menus —
      // they're cookie consent, language selectors, advertising opt-out, privacy
      // notices, etc. They should never trigger the menu guard.
      const _compliancePatterns = [
        'cookie', 'consent', 'advertis', 'privacy', 'gdpr', 'language',
        'location', 'region', 'country', 'opt-out', 'opt out', 'tailored',
        'your privacy choices', 'do not sell', 'ccpa',
      ];
      function isComplianceDialog(el) {
        const _label = (el.getAttribute('aria-label') || '').toLowerCase();
        const _cls = (el.className || '').toLowerCase();
        const _text = ((el.innerText || el.textContent || '').slice(0, 200) || '').toLowerCase();
        for (const p of _compliancePatterns) {
          if (_label.includes(p)) return true;
          if (_cls.includes(p)) return true;
          if (_text.includes(p) && _text.length < 300) return true;
        }
        return false;
      }
      const menus = [];
      // Standard ARIA containers + class-name fallbacks for non-ARIA sites.
      // NOTE: [role="dialog"] and [aria-modal="true"] are included but will be
      // filtered by isComplianceDialog and the clickable-items requirement.
      const _selector = '[role="menu"], [role="listbox"], [aria-modal="true"], ' +
        '[class*="dropdown" i]:not([class*="menubar" i]), [class*="popover" i], ' +
        '[class*="context-menu" i], [class*="popup" i]:not([class*="popup-" i])';
      // Also include [role="dialog"] but only if it has clickable menu items
      // (not just text content like cookie consent)
      const _seen = new Set();
      const _candidates = Array.from(document.querySelectorAll(_selector));
      // Add role="dialog" separately for special handling
      _candidates.push(...Array.from(document.querySelectorAll('[role="dialog"]')));
      for (const c of _candidates) {
        if (_seen.has(c)) continue;
        _seen.add(c);
        if (!isVisible(c)) continue;
        // Skip compliance/cookie/privacy dialogs
        if (isComplianceDialog(c)) continue;
        // Capture ONLY actual clickable menu items — buttons, links, menuitem
        // roles, options. NOT generic div/span (which match cookie consent text).
        const _itemEls = Array.from(c.querySelectorAll(
          'button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
          '[role="option"], [role="button"], input[type="submit"], input[type="button"]'
        ));
        const items = [];
        for (const el of _itemEls) {
          if (!isVisible(el)) continue;
          const _t = (el.innerText || el.textContent || '').trim();
          if (!_t || _t.length < 1) continue;
          // Skip generic buttons with no text (icon-only)
          if (_t.length > 60) continue;
          // Skip duplicates
          if (items.some(i => i.text === _t.slice(0, 60))) continue;
          items.push({
            tag: el.tagName,
            text: _t.slice(0, 60),
            role: el.getAttribute('role') || '',
          });
          if (items.length >= 20) break; // cap
        }
        // CRITICAL: Only treat as a menu if it has at least 2 clickable items.
        // A dialog with 0-1 clickable items is likely a compliance popup or
        // a text-only overlay, not an interactive menu. This prevents false
        // positives from cookie consent / language selectors / advertising opt-out.
        if (items.length < 2) continue;
        // For [role="dialog"], require that it's actually on top (not a hidden
        // background dialog). This catches Spotify's compliance dialogs that
        // are in the DOM but not visually on top.
        if (c.getAttribute('role') === 'dialog' && !isOnTop(c)) continue;
        // Build a selector for this container
        let _sel = '';
        if (c.id) _sel = `#${c.id}`;
        else if (c.getAttribute('role')) _sel = `[role="${c.getAttribute('role')}"]`;
        else if (c.getAttribute('aria-label')) _sel = `[aria-label="${c.getAttribute('aria-label')}"]`;
        else _sel = `[class*="${(c.className || '').split(' ')[0] || 'menu'}"]`;
        // Capture bounding rect for Tier 1.6 OCR clipping
        const _r = c.getBoundingClientRect();
        menus.push({
          selector: _sel,
          role: c.getAttribute('role') || '',
          label: c.getAttribute('aria-label') || '',
          class: (c.className || '').slice(0, 80),
          itemcount: items.length,
          items: items.slice(0, 15),
          boundingRect: {
            x: Math.round(_r.x),
            y: Math.round(_r.y),
            width: Math.round(_r.width),
            height: Math.round(_r.height),
          },
        });
      }
      // Sort: menus with more items first (likely the active menu)
      menus.sort((a, b) => b.itemcount - a.itemcount);
      return menus;
    }).catch(() => []);
    return _menus || [];
  } catch (e) {
    logger.debug(`[playwright.agent] _detectOpenMenus error (non-fatal): ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// _captureState — capture the current page state for the state-diff loop.
//   captureMode='full'  → DOM snapshot + LiteParser OCR + URL + openMenus + modalCount
//                         (used at sub-task boundaries: start + end)
//   captureMode='cheap' → DOM hash + page text + URL + modalCount
//                         (used between actions to detect no-ops — no LiteParser)
// Returns { url, domHash, pageText, ocrText?, openMenus?, modalCount, timestamp }
// ---------------------------------------------------------------------------
async function _captureState(sessionId, headed, captureMode = 'cheap') {
  const _ts = Date.now();
  let _url = '';
  let _domHash = '';
  let _pageText = '';
  let _ocrText = '';
  let _openMenus = [];
  let _modalCount = 0;

  try {
    const _page = engine?.getPage?.(sessionId);
    if (!_page) return { url: '', domHash: '', pageText: '', modalCount: 0, timestamp: _ts, ok: false };

    // URL
    try { _url = _page.url(); } catch (_) {}

    // Page text (always capture — cheap)
    try {
      _pageText = await _page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
    } catch (_) {}

    // DOM hash: hash of interactive elements' signatures (tag + role + text + rect)
    // This is cheaper than a full ARIA snapshot and stable across non-meaningful changes
    try {
      _domHash = await _page.evaluate(() => {
        const els = document.querySelectorAll('button, a, [role="button"], [role="link"], input, [contenteditable], [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]');
        const sigs = [];
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden') continue;
          const t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40);
          sigs.push(`${el.tagName}|${el.getAttribute('role') || ''}|${t}|${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`);
        }
        // Simple hash: join + length-based hash (fast, no crypto needed)
        const joined = sigs.join('§');
        let h = 0;
        for (let i = 0; i < joined.length; i++) {
          h = ((h << 5) - h + joined.charCodeAt(i)) | 0;
        }
        return `${h}_${sigs.length}`;
      }).catch(() => '');
    } catch (_) {}

    // Modal count (always capture — cheap)
    try {
      _modalCount = await _page.evaluate(() => {
        let count = 0;
        for (const m of document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) {
          const r = m.getBoundingClientRect();
          if (r.width > 2 && r.height > 2) {
            const s = window.getComputedStyle(m);
            if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0) count++;
          }
        }
        return count;
      }).catch(() => 0);
    } catch (_) {}

    // Full capture: LiteParser OCR + openMenus
    if (captureMode === 'full') {
      try {
        const _cap = await _ocrCaptureViaPage(_page);
        if (_cap.ok) _ocrText = (_cap.text || '').slice(0, 2000);
      } catch (_) {}
      try {
        _openMenus = await _detectOpenMenus(sessionId, headed, 5000);
      } catch (_) {}
    }
  } catch (e) {
    logger.debug(`[playwright.agent] _captureState error (non-fatal): ${e.message}`);
  }

  return { url: _url, domHash: _domHash, pageText: _pageText, ocrText: _ocrText, openMenus: _openMenus, modalCount: _modalCount, timestamp: _ts, ok: true };
}

// ---------------------------------------------------------------------------
// _diffStates — compare two captured states to detect if the page changed.
// Returns { changed: bool, changes: string[] }
// Used between actions in the state-diff loop to detect no-ops.
// ---------------------------------------------------------------------------
function _diffStates(before, after) {
  if (!before || !after) return { changed: true, changes: ['state-unavailable'] };
  const changes = [];

  // DOM hash changed → structural change
  if (before.domHash && after.domHash && before.domHash !== after.domHash) {
    changes.push('dom-changed');
  }

  // URL changed → navigation
  if (before.url && after.url && before.url !== after.url) {
    changes.push(`url-changed: ${before.url.slice(0, 60)} → ${after.url.slice(0, 60)}`);
  }

  // Modal count changed → dialog opened/closed
  if (before.modalCount !== after.modalCount) {
    changes.push(`modal-count-changed: ${before.modalCount} → ${after.modalCount}`);
  }

  // Page text changed (compare first 500 chars for cheap diff)
  const _beforeText = (before.pageText || '').slice(0, 500);
  const _afterText = (after.pageText || '').slice(0, 500);
  if (_beforeText !== _afterText) {
    changes.push('page-text-changed');
  }

  return { changed: changes.length > 0, changes };
}

// ---------------------------------------------------------------------------
// Fuzzy text matching helpers — handle OCR misreads (e.g. "Save" → "sve")
// ---------------------------------------------------------------------------

// Levenshtein distance between two short strings (button labels are ≤ 30 chars)
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

// Fuzzy match: exact → substring (with length-ratio guard) → Levenshtein (for short strings only)
// Guards against the bug where a 1-char candidate ("a") substring-matches a
// multi-char target ("search") via t.includes(c). Both strings must be ≥ 3 chars
// for fuzzy matching, and substring matches require the shorter string to be at
// least 60% of the longer string's length.
function _fuzzyMatchText(target, candidate, maxDistance = 2) {
  const t = (target || '').toLowerCase().trim();
  const c = (candidate || '').toLowerCase().trim();
  if (!t || !c) return { match: false, exact: false, distance: -1 };
  if (t === c) return { match: true, exact: true, distance: 0 };
  // Substring match — but only when the strings are close in length (≥ 60% ratio).
  // This prevents "a" matching "search" via t.includes("a").
  const _shorter = Math.min(t.length, c.length);
  const _longer = Math.max(t.length, c.length);
  if (_shorter >= 3 && _shorter / _longer >= 0.6) {
    if (c.includes(t) || t.includes(c)) {
      // Add a small length-difference penalty so closer-length matches win ties.
      const _lenPenalty = Math.round((_longer - _shorter) / 3);
      return { match: true, exact: false, distance: _lenPenalty };
    }
  }
  // Only fuzzy-match short strings (buttons/labels are ≤ 30 chars), and require
  // both strings to be ≥ 3 chars so 1-2 char fragments never fuzzy-match.
  if (t.length >= 3 && t.length <= 30 && c.length >= 3 && c.length <= 30) {
    const d = _levenshtein(t, c);
    if (d <= maxDistance) return { match: true, exact: false, distance: d };
  }
  return { match: false, exact: false, distance: -1 };
}

// Diff OCR text items before vs after an action
function _diffOcrText(beforeItems, afterItems) {
  const _beforeSet = new Set((beforeItems || []).map(i => (i.text || '').toLowerCase().trim()));
  const _afterSet = new Set((afterItems || []).map(i => (i.text || '').toLowerCase().trim()));
  const _added = (afterItems || []).filter(i => !_beforeSet.has((i.text || '').toLowerCase().trim()));
  const _removed = (beforeItems || []).filter(i => !_afterSet.has((i.text || '').toLowerCase().trim()));
  return {
    changed: _added.length > 0 || _removed.length > 0,
    added: _added.map(i => i.text),
    removed: _removed.map(i => i.text),
  };
}

// ---------------------------------------------------------------------------
// _filterOcrForPrompt — filter + classify + structure OCR text items so the
// LLM receives a clean, organized view of what's visible on screen instead of
// a raw dump of 100+ noisy fragments (1-char items, cookie consent text, etc.).
//
// Steps:
//   1. Drop noise: <2 char text, very low confidence, pure punctuation
//   2. Drop items inside cookie/consent/language/advertising dialogs
//   3. Classify each item as button / input / heading / link / text based on
//      dimensions and text characteristics
//   4. Sort: interactive elements (button, input, link) first, then headings,
//      then plain text — so the LLM sees actionable items at the top
//   5. Group by vertical band: top bar, main content, sidebar, bottom
//
// Returns a formatted string ready to inject into the LLM prompt.
// ---------------------------------------------------------------------------
const _NOISE_DIALOG_RE = /cookie|consent|privacy|language|advertising|tailored|opt.?out|gdpr|do not sell/i;
const _PUNCT_ONLY_RE = /^[^\w]+$/;

function _classifyOcrItem(item) {
  const _text = (item.text || '').trim();
  const _w = item.width || 0;
  const _h = item.height || 0;
  const _len = _text.length;
  // Input fields: typically placeholder text, wider than tall, often ends with "?"
  if (_len > 3 && _len < 60 && _w > 150 && _h < 40 && /[?]/.test(_text)) return 'input';
  if (_len > 3 && _len < 50 && _w > 200 && _h < 35 && /^(search|what|enter|add|type|find)/i.test(_text)) return 'input';
  // Buttons: short text, small-to-medium box
  if (_len >= 2 && _len <= 30 && _w < 200 && _h < 50) return 'button';
  // Headings: larger height (bigger font)
  if (_h > 28 && _len > 3 && _len < 80) return 'heading';
  // Links: medium length, often single line
  if (_len >= 3 && _len <= 60 && _h < 30) return 'link';
  return 'text';
}

function _filterOcrForPrompt(items, opts = {}) {
  if (!items || items.length === 0) return { formatted: '', filtered: [], noise: 0 };
  const _imgW = opts.imageWidth || 1280;
  const _imgH = opts.imageHeight || 800;
  const _page = opts.page;
  let _noiseDialogRects = null;

  // Resolve cookie/consent dialog bounding rects from the DOM (cheap, one-time)
  if (_page) {
    try {
      // Synchronous-ish: we accept this may be null if the page is unavailable
      // (the caller can pre-compute and pass via opts.noiseDialogRects instead)
      _noiseDialogRects = opts.noiseDialogRects || null;
    } catch (_) {}
  }

  const _filtered = [];
  let _noiseCount = 0;
  for (const item of items) {
    const _text = (item.text || '').trim();
    // 1. Drop noise: <2 chars, pure punctuation, very low confidence
    if (_text.length < 2) { _noiseCount++; continue; }
    if (_PUNCT_ONLY_RE.test(_text)) { _noiseCount++; continue; }
    if ((item.confidence || 1.0) < 0.5) { _noiseCount++; continue; }
    // 2. Drop items inside known noise dialogs (if rect info available)
    let _inNoiseDialog = false;
    if (_noiseDialogRects && item.x !== undefined) {
      const _cx = item.x + (item.width || 0) / 2;
      const _cy = item.y + (item.height || 0) / 2;
      for (const r of _noiseDialogRects) {
        if (_cx >= r.x && _cx <= r.x + r.w && _cy >= r.y && _cy <= r.y + r.h) {
          _inNoiseDialog = true;
          break;
        }
      }
    }
    if (_inNoiseDialog) { _noiseCount++; continue; }
    _filtered.push(item);
  }

  // 3. Classify
  const _classified = _filtered.map(item => ({
    ...item,
    _type: _classifyOcrItem(item),
  }));

  // 4. Sort: interactive first (button, input, link), then heading, then text
  const _typePriority = { input: 0, button: 1, link: 2, heading: 3, text: 4 };
  _classified.sort((a, b) => {
    const _pa = _typePriority[a._type] !== undefined ? _typePriority[a._type] : 5;
    const _pb = _typePriority[b._type] !== undefined ? _typePriority[b._type] : 5;
    if (_pa !== _pb) return _pa - _pb;
    // Within same type, sort by vertical position (top to bottom)
    return (a.y || 0) - (b.y || 0);
  });

  // 5. Format with type labels and coordinates
  const _lines = _classified.map(i => {
    const _x = Math.round(i.x || 0);
    const _y = Math.round(i.y || 0);
    const _w = Math.round(i.width || 0);
    const _h = Math.round(i.height || 0);
    return `  [${i._type}] "${i.text}" at (${_x},${_y}) ${_w}x${_h}`;
  });

  return {
    formatted: _lines.join('\n'),
    filtered: _classified,
    noise: _noiseCount,
  };
}

// Async helper: query the DOM for cookie/consent dialog rects so we can filter
// OCR items that fall inside them. Returns an array of {x, y, w, h} in image
// coordinates (scaled to the screenshot, not CSS pixels).
async function _getNoiseDialogRects(page, imgW, imgH) {
  if (!page) return [];
  const _vpW = page.viewportSize()?.width || 1280;
  const _vpH = page.viewportSize()?.height || 800;
  const _scaleX = imgW / _vpW;
  const _scaleY = imgH / _vpH;
  try {
    const _rects = await page.evaluate(() => {
      const _out = [];
      const _dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"], div');
      for (const d of _dialogs) {
        const _t = (d.innerText || d.textContent || '').trim().slice(0, 200);
        if (!_t) continue;
        if (!_NOISE_DIALOG_RE.test(_t)) continue;
        const r = d.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        _out.push({ x: r.left, y: r.top, w: r.width, h: r.height, text: _t.slice(0, 60) });
      }
      return _out;
    }).catch(() => []);
    return _rects.map(r => ({
      x: r.x * _scaleX, y: r.y * _scaleY,
      w: r.w * _scaleX, h: r.h * _scaleY,
    }));
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------
// _resolveActionTarget — disambiguate clickByText targets when multiple DOM
// candidates share the same text (e.g. "Save" in "Edit details" dialog vs
// "Save" in a cookie consent dialog). Combines DOM bounding boxes with
// LiteParser text coordinates to pick the correct target.
//
// Returns { ok, resolved: bool, bestSelector?: string, candidates?: array, reason: string }
//   - resolved=true + bestSelector: a single best candidate was found
//   - resolved=false + candidates: still ambiguous, return all for LLM to decide
// ---------------------------------------------------------------------------
async function _resolveActionTarget({ sessionId, text, subTaskContext, liteparseCache }) {
  const _targetText = (text || '').trim().toLowerCase();
  if (!_targetText) return { ok: false, resolved: false, reason: 'no text provided' };

  const _page = engine?.getPage?.(sessionId);
  if (!_page) return { ok: false, resolved: false, reason: 'no page' };

  // 1. Get DOM candidates with bounding boxes + dialog containment info
  let _candidates = [];
  try {
    _candidates = await _page.evaluate((targetText) => {
      const lower = targetText.toLowerCase();
      const baseSelector = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], div, span';
      const els = Array.from(document.querySelectorAll(baseSelector));
      const results = [];
      // Compliance dialog patterns (same as _detectOpenMenus)
      const _compliancePatterns = ['cookie', 'consent', 'advertis', 'privacy', 'gdpr', 'language', 'location', 'region', 'country', 'opt-out', 'opt out', 'tailored', 'your privacy choices', 'do not sell', 'ccpa'];
      function isComplianceDialog(el) {
        const _label = (el.getAttribute('aria-label') || '').toLowerCase();
        const _cls = (el.className || '').toLowerCase();
        const _text = ((el.innerText || el.textContent || '').slice(0, 200) || '').toLowerCase();
        for (const p of _compliancePatterns) {
          if (_label.includes(p) || _cls.includes(p)) return true;
          if (_text.includes(p) && _text.length < 300) return true;
        }
        return false;
      }
      // Find which dialog each candidate is inside
      function getDialogInfo(el) {
        let node = el.parentElement;
        for (let i = 0; i < 8 && node; i++) {
          const role = node.getAttribute('role');
          if (role === 'dialog' || role === 'alertdialog' || node.getAttribute('aria-modal') === 'true') {
            return {
              inDialog: true,
              dialogLabel: node.getAttribute('aria-label') || '',
              dialogRole: role || 'dialog',
              isCompliance: isComplianceDialog(node),
            };
          }
          if (role === 'menu' || role === 'listbox') {
            return { inDialog: true, dialogLabel: node.getAttribute('aria-label') || '', dialogRole: role, isCompliance: isComplianceDialog(node) };
          }
          node = node.parentElement;
        }
        return { inDialog: false, dialogLabel: '', dialogRole: '', isCompliance: false };
      }
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const elText = (el.innerText || el.textContent || '').trim();
        if (!elText) continue;
        const isExact = elText.toLowerCase() === lower;
        const isSub = elText.toLowerCase().includes(lower);
        if (!isExact && !isSub) continue;
        const dlg = getDialogInfo(el);
        // Build a selector for this element
        let sel = '';
        if (el.id) sel = `#${el.id}`;
        else if (el.getAttribute('role')) sel = `[role="${el.getAttribute('role')}"]`;
        else sel = el.tagName.toLowerCase();
        results.push({
          selector: sel,
          tag: el.tagName,
          text: elText.slice(0, 60),
          isExact,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          cx: Math.round(r.x + r.width / 2),
          cy: Math.round(r.y + r.height / 2),
          inDialog: dlg.inDialog,
          dialogLabel: dlg.dialogLabel,
          dialogRole: dlg.dialogRole,
          isCompliance: dlg.isCompliance,
        });
      }
      return results;
    }, _targetText);
  } catch (e) {
    return { ok: false, resolved: false, reason: `DOM candidate query failed: ${e.message}` };
  }

  if (_candidates.length === 0) return { ok: false, resolved: false, reason: 'no DOM candidates' };
  if (_candidates.length === 1) return { ok: true, resolved: true, bestSelector: _candidates[0].selector, reason: 'single candidate' };

  // 2. Multiple candidates — get LiteParser text items (use cache if fresh < 3s)
  let _lpItems = null;
  let _imgW = 1280, _imgH = 800;
  const _now = Date.now();
  if (liteparseCache && liteparseCache.textItems && (_now - liteparseCache.timestamp) < 3000) {
    _lpItems = liteparseCache.textItems;
    _imgW = liteparseCache.imageWidth || 1280;
    _imgH = liteparseCache.imageHeight || 800;
  } else {
    try {
      const _cap = await _liteparseCapture(_page);
      if (_cap.ok) {
        _lpItems = _cap.textItems || [];
        _imgW = _cap.imageWidth || 1280;
        _imgH = _cap.imageHeight || 800;
      }
    } catch (_) {}
  }

  // Viewport for coordinate scaling
  const _vpW = _page.viewportSize()?.width || 1280;
  const _vpH = _page.viewportSize()?.height || 800;
  const _scaleX = _vpW / _imgW;
  const _scaleY = _vpH / _imgH;

  // 3. Score each candidate
  const _subTaskLower = (subTaskContext || '').toLowerCase();
  for (const c of _candidates) {
    let score = 0;
    // +3 exact text match
    if (c.isExact) score += 3;
    // +2 button tag
    if (c.tag === 'BUTTON' || c.selector.includes('button')) score += 2;
    // -5 compliance dialog
    if (c.isCompliance) score -= 5;
    // +5 inside a dialog whose label matches sub-task context
    if (c.inDialog && c.dialogLabel && _subTaskLower) {
      const _dlgLower = c.dialogLabel.toLowerCase();
      // Check if any word from the sub-task context appears in the dialog label
      const _ctxWords = _subTaskLower.split(/\s+/).filter(w => w.length > 3);
      if (_ctxWords.some(w => _dlgLower.includes(w))) score += 5;
    }
    // +10 LiteParser coordinate overlap
    if (_lpItems && _lpItems.length > 0) {
      for (const item of _lpItems) {
        const _itemText = (item.text || '').trim().toLowerCase();
        if (!_itemText) continue;
        // Text match (exact or substring)
        if (_itemText === _targetText || _itemText.includes(_targetText) || _targetText.includes(_itemText)) {
          // Scale LiteParser coords to viewport coords
          const _lpCx = (item.x + (item.width || 0) / 2) * _scaleX;
          const _lpCy = (item.y + (item.height || 0) / 2) * _scaleY;
          // Check overlap: DOM center within 20px of LiteParser center
          const _dx = Math.abs(c.cx - _lpCx);
          const _dy = Math.abs(c.cy - _lpCy);
          if (_dx < 20 && _dy < 20) {
            score += 10;
            break; // only count one match
          }
        }
      }
    }
    c.score = score;
  }

  // 4. Sort by score descending
  _candidates.sort((a, b) => b.score - a.score);

  // 5. Pick highest, or return all if top two are within 2 points
  const _top = _candidates[0];
  const _second = _candidates[1];
  if (_second && (_top.score - _second.score) < 2) {
    logger.warn(`[playwright.agent] _resolveActionTarget: ambiguous — top candidates "${_top.text}" (score=${_top.score}) and "${_second.text}" (score=${_second.score}) for text="${text}" — returning all for LLM`);
    return { ok: true, resolved: false, candidates: _candidates.slice(0, 5), reason: 'ambiguous — top scores within 2 points' };
  }

  logger.info(`[playwright.agent] _resolveActionTarget: resolved "${text}" → "${_top.text}" (score=${_top.score}, dialog="${_top.dialogLabel}", compliance=${_top.isCompliance}) out of ${_candidates.length} candidates`);
  return { ok: true, resolved: true, bestSelector: _top.selector, bestCandidate: _top, candidates: _candidates.slice(0, 5), reason: `highest score=${_top.score}` };
}
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
      const modal = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"]')).find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
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
- HIDDEN ELEMENT RULE: If a fill or click action fails with "element is not visible" or "not interactable", the element exists in the DOM but is hidden by a UI mode (compact mode, collapsed toolbar, minimized section). Do NOT retry the same selector. Instead: (a) check the APP KNOWLEDGE block for known keyboard shortcuts or UI mode toggles for this app, (b) try pressing a keyboard shortcut to toggle the UI mode (e.g. Ctrl+Shift+F for compact mode in many editors), (c) look for a toggle/expand/collapse button in the snapshot, or (d) press Ctrl+/ or ? to open the app's shortcut help overlay. After revealing the element, retry the original action.
- CLEAR-BEFORE-FILL RULE: When filling a title, rename, or any input field that already has a value (e.g. "Untitled document", "Untitled", existing text), NEVER use "type" — it appends to the existing value, producing garbage like "Untitled dQ3 Planning Notesocument". Instead use "fill" (which does Meta+A + type to replace) or "reactFill" (which replaces via native setter with clearFirst). If you must use "type", first press { "action": "press", "key": "Meta+a" } to select all existing text, then type the new value.
- MULTI-CONTENTEDITABLE RULE: When the page has multiple contenteditable elements (e.g. title H1 + body DIV, or To/Subject/Body in email compose), do NOT use generic "[contenteditable='true']" — it matches the FIRST in document order, which may be the body, not the title. Use the SELECTOR HINTS which list each contenteditable with its distinguishing attribute (placeholder, aria-label, role, tag). For title/rename tasks, prefer "h1[contenteditable]", "[placeholder='New page']", or the tag-specific selector. For body/content tasks, target the body element specifically by role or aria-label. If reactFill returns a "warning" field, the selector matched multiple elements — switch to a more specific selector immediately.
- SEARCH-THEN-CLICK RULE: After filling a search box and pressing Enter, ALWAYS run waitForStableText before clicking a result. Search results load dynamically — if you click before results settle, you may click a stale element or the search box itself. After results load, identify the first ORGANIC result (skip ads/sponsored) by its link/text and click it.
- BLOCK-CREATION RULE: When creating lists/todos in block-based editors (Notion, Google Docs, Confluence), do NOT type raw markdown like "- Task 1\n- Task 2\n- Task 3" as a single type action — newlines inside a contenteditable do NOT create separate blocks. Instead, create each item as a separate step: (1) type the block-creation shortcut for the desired block type (e.g. "[]" + Space for todo, "-" + Space for bullet, "/todo" + Enter for slash command), (2) type the item text, (3) press Enter to create the next block, (4) repeat for each item. Check the APP KNOWLEDGE section for the app's specific block-creation shortcuts — if slash commands are available (e.g. "/todo"), prefer them over markdown shortcuts.
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
- HIDDEN ELEMENT RULE: If a step failed with "element is not visible" or "not interactable", the element exists in the DOM but is hidden by a UI mode (compact mode, collapsed toolbar). Do NOT retry the same selector. Instead: (a) check the APP KNOWLEDGE block for known keyboard shortcuts or UI mode toggles, (b) try pressing a keyboard shortcut to toggle the UI mode (e.g. Ctrl+Shift+F for compact mode), (c) look for a toggle/expand/collapse button in the snapshot, or (d) press Ctrl+/ to open shortcut help. After revealing the element, retry the original action with fresh refs.
- CLEAR-BEFORE-FILL RULE: When filling a title, rename, or any input field that already has a value (e.g. "Untitled document", "Untitled", existing text), NEVER use "type" — it appends to the existing value, producing garbage like "Untitled dQ3 Planning Notesocument". Instead use "fill" (which does Meta+A + type to replace) or "reactFill" (which replaces via native setter with clearFirst). If you must use "type", first press { "action": "press", "key": "Meta+a" } to select all existing text, then type the new value.
- MULTI-CONTENTEDITABLE RULE: When the page has multiple contenteditable elements (e.g. title H1 + body DIV, or To/Subject/Body in email compose), do NOT use generic "[contenteditable='true']" — it matches the FIRST in document order, which may be the body, not the title. Use the SELECTOR HINTS which list each contenteditable with its distinguishing attribute (placeholder, aria-label, role, tag). For title/rename tasks, prefer "h1[contenteditable]", "[placeholder='New page']", or the tag-specific selector. For body/content tasks, target the body element specifically by role or aria-label. If reactFill returns a "warning" field, the selector matched multiple elements — switch to a more specific selector immediately.
- SEARCH-THEN-CLICK RULE: After filling a search box and pressing Enter, ALWAYS run waitForStableText before clicking a result. Search results load dynamically — if you click before results settle, you may click a stale element or the search box itself. After results load, identify the first ORGANIC result (skip ads/sponsored) by its link/text and click it.
- BLOCK-CREATION RULE: When creating lists/todos in block-based editors (Notion, Google Docs, Confluence), do NOT type raw markdown like "- Task 1\n- Task 2\n- Task 3" as a single type action — newlines inside a contenteditable do NOT create separate blocks. Instead, create each item as a separate step: (1) type the block-creation shortcut for the desired block type (e.g. "[]" + Space for todo, "-" + Space for bullet, "/todo" + Enter for slash command), (2) type the item text, (3) press Enter to create the next block, (4) repeat for each item. Check the APP KNOWLEDGE section for the app's specific block-creation shortcuts — if slash commands are available (e.g. "/todo"), prefer them over markdown shortcuts.

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
      const modalCount = document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"]').length;
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
        modalCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"]').length,
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
    url: window.location.href,
    hasModalDialog: Array.from(document.querySelectorAll('[role="dialog"], [data-testid*="modal"], [data-testid*="share"], [aria-modal="true"]')).some(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }),
    modalCount: Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length,
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
      // Strip `text` from each field before saving — values are goal-specific
      // (e.g. "Q3 Planning Notes") and should never be cached. Only STRUCTURE
      // (selectors, placeholders, roles) should be cached. Caching values leads
      // to stale values being reused on future runs with different goals.
      fields: (map.fields || []).map(f => {
        const { text, ...rest } = f;
        return rest;
      }),
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
- IMPORTANT: The "[] " shortcut requires a SPACE after the brackets to trigger. Typing "[]item" will NOT work — it must be "[] item".
- Once that block is created, pressing Enter typically continues the SAME block type automatically for the next line — do NOT repeat the shortcut prefix on subsequent items, it will appear as literal unconverted text instead of being interpreted.
- PREFER slash commands (e.g. "/todo", "/checklist") over markdown shortcuts when available — they're more reliable and don't depend on the space-after-shortcut timing.
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

    // Clear existing content before typing — prevents duplicate text from prior
    // failed attempts (e.g. Tier 1.7 typed but failed to submit, leaving text in
    // the compose box). Meta+A selects all; the first type step then replaces it.
    const _hasTypeStep = parsed.steps.some(s => s.type);
    if (_hasTypeStep) {
      await browserAct({ action: 'press', key: 'Meta+a', sessionId, headed, timeoutMs: 3000 }).catch(() => {});
    }

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

// Unified field map prompt — placeholder primary, CSS selector fallback.
// Used for both form URLs (Gmail, LinkedIn) and editor pages (Notion, Google Docs).
// The LLM sees the actual page HTML (with real placeholders) and generates a map
// with BOTH placeholder hints AND CSS selectors. The executor tries placeholder first.
const FIELD_MAP_GEN_PROMPT = `You are a browser automation expert. Analyze the provided page fields and the user's goal, and generate a unified field map for form/editor filling.

Output ONLY a JSON object (no markdown, no explanation) with:
- "fields": array of field objects, each with:
  - "name": semantic field name (e.g. "to", "subject", "body", "title", "description", "content", "item1", "item2", "item3")
  - "role": one of "title", "body", "item", "input" (for finding by position when no placeholder)
  - "placeholder": the placeholder text to look for (from the page fields), or "" if none
  - "text": the text to type into this field (extracted from the goal)
  - "selectors": array of CSS selector strings (fallback when no placeholder), most specific first, or [] if none
  - "type": one of "input", "textarea", "contenteditable", "chip", "select"
  - "verifySelector": CSS selector to check after typing (optional, for fallback verification), or null
  - "verifyType": one of "value", "innerText", "chip_count"
  - "pressAfter": key to press after typing (e.g. "Enter" to move to next field or create next list item), or null
- "submitSelectors": array of CSS selectors for submit/send buttons (optional — null for auto-save pages)
- "submitVerify": object with "type" ("compose_gone", "snackbar", "url_change") and "pattern" (regex string), or null
- "autoSave": boolean — true if the page auto-saves (no submit button needed, e.g. Notion, Google Docs)
- "multiStep": boolean — true if the goal is a multi-step sequential task that CANNOT be accomplished by filling form fields on the CURRENT page (e.g. "create a playlist, then search for each artist and add songs" requires clicking buttons and navigating between pages, not just filling fields). false for single-action form fills (even if described with multiple micro-steps like "click search, type X, press Enter" — all target the same input).

Rules:
- Include BOTH placeholder AND selectors when available — the executor tries placeholder first, falls back to selectors
- For fields with placeholders (Notion title "New page", LinkedIn compose "What do you want to talk about?", Twitter "What's happening?"): include placeholder
- For fields without placeholders but with stable selectors (Gmail To=[name="to"], Subject=[name="subjectbox"]): include selectors
- PSEUDO-PLACEHOLDER FIELDS: Some fields use value="" instead of the placeholder attribute. The page fields now include "value", "dataTooltip", "title", "cssBeforeContent", and "hasBlankClass" signals. If a field has NO placeholder attr but has value matching aria-label (e.g. Google Docs title: value="Untitled document" + aria-label="Untitled document"), treat the value as the placeholder — set "placeholder" to the value text. Same for cssBeforeContent (CSS ::before content on empty contenteditable) and hasBlankClass (ql-blank, is-empty, etc.).
- For contenteditable bodies: type="contenteditable", verifyType="innerText"
- For chip/badge fields (Gmail To): type="chip", verifyType="chip_count"
- For editor pages (Notion, Google Docs): autoSave=true, submitSelectors=null
- For AI chat pages (a message box that streams a reply — ChatGPT, Claude, Gemini, Grok, Perplexity, etc.): autoSave=false, submitSelectors=null, pressAfter="Enter" on the message field. The Enter key submits the prompt; the system will wait for the streamed response automatically.
- For form/compose pages (Gmail, LinkedIn, Twitter): autoSave=false, include submitSelectors
- For list items: role="item", pressAfter="Enter" (to create the next item automatically)
- For slash commands (e.g. "/todo"): include as a separate field with text="/todo" and pressAfter="Enter"
- Extract the text values from the goal (e.g. "Weekly Goals" from "create a page called 'Weekly Goals'")
- MULTI-STEP DETECTION: Set "multiStep": true ONLY when the goal requires actions across MULTIPLE different UI contexts/pages (e.g. create a playlist on one page, then search on another page, then add songs from a third context). Do NOT set multiStep=true when all actions target the same form/input on the current page (e.g. "click the search box, type 'Lecrae', press Enter" is single-step — all actions target the search input). When the goal describes more than 2 sequential actions across different pages (e.g. "create X, then search Y, then add Z"), set multiStep=true. If the goal contains sequential markers like "then", "next", "finally" connecting different actions, set multiStep=true.
- Output ONLY the JSON object.`;

const FIELD_EXTRACTION_PROMPT = `You are a goal parser. Extract field values from the user's goal for form filling.

Output ONLY a JSON object mapping field names to their values. Field names should match common form field names: "to", "subject", "body", "title", "description", "content", "cc", "bcc", "tags", "category", "prompt".

Rules:
- Email addresses go in "to" (comma-separated if multiple).
- Text after "subject" or "titled" goes in "subject".
- Text after "body" or "message" or "saying" goes in "body".
- If the goal is a single text with no clear field mapping, put it in "body".
- For AI chat / conversation tasks (ask, tell, prompt, proofread, polish, summarize, rewrite, improve, edit, review, translate, explain, analyze, etc.): put the FULL instruction text (including the verb and any instruction prefix like "Proofread and polish the following...") in "body". Do NOT strip the instruction prefix — the entire instruction is the prompt that should be pasted into the AI chat box. For example, "Proofread and polish the following thank-you note: 'Dear Bob, thanks...'" → body: "Proofread and polish the following thank-you note: 'Dear Bob, thanks...'" (the full text).
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

// Unified field map generation — placeholder primary, CSS selector fallback.
// Used for both form URLs (CSS selectors) and editor pages (placeholder + position).
// Gathers page HTML with placeholders + positions, asks LLM for unified field map.
async function _generateFieldMap(sessionId, hostname, goal, timeoutMs, options = {}) {
  try {
    const page = engine.getPage(sessionId);
    if (!page) return null;

    // Gather page HTML — include placeholders, positions, and CSS-relevant attributes
    const pageHtml = await page.evaluate(() => {
      const elements = [];
      const inputs = document.querySelectorAll('input, textarea, select, [contenteditable], [role="combobox"], [role="textbox"]');
      for (const el of inputs) {
        // Don't skip hidden elements — mark them as hidden instead. The LLM needs
        // to see hidden elements (e.g. Google Docs title input when header is
        // collapsed) so it can generate a selector. The executor uses JS focus
        // to interact with hidden elements.
        const _isHidden = el.offsetParent === null && el.getClientRects().length === 0;
        // Skip elements that are truly not in the DOM (display:none on parent with 0 size)
        // but keep elements that are just visually hidden (can be focused via JS)
        if (_isHidden && el.tagName !== 'INPUT' && !el.isContentEditable) continue;
        const r = el.getBoundingClientRect();
        const info = {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type'),
          name: el.getAttribute('name'),
          id: el.getAttribute('id'),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '',
          role: el.getAttribute('role'),
          contentEditable: el.isContentEditable,
          className: (el.className || '').toString().slice(0, 100),
          dataTestId: el.getAttribute('data-testid'),
          hidden: _isHidden,
          // Pseudo-placeholder signals (Fix 30a) — detect placeholder-like fields
          // when the standard placeholder attr is absent. Google Docs title input
          // uses value="Untitled document" + aria-label="Untitled document" +
          // data-tooltip="Untitled document" as a pseudo-placeholder.
          value: (el.value || '').slice(0, 200),
          dataTooltip: el.getAttribute('data-tooltip') || '',
          title: el.getAttribute('title') || '',
          cssBeforeContent: (() => {
            try {
              const c = getComputedStyle(el, '::before').content;
              return (c && c !== 'none' && c !== 'normal') ? c.replace(/^["']|["']$/g, '') : '';
            } catch { return ''; }
          })(),
          hasBlankClass: /placeholder|blank|empty|watermark/i.test(el.className || ''),
          rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
        };
        elements.push(info);
      }
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

    const prompt = options.hasEditableFields ? FIELD_MAP_GEN_PROMPT : SELECTOR_MAP_GEN_PROMPT;
    const raw = await askWithMessages([
      { role: 'system', content: prompt },
      { role: 'user', content: `HOSTNAME: ${hostname}\nGOAL: ${goal}\n\nPAGE STRUCTURE:\n${pageHtml}${options.agentContext ? `\n\nAPP KNOWLEDGE (site-specific instructions — use these selectors/shortcuts when generating the field map):\n${options.agentContext}` : ''}\n\nGenerate the field map JSON:` },
    ], { temperature: 0.1, maxTokens: 1200, responseTimeoutMs: 20000 });

    const parsed = parseJson(raw);
    if (!parsed || !Array.isArray(parsed.fields) || parsed.fields.length === 0) {
      logger.warn(`[playwright.agent] field map gen: no valid map generated`);
      return null;
    }
    // LLM multi-step detection — goal requires sequential actions across multiple
    // UI contexts that a single field map cannot handle. Fall through to Tier 2/3.
    if (parsed.multiStep === true) {
      logger.info(`[playwright.agent] field map gen: LLM detected multi-step goal — skipping field map (falling through to Tier 2/3)`);
      return { multiStep: true };
    }
    // Structural sanity check: if the LLM generated only 1 field with very long
    // text (>100 chars), it has misrouted a multi-step task into a single field.
    // This catches cases where the LLM's multiStep flag failed but the field map
    // is clearly wrong (e.g. entire 500-char goal typed into a search box).
    if (parsed.fields.length === 1 && (parsed.fields[0].text || '').length > 100) {
      logger.info(`[playwright.agent] field map gen: single field "${parsed.fields[0].name}" with long text (${(parsed.fields[0].text || '').length} chars) — treating as multi-step (falling through to Tier 2/3)`);
      return { multiStep: true };
    }
    logger.info(`[playwright.agent] field map gen: ${parsed.fields.length} fields, ${parsed.submitSelectors?.length || 0} submit selectors, autoSave=${!!parsed.autoSave}, multiStep=${!!parsed.multiStep}`);
    logger.info(`[playwright.agent] field map gen JSON: ${JSON.stringify(parsed.fields.map(f => ({ name: f.name, text: f.text, role: f.role, selectors: f.selectors, pressAfter: f.pressAfter, placeholder: f.placeholder })))}`);
    return parsed;
  } catch (err) {
    logger.warn(`[playwright.agent] field map gen error: ${err.message}`);
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

// Unified field map execution — placeholder + position primary, CSS selector fallback.
// For each field: try placeholder + position first (JS focus, bypasses overlays),
// fall back to CSS selector (page.click), fall back to role + position.
// Verification: snapshot comparison (built into type action) for placeholder path,
// ── App-Knowledge Entry Application Helpers ─────────────────────────────────
// Used by _executeFieldMap to apply existing app-knowledge entries (ui_mode,
// recovery_move) BEFORE triggering JIT research. This avoids redundant web
// research when the fix is already cached (e.g. "Ctrl+Shift+F to toggle compact
// mode" was already known but wasn't being used).

// Apply an app-knowledge entry's fix (shortcut, menuPath, or selector).
// Returns true if the fix was applied, false if it couldn't be applied.
async function _applyAppKnowledgeEntry(entry, page, browserAct, sessionId) {
  if (!entry?.details) return false;
  const _d = entry.details;
  try {
    // Shortcut: press a keyboard shortcut (e.g. Ctrl+Shift+F to toggle compact mode)
    if (_d.shortcut) {
      logger.info(`[playwright.agent] app-knowledge: applying [${entry.type}] shortcut="${_d.shortcut}" — ${entry.summary}`);
      await browserAct({ action: 'press', key: _d.shortcut, sessionId, headed: true, timeoutMs: 5000 });
      await new Promise(r => setTimeout(r, 800)); // wait for UI to update
      return true;
    }
    // Menu path: click through menu items (e.g. "File > Rename")
    if (_d.menuPath) {
      const _menuItems = _d.menuPath.split(/[>›\u203a]/).map(s => s.trim()).filter(Boolean);
      logger.info(`[playwright.agent] app-knowledge: applying [${entry.type}] menuPath="${_d.menuPath}" — ${entry.summary}`);
      for (const _menuItem of _menuItems) {
        await page.evaluate((label) => {
          const _els = Array.from(document.querySelectorAll('div[role="menuitem"], span, a, button'));
          const _match = _els.find(el => (el.textContent || '').trim().toLowerCase() === label.toLowerCase());
          if (_match) { _match.click(); return true; }
          const _partial = _els.find(el => {
            const t = (el.textContent || '').trim().toLowerCase();
            return t.includes(label.toLowerCase()) && t.length < label.length + 20;
          });
          if (_partial) { _partial.click(); return true; }
          return false;
        }, _menuItem).catch(() => false);
        await new Promise(r => setTimeout(r, 300));
      }
      await new Promise(r => setTimeout(r, 500));
      return true;
    }
    // Selector: JS focus on the selector
    if (_d.selector) {
      logger.info(`[playwright.agent] app-knowledge: applying [${entry.type}] selector="${_d.selector}" — ${entry.summary}`);
      const _jsFocus = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return false;
        el.focus();
        return true;
      }, _d.selector).catch(() => false);
      return !!_jsFocus;
    }
    logger.info(`[playwright.agent] app-knowledge: entry [${entry.type}] has no applicable fix (no shortcut/menuPath/selector)`);
    return false;
  } catch (_err) {
    logger.warn(`[playwright.agent] app-knowledge: failed to apply [${entry.type}] entry: ${_err.message}`);
    return false;
  }
}

// Retry the normal fill path after applying an app-knowledge fix.
// Fix 32: Path 1 now uses native setter with pre/post value snapshot verification
//   (Placeholder-verify concept) instead of keyboard.type which routes to wrong element.
// Fix 33: Path 2 now adds el.focus() for INPUT/TEXTAREA before native setter.
// Verifies el.value contains expected text before returning filled=true.
// Returns { filled: boolean, method: string }.
async function _retryFieldFill(page, field, value, browserAct, sessionId, fieldTimeout, transcript) {
  // Path 1: CSS selector with page.click + native setter (Fix 32: Placeholder-verify concept)
  // After app-knowledge fix (e.g. Ctrl+Shift+F), element is visible. page.click focuses it,
  // then native setter sets value directly (bypasses keyboard routing to body contenteditable).
  // Pre/post value comparison = deterministic verification.
  if (field.selectors && field.selectors.length > 0) {
    for (const sel of field.selectors) {
      try {
        await page.click(sel, { timeout: Math.min(fieldTimeout, 5000) });
        // Native setter with pre/post value snapshot (Fix 32)
        const _setResult = await page.evaluate((selector, text) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const preValue = (el.value || el.textContent || '').slice(0, 200);
          el.focus();
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) { setter.set.call(el, text); } else { el.value = text; }
          } else if (el.isContentEditable) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            document.execCommand('insertText', false, text);
          } else { return null; }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          const postValue = (el.value || el.textContent || '').slice(0, 200);
          return { preValue, postValue, tag: el.tagName.toLowerCase(), changed: postValue !== preValue, contains: postValue.includes(text) };
        }, sel, value).catch(() => null);
        if (_setResult && (_setResult.contains || _setResult.changed)) {
          logger.info(`[playwright.agent] app-knowledge retry: field "${field.name}" filled via native setter on "${sel}" (pre="${_setResult.preValue.slice(0, 40)}" post="${_setResult.postValue.slice(0, 40)}" changed=${_setResult.changed})`);
          transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: sel, method: 'app-knowledge-retry-native-setter', verified: true, preValue: _setResult.preValue, postValue: _setResult.postValue } });
          if (field.pressAfter) { await page.keyboard.press(field.pressAfter); }
          return { filled: true, method: 'native-setter' };
        }
        logger.warn(`[playwright.agent] app-knowledge retry: CSS selector "${sel}" click succeeded but value not set (pre="${_setResult?.preValue?.slice(0, 40) || ''}" post="${_setResult?.postValue?.slice(0, 40) || ''}")`);
      } catch (_) { /* element still not visible — try next selector */ }
    }
  }
  // Path 2: JS focus + native setter without page.click (for elements still hidden after fix)
  // Fix 33: Add el.focus() for INPUT/TEXTAREA (was only done for contenteditable)
  if (field.selectors && field.selectors.length > 0) {
    for (const sel of field.selectors) {
      const _setResult = await page.evaluate((selector, text) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        el.focus(); // Fix 33: focus before setter for ALL element types
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value');
          if (setter && setter.set) { setter.set.call(el, text); } else { el.value = text; }
        } else if (el.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('insertText', false, text);
        } else { return null; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: el.value || el.textContent || '', tag: el.tagName.toLowerCase() };
      }, sel, value).catch(() => null);
      if (_setResult?.value?.includes(value)) {
        logger.info(`[playwright.agent] app-knowledge retry: field "${field.name}" filled via native setter (no click) on "${sel}" (verified: "${_setResult.value.slice(0, 50)}")`);
        transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: sel, method: 'app-knowledge-retry-native-setter-noclick', verified: true } });
        if (field.pressAfter) { await page.keyboard.press(field.pressAfter); }
        return { filled: true, method: 'native-setter' };
      }
    }
  }
  // Path 3: Placeholder (incl. pseudo-placeholder — element may now be visible)
  const _hasPseudoPlaceholder = !!(
    (field.value && field.value.length > 0 && field.value === field.ariaLabel) ||
    (field.value && /^(untitled|new|empty|add|enter|placeholder|click to|type to|start (typing|writing))/i.test(field.value)) ||
    (field.cssBeforeContent && field.cssBeforeContent.length > 0) ||
    (field.hasBlankClass)
  );
  if ((field.placeholder && field.placeholder.length > 0) || _hasPseudoPlaceholder) {
    const _placeholderText = field.placeholder || field.value || field.cssBeforeContent || '';
    const _found = await page.evaluate((fieldInfo) => {
      const _placeholder = fieldInfo.placeholder || fieldInfo.value || fieldInfo.cssBeforeContent || '';
      const _hasPseudo = !fieldInfo.placeholder && !!(
        (fieldInfo.value && fieldInfo.value === fieldInfo.ariaLabel) ||
        (fieldInfo.value && /^(untitled|new|empty|add|enter|placeholder|click to|type to|start (typing|writing))/i.test(fieldInfo.value)) ||
        (fieldInfo.cssBeforeContent && fieldInfo.cssBeforeContent.length > 0) ||
        (fieldInfo.hasBlankClass)
      );
      const _candidates = Array.from(document.querySelectorAll(
        '[contenteditable="true"], [role="textbox"], input[type="text"], input:not([type]), textarea'
      )).filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '';
        if (ph && ph.toLowerCase().includes(_placeholder.toLowerCase())) return true;
        if (_hasPseudo) {
          const val = (el.value || '').trim();
          const aria = el.getAttribute('aria-label') || '';
          const tooltip = el.getAttribute('data-tooltip') || '';
          if (val && val.toLowerCase().includes(_placeholder.toLowerCase())) return true;
          if (val && aria && val === aria) return true;
          if (val && tooltip && val === tooltip) return true;
          if (fieldInfo.cssBeforeContent) {
            try {
              const c = getComputedStyle(el, '::before').content;
              const beforeText = (c && c !== 'none' && c !== 'normal') ? c.replace(/^["']|["']$/g, '') : '';
              if (beforeText && beforeText.toLowerCase().includes(_placeholder.toLowerCase())) return true;
            } catch {}
          }
          if (fieldInfo.hasBlankClass && /placeholder|blank|empty|watermark/i.test(el.className || '')) return true;
        }
        return false;
      });
      if (_candidates.length === 0) return null;
      const el = _candidates[0];
      el.focus();
      return { found: true, tag: el.tagName.toLowerCase(), method: _hasPseudo ? 'pseudo-placeholder' : 'placeholder' };
    }, field).catch(() => null);
    if (_found?.found) {
      const _typeRes = await browserAct({ action: 'type', text: value, sessionId, headed: true, timeoutMs: 10000 });
      if (_typeRes.ok) {
        transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, method: `app-knowledge-retry-${_found.method}` } });
        if (field.pressAfter) { await browserAct({ action: 'press', key: field.pressAfter, sessionId, headed: true, timeoutMs: 5000 }); }
        return { filled: true, method: _found.method };
      }
    }
  }
  return { filled: false, method: null };
}

// ── Streaming response detection ────────────────────────────────────────────
// After pressing Enter on an AI chat / search page, the response streams via SSE
// (text/event-stream) or WebSocket. Auto-save editors (Notion, Google Docs) NEVER
// use these protocols — they use regular fetch POST with JSON. So detecting them
// is a definitive signal that a streamed response is in progress.
//
// Multi-signal: network protocol (strongest) + content growth/URL change (behavioral).
// Handles variable response timing: up to maxWait for streaming to start (5s preload
// case), early exit after earlyExit ms if no activity (true autoSave).
//
// Activity signals (any one keeps us waiting):
//   - streamingSeen (network flag from listeners)
//   - URL changed from preSubmitUrl (ChatGPT navigates / → /c/<id> on first message)
//   - innerText changed materially in EITHER direction vs postSubmitBaseline (|Δ| > 100)
//     — catches the shrink-then-grow pattern during page transition mid-stream
//   - innerText grew > 200 vs postSubmitBaseline (original growth check, now vs right baseline)
//
// NOTE: Listeners are set up BEFORE the field loop by the caller (so they catch the
// SSE event when Enter is pressed during typing). This function only polls content
// growth + URL + checks the pre-set streamingSeen flag, then runs cleanup in finally.
async function _detectStreamingResponse(page, postSubmitBaselineTextLen, preSubmitUrl, streamingSeen, cleanup, maxWait = 10000, earlyExit = 8000) {
  let _contentGrew = false;
  let _urlChanged = false;
  try {
    const deadline = Date.now() + maxWait;
    const earlyDeadline = Date.now() + earlyExit;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));

      if (streamingSeen || _contentGrew || _urlChanged) return true;

      // Behavioral: check URL change (strong signal — ChatGPT/Claude navigate on first message)
      const currentUrl = await page.evaluate(() => location.href).catch(() => '');
      if (preSubmitUrl && currentUrl && currentUrl !== preSubmitUrl) {
        _urlChanged = true;
        logger.info(`[playwright.agent] field map: URL changed post-submit (${preSubmitUrl} → ${currentUrl}) — treating as streaming activity`);
        return true;
      }

      // Behavioral: check content growth OR shrink (page transition causes shrink-then-grow)
      const currentLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
      if (Math.abs(currentLen - postSubmitBaselineTextLen) > 100) {
        _contentGrew = true;
        logger.info(`[playwright.agent] field map: text length changed post-submit (baseline=${postSubmitBaselineTextLen} current=${currentLen} Δ=${currentLen - postSubmitBaselineTextLen}) — treating as streaming activity`);
        return true;
      }

      // Early exit: no network streaming AND no URL change AND no content movement → true autoSave
      if (Date.now() > earlyDeadline && !streamingSeen && !_contentGrew && !_urlChanged) return false;
    }

    return streamingSeen || _contentGrew || _urlChanged;
  } finally {
    if (cleanup) cleanup();
  }
}

// Capture a streaming response: detect → dual-signal completion wait → getPageText.
// Returns the extracted text on success, or null if no streaming detected.
//
// Completion signals (any one):
//   Signal 1: SSE requestfinished event (definitive — fires when the stream ends)
//   Signal 2: Sliding window — 3s of no text growth (fallback for non-SSE sites)
//   Signal 3: Stop button disappearance (ChatGPT/Claude show a Stop button while
//             streaming; its disappearance means the response is complete)
// This replaces waitForStableText which returns immediately on stable page text
// before the AI starts generating (its exact-match exit fires on pre-streaming text).
//
// postSubmitBaselineTextLen: captured by the caller ~500ms after submit (not before!)
//   — a pre-submit baseline is defeated by the page transition on submit.
// preSubmitUrl: captured before the field loop — used to detect URL change as activity.
async function _captureStreamingResponse(sessionId, page, postSubmitBaselineTextLen, preSubmitUrl, streamingSeen, cleanup, timeoutMs) {
  const _streaming = await _detectStreamingResponse(page, postSubmitBaselineTextLen, preSubmitUrl, streamingSeen, cleanup, 10000, 8000);
  if (!_streaming) return null;
  logger.info(`[playwright.agent] field map: streaming response detected — waiting for completion (up to 60s)`);

  // Triple-signal completion wait
  const _sseFinished = (typeof cleanup?._sseRequestFinished === 'function') ? cleanup._sseRequestFinished : () => false;
  const deadline = Date.now() + Math.min(timeoutMs, 60000);
  let prevLen = 0;
  let lastChangeTime = Date.now();
  const startTime = Date.now();
  let _stopButtonWasVisible = false;

  while (Date.now() < deadline) {
    // Signal 1: SSE request finished — definitive completion
    if (_sseFinished()) {
      logger.info(`[playwright.agent] field map: SSE completion signal — capturing text`);
      break;
    }
    // Signal 3: Stop button disappearance (ChatGPT/Claude DOM-based completion)
    const _stopVisible = await page.evaluate(() => {
      const sel = '[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop" i]';
      const el = document.querySelector(sel);
      return !!(el && el.offsetParent !== null);
    }).catch(() => false);
    if (_stopVisible) {
      _stopButtonWasVisible = true;
    } else if (_stopButtonWasVisible) {
      // Stop button was visible and is now gone → response complete
      // BUT: on Claude.ai the Stop button briefly appears during request setup
      // and disappears BEFORE streaming begins. Require a 2s text-stability
      // confirmation before accepting this as a completion signal. If the text
      // is still growing, keep waiting (the 2s window keeps resetting on growth).
      logger.info(`[playwright.agent] field map: Stop button disappeared — confirming text stability (2s)`);
      let _stableStart = Date.now();
      let _stablePrevLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
      while (Date.now() - _stableStart < 2000 && Date.now() < deadline) {
        const _checkLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
        if (_checkLen !== _stablePrevLen) {
          // Text still growing — not stable yet, reset window
          _stablePrevLen = _checkLen;
          _stableStart = Date.now();
        }
        await new Promise(r => setTimeout(r, 300));
      }
      logger.info(`[playwright.agent] field map: Stop button disappeared + text stable — capturing text`);
      break;
    }
    // Signal 2: Sliding window — 3s of no text growth (fallback)
    const curLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
    if (curLen !== prevLen) {
      lastChangeTime = Date.now();
    }
    if (prevLen > 0 && (Date.now() - lastChangeTime) > 3000 && (Date.now() - startTime) > 3000) {
      logger.info(`[playwright.agent] field map: text stable for 3s — capturing text`);
      break;
    }
    prevLen = curLen;
    await new Promise(r => setTimeout(r, 200));
  }

  const _textRes = await browserAct({ action: 'getPageText', sessionId, headed: true, timeoutMs: 10000 }).catch(() => null);
  const _text = String(_textRes?.result || '').trim();
  if (_text) {
    logger.info(`[playwright.agent] field map: streaming response captured (${_text.length} chars)`);
    return _text;
  }
  logger.warn(`[playwright.agent] field map: streaming detected but getPageText returned empty`);
  return 'Completed via field map (streaming response — extraction failed)';
}

// CSS selector check for CSS fallback path.
// Submit phase: skipped for autoSave pages (Notion, Google Docs).
async function _executeFieldMap(sessionId, fieldValues, fieldMap, timeoutMs, options = {}) {
  const page = engine.getPage(sessionId);
  if (!page) return { ok: false, error: 'no engine page' };

  const transcript = [];
  const fieldTimeout = Math.min(timeoutMs, 15000);
  const _hasEditableFields = !!options.hasEditableFields;

  // ── Streaming detection setup ──────────────────────────────────────
  // Structural signal: pressAfter="Enter" on body/message + no submitSelectors
  // → Enter is the submit mechanism, a streamed response may follow.
  // True autoSave editors (Notion, Google Docs) don't use pressAfter="Enter" on body.
  // NOTE: autoSave is NOT required — AI chat maps may have autoSave=true OR false.
  const _hasEnterSubmit = !(fieldMap.submitSelectors?.length) &&
    fieldMap.fields?.some(f => f.pressAfter === 'Enter');
  let _baselineTextLen = 0;
  let _preSubmitUrl = '';
  let _streamingSeen = false;
  let _streamingCleanup = null;
  if (_hasEnterSubmit) {
    _baselineTextLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
    _preSubmitUrl = await page.evaluate(() => location.href).catch(() => '');
    // Target hostname for diagnostic filtering — only log non-matching stream
    // candidates on the same host as the page (avoids noise from CDNs/analytics).
    let _targetHost = '';
    try { _targetHost = _preSubmitUrl ? new URL(_preSubmitUrl).hostname : ''; } catch (_) {}
    // Static asset extensions to skip in the non-matching diagnostic log.
    const _STATIC_ASSET_RE = /\.(?:js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map|wasm)(?:\?|#|$)/i;
    // Set up listeners BEFORE field loop — Enter is pressed during typing, SSE starts immediately.
    // Multi-signal network detection: content-type (original) + URL pattern (robust against
    // content-type changes) + chunked transfer-encoding. Listeners attached at BOTH page and
    // context level so engine wrappers / service workers can't swallow events.
    let _sseRequestFinished = false;
    const _STREAM_URL_RE = /\/backend-api\/conver|\/api\/chat|\/api\/conversation|\/completions|\/conversation|\/messages|\/stream|\/sse/i;
    const _isStreamResponse = (res) => {
      try {
        const ct = (res.headers()['content-type'] || '').toLowerCase();
        const te = (res.headers()['transfer-encoding'] || '').toLowerCase();
        const url = res.url() || '';
        const ctMatch = ct.includes('text/event-stream') || ct.includes('application/stream') || ct.includes('x-ndjson');
        const urlMatch = _STREAM_URL_RE.test(url);
        const chunked = te.includes('chunked');
        return { ctMatch, urlMatch, chunked, ct, url };
      } catch (_) {
        return null;
      }
    };
    const _onResponse = (res) => {
      const info = _isStreamResponse(res);
      if (!info) return;
      if (info.ctMatch || info.urlMatch) {
        if (!_streamingSeen) {
          logger.info(`[playwright.agent] field map: stream response detected (ct="${info.ct}" url="${info.url}")`);
        }
        _streamingSeen = true;
        return;
      }
      // Diagnostic: log non-matching responses that are likely stream candidates.
      // If the network signal misses, this shows exactly what the service sent so
      // we can extend the matcher instead of guessing.
      try {
        const resUrl = info.url || '';
        // Filter: only same-host responses (skip CDNs, analytics, etc.)
        let resHost = '';
        try { resHost = resUrl ? new URL(resUrl).hostname : ''; } catch (_) {}
        if (!_targetHost || !resHost || resHost !== _targetHost) return;
        // Filter: skip obvious static assets
        if (_STATIC_ASSET_RE.test(resUrl)) return;
        // Get method + status for diagnostic context
        const method = res.request()?.method?.() || res.request()?.method || '?';
        const status = res.status();
        const ct = info.ct || '';
        const te = (res.headers()['transfer-encoding'] || '').toLowerCase();
        // Log candidate: POST to target host, OR chunked, OR non-HTML text/*
        const isPost = String(method).toUpperCase() === 'POST';
        const isChunked = te.includes('chunked');
        const isNonHtmlText = ct.startsWith('text/') && !ct.includes('text/html');
        if (isPost || isChunked || isNonHtmlText) {
          logger.info(`[playwright.agent] field map: non-matching stream candidate (method=${method} ct="${ct}" url="${resUrl}" status=${status} te="${te}")`);
        }
      } catch (_) {}
    };
    const _onRequestFinished = (req) => {
      try {
        const res = req.response();
        if (!res) return;
        const info = _isStreamResponse(res);
        if (!info) return;
        if (info.ctMatch || info.urlMatch) {
          _sseRequestFinished = true;
          logger.info(`[playwright.agent] field map: stream request finished — streaming response complete (ct="${info.ct}" url="${info.url}")`);
        }
      } catch (_) {}
    };
    const _onWebSocket = () => { _streamingSeen = true; };
    // Page-level listeners (existing)
    page.on('response', _onResponse);
    page.on('requestfinished', _onRequestFinished);
    page.on('websocket', _onWebSocket);
    // Context-level listeners (new — catches events that page-level misses)
    const _ctx = engine.getContext(sessionId);
    if (_ctx) {
      _ctx.on('response', _onResponse);
      _ctx.on('requestfinished', _onRequestFinished);
    }
    _streamingCleanup = () => {
      page.removeListener('response', _onResponse);
      page.removeListener('requestfinished', _onRequestFinished);
      page.removeListener('websocket', _onWebSocket);
      if (_ctx) {
        try { _ctx.removeListener('response', _onResponse); } catch (_) {}
        try { _ctx.removeListener('requestfinished', _onRequestFinished); } catch (_) {}
      }
    };
    // Expose _sseRequestFinished via closure — _captureStreamingResponse reads it
    _streamingCleanup._sseRequestFinished = () => _sseRequestFinished;
    logger.info(`[playwright.agent] field map: Enter-submit detected (pressAfter=Enter, no submitSelectors) — listeners armed (page+context) for streaming detection (preSubmitUrl=${_preSubmitUrl})`);
  }

  // Phase 1: Fill each field — placeholder first, CSS selector fallback, role+position fallback
  for (const field of fieldMap.fields) {
    // Guard: if the extracted value looks like the entire goal string (not actual
    // content to type), prefer field.text (which the field-map-gen LLM picked).
    // This happens when the goal is a task description ("select a verse and post it")
    // rather than the content itself ("post 'John 3:16'"). The field extraction LLM
    // extracts the entire goal as "body" because it has "no clear field mapping".
    let _useFieldText = false;
    if (field.text && fieldValues[field.name]) {
      const _extracted = String(fieldValues[field.name]);
      const _isGoalLike = _extracted.length > 200 ||
        /\b(IMPORTANT:|Task:|browser session|you are working on|If the page ever shows)\b/i.test(_extracted);
      if (_isGoalLike) {
        logger.warn(`[playwright.agent] field map: extracted value for "${field.name}" looks like goal string (${_extracted.length} chars) — preferring field.text`);
        _useFieldText = true;
      }
    }
    let value = _useFieldText ? field.text : (fieldValues[field.name] || field.text);
    // Fallback: cached field name may not match the extraction (e.g. cache has
    // "prompt" but extraction returns "body"). When there's exactly one field in
    // the map and exactly one extracted value, use it regardless of name mismatch.
    // This is the common case for AI chat prompts (single field, single value).
    if (!value && fieldMap.fields.length === 1 && fieldValues && Object.keys(fieldValues).length > 0) {
      value = Object.values(fieldValues)[0];
    }
    if (!value) {
      logger.info(`[playwright.agent] field map: skipping field "${field.name}" — no value`);
      continue;
    }

    let filled = false;

    // ── Primary: Placeholder + position path (incl. pseudo-placeholder) ──
    // Fix 30b: Also fire when pseudo-placeholder signals are present (value === aria-label,
    // value matches default pattern, CSS ::before content, blank class). Google Docs title
    // input uses value="Untitled document" + aria-label="Untitled document" — no placeholder attr.
    const _hasPseudoPlaceholder = !!(
      (field.value && field.value.length > 0 && field.value === field.ariaLabel) ||
      (field.value && /^(untitled|new|empty|add|enter|placeholder|click to|type to|start (typing|writing))/i.test(field.value)) ||
      (field.cssBeforeContent && field.cssBeforeContent.length > 0) ||
      (field.hasBlankClass)
    );
    if ((field.placeholder && field.placeholder.length > 0) || _hasPseudoPlaceholder) {
      const _placeholderText = field.placeholder || field.value || field.cssBeforeContent || '';
      const _found = await page.evaluate((fieldInfo) => {
        const _placeholder = fieldInfo.placeholder || fieldInfo.value || fieldInfo.cssBeforeContent || '';
        const _isTitle = fieldInfo.role === 'title' || fieldInfo.name === 'title';
        const _hasPseudo = !fieldInfo.placeholder && !!(
          (fieldInfo.value && fieldInfo.value === fieldInfo.ariaLabel) ||
          (fieldInfo.value && /^(untitled|new|empty|add|enter|placeholder|click to|type to|start (typing|writing))/i.test(fieldInfo.value)) ||
          (fieldInfo.cssBeforeContent && fieldInfo.cssBeforeContent.length > 0) ||
          (fieldInfo.hasBlankClass)
        );
        const _candidates = Array.from(document.querySelectorAll(
          '[contenteditable="true"], [role="textbox"], input[type="text"], input:not([type]), textarea'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // Standard placeholder match
          const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '';
          if (ph && ph.toLowerCase().includes(_placeholder.toLowerCase())) return true;
          // Pseudo-placeholder: value matches aria-label or data-tooltip (Google Docs pattern)
          if (_hasPseudo) {
            const val = (el.value || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            const tooltip = el.getAttribute('data-tooltip') || '';
            if (val && val.toLowerCase().includes(_placeholder.toLowerCase())) return true;
            if (val && aria && val === aria) return true;
            if (val && tooltip && val === tooltip) return true;
            // CSS ::before content on empty contenteditable
            if (fieldInfo.cssBeforeContent) {
              try {
                const c = getComputedStyle(el, '::before').content;
                const beforeText = (c && c !== 'none' && c !== 'normal') ? c.replace(/^["']|["']$/g, '') : '';
                if (beforeText && beforeText.toLowerCase().includes(_placeholder.toLowerCase())) return true;
              } catch {}
            }
            // Blank class
            if (fieldInfo.hasBlankClass && /placeholder|blank|empty|watermark/i.test(el.className || '')) return true;
          }
          return false;
        });
        if (_candidates.length === 0) return null;
        const _sorted = _candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          return _isTitle ? ra.top - rb.top : (rb.width * rb.height) - (ra.width * ra.height);
        });
        const el = _sorted[0];
        el.focus(); // JS focus — bypasses overlays
        return { found: true, tag: el.tagName.toLowerCase(), placeholder: el.getAttribute('placeholder') || el.value || '', method: _hasPseudo ? 'pseudo-placeholder' : 'placeholder' };
      }, field).catch(() => null);

      if (_found?.found) {
        logger.info(`[playwright.agent] field map: field "${field.name}" found by ${_found.method}="${_placeholderText}" tag=${_found.tag} — typing "${value}"`);
        // Type — the type action's built-in snapshot comparison handles verification
        const _typeRes = await browserAct({ action: 'type', text: value, sessionId, headed: true, timeoutMs: 10000 });
        transcript.push({ action: { type: value }, outcome: { ok: _typeRes.ok, verified: _typeRes.verified, field: field.name, method: _found.method } });
        if (_typeRes.ok) {
          filled = true;
          if (field.pressAfter) {
            await browserAct({ action: 'press', key: field.pressAfter, sessionId, headed: true, timeoutMs: 5000 });
          }
        } else {
          logger.warn(`[playwright.agent] field map: field "${field.name}" ${_found.method} type failed: ${_typeRes.error}`);
        }
      }
    }

    // ── Fallback: CSS selector path (existing logic) ──
    if (!filled && field.selectors && field.selectors.length > 0) {
      for (const sel of field.selectors) {
        try {
          await page.click(sel, { timeout: fieldTimeout });
          const isChip = field.type === 'chip';
          if (isChip) {
            await page.keyboard.type(value, { timeout: fieldTimeout });
            await page.keyboard.press('Enter');
          } else if (field.type === 'contenteditable') {
            await page.keyboard.press('Meta+a');
            await page.keyboard.type(value, { timeout: fieldTimeout });
          } else {
            await page.keyboard.press('Meta+a');
            await page.keyboard.type(value, { timeout: fieldTimeout });
          }
          filled = true;
          logger.info(`[playwright.agent] field map: typed "${value}" (field="${field.name}") via CSS selector "${sel}"`);
          transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: sel, method: 'css' } });
          // Post-interaction verification (CSS selector check)
          if (field.verifySelector) {
            await new Promise(r => setTimeout(r, 300));
            const verifyResult = await _verifyField(page, field, value);
            if (!verifyResult.ok) {
              logger.warn(`[playwright.agent] field map: field "${field.name}" CSS verification failed: ${verifyResult.reason}`);
              filled = false;
              transcript.push({ action: { verify: field.name }, outcome: { ok: false, reason: verifyResult.reason } });
              continue; // try next selector
            }
            logger.info(`[playwright.agent] field map: field "${field.name}" verified — ${verifyResult.reason}`);
            transcript.push({ action: { verify: field.name }, outcome: { ok: true, reason: verifyResult.reason } });
          }
          if (filled && field.pressAfter) {
            await page.keyboard.press(field.pressAfter);
          }
          break;
        } catch (typeErr) {
          // JS focus + native setter fallback — bypasses hidden elements and overlays
          // (e.g. Google Docs title input when header collapsed). Runs in a SINGLE
          // atomic page.evaluate: find, focus, set value, dispatch events. Previously
          // these were two separate evaluates — the element could be re-rendered
          // between them (Google Docs re-renders on focus), causing the second
          // querySelector to return null or a different element.
          const _setResult = await page.evaluate((selector, text) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            el.focus(); // JS focus first — works even when hidden/covered by overlay
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value');
              if (setter && setter.set) { setter.set.call(el, text); } else { el.value = text; }
            } else if (el.isContentEditable) {
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('insertText', false, text);
            } else { return null; }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { value: el.value || el.textContent || '', tag: el.tagName.toLowerCase() };
          }, sel, value).catch(() => null);
          if (_setResult?.value?.includes(value)) {
            filled = true;
            logger.info(`[playwright.agent] field map: field "${field.name}" filled via JS focus + native setter on "${sel}" (page.click failed: ${typeErr.message}, verified: "${_setResult.value.slice(0, 50)}")`);
            transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: sel, method: 'css-jsfocus-native-setter', verified: true } });
            if (field.verifySelector) {
              await new Promise(r => setTimeout(r, 300));
              const verifyResult = await _verifyField(page, field, value);
              if (!verifyResult.ok) {
                logger.warn(`[playwright.agent] field map: field "${field.name}" JS-focus verification failed: ${verifyResult.reason}`);
                filled = false;
                transcript.push({ action: { verify: field.name }, outcome: { ok: false, reason: verifyResult.reason } });
                continue;
              }
              logger.info(`[playwright.agent] field map: field "${field.name}" JS-focus verified — ${verifyResult.reason}`);
              transcript.push({ action: { verify: field.name }, outcome: { ok: true, reason: verifyResult.reason } });
            }
            if (filled && field.pressAfter) {
              await page.keyboard.press(field.pressAfter);
            }
            break;
          } else {
            logger.warn(`[playwright.agent] field map: field "${field.name}" JS focus + native setter failed on "${sel}" (page.click failed: ${typeErr.message}, value="${_setResult?.value?.slice(0, 50) || 'null'}" expected to contain "${value.slice(0, 50)}")`);
            // Fall through to try next selector
          }
        }
      }
    }

    // ── Fallback: role + position (no placeholder, no selector) ──
    if (!filled && field.role && _hasEditableFields) {
      const _found = await page.evaluate((fieldInfo) => {
        const _isTitle = fieldInfo.role === 'title';
        const _isBody = fieldInfo.role === 'body';
        const _candidates = Array.from(document.querySelectorAll(
          '[contenteditable="true"], [role="textbox"], textarea, input[type="text"], input:not([type])'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          // For title fields: only match elements with title-specific attributes.
          // This excludes generic contenteditable/textbox elements like Google Docs'
          // Gemini "Write a document about..." field, which has role="textbox" but
          // no title-specific attributes (no aria-label with "Untitled"/"title",
          // no class with "title-input").
          if (_isTitle) {
            const attrs = [
              el.getAttribute('aria-label'),
              el.getAttribute('placeholder'),
              el.getAttribute('name'),
              el.getAttribute('id'),
              (el.className || '').toString(),
            ].filter(Boolean).join(' ').toLowerCase();
            return /title|name|subject|rename|document|untitled|title-input|docs-title/i.test(attrs);
          }
          return true;
        });
        if (_candidates.length === 0) return null;
        const _sorted = _candidates.sort((a, b) => {
          const ra = a.getBoundingClientRect();
          const rb = b.getBoundingClientRect();
          if (_isTitle) return ra.top - rb.top;
          if (_isBody) return (rb.width * rb.height) - (ra.width * ra.height);
          return 0;
        });
        const el = _sorted[0];
        el.focus();
        return { found: true, tag: el.tagName.toLowerCase() };
      }, field).catch(() => null);

      if (_found?.found) {
        logger.info(`[playwright.agent] field map: field "${field.name}" found by role="${field.role}" tag=${_found.tag}`);
        const _typeRes = await browserAct({ action: 'type', text: value, sessionId, headed: true, timeoutMs: 10000 });
        if (_typeRes.ok) {
          filled = true;
          transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, method: 'role+position' } });
          if (field.pressAfter) {
            await browserAct({ action: 'press', key: field.pressAfter, sessionId, headed: true, timeoutMs: 5000 });
          }
        }
      }
    }

    if (!filled) {
      const _hostname = options.hostname;
      const _goal = options.goal;

      // ── Phase 0: Check existing app-knowledge entries (ui_mode, recovery_move)
      // BEFORE triggering JIT research. The fix may already be cached from a
      // prior run or from upfront web research. Try entries in priority order:
      // ui_mode first (addresses root cause — e.g. toggle compact mode), then
      // recovery_move (workaround — e.g. File > Rename). Try multiple entries
      // if the first doesn't work.
      if (_hostname) {
        try {
          const { loadAppKnowledge } = require('./lib/appKnowledge.cjs');
          // Check BOTH disk AND in-memory entries (passed from browser.agent.cjs).
          // In-memory entries are from the same run's upfront research — they may
          // not be on disk yet if caching failed or is stale. Dedup by ID.
          const _diskEntries = loadAppKnowledge(_hostname).filter(e =>
            (e.type === 'ui_mode' || e.type === 'recovery_move') && (e.confidence || 0) >= 0.5
          );
          const _memEntries = (options.appKnowledgeEntries || []).filter(e =>
            (e.type === 'ui_mode' || e.type === 'recovery_move') && (e.confidence || 0) >= 0.5
          );
          const _existingEntries = [..._diskEntries];
          for (const _mem of _memEntries) {
            if (!_existingEntries.some(e => e.id === _mem.id)) _existingEntries.push(_mem);
          }
          // Sort: ui_mode first (root cause), then recovery_move (workaround)
          _existingEntries.sort((a, b) => {
            const _order = { ui_mode: 0, recovery_move: 1 };
            return (_order[a.type] ?? 9) - (_order[b.type] ?? 9);
          });

          for (const _entry of _existingEntries) {
            logger.info(`[playwright.agent] field map: trying existing app-knowledge [${_entry.type}] for "${field.name}": ${_entry.summary}`);
            const _applied = await _applyAppKnowledgeEntry(_entry, page, browserAct, sessionId);
            if (!_applied) {
              logger.info(`[playwright.agent] field map: app-knowledge [${_entry.type}] couldn't be applied — trying next entry`);
              continue;
            }
            // Retry the normal fill path (element may now be visible/revealed)
            const _retryResult = await _retryFieldFill(page, field, value, browserAct, sessionId, fieldTimeout, transcript);
            if (_retryResult.filled) {
              filled = true;
              logger.info(`[playwright.agent] field map: existing app-knowledge [${_entry.type}] resolved "${field.name}" via ${_retryResult.method} — ${_entry.summary}`);
              transcript.push({ action: { app_knowledge: _entry.type }, outcome: { ok: true, field: field.name, entry: _entry.id, method: _retryResult.method } });
              break;
            }
            logger.info(`[playwright.agent] field map: app-knowledge [${_entry.type}] applied but didn't resolve "${field.name}" — trying next entry`);
          }
        } catch (_akErr) {
          logger.warn(`[playwright.agent] field map: app-knowledge check failed (non-fatal): ${_akErr.message}`);
        }
      }

      // ── Phase 1: JIT research — only if no existing app-knowledge entries worked
      // Skip JIT research when the page has contenteditable elements — JIT research
      // searches the web for CSS selectors, but custom elements (e.g. Reddit's
      // <post-composer-title>) don't have standard CSS selectors. Tier 2.5's keyboard
      // approach (type into focused element) is more reliable for contenteditable.
      if (!filled && _hostname && _justInTimeResearch) {
        const _hasContentEditable = await page.evaluate(() =>
          document.querySelector('[contenteditable="true"], [contenteditable="plaintext-only"]') !== null
        ).catch(() => false);
        if (_hasContentEditable) {
          logger.info(`[playwright.agent] field map: field "${field.name}" not found via CSS, but page has contenteditable — skipping JIT research, falling through to Tier 2.5`);
          continue;
        }
        logger.info(`[playwright.agent] field map: field "${field.name}" not found — triggering JIT research on ${_hostname}`);
        const _jitFix = await _justInTimeResearch({
          hostname: _hostname,
          field: field.name,
          goal: _goal,
          failureContext: `All fill methods failed (placeholder, CSS selector, role+position). The field may be hidden, collapsed, or require a specific action to reveal.`,
          sessionId,
        }).catch((_err) => { logger.warn(`[playwright.agent] JIT research error (non-fatal): ${_err.message}`); return null; });

        if (_jitFix) {
          transcript.push({ action: { jit_research: _jitFix.action }, outcome: { ok: true, field: field.name, fix: _jitFix.action } });

          // Apply the fix based on its type
          try {
            // Shortcut: press a keyboard shortcut to toggle UI mode / reveal field
            if (_jitFix.shortcut) {
              logger.info(`[playwright.agent] field map: applying JIT fix — press ${_jitFix.shortcut}`);
              await browserAct({ action: 'press', key: _jitFix.shortcut, sessionId, headed: true, timeoutMs: 5000 });
              await new Promise(r => setTimeout(r, 500)); // wait for UI to update
            }
            // Menu path: click through menu items (e.g. "File > Rename")
            if (_jitFix.menuPath) {
              const _menuItems = _jitFix.menuPath.split(/[>›\u203a]/).map(s => s.trim()).filter(Boolean);
              logger.info(`[playwright.agent] field map: applying JIT fix — click menu ${_jitFix.menuPath}`);
              for (const _menuItem of _menuItems) {
                await page.evaluate((label) => {
                  const _els = Array.from(document.querySelectorAll('div[role="menuitem"], span, a, button'));
                  const _match = _els.find(el => (el.textContent || '').trim().toLowerCase() === label.toLowerCase());
                  if (_match) { _match.click(); return true; }
                  const _partial = _els.find(el => {
                    const t = (el.textContent || '').trim().toLowerCase();
                    return t.includes(label.toLowerCase()) && t.length < label.length + 20;
                  });
                  if (_partial) { _partial.click(); return true; }
                  return false;
                }, _menuItem).catch(() => false);
                await new Promise(r => setTimeout(r, 300));
              }
              await new Promise(r => setTimeout(r, 500));

              // Fix 18: After menuPath (e.g. File > Rename), use native setter on
              // document.activeElement (the now-focused rename dialog input) and
              // press Enter to commit. keyboard.type() would route to the wrong
              // element, and Ctrl+Enter doesn't commit the rename dialog.
              const _activeSet = await page.evaluate((text) => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                  const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (setter && setter.set) { setter.set.call(el, text); } else { el.value = text; }
                } else if (el.isContentEditable) {
                  el.focus();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('insertText', false, text);
                } else { return null; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { value: el.value || el.textContent || '', tag: el.tagName.toLowerCase() };
              }, value).catch(() => null);
              if (_activeSet?.value?.includes(value)) {
                await page.keyboard.press('Enter'); // commit (NOT Ctrl+Enter)
                await new Promise(r => setTimeout(r, 500)); // wait for dialog to close
                filled = true;
                logger.info(`[playwright.agent] field map: JIT menuPath fix — set value via activeElement + Enter commit (verified: "${_activeSet.value.slice(0, 50)}")`);
                transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, method: 'jit-menupath-activeelement', verified: true } });
              } else {
                logger.warn(`[playwright.agent] field map: JIT menuPath fix — activeElement set failed (value="${_activeSet?.value?.slice(0, 50) || 'null'}")`);
              }
            }
            // Selector: use native setter on the revealed selector
            if (!filled && _jitFix.selector) {
              logger.info(`[playwright.agent] field map: applying JIT fix — native setter on ${_jitFix.selector}`);
              const _setResult = await page.evaluate((selector, text) => {
                const el = document.querySelector(selector);
                if (!el) return null;
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                  const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                  if (setter && setter.set) { setter.set.call(el, text); } else { el.value = text; }
                } else if (el.isContentEditable) {
                  el.focus();
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const sel = window.getSelection();
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('insertText', false, text);
                } else { return null; }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { value: el.value || el.textContent || '', tag: el.tagName.toLowerCase() };
              }, _jitFix.selector, value).catch(() => null);
              if (_setResult?.value?.includes(value)) {
                filled = true;
                transcript.push({ action: { type: value }, outcome: { ok: true, field: field.name, selector: _jitFix.selector, method: 'jit-research-native-setter', verified: true } });
                if (field.pressAfter) { await page.keyboard.press(field.pressAfter); }
              }
            }
            // If still not filled, retry all methods after applying shortcut/menu
            // (Fix 17: with verification — don't set filled=true without checking value)
            if (!filled && (_jitFix.shortcut || _jitFix.menuPath)) {
              const _retryResult = await _retryFieldFill(page, field, value, browserAct, sessionId, fieldTimeout, transcript);
              if (_retryResult.filled) {
                filled = true;
                logger.info(`[playwright.agent] field map: JIT fix retry succeeded via ${_retryResult.method}`);
              }
            }
          } catch (_applyErr) {
            logger.warn(`[playwright.agent] field map: JIT fix application failed (non-fatal): ${_applyErr.message}`);
          }
        }
      }

      if (!filled) {
        transcript.push({ action: { type: value }, outcome: { ok: false, field: field.name, error: 'all methods failed (including JIT research)' } });
        return { ok: false, error: `field "${field.name}" could not be filled`, transcript, failedField: field.name };
      }
    }
  }

  // Phase 2: Submit (only if NOT autoSave)
  if (fieldMap.autoSave) {
    if (!_hasEnterSubmit) {
      // True autoSave (Notion, Google Docs) — no Enter submit, no response to wait for
      logger.info(`[playwright.agent] field map: autoSave=true — skipping submit phase`);
      return { ok: true, transcript, result: 'Completed via field map (auto-save)' };
    }

    // Enter was the submit — check for streaming response (AI chat, search, etc.)
    logger.info(`[playwright.agent] field map: autoSave=true but Enter-submit detected — checking for streaming response`);
    // Re-baseline AFTER submit — a pre-submit baseline is defeated by the page transition
    // (ChatGPT navigates / → /c/<id>, innerText shrinks then grows).
    await new Promise(r => setTimeout(r, 500));
    const _postSubmitBaseline = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
    const _text = await _captureStreamingResponse(sessionId, page, _postSubmitBaseline, _preSubmitUrl, _streamingSeen, _streamingCleanup, timeoutMs);
    if (_text) return { ok: true, transcript, result: _text };

    // No streaming detected — true autoSave or response already complete
    logger.info(`[playwright.agent] field map: no streaming detected — treating as true autoSave`);
    return { ok: true, transcript, result: 'Completed via field map (auto-save)' };
  }

  let submitted = false;
  for (const sel of (fieldMap.submitSelectors || [])) {
    try {
      await page.click(sel, { timeout: fieldTimeout });
      submitted = true;
      logger.info(`[playwright.agent] field map: submit clicked via "${sel}"`);
      transcript.push({ action: { click: sel }, outcome: { ok: true, intent: 'submit' } });
      break;
    } catch (clickErr) {
      logger.warn(`[playwright.agent] field map: submit selector "${sel}" failed: ${clickErr.message}`);
    }
  }

  if (!submitted) {
    try {
      await page.keyboard.press('Control+Enter');
      submitted = true;
      logger.info(`[playwright.agent] field map: submit via Ctrl+Enter`);
      transcript.push({ action: { press: 'Control+Enter' }, outcome: { ok: true, intent: 'submit' } });
    } catch (_) {}
  }

  if (!submitted) {
    return { ok: false, error: 'could not click any submit selector', transcript };
  }

  // Phase 3: Verify submit success (if configured)
  if (fieldMap.submitVerify) {
    const sv = fieldMap.submitVerify;
    await new Promise(r => setTimeout(r, 1000));
    if (sv.type === 'compose_gone') {
      const composeGone = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        return !modal || modal.offsetParent === null;
      });
      if (composeGone) {
        logger.info(`[playwright.agent] field map: submit verified — compose dialog gone`);
        return { ok: true, transcript, result: 'Submitted (compose gone)' };
      }
      return { ok: false, error: 'compose dialog still visible after submit', transcript };
    }
    if (sv.type === 'url_change') {
      const newUrl = await page.evaluate(() => location.href);
      // Compare to the URL captured before submit — use page.url() as baseline
      const preSubmitUrl = page.url();
      if (newUrl !== preSubmitUrl) {
        logger.info(`[playwright.agent] field map: submit verified — URL changed`);
        return { ok: true, transcript, result: 'Submitted (URL changed)' };
      }
    }
  }

  // Phase 4: AI chat streaming detection (if Enter was the submit mechanism)
  // For non-autoSave maps with pressAfter=Enter + no submitSelectors (AI chat pages),
  // the response streams after Enter. Wait for it to settle, then extract page text.
  if (_hasEnterSubmit) {
    logger.info(`[playwright.agent] field map: Enter-submit detected post-submit — checking for streaming response`);
    // Re-baseline AFTER submit — a pre-submit baseline is defeated by the page transition
    // (ChatGPT navigates / → /c/<id>, innerText shrinks then grows).
    await new Promise(r => setTimeout(r, 500));
    const _postSubmitBaseline = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
    const _text = await _captureStreamingResponse(sessionId, page, _postSubmitBaseline, _preSubmitUrl, _streamingSeen, _streamingCleanup, timeoutMs);
    if (_text) return { ok: true, transcript, result: _text };
    logger.info(`[playwright.agent] field map: no streaming detected post-submit`);
  }

  logger.info(`[playwright.agent] field map: no submit verification configured — assuming success`);
  return { ok: true, transcript, result: 'Submitted (no verification configured)' };
}

// Conservative multi-step detector — only triggers on explicit loop constructs.
// This is the FAST pre-check: skips the LLM field-map call entirely for obvious
// multi-step goals. The LLM field-map itself has a secondary multiStep flag (below)
// for subtler cases. "for each"/"for every" has near-zero false-positive risk
// because single-action goals never use loop language.
function _isMultiStepGoal(goal) {
  if (!goal || typeof goal !== 'string') return false;
  return /\bfor each\b|\bfor every\b|\bfor all of\b/i.test(goal);
}

// Main Tier 1.5 entry point: try cached map, or generate + cache new one
// Extended: handles both form URLs (CSS selector path) AND editable pages
// (placeholder + position path). options.hasEditableFields enables the extended path.
async function _deterministicSelectorPath(sessionId, url, goal, hostname, timeoutMs, options = {}) {
  const _isFormUrl = isFormUrl(url);
  const _hasEditableFields = !!options.hasEditableFields;
  if (!_isFormUrl && !_hasEditableFields) return null;

  const pagePattern = derivePagePattern(url);
  logger.info(`[playwright.agent] Tier 1.5: checking field map for ${hostname}:${pagePattern} (formUrl=${_isFormUrl}, editable=${_hasEditableFields})`);

  // Try cached map first
  let fieldMap = await getSelectorMap(hostname, pagePattern);

  if (!fieldMap) {
    logger.info(`[playwright.agent] Tier 1.5: no cached map — generating via LLM`);
    const generated = await _generateFieldMap(sessionId, hostname, goal, timeoutMs, { hasEditableFields: _hasEditableFields, agentContext: options.agentContext });
    if (!generated) return null; // fall through to Tier 2/3
    if (generated.multiStep === true) return null; // LLM says multi-step — fall through to Tier 2/3
    fieldMap = generated;
    // Cache it
    await saveSelectorMap(hostname, pagePattern, generated);
  }

  // Extract field values from goal. Use regex-based extraction (deterministic)
  // as the FIRST pass — it correctly extracts { title: "Q7 Planning Notes" } from
  // "titled 'Q7 Planning Notes'". Then use LLM-based extraction as a SUPPLEMENT
  // (may find additional fields the regex misses). Regex takes precedence on
  // conflicts (more reliable for title extraction — LLM sometimes returns
  // "subject" instead of "title", causing key mismatch with the field map).
  const _regexParams = extractParamsFromGoal(goal);
  const _llmValues = await _extractFieldValues(goal);
  const fieldValues = { ...(_llmValues || {}), ...(_regexParams || {}) };
  if (!fieldValues || Object.keys(fieldValues).length === 0) {
    // For editable pages, values may be embedded in the field map (field.text)
    if (!_hasEditableFields || !fieldMap.fields || !fieldMap.fields.some(f => f.text)) {
      logger.warn(`[playwright.agent] Tier 1.5: could not extract field values from goal — falling back`);
      return null;
    }
    logger.info(`[playwright.agent] Tier 1.5: using embedded field values from map (editable page)`);
  }

  // Execute: type → verify → submit → verify (or skip submit for autoSave pages)
  const result = await _executeFieldMap(sessionId, fieldValues || {}, fieldMap, timeoutMs, { hasEditableFields: _hasEditableFields, hostname, goal, agentContext: options.agentContext, appKnowledgeEntries: options.appKnowledgeEntries });

  if (result.ok) {
    await incrementSelectorMapSuccess(hostname, pagePattern);
    return {
      ok: true,
      goal,
      sessionId,
      turns: result.transcript.length,
      done: true,
      result: result.result || 'Completed via field map',
      transcript: result.transcript,
      routingDecision: _hasEditableFields ? 'tier1_5_field_map' : 'tier1_5_selector_map',
      executionTime: 0, // set by caller
    };
  }

  // Failure — increment failure count and fall through
  await incrementSelectorMapFailure(hostname, pagePattern);
  logger.warn(`[playwright.agent] Tier 1.5: field map failed: ${result.error} — falling back to Tier 2/3`);

  // If the map was cached and failed, try regenerating once
  if (fieldMap.status === 'healthy' && fieldMap.failure_count === undefined) {
    logger.info(`[playwright.agent] Tier 1.5: attempting one-shot regeneration`);
    const regenerated = await _generateFieldMap(sessionId, hostname, goal, timeoutMs, { hasEditableFields: _hasEditableFields, agentContext: options.agentContext });
    if (regenerated) {
      await saveSelectorMap(hostname, pagePattern, regenerated);
      const retryResult = await _executeFieldMap(sessionId, fieldValues || {}, regenerated, timeoutMs, { hasEditableFields: _hasEditableFields, hostname, goal, agentContext: options.agentContext, appKnowledgeEntries: options.appKnowledgeEntries });
      if (retryResult.ok) {
        await incrementSelectorMapSuccess(hostname, pagePattern);
        return {
          ok: true,
          goal,
          sessionId,
          turns: retryResult.transcript.length,
          done: true,
          result: retryResult.result || 'Completed via regenerated field map',
          transcript: retryResult.transcript,
          routingDecision: _hasEditableFields ? 'tier1_5_field_map_regen' : 'tier1_5_selector_map_regen',
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

// ── Just-in-Time App-Knowledge Research ─────────────────────────────────────
// When the agent can't find/fill a field or is stuck in a loop, do targeted web
// research: "I can't find field 'title' on docs.google.com — how do I locate it?"
// Search → crawl top result → LLM extracts actionable fix → return fix + cache it.
// This is failure-driven learning — targeted, contextual, and always relevant.
// Cached as `recovery_move` in app-knowledge (confidence 0.8 — higher than generic
// research because it's specific to our problem).

// Module-level flag — set to true when JIT research is attempted during a run.
// Reset at the start of each playwrightAgent run. Included in ask_user message
// so the user knows web research was already tried.
let _jitResearchAttemptedFlag = false;

async function _justInTimeResearch({ hostname, field, elementType, goal, failureContext, sessionId, headed }) {
  if (!hostname || !field) return null;
  _jitResearchAttemptedFlag = true; // track for ask_user enrichment
  const _appName = hostname.replace(/^www\./, '').split('.')[0];
  const _logTag = '[playwright.agent] JIT research';
  const _type = elementType || 'field';

  // Element-type-specific nouns and verbs for queries
  const _typeNoun = {
    field: 'field', button: 'button', dropdown: 'dropdown',
    menu: 'menu', toggle: 'toggle', element: 'element',
  }[_type] || 'element';
  const _typeVerb = {
    field: 'fill', button: 'click', dropdown: 'open',
    menu: 'open', toggle: 'toggle', element: 'interact with',
  }[_type] || 'interact with';

  // Extract action phrase from goal for HOW-TO queries.
  // Strip the "IMPORTANT: You are working on ... Task:" wrapper that browser.agent.cjs
  // adds (line 5178) — otherwise the extraction picks up "important you are working
  // https docs google com" instead of the actual task.
  // e.g. "IMPORTANT: You are working on https://docs.google.com/...\n\nTask: Create a Google Doc titled 'Q7 Planning Notes'"
  //    → "create a google doc titled"
  const _taskPart = (goal || '').replace(/^IMPORTANT:.*?Task:\s*/si, '').trim();
  const _goalAction = _taskPart.toLowerCase()
    .replace(/['"]/g, '').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2).slice(0, 8).join(' ');
  const _goalActionShort = _goalAction.split(' ').slice(0, 4).join(' ');

  // Multi-angle queries — each angle surfaces different kinds of help articles.
  // Framing: the failure is always a VISIBILITY problem (element is hidden), not an
  // INTERACTION problem (can't type). So queries focus on "why is it hidden / how to
  // reveal" instead of "how to fill" — the latter surfaces workaround articles
  // (e.g. "File > Rename") instead of root-cause articles (e.g. "Ctrl+Shift+F to
  // toggle compact mode").
  const _queries = [
    // HOW-TO: re-framed as visibility, not interaction
    `${_appName} ${field} ${_typeNoun} hidden why`,
    `${_appName} compact mode hidden UI toolbar`,
    // HAVING-ISSUE: keep existing good angles
    `having issues ${_type === 'field' ? 'finding' : _typeVerb + 'ing'} ${field} on ${_appName}`,
    `${_appName} ${field} ${_typeNoun} hidden missing not visible`,
    // FINDING: re-framed as "how to show", not "where is it"
    `${_appName} ${field} ${_typeNoun} collapsed not visible how to show`,
    `${_appName} ${field} ${_typeNoun} not showing how to reveal`,
    // SHORTCUT: re-framed to mention field + visibility, not vague action
    `${_appName} keyboard shortcut show ${field} ${_typeNoun} reveal toggle`,
  ];

  logger.info(`${_logTag}: triggered for ${_type}="${field}" on ${hostname} — ${_queries.length} queries (${_queries.length} angles, parallel search)`);

  // Lazy-load dependencies (avoid circular require issues)
  let searchWeb, webCrawl, ask;
  try {
    ({ searchWeb } = require('./web.agent.cjs'));
    ({ webCrawl } = require('./web.crawl.cjs'));
    ({ ask } = require('../skill-helpers/skill-llm.cjs'));
  } catch (_reqErr) {
    logger.warn(`${_logTag}: dependency load failed: ${_reqErr.message}`);
    return null;
  }

  if (!searchWeb || !webCrawl || !ask) {
    logger.warn(`${_logTag}: dependencies not available`);
    return null;
  }

  // Phase 1: Run all searches in parallel (~5-10s instead of ~20-40s sequential)
  const _searchPromises = _queries.map(q =>
    searchWeb(q, 3).catch(() => null)
  );
  const _searchResults = await Promise.all(_searchPromises);

  // Phase 2: Process each query's results sequentially (crawl top 2, LLM extract, stop at first fix)
  for (let _qi = 0; _qi < _queries.length; _qi++) {
    const _results = _searchResults[_qi];
    if (!_results?.ok || !Array.isArray(_results.results) || _results.results.length === 0) continue;

    for (const _result of _results.results.slice(0, 2)) {
      let _crawl;
      try {
        _crawl = await webCrawl({ url: _result.url, maxChars: 4000, timeoutMs: 15000 });
      } catch (_) { continue; }
      if (!_crawl?.ok || !_crawl.content || _crawl.content.length < 100) continue;

      // LLM extract: "Given this help article, how do I find/show the {field} {type}?"
      const _extractPrompt = `The agent is trying to ${_typeVerb} the "${field}" ${_typeNoun} on ${hostname} but cannot locate it (it may be hidden, collapsed, or require a specific action to reveal).

Context: ${failureContext || `All methods failed. The ${_typeNoun} may be hidden, collapsed, or require a specific action to reveal.`}

Help article content (from ${_result.url}):
${_crawl.content.slice(0, 3000)}

Extract the SPECIFIC action needed to find/show/access/${_typeVerb} the "${field}" ${_typeNoun} in ${hostname}. Return ONLY a JSON object:
{
  "action": "the specific action to take (e.g. 'click View menu > Show header' or 'press Ctrl+Shift+F1' or 'use JS focus on selector input.docs-title-input — it is hidden but focusable')",
  "selector": "CSS selector if mentioned, or null",
  "shortcut": "keyboard shortcut if mentioned, or null",
  "menuPath": "menu path if mentioned (e.g. 'View > Show header & footer'), or null",
  "reasoning": "one sentence explanation"
}
Return {} if no actionable answer found.`;

      let _raw;
      try {
        _raw = await ask(_extractPrompt, { maxTokens: 300, temperature: 0, responseTimeoutMs: 15000 });
      } catch (_) { continue; }
      if (!_raw) continue;

      const _jsonMatch = _raw.match(/\{[\s\S]*\}/);
      if (!_jsonMatch) continue;

      let _fix;
      try { _fix = JSON.parse(_jsonMatch[0]); } catch (_) { continue; }
      if (!_fix || !_fix.action) continue;

      // Cache as recovery_move in app-knowledge
      try {
        const { saveAppKnowledge, loadAppKnowledge } = require('./lib/appKnowledge.cjs');
        const _entry = {
          id: `${_appName}.recovery_move.cant-find-${field}`,
          type: 'recovery_move',
          summary: `When "${field}" ${_typeNoun} is not found: ${_fix.action}`,
          details: {
            field,
            elementType: _type,
            action: _fix.action,
            selector: _fix.selector || null,
            shortcut: _fix.shortcut || null,
            menuPath: _fix.menuPath || null,
            sourceUrl: _result.url,
          },
          source: 'jit_research',
          confidence: 0.8,
        };
        const _existing = loadAppKnowledge(hostname);
        saveAppKnowledge(hostname, [..._existing.filter(e => e.id !== _entry.id), _entry]);
        logger.info(`${_logTag}: found + cached fix for "${field}" (${_type}) on ${hostname}: ${_fix.action}`);
      } catch (_cacheErr) {
        logger.warn(`${_logTag}: cache failed (non-fatal): ${_cacheErr.message}`);
      }

      return _fix; // STOP at first actionable fix
    }
  }

  logger.info(`${_logTag}: no actionable fix found for ${_type}="${field}" on ${hostname} (all ${_queries.length} angles exhausted)`);
  return null;
}

// ---------------------------------------------------------------------------
// Task-level discovery: when the turn-loop exhausts on a complex UI site,
// search the web for how-to articles about the overall goal, crawl top
// results, and LLM-extract a step-by-step procedure. Mirrors what a human
// would do (e.g. "in spotify how do i add music to my playlist"). The
// procedure is injected into a second turn-loop attempt and cached as
// app-knowledge (type: task_procedure) for future runs of the same task.
// ---------------------------------------------------------------------------

async function _discoverTaskProcedure({ hostname, goal, transcript, sessionId, headed }) {
  if (!hostname || !goal) return { discovered: false, reason: 'missing hostname or goal' };
  const _logTag = '[playwright.agent] task-discovery';
  const _appName = hostname.replace(/^www\./, '').split('.')[0];

  // Strip the "IMPORTANT: You are working on ... Task:" wrapper that browser.agent.cjs
  // adds so the LLM sees the actual task, not the routing preamble.
  const _cleanGoal = String(goal).replace(/^IMPORTANT:.*?Task:\s*/si, '').trim();

  // Lazy-load dependencies (same as _justInTimeResearch)
  let searchWeb, webCrawl, ask;
  try {
    ({ searchWeb } = require('./web.agent.cjs'));
    ({ webCrawl } = require('./web.crawl.cjs'));
    ({ ask } = require('../skill-helpers/skill-llm.cjs'));
  } catch (_reqErr) {
    logger.warn(`${_logTag}: dependency load failed: ${_reqErr.message}`);
    return { discovered: false, reason: 'dependencies unavailable' };
  }
  if (!searchWeb || !webCrawl || !ask) {
    logger.warn(`${_logTag}: dependencies not available`);
    return { discovered: false, reason: 'dependencies unavailable' };
  }

  // ── Phase 1: Check cached task_procedure in app-knowledge ────────────────
  // Avoids redundant web research on repeated runs of the same task type.
  try {
    const { loadAppKnowledge } = require('./lib/appKnowledge.cjs');
    const _existing = loadAppKnowledge(hostname);
    const _goalActionHash = _hashGoalAction(_cleanGoal);
    const _cached = _existing.find(e =>
      e.type === 'task_procedure' && e.id?.endsWith(`:${_goalActionHash}`)
    );
    if (_cached?.details?.procedure) {
      logger.info(`${_logTag}: cache hit for ${hostname} (hash=${_goalActionHash}) — reusing cached procedure`);
      return {
        discovered: true,
        procedure: _cached.details.procedure,
        keyUiElements: _cached.details.keyUiElements || [],
        sourceUrls: _cached.details.sourceUrls || [],
        queries: [],
        fromCache: true,
      };
    }
  } catch (_cacheErr) {
    logger.debug(`${_logTag}: cache lookup failed (non-fatal): ${_cacheErr.message}`);
  }

  // ── Phase 2: LLM-generate search queries from the goal ───────────────────
  const _queryGenPrompt = `Convert this automation goal into 3 web-search queries a human would type to find a how-to article. The queries should target official help docs, community forums, or tutorials.

Goal: "${_cleanGoal}"
Site: ${hostname}

Return ONLY valid JSON: { "queries": ["query 1", "query 2", "query 3"] }
Rules:
- Each query should be 4-10 words, natural language.
- Include the site/app name in at least one query.
- Focus on the ACTION the user wants to accomplish, not on the agent's internal state.
- Do NOT include words like "automation", "agent", "playwright" — these are human how-to queries.`;

  let _queries = [];
  try {
    const _raw = await ask(_queryGenPrompt, { maxTokens: 200, temperature: 0, responseTimeoutMs: 15000 });
    const _text = (typeof _raw === 'string' ? _raw : _raw?.text || _raw?.content || '').trim();
    const _stripped = _text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const _jsonMatch = _stripped.match(/\{[\s\S]*\}/);
    if (_jsonMatch) {
      const _parsed = JSON.parse(_jsonMatch[0]);
      if (Array.isArray(_parsed.queries)) {
        _queries = _parsed.queries.filter(q => typeof q === 'string' && q.trim().length > 0).slice(0, 5);
      }
    }
  } catch (_qErr) {
    logger.warn(`${_logTag}: query generation failed: ${_qErr.message}`);
  }
  if (_queries.length === 0) {
    // Fallback: simple deterministic queries from the goal + app name
    const _goalWords = _cleanGoal.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 6).join(' ');
    _queries = [
      `${_appName} ${_goalWords}`,
      `how to ${_goalWords} on ${_appName}`,
      `${_appName} tutorial ${_goalWords}`,
    ];
  }
  logger.info(`${_logTag}: generated ${_queries.length} queries for ${hostname}: ${_queries.map(q => `"${q}"`).join(', ')}`);

  // ── Phase 3: Parallel web search ─────────────────────────────────────────
  const _searchPromises = _queries.map(q => searchWeb(q, 3).catch(() => null));
  const _searchResults = await Promise.all(_searchPromises);

  // ── Phase 4: Crawl top results per query (sequential per query, parallel within) ──
  // Stop at the first article that yields a high-confidence procedure.
  const _sourceUrls = [];
  for (let _qi = 0; _qi < _queries.length; _qi++) {
    const _results = _searchResults[_qi];
    if (!_results?.ok || !Array.isArray(_results.results) || _results.results.length === 0) continue;

    for (const _result of _results.results.slice(0, 2)) {
      let _crawl;
      try {
        _crawl = await webCrawl({ url: _result.url, maxChars: 5000, timeoutMs: 15000 });
      } catch (_) { continue; }
      if (!_crawl?.ok || !_crawl.content || _crawl.content.length < 100) continue;
      _sourceUrls.push(_result.url);

      // LLM-extract a procedural summary from the crawled help article
      const _extractPrompt = `You are reading help articles for an automation agent. The agent is trying to accomplish this goal on ${hostname}:

GOAL: ${_cleanGoal}

Here is an excerpt from a help article (from ${_result.url}):
${_crawl.content.slice(0, 4000)}

Extract a CONCISE step-by-step procedure the agent should follow on the actual site UI. Mention specific buttons, menus, keyboard shortcuts, and UI element labels (e.g. "click the ••• button on the song row", "select 'Add to playlist' from the menu", "press the (+) Plus button").

Return ONLY valid JSON:
{
  "procedure": "1. ...\\n2. ...\\n3. ...",
  "keyUiElements": ["button label", "menu item", ...],
  "confidence": 0.0-1.0
}
Return { "procedure": "", "confidence": 0.0 } if the article is not relevant.`;

      let _raw;
      try {
        _raw = await ask(_extractPrompt, { maxTokens: 500, temperature: 0, responseTimeoutMs: 15000 });
      } catch (_) { continue; }
      if (!_raw) continue;
      const _text = (typeof _raw === 'string' ? _raw : _raw?.text || _raw?.content || '').trim();
      const _stripped = _text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const _jsonMatch = _stripped.match(/\{[\s\S]*\}/);
      if (!_jsonMatch) continue;

      let _extracted;
      try { _extracted = JSON.parse(_jsonMatch[0]); } catch (_) { continue; }
      if (!_extracted?.procedure || _extracted.procedure.length < 20) continue;

      const _confidence = Number(_extracted.confidence) || 0;
      if (_confidence < 0.5) {
        logger.info(`${_logTag}: article ${_result.url} yielded low-confidence procedure (${_confidence.toFixed(2)}) — continuing search`);
        continue;
      }

      logger.info(`${_logTag}: found procedure (confidence=${_confidence.toFixed(2)}) from ${_result.url} — ${_extracted.procedure.slice(0, 80)}...`);

      // ── Phase 5: Cache as task_procedure in app-knowledge ─────────────────
      try {
        const { saveAppKnowledge, loadAppKnowledge } = require('./lib/appKnowledge.cjs');
        const _goalActionHash = _hashGoalAction(_cleanGoal);
        const _entry = {
          id: `${_appName}.task_procedure:${_goalActionHash}`,
          type: 'task_procedure',
          summary: `How to "${_cleanGoal.slice(0, 60)}" on ${hostname}`,
          details: {
            goal: _cleanGoal,
            procedure: _extracted.procedure,
            keyUiElements: _extracted.keyUiElements || [],
            sourceUrls: _sourceUrls,
            confidence: _confidence,
          },
          source: 'task_discovery',
          confidence: _confidence,
        };
        const _existing = loadAppKnowledge(hostname);
        saveAppKnowledge(hostname, [..._existing.filter(e => e.id !== _entry.id), _entry]);
        logger.info(`${_logTag}: cached procedure for ${hostname} (hash=${_goalActionHash})`);
      } catch (_cacheErr) {
        logger.warn(`${_logTag}: cache save failed (non-fatal): ${_cacheErr.message}`);
      }

      return {
        discovered: true,
        procedure: _extracted.procedure,
        keyUiElements: _extracted.keyUiElements || [],
        sourceUrls: _sourceUrls,
        queries: _queries,
        fromCache: false,
      };
    }
  }

  logger.info(`${_logTag}: no actionable procedure found for goal on ${hostname} (${_queries.length} queries, ${_sourceUrls.length} articles crawled)`);
  return { discovered: false, reason: 'no actionable procedure found', queries: _queries, sourceUrls: _sourceUrls };
}

// Simple hash of the goal's action phrase for cache keying.
// Strips filler words so "Add songs to my Spotify playlist" and
// "Add music to a Spotify playlist" hash to the same key.
function _hashGoalAction(goal) {
  const _stop = new Set(['the', 'a', 'an', 'my', 'your', 'to', 'on', 'in', 'for', 'and', 'or', 'of', 'with', 'from', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them']);
  const _words = String(goal || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !_stop.has(w))
    .slice(0, 8)
    .sort();
  // Simple djb2 hash
  let _hash = 5381;
  for (const w of _words) {
    for (let i = 0; i < w.length; i++) {
      _hash = ((_hash << 5) + _hash) + w.charCodeAt(i);
      _hash = _hash & 0xffffffff;
    }
  }
  return (_hash >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Partial-progress summary: when the turn-loop exhausts (after discovery retry
// also fails), ask the LLM to summarize what was completed vs. what remains,
// using the action transcript + current page state as ground truth. The
// summary is surfaced to the user via the partial-failure QuestionCard so they
// can decide whether to "Try to finish" (plan extension), train a recipe, or
// type a correction.
// ---------------------------------------------------------------------------

async function _summarizePartialProgress({ goal, transcript, sessionId, hostname }) {
  if (!goal || !Array.isArray(transcript) || transcript.length === 0) return null;

  let ask;
  try {
    ({ ask } = require('../skill-helpers/skill-llm.cjs'));
  } catch (_) { return null; }
  if (!ask) return null;

  // Build a compact transcript summary (actions + outcomes, no full DOM dumps)
  const _transcriptSummary = transcript
    .slice(-20) // last 20 actions are most relevant
    .map((t, i) => {
      const _a = t.action || {};
      const _o = t.outcome || {};
      const _actionDesc = _a.action
        ? `${_a.action}(${_a.selector || _a.text || _a.url || ''})`
        : (_a.jit_research ? `jit_research: ${_a.jit_research}` : JSON.stringify(_a).slice(0, 80));
      const _outcomeDesc = _o.ok ? 'ok' : `fail: ${(_o.error || '').slice(0, 60)}`;
      return `${i + 1}. ${_actionDesc} → ${_outcomeDesc}`;
    })
    .join('\n');

  // Capture current page state (URL + first 500 chars of body text)
  let _pageState = '';
  try {
    const engine = require('./browser.engine.cjs');
    const page = engine.getPage(sessionId);
    if (page) {
      let _url = '';
      try { _url = page.url(); } catch (_) {}
      const _text = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
      _pageState = `Current URL: ${_url}\nPage text (first 500 chars): ${_text}`;
    }
  } catch (_) { /* non-fatal */ }

  const _prompt = `You are analyzing a partially-completed browser automation task. The agent ran out of turns before finishing.

ORIGINAL GOAL:
${String(goal).replace(/^IMPORTANT:.*?Task:\s*/si, '').trim()}

ACTIONS TAKEN (last ${Math.min(20, transcript.length)} of ${transcript.length}):
${_transcriptSummary}

CURRENT PAGE STATE:
${_pageState || '(could not capture page state)'}

Determine what was COMPLETED and what REMAINS. Be specific and accurate — base your assessment only on the evidence above (actions taken + current page state), not on assumptions.

Return ONLY valid JSON:
{
  "completed": ["specific thing that was achieved", ...],
  "remaining": ["specific thing that still needs to be done", ...],
  "summary": "one-paragraph user-facing summary (2-3 sentences) explaining what happened and what's left"
}
Rules:
- "completed" should list concrete achievements (e.g. "Created a Spotify playlist named 'Christian Music'").
- "remaining" should list concrete outstanding work (e.g. "Add songs from Lecrae, KB, and Newsboys to the playlist").
- If nothing was completed, return an empty "completed" array.
- If the task is fully done (shouldn't happen on exhaust, but defensively), return an empty "remaining" array.
- "summary" should be friendly and actionable — the user will read it in a UI card.`;

  try {
    const _raw = await ask(_prompt, { maxTokens: 400, temperature: 0, responseTimeoutMs: 15000 });
    const _text = (typeof _raw === 'string' ? _raw : _raw?.text || _raw?.content || '').trim();
    const _stripped = _text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const _jsonMatch = _stripped.match(/\{[\s\S]*\}/);
    if (!_jsonMatch) return null;
    const _parsed = JSON.parse(_jsonMatch[0]);
    if (!Array.isArray(_parsed.completed) || !Array.isArray(_parsed.remaining)) return null;
    logger.info(`[playwright.agent] partial-progress: completed=${_parsed.completed.length}, remaining=${_parsed.remaining.length}, summary="${String(_parsed.summary || '').slice(0, 80)}"`);
    return {
      completed: _parsed.completed,
      remaining: _parsed.remaining,
      summary: _parsed.summary || '',
      currentUrl: _pageState.match(/Current URL: (.+)/)?.[1] || null,
    };
  } catch (e) {
    logger.warn(`[playwright.agent] partial-progress: LLM summary failed: ${e.message}`);
    return null;
  }
}

// Signal collector D: Compose text disappearance — check if typed text is STILL
// in any visible compose element. If text is gone → sent. If text still present →
// authoritative FAIL (text wouldn't stay in compose after a successful send).
async function _verifyComposeTextGone(sessionId, expectedText) {
  try {
    const _snippet = String(expectedText || '').slice(0, 30).toLowerCase();
    if (!_snippet) return { gone: false, reason: 'no expected text' };

    const page = engine.getPage(sessionId);
    if (page) {
      const _result = await page.evaluate((snippet) => {
        const composeEls = Array.from(document.querySelectorAll(
          '[contenteditable="true"], [role="textbox"], textarea, input[type="text"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        for (const el of composeEls) {
          const text = (el.innerText || el.textContent || el.value || '').toLowerCase();
          if (text.includes(snippet)) {
            return { gone: false, tag: el.tagName.toLowerCase(), textLen: text.length };
          }
        }
        return { gone: true };
      }, _snippet).catch(() => null);
      if (_result) return _result;
    }

    // Fallback: session not engine-owned — use browserAct evaluate
    try {
      const _baRes = await browserAct({ action: 'evaluate', text: `(() => {
        const snippet = ${JSON.stringify(_snippet)};
        const composeEls = Array.from(document.querySelectorAll(
          '[contenteditable="true"], [role="textbox"], textarea, input[type="text"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        for (const el of composeEls) {
          const text = (el.innerText || el.textContent || el.value || '').toLowerCase();
          if (text.includes(snippet)) {
            return JSON.stringify({ gone: false, tag: el.tagName.toLowerCase(), textLen: text.length });
          }
        }
        return JSON.stringify({ gone: true });
      })()`, sessionId, headed: true, timeoutMs: 5000 }).catch(() => ({ ok: false }));
      if (_baRes?.ok) {
        const _raw = typeof _baRes.result === 'string' ? _baRes.result.replace(/^"|"$/g, '') : String(_baRes.result || '{}');
        try { return JSON.parse(_raw); } catch (_) {}
      }
    } catch (_) {}

    return { gone: false, reason: 'evaluate failed' };
  } catch (e) {
    return { gone: false, reason: e.message };
  }
}

// Signal collector A: DOM compose-gone — check if compose dialog/modal is gone
// or no longer contains a compose element. Gone → PASS. Still open → WEAK FAIL.
async function _verifyComposeGone(sessionId) {
  try {
    const page = engine.getPage(sessionId);
    if (page) {
      const _result = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!modal || modal.offsetParent === null) return { gone: null, hasModal: false, reason: 'no compose dialog present — full-page form, inconclusive' };
        // Modal present — check if it still contains a compose element
        const composeInModal = modal.querySelector('[contenteditable="true"], [role="textbox"], textarea');
        return { gone: !composeInModal, hasModal: true };
      }).catch(() => null);
      if (_result) return _result;
    }

    // Fallback: session not engine-owned — use browserAct evaluate
    try {
      const _baRes = await browserAct({ action: 'evaluate', text: `(() => {
        const modal = document.querySelector('[role="dialog"], [aria-modal="true"]');
        if (!modal || modal.offsetParent === null) return JSON.stringify({ gone: null, hasModal: false, reason: 'no compose dialog present — full-page form, inconclusive' });
        const composeInModal = modal.querySelector('[contenteditable="true"], [role="textbox"], textarea');
        return JSON.stringify({ gone: !composeInModal, hasModal: true });
      })()`, sessionId, headed: true, timeoutMs: 5000 }).catch(() => ({ ok: false }));
      if (_baRes?.ok) {
        const _raw = typeof _baRes.result === 'string' ? _baRes.result.replace(/^"|"$/g, '') : String(_baRes.result || '{}');
        try { return JSON.parse(_raw); } catch (_) {}
      }
    } catch (_) {}

    return { gone: false, reason: 'evaluate failed' };
  } catch (e) {
    return { gone: false, reason: e.message };
  }
}

// Unified action verification — ALL tiers call this for send/submit/post goals.
// Priority-based resolution: B (network) > D (compose text gone) > A (DOM compose-gone) > C (VLM).
// Authoritative signals:
//   - B-PASS-with-payload (network 2xx + payload contains text) → PASS (server confirmed receipt)
//   - D-FAIL (text still in compose) → FAIL (text wouldn't stay if sent)
// Existing functions become signal collectors orchestrated by this function.
async function _verifyActionCompletion({ goal, sessionId, headed, pageType, submitClickTs, expectedText, isSendSubmitGoal }) {
  const _logTag = '[playwright.agent] action verification';
  const signals = {};

  if (!isSendSubmitGoal) {
    // Non-send/submit goal — defer to existing _verifyGoalCompletion (phrase matching)
    return null;
  }

  logger.info(`${_logTag}: starting (submitClickTs=${submitClickTs}, expectedText="${String(expectedText || '').slice(0, 40)}")`);

  // ── Signal D: Compose text disappearance (FIRST — most authoritative for FAIL) ──
  // If text is still in compose → FAIL immediately, regardless of network requests.
  // Network can be fooled by draft saves (Gmail auto-save), auto-saves (Outlook),
  // and background sync requests — all fire 2xx POST with typed text in payload.
  // DOM text presence is direct evidence: if text is still in compose, it was NOT sent.
  if (expectedText) {
    signals.D = await _verifyComposeTextGone(sessionId, expectedText);
    // D-FAIL → authoritative FAIL (text still in compose = not sent)
    if (signals.D && !signals.D.gone) {
      logger.warn(`${_logTag}: FAIL (D-authoritative) — text still in compose element (tag=${signals.D.tag}, textLen=${signals.D.textLen}) — not sent`);
      return { pass: false, reason: 'Text still in compose element — send/submit not completed', source: 'compose-text', signals };
    }
  }

  // ── Signal B: Network (SECOND — can be fooled by draft saves) ──
  // Only checked if D-PASS (text gone). B-PASS + D-PASS → both agree → PASS.
  // B alone (without D confirmation) is NOT authoritative — could be draft save.
  if (submitClickTs) {
    try {
      signals.B = await _verifySubmitViaNetwork(sessionId, submitClickTs, expectedText);
    } catch (e) {
      signals.B = { ok: false, reason: 'error', error: e.message };
    }
    // B-PASS-with-payload + D-PASS → authoritative PASS (both agree — sent)
    if (signals.B.ok && signals.B.reason === '2xx-with-text' && signals.D?.gone) {
      logger.info(`${_logTag}: PASS (B+D-authoritative) — network 2xx + payload contains text + compose text gone`);
      return { pass: true, reason: `Network + compose text gone`, source: 'network+compose', signals };
    }
  }

  // ── Signal A: DOM compose-gone ──
  signals.A = await _verifyComposeGone(sessionId);

  // ── Resolution: combine remaining signals ──
  // B-PASS + D-PASS → already caught above
  // B-PASS + A-PASS → PASS (network + compose gone)
  // Require signals.A?.gone === true (not just truthy) — null means inconclusive
  // (e.g. full-page forms like Reddit submit have no dialog to disappear).
  if (signals.B?.ok && signals.A?.gone === true) {
    logger.info(`${_logTag}: PASS (B+A) — network 2xx + compose dialog gone`);
    return { pass: true, reason: `Network + compose gone`, source: 'network+dom', signals };
  }
  // D-PASS + A-PASS → PASS (no network but text gone + compose gone)
  if (signals.D?.gone && signals.A?.gone === true) {
    logger.info(`${_logTag}: PASS (D+A) — compose text gone + compose dialog gone`);
    return { pass: true, reason: `Compose text + dialog gone`, source: 'compose', signals };
  }
  // B-FAIL + A-FAIL → FAIL (no network + compose still open)
  // Only fail when A is definitively false (dialog still open), not null (no dialog = inconclusive)
  if (signals.B && !signals.B.ok && signals.A && signals.A.gone === false) {
    logger.warn(`${_logTag}: FAIL (B+A) — no network 2xx + compose dialog still open`);
    return { pass: false, reason: `No network confirmation + compose still open`, source: 'network+dom', signals };
  }

  // ── Signal C: VLM screenshot (tiebreaker) ──
  try {
    const _ssRes = await browserAct({ action: 'screenshot', sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
    if (_ssRes.ok && _ssRes.result) {
      const _vlm = await _vlmVerifyScreenshot(_ssRes.result, goal, pageType);
      signals.C = _vlm;
      if (_vlm?.verified === true) {
        logger.info(`${_logTag}: PASS (C) — VLM verified send/submit`);
        return { pass: true, reason: `VLM verified: ${_vlm.reasoning || 'screenshot matches'}`, source: 'vlm', signals };
      }
      if (_vlm?.verified === false) {
        logger.warn(`${_logTag}: FAIL (C) — VLM says not sent: ${_vlm.reasoning || ''}`);
        return { pass: false, reason: `VLM failed: ${_vlm.reasoning || 'screenshot does not match'}`, source: 'vlm', signals };
      }
    }
  } catch (e) {
    signals.C = { error: e.message };
  }

  // All inconclusive → FAIL (safer to fail than false positive)
  logger.warn(`${_logTag}: INCONCLUSIVE — all signals inconclusive, defaulting to FAIL (signals=${JSON.stringify(Object.keys(signals))})`);
  return { pass: false, reason: 'All verification signals inconclusive', source: 'inconclusive', signals };
}

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
// Goal-phrase extraction + location-aware goal verification (F7).
// Used by _focusedPlanExecute (F7c) and the turn-loop return check (F7d) to
// prevent false "completed successfully" when steps returned ok=true but the
// goal wasn't actually achieved (e.g. Google Docs rename that typed the title
// into the Find-and-replace dialog instead of the document title input).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LLM goal decomposition: break the goal into sub-tasks with semantic
// verification criteria. This replaces the fragile regex-based phrase
// extraction as the PRIMARY verification mechanism. Falls back to regex
// (_extractGoalPhrases) if decomposition fails.
// ---------------------------------------------------------------------------

// Extract entities (proper nouns + quoted phrases) from a goal string.
// Used to ensure the LLM decomposition doesn't silently drop entities like
// "KB" or "Newsboys" when collapsing a multi-entity task into sub-tasks.
function _extractGoalEntities(goal) {
  if (!goal || typeof goal !== 'string') return [];
  const _stop = new Set([
    'The', 'And', 'Then', 'Create', 'Search', 'Add', 'Click', 'Open', 'New',
    'Page', 'Playlist', 'Repeat', 'Process', 'Find', 'Top', 'Songs', 'Track',
    'Tracks', 'Menu', 'Button', 'Sidebar', 'Left', 'Right', 'URL', 'Go',
    'Make', 'Use', 'Get', 'Set', 'Put', 'Show', 'List', 'Name', 'Rename',
    'Music', 'Artist', 'Artists', 'Album', 'Song', 'Spotify', 'YouTube',
    'Google', 'Chrome', 'Safari', 'Firefox', 'Edge', 'Browser', 'Tab',
    'Window', 'Screen', 'App', 'Application', 'Desktop', 'Mobile',
  ]);
  const entities = new Set();
  // Quoted phrases (single + double quotes) — these are the most reliable
  const _quoted = goal.match(/['"]([^'"]{2,50})['"]/g) || [];
  for (const q of _quoted) {
    const t = q.replace(/['"]/g, '').trim();
    if (t.length > 1 && !/^\+|\.\.\.$|^Save$|^Enter$|^Cancel$|^OK$|^Yes$|^No$/i.test(t)) {
      entities.add(t);
    }
  }
  // Capitalized proper nouns (2+ chars, not in stoplist)
  const _caps = goal.match(/\b[A-Z][a-zA-Z]{1,}\b/g) || [];
  for (const c of _caps) {
    if (!_stop.has(c) && c.length > 1) {
      entities.add(c);
    }
  }
  const result = Array.from(entities);
  logger.info(`[playwright.agent] entity extraction from goal: ${result.length} entities: ${result.join(', ')}`);
  return result;
}

async function _decomposeGoalIntoSubTasks(goal, sessionId) {
  if (!goal || goal.length < 10) return { ok: false, error: 'goal too short' };
  // Don't decompose if the goal already has a [DISCOVERED PROCEDURE] block —
  // the procedure is already step-by-step.
  if (/\[DISCOVERED PROCEDURE/.test(goal)) return { ok: false, error: 'goal has procedure block' };

  // ── Entity preservation: extract entities before LLM call ──
  const _entities = _extractGoalEntities(goal);
  const _entityList = _entities.length > 0
    ? `\n\nCRITICAL — ENTITY PRESERVATION:\nThe following entities are mentioned in the goal and MUST each appear in at least one sub-task description: ${_entities.map(e => `"${e}"`).join(', ')}\nDo NOT collapse multiple entities into a single sub-task unless the verification criterion covers ALL of them. If there are 3 artists, create separate sub-tasks for each artist's songs being added (or one sub-task whose verification checks for ALL 3 artists on the destination page).\n`
    : '';

  const _prompt = `Decompose this browser automation goal into ordered sub-tasks. For each sub-task, provide a specific, checkable verification criterion AND a description of the expected page state after the sub-task completes.

Goal: "${goal.slice(0, 1000)}"
${_entityList}
Return JSON only:
{
  "subTasks": [
    {
      "id": 1,
      "description": "what to do (imperative, e.g. 'Create a new playlist')",
      "verification": "how to check if done (specific, e.g. 'URL contains /playlist/' or 'input with placeholder Add a name contains Christian Music')",
      "expectedState": "what the page should look like AFTER this sub-task (e.g. 'A new playlist card appears in the sidebar with a default name. The main panel shows an empty playlist with an Edit details button.')"
    }
  ]
}

Rules:
- 2-8 sub-tasks (merge trivial steps, but preserve all entities)
- verification must be checkable from URL, DOM, or visible text — NOT from "the action succeeded"
- expectedState must describe VISIBLE page elements (text, dialogs, buttons, URL) that would be present after the sub-task completes — this is used as a visual verification gate
- Each sub-task should be independently verifiable
- Order matters — earlier sub-tasks are prerequisites for later ones
- CRITICAL: verification must check the FINAL page state after ALL sub-tasks are complete, NOT intermediate states. For "add X to Y" tasks, use "page text contains X" (the final destination page), NOT "search results show X" (intermediate). For "create playlist named Z", use "URL contains /playlist/ and page text contains Z".
- For "add/search" sub-tasks, the verification should check that the ADDED ITEM appears on the DESTINATION page (e.g. playlist page text contains the artist name), not that search results are visible.
- ELEMENT DISAMBIGUATION: When a sub-task involves typing, searching, or clicking, and the page may have MULTIPLE similar elements (e.g. two search boxes, multiple "Add" buttons), include a distinguishing hint in the description. Specify the target element's placeholder text, aria-label, nearby heading, or section context. Example: "Search for 'Lecrae' in the playlist's 'Search for songs or episodes' input (under 'Let's find something for your playlist'), NOT the top global search bar". This helps the agent pick the right element when multiple candidates exist.
- WORKFLOW SELECTION (general — applies to all sites): When a task involves interacting within a specific section/container of a page (e.g., a playlist, a project board, a document editor, a chat thread), prefer using that section's built-in inputs over global page-level inputs. The DOM signals will show inputs with \`context="..."\` attributes — choose the input whose context matches the section you're working in. Prefer the SIMPLEST workflow: if a section has its own search/add input, use it directly rather than navigating elsewhere and using a global search + multi-step menu navigation. Sub-task descriptions should reference the context attribute or nearby heading of the correct input (e.g., "use the input under the 'Let's find something for your playlist' heading") rather than naming a specific input by aria-label (which may be ambiguous).`;

  try {
    const _raw = await askWithMessages([
      { role: 'system', content: 'You are a browser automation task planner. Output valid JSON only.' },
      { role: 'user', content: _prompt },
    ], { temperature: 0.1, maxTokens: 1000, responseTimeoutMs: 15000 });

    if (!_raw) return { ok: false, error: 'empty response' };
    const _m = _raw.match(/\{[\s\S]*\}/);
    if (!_m) return { ok: false, error: 'no JSON in response' };
    const _parsed = JSON.parse(_m[0]);
    if (!_parsed.subTasks || !Array.isArray(_parsed.subTasks) || _parsed.subTasks.length === 0) {
      return { ok: false, error: 'no subTasks array' };
    }
    // Normalize
    let subTasks = _parsed.subTasks.map((s, i) => ({
      id: s.id || (i + 1),
      description: String(s.description || '').slice(0, 200),
      verification: String(s.verification || '').slice(0, 300),
      expectedState: String(s.expectedState || '').slice(0, 300),
      completed: false,
    }));

    // ── Entity preservation validation: check all entities are covered ──
    if (_entities.length > 0) {
      const _allDesc = subTasks.map(s => s.description).join(' ').toLowerCase();
      const _missing = _entities.filter(e => !_allDesc.includes(e.toLowerCase()));
      if (_missing.length > 0) {
        logger.warn(`[playwright.agent] entity preservation: ${_missing.length} entities missing from sub-tasks: ${_missing.join(', ')} — adding fallback sub-tasks`);
        const _hasPlaylist = /playlist/i.test(_allDesc);
        const _destination = _hasPlaylist ? 'the playlist' : 'the destination';
        for (const entity of _missing) {
          const _nextId = Math.max(...subTasks.map(s => s.id)) + 1;
          subTasks.push({
            id: _nextId,
            description: `Add songs by ${entity} to ${_destination}`,
            verification: `${_destination} page text contains "${entity}"`,
            expectedState: `${_destination} page shows songs by ${entity} in the track list`,
            completed: false,
          });
        }
      }
    }

    logger.info(`[playwright.agent] goal decomposition: ${subTasks.length} sub-tasks: ${subTasks.map(s => `#${s.id} ${s.description} [verify: ${s.verification}] [expected: ${s.expectedState.slice(0, 60)}]`).join(' | ')}`);
    return { ok: true, subTasks };
  } catch (e) {
    logger.warn(`[playwright.agent] goal decomposition failed (non-fatal, will use regex fallback): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Check a SINGLE verification condition (no " and " splitting).
// Returns true if this one condition is met.
async function _checkSingleVerificationCondition(v, page, url, text, subTaskId) {
  // Pattern: "URL contains X" or "url contains X"
  const urlMatch = v.match(/url contains ['"]?([^'"\n]+?)['"]?(?:\s|$)/);
  if (urlMatch) {
    const frag = urlMatch[1].toLowerCase().trim();
    if (frag && url.includes(frag)) {
      logger.info(`[playwright.agent] sub-task #${subTaskId} verified: URL contains "${frag}"`);
      return true;
    }
  }

  // Pattern: "input ... contains X" or "field ... contains X"
  const inputMatch = v.match(/(?:input|field)(?:.*?)(?:contains|has|shows?)\s+['"]?([^'"\n]+?)['"]?(?:\s|$)/);
  if (inputMatch && page) {
    const target = inputMatch[1].toLowerCase().trim();
    try {
      const _found = await page.evaluate((t) => {
        const els = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'));
        for (const el of els) {
          const val = (el.value || el.innerText || el.textContent || '').toLowerCase();
          if (val.includes(t)) return true;
        }
        return false;
      }, target).catch(() => false);
      if (_found) {
        logger.info(`[playwright.agent] sub-task #${subTaskId} verified: input contains "${target}"`);
        return true;
      }
    } catch (_) {}
  }

  // Pattern: "page shows X" or "text X visible" or "X appears"
  const textMatch = v.match(/(?:page shows?|text|visible|appears?|displays?)\s+['"]?([^'"\n]+?)['"]?(?:\s|$)/);
  if (textMatch) {
    const target = textMatch[1].toLowerCase().trim();
    if (target && text.includes(target)) {
      logger.info(`[playwright.agent] sub-task #${subTaskId} verified: page text contains "${target}"`);
      return true;
    }
  }

  // Pattern: "search results" — check if there are list-like elements with the search term
  const searchMatch = v.match(/search results?(?:.*?)(?:show|contain|visible|display)\s+['"]?([^'"\n]+?)['"]?(?:\s|$)/);
  if (searchMatch && page) {
    const term = searchMatch[1].toLowerCase().trim();
    if (term && text.includes(term)) {
      try {
        const _hasResults = await page.evaluate(() => {
          return document.querySelectorAll('[role="listitem"], [data-testid*="track"], [data-testid*="card"], li, .search-result').length > 0;
        }).catch(() => false);
        if (_hasResults) {
          logger.info(`[playwright.agent] sub-task #${subTaskId} verified: search results for "${term}" visible`);
          return true;
        }
      } catch (_) {}
    }
  }

  // Fallback: just check if the verification text appears in page text
  if (v.length > 5 && v.length < 100) {
    const keyPhrase = v.replace(/^(url contains|input.*?contains|page shows?|text|visible|appears?|displays?|search results?.*?)\s+/i, '').replace(/['"]/g, '').trim();
    if (keyPhrase.length > 3 && text.includes(keyPhrase.toLowerCase())) {
      logger.info(`[playwright.agent] sub-task #${subTaskId} verified: page contains "${keyPhrase}"`);
      return true;
    }
  }

  return false;
}

// Check if a single sub-task is completed based on its verification criterion.
// Uses lightweight DOM/URL checks — not another LLM call.
// Returns true if the verification criterion is met.
// If the verification contains " and ", ALL parts must pass (compound verification).
async function _checkSubTaskCompletion(subTask, page, pageUrl, pageText) {
  if (!subTask || subTask.completed) return true;
  const v = (subTask.verification || '').toLowerCase();
  if (!v) return false;
  const url = (pageUrl || '').toLowerCase();
  const text = (pageText || '').toLowerCase().slice(0, 5000);

  // Split on " and " for compound verification (e.g. "URL contains /playlist/ and page text contains 'Christian Music'")
  // Only split when " and " is between two verification-like phrases (not inside quotes)
  const _parts = v.split(/\s+and\s+/).map(s => s.trim()).filter(s => s.length > 0);
  if (_parts.length <= 1) {
    // Single condition — check directly
    return _checkSingleVerificationCondition(v, page, url, text, subTask.id);
  }
  // Compound verification — ALL parts must pass
  for (const _part of _parts) {
    const _passed = await _checkSingleVerificationCondition(_part, page, url, text, subTask.id);
    if (!_passed) {
      logger.info(`[playwright.agent] sub-task #${subTask.id} NOT verified: compound part failed — "${_part.slice(0, 80)}"`);
      return false;
    }
  }
  logger.info(`[playwright.agent] sub-task #${subTask.id} verified: all ${_parts.length} compound parts passed`);
  return true;
}

// Build the sub-task progress block for injection into the turn-loop LLM prompt.
function _buildSubTaskProgressBlock(subTasks) {
  if (!subTasks || subTasks.length === 0) return '';
  const lines = subTasks.map(s => {
    const mark = s.completed ? '[✓]' : '[ ]';
    const status = s.completed ? 'DONE' : 'NOT DONE';
    return `${mark} ${s.id}. ${s.description} — ${status}`;
  });
  const _current = subTasks.find(s => !s.completed);
  const currentLine = _current
    ? `\nCURRENT SUB-TASK: #${_current.id} — ${_current.description}\nDo NOT repeat completed sub-tasks. Focus on the current sub-task.`
    : '\nALL SUB-TASKS COMPLETE — output { "action": "return", "data": "all sub-tasks completed" }';
  return `\nSUB-TASK PROGRESS:\n${lines.join('\n')}${currentLine}\n`;
}

// ---------------------------------------------------------------------------
// 3-gate structural verification — used when the LLM emits "return" or the
// turn-loop exhausts, to verify that incomplete sub-tasks were ACTUALLY
// completed (not just "entity name appears somewhere on the page").
//
// Gate 1: Action transcript check — did the agent perform an "add" action
//         matching the entity? (fast, deterministic)
// Gate 2: Container check — does the entity appear in a track-list-like
//         container but NOT in search results? (fast, deterministic)
// Gate 3: LLM verification — ask the LLM with page state + transcript
//         (only when gates 1 & 2 are inconclusive; ~3-5s latency)
//
// Returns { verified: boolean, gate: string, reason: string }
// ---------------------------------------------------------------------------
async function _structuralVerifySubTask(subTask, { page, pageUrl, pageText, transcript, sessionId }) {
  if (!subTask || subTask.completed) return { verified: true, gate: 'already_completed', reason: 'sub-task already marked complete' };
  const _desc = (subTask.description || '').toLowerCase();
  const _verification = (subTask.verification || '').toLowerCase();
  const _url = (pageUrl || '').toLowerCase();
  const _text = (pageText || '').toLowerCase().slice(0, 8000);

  // Extract key entities from the sub-task description + verification
  const _entityTerms = new Set();
  const _quoted = (subTask.description + ' ' + subTask.verification).match(/['"]([^'"]{2,50})['"]/g) || [];
  for (const q of _quoted) {
    const t = q.replace(/['"]/g, '').trim();
    if (t.length > 1 && !/^\+|\.\.\.$|^save$|^enter$|^cancel$/i.test(t)) _entityTerms.add(t.toLowerCase());
  }
  const _caps = (subTask.description + ' ' + subTask.verification).match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
  const _stop = new Set(['The', 'And', 'Then', 'Create', 'Search', 'Add', 'Click', 'Open', 'New', 'Page', 'Playlist', 'Repeat', 'Process', 'Find', 'Top', 'Songs', 'Track', 'Tracks', 'Menu', 'Button', 'Sidebar', 'URL', 'Music', 'Artist', 'Artists', 'Album', 'Song']);
  for (const c of _caps) {
    if (!_stop.has(c)) _entityTerms.add(c.toLowerCase());
  }
  const _terms = Array.from(_entityTerms);
  if (_terms.length === 0) {
    return { verified: false, gate: 'no_terms', reason: 'no entity terms extracted from sub-task description' };
  }

  // Determine if this is an "add" sub-task
  const _isAddTask = /\b(add|insert|include|put|append)\b/.test(_desc) || /\b(add|insert|include|put|append)\b/.test(_verification);
  // Determine if this is a "create" sub-task (e.g. create playlist, create document,
  // create project). These tasks produce a one-time creation action in the transcript
  // (typing a name, clicking "Create") that persists even after the agent navigates
  // away. Verifying by current page URL fails when the agent moves to another page,
  // but the creation action in the transcript is durable evidence.
  const _isCreateTask = /\b(create|make|new|rename)\b/.test(_desc) || /\b(create|make|new|rename)\b/.test(_verification);

  // Generic UI labels that appear in sub-task descriptions as quoted terms but
  // are just button labels — clicking them opens a menu/dialog and does NOT
  // complete the action. Used by Gate 0 and Gate 1 to avoid false positives.
  const _genericUiLabels = new Set([
    'add to playlist', 'add to cart', 'add to favorites', 'add to list',
    'save', 'cancel', 'done', 'close', 'ok', 'yes', 'no', 'submit', 'post',
    'send', 'share', 'more options', 'options', 'menu', 'edit', 'delete',
    'remove', 'create', 'new', 'add', 'select', 'choose', 'pick',
  ]);

  // ── Gate 0: Transcript history check for "create" tasks ──────────────
  // For create tasks, check if a creation action was performed in the transcript
  // (e.g. typing the entity name into a name/title field). This catches the case
  // where the agent created the item successfully but then navigated away —
  // the current page URL won't match, but the transcript has durable evidence.
  if (_isCreateTask && Array.isArray(transcript) && transcript.length > 0) {
    // Filter entity terms to exclude generic UI labels
    const _contentTerms = _terms.filter(term => !_genericUiLabels.has(term));
    const _searchTerms = _contentTerms.length > 0 ? _contentTerms : _terms;
    for (const t of transcript) {
      const _a = t.action || {};
      const _o = t.outcome || {};
      if (!_o.ok) continue;
      // Look for type/fill/reactFill actions where the text matches an entity term
      if (['type', 'fill', 'reactFill'].includes(_a.action) && _a.text) {
        const _typedText = _a.text.toLowerCase();
        if (_searchTerms.some(term => _typedText.includes(term))) {
          logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 0 PASSED — create action found in transcript: ${_a.action}("${_a.text}")`);
          return { verified: true, gate: 'history', reason: `create action found in transcript: typed "${_a.text}" matching entity` };
        }
      }
      // Also look for clickByText actions that match create-like verbs + entity
      if (_a.action === 'clickByText' && _a.text) {
        const _clickText = _a.text.toLowerCase();
        if (/\b(create|new|add|make)\b/.test(_clickText) && _searchTerms.some(term => _clickText.includes(term))) {
          logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 0 PASSED — create click found in transcript: clickByText("${_a.text}")`);
          return { verified: true, gate: 'history', reason: `create click found in transcript: clicked "${_a.text}"` };
        }
      }
    }
    logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 0 FAILED — no create action matching entity in transcript (${transcript.length} actions scanned)`);
  }

  // ── Gate 1: Action transcript check ──────────────────────────────────
  // Checks if the agent performed an "add" action matching the entity.
  // IMPORTANT: Only check text/label/value for the add verb and entity match —
  // NOT the selector. Selectors often contain placeholder text like "Add a name"
  // which falsely matches the add verb, and entity names like "Christian" from
  // the playlist name field match entities from the sub-task description, causing
  // false positives (e.g. typing "Christian Music" in the playlist name field
  // was counted as "adding Christian songs to the playlist").
  // ALSO: exclude generic UI labels (e.g. "Add to playlist", "Save", "Submit")
  // from entity matching — these are button labels that appear in sub-task
  // descriptions as quoted terms, but clicking them just opens a menu/dialog
  // and does NOT complete the add action.
  if (_isAddTask && Array.isArray(transcript) && transcript.length > 0) {
    for (const t of transcript) {
      const _a = t.action || {};
      const _o = t.outcome || {};
      if (!_o.ok) continue;
      // Build action text from text/label/value ONLY — exclude selector to avoid
      // false positives from placeholder text in selectors (e.g. "Add a name").
      const _actionContent = ((_a.text || '') + ' ' + (_a.label || '') + ' ' + (_a.value || '')).toLowerCase().trim();
      // Skip generic UI label actions — clicking "Add to playlist" just opens a
      // menu, it doesn't complete the add. The entity match must be on the
      // actual content being added (artist name, song name), not the button label.
      if (_genericUiLabels.has(_actionContent)) {
        continue;
      }
      const _hasAddVerb = /\b(add|add to|include|insert|append)\b/.test(_actionContent);
      // Filter entity terms to exclude generic UI labels — only match on real
      // content entities (artist names, song names, etc.)
      const _contentTerms = _terms.filter(term => !_genericUiLabels.has(term));
      const _matchesEntity = _contentTerms.some(term => _actionContent.includes(term));
      // Also check the action name itself for add-like verbs (clickByText "Add to playlist")
      const _actionName = (_a.action || '').toLowerCase();
      const _actionNameHasAdd = /add/.test(_actionName);
      if ((_hasAddVerb || _actionNameHasAdd) && _matchesEntity) {
        logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 1 PASSED — add action found in transcript: ${_a.action}(${_a.text || _a.label || _a.value || ''})`);
        return { verified: true, gate: 'transcript', reason: `add action found in transcript matching entity: ${_contentTerms.filter(t => _actionContent.includes(t)).join(', ')}` };
      }
    }
    logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 1 FAILED — no add action matching entity in transcript (${transcript.length} actions scanned)`);
  } else if (!_isAddTask) {
    logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 1 SKIPPED — not an add task`);
  } else {
    logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 1 SKIPPED — no transcript`);
  }

  // ── Gate 2: Container check ──────────────────────────────────────────
  if (page) {
    try {
      const _containerResult = await page.evaluate((terms) => {
        const _trackListSelectors = [
          '[data-testid="track-list"]', '[data-testid*="track-list"]',
          '[data-testid*="playlist-track"]', '[role="listitem"]',
          '.track-list', '.playlist-tracks',
          '[aria-label*="Track"]', '[aria-label*="Content of"]',
        ];
        const _searchSelectors = [
          '[data-testid*="search"]', '[data-testid*="search-result"]',
          '.search-result', '[role="search"]', '[aria-label*="Search result"]',
        ];
        let _trackListText = '';
        for (const sel of _trackListSelectors) {
          for (const el of document.querySelectorAll(sel)) _trackListText += ' ' + (el.innerText || el.textContent || '');
        }
        let _searchText = '';
        for (const sel of _searchSelectors) {
          for (const el of document.querySelectorAll(sel)) _searchText += ' ' + (el.innerText || el.textContent || '');
        }
        _trackListText = _trackListText.toLowerCase();
        _searchText = _searchText.toLowerCase();
        const _results = [];
        for (const term of terms) {
          _results.push({ term, inTrackList: _trackListText.includes(term), inSearch: _searchText.includes(term) });
        }
        return { results: _results, hasTrackListContainer: _trackListText.length > 0, hasSearchContainer: _searchText.length > 0 };
      }, _terms).catch(() => null);

      if (_containerResult && _containerResult.results) {
        const _inTrackListOnly = _containerResult.results.filter(r => r.inTrackList && !r.inSearch);
        const _inSearchOnly = _containerResult.results.filter(r => r.inSearch && !r.inTrackList);
        const _inBoth = _containerResult.results.filter(r => r.inTrackList && r.inSearch);

        if (_inTrackListOnly.length > 0) {
          logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 PASSED — entity in track-list, not in search: ${_inTrackListOnly.map(r => r.term).join(', ')}`);
          return { verified: true, gate: 'container', reason: `entity in track-list container, not in search: ${_inTrackListOnly.map(r => r.term).join(', ')}` };
        }
        if (_inSearchOnly.length > 0 && _containerResult.results.every(r => !r.inTrackList)) {
          logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 FAILED — entity only in search results: ${_inSearchOnly.map(r => r.term).join(', ')}`);
          return { verified: false, gate: 'container', reason: `entity only in search results, not in track list: ${_inSearchOnly.map(r => r.term).join(', ')}` };
        }
        logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 INCONCLUSIVE — falling through to Gate 3`);
      } else {
        logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 INCONCLUSIVE — container check returned null — falling through to Gate 3`);
      }
    } catch (e) {
      logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 ERROR — ${e.message} — falling through to Gate 3`);
    }
  } else {
    logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 2 SKIPPED — no page object`);
  }

  // ── Gate 3: LLM verification ─────────────────────────────────────────
  try {
    let ask;
    try { ({ ask } = require('../skill-helpers/skill-llm.cjs')); } catch (_) {}
    if (!ask) {
      return { verified: false, gate: 'no_llm', reason: 'gates 1 & 2 inconclusive and LLM not available' };
    }
    const _transcriptSummary = (transcript || []).slice(-10).map((t, i) => {
      const _a = t.action || {};
      const _o = t.outcome || {};
      const _actionDesc = _a.action ? `${_a.action}(${_a.text || _a.selector || _a.url || ''})` : JSON.stringify(_a).slice(0, 60);
      const _outcomeDesc = _o.ok ? 'ok' : `fail: ${(_o.error || '').slice(0, 40)}`;
      return `${i + 1}. ${_actionDesc} → ${_outcomeDesc}`;
    }).join('\n');

    const _llmPrompt = `You are verifying whether a browser automation sub-task was completed. Base your assessment ONLY on the evidence below.

SUB-TASK DESCRIPTION: ${subTask.description}
VERIFICATION CRITERION: ${subTask.verification}

CURRENT PAGE URL: ${pageUrl || '(unknown)'}
CURRENT PAGE TEXT (first 500 chars): ${(pageText || '').slice(0, 500)}

ACTIONS TAKEN (last ${Math.min(10, (transcript || []).length)} of ${(transcript || []).length}):
${_transcriptSummary || '(no actions)'}

Was this sub-task completed? Consider:
- Does the current page show evidence that the sub-task's goal was achieved?
- Were the actions taken consistent with completing the sub-task?
- For "add X to Y" tasks: is X actually IN Y (the destination), not just visible on a search page?

Return ONLY valid JSON:
{"completed": true/false, "reasoning": "1-2 sentence explanation"}`;

    const _raw = await ask(_llmPrompt, { maxTokens: 150, temperature: 0, responseTimeoutMs: 10000 });
    const _text2 = (typeof _raw === 'string' ? _raw : _raw?.text || _raw?.content || '').trim();
    const _stripped = _text2.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const _jsonMatch = _stripped.match(/\{[\s\S]*\}/);
    if (_jsonMatch) {
      const _parsed = JSON.parse(_jsonMatch[0]);
      const _verified = _parsed.completed === true;
      logger.info(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 3 ${_verified ? 'PASSED' : 'FAILED'} — LLM says: ${String(_parsed.reasoning || '').slice(0, 100)}`);
      return { verified: _verified, gate: 'llm', reason: String(_parsed.reasoning || '').slice(0, 200) };
    }
    return { verified: false, gate: 'llm_parse_fail', reason: 'LLM response did not contain valid JSON' };
  } catch (e) {
    logger.warn(`[playwright.agent] structural verify sub-task #${subTask.id}: Gate 3 ERROR — ${e.message}`);
    return { verified: false, gate: 'llm_error', reason: e.message };
  }
}

// Extract goal phrases from a natural-language goal string.
// Returns { phrases: string[], titledPhrases: string[] }.
//   phrases        — all phrases that should appear somewhere on the page
//                    (quoted phrases + titled/called/named X).
//   titledPhrases  — subset extracted via `titled|called|named X`; these must
//                    appear in document.title or a title-ish input value, NOT
//                    just anywhere in body text (otherwise typing the title
//                    into a modal input would falsely pass).
// Shared by the turn-loop pre-exhaustion check (F7e) and _verifyGoalCompletion.
function _extractGoalPhrases(goal) {
  if (!goal || typeof goal !== 'string') return { phrases: [], titledPhrases: [] };

  // ── Read/extract task detection ──────────────────────────────────────────
  // For read/extract tasks, quoted strings in the goal are PARAMETERS (search
  // queries, field names to extract), not goal-completion targets. Phrase-based
  // verification is for WRITE tasks (verify typed text landed in the right
  // field). For READ tasks, skip phrase extraction → verification falls through
  // to VLM/inconclusive → return is accepted → captured data flows downstream
  // to synthesize. This prevents false-negative goal verification when a quoted
  // search query (e.g. "is:unread wendal") doesn't appear verbatim on the page.
  // Mixed tasks (read + mutation verbs) still get phrase verification.
  const _hasReadVerb = /\b(extract|read|search|find|check|list|show|display|look\s+up|pull\s+up|fetch|retrieve|count|how many|browse|summarize)\b/i.test(goal);
  const _hasMutationVerb = /\b(send|post|compose|tweet|share|write|create|submit|publish|edit|update|delete|remove|add|fill|type|reply|comment|draft|rename|move|sort|format|forward)\b/i.test(goal);
  if (_hasReadVerb && !_hasMutationVerb) {
    logger.info(`[playwright.agent] _extractGoalPhrases: read/extract task detected — skipping phrase extraction (quoted strings are parameters, not goal targets)`);
    return { phrases: [], titledPhrases: [] };
  }

  const phrases = [];
  const titledPhrases = [];

  // 0. Defense-in-depth: strip instruction notes before extracting phrases.
  //    Notes like 'Do NOT click "Start a post"' or 'IMPORTANT: ... "X"' get
  //    appended to the goal for the LLM but should NOT contribute verification
  //    phrases. Strip text after common instruction markers.
  //    Normalize Unicode quotes to ASCII so the regex below matches regardless
  //    of whether the LLM used straight or curly quotes.
  const _cleanGoal = goal
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')  // curly double quotes → "
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")  // curly single quotes → '
    .replace(/^IMPORTANT:.*?(?=\n\n|\n[A-Z]|\n$|$)/is, '')  // strip IMPORTANT from START of goal
    .replace(/\n\nIMPORTANT:.*$/is, '')   // strip IMPORTANT notes (mid-goal)
    .replace(/\n\nNOTE:.*$/is, '')        // strip NOTE notes
    .replace(/Do NOT click\s+["'][^"']+["']/gi, '') // strip "Do NOT click 'X'" patterns
    .replace(/Do NOT\s+\w+\s+["'][^"']+["']/gi, ''); // strip "Do NOT <verb> 'X'" patterns

  // 1. Quoted phrases — "Q3 Planning Notes" or 'Q3 Planning Notes'
  const quoted = _cleanGoal.match(/["']([^"']{2,})["']/g);
  if (quoted) {
    for (const q of quoted) {
      const cleaned = q.replace(/["']/g, '').trim();
      if (cleaned.length > 2) phrases.push(cleaned);
    }
  }
  // 2. titled|called|named X — these are title-targeted; must land in
  //    document.title or a title-ish input, not just any input.
  //    Stop at common conjunctions/punctuation so we don't swallow the rest
  //    of the sentence ("titled 'X' and send to Y" → just X).
  const titledRe = /\b(?:titled|called|named)\s+["']?([^"'.\n]+?)["']?(?:\s+(?:and|then|with|to|under|for|in|on|at|by)|[.,;\n]|$)/gi;
  let m;
  while ((m = titledRe.exec(_cleanGoal)) !== null) {
    const p = m[1].trim();
    if (p.length > 2) {
      phrases.push(p);
      titledPhrases.push(p);
    }
  }
  // De-dup (case-sensitive — callers lower-case for comparison)
  // Each array gets its OWN Set so phrases and titledPhrases are deduped
  // independently — a phrase that appears in both arrays should survive
  // in titledPhrases even if it was already seen in phrases.
  const _dedup = arr => {
    const seen = new Set();
    return arr.filter(p => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const _result = { phrases: _dedup(phrases), titledPhrases: _dedup(titledPhrases) };
  // Debug: log what was extracted so we can diagnose titled=0 cases
  logger.info(`[playwright.agent] _extractGoalPhrases: phrases=${JSON.stringify(_result.phrases)} titledPhrases=${JSON.stringify(_result.titledPhrases)} goalSnippet="${(goal || '').slice(0, 200)}"`);
  return _result;
}

// Verify that the goal was actually achieved on the current page.
// Two tiers:
//   Tier 1 (DOM, deterministic, ~50ms): one page.evaluate collecting
//     - document.title
//     - visible NON-MODAL input values (exclude inputs inside [role=dialog] /
//       [aria-modal="true"]) — typing into a modal's input doesn't count
//     - title-ish input values (inputs whose aria-label/placeholder/name/id
//       matches /title|name|subject|rename/i) — these count even if inside a
//       dialog, because some legit flows (calendar event, rename dialog) put
//       the title input in a modal
//     - body.innerText
//   Then location-aware matching:
//     - titledPhrases must be in document.title OR a title-ish input value
//     - other phrases must be in body.innerText OR a non-modal input value
//     - missing phrases → fail
//   Tier 2 (VLM, only when no phrases extracted OR Tier 1 inconclusive):
//     Playwright page.screenshot + _vlmVerifyScreenshot. VLM false → fail,
//     true → pass, null (unavailable) → don't fail on VLM's account.
//
// Returns { pass: bool, reason: string, source: 'dom'|'vlm'|'inconclusive'|'llm'|'unavailable',
//           matchedPhrases: string[], missingPhrases: string[] }.
async function _verifyGoalCompletion({ goal, sessionId, headed, pageType, transcript }) {
  const { phrases, titledPhrases } = _extractGoalPhrases(goal);
  const _logTag = '[playwright.agent] goal verification';

  let _page = null;
  try { _page = engine.getPage(sessionId); } catch (_) {}

  // ── Tier 0: LLM semantic verification for goals with no extractable phrases ──
  // Phrase extraction yields nothing when the goal's target is a parameter rather
  // than a goal-completion phrase — most commonly "add/move/save X to Y" goals
  // where Y (the destination) is a parameter. Previously this fell through to
  // VLM-only → 'inconclusive' → false success (the root cause of "add songs to
  // playlist" tasks reporting success after only doing a search). Instead, ask
  // the LLM directly with the current page text + action transcript: "was this
  // goal achieved?" This is site-agnostic (the LLM reads the actual page) and
  // reuses the proven Gate 3 prompt pattern from _structuralVerifySubTask.
  if (phrases.length === 0) {
    let _ask = null;
    try { ({ ask: _ask } = require('../skill-helpers/skill-llm.cjs')); } catch (_) {}
    if (_ask) {
      try {
        const _transcriptSummary = (Array.isArray(transcript) ? transcript : []).slice(-10).map((t, i) => {
          const _a = t.action || {};
          const _o = t.outcome || {};
          const _actionDesc = _a.action ? `${_a.action}(${_a.text || _a.selector || _a.url || ''})` : JSON.stringify(_a).slice(0, 60);
          const _outcomeDesc = _o.ok ? 'ok' : `fail: ${(_o.error || '').slice(0, 40)}`;
          return `${i + 1}. ${_actionDesc} → ${_outcomeDesc}`;
        }).join('\n');

        let _pageTextForLlm = '';
        try {
          if (_page) {
            _pageTextForLlm = await _page.evaluate(() => (document.body?.innerText || '').slice(0, 1500)).catch(() => '');
          }
        } catch (_) {}
        if (!_pageTextForLlm) {
          try {
            const _baRes = await browserAct({ action: 'evaluate', text: `(document.body?.innerText || '').slice(0, 1500)`, sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
            if (_baRes?.ok) _pageTextForLlm = typeof _baRes.result === 'string' ? _baRes.result.replace(/^"|"$/g, '') : String(_baRes.result || '');
          } catch (_) {}
        }

        let _pageUrlForLlm = '';
        try {
          if (_page) _pageUrlForLlm = _page.url();
        } catch (_) {}

        const _llmPrompt = `You are verifying whether a browser automation goal was achieved. Base your assessment ONLY on the evidence below — do not assume actions succeeded just because they returned ok.

GOAL: ${goal}

CURRENT PAGE URL: ${_pageUrlForLlm || '(unknown)'}
CURRENT PAGE TEXT (first 1500 chars):
${_pageTextForLlm || '(unavailable)'}

ACTIONS TAKEN (last ${Math.min(10, (Array.isArray(transcript) ? transcript : []).length)} of ${(Array.isArray(transcript) ? transcript : []).length}):
${_transcriptSummary || '(no actions)'}

Was this goal achieved? Consider:
- Does the current page show evidence that the goal was completed?
- Were the actions taken consistent with completing the goal — or did the agent stop at an intermediate step (e.g. only searched for X but never added/moved/saved it to Y)?
- For "add/move/save X to Y" goals: is X actually IN Y now (visible on the destination page/section), not just visible in search results?
- For "create X" goals: does the page show X was created (e.g. URL contains the new item, page text contains the name)?

Return ONLY valid JSON:
{"achieved": true/false, "reasoning": "1-2 sentence explanation citing the evidence"}`;

        const _raw = await _ask(_llmPrompt, { maxTokens: 150, temperature: 0, responseTimeoutMs: 15000 });
        const _text = (typeof _raw === 'string' ? _raw : _raw?.text || _raw?.content || '').trim();
        const _stripped = _text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const _jsonMatch = _stripped.match(/\{[\s\S]*\}/);
        if (_jsonMatch) {
          try {
            const _parsed = JSON.parse(_jsonMatch[0]);
            const _achieved = _parsed.achieved === true;
            const _reasoning = String(_parsed.reasoning || '').slice(0, 200);
            logger.info(`${_logTag}: ${_achieved ? 'PASS' : 'FAIL'} (LLM Tier 0) — ${_reasoning}`);
            return { pass: _achieved, reason: _achieved ? `LLM verified: ${_reasoning}` : `LLM rejected: ${_reasoning}`, source: 'llm', matchedPhrases: [], missingPhrases: [] };
          } catch (_parseErr) {
            logger.warn(`${_logTag}: LLM Tier 0 response unparseable — falling through to VLM`);
          }
        } else {
          logger.warn(`${_logTag}: LLM Tier 0 returned no JSON — falling through to VLM`);
        }
      } catch (_llmErr) {
        logger.warn(`${_logTag}: LLM Tier 0 error (non-fatal): ${_llmErr.message} — falling through to VLM`);
      }
    } else {
      logger.info(`${_logTag}: LLM unavailable for Tier 0 — falling through to VLM`);
    }
  }

  // ── Tier 1: DOM check ──
  if (phrases.length > 0) {
    let _dom = null;
    if (_page) {
      try {
        _dom = await _page.evaluate((goalText) => {
          const isInsideModal = (el) => {
            let cur = el;
            while (cur) {
              if (cur.getAttribute && (cur.getAttribute('role') === 'dialog' || cur.getAttribute('aria-modal') === 'true')) return true;
              cur = cur.parentElement;
            }
            return false;
          };
          const isTitleish = (el) => {
            const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id].filter(Boolean).join(' ').toLowerCase();
            return /title|name|subject|rename|document/i.test(attrs);
          };
          // Create-goal + open-modal gate: for "create/make/new X" goals, an open
          // modal means the typed name is an uncommitted draft (Save not clicked
          // yet). Don't count title-ish inputs inside modals until the modal closes
          // and the created item appears in the parent page.
          const _hasOpenModal = document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length > 0;
          const _isCreateGoal = /\b(create|make|new)\b/i.test(goalText || '');
          const _gateCreateModal = _hasOpenModal && _isCreateGoal;
          const parts = [];
          parts.push('TITLE:' + (document.title || ''));
          if (_gateCreateModal) parts.push('GATE:create-modal-open');
          // Non-modal visible input values
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          for (const el of inputs) {
            // Skip hidden/zero-size inputs (Google Docs carries hidden title input)
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (el.type === 'hidden' || el.disabled) continue;
            const inModal = isInsideModal(el);
            const titleish = isTitleish(el);
            const val = (el.value || '').slice(0, 300);
            if (!val) continue;
            // Title-ish inputs count even in modals (rename dialog, event title).
            // Non-title inputs only count when NOT in a modal.
            // EXCEPTION: for create goals with an open modal, skip title-ish
            // inputs inside modals — the name is an uncommitted draft until
            // Save is clicked and the modal closes.
            if (_gateCreateModal && titleish && inModal) continue;
            if (titleish || !inModal) {
              parts.push('INPUT:' + (titleish ? '[titleish]' : '[nonmodal]') + ' ' + val);
            }
          }
          // Fix N: Contenteditable title elements — Notion's title is an H1 with
          // role=textbox and placeholder="New page", NOT an <input>/<textarea>.
          // Without this, titled phrases ("Weekly Goals") are never checked against
          // the contenteditable title → verification fails even if title is correct.
          const _ceTitleEls = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (isInsideModal(el)) return false;
            const tag = el.tagName.toLowerCase();
            const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('aria-placeholder')].filter(Boolean).join(' ').toLowerCase();
            const isTitleTag = tag === 'h1' || tag === 'h2';
            const isTitleAttr = /title|name|subject|rename|document|page title|untitled|new page/i.test(attrs);
            return isTitleTag || isTitleAttr;
          });
          for (const el of _ceTitleEls) {
            const val = (el.innerText || el.textContent || '').slice(0, 300);
            if (val) parts.push('INPUT:[titleish] ' + val); // Reuse titleish format for titled-phrase matching
          }
          // Contenteditable text (first visible one)
          const ce = Array.from(document.querySelectorAll('[contenteditable="true"]')).find(e => {
            const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
          });
          if (ce) parts.push('CE:' + (ce.innerText || ce.textContent || '').slice(0, 1000));
          // Body innerText
          parts.push('BODY:' + (document.body?.innerText || '').slice(0, 3000));
          return parts.join('\n');
        }, goal || '').catch(() => null);
      } catch (_) {}
    }
    if (!_dom) {
      // Fallback: session not engine-owned — use browserAct evaluate for the DOM check.
      // The browser.act layer can interact with ANY session (engine-owned or not).
      try {
        const _baGoal = (goal || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
        const _baRes = await browserAct({ action: 'evaluate', text: `(() => {
          const goalText = "${_baGoal}";
          const isInsideModal = (el) => {
            let cur = el;
            while (cur) {
              if (cur.getAttribute && (cur.getAttribute('role') === 'dialog' || cur.getAttribute('aria-modal') === 'true')) return true;
              cur = cur.parentElement;
            }
            return false;
          };
          const isTitleish = (el) => {
            const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id].filter(Boolean).join(' ').toLowerCase();
            return /title|name|subject|rename|document/i.test(attrs);
          };
          const _hasOpenModal = document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length > 0;
          const _isCreateGoal = /\\b(create|make|new)\\b/i.test(goalText || '');
          const _gateCreateModal = _hasOpenModal && _isCreateGoal;
          const parts = [];
          parts.push('TITLE:' + (document.title || ''));
          if (_gateCreateModal) parts.push('GATE:create-modal-open');
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          for (const el of inputs) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (el.type === 'hidden' || el.disabled) continue;
            const inModal = isInsideModal(el);
            const titleish = isTitleish(el);
            const val = (el.value || '').slice(0, 300);
            if (!val) continue;
            if (_gateCreateModal && titleish && inModal) continue;
            if (titleish || !inModal) {
              parts.push('INPUT:' + (titleish ? '[titleish]' : '[nonmodal]') + ' ' + val);
            }
          }
          const _ceTitleEls = Array.from(document.querySelectorAll('[contenteditable="true"], [role="textbox"]')).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            if (isInsideModal(el)) return false;
            const tag = el.tagName.toLowerCase();
            const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('aria-placeholder')].filter(Boolean).join(' ').toLowerCase();
            const isTitleTag = tag === 'h1' || tag === 'h2';
            const isTitleAttr = /title|name|subject|rename|document|page title|untitled|new page/i.test(attrs);
            return isTitleTag || isTitleAttr;
          });
          for (const el of _ceTitleEls) {
            const val = (el.innerText || el.textContent || '').slice(0, 300);
            if (val) parts.push('INPUT:[titleish] ' + val);
          }
          const ce = Array.from(document.querySelectorAll('[contenteditable="true"]')).find(e => {
            const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
          });
          if (ce) parts.push('CE:' + (ce.innerText || ce.textContent || '').slice(0, 1000));
          parts.push('BODY:' + (document.body?.innerText || '').slice(0, 3000));
          return parts.join('\\n');
        })()`, sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
        if (_baRes?.ok) {
          _dom = typeof _baRes.result === 'string' ? _baRes.result.replace(/^"|"$/g, '') : String(_baRes.result || '');
        }
      } catch (_) {}
    }

    if (_dom) {
      const _domLower = _dom.toLowerCase();
      const _titleLower = ((_dom.match(/^TITLE:.*$/m) || [''])[0].slice(6) || '').toLowerCase();
      // Pull title-ish input values as an array (trimmed) for exact-match checks
      const _titleishArr = (_dom.split('\n')
        .filter(l => l.startsWith('INPUT:[titleish]'))
        .map(l => l.replace(/^INPUT:\[titleish\]\s*/, '').toLowerCase().trim())
        .filter(Boolean));
      // Joined version kept for backward-compat logging
      const _titleishVals = _titleishArr.join(' ');
      // Non-modal input values + CE + body
      const _nonModalLower = _dom.split('\n')
        .filter(l => l.startsWith('INPUT:[nonmodal]') || l.startsWith('CE:') || l.startsWith('BODY:'))
        .map(l => l.replace(/^INPUT:\[nonmodal\]\s*|^CE:\s*|^BODY:\s*/, ''))
        .join('\n')
        .toLowerCase();

      const matched = [];
      const missing = [];
      for (const p of phrases) {
        const pLower = p.toLowerCase();
        const isTitled = titledPhrases.some(tp => tp.toLowerCase() === pLower);
        if (isTitled) {
          // For titled phrases ("titled 'X'"), the title should BE X — not just
          // contain X embedded in a default value. Containment (includes) would
          // pass for "Untitled dQ3 Planning Notesocument" (append) and
          // "Q3 Planning NotesUntitled document" (prepend). Instead:
          //   - Input values: exact match (after trim)
          //   - document.title: exact match OR starts with phrase + remainder
          //     matches a separator pattern ( - , | , — , – ) to allow the common
          //     "Title - AppName" suffix that browsers add to document.title.
          // Language-agnostic — no hardcoded default-name or app-name patterns.
          const _inputExact = _titleishArr.some(v => v === pLower);
          const _titleTrim = _titleLower.trim();
          const _titleExact = _titleTrim === pLower;
          // Allow "Phrase - AppName" / "Phrase | AppName" / "Phrase — AppName" suffix
          const _titleWithSuffix = _titleTrim.length > pLower.length &&
            _titleTrim.startsWith(pLower) &&
            /^\s*(?:-|\||—|–)\s+\S/.test(_titleTrim.slice(pLower.length));
          if (_inputExact || _titleExact || _titleWithSuffix) {
            matched.push(p);
          } else {
            missing.push(p);
          }
        } else {
          // Must be in body text, contenteditable, or non-modal input value
          if (_nonModalLower.includes(pLower)) {
            matched.push(p);
          } else {
            missing.push(p);
          }
        }
      }
      if (missing.length === 0) {
        // ── Structural completeness gate (Fix 3) ──
        // Phrase matching found everything, but the goal may have unverified
        // structural requirements (list with N items). Keep the turn-loop going
        // until satisfied.
        // Fix 37: Removed menuOpen gate — it produced false positives on apps
        // with always-visible combobox/option elements (Google Docs toolbar).
        // The list intent gate handles the Notion slash command case. If the
        // text is in the DOM, it's committed — the goal is achieved.
        let _gate = { listIntent: false, required: 0, found: 0 };
        if (_page) {
          _gate = await _page.evaluate((goalText) => {
            // List/todo count — only when goal has list intent
            const _numWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
            const _listIntent = /\b(to-?do\s+list|todo\s+list|checklist|task\s+list|to-?dos?|bullets?|numbered\s+list)\b/i.test(goalText);
            let _required = 0;
            if (_listIntent) {
              const _cntRe = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:items?|todos?|to-dos?|tasks?|entries|things)/i;
              const _cm = goalText.match(_cntRe);
              if (_cm) {
                const _w = _cm[1].toLowerCase();
                _required = /^\d+$/.test(_w) ? parseInt(_w,10) : (_numWords[_w] || 0);
              }
              if (_required === 0) _required = 1; // list intent but no count → at least 1
            }
            let _found = 0;
            if (_listIntent && _required > 0) {
              const _root = document.querySelector('.notion-page-content') ||
                document.querySelector('[data-content-editable-root]') ||
                document.querySelector('main') || document.body;
              if (_root) {
                _found = _root.querySelectorAll('[role="checkbox"]').length;
                if (_found === 0) _found = _root.querySelectorAll('li, [role="listitem"]').length;
              }
            }
            return { listIntent: _listIntent, required: _required, found: _found };
          }, goal || '').catch(() => ({ listIntent: false, required: 0, found: 0 }));
        } else {
          // Fallback: session not engine-owned — use browserAct evaluate for the structural gate
          try {
            const _baRes = await browserAct({ action: 'evaluate', text: `(() => {
              const goalText = ${JSON.stringify(goal || '')};
              const _numWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
              const _listIntent = /\\b(to-?do\\s+list|todo\\s+list|checklist|task\\s+list|to-?dos?|bullets?|numbered\\s+list)\\b/i.test(goalText);
              let _required = 0;
              if (_listIntent) {
                const _cntRe = /\\b(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(?:items?|todos?|to-dos?|tasks?|entries|things)/i;
                const _cm = goalText.match(_cntRe);
                if (_cm) {
                  const _w = _cm[1].toLowerCase();
                  _required = /^\\d+$/.test(_w) ? parseInt(_w,10) : (_numWords[_w] || 0);
                }
                if (_required === 0) _required = 1;
              }
              let _found = 0;
              if (_listIntent && _required > 0) {
                const _root = document.querySelector('.notion-page-content') ||
                  document.querySelector('[data-content-editable-root]') ||
                  document.querySelector('main') || document.body;
                if (_root) {
                  _found = _root.querySelectorAll('[role="checkbox"]').length;
                  if (_found === 0) _found = _root.querySelectorAll('li, [role="listitem"]').length;
                }
              }
              return JSON.stringify({ listIntent: _listIntent, required: _required, found: _found });
            })()`, sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
            if (_baRes?.ok) {
              const _raw = typeof _baRes.result === 'string' ? _baRes.result.replace(/^"|"$/g, '') : String(_baRes.result || '{}');
              try { _gate = JSON.parse(_raw); } catch (_) {}
            }
          } catch (_) {}
        }

        if (_gate.listIntent && _gate.found < _gate.required) {
          logger.warn(`${_logTag}: BLOCKED (DOM) — all phrases found but list incomplete: found=${_gate.found} required=${_gate.required}`);
          return { pass: false, reason: `List incomplete: found ${_gate.found} of ${_gate.required} required items`, source: 'dom', matchedPhrases: matched, missingPhrases: [] };
        }

        logger.info(`${_logTag}: PASS (DOM) — all ${phrases.length} phrase(s) found [titled=${titledPhrases.length}] matched=${JSON.stringify(matched)} gate=passed(list=${_gate.found}/${_gate.required})`);
        return { pass: true, reason: `All ${phrases.length} goal phrase(s) found in expected locations`, source: 'dom', matchedPhrases: matched, missingPhrases: [] };
      }
      // Phrases extracted but some missing → FAIL (don't fall through to VLM,
      // because the DOM check is authoritative when phrases exist).
      logger.warn(`${_logTag}: FAIL (DOM) — ${missing.length}/${phrases.length} phrase(s) missing [titled=${titledPhrases.length}] missing=${JSON.stringify(missing)} title="${_titleLower.slice(0,80)}" titleishVals="${_titleishVals.slice(0,80)}"`);
      return { pass: false, reason: `Goal phrases missing from expected locations: ${missing.join(', ')}`, source: 'dom', matchedPhrases: matched, missingPhrases: missing };
    }
    // DOM check errored → fall through to VLM
    logger.warn(`${_logTag}: DOM check errored — falling back to VLM`);
  } else {
    logger.info(`${_logTag}: no phrases extracted from goal — using VLM only`);
  }

  // ── Tier 2: VLM screenshot grading ──
  // Fallback when Tier 0 (LLM) and Tier 1 (DOM phrases) both yielded nothing.
  // If VLM is also unavailable, return source:'unavailable' (NOT 'inconclusive')
  // so the caller's `source !== 'inconclusive'` check treats it as a hard fail
  // and falls through to the turn-loop. This prevents false-success when all
  // verification paths are down (the root cause of add-to-playlist tasks that
  // only searched then reported success).
  try {
    const _ssRes = await browserAct({ action: 'screenshot', sessionId, headed, timeoutMs: 5000 }).catch(() => ({ ok: false }));
    if (!_ssRes.ok || !_ssRes.result) {
      logger.warn(`${_logTag}: VLM tier skipped — screenshot failed`);
      return { pass: false, reason: 'goal verification unavailable (no phrases, screenshot failed)', source: 'unavailable', matchedPhrases: [], missingPhrases: phrases };
    }
    const _vlm = await _vlmVerifyScreenshot(_ssRes.result, goal, pageType);
    if (_vlm && _vlm.verified === true) {
      logger.info(`${_logTag}: PASS (VLM) — ${_vlm.reasoning || 'screenshot matches goal'} (conf=${_vlm.confidence})`);
      return { pass: true, reason: `VLM verified: ${_vlm.reasoning || 'screenshot matches goal'}`, source: 'vlm', matchedPhrases: [], missingPhrases: [] };
    }
    if (_vlm && _vlm.verified === false) {
      logger.warn(`${_logTag}: FAIL (VLM) — ${_vlm.reasoning || 'screenshot does not match goal'} (conf=${_vlm.confidence})`);
      return { pass: false, reason: `VLM failed: ${_vlm.reasoning || 'screenshot does not match goal'}`, source: 'vlm', matchedPhrases: [], missingPhrases: phrases };
    }
    // VLM null/unavailable — can't confirm or deny. Return 'unavailable' so the
    // caller treats this as a fail (not a false-success 'inconclusive').
    logger.warn(`${_logTag}: unavailable (VLM unavailable/uncertain) — returning fail to avoid false positive`);
    return { pass: false, reason: 'goal verification unavailable (no phrases, VLM unavailable)', source: 'unavailable', matchedPhrases: [], missingPhrases: phrases };
  } catch (e) {
    logger.warn(`${_logTag}: VLM tier error (non-fatal): ${e.message}`);
    return { pass: false, reason: `goal verification error: ${e.message}`, source: 'unavailable', matchedPhrases: [], missingPhrases: phrases };
  }
}

// ---------------------------------------------------------------------------
// Script-URL fast path — deterministic compose-and-submit (no LLM needed)
// Called when URL matches a compose pattern and goal has extractable text.
// Uses Playwright Node API directly for speed (2-5s vs 30-120s LLM path).
// Returns a result object on success/failure, or null to fall through to LLM.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// OCR helpers — hide/show ThinkDrop overlay + capture screen via screen.analyze
// Inlined (not requiring deprecated/overlayControl.cjs) to avoid module path issues.
// ---------------------------------------------------------------------------
async function _hideOverlay() {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3010, path: '/overlay/hide', method: 'POST', timeout: 2000, headers: { 'Content-Length': '0' } }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
async function _showOverlay() {
  const http = require('http');
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port: 3010, path: '/overlay/show', method: 'POST', timeout: 2000, headers: { 'Content-Length': '0' } }, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Capture screen via screen.analyze (port 3008) with overlay hidden.
// Returns { ok, text, appName, url, confidence } or { ok:false, error }.
//
// NOTE: This is the OS-level capture path. It hides the ThinkDrop overlay (POST
// /overlay/hide) before the screenshot and re-shows it after — which causes the
// unified window to flicker. For browser.agent runs (where playwright owns the
// page), prefer _ocrCaptureViaPage() which uses Playwright page.screenshot() +
// LiteParse and never touches the overlay. This function is now only the fallback
// for paths that have no engine page (rare).
async function _ocrCapture() {
  const SCREEN_HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
  const SCREEN_PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
  const http = require('http');
  await _hideOverlay();
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
    if (!result?.success) return { ok: false, error: result?.error || 'screen.analyze failed' };
    return { ok: true, text: result.text || '', appName: result.appName, url: result.url, confidence: result.confidence };
  } finally {
    await _showOverlay();
  }
}

// Page-level OCR capture: Playwright page.screenshot() → LiteParse CLI.
// Returns the same shape as _ocrCapture ({ ok, text, appName?, url?, confidence? })
// so callers can be swapped transparently. No overlay hide/show — the screenshot
// is taken from inside the playwright-owned page, so the Electron overlay never
// appears in it. Falls back to _ocrCapture() (OS-level, with overlay hide) only
// when no engine page is available for the session.
//
// Accepts either a sessionId (string) or a Playwright page object. When given a
// sessionId, resolves the engine page; when given a page, uses it directly.
async function _ocrCaptureViaPage(sessionIdOrPage = 'playwright_agent') {
  let _page = null;
  if (sessionIdOrPage && typeof sessionIdOrPage === 'object' && typeof sessionIdOrPage.screenshot === 'function') {
    _page = sessionIdOrPage;
  } else {
    try { _page = engine.getPage(sessionIdOrPage); } catch (_) {}
  }
  if (!_page) {
    // No engine page — fall back to OS-level capture (rare; only outside browser.agent).
    return _ocrCapture();
  }
  try {
    const _cap = await _liteparseCapture(_page);
    if (!_cap.ok) return { ok: false, error: _cap.error || 'liteparse capture failed' };
    // Recover the live URL for callers that use it (e.g. _ocrVerify logging).
    let _url = null;
    try { _url = await _page.evaluate(() => window.location.href).catch(() => null); } catch (_) {}
    return {
      ok: true,
      text: _cap.fullText || '',
      // LiteParse doesn't surface appName/confidence — leave undefined so callers
      // that log them degrade gracefully.
      appName: undefined,
      url: _url,
      confidence: undefined,
    };
  } catch (e) {
    return { ok: false, error: `liteparse capture error: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// OCR-based verification — uses user-memory-service (getRecentOcr) and
// page-level LiteParse capture (_ocrCaptureViaPage) to verify what's visible.
// Two-tier: getRecentOcr (free, may be stale) → page LiteParse (fresh, no overlay hide).
// ---------------------------------------------------------------------------

// Shared selectors — used by every frame-aware DOM helper below.
// _MODAL_SEL_GENERIC: standard ARIA modal selectors — work across all apps.
// _MODAL_SEL_BROAD:   generic + app-specific extensions (.artdeco-modal for LinkedIn,
//   .share-creation / #interop-outlet for LinkedIn share dialogs). Used in broadened
//   detection where the extra selectors catch edge cases without false-positiving on
//   apps that use standard ARIA dialogs.
const _MODAL_SEL_GENERIC = '[role="dialog"], [aria-modal="true"], [role="alertdialog"], [data-testid*="modal"], [data-testid*="share"]';
const _MODAL_SEL_BROAD = _MODAL_SEL_GENERIC + ', .artdeco-modal, .share-creation, #interop-outlet';
// Default: use the broad selector for backward compatibility (existing callers expect
// _MODAL_SEL to include the app-specific extensions). New code should prefer
// _MODAL_SEL_GENERIC for standard detection, _MODAL_SEL_BROAD for fallback/broadened.
const _MODAL_SEL = _MODAL_SEL_BROAD;
const _COMPOSE_SEL = '[contenteditable="true"], [contenteditable=""], .ql-editor, [role="textbox"], [role="searchbox"], [role="combobox"], textarea, input[type="text"], input[type="search"]';
// Labels that START a flow (or cancel it) and must never be clicked as a submit.
const _START_LABEL_RE = /^(start a post|start|new|compose|write|log ?in|sign ?in|cancel|close|discard|go back|back|dismiss|next|add a photo|add media)\b/i;

// Log a one-shot diagnostic of every frame so we can see WHERE the compose surface lives.
// This is what identifies "the composer is in a child frame" in a single run.
async function _logFrameDiagnostic(page, label = '') {
  try {
    const _frames = page.frames();
    logger.info(`[playwright.agent] frame diagnostic${label ? ` (${label})` : ''}: ${_frames.length} frame(s)`);
    for (let i = 0; i < _frames.length; i++) {
      const f = _frames[i];
      const _info = await f.evaluate(({ composeSel, modalSel }) => {
        const compose = Array.from(document.querySelectorAll(composeSel));
        const visibleCompose = compose.filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).filter(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        return {
          composeCount: compose.length,
          visibleComposeCount: visibleCompose.length,
          composeText: visibleCompose.slice(0, 2).map(el => (el.innerText || el.value || '').slice(0, 40)),
          modalCount: document.querySelectorAll(modalSel).length,
          bodyLen: (document.body?.innerText || '').length,
          buttonLabels: btns.slice(0, 12).map(b => ((b.innerText || b.value || '').trim() || b.getAttribute('aria-label') || '').slice(0, 25)).filter(Boolean),
        };
      }, { composeSel: _COMPOSE_SEL, modalSel: _MODAL_SEL }).catch((e) => ({ error: e.message }));
      logger.info(`[playwright.agent]   frame[${i}]${f === page.mainFrame() ? ' (main)' : ''} url=${(f.url() || '').slice(0, 80)} ${JSON.stringify(_info)}`);
    }
  } catch (e) {
    logger.warn(`[playwright.agent] frame diagnostic failed: ${e.message}`);
  }
}

// Find the frame that owns the compose surface. Returns { frame, isMain, reason }.
// Prefers a frame with a visible compose element containing `expectText` (when given),
// then any frame with a visible compose element, then the main frame.
async function _findComposeFrame(page, expectText = null) {
  const _snippet = expectText ? expectText.slice(0, 20).toLowerCase() : null;
  let _best = null;
  try {
    for (const f of page.frames()) {
      const _info = await f.evaluate(({ composeSel, snippet }) => {
        const compose = Array.from(document.querySelectorAll(composeSel)).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.getAttribute('aria-hidden') !== 'true';
        });
        let withText = 0;
        for (const el of compose) {
          const t = (el.innerText || el.textContent || el.value || '').toLowerCase();
          if (snippet && t.includes(snippet)) withText++;
        }
        return { visibleCompose: compose.length, withText };
      }, { composeSel: _COMPOSE_SEL, snippet: _snippet }).catch(() => null);
      if (!_info) continue;
      // Highest priority: a frame whose compose element already holds our text
      if (_info.withText > 0) {
        logger.info(`[playwright.agent] compose frame: found text in frame url=${(f.url() || '').slice(0, 70)} (isMain=${f === page.mainFrame()})`);
        return { frame: f, isMain: f === page.mainFrame(), reason: 'has-text' };
      }
      if (_info.visibleCompose > 0 && (!_best || _info.visibleCompose > _best.count)) {
        _best = { frame: f, count: _info.visibleCompose };
      }
    }
  } catch (e) {
    logger.warn(`[playwright.agent] compose frame search error: ${e.message}`);
  }
  if (_best) {
    logger.info(`[playwright.agent] compose frame: using frame with ${_best.count} visible compose el(s) url=${(_best.frame.url() || '').slice(0, 70)} (isMain=${_best.frame === page.mainFrame()})`);
    return { frame: _best.frame, isMain: _best.frame === page.mainFrame(), reason: 'has-compose' };
  }
  logger.warn(`[playwright.agent] compose frame: no frame has a visible compose element — falling back to main frame`);
  return { frame: page.mainFrame(), isMain: true, reason: 'fallback-main' };
}

// Capture pre-click UI state for comparison after submit.
// Returns { url, modalCount, visibleModalCount, modalTexts, bodyLen, composeText }.
// `frameOrPage` may be a Frame — the composer often lives in a child frame.
async function _captureUiState(page, frameOrPage = null) {
  const _target = frameOrPage || page;
  const _empty = { url: '', modalCount: 0, visibleModalCount: 0, modalTexts: [], bodyLen: 0, composeCount: 0, composeTexts: [] };
  try {
    const _state = await _target.evaluate(({ modalSel, composeSel }) => {
      const modals = Array.from(document.querySelectorAll(modalSel));
      const visibleModals = modals.filter(m => {
        if (m.getAttribute('aria-hidden') === 'true') return false;
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const compose = Array.from(document.querySelectorAll(composeSel)).filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && el.getAttribute('aria-hidden') !== 'true';
      });
      return {
        url: window.location.href.slice(0, 100),
        bodyLen: (document.body?.innerText || '').length,
        modalCount: modals.length,
        visibleModalCount: visibleModals.length,
        modalTexts: visibleModals.slice(0, 3).map(m => (m.innerText || '').slice(0, 200).trim()),
        composeCount: compose.length,
        // Compose contents are the primary success signal: a successful post clears them.
        composeTexts: compose.slice(0, 3).map(el => (el.innerText || el.textContent || el.value || '').trim()),
      };
    }, { modalSel: _MODAL_SEL, composeSel: _COMPOSE_SEL });
    return _state || _empty;
  } catch (e) {
    return { ..._empty, error: e.message };
  }
}

// Verify submit via UI state change. Polled for up to timeoutMs.
// - Failure (hard): a NEW dialog appeared matching discard/unsaved/leave patterns → click hit backdrop.
// - Success: our text is gone from the composer (cleared) or the compose surface closed.
//   Composer-cleared is the strongest universal signal — every site clears/closes on success.
// - Inconclusive: composer still holds our text.
// `frameOrPage` must be the frame that owns the composer (see _findComposeFrame).
async function _verifySubmitViaUiState(page, preClickState, timeoutMs = 6000, frameOrPage = null, expectText = null) {
  const _discardRe = /discard|are you sure|unsaved|leave.*(page|draft)|go back|cancel.*post/i;
  const _snippet = expectText ? expectText.slice(0, 20).toLowerCase() : null;
  // Did the composer hold our text before the click? Only then can "cleared" mean anything.
  const _hadText = _snippet ? (preClickState.composeTexts || []).some(t => (t || '').toLowerCase().includes(_snippet)) : false;
  const _start = Date.now();
  while (Date.now() - _start < timeoutMs) {
    try {
      const _after = await _captureUiState(page, frameOrPage);
      // Hard failure: a NEW dialog matching discard/unsaved appeared
      const _newModalTexts = (_after.modalTexts || []).filter(t => !(preClickState.modalTexts || []).includes(t));
      const _discardDialog = _newModalTexts.find(t => _discardRe.test(t));
      if (_discardDialog) {
        return { ok: false, reason: 'confirm-dialog-appeared', dialogText: _discardDialog.slice(0, 150) };
      }
      // Primary success signal: the composer held our text and no longer does.
      if (_hadText) {
        const _stillHasText = (_after.composeTexts || []).some(t => (t || '').toLowerCase().includes(_snippet));
        if (!_stillHasText) {
          return { ok: true, reason: 'composer-cleared', composeCount: _after.composeCount };
        }
      }
      // Secondary: the compose surface itself disappeared (modal closed / composer unmounted)
      if (preClickState.composeCount > 0 && _after.composeCount === 0) {
        return { ok: true, reason: 'composer-closed', before: preClickState.composeCount, after: 0 };
      }
      if (preClickState.visibleModalCount > 0 && _after.visibleModalCount < preClickState.visibleModalCount) {
        return { ok: true, reason: 'modal-closed', before: preClickState.visibleModalCount, after: _after.visibleModalCount };
      }
    } catch (e) {
      // Page may be navigating — keep polling
    }
    await page.waitForTimeout(300);
  }
  return { ok: null, reason: _hadText ? 'inconclusive-text-still-present' : 'inconclusive-no-baseline-text' };
}

// Recovery from a confirm/discard dialog — press the non-destructive option so the draft survives.
async function _recoverFromConfirmDialog(page, frameOrPage = null) {
  const _target = frameOrPage || page;
  try {
    // Try to click a "Go back" / "Cancel" / "Keep" button first
    const _recovered = await _target.evaluate(() => {
      const _btnSel = 'button, [role="button"]';
      const btns = Array.from(document.querySelectorAll(_btnSel));
      const _keepRe = /^(go back|cancel|keep|don.?t discard|keep editing|stay)$/i;
      for (const b of btns) {
        const text = (b.innerText || b.textContent || '').trim().toLowerCase();
        const r = b.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && _keepRe.test(text)) {
          b.click();
          return { ok: true, method: 'click', text };
        }
      }
      return { ok: false };
    });
    if (_recovered.ok) {
      logger.info(`[playwright.agent] recovery: clicked "${_recovered.text}" to dismiss discard dialog`);
      return;
    }
    // Fallback: press Escape
    await page.keyboard.press('Escape').catch(() => {});
    logger.info(`[playwright.agent] recovery: pressed Escape to dismiss discard dialog`);
  } catch (e) {
    logger.warn(`[playwright.agent] recovery error: ${e.message}`);
  }
}

// Network-based submit verification — check if POST/PUT/PATCH/DELETE with 2xx + payload contains text
// Strict version: does NOT accept "payload doesn't contain text — accepting".
// Requires: payload contains the first 20 chars of expected text, OR the URL looks like a content
// mutation endpoint AND is not telemetry.
async function _verifySubmitViaNetwork(sessionId, submitClickTs, expectedText) {
  try {
    const _netLog = engine.getNetLog(sessionId);
    const _relevant = _netLog.filter(e => e.ts >= submitClickTs - 500 && /^(POST|PUT|PATCH|DELETE)$/.test(e.method));
    if (_relevant.length === 0) {
      logger.info(`[playwright.agent] network verify: no mutation requests after submit click`);
      return { ok: false, reason: 'no-mutation-requests' };
    }
    const _success = _relevant.find(e => e.status >= 200 && e.status < 300);
    if (!_success) {
      const _errors = _relevant.filter(e => e.status >= 400);
      logger.info(`[playwright.agent] network verify: ${_relevant.length} requests, no 2xx, ${_errors.length} errors`);
      return { ok: false, reason: 'no-success-status', requests: _relevant.map(e => `${e.method} ${e.url.slice(0, 60)} → ${e.status}`) };
    }
    // Path 1: payload contains the first 20 chars of our text → strong evidence of content submission
    if (expectedText && _success.payload) {
      const _snippet = expectedText.slice(0, 20).toLowerCase();
      if (_success.payload.toLowerCase().includes(_snippet)) {
        logger.info(`[playwright.agent] network verify: 2xx + payload contains text — verified`);
        return { ok: true, reason: '2xx-with-text', method: _success.method, url: _success.url.slice(0, 80), status: _success.status };
      }
    }
    // Path 2: URL looks like a content mutation endpoint (not telemetry) → accept
    const _mutationRe = /\/graphql|\/voyager\/api|\/api\/|create|share|post|submit|send/i;
    const _telCheckRe = /analytics|telemetry|beacon|metrics|sentry|collect|track|amplitude|datadog|newrelic|rum|perf|\btapi\b|gen_?204|pixel|csp-report|\/li\/track|clienttelemetry|ingraph/i;
    if (_mutationRe.test(_success.url) && !_telCheckRe.test(_success.url)) {
      logger.info(`[playwright.agent] network verify: 2xx + mutation URL (no payload match) — verified (${_success.method} ${_success.url.slice(0, 60)} → ${_success.status})`);
      return { ok: true, reason: '2xx-mutation-url', method: _success.method, url: _success.url.slice(0, 80), status: _success.status };
    }
    // Otherwise: only telemetry or unrelated 2xx — NOT verified
    logger.info(`[playwright.agent] network verify: 2xx but only telemetry/unrelated URL — NOT verified (${_success.method} ${_success.url.slice(0, 60)} → ${_success.status})`);
    return { ok: false, reason: 'only-telemetry-or-unrelated-2xx', method: _success.method, url: _success.url.slice(0, 80), status: _success.status };
  } catch (e) {
    logger.warn(`[playwright.agent] network verify error: ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// Wait for a compose element (contenteditable / textarea / input / role=textbox) to be
// focused and visible. Replaces the old fixed `waitForTimeout(2000)` which returned before
// the modal/compose box existed, causing a lost-prefix typing race.
//
// If a modal is present but nothing inside it is focused, click the first visible compose
// element to focus it, then re-check. Returns { focused, tag, role, inModal, focusTimeout }.
// `frameOrPage` may be a Page or a Frame — the compose surface often lives in a child frame.
async function _waitForComposeFocus(page, timeoutMs = 12000, frameOrPage = null) {
  const _target = frameOrPage || page;
  const _start = Date.now();
  let _lastLog = 0;
  let _evalErrLogged = false;
  let _clickAttempts = 0;
  let _triggerClickAttempts = 0;
  let _urlRetryDone = false;
  while (Date.now() - _start < timeoutMs) {
    try {
      // NOTE: page.evaluate accepts exactly ONE argument — always pass a single object.
      const _state = await _target.evaluate(({ modalSel, composeSel }) => {
        const modal = document.querySelector(modalSel);
        const modalRect = modal ? modal.getBoundingClientRect() : null;
        const inModal = !!modal && modalRect.width > 0 && modalRect.height > 0;
        const ae = document.activeElement;
        if (!ae) return { focused: false, inModal };
        const aeRect = ae.getBoundingClientRect();
        const aeVisible = aeRect.width > 0 && aeRect.height > 0;
        const isCompose = ae.matches(composeSel) || ae.getAttribute('contenteditable') === 'true' ||
          ae.getAttribute('role') === 'textbox' || ae.getAttribute('role') === 'searchbox' ||
          ae.getAttribute('role') === 'combobox' || ae.tagName === 'TEXTAREA' ||
          (ae.tagName === 'INPUT' && /^(text|search|email|url)$/i.test(ae.type || ''));
        if (isCompose && aeVisible) {
          return { focused: true, tag: ae.tagName, role: ae.getAttribute('role'), inModal,
            ce: ae.getAttribute('contenteditable'), rect: { x: aeRect.x, y: aeRect.y, w: aeRect.width, h: aeRect.height } };
        }
        // Nothing compose-like focused — find a visible compose element to click. Prefer one
        // inside the modal, but fall back to any visible compose element in this document
        // (the composer may not be wrapped in a detectable modal container).
        const scope = inModal ? modal : document;
        const visible = Array.from(scope.querySelectorAll(composeSel)).find(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && el.getAttribute('aria-hidden') !== 'true';
        });
        if (visible) return { focused: false, inModal, needsClick: true };
        return { focused: false, inModal };
      }, { modalSel: _MODAL_SEL, composeSel: _COMPOSE_SEL });

      if (_state.focused) {
        logger.info(`[playwright.agent] waiting for compose focus: focused=true tag=${_state.tag} role=${_state.role || 'n/a'} inModal=${_state.inModal} (${Date.now() - _start}ms)`);
        // Settle delay — LinkedIn re-mounts the Quill editor right after focus.
        await page.waitForTimeout(400);
        return _state;
      }
      if (_state.needsClick) {
        // Click the first visible compose element to focus it.
        const _clicked = await _target.evaluate(({ modalSel, composeSel }) => {
          const modal = document.querySelector(modalSel);
          const mR = modal ? modal.getBoundingClientRect() : null;
          const scope = (modal && mR.width > 0 && mR.height > 0) ? modal : document;
          const cand = Array.from(scope.querySelectorAll(composeSel)).find(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && el.getAttribute('aria-hidden') !== 'true';
          });
          if (cand) { cand.focus(); cand.click(); return true; }
          return false;
        }, { modalSel: _MODAL_SEL, composeSel: _COMPOSE_SEL }).catch((e) => {
          logger.warn(`[playwright.agent] waiting for compose focus: focus-click evaluate failed: ${e.message}`);
          return false;
        });
        if (_clicked) logger.info(`[playwright.agent] waiting for compose focus: clicked compose element to focus`);
        _clickAttempts++;
      }
      // Recovery: when no compose element is found and no modal is open, try in order:
      // 1. URL-first retry (re-navigate to shareActive=true URL) — most deterministic.
      //    The URL parameter is the canonical way to open the share modal. If it failed
      //    once, it may have been a transient render race. Only fires once, and only
      //    when the URL matches a compose pattern.
      // 2. Trigger-click fallback ("Start a post", "What's on your mind?") — less
      //    deterministic but reliable. Up to 2 attempts.
      const _noComposeFound = !_state.focused && !_state.needsClick && !_state.inModal;
      if (_noComposeFound && !_urlRetryDone) {
        _urlRetryDone = true;
        let _curUrl = '';
        try { _curUrl = page.url(); } catch (_) {}
        if (/shareActive=true|compose\/post|compose=new|\/compose\b/i.test(_curUrl)) {
          logger.info(`[playwright.agent] waiting for compose focus: no modal — retrying URL-first navigation to ${_curUrl}`);
          try {
            await page.goto(_curUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000); // let SPA hydrate + modal render
          } catch (_navErr) {
            logger.warn(`[playwright.agent] waiting for compose focus: URL retry failed: ${_navErr.message}`);
          }
          continue; // re-check state after navigation
        }
      }
      // Trigger-click fallback: fire immediately when no compose found (after URL retry),
      // or after 3 unsuccessful compose clicks (the original gate for the case where
      // compose elements ARE found but clicking them doesn't focus them).
      if (!_state.focused && (_noComposeFound || _clickAttempts >= 3) && _triggerClickAttempts < 2) {
        _triggerClickAttempts++;
        const _triggerClicked = await _target.evaluate(() => {
          // Look for common post-composer triggers across social platforms
          const candidates = Array.from(document.querySelectorAll('div[role="button"], button, [role="button"]')).filter(el => {
            const text = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            return /what'?s on your mind|create (a )?post|start a post|write something|share what|new post/i.test(text);
          });
          if (candidates.length > 0) {
            candidates[0].click();
            return (candidates[0].innerText || candidates[0].getAttribute('aria-label') || '').slice(0, 40);
          }
          return null;
        }).catch(() => null);
        if (_triggerClicked) {
          logger.info(`[playwright.agent] waiting for compose focus: clicked post-composer trigger "${_triggerClicked}" (attempt ${_triggerClickAttempts}, clickAttempts=${_clickAttempts})`);
          await page.waitForTimeout(800); // let the modal open
        }
      }
      if (Date.now() - _lastLog > 1000) {
        logger.info(`[playwright.agent] waiting for compose focus: focused=false inModal=${_state.inModal} needsClick=${!!_state.needsClick} (${Date.now() - _start}ms)`);
        _lastLog = Date.now();
      }
    } catch (e) {
      // Do NOT swallow silently — a broken probe must not masquerade as "not ready yet".
      if (!_evalErrLogged) {
        logger.warn(`[playwright.agent] waiting for compose focus: evaluate error (will keep polling): ${e.message}`);
        _evalErrLogged = true;
      }
    }
    await page.waitForTimeout(250);
  }
  logger.warn(`[playwright.agent] waiting for compose focus: TIMEOUT after ${timeoutMs}ms — proceeding anyway`);
  return { focused: false, focusTimeout: true, inModal: false };
}

// Generalized DOM verify — check if ANY field contains expected text
// Checks contenteditable (innerText), inputs/textareas (.value), role=textbox
// Returns { ok, fieldFound, fieldText, type, tag }:
//   ok=true         — a field's text contains the snippet (verified)
//   fieldFound=true, ok=false — a compose field exists but its text is WRONG (truncation)
//   fieldFound=false — no compose field readable at all (OCR fallback is legitimate)
// Searches EVERY frame — the compose surface is frequently in a child frame, and querying
// only the main frame reports a false "no compose field found".
// Also returns `frame` so callers can reuse the frame that owns the composer.
async function _domVerify(page, expectText) {
  const _snippet = expectText.slice(0, 20).toLowerCase();
  const _probe = (snippet) => {
    // contenteditable + role=textbox + .ql-editor (use innerText)
    const editable = document.querySelectorAll('[contenteditable], [role="textbox"], .ql-editor');
    let _firstFieldText = null, _firstFieldTag = null;
    for (const el of editable) {
      const _t = (el.innerText || el.textContent || '');
      if (_t.toLowerCase().includes(snippet)) return { ok: true, fieldFound: true, fieldText: _t, type: 'contenteditable', tag: el.tagName };
      if (_firstFieldText === null && _t.trim().length > 0) { _firstFieldText = _t; _firstFieldTag = el.tagName; }
    }
    // input + textarea (use .value)
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input[type="email"], input[type="url"], input:not([type]), textarea');
    for (const el of inputs) {
      const _t = (el.value || '');
      if (_t.toLowerCase().includes(snippet)) return { ok: true, fieldFound: true, fieldText: _t, type: 'input', tag: el.tagName };
      if (_firstFieldText === null && _t.trim().length > 0) { _firstFieldText = _t; _firstFieldTag = el.tagName; }
    }
    // fieldFound=true if we found a compose field with any text (even if it didn't match)
    if (_firstFieldText !== null) return { ok: false, fieldFound: true, fieldText: _firstFieldText, type: 'contenteditable', tag: _firstFieldTag };
    return { ok: false, fieldFound: false };
  };

  let _bestPartial = null;
  try {
    for (const f of page.frames()) {
      const _found = await f.evaluate(_probe, _snippet).catch(() => null);
      if (!_found) continue;
      if (_found.ok) {
        logger.info(`[playwright.agent] DOM verify: found text in ${_found.type} <${_found.tag}> — verified (frame=${f === page.mainFrame() ? 'main' : (f.url() || '').slice(0, 50)})`);
        return { ..._found, frame: f };
      }
      if (_found.fieldFound && !_bestPartial) _bestPartial = { ..._found, frame: f };
    }
  } catch (e) {
    logger.warn(`[playwright.agent] DOM verify error: ${e.message}`);
    return { ok: false, fieldFound: false, error: e.message };
  }
  if (_bestPartial) {
    logger.info(`[playwright.agent] DOM verify: field found but text does not match (fieldLen=${(_bestPartial.fieldText||'').length}, frame=${_bestPartial.frame === page.mainFrame() ? 'main' : (_bestPartial.frame.url() || '').slice(0, 50)})`);
    return _bestPartial;
  }
  logger.info(`[playwright.agent] DOM verify: no compose field found in any of ${page.frames().length} frame(s)`);
  return { ok: false, fieldFound: false };
}

// Generalized deterministic action — try to click submit/post/send/create button
// Uses fuzzy matching (includes/startsWith) so "Submit Application", "Post Check", etc. match
async function _deterministicAction(page, goal, frameOrPage = null) {
  const _target = frameOrPage || page;
  // Labels that START/cancel a flow must never be clicked as a submit. Without this,
  // keyword "post" fuzzy-matched "Start a post" and re-opened the composer.
  const _startLabelSrc = _START_LABEL_RE.source;
  const _goalLower = goal.toLowerCase();
  // Determine action keywords from goal
  const _actionKeywords = [];
  if (/\bpost\b|\bshare\b|\btweet\b|\bpublish\b/.test(_goalLower)) _actionKeywords.push('post', 'share', 'tweet', 'publish');
  if (/\bsend\b|\bemail\b|\bmessage\b|\bdraft\b/.test(_goalLower)) _actionKeywords.push('send', 'send email', 'send message');
  if (/\bcreate\b|\bnew\b|\bsave\b/.test(_goalLower)) _actionKeywords.push('create', 'save', 'new', 'create document', 'create page');
  if (/\badd\b.*\bcart\b|\badd\b.*\bto\b.*\bcart\b/.test(_goalLower)) _actionKeywords.push('add to cart', 'add');
  if (/\bsubmit\b/.test(_goalLower)) _actionKeywords.push('submit', 'submit issue', 'create issue');
  if (/\bplay\b/.test(_goalLower)) _actionKeywords.push('play', 'play all', 'shuffle', 'play song');
  if (/\blike\b/.test(_goalLower)) _actionKeywords.push('like');
  if (_actionKeywords.length === 0) _actionKeywords.push('post', 'send', 'submit', 'create', 'save'); // fallback

  logger.info(`[playwright.agent] deterministic action: keywords=[${_actionKeywords.join(', ')}]`);

  // Try by button text (fuzzy — includes/startsWith matching)
  for (const keyword of _actionKeywords) {
    try {
      const _clicked = await _target.evaluate(({ kw, startSrc }) => {
        const startRe = new RegExp(startSrc, 'i');
        const btns = document.querySelectorAll('button, [role="button"], a[role="button"], input[type="submit"]');
        for (const btn of btns) {
          const text = (btn.innerText || btn.value || '').trim().toLowerCase();
          // Never click a start/cancel action (e.g. "Start a post") as a submit
          if (startRe.test(text)) continue;
          // Fuzzy: button text includes keyword OR starts with keyword
          if ((text.includes(kw) || text.startsWith(kw)) && !btn.disabled) {
            btn.click();
            return { ok: true, text: btn.innerText || btn.value };
          }
        }
        return { ok: false };
      }, { kw: keyword, startSrc: _startLabelSrc });
      if (_clicked?.ok) {
        logger.info(`[playwright.agent] deterministic action: clicked button "${_clicked.text}" (matched keyword "${keyword}")`);
        return { ok: true, method: 'text-fuzzy', keyword, text: _clicked.text };
      }
    } catch (_) {}
  }

  // Try by aria-label (fuzzy)
  for (const keyword of _actionKeywords) {
    try {
      const _clicked = await _target.evaluate(({ kw, startSrc }) => {
        const startRe = new RegExp(startSrc, 'i');
        const els = document.querySelectorAll('[aria-label]');
        for (const el of els) {
          const label = (el.getAttribute('aria-label') || '').toLowerCase();
          if (startRe.test(label)) continue; // never click a start/cancel action as submit
          if (label.includes(kw) && !el.disabled) { el.click(); return { ok: true, label }; }
        }
        return { ok: false };
      }, { kw: keyword, startSrc: _startLabelSrc });
      if (_clicked?.ok) {
        logger.info(`[playwright.agent] deterministic action: clicked aria-label="${_clicked.label}" (matched keyword "${keyword}")`);
        return { ok: true, method: 'aria-label-fuzzy', keyword, label: _clicked.label };
      }
    } catch (_) {}
  }

  // Try generic submit selectors
  const _genericSelectors = [
    'button[type="submit"]:not([disabled])',
    'button.share-actions__primary-button:not([disabled])',
    'input[type="submit"]:not([disabled])',
  ];
  for (const sel of _genericSelectors) {
    try {
      const _clicked = await _target.evaluate((s) => {
        const e = document.querySelector(s);
        if (e && !e.disabled) { e.click(); return true; }
        return false;
      }, sel);
      if (_clicked) {
        logger.info(`[playwright.agent] deterministic action: clicked generic selector ${sel}`);
        return { ok: true, method: 'selector', selector: sel };
      }
    } catch (_) {}
  }

  logger.warn(`[playwright.agent] deterministic action: no matching button found`);
  return { ok: false };
}

// Submit via Playwright Locators — the primary submit path.
// Locators handle frame offsets, scrolling, actionability and occlusion automatically, which
// eliminates the whole class of "clicked the dimmed backdrop instead of the button" bugs that
// raw mouse.click(x, y) produced. Searches every frame, preferring the composer's frame.
// Returns { ok, text, method, frame } or { ok: false, reason }.
async function _locatorSubmit(page, goal, preferredFrame = null) {
  const _goalLower = (goal || '').toLowerCase();
  // Ordered submit labels — most specific/likely first, derived from the goal.
  const _labels = [];
  if (/\bpost\b|\bshare\b|\btweet\b|\bpublish\b/.test(_goalLower)) _labels.push('Post', 'Share', 'Publish', 'Tweet');
  if (/\bsend\b|\bemail\b|\bmessage\b/.test(_goalLower)) _labels.push('Send');
  if (/\bcomment\b|\breply\b/.test(_goalLower)) _labels.push('Reply', 'Comment');
  if (/\bsubmit\b/.test(_goalLower)) _labels.push('Submit');
  if (/\bcreate\b|\bsave\b/.test(_goalLower)) _labels.push('Create', 'Save');
  if (_labels.length === 0) _labels.push('Post', 'Send', 'Submit', 'Save');

  // Try the composer's frame first, then all others.
  const _frames = [];
  if (preferredFrame) _frames.push(preferredFrame);
  for (const f of page.frames()) if (f !== preferredFrame) _frames.push(f);

  for (const f of _frames) {
    const _isMain = f === page.mainFrame();
    for (const label of _labels) {
      try {
        // Exact, case-insensitive name match — excludes "Start a post" (which would only
        // match a non-exact/substring query).
        const _loc = f.getByRole('button', { name: new RegExp(`^\\s*${label}\\s*$`, 'i') });
        const _count = await _loc.count().catch(() => 0);
        if (_count === 0) continue;
        // Prefer the LAST match — submit buttons sit at the modal/form footer.
        const _btn = _loc.last();
        const _visible = await _btn.isVisible().catch(() => false);
        const _enabled = await _btn.isEnabled().catch(() => false);
        if (!_visible || !_enabled) {
          logger.info(`[playwright.agent] locator submit: "${label}" found (${_count}) but visible=${_visible} enabled=${_enabled} — skipping`);
          continue;
        }
        await _btn.click({ timeout: 5000 });
        logger.info(`[playwright.agent] locator submit: clicked "${label}" (${_count} match(es), frame=${_isMain ? 'main' : (f.url() || '').slice(0, 50)})`);
        return { ok: true, text: label, method: 'locator', keyword: label.toLowerCase(), frame: f };
      } catch (e) {
        logger.info(`[playwright.agent] locator submit: "${label}" click failed: ${e.message.split('\n')[0].slice(0, 120)}`);
      }
    }
  }
  logger.warn(`[playwright.agent] locator submit: no enabled submit button found for labels [${_labels.join(', ')}] across ${_frames.length} frame(s)`);
  return { ok: false, reason: 'no-locator-match' };
}

async function _ocrVerify(expectText, typeTs, page) {
  const _expectSnippet = expectText.slice(0, 30).toLowerCase();
  // Key words for fuzzy matching (>4 chars, significant)
  const _words = expectText.toLowerCase().split(/\s+/).filter(w => w.length > 4);

  // DOM-based modal detection (site-agnostic — replaces LinkedIn-specific regex)
  let _modalPresent = false;
  if (page) {
    try {
      _modalPresent = await page.evaluate(() => {
        const _modalSelectors = [
          '[role="dialog"]', '[aria-modal="true"]', '[role="alertdialog"]',
          '[data-testid*="modal"]', '[data-testid*="dialog"]', '[data-testid*="share"]',
          '.modal', '.dialog', '.overlay', '[class*="modal"]', '[class*="dialog"]'
        ];
        for (const sel of _modalSelectors) {
          if (document.querySelector(sel)) return true;
        }
        return false;
      }).catch(() => false);
    } catch (_) {}
  }

  function _fuzzyMatch(ocrLower) {
    // Exact snippet match (30 chars)
    if (ocrLower.includes(_expectSnippet)) return { match: true, source: 'exact' };
    // Key word matching (>40% of significant words)
    if (_words.length > 0) {
      const matched = _words.filter(w => ocrLower.includes(w));
      const ratio = matched.length / _words.length;
      if (ratio > 0.4) return { match: true, source: `fuzzy-${Math.round(ratio * 100)}pct` };
    }
    return { match: false };
  }

  // Tier 1: Quick check getRecentOcr — maybe monitor already captured the browser with our text
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
    if (capture) {
      const capturedAtTs = new Date(capture.capturedAt).getTime();
      const isFresh = capturedAtTs > typeTs;
      const ocrText = (capture.text || '').toLowerCase();
      const _fuzzy = _fuzzyMatch(ocrText);
      logger.info(`[playwright.agent] OCR verify (getRecentOcr): fresh=${isFresh} fuzzy=${_fuzzy.match} modalPresent=${_modalPresent} ocrLen=${ocrText.length} url=${capture.url || 'n/a'}`);
      if (isFresh && (_fuzzy.match || _modalPresent)) {
        return { success: true, verified: true, hasText: true, source: `getRecentOcr-${_fuzzy.source || 'modal'}` };
      }
    }
  } catch (e) { /* non-fatal — fall through to screen.analyze */ }

  // Tier 2: Fresh page-level capture via _ocrCaptureViaPage (Playwright screenshot → LiteParse).
  // Falls back to OS-level _ocrCapture (screen.analyze + overlay hide) only when no page is available.
  try {
    const _cap = await _ocrCaptureViaPage(page);
    if (!_cap.ok) return { success: false, error: _cap.error };
    const _ocrLower = _cap.text.toLowerCase();
    const _fuzzy = _fuzzyMatch(_ocrLower);
    const _verified = _fuzzy.match || _modalPresent;
    logger.info(`[playwright.agent] OCR verify (page-liteparse): verified=${_verified} fuzzy=${_fuzzy.match}(${_fuzzy.source}) modalPresent=${_modalPresent} app=${_cap.appName} url=${_cap.url} conf=${_cap.confidence} textLen=${_cap.text.length} textPreview="${_cap.text.slice(0, 200).replace(/\n/g, ' ')}..."`);
    return { success: true, verified: _verified, hasText: _verified, source: `page-liteparse-${_fuzzy.source || (_modalPresent ? 'modal' : 'none')}` };
  } catch (e) {
    logger.warn(`[playwright.agent] OCR verify (page-liteparse) failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function _scriptUrlFastPath(sessionId, text, goal, startTs, deadline, heartbeat, headed) {
  const page = engine.getPage(sessionId);
  if (!page) return null;

  const transcript = [];

  // ── Deterministic fast path ──
  // 1. Wait for page to stabilize
  // 2. Wait for compose focus (replaces fixed waitForTimeout — fixes lost-prefix typing race)
  // 3. Type text via keyboard.type()
  // 4. Verify via DOM (authoritative). Only fall back to OCR when NO compose field is readable.
  // 5. If verified → submit via DOM-first + LiteParse cross-check

  logger.info(`[playwright.agent] fast path: waiting for page to stabilize (up to 15s)`);
  await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 15000 }).catch(() => {});

  // Diagnostic: enumerate every frame so we can see WHERE the compose surface lives.
  // The composer is frequently in a child frame; querying only the main frame reports
  // "no compose field found" while OCR clearly sees the text.
  await _logFrameDiagnostic(page, 'after-stabilize');

  // Resolve the frame that owns the composer, then use it for all DOM work.
  let _composeFrame = (await _findComposeFrame(page)).frame;

  // Wait for the compose element to actually be focused (not a fixed timeout).
  // The old `waitForTimeout(2000)` returned before the modal existed, causing typing
  // to start on a not-yet-focused contenteditable → lost the first 4 chars.
  const _focusState = await _waitForComposeFocus(page, 12000, _composeFrame);
  logger.info(`[playwright.agent] fast path: compose focus ready (focused=${_focusState.focused} inModal=${_focusState.inModal}) — typing`);

  let _textVerified = false;
  const MAX_TYPE_ATTEMPTS = 3;

  for (let _attempt = 1; _attempt <= MAX_TYPE_ATTEMPTS; _attempt++) {
    if (Date.now() > deadline) {
      logger.warn(`[playwright.agent] fast path: deadline exceeded during type retry loop`);
      break;
    }
    logger.info(`[playwright.agent] fast path: type attempt ${_attempt}/${MAX_TYPE_ATTEMPTS} via keyboard.type`);

    // Ensure compose focus before each attempt (re-focus if lost)
    if (_attempt > 1 || !_focusState.focused) {
      await _waitForComposeFocus(page, 6000, _composeFrame).catch(() => {});
    }

    // Clear any existing text (Cmd+A on macOS, Ctrl+A on Windows/Linux)
    const _clearMod = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
    await page.keyboard.press(_clearMod).catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});

    // Type the text — keyboard.type types into whatever element has focus (auto-focused compose box)
    await page.keyboard.type(text, { delay: 5 });
    await page.waitForTimeout(1000);

    // ── DOM verify (authoritative, searches all frames) — { ok, fieldFound, fieldText, frame } ──
    const _domResult = await _domVerify(page, text);
    // Adopt the frame that actually holds the text — this is the authoritative composer frame.
    if (_domResult.frame) _composeFrame = _domResult.frame;
    if (_domResult.ok) {
      logger.info(`[playwright.agent] fast path: text verified via DOM — proceeding to submit`);
      _textVerified = true;
      transcript.push({ step: 1, action: { action: 'type', text: text.slice(0, 80) + '...' }, outcome: { ok: true }, thoughts: `fast path: keyboard.type attempt ${_attempt} verified via DOM` });
      break;
    }

    if (_domResult.fieldFound) {
      // A compose field exists but its text does NOT contain the snippet → truncation.
      // This is authoritative — do NOT fall back to fuzzy OCR (which falsely accepted
      // an 80% word match on truncated text in the bug report).
      const _fieldText = _domResult.fieldText || '';
      const _expectText = text;
      // Detect lost-prefix: field text is a suffix of the expected text
      const _isSuffix = _expectText.toLowerCase().endsWith(_fieldText.toLowerCase().trim()) && _fieldText.trim().length > 0;
      logger.warn(`[playwright.agent] fast path: DOM verify fieldFound=true ok=false${_isSuffix ? ' (field text is a SUFFIX of expected — lost-prefix focus race)' : ''} fieldLen=${_fieldText.length} expectLen=${_expectText.length} fieldPreview="${_fieldText.slice(0, 60).replace(/\n/g, ' ')}" — re-focusing and retyping (NO OCR fallback)`);
      // Clear, re-focus, and retry — do NOT call _ocrVerify here.
      if (_attempt < MAX_TYPE_ATTEMPTS) await page.waitForTimeout(500);
      continue;
    }

    // No compose field readable at all (canvas / shadow DOM) → OCR fallback is legitimate
    logger.info(`[playwright.agent] fast path: DOM verify fieldFound=false — falling back to OCR verify`);
    const _typeTs = Date.now();
    const _ocrResult = await _ocrVerify(text, _typeTs, page);
    if (_ocrResult.verified) {
      logger.info(`[playwright.agent] fast path: text verified via OCR (source=${_ocrResult.source}) — proceeding to submit`);
      _textVerified = true;
      transcript.push({ step: 1, action: { action: 'type', text: text.slice(0, 80) + '...' }, outcome: { ok: true }, thoughts: `fast path: keyboard.type attempt ${_attempt} verified via OCR (${_ocrResult.source})` });
      break;
    }
    logger.warn(`[playwright.agent] fast path: text not verified via DOM or OCR (attempt ${_attempt}) — retrying`);
    if (_attempt < MAX_TYPE_ATTEMPTS) await page.waitForTimeout(2000);
  }

  if (!_textVerified) {
    logger.warn(`[playwright.agent] fast path: could not type+verify after ${MAX_TYPE_ATTEMPTS} attempts — falling back to LLM`);
    transcript.push({ step: 1, action: { action: 'type' }, outcome: { ok: false, error: 'verify failed' }, thoughts: 'fast path: all retries failed' });
    return null;
  }

  // ── Submit: Locator-first (frame-aware, actionability-checked), then DOM/LiteParse fallbacks ──
  logger.info(`[playwright.agent] fast path: text verified — attempting Locator submit`);
  await page.waitForTimeout(500); // brief pause for UI to settle

  // Capture pre-click state IN THE COMPOSER'S FRAME. composeTexts is the baseline for the
  // primary success signal (a successful post clears the composer).
  const _preClickState = await _captureUiState(page, _composeFrame);
  logger.info(`[playwright.agent] fast path: pre-click state: modals=${_preClickState.visibleModalCount} compose=${_preClickState.composeCount} composeTextLen=${(_preClickState.composeTexts || []).join('').length} bodyLen=${_preClickState.bodyLen}`);

  let _submitResult = null;

  // Step 1: Locator-based submit — handles frame offsets, scrolling, actionability, occlusion.
  _submitResult = await _locatorSubmit(page, goal, _composeFrame);

  // Step 2: DOM coordinate fallback (scoped to modal + elementFromPoint validated)
  if (!_submitResult.ok) {
    const _domTarget = await _domFindSubmitTarget(_composeFrame, goal);
    if (_domTarget.ok) {
      const _valid = await _validateClickPoint(_composeFrame, _domTarget.x, _domTarget.y, _domTarget.text);
      if (_valid.ok) {
        try {
          await _composeFrame.evaluate(({ px, py }) => {
            const el = document.elementFromPoint(px, py);
            if (el) el.click();
          }, { px: _domTarget.x, py: _domTarget.y });
          _submitResult = { ok: true, text: _domTarget.text, keyword: _domTarget.keyword, method: 'dom-find' };
          logger.info(`[playwright.agent] fast path: clicked DOM-validated submit "${_domTarget.text}"`);
        } catch (e) {
          logger.warn(`[playwright.agent] fast path: DOM click failed: ${e.message}`);
        }
      } else {
        logger.warn(`[playwright.agent] fast path: DOM target validation failed (${_valid.reason}) — trying LiteParse fallback`);
      }
    } else {
      logger.info(`[playwright.agent] fast path: DOM find submit: ${_domTarget.reason} — trying LiteParse fallback`);
    }
  }

  // Step 3: LiteParse fallback (coordinates are page-level, so only valid for the main frame)
  if (!_submitResult.ok) {
    try {
      const _cap = await _liteparseCapture(page);
      if (_cap.ok && _cap.textItems.length > 0) {
        const _bodyLen = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0);
        if (_cap.fullText && _cap.fullText.length < 200 && _bodyLen > 1000) {
          logger.warn(`[playwright.agent] fast path: LiteParse read only ${_cap.fullText.length} chars from ${_bodyLen}-char page — skipping LiteParse coordinates`);
        } else {
          const _lpResult = await _liteparseSubmit(page, goal, _cap.textItems, _cap.imageWidth, _cap.imageHeight);
          if (_lpResult?.ok && _lpResult.x !== undefined) {
            const _lpValid = await _validateClickPoint(page, _lpResult.x, _lpResult.y, _lpResult.text);
            if (_lpValid.ok) _submitResult = _lpResult;
            else logger.warn(`[playwright.agent] fast path: LiteParse click point validation failed (${_lpValid.reason}) — discarding`);
          }
        }
      } else {
        logger.warn(`[playwright.agent] fast path: LiteParse capture failed (${_cap.error || 'no text items'})`);
      }
    } catch (_lpErr) {
      logger.warn(`[playwright.agent] fast path: LiteParse submit error: ${_lpErr.message}`);
    }
  }

  // Step 4: Last-resort — legacy deterministic action (now excludes "Start a post")
  if (!_submitResult.ok) {
    _submitResult = await _deterministicAction(page, goal, _composeFrame);
  }

  if (_submitResult.ok) {
    const _submitClickTs = Date.now();
    logger.info(`[playwright.agent] fast path: clicked submit (${_submitResult.method || 'unknown'} text="${_submitResult.text || _submitResult.label || 'n/a'}") — verifying`);
    transcript.push({ step: 2, action: { action: 'click', text: _submitResult.text || _submitResult.label || _submitResult.selector }, outcome: { ok: true }, thoughts: `submit via ${_submitResult.method || 'unknown'}` });

    // Primary verification: did the composer clear/close in its own frame?
    const _uiVerify = await _verifySubmitViaUiState(page, _preClickState, 8000, _composeFrame, text);
    if (_uiVerify.ok === false && _uiVerify.reason === 'confirm-dialog-appeared') {
      // Hard failure — the click hit a destructive path. Recover so the draft survives.
      logger.error(`[playwright.agent] fast path: HARD FAILURE — confirm dialog appeared: "${_uiVerify.dialogText}" — attempting recovery`);
      await _recoverFromConfirmDialog(page, _composeFrame);
      transcript.push({ step: 3, action: { action: 'verify' }, outcome: { ok: false, error: `confirm dialog: ${_uiVerify.dialogText}` }, thoughts: 'submit hit destructive path — recovered draft, falling through' });
      // Fall through to Plan-Execute (never done:true)
    } else if (_uiVerify.ok === true) {
      logger.info(`[playwright.agent] fast path: UI state verify: ${_uiVerify.reason} — verified`);
      const execTime = Date.now() - startTs;
      return {
        ok: true,
        done: true,
        goal,
        sessionId,
        turns: transcript.length,
        result: `Posted: "${text}" (verified via UI: ${_uiVerify.reason})`,
        transcript,
        routingDecision: 'fast_path_locator_submit_ui_verified',
        executionTime: execTime,
      };
    } else {
      // UI state inconclusive. Only a payload-level network match counts as proof here —
      // an opaque 2xx (e.g. LinkedIn's rsc-action RPC) is NOT evidence of a post.
      logger.info(`[playwright.agent] fast path: UI state ${_uiVerify.reason} — checking network for payload-level proof`);
      await page.waitForTimeout(3000);
      const _netVerify = await _verifySubmitViaNetwork(sessionId, _submitClickTs, text);
      if (_netVerify.ok && _netVerify.reason === '2xx-with-text') {
        logger.info(`[playwright.agent] fast path: submit verified via network payload — task complete`);
        const execTime = Date.now() - startTs;
        return {
          ok: true,
          done: true,
          goal,
          sessionId,
          turns: transcript.length,
          result: `Posted: "${text}" (verified via network payload)`,
          transcript,
          routingDecision: 'fast_path_locator_submit_network_verified',
          executionTime: execTime,
        };
      }
      logger.warn(`[playwright.agent] fast path: NOT verified (ui=${_uiVerify.reason}, net=${_netVerify.reason}) — composer still holds the text, falling through to Plan-Execute`);
    }
  } else {
    logger.warn(`[playwright.agent] fast path: submit button not found — falling through to Plan-Execute`);
  }

  // Submit failed or not verified — fall through with _textEntered=true
  const execTime = Date.now() - startTs;
  const result = {
    ok: true,
    _textEntered: true,
    goal,
    sessionId,
    turns: transcript.length,
    done: false, // not done — Plan-Execute/turn-loop still needs to click submit
    result: `Text entered: "${text}" — falling through for submit`,
    transcript,
    routingDecision: 'fast_path_ocr',
    executionTime: execTime,
  };

  logger.info(`[playwright.agent] fast path: text entered + verified — returning _textEntered=true for fallback (time=${execTime}ms)`);
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
    // Exact match is trivially canonical (include hash — SPA hash-routers like
    // Gmail use #inbox vs #inbox?compose=new to distinguish different page states)
    if (_t.hostname === _c.hostname && _t.pathname === _c.pathname && _t.hash === _c.hash) return true;

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
  press           { "action": "press", "key": "Enter" }
                  - Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.). CRITICAL for
                    committing inputs that only persist on Enter/blur (e.g. Google Docs rename,
                    search bars). After reactFill on an <input>, press Enter to commit if the
                    site requires it. Also use for dismissing modals (Escape) or navigating
                    autocomplete (ArrowDown + Enter).
  type            { "action": "type", "text": "hello" }
                  - Type into the currently-focused element. Fallback when reactFill can't
                    resolve a selector. Depends on focus state — focus the target first.
  fill            { "action": "fill", "selector": "e12", "text": "hello" }
                  - React-aware fill using a snapshot ref. Use when you have a ref from the snapshot.
  click           { "action": "click", "selector": "e12" }
                  - Click using a snapshot ref. Use refs from the ARIA snapshot.
  dblclick        { "action": "dblclick", "selector": "e12" }
                  - Double-click using a snapshot ref.
  hover           { "action": "hover", "selector": "e12" }
                  - Hover an element (to reveal menus/tooltips).
  select          { "action": "select", "selector": "e12", "value": "option" }
                  - Select an <option> in a <select>.
  scroll          { "action": "scroll", "dy": 500 }
                  - Scroll the page (dy in pixels; negative scrolls up).
  check           { "action": "check", "selector": "e12" }
  uncheck         { "action": "uncheck", "selector": "e12" }
                  - Check/uncheck a checkbox.
  getPageText     { "action": "getPageText" }
                  - Read all visible text on the page. Use to verify content or for read tasks.
  waitForStableText { "action": "waitForStableText" }
                  - Wait for the page to stop mutating (streaming content, lazy load).
  waitForContent  { "action": "waitForContent", "text": "Done" }
                  - Wait until the given text appears on the page.
  waitForElement  { "action": "waitForSelector", "selector": "..." }
                  - Wait for an element to appear.
  tab-select      { "action": "tab-select", "index": 0 }
                  - Switch browser tab by index.
  tab-new         { "action": "tab-new", "url": "..." }
  tab-close       { "action": "tab-close" }
                  - Open/close browser tabs.
  back            { "action": "back" }
  forward         { "action": "forward" }
  reload          { "action": "reload" }
                  - Browser history navigation / reload.
  dialog-accept   { "action": "dialog-accept" }
  dialog-dismiss  { "action": "dialog-dismiss" }
                  - Accept/dismiss a native browser dialog (alert/confirm/prompt).
  screenshot      { "action": "screenshot" }
                  - Capture a screenshot (returned in the result). Rarely needed — the loop
                    already captures OCR each turn when warranted.
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
- IMPORTANT: Some inputs (title fields, search bars, rename dialogs) only commit on
  Enter or blur. If reactFill reports verified=true but the page text/OCR still shows
  the OLD value on the next turn, follow reactFill with { "action": "press", "key": "Enter" }
  to commit, then re-check. Do NOT repeat the same reactFill — it will not help.
- MODAL-COMMIT RULE: When you fill a name/title field inside a creation or edit
  dialog/modal, you MUST then click the dialog's "Save"/"Create"/"Done" button
  (use clickByText with scope='[role="dialog"]') or press Enter to commit. The
  change is NOT saved until the dialog is submitted. Do NOT return "done" while
  a modal is still open — first close it by clicking Save or pressing Escape,
  then verify the change persisted on the main page.
- After each action, you'll see the result. Adapt based on what happened.
- When the goal is achieved, output { "action": "return", "data": "what you did" }.
- The ARIA snapshot may NOT show contenteditable elements. If the PAGE TEXT or PROBE
  shows a compose box (contenteditable=true, role=textbox), use reactFill with the
  indicated selector even if it's not in the ARIA snapshot.
- HIDDEN ELEMENT RULE: If an action fails with "element is not visible" or "not
  interactable", OR if reactFill reports verified=true but the OCR/page text doesn't
  show the expected change, the element is likely hidden by a UI mode (compact mode,
  collapsed toolbar, minimized section). Do NOT repeat the same action. Instead:
  (a) check the APP KNOWLEDGE block for known keyboard shortcuts or UI mode toggles,
  (b) press a keyboard shortcut to toggle the UI mode (e.g. { "action": "press", "key": "Control+Shift+F" } for compact mode in many editors),
  (c) look for a toggle/expand/collapse button in the snapshot and click it,
  (d) press Ctrl+/ or ? to open the app's shortcut help overlay,
  (e) check the OCR — if the expected UI area (title bar, toolbar) is missing from
      the screen, a UI mode is hiding it. After revealing the element, retry the action.
- CLEAR-BEFORE-FILL RULE: When filling a title, rename, or any input field that
  already has a value (e.g. "Untitled document", "Untitled", existing text), NEVER
  use "type" — it appends to the existing value, producing garbage like
  "Untitled dQ3 Planning Notesocument". Instead use "fill" (which does Meta+A + type
  to replace) or "reactFill" (which replaces via native setter with clearFirst). If
  you must use "type", first press { "action": "press", "key": "Meta+a" } to select
  all existing text, then type the new value.
- MULTI-CONTENTEDITABLE RULE: When the page has multiple contenteditable elements (e.g.
  title H1 + body DIV, or To/Subject/Body in email compose), do NOT use generic
  "[contenteditable='true']" — it matches the FIRST in document order, which may be the
  body, not the title. Use the SELECTOR HINTS which list each contenteditable with its
  distinguishing attribute (placeholder, aria-label, role, tag). For title/rename tasks,
  prefer "h1[contenteditable]", "[placeholder='New page']", or the tag-specific selector.
  For body/content tasks, target the body element specifically by role or aria-label. If
  reactFill returns a "warning" field, the selector matched multiple elements — switch to
  a more specific selector immediately.
- SEARCH-THEN-CLICK RULE: After filling a search box and pressing Enter, ALWAYS run
  waitForStableText before clicking a result. Search results load dynamically — if you
  click before results settle, you may click a stale element or the search box itself.
  After results load, identify the first ORGANIC result (skip ads/sponsored) by its
  link/text and click it.
- BLOCK-CREATION RULE: When creating lists/todos in block-based editors (Notion, Google
  Docs, Confluence), do NOT type raw markdown like "- Task 1\n- Task 2\n- Task 3" as a
  single type action — newlines inside a contenteditable do NOT create separate blocks.
  Instead, create each item as a separate step: (1) type the block-creation shortcut for
  the desired block type (e.g. "[]" + Space for todo, "-" + Space for bullet, "/todo" +
  Enter for slash command), (2) type the item text, (3) press Enter to create the next
  block, (4) repeat for each item. Check the APP KNOWLEDGE section for the app's specific
  block-creation shortcuts — if slash commands are available (e.g. "/todo"), prefer them
  over markdown shortcuts.

Output ONLY the JSON action object, no markdown, no explanation.`;

// ── Focused Plan-Execute: ONE LLM call → 3-5 steps → verify each ──────────
// Handles ALL browser interaction types (click, fill, type, press, hover, select,
// scroll, drag, upload, check, tab-select, getPageText, etc.)
// Key improvements over old Plan-Execute: OCR + DOM signals included, fresh snapshot,
// verification after each step, limited to 3-5 steps.
const FOCUSED_PLAN_EXECUTE_PROMPT = `You are a browser automation expert. Given the page state and task goal, generate 3-5 steps to complete the task.

AVAILABLE ACTIONS (use these exact action names):
  click        — {"action": "click", "selector": "e12"} (use refs from snapshot)
  fill         — {"action": "fill", "selector": "e12", "text": "hello"} (React-aware fill)
  type         — {"action": "type", "text": "hello"} (types into focused element)
  press        — {"action": "press", "key": "Enter"}
  hover        — {"action": "hover", "selector": "e12"}
  select       — {"action": "select", "selector": "e12", "value": "option"}
  scroll       — {"action": "scroll", "dy": 500}
  drag         — {"action": "drag", "selector": "e12", "target": "e15"}
  check        — {"action": "check", "selector": "e12"}
  uncheck      — {"action": "uncheck", "selector": "e12"}
  upload       — {"action": "upload", "selector": "e12", "files": ["/path/to/file"]}
  tab-select   — {"action": "tab-select", "index": 0}
  getPageText  — {"action": "getPageText"} (reads all visible text — use for read tasks)
  waitForStableText — {"action": "waitForStableText"} (wait for page to settle)

RULES:
- Use element refs (e12, td5) from the ARIA snapshot for selectors — most reliable.
- Maximum 5 steps. If the task needs more, prioritize the most critical steps.
- For read/count/list tasks, end with getPageText.
- For compose tasks, fill the compose box then click the submit button.
- Do NOT include navigate steps — we're already on the right page.
- ADD/MOVE/SAVE RULE: For goals like "add X to Y", "move X to Y", "save X to Y",
  "insert X into Y", "assign X to Y", the steps MUST include the action that
  actually places X into Y — not just searching for or reading X. Searching is
  only an intermediate step. The plan is incomplete if it stops after search or
  getPageText without performing the destination action.
- OVERFLOW-MENU RULE: When the goal requires acting on a specific item (add/move/
  save/share/delete a row, track, card, file, message) and the page does NOT show
  a direct "Add"/"Move"/"Save" button for that item, use the item's overflow /
  "more options" / "..." button on its row (often an icon button on the right side
  of the row). Click it, then choose the matching menu item (e.g. "Add to ...",
  "Move to ...", "Save to ..."). Do NOT clickByText "Add" globally — there is
  usually no such top-level element.
- DESTINATION-CONTAINER RULE: When the target Y has its own built-in search/add
  input (e.g. a section-specific "Search" or "Add" input under a heading), prefer
  using that input over a global page-level search. The DOM signals list inputs
  with context attributes — pick the input whose context matches the destination
  section.
- CREATE/NEW RULE: For goals like "create a X", "make a new X", "add a new X",
  "create a playlist/album/folder/project/document":
  First click the "Create"/"New"/"Add" button on the page to open the creation
  dialog or dropdown. Do NOT type the name into a search bar — search bars
  (placeholder "What do you want to play?", "Search...", "Search for...") are for
  searching, not creating. After clicking Create, a dialog or dropdown will
  appear — then fill the name field in that dialog. If a dropdown appears after
  clicking Create, the next step's click will handle selecting the appropriate
  option (e.g. "Create a playlist") to open the actual creation dialog.
  COMMIT RULE: After filling the name field in the creation dialog, you MUST
  include a final step to click the "Save"/"Create"/"Done"/"Confirm" button (or
  press Enter) to commit the creation and close the dialog. The item is NOT
  created until the dialog is submitted — typing the name alone is not enough.
  After submitting, the dialog should close and the new item should appear in
  the page/list.

Return JSON: {"steps": [...], "thoughts": "brief explanation"}`;

// ---------------------------------------------------------------------------
// Tier 1.6: Structured OCR Overlay Interaction
// Uses DOM to open a menu/dropdown/popup/modal, then captures only that
// overlay's region with LiteParser OCR, restructures the fragmented word-items
// into clean { id, type, text, bounds } rows, and asks the LLM to pick the
// right option or fill fields + click a button.
// ---------------------------------------------------------------------------

const { structureOcrOverlayItems, formatOverlayForLLM, pickOverlayAction } = require('./ocrOverlayStructure.cjs');

function _isOverlayInteractionTask(goal, domSignals) {
  if (!goal) return false;
  const _g = goal.toLowerCase();
  // Goal keywords that imply opening an overlay and selecting/filling
  const _overlayKeywords = /\b(menu|dropdown|popup|modal|dialog|select|choose|pick from|open\s+\w+\s+options|tab|switch to|create\s+(?:a\s+)?(?:playlist|folder|project|document)|edit\s+details|context\s+menu)\b/i;
  if (_overlayKeywords.test(_g)) return true;
  // DOM signals: aria-haspopup, aria-expanded on the page
  if (domSignals && typeof domSignals === 'string') {
    if (/aria-expanded|aria-haspopup|role="combobox"|role="tablist"/i.test(domSignals)) return true;
  }
  return false;
}

async function _detectOverlayRect(sessionId) {
  const _page = engine?.getPage?.(sessionId);
  if (!_page) return null;
  try {
    const rect = await _page.evaluate(() => {
      const sels = '[role="menu"], [role="listbox"], [role="dialog"], [aria-modal="true"], ' +
        '[role="combobox"], [role="tablist"], ' +
        '[class*="dropdown" i], [class*="popover" i], [class*="popup" i], ' +
        '[class*="modal" i], [class*="overlay" i]';
      for (const el of document.querySelectorAll(sels)) {
        const r = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        if (r.width < 2 || r.height < 2) continue;
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top || (top !== el && !el.contains(top))) continue;
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      }
      return null;
    }).catch(() => null);
    return rect;
  } catch (_) { return null; }
}

async function _executeOverlayInteraction({ goal, sessionId, headed, timeoutMs, triggerText, triggerSelector, overlayRect: _providedRect, skipTriggerClick = false }) {
  const _oiStart = Date.now();
  logger.info(`[playwright.agent] Tier 1.6 (overlay interaction): starting for goal="${goal.slice(0, 80)}"${skipTriggerClick ? ' [menu already open]' : ''}`);
  const { browserAct } = require('./browser.act.cjs');
  const { _liteparseCapture } = require('./browser.agent.cjs');
  const _page = engine?.getPage?.(sessionId);
  if (!_page) return { ok: false, error: 'no page available' };

  try {
    // 1. Open the overlay via DOM click (if trigger provided and menu not already open)
    if (!skipTriggerClick && (triggerText || triggerSelector)) {
      logger.info(`[playwright.agent] Tier 1.6: clicking trigger "${triggerText || triggerSelector}"`);
      if (triggerSelector) {
        await browserAct({ action: 'click', sessionId, headed, timeoutMs: 5000, selector: triggerSelector });
      } else {
        await browserAct({ action: 'clickByText', sessionId, headed, timeoutMs: 5000, text: triggerText });
      }
    }

    // 2. Wait for overlay animation (skip if menu was already open)
    if (!skipTriggerClick) {
      await new Promise(r => setTimeout(r, 400));
    }

    // 3. Use provided rect or detect the open overlay region via DOM
    let overlayRect = _providedRect || await _detectOverlayRect(sessionId);

    // Fallback: if no DOM overlay container found, use the trigger element's bounds + expansion
    if (!overlayRect && (triggerText || triggerSelector)) {
      try {
        const triggerRect = await _page.evaluate((sel, txt) => {
          let el = null;
          if (sel) el = document.querySelector(sel);
          if (!el && txt) {
            el = Array.from(document.querySelectorAll('button, a, [role="button"], [aria-haspopup]'))
              .find(e => (e.innerText || e.textContent || '').trim().toLowerCase().includes(txt.toLowerCase()));
          }
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        }, triggerSelector || null, triggerText || null).catch(() => null);
        if (triggerRect) {
          // Expand downward by 300px, width 250px (typical menu size)
          overlayRect = {
            x: Math.max(0, triggerRect.x - 20),
            y: triggerRect.y + triggerRect.height,
            width: Math.max(triggerRect.width + 40, 250),
            height: 300,
          };
        }
      } catch (_) {}
    }

    if (!overlayRect) {
      logger.warn(`[playwright.agent] Tier 1.6: no overlay detected — falling through`);
      return { ok: false, error: 'no overlay detected' };
    }

    logger.info(`[playwright.agent] Tier 1.6: overlay rect = ${JSON.stringify(overlayRect)}`);

    // 4-6. OCR capture → structure → LLM pick, with smart scroll for off-screen items.
    // If the first capture doesn't yield a confident pick, scroll the overlay (or
    // page) by ~80% of the capture height and re-capture, up to MAX_SCROLL times.
    // This handles long scrollable dropdowns/modals where the target row is below
    // the fold on any site, regardless of how the overlay is implemented.
    const MAX_SCROLL_ATTEMPTS = 3;
    let _pickResult = null;
    let _cap = null;
    let rows = [];
    let scrollAttempt = 0;
    let _scrolledAtLeastOnce = false;

    while (scrollAttempt <= MAX_SCROLL_ATTEMPTS) {
      _cap = await _liteparseCapture(_page, { clip: overlayRect });
      if (_cap?.ok && _cap.textItems && _cap.textItems.length > 0) {
        rows = structureOcrOverlayItems(_cap.textItems, {
          imageWidth: _cap.imageWidth,
          imageHeight: _cap.imageHeight,
        });
        if (rows.length > 0) {
          logger.info(`[playwright.agent] Tier 1.6: scroll=${scrollAttempt}, ${rows.length} rows:\n${formatOverlayForLLM(rows).split('\n').map(l => '  ' + l).join('\n')}`);
          _pickResult = await pickOverlayAction(rows, goal, askWithMessages);
          if (_pickResult?.ok) break; // confident pick — stop scrolling
          logger.info(`[playwright.agent] Tier 1.6: scroll=${scrollAttempt} no confident pick (${_pickResult?.error || 'unknown'}) — will scroll and retry`);
        } else {
          logger.info(`[playwright.agent] Tier 1.6: scroll=${scrollAttempt} structured rows empty — will scroll and retry`);
        }
      } else {
        logger.info(`[playwright.agent] Tier 1.6: scroll=${scrollAttempt} OCR capture empty — will scroll and retry`);
      }

      if (scrollAttempt === MAX_SCROLL_ATTEMPTS) break;

      // Scroll the overlay (or page) down by ~80% of the capture height.
      // Find the first scrollable ancestor of the overlay's center point.
      const scrollDelta = Math.round((overlayRect.height || 300) * 0.8);
      const scrolled = await _page.evaluate((rect, delta) => {
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        let el = document.elementFromPoint(cx, cy);
        while (el && el !== document.body && el !== document.documentElement) {
          const s = window.getComputedStyle(el);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) {
            const before = el.scrollTop;
            el.scrollBy(0, delta);
            return { scrolled: el.scrollTop !== before, target: 'overlay', delta: el.scrollTop - before };
          }
          el = el.parentElement;
        }
        // Fallback: scroll the page body
        const before = window.scrollY;
        window.scrollBy(0, delta);
        return { scrolled: window.scrollY !== before, target: 'page', delta: window.scrollY - before };
      }, overlayRect, scrollDelta).catch(() => null);

      if (!scrolled || !scrolled.scrolled) {
        logger.info(`[playwright.agent] Tier 1.6: no scrollable container found or already at bottom — stopping`);
        break;
      }
      _scrolledAtLeastOnce = true;
      logger.info(`[playwright.agent] Tier 1.6: scrolled ${scrolled.target} by ${scrolled.delta}px (attempt ${scrollAttempt + 1}/${MAX_SCROLL_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, 350)); // wait for scroll + any lazy render
      scrollAttempt++;
    }

    if (!_pickResult?.ok) {
      logger.warn(`[playwright.agent] Tier 1.6: no confident pick after ${scrollAttempt + 1} capture(s)${_scrolledAtLeastOnce ? ' (with scrolling)' : ''} — falling through`);
      return { ok: false, error: _pickResult?.error || 'no confident pick after scrolling' };
    }

    // 7. Execute the LLM's decision
    const _viewportWidth = _page.viewportSize()?.width || 1280;
    const _viewportHeight = _page.viewportSize()?.height || 800;
    // When a clip/overlayRect was used, OCR coordinates are relative to the clipped
    // region, not the full viewport. We must:
    // 1. Scale OCR coords by (overlayRect.width / imageWidth) to get CSS-pixel offsets
    // 2. Add overlayRect.x/y to get full-viewport coordinates
    const _hasClip = !!(overlayRect && overlayRect.width && overlayRect.height);
    const _originX = _hasClip ? overlayRect.x : 0;
    const _originY = _hasClip ? overlayRect.y : 0;
    const _scaleX = _hasClip
      ? overlayRect.width / (_cap.imageWidth || overlayRect.width)
      : _viewportWidth / (_cap.imageWidth || _viewportWidth);
    const _scaleY = _hasClip
      ? overlayRect.height / (_cap.imageHeight || overlayRect.height)
      : _viewportHeight / (_cap.imageHeight || _viewportHeight);

    if (_pickResult.action === 'pick') {
      // Pick one row — click its center
      const sel = _pickResult.selection;
      const clickX = Math.round(_originX + (sel.x + sel.width / 2) * _scaleX);
      const clickY = Math.round(_originY + (sel.y + sel.height / 2) * _scaleY);
      logger.info(`[playwright.agent] Tier 1.6: clicking "${sel.text}" at (${clickX}, ${clickY}) — scale=(${_scaleX}, ${_scaleY}), origin=(${_originX}, ${_originY})`);
      await _page.mouse.click(clickX, clickY);
      return { ok: true, action: 'pick', selectedText: sel.text, clickedAt: { x: clickX, y: clickY }, reason: _pickResult.reason, rows, executionTime: Date.now() - _oiStart };
    } else if (_pickResult.action === 'fill_and_click') {
      // Fill fields + click button
      const transcript = [];
      for (const fill of _pickResult.fills || []) {
        logger.info(`[playwright.agent] Tier 1.6: filling field "${fill.text}" with "${fill.value}"`);
        // Try DOM focus first (find input by placeholder/label within the overlay region)
        try {
          const focused = await _page.evaluate((rect, labelText) => {
            const inputs = document.querySelectorAll('input, textarea, [contenteditable], [role="textbox"]');
            for (const inp of inputs) {
              const r = inp.getBoundingClientRect();
              if (r.x < rect.x || r.x > rect.x + rect.width) continue;
              if (r.y < rect.y || r.y > rect.y + rect.height) continue;
              const label = (inp.getAttribute('placeholder') || inp.getAttribute('aria-label') || inp.getAttribute('aria-placeholder') || '').toLowerCase();
              if (label.includes(labelText.toLowerCase()) || labelText.toLowerCase().includes(label)) {
                inp.focus();
                return true;
              }
            }
            return false;
          }, overlayRect, fill.text).catch(() => false);
          if (focused) {
            await _page.keyboard.type(fill.value);
            transcript.push({ action: 'fill', field: fill.text, value: fill.value, ok: true });
          } else {
            // Fallback: click the field by OCR coords, then type
            const clickX = Math.round(_originX + (fill.x + 50) * _scaleX);
            const clickY = Math.round(_originY + (fill.y + fill.height / 2) * _scaleY);
            await _page.mouse.click(clickX, clickY);
            await new Promise(r => setTimeout(r, 200));
            await _page.keyboard.type(fill.value);
            transcript.push({ action: 'fill', field: fill.text, value: fill.value, ok: true, method: 'ocr-coords' });
          }
        } catch (e) {
          transcript.push({ action: 'fill', field: fill.text, value: fill.value, ok: false, error: e.message });
        }
      }
      // Click the button
      if (_pickResult.click) {
        const btn = _pickResult.click;
        const clickX = Math.round(_originX + (btn.x + btn.width / 2) * _scaleX);
        const clickY = Math.round(_originY + (btn.y + btn.height / 2) * _scaleY);
        logger.info(`[playwright.agent] Tier 1.6: clicking button "${btn.text}" at (${clickX}, ${clickY})`);
        await _page.mouse.click(clickX, clickY);
        transcript.push({ action: 'click', button: btn.text, ok: true });
      } else {
        // No button row found by OCR — press Enter to commit the fill.
        // This handles modals where the Save button was not detected as a
        // separate row (e.g. clustered with surrounding text by OCR).
        logger.info(`[playwright.agent] Tier 1.6: no button row — pressing Enter to commit fill`);
        await _page.keyboard.press('Enter');
        transcript.push({ action: 'press', key: 'Enter', ok: true, reason: 'no button row — Enter as commit' });
      }
      return { ok: true, action: 'fill_and_click', transcript, reason: _pickResult.reason, rows, executionTime: Date.now() - _oiStart };
    }

    return { ok: false, error: 'unknown action type from LLM', executionTime: Date.now() - _oiStart };
  } catch (e) {
    logger.warn(`[playwright.agent] Tier 1.6 error: ${e.message}`);
    return { ok: false, error: e.message, executionTime: Date.now() - _oiStart };
  }
}

async function _focusedPlanExecute({ goal, verificationGoal, sessionId, headed, timeoutMs, agentContext, deadline, start, heartbeat, _ocrText, _domSignals, pageStudyBlock, domainLockBlock, failedApproachesBlock, recordFailedApproach }) {
  const _peStart = Date.now();
  logger.info(`[playwright.agent] focused Plan-Execute: starting for goal="${goal.slice(0, 80)}"`);
  logger.info(`[playwright.agent] focused Plan-Execute: pageStudyBlock length=${(pageStudyBlock || '').length}${pageStudyBlock ? `, first 200 chars: ${pageStudyBlock.slice(0, 200)}` : ' (empty)'}`);

  try {
    const page = engine.getPage(sessionId);
    if (!page) return { ok: false, error: 'no page' };

    // 1. Get fresh snapshot + page text
    const _snapResult = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
    const _snap = _snapResult?.ok ? String(_snapResult.result || '') : '';
    const _pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

    // 2. ONE LLM call with full context
    const _userPrompt = `GOAL: ${goal}
${agentContext ? `\nAGENT CONTEXT:\n${agentContext}` : ''}
${pageStudyBlock || ''}
${_ocrText ? `\nOCR SCREEN CAPTURE:\n${_ocrText.slice(0, 1000)}\n` : ''}
${_domSignals ? `\nDOM STATE SIGNALS:\n${_domSignals.slice(0, 1000)}\n` : ''}
VISIBLE PAGE TEXT (first 2000 chars):
${_pageText.slice(0, 2000)}

ARIA SNAPSHOT (first 3000 chars):
${_snap.slice(0, 3000)}

Generate 3-5 steps to complete this task.`;

    logger.info(`[playwright.agent] focused Plan-Execute: prompt (first 500 chars): ${_userPrompt.slice(0, 500)}`);

    const _response = await askWithMessages([
      { role: 'system', content: FOCUSED_PLAN_EXECUTE_PROMPT },
      { role: 'user', content: _userPrompt },
    ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 20000 });

    const _parsed = parseJson(_response);
    if (!_parsed || !Array.isArray(_parsed.steps) || _parsed.steps.length === 0) {
      logger.warn(`[playwright.agent] focused Plan-Execute: invalid response — no steps`);
      return { ok: false, error: 'no steps in response' };
    }

    const _steps = _parsed.steps.slice(0, 5); // max 5 steps
    logger.info(`[playwright.agent] focused Plan-Execute: ${_steps.length} steps — ${_parsed.thoughts || 'no thoughts'}`);

    // 3. Execute with verification, with ONE replan attempt on step failure.
    // On a failed step: take a fresh snapshot and ask the LLM to re-plan only the
    // REMAINING steps (1 attempt). If the repair also fails, fall through to the
    // turn-loop as before. This avoids throwing away a good 5-step plan over a
    // single transient click failure (e.g. stale-visibility read).
    const _peTranscript = [];
    let _replanned = false;
    let _i = 0;
    // Track timestamp of the last DOM-mutating step (the likely submit action).
    // Used to (1) poll the netlog for the mutation response before verification,
    // and (2) pass to _verifyActionCompletion so Signal B (network) can run.
    let _lastMutatingStepTs = null;
    while (_i < _steps.length) {
      if (Date.now() > deadline) {
        logger.warn(`[playwright.agent] focused Plan-Execute: deadline exceeded at step ${_i + 1}`);
        return { ok: false, error: 'deadline exceeded', transcript: _peTranscript };
      }
      const _step = _steps[_i];
      logger.info(`[playwright.agent] focused Plan-Execute: step ${_i + 1}/${_steps.length} — ${_step.action}`);

      // Capture state before click for post-click menu detection (Tier 1.6).
      const _isClickStep = _step.action === 'click';
      const _urlBefore = _isClickStep ? await page.evaluate(() => window.location.href).catch(() => '') : '';
      const _bodyLenBefore = _isClickStep ? await page.evaluate(() => document.body.innerText.length).catch(() => 0) : 0;

      const _result = await browserAct({ ..._step, sessionId, headed, timeoutMs: timeoutMs || 15000 });
      _peTranscript.push({ step: _i + 1, action: _step, outcome: { ok: _result.ok, error: _result.error, result: _result.result }, thoughts: `Plan-Execute step ${_i + 1}` });

      // Track timestamp of last DOM-mutating step for network verification (Signal B).
      // The netlog logs on 'response' event, so we need the timestamp to filter requests.
      if (_result.ok && ['click', 'press', 'fill', 'type', 'reactFill'].includes(_step.action)) {
        _lastMutatingStepTs = Date.now();
      }

      // ── Post-click Tier 1.6: detect menu/dropdown and pick the right item ──
      // After a successful click, check if a menu appeared. If so, use Tier 1.6
      // (OCR + structure + LLM pick) to click the right menu item before proceeding.
      // This handles cases where the LLM's plan assumes a click leads directly to a
      // form/dialog, but actually opens a dropdown menu that needs an intermediate click.
      if (_result.ok && _isClickStep) {
        try {
          await new Promise(r => setTimeout(r, 400)); // wait for menu animation
          const _urlAfter = await page.evaluate(() => window.location.href).catch(() => '');
          const _bodyLenAfter = await page.evaluate(() => document.body.innerText.length).catch(() => 0);

          // Only proceed if: no navigation + something appeared on screen
          if (_urlAfter === _urlBefore && _bodyLenAfter > _bodyLenBefore + 30) {
            logger.info(`[playwright.agent] focused Plan-Execute: bodyLen ${_bodyLenBefore} → ${_bodyLenAfter} after click — checking for menu`);

            // Resolve trigger text from the clicked element (for overlay rect fallback)
            let _triggerText = _step.text || null;
            if (!_triggerText && _step.selector) {
              _triggerText = await page.evaluate((sel) => {
                const el = sel.startsWith('td') ? document.querySelector(`[data-td-ref="${sel}"]`) : document.querySelector(sel);
                return el ? (el.innerText || el.textContent || '').trim().slice(0, 50) : null;
              }, _step.selector).catch(() => null);
            }

            // ── Keyboard nav probe: try ArrowDown to detect+navigate menu ──
            // If the next planned step is a click targeting a menu item, try
            // keyboard nav (ArrowDown + Enter) before falling back to OCR.
            const _nextStep = _steps[_i + 1];
            if (_nextStep && (_nextStep.action === 'click' || _nextStep.action === 'clickByText') && _nextStep.text) {
              const _kbHelpers = _getKbHelpers();
              if (_kbHelpers._selectOverlayItemByKeyboard) {
                logger.info(`[playwright.agent] focused Plan-Execute: trying keyboard nav for next step target "${_nextStep.text}"`);
                const _kbResult = await _kbHelpers._selectOverlayItemByKeyboard(sessionId, _nextStep.text, null, _menuRect || null);
                if (_kbResult?.ok) {
                  logger.info(`[playwright.agent] focused Plan-Execute: keyboard nav succeeded — selected "${_kbResult.selectedText}"`);
                  _peTranscript.push({
                    step: _i + 1, action: { action: 'keyboard_nav', text: _kbResult.selectedText || '' },
                    outcome: { ok: true, selectedText: _kbResult.selectedText },
                    thoughts: `Keyboard nav: ArrowDown + Enter selected "${_kbResult.selectedText}"`,
                  });
                  _lastMutatingStepTs = Date.now();
                  // Skip the next step — keyboard nav already selected the item
                  _i++;
                  continue;
                }
                logger.info(`[playwright.agent] focused Plan-Execute: keyboard nav failed: ${_kbResult?.error} — falling back to Tier 1.6`);
              } else {
                logger.info(`[playwright.agent] focused Plan-Execute: keyboard nav not available — falling back to Tier 1.6`);
              }
            }

            // Try DOM-based menu detection first (for overlay rect)
            const _openMenus = await _detectOpenMenus(sessionId, headed, 3000);
            let _menuRect = null;
            if (_openMenus.length > 0 && _openMenus[0].items.length >= 2) {
              _menuRect = _openMenus[0].boundingRect;
              logger.info(`[playwright.agent] focused Plan-Execute: DOM menu detected (${_openMenus[0].items.length} items)`);
            }

            // Call Tier 1.6 — with menu rect if found, or triggerText for fallback rect
            const _overlayResult = await _executeOverlayInteraction({
              goal, sessionId, headed, timeoutMs,
              triggerText: _triggerText,
              triggerSelector: _step.selector && !_step.selector.startsWith('td') ? _step.selector : null,
              overlayRect: _menuRect,
              skipTriggerClick: true, // menu is already open — don't click trigger again
            });

            if (_overlayResult.ok) {
              logger.info(`[playwright.agent] focused Plan-Execute: Tier 1.6 succeeded (${_overlayResult.action}) — ${_overlayResult.reason || ''}`);
              _peTranscript.push({
                step: _i + 1, action: { action: 'tier1.6_pick', text: _overlayResult.selectedText || '' },
                outcome: { ok: true, ..._overlayResult },
                thoughts: `Tier 1.6 in Plan-Execute: ${_overlayResult.reason || ''}`,
              });
              _lastMutatingStepTs = Date.now();
            } else {
              logger.warn(`[playwright.agent] focused Plan-Execute: Tier 1.6 failed: ${_overlayResult.error} — continuing with planned steps`);
            }
          }
        } catch (_t16Err) {
          logger.warn(`[playwright.agent] focused Plan-Execute: post-click Tier 1.6 error: ${_t16Err.message}`);
        }
      }

      if (!_result.ok) {
        logger.warn(`[playwright.agent] focused Plan-Execute: step ${_i + 1} failed — ${_result.error}`);
        // Press Escape to dismiss any stale overlay before retrying/replanning
        try { await page.keyboard.press('Escape').catch(() => {}); await new Promise(r => setTimeout(r, 200)); } catch {}
        // Record this failed step in the session ledger (process of elimination)
        if (typeof recordFailedApproach === 'function') {
          recordFailedApproach(
            `step: ${_step.action}${_step.selector ? `(${_step.selector})` : ''}${_step.text ? ` "${_step.text}"` : ''}`,
            _result.error,
            ''
          );
        }
        // One replan attempt: re-snapshot + re-plan remaining steps from the fresh state.
        if (!_replanned) {
          _replanned = true;
          logger.info(`[playwright.agent] focused Plan-Execute: attempting one replan (fresh snapshot + re-plan remaining ${_steps.length - _i} step(s))`);
          try {
            const _replanSnapRes = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
            const _replanSnap = _replanSnapRes?.ok ? String(_replanSnapRes.result || '') : '';
            const _replanPageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

            // Re-run page study on the fresh snapshot so the re-plan is grounded in the current page state
            let _replanStudyBlock = pageStudyBlock || '';
            try {
              const _replanStudyRaw = await askWithMessages([
                { role: 'system', content: PAGE_STUDY_PROMPT + (domainLockBlock || '') },
                { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(_replanSnap))}` },
              ], { temperature: 0.1, maxTokens: 1000, responseTimeoutMs: 15000 });
              const _replanPageStudy = parseJson(_replanStudyRaw);
              if (_replanPageStudy && typeof _replanPageStudy === 'object') {
                logger.info(`[playwright.agent] focused Plan-Execute: internal replan page study — pageType=${_replanPageStudy.pageType}, confidence=${_replanPageStudy.confidence}, elements=${_replanPageStudy.keyElements?.length || 0}`);
                _replanStudyBlock = `\nPAGE ANALYSIS (from pre-plan study phase — use this to guide your plan):\n- Page type: ${_replanPageStudy.pageType || 'unknown'}\n- Right page: ${_replanPageStudy.rightPage}\n- Confidence: ${_replanPageStudy.confidence}\n- Key elements: ${JSON.stringify((_replanPageStudy.keyElements || []).slice(0, 10))}\n- Expected flow: ${(_replanPageStudy.expectedFlow || []).join(' → ')}\n- Potential blockers: ${(_replanPageStudy.potentialBlockers || []).join('; ')}\n`;
              } else {
                logger.warn(`[playwright.agent] focused Plan-Execute: internal replan page study unparseable — using original study block`);
              }
            } catch (_replanStudyErr) {
              logger.warn(`[playwright.agent] focused Plan-Execute: internal replan page study failed (non-fatal): ${_replanStudyErr.message}`);
            }

            const _failedStepNote = `The previous plan failed at step ${_i + 1} (${_step.action}) with error: ${_result.error}. The page state below is a FRESH snapshot taken after that failure.`;
            const _replanPrompt = `GOAL: ${goal}
${agentContext ? `\nAGENT CONTEXT:\n${agentContext}` : ''}
${_replanStudyBlock}
${_ocrText ? `\nOCR SCREEN CAPTURE:\n${_ocrText.slice(0, 1000)}\n` : ''}
${_domSignals ? `\nDOM STATE SIGNALS:\n${_domSignals.slice(0, 1000)}\n` : ''}
${failedApproachesBlock || ''}
${_failedStepNote}

VISIBLE PAGE TEXT (first 2000 chars):
${_replanPageText.slice(0, 2000)}

ARIA SNAPSHOT (first 3000 chars):
${_replanSnap.slice(0, 3000)}

Generate 3-5 steps to complete this task FROM THE CURRENT PAGE STATE. Steps 1-${_i} already succeeded — do NOT repeat them. If the FAILED APPROACHES block above lists an action, do NOT retry it — try a DIFFERENT approach.`;

            const _replanResponse = await askWithMessages([
              { role: 'system', content: FOCUSED_PLAN_EXECUTE_PROMPT },
              { role: 'user', content: _replanPrompt },
            ], { temperature: 0.1, maxTokens: 800, responseTimeoutMs: 20000 });

            const _replanParsed = parseJson(_replanResponse);
            if (_replanParsed && Array.isArray(_replanParsed.steps) && _replanParsed.steps.length > 0) {
              // Replace remaining steps with the re-planned steps and continue the loop.
              _steps.splice(_i, _steps.length - _i, ..._replanParsed.steps.slice(0, 5));
              logger.info(`[playwright.agent] focused Plan-Execute: replan produced ${_replanParsed.steps.length} fresh step(s) — ${_replanParsed.thoughts || 'no thoughts'}`);
              _peTranscript.push({ step: _i + 1, action: { action: 'replan' }, outcome: { ok: true, result: `replanned ${_replanParsed.steps.length} steps` }, thoughts: `replan after step ${_i + 1} failure: ${_result.error}` });
              // Do NOT increment _i — re-enter the loop at the same index with the new first step.
              continue;
            } else {
              logger.warn(`[playwright.agent] focused Plan-Execute: replan returned no steps — falling back to turn-loop`);
            }
          } catch (_replanErr) {
            logger.warn(`[playwright.agent] focused Plan-Execute: replan error: ${_replanErr.message} — falling back to turn-loop`);
          }
        }
        // Replan already used (or failed) — stop and fall through to turn-loop.
        logger.warn(`[playwright.agent] focused Plan-Execute: stopping after step ${_i + 1} failure — ${_result.error}`);
        return { ok: false, error: `step ${_i + 1} failed: ${_result.error}`, transcript: _peTranscript };
      }

      // Brief pause for UI to settle
      await page.waitForTimeout(1000);
      _i++;
    }

    // 4. All steps succeeded — extract result if last step was getPageText
    let _resultText = 'Completed via focused Plan-Execute';
    if (_steps[_steps.length - 1].action === 'getPageText') {
      const _lastResult = _peTranscript[_peTranscript.length - 1];
      if (_lastResult.outcome?.result) _resultText = String(_lastResult.outcome.result);
    }

    const _execTime = Date.now() - _peStart;

    // 4b. For send/submit goals, poll the netlog for the mutation response before
    // running verification. Signal B (network) is the universal verification signal
    // but it needs the response to be logged. The netlog logs on 'response' event
    // (browser-engine.cjs), so we must wait for the server to respond.
    // Poll for up to 8 seconds (same budget as fast path's _verifySubmitViaUiState).
    // Returns early when a 2xx mutation response appears — no unnecessary latency
    // for fast-responding sites (Facebook ~500ms). Waits longer for slow sites
    // (LinkedIn rsc-action can take 3-5s).
    const _isSendSubmitGoal = /\b(send|post|submit|publish|dispatch|email|tweet|share|reply|comment)\b/i.test(goal);
    if (_isSendSubmitGoal && _lastMutatingStepTs) {
      const _netSettleStart = Date.now();
      const _NET_SETTLE_TIMEOUT = 8000;
      const _netLog = engine.getNetLog(sessionId);
      const _preClickNetLogLen = _netLog.length;
      while (Date.now() - _netSettleStart < _NET_SETTLE_TIMEOUT) {
        const _newEntries = _netLog.slice(_preClickNetLogLen);
        const _mutationResponse = _newEntries.find(e =>
          e.ts >= _lastMutatingStepTs - 500 &&
          /^(POST|PUT|PATCH|DELETE)$/.test(e.method) &&
          e.status >= 200 && e.status < 300
        );
        if (_mutationResponse) {
          logger.info(`[playwright.agent] Plan-Execute: network settle detected ${_mutationResponse.method} ${_mutationResponse.url.slice(0, 60)} → ${_mutationResponse.status} after ${Date.now() - _netSettleStart}ms`);
          break;
        }
        await page.waitForTimeout(300);
      }
      if (Date.now() - _netSettleStart >= _NET_SETTLE_TIMEOUT) {
        logger.info(`[playwright.agent] Plan-Execute: network settle timed out after ${_NET_SETTLE_TIMEOUT}ms — proceeding with verification anyway`);
      }
    }

    // 5. Goal verification (F7c) — confirm the goal was actually achieved, not
    // just that every step returned ok=true. Location-aware: phrases from
    // "titled X" must land in document.title or a title-ish input, not in a
    // modal's input (the Find-and-replace trap). On fail, return ok:false so
    // the caller falls through to the turn-loop instead of falsely reporting
    // success. VLM arbitrates when no phrases are extractable.
    let _goalVerify = null;
    try {
      // For send/submit goals, use unified action verification (B>D>A>C).
      // Phrase matching would false-negative: if email was sent, text is gone → FAIL.
      const _isSendSubmitGoal = /\b(send|post|submit|publish|dispatch|email|tweet|share|reply|comment)\b/i.test(goal);
      if (_isSendSubmitGoal) {
        // Extract expected text from goal (text after "saying" or "message" or quoted text)
        const _expectedText = (goal.match(/(?:saying|message|body|content)\s+["']?([^"'.\n]+)["']?/i) || [])[1] ||
          (goal.match(/["']([^"']{5,})["']/) || [])[1] || '';
        _goalVerify = await _verifyActionCompletion({
          goal: verificationGoal || goal, sessionId, headed, pageType: undefined,
          submitClickTs: _lastMutatingStepTs || Date.now() - 5000, // last mutating step, or 5s ago as fallback
          expectedText: _expectedText,
          isSendSubmitGoal: true,
        });
        // If action verification is inconclusive, fall back to phrase matching
        if (!_goalVerify) {
          _goalVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _peTranscript });
        }
      } else {
        _goalVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _peTranscript });
      }
    } catch (_gvErr) {
      logger.warn(`[playwright.agent] focused Plan-Execute: goal verification error (non-fatal): ${_gvErr.message}`);
    }
    // On verification fail, fall through to the turn-loop. The 'unavailable'
    // source (returned when both LLM and VLM are down) is NOT 'inconclusive',
    // so it triggers the fail path — preventing false-success when all
    // verification paths are unavailable (e.g. add-to-playlist tasks that
    // only searched then reported success with no verification possible).
    if (_goalVerify && !_goalVerify.pass && _goalVerify.source !== 'inconclusive') {
      logger.warn(`[playwright.agent] focused Plan-Execute: goal verification FAILED — ${_goalVerify.reason} — falling back to turn-loop`);
      return {
        ok: false,
        error: `goal verification failed: ${_goalVerify.reason}`,
        result: _resultText,
        transcript: _peTranscript,
        routingDecision: 'focused_plan_execute_goal_verify_fail',
        executionTime: _execTime,
      };
    }
    const _verifyNote = _goalVerify ? ` verified=${_goalVerify.pass} (${_goalVerify.source})` : '';
    logger.info(`[playwright.agent] focused Plan-Execute: completed in ${_execTime}ms${_replanned ? ' (after 1 replan)' : ''}${_verifyNote}`);
    return { ok: true, result: _resultText, transcript: _peTranscript, routingDecision: 'focused_plan_execute', goalVerified: _goalVerify?.pass || false };

  } catch (e) {
    logger.warn(`[playwright.agent] focused Plan-Execute error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// _executeStateDiffLoop — Phase 2a: state-aware action loop.
// For each sub-task: capture beforeState (full) → ask LLM for ONE action →
// execute → capture afterState (cheap) → diff → verify → repeat or move on.
// Uses _resolveActionTarget for ambiguous clickByText targets.
// Falls back to _executeTurnLoopFallback if it can't complete.
// ---------------------------------------------------------------------------
const STATE_DIFF_LOOP_SYSTEM_PROMPT = `You are a browser automation agent. You receive the current page state (DOM snapshot + visible text) and a sub-task to complete. You must output ONE action as JSON.

Available actions:
  clickByText     { "action": "clickByText", "text": "Save", "tag": "button", "exact": true }
  clickBySelector { "action": "clickBySelector", "selector": "#save-btn" }
  click           { "action": "click", "selector": "td20" }
  type            { "action": "type", "selector": "input[name='title']", "text": "Christian Music" }
  fill            { "action": "fill", "selector": "input[name='title']", "text": "Christian Music" }
  reactFill       { "action": "reactFill", "selector": "input[name='title']", "text": "Christian Music" }
  press           { "action": "press", "key": "Enter" }
  navigate        { "action": "navigate", "url": "https://..." }
  return          { "action": "return", "data": "done" }

Rules:
- Output ONLY the JSON action, no explanation.
- If the sub-task is already complete based on the page state, return done.
- If a dialog/menu is open that is NOT related to the sub-task, press Escape to dismiss it first.
- Do NOT click elements inside cookie/consent/language dialogs — dismiss them with Escape.
- Use the DOM STATE SIGNALS and OCR text to identify the correct element.
- If multiple elements have the same text, use the one inside the dialog/section relevant to the sub-task.`;

// ---------------------------------------------------------------------------
// Tier 1.9: LiteParser-First Action Loop
// Uses Playwright screenshot + LiteParser OCR as the PRIMARY source of truth.
// Clicks at OCR coordinates (deterministic, shadow-DOM-proof).
// Middle-ground state-diff: DOM hash for cheap change detection, OCR re-capture
// only when DOM hash is unchanged (possible no-op) or verification fails.
// ---------------------------------------------------------------------------
const LITEPARSE_FIRST_SYSTEM_PROMPT = `You are a browser automation agent. You receive OCR text items with screen coordinates and a sub-task to complete. You must output ONE action as JSON.

Available actions:
  clickByText  { "action": "clickByText", "text": "Save" }
  type         { "action": "type", "text": "Christian Music", "fieldText": "Add a name" }
  press        { "action": "press", "key": "Enter" }
  pressEscape  { "action": "pressEscape" }
  return       { "action": "return", "data": "done" }

Rules:
- Output ONLY the JSON action, no explanation.
- For clickByText: pick the text of the button/link you want to click. The system will find it on screen via fuzzy matching and click at its coordinates.
- For type: provide "fieldText" = the placeholder/label of the input field to click first, and "text" = the text to type.
- If the sub-task is already complete based on the OCR text, return done.
- If a dialog/menu is open that is NOT related to the sub-task, pressEscape to dismiss it first.
- Do NOT click elements inside cookie/consent/language dialogs — dismiss them with Escape.
- Use the OCR TEXT ITEMS with coordinates to identify what's visible on screen.`;

async function _executeLiteparseFirstLoop({ goal, verificationGoal, sessionId, headed, timeoutMs, deadline, start, heartbeat, hostname, _preDecomposedSubTasks = null, _progressCallbackUrl, _stepIndex }) {
  const _lpStart = Date.now();
  logger.info(`[playwright.agent] Tier 1.9 (LiteParser-first): starting for goal="${goal.slice(0, 80)}"`);

  try {
    const page = engine.getPage(sessionId);
    if (!page) return { ok: false, error: 'no page' };

    // Decompose goal into sub-tasks (with expectedState)
    let _subTasks = _preDecomposedSubTasks;
    if (!_subTasks) {
      const _decomp = await _decomposeGoalIntoSubTasks(goal, sessionId);
      if (_decomp.ok && _decomp.subTasks) {
        _subTasks = _decomp.subTasks;
      }
    }
    if (!_subTasks || _subTasks.length === 0) {
      logger.warn(`[playwright.agent] Tier 1.9: no sub-tasks — falling through`);
      return { ok: false, error: 'no sub-tasks available' };
    }
    logger.info(`[playwright.agent] Tier 1.9: ${_subTasks.length} sub-tasks`);

    const _lpTranscript = [];
    const MAX_ACTIONS_PER_SUBTASK = 5;
    let _prevOcrItems = null; // carry across sub-task boundaries (optimization #2)

    // Emit tier progress
    postProgress(_progressCallbackUrl, {
      type: 'agent:tier',
      stepIndex: _stepIndex,
      tier: 'liteparse-first',
      message: `LiteParser-first loop: ${_subTasks.length} sub-tasks`,
    });

    for (let _stIdx = 0; _stIdx < _subTasks.length; _stIdx++) {
      const _st = _subTasks[_stIdx];
      if (_st.completed) continue;
      if (Date.now() > deadline) {
        logger.warn(`[playwright.agent] Tier 1.9: deadline exceeded at sub-task #${_st.id}`);
        return { ok: false, error: 'deadline exceeded', transcript: _lpTranscript };
      }

      logger.info(`[playwright.agent] Tier 1.9: sub-task #${_st.id}/${_subTasks.length} — "${_st.description.slice(0, 80)}"`);

      // Emit sub-task progress
      postProgress(_progressCallbackUrl, {
        type: 'agent:tier',
        stepIndex: _stepIndex,
        tier: 'liteparse-first',
        message: `Sub-task ${_st.id}/${_subTasks.length}: ${_st.description.slice(0, 80)}`,
      });

      // 1. Capture beforeState: OCR + DOM hash
      // Reuse previous OCR if available and fresh (optimization #2: cache across sub-task boundaries)
      let _beforeOcr = null;
      let _beforeDomHash = '';
      if (_prevOcrItems && (Date.now() - (_prevOcrItems._ts || 0)) < 3000) {
        _beforeOcr = _prevOcrItems;
        logger.info(`[playwright.agent] Tier 1.9: reusing cached OCR from previous sub-task (${_beforeOcr.length} items)`);
      } else {
        const _cap = await _liteparseCapture(page);
        if (!_cap.ok) {
          logger.warn(`[playwright.agent] Tier 1.9: LiteParser capture failed — falling through`);
          return { ok: false, error: 'LiteParser capture failed', transcript: _lpTranscript };
        }
        _beforeOcr = _cap.textItems || [];
        _beforeOcr._ts = Date.now();
        _beforeOcr._imgW = _cap.imageWidth;
        _beforeOcr._imgH = _cap.imageHeight;
      }
      // DOM hash (cheap)
      try {
        _beforeDomHash = await page.evaluate(() => {
          const els = document.querySelectorAll('button, a, [role="button"], [role="link"], input, [contenteditable], [role="dialog"], [aria-modal="true"]');
          const sigs = [];
          for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            const t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40);
            sigs.push(`${el.tagName}|${el.getAttribute('role') || ''}|${t}`);
          }
          let h = 0;
          const joined = sigs.join('§');
          for (let i = 0; i < joined.length; i++) { h = ((h << 5) - h + joined.charCodeAt(i)) | 0; }
          return `${h}_${sigs.length}`;
        }).catch(() => '');
      } catch (_) {}

      let _actionCount = 0;
      let _noOpCount = 0;

      // Pre-compute noise dialog rects (cookie/consent/language) so we can filter
      // OCR items that fall inside them. Computed once per sub-task.
      const _imgW0 = _beforeOcr._imgW || 1280;
      const _imgH0 = _beforeOcr._imgH || 800;
      const _noiseRects = await _getNoiseDialogRects(page, _imgW0, _imgH0);

      // 2. Action loop for this sub-task
      while (_actionCount < MAX_ACTIONS_PER_SUBTASK) {
        if (Date.now() > deadline) break;

        // Build filtered + structured OCR text items list for the LLM prompt
        const _ocrFiltered = _filterOcrForPrompt(_beforeOcr, {
          imageWidth: _beforeOcr._imgW || 1280,
          imageHeight: _beforeOcr._imgH || 800,
          noiseDialogRects: _noiseRects,
        });
        const _ocrForPrompt = _ocrFiltered.formatted;
        const _ocrFullText = _ocrFiltered.filtered.map(i => i.text).join(' ');
        if (_actionCount === 0 && _ocrFiltered.noise > 0) {
          logger.info(`[playwright.agent] Tier 1.9: filtered ${_ocrFiltered.noise} noise OCR items (cookie/consent/short) — ${_ocrFiltered.filtered.length} remaining`);
        }

        // Build the LLM prompt
        const _turnUser = `SUB-TASK #${_st.id}: ${_st.description}
VERIFICATION: ${_st.verification}
EXPECTED STATE AFTER: ${_st.expectedState || '(not specified)'}

OCR TEXT ITEMS (what's actually visible on screen, classified + sorted — interactive first):
${_ocrForPrompt.slice(0, 3000)}

${_noOpCount > 0 ? `\n⚠️ LAST ACTION HAD NO EFFECT (no-op #${_noOpCount}). Try a COMPLETELY different approach.\n` : ''}
${_actionCount === 0 ? 'What is your first action to complete this sub-task?' : `Action ${_actionCount + 1}/${MAX_ACTIONS_PER_SUBTASK}. What is your next action?`}

Output ONLY the JSON action:`;

        let _actionRaw;
        try {
          _actionRaw = await askWithMessages([
            { role: 'system', content: LITEPARSE_FIRST_SYSTEM_PROMPT },
            { role: 'user', content: _turnUser },
          ], { temperature: 0.1, maxTokens: 300, responseTimeoutMs: 20000 });
        } catch (_llmErr) {
          logger.warn(`[playwright.agent] Tier 1.9: LLM call failed: ${_llmErr.message}`);
          break;
        }

        const _action = parseJson(_actionRaw);
        if (!_action || !_action.action) {
          logger.warn(`[playwright.agent] Tier 1.9: unparseable action: ${(_actionRaw || '').slice(0, 100)}`);
          break;
        }

        // Return = sub-task done
        if (_action.action === 'return') {
          let _retUrl = '';
          try { _retUrl = page.url(); } catch (_) {}
          const _verifyResult = await _checkSubTaskCompletion(_st, page, _retUrl, await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => ''));
          if (_verifyResult) {
            _st.completed = true;
            logger.info(`[playwright.agent] Tier 1.9: sub-task #${_st.id} completed (return + verification passed)`);
            _lpTranscript.push({ action: _action, outcome: { ok: true }, subTask: _st.id });
            break;
          } else {
            logger.warn(`[playwright.agent] Tier 1.9: sub-task #${_st.id} return rejected — verification not met`);
            _actionCount++;
            continue;
          }
        }

        // 3. Execute the action via OCR coordinates
        let _outcome;
        const _imgW = _beforeOcr._imgW || 1280;
        const _imgH = _beforeOcr._imgH || 800;
        const _vpW = page.viewportSize()?.width || 1280;
        const _vpH = page.viewportSize()?.height || 800;
        const _scaleX = _vpW / _imgW;
        const _scaleY = _vpH / _imgH;

        try {
          if (_action.action === 'pressEscape') {
            await page.keyboard.press('Escape');
            _outcome = { ok: true, result: 'Escape pressed' };
            logger.info(`[playwright.agent] Tier 1.9: pressed Escape`);
          } else if (_action.action === 'press') {
            await page.keyboard.press(_action.key || 'Enter');
            _outcome = { ok: true, result: `Pressed ${_action.key || 'Enter'}` };
            logger.info(`[playwright.agent] Tier 1.9: pressed ${_action.key || 'Enter'}`);
          } else if (_action.action === 'clickByText') {
            // Find the OCR text item matching the target text (fuzzy)
            // Use the filtered list (noise removed) for cleaner matching
            const _target = _action.text || '';
            const _candidates = _ocrFiltered.filtered.length > 0 ? _ocrFiltered.filtered : _beforeOcr;
            let _bestItem = null;
            let _bestScore = Infinity;
            for (const item of _candidates) {
              const _m = _fuzzyMatchText(_target, item.text, 2);
              if (_m.match) {
                // Prefer items in the dialog/modal region (center of screen, not top bar)
                const _cy = item.y + (item.height || 0) / 2;
                const _isInDialog = _cy > 80 && _cy < _imgH - 50;
                // Prefer items classified as button/link (interactive) over plain text
                const _typeBonus = (item._type === 'button' || item._type === 'link') ? -1 : 0;
                const _score = _m.distance + (_isInDialog ? 0 : 5) + (_m.exact ? -1 : 0) + _typeBonus;
                if (_score < _bestScore) { _bestScore = _score; _bestItem = item; }
              }
            }
            if (_bestItem) {
              const _clickX = Math.round((_bestItem.x + (_bestItem.width || 0) / 2) * _scaleX);
              const _clickY = Math.round((_bestItem.y + (_bestItem.height || 0) / 2) * _scaleY);
              logger.info(`[playwright.agent] Tier 1.9: clicking "${_bestItem.text}" at (${_clickX}, ${_clickY}) — fuzzy match for "${_target}" (score=${_bestScore} type=${_bestItem._type || '?'})`);
              await page.mouse.click(_clickX, _clickY);
              _outcome = { ok: true, result: `Clicked "${_bestItem.text}" at (${_clickX}, ${_clickY})` };
            } else {
              _outcome = { ok: false, error: `No OCR text item matching "${_target}" (fuzzy)` };
              logger.warn(`[playwright.agent] Tier 1.9: no OCR match for "${_target}"`);
            }
          } else if (_action.action === 'type') {
            // Click the field first, then type
            const _fieldTarget = _action.fieldText || '';
            const _candidates = _ocrFiltered.filtered.length > 0 ? _ocrFiltered.filtered : _beforeOcr;
            let _fieldItem = null;
            let _fieldScore = Infinity;
            for (const item of _candidates) {
              const _m = _fuzzyMatchText(_fieldTarget, item.text, 2);
              if (_m.match) {
                // Prefer items classified as input fields
                const _typeBonus = item._type === 'input' ? -2 : 0;
                const _score = _m.distance + (_m.exact ? -1 : 0) + _typeBonus;
                if (_score < _fieldScore) { _fieldScore = _score; _fieldItem = item; }
              }
            }
            if (_fieldItem) {
              const _clickX = Math.round((_fieldItem.x + (_fieldItem.width || 0) / 2) * _scaleX);
              const _clickY = Math.round((_fieldItem.y + (_fieldItem.height || 0) / 2) * _scaleY);
              logger.info(`[playwright.agent] Tier 1.9: clicking field "${_fieldItem.text}" at (${_clickX}, ${_clickY}) then typing "${_action.text}"`);
              await page.mouse.click(_clickX, _clickY);
              await page.waitForTimeout(200);
              await page.keyboard.type(_action.text || '', { delay: 50 });
              _outcome = { ok: true, result: `Typed "${_action.text}" into "${_fieldItem.text}"` };
            } else {
              _outcome = { ok: false, error: `No OCR text item matching field "${_fieldTarget}"` };
              logger.warn(`[playwright.agent] Tier 1.9: no OCR match for field "${_fieldTarget}"`);
            }
          } else {
            _outcome = { ok: false, error: `Unknown action: ${_action.action}` };
          }
        } catch (_execErr) {
          _outcome = { ok: false, error: _execErr.message };
        }
        _lpTranscript.push({ action: _action, outcome: _outcome, subTask: _st.id });
        _actionCount++;

        // Emit turn progress
        postProgress(_progressCallbackUrl, {
          type: 'agent:turn',
          stepIndex: _stepIndex,
          turn: _actionCount,
          maxTurns: MAX_ACTIONS_PER_SUBTASK,
          action: _action,
          outcome: _outcome,
          thoughts: '',
        });

        if (!_outcome.ok) {
          logger.warn(`[playwright.agent] Tier 1.9: action failed: ${_outcome.error}`);
          continue;
        }

        // 4. State-diff: middle-ground optimization
        // Cheap DOM hash first — only re-capture OCR if DOM hash is unchanged
        let _afterDomHash = '';
        try {
          _afterDomHash = await page.evaluate(() => {
            const els = document.querySelectorAll('button, a, [role="button"], [role="link"], input, [contenteditable], [role="dialog"], [aria-modal="true"]');
            const sigs = [];
            for (const el of els) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              const s = window.getComputedStyle(el);
              if (s.display === 'none' || s.visibility === 'hidden') continue;
              const t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40);
              sigs.push(`${el.tagName}|${el.getAttribute('role') || ''}|${t}`);
            }
            let h = 0;
            const joined = sigs.join('§');
            for (let i = 0; i < joined.length; i++) { h = ((h << 5) - h + joined.charCodeAt(i)) | 0; }
            return `${h}_${sigs.length}`;
          }).catch(() => '');
        } catch (_) {}

        const _domChanged = _beforeDomHash && _afterDomHash && _beforeDomHash !== _afterDomHash;

        if (_domChanged) {
          // DOM changed — something happened. Check verification.
          _noOpCount = 0;
          logger.info(`[playwright.agent] Tier 1.9: DOM hash changed — checking verification`);
        } else {
          // DOM unchanged — re-capture OCR to check for shadow-DOM-only change
          logger.info(`[playwright.agent] Tier 1.9: DOM hash unchanged — re-capturing OCR to check for shadow-DOM change`);
          const _reCap = await _liteparseCapture(page);
          if (_reCap.ok) {
            const _ocrDiff = _diffOcrText(_beforeOcr, _reCap.textItems || []);
            if (_ocrDiff.changed) {
              _noOpCount = 0;
              logger.info(`[playwright.agent] Tier 1.9: OCR text changed (${_ocrDiff.added.length} added, ${_ocrDiff.removed.length} removed) — progress`);
              // Update beforeOcr for next iteration
              _beforeOcr = _reCap.textItems || [];
              _beforeOcr._ts = Date.now();
              _beforeOcr._imgW = _reCap.imageWidth;
              _beforeOcr._imgH = _reCap.imageHeight;
            } else {
              _noOpCount++;
              logger.warn(`[playwright.agent] Tier 1.9: no-op detected (DOM + OCR unchanged) — noOpCount=${_noOpCount}`);
              // Update beforeOcr anyway (page may have scrolled)
              _beforeOcr = _reCap.textItems || [];
              _beforeOcr._ts = Date.now();
              _beforeOcr._imgW = _reCap.imageWidth;
              _beforeOcr._imgH = _reCap.imageHeight;
            }
          }
        }

        // 5. Check verification
        let _pageUrl = '', _pageText = '';
        try { _pageUrl = page.url(); } catch (_) {}
        _pageText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');

        const _verified = await _checkSubTaskCompletion(_st, page, _pageUrl, _pageText);
        if (_verified) {
          _st.completed = true;
          logger.info(`[playwright.agent] Tier 1.9: sub-task #${_st.id} completed (verification passed after ${_actionCount} action(s))`);

          // If DOM changed but we didn't re-capture OCR, capture now for the next sub-task
          if (_domChanged && !_prevOcrItems) {
            const _finalCap = await _liteparseCapture(page);
            if (_finalCap.ok) {
              _prevOcrItems = _finalCap.textItems || [];
              _prevOcrItems._ts = Date.now();
              _prevOcrItems._imgW = _finalCap.imageWidth;
              _prevOcrItems._imgH = _finalCap.imageHeight;
            }
          } else {
            _prevOcrItems = _beforeOcr;
          }
          break;
        }

        // If DOM changed but verification failed, re-capture OCR to investigate
        if (_domChanged) {
          logger.info(`[playwright.agent] Tier 1.9: DOM changed but verification not met — re-capturing OCR to investigate`);
          const _reCap = await _liteparseCapture(page);
          if (_reCap.ok) {
            _beforeOcr = _reCap.textItems || [];
            _beforeOcr._ts = Date.now();
            _beforeOcr._imgW = _reCap.imageWidth;
            _beforeOcr._imgH = _reCap.imageHeight;
          }
        }

        // Update DOM hash for next iteration
        _beforeDomHash = _afterDomHash;
      } // end action loop

      if (!_st.completed) {
        // Try structural verification as fallback
        let _structPageText = '', _structPageUrl = '';
        try { _structPageText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => ''); } catch (_) {}
        try { _structPageUrl = page.url(); } catch (_) {}
        const _sv = await _structuralVerifySubTask(_st, { page, pageUrl: _structPageUrl, pageText: _structPageText, transcript: _lpTranscript, sessionId });
        if (_sv.verified) {
          _st.completed = true;
          logger.info(`[playwright.agent] Tier 1.9: sub-task #${_st.id} completed via structural verification (${_sv.gate}: ${_sv.reason})`);
        } else {
          logger.warn(`[playwright.agent] Tier 1.9: sub-task #${_st.id} NOT verified (${_sv.gate}: ${_sv.reason}) — falling through to Tier 2`);
          break;
        }
      }
    } // end sub-task loop

    // Check if all sub-tasks are complete
    const _allComplete = _subTasks.every(s => s.completed);
    if (_allComplete) {
      const _execTime = Date.now() - _lpStart;
      logger.info(`[playwright.agent] Tier 1.9: all ${_subTasks.length} sub-tasks completed in ${_execTime}ms`);
      return {
        ok: true,
        result: `All ${_subTasks.length} sub-tasks completed (Tier 1.9 LiteParser-first)`,
        transcript: _lpTranscript,
        routingDecision: 'liteparse_first',
        sessionId,
      };
    }

    const _incomplete = _subTasks.filter(s => !s.completed).map(s => `#${s.id} ${s.description}`);
    logger.warn(`[playwright.agent] Tier 1.9: ${_incomplete.length} sub-tasks incomplete: ${_incomplete.join(', ')}`);
    return { ok: false, error: `Tier 1.9: ${_incomplete.length} sub-tasks incomplete`, transcript: _lpTranscript, subTasks: _subTasks };
  } catch (e) {
    logger.warn(`[playwright.agent] Tier 1.9 error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Tier 1.8: Visual Discovery Loop
// Slow, screenshot-first observer for menu-driven multi-step flows.
// For each sub-task: capture OCR → propose ONE action → execute → re-capture →
// compare → backtrack or proceed. Probes hidden menus, backtracks on no-ops,
// and uses structural verification (not just text presence).
// Falls back to Tier 1.9 if it can't complete.
// ---------------------------------------------------------------------------

const VISUAL_DISCOVERY_SYSTEM_PROMPT = `You are a browser automation agent. You receive the current page state and a sub-task. You output ONE action as JSON.

Available actions:
  clickByText   { "action": "clickByText", "text": "<exact text of element>" }
  type          { "action": "type", "text": "<text to type>", "fieldText": "<input placeholder/label>" }
  press         { "action": "press", "key": "Enter|Tab|Escape|ArrowDown|ArrowUp|ArrowLeft|ArrowRight|Meta+a|Meta+c|Meta+v" }
  pressEscape   { "action": "pressEscape" }
  scroll        { "action": "scroll", "direction": "down|up", "amount": 300 }
  hover         { "action": "hover", "text": "<text of element to hover over>" }
  return        { "action": "return", "data": "done" }

Output format (JSON only, no explanation):
{
  "action": "...",
  "text": "...",
  "fieldText": "...",
  "key": "...",
  "url": "...",
  "direction": "...",
  "amount": 300,
  "expectChange": "what should change after this action",
  "reasoning": "1 sentence why"
}

Rules:
- Output ONLY the JSON action, no explanation outside the JSON.
- When a popup/menu/dialog is open, act INSIDE it. Do not dismiss it unless it's unrelated.
- Use clickByText with the EXACT text of the element you want to click.
- If content might be below the fold, use scroll to reveal it.
- After typing into a field, press Enter or click the confirm/save button.
- If a notification/toast appeared confirming your action, the sub-task may be complete — return done.
- If a tab needs switching, clickByText the tab label.
- If an accordion/tree node needs expanding, clickByText its label.
- If a checkbox/toggle needs toggling, clickByText its label.
- If a select/dropdown needs changing, clickByText its current value to open options.
- Do NOT navigate — you are already on the correct page (URL-first navigation is handled before this tier). Work only with elements visible on the current page. If you believe you're on the wrong page, return done with an explanation.
- If nothing on screen helps, click a REVEALABLE TRIGGER to open hidden UI.
- If the page is loading, WAIT — do not act until loading completes.
- If there are validation errors, fix the inputs before proceeding.
- If you need to hover to reveal content, use the hover action.
- Do NOT click elements inside cookie/consent/privacy dialogs — dismiss with pressEscape.
- Do NOT click disabled buttons — they won't work. Fix prerequisites first.
- In menus and listboxes, you can use press ArrowDown/ArrowUp to navigate between items and press Enter to select. This is often more reliable than clickByText for menu items.
- You may need MULTIPLE actions inside a popup: type to filter/search, then click a result. Don't dismiss the popup after the first action if more steps are needed.
- PREFER EXACT text matches. Avoid 1-2 word fragments — use the full label.
- When a dialog/modal is open, ONLY interact with elements INSIDE it. Background elements are unreachable — clicking them will close the modal.
- To rename or edit text in a dialog, use type with the input's placeholder or label as fieldText. Do NOT clickByText the current text value — that clicks the label behind the modal.
- After typing a new value into a dialog input, click Save or press Enter to confirm. Do not click outside the dialog.
- Think: what would a human do next to get one step closer to the goal?

REVEALABLE TRIGGERS — structural hints (click to open hidden UI):
- collapsed: element has aria-expanded="false" — can be expanded to reveal content
- expanded: element has aria-expanded="true" — already open, may have sub-items
- has-popup: element declares aria-haspopup — opens a popup/menu/dialog
- controls: element has aria-controls — controls visibility of another element
- owns: element has aria-owns — owns child elements (may be dynamically populated)
- toggle: element has data-toggle/data-bs-toggle — toggles UI state
- icon-only: element has no visible text but has an icon — could be a menu/more button
- in-nav: element is inside a nav/aside/navigation container
- in-toolbar: element is inside a toolbar/menubar
- in-menu: element is inside a menu/listbox
- interactive: standard interactive element (button/link/etc.) with no special semantics`;

// DOM helper: find candidate menu triggers that can reveal hidden UI.
// Fully structural/ARIA-based — NO regex on text content. The LLM reads the
// text from OCR and decides what's relevant; we only provide structural metadata.
// Returns array of { text, ariaLabel, tag, role, rect, hint, hintList, inNav, inToolbar, inMenu }
async function _probeRevealableMenus(page) {
  if (!page) return [];
  try {
    const _menus = await page.evaluate(() => {
      const _out = [];
      // All-encompassing structural selector — captures every interactive pattern
      // without matching on text content or app-specific data attributes.
      const _sel = [
        // Standard interactive elements
        'button', 'a', '[role="button"]', '[role="link"]',
        '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="tab"]', '[role="option"]', '[role="treeitem"]',
        // ARIA expansion/popup semantics (any value — "false" = collapsed, "true" = expanded)
        '[aria-haspopup]', '[aria-expanded]', '[aria-controls]', '[aria-owns]',
        // Framework toggle patterns (Bootstrap, etc.)
        '[data-toggle]', '[data-bs-toggle]', '[data-dismiss]', '[data-target]',
        // Elements with click handlers or tabindex (interactive but not standard tags)
        '[onclick]', '[tabindex]:not([tabindex="-1"])',
        // Input-like elements that might trigger UI (search, combobox)
        '[role="combobox"]', '[role="searchbox"]', 'input[type="search"]',
        'input[type="submit"]', 'input[type="button"]', 'input[type="image"]',
      ].join(', ');
      const _seen = new Set();
      const _els = Array.from(document.querySelectorAll(_sel));
      for (const el of _els) {
        if (_seen.has(el)) continue;
        _seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 5 || r.height < 5) continue;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
        // Skip elements inside noise dialogs (cookie/consent/privacy)
        let _inNoise = false;
        let _cur = el;
        while (_cur) {
          if (_cur.getAttribute && (_cur.getAttribute('role') === 'dialog' || _cur.getAttribute('aria-modal') === 'true')) {
            const _dt = (_cur.innerText || '').toLowerCase();
            if (/cookie|consent|privacy|language|gdpr/.test(_dt)) { _inNoise = true; break; }
          }
          _cur = _cur.parentElement;
        }
        if (_inNoise) continue;

        // Extract structural properties — NO text content matching
        const _text = (el.innerText || el.textContent || '').trim().slice(0, 40);
        const _aria = (el.getAttribute('aria-label') || '').trim().slice(0, 40);
        const _tag = el.tagName.toLowerCase();
        const _role = el.getAttribute('role') || '';
        const _expanded = el.getAttribute('aria-expanded');
        const _hasPopup = el.hasAttribute('aria-haspopup');
        const _testid = (el.getAttribute('data-testid') || '').toLowerCase();

        // Classify by STRUCTURAL properties only — zero regex on text
        const _hintList = [];
        if (_expanded === 'false') _hintList.push('collapsed');
        if (_expanded === 'true') _hintList.push('expanded');
        if (_hasPopup) _hintList.push('has-popup');
        if (el.hasAttribute('aria-controls')) _hintList.push('controls');
        if (el.hasAttribute('aria-owns')) _hintList.push('owns');
        if (el.hasAttribute('data-toggle') || el.hasAttribute('data-bs-toggle')) _hintList.push('toggle');
        // Icon-only button: no text/aria-label but has icon child
        const _hasIconChild = el.querySelector('svg, img, i[class*="icon"], [class*="icon"]');
        if (!_text && !_aria && _hasIconChild) _hintList.push('icon-only');
        // Contextual containers — where the element lives
        const _inNav = !!el.closest('nav, aside, [role="navigation"]');
        const _inToolbar = !!el.closest('[role="toolbar"], [role="menubar"]');
        const _inMenu = !!el.closest('[role="menu"], [role="listbox"]');
        if (_inNav) _hintList.push('in-nav');
        if (_inToolbar) _hintList.push('in-toolbar');
        if (_inMenu) _hintList.push('in-menu');
        // Fallback: standard interactive with no special semantics
        if (_hintList.length === 0) _hintList.push('interactive');

        _out.push({
          text: _text || _aria || '(no label)',
          ariaLabel: _aria,
          tag: _tag,
          role: _role,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          hint: _hintList.join(' '),
          hintList: _hintList,
          inNav: _inNav,
          inToolbar: _inToolbar,
          inMenu: _inMenu,
          testid: _testid,
        });
      }
      // Sort by structural relevance — collapsed/has-popup most likely to reveal hidden UI
      const _priority = {
        'collapsed': 0,      // can be expanded — highest priority
        'has-popup': 1,      // declared popup behavior
        'controls': 2,       // controls another element's visibility
        'owns': 2,           // owns another element
        'toggle': 3,         // toggle behavior
        'icon-only': 4,      // might be a menu button with no visible label
        'in-nav': 5,         // navigation context
        'in-toolbar': 5,     // toolbar context
        'in-menu': 6,        // menu context
        'expanded': 7,       // already open
        'interactive': 8,    // generic catch-all
      };
      _out.sort((a, b) => {
        const _aBest = Math.min(...a.hintList.map(h => _priority[h] ?? 9));
        const _bBest = Math.min(...b.hintList.map(h => _priority[h] ?? 9));
        return _aBest - _bBest;
      });
      return _out.slice(0, 20);
    }).catch(() => []);
    return _menus;
  } catch (_) { return []; }
}

// Classify a raw popup element in Node.js (after page.evaluate returns role/className/rect).
function _classifyPopup(role, className, rect, winWidth) {
  const classes = (className || '').toLowerCase();
  if (role === 'menu' || role === 'menubar') return 'menu';
  if (role === 'listbox') return 'listbox';
  if (role === 'dialog' || role === 'alertdialog') {
    const r = rect || {};
    if ((r.x || 0) < 50 || ((r.x || 0) + (r.w || 0)) > (winWidth || 1280) - 50) return 'sheet';
    return 'dialog';
  }
  if (role === 'tooltip') return 'tooltip';
  if (role === 'status' || role === 'alert' || role === 'log') return 'status';
  if (role === 'tabpanel') return 'tabpanel';
  if (role === 'tree') return 'tree';
  if (role === 'grid') return 'calendar';
  if (role === 'popover') return 'popover';

  if (classes.includes('dropdown') || classes.includes('select-menu') || classes.includes('menu-popup') || classes.includes('context-menu') || classes.includes('menu-dropdown')) return 'menu';
  if (classes.includes('popover') || classes.includes('flyout')) return 'popover';
  if (classes.includes('autocomplete') || classes.includes('suggestions') || classes.includes('combobox-popup') || classes.includes('combobox-list')) return 'listbox';
  if (classes.includes('drawer') || classes.includes('sheet')) return 'sheet';
  if (classes.includes('calendar') || classes.includes('datepicker') || classes.includes('calendar-popup') || classes.includes('datepicker-popup')) return 'calendar';
  if (classes.includes('color-picker')) return 'popover';
  if (classes.includes('modal')) return 'dialog';
  if (classes.includes('tooltip')) return 'tooltip';
  if (classes.includes('toast') || classes.includes('snackbar') || classes.includes('alert-banner') || classes.includes('notification')) return 'status';

  return 'unknown';
}

// Universal DOM state observation: structured, deterministic replacement for _captureDomHash.
async function _captureDomState(page) {
  if (!page) return _emptyDomState();
  try {
    const _t0 = Date.now();
    const _state = await page.evaluate(() => {
      const _vpH = window.innerHeight;
      const _vpW = window.innerWidth;

      function _isVisible(el) {
        if (!el) return false;
        if (el.hasAttribute('hidden')) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.hasAttribute('inert')) return false;
        let _p = el.parentElement;
        while (_p) {
          if (_p.hasAttribute('inert')) return false;
          _p = _p.parentElement;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom < 0 || r.top > _vpH || r.right < 0 || r.left > _vpW) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        return true;
      }

      function _isInteractiveClickable(el) {
        const s = window.getComputedStyle(el);
        if (s.pointerEvents === 'none') return false;
        return true;
      }

      function _visibleText(el) {
        return (el.innerText || el.textContent || '').trim().slice(0, 60);
      }

      function _ariaLabel(el) {
        return (el.getAttribute('aria-label') || '').trim().slice(0, 60);
      }

      function _rectObj(r) {
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }

      function _isComplianceDialog(el) {
        const _patterns = ['cookie', 'consent', 'privacy', 'gdpr', 'language', 'opt-out', 'do not sell', 'ccpa'];
        const _label = (el.getAttribute('aria-label') || '').toLowerCase();
        const _cls = ((el.getAttribute && el.getAttribute('class')) || '').toLowerCase();
        const _text = ((el.innerText || '').slice(0, 200) || '').toLowerCase();
        for (const p of _patterns) {
          if (_label.includes(p) || _cls.includes(p)) return true;
          if (_text.includes(p) && _text.length < 300) return true;
        }
        return false;
      }

      function _isDisabled(el) {
        return el.hasAttribute('disabled') ||
          el.getAttribute('aria-disabled') === 'true' ||
          window.getComputedStyle(el).cursor === 'not-allowed';
      }

      // ── Popup detection ──
      const POPUP_SELECTORS = [
        '[role="menu"]', '[role="menubar"]', '[role="listbox"]', '[role="dialog"]',
        '[role="alertdialog"]', '[role="tooltip"]', '[role="tabpanel"]', '[role="tree"]',
        '[role="status"]', '[role="alert"]', '[role="log"]', '[role="popover"]', '[role="grid"]',
        '[aria-modal="true"]',
        '[data-radix-popper-content-wrapper]', '[data-radix-portal]',
        '[data-headlessui-portal]', '[data-headlessui-state="open"]',
        '[data-floating-ui-portal]',
        '[data-mui-portal]', '.MuiPopover-root', '.MuiDialog-root', '.MuiMenu-root',
        '.ant-dropdown', '.ant-popover', '.ant-modal', '.ant-select-dropdown', '.ant-menu-popup', '.ant-cascader-menus',
        '[data-chakra-portal]', '.chakra-portal',
        '.mantine-Popover-dropdown', '.mantine-Menu-dropdown', '.mantine-Modal-root',
        '.p-dropdown-panel', '.p-menu', '.p-dialog', '.p-overlay-panel',
        '.dropdown-menu.show', '.modal.show', '.popover.show',
        '.ion-popover', '.ion-modal',
        '[data-state="open"]',
        'dialog[open]', '[popover]:not([hidden])',
        '[class*="dropdown-menu"]', '[class*="dropdown-content"]', '[class*="dropdown-list"]', '[class*="select-dropdown"]',
        '[class*="menu-popup"]', '[class*="menu-dropdown"]', '[class*="context-menu"]',
        '[class*="popover-content"]', '[class*="popover-body"]', '[class*="flyout"]',
        '[class*="tooltip-content"]', '[class*="modal-content"]', '[class*="modal-body"]', '[class*="dialog-content"]',
        '[class*="drawer-content"]', '[class*="sheet-content"]', '[class*="sidebar-overlay"]', '[class*="panel-content"]',
        '[class*="autocomplete-dropdown"]', '[class*="suggestions-list"]', '[class*="combobox-list"]',
        '[class*="calendar-popup"]', '[class*="datepicker-popup"]', '[class*="color-picker-popup"]',
        '[class*="notification-toast"]', '[class*="toast-container"]', '[class*="alert-banner"]', '[class*="snackbar"]',
      ];

      const _popupEls = new Set();
      const _popups = [];
      for (const sel of POPUP_SELECTORS) {
        for (const el of document.querySelectorAll(sel)) {
          if (_popupEls.has(el)) continue;
          if (!_isVisible(el)) continue;
          // Skip elements inside an already-detected popup
          let _parent = el.parentElement;
          let _inside = false;
          while (_parent) {
            if (_popupEls.has(_parent)) { _inside = true; break; }
            _parent = _parent.parentElement;
          }
          if (_inside) continue;
          // Skip compliance / cookie dialogs from popups list (but record cookieConsentVisible)
          if (_isComplianceDialog(el)) continue;

          const r = _rectObj(el.getBoundingClientRect());
          const _role = el.getAttribute('role') || '';
          const _cls = (el.getAttribute('class') || '').toLowerCase();
          const _items = [];
          const _itemSelector = 'button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="treeitem"], [role="gridcell"], [role="button"], [role="link"]';
          for (const _item of el.querySelectorAll(_itemSelector)) {
            if (!_isVisible(_item) || !_isInteractiveClickable(_item)) continue;
            const _ir = _item.getBoundingClientRect();
            _items.push({
              text: _visibleText(_item),
              tag: _item.tagName.toLowerCase(),
              role: _item.getAttribute('role') || '',
              ariaLabel: _ariaLabel(_item),
              x: Math.round(_ir.x + _ir.width / 2),
              y: Math.round(_ir.y + _ir.height / 2),
              disabled: _isDisabled(_item),
            });
          }
          _items.sort((a, b) => a.y - b.y || a.x - b.x);

          let _hasInput = false;
          let _inputPlaceholder = '';
          for (const _inp of el.querySelectorAll('input, textarea, [contenteditable="true"], [role="searchbox"], [role="textbox"]')) {
            if (_isVisible(_inp)) { _hasInput = true; _inputPlaceholder = (_inp.placeholder || _inp.getAttribute('aria-label') || '').slice(0, 40); break; }
          }

          _popupEls.add(el);
          _popups.push({
            role: _role,
            className: _cls,
            tagName: el.tagName.toLowerCase(),
            rect: r,
            zIndex: parseInt(window.getComputedStyle(el).zIndex) || 0,
            text: _visibleText(el),
            items: _items.slice(0, 20),
            hasInput,
            inputPlaceholder: _inputPlaceholder,
          });
        }
      }

      // Sort popups by z-index then DOM depth (deepest last)
      _popups.sort((a, b) => (b.zIndex || 0) - (a.zIndex || 0));

      // ── Inputs (not inside popups) ──
      const _inputs = [];
      const _inputSelectors = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="color"]):not([type="range"]), textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"], [role="combobox"]';
      for (const el of document.querySelectorAll(_inputSelectors)) {
        if (!_isVisible(el) || el.closest('[role="menu"], [role="dialog"], [role="listbox"]')) continue;
        const r = el.getBoundingClientRect();
        _inputs.push({
          type: el.type || el.getAttribute('role') || 'text',
          placeholder: (el.placeholder || _ariaLabel(el) || '').slice(0, 40),
          value: (el.value || '').slice(0, 80),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          isFocused: document.activeElement === el,
          disabled: _isDisabled(el),
          readonly: !!el.readOnly,
          invalid: el.getAttribute('aria-invalid') === 'true',
          required: el.required || el.getAttribute('aria-required') === 'true',
        });
      }

      // ── Selects ──
      const _selects = [];
      for (const el of document.querySelectorAll('select, [role="listbox"]:not([role*="popup"])')) {
        if (!_isVisible(el) || el.closest('[role="menu"], [role="dialog"]')) continue;
        const r = el.getBoundingClientRect();
        const _opts = Array.from(el.querySelectorAll('option, [role="option"]')).map(o => ({
          text: _visibleText(o),
          value: o.value || o.getAttribute('value') || '',
          selected: o.selected || o.getAttribute('aria-selected') === 'true',
        })).slice(0, 20);
        _selects.push({
          placeholder: (el.getAttribute('aria-label') || '').slice(0, 40),
          value: (el.value || '').slice(0, 40),
          options: _opts,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        });
      }

      // ── Checkboxes / Radios / Toggles / Sliders / File inputs ──
      const _checkboxes = [];
      const _radios = new Map();
      const _toggles = [];
      const _sliders = [];
      const _fileInputs = [];
      for (const el of document.querySelectorAll('input[type="checkbox"], input[type="radio"], input[type="range"], input[type="file"], input[type="color"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]')) {
        if (!_isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const _common = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: _isDisabled(el) };
        const _role = el.getAttribute('role') || el.type || '';
        if (_role === 'checkbox' || el.type === 'checkbox') _checkboxes.push({ label: _ariaLabel(el) || _visibleText(el), checked: el.checked || el.getAttribute('aria-checked') === 'true', ..._common });
        else if (_role === 'radio' || el.type === 'radio') {
          const _name = el.name || el.getAttribute('name') || el.getAttribute('aria-label') || 'radio group';
          if (!_radios.has(_name)) _radios.set(_name, { name: _name, options: [], x: _common.x, y: _common.y });
          _radios.get(_name).options.push({ label: _ariaLabel(el) || _visibleText(el), checked: el.checked || el.getAttribute('aria-checked') === 'true' });
        }
        else if (_role === 'switch') _toggles.push({ label: _ariaLabel(el) || _visibleText(el), checked: el.getAttribute('aria-checked') === 'true', ..._common });
        else if (_role === 'slider' || el.type === 'range') _sliders.push({ label: _ariaLabel(el) || _visibleText(el), min: el.min || '0', max: el.max || '100', value: el.value || '0', ..._common });
        else if (el.type === 'file' || el.type === 'color') _fileInputs.push({ accept: el.accept || '', multiple: el.multiple, ..._common });
      }

      // ── Buttons / Links (not inside popups) ──
      const _buttons = [];
      for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"], [role="tab"], input[type="submit"], input[type="button"]')) {
        if (!_isVisible(el) || !_isInteractiveClickable(el) || el.closest('[role="menu"], [role="dialog"], [role="listbox"]')) continue;
        const r = el.getBoundingClientRect();
        const _text = _visibleText(el) || _ariaLabel(el);
        _buttons.push({
          text: _text,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          ariaLabel: _ariaLabel(el),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          disabled: _isDisabled(el),
        });
      }

      // ── Tabs / Accordions / Trees / Expanded elements ──
      const _tabs = [];
      let _activeTabPanel = null;
      for (const el of document.querySelectorAll('[role="tab"]')) {
        const r = el.getBoundingClientRect();
        _tabs.push({
          text: _visibleText(el),
          role: 'tab',
          ariaSelected: el.getAttribute('aria-selected') || 'false',
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          panelId: el.getAttribute('aria-controls') || '',
        });
      }
      const _activePanelId = _tabs.find(t => t.ariaSelected === 'true')?.panelId;
      if (_activePanelId) {
        const _panel = document.getElementById(_activePanelId);
        if (_panel && _isVisible(_panel)) {
          const r = _panel.getBoundingClientRect();
          _activeTabPanel = { text: _visibleText(_panel).slice(0, 200), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        }
      }

      const _accordions = [];
      const _expandedElements = [];
      for (const el of document.querySelectorAll('details, [aria-expanded]')) {
        if (!_isVisible(el)) continue;
        const _expanded = el.open || el.getAttribute('aria-expanded') === 'true';
        if (el.tagName.toLowerCase() === 'details' || el.hasAttribute('aria-expanded')) {
          const r = el.getBoundingClientRect();
          _accordions.push({ text: _visibleText(el).slice(0, 40), expanded: _expanded, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
        if (_expanded) {
          const r = el.getBoundingClientRect();
          _expandedElements.push({ text: _visibleText(el).slice(0, 40), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
      }

      const _treeItems = [];
      for (const el of document.querySelectorAll('[role="treeitem"]')) {
        if (!_isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        let _level = 0; let _p = el.parentElement;
        while (_p) { if (_p.getAttribute('role') === 'tree' || _p.getAttribute('role') === 'group' || _p.getAttribute('role') === 'treeitem') _level++; _p = _p.parentElement; }
        _treeItems.push({ text: _visibleText(el).slice(0, 40), level: _level, expanded: el.getAttribute('aria-expanded') === 'true', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }

      // ── Loading / Toasts / Validation errors / Confirm dialogs ──
      const _loadingIndicators = [];
      let _isLoading = false;
      for (const el of document.querySelectorAll('[role="progressbar"], [class*="loading"], [class*="spinner"], [class*="skeleton"]')) {
        if (!_isVisible(el)) continue;
        _isLoading = true;
        const r = el.getBoundingClientRect();
        const _role = el.getAttribute('role') || 'spinner';
        _loadingIndicators.push({ type: _role === 'progressbar' ? 'progressbar' : (el.getAttribute('class') || '').includes('skeleton') ? 'skeleton' : 'spinner', text: _visibleText(el).slice(0, 40), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }

      const _toasts = [];
      for (const el of document.querySelectorAll('[role="status"], [role="alert"], [class*="toast"], [class*="snackbar"], [class*="notification"]')) {
        if (!_isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const _cls = (el.getAttribute('class') || '').toLowerCase();
        let _type = 'info';
        if (_cls.includes('success') || _cls.includes('ok')) _type = 'success';
        else if (_cls.includes('error') || _cls.includes('fail')) _type = 'error';
        else if (_cls.includes('warning') || _cls.includes('warn')) _type = 'warning';
        _toasts.push({ text: _visibleText(el).slice(0, 120), role: el.getAttribute('role') || 'status', type: _type, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }

      const _validationErrors = [];
      for (const el of document.querySelectorAll('[aria-invalid="true"]')) {
        if (!_isVisible(el)) continue;
        const _errId = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
        let _msg = '';
        if (_errId) { const _err = document.getElementById(_errId); if (_err) _msg = _visibleText(_err); }
        _validationErrors.push({ field: (el.placeholder || _ariaLabel(el) || 'field').slice(0, 40), message: _msg.slice(0, 120) });
      }

      const _confirmDialogs = [];
      for (const el of document.querySelectorAll('[role="alertdialog"], [role="dialog"]')) {
        if (!_isVisible(el) || _isComplianceDialog(el)) continue;
        const _text = _visibleText(el).slice(0, 120);
        if (!_text.includes('?') && !_text.toLowerCase().includes('are you sure')) continue;
        const r = el.getBoundingClientRect();
        const _opts = [];
        for (const _btn of el.querySelectorAll('button, [role="button"], [role="menuitem"]')) {
          if (!_isVisible(_btn)) continue;
          const _br = _btn.getBoundingClientRect();
          _opts.push({ text: _visibleText(_btn) || _ariaLabel(_btn), x: Math.round(_br.x + _br.width / 2), y: Math.round(_br.y + _br.height / 2) });
        }
        _confirmDialogs.push({ text: _text, options: _opts.slice(0, 6), x: Math.round(r.x), y: Math.round(r.y) });
      }

      // ── Auth / Cookie consent ──
      const _loginUrl = /\/login|\/signin|\/sign-in|\/auth|\/account\/login/i.test(window.location.pathname);
      const _loginText = /sign\s*(in|up|into)|log\s*(in|into)|create\s*account|welcome\s*back/i.test((document.body.innerText || '').slice(0, 2000));
      const _oauthButtons = document.querySelectorAll('[class*="oauth"], [class*="social-login"], button[aria-label*="Google"], button[aria-label*="Apple"], button[aria-label*="GitHub"]');
      let _cookieConsentVisible = false;
      const _cookieText = /cookie|consent|privacy|gdpr|do not sell|tracking|advertising/i;
      for (const el of document.querySelectorAll('[role="dialog"], [class*="cookie"], [class*="consent"], [class*="gdpr"], #onetrust-banner-sdk, #cybotcookiepopup')) {
        if (!_isVisible(el)) continue;
        const _txt = (el.innerText || '').toLowerCase();
        if (_cookieText.test(_txt) || el.id.includes('cookie') || el.id.includes('consent')) { _cookieConsentVisible = true; break; }
      }

      // ── Media / Embedded ──
      const _iframes = [];
      for (const el of document.querySelectorAll('iframe')) { const r = el.getBoundingClientRect(); if (_isVisible(el)) _iframes.push({ src: (el.src || '').slice(0, 120), title: (el.title || '').slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); }
      const _videos = [];
      for (const el of document.querySelectorAll('video, audio')) { const r = el.getBoundingClientRect(); if (_isVisible(el)) _videos.push({ type: el.tagName.toLowerCase(), playing: !el.paused, x: Math.round(r.x), y: Math.round(r.y) }); }
      const _canvases = [];
      for (const el of document.querySelectorAll('canvas')) { const r = el.getBoundingClientRect(); if (_isVisible(el)) _canvases.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); }

      // ── Pagination / Load more ──
      let _pagination = null;
      for (const el of document.querySelectorAll('[role="navigation"], nav')) {
        if (!_isVisible(el)) continue;
        const _links = Array.from(el.querySelectorAll('a, button, [role="button"]'));
        const _current = _links.find(a => a.getAttribute('aria-current') === 'page' || a.classList.contains('active') || a.classList.contains('current'));
        if (_current) {
          const _currentPage = parseInt(_current.textContent, 10) || 1;
          const _totalPages = Math.max(..._links.map(a => parseInt(a.textContent, 10)).filter(n => !isNaN(n))) || _currentPage;
          _pagination = { currentPage: _currentPage, totalPages: _totalPages, nextPageButton: null, prevPageButton: null };
          break;
        }
      }

      let _loadMoreButton = null;
      for (const el of document.querySelectorAll('button, a, [role="button"]')) {
        if (!_isVisible(el)) continue;
        const _txt = _visibleText(el).toLowerCase();
        if (/load more|show more|see more|view more/.test(_txt)) {
          const r = el.getBoundingClientRect();
          _loadMoreButton = { text: _visibleText(el), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: _isDisabled(el) };
          break;
        }
      }

      // ── Active element ──
      const _active = document.activeElement;
      const _activeElement = (!_active || _active === document.body) ? null : (() => {
        const r = _active.getBoundingClientRect();
        return {
          tag: _active.tagName.toLowerCase(),
          role: _active.getAttribute('role') || '',
          type: _active.type || '',
          placeholder: (_active.placeholder || _ariaLabel(_active) || '').slice(0, 40),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      })();

      // ── Draggable / hover reveal ──
      const _draggableItems = [];
      for (const el of document.querySelectorAll('[draggable="true"]')) {
        if (!_isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        _draggableItems.push({ text: _visibleText(el).slice(0, 40), tag: el.tagName.toLowerCase(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }
      const _hoverRevealTriggers = [];
      for (const el of document.querySelectorAll('[aria-haspopup], [data-toggle], [data-bs-toggle]')) {
        if (!_isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        _hoverRevealTriggers.push({ text: _visibleText(el).slice(0, 40), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      }

      // ── Hash ──
      const _hashParts = [];
      for (const el of document.querySelectorAll('button, a, [role="button"], [role="link"], input, [contenteditable], [role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]')) {
        if (!_isVisible(el)) continue;
        const _t = _visibleText(el) || _ariaLabel(el) || el.value || '';
        _hashParts.push(`${el.tagName}|${el.getAttribute('role') || ''}|${_t}`);
      }
      let _h = 0;
      const _joined = _hashParts.join('§');
      for (let i = 0; i < _joined.length; i++) { _h = ((_h << 5) - _h + _joined.charCodeAt(i)) | 0; }
      const _hash = `${_h}_${_hashParts.length}`;

      const _scrollY = Math.round(window.scrollY);
      const _scrollableHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      return {
        title: document.title || '',
        hash: _hash,
        url: window.location.href,
        scrollY: _scrollY,
        viewportHeight: _vpH,
        scrollableHeight: _scrollableHeight,
        canScrollDown: (_scrollY + _vpH) < (_scrollableHeight - 2),
        canScrollUp: _scrollY > 2,
        popups: _popups.slice(0, 5),
        inputs: _inputs.slice(0, 10),
        selects: _selects.slice(0, 5),
        checkboxes: _checkboxes.slice(0, 10),
        radios: Array.from(_radios.values()).slice(0, 5),
        toggles: _toggles.slice(0, 10),
        sliders: _sliders.slice(0, 5),
        fileInputs: _fileInputs.slice(0, 5),
        buttons: _buttons.slice(0, 30),
        draggableItems: _draggableItems.slice(0, 10),
        hoverRevealTriggers: _hoverRevealTriggers.slice(0, 12),
        tabs: _tabs.slice(0, 10),
        activeTabPanel: _activeTabPanel,
        accordions: _accordions.slice(0, 10),
        expandedElements: _expandedElements.slice(0, 10),
        treeItems: _treeItems.slice(0, 15),
        isLoading,
        loadingIndicators: _loadingIndicators.slice(0, 3),
        toasts: _toasts.slice(0, 3),
        validationErrors: _validationErrors.slice(0, 5),
        confirmDialogs: _confirmDialogs.slice(0, 3),
        isLoginWall: _loginUrl || (_loginText && _oauthButtons.length > 0),
        cookieConsentVisible: _cookieConsentVisible,
        oauthProviders: [],
        iframes: _iframes.slice(0, 5),
        videos: _videos.slice(0, 5),
        canvases: _canvases.slice(0, 5),
        pagination: _pagination,
        loadMoreButton: _loadMoreButton,
        disabledButtons: _buttons.filter(b => b.disabled).map(b => ({ text: b.text, reason: b.disabled ? 'unknown' : 'unknown', x: b.x, y: b.y })).slice(0, 10),
        activeElement: _activeElement,
      };
    }).catch(() => null);

    if (!_state) return _emptyDomState();

    // Classify popups in Node.js using the captured role / className / rect
    const _vpW = page.viewportSize()?.width || 1280;
    for (const p of _state.popups) {
      p.type = _classifyPopup(p.role, p.className, p.rect, _vpW);
      p.hash = `${p.type}|${p.role}|${p.items.length}|${p.text}|${p.items.map(i => i.text).join(',')}`;
    }

    logger.info(`[playwright.agent] _captureDomState: ${Date.now() - _t0}ms`);
    return _state;
  } catch (e) {
    logger.warn(`[playwright.agent] _captureDomState failed: ${e.message}`);
    return _emptyDomState();
  }
}

function _emptyDomState() {
  return {
    title: '',
    hash: '',
    url: '',
    scrollY: 0,
    viewportHeight: 800,
    scrollableHeight: 800,
    canScrollDown: false,
    canScrollUp: false,
    popups: [],
    inputs: [],
    selects: [],
    checkboxes: [],
    radios: [],
    toggles: [],
    sliders: [],
    fileInputs: [],
    buttons: [],
    draggableItems: [],
    hoverRevealTriggers: [],
    tabs: [],
    activeTabPanel: null,
    accordions: [],
    expandedElements: [],
    treeItems: [],
    isLoading: false,
    loadingIndicators: [],
    toasts: [],
    validationErrors: [],
    confirmDialogs: [],
    isLoginWall: false,
    cookieConsentVisible: false,
    oauthProviders: [],
    iframes: [],
    videos: [],
    canvases: [],
    pagination: null,
    loadMoreButton: null,
    disabledButtons: [],
    activeElement: null,
  };
}

function _compareDomState(before, after, expectChange) {
  // 1. Navigation
  if (before.url !== after.url) {
    return { direction: 'closer', reason: `navigated: ${before.url} → ${after.url}`, navigated: true };
  }

  // 2. Popup opened
  const beforePopupCount = before.popups.length;
  const afterPopupCount = after.popups.length;
  if (afterPopupCount > beforePopupCount) {
    const newPopup = after.popups[afterPopupCount - 1];
    return {
      direction: 'closer',
      reason: `${newPopup.type} opened with ${newPopup.items.length} items`,
      popupOpened: true,
      popup: newPopup,
    };
  }

  // 3. expectChange popup hint
  if (expectChange && afterPopupCount > beforePopupCount && /menu|popup|dialog|dropdown/i.test(expectChange)) {
    return { direction: 'closer', reason: 'popup opened matching expectChange', popupOpened: true };
  }

  // 4. Popup closed
  if (beforePopupCount > 0 && afterPopupCount === 0) {
    return { direction: 'same', reason: 'popup closed', popupClosed: true };
  }

  // 5. Popup contents changed
  if (beforePopupCount > 0 && afterPopupCount > 0) {
    const beforeHash = before.popups.map(p => p.hash).join('|');
    const afterHash = after.popups.map(p => p.hash).join('|');
    if (beforeHash !== afterHash) {
      return {
        direction: 'closer',
        reason: 'popup contents changed',
        popupChanged: true,
        popup: after.popups[0],
      };
    }
  }

  // 6. Toast/notification appeared
  if (after.toasts.length > before.toasts.length) {
    const newToast = after.toasts[after.toasts.length - 1];
    return {
      direction: 'closer',
      reason: `notification appeared: "${newToast.text.slice(0, 60)}"`,
      toastAppeared: true,
      toast: newToast,
    };
  }

  // 7. Tab switched
  const beforeSelectedTab = before.tabs.find(t => t.ariaSelected === 'true');
  const afterSelectedTab = after.tabs.find(t => t.ariaSelected === 'true');
  if (beforeSelectedTab && afterSelectedTab && beforeSelectedTab.text !== afterSelectedTab.text) {
    return {
      direction: 'closer',
      reason: `tab switched: "${beforeSelectedTab.text}" → "${afterSelectedTab.text}"`,
      tabSwitched: true,
    };
  }

  // 8. Accordion/section expanded
  if (after.expandedElements.length > before.expandedElements.length) {
    const newExpanded = after.expandedElements[after.expandedElements.length - 1];
    return {
      direction: 'closer',
      reason: `element expanded: "${newExpanded.text.slice(0, 40)}"`,
      expanded: true,
    };
  }

  // 9. Tree node expanded
  const beforeExpandedTrees = before.treeItems.filter(t => t.expanded).length;
  const afterExpandedTrees = after.treeItems.filter(t => t.expanded).length;
  if (afterExpandedTrees > beforeExpandedTrees) {
    return { direction: 'closer', reason: 'tree node expanded', treeExpanded: true };
  }

  // 10. Focus moved to an input
  if (!before.activeElement && after.activeElement) {
    return { direction: 'closer', reason: `focus moved to ${after.activeElement.tag}`, focusChanged: true };
  }

  // 11. Scroll position changed
  if (Math.abs(after.scrollY - before.scrollY) > 100) {
    return {
      direction: 'closer',
      reason: `scrolled ${after.scrollY > before.scrollY ? 'down' : 'up'} (${Math.abs(after.scrollY - before.scrollY)}px)`,
      scrolled: true,
    };
  }

  // 12. Loading state changed
  if (before.isLoading && !after.isLoading) {
    return { direction: 'closer', reason: 'loading completed', loadingCompleted: true };
  }
  if (!before.isLoading && after.isLoading) {
    return { direction: 'same', reason: 'loading started', loadingStarted: true };
  }

  // 13. Validation errors
  if (after.validationErrors.length > before.validationErrors.length) {
    return {
      direction: 'same',
      reason: `validation error: ${after.validationErrors[after.validationErrors.length - 1].message}`,
      validationError: true,
    };
  }
  if (before.validationErrors.length > 0 && after.validationErrors.length === 0) {
    return { direction: 'closer', reason: 'validation errors cleared', errorsCleared: true };
  }

  // 14. Input value changed
  const inputChanged = after.inputs.some(inp => {
    const match = before.inputs.find(b => b.placeholder === inp.placeholder);
    return match && inp.value !== match.value;
  });
  if (inputChanged) {
    return { direction: 'closer', reason: 'input value changed', inputChanged: true };
  }

  // 15. Checkbox/toggle state changed
  const toggleChanged = after.checkboxes.some(cb => {
    const match = before.checkboxes.find(b => b.label === cb.label);
    return match && cb.checked !== match.checked;
  }) || after.toggles.some(tg => {
    const match = before.toggles.find(b => b.label === tg.label);
    return match && tg.checked !== match.checked;
  });
  if (toggleChanged) {
    return { direction: 'closer', reason: 'toggle/checkbox state changed', toggleChanged: true };
  }

  // 16. Pagination changed
  if (before.pagination?.currentPage !== after.pagination?.currentPage) {
    return {
      direction: 'closer',
      reason: `page changed: ${before.pagination?.currentPage} → ${after.pagination?.currentPage}`,
      paginated: true,
    };
  }

  // 17. New buttons/inputs appeared
  if (before.hash !== after.hash) {
    const newButtons = after.buttons.filter(b => !before.buttons.some(b2 => b2.text === b.text && Math.abs(b2.x - b.x) < 50 && Math.abs(b2.y - b.y) < 50));
    if (newButtons.length > 0) {
      return {
        direction: 'closer',
        reason: `${newButtons.length} new button(s) appeared: ${newButtons.slice(0, 3).map(b => `"${b.text}"`).join(', ')}`,
        newButtons: true,
      };
    }
    const newInputs = after.inputs.filter(i => !before.inputs.some(i2 => i2.placeholder === i.placeholder && Math.abs(i2.x - i.x) < 50 && Math.abs(i2.y - i.y) < 50));
    if (newInputs.length > 0) {
      return {
        direction: 'closer',
        reason: `${newInputs.length} new input(s) appeared`,
        newInputs: true,
      };
    }
    return { direction: 'closer', reason: 'DOM state changed', hashChanged: true };
  }

  // 18. Nothing changed
  return { direction: 'same', reason: 'no DOM change', hashChanged: false };
}

// Compute a structured diff between before/after DOM states.
// Returns raw new/removed elements for the LLM to interpret.
function _computeStateDiff(before, after) {
  const diff = {
    newButtons: [], newInputs: [], newPopups: [], newExpanded: [],
    newToasts: [], removedButtons: [], newOcrText: [], removedOcrText: [],
    hasChanges: false,
  };

  // New buttons (by text+position match)
  diff.newButtons = after.buttons.filter(b =>
    !before.buttons.some(b2 => b2.text === b.text && Math.abs(b2.x - b.x) < 50 && Math.abs(b2.y - b.y) < 50)
  ).map(b => ({ text: b.text, tag: b.tag, role: b.role, x: b.x, y: b.y }));

  // Removed buttons
  diff.removedButtons = before.buttons.filter(b =>
    !after.buttons.some(b2 => b2.text === b.text && Math.abs(b2.x - b.x) < 50 && Math.abs(b2.y - b.y) < 50)
  ).map(b => ({ text: b.text }));

  // New inputs
  diff.newInputs = after.inputs.filter(i =>
    !before.inputs.some(i2 => i2.placeholder === i.placeholder && Math.abs(i2.x - i.x) < 50 && Math.abs(i2.y - i.y) < 50)
  ).map(i => ({ placeholder: i.placeholder, type: i.type, x: i.x, y: i.y }));

  // New popups
  if (after.popups.length > before.popups.length) {
    diff.newPopups = after.popups.slice(before.popups.length);
  }

  // Newly expanded elements
  diff.newExpanded = after.expandedElements.filter(e =>
    !before.expandedElements.some(e2 => e2.text === e.text)
  );

  // New toasts
  diff.newToasts = after.toasts.length > before.toasts.length
    ? after.toasts.slice(before.toasts.length) : [];

  diff.hasChanges = diff.newButtons.length > 0 || diff.newInputs.length > 0 ||
    diff.newPopups.length > 0 || diff.newExpanded.length > 0 ||
    diff.newToasts.length > 0 || diff.removedButtons.length > 0;

  return diff;
}

// Format a state diff into a human-readable block for the LLM prompt.
function _buildDiffPromptBlock(diff, ocrDiff) {
  if (!diff && !ocrDiff) return 'WHAT CHANGED: nothing — your action had no visible effect.';
  const _lines = [];

  if (diff) {
    if (diff.newButtons.length > 0) {
      _lines.push(`New buttons/links appeared:`);
      for (const b of diff.newButtons.slice(0, 10)) {
        _lines.push(`  - "${b.text}" ${b.tag}${b.role ? `[role=${b.role}]` : ''} at (${b.x},${b.y})`);
      }
    }
    if (diff.newInputs.length > 0) {
      _lines.push(`New input fields appeared:`);
      for (const i of diff.newInputs.slice(0, 5)) {
        _lines.push(`  - "${i.placeholder}" type=${i.type} at (${i.x},${i.y})`);
      }
    }
    if (diff.newPopups.length > 0) {
      _lines.push(`New popups/menus/dialogs appeared:`);
      for (const p of diff.newPopups.slice(0, 3)) {
        _lines.push(`  - ${p.role || p.tagName} text="${(p.text || '').slice(0, 60)}" with ${p.items?.length || 0} items`);
      }
    }
    if (diff.newExpanded.length > 0) {
      _lines.push(`Elements expanded:`);
      for (const e of diff.newExpanded.slice(0, 5)) {
        _lines.push(`  - "${e.text}"`);
      }
    }
    if (diff.newToasts.length > 0) {
      _lines.push(`Notifications appeared:`);
      for (const t of diff.newToasts.slice(0, 3)) {
        _lines.push(`  - "${t.text.slice(0, 60)}"`);
      }
    }
    if (diff.removedButtons.length > 0) {
      _lines.push(`Elements disappeared: ${diff.removedButtons.slice(0, 5).map(b => `"${b.text}"`).join(', ')}`);
    }
  }

  if (ocrDiff && ocrDiff.changed) {
    if (ocrDiff.added.length > 0) {
      _lines.push(`New text appeared on screen: ${ocrDiff.added.slice(0, 10).map(t => `"${t}"`).join(', ')}`);
    }
    if (ocrDiff.removed.length > 0) {
      _lines.push(`Text disappeared from screen: ${ocrDiff.removed.slice(0, 5).map(t => `"${t}"`).join(', ')}`);
    }
  }

  if (_lines.length === 0) {
    return 'WHAT CHANGED: nothing — your action had no visible effect.';
  }
  return 'WHAT CHANGED AFTER YOUR LAST ACTION:\n' + _lines.join('\n');
}

// Compare before/after state to determine if an action moved us closer to the sub-task.
// Returns { direction: 'closer'|'same'|'farther', reason, ocrDiff }
function _visualCompare({ beforeOcr, afterOcr, beforeDomHash, afterDomHash, subTask, expectChange }) {
  const _ocrDiff = _diffOcrText(beforeOcr, afterOcr);
  const _domChanged = beforeDomHash && afterDomHash && beforeDomHash !== afterDomHash;

  // Extract entity terms from sub-task (reuse logic similar to _structuralVerifySubTask)
  const _desc = (subTask.description || '').toLowerCase();
  const _quoted = (subTask.description + ' ' + subTask.verification).match(/['"]([^'"]{2,50})['"]/g) || [];
  const _entityTerms = [];
  for (const q of _quoted) {
    const t = q.replace(/['"]/g, '').trim().toLowerCase();
    if (t.length > 1 && !/^(save|enter|cancel|ok|done|close|add|create|new)$/i.test(t)) _entityTerms.push(t);
  }
  const _caps = (subTask.description + ' ' + subTask.verification).match(/\b[A-Z][a-zA-Z]{2,}\b/g) || [];
  const _stop = new Set(['The', 'And', 'Then', 'Create', 'Search', 'Add', 'Click', 'Open', 'Page', 'Playlist', 'Repeat', 'Process', 'Find', 'Top', 'Songs', 'Track', 'Tracks', 'Menu', 'Button', 'Sidebar', 'URL', 'Music', 'Artist', 'Artists', 'Album', 'Song']);
  for (const c of _caps) {
    if (!_stop.has(c)) _entityTerms.push(c.toLowerCase());
  }

  // Check if entity terms newly appeared in afterOcr
  const _beforeText = (beforeOcr || []).map(i => (i.text || '').toLowerCase()).join(' ');
  const _afterText = (afterOcr || []).map(i => (i.text || '').toLowerCase()).join(' ');
  const _newEntities = _entityTerms.filter(t => !_beforeText.includes(t) && _afterText.includes(t));
  const _lostEntities = _entityTerms.filter(t => _beforeText.includes(t) && !_afterText.includes(t));

  // Check if expectChange description matches new OCR items
  const _expectLower = (expectChange || '').toLowerCase();
  let _expectMatched = false;
  if (_expectLower && _ocrDiff.added.length > 0) {
    const _addedText = _ocrDiff.added.join(' ').toLowerCase();
    // Match key words from expectChange against added OCR text.
    // Use an array-based stop word set (NOT regex .includes — RegExp has no .includes method).
    const _stopWords = new Set([
      'the', 'should', 'would', 'after', 'this', 'action', 'visible',
      'screen', 'page', 'dialog', 'menu', 'button', 'field', 'input', 'element',
    ]);
    const _expectWords = _expectLower.split(/\s+/).filter(w => w.length > 3 && !_stopWords.has(w));
    if (_expectWords.some(w => _addedText.includes(w))) _expectMatched = true;
  }

  // Decision logic
  if (_newEntities.length > 0) {
    return { direction: 'closer', reason: `new entity terms appeared: ${_newEntities.join(', ')}`, ocrDiff: _ocrDiff };
  }
  if (_expectMatched) {
    return { direction: 'closer', reason: `expected change matched: "${expectChange.slice(0, 80)}"`, ocrDiff: _ocrDiff };
  }
  if (_ocrDiff.changed && _domChanged) {
    return { direction: 'closer', reason: `state changed (${_ocrDiff.added.length} added, ${_ocrDiff.removed.length} removed)`, ocrDiff: _ocrDiff };
  }
  if (_lostEntities.length > 0 && _newEntities.length === 0) {
    return { direction: 'farther', reason: `entity terms disappeared: ${_lostEntities.join(', ')}`, ocrDiff: _ocrDiff };
  }
  if (!_domChanged && !_ocrDiff.changed) {
    return { direction: 'same', reason: 'no observable change (DOM + OCR unchanged)', ocrDiff: _ocrDiff };
  }
  return { direction: 'same', reason: `state changed but no entity/expectChange match (${_ocrDiff.added.length} added, ${_ocrDiff.removed.length} removed)`, ocrDiff: _ocrDiff };
}

// Draw a magenta click-aim dot + label DIRECTLY on the Playwright page (not the
// Electron GhostLayer, which is in a different coordinate space). This ensures
// the highlight appears at the exact CSS pixel coordinates where the click will
// happen. The dot auto-removes after 2 seconds. Non-fatal.
async function _highlightClickInPage(page, x, y, label) {
  if (!page) return;
  try {
    await page.evaluate(({ x, y, label }) => {
      const _id = 'td-click-aim-' + Date.now();
      const dot = document.createElement('div');
      dot.id = _id;
      dot.style.cssText = [
        'position:fixed',
        `left:${Math.round(x - 14)}px`,
        `top:${Math.round(y - 14)}px`,
        'width:28px',
        'height:28px',
        'border:3px solid #ff00ff',
        'border-radius:50%',
        'background:rgba(255,0,255,0.15)',
        'z-index:2147483647',
        'pointer-events:none',
        'box-shadow:0 0 12px #ff00ff,0 0 4px #ff00ff',
      ].join(';');
      // Crosshair lines
      const hLine = document.createElement('div');
      hLine.style.cssText = `position:fixed;left:${Math.round(x - 20)}px;top:${Math.round(y)}px;width:40px;height:1px;background:#ff00ff;z-index:2147483647;pointer-events:none;`;
      const vLine = document.createElement('div');
      vLine.style.cssText = `position:fixed;left:${Math.round(x)}px;top:${Math.round(y - 20)}px;width:1px;height:40px;background:#ff00ff;z-index:2147483647;pointer-events:none;`;
      // Label
      const lbl = document.createElement('div');
      lbl.style.cssText = [
        'position:fixed',
        `left:${Math.round(x + 18)}px`,
        `top:${Math.round(y - 14)}px`,
        'background:#ff00ff',
        'color:#000',
        'padding:2px 8px',
        'font-size:12px',
        'font-family:monospace',
        'font-weight:bold',
        'z-index:2147483647',
        'pointer-events:none',
        'border-radius:3px',
        'white-space:nowrap',
        'max-width:300px',
        'overflow:hidden',
        'text-overflow:ellipsis',
      ].join(';');
      lbl.textContent = label ? `click: ${label.slice(0, 40)}` : 'click';
      document.body.appendChild(dot);
      document.body.appendChild(hLine);
      document.body.appendChild(vLine);
      document.body.appendChild(lbl);
      setTimeout(() => {
        dot.remove(); hLine.remove(); vLine.remove(); lbl.remove();
      }, 2000);
    }, { x: Math.round(x), y: Math.round(y), label: label || '' });
  } catch (_) { /* non-fatal — page may have navigated */ }
}

// DOM-based click: find a visible interactive element (button, link, menuitem,
// option, tab, [role="button"], etc.) whose text or aria-label matches the
// target, and return its center coordinates in CSS pixels. This is more reliable
// than OCR text boxes because it hits the actual clickable element.
// If containerSelector is provided (as { role, className } object), search ONLY within that element (no page-wide fallback).
// Returns { ok: true, x, y, text, tag } or { ok: false }.
async function _clickByTextDom(page, target, containerSelector = null, options = {}) {
  if (!page || !target) return { ok: false };
  const _mode = (options?.mode || 'click');
  try {
    const _result = await page.evaluate(({ targetText, containerSel, mode }) => {
      const _target = (targetText || '').toLowerCase().trim();
      if (!_target) return null;

      // Build container selector string from { role, className } object
      let _containerEl = null;
      if (containerSel && containerSel.role) {
        let _sel = `[role="${containerSel.role}"]`;
        if (containerSel.className) {
          _sel += '.' + CSS.escape(containerSel.className);
        }
        _containerEl = document.querySelector(_sel);
      }

      // Find the top popup by z-index for overlay blocking
      let _topPopupZ = -1;
      let _topPopupRect = null;
      const _popupSel = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';
      for (const _pel of document.querySelectorAll(_popupSel)) {
        const _s = window.getComputedStyle(_pel);
        if (_s.display === 'none' || _s.visibility === 'hidden' || parseFloat(_s.opacity) === 0) continue;
        const _r = _pel.getBoundingClientRect();
        if (_r.width < 10 || _r.height < 10) continue;
        const _z = parseInt(_s.zIndex) || 0;
        if (_z > _topPopupZ) {
          _topPopupZ = _z;
          _topPopupRect = { x: _r.x + _r.width / 2, y: _r.y + _r.height / 2 };
        }
      }

      function _isInsidePopup(el) {
        let _cur = el;
        while (_cur) {
          if (_cur.getAttribute && (_cur.getAttribute('role') === 'dialog' || _cur.getAttribute('role') === 'alertdialog' || _cur.getAttribute('aria-modal') === 'true' || _cur.getAttribute('role') === 'menu' || _cur.getAttribute('role') === 'listbox')) {
            return true;
          }
          _cur = _cur.parentElement;
        }
        return false;
      }

      function _scoreElement(el) {
        const _text = (el.innerText || el.textContent || '').trim().toLowerCase();
        const _aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const _elType = (el.type || '').toLowerCase();
        const _useValue = el.tagName === 'INPUT' && ['submit', 'button', 'reset', 'image'].includes(_elType);
        const _val = _useValue ? (el.value || '').trim().toLowerCase() : '';
        const _ph = (el.placeholder || '').trim().toLowerCase();
        const _label = _text + ' ' + _aria + ' ' + _val + ' ' + _ph;
        if (!_label.trim()) return null;
        let _score = Infinity;
        if (_text === _target || _aria === _target || _val === _target || _ph === _target) _score = 0;
        else if (_text.includes(_target) || _aria.includes(_target) || _val.includes(_target) || _ph.includes(_target)) _score = 1;
        else if (_text.startsWith(_target) || _aria.startsWith(_target) || _ph.startsWith(_target)) _score = 2;
        else {
          const _targetWords = _target.split(/\s+/).filter(w => w.length > 2);
          if (_targetWords.length > 0 && _targetWords.every(w => _label.includes(w))) {
            _score = 3 + Math.abs(_text.length - _target.length) / 10;
          }
        }
        if (_score === Infinity) return null;
        const r = el.getBoundingClientRect();
        return {
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          text: (el.innerText || el.textContent || el.getAttribute('aria-label') || el.placeholder || el.value || '').trim().slice(0, 40),
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          _score,
          _rect: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        };
      }

      function _findInRoot(root) {
        const _clickSelectors = [
          'button', 'a', '[role="button"]', '[role="link"]',
          '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
          '[role="tab"]', '[role="option"]', '[role="treeitem"]',
          'input[type="submit"]', 'input[type="button"]',
        ];
        const _fieldSelectors = _clickSelectors.concat([
          'input[type="text"]', 'input[type="search"]', 'input:not([type])',
          'textarea', '[contenteditable="true"]', '[role="textbox"]', '[role="searchbox"]',
        ]);
        const _sel = (mode === 'field' ? _fieldSelectors : _clickSelectors).join(', ');
        const _els = Array.from(root.querySelectorAll(_sel));
        let _candidates = [];
        for (const el of _els) {
          const r = el.getBoundingClientRect();
          if (r.width < 5 || r.height < 5) continue;
          const s = window.getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
          // Skip noise dialogs
          let _inNoise = false;
          let _cur = el;
          while (_cur) {
            if (_cur.getAttribute && _cur.getAttribute('role') === 'dialog') {
              const _dt = (_cur.innerText || '').toLowerCase();
              if (/cookie|consent|privacy|language|gdpr/.test(_dt)) { _inNoise = true; break; }
            }
            _cur = _cur.parentElement;
          }
          if (_inNoise) continue;
          // Z-index overlay blocking: if a popup is on top and this element is not inside it, skip
          if (_topPopupZ > 0 && !_isInsidePopup(el)) {
            const _elZ = parseInt(s.zIndex) || 0;
            if (_elZ < _topPopupZ) continue;
          }
          const _scored = _scoreElement(el);
          if (_scored) _candidates.push(_scored);
        }
        if (_candidates.length === 0) return null;
        // Sort by score, then by proximity to popup center
        _candidates.sort((a, b) => {
          if (a._score !== b._score) return a._score - b._score;
          // Tie-break: prefer element closer to top popup center
          if (_topPopupRect) {
            const _da = Math.hypot(a._rect.x - _topPopupRect.x, a._rect.y - _topPopupRect.y);
            const _db = Math.hypot(b._rect.x - _topPopupRect.x, b._rect.y - _topPopupRect.y);
            return _da - _db;
          }
          return 0;
        });
        return _candidates[0];
      }

      // When container is provided, search ONLY inside it — no page-wide fallback
      if (containerSel && containerSel.role && !_containerEl) return null;
      return _findInRoot(_containerEl || document);
    }, { targetText: target, containerSel: containerSelector, mode: _mode });
    if (_result) {
      delete _result._score;
      delete _result._rect;
      return { ok: true, ..._result };
    }
  } catch (_) { /* page may have navigated */ }
  return { ok: false };
}

// Main Tier 1.8 entry point — DOM-primary visual discovery loop
async function _executeVisualDiscoveryLoop({ goal, verificationGoal, sessionId, headed, timeoutMs, agentContext, deadline, start, heartbeat, hostname, _preDecomposedSubTasks = null, _progressCallbackUrl, _stepIndex }) {
  const _vdStart = Date.now();
  logger.info(`[playwright.agent] Tier 1.8 (Visual Discovery): starting for goal="${goal.slice(0, 80)}"`);

  try {
    const page = engine.getPage(sessionId);
    if (!page) return { ok: false, error: 'no page' };

    // Use pre-decomposed sub-tasks (from playwrightAgent's early decomposition)
    let _subTasks = _preDecomposedSubTasks;
    if (!_subTasks) {
      const _decomp = await _decomposeGoalIntoSubTasks(goal, sessionId);
      if (_decomp.ok && _decomp.subTasks) _subTasks = _decomp.subTasks;
    }
    if (!_subTasks || _subTasks.length === 0) {
      logger.warn(`[playwright.agent] Tier 1.8: no sub-tasks — falling through`);
      return { ok: false, error: 'no sub-tasks available' };
    }
    logger.info(`[playwright.agent] Tier 1.8: ${_subTasks.length} sub-tasks`);

    // Auto-complete navigate-type sub-tasks — URL-first handles navigation, not Tier 1.8
    const _navigateRe = /^(navigate|go to|open|visit|log in|login|sign in|reach)/i;
    for (const _st of _subTasks) {
      if (!_st.completed && _navigateRe.test(_st.description)) {
        _st.completed = true;
        logger.info(`[playwright.agent] Tier 1.8: auto-completed navigate sub-task #${_st.id} "${_st.description.slice(0, 60)}" (URL-first handles navigation)`);
      }
    }

    const _vdTranscript = [];
    const MAX_ACTIONS_PER_SUBTASK = 8;
    const MAX_NO_OP_BEFORE_BACKTRACK = 2;
    let _prevOcrItems = null;

    // Emit tier progress
    postProgress(_progressCallbackUrl, {
      type: 'agent:tier',
      stepIndex: _stepIndex,
      tier: 'visual-discovery',
      message: `Visual Discovery loop: ${_subTasks.length} sub-tasks`,
    });

    for (let _stIdx = 0; _stIdx < _subTasks.length; _stIdx++) {
      const _st = _subTasks[_stIdx];
      if (_st.completed) continue;
      if (Date.now() > deadline) {
        logger.warn(`[playwright.agent] Tier 1.8: deadline exceeded at sub-task #${_st.id}`);
        return { ok: false, error: 'deadline exceeded', transcript: _vdTranscript, subTasks: _subTasks };
      }

      logger.info(`[playwright.agent] Tier 1.8: sub-task #${_st.id}/${_subTasks.length} — "${_st.description.slice(0, 80)}"`);

      postProgress(_progressCallbackUrl, {
        type: 'agent:tier',
        stepIndex: _stepIndex,
        tier: 'visual-discovery',
        message: `Sub-task ${_st.id}/${_subTasks.length}: ${_st.description.slice(0, 80)}`,
      });

      // 1. Capture beforeState: DOM state (primary) + OCR (supplement/fallback)
      let _beforeState = await _captureDomState(page);
      let _currentUrl = _beforeState.url || '';
      let _beforeOcr = null;
      if (_prevOcrItems && (Date.now() - (_prevOcrItems._ts || 0)) < 3000 && _prevOcrItems._url === _currentUrl) {
        _beforeOcr = _prevOcrItems;
        logger.info(`[playwright.agent] Tier 1.8: reusing cached OCR from previous sub-task (${_beforeOcr.length} items)`);
      } else {
        const _cap = await _liteparseCapture(page);
        if (!_cap.ok) {
          logger.warn(`[playwright.agent] Tier 1.8: LiteParser capture failed — falling through`);
          return { ok: false, error: 'LiteParser capture failed', transcript: _vdTranscript, subTasks: _subTasks };
        }
        _beforeOcr = _cap.textItems || [];
        _beforeOcr._ts = Date.now();
        _beforeOcr._imgW = _cap.imageWidth;
        _beforeOcr._imgH = _cap.imageHeight;
        _beforeOcr._url = _currentUrl;
      }

      // Probe revealable menus
      let _revealableMenus = await _probeRevealableMenus(page);
      logger.info(`[playwright.agent] Tier 1.8: ${_revealableMenus.length} revealable menu candidates, ${_beforeState.popups.length} popups, ${_beforeState.buttons.length} buttons`);

      const _imgW0 = _beforeOcr._imgW || 1280;
      const _imgH0 = _beforeOcr._imgH || 800;
      const _noiseRects = await _getNoiseDialogRects(page, _imgW0, _imgH0);

      let _actionCount = 0;
      let _noOpCount = 0;
      let _probedMenuIdx = 0;
      const _recentClicks = [];
      const _recentActions = [];
      let _lastDiff = null;
      let _lastOcrDiff = null;

      // 2. Action loop for this sub-task
      while (_actionCount < MAX_ACTIONS_PER_SUBTASK) {
        if (Date.now() > deadline) break;

        // Re-fetch page in case it closed mid-action
        const page = engine.getPage(sessionId);
        if (!page || page.isClosed()) {
          logger.warn(`[playwright.agent] Tier 1.8: page closed mid-action — breaking`);
          break;
        }

        // Loop detection: if the last 2 clicks were at the same coordinates AND no popup is open,
        // force a backtrack (pressEscape + try a different approach)
        if (_recentClicks.length >= 2 && _beforeState.popups.length === 0) {
          const _last = _recentClicks[_recentClicks.length - 1];
          const _prev = _recentClicks[_recentClicks.length - 2];
          if (_last.x === _prev.x && _last.y === _prev.y) {
            // Check if new elements appeared despite same coord click — if so, don't Escape
            const _hasNew = _lastDiff && (_lastDiff.newButtons.length > 0 || _lastDiff.newInputs.length > 0 || _lastDiff.newPopups.length > 0);
            const _hasNewOcr = _lastOcrDiff && _lastOcrDiff.added && _lastOcrDiff.added.length > 0;
            if (_hasNew || _hasNewOcr) {
              logger.info(`[playwright.agent] Tier 1.8: same coord clicked twice but new elements appeared — skipping Escape`);
              _recentClicks.length = 0;
              _noOpCount = 0;
              continue;
            }
            logger.warn(`[playwright.agent] Tier 1.8: loop detected — same coord (${_last.x},${_last.y}) clicked twice — forcing backtrack`);
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(400);
            _beforeState = await _captureDomState(page);
            const _reCap = await _liteparseCapture(page);
            if (_reCap.ok) {
              _beforeOcr = _reCap.textItems || [];
              _beforeOcr._ts = Date.now();
              _beforeOcr._imgW = _reCap.imageWidth;
              _beforeOcr._imgH = _reCap.imageHeight;
              _beforeOcr._url = _beforeState.url || '';
            }
            _revealableMenus = await _probeRevealableMenus(page);
            _recentClicks.length = 0;
            _noOpCount = 0;
            _probedMenuIdx++;
            _lastDiff = null;
            _lastOcrDiff = null;
            continue;
          }
        }

        // Loading state detection: if page is loading, wait and re-capture
        if (_beforeState.isLoading) {
          logger.info(`[playwright.agent] Tier 1.8: page is loading — waiting 1s and re-capturing`);
          await page.waitForTimeout(1000);
          _beforeState = await _captureDomState(page);
          if (!_beforeState.isLoading) {
            logger.info(`[playwright.agent] Tier 1.8: loading completed — continuing`);
            continue;
          }
          // Still loading after 1s — wait more
          await page.waitForTimeout(1000);
          _beforeState = await _captureDomState(page);
          if (_beforeState.isLoading) {
            logger.warn(`[playwright.agent] Tier 1.8: still loading after 2s — proceeding anyway`);
          }
          continue;
        }

        // Build DOM state prompt block
        const _domBlock = _buildDomStatePromptBlock(_beforeState);

        // Build filtered OCR for prompt (supplement)
        const _ocrFiltered = _filterOcrForPrompt(_beforeOcr, {
          imageWidth: _beforeOcr._imgW || 1280,
          imageHeight: _beforeOcr._imgH || 800,
          noiseDialogRects: _noiseRects,
        });
        const _ocrForPrompt = _ocrFiltered.formatted;

        // Build revealable menus list for prompt
        const _menusForPrompt = _revealableMenus.slice(0, 12).map((m, i) => {
          const _ctx = [];
          if (m.inNav) _ctx.push('nav');
          if (m.inToolbar) _ctx.push('toolbar');
          if (m.inMenu) _ctx.push('menu');
          const _ctxStr = _ctx.length > 0 ? ` in-${_ctx.join('+')}` : '';
          const _roleStr = m.role ? `[role=${m.role}]` : '';
          return `  [${i}] "${m.text}" ${m.tag}${_roleStr}[${m.hint}]${_ctxStr} at (${m.rect.x},${m.rect.y}) ${m.rect.w}x${m.rect.h}`;
        }).join('\n');

        // Build sub-task progress block
        const _progressBlock = _buildSubTaskProgressBlock(_subTasks);

        // Build diff block from last action
        const _diffBlock = _buildDiffPromptBlock(_lastDiff, _lastOcrDiff);

        // Build recent actions block
        let _recentActionsBlock = '';
        if (_recentActions.length > 0) {
          _recentActionsBlock = 'RECENT ACTIONS (avoid repeating the same action):\n' +
            _recentActions.map((a, i) => `  ${i + 1}. ${a.action}${a.text ? ` "${a.text}"` : ''} → ${a.ok ? 'ok' : 'failed'}${a.result ? ` (${a.result.slice(0, 80)})` : ''}`).join('\n') + '\n';
        }

        const _turnUser = `SUB-TASK #${_st.id}: ${_st.description}
VERIFICATION: ${_st.verification}
EXPECTED STATE AFTER: ${_st.expectedState || '(not specified)'}

SUB-TASK PROGRESS:
${_progressBlock}

${_recentActionsBlock}
${_actionCount > 0 ? _diffBlock + '\n' : ''}
CURRENT PAGE STATE:
URL: ${_beforeState.url || '(unknown)'}
Title: ${_beforeState.title || '(none)'}
Scroll: ${_beforeState.scrollY}px${_beforeState.canScrollDown ? ' (can scroll down)' : ''}${_beforeState.canScrollUp ? ' (can scroll up)' : ''}

${_domBlock}

OCR TEXT ITEMS (supplement — what's visually visible):
${_ocrForPrompt.slice(0, 2000)}

REVEALABLE TRIGGERS (click to open hidden UI):
${_menusForPrompt || '(none detected)'}

${_noOpCount > 0 ? `\n⚠️ LAST ${_noOpCount} ACTION(S) HAD NO EFFECT. Try a COMPLETELY different approach — probe a hidden menu, scroll, or reconsider.\n` : ''}
${agentContext ? `\nSITE-SPECIFIC RULES:\n${agentContext}\n` : ''}
${_actionCount === 0 ? 'What is your first action to complete this sub-task?' : `Action ${_actionCount + 1}/${MAX_ACTIONS_PER_SUBTASK}. What is your next action?`}

Output ONLY the JSON action:`;

        let _actionRaw;
        try {
          _actionRaw = await askWithMessages([
            { role: 'system', content: VISUAL_DISCOVERY_SYSTEM_PROMPT },
            { role: 'user', content: _turnUser },
          ], { temperature: 0.1, maxTokens: 400, responseTimeoutMs: 20000 });
        } catch (_llmErr) {
          logger.warn(`[playwright.agent] Tier 1.8: LLM call failed: ${_llmErr.message}`);
          if (_llmErr.message.includes('Circuit breaker')) break;
          _actionCount++;
          continue;
        }

        if (!_actionRaw || _actionRaw.length === 0) {
          logger.warn(`[playwright.agent] Tier 1.8: LLM returned empty response`);
          _actionCount++;
          continue;
        }

        const _action = parseJson(_actionRaw);
        if (!_action || !_action.action) {
          logger.warn(`[playwright.agent] Tier 1.8: unparseable action: ${(_actionRaw || '').slice(0, 100)}`);
          _actionCount++;
          continue;
        }

        // Return = sub-task done
        if (_action.action === 'return') {
          let _retUrl = '';
          try { _retUrl = page.url(); } catch (_) {}
          const _retText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
          const _sv = await _structuralVerifySubTask(_st, { page, pageUrl: _retUrl, pageText: _retText, transcript: _vdTranscript, sessionId });
          if (_sv.verified) {
            _st.completed = true;
            logger.info(`[playwright.agent] Tier 1.8: sub-task #${_st.id} completed (return + structural verification: ${_sv.gate}: ${_sv.reason})`);
            _vdTranscript.push({ action: _action, outcome: { ok: true }, subTask: _st.id });
            break;
          } else {
            const _basic = await _checkSubTaskCompletion(_st, page, _retUrl, _retText);
            if (_basic) {
              _st.completed = true;
              logger.info(`[playwright.agent] Tier 1.8: sub-task #${_st.id} completed (return + basic verification passed)`);
              _vdTranscript.push({ action: _action, outcome: { ok: true }, subTask: _st.id });
              break;
            }
            logger.warn(`[playwright.agent] Tier 1.8: sub-task #${_st.id} return rejected — verification not met (${_sv.gate}: ${_sv.reason})`);
            _actionCount++;
            continue;
          }
        }

        // 3. Determine popup container for scoped clicks
        const _popupContainer = _beforeState.popups.length > 0 ? _beforeState.popups[0] : null;
        const _containerSelector = _popupContainer
          ? { role: _popupContainer.role, className: _popupContainer.className ? _popupContainer.className.split(' ')[0] : '' }
          : null;

        // 4. Execute the action
        let _outcome;
        const _imgW = _beforeOcr._imgW || 1280;
        const _imgH = _beforeOcr._imgH || 800;
        const _vpW = page.viewportSize()?.width || 1280;
        const _vpH = page.viewportSize()?.height || 800;
        const _scaleX = _vpW / _imgW;
        const _scaleY = _vpH / _imgH;

        try {
          if (_action.action === 'pressEscape') {
            await page.keyboard.press('Escape');
            _outcome = { ok: true, result: 'Escape pressed' };
            logger.info(`[playwright.agent] Tier 1.8: pressed Escape`);
          } else if (_action.action === 'press') {
            await page.keyboard.press(_action.key || 'Enter');
            _outcome = { ok: true, result: `Pressed ${_action.key || 'Enter'}` };
            logger.info(`[playwright.agent] Tier 1.8: pressed ${_action.key || 'Enter'}`);
          } else if (_action.action === 'scroll') {
            const _dir = _action.direction || 'down';
            const _amount = _action.amount || 300;
            const _dy = _dir === 'up' ? -_amount : _amount;
            await page.mouse.wheel(0, _dy);
            await page.waitForTimeout(400);
            _outcome = { ok: true, result: `Scrolled ${_dir} ${_amount}px` };
            logger.info(`[playwright.agent] Tier 1.8: scrolled ${_dir} ${_amount}px`);
          } else if (_action.action === 'hover') {
            const _hoverTarget = _action.text || '';
            const _domHover = await _clickByTextDom(page, _hoverTarget, _containerSelector);
            if (_domHover.ok) {
              await page.mouse.move(_domHover.x, _domHover.y);
              await page.waitForTimeout(500);
              _outcome = { ok: true, result: `Hovered "${_domHover.text}" at (${_domHover.x}, ${_domHover.y})` };
              logger.info(`[playwright.agent] Tier 1.8: hovered "${_domHover.text}" at (${_domHover.x}, ${_domHover.y})`);
            } else {
              _outcome = { ok: false, error: `No DOM match for hover target "${_hoverTarget}"` };
            }
          } else if (_action.action === 'clickByText') {
            const _target = _action.text || '';
            // ── Strategy 0: Keyboard nav (ArrowDown + Enter) — deterministic for menus ──
            const _kbHelpers = _getKbHelpers();
            if (_kbHelpers._selectOverlayItemByKeyboard) {
              const _kbResult = await _kbHelpers._selectOverlayItemByKeyboard(sessionId, _target, null, null);
              if (_kbResult?.ok) {
                logger.info(`[playwright.agent] Tier 1.8: keyboard nav succeeded for "${_target}" — selected "${_kbResult.selectedText}"`);
                _outcome = { ok: true, result: `Keyboard nav: selected "${_kbResult.selectedText}"` };
                _actionCount++;
                postProgress(_progressCallbackUrl, {
                  type: 'agent:turn', stepIndex: _stepIndex, turn: _actionCount,
                  maxTurns: MAX_ACTIONS_PER_SUBTASK, action: _action, outcome: _outcome, thoughts: '',
                });
                continue;
              }
            } else {
              logger.info(`[playwright.agent] Tier 1.8: keyboard nav not available — using clickByText`);
            }
            // ── Strategy 1: DOM-based click (PRIMARY — scoped to popup if open) ──
            const _domClick = await _clickByTextDom(page, _target, _containerSelector);
            if (_domClick.ok) {
              const _clickX = _domClick.x;
              const _clickY = _domClick.y;
              logger.info(`[playwright.agent] Tier 1.8: clicking "${_domClick.text}" at (${_clickX}, ${_clickY}) via DOM match (${_domClick.tag}${_domClick.role ? `[role=${_domClick.role}]` : ''}) for "${_target}"${_containerSelector ? ' (in popup)' : ''}`);
              await _highlightClickInPage(page, _clickX, _clickY, _domClick.text);
              await page.waitForTimeout(400);
              await page.mouse.click(_clickX, _clickY);
              _outcome = { ok: true, result: `Clicked "${_domClick.text}" at (${_clickX}, ${_clickY}) via DOM` };
              _recentClicks.push({ x: _clickX, y: _clickY }); if (_recentClicks.length > 3) _recentClicks.shift();
            } else {
              // ── Strategy 2: OCR-based click with STRICT type filtering (fallback) ──
              const _candidates = (_ocrFiltered.filtered.length > 0 ? _ocrFiltered.filtered : _beforeOcr)
                .filter(item => item._type === 'button' || item._type === 'link' || item._type === 'input');
              let _bestItem = null;
              let _bestScore = Infinity;
              for (const item of _candidates) {
                const _m = _fuzzyMatchText(_target, item.text, 2);
                if (_m.match) {
                  const _lenPenalty = item.text.length < _target.length ? (_target.length - item.text.length) * 2 : 0;
                  const _score = _m.distance + _lenPenalty + (_m.exact ? -2 : 0);
                  if (_score < _bestScore) { _bestScore = _score; _bestItem = item; }
                }
              }
              if (_bestItem) {
                const _clickX = Math.round((_bestItem.x + (_bestItem.width || 0) / 2) * _scaleX);
                const _clickY = Math.round((_bestItem.y + (_bestItem.height || 0) / 2) * _scaleY);
                logger.info(`[playwright.agent] Tier 1.8: clicking "${_bestItem.text}" at (${_clickX}, ${_clickY}) — OCR match for "${_target}" (score=${_bestScore}, type=${_bestItem._type})`);
                await _highlightClickInPage(page, _clickX, _clickY, _bestItem.text);
                await page.waitForTimeout(400);
                await page.mouse.click(_clickX, _clickY);
                _outcome = { ok: true, result: `Clicked "${_bestItem.text}" at (${_clickX}, ${_clickY}) via OCR` };
                _recentClicks.push({ x: _clickX, y: _clickY }); if (_recentClicks.length > 3) _recentClicks.shift();
              } else {
                // ── Strategy 3: Revealable menus DOM rect (last resort) ──
                const _menuMatch = _revealableMenus.find(m => _fuzzyMatchText(_target, m.text, 2).match || _fuzzyMatchText(_target, m.ariaLabel || '', 2).match);
                if (_menuMatch) {
                  const _clickX = Math.round((_menuMatch.rect.x + _menuMatch.rect.w / 2) * _scaleX);
                  const _clickY = Math.round((_menuMatch.rect.y + _menuMatch.rect.h / 2) * _scaleY);
                  logger.info(`[playwright.agent] Tier 1.8: clicking menu "${_menuMatch.text}" at (${_clickX}, ${_clickY}) via DOM rect`);
                  await _highlightClickInPage(page, _clickX, _clickY, _menuMatch.text);
                  await page.waitForTimeout(400);
                  await page.mouse.click(_clickX, _clickY);
                  _outcome = { ok: true, result: `Clicked menu "${_menuMatch.text}" at (${_clickX}, ${_clickY})` };
                  _recentClicks.push({ x: _clickX, y: _clickY }); if (_recentClicks.length > 3) _recentClicks.shift();
                } else {
                  _outcome = { ok: false, error: `No DOM/OCR/menu match for "${_target}"` };
                  logger.warn(`[playwright.agent] Tier 1.8: no match for "${_target}"`);
                }
              }
            }
          } else if (_action.action === 'type') {
            const _fieldTarget = _action.fieldText || '';
            // ── Strategy 1: DOM-based field finding (PRIMARY — scoped to popup if open) ──
            const _domField = await _clickByTextDom(page, _fieldTarget, _containerSelector, { mode: 'field' });
            if (_domField.ok) {
              const _clickX = _domField.x;
              const _clickY = _domField.y;
              logger.info(`[playwright.agent] Tier 1.8: clicking field "${_domField.text}" at (${_clickX}, ${_clickY}) via DOM then typing "${_action.text}"${_containerSelector ? ' (in popup)' : ''}`);
              await _highlightClickInPage(page, _clickX, _clickY, _domField.text);
              await page.waitForTimeout(400);
              await page.mouse.click(_clickX, _clickY);
              await page.waitForTimeout(200);
              await page.mouse.click(_clickX, _clickY, { clickCount: 3 });
              await page.waitForTimeout(100);
              await page.keyboard.press('Meta+A');
              await page.keyboard.press('Delete');
              await page.keyboard.type(_action.text || '', { delay: 50 });
              _outcome = { ok: true, result: `Typed "${_action.text}" into "${_domField.text}" via DOM` };
            } else {
              // ── Strategy 2: OCR-based with strict input filtering ──
              const _candidates = (_ocrFiltered.filtered.length > 0 ? _ocrFiltered.filtered : _beforeOcr)
                .filter(item => item._type === 'input');
              let _fieldItem = null;
              let _fieldScore = Infinity;
              for (const item of _candidates) {
                const _m = _fuzzyMatchText(_fieldTarget, item.text, 2);
                if (_m.match) {
                  const _score = _m.distance + (_m.exact ? -2 : 0);
                  if (_score < _fieldScore) { _fieldScore = _score; _fieldItem = item; }
                }
              }
              if (_fieldItem) {
                const _clickX = Math.round((_fieldItem.x + (_fieldItem.width || 0) / 2) * _scaleX);
                const _clickY = Math.round((_fieldItem.y + (_fieldItem.height || 0) / 2) * _scaleY);
                logger.info(`[playwright.agent] Tier 1.8: clicking field "${_fieldItem.text}" at (${_clickX}, ${_clickY}) via OCR then typing "${_action.text}"`);
                await _highlightClickInPage(page, _clickX, _clickY, _fieldItem.text);
                await page.waitForTimeout(400);
                await page.mouse.click(_clickX, _clickY);
                await page.waitForTimeout(200);
                await page.mouse.click(_clickX, _clickY, { clickCount: 3 });
                await page.waitForTimeout(100);
                await page.keyboard.press('Meta+A');
                await page.keyboard.press('Delete');
                await page.keyboard.type(_action.text || '', { delay: 50 });
                _outcome = { ok: true, result: `Typed "${_action.text}" into "${_fieldItem.text}" via OCR` };
              } else {
                // ── Strategy 3: Revealable menus for input fields ──
                const _fieldMenuMatch = _revealableMenus.find(m => _fuzzyMatchText(_fieldTarget, m.text, 2).match || _fuzzyMatchText(_fieldTarget, m.ariaLabel || '', 2).match);
                if (_fieldMenuMatch) {
                  const _clickX = Math.round((_fieldMenuMatch.rect.x + _fieldMenuMatch.rect.w / 2) * _scaleX);
                  const _clickY = Math.round((_fieldMenuMatch.rect.y + _fieldMenuMatch.rect.h / 2) * _scaleY);
                  logger.info(`[playwright.agent] Tier 1.8: clicking field menu "${_fieldMenuMatch.text}" at (${_clickX}, ${_clickY}) then typing "${_action.text}"`);
                  await _highlightClickInPage(page, _clickX, _clickY, _fieldMenuMatch.text);
                  await page.waitForTimeout(400);
                  await page.mouse.click(_clickX, _clickY);
                  await page.waitForTimeout(200);
                  await page.keyboard.type(_action.text || '', { delay: 50 });
                  _outcome = { ok: true, result: `Typed "${_action.text}" into "${_fieldMenuMatch.text}"` };
                } else {
                  _outcome = { ok: false, error: `No DOM/OCR/menu match for field "${_fieldTarget}"` };
                  logger.warn(`[playwright.agent] Tier 1.8: no match for field "${_fieldTarget}"`);
                }
              }
            }
          } else {
            _outcome = { ok: false, error: `Unknown action: ${_action.action}` };
          }
        } catch (_execErr) {
          _outcome = { ok: false, error: _execErr.message };
        }
        _vdTranscript.push({ action: _action, outcome: _outcome, subTask: _st.id });
        _actionCount++;

        // Track recent actions for prompt awareness
        _recentActions.push({
          action: _action.action,
          text: _action.text || _action.fieldText || '',
          ok: _outcome.ok,
          result: _outcome.ok ? (_outcome.result || '') : (_outcome.error || ''),
        });
        if (_recentActions.length > 3) _recentActions.shift();

        postProgress(_progressCallbackUrl, {
          type: 'agent:turn',
          stepIndex: _stepIndex,
          turn: _actionCount,
          maxTurns: MAX_ACTIONS_PER_SUBTASK,
          action: _action,
          outcome: _outcome,
          thoughts: _action.reasoning || '',
        });

        if (!_outcome.ok) {
          logger.warn(`[playwright.agent] Tier 1.8: action failed: ${_outcome.error}`);
          continue;
        }

        // 5. Wait for page to settle after click/type/scroll
        await page.waitForTimeout(800);

        // 6. Capture afterState via DOM state (primary)
        const _afterState = await _captureDomState(page);

        // 7. Compare DOM states (deterministic)
        let _compare = _compareDomState(_beforeState, _afterState, _action.expectChange);
        logger.info(`[playwright.agent] Tier 1.8: DOM compare → ${_compare.direction} — ${_compare.reason}`);

        // 7a. Compute state diff for next prompt (regardless of compare direction)
        _lastDiff = _computeStateDiff(_beforeState, _afterState);

        // 7b. If DOM comparison is inconclusive (same), fall back to OCR comparison
        if (_compare.direction === 'same') {
          const _afterCap = await _liteparseCapture(page);
          let _afterOcr = _beforeOcr;
          if (_afterCap.ok) {
            _afterOcr = _afterCap.textItems || [];
            _afterOcr._ts = Date.now();
            _afterOcr._imgW = _afterCap.imageWidth;
            _afterOcr._imgH = _afterCap.imageHeight;
            _afterOcr._url = _afterState.url || '';
          }
          const _ocrCompare = _visualCompare({
            beforeOcr: _beforeOcr,
            afterOcr: _afterOcr,
            beforeDomHash: _beforeState.hash,
            afterDomHash: _afterState.hash,
            subTask: _st,
            expectChange: _action.expectChange,
          });
          if (_ocrCompare.direction !== 'same') {
            _compare = _ocrCompare;
            logger.info(`[playwright.agent] Tier 1.8: OCR fallback compare → ${_compare.direction} — ${_compare.reason}`);
          }
          // Compute OCR diff for prompt
          _lastOcrDiff = _diffOcrText(_beforeOcr, _afterOcr);
          // Update OCR cache
          _beforeOcr = _afterOcr;
          _prevOcrItems = _afterOcr;
        } else {
          _lastOcrDiff = null;
        }

        if (_compare.direction === 'same') {
          _noOpCount++;
          if (_noOpCount >= MAX_NO_OP_BEFORE_BACKTRACK) {
            logger.warn(`[playwright.agent] Tier 1.8: ${_noOpCount} no-ops — backtracking`);
            // Smart backtrack: if diff shows new elements appeared, don't Escape — let LLM try them
            const _hasNewElements = _lastDiff && (_lastDiff.newButtons.length > 0 || _lastDiff.newInputs.length > 0 || _lastDiff.newPopups.length > 0);
            const _hasNewOcr = _lastOcrDiff && _lastOcrDiff.added && _lastOcrDiff.added.length > 0;
            if (_hasNewElements || _hasNewOcr) {
              logger.info(`[playwright.agent] Tier 1.8: new elements detected in diff — skipping Escape, letting LLM interact`);
              _noOpCount = 0;
              _beforeState = _afterState;
              continue;
            }
            // Smart backtrack: if popup is open, try scrolling first before dismissing
            if (_afterState.popups.length > 0 && _afterState.canScrollDown) {
              logger.info(`[playwright.agent] Tier 1.8: popup open + can scroll — trying scroll before Escape`);
              await page.mouse.wheel(0, 300);
              await page.waitForTimeout(400);
              _beforeState = await _captureDomState(page);
              _noOpCount = 0;
              continue;
            }
            // Press Escape to dismiss current context
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(400);
            // Re-capture after escape
            _beforeState = await _captureDomState(page);
            const _reCap = await _liteparseCapture(page);
            if (_reCap.ok) {
              _beforeOcr = _reCap.textItems || [];
              _beforeOcr._ts = Date.now();
              _beforeOcr._imgW = _reCap.imageWidth;
              _beforeOcr._imgH = _reCap.imageHeight;
              _beforeOcr._url = _beforeState.url || '';
            }
            _revealableMenus = await _probeRevealableMenus(page);
            _probedMenuIdx++;
            _noOpCount = 0;
            _recentClicks.length = 0;
            _lastDiff = null;
            _lastOcrDiff = null;
            if (_probedMenuIdx > _revealableMenus.length + 3) {
              logger.warn(`[playwright.agent] Tier 1.8: exhausted revealable menus — breaking sub-task`);
              break;
            }
            continue;
          }
        } else {
          _noOpCount = 0;
        }

        // Update beforeState for next iteration
        _beforeState = _afterState;

        // 8. Structural verification — only on return, toastAppeared, or navigated
        const _shouldVerify = _action.action === 'return' || _compare.toastAppeared || _compare.navigated;
        if (_shouldVerify) {
          let _pageUrl = '', _pageText = '';
          try { _pageUrl = page.url(); } catch (_) {}
          _pageText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');

          const _sv = await _structuralVerifySubTask(_st, { page, pageUrl: _pageUrl, pageText: _pageText, transcript: _vdTranscript, sessionId });
          if (_sv.verified) {
            _st.completed = true;
            logger.info(`[playwright.agent] Tier 1.8: sub-task #${_st.id} completed (structural verification after ${_actionCount} action(s): ${_sv.gate}: ${_sv.reason})`);
            const _finalCap = await _liteparseCapture(page);
            if (_finalCap.ok) {
              _prevOcrItems = _finalCap.textItems || [];
              _prevOcrItems._ts = Date.now();
              _prevOcrItems._imgW = _finalCap.imageWidth;
              _prevOcrItems._imgH = _finalCap.imageHeight;
              _prevOcrItems._url = _pageUrl;
            }
            break;
          }

          // Also try basic verification as secondary check
          const _basicVerify = await _checkSubTaskCompletion(_st, page, _pageUrl, _pageText);
          if (_basicVerify) {
            _st.completed = true;
            logger.info(`[playwright.agent] Tier 1.8: sub-task #${_st.id} completed (basic verification after ${_actionCount} action(s))`);
            const _finalCap = await _liteparseCapture(page);
            if (_finalCap.ok) {
              _prevOcrItems = _finalCap.textItems || [];
              _prevOcrItems._ts = Date.now();
              _prevOcrItems._imgW = _finalCap.imageWidth;
              _prevOcrItems._imgH = _finalCap.imageHeight;
              _prevOcrItems._url = _pageUrl;
            }
            break;
          }
        }
      } // end action loop

      if (!_st.completed) {
        logger.warn(`[playwright.agent] Tier 1.8: sub-task #${_st.id} not completed after ${_actionCount} actions — will fall through`);
      }

      postProgress(_progressCallbackUrl, {
        type: 'agent:tier',
        stepIndex: _stepIndex,
        tier: 'visual-discovery',
        message: _st.completed ? `Sub-task ${_st.id} completed` : `Sub-task ${_st.id} incomplete`,
      });
    } // end sub-task loop

    // Check if all sub-tasks are complete
    const _allComplete = _subTasks.every(s => s.completed);
    if (_allComplete) {
      const _execTime = Date.now() - _vdStart;
      logger.info(`[playwright.agent] Tier 1.8: all ${_subTasks.length} sub-tasks completed in ${_execTime}ms`);
      return {
        ok: true,
        result: `All ${_subTasks.length} sub-tasks completed (Tier 1.8 Visual Discovery)`,
        transcript: _vdTranscript,
        routingDecision: 'visual_discovery',
        sessionId,
        subTasks: _subTasks,
      };
    }

    const _incomplete = _subTasks.filter(s => !s.completed).map(s => `#${s.id} ${s.description}`);
    logger.warn(`[playwright.agent] Tier 1.8: ${_incomplete.length} sub-tasks incomplete: ${_incomplete.join(', ')}`);
    return { ok: false, error: `Tier 1.8: ${_incomplete.length} sub-tasks incomplete`, transcript: _vdTranscript, subTasks: _subTasks };
  } catch (e) {
    logger.warn(`[playwright.agent] Tier 1.8 error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Build a human-readable DOM state block for the LLM prompt
function _buildDomStatePromptBlock(state) {
  const _lines = [];

  // Popups (highest priority — act inside them)
  if (state.popups.length > 0) {
    _lines.push('OPEN POPUPS/MENUS/DIALOGS (act INSIDE these):');
    for (let i = 0; i < state.popups.length; i++) {
      const p = state.popups[i];
      _lines.push(`  [popup ${i}] type=${p.type} role="${p.role}" text="${p.text}"${p.hasInput ? ` (has input: "${p.inputPlaceholder}")` : ''}`);
      const _items = p.items.filter(it => !it.disabled).slice(0, 15);
      for (const it of _items) {
        _lines.push(`    - "${it.text}" ${it.tag}${it.role ? `[role=${it.role}]` : ''} at (${it.x},${it.y})${it.disabled ? ' [disabled]' : ''}`);
      }
      if (p.items.length > 15) _lines.push(`    ... and ${p.items.length - 15} more items`);
    }
  }

  // Confirm dialogs
  if (state.confirmDialogs.length > 0) {
    _lines.push('CONFIRM DIALOGS:');
    for (const d of state.confirmDialogs) {
      _lines.push(`  "${d.text}" options: ${d.options.map(o => `"${o.text}"`).join(', ')}`);
    }
  }

  // Toasts/notifications
  if (state.toasts.length > 0) {
    _lines.push('NOTIFICATIONS/TOASTS:');
    for (const t of state.toasts) {
      _lines.push(`  [${t.type}] "${t.text}"`);
    }
  }

  // Validation errors
  if (state.validationErrors.length > 0) {
    _lines.push('VALIDATION ERRORS (fix these before proceeding):');
    for (const e of state.validationErrors) {
      _lines.push(`  field "${e.field}": ${e.message || '(invalid)'}`);
    }
  }

  // Buttons
  const _enabledButtons = state.buttons.filter(b => !b.disabled).slice(0, 25);
  if (_enabledButtons.length > 0) {
    _lines.push('BUTTONS/LINKS:');
    for (const b of _enabledButtons) {
      _lines.push(`  "${b.text}" ${b.tag}${b.role ? `[role=${b.role}]` : ''} at (${b.x},${b.y})`);
    }
  }

  // Inputs
  if (state.inputs.length > 0) {
    _lines.push('INPUT FIELDS:');
    for (const inp of state.inputs) {
      _lines.push(`  "${inp.placeholder}" type=${inp.type}${inp.value ? ` value="${inp.value}"` : ''}${inp.isFocused ? ' [focused]' : ''}${inp.required ? ' [required]' : ''}${inp.invalid ? ' [invalid]' : ''} at (${inp.x},${inp.y})`);
    }
  }

  // Selects
  if (state.selects.length > 0) {
    _lines.push('SELECTS:');
    for (const sel of state.selects) {
      _lines.push(`  "${sel.placeholder}" value="${sel.value}" options: ${sel.options.map(o => `${o.selected ? '►' : ''}"${o.text}"`).join(', ')}`);
    }
  }

  // Checkboxes/Toggles
  const _toggles = [...state.checkboxes, ...state.toggles];
  if (_toggles.length > 0) {
    _lines.push('CHECKBOXES/TOGGLES:');
    for (const cb of _toggles) {
      _lines.push(`  "${cb.label}" ${cb.checked ? '[✓]' : '[ ]'} at (${cb.x},${cb.y})`);
    }
  }

  // Tabs
  if (state.tabs.length > 0) {
    _lines.push('TABS:');
    for (const t of state.tabs) {
      _lines.push(`  "${t.text}" ${t.ariaSelected === 'true' ? '[active]' : ''} at (${t.x},${t.y})`);
    }
  }

  // Accordions/expanded elements
  if (state.accordions.length > 0) {
    _lines.push('ACCORDIONS:');
    for (const a of state.accordions) {
      _lines.push(`  "${a.text}" ${a.expanded ? '[expanded]' : '[collapsed]'} at (${a.x},${a.y})`);
    }
  }

  // Tree items
  if (state.treeItems.length > 0) {
    _lines.push('TREE ITEMS:');
    for (const t of state.treeItems) {
      _lines.push(`  ${'  '.repeat(t.level)}"${t.text}" ${t.expanded ? '[expanded]' : ''}`);
    }
  }

  // Pagination
  if (state.pagination) {
    _lines.push(`PAGINATION: page ${state.pagination.currentPage}/${state.pagination.totalPages}`);
  }

  // Load more
  if (state.loadMoreButton) {
    _lines.push(`LOAD MORE: "${state.loadMoreButton.text}" at (${state.loadMoreButton.x},${state.loadMoreButton.y})${state.loadMoreButton.disabled ? ' [disabled]' : ''}`);
  }

  // Cookie consent
  if (state.cookieConsentVisible) {
    _lines.push('⚠️ COOKIE CONSENT DIALOG VISIBLE — dismiss with pressEscape');
  }

  // Login wall
  if (state.isLoginWall) {
    _lines.push('⚠️ LOGIN WALL DETECTED — may need authentication');
  }

  return _lines.length > 0 ? _lines.join('\n') : '(no interactive elements detected)';
}

async function _executeStateDiffLoop({ goal, verificationGoal, sessionId, headed, timeoutMs, agentContext, deadline, start, heartbeat, hostname, _preDecomposedSubTasks = null, _progressCallbackUrl = null, _stepIndex = null }) {
  const _sdStart = Date.now();
  logger.info(`[playwright.agent] state-diff loop: starting for goal="${goal.slice(0, 80)}"`);

  try {
    const page = engine.getPage(sessionId);
    if (!page) return { ok: false, error: 'no page' };

    // Decompose goal into sub-tasks (with expectedState)
    let _subTasks = _preDecomposedSubTasks;
    if (!_subTasks) {
      const _decomp = await _decomposeGoalIntoSubTasks(goal, sessionId);
      if (_decomp.ok && _decomp.subTasks) {
        _subTasks = _decomp.subTasks;
      }
    }
    if (!_subTasks || _subTasks.length === 0) {
      logger.warn(`[playwright.agent] state-diff loop: no sub-tasks — falling back`);
      return { ok: false, error: 'no sub-tasks available' };
    }
    logger.info(`[playwright.agent] state-diff loop: ${_subTasks.length} sub-tasks`);

    const _sdTranscript = [];
    const MAX_ACTIONS_PER_SUBTASK = 5;
    let _liteparseCache = null; // { textItems, imageWidth, imageHeight, timestamp }

    // Emit tier progress so the frontend shows state-diff loop activity
    postProgress(_progressCallbackUrl, {
      type: 'agent:tier',
      stepIndex: _stepIndex,
      tier: 'state-diff',
      message: `State-diff loop: ${_subTasks.length} sub-tasks`,
    });

    for (let _stIdx = 0; _stIdx < _subTasks.length; _stIdx++) {
      const _st = _subTasks[_stIdx];
      if (_st.completed) continue;
      if (Date.now() > deadline) {
        logger.warn(`[playwright.agent] state-diff loop: deadline exceeded at sub-task #${_st.id}`);
        return { ok: false, error: 'deadline exceeded', transcript: _sdTranscript, partialProgress: await _summarizePartialProgress({ goal, transcript: _sdTranscript, sessionId, hostname }) };
      }

      logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id}/${_subTasks.length} — "${_st.description.slice(0, 80)}"`);

      // 1. Capture beforeState (full: DOM + LiteParser + openMenus)
      const _beforeState = await _captureState(sessionId, headed, 'full');
      // Cache the LiteParser capture for _resolveActionTarget
      if (_beforeState.ocrText) {
        // Re-capture textItems for coordinate matching (ocrText is just the string)
        try {
          const _cap = await _liteparseCapture(page);
          if (_cap.ok) _liteparseCache = { textItems: _cap.textItems, imageWidth: _cap.imageWidth, imageHeight: _cap.imageHeight, timestamp: Date.now() };
        } catch (_) {}
      }

      let _actionCount = 0;
      let _noOpCount = 0;
      let _lastDiff = null;

      // 2. Action loop for this sub-task
      while (_actionCount < MAX_ACTIONS_PER_SUBTASK) {
        if (Date.now() > deadline) break;

        // Get fresh DOM snapshot for the LLM prompt
        const _snap = await _fastSnapshot(sessionId, headed, timeoutMs);
        let _currentSnapshot = _snap?.ok ? String(_snap.result || '') : '';
        const _prunedSnap = pruneSnapshot(extractInteractiveRefs(_currentSnapshot));

        // Build the LLM prompt
        const _turnUser = `SUB-TASK #${_st.id}: ${_st.description}
VERIFICATION: ${_st.verification}
EXPECTED STATE AFTER: ${_st.expectedState || '(not specified)'}

CURRENT PAGE URL: ${_beforeState.url}
${_beforeState.ocrText ? `OCR SCREEN CAPTURE (what's actually visible):\n${_beforeState.ocrText.slice(0, 1500)}\n` : ''}
CURRENT SNAPSHOT (ARIA):
${_prunedSnap.slice(0, 3000)}
${_lastDiff ? `\nLAST ACTION RESULT: ${_lastDiff.changed ? `State changed (${_lastDiff.changes.join(', ')})` : 'State UNCHANGED — your last action was a no-op. Try a COMPLETELY different approach.'}\n` : ''}
${_actionCount === 0 ? 'What is your first action to complete this sub-task?' : `Action ${_actionCount + 1}/${MAX_ACTIONS_PER_SUBTASK}. What is your next action?`}

Output ONLY the JSON action:`;

        let _actionRaw;
        try {
          _actionRaw = await askWithMessages([
            { role: 'system', content: STATE_DIFF_LOOP_SYSTEM_PROMPT },
            { role: 'user', content: _turnUser },
          ], { temperature: 0.1, maxTokens: 400, responseTimeoutMs: 20000 });
        } catch (_llmErr) {
          logger.warn(`[playwright.agent] state-diff loop: LLM call failed: ${_llmErr.message}`);
          break;
        }

        const _action = parseJson(_actionRaw);
        if (!_action || !_action.action) {
          logger.warn(`[playwright.agent] state-diff loop: unparseable action: ${(_actionRaw || '').slice(0, 100)}`);
          break;
        }

        // Return = sub-task done
        if (_action.action === 'return') {
          // Verify the sub-task is actually complete
          let _retUrl = '';
          try { _retUrl = page.url(); } catch (_) {}
          const _verifyResult = await _checkSubTaskCompletion(_st, page, _retUrl, await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => ''));
          if (_verifyResult) {
            _st.completed = true;
            logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id} completed (return + verification passed)`);
            _sdTranscript.push({ action: _action, outcome: { ok: true }, subTask: _st.id, note: 'completed via return' });
            break;
          } else {
            // Verification failed — continue loop with a hint
            logger.warn(`[playwright.agent] state-diff loop: sub-task #${_st.id} return rejected — verification not met`);
            _sdTranscript.push({ action: _action, outcome: { ok: false, error: 'return rejected — verification not met' }, subTask: _st.id });
            _lastDiff = { changed: false, changes: ['return-rejected'] };
            _actionCount++;
            continue;
          }
        }

        // 3. Resolve ambiguous clickByText targets
        if (_action.action === 'clickByText' && _action.text) {
          const _resolution = await _resolveActionTarget({
            sessionId,
            text: _action.text,
            subTaskContext: _st.description + ' ' + (_st.expectedState || ''),
            liteparseCache: _liteparseCache,
          });
          if (_resolution.ok && _resolution.resolved && _resolution.bestSelector) {
            // Convert to clickBySelector for precise targeting
            _action.action = 'clickBySelector';
            _action.selector = _resolution.bestSelector;
            logger.info(`[playwright.agent] state-diff loop: resolved clickByText "${_action.text}" → clickBySelector "${_resolution.bestSelector}"`);
          } else if (_resolution.ok && !_resolution.resolved && _resolution.candidates) {
            // Still ambiguous — include candidates in next prompt
            const _candList = _resolution.candidates.map(c => `  - "${c.text}" at (${c.cx},${c.cy}) score=${c.score} dialog="${c.dialogLabel}" compliance=${c.isCompliance}`).join('\n');
            _lastDiff = { changed: false, changes: [`AMBIGUOUS TARGET: Multiple elements match "${_action.text}":\n${_candList}\nUse clickBySelector with a more specific selector, or press Escape to dismiss irrelevant dialogs first.`] };
            _actionCount++;
            continue; // skip execution, re-prompt with ambiguity info
          }
        }

        // 4. Execute the action
        logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id} action ${_actionCount + 1}/${MAX_ACTIONS_PER_SUBTASK}: ${_action.action}`);
        let _outcome;
        try {
          _outcome = await browserAct({ ..._action, sessionId, headed, timeoutMs: timeoutMs || 15000 });
        } catch (_execErr) {
          _outcome = { ok: false, error: _execErr.message };
        }
        _sdTranscript.push({ action: _action, outcome: _outcome, subTask: _st.id });
        _actionCount++;

        // Emit per-turn progress so the frontend shows state-diff loop activity
        postProgress(_progressCallbackUrl, {
          type: 'agent:turn',
          stepIndex: _stepIndex,
          turn: _actionCount,
          maxTurns: MAX_ACTIONS_PER_SUBTASK,
          action: _action,
          outcome: _outcome,
          thoughts: '',
        });

        if (!_outcome.ok) {
          logger.warn(`[playwright.agent] state-diff loop: action failed: ${_outcome.error}`);
          _lastDiff = { changed: false, changes: [`action failed: ${_outcome.error}`] };
          continue;
        }

        // 5. Capture afterState (cheap) and diff
        const _afterState = await _captureState(sessionId, headed, 'cheap');
        _lastDiff = _diffStates(_beforeState, _afterState);

        if (!_lastDiff.changed) {
          _noOpCount++;
          logger.warn(`[playwright.agent] state-diff loop: no-op detected (action had no effect) — noOpCount=${_noOpCount}`);
          if (_noOpCount >= 2) {
            // Two consecutive no-ops — inject a strong hint and try a different approach
            _lastDiff = { changed: false, changes: ['Two consecutive no-ops. The element may be hidden, in the wrong dialog, or require a different action type. Try: (a) press Escape to dismiss irrelevant dialogs, (b) use a different selector, (c) try a keyboard shortcut, (d) return done if the sub-task is already complete.'] };
          }
        } else {
          _noOpCount = 0;
          logger.info(`[playwright.agent] state-diff loop: state changed (${_lastDiff.changes.join(', ')})`);
        }

        // 6. Check verification
        let _pageUrl = '', _pageText = '';
        try {
          try { _pageUrl = page.url(); } catch (_) {}
          _pageText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
        } catch (_) {}

        const _verified = await _checkSubTaskCompletion(_st, page, _pageUrl, _pageText);
        if (_verified) {
          _st.completed = true;
          logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id} completed (verification passed after ${_actionCount} action(s))`);
          // 7. Capture final afterState (full) and compare with expectedState
          const _finalState = await _captureState(sessionId, headed, 'full');
          logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id} final state — url=${_finalState.url}, modalCount=${_finalState.modalCount}, ocrPreview="${(_finalState.ocrText || '').slice(0, 100).replace(/\n/g, ' ')}..."`);
          break;
        }
      } // end action loop

      if (!_st.completed) {
        logger.warn(`[playwright.agent] state-diff loop: sub-task #${_st.id} not completed after ${_actionCount} actions — trying structural verification`);
        // Try structural verification as a fallback
        let _structPageText = '', _structPageUrl = '';
        try {
          _structPageText = await page.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
          try { _structPageUrl = page.url(); } catch (_) {}
        } catch (_) {}
        const _sv = await _structuralVerifySubTask(_st, { page, pageUrl: _structPageUrl, pageText: _structPageText, transcript: _sdTranscript, sessionId });
        if (_sv.verified) {
          _st.completed = true;
          logger.info(`[playwright.agent] state-diff loop: sub-task #${_st.id} completed via structural verification (${_sv.gate}: ${_sv.reason})`);
        } else {
          logger.warn(`[playwright.agent] state-diff loop: sub-task #${_st.id} NOT verified (${_sv.gate}: ${_sv.reason}) — falling back to turn-loop`);
          // Don't try remaining sub-tasks — fall back to turn-loop for the whole goal
          break;
        }
      }
    } // end sub-task loop

    // Check if all sub-tasks are complete
    const _allComplete = _subTasks.every(s => s.completed);
    if (_allComplete) {
      const _execTime = Date.now() - _sdStart;
      logger.info(`[playwright.agent] state-diff loop: all ${_subTasks.length} sub-tasks completed in ${_execTime}ms`);
      return {
        ok: true,
        result: `All ${_subTasks.length} sub-tasks completed (state-diff loop)`,
        transcript: _sdTranscript,
        routingDecision: 'state_diff_loop',
        sessionId,
      };
    }

    // Not all complete — return failure with partial progress
    const _incomplete = _subTasks.filter(s => !s.completed).map(s => `#${s.id} ${s.description}`);
    logger.warn(`[playwright.agent] state-diff loop: ${_incomplete.length} sub-tasks incomplete: ${_incomplete.join(', ')}`);
    const _partialProgress = await _summarizePartialProgress({ goal, transcript: _sdTranscript, sessionId, hostname });
    return { ok: false, error: `state-diff loop: ${_incomplete.length} sub-tasks incomplete`, transcript: _sdTranscript, partialProgress: _partialProgress, subTasks: _subTasks };
  } catch (e) {
    logger.warn(`[playwright.agent] state-diff loop error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Session-scoped "failed approaches" ledger (process of elimination) ──────
// Top-level so both _executeTurnLoopFallback and playwrightAgent can access it.
// Reset to [] at the start of each playwrightAgent() call for per-run isolation.
let _failedApproaches = [];
function _recordFailedApproach(approach, result, url) {
  const _entry = { approach: String(approach || '').slice(0, 200), result: String(result || '').slice(0, 200), url: url || '' };
  if (!_failedApproaches.some(a => a.approach === _entry.approach && a.result === _entry.result)) {
    _failedApproaches.push(_entry);
    if (_failedApproaches.length > 8) _failedApproaches.shift();
    logger.info(`[playwright.agent] failed-approaches: recorded #${_failedApproaches.length}: "${_entry.approach}" → "${_entry.result}"`);
  }
}
function _formatFailedApproachesBlock() {
  if (_failedApproaches.length === 0) return '';
  const _lines = _failedApproaches.map((a, i) =>
    `${i + 1}. Tried: ${a.approach} → Result: ${a.result}${a.url ? ` (on ${a.url})` : ''}`
  );
  return `\nFAILED APPROACHES (these did not achieve the goal — do NOT retry the same actions; try a DIFFERENT approach):\n${_lines.join('\n')}\n`;
}

async function _executeTurnLoopFallback({ goal, verificationGoal, sessionId, headed, timeoutMs, agentContext, transcript, deadline, start, extractedText, heartbeat, textAlreadyEntered, maxTurns = 8, hostname, _discoveryAlreadyAttempted = false, _preDecomposedSubTasks = null, _inheritedActionSignatureCounts = null, _inheritedJitDiscoveryFired = null, _progressCallbackUrl, _stepIndex, _abortSignal = null }) {
  const MAX_TURNS = maxTurns;
  const _loopTranscript = [...transcript];

  // Emit tier progress so the frontend shows turn-loop activity
  postProgress(_progressCallbackUrl, {
    type: 'agent:tier',
    stepIndex: _stepIndex,
    tier: 'turn-loop',
    message: `Turn-loop fallback starting (max ${MAX_TURNS} turns)`,
  });

  let _lastActionSignature = null; // for duplicate detection
  let _lastStateHash = null;       // page state hash for no-op detection
  // Stash for LLM return data that was rejected by goal verification. If the
  // pre-exhaustion check later passes, this content (which often contains the
  // extracted data the user actually wants) is used as the result instead of a
  // generic "Goal verified" string — preventing data loss downstream.
  let _rejectedReturnData = null;
  // Discovery-on-exhaust: set to true on the first exhaust so the retry
  // (re-entering this function with the discovered procedure) does not
  // trigger another discovery, preventing infinite recursion.
  let _discoveryAttempted = _discoveryAlreadyAttempted;
  // Cross-transcript action-signature repeat counter for no-progress detection.
  // Key: "{action}|{selector}|{text}|{url}". Value: count of prior attempts with
  // ok=true outcomes. The body.innerText hash the old guard relies on is unreliable
  // on apps with live regions (Google Docs' body text mutates constantly), so we
  // additionally bail when the SAME action signature repeats ≥3× without the goal
  // being met — this stops the 14×-identical-reactFill failure mode.
  const _actionSignatureCounts = _inheritedActionSignatureCounts ? new Map(_inheritedActionSignatureCounts) : new Map();
  const _NO_PROGRESS_THRESHOLD = 3;       // hint after this many identical unproductive attempts
  const _NO_PROGRESS_BAIL_THRESHOLD = 4;  // bail to ask_user after this many
  let _noProgressHintInjected = false;
  // JIT sub-task discovery: when the agent gets stuck (3+ duplicate/blocked
  // attempts on the same action), trigger _discoverTaskProcedure for the
  // CURRENT sub-task only (not the whole goal). This is faster and more
  // targeted than on-exhaust discovery. Tracks which sub-task IDs have
  // already been discovered so we don't re-discover the same sub-task.
  const _jitDiscoveryFiredForSubTask = _inheritedJitDiscoveryFired ? new Set(_inheritedJitDiscoveryFired) : new Set();
  // URL-drift tracking: records the page URL when each sub-task STARTED being
  // worked on. If the agent navigates away from that URL while the sub-task is
  // still incomplete, a hint is injected telling the agent to navigate back.
  // This is general — works for any site where a sub-task starts on one page
  // and the agent drifts to another (e.g. searching on a global page instead
  // of the section-specific page).
  const _subTaskStartUrls = new Map(); // subTaskId → URL path when sub-task started
  const _urlDriftFiredFor = new Set(); // subTaskIds where drift hint was already fired
  // ── LLM goal decomposition: break the goal into sub-tasks with semantic
  // verification criteria. This replaces the fragile regex-based phrase
  // extraction as the PRIMARY verification mechanism. Falls back to regex
  // (_extractGoalPhrases) if decomposition fails.
  let _subTasks = _preDecomposedSubTasks;
  if (_subTasks) {
    logger.info(`[playwright.agent] turn-loop: using pre-decomposed sub-tasks (${_subTasks.length} sub-tasks, cached from pre-check)`);
  } else if (!_discoveryAlreadyAttempted) {
    try {
      const _decomp = await _decomposeGoalIntoSubTasks(goal, sessionId);
      if (_decomp.ok && _decomp.subTasks && _decomp.subTasks.length > 0) {
        _subTasks = _decomp.subTasks;
      }
    } catch (e) {
      logger.warn(`[playwright.agent] turn-loop: goal decomposition error (non-fatal): ${e.message}`);
    }
  }
  logger.info(`[playwright.agent] turn-loop fallback: starting (max ${MAX_TURNS} turns) for goal="${goal.slice(0, 80)}"${_subTasks ? ` [decomposed: ${_subTasks.length} sub-tasks]` : ''}`);

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (Date.now() > deadline) {
      logger.warn(`[playwright.agent] turn-loop: deadline exceeded at turn ${turn}`);
      break;
    }
    // Abort check — user clicked Cancel. Break out of the turn-loop cleanly.
    if (_abortSignal && _abortSignal.aborted) {
      logger.info(`[playwright.agent] turn-loop: cancelled by signal at turn ${turn}`);
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
    let _probe = null;
    try {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        _probe = await _ePage.evaluate(() => {
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

    // ── DOM STATE SIGNALS (5th signal: active UI elements + ready-made selectors) ──
    // Dumps elements with state-like attributes (contenteditable, aria-expanded, aria-modal,
    // state classes, placeholder text, shadow DOM hosts). Each signal includes a CSS selector
    // the LLM can use directly in clickBySelector/reactFill.
    // PRIORITIZED: text inputs (input/textarea/contenteditable/role=textbox|searchbox|combobox)
    // are collected FIRST with parent context (nearest heading/aria-label/section), so the LLM
    // can disambiguate when multiple similar inputs exist (e.g. Spotify's global search vs.
    // playlist's "Search for songs or episodes"). Other signals fill the remaining slots.
    let _domSignals = '';
    let _signals = [];  // declared outside try so search disambiguation can access it
    try {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        _signals = await _ePage.evaluate(() => {
          const inputSignals = [];
          const otherSignals = [];
          function makeSelector(el) {
            if (el.id) return `#${el.id}`;
            const parts = [el.tagName.toLowerCase()];
            if (el.getAttribute('aria-label')) parts.push(`[aria-label='${el.getAttribute('aria-label')}']`);
            else if (el.getAttribute('placeholder')) parts.push(`[placeholder='${el.getAttribute('placeholder')}']`);
            else if (el.getAttribute('aria-placeholder')) parts.push(`[aria-placeholder='${el.getAttribute('aria-placeholder')}']`);
            else if (el.getAttribute('contenteditable')) parts.push(`[contenteditable='${el.getAttribute('contenteditable')}']`);
            else if (el.getAttribute('role')) parts.push(`[role='${el.getAttribute('role')}']`);
            else if (el.getAttribute('data-testid')) parts.push(`[data-testid='${el.getAttribute('data-testid')}']`);
            return parts.join('');
          }
          function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const s = window.getComputedStyle(el);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
            if (parseFloat(s.opacity) === 0) return false;
            return true;
          }
          // getParentContext: walk up to 4 parents to find a distinguishing label —
          // nearest heading text, aria-label, data-testid, or section title.
          // This lets the LLM tell apart inputs like "Search for songs or episodes"
          // (context: "Let's find something for your playlist") from "What do you want
          // to play?" (context: "Your Library").
          function getParentContext(el) {
            let parent = el.parentElement;
            for (let i = 0; i < 4 && parent; i++) {
              // Heading text (h1-h6)
              const heading = parent.querySelector('h1, h2, h3, h4, h5, h6');
              if (heading && (heading.innerText || '').trim()) {
                return (heading.innerText || '').trim().slice(0, 60);
              }
              // aria-label on this parent
              const al = parent.getAttribute('aria-label');
              if (al) return al.slice(0, 60);
              // data-testid as fallback
              const dt = parent.getAttribute('data-testid');
              if (dt) return dt.slice(0, 60);
              parent = parent.parentElement;
            }
            return '';
          }
          const INPUT_SELECTOR = 'input, textarea, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"]';
          // 1. PRIORITIZED: All visible text inputs with parent context (no cap)
          //    Capture y-coordinate for positional search disambiguation.
          document.querySelectorAll(INPUT_SELECTOR).forEach(el => {
            if (!isVisible(el)) return;
            const _rect = el.getBoundingClientRect();
            inputSignals.push({
              selector: makeSelector(el),
              tag: el.tagName,
              ce: el.getAttribute('contenteditable') || '',
              label: el.getAttribute('aria-label') || '',
              placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '',
              role: el.getAttribute('role') || '',
              context: getParentContext(el),
              text: (el.innerText || el.value || '').slice(0, 50),
              y: Math.round(_rect.y),
              isInput: true,
            });
          });
          // 2. aria-expanded/aria-haspopup/aria-modal — capture text content too
          document.querySelectorAll('[aria-expanded], [aria-haspopup], [aria-modal]').forEach(el => {
            const _t = (el.innerText || el.textContent || '').trim();
            otherSignals.push({ selector: makeSelector(el), tag: el.tagName, expanded: el.getAttribute('aria-expanded'), modal: el.getAttribute('aria-modal'), label: el.getAttribute('aria-label'), text: _t ? _t.slice(0, 80) : '' });
          });
          // 3. State-like classes (compose/share/editor/modal) — capture text content
          document.querySelectorAll('[class*="modal" i], [class*="compose" i], [class*="share" i], [class*="editor" i]').forEach(el => {
            if (el.children.length < 10) {
              const _t = (el.innerText || el.textContent || '').trim();
              otherSignals.push({ selector: makeSelector(el), tag: el.tagName, class: (el.className || '').slice(0, 100), label: el.getAttribute('aria-label'), ce: el.getAttribute('contenteditable'), text: _t ? _t.slice(0, 80) : '' });
            }
          });
          // 4. Elements with placeholder text (already captured in input pass if they're inputs;
          //    this catches non-input elements with placeholders, e.g. div[role='combobox'])
          document.querySelectorAll('[placeholder], [aria-placeholder]').forEach(el => {
            if (el.matches(INPUT_SELECTOR)) return; // already in inputSignals
            const _t = (el.innerText || el.textContent || '').trim();
            otherSignals.push({ selector: makeSelector(el), tag: el.tagName, placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'), ce: el.getAttribute('contenteditable'), text: _t ? _t.slice(0, 80) : '' });
          });
          // 5. Menu items, buttons with role, and clickable elements with text —
          //    CRITICAL: capture text content so the LLM can see what menu items say.
          //    Without this, the LLM sees button[role='menuitem'] but doesn't know
          //    if it says "Christian Music" or "Accept cookies".
          document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="button"], button[type="submit"], button[type="button"]').forEach(el => {
            if (!isVisible(el)) return;
            const _t = (el.innerText || el.textContent || '').trim();
            if (!_t) return; // skip elements with no text
            // Skip if already captured (avoid duplicates)
            const _sel = makeSelector(el);
            if (otherSignals.some(s => s.selector === _sel && s.text === _t.slice(0, 80))) return;
            otherSignals.push({ selector: _sel, tag: el.tagName, role: el.getAttribute('role') || '', label: el.getAttribute('aria-label') || '', text: _t.slice(0, 80), expanded: el.getAttribute('aria-expanded') || '' });
          });
          // 6. Shadow DOM hosts
          document.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
              otherSignals.push({ selector: makeSelector(el), tag: el.tagName, shadow: true, label: el.getAttribute('aria-label') });
            }
          });
          // Inputs first (all of them), then others up to 25 total
          const others = otherSignals.slice(0, Math.max(0, 25 - inputSignals.length));
          return [...inputSignals, ...others];
        }).catch(() => []);
        if (_signals.length > 0) {
          _domSignals = _signals.map(s => {
            const parts = [s.selector];
            if (s.tag) parts.push(`<${s.tag}>`);
            if (s.ce) parts.push(`contenteditable=${s.ce}`);
            if (s.label) parts.push(`label="${s.label}"`);
            if (s.placeholder) parts.push(`placeholder="${s.placeholder}"`);
            if (s.role) parts.push(`role="${s.role}"`);
            if (s.context) parts.push(`context="${s.context}"`);
            if (s.y !== undefined) parts.push(`y=${s.y}`);
            if (s.expanded) parts.push(`expanded=${s.expanded}`);
            if (s.modal) parts.push(`modal=${s.modal}`);
            if (s.class) parts.push(`class="${s.class}"`);
            if (s.text) parts.push(`text="${s.text}"`);
            if (s.shadow) parts.push(`shadowDOM=true`);
            return '  ' + parts.join(' ');
          }).join('\n');
          const _inputCount = _signals.filter(s => s.isInput).length;
          logger.info(`[playwright.agent] turn-loop: DOM signals dump (${_signals.length} signals, ${_inputCount} inputs prioritized):\n${_domSignals}`);
        }
      }
    } catch (_) {}

    // ── Search input disambiguation hint ──
    // When DOM signals show 2+ search inputs, inject a hint so the LLM picks the
    // right one. Uses positional heuristic: the topmost search input (lowest y) is
    // typically the global search — mark it as [AVOID for context-specific tasks].
    // Don't mark any as PREFERRED — there may be sidebar/footer searches that are
    // also not relevant. Let the LLM pick among the non-topmost ones using context.
    // Also add URL-first guidance: for global searches, navigate to the URL directly
    // instead of typing in the top search field.
    let _searchDisambiguationHint = '';
    try {
      const _searchInputs = _signals.filter(s =>
        s.isInput && (
          (s.placeholder && /search|find|what do you want/i.test(s.placeholder)) ||
          (s.label && /search|find|what do you want/i.test(s.label)) ||
          (s.role === 'searchbox') || (s.role === 'combobox')
        )
      );
      if (_searchInputs.length >= 2) {
        // Sort by y ascending (topmost first)
        const _sorted = [..._searchInputs].sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
        const _topY = _sorted[0].y;
        const _lines = _sorted.map((s, i) => {
          const _id = s.label ? `[aria-label='${s.label}']` : `[placeholder='${s.placeholder}']`;
          const _ctx = s.context ? ` context="${s.context}"` : '';
          const _avoid = (i === 0) ? ` [AVOID for context-specific tasks — likely global search]` : '';
          return `  ${i + 1}. ${_id} (y=${s.y ?? '?'})${_ctx}${_avoid}`;
        });
        _searchDisambiguationHint = `\n⚠️ MULTIPLE SEARCH INPUTS DETECTED (${_searchInputs.length}):\n${_lines.join('\n')}\nFor context-specific tasks, AVOID the topmost search input (lowest y). Pick the input whose context matches the section you're working in.\nFor global searches, prefer URL navigation instead of typing in the top search field (e.g., https://[site]/search/{query} or https://[site]/search?q={query}).\n`;
        logger.info(`[playwright.agent] turn-loop: search disambiguation hint injected (${_searchInputs.length} search inputs, topmost y=${_topY} marked AVOID)`);
      }
    } catch (_) {}

    // ── URL-drift detection hint ──
    // General: if the current sub-task started on URL X and the agent is now on
    // URL Y (different path), inject a hint to navigate back. This catches the
    // case where the agent navigated away from the section it was working in
    // (e.g. navigated to an artist page instead of staying on the playlist page).
    let _urlDriftHint = '';
    try {
      if (_subTasks && _subTasks.length > 0) {
        const _currentST = _subTasks.find(s => !s.completed);
        if (_currentST) {
          const _curUrlRes = await _engineEval(sessionId, 'window.location.href');
          if (_curUrlRes?.ok) {
            const _curUrl = String(_curUrlRes.result).trim().replace(/^"|"$/g, '');
            const _curPath = (() => { try { return new URL(_curUrl).pathname; } catch (_) { return _curUrl; } })();
            // Record the start URL for this sub-task if not already recorded
            if (!_subTaskStartUrls.has(_currentST.id)) {
              _subTaskStartUrls.set(_currentST.id, _curPath);
            }
            const _startPath = _subTaskStartUrls.get(_currentST.id);
            // If the path changed (ignoring query params/hash), inject drift hint
            // BUT only fire once per sub-task to avoid spamming the prompt every turn
            if (_startPath && _curPath !== _startPath && !_urlDriftFiredFor.has(_currentST.id)) {
              _urlDriftHint = `\n⚠️ URL DRIFT DETECTED: This sub-task started on path "${_startPath}" but you are now on path "${_curPath}". If this sub-task requires being on the original page, navigate back to it first (e.g., click the back button, or click the relevant item in the sidebar/navigation).\n`;
              _urlDriftFiredFor.add(_currentST.id);
              logger.info(`[playwright.agent] turn-loop: URL drift hint injected (sub-task #${_currentST.id}: "${_startPath}" → "${_curPath}") [once]`);
            }
          }
        }
      }
    } catch (_) {}

    // ── Open menu detection (general — uses ARIA roles + class heuristics) ──
    // Detect open menus/dialogs and capture their contents. When a menu is open,
    // the agent MUST complete or dismiss it before taking any other action.
    // This prevents the agent from abandoning an open "Add to playlist" menu to
    // search for the next artist. Works for any site with menus/dialogs.
    let _openMenuHint = '';
    let _openMenus = []; // all visible non-compliance menus/dialogs
    let _activeMenuScope = null; // selector for the most prominent open menu
    let _activeMenuItems = []; // text of items in the active menu
    try {
      _openMenus = await _detectOpenMenus(sessionId, headed, 5000);
      if (_openMenus.length > 0) {
        // Pick the most prominent menu (most items, excluding cookie consent)
        const _activeMenu = _openMenus[0];
        _activeMenuScope = _activeMenu.selector;
        _activeMenuItems = _activeMenu.items.map(i => i.text).filter(Boolean);

        // ── Tier 1.6: Structured OCR overlay handler ──────────────────────────
        // When a menu is open, OCR its region, restructure via
        // ocrOverlayStructure.cjs, and ask the LLM to pick the right row.
        // This is more accurate than the DOM-scraped text hint below because:
        //   (a) OCR captures what's actually visible (not filtered by EXCLUDE_CONTEXT)
        //   (b) ocrOverlayStructure.cjs clusters fragments into clean rows
        //   (c) The LLM sees structured { id, type, text, description } rows
        // Falls back to the text hint if Tier 1.6 fails.
        if (_activeMenuItems.length >= 2 && _activeMenu.boundingRect && _activeMenu.boundingRect.width > 10) {
          try {
            logger.info(`[playwright.agent] turn-loop: Tier 1.6 overlay handler — OCR menu region ${JSON.stringify(_activeMenu.boundingRect)} (${_activeMenuItems.length} DOM items)`);
            const _overlayResult = await _executeOverlayInteraction({
              goal, sessionId, headed, timeoutMs,
              overlayRect: _activeMenu.boundingRect,
              skipTriggerClick: true, // menu is already open
            });
            if (_overlayResult.ok) {
              logger.info(`[playwright.agent] turn-loop: Tier 1.6 succeeded (${_overlayResult.action}) — ${_overlayResult.reason || ''}`);
              // Record the action in the loop transcript
              _loopTranscript.push({
                step: turn,
                action: { action: 'overlay_interaction', tier: '1.6', selectedText: _overlayResult.selectedText || '' },
                outcome: { ok: true, ..._overlayResult },
                thoughts: `Tier 1.6 overlay handler: ${_overlayResult.reason || ''}`,
              });
              // Skip the normal LLM turn — Tier 1.6 already clicked the right item.
              // Continue to next turn iteration for state capture + verification.
              _openMenuHint = '';
              continue; // skip to next turn — don't run LLM this iteration
            }
            logger.warn(`[playwright.agent] turn-loop: Tier 1.6 failed: ${_overlayResult.error} — falling back to text hint`);
          } catch (_t16Err) {
            logger.warn(`[playwright.agent] turn-loop: Tier 1.6 error: ${_t16Err.message} — falling back to text hint`);
          }
        }

        // Fallback: text hint (existing behavior)
        if (_activeMenuItems.length > 0) {
          const _itemsList = _activeMenuItems.map(t => `    - "${t}"`).join('\n');
          const _multiModal = _openMenus.length > 1 ? ` Multiple dialogs are open. If the element you need is NOT inside this menu, DISMISS the others first (press Escape or click their Cancel/Close) before interacting with it.` : '';
          _openMenuHint = `\n⚠️ OPEN MENU DETECTED (${_activeMenu.role || 'menu'}${_activeMenu.label ? ', label="' + _activeMenu.label + '"' : ''}):\n${_itemsList}\nYou MUST complete or dismiss this menu before taking any other action. Do NOT search, navigate, or type into other fields while this menu is open.${_multiModal}\nTo complete: clickByText one of the menu items listed above.\nTo dismiss: press Escape.\n`;
          logger.info(`[playwright.agent] turn-loop: open menu hint injected (${_activeMenuItems.length} items, scope=${_activeMenuScope}, totalMenus=${_openMenus.length})`);
        }
      }
    } catch (_) {}

    // ── OCR capture (B+ trigger: first turn, DOM disagrees, or last action failed) ──
    // The DOM-based sources (heartbeat, page text, ARIA snapshot) can miss modals
    // that use CSS transforms or shadow DOM (getBoundingClientRect returns 0).
    // OCR captures what's actually visible on screen — ground truth.
    let _ocrText = '';
    const _isFirstTurn = turn === 1;
    // DOM disagrees: heartbeat says visibleModalCount=0 but probe found a VISIBLE modal.
    // Use _probe.hasModal (visibility-filtered via getBoundingClientRect) — NOT
    // _probe.hasAnyModal, which counts hidden [role="dialog"] elements that some
    // apps (e.g. Google Docs) always carry in the DOM. Counting those caused OCR
    // to fire every turn and (with the old OS-level capture) flicker the overlay.
    const _lastTick = heartbeat?.buffer?.[heartbeat.buffer.length - 1];
    const _domDisagrees = _lastTick && _lastTick.visibleModalCount === 0 &&
      _probe && _probe.hasModal === true;
    // Last action failed
    const _lastAction = _loopTranscript[_loopTranscript.length - 1];
    const _actionFailed = _lastAction && _lastAction.outcome && !_lastAction.outcome.ok;
    if (_isFirstTurn || _domDisagrees || _actionFailed) {
      logger.info(`[playwright.agent] turn-loop: OCR capture triggered (firstTurn=${_isFirstTurn} domDisagrees=${!!_domDisagrees} actionFailed=${!!_actionFailed})`);
      try {
        // Page-level capture (Playwright screenshot → LiteParse) — no overlay hide/show, no flicker.
        // Falls back to OS-level screen.analyze only when no engine page is available.
        const _cap = await _ocrCaptureViaPage(sessionId);
        if (_cap.ok) {
          _ocrText = _cap.text.slice(0, 1500);
          logger.info(`[playwright.agent] turn-loop: OCR captured ${_ocrText.length} chars (app=${_cap.appName} conf=${_cap.confidence} url=${_cap.url}) textPreview="${_ocrText.slice(0, 300).replace(/\n/g, ' ')}..."`);
        } else {
          logger.warn(`[playwright.agent] turn-loop: OCR capture failed: ${_cap.error}`);
        }
      } catch (e) {
        logger.warn(`[playwright.agent] turn-loop: OCR capture error: ${e.message}`);
      }
    }

    // ── Text-already-entered detection (DOM + OCR) ──
    // If text was typed by Plan-Execute or a prior phase but verification failed
    // (e.g. "text still in compose — not sent"), detect it here so the turn-loop
    // doesn't re-type. DOM check is authoritative; OCR is fallback for canvas/shadow DOM.
    // NOTE: Only run for compose/post/share tasks. For search/navigation tasks (e.g.
    // "search for Lecrae"), extractedText is the last quoted string which may not
    // match any compose field, causing false "field found but text does not match"
    // logs every turn. Skip DOM verify entirely for non-compose tasks.
    const _isComposeTask = /\bpost\b|\bshare\b|\btweet\b|\bcompose\b|\bwrite\b|\bmessage\b|\bsend\b|\bemail\b/i.test(goal);
    if (!textAlreadyEntered && extractedText && _isComposeTask) {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const _domCheck = await _domVerify(_ePage, extractedText).catch(() => null);
        if (_domCheck?.ok) {
          textAlreadyEntered = true;
          logger.info(`[playwright.agent] turn-loop: text already in compose box (DOM verify ok) — setting textAlreadyEntered=true, will NOT re-type`);
        } else if (_ocrText) {
          // OCR fallback: check if expected text is visible in a compose context
          const _words = extractedText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
          const _ocrLower = _ocrText.toLowerCase();
          const _matchedWords = _words.filter(w => _ocrLower.includes(w));
          const _wordRatio = _words.length > 0 ? _matchedWords.length / _words.length : 0;
          if ((_wordRatio > 0.5 || _ocrLower.includes(extractedText.slice(0, 40).toLowerCase())) &&
              /create post|what's on your mind|compose|share a post|post to|dialog/i.test(_ocrText)) {
            textAlreadyEntered = true;
            logger.info(`[playwright.agent] turn-loop: text already in compose box (OCR wordRatio=${_wordRatio.toFixed(2)}) — setting textAlreadyEntered=true, will NOT re-type`);
          }
        }
      }
    }

    // ── OCR-triggered type (just type + OCR verify, no focus-finding) ──
    // If OCR shows compose modal text, just keyboard.type into whatever has focus
    // (compose URLs auto-focus the compose box). Then OCR verify.
    if (_ocrText && !textAlreadyEntered && extractedText &&
        /create a post|what do you want to talk about|compose|share a post|what's on your mind/i.test(_ocrText)) {
      logger.info(`[playwright.agent] turn-loop: OCR shows compose modal — typing into focused element`);
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const _clearMod = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
        await _ePage.keyboard.press(_clearMod).catch(() => {});
        await _ePage.keyboard.press('Delete').catch(() => {});
        await _ePage.keyboard.type(extractedText, { delay: 5 });
        await _ePage.waitForTimeout(1000);
        // Verify via OCR
        const _typeTs = Date.now();
        const _ocrResult = await _ocrVerify(extractedText, _typeTs, _ePage);
        if (_ocrResult.verified) {
          logger.info(`[playwright.agent] turn-loop: text typed + verified via OCR (source=${_ocrResult.source}) — next turn will click Post`);
          textAlreadyEntered = true;
          _loopTranscript.push({ step: turn, action: { action: 'type', text: extractedText.slice(0, 80) + '...' }, outcome: { ok: true }, thoughts: `OCR-triggered type verified via OCR (${_ocrResult.source})` });
        } else {
          logger.warn(`[playwright.agent] turn-loop: text typed but not verified via OCR — will let LLM handle`);
        }
      }
    }

    // Build action history summary (last 5 actions) — enriched with
    // selector/text/label details so the LLM has better context about what
    // was actually done (e.g. "reactFill([role='textbox']) text='Lecrae' -> ok"
    // instead of just "reactFill -> ok").
    const _recentActions = _loopTranscript.slice(-5).map((t, i) => {
      const a = t.action?.action || 'unknown';
      const ok = t.outcome?.ok ? 'ok' : 'FAIL';
      const err = t.outcome?.error ? ` (${t.outcome.error.slice(0, 60)})` : '';
      const sel = t.action?.selector || t.action?.text || t.action?.label || t.action?.url || '';
      const selStr = sel ? `(${String(sel).slice(0, 40)})` : '';
      return `${i + 1}. ${a}${selStr ? ' ' + selStr : ''} -> ${ok}${err}`;
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
      .replace(/^.*?Open [A-Z][A-Za-z]+\b[^.]*\.\s*/i, '')
      .replace(/^.*?Go to [A-Z][A-Za-z]+\b[^.]*\.\s*/i, '')
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
        if (_lastWithCompose && _lastWithCompose.composeDetails.length > 0) {
          const _composeEls = _lastWithCompose.composeDetails;
          const _multiCompose = _composeEls.length > 1;
          // Generate hints for EACH compose element, labeled by distinguishing attribute.
          // When multiple contenteditable elements exist (e.g. title H1 + body DIV),
          // generic "[contenteditable='true']" matches the FIRST in document order —
          // which may be the body, not the title. Use placeholder/aria-label/tag-specific
          // selectors to disambiguate.
          for (const c of _composeEls) {
            const _label = c.placeholder || c.ariaLabel || c.role || c.tag;
            if (c.placeholder) _hints.push(`reactFill for "${_label}": { "action": "reactFill", "selector": "[placeholder='${c.placeholder}']", "text": "<TEXT>" }`);
            if (c.ariaLabel) _hints.push(`reactFill for "${_label}": { "action": "reactFill", "selector": "[aria-label='${c.ariaLabel}']", "text": "<TEXT>" }`);
            // Tag-specific selector (e.g. h1[contenteditable]) — more specific than generic
            if (c.ce && c.tag) _hints.push(`reactFill for "${_label}": { "action": "reactFill", "selector": "${c.tag.toLowerCase()}[contenteditable='${c.ce}']", "text": "<TEXT>" }`);
          }
          // Only add generic [contenteditable] if there's just ONE compose element
          if (!_multiCompose) {
            const c = _composeEls[0];
            if (c.ce) _hints.push(`reactFill { "action": "reactFill", "selector": "[contenteditable='${c.ce}']", "text": "<TEXT>" }`);
          }
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
${_subTasks && _subTasks.length > 0 ? _buildSubTaskProgressBlock(_subTasks) : ''}
${agentContext ? `\nAGENT CONTEXT:\n${agentContext}` : ''}
${_onTargetPage ? '\n⚠️ YOU ARE ALREADY ON THE CORRECT PAGE. DO NOT navigate. Start typing or clicking NOW.\n' : ''}
${textAlreadyEntered ? '\n✅ TEXT ALREADY ENTERED via keyboard.type and verified via OCR. Do NOT type again. Just click the submit/Post button NOW.\n' : ''}
${extractedText && !textAlreadyEntered ? `\n📝 TEXT TO TYPE (use this EXACT text in reactFill): "${extractedText}"\n` : ''}
${_probeInfo ? _probeInfo + '\n' : ''}
${_ocrText ? `\nOCR SCREEN CAPTURE (what's actually visible on screen — TRUST THIS over DOM snapshot. If OCR shows a compose modal with "Create a post" or "What do you want to talk about?", the modal IS open even if the DOM says otherwise. Type text into the compose box or click Post.):\n${_ocrText}\n` : ''}
${_domSignals ? `\nDOM STATE SIGNALS (active UI elements + ready-made selectors — use these selectors in clickBySelector/reactFill):\n${_domSignals}\n` : ''}${_searchDisambiguationHint || ''}${_urlDriftHint || ''}${_openMenuHint || ''}
${_heartbeatHistory ? `\nPAGE STATE HISTORY (last ${Math.min(10, heartbeat.buffer.length)} heartbeat ticks, oldest first — use this to see what appeared/disappeared on the page):\n${_heartbeatHistory}\n` : ''}
${_selectorHints}
VISIBLE PAGE TEXT (first 2000 chars):
${_pageText.slice(0, 2000)}

CURRENT SNAPSHOT (ARIA - may not show contenteditable elements):
${_prunedSnap}

${_recentActions ? `RECENT ACTIONS:\n${_recentActions}\n` : ''}
${_lastActionSignature === 'duplicate_noop' ? '\n⚠️ NO-PROGRESS WARNING: Your last action was a no-op (page state unchanged). Try a COMPLETELY different approach — different selector, different action type, or press Enter/Escape to commit/dismiss. Do NOT repeat the same action.\n' : ''}
${_lastActionSignature && _lastActionSignature.startsWith('no_progress:') ? `\n🚫 STUCK WARNING: You have already tried "${_lastActionSignature.slice('no_progress:'.length)}" multiple times with ok=true but the goal is NOT met. The site is likely reverting your change (e.g. the value only commits on Enter/blur) or the element is hidden by a UI mode (compact mode, collapsed section). Try a COMPLETELY different approach: (a) press Enter to commit ({ "action": "press", "key": "Enter" }), (b) click a different element first to focus it, (c) use a different selector, (d) press a keyboard shortcut to toggle the UI mode (e.g. { "action": "press", "key": "Control+Shift+F" } for compact mode), or (e) if the goal is genuinely already met, return done. Do NOT repeat the same action.\n` : ''}
${_lastActionSignature === 'return_rejected' || (_lastActionSignature && _lastActionSignature.startsWith('return_rejected:')) ? `\n❌ RETURN REJECTED: You declared the goal done, but verification found the goal was NOT actually achieved.${_lastActionSignature && _lastActionSignature.startsWith('return_rejected:') ? ` Verification reason: "${_lastActionSignature.slice('return_rejected:'.length)}"` : ' (expected text is missing from the page/title).'} Do NOT return again until you have actually completed the task. Look at the PAGE TEXT, OCR, and DOM STATE SIGNALS above — identify what the verification reason says is missing, then perform the action that actually completes the goal. For example: if you only searched for X but the goal was to add X to Y, you need to perform the add action (e.g. open the item's overflow/.../more-options button on its row and choose "Add to Y"), not just search. If you typed text into the wrong field, close the dialog (press Escape) and try the correct element.\n` : ''}
${_lastActionSignature && _lastActionSignature.startsWith('hidden_element:') ? `\n🔍 HIDDEN ELEMENT: The element "${_lastActionSignature.slice('hidden_element:'.length)}" exists in the DOM but is NOT VISIBLE. It may be hidden by a UI mode (compact mode, collapsed toolbar, minimized section) or by a parent container. Try: (a) press a keyboard shortcut to toggle the UI mode (e.g. { "action": "press", "key": "Control+Shift+F" } for compact mode in many editors), (b) look for a toggle/expand/collapse button in the snapshot and click it to reveal the element, (c) press Ctrl+/ or ? to open the app's keyboard shortcut help overlay to find the right shortcut, or (d) check the OCR — if the expected UI area (e.g. title bar, toolbar section) is missing from the screen, a UI mode is likely hiding it. Also check the APP KNOWLEDGE block above for known shortcuts and UI mode toggles for this app.\n` : ''}
${_lastActionSignature === 'multiple_modals' ? '\n🪟 MULTIPLE DIALOGS OPEN: Several dialogs/menus are on screen at once (e.g. cookie/language/location/privacy on top of the task dialog). The same click keeps being applied to the WRONG dialog. You must FIRST dismiss the irrelevant dialogs — press Escape or click their Cancel/Close/Not now/Done button. Then perform the click inside the correct dialog (e.g. the "Edit details" dialog or the "Add to playlist" dialog). If a clickByText would match several dialogs, use clickBySelector with a ref id from the specific dialog you want, or press Escape to clear the non-goal modals first.\n' : ''}${_lastActionSignature && _lastActionSignature.startsWith('jit_fix:') ? `\n💡 JIT RESEARCH FIX: Web research found this specific fix for the current issue: ${_lastActionSignature.slice('jit_fix:'.length)} — apply this fix now.\n` : ''}
${_formatFailedApproachesBlock()}
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
      // ── Sub-task-aware early exit: if LLM decomposition was used and ALL
      // sub-tasks are marked completed via strict verification, accept the
      // return without falling through to the fragile regex-based verification.
      if (_subTasks && _subTasks.length > 0 && _subTasks.every(s => s.completed)) {
        logger.info(`[playwright.agent] turn-loop: return accepted at turn ${turn} — all ${_subTasks.length} sub-tasks verified complete`);
        return {
          ok: true,
          routingDecision: 'turn_loop_subtask_complete',
          result: _result || `All ${_subTasks.length} sub-tasks completed`,
          transcript: _loopTranscript,
          sessionId,
        };
      }
      // ── 3-gate structural verification for incomplete sub-tasks ────────
      // If sub-tasks exist but not all are marked completed, re-check incomplete
      // sub-tasks using the 3-gate structural verification (action transcript +
      // container check + LLM). This catches cases where the strict per-turn
      // check missed a completion (e.g., verification criteria checked
      // intermediate states).
      if (_subTasks && _subTasks.length > 0) {
        const _incomplete = _subTasks.filter(s => !s.completed);
        if (_incomplete.length > 0) {
          let _structPageText = '';
          let _structPageUrl = '';
          let _structPage = null;
          try {
            _structPage = engine.getPage(sessionId);
            if (_structPage) {
              _structPageText = await _structPage.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
              try { _structPageUrl = _structPage.url(); } catch (_) {}
            }
          } catch (_) {}
          let _structPassed = 0;
          const _structDetails = [];
          for (const _st of _incomplete) {
            const _sv = await _structuralVerifySubTask(_st, {
              page: _structPage, pageUrl: _structPageUrl, pageText: _structPageText,
              transcript: _loopTranscript, sessionId,
            });
            if (_sv.verified) {
              _st.completed = true;
              _structPassed++;
              _structDetails.push(`#${_st.id} verified via ${_sv.gate}: ${_sv.reason}`);
            } else {
              _structDetails.push(`#${_st.id} NOT verified (${_sv.gate}): ${_sv.reason}`);
            }
          }
          logger.info(`[playwright.agent] turn-loop: structural re-check — ${_structPassed}/${_incomplete.length} incomplete sub-tasks now verified. Details: ${_structDetails.join('; ')}`);
          // If ALL sub-tasks are now completed, accept the return
          if (_subTasks.every(s => s.completed)) {
            logger.info(`[playwright.agent] turn-loop: return accepted at turn ${turn} — all ${_subTasks.length} sub-tasks verified (structural re-check passed)`);
            return {
              ok: true,
              routingDecision: 'turn_loop_subtask_complete_structural',
              result: _result || `All ${_subTasks.length} sub-tasks completed (structural verification)`,
              transcript: _loopTranscript,
              sessionId,
            };
          }
          // Not all sub-tasks verified — reject the return and continue the loop
          const _stillIncomplete = _subTasks.filter(s => !s.completed).map(s => `#${s.id} ${s.description}`);
          logger.warn(`[playwright.agent] turn-loop: return REJECTED at turn ${turn} — ${_stillIncomplete.length} sub-tasks not verified: ${_stillIncomplete.join(', ')} — continuing loop`);
          _loopTranscript.push({
            action: { jit_research: `Goal verification: sub-tasks not yet verified: ${_stillIncomplete.join('; ')}. Focus on completing these.` },
            outcome: { ok: true, note: 'structural verification hint' },
          });
          _lastActionSignature = 'return_rejected';
          if (_result && _result.trim().length > 0) _rejectedReturnData = _result;
          continue;
        }
      }
      // F7d: Verify the goal was actually achieved before accepting the LLM's
      // self-declared "done". The LLM may declare done based on per-step ok=true
      // even when the goal wasn't met (e.g. typed the title into the wrong field).
      // Same _verifyGoalCompletion helper as Plan-Execute (F7c): Tier-1 DOM phrase
      // check (location-aware) → Tier-2 VLM. On fail, reject the return and push
      // a transcript note so the loop continues with a hint.
      let _returnVerify = null;
      try {
        // For send/submit goals, use unified action verification (B>D>A>C)
        const _isSendSubmitGoal = /\b(send|post|submit|publish|dispatch|email|tweet|share|reply|comment)\b/i.test(goal);
        if (_isSendSubmitGoal) {
          const _expectedText = (goal.match(/(?:saying|message|body|content)\s+["']?([^"'.\n]+)["']?/i) || [])[1] ||
            (goal.match(/["']([^"']{5,})["']/) || [])[1] || '';
          _returnVerify = await _verifyActionCompletion({
            goal: verificationGoal || goal, sessionId, headed, pageType: undefined,
            submitClickTs: null, expectedText: _expectedText, isSendSubmitGoal: true,
          });
          if (!_returnVerify) {
            _returnVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _loopTranscript });
          }
        } else {
          _returnVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _loopTranscript });
        }
      } catch (_rvErr) {
        logger.warn(`[playwright.agent] turn-loop: return verification error (non-fatal): ${_rvErr.message}`);
      }
      if (_returnVerify && !_returnVerify.pass && _returnVerify.source !== 'inconclusive') {
        // Deterministic fail — reject the return and keep looping with a hint.
        const _missing = _returnVerify.missingPhrases.length > 0 ? ` Missing phrases: ${_returnVerify.missingPhrases.join(', ')}` : '';
        logger.warn(`[playwright.agent] turn-loop: return REJECTED at turn ${turn} — goal verification failed (${_returnVerify.source}): ${_returnVerify.reason}.${_missing} — continuing loop`);
        // Stash the rejected return data — it often contains the extracted
        // content the user wants. If the pre-exhaustion check later passes,
        // this is preferred over a generic "Goal verified" string so the data
        // flows downstream to synthesize instead of being lost.
        if (_result && _result.trim().length > 0) {
          _rejectedReturnData = _result;
        }
        _loopTranscript.push({
          action: { action: 'return', data: _result },
          outcome: { ok: false, error: `goal not yet met — ${_returnVerify.reason}${_missing}` },
          thoughts: `return rejected: ${_returnVerify.reason}`,
        });
        // Inject a hard hint for the next turn so the LLM doesn't just re-return.
        // Carry the verification reason so the hint can tell the LLM *what* it did
        // wrong (e.g. "only searched, didn't add") instead of a generic "not done".
        _lastActionSignature = `return_rejected:${_returnVerify.reason.slice(0, 200)}`;
        continue;
      }
      const _vNote = _returnVerify ? ` verified=${_returnVerify.pass} (${_returnVerify.source})` : ' (verification inconclusive — accepting)';
      logger.info(`[playwright.agent] turn-loop: done at turn ${turn} — result="${_result.slice(0, 100)}"${_vNote}`);
      return {
        ok: true,
        goal,
        sessionId,
        turns: _loopTranscript.length,
        done: true,
        result: _result || 'Completed via turn-loop fallback',
        transcript: _loopTranscript,
        routingDecision: 'turn_loop_fallback',
        goalVerified: _returnVerify?.pass || false,
        executionTime: Date.now() - start,
      };
    }

    // ── Anti-repeat: skip duplicate actions ──
    // Extended to ALL action types, not just navigate/snapshot.
    // If the last action was identical (same action + selector + text + url)
    // and the page state hasn't changed, skip it and inject a hint.
    // IMPORTANT: Blocked duplicates count toward the no-progress bail threshold
    // (_NO_PROGRESS_BAIL_THRESHOLD) so the agent doesn't loop 15× on the same
    // blocked action. Without this, the duplicate detector short-circuits the
    // bail mechanism — the action signature counter at line ~8160 only runs
    // after successful execution, so blocked actions never increment it.
    // After counting, check the threshold: at 3, trigger JIT sub-task
    // discovery + inject hint; at 4, bail to ask_user.
    const _countBlockedDuplicate = (act) => {
      const _sig = `${act.action}|${act.selector || ''}|${act.text || ''}|${act.url || ''}`;
      const _count = (_actionSignatureCounts.get(_sig) || 0) + 1;
      _actionSignatureCounts.set(_sig, _count);
      return _count;
    };
    // Check blocked-duplicate threshold and take action (hint or bail).
    // Returns true if the loop should bail (caller should return).
    const _checkBlockedDuplicateThreshold = async (act, blockedCount) => {
      if (blockedCount >= _NO_PROGRESS_BAIL_THRESHOLD) {
        logger.warn(`[playwright.agent] turn-loop: no-progress bail — blocked action "${act.action}" (${act.selector || act.text || act.url || ''}) repeated ${blockedCount}× — surfacing ask_user`);
        return true; // signal bail
      }
      if (blockedCount >= _NO_PROGRESS_THRESHOLD && !_noProgressHintInjected) {
        _noProgressHintInjected = true;
        _lastActionSignature = `no_progress:${act.action}`;
        logger.warn(`[playwright.agent] turn-loop: no-progress hint — blocked action "${act.action}" repeated ${blockedCount}× — injecting hint`);
        _recordFailedApproach(`turn-loop: ${act.action} repeated ${blockedCount}×`, 'no progress / blocked', '');

        // JIT sub-task discovery for the current sub-task
        if (hostname && _discoverTaskProcedure && _subTasks && _subTasks.length > 0) {
          const _currentST = _subTasks.find(s => !s.completed);
          if (_currentST && !_jitDiscoveryFiredForSubTask.has(_currentST.id)) {
            _jitDiscoveryFiredForSubTask.add(_currentST.id);
            logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery (blocked) — searching for procedure for sub-task #${_currentST.id}: "${_currentST.description.slice(0, 80)}"`);
            const _jitDiscovery = await _discoverTaskProcedure({
              hostname,
              goal: _currentST.description,
              transcript: _loopTranscript,
              sessionId,
              headed,
            }).catch((e) => { logger.warn(`[playwright.agent] turn-loop: JIT sub-task discovery error (non-fatal): ${e.message}`); return null; });
            if (_jitDiscovery?.discovered && _jitDiscovery.procedure) {
              logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery found procedure (sources: ${_jitDiscovery.sourceUrls?.length || 0}, fromCache: ${!!_jitDiscovery.fromCache}) — injecting as hint`);
              _loopTranscript.push({
                action: { jit_subtask_discovery: _jitDiscovery.procedure },
                outcome: { ok: true, hint: `Discovered procedure for sub-task #${_currentST.id}: ${_jitDiscovery.procedure.slice(0, 200)}` },
              });
              const _procSummary = _jitDiscovery.procedure.slice(0, 300);
              _lastActionSignature = `jit_fix:Sub-task procedure discovered — follow these steps:\n${_procSummary}\nKey UI elements: ${(_jitDiscovery.keyUiElements || []).join(', ') || 'n/a'}`;
            } else {
              logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery found no procedure for sub-task #${_currentST.id}`);
            }
          }
        }
      }
      return false; // don't bail
    };
    if (_loopTranscript.length > 0) {
      const _last = _loopTranscript[_loopTranscript.length - 1];
      const _lastSig = JSON.stringify({ a: _last.action?.action, s: _last.action?.selector, t: _last.action?.text, u: _last.action?.url });
      const _curSig = JSON.stringify({ a: _action.action, s: _action.selector, t: _action.text, u: _action.url });

      if (_lastSig === _curSig && _last.outcome?.ok) {
        // For navigate: skip if same URL
        if (_action.action === 'navigate' && _last.action?.url === _action.url) {
          logger.warn(`[playwright.agent] turn-loop: skipping duplicate navigate to ${_action.url} — already done`);
          const _bc = _countBlockedDuplicate(_action);
          if (await _checkBlockedDuplicateThreshold(_action, _bc)) {
            return { ok: false, goal, sessionId, turns: _loopTranscript.length, done: false, result: `Turn-loop stalled: blocked navigate to "${_action.url}" repeated ${_bc}×.`, transcript: _loopTranscript, error: 'turn_loop_no_progress', routingDecision: 'turn_loop_fallback', executionTime: Date.now() - start };
          }
          _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate navigate' } });
          continue;
        }
        // For snapshot: skip if last was also snapshot
        if (_action.action === 'snapshot') {
          logger.warn(`[playwright.agent] turn-loop: skipping duplicate snapshot`);
          const _bc = _countBlockedDuplicate(_action);
          if (await _checkBlockedDuplicateThreshold(_action, _bc)) {
            return { ok: false, goal, sessionId, turns: _loopTranscript.length, done: false, result: `Turn-loop stalled: blocked snapshot repeated ${_bc}×.`, transcript: _loopTranscript, error: 'turn_loop_no_progress', routingDecision: 'turn_loop_fallback', executionTime: Date.now() - start };
          }
          _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate snapshot' } });
          continue;
        }
        // For all other actions: check if page state changed since last action
        // If state is unchanged, the action was a no-op — skip and inject hint
        let _currentStateHash = null;
        try {
          const _ePage = engine.getPage(sessionId);
          if (_ePage) {
            _currentStateHash = await _ePage.evaluate(() => (document.body?.innerText || '').length + ':' + (document.body?.innerText || '').slice(0, 200)).catch(() => null);
          }
        } catch (_) {}
        if (_lastStateHash && _currentStateHash && _lastStateHash === _currentStateHash) {
          logger.warn(`[playwright.agent] turn-loop: skipping duplicate ${_action.action} (identical action + unchanged page state) — inject hint to try different approach`);
          const _bc = _countBlockedDuplicate(_action);
          if (await _checkBlockedDuplicateThreshold(_action, _bc)) {
            return { ok: false, goal, sessionId, turns: _loopTranscript.length, done: false, result: `Turn-loop stalled: action "${_action.action}" (${_action.selector || _action.text || _action.url || ''}) blocked ${_bc}× with unchanged page state.`, transcript: _loopTranscript, error: 'turn_loop_no_progress', routingDecision: 'turn_loop_fallback', executionTime: Date.now() - start };
          }
          _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate — page state unchanged, try a different approach or return done' } });
          // Inject hint into next turn by modifying the goal temporarily
          _lastActionSignature = 'duplicate_noop';
          _recordFailedApproach(`turn-loop: ${_action.action}(${_action.selector || _action.text || _action.url || ''})`, 'duplicate no-op / page unchanged', '');
          continue;
        }
      }
    }

    // ── Anti-repeat for type/fill/reactFill: same text, different selector ──
    // The exact-match check above compares selector strings, so the same text typed
    // via a different selector (e.g. `div[contenteditable='true']` vs
    // `[role='dialog'] div[contenteditable='true']`) bypasses it. This catches that
    // case by comparing the TEXT only — re-typing the same text into a different
    // selector for the same compose element is a no-op that causes triple-typing.
    if (['type', 'fill', 'reactFill'].includes(_action.action) && _action.text) {
      const _lastTypeFill = [..._loopTranscript].reverse().find(t =>
        t.outcome?.ok && ['type', 'fill', 'reactFill'].includes(t.action?.action) &&
        t.action?.text === _action.text
      );
      if (_lastTypeFill) {
        logger.warn(`[playwright.agent] turn-loop: skipping duplicate ${_action.action} (same text "${(_action.text || '').slice(0, 40)}..." already typed via ${_lastTypeFill.action?.selector || 'n/a'}) — inject hint`);
        const _bc = _countBlockedDuplicate(_action);
        if (await _checkBlockedDuplicateThreshold(_action, _bc)) {
          return { ok: false, goal, sessionId, turns: _loopTranscript.length, done: false, result: `Turn-loop stalled: action "${_action.action}" (text="${_action.text || ''}") blocked ${_bc}× — same text already typed via different selector.`, transcript: _loopTranscript, error: 'turn_loop_no_progress', routingDecision: 'turn_loop_fallback', executionTime: Date.now() - start };
        }
        _loopTranscript.push({ action: _action, outcome: { ok: false, error: 'skipped duplicate type/fill — same text already entered via different selector' } });
        _lastActionSignature = 'duplicate_noop';
        _recordFailedApproach(`turn-loop: ${_action.action} text="${(_action.text || '').slice(0, 40)}"`, 'duplicate type/fill — same text already entered', '');
        continue;
      }
    }

    // ── Execute the action ──
    // If the action is clickByText and an open menu was detected, inject menuScope
    // so clickByText scopes candidates to the open menu container. This prevents
    // clicking sidebar/header elements when the intended target is a menu item.
    // NOTE: The menu guard was removed — it caused false positives on form dialogs
    // (e.g., Spotify's "Edit details" dialog with name/description inputs was
    // detected as a menu, blocking reactFill/fill). The open-menu hint in the
    // prompt + menuScope injection are sufficient to guide the agent.
    let _outcome;
    // Capture state before action for state-change detection (turn-loop → Tab-Flow re-entry)
    let _preActionState = null;
    try {
      const _prePage = engine.getPage(sessionId);
      if (_prePage) {
        _preActionState = await _prePage.evaluate(() => ({
          url: window.location.href,
          bodyLen: (document.body.innerText || '').length,
          modalCount: document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').length,
        })).catch(() => null);
      }
    } catch (_) {}
    try {
      const _execAction = { ..._action, sessionId, headed, timeoutMs };
      if (_action.action === 'clickByText' && _activeMenuScope && !_action.scope && !_action.menuScope) {
        // Only scope the click to the active menu if the target text actually
        // looks like a menu item. If the agent is trying to click a button in a
        // different dialog (e.g. "Save" in the "Edit details" dialog while a
        // cookie/language menu is also open), forcing scope to the active menu
        // will click the wrong "Save" and loop forever.
        const _clickText = (_action.text || '').toLowerCase().trim();
        const _matchesMenuItem = _activeMenuItems.some(i => i.toLowerCase().includes(_clickText) || _clickText.includes(i.toLowerCase()));
        if (_matchesMenuItem) {
          _execAction.menuScope = _activeMenuScope;
          logger.info(`[playwright.agent] turn-loop: injecting menuScope="${_activeMenuScope}" into clickByText("${_action.text}") because it matches an active menu item`);
        } else if (_openMenus.length > 1) {
          logger.warn(`[playwright.agent] turn-loop: clickByText("${_action.text}") does NOT match active menu items (${_activeMenuItems.join(', ')}) and ${_openMenus.length} dialogs are open — leaving unscoped so it can target the correct dialog`);
        }
      }
      _outcome = await browserAct(_execAction);
    } catch (_execErr) {
      _outcome = { ok: false, error: _execErr.message };
    }

    _loopTranscript.push({ action: _action, outcome: _outcome, verified: _outcome.verified });

    // ── Slash-command settle: after pressing Enter to confirm a slash command ──
    // (e.g. "/todo" in Notion), the app unmounts the slash-menu popup and remounts a
    // new contenteditable block. If the next step types immediately, the first
    // character can be dropped. Detect the pattern: previous action was type/fill/
    // reactFill with text starting with "/", current action is press Enter.
    if (_outcome.ok && _action.action === 'press' && String(_action.key).toLowerCase() === 'enter') {
      const _prev = _loopTranscript[_loopTranscript.length - 2];
      if (_prev && _prev.outcome?.ok && ['type', 'fill', 'reactFill'].includes(_prev.action?.action)) {
        const _prevText = _prev.action?.text || '';
        if (_prevText.trim().startsWith('/')) {
          logger.info(`[playwright.agent] turn-loop: slash-command detected ("${_prevText.trim().slice(0, 20)}" + Enter) — waiting for block to settle`);
          await _waitForSlashCommandSettled(sessionId, headed);
        }
      }
    }

    // ── Cross-transcript no-progress detection ──
    // Count this action signature across the whole transcript (only ok=true attempts
    // count — failures are already handled by the actionFailed OCR trigger). When the
    // same action repeats ≥3× without the goal being met, inject a hard hint; at 4×,
    // bail to ask_user instead of burning the remaining turns. This catches the
    // failure mode where reactFill reports verified=true but the framework reverts the
    // value (Google Docs rename) and the loop spins 14× on the identical no-op.
    if (_outcome.ok && _action.action !== 'return' && _action.action !== 'snapshot' &&
        _action.action !== 'getPageText' && _action.action !== 'waitForStableText' &&
        _action.action !== 'waitForSelector' && _action.action !== 'waitForContent') {
      const _sig = `${_action.action}|${_action.selector || ''}|${_action.text || ''}|${_action.url || ''}`;
      const _count = (_actionSignatureCounts.get(_sig) || 0) + 1;
      _actionSignatureCounts.set(_sig, _count);
      if (_count >= _NO_PROGRESS_BAIL_THRESHOLD) {
        logger.warn(`[playwright.agent] turn-loop: no-progress bail — action "${_action.action}" repeated ${_count}× without completing the goal — surfacing ask_user`);
        return {
          ok: false,
          goal,
          sessionId,
          turns: _loopTranscript.length,
          done: false,
          result: `Turn-loop stalled: action "${_action.action}" (${_action.selector || _action.text || _action.url || ''}) repeated ${_count}× without completing the goal. The site may require a different commit mechanism (e.g. Enter/blur) or the element may not be interactable.`,
          transcript: _loopTranscript,
          error: 'turn_loop_no_progress',
          routingDecision: 'turn_loop_fallback',
          executionTime: Date.now() - start,
        };
      }
      if (_count >= _NO_PROGRESS_THRESHOLD && !_noProgressHintInjected) {
        logger.warn(`[playwright.agent] turn-loop: no-progress hint — action "${_action.action}" repeated ${_count}× with ok=true but goal not met — injecting hard hint`);
        _noProgressHintInjected = true;
        // If the repeated action is a fill/reactFill on a specific selector, the
        // element is likely hidden (fill "succeeds" via native setter but the
        // value isn't visible/committed because the element is hidden by a UI
        // mode). Use the hidden_element hint instead of the generic no_progress
        // hint — it tells the LLM to try keyboard shortcuts / toggles to reveal.
        if ((_action.action === 'reactFill' || _action.action === 'fill') && _action.selector) {
          _lastActionSignature = `hidden_element:${_action.selector}`;
          logger.info(`[playwright.agent] turn-loop: reactFill repeated ${_count}× on "${_action.selector}" with ok=true but goal not met — element likely hidden, injecting hidden-element hint`);
        } else if (_openMenus.length > 1 && /click/.test(_action.action)) {
          // Multiple overlapping dialogs and the same click is going nowhere —
          // the agent is likely clicking inside the wrong dialog. Tell it to
          // dismiss non-goal modals and scope the next click to the correct one.
          _lastActionSignature = 'multiple_modals';
          logger.info(`[playwright.agent] turn-loop: ${_openMenus.length} open dialogs and click repeated ${_count}× — injecting multiple-modals hint`);
        } else {
          // Inject hint into next turn via _lastActionSignature (read by the goal builder below)
          _lastActionSignature = `no_progress:${_action.action}`;
          _recordFailedApproach(`turn-loop: ${_action.action}(${_action.selector || _action.text || ''})`, 'no progress / stuck', '');
        }

        // Just-in-time app-knowledge research: the agent is stuck — search for
        // how to resolve this specific issue. If a fix is found, inject it as
        // an additional hint for the next turn.
        // SKIP for UI click actions (clickByText, click, clickBySelector) — web research
        // won't help with UI element visibility issues, and wastes ~10s per crawl.
        if (hostname && _justInTimeResearch && !/clickByText|clickBySelector|^click$/.test(_action.action)) {
          const _jitFix = await _justInTimeResearch({
            hostname,
            field: _action.selector || _action.action || 'goal',
            goal,
            failureContext: `Action "${_action.action}" (selector="${_action.selector || ''}", text="${_action.text || ''}") repeated ${_count}× with ok=true but goal not met. The element may be hidden, require a commit mechanism (Enter/blur), or need a UI toggle to reveal.`,
            sessionId,
          }).catch((_err) => { logger.warn(`[playwright.agent] turn-loop: JIT research error (non-fatal): ${_err.message}`); return null; });
          if (_jitFix?.action) {
            _loopTranscript.push({
              action: { jit_research: _jitFix.action },
              outcome: { ok: true, hint: `JIT research suggests: ${_jitFix.action}` },
            });
            // Inject the JIT fix as a stronger hint — overrides the generic no_progress hint
            _lastActionSignature = `jit_fix:${_jitFix.action}`;
            logger.info(`[playwright.agent] turn-loop: JIT research found fix — injecting as hint: ${_jitFix.action}`);
          }
        }

        // ── JIT sub-task discovery: search for a how-to procedure for the
        // CURRENT sub-task only (not the whole goal). More targeted than
        // on-exhaust discovery, fires at 3 stuck attempts instead of 15
        // exhausted turns. Only fires once per sub-task ID.
        if (hostname && _discoverTaskProcedure && _subTasks && _subTasks.length > 0) {
          const _currentST = _subTasks.find(s => !s.completed);
          if (_currentST && !_jitDiscoveryFiredForSubTask.has(_currentST.id)) {
            _jitDiscoveryFiredForSubTask.add(_currentST.id);
            logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery — searching for procedure for sub-task #${_currentST.id}: "${_currentST.description.slice(0, 80)}"`);
            const _jitDiscovery = await _discoverTaskProcedure({
              hostname,
              goal: _currentST.description,
              transcript: _loopTranscript,
              sessionId,
              headed,
            }).catch((e) => { logger.warn(`[playwright.agent] turn-loop: JIT sub-task discovery error (non-fatal): ${e.message}`); return null; });
            if (_jitDiscovery?.discovered && _jitDiscovery.procedure) {
              logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery found procedure (sources: ${_jitDiscovery.sourceUrls?.length || 0}, fromCache: ${!!_jitDiscovery.fromCache}) — injecting as hint`);
              _loopTranscript.push({
                action: { jit_subtask_discovery: _jitDiscovery.procedure },
                outcome: { ok: true, hint: `Discovered procedure for sub-task #${_currentST.id}: ${_jitDiscovery.procedure.slice(0, 200)}` },
              });
              // Inject as a strong hint — overrides the generic no_progress / hidden_element hint
              const _procSummary = _jitDiscovery.procedure.slice(0, 300);
              _lastActionSignature = `jit_fix:Sub-task procedure discovered — follow these steps:\n${_procSummary}\nKey UI elements: ${(_jitDiscovery.keyUiElements || []).join(', ') || 'n/a'}`;
            } else {
              logger.info(`[playwright.agent] turn-loop: JIT sub-task discovery found no procedure for sub-task #${_currentST.id}`);
            }
          }
        }
      }
    }

    if (!_outcome.ok) {
      logger.warn(`[playwright.agent] turn-loop: action ${_action.action} failed at turn ${turn}: ${_outcome.error}`);
      // Hidden-element detection: when an action fails with "not visible" or a
      // visibility-related error, the element exists in the DOM but is hidden by
      // a UI mode (compact mode, collapsed toolbar, minimized section). Flag it
      // so the next turn injects a hidden-element hint telling the LLM to try
      // keyboard shortcuts or toggle buttons to reveal it.
      if (_outcome.error && /not visible|hidden|display.*none|visibility|not interactable|element.*not.*stable/i.test(_outcome.error)) {
        const _hiddenSel = _action.selector || _action.action;
        _lastActionSignature = `hidden_element:${_hiddenSel}`;
        logger.info(`[playwright.agent] turn-loop: hidden-element detected — element "${_hiddenSel}" not visible (likely hidden by UI mode) — will inject hint next turn`);

        // Just-in-time app-knowledge research: the element is hidden — search for
        // how to reveal/locate it. Detect element type from the action and selector.
        // SKIP for clickByText/clickBySelector — web research won't help with UI
        // element visibility issues, and wastes ~10s per crawl.
        if (hostname && _justInTimeResearch && !_noProgressHintInjected && !/clickByText|clickBySelector/.test(_action.action)) {
          const _sel = _action.selector || '';
          const _elementType = (() => {
            if (/select|dropdown|combobox|listbox/i.test(_sel)) return 'dropdown';
            if (/menu|menubar|menuitem/i.test(_sel)) return 'menu';
            if (/button|btn|submit|send|post|save|click/i.test(_sel) || _action.action === 'click') return 'button';
            if (/toggle|switch|checkbox|radio/i.test(_sel)) return 'toggle';
            return 'element';
          })();
          const _jitFix = await _justInTimeResearch({
            hostname,
            field: _hiddenSel,
            elementType: _elementType,
            goal,
            failureContext: `Action "${_action.action}" on selector "${_hiddenSel}" failed: ${_outcome.error}. The element exists in the DOM but is not visible/interactable — it may be hidden by a UI mode (compact mode, collapsed toolbar) or require a specific action to reveal.`,
            sessionId,
          }).catch((_err) => { logger.warn(`[playwright.agent] turn-loop: JIT research error (non-fatal): ${_err.message}`); return null; });
          if (_jitFix?.action) {
            _loopTranscript.push({
              action: { jit_research: _jitFix.action },
              outcome: { ok: true, hint: `JIT research suggests: ${_jitFix.action}` },
            });
            _lastActionSignature = `jit_fix:${_jitFix.action}`;
            _noProgressHintInjected = true; // prevent duplicate JIT research on next turn
            logger.info(`[playwright.agent] turn-loop: JIT research found fix for hidden ${_elementType} — injecting as hint: ${_jitFix.action}`);
          }
        }
      }
      // Continue to next turn — the loop will reassess from a fresh snapshot
    } else {
      // Surface verified status — ok && !verified means "unconfirmed", not "succeeded"
      if (_outcome.verified === false) {
        logger.info(`[playwright.agent] turn-loop: action ${_action.action} unconfirmed at turn ${turn} (ok but verified=false) — goal may already be met`);
      } else {
        logger.info(`[playwright.agent] turn-loop: action ${_action.action} succeeded at turn ${turn}`);
      }
      // Track state hash for duplicate detection
      try {
        const _ePage = engine.getPage(sessionId);
        if (_ePage) {
          _lastStateHash = await _ePage.evaluate(() => (document.body?.innerText || '').length + ':' + (document.body?.innerText || '').slice(0, 200)).catch(() => null);
        }
      } catch (_) {}

      // Emit per-turn progress so the frontend shows turn-loop activity
      postProgress(_progressCallbackUrl, {
        type: 'agent:turn',
        stepIndex: _stepIndex,
        turn: turn,
        maxTurns: MAX_TURNS,
        action: _action,
        outcome: _outcome,
        thoughts: '',
      });
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

      // ── State-change detection: return to Tab-Flow on significant state change ──
      // When the turn-loop opens a dialog/modal or navigates (e.g., "Show key" dialog),
      // return to Tab-Flow so Tab-Map can scan the new state and execute the next
      // flow step. The turn-loop is a recovery mechanism — once it gets the page
      // into a new state, Tab-Flow should take over for deterministic execution.
      if (_outcome.ok && _domMutating && _preActionState && turn >= 2) {
        try {
          const _postPage = engine.getPage(sessionId);
          if (_postPage) {
            const _postState = await _postPage.evaluate(() => ({
              url: window.location.href,
              bodyLen: (document.body.innerText || '').length,
              modalCount: document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').length,
            })).catch(() => null);
            if (_postState) {
              const _urlChanged = _postState.url !== _preActionState.url;
              const _modalChanged = _postState.modalCount !== _preActionState.modalCount;
              const _bodyChanged = Math.abs((_postState.bodyLen || 0) - (_preActionState.bodyLen || 0)) > 200;
              // Only return to Tab-Flow if a modal OPENED (not closed) or URL changed
              // — modal closing is just dismissing something, not progress.
              const _modalOpened = _postState.modalCount > _preActionState.modalCount;
              if ((_modalOpened || _urlChanged) && (_modalChanged || _bodyChanged || _urlChanged)) {
                logger.info(`[playwright.agent] turn-loop: state changed after ${_action.action} (url=${_urlChanged}, modal=${_preActionState.modalCount}→${_postState.modalCount}, body=${_preActionState.bodyLen}→${_postState.bodyLen}) — returning to Tab-Flow for re-scan`);
                return {
                  ok: false, stateChanged: true, resumeTabFlow: true,
                  goal, sessionId, transcript: _loopTranscript,
                  result: `State changed during turn-loop — returning to Tab-Flow`,
                  error: 'state_changed_resume_tabflow',
                  routingDecision: 'turn_loop_state_changed',
                };
              }
            }
          }
        } catch (_) {}
      }

      // ── Sub-task completion check after each turn ──
      // After DOM-mutating actions, check if any incomplete sub-tasks are now
      // verified via their strict verification criteria. This provides early
      // exit when all sub-tasks are done (without waiting for LLM 'return').
      if (_subTasks && _subTasks.length > 0 && _domMutating) {
        try {
          const _stPage = engine.getPage(sessionId);
          if (_stPage) {
            let _stUrl = '';
            try { _stUrl = _stPage.url(); } catch (_) {}
            const _stText = await _stPage.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
            let _newlyCompleted = 0;
            for (const _st of _subTasks) {
              if (!_st.completed) {
                const _done = await _checkSubTaskCompletion(_st, _stPage, _stUrl, _stText);
                if (_done) { _st.completed = true; _newlyCompleted++; }
              }
            }
            if (_newlyCompleted > 0) {
              logger.info(`[playwright.agent] turn-loop: ${_newlyCompleted} sub-task(s) newly completed at turn ${turn} (${_subTasks.filter(s => s.completed).length}/${_subTasks.length} total)`);
            }
            // Early exit: if ALL sub-tasks are completed, return success
            if (_subTasks.every(s => s.completed)) {
              logger.info(`[playwright.agent] turn-loop: all ${_subTasks.length} sub-tasks completed at turn ${turn} — exiting loop early`);
              return {
                ok: true,
                routingDecision: 'turn_loop_subtask_complete_early',
                result: _stText.slice(0, 2000) || `All ${_subTasks.length} sub-tasks completed`,
                transcript: _loopTranscript,
                sessionId,
              };
            }
          }
        } catch (_) {}
      }
    }
  }

  // Max turns reached — run a pre-exhaustion completion check before declaring failure.
  // The goal may already be satisfied (e.g., text was typed but the LLM never emitted
  // a 'return' action). Use the location-aware _verifyGoalCompletion first (same as
  // the return-check), then fall back to the relaxed body.innerText check only if
  // location-aware was inconclusive (e.g. no titled phrases, no title input found).
  logger.warn(`[playwright.agent] turn-loop: reached max turns (${MAX_TURNS}) — running pre-exhaustion completion check`);
  // ── Sub-task-aware pre-exhaustion: if all sub-tasks are completed (either
  // via strict per-turn checks or via 3-gate structural verification), exit
  // successfully without needing the regex-based verification.
  if (_subTasks && _subTasks.length > 0) {
    // Run structural verification on any incomplete sub-tasks
    const _incompletePre = _subTasks.filter(s => !s.completed);
    if (_incompletePre.length > 0) {
      let _preStructPage = null;
      let _preStructText = '';
      let _preStructUrl = '';
      try {
        _preStructPage = engine.getPage(sessionId);
        if (_preStructPage) {
          _preStructText = await _preStructPage.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
          try { _preStructUrl = _preStructPage.url(); } catch (_) {}
        }
      } catch (_) {}
      let _preStructPassed = 0;
      const _preStructDetails = [];
      for (const _st of _incompletePre) {
        const _sv = await _structuralVerifySubTask(_st, {
          page: _preStructPage, pageUrl: _preStructUrl, pageText: _preStructText,
          transcript: _loopTranscript, sessionId,
        });
        if (_sv.verified) {
          _st.completed = true;
          _preStructPassed++;
          _preStructDetails.push(`#${_st.id} verified via ${_sv.gate}: ${_sv.reason}`);
        } else {
          _preStructDetails.push(`#${_st.id} NOT verified (${_sv.gate}): ${_sv.reason}`);
        }
      }
      logger.info(`[playwright.agent] turn-loop: pre-exhaustion structural re-check — ${_preStructPassed}/${_incompletePre.length} incomplete sub-tasks now verified. Details: ${_preStructDetails.join('; ')}`);
    }
    // All complete?
    if (_subTasks.every(s => s.completed)) {
      logger.info(`[playwright.agent] turn-loop: pre-exhaustion check — all ${_subTasks.length} sub-tasks verified complete`);
      let _stPageText = '';
      try {
        const _ePage = engine.getPage(sessionId);
        if (_ePage) _stPageText = await _ePage.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
      } catch (_) {}
      return {
        ok: true,
        goal,
        sessionId,
        routingDecision: 'turn_loop_subtask_complete_pre_exhaustion',
        result: _stPageText || `All ${_subTasks.length} sub-tasks completed`,
        transcript: _loopTranscript,
      };
    }
    // Not all sub-tasks verified — log what's missing and fall through to
    // the regex-based verification as a last resort.
    const _stillIncompletePre = _subTasks.filter(s => !s.completed).map(s => `#${s.id} ${s.description}`);
    logger.warn(`[playwright.agent] turn-loop: pre-exhaustion — ${_stillIncompletePre.length} sub-tasks NOT verified: ${_stillIncompletePre.join(', ')} — falling through to regex verification`);
  }
  try {
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      // ── Tier 1: Location-aware verification (same as return-check) ──
      // This catches false positives where the goal phrase appears in the wrong
      // location (e.g. "Weekly Goals" typed into the body instead of the title).
      let _preExhaustionVerify = null;
      try {
        // For send/submit goals, use unified action verification (B>D>A>C)
        const _isSendSubmitGoal = /\b(send|post|submit|publish|dispatch|email|tweet|share|reply|comment)\b/i.test(goal);
        if (_isSendSubmitGoal) {
          const _expectedText = (goal.match(/(?:saying|message|body|content)\s+["']?([^"'.\n]+)["']?/i) || [])[1] ||
            (goal.match(/["']([^"']{5,})["']/) || [])[1] || '';
          _preExhaustionVerify = await _verifyActionCompletion({
            goal: verificationGoal || goal, sessionId, headed, pageType: undefined,
            submitClickTs: null, expectedText: _expectedText, isSendSubmitGoal: true,
          });
          if (!_preExhaustionVerify) {
            _preExhaustionVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _loopTranscript });
          }
        } else {
          _preExhaustionVerify = await _verifyGoalCompletion({ goal: verificationGoal || goal, sessionId, headed, pageType: undefined, transcript: _loopTranscript });
        }
      } catch (_veErr) {
        logger.warn(`[playwright.agent] turn-loop: pre-exhaustion location-aware check error (non-fatal): ${_veErr.message}`);
      }
      if (_preExhaustionVerify && _preExhaustionVerify.pass) {
        logger.info(`[playwright.agent] turn-loop: pre-exhaustion check PASSED (location-aware: ${_preExhaustionVerify.source}) — goal verified`);
        // Capture actual page content so it flows downstream to synthesize
        // instead of returning a generic "Goal verified" string with no data.
        // Priority: fresh page text > rejected return data > generic string.
        let _preExhaustionPageText = '';
        try {
          _preExhaustionPageText = await _ePage.evaluate(() => document.body.innerText.slice(0, 5000)).catch(() => '');
        } catch (_) {}
        const _preExhaustionResult = (_preExhaustionPageText && _preExhaustionPageText.trim().length > 0)
          ? _preExhaustionPageText
          : (_rejectedReturnData || `Goal verified via location-aware check (${_preExhaustionVerify.source}).`);
        return {
          ok: true,
          goal,
          sessionId,
          turns: _loopTranscript.length,
          done: true,
          result: _preExhaustionResult,
          transcript: _loopTranscript,
          routingDecision: 'turn_loop_pre_exhaustion_pass',
          goalVerified: true,
          executionTime: Date.now() - start,
        };
      }
      logger.info(`[playwright.agent] turn-loop: pre-exhaustion location-aware check: ${_preExhaustionVerify ? `FAIL (${_preExhaustionVerify.source}: ${_preExhaustionVerify.reason})` : 'inconclusive'} — trying relaxed body text check`);

      // ── Tier 2: Relaxed body.innerText check (fallback) ──
      // Only used when location-aware was inconclusive (no titled phrases, no title
      // input found on page). Checks if 50%+ of goal phrases appear anywhere in
      // body text — best-effort early-exit for goals without title-targeted phrases.
      if (!_preExhaustionVerify || _preExhaustionVerify.source === 'inconclusive') {
        const _finalPageText = await _ePage.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
        const { phrases: _goalPhrases } = _extractGoalPhrases(verificationGoal || goal);
        if (_goalPhrases.length > 0) {
          const _pageLower = _finalPageText.toLowerCase();
          const _matchedPhrases = _goalPhrases.filter(p => p.length > 2 && _pageLower.includes(p.toLowerCase()));
          const _matchRatio = _matchedPhrases.length / _goalPhrases.length;
          if (_matchRatio >= 0.5) {
            logger.info(`[playwright.agent] turn-loop: pre-exhaustion check PASSED (relaxed) — ${_matchedPhrases.length}/${_goalPhrases.length} goal phrases found in page text (ratio=${_matchRatio.toFixed(2)})`);
            return {
              ok: true,
              goal,
              sessionId,
              turns: _loopTranscript.length,
              done: true,
              result: `Goal appears satisfied — ${_matchedPhrases.length}/${_goalPhrases.length} key phrases found in page text. Page content: ${_finalPageText.slice(0, 500)}`,
              transcript: _loopTranscript,
              routingDecision: 'turn_loop_pre_exhaustion_pass',
              executionTime: Date.now() - start,
            };
          } else {
            logger.info(`[playwright.agent] turn-loop: pre-exhaustion check FAILED — only ${_matchedPhrases.length}/${_goalPhrases.length} goal phrases found (ratio=${_matchRatio.toFixed(2)})`);
          }
        }
      }
    }
  } catch (_checkErr) {
    logger.warn(`[playwright.agent] turn-loop: pre-exhaustion check error (non-fatal): ${_checkErr.message}`);
  }

  logger.warn(`[playwright.agent] turn-loop: exhausted (${MAX_TURNS} turns) without completing the goal`);

  // ── Discovery-on-exhaust: one-shot task-level research + retry ────────────
  // When the turn-loop exhausts on a complex UI site, search the web for how-to
  // articles about the overall goal, crawl top results, LLM-extract a step-by-step
  // procedure, and re-enter the turn-loop with that procedure injected as context.
  // Only fires once (prevented by _discoveryAttempted) — never recurses.
  // SKIP if JIT sub-task discovery already fired for ALL incomplete sub-tasks
  // (those procedures were already injected as hints — a full re-entry with the
  // whole-goal procedure would be redundant). Still fires if JIT didn't fire for
  // any sub-task, or if there are incomplete sub-tasks JIT didn't cover.
  const _incompleteSubTaskIds = _subTasks ? _subTasks.filter(s => !s.completed).map(s => s.id) : [];
  const _allIncompleteAlreadyDiscovered = _incompleteSubTaskIds.length > 0 &&
    _incompleteSubTaskIds.every(id => _jitDiscoveryFiredForSubTask.has(id));
  if (!_discoveryAttempted && hostname && _discoverTaskProcedure && !_allIncompleteAlreadyDiscovered) {
    _discoveryAttempted = true;
    logger.info(`[playwright.agent] turn-loop: exhausted — triggering task-procedure discovery for ${hostname}${_jitDiscoveryFiredForSubTask.size > 0 ? ` (JIT already fired for ${_jitDiscoveryFiredForSubTask.size} sub-task(s), but not all incomplete ones)` : ''}`);
    const _discovery = await _discoverTaskProcedure({
      hostname, goal, transcript: _loopTranscript, sessionId, headed,
    }).catch((e) => { logger.warn(`[playwright.agent] turn-loop: discovery error (non-fatal): ${e.message}`); return null; });

    if (_discovery?.discovered && _discovery.procedure) {
      logger.info(`[playwright.agent] turn-loop: discovery found procedure (sources: ${_discovery.sourceUrls?.length || 0}, fromCache: ${!!_discovery.fromCache}) — re-entering turn-loop with injected knowledge`);
      const _procedureBlock = `\n\n[DISCOVERED PROCEDURE for ${hostname}:\n${_discovery.procedure}\nKey UI elements to look for: ${(_discovery.keyUiElements || []).join(', ') || 'n/a'}\nFollow these steps. Look for the specific UI elements mentioned above.]`;
      const _retryResult = await _executeTurnLoopFallback({
        goal: `${goal}${_procedureBlock}`,
        verificationGoal,
        sessionId, headed, timeoutMs, agentContext,
        transcript: _loopTranscript,
        deadline: Date.now() + 120000,  // FRESH 120s budget — don't inherit consumed deadline
        start: Date.now(),               // fresh start for the retry
        extractedText, heartbeat, textAlreadyEntered,
        maxTurns, hostname,
        _discoveryAlreadyAttempted: true,
        // Pass sub-tasks with completion status so JIT discovery and structural
        // verification continue to work in the re-entered turn-loop. Without this,
        // the re-entered loop has no sub-task structure and can't detect stuck
        // sub-tasks or verify completion.
        _preDecomposedSubTasks: _subTasks,
        _inheritedActionSignatureCounts: _actionSignatureCounts,
        _inheritedJitDiscoveryFired: _jitDiscoveryFiredForSubTask,
        _abortSignal,
      }).catch((e) => { logger.warn(`[playwright.agent] turn-loop: discovery retry error (non-fatal): ${e.message}`); return null; });

      if (_retryResult?.ok) {
        _retryResult.routingDecision = 'turn_loop_discovery_retry_pass';
        _retryResult.discoveryUsed = true;
        _retryResult.discoverySources = _discovery.sourceUrls || [];
        return _retryResult;
      }
      logger.warn(`[playwright.agent] turn-loop: discovery retry also exhausted — surfacing to user with partial progress`);
    } else {
      logger.info(`[playwright.agent] turn-loop: discovery found no procedure — surfacing to user with partial progress`);
    }
  }

  // ── Partial-progress summary (LLM-generated) ──────────────────────────────
  // Before surfacing the failure to the user, ask the LLM to summarize what was
  // completed vs. what remains — so the user can decide whether to "Try to
  // finish" (plan extension) or take another action.
  let _partialProgress = null;
  try {
    _partialProgress = await _summarizePartialProgress({
      goal, transcript: _loopTranscript, sessionId, hostname,
    }).catch((e) => { logger.warn(`[playwright.agent] partial-progress summary error (non-fatal): ${e.message}`); return null; });
  } catch (_) { /* non-fatal */ }

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
    partialProgress: _partialProgress,
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
        // Broadened modal detection — uses generic ARIA + class-based patterns
        const modals = Array.from(document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"], ' +
          '[class*="modal"][class*="share"], [class*="compose"][class*="modal"], ' +
          '[aria-labelledby*="share"], [aria-labelledby*="compose"]'
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
    goal: _rawGoal,
    sessionId             = 'playwright_agent',
    agentId               = sessionId,
    agentContext,
    appKnowledgeEntries,
    maxRepairs            = 2,
    maxTurns              = 8,
    timeoutMs             = 15000,
    headed                = true,
    url,
    recipeWasUsed         = false,
    authConfirmedAt       = null,
    overallTimeoutMs      = 120000,
    _progressCallbackUrl,
    _stepIndex            = 0,
    _abortSignal          = null,
  } = args || {};

  // Abort helper — true when the caller cancelled (user clicked Cancel).
  // Checked at the top of every long loop so the agent stops promptly instead
  // of running on after the HTTP request was destroyed.
  const _aborted = () => !!(_abortSignal && _abortSignal.aborted);

  // ── Strip recovery-anchor preamble from goal ──────────────────────────────
  // browser.agent.cjs:5418 prepends "IMPORTANT: You are working on <url>..." to the
  // task. Without stripping it here, the LLM types the preamble into the first input
  // field it finds (e.g. Spotify search bar). Extract the recovery URL for navigation
  // fallback, then use only the clean task text as `goal` for the rest of the function.
  let _recoveryUrl = null;
  let goal = _rawGoal;
  if (_rawGoal && typeof _rawGoal === 'string') {
    const _preambleMatch = _rawGoal.match(/^IMPORTANT: You are working on (\S+?) \(browser session: .+?\)\..+?\n\nTask:\s*/is);
    if (_preambleMatch) {
      _recoveryUrl = _preambleMatch[1];
      goal = _rawGoal.slice(_preambleMatch[0].length);
      logger.info(`[playwright.agent] stripped recovery preamble from goal — recoveryUrl=${_recoveryUrl}, cleanGoal="${goal.slice(0, 80)}"`);
    }
  }

  // ── LLM goal decomposition pre-check ─────────────────────────────────────
  // Decompose the goal into sub-tasks ONCE, early. This serves two purposes:
  //   1. Multi-step detection: if >1 sub-task, skip the Tier 1.5 field map
  //      (the goal is a multi-step task, not a single form fill).
  //   2. Cached sub-tasks: passed to _executeTurnLoopFallback via the
  //      _preDecomposedSubTasks param, avoiding a second decomposition call.
  // This is LLM-based — no regex. Falls back gracefully if decomposition fails.
  let _preDecomposedSubTasks = null;
  try {
    const _decomp = await _decomposeGoalIntoSubTasks(goal, sessionId);
    if (_decomp.ok && _decomp.subTasks && _decomp.subTasks.length > 1) {
      _preDecomposedSubTasks = _decomp.subTasks;
      logger.info(`[playwright.agent] pre-check: goal decomposed into ${_preDecomposedSubTasks.length} sub-tasks — will skip field map (multi-step task)`);
    } else if (_decomp.ok && _decomp.subTasks && _decomp.subTasks.length === 1) {
      logger.info(`[playwright.agent] pre-check: goal decomposed into 1 sub-task — single-step, field map eligible`);
    }
  } catch (e) {
    logger.warn(`[playwright.agent] pre-check: decomposition error (non-fatal): ${e.message}`);
  }

  const start = Date.now();
  const _deadline = start + overallTimeoutMs;
  // Track whether JIT research was attempted during this run — included in ask_user message.
  // Reset at the start of each playwrightAgent run (module-level var set by _justInTimeResearch).
  _jitResearchAttemptedFlag = false;
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

  // Early abort check — if the caller already cancelled (e.g. user clicked
  // Cancel during auth/probe before this run started), stop immediately.
  if (_aborted()) {
    logger.info(`[playwright.agent] cancelled before run — stopping heartbeat and returning`);
    _heartbeat.stop();
    try { await browserAct({ action: 'close', sessionId }); } catch (_) {}
    return { ok: false, goal, sessionId, error: 'Cancelled by user', cancelled: true, turns: 0, transcript: [], executionTime: Date.now() - start };
  }

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
  function _failureAskUser(reason, partialProgress = null) {
    const _jitNote = _jitResearchAttemptedFlag
      ? `\n\nI also tried looking up how to resolve this on ${hostname || 'this site'} via web research, but didn't find a specific fix.`
      : '';
    // When partialProgress is available, the failure UI shows a partial-completion
    // QuestionCard with "Try to finish" (plan extension), "Train me with a recipe",
    // and a free-text "Other" option. When partialProgress is null (e.g. a login
    // wall or early failure), fall back to the original options.
    const _options = partialProgress
      ? [
          { label: 'Try to finish', value: 'try_to_finish', primary: true },
          { label: 'Train me with a recipe', value: 'record_recipe' },
        ]
      : [
          { label: 'Try again', value: 'try_again' },
          { label: 'Correct and retry (tell me what was missed)', value: 'correct_and_retry' },
          { label: 'Record recipe from beginning', value: 'record_recipe' },
        ];
    const _question = partialProgress
      ? partialProgress.summary || `I partially completed this step but couldn't finish it.\n\nReason: ${reason}${_jitNote}`
      : `I wasn't able to complete this step automatically.\n\nReason: ${reason}${_jitNote}\n\nWhat would you like to do? You can also type what went wrong and I'll retry with your correction.`;
    return {
      ok: false,
      askUser: true,
      trainingHandoff: true,
      question: _question,
      options: _options,
      partialProgress,
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
        if (_urlsEqual(_curUrl, url)) {
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
            if (_urlsEqual(_curUrl, url)) {
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
  // Extract compose text from goal for ALL compose/post tasks (not just fast path).
  // This makes it available to the turn-loop for text-already-entered detection even
  // when the fast path isn't taken (e.g. Facebook homepage requires a click to open
  // the compose modal, so its URL doesn't match the compose regex).
  if (!_extractedComposeText) {
    const _goalQuotes = [...goal.matchAll(/["']([^"']{3,5000})["']/g)].map(m => m[1]);
    if (_goalQuotes.length > 0) {
      _extractedComposeText = _goalQuotes[_goalQuotes.length - 1].trim();
    }
  }
  if (url && engine.isSessionActive(sessionId)) {
    const _composeRe = /shareActive=true|compose\/post|compose=new|\/compose\b|posting\?compose=true/i;
    if (_composeRe.test(url)) {
      // Gmail multi-field compose is handled by Tier 1.5 selector map (below).
      // The single-text fast path cannot handle it.
      if (/mail\.google\.com.*compose=new/.test(url)) {
        logger.info(`[playwright.agent] Script-URL fast path: skipping Gmail multi-field compose — Tier 1.5 selector map will handle`);
      } else {
        // Extract the text to type from the goal.
        // Strategy:
        // 1. If the goal contains {{synthesisAnswer}} (unsubstituted — group execution path
        //    passes content via [DATA FROM PRIOR STEP] instead), use the [DATA FROM PRIOR
        //    STEP] content as the text to type.
        // 2. Otherwise, find the LAST quoted string in the goal (after stripping [DATA FROM
        //    PRIOR STEP] diagnostic blocks) — the post text is always at the end.
        // 3. Fallback: text after "post:" / "type:" / "write:" / "share:"
        let _composeText = null;

        // Extract [DATA FROM PRIOR STEP] content (if present) and strip it from the goal
        let _priorStepContent = null;
        const _priorStepMatch = goal.match(/\[DATA FROM PRIOR STEP\][\s\S]*?(?:\[\/DATA FROM PRIOR STEP\]|$)/i);
        if (_priorStepMatch) {
          _priorStepContent = _priorStepMatch[0].replace(/\[DATA FROM PRIOR STEP\]\s*/i, '').replace(/\[\/DATA FROM PRIOR STEP\]/i, '').trim();
        }
        const _goalWithoutPriorStep = goal.replace(/\[DATA FROM PRIOR STEP\][\s\S]*?(?:\[\/DATA FROM PRIOR STEP\]|$)/i, ' ').trim();

        // If the goal contains {{synthesisAnswer}} (unsubstituted token — group execution path),
        // use the [DATA FROM PRIOR STEP] content as the text to type
        if (/\{\{synthesisAnswer\}\}/.test(_goalWithoutPriorStep) && _priorStepContent) {
          _composeText = _priorStepContent;
          logger.info(`[playwright.agent] Script-URL fast path: using [DATA FROM PRIOR STEP] content for {{synthesisAnswer}} (${_composeText.length} chars)`);
        } else {
          // Search for quoted strings in the goal WITHOUT [DATA FROM PRIOR STEP] noise
          const _allQuotes = [..._goalWithoutPriorStep.matchAll(/["']([^"']{3,5000})["']/g)].map(m => m[1]);
          if (_allQuotes.length > 0) {
            // Use the last quoted string — it's the actual post text
            _composeText = _allQuotes[_allQuotes.length - 1].trim();
          } else {
            // Fallback: text after "post:" / "type:" / "write:" / "share:"
            const _textMatch = _goalWithoutPriorStep.match(/(?:post|type|write|share)[:\s]+(.{3,5000})$/i);
            if (_textMatch) _composeText = _textMatch[1].trim();
          }
        }
        if (_composeText) {
          logger.info(`[playwright.agent] Script-URL fast path: compose URL detected + text extracted (${_composeText.length} chars) — deterministic flow`);
          // Store extracted text for turn-loop fallback (in case fast path fails)
          _extractedComposeText = _composeText;
          try {
            const _fastResult = await _scriptUrlFastPath(sessionId, _composeText, goal, start, _deadline, _heartbeat, headed);
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

  // ── Browse/read task: extract content + return (no turn-loop needed) ──────
  // For passive read-only tasks (summarize, read, how many, count), just extract
  // page content. Query verbs (search for, find, look up, check) are NOT passive
  // reads — they require interaction (search box or search URL) and fall through
  // to Plan-Execute. Search-criteria tasks (unread, from:X, subject:X) also fall
  // through so the filter can be applied before extraction.
  if (url && engine.isSessionActive(sessionId)) {
    // Passive read verbs — extract content from the current page without interaction
    const _browseRe = /\bsummarize\b|\bread\b|\bshow me\b|\bbrowse\b|\bhow many\b|\bcount\b|\btell me what's on\b|\btell me what is on\b|\bwhat's on this page\b|\bwhat is on this page\b|\bextract content\b|\bget page text\b/i;
    // Mutation verbs — if present, don't take the browse shortcut
    // "ask" is included because chatbot-prompt tasks ("Ask Claude to summarize X")
    // require typing+submitting a prompt — they are NOT passive page reads even
    // though they often contain passive verbs like "summarize" (that verb describes
    // what the chatbot does, not what the agent does).
    const _composeRe2 = /\bpost\b|\bsend\b|\bcompose\b|\btweet\b|\bshare\b|\bwrite\b|\bcreate\b|\bsubmit\b|\bemail\b|\bmessage\b|\bdraft\b|\bask\b/i;
    // Search-criteria patterns — if present, the task needs a search/filter applied first
    const _searchCriteriaRe = /\bunread|starred|label:|tag:|from:|to:|subject:|is:unread|is:read|has:|since:|before:|after:|category:|not from|but not from|excluding\b/i;
    // Check if the current URL already has a search query applied
    let _urlHasSearchQuery = false;
    try {
      const _curUrl = await _engineEval(sessionId, 'window.location.href');
      if (_curUrl?.ok && _curUrl.result) {
        const _u = String(_curUrl.result).trim().replace(/^"|"$/g, '');
        _urlHasSearchQuery = /#search\/|[?&](q|query|filter|search)=/i.test(_u);
      }
    } catch (_) {}

    const _isBrowseMatch = _browseRe.test(goal);
    const _hasMutation = _composeRe2.test(goal);
    const _hasSearchCriteria = _searchCriteriaRe.test(goal);
    // Take the browse shortcut when: no mutation AND (passive read verb OR the
    // URL already has a search query applied). When the deep-link URL already
    // loaded the search results (e.g. #search/is:unread from:pastor wendal),
    // just extract — don't fall through to Plan-Execute which would re-type the
    // planner's (possibly worse) query and override the correct results.
    if (!_hasMutation && (_isBrowseMatch || _urlHasSearchQuery)) {
      logger.info(`[playwright.agent] browse/read task detected — extracting content (no turn-loop) [browseMatch=${_isBrowseMatch} searchCriteria=${_hasSearchCriteria} urlHasQuery=${_urlHasSearchQuery}]`);
      try {
        const _browsePage = engine.getPage(sessionId);
        if (_browsePage) {
          await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 15000 }).catch(() => {});
          await _browsePage.waitForTimeout(2000); // extra settle for dynamic content
          const _pageText = await _browsePage.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => '');
          let _ocrText = '';
          try { const _cap = await _ocrCaptureViaPage(_browsePage); if (_cap.ok) _ocrText = _cap.text.slice(0, 3000); } catch (_) {}
          const _content = _pageText || _ocrText || '(no content extracted)';
          logger.info(`[playwright.agent] browse/read: extracted ${_pageText.length} chars DOM + ${_ocrText.length} chars OCR (page-liteparse)`);
          _heartbeat.stop();
          return {
            ok: true,
            done: true,
            goal,
            sessionId,
            turns: 1,
            result: _content,
            transcript: [{ step: 1, action: { action: 'getPageText' }, outcome: { ok: true }, thoughts: 'browse/read task — content extracted' }],
            routingDecision: 'browse_read_extract',
            executionTime: Date.now() - start,
          };
        }
      } catch (_browseErr) {
        logger.warn(`[playwright.agent] browse/read task error (non-fatal): ${_browseErr.message} — falling through`);
      }
    } else if (_hasSearchCriteria && !_urlHasSearchQuery && !_isBrowseMatch) {
      logger.info(`[playwright.agent] search-criteria task detected but URL has no search query — falling through to Plan-Execute (not taking browse shortcut)`);
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
  // attempt Tier 1.5/2/2.5/3. Prevents planning against about:blank, 404s, or
  // broken pages. If the deep-link URL is a 404, falls back to _recoveryUrl
  // (browser.agent's startUrl) or the URL's origin.
  if (url && hostname) {
    let _verifyOk = false;
    let _verifyRetry = false;
    let _verifyIs404 = false;
    let _recoveryUrls = [];
    try {
      const _vgUrl = await _engineEval(sessionId, 'window.location.href');
      const _vgTextLen = await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText.length : 0)');
      const _vgTitle = await _engineEval(sessionId, 'document.title');
      const _vgActualUrl = _vgUrl?.ok ? String(_vgUrl.result).trim().replace(/^"|"$/g, '') : '';
      const _vgTextNum = _vgTextLen?.ok ? Number(_vgTextLen.result) : 0;
      const _vgTitleText = _vgTitle?.ok ? String(_vgTitle.result).trim().replace(/^"|"$/g, '') : '';
      const _vgPageText = (_vgTextNum > 0)
        ? await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText : "").toLowerCase().slice(0, 1500)').then(r => String(r?.ok ? r.result : '').replace(/^"|"$/g, '')).catch(() => '')
        : '';

      // 404 / not-found detection (case-insensitive)
      const _is404 = /\b404\b|page not found|we can('t|t) seem to find|we can('t|t) find|this page( does)?n'?t exist|does not exist|not available|couldn('t|t) find the page|the page you'?re looking for/i.test(`${_vgPageText} ${_vgTitleText}`);
      if (_is404) {
        logger.warn(`[playwright.agent] verify gate: page appears to be a 404 / not-found — will try recovery URLs`);
        _verifyIs404 = true;
        _verifyRetry = true;
      } else if (/about:blank/i.test(_vgActualUrl)) {
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
        // Build a list of recovery URLs to try in order:
        // 1. The original deep-link URL (transient failures / race conditions)
        // 2. The recovery URL from browser.agent (service startUrl, e.g. https://open.spotify.com)
        // 3. The origin of the deep-link URL (e.g. https://open.spotify.com/)
        _recoveryUrls.push(url);
        if (_recoveryUrl && _recoveryUrl !== url) _recoveryUrls.push(_recoveryUrl);
        try {
          const _origin = new URL(url).origin + '/';
          if (_origin !== url && _origin !== _recoveryUrl) _recoveryUrls.push(_origin);
        } catch (_) {}

        let _lastRecoveryError = null;
        let _recoveredTextLen = 0;
        let _recoveredUrl = '';

        for (const _tryUrl of _recoveryUrls) {
          logger.info(`[playwright.agent] verify gate: recovery — navigating to ${_tryUrl}`);
          const _engineNav = await _engineNavigate(sessionId, _tryUrl, Math.max(timeoutMs, 30000));
          if (!_engineNav?.ok) {
            await browserAct({ action: 'navigate', url: _tryUrl, sessionId, headed, timeoutMs: Math.max(timeoutMs, 30000) }).catch(() => {});
          }
          await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 10000 }).catch(() => {});
          // Re-check
          const _vgUrl2 = await _engineEval(sessionId, 'window.location.href');
          const _vgTextLen2 = await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText.length : 0)');
          const _vgActualUrl2 = _vgUrl2?.ok ? String(_vgUrl2.result).trim().replace(/^"|"$/g, '') : '';
          const _vgTextNum2 = _vgTextLen2?.ok ? Number(_vgTextLen2.result) : 0;

          if (/about:blank/i.test(_vgActualUrl2) || _vgTextNum2 < 100) {
            _lastRecoveryError = 'about:blank or empty page';
            continue; // try next recovery URL
          }

          // Also re-check for 404 on the recovery URL (could still be broken)
          const _vgTitle2 = await _engineEval(sessionId, 'document.title');
          const _vgTitleText2 = _vgTitle2?.ok ? String(_vgTitle2.result).trim().replace(/^"|"$/g, '') : '';
          const _vgPageText2 = await _engineEval(sessionId, '(document.body && document.body.innerText ? document.body.innerText : "").toLowerCase().slice(0, 1500)').then(r => String(r?.ok ? r.result : '').replace(/^"|"$/g, '')).catch(() => '');
          const _is404Recovery = /\b404\b|page not found|we can('t|t) seem to find|we can('t|t) find|this page( does)?n'?t exist|does not exist|not available|couldn('t|t) find the page|the page you'?re looking for/i.test(`${_vgPageText2} ${_vgTitleText2}`);
          if (_is404Recovery) {
            _lastRecoveryError = 'page not found / 404';
            continue;
          }

          _recoveredTextLen = _vgTextNum2;
          _recoveredUrl = _vgActualUrl2;
          _verifyOk = true;
          break; // success
        }

        if (!_verifyOk) {
          logger.error(`[playwright.agent] verify gate: page still broken after recovery — attempted ${_recoveryUrls.length} URL(s) — aborting`);
          return {
            ok: false, goal, sessionId,
            turns: 0, done: false,
            result: `Page verification failed — could not load ${url}`,
            error: `Verify gate: page is about:blank, 404, or empty after recovery attempt`,
            transcript: [],
            executionTime: Date.now() - start,
          };
        }
        // Re-snapshot after recovery
        const _vgSnap = await _fastSnapshot(sessionId, headed, timeoutMs);
        if (_vgSnap.ok && _vgSnap.result) currentSnapshot = _vgSnap.result;
        logger.info(`[playwright.agent] verify gate: recovered after re-navigation to ${_recoveredUrl} (textLen=${_recoveredTextLen})`);
      }
    } catch (_vgErr) {
      logger.warn(`[playwright.agent] verify gate error (non-fatal): ${_vgErr.message} — proceeding`);
    }
  }

  // ── Phase 1.1 variables (declared early to avoid TDZ in Tier 1.7) ──────────
  // These are set in Phase 1.1 below but referenced by Tier 1.7's return path.
  let _pageType = 'sparse';
  let _routingDecision = 'tier3_llm';
  let _probeResult = null;
  let _scriptResult = null;

  // ── Tier 0.5: Skill-reference detection ──────────────────────────────────
  // If the goal explicitly references a trained agent-based skill (execType:'agent'),
  // delegate to instruction.runner.cjs (keyboard nav) instead of the tier cascade.
  // This handles prompts like "Use create.playlist.skill and create 'Christian music'".
  // Falls through to the normal tier cascade if the skill fails or is not found.
  try {
    const trainerAgent = require('./trainer.agent.cjs');
    const _tier05AgentId = (agentId || sessionId || '').replace(/\.agent$/, '').replace(/_agent$/, '');
    if (_tier05AgentId) {
      const _matchedSkill = trainerAgent.findMatchingRecipe(_tier05AgentId, goal, { allowAutoGenerated: true });
      if (_matchedSkill && (_matchedSkill.execType === 'agent' ||
          (_matchedSkill.instructions && (!_matchedSkill.waypoints || _matchedSkill.waypoints.length === 0)))) {
        logger.info(`[playwright.agent] Tier 0.5: goal matches agent skill "${_matchedSkill.name}" — delegating to instruction.runner`);

        // Extract params from goal
        let _tier05Params = { sessionId };
        if (_matchedSkill.params && Array.isArray(_matchedSkill.params) && _matchedSkill.params.length > 0) {
          const paramPrompt = `Extract parameter values from this user task.
TASK: "${goal}"
PARAMS:
${_matchedSkill.params.map(p => `- ${p.name} (${p.type}${p.required ? ', required' : ''}): "${p.description}"`).join('\n')}

Output ONLY valid JSON: {${_matchedSkill.params.map(p => `"${p.name}": "<extracted value or null>"`).join(', ')}}`;
          try {
            const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
            const paramResponse = await askWithMessages([
              { role: 'system', content: 'You extract parameter values from user tasks. Output ONLY valid JSON.' },
              { role: 'user', content: paramPrompt },
            ], { maxTokens: 500, temperature: 0.1 });
            let paramJson = (paramResponse || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
            _tier05Params = { sessionId, ...JSON.parse(paramJson) };
            logger.info(`[playwright.agent] Tier 0.5: params extracted: ${JSON.stringify(_tier05Params)}`);
          } catch (e) {
            logger.warn(`[playwright.agent] Tier 0.5: param extraction failed: ${e.message}`);
          }
        }

        const { runInstructionSkill } = require('./instruction.runner.cjs');
        const _tier05Result = await runInstructionSkill({
          instructions: _matchedSkill.instructions,
          keyPath: _matchedSkill.keyPath || null,
          params: _matchedSkill.params || [],
          skillArgs: _tier05Params,
          startUrl: _matchedSkill.startUrl || url,
          sessionId,
          timeoutMs: overallTimeoutMs,
        });

        if (_tier05Result?.ok) {
          // Cache keyPath if discovered
          if (_tier05Result.discoveredKeyPath && _tier05Result.discoveredKeyPath.length > 0 && !_matchedSkill.keyPath) {
            try {
              _matchedSkill.keyPath = _tier05Result.discoveredKeyPath;
              const os = require('os');
              const path = require('path');
              const fs = require('fs');
              const skillDir = path.join(trainerAgent.SKILLS_DIR || path.join(os.homedir(), '.thinkdrop', 'skills'), _tier05AgentId);
              const skillPath = path.join(skillDir, `${_matchedSkill.name}.skill.json`);
              if (fs.existsSync(skillPath)) {
                fs.writeFileSync(skillPath, JSON.stringify(_matchedSkill, null, 2));
                logger.info(`[playwright.agent] Tier 0.5: cached keyPath (${_tier05Result.discoveredKeyPath.length} steps) to ${skillPath}`);
              }
            } catch (e) {
              logger.warn(`[playwright.agent] Tier 0.5: could not cache keyPath: ${e.message}`);
            }
          }
          _heartbeat.stop();
          return {
            ok: true, goal, sessionId,
            turns: 1, done: true,
            result: _tier05Result.output || `Completed via skill ${_matchedSkill.name}`,
            transcript: [{ step: 1, action: { skill: _matchedSkill.name }, outcome: { ok: true } }],
            routingDecision: 'tier0_5_skill_delegate',
            pageType: _pageType,
            executionTime: Date.now() - start,
          };
        }
        // If skill failed, fall through to normal tier cascade
        logger.warn(`[playwright.agent] Tier 0.5: skill "${_matchedSkill.name}" failed: ${_tier05Result?.error} — falling through to tier cascade`);
      }
    }
  } catch (_tier05Err) {
    logger.warn(`[playwright.agent] Tier 0.5 error (non-fatal): ${_tier05Err.message} — falling through`);
  }

  // ── Tier 1.5: Deterministic field map for form/compose URLs AND editor pages ──
  // After URL-first navigation + waitForStableText, try cached or LLM-generated
  // field map for type→verify→submit→verify. Falls through to Tier 2/3 on failure.
  // Extended: also handles URL-first pages with editable fields (Notion, Google Docs,
  // etc.) — uses placeholder + position as primary, CSS selectors as fallback.
  if (url && hostname && engine.isSessionActive(sessionId)) {
    try {
      const _curUrl = await _engineEval(sessionId, 'window.location.href');
      const _actualUrl = _curUrl?.ok ? String(_curUrl.result).trim().replace(/^"|"$/g, '') : url;
      const _isFormUrl = isFormUrl(url) || isFormUrl(_actualUrl);

      // ── Gmail compose dialog guard ───────────────────────────────────────────
      // If this is a Gmail compose task (URL contains compose=new) but the compose
      // dialog is NOT open on the page, do NOT proceed to the field map. The field
      // map will try to fill a To field that doesn't exist on the inbox view and
      // burn the entire timeout. Instead, attempt one navigation retry; if the
      // dialog still isn't open, fall through to Tier 2/3 (LLM planning) which can
      // click the Compose button as a fallback.
      const _isGmailComposeUrl = /mail\.google\.com.*compose=new/.test(url)
        || /mail\.google\.com.*compose=new/.test(_actualUrl);
      let _gmailComposeDialogOpen = true; // assume open unless proven otherwise
      if (_isGmailComposeUrl) {
        const _composeDialogExpr = "(!!(document.querySelector('div[role=dialog] [contenteditable], div[role=dialog] [role=textbox], div[role=dialog] textarea, div[role=dialog] input[name=to], textarea[name=to]') || document.querySelector('div[role=dialog] form')))";
        const _composeCheckRes = await _engineEval(sessionId, _composeDialogExpr).catch(() => ({ ok: false }));
        const _composeDialogOpen = _composeCheckRes?.ok
          && (_composeCheckRes.result === true || _composeCheckRes.result === 'true');
        if (!_composeDialogOpen) {
          logger.warn(`[playwright.agent] Tier 1.5: Gmail compose URL detected but compose dialog NOT open — attempting navigation retry before field map (url=${url} actualUrl=${_actualUrl})`);
          // Retry navigation to the compose URL once
          const _retryNav = await _engineNavigate(sessionId, url, Math.max(timeoutMs, 30000));
          if (_retryNav?.ok) {
            await new Promise(r => setTimeout(r, 3000));
            const _recheckRes = await _engineEval(sessionId, _composeDialogExpr).catch(() => ({ ok: false }));
            const _recheckOpen = _recheckRes?.ok
              && (_recheckRes.result === true || _recheckRes.result === 'true');
            if (_recheckOpen) {
              logger.info(`[playwright.agent] Tier 1.5: Gmail compose dialog open after retry — proceeding to field map`);
              _gmailComposeDialogOpen = true;
            } else {
              logger.warn(`[playwright.agent] Tier 1.5: Gmail compose dialog still NOT open after retry — skipping field map, falling through to Tier 2/3 (LLM will click Compose)`);
              _gmailComposeDialogOpen = false;
            }
          } else {
            logger.warn(`[playwright.agent] Tier 1.5: Gmail compose navigation retry failed — skipping field map, falling through to Tier 2/3`);
            _gmailComposeDialogOpen = false;
          }
        }
      }

      // Structural editor page detection: editable fields (app-agnostic).
      // _probeResult is not yet defined at this point (it's initialized later at line ~6977).
      // Use a quick inline probe via _engineEval — just 3 DOM queries to check for editable fields.
      const _quickProbeRes = await _engineEval(sessionId, `JSON.stringify({
        hasContentEditable: document.querySelector('[contenteditable="true"]') !== null,
        hasPlaceholder: document.querySelector('[placeholder]') !== null,
        textInputCount: document.querySelectorAll('input[type="text"], input:not([type]), textarea').length,
      })`);
      let _quickProbe = null;
      if (_quickProbeRes?.ok && _quickProbeRes.result) {
        try { _quickProbe = JSON.parse(String(_quickProbeRes.result)); } catch (_) {}
      }
      const _hasEditableFields = _quickProbe &&
        (_quickProbe.hasContentEditable || _quickProbe.hasPlaceholder || (_quickProbe.textInputCount || 0) > 0);
      // Page-structure-based skip: if the page has NO editable fields, it's a
      // read/extract task — skip the field map. If the page HAS editable fields,
      // always try the field map regardless of goal verbs — the page structure is
      // the ground truth, not the goal text. (Previously used a verb list which
      // falsely skipped "Ask Claude to summarize X" because "summarize" matched.)
      if (!_hasEditableFields && !_isFormUrl) {
        logger.info(`[playwright.agent] Tier 1.5: no editable fields on page — skipping field map (read/extract task)`);
      } else if (_isGmailComposeUrl && !_gmailComposeDialogOpen) {
        logger.info(`[playwright.agent] Tier 1.5: Gmail compose dialog not open — skipping field map (falling through to Tier 2/3 for Compose click)`);
      } else if (_isMultiStepGoal(goal)) {
        logger.info(`[playwright.agent] Tier 1.5: multi-step goal detected (for-each loop) — skipping field map (falling through to Tier 2/3 for full LLM plan)`);
      } else if (_preDecomposedSubTasks && _preDecomposedSubTasks.length > 1) {
        logger.info(`[playwright.agent] Tier 1.5: LLM decomposition detected ${_preDecomposedSubTasks.length} sub-tasks — skipping field map (falling through to Tier 2/3)`);
      } else {
        logger.info(`[playwright.agent] Tier 1.5: ${_isFormUrl ? 'form URL' : 'editable page'} detected (url=${url} actualUrl=${_actualUrl}) — trying deterministic field map`);
        const _tier15Result = await _deterministicSelectorPath(sessionId, _actualUrl || url, goal, hostname, timeoutMs, { hasEditableFields: _hasEditableFields, agentContext, appKnowledgeEntries });
        if (_tier15Result) {
          _tier15Result.executionTime = Date.now() - start;
          return _tier15Result;
        }
        logger.info(`[playwright.agent] Tier 1.5: field map did not complete — falling through to Tier 2/3`);
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
      const _isSimpleGoal = !_isMultiStepGoal(goal) &&
        !/\bto\s+[\w.+-]+@|subject|recipient|cc|bcc|attach|file|upload\b/i.test(goal) &&
        (/\b(post|share|update|tweet|send|write|say|ask|tell|search|query|look\s+up|find|message)\b/i.test(_goalLower));

      if (_isSimpleGoal) {
        // Extract text payload: remove leading action verbs and service names
        let _textPayload = goal
          // Strip the guard preamble (recovery anchor) — extract just the "Task: ..." part.
          // The preamble is constructed at browser.agent.cjs:5253 as:
          //   "IMPORTANT: You are working on <url> (browser session: <id>). If the page ever shows about:blank..."
          // followed by "\n\nTask: <actual task>". Without this strip, the entire preamble
          // gets typed into the compose box.
          .replace(/^IMPORTANT: You are working on .+?\n\nTask:\s*/is, '')
          .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:I\s+want\s+to\s+|I'd\s+like\s+to\s+)?/i, '')
          .replace(/^(?:post|share|update|tweet|send|write|say|ask|tell|search\s+for|query|look\s+up|find|message)\s+/i, '')
          .replace(/^(?:on\s+|to\s+|in\s+)?[a-z][a-z0-9.]+\s+/i, '')
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
            // Step 2: Universal layered submit detection
            // Uses compose element type + DOM structure + positional proximity.
            // No text regex — element type and position are the truth.
            const _activeElInfo = _tier17Snap?.activeElement;
            const _isChatCompose = _activeElInfo?.isContentEditable === true ||
              (_activeElInfo?.tag === 'div' && _activeElInfo?.role === 'textbox');

            // Helper: verify submit succeeded (URL changed or text on page)
            const _verifySubmit = async (_method) => {
              await new Promise(r => setTimeout(r, 1500));
              const _verifyUrlRes = await browserAct({ action: 'evaluate', text: 'window.location.href', sessionId, headed, timeoutMs: 3000 }).catch(() => ({ ok: false }));
              const _verifyTextRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
              const _pageText = _verifyTextRes?.ok ? String(_verifyTextRes.result || '') : '';
              const _textOnPage = _pageText.includes(_textPayload.slice(0, 50));
              const _urlChanged = _verifyUrlRes?.ok && String(_verifyUrlRes.result || '').replace(/^"|"$/g, '') !== url;
              return { textOnPage: _textOnPage, urlChanged: _urlChanged, pageText: _pageText };
            };

            // Helper: return success result
            const _returnSuccess = (_method, _verifyResult) => {
              logger.info(`[playwright.agent] Tier 1.7: SUCCESS via ${_method} — textOnPage=${_verifyResult.textOnPage}, urlChanged=${_verifyResult.urlChanged}`);
              return {
                ok: true, goal, sessionId,
                turns: 2, done: true,
                result: `Completed via Tier 1.7 fast-path (${_method})${_verifyResult.textOnPage ? ' — content verified on page' : _verifyResult.urlChanged ? ' — URL changed' : ''}`,
                transcript: _tier17Transcript,
                routingDecision: 'tier1_7_fastpath',
                pageType: _pageType,
                executionTime: Date.now() - start,
              };
            };

            let _submitHandled = false;

            // ── Layer 1: Chat compose (contenteditable div) → press Enter ────────
            // Chat interfaces (Claude, ChatGPT, Grok, etc.) universally use Enter
            // to submit. No button search needed — eliminates false matches.
            if (_isChatCompose) {
              logger.info(`[playwright.agent] Tier 1.7: chat compose detected (contenteditable div) — pressing Enter to submit`);
              const _enterRes = await browserAct({ action: 'press', key: 'Enter', sessionId, headed, timeoutMs: 5000 });
              _tier17Transcript.push({ action: { press: 'Enter' }, outcome: { ok: _enterRes.ok } });

              if (_enterRes.ok) {
                const _vResult = await _verifySubmit('Enter');
                if (_vResult.textOnPage || _vResult.urlChanged) {
                  return _returnSuccess('type→Enter→verify', _vResult);
                }
                logger.info(`[playwright.agent] Tier 1.7: Enter did not produce verifiable result — trying positional button search`);
              }
            }

            // ── Layer 2: DOM structure — find <button> in same form/container ──
            // Traditional forms have <button> inside <form>. SPAs may not have
            // <form> but the button is in a nearby container.
            if (!_submitHandled) {
              const _domBtnRes = await browserAct({ action: 'evaluate', sessionId, headed, timeoutMs: 5000,
                text: `(() => {
                  const compose = document.activeElement;
                  if (!compose) return null;
                  // Walk up to find form, dialog, or section containing the compose element
                  let container = compose.closest('form') || compose.closest('[role="dialog"]') || compose.closest('section');
                  for (let i = 0; i < 3 && container; i++) {
                    const btn = container.querySelector('button:not([disabled])');
                    if (btn) return btn.getAttribute('data-td-ref') || null;
                    container = container.parentElement;
                  }
                  return null;
                })()` });
              const _domBtnRef = _domBtnRes?.ok ? String(_domBtnRes.result || '').replace(/^"|"$/g, '') : null;
              if (_domBtnRef && _domBtnRef !== 'null') {
                logger.info(`[playwright.agent] Tier 1.7: found submit button via DOM structure ref=${_domBtnRef}`);
                const _clickRes = await browserAct({ action: 'click', selector: _domBtnRef, sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
                _tier17Transcript.push({ action: { click: _domBtnRef }, outcome: { ok: _clickRes.ok, error: _clickRes.error } });

                if (_clickRes.ok) {
                  const _vResult = await _verifySubmit('type→click→verify');
                  if (_vResult.textOnPage || _vResult.urlChanged) {
                    return _returnSuccess('type→click(DOM)→verify', _vResult);
                  }
                  logger.warn(`[playwright.agent] Tier 1.7: DOM button clicked but no verification — trying positional`);
                } else {
                  logger.warn(`[playwright.agent] Tier 1.7: DOM button click failed — trying positional`);
                }
              }
            }

            // ── Layer 3: Positional proximity — nearest <button> by rect coords ──
            // Universal fallback: finds the nearest visible <button> to the compose
            // element, penalizing buttons ABOVE or LEFT (submit buttons are below/right).
            // Only matches <button> elements — never <a> links or sidebar items.
            if (!_submitHandled) {
              const _posBtnRes = await browserAct({ action: 'evaluate', sessionId, headed, timeoutMs: 5000,
                text: `(() => {
                  const compose = document.activeElement;
                  if (!compose) return null;
                  const cr = compose.getBoundingClientRect();
                  if (cr.width < 5) return null;
                  const buttons = Array.from(document.querySelectorAll('button[data-td-ref]:not([disabled])'))
                    .filter(btn => {
                      const r = btn.getBoundingClientRect();
                      if (r.width < 2 || r.height < 2) return false;
                      const s = window.getComputedStyle(btn);
                      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
                    });
                  if (buttons.length === 0) return null;
                  let best = null, bestScore = Infinity;
                  for (const btn of buttons) {
                    const r = btn.getBoundingClientRect();
                    const dx = (r.x + r.width/2) - (cr.x + cr.width/2);
                    const dy = (r.y + r.height/2) - (cr.y + cr.height/2);
                    let score = Math.sqrt(dx*dx + dy*dy);
                    if (dy < -10) score += 500;
                    if (dx < -10) score += 200;
                    if (score < bestScore) { bestScore = score; best = btn; }
                  }
                  return best ? best.getAttribute('data-td-ref') : null;
                })()` });
              const _posBtnRef = _posBtnRes?.ok ? String(_posBtnRes.result || '').replace(/^"|"$/g, '') : null;
              if (_posBtnRef && _posBtnRef !== 'null') {
                logger.info(`[playwright.agent] Tier 1.7: found submit button via positional proximity ref=${_posBtnRef}`);
                const _clickRes = await browserAct({ action: 'click', selector: _posBtnRef, sessionId, headed, timeoutMs: Math.min(timeoutMs, 15000) });
                _tier17Transcript.push({ action: { click: _posBtnRef }, outcome: { ok: _clickRes.ok, error: _clickRes.error } });

                if (_clickRes.ok) {
                  const _vResult = await _verifySubmit('type→click→verify');
                  if (_vResult.textOnPage || _vResult.urlChanged) {
                    return _returnSuccess('type→click(positional)→verify', _vResult);
                  }
                  logger.warn(`[playwright.agent] Tier 1.7: positional button clicked but no verification — trying Enter fallback`);
                } else {
                  logger.warn(`[playwright.agent] Tier 1.7: positional button click failed — trying Enter fallback`);
                }
              }
            }

            // ── Layer 4: Enter fallback (universal) ─────────────────────────────
            // If no button was found or clicked successfully, press Enter as a
            // last resort. Works for chat interfaces and many form types.
            if (!_submitHandled) {
              logger.info(`[playwright.agent] Tier 1.7: no button found/clicked — trying Enter key as fallback`);
              const _enterRes = await browserAct({ action: 'press', key: 'Enter', sessionId, headed, timeoutMs: 5000 });
              _tier17Transcript.push({ action: { press: 'Enter' }, outcome: { ok: _enterRes.ok } });

              if (_enterRes.ok) {
                const _vResult = await _verifySubmit('Enter');
                if (_vResult.textOnPage || _vResult.urlChanged) {
                  return _returnSuccess('type→Enter(fallback)→verify', _vResult);
                }
              }
              logger.warn(`[playwright.agent] Tier 1.7: Enter fallback did not produce verifiable result — falling through to Tier 3`);
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
              const _isSimpleGoal = !_isMultiStepGoal(goal) &&
                !/\bto\s+[\w.+-]+@|subject|recipient|cc|bcc|attach|file|upload\b/i.test(goal) &&
                (/\b(post|share|update|tweet|send|write|say|ask|tell|search|query|look\s+up|find|message)\b/i.test(_goalLower));

              if (_isSimpleGoal) {
                let _textPayload = goal
                  .replace(/^(?:please\s+)?(?:can\s+you\s+)?(?:I\s+want\s+to\s+|I'd\s+like\s+to\s+)?/i, '')
                  .replace(/^(?:post|share|update|tweet|send|write|say|ask|tell|search\s+for|query|look\s+up|find|message)\s+/i, '')
                  .replace(/^(?:on\s+|to\s+|in\s+)?[a-z][a-z0-9.]+\s+/i, '')
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
  // (_pageType, _routingDecision, _probeResult, _scriptResult declared above Tier 1.5)
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

    // ── Blocking-modal guard for post/share tasks ──────────────────────────────
    // If the page has a visible modal dialog AND no compose area (contentEditable=0,
    // roleTextbox=0, textarea=0), the task cannot proceed. The agent would click
    // around the modal and falsely report success. Instead, return a failure with
    // askUser so the user can dismiss the modal manually.
    // Only applies to mutation tasks (post/share/send/submit) — read tasks can
    // still extract content from behind modals via getPageText.
    const _isMutationTask = /\b(post|share|publish|submit|send|tweet|comment|reply|update|create|write|compose)\b/i.test(goal);
    const _hasBlockingModal = _probeResult?.hasModalDialog === true || (_probeResult?.modalCount || 0) > 0;
    const _hasNoCompose = (_probeResult?.contentEditableCount || 0) === 0 &&
                          (_probeResult?.roleTextboxCount || 0) === 0 &&
                          (_probeResult?.textareaCount || 0) === 0;
    if (_isMutationTask && _hasBlockingModal && _hasNoCompose) {
      // Extract modal text for the user-facing message
      let _modalText = '';
      try {
        const _modalInfo = await _engineEval(sessionId, `(() => {
          const sel = '[role="dialog"], [aria-modal="true"], [data-testid*="modal"]';
          const modals = Array.from(document.querySelectorAll(sel)).filter(m => {
            const r = m.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && m.getAttribute('aria-hidden') !== 'true';
          });
          return (modals[0]?.innerText || '').slice(0, 200).trim();
        })()`, 5000);
        _modalText = String(_modalInfo?.result || '').trim();
      } catch (_) {}
      const _blockReason = _modalText
        ? `Blocked by dialog: "${_modalText.slice(0, 120)}"`
        : 'Blocked by a modal dialog — no compose area available';
      logger.warn(`[playwright.agent] BLOCKING-MODAL GUARD: mutation task + modal + no compose — aborting: ${_blockReason}`);
      _heartbeat.stop();
      return {
        ok: false, done: false, goal, sessionId,
        turns: 0,
        result: _blockReason,
        transcript: [],
        executionTime: Date.now() - start,
        error: _blockReason,
        askUser: true,
        askUserPrompt: `${_blockReason}. Please dismiss the dialog on the ${_service || 'target'} page and try again.`,
      };
    }

    // ── URL-vs-task mismatch guard for post/share tasks ─────────────────────────
    // If the current URL contains /messages/ or /messenger/ but the task is a
    // post/share task (not a message task), the agent is on the wrong page (Messenger
    // instead of the feed composer). It would type into the chat compose area and
    // falsely report success. Return failure with askUser instead.
    const _currentUrl = _probeResult?.url || _probeResult?.hostname || '';
    const _isPostShareTaskUrl = /\b(post|share|publish|update|tweet|feed|status)\b/i.test(goal);
    const _isMessageTaskUrl = /\b(message|msg|dm|direct message|chat|reply|respond|inbox)\b/i.test(goal);
    if (_isPostShareTaskUrl && !_isMessageTaskUrl && /\/(messages|messenger)\b/i.test(_currentUrl)) {
      const _mismatchReason = `Wrong page for post/share task: current URL is ${_currentUrl.slice(0, 100)} (Messenger), but the task requires the feed composer. The agent would post into a chat instead of the feed.`;
      logger.warn(`[playwright.agent] URL-MISMATCH GUARD: ${_mismatchReason}`);
      _heartbeat.stop();
      return {
        ok: false, done: false, goal, sessionId,
        turns: 0,
        result: _mismatchReason,
        transcript: [],
        executionTime: Date.now() - start,
        error: _mismatchReason,
        askUser: true,
        askUserPrompt: `The agent was directed to Messenger instead of the Facebook feed. Please check the agent's deep-link configuration and try again.`,
      };
    }

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

    // Structural pattern: "URL-first landed us on a page with a contenteditable textbox
    // that has a placeholder" = "fresh editor page where keyboard-only is appropriate."
    // App-agnostic — no app-name checks. Applies to ANY app matching this pattern:
    // Notion (new page), LinkedIn (compose), X (compose), Google Docs (new doc), etc.
    // Fallback safety: if the task needs clicks, bestEffortKeyboard fails → falls through to Tier 3.
    const _keyboardEligible = _pageType === 'canvas' ||
      (_pageType === 'hybrid' && _urlFirst && _probeResult?.hasContentEditable &&
       _probeResult?.roleTextboxCount >= 1 && _probeResult?.hasPlaceholder);
    if (_keyboardEligible && !_scriptResult?.ok) {
      // Tier 2.5: Best-effort keyboard mode (no script or script failed)
      _routingDecision = 'tier2_5_keyboard';
      logger.info(`[playwright.agent] routing: Tier 2.5 (best-effort keyboard) — service=${_service || 'unknown'}, pageType=${_pageType}, keyboardEligible=${_keyboardEligible}`);

      // Phase 10: Queue async script generation for this service so next run can use Tier 2
      if (_service && !_matchedScript) {
        queueAsyncScriptGeneration(_service, _pageType, goal, _taskKeywords);
      }

      // Sync script generation removed — it generated app-specific scripts with
      // hardcoded placeholders that were often wrong (e.g. getByPlaceholder('Untitled')
      // vs Notion's "New page"), wasting 30s. Tier 1.5 (field map) now handles
      // form/editor pages deterministically. Go straight to best-effort keyboard.

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

        // Detect send/submit goals and extract verification signals from transcript
        const _isSendSubmitGoal = /\b(send|post|submit|publish|dispatch|email|tweet|share|reply|comment)\b/i.test(goal);
        let _verify = null;
        if (_isSendSubmitGoal) {
          // Extract submit click timestamp: find the last Control+Enter / Enter press in transcript
          let _submitClickTs = null;
          let _expectedText = '';
          for (const entry of _bestEffort.transcript || []) {
            if (entry.action?.press && /enter/i.test(entry.action.press)) {
              _submitClickTs = entry.outcome?.ts || Date.now();
            }
            if (entry.action?.type) {
              _expectedText = entry.action.type; // last typed text (usually the body/message)
            }
          }
          // Wait briefly for network requests to complete after submit
          await new Promise(r => setTimeout(r, 2000));
          _verify = await _verifyActionCompletion({
            goal, sessionId, headed, pageType: _pageType,
            submitClickTs: _submitClickTs,
            expectedText: _expectedText,
            isSendSubmitGoal: true,
          });
          if (_verify && _verify.pass === false) {
            logger.warn(`[playwright.agent] action verification: FAIL after Tier 2.5 best-effort — ${_verify.reason} — falling back to Tier 3 (LLM)`);
          } else if (_verify && _verify.pass === true) {
            // For CHAT/RESEARCH goals, capture the actual response content
            // (not just a status message) so the quality gate and synthesis
            // step can see the real AI response.
            const _isChatResearch = /\b(ask|summarize|what\s+is|tell\s+me|explain|describe|write|generate|create|compose|draft)\b/i.test(goal);
            let _responseContent = null;
            if (_isChatResearch) {
              logger.info(`[playwright.agent] Tier 2.5: CHAT/RESEARCH goal detected — capturing response content`);
              await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 30000) }).catch(() => {});
              const _textRes = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => null);
              _responseContent = String(_textRes?.result || '').trim();
              if (_responseContent) {
                logger.info(`[playwright.agent] Tier 2.5: response captured (${_responseContent.length} chars)`);
              }
            }
            return {
              ok: true, goal, sessionId,
              turns: _bestEffort.transcript.length, done: true,
              result: _responseContent || `Completed via best-effort keyboard (${_verify.source} verified)`,
              transcript: _bestEffort.transcript,
              routingDecision: _routingDecision,
              pageType: _pageType,
              verification: _verify,
              executionTime: Date.now() - start,
            };
          }
          // _verify returned null (shouldn't happen for send/submit) — fall through to legacy
        }

        // Phase 8: Verification layer (legacy — for non-send/submit goals or fallback)
        _verify = _verify || await verifyTierCompletion(goal, _pageType, _routingDecision, null, sessionId, headed, timeoutMs);
        if (_verify.fail) {
          logger.warn(`[playwright.agent] verification layer: FAIL after Tier 2.5 best-effort — ${_verify.reason} — falling back to Tier 3 (LLM)`);
        } else {
          // For CHAT/RESEARCH goals, capture the actual response content
          const _isChatResearchLegacy = /\b(ask|summarize|what\s+is|tell\s+me|explain|describe|write|generate|create|compose|draft)\b/i.test(goal);
          let _responseContentLegacy = null;
          if (_isChatResearchLegacy) {
            logger.info(`[playwright.agent] Tier 2.5 (legacy): CHAT/RESEARCH goal detected — capturing response content`);
            await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: Math.min(timeoutMs, 30000) }).catch(() => {});
            const _textResLegacy = await browserAct({ action: 'getPageText', sessionId, headed, timeoutMs: 10000 }).catch(() => null);
            _responseContentLegacy = String(_textResLegacy?.result || '').trim();
            if (_responseContentLegacy) {
              logger.info(`[playwright.agent] Tier 2.5 (legacy): response captured (${_responseContentLegacy.length} chars)`);
            }
          }
          return {
            ok: true, goal, sessionId,
            turns: _bestEffort.transcript.length, done: true,
            result: _responseContentLegacy || `Completed via best-effort keyboard${_verify.warn ? ' (warning: ' + _verify.reason + ')' : ''}`,
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
    _goalStateNote = '\n\nIMPORTANT: The composer/modal is ALREADY OPEN (opened by the URL deep-link). Do NOT click any button to open a composer — it is already open. Type directly into the composer text area (contenteditable or textarea) using refs from the snapshot above.';
    logger.info(`[playwright.agent] goal-state: compose URL detected — injecting "composer already open" note`);
  } else if (_composerModalOpen || _probeResult?.hasModalDialog) {
    _goalStateNote = '\n\nIMPORTANT: A composer/modal is ALREADY OPEN on the page. Do NOT click any button to open a composer — it is already open. Type directly into the composer text area (contenteditable or textarea) using refs from the snapshot above.';
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
    ], { temperature: 0.1, maxTokens: 1000, responseTimeoutMs: 15000 });
    _pageStudy = parseJson(_studyRaw);
    if (!_pageStudy && _studyRaw) {
      logger.warn(`[playwright.agent] phase 1.7: page study response unparseable — retrying with simpler prompt. Raw (first 300 chars): ${_studyRaw.slice(0, 300)}`);
      const _retryRaw = await askWithMessages([
        { role: 'system', content: 'Respond with ONLY a JSON object, no markdown fences, no explanation. Format: {"pageType":"...","rightPage":true,"confidence":0.9,"keyElements":[{"ref":"...","role":"...","label":"...","purpose":"..."}],"expectedFlow":["..."],"potentialBlockers":["..."],"wrongPageReason":null}' },
        { role: 'user', content: `GOAL: ${_finalGoal}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(currentSnapshot)).slice(0, 2000)}\n\nReturn the JSON object now.` },
      ], { temperature: 0, maxTokens: 800, responseTimeoutMs: 15000 });
      _pageStudy = parseJson(_retryRaw);
      if (_pageStudy) {
        logger.info(`[playwright.agent] phase 1.7: page study succeeded on retry — pageType=${_pageStudy.pageType}`);
      } else {
        logger.warn(`[playwright.agent] phase 1.7: page study retry also unparseable. Raw retry (first 300 chars): ${(_retryRaw || '').slice(0, 300)}`);
      }
    }
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

  // ── Tier 1.8 + Tier 1.9: DISABLED — multi-step goals fall through to Phase 2 turn-loop ──
  // Tier 1.8 (Visual Discovery Loop, _executeVisualDiscoveryLoop) and Tier 1.9
  // (LiteParser-First Loop, _executeLiteparseFirstLoop) were alternative multi-step
  // executors that ran before Phase 2. They were insufficiently tested and produced
  // brittle clicks (e.g. repeatedly clicking the global search field instead of the
  // playlist menu on Spotify). Phase 2 (Focused Plan-Execute / LLM turn-loop) handles
  // multi-step goals correctly and is the canonical executor.
  // Function definitions are preserved above for future re-enable.
  // To re-enable: set ENABLE_TIER18_19=1 (or remove the _tier18_19_Enabled guard).
  const _tier18_19_Enabled = process.env.ENABLE_TIER18_19 === '1';
  if (_tier18_19_Enabled && _preDecomposedSubTasks && _preDecomposedSubTasks.length > 1) {
    const _visualDiscoveryEnabled = process.env.ENABLE_VISUAL_DISCOVERY !== 'false';

    // ── Tier 1.8: Visual Discovery Loop (primary) ──────────────────────────
    if (_visualDiscoveryEnabled) {
      logger.info(`[playwright.agent] Tier 1.8: multi-step goal detected (${_preDecomposedSubTasks.length} sub-tasks) — trying Visual Discovery loop`);
      try {
        const _vdResult = await _executeVisualDiscoveryLoop({
          goal: _finalGoal,
          verificationGoal: effectiveGoal,
          sessionId,
          headed,
          timeoutMs,
          agentContext,
          deadline: _deadline,
          start,
          heartbeat: _heartbeat,
          hostname,
          _preDecomposedSubTasks,
          _progressCallbackUrl,
          _stepIndex,
        });
        if (_vdResult.ok) {
          _vdResult.executionTime = Date.now() - start;
          _heartbeat.stop();
          return _vdResult;
        }
        logger.warn(`[playwright.agent] Tier 1.8 failed: ${_vdResult.error || 'unknown'} — falling through to Tier 1.9`);
        // Pass sub-tasks + transcript to Tier 1.9 so it doesn't re-decompose
        if (_vdResult.subTasks) {
          _preDecomposedSubTasks = _vdResult.subTasks;
        }
      } catch (_vdErr) {
        logger.warn(`[playwright.agent] Tier 1.8 error: ${_vdErr.message} — falling through to Tier 1.9`);
      }
    }

    // ── Tier 1.9: LiteParser-First Action Loop (fallback) ──────────────────
    logger.info(`[playwright.agent] Tier 1.9: trying LiteParser-first loop${_visualDiscoveryEnabled ? ' (fallback after Tier 1.8)' : ' (primary — visual discovery disabled)'}`);
    try {
      const _lpResult = await _executeLiteparseFirstLoop({
        goal: _finalGoal,
        verificationGoal: effectiveGoal,
        sessionId,
        headed,
        timeoutMs,
        agentContext,
        deadline: _deadline,
        start,
        heartbeat: _heartbeat,
        hostname,
        _preDecomposedSubTasks,
        _progressCallbackUrl,
        _stepIndex,
      });
      if (_lpResult.ok) {
        _lpResult.executionTime = Date.now() - start;
        _heartbeat.stop();
        return _lpResult;
      }
      logger.warn(`[playwright.agent] Tier 1.9 failed: ${_lpResult.error || 'unknown'} — falling through to Phase 2`);
      // Pass sub-tasks + transcript to Tier 2 so it doesn't re-decompose
      if (_lpResult.subTasks) {
        _preDecomposedSubTasks = _lpResult.subTasks;
      }
    } catch (_lpErr) {
      logger.warn(`[playwright.agent] Tier 1.9 error: ${_lpErr.message} — falling through to Phase 2`);
    }
  } else if (_preDecomposedSubTasks && _preDecomposedSubTasks.length > 1) {
    logger.info(`[playwright.agent] Tier 1.8/1.9 disabled (ENABLE_TIER18_19!=1) — multi-step goal falling through to Phase 2 turn-loop`);
  } else {
    logger.info(`[playwright.agent] Tier 1.8/1.9: skipping (single-step or no sub-tasks) — falling through to Phase 2`);
  }

  // ── NOTE: Tier 1.6 (Structured OCR Overlay) was previously a pre-Phase-2 gate
  // that tried to detect overlay tasks from the goal text. It always failed
  // because no overlay was open yet (the page just loaded). Tier 1.6 is now
  // integrated INTO the turn-loop's open-menu detection — it fires when
  // _detectOpenMenus finds an open menu, OCRs the menu region, restructures
  // via ocrOverlayStructure.cjs, and asks the LLM to pick the right row.
  // See _executeOverlayInteraction + the turn-loop open-menu handler.

  // ── Phase 2: Focused Plan-Execute loop with re-study/re-plan on state changes ──
  // Plan-Execute is run repeatedly. After each attempt:
  //   - If goal is verified (ok=true), return immediately
  //   - If state changed significantly (URL, body length >200, modal count), re-study and re-run
  //   - If state did not change or max attempts reached, break and fall back to turn-loop
  logger.info(`[playwright.agent] phase 2: URL-first tiers did not complete - trying focused Plan-Execute (loop)`);

  let _ocrTextForPE = '';
  let _domSignalsForPE = '';
  async function _refreshPeInputs() {
    _ocrTextForPE = '';
    _domSignalsForPE = '';
    try {
      const _pePage = engine.getPage(sessionId);
      if (_pePage) {
        const _cap = await _ocrCaptureViaPage(sessionId).catch(() => ({ ok: false }));
        if (_cap.ok) _ocrTextForPE = _cap.text.slice(0, 1500);
        const _signals = await _pePage.evaluate(() => {
          const signals = [];
          function makeSelector(el) {
            if (el.id) return `#${el.id}`;
            const parts = [el.tagName.toLowerCase()];
            if (el.getAttribute('aria-label')) parts.push(`[aria-label='${el.getAttribute('aria-label')}']`);
            else if (el.getAttribute('contenteditable')) parts.push(`[contenteditable='${el.getAttribute('contenteditable')}']`);
            else if (el.getAttribute('role')) parts.push(`[role='${el.getAttribute('role')}']`);
            return parts.join('');
          }
          document.querySelectorAll('[contenteditable], [aria-expanded], [aria-modal], [placeholder], [aria-placeholder]').forEach(el => {
            signals.push({ selector: makeSelector(el), tag: el.tagName, ce: el.getAttribute('contenteditable'), label: el.getAttribute('aria-label'), text: (el.innerText || '').slice(0, 40) });
          });
          return signals.slice(0, 15);
        }).catch(() => []);
        if (_signals.length > 0) {
          _domSignalsForPE = _signals.map(s => `${s.selector} <${s.tag}>${s.ce ? ' ce=' + s.ce : ''}${s.label ? ' label="' + s.label + '"' : ''}${s.text ? ' text="' + s.text + '"' : ''}`).join('\n  ');
        }
      }
    } catch (_) {}
  }
  await _refreshPeInputs();

  const MAX_PE_ATTEMPTS = 3;
  let _peAttempt = 0;
  let _lastPeState = { url: '', bodyLen: 0, modalCount: 0 };
  let _peLoopResult = null;
  let _peLoopStudyBlock = _studyBlock;

  // ── Session-scoped "failed approaches" ledger (process of elimination) ──
  // Top-level helpers (_failedApproaches, _recordFailedApproach,
  // _formatFailedApproachesBlock) are defined above _executeTurnLoopFallback
  // so both the turn-loop and Plan-Execute can access them. Reset per run.
  _failedApproaches = [];

  // Capture initial state
  try {
    const _pePage0 = engine.getPage(sessionId);
    if (_pePage0) {
      _lastPeState = await _pePage0.evaluate(() => ({
        url: window.location.href,
        bodyLen: (document.body.innerText || '').length,
        modalCount: document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').length,
      })).catch(() => _lastPeState);
    }
  } catch (_) {}

  while (_peAttempt < MAX_PE_ATTEMPTS) {
    _peAttempt++;
    logger.info(`[playwright.agent] phase 2: Plan-Execute attempt ${_peAttempt}/${MAX_PE_ATTEMPTS}`);

    let _peResult = null;
    try {
      _peResult = await _focusedPlanExecute({
        goal: _finalGoal,
        verificationGoal: effectiveGoal,
        sessionId,
        headed,
        timeoutMs,
        agentContext,
        deadline: _deadline,
        start,
        heartbeat: _heartbeat,
        _ocrText: _ocrTextForPE,
        _domSignals: _domSignalsForPE,
        pageStudyBlock: _peLoopStudyBlock,
        domainLockBlock,
        failedApproachesBlock: _formatFailedApproachesBlock(),
        recordFailedApproach: _recordFailedApproach,
      });

      if (_peResult && _peResult.ok) {
        _peResult.executionTime = Date.now() - start;
        _heartbeat.stop();
        return _peResult;
      }
      _peLoopResult = _peResult;
      logger.warn(`[playwright.agent] focused Plan-Execute attempt ${_peAttempt} failed: ${_peResult?.error || 'unknown'}`);
      // Record failed approach in the session ledger (process of elimination)
      const _stepsSummary = (_peLoopResult?.transcript || [])
        .filter(t => t.action?.action && t.action.action !== 'replan')
        .slice(0, 5)
        .map(t => `${t.action.action}${t.action.selector ? `(${t.action.selector})` : ''}${t.action.text ? ` "${t.action.text}"` : ''}`)
        .join(', ');
      _recordFailedApproach(
        `Plan-Execute attempt ${_peAttempt}: ${_stepsSummary || 'unknown steps'}`,
        _peLoopResult?.error || 'goal not met',
        ''
      );
    } catch (_peErr) {
      logger.warn(`[playwright.agent] focused Plan-Execute attempt ${_peAttempt} error: ${_peErr.message}`);
      _peLoopResult = { ok: false, error: _peErr.message };
      _recordFailedApproach(`Plan-Execute attempt ${_peAttempt}`, _peErr.message, '');
    }

    // Decide whether to re-study and re-plan
    let _peEndState = { url: '', bodyLen: 0, modalCount: 0 };
    try {
      const _pePage1 = engine.getPage(sessionId);
      if (_pePage1) {
        _peEndState = await _pePage1.evaluate(() => ({
          url: window.location.href,
          bodyLen: (document.body.innerText || '').length,
          modalCount: document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]').length,
        })).catch(() => _peEndState);
      }
    } catch (_) {}

    const _urlChanged = _peEndState.url && _lastPeState.url && _peEndState.url !== _lastPeState.url;
    const _bodyChanged = Math.abs((_peEndState.bodyLen || 0) - (_lastPeState.bodyLen || 0)) > 200;
    const _modalChanged = _peEndState.modalCount !== _lastPeState.modalCount;
    const _stateChanged = _urlChanged || _bodyChanged || _modalChanged;

    if (!_stateChanged || _peAttempt >= MAX_PE_ATTEMPTS) {
      logger.warn(`[playwright.agent] phase 2: Plan-Execute loop stopping — stateChanged=${_stateChanged}, attempts=${_peAttempt}`);
      break;
    }

    _lastPeState = _peEndState;
    logger.info(`[playwright.agent] phase 2: state changed during Plan-Execute (url: ${_urlChanged}, body: ${_lastPeState.bodyLen}→${_peEndState.bodyLen}, modals: ${_lastPeState.modalCount}→${_peEndState.modalCount}) — re-studying page and re-planning`);

    // Refresh snapshot for the new page state
    try {
      const _reSnap = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 }).catch(() => ({ ok: false }));
      if (_reSnap.ok && _reSnap.result) currentSnapshot = _reSnap.result;
    } catch (_) {}

    // Re-run page study on the new page state
    try {
      const _reStudyRefs = pruneSnapshot(extractInteractiveRefs(currentSnapshot));
      logger.info(`[playwright.agent] phase 2-replan: extracted refs (${_reStudyRefs.length} chars, first 500): ${_reStudyRefs.slice(0, 500)}`);
      const _reStudyRaw = await askWithMessages([
        { role: 'system', content: PAGE_STUDY_PROMPT + domainLockBlock },
        { role: 'user',   content: `GOAL: ${_finalGoal}\n\nSNAPSHOT:\n${_reStudyRefs}` },
      ], { temperature: 0.1, maxTokens: 1000, responseTimeoutMs: 15000 });
      let _rePageStudy = parseJson(_reStudyRaw);
      if (!_rePageStudy && _reStudyRaw) {
        logger.warn(`[playwright.agent] phase 2-replan: re-study response unparseable — retrying with minimal prompt. Raw (first 300 chars): ${_reStudyRaw.slice(0, 300)}`);
        const _minimalRaw = await askWithMessages([
          { role: 'system', content: 'Return valid JSON only, no markdown, no prose: {"pageType":"...","rightPage":true,"confidence":0.9,"keyElements":[{"ref":"...","label":"...","purpose":"..."}],"expectedFlow":["..."],"potentialBlockers":[]}' },
          { role: 'user', content: `GOAL: ${_finalGoal}\n\nSNAPSHOT:\n${_reStudyRefs.slice(0, 1500)}\n\nReturn only the JSON.` },
        ], { temperature: 0, maxTokens: 600, responseTimeoutMs: 10000 });
        _rePageStudy = parseJson(_minimalRaw);
      }
      if (_rePageStudy && typeof _rePageStudy === 'object') {
        logger.info(`[playwright.agent] phase 2-replan: re-study — pageType=${_rePageStudy.pageType}, confidence=${_rePageStudy.confidence}, elements=${_rePageStudy.keyElements?.length || 0}`);
        logger.info(`[playwright.agent] phase 2-replan: re-study details: ${JSON.stringify(_rePageStudy).slice(0, 800)}`);
        _peLoopStudyBlock = `\nPAGE ANALYSIS (from pre-plan study phase — use this to guide your plan):\n- Page type: ${_rePageStudy.pageType || 'unknown'}\n- Right page: ${_rePageStudy.rightPage}\n- Confidence: ${_rePageStudy.confidence}\n- Key elements: ${JSON.stringify((_rePageStudy.keyElements || []).slice(0, 10))}\n- Expected flow: ${(_rePageStudy.expectedFlow || []).join(' → ')}\n- Potential blockers: ${(_rePageStudy.potentialBlockers || []).join('; ')}\n`;
      } else {
        logger.warn(`[playwright.agent] phase 2-replan: re-study response unparseable after retry — proceeding without`);
      }
    } catch (_reStudyErr) {
      logger.warn(`[playwright.agent] phase 2-replan: re-study failed (non-fatal): ${_reStudyErr.message}`);
    }

    // Refresh OCR + DOM signals for the next Plan-Execute attempt
    await _refreshPeInputs();
  }

  // Preserve text-already-entered signal for the turn-loop
  if (_peLoopResult?.transcript) {
    const _typedText = _peLoopResult.transcript.some(t =>
      t.outcome?.ok && ['type', 'fill', 'reactFill'].includes(t.action?.action)
    );
    const _failReason = String(_peLoopResult.error || '');
    if (_typedText && /text still in compose|not sent|not completed/i.test(_failReason)) {
      _textAlreadyEntered = true;
      logger.info(`[playwright.agent] Plan-Execute typed text but failed verification (${_failReason.slice(0, 60)}) — setting _textAlreadyEntered=true for turn-loop`);
    }
  }

  // ── Phase 2a: State-Diff Loop (gated behind flag) ────────────────────────
  // State-aware loop: captures DOM+LiteParser at sub-task boundaries, uses
  // cheap DOM-hash diffs between actions to detect no-ops, and verifies the
  // expected after-state before moving on. Falls back to the turn-loop if it
  // can't complete. Uses _resolveActionTarget for ambiguous clickByText targets.
  // Disabled by default — set ENABLE_STATE_DIFF_LOOP=true to enable.
  const _stateDiffLoopEnabled = process.env.ENABLE_STATE_DIFF_LOOP === 'true';
  if (_stateDiffLoopEnabled) {
    logger.info(`[playwright.agent] phase 2a: Plan-Execute did not complete - trying state-diff loop`);
    try {
      const _sdResult = await _executeStateDiffLoop({
        goal: _finalGoal,
        verificationGoal: effectiveGoal,
        sessionId,
        headed,
        timeoutMs,
        agentContext,
        deadline: _deadline,
        start,
        heartbeat: _heartbeat,
        hostname,
        _preDecomposedSubTasks,
        _progressCallbackUrl,
        _stepIndex,
      });
      if (_sdResult.ok) {
        _sdResult.executionTime = Date.now() - start;
        _heartbeat.stop();
        return _sdResult;
      }
      logger.warn(`[playwright.agent] state-diff loop failed: ${_sdResult.error || 'unknown'} — falling back to turn-loop`);
      // Pass state-diff sub-tasks + transcript to the turn-loop so it doesn't
      // re-decompose or re-do completed sub-tasks.
      if (_sdResult.subTasks) {
        _preDecomposedSubTasks = _sdResult.subTasks;
      }
    } catch (_sdErr) {
      logger.warn(`[playwright.agent] state-diff loop error: ${_sdErr.message} — falling back to turn-loop`);
    }
  } else {
    logger.info(`[playwright.agent] phase 2a: state-diff loop disabled (set ENABLE_STATE_DIFF_LOOP=false to disable)`);
  }

  // ── Phase 2b: Mini turn-loop (2-3 turns, last resort) ──────────────────
  // Focused prompt: "step X failed, what's the ONE action to take?"
  // Only triggered when Plan-Execute fails.
  logger.info(`[playwright.agent] phase 2b: Plan-Execute did not complete - starting turn-loop (max ${maxTurns} turns)`);
  try {
    const _turnLoopResult = await _executeTurnLoopFallback({
      goal: _finalGoal,
      verificationGoal: effectiveGoal,
      extractedText: _extractedComposeText,
      textAlreadyEntered: _textAlreadyEntered,
      heartbeat: _heartbeat,
      sessionId,
      headed,
      timeoutMs,
      agentContext,
      transcript: [],
      deadline: _deadline,
      maxTurns,
      start,
      hostname,
      _preDecomposedSubTasks,
      _progressCallbackUrl,
      _stepIndex,
      _abortSignal,
    });
    if (_turnLoopResult.ok) {
      _turnLoopResult.executionTime = Date.now() - start;
      _heartbeat.stop();
      return _turnLoopResult;
    }
    // If the user cancelled, return a clean cancelled result instead of
    // surfacing an ask_user failure card (which would prompt LLM recovery).
    if (_aborted()) {
      logger.info(`[playwright.agent] cancelled by user after turn-loop — returning cancelled result`);
      _heartbeat.stop();
      try { await browserAct({ action: 'close', sessionId }); } catch (_) {}
      return { ok: false, goal, sessionId, error: 'Cancelled by user', cancelled: true, turns: transcript.length, transcript, executionTime: Date.now() - start };
    }
    logger.warn(`[playwright.agent] turn-loop failed: ${_turnLoopResult.error || 'unknown'} - surfacing ask_user`);
    _heartbeat.stop();
    return { ..._failureAskUser(`Turn-loop failed: ${_turnLoopResult.error || 'could not complete task'}`, _turnLoopResult.partialProgress), executionTime: Date.now() - start };
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

DO NOT navigate anywhere. DO NOT click any button to open a composer — it is ALREADY OPEN.
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
    { role: 'user',   content: `GOAL: ${_finalGoal}${_studyBlock}${_activeElBlock}${failedApproachesBlock || ''}\n\nSNAPSHOT:\n${pruneSnapshot(extractInteractiveRefs(_planningSnapshot))}${agentContext ? `\n\nAGENT CONTEXT (agent instructions — follow these for site-specific behaviour):\n${agentContext}` : ''}` },
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
                  modalCount: document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"]').length,
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
            maxTurns,
            hostname,
            _preDecomposedSubTasks,
            _abortSignal,
          });
          if (_turnLoopResult.ok) {
            logger.info(`[playwright.agent] turn-loop fallback succeeded — returning`);
            return _turnLoopResult;
          }
          logger.warn(`[playwright.agent] turn-loop fallback failed: ${_turnLoopResult.error} — surfacing ask_user`);
        } catch (_turnLoopErr) {
          logger.warn(`[playwright.agent] turn-loop fallback threw: ${_turnLoopErr.message} — surfacing ask_user`);
        }
        return { ..._failureAskUser(`Step ${stepIndex + 1} (${step.action}) failed: ${outcome.error}`, _turnLoopResult?.partialProgress), transcript };
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
              _hasModal = await _ePage2.evaluate(() => !!document.querySelector('[role="dialog"], [aria-modal="true"], [data-testid*="modal"], [data-testid*="share"]'));
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
            maxTurns,
            hostname,
            _preDecomposedSubTasks,
            _abortSignal,
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
    // EXCEPTION: For mutation tasks (post/share/send/submit), ALWAYS run verification —
    // even if finalResult is long (e.g. from getPageText on the wrong page). This catches
    // false-positive completions where the agent declared done without actually performing
    // the mutation (e.g. blocked by a modal, navigated to wrong page).
    // ---------------------------------------------------------------------------
    const _isMutationGoal = /\b(post|share|publish|submit|send|tweet|comment|reply)\b/i.test(goal);
    const _shouldVerify = !_emailAlreadySent && (_isMutationGoal || !finalResult || finalResult.length <= 100);
    if (_shouldVerify) {
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
          maxTurns,
          hostname,
          _preDecomposedSubTasks,
          _abortSignal,
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
  // URL comparison helpers (exported for testing)
  _urlsEqual,
  _isCanonicalRedirect,
  // Tier 1.6 overlay interaction (exported for instruction.runner.cjs)
  _detectOverlayRect,
  _executeOverlayInteraction,
};
