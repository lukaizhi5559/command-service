'use strict';

/**
 * terminal/session-store.cjs
 *
 * Registry of live PTY sessions. Each entry:
 *   { id, pty, screen, meta, transcriptPath, killed, exitCode, dataListeners }
 *
 * - Every session appends ANSI-stripped output to a transcript file under
 *   ~/.thinkdrop/logs/terminal/ — the audit log.
 * - dataListeners receive raw (ANSI-preserving) chunks — the ws bridge for
 *   the renderer's xterm.js pane subscribes here.
 * - An idle sweeper kills abandoned sessions: agent sessions 30min, user-
 *   attached 2h (a user may open a pane and walk away).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../logger.cjs');
const { openSession, ptyBackend } = require('./pty-session.cjs');
const { ScreenBuffer, stripAnsi } = require('./screen-buffer.cjs');
const { getCwdRoots } = require('../skills/shell.run.cjs');

const LOG_DIR = path.join(os.homedir(), '.thinkdrop', 'logs', 'terminal');
const AGENT_IDLE_TTL_MS = 30 * 60 * 1000;
const USER_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

const sessions = new Map();
let _sweepTimer = null;

function _ensureDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}

function _validateCwd(cwd) {
  if (!cwd) return os.homedir();
  const resolved = path.resolve(cwd);
  const roots = getCwdRoots();
  if (!roots.some(r => resolved === r || resolved.startsWith(r + path.sep))) {
    throw new Error(`cwd-not-allowed: ${resolved} is outside allowed roots`);
  }
  return resolved;
}

function create(opts = {}) {
  const id = `t_${crypto.randomUUID().slice(0, 8)}`;
  const cwd = _validateCwd(opts.cwd);
  const pty = openSession({ ...opts, cwd });
  const screen = new ScreenBuffer(opts.cols || 120, opts.rows || 30);
  _ensureDir();
  const transcriptPath = path.join(LOG_DIR, `${id}.log`);
  const transcript = fs.createWriteStream(transcriptPath, { flags: 'a' });

  const session = {
    id, pty, screen, transcript, transcriptPath,
    backend: pty.backend,
    killed: false,
    exitCode: null,
    dataListeners: new Set(),
    meta: {
      id,
      label: opts.label || null,
      managedBy: opts.managedBy || 'agent',
      ownerRunId: opts.ownerRunId || null,
      shell: opts.shell || null,
      cwd,
      cols: opts.cols || 120,
      rows: opts.rows || 30,
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
      prompt: null, // 'password' | null — set by prompt detection in terminal.agent
    },
  };

  pty.onData((data) => {
    session.meta.lastActivity = Date.now();
    screen.write(data);
    try { transcript.write(stripAnsi(data)); } catch (_) {}
    for (const cb of session.dataListeners) {
      try { cb(data); } catch (_) {}
    }
  });

  pty.onExit((code) => {
    session.exitCode = code;
    session.meta.exitedAt = new Date().toISOString();
    try { transcript.end(`\n[session exited code=${code}]\n`); } catch (_) {}
    for (const cb of session.dataListeners) {
      try { cb(`\n[session exited code=${code}]\n`); } catch (_) {}
    }
  });

  sessions.set(id, session);
  _ensureSweeper();
  return session;
}

function get(id) { return sessions.get(id) || null; }

function list() {
  return [...sessions.values()].map(s => ({
    id: s.id,
    backend: s.backend,
    killed: s.killed,
    exitCode: s.exitCode,
    meta: s.meta,
  }));
}

function close(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.killed = true;
  try { s.pty.kill(); } catch (_) {}
  try { s.transcript.end(`\n[session closed by request]\n`); } catch (_) {}
  sessions.delete(id);
  return true;
}

function killAll() {
  for (const id of [...sessions.keys()]) close(id);
}

/** Find sessions owned by a run/task (for cleanup + cancel routing). */
function findByOwner(ownerRunId) {
  return [...sessions.values()].filter(s => s.meta.ownerRunId === ownerRunId);
}

function _ensureSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.exitCode !== null) { // exited — keep briefly for late reads, then reap
        if (now - s.meta.lastActivity > 5 * 60 * 1000) sessions.delete(s.id);
        continue;
      }
      const ttl = s.meta.managedBy === 'user' ? USER_IDLE_TTL_MS : AGENT_IDLE_TTL_MS;
      if (now - s.meta.lastActivity > ttl) {
        logger.info(`[terminal] idle session ${s.id} exceeded ttl — killing`);
        close(s.id);
      }
    }
    if (sessions.size === 0 && _sweepTimer) {
      clearInterval(_sweepTimer);
      _sweepTimer = null;
    }
  }, SWEEP_MS);
  _sweepTimer.unref?.();
}

module.exports = { create, get, list, close, killAll, findByOwner, LOG_DIR, ptyBackend };
