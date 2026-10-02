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

  const route = await routeOnPageAction({
    sessionId, goal, pageCategory, agentHint,
    triedAgents: triedAgents ? new Set(triedAgents) : null,
  });

  logger.info(`[dom.act] routed "${goal.slice(0, 60)}" → ${route.agent} (rule=${route.rule})`);
  postProgress(_progressCallbackUrl, { tier: 'route', message: `dom.act → ${route.agent} (${route.rule})` });

  const run = AGENT_RUNNERS[route.agent]();
  const res = await run({
    ...args,
    goal,
    sessionId,
    agentId,
    pageCategory,
    agentContext,
    expectOverlay,
    _progressCallbackUrl,
  });
  return { ...res, resolvedAgent: route.agent, routeRule: route.rule, sessionId };
}

module.exports = { domAct };
