'use strict';

// ---------------------------------------------------------------------------
// browserCore/formFields.cjs — canonical form-field → semantic-key mapping +
// fillable-entry helpers for form.fill.agent (and its 'probe' action consumed
// by the stategraph gather node).
//
// Keys align with user.agent's SELF_KEYS (self:<key> profile slots) so a
// mapped key feeds resolve_form directly. Unknown/custom labels map to
// 'custom:<slug>' — user.agent falls back to `self:<slug>` + memory search.
// ---------------------------------------------------------------------------

// Ordered specific → generic; longest substring hit wins (see labelToKey).
// Keep 'name' LAST in full_name — 'first name'/'last name' must win on
// composite labels that contain the bare word "name".
const FIELD_KEYWORDS = {
  first_name:  ['first name', 'given name', 'forename', 'fname', 'first_name'],
  last_name:   ['last name', 'surname', 'family name', 'lname', 'last_name'],
  email:       ['email address', 'e-mail', 'email', 'mail'],
  phone:       ['phone number', 'phone', 'mobile', 'telephone', 'cell', 'contact number'],
  address:     ['street address', 'address line 1', 'address line', 'mailing address', 'address', 'street'],
  address2:    ['address line 2', 'apt', 'suite', 'unit', 'apartment'],
  city:        ['city', 'town'],
  state:       ['state', 'province', 'region'],
  zip:         ['zip code', 'zip', 'postal code', 'postcode', 'postal'],
  country:     ['country'],
  company:     ['company name', 'company', 'organization', 'organisation', 'business', 'employer', 'workplace'],
  job_title:   ['job title', 'title', 'position', 'occupation'],
  website:     ['website url', 'website', 'web site', 'portfolio', 'homepage', 'url'],
  dob:         ['date of birth', 'birthday', 'birth date', 'dob'],
  full_name:   ['full name', 'your name', 'display name', 'contact name', 'name'],
  subject:     ['subject', 'regarding', 'topic'],
  message:     ['your message', 'message', 'comments', 'details', 'description', 'tell us', 'additional information', 'notes', 'how can we help'],
};

// input[type] → fill strategy. Anything not listed falls back to 'text'.
// Widget hints from PROBE_SCRIPT (isDropdown/picker/chip/inputmode/pattern/mask)
// override the tag/type defaults so antd/Bootstrap widgets get real handlers.
function widgetKind(e) {
  const tag = (e.tag || '').toLowerCase();
  const type = (e.type || '').toLowerCase();
  const role = (e.role || '').toLowerCase();
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'text';
  if (e.isDropdown) return 'dropdown';
  if (e.isChip) return 'chip';
  if (e.isPicker) return 'date';
  if (e.isContentEditable || role === 'textbox' || role === 'combobox' || e.ariaAutoComplete) return 'combobox';
  if (tag !== 'input') return 'text';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (['date', 'datetime-local', 'month', 'week', 'time'].includes(type)) return 'date';
  if (type === 'number' || e.inputmode === 'numeric' || e.inputmode === 'decimal') return 'number';
  if (e.mask || e.pattern) return 'masked';
  if (type === 'range' || type === 'color' || type === 'file') return 'unsupported';
  return 'text';
}

// Normalize a value for comparison/fill per widget kind. Masked & number
// inputs auto-format on input — compare digits-only so "5550134" written by
// us verifies against the mask-rendered "555-0134".
function valueNormalize(v, kind) {
  const s = String(v == null ? '' : v).trim();
  if (kind === 'number' || kind === 'masked') return s.replace(/[^0-9.]/g, '');
  if (kind === 'date') return s.replace(/[^0-9/-]/g, '');
  return s;
}

function isFillableEntry(e) {
  if (!e || typeof e !== 'object') return false;
  const tag = (e.tag || '').toLowerCase();
  const type = (e.type || '').toLowerCase();
  const role = (e.role || '').toLowerCase();
  if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return false;
  if (tag === 'button' || role === 'button' || tag === 'a' || role === 'link') return false;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (role === 'textbox' || role === 'combobox' || e.isContentEditable || e.cursor === 'text') return true;
  return false;
}

// Best human-facing label for a tab-map entry — mirrors entryLabel's chain
// without pulling the whole module (callers may also pass entryLabel output).
function fieldLabel(e) {
  if (!e || typeof e !== 'object') return '';
  return (e.text || e.ariaLabel || e.placeholder || e.dataPlaceholder || '').trim();
}

// Deterministic label → canonical key. Longest keyword hit wins so
// "First Name" → first_name beats "name" → full_name.
function labelToKey(label) {
  const l = String(label || '').toLowerCase().replace(/[*:()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!l) return null;
  let bestKey = null, bestLen = 0;
  for (const [key, keywords] of Object.entries(FIELD_KEYWORDS)) {
    for (const kw of keywords) {
      // Short keywords need a word-boundary hit so 'name' doesn't match
      // 'username' and 'state' doesn't match 'statement'.
      const hit = kw.length <= 5
        ? new RegExp('(^|[^a-z])' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(l)
        : l.includes(kw);
      if (hit && kw.length > bestLen) { bestKey = key; bestLen = kw.length; }
    }
  }
  if (!bestKey && /^[a-z_]{3,30}$/.test(l) && (l === 'name' || l === 'nombre')) bestKey = 'full_name';
  return bestKey;
}

// Required heuristic for probe/tab-map entries: explicit flags first, then a
// '*' in the label text, else assume required when the field is empty inside a
// form (missing-value asks are the expensive path — err toward asking).
function isRequiredEntry(e) {
  if (e.required === true || e.ariaRequired === true) return true;
  const l = fieldLabel(e);
  if (/\*\s*$|required/i.test(l)) return true;
  return false;
}

// ── Compact DOM probe (no tab-map scan) ─────────────────────────────────────
// Used by form.fill.agent {action:'probe'} — the stategraph gather node calls
// it pre-plan so missing-field questions are field-specific. Read-only.
const PROBE_SCRIPT = `(() => {
  const els = document.querySelectorAll('input, textarea, select, [role="textbox"], [role="combobox"], [contenteditable="true"], [contenteditable=""]');
  const vis = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const labelOf = el => {
    if (el.id) {
      const l = document.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]');
      if (l) return l.innerText.trim().slice(0, 80);
    }
    const al = el.getAttribute('aria-labelledby');
    if (al) { const t = document.getElementById(al); if (t) return t.innerText.trim().slice(0, 80); }
    const wrapped = el.closest('label');
    if (wrapped) return wrapped.innerText.trim().slice(0, 80);
    // Container-label pattern (antd .ant-form-item, Bootstrap .form-group,
    // generic .field/.form-field wrappers): the label sits in a sibling
    // label element inside the field's wrapper, not linked by for=.
    const wrap = el.closest('[class*="form-item"], [class*="form-group"], [class*="form-field"], [class*="field-wrapper"], fieldset');
    if (wrap) {
      const l = wrap.querySelector('label, [class*="-label"], legend');
      if (l) { const t = l.innerText.trim().slice(0, 80); if (t) return t; }
    }
    // Humanized id/name when it looks semantic (first-name → "first name");
    // skip generated ids (input-3, uid-…, uuid-like).
    const humanize = s => String(s || '').replace(/[_-]+/g, ' ').trim();
    const semantic = s => /^[a-z][a-z0-9_-]{1,40}$/i.test(String(s || '')) && !/^(input|field|uid|uuid|el|cmp|cmp-\d)[-_]?\d*$/i.test(String(s)) && /[a-z]{2}/i.test(String(s));
    if (semantic(el.name)) return humanize(el.name).slice(0, 80);
    if (semantic(el.id)) return humanize(el.id).slice(0, 80);
    const parentText = (() => { const p = el.closest('div, fieldset, li, td'); return p && p !== el ? (p.innerText || '').split('\\n')[0].trim().slice(0, 80) : ''; })();
    return (el.getAttribute('aria-label') || el.placeholder || el.getAttribute('data-placeholder') || parentText || '').toString().trim().slice(0, 80);
  };
  const cssPath = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    if (el.name && document.querySelectorAll('[name="' + el.name.replace(/"/g, '') + '"]').length === 1) return '[name="' + el.name + '"]';
    const parts = [];
    let n = el;
    while (n && n !== document.body && parts.length < 5) {
      const tag = n.tagName.toLowerCase();
      const sib = n.parentElement ? [...n.parentElement.children].filter(c => c.tagName === n.tagName) : [n];
      parts.unshift(sib.length > 1 ? tag + ':nth-of-type(' + (sib.indexOf(n) + 1) + ')' : tag);
      n = n.parentElement;
    }
    return parts.join('>');
  };
  let ffIdx = 0;
  const out = [];
  for (const el of els) {
    if (!vis(el) || el.disabled || el.readOnly) continue;
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.type || 'text') : '';
    if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
    if (el.tabIndex < 0) continue;
    const role = el.getAttribute('role') || '';
    const label = labelOf(el);
    const required = !!(el.required || el.getAttribute('aria-required') === 'true' || /\\*\\s*$/.test(label));
    const hasValue = tag === 'select' ? !!el.value : !!String(el.value || '').trim();
    const ref = 'ff' + (++ffIdx);
    el.setAttribute('data-td-ref', ref);
    // Widget hints for specialized fill strategies (see widgetKind):
    const isDropdown = role === 'combobox' && (
      !!el.closest('.ant-select, [class*="select" i], [class*="dropdown" i]')
      || el.getAttribute('aria-haspopup') === 'listbox'
      || el.getAttribute('aria-expanded') != null);
    const isPicker = !!el.closest('.ant-picker, [class*="datepicker" i], [class*="date-picker" i]');
    const isChip = !!el.closest('[class*="chip" i], [class*="tag" i], [role="listbox"][aria-multiselectable="true"]');
    const mask = (el.placeholder || '').replace(/\\d/g, 'x');
    out.push({ label, tag, type, role, name: el.name || '', required, hasValue, ref,
      selector: cssPath(el), isContentEditable: !!el.isContentEditable,
      isDropdown, isPicker, isChip,
      inputmode: el.getAttribute('inputmode') || '',
      pattern: el.getAttribute('pattern') || '',
      mask: /x{2,}/.test(mask) ? mask : '' });
    if (out.length >= 40) break;
  }
  return JSON.stringify({ url: location.href, fields: out });
})()`;

module.exports = {
  FIELD_KEYWORDS,
  widgetKind,
  valueNormalize,
  isFillableEntry,
  fieldLabel,
  labelToKey,
  isRequiredEntry,
  PROBE_SCRIPT,
};
