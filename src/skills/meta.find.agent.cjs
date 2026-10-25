'use strict';

// ---------------------------------------------------------------------------
// meta.find.agent.cjs — Atomic agent: Meta+F / window.find to locate text on
// the current page and click the closest match.
//
// Contract:
//   args: { goal, searchText?, sessionId, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeMetaF } = require('./instruction.runner.cjs');
const { _extractSearchText } = require('./browser.agent.cjs');
const { withSessionMutex, qualifyOpenTab } = require('./lib/browserCore/session.cjs');
const { browserAct } = require('./browser.act.cjs');
const { preflightStateGate } = require('./lib/browserCore/stateEyes.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

async function metaFindAgent(args = {}) {
  const { goal = '', sessionId: _sid, _progressCallbackUrl } = args;
  const sessionId = qualifyOpenTab(_sid, goal);
  if (!sessionId) return { ok: false, error: 'meta.find.agent: no sessionId' };
  if (!goal && !args.searchText) return { ok: false, error: 'meta.find.agent: no goal/searchText' };

  return withSessionMutex(sessionId, async () => {
    const _gate = await preflightStateGate({ sessionId, skill: 'meta.find', goal });
    if (_gate.redirect) return { ok: false, suggestedAgent: _gate.redirect, why: _gate.why, sessionId };
    if (_gate.satisfied) return { ok: true, alreadySatisfied: true, output: _gate.why, sessionId };
    if (_gate.abort)    return { ok: false, error: _gate.reason, sessionId };
    let searchText = args.searchText;
    if (!searchText) {
      try { searchText = await _extractSearchText(goal, []); } catch (_) {}
    }
    if (!searchText) return { ok: false, error: 'Could not extract search text from goal', suggestedAgent: 'tab.map.agent' };

    // Map hit fast path — a propagated tabMap entry matching the target
    // clicks directly by live ref; no find-dialog needed.
    const _mapHit = (Array.isArray(args.tabMap) ? args.tabMap : []).find(e =>
      String(e.text || e.ariaLabel || '').toLowerCase().includes(String(searchText).toLowerCase()));
    if (_mapHit?.ref) {
      const cr = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
        text: `(() => { const el = document.querySelector('[data-td-ref="${_mapHit.ref}"]'); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()` }).catch(() => null);
      if (cr?.result === true || cr?.result === 'true') {
        postProgress(_progressCallbackUrl, { tier: 'meta-find', message: `meta.find.agent: clicked mapped "${String(searchText).slice(0, 40)}"` });
        return { ok: true, output: `Clicked mapped "${searchText}"`, sessionId, actionHistory: [`Map click "${String(searchText).slice(0, 40)}" (ref ${_mapHit.ref}) → ok`] };
      }
    }

    postProgress(_progressCallbackUrl, { tier: 'meta-find', message: `meta.find.agent: searching for "${String(searchText).slice(0, 50)}"` });
    const res = await _executeMetaF(sessionId, searchText);
    return {
      ok: !!res?.ok,
      output: res?.ok ? `Found "${searchText}"` : undefined,
      error: res?.error,
      suggestedAgent: res?.ok ? undefined : 'tab.map.agent',
      sessionId,
      actionHistory: [`Meta+F "${String(searchText).slice(0, 40)}" ${res?.ok ? '→ found' : '→ not found'}`],
    };
  });
}

module.exports = { metaFindAgent };
