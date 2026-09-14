'use strict';

/**
 * extract-page-items.cjs — Shared page-card extraction utility.
 *
 * Used by:
 *   - web.crawl.cjs   (public, anonymous sessions)
 *   - browser.agent.cjs (authenticated sessions — Phase 2)
 *
 * Exports:
 *   buildExtractItemsScript()  → JS string to eval in page context; returns JSON string of items.
 *   parseExtractedItems(raw)   → parses eval output into the item schema, applies filters + dedupe + cap.
 *
 * Item schema:
 *   { title?, imageUrl?, url?, price?, snippet?, hostname? }
 *
 * Standalone module — NO relative requires — so browser.agent can require it
 * without path issues (same constraint as creator-built skills).
 */

// ── Build the in-page extraction script ──────────────────────────────────────
// Returns a JS expression that evaluates to a JSON string of items.
// Designed to run via playwright-cli `eval` or browser.act `evaluate`.
function buildExtractItemsScript() {
  // The script is wrapped in an IIFE so it returns a single JSON string.
  // We keep it as a single string for easy `eval`/`evaluate` transport.
  return `(() => {
    const MAX_ITEMS = 24;
    const items = [];

    // ── Pass 1: structured data (JSON-LD) ────────────────────────────────────
    const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const s of ldScripts) {
      let json;
      try { json = JSON.parse(s.textContent || ''); } catch (_) { continue; }
      const candidates = [];
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        const t = (node['@type'] || '').toString().toLowerCase();
        if (t.includes('itemlist') && Array.isArray(node.itemListElement)) {
          node.itemListElement.forEach((el) => {
            const it = el.item || el;
            if (it && typeof it === 'object') candidates.push(it);
          });
        } else if (t.includes('product') || t.includes('article') || t.includes('listitem')) {
          candidates.push(node);
        }
        // Recurse into common nested containers
        if (node.mainEntity) walk(node.mainEntity);
        if (node.itemListElement) node.itemListElement.forEach(walk);
        if (node.hasPart) node.hasPart.forEach(walk);
      };
      walk(json);
      for (const c of candidates) {
        const title = (c.name || c.headline || c.title || '').toString().trim();
        const url = (c.url || '').toString().trim();
        const offers = c.offers || (c.itemOffers && c.itemOffers[0]) || null;
        const price = offers && (offers.price || (offers.lowPrice) || (Array.isArray(offers) ? offers[0]?.price : null)) || null;
        const image = c.image || (Array.isArray(c.image) ? c.image[0] : null) || null;
        const imageUrl = image ? (typeof image === 'string' ? image : (image.url || image.contentUrl || '')).toString().trim() : '';
        if (title || url) {
          items.push({
            title: title || null,
            imageUrl: imageUrl || null,
            url: url || null,
            price: price != null ? String(price) : null,
            snippet: (c.description || '').toString().trim().slice(0, 160) || null,
          });
        }
        if (items.length >= MAX_ITEMS) break;
      }
      if (items.length >= MAX_ITEMS) break;
    }

    // ── Pass 2: DOM fallback (when Pass 1 yields < 3 items) ─────────────────
    if (items.length < 3) {
      const anchors = Array.from(document.querySelectorAll('a:has(img)'));
      const seen = new Set(items.map((i) => i.url).filter(Boolean));
      const priceRe = /(?:US\\s?)?\\$[\\d,]+(?:\\.\\d+)?|€\\s?\\d+|£\\s?\\d+|price\\s*[: ]?\\s*[\\d.,]+/i;

      for (const a of anchors) {
        if (items.length >= MAX_ITEMS) break;
        const href = a.href || '';
        if (!href || !href.startsWith('http')) continue;
        if (seen.has(href)) continue;

        // Roll up to nearest card ancestor
        const card = a.closest('li, article, [class*="item"], [class*="card"], [class*="result"], tr, div');
        const scope = card || a;

        // Image
        const img = scope.querySelector('img') || a.querySelector('img');
        let imageUrl = '';
        if (img) {
          imageUrl = (img.currentSrc || img.src || img.dataset && img.dataset.src || '').toString().trim();
          if (!imageUrl && img.srcset) {
            const firstSrc = img.srcset.split(',')[0].trim().split(/\\s+/)[0];
            if (firstSrc) imageUrl = firstSrc;
          }
        }
        // Skip tracking pixels / 1x1 placeholders
        if (img && (img.width === 1 || img.height === 1)) continue;
        if (imageUrl && imageUrl.startsWith('data:')) continue;

        // Title
        let title = (a.innerText || a.textContent || '').toString().trim();
        if (!title && img) title = (img.alt || img.title || '').toString().trim();
        if (!title) {
          const h = scope.querySelector('h1, h2, h3, h4, [class*="title"]');
          if (h) title = (h.innerText || h.textContent || '').toString().trim();
        }
        title = title.slice(0, 200);

        // Price
        let price = null;
        const cardText = (scope.innerText || scope.textContent || '').toString();
        const priceMatch = cardText.match(priceRe);
        if (priceMatch) price = priceMatch[0].trim();

        // Snippet (card text minus title/price, ≤160 chars)
        let snippet = cardText.replace(title || '', '').replace(price || '', '').trim().slice(0, 160);
        snippet = snippet.replace(/\\s+/g, ' ').trim() || null;

        // Require at least an image or a url with a title
        if (!imageUrl && !title) continue;
        if (!imageUrl && !href) continue;

        seen.add(href);
        items.push({
          title: title || null,
          imageUrl: imageUrl || null,
          url: href,
          price,
          snippet,
        });
      }
    }

    // ── Junk filters + hostname + dedupe ────────────────────────────────────
    const filtered = [];
    const dedupe = new Set();
    for (const it of items) {
      if (!it.imageUrl && !it.url) continue;
      const key = (it.url || it.imageUrl || '') + '|' + (it.title || '');
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      let hostname = null;
      try { hostname = new URL(it.url || it.imageUrl).hostname; } catch (_) {}
      filtered.push({
        title: it.title || undefined,
        imageUrl: it.imageUrl || undefined,
        url: it.url || undefined,
        price: it.price || undefined,
        snippet: it.snippet || undefined,
        hostname: hostname || undefined,
      });
      if (filtered.length >= MAX_ITEMS) break;
    }
    return JSON.stringify(filtered);
  })()`;
}

// ── Parse the eval output into the item schema ──────────────────────────────
// Accepts the raw stdout from playwright-cli `eval` or browser.act `evaluate`.
// Mirrors web.crawl.cjs's unwrapEvalResult pattern.
function parseExtractedItems(rawEvalOutput) {
  if (!rawEvalOutput) return [];

  let s = String(rawEvalOutput).trim();

  // Strip playwright-cli header block: "### Ran Playwright code\n```js\n...\n```\n<value>"
  const fenceEnd = s.lastIndexOf('```');
  if (fenceEnd !== -1) {
    const afterFence = s.slice(fenceEnd + 3).trim();
    if (afterFence.length > 0) s = afterFence;
  }

  // Try direct JSON.parse first
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return _normalizeItems(parsed);
  } catch (_) {}

  // Fallback: extract the first JSON array from the string
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) return _normalizeItems(parsed);
    } catch (_) {}
  }

  return [];
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
    const key = (url || imageUrl) + '|' + (it.title || '');
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
    });
    if (out.length >= 24) break;
  }
  return out;
}

module.exports = {
  buildExtractItemsScript,
  parseExtractedItems,
};
