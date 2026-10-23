'use strict';

// ---------------------------------------------------------------------------
// browserCore/ordinal.cjs — deterministic ordinal-item resolution.
//
// "click/open the first|second|Nth item|result|listing|product" resolves
// positionally against the live DOM — no LLM. Enumerates result-shaped
// anchors in visual order and returns the Nth so callers can navigate to
// its href (a navigate can't be occluded by overlays like a coordinate
// click can).
// ---------------------------------------------------------------------------

const ORDINAL_WORDS = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3,
  fourth: 4, '4th': 4, fifth: 5, '5th': 5,
};
const ORDINAL_GOAL_RE = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b[^\n]{0,60}\b(item|items|result|results|listing|listings|product|products|link|links|video|videos|option|options|row|rows|card|cards|message|messages|email|emails|e-mail|e-mails|thread|threads|conversation|conversations|mail|mails)\b/i;
const ORDINAL_OPEN_VERB_RE = /\b(click|open|go to|goto|select|view|visit|details?|read|show|display|pull up)\b/i;

function ordinalNth(goal) {
  const m = String(goal || '').match(ORDINAL_GOAL_RE);
  if (!m || !ORDINAL_OPEN_VERB_RE.test(goal)) return 0;
  return ORDINAL_WORDS[m[1].toLowerCase()] || 0;
}

// Page-side enumeration: skip chrome/nav regions, require real visible size
// + link text, prefer anchors that leave the listing's URL path family
// (results leave /s?k= → /dp/; facets stay), dedupe hrefs, sort by visual
// reading order. Same heuristics as playwright.agent's ordinal fast-path.
const ORDINAL_SCAN = (nth) => `(() => {
  const nth = ${nth};
  const vh = window.innerHeight || 800;
  const curSeg = (location.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
  const out = [];
  for (const el of document.querySelectorAll('a[href]')) {
    if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], form')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10) continue;
    if (r.top < -50 || r.top > vh * 1.5) continue;
    const t = (el.innerText || el.textContent || '').trim();
    if (t.length < 15 || t.length > 500) continue;
    let sel = null;
    if (el.id) sel = '#' + el.id;
    else if (el.getAttribute('data-testid')) sel = 'a[data-testid="' + el.getAttribute('data-testid') + '"]';
    else {
      const attr = el.getAttribute('href') || '';
      // Attribute-selector-safe: prefer the raw attribute so a[href='X']
      // actually matches; el.href's absolute form mismatches relative attrs.
      if (attr && !attr.startsWith('#') && !attr.startsWith('javascript:')) {
        sel = 'a[href="' + attr.replace(/"/g, '\\"') + '"]';
      }
    }
    let cross = 1;
    try { cross = (new URL(el.href).pathname.split('/').filter(Boolean)[0] || '').toLowerCase() !== curSeg ? 1 : 0; } catch (_) {}
    out.push({ sel, tag: 'A', text: t.slice(0, 140), href: el.href || '', y: Math.round(r.top), x: Math.round(r.left), cross });
  }
  const seen = new Set();
  const items = out.filter(o => { if (seen.has(o.href)) return false; seen.add(o.href); return true; });
  items.sort((a, b) => (b.cross - a.cross) || (a.y - b.y) || (a.x - b.x));
  if (items[nth - 1]) return items[nth - 1];

  // Row fallback — SPA list surfaces (Gmail tr.zA, ARIA grids, listboxes)
  // render message rows as role=row/option controls, not anchors with hrefs.
  // Enumerate them in visual order and mark the target so the caller can
  // click it by selector instead of navigating an href.
  const ROW_SEL = 'tr[role="row"], tr.zA, [role="listitem"], [role="option"][aria-posinset], [data-thread-id], [data-legacy-thread-id]';
  const rows = [];
  for (const el of document.querySelectorAll(ROW_SEL)) {
    if (el.closest('nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], form')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10) continue;
    if (r.top < -50 || r.top > vh * 1.5) continue;
    const t = (el.innerText || el.textContent || '').trim();
    if (t.length < 4 || t.length > 800) continue;
    rows.push({ el, text: t.slice(0, 140), y: Math.round(r.top), x: Math.round(r.left), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) });
  }
  rows.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const row = rows[nth - 1];
  if (row) {
    for (const e of document.querySelectorAll('[data-td-ordinal]')) e.removeAttribute('data-td-ordinal');
    row.el.setAttribute('data-td-ordinal', '1');
    return { sel: '[data-td-ordinal="1"]', tag: row.el.tagName, text: row.text, href: '', rowClick: true, x: row.cx, y: row.cy };
  }
  return null;
})()`;

/**
 * Resolve an ordinal-item goal to a live page anchor.
 * @returns {Promise<{nth:number, text:string, href:string}|null>} null when
 *          the goal isn't ordinal-shaped or no candidate resolves.
 */
async function resolveOrdinalItem(browserAct, { sessionId, goal, headed = true, timeoutMs = 8000 }) {
  const nth = ordinalNth(goal);
  if (!nth) return null;
  const res = await browserAct({ action: 'evaluate', sessionId, headed, timeoutMs, text: ORDINAL_SCAN(nth) });
  const item = res?.result;
  // Anchors resolve to navigable hrefs; SPA rows resolve to a marked
  // selector (rowClick) the caller clicks instead.
  return item && (item.href || item.rowClick) ? { nth, ...item } : null;
}

module.exports = { ORDINAL_GOAL_RE, ORDINAL_OPEN_VERB_RE, ORDINAL_WORDS, ordinalNth, resolveOrdinalItem, ORDINAL_SCAN };
