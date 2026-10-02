// Shared site-search helpers.
//
// Moved out of browser.agent.cjs so the public web.agent/web.crawl path can
// resolve "search <site> for 'X'" / "show pics of … on <site>" tasks to the
// site's own results page without going through the interactive browser agent.
//
// Consumers:
//   - browser.agent.cjs  (legacy _buildGenericSearchUrl / _extractQuotedSearchTerm)
//   - web.agent.cjs      (new `site_search` action)
//   - executeCommand.js  (deep-page → search-URL rewrite safety net)

const { getSearchUrlPattern } = require('./destination-resolver.cjs');

// ── Generic site-search URL templates ────────────────────────────────────────
// Deterministic results-page URLs for high-traffic search/shopping sites.
// "search <site> for 'X'" tasks land directly on a fresh results page via
// URL-first instead of (a) hitting the keyword cache — which may hold a stale
// query-baked URL — or (b) typing into the site's search box.
const SITE_SEARCH_URL_TEMPLATES = {
  'amazon.com':        'https://www.amazon.com/s?k={query}',
  'ebay.com':          'https://www.ebay.com/sch/i.html?_nkw={query}',
  'etsy.com':          'https://www.etsy.com/search?q={query}',
  'walmart.com':       'https://www.walmart.com/search?q={query}',
  'target.com':        'https://www.target.com/s?searchTerm={query}',
  'bestbuy.com':       'https://www.bestbuy.com/site/searchpage.jsp?st={query}',
  'homedepot.com':     'https://www.homedepot.com/s/{query}',
  'youtube.com':       'https://www.youtube.com/results?search_query={query}',
  'google.com':        'https://www.google.com/search?q={query}',
  'bing.com':          'https://www.bing.com/search?q={query}',
  'duckduckgo.com':    'https://duckduckgo.com/?q={query}',
  'github.com':        'https://github.com/search?q={query}',
  'stackoverflow.com': 'https://stackoverflow.com/search?q={query}',
  'reddit.com':        'https://www.reddit.com/search/?q={query}',
  'yelp.com':          'https://www.yelp.com/search?find_desc={query}',
  'imdb.com':          'https://www.imdb.com/find?q={query}',
  'wikipedia.org':     'https://en.wikipedia.org/wiki/Special:Search?search={query}',
  // Mail services use hash/deeplink search routes (query lives in the fragment,
  // not ?params — see _hasSearchQueryParam in destination-resolver.cjs).
  'mail.google.com':   'https://mail.google.com/mail/u/0/#search/{query}',
  'outlook.live.com':  'https://outlook.live.com/mail/0/deeplink/search?q={query}',
};

// UI button labels are not search queries. Used by _extractQuotedSearchTerm to
// reject "search for 'Add to Cart'" style misfires.
const _UI_LABEL_BLOCKLIST = /^(add\s+to\s+(?:cart|bag|basket|list|wishlist)|buy\s+now|checkout|sign\s+(?:in|up|out)|log\s+(?:in|out)|submit|send|save|delete|remove|cancel|close|confirm|continue|next|back|edit|share|follow|like|subscribe|unsubscribe|post|publish|reply|comment)$/i;

// Extract the quoted search term from a "search ... 'X'" task. The quote pattern
// is boundary-aware: an internal apostrophe followed by a word char (children's)
// is part of the term, not a quote terminator.
//
// SAFETY: The search keyword must appear near the START of the task (first 60 chars).
// This prevents contextual phrases like "search results page" in the middle of a
// click/action task from triggering search-term extraction.
function extractQuotedSearchTerm(task) {
  const t = String(task || '');
  // Anchor: search keyword must be in the first 60 chars of the task
  const _head = t.slice(0, 60);
  if (!/\b(?:search\s+for|search\s+on|look\s*up|shop\s+for|browse\s+for)\b/i.test(_head)) return null;
  const m = t.match(/\b(?:search\s+for|search\s+on|look\s*up|find|shop\s+for|browse\s+for)\b[^'"]*?["']((?:[^'"]+|'(?=\w))+)["']/i);
  if (!m) return null;
  const term = m[1].trim();
  // Reject UI button labels — they are not search queries
  if (_UI_LABEL_BLOCKLIST.test(term)) return null;
  return term;
}

/**
 * Extract an unquoted query from "search (my|the)? <service> for X" phrasing —
 * e.g. "search my gmail for vidangel emails" → "vidangel". Unlike
 * extractQuotedSearchTerm, the term does not need quotes, but the task MUST
 * name one of the provided service names (word-boundary match) — this keeps
 * generic prose ("the email I searched for on my phone") from misfiring while
 * letting service-targeted searches resolve deterministically.
 *
 * @param {string} task           - The task text.
 * @param {string|string[]} serviceNames - Service key(s)/host label(s) that must
 *                                          appear in the task (e.g. ['gmail','mail']).
 * Returns the extracted query, or null.
 */
function extractServiceSearchTerm(task, serviceNames) {
  const t = String(task || '').trim();
  if (!t) return null;
  const names = (Array.isArray(serviceNames) ? serviceNames : [serviceNames])
    .map(n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  if (!names.length) return null;
  const named = names.some(n => new RegExp(`\\b${n}\\b`, 'i').test(t));
  if (!named) return null;
  const m = t.match(/\b(?:search|find|look\s*up|look\s+for|browse|check|scan|read)\b[^.?!]{0,60}?\bfor\s+(.+?)\s*[?.!]*$/i);
  if (!m) return null;
  // Drop a trailing bare container noun — "vidangel emails" → "vidangel".
  let q = m[1].trim().replace(/\s+(?:emails?|messages?|mails?|threads?|posts?|items?|results?|products?)$/i, '');
  // Pipeline-injected wrappers ("(Context from prior turn: X)", "(Resolved
  // referent — X)") can leak a closing paren into the capture — and
  // encodeURIComponent leaves ) ] } ' " literal in the URL. Strip trailing
  // closers only when they're unbalanced (legit "(foo OR bar)" is kept), plus
  // wrapping quotes.
  const _CLOSERS = { ')': '(', ']': '[', '}': '{' };
  let _prev;
  do {
    _prev = q;
    while (q.length > 1) {
      const _c = q.slice(-1), _o = _CLOSERS[_c];
      if (!_o) break;
      if ((q.split(_c).length - 1) <= (q.split(_o).length - 1)) break;
      q = q.slice(0, -1).trimEnd();
    }
    q = q.replace(/^["']+|["']+$/g, '').trim();
  } while (q !== _prev && q.length);
  if (!q || _UI_LABEL_BLOCKLIST.test(q)) return null;
  return q;
}

/**
 * Resolve a host/domain to its static site-search URL template, if any.
 * Matches exact host, then suffix (e.g. "smile.amazon.com" → amazon.com template).
 * Returns the template string (with {query}) or null.
 */
function lookupSiteSearchTemplate(hostOrDomain) {
  const host = String(hostOrDomain || '').replace(/^www\./, '').toLowerCase();
  if (!host) return null;
  if (SITE_SEARCH_URL_TEMPLATES[host]) return SITE_SEARCH_URL_TEMPLATES[host];
  const suffixMatch = Object.entries(SITE_SEARCH_URL_TEMPLATES).find(([d]) => host.endsWith('.' + d));
  return suffixMatch ? suffixMatch[1] : null;
}

/**
 * Build a deterministic site-search URL for a (domain, query) pair.
 *
 * Resolution order:
 *   1. Static SITE_SEARCH_URL_TEMPLATES (exact host, then suffix match).
 *   2. Learned search-pattern cache (destination-resolver.getSearchUrlPattern).
 *
 * Returns the URL string, or null if no template is known for the domain.
 *
 * Note: unlike browser.agent._buildGenericSearchUrl, this does NOT extract the
 * query from a task string — callers pass the already-extracted query. This
 * keeps the helper pure and reusable from web.agent's `site_search` action
 * (which receives { domain, query } directly) and from executeCommand's
 * deep-page rewrite (which strips the site name out of the user message).
 */
async function buildSiteSearchUrl(domain, query, options = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  // Defense-in-depth: reject UI button labels even if a caller passes one.
  if (_UI_LABEL_BLOCKLIST.test(q)) return null;

  const tmpl = lookupSiteSearchTemplate(domain);
  if (tmpl) return tmpl.replace('{query}', encodeURIComponent(q));

  // Fallback: a previously discovered {query} pattern for this service.
  const serviceKey = String(domain || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (serviceKey) {
    try {
      const pat = await getSearchUrlPattern(serviceKey);
      if (pat && pat.urlTemplate && pat.urlTemplate.includes('{query}')) {
        return pat.urlTemplate.replace('{query}', encodeURIComponent(q));
      }
    } catch (_) { /* non-fatal */ }
  }
  return null;
}

/**
 * Heuristic: does this user message describe a listing/search/shopping task
 * that should produce structured item cards rather than a prose summary?
 *
 * Used by executeCommand to auto-inject `extractItems: true` on web.crawl steps
 * and to gate the deep-page → site-search-URL rewrite.
 */
const _LISTING_TASK_RE = /\b(show|see|display|browse|list|look[\s_-]?up|search(?:\s+for|\s+on)?|find|shop(?:ping)?|buy|for\s+sale|prices?|deals?|items?|products?|pics?|pictures?|images?|photos?|videos?|clips?)\b/i;
function isListingTask(taskText) {
  return _LISTING_TASK_RE.test(String(taskText || ''));
}

/**
 * Heuristic: does this URL look like a site's search/results page?
 * Matches common search-path patterns across retailers/forums/search engines.
 */
const _SEARCH_URL_RE = /(?:[?&](?:q|k|query|searchTerm|search_query|_nkw|st|find_desc|search)=|\/s[?\/]|\/search(?:[\/?]|\.jsp)|\/results|sch\/i\.html|\/find\b)/i;
function isSearchResultsUrl(url) {
  return _SEARCH_URL_RE.test(String(url || ''));
}

/**
 * Heuristic: does this URL look like a deep item/product page?
 * Used by executeCommand to decide whether to rewrite to a site-search URL.
 */
const _DEEP_ITEM_URL_RE = /\/(?:dp|gp\/product|item|itm|product|p|listing|watch|video|view)\b/i;
function isDeepItemUrl(url) {
  return _DEEP_ITEM_URL_RE.test(String(url || ''));
}

module.exports = {
  SITE_SEARCH_URL_TEMPLATES,
  UI_LABEL_BLOCKLIST: _UI_LABEL_BLOCKLIST,
  extractQuotedSearchTerm,
  extractServiceSearchTerm,
  lookupSiteSearchTemplate,
  buildSiteSearchUrl,
  isListingTask,
  isSearchResultsUrl,
  isDeepItemUrl,
};
