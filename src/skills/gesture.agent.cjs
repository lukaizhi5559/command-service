'use strict';

// ---------------------------------------------------------------------------
// gesture.agent.cjs — Atomic agent: drag-drop / slider spatial interactions.
//
// Tier-5 executor. One bounded gesture per call (single drag), so the plan
// should emit one step per drag/slider adjustment.
//
// Contract:
//   args: { goal, sessionId, pageCategory?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeGestureStep } = require('./instruction.runner.cjs');
const { probePageStructure, readActiveElement, detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { browserAct } = require('./browser.act.cjs');

async function gestureAgent(args = {}) {
  const { goal = '', sessionId, pageCategory = 'web_generic', _progressCallbackUrl } = args;
  if (!sessionId) return { ok: false, error: 'gesture.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'gesture.agent: no goal' };

  return withSessionMutex(sessionId, async () => {
    const [probe, focused, overlay] = await Promise.all([
      probePageStructure(sessionId).catch(() => null),
      readActiveElement(sessionId).catch(() => null),
      detectOverlay(sessionId, pageCategory).catch(() => null),
    ]);
    let currentUrl = '';
    try {
      const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
      const raw = res?.result;
      currentUrl = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
    } catch (_) {}

    postProgress(_progressCallbackUrl, { tier: 'gesture', message: `gesture.agent: ${goal.slice(0, 60)}` });
    const actionHistory = [];
    const res = await _executeGestureStep({
      sessionId, goal, focused, probe, actionHistory,
      overlayActive: !!(overlay && overlay.active), currentUrl,
    });
    return {
      ok: !!res?.performed,
      output: res?.performed ? `Gesture performed for: ${goal.slice(0, 60)}` : undefined,
      error: res?.performed ? undefined : (res?.error || 'Gesture not performed'),
      suggestedAgent: res?.performed ? undefined : 'tab.map.agent',
      sessionId,
      actionHistory,
    };
  });
}

module.exports = { gestureAgent };
