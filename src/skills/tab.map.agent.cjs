'use strict';

// ---------------------------------------------------------------------------
// tab.map.agent.cjs — Atomic agent: Tab-Map on-page interaction.
//
// The default on-page executor. Scans the page's focusable/actionable element
// map, then runs a bounded inner loop (LLM picks next action → execute →
// repeat) until the step's sub-goal is done or maxSteps is hit. No Tab-Flow,
// no tier selection — the plan owns sequencing.
//
// Contract:
//   args: { goal, sessionId, agentId?, pageCategory?, agentContext?, stepType?,
//           maxSteps?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _tabMapInnerStep, buildTabMap } = require('./instruction.runner.cjs');
const { detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { browserAct } = require('./browser.act.cjs');

async function tabMapAgent(args = {}) {
  const {
    goal = '', sessionId, agentId = '', pageCategory = 'web_generic',
    agentContext = '', stepType = 'on-page-action', maxSteps = 6,
    _progressCallbackUrl,
  } = args;
  if (!sessionId) return { ok: false, error: 'tab.map.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'tab.map.agent: no goal' };

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'tab-map', message: `tab.map.agent: ${goal.slice(0, 60)}` });

    const overlay = await detectOverlay(sessionId, pageCategory).catch(() => null);
    const overlayActive = !!(overlay && overlay.active);

    let currentUrl = '';
    const readUrl = async () => {
      try {
        const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
        const raw = res?.result;
        return (typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : raw) || '';
      } catch (_) { return currentUrl; }
    };
    currentUrl = await readUrl();

    let tabMap = await buildTabMap(sessionId, 150, { skipReset: overlayActive }).catch(() => null);
    let tabMapUrl = currentUrl;
    if (!tabMap || tabMap.length === 0) {
      return { ok: false, error: 'Tab-map scan returned no actionable elements', suggestedAgent: 'turn.loop.agent', sessionId };
    }

    const actionHistory = [];
    const filledFields = [];
    const consumedRefs = new Set();
    let lastVerifyFailed = false;
    let extractedPageText = '';
    let lastError = null;

    for (let i = 0; i < maxSteps; i++) {
      const res = await _tabMapInnerStep(
        sessionId, goal, actionHistory, currentUrl, overlayActive, pageCategory,
        agentContext, tabMap, filledFields, consumedRefs, lastVerifyFailed,
        extractedPageText, stepType,
      );
      if (res?.done) {
        if (res.ok) {
          postProgress(_progressCallbackUrl, { tier: 'tab-map', message: `tab.map.agent: done after ${i + 1} step(s)` });
          return { ok: true, output: actionHistory.join('; ') || 'done', sessionId, actionHistory };
        }
        lastError = res.error || 'Tab-map inner step failed';
        break;
      }
      // not done — keep going; rescan if the page navigated
      const newUrl = await readUrl();
      if (newUrl && newUrl !== tabMapUrl) {
        tabMapUrl = newUrl;
        currentUrl = newUrl;
        tabMap = await buildTabMap(sessionId, 150, { skipReset: overlayActive }).catch(() => tabMap);
      }
      lastError = res?.error || lastError;
    }

    logger.warn(`[tab.map.agent] exhausted/failed: ${lastError || 'max steps'}`);
    return { ok: false, error: lastError || `Exceeded ${maxSteps} inner steps`, suggestedAgent: 'turn.loop.agent', sessionId, actionHistory };
  });
}

module.exports = { tabMapAgent };
