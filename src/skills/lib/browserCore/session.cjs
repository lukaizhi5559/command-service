'use strict';

// ---------------------------------------------------------------------------
// browserCore/session.cjs — session identity + serialization for atomic agents.
// ---------------------------------------------------------------------------

const { browserAgent, _withSessionMutex } = require('../../browser.agent.cjs');

// browser.agent derives run sessions as `${agentId minus .agent}_agent`.
// Keep the same convention so atomic-agent steps share the session a
// url.first.agent step created.
function deriveSessionId(agentId) {
  const base = String(agentId || 'default').replace(/\.agent$/i, '').replace(/\s+/g, '_');
  return `${base}_agent`;
}

// Serialize work on a browser session — delegates to browser.agent's shared
// mutex map so atomic agents can't race each other (or a legacy run) on the
// same session.
async function withSessionMutex(sessionId, fn) {
  return _withSessionMutex(sessionId, fn);
}

module.exports = { deriveSessionId, withSessionMutex };
