'use strict';

/**
 * state-patterns.cjs — Classify page state into a named universal pattern.
 *
 * Deterministic, fast, universal — works for ANY web app.
 * Combines raw signals (overlay, alert, fillable, editor state, goal text,
 * deep link type, shortcuts) into a named state pattern with a recommended
 * tier and fast-path flag.
 *
 * CRITICAL: fastPath=true ONLY when all guard conditions pass.
 * If ANY conflicting signal is present, fastPath=false and the LLM
 * makes the call with the pattern as context.
 *
 * State patterns (priority-ordered, highest first):
 *   1. alert_confirmation       → Alert handler (always fast-path)
 *   2. loading_state            → Wait (always fast-path)
 *   3. creation_deep_link       → Just-type (fast-path if no overlay/alert + fillable≥1)
 *   4. search_deep_link_read    → DONE (fast-path if read-only goal + no overlay)
 *   5. form_dialog_open         → Tab-Map (LLM decides)
 *   6. multi_step_form          → Tab-Map (LLM decides)
 *   7. spatial_interaction      → Gesture (fast-path if explicit + no overlay)
 *   8. find_and_click_text      → Meta+F (LLM decides)
 *   9. shortcut_available       → Shortcut (LLM decides)
 *  10. canvas_editing           → Just-type (LLM decides)
 *  11. single_field_focused     → Just-type (fast-path only for ai_chat)
 *  12. list_browse              → Tab-Map or DONE (LLM decides)
 *  13. no_focus_need_click      → Tab-Map (LLM decides)
 */

const { classifyDeepLinkType } = require('./deep-link-types.cjs');

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify the current page state into a named pattern.
 *
 * @param {Object} state — raw state signals
 * @param {string} state.goal — the user's task/goal text
 * @param {string} [state.currentUrl] — current page URL
 * @param {string} [state.pageCategory] — inferred page category
 * @param {boolean} [state.isCreationDeepLink] — pre-computed creation deep-link flag
 * @param {boolean} [state.overlayActive] — dialog/menu/listbox open?
 * @param {boolean} [state.alertActive] — confirmation/error alert blocking?
 * @param {boolean} [state.isLoading] — page is loading (spinner detected)?
 * @param {number} [state.fillableCount] — count of fillable elements
 * @param {boolean} [state.hasAutoFocus] — a field is auto-focused?
 * @param {Object} [state.editorState] — { region, blockIndex, blockType, ... }
 * @param {number} [state.shortcutCount] — count of available shortcuts
 * @param {string} [state.shortcutLabels] — shortcut label text
 * @param {string[]} [state.actionHistory] — what's been done so far
 * @returns {{ pattern: string, tier: number|null, fastPath: boolean, description: string, guardsPassed: boolean, guardReason: string|null, deepLinkType: string }}
 */
function classifyStatePattern(state) {
  const s = state || {};
  const goal = String(s.goal || '');
  const overlayActive = !!s.overlayActive;
  const alertActive = !!s.alertActive;
  const isLoading = !!s.isLoading;
  const fillableCount = Number(s.fillableCount) || 0;
  const hasAutoFocus = !!s.hasAutoFocus;
  const editorState = s.editorState || null;
  const pageCategory = String(s.pageCategory || '');
  const shortcutCount = Number(s.shortcutCount) || 0;
  const shortcutLabels = String(s.shortcutLabels || '');
  const isCreationDeepLinkPre = !!s.isCreationDeepLink;

  // Classify deep link type from URL (or use pre-computed flag)
  const deepLinkType = isCreationDeepLinkPre
    ? 'creation'
    : classifyDeepLinkType(s.currentUrl, pageCategory);

  // Goal text analysis
  const isReadCountListGoal = _isReadCountListGoal(goal);
  const isSpatialGoal = _isSpatialGoal(goal);
  const isExplicitSpatial = _isExplicitSpatial(goal);
  const isFindClickGoal = _isFindClickGoal(goal);
  const shortcutMatches = _shortcutMatchesGoal(goal, shortcutLabels);

  // ── Priority-ordered pattern matching ────────────────────────────────

  // 1. Alert confirmation (always wins, always fast-path)
  if (alertActive) {
    return _result('alert_confirmation', null, true,
      'A confirmation/error alert is blocking the page — handle it first.',
      true, null, deepLinkType);
  }

  // 2. Loading state (always wins, always fast-path)
  if (isLoading) {
    return _result('loading_state', null, true,
      'Page is loading — wait before acting.',
      true, null, deepLinkType);
  }

  // 3. Creation deep link (fast-path if guards pass)
  if (deepLinkType === 'creation') {
    const guardsPassed = !overlayActive && !alertActive && fillableCount >= 1;
    const guardReason = guardsPassed ? null : _guardReason({
      overlay: overlayActive, alert: alertActive, noFillable: fillableCount < 1,
    });
    return _result('creation_deep_link', 1, guardsPassed,
      'Creation deep-link — entity already created, just type into the focused field.',
      guardsPassed, guardReason, deepLinkType);
  }

  // 4. Search deep link + read-only goal (fast-path if guards pass)
  if (deepLinkType === 'search' && isReadCountListGoal) {
    const guardsPassed = !overlayActive && !alertActive;
    const guardReason = guardsPassed ? null : _guardReason({ overlay: overlayActive, alert: alertActive });
    return _result('search_deep_link_read', 0, guardsPassed,
      'Search results already loaded — read them directly.',
      guardsPassed, guardReason, deepLinkType);
  }

  // 5-6. Form dialog open / multi-step form (LLM decides)
  if (overlayActive && fillableCount >= 2) {
    const multiItem = _isMultiItemGoal(goal);
    if (multiItem) {
      return _result('multi_step_form', 4, false,
        'Multi-step form dialog is open with multiple fields to fill.',
        false, 'LLM decides — multi-field form needs Tab-Map or Just-type per field', deepLinkType);
    }
    return _result('form_dialog_open', 4, false,
      'Form dialog is open with multiple fields.',
      false, 'LLM decides — form may need Tab-Map or Just-type for current field', deepLinkType);
  }

  // 7. Spatial interaction (fast-path if explicit + guards)
  if (isSpatialGoal) {
    const guardsPassed = isExplicitSpatial && !overlayActive && !alertActive;
    const guardReason = guardsPassed ? null : _guardReason({
      notExplicit: !isExplicitSpatial, overlay: overlayActive, alert: alertActive,
    });
    return _result('spatial_interaction', 5, guardsPassed,
      'Goal involves drag-drop, reordering, or resizing.',
      guardsPassed, guardReason, deepLinkType);
  }

  // 8. Find and click text (LLM decides)
  if (isFindClickGoal && !overlayActive) {
    return _result('find_and_click_text', 2, false,
      'Goal mentions finding and clicking a specific element.',
      false, 'LLM decides — text may be visible or need scrolling', deepLinkType);
  }

  // 9. Shortcut available (LLM decides)
  if (!overlayActive && shortcutCount > 0 && shortcutMatches) {
    return _result('shortcut_available', 3, false,
      'An app shortcut matches the goal keywords.',
      false, 'LLM decides — verify shortcut semantically matches the goal', deepLinkType);
  }

  // 10. Canvas editing (LLM decides)
  const editorRegion = editorState?.region;
  if (editorRegion && ['body', 'cell', 'code', 'canvas'].includes(editorRegion) && !overlayActive) {
    return _result('canvas_editing', 1, false,
      `Focus is in ${editorRegion} region (block ${editorState.blockIndex ?? '?'}) — type into the focused block.`,
      false, 'LLM decides — verify region matches goal before typing', deepLinkType);
  }

  // 11. Single field focused (fast-path only for ai_chat)
  if ((fillableCount === 1 || hasAutoFocus) && !overlayActive) {
    const guardsPassed = pageCategory === 'ai_chat' && fillableCount === 1 && !alertActive;
    const guardReason = guardsPassed ? null : `Not fast-path: category=${pageCategory || 'none'} (ai_chat only), fillable=${fillableCount}`;
    return _result('single_field_focused', 1, guardsPassed,
      'A single field is focused — type into it.',
      guardsPassed, guardReason, deepLinkType);
  }

  // 12. List browse (LLM decides)
  if (isReadCountListGoal && !overlayActive && fillableCount === 0) {
    return _result('list_browse', null, false,
      'Read/count/list goal with no form open — read the page content.',
      false, 'LLM decides — content may be visible or need scrolling', deepLinkType);
  }

  // 13. Fallback — no focus, need to find something
  return _result('no_focus_need_click', 4, false,
    'No focused field and no overlay — need to find and click something.',
    false, 'LLM decides — Tab-Map to find clickable elements', deepLinkType);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function _result(pattern, tier, fastPath, description, guardsPassed, guardReason, deepLinkType) {
  return { pattern, tier, fastPath, description, guardsPassed, guardReason: guardReason || null, deepLinkType };
}

function _guardReason(reasons) {
  const parts = [];
  if (reasons.notExplicit) parts.push('not explicit spatial');
  if (reasons.overlay) parts.push('overlay present');
  if (reasons.alert) parts.push('alert present');
  if (reasons.noFillable) parts.push('no fillable fields');
  return parts.length > 0 ? `Blocked by: ${parts.join(', ')}` : null;
}

function _isReadCountListGoal(goal) {
  return /\b(read|count|list|how many|show me|find all|list all|get all)\b/i.test(goal);
}

function _isSpatialGoal(goal) {
  return /\b(drag|drop|reorder|resize|move|slide|arrange|scrub)\b/i.test(goal);
}

function _isExplicitSpatial(goal) {
  // "drag X to Y" — drag with a destination
  // "reorder X by/to/before/after" — reorder with a direction
  // "resize X" — resize is always explicit enough
  // "move X up/down/left/right/to" — move with a direction
  // "slide X to Y" — slide with a destination
  return /\b(drag\s+.+\s+to\b|reorder\s+\S+\s+(by|to|before|after|above|below)\b|resize\s+\S+|move\s+\S+\s+(up|down|left|right|to)\b|slide\s+.+\s+to\b)\b/i.test(goal);
}

function _isFindClickGoal(goal) {
  return /\b(find|click|open|select)\b.*\b(button|link|tab|menu|item|icon|option|card|row|entry)\b/i.test(goal);
}

function _isMultiItemGoal(goal) {
  // "fill title and date and location" or "fill title, date, location"
  const andCount = (goal.match(/\band\b/gi) || []).length;
  const commaCount = (goal.match(/,/g) || []).length;
  return andCount >= 2 || commaCount >= 2;
}

function _shortcutMatchesGoal(goal, shortcutLabels) {
  if (!shortcutLabels || !goal) return false;
  const goalLower = goal.toLowerCase();
  // Extract action verbs from shortcut labels.
  // Labels are formatted as "key: action description" (e.g. "c: create event")
  // We extract the action verb (word after the colon) to match against the goal.
  const lines = shortcutLabels.toLowerCase().split(/\n/);
  const actionVerbs = [];
  for (const line of lines) {
    // Match "key: action" or "key - action" or "key action"
    const m = line.match(/[:\-]\s*(\w+)/);
    if (m && m[1] && m[1].length > 2) {
      actionVerbs.push(m[1]);
    } else {
      // Fallback: take the longest word in the line (likely the action verb)
      const words = line.trim().split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) actionVerbs.push(words.sort((a, b) => b.length - a.length)[0]);
    }
  }
  return actionVerbs.some(verb => goalLower.includes(verb));
}

module.exports = {
  classifyStatePattern,
  // Exported for testing
  _isReadCountListGoal,
  _isSpatialGoal,
  _isExplicitSpatial,
  _isFindClickGoal,
  _isMultiItemGoal,
  _shortcutMatchesGoal,
};
