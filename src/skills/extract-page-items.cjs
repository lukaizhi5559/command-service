'use strict';

/**
 * extract-page-items.cjs — Shared page-card extraction utility.
 *
 * Used by:
 *   - web.crawl.cjs   (public, anonymous sessions)
 *   - browser.agent.cjs (authenticated sessions — Phase 2)
 *
 * Exports:
 *   buildExtractItemsScript()  → JS string to eval in page context; returns JSON string
 *                                of the form `{"items":[...],"stats":{...}}`.
 *   parseExtractedItems(raw)   → parses eval output into { items, stats }.
 *
 * Item schema (all fields optional unless noted):
 *   {
 *     title?, imageUrl?, url?, price?, snippet?, hostname?,
 *     mediaType?,        // 'video' | 'product' | 'article' | 'card'
 *     videoUrl?,         // direct content URL for <video>/og:video
 *     embedUrl?,         // iframe embed URL (youtube/vimeo/...)
 *     posterUrl?,        // video poster image
 *     duration?,         // ISO-8601 or "MM:SS" duration string
 *     sourceUrl?,        // canonical source when url is a watch page
 *   }
 *
 * Standalone module — NO relative requires — so browser.agent can require it
 * without path issues (same constraint as creator-built skills).
 */

// ── Build the in-page extraction script ──────────────────────────────────────
// Returns a JS expression that evaluates to a JSON string of the form
// `{"items":[...],"stats":{...}}`. Designed to run via playwright-cli `eval`
// or browser.act `evaluate`.
function buildExtractItemsScript() {
  // The script is wrapped in an IIFE so it returns a single JSON string.
  // It is written for speed on heavy SERPs (Amazon, eBay, YouTube) and returns
  // partial results if it is interrupted or errors.
  return `(() => {
    const MAX_ITEMS = 24;
    const MAX_CARD_LOOPS = 60;
    const MAX_ANCHORS = 5;
    const MAX_IMGS = 8;
    const items = [];
    const stats = { ldBlocks: 0, anchorsWithImg: 0, cardCandidates: 0, filtered: 0 };
    const seen = new Set();

    const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (_) { return ''; } };
    const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
    const trim = (s) => String(s || '').trim();
    const startsData = (u) => String(u || '').startsWith('data:');

    // Pick the largest image URL from a srcset string.
    const bestFromSrcset = (srcset) => {
      if (!srcset) return '';
      const cands = srcset.split(',').map(c => c.trim()).filter(Boolean);
      let best = '', bestW = -1;
      for (const c of cands) {
        const parts = c.split(/\s+/);
        const url = parts[0];
        const w = parts[1] ? parseInt(parts[1].replace(/w$/, ''), 10) || 0 : 0;
        if (w > bestW) { best = url; bestW = w; }
      }
      return best || (cands[0] ? cands[0].split(/\s+/)[0] : '');
    };

    // Resolve an <img>'s current best image URL, covering lazy-attr variants.
    const resolveImg = (img) => {
      if (!img) return '';
      let u = '';
      try { u = img.currentSrc || ''; } catch (_) {}
      if (!u) u = trim(img.src || '');
      if (!u && img.dataset) {
        u = trim(img.dataset.src || img.dataset.lazySrc || img.dataset.original || '');
      }
      // Amazon: data-a-dynamic-image is a JSON map of real URLs keyed by URL.
      if (img.dataset && img.dataset.aDynamicImage) {
        try {
          const map = JSON.parse(img.dataset.aDynamicImage);
          let best = '', bestW = -1;
          for (const k of Object.keys(map)) {
            const w = (map[k] && map[k][0]) || 0;
            if (w > bestW && !startsData(k)) { best = k; bestW = w; }
          }
          if (best) u = best;
        } catch (_) {}
      }
      if (!u && img.srcset) u = bestFromSrcset(img.srcset);
      if (!u && img.getAttribute) {
        const ds = img.getAttribute('data-srcset') || img.getAttribute('lazy-srcset');
        if (ds) u = bestFromSrcset(ds);
      }
      if (u && !isHttp(u)) u = abs(u);
      if (u && startsData(u)) u = '';
      return u;
    };

    const imgIsJunk = (img) => {
      if (!img) return false;
      if (img.width === 1 || img.height === 1) return true;
      const u = resolveImg(img);
      return startsData(u);
    };

    const quickText = (el) => (el && el.textContent) ? trim(el.textContent) : '';
    const quickPrice = (txt) => {
      if (!txt) return null;
      const m = txt.match(/(?:US\s?)?\\$[\\d,]+(?:\\.\\d+)?(?:\\s*[-–]\\s*\\$[\\d,]+(?:\\.\\d+)?)?/);
      return m ? m[0].trim() : null;
    };

    const addItem = (it) => {
      if (!it || typeof it !== 'object') return;
      const url = String(it.url || '').trim();
      const imageUrl = String(it.imageUrl || '').trim();
      if (!url && !imageUrl) return;
      const key = (url || imageUrl) + '|' + (it.title || '') + '|' + (it.mediaType || '');
      if (seen.has(key)) return;
      seen.add(key);
      let hostname = null;
      try { hostname = new URL(url || imageUrl).hostname; } catch (_) {}
      items.push({
        title: it.title || undefined,
        imageUrl: imageUrl || undefined,
        url: url || undefined,
        price: it.price || undefined,
        snippet: it.snippet || undefined,
        hostname: hostname || undefined,
        mediaType: it.mediaType || undefined,
        videoUrl: it.videoUrl || undefined,
        embedUrl: it.embedUrl || undefined,
        posterUrl: it.posterUrl || undefined,
        duration: it.duration || undefined,
        sourceUrl: it.sourceUrl || undefined,
      });
    };

    try {
      // ── Pass 1: structured data (JSON-LD) ─────────────────────────────────
      if (items.length < MAX_ITEMS) {
        const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
        stats.ldBlocks = ldScripts.length;
        for (let sIdx = 0; sIdx < ldScripts.length && items.length < MAX_ITEMS; sIdx++) {
          const s = ldScripts[sIdx];
          let json;
          try { json = JSON.parse(s.textContent || ''); } catch (_) { continue; }
          const candidates = [];
          const walk = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(walk); return; }
            const t = String(node['@type'] || '').toLowerCase();
            if (t.includes('itemlist') && Array.isArray(node.itemListElement)) {
              node.itemListElement.forEach((el) => {
                const it = el.item || el;
                if (it && typeof it === 'object') candidates.push(it);
              });
            } else if (t.includes('product') || t.includes('article') || t.includes('listitem') || t.includes('videoobject') || t.includes('imageobject')) {
              candidates.push(node);
            }
            if (node.mainEntity) walk(node.mainEntity);
            if (node.itemListElement) node.itemListElement.forEach(walk);
            if (node.hasPart) node.hasPart.forEach(walk);
          };
          walk(json);
          for (let cIdx = 0; cIdx < candidates.length && items.length < MAX_ITEMS; cIdx++) {
            const c = candidates[cIdx];
            const title = trim(c.name || c.headline || c.title || '');
            const url = abs(trim(c.url || ''));
            const offers = c.offers || (c.itemOffers && c.itemOffers[0]) || null;
            const price = offers && (offers.price || offers.lowPrice || (Array.isArray(offers) ? offers[0] && offers[0].price : null)) || null;
            const image = c.image || (Array.isArray(c.image) ? c.image[0] : null) || null;
            const imageUrl = image ? (typeof image === 'string' ? image : trim(image.url || image.contentUrl || '')).trim() : '';
            const t = String(c['@type'] || '').toLowerCase();
            if (t.includes('videoobject')) {
              const videoUrl = abs(trim(c.contentUrl || ''));
              const embedUrl = abs(trim(c.embedUrl || ''));
              const poster = abs(trim(c.thumbnailUrl || ''));
              addItem({
                title: title || null,
                imageUrl: (imageUrl || poster) || null,
                url: url || videoUrl || embedUrl || null,
                mediaType: 'video',
                videoUrl: videoUrl || null,
                embedUrl: embedUrl || null,
                posterUrl: poster || null,
                duration: trim(c.duration) || null,
                snippet: trim(c.description || '').slice(0, 160) || null,
              });
            } else if (title || url) {
              addItem({
                title: title || null,
                imageUrl: abs(imageUrl) || null,
                url: url || null,
                mediaType: t.includes('product') ? 'product' : (t.includes('article') ? 'article' : 'card'),
                price: price != null ? String(price) : null,
                snippet: trim(c.description || '').slice(0, 160) || null,
              });
            }
          }
        }
      }

      // ── Pass 2: DOM card-candidate pass ────────────────────────────────────
      if (items.length < MAX_ITEMS) {
        const priceRe = /(?:US\s?)?\\$[\\d,]+(?:\\.\\d+)?|€\s?\\d+|£\s?\\d+|price\s*[: ]?\s*[\\d.,]+/i;
        const embedHostRe = /(?:youtube\\.com\\/embed|player\\.vimeo\\.com|www\\.youtube-nocookie\\.com\\/embed|players\\.brightcove\\.net|embed\\.)/i;

        const cardSel = '[data-component-type], [data-asin], li, article, tr, [class*="card"], [class*="item"], [class*="result"], [class*="product"], [class*="tile"], [class*="s-result"]';
        const cardEls = Array.from(document.querySelectorAll(cardSel));
        const cardSet = new Set(cardEls);
        const topCards = cardEls.filter((el) => {
          let p = el.parentElement;
          while (p) { if (cardSet.has(p)) return false; p = p.parentElement; }
          return true;
        });
        stats.cardCandidates = topCards.length;

        for (let ci = 0; ci < topCards.length && items.length < MAX_ITEMS && ci < MAX_CARD_LOOPS; ci++) {
          const card = topCards[ci];
          const anchors = Array.from(card.querySelectorAll('a[href]')).filter(a => isHttp(abs(a.href)));
          if (anchors.length === 0) continue;
          let primary = null, bestLen = -1;
          for (let ai = 0; ai < anchors.length && ai < MAX_ANCHORS; ai++) {
            const a = anchors[ai];
            const len = (a.textContent || '').trim().length;
            if (len > bestLen) { bestLen = len; primary = a; }
          }
          if (!primary) primary = anchors[0];
          const href = abs(primary.href);
          if (seen.has(href)) continue;

          let img = primary.querySelector('img');
          if (!img) {
            const imgs = Array.from(card.querySelectorAll('img'));
            for (let ii = 0; ii < imgs.length && ii < MAX_IMGS; ii++) {
              if (!imgIsJunk(imgs[ii])) { img = imgs[ii]; break; }
            }
          }
          if (img && imgIsJunk(img)) img = null;
          const imageUrl = img ? resolveImg(img) : '';
          if (!imageUrl && !href) continue;

          let title = trim(primary.textContent || '');
          if (!title && img) title = trim(img.alt || img.title || '');
          if (!title) {
            const h = card.querySelector('h1, h2, h3, h4, [class*="title"]');
            if (h) title = trim(h.textContent);
          }
          title = title.slice(0, 200);

          const cardText = quickText(card);
          const priceMatch = cardText.match(priceRe);
          const price = priceMatch ? priceMatch[0].trim() : null;
          let snippet = cardText.replace(title || '', '').replace(price || '', '').trim().slice(0, 160);
          snippet = snippet.replace(/\\s+/g, ' ').trim() || null;

          const iframe = card.querySelector('iframe[src]');
          const isVideo = iframe && embedHostRe.test(abs(iframe.getAttribute('src') || ''));

          const item = { title: title || null, imageUrl: imageUrl || null, url: href, price, snippet };
          if (isVideo) {
            item.mediaType = 'video';
            item.embedUrl = abs(iframe.getAttribute('src'));
          } else {
            item.mediaType = 'card';
          }
          addItem(item);
        }
      }

      // ── Pass 3: a:has(img) fallback ────────────────────────────────────────
      if (items.length < 3) {
        const anchors = Array.from(document.querySelectorAll('a:has(img)'));
        stats.anchorsWithImg = anchors.length;
        for (let ai = 0; ai < anchors.length && items.length < MAX_ITEMS && ai < MAX_CARD_LOOPS; ai++) {
          const a = anchors[ai];
          const href = abs(a.href || '');
          if (!isHttp(href) || seen.has(href)) continue;
          const card = a.closest('li, article, [class*="item"], [class*="card"], [class*="result"], tr, div') || a;
          const img = (card.querySelector('img') || a.querySelector('img'));
          if (img && imgIsJunk(img)) continue;
          const imageUrl = img ? resolveImg(img) : '';
          let title = trim(a.textContent || '');
          if (!title && img) title = trim(img.alt || img.title || '');
          if (!title) {
            const h = card.querySelector('h1, h2, h3, h4, [class*="title"]');
            if (h) title = trim(h.textContent);
          }
          title = title.slice(0, 200);
          const cardText = quickText(card);
          const priceMatch = cardText.match(/(?:US\s?)?\\$[\\d,]+(?:\\.\\d+)?/);
          const price = priceMatch ? priceMatch[0].trim() : null;
          let snippet = cardText.replace(title || '', '').replace(price || '', '').trim().slice(0, 160);
          snippet = snippet.replace(/\\s+/g, ' ').trim() || null;
          if (!imageUrl && !title) continue;
          addItem({ title: title || null, imageUrl: imageUrl || null, url: href, price, snippet, mediaType: 'card' });
        }
      }

      // ── Pass 4: page-level meta (only when items < 3) ──────────────────────
      if (items.length < 3) {
        const meta = (n) => {
          const el = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]');
          return el ? trim(el.getAttribute('content') || '') : '';
        };
        const ogImageRaw = meta('og:image');
        const ogImage = ogImageRaw ? abs(ogImageRaw) : '';
        const ogVideoRaw = meta('og:video') || meta('og:video:url') || meta('og:video:secure_url');
        const ogVideo = ogVideoRaw ? abs(ogVideoRaw) : '';
        const twitterPlayerRaw = meta('twitter:player');
        const twitterPlayer = twitterPlayerRaw ? abs(twitterPlayerRaw) : '';
        const twitterImageRaw = meta('twitter:image');
        const twitterImage = twitterImageRaw ? abs(twitterImageRaw) : '';
        const pageUrl = abs(meta('og:url') || document.location.href);
        const pageTitle = trim(document.title || meta('og:title') || '');
        if (ogVideo || twitterPlayer) {
          addItem({
            title: pageTitle || null,
            imageUrl: ogImage || twitterImage || null,
            url: pageUrl,
            mediaType: 'video',
            videoUrl: ogVideo || null,
            embedUrl: twitterPlayer || null,
            posterUrl: ogImage || null,
            snippet: trim(meta('og:description') || '').slice(0, 160) || null,
          });
        } else if (ogImage) {
          addItem({
            title: pageTitle || null,
            imageUrl: ogImage,
            url: pageUrl,
            mediaType: 'card',
            snippet: trim(meta('og:description') || '').slice(0, 160) || null,
          });
        }
      }
    } catch (err) {
      // Return whatever we managed to collect plus an error marker.
      stats.error = String(err && err.message || err).slice(0, 200);
    }

    // Final filter/cap (also drops junk without images on Amazon if we already have Amazon items)
    const filtered = [];
    const dedupe = new Set();
    for (const it of items) {
      const url = String(it.url || '').trim();
      const imageUrl = String(it.imageUrl || '').trim();
      if (!url && !imageUrl) { stats.filtered++; continue; }
      const key = (url || imageUrl) + '|' + (it.title || '') + '|' + (it.mediaType || '');
      if (dedupe.has(key)) { stats.filtered++; continue; }
      dedupe.add(key);
      filtered.push(it);
      if (filtered.length >= MAX_ITEMS) break;
    }
    return JSON.stringify({ items: filtered, stats });
  })()`;
}

// ── Parse the eval output into { items, stats } ──────────────────────────────
// Accepts the raw stdout from playwright-cli `eval` or browser.act `evaluate`.
// Mirrors web.crawl.cjs's unwrapEvalResult pattern.
//
// Backward compatibility: callers that expect a bare array (the old shape) still
// work — when the script returns the new { items, stats } envelope we return
// { items, stats }; when it returns a bare array (old script) we wrap it as
// { items, stats: {} }.
function parseExtractedItems(rawEvalOutput) {
  const { items, stats } = _parseInternal(rawEvalOutput);
  return { items, stats: stats || {} };
}

function _parseInternal(rawEvalOutput) {
  if (!rawEvalOutput) return { items: [], stats: {} };

  let s = String(rawEvalOutput).trim();

  // Strip playwright-cli header block: "### Ran Playwright code\n\`\`\`js\n...\n\`\`\`\n<value>"
  const fenceEnd = s.lastIndexOf('```');
  if (fenceEnd !== -1) {
    const afterFence = s.slice(fenceEnd + 3).trim();
    if (afterFence.length > 0) s = afterFence;
  }

  // Try direct JSON.parse first — could be { items, stats } or a bare array.
  try {
    const parsed = JSON.parse(s);
    if (parsed && Array.isArray(parsed.items)) {
      return { items: _normalizeItems(parsed.items), stats: parsed.stats || {} };
    }
    if (Array.isArray(parsed)) return { items: _normalizeItems(parsed), stats: {} };
  } catch (_) {}

  // Fallback: extract the first JSON object or array from the string.
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (parsed && Array.isArray(parsed.items)) {
        return { items: _normalizeItems(parsed.items), stats: parsed.stats || {} };
      }
    } catch (_) {}
  }
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return { items: _normalizeItems(parsed), stats: {} };
    } catch (_) {}
  }

  return { items: [], stats: {} };
}

// ── Normalize + cap items ────────────────────────────────────────────────────
function _normalizeItems(arr) {
  const out = [];
  const dedupe = new Set();
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const url = (it.url || '').toString().trim();
    const imageUrl = (it.imageUrl || '').toString().trim();
    if (!url && !imageUrl) continue;
    const key = (url || imageUrl) + '|' + (it.title || '') + '|' + (it.mediaType || '');
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    let hostname = it.hostname || null;
    if (!hostname) {
      try { hostname = new URL(url || imageUrl).hostname; } catch (_) {}
    }
    out.push({
      title: it.title || undefined,
      imageUrl: imageUrl || undefined,
      url: url || undefined,
      price: it.price || undefined,
      snippet: it.snippet || undefined,
      hostname: hostname || undefined,
      mediaType: it.mediaType || undefined,
      videoUrl: it.videoUrl || undefined,
      embedUrl: it.embedUrl || undefined,
      posterUrl: it.posterUrl || undefined,
      duration: it.duration || undefined,
      sourceUrl: it.sourceUrl || undefined,
    });
    if (out.length >= 24) break;
  }
  return out;
}

module.exports = {
  buildExtractItemsScript,
  parseExtractedItems,
};
