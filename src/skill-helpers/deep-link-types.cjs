'use strict';

/**
 * deep-link-types.cjs — Classify a URL into a deep link type.
 *
 * Deterministic, URL-pattern-based. No app-specific hardcoding.
 * Used by state-patterns.cjs and _selectTierLLM to provide context
 * about what the navigation URL has ALREADY done (created an entity,
 * executed a search, opened a compose form, etc.).
 *
 * Deep link types:
 *   creation   — *.new, /new, /create → entity already created, just type
 *   search     — #search/, ?q=, &filter=, is:unread → results loaded, just read
 *   compose    — #compose=new, /compose → compose form open, fill fields
 *   navigation — /settings, /dashboard, /calendar → section loaded, interact
 *   read       — /docs/, /page/, /view/ → content loaded, just read
 *   none       — generic URL, no deep link type
 */

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Classify a URL into a deep link type.
 * @param {string} url — the URL to classify
 * @param {string} [pageCategory] — optional page category for disambiguation
 * @returns {'creation'|'search'|'compose'|'navigation'|'read'|'none'}
 */
function classifyDeepLinkType(url, pageCategory) {
  if (!url) return 'none';
  const u = _safeUrl(url);
  if (!u) return 'none';

  const host = u.hostname.replace(/^www\./, '');
  const path = u.pathname || '/';
  const hash = u.hash || '';
  const search = u.search || '';
  const fullUrl = url; // for hash-embedded query patterns

  // 1. Creation: *.new shortcut domains (notion.new, docs.new, sheets.new)
  //    or paths containing /new, /create (word-boundary guarded)
  if (host.endsWith('.new') || host === 'new') return 'creation';
  if (/\/(new|create)(\/|$|\?|#)/i.test(path)) return 'creation';

  // 2. Compose: #compose=new, #inbox?compose=new, /compose (email-specific)
  //    Check BEFORE search because compose URLs may contain query-like patterns.
  //    Gmail uses #inbox?compose=new (compose param inside the hash fragment)
  if (/(#compose=new|#compose\b|compose=new|\/compose\b)/i.test(fullUrl)) return 'compose';

  // 3. Search: #search/, ?q=, ?filter=, &filter=, is:unread, from:, etc.
  //    Covers Gmail hash-search, generic query params, and filter operators
  if (/(#search\/|\?q=|&q=|#query=|\?filter=|&filter=|#filter\b|is:unread|is:starred|is:read|from:|to:|subject:|label:|in:|has:)/i.test(fullUrl)) {
    return 'search';
  }

  // 4. Navigation: /settings, /dashboard, /calendar, /inbox, /admin, etc.
  //    These are section navigations — the page needs interaction, not just reading
  if (/\/(settings|dashboard|calendar|inbox|admin|account|profile|notifications|contacts|preferences)(\/|$|\?|#)/i.test(path)) {
    return 'navigation';
  }

  // 5. Read: /docs/, /page/, /view/, /help/, /guide/, /tutorial/
  //    Content is loaded — just read it
  if (/\/(docs|documentation|page|view|help|guide|tutorial|article|post|blog)(\/|$|\?|#)/i.test(path)) {
    return 'read';
  }

  return 'none';
}

/**
 * Get a human-readable description of what the deep link type means.
 * Used to inject context into the LLM prompt in _selectTierLLM.
 * @param {string} type — deep link type from classifyDeepLinkType
 * @returns {string}
 */
function getDeepLinkDescription(type) {
  const descriptions = {
    creation: 'The entity has ALREADY been created by navigating to this URL. Do NOT create another one — do NOT press New/Create buttons or shortcuts (Ctrl+N, Cmd+N). The entity is ready for input — begin typing into the focused field, or click the appropriate field first if focus is not yet in an editor.',
    search: 'The search has ALREADY been executed by navigating to this URL. The search results are loaded — read them directly, do NOT re-run the search or navigate to a search page.',
    compose: 'The compose window is ALREADY open. Fill in the fields (recipient, subject, body) directly — do NOT open another compose window or press compose shortcuts.',
    navigation: 'You have been navigated to a specific section of the app. Interact with what is on this page — do NOT navigate away unless the task requires it.',
    read: 'The content is ALREADY loaded. Read it directly — do NOT navigate further or click through to other pages unless the task requires it.',
    none: 'No deep link type detected — this is a generic URL. Navigate and interact as needed.',
  };
  return descriptions[type] || descriptions.none;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function _safeUrl(url) {
  try {
    return new URL(String(url));
  } catch (_) {
    return null;
  }
}

module.exports = {
  classifyDeepLinkType,
  getDeepLinkDescription,
};
