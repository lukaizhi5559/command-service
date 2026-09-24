// edit.agent.cjs — File-based editing agent for semantic text edits.
// Works like a mini Devin: reads a file, understands the goal, applies edits,
// saves — with safety rails. Phase 2 adds draft/apply modes, tiered
// find/replace ops editing for large files, and structured Office handlers.
//
// Used by:
//   - command.automate dispatch (skill: 'edit.agent') — plan-level file edits
//   - instruction.runner.cjs type-edit (Edit mode) — browser fields
//   - app.agent.cjs — editing files in desktop apps (VS Code, TextEdit)
//   - cli.agent.cjs — editing files via CLI (vim, nano)
//
// API:
//   const { editAgent } = require('./edit.agent.cjs');
//   const result = await editAgent({ goal, filePath, mode?, draftPath?, agentContext? });
//   // ok:    { ok:true, filePath, changed, appliedEdits, backupPath?, draftPath?,
//   //          diff?, mode, autoDraft?, summary, stdout }
//   // fail:  { ok:false, error, reason }
//   // reasons: no_goal | no_file | file_missing | not_a_file | binary_file |
//   //          file_too_large | llm_failed | suspicious_output | mtime_conflict |
//   //          write_failed | region_not_found | ambiguous_region |
//   //          missing_dep | office_ops_failed | no_draft | ext_mismatch
//
// Modes:
//   inplace (default) — backup + atomic write to the original
//   draft             — write ~/.thinkdrop/edits/drafts/<base>-draft-<ts>.<ext>,
//                       return a unified diff; original untouched
//   apply             — copy a prior draft over the original (backup + mtime
//                       guard); same-extension drafts only
// If `lsof` shows the file open in an app, mode is forced to draft
// (autoDraft:true) — open documents are never overwritten underneath their app.
//
// Office formats (.docx/.xlsx, .doc/.rtf via textutil) always produce drafts —
// the LLM emits structured JSON ops, python helpers apply them to a copy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let _logger;
try {
  _logger = require('../skill-helpers/skill-logger.cjs');
} catch {
  _logger = { info: console.log, warn: console.warn, error: console.error };
}
const logger = _logger;

// ── Limits / guards ──────────────────────────────────────────────────────────
// Whole-file rewrites must fit the LLM output budget with margin — 8k chars
// ≈ 2-3k tokens, well under the 8000-token cap.
const SMALL_FILE_MAX = 8000;
// Whole-file/chunked ops passes are capped at ~50k tokens of content.
// Targeted slices (line range / symbol / quoted text) have no cap — the LLM
// only ever sees a bounded window.
const LARGE_FILE_MAX = 200000;
// Reject rewrites that come back drastically shorter — the old 30% floor let
// 50% truncations pass and silently destroyed content.
const MIN_REWRITE_RATIO = 0.6;
const DIFF_CAP = 6000;

const DRAFTS_DIR = path.join(os.homedir(), '.thinkdrop', 'edits', 'drafts');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');
const DOCX_OPS = path.join(SCRIPTS_DIR, 'docx_ops.py');
const XLSX_OPS = path.join(SCRIPTS_DIR, 'xlsx_ops.py');

// Extensions edit.agent handles via structured office handlers (draft-only).
const OFFICE_EXTS = new Set(['docx', 'doc', 'rtf', 'xlsx']);

// Extensions that must never be opened as UTF-8 text and have no structured
// handler — they still route to format readers or app-level automation.
const BINARY_EXTS = new Set([
  // documents / office without a handler
  'pdf', 'xls', 'pptx', 'ppt',
  'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'epub',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'tif', 'bmp', 'ico', 'icns',
  // audio / video
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v',
  // archives / disks / db / fonts
  'zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z', 'dmg', 'iso',
  'db', 'sqlite', 'sqlite3',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

function _expandHome(p) {
  return typeof p === 'string' && p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

function _readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    logger.warn(`[edit.agent] _readFile failed: ${e.message}`);
    return null;
  }
}

// NUL-byte sniff on the first 4KB — catches binary files whose extension is
// missing, misleading, or not on the denylist.
function _looksBinary(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).includes(0x00);
  } catch (_) {
    return false; // unreadable — handled by the read path
  }
}

// Backup before any write — ~/.thinkdrop/edits/backups/<basename>-<ts>.bak
function _backup(filePath) {
  try {
    const dir = path.join(os.homedir(), '.thinkdrop', 'edits', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${path.basename(filePath)}-${Date.now()}.bak`);
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (e) {
    logger.warn(`[edit.agent] backup failed (continuing without backup): ${e.message}`);
    return null;
  }
}

// Atomic write: temp file in the same directory → rename (same filesystem).
function _writeFileAtomic(filePath, content) {
  const tmp = `${filePath}.thinkdrop-tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch (e) {
    logger.warn(`[edit.agent] atomic write failed: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

// Draft destination — ~/.thinkdrop/edits/drafts/<base>-draft-<ts>.<ext>
function _draftPathFor(filePath, extOverride) {
  fs.mkdirSync(DRAFTS_DIR, { recursive: true });
  const base = path.basename(filePath, path.extname(filePath));
  const ext = extOverride || path.extname(filePath).slice(1) || 'txt';
  return path.join(DRAFTS_DIR, `${base}-draft-${Date.now()}.${ext}`);
}

// Deterministic "is this file open in an app" check — a held file handle means
// the app may auto-save over an in-place write, so drafts are mandatory.
// `lsof -F c` returns full command names (the default column truncates ~9
// chars); lines look like `cTextEdit` / `p1234` — we keep the c-prefixed ones.
// Document-based apps that hold files via NSDocument-style in-memory buffers —
// they close the fd after reading, so `lsof` never sees them. Detection requires
// asking the app for its open documents via AppleScript. (VS Code is excluded
// deliberately: it watches files and reloads external changes safely.)
const _DOC_APP_NAMES = [
  'TextEdit', 'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint',
  'Pages', 'Numbers', 'Keynote', 'BBEdit', 'CotEditor', 'TextMate',
  'SubEthaEdit', 'Preview',
];

// Normalize a path for comparison (resolves symlinks like /var → /private/var).
function _normPath(p) {
  try { return fs.realpathSync(String(p).trim()); } catch (_) { return String(p).trim(); }
}

// Pure matcher — which doc-app path strings refer to targetPath?
function _matchDocPaths(docPaths, targetPath) {
  const t = _normPath(targetPath);
  return docPaths.some(p => _normPath(p) === t);
}

// Ask each running document app for its open documents and match the target.
// Two query forms: `path of every document` (TextEdit/BBEdit) and
// `POSIX path of (file of every document)` (Word/Pages-style file objects).
// Fails soft per app — osascript errors (non-scriptable, denied automation
// consent) just skip it.
function _docAppHolders(filePath) {
  const holders = [];
  try {
    const procs = spawnSync('osascript', ['-e',
      'tell application "System Events" to get name of every process whose background only is false'],
      { timeout: 10000, encoding: 'utf8' });
    if (procs.status !== 0 || !procs.stdout) return holders;
    const running = new Set(procs.stdout.split(',').map(s => s.trim()).filter(Boolean));
    const candidates = _DOC_APP_NAMES.filter(a => running.has(a));
    for (const app of candidates) {
      const script = [
        `tell application "${app}"`,
        '  set out to ""',
        '  try',
        '    set ps to path of every document',
        '    repeat with p in ps',
        '      set out to out & p & linefeed',
        '    end repeat',
        '  on error',
        '    try',
        '      set fs to file of every document',
        '      repeat with f in fs',
        '        set out to out & (POSIX path of f) & linefeed',
        '      end repeat',
        '    end try',
        '  end try',
        '  return out',
        'end tell',
      ].join('\n');
      const r = spawnSync('osascript', ['-e', script], { timeout: 15000, encoding: 'utf8' });
      if (r.status !== 0 || !r.stdout) continue;
      const docPaths = r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
      if (_matchDocPaths(docPaths, filePath)) holders.push(app);
    }
  } catch (_) {}
  return holders;
}

function _openFileHolders(filePath) {
  const holders = new Set();
  try {
    const r = spawnSync('lsof', ['-F', 'c', '--', filePath], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      for (const l of String(r.stdout).split('\n')) {
        if (l.length > 1 && l[0] === 'c') {
          const name = l.slice(1).trim();
          if (name) holders.add(name);
        }
      }
    }
  } catch (_) {}
  for (const app of _docAppHolders(filePath)) holders.add(app);
  return [...holders];
}

function _isFileOpen(filePath) {
  return _openFileHolders(filePath).length > 0;
}

// Graceful document-scoped close in the holding app. `saving ask` lets the app
// surface its own save dialog when unsaved changes exist — never silently
// discards user work. Returns true if osascript ran (not that a doc closed).
function _closeDocumentInApp(appName, filePath) {
  const safeApp = String(appName).replace(/["\\]/g, '');
  const safePath = String(filePath).replace(/["\\]/g, '');
  const base = path.basename(safePath);
  const script = [
    `tell application "${safeApp}"`,
    `  try`,
    `    close (every document whose file is POSIX file "${safePath}") saving ask`,
    `  end try`,
    `  try`,
    `    close (every document whose name is "${base}") saving ask`,
    `  end try`,
    `end tell`,
  ].join('\n');
  const r = spawnSync('osascript', ['-e', script], { timeout: 15000, encoding: 'utf8' });
  return r.status === 0;
}

// Unified diff between two text snapshots (temp files + `diff -u`).
function _unifiedDiff(oldText, newText, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-diff-'));
  try {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    fs.writeFileSync(a, oldText, 'utf8');
    fs.writeFileSync(b, newText, 'utf8');
    const r = spawnSync('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, a, b], { timeout: 10000, encoding: 'utf8' });
    return (r.stdout || '').slice(0, DIFF_CAP);
  } catch (_) {
    return '';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Python dependency probe + auto-install ───────────────────────────────────
// Same convention as video.agent's yt-dlp install: probe once per process,
// `pip3 install --user` if missing, degrade to missing_dep on failure
// (offline / PEP-668 externally-managed / no pip).
const _depCache = {};
function _ensurePyDep(moduleName, pipName) {
  if (_depCache[moduleName]) return _depCache[moduleName];
  // Shared dep registry — 'python-docx' manifest name covers the 'docx' module.
  const { ensurePipSync } = require('../skill-helpers/deps.cjs');
  const depName = pipName || moduleName;
  const r = ensurePipSync(depName === 'docx' ? 'python-docx' : depName);
  return (_depCache[moduleName] = r);
}

// ── Small file editing (≤ SMALL_FILE_MAX) ────────────────────────────────────
// LLM returns the full edited content.
async function _llmRewrite(goal, content, agentContext, what = 'content') {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}` : '';

  const systemPrompt = `You are a precise text editor. You edit the given ${what} according to the goal.
Return ONLY the edited ${what} — no explanations, no markdown code fences.
- Apply the requested changes precisely
- Preserve the overall structure and formatting
- Do not add or remove content beyond what the goal asks for
- If the goal asks to add a section, add it in the appropriate place
- If the goal asks to fix something, fix only that
- Return the full edited ${what} (not just the changes)`;

  const userPrompt = `Goal: ${goal}
${_contextBlock}

Content to edit:
---
${content}
---

Edited content:`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 8000, temperature: 0.2, responseTimeoutMs: 60000, taskType: 'complex' });
    const edited = (raw || '').trim().replace(/^```(?:text|plaintext|markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (!edited || edited.length < content.length * MIN_REWRITE_RATIO) {
      logger.warn(`[edit.agent] _llmRewrite: output suspiciously short (${edited.length} vs ${content.length}) — rejecting`);
      return { rejected: true };
    }
    return { edited };
  } catch (e) {
    logger.warn(`[edit.agent] _llmRewrite failed: ${e.message}`);
    return null;
  }
}

// ── Ops-based editing (SMALL_FILE_MAX < size; targeted slices at any size) ───
// The LLM emits self-locating {find, replace, occurrence?} ops — find is
// verbatim text copied from the slice it was shown. Application is
// deterministic indexOf/replace: no "locate the region" LLM call, no
// window-rewrite drift, and unchanged text passes through byte-identical.

const OP_FIND_MAX = 2000;        // a giant find is just rewrite-with-extra-steps
const CHUNK_MAX = 6000;          // global-pass chunk size (paragraph-aligned)
const WINDOW_MAX = 8000;         // targeted window cap
const LINE_PAD = 20;             // context lines around an explicit line range

// Whitespace/curly-quote/dash-tolerant indexOf. Returns {index, length} in
// ORIGINAL coordinates (length = matched span in `text`, may differ from
// needle length after normalization) or null. opts.ci adds a case-fold tier —
// locate-only (_findTarget); _applyOps stays strict so ops can't replace text
// with different casing than the model saw.
function _normalizedIndexOf(text, needle, opts = {}) {
  let idx = text.indexOf(needle);
  if (idx >= 0) return { index: idx, length: needle.length };

  const ci = !!opts.ci;
  const fold = (ch) => ci ? ch.toLowerCase() : ch;
  const norm = (s) => {
    let out = s
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ');
    return ci ? out.toLowerCase() : out;
  };
  const nNeedle = norm(needle);

  // Build normalized text + position map back to original offsets.
  const posMap = new Int32Array(text.length + 1);
  const normChars = [];
  let i = 0, oi = 0;
  const L = text.length;
  while (oi < L) {
    let ch = text[oi];
    if (ch === '\u2018' || ch === '\u2019') ch = "'";
    else if (ch === '\u201C' || ch === '\u201D') ch = '"';
    else if (ch === '\u2013' || ch === '\u2014') ch = '-';
    ch = fold(ch);
    if (/\s/.test(ch)) {
      // collapse whitespace run
      while (oi < L && /\s/.test(text[oi])) oi++;
      if (normChars.length && normChars[normChars.length - 1] !== ' ') {
        normChars.push(' ');
        posMap[i++] = oi - 1;
      }
      continue;
    }
    normChars.push(ch);
    posMap[i++] = oi;
    oi++;
  }
  const nText = normChars.join('');
  const nIdx = nText.indexOf(nNeedle);
  if (nIdx < 0) return null;
  const start = posMap[nIdx];
  const endOrig = posMap[Math.min(nIdx + nNeedle.length - 1, i - 1)] + 1;
  return { index: start, length: endOrig - start };
}

// Deterministic op application against one slice of text.
// Returns { text, applied:[{find,replace,position}] } or { error, reason, op }.
function _applyOps(text, ops) {
  const applied = [];
  for (const [oi, op] of (ops || []).entries()) {
    const find = String(op?.find ?? '');
    const replace = String(op?.replace ?? '');
    if (!find) return { error: `op ${oi}: empty find`, reason: 'op_bad_shape', op };
    if (find.length > OP_FIND_MAX) {
      return { error: `op ${oi}: find is ${find.length} chars (cap ${OP_FIND_MAX}) — split into smaller edits`, reason: 'op_too_large', op };
    }
    const occNum = typeof op.occurrence === 'number' ? op.occurrence : parseInt(op.occurrence, 10);
    const occurrence = op.occurrence === 'all' ? 'all' : (Number.isInteger(occNum) && occNum > 0 ? occNum : 'first');

    if (occurrence === 'all') {
      const hits = [];
      let from = 0, hit;
      while ((hit = _normalizedIndexOf(text.slice(from), find))) {
        hits.push(from + hit.index);
        from += hit.index + Math.max(hit.length, 1);
      }
      if (!hits.length) {
        // Idempotent re-run: find is gone but its replacement is already
        // present — treat as already applied rather than an error.
        if (replace && _normalizedIndexOf(text, replace)) {
          applied.push({ find: find.slice(0, 80), replace: replace.slice(0, 80), alreadyApplied: true });
          continue;
        }
        return { error: `op ${oi}: could not find "${find.slice(0, 80)}"`, reason: 'op_no_match', op };
      }
      // Apply right-to-left so earlier positions stay valid.
      for (let h = hits.length - 1; h >= 0; h--) {
        const m = _normalizedIndexOf(text.slice(hits[h]), find);
        if (m) text = text.slice(0, hits[h]) + replace + text.slice(hits[h] + m.length);
      }
      applied.push({ find: find.slice(0, 80), replace: replace.slice(0, 80), position: hits[0], count: hits.length });
      continue;
    }

    const first = _normalizedIndexOf(text, find);
    if (!first) {
      if (replace && _normalizedIndexOf(text, replace)) {
        applied.push({ find: find.slice(0, 80), replace: replace.slice(0, 80), alreadyApplied: true });
        continue;
      }
      return { error: `op ${oi}: could not find "${find.slice(0, 80)}"`, reason: 'op_no_match', op };
    }
    // Multi-match within the window is NOT an error — the window is already the
    // declared scope (a paragraph, block, or chunk). 'first' deterministically
    // edits the first in-window occurrence; the count is recorded in the audit
    // so the draft review can see boilerplate repeats. occurrence:N selects a
    // specific one; out-of-range is an error.
    let extraCount = 0;
    {
      let from = first.index + first.length, nx;
      while ((nx = _normalizedIndexOf(text.slice(from), find))) {
        extraCount++;
        from += nx.index + Math.max(nx.length, 1);
        if (extraCount > 50) break;
      }
    }
    let target = first;
    if (typeof occurrence === 'number' && occurrence > 1) {
      let from = first.index + first.length;
      for (let n = 2; n <= occurrence; n++) {
        const nx = _normalizedIndexOf(text.slice(from), find);
        if (!nx) return { error: `op ${oi}: occurrence ${occurrence} of "${find.slice(0, 60)}" not found`, reason: 'op_no_match', op };
        target = { index: from + nx.index, length: nx.length };
        from = target.index + target.length;
      }
    }
    text = text.slice(0, target.index) + replace + text.slice(target.index + target.length);
    applied.push({ find: find.slice(0, 80), replace: replace.slice(0, 80), position: target.index, occurrences: extraCount + 1 });
  }
  return { text, applied };
}

// Ask the LLM for ops against ONE slice of text. `contextLabel` tells the
// model what it's looking at ("part 3 of 9", "lines 4520-4610", "the block
// containing your target").
async function _emitOps(goal, text, contextLabel, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const { parseLlmJson } = require('../skill-helpers/parseLlmJson.cjs');

  const systemPrompt = `You are a precise text editor that emits SEARCH/REPLACE operations.
For the given text, return a JSON array of edit ops that accomplish the goal.
Each op: {"find": "<verbatim text copied EXACTLY from the text>", "replace": "<new text>", "occurrence": "first"|"all"}
Rules:
- "find" MUST be copied character-for-character from the text below — it is matched literally
- Keep "find" as short as possible while staying unique within this text (a line or two, not paragraphs)
- Use occurrence:"all" to change every match; otherwise each find must be unique
- To rewrite a whole paragraph/section, find can span it — but prefer several small ops when only parts change
- If nothing in THIS text needs changing for the goal, return []
- Return ONLY the JSON array — no explanation, no markdown fences`;

  const userPrompt = `Goal: ${goal}
${agentContext ? `\nAgent context:\n${String(agentContext).slice(0, 400)}\n` : ''}
This is ${contextLabel}:
---
${text}
---

Edit ops (JSON array):`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 4000, temperature: 0.2, responseTimeoutMs: 60000, taskType: 'complex' });
    const parsed = parseLlmJson(raw, logger, 'edit.agent/ops');
    if (parsed === null) return null;
    const ops = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.ops) ? parsed.ops : null);
    if (!ops) return null;
    return ops;
  } catch (e) {
    logger.warn(`[edit.agent] _emitOps failed: ${e.message}`);
    return null;
  }
}

// Split content into paragraph-aligned chunks ≤ maxChars. Oversized
// paragraphs split on single newlines; oversized lines split hard.
function _chunkContent(content, maxChars = CHUNK_MAX) {
  const chunks = [];
  let cur = '';
  for (const para of content.split(/(\n\n+)/)) {
    if (cur.length + para.length <= maxChars) { cur += para; continue; }
    if (cur) { chunks.push(cur); cur = ''; }
    if (para.length <= maxChars) { cur = para; continue; }
    // Oversized paragraph — split on lines.
    for (const line of para.split(/(\n)/)) {
      if (cur.length + line.length <= maxChars) { cur += line; continue; }
      if (cur) { chunks.push(cur); cur = ''; }
      let rest = line;
      while (rest.length > maxChars) {
        chunks.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      cur = rest;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ── Deterministic target location (no LLM) ─────────────────────────────────

// "lines 4543-4590", "line 500", "lines 12 through 30" → line-indexed slice.
function _lineRangeTarget(goal, content) {
  const m = String(goal).match(/\blines?\s+(\d+)\s*(?:[-–—]|\s+to\s+|\s+through\s+)\s*(\d+)\b/i)
        || String(goal).match(/\bline\s+(\d+)\b/i);
  if (!m) return null;
  const a = Math.max(1, parseInt(m[1], 10));
  const b = m[2] ? Math.max(a, parseInt(m[2], 10)) : a;
  const lines = content.split('\n');
  if (a > lines.length) return { notFound: `line ${a} beyond end of file (${lines.length} lines)` };
  const from = Math.max(0, a - 1 - LINE_PAD);
  const to = Math.min(lines.length, b + LINE_PAD);
  let start = 0;
  for (let i = 0; i < from; i++) start += lines[i].length + 1;
  let end = start;
  for (let i = from; i < to; i++) end += lines[i].length + 1;
  return { start, end: Math.min(end, content.length), label: `lines ${from + 1}–${to}` };
}

// Expand a hit outward to its blank-line-delimited block (paragraph /
// function body), then add margin. Falls back to ±radius when no blank lines.
function _blockWindow(content, hitIndex, hitLen = 0) {
  const pad = 1500;
  let bs = hitIndex, be = hitIndex + hitLen;
  // block start: previous blank line before hit
  const prevBlank = content.lastIndexOf('\n\n', Math.max(0, hitIndex));
  if (prevBlank >= 0) bs = prevBlank + 2;
  // block end: next blank line after the hit end
  const nextBlank = content.indexOf('\n\n', be);
  if (nextBlank >= 0) be = nextBlank;
  // margin: one extra block / ~pad chars each side, line-aligned.
  // Search from BEFORE the boundary blank line — searching from bs-1/be+1
  // re-finds the same blank line and the margin never expands.
  const mStart = content.lastIndexOf('\n\n', Math.max(0, bs - 3));
  const mEnd = content.indexOf('\n\n', be + 2);
  let start = mStart >= 0 ? mStart + 2 : Math.max(0, bs - pad);
  let end = mEnd >= 0 ? mEnd : Math.min(content.length, be + pad);
  if (end - start > WINDOW_MAX) {
    // Oversized block — center on hit, line-aligned.
    start = Math.max(bs, hitIndex - Math.floor(WINDOW_MAX / 2));
    end = Math.min(content.length, start + WINDOW_MAX);
    const nl = content.indexOf('\n', start);
    if (nl >= 0 && nl < end) start = nl + 1;
    const nl2 = content.lastIndexOf('\n', end);
    if (nl2 > start) end = nl2;
  }
  return { start, end };
}

// Score an identifier hit: definition-context beats call-site.
function _defScore(content, hitIndex, ident) {
  const lineStart = content.lastIndexOf('\n', hitIndex - 1) + 1;
  const before = content.slice(lineStart, hitIndex);
  const after = content.slice(hitIndex + ident.length, hitIndex + ident.length + 30);
  if (new RegExp(`(?:function|def|func|fn|sub)\\s*$`, 'i').test(before)) return 3;
  if (new RegExp(`(?:const|let|var|public|private|static|async|export|function\\*|local)\\s+$`, 'i').test(before)) return 3;
  if (new RegExp(`^(?:\\s*[:=]|\\s*=>)`).test(after) || /^[ \t]*\(/.test(after) && /[{=]>?\s*$/.test(before)) return 2;
  if (/^\s*$/.test(before) && /^[ \t]*\(/.test(after)) return 2; // `name(` at line start — likely a def
  return 0;
}

// Candidate target strings mined from the goal — longest/most-specific first.
function _goalFragments(goal) {
  let g = String(goal);
  const frags = new Set();
  // backticked + quoted spans (mine BEFORE stripping — quotes are explicit)
  for (const m of g.matchAll(/`([^`\n]{3,200})`/g)) frags.add(m[1].trim());
  for (const m of g.matchAll(/'([^'\n]{3,200})'|"([^"\n]{3,200})"/g)) frags.add((m[1] || m[2]).trim());
  // Strip noise that would otherwise dominate the n-gram/frags: absolute file
  // paths, [File:]/[Folder:] tags, URLs. They can never match file CONTENT.
  g = g
    .replace(/\[\s*(?:File|Folder)\s*:\s*[^\]]+\]/gi, ' ')
    .replace(/(?:~|\/[\w.@+-][\w.@+/-]*)+\.\w{1,10}\b/g, ' ')
    .replace(/\b[\w-]{2,}\.(?:txt|md|markdown|js|mjs|cjs|ts|tsx|py|json|ya?ml|html?|css|csv|xml|docx?|xlsx?|pdf|rtf|log|sh|swift|java|cpp?|h|rb|go|rs)\b/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  // Capitalized runs — "Section 1", "Common Spelling and Typographical
  // Errors". Require ≥2 words or a digit so sentence-initial words
  // ("Expand", "Ensure") don't pollute the frag set.
  for (const m of g.matchAll(/\b[A-Z][\w$]*(?:\s+[A-Z0-9][\w$]*)+\b/g)) {
    const t = m[0].trim();
    if (t.length >= 3 && t.length <= 120) frags.add(t);
  }
  // sentence/clause fragments
  for (const f of g.split(/[.;:\n—]|(?:\s+-\s+)/)) {
    const t = f.trim();
    if (t.length >= 12 && t.length <= 200) frags.add(t);
  }
  // identifiers (camelCase / snake_case / ClassName)
  for (const m of g.matchAll(/\b([a-zA-Z_$][\w$]{2,}(?:\(\))?)\b/g)) {
    const id = m[1].replace(/\(\)$/, '');
    if (/[A-Z_]/.test(id.slice(1)) || id.includes('_')) frags.add(id);
  }
  // word n-grams (3-8) for title/heading phrases
  const words = g.split(/\s+/).filter(Boolean);
  for (let n = Math.min(8, words.length); n >= 3; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      frags.add(words.slice(i, i + n).join(' '));
    }
  }
  return [...frags].filter(f => f.length >= 3).sort((x, y) => y.length - x.length);
}

const _GLOBAL_SCOPE_RE = /\b(entire|whole)\s+(file|document|content|text)\b|\ball\b[^.]{0,40}\b(in|throughout|across)\b[^.]{0,40}\b(file|document|text)\b|\bevery\s+(line|section|paragraph|instance|occurrence|word|sentence)\b|\beverything\s+in\s+(this|the)\s+(file|document)\b/i;

function _isGlobalScope(goal) {
  return _GLOBAL_SCOPE_RE.test(String(goal));
}

// Locate where a targeted goal should edit. Returns {start,end,label,note?}
// or 'whole' or {notFound} or null.
function _findTarget(goal, content) {
  const lr = _lineRangeTarget(goal, content);
  if (lr) return lr.notFound ? { notFound: lr.notFound } : lr;
  if (_isGlobalScope(goal)) return 'whole';

  const frags = _goalFragments(goal);
  // Pass 1: exact/normalized matching. Pass 2 (only if nothing hit): case-
  // folded — "spelling and typographical errors" in the goal should still
  // locate "Spelling and Typographical Errors" in the file.
  for (const ci of [false, true]) {
    let best = null;
    for (const frag of frags) {
      // Collect all hits (normalized fallback included).
      const hits = [];
      let from = 0, hit;
      while ((hit = _normalizedIndexOf(content.slice(from), frag, { ci }))) {
        hits.push({ index: from + hit.index, length: hit.length });
        from += hit.index + Math.max(hit.length, 1);
        if (hits.length > 20) break;
      }
      if (!hits.length) continue;
      // Prefer definition-context hits for identifiers; exact hits beat ci hits.
      const scored = hits.map(h => ({ ...h, score: _defScore(content, h.index, frag) }));
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      const win = scored[0];
      const topScore = win.score;
      const sameScore = scored.filter(h => h.score === topScore);
      const note = sameScore.length > 1
        ? `"${frag.slice(0, 50)}" matched ${sameScore.length} locations — editing first occurrence`
        : (hits.length > 1 ? `"${frag.slice(0, 50)}" matched ${hits.length} locations — editing first occurrence` : undefined);
      const cand = { hit: win, frag, note, fragLen: frag.length };
      if (!best || cand.fragLen > best.fragLen) best = cand;
    }
    if (best) {
      const w = _blockWindow(content, best.hit.index, best.hit.length);
      return { ...w, label: `block at char ${best.hit.index}`, note: best.note };
    }
  }
  return null;
}

// ── Semantic block locator (fallback when _findTarget has no anchor) ─────────
// The model picks a block NUMBER from a numbered outline — integer-only JSON,
// so the verbatim-quote control-char crash that killed _locateAnchor can't
// recur. The picked block becomes the ops window.

// Split content into outline blocks: blank-line-delimited, small blocks
// (<150 chars — lone headings) merged into the FOLLOWING block. >80 blocks →
// fixed ~4K windows labeled by char range instead.
function _outlineBlocks(content, maxBlocks = 80) {
  const raw = [];
  let pos = 0;
  for (const part of content.split(/(\n\n+)/)) {
    if (/^\n\n+$/.test(part)) { pos += part.length; continue; }
    raw.push({ start: pos, end: pos + part.length });
    pos += part.length;
  }
  // Merge small blocks forward — a lone heading belongs with its body.
  const merged = [];
  let pendingStart = null;
  for (const b of raw) {
    if (b.end - b.start < 150) {
      if (pendingStart === null) pendingStart = b.start;
      continue;
    }
    merged.push({ start: pendingStart ?? b.start, end: b.end });
    pendingStart = null;
  }
  if (pendingStart !== null) merged.push({ start: pendingStart, end: content.length });
  let blocks = merged;
  if (blocks.length > maxBlocks) {
    // Coarsen: fixed ~4K windows labeled by char range.
    blocks = [];
    const W = 4000;
    for (let s = 0; s < content.length; s += W) {
      blocks.push({ start: s, end: Math.min(content.length, s + W) });
    }
  }
  return blocks.map((b, i) => ({
    i, start: b.start, end: b.end,
    head: content.slice(b.start, Math.min(b.end, b.start + 90)).replace(/\s+/g, ' ').trim(),
  }));
}

async function _locateBlock(goal, content, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  const { parseLlmJson } = require('../skill-helpers/parseLlmJson.cjs');
  const blocks = _outlineBlocks(content);
  const listing = blocks.map(b => `[${b.i}] ${b.head}`).join('\n');

  const userPrompt = `Goal: ${goal}
${agentContext ? `\nAgent context:\n${String(agentContext).slice(0, 400)}\n` : ''}
The file has ${blocks.length} blocks. Outline (index + first words of each):
${listing}

Which block does the goal want edited? Reply with ONLY JSON:
{"block": N}  — single block index
{"blocks": [a, b]}  — a span of consecutive blocks
{"none": true}  — if no block matches the goal`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You pick which numbered block of a file matches the user\'s goal. Output only JSON with a block index — never quote file text.' },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 150, temperature: 0, responseTimeoutMs: 30000, taskType: 'fast' });
    const parsed = parseLlmJson(raw, logger, 'edit.agent/locateBlock');
    if (!parsed || parsed.none === true) return null;
    let a = null, b = null;
    if (Number.isInteger(parsed.block)) { a = b = parsed.block; }
    else if (Array.isArray(parsed.blocks) && parsed.blocks.length) {
      const valid = parsed.blocks.filter(Number.isInteger).sort((x, y) => x - y);
      if (valid.length) { a = valid[0]; b = valid[valid.length - 1]; }
    }
    if (a === null || a < 0 || a >= blocks.length) return null;
    b = Math.min(b ?? a, blocks.length - 1);

    const picked = blocks[a];
    // Margin: one neighbor block each side.
    const start = a > 0 ? blocks[a - 1].start : picked.start;
    const end = b < blocks.length - 1 ? blocks[b + 1].end : blocks[b].end;
    let w = { start, end };
    if (w.end - w.start > WINDOW_MAX) {
      w = { start: picked.start, end: Math.min(content.length, picked.start + WINDOW_MAX) };
    }
    // Duplicate-head note — repeated boilerplate sections ("Section 1" ×15).
    const dupes = blocks.filter(x => x.head === picked.head).length;
    const note = dupes > 1 ? `"${picked.head.slice(0, 50)}" matches ${dupes} blocks — used #${a}` : undefined;
    return { ...w, label: `block ${a}${b !== a ? `-${b}` : ''}`, note };
  } catch (e) {
    logger.warn(`[edit.agent] _locateBlock failed: ${e.message}`);
    return null;
  }
}

// Global-scope edit: emit + apply ops per paragraph-aligned chunk. An op that
// misses its chunk gets one retry against the merged boundary region before
// failing the whole pass — all-or-nothing, no partial writes.
async function _chunkedOps(goal, content, agentContext, progressCallback) {
  const chunks = _chunkContent(content);
  const applied = [];
  const editedChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    if (progressCallback) progressCallback({ type: 'edit:progress', message: `Editing part ${i + 1} of ${chunks.length}`, chunk: i + 1, total: chunks.length });
    const ops = await _emitOps(goal, chunks[i], `part ${i + 1} of ${chunks.length}`, agentContext);
    if (ops === null) return { error: 'LLM op emission failed', reason: 'llm_failed' };
    if (!ops.length) { editedChunks.push(chunks[i]); continue; }
    let res = _applyOps(chunks[i], ops);
    if (res.error && res.reason === 'op_no_match' && i > 0) {
      // Boundary retry: the find may span the chunk split — retry against
      // prev-tail + this-chunk merged region.
      const merged = editedChunks.pop() + chunks[i];
      const mergedRes = _applyOps(merged, ops);
      if (mergedRes.error) return { error: res.error, reason: res.reason };
      // Split back at the original boundary (prev chunk may have been edited —
      // its edited length is merged.length - this chunk's length).
      const boundary = merged.length - chunks[i].length;
      editedChunks.push(merged.slice(0, boundary));
      editedChunks.push(merged.slice(boundary));
      applied.push(...mergedRes.applied);
      continue;
    }
    if (res.error) return { error: res.error, reason: res.reason };
    editedChunks.push(res.text);
    applied.push(...res.applied);
  }
  return { edited: editedChunks.join(''), applied };
}

// ── Office handlers ──────────────────────────────────────────────────────────
// The LLM emits structured JSON ops; committed python scripts apply them to a
// copy. The model never writes the file — ops are validated and capped.

function _py(script, argv, input) {
  const r = spawnSync('python3', [script, ...argv], {
    input, timeout: 60000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: (r.stderr || 'python failed').slice(0, 500) };
  return { ok: true, stdout: r.stdout || '' };
}

function _textutilToDocx(filePath) {
  const out = _draftPathFor(filePath, 'docx');
  const r = spawnSync('textutil', ['-convert', 'docx', filePath, '-output', out], { timeout: 30000 });
  if (r.status !== 0 || !fs.existsSync(out)) {
    logger.warn(`[edit.agent] textutil docx conversion failed: ${(r.stderr || '').toString().slice(0, 200)}`);
    return null;
  }
  return out;
}

// LLM → validated ops array. kind selects the op schema shown to the model.
async function _officeOps(goal, extracted, kind, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const schema = kind === 'xlsx'
    ? `{"ops":[{"sheet":"<sheet name, optional>","cell":"A1","value":"<new value>"} | {"cell":"B2","number_format":"$#,##0.00"} | {"cell":"C3","bold":true} | {"cell":"C4","italic":true}]}`
    : `{"ops":[{"find":"<verbatim text to find>","replace":"<replacement>","all":false} | {"append":"<new paragraph text>"}]}`;

  const userPrompt = `Goal: ${goal}
${agentContext ? `\nAgent context:\n${String(agentContext).slice(0, 400)}\n` : ''}
Extracted ${kind} content:
---
${extracted.slice(0, 12000)}
---

Reply with ONLY a JSON object of edit operations matching this schema:
${schema}
- "find" strings must be copied verbatim from the extracted content
- Prefer few, precise ops; no more than 40 ops
- If the goal cannot be expressed as ops, reply {"ops":[]}`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You translate edit goals into structured JSON operations. Output only JSON.' },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 2000, temperature: 0.1, responseTimeoutMs: 60000, taskType: 'complex' });
    const m = (raw || '').match(/\{[\s\S]*"ops"[\s\S]*\}/);
    if (!m) return { failed: true };
    const ops = JSON.parse(m[0]).ops;
    if (!Array.isArray(ops)) return { failed: true };
    return { ops: ops.slice(0, 40) };
  } catch (e) {
    logger.warn(`[edit.agent] _officeOps failed: ${e.message}`);
    return { failed: true };
  }
}

async function _editOffice(goal, filePath, ext, agentContext) {
  const isSheet = ext === 'xlsx';
  const dep = _ensurePyDep(isSheet ? 'openpyxl' : 'docx', isSheet ? 'openpyxl' : 'python-docx');
  if (!dep.ok) return { ok: false, error: dep.error, reason: 'missing_dep' };

  // Legacy formats convert to docx first — the draft is the converted docx.
  let workPath = filePath;
  let converted = false;
  if (ext === 'doc' || ext === 'rtf') {
    workPath = _textutilToDocx(filePath);
    if (!workPath) return { ok: false, error: `textutil could not convert ${ext} to docx`, reason: 'office_ops_failed' };
    converted = true;
  }

  const script = isSheet ? XLSX_OPS : DOCX_OPS;
  const kind = isSheet ? 'xlsx' : 'docx';

  const before = _py(script, ['extract', workPath]);
  if (!before.ok) return { ok: false, error: `extract failed: ${before.error}`, reason: 'office_ops_failed' };

  const o = await _officeOps(goal, before.stdout, kind, agentContext);
  if (o.failed) return { ok: false, error: 'LLM did not produce valid edit ops', reason: 'llm_failed' };
  if (!o.ops.length) return { ok: false, error: 'Goal could not be expressed as structured ops — try app.agent for in-app editing', reason: 'office_ops_failed' };

  const draftPath = converted ? workPath : _draftPathFor(filePath, kind);
  const applied = _py(script, ['apply', workPath, draftPath], JSON.stringify({ ops: o.ops }));
  if (!applied.ok) return { ok: false, error: `apply failed: ${applied.error}`, reason: 'office_ops_failed' };

  const after = _py(script, ['extract', draftPath]);
  const diff = after.ok ? _unifiedDiff(before.stdout, after.stdout, path.basename(filePath)) : '';

  let applyMeta = {};
  try { applyMeta = JSON.parse(applied.stdout.trim().split('\n').pop() || '{}'); } catch (_) {}
  const _officeHolders = _openFileHolders(filePath);
  const summary = `Draft ${kind} edit on ${path.basename(filePath)}: ${applyMeta.applied ?? o.ops.length} ops applied${applyMeta.missed ? `, ${applyMeta.missed} missed` : ''} → ${draftPath}`;
  logger.info(`[edit.agent] office: ${summary}`);
  return {
    ok: true, filePath, changed: true, mode: 'draft', draftPath, diff,
    appliedEdits: applyMeta.applied ?? o.ops.length, skippedEdits: [],
    converted, openIn: _officeHolders, summary, stdout: summary,
  };
}

// ── Apply a prior draft over the original ────────────────────────────────────
function _applyDraft(draftPath, filePath) {
  draftPath = _expandHome(String(draftPath));
  filePath = _expandHome(String(filePath));
  if (!fs.existsSync(draftPath)) {
    return { ok: false, error: `Draft not found: ${draftPath}`, reason: 'no_draft' };
  }
  const _draftExt = path.extname(draftPath).slice(1).toLowerCase();
  const _targetExt = path.extname(filePath).slice(1).toLowerCase();
  // A .docx draft may write back to legacy/convertible targets via textutil —
  // that's how rtf/doc drafts were produced in the first place.
  const _WRITEBACK_EXTS = new Set(['rtf', 'doc', 'odt', 'wordml', 'html', 'txt']);
  const _needsWriteBack = _draftExt === 'docx' && _draftExt !== _targetExt && _WRITEBACK_EXTS.has(_targetExt);
  if (_draftExt !== _targetExt && !_needsWriteBack) {
    return {
      ok: false,
      error: `Draft extension (${path.extname(draftPath)}) does not match target (${path.extname(filePath)}) — converted drafts must be saved manually`,
      reason: 'ext_mismatch',
    };
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) {
    return { ok: false, error: `File not found: ${filePath}`, reason: 'file_missing' };
  }
  const mtimeAtRead = stat.mtimeMs;

  // Open-file gate — an app holding the file will stomp the applied draft on
  // its next save (that's the whole reason the draft exists). Try a graceful
  // document-close first; if the handle survives (Automation consent denied,
  // non-scriptable app, user cancelled the save dialog) refuse with the app
  // name so the caller can ask the user to close it manually.
  const _applyHolders = _openFileHolders(filePath);
  let _closedIn = [];
  if (_applyHolders.length > 0) {
    logger.info(`[edit.agent] apply: ${path.basename(filePath)} open in ${_applyHolders.join(', ')} — attempting document close`);
    for (const appName of _applyHolders) {
      try { _closeDocumentInApp(appName, filePath); } catch (_) {}
    }
    const stillHeld = _openFileHolders(filePath);
    if (stillHeld.length > 0) {
      return {
        ok: false,
        error: `${path.basename(filePath)} is still open in ${stillHeld.join(', ')} — close it there (choose Don't Save if you kept the old version) and ask me to apply again`,
        reason: 'file_open',
        openIn: stillHeld,
      };
    }
    _closedIn = _applyHolders;
    logger.info(`[edit.agent] apply: document closed in ${_closedIn.join(', ')} — proceeding`);
  }

  const backupPath = _backup(filePath);
  const tmp = `${filePath}.thinkdrop-tmp`;
  try {
    if (_needsWriteBack) {
      const r = spawnSync('textutil', ['-convert', _targetExt, draftPath, '-output', tmp], { timeout: 30000 });
      if (r.status !== 0 || !fs.existsSync(tmp)) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        return { ok: false, error: `textutil could not convert draft to ${_targetExt}: ${(r.stderr || '').toString().slice(0, 200)}`, reason: 'office_ops_failed' };
      }
    } else {
      fs.copyFileSync(draftPath, tmp);
    }
    if (fs.statSync(filePath).mtimeMs !== mtimeAtRead) {
      fs.unlinkSync(tmp);
      return { ok: false, error: 'File changed on disk during apply — re-check and retry', reason: 'mtime_conflict' };
    }
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: `Apply failed: ${e.message}`, reason: 'write_failed' };
  }
  const summary = `Applied draft ${path.basename(draftPath)} → ${filePath}${_needsWriteBack ? ` (converted docx→${_targetExt})` : ''}${_closedIn.length ? ` (closed in ${_closedIn.join(', ')} first)` : ''}`;
  logger.info(`[edit.agent] ${summary}`);
  return { ok: true, filePath, changed: true, appliedEdits: 1, skippedEdits: [], backupPath, closedIn: _closedIn, converted: _needsWriteBack, writeBack: _needsWriteBack ? _targetExt : undefined, summary, stdout: summary };
}

// ── Main entry point ─────────────────────────────────────────────────────────
// Accepts planner arg aliases so a slightly-off plan still lands:
//   goal      ← goal | instruction | prompt | task | edit
//   filePath  ← filePath | path | file | target
//   mode      ← mode | writeMode        (inplace | draft | apply)
//   draftPath ← draftPath | draft       (apply mode)
// Fire-and-forget progress POST — same convention as cli.agent/browser.agent.
function _postProgress(callbackUrl, evt) {
  if (!callbackUrl) return;
  try {
    const http = require('http');
    const payload = JSON.stringify(evt);
    const parsed = new URL(callbackUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port: parseInt(parsed.port, 10),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 2000,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

// ── Post-edit validation & format preservation ──────────────────────────────

// Structural sanity before any write: an edit that breaks the file's syntax
// must never land. Best-effort — only validators for formats we can check.
// Returns { ok: true } or { ok: false, reason: 'invalid_syntax', detail }.
function _validateSyntax(filePath, edited) {
  const ext = (path.extname(filePath).slice(1) || '').toLowerCase();
  try {
    if (ext === 'json') {
      JSON.parse(edited);
      return { ok: true };
    }
    if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') {
      // node --check parses without executing. TS/JSX aren't node-checkable —
      // only run it on plain JS flavors.
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
        const tmp = path.join(os.tmpdir(), `edit-agent-check-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext === 'cjs' ? 'cjs' : 'mjs' === ext ? 'mjs' : 'js'}`);
        fs.writeFileSync(tmp, edited, 'utf8');
        try {
          require('child_process').execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe', timeout: 10000 });
          return { ok: true };
        } catch (e) {
          const detail = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 4).join('; ');
          return { ok: false, detail };
        } finally {
          try { fs.unlinkSync(tmp); } catch (_) {}
        }
      }
      return { ok: true };
    }
    if (ext === 'py') {
      const tmp = path.join(os.tmpdir(), `edit-agent-check-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
      fs.writeFileSync(tmp, edited, 'utf8');
      try {
        require('child_process').execFileSync('python3', ['-m', 'py_compile', tmp], { stdio: 'pipe', timeout: 15000 });
        return { ok: true };
      } catch (e) {
        const detail = String(e.stderr || e.message || '').split('\n').filter(Boolean).slice(0, 4).join('; ');
        return { ok: false, detail };
      } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
      }
    }
    if (ext === 'yaml' || ext === 'yml') {
      try { require.resolve('yaml'); } catch (_) { return { ok: true }; } // no parser available — skip
      const YAML = require('yaml');
      YAML.parse(edited);
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, detail: String(e.message || e).split('\n').slice(0, 3).join('; ') };
  }
  return { ok: true };
}

// Preserve the original's representation: BOM and dominant line-ending style.
// An edit must not silently convert a CRLF file to LF or drop a BOM.
function _preserveFormat(original, edited) {
  const hadBOM = original.charCodeAt(0) === 0xFEFF;
  const hasBOM = edited.charCodeAt(0) === 0xFEFF;
  if (hadBOM && !hasBOM) edited = '\uFEFF' + edited;
  else if (!hadBOM && hasBOM) edited = edited.slice(1);

  const origCRLF = (original.match(/\r\n/g) || []).length;
  const origLF = (original.match(/(?<!\r)\n/g) || []).length;
  const preferCRLF = origCRLF > origLF;
  if (preferCRLF) {
    // Normalize to LF first (handles mixed input), then convert to CRLF.
    edited = edited.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  } else {
    edited = edited.replace(/\r\n/g, '\n');
  }
  return edited;
}

async function editAgent(args = {}) {
  const goal = args.goal || args.instruction || args.prompt || args.task || args.edit || null;
  let filePath = args.filePath || args.path || args.file || args.target || null;
  const agentContext = args.agentContext;
  const mode = String(args.mode || args.writeMode || 'inplace').toLowerCase();
  const draftPath = args.draftPath || args.draft || null;

  if (mode === 'apply') {
    if (!draftPath || !filePath) {
      return { ok: false, error: 'apply mode needs both draftPath and filePath', reason: draftPath ? 'no_file' : 'no_draft' };
    }
    return _applyDraft(draftPath, filePath);
  }

  if (!filePath) return { ok: false, error: 'No filePath provided', reason: 'no_file' };
  if (!goal) return { ok: false, error: 'No goal provided', reason: 'no_goal' };

  filePath = _expandHome(String(filePath));

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return { ok: false, error: `File not found: ${filePath}`, reason: 'file_missing' };
  }
  if (!stat.isFile()) {
    return { ok: false, error: `Not a regular file: ${filePath}`, reason: 'not_a_file' };
  }

  const ext = (path.extname(filePath).slice(1) || '').toLowerCase();

  // Office formats → structured handlers (always draft-only).
  if (OFFICE_EXTS.has(ext)) {
    return await _editOffice(goal, filePath, ext, agentContext);
  }

  if (BINARY_EXTS.has(ext) || _looksBinary(filePath)) {
    return {
      ok: false,
      error: `Binary or non-text format (${ext || 'unknown'}) — use a format reader (textutil/pdftotext) or app.agent instead`,
      reason: 'binary_file',
    };
  }

  const mtimeAtRead = stat.mtimeMs;
  const content = _readFile(filePath);
  if (content === null) return { ok: false, error: `Could not read file: ${filePath}`, reason: 'file_missing' };

  // ── Produce edited content ─────────────────────────────────────────────────
  // ≤8K → whole-file rewrite. Larger → self-locating find/replace ops: a
  // targeted goal (line range, symbol, quoted text) slices a block-aware
  // window and ops apply inside it — works at ANY file size; a global goal
  // ("fix all typos") runs a chunked ops pass, still capped at 200K.
  let edited;
  let opsApplied = null;
  let targetNote = null;
  if (content.length <= SMALL_FILE_MAX) {
    logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars (whole-file)`);
    const res = await _llmRewrite(goal, content, agentContext);
    if (res === null) return { ok: false, error: 'LLM edit failed — no output', reason: 'llm_failed' };
    if (res.rejected) {
      return {
        ok: false,
        error: `LLM output rejected — suspiciously short (< ${Math.round(MIN_REWRITE_RATIO * 100)}% of original), refusing to write`,
        reason: 'suspicious_output',
      };
    }
    edited = res.edited;
  } else {
    let target = _findTarget(goal, content);
    if (content.length > LARGE_FILE_MAX && (target === 'whole' || !target)) {
      return {
        ok: false,
        error: `File too large (${content.length} chars > ${LARGE_FILE_MAX}) for a whole-file pass — target a section (quote text or name a line range) or split the task`,
        reason: 'file_too_large',
      };
    }
    if (target && target.notFound) {
      return { ok: false, error: target.notFound, reason: 'region_not_found' };
    }
    if (!target) {
      // No verbatim anchor — semantic fallback: the model picks a block index
      // from a numbered outline (integer-only JSON, can't crash on quotes).
      target = await _locateBlock(goal, content, agentContext);
    }
    if (!target) {
      return { ok: false, error: 'Could not locate the target — quote a few words from the text or name a section/line range', reason: 'region_not_found' };
    }
    if (target === 'whole') {
      logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars (chunked ops)`);
      const _emitProgress = typeof args._progressCallback === 'function'
        ? args._progressCallback
        : (args._progressCallbackUrl
          ? (evt) => _postProgress(args._progressCallbackUrl, { stepIndex: args._stepIndex ?? 0, ...evt })
          : null);
      const res = await _chunkedOps(goal, content, agentContext, _emitProgress);
      if (res.error) return { ok: false, error: res.error, reason: res.reason || 'op_failed' };
      edited = res.edited;
      opsApplied = res.applied;
      logger.info(`[edit.agent] chunked ops: ${res.applied.length} op(s) applied across ${content.length} chars`);
    } else {
      logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars (targeted ops @ ${target.label})`);
      const windowText = content.slice(target.start, target.end);
      const ops = await _emitOps(goal, windowText, target.label, agentContext);
      if (ops === null) return { ok: false, error: 'LLM edit failed — no output', reason: 'llm_failed' };
      const res = _applyOps(windowText, ops);
      if (res.error) return { ok: false, error: res.error, reason: res.reason || 'op_failed' };
      edited = content.slice(0, target.start) + res.text + content.slice(target.end);
      opsApplied = res.applied;
      targetNote = target.note || null;
      logger.info(`[edit.agent] targeted ops: ${res.applied.length} op(s) in window ${target.start}-${target.end} of ${content.length}`);
    }
  }

  // Trim-insensitive compare — the LLM response is .trim()'d, so a file with a
  // trailing newline would otherwise register a whitespace-only "change" and
  // trigger a pointless write + backup.
  const regionTrimmed = edited === content || edited === content.trim();
  if (regionTrimmed) {
    logger.info(`[edit.agent] editAgent: no changes made`);
    const summary = 'No changes needed';
    return { ok: true, filePath, changed: false, appliedEdits: 0, skippedEdits: [], summary, stdout: summary };
  }

  // Preserve the original's BOM + dominant line-ending style, then reject any
  // edit that breaks the file's syntax — before backup, draft, or write.
  edited = _preserveFormat(content, edited);
  const syntax = _validateSyntax(filePath, edited);
  if (!syntax.ok) {
    logger.warn(`[edit.agent] syntax check failed for ${path.basename(filePath)}: ${syntax.detail}`);
    return {
      ok: false,
      error: `Edit would produce invalid ${ext || 'file'} syntax — ${syntax.detail}. Nothing was written.`,
      reason: 'invalid_syntax',
    };
  }

  // mtime guard — if the file changed on disk since we read it (e.g. the app
  // it's open in auto-saved), do NOT silently overwrite that state.
  try {
    if (fs.statSync(filePath).mtimeMs !== mtimeAtRead) {
      return {
        ok: false,
        error: 'File changed on disk during the edit — re-read and retry',
        reason: 'mtime_conflict',
      };
    }
  } catch (_) { /* stat failed — proceed to write which will surface any real error */ }

  // Open-document guard: an app holding the file may auto-save over our write —
  // force draft mode regardless of what was requested. Name the holder(s) so
  // the UI can offer "Close <App> & Apply" instead of a generic message.
  const _holders = _openFileHolders(filePath);
  const autoDraft = mode !== 'draft' && _holders.length > 0;
  if (autoDraft) {
    logger.info(`[edit.agent] ${path.basename(filePath)} is open in ${_holders.join(', ')} (lsof) — forcing draft mode`);
  }

  if (mode === 'draft' || autoDraft) {
    const dp = _draftPathFor(filePath);
    if (!_writeFileAtomic(dp, edited)) {
      return { ok: false, error: `Could not write draft: ${dp}`, reason: 'write_failed' };
    }
    const diff = _unifiedDiff(content, edited, path.basename(filePath));
    const summary = `Draft saved → ${dp} (original untouched)${_holders.length ? ` — ${path.basename(filePath)} is open in ${_holders.join(', ')}` : ''}`;
    logger.info(`[edit.agent] editAgent: ${summary}`);
    return {
      ok: true, filePath, changed: true, mode: 'draft', draftPath: dp, diff,
      autoDraft, openIn: _holders, appliedEdits: 1, skippedEdits: [],
      opsApplied: opsApplied || undefined, note: targetNote || undefined,
      summary, stdout: summary,
    };
  }

  const backupPath = _backup(filePath);
  if (!_writeFileAtomic(filePath, edited)) {
    return { ok: false, error: `Could not write file: ${filePath}`, reason: 'write_failed' };
  }

  const _changePct = Math.round(Math.abs(edited.length - content.length) / content.length * 100);
  const summary = `Edited ${path.basename(filePath)}: ${content.length} → ${edited.length} chars (${_changePct}% change)`;
  logger.info(`[edit.agent] editAgent: done — ${summary}${backupPath ? `, backup: ${backupPath}` : ''}`);
  return {
    ok: true,
    filePath,
    changed: true,
    appliedEdits: 1,
    skippedEdits: [],
    backupPath,
    diff: _unifiedDiff(content, edited, path.basename(filePath)),
    opsApplied: opsApplied || undefined,
    note: targetNote || undefined,
    summary,
    stdout: summary,
  };
}

module.exports = {
  editAgent, _matchDocPaths, _openFileHolders,
  // exported for unit tests
  _applyOps, _normalizedIndexOf, _findTarget, _chunkedOps, _chunkContent,
  _preserveFormat, _validateSyntax, _lineRangeTarget, _blockWindow, _goalFragments, _isGlobalScope,
  _outlineBlocks, _locateBlock,
};
