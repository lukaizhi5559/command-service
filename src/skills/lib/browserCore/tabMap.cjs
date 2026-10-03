'use strict';

// ---------------------------------------------------------------------------
// browserCore/tabMap.cjs — Tab-Map scan + pick + act engine for atomic agents.
// Extracted from instruction.runner.cjs: buildTabMap (focus-cycle + DOM-overlay
// scans, data-td-ref tagging), tab-map persistence, LLM picking/matching, the
// per-action dispatcher (_executeTabMapAction) and inner step (_tabMapInnerStep).
// Runner internals are lazy-proxied via _r() to avoid circular module loads.
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { browserAct } = require('../../browser.act.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { askWithMessages } = require('../../../skill-helpers/skill-llm.cjs');
const { _tabToRef, _slimReadActiveElement, ensureFieldFocused } = require('./focusField.cjs');
const { _executeJustType } = require('./typing.cjs');

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _R = null;
const _r = () => (_R ||= require('../../instruction.runner.cjs'));
const _emitProgress = (...a) => _r()._emitProgress(...a);
const _getUrl = (...a) => _r()._getUrl(...a);
const _urlsEquivalent = (...a) => _r()._urlsEquivalent(...a);
const _readActiveElement = (...a) => _r()._readActiveElement(...a);
const { _parseAction } = require('./actionParse.cjs');
const { DIALOG_SELECTOR, FILLABLE_SELECTOR, probeDialogContainer, hasVisibleDialog: _probeDialog, resolveUnnamedFillable } = require('./overlayProbe.cjs');
const { inferEntryKind, entryLabel, GENERIC_KIND_TARGETS } = require('./elementKind.cjs');
const _executeAction = (...a) => _r()._executeAction(...a);
const _extractProductPath = (...a) => _r()._extractProductPath(...a);
const _verifySubmitSuccess = (...a) => _r()._verifySubmitSuccess(...a);

// Real submit/primary-action labels — EXACT match only. Substring matching
// (/post/) false-positive'd on audience selectors like LinkedIn's
// "Post to Anyone" chip (opened a dropdown, then verified a fake submit).
const _submitLabels = /^(Post|Send|Submit|Publish|Save|Create|Share|Tweet|Schedule|Confirm|Apply|Continue|Post\s+it|Send\s+now|Save\s+changes)$/i;


// Reset focus to a known starting point.
// Playwright's `page.keyboard.press` sends keys to the page DOM, not the
// browser chrome, so `Meta+L`/`Ctrl+L`/`F6` cannot focus the address bar.
// Instead we blur any focused page element and scroll to the top-left, then
// the next Tab starts from the first focusable element in the page tab order.
async function _resetFocusToPageTop(sessionId) {
  // 1. Send Escape to close any open overlays/menus that might trap focus
  try { await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 1500 }); } catch {}
  await _sleep(100);

  // 2. Scroll to top
  await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
    text: `(() => { window.scrollTo(0, 0); })()`,
  });
  await _sleep(50);

  // 3. Real Playwright click at the top-left of the viewport to move focus out of
  //    the browser address bar and into the page at the very top. page.click('body')
  //    landed in the scrolled middle of the page, so we use a fixed top-left point.
  try {
    logger.info(`[instruction.runner] Reset: real Playwright click at top-left (10, 60)`);
    await browserAct({ action: 'clickAt', sessionId, x: 10, y: 60, headed: true, timeoutMs: 3000 });
  } catch (e) {
    logger.info(`[instruction.runner] Reset: clickAt failed: ${e.message}`);
  }
  await _sleep(100);

  // 4. Blur any focused element and scroll to top after the real click
  await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
    text: `(() => {
      const el = document.activeElement;
      if (el && el !== document.body && el !== document.documentElement) { el.blur(); }
      window.scrollTo(0, 0);
    })()`,
  });
  await _sleep(150);

  const focused = await _readActiveElement(sessionId);
  logger.info(`[instruction.runner] Reset to page top — focused: "${focused?.text || '(none/body)'}"`);
}

// Focus an element by its data-td-ref attribute.
// Used by buildTabMap to reset focus back to the ArrowRight origin element
// when ArrowRight didn't advance (prevents getting stuck in a sub-region).


// Focus an element by its data-td-ref attribute.
// Used by buildTabMap to reset focus back to the ArrowRight origin element
// when ArrowRight didn't advance (prevents getting stuck in a sub-region).
async function _focusByRef(sessionId, ref) {
  if (!ref) return false;
  try {
    await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => { const el = document.querySelector('[data-td-ref="${ref}"]'); if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'instant' }); return true; } return false; })()`,
    });
    await _sleep(60);
    return true;
  } catch { return false; }
}

// ── Tab-to-ref: navigate to a target ref via Tab/ArrowRight key presses ──
// Backup focus mechanism for React comboboxes (Gmail To/CC/BCC) where
// el.focus() (untrusted programmatic call) doesn't move document.activeElement,
// but Tab (trusted browser-level keyboard event) does. Uses the same
// ArrowRight→Tab sequence the Tab-Map scan uses, checking data-td-ref after
// each press until it matches the target ref.


// ── Bulk metadata extraction for buildTabMap ───────────────────────────
// After the fast focus-cycling phase assigns data-td-ref to all elements,
// this ONE call queries all [data-td-ref^="tm-"] elements and returns
// full metadata (tag, role, text, ariaLabel, placeholder, value, rect,
// inDropdown, isIconLike, hasSvg, etc.) as a JSON array.
// Replaces the per-element _readActiveElement calls (4KB each × N elements)
// with a single ~2KB query that runs once at the end.
async function _bulkReadTabMapMetadata(sessionId) {
  const res = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 5000,
    text: `(() => {
      const els = document.querySelectorAll('[data-td-ref^="tm-"]');
      const out = [];
      for (const el of els) {
        const ref = el.getAttribute('data-td-ref');
        const _role = el.getAttribute('role') || '';
        const _tag = el.tagName.toLowerCase();
        const _ariaRoleDescription = el.getAttribute('aria-roledescription') || '';
        let text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        if (!text && el.isContentEditable) {
          try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              let node = sel.getRangeAt(0).startContainer;
              if (node.nodeType === 3) node = node.parentElement;
              while (node && node !== el && node.parentElement !== el) node = node.parentElement;
              text = (node?.innerText || node?.textContent || '').trim();
            }
          } catch (_) {}
          if (!text) text = el.innerText;
        }
        if (!text) text = el.textContent || '';
        text = text.trim().replace(/\\s+/g, ' ')
          .replace(/\\b(?:shift|option|opt|alt|ctrl|control|cmd|command|meta)(?:\\s*\\+\\s*(?:shift|option|opt|alt|ctrl|control|cmd|command|meta|[a-z0-9]))*\\b/gi, '')
          .trim()
          .slice(0, 120);
        const r = el.getBoundingClientRect();
        const hasSvg = !!el.querySelector('svg');
        const ariaLabel = el.getAttribute('aria-label') || '';
        const isIconLike = text.length < 3 && (hasSvg || (r.width < 50 && r.height < 50) || _role === 'button' || el.tagName === 'BUTTON');
        const inDropdown = ['menuitem','menuitemcheckbox','menuitemradio','option'].includes(_role) ||
                           (!['input','textarea'].includes(_tag) && _role !== 'combobox' && _role !== 'textbox' &&
                            !!el.closest('[role="menu"], [role="listbox"]'));
        const _isContainer = el.querySelectorAll('[contenteditable="true"], [contenteditable=""]').length > 0;
        const _actualContent = (el.value !== undefined && el.value !== ''
          ? String(el.value)
          : (el.isContentEditable ? (el.innerText || el.textContent || '') : '')
        ).trim();
        const currentValue = (el.value !== undefined && el.value !== ''
          ? String(el.value)
          : (el.isContentEditable ? text : '')
        ).trim().replace(/\\s+/g, ' ').slice(0, 120);
        const hasContent = !_isContainer && _actualContent.length > 0;
        // Sponsored/ad detection: the element's own attributes don't carry this
        // — the "Sponsored" badge lives on a sibling node inside the result card.
        // Check explicit sponsored containers first (Amazon s-sponsored-result,
        // Google data-text-ad, FB ads), then look for a leaf badge whose text is
        // exactly "Sponsored"/"Ad" inside the nearest result-card ancestor.
        const _isSponsored = (() => {
          try {
            if (el.closest('[data-component-type="s-sponsored-result"], .s-sponsored-result, [data-sponsored], [data-text-ad], [data-ad], .ads-ad, [class*="sponsored" i]')) return true;
            const _card = el.closest('[data-asin], .s-result-item, [role="listitem"], article, li, .g');
            const _roots = _card && _card !== el ? [el, _card] : [el];
            for (const _root of _roots) {
              if (!_root || !_root.querySelectorAll) continue;
              if (_root.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored" i], [data-component-type*="sponsored" i]')) return true;
              let _n = 0;
              for (const _c of _root.querySelectorAll('span, div, a, i')) {
                if (++_n > 80) break;
                if (_c.children.length > 2) continue;
                const _t = (_c.textContent || '').trim();
                if (/^(sponsored|ad|advertisement|promoted|sponsored ad)$/i.test(_t)) return true;
              }
            }
            return false;
          } catch (_) { return false; }
        })();
        const _expanded = el.getAttribute('aria-expanded');
        out.push({
          ref, tag: _tag, role: _role, text,
          currentValue, hasContent,
          isSponsored: _isSponsored,
          isContentEditable: el.isContentEditable,
          ariaRoleDescription: _ariaRoleDescription,
          placeholder: el.getAttribute('placeholder') || '',
          dataPlaceholder: el.getAttribute('data-placeholder') || '',
          type: el.tagName === 'INPUT' ? (el.type || 'text') : '',
          ariaLabel,
          ariaAutoComplete: el.getAttribute('aria-autocomplete') || '',
          ariaOwns: el.getAttribute('aria-owns') || '',
          ariaControls: el.getAttribute('aria-controls') || '',
          // Element state signals — the LLM can't see a disabled Send, a
          // collapsed expander, or an already-focused field without them.
          disabled: !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'),
          expanded: _expanded === 'true' ? true : _expanded === 'false' ? false : undefined,
          checked: !!(el.checked || el.getAttribute('aria-checked') === 'true') || undefined,
          selected: el.getAttribute('aria-selected') === 'true' || undefined,
          pressed: el.getAttribute('aria-pressed') === 'true' || undefined,
          readOnly: !!(el.readOnly || el.getAttribute('aria-readonly') === 'true') || undefined,
          focused: el === document.activeElement || undefined,
          cursor: (() => { try { return getComputedStyle(el).cursor; } catch (_) { return ''; } })(),
          isIconLike, hasSvg, inDropdown,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        });
      }
      return JSON.stringify(out);
    })()`,
  });
  try {
    const raw = res?.result;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// Scroll the active element into the center of the viewport.
// Called after each Tab/Arrow key press so the focused element is always visible.
// Uses the browser's built-in scrollIntoView — no manual x/y math needed.


// Scroll the active element into the center of the viewport.
// Called after each Tab/Arrow key press so the focused element is always visible.
// Uses the browser's built-in scrollIntoView — no manual x/y math needed.
async function _scrollActiveIntoView(sessionId) {
  try {
    await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => { const el = document.activeElement; if (el && el !== document.body && el !== document.documentElement) el.scrollIntoView({ block: 'center', behavior: 'instant' }); })()`,
    });
  } catch { /* non-fatal — scroll failure shouldn't break navigation */ }
}

// ---------------------------------------------------------------------------
// LLM-guided focus verification
// ---------------------------------------------------------------------------

// LLM-guided match: ask the LLM if the focused element matches the target.
// Strict prompt with examples to prevent false positives.
// Uses session-level cache to avoid re-analyzing the same element for the same target.
// `focusedTag` and `focusedType` are included for context but element-type validation
// is handled by behavior-based probe (_isEditableByProbe), not the LLM.


// Generate a signature for an element to detect loops
function _elementSignature(el) {
  if (!el) return 'null';
  return `${el.tag}|${el.text || ''}|${el.x || 0},${el.y || 0}`;
}

// Distinguish a real focus change from a scroll-induced coordinate shift.
// If tag + text + x are the same but only y changed, the page scrolled
// (ArrowDown on a regular page) — not a real focus change.


// Distinguish a real focus change from a scroll-induced coordinate shift.
// If tag + text + x are the same but only y changed, the page scrolled
// (ArrowDown on a regular page) — not a real focus change.
function _isRealFocusChange(before, after) {
  if (!before) return !!after;
  if (!after) return false;
  // Same element but y changed = scroll, not focus change
  if (before.tag === after.tag &&
      (before.text || '') === (after.text || '') &&
      (before.x || 0) === (after.x || 0) &&
      (before.y || 0) !== (after.y || 0)) {
    return false; // scroll
  }
  return _elementSignature(before) !== _elementSignature(after);
}

// ---------------------------------------------------------------------------
// Fuzzy text matching — handles garbled training text where characters are
// dropped within words (e.g. "playli t" → "playlist", "ong" → "song").
// ---------------------------------------------------------------------------

// Normalize text: lowercase, remove all spaces and punctuation


// Normalize text: lowercase, remove all spaces and punctuation
function _normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Check if a is a subsequence of b (all chars of a appear in b in order)


// Check if a is a subsequence of b (all chars of a appear in b in order)
function _isSubsequence(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (a[i] === b[j]) i++;
  }
  return i === a.length;
}

// Levenshtein distance (edit distance) between two strings


// Levenshtein distance (edit distance) between two strings
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// Fuzzy match: returns true if target (garbled) likely refers to candidate (real).
// 1. Subsequence check: garbled text is a subsequence of real text (chars dropped)
// 2. Length guard: shorter string must be ≥ 70% of longer string's length
// 3. Levenshtein fallback: edit distance < 30% of longer string's length


// Fuzzy match: returns true if target (garbled) likely refers to candidate (real).
// 1. Subsequence check: garbled text is a subsequence of real text (chars dropped)
// 2. Length guard: shorter string must be ≥ 70% of longer string's length
// 3. Levenshtein fallback: edit distance < 30% of longer string's length
function _fuzzyTextMatch(target, candidate) {
  if (!target || !candidate) return false;
  const t = _normalizeText(target);
  const c = _normalizeText(candidate);
  if (t === c) return true;
  if (t.length === 0 || c.length === 0) return false;

  const longer = t.length >= c.length ? t : c;
  const shorter = t.length >= c.length ? c : t;

  // Length guard — too different in length = not a match
  // 0.5 threshold allows ~50% character dropping (garbled text from recorder)
  if (shorter.length < longer.length * 0.5) return false;

  // Subsequence check (handles character-dropping garbling)
  if (_isSubsequence(shorter, longer)) return true;

  // Levenshtein fallback
  const dist = _levenshtein(t, c);
  if (dist < longer.length * 0.3) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Tab-map persistence — save/load to ~/.thinkdrop/domain-maps/{domain}.tab-map.json
// ---------------------------------------------------------------------------

// Get the current domain from the browser session


// Get the current domain from the browser session
async function _getDomainFromSession(sessionId) {
  try {
    const result = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: 'window.location.hostname',
    });
    return result?.result || result?.value || null;
  } catch (e) {
    return null;
  }
}

// Get the path for the domain's tab-map file


// Get the path for the domain's tab-map file
function _tabMapFilePath(domain) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'domain-maps');
  return path.join(dir, `${domain}.tab-map.json`);
}

// Load the persisted tab-map for a domain (returns array of elements or empty)


// Load the persisted tab-map for a domain (returns array of elements or empty)
function _loadTabMap(domain) {
  if (!domain) return [];
  try {
    const filePath = _tabMapFilePath(domain);
    if (!fs.existsSync(filePath)) return [];
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data?.elements && Array.isArray(data.elements)) {
      logger.info(`[instruction.runner] Loaded tab-map for ${domain}: ${data.elements.length} elements`);
      return data.elements;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] Failed to load tab-map for ${domain}: ${e.message}`);
  }
  return [];
}

// Save the tab-map for a domain (merges new elements with existing ones)


// Save the tab-map for a domain (merges new elements with existing ones)
function _saveTabMap(domain, map) {
  if (!domain || !map || map.length === 0) return;
  try {
    const filePath = _tabMapFilePath(domain);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Load existing elements to merge
    let existing = [];
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        existing = data?.elements || [];
      }
    } catch (e) { /* ignore — start fresh */ }

    // Merge: add new elements (by signature) that don't exist in the persisted map
    const existingSigs = new Set(existing.map(e => `${e.tag}|${e.text || ''}|${e.x || 0},${e.y || 0}`));
    let added = 0;
    for (const el of map) {
      const sig = `${el.tag}|${el.text || ''}|${el.x || 0},${el.y || 0}`;
      if (!existingSigs.has(sig)) {
        existing.push({
          tag: el.tag,
          text: el.text || '',
          ariaLabel: el.ariaLabel || '',
          role: el.role || '',
          x: el.x || 0,
          y: el.y || 0,
          w: el.w || 0,
          h: el.h || 0,
          key: el.key || 'Tab',
        });
        existingSigs.add(sig);
        added++;
      }
    }

    const output = {
      domain,
      lastUpdated: new Date().toISOString(),
      elements: existing,
    };
    fs.writeFileSync(filePath, JSON.stringify(output, null, 2));
    logger.info(`[instruction.runner] Saved tab-map for ${domain}: ${existing.length} elements (${added} new)`);
  } catch (e) {
    logger.warn(`[instruction.runner] Failed to save tab-map for ${domain}: ${e.message}`);
  }
}

// Build a tab-map by scanning all focusable elements in the current state.
// Per-step fallback: ArrowRight → ArrowDown → Tab (each step tries all 3 keys).
//   - ArrowRight: enters dropdowns from trigger, horizontal menus
//   - ArrowDown: vertical lists (dropdowns, menus)
//   - Tab: general navigation (modals, page elements)
// Set-based deduplication: O(1) check for seen elements.
// Starter tracking: first element added to map; when we loop back to it,
//   the current region is fully scanned. Tab then exits to the next region.
// Safety cap: 150 elements (prevents scanning 30k YouTube comments).
// skipReset: when true, don't reset focus to page top (for scanning inside
//   an open dropdown/modal — resetting would close the overlay).


// Build a tab-map by scanning all focusable elements in the current state.
// Per-step fallback: ArrowRight → ArrowDown → Tab (each step tries all 3 keys).
//   - ArrowRight: enters dropdowns from trigger, horizontal menus
//   - ArrowDown: vertical lists (dropdowns, menus)
//   - Tab: general navigation (modals, page elements)
// Set-based deduplication: O(1) check for seen elements.
// Starter tracking: first element added to map; when we loop back to it,
//   the current region is fully scanned. Tab then exits to the next region.
// Safety cap: 150 elements (prevents scanning 30k YouTube comments).
// skipReset: when true, don't reset focus to page top (for scanning inside
//   an open dropdown/modal — resetting would close the overlay).
async function buildTabMap(sessionId, maxElements = 150, options = {}) {
  const { skipReset = false, backward = false, continuation = null } = options;
  const map = [];

  // ── Stale-ref invalidation ───────────────────────────────────────────
  // data-td-ref attributes persist on DOM nodes across scans. When a page
  // re-renders or collapses a field between scans (e.g. Gmail's recipients
  // row hiding its input when focus leaves), a rescan would otherwise keep
  // finding the same now-hidden node — rescan becomes a no-op. Strip refs
  // from elements that are currently invisible/detached so the map reflects
  // real current state; still-visible nodes keep their refs (learned-skill
  // and cross-step reference stability).
  try {
    await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        let stripped = 0;
        for (const el of document.querySelectorAll('[data-td-ref]')) {
          const r = el.getBoundingClientRect();
          let vis = el.isConnected && r.width > 0 && r.height > 0;
          if (vis) { try { if (el.checkVisibility && !el.checkVisibility()) vis = false; } catch (_) {} }
          if (!vis) { el.removeAttribute('data-td-ref'); stripped++; }
        }
        return stripped;
      })()`,
    });
  } catch (_) { /* non-fatal — refs just may be stale this scan */ }

  // ── Page-density gating ──────────────────────────────────────────────
  // Abort Tab-Map scanning on dense commerce/product-grid pages where
  // scanning 150+ focusable elements is slow and unreliable. The LLM tier
  // selector should ESCALATE to Turn-Loop instead. We check the hostname
  // and the visible interactive element count before starting the scan.
  if (!continuation) {  // only gate on the first call, not paginated continuations
    try {
      const _hostRes = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.hostname' });
      const _host = _hostRes?.ok ? String(_hostRes.result || '').replace(/^"|"$/g, '').toLowerCase() : '';
      const _COMMERCE_HOSTS = /^(www\.)?(amazon|ebay|etsy|walmart|target|aliexpress|bestbuy|shopify|costco|homedepot|lowes)\./;
      if (_COMMERCE_HOSTS.test(_host)) {
        // Count visible interactive elements — if >80, abort Tab-Map.
        const _countRes = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: `(() => {
          const sel = 'a, button, [role="button"], [role="link"], [role="menuitem"], input:not([type="hidden"]), textarea, [contenteditable], [tabindex]:not([tabindex="-1"])';
          let n = 0;
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) n++;
          }
          return n;
        })()` });
        const _interactiveCount = _countRes?.ok ? parseInt(String(_countRes.result || '').replace(/^"|"$/g, ''), 10) || 0 : 0;
        if (_interactiveCount > 80) {
          logger.info(`[instruction.runner] buildTabMap: dense grid abort — host=${_host}, interactiveCount=${_interactiveCount} (>80) — returning empty map (ESCALATE to Turn-Loop)`);
          return [];  // empty array — caller will see 0 elements and the tier selector will ESCALATE
        }
      }
    } catch (_gateErr) {
      // Non-fatal — proceed with normal Tab-Map if the gate check fails
      logger.debug(`[instruction.runner] buildTabMap: density gate check failed (non-fatal): ${_gateErr.message}`);
    }
  }

  // Pagination: when `continuation` is provided, seed seenSet/starterSig/idCounter
  // from the previous page so we dedupe against already-seen elements and
  // terminate only when Tab loops back to the ORIGINAL starter (true whole-
  // page coverage), not a per-call starter. `_loopedBack` is set when that
  // original-starter loop-back happens — the caller uses it to decide between
  // paginating (more pages) vs. marking Tab-Map exhausted for this state.
  const seenSet = continuation?.seenSet ? continuation.seenSet : new Set();
  let idCounter = continuation?.startId ? continuation.startId : 0;
  let starterSig = continuation?.starterSig ? continuation.starterSig : null; // original starter — whole-page loop-back signal
  let _loopedBack = false; // set true when Tab hits the original starter
  let dropdownArrowCount = 0;        // count ArrowDown/ArrowUp used in current dropdown
  const DROPDOWN_ARROW_LIMIT = 5;    // max ArrowDown attempts before forcing exit
  let _prevInDropdown = false;       // track previous dropdown state to reset counter
  let _tabThroughSeenCount = 0;      // count Tab landing on seen elements (tab-row escape)

  // Key mappings: forward vs backward
  const keyRight = backward ? 'ArrowLeft'  : 'ArrowRight';
  const keyDown  = backward ? 'ArrowUp'    : 'ArrowDown';
  const keyTab   = backward ? 'Shift+Tab'  : 'Tab';
  const label    = backward ? 'backward'   : 'forward';

  // If starting inside a dropdown and skipReset, exit it first (press Escape)
  if (skipReset) {
    const _preEl = await _readActiveElement(sessionId);
    if (_preEl?.inDropdown) {
      logger.info(`[instruction.runner] buildTabMap (${label}): starting inside a dropdown — pressing Escape to exit`);
      await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
      await _sleep(100);
    }
  }

  // If skipReset but focus is trapped in a canvas/grid (document editors:
  // spreadsheets, code editors, doc editors load with canvas focus), break
  // out by clicking at the top-left of the page where chrome/toolbar lives.
  // Don't press Escape (could close a real overlay). Without this, Tab
  // navigates within the canvas and finds 0 chrome elements.
  if (skipReset) {
    const _preEl2 = await _readActiveElement(sessionId);
    const _isCanvasFocus = _preEl2 && (
      _preEl2.role === 'grid' || _preEl2.role === 'gridcell' ||
      _preEl2.tag === 'canvas' ||
      // Spreadsheet cells are often div[role=textbox] inside [role=grid]
      (_preEl2.role === 'textbox' && _preEl2.tag === 'div') ||
      // Code editors: textarea inside .cm-editor/.monaco-editor
      _preEl2.tag === 'textarea'
    );
    if (_isCanvasFocus) {
      logger.info(`[instruction.runner] buildTabMap (${label}): focus trapped in canvas/grid (tag=${_preEl2.tag}, role=${_preEl2.role}) — clicking top-left to break out`);
      try {
        await browserAct({ action: 'clickAt', sessionId, x: 10, y: 60, headed: true, timeoutMs: 3000 });
        await _sleep(200);
      } catch (e) {
        logger.warn(`[instruction.runner] buildTabMap: canvas break-out click failed: ${e.message}`);
      }
      const _postEl = await _readActiveElement(sessionId);
      logger.info(`[instruction.runner] buildTabMap: after break-out — focus tag=${_postEl?.tag || 'none'}, role=${_postEl?.role || 'none'}, text="${_postEl?.text || ''}"`);
    }
  }

  if (!skipReset) {
    await _resetFocusToPageTop(sessionId);
  }

  // ── Scan flow: ArrowRight → Tab by default, ArrowDown only in dropdowns ──
  // ArrowDown opens autocomplete on comboboxes and can select wrong items.
  // Only use ArrowDown when the focused element is inside a dropdown (detected
  // via ARIA roles: menuitem/option, or inside role=menu/listbox and not an input).
  // ArrowRight is always safe — it enters dropdowns from triggers and moves
  // horizontally in menus without opening autocomplete.
  //
  // PHASE A (fast): Use _slimReadActiveElement (~400 byte script) for loop
  // control — only needs { ref, role, tag, text, x, y, inDropdown } for
  // dedup, dropdown detection, and focus-change detection. Full metadata
  // is extracted in bulk AFTER the scan via _bulkReadTabMapMetadata.
  const _initialEl = await _slimReadActiveElement(sessionId);
  logger.info(`[instruction.runner] buildTabMap: initial focus tag=${_initialEl?.tag || 'none'}, role=${_initialEl?.role || 'none'}, inDropdown=${!!_initialEl?.inDropdown}`);

  for (let i = 0; i < maxElements; i++) {
    const before = await _slimReadActiveElement(sessionId);
    let current = before; // tracks current focus position (may shift via arrows)
    let advanced = false;
    const _inDropdown = !!before?.inDropdown;
    const _arrowRightOriginRef = before?.ref || null; // ref before ArrowRight pressed

    // Reset dropdown arrow counter when focus leaves a dropdown
    if (!_inDropdown && _prevInDropdown) {
      dropdownArrowCount = 0;
    }
    _prevInDropdown = _inDropdown;

    // 1. Try ArrowRight (forward) / ArrowLeft (backward) — always safe
    await browserAct({ action: 'press', sessionId, key: keyRight, headed: true, timeoutMs: 2000 });
    await _sleep(20);
    let after = await _slimReadActiveElement(sessionId);

    if (_isRealFocusChange(current, after)) {
      const sig = after?.ref || _elementSignature(after);
      if (!seenSet.has(sig)) {
        // New element — add to set + map
        seenSet.add(sig);
        if (!starterSig) starterSig = sig;
        map.push({ id: ++idCounter, ...after, key: keyRight });
        advanced = true;
      } else {
        // Seen element — check if it's the starter (looped back)
        if (sig === starterSig) {
          // ArrowRight cycled back to the starter. This often happens in
          // tab-rows (e.g., Google Calendar create dialog: Event → Task →
          // Appointment schedule → Event). Do NOT end the scan here —
          // reset focus to the origin tab and fall through to Tab so the
          // scan continues into the tab panel's form fields.
          logger.info(`[instruction.runner] buildTabMap (${label}): ${keyRight} looped back to starter (ref=${sig}) — resetting to origin, falling through to Tab`);
          if (_arrowRightOriginRef) {
            await _focusByRef(sessionId, _arrowRightOriginRef);
            current = before; // restore to pre-ArrowRight position
          } else {
            current = after;
          }
          // Do NOT set advanced=true; do NOT break. Fall through to Tab.
        } else {
          // Seen but not starter — ArrowRight landed on a seen element.
          // Reset focus back to the ArrowRight origin so Tab starts from there
          // (prevents getting stuck in a sub-region / dropdown remnant).
          if (_arrowRightOriginRef) {
            logger.info(`[instruction.runner] buildTabMap (${label}): ${keyRight} landed on seen element — resetting focus to origin (${_arrowRightOriginRef})`);
            await _focusByRef(sessionId, _arrowRightOriginRef);
            current = before; // restore current to pre-ArrowRight position
          } else {
            current = after;
          }
        }
      }
    } else {
      // No focus change from ArrowRight — reset focus to origin before falling
      // through to Tab (prevents Tab from starting inside a sub-region).
      if (_arrowRightOriginRef) {
        await _focusByRef(sessionId, _arrowRightOriginRef);
        current = before;
      }
    }

    // 2. Try ArrowDown (forward) / ArrowUp (backward) — ONLY when in a dropdown
    // ArrowDown opens autocomplete on comboboxes and selects wrong items.
    // Only use it when the focused element is a menuitem/option or inside a
    // role=menu/listbox (and not an input/textarea/combobox).
    // Cap at DROPDOWN_ARROW_LIMIT attempts — if exceeded, press Escape to exit
    // the dropdown and continue scanning the main page.
    if (!advanced && _inDropdown) {
      dropdownArrowCount++;

      if (dropdownArrowCount > DROPDOWN_ARROW_LIMIT) {
        // Too many ArrowDown/Up in this dropdown — force exit
        logger.info(`[instruction.runner] buildTabMap (${label}): ${keyDown} limit reached (${DROPDOWN_ARROW_LIMIT}) — pressing Escape to exit dropdown`);
        await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
        await _sleep(100);
        dropdownArrowCount = 0;
        // Continue to Tab on the main page (don't set advanced — fall through)
      } else {
        await browserAct({ action: 'press', sessionId, key: keyDown, headed: true, timeoutMs: 2000 });
        await _sleep(20);
        after = await _slimReadActiveElement(sessionId);

        if (_isRealFocusChange(current, after)) {
          const sig = after?.ref || _elementSignature(after);
          if (!seenSet.has(sig)) {
            seenSet.add(sig);
            if (!starterSig) starterSig = sig;
            map.push({ id: ++idCounter, ...after, key: keyDown });
            advanced = true;
          } else {
            // Seen element — check if it's the starter (looped back)
            if (sig === starterSig) {
              logger.info(`[instruction.runner] buildTabMap (${label}): ${keyDown} looped back to starter (ref=${sig}) — exiting dropdown`);
              await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
              await _sleep(100);
              dropdownArrowCount = 0;
              // Don't break — continue to Tab on main page
            } else {
              // Seen but not starter — fall through to Tab
              current = after;
            }
          }
        }
      }
    }

    // 3. Try Tab (forward) / Shift+Tab (backward) — always
    // When Tab lands on seen elements (e.g., a tab-row already scanned by
    // ArrowRight), keep Tabbing in-place to escape into new form fields.
    if (!advanced) {
      let _tabRetries = 0;
      const _MAX_TAB_RETRIES = 5;
      while (_tabRetries <= _MAX_TAB_RETRIES) {
        await browserAct({ action: 'press', sessionId, key: keyTab, headed: true, timeoutMs: 2000 });
        await _sleep(20);
        after = await _slimReadActiveElement(sessionId);

        if (!after) break; // nothing focusable

        if (!_isRealFocusChange(current, after)) {
          // Tab didn't change focus — end of focusable elements
          break;
        }

        const sig = after?.ref || _elementSignature(after);
        if (!seenSet.has(sig)) {
          // New element — add and advance
          seenSet.add(sig);
          if (!starterSig) starterSig = sig;
          map.push({ id: ++idCounter, ...after, key: keyTab });
          advanced = true;
          break;
        }

        // Tab landed on a seen element
        if (sig === starterSig) {
          logger.info(`[instruction.runner] buildTabMap (${label}): Tab looped back to starter (ref=${sig}) — scan done`);
          _loopedBack = true;
          break;
        }

        // Seen but not starter — Tab through it to reach new fields beyond
        _tabRetries++;
        _tabThroughSeenCount++;
        logger.info(`[instruction.runner] buildTabMap (${label}): Tab landed on seen element (retry ${_tabRetries}/${_MAX_TAB_RETRIES}) — Tabbing past it`);
        current = after;
      }
    }

    // If nothing advanced, all keys led to seen elements or no change
    if (!advanced) break;
  }

  logger.info(`[instruction.runner] buildTabMap (${label}): scanned ${map.length} elements (cap=${maxElements}, skipReset=${skipReset})`);

  // ── PHASE B: Bulk metadata extraction ────────────────────────────────
  // The fast focus-cycling phase (Phase A) used _slimReadActiveElement which
  // only captured { ref, role, tag, text, x, y, inDropdown } — enough for
  // loop control but missing the full metadata the LLM needs (ariaLabel,
  // placeholder, value, bounding rect, isIconLike, hasSvg, currentValue,
  // hasContent, ariaRoleDescription, etc.).
  // Now run ONE bulk query to extract full metadata for all [data-td-ref^="tm-"]
  // elements and merge it back into the ordered map[] by ref.
  if (map.length > 0) {
    try {
      const _bulkStart = Date.now();
      const _bulkMeta = await _bulkReadTabMapMetadata(sessionId);
      if (_bulkMeta && _bulkMeta.length > 0) {
        // Build a ref → metadata lookup
        const _metaByRef = new Map();
        for (const m of _bulkMeta) {
          if (m.ref) _metaByRef.set(m.ref, m);
        }
        // Merge bulk metadata into map entries (preserve tab order + key)
        let _enriched = 0;
        for (let i = 0; i < map.length; i++) {
          const _entry = map[i];
          const _full = _metaByRef.get(_entry.ref);
          if (_full) {
            // Keep id, key (from Phase A), merge all fields from bulk metadata
            map[i] = { id: _entry.id, key: _entry.key, ..._full };
            _enriched++;
          }
        }
        logger.info(`[instruction.runner] buildTabMap (${label}): bulk metadata enriched ${_enriched}/${map.length} elements in ${Date.now() - _bulkStart}ms`);
      }
    } catch (e) {
      logger.warn(`[instruction.runner] buildTabMap: bulk metadata extraction failed (non-fatal — using slim data): ${e.message}`);
    }
  }

  // ── DOM-based overlay scan (backup) ─────────────────────────────────────
  // Focus-cycling can miss custom form fields (Google Calendar title input,
  // contenteditable widgets, etc.). When an overlay/dialog is open, also query
  // its DOM directly for visible inputs, contenteditables, buttons, and tabs.
  // This ensures form fields are discovered even if the focus order doesn't
  // reach them.
  try {
    const _overlayDom = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        // Pick the ACTIVE visible dialog, not the first match — Gmail keeps
        // several hidden role="dialog" containers (settings quick panel,
        // stale compose shells). Choose the visible candidate with the most
        // interactive children.
        const _dialogs = Array.from(document.querySelectorAll('${DIALOG_SELECTOR}'))
          .filter(d => {
            // offsetParent is null for position:fixed modals (LinkedIn's
            // .share-box-modal) — rendered-check must not exclude them.
            if (!d.isConnected || (d.offsetParent === null && getComputedStyle(d).position !== 'fixed')) return false;
            const dr = d.getBoundingClientRect();
            return dr.width > 0 && dr.height > 0;
          });
        let overlay = null, _best = -1;
        for (const d of _dialogs) {
          const n = d.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"]), button, [role="button"], [role="textbox"], [role="combobox"]').length;
          if (n > _best) { _best = n; overlay = d; }
        }
        const scope = overlay || document;
        const inDialog = !!overlay;
        const out = [];
        const fillable = scope.querySelectorAll('${FILLABLE_SELECTOR}');
        for (const el of fillable) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            // Inject data-td-ref so DOM-scanned elements are clickable via selector
            let ref = el.getAttribute('data-td-ref');
            if (!ref || !ref.startsWith('tm-')) {
              ref = 'tm-' + Math.random().toString(36).slice(2, 10);
              el.setAttribute('data-td-ref', ref);
            }
            const _exp = el.getAttribute('aria-expanded');
            out.push({
              tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
              text: (el.getAttribute('aria-label') || el.placeholder || '').slice(0, 80),
              ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
              placeholder: (el.getAttribute('placeholder') || '').slice(0, 80),
              value: (el.value || el.innerText || '').slice(0, 100),
              ref,
              inDialog: inDialog,
              disabled: !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'),
              expanded: _exp === 'true' ? true : _exp === 'false' ? false : undefined,
              checked: !!(el.checked || el.getAttribute('aria-checked') === 'true') || undefined,
              selected: el.getAttribute('aria-selected') === 'true' || undefined,
              readOnly: !!(el.readOnly || el.getAttribute('aria-readonly') === 'true') || undefined,
              focused: el === document.activeElement || undefined,
              cursor: (() => { try { return getComputedStyle(el).cursor; } catch (_) { return ''; } })(),
              x: r.x, y: r.y, w: r.width, h: r.height
            });
          }
        }
        const clickables = scope.querySelectorAll('button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"]');
        for (const el of clickables) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            let ref = el.getAttribute('data-td-ref');
            if (!ref || !ref.startsWith('tm-')) {
              ref = 'tm-' + Math.random().toString(36).slice(2, 10);
              el.setAttribute('data-td-ref', ref);
            }
            // Sponsored/ad detection — same heuristic as _bulkReadTabMapMetadata:
            // the "Sponsored" badge is a sibling inside the result card, not on
            // the clickable element itself.
            const _isSponsored = (() => {
              try {
                if (el.closest('[data-component-type="s-sponsored-result"], .s-sponsored-result, [data-sponsored], [data-text-ad], [data-ad], .ads-ad, [class*="sponsored" i]')) return true;
                const _card = el.closest('[data-asin], .s-result-item, [role="listitem"], article, li, .g');
                const _roots = _card && _card !== el ? [el, _card] : [el];
                for (const _root of _roots) {
                  if (!_root || !_root.querySelectorAll) continue;
                  if (_root.querySelector('.puis-sponsored-label-text, [aria-label*="Sponsored" i], [data-component-type*="sponsored" i]')) return true;
                  let _n = 0;
                  for (const _c of _root.querySelectorAll('span, div, a, i')) {
                    if (++_n > 80) break;
                    if (_c.children.length > 2) continue;
                    const _t = (_c.textContent || '').trim();
                    if (/^(sponsored|ad|advertisement|promoted|sponsored ad)$/i.test(_t)) return true;
                  }
                }
                return false;
              } catch (_) { return false; }
            })();
            const _exp2 = el.getAttribute('aria-expanded');
            out.push({
              tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
              text: (el.innerText || el.getAttribute('aria-label') || el.title || '')
                      .replace(/\s+/g, ' ')
                      .replace(/\\b(?:shift|option|opt|alt|ctrl|control|cmd|command|meta)(?:\\s*\\+\\s*(?:shift|option|opt|alt|ctrl|control|cmd|command|meta|[a-z0-9]))*\\b/gi, '')
                      .trim()
                      .slice(0, 80),
              ref,
              inDialog: inDialog,
              isSponsored: _isSponsored,
              disabled: !!(el.disabled || el.getAttribute('disabled') !== null || el.getAttribute('aria-disabled') === 'true'),
              expanded: _exp2 === 'true' ? true : _exp2 === 'false' ? false : undefined,
              checked: !!(el.checked || el.getAttribute('aria-checked') === 'true') || undefined,
              selected: el.getAttribute('aria-selected') === 'true' || undefined,
              pressed: el.getAttribute('aria-pressed') === 'true' || undefined,
              focused: el === document.activeElement || undefined,
              x: r.x, y: r.y, w: r.width, h: r.height
            });
          }
        }
        return JSON.stringify(out);
      })()`
    });
    if (_overlayDom?.ok && _overlayDom.result) {
      const _domItems = JSON.parse(_overlayDom.result || '[]');
      let _added = 0;
      for (const it of _domItems) {
        const sig = `${it.tag}:${it.text}:${Math.round(it.x)}:${Math.round(it.y)}`;
        if (!seenSet.has(sig)) {
          seenSet.add(sig);
          map.push({ id: ++idCounter, ...it });
          _added++;
        }
      }
      if (_added > 0) {
        logger.info(`[instruction.runner] buildTabMap (${label}): DOM overlay scan added ${_added} elements (total: ${map.length})`);
      }
    }
  } catch (e) {
    logger.warn(`[instruction.runner] buildTabMap: DOM overlay scan failed: ${e.message}`);
  }

  // ── Post-scan visibility filter ─────────────────────────────────────────
  // The forward focus-cycle tags elements while they hold focus — some widgets
  // (Gmail recipients, collapsible rows) are only rendered/expanded while
  // focused and collapse the moment focus moves on. Entries captured mid-cycle
  // can therefore point at nodes that are invisible RIGHT NOW. Drop them so a
  // pick can only land on an element that is actually interactable — collapsed
  // fields stay out of the map and the pick surfaces the visible expander row.
  try {
    const _hiddenRes = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        const hidden = [];
        for (const el of document.querySelectorAll('[data-td-ref]')) {
          const r = el.getBoundingClientRect();
          let vis = el.isConnected && r.width > 0 && r.height > 0;
          if (vis) { try { if (el.checkVisibility && !el.checkVisibility()) vis = false; } catch (_) {} }
          if (!vis) hidden.push(el.getAttribute('data-td-ref'));
        }
        return hidden;
      })()`,
    });
    const _hidden = new Set(Array.isArray(_hiddenRes?.result) ? _hiddenRes.result : []);
    if (_hidden.size) {
      const _before = map.length;
      for (let i = map.length - 1; i >= 0; i--) {
        if (map[i]?.ref && _hidden.has(map[i].ref)) map.splice(i, 1);
      }
      logger.info(`[instruction.runner] buildTabMap (${label}): post-scan filter dropped ${_before - map.length} invisible entries (total: ${map.length})`);
    }
  } catch (_) { /* non-fatal — map keeps unverified entries */ }

  // Persist the tab-map for this domain (merges with existing elements)
  const domain = await _getDomainFromSession(sessionId);
  if (domain) {
    _saveTabMap(domain, map);
  }

  // Attach pagination state to the returned array (backward-compat: callers
  // that treat the return as an array still work; the pagination wrapper reads
  // these extra properties to decide whether to continue to the next page).
  map.seenSet = seenSet;
  map.starterSig = starterSig;
  map.nextId = idCounter;
  map.loopedBack = _loopedBack;
  return map;
}

// ---------------------------------------------------------------------------
// Page search: window.find() + Ctrl+F fallback + tab-to-nearby
// ---------------------------------------------------------------------------
// Finds specific text content on the page using browser-native search.
// Used for dynamic content (playlist names, comments, emails) that can't
// be cached in the tab-map. After finding text, can tab to nearby elements.

// Search for text on the page using window.find() (Chrome supports this).
// Returns the focused element after the search, or null if not found.
// After page search finds text, walk to the nearest input/textarea if the
// focused element is not itself an input. window.find() often focuses the
// container element (e.g. <main> or <div>) instead of the actual <input>.


// Search for text on the page using window.find() (Chrome supports this).
// Returns the focused element after the search, or null if not found.
// After page search finds text, walk to the nearest input/textarea if the
// focused element is not itself an input. window.find() often focuses the
// container element (e.g. <main> or <div>) instead of the actual <input>.
async function _focusNearestInput(sessionId, text) {
  const escaped = JSON.stringify(text);
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        const el = document.activeElement;
        if (!el) return null;
        // Already an input/textarea — return it
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          return { tag: el.tagName.toLowerCase(), text: '', placeholder: el.placeholder || '', ariaLabel: el.getAttribute('aria-label') || '' };
        }
        const target = ${escaped};
        const targetLower = target.toLowerCase();
        // Search descendants for input with matching placeholder/aria-label
        const matches = (sel) => {
          const list = el.querySelectorAll(sel);
          for (const input of list) {
            const ph = (input.placeholder || '').toLowerCase();
            const al = (input.getAttribute('aria-label') || '').toLowerCase();
            if (ph.includes(targetLower) || al.includes(targetLower)) {
              input.focus();
              return { tag: input.tagName.toLowerCase(), text: '', placeholder: input.placeholder || '', ariaLabel: input.getAttribute('aria-label') || '' };
            }
          }
          return null;
        };
        let r = matches('input, textarea');
        if (r) return r;
        // Search parent's descendants (siblings and cousins)
        const parent = el.parentElement;
        if (parent) {
          r = matches('input, textarea');
          if (r) return r;
        }
        // Search whole document for matching input
        const all = document.querySelectorAll('input, textarea');
        for (const input of all) {
          const ph = (input.placeholder || '').toLowerCase();
          const al = (input.getAttribute('aria-label') || '').toLowerCase();
          if (ph.includes(targetLower) || al.includes(targetLower)) {
            input.focus();
            return { tag: input.tagName.toLowerCase(), text: '', placeholder: input.placeholder || '', ariaLabel: input.getAttribute('aria-label') || '' };
          }
        }
        return null;
      })()`,
    });
    if (res?.result) {
      logger.info(`[instruction.runner] _focusNearestInput: focused ${res.result.tag} placeholder="${res.result.placeholder}" for "${text}"`);
      return res.result;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _focusNearestInput failed: ${e.message}`);
  }
  return null;
}


async function pageSearch(sessionId, text) {
  if (!text) return null;

  // Try window.find() first — programmatic, works in Playwright
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `window.find(${JSON.stringify(text)}, false, false, true)`,
    });
    const found = res?.result === true || res?.result === 'true';
    if (found) {
      await _sleep(100);
      let focused = await _readActiveElement(sessionId);
      // If focused element is not an input, try to walk to nearest input
      // (window.find often focuses the container, not the actual input)
      if (focused && focused.tag !== 'input' && focused.tag !== 'textarea') {
        const inputEl = await _focusNearestInput(sessionId, text);
        if (inputEl) {
          focused = await _readActiveElement(sessionId);
        }
      }
      if (focused) {
        logger.info(`[instruction.runner] pageSearch: window.find found "${text}" → focused ${focused.tag} "${(focused.text || '').substring(0, 40)}"`);
        return focused;
      }
    }
  } catch (e) {
    logger.warn(`[instruction.runner] pageSearch: window.find failed: ${e.message}`);
  }

  // Fallback: Ctrl+F (Meta+F on Mac) via keyboard
  try {
    const isMac = process.platform === 'darwin';
    const findKey = isMac ? 'Meta+f' : 'Control+f';
    await browserAct({ action: 'press', sessionId, key: findKey, headed: true, timeoutMs: 2000 });
    await _sleep(300);

    // Type the search text character by character
    for (const char of text) {
      await browserAct({ action: 'press', sessionId, key: char, headed: true, timeoutMs: 1000 });
      await _sleep(30);
    }
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 2000 });
    await _sleep(300);

    // Close find bar
    await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 1500 });
    await _sleep(100);

    let focused = await _readActiveElement(sessionId);
    if (focused && focused.tag !== 'input' && focused.tag !== 'textarea') {
      const inputEl = await _focusNearestInput(sessionId, text);
      if (inputEl) {
        focused = await _readActiveElement(sessionId);
      }
    }
    if (focused) {
      logger.info(`[instruction.runner] pageSearch: Ctrl+F found "${text}" → focused ${focused.tag} "${(focused.text || '').substring(0, 40)}"`);
      return focused;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] pageSearch: Ctrl+F fallback failed: ${e.message}`);
  }

  logger.info(`[instruction.runner] pageSearch: "${text}" not found on page`);
  return null;
}

// Scroll all scrollable containers down by 80% of their viewport height.
// Used to trigger lazy/virtualized rendering of off-screen content.
// scrollIntoView can't be used here because the target element may not exist
// in the DOM yet (virtualized lists only render items near the viewport).


// Scroll all scrollable containers down by 80% of their viewport height.
// Used to trigger lazy/virtualized rendering of off-screen content.
// scrollIntoView can't be used here because the target element may not exist
// in the DOM yet (virtualized lists only render items near the viewport).
async function _scrollPageDown(sessionId) {
  await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
    text: `(() => {
      // Limit to likely scroll containers instead of querySelectorAll('*')
      const candidates = document.querySelectorAll('div, main, nav, section, aside, ul, ol');
      let scrolled = false;
      for (const el of candidates) {
        if (el.scrollHeight <= el.clientHeight + 10) continue;
        const style = getComputedStyle(el);
        const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                           style.overflow === 'auto' || style.overflow === 'scroll');
        if (canScroll) {
          el.scrollBy(0, el.clientHeight * 0.8);
          scrolled = true;
        }
      }
      if (document.documentElement.scrollHeight > window.innerHeight) {
        window.scrollBy(0, window.innerHeight * 0.8);
        scrolled = true;
      }
      return scrolled;
    })()`,
  });
}

// Scroll all scrollable containers back to top.


// Scroll all scrollable containers back to top.
async function _scrollToTop(sessionId) {
  await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
    text: `(() => {
      const candidates = document.querySelectorAll('div, main, nav, section, aside, ul, ol');
      for (const el of candidates) {
        if (el.scrollHeight <= el.clientHeight + 10) continue;
        const style = getComputedStyle(el);
        const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
                           style.overflow === 'auto' || style.overflow === 'scroll');
        if (canScroll) {
          el.scrollTo(0, 0);
        }
      }
      window.scrollTo(0, 0);
      return true;
    })()`,
  });
}

// Page search with scroll retry: try window.find(), scroll if not found, retry.
// Handles virtualized/lazy-loaded lists where the target isn't in the DOM
// until the user scrolls near it.


// Page search with scroll retry: try window.find(), scroll if not found, retry.
// Handles virtualized/lazy-loaded lists where the target isn't in the DOM
// until the user scrolls near it.
async function _pageSearchWithScroll(sessionId, text, maxScrolls = 5) {
  let result = await pageSearch(sessionId, text);
  if (result) return result;

  for (let i = 0; i < maxScrolls; i++) {
    await _scrollPageDown(sessionId);
    await _sleep(500); // wait for virtualized content to render
    result = await pageSearch(sessionId, text);
    if (result) {
      logger.info(`[instruction.runner] pageSearch: found "${text}" after ${i + 1} scrolls`);
      return result;
    }
  }
  await _scrollToTop(sessionId);
  return null;
}

// Search for text, then tab forward to find a nearby element matching a label.
// Used for: "Click Reply on John Smith's comment" → find "John Smith", tab to "Reply".
// Returns the focused element matching the nearbyLabel, or the search result if no match.


// Search for text, then tab forward to find a nearby element matching a label.
// Used for: "Click Reply on John Smith's comment" → find "John Smith", tab to "Reply".
// Returns the focused element matching the nearbyLabel, or the search result if no match.
async function pageSearchAndTabTo(sessionId, searchText, nearbyLabel, maxTabs = 5) {
  const found = await pageSearch(sessionId, searchText);
  if (!found) return null;
  if (!nearbyLabel) return found;

  const labelLower = nearbyLabel.toLowerCase().trim();
  // Check if the found element itself matches
  const foundText = (found.text || '').toLowerCase();
  const foundAria = (found.ariaLabel || '').toLowerCase();
  if (foundText.includes(labelLower) || foundAria.includes(labelLower)) {
    return found;
  }

  // Tab forward looking for the nearby element
  for (let i = 0; i < maxTabs; i++) {
    await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
    await _sleep(60);
    const focused = await _readActiveElement(sessionId);
    if (!focused) continue;
    const fText = (focused.text || '').toLowerCase();
    const fAria = (focused.ariaLabel || '').toLowerCase();
    if (fText.includes(labelLower) || fAria.includes(labelLower)) {
      logger.info(`[instruction.runner] pageSearchAndTabTo: found "${nearbyLabel}" after ${i + 1} tabs from "${searchText}"`);
      return focused;
    }
  }

  logger.info(`[instruction.runner] pageSearchAndTabTo: found "${searchText}" but couldn't tab to "${nearbyLabel}"`);
  return found; // return the search result even if nearby element not found
}

// ---------------------------------------------------------------------------
// LLM selection from tab-map
// ---------------------------------------------------------------------------
// Formats the tab-map as a simplified numbered list (no coordinates) for the
// LLM to pick the best match. Maps the LLM's pick back to the full entry
// with real coordinates for clicking.

// Format a tab-map entry as a simplified line for the LLM


// Format a tab-map entry as a simplified line for the LLM
function _formatTabMapEntryForLLM(entry) {
  const parts = [entry.tag || 'element'];
  if (entry.text && entry.text.length > 0) {
    parts.push(`"${entry.text.substring(0, 60)}"`);
  }
  if (entry.ariaLabel && entry.ariaLabel.length > 0) {
    parts.push(`ariaLabel="${entry.ariaLabel.substring(0, 40)}"`);
  }
  if (entry.placeholder && entry.placeholder.length > 0) {
    parts.push(`placeholder="${entry.placeholder.substring(0, 40)}"`);
  }
  if (entry.isIconLike) {
    parts.push('icon');
  }
  if (entry.role && entry.role !== entry.tag) {
    parts.push(`role=${entry.role}`);
  }
  if (entry.isSponsored) {
    parts.push('[SPONSORED]');
  }
  // Add [FILLABLE]/[CLICKABLE] marker so the picker LLM has the same context
  // as _extractSteps/_llmNextAction (which use these markers for type/click decisions).
  const _isFillable = ['input', 'textarea'].includes(entry.tag) ||
                      entry.role === 'combobox' || entry.role === 'textbox';
  parts.push(_isFillable ? '[FILLABLE]' : '[CLICKABLE]');
  // Add coordinates for disambiguation (largest/highest button selection).
  if (entry.x !== undefined && entry.y !== undefined && entry.w !== undefined && entry.h !== undefined) {
    parts.push(`@x=${Math.round(entry.x)},y=${Math.round(entry.y)},w=${Math.round(entry.w)},h=${Math.round(entry.h)}`);
  }
  return parts.join(' ');
}

// Ask the LLM to pick the best element from a tab-map for a given step.
// Returns the full tab-map entry (with coordinates) or null.


// Ask the LLM to pick the best element from a tab-map for a given step.
// Returns the full tab-map entry (with coordinates) or null.
async function _llmPickFromTabMap(tabMap, stepAction, verifyText, value, contextHint = '') {
  if (!tabMap || tabMap.length === 0) return null;

  // Build simplified list
  const listStr = tabMap.map(e => `${e.id} - ${_formatTabMapEntryForLLM(e)}`).join('\n');

  const actionDesc = stepAction === 'fill'
    ? `Type "${value || ''}" into the matching field`
    : stepAction === 'click'
    ? `Click the matching element`
    : `${stepAction} the matching element`;

  const hintBlock = contextHint ? `\nAdditional context: "${contextHint}"` : '';

  const prompt = `Step: ${actionDesc} — target: "${verifyText}"${hintBlock}

Available elements:
${listStr}

Which element number matches the step target?
- The target text may be GARBLED — characters can be dropped within words (e.g. "playli t" = "playlist", "ong" = "song", "epi ode" = "episode")
- Match if the element's text/ariaLabel/placeholder contains the same words as the target (ignoring dropped characters)
- "Create" does NOT match "Create a playlist with a song or episode" (different text — one is a single word, the other is a full sentence)
- "Create" only matches if the target is exactly "Create" or "Create button"
- If the target is a generic button like "Add" and there are multiple, use the Additional context to pick the right one
- If NO element matches, output 0
Output ONLY the number, or 0 if no match.`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: 'You pick the matching element from a list. The target text may be garbled (characters dropped within words). Match if the words align. Output ONLY the number, or 0 if no match. Nothing else.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 30, temperature: 0, responseTimeoutMs: 8000 });

    const responseText = (response || '').trim();
    logger.info(`[instruction.runner] LLM pick raw response: "${responseText.substring(0, 80)}" (${responseText.length} chars) for "${verifyText}"`);
    let id = 0;
    if (responseText.length <= 3) {
      id = parseInt(responseText.replace(/\D/g, ''), 10) || 0;
    } else {
      // Verbose response — extract first standalone number
      const match = responseText.match(/\b(\d+)\b/);
      id = match ? parseInt(match[1], 10) : 0;
    }
    if (id > 0) {
      const entry = tabMap.find(e => e.id === id);
      if (entry) {
        logger.info(`[instruction.runner] LLM picked element #${id} (${_formatTabMapEntryForLLM(entry)}) for "${verifyText}"`);
        return entry;
      }
    }
    logger.info(`[instruction.runner] LLM returned ${id} (no match) for "${verifyText}" — trying fuzzy fallback`);

    // Fuzzy fallback: if LLM returned 0, try fuzzy matching the target text
    // against each tab-map entry's text/ariaLabel. Handles garbled training text
    // where characters are dropped within words (e.g. "playli t" → "playlist").
    let bestEntry = null;
    let bestScore = 0;
    for (const entry of tabMap) {
      const candidateText = entryLabel(entry);
      if (!candidateText) continue;
      if (_fuzzyTextMatch(verifyText, candidateText)) {
        // Use the word-overlap score to pick the best match among fuzzy matches
        const score = _fuzzyTextScore(verifyText, candidateText);
        if (score > bestScore) {
          bestScore = score;
          bestEntry = entry;
        }
      }
    }
    if (bestEntry) {
      logger.info(`[instruction.runner] Fuzzy fallback picked element #${bestEntry.id} (${_formatTabMapEntryForLLM(bestEntry)}) for "${verifyText}" (score=${bestScore.toFixed(2)})`);
      return bestEntry;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] LLM pick from tab-map failed: ${e.message}`);
  }
  return null;
}

// Ask the LLM to identify a "reveal" button from the tab-map — one that
// reveals more content when clicked (e.g. "See more", "Load more", "Show all",
// "View all", "Expand", "More"). Uses LLM language understanding to handle
// any phrasing without brittle regex. Returns the entry or null.


// Ask the LLM to identify a "reveal" button from the tab-map — one that
// reveals more content when clicked (e.g. "See more", "Load more", "Show all",
// "View all", "Expand", "More"). Uses LLM language understanding to handle
// any phrasing without brittle regex. Returns the entry or null.
async function _llmPickRevealButton(tabMap) {
  if (!tabMap || tabMap.length === 0) return null;
  const listStr = tabMap.map(e => `${e.id} - ${_formatTabMapEntryForLLM(e)}`).join('\n');
  const prompt = `Available elements:
${listStr}

Is any element a "reveal" button — one that reveals more content when clicked (e.g. "See more", "Load more", "Show all", "View all", "Expand", "More")?
Output ONLY the element number, or 0 if none.`;
  try {
    const response = await askWithMessages([
      { role: 'system', content: 'You identify reveal buttons from a list. A reveal button reveals more content when clicked (e.g. "See more", "Load more", "Show all", "View all", "Expand", "More"). Output ONLY the element number, or 0 if none.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 30, temperature: 0, responseTimeoutMs: 8000 });
    const responseText = (response || '').trim();
    logger.info(`[instruction.runner] LLM reveal-button raw response: "${responseText.substring(0, 80)}" (${responseText.length} chars)`);
    let id = 0;
    if (responseText.length <= 3) {
      id = parseInt(responseText.replace(/\D/g, ''), 10) || 0;
    } else {
      const match = responseText.match(/\b(\d+)\b/);
      id = match ? parseInt(match[1], 10) : 0;
    }
    if (id > 0) {
      const entry = tabMap.find(e => e.id === id);
      if (entry) {
        logger.info(`[instruction.runner] LLM identified reveal button #${id} (${_formatTabMapEntryForLLM(entry)})`);
        return entry;
      }
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _llmPickRevealButton failed: ${e.message}`);
  }
  return null;
}


// ---------------------------------------------------------------------------
// Uses LiteParser+OCR to get visible text/icon coordinates, then tabs through
// the page. For each tab stop, checks THREE data points against ALL OCR rows:
//   1. Bounds overlap (≥30% of smaller rect)
//   2. Fuzzy text match (≥0.5 word overlap)
//   3. Icon inference (both active element and OCR row are icon-like)
// A match requires at least 2 of 3 applicable data points to pass.
// Bounds overlap is always required — never match without coordinate agreement.
// Re-OCRs when the active element scrolls outside the current screenshot.
// Falls back to the slow path (_discoverKeyPathStep) on any failure.

// Calculate overlap percentage between two rects (0-100).


// Calculate overlap percentage between two rects (0-100).
function _rectOverlapPercent(a, b) {
  const overlapX = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapY = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const overlapArea = overlapX * overlapY;
  const aArea = (a.width || 0) * (a.height || 0);
  const bArea = (b.width || 0) * (b.height || 0);
  const smallerArea = Math.min(aArea, bArea);
  if (smallerArea <= 0) return 0;
  return (overlapArea / smallerArea) * 100;
}

// Fuzzy text score: returns a score 0-1 based on word-level overlap.
// Handles OCR garbling: "Create playli t" → 1.0 match with "Create playlist".


// Fuzzy text score: returns a score 0-1 based on word-level overlap.
// Handles OCR garbling: "Create playli t" → 1.0 match with "Create playlist".
function _fuzzyTextScore(a, b) {
  if (!a || !b) return 0;
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();
  if (aLower === bLower) return 1.0;
  const aWords = aLower.split(/\s+/).filter(w => w.length > 2);
  const bWords = bLower.split(/\s+/).filter(w => w.length > 2);
  if (aWords.length === 0 || bWords.length === 0) return 0;
  const matched = aWords.filter(w => bWords.some(bw => bw.includes(w) || w.includes(bw)));
  return matched.length / Math.max(aWords.length, bWords.length);
}

// Check if an OCR row is icon-like (non-alphanumeric, small, or type:'icon').


// ── Spreadsheet cell navigation helper ─────────────────────────────────
// Focuses a specific cell in Google Sheets / Excel Online via the Name Box.
// Flow: Cmd+J (Mac) / Ctrl+J (Win) → focus Name Box → type cell address → Enter → cell focused.
// Returns { ok, cellAddress, error }
async function _focusSpreadsheetCell(sessionId, cellAddress) {
  if (!cellAddress) return { ok: false, error: 'No cell address provided' };
  const _normalizedAddr = String(cellAddress).trim().toUpperCase();

  logger.info(`[instruction.runner] _focusSpreadsheetCell: focusing cell ${_normalizedAddr} via Name Box`);

  // 1. Press Cmd+J (Mac) to focus the Name Box
  //    Meta=Cmd on macOS, Control=Ctrl on Windows/Linux
  const _isMac = process.platform === 'darwin';
  const _nameBoxShortcut = _isMac ? 'Meta+j' : 'Control+j';
  try {
    await browserAct({ action: 'press', sessionId, key: _nameBoxShortcut, headed: true, timeoutMs: 5000 });
    await _sleep(600); // wait for Name Box to focus
  } catch (e) {
    return { ok: false, error: `Name Box shortcut failed: ${e.message}` };
  }

  // 2. Type the cell address into the Name Box
  try {
    await browserAct({ action: 'type', sessionId, text: _normalizedAddr, headed: true, timeoutMs: 3000 });
    await _sleep(200);
  } catch (e) {
    return { ok: false, error: `Type cell address failed: ${e.message}` };
  }

  // 3. Press Enter to jump to the cell
  try {
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 3000 });
    await _sleep(500); // wait for cell to be focused
  } catch (e) {
    return { ok: false, error: `Enter (cell focus) failed: ${e.message}` };
  }

  logger.info(`[instruction.runner] _focusSpreadsheetCell: focused cell ${_normalizedAddr} ✓`);
  return { ok: true, cellAddress: _normalizedAddr };
}

// Type a value into a specific spreadsheet cell using the Meta+J shortcut.
// This is a Tier 3 (Shortcuts) function — Meta+J is a keyboard shortcut.
// Does the full flow: Meta+J → type cell address → Enter → type value.
// Does NOT press Tab/Enter to commit — the caller decides the commit key.


// Type a value into a specific spreadsheet cell using the Meta+J shortcut.
// This is a Tier 3 (Shortcuts) function — Meta+J is a keyboard shortcut.
// Does the full flow: Meta+J → type cell address → Enter → type value.
// Does NOT press Tab/Enter to commit — the caller decides the commit key.
async function _typeIntoSpreadsheetCell(sessionId, cellAddress, value) {
  if (!cellAddress || !value) return { ok: false, error: 'Missing cell or value' };

  // 1. Focus the target cell via Name Box (Meta+J → type cell → Enter)
  const _focusResult = await _focusSpreadsheetCell(sessionId, cellAddress);
  if (!_focusResult?.ok) {
    logger.warn(`[instruction.runner] _typeIntoSpreadsheetCell: focus ${cellAddress} failed`);
    return { ok: false, error: _focusResult?.error || 'focus failed' };
  }
  await _sleep(400);

  // 2. Type the value directly via the engine keyboard.
  //    Don't use browserAct({ action: 'type' }) — its post-snap verification
  //    fails for Google Sheets' canvas-based cell editor even though the
  //    typing succeeds. The per-iteration _ocrVerifyGoal check at the end
  //    of the main loop provides verification.
  const _gridPage = engine.getPage(sessionId);
  if (!_gridPage) {
    logger.warn(`[instruction.runner] _typeIntoSpreadsheetCell: no page for session ${sessionId}`);
    return { ok: false, error: 'no page' };
  }

  logger.info(`[instruction.runner] _typeIntoSpreadsheetCell: typing "${String(value).slice(0, 30)}" into cell ${cellAddress}`);
  try {
    await _gridPage.keyboard.type(value);
  } catch (e) {
    logger.warn(`[instruction.runner] _typeIntoSpreadsheetCell: keyboard.type error: ${e.message}`);
    return { ok: false, error: e.message };
  }
  await _sleep(300);
  return { ok: true, cell: cellAddress };
}

// Detect the current focused cell in a spreadsheet.
// Returns the cell address (e.g., "B3") or null if no grid cell is focused.
// Tries multiple strategies because Google Sheets is canvas-based and
// document.activeElement is often a hidden input, not the visible cell.


// Detect the current focused cell in a spreadsheet.
// Returns the cell address (e.g., "B3") or null if no grid cell is focused.
// Tries multiple strategies because Google Sheets is canvas-based and
// document.activeElement is often a hidden input, not the visible cell.
async function _getCurrentCell(sessionId) {
  try {
    const _result = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const _cellRe = /^([A-Z]{1,2})(\\d{1,4})$/;
        const _labelRe = /(?:cell\\s+)?([A-Z]{1,2})(\\d{1,4})(?:\\s+selected)?/i;

        // 1. document.activeElement aria-label: "Cell B3 selected"
        const el = document.activeElement;
        if (el && el !== document.body) {
          const ariaLabel = el.getAttribute('aria-label') || '';
          const m1 = ariaLabel.match(/cell\\s+([A-Z]{1,2})(\\d{1,4})\\s+selected/i);
          if (m1) return m1[1].toUpperCase() + m1[2];
          // aria-label might just be "B3"
          const m1b = ariaLabel.trim().match(_cellRe);
          if (m1b) return m1b[1].toUpperCase() + m1b[2];
        }

        // 2. aria-activedescendant on a grid container
        const grid = document.querySelector('[role="grid"]');
        if (grid) {
          const ad = grid.getAttribute('aria-activedescendant');
          if (ad) {
            const adEl = document.getElementById(ad) || document.querySelector('[id="' + CSS.escape(ad) + '"]');
            if (adEl) {
              const adLabel = adEl.getAttribute('aria-label') || '';
              const m2 = adLabel.match(_labelRe);
              if (m2) return m2[1].toUpperCase() + m2[2];
              // The cell might have a row/col index attribute
              const rIdx = adEl.getAttribute('aria-rowindex');
              const cIdx = adEl.getAttribute('aria-colindex');
              if (rIdx && cIdx) {
                const col = String.fromCharCode(64 + parseInt(cIdx, 10));
                return col + rIdx;
              }
            }
          }
        }

        // 3. Query for selected gridcell
        const selectedCell = document.querySelector('[role="gridcell"][aria-selected="true"]');
        if (selectedCell) {
          const scLabel = selectedCell.getAttribute('aria-label') || '';
          const m3 = scLabel.match(_labelRe);
          if (m3) return m3[1].toUpperCase() + m3[2];
        }

        // 4. Google Sheets specific: the active cell has class containing "selected"
        //    and role="gridcell" or is inside the grid
        const allCells = document.querySelectorAll('[role="gridcell"]');
        for (const c of allCells) {
          const cls = (c.className || '').toLowerCase();
          if (cls.includes('selected') || c.getAttribute('aria-selected') === 'true') {
            const cLabel = c.getAttribute('aria-label') || '';
            const m4 = cLabel.match(_labelRe);
            if (m4) return m4[1].toUpperCase() + m4[2];
          }
        }

        // 5. Name Box input — Google Sheets shows the current cell address
        //    in an input with aria-label "Name Box" or "Range Box".
        //    Broadened selector to cover various Google Sheets DOM versions.
        const nameBox = document.querySelector(
          'input[aria-label*="name box" i], input[aria-label*="range box" i], ' +
          'input[aria-label*="name" i][class*="name-box"], .name-box-input, ' +
          '#name-box, input.docs-namebox, .waffle-name-box, ' +
          '[class*="name-box"] input, [class*="nameBox"] input, ' +
          'input[aria-label*="name" i][class*="name"]'
        );
        if (nameBox) {
          const val = (nameBox.value || '').trim();
          const m5 = val.match(_cellRe);
          if (m5) return m5[1].toUpperCase() + m5[2];
        }

        // 6. Google Sheets: the active cell element has data-td-ref or is a
        //    contenteditable with aria-label matching a cell
        const ceCells = document.querySelectorAll('[contenteditable][aria-label]');
        for (const ce of ceCells) {
          const ceLabel = ce.getAttribute('aria-label') || '';
          const m6 = ceLabel.match(_labelRe);
          if (m6 && ce.offsetParent !== null) return m6[1].toUpperCase() + m6[2];
        }

        // 7. Fallback: check the active element's value or text content for a
        //    cell address pattern. After _focusSpreadsheetCell types "A1" and
        //    presses Enter, the active element might still contain the cell ref.
        if (document.activeElement && document.activeElement !== document.body) {
          const active = document.activeElement;
          const activeLabel = active.getAttribute('aria-label') || '';
          const activeValue = active.value || active.textContent || '';
          for (const src of [activeLabel, activeValue]) {
            const m7 = String(src).match(/\\b([A-Z]{1,2})(\\d{1,4})\\b/);
            if (m7) return m7[1].toUpperCase() + m7[2];
          }
        }

        return null;
      })()`,
    });
    return _result?.result || null;
  } catch (_) {
    return null;
  }
}

// Calculate arrow key presses to move from currentCell to targetCell.
// Returns an array of key names (e.g., ["ArrowRight", "ArrowRight"]) or null
// if the distance is too far (>3 total moves → defer to Meta+J).


// Calculate arrow key presses to move from currentCell to targetCell.
// Returns an array of key names (e.g., ["ArrowRight", "ArrowRight"]) or null
// if the distance is too far (>3 total moves → defer to Meta+J).
function _calculateArrowMoves(currentCell, targetCell) {
  if (!currentCell || !targetCell) return null;
  const _parse = (cell) => {
    const m = cell.toUpperCase().match(/^([A-Z]{1,2})(\d+)$/);
    if (!m) return null;
    const col = m[1].split('').reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0);
    const row = parseInt(m[2], 10);
    return { col, row };
  };
  const _cur = _parse(currentCell);
  const _tgt = _parse(targetCell);
  if (!_cur || !_tgt) return null;
  const _dCol = _tgt.col - _cur.col;
  const _dRow = _tgt.row - _cur.row;
  const _totalMoves = Math.abs(_dCol) + Math.abs(_dRow);
  if (_totalMoves === 0) return []; // already at target
  if (_totalMoves > 3) return null; // too far — defer to Meta+J
  const _moves = [];
  if (_dCol > 0) for (let i = 0; i < _dCol; i++) _moves.push('ArrowRight');
  if (_dCol < 0) for (let i = 0; i < -_dCol; i++) _moves.push('ArrowLeft');
  if (_dRow > 0) for (let i = 0; i < _dRow; i++) _moves.push('ArrowDown');
  if (_dRow < 0) for (let i = 0; i < -_dRow; i++) _moves.push('ArrowUp');
  return _moves;
}

// ── Strategy 1: Just-type ──────────────────────────────────────────────
// The focused element is the right field — just type into it.
// If no element is focused (e.g., canvas editor where title isn't auto-focused),
// click the first visible fillable element to focus it before typing.
// Returns { ok, pageChanged, error }
// ── Field-type executors (type-plain, type-edit, type-commands, type-search) ──
// These are called by _executeTypedField after _extractFieldType determines the kind of typing.
// Each receives: sessionId, value, focusedElement, goal, pageCategory, agentContext, pageContext, ctx
// ctx = { isEdit, hasContent } — pre-computed by _executeTypedField so all flows share the same edit/create decision.

// ── Backup helper ──
// Saves a backup of the current field content before any modification.
// Enables undo for all operations on fields with existing content.
// Files stored in ~/.thinkdrop/edits/copies/copy-{timestamp}-backup.md


// Execute a single Tab-Map action (click/type/press/navigate).
// Whether a dialog/overlay is currently visible (DOM-only modals don't change
// the URL). Used to detect clicks that open/close overlays → signal rescan.
async function _hasVisibleDialog(sessionId) {
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 1500,
      text: `(() => {
        const ds = document.querySelectorAll('${DIALOG_SELECTOR}');
        for (const d of ds) {
          const r = d.getBoundingClientRect();
          if (r.width > 40 && r.height > 40 && getComputedStyle(d).visibility !== 'hidden') return true;
        }
        return false;
      })()`,
    });
    return res?.ok ? res.result === true || res.result === 'true' : false;
  } catch (_) { return false; }
}

// Returns { ok, pageChanged, error, pickedRef, rescan, overlayChanged }
async function _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory, prePickedEntry) {
  const _pageCategory = pageCategory || 'web_generic';

  if (parsed.action === 'done') {
    return { ok: true, pageChanged: false };
  }

  if (parsed.action === 'navigate') {
    // Guard: refuse to navigate while an overlay/dialog is open — navigating
    // will close the dialog and destroy progress. Trigger re-extraction instead.
    if (overlayActive) {
      logger.warn(`[instruction.runner] Tab-Map: refusing navigate to "${parsed.url}" while overlay is open — will re-extract steps`);
      return { ok: false, pageChanged: false, error: 'navigate-while-overlay-open', rescan: true };
    }
    // Guard: skip redundant navigate if current URL already matches target
    const _currentUrl = await _getUrl(sessionId);
    if (_urlsEquivalent(_currentUrl, parsed.url)) {
      logger.info(`[instruction.runner] Tab-Map: skipping navigate — already at ${parsed.url}`);
      return { ok: true, pageChanged: false };
    }
    const navResult = await browserAct({ action: 'navigate', sessionId, url: parsed.url, headed: true, timeoutMs: 30000 });
    await _sleep(2000);
    await _resetFocusToPageTop(sessionId);
    return { ok: !!navResult?.ok, pageChanged: true, error: navResult?.error };
  }

  if (parsed.action === 'press') {
    const keyMap = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape' };
    const result = await browserAct({ action: 'press', sessionId, key: keyMap[parsed.key] || parsed.key, headed: true, timeoutMs: 5000 });
    await _sleep(500);
    return { ok: !!result?.ok, pageChanged: false, error: result?.error };
  }

  if (parsed.action === 'click') {
    const pickedEntry = prePickedEntry || await _llmPickFromTabMap(tabMap, 'click', parsed.target, '', '');
    if (!pickedEntry) {
      // Lazy re-scan signal
      return { ok: false, pageChanged: false, error: `No element found for "${parsed.target}"`, rescan: true };
    }

    // Clear netLog before submit/save/send clicks so we can verify the API call after
    const _isSubmitClick = /^(Save|Send|Submit|Create|Done|Confirm|OK|Post|Publish)$/i.test(parsed.target || '');
    if (_isSubmitClick) {
      try { engine.clearNetLog(sessionId); } catch (_) {}
      logger.info(`[instruction.runner] Tab-Map: cleared netLog before submit click "${parsed.target}"`);
    }

    const _preUrl = await _getUrl(sessionId);
    // Snapshot visible-dialog presence before the click — a DOM-only modal
    // open/close (LinkedIn "Start a post", share dialogs) doesn't change the
    // URL, so pageChanged alone can't signal a rescan.
    const _preDialog = await _hasVisibleDialog(sessionId);

    // Stale-[DISABLED] re-probe: the map predates the last type action — React
    // enables submit buttons on input events, so a scanned-disabled flag may be
    // stale by the time we click. Check live state; log and proceed if enabled.
    if (pickedEntry.disabled === true && pickedEntry.ref) {
      try {
        const _liveDisabled = await browserAct({
          action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
          text: `(() => { const el = document.querySelector('[data-td-ref="${pickedEntry.ref}"]'); return el ? !!(el.disabled || el.getAttribute('aria-disabled') === 'true') : null; })()`,
        });
        if (_liveDisabled?.result === false) {
          logger.info(`[instruction.runner] Tab-Map: "${parsed.target}" was [DISABLED] at scan but is enabled now — proceeding`);
        } else if (_liveDisabled?.result === true) {
          logger.warn(`[instruction.runner] Tab-Map: "${parsed.target}" still disabled — click may no-op`);
        }
      } catch (_) {}
    }

    // Click via data-td-ref selector
    const cssSelector = pickedEntry.ref ? `[data-td-ref="${pickedEntry.ref}"]` : null;
    let clickOk = false;
    if (cssSelector) {
      logger.info(`[instruction.runner] Tab-Map: clicking "${pickedEntry.text || pickedEntry.ariaLabel || parsed.target}" via ${cssSelector}`);
      try {
        const clickResult = await browserAct({ action: 'click', sessionId, selector: cssSelector, headed: true, timeoutMs: 5000 });
        clickOk = !!clickResult?.ok;
      } catch (e) {
        logger.warn(`[instruction.runner] Tab-Map: Playwright click error: ${e.message}`);
      }
    }
    // Coordinate-click fallback
    if (!clickOk && pickedEntry.x !== undefined && pickedEntry.x > 0) {
      const cx = Math.round(pickedEntry.x + (pickedEntry.w || 0) / 2);
      const cy = Math.round(pickedEntry.y + (pickedEntry.h || 0) / 2);
      logger.info(`[instruction.runner] Tab-Map: coordinate-click at (${cx}, ${cy}) for "${parsed.target}"`);
      try {
        const coordResult = await browserAct({ action: 'clickAt', sessionId, x: cx, y: cy, headed: true, timeoutMs: 5000 });
        clickOk = !!coordResult?.ok;
      } catch (e) {
        logger.warn(`[instruction.runner] Tab-Map: coordinate-click error: ${e.message}`);
      }
    }

    await _sleep(1000);
    const _postUrl = await _getUrl(sessionId);
    const pageChanged = _preUrl !== _postUrl;

    // Poll briefly for a dialog state change — React modals mount ~300-1500ms
    // after the opener click; checking once races the mount.
    let overlayChanged = false;
    for (let _t = 0; _t < 4 && clickOk; _t++) {
      const _postDialog = await _hasVisibleDialog(sessionId);
      if (_postDialog !== _preDialog) {
        overlayChanged = _postDialog ? 'opened' : 'closed';
        break;
      }
      if (_t < 3) await _sleep(400);
    }
    if (overlayChanged) logger.info(`[instruction.runner] Tab-Map: dialog ${overlayChanged} after click — will rescan`);

    // Post-click commerce verification: if this was an add-to-cart click,
    // check that the cart was actually updated (not a List/Wishlist redirect).
    if (clickOk && /\badd\s+to\s+(?:cart|bag|basket)\b/i.test(parsed.target || '')) {
      await _sleep(800); // extra wait for cart confirmation toast/modal
      let _commerceVerify = null;
      try {
        const _verifyRes = await browserAct({
          action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
          text: `(() => {
            const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 6000) : '';
            const cartConfirm = /added to (?:your |the |my )?(?:cart|bag|basket)|item(?:s)? added|subtotal|go to (?:cart|bag|basket)|view (?:cart|bag|basket)|\\b\\d+\\s+items? in (?:your |the )?(?:cart|bag|basket)/i.test(body);
            const listConfirm = /added to (?:your |the |my )?(?:list|wishlist|registry)|saved for later/i.test(body);
            return JSON.stringify({ cartConfirm, listConfirm });
          })()`,
        });
        _commerceVerify = _verifyRes?.result ? JSON.parse(typeof _verifyRes.result === 'string' ? _verifyRes.result : JSON.stringify(_verifyRes.result)) : null;
      } catch (e) {
        logger.warn(`[instruction.runner] Tab-Map: post-click commerce verify failed: ${e.message}`);
      }
      if (_commerceVerify) {
        logger.info(`[instruction.runner] Tab-Map: post-click commerce verify — cartConfirm=${_commerceVerify.cartConfirm}, listConfirm=${_commerceVerify.listConfirm}`);
        if (_commerceVerify.listConfirm && !_commerceVerify.cartConfirm) {
          logger.warn(`[instruction.runner] Tab-Map: add-to-cart click hit a List/Wishlist button instead — failing step`);
          return { ok: false, pageChanged: true, error: 'Clicked Add to List instead of Add to Cart', pickedRef: pickedEntry.ref };
        }
      }
    }

    return { ok: clickOk, pageChanged, overlayChanged, error: clickOk ? undefined : `Click failed for "${parsed.target}"`, pickedRef: pickedEntry.ref };
  }

  if (parsed.action === 'type') {
    // ── Spreadsheet cell-focus guard ────────────────────────────────────
    // In Google Sheets, Tab-Map can accidentally type into the formula bar
    // (a textarea) instead of a grid cell. If the page is a spreadsheet, the
    // target looks like a cell address (e.g., "A1", "cell B3"), and no grid
    // cell is focused, focus the target cell via _focusSpreadsheetCell before
    // typing.
    //
    // IMPORTANT: Only run when parsed.target is a cell address. Non-cell targets
    // like "Rename", "Title", "Name Box" should go through normal _llmPickFromTabMap.
    if (_pageCategory === 'spreadsheet' && parsed.value && !parsed.value.startsWith('PRESS_')) {
      // Check if the target is a cell address (e.g., "A1", "cell B3", "C5")
      const _targetStr = (parsed.target || '').toLowerCase();
      const _cellMatch = _targetStr.match(/\b(?:cell\s+)?([a-z]{1,2})(\d{1,3})\b/);
      // Exclude false positives: "Rename" contains no digits, "Title" contains no digits
      // The regex requires letters followed by digits, so "Rename" won't match.
      if (_cellMatch) {
        const _targetCell = _cellMatch[1].toUpperCase() + _cellMatch[2];
        // Check if a grid cell is currently focused
        let _isCellFocused = false;
        try {
          const _focusCheck = await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
            text: `(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return false;
              const ariaLabel = el.getAttribute('aria-label') || '';
              if (/cell\\s+[A-Z]+\\d+\\s+selected/i.test(ariaLabel)) return true;
              if (el.closest('[role="gridcell"]')) return true;
              return false;
            })()`,
          });
          _isCellFocused = !!(_focusCheck?.result);
        } catch (_) {}
        if (!_isCellFocused) {
          logger.info(`[instruction.runner] Tab-Map cell-focus guard: no cell focused, focusing ${_targetCell} before typing`);
          const _cellResult = await _focusSpreadsheetCell(sessionId, _targetCell);
          if (_cellResult.ok) {
            await _sleep(300);
            // Type directly into the focused grid cell — do NOT fall through to
            // _llmPickFromTabMap (the tab map contains the formula bar/name box,
            // not grid cells, so it would pick the wrong element).
            logger.info(`[instruction.runner] Tab-Map cell-focus guard: typing "${parsed.value}" directly into cell ${_targetCell}`);
            const _typeResult = await browserAct({
              action: 'type', sessionId, text: parsed.value, headed: true, timeoutMs: 5000,
            });
            if (_typeResult?.ok) {
              await _sleep(200);
              // Press Enter to commit the cell value
              await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 3000 }).catch(() => {});
              return { ok: true, pageChanged: false };
            }
            logger.warn(`[instruction.runner] Tab-Map cell-focus guard: type failed: ${_typeResult?.error}`);
            return { ok: false, pageChanged: false, error: `Cell type failed: ${_typeResult?.error}` };
          } else {
            logger.warn(`[instruction.runner] Tab-Map cell-focus guard failed: ${_cellResult.error}`);
          }
        }
      }
    }

    // Unnamed-target resolution: `Type "v" into the "" field` / bare `Type "v"`
    // means the LLM couldn't name the field (LinkedIn Quill composer has no
    // text/aria-label). Resolve deterministically: focused fillable → sole
    // in-dialog fillable → sole fillable on page. Ambiguous → normal pick.
    const _targetStr = String(parsed.target || '').trim();
    // Generic inferred-kind targets ("text field", "button", ...) are
    // unnamed-target equivalents — the LLM named what it *saw*, which was the
    // inferred label. Resolve deterministically like a "" target.
    const _isGenericTarget = GENERIC_KIND_TARGETS.has(_targetStr.toLowerCase());
    let _unnamedPick = null;
    if (!_targetStr || _isGenericTarget) {
      const _fillables = (tabMap || []).filter(e =>
        ['input', 'textarea'].includes(e.tag || '') ||
        e.role === 'combobox' || e.role === 'textbox' || e.isContentEditable ||
        e.cursor === 'text');
      const _focused = _fillables.find(e => e.focused);
      const _inDialog = _fillables.filter(e => e.inDialog);
      _unnamedPick = _focused
        || (_inDialog.length === 1 ? _inDialog[0] : null)
        || (_fillables.length === 1 ? _fillables[0] : null);
      // Map heuristics exhausted (e.g., non-ARIA modal → no inDialog flags,
      // multiple fillables on the page) — resolve directly in-page: focused →
      // largest fillable inside the detected dialog → sole → largest centered.
      if (!_unnamedPick) {
        try {
          await probeDialogContainer(sessionId, { tag: true });
          _unnamedPick = await resolveUnnamedFillable(sessionId);
        } catch (_) { /* non-fatal — fall through to LLM pick */ }
      }
      if (_unnamedPick) {
        logger.info(`[instruction.runner] Tab-Map: unnamed type target → resolved to ${_unnamedPick.role || _unnamedPick.tag} ${(_unnamedPick.placeholder || _unnamedPick.dataPlaceholder || _unnamedPick.ariaLabel || _unnamedPick.ref || '').slice?.(0, 40) || ''}`);
      }
    }
    let pickedEntry = prePickedEntry || _unnamedPick || await _llmPickFromTabMap(tabMap, 'fill', parsed.target, parsed.value, '');
    if (!pickedEntry) {
      return { ok: false, pageChanged: false, error: `No element found for "${parsed.target || '(unnamed field)'}"`, rescan: true };
    }

    // Verify the picked element's label matches the requested target before typing.
    // Prevents the per-step LLM fallback from typing values into the wrong field
    // (e.g., typing the email address into Subject instead of To recipients).
    // Skipped for unnamed targets ("" target → nothing to match against).
    // Generic-kind targets stay in — entryLabel includes the inferred kind so
    // a pick that landed on the entry rendered as "text field" verifies.
    if (!prePickedEntry && _targetStr) {
      const _pickedLabel = entryLabel(pickedEntry).toLowerCase().trim();
      const _targetLabel = (parsed.target || '').toLowerCase().trim();
      if (!_fuzzyTextMatch(_targetLabel, _pickedLabel)) {
        // LLM picked the wrong element — try deterministic match first
        const _detMatch = await _matchElementToStep(sessionId, { target: parsed.target }, tabMap);
        if (_detMatch) {
          const _detLabel = entryLabel(_detMatch).toLowerCase().trim();
          if (_fuzzyTextMatch(_targetLabel, _detLabel)) {
            logger.warn(`[instruction.runner] Tab-Map type: LLM picked wrong element "${_pickedLabel}" for "${parsed.target}" — using deterministic match instead`);
            pickedEntry = _detMatch;
          } else {
            logger.warn(`[instruction.runner] Tab-Map type: picked "${_pickedLabel}" doesn't match target "${parsed.target}" — requesting rescan`);
            return { ok: false, pageChanged: false, error: `Element mismatch: picked "${_pickedLabel}" for target "${parsed.target}"`, rescan: true };
          }
        } else {
          logger.warn(`[instruction.runner] Tab-Map type: picked "${_pickedLabel}" doesn't match target "${parsed.target}" — requesting rescan`);
          return { ok: false, pageChanged: false, error: `Element mismatch: picked "${_pickedLabel}" for target "${parsed.target}"`, rescan: true };
        }
      }
    }

    // Single-line <input> can't hold newlines — a raw \n becomes an Enter
    // keypress which can submit the form. Collapse newlines to spaces so all
    // text is preserved without Enter semantics. (textarea/contenteditable
    // handle \n natively via keyboard.type/insertText.)
    if (parsed.value && String(parsed.value).includes('\n') &&
        pickedEntry.tag === 'input' && !pickedEntry.isContentEditable) {
      logger.info(`[instruction.runner] Tab-Map type: collapsing newlines in value for single-line input "${parsed.target}"`);
      parsed.value = String(parsed.value).replace(/\s*\n\s*/g, ' ');
    }

    // Focus establishment via the shared primitive (focusField.cjs):
    // already-focused just-type shortcut → CSS click → stale-ref identity
    // re-resolution → guarded tab-walk → focus verify. A stateChanged result
    // means the picked node collapsed/detached since scan — rescan instead of
    // re-picking the dead ref (buildTabMap now invalidates hidden refs).
    const _focusRes = await ensureFieldFocused(sessionId, pickedEntry, { overlayActive });
    if (!_focusRes.ok) {
      const _err = _focusRes.error || `Could not focus "${parsed.target}"`;
      logger.warn(`[instruction.runner] Tab-Map type: focus failed for "${parsed.target}"${_focusRes.stateChanged ? ' (stateChanged — rescan)' : ''}: ${_err}`);
      return { ok: false, pageChanged: false, error: _err, rescan: true };
    }

    // Replace-semantics: a single-value editor (textarea / contenteditable /
    // textbox — NOT combobox/autocomplete chip fields where typing appends)
    // that already holds different content gets select-all before typing, so
    // the new value replaces. Turns the LLM's "clear it first" instinct into
    // a no-op instead of an unparseable Press Ctrl+A or a broken run-code.
    const _existing = String(pickedEntry.value || pickedEntry.currentValue || _focusRes.focusedElement?.currentValue || '').trim();
    if (_existing && String(parsed.value || '').trim() && _existing !== String(parsed.value).trim() &&
        (pickedEntry.tag === 'textarea' || pickedEntry.isContentEditable || pickedEntry.role === 'textbox') &&
        !pickedEntry.ariaAutoComplete && !pickedEntry.ariaOwns) {
      logger.info(`[instruction.runner] Tab-Map type: "${parsed.target || 'field'}" has existing content — select-all before replace`);
      await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 }).catch(() => {});
    }

    // Delegate typing to the shared just-type engine — same executor
    // just.type.agent uses (PRESS_ keys, chip confirm, reactFill, verify).
    const result = await _executeJustType(
      sessionId, parsed.value, _focusRes.focusedElement || pickedEntry,
      _pageCategory, parsed.target, null, null, overlayActive, null,
    );

    return { ok: !!result?.ok, pageChanged: false, error: result?.error, pickedRef: pickedEntry.ref };
  }

  // ── Observation actions (no element matching needed) ──
  if (parsed.action === 'waitForStableText') {
    const result = await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 }).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!result?.ok, pageChanged: false, error: result?.error, pageText: result?.result || '' };
  }

  if (parsed.action === 'getPageText') {
    const result = await browserAct({ action: 'getPageText', sessionId, headed: true, timeoutMs: 10000 }).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!result?.ok, pageChanged: false, error: result?.error, pageText: result?.result || result?.stdout || '' };
  }

  if (parsed.action === 'scroll') {
    const result = await browserAct({ action: 'scroll', sessionId, direction: parsed.direction || 'down', headed: true, timeoutMs: 5000 }).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!result?.ok, pageChanged: false, error: result?.error };
  }

  if (parsed.action === 'screenshot') {
    const result = await browserAct({ action: 'screenshot', sessionId, headed: true, timeoutMs: 5000 }).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!result?.ok, pageChanged: false, error: result?.error };
  }

  if (parsed.action === 'run-code') {
    // LLM run-code snippets are DOM-level (document.querySelector...) — the
    // engine run-code path wraps code as `async page => {}` which has no DOM
    // context and falls back to a CLI that can't attach to engine sessions.
    // Route DOM code through evaluate (in-page); keep run-code only for
    // playwright-style snippets that reference the `page` object.
    const _isDomCode = !/\bpage\s*\./.test(parsed.code);
    const result = _isDomCode
      ? await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 10000,
          text: `(async () => {\n${parsed.code}\n})()` }).catch(e => ({ ok: false, error: e.message }))
      : await browserAct({ action: 'run-code', sessionId, code: parsed.code, headed: true, timeoutMs: 10000 }).catch(e => ({ ok: false, error: e.message }));
    return { ok: !!result?.ok, pageChanged: false, error: result?.error, pageText: result?.result || result?.stdout || '' };
  }

  return { ok: false, pageChanged: false, error: `Unknown action: ${parsed.action}` };
}

// Match a step's target text to an element in the tab-map.
// Tries exact label match, then contains match, then LLM fallback.
// Returns the element object or null.


// Match a step's target text to an element in the tab-map.
// Tries exact label match, then contains match, then LLM fallback.
// Returns the element object or null.
async function _matchElementToStep(sessionId, step, tabMap, goalContext = '') {
  const target = (step.target || '').toLowerCase().trim();
  if (!target) return null;

  const _isTypeAction = step.action === 'type';

  // Commerce anti-match: if the goal/flow step says "Add to Cart" but the
  // step target contains "List"/"Wishlist"/"Registry"/"Save for Later",
  // reject the match and return null (forces re-plan or LLM fallback).
  const _goalLower = (goalContext || '').toLowerCase();
  const _goalIsAddToCart = /\badd\b[\s\S]{0,40}\b(?:cart|bag|basket)\b/i.test(_goalLower) ||
                          /\b(?:cart|bag|basket)\b[\s\S]{0,40}\badd\b/i.test(_goalLower);
  const _targetIsListButton = /\b(?:add\s+to\s+list|wishlist|registry|save\s+for\s+later|add\s+to\s+save)\b/i.test(target) &&
                              !/\b(?:cart|bag|basket)\b/i.test(target);
  if (_goalIsAddToCart && _targetIsListButton) {
    logger.warn(`[instruction.runner] _matchElementToStep: REJECTING match — goal is add-to-cart but target "${step.target}" is a list/wishlist button`);
    return null;
  }

  // Score each element for how well it matches the target.
  // For type actions, non-typeable elements (buttons, menu items) are filtered out.
  // This prevents matching a "Rename" button when we need the "Rename" input.
  const _scoreElement = (e) => {
    const label = (e.text || e.ariaLabel || '').toLowerCase().trim();
    let score = 0;

    // Label matching
    if (label === target) score += 3;
    else if (label.includes(target) || target.includes(label)) score += 2;
    else if (_fuzzyTextMatch(target, label)) score += 1;
    else return 0; // no label match at all

    // Sponsored/ad demotion: on search-results pages the first clickable match
    // is often a sponsored card. Demote (not remove) sponsored elements so
    // organic results win, while still allowing sponsored targets when the
    // goal explicitly asks for them.
    if (e.isSponsored && !/sponsored|promoted|advertis/i.test(target)) score -= 2;

    // Commerce demotion: when the goal is add-to-cart, heavily demote
    // List/Wishlist/Registry/Save-for-Later buttons so they can't win
    // over a real Add to Cart button even on fuzzy/contains matches.
    if (_goalIsAddToCart && /\b(?:add\s+to\s+list|wishlist|registry|save\s+for\s+later|add\s+to\s+save)\b/i.test(label) &&
        !/\b(?:cart|bag|basket)\b/i.test(label)) {
      score -= 5;
    }

    if (!_isTypeAction) return score;

    // For type actions: must be typeable (filter out buttons/menu items)
    const _isTypeable = e.tag === 'input' || e.tag === 'textarea' ||
                        e.isContentEditable || e.role === 'textbox' || e.role === 'combobox';
    if (!_isTypeable) return 0;

    // Bonus signals for type actions:
    // Has placeholder? (cells don't, title/name fields often do)
    if (e.placeholder && e.placeholder.length > 0) score += 1;
    // aria-label matches target? (explicit semantic match)
    if (e.ariaLabel && e.ariaLabel.toLowerCase().includes(target)) score += 2;
    // Has a ref? (clickable via selector)
    if (e.ref) score += 1;
    // Outside canvas region? (chrome elements are typically at y < 100, small width)
    if (e.y !== undefined && e.y < 100 && (e.w || 0) < 400) score += 1;

    return score;
  };

  // Score all elements and pick the highest.
  // Tie-break by largest area (primary action buttons are bigger than table-row
  // buttons), then by smallest y (buy box / main action area is higher on page).
  const scored = tabMap.map(e => ({ entry: e, score: _scoreElement(e) }))
                       .filter(s => s.score > 0)
                       .sort((a, b) => {
                         if (b.score !== a.score) return b.score - a.score;
                         const _aArea = (a.entry.w || 0) * (a.entry.h || 0);
                         const _bArea = (b.entry.w || 0) * (b.entry.h || 0);
                         if (_bArea !== _aArea) return _bArea - _aArea;
                         return (a.entry.y || 0) - (b.entry.y || 0);
                       });

  if (scored.length > 0) {
    const best = scored[0];
    const _next = scored[1];
    logger.info(`[instruction.runner] _matchElementToStep: scored match "${step.target}" → #${best.entry.id} (score=${best.score}${_next ? `, next=${_next.score}` : ''})`);
    return best.entry;
  }

  // LLM fallback — ask which element ID matches
  const { askWithMessages } = require('../../../skill-helpers/skill-llm.cjs');
  const elementList = tabMap.map(e =>
    `${e.id} - ${e.tag || ''} "${e.text || e.ariaLabel || ''}" ${e.role || ''}${e.isSponsored ? ' [SPONSORED]' : ''}`
  ).join('\n');
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'Return ONLY the element ID number that best matches the target. No other text. Elements marked [SPONSORED] are ads — prefer non-sponsored elements unless the target explicitly asks for a sponsored/ad result.' },
      { role: 'user', content: `Target: "${step.target}"\nElements:\n${elementList}\n\nWhich element ID matches?` },
    ], { maxTokens: 30, temperature: 0.1, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    const match = tabMap.find(e => e.id === num);
    if (match) {
      logger.info(`[instruction.runner] _matchElementToStep: LLM match "${step.target}" → #${match.id}`);
      return match;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _matchElementToStep LLM fallback failed: ${e.message}`);
  }
  return null;
}

// Sentinel returned by _classifyOnPageAction when the target is an on-page
// action but no element meets the strength threshold. The caller uses this to
// decide between paginating (more tab-map pages) vs. marking Tab-Map exhausted
// for this state (if the scan already looped back to the original starter).


// Sentinel returned by _classifyOnPageAction when the target is an on-page
// action but no element meets the strength threshold. The caller uses this to
// decide between paginating (more tab-map pages) vs. marking Tab-Map exhausted
// for this state (if the scan already looped back to the original starter).
const ON_PAGE_NOT_FOUND = Symbol('on-page-not-found');

// On-page action targets: single click of a known button label. These are
// commerce/mutation actions performed on the current page (no navigation).
// The regex is intentionally general — matches "add to cart", "add it to the
// cart", "add the first result to the cart", "buy now", "add to bag/basket",
// "add to wishlist", etc. across sites (Amazon, Target, Etsy, etc.). It allows
// optional words ("it", "the", "to the", "first result", product names) between
// "add" and "to ... cart/bag/basket" so decomposed multi-step goals like
// "add the first result to the cart" are still detected as on-page actions.


// On-page action targets: single click of a known button label. These are
// commerce/mutation actions performed on the current page (no navigation).
// The regex is intentionally general — matches "add to cart", "add it to the
// cart", "add the first result to the cart", "buy now", "add to bag/basket",
// "add to wishlist", etc. across sites (Amazon, Target, Etsy, etc.). It allows
// optional words ("it", "the", "to the", "first result", product names) between
// "add" and "to ... cart/bag/basket" so decomposed multi-step goals like
// "add the first result to the cart" are still detected as on-page actions.
const _ON_PAGE_ACTION_RE = /\b(?:add\b[^.]{0,40}?\bto\b[^.]{0,20}?\b(?:cart|bag|basket|wishlist|wish ?list|favorites?|watch ?later)\b|buy\s+now|subscribe\s+(?:now|to))\b/i;

// Detects whether a goal is an on-page action (single click of a known button
// on the current page, no navigation). Returns the normalized target label
// (e.g. "Add to Cart") if it is, or null if it isn't.


// Detects whether a goal is an on-page action (single click of a known button
// on the current page, no navigation). Returns the normalized target label
// (e.g. "Add to Cart") if it is, or null if it isn't.
function _detectOnPageAction(goal) {
  if (!goal) return null;
  const m = _ON_PAGE_ACTION_RE.exec(String(goal));
  if (!m) return null;
  // Normalize the matched phrase to a canonical button label.
  const _raw = m[0].replace(/\s+/g, ' ').trim().toLowerCase();
  if (/buy\s+now/.test(_raw)) return 'Buy Now';
  if (/subscribe/.test(_raw)) return 'Subscribe';
  if (/wishlist|wish ?list/.test(_raw)) return 'Add to Wishlist';
  if (/favorites?/.test(_raw)) return 'Add to Favorites';
  if (/watch ?later/.test(_raw)) return 'Add to Watch Later';
  if (/bag/.test(_raw)) return 'Add to Bag';
  if (/basket/.test(_raw)) return 'Add to Basket';
  if (/cart/.test(_raw)) return 'Add to Cart';
  return m[0].replace(/\s+/g, ' ').trim();
}

// Whether to force a focus reset to page top before building the tab-map.
// On shopping product pages the primary action button (Add to Cart, Buy Now)
// lives in the buybox near the top. When a session is reused after a previous
// click (e.g. clicking a search result), skipReset=true would start the scan
// mid-page and miss the buybox. Override to reset focus for shopping primary-
// action goals so the scan reaches the buybox. Never override when an overlay
// is open (overlay scans must keep skipReset=true).


// Whether to force a focus reset to page top before building the tab-map.
// On shopping product pages the primary action button (Add to Cart, Buy Now)
// lives in the buybox near the top. When a session is reused after a previous
// click (e.g. clicking a search result), skipReset=true would start the scan
// mid-page and miss the buybox. Override to reset focus for shopping primary-
// action goals so the scan reaches the buybox. Never override when an overlay
// is open (overlay scans must keep skipReset=true).
function _shouldForceFocusReset(goal, pageCategory, overlayActive) {
  if (overlayActive) return false;
  if (pageCategory !== 'shopping') return false;
  return !!_detectOnPageAction(goal);
}

// True if a step target label is an on-page primary action button (Add to Cart,
// Buy Now, Add to Bag, etc.). Used to decide which clicks get the post-click
// page-change guard. Broader than _detectOnPageAction (which parses the whole
// goal) — this matches a bare button label like "Add to Cart".


// True if a step target label is an on-page primary action button (Add to Cart,
// Buy Now, Add to Bag, etc.). Used to decide which clicks get the post-click
// page-change guard. Broader than _detectOnPageAction (which parses the whole
// goal) — this matches a bare button label like "Add to Cart".
const _ON_PAGE_ACTION_LABEL_RE = /^(?:add\s+to\s+(?:cart|bag|basket|wishlist|wish ?list|favorites?|watch ?later)|buy\s+now|subscribe(?:\s+now)?|add\s+to\s+order)$/i;

function _isOnPageActionLabel(label) {
  if (!label) return false;
  return _ON_PAGE_ACTION_LABEL_RE.test(String(label).trim());
}

// Known ad/tracking redirect domains. A click that navigates here is an
// ad/affiliate link, not the primary action — reject and retry the next
// candidate. General list, not site-specific.


// Known ad/tracking redirect domains. A click that navigates here is an
// ad/affiliate link, not the primary action — reject and retry the next
// candidate. General list, not site-specific.
const _AD_TRACKING_DOMAINS = [
  'amazon-adsystem.com', 'doubleclick.net', 'googleadservices.com',
  'googlesyndication.com', 'adservice.google.com', 'adnxs.com',
  'criteo.com', 'taboola.com', 'outbrain.com', 'facebook.com/tr',
  'analytics.google.com', 'googletagmanager.com', 'scorecardresearch.com',
  'ads.yahoo.com', 'advertising.com', 'moatads.com', 'rubiconproject.com',
  'pubmatic.com', 'openx.net', 'casalemedia.com', '3lift.com',
];

function _isAdOrTrackingDomain(url) {
  if (!url) return false;
  try {
    const _host = String(url).replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    return _AD_TRACKING_DOMAINS.some(d => _host === d || _host.endsWith('.' + d));
  } catch (_) { return false; }
}

// Classify an on-page action target against the current tab-map with a
// strength threshold. This is stricter than _matchElementToStep: it rejects
// weak/ambiguous matches (e.g. a carousel "Add to Cart" for a different
// product) so the caller can paginate to find the strong exact buybox button.
//
// Returns:
//   { entry }       — a strong match was found (accept)
//   ON_PAGE_NOT_FOUND — target is an on-page action but no strong match (reject)
//   null            — target is NOT an on-page action (caller falls through
//                     to the existing _extractSteps planner)
//
// Strength threshold:
//   - Accept if best score >= 3 (exact label match)
//   - OR best score >= 2 AND element is large (w*h >= 20000) AND high on page
//     (y < 600) AND not sponsored — the buybox button is large and near the top
//   - Otherwise reject (ON_PAGE_NOT_FOUND) so pagination continues


// Classify an on-page action target against the current tab-map with a
// strength threshold. This is stricter than _matchElementToStep: it rejects
// weak/ambiguous matches (e.g. a carousel "Add to Cart" for a different
// product) so the caller can paginate to find the strong exact buybox button.
//
// Returns:
//   { entry }       — a strong match was found (accept)
//   ON_PAGE_NOT_FOUND — target is an on-page action but no strong match (reject)
//   null            — target is NOT an on-page action (caller falls through
//                     to the existing _extractSteps planner)
//
// Strength threshold:
//   - Accept if best score >= 3 (exact label match)
//   - OR best score >= 2 AND element is large (w*h >= 20000) AND high on page
//     (y < 600) AND not sponsored — the buybox button is large and near the top
//   - Otherwise reject (ON_PAGE_NOT_FOUND) so pagination continues
async function _classifyOnPageAction(goal, tabMap, ctx = {}) {
  const target = _detectOnPageAction(goal);
  if (!target) return null; // not an on-page action — caller falls through

  const _targetLower = target.toLowerCase();
  const _isProductPageUrl = /\/(?:dp|p|product|products|item|items)\//i.test(ctx.currentUrl || '');
  const _consumedRefs = ctx.consumedRefs || new Set();

  // Score each element using the same label-matching logic as _matchElementToStep
  const _scoreElement = (e) => {
    // Exclude already-tried refs (wrong-target retries)
    if (e.ref && _consumedRefs.has(e.ref)) return 0;
    const label = (e.text || e.ariaLabel || '').toLowerCase().trim();
    if (!label) return 0;
    let score = 0;
    if (label === _targetLower) score += 3;
    else if (label.includes(_targetLower) || _targetLower.includes(label)) score += 2;
    else if (_fuzzyTextMatch(_targetLower, label)) score += 1;
    else return 0;

    // Demote sponsored elements (carousel/related-products area)
    if (e.isSponsored) score -= 2;
    return score;
  };

  const scored = (tabMap || [])
    .map(e => ({ entry: e, score: _scoreElement(e) }))
    .filter(s => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const _aArea = (a.entry.w || 0) * (a.entry.h || 0);
      const _bArea = (b.entry.w || 0) * (b.entry.h || 0);
      if (_bArea !== _aArea) return _bArea - _aArea;
      return (a.entry.y || 0) - (b.entry.y || 0);
    });

  if (scored.length === 0) {
    logger.info(`[instruction.runner] _classifyOnPageAction: no match for "${target}" (tab-map has ${tabMap?.length || 0} elements) → NOT_FOUND`);
    return ON_PAGE_NOT_FOUND;
  }

  const best = scored[0];
  const _area = (best.entry.w || 0) * (best.entry.h || 0);
  const _high = (best.entry.y || 0) < 600;
  const _large = _area >= 20000;
  const _notSponsored = !best.entry.isSponsored;

  // Strength threshold: exact match (score>=3) always accepted.
  // Weak match (score=2) accepted only if large + high + not sponsored
  // (the buybox button profile). Otherwise reject so pagination continues.
  const _accept = best.score >= 3 || (best.score >= 2 && _large && _high && _notSponsored);

  if (_accept) {
    logger.info(`[instruction.runner] _classifyOnPageAction: accepted "${target}" → #${best.entry.id} (score=${best.score}, area=${_area}, y=${best.entry.y || '?'}, sponsored=${!!best.entry.isSponsored})`);
    return { entry: best.entry };
  }

  logger.info(`[instruction.runner] _classifyOnPageAction: weak match "${target}" → #${best.entry.id} (score=${best.score}, area=${_area}, y=${best.entry.y || '?'}, sponsored=${!!best.entry.isSponsored}) → NOT_FOUND (will paginate or exhaust)`);
  return ON_PAGE_NOT_FOUND;
}



// Step-based Tab-Map: runs ONE step from a pre-extracted step plan.
// Returns same shape as _tabMapInnerStep: { done, ok, error, stateChanged, filledRef, filledLabel, filledValue, rescan, action, fallbackToLlm }


// Step-based Tab-Map: runs ONE step from a pre-extracted step plan.
// Returns same shape as _tabMapInnerStep: { done, ok, error, stateChanged, filledRef, filledLabel, filledValue, rescan, action, fallbackToLlm }
async function _tabMapStepExecute(sessionId, step, stepIndex, stepCount, tabMap, overlayActive, pageCategory, currentUrl, progressCallbackUrl = null, _outerStepIndex = 0, agentId = '', sessionUuid = '', goalContext = '') {
  logger.info(`[instruction.runner] Tab-Map step ${stepIndex + 1}/${stepCount}: ${JSON.stringify(step)}`);

  // Emit tab_map:step_start so the frontend can mark this sub-step as running
  _emitProgress(progressCallbackUrl, _outerStepIndex, {
    type: 'tab_map:step_start',
    subStepIndex: stepIndex,
    subStepTotal: stepCount,
    action: step.action,
    target: step.target || step.key || step.value || '',
  }, agentId, sessionUuid);

  // Handle "done" step
  if (step.action === 'done') {
    return { done: true, ok: true, action: 'DONE' };
  }

  // Open/create button guard: if an overlay/dialog is already open and the
  // step is a click on an open/create button (e.g. "Start a post", "Compose"),
  // skip it as a no-op. The composer is already open — don't open another one.
  const _openCreateKeywords = /\bstart a post\b|\bnew post\b|\bcompose\b|\bnew\s+(?:post|tweet|message|document|page)\b|\bcreate\s+(?:new|post|tweet|message|document|page)?\b/i;
  if (step.action === 'click' && overlayActive && _openCreateKeywords.test(step.target || '')) {
    if (pageCategory === 'social_feed' || pageCategory === 'ai_chat' || pageCategory === 'email_compose') {
      logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: skipping open/create click "${step.target}" — compose dialog already open (overlayActive=${overlayActive})`);
      return { done: false, ok: true, stateChanged: false, action: `SKIP "${step.target}"` };
    }
  }

  // Multi-line type guard: a single type action with \n in a block-structured
  // editor corrupts the page (types into the wrong field, creates wrong blocks).
  // Only applies to categories where Enter has structural semantics —
  // document_editor (Notion, Google Docs: Enter = new block) and spreadsheet
  // (Enter = commit cell + move down). For all other categories (email_compose,
  // ai_chat, messaging, social_feed, code_editor, generic forms) \n is a plain
  // line break handled safely by insertText — let the type proceed normally.
  const _MULTILINE_GUARD_CATEGORIES = ['document_editor', 'spreadsheet'];
  if (step.action === 'type' && typeof step.value === 'string' && step.value.includes('\n') &&
      _MULTILINE_GUARD_CATEGORIES.includes(pageCategory)) {
    logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: multi-line type value detected (${step.value.split('\n').length} lines) in ${pageCategory} — aborting, falling back to per-step LLM`);
    return { done: false, ok: false, error: 'Multi-line type action not allowed in Tab-Map — use per-step LLM', fallbackToLlm: true, action: `type (multi-line)` };
  }

  // Handle "press" step (no target needed)
  if (step.action === 'press') {
    const keyMap = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape' };
    const result = await browserAct({ action: 'press', sessionId, key: keyMap[step.key] || step.key, headed: true, timeoutMs: 5000 });
    await _sleep(500);
    const _postUrl = await _getUrl(sessionId);
    const pageChanged = _postUrl !== currentUrl;
    return {
      done: pageChanged,
      ok: !!result?.ok,
      pageChanged,
      stateChanged: pageChanged,
      error: result?.error,
      action: `Press ${step.key}`,
    };
  }

  // Handle observation actions (no element matching needed)
  if (step.action === 'waitForStableText' || step.action === 'getPageText' ||
      step.action === 'scroll' || step.action === 'screenshot' || step.action === 'run-code') {
    const parsed = { action: step.action, direction: step.direction, code: step.code };
    const result = await _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory, null);
    const _actionLabel = step.action === 'run-code' ? 'Run code' :
                         step.action === 'waitForStableText' ? 'Wait for stable text' :
                         step.action === 'getPageText' ? 'Get page text' :
                         step.action === 'scroll' ? `Scroll ${step.direction || 'down'}` :
                         'Screenshot';
    return {
      done: false,
      ok: !!result?.ok,
      pageChanged: false,
      stateChanged: false,
      error: result?.error,
      extractedText: result?.pageText || '',
      action: _actionLabel,
    };
  }

  // Match target to element
  let pickedEntry = null;
  if (step._preClassifiedRef) {
    // Pre-classified by _classifyOnPageAction (on-page action pagination) —
    // skip _matchElementToStep and use the pre-picked ref directly.
    pickedEntry = tabMap.find(e => e.ref === step._preClassifiedRef) ||
                  { ref: step._preClassifiedRef, id: step._preClassifiedId, text: step.target };
    logger.info(`[instruction.runner] Tab-Map step ${stepIndex + 1}: using pre-classified ref ${step._preClassifiedRef} for "${step.target}"`);
  } else if (step.target) {
    pickedEntry = await _matchElementToStep(sessionId, step, tabMap, goalContext);
    if (!pickedEntry) {
      logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: no element matched "${step.target}" — falling back to per-step LLM`);
      return { done: false, ok: false, error: `No element matched "${step.target}"`, fallbackToLlm: true, action: `${step.action} "${step.target}"` };
    }
  }

  // Build parsed action for _executeTabMapAction
  const parsed = {
    action: step.action,
    target: step.target,
    value: step.value,
    key: step.key,
  };

  // Execute via existing _executeTabMapAction (handles click/type with all fallbacks)
  // Pass the pre-picked element so _executeTabMapAction doesn't call _llmPickFromTabMap again
  // For on-page action clicks (Add to Cart, Buy Now, etc.), capture pre-click URL for the
  // universal post-click guard (detects ad/tracking-domain navigation AND wrong-product drift).
  const _isOnPageClick = step.action === 'click' && _isOnPageActionLabel(step.target);
  const _guardPreUrl = (_isOnPageClick || step._preClassifiedRef) ? await _getUrl(sessionId).catch(() => '') : null;
  // Submit-marker: stamp BEFORE the click so a send-API POST landing in the
  // netLog right after is attributed to this submit (correlated send detection —
  // covers endpoints the _SEND_ENDPOINT_RE name list doesn't know).
  if (step.action === 'click' && _submitLabels.test(step.target || '')) {
    try {
      const { _markSubmitAttempt } = require('../../browser.agent.cjs');
      _markSubmitAttempt(sessionId, currentUrl ? new URL(currentUrl).hostname : '');
    } catch (_) {}
  }
  const result = await _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory, pickedEntry);

  // ── Universal post-click guard for on-page actions ──────────────────────
  // Two checks after an on-page action click:
  //   1. Ad/tracking-domain navigation: the clicked element was an ad/affiliate
  //      link (e.g. amazon-adsystem.com), not the real action button. Reject.
  //   2. Wrong-product drift: the click navigated to a DIFFERENT product page
  //      (e.g. a carousel "Add to Cart" for a related product). Navigate back.
  // In both cases signal wrongTarget so the caller retries with the next-best
  // candidate (consumed refs prevent re-picking the same element).
  if ((_isOnPageClick || step._preClassifiedRef) && _guardPreUrl && result.pageChanged) {
    const _postGuardUrl = await _getUrl(sessionId).catch(() => '');
    if (_postGuardUrl) {
      // 1. Ad/tracking-domain guard
      if (_isAdOrTrackingDomain(_postGuardUrl)) {
        logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: post-click guard detected ad/tracking-domain navigation (${_postGuardUrl.slice(0, 80)}) — navigating back to original page`);
        try {
          await browserAct({ action: 'navigate', sessionId, url: _guardPreUrl, headed: true, timeoutMs: 30000 });
          await _sleep(2000);
        } catch (e) {
          logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: navigate-back failed: ${e.message}`);
        }
        return { done: false, ok: false, error: `Ad/tracking-domain navigation detected by post-click guard`, wrongTarget: true, consumedRef: pickedEntry?.ref, action: `${step.action} "${step.target}"` };
      }
      // 2. Wrong-product drift guard
      if (_extractProductPath(_guardPreUrl) !== _extractProductPath(_postGuardUrl)) {
        logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: post-click guard detected wrong-product navigation (pre=${_extractProductPath(_guardPreUrl)}, post=${_extractProductPath(_postGuardUrl)}) — navigating back to original product`);
        try {
          await browserAct({ action: 'navigate', sessionId, url: _guardPreUrl, headed: true, timeoutMs: 30000 });
          await _sleep(2000);
        } catch (e) {
          logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: navigate-back failed: ${e.message}`);
        }
        return { done: false, ok: false, error: `Wrong-product navigation detected by post-click guard`, wrongTarget: true, consumedRef: pickedEntry?.ref, action: `${step.action} "${step.target}"` };
      }
    }
  }

  // Handle lazy re-scan signal
  if (result.rescan) {
    return { done: false, ok: false, error: result.error, rescan: true, action: `${step.action} "${step.target}"` };
  }

  // Track filled fields
  let filledRef = null, filledLabel = null, filledValue = null;
  if (step.action === 'type' && result.ok && result.pickedRef) {
    filledRef = result.pickedRef;
    filledLabel = step.target;
    filledValue = step.value;
  }

  // Check for submit actions — only real submit/primary action buttons, not
  // open/create labels like "Start a post" or "New post".
  // (_submitLabels declared above — also used for the pre-click submit marker.)
  if (step.action === 'click' && _submitLabels.test(step.target || '')) {
    const _verify = await _verifySubmitSuccess(sessionId, step.target, { url: currentUrl });
    if (_verify?.ok) {
      return { done: true, ok: true, stateChanged: true, action: `Click "${step.target}"` };
    }
    logger.warn(`[instruction.runner] Tab-Map step ${stepIndex + 1}: submit verification failed — re-scanning`);
    return { done: false, ok: false, error: 'Submit verification failed', rescan: true, action: `Click "${step.target}"` };
  }

  // Type actions don't end the session on page change — chip confirmations,
  // dropdown closures, and autocomplete selections are within-overlay changes,
  // not page navigation. Only click/press actions can end the session.
  const stateChanged = step.action === 'type' ? false : result.pageChanged;
  // Only end the session (done=true) on the LAST step of the plan.
  // For intermediate steps, a URL/state change means we need to re-scan and
  // continue — NOT that the goal is achieved.
  const _isLastStep = stepIndex >= stepCount - 1;
  // Emit tab_map:step_done so the frontend can mark this sub-step as done/failed
  _emitProgress(progressCallbackUrl, _outerStepIndex, {
    type: 'tab_map:step_done',
    subStepIndex: stepIndex,
    subStepTotal: stepCount,
    ok: result.ok,
    stateChanged,
  }, agentId, sessionUuid);
  return {
    done: _isLastStep ? stateChanged : false, // only end session on last step
    ok: result.ok,
    error: result.error,
    stateChanged,
    filledRef,
    filledLabel,
    filledValue,
    action: `${step.action} "${step.target || step.key || ''}"`,
  };
}

// Tab-Map inner loop: runs ONE step of the Tab-Map scan session.
// Returns { done, ok, error, stateChanged, filledRef, filledLabel, filledValue }
//   done=true when session ends (DONE, state change, or failure)


// ── Goal-completion gate ────────────────────────────────────────────────────
// Shared by the explicit-DONE path and the stateChanged path. Returns a reject
// reason when the action history can't yet support the goal claim, else null.
// Checks:
//   - nav-only actions for a non-navigation goal
//   - compound goal ("X and Y") where the last action navigated — unmet clauses
//   - submit-implying goal (send/save/create/…) with no submit action or send-API
//   - rename/title goal whose quoted value isn't in document.title — a value
//     typed into a dialog input is UNCOMMITTED until Enter/blur lands it
async function _goalCompletionRejectReason(goal, actionHistory, sessionId) {
  const _hist = (actionHistory || []).join('\n');
  const _isNavGoal = /^(navigate to|go to)\b/i.test(goal || '');
  const _onlyNav = (actionHistory || []).length > 0 && actionHistory.length <= 2 &&
    actionHistory.every(a => /navigate/i.test(a));
  const _compound = /(?:and\s+then|,?\s+and\s+|then\s+|after\s+.*\s+click)/i.test(goal || '');
  const _lastChanged = /→\s*page changed/.test((actionHistory || [])[(actionHistory || []).length - 1] || '');
  const _submitGoal = /\b(send|submit|save|create|post|publish|apply|checkout|book|order|schedule)\b/i.test(goal || '');
  const _hasSubmitAct = /click "[^"]*(send|submit|save|post|publish|confirm)[^"]*"|(?:meta|control|ctrl|cmd)\+enter/i.test(_hist);
  let _sent = false;
  if (_submitGoal && !_hasSubmitAct) {
    try {
      const { _detectSuccessfulSend } = require('../../browser.agent.cjs');
      _sent = !!_detectSuccessfulSend?.(sessionId);
    } catch (_) {}
  }
  if (_onlyNav && !_isNavGoal) return 'navigate-only actions for a non-navigation goal';
  if (_compound && _lastChanged) return 'compound goal with unmet clauses after navigation';
  if (_submitGoal && !_hasSubmitAct && !_sent) return 'goal implies submit/send but no submit action or send-API success was recorded';
  // Committed-title check: for rename/set-title goals the quoted value must
  // appear in document.title — an in-field verify passes while the value sits
  // uncommitted in the input (observed: "Trip Budget" typed into the Sheets
  // Rename field, never Enter'd, sheet stayed Untitled — then a later script
  // overwrote it with "item").
  const _renameGoal = /\b(rename|set the .{0,14}title|title it|name it|call it)\b/i.test(goal || '');
  if (_renameGoal) {
    const q = String(goal || '').match(/"([^"]{2,120})"/) || String(goal || '').match(/'([^']{2,120})'/);
    if (q && sessionId) {
      try {
        const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'document.title' });
        const raw = res?.result;
        const docTitle = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : '';
        if (docTitle && !docTitle.toLowerCase().includes(q[1].trim().toLowerCase())) {
          return `rename value '${q[1].trim()}' not committed — document.title is '${docTitle.slice(0, 60)}'`;
        }
      } catch (_) { /* probe failure doesn't reject */ }
    }
  }
  return null;
}

// Tab-Map inner loop: runs ONE step of the Tab-Map scan session.
// Returns { done, ok, error, stateChanged, filledRef, filledLabel, filledValue }
//   done=true when session ends (DONE, state change, or failure)
async function _tabMapInnerStep(sessionId, goal, actionHistory, currentUrl, overlayActive, pageCategory, agentContext, cachedTabMap, filledFields, consumedRefs, lastVerifyFailed, extractedPageText, stepType = null, clickedRefs = null, clickedSubmitRefs = null) {
  const { _llmNextAction } = require('../../browser.agent.cjs');

  // 1. Use cached tab-map (scan session — no re-scan unless invalidated by caller)
  const tabMap = cachedTabMap;
  if (!tabMap || tabMap.length === 0) {
    return { done: true, ok: false, error: 'Tab-map is empty' };
  }

  // 2. Ask LLM for next action
  const nextAction = await _llmNextAction(goal, currentUrl, tabMap, actionHistory, pageCategory, agentContext, lastVerifyFailed, consumedRefs, filledFields, extractedPageText, stepType, clickedRefs, clickedSubmitRefs, overlayActive);
  if (!nextAction) {
    logger.warn(`[instruction.runner] Tab-Map: LLM returned null — treating as failure (not done)`);
    return { done: true, ok: false, error: 'LLM returned null (provider failed)' };
  }
  logger.info(`[instruction.runner] Tab-Map step: LLM says "${nextAction}"`);

  // 3. Parse the action
  const parsed = _parseAction(nextAction);
  if (!parsed) {
    // Recoverable: a garbled/prose LLM emission shouldn't kill the step — the
    // caller records it FAILED, nudges the LLM to emit a clean action line,
    // and retries within maxSteps instead of aborting to ask_user.
    logger.warn(`[instruction.runner] Tab-Map: couldn't parse "${nextAction}" — retrying (not fatal)`);
    return { done: false, ok: false, parseFailed: true, action: `unparseable output: ${String(nextAction).slice(0, 60)}`, error: `Could not parse LLM action: "${nextAction}"` };
  }

  // 4. Handle DONE — with the guards the old runner loop had (dropped in the
  // atomic extraction): nav-only, compound-clause, and submit-goal checks.
  if (parsed.action === 'done') {
    const _rejectReason = await _goalCompletionRejectReason(goal, actionHistory, sessionId);
    if (_rejectReason) {
      logger.warn(`[instruction.runner] Tab-Map: Done rejected — ${_rejectReason}`);
      return { done: false, ok: false, error: `Done rejected: ${_rejectReason}`, verifyFailed: true, action: nextAction };
    }
    return { done: true, ok: true };
  }

  // 5. Loop detection: same action 3x consecutively
  // Strip the "→ ok/→ FAILED" suffix that actionHistory adds (line ~3731) so
  // we compare the raw LLM action text, not the formatted history entry.
  const _lastActions = actionHistory.slice(-2).map(a => String(a).replace(/\s+→.*$/, ''));
  if (_lastActions.length === 2 && _lastActions[0] === nextAction && _lastActions[1] === nextAction) {
    logger.warn(`[instruction.runner] Tab-Map: loop detected — same action 3x ("${nextAction}") — stopping session`);
    return { done: true, ok: false, error: `Loop detected — same action repeated 3 times: "${nextAction}"` };
  }

  // 5b. Deterministic already-filled guard (non-LLM): a type action whose
  // target+value matches a field we already filled this session must not
  // re-execute — re-typing a chip field produces residual duplicate text.
  if (parsed.action === 'type' && parsed.value && (filledFields || []).length) {
    const _t = String(parsed.target || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const _v = String(parsed.value).toLowerCase().replace(/\s+/g, ' ').trim();
    const _dup = filledFields.some(f => {
      const fl = String(f.label || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const fv = String(f.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const labelMatch = fl && _t && (fl === _t || fl.includes(_t) || _t.includes(fl));
      const valueMatch = fv && _v && (fv === _v || fv.includes(_v) || _v.includes(fv));
      return labelMatch && valueMatch;
    });
    if (_dup) {
      logger.info(`[instruction.runner] Tab-Map: "${parsed.target}" already filled with same value — skipping re-type`);
      return { done: false, ok: true, alreadyFilled: true, action: nextAction };
    }
  }

  // 5c. Hard guard: suppressed submit can't be re-picked even if the LLM names
  // it (prompt-level exclusion is soft — the picker resolves against the raw
  // map). Any successful fill clears clickedSubmitRefs, so this only blocks
  // re-clicks while form state is unchanged.
  if (parsed.action === 'click' && clickedSubmitRefs?.size && Array.isArray(tabMap)) {
    const _supEntry = tabMap.find(e => e.ref && clickedSubmitRefs.has(e.ref));
    const _supLabel = String(_supEntry?.text || _supEntry?.ariaLabel || '').toLowerCase();
    const _pt = String(parsed.target || '').toLowerCase();
    if (_supLabel && _pt && (_supLabel.includes(_pt) || _pt.includes(_supLabel) || _fuzzyTextMatch(_pt, _supLabel))) {
      logger.warn(`[instruction.runner] Tab-Map: submit "${parsed.target}" already clicked with unchanged fields — suppressing re-click`);
      return { done: false, ok: true, suppressed: true, action: nextAction };
    }
  }

  // 6. Execute the action — stamp a submit marker first for submit-labeled
  // clicks so a send-API POST landing right after is attributed to this submit.
  if (parsed.action === 'click' && _submitLabels.test(parsed.target || '')) {
    try {
      const { _markSubmitAttempt } = require('../../browser.agent.cjs');
      _markSubmitAttempt(sessionId, currentUrl ? new URL(currentUrl).hostname : '');
    } catch (_) {}
  }
  const result = await _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory);

  // 7. Handle lazy re-scan signal
  if (result.rescan) {
    logger.info(`[instruction.runner] Tab-Map: element not found — signaling re-scan`);
    return { done: false, ok: false, error: result.error, rescan: true, action: nextAction };
  }

  // 8. Track filled fields
  let filledRef = null, filledLabel = null, filledValue = null;
  if (parsed.action === 'type' && result.ok && result.pickedRef) {
    filledRef = result.pickedRef;
    filledLabel = parsed.target;
    filledValue = parsed.value;
  }

  // 9. Check for submit actions
  let submitVerified = false;
  if (parsed.action === 'click' && _submitLabels.test(parsed.target || '')) {
    const _verify = await _verifySubmitSuccess(sessionId, parsed.target, { url: currentUrl });
    if (_verify?.ok) {
      submitVerified = true;
      return { done: true, ok: true, stateChanged: true, action: nextAction };
    }
    logger.warn(`[instruction.runner] Tab-Map: submit verification failed — re-scanning`);
    return { done: false, ok: false, error: 'Submit verification failed', rescan: true, action: nextAction };
  }

  // 10. Check for state change — URL nav ends the session, but a DOM-only
  // dialog open/close (LinkedIn "Start a post", share composer) must rescan
  // instead: the element map is stale the moment an overlay mounts.
  const stateChanged = result.pageChanged;
  if (result.overlayChanged) {
    return {
      done: false,
      ok: result.ok,
      rescan: true,
      overlayOpened: result.overlayChanged === 'opened',
      stateChanged: true,
      clickedRef: parsed.action === 'click' && result.ok ? (result.pickedRef || null) : null,
      action: nextAction,
    };
  }

  // A state-changing action isn't proof of goal completion for non-navigation
  // goals — a mid-goal click that navigates (calendar month switch, wrong link)
  // used to end the session as success with zero goal work done. Run the same
  // completion gate as explicit DONE; on rejection, rescan the NEW page and
  // keep working — the later explicit DONE goes through the same guards.
  let _doneViaState = stateChanged;
  if (_doneViaState && result.ok) {
    const _scReason = await _goalCompletionRejectReason(goal, [...(actionHistory || []), `${nextAction} → page changed`], sessionId);
    if (_scReason) {
      logger.warn(`[instruction.runner] Tab-Map: stateChanged but goal gate rejected (${_scReason}) — rescanning and continuing`);
      return {
        done: false, ok: true, rescan: true, stateChanged: true,
        filledRef, filledLabel, filledValue,
        clickedRef: parsed.action === 'click' && result.ok ? (result.pickedRef || null) : null,
        action: nextAction,
      };
    }
  }

  return {
    done: _doneViaState, // session ends on state change
    ok: result.ok,
    error: result.error,
    stateChanged,
    filledRef,
    filledLabel,
    filledValue,
    clickedRef: parsed.action === 'click' && result.ok ? (result.pickedRef || null) : null,
    clickedSubmit: parsed.action === 'click' && result.ok &&
      /\b(send|submit|post|publish|save|create|delete|confirm|ok|apply|done|finish|complete|next|continue|yes|update|sign\s*up|register|log\s*in|sign\s*in|place\s*order|buy|checkout|book|reserve|schedule|subscribe)\b/i.test(parsed.target || ''),
    extractedText: result.pageText || '',
    action: nextAction,
  };
}

// ── Deterministic tier selection (replaces LLM _decisionCall) ─────────
// Probes page structure (scoped to overlay if open) and selects tier
// based on fillable/clickable element counts + page category + shortcuts.
// Returns: 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Shortcuts), 4 (Tab-Map)

// Count fillable + clickable elements, scoped to overlay if one is open.
// Returns { fillableCount, clickableCount, hasAutoFocus }

module.exports = {
  _resetFocusToPageTop,
  _focusByRef,
  _bulkReadTabMapMetadata,
  _scrollActiveIntoView,
  _elementSignature,
  _isRealFocusChange,
  _normalizeText,
  _isSubsequence,
  _levenshtein,
  _fuzzyTextMatch,
  _getDomainFromSession,
  _tabMapFilePath,
  _loadTabMap,
  _saveTabMap,
  buildTabMap,
  _focusNearestInput,
  pageSearch,
  _scrollPageDown,
  _scrollToTop,
  _pageSearchWithScroll,
  pageSearchAndTabTo,
  _formatTabMapEntryForLLM,
  _llmPickFromTabMap,
  _llmPickRevealButton,
  _rectOverlapPercent,
  _fuzzyTextScore,
  _focusSpreadsheetCell,
  _typeIntoSpreadsheetCell,
  _getCurrentCell,
  _calculateArrowMoves,
  _executeTabMapAction,
  _matchElementToStep,
  ON_PAGE_NOT_FOUND,
  _detectOnPageAction,
  _shouldForceFocusReset,
  _isOnPageActionLabel,
  _isAdOrTrackingDomain,
  _classifyOnPageAction,
  _tabMapStepExecute,
  _tabMapInnerStep,
  _goalCompletionRejectReason,
};
