'use strict';

// ---------------------------------------------------------------------------
// browserCore/session.cjs — session identity + serialization for atomic agents.
// ---------------------------------------------------------------------------

const { browserAgent, _withSessionMutex } = require('../../browser.agent.cjs');

// browser.agent derives run sessions as `${agentId minus .agent}_agent`.
// Keep the same convention so atomic-agent steps share the session a
// url.first.agent step created.
function deriveSessionId(agentId) {
  const base = String(agentId || 'default').replace(/\.agent$/i, '').replace(/_agent$/i, '').replace(/\s+/g, '_');
  return `${base}_agent`;
}

// Serialize work on a browser session — delegates to browser.agent's shared
// mutex map so atomic agents can't race each other (or a legacy run) on the
// same session.
async function withSessionMutex(sessionId, fn) {
  return _withSessionMutex(sessionId, fn);
}

// "in an open tab / the open tab" — the user is asking for an ALREADY-OPEN tab
// to be adopted (vs the default front-or-new policy). Requires an explicit
// `open tab` noun phrase; loose words like "existing" alone don't qualify —
// a miss degrades to front-or-new (harmless), a false-positive hijacks a tab.
const OPEN_TAB_RE = /\b(?:in|on|into|inside|using|use|via|within)\s+(?:an?|the|my|that|this|any)\s+open\s+tab\b|\b(?:the|an?|my|that|this)\s+open\s+tab\b/i;

/**
 * Prefix `open:` on a sessionId when the task text requests an already-open
 * tab. The extension treats ext:open:<name> as adopt-or-background; under the
 * engine path the prefix is just a session name (harmless).
 */
function qualifyOpenTab(sessionId, text) {
  const sid = String(sessionId || '');
  if (!sid || /^(ext:|bg:|open:)/.test(sid)) return sid;
  return OPEN_TAB_RE.test(String(text || '')) ? `open:${sid}` : sid;
}

module.exports = { deriveSessionId, withSessionMutex, qualifyOpenTab, OPEN_TAB_RE };
