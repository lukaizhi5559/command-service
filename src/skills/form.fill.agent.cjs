'use strict';

// ---------------------------------------------------------------------------
// form.fill.agent.cjs — Atomic agent: orchestrated multi-field form fill.
//
//   scan → map labels→keys → resolve values (user.agent) → ask only missing
//   required fields (batched gather) → fill deterministically → verify.
//
// Contract:
//   args: { goal|task, sessionId, fields?, resolvedFields?, gatheredAnswers?,
//           submit?, overwrite?, maxSteps?, _progressCallbackUrl?,
//           _gatherAnswerCallback?, action? }
//
//   action 'probe'  — read-only field discovery + memory resolution used by
//                     the stategraph gather node so missing-field questions are
//                     field-specific BEFORE the plan is written.
//                     returns { ok, url, fields, resolved, missing, allResolved }
//
//   default run     — fills the form on the bound session. NEVER submits
//                     unless submit:true and the goal doesn't forbid it:
//                     a capture-phase DOM guard blocks submit/requestSubmit/
//                     implicit Enter submission, submit-class elements are
//                     never clicked, and leftovers go to tab.map with
//                     noSubmit:true.
//
//   returns { ok, output?, error?, filledFields, missingFields, asked,
//             leftoversHandled, verification, sessionId }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { userAgent } = require('./user.agent.cjs');
const { tabMapAgent } = require('./tab.map.agent.cjs');
const { withSessionMutex, resolveExtSession } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const {
  widgetKind, valueNormalize, isFillableEntry, fieldLabel, labelToKey, isRequiredEntry, PROBE_SCRIPT,
} = require('./lib/browserCore/formFields.cjs');

const MAX_FIELDS = 40;
const MAX_LLM_LABELS = 30;

// "fill ... but don't submit / without submitting / leave it ready" — a
// negated-submit phrase ALWAYS wins over an explicit submit:true arg.
const NEG_SUBMIT_RE = /don'?t\s+submit|do\s+not\s+submit|without\s+submit|never\s+submit|no\s+submi|don'?t\s+send|do\s+not\s+send|without\s+send|don'?t\s+save|leave\s+(?:it|the\s+form)\s+(?:ready|open|unsent|unsubmitted)|fill\s+(?:only|but)|just\s+fill/i;

// Capture-phase guard: blocks <form> submit events (incl. implicit Enter
// submission), form.submit() and form.requestSubmit(). Installed by default;
// the ONLY way a fill run submits is submit:true with an unnegated goal.
const NO_SUBMIT_GUARD = `(() => {
  if (window.__tdNoSubmitInstalled) return true;
  window.__tdNoSubmitInstalled = true;
  window.__tdBlockedSubmits = 0;
  const block = (e) => {
    window.__tdBlockedSubmits++;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return false;
  };
  document.addEventListener('submit', block, true);
  try {
    HTMLFormElement.prototype.submit = function () { window.__tdBlockedSubmits++; };
    if (HTMLFormElement.prototype.requestSubmit) {
      HTMLFormElement.prototype.requestSubmit = function () { window.__tdBlockedSubmits++; };
    }
  } catch (_) {}
  return true;
})()`;

// ── evaluate result unwrapping ──────────────────────────────────────────────
// engine evaluate returns {result}; ext returns the raw value (sometimes a
// JSON string, sometimes already-decoded). Normalize to a JS value.
function _unwrapEval(res) {
  if (!res || !res.ok) return null;
  let v = res.result !== undefined ? res.result : res.stdout;
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || s.startsWith('{') || s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (typeof parsed === 'string' && (parsed.trim().startsWith('{') || parsed.trim().startsWith('['))) {
          try { return JSON.parse(parsed); } catch (_) { return parsed; }
        }
        return parsed;
      } catch (_) { return s; }
    }
    return s;
  }
  return v;
}

// ── Memory resolution ───────────────────────────────────────────────────────
async function _resolveValues(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return { resolved: {}, missingFields: [] };
  try {
    const res = await userAgent({ action: 'resolve_form', fields: unique });
    return {
      resolved: res?.resolved || {},
      missingFields: res?.missingFields || [],
      summary: res?.summary,
    };
  } catch (e) {
    logger.warn(`[form.fill] user.agent resolve_form failed: ${e.message}`);
    return { resolved: {}, missingFields: unique };
  }
}

// ── LLM label→key mapping for labels the keyword table missed ───────────────
async function _llmMapLabels(labels) {
  if (!labels.length) return {};
  const canonical = ['first_name', 'last_name', 'full_name', 'email', 'phone', 'address', 'city', 'state', 'zip', 'country', 'company', 'job_title', 'website', 'dob', 'subject', 'message'];
  const prompt = `You are mapping web-form field labels to canonical profile keys.

Canonical keys: ${canonical.join(', ')}

Rules:
- Return a JSON object: {"<label>": "<key>"}
- If a label doesn't fit a canonical key but is a named custom attribute (e.g. "Rider number", "Team name"), map it to "custom:<slugified_label>".
- If a label is not a fillable user-data field (search box, captcha, file upload, newsletter checkbox), map it to "ignore".

Labels:
${labels.map((l) => `- "${l}"`).join('\n')}

JSON object only, no prose.`;
  // ── Local decision fast path — one batched choice per label ─────────────
  // Custom-attribute slugs are deterministic (slugify the label), so the
  // model only picks: canonical key | custom | ignore.
  if (labels.length <= 12) {
    const _decision = require('../skill-helpers/decision.cjs');
    const _slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    const _qs = labels.map((label, i) => ({
      id: `l${i}`, type: 'choice',
      question: `Map the web-form field label "${label}" to a canonical profile key. Pick "custom" if it's a named custom attribute (e.g. "Rider number"), or "ignore" if it is not a fillable user-data field (search box, captcha, file upload, newsletter checkbox).`,
      options: [...canonical, 'custom', 'ignore'],
    }));
    const _map = await _decision.boundedDecision({
      site: 'formFill.labelMap',
      questions: _qs,
      state: `Canonical keys: ${canonical.join(', ')}\nLabels: ${labels.join(', ')}`,
      local: (a) => {
        const out = {};
        labels.forEach((label, i) => {
          const idx = a[`l${i}`]?.index;
          if (idx == null) return;
          if (idx < canonical.length) out[label] = canonical[idx];
          else if (idx === canonical.length) out[label] = `self:${_slug(label)}`;
          // 'ignore' → omit
        });
        return Object.keys(out).length ? out : null;
      },
      remote: async () => null,
      logger,
    });
    if (_map) {
      logger.info(`[form.fill] local decision mapped ${Object.keys(_map).length}/${labels.length} labels`);
      return _map;
    }
  }
  try {
    const resp = await askWithMessages([{ role: 'user', content: prompt }]);
    const text = String(resp || '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return {};
    const parsed = JSON.parse(m[0]);
    const out = {};
    for (const [label, key] of Object.entries(parsed)) {
      if (typeof key === 'string' && key !== 'ignore') out[label] = key.startsWith('custom:') ? `self:${key.slice(7)}` : key;
    }
    return out;
  } catch (e) {
    logger.warn(`[form.fill] LLM label mapping failed: ${e.message}`);
    return {};
  }
}

// ── action:'probe' — gather-phase read-only field scan ──────────────────────
async function _probeForm(args) {
  const sessionId = await resolveExtSession(args.sessionId || 'ext:default');
  const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: PROBE_SCRIPT });
  const data = _unwrapEval(res);
  if (!data || !Array.isArray(data.fields)) {
    return { ok: false, error: `form probe failed: ${res?.error || 'no fields returned'}`, sessionId };
  }
  const fields = data.fields
    .filter((f) => (f.tag === 'input' ? f.type !== 'password' : true))
    .map((f) => ({ ...f, label: f.label || f.name || '', key: labelToKey(f.label || f.name) }));

  // Resolve keys through memory/profile so the gather phase knows what's missing
  const keys = fields.map((f) => f.key).filter(Boolean);
  const { resolved, missingFields } = await _resolveValues(keys);
  const missing = fields
    .filter((f) => f.key && !f.hasValue && !(resolved[f.key] || resolved[`self:${f.key}`]))
    .map((f) => ({ key: f.key, label: f.label, required: f.required }));

  return {
    ok: true,
    url: data.url,
    sessionId,
    fields: fields.map((f) => ({ label: f.label, key: f.key, tag: f.tag, type: f.type, required: f.required, hasValue: f.hasValue })),
    resolved,
    missing,
    allResolved: missing.length === 0,
  };
}

// ── Per-entry deterministic fill ────────────────────────────────────────────
async function _fillEntry(sessionId, entry, value, overwrite) {
  const ref = entry.ref;
  if (!ref) return { ok: false, reason: 'no-ref' };
  const kind = widgetKind(entry);
  const label = fieldLabel(entry);

  if (kind === 'unsupported') return { ok: false, reason: 'unsupported-widget' };

  if (kind === 'checkbox') {
    const want = /^(1|true|yes|checked|on)$/i.test(String(value).trim());
    const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return null;
      if (el.checked !== ${want}) { el.scrollIntoView({block:'center'}); el.click(); }
      return el.checked;
    })()` });
    const cur = _unwrapEval(r);
    return cur === want ? { ok: true } : { ok: false, reason: 'checkbox-state-mismatch' };
  }

  if (kind === 'radio') {
    // Only click when the option's own label matches the desired value
    const want = String(value).trim().toLowerCase();
    const elLabel = label.toLowerCase();
    const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return null;
      const val = (el.value || '').toLowerCase();
      const lab = (el.closest('label')?.innerText || el.getAttribute('aria-label') || '').trim().toLowerCase();
      return { val, lab, checked: el.checked };
    })()` });
    const info = _unwrapEval(r);
    if (!info) return { ok: false, reason: 'no-el' };
    if (![info.val, info.lab, elLabel].some((s) => s && (s === want || s.includes(want)))) {
      return { ok: false, reason: 'radio-value-mismatch', skipped: true };
    }
    if (!info.checked) {
      const c = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: `(() => { const el = document.querySelector('[data-td-ref="${ref}"]'); if (el) { el.scrollIntoView({block:'center'}); el.click(); return el.checked; } return null; })()` });
      return _unwrapEval(c) === true ? { ok: true } : { ok: false, reason: 'radio-click-failed' };
    }
    return { ok: true };
  }

  if (kind === 'select') {
    const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 4000, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el || el.tagName !== 'SELECT') return null;
      const want = ${JSON.stringify(String(value).trim().toLowerCase())};
      let opt = null;
      for (const o of el.options) {
        const t = (o.text || '').trim().toLowerCase(), v = (o.value || '').trim().toLowerCase();
        if (t === want || v === want) { opt = o; break; }
        if (!opt && (t.includes(want) || v.includes(want))) opt = o;
      }
      if (!opt) return { matched: false, options: [...el.options].slice(0, 12).map((o) => o.text.trim()).join(', ') };
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { matched: true, value: el.value };
    })()` });
    const out = _unwrapEval(r);
    if (out && out.matched) return { ok: true };
    return { ok: false, reason: out ? `no-option-match (options: ${(out.options || '').slice(0, 60)})` : 'no-el' };
  }

  // Custom dropdown (antd .ant-select, role=combobox + listbox, Bootstrap-ish):
  // open the popup, click the matching option, verify the displayed selection.
  if (kind === 'dropdown') {
    const want = String(value).trim();
    const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 6000, text: `(async () => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return { err: 'no-el' };
      const wrap = el.closest('.ant-select, [class*="select" i], [class*="dropdown" i]') || el;
      (wrap.querySelector('.ant-select-selector') || wrap).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      (wrap.querySelector('.ant-select-selector') || wrap).click();
      await new Promise(r => setTimeout(r, 400));
      const want = ${JSON.stringify(want.toLowerCase())};
      const opts = [...document.querySelectorAll('[role="option"], .ant-select-item-option, .ant-select-dropdown [class*="option" i], [role="listbox"] li')];
      let hit = opts.find(o => (o.textContent || '').trim().toLowerCase() === want)
             || opts.find(o => (o.textContent || '').trim().toLowerCase().includes(want))
             || opts.find(o => want.includes((o.textContent || '').trim().toLowerCase()) && (o.textContent || '').trim().length > 1);
      if (!hit) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { matched: false, options: opts.slice(0, 12).map(o => (o.textContent || '').trim()).filter(Boolean).join(', ') };
      }
      hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      hit.click();
      await new Promise(r => setTimeout(r, 200));
      const shown = (wrap.querySelector('.ant-select-selection-item') || wrap).textContent.trim();
      return { matched: true, shown: shown.slice(0, 60) };
    })()` });
    const out = _unwrapEval(r);
    if (out && out.matched) return { ok: true };
    return { ok: false, reason: out?.err === 'no-el' ? 'no-el' : `no-option-match (options: ${(out?.options || '').slice(0, 80)})` };
  }

  // Chip/tag input (gmail-style tokenizers): type the value + Enter to commit,
  // then confirm a chip node containing the value materialized.
  if (kind === 'chip') {
    const v = String(value).trim();
    const f = await browserAct({ action: 'fill', sessionId, headed: true, timeoutMs: 5000, selector: entry.selector || ref, ref, text: v });
    if (!f?.ok) return { ok: false, reason: f?.error || 'fill-failed' };
    await browserAct({ action: 'press', sessionId, headed: true, timeoutMs: 3000, key: 'Enter', selector: entry.selector || ref }).catch(() => null);
    const c = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return null;
      const box = el.closest('div, span, li, td') || el.parentElement;
      const want = ${JSON.stringify(v.toLowerCase())};
      const chips = box ? [...box.querySelectorAll('[class*="chip" i], [class*="tag" i], [role="option"], [class*="token" i]')] : [];
      return { found: chips.some(c => (c.textContent || '').toLowerCase().includes(want)), val: el.value || '' };
    })()` });
    const out = _unwrapEval(c);
    return (out && (out.found || out.val === '')) ? { ok: true } : { ok: false, reason: 'chip-not-committed' };
  }

  // text / textarea / combobox / date / masked / number — trusted fill
  // (native setter + events); masked & numeric compare normalized digits.
  const f = await browserAct({ action: 'fill', sessionId, headed: true, timeoutMs: 5000, selector: entry.selector || ref, ref, text: String(value) });
  if (f?.ok) {
    // verify — read back the value
    const v = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2500, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return null;
      return el.isContentEditable ? (el.innerText || el.textContent || '').trim() : (el.value || '');
    })()` });
    const cur = _unwrapEval(v);
    if (cur != null && String(cur).trim() !== '') {
      const wantN = valueNormalize(value, kind), gotN = valueNormalize(cur, kind);
      const match = wantN && gotN && (gotN.includes(wantN.slice(0, 12)) || wantN.includes(gotN.slice(0, 12)));
      if (match) {
        // Dismiss any open date-picker / dropdown popup left by typing.
        if (kind === 'date' || kind === 'combobox') {
          await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 1500, text: `document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))` }).catch(() => null);
        }
        return { ok: true };
      }
      return { ok: true, partial: true, current: String(cur).slice(0, 60) };
    }
    // insertText may no-op on date/number inputs — fall back to value-set
    const s = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: `(() => {
      const el = document.querySelector('[data-td-ref="${ref}"]');
      if (!el) return null;
      el.focus();
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, ${JSON.stringify(String(value))}); else el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.blur();
      return el.value;
    })()` });
    const cur2 = _unwrapEval(s);
    return cur2 != null && String(cur2).trim() !== '' ? { ok: true } : { ok: false, reason: 'value-not-set' };
  }
  return { ok: false, reason: f?.error || 'fill-failed' };
}

// ── Post-fill validation sweep ──────────────────────────────────────────────
// One batched read: native checkValidity + aria-invalid + framework error
// classes (.ant-form-item-has-error etc.) + visible error text near the field.
// A fill run is an UPDATE, not a verdict — issues are reported verbatim so
// synthesize (and the next correction prompt) sees the real field state.
async function _validationSweep(sessionId, entries) {
  if (!entries.length) return {};
  const refs = entries.map((e) => e.ref).filter(Boolean);
  const r = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 4000, text: `(() => {
    const out = {};
    for (const ref of ${JSON.stringify(refs)}) {
      const el = document.querySelector('[data-td-ref="' + ref + '"]');
      if (!el) continue;
      const issues = [];
      try { if (el.checkValidity && !el.checkValidity()) issues.push(el.validationMessage || 'invalid value'); } catch (_) {}
      if (el.getAttribute('aria-invalid') === 'true' && !issues.length) issues.push('marked invalid');
      const wrap = el.closest('.ant-form-item, [class*="form-group" i], [class*="form-field" i], [class*="field" i], fieldset');
      if (wrap) {
        const errEl = wrap.querySelector('.ant-form-item-explain-error, [role="alert"], .invalid-feedback, [class*="error" i]:not(input):not(select):not(textarea)');
        if (errEl) {
          const t = (errEl.innerText || errEl.textContent || '').trim().slice(0, 120);
          if (t && !issues.includes(t)) issues.push(t);
        }
        if (wrap.className && /has-error|is-invalid/i.test(String(wrap.className)) && !issues.length) issues.push('field has error state');
      }
      if (issues.length) out[ref] = issues;
    }
    return out;
  })()` }).catch(() => null);
  return _unwrapEval(r) || {};
}

// ── Batched missing-field ask ───────────────────────────────────────────────
async function _askMissing(missing, gatherCb) {
  if (!missing.length || typeof gatherCb !== 'function') return {};
  const questions = missing.map((m) => ({
    id: `q_ff_${m.key}`,
    question: `The form asks for "${m.label}" — what should I use?`,
    text: `The form asks for "${m.label}" — what should I use?`,
    type: 'text',
    freeText: true,
    memoryText: `The user's ${String(m.key).replace(/^self:/, '').replace(/_/g, ' ')} is {answer}`,
  }));
  try {
    const answers = await gatherCb({ batch: true, batchId: `formfill_${Date.now()}`, questions });
    const out = {};
    for (const m of missing) {
      const v = answers?.[`q_ff_${m.key}`];
      if (typeof v === 'string' && v.trim()) out[m.key] = v.trim();
    }
    return out;
  } catch (e) {
    logger.warn(`[form.fill] missing-field ask failed: ${e.message}`);
    return {};
  }
}

// ── Main run ────────────────────────────────────────────────────────────────
async function formFillAgent(args = {}) {
  if (args.action === 'probe') return _probeForm(args);

  const goal = String(args.task || args.goal || '');
  const sessionId = await resolveExtSession(args.sessionId || 'ext:default');
  const { _progressCallbackUrl, _gatherAnswerCallback = null, overwrite = false } = args;
  const wantsSubmit = args.submit === true && !NEG_SUBMIT_RE.test(goal);
  const gatherCb = _gatherAnswerCallback || args.gatherAnswerCallback || null;

  const _mutexOwner = {};
  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'form-fill', message: `form.fill: scanning form` });

    // 1. No-submit guard — installed BEFORE any fill so even a page script
    //    reacting to input events can't submit while we work.
    if (!wantsSubmit) {
      try { await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000, text: NO_SUBMIT_GUARD }); }
      catch (e) { logger.warn(`[form.fill] no-submit guard install failed (continuing): ${e.message}`); }
    }

    // 2. Scan the live form with the field probe (enumerates ALL fillable
    //    inputs — buildTabMap only tags "actionable" elements, which misses
    //    most form fields). The probe tags each field with data-td-ref so
    //    the deterministic fill + verify passes locate them directly.
    const scanRes = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 5000, text: PROBE_SCRIPT });
    const scan = _unwrapEval(scanRes);
    if (!scan || !Array.isArray(scan.fields)) {
      return { ok: false, error: `form scan failed: ${scanRes?.error || 'no fields returned'}`, filledFields: [], missingFields: [], sessionId };
    }
    const fillables = scan.fields
      .filter(isFillableEntry)
      .slice(0, MAX_FIELDS);
    for (const e of fillables) e.currentValue = e.hasValue ? 'present' : '';
    if (!fillables.length) {
      return { ok: false, error: 'No fillable fields found on this page', filledFields: [], missingFields: [], sessionId };
    }

    // 3. label → key mapping (deterministic, then one LLM pass for leftovers)
    const mapped = fillables.map((e) => {
      const label = e.label || fieldLabel(e);
      return { entry: e, label, key: labelToKey(label), kind: widgetKind(e) };
    });
    const unmapped = mapped.filter((m) => !m.key && m.label && m.kind !== 'unsupported');
    if (unmapped.length) {
      const llmMap = await _llmMapLabels(unmapped.slice(0, MAX_LLM_LABELS).map((m) => m.label));
      for (const m of unmapped) {
        const k = llmMap[m.label];
        if (k) m.key = k;
      }
    }

    // `only` — targeted re-fill: a correction prompt ("the email is kai@x.com")
    // re-runs the skill on just the named fields (key or label match).
    const only = Array.isArray(args.only) ? args.only.map((s) => String(s).toLowerCase()) : null;
    const active = only
      ? mapped.filter((m) => only.includes(String(m.key || '').toLowerCase())
          || only.includes(String(m.label || '').toLowerCase())
          || only.some((o) => o && String(m.label || '').toLowerCase().includes(o)))
      : mapped;

    // 4. Resolve values. Precedence: explicit fields > gather answers >
    //    early-probe resolvedFields > fresh user.agent resolve.
    const explicit = args.fields && typeof args.fields === 'object' ? args.fields : {};
    const gathered = args.gatheredAnswers && typeof args.gatheredAnswers === 'object' ? args.gatheredAnswers : {};
    const preResolved = args.resolvedFields && typeof args.resolvedFields === 'object' ? args.resolvedFields : {};
    const keys = mapped.map((m) => m.key).filter(Boolean);
    const { resolved: uaResolved } = await _resolveValues(keys);
    const valueFor = (key) =>
      explicit[key] ?? gathered[key] ?? preResolved[key] ?? preResolved[`self:${key}`] ?? uaResolved[key] ?? uaResolved[`self:${key}`];

    // 5. Ask only for genuinely missing REQUIRED fields (batched card)
    const missingRequired = [];
    const seenAskKeys = new Set();
    for (const m of active) {
      if (!m.key || valueFor(m.key) != null || m.entry.hasValue || seenAskKeys.has(m.key)) continue;
      if (!isRequiredEntry(m.entry)) continue;
      seenAskKeys.add(m.key);
      missingRequired.push({ key: m.key, label: m.label || m.key });
    }
    let asked = [];
    if (missingRequired.length && gatherCb) {
      postProgress(_progressCallbackUrl, { tier: 'form-fill', message: `form.fill: asking for ${missingRequired.length} missing value(s)` });
      const answers = await _askMissing(missingRequired, gatherCb);
      Object.assign(gathered, answers); // answers join the value map
      asked = missingRequired.filter((m) => answers[m.key]).map((m) => m.key);
    }

    // 6. Deterministic fill pass
    const filledFields = [];
    const missingFields = [];
    const leftovers = [];
    for (const m of active) {
      if (!m.key) continue;
      const value = valueFor(m.key);
      if (value == null || String(value).trim() === '') {
        missingFields.push({ key: m.key, label: m.label, required: isRequiredEntry(m.entry) });
        continue;
      }
      if (m.entry.hasValue && !overwrite) {
        filledFields.push({ key: m.key, label: m.label, ref: m.entry.ref, note: 'already-had-value' });
        continue;
      }
      postProgress(_progressCallbackUrl, { tier: 'form-fill', message: `form.fill: filling "${(m.label || m.key).slice(0, 40)}"` });
      const r = await _fillEntry(sessionId, m.entry, value, overwrite);
      if (r.ok) {
        filledFields.push({ key: m.key, label: m.label, ref: m.entry.ref });
      } else if (r.skipped) {
        continue; // e.g. radio whose option didn't match — not an error
      } else {
        leftovers.push({ ...m, value });
      }
    }

    // 7. Leftovers → tab.map (comboboxes needing dropdown interaction, odd
    //    widgets). goal carries only the unfillable pairs; noSubmit is
    //    structurally enforced inside tab.map when wantsSubmit is false.
    let leftoversHandled = [];
    if (leftovers.length) {
      const pairs = leftovers.map((l) => `"${(l.label || l.key).slice(0, 50)}" → "${String(l.value).slice(0, 80)}"`).join('; ');
      const sub = `${goal ? goal + '. ' : ''}Fill ONLY these fields with the given values — do NOT click submit/save/continue: ${pairs}`;
      postProgress(_progressCallbackUrl, { tier: 'form-fill', message: `form.fill: delegating ${leftovers.length} complex field(s) to tab.map` });
      try {
        const res = await tabMapAgent({ goal: sub, sessionId, maxSteps: leftovers.length * 4 + 4, noSubmit: !wantsSubmit, _progressCallbackUrl, _gatherAnswerCallback: gatherCb, _mutexOwner });
        leftoversHandled = (res?.filledFields || []).map((f) => f.label || f.key || f);
      } catch (e) {
        logger.warn(`[form.fill] tab.map leftover delegation failed: ${e.message}`);
      }
    }

    // 8. Verification — read back every deterministic fill
    const verification = [];
    let filledCount = filledFields.length - filledFields.filter((f) => f.note === 'already-had-value').length;
    for (const f of filledFields) {
      if (!f.ref) continue;
      const v = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2500, text: `(() => {
        const el = document.querySelector('[data-td-ref="${f.ref}"]');
        if (!el) return null;
        if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked);
        return el.isContentEditable ? (el.innerText || el.textContent || '').trim().slice(0, 80) : (el.value || '');
      })()` }).catch(() => null);
      const cur = _unwrapEval(v);
      const hasValue = cur != null && cur !== '' && cur !== 'false';
      verification.push({ key: f.key, label: f.label, verified: hasValue, current: cur == null ? null : String(cur).slice(0, 60) });
      if (!hasValue && f.note !== 'already-had-value') filledCount--;
    }
    for (const l of leftoversHandled) filledCount++;

    // 9. Validation sweep — read per-field error state AFTER filling so the
    //    report carries the form's own messages ("Not a valid email address",
    //    "Required field"). A fill run is an UPDATE, not a verdict.
    const sweepTargets = active.filter((m) => m.key);
    const issues = await _validationSweep(sessionId, sweepTargets.map((m) => m.entry));
    const validationIssues = [];
    for (const m of sweepTargets) {
      const msgs = issues[m.entry.ref];
      if (msgs && msgs.length) {
        validationIssues.push({ key: m.key, label: m.label, messages: msgs, current: m.entry.hasValue ? 'had-value' : null, ref: m.entry.ref });
      }
    }

    const stillMissing = missingFields.filter((m) => m.required !== false).map((m) => m.key);
    const totalFilled = filledCount + leftoversHandled.length;
    const status = totalFilled > 0 ? (stillMissing.length || validationIssues.length ? 'partial' : 'filled') : 'nothing-filled';
    // Honest contract: ok:false is reserved for infra failures (no form, dead
    // session). A partial fill is a successful UPDATE with reported issues.
    const ok = totalFilled > 0 || stillMissing.length === 0;
    const issueText = validationIssues.map((v) => `${v.label || v.key}: ${v.messages[0]}`).join('; ');
    const summary = `form.fill: ${status} — filled ${totalFilled + filledFields.filter((f) => f.note === 'already-had-value').length} field(s)` +
      (issueText ? ` — validation issues: ${issueText.slice(0, 220)}` : '') +
      (stillMissing.length ? ` — missing: ${stillMissing.join(', ')}` : '') +
      (wantsSubmit ? ' (submit allowed)' : ' (no-submit enforced)');

    postProgress(_progressCallbackUrl, { tier: 'form-fill', message: summary });
    logger.info(`[form.fill] ${summary} session=${sessionId}`);

    return {
      ok,
      status,
      output: summary,
      filledFields,
      missingFields: missingFields.filter((m) => valueFor(m.key) == null),
      validationIssues,
      asked,
      leftoversHandled,
      verification,
      noSubmit: !wantsSubmit,
      sessionId,
    };
  }, _mutexOwner);
}

module.exports = { formFillAgent, NEG_SUBMIT_RE, NO_SUBMIT_GUARD };
