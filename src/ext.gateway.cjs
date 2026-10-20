'use strict';

// ---------------------------------------------------------------------------
// ext.gateway.cjs — WebSocket bridge between command-service and the ThinkDrop
// Chrome extension. The extension connects to ws://127.0.0.1:<PORT>/ext on the
// same HTTP server that serves /health — no separate discovery port needed.
//
// Commands are dispatched as { type:'cmd', id, sessionId, action, args } and
// answered with { type:'result', id, ok, result?, error? } — correlated by id.
// The extension also emits { type:'event', event, ... } for lifecycle signals
// (tab closed, debugger detached, navigation).
//
// Session semantics live in the extension (it owns chrome.tabs):
//   ext:default      → the browser's currently active tab
//   ext:bg:<name>    → a dedicated background tab for non-interactive work
//   ext:<other>      → find-adopt-or-create: bind a tab whose URL host matches
//                      the command's target URL, else create one (inactive)
// ---------------------------------------------------------------------------

const logger = require('./logger.cjs');

let _ws = null;                 // the single connected extension socket
let _wss = null;
let _nextCmdId = 1;
const _pending = new Map();     // cmdId → { resolve, reject, timer, action }
const _extInfo = { connectedAt: 0, ua: '', sessions: {} };
// sessionId → { tabId, url, title, lastSeen } — fed by tabAdopted/tabCreated/
// tabNavigated events so /ext.sessions can report the REAL page each bound
// session is on (live-page referents resolve here when the frontmost app
// isn't the browser).
const _sessionTabInfo = new Map();

// ── Per-session input mutex ──────────────────────────────────────────────────
// Trusted input (Input.dispatchKeyEvent / mouse) is global in effect — a Tab
// in one tab and a typed char in another can interleave visibly. Serialize
// input-producing commands per session (and conservative global for presses).
const _sessionLocks = new Map(); // sessionId → Promise

async function withSessionLock(sessionId, fn) {
  const prev = _sessionLocks.get(sessionId);
  if (prev) await prev.catch(() => {});
  let release;
  const lock = new Promise(r => { release = r; });
  _sessionLocks.set(sessionId, lock);
  try { return await fn(); }
  finally { release(); if (_sessionLocks.get(sessionId) === lock) _sessionLocks.delete(sessionId); }
}

function hasExtension() {
  return !!_ws && _ws.readyState === 1; // WebSocket.OPEN
}

function status() {
  return {
    connected: hasExtension(),
    connectedAt: _extInfo.connectedAt || null,
    ua: _extInfo.ua || null,
    pendingCommands: _pending.size,
  };
}

function _cachedSessions() {
  return [..._sessionTabInfo.entries()].map(([sessionId, s]) => ({
    sessionId, tabId: s.tabId, url: s.url || null, title: s.title || null, lastSeen: s.lastSeen,
  }));
}

async function sessions() {
  const connected = hasExtension();
  if (!connected) return { connected: false, sessions: _cachedSessions() };
  // Live query — hydrated/restored bindings emit no events, so the event-fed
  // cache alone under-reports. Merge the extension's authoritative list.
  try {
    const res = await sendCmd({ sessionId: 'ext:default', action: 'listSessions' }, 4000);
    if (res?.ok && Array.isArray(res.sessions)) {
      const now = Date.now();
      for (const s of res.sessions) {
        if (s?.sessionId) _sessionTabInfo.set(s.sessionId, { tabId: s.tabId, url: s.url, title: s.title, lastSeen: now });
      }
      return { connected: true, sessions: res.sessions.filter(s => s && s.alive !== false && s.url) };
    }
  } catch (_) { /* fall through to cache */ }
  return { connected: true, sessions: _cachedSessions() };
}

function _rejectAllPending(reason) {
  for (const [id, p] of _pending) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
    _pending.delete(id);
  }
}

function _onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }

  switch (msg.type) {
    case 'hello':
      _extInfo.connectedAt = Date.now();
      _extInfo.ua = msg.ua || '';
      logger.info(`[ext.gateway] extension hello (ua=${(msg.ua || '').slice(0, 60)})`);
      try { ws.send(JSON.stringify({ type: 'hello-ack' })); } catch (_) {}
      break;

    case 'result': {
      const p = _pending.get(msg.id);
      // Late result for a timed-out/rejected command — expected under load;
      // warn only on genuine protocol drift by keeping it at debug level.
      if (!p) { logger.debug(`[ext.gateway] result for unknown cmd id=${msg.id} (late)`); break; }
      clearTimeout(p.timer);
      _pending.delete(msg.id);
      p.resolve(msg);
      break;
    }

    case 'event': {
      // Lifecycle signals from the extension (debugger detached, tab closed…)
      logger.info(`[ext.gateway] event: ${msg.event}${msg.sessionId ? ` session=${msg.sessionId}` : ''}${msg.tabId != null ? ` tab=${msg.tabId}` : ''}`);
      // Track bound-tab URLs — /ext.sessions serves this to the stategraph
      // so live-page referents resolve to the real bound page.
      if (msg.sessionId) {
        const sid = canonicalSessionId(msg.sessionId);
        if (msg.event === 'tabClosed' || msg.event === 'tabUnbound') {
          _sessionTabInfo.delete(sid);
        } else if (msg.event === 'tabAdopted' || msg.event === 'tabCreated' || msg.event === 'tabActivated' || msg.event === 'tabNavigated') {
          const prev = _sessionTabInfo.get(sid) || {};
          _sessionTabInfo.set(sid, {
            tabId: msg.tabId != null ? msg.tabId : prev.tabId,
            url: msg.url || prev.url || null,
            title: msg.title || prev.title || null,
            lastSeen: Date.now(),
          });
        }
      }
      break;
    }

    case 'ping':
      // Application-level keepalive from the extension's watchdog alarm —
      // answer with pong so both ends can detect a half-dead socket.
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
      break;

    case 'pong':
      break;

    default:
      logger.warn(`[ext.gateway] unknown message type: ${msg.type}`);
  }
}

/**
 * Attach the gateway to an existing http.Server — handles Upgrade requests
 * on path /ext only; all other upgrade attempts are rejected.
 */
function attach(httpServer) {
  const { WebSocketServer } = require('ws');
  _wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (_) {}
    if (pathname !== '/ext') { socket.destroy(); return; }
    _wss.handleUpgrade(req, socket, head, (ws) => _wss.emit('connection', ws, req));
  });

  _wss.on('connection', (ws) => {
    if (_ws && _ws !== ws && _ws.readyState === 1) {
      // One extension bridge at a time — replace stale socket.
      try { _ws.terminate(); } catch (_) {}
    }
    _ws = ws;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (d) => _onMessage(ws, d));
    ws.on('close', () => {
      logger.warn('[ext.gateway] extension disconnected');
      if (_ws === ws) _ws = null;
      _rejectAllPending('extension disconnected');
    });
    ws.on('error', (e) => logger.warn(`[ext.gateway] ws error: ${e.message}`));
  });

  // Heartbeat: ping every 20s; terminate sockets that miss a pong.
  const hb = setInterval(() => {
    if (!_wss) return;
    for (const ws of _wss.clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, 20000);
  hb.unref();

  logger.info('[ext.gateway] attached — extension endpoint ws://127.0.0.1:<PORT>/ext');
}

/**
 * Send a command to the extension and await its result.
 * Returns the extension's raw result message payload.
 * Never throws on timeout — returns {ok:false, error} instead.
 */
// Session IDs must be canonical 'ext:<name>' on the wire. Several callers
// (deep-link nav, browser.agent, plan steps) still pass raw names like
// 'ebay_agent' — the extension then binds a *separate* session record, so a
// navigate under 'ebay_agent' and a snapshot under 'ext:ebay_agent' hit
// different tabs (observed: nav went to the real ebay tab while snapshots
// scanned a fresh about:blank). Normalize at the boundary: prefer a live
// registered session when one matches, else prefix 'ext:'.
function canonicalSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return sessionId;
  if (sessionId.startsWith('ext:')) return sessionId;
  const suffixed = `ext:${sessionId}_agent`;
  if (_sessionTabInfo.has(suffixed)) return suffixed;
  return `ext:${sessionId}`;
}

async function sendCmd({ sessionId, action, args = {} }, timeoutMs = 20000) {
  if (!hasExtension()) {
    return { ok: false, error: 'ThinkDrop extension not connected — click the ThinkDrop icon in Chrome to connect' };
  }
  sessionId = canonicalSessionId(sessionId);
  const id = _nextCmdId++;
  const payload = { type: 'cmd', id, sessionId, action, args };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve({ ok: false, error: `ext command '${action}' timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    _pending.set(id, { resolve, timer, action });
    try {
      _ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      _pending.delete(id);
      resolve({ ok: false, error: `ext send failed: ${e.message}` });
    }
  });
}

function close() {
  _rejectAllPending('gateway shutting down');
  try { if (_ws) _ws.terminate(); } catch (_) {}
  try { if (_wss) _wss.close(); } catch (_) {}
  _wss = null; _ws = null;
}

module.exports = { attach, sendCmd, hasExtension, status, sessions, withSessionLock, close };
