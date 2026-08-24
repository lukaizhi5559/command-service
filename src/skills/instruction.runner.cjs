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
      // inDropdown: true when ArrowDown should navigate within a dropdown (not open autocomplete)
      // - element has role menuitem/menuitemcheckbox/menuitemradio/option (it IS a dropdown item)
      // - element is inside [role="menu"] or [role="listbox"] AND is NOT an input/textarea/combobox
      const _role = el.getAttribute('role') || '';
      const _tag = el.tagName.toLowerCase();
      const inDropdown = ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'].includes(_role) ||
                         (!['input', 'textarea'].includes(_tag) && _role !== 'combobox' && _role !== 'textbox' &&
                          !!el.closest('[role="menu"], [role="listbox"]'));
      // currentValue: what's currently in the field (input.value, textarea.value,
      // or textContent for contenteditable). Used for stuck-detection after Just-type.
      const currentValue = (el.value !== undefined && el.value !== ''
        ? String(el.value)
        : (el.isContentEditable ? (el.innerText || el.textContent || '') : ''))
        .trim().replace(/\\s+/g, ' ').slice(0, 120);
      return { tag: _tag, role: _role, text,
               currentValue,
               ref,
               type: el.tagName === 'INPUT' ? (el.type || 'text') : '',
               ariaLabel,
               isIconLike,
               hasSvg,
               inDropdown,
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

// ---------------------------------------------------------------------------
// Chip/token confirmation: for email To/CC/BCC and similar multi-select
// inputs, the page converts the typed text into a chip only after Enter is
// pressed. This function checks the focused element and its context and, if
// it looks like a token field, presses Enter up to two times and verifies the
// typed value no longer appears as raw text in the input.
//
// Detection layers (any one triggers confirmation):
// 1. Element name attribute (name="to", name="cc", name="bcc")
// 2. Combobox semantics (role="combobox", aria-autocomplete="list", aria-owns)
// 3. Chip-like children in 5 ancestors ([role="listbox"], .chip, .token, etc.)
// 4. Step target text fallback (target contains "To/Recipients/CC/BCC/Email")
// 5. Category forcing: if pageCategory="email_compose" and target looks chip-like
//
// Safety: after pressing Enter, checks if the compose dialog is still open.
// If it closed (Enter submitted the form prematurely), stops and returns ok:false.
// ---------------------------------------------------------------------------
async function _confirmChipIfNeeded(sessionId, stepTarget, stepValue, pageCategory) {
  const _chipLike = (target) => /\b(to|recipients|recipient|email|cc|bcc)\b/i.test(target || '');
  const _categoryForcesChip = pageCategory === 'email_compose';

  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { isChip: false };
        const name = (el.getAttribute('name') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const autocomplete = (el.getAttribute('aria-autocomplete') || '').toLowerCase();
        const owns = el.getAttribute('aria-owns') || '';
        const controls = el.getAttribute('aria-controls') || '';
        const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();

        const nameMatches = ['to', 'cc', 'bcc'].includes(name);
        const comboLike = role === 'combobox' || autocomplete === 'list' || owns || controls;
        const labelLike = /\b(to|recipients|recipient|email)\b/.test(placeholder + ' ' + ariaLabel);

        let parent = el.parentElement;
        let tokenLikeContainer = false;
        for (let p = 0; p < 5 && parent; p++) {
          if (parent.querySelector('[role="listbox"], [role="option"], .chip, .token, .recipient, [data-tooltip]')) {
            tokenLikeContainer = true; break;
          }
          parent = parent.parentElement;
        }

        const isChip = nameMatches || (comboLike && labelLike) || tokenLikeContainer;
        return { isChip, name, role, autocomplete, labelLike, comboLike, tokenLikeContainer };
      })()`,
    });
    const info = res?.result;
    logger.info(`[instruction.runner] _confirmChipIfNeeded: pageCategory=${pageCategory}, target="${stepTarget}", value="${String(stepValue || '').slice(0, 40)}", DOM={isChip=${info?.isChip}, name=${info?.name}, role=${info?.role}, comboLike=${info?.comboLike}, labelLike=${info?.labelLike}, tokenLikeContainer=${info?.tokenLikeContainer}}`);

    // Decide whether to confirm:
    // - DOM signals say chip → confirm
    // - Category says email_compose + target looks chip-like → force confirm
    // - Otherwise → skip
    if (!info?.isChip && !_chipLike(stepTarget) && !(_categoryForcesChip && _chipLike(stepTarget))) {
      logger.info(`[instruction.runner] _confirmChipIfNeeded: skipping (no chip signals, target not chip-like, category not forcing)`);
      return { ok: true, pressed: false };
    }
    if (!info?.isChip && _categoryForcesChip && _chipLike(stepTarget)) {
      logger.info(`[instruction.runner] Chip confirmation forced by category=email_compose for target "${stepTarget}"`);
    } else {
      logger.info(`[instruction.runner] Chip field detected (name=${info?.name}, role=${info?.role}) — confirming token for "${stepTarget || ''}"`);
    }

    // Capture pre-Enter state (compose dialog open?)
    const _preEnter = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return { hasDialog: !!dialog, dialogText: dialog ? (dialog.innerText || '').slice(0, 100) : '' };
      })()`,
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 2000 });
      await _sleep(400);
      logger.info(`[instruction.runner] _confirmChipIfNeeded: Enter press #${attempt + 1} sent`);

      // Safety: check compose dialog still open (Enter didn't submit form prematurely)
      const _postEnter = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return { hasDialog: !!dialog };
        })()`,
      });
      logger.info(`[instruction.runner] _confirmChipIfNeeded: post-Enter dialog check: preHasDialog=${_preEnter?.result?.hasDialog}, postHasDialog=${_postEnter?.result?.hasDialog}`);
      if (_preEnter?.result?.hasDialog && !_postEnter?.result?.hasDialog) {
        logger.warn(`[instruction.runner] Enter closed the compose dialog — form may have submitted prematurely. Stopping chip confirmation.`);
        return { ok: false, pressed: true, prematureSubmit: true };
      }

      // Check if value became a chip (no longer raw text in input)
      const stillThere = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return false;
          const val = el.value !== undefined ? String(el.value) : (el.textContent || '');
          return val.includes(${JSON.stringify(String(stepValue || ''))});
        })()`,
      });
      logger.info(`[instruction.runner] _confirmChipIfNeeded: stillThere=${stillThere?.result} after attempt ${attempt + 1}`);
      if (!stillThere?.result) {
        logger.info(`[instruction.runner] Token confirmed after ${attempt + 1} Enter press(es)`);
        return { ok: true, pressed: true, attempts: attempt + 1 };
      }
      // Value still in input — but for multi-recipient comboboxes (Gmail To/Cc/Bcc),
      // a chip/pill may have formed alongside the residual input text.
      // Check if a recipient chip now exists with this value before re-trying Enter.
      const _chipVal = String(stepValue || '').toLowerCase();
      const chipFormed = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const composeArea = document.querySelector('[role="dialog"]') || document;
          // Gmail recipient pills: [data-hovercard-id], [email], .vR .vN, [role="listbox"] [role="option"]
          const pills = composeArea.querySelectorAll('[data-hovercard-id], [email], .vR .vN, [role="listbox"] [role="option"], [role="option"][data-name]');
          return Array.from(pills).some(p => {
            const text = (p.textContent || p.getAttribute('email') || p.getAttribute('data-name') || '').toLowerCase();
            return text.includes(${JSON.stringify(_chipVal)});
          });
        })()`,
      });
      if (chipFormed?.result) {
        logger.info(`[instruction.runner] _confirmChipIfNeeded: chip/pill formed for "${String(stepValue || '').slice(0, 30)}" — value in input is residual, treating as confirmed`);
        return { ok: true, pressed: true, attempts: attempt + 1, chipFormed: true };
      }
      logger.info(`[instruction.runner] Value still present in input after Enter — re-trying`);
    }
    // Value still in input after 2 tries → not a chip field, but value is still there
    // No bad side-effect — the email address is in the To field and will be sent
    logger.info(`[instruction.runner] Chip confirmation: value remains in input after 2 Enter presses — treating as non-chip field (value preserved)`);
    return { ok: true, pressed: true, attempts: 2, notChip: true };
  } catch (e) {
    logger.warn(`[instruction.runner] Chip confirmation error (non-fatal): ${e.message}`);
    return { ok: true, pressed: false };
  }
}

// ---------------------------------------------------------------------------
// pressAfter: for AI chat message boxes (Enter submits the prompt) and
// list item creation (Enter creates the next item). This is the runtime
// equivalent of playwright.agent's pressAfter="Enter".
//
// Category-aware: if pageCategory="ai_chat", any field matching
// "message/prompt/chat/ask" gets Enter pressed. If pageCategory="document_editor",
// list-item fields get Enter pressed.
// ---------------------------------------------------------------------------
async function _pressAfterIfNeeded(sessionId, stepTarget, stepValue, pageCategory) {
  const t = (stepTarget || '').toLowerCase();
  const _isChatMessage = /\b(message|prompt|chat|ask|query)\b/.test(t) && !/\b(subject|body|email|search)\b/.test(t);
  const _isListItem = /\b(item|todo|task|list|checkbox)\b/.test(t);

  if (!_isChatMessage && !_isListItem) return { ok: true, pressed: false };

  // For AI chat: verify the page has chat indicators before pressing Enter
  if (_isChatMessage) {
    try {
      const res = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const el = document.activeElement;
          if (!el) return { isChat: false };
          const ph = (el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || '').toLowerCase();
          const role = el.getAttribute('role') || '';
          const isTextarea = el.tagName === 'TEXTAREA' || role === 'textbox';
          const hasChatHint = /message|prompt|ask|chat|anything|send/.test(ph);
          // Check for nearby send button (if present, Enter may not be the submit mechanism)
          const hasSendBtn = !!document.querySelector('button[data-testid="send-button"], button[aria-label*="Send" i], button[type="submit"]');
          return { isChat: isTextarea && hasChatHint && !hasSendBtn, ph, hasSendBtn };
        })()`,
      });
      const info = res?.result;
      if (!info?.isChat) {
        // If category says ai_chat but there's a send button, skip Enter (user should click Send)
        if (info?.hasSendBtn) {
          logger.info(`[instruction.runner] AI chat field has send button — skipping Enter (will click Send instead)`);
        }
        return { ok: true, pressed: false };
      }
      logger.info(`[instruction.runner] AI chat message field detected (placeholder="${info.ph}") — pressing Enter to submit`);
    } catch {
      return { ok: true, pressed: false };
    }
  }

  if (_isListItem) {
    logger.info(`[instruction.runner] List item field detected — pressing Enter to create next item`);
  }

  await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 2000 });
  await _sleep(500);
  return { ok: true, pressed: true };
}

// ---------------------------------------------------------------------------
// Submit verification: after clicking Send/Submit/Post, verifies the action
// succeeded by checking:
// 1. Compose dialog gone (email compose windows)
// 2. URL changed away from compose/editor
// 3. Success snackbar/toast appeared (Gmail "Sending...", LinkedIn "Posted!")
//
// Skip for document_editor category (auto-save pages don't have submit verification).
// ---------------------------------------------------------------------------
async function _verifySubmitSuccess(sessionId, verifyText, preClickState) {
  try {
    await _sleep(1500); // wait for submit to take effect

    // 1. Compose dialog gone?
    const composeGone = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return { gone: true, reason: 'no dialog' };
        const text = (dialog.innerText || '').toLowerCase();
        const hasSend = !!dialog.querySelector('[data-tooltip*="Send" i], [aria-label*="Send" i]');
        const isCompose = /compose|recipient|subject|message body/.test(text) || hasSend;
        return { gone: !isCompose, reason: isCompose ? 'compose still open' : 'dialog changed' };
      })()`,
    });
    if (composeGone?.result?.gone) {
      logger.info(`[instruction.runner] Submit verified — compose dialog gone`);
      return { ok: true, reason: 'compose_gone' };
    }

    // 2. URL changed away from compose?
    const urlCheck = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const url = window.location.href;
        const wasCompose = /compose|draft|new/.test(${JSON.stringify(preClickState?.url || '')});
        const isCompose = /compose|draft|new/.test(url);
        return { changed: wasCompose && !isCompose, url };
      })()`,
    });
    if (urlCheck?.result?.changed) {
      logger.info(`[instruction.runner] Submit verified — URL changed away from compose`);
      return { ok: true, reason: 'url_change' };
    }

    // 3. Success snackbar/toast?
    const snackbar = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const toast = document.querySelector('[role="status"], [role="alert"], .snackbar, .toast, [data-testid*="toast" i], [data-testid*="snackbar" i]');
        if (!toast) return { found: false };
        const text = (toast.innerText || '').toLowerCase();
        const successPatterns = ['sent', 'sending', 'posted', 'saved', 'submitted', 'done', 'success'];
        const matched = successPatterns.some(p => text.includes(p));
        return { found: matched, text: text.slice(0, 100) };
      })()`,
    });
    if (snackbar?.result?.found) {
      logger.info(`[instruction.runner] Submit verified — snackbar: "${snackbar.result.text}"`);
      return { ok: true, reason: 'snackbar' };
    }

    logger.warn(`[instruction.runner] Submit verification FAILED — compose still open, no URL change, no snackbar`);
    return { ok: false, reason: 'no verification signal' };
  } catch (e) {
    logger.warn(`[instruction.runner] Submit verification error (non-fatal): ${e.message}`);
    return { ok: true, reason: 'verify-error' }; // non-fatal — don't block on verify errors
  }
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
  const { skipReset = false, backward = false } = options;
  const map = [];
  const seenSet = new Set(); // O(1) deduplication
  let idCounter = 0;
  let starterSig = null; // first element — when we loop back, scan is done

  if (!skipReset) {
    await _resetFocusToPageTop(sessionId);
  }

  // ── Scan flow: ArrowRight → Tab by default, ArrowDown only in dropdowns ──
  // ArrowDown opens autocomplete on comboboxes and can select wrong items.
  // Only use ArrowDown when the focused element is inside a dropdown (detected
  // via ARIA roles: menuitem/option, or inside role=menu/listbox and not an input).
  // ArrowRight is always safe — it enters dropdowns from triggers and moves
  // horizontally in menus without opening autocomplete.
  const _initialEl = await _readActiveElement(sessionId);
  logger.info(`[instruction.runner] buildTabMap: initial focus tag=${_initialEl?.tag || 'none'}, role=${_initialEl?.role || 'none'}, inDropdown=${!!_initialEl?.inDropdown}`);

  // Key mappings: forward vs backward
  const keyRight = backward ? 'ArrowLeft'  : 'ArrowRight';
  const keyDown  = backward ? 'ArrowUp'    : 'ArrowDown';
  const keyTab   = backward ? 'Shift+Tab'  : 'Tab';
  const label    = backward ? 'backward'   : 'forward';

  for (let i = 0; i < maxElements; i++) {
    const before = await _readActiveElement(sessionId);
    let current = before; // tracks current focus position (may shift via arrows)
    let advanced = false;
    const _inDropdown = !!before?.inDropdown;

    // 1. Try ArrowRight (forward) / ArrowLeft (backward) — always safe
    await browserAct({ action: 'press', sessionId, key: keyRight, headed: true, timeoutMs: 2000 });
    await _sleep(60);
    let after = await _readActiveElement(sessionId);

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
          logger.info(`[instruction.runner] buildTabMap (${label}): ${keyRight} looped back to starter (ref=${sig}) — scan done`);
          break;
        }
        // Seen but not starter — fall through to next key
        current = after;
      }
    }
    // else: no focus change — current stays the same, fall through to next key

    // 2. Try ArrowDown (forward) / ArrowUp (backward) — ONLY when in a dropdown
    // ArrowDown opens autocomplete on comboboxes and selects wrong items.
    // Only use it when the focused element is a menuitem/option or inside a
    // role=menu/listbox (and not an input/textarea/combobox).
    if (!advanced && _inDropdown) {
      await browserAct({ action: 'press', sessionId, key: keyDown, headed: true, timeoutMs: 2000 });
      await _sleep(60);
      after = await _readActiveElement(sessionId);

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
            logger.info(`[instruction.runner] buildTabMap (${label}): ${keyDown} looped back to starter (ref=${sig}) — scan done`);
            break;
          }
          // Seen but not starter — fall through to Tab
          current = after;
        }
      }
    }

    // 3. Try Tab (forward) / Shift+Tab (backward) — always
    if (!advanced) {
      await browserAct({ action: 'press', sessionId, key: keyTab, headed: true, timeoutMs: 2000 });
      await _sleep(60);
      after = await _readActiveElement(sessionId);

      if (!after) break; // nothing focusable

      if (_isRealFocusChange(current, after)) {
        const sig = after?.ref || _elementSignature(after);
        if (!seenSet.has(sig)) {
          seenSet.add(sig);
          if (!starterSig) starterSig = sig;
          map.push({ id: ++idCounter, ...after, key: keyTab });
          advanced = true;
        } else {
          // Tab led to a seen element — check if it's the starter (looped back)
          if (sig === starterSig) {
            logger.info(`[instruction.runner] buildTabMap (${label}): looped back to starter (ref=${sig}) — scan done`);
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

  logger.info(`[instruction.runner] buildTabMap (${label}): scanned ${map.length} elements (cap=${maxElements}, skipReset=${skipReset})`);

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
    ], { maxTokens: 10, temperature: 0, responseTimeoutMs: 8000 });

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
    ], { maxTokens: 10, temperature: 0, responseTimeoutMs: 8000 });
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
      logger.info(`[instruction.runner] _executeAction type: target="${step.target || ''}", value="${String(step.value || '').slice(0, 50)}", pageCategory=${step.pageCategory || 'none'}, ref=${step.ref || 'none'}`);

      const _val = String(step.value || '');
      const _fillRef = step.ref || null;
      // Chip confirmation only for actual To/Cc/Bcc/Recipients/Email targets
      const _targetIsEmailChip = /\b(to|recipients|recipient|email|cc|bcc)\b/i.test(step.target || '');

      // For chip/token fields (Gmail/Outlook To), use reactFill directly.
      // browserAct type fails on React-controlled comboboxes because React
      // doesn't update the value until the right events fire. reactFill uses
      // the native setter + input event dispatch technique and is React-aware.
      let result;
      let _usedReactFill = false;
      if (_targetIsEmailChip && _fillRef) {
        logger.info(`[instruction.runner] _executeAction type: using reactFill for chip field [data-td-ref="${_fillRef}"]`);
        result = await browserAct({
          action: 'reactFill', sessionId, selector: `[data-td-ref="${_fillRef}"]`, text: _val, headed: true, timeoutMs: 10000,
        });
        _usedReactFill = !!result?.ok;
        await _sleep(300);
        logger.info(`[instruction.runner] _executeAction type: reactFill result ok=${result?.ok}, error=${result?.error || 'none'}`);
      } else {
        // Select all existing text first (Ctrl+A / Cmd+A) so the new value replaces it
        await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
        await _sleep(50);
        // Use `type` (not `fill`) because keyboard navigation already focused the field
        result = await browserAct({ action: 'type', sessionId, text: _val, headed: true, timeoutMs: 10000 });
        await _sleep(300);
        logger.info(`[instruction.runner] _executeAction type: browserAct type result ok=${result?.ok}, error=${result?.error || 'none'}`);
      }

      // Verify the value actually appeared in the field (or as a chip in the dialog)
      // NOTE: _fillRef is a string literal — no Node.js variables in the browser evaluate string
      let _verify = await browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
        text: `(() => {
          const el = ${_fillRef ? `document.querySelector('[data-td-ref="${_fillRef}"]') || document.activeElement` : 'document.activeElement'};
          if (!el || el === document.body) return { ok: false };
          const v = el.value !== undefined ? String(el.value) : (el.textContent || el.innerText || '');
          const inDialog = (document.querySelector('[role="dialog"]') || document.body).innerText.includes(${JSON.stringify(_val.slice(0, 50))});
          return { ok: v.includes(${JSON.stringify(_val.slice(0, 50))}) || inDialog, value: v.slice(0, 100), inDialog };
        })()`,
      });
      logger.info(`[instruction.runner] _executeAction type: verify ok=${_verify?.result?.ok}, value="${_verify?.result?.value || ''}", inDialog=${_verify?.result?.inDialog}`);

      // reactFill fallback for React-controlled inputs that ignore keyboard.type
      // (only if we didn't already use reactFill and we have a ref)
      if (!_verify?.result?.ok && !_usedReactFill && _fillRef) {
        logger.info(`[instruction.runner] type verify failed — trying reactFill fallback with selector [data-td-ref="${_fillRef}"]`);
        try {
          const _rfResult = await browserAct({
            action: 'reactFill', sessionId, selector: `[data-td-ref="${_fillRef}"]`, text: _val, headed: true, timeoutMs: 10000,
          });
          if (_rfResult?.ok) {
            _usedReactFill = true;
            result = _rfResult;
            await _sleep(300);
            logger.info(`[instruction.runner] reactFill fallback succeeded`);
            _verify = await browserAct({
              action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
              text: `(() => {
                const el = document.querySelector('[data-td-ref="${_fillRef}"]') || document.activeElement;
                if (!el || el === document.body) return { ok: false };
                const v = el.value !== undefined ? String(el.value) : (el.textContent || el.innerText || '');
                const inDialog = (document.querySelector('[role="dialog"]') || document.body).innerText.includes(${JSON.stringify(_val.slice(0, 50))});
                return { ok: v.includes(${JSON.stringify(_val.slice(0, 50))}) || inDialog, value: v.slice(0, 100), inDialog };
              })()`,
            });
            logger.info(`[instruction.runner] _executeAction type: post-reactFill verify ok=${_verify?.result?.ok}, value="${_verify?.result?.value || ''}", inDialog=${_verify?.result?.inDialog}`);
          } else {
            logger.warn(`[instruction.runner] reactFill fallback failed: ${_rfResult?.error}`);
          }
        } catch (e) {
          logger.warn(`[instruction.runner] reactFill fallback error: ${e.message}`);
        }
      }

      // Native setter as final fallback (no ref, or reactFill failed)
      if (!_verify?.result?.ok) {
        logger.info(`[instruction.runner] type verify failed — trying native setter fallback`);
        try {
          await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
            text: `(() => {
              const el = document.activeElement;
              if (!el || el === document.body) return false;
              el.focus();
              const text = ${JSON.stringify(_val)};
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                const proto = el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value');
                if (setter && setter.set) { setter.set.call(el, text); }
                else { el.value = text; }
              } else if (el.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(el);
                range.deleteContents();
                const node = document.createTextNode(text);
                range.insertNode(node);
              }
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()`,
          });
          await _sleep(200);
          logger.info(`[instruction.runner] native setter fallback applied`);
          // Re-verify after native setter to confirm text actually appeared
          _verify = await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
            text: `(() => {
              const el = ${_fillRef ? `document.querySelector('[data-td-ref="${_fillRef}"]') || document.activeElement` : 'document.activeElement'};
              if (!el || el === document.body) return { ok: false };
              const v = el.value !== undefined ? String(el.value) : (el.textContent || el.innerText || '');
              return { ok: v.includes(${JSON.stringify(_val.slice(0, 50))}), value: v.slice(0, 100) };
            })()`,
          });
          logger.info(`[instruction.runner] _executeAction type: native setter verify ok=${_verify?.result?.ok}, value="${_verify?.result?.value || ''}"`);
        } catch (e) {
          logger.warn(`[instruction.runner] native setter fallback failed: ${e.message}`);
        }
      }

      // Chip/token confirmation — ONLY for actual To/Cc/Bcc/Recipients/Email targets.
      // Not for Subject, Message Body, or other non-chip fields.
      let _chip = { ok: true, pressed: false };
      if (_targetIsEmailChip) {
        _chip = await _confirmChipIfNeeded(sessionId, step.target, step.value, step.pageCategory);
        logger.info(`[instruction.runner] _executeAction type: chip result ok=${_chip.ok}, pressed=${_chip.pressed}, attempts=${_chip.attempts || 0}, notChip=${_chip.notChip || false}, prematureSubmit=${_chip.prematureSubmit || false}`);
        if (_chip.prematureSubmit) {
          return { ok: false, error: 'Enter closed compose dialog prematurely during chip confirmation' };
        }
      } else {
        logger.info(`[instruction.runner] _executeAction type: skipping chip confirmation for non-chip target "${step.target}"`);
      }

      // pressAfter for AI chat / list items — category aware
      const _pressAfter = (result?.ok || _usedReactFill) ? await _pressAfterIfNeeded(sessionId, step.target, step.value, step.pageCategory) : { ok: true };
      logger.info(`[instruction.runner] _executeAction type: pressAfter result ok=${_pressAfter.ok}, pressed=${_pressAfter.pressed}`);

      // Retry-based chip fallback: if value still not in field after all attempts,
      // and step.retryCount >= 3, try pressing Enter as last-resort chip/token confirmation
      if (!_verify?.result?.ok && (step.retryCount || 0) >= 3) {
        logger.warn(`[instruction.runner] type failed ${(step.retryCount || 0)}x — trying last-resort Enter for chip/token confirmation`);
        await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 2000 });
        await _sleep(400);
        const _retryVerify = await browserAct({
          action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
          text: `(() => {
            const el = document.activeElement;
            if (!el || el === document.body) return { ok: false };
            const v = el.value !== undefined ? String(el.value) : (el.textContent || el.innerText || '');
            return { ok: v.includes(${JSON.stringify(_val.slice(0, 50))}) };
          })()`,
        });
        if (_retryVerify?.result?.ok) {
          logger.info(`[instruction.runner] Last-resort Enter confirmed chip/token — value now in field`);
          return { ok: true };
        }
      }

      const _finalOk = (result?.ok || _usedReactFill) && _chip.ok && _pressAfter.ok;
      return { ok: _finalOk, error: _finalOk ? undefined : (result?.error || 'type verification failed') };
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
  let rawSteps = [];
  if (/\n/.test(instructions)) {
    // Primary: one instruction per line (as specified in the prompt)
    rawSteps = instructions.split(/\n/).map(s => s.trim()).filter(Boolean);
  } else {
    // Fallback: sentence-style for legacy single-line instructions
    rawSteps = instructions.split(/\.\.\s*|\.\s+|\.$/).map(s => s.trim()).filter(Boolean);
  }
  for (const raw of rawSteps) {
    // Strip leading dash, bullets, and numbering
    const cleaned = raw.replace(/^[-•\d.]+[.\s)]+/, '').trim();
    if (!cleaned) continue;
    const step = parseStep(cleaned);
    if (step) steps.push(step);
  }
  logger.info(`[instruction.runner] parseInstructions: ${rawSteps.length} raw lines, ${steps.length} parsed steps`);
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
    let target = m[1].replace(/^["']|["']$/g, '');
    // Strip CSS selectors — extract the attribute value as a hint
    if (/^[a-z]+\[/.test(target)) {
      const attrMatch = target.match(/['"]([^'"]+)['"]/);
      target = attrMatch ? attrMatch[1] : target.replace(/[^\w\s]/g, ' ').trim();
      logger.info(`[instruction.runner] parseStep: stripped CSS selector to target="${target}"`);
    }
    return { action: 'click', verifyText: target, target };
  }

  // Fill "value" into the "field" field (safety net — prompt says use Type, but LLM may still use Fill)
  // Also handles reversed "Fill "field" with "value"" format
  m = s.match(/^fill\s+["']([^"']*)["']\s+(?:into|in|to|with)\s+(?:the\s+)?["']([^"']*)["'](?:\s+(?:field|input|textarea|box|area))?$/i);
  if (m) {
    let value, target;
    // Detect reversed format: "Fill "field" with "value""
    if (s.match(/^fill\s+["'][^"']*["']\s+with\s+/i)) {
      target = _isGenericFieldLabel(m[1]) ? null : m[1];
      value = m[2];
    } else {
      value = m[1];
      target = _isGenericFieldLabel(m[2]) ? null : m[2];
    }
    // Strip CSS selectors from target
    if (target && /^[a-z]+\[/.test(target)) {
      const attrMatch = target.match(/['"]([^'"]+)['"]/);
      target = attrMatch ? attrMatch[1] : target.replace(/[^\w\s]/g, ' ').trim();
      logger.info(`[instruction.runner] parseStep: stripped CSS selector from Fill target to "${target}"`);
    }
    return { action: 'fill', verifyText: target, target, value };
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

async function runInstructionSkill({ instructions, keyPath, params, skillArgs, startUrl, sessionId, timeoutMs, pageCategory, urlFirstNav }) {
  if (!sessionId) return { ok: false, error: 'No sessionId provided' };
  const _pageCategory = pageCategory || 'web_generic';
  const _urlFirstNav = !!urlFirstNav;
  logger.info(`[instruction.runner] runInstructionSkill: pageCategory=${_pageCategory}, sessionId=${sessionId}, urlFirstNav=${_urlFirstNav}`);

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

  // Determine steps: always parse from text instructions.
  // The buildTabMap + LLM pick + Playwright click approach is used for every run
  // (both preview and test). The cached keyPath is saved for debugging/analytics
  // but never used for navigation — clickByText is unreliable for dynamic elements.
  let steps = [];
  if (resolvedInstructions) {
    steps = parseInstructions(resolvedInstructions);
    if (steps.length === 0) {
      return { ok: false, error: 'Could not parse any steps from instructions' };
    }
    logger.info(`[instruction.runner] Parsed ${steps.length} steps from text instructions`);
  } else {
    return { ok: false, error: 'No instructions provided' };
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

  // ── URL-first overlay awareness ──────────────────────────────────────────
  // URL-first navigation may have opened an overlay (modal, dialog, popup,
  // dropdown, menu, side panel, drawer) that Escape would dismiss. Detect it
  // via DOM state (not URL patterns) and set overlayActive=true so the first
  // buildTabMap uses skipReset=true (doesn't send Escape which would close it).
  // This is DOM-state-based — works for ALL sites regardless of URL pattern.
  let overlayActive = false;
  let _urlFirstOverlayDetected = false;
  let _overlayRecoveryRetried = false;
  try {
    const _overlayCheck = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return { hasOverlay: true, type: 'dialog' };
        if (document.querySelector('[popover]:not([data-popper-hidden])')) return { hasOverlay: true, type: 'popover' };
        const menu = document.querySelector('[role="menu"], [role="listbox"]');
        if (menu && menu.offsetParent !== null) return { hasOverlay: true, type: 'menu' };
        const classMatch = document.querySelector('.modal:not([hidden]), .popup:not([hidden]), .dropdown-menu:not([hidden]), .overlay:not([hidden]), .drawer:not([hidden]), .sheet:not([hidden]), .slide-over:not([hidden])');
        if (classMatch && classMatch.offsetParent !== null) return { hasOverlay: true, type: 'class' };
        const expanded = document.querySelector('[aria-expanded="true"]');
        if (expanded) {
          const role = expanded.getAttribute('role') || '';
          if (role === 'combobox' || role === 'button' || expanded.tagName === 'BUTTON') return { hasOverlay: true, type: 'expanded' };
        }
        return { hasOverlay: false };
      })()`,
    }).catch(() => ({ ok: false }));
    if (_overlayCheck?.ok && _overlayCheck?.result?.hasOverlay) {
      overlayActive = true;
      _urlFirstOverlayDetected = true;
      logger.info(`[instruction.runner] URL-first overlay detected (type=${_overlayCheck.result.type}) — setting overlayActive=true to preserve it during scan`);
    }
  } catch (_) {}

  // Reset focus to address bar (known starting point)
  // Skip if overlay is active — _resetFocusToPageTop sends Escape which would close it
  if (!overlayActive) {
    await _resetFocusToPageTop(sessionId);
  }

  // ── Runtime safety net: skip redundant click step if overlay is already open ─
  // If URL-first opened an overlay and the first step is a click that would open
  // it (e.g. "Compose", "New", "Create"), skip it — the action is already done.
  if (overlayActive && steps.length > 0 && steps[0].action === 'click') {
    const _clickTarget = (steps[0].target || '').toLowerCase();
    const _openActionVerbs = ['compose', 'new', 'create', 'add', 'open', 'start', 'edit', 'write', 'draft'];
    if (_openActionVerbs.some(v => _clickTarget.includes(v))) {
      logger.info(`[instruction.runner] Overlay already open — skipping Click "${steps[0].target}" (action already triggered by URL-first)`);
      steps.shift();
    }
  }

  // Execute each step
  const stepResults = [];
  const discoveredKeyPath = []; // build this for caching
  // currentOverlayMode removed — buildTabMap handles arrow/tab detection internally
  // Sticky overlay flag: once an overlay (dropdown/modal) opens, all subsequent steps
  // use skipReset=true (don't reset focus to page top) until a navigate event closes it.
  // This prevents fill steps inside a modal from closing the modal by resetting focus.
  let lastFillValue = ''; // hint for the next click when target is a generic button (e.g. "Add")

  // Tab-map cache: one scan per overlay session, reused for all steps via data-td-ref.
  // Invalidated on: URL change, click fails (ref not found), new overlay/submenu opens,
  // or LLM returns no match. The data-td-ref attributes persist in the DOM from the
  // initial scan, so subsequent steps can click directly via [data-td-ref="tm-..."].
  let _cachedTabMap = null;
  let _cachedTabMapUrl = null;
  let _cachedTabMapOverlayActive = null;

  for (let i = 0; i < steps.length; i++) {
    if (Date.now() > deadline) {
      return { ok: false, error: `Timeout after ${overallTimeout}ms at step ${i + 1}/${steps.length}`, stepResults, discoveredKeyPath };
    }

    const step = steps[i];
    logger.info(`[instruction.runner] Step ${i + 1}/${steps.length}: ${JSON.stringify({ ...step, value: step.value ? String(step.value).substring(0, 40) : undefined })} [pageCategory=${_pageCategory}]`);

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
        // Navigation closes any open overlay (dropdown/modal)
        overlayActive = false;
        _cachedTabMap = null;        // URL changed — invalidate cache
        _cachedTabMapUrl = null;
        _cachedTabMapOverlayActive = null;
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
          // Use _executeAction so chip confirmation + pressAfter + native setter fallback apply
          const fillResult = await _executeAction(sessionId, { action: 'Type', value: step.value, target: step.target || '', pageCategory: _pageCategory });
          lastFillValue = String(step.value || '');
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
      // skipReset: if an overlay (dropdown/modal) is active, don't reset focus
      // to page top — that would close the overlay. The overlayActive flag is
      // sticky: once set, it stays true until a navigate event closes the overlay.
      // This ensures fill steps inside a modal keep skipReset=true.
      const skipReset = overlayActive || (i > 0 && stepResults[i - 1]?.opensOverlay);
      try {
          // ── Tab-map cache: one scan per overlay session ───────────────────
          // For open overlays, scan once and reuse via data-td-ref selectors.
          // For landing pages, scan once and reuse until URL changes.
          // Invalidated on: URL change, click fails, new overlay opens, LLM returns no match.
          let tabMap;
          let _usedCachedTabMap = false;

          if (_cachedTabMap && _cachedTabMapOverlayActive === overlayActive) {
            // Check if URL changed (landing page navigation)
            const _urlCheck = await browserAct({
              action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
              text: `window.location.href`,
            }).catch(() => ({ ok: false }));
            const _url = _urlCheck?.ok ? _urlCheck.result : null;
            if (_url === _cachedTabMapUrl) {
              tabMap = _cachedTabMap;
              _usedCachedTabMap = true;
              logger.info(`[instruction.runner] Using cached tab-map (${tabMap.length} elements) — URL and overlay state unchanged`);
            } else {
              _cachedTabMap = null; // URL changed — invalidate
            }
          }

          if (!tabMap) {
            // Build fresh tab-map (forward scan)
            tabMap = await buildTabMap(sessionId, 150, { skipReset });

            // If forward scan found very few elements and we're in an overlay,
            // do a backward scan (Shift+Tab) to find elements before current focus.
            // In a dialog, Shift+Tab from the first element wraps to the last,
            // so we find all elements the forward scan missed.
            // Shift+Tab only moves focus — never clicks, selects, or dismisses.
            if (overlayActive && tabMap.length < 3) {
              logger.info(`[instruction.runner] Forward scan found only ${tabMap.length} elements in overlay — doing backward scan (Shift+Tab)`);
              const backwardMap = await buildTabMap(sessionId, 150, { skipReset: true, backward: true });
              // Merge: add backward elements that aren't already in the forward map
              const existingSigs = new Set(tabMap.map(e => _elementSignature(e)));
              for (const el of backwardMap) {
                const sig = _elementSignature(el);
                if (!existingSigs.has(sig)) {
                  tabMap.push({ id: tabMap.length + 1, ...el });
                  existingSigs.add(sig);
                }
              }
              logger.info(`[instruction.runner] Merged backward scan: ${tabMap.length} total elements`);
            }

            _cachedTabMap = tabMap;
            _cachedTabMapOverlayActive = overlayActive;
            const _urlRes = await browserAct({
              action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
              text: `window.location.href`,
            }).catch(() => ({ ok: false }));
            _cachedTabMapUrl = _urlRes?.ok ? _urlRes.result : null;
            logger.info(`[instruction.runner] Built fresh tab-map (${tabMap.length} elements) — cached for overlay session (url=${_cachedTabMapUrl})`);
          }

          // 2. Ask LLM to pick the best element
          const clickHint = (stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select') ? lastFillValue : '';
          let pickedEntry = await _llmPickFromTabMap(tabMap, stepAction, verifyText, step.value, clickHint);

          // If LLM returns no match and we used cached tab-map, invalidate and re-scan
          if (!pickedEntry && _usedCachedTabMap) {
            logger.info(`[instruction.runner] LLM returned no match from cached tab-map — invalidating cache and re-scanning`);
            _cachedTabMap = null;
            tabMap = await buildTabMap(sessionId, 150, { skipReset });
            if (overlayActive && tabMap.length < 3) {
              const backwardMap = await buildTabMap(sessionId, 150, { skipReset: true, backward: true });
              const existingSigs = new Set(tabMap.map(e => _elementSignature(e)));
              for (const el of backwardMap) {
                const sig = _elementSignature(el);
                if (!existingSigs.has(sig)) {
                  tabMap.push({ id: tabMap.length + 1, ...el });
                  existingSigs.add(sig);
                }
              }
            }
            _cachedTabMap = tabMap;
            pickedEntry = await _llmPickFromTabMap(tabMap, stepAction, verifyText, step.value, clickHint);
          }

          // If no match, try reveal button (click steps only, not for small dropdowns).
          // Uses a separate LLM call to identify reveal buttons — avoids fragile regex
          // and keeps the main pick call simple (N or 0).
          // Skip the reveal-button loop for close/X/dismiss targets — these are never
          // hidden behind a "See more" reveal button. Trying to find one wastes time
          // and often mis-clicks a wrong element.
          const isCloseLike = /\b(?:x(?:\s+button)?|close(?:\s+(?:button|icon))?|dismiss(?:\s+button)?|cancel(?:\s+button)?)\b/i.test(verifyText);
          if (!pickedEntry && !isCloseLike && (stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select') && tabMap.length > 5) {
            for (let revealIter = 0; revealIter < 3 && !pickedEntry; revealIter++) {
              const revealBtn = await _llmPickRevealButton(tabMap);
              if (!revealBtn) break;
              const revealSelector = revealBtn.ref ? `[data-td-ref="${revealBtn.ref}"]` : null;
              if (revealSelector) {
                try {
                  await browserAct({ action: 'click', sessionId, selector: revealSelector, headed: true, timeoutMs: 5000 });
                  logger.info(`[instruction.runner] Clicked reveal button "${revealBtn.text || revealBtn.ariaLabel}" (iter ${revealIter + 1})`);
                  await _sleep(1500); // wait for content to load/expand
                } catch (e) {
                  logger.warn(`[instruction.runner] Reveal button click failed: ${e.message}`);
                  break;
                }
              }
              // Rebuild tab-map and retry LLM pick
              const retryTabMap = await buildTabMap(sessionId, 150, { skipReset });
              pickedEntry = await _llmPickFromTabMap(retryTabMap, stepAction, verifyText, step.value, clickHint);
            }
          }

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
                  logger.info(`[instruction.runner] Tab-map: Playwright click failed for "${verifyText}" — trying coordinate-click fallback`);
                }
              } catch (e) {
                logger.warn(`[instruction.runner] Tab-map: Playwright click error: ${e.message} — trying coordinate-click fallback`);
              }
            }

            // Coordinate-click fallback: if selector click failed (data-td-ref lost),
            // click at the element's center coordinates from the tab-map
            if (!clickOk && pickedEntry.x !== undefined && pickedEntry.x > 0) {
              const cx = Math.round(pickedEntry.x + (pickedEntry.w || 0) / 2);
              const cy = Math.round(pickedEntry.y + (pickedEntry.h || 0) / 2);
              logger.info(`[instruction.runner] Tab-map: coordinate-click at (${cx}, ${cy}) for "${verifyText}"`);
              try {
                const coordResult = await browserAct({ action: 'clickAt', sessionId, x: cx, y: cy, headed: true, timeoutMs: 5000 });
                clickOk = !!coordResult?.ok;
                clickedViaPlaywright = clickOk;
                if (clickOk) {
                  logger.info(`[instruction.runner] Tab-map: coordinate-click succeeded for "${verifyText}"`);
                }
              } catch (e) {
                logger.warn(`[instruction.runner] Tab-map: coordinate-click failed: ${e.message}`);
              }
            }

            // Tab-count fallback: tab to element by count (focus only — action phase handles Enter)
            // Only for page-level navigation (skipReset=false). Inside overlays, resetting
            // focus closes the dropdown/modal — coordinate-click handles that case.
            if (!clickOk) {
              // Click failed — element may have been re-rendered. Invalidate cache.
              _cachedTabMap = null;
              logger.info(`[instruction.runner] Click failed for "${verifyText}" — invalidating tab-map cache`);
            }
            if (!clickOk && pickedEntry.id && !skipReset) {
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
              if (clickedViaPlaywright && (stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select')) {
                // Trust the Playwright click — don't probe. The probe checks
                // document.activeElement AFTER the click, but the click may have
                // changed focus (closed modal, navigated) causing false mismatches.
                navResult = { ok: true, count: 0, navMode, focusedText: pickedEntry.text || pickedEntry.ariaLabel || verifyText, ref: pickedEntry.ref || null, mouse: true, matchedBy: 'tabmap_llm' };
              } else {
                const focused = await _readActiveElement(sessionId);
                if (focused) {
                  const editable = await _isEditableByProbe(sessionId);
                  // mouse: true when Playwright click activated the element →
                  // action phase skips Enter/Space (prevents double-activation)
                  const mouseFlag = clickedViaPlaywright;
                  if (stepAction === 'fill' && editable) {
                    // Use pickedEntry.ref (the element we clicked from tab-map), not focused.ref
                    // (the active element after click, which may be stale if the click didn't move focus)
                    navResult = { ok: true, count: 0, navMode, focusedText: focused.text, ref: pickedEntry.ref || focused.ref || null, mouse: mouseFlag, matchedBy: 'tabmap_llm' };
                  } else if ((stepAction === 'click' || stepAction === 'dblclick') && !editable) {
                    navResult = { ok: true, count: 0, navMode, focusedText: focused.text, ref: focused.ref || null, mouse: mouseFlag, matchedBy: 'tabmap_llm' };
                  } else {
                    logger.info(`[instruction.runner] Tab-map: picked element but type mismatch (editable=${editable}, action=${stepAction}) — trying page search`);
                  }
                }
              }
            }
          }

          // 4. If tab-map didn't work, try page search with scroll (window.find).
          // Only for click/dblclick/select steps — page search can close modals and
          // is not appropriate for fill steps (inputs should be found via DOM query).
          // Also skip when overlayActive=true — Ctrl+F+Escape and scrolling can
          // close the open modal/dropdown, losing the context we need.
          if (!navResult && !overlayActive && (stepAction === 'click' || stepAction === 'dblclick' || stepAction === 'select')) {
            logger.info(`[instruction.runner] Tab-map did not find "${verifyText}" — trying page search with scroll`);
            const searchResult = await _pageSearchWithScroll(sessionId, verifyText, 5);
            if (searchResult) {
              if (stepAction === 'click' || stepAction === 'dblclick') {
                // Click the found element via Playwright (ref already injected by _readActiveElement)
                const cssSelector = searchResult.ref ? `[data-td-ref="${searchResult.ref}"]` : null;
                let clickOk = false;
                if (cssSelector) {
                  try {
                    const clickResult = await browserAct({ action: 'click', sessionId, selector: cssSelector, headed: true, timeoutMs: 5000 });
                    clickOk = !!clickResult?.ok;
                  } catch (e) {
                    logger.warn(`[instruction.runner] Page search Playwright click failed: ${e.message}`);
                  }
                }
                // Fallback: coordinate click using the focused element's rect
                if (!clickOk && searchResult.x !== undefined && searchResult.x > 0) {
                  const cx = Math.round(searchResult.x + (searchResult.w || 0) / 2);
                  const cy = Math.round(searchResult.y + (searchResult.h || 0) / 2);
                  try {
                    const coordResult = await browserAct({ action: 'clickAt', sessionId, x: cx, y: cy, headed: true, timeoutMs: 5000 });
                    clickOk = !!coordResult?.ok;
                  } catch (e) {
                    logger.warn(`[instruction.runner] Page search coordinate click failed: ${e.message}`);
                  }
                }
                if (clickOk) {
                  navResult = { ok: true, count: 0, navMode, focusedText: searchResult.text, ref: searchResult.ref, mouse: true, matchedBy: 'page_search_click' };
                }
              } else if (stepAction === 'fill') {
                const editable = await _isEditableByProbe(sessionId);
                if (editable) {
                  navResult = { ok: true, count: 0, navMode, focusedText: searchResult.text, ref: searchResult.ref || null, mouse: false, matchedBy: 'page_search' };
                }
              }
            }
          }

          // 5. If page search didn't work, try OCR fast path.
          // Skip when overlayActive=true — OCR fast path tabs through the page,
          // which moves focus out of dropdowns/modals and closes them.
          if (!navResult && !overlayActive) {
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

      // ── Direct DOM query fallback for fill steps ──────────────────────
      // Before falling back to the slow 50-tab path, try a direct DOM query
      // for inputs matching the target placeholder/aria-label. This is fast
      // and avoids wasting 5 minutes tabbing when the input doesn't exist.
      // For To/Recipients fields, prefer input/textarea[name="to"] and avoid
      // matching Gmail's "Ask Gmail" search box.
      if (!navResult && stepAction === 'fill') {
        try {
          const domQuery = await browserAct({
            action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
            text: `(() => {
              const target = ${JSON.stringify(verifyText)};
              const targetLower = target.toLowerCase();
              const _isToField = /\\b(to|recipients|recipient)\\b/i.test(target);
              const inputs = document.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable=""]');
              for (const input of inputs) {
                const ph = (input.placeholder || '').toLowerCase();
                const al = (input.getAttribute('aria-label') || '').toLowerCase();
                const lbl = (input.getAttribute('aria-labelledby') || '').toLowerCase();
                const name = (input.getAttribute('name') || '').toLowerCase();

                // Gmail To field: name="to" takes precedence
                if (_isToField && name === 'to') {
                  input.focus();
                  const rect = input.getBoundingClientRect();
                  return { tag: input.tagName.toLowerCase(), text: '', placeholder: input.placeholder || '',
                           ariaLabel: input.getAttribute('aria-label') || '', name, focusMatch: 'name-to',
                           x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                }

                if (ph.includes(targetLower) || al.includes(targetLower) || lbl.includes(targetLower)) {
                  // Avoid matching "Ask Gmail" search box when looking for To field
                  if (_isToField && al.includes('ask gmail')) continue;
                  input.focus();
                  const rect = input.getBoundingClientRect();
                  return { tag: input.tagName.toLowerCase(), text: '', placeholder: input.placeholder || '',
                           ariaLabel: input.getAttribute('aria-label') || '', name, focusMatch: 'label',
                           x: rect.x, y: rect.y, w: rect.width, h: rect.height };
                }
              }
              return null;
            })()`,
          });
          if (domQuery?.result) {
            logger.info(`[instruction.runner] DOM query found input for "${verifyText}": ${domQuery.result.tag} placeholder="${domQuery.result.placeholder}" match=${domQuery.result.focusMatch}`);
            navResult = { ok: true, count: 0, navMode: 'tab', focusedText: '', ref: null, mouse: false, matchedBy: 'dom_query' };
          }
        } catch (e) {
          logger.warn(`[instruction.runner] DOM query fallback failed: ${e.message}`);
        }
      }

      // ── Slow discovery (final fallback) ────────────────────────────────
      if (!navResult) {
        // Slow path: reset focus to top first, then discover the path.
        // Skip the reset when overlayActive=true — resetting to page top
        // closes dropdowns/modals. Start discovery from current focus instead.
        if (!overlayActive) {
          await _resetFocusToPageTop(sessionId);
        }
        navResult = await _discoverKeyPathStep(sessionId, verifyText, navMode, 50, allowMouse, stepAction);
      }

      if (!navResult?.ok) {
        // ── Overlay recovery: if URL-first was used and first step failed, the
        // overlay was likely closed by Escape during buildTabMap. Re-navigate to
        // startUrl to reopen it and retry with overlayActive=true.
        // The urlFirstNav flag tells us the URL was intentionally chosen to trigger
        // an action — no URL pattern matching needed.
        if (i === 0 && _urlFirstNav && !_urlFirstOverlayDetected && startUrl && !_overlayRecoveryRetried) {
          try {
            const _postFailCheck = await browserAct({
              action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
              text: `(() => {
                const visibleDialog = document.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"], [role="listbox"]');
                const hasVisibleOverlay = visibleDialog && visibleDialog.offsetParent !== null;
                return { hasVisibleOverlay };
              })()`,
            }).catch(() => ({ ok: false }));
            const _postFailResult = _postFailCheck?.ok ? _postFailCheck.result : null;
            if (!_postFailResult?.hasVisibleOverlay) {
              logger.warn(`[instruction.runner] Step 1 failed — URL-first was used but no visible overlay. Overlay was likely closed by Escape. Re-navigating to ${startUrl} to reopen.`);
              await browserAct({ action: 'navigate', sessionId, url: startUrl, headed: true, timeoutMs: 30000 });
              await _sleep(2000);
              // Re-check for overlay after re-navigate
              const _recheckRes = await browserAct({
                action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
                text: `(() => {
                  const d = document.querySelector('[role="dialog"], [aria-modal="true"]');
                  return !!(d && d.offsetParent !== null);
                })()`,
              }).catch(() => ({ ok: false }));
              if (_recheckRes?.ok && (_recheckRes.result === true || _recheckRes.result === 'true')) {
                overlayActive = true;
                _urlFirstOverlayDetected = true;
                logger.info(`[instruction.runner] Overlay reopened after re-navigate — retrying step 1 with overlayActive=true`);
              } else {
                logger.info(`[instruction.runner] No overlay after re-navigate — retrying step 1 anyway`);
              }
              _overlayRecoveryRetried = true;
              i--; // retry same step
              continue;
            }
          } catch (_) {}
        }
        stepResults.push({ step: i + 1, ...step, ok: false, error: navResult?.error });
        return { ok: false, error: `Step ${i + 1} failed: ${navResult?.error}`, stepResults, discoveredKeyPath };
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
        lastFillValue = String(value || '');
        actionResult = await _executeAction(sessionId, { action: 'Type', value, target: step.target || step.verifyText || '', pageCategory: _pageCategory, ref: navResult?.ref });
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
          overlayActive = true; // sticky — stays true until navigate event
          _cachedTabMap = null; // new overlay opened — invalidate cache so next step re-scans

          // Submit verification: if the clicked element looks like Send/Submit/Post,
          // verify the action actually succeeded (compose gone, URL change, snackbar).
          // Skip for document_editor category (auto-save pages don't have submit verification).
          const _isSubmit = /\b(send|submit|post|publish|create|save)\b/i.test(verifyText);
          const _shouldVerify = _isSubmit && _pageCategory !== 'document_editor';
          if (_shouldVerify) {
            const _preState = await browserAct({
              action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
              text: `(() => ({ url: window.location.href, bodyLen: document.body.innerText.length }))()`,
            }).catch(() => ({ result: {} }));
            const _submitVerify = await _verifySubmitSuccess(sessionId, verifyText, _preState?.result);
            if (!_submitVerify?.ok) {
              logger.warn(`[instruction.runner] Submit verification failed for "${verifyText}" — action may not have succeeded`);
              stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText, opensOverlay: true, submitVerified: false });
              // Try clicking Send again as recovery
              logger.info(`[instruction.runner] Retrying submit click for "${verifyText}"`);
              await browserAct({ action: 'clickByText', sessionId, text: verifyText, headed: true, timeoutMs: 10000 });
              await _sleep(1500);
              const _retryVerify = await _verifySubmitSuccess(sessionId, verifyText, _preState?.result);
              if (_retryVerify?.ok) {
                logger.info(`[instruction.runner] Submit retry succeeded`);
              }
            } else {
              stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText, opensOverlay: true, submitVerified: true });
            }
          } else {
            stepResults.push({ step: i + 1, ...step, ok: true, ref: navResult.ref, focusedText: navResult.focusedText, opensOverlay: true });
          }

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
          await _sleep(1000); // wait for overlay/page to settle
          continue;
        }
      } else {
        actionResult = await _executeAction(sessionId, { action: actionType });
      }

      if (!actionResult?.ok) {
        // Retry tracking: for type/fill steps, retry up to 3 times before failing
        const _retryCount = (step.retryCount || 0) + 1;
        if (_retryCount <= 3 && (step.action === 'fill' || step.action === 'type')) {
          logger.warn(`[instruction.runner] Step ${i + 1} type failed (attempt ${_retryCount}/3) — retrying`);
          step.retryCount = _retryCount;
          i--; // retry same step
          continue;
        }
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
// Three-tier iterative navigation: decision call + strategies
// ---------------------------------------------------------------------------
// Tier 1: URL-first (deterministic) — already done before this function
// Tier 2: Decision call — LLM returns 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Tab-Map)
// Tier 3: Strategy execution with fallback to Tab-Map

// Parse a single LLM action line into a structured action object.
function _parseAction(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();

  // DONE
  if (/^done$/i.test(t)) return { action: 'done' };

  // Click "button text"
  let m = t.match(/^Click\s+"([^"]+)"\s*$/i);
  if (m) return { action: 'click', target: m[1] };

  // Type "value" into the "field" field
  m = t.match(/^Type\s+"([^"]+)"\s+into\s+(?:the\s+)?"([^"]+)"\s+field\s*$/i);
  if (m) return { action: 'type', value: m[1], target: m[2] };

  // Press Enter / Tab / Escape
  m = t.match(/^Press\s+(Enter|Tab|Escape)\s*$/i);
  if (m) return { action: 'press', key: m[1] };

  // Navigate to URL
  m = t.match(/^Navigate\s+to\s+(https?:\/\/\S+)\s*$/i);
  if (m) return { action: 'navigate', url: m[1] };

  return null;
}

// ── State helpers ──────────────────────────────────────────────────────

async function _getUrl(sessionId) {
  try {
    const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
    return res?.ok ? res.result : '';
  } catch { return ''; }
}

async function _detectOverlay(sessionId) {
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        if (document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return true;
        const menu = document.querySelector('[role="menu"], [role="listbox"]');
        if (menu && menu.offsetParent !== null) return true;
        const classMatch = document.querySelector('.modal:not([hidden]), .popup:not([hidden]), .overlay:not([hidden]), .drawer:not([hidden]), .sheet:not([hidden])');
        if (classMatch && classMatch.offsetParent !== null) return true;
        return false;
      })()`,
    });
    return res?.result === true || res?.result === 'true';
  } catch { return false; }
}

// Click the first visible fillable element to focus it (for canvas editors
// where the title isn't auto-focused). Returns the focused element descriptor
// or null if no fillable element was found.
async function _clickFirstFillable(sessionId) {
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
      const sel = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          el.click();
          el.focus();
          let ref = el.getAttribute('data-td-ref');
          if (!ref || !ref.startsWith('tm-')) {
            ref = 'tm-' + Math.random().toString(36).slice(2, 10);
            el.setAttribute('data-td-ref', ref);
          }
          const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
          return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text, ref, type: el.tagName === 'INPUT' ? (el.type || 'text') : '' };
        }
      }
      return null;
    })()`,
    });
    const raw = res?.result;
    const parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"')) : raw;
    if (parsed) logger.info(`[instruction.runner] _clickFirstFillable: focused ${parsed.tag} role=${parsed.role} text="${parsed.text?.slice(0, 40)}"`);
    return parsed || null;
  } catch (e) {
    logger.warn(`[instruction.runner] _clickFirstFillable failed: ${e.message}`);
    return null;
  }
}

// ── Strategy 1: Just-type ──────────────────────────────────────────────
// The focused element is the right field — just type into it.
// If no element is focused (e.g., canvas editor where title isn't auto-focused),
// click the first visible fillable element to focus it before typing.
// Returns { ok, pageChanged, error }
async function _executeJustType(sessionId, value, focusedElement, pageCategory) {
  if (!focusedElement) {
    // No focused element — try to click the first visible fillable element
    logger.info(`[instruction.runner] Just-type: no focused element — clicking first fillable to focus`);
    const _firstFillable = await _clickFirstFillable(sessionId);
    if (!_firstFillable) return { ok: false, pageChanged: false, error: 'No focused element and no fillable element found' };
    focusedElement = _firstFillable;
  }

  const _tag = focusedElement.tag || '';
  const _role = focusedElement.role || '';
  const _isFillable = ['input', 'textarea'].includes(_tag) ||
                      _role === 'combobox' || _role === 'textbox';
  if (!_isFillable) {
    return { ok: false, pageChanged: false, error: `Focused element ${_tag} role=${_role} is not fillable` };
  }

  // Handle special values
  if (value === 'PRESS_ENTER') {
    logger.info(`[instruction.runner] Just-type: pressing Enter (field already has text)`);
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
    await _sleep(1000);
    return { ok: true, pageChanged: false };
  }
  if (value === 'SKIP' || !value) {
    return { ok: false, pageChanged: false, error: 'LLM says skip this field' };
  }

  logger.info(`[instruction.runner] Just-type: typing "${value.slice(0, 50)}" into ${_tag} "${(focusedElement.text || focusedElement.ariaLabel || '').slice(0, 40)}"`);

  // Detect contenteditable vs form input
  // Form inputs (input/textarea): use _executeAction (with Meta+a select-all to replace)
  // Contenteditable (div role=textbox): type at cursor, no Meta+a — supports multi-line block creation
  const _isFormInput = ['input', 'textarea'].includes(_tag);
  const _isContenteditable = !_isFormInput && (_role === 'textbox' || _tag === 'div');

  // Multi-line content for contenteditable (block creation in Notion, Google Docs, etc.)
  // Type each line directly (no Meta+a), press Enter between lines to create new blocks
  if (_isContenteditable && value.includes('\n')) {
    const lines = value.split('\n').filter(l => l.length > 0);
    logger.info(`[instruction.runner] Just-type: multi-line content (${lines.length} lines) for contenteditable`);

    for (let i = 0; i < lines.length; i++) {
      if (i === 0) {
        // First line: clear any placeholder/untitled text with Meta+a, then type
        await browserAct({ action: 'press', sessionId, key: 'Meta+a', headed: true, timeoutMs: 2000 });
        await _sleep(50);
      } else {
        // Press Enter to create a new block, wait for it to settle
        await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
        await _sleep(500);
      }
      // Type the line directly (no Meta+a — we're at cursor position)
      await browserAct({ action: 'type', sessionId, text: lines[i], headed: true, timeoutMs: 10000 });
      await _sleep(300);
    }

    // For AI chat, press Enter after typing to submit
    if (pageCategory === 'ai_chat') {
      await _sleep(500);
      logger.info(`[instruction.runner] Just-type: pressing Enter for ai_chat submit`);
      await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
      await _sleep(1000);
    }

    return { ok: true, pageChanged: false };
  }

  // Single-line or form input: use _executeAction (includes reactFill, Meta+a for form inputs)
  const result = await _executeAction(sessionId, {
    action: 'Type',
    value: value,
    target: focusedElement.text || focusedElement.ariaLabel || '',
    pageCategory: pageCategory,
    ref: focusedElement.ref || null,
  });

  if (!result?.ok) {
    return { ok: false, pageChanged: false, error: result?.error || 'Type failed' };
  }

  // For AI chat, press Enter after typing to submit
  if (pageCategory === 'ai_chat') {
    await _sleep(500);
    logger.info(`[instruction.runner] Just-type: pressing Enter for ai_chat submit`);
    await browserAct({ action: 'press', sessionId, key: 'Enter', headed: true, timeoutMs: 5000 });
    await _sleep(1000);
  }

  return { ok: true, pageChanged: false };
}

// ── Strategy 2: Meta+F search ──────────────────────────────────────────
// Find specific text on the page using window.find(), then click the element.
// Returns { ok, pageChanged, error }

// Find closest clickable ancestor of the currently focused element.
// Sets data-td-ref on it and returns { ref, tag, role, text }.
async function _findClosestClickable(sessionId, focused) {
  // If focused element is already clickable, return it
  const _tag = focused?.tag || '';
  const _role = focused?.role || '';
  if (['a', 'button'].includes(_tag) || ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(_role)) {
    return focused;
  }

  // Walk up to closest clickable ancestor via DOM
  try {
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
      text: `(() => {
        let el = document.activeElement;
        while (el && el !== document.body) {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link' || role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox' || el.hasAttribute('onclick')) {
            let ref = el.getAttribute('data-td-ref');
            if (!ref || !ref.startsWith('tm-')) {
              ref = 'tm-' + Math.random().toString(36).slice(2, 10);
              el.setAttribute('data-td-ref', ref);
            }
            const r = el.getBoundingClientRect();
            return { ref, tag, role, text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          }
          el = el.parentElement;
        }
        return null;
      })()`,
    });
    return res?.result || null;
  } catch (e) {
    logger.warn(`[instruction.runner] _findClosestClickable failed: ${e.message}`);
    return null;
  }
}

async function _executeMetaF(sessionId, searchText) {
  if (!searchText) return { ok: false, pageChanged: false, error: 'No search text' };

  logger.info(`[instruction.runner] Meta+F: searching for "${searchText}"`);

  // Use existing pageSearch to find text and focus element
  const focused = await pageSearch(sessionId, searchText);
  if (!focused) {
    return { ok: false, pageChanged: false, error: `Text "${searchText}" not found on page` };
  }

  logger.info(`[instruction.runner] Meta+F: found "${searchText}" → focused ${focused.tag} "${(focused.text || '').slice(0, 40)}"`);

  // Find closest clickable ancestor (the focused element might be a container)
  const clickTarget = await _findClosestClickable(sessionId, focused);
  if (!clickTarget) {
    return { ok: false, pageChanged: false, error: `No clickable element found for "${searchText}"` };
  }

  // Click via Playwright using data-td-ref
  const cssSelector = `[data-td-ref="${clickTarget.ref}"]`;
  logger.info(`[instruction.runner] Meta+F: clicking ${clickTarget.tag} "${(clickTarget.text || '').slice(0, 40)}" via ${cssSelector}`);

  try {
    const clickResult = await browserAct({ action: 'click', sessionId, selector: cssSelector, headed: true, timeoutMs: 5000 });
    if (!clickResult?.ok) {
      // Coordinate-click fallback
      if (clickTarget.x !== undefined && clickTarget.x > 0) {
        const cx = Math.round(clickTarget.x + (clickTarget.w || 0) / 2);
        const cy = Math.round(clickTarget.y + (clickTarget.h || 0) / 2);
        logger.info(`[instruction.runner] Meta+F: coordinate-click at (${cx}, ${cy})`);
        const coordResult = await browserAct({ action: 'clickAt', sessionId, x: cx, y: cy, headed: true, timeoutMs: 5000 });
        return { ok: !!coordResult?.ok, pageChanged: true, error: coordResult?.ok ? undefined : 'Coordinate click failed' };
      }
      return { ok: false, pageChanged: false, error: 'Click failed' };
    }
    await _sleep(1000); // wait for page to settle after click
    return { ok: true, pageChanged: true };
  } catch (e) {
    return { ok: false, pageChanged: false, error: `Click error: ${e.message}` };
  }
}

// ── Strategy 3: App Shortcuts ──────────────────────────────────────────
// Press an app-specific keyboard shortcut from appKnowledge.
// Returns { ok, pageChanged, error }
async function _executeShortcut(sessionId, keyCombo) {
  if (!keyCombo) return { ok: false, pageChanged: false, error: 'No shortcut' };

  logger.info(`[instruction.runner] Shortcut: pressing "${keyCombo}"`);

  const _preUrl = await _getUrl(sessionId);
  try {
    const result = await browserAct({ action: 'press', sessionId, key: keyCombo, headed: true, timeoutMs: 5000 });
    await _sleep(1500); // wait for page to react (dialog open, navigation, etc.)
    const _postUrl = await _getUrl(sessionId);
    const pageChanged = _preUrl !== _postUrl;
    return { ok: !!result?.ok, pageChanged, error: result?.error };
  } catch (e) {
    return { ok: false, pageChanged: false, error: `Shortcut error: ${e.message}` };
  }
}

// ── Strategy 4: Tab-Map scan session ───────────────────────────────────
// One scan per form/modal session. Track filled fields, omit from list.
// Returns { done, ok, error, pickedRef } — done=true when session ends.

// Execute a single Tab-Map action (click/type/press/navigate).
// Returns { ok, pageChanged, error, pickedRef, rescan }
async function _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory, prePickedEntry) {
  const _pageCategory = pageCategory || 'web_generic';

  if (parsed.action === 'done') {
    return { ok: true, pageChanged: false };
  }

  if (parsed.action === 'navigate') {
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

    const _preUrl = await _getUrl(sessionId);

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

    return { ok: clickOk, pageChanged, error: clickOk ? undefined : `Click failed for "${parsed.target}"`, pickedRef: pickedEntry.ref };
  }

  if (parsed.action === 'type') {
    let pickedEntry = prePickedEntry || await _llmPickFromTabMap(tabMap, 'fill', parsed.target, parsed.value, '');
    if (!pickedEntry) {
      return { ok: false, pageChanged: false, error: `No element found for "${parsed.target}"`, rescan: true };
    }

    // Verify the picked element's label matches the requested target before typing.
    // Prevents the per-step LLM fallback from typing values into the wrong field
    // (e.g., typing the email address into Subject instead of To recipients).
    if (!prePickedEntry) {
      const _pickedLabel = (pickedEntry.text || pickedEntry.ariaLabel || pickedEntry.placeholder || '').toLowerCase().trim();
      const _targetLabel = (parsed.target || '').toLowerCase().trim();
      if (!_fuzzyTextMatch(_targetLabel, _pickedLabel)) {
        // LLM picked the wrong element — try deterministic match first
        const _detMatch = await _matchElementToStep(sessionId, { target: parsed.target }, tabMap);
        if (_detMatch) {
          const _detLabel = (_detMatch.text || _detMatch.ariaLabel || _detMatch.placeholder || '').toLowerCase().trim();
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

    // Click the field to focus it
    const cssSelector = pickedEntry.ref ? `[data-td-ref="${pickedEntry.ref}"]` : null;
    if (cssSelector) {
      try {
        await browserAct({ action: 'click', sessionId, selector: cssSelector, headed: true, timeoutMs: 5000 });
      } catch (e) {
        logger.warn(`[instruction.runner] Tab-Map type: click field error: ${e.message}`);
      }
    }
    await _sleep(300);

    // Execute the type action (includes reactFill, chip confirmation)
    const result = await _executeAction(sessionId, {
      action: 'Type',
      value: parsed.value,
      target: parsed.target,
      pageCategory: _pageCategory,
      ref: pickedEntry.ref || null,
    });

    return { ok: !!result?.ok, pageChanged: false, error: result?.error, pickedRef: pickedEntry.ref };
  }

  return { ok: false, pageChanged: false, error: `Unknown action: ${parsed.action}` };
}

// Match a step's target text to an element in the tab-map.
// Tries exact label match, then contains match, then LLM fallback.
// Returns the element object or null.
async function _matchElementToStep(sessionId, step, tabMap) {
  const target = (step.target || '').toLowerCase().trim();
  if (!target) return null;

  // 1. Exact label match
  let match = tabMap.find(e => {
    const label = (e.text || e.ariaLabel || '').toLowerCase().trim();
    return label === target;
  });
  if (match) {
    logger.info(`[instruction.runner] _matchElementToStep: exact match "${step.target}" → #${match.id}`);
    return match;
  }

  // 2. Contains match (target is substring of label or vice versa)
  match = tabMap.find(e => {
    const label = (e.text || e.ariaLabel || '').toLowerCase().trim();
    return label.includes(target) || target.includes(label);
  });
  if (match) {
    logger.info(`[instruction.runner] _matchElementToStep: fuzzy match "${step.target}" → #${match.id} "${match.text || match.ariaLabel}"`);
    return match;
  }

  // 3. LLM fallback — ask which element ID matches
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const elementList = tabMap.map(e =>
    `${e.id} - ${e.tag || ''} "${e.text || e.ariaLabel || ''}" ${e.role || ''}`
  ).join('\n');
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'Return ONLY the element ID number that best matches the target. No other text.' },
      { role: 'user', content: `Target: "${step.target}"\nElements:\n${elementList}\n\nWhich element ID matches?` },
    ], { maxTokens: 5, temperature: 0.1, responseTimeoutMs: 5000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    match = tabMap.find(e => e.id === num);
    if (match) {
      logger.info(`[instruction.runner] _matchElementToStep: LLM match "${step.target}" → #${match.id}`);
      return match;
    }
  } catch (e) {
    logger.warn(`[instruction.runner] _matchElementToStep LLM fallback failed: ${e.message}`);
  }
  return null;
}

// Step-based Tab-Map: runs ONE step from a pre-extracted step plan.
// Returns same shape as _tabMapInnerStep: { done, ok, error, stateChanged, filledRef, filledLabel, filledValue, rescan, action, fallbackToLlm }
async function _tabMapStepExecute(sessionId, step, stepIndex, stepCount, tabMap, overlayActive, pageCategory, currentUrl) {
  logger.info(`[instruction.runner] Tab-Map step ${stepIndex + 1}/${stepCount}: ${JSON.stringify(step)}`);

  // Handle "done" step
  if (step.action === 'done') {
    return { done: true, ok: true, action: 'DONE' };
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

  // Match target to element
  let pickedEntry = null;
  if (step.target) {
    pickedEntry = await _matchElementToStep(sessionId, step, tabMap);
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
  const result = await _executeTabMapAction(sessionId, parsed, tabMap, overlayActive, pageCategory, pickedEntry);

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

  // Check for submit actions
  if (step.action === 'click' && /\b(send|submit|post|publish|create|save)\b/i.test(step.target || '')) {
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
  return {
    done: stateChanged, // session ends on state change (click/press only)
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
async function _tabMapInnerStep(sessionId, goal, actionHistory, currentUrl, overlayActive, pageCategory, agentContext, cachedTabMap, filledFields, consumedRefs, lastVerifyFailed) {
  const { _llmNextAction } = require('./browser.agent.cjs');

  // 1. Use cached tab-map (scan session — no re-scan unless invalidated by caller)
  const tabMap = cachedTabMap;
  if (!tabMap || tabMap.length === 0) {
    return { done: true, ok: false, error: 'Tab-map is empty' };
  }

  // 2. Ask LLM for next action
  const nextAction = await _llmNextAction(goal, currentUrl, tabMap, actionHistory, pageCategory, agentContext, lastVerifyFailed, consumedRefs, filledFields);
  if (!nextAction) {
    logger.warn(`[instruction.runner] Tab-Map: LLM returned null — treating as DONE`);
    return { done: true, ok: true };
  }
  logger.info(`[instruction.runner] Tab-Map step: LLM says "${nextAction}"`);

  // 3. Parse the action
  const parsed = _parseAction(nextAction);
  if (!parsed) {
    logger.warn(`[instruction.runner] Tab-Map: couldn't parse "${nextAction}" — treating as DONE`);
    return { done: true, ok: true };
  }

  // 4. Handle DONE
  if (parsed.action === 'done') {
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

  // 6. Execute the action
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
  if (parsed.action === 'click' && /\b(send|submit|post|publish|create|save)\b/i.test(parsed.target || '')) {
    const _verify = await _verifySubmitSuccess(sessionId, parsed.target, { url: currentUrl });
    if (_verify?.ok) {
      submitVerified = true;
      return { done: true, ok: true, stateChanged: true, action: nextAction };
    }
    logger.warn(`[instruction.runner] Tab-Map: submit verification failed — re-scanning`);
    return { done: false, ok: false, error: 'Submit verification failed', rescan: true, action: nextAction };
  }

  // 10. Check for state change
  const stateChanged = result.pageChanged;

  return {
    done: stateChanged, // session ends on state change
    ok: result.ok,
    error: result.error,
    stateChanged,
    filledRef,
    filledLabel,
    filledValue,
    action: nextAction,
  };
}

// ── Deterministic tier selection (replaces LLM _decisionCall) ─────────
// Probes page structure (scoped to overlay if open) and selects tier
// based on fillable/clickable element counts + page category + shortcuts.
// Returns: 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Shortcuts), 4 (Tab-Map)

// Count fillable + clickable elements, scoped to overlay if one is open.
// Returns { fillableCount, clickableCount, hasAutoFocus }
async function _probePageStructure(sessionId) {
  const res = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
    text: `(() => {
      // Scope to overlay if one is open (don't count background page inputs)
      const overlay = document.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
      const scope = (overlay && overlay.offsetParent !== null) ? overlay : document;

      const fillableSelector = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
      const fillable = scope.querySelectorAll(fillableSelector);
      let fillableCount = 0;
      let inputCount = 0, textareaCount = 0, contenteditableCount = 0, roleTextboxCount = 0;
      for (const el of fillable) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          fillableCount++;
          const tag = el.tagName.toLowerCase();
          if (tag === 'input') inputCount++;
          else if (tag === 'textarea') textareaCount++;
          else if (el.isContentEditable) contenteditableCount++;
          else if (el.getAttribute('role') === 'textbox') roleTextboxCount++;
        }
      }

      const clickableSelector = 'a, button, [role="button"], [role="link"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [onclick]';
      const clickable = scope.querySelectorAll(clickableSelector);
      let clickableCount = 0;
      for (const el of clickable) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) clickableCount++;
      }

      const focused = document.activeElement;
      const hasAutoFocus = focused && focused !== document.body &&
        (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable ||
         focused.getAttribute('role') === 'textbox' || focused.getAttribute('role') === 'combobox');

      // Real-time page context — what the user actually sees
      const pageTitle = (document.title || '').slice(0, 100);
      const visibleText = ((scope === document ? document.body : scope).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200);

      return { fillableCount, clickableCount, hasAutoFocus,
               fillableTypes: { inputCount, textareaCount, contenteditableCount, roleTextboxCount },
               pageTitle, visibleText };
    })()`,
  });
  try {
    const raw = res?.result;
    const parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"')) : raw;
    return parsed || { fillableCount: 0, clickableCount: 0, hasAutoFocus: false, fillableTypes: { inputCount: 0, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 }, pageTitle: '', visibleText: '' };
  } catch { return { fillableCount: 0, clickableCount: 0, hasAutoFocus: false, fillableTypes: { inputCount: 0, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 }, pageTitle: '', visibleText: '' }; }
}

// Lightweight DONE check — LLM YES/NO based on goal + action history.
async function _checkDone(goal, actionHistory) {
  if (actionHistory.length === 0) return false;
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const historyStr = actionHistory.slice(-10).map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'Has this browser automation goal been completed? Look at the action history. Return ONLY "YES" or "NO".' },
      { role: 'user', content: `Goal: ${goal}\nActions:\n${historyStr}` },
    ], { maxTokens: 5, temperature: 0.1, responseTimeoutMs: 5000 });
    const done = (raw || '').trim().toUpperCase().startsWith('YES');
    logger.info(`[instruction.runner] _checkDone: ${done ? 'YES' : 'NO'} (raw="${(raw || '').trim()}")`);
    return done;
  } catch (e) {
    logger.warn(`[instruction.runner] _checkDone failed: ${e.message}`);
    return false;
  }
}

// LLM-based tier selection — sees goal + URL + real-time page context (title,
// visible text) + agent context (shortcuts, commands) + page structure (element
// types) and returns 0-4. Falls back to _selectTierDeterministic on LLM failure.
async function _selectTierLLM(sessionId, goal, actionHistory, pageCategory, shortcutCount, focused, currentUrl, probe, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  // 1. DONE check (only if we've taken actions) — keep this deterministic
  if (actionHistory.length > 0) {
    const done = await _checkDone(goal, actionHistory);
    if (done) return 0;
  }

  const { fillableCount, clickableCount, hasAutoFocus, fillableTypes, pageTitle, visibleText } = probe;
  const _focusedStr = focused
    ? `${focused.tag} "${(focused.text || focused.ariaLabel || '').slice(0, 60)}" role=${focused.role || 'none'}`
    : 'none (body/no focus)';

  // Trim agentContext to relevant parts (shortcuts, command systems, creation notes)
  const _contextBlock = agentContext
    ? `\n\nApp context (shortcuts, commands, notes):\n${String(agentContext).slice(0, 800)}`
    : '';

  const systemPrompt = `You decide the navigation strategy for a browser automation task.
Look at the goal, the current URL, what's visible on the page, the page structure, and available shortcuts.
Return ONLY a single number — nothing else:
  0 = DONE (goal already achieved — see action history)
  1 = Just-type (the page has a primary input/contenteditable that's focused or should be; just type the value from the goal)
  2 = Meta+F (find specific text on the page by searching, then click it — for finding a specific item in a list)
  3 = Shortcut keys (press an app-specific keyboard shortcut to accomplish the goal)
  4 = Tab-Map (scan all focusable elements, pick one to interact with — for multi-field forms, toolbars, complex UI)

Decision rules:
- If the page shows a blank/new editor (visible text has placeholder like "New page", "Untitled", or the page title suggests a new blank document) and the goal is to create/write/type content → return 1 (Just-type — the title/content area is the primary input)
- If the page structure shows contenteditable elements (canvas editor) and the goal is to type/write/create → return 1 (Just-type)
- If the page has a single fillable input (search box, chat prompt) and the goal is to search/ask/type → return 1 (Just-type)
- If the page has multiple <input> form fields (e.g., To, Subject, Body — email compose, registration) and the goal is to fill them → return 4 (Tab-Map)
- If the goal requires finding a specific item on the page (email subject, conversation name, menu item) → return 2 (Meta+F)
- If app shortcuts are available (see App context) and a shortcut directly accomplishes the goal → return 3 (Shortcuts)
- If the goal requires interacting with multiple elements (form filling, toolbar buttons, multi-field modal) → return 4 (Tab-Map)
- If everything in the goal has been accomplished (see action history) → return 0
- When in doubt → return 4`;

  const userPrompt = `Goal: ${goal}
Current URL: ${currentUrl}
Page title: ${pageTitle}
Visible text (first 200 chars): ${visibleText}
Page category: ${pageCategory || 'unknown'}
Page structure: ${fillableCount} fillable (input=${fillableTypes.inputCount}, textarea=${fillableTypes.textareaCount}, contenteditable=${fillableTypes.contenteditableCount}), ${clickableCount} clickable, autoFocus=${hasAutoFocus}
Focused element: ${_focusedStr}
Available shortcuts: ${shortcutCount}
Actions taken so far:
${actionHistory.length > 0 ? actionHistory.slice(-10).map((a, i) => `  ${i + 1}. ${a}`).join('\n') : '  (none)'}${_contextBlock}

Strategy? (0, 1, 2, 3, or 4)`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 10, temperature: 0.1, responseTimeoutMs: 10000 });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    const result = [0, 1, 2, 3, 4].includes(num) ? num : 4;
    logger.info(`[instruction.runner] _selectTierLLM: strategy=${result} (raw="${(raw || '').trim()}") — fillable=${fillableCount} (input=${fillableTypes.inputCount}, ce=${fillableTypes.contenteditableCount}), title="${pageTitle}", url=${currentUrl}`);
    return result;
  } catch (e) {
    logger.warn(`[instruction.runner] _selectTierLLM failed: ${e.message} — falling back to _selectTierDeterministic`);
    return _selectTierDeterministic(sessionId, goal, actionHistory, pageCategory, shortcutCount, focused, probe);
  }
}

// Deterministic tier selection — fallback when LLM is unavailable.
// Uses page structure + fillable type breakdown + category + shortcuts.
// Order:
//   1. DONE check (LLM YES/NO — only if actionHistory > 0)
//   2. Canvas editor (majority contenteditable) + document_editor → Just-type (1)
//   3. 1 fillable + auto-focus → Just-type (1)
//   4. 0-1 fillable + shortcuts + shortcut-heavy category → Shortcuts (3)
//   5. 2+ fillable → Tab-Map (4) — forms take priority over search
//   6. 0 fillable + many clickable (>20) → Meta+F (2) — fails → Tab-Map
//   7. Default → Tab-Map (4)
async function _selectTierDeterministic(sessionId, goal, actionHistory, pageCategory, shortcutCount, focused, probe) {
  // 1. DONE check (only if we've taken actions)
  if (actionHistory.length > 0) {
    const done = await _checkDone(goal, actionHistory);
    if (done) return 0;
  }

  const { fillableCount, clickableCount, hasAutoFocus, fillableTypes } = probe;
  const _isCanvasEditor = (fillableTypes.contenteditableCount + fillableTypes.roleTextboxCount) >= Math.ceil(fillableCount * 0.5);
  logger.info(`[instruction.runner] _selectTierDeterministic: fillable=${fillableCount} (input=${fillableTypes.inputCount}, ce=${fillableTypes.contenteditableCount}), clickable=${clickableCount}, autoFocus=${hasAutoFocus}, category=${pageCategory}, shortcuts=${shortcutCount}, isCanvas=${_isCanvasEditor}`);

  // 2. Canvas editor (majority contenteditable) + document_editor → Just-type
  if (_isCanvasEditor && pageCategory === 'document_editor' && fillableCount >= 1) {
    logger.info(`[instruction.runner] _selectTierDeterministic: → 1 (Just-type) — canvas editor (ce=${fillableTypes.contenteditableCount})`);
    return 1;
  }

  // 3. Single fillable + auto-focus → Just-type
  if (fillableCount <= 1 && hasAutoFocus && focused) {
    const _isFillable = ['input', 'textarea'].includes(focused.tag) ||
                        ['combobox', 'textbox'].includes(focused.role);
    if (_isFillable) {
      logger.info(`[instruction.runner] _selectTierDeterministic: → 1 (Just-type) — single fillable + auto-focus`);
      return 1;
    }
  }

  // 4. 0-1 fillable + shortcuts available + shortcut-heavy category → Shortcuts
  const _shortcutCategories = ['media_player', 'calendar', 'social_feed', 'email_compose', 'document_editor'];
  if (fillableCount <= 1 && shortcutCount > 0 && _shortcutCategories.includes(pageCategory)) {
    logger.info(`[instruction.runner] _selectTierDeterministic: → 3 (Shortcuts) — ${shortcutCount} shortcuts + category=${pageCategory}`);
    return 3;
  }

  // 5. 2+ fillable → Tab-Map (forms take priority over search)
  if (fillableCount >= 2) {
    logger.info(`[instruction.runner] _selectTierDeterministic: → 4 (Tab-Map) — ${fillableCount} fillable elements`);
    return 4;
  }

  // 6. 0 fillable + many clickable → Meta+F (fails → Tab-Map fallback)
  if (fillableCount === 0 && clickableCount > 20) {
    logger.info(`[instruction.runner] _selectTierDeterministic: → 2 (Meta+F) — ${clickableCount} clickable items, no fillable`);
    return 2;
  }

  // 7. Default → Tab-Map
  logger.info(`[instruction.runner] _selectTierDeterministic: → 4 (Tab-Map) — default fallback`);
  return 4;
}

// ── Main iterative navigation loop (three-tier) ───────────────────────
// Tier 1: URL-first (already done by caller)
// Build a descriptive result string from action history + filled fields.
// This gives the synthesize step enough context to verify what was done
// without needing to scrape the final page (which may not show the result).
// Generic — works for any task (email, search, form, Notion, etc.).
function _buildResultString(goal, actionHistory, filledFields) {
  const parts = [];

  // Summarize filled fields with their values
  if (filledFields && filledFields.length > 0) {
    const fieldSummary = filledFields
      .map(f => `${f.label}: "${String(f.value).slice(0, 80)}"`)
      .join(', ');
    parts.push(`Filled fields [${fieldSummary}]`);
  }

  // Summarize key actions (clicks, presses) — strip result notes
  const actions = actionHistory
    .map(a => a.replace(/\s+→.*$/, ''))
    .filter(a => /^(Click|Press|Type|Shortcut|Meta\+F|Just-type)\b/i.test(a));
  if (actions.length > 0) {
    parts.push(`Actions taken [${actions.join('; ')}]`);
  }

  if (parts.length === 0) {
    return `Goal achieved in ${actionHistory.length} steps`;
  }
  return `Goal achieved in ${actionHistory.length} steps. ${parts.join('. ')}.`;
}

// Tier 2: _selectTier → 0 (DONE), 1 (Just-type), 2 (Meta+F), 3 (Shortcuts), 4 (Tab-Map)
// Tier 3: Strategy execution with fallback to Tab-Map
async function runIterativeNavigation({ goal, sessionId, startUrl, urlFirstNav, pageCategory, agentContext, shortcutCount = 0, timeoutMs = 120000 }) {
  if (!sessionId) return { ok: false, error: 'No sessionId provided' };
  const _pageCategory = pageCategory || 'web_generic';
  const _urlFirstNav = !!urlFirstNav;
  logger.info(`[instruction.runner] runIterativeNavigation: goal="${String(goal || '').slice(0, 80)}", pageCategory=${_pageCategory}, sessionId=${sessionId}, urlFirstNav=${_urlFirstNav}`);

  _clearLlmCache(sessionId);

  const startTime = Date.now();
  const actionHistory = [];
  let _doneVerifyFails = 0;

  // Tab-Map scan session state
  let _cachedTabMap = null;
  let _cachedTabMapUrl = null;
  let _cachedTabMapOverlayActive = null;
  const filledFields = [];        // { ref, label, value } — for LLM prompt
  const consumedRefs = new Set(); // refs of filled fields — for filtering element list
  let inTabMapSession = false;
  let overlayActive = false;
  const _shortcutCount = shortcutCount || 0;
  // Step-based Tab-Map state
  let _stepPlan = null;         // extracted steps for current page: [{ action, target?, value?, key? }]
  let _stepIndex = 0;           // current step index in _stepPlan
  let _usingStepFallback = false; // true → use per-step _llmNextAction (browse-and-report)

  // Initial overlay detection (URL-first might have opened a modal)
  overlayActive = await _detectOverlay(sessionId);
  if (overlayActive) {
    logger.info(`[instruction.runner] Iterative: initial overlay detected — overlayActive=true`);
  }

  let prevUrl = await _getUrl(sessionId);

  // ── Main loop ──────────────────────────────────────────────────────
  while (Date.now() - startTime < timeoutMs) {
    // 1. Read current state
    const currentUrl = await _getUrl(sessionId);
    const focused = await _readActiveElement(sessionId);
    const newOverlayActive = await _detectOverlay(sessionId);
    const _inStepPlan = !_usingStepFallback && _stepPlan && _stepIndex < _stepPlan.length;
    const stateChanged = _inStepPlan
      ? false  // Mid-step-plan: ignore URL/overlay changes, keep executing steps
      : (currentUrl !== prevUrl || newOverlayActive !== overlayActive);
    overlayActive = newOverlayActive;

    // 2. If in Tab-Map session and no state change → continue Tab-Map inner loop
    if (inTabMapSession && !stateChanged && _cachedTabMap) {
      let stepResult;

      if (!_usingStepFallback && _stepPlan && _stepIndex < _stepPlan.length) {
        // Step-based execution: run ONE step from the pre-extracted plan
        const _step = _stepPlan[_stepIndex];
        stepResult = await _tabMapStepExecute(
          sessionId, _step, _stepIndex, _stepPlan.length,
          _cachedTabMap, overlayActive, _pageCategory, currentUrl
        );

        // Handle fallback-to-LLM signal (element not matched, step failed)
        if (stepResult.fallbackToLlm) {
          logger.info(`[instruction.runner] Tab-Map: step ${_stepIndex + 1} requested LLM fallback — switching to per-step mode`);
          _usingStepFallback = true;
          // Don't increment _stepIndex — let per-step LLM take over from here
          // Fall through to per-step LLM below
        } else if (!stepResult.ok && !stepResult.rescan && !stepResult.done) {
          // Step failed (e.g., unknown action, click failed) — switch to per-step LLM
          logger.warn(`[instruction.runner] Tab-Map: step ${_stepIndex + 1} failed (${stepResult.error}) — switching to per-step LLM`);
          _usingStepFallback = true;
        } else {
          // Step executed (success or fail) — increment index
          _stepIndex++;
        }
      }

      if (_usingStepFallback || (!_stepPlan && !stepResult)) {
        // Per-step LLM fallback (browse-and-report or step execution failed)
        stepResult = await _tabMapInnerStep(
          sessionId, goal, actionHistory, currentUrl, overlayActive, _pageCategory, agentContext,
          _cachedTabMap, filledFields, consumedRefs, _doneVerifyFails > 0
        );
      }

      // Handle re-scan signal (element not found in cached tab-map)
      if (stepResult.rescan) {
        logger.info(`[instruction.runner] Tab-Map session: re-scanning (element not found)`);
        _cachedTabMap = null;
        _stepPlan = null;  // re-extract steps for fresh tab-map
        _stepIndex = 0;
        // Re-scan and retry this step
        const skipReset = overlayActive;
        let freshTabMap = await buildTabMap(sessionId, 150, { skipReset });
        if (overlayActive && freshTabMap.length < 3) {
          const backwardMap = await buildTabMap(sessionId, 150, { skipReset: true, backward: true });
          const existingSigs = new Set(freshTabMap.map(e => _elementSignature(e)));
          for (const el of backwardMap) {
            const sig = _elementSignature(el);
            if (!existingSigs.has(sig)) {
              freshTabMap.push({ id: freshTabMap.length + 1, ...el });
              existingSigs.add(sig);
            }
          }
        }
        _cachedTabMap = freshTabMap;
        _cachedTabMapUrl = currentUrl;
        _cachedTabMapOverlayActive = overlayActive;
        _clearLlmCache(sessionId);
        // Re-extract steps for the fresh tab-map (unless in fallback mode)
        if (!_usingStepFallback) {
          const { _extractSteps } = require('./browser.agent.cjs');
          _stepPlan = await _extractSteps(goal, currentUrl, _cachedTabMap, _pageCategory, agentContext);
          _stepIndex = 0;
          if (!_stepPlan || _stepPlan.length <= 1) {
            logger.info(`[instruction.runner] Tab-Map: re-extraction returned ${_stepPlan?.length || 0} step(s) — using per-step LLM`);
            _usingStepFallback = true;
          }
        }
        continue;
      }

      // Record action in history with result
      if (stepResult.action) {
        const _note = stepResult.stateChanged ? '→ page changed' : (stepResult.ok ? '→ ok' : '→ FAILED');
        actionHistory.push(`${stepResult.action} ${_note}`);
      }

      // Track filled fields — all elements are now shown to the LLM with [FILLED] markers,
      // so we no longer need consumedRefs for filtering. Keep filledFields for the markers.
      if (stepResult.filledRef) {
        filledFields.push({ ref: stepResult.filledRef, label: stepResult.filledLabel, value: stepResult.filledValue });
        logger.info(`[instruction.runner] Tab-Map: filled "${stepResult.filledLabel}" — marked [FILLED] for next LLM call (${filledFields.length} fields filled)`);
      }

      // Check if all steps in plan are completed — n/n steps done → success.
      // The step plan IS the source of truth. No regex goal classification,
      // no _pageCategory checks, no _verifySubmitSuccess. If the plan said
      // "type title, press enter" and both steps executed, the goal is achieved.
      if (!_usingStepFallback && _stepPlan && _stepIndex >= _stepPlan.length && !stepResult.done) {
        const _resultStr = _buildResultString(goal, actionHistory, filledFields);
        logger.info(`[instruction.runner] Tab-Map: all ${_stepPlan.length} steps executed — done. ${_resultStr}`);
        return { ok: true, output: _resultStr, actionHistory };
      }

      if (stepResult.done) {
        // Tab-Map session ended
        inTabMapSession = false;
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;

        if (stepResult.ok && !stepResult.error) {
          // DONE — step plan completed or LLM declared done. No regex
          // verification — the step plan is the source of truth.
          const _resultStr = _buildResultString(goal, actionHistory, filledFields);
          logger.info(`[instruction.runner] Tab-Map: DONE — ${_resultStr}`);
          return { ok: true, output: _resultStr, actionHistory };
        } else if (stepResult.stateChanged) {
          // State changed (e.g., Send clicked, page navigated) — re-decide
          logger.info(`[instruction.runner] Tab-Map: session ended (state changed) — re-deciding`);
          prevUrl = currentUrl;
          // Clear filled fields for new page
          filledFields.length = 0;
          consumedRefs.clear();
          continue; // re-decide
        } else if (!stepResult.ok) {
          // Failed — re-decide
          logger.warn(`[instruction.runner] Tab-Map: session ended (failed: ${stepResult.error}) — re-deciding`);
          prevUrl = currentUrl;
          continue; // re-decide
        }
      }

      // Session continues — no state change
      prevUrl = currentUrl;
      await _sleep(1000);
      continue;
    }

    // 3. Not in Tab-Map session (or state changed) → decision call
    inTabMapSession = false;
    if (stateChanged) {
      // Clear Tab-Map session state on state change
      _cachedTabMap = null;
      _stepPlan = null;
      _stepIndex = 0;
      _usingStepFallback = false;
      filledFields.length = 0;
      consumedRefs.clear();
      _clearLlmCache(sessionId);
      logger.info(`[instruction.runner] State changed (url=${currentUrl !== prevUrl}, overlay=${newOverlayActive !== overlayActive}) — clearing session state`);
    }

    const { _extractValue, _extractSearchText } = require('./browser.agent.cjs');
    // Probe page structure once per iteration (includes fillable types + title + visible text)
    const _probe = await _probePageStructure(sessionId);
    const strategy = await _selectTierLLM(sessionId, goal, actionHistory, _pageCategory, _shortcutCount, focused, currentUrl, _probe, agentContext);
    logger.info(`[instruction.runner] Decision: strategy=${strategy} (0=DONE, 1=Just-type, 2=Meta+F, 3=App Shortcuts, 4=Tab-Map)`);

    // 4. Execute strategy

    if (strategy === 0) {
      // DONE — the LLM decided the goal is achieved. No regex goal
      // classification, no _verifySubmitSuccess. The step plan / LLM
      // decision is the source of truth.
      const _resultStr = _buildResultString(goal, actionHistory, filledFields);
      logger.info(`[instruction.runner] DONE — ${_resultStr}`);
      return { ok: true, output: _resultStr, actionHistory };
    }

    if (strategy === 1) {
      // Just-type
      const value = await _extractValue(goal, focused, actionHistory, agentContext, focused?.currentValue || '');
      const result = await _executeJustType(sessionId, value, focused, _pageCategory);
      const _note = result.ok ? '→ ok' : '→ FAILED';
      actionHistory.push(`Just-type "${value.slice(0, 40)}" ${_note}`);

      if (!result.ok) {
        // Fallback to Tab-Map
        logger.info(`[instruction.runner] Just-type failed (${result.error}) — falling back to Tab-Map`);
        inTabMapSession = true;
        // Build tab-map on next iteration
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        prevUrl = currentUrl;
        continue;
      }

      // Just-type succeeded — check for state change
      const postUrl = await _getUrl(sessionId);
      const _pageChanged = postUrl !== currentUrl;

      if (_pageChanged) {
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        filledFields.length = 0;
        consumedRefs.clear();
      }
      prevUrl = postUrl;
      _doneVerifyFails = 0;
      await _sleep(1500);
      continue;
    }

    if (strategy === 2) {
      // Meta+F
      const searchText = await _extractSearchText(goal, actionHistory);
      const result = await _executeMetaF(sessionId, searchText);
      const _note = result.ok ? '→ found+clicked' : '→ not found';
      actionHistory.push(`Meta+F "${searchText}" ${_note}`);

      if (!result.ok) {
        // Fallback to Tab-Map
        logger.info(`[instruction.runner] Meta+F failed (${result.error}) — falling back to Tab-Map`);
        inTabMapSession = true;
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        prevUrl = currentUrl;
        continue;
      }

      // Meta+F succeeded — page likely changed (clicked an element)
      const postUrl = await _getUrl(sessionId);
      _cachedTabMap = null;
      _stepPlan = null;
      _stepIndex = 0;
      filledFields.length = 0;
      consumedRefs.clear();
      prevUrl = postUrl;
      _doneVerifyFails = 0;
      await _sleep(1500);
      continue;
    }

    if (strategy === 3) {
      // App Shortcuts — press an app-specific keyboard shortcut
      const { _extractShortcut } = require('./browser.agent.cjs');
      const _hostname = (() => { try { return new URL(currentUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
      const shortcutResult = await _extractShortcut(goal, actionHistory, _hostname, agentContext);
      if (!shortcutResult) {
        // No shortcut found — fallback to Tab-Map
        logger.info(`[instruction.runner] Shortcut: no shortcut found — falling back to Tab-Map`);
        inTabMapSession = true;
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        prevUrl = currentUrl;
        continue;
      }
      const result = await _executeShortcut(sessionId, shortcutResult.key);
      const _note = result.ok ? (result.pageChanged ? '→ page changed' : '→ ok') : '→ FAILED';
      actionHistory.push(`Shortcut "${shortcutResult.key}" ${_note}`);

      // Record verification outcome (decays confidence on failure, triggers re-research eventually)
      if (_hostname && shortcutResult.entryId) {
        try {
          const { recordVerification } = require('./lib/appKnowledge.cjs');
          recordVerification(_hostname, shortcutResult.entryId, !!result.ok);
        } catch (_) {}
      }

      if (!result.ok) {
        // Fallback to Tab-Map
        logger.info(`[instruction.runner] Shortcut failed (${result.error}) — falling back to Tab-Map`);
        inTabMapSession = true;
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        prevUrl = currentUrl;
        continue;
      }

      // Shortcut succeeded — check for state change
      const postUrl = await _getUrl(sessionId);
      if (postUrl !== currentUrl) {
        _cachedTabMap = null;
        _stepPlan = null;
        _stepIndex = 0;
        filledFields.length = 0;
        consumedRefs.clear();
      }
      prevUrl = postUrl;
      _doneVerifyFails = 0;
      await _sleep(1000);
      continue;
    }

    if (strategy === 4) {
      // Tab-Map — enter scan session
      inTabMapSession = true;

      // Build tab-map if not cached or cache invalidated
      if (!_cachedTabMap || _cachedTabMapOverlayActive !== overlayActive || _cachedTabMapUrl !== currentUrl) {
        const skipReset = overlayActive;
        logger.info(`[instruction.runner] Tab-Map: building fresh tab-map (overlayActive=${overlayActive})`);
        let tabMap = await buildTabMap(sessionId, 150, { skipReset });

        // Backward scan if forward scan found very few elements in an overlay
        if (overlayActive && tabMap.length < 3) {
          logger.info(`[instruction.runner] Tab-Map: forward scan found only ${tabMap.length} elements — doing backward scan`);
          const backwardMap = await buildTabMap(sessionId, 150, { skipReset: true, backward: true });
          const existingSigs = new Set(tabMap.map(e => _elementSignature(e)));
          for (const el of backwardMap) {
            const sig = _elementSignature(el);
            if (!existingSigs.has(sig)) {
              tabMap.push({ id: tabMap.length + 1, ...el });
              existingSigs.add(sig);
            }
          }
          logger.info(`[instruction.runner] Tab-Map: merged backward scan: ${tabMap.length} total elements`);
        }

        _cachedTabMap = tabMap;
        _cachedTabMapUrl = currentUrl;
        _cachedTabMapOverlayActive = overlayActive;
        _clearLlmCache(sessionId);
        logger.info(`[instruction.runner] Tab-Map: built fresh tab-map (${tabMap.length} elements) — cached for session`);

        // Extract steps from goal + tab-map (one LLM call)
        const { _extractSteps } = require('./browser.agent.cjs');
        _stepPlan = await _extractSteps(goal, currentUrl, _cachedTabMap, _pageCategory, agentContext);
        _stepIndex = 0;

        if (!_stepPlan || _stepPlan.length <= 1) {
          // ≤1 step → fall back to per-step LLM (browse-and-report tasks)
          logger.info(`[instruction.runner] Tab-Map: step extraction returned ${_stepPlan?.length || 0} step(s) — using per-step LLM fallback`);
          _usingStepFallback = true;
        } else {
          _usingStepFallback = false;
          logger.info(`[instruction.runner] Tab-Map: executing ${_stepPlan.length} extracted steps`);
        }
      } else {
        logger.info(`[instruction.runner] Tab-Map: using cached tab-map (${_cachedTabMap.length} elements)`);
      }

      prevUrl = currentUrl;
      _doneVerifyFails = 0;
      continue; // next iteration will run step execution or _tabMapInnerStep
    }

    // Unknown strategy — default to Tab-Map (4)
    logger.warn(`[instruction.runner] Unknown strategy ${strategy} — defaulting to Tab-Map (4)`);
    inTabMapSession = true;
    _cachedTabMap = null;
    _stepPlan = null;
    _stepIndex = 0;
    prevUrl = currentUrl;
  }

  // Timeout reached
  logger.warn(`[instruction.runner] Iterative: timeout after ${actionHistory.length} steps`);
  return { ok: false, error: `Timeout after ${actionHistory.length} steps`, actionHistory };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  runInstructionSkill,
  runIterativeNavigation,
  parseInstructions,
  parseStep,
  // Keyboard helpers (exported for playwright.agent.cjs compatibility)
  _readActiveElement,
  _pressEscape,
  _llmMatchFocusedItem,
  // Three-tier iterative navigation helpers
  _parseAction,
  _executeJustType,
  _executeMetaF,
  _tabMapInnerStep,
};
