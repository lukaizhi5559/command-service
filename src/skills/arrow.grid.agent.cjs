'use strict';

// ---------------------------------------------------------------------------
// arrow.grid.agent.cjs — Atomic agent: spreadsheet cell navigation + fill.
//
// Tier-6 executor (spreadsheet-only). Loops _executeArrowGridStep until all
// targets are filled or a step fails — bounded by a max iteration count so a
// bad state can't spin forever.
//
// Contract:
//   args: { goal, sessionId, pageCategory?, maxSteps?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeArrowGridStep } = require('./instruction.runner.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

async function arrowGridAgent(args = {}) {
  const { goal = '', sessionId, pageCategory = 'spreadsheet', maxSteps = 40, _progressCallbackUrl } = args;
  if (!sessionId) return { ok: false, error: 'arrow.grid.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'arrow.grid.agent: no goal' };

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'arrow-grid', message: `arrow.grid.agent: ${goal.slice(0, 60)}` });
    const actionHistory = [];
    let lastError = null;

    for (let i = 0; i < maxSteps; i++) {
      const res = await _executeArrowGridStep({ sessionId, goal, actionHistory, pageCategory });
      if (res?.error && res.markTried && !res.typedOk) {
        // Hard failure (non-spreadsheet page) or no more targets
        if (res.error?.includes('Not a spreadsheet')) {
          return { ok: false, error: res.error, suggestedAgent: 'tab.map.agent', sessionId, actionHistory };
        }
        lastError = res.error;
      }
      // "no more targets" → done
      if (res?.markTried && !res?.typedOk && !res?.error) {
        const filled = actionHistory.filter(a => a.startsWith('ArrowGrid: typed')).length;
        logger.info(`[arrow.grid.agent] done — ${filled} cells filled`);
        return { ok: filled > 0 || actionHistory.length === 0, output: `Filled ${filled} cell(s)`, sessionId, actionHistory };
      }
      lastError = res?.error || lastError;
    }
    return { ok: false, error: lastError || `Reached max ${maxSteps} arrow-grid steps`, suggestedAgent: 'tab.map.agent', sessionId, actionHistory };
  });
}

module.exports = { arrowGridAgent };
