'use strict';

/**
 * decision.cjs — local typed-decision client for command-service skills.
 *
 * POSTs to phi4's /decision.answer (Ollama System One — choice/noul/score,
 * no text generation). Replaces remote force-classification calls in the
 * browser inner loop (~5–30s per step → ~100–300ms warm).
 *
 * Modes (env):
 *   DECISION_LOCAL=0          — disabled; callers use the remote LLM path
 *   DECISION_SHADOW=1         — run local AND remote, log agreement, return
 *                               the REMOTE answer (data collection only)
 *   default                   — local first; on failure/low-confidence fall
 *                               back to remote
 *
 * Shadow log line (grep '[DecisionShadow]'):
 *   [DecisionShadow] site=<site> agree=<bool> local=<v> remote=<v> localMs=<n>
 */

const PHI4_URL = process.env.MCP_PHI4_URL || 'http://127.0.0.1:3009';
const PHI4_API_KEY = process.env.MCP_PHI4_API_KEY || process.env.MCP_API_KEY || '';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DECISION_TIMEOUT_MS || '3000', 10);

let _logger = null;
function _log() {
  if (!_logger) {
    try { _logger = require('../logger.cjs'); } catch { _logger = console; }
  }
  return _logger;
}

function decisionEnabled() { return process.env.DECISION_LOCAL !== '0'; }
// DECISION_SHADOW_SITES — comma list ("prefix*" wildcard): when set, only the
// listed sites run shadow; all other sites go authoritative-local (fail-open
// remote on error/low-confidence). Unset → DECISION_SHADOW=1 shadows all.
function _shadowSiteMatches(site) {
  const list = (process.env.DECISION_SHADOW_SITES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return true;
  return list.some(pat => pat.endsWith('*')
    ? String(site || '').startsWith(pat.slice(0, -1))
    : String(site || '') === pat);
}
function shadowMode(site) { return process.env.DECISION_SHADOW === '1' && _shadowSiteMatches(site); }

/**
 * Ask the local decision model a batch of typed questions.
 * @param {Array}  questions  [{id, type:'choice'|'noul'|'score'|'rating', question, options?, min?, max?}]
 * @param {object} [opts]     { state?, image?, timeoutMs? }
 * @returns {Promise<{answers,model,elapsedMs}|null>} — null on any failure
 */
async function askDecision(questions, opts = {}) {
  if (!decisionEnabled()) return null;
  const start = Date.now();
  try {
    const res = await fetch(`${PHI4_URL}/decision.answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PHI4_API_KEY ? { Authorization: `Bearer ${PHI4_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        version: 'mcp.v1',
        service: 'phi4',
        action: 'decision.answer',
        requestId: `cmd_dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        payload: {
          state: opts.state || '',
          questions,
          ...(opts.image ? { image: opts.image } : {}),
        },
      }),
      // Batch-scaled timeout — ~60-120ms/question on the small-tier model;
      // a flat 3s ceiling made >8-question batches always time out.
      signal: opts.signal || AbortSignal.timeout(opts.timeoutMs
        || (process.env.DECISION_TIMEOUT_MS ? DEFAULT_TIMEOUT_MS : Math.min(6000 + 400 * (Array.isArray(questions) ? questions.length : 1), 15000))),
    });
    const body = await res.json().catch(() => null);
    if (!body || body.status !== 'ok' || !body.data?.answers) return null;
    return { answers: body.data.answers, elapsedMs: Date.now() - start, model: body.data.model };
  } catch (err) {
    _log().debug?.(`[Decision] local decision failed: ${err.message}`);
    return null;
  }
}

/**
 * boundedDecision — one-line swap for bounded classification call sites.
 *
 * @param {object} cfg
 *   askDecision    fn|null   — pass `askDecision` or null to disable
 *   site           string    — shadow-log label
 *   questions      array     — systemone questions
 *   state          string|object — decision context
 *   local          fn(answers)→any — build the value; null/undefined → remote
 *   remote         fn()→any  — existing production path
 *   logger         object?   — gets info/debug lines
 *   minConfidence  number?   — abstain to remote below this (choice/score)
 *   signal         AbortSignal? — caller cancellation
 */
async function boundedDecision(cfg) {
  const { site, questions, state, local, remote, logger = _log(), minConfidence, signal } = cfg;
  const ask = cfg.askDecision === undefined ? askDecision : cfg.askDecision;
  const enabled = typeof ask === 'function' && decisionEnabled();
  const shadow = enabled && shadowMode(site);

  if (!enabled) return remote();

  const runLocal = async () => {
    const r = await ask(questions, { state, signal, ...(cfg.image ? { image: cfg.image } : {}) });
    if (!r?.answers) return { value: null, ms: null };
    if (minConfidence != null) {
      for (const q of questions) {
        const a = r.answers[q.id];
        if (a && typeof a.confidence === 'number' && a.confidence < minConfidence) {
          return { value: null, ms: r.elapsedMs, lowConf: true };
        }
      }
    }
    const v = local(r.answers);
    return { value: v == null ? null : v, ms: r.elapsedMs, model: r.model };
  };

  if (shadow) {
    const remoteP = Promise.resolve().then(remote);
    let lv = null, lms = null, lerr = '';
    try { const l = await runLocal(); lv = l.value; lms = l.ms; }
    catch (e) { lerr = e.message; }
    const rv = await remoteP;
    const agree = lv != null && rv != null && JSON.stringify(lv) === JSON.stringify(rv);
    logger.info?.(`[DecisionShadow] site=${site} agree=${agree} local=${JSON.stringify(lv)?.slice(0, 120)} remote=${JSON.stringify(rv)?.slice(0, 120)} localMs=${lms}${lerr ? ` err=${lerr}` : ''}`);
    return rv;
  }

  try {
    const l = await runLocal();
    if (l.value != null) {
      logger.info?.(`[Decision] site=${site} local ${l.ms}ms model=${l.model || '?'}`);
      return l.value;
    }
    // Warn-level: remote fallbacks cost money + latency and were previously
    // invisible (debug lines never reach persisted logs). One line per site
    // per failure keeps fallback storms diagnosable.
    if (l.lowConf) logger.warn?.(`[Decision] site=${site} low-confidence — remote fallback`);
    else logger.warn?.(`[Decision] site=${site} local returned null — remote fallback`);
  } catch (e) {
    logger.warn?.(`[Decision] site=${site} failed: ${e.message} — remote fallback`);
  }
  return remote();
}

module.exports = { askDecision, boundedDecision, decisionEnabled, shadowMode };
