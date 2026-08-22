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

// Read document.activeElement info (tag, text, role, ref, rect)
async function _readActiveElement(sessionId) {
  const res = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
    text: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      const r = el.getBoundingClientRect();
      return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text,
               ref: el.getAttribute('data-td-ref') || '',
               type: el.tagName === 'INPUT' ? (el.type || 'text') : '',
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
// Overlay navigation mode detection (arrow vs tab)
// ---------------------------------------------------------------------------

// After pressing Enter on a trigger, probe to determine if the overlay that
// opened uses ArrowDown (dropdown) or Tab (modal) for navigation.
// Returns "arrow" or "tab".
async function _detectOverlayNavMode(sessionId) {
  await _sleep(300); // wait for overlay to appear

  const baseline = await _readActiveElement(sessionId);
  const baselineKey = `${baseline?.tag}|${baseline?.text}|${baseline?.ref}`;

  // Try ArrowDown first
  await browserAct({ action: 'press', sessionId, key: 'ArrowDown', headed: true, timeoutMs: 2000 });
  await _sleep(80);
  let focused = await _readActiveElement(sessionId);
  if (focused && `${focused.tag}|${focused.text}|${focused.ref}` !== baselineKey) {
    logger.info(`[instruction.runner] Overlay probe: ArrowDown changed focus → ARROW mode`);
    // Shift+ArrowUp to undo the probe (go back to first item or baseline)
    await browserAct({ action: 'press', sessionId, key: 'ArrowUp', headed: true, timeoutMs: 2000 });
    await _sleep(50);
    return 'arrow';
  }

  // ArrowDown didn't change — try Tab
  await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
  await _sleep(80);
  focused = await _readActiveElement(sessionId);
  if (focused && `${focused.tag}|${focused.text}|${focused.ref}` !== baselineKey) {
    logger.info(`[instruction.runner] Overlay probe: Tab changed focus → TAB mode`);
    // Shift+Tab to undo
    await browserAct({ action: 'press', sessionId, key: 'Shift+Tab', headed: true, timeoutMs: 2000 });
    await _sleep(50);
    return 'tab';
  }

  // Try ArrowDown again (some menus need 2 presses to focus first item)
  await browserAct({ action: 'press', sessionId, key: 'ArrowDown', headed: true, timeoutMs: 2000 });
  await _sleep(80);
  focused = await _readActiveElement(sessionId);
  if (focused && `${focused.tag}|${focused.text}|${focused.ref}` !== baselineKey) {
    logger.info(`[instruction.runner] Overlay probe: 2nd ArrowDown changed focus → ARROW mode`);
    await browserAct({ action: 'press', sessionId, key: 'ArrowUp', headed: true, timeoutMs: 2000 });
    await _sleep(50);
    return 'arrow';
  }

  // Try Tab again
  await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
  await _sleep(80);
  focused = await _readActiveElement(sessionId);
  if (focused && `${focused.tag}|${focused.text}|${focused.ref}` !== baselineKey) {
    logger.info(`[instruction.runner] Overlay probe: 2nd Tab changed focus → TAB mode`);
    await browserAct({ action: 'press', sessionId, key: 'Shift+Tab', headed: true, timeoutMs: 2000 });
    await _sleep(50);
    return 'tab';
  }

  // Nothing changed — default to Tab mode
  logger.info(`[instruction.runner] Overlay probe: no focus change — defaulting to TAB mode`);
  return 'tab';
}

// Check if we're inside an overlay (modal/dropdown) by checking if Escape
// changes the activeElement or closes something
async function _isInsideOverlay(sessionId) {
  const before = await _readActiveElement(sessionId);
  const beforeKey = `${before?.tag}|${before?.text}|${before?.ref}`;
  await browserAct({ action: 'press', sessionId, key: 'Escape', headed: true, timeoutMs: 2000 });
  await _sleep(100);
  const after = await _readActiveElement(sessionId);
  const afterKey = `${after?.tag}|${after?.text}|${after?.ref}`;
  if (beforeKey !== afterKey) {
    // Escape changed focus — we were inside an overlay. But now we closed it.
    // We need to re-open it. This is destructive, so we only use this for
    // the "should we reset to address bar" decision, not for detection.
    // Actually, let's NOT use this — it's destructive. Return false.
    // Re-press the trigger to reopen... but we don't know the trigger.
    // Better: just return false and let the caller decide.
    return false;
  }
  return false;
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
  const reverseKey = navMode === 'arrow' ? 'ArrowUp' : 'Shift+Tab';

  if (cachedCount === 0) {
    // No keys to press — verify current focus
    const focused = await _readActiveElement(sessionId);
    if (focused?.text && await _llmMatchFocusedItem(step.verifyText, focused.text)) {
      return { ok: true, focusedText: focused.text, ref: focused.ref, newCount: 0 };
    }
    // Fall through to backtracking
  } else {
    // Fast: press cached keys without LLM checking
    for (let i = 0; i < cachedCount; i++) {
      await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
      await _sleep(50); // faster on cached path
    }
    await _scrollActiveIntoView(sessionId);

    // Verify
    const focused = await _readActiveElement(sessionId);
    if (focused?.text && await _llmMatchFocusedItem(step.verifyText, focused.text)) {
      logger.info(`[instruction.runner] Cached path: verified "${focused.text}" at count=${cachedCount}`);
      return { ok: true, focusedText: focused.text, ref: focused.ref, newCount: cachedCount };
    }

    logger.info(`[instruction.runner] Cached path: count=${cachedCount} missed — backtracking`);
  }

  // Backtrack: proportional window
  const backCount = Math.max(5, Math.floor(cachedCount * 0.2));
  const forwardCount = Math.max(10, Math.floor(cachedCount * 0.3));

  // Shift+Tab/ArrowUp back
  for (let i = 0; i < backCount; i++) {
    await browserAct({ action: 'press', sessionId, key: reverseKey, headed: true, timeoutMs: 2000 });
    await _sleep(80);
    await _scrollActiveIntoView(sessionId);
    const focused = await _readActiveElement(sessionId);
    if (focused?.text && await _llmMatchFocusedItem(step.verifyText, focused.text)) {
      const newCount = Math.max(0, cachedCount - i - 1);
      logger.info(`[instruction.runner] Backtrack: found at count=${newCount} (back ${i + 1})`);
      return { ok: true, focusedText: focused.text, ref: focused.ref, newCount };
    }
  }

  // Tab/ArrowDown forward from cached position
  // First, re-press the cached keys to get back to cached position
  for (let i = 0; i < backCount; i++) {
    await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
    await _sleep(50);
  }
  // Now go forward
  for (let i = 0; i < forwardCount; i++) {
    await browserAct({ action: 'press', sessionId, key, headed: true, timeoutMs: 2000 });
    await _sleep(80);
    await _scrollActiveIntoView(sessionId);
    const focused = await _readActiveElement(sessionId);
    if (focused?.text && await _llmMatchFocusedItem(step.verifyText, focused.text)) {
      const newCount = cachedCount + i + 1;
      logger.info(`[instruction.runner] Forward search: found at count=${newCount} (forward ${i + 1})`);
      return { ok: true, focusedText: focused.text, ref: focused.ref, newCount };
    }
  }

  // Full re-discovery: reset to address bar and search from 0
  logger.info(`[instruction.runner] Backtrack failed — full re-discovery from address bar`);
  await _pressEscape(sessionId); // close any stray overlay
  await _resetFocusToPageTop(sessionId);
  const discoverResult = await _discoverKeyPathStep(sessionId, step.verifyText, navMode, 50, step.allowMouse || false, step.stepAction || '');
  if (discoverResult?.ok) {
    return { ok: true, focusedText: discoverResult.focusedText, ref: discoverResult.ref, newCount: discoverResult.count };
  }

  return { ok: false, error: `Could not find "${step.verifyText}" near cached position ${cachedCount} or after re-discovery` };
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
  let currentOverlayMode = null; // tracks if we're inside an overlay (arrow/tab)

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
        currentOverlayMode = null;
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
      let navMode = step.navMode || currentOverlayMode || 'tab';

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
      if (hasCachedPath && step.cachedCount !== undefined) {
        // Fast path: use cached count
        navResult = await _executeCachedKeyPathStep(sessionId, { ...step, navMode, stepAction });
      } else {
        // Slow path: discover the path
        navResult = await _discoverKeyPathStep(sessionId, verifyText, navMode, 50, allowMouse, stepAction);
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

        // After Enter on a trigger, detect overlay mode for the NEXT step
        if (actionResult?.ok) {
          const overlayMode = await _detectOverlayNavMode(sessionId);
          currentOverlayMode = overlayMode === 'arrow' ? 'arrow' : null; // null = tab (default)
          // Store opensOverlay info in discovered path
          discoveredKeyPath.push({
            description: step.target ? `Click "${step.target}"` : `Step ${i + 1}`,
            verifyText,
            action: 'Enter',
            navMode,
            cachedCount: navResult.count || navResult.newCount || 0,
            mouse: navResult.mouse || false,
            stepAction: stepAction || '',
            opensOverlay: true,
            overlayNavMode: overlayMode,
          });
          // If we have a cached path, update the overlayNavMode
          if (hasCachedPath && i + 1 < steps.length) {
            steps[i + 1].navMode = overlayMode;
          }
          stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText });
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

      // After non-Enter actions, reset overlay mode
      if (actionType !== 'Enter') {
        currentOverlayMode = null;
      }

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
