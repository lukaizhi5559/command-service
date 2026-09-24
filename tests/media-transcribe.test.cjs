'use strict';

// Tests for media.transcribe — guards and dep-miss path only (no real Whisper run;
// the transcription happy path is exercised manually since it downloads models).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Stub deps.ensure — never install heavy deps in tests.
const depsPath = require.resolve('../src/skill-helpers/deps.cjs');
let _ensureResult = { ok: false, reason: 'missing_dep', error: 'transcribe-anything missing (test stub)' };
require.cache[depsPath] = {
  id: depsPath,
  filename: depsPath,
  loaded: true,
  exports: {
    ensure: async () => _ensureResult,
    ensurePipSync: () => _ensureResult,
    which: () => null,
    DEPS: {},
    BIN_DIR: '/tmp',
  },
};

const { mediaTranscribe } = require('../src/skills/media.transcribe.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-transcribe-test-'));
const write = (name, content) => { const p = path.join(TMP, name); fs.writeFileSync(p, content); return p; };

async function main() {
  console.log('--- arg + file guards ---');
  let r = await mediaTranscribe({});
  check('no path → no_file', r.ok === false && r.reason === 'no_file', JSON.stringify(r));
  r = await mediaTranscribe({ path: '/nonexistent/clip.mp3' });
  check('missing file → file_missing', r.ok === false && r.reason === 'file_missing', JSON.stringify(r));
  r = await mediaTranscribe({ path: TMP });
  check('directory → not_a_file', r.ok === false && r.reason === 'not_a_file', JSON.stringify(r));

  console.log('\n--- format + dep gates ---');
  const txt = write('notes.txt', 'not media\n');
  r = await mediaTranscribe({ path: txt });
  check('non-media ext → unsupported', r.ok === false && r.reason === 'unsupported', JSON.stringify(r));

  const mp3 = write('memo.mp3', 'ID3fake\n');
  r = await mediaTranscribe({ path: mp3 });
  check('dep miss → missing_dep', r.ok === false && r.reason === 'missing_dep', JSON.stringify(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
