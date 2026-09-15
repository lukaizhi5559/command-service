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
    const MAX_CARD_LOOPS = 80;
    const MAX_ANCHORS = 8;
    const MAX_IMGS = 8;
    const items = [];
    const stats = { ldBlocks: 0, anchorsWithImg: 0, cardCandidates: 0, scoredPositive: 0, filtered: 0 };
    const seen = new Set();

    const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch (_) { return ''; } };
    const isHttp = (u) => /^https?:\\/\\//i.test(String(u || ''));
    const trim = (s) => String(s || '').trim();
    const startsData = (u) => String(u || '').startsWith('data:');

    // Normalize redirect/tracking URLs to their target. Many ad networks and
    // sponsored-link wrappers encode the real destination in a query param
    // (commonly 'url', 'dest', 'target', 'redirect'). Decode the first one
    // that resolves to an http(s) URL on the same host.
    const normalizeUrl = (u) => {
      if (!u) return u;
      try {
        const parsed = new URL(u);
        for (const key of ['url', 'dest', 'target', 'redirect', 'u']) {
          const val = parsed.searchParams.get(key);
          if (!val) continue;
          // Try as absolute URL first, then as same-origin path.
          const decoded = decodeURIComponent(val);
          if (/^https?:\\/\\//i.test(decoded)) {
            try { return new URL(decoded).href; } catch (_) {}
          }
          if (decoded.startsWith('/')) {
            try { return new URL(decoded, parsed.origin).href; } catch (_) {}
          }
        }
      } catch (_) {}
      return u;
    };

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

    // Normalise a raw URL: make absolute and reject data: placeholders.
    const cleanUrl = (u) => {
      if (!u) return '';
      u = trim(u);
      if (startsData(u)) return '';
      if (!isHttp(u)) u = abs(u);
      return isHttp(u) ? u : '';
    };

    // Resolve an <img>'s best image URL. Many sites (eBay, Etsy, Amazon)
    // use a placeholder/low-res img.src while the real image lives in
    // data-src, srcset, or a sibling <picture><source>. We collect all
    // candidates, reject junk, and return the largest/best remaining URL.
    const resolveImg = (img) => {
      if (!img) return '';
      const cands = [];
      try { const u = cleanUrl(img.currentSrc); if (u) cands.push({ u, w: 0 }); } catch (_) {}
      const add = (raw, w) => { const u = cleanUrl(raw); if (u) cands.push({ u, w: w || 0 }); };
      add(img.src);
      if (img.dataset) {
        add(img.dataset.src, 100);
        add(img.dataset.lazySrc, 100);
        add(img.dataset.original, 100);
      }
      if (img.getAttribute) {
        add(img.getAttribute('data-srcset'), 0);
        add(img.getAttribute('lazy-srcset'), 0);
      }
      if (img.srcset) add(bestFromSrcset(img.srcset), 0);
      // Amazon: data-a-dynamic-image is a JSON map of URLs keyed by URL.
      if (img.dataset && img.dataset.aDynamicImage) {
        try {
          const map = JSON.parse(img.dataset.aDynamicImage);
          for (const k of Object.keys(map)) {
            const u = cleanUrl(k);
            if (u) cands.push({ u, w: (map[k] && map[k][0]) || 0 });
          }
        } catch (_) {}
      }
      // <picture><source srcset> siblings.
      const pic = img.closest && img.closest('picture');
      if (pic) {
        const sources = pic.querySelectorAll('source[srcset]');
        for (const s of sources) add(bestFromSrcset(s.getAttribute('srcset')), 0);
      }
      if (cands.length === 0) return '';
      // Prefer the largest width descriptor, then the longest (higher-res) URL.
      cands.sort((a, b) => (b.w - a.w) || (b.u.length - a.u.length));
      return cands[0].u;
    };

    const imgIsJunk = (img) => {
      if (!img) return false;
      if (img.width === 1 || img.height === 1) return true;
      const u = resolveImg(img);
      return !u || startsData(u) || u.length < 12;
    };

    const quickText = (el) => (el && el.textContent) ? trim(el.textContent) : '';
    const quickPrice = (txt) => {
      if (!txt) return null;
      const m = txt.match(/(?:US\s?)?\\$[\\d,]+(?:\\.\\d+)?(?:\s*[-–]\s*\\$[\\d,]+(?:\\.\\d+)?)?/);
      return m ? m[0].trim() : null;
    };

    const addItem = (it) => {
      if (!it || typeof it !== 'object') return;
      const url = String(it.url || '').trim();
      const imageUrl = String(it.imageUrl || '').trim();
      if (!url && !imageUrl) return;
      // Dedup by URL path (strip query/tracking params and path segments
      // containing '=' which are typically tracking refs) so the same product
      // with different tracking only appears once.
      let urlPath = url;
      try {
        const pu = new URL(url);
        urlPath = pu.pathname
          .split('/')
          .filter(seg => seg && !seg.includes('='))
          .join('/');
      } catch (_) {}
      const key = (urlPath || url || imageUrl) + '|' + (it.title || '') + '|' + (it.mediaType || '');
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
        const priceRe = /(?:US\s?)?\\$[\\d,]+(?:\\.\\d+)?|€\s?\\d+|£\s?\\d+|price\s*[: ]?\s*\\d[\\d.,]*/i;
        const embedHostRe = /(?:youtube\\.com\\/embed|player\\.vimeo\\.com|www\\.youtube-nocookie\\.com\\/embed|players\\.brightcove\\.net|embed\\.)/i;
        const pageUrl = abs(document.location.href);
        const isPageUrl = (u) => !u || u === pageUrl || u === pageUrl + '#' || u.startsWith(pageUrl + '#') || /^javascript:|^data:|^mailto:|^tel:|^#/i.test(u);

        const inNavLandmark = (el) => {
          let p = el;
          while (p) {
            if (/^(nav|header|footer)$/i.test(p.tagName)) return true;
            const role = p.getAttribute && p.getAttribute('role');
            if (role && /^(navigation|banner|contentinfo)$/i.test(role)) return true;
            p = p.parentElement;
          }
          return false;
        };

        const scoreCard = (card) => {
          let score = 0;
          if (inNavLandmark(card)) score -= 20;
          const cls = String(card.className || '');
          if (cls.includes('nav') || cls.includes('menu') || cls.includes('flyout') || cls.includes('shortcut') || cls.includes('autocomplete')) score -= 15;
          const imgs = Array.from(card.querySelectorAll('img'));
          const goodImgs = imgs.filter(img => !imgIsJunk(img) && resolveImg(img));
          score += Math.min(goodImgs.length, 2) * 10;

          const anchors = Array.from(card.querySelectorAll('a[href]'));
          let bestA = null, bestLen = -1;
          for (const a of anchors) {
            const u = abs(a.href || '');
            if (!isHttp(u) || isPageUrl(u)) continue;
            const txt = trim(a.textContent || '');
            if (/^sponsored|leave ad feedback|ad feedback$/i.test(txt)) continue;
            if (txt.length > bestLen) { bestLen = txt.length; bestA = a; }
          }
          if (bestA) {
            score += 15;
            if (bestLen > 20) score += 10;
            if (bestLen > 40) score += 5;
          }
          if (card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="headline"]')) score += 3;
          const cardText = quickText(card);
          if (priceRe.test(cardText)) score += 8;
          if (/bought in past month|out of \d+ stars|\d+\.\d+ out of \d+ stars|best seller/i.test(cardText)) score += 5;
          return { score, bestA, goodImgs, cardText };
        };

        const cardSel = '[data-component-type], [data-asin], article, [class*="card"], [class*="item"], [class*="result"], [class*="product"], [class*="tile"], [class*="s-result"]'; // eslint-disable-line
        const cardEls = Array.from(document.querySelectorAll(cardSel));
        const cardSet = new Set(cardEls);

        // Score every candidate once so we can distinguish a list/grid container
        // (many card descendants, low score) from a real product card that
        // happens to contain nested sub-components (many card descendants,
        // high score — e.g. eBay's .s-item with s-item__image/info children).
        const scoredAll = cardEls.map((card) => ({ card, ...scoreCard(card) }));
        const scoreMap = new Map(scoredAll.map(s => [s.card, s.score]));

        // Count total card-candidate descendants for each candidate.
        const descCount = new Map();
        for (const el of cardEls) {
          let n = 0;
          for (const c of el.querySelectorAll(cardSel)) n++;
          descCount.set(el, n);
        }

        // A passthrough/container has many card descendants AND itself scores low.
        // A real product card (eBay .s-item, Amazon .s-result-item) scores high
        // even if it has many descendant candidates.
        const PASSTHROUGH_THRESHOLD = 15;
        const isPassthrough = (el) => {
          const desc = descCount.get(el) || 0;
          if (desc <= 3) return false;
          const score = scoreMap.get(el) || 0;
          return score < PASSTHROUGH_THRESHOLD;
        };

        // A card is "top-level" if no ancestor is a single-card candidate.
        // Passthroughs (containers with many card descendants) don't swallow children.
        const topCards = cardEls.filter((el) => {
          if (isPassthrough(el)) return false; // container/wrapper, not a card
          let p = el.parentElement;
          while (p) {
            if (cardSet.has(p) && !isPassthrough(p)) return false; // swallowed by a single-card parent
            p = p.parentElement;
          }
          return true;
        });

        const scored = topCards.map((card) => ({ card, ...scoreCard(card) })).filter(s => s.score > 0);
        scored.sort((a, b) => b.score - a.score);
        stats.cardCandidates = topCards.length;
        stats.scoredPositive = scored.length;

        for (let ci = 0; ci < scored.length && items.length < MAX_ITEMS && ci < MAX_CARD_LOOPS; ci++) {
          const { card, bestA, goodImgs, cardText } = scored[ci];
          if (!bestA && goodImgs.length === 0) continue;

          let primary = bestA;
          if (!primary) {
            const firstA = card.querySelector('a[href]');
            const u = firstA ? abs(firstA.href || '') : '';
            if (u && !isPageUrl(u)) primary = firstA;
          }
          const rawUrl = primary ? abs(primary.href || '') : '';
          const url = normalizeUrl(rawUrl) || rawUrl;
          let urlPath = url;
          try {
            const pu = new URL(url);
            urlPath = pu.pathname.split('/').filter(seg => seg && !seg.includes('=')).join('/');
          } catch (_) {}
          if (!url || isPageUrl(url) || seen.has(urlPath) || seen.has(url)) continue;

          let img = primary ? primary.querySelector('img') : null;
          if (!img && goodImgs.length > 0) img = goodImgs[0];
          if (!img) {
            const imgs = Array.from(card.querySelectorAll('img'));
            for (let ii = 0; ii < imgs.length && ii < MAX_IMGS; ii++) {
              if (!imgIsJunk(imgs[ii])) { img = imgs[ii]; break; }
            }
          }
          if (img && imgIsJunk(img)) img = null;
          const imageUrl = img ? resolveImg(img) : '';
          if (!imageUrl && !url) continue;

          let title = primary ? trim(primary.textContent || '') : '';
          if (!title && img) title = trim(img.alt || img.title || '');
          if (!title) {
            const h = card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="headline"]');
            if (h) title = trim(h.textContent);
          }
          title = title.slice(0, 200);
          if (!title) continue;

          const priceMatch = cardText.match(priceRe);
          const price = priceMatch ? priceMatch[0].trim() : null;
          let snippet = cardText.replace(title || '', '').replace(price || '', '').trim().slice(0, 160);
          snippet = snippet.replace(/\s+/g, ' ').trim() || null;

          const iframe = card.querySelector('iframe[src]');
          const isVideo = iframe && embedHostRe.test(abs(iframe.getAttribute('src') || ''));

          const item = { title: title || null, imageUrl: imageUrl || null, url: url, price, snippet };
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
          snippet = snippet.replace(/\s+/g, ' ').trim() || null;
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

    // Final filter/cap
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
