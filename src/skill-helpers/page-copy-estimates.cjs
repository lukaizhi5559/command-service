'use strict';

/**
 * page-copy-estimates.cjs — URL-category load estimates + page-copy cache.
 *
 * Backs the real-browser scan lane in app.agent (`scan_page` / `navigate_url`).
 * Since a real browser has no DOM handle, we verify "the page actually loaded"
 * by checking the copied text length against a per-category floor, and wait
 * `settleMs` between retries.
 *
 * Copies are persisted under ~/.thinkdrop/copies/ with an index.json keyed by
 * normalized URL so follow-up questions within the TTL skip the clipboard
 * churn entirely.
 *
 * Consumers:
 *   - app.agent.cjs  (actionScanPage, actionNavigateUrl)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger.cjs');

// ─── Category estimates ──────────────────────────────────────────────────────

const CATEGORY_ESTIMATES = {
  search_engine:  { minChars: 800,  settleMs: 1500 },
  shopping:       { minChars: 2000, settleMs: 2500 },
  media_player:   { minChars: 1200, settleMs: 2500 },
  social_feed:    { minChars: 1200, settleMs: 2500 },
  email_compose:  { minChars: 800,  settleMs: 2500 },
  document_editor:{ minChars: 600,  settleMs: 2500 },
  news_content:   { minChars: 1200, settleMs: 2000 },
  web_generic:    { minChars: 300,  settleMs: 1500 },
};

// Host (suffix-matched, www stripped) → category.
const HOST_CATEGORIES = {
  'google.com':        'search_engine',
  'bing.com':          'search_engine',
  'duckduckgo.com':    'search_engine',
  'yahoo.com':         'search_engine',
  'baidu.com':         'search_engine',
  'amazon.com':        'shopping',
  'ebay.com':          'shopping',
  'etsy.com':          'shopping',
  'walmart.com':       'shopping',
  'target.com':        'shopping',
  'bestbuy.com':       'shopping',
  'homedepot.com':     'shopping',
  'aliexpress.com':    'shopping',
  'costco.com':        'shopping',
  'youtube.com':       'media_player',
  'spotify.com':       'media_player',
  'netflix.com':       'media_player',
  'soundcloud.com':    'media_player',
  'twitch.tv':         'media_player',
  'twitter.com':       'social_feed',
  'x.com':             'social_feed',
  'facebook.com':      'social_feed',
  'instagram.com':     'social_feed',
  'linkedin.com':      'social_feed',
  'reddit.com':        'social_feed',
  'tiktok.com':        'social_feed',
  'gmail.com':         'email_compose',
  'mail.google.com':   'email_compose',
  'outlook.com':       'email_compose',
  'outlook.live.com':  'email_compose',
  'protonmail.com':    'email_compose',
  'mail.proton.me':    'email_compose',
  'notion.so':         'document_editor',
  'docs.google.com':   'document_editor',
  'cnn.com':           'news_content',
  'bbc.com':           'news_content',
  'bbc.co.uk':         'news_content',
  'nytimes.com':       'news_content',
  'medium.com':        'news_content',
  'substack.com':      'news_content',
};

// Below this length the copy almost certainly failed (empty selection, page
// still on about:blank, keystrokes went nowhere) regardless of category.
const ABSOLUTE_MIN_CHARS = 80;

// Bot-wall signatures in copied page text.
const BOT_WALL_RE = /\b(verify you are human|verify you'?re human|are you a robot|unusual traffic|cf-chl|cloudflare.{0,30}(?:verify|challenge|ray id)|captcha|please complete the security check|access to this page has been denied|pardon our interruption|press & hold|bot detection|ddos protection by)\b/i;

// Error-page signatures — 404/soft-404 pages, empty-result pages. Error pages
// usually announce early (title/heading), but soft-404s wrapped in site chrome
// bury the marker — so a marker anywhere counts when the page is thin.
const ERROR_PAGE_RE = /\b(404\b.{0,20}(?:not found|error)|page (?:not|couldn'?t be) found|no results found|result(?:s)? not found|this page (?:doesn'?t|does not|could not be) (?:exist|found)|the page you (?:requested|are looking for)|we can'?t find (?:that|this|the) page|oops.{0,20}(?:not found|went wrong)|error 404)\b/i;
const ERROR_PAGE_LEAD_CHARS = 800;   // marker near the top = error page regardless of size
const ERROR_PAGE_MAX_CHARS = 4000;   // buried marker only counts on thin pages

// Login-wall signatures — page demands a session before showing content. The
// HTTP fetch tier carries no cookies, so these must escalate to the real
// browser tier which shares the user's logged-in session.
const LOGIN_WALL_RE = /\b(sign in to continue|log in to (?:continue|view|read|see)|you must (?:be )?log(?:ged)? ?in|please (?:sign|log) ?in to|create an account to|sign in to (?:read|view|see)|members? only|subscribe to (?:read|view|continue)|this content is (?:only )?(?:available|for) (?:to )?(?:subscribers|members))\b/i;
const LOGIN_WALL_LEAD_CHARS = 2000;  // login gates usually lead; "subscribe to read" deeper in text is still a wall for full content

/**
 * Copied/fetched text looks like an error page (404, not-found, empty results).
 * Marker in the lead OR thin page with a buried marker.
 */
function isErrorPage(text) {
  const s = String(text || '');
  if (!s) return false;
  const m = ERROR_PAGE_RE.exec(s);
  if (!m) return false;
  return m.index < ERROR_PAGE_LEAD_CHARS || s.length < ERROR_PAGE_MAX_CHARS;
}

/**
 * Copied/fetched text is gated behind a login/subscription wall. Matched only
 * in the lead — a real article mentioning "log in" deep in the body is content.
 */
function isLoginWall(text) {
  const s = String(text || '');
  if (!s) return false;
  const m = LOGIN_WALL_RE.exec(s);
  return !!m && m.index < LOGIN_WALL_LEAD_CHARS;
}

/**
 * Hostname → page category. Exact match first, then suffix match
 * (smile.amazon.com → amazon.com).
 */
function categorizeUrl(url) {
  const host = _hostOf(url);
  if (!host) return null;
  if (HOST_CATEGORIES[host]) return HOST_CATEGORIES[host];
  const suffix = Object.entries(HOST_CATEGORIES).find(([d]) => host.endsWith('.' + d));
  return suffix ? suffix[1] : null;
}

/**
 * URL → { category, minChars, settleMs } for load verification.
 * Falls back to web_generic estimates for unknown hosts / non-URLs.
 */
function estimateForUrl(url) {
  const category = categorizeUrl(url) || 'web_generic';
  const est = CATEGORY_ESTIMATES[category] || CATEGORY_ESTIMATES.web_generic;
  return { category, minChars: est.minChars, settleMs: est.settleMs };
}

// Bot walls are thin interstitials (~hundreds of chars of challenge text).
// A marker word inside a large document — e.g. a StackOverflow results page
// whose question titles mention "captcha" — is content, not a wall. Gate the
// check on thin content so real pages can't false-positive.
const BOT_WALL_MAX_CHARS = 8000;

function isBotWall(text) {
  const s = String(text || '');
  if (s.length > BOT_WALL_MAX_CHARS) return false;
  return BOT_WALL_RE.test(s);
}

// ─── Copies store (~/.thinkdrop/copies) ──────────────────────────────────────

const COPIES_DIR = path.join(os.homedir(), '.thinkdrop', 'copies');
const COPIES_INDEX = path.join(COPIES_DIR, 'index.json');
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function ensureCopiesDir() {
  try { fs.mkdirSync(COPIES_DIR, { recursive: true }); } catch (_) {}
}

function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    // Strip volatile tracking params so cache hits survive re-navigation.
    const keep = [...u.searchParams.entries()]
      .filter(([k]) => !/^(utm_|fbclid|gclid|mc_|_ga|ref_|si$|feature$|t$)/i.test(k));
    keep.sort(([a], [b]) => a.localeCompare(b));
    const qs = keep.map(([k, v]) => `${k}=${v}`).join('&');
    return `${host}${u.pathname.replace(/\/$/, '') || '/'}${qs ? '?' + qs : ''}`.toLowerCase();
  } catch (_) {
    return String(url || '').toLowerCase().replace(/^www\./, '').replace(/#.*$/, '');
  }
}

function _loadIndex() {
  try {
    if (!fs.existsSync(COPIES_INDEX)) return {};
    return JSON.parse(fs.readFileSync(COPIES_INDEX, 'utf8')) || {};
  } catch (_) { return {}; }
}

function _saveIndex(idx) {
  try { fs.writeFileSync(COPIES_INDEX, JSON.stringify(idx, null, 2)); } catch (e) {
    logger.warn(`[page-copy] index write failed: ${e.message}`);
  }
}

/**
 * Persist a page copy under ~/.thinkdrop/copies and index it.
 * @returns {{ file: string, key: string } | null}
 */
function saveCopy({ url, content, appName, html }) {
  // Below ABSOLUTE_MIN_CHARS the copy is a failed grab (keystrokes went
  // nowhere, page still on about:blank). Persisting it poisons the cache —
  // a later scan_page serves the 1-char stub as a "fresh" hit for the URL.
  if (!content || content.length < ABSOLUTE_MIN_CHARS) return null;
  ensureCopiesDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const host = _hostOf(url) || 'page';
  const file = path.join(COPIES_DIR, `${host}-${ts}.txt`);
  try {
    fs.writeFileSync(file, content, 'utf8');
    let htmlFile = null;
    if (html) {
      htmlFile = file.replace(/\.txt$/, '.html');
      try { fs.writeFileSync(htmlFile, html, 'utf8'); } catch (_) { htmlFile = null; }
    }
    const idx = _loadIndex();
    const key = normalizeUrl(url || 'unknown');
    // Prune entries past TTL on write to bound index growth.
    const cutoff = Date.now() - DEFAULT_TTL_MS;
    for (const [k, v] of Object.entries(idx)) {
      if (!v || typeof v.ts !== 'number' || v.ts < cutoff) delete idx[k];
    }
    idx[key] = { file, htmlFile, url: url || null, ts: Date.now(), chars: content.length, appName: appName || null };
    _saveIndex(idx);
    return { file, htmlFile, key };
  } catch (e) {
    logger.warn(`[page-copy] save failed: ${e.message}`);
    return null;
  }
}

/**
 * Find a fresh copy. With `url`, look up its normalized key; without, return
 * the newest non-expired entry (the page the user most recently scanned).
 * @returns {{ file, url, chars, ts, appName } | null}
 */
function findFreshCopy(url, ttlMs = DEFAULT_TTL_MS) {
  const idx = _loadIndex();
  const now = Date.now();
  const fresh = (e) => e && typeof e.ts === 'number' && (now - e.ts) < ttlMs && e.file && fs.existsSync(e.file)
    && (typeof e.chars !== 'number' || e.chars >= ABSOLUTE_MIN_CHARS);
  if (url) {
    const hit = idx[normalizeUrl(url)];
    return fresh(hit) ? hit : null;
  }
  let best = null;
  for (const e of Object.values(idx)) {
    if (fresh(e) && (!best || e.ts > best.ts)) best = e;
  }
  return best;
}

function readCopy(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// ─── Internal ────────────────────────────────────────────────────────────────

function _hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) { return null; }
}

module.exports = {
  CATEGORY_ESTIMATES,
  HOST_CATEGORIES,
  ABSOLUTE_MIN_CHARS,
  BOT_WALL_RE,
  categorizeUrl,
  estimateForUrl,
  isBotWall,
  isErrorPage,
  isLoginWall,
  COPIES_DIR,
  COPIES_INDEX,
  DEFAULT_TTL_MS,
  normalizeUrl,
  saveCopy,
  findFreshCopy,
  readCopy,
};
