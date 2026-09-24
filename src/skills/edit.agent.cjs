// edit.agent.cjs — File-based editing agent for semantic text edits.
// Works like a mini Devin: reads a file, understands the goal, applies edits,
// saves — with safety rails. Phase 2 adds draft/apply modes, region-anchored
// edits for large files, and structured Office handlers.
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
// Region-anchored edits cover files up to ~50k tokens of content.
const LARGE_FILE_MAX = 200000;
// Region window around an anchor hit (line-aligned, ± this many chars).
const REGION_RADIUS = 3000;
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

// ── Region-anchored editing (SMALL_FILE_MAX < size ≤ LARGE_FILE_MAX) ─────────
// Anchor candidates: quoted spans in the goal are literal text the user is
// pointing at ("fix the 'misstake' typo"). A unique indexOf hit anchors a
// line-aligned window; the LLM rewrites only that window and we splice it back.
function _literalAnchors(goal) {
  const out = [];
  const re = /["'`]([^"'`\n]{3,120})["'`]/g;
  let m;
  while ((m = re.exec(String(goal)))) out.push(m[1]);
  return out;
}

function _regionWindow(content, hitIndex) {
  let start = Math.max(0, hitIndex - REGION_RADIUS);
  let end = Math.min(content.length, hitIndex + REGION_RADIUS);
  // Align to line boundaries so the LLM sees whole lines.
  if (start > 0) {
    const nl = content.indexOf('\n', start);
    start = nl >= 0 && nl < end ? nl + 1 : start;
  }
  if (end < content.length) {
    const nl = content.lastIndexOf('\n', end);
    end = nl > start ? nl : end;
  }
  return { start, end };
}

// LLM locate fallback: ask for a short verbatim substring nearest the edit
// site. Validated by indexOf — the model can only point at real text.
async function _locateAnchor(goal, content, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
  // Send head + tail + line count so the model sees structure without the
  // whole file (region anchoring exists precisely because it doesn't fit).
  const head = content.slice(0, 4000);
  const tail = content.slice(-2000);
  const userPrompt = `Goal: ${goal}
${agentContext ? `\nAgent context:\n${String(agentContext).slice(0, 400)}\n` : ''}
The file is too large to show fully (${content.length} chars). Head and tail:
--- HEAD ---
${head}
--- TAIL ---
${tail}
---

Reply with ONLY a JSON object: {"anchor":"<a short verbatim substring (5-15 words) copied exactly from the file, nearest the text the goal refers to>"}. The anchor MUST be copied character-for-character from the file.`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You locate text. Output only JSON.' },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 200, temperature: 0, responseTimeoutMs: 30000, taskType: 'fast' });
    const m = (raw || '').match(/\{[^}]*"anchor"[^}]*\}/s);
    if (!m) return null;
    const anchor = JSON.parse(m[0]).anchor;
    return typeof anchor === 'string' && anchor.length >= 3 ? anchor : null;
  } catch (e) {
    logger.warn(`[edit.agent] _locateAnchor failed: ${e.message}`);
    return null;
  }
}

async function _findRegion(goal, content, agentContext) {
  const anchors = _literalAnchors(goal);
  for (const a of anchors) {
    const first = content.indexOf(a);
    if (first >= 0 && content.indexOf(a, first + 1) === -1) {
      return _regionWindow(content, first); // unique literal hit
    }
    if (first >= 0) return { ambiguous: a }; // literal hit, but not unique
  }
  const anchor = await _locateAnchor(goal, content, agentContext);
  if (anchor) {
    const idx = content.indexOf(anchor);
    if (idx >= 0) return _regionWindow(content, idx);
    logger.warn(`[edit.agent] LLM anchor not found verbatim: "${anchor.slice(0, 60)}"`);
  }
  return null;
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

  if (content.length > LARGE_FILE_MAX) {
    return {
      ok: false,
      error: `File too large (${content.length} chars > ${LARGE_FILE_MAX}) — use targeted shell edits (sed/python3) or split the task`,
      reason: 'file_too_large',
    };
  }

  // ── Produce edited content: whole-file for small, region-anchored for large ──
  let edited;
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
    logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars (region-anchored)`);
    const region = await _findRegion(goal, content, agentContext);
    if (!region) {
      return { ok: false, error: 'Could not locate the edit region — quote the target text in the goal, or use targeted shell edits', reason: 'region_not_found' };
    }
    if (region.ambiguous) {
      return { ok: false, error: `Anchor "${String(region.ambiguous).slice(0, 60)}" matches multiple locations — narrow the goal`, reason: 'ambiguous_region' };
    }
    const regionText = content.slice(region.start, region.end);
    const res = await _llmRewrite(goal, regionText, agentContext, 'region');
    if (res === null) return { ok: false, error: 'LLM edit failed — no output', reason: 'llm_failed' };
    if (res.rejected) {
      return { ok: false, error: `LLM region output rejected — suspiciously short, refusing to write`, reason: 'suspicious_output' };
    }
    edited = content.slice(0, region.start) + res.edited + content.slice(region.end);
    logger.info(`[edit.agent] region edit: chars ${region.start}-${region.end} of ${content.length}`);
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
      autoDraft, openIn: _holders, appliedEdits: 1, skippedEdits: [], summary, stdout: summary,
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
    summary,
    stdout: summary,
  };
}

module.exports = { editAgent, _matchDocPaths, _openFileHolders };
