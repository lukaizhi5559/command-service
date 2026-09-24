'use strict';
/**
 * skill: doc.read
 *
 * Extract text from document files — the understanding path for binary
 * office/document formats. fs.read handles plain text/code; this handles
 * everything that needs a format decoder.
 *
 *   docx  → scripts/docx_ops.py extract        (dep: python-docx)
 *   xlsx  → scripts/xlsx_ops.py extract        (dep: openpyxl)
 *   pptx  → scripts/pptx_extract.py            (dep: python-pptx)
 *   pdf   → scripts/pdf_extract.py             (dep: pypdf; fallback: pdftotext)
 *   doc / rtf / odt / wordml / html → textutil -convert txt -stdout
 *
 * Args:
 *   path | filePath   {string}  Required. Absolute path to the document.
 *   maxChars          {number}  Optional. Cap on returned text (default 100KB).
 *
 * Returns:
 *   { ok: true, path, format, text, chars, truncated, stdout }
 *   { ok: false, reason: 'no_file'|'file_missing'|'not_a_file'|'unsupported'|'missing_dep'|'extract_failed', error }
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const logger = require('../logger.cjs');
const { ensurePipSync, which } = require('../skill-helpers/deps.cjs');

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const MAX_CHARS_DEFAULT = 100 * 1024;

const TEXTUTIL_EXTS = new Set(['doc', 'rtf', 'odt', 'wordml', 'html', 'txt', 'text']);

function _expandHome(p) {
  return typeof p === 'string' && p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

function _run(cmd, argv, timeout = 60000) {
  const r = spawnSync(cmd, argv, { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || `${cmd} exited ${r.status}`).slice(0, 500) };
  return { ok: true, stdout: r.stdout || '' };
}

async function docRead(args = {}) {
  let filePath = args.path || args.filePath || args.file || null;
  if (!filePath) return { ok: false, error: 'No path provided', reason: 'no_file' };
  filePath = _expandHome(String(filePath));

  let stat;
  try { stat = fs.statSync(filePath); } catch (_) {
    return { ok: false, error: `File not found: ${filePath}`, reason: 'file_missing' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `Not a regular file: ${filePath}`, reason: 'not_a_file' };
  }

  const ext = (path.extname(filePath).slice(1) || '').toLowerCase();
  const maxChars = Number(args.maxChars) > 0 ? Number(args.maxChars) : MAX_CHARS_DEFAULT;

  let text = null;
  let method = null;

  if (TEXTUTIL_EXTS.has(ext)) {
    method = 'textutil';
    const r = _run('textutil', ['-convert', 'txt', '-stdout', filePath]);
    if (!r.ok) return { ok: false, error: `textutil extract failed: ${r.error}`, reason: 'extract_failed' };
    text = r.stdout;
  } else if (ext === 'docx') {
    method = 'docx_ops';
    const dep = ensurePipSync('python-docx');
    if (!dep.ok) return { ok: false, error: dep.error, reason: 'missing_dep' };
    const r = _run('python3', [path.join(SCRIPTS_DIR, 'docx_ops.py'), 'extract', filePath]);
    if (!r.ok) return { ok: false, error: `docx extract failed: ${r.error}`, reason: 'extract_failed' };
    text = r.stdout;
  } else if (ext === 'xlsx') {
    method = 'xlsx_ops';
    const dep = ensurePipSync('openpyxl');
    if (!dep.ok) return { ok: false, error: dep.error, reason: 'missing_dep' };
    const r = _run('python3', [path.join(SCRIPTS_DIR, 'xlsx_ops.py'), 'extract', filePath]);
    if (!r.ok) return { ok: false, error: `xlsx extract failed: ${r.error}`, reason: 'extract_failed' };
    text = r.stdout;
  } else if (ext === 'pptx') {
    method = 'python-pptx';
    const dep = ensurePipSync('python-pptx');
    if (!dep.ok) return { ok: false, error: dep.error, reason: 'missing_dep' };
    const r = _run('python3', [path.join(SCRIPTS_DIR, 'pptx_extract.py'), filePath]);
    if (!r.ok) return { ok: false, error: `pptx extract failed: ${r.error}`, reason: 'extract_failed' };
    text = r.stdout;
  } else if (ext === 'pdf') {
    method = 'pypdf';
    const dep = ensurePipSync('pypdf');
    if (dep.ok) {
      const r = _run('python3', [path.join(SCRIPTS_DIR, 'pdf_extract.py'), filePath]);
      if (r.ok) {
        text = r.stdout;
      } else {
        logger.warn(`[doc.read] pypdf extract failed (${r.error?.slice(0, 120)}) — trying pdftotext`);
      }
    }
    if (text === null) {
      // Fallback: pdftotext (poppler) if present — no install attempt here,
      // pypdf is the primary rail.
      if (which('pdftotext')) {
        method = 'pdftotext';
        const r = _run('pdftotext', [filePath, '-']);
        if (!r.ok) return { ok: false, error: `pdftotext failed: ${r.error}`, reason: 'extract_failed' };
        text = r.stdout;
      } else if (!dep.ok) {
        return { ok: false, error: dep.error, reason: 'missing_dep' };
      } else {
        return { ok: false, error: 'pdf extract failed (pypdf) and pdftotext not installed', reason: 'extract_failed' };
      }
    }
  } else {
    return {
      ok: false,
      error: `Unsupported document format '.${ext || 'none'}' — fs.read handles plain text; doc.read covers docx/xlsx/pptx/pdf/doc/rtf/odt/wordml/html`,
      reason: 'unsupported',
    };
  }

  const truncated = text.length > maxChars;
  const out = truncated ? text.slice(0, maxChars) : text;
  logger.info(`[doc.read] ${path.basename(filePath)} via ${method}: ${out.length} chars${truncated ? ' (truncated)' : ''}`);
  return {
    ok: true, path: filePath, format: ext, method,
    text: out, chars: out.length, truncated,
    summary: `Extracted ${out.length} chars from ${path.basename(filePath)} via ${method}`,
    stdout: out,
  };
}

module.exports = { docRead };
