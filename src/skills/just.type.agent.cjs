'use strict';

// ---------------------------------------------------------------------------
// just.type.agent.cjs — Atomic agent: type a value into the focused element.
//
// Tier-1 executor. Runs when a field is already focused (autofocus or the
// previous step focused it). Refuses to type blindly when nothing is focused
// and no overlay is open — returns suggestedAgent so the graph can replan.
//
// Contract:
//   args: { goal, value?, sessionId, agentId?, pageCategory?, agentContext?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeJustType } = require('./instruction.runner.cjs');
const { _extractValue } = require('./browser.agent.cjs');
const { readActiveElement, detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

async function justTypeAgent(args = {}) {
  const { goal = '', sessionId, agentId = '', pageCategory = 'web_generic', agentContext = '', _progressCallbackUrl } = args;
  if (!sessionId) return { ok: false, error: 'just.type.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'just.type.agent: no goal' };

  return withSessionMutex(sessionId, async () => {
    const [focused, overlay] = await Promise.all([
      readActiveElement(sessionId).catch(() => null),
      detectOverlay(sessionId, pageCategory).catch(() => null),
    ]);
    const overlayActive = !!(overlay && overlay.active);

    if (!focused && !overlayActive) {
      logger.warn('[just.type.agent] no focused element and no overlay — cannot type blindly');
      return { ok: false, error: 'No focused element and no overlay open', suggestedAgent: 'tab.map.agent' };
    }

    let value = args.value;
    if (!value) {
      try { value = await _extractValue(goal, focused, [], agentContext); } catch (_) {}
    }
    if (!value) return { ok: false, error: 'Could not extract value to type from goal', suggestedAgent: 'tab.map.agent' };

    postProgress(_progressCallbackUrl, { tier: 'just-type', message: `just.type.agent: typing "${String(value).slice(0, 50)}"` });
    const actionHistory = [];
    const res = await _executeJustType(sessionId, value, focused, pageCategory, goal, agentContext, null, overlayActive, actionHistory);
    return { ok: !!res?.ok, output: res?.ok ? `Typed "${String(value).slice(0, 60)}"` : undefined, error: res?.error, suggestedAgent: res?.ok ? undefined : 'tab.map.agent', sessionId };
  });
}

module.exports = { justTypeAgent };
