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
const http = require('http');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);

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

// tabId → {url, title, mediaTitle, state, lastSeen} — live media playback
// state reported by the media-probe content script. Consumed by the audio
// journal's is-playing verdict (page-open ≠ playing).
const _mediaState = new Map();

// Forward media.playing to the memory-service audio journal — fire-and-forget.
function _postAudioContext(payload) {
  try {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port: MEMORY_PORT, path: '/audio.context',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
    }, (res) => res.resume());
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch (_) {}
}

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

async function _reconcileSessions(timeoutMs = 4000) {
  // Live query — hydrated/restored bindings emit no events, so the event-fed
  // cache alone under-reports. It also OVER-reports after downtime: a
  // tabClosed/unbind emitted while the socket was dead is gone forever,
  // leaving a phantom binding that points at a dead tab (observed: the
  // amazon_agent binding survived in cache after the real tab died, and a
  // follow-up click minted about:blank instead of adopting the live tab).
  // The extension's listSessions is authoritative — merge AND prune.
  let res = await sendCmd({ sessionId: 'ext:default', action: 'listSessions' }, timeoutMs);
  // MV3 cold-boot: a suspended worker can exceed the timeout hydrating
  // before it answers — one retry beats falling back to a stale cache.
  if (!res?.ok && /timed out/i.test(res?.error || '')) {
    res = await sendCmd({ sessionId: 'ext:default', action: 'listSessions' }, timeoutMs + 2000);
  }
  if (!(res?.ok && Array.isArray(res.sessions))) return null;
  const now = Date.now();
  const liveIds = new Set();
  for (const s of res.sessions) {
    if (!s?.sessionId) continue;
    if (s.alive !== false) liveIds.add(s.sessionId);
    _sessionTabInfo.set(s.sessionId, { tabId: s.tabId, url: s.url, title: s.title, lastSeen: now });
  }
  for (const sid of [..._sessionTabInfo.keys()]) {
    if (!liveIds.has(sid)) _sessionTabInfo.delete(sid);
  }
  return res.sessions;
}

async function sessions() {
  const connected = hasExtension();
  if (!connected) return { connected: false, sessions: _cachedSessions() };
  try {
    const live = await _reconcileSessions();
    if (live) return { connected: true, sessions: live.filter(s => s && s.alive !== false && s.url) };
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
      // Reconnect after downtime — lifecycle events emitted while the socket
      // was dead are gone forever; reconcile the session cache against the
      // extension's authoritative registry before the next /ext.sessions read.
      _reconcileSessions().catch(() => {});
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
      // Media probe reports — per-tab playing/paused/ended state for the
      // audio journal's is-playing verdict (web video, Meet/Zoom-in-browser).
      if (msg.event === 'media.playing' && msg.tabId != null) {
        if (msg.state === 'none') {
          _mediaState.delete(msg.tabId);
        } else {
          _mediaState.set(msg.tabId, {
            url: msg.url || null, title: msg.title || null,
            mediaTitle: msg.mediaTitle || null, state: msg.state || 'idle',
            lastSeen: Date.now(),
          });
        }
        _postAudioContext({
          tabId: msg.tabId, url: msg.url || null, title: msg.title || null,
          mediaTitle: msg.mediaTitle || null, state: msg.state || null,
          app: 'web',
        });
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
