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
  check('apply result includes diff', typeof r.diff === 'string' && r.diff.includes('+line two has a mistake'), (r.diff || '').slice(0, 120));

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

  console.log('\n--- targeted ops on large file (quoted fragment) ---');
  const pad = 'padding line\n'.repeat(700); // ~9100 chars
  const big2 = write('region.md', pad + 'the quik brown fox\n' + pad);
  _llmResponder = (msgs) => msgs[1].content.includes('quik')
    ? '[{"find":"quik","replace":"quick"}]'
    : '[]';
  r = await editAgent({ goal: "fix 'quik' typo", filePath: big2 });
  check('targeted edit ok', r.ok === true && r.changed === true, JSON.stringify(r));
  const big2After = fs.readFileSync(big2, 'utf8');
  check('fix applied inside window', big2After.includes('the quick brown fox'));
  check('no quik left', !big2After.includes('quik'));
  check('file outside window intact', big2After.startsWith(pad) && big2After.endsWith(pad));
  check('opsApplied audit present', Array.isArray(r.opsApplied) && r.opsApplied[0].find === 'quik', JSON.stringify(r.opsApplied));

  console.log('\n--- region_not_found ---');
  const big3 = write('region2.md', pad + 'nothing relevant here\n' + pad);
  _llmResponder = null;
  r = await editAgent({ goal: 'change something unquoted entirely differently', filePath: big3 });
  check('no matching fragment → region_not_found', r.ok === false && r.reason === 'region_not_found', JSON.stringify(r));

  console.log('\n--- multi-match target → first + note ---');
  const big4 = write('region3.md', pad + 'dup TARGET word\n' + pad + 'dup TARGET word\n' + pad);
  _llmResponder = (msgs) => msgs[1].content.includes('TARGET')
    ? '[{"find":"dup TARGET word","replace":"dup FIXED word"}]'
    : '[]';
  r = await editAgent({ goal: "fix 'TARGET'", filePath: big4 });
  check('multi-match still edits ok', r.ok === true && r.changed === true, JSON.stringify(r));
  const big4After = fs.readFileSync(big4, 'utf8');
  check('first occurrence edited', big4After.includes('dup FIXED word'));
  check('second occurrence untouched', (big4After.match(/dup TARGET word/g) || []).length === 1);
  check('note flags the ambiguity', typeof r.note === 'string' && r.note.includes('matched'), r.note);

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

  console.log('\n--- rtf converted draft + apply write-back ---');
  // Build a typo'd .rtf via textutil from a plain-text source.
  const rtfSrc = write('rtf-src.txt', 'Meeting notes\n\nThe deadline moved to next Wenesday. Please reveiw the attached documnet.\n');
  const rtfPath = path.join(TMP, 'test.rtf');
  const conv = spawnSync('textutil', ['-convert', 'rtf', rtfSrc, '-output', rtfPath]);
  check('rtf fixture created', conv.status === 0 && fs.existsSync(rtfPath), (conv.stderr || '').toString().slice(0, 200));

  _llmResponder = (msgs) => msgs[1].content.includes('"ops"')
    ? '{"ops":[{"find":"Wenesday","replace":"Wednesday"},{"find":"reveiw","replace":"review"},{"find":"documnet","replace":"document"}]}'
    : _llmResponse;
  r = await editAgent({ goal: 'fix the typos', filePath: rtfPath });
  check('rtf edit ok, draft mode, converted', r.ok === true && r.mode === 'draft' && r.converted === true && fs.existsSync(r.draftPath), JSON.stringify(r));
  check('rtf draft is a .docx', /\.docx$/.test(r.draftPath || ''), r.draftPath);
  const rtfDraft = r.draftPath;
  let back = spawnSync('textutil', ['-convert', 'txt', rtfPath, '-stdout']);
  check('original rtf untouched', back.stdout.includes('Wenesday'), back.stdout.slice(0, 120));

  // apply — .docx draft writes back to .rtf via textutil (was ext_mismatch before)
  r = await editAgent({ mode: 'apply', draftPath: rtfDraft, filePath: rtfPath });
  check('rtf apply ok via docx→rtf write-back', r.ok === true && r.changed === true && r.converted === true, JSON.stringify(r));
  back = spawnSync('textutil', ['-convert', 'txt', rtfPath, '-stdout']);
  check('rtf now contains fixes', back.stdout.includes('Wednesday') && back.stdout.includes('review') && back.stdout.includes('document'), back.stdout.slice(0, 200));
  check('rtf apply made a backup', typeof r.backupPath === 'string' && fs.existsSync(r.backupPath));

  // Non-convertible pair still refuses: .docx draft → .md target
  const mdTarget = write('target.md', ORIGINAL);
  r = await editAgent({ mode: 'apply', draftPath: rtfDraft, filePath: mdTarget });
  check('docx→md still ext_mismatch', r.ok === false && r.reason === 'ext_mismatch', JSON.stringify(r));

  // ── _matchDocPaths — doc-app holder path matching (NSDocument apps report
  // open documents via AppleScript since lsof can't see their closed fds).
  const { _matchDocPaths } = require('../src/skills/edit.agent.cjs');
  const realFile = write('real.md', 'x\n');
  check('match same path', _matchDocPaths([realFile, '/other/file.txt'], realFile));
  check('no match for different file', !_matchDocPaths(['/other/file.txt', '/tmp/x.md'], realFile));
  check('match through /var→/private/var symlink', _matchDocPaths(
    [realFile.replace('/var/', '/private/var/')], realFile));
  check('empty list → no match', !_matchDocPaths([], realFile));

  // ── Ops engine (exported internals) ────────────────────────────────────────
  const EA = require('../src/skills/edit.agent.cjs');

  console.log('\n--- _applyOps ---');
  let ar = EA._applyOps('hello wrld\n', [{ find: 'wrld', replace: 'world' }]);
  check('op applies', ar.text === 'hello world\n' && ar.applied.length === 1, JSON.stringify(ar));
  ar = EA._applyOps('hello\n', [{ find: 'missing text', replace: 'x' }]);
  check('miss → op_no_match', ar.error && ar.reason === 'op_no_match', JSON.stringify(ar));
  ar = EA._applyOps('dup dup dup\n', [{ find: 'dup', replace: 'x' }]);
  check('multi-match default → first + count in audit', ar.text === 'x dup dup\n' && ar.applied[0].occurrences === 3, JSON.stringify(ar));
  ar = EA._applyOps('dup dup dup\n', [{ find: 'dup', replace: 'x', occurrence: 'all' }]);
  check('occurrence:all replaces all', ar.text === 'x x x\n' && ar.applied[0].count === 3, JSON.stringify(ar));
  ar = EA._applyOps('dup dup dup\n', [{ find: 'dup', replace: 'x', occurrence: 2 }]);
  check('occurrence:2 hits second only', ar.text === 'dup x dup\n', JSON.stringify(ar));
  ar = EA._applyOps('abc\n', [{ find: 'x'.repeat(2100), replace: 'y' }]);
  check('oversized find → op_too_large', ar.error && ar.reason === 'op_too_large');
  ar = EA._applyOps('hello world\n', [{ find: 'wrld', replace: 'world' }]);
  check('already-applied → skipped not failed', !ar.error && ar.applied[0].alreadyApplied === true, JSON.stringify(ar));

  console.log('\n--- _normalizedIndexOf ---');
  const curly = 'she said \u201Chello wrld\u201D here';
  let nm = EA._normalizedIndexOf(curly, '"hello wrld"');
  check('curly quotes match straight', nm && curly.slice(nm.index, nm.index + nm.length).includes('hello wrld'), JSON.stringify(nm));
  const spaced = 'line  one\nline   two';
  nm = EA._normalizedIndexOf(spaced, 'line one line two');
  check('whitespace collapse maps to orig coords', nm && spaced.slice(nm.index, nm.index + nm.length) === 'line  one\nline   two', JSON.stringify(nm));
  check('no match → null', EA._normalizedIndexOf('abc', 'zzz') === null);

  console.log('\n--- _lineRangeTarget / _findTarget ---');
  const lineFile = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  let lt = EA._lineRangeTarget('refactor lines 40-50', lineFile);
  check('line range slices with context', lt && lineFile.slice(lt.start, lt.end).includes('line 40') && lineFile.slice(lt.start, lt.end).includes('line 50'), JSON.stringify(lt));
  check('label reports range', lt && /lines \d+.\d+/.test(lt.label), lt && lt.label);
  lt = EA._lineRangeTarget('fix line 9999', lineFile);
  check('out-of-range line → notFound', lt && !!lt.notFound, JSON.stringify(lt));

  const codeFile = 'const r = parseConfig(x)\n\n' + 'function parseConfig(raw) {\n  return raw.trim()\n}\n\nconst q = parseConfig(y)\n';
  let ft = EA._findTarget('refactor `parseConfig`', codeFile);
  check('symbol → definition not call site', ft && codeFile.slice(ft.start, ft.end).includes('function parseConfig'), JSON.stringify(ft));
  const para = 'Para one here.\n\nAlpha. I love that pizza I ate the other night. Omega.\n\nPara three here.\n';
  ft = EA._findTarget("make 'I love that pizza I ate the other night' better", para);
  check('buried quote → containing paragraph window', ft && para.slice(ft.start, ft.end).includes('pizza') && para.slice(ft.start, ft.end).includes('Alpha'), JSON.stringify(ft));
  check('window includes neighbors', ft && para.slice(ft.start, ft.end).includes('Para one') && para.slice(ft.start, ft.end).includes('Para three'));
  check('global scope → whole', EA._findTarget('fix all typos throughout the file', para) === 'whole');

  console.log('\n--- _preserveFormat ---');
  check('CRLF preserved', EA._preserveFormat('a\r\nb\r\nc\r\n', 'a\nb2\nc\n') === 'a\r\nb2\r\nc\r\n');
  check('LF stays LF', EA._preserveFormat('a\nb\nc\n', 'a\nb2\nc\r\n') === 'a\nb2\nc\n');
  check('BOM preserved', EA._preserveFormat('\uFEFFa\nb\n', 'a\nb2\n') === '\uFEFFa\nb2\n');
  check('no BOM stays none', EA._preserveFormat('a\nb\n', '\uFEFFa\nb2\n') === 'a\nb2\n');

  console.log('\n--- _validateSyntax ---');
  const jf = write('v.json', '{}');
  check('valid json ok', EA._validateSyntax(jf, '{"a":1}').ok === true);
  check('invalid json rejected', EA._validateSyntax(jf, '{"a":').ok === false);
  const jsf = write('v.js', 'x');
  check('valid js ok', EA._validateSyntax(jsf, 'const x = 1;\n').ok === true);
  check('invalid js rejected', EA._validateSyntax(jsf, 'const = ;').ok === false);
  const pyf = write('v.py', 'x');
  check('invalid py rejected', EA._validateSyntax(pyf, 'def f(:\n').ok === false);
  check('unvalidated ext passes', EA._validateSyntax(write('v.txt', ''), 'anything').ok === true);

  console.log('\n--- chunk-boundary retry ---');
  // 'NEEDLE' straddles the 6000-char hard split inside one oversized line:
  // chunk1 ends '...NEE', chunk2 starts 'DLE...' — the find misses chunk2
  // alone, then the merged-boundary retry applies it.
  const spanContent = 'pad block\n\n' + 'a'.repeat(5990) + 'NEEDLE' + 'b'.repeat(2000);
  _llmResponder = (msgs) => msgs[1].content.includes('DLE')
    ? '[{"find":"NEEDLE","replace":"FIXED"}]'
    : '[]';
  const spanRes = await EA._chunkedOps('fix the needle', spanContent, null, null);
  check('boundary-spanning op applied via merged retry', !spanRes.error && spanRes.edited.includes('FIXED'), JSON.stringify(spanRes).slice(0, 200));
  check('merged result length sane', spanRes.edited && spanRes.edited.length === spanContent.length - 'NEEDLE'.length + 'FIXED'.length);

  console.log('\n--- global chunked ops ---');
  const chunkA = ('para ' + 'filler '.repeat(60) + 'teh end\n\n').repeat(40);
  const chunkB = ('more ' + 'filler '.repeat(60) + 'recieve end\n\n').repeat(40);
  const gfile = write('global.md', chunkA + chunkB); // ~28K, typo in each half
  _llmResponder = (msgs) => {
    const c = msgs[1].content;
    const ops = [];
    if (c.includes('teh end')) ops.push({ find: 'teh', replace: 'the', occurrence: 'all' });
    if (c.includes('recieve end')) ops.push({ find: 'recieve', replace: 'receive', occurrence: 'all' });
    return JSON.stringify(ops);
  };
  const progress = [];
  r = await editAgent({ goal: 'fix all typos throughout the file', filePath: gfile, _progressCallback: (e) => progress.push(e) });
  check('global ops ok', r.ok === true && r.changed === true, JSON.stringify(r).slice(0, 300));
  const gAfter = fs.readFileSync(gfile, 'utf8');
  check('all typos fixed everywhere', !gAfter.includes('teh') && !gAfter.includes('recieve'), gAfter.length);
  check('opsApplied covers both chunks', Array.isArray(r.opsApplied) && r.opsApplied.length >= 2, JSON.stringify(r.opsApplied).slice(0, 200));
  check('progress events emitted', progress.length > 0 && progress[0].type === 'edit:progress', JSON.stringify(progress[0]));

  console.log('\n--- targeted ops on >200K file ---');
  const hugePad = 'padding '.repeat(100) + '\n\n'; // ~800 chars/block
  const hugeContent = hugePad.repeat(300) + 'the quik fix target\n\n' + hugePad.repeat(10); // ~245K
  const hfile = write('huge-target.md', hugeContent);
  _llmResponder = (msgs) => msgs[1].content.includes('quik fix')
    ? '[{"find":"quik","replace":"quick"}]'
    : '[]';
  r = await editAgent({ goal: "fix 'quik fix'", filePath: hfile });
  check('>200K targeted edit works', r.ok === true && r.changed === true, JSON.stringify(r).slice(0, 200));
  check('huge file edited at target only', fs.readFileSync(hfile, 'utf8').includes('quick fix') && fs.readFileSync(hfile, 'utf8').startsWith(hugePad));

  console.log('\n--- invalid syntax rejected e2e ---');
  const bigJson = JSON.stringify({ items: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `item-${i}`, note: 'placeholder' })) }, null, 2);
  check('json fixture >8K', bigJson.length > 8000, String(bigJson.length));
  const jfile = write('data.json', bigJson);
  _llmResponder = (msgs) => msgs[1].content.includes('item-150')
    ? '[{"find":"\\"name\\": \\"item-150\\"","replace":"\\"name\\": \\"item-150\\" BROKEN"}]' // emits malformed
    : '[]';
  r = await editAgent({ goal: "fix 'item-150'", filePath: jfile });
  check('breaking json → invalid_syntax', r.ok === false && r.reason === 'invalid_syntax', JSON.stringify(r).slice(0, 200));
  check('json file untouched', fs.readFileSync(jfile, 'utf8') === bigJson);

  console.log('\n--- op miss e2e → op_failed family ---');
  const miss = write('miss.md', pad + 'unique anchorphrase here\n' + pad);
  _llmResponder = (msgs) => msgs[1].content.includes('anchorphrase')
    ? '[{"find":"text that is not in the window","replace":"x"}]'
    : '[]';
  r = await editAgent({ goal: "fix 'anchorphrase'", filePath: miss });
  check('unlocatable op → op_no_match', r.ok === false && r.reason === 'op_no_match', JSON.stringify(r));
  check('file untouched on op miss', fs.readFileSync(miss, 'utf8').includes('unique anchorphrase here'));

  console.log('\n--- line-range e2e ---');
  const lfile = write('lines.md', Array.from({ length: 400 }, (_, i) => i === 199 ? 'line 200 has a misstake in it' : `line ${i + 1} is fine and carries padding text`).join('\n') + '\n');
  _llmResponder = (msgs) => msgs[1].content.includes('misstake')
    ? '[{"find":"misstake","replace":"mistake"}]'
    : '[]';
  r = await editAgent({ goal: 'fix the typo on lines 195-205', filePath: lfile });
  check('line-range edit ok', r.ok === true && r.changed === true, JSON.stringify(r).slice(0, 200));
  check('line 200 fixed', fs.readFileSync(lfile, 'utf8').includes('line 200 has a mistake'));

  _llmResponder = null;

  console.log('\n--- fragment mining: capitalized runs + noise strip ---');
  const realGoal = 'Expand the content of the file /Users/lukaizhi/Desktop/proofreading_test_hugh_file.txt to make it longer and provide a better, more detailed explanation of the spelling and typographical errors mentioned in Section 1.';
  const frags = EA._goalFragments(realGoal);
  check('capitalized run "Section 1" mined', frags.includes('Section 1'), frags.slice(0, 10).join(' | '));
  check('no path-bearing fragments', !frags.some(f => f.includes('proofreading_test_hugh_file')), frags.slice(0, 5).join(' | '));

  console.log('\n--- ci tier in _findTarget ---');
  const ciContent = 'intro block\n\n' + 'x'.repeat(5000) + '\n\nSection 9: Common Spelling and Typographical Errors\nThere are mistakes here.\n\n' + 'y'.repeat(5000);
  ft = EA._findTarget('expand the spelling and typographical errors section', ciContent);
  check('lowercase goal finds Title-Case text', ft && ciContent.slice(ft.start, ft.end).includes('Spelling and Typographical'), JSON.stringify(ft));

  console.log('\n--- _outlineBlocks ---');
  const padPara = (w) => (w + ' ').repeat(40).trim(); // ~200+ char paragraphs
  const outlineSrc = padPara('Intro para one') + '\n\nShort.\n\n' + padPara('Body paragraph here with enough text') + '\n\n' + padPara('Final para');
  const ob = EA._outlineBlocks(outlineSrc);
  check('small block merged forward', ob.length === 3 && ob[1].head.startsWith('Short.'), JSON.stringify(ob.map(b => b.head.slice(0, 40))));
  const bigOutline = EA._outlineBlocks(('x'.repeat(300) + '\n\n').repeat(100));
  check('>80 blocks coarsen to fixed windows', bigOutline.length < 20, String(bigOutline.length));

  console.log('\n--- _locateBlock (semantic fallback) ---');
  _llmResponder = (msgs) => msgs[1].content.includes('blocks. Outline') ? '{"block":1}' : '[]';
  const lb = await EA._locateBlock('improve the middle part', outlineSrc, null);
  check('{"block":1} → window covering block 1', lb && lb.start <= outlineSrc.indexOf('Short.') && lb.end >= outlineSrc.indexOf('Body paragraph'), JSON.stringify(lb));
  _llmResponder = () => '{"none":true}';
  check('{"none":true} → null', (await EA._locateBlock('anything', outlineSrc, null)) === null);
  _llmResponder = () => '{"block":99}';
  check('out-of-range → null', (await EA._locateBlock('anything', outlineSrc, null)) === null);

  console.log('\n--- e2e: abstract goal → _locateBlock → ops ---');
  const secBlock = padPara('Section A intro text that is long enough to stand alone as a block') + '\n\n';
  const abFile = write('abstract.md', secBlock + 'SECTION B TARGET body text with a misstake in it that needs fixing. ' + padPara('filler prose around the target') + '\n\n' + 'z'.repeat(9000));
  _llmResponder = (msgs) => {
    const c = msgs[1].content;
    if (c.includes('blocks. Outline')) return '{"block":1}';
    if (c.includes('misstake')) return '[{"find":"misstake","replace":"mistake"}]';
    return '[]';
  };
  r = await editAgent({ goal: 'improve the second block of this document', filePath: abFile });
  check('abstract goal edits via block pick', r.ok === true && r.changed === true, JSON.stringify(r).slice(0, 200));
  check('op applied in picked block', fs.readFileSync(abFile, 'utf8').includes('mistake'));

  console.log('\n--- e2e: no anchor + {"none":true} → region_not_found ---');
  const noneFile = write('none.md', secBlock + 'z'.repeat(9000));
  _llmResponder = () => '{"none":true}';
  r = await editAgent({ goal: 'change the unfindable zzzqqq thing', filePath: noneFile });
  check('no matching block → region_not_found', r.ok === false && r.reason === 'region_not_found', JSON.stringify(r));

  console.log('\n--- e2e regression: real proofreading goal ---');
  const repBlock = 'Section 1: Common Spelling and Typographical Errors\nThere are numerous mistakes hidden throughout this text including beleive and occured. ' + padPara('Padding prose for the section') + '\n\n';
  const repFile = write('repeated.md', repBlock.repeat(15)); // 15 identical sections, >8K
  _llmResponder = (msgs) => msgs[1].content.includes('beleive')
    ? '[{"find":"beleive","replace":"believe"},{"find":"occured","replace":"occurred"}]'
    : '[]';
  r = await editAgent({ goal: realGoal, filePath: repFile });
  check('real goal resolves first Section 1', r.ok === true && r.changed === true, JSON.stringify(r).slice(0, 200));
  const repAfter = fs.readFileSync(repFile, 'utf8');
  check('only first block edited', (repAfter.match(/believe/g) || []).length === 1 && (repAfter.match(/beleive/g) || []).length === 14);
  check('note flags 15 matches', typeof r.note === 'string' && r.note.includes('15'), r.note);

  _llmResponder = null;

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
