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
const { deepLinkOpensOverlay } = require('../skill-helpers/deep-link-types.cjs');

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
    pageCategory = 'web_generic', agentContext = '', agentHint = null,
    triedAgents = null, _progressCallbackUrl,
    priorNavUrl = null, priorNavType = null,
  } = args;
  const goal = task || _goalArg || '';
  if (!goal) return { ok: false, error: 'dom.act: no task/goal' };

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
      agentHint: attempt === 0 ? agentHint : null,
      triedAgents: tried,
    });
    lastRoute = route;
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
    if (_mutationApplied(res, goal)) {
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
// carrying it in the result's filledFields/actionHistory/transcript.
function _mutationApplied(res, goal) {
  if (!res || res.ok) return false;
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

module.exports = { domAct, _isPureCreateGoal, _mutationApplied };
