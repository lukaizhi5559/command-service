'use strict';

// ---------------------------------------------------------------------------
// browserCore/focusField.cjs — focus-establishment primitives for atomic agents.
// Extracted from instruction.runner.cjs (_tabToRef, _slimReadActiveElement) plus
// ensureFieldFocused: ordered focus resolution (already-focused shortcut → CSS
// click → identity re-resolution → guarded tab-walk → verify).
// Runner internals are reached via lazy require (_r) to avoid circular
// module loads — same pattern as playwright.agent.cjs.
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { browserAct } = require('../../browser.act.cjs');

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _R = null;
const _r = () => (_R ||= require('../../instruction.runner.cjs'));
const _readActiveElement = (...a) => _r()._readActiveElement(...a);


// ── Tab-to-ref: navigate to a target ref via Tab/ArrowRight key presses ──
// Backup focus mechanism for React comboboxes (Gmail To/CC/BCC) where
// el.focus() (untrusted programmatic call) doesn't move document.activeElement,
// but Tab (trusted browser-level keyboard event) does.
//
// Focus-transition model: before each press we snapshot the focused element's
// signature {ref, role, tag, text, x, y}; after the press we compare. If the
// signature is unchanged the key didn't move focus — try the alternate key
// once, then abort. A visited-signature set catches wandering cycles (e.g.
// Gmail inbox rows swallowing ArrowRight forever) that a starter-only check
// never detects. Skipped entirely when focus starts on <body> — key-walking
// from page-top can't reach dialog-internal fields and just burns presses.
const _focusSig = (el) => el ? `${el.ref}|${el.role}|${el.tag}|${el.text}|${el.x},${el.y}` : 'none';
async function _tabToRef(sessionId, targetRef, maxSteps = 15) {
  if (!targetRef) return false;
  const starter = await _slimReadActiveElement(sessionId);
  if (!starter || !starter.ref) {
    logger.info('[focusField] _tabToRef: focus on <body>/null — key-walk skipped (target unreachable)');
    return false;
  }
  const starterSig = _focusSig(starter);
  const visited = new Set([starterSig]);
  for (let i = 0; i < maxSteps; i++) {
    const current = await _slimReadActiveElement(sessionId);
    if (current?.ref === targetRef) return true;
    const prevSig = _focusSig(current);
    // ArrowRight first (same as scan), then Tab
    await browserAct({ action: 'press', sessionId, key: 'ArrowRight', headed: true, timeoutMs: 2000 });
    await _sleep(20);
    let after = await _slimReadActiveElement(sessionId);
    if (after?.ref === targetRef) return true;
    let afterSig = _focusSig(after);
    if (afterSig === prevSig || visited.has(afterSig)) {
      // ArrowRight didn't move focus (or re-entered a visited element) — try Tab
      await browserAct({ action: 'press', sessionId, key: 'Tab', headed: true, timeoutMs: 2000 });
      await _sleep(20);
      after = await _slimReadActiveElement(sessionId);
      if (after?.ref === targetRef) return true;
      afterSig = _focusSig(after);
      if (afterSig === prevSig || visited.has(afterSig)) {
        logger.info(`[focusField] _tabToRef: focus stuck after ArrowRight+Tab at ${afterSig.slice(0, 60)} — aborting`);
        return false;
      }
    }
    if (afterSig === starterSig) break; // looped back to start — not reachable
    visited.add(afterSig);
  }
  return false;
}

// ── Slim active-element read for buildTabMap fast phase ────────────────
// Returns ONLY the fields needed for loop control during focus-cycling:
//   { ref, role, tag, text(40ch), x, y, inDropdown }
// This is ~400 bytes vs the 4KB _readActiveElement script, cutting
// per-element evaluate time by ~90%. Full metadata is extracted in bulk
// AFTER the scan via _bulkReadTabMapMetadata.


// ── Slim active-element read for buildTabMap fast phase ────────────────
// Returns ONLY the fields needed for loop control during focus-cycling:
//   { ref, role, tag, text(40ch), x, y, inDropdown }
// This is ~400 bytes vs the 4KB _readActiveElement script, cutting
// per-element evaluate time by ~90%. Full metadata is extracted in bulk
// AFTER the scan via _bulkReadTabMapMetadata.
async function _slimReadActiveElement(sessionId) {
  const res = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
    text: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      let ref = el.getAttribute('data-td-ref');
      if (!ref || !ref.startsWith('tm-')) {
        ref = 'tm-' + Math.random().toString(36).slice(2, 10);
        el.setAttribute('data-td-ref', ref);
      }
      const role = el.getAttribute('role') || '';
      const tag = el.tagName.toLowerCase();
      const r = el.getBoundingClientRect();
      let text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (!text) text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
      const inDropdown = ['menuitem','menuitemcheckbox','menuitemradio','option'].includes(role) ||
                         (!['input','textarea'].includes(tag) && role !== 'combobox' && role !== 'textbox' &&
                          !!el.closest('[role="menu"], [role="listbox"]'));
      return { ref, role, tag, text, x: Math.round(r.x), y: Math.round(r.y), inDropdown };
    })()`,
  });
  try {
    const raw = res?.result;
    return typeof raw === 'string' ? JSON.parse(raw.replace(/^"|"$/g, '').replace(/\\"/g, '"')) : raw;
  } catch { return null; }
}

// ── Bulk metadata extraction for buildTabMap ───────────────────────────
// After the fast focus-cycling phase assigns data-td-ref to all elements,
// this ONE call queries all [data-td-ref^="tm-"] elements and returns
// full metadata (tag, role, text, ariaLabel, placeholder, value, rect,
// inDropdown, isIconLike, hasSvg, etc.) as a JSON array.
// Replaces the per-element _readActiveElement calls (4KB each × N elements)
// with a single ~2KB query that runs once at the end.

// Lazy access to tabMap.cjs helpers (it requires us — must stay lazy).
let _TM = null;
const _tm = () => (_TM ||= require('./tabMap.cjs'));

// ── ensureFieldFocused — ordered focus establishment for a picked entry ─────
// The interaction contract for "Type X into field Y"-style steps:
//   1. already-focused shortcut — never click a field that holds focus
//      (Gmail compose auto-focuses To; clicking can collapse the field)
//   2. CSS click on [data-td-ref]
//   3. state check → identity re-resolution: if the tagged node is hidden or
//      detached (Gmail collapses/re-renders recipients rows between scan and
//      click), find the currently-visible element matching the entry's
//      identity, retag it with the same ref, retry once. No visible
//      counterpart → stateChanged so the caller rescans instead of failing.
//   4. _tabToRef — last resort, focus-transition guarded
//   5. verify document.activeElement carries the ref
// Returns { ok, focusedElement?, via?, stateChanged?, error? }
async function ensureFieldFocused(sessionId, entry, opts = {}) {
  const ref = entry?.ref;
  if (!ref) return { ok: false, error: 'entry has no ref' };
  const label = (entry.text || entry.ariaLabel || entry.placeholder || '').trim();

  // ── 1. Just-type shortcut ──
  const active = await _readActiveElement(sessionId).catch(() => null);
  if (active && active.ref === ref) {
    logger.info(`[focusField] already focused ref=${ref} — skipping click`);
    return { ok: true, focusedElement: active, via: 'already-focused' };
  }
  if (active && label) {
    const aTag = (active.tag || '').toLowerCase();
    const aRole = (active.role || '').toLowerCase();
    const fillable = ['input', 'textarea'].includes(aTag) ||
      ['textbox', 'combobox', 'searchbox'].includes(aRole) || !!active.isContentEditable;
    const aLabel = (active.text || active.ariaLabel || active.placeholder || '').toLowerCase();
    if (fillable && aLabel && _tm()._fuzzyTextMatch(label.toLowerCase(), aLabel)) {
      logger.info(`[focusField] focused fillable "${aLabel.slice(0, 40)}" matches "${label.slice(0, 40)}" — typing into it`);
      return { ok: true, focusedElement: active, via: 'focused-match' };
    }
  }

  const selector = `[data-td-ref="${ref}"]`;

  // ── 2. State check BEFORE click — a hidden node can't be clicked, and the
  // same probe doubles as identity re-resolution for collapsed/stale refs.
  const state = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
    text: `(() => {
      const ref = ${JSON.stringify(ref)};
      const el = document.querySelector('[data-td-ref="' + ref + '"]');
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        if (!e.isConnected || r.width <= 0 || r.height <= 0) return false;
        try { if (e.checkVisibility && !e.checkVisibility()) vis = false; } catch (_) {}
        return true;
      };
      if (!el) return { status: 'detached' };
      if (vis(el)) return { status: 'visible' };
      // Hidden/collapsed — find a visible counterpart by identity.
      // Candidates: interactive selector ∪ ALL scan-tagged [data-td-ref]
      // elements (tagged = known-interactive at scan time). Label match uses
      // token overlap so "To recipients" can match a "Recipients" row.
      const label = ${JSON.stringify(label.toLowerCase())};
      const wantTag = ${JSON.stringify((entry.tag || '').toLowerCase())};
      const wantRole = ${JSON.stringify((entry.role || '').toLowerCase())};
      const tokens = label.split(/\\s+/).filter(t => t.length > 1);
      const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i]')]
        // offsetParent is null for position:fixed modals — don't exclude them
        .filter(d => (d.offsetParent !== null || getComputedStyle(d).position === 'fixed') && d.getBoundingClientRect().width > 0);
      const scopes = dialogs.length ? dialogs : [document];
      const seen = new Set();
      let best = null, bestScore = 0;
      for (const scope of scopes) {
        const pool = scope.querySelectorAll('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="button"], button, [role="listitem"], [role="option"], [role="menuitem"], a, td, [role="gridcell"], [role="row"], [data-td-ref]');
        for (const e of pool) {
          if (e === el || seen.has(e) || !vis(e)) continue;
          seen.add(e);
          const eLabel = (e.getAttribute('aria-label') || e.getAttribute('placeholder') || (e.innerText || '').trim().replace(/\\s+/g, ' ')).toLowerCase().slice(0, 80);
          const eRole = (e.getAttribute('role') || '').toLowerCase();
          const eTag = e.tagName.toLowerCase();
          let score = 0;
          if (label && eLabel && (eLabel.includes(label.slice(0, 40)) || label.includes(eLabel.slice(0, 40)))) score += 2;
          if (tokens.length && eLabel && tokens.some(t => eLabel.includes(t))) score += 1;
          if (wantRole && eRole === wantRole) score += 1;
          if (wantTag && eTag === wantTag) score += 1;
          if (score > bestScore) { best = e; bestScore = score; }
        }
      }
      if (best && bestScore >= 2) {
        document.querySelectorAll('[data-td-ref="' + ref + '"]').forEach(n => n.removeAttribute('data-td-ref'));
        best.setAttribute('data-td-ref', ref);
        const br = best.getBoundingClientRect();
        return { status: 'resolved', x: Math.round(br.x), y: Math.round(br.y) };
      }
      return { status: 'collapsed' };
    })()`,
  }).catch(() => null);
  const st = state?.result?.status;
  if (st && st !== 'visible') logger.info(`[focusField] ref=${ref} pre-click state=${st}`);

  // ── 3. CSS click (skipped on detached; after 'resolved' the counterpart
  // carries the same ref so the selector just works) ──
  let clickOk = false;
  if (st !== 'detached') {
    try {
      const r = await browserAct({ action: 'click', sessionId, selector, headed: true, timeoutMs: 2000 });
      clickOk = !!r?.ok;
    } catch (_) {}
  }

  // ── 4. Coordinate fallback — verify-gated ──
  // The entry's recorded rect may still point at the right region even when the
  // ref is dead (a collapsed Gmail "Recipients" row occupies the expanded
  // input's area — clicking it expands the field and autofocuses the input).
  // Guards: elementFromPoint must hit something interactive-ish before we
  // click, and the post-focus verify (step 6) must pass — never type blind.
  if (!clickOk && Number.isFinite(entry?.x) && Number.isFinite(entry?.y) && (entry.w || entry.h)) {
    const cx = Math.round(entry.x + (entry.w || 0) / 2);
    const cy = Math.round(entry.y + (entry.h || 0) / 2);
    const gate = await browserAct({
      action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
      text: `(() => {
        const hit = document.elementFromPoint(${cx}, ${cy});
        if (!hit) return { ok: false };
        const interactive = hit.closest('input, textarea, [contenteditable], [role="textbox"], [role="combobox"], [role="button"], button, a, [role="row"], [role="gridcell"], [role="listitem"], [data-td-ref]') ||
                            hit.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i]');
        const tag = hit.tagName.toLowerCase();
        const hitLabel = (hit.getAttribute('aria-label') || hit.getAttribute('placeholder') || (hit.innerText || '').trim().replace(/\\s+/g, ' ')).slice(0, 60);
        return { ok: !!interactive, tag, label: hitLabel };
      })()`,
    }).catch(() => null);
    if (gate?.result?.ok) {
      logger.info(`[focusField] coord-fallback at (${cx},${cy}) → hit ${gate.result.tag} "${gate.result.label}"`);
      try {
        const r3 = await browserAct({ action: 'clickAt', sessionId, x: cx, y: cy, headed: true, timeoutMs: 3000 });
        clickOk = !!r3?.ok;
        if (clickOk) await _sleep(250); // let expander clicks take effect
      } catch (_) {}
    } else {
      logger.info(`[focusField] coord-fallback (${cx},${cy}) — elementFromPoint not interactive, skipping`);
    }
  }

  // ── 5. Guarded tab walk ──
  if (!clickOk) {
    const tabbed = await _tabToRef(sessionId, ref);
    if (!tabbed) {
      if (st === 'collapsed' || st === 'detached') {
        return { ok: false, stateChanged: true, error: `target "${label}" node ${st} — rescan needed` };
      }
      return { ok: false, error: `click + tab-walk failed to focus "${label || ref}"` };
    }
  }

  // ── 6. Verify focus landed on the target (or a label-matching fillable —
  // an expander click focuses the inner input, which carries a different ref) ──
  await _sleep(150);
  const check = await browserAct({
    action: 'evaluate', sessionId, headed: true, timeoutMs: 2000,
    text: `(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { matches: false };
      let ref = el.getAttribute('data-td-ref') || '';
      if (!ref && el.isContentEditable) {
        try {
          const sel = window.getSelection();
          if (sel && sel.rangeCount > 0) {
            let node = sel.getRangeAt(0).startContainer;
            if (node.nodeType === 3) node = node.parentElement;
            while (node && !node.isContentEditable) node = node.parentElement;
            if (node && node !== el) ref = node.getAttribute('data-td-ref') || '';
          }
        } catch (_) {}
      }
      const tag = el.tagName.toLowerCase();
      const role = (el.getAttribute('role') || '').toLowerCase();
      const fillable = ['input', 'textarea'].includes(tag) ||
        ['textbox', 'combobox', 'searchbox'].includes(role) || !!el.isContentEditable;
      const aLabel = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
      return { matches: ref === ${JSON.stringify(ref)}, activeRef: ref, fillable, aLabel };
    })()`,
  }).catch(() => null);
  const res = check?.result;
  const labelOk = !!(res?.fillable && res?.aLabel && label &&
    _tm()._fuzzyTextMatch(label.toLowerCase(), res.aLabel));
  if (!res?.matches && !labelOk) {
    return { ok: false, error: `focus not on target (activeRef=${res?.activeRef || 'none'}, expected=${ref})` };
  }
  const focused = await _readActiveElement(sessionId).catch(() => null);
  return { ok: true, focusedElement: focused || entry };
}


module.exports = {
  _tabToRef,
  _slimReadActiveElement,
  ensureFieldFocused,
};
