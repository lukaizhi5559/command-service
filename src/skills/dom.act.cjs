'use strict';

// ---------------------------------------------------------------------------
// dom.act.cjs — Deterministic dispatcher skill for `on-page-action` plan steps.
//
// The planner emits { skill: 'dom.act', stepType: 'on-page-action', agentHint?,
// args: { task/goal, agentId, sessionId? } }. At execution time this skill
// probes the real page state (router.cjs — no LLM) and delegates to the atomic
// agent that fits: just.type / meta.find / shortcut.keys / tab.map / gesture /
// arrow.grid / turn.loop.
//
// The resolved agent name is returned on the result as `resolvedAgent` so the
// UI trace and replan logic can see which executor actually ran.
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { routeOnPageAction } = require('./lib/browserCore/router.cjs');
const { deriveSessionId } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { hasVisibleDialog } = require('./lib/browserCore/overlayProbe.cjs');
const { deepLinkOpensOverlay, classifyDeepLinkType } = require('../skill-helpers/deep-link-types.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');

// True when the goal is *only* the create/compose action that a
// creation/compose deep-link already performed. Any residual work in the
// goal (titling, filling, clicking, navigating) disqualifies it — those
// still need an agent. Excluded-word list errs toward not gating.
const _CREATE_ACTION_RE = /\b(create|compose|new|make|start|open)\b/i;
const _RESIDUAL_WORK_RE = /\b(and|then|titled|named?|called|with|fill|type|write|set|add|enter|including|containing|click|that says|body|subject|send|about)\b/i;
function _isPureCreateGoal(goal, priorNavType) {
  if (priorNavType !== 'creation' && priorNavType !== 'compose') return false;
  const g = String(goal || '').trim();
  if (!g) return false;
  return _CREATE_ACTION_RE.test(g) && !_RESIDUAL_WORK_RE.test(g);
}

const AGENT_RUNNERS = {
  'just.type.agent':    () => require('./just.type.agent.cjs').justTypeAgent,
  'meta.find.agent':    () => require('./meta.find.agent.cjs').metaFindAgent,
  'shortcut.keys.agent':() => require('./shortcut.keys.agent.cjs').shortcutKeysAgent,
  'tab.map.agent':      () => require('./tab.map.agent.cjs').tabMapAgent,
  'gesture.agent':      () => require('./gesture.agent.cjs').gestureAgent,
  'arrow.grid.agent':   () => require('./arrow.grid.agent.cjs').arrowGridAgent,
  'turn.loop.agent':    () => require('./turn.loop.agent.cjs').turnLoopAgent,
};

async function domAct(args = {}) {
  const {
    task, goal: _goalArg, agentId = 'default.agent', sessionId: _sid,
    pageCategory: _pageCategoryArg, agentContext = '', agentHint = null,
    triedAgents = null, _progressCallbackUrl,
    priorNavUrl = null, priorNavType = null,
  } = args;
  const goal = task || _goalArg || '';
  if (!goal) return { ok: false, error: 'dom.act: no task/goal' };

  // Category derivation — the planner may emit pageCategory, but most steps
  // don't. Infer deterministically (service map → host map → cached LLM) so
  // category gating (ai_chat just-type, allowedTiers, overlay hints) actually
  // engages on the atomic path.
  let pageCategory = _pageCategoryArg;
  if (!pageCategory || pageCategory === 'web_generic') {
    try {
      pageCategory = await inferPageCategory({ agentId, task: goal });
      if (pageCategory !== _pageCategoryArg) {
        logger.info(`[dom.act] pageCategory inferred: ${pageCategory} (agentId=${agentId}, was=${_pageCategoryArg || 'none'})`);
      }
    } catch (_) { pageCategory = _pageCategoryArg || 'web_generic'; }
  }

  const sessionId = _sid || deriveSessionId(agentId);

  // Settle gate: the previous step (url.first) resolves at domcontentloaded —
  // heavy SPAs (Gmail compose, Calendar dialogs) keep rendering after that.
  // Wait for page text to stabilize so the probe sees the real post-nav state.
  try {
    await browserAct({ action: 'waitForStableText', sessionId, headed: true, timeoutMs: 8000 });
  } catch (_) { /* non-fatal — probe anyway */ }

  // Expected-overlay gate. Two signals, observation-first:
  //   (a) DOM observation — a dialog is already mounted (handles ANY nav-
  //       triggered modal regardless of URL param knowledge), and a short
  //       late-mount poll when a nav just preceded this step (lazy React
  //       modals — LinkedIn share composer mounts ~1-3s after hydration).
  //   (b) URL classification — deepLinkOpensOverlay (generic param-key
  //       heuristic now covers unknown-site params like ?shareActive).
  // When overlay is expected/seen: poll until the dialog exists so downstream
  // detection finds it, and flag expectOverlay so tab.map never fires the
  // Escape+top-left focus reset that would dismiss it.
  // Single bounded dialog wait (~6s): exits the moment a modal-like layer is
  // detected, so an already-mounted or quickly-mounting dialog adds ~zero
  // startup delay. Covers (a) already-mounted modals, (b) lazy post-nav React
  // mounts, (c) URL-classified overlay intent. Late mounts beyond the bound
  // self-heal downstream (click→overlayChanged→rescan, scan-time dialog scope).
  const _looseOverlayProbe = () => hasVisibleDialog(sessionId);

  let overlaySeen = await _looseOverlayProbe();
  const expectOverlay = overlaySeen || deepLinkOpensOverlay(priorNavUrl, priorNavType);
  if (!overlaySeen && (priorNavUrl || expectOverlay)) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const late = await detectOverlay(sessionId, pageCategory).catch(() => null);
      if (late?.active || await _looseOverlayProbe()) { overlaySeen = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    logger.info(`[dom.act] overlay wait (priorNavType=${priorNavType}, expect=${expectOverlay}) → dialog ${overlaySeen ? 'mounted' : 'NOT confirmed after 6s'}`);
  }

  // Already-satisfied gate: a creation/compose deep-link performs the action
  // itself (docs.google.com/document/create creates AND opens the doc). A
  // follow-on step whose whole goal is "create a new X" is therefore a no-op —
  // routing it to an LLM lets it wander (observed: tab-map clicked "Doc home"
  // and created a second document). Deliberately narrow: only fires when the
  // goal is purely the create action — fused goals ("create a doc titled X")
  // fall through so the residual part still executes.
  if (_isPureCreateGoal(goal, priorNavType)) {
    logger.info(`[dom.act] already satisfied — "${goal.slice(0, 60)}" done by ${priorNavType} deep-link (${priorNavUrl || 'unknown url'})`);
    postProgress(_progressCallbackUrl, { tier: 'done', message: `dom.act: already satisfied by navigation` });
    return { ok: true, alreadySatisfied: true, sessionId, agentId, url: priorNavUrl, output: `Already done — ${priorNavType} deep-link created it (${priorNavUrl || ''})` };
  }

  // Bounded re-route: a routed agent that fails (e.g. shortcut agent finds no
  // matching hotkey) is added to triedAgents and the router picks the next-best
  // candidate. Prevents one wrong classification from dead-ending the step.
  const tried = new Set(triedAgents || []);
  const MAX_ROUTE_ATTEMPTS = 3;
  let res = null;
  let lastRoute = null;
  for (let attempt = 0; attempt < MAX_ROUTE_ATTEMPTS; attempt++) {
    const route = await routeOnPageAction({
      sessionId, goal, pageCategory,
      // A failing agent steers its successor: just.type's value-not-landed
      // suggests turn.loop, tab.map exhaustion suggests turn.loop, etc.
      agentHint: attempt === 0 ? agentHint : (res?.suggestedAgent || null),
      triedAgents: tried,
    });
    lastRoute = route;
    // The router probed the live URL and may have refined a web_generic
    // category by hostname — adopt it for the executor (drives just.type's
    // Enter-on-submit behavior and overlay scoping).
    if (route.pageCategory && route.pageCategory !== pageCategory) {
      logger.info(`[dom.act] pageCategory refined by router → ${route.pageCategory}`);
      pageCategory = route.pageCategory;
    }
    if (tried.has(route.agent)) break; // forced fallback re-picked a tried agent — stop
    logger.info(`[dom.act] routed "${goal.slice(0, 60)}" → ${route.agent} (rule=${route.rule}, attempt=${attempt + 1})`);
    postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → ${route.agent} (${route.rule})` });

    const run = AGENT_RUNNERS[route.agent];
    if (!run) break;
    res = await run()({
      ...args,
      goal,
      sessionId,
      agentId,
      pageCategory,
      agentContext,
      expectOverlay,
      _progressCallbackUrl,
    });
    if (res?.ok) break;
    // Mutation-applied guard: a failed executor that already landed the goal's
    // quoted value (e.g. verify criteria were over-strict) must not trigger a
    // re-route — the next agent would blindly re-type into whatever is focused.
    // Two honesty gates before crediting it:
    //   1. The failure must be a verify-REJECTED done attempt ("Done rejected")
    //      — exhaustion/element-mismatch errors mean incomplete work, not an
    //      over-strict verifier.
    //   2. The page must not still sit on an unsubmitted creation/compose URL
    //      (eventedit, ?action=TEMPLATE, /new) — a quoted value typed into an
    //      unsaved form is transient and will be lost on nav.
    if (_mutationApplied(res, goal) && !(await _stillOnUnsubmittedForm(sessionId))) {
      logger.info(`[dom.act] ${route.agent} reported failure but the goal's value was already applied — treating as complete (verification over-strict)`);
      return {
        ok: true, mutationApplied: true,
        note: 'mutation applied; verification inconclusive',
        resolvedAgent: route.agent, routeRule: route.rule, sessionId,
        output: res.output || res.result || `Applied: ${goal.slice(0, 80)}`,
      };
    }
    if (attempt === MAX_ROUTE_ATTEMPTS - 1) break;
    logger.warn(`[dom.act] ${route.agent} failed (${res?.error || 'unknown'}) — re-routing`);
    tried.add(route.agent);
    res.routeRule = route.rule;
  }
  return { ...(res || {}), resolvedAgent: lastRoute?.agent, routeRule: res?.routeRule || lastRoute?.rule, sessionId };
}

// Did a failed executor still land the goal's quoted value? Conservative:
// needs a quoted value in the goal AND a successful fill/type/reactFill
// carrying it in the result's filledFields/actionHistory/transcript — and
// the failure must be a verify-rejected done claim. Exhaustion ("Exceeded N
// inner steps", "Element mismatch"), transport and parse errors mean the
// work is incomplete — the executor never believed it was done.
function _mutationApplied(res, goal) {
  if (!res || res.ok) return false;
  const err = String(res.error || res.note || '');
  if (!/done\s+rejected|verif/i.test(err)) return false;
  const q = String(goal || '').match(/"([^"]{2,120})"/) || String(goal || '').match(/'([^']{2,120})'/);
  const target = q ? q[1].trim().toLowerCase() : '';
  if (!target) return false;
  for (const f of res.filledFields || []) {
    if (f && String(f.value || '').toLowerCase().includes(target)) return true;
  }
  const hay = [...(res.actionHistory || []), ...(res.transcript || [])]
    .map(String).filter(Boolean);
  return hay.some(h =>
    /(?:fill|type|reactfill)/i.test(h) &&
    !/→\s*failed/i.test(h) &&
    h.toLowerCase().includes(target));
}

// True when the current URL is still an unsubmitted creation/compose surface
// (eventedit form, ?action=TEMPLATE, /new shortcut, compose overlay): values
// typed there are transient until a Save/submit lands, so a failed executor's
// fill evidence must not be credited as applied work.
function _isUnsubmittedFormUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  try {
    if (classifyDeepLinkType(u) === 'compose') return true;
    const host = new URL(u).hostname;
    // Bare *.new create shortcuts (docs.new, sheets.new, cal.new): a live
    // page still showing the shortcut means the create-redirect is mid-flight
    // — transient surface, not applied work.
    if (/\.new$/.test(host)) return true;
  } catch (_) {}
  return /\/eventedit(\/|$|\?|#)|action=TEMPLATE|\/new\b|[?&#](?:new|create|draft|compose)=/i.test(u);
}

// Probe the live page URL; true when it still sits on an unsubmitted form.
// A dead/unreadable page counts as "still on the form" — conservative: when
// we can't confirm the work persisted, we don't claim it did.
async function _stillOnUnsubmittedForm(sessionId) {
  try {
    const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
    const raw = res?.result;
    const url = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
    return _isUnsubmittedFormUrl(url);
  } catch (_) {
    return true;
  }
}

module.exports = { domAct, _isPureCreateGoal, _mutationApplied, _isUnsubmittedFormUrl };
