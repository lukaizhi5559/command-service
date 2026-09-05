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
 * @param {Object} [state.fillableTypes] — breakdown: { inputCount, textareaCount, contenteditableCount, roleTextboxCount }
 * @param {boolean} [state.hasAutoFocus] — a field is auto-focused?
 * @param {boolean} [state.focused] — is any element focused (not body)?
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
  const fillableTypes = s.fillableTypes || { inputCount: 0, textareaCount: 0, contenteditableCount: 0, roleTextboxCount: 0 };
  const _hasRealFormFields = (Number(fillableTypes.inputCount) + Number(fillableTypes.textareaCount)) > 0;
  const _hasOnlyContenteditable = fillableCount > 0 && !_hasRealFormFields;
  const hasAutoFocus = !!s.hasAutoFocus;
  const focused = !!s.focused;
  const editorState = s.editorState || null;
  const pageCategory = String(s.pageCategory || '');
  const shortcutCount = Number(s.shortcutCount) || 0;
  const shortcutLabels = String(s.shortcutLabels || '');
  const clickableCount = Number(s.clickableCount) || 0;
  const isCreationDeepLinkPre = !!s.isCreationDeepLink;

  // Classify deep link type from URL (or use pre-computed flag)
  const deepLinkType = isCreationDeepLinkPre
    ? 'creation'
    : classifyDeepLinkType(s.currentUrl, pageCategory);

  // Goal text analysis
  const isReadCountListGoal = _isReadCountListGoal(goal);
  const isSpatialGoal = _isSpatialGoal(goal);
  const isExplicitSpatial = _isExplicitSpatial(goal);
  const findClickClass = _classifyFindClickGoal(goal);
  const isFindClickGoal = findClickClass === 'meta-f'; // only clear Meta+F cases fire the pattern
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
    // For spreadsheets, the creation deep link creates the sheet but the title
    // needs to be renamed via the title bar — NOT Just-type into cell A1.
    // Don't fast-path; let the LLM decide (Tab-Map to click title bar).
    if (pageCategory === 'spreadsheet') {
      return _result('creation_deep_link_spreadsheet', 4, false,
        'Spreadsheet created via deep link — title needs renaming via title bar, not cell A1.',
        false, 'LLM decides — use Tab-Map to click title bar and rename', deepLinkType);
    }
    // For docs and other apps, Just-type is correct (title is auto-focused)
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

  // 4.5. Editor with overlay (e.g., Notion "Move to" dialog over editor body)
  // The overlay is NOT a form — it's a navigation/confirmation dialog over the editor.
  // The editor body is the real target. Recommend Just-Type (tier 1).
  // Caller should dismiss the overlay before typing.
  if (overlayActive && _hasOnlyContenteditable && (pageCategory === 'document_editor' || editorState?.region)) {
    return _result('canvas_editing_with_overlay', 1, false,
      `Editor ${editorState?.region ? `body (${editorState.region})` : 'page'} is focused with a non-form overlay open — overlay is likely a navigation dialog, not a form. Dismiss overlay and type into the focused block.`,
      false, 'LLM decides — dismiss overlay if blocking, then type into body', deepLinkType);
  }

  // 4.6. Spreadsheet cell entry — BEFORE form patterns to prevent
  // multi_step_form misclassifying spreadsheets (formula bar + name box
  // count as 8 "fillable" inputs, and aria-expanded menus trigger overlayActive).
  // Spreadsheet cell entry uses Tier 3 (Shortcuts) — Meta+J to focus each cell
  // and type the value. This is more reliable than Tier 6 (ArrowGrid) which
  // depended on _getCurrentCell (unreliable in Google Sheets' canvas-based DOM).
  // NEVER Tab-Map (which scans/clicks elements and types into the formula bar).
  if (pageCategory === 'spreadsheet' && !alertActive && !isLoading) {
    // Use Tier 3 (Shortcuts) for spreadsheet cell entry — Meta+J is a shortcut
    if (hasAutoFocus || focused || shortcutCount > 0) {
      return _result('spreadsheet_cell_entry', 3, true,
        'Spreadsheet cell entry — use Meta+J shortcut to focus and type each cell.',
        true, null, deepLinkType);
    }
    // No shortcuts available — let LLM decide (but still avoid Tab-Map)
    return _result('spreadsheet_no_focus', 3, false,
      'Spreadsheet open, no shortcuts — LLM decides.',
      false, 'LLM decides — need to focus a cell first', deepLinkType);
  }

  // 5-6. Form dialog open / multi-step form (LLM decides)
  // ONLY for REAL form fields (input/textarea), NOT contenteditable editor blocks.
  // Editors with overlays are handled by canvas_editing_with_overlay (pattern 4.5).
  // NOTE: Spreadsheets are handled by pattern 4.6 above — they never reach here.
  if (overlayActive && fillableCount >= 2 && _hasRealFormFields) {
    const multiItem = _isMultiItemGoal(goal);
    if (multiItem) {
      return _result('multi_step_form', 4, false,
        'Multi-step form dialog is open with multiple input/textarea fields to fill.',
        false, 'LLM decides — multi-field form needs Tab-Map or Just-type per field', deepLinkType);
    }
    return _result('form_dialog_open', 4, false,
      'Form dialog is open with multiple input/textarea fields.',
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

  // 8. Find and click text (LLM decides) — hybrid: only clear Meta+F cases fire
  // KEEP !overlayActive gate: Meta+F's window.find() searches the entire page,
  // not just the overlay. Tab-Map is overlay-scoped and safer inside overlays.
  // ADD clickableCount > 5: ensures enough things to click to justify text search.
  // Ambiguous cases ('ambiguous' class) don't fire — let _selectTierLLM decide.
  // UI element types ('tab-map' class) don't fire — let Tab-Map (priority 13) handle.
  if (isFindClickGoal && !overlayActive && clickableCount > 5) {
    return _result('find_and_click_text', 2, false,
      'Goal involves finding a specific named item by text (proper noun detected, no UI element type).',
      false, 'LLM decides — text may be visible or need scrolling', deepLinkType);
  }

  // 9. Shortcut available (LLM decides) — but NOT for editor content goals
  if (!overlayActive && shortcutCount > 0 && shortcutMatches) {
    // Don't recommend shortcuts for editor content goals (typing, not shortcutting)
    const _isEditorContent = /\b(todo\s+(list|items?)|add\s+(?:a\s+)?(?:todo|item|text|note|heading|bullet|callout|paragraph))\b/i.test(goal);
    if (!(_isEditorContent && editorState?.region === 'body')) {
      return _result('shortcut_available', 3, false,
        'An app shortcut matches the goal keywords.',
        false, 'LLM decides — verify shortcut semantically matches the goal', deepLinkType);
    }
  }

  // 10. Canvas editing (LLM decides)
  // Allow even with overlay if the overlay is not a real form (contenteditable-only).
  // Real form overlays are handled by patterns 5-6 above.
  const editorRegion = editorState?.region;
  if (editorRegion && ['body', 'cell', 'code', 'canvas'].includes(editorRegion) && (!overlayActive || _hasOnlyContenteditable)) {
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
  // "move" alone is too broad — "move to page", "move email to folder" are navigation, not drag-drop.
  // Only match "move" with directional words (up/down/left/right/before/after/above/below).
  // "to" is excluded from _isSpatialGoal because "move X to Y" is usually navigation;
  // the LLM can still pick Gesture (tier 5) if the goal is clearly drag-drop.
  // Other verbs (drag/drop/reorder/resize/slide/arrange/scrub) are always spatial.
  const _strongSpatial = /\b(drag|drop|reorder|resize|slide|arrange|scrub)\b/i.test(goal);
  const _moveWithDirection = /\bmove\s+\S+\s+(up|down|left|right|before|after|above|below)\b/i.test(goal);
  return _strongSpatial || _moveWithDirection;
}

function _isExplicitSpatial(goal) {
  // "drag X to Y" — drag with a destination
  // "reorder X by/to/before/after" — reorder with a direction
  // "resize X" — resize is always explicit enough
  // "move X up/down/left/right/to" — move with a direction
  // "slide X to Y" — slide with a destination
  return /\b(drag\s+.+\s+to\b|reorder\s+\S+\s+(by|to|before|after|above|below)\b|resize\s+\S+|move\s+\S+\s+(up|down|left|right|to)\b|slide\s+.+\s+to\b)\b/i.test(goal);
}

// Hybrid find-and-click classifier: determines if Meta+F or Tab-Map is better.
// Returns: 'meta-f' (specific named item → Meta+F), 'tab-map' (UI element → Tab-Map),
//          'ambiguous' (LLM decides), 'none' (not a find-and-click goal)
function _classifyFindClickGoal(goal) {
  if (!goal) return 'none';

  const _findVerbs = /\b(find|click|open|go\s+to|navigate\s+to|show\s+me|look\s+up|view|visit|check|move\s+to|select)\b/i;
  const _contentVerbs = /\b(add|type|create|write|draft|compose|make|fill|name|title|rename|update|edit|change|delete|remove)\b/i;
  const _uiElementTypes = /\b(button|link|dropdown|tab|menu|navigation|nav\s+bar|sidebar|toolbar|checkbox|toggle|switch|icon|option|row|card)\b/i;

  // Content-creation only → not find-and-click
  if (_contentVerbs.test(goal) && !_findVerbs.test(goal)) return 'none';
  // No find-and-click verb → not find-and-click
  if (!_findVerbs.test(goal)) return 'none';

  const hasUiType = _uiElementTypes.test(goal);

  // Check for a specific name: capitalized word that's NOT the first word and NOT a UI type/stop word
  // e.g., "find John Smith" → "John" is a name
  // e.g., "find Wireless Headphones" → "Wireless" is a product name (capitalized)
  const _words = goal.split(/\s+/);
  const _stopWords = new Set(['button','link','dropdown','tab','menu','navigation','nav','sidebar',
    'toolbar','checkbox','toggle','switch','icon','option','row','card','the','a','an',
    'find','click','open','go','to','navigate','show','me','look','up','view','visit',
    'check','move','select','about','for','with','from','in','on','at','of','and','or']);
  const _hasProperNoun = _words.some((w, i) =>
    i > 0 && /^[A-Z][a-z]/.test(w) && !_stopWords.has(w.toLowerCase()));

  if (hasUiType && _hasProperNoun) {
    // Both UI type AND proper noun → Tab-Map (UI type is the dominant signal)
    // e.g., "click the John Smith card" → Tab-Map scans cards and finds "John Smith"
    return 'tab-map';
  }
  if (hasUiType) {
    // UI type, no proper noun → Tab-Map (e.g., "click Sign In button")
    return 'tab-map';
  }
  if (_hasProperNoun) {
    // Proper noun, no UI type → Meta+F (e.g., "find John Smith")
    return 'meta-f';
  }
  // No UI type, no proper noun → ambiguous (e.g., "click Submit", "open settings")
  return 'ambiguous';
}

// Backward-compatible wrapper for tests that import _isFindClickGoal
function _isFindClickGoal(goal) {
  return _classifyFindClickGoal(goal) === 'meta-f';
}

function _isMultiItemGoal(goal) {
  // Editor content goals (todo items, list items, bullets, headings) are NOT
  // multi-form-field goals — they're sequential blocks typed via type-list-item.
  const isEditorContent = /\b(todo\s+(list|items?)|list\s+items?|add\s+(?:a\s+)?(?:todos?|items?|bullets?|headings?|paragraphs?|callouts?))\b/i.test(goal || '');
  if (isEditorContent) return false;
  
  const andCount = (goal.match(/\band\b/gi) || []).length;
  const commaCount = (goal.match(/,/g) || []).length;
  return andCount >= 2 || commaCount >= 2;
}

function _shortcutMatchesGoal(goal, shortcutLabels) {
  if (!shortcutLabels || !goal) return false;
  const goalLower = goal.toLowerCase();
  const lines = shortcutLabels.toLowerCase().split(/\n/);
  const actionVerbs = [];
  // Common nouns that should NOT be matched as action verbs
  const _nouns = new Set([
    'today', 'tomorrow', 'week', 'month', 'year', 'event', 'note', 'item',
    'page', 'day', 'time', 'period', 'view', 'list', 'task', 'todo', 'email',
    'folder', 'file', 'project', 'label', 'tag', 'filter', 'calendar',
  ]);
  // Semantic synonyms: verbs that mean the same thing as shortcut action verbs.
  // This allows "Add event" to match a shortcut labeled "Create event".
  const _synonyms = {
    create: ['create', 'add', 'new', 'make', 'insert', 'start'],
    delete: ['delete', 'remove', 'trash', 'archive', 'discard'],
    edit: ['edit', 'modify', 'change', 'update', 'rename', 'set'],
    find: ['find', 'search', 'look', 'locate'],
    open: ['open', 'view', 'show', 'navigate', 'go'],
    save: ['save', 'submit', 'confirm', 'done', 'send'],
    move: ['move', 'go', 'navigate', 'jump', 'switch'],
    select: ['select', 'choose', 'pick'],
    format: ['format', 'style', 'bold', 'italic', 'underline'],
    insert: ['insert', 'add', 'create', 'new'],
    focus: ['focus', 'jump', 'go', 'navigate'],
  };
  // Build a reverse map: word → synonym group key
  const _wordToGroup = {};
  for (const [group, words] of Object.entries(_synonyms)) {
    for (const w of words) _wordToGroup[w] = group;
  }

  for (const line of lines) {
    // Primary: match "key: action" — extract first word after separator
    const m = line.match(/[:\-]\s*(\w+)/);
    if (m && m[1] && m[1].length > 2 && !_nouns.has(m[1])) {
      actionVerbs.push(m[1]);
      continue;
    }
    // Fallback: extract verb after "to " in "Press X to <verb>"
    const toMatch = line.match(/\bto\s+(\w+)/);
    if (toMatch && toMatch[1] && toMatch[1].length > 2 && !_nouns.has(toMatch[1])) {
      actionVerbs.push(toMatch[1]);
    }
  }
  // Check each action verb against the goal — including semantic synonyms
  return actionVerbs.some(verb => {
    const group = _wordToGroup[verb];
    if (group) {
      // Check all synonyms for this verb's group
      return _synonyms[group].some(syn => goalLower.includes(syn));
    }
    return goalLower.includes(verb);
  });
}

module.exports = {
  classifyStatePattern,
  // Exported for testing
  _isReadCountListGoal,
  _isSpatialGoal,
  _isExplicitSpatial,
  _isFindClickGoal,
  _classifyFindClickGoal,
  _isMultiItemGoal,
  _shortcutMatchesGoal,
};
