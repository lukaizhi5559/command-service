'use strict';

// ---------------------------------------------------------------------------
// browserCore/pageState.cjs — shared page-state probes for atomic agents.
// Thin re-exports over instruction.runner's exported internals so every atomic
// agent sees the same DOM signals (fillable/clickable counts, autofocus,
// overlay, region breakdown, spreadsheet/grid signals).
// ---------------------------------------------------------------------------

const {
  _probePageStructure,
  _readActiveElement,
  _detectOverlay,
  _overlayStateKey,
  buildTabMap,
  pageSearch,
} = require('../../instruction.runner.cjs');

// Convenience: gather everything an agent (or the router) needs in one shot.
async function snapshotPageState(sessionId, pageCategory = 'web_generic') {
  const [probe, focused, overlay] = await Promise.all([
    _probePageStructure(sessionId).catch(() => null),
    _readActiveElement(sessionId).catch(() => null),
    _detectOverlay(sessionId, pageCategory).catch(() => null),
  ]);
  const overlayActive = !!(overlay && overlay.active);
  let currentUrl = '';
  try {
    const { browserAct } = require('../../browser.act.cjs');
    const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
    const raw = res?.result;
    currentUrl = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
  } catch (_) {}
  return { probe, focused, overlay, overlayActive, currentUrl };
}

module.exports = {
  probePageStructure: _probePageStructure,
  readActiveElement: _readActiveElement,
  detectOverlay: _detectOverlay,
  overlayStateKey: _overlayStateKey,
  buildTabMap,
  pageSearch,
  snapshotPageState,
};
