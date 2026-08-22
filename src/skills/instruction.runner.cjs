'use strict';

// ---------------------------------------------------------------------------
// instruction.runner.cjs — Keyboard path navigation for recorded skills
//
// Instead of resolving DOM refs via LLM/snapshots/overlays, this runner uses
// pure keyboard navigation from the address bar:
//   1. Navigate to startUrl (URL-first — deterministic)
//   2. Reset focus to address bar (Ctrl+L / Cmd+L)
//   3. For each step: Tab/Arrow/Enter/Escape/Type to navigate to the target
//      - First run: discover the path (LLM verifies focus after each key)
//      - Subsequent runs: use cached key counts (fast, one LLM verify per step)
//   4. Backtracking with proportional windows + full re-discovery on failure
//
// No ref resolver. No overlay detection. No OCR. No clickByText.
// Just keyboard navigation — the same way screen readers navigate the web.
// ---------------------------------------------------------------------------

const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const logger = require('../logger.cjs');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Session-level LLM analysis cache
// Avoids re-calling the LLM for the same (element, target) pair across steps.
// Key: sessionId → focusKey → targetText → boolean (match result)
// ---------------------------------------------------------------------------
const _llmAnalysisCache = new Map();

function _clearLlmCache(sessionId) {
  _llmAnalysisCache.delete(sessionId);
}

function _getCachedLlmResult(sessionId, focusKey, targetText) {
  return _llmAnalysisCache.get(sessionId)?.get(focusKey)?.get(targetText);
}

function _setCachedLlmResult(sessionId, focusKey, targetText, result) {
  if (!_llmAnalysisCache.has(sessionId)) _llmAnalysisCache.set(sessionId, new Map());
  const sessionCache = _llmAnalysisCache.get(sessionId);
  if (!sessionCache.has(focusKey)) sessionCache.set(focusKey, new Map());
  sessionCache.get(focusKey).set(targetText, result);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Read document.activeElement info (tag, text, role, ref, rect, icon signals)
async function _readActiveElement(sessionId) {
  const res = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
    text: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      // Inject data-td-ref if missing (for real Playwright selector clicks)
      // Uses tm- prefix to distinguish from DOM scanner's tdN refs
      let ref = el.getAttribute('data-td-ref');
      if (!ref || !ref.startsWith('tm-')) {
        ref = 'tm-' + Math.random().toString(36).slice(2, 10);
        el.setAttribute('data-td-ref', ref);
      }
      const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      const r = el.getBoundingClientRect();
      const hasSvg = !!el.querySelector('svg');
      const ariaLabel = el.getAttribute('aria-label') || '';
      const isIconLike = text.length < 3 && (hasSvg || (r.width < 50 && r.height < 50) || el.getAttribute('role') === 'button' || el.tagName === 'BUTTON');
      return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text,
               ref,
               type: el.tagName === 'INPUT' ? (el.type || 'text') : '',
               ariaLabel,
               isIconLike,
               hasSvg,
               x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    })()`,
  });
  try {
    const raw = res?.result;
    return typeof raw === 'string' ? JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"')) : raw;
  } catch { return null; }
}

// Check if a point is inside a rect
function _pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

// Behavior-based editable check: type "x", check if it appears in the field, then backspace.
// Works for input, textarea, contenteditable — no tag/role inspection needed.
// Returns true if the element accepted the typed character (is editable).
async function _isEditableByProbe(sessionId) {
  // Type a test character
  await browserAct({ action: 'press', sessionId, key: 'x', headed: true, timeoutMs: 2000 });
  await _sleep(50);

  // Read the active element's value/textContent to see if "x" appeared
  let isEditable = false;
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const val = el.value !== undefined ? String(el.value) : (el.textContent || el.innerHTML || '');
        return val.includes('x');
      })()`,
    });
    const raw = res?.result;
    isEditable = raw === true || raw === 'true';
  } catch { /* if we can't read, assume not editable */ }

  // Backspace to clear the test character (whether it appeared or not)
  await browserAct({ action: 'press', sessionId, key: 'Backspace', headed: true, timeoutMs: 2000 });
  await _sleep(30);

  return isEditable;
}

// Press Escape to close any open overlay (menu/dropdown/modal/popover).
async function _pressEscape(sessionId) {
  await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
  await _sleep(100);
}

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
async function _llmMatchFocusedItem(targetText, focusedText, focusedTag = '', focusedType = '') {
  if (!focusedText) return false;
  const t = (targetText || '').toLowerCase().trim();
  const f = (focusedText || '').toLowerCase().trim();
  if (t === f) return true; // quick exact match, no LLM needed

  try {
    const response = await askWithMessages([
      { role: 'system', content: 'You determine if a focused element matches a target label. Output ONLY "YES" or "NO". Be STRICT — match the text, not the element type.' },
      { role: 'user', content: `Target: "${targetText}"
Focused element: <${focusedTag}${focusedType ? ' type="' + focusedType + '"' : ''}> "${focusedText}"

Does the focused element text match the target? Be STRICT on text matching.
- The focused element MUST contain at least one meaningful word from the target (or be a close synonym). A logo or unrelated label is NEVER a match.
- "Save" matches "Save" → YES
- "Save" matches "Save changes" → YES
- "Save" matches "Save playlist" → YES
- "Create" matches "Create" → YES
- "Create" matches "Create a playlist" → YES (target is a label for the focused item)
- "Create a playlist" matches "Create" → NO (focused is too vague)
- "Save" matches "Deborah De Luca's track IDs..." → NO
- "Save" matches "Show all" → NO
- "Create" matches "Expand Your Library" → NO
- "Create" matches "Spotify" → NO (logo text, no shared meaning or keyword)
- "Add a name" matches "Add a name" → YES
- "Edit detail" matches "Edit details" → YES
- "Edit detail" matches "Add an optional description" → NO (different text)
- "Name & details" matches "My Playlist #5 – Edit details" → NO (focused is the page title, not the target)

Output ONLY "YES" or "NO".` },
    ], { maxTokens: 5, temperature: 0.1, responseTimeoutMs: 5000 });
    const answer = (response || '').trim().toUpperCase();
    let match = answer.startsWith('YES');

    // Safety net: reject matches that share no meaningful text with the target.
    // The LLM can be over-eager for custom elements; this catches obvious false positives.
    if (match && !_hasTextualOverlap(targetText, focusedText)) {
      logger.info(`[instruction.runner] LLM said YES but textual overlap guard rejected: target="${targetText}" focused="${focusedText.substring(0, 60)}"`);
      match = false;
    }

    logger.info(`[instruction.runner] LLM match: target="${targetText}" focused="<${focusedTag}> ${focusedText.substring(0, 60)}" → ${match ? 'YES' : 'NO'}`);
    return match;
  } catch (e) {
    logger.info(`[instruction.runner] LLM match failed: ${e.message} — falling back to string match`);
    return _stringMatch(targetText, focusedText);
  }
}

// Two-tier generic field label detection.
// Returns true if the label is too generic to help locate the field.
// Tier 1: unambiguously generic words (articles, fillers, generic nouns)
// Tier 2a: borderline verbs (always generic — they don't name a field)
// Tier 2b: borderline nouns (preserved if ≥5 chars — they might name a field)
// Rule: null only if ALL words are Tier 1, OR ALL words are Tier 1+2 AND no Tier 2b noun is ≥5 chars.
// This preserves "Add a name" (name not generic), "Edit content" (content ≥5 chars),
// "Enter value" (value ≥5 chars), while nulling "text field", "enter text here", "type something".
const _GENERIC_TIER1 = new Set([
  'the', 'a', 'an', 'your', 'our', 'my', 'here', 'there', 'please',
  'something', 'anything', 'text', 'field', 'input', 'box', 'area', 'placeholder',
]);
const _GENERIC_TIER2_VERBS = new Set([
  'enter', 'type', 'add', 'put', 'write', 'edit',
]);
const _GENERIC_TIER2_NOUNS = new Set([
  'new', 'default', 'empty', 'blank', 'value', 'content', 'data', 'form', 'string',
]);
function _isGenericFieldLabel(label) {
  if (!label) return true;
  const words = label.toLowerCase().trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;
  const allTier1 = words.every(w => _GENERIC_TIER1.has(w));
  if (allTier1) return true;
  const allGeneric = words.every(w =>
    _GENERIC_TIER1.has(w) || _GENERIC_TIER2_VERBS.has(w) || _GENERIC_TIER2_NOUNS.has(w)
  );
  if (allGeneric) {
    // Only preserve if a Tier 2 noun ≥5 chars is present (content, default, string, value)
    const hasLongNoun = words.some(w => _GENERIC_TIER2_NOUNS.has(w) && w.length >= 5);
    return !hasLongNoun;
  }
  return false;
}

// Hard guard: the focused text must contain the target's meaningful keywords.
// This is DIRECTIONAL — the focused must cover the target, not the other way around.
// Prevents "Create" from matching the long garbled target "Create a playli t with ong or epi ode".
// Tolerates minor text noise (truncation, garbling) via prefix/substring matching:
// e.g. "playli" matches "playlist" (prefix), "ong" matches "songs" (substring).
function _hasTextualOverlap(targetText, focusedText) {
  const t = (targetText || '').toLowerCase().trim();
  const f = (focusedText || '').toLowerCase().trim();
  if (!t || !f) return false;

  // Exact match / focused contains full target already covers most cases
  if (t === f || f.includes(t)) return true;

  // Extract significant words (>= 3 chars) and ignore common stop words
  const stop = new Set(['the', 'and', 'for', 'you', 'are', 'with', 'can', 'all', 'any', 'not', 'but', 'use', 'has', 'had', 'was', 'will', 'from', 'into', 'this', 'that']);
  const words = (s) => s.match(/[a-z0-9]+/g)?.filter(w => w.length >= 3 && !stop.has(w)) || [];
  const tWords = words(t);
  const fWords = words(f);
  if (tWords.length === 0 || fWords.length === 0) return false;

  // Word match with fuzzy tolerance: exact, prefix (playli→playlist), or substring (ong→songs)
  // Only applies to words >= 3 chars to avoid false positives on short fragments.
  const wordMatches = (tw) => fWords.some(fw => fw === tw || fw.startsWith(tw) || tw.startsWith(fw) || fw.includes(tw) || tw.includes(fw));

  // Focused must contain every significant target word (e.g. "Create a playlist" in "Playlist Create a playlist with songs or episodes")
  const allMatch = tWords.every(wordMatches);
  if (allMatch) return true;

  // For longer targets (3+ words), allow ≥60% fuzzy match to tolerate 1-2 garbled words
  if (tWords.length >= 3) {
    const matchCount = tWords.filter(wordMatches).length;
    if (matchCount / tWords.length >= 0.6) return true;
  }

  // For very short targets (1-2 words), allow an overlap ONLY if the focused text
  // is not much longer with unrelated words (prevents "Create" matching page titles)
  if (tWords.length <= 2) {
    const overlapCount = tWords.filter(wordMatches).length;
    if (overlapCount === 0) return false;
    // If focused has more than 1 extra unrelated word, reject
    const extraCount = fWords.length - overlapCount;
    return extraCount <= 1;
  }

  // For longer targets, require all target words to be in focused (already checked above)
  return false;
}

// Fallback string match (used when LLM is unavailable)
function _stringMatch(targetText, focusedText) {
  const t = (targetText || '').toLowerCase().trim();
  const f = (focusedText || '').toLowerCase().trim();
  if (!t || !f) return false;
  if (t === f) return true;
  if (f.includes(t)) return true;
  if (t.includes(f) && (f.length / t.length) >= 0.7) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Overlay navigation mode detection — REMOVED
// ---------------------------------------------------------------------------
// The overlay probe was removed because it interfered with the dropdown scan.
// After a Playwright click opens a dropdown, the probe pressed Tab/Shift+Tab
// which moved focus away from the dropdown. buildTabMap's ArrowRight→ArrowDown
// →Tab scan handles dropdown entry naturally without a separate probe.

// ---------------------------------------------------------------------------
// Tab-map: arrow-key-first scan with loop detection
// ---------------------------------------------------------------------------
// Builds a complete map of focusable elements on the current page state.
// Tries Arrow Right first (horizontal regions), then Arrow Down (vertical
// lists like dropdowns/menus), then Tab (general navigation).
// Stops on loop detection (seen same element signature twice) or safety cap.
// Returns array of { id, tag, text, ariaLabel, placeholder, role, type,
//   x, y, w, h, isIconLike, hasSvg, ref } with real coordinates.

// Generate a signature for an element to detect loops
function _elementSignature(el) {
  if (!el) return 'null';
  return `${el.tag}|${el.text || ''}|${el.x || 0},${el.y || 0}`;
}

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
function _normalizeText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Check if a is a subsequence of b (all chars of a appear in b in order)
function _isSubsequence(a, b) {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (a[i] === b[j]) i++;
  }
  return i === a.length;
}

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
function _fuzzyTextMatch(target, candidate) {
  if (!target || !candidate) return false;
  const t = _normalizeText(target);
  const c = _normalizeText(candidate);
  if (t === c) return true;
  if (t.length === 0 || c.length === 0) return false;

  const longer = t.length >= c.length ? t : c;
  const shorter = t.length >= c.length ? c : t;

  // Length guard — too different in length = not a match
  if (shorter.length < longer.length * 0.7) return false;

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
function _tabMapFilePath(domain) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'domain-maps');
  return path.join(dir, `${domain}.tab-map.json`);
}

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
async function buildTabMap(sessionId, maxElements = 150, options = {}) {
  const { skipReset = false } = options;
  const map = [];
  const seenSet = new Set(); // O(1) deduplication
  let idCounter = 0;
  let starterSig = null; // first element — when we loop back, scan is done

  if (!skipReset) {
    await _resetFocusToPageTop(sessionId);
  }

  for (let i = 0; i < maxElements; i++) {
    const before = await _readActiveElement(sessionId);
    let current = before; // tracks current focus position (may shift via arrows)
    let advanced = false;

    // 1. Try ArrowRight (enters dropdowns from trigger, horizontal menus)
    await browserAct({ action: 'press', sessionId, key: 'ArrowRight', headed: true, timeoutMs: 2000 });
    await _sleep(60);
    let after = await _readActiveElement(sessionId);

    if (_isRealFocusChange(current, after)) {
      const sig = _elementSignature(after);
      if (!seenSet.has(sig)) {
        // New element — add to set + map
        seenSet.add(sig);
        if (!starterSig) starterSig = sig;
        map.push({ id: ++idCounter, ...after, key: 'ArrowRight' });
        advanced = true;
      } else {
        // Seen element — update current position, fall through to ArrowDown
        current = after;
      }
    }
    // else: no focus change — current stays the same, fall through to ArrowDown

    // 2. Try ArrowDown (vertical lists: dropdowns, menus — may scroll page)
    if (!advanced) {
      await browserAct({ action: 'press', sessionId, key: 'ArrowDown', headed: true, timeoutMs: 2000 });
      await _sleep(60);
      after = await _readActiveElement(sessionId);

      if (_isRealFocusChange(current, after)) {
        const sig = _elementSignature(after);
        if (!seenSet.has(sig)) {
          seenSet.add(sig);
          if (!starterSig) starterSig = sig;
          map.push({ id: ++idCounter, ...after, key: 'ArrowDown' });
          advanced = true;
        } else {
          // Seen element — update current, fall through to Tab
          current = after;
        }
      }
    }

    // 3. Try Tab (general navigation — modals, page elements)
    if (!advanced) {
      await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
      await _sleep(60);
      after = await _readActiveElement(sessionId);

      if (!after) break; // nothing focusable

      if (_isRealFocusChange(current, after)) {
        const sig = _elementSignature(after);
        if (!seenSet.has(sig)) {
          seenSet.add(sig);
          if (!starterSig) starterSig = sig;
          map.push({ id: ++idCounter, ...after, key: 'Tab' });
          advanced = true;
        } else {
          // Tab led to a seen element — check if it's the starter (looped back)
          if (sig === starterSig) {
            logger.info(`[instruction.runner] buildTabMap: looped back to starter — scan done`);
            break;
          }
          // Seen but not starter — all keys exhausted
          break;
        }
      } else {
        // Tab didn't change focus — end of focusable elements
        break;
      }
    }

    // If nothing advanced, all keys led to seen elements or no change
    if (!advanced) break;
  }

  logger.info(`[instruction.runner] buildTabMap: scanned ${map.length} elements (cap=${maxElements}, skipReset=${skipReset})`);

  // Persist the tab-map for this domain (merges with existing elements)
  const domain = await _getDomainFromSession(sessionId);
  if (domain) {
    _saveTabMap(domain, map);
  }

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
  return parts.join(' ');
}

// Ask the LLM to pick the best element from a tab-map for a given step.
// Returns the full tab-map entry (with coordinates) or null.
async function _llmPickFromTabMap(tabMap, stepAction, verifyText, value) {
  if (!tabMap || tabMap.length === 0) return null;

  // Build simplified list
  const listStr = tabMap.map(e => `${e.id} - ${_formatTabMapEntryForLLM(e)}`).join('\n');

  const actionDesc = stepAction === 'fill'
    ? `Type "${value || ''}" into the matching field`
    : stepAction === 'click'
    ? `Click the matching element`
    : `${stepAction} the matching element`;

  const prompt = `Step: ${actionDesc} — target: "${verifyText}"

Available elements:
${listStr}

Which element number EXACTLY matches the step target?
- The element's text, ariaLabel, or placeholder must closely match the target text
- "Create" does NOT match "Create a playlist with a song or episode" (different text)
- "Create" only matches if the target is exactly "Create" or "Create button"
- If NO element closely matches, output 0
Output ONLY the number, or 0 if no match.`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: 'You pick the exactly matching element from a list. Output ONLY the number, or 0 if no exact match. Nothing else.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 10, temperature: 0, responseTimeoutMs: 8000 });

    const id = parseInt((response || '').trim().replace(/\D/g, ''), 10);
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
      const candidateText = entry.text || entry.ariaLabel || entry.placeholder || '';
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
function _isOcrRowIconLike(row) {
  if (!row) return false;
  if (row.type === 'icon') return true;
  const text = (row.text || '').trim();
  if (text.length === 0) return false;
  if (text.length <= 2 && !/[a-z0-9]/i.test(text)) return true;
  if ((row.width || 0) < 50 && (row.height || 0) < 50 && text.length < 3) return true;
  return false;
}

// OCR fast path step: capture → structure → tab, checking 2-of-3 per tab stop.
// Returns { ok, count, navMode, focusedText, ref, mouse, matchedBy, scores }
// or { ok: false, error, fallback: true } (caller should fall back to slow path).
async function _ocrFastPathStep(sessionId, verifyText, navMode = 'tab', maxTabs = 60, stepAction = '') {
  const target = (verifyText || '').toLowerCase().trim();
  if (!target) return { ok: false, error: 'no verify text', fallback: true };

  // 1. Get the Playwright page from the engine
  let engine, page;
  try {
    engine = require('./browser-engine.cjs');
    page = engine.getPage(sessionId);
  } catch (e) {
    return { ok: false, error: `engine access failed: ${e.message}`, fallback: true };
  }
  if (!page) return { ok: false, error: 'no page available for OCR', fallback: true };

  // 2. Initial OCR capture
  let _liteparseCapture;
  try {
    ({ _liteparseCapture } = require('./browser.agent.cjs'));
  } catch (e) {
    return { ok: false, error: `could not load _liteparseCapture: ${e.message}`, fallback: true };
  }
  const { structureOcrOverlayItems } = require('./ocrOverlayStructure.cjs');

  let cap = await _liteparseCapture(page);
  if (!cap?.ok || !cap.textItems || cap.textItems.length === 0) {
    return { ok: false, error: `OCR capture failed: ${cap?.error || 'no text items'}`, fallback: true };
  }

  let ocrRows = structureOcrOverlayItems(cap.textItems);
  if (ocrRows.length === 0) {
    return { ok: false, error: 'no OCR rows after structuring', fallback: true };
  }
  let screenshotHeight = cap.imageHeight || 800;
  logger.info(`[instruction.runner] OCR fast path: captured ${ocrRows.length} rows, screenshot ${cap.imageWidth}x${screenshotHeight}`);

  // 3. Tab through, checking 2-of-3 data points against ALL OCR rows per stop
  const key = navMode === 'arrow' ? 'ArrowDown' : 'Tab';
  const isFillStep = stepAction === 'fill';
  const isClickStep = stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select';

  for (let i = 0; i < maxTabs; i++) {
    await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
    await _sleep(80);
    await _scrollActiveIntoView(sessionId);

    const focused = await _readActiveElement(sessionId);
    if (!focused) continue;

    // ── Re-OCR if active element is outside current screenshot bounds ──
    if (focused.y + focused.h < 0 || focused.y > screenshotHeight) {
      logger.info(`[instruction.runner] OCR fast path: element at y=${focused.y} outside OCR bounds (0..${screenshotHeight}) — re-capturing (tab ${i + 1})`);
      cap = await _liteparseCapture(page);
      if (cap?.ok && cap.textItems && cap.textItems.length > 0) {
        ocrRows = structureOcrOverlayItems(cap.textItems);
        screenshotHeight = cap.imageHeight || 800;
        logger.info(`[instruction.runner] OCR fast path: re-captured ${ocrRows.length} rows`);
      }
    }

    const focusedRect = { x: focused.x, y: focused.y, width: focused.w, height: focused.h };
    const focusedText = focused.text || '';
    const focusedIsIcon = !!(focused.isIconLike || focusedText.length < 3);

    // Check against ALL OCR rows — 2 of 3 data points
    for (const row of ocrRows) {
      const rowRect = { x: row.x, y: row.y, width: row.width, height: row.height };
      const rowText = row.text || '';
      const rowIsIcon = _isOcrRowIconLike(row);

      // Data point 1: bounds overlap (always required)
      const overlapPct = _rectOverlapPercent(focusedRect, rowRect);
      const boundsMatch = overlapPct >= 30;
      if (!boundsMatch) continue; // no coordinate agreement → skip this row

      // Data point 2: fuzzy text match — OCR row text vs step's verifyText
      // (is this the element we're looking for? not just a consistency check)
      let textMatch = false;
      let textApplicable = true;
      if (focusedIsIcon && rowIsIcon) {
        textApplicable = false; // both icons — text is N/A
      } else if (rowText.length > 0) {
        // Match OCR row text against the step target
        textMatch = _fuzzyTextScore(rowText, verifyText) >= 0.5;
        // Also try active element's ariaLabel (e.g. icon button with label "Create")
        if (!textMatch && focused.ariaLabel && focused.ariaLabel.length > 0) {
          textMatch = _fuzzyTextScore(focused.ariaLabel, verifyText) >= 0.5;
        }
      } else {
        textApplicable = false; // OCR row has no text
      }

      // Data point 3: icon inference
      let iconMatch = false;
      let iconApplicable = focusedIsIcon || rowIsIcon;
      if (iconApplicable && focusedIsIcon && rowIsIcon) {
        iconMatch = true; // both icon-like + bounds overlap → icon inference passes
      } else if (iconApplicable && (focusedIsIcon || rowIsIcon) && overlapPct >= 50) {
        // One is icon, one is text — if bounds strongly overlap, count it
        iconMatch = true;
      }

      // Count matches (only applicable data points count)
      const applicableCount = 1 + (textApplicable ? 1 : 0) + (iconApplicable ? 1 : 0);
      const matchCount = 1 + (textMatch ? 1 : 0) + (iconMatch ? 1 : 0); // bounds always counts (we already continued if no bounds)
      const threshold = Math.ceil(applicableCount * 0.67); // 2 of 3, or 2 of 2

      if (matchCount >= threshold) {
        // Verify element type via probe (same as slow path)
        const editable = await _isEditableByProbe(sessionId);
        if (isFillStep && !editable) {
          logger.info(`[instruction.runner] OCR fast path: 2-of-3 match on row "${rowText}" but not editable — keep tabbing`);
          continue;
        }
        if (isClickStep && editable) {
          logger.info(`[instruction.runner] OCR fast path: 2-of-3 match on row "${rowText}" but editable (not a button) — keep tabbing`);
          continue;
        }
        logger.info(`[instruction.runner] OCR fast path: found "${verifyText}" after ${i + 1} ${key}s — 2-of-3 match (bounds=${overlapPct.toFixed(0)}% text=${textMatch} icon=${iconMatch} row="${rowText}" focused="${focusedText.substring(0, 40)}" editable=${editable})`);
        return { ok: true, count: i + 1, navMode, focusedText, ref: focused.ref || null,
                 mouse: false, matchedBy: 'ocr_2of3',
                 scores: { bounds: overlapPct, text: textMatch, icon: iconMatch, ocrRowText: rowText } };
      }
    }
  }

  return { ok: false, error: `OCR fast path: could not find "${verifyText}" after ${maxTabs} ${key}s`, fallback: true };
}

// ---------------------------------------------------------------------------
// Key path discovery (first run — slow, LLM on each key press)
// ---------------------------------------------------------------------------

// Discover the key path to reach a target element from the current focus position.
// Uses Tab (or ArrowDown for arrow mode) to cycle through elements, LLM-checking each.
// Uses session-level cache to skip re-analyzing elements already checked for the same target.
// After LLM says YES, uses behavior-based type-probe (_isEditableByProbe) to verify:
//   - For fill steps: element must be editable (probe returns true)
//   - For click steps: element must NOT be editable (probe returns false)
// If the target is not keyboard-reachable and `allowMouse` is true, falls back to
// `clickByText` so mouse-only buttons (e.g. Spotify's + "Create") can still work.
// Returns { ok, count, navMode, focusedText, ref, mouse } or { ok: false, error }.
async function _discoverKeyPathStep(sessionId, verifyText, navMode = 'tab', maxAttempts = 50, allowMouse = false, stepAction = '') {
  const target = (verifyText || '').toLowerCase().trim();
  if (!target) return { ok: false, error: 'no verify text' };

  const key = navMode === 'arrow' ? 'ArrowDown' : 'Tab';
  const seenKeys = new Set();
  const isFillStep = stepAction === 'fill';
  const isClickStep = stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select';

  logger.info(`[instruction.runner] Discover: searching for "${verifyText}" using ${key} (mode=${navMode}, action=${stepAction})`);

  for (let i = 0; i < maxAttempts; i++) {
    await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
    await _sleep(80);
    await _scrollActiveIntoView(sessionId);

    const focused = await _readActiveElement(sessionId);
    if (focused && focused.text) {
      const focusKey = `${focused.tag}|${focused.text}|${focused.ref}`;
      if (seenKeys.has(focusKey)) {
        logger.info(`[instruction.runner] Discover: wrapped around after ${i + 1} ${key}s — target not found`);
        break;
      }
      seenKeys.add(focusKey);

      // Check session-level cache first
      const cached = _getCachedLlmResult(sessionId, focusKey, target);
      if (cached !== undefined) {
        logger.info(`[instruction.runner] Discover: ${key} ${i + 1}, focused "${focused.text.substring(0, 40)}" — cache ${cached ? 'HIT (match!)' : 'hit (no match)'}`);
        if (cached) {
          // Cache says match — but still need to verify element type via probe
          const editable = await _isEditableByProbe(sessionId);
          if (isFillStep && !editable) {
            logger.info(`[instruction.runner] Discover: cache hit but probe says not editable — skipping`);
            continue;
          }
          if (isClickStep && editable) {
            logger.info(`[instruction.runner] Discover: cache hit but probe says editable (not a button) — skipping`);
            continue;
          }
          return { ok: true, count: i + 1, navMode, focusedText: focused.text, ref: focused.ref || null, mouse: false };
        }
        continue; // cached NO — skip
      }

      // Call LLM with tag/type context
      if (await _llmMatchFocusedItem(verifyText, focused.text, focused.tag, focused.type)) {
        // LLM says match — verify element type via behavior probe
        const editable = await _isEditableByProbe(sessionId);
        if (isFillStep && !editable) {
          logger.info(`[instruction.runner] Discover: LLM matched "${focused.text}" but probe says not editable — skipping (not an input)`);
          _setCachedLlmResult(sessionId, focusKey, target, false);
          continue;
        }
        if (isClickStep && editable) {
          logger.info(`[instruction.runner] Discover: LLM matched "${focused.text}" but probe says editable (not a button) — skipping`);
          _setCachedLlmResult(sessionId, focusKey, target, false);
          continue;
        }
        logger.info(`[instruction.runner] Discover: found "${focused.text}" after ${i + 1} ${key}s — match! (editable=${editable})`);
        _setCachedLlmResult(sessionId, focusKey, target, true);
        return { ok: true, count: i + 1, navMode, focusedText: focused.text, ref: focused.ref || null, mouse: false };
      }
      _setCachedLlmResult(sessionId, focusKey, target, false);
      logger.info(`[instruction.runner] Discover: ${key} ${i + 1}, focused "<${focused.tag}> ${focused.text.substring(0, 60)}" (no match)`);
    }
  }

  // If Tab mode failed, try ArrowDown mode
  if (navMode === 'tab') {
    logger.info(`[instruction.runner] Discover: Tab mode exhausted — trying ArrowDown mode`);
    const arrowResult = await _discoverKeyPathStep(sessionId, verifyText, 'arrow', maxAttempts, allowMouse, stepAction);
    if (arrowResult?.ok) return arrowResult;
  }

  // ── Mouse fallback for mouse-only targets ─────────────────────────────────
  // Some buttons (e.g. Spotify's + "Create" in the sidebar) are not in the
  // natural tab order. If allowed, use clickByText as a last resort.
  if (allowMouse) {
    logger.info(`[instruction.runner] Discover: keyboard navigation exhausted — trying clickByText for "${verifyText}"`);
    const clickResult = await browserAct({ action: 'clickByText', sessionId, text: verifyText, headed: true, timeoutMs: 10000 });
    if (clickResult?.ok) {
      logger.info(`[instruction.runner] Discover: clickByText succeeded for "${verifyText}"`);

      // For fill steps: verify the click focused an editable element via probe
      if (isFillStep) {
        await _sleep(200);
        const editable = await _isEditableByProbe(sessionId);
        if (!editable) {
          logger.info(`[instruction.runner] Discover: clickByText clicked but probe says not editable — failing`);
          return { ok: false, error: `clickByText found "${verifyText}" but it's not an editable field` };
        }
        logger.info(`[instruction.runner] Discover: clickByText focused editable element — ready to type`);
      }

      return { ok: true, count: 0, navMode: 'tab', focusedText: verifyText, ref: null, mouse: true };
    }
    logger.info(`[instruction.runner] Discover: clickByText also failed: ${clickResult?.error}`);
  }

  return { ok: false, error: `Could not find "${verifyText}" after ${maxAttempts} key presses` };
}

// ---------------------------------------------------------------------------
// Cached key path execution (subsequent runs — fast, one LLM verify per step)
// ---------------------------------------------------------------------------

// Execute a cached key path step: press cached keys, verify with LLM,
// backtrack if needed. Returns { ok, focusedText, ref, newCount } or { ok: false, error }.
async function _executeCachedKeyPathStep(sessionId, step) {
  // Mouse-only step — use clickByText directly
  if (step.mouse) {
    logger.info(`[instruction.runner] Cached path: mouse click for "${step.verifyText}"`);
    const clickResult = await browserAct({ action: 'clickByText', sessionId, text: step.verifyText, headed: true, timeoutMs: 10000 });
    if (clickResult?.ok) {
      // For fill/type steps: verify the click focused an editable element via probe
      if (step.stepAction === 'fill') {
        await _sleep(200);
        const editable = await _isEditableByProbe(sessionId);
        if (!editable) {
          return { ok: false, error: `Mouse clickByText found "${step.verifyText}" but it's not editable` };
        }
      }
      return { ok: true, focusedText: step.verifyText, ref: null, newCount: 0 };
    }
    return { ok: false, error: `Mouse clickByText failed for "${step.verifyText}": ${clickResult?.error}` };
  }

  const cachedCount = step.cachedCount || 0;
  const navMode = step.navMode || 'tab';
  const key = navMode === 'arrow' ? 'ArrowDown' : 'Tab';
  const WINDOW = 3;

  // Focus is at the expected starting point for this step (the previous action left it there).
  // Search a ±3 window around the cached count. This gives flexibility for minor page state
  // changes without calling the LLM for every single tabbed element.
  logger.info(`[instruction.runner] Cached keyPath: searching ±${WINDOW} around count=${cachedCount} (mode=${navMode}) for "${step.verifyText}"`);

  let startCount;
  if (cachedCount === 0) {
    // Target should be at the current focus; also allow up to WINDOW steps forward.
    startCount = 0;
  } else {
    startCount = Math.max(0, cachedCount - WINDOW);
    // Move to the start of the window quickly without LLM checks
    for (let i = 0; i < startCount; i++) {
      await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
      await _sleep(40);
    }
    await _scrollActiveIntoView(sessionId);
  }

  const endCount = cachedCount + WINDOW;
  for (let pos = startCount; pos <= endCount; pos++) {
    const focused = await _readActiveElement(sessionId);
    if (focused?.text && await _llmMatchFocusedItem(step.verifyText, focused.text)) {
      logger.info(`[instruction.runner] Cached keyPath: found "${focused.text}" at count=${pos} (cached ${cachedCount})`);
      return { ok: true, focusedText: focused.text, ref: focused.ref, newCount: pos };
    }
    // Advance one key, unless this is the last position in the window
    if (pos < endCount) {
      await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
      await _sleep(40);
      await _scrollActiveIntoView(sessionId);
    }
  }

  logger.info(`[instruction.runner] Cached keyPath: ±${WINDOW} window around ${cachedCount} missed — falling back to re-discovery`);

  // Full re-discovery: reset to address bar and search from 0
  await _pressEscape(sessionId); // close any stray overlay
  await _resetFocusToPageTop(sessionId);
  const discoverResult = await _discoverKeyPathStep(sessionId, step.verifyText, navMode, 50, true, step.stepAction || '');
  if (discoverResult?.ok) {
    return { ok: true, focusedText: discoverResult.focusedText, ref: discoverResult.ref, newCount: discoverResult.count };
  }

  return { ok: false, error: `Could not find "${step.verifyText}" near cached position ${cachedCount} (±${WINDOW}) or after re-discovery` };
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

// Execute the action for a step (Enter, Space, Type, Escape, etc.)
// after the target element has been focused.
async function _executeAction(sessionId, step) {
  const action = step.action || 'Enter';

  switch (action.toLowerCase()) {
    case 'enter': {
      const result = await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
      await _sleep(500); // wait for page/overlay to react
      return { ok: !!result?.ok, error: result?.error };
    }
    case 'space': {
      const result = await browserAct({ action: 'press', sessionId, key: 'Space', headed: true, timeoutMs: 5000 });
      await _sleep(500);
      return { ok: !!result?.ok, error: result?.error };
    }
    case 'type': {
      if (!step.value && step.value !== 0) return { ok: false, error: 'No value to type' };
      // Select all existing text first (Ctrl+A / Cmd+A) so the new value replaces it
      await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
      await _sleep(50);
      // Use `type` (not `fill`) because keyboard navigation already focused the field
      const result = await browserAct({ action: 'type', sessionId, text: String(step.value), headed: true, timeoutMs: 10000 });
      await _sleep(300);
      return { ok: !!result?.ok, error: result?.error };
    }
    case 'escape': {
      await _pressEscape(sessionId);
      return { ok: true };
    }
    case 'pagedown': {
      await browserAct({ action: 'press', sessionId, key: 'PageDown', headed: true, timeoutMs: 2000 });
      await _sleep(300);
      return { ok: true };
    }
    case 'pageup': {
      await browserAct({ action: 'press', sessionId, key: 'PageUp', headed: true, timeoutMs: 2000 });
      await _sleep(300);
      return { ok: true };
    }
    case 'scroll': {
      // Scroll using ArrowDown on the body until the target is visible
      // For now, just press PageDown a few times
      const scrollCount = step.scrollCount || 3;
      for (let i = 0; i < scrollCount; i++) {
        await browserAct({ action: 'press', sessionId, key: 'PageDown', headed: true, timeoutMs: 2000 });
        await _sleep(200);
      }
      return { ok: true };
    }
    case 'none':
    case 'verify':
      // No action — just verification (used when we only want to check focus)
      return { ok: true };
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
}

// Try Enter, then Space as fallback for button activation
async function _executeButtonActivation(sessionId) {
  const before = await _readActiveElement(sessionId);

  // Try Enter
  await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
  await _sleep(500);

  // Check if something changed (page navigated, overlay opened, etc.)
  const after = await _readActiveElement(sessionId);
  const changed = `${before?.tag}|${before?.text}|${before?.ref}` !== `${after?.tag}|${after?.text}|${after?.ref}`;

  if (changed) {
    return { ok: true };
  }

  // Enter didn't work — try Space
  logger.info(`[instruction.runner] Enter didn't activate — trying Space`);
  await browserAct({ action: 'press', sessionId, key: 'Space', headed: true, timeoutMs: 5000 });
  await _sleep(500);
  const afterSpace = await _readActiveElement(sessionId);
  const changedSpace = `${before?.tag}|${before?.text}|${before?.ref}` !== `${afterSpace?.tag}|${afterSpace?.text}|${afterSpace?.ref}`;
  if (changedSpace) {
    return { ok: true };
  }

  // Neither Enter nor Space worked. Some interactive elements are `<div>`/`<li>`
  // with click handlers (e.g. Spotify's menu items). Dispatch a real mouse click
  // on the currently focused element via the DOM `click()` method.
  logger.info(`[instruction.runner] Enter/Space didn't activate — dispatching click on focused element`);
  try {
    await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        const el = document.activeElement;
        if (el && el.click) { el.click(); return true; }
        return false;
      })()`,
    });
  } catch (e) {
    logger.info(`[instruction.runner] click() fallback failed: ${e.message}`);
  }
  await _sleep(500);
  const afterClick = await _readActiveElement(sessionId);
  const changedClick = `${before?.tag}|${before?.text}|${before?.ref}` !== `${afterClick?.tag}|${afterClick?.text}|${afterClick?.ref}`;
  if (changedClick) {
    return { ok: true };
  }

  return { ok: false, error: 'Neither Enter nor Space activated the focused element' };
}

// ---------------------------------------------------------------------------
// Instruction parsing (text → steps, for first-run discovery)
// ---------------------------------------------------------------------------

function parseInstructions(instructions) {
  const steps = [];
  const sentences = instructions.split(/\.\s+|\.$/).map(s => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const step = parseStep(sentence);
    if (step) steps.push(step);
  }
  return steps;
}

function parseStep(sentence) {
  const s = sentence.trim();
  if (!s) return null;

  // Navigate to URL
  let m = s.match(/^navigate\s+to\s+(?:https?:\/\/\S+|["']?(https?:\/\/\S+)["']?)$/i);
  if (m) return { action: 'navigate', url: m[1] || s.replace(/^navigate\s+to\s+/i, '').replace(/["']/g, '') };

  // Click the "X" button/link/element
  m = s.match(/^click\s+(?:the\s+)?["']([^"']+)["'](?:\s+(?:button|link|element|tab|menu|item))?$/i);
  if (m) return { action: 'click', verifyText: m[1], target: m[1] };

  // Click X (without quotes)
  m = s.match(/^click\s+(?:the\s+)?(.+?)(?:\s+(?:button|link|element|tab|menu|item))?$/i);
  if (m && !m[1].match(/^(?:type|select|press|navigate|check|uncheck|submit)/i)) {
    return { action: 'click', verifyText: m[1].replace(/^["']|["']$/g, ''), target: m[1].replace(/^["']|["']$/g, '') };
  }

  // Type "value" into the "field" field/input/textarea
  m = s.match(/^type\s+(?:"([^"]*)"|'([^']*)'|\{\{([^}]+)\}\}|(.+?))\s+into\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|([^\s.]+))(?:\s+(?:field|input|textarea|box|area))?\.?$/i);
  if (m) {
    let value;
    if (m[1] !== undefined) value = m[1];
    else if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = `{{${m[3]}}}`;
    else value = (m[4] || '').trim();
    let target;
    if (m[5] !== undefined) target = m[5];
    else if (m[6] !== undefined) target = m[6];
    else target = m[7];
    // Generic targets like "text", "field", "input" don't help locate the element.
    // Set to null so the runner types into the active element instead of searching for "text".
    // Uses two-tier generic detection to minimize false positives.
    if (target && _isGenericFieldLabel(target)) {
      logger.info(`[instruction.runner] parseStep: nulling generic fill target "${target}" — will use active element`);
      target = null;
    }
    return { action: 'fill', verifyText: target, target, value };
  }

  // Type "value" (no target specified — will use active input)
  m = s.match(/^type\s+(?:"([^"]*)"|'([^']*)'|\{\{([^}]+)\}\}|(.+))$/i);
  if (m) {
    let value;
    if (m[1] !== undefined) value = m[1];
    else if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = `{{${m[3]}}}`;
    else value = (m[4] || '').trim();
    return { action: 'fill', verifyText: null, target: null, value };
  }

  // Select "value" from "dropdown"
  m = s.match(/^select\s+["']([^"']+)["']\s+from\s+(?:the\s+)?["']?([^"']+)["']?(?:\s+dropdown)?$/i);
  if (m) return { action: 'select', verifyText: m[1], target: m[2], value: m[1] };

  // Press Enter / Tab / Escape
  m = s.match(/^press\s+(enter|tab|escape|return|space)$/i);
  if (m) {
    const keyName = m[1].toLowerCase();
    const keyMap = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', space: 'Space' };
    return { action: 'key', key: keyMap[keyName] };
  }

  // Check "X"
  m = s.match(/^check\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'check', verifyText: m[1], target: m[1] };

  // Uncheck "X"
  m = s.match(/^uncheck\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'uncheck', verifyText: m[1], target: m[1] };

  // Submit the form
  m = s.match(/^submit\s+(?:the\s+)?form$/i);
  if (m) return { action: 'key', key: 'Enter' };

  // Double-click "X"
  m = s.match(/^double[- ]click\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'dblclick', verifyText: m[1], target: m[1] };

  logger.warn(`[instruction.runner] Could not parse step: "${s}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function runInstructionSkill({ instructions, keyPath, params, skillArgs, startUrl, sessionId, timeoutMs }) {
  if (!sessionId) return { ok: false, error: 'No sessionId provided' };

  // Clear session-level LLM analysis cache for this run
  _clearLlmCache(sessionId);

  const overallTimeout = timeoutMs || 120000;
  const deadline = Date.now() + overallTimeout;

  // Resolve {{param}} placeholders from skillArgs
  let resolvedInstructions = instructions || '';
  const unresolved = [];
  if (resolvedInstructions) {
    resolvedInstructions = resolvedInstructions.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
      const val = skillArgs?.[name];
      if (val !== undefined && val !== null && val !== '') return String(val);
      unresolved.push(name);
      return `{{${name}}}`;
    });
    if (unresolved.length > 0) {
      return { ok: false, error: `Unresolved parameter(s): ${unresolved.join(', ')}` };
    }
  }

  // Determine steps: use cached keyPath if available, otherwise parse text instructions
  let steps = [];
  let hasCachedPath = false;

  if (keyPath && Array.isArray(keyPath) && keyPath.length > 0) {
    steps = keyPath;
    hasCachedPath = true;
    logger.info(`[instruction.runner] Using cached keyPath with ${steps.length} steps`);
  } else if (resolvedInstructions) {
    steps = parseInstructions(resolvedInstructions);
    if (steps.length === 0) {
      return { ok: false, error: 'Could not parse any steps from instructions' };
    }
    logger.info(`[instruction.runner] Parsed ${steps.length} steps from text instructions (first run — will discover path)`);
  } else {
    return { ok: false, error: 'No instructions or keyPath provided' };
  }

  logger.info(`[instruction.runner] Resolved instructions: ${resolvedInstructions.substring(0, 200)}`);

  // Navigate to startUrl if provided
  if (startUrl) {
    try {
      logger.info(`[instruction.runner] Navigating to startUrl: ${startUrl}`);
      const navResult = await browserAct({ action: 'navigate', sessionId, url: startUrl, headed: true, timeoutMs: 30000 });
      if (!navResult?.ok) {
        return { ok: false, error: `Failed to navigate to start URL: ${navResult?.error || 'unknown'}` };
      }
      await _sleep(2000);
    } catch (e) {
      return { ok: false, error: `Navigation failed: ${e.message}` };
    }
  }

  // Reset focus to address bar (known starting point)
  await _resetFocusToPageTop(sessionId);

  // Execute each step
  const stepResults = [];
  const discoveredKeyPath = []; // build this for caching
  // currentOverlayMode removed — buildTabMap handles arrow/tab detection internally

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() > deadline) {
      return { ok: false, error: `Timeout after ${overallTimeout}ms at step ${i + 1}/${steps.length}`, stepResults, discoveredKeyPath };
    }

    const step = steps[i];
    logger.info(`[instruction.runner] Step ${i + 1}/${steps.length}: ${JSON.stringify({ ...step, value: step.value ? String(step.value).substring(0, 40) : undefined })}`);

    try {
      // Handle navigate steps (URL-first)
      if (step.action === 'navigate') {
        const navResult = await browserAct({ action: 'navigate', sessionId, url: step.url, headed: true, timeoutMs: 30000 });
        if (!navResult?.ok) {
          stepResults.push({ step: i + 1, ...step, ok: false, error: `Navigation failed: ${navResult?.error}` });
          return { ok: false, error: `Step ${i + 1} navigation failed: ${navResult?.error}`, stepResults, discoveredKeyPath };
        }
        await _sleep(2000);
        await _resetFocusToPageTop(sessionId);
        // Clear LLM cache on page navigation — elements on the new page may share
        // focusKey (tag|text) with unrelated elements on the old page
        _clearLlmCache(sessionId);
        stepResults.push({ step: i + 1, ...step, ok: true });
        discoveredKeyPath.push({ action: 'navigate', url: step.url });
        continue;
      }

      // Handle raw key press steps
      if (step.action === 'key') {
        await browserAct({ action: 'press', sessionId, key: step.key, headed: true, timeoutMs: 5000 });
        await _sleep(500);
        stepResults.push({ step: i + 1, ...step, ok: true });
        discoveredKeyPath.push({ action: step.key });
        continue;
      }

      // For click/fill/select/check/uncheck/dblclick — navigate to target via keyboard
      const verifyText = step.verifyText || step.target;
      if (!verifyText) {
        // No target — use the active element (e.g. for fill into focused input)
        if (step.action === 'fill') {
          // Select all existing text first so the new value replaces it
          await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
          await _sleep(50);
          const fillResult = await browserAct({ action: 'type', sessionId, text: String(step.value), headed: true, timeoutMs: 10000 });
          stepResults.push({ step: i + 1, ...step, ok: !!fillResult?.ok, error: fillResult?.error });
          if (!fillResult?.ok) {
            return { ok: false, error: `Step ${i + 1} type failed: ${fillResult?.error}`, stepResults, discoveredKeyPath };
          }
          discoveredKeyPath.push({ action: 'Type', value: step.value, cachedCount: 0, navMode: 'tab', verifyText: null });
          continue;
        }
        stepResults.push({ step: i + 1, ...step, ok: false, error: 'No verifyText for step' });
        return { ok: false, error: `Step ${i + 1} requires a target but none was specified`, stepResults, discoveredKeyPath };
      }

      // Determine nav mode for this step
      let navMode = step.navMode || 'tab';

      // Decide if this step can use the mouse fallback.
      // All action types can use mouse fallback — clickByText + probe will verify
      // the element type for fill steps.
      const allowMouse = true;
      // Pass the step action so _discoverKeyPathStep can use behavior-based probe:
      // - fill steps: element must be editable (probe returns true)
      // - click steps: element must NOT be editable (probe returns false)
      const stepAction = step.action || '';

      // Navigate to the target element
      let navResult;

      // ── Tab-map approach (first run only, not cached) ──────────────────
      // Build a fresh tab-map of the current state, feed to LLM to pick the
      // target element, click at its coordinates. Falls back to page search
      // (window.find) for content, then OCR for visual elements, then the
      // old slow path as a last resort.
      //
      // skipReset: if the previous step opened an overlay (dropdown/modal),
      // don't reset focus to page top — that would close the overlay.
      // Instead, scan from the current focus position inside the overlay.
      const skipReset = (i > 0 && stepResults[i - 1]?.opensOverlay);
      if (!hasCachedPath) {
        try {
          // 1. Build tab-map for current state
          const tabMap = await buildTabMap(sessionId, 150, { skipReset });

          // 2. Ask LLM to pick the best element
          let pickedEntry = await _llmPickFromTabMap(tabMap, stepAction, verifyText, step.value);

          if (pickedEntry) {
            // 3. Click/focus the picked element via real Playwright click
            //    using data-td-ref selector (trusted mouse event with real coordinates)
            const cssSelector = pickedEntry.ref ? `[data-td-ref="${pickedEntry.ref}"]` : null;
            logger.info(`[instruction.runner] Tab-map: clicking "${pickedEntry.text || pickedEntry.ariaLabel || verifyText}" via selector ${cssSelector || '(no ref)'}`);

            let clickOk = false;
            let clickedViaPlaywright = false; // tracks if Playwright click activated the element
            if (cssSelector) {
              // Real Playwright click via data-td-ref — trusted mouse event
              try {
                const clickResult = await browserAct({ action: 'click', sessionId, selector: cssSelector, headed: true, timeoutMs: 5000 });
                clickOk = !!clickResult?.ok;
                clickedViaPlaywright = clickOk;
                if (clickOk) {
                  logger.info(`[instruction.runner] Tab-map: Playwright click succeeded for "${verifyText}"`);
                } else {
                  logger.info(`[instruction.runner] Tab-map: Playwright click failed for "${verifyText}" — trying tab-count fallback`);
                }
              } catch (e) {
                logger.warn(`[instruction.runner] Tab-map: Playwright click error: ${e.message} — trying tab-count fallback`);
              }
            }

            // Fallback: tab to element by count (focus only — action phase handles Enter)
            if (!clickOk && pickedEntry.id) {
              try {
                await _resetFocusToPageTop(sessionId);
                const tabCount = Math.min(pickedEntry.id, 50);
                for (let t = 0; t < tabCount; t++) {
                  await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
                  await _sleep(40);
                }
                // Don't press Enter here — the action phase handles activation.
                // Pressing Enter here would cause double-activation (Enter here + Enter in action phase).
                clickOk = true;
                logger.info(`[instruction.runner] Tab-map: tab-count fallback (${tabCount} tabs) for "${verifyText}"`);
              } catch (e) {
                logger.warn(`[instruction.runner] Tab-map: tab-count fallback failed: ${e.message}`);
              }
            }

            // Verify we're on the right element
            if (clickOk) {
              const focused = await _readActiveElement(sessionId);
              if (focused) {
                const editable = await _isEditableByProbe(sessionId);
                // mouse: true when Playwright click activated the element →
                // action phase skips Enter/Space (prevents double-activation)
                const mouseFlag = clickedViaPlaywright;
                if (stepAction === 'fill' && editable) {
                  navResult = { ok: true, count: 0, navMode, focusedText: focused.text, ref: focused.ref || null, mouse: mouseFlag, matchedBy: 'tabmap_llm' };
                } else if ((stepAction === 'click' || stepAction === 'dblclick') && !editable) {
                  navResult = { ok: true, count: 0, navMode, focusedText: focused.text, ref: focused.ref || null, mouse: mouseFlag, matchedBy: 'tabmap_llm' };
                } else {
                  logger.info(`[instruction.runner] Tab-map: picked element but type mismatch (editable=${editable}, action=${stepAction}) — trying page search`);
                }
              }
            }
          }

          // 4. If tab-map didn't work, try page search (window.find)
          if (!navResult) {
            logger.info(`[instruction.runner] Tab-map did not find "${verifyText}" — trying page search`);
            const searchResult = await pageSearch(sessionId, verifyText);
            if (searchResult) {
              const editable = await _isEditableByProbe(sessionId);
              if (stepAction === 'fill' && editable) {
                navResult = { ok: true, count: 0, navMode, focusedText: searchResult.text, ref: searchResult.ref || null, mouse: false, matchedBy: 'page_search' };
              } else if ((stepAction === 'click' || stepAction === 'dblclick') && !editable) {
                navResult = { ok: true, count: 0, navMode, focusedText: searchResult.text, ref: searchResult.ref || null, mouse: false, matchedBy: 'page_search' };
              } else {
                // Page search found the text but wrong element type — try tabbing to nearby
                logger.info(`[instruction.runner] Page search found text but type mismatch — trying tab to nearby`);
              }
            }
          }

          // 5. If page search didn't work, try OCR fast path
          if (!navResult) {
            logger.info(`[instruction.runner] Page search did not find "${verifyText}" — trying OCR fast path`);
            navResult = await _ocrFastPathStep(sessionId, verifyText, navMode, 60, stepAction);
            if (navResult?.fallback || !navResult?.ok) {
              logger.info(`[instruction.runner] OCR fast path did not succeed: ${navResult?.error}`);
              navResult = null;
            }
          }

        } catch (_tabMapErr) {
          logger.warn(`[instruction.runner] Tab-map approach error: ${_tabMapErr.message} — falling back to slow path`);
          navResult = null;
        }
      }

      // ── Direct DOM query fallback for fill steps ──────────────────────
      // Before falling back to the slow 50-tab path, try a direct DOM query
      // for inputs matching the target placeholder/aria-label. This is fast
      // and avoids wasting 5 minutes tabbing when the input doesn't exist.
      if (!navResult && stepAction === 'fill') {
        try {
          const domQuery = await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
            text: `(() => {
              const target = ${JSON.stringify(verifyText)};
              const targetLower = target.toLowerCase();
              const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]');
              for (const input of inputs) {
                const ph = (input.placeholder || '').toLowerCase();
                const al = (input.getAttribute('aria-label') || '').toLowerCase();
                const lbl = (input.getAttribute('aria-labelledby') || '').toLowerCase();
                if (ph.includes(targetLower) || al.includes(targetLower) || lbl.includes(targetLower)) {
                  input.focus();
                  const rect = input.getBoundingClientRect();
                  return { tag: input.tagName.toLowerCase(), text: '', placeholder: input.placeholder || '',
                           ariaLabel: input.getAttribute('aria-label') || '',
                           x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                }
              }
              return null;
            })()`,
          });
          if (domQuery?.result) {
            logger.info(`[instruction.runner] DOM query found input for "${verifyText}": ${domQuery.result.tag} placeholder="${domQuery.result.placeholder}"`);
            navResult = { ok: true, count: 0, navMode: 'tab', focusedText: '', ref: null, mouse: false, matchedBy: 'dom_query' };
          }
        } catch (e) {
          logger.warn(`[instruction.runner] DOM query fallback failed: ${e.message}`);
        }
      }

      // ── Cached path or slow discovery (fallback) ────────────────────────
      if (!navResult) {
        if (hasCachedPath && step.cachedCount !== undefined) {
          // Fast path: use cached count
          navResult = await _executeCachedKeyPathStep(sessionId, { ...step, navMode, stepAction });
        } else {
          // Slow path: reset focus to top first, then discover the path
          await _resetFocusToPageTop(sessionId);
          navResult = await _discoverKeyPathStep(sessionId, verifyText, navMode, 50, allowMouse, stepAction);
        }
      }

      if (!navResult?.ok) {
        stepResults.push({ step: i + 1, ...step, ok: false, error: navResult?.error });
        return { ok: false, error: `Step ${i + 1} failed: ${navResult?.error}`, stepResults, discoveredKeyPath };
      }

      // Update cached count if it changed
      if (hasCachedPath && navResult.newCount !== undefined && navResult.newCount !== step.cachedCount) {
        logger.info(`[instruction.runner] Updating cached count: ${step.cachedCount} → ${navResult.newCount}`);
        step.cachedCount = navResult.newCount;
      }

      // Execute the action
      let actionResult;
      const actionType = step.action === 'fill' ? 'Type' :
                         step.action === 'check' || step.action === 'uncheck' ? 'Space' :
                         step.action === 'click' || step.action === 'dblclick' || step.action === 'select' ? 'Enter' :
                         step.action === 'escape' ? 'Escape' :
                         'Enter';

      if (actionType === 'Type') {
        // Resolve {{param}} in value
        let value = step.value;
        if (typeof value === 'string') {
          value = value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
            const val = skillArgs?.[name];
            return val !== undefined && val !== null ? String(val) : `{{${name}}}`;
          });
        }
        actionResult = await _executeAction(sessionId, { action: 'Type', value });
      } else if (actionType === 'Enter') {
        // Mouse fallback already clicked the element during navigation, so
        // we don't need to press Enter/Space again. The click already happened.
        if (navResult.mouse) {
          actionResult = { ok: true };
        } else {
          // Try Enter, then Space as fallback
          actionResult = await _executeButtonActivation(sessionId);
          // If keyboard activation failed, the focused element may not have been
          // the right one (LLM false positive). Use clickByText as a last-ditch
          // recovery — it searches the DOM for the target text and clicks it.
          if (!actionResult?.ok) {
            logger.info(`[instruction.runner] Activation failed for "${verifyText}" — trying clickByText recovery`);
            const clickRecovery = await browserAct({ action: 'clickByText', sessionId, text: verifyText, headed: true, timeoutMs: 10000 });
            if (clickRecovery?.ok) {
              logger.info(`[instruction.runner] clickByText recovery succeeded for "${verifyText}"`);
              actionResult = { ok: true };
            }
          }
        }

        // After a click step, mark as opensOverlay so the next step's
        // buildTabMap uses skipReset=true (scan from current focus, not page top)
        if (actionResult?.ok) {
          discoveredKeyPath.push({
            description: step.target ? `Click "${step.target}"` : `Step ${i + 1}`,
            verifyText,
            action: 'Enter',
            navMode,
            cachedCount: navResult.count || navResult.newCount || 0,
            mouse: navResult.mouse || false,
            stepAction: stepAction || '',
            opensOverlay: true,
          });
          stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText, opensOverlay: true });
          await _sleep(1000); // wait for overlay/page to settle
          continue;
        }
      } else {
        actionResult = await _executeAction(sessionId, { action: actionType });
      }

      if (!actionResult?.ok) {
        stepResults.push({ step: i + 1, ...step, ok: false, error: actionResult?.error || 'Action failed' });
        return { ok: false, error: `Step ${i + 1} action failed: ${actionResult?.error}`, stepResults, discoveredKeyPath };
      }

      // Record discovered path step
      discoveredKeyPath.push({
        description: step.target ? `${step.action} "${step.target}"` : `Step ${i + 1}`,
        verifyText,
        action: actionType,
        navMode,
        cachedCount: navResult.count || navResult.newCount || 0,
        mouse: navResult.mouse || false,
        stepAction: stepAction || '',
        value: step.value || undefined,
      });

      stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText });

      // Wait between steps for page to settle
      await _sleep(1500);

    } catch (e) {
      logger.error(`[instruction.runner] Step ${i + 1} threw: ${e.message}`);
      stepResults.push({ step: i + 1, ...step, ok: false, error: e.message });
      return { ok: false, error: `Step ${i + 1} threw: ${e.message}`, stepResults, discoveredKeyPath };
    }
  }

  logger.info(`[instruction.runner] All ${steps.length} steps completed successfully`);
  return { ok: true, output: `Completed ${steps.length} steps`, stepResults, discoveredKeyPath };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runInstructionSkill,
  parseInstructions,
  parseStep,
  // Keyboard helpers (exported for playwright.agent.cjs compatibility)
  _readActiveElement,
  _pressEscape,
  _llmMatchFocusedItem,
};
