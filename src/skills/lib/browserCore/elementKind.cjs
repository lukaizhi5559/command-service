'use strict';

// ---------------------------------------------------------------------------
// browserCore/elementKind.cjs — shared per-entry label + kind inference.
//
// Elements with no text/aria/placeholder surface get an inferred kind from
// geometry + cursor (signals a site can't avoid when the element is visible).
// Used consistently by render (_label fallbacks), pick (candidateText), and
// verify (label mismatch) paths so the name the LLM saw is the name that
// matches — fixes "picked '' for target 'text field'" reject loops.
// ---------------------------------------------------------------------------

// Infer an element's functional kind from tag/role/cursor/geometry.
// Returns '' when nothing can be inferred (don't fabricate labels).
function inferEntryKind(e) {
  if (!e || typeof e !== 'object') return '';
  const tag = e.tag || '', role = e.role || '';
  if (e.isContentEditable || e.cursor === 'text' ||
      role === 'textbox' || role === 'combobox' ||
      tag === 'input' || tag === 'textarea') return 'text field';
  if (tag === 'button' || role === 'button' || e.cursor === 'pointer') return 'button';
  if (e.hasSvg && e.w > 0 && e.w <= 56 && e.h > 0 && e.h <= 56) return 'icon button';
  if (tag === 'a' || role === 'link') return 'link';
  return '';
}

// Full label fallback chain — the single surface every consumer should use.
function entryLabel(e) {
  if (!e || typeof e !== 'object') return '';
  return e.text || e.ariaLabel || e.placeholder || e.dataPlaceholder ||
         e.ariaRoleDescription || inferEntryKind(e);
}

// Labels inferEntryKind can emit — when the LLM echoes one of these back as a
// target, treat it as unnamed and resolve deterministically (many entries can
// share an inferred kind; label matching can't disambiguate them).
const GENERIC_KIND_TARGETS = new Set([
  'field', 'text field', 'input', 'textbox', 'button', 'icon button', 'link',
]);

// Truncation-safe value preview — a bare slice("...") reads as a *partial*
// field value to the LLM and triggers needless "clear and retype" fixations.
// Long values get an ellipsis + total length so the preview is unambiguous.
function previewValue(v, max = 60) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (${s.length} chars)`;
}

module.exports = { inferEntryKind, entryLabel, GENERIC_KIND_TARGETS, previewValue };
