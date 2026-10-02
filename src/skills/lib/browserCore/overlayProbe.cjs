'use strict';

// ---------------------------------------------------------------------------
// browserCore/overlayProbe.cjs — shared generic modal/dialog detection.
//
// All prior detectors required ARIA semantics ([role="dialog"], aria-modal) or
// exact classes (.modal, .popup). Sites like LinkedIn ship non-ARIA overlays
// (`.share-box-modal`) that every one of those probes missed. This probe adds:
//   - attribute-contains class matching (modal/dialog/popup/sheet/drawer)
//   - a backdrop-driven fallback: a fixed element covering most of the
//     viewport with a translucent/dark bg implies the topmost centered
//     interactive container is the dialog
// Gating (visible, 160px–90% viewport, ≥1 interactive child, not a side panel)
// keeps false positives out.
// ---------------------------------------------------------------------------

// Candidate selector reusable in querySelectorAll contexts (bulk scans,
// overlay-state keys, submit verification). Includes ARIA + class-contains.
const DIALOG_SELECTOR = [
  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
  '[class*="modal" i]', '[class*="dialog" i]', '[class*="popup" i]',
  '[class*="sheet" i]', '[class*="drawer" i]',
].join(', ');

// Fillable selector shared with the scans — matches contenteditable regardless
// of value (catches `plaintext-only`, which `[contenteditable="true"/""]` miss).
const FILLABLE_SELECTOR = [
  'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"]):not([type="file"])',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]', '[role="combobox"]',
].join(', ');

// In-page detector. Returns { found, x, y, w, h, children } or { found:false }.
// `tag` — when true, the winning container gets data-td-dialog="1" so callers
// can re-locate it cheaply for membership tests.
const _FIND_DIALOG_JS = (tag) => `(() => {
  // Rendered-check: offsetParent is null for position:fixed elements — the
  // standard modal positioning — so it can't be used alone as a visibility
  // gate for containers. (Descendants of fixed elements get a non-null
  // offsetParent, so only container-candidate checks needed this.)
  const _viz = (el) => !!el && el.isConnected && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
  const _isSidePanel = (r) => {
    const cx = r.x + r.width / 2;
    return (cx < window.innerWidth * 0.15 || cx > window.innerWidth * 0.85);
  };
  const _interactiveCount = (el) => {
    const els = el.querySelectorAll('${'button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'}');
    let n = 0;
    for (const e of els) {
      const er = e.getBoundingClientRect();
      if (er.width > 0 && er.height > 0 && _viz(e)) { n++; if (n >= 3) break; }
    }
    return n;
  };
  const _okCandidate = (el) => {
    if (!el || !_viz(el)) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.height < 80) return null;
    if (r.width > window.innerWidth * 0.9 || r.height > window.innerHeight * 0.9) return null;
    if (_isSidePanel(r)) return null;
    if (_interactiveCount(el) < 1) return null;
    return r;
  };
  const _clean = () => { for (const d of document.querySelectorAll('[data-td-dialog]')) d.removeAttribute('data-td-dialog'); };
  ${tag ? '_clean();' : ''}

  // Path 1: ARIA + class-contains candidates — pick the one with the most
  // interactive children (hidden/stale dialog shells lose to the live one).
  let best = null, bestN = -1, bestR = null;
  for (const d of document.querySelectorAll('${DIALOG_SELECTOR}')) {
    const r = _okCandidate(d); if (!r) continue;
    const n = _interactiveCount(d);
    if (n > bestN) { bestN = n; best = d; bestR = r; }
  }

  // Path 2: backdrop-driven — a full-viewport translucent fixed layer implies
  // a modal exists even when the dialog container has no recognizable class.
  if (!best) {
    let hasBackdrop = false;
    for (const el of document.querySelectorAll('body *')) {
      if (!_viz(el)) continue;
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width < window.innerWidth * 0.8 || r.height < window.innerHeight * 0.8) continue;
      const bg = s.backgroundColor || '';
      const m = bg.match(/rgba?\\(\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*([\\d.]+)/);
      const translucent = m ? parseFloat(m[1]) > 0 && parseFloat(m[1]) < 0.95 : false;
      const darkish = /rgba?\\(\\s*(\\d+)/.test(bg) && parseInt(RegExp.$1, 10) < 80;
      const namedLayer = /scrim|backdrop|overlay|veil|shim/i.test(el.className || '');
      if (translucent || darkish || namedLayer) { hasBackdrop = true; break; }
    }
    if (hasBackdrop) {
      // Topmost centered positioned container with interactive children.
      const cands = document.querySelectorAll('div, section, aside, form, dialog');
      for (let i = cands.length - 1; i >= 0; i--) {
        const c = cands[i];
        const s = getComputedStyle(c);
        if (s.position !== 'fixed' && s.position !== 'absolute') continue;
        const r = _okCandidate(c); if (!r) continue;
        best = c; bestR = r; break;
      }
    }
  }

  if (!best) return { found: false };
  ${tag ? "best.setAttribute('data-td-dialog', '1');" : ''}
  return { found: true, x: bestR.x, y: bestR.y, w: bestR.width, h: bestR.height, children: _interactiveCount(best) };
})()`;

// Probe: is a dialog-like overlay currently visible? Optionally tags the
// winning container with data-td-dialog="1" for downstream membership tests.
async function probeDialogContainer(sessionId, { tag = false } = {}) {
  try {
    const { browserAct } = require('../../browser.act.cjs');
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2500,
      text: _FIND_DIALOG_JS(tag),
    });
    const r = res?.result;
    return (r && r.found) ? r : { found: false };
  } catch (_) { return { found: false }; }
}

async function hasVisibleDialog(sessionId, opts) {
  const r = await probeDialogContainer(sessionId, opts);
  return !!r.found;
}

// Resolve the best fillable for an unnamed/"" type target directly in-page —
// doesn't depend on the map's inDialog flags. Order: focused fillable →
// largest fillable inside the detected dialog → sole visible fillable →
// largest-area fillable in the viewport middle band. Tags the winner with a
// tm- data-td-ref and returns a synthesized entry, or null.
async function resolveUnnamedFillable(sessionId) {
  try {
    const { browserAct } = require('../../browser.act.cjs');
    const res = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2500,
      text: `(() => {
        const _isFillable = (el) => {
          if (!el) return false;
          const t = el.tagName.toLowerCase();
          if (t === 'input') return !/hidden|checkbox|radio|submit|button|file/.test(el.type || 'text');
          if (t === 'textarea') return true;
          if (el.isContentEditable) return true;
          const r = el.getAttribute('role') || '';
          if (r === 'textbox' || r === 'combobox' || r === 'searchbox') return true;
          try { if (getComputedStyle(el).cursor === 'text') return true; } catch (_) {}
          return false;
        };
        const _vis = (el) => {
          const r = el.getBoundingClientRect();
          return el.isConnected && r.width > 0 && r.height > 0 &&
            (el.offsetParent !== null || getComputedStyle(el).position === 'fixed');
        };
        const _area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
        const _finish = (el) => {
          if (!el) return null;
          let ref = el.getAttribute('data-td-ref');
          if (!ref || !ref.startsWith('tm-')) {
            ref = 'tm-' + Math.random().toString(36).slice(2, 10);
            el.setAttribute('data-td-ref', ref);
          }
          const r = el.getBoundingClientRect();
          return {
            ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '',
            text: '', ariaLabel: (el.getAttribute('aria-label') || '').slice(0, 80),
            placeholder: (el.getAttribute('placeholder') || '').slice(0, 80),
            dataPlaceholder: (el.getAttribute('data-placeholder') || '').slice(0, 80),
            x: r.x, y: r.y, w: r.width, h: r.height, inDialog: !!el.closest('[data-td-dialog]'),
          };
        };

        // 1. focused fillable
        if (_isFillable(document.activeElement) && _vis(document.activeElement)) {
          return _finish(document.activeElement);
        }
        // 2. largest fillable inside detected dialog container
        const dlg = document.querySelector('[data-td-dialog]');
        if (dlg) {
          let best = null;
          for (const el of dlg.querySelectorAll('${FILLABLE_SELECTOR}')) {
            if (!_vis(el)) continue;
            if (!best || _area(el) > _area(best)) best = el;
          }
          if (best) return _finish(best);
        }
        // 3. collect visible fillables overall
        const all = [];
        for (const el of document.querySelectorAll('${FILLABLE_SELECTOR}')) {
          if (_vis(el)) all.push(el);
        }
        if (all.length === 1) return _finish(all[0]);
        if (!all.length) return null;
        // 4. largest-area fillable in the viewport middle band
        const mid = all.filter(el => {
          const r = el.getBoundingClientRect();
          const cx = r.x + r.width / 2;
          return cx > window.innerWidth * 0.1 && cx < window.innerWidth * 0.9;
        });
        const pool = mid.length ? mid : all;
        let best = pool[0];
        for (const el of pool) if (_area(el) > _area(best)) best = el;
        return _finish(best);
      })()`,
    });
    return res?.ok && res.result ? res.result : null;
  } catch (_) { return null; }
}

module.exports = {
  DIALOG_SELECTOR,
  FILLABLE_SELECTOR,
  probeDialogContainer,
  hasVisibleDialog,
  resolveUnnamedFillable,
};
