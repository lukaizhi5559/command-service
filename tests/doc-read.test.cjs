'use strict';

// Tests for doc.read — document→text extraction.
//   - rtf/txt via textutil
//   - docx via docx_ops extract (python-docx)
//   - pdf via pypdf (raw minimal PDF fixture)
//   - pptx via python-pptx
//   - unsupported ext / missing file / arg aliases

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { docRead } = require('../src/skills/doc.read.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-read-test-'));
const write = (name, content) => { const p = path.join(TMP, name); fs.writeFileSync(p, content); return p; };

// Minimal valid single-page PDF with a text object (pypdf tolerates the fake xref).
const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
  '4 0 obj<</Length 62>>stream',
  'BT /F1 24 Tf 100 700 Td (Hello PDF world) Tj ET',
  'endstream',
  'endobj',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');

async function main() {
  console.log('--- arg + file guards ---');
  let r = await docRead({});
  check('no path → no_file', r.ok === false && r.reason === 'no_file', JSON.stringify(r));
  r = await docRead({ path: '/nonexistent/file.pdf' });
  check('missing file → file_missing', r.ok === false && r.reason === 'file_missing', JSON.stringify(r));
  r = await docRead({ path: TMP });
  check('directory → not_a_file', r.ok === false && r.reason === 'not_a_file', JSON.stringify(r));

  console.log('\n--- textutil formats ---');
  const txt = write('plain.txt', 'hello text world\n');
  r = await docRead({ path: txt });
  check('txt via textutil', r.ok === true && r.text.includes('hello text world') && r.method === 'textutil', JSON.stringify(r));

  const rtfSrc = write('src.txt', 'Meeting notes\n\nDeadline moved to Wenesday.\n');
  const rtfPath = path.join(TMP, 'notes.rtf');
  const conv = spawnSync('textutil', ['-convert', 'rtf', rtfSrc, '-output', rtfPath]);
  check('rtf fixture created', conv.status === 0 && fs.existsSync(rtfPath));
  r = await docRead({ path: rtfPath });
  check('rtf → text via textutil', r.ok === true && r.text.includes('Wenesday'), JSON.stringify(r).slice(0, 200));

  console.log('\n--- docx ---');
  const docxPath = path.join(TMP, 'real.docx');
  const mk = spawnSync('python3', ['-c', `import docx; d=docx.Document(); d.add_paragraph('Quarterly repport draft'); d.save('${docxPath}')`]);
  if (mk.status === 0) {
    r = await docRead({ path: docxPath });
    check('docx extract ok', r.ok === true && r.method === 'docx_ops' && r.text.includes('repport'), JSON.stringify(r).slice(0, 200));
  } else {
    check('docx fixture (python-docx available)', false, (mk.stderr || '').toString().slice(0, 150));
  }

  console.log('\n--- pdf ---');
  const pdfPath = write('sample.pdf', MINIMAL_PDF);
  r = await docRead({ path: pdfPath });
  check('pdf extract ok', r.ok === true && r.text.includes('Hello PDF world'), JSON.stringify(r).slice(0, 200));

  console.log('\n--- pptx ---');
  const pptxPath = path.join(TMP, 'deck.pptx');
  const mkp = spawnSync('python3', ['-c', `from pptx import Presentation; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[5]); s.shapes.title.text='Q3 Reveiw Deck'; p.save('${pptxPath}')`]);
  if (mkp.status === 0) {
    r = await docRead({ path: pptxPath });
    check('pptx extract ok', r.ok === true && r.method === 'python-pptx' && r.text.includes('Reveiw'), JSON.stringify(r).slice(0, 200));
  } else {
    console.log('  (skipping pptx — python-pptx not installed and auto-install may be slow)');
  }

  console.log('\n--- unsupported + truncation ---');
  const bin = write('file.xyz', 'whatever\n');
  r = await docRead({ path: bin });
  check('unknown ext → unsupported', r.ok === false && r.reason === 'unsupported', JSON.stringify(r));
  r = await docRead({ path: txt, maxChars: 5 });
  check('maxChars truncates', r.ok === true && r.truncated === true && r.text.length === 5, JSON.stringify(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
