'use strict';
/**
 * deps.cjs — shared dependency manifest + ensure() for skill-level tools/modules.
 *
 * Install rails (by kind):
 *   pip  — `python3 -m pip install --user <pkg>` — silent; user-site is
 *          non-destructive (edit.agent/video.agent precedent).
 *   brew — `brew install <pkg>` — heavier; callers may pass a `confirm(name)`
 *          callback (async → bool) to surface a consent card first. With no
 *          callback we still attempt the install — a missing tool is a
 *          hard failure either way. If brew itself is absent → missing_dep
 *          with a Homebrew hint (static-binary downloads are a later option;
 *          see the `bin` manifest slot).
 *
 * Every dep probes once per process and caches the outcome.
 *
 *   const { ensure, which } = require('../skill-helpers/deps.cjs');
 *   const dep = await ensure('pypdf');               // → { ok:true } | { ok:false, reason:'missing_dep', error }
 *   const ff  = await ensure('ffmpeg', { confirm }); // confirm?: async (name) => bool
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('../logger.cjs');

const BIN_DIR = path.join(os.homedir(), '.thinkdrop', 'bin');

// kind 'pip': probe `python3 -c "import <module>"`, install `pip install --user <pip>`
// kind 'brew': probe `which <bin>`, install `brew install <brew>`
const DEPS = {
  'python-docx':          { kind: 'pip',  module: 'docx',               pip: 'python-docx' },
  'openpyxl':             { kind: 'pip',  module: 'openpyxl',           pip: 'openpyxl' },
  'pypdf':                { kind: 'pip',  module: 'pypdf',              pip: 'pypdf' },
  'python-pptx':          { kind: 'pip',  module: 'pptx',               pip: 'python-pptx' },
  'transcribe-anything':  { kind: 'pip',  module: 'transcribe_anything', pip: 'transcribe-anything' },
  'ffmpeg':               { kind: 'brew', bin: 'ffmpeg',  brew: 'ffmpeg' },
  'pdftotext':            { kind: 'brew', bin: 'pdftotext', brew: 'poppler' },
  'pandoc':               { kind: 'brew', bin: 'pandoc',  brew: 'pandoc' },
  'whisper':              { kind: 'brew', bin: 'whisper', brew: 'openai-whisper' },
};

const _cache = {}; // name → result object (memoized per process)

function which(bin) {
  try {
    const r = spawnSync('which', [bin], { timeout: 5000, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const p = String(r.stdout).trim().split('\n')[0];
    return p || null;
  } catch (_) { return null; }
}

function _hasPython() {
  return !!which('python3');
}

function _hasBrew() {
  return !!which('brew');
}

async function _ensurePip(name, def) {
  const probe = () => spawnSync('python3', ['-c', `import ${def.module}`], { timeout: 15000 });
  if (!_hasPython()) {
    return { ok: false, reason: 'missing_dep', error: `python3 not installed — install Xcode Command Line Tools (xcode-select --install) or python.org, then retry` };
  }
  try {
    if (probe().status === 0) return { ok: true };
    logger.info(`[deps] python module '${def.module}' missing — pip3 install --user ${def.pip}`);
    const inst = spawnSync('python3', ['-m', 'pip', 'install', '--user', '--quiet', def.pip], { timeout: 240000 });
    if (inst.status !== 0) {
      return { ok: false, reason: 'missing_dep', error: `python module '${def.module}' missing and 'pip3 install --user ${def.pip}' failed — install it manually (or via pipx/venv)` };
    }
    if (probe().status === 0) return { ok: true };
    return { ok: false, reason: 'missing_dep', error: `python module '${def.module}' still missing after install` };
  } catch (e) {
    return { ok: false, reason: 'missing_dep', error: `python3 unavailable: ${e.message}` };
  }
}

async function _ensureBrew(name, def, confirm) {
  const binPath = which(def.bin) || which(path.join(BIN_DIR, def.bin));
  if (binPath) return { ok: true, path: binPath };
  if (!_hasBrew()) {
    return {
      ok: false, reason: 'missing_dep',
      error: `'${def.bin}' not installed and Homebrew is unavailable — install Homebrew (https://brew.sh) then 'brew install ${def.brew}', or install ${def.bin} manually`,
    };
  }
  if (typeof confirm === 'function') {
    try {
      const yes = await confirm(def.bin);
      if (!yes) return { ok: false, reason: 'missing_dep', error: `User declined install of '${def.bin}'` };
    } catch (_) { /* confirm failed — fall through to direct install */ }
  }
  logger.info(`[deps] '${def.bin}' missing — brew install ${def.brew}`);
  const inst = spawnSync('brew', ['install', def.brew], { timeout: 600000 });
  const after = which(def.bin);
  if (inst.status === 0 && after) return { ok: true, path: after };
  return { ok: false, reason: 'missing_dep', error: `'brew install ${def.brew}' failed — install ${def.bin} manually` };
}

/**
 * Resolve a dep by manifest name. Result memoized per process.
 * @param {string} name  key in DEPS
 * @param {object} [opts] { confirm?: async (name)=>bool }
 * @returns {Promise<{ok:true, path?:string} | {ok:false, reason:'missing_dep', error:string}>}
 */
async function ensure(name, opts = {}) {
  if (_cache[name]) return _cache[name];
  const def = DEPS[name];
  if (!def) return { ok: false, reason: 'missing_dep', error: `unknown dep '${name}'` };
  const result = def.kind === 'pip'
    ? await _ensurePip(name, def)
    : await _ensureBrew(name, def, opts.confirm);
  _cache[name] = result;
  return result;
}

/** Sync variant for pip deps already probed this process or where await isn't available. */
function ensurePipSync(name) {
  const def = DEPS[name];
  if (!def || def.kind !== 'pip') return { ok: false, reason: 'missing_dep', error: `unknown pip dep '${name}'` };
  if (_cache[name]) return _cache[name];
  // Wrap the async fn's sync internals — all spawnSync already, so just inline.
  const probe = () => spawnSync('python3', ['-c', `import ${def.module}`], { timeout: 15000 });
  try {
    if (!_hasPython()) return (_cache[name] = { ok: false, reason: 'missing_dep', error: 'python3 not installed' });
    if (probe().status === 0) return (_cache[name] = { ok: true });
    const inst = spawnSync('python3', ['-m', 'pip', 'install', '--user', '--quiet', def.pip], { timeout: 240000 });
    if (inst.status === 0 && probe().status === 0) return (_cache[name] = { ok: true });
    return (_cache[name] = { ok: false, reason: 'missing_dep', error: `pip install --user ${def.pip} failed` });
  } catch (e) {
    return (_cache[name] = { ok: false, reason: 'missing_dep', error: `python3 unavailable: ${e.message}` });
  }
}

module.exports = { DEPS, ensure, ensurePipSync, which, BIN_DIR };
