'use strict';

// ---------------------------------------------------------------------------
// browserCore/session.cjs — session identity + serialization for atomic agents.
// ---------------------------------------------------------------------------

const { browserAgent, _withSessionMutex } = require('../../browser.agent.cjs');

// browser.agent derives run sessions as `${agentId minus .agent}_agent`.
// Keep the same convention so atomic-agent steps share the session a
// url.first.agent step created.
function deriveSessionId(agentId) {
  const raw = String(agentId || 'default').trim();
  // ext:/open:/bg:-prefixed ids are already session names, not agent ids —
  // deriving again would mint a nonexistent session (ext:default →
  // ext:default_agent → "no live tab for session 'ext:default_agent'").
  if (/^(ext:|open:|bg:)/i.test(raw)) return raw;
  const base = raw.replace(/\.agent$/i, '').replace(/_agent$/i, '').replace(/\s+/g, '_');
  return `${base}_agent`;
}

// Serialize work on a browser session — delegates to browser.agent's shared
// mutex map so atomic agents can't race each other (or a legacy run) on the
// same session.
async function withSessionMutex(sessionId, fn, owner) {
  return _withSessionMutex(sessionId, fn, owner);
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

/**
 * Normalize a bare engine session name to its bound extension session when
 * one exists. Plans sometimes emit `ebay_agent` (agentId-derived) while the
 * live binding is `ext:ebay_agent` — skills then ran engine paths and found
 * "no page" / "no URL resolved" (observed: "go back to my ebay tab" →
 * turn.loop on `ebay_agent` → turn_loop_exhausted). Returns the input
 * unchanged when the extension is disconnected or nothing is bound.
 */
async function resolveExtSession(sessionId) {
  const sid = String(sessionId || '');
  if (!sid || sid.startsWith('ext:') || sid.startsWith('_')) return sid;
  try {
    const _gw = require('../../../ext.gateway.cjs');
    if (!_gw.hasExtension || !_gw.hasExtension()) return sid;
    const bound = ((await _gw.sessions().catch(() => null))?.sessions || [])
      .filter(s => s && s.alive !== false);
    const exact = bound.find(s => s.sessionId === `ext:${sid}`);
    if (exact) return exact.sessionId;
    // Name-derived: ebay_agent → ebay, match ext:<name>_agent
    const base = sid.replace(/_agent$/i, '');
    const named = bound.find(s => s.sessionId === `ext:${base}_agent`);
    if (named) return named.sessionId;
    // Extension-first policy (F9-B): when the extension is connected, browser
    // work runs in the user's real Chrome — `ext:<name>` binds on first use
    // (adopt-or-create). The Playwright engine is the fallback for when the
    // extension is absent, not a peer transport.
    if (_gw.hasExtension()) return `ext:${sid}`;
    return sid;
  } catch (_) { return sid; }
}

module.exports = { deriveSessionId, withSessionMutex, qualifyOpenTab, resolveExtSession, OPEN_TAB_RE };
