'use strict';

/**
 * http-fetch.cjs — invisible tier-0 page fetch.
 *
 * Plain HTTP GET with a real browser UA + a lightweight HTML→text stripper.
 * Sub-second for server-rendered pages; used by app.agent read_url (and
 * web.crawl standalone) before paying for the visible-browser or playwright
 * tiers. Output feeds an LLM, so the stripping aims for readable text, not
 * byte-fidelity.
 *
 * Every result runs the shared page validators (isBotWall / isErrorPage /
 * isLoginWall / minChars) so a soft-block page that returns lots of HTTP-200
 * challenge text doesn't false-accept into synthesis.
 */

const _est = require('./page-copy-estimates.cjs');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // cap huge pages; we only need text

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', copy: '©', reg: '®', trade: '™',
};

function _decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, name) => {
    if (name[0] === '#') {
      const cp = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITY_MAP[name.toLowerCase()] ?? m;
  });
}

/**
 * HTML → plain text. Strips script/style/head/svg/noscript, maps block-level
 * closes to newlines, removes tags, decodes entities, collapses blank runs.
 */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Block-level boundaries → newlines so columns/lists keep line shape.
  s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|ul|ol|blockquote|pre|br|hr)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  s = _decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function _extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? _decodeEntities(m[1].replace(/<[^>]+>/g, '').trim()) : null;
}

/**
 * fetchPageText — GET a URL and return validated plain text.
 *
 * @returns {Promise<{ok, content?, url?, status?, chars?, reason?}>}
 *   reason values: 'invalid-url' | 'http-error:<status>' | 'non-html' |
 *   'network' | 'timeout' | 'bot_wall' | 'error_page' | 'login_wall' | 'thin'
 */
async function fetchPageText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, minChars } = {}) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return { ok: false, reason: 'invalid-url' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(raw, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
  }

  try {
    const status = res.status || 0;
    const finalUrl = res.url || raw;
    const ct = String(res.headers.get('content-type') || '');
    if (status === 404 || status === 410) return { ok: false, reason: 'error_page', status, url: finalUrl };
    if (status === 401 || status === 403) return { ok: false, reason: status === 401 ? 'login_wall' : 'http-error:403', status, url: finalUrl };
    if (status === 429 || status === 503) return { ok: false, reason: 'bot_wall', status, url: finalUrl };
    if (status < 200 || status >= 300) return { ok: false, reason: `http-error:${status}`, status, url: finalUrl };
    if (!/text\/html|application\/xhtml|^$/.test(ct)) {
      return { ok: false, reason: 'non-html', status, url: finalUrl, contentType: ct };
    }

    // Read with a size cap — some pages stream megabytes of inline state.
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    try { await reader.cancel(); } catch (_) {}
    const html = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');

    const title = _extractTitle(html);
    const content = htmlToText(html);
    const chars = content.length;
    // Caller-omitted minChars → the category estimate for the URL (a
    // youtube.com watch page demands ~1200 chars, not the 80-char floor —
    // footer chrome once false-accepted a YouTube page as "content").
    const floor = Math.max(minChars ?? _est.estimateForUrl(finalUrl || url).minChars, _est.ABSOLUTE_MIN_CHARS);

    if (_est.isBotWall(title + '\n' + content)) return { ok: false, reason: 'bot_wall', status, url: finalUrl, chars };
    if (_est.isLoginWall(title + '\n' + content)) return { ok: false, reason: 'login_wall', status, url: finalUrl, chars };
    if (_est.isErrorPage(title + '\n' + content)) return { ok: false, reason: 'error_page', status, url: finalUrl, chars };
    if (chars < floor) return { ok: false, reason: 'thin', status, url: finalUrl, chars };

    return { ok: true, content, title, url: finalUrl, status, chars };
  } catch (e) {
    return { ok: false, reason: 'network', error: e?.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchPageText, htmlToText, BROWSER_UA, DEFAULT_TIMEOUT_MS };
