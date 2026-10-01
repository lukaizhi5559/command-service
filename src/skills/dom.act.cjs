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
const { routeOnPageAction } = require('./lib/browserCore/router.cjs');
const { deriveSessionId } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

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
  } = args;
  const goal = task || _goalArg || '';
  if (!goal) return { ok: false, error: 'dom.act: no task/goal' };

  const sessionId = _sid || deriveSessionId(agentId);
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
    _progressCallbackUrl,
  });
  return { ...res, resolvedAgent: route.agent, routeRule: route.rule, sessionId };
}

module.exports = { domAct };
