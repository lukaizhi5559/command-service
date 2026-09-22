'use strict';

// Tests for the minimal-safe edit.agent rewrite:
//   - arg aliases (goal|instruction|prompt, filePath|path|file)
//   - missing file / directory reject
//   - binary extension + NUL-sniff reject
//   - >8K reject (kills the old blind first/last-2000 large-file path)
//   - rewrite acceptance floor (60% — was 30%)
//   - backup + atomic write
//   - no-change pass-through
//
// LLM calls are stubbed via require.cache on skill-llm.cjs — edit.agent
// requires it lazily inside _editSmallFile.

const fs = require('fs');
const os = require('os');
const path = require('path');
const llmPath = require.resolve('../src/skill-helpers/skill-llm.cjs');

let _llmResponse = '';
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: { askWithMessages: async () => _llmResponse },
};

const { editAgent } = require('../src/skills/edit.agent.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-agent-test-'));
const write = (name, content) => { const p = path.join(TMP, name); fs.writeFileSync(p, content); return p; };
const ORIGINAL = 'line one\nline two has a misstake\nline three\n';

async function main() {

  console.log('\n--- arg validation ---');
  let r = await editAgent({ goal: 'fix typos' });
  check('no filePath → no_file', r.ok === false && r.reason === 'no_file', JSON.stringify(r));
  r = await editAgent({ filePath: '/tmp/x.md' });
  check('no goal → no_goal', r.ok === false && r.reason === 'no_goal', JSON.stringify(r));
  r = await editAgent({ goal: 'x', filePath: '/nonexistent/dir/file.md' });
  check('missing file → file_missing', r.ok === false && r.reason === 'file_missing', JSON.stringify(r));
  r = await editAgent({ goal: 'x', filePath: TMP });
  check('directory → not_a_file', r.ok === false && r.reason === 'not_a_file', JSON.stringify(r));

  console.log('\n--- binary guard ---');
  const docx = write('fake.docx', ORIGINAL);
  r = await editAgent({ goal: 'fix typos', filePath: docx });
  check('.docx ext → binary_file', r.ok === false && r.reason === 'binary_file', JSON.stringify(r));

  const nulFile = write('hasnulls.txt', 'abc\u0000def');
  r = await editAgent({ goal: 'fix typos', filePath: nulFile });
  check('NUL sniff → binary_file', r.ok === false && r.reason === 'binary_file', JSON.stringify(r));

  console.log('\n--- size cap ---');
  const big = write('big.md', 'x'.repeat(8100));
  r = await editAgent({ goal: 'fix typos', filePath: big });
  check('>8K → file_too_large', r.ok === false && r.reason === 'file_too_large', JSON.stringify(r));
  check('big file untouched', fs.readFileSync(big, 'utf8').length === 8100);

  console.log('\n--- successful rewrite ---');
  const f1 = write('notes.md', ORIGINAL);
  _llmResponse = 'line one\nline two has a mistake\nline three\n';
  r = await editAgent({ goal: 'fix the typo', filePath: f1 });
  check('edit ok', r.ok === true && r.changed === true, JSON.stringify(r));
  check('file updated', fs.readFileSync(f1, 'utf8').includes('mistake'));
  check('no stray tmp file', !fs.existsSync(`${f1}.thinkdrop-tmp`));
  check('backupPath under ~/.thinkdrop/edits/backups', typeof r.backupPath === 'string' && r.backupPath.includes(path.join('.thinkdrop', 'edits', 'backups')) && fs.existsSync(r.backupPath));
  check('backup has original', r.backupPath && fs.readFileSync(r.backupPath, 'utf8') === ORIGINAL);
  check('stdout carries summary', typeof r.stdout === 'string' && r.stdout.length > 0);

  console.log('\n--- arg aliases ---');
  const f2 = write('alias.md', ORIGINAL);
  _llmResponse = 'line one\nline two has a mistake\nline three\n';
  r = await editAgent({ instruction: 'fix the typo', path: f2 });
  check('instruction+path aliases work', r.ok === true && r.changed === true, JSON.stringify(r));

  console.log('\n--- suspicious output rejected ---');
  const f3 = write('reject.md', ORIGINAL);
  _llmResponse = 'tiny'; // way below 60% floor
  r = await editAgent({ goal: 'rewrite', filePath: f3 });
  check('short output → suspicious_output', r.ok === false && r.reason === 'suspicious_output', JSON.stringify(r));
  check('file untouched after reject', fs.readFileSync(f3, 'utf8') === ORIGINAL);

  console.log('\n--- no-change pass-through ---');
  const f4 = write('same.md', ORIGINAL);
  _llmResponse = ORIGINAL;
  r = await editAgent({ goal: 'improve', filePath: f4 });
  check('identical output → changed:false', r.ok === true && r.changed === false, JSON.stringify(r));

  console.log('\n--- llm failure ---');
  const f5 = write('fail.md', ORIGINAL);
  _llmResponse = '';
  r = await editAgent({ goal: 'rewrite', filePath: f5 });
  check('empty LLM output → suspicious_output or llm_failed', r.ok === false && ['suspicious_output', 'llm_failed'].includes(r.reason), JSON.stringify(r));
  check('file untouched after llm failure', fs.readFileSync(f5, 'utf8') === ORIGINAL);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
