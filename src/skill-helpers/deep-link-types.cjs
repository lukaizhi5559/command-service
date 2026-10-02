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

  // 1. Creation: *.new shortcut domains (notion.new, docs.new, sheets.new),
  //    paths containing /new, /create — entity already created and open.
  //    (Google Calendar /eventedit and ?action=TEMPLATE are NOT creation: they
  //    open an UNSAVED event form — classified compose below.)
  if (host.endsWith('.new') || host === 'new') return 'creation';
  if (/\/(new|create)(\/|$|\?|#)/i.test(path)) return 'creation';

  // 2. Compose: #compose=new, #inbox?compose=new, /compose, share intents
  //    (twitter.com/intent/tweet, linkedin.com/shareArticle, /sharebox) —
  //    Check BEFORE search because compose URLs may contain query-like patterns.
  //    Gmail uses #inbox?compose=new (compose param inside the hash fragment)
  if (/(#compose=new|#compose\b|compose=new|\/compose\b)/i.test(fullUrl)) return 'compose';
  //    Calendar event forms — /eventedit, /event/new, ?action=TEMPLATE all open
  //    an unsaved form to fill, not a created entity.
  if (/[?&]action=TEMPLATE\b/i.test(search)) return 'compose';
  if (/\/(eventedit|event\/new)(\/|$|\?|#)/i.test(path)) return 'compose';
  //    Also covers feed-level share activators: linkedin.com/feed/?shareActive=true,
  //    ?shareActive, composer-modal params — the modal mounts lazily after load.
  if (/(intent\/(tweet|share|whatsapp)|sharebox|shareArticle|sharing\/share-offsite|deeplink=compose|shareActive\b|[?&]composer\b|composeModal)/i.test(fullUrl)) return 'compose';

  // 3. Search: #search/, ?q=, ?filter=, &filter=, is:unread, from:, etc.
  //    Covers Gmail hash-search, generic query params, filter operators, and
  //    common results-page URL shapes (amazon /s?k=, youtube /results?search_query=,
  //    github/reddit /search?q=, ebay /sch/?_nkw=).
  if (/(#search\/|\?q=|&q=|#query=|\?filter=|&filter=|#filter\b|is:unread|is:starred|is:read|from:|to:|subject:|label:|in:|has:)/i.test(fullUrl)) {
    return 'search';
  }
  if (/[?&](k|query|search_query|term|_nkw|find_desc)=/i.test(search)) return 'search';
  if (/\/(search|results|sch)(\/|$|\?|#)/i.test(path)) return 'search';

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

  // 6. Generic overlay-intent heuristic — param KEY names that imply a
  //    compose/share/modal UI auto-opens on load. Key-based, not value-based
  //    (values vary wildly per site): linkedin ?shareActive=true, reddit
  //    ?submit=true, ?composer, ?new=post, ?draft=, ?modal=share... A false
  //    positive only costs a short overlay poll — a false negative is the
  //    "modal never awaited" bug, so over-trigger is intentional.
  if (_urlHasOverlayParamKey(u)) return 'compose';

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

// URL markers that auto-open transient UI (dialogs, modals, compose panels,
// share boxes, wizards). Used by deepLinkOpensOverlay — keep word-boundary
// guarded so terms like "news" don't false-positive.
const OVERLAY_URL_RE = /(compose|dialog|modal|popup|wizard|eventedit|action=TEMPLATE|intent\/|sharebox|shareArticle|[?&#](new|create|draft|compose|edit)=|#new\b|\/new\b)/i;

/**
 * Whether navigating to this URL is expected to leave a transient overlay
 * (dialog/compose panel/share box) open on screen. When true, downstream
 * agents must NOT reset focus (Escape + top-left click would dismiss it).
 * @param {string} url — the landed URL
 * @param {string} [deepLinkType] — optional pre-classified type
 * @returns {boolean}
 */
function deepLinkOpensOverlay(url, deepLinkType) {
  const type = deepLinkType || classifyDeepLinkType(url);
  if (type === 'compose') return true;
  // 'creation' is not blanket-true: a landed entity page (docs
  // /document/d/<id>/edit, notion page, etc.) IS the destination — no dialog
  // is expected, and suppressing focus-reset leaves the body autofocused.
  // Only URLs still carrying a creation/dialog marker (/new, eventedit,
  // ?action=TEMPLATE, overlay param keys) imply a dialog may be mounted.
  const u = url ? _safeUrl(url) : null;
  if (u && _urlHasOverlayParamKey(u)) return true;
  return url ? OVERLAY_URL_RE.test(url) : false;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

// Param keys (query OR hash-embedded) that imply transient UI auto-opens.
const OVERLAY_PARAM_KEY_RE = /^(?:composer?|compose|share(?:active)?|post|tweet|toot|modal|dialog|dialogopen|draft|reply(?:to)?|comment|edit(?:or)?|publish|write|new|create|submit|quickpost|story|message|send|openform|form)$/i;

function _urlHasOverlayParamKey(u) {
  // u.search for query params; hash may embed a ?query (Gmail #inbox?compose=new)
  // or be a bare flag (#compose). URLSearchParams tolerates bare keys too.
  for (const src of [u.search || '', (u.hash || '')]) {
    const q = src.includes('?') ? src.slice(src.indexOf('?')) : src;
    try {
      for (const k of new URLSearchParams(q).keys()) {
        if (OVERLAY_PARAM_KEY_RE.test(k.replace(/^[#?]/, ''))) return true;
      }
    } catch (_) {}
  }
  return false;
}

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
  deepLinkOpensOverlay,
};
