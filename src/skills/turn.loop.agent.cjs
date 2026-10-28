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
const { withSessionMutex, deriveSessionId, qualifyOpenTab, resolveExtSession } = require('./lib/browserCore/session.cjs');
const { preflightStateGate } = require('./lib/browserCore/stateEyes.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');

async function turnLoopAgent(args = {}) {
  // dom.act's re-route and BROWSER_ESCALATE both pass `task`; standalone calls
  // pass `goal`. Accept either (observed: "click on it" re-route → 'no goal').
  const goal = args.goal || args.task || '';
  const { mode = 'act', _progressCallbackUrl } = args;
  const sessionId = qualifyOpenTab(await resolveExtSession(args.sessionId || deriveSessionId(args.agentId || 'default.agent')), goal);
  if (!sessionId) return { ok: false, error: 'turn.loop.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'turn.loop.agent: no goal' };
  // Self-derive category for standalone calls — playwrightAgent's internal
  // gates (overlay/field handling) read it.
  if (!args.pageCategory || args.pageCategory === 'web_generic') {
    try { args.pageCategory = await inferPageCategory({ agentId: args.agentId, url: args.url, task: goal }); } catch (_) {}
  }

  // Page-map context — the propagated shape grounds the loop's element
  // choices on scanned facts instead of hallucinated selectors.
  if (args.pageMap) {
    const pm = args.pageMap;
    const _fields = (pm.fields || []).map(f => `${f.semanticRole || f.key}${f.ref ? `(ref:${f.ref})` : ''}`).join(', ');
    const _clickables = (Array.isArray(args.tabMap) ? args.tabMap : [])
      .filter(e => e.text || e.ariaLabel).slice(0, 15)
      .map(e => `"${(e.text || e.ariaLabel || '').slice(0, 30)}"${e.ref ? `(ref:${e.ref})` : ''}`).join(', ');
    args.agentContext = `${args.agentContext || ''}\nPage map: category=${pm.pageCategory || '?'} dialog=${pm.signature?.dialogOpen ? 'open' : 'none'} fields=[${_fields}] submit=${pm.submit ? (pm.submit.text || pm.submit.selector || 'yes') : 'none'}${_clickables ? `\nClickables: ${_clickables}` : ''}`.trim();
  }

  return withSessionMutex(sessionId, async () => {
    const isVerify = mode === 'verify';
    postProgress(_progressCallbackUrl, { tier: 'turn-loop', message: `turn.loop.agent (${mode}): ${goal.slice(0, 60)}` });

    // State-eyes preflight — turn.loop's biggest failure mode is a dead
    // session burning N turns before the streak-bail catches it. The gate
    // catches session_dead up front plus skill-fit mismatches.
    const _gate = await preflightStateGate({ sessionId, skill: 'turn.loop', goal });
    if (_gate.redirect) return { ok: false, suggestedAgent: _gate.redirect, why: _gate.why, sessionId };
    if (_gate.satisfied) return { ok: true, alreadySatisfied: true, output: _gate.why, sessionId };
    if (_gate.abort)    return { ok: false, error: _gate.reason, recoverable: false, sessionId };

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
      error: res?.error || (res && res.ok === false ? 'turn.loop failed (no error detail)' : undefined),
      suggestedAgent: res?.ok ? undefined : 'tab.map.agent',
      sessionId,
      actionHistory: Array.isArray(res?.actionHistory) ? res.actionHistory
        : (Array.isArray(res?.turns) ? res.turns.map(t => String(t?.action || t).slice(0, 120)) : undefined),
      raw: res,
    };
  });
}

module.exports = { turnLoopAgent };
