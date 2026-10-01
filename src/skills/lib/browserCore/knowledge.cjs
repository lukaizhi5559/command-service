'use strict';

// ---------------------------------------------------------------------------
// browserCore/knowledge.cjs — per-app knowledge (shortcuts, intent→URL seeds).
// ---------------------------------------------------------------------------

const appKnowledge = require('../appKnowledge.cjs');

// Load the shortcut table for a hostname as [{key, desc}] entries — the same
// shape _collectShortcuts produces inside browser.agent's tier-3 path.
function loadShortcutTable(hostname) {
  try {
    const entries = appKnowledge.loadAppKnowledge(hostname) || [];
    return entries
      .filter(e => e && e.type === 'shortcut' && e.details?.shortcut)
      .map(e => ({ key: e.details.shortcut, desc: e.summary || e.details.action || '', entryId: e.id }));
  } catch (_) {
    return [];
  }
}

module.exports = {
  loadAppKnowledge: appKnowledge.loadAppKnowledge,
  saveAppKnowledge: appKnowledge.saveAppKnowledge,
  loadAndFormat: appKnowledge.loadAndFormat,
  recordVerification: appKnowledge.recordVerification,
  loadShortcutTable,
};
