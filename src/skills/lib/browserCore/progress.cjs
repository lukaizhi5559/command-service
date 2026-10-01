'use strict';

// ---------------------------------------------------------------------------
// browserCore/progress.cjs — progress events posted back to the UI.
// ---------------------------------------------------------------------------

const { _postProgress } = require('../../browser.agent.cjs');

function postProgress(callbackUrl, evt) {
  try { _postProgress(callbackUrl, evt); } catch (_) {}
}

module.exports = { postProgress };
