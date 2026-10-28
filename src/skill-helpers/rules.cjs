'use strict';

// ---------------------------------------------------------------------------
// rules.cjs — guardian/trigger rules: storage, deterministic matching,
// passphrase-gated management.
//
// One rules file, four evaluation seams:
//   entry       comms-graph, after classify — covers EVERY lane (web-search,
//               general_quick, planning, handoff)
//   preflight   stategraph preflightAgents — vs resolved taskFacts
//   completion  executeCommand tail — vs taskFacts + gathered vars
//   observation monitorService._recordAppSwitch — ambient app/tab switches
//
// `when` matching is deterministic (eq/contains/regex/host-match); the only
// modeled field is `category`, evaluated by callers against the rule's own
// authored category list — never an open-ended judgment.
//
// `then` actions: block | ask | notify | show_card | enqueue_task.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RULES_PATH = path.join(os.homedir(), '.thinkdrop', 'rules.json');
const ACTIONS = new Set(['block', 'ask', 'notify', 'show_card', 'enqueue_task']);
const SEAMS = new Set(['entry', 'preflight', 'completion', 'observation']);

// ── Storage ──────────────────────────────────────────────────────────────────

let _cache = null; // {mtimeMs, doc}

function _rulesPath() {
  return process.env.THINKDROP_RULES_PATH || RULES_PATH;
}

function _readDoc() {
  const p = _rulesPath();
  try {
    const st = fs.statSync(p);
    if (_cache && _cache.mtimeMs === st.mtimeMs && _cache.path === p) return _cache.doc;
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cache = { mtimeMs: st.mtimeMs, path: p, doc };
    return doc;
  } catch (_) {
    return null;
  }
}

function _writeDoc(doc) {
  const p = _rulesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  _cache = null;
}

function loadRules() {
  const doc = _readDoc();
  return doc && Array.isArray(doc.rules) ? doc.rules.filter((r) => r && r.enabled !== false) : [];
}

function _docOrEmpty() {
  return _readDoc() || { passphrase: null, rules: [] };
}

// ── Passphrase ───────────────────────────────────────────────────────────────

function _hash(pass, salt) {
  return crypto.createHash('sha256').update(`${salt}${pass}`).digest('hex');
}

function hasPassphrase() {
  const doc = _readDoc();
  return !!(doc && doc.passphrase && doc.passphrase.hash);
}

function setPassphrase(pass, { confirmExisting = null } = {}) {
  const doc = _docOrEmpty();
  if (doc.passphrase && doc.passphrase.hash) {
    if (confirmExisting === null || _hash(String(confirmExisting), doc.passphrase.salt) !== doc.passphrase.hash) {
      return { ok: false, error: 'existing passphrase required to change it' };
    }
  }
  const salt = crypto.randomBytes(16).toString('hex');
  doc.passphrase = { salt, hash: _hash(String(pass), salt) };
  _writeDoc(doc);
  return { ok: true };
}

function verifyPassphrase(input) {
  const doc = _readDoc();
  if (!doc || !doc.passphrase || !doc.passphrase.hash) return false;
  return _hash(String(input || ''), doc.passphrase.salt) === doc.passphrase.hash;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function listRules() {
  const doc = _docOrEmpty();
  return (doc.rules || []).map((r) => ({
    id: r.id, enabled: r.enabled !== false, seam: r.seam || 'any',
    when: r.when || {}, then: r.then || {},
  }));
}

function addRule(rule) {
  const doc = _docOrEmpty();
  doc.rules = doc.rules || [];
  const id = rule.id || `r${Date.now().toString(36)}`;
  if (doc.rules.some((r) => r.id === id)) return { ok: false, error: `rule id "${id}" exists` };
  const clean = {
    id,
    enabled: rule.enabled !== false,
    seam: SEAMS.has(rule.seam) ? rule.seam : 'any',
    when: rule.when || {},
    then: rule.then || { action: 'notify' },
    source: rule.source || 'user',
    fireOnce: !!rule.fireOnce,
    cooldownMs: typeof rule.cooldownMs === 'number' ? rule.cooldownMs : null,
    lastFiredAt: rule.lastFiredAt || 0,
    firedAt: rule.firedAt || null,
  };
  if (!ACTIONS.has(clean.then.action)) clean.then = { ...clean.then, action: 'notify' };
  doc.rules.push(clean);
  _writeDoc(doc);
  return { ok: true, rule: clean };
}

function setRuleEnabled(id, enabled) {
  const doc = _docOrEmpty();
  const r = (doc.rules || []).find((x) => x.id === id);
  if (!r) return { ok: false, error: `no rule "${id}"` };
  r.enabled = !!enabled;
  _writeDoc(doc);
  return { ok: true };
}

function removeRule(id) {
  const doc = _docOrEmpty();
  const i = (doc.rules || []).findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, error: `no rule "${id}"` };
  doc.rules.splice(i, 1);
  _writeDoc(doc);
  return { ok: true };
}

// ── Matching ─────────────────────────────────────────────────────────────────

function _testRe(pattern, text) {
  try {
    return new RegExp(pattern, 'i').test(String(text || ''));
  } catch (_) {
    return false;
  }
}

function _hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

// ctx: { prompt, service, host, url, entities, vars, appName, intent,
//        filePath, windowTitle, ocrText }
// Returns {matched:true, rule} on first hit — callers evaluate rules in file
// order and stop at first match per seam.
//
// Substr-or-regex helper: a bare value matches case-insensitive substring;
// 're:<pattern>' matches as a regex.
function _subOrRe(pattern, text) {
  const p = String(pattern);
  if (p.startsWith('re:')) return _testRe(p.slice(3), text);
  return String(text || '').toLowerCase().includes(p.toLowerCase());
}

function whenMatches(when, ctx) {
  if (!when || typeof when !== 'object') return false;
  let asserted = false;
  if (when.promptMatch) {
    asserted = true;
    if (!_testRe(when.promptMatch, ctx.prompt || '')) return false;
  }
  if (when.service) {
    asserted = true;
    if (String(when.service).toLowerCase() !== String(ctx.service || '').toLowerCase()) return false;
  }
  if (when.hostMatch) {
    asserted = true;
    const want = String(when.hostMatch).toLowerCase();
    const urlHost = _hostOf(ctx.url || '');
    const host = String(ctx.host || urlHost || '').toLowerCase();
    if (!(host === want || host.endsWith('.' + want) || urlHost === want || urlHost.endsWith('.' + want))) return false;
  }
  if (when.urlMatch) {
    asserted = true;
    if (!_subOrRe(when.urlMatch, ctx.url || '')) return false;
  }
  if (when.appName) {
    asserted = true;
    if (!_testRe(`^${when.appName}$`, ctx.appName || '') && String(ctx.appName || '') !== String(when.appName)) return false;
  }
  if (when.fileMatch) {
    asserted = true;
    if (!_subOrRe(when.fileMatch, ctx.filePath || '')) return false;
  }
  if (when.titleMatch) {
    asserted = true;
    if (!_testRe(when.titleMatch, ctx.windowTitle || '')) return false;
  }
  if (when.ocrMatch) {
    asserted = true;
    if (!_testRe(when.ocrMatch, ctx.ocrText || '')) return false;
  }
  if (when.entities && typeof when.entities === 'object') {
    asserted = true;
    const ent = ctx.entities || {};
    for (const [k, v] of Object.entries(when.entities)) {
      const actual = String(ent[k] || '');
      if (String(v).startsWith('re:')) {
        if (!_testRe(String(v).slice(3), actual)) return false;
      } else if (actual.toLowerCase() !== String(v).toLowerCase()) return false;
    }
  }
  if (when.varMatch && typeof when.varMatch === 'object') {
    asserted = true;
    const vars = ctx.vars || {};
    const vm = when.varMatch;
    const actual = String(vars[vm.var] ?? '');
    if (vm.re !== undefined && !_testRe(vm.re, actual)) return false;
    if (vm.eq !== undefined && actual.toLowerCase() !== String(vm.eq).toLowerCase()) return false;
  }
  if (when.intent) {
    asserted = true;
    if (String(when.intent).toLowerCase() !== String(ctx.intent || '').toLowerCase()) return false;
  }
  // A `when` naming only keys the ctx can't supply (e.g. entities at the
  // observation seam) counts asserted-but-unsatisfied only if asserted;
  // a completely empty when never matches anything.
  return asserted;
}

// Default re-fire cooldown for non-guard rules — a fireAlways site rule
// shouldn't re-notify on every appWatch tick of the same visit.
const DEFAULT_COOLDOWN_MS = 60000;
// Guard actions enforce every time — cooldown never applies to them.
const _GUARD_ACTIONS = new Set(['block', 'ask']);

function _inCooldown(rule, now) {
  const action = rule?.then?.action;
  if (_GUARD_ACTIONS.has(action)) return false;
  const cd = typeof rule.cooldownMs === 'number' ? rule.cooldownMs : DEFAULT_COOLDOWN_MS;
  if (cd <= 0) return false;
  return !!rule.lastFiredAt && now - rule.lastFiredAt < cd;
}

// Evaluate enabled rules for one seam. seam === 'any' rules run everywhere.
// Returns [{rule, when}] for every match — callers pick first/strongest.
function evaluate(ctx, seam) {
  const out = [];
  const now = Date.now();
  for (const rule of loadRules()) {
    const s = rule.seam || 'any';
    if (s !== 'any' && s !== seam) continue;
    if (_inCooldown(rule, now)) continue;
    if (whenMatches(rule.when, ctx)) out.push(rule);
  }
  return out;
}

// Record that rules fired: fireOnce rules disable themselves (firedAt),
// fireAlways rules stamp lastFiredAt for cooldown. One write per batch.
function markFired(ruleIds) {
  if (!Array.isArray(ruleIds) || !ruleIds.length) return;
  const doc = _docOrEmpty();
  let dirty = false;
  for (const r of doc.rules || []) {
    if (!ruleIds.includes(r.id)) continue;
    r.lastFiredAt = Date.now();
    if (r.fireOnce) {
      r.enabled = false;
      r.firedAt = r.lastFiredAt;
    }
    dirty = true;
  }
  if (dirty) _writeDoc(doc);
}

// Resolve {{slot}} templates in a then-action against the match ctx —
// pure string interpolation, no model. Slots: host, url, appName,
// windowTitle, filePath, service, intent.
function interpolate(then, ctx) {
  const t = then || {};
  const c = ctx || {};
  const vals = {
    host: c.host || _hostOf(c.url || ''),
    url: c.url || '',
    appName: c.appName || '',
    windowTitle: c.windowTitle || '',
    filePath: c.filePath || '',
    service: c.service || '',
    intent: c.intent || '',
  };
  const sub = (s) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => vals[k] ?? '');
  const out = { ...t };
  if (t.prompt) out.prompt = sub(t.prompt);
  if (t.title) out.title = sub(t.title);
  if (t.body) out.body = sub(t.body);
  if (t.msg) out.msg = sub(t.msg);
  if (t.reason) out.reason = sub(t.reason);
  return out;
}

// True when any enabled rule asserts when.ocrMatch — lets callers skip the
// (heavier) per-capture OCR eval entirely when nothing can match.
function hasOcrRules() {
  return loadRules().some((r) => r.when && r.when.ocrMatch);
}

// First blocking/asking rule at a seam — callers short-circuit on these.
function firstGuardHit(ctx, seam) {
  for (const rule of evaluate(ctx, seam)) {
    const action = rule?.then?.action;
    if (action === 'block' || action === 'ask') return rule;
  }
  return null;
}

module.exports = {
  RULES_PATH,
  loadRules,
  listRules,
  addRule,
  setRuleEnabled,
  removeRule,
  evaluate,
  firstGuardHit,
  whenMatches,
  markFired,
  interpolate,
  hasOcrRules,
  hasPassphrase,
  setPassphrase,
  verifyPassphrase,
};
