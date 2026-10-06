'use strict';

/**
 * skill: terminal.agent
 *
 * PTY-backed terminal sessions for agentic work — the "hands" layer that
 * lets the agent type into real terminals: interactive installers, login
 * menus (gh auth login), REPLs, ssh, sudo prompts, anything that refuses
 * piped stdio.
 *
 * Actions:
 *   open    { cwd?, env?, cols?, rows?, shell?, argv?, label?,
 *             managedBy?, ownerRunId?, protectedPaths? }   → { sessionId }
 *   send    { sessionId, text } | { sessionId, ctrl }      → typed input
 *   read    { sessionId, mode?: 'screen'|'tail', lines? }  → visible output
 *   wait    { sessionId, match?, idleMs?, timeoutMs? }     → wait for regex/idle
 *   exec    { cmd, sessionId?, timeoutMs? }                → cmd + exit marker
 *   resize  { sessionId, cols, rows }
 *   list    {}                                              → live sessions
 *   close   { sessionId }
 *   kill_all {}
 *
 * Safety:
 * - send/exec text is scanned against shell.run's DANGEROUS_SCRIPT_PATTERNS.
 * - Password/passphrase prompts are detected on output and flagged via
 *   session.meta.prompt + terminal:prompt_wait progress events — the agent
 *   must ask_user (masked) or hand the user the live pane; it never types
 *   credentials unprompted.
 * - _abortSignal (wired by server.cjs from /automation.cancel) kills every
 *   session this call creates.
 */

const http = require('http');
const crypto = require('crypto');
const logger = require('../logger.cjs');
const store = require('../terminal/session-store.cjs');
const { DANGEROUS_SCRIPT_PATTERNS } = require('./shell.run.cjs');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 600000;
const PASSWORD_RE = /([Pp]assword( for .+)?:|[Pp]assphrase( for .+)?:|\[sudo\] password)/;

// ── Progress events (same fire-and-forget POST as cli.agent turn_live) ──────
function emitProgress(cbUrl, payload) {
  if (!cbUrl) return;
  try {
    const body = JSON.stringify(payload);
    const u = new URL(cbUrl);
    const req = http.request({
      hostname: '127.0.0.1',
      port: parseInt(u.port, 10),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    });
    req.on('error', () => {});
    req.end(body);
  } catch (_) {}
}

function _dangerScan(text) {
  for (const re of DANGEROUS_SCRIPT_PATTERNS) {
    if (re.test(text)) return `dangerous-command-blocked: ${re.source}`;
  }
  return null;
}

// Track password prompts per session; emit once per new occurrence.
function _watchPassword(session, cbUrl) {
  if (session._pwWatch) return;
  session._pwWatch = true;
  let cursor = 0;
  const check = () => {
    const { data, offset } = session.screen.rawSince(cursor);
    cursor = offset;
    if (PASSWORD_RE.test(data)) {
      if (session.meta.prompt !== 'password') {
        session.meta.prompt = 'password';
        emitProgress(cbUrl, { type: 'terminal:prompt_wait', sessionId: session.id, prompt: 'password' });
      }
    }
  };
  session.dataListeners.add(() => check());
}

async function actionOpen(args, ctx) {
  const session = store.create({
    cwd: args.cwd,
    env: args.env,
    cols: args.cols,
    rows: args.rows,
    shell: args.shell,
    argv: args.argv,
    label: args.label,
    managedBy: args.managedBy || 'agent',
    ownerRunId: args.ownerRunId || null,
    protectedPaths: args.protectedPaths,
  });
  _watchPassword(session, ctx.cbUrl);
  if (ctx.abortSignal) {
    ctx.abortSignal.addEventListener('abort', () => { try { store.close(session.id); } catch (_) {} }, { once: true });
  }
  // Give the shell a beat to print its first prompt
  await new Promise(r => setTimeout(r, 400));
  await session.screen.flush();
  emitProgress(ctx.cbUrl, { type: 'terminal:session_open', sessionId: session.id, label: session.meta.label });
  return {
    ok: true,
    sessionId: session.id,
    backend: session.backend,
    screen: session.screen.screen(),
    meta: session.meta,
  };
}

function actionSend(args) {
  const s = store.get(args.sessionId);
  if (!s) return { ok: false, error: 'session-not-found' };
  if (s.exitCode !== null) return { ok: false, error: 'session-exited', exitCode: s.exitCode };

  if (args.ctrl) {
    const map = { c: '\x03', d: '\x04', z: '\x1a', l: '\x0c', a: '\x01', e: '\x05', u: '\x15', k: '\x0b', enter: '\r', esc: '\x1b' };
    const key = String(args.ctrl).toLowerCase();
    const byte = map[key] ?? (key.length === 1 ? String.fromCharCode(key.charCodeAt(0) - 96) : null);
    if (!byte) return { ok: false, error: `unknown-ctrl-key: ${args.ctrl}` };
    s.pty.write(byte);
    return { ok: true };
  }

  const text = String(args.text ?? '');
  const danger = _dangerScan(text);
  if (danger) return { ok: false, error: danger };
  s.pty.write(text);
  return { ok: true };
}

async function actionRead(args) {
  const s = store.get(args.sessionId);
  if (!s) return { ok: false, error: 'session-not-found' };
  await s.screen.flush();
  const mode = args.mode === 'tail' ? 'tail' : 'screen';
  return {
    ok: true,
    sessionId: s.id,
    mode,
    output: mode === 'tail' ? s.screen.tailLines(args.lines || 40) : s.screen.screen(),
    prompt: s.meta.prompt,
    exited: s.exitCode !== null,
    exitCode: s.exitCode,
  };
}

function actionWait(args) {
  const s = store.get(args.sessionId);
  if (!s) return Promise.resolve({ ok: false, error: 'session-not-found' });
  const timeoutMs = Math.min(args.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const idleMs = args.idleMs || 0;
  const re = args.match ? new RegExp(args.match, 'm') : null;

  return new Promise((resolve) => {
    let cursor = null; // start from NOW — match only new output
    const start = Date.now();
    let idleTimer = null;
    let done = false;

    const finish = async (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      s.dataListeners.delete(onData);
      await s.screen.flush();
      resolve({
        ok: reason === 'match' || reason === 'idle',
        reason,
        screen: s.screen.screen(),
        prompt: s.meta.prompt,
        exited: s.exitCode !== null,
      });
    };

    const armIdle = () => {
      if (!idleMs) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('idle'), idleMs);
    };

    const onData = () => {
      const { data, offset } = s.screen.rawSince(cursor);
      cursor = offset;
      if (re && re.test(data)) return finish('match');
      armIdle();
    };

    // Initialize cursor at current end so only new output is matched
    cursor = s.screen.rawSince(null).offset;
    s.dataListeners.add(onData);
    armIdle();

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

async function actionExec(args, ctx) {
  const cmd = String(args.cmd || '');
  if (!cmd) return { ok: false, error: 'cmd-required' };
  const danger = _dangerScan(cmd);
  if (danger) return { ok: false, error: danger };

  let s = args.sessionId ? store.get(args.sessionId) : null;
  let owned = false;
  if (args.sessionId && !s) return { ok: false, error: 'session-not-found' };
  if (!s) {
    const opened = await actionOpen({ label: args.label || `exec: ${cmd.slice(0, 40)}`, managedBy: 'agent', ownerRunId: args.ownerRunId, protectedPaths: args.protectedPaths, env: args.env, cwd: args.cwd }, ctx);
    if (!opened.ok) return opened;
    s = store.get(opened.sessionId);
    owned = true;
  }

  const nonce = crypto.randomUUID().slice(0, 8);
  const markerRe = new RegExp(`__TD_EXIT_${nonce}_(\\d+)`);
  const timeoutMs = Math.min(args.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // Baseline cursor BEFORE sending — output matched from here forward.
  let cursor = s.screen.rawSince(null).offset;
  s.pty.write(`${cmd}; echo "__TD_EXIT_${nonce}_$?"\n`);

  const result = await new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); s.dataListeners.delete(onData); resolve(r); } };
    const onData = () => {
      const { data, offset } = s.screen.rawSince(cursor);
      const m = data.match(markerRe);
      if (m) {
        cursor = offset;
        finish({ exitCode: parseInt(m[1], 10), saw: true });
        return;
      }
      cursor = offset;
    };
    s.dataListeners.add(onData);
    const timer = setTimeout(() => finish({ saw: false }), timeoutMs);
  });

  await s.screen.flush();
  const screen = s.screen.screen()
    .split('\n')
    .filter(l => !l.includes(`__TD_EXIT_${nonce}`))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const out = {
    ok: result.saw === true,
    sessionId: s.id,
    owned,
    exitCode: result.saw ? result.exitCode : -1,
    screen,
    prompt: s.meta.prompt,
    error: result.saw ? undefined : `timeout after ${timeoutMs}ms`,
  };
  if (owned && result.saw) {
    // one-shot exec session — clean up unless caller asked to persist
    if (!args.keepSession) store.close(s.id);
  }
  return out;
}

function actionResize(args) {
  const s = store.get(args.sessionId);
  if (!s) return { ok: false, error: 'session-not-found' };
  s.pty.resize(args.cols || 120, args.rows || 30);
  s.meta.cols = args.cols || 120;
  s.meta.rows = args.rows || 30;
  return { ok: true };
}

function actionClose(args) {
  return { ok: store.close(args.sessionId) };
}

function actionList() {
  return { ok: true, sessions: store.list(), backend: store.ptyBackend() };
}

async function terminalAgent(args = {}) {
  const ctx = { cbUrl: args._progressCallbackUrl, abortSignal: args._abortSignal };
  const action = args.action || 'exec';
  try {
    switch (action) {
      case 'open': return await actionOpen(args, ctx);
      case 'send': return actionSend(args);
      case 'read': return await actionRead(args);
      case 'wait': return await actionWait(args);
      case 'exec': return await actionExec(args, ctx);
      case 'resize': return actionResize(args);
      case 'close': return actionClose(args);
      case 'list': return actionList(args);
      case 'kill_all': store.killAll(); return { ok: true };
      default: return { ok: false, error: `unknown-action: ${action}` };
    }
  } catch (err) {
    logger.error(`[terminal.agent] ${action} failed`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { terminalAgent };
