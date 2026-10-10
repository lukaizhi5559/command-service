'use strict';

/**
 * terminal/pty-session.cjs
 *
 * PTY backend abstraction. Primary backend is node-pty (prebuilt native
 * module, real forkpty). Zero-dep fallback is the BSD `script` shim:
 *   script -q /dev/null <shell> -i
 * allocates a pty, forwards our stdin pipe into it, and streams the pty
 * master back over stdout — interactive prompts work, only resize no-ops.
 *
 * Backend is probed once at first use and reported via ptyBackend():
 *   'node-pty' | 'script' | 'none'
 *
 * A PtySession exposes a uniform interface regardless of backend:
 *   .write(data)   — raw input (terminal bytes: '\n' submits, '\x03' = ^C)
 *   .onData(cb)    — raw output stream (ANSI preserved)
 *   .kill()        — terminate the shell/process tree
 *   .resize(c,r)   — window size (no-op on the script fallback)
 *   .onExit(cb)    — process exit notification
 *   .pid           — child pid (best effort)
 */

const os = require('os');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');
const { _sandboxProfile } = require('../skills/shell.run.cjs');

let _nodePty = null;
let _backend = null; // 'node-pty' | 'script' | 'none'

function ptyBackend() {
  if (_backend !== null) return _backend;
  try {
    _nodePty = require('node-pty');
    // Smoke test — some environments can require() but not forkpty
    // (sandboxed builds, missing prebuild arch). We trust the require here;
    // openSession falls back per-spawn if node-pty throws.
    _backend = 'node-pty';
  } catch (err) {
    _nodePty = null;
    _backend = _shimAvailable() ? 'script' : 'none';
    logger.warn(`[terminal] node-pty unavailable (${err.message}) — backend=${_backend}`);
  }
  return _backend;
}

function _shimAvailable() {
  if (process.platform === 'win32') return false;
  try {
    const r = require('child_process').spawnSync('python3', ['-c', 'import pty; print(1)'], { timeout: 3000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function defaultShell() {
  if (process.platform === 'win32') return { cmd: 'powershell.exe', argv: [] };
  const sh = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
  return { cmd: sh, argv: ['-i'] };
}

/**
 * Open a PTY session.
 * opts: { shell?, argv?, cwd?, env?, cols?, rows?, protectedPaths? }
 * Returns a PtySession-shaped object, or throws.
 */
function openSession(opts = {}) {
  const cols = opts.cols || 120;
  const rows = opts.rows || 30;
  const sh = opts.shell ? { cmd: opts.shell, argv: opts.argv || [] } : defaultShell();
  // NODE_PATH makes rail-installed node libraries (~/.thinkdrop/node-deps)
  // resolvable via require() in every PTY session — the actual "installed
  // globally" semantic; `npm i -g` alone never puts packages on the require path.
  const _depEnv = (() => { try { return require('../skill-helpers/deps.cjs').withNodePath({}); } catch (_) { return {}; } })();
  const env = { ...process.env, ..._depEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', CLICOLOR: '1', ...(opts.env || {}) };
  const cwd = opts.cwd || os.homedir();

  // Seatbelt wrap — deny file-write* on protected paths at the kernel
  // boundary (darwin only; _sandboxProfile returns null otherwise/absent).
  const profile = _sandboxProfile(opts.protectedPaths);
  let spawnCmd = sh.cmd;
  let spawnArgv = sh.argv;
  if (profile) {
    spawnArgv = ['-p', profile, spawnCmd, ...spawnArgv];
    spawnCmd = '/usr/bin/sandbox-exec';
  }

  const backend = ptyBackend();

  if (backend === 'node-pty') {
    try {
      return _openNodePty(spawnCmd, spawnArgv, { cwd, env, cols, rows });
    } catch (err) {
      // Prebuild extraction can drop the +x bit on spawn-helper (observed
      // under yarn zip installs → posix_spawnp EPERM). Heal and retry once.
      if (_healSpawnHelper()) {
        try {
          return _openNodePty(spawnCmd, spawnArgv, { cwd, env, cols, rows });
        } catch (_) { /* fall through to script */ }
      }
      logger.warn(`[terminal] node-pty spawn failed (${err.message}) — falling back to script shim`);
      _backend = 'script';
    }
  }
  if (_backend === 'script') {
    return _openScriptShim(spawnCmd, spawnArgv, { cwd, env, cols, rows });
  }
  throw new Error('no-pty-backend');
}

function _openNodePty(cmd, argv, { cwd, env, cols, rows }) {
  const p = _nodePty.spawn(cmd, argv, {
    name: 'xterm-256color',
    cols, rows, cwd, env,
  });
  return {
    backend: 'node-pty',
    pid: p.pid,
    write: (d) => p.write(d),
    onData: (cb) => p.onData(cb),
    onExit: (cb) => p.onExit(({ exitCode }) => cb(exitCode)),
    kill: () => { try { p.kill(); } catch (_) {} },
    resize: (c, r) => { try { p.resize(c, r); } catch (_) {} },
    _raw: p,
  };
}

function _healSpawnHelper() {
  if (process.platform === 'win32') return false;
  try {
    const helper = require('path').join(
      require.resolve('node-pty/package.json'), '..',
      'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'
    );
    if (!require('fs').existsSync(helper)) return false;
    require('fs').chmodSync(helper, 0o755);
    logger.info('[terminal] restored +x on node-pty spawn-helper');
    return true;
  } catch (_) {
    return false;
  }
}

function _openScriptShim(cmd, argv, { cwd, env }) {
  // python3 pty_shim.py <cmd> <argv> — the shim allocates a real pty,
  // forwards our stdin pipe into the master, and streams master output
  // back over stdout. (BSD `script` can't do this — it demands a tty on
  // its own stdin, which we don't have.)
  const shim = require('path').join(__dirname, 'pty_shim.py');
  const proc = spawn('python3', [shim, cmd, ...argv], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    backend: 'script',
    pid: proc.pid,
    write: (d) => { try { proc.stdin.write(d); } catch (_) {} },
    onData: (cb) => {
      proc.stdout.on('data', (c) => cb(c.toString()));
      proc.stderr.on('data', (c) => cb(c.toString()));
    },
    onExit: (cb) => proc.on('close', (code) => cb(code ?? -1)),
    kill: () => { try { proc.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000); },
    resize: () => {},
    _raw: proc,
  };
}

module.exports = { openSession, ptyBackend, defaultShell };
