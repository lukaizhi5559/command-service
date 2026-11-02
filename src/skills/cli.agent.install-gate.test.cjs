'use strict';
/* Unit test for the cli.agent global-install gate — parse + entity checks.
 * The registry probe (_verifyPackageExists) hits npm/brew/PyPI live, so these
 * tests exercise the parse layer and the service-entity branch only.
 * Run: node mcp-services/command-service/src/skills/cli.agent.install-gate.test.cjs */

const assert = require('assert');
const { _globalInstalls, _looksLikeFilename } = require('./cli.agent.cjs');

// ── _looksLikeFilename — hallucinated service-name sanity ───────────────────
// The observed incident: a recovery loop invented "handoffcompiletestcjs"
// (flattened handoffCompile.test.cjs) and chased an install for it.
assert(_looksLikeFilename('handoffcompiletestcjs'), 'fused test+ext run-on');
assert(_looksLikeFilename('handoffcompile.test.cjs'), 'dotted filename');
assert(_looksLikeFilename('mything.spec.ts'), 'spec file');
assert(_looksLikeFilename('x'.repeat(30)), 'extreme run-on token');
assert(!_looksLikeFilename('nylas'), 'real service');
assert(!_looksLikeFilename('ffmpeg'), 'real tool');
assert(!_looksLikeFilename('fish'), 'shell ending in sh is legit');
assert(!_looksLikeFilename('latest'), '"latest" ends in test-shape but is a real word');
assert(!_looksLikeFilename('imagemagick'), 'real tool');
assert(!_looksLikeFilename('yt-dlp'), 'hyphenated tool');

// ── _globalInstalls parse layer ─────────────────────────────────────────────
// argv-style (cmd + argv array, generic run_cmd)
{
  const hits = _globalInstalls('npm', ['install', '-g', 'skill']);
  assert(hits.length === 1 && hits[0].pkg === 'skill' && hits[0].method === 'npm', `npm -g: ${JSON.stringify(hits)}`);
}
{
  const hits = _globalInstalls('npm', ['install', 'lodash']);
  assert(hits.length === 0, 'local npm install is not a global install');
}
{
  const hits = _globalInstalls('brew', ['install', 'ffmpeg']);
  assert(hits.length === 1 && hits[0].pkg === 'ffmpeg' && hits[0].method === 'brew', 'brew install is global by default');
}
{
  const hits = _globalInstalls('pip3', ['install', 'requests']);
  assert(hits.length === 1 && hits[0].method === 'pip', 'pip3 install gated');
}
{
  // sudo prefix still parses
  const hits = _globalInstalls('sudo npm install -g typescript', null);
  assert(hits.length === 1 && hits[0].pkg === 'typescript', `sudo npm -g: ${JSON.stringify(hits)}`);
}
{
  // flags after the package name
  const hits = _globalInstalls('npm', ['install', '-g', 'yt-dlp', '--force']);
  assert(hits[0].pkg === 'yt-dlp', `pkg extracted before trailing flags: ${JSON.stringify(hits)}`);
}
{
  // script text — the observed hallucination shape
  const hits = _globalInstalls('npm install -g handoffcompiletestcjs && which handoffcompiletestcjs', null);
  assert(hits.length === 1 && hits[0].pkg === 'handoffcompiletestcjs', `script parse: ${JSON.stringify(hits)}`);
}
{
  // env-var prefix tokens are not mistaken for the package name
  const hits = _globalInstalls('npm', ['install', '-g', 'NODE_ENV=production', 'pm2']);
  // 'NODE_ENV=production' is filtered by the env-assignment guard
  assert(!hits.length || hits[0].pkg !== 'NODE_ENV=production', `env assignment not a pkg: ${JSON.stringify(hits)}`);
}
{
  // non-install commands parse clean
  assert(!_globalInstalls('git', ['status']).length, 'git status clean');
  assert(!_globalInstalls('npm', ['view', 'skill', 'version']).length, 'npm view is not an install');
  assert(!_globalInstalls('bash', ['-c', 'cd /x && git commit -m msg']).length, 'commit script clean');
}

// ── entity branch of the gate (serviceKey set → unrelated pkg blocked even
// though registry verify would pass) — exercised synchronously via the
// blocked list shape. Full _gateGlobalInstalls is async (registry probe);
// the unrelated-pkg short-circuit happens BEFORE any network call, so a
// serviceKey + clearly-unrelated pkg resolves without network.
(async () => {
  const { _gateGlobalInstalls } = require('./cli.agent.cjs');
  const r = await _gateGlobalInstalls('npm', ['install', '-g', 'totally-unrelated-pkg-xyz'], { serviceKey: 'nylas' });
  assert(r.blocked.length === 1 && /unrelated/.test(r.blocked[0].why), `entity gate blocked: ${JSON.stringify(r.blocked)}`);
  const r2 = await _gateGlobalInstalls('npm', ['install', '-g', 'nylas-cli'], { serviceKey: 'nylas' });
  // nylas-cli names the service — passes the entity check; registry verify
  // then decides (network). Either outcome is fine — the point is it was NOT
  // entity-blocked.
  assert(!r2.blocked.some(b => /unrelated/.test(b.why)), 'matching <svc>-cli alias not entity-blocked');
  console.log('cli.agent.install-gate.test.cjs: all assertions passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
