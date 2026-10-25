'use strict';

// ---------------------------------------------------------------------------
// browserCore/shapeMap.cjs — derive a persistable page SHAPE from a tab.map
// scan. The shape is the page's cached identity: semantic-role fields, the
// submit control, a surface signature, and a revalidation fingerprint.
//
// ref-ids are per-scan ephemeral and are NEVER part of the shape — we cache
// the recipe for finding each element (stable selector), not the element's
// scan index. Selector stability ranking: aria-label > data-testid > name
// > role+name > placeholder > type-hint. Positional selectors are avoided
// entirely — SPAs reorder DOM constantly.
// ---------------------------------------------------------------------------

// Semantic-role lexicon — label/placeholder/aria text → canonical field role.
const ROLE_RULES = [
  [/title|subject|name\b|event name/i, 'title'],
  [/\bto\b|recipient|e-?mail/i, 'recipient'],
  [/\bcc\b|\bbcc\b/i, 'cc'],
  [/start.*date|date\b/i, 'date'],
  [/end.*date|until/i, 'endDate'],
  [/start.*time|^time\b|when\b/i, 'time'],
  [/end.*time/i, 'endTime'],
  [/location|where\b|venue|place/i, 'location'],
  [/search|query|find\b/i, 'search'],
  [/desc|notes?|body|message|details/i, 'body'],
  [/url|link\b|website/i, 'url'],
  [/phone|tel\b/i, 'phone'],
  [/amount|price|cost|total/i, 'amount'],
];
const SUBMIT_ROLE_RE = /\b(save|submit|send|post|publish|create|add|confirm|apply|book|order|schedule|done)\b/i;

function _stableSelector(e) {
  const tag = (e.tag || 'input').toLowerCase();
  if (e.ariaLabel) return `${tag}[aria-label*="${e.ariaLabel.slice(0, 40).replace(/"/g, '')}" i]`;
  if (e.placeholder) return `${tag}[placeholder*="${e.placeholder.slice(0, 40).replace(/"/g, '')}" i]`;
  if (e.dataPlaceholder) return `${tag}[data-placeholder*="${e.dataPlaceholder.slice(0, 40).replace(/"/g, '')}" i]`;
  if (e.role) return `[role="${e.role}"]`;
  if (e.type && e.type !== 'text') return `${tag}[type="${e.type}"]`;
  return null; // positional only — not cacheable
}

function _semanticRole(e) {
  const hay = `${e.ariaLabel || ''} ${e.placeholder || ''} ${e.dataPlaceholder || ''} ${e.text || ''}`;
  for (const [re, role] of ROLE_RULES) if (re.test(hay)) return role;
  return null;
}

const _FILLABLE_TAGS = new Set(['input', 'textarea', 'select']);
function _isFillable(e) {
  return _FILLABLE_TAGS.has((e.tag || '').toLowerCase())
    || e.isContentEditable === true
    || e.role === 'textbox' || e.role === 'combobox';
}

/**
 * deriveShape(tabMap, {url, dialogOpen}) → shape record for saveFormMap.
 * Returns null when the page has no form structure (pure listing/feed/read).
 */
function deriveShape(tabMap, { url = '', dialogOpen = false, includeRefs = false } = {}) {
  if (!Array.isArray(tabMap) || !tabMap.length) return null;
  const fields = [];
  let submit = null;
  let clickables = 0;

  for (const e of tabMap) {
    if (e.disabled) continue;
    const selector = _stableSelector(e);
    if (!selector) continue;
    if (_isFillable(e)) {
      fields.push({
        key: (e.ariaLabel || e.placeholder || e.text || `field_${fields.length}`).slice(0, 60),
        semanticRole: _semanticRole(e),
        selector,
        required: e.required === true || /required|\*/i.test(e.ariaLabel || ''),
        currentValue: e.currentValue ?? e.value ?? undefined,
        ...(includeRefs && e.ref ? { ref: e.ref } : {}),
      });
    } else if ((e.tag === 'button' || e.role === 'button') && !submit) {
      clickables++;
      const label = `${e.ariaLabel || ''} ${e.text || ''}`;
      if (SUBMIT_ROLE_RE.test(label)) {
        submit = { selector, semanticRole: 'submit', text: (e.text || e.ariaLabel || '').slice(0, 60), ...(includeRefs && e.ref ? { ref: e.ref } : {}) };
      }
    } else {
      clickables++;
    }
  }

  if (!fields.length) return null;

  // Page category from shape — the deterministic classifier that replaces
  // the LLM guess: form (fillables + submit), else generic.
  const pageCategory = submit ? 'form' : 'form'; // fields exist → form regardless of submit

  return {
    pageCategory,
    url,
    scanTs: Date.now(),
    fields,
    submit,
    signature: {
      dialogOpen: !!dialogOpen,
      hasForm: true,
      elementStats: { fillables: fields.length, clickables },
    },
    postcondition: submit ? { dialogCloses: true } : null,
    fingerprint: [...fields.slice(0, 3).map(f => f.selector), submit?.selector].filter(Boolean),
  };
}

/**
 * fingerprintOk(shape, resolveFn) — cheap reuse validation: do the shape's
 * key selectors still resolve on the live page? resolveFn = sync
 * querySelector bound to a page eval. Dynamic sites churn; a stale map gets
 * dropped and rescanned rather than mis-typed into.
 */
function fingerprintOk(shape, existsInPage) {
  if (!shape?.fingerprint?.length) return false;
  let hits = 0;
  for (const sel of shape.fingerprint) { if (existsInPage(sel)) hits++; }
  return hits >= Math.max(1, Math.ceil(shape.fingerprint.length * 0.6));
}

module.exports = { deriveShape, fingerprintOk, _stableSelector };
