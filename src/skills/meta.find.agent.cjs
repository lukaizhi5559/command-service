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
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

async function metaFindAgent(args = {}) {
  const { goal = '', sessionId, _progressCallbackUrl } = args;
  if (!sessionId) return { ok: false, error: 'meta.find.agent: no sessionId' };
  if (!goal && !args.searchText) return { ok: false, error: 'meta.find.agent: no goal/searchText' };

  return withSessionMutex(sessionId, async () => {
    let searchText = args.searchText;
    if (!searchText) {
      try { searchText = await _extractSearchText(goal, []); } catch (_) {}
    }
    if (!searchText) return { ok: false, error: 'Could not extract search text from goal', suggestedAgent: 'tab.map.agent' };

    postProgress(_progressCallbackUrl, { tier: 'meta-find', message: `meta.find.agent: searching for "${String(searchText).slice(0, 50)}"` });
    const res = await _executeMetaF(sessionId, searchText);
    return {
      ok: !!res?.ok,
      output: res?.ok ? `Found "${searchText}"` : undefined,
      error: res?.error,
      suggestedAgent: res?.ok ? undefined : 'tab.map.agent',
      sessionId,
    };
  });
}

module.exports = { metaFindAgent };
