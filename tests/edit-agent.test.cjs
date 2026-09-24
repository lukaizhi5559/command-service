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
let _llmResponder = null; // optional fn(messages) → string, wins over _llmResponse
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: {
    askWithMessages: async (msgs) => _llmResponder ? _llmResponder(msgs) : _llmResponse,
  },
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
  const docx = write('fake.docx', ORIGINAL); // plain text in a .docx wrapper
  r = await editAgent({ goal: 'fix typos', filePath: docx });
  check('.docx routes to office handler (extract fails on fake file) → office_ops_failed', r.ok === false && r.reason === 'office_ops_failed', JSON.stringify(r));

  const nulFile = write('hasnulls.txt', 'abc\u0000def');
  r = await editAgent({ goal: 'fix typos', filePath: nulFile });
  check('NUL sniff → binary_file', r.ok === false && r.reason === 'binary_file', JSON.stringify(r));

  console.log('\n--- size cap ---');
  const big = write('big.md', 'x'.repeat(8100));
  _llmResponse = ''; // locate-anchor LLM call returns nothing usable
  r = await editAgent({ goal: 'fix typos', filePath: big });
  check('>8K, no anchor → region_not_found', r.ok === false && r.reason === 'region_not_found', JSON.stringify(r));
  check('big file untouched', fs.readFileSync(big, 'utf8').length === 8100);

  const huge = write('huge.md', 'x'.repeat(210000));
  r = await editAgent({ goal: 'fix typos', filePath: huge });
  check('>200K → file_too_large', r.ok === false && r.reason === 'file_too_large', JSON.stringify(r));

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

  // ── Phase 2 ──────────────────────────────────────────────────────────────

  console.log('\n--- draft mode ---');
  const fd1 = write('draftme.md', ORIGINAL);
  _llmResponder = null;
  _llmResponse = 'line one\nline two has a mistake\nline three\n';
  r = await editAgent({ goal: 'fix the typo', filePath: fd1, mode: 'draft' });
  check('draft ok, mode=draft', r.ok === true && r.mode === 'draft', JSON.stringify(r));
  check('draftPath exists', typeof r.draftPath === 'string' && fs.existsSync(r.draftPath), r.draftPath);
  check('original untouched by draft', fs.readFileSync(fd1, 'utf8') === ORIGINAL);
  check('diff present with +/- lines', typeof r.diff === 'string' && r.diff.includes('+line two has a mistake'), (r.diff || '').slice(0, 200));
  check('draft content has the fix', fs.readFileSync(r.draftPath, 'utf8').includes('mistake'));

  console.log('\n--- apply mode ---');
  r = await editAgent({ mode: 'apply', draftPath: r.draftPath, filePath: fd1 });
  check('apply ok', r.ok === true && r.changed === true, JSON.stringify(r));
  check('original updated after apply', fs.readFileSync(fd1, 'utf8').includes('mistake'));
  check('apply made a backup', typeof r.backupPath === 'string' && fs.existsSync(r.backupPath));
  r = await editAgent({ mode: 'apply', draftPath: '/nonexistent/draft.md', filePath: fd1 });
  check('missing draft → no_draft', r.ok === false && r.reason === 'no_draft', JSON.stringify(r));
  const wrongExt = write('wrongext.txt', ORIGINAL);
  const mdDraft = write('somedraft.md', 'changed\n');
  r = await editAgent({ mode: 'apply', draftPath: mdDraft, filePath: wrongExt });
  check('ext mismatch → ext_mismatch', r.ok === false && r.reason === 'ext_mismatch', JSON.stringify(r));

  console.log('\n--- lsof auto-draft ---');
  const fdHeld = write('held.md', ORIGINAL);
  const fd = fs.openSync(fdHeld, 'r'); // hold a handle → lsof reports it open
  try {
    _llmResponse = 'line one\nline two has a mistake\nline three\n';
    r = await editAgent({ goal: 'fix the typo', filePath: fdHeld }); // mode defaults to inplace
    check('open file forces draft mode', r.ok === true && r.mode === 'draft' && r.autoDraft === true, JSON.stringify(r));
    check('held file untouched', fs.readFileSync(fdHeld, 'utf8') === ORIGINAL);
  } finally {
    fs.closeSync(fd);
  }

  console.log('\n--- region-anchored large file ---');
  const pad = 'padding line\n'.repeat(700); // ~9100 chars
  const big2 = write('region.md', pad + 'the quik brown fox\n' + pad);
  _llmResponder = (msgs) => {
    const m = msgs[1].content.match(/Content to edit:\n---\n([\s\S]*?)\n---\n\nEdited content:/);
    return m ? m[1].replace('quik', 'quick') : '';
  };
  r = await editAgent({ goal: "fix 'quik' typo", filePath: big2 });
  check('region edit ok', r.ok === true && r.changed === true, JSON.stringify(r));
  const big2After = fs.readFileSync(big2, 'utf8');
  check('fix applied inside region', big2After.includes('the quick brown fox'));
  check('no quik left', !big2After.includes('quik'));
  check('file outside region intact', big2After.startsWith(pad) && big2After.endsWith(pad));

  console.log('\n--- region_not_found ---');
  const big3 = write('region2.md', pad + 'nothing relevant here\n' + pad);
  _llmResponder = () => '{"anchor":"zzz text that is not in the file"}';
  r = await editAgent({ goal: 'change something unquoted', filePath: big3 });
  check('unverifiable anchor → region_not_found', r.ok === false && r.reason === 'region_not_found', JSON.stringify(r));

  console.log('\n--- ambiguous_region ---');
  const big4 = write('region3.md', pad + 'dup TARGET word\n' + pad + 'dup TARGET word\n' + pad);
  r = await editAgent({ goal: "fix 'TARGET'", filePath: big4 });
  check('non-unique literal anchor → ambiguous_region', r.ok === false && r.reason === 'ambiguous_region', JSON.stringify(r));

  console.log('\n--- docx draft ---');
  const { spawnSync } = require('child_process');
  const docxPath = path.join(TMP, 'real.docx');
  let mk = spawnSync('python3', ['-c', `import docx; d=docx.Document(); d.add_paragraph('Hello wrld'); d.add_paragraph('Second para'); d.save('${docxPath}')`]);
  check('docx fixture created', mk.status === 0, (mk.stderr || '').toString().slice(0, 200));
  _llmResponder = (msgs) => msgs[1].content.includes('"ops"')
    ? '{"ops":[{"find":"wrld","replace":"world"}]}'
    : _llmResponse;
  r = await editAgent({ goal: "fix 'wrld' typo", filePath: docxPath });
  check('docx edit ok, draft mode', r.ok === true && r.mode === 'draft' && fs.existsSync(r.draftPath), JSON.stringify(r));
  let ex = spawnSync('python3', [require('path').join(__dirname, '..', 'scripts', 'docx_ops.py'), 'extract', docxPath]);
  check('original docx untouched', ex.stdout.includes('wrld'), ex.stdout.slice(0, 120));
  ex = spawnSync('python3', [require('path').join(__dirname, '..', 'scripts', 'docx_ops.py'), 'extract', r.draftPath]);
  check('draft docx has fix', ex.stdout.includes('world'), ex.stdout.slice(0, 120));
  check('docx diff shows the change', typeof r.diff === 'string' && r.diff.includes('world'), (r.diff || '').slice(0, 200));

  console.log('\n--- xlsx draft ---');
  const xlsxPath = path.join(TMP, 'real.xlsx');
  mk = spawnSync('python3', ['-c', `import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws['A1']=5; ws['A2']=10; wb.save('${xlsxPath}')`]);
  check('xlsx fixture created', mk.status === 0, (mk.stderr || '').toString().slice(0, 200));
  _llmResponder = (msgs) => msgs[1].content.includes('"ops"')
    ? '{"ops":[{"cell":"A3","value":"=A1+A2"},{"cell":"A1","number_format":"$#,##0.00"}]}'
    : _llmResponse;
  r = await editAgent({ goal: 'add a sum in A3 and format A1 as currency', filePath: xlsxPath });
  check('xlsx edit ok, draft mode', r.ok === true && r.mode === 'draft' && fs.existsSync(r.draftPath), JSON.stringify(r));
  ex = spawnSync('python3', ['-c', `import openpyxl; wb=openpyxl.load_workbook('${r.draftPath}'); ws=wb.active; print(ws['A3'].value, ws['A1'].number_format)`]);
  check('draft xlsx has ops applied', ex.stdout.includes('=A1+A2') && ex.stdout.includes('$#,##0.00'), ex.stdout.slice(0, 120));
  ex = spawnSync('python3', ['-c', `import openpyxl; wb=openpyxl.load_workbook('${xlsxPath}'); ws=wb.active; print(ws['A3'].value)`]);
  check('original xlsx untouched', ex.stdout.includes('None'), ex.stdout.slice(0, 120));

  _llmResponder = null;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
