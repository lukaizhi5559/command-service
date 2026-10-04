'use strict';

// ---------------------------------------------------------------------------
// turn.loop.agent.cjs — Atomic agent: Playwright think/act/verify turn loop.
//
// Thin contract over playwrightAgent. Two modes:
//   act    — full turn loop; performs actions until the goal verifies (default)
//   verify — observe + verify only; performs NO mutations (used by planner
//            "verify" steps: confirm the email sent, confirm item in cart)
//
// Contract:
//   args: { goal, sessionId, mode?: 'act'|'verify', agentId?, agentContext?,
//           url?, maxTurns?, _progressCallbackUrl?, _abortSignal? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { playwrightAgent } = require('./playwright.agent.cjs');
const { withSessionMutex, deriveSessionId } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');

async function turnLoopAgent(args = {}) {
  const { goal = '', mode = 'act', _progressCallbackUrl } = args;
  const sessionId = args.sessionId || deriveSessionId(args.agentId || 'default.agent');
  if (!sessionId) return { ok: false, error: 'turn.loop.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'turn.loop.agent: no goal' };
  // Self-derive category for standalone calls — playwrightAgent's internal
  // gates (overlay/field handling) read it.
  if (!args.pageCategory || args.pageCategory === 'web_generic') {
    try { args.pageCategory = await inferPageCategory({ agentId: args.agentId, url: args.url, task: goal }); } catch (_) {}
  }

  return withSessionMutex(sessionId, async () => {
    const isVerify = mode === 'verify';
    postProgress(_progressCallbackUrl, { tier: 'turn-loop', message: `turn.loop.agent (${mode}): ${goal.slice(0, 60)}` });

    const res = await playwrightAgent({
      ...args,
      goal: isVerify
        ? `VERIFICATION ONLY — do NOT click, type, submit, or navigate. Observe the current page and report whether this condition holds: ${goal}`
        : goal,
      sessionId,
      maxTurns: args.maxTurns ?? (isVerify ? 2 : 8),
      _progressCallbackUrl,
    });

    return {
      ok: !!(res?.ok || res?.success || res?.goalVerified),
      output: res?.output || res?.result || res?.finalResult || (res?.ok ? 'done' : undefined),
      error: res?.error,
      suggestedAgent: res?.ok ? undefined : 'tab.map.agent',
      sessionId,
      actionHistory: Array.isArray(res?.actionHistory) ? res.actionHistory
        : (Array.isArray(res?.turns) ? res.turns.map(t => String(t?.action || t).slice(0, 120)) : undefined),
      raw: res,
    };
  });
}

module.exports = { turnLoopAgent };
