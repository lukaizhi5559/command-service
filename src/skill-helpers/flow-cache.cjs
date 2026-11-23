'use strict';

// ---------------------------------------------------------------------------
// flow-cache.cjs — learned UI-flow store.
//
// Recipes are EARNED at runtime, never authored: when screen.act finishes a
// task with every step verified, the effective step trace (resolved match,
// winning dx/dy, expect/pre gates, settleMs) persists here keyed by a
// normalized task-shape signature. Next run, ui-plan replays the learned
// steps — still verify-gated at runtime, so a stale recipe fails honestly
// instead of replaying blind. Recovery wins merge back as match alternatives
// (the recipe literally grows caveats for OCR/layout variants it survived).
//
// Same philosophy as destination-cache/shortcut-cache: learned writes,
// verify-on-read, never load-bearing — a corrupt or missing entry falls
// through to generic derivation.
//
// Store: ~/.thinkdrop/ui-flows/<key>.json — one recipe per file so concurrent
// reads/writes on different flows never contend.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger.cjs');

const FLOWS_DIR = path.join(os.homedir(), '.thinkdrop', 'ui-flows');

// Entity-value masking — playlist names / quoted strings / emails / numbers
// must not fragment keys: "playlist called Hope" and "playlist called Peace"
// are the SAME flow.
function maskEntities(prompt) {
  return String(prompt || '')
    .replace(/^(?:please\s+|can you\s+|could you\s+|hey\s+|ok(?:ay)?[,\s]+|try a prompt with\s+)/i, '')
    .replace(/(?:called|named|titled|titled as)\s+["'`][^"'`]+["'`]/gi, 'called X')
    // The name span stops at function words — "called Worship Anthems on
    // spotify" must mask only "Worship Anthems", not swallow the destination.
    .replace(/(?:called|named|titled)\s+(?:(?!\b(?:a|an|the|on|in|at|for|and|with|to|my|your|our|then|add|make|create|put|next|so|verify|check)\b)\S+\s*){1,4}/gi, 'called X ')
    .replace(/["'`][^"'`]{1,60}["'`]/g, '"X"')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, 'X@x.com')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'N')
    // Function words don't change the flow — "make a playlist" and "create a
    // playlist" phrasing variants should converge on one learned recipe.
    .replace(/\b(a|an|the|to|it|its|on|in|at|for|and|or|but|with|now|please|can|could|you|your|my|me|that|this|these|those|of|from|by|as|is|are|was|were|be|been|have|has|had|do|does|did|will|would|should|try|prompt|hey|ok|okay|new|own|then|next|so|just|open|launch|visit|go|into|onto|browser|app|application|verify|check|confirm|ensure|exist|exists|there)\b/g, ' ')
    .toLowerCase();
}

// Key = hash of the masked prompt's word skeleton — compact, stable, and
// filename-safe without leaking prompt text into paths. Sorted so word ORDER
// doesn't fragment ("…on spotify" vs "spotify …" are the same flow); a small
// verb map folds synonyms (make/create/build → make, add/include → add).
const _VERB_MAP = { create: 'make', build: 'make', generate: 'make', include: 'add', insert: 'add', put: 'add' };
function taskKey(prompt) {
  const words = maskEntities(prompt)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/).filter(Boolean)
    .map(w => _VERB_MAP[w] || w)
    .sort();
  const skeleton = words.join(' ').slice(0, 160);
  if (!skeleton) return null;
  const h = crypto.createHash('sha1').update(skeleton).digest('hex').slice(0, 16);
  return `${h}-${skeleton.replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
}

function _file(key) {
  const safe = String(key || '').replace(/[^a-z0-9._-]/gi, '_');
  return path.join(FLOWS_DIR, `${safe}.json`);
}

function get(key) {
  try {
    const f = _file(key);
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!d || !Array.isArray(d.steps) || !d.steps.length) return null;
    // Poisoned recipe — a replayed flow that failed twice never produced a
    // verified trace, so its steps can't be trusted to fresh-parse correctly.
    // A later successful put() rewrites it with fails:0 (rehabilitation).
    if ((d.fails || 0) >= 2) { logger.warn(`[flow-cache] bypassing poisoned flow ${key} (${d.fails} fails)`); return null; }
    return d;
  } catch (_) { return null; }
}

// Replayed recipe failed — mark it. Two strikes and lookups stop serving it.
function noteFailure(key) {
  try {
    const d = (() => { const f = _file(key); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; })();
    if (!d) return;
    d.fails = (d.fails || 0) + 1;
    fs.writeFileSync(_file(key), JSON.stringify(d, null, 2));
  } catch (_) {}
}

// Paraphrase-tolerant lookup — the planner rewords goals ("add Lecrae and KB
// songs" drops "christian"), so exact skeleton keys miss. Score word-overlap
// (Jaccard) against every stored flow's skeleton (parsed from its key suffix);
// a best match ≥min AND clearly ahead of the runner-up replays.
function _skeletonWords(promptOrKey) {
  return new Set(maskEntities(promptOrKey)
    .replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => _VERB_MAP[w] || w));
}
function getFuzzy(prompt, { min = 0.7, margin = 0.08 } = {}) {
  const want = _skeletonWords(prompt);
  if (!want.size) return null;
  let best = null, second = 0;
  let files = [];
  try { files = fs.readdirSync(FLOWS_DIR).filter(f => f.endsWith('.json')); } catch (_) { return null; }
  for (const f of files) {
    const key = f.slice(0, -5);
    const have = new Set(key.slice(17).split('-').filter(Boolean));
    if (!have.size) continue;
    let inter = 0;
    for (const w of want) if (have.has(w)) inter++;
    const score = inter / (want.size + have.size - inter);
    if (score >= min && score > (best?.score || 0)) { second = best?.score || 0; best = { score, key }; }
    else if (score > second) second = score;
  }
  if (!best || best.score - second < margin) return null;
  const rec = get(best.key);
  if (rec) rec.fuzzyScore = +best.score.toFixed(3);
  return rec;
}

// recipe.steps: screen.act-shaped step objects — action, match, text?, dx?,
// dy?, expect?, pre?, preUnless?, settleMs?, waitMatchMs?, why?
// A learned recipe must contain at least one mutating action — a plan that
// only verified observed state (verify/wait steps) teaches nothing and
// out-competes real recipes at fuzzy lookup (observed: a 2-step
// verify-only "flow" shadowed the 16-step playlist recipe on a paraphrase).
const MUTATING_ACTIONS = new Set(['click', 'type', 'paste', 'key', 'select', 'drag', 'scroll', 'auto', 'copy_page']);
function put(key, steps, meta = {}) {
  try {
    if (!Array.isArray(steps) || !steps.some(s => MUTATING_ACTIONS.has(String(s?.action || '')))) {
      logger.warn(`[flow-cache] rejected ${key} — recipe has no mutating action (${(steps || []).map(s => s?.action).join(',') || 'empty'})`);
      return false;
    }
    const prev = get(key);
    const rec = {
      v: 1,
      key,
      learnedAt: Date.now(),
      runs: (prev?.runs || 0) + 1,
      fails: 0,
      lastRun: Date.now(),
      steps,
      variants: prev?.variants || {},
      ...(meta.goal ? { goal: meta.goal.slice(0, 300) } : {}),
    };
    fs.mkdirSync(FLOWS_DIR, { recursive: true });
    fs.writeFileSync(_file(key), JSON.stringify(rec, null, 2));
    return true;
  } catch (err) {
    logger.warn(`[flow-cache] write failed: ${err.message}`);
    return false;
  }
}

// Recovery merge — the winning anchor for a step that only resolved after
// retries becomes a permanent alternative. Steps' match is upgraded to the
// array-alternatives form [{re, dx?, dy?}] when it isn't already.
function mergeVariant(key, stepIdx, variant) {
  try {
    const rec = get(key);
    if (!rec || !rec.steps?.[stepIdx]) return false;
    const step = rec.steps[stepIdx];
    const re = String(variant.match || '');
    if (!re) return false;
    const alts = Array.isArray(step.match)
      ? step.match
      : [{ re: String(step.match || '') }];
    if (!alts.some(a => String(a.re || a) === re)) {
      alts.push({ re, ...(variant.dx ? { dx: variant.dx } : {}), ...(variant.dy ? { dy: variant.dy } : {}) });
      step.match = alts;
    }
    rec.variants = rec.variants || {};
    rec.variants[`${stepIdx}`] = (rec.variants[`${stepIdx}`] || 0) + 1;
    fs.mkdirSync(FLOWS_DIR, { recursive: true });
    fs.writeFileSync(_file(key), JSON.stringify(rec, null, 2));
    return true;
  } catch (err) {
    logger.warn(`[flow-cache] mergeVariant failed: ${err.message}`);
    return false;
  }
}

// ── Prompt-entity slots ──────────────────────────────────────────────────────
// Typed text in a learned recipe (playlist names, search terms) is prompt-
// derived — replaying it literally would write the OLD name into the NEW
// request. serializeSteps replaces step.text with {$slot:i} when it matches an
// extracted prompt entity; ui-plan re-fills slots with entities extracted
// from the NEW prompt. Extractor is deliberately generic (quoted spans,
// called/named values, add/search/type/find lists) — it must produce a
// CONSISTENT ordering for same-shaped prompts, not be perfect.
function extractEntities(prompt) {
  const ents = [];
  const push = (s) => { s = String(s || '').replace(/[.,;:!?]+$/, '').trim(); if (s && s.length > 1 && !ents.includes(s)) ents.push(s); };
  // 1. quoted spans — most explicit
  for (const m of String(prompt || '').matchAll(/["'`]([^"'`]{1,60})["'`]/g)) push(m[1]);
  // 2. called/named/titled values — the span stops at prepositions so
  //    "called Worship Anthems on spotify" yields "Worship Anthems", not
  //    the destination suffix.
  for (const m of String(prompt || '').matchAll(/(?:called|named|titled)\s+([A-Za-z0-9][A-Za-z0-9 .&'-]{0,40}?)(?=\s+(?:and|with|to|on|in|at|for|via|using)\b|[,.]|$)/gi)) push(m[1]);
  // 3. verb-object lists — "add A and B to it", "add A and B" (end-anchored),
  //    "search for X and Y"
  for (const m of String(prompt || '').matchAll(/(?:add|search(?:\s+for)?|type|find|look\s*up)\s+(.+?)\s+to\s+(?:it|the|that|this|my|your|our|a|an)\b/gi)) {
    m[1].split(/\s*(?:,|\band\b)\s*/i).forEach(push);
  }
  if (!ents.slice(1).length) {
    for (const m of String(prompt || '').matchAll(/\badd\s+([A-Za-z0-9][A-Za-z0-9 .&'’-]{1,60}?)(?=\s+(?:to|on|in)\s|[,.]|$)/gi)) {
      m[1].split(/\s*(?:,|\band\b)\s*/i).forEach(push);
    }
  }
  return ents;
}

// Stored step text that exactly matches an entity becomes {slot:i}; anything
// else stays literal. Matching is case-insensitive substring-free exact —
// safer than fuzzy for a write-once artifact.
function _slotValue(v, entities) {
  return (v && typeof v === 'object' && v.$slot != null) ? (entities?.[v.$slot] ?? '') : v;
}
// Recipe health gate — flows learned under failure carry garbage match
// strings: error-page OCR baked as regexes (/went wrong|reload/), and
// non-string match values that serialized weirdly (observed: "step 0/0:
// undefined function match()" — String.prototype.match reached a desc
// field). A step whose match can't correspond to a real control gets
// dropped at load; execution falls back to clause-derived/auto paths.
const _POISON_MATCH = /went wrong|try again|not found|native code|\[object|function match|reload\b/i;
function _saneStep(s) {
  if (!s || typeof s !== 'object') return false;
  const m = s.match;
  if (m == null) return true;
  if (Array.isArray(m)) return m.every(a => a && typeof a.re === 'string' && !_POISON_MATCH.test(a.re));
  if (typeof m !== 'string') return false;
  return !_POISON_MATCH.test(m);
}
function serializeSteps(steps, entities) {
  return (steps || []).filter(_saneStep).map(s => {
    const out = { ...s };
    for (const f of ['text', 'check']) {
      if (typeof out[f] === 'string' && entities?.length) {
        const t = out[f].trim().toLowerCase();
        const i = entities.findIndex(e => String(e).trim().toLowerCase() === t);
        if (i >= 0) out[f] = { $slot: i };
      }
    }
    return out;
  });
}

function hydrateSteps(storedSteps, entities) {
  return (storedSteps || []).filter(_saneStep).map(s => {
    const out = { ...s };
    for (const f of ['text', 'check']) {
      if (out[f] && typeof out[f] === 'object') out[f] = _slotValue(out[f], entities);
    }
    return out;
  });
}

module.exports = { taskKey, get, getFuzzy, put, noteFailure, mergeVariant, extractEntities, serializeSteps, hydrateSteps, saneStep: _saneStep, FLOWS_DIR };
