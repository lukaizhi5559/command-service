// edit.agent.cjs — File-based editing agent for semantic text edits.
// Works like a mini Devin: reads a file, understands the goal, applies edits
// using an LLM full-content rewrite, saves the file — with safety rails.
//
// Used by:
//   - command.automate dispatch (skill: 'edit.agent') — plan-level file edits
//   - instruction.runner.cjs type-edit (Edit mode) — browser fields
//   - app.agent.cjs — editing files in desktop apps (VS Code, TextEdit)
//   - cli.agent.cjs — editing files via CLI (vim, nano)
//
// API:
//   const { editAgent } = require('./edit.agent.cjs');
//   const result = await editAgent({ goal, filePath, agentContext? });
//   // ok:    { ok:true, filePath, changed, appliedEdits, backupPath, summary, stdout }
//   // fail:  { ok:false, error, reason }
//   // reasons: no_goal | no_file | file_missing | not_a_file | binary_file |
//   //          file_too_large | llm_failed | suspicious_output | mtime_conflict | write_failed
//
// Phase-1 scope (minimal-safe): plain-text files ≤ SMALL_FILE_MAX chars only,
// full-rewrite mode with a strict length floor, backup + atomic write + mtime
// guard. Larger files return reason:'file_too_large' so recovery can route to
// targeted shell edits — the region-anchored large-file protocol, draft/approve
// mode, and Office-format handlers land in Phase 2.

const fs = require('fs');
const os = require('os');
const path = require('path');

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
// Reject rewrites that come back drastically shorter — the old 30% floor let
// 50% truncations pass and silently destroyed content.
const MIN_REWRITE_RATIO = 0.6;

// Extensions that must never be opened as UTF-8 text. Binary/office/markup
// formats route to format readers (textutil/pdftotext/openpyxl) or the
// structured handlers planned for Phase 2.
const BINARY_EXTS = new Set([
  // documents / office
  'pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt',
  'pages', 'numbers', 'key', 'odt', 'ods', 'odp', 'rtf', 'epub',
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

// ── Small file editing (≤ SMALL_FILE_MAX) ────────────────────────────────────
// LLM returns the full edited content.
async function _editSmallFile(goal, content, agentContext) {
  const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

  const _contextBlock = agentContext ? `\n\nAgent context:\n${String(agentContext).slice(0, 800)}` : '';

  const systemPrompt = `You are a precise text editor. You edit the given content according to the goal.
Return ONLY the edited content — no explanations, no markdown code fences.
- Apply the requested changes precisely
- Preserve the overall structure and formatting
- Do not add or remove content beyond what the goal asks for
- If the goal asks to add a section, add it in the appropriate place
- If the goal asks to fix something, fix only that
- Return the full edited content (not just the changes)`;

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
      logger.warn(`[edit.agent] _editSmallFile: edited content suspiciously short (${edited.length} vs ${content.length}) — rejecting`);
      return { rejected: true };
    }
    return { edited };
  } catch (e) {
    logger.warn(`[edit.agent] _editSmallFile failed: ${e.message}`);
    return null;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────
// Accepts planner arg aliases so a slightly-off plan still lands:
//   goal     ← goal | instruction | prompt | task | edit
//   filePath ← filePath | path | file | target
async function editAgent(args = {}) {
  const goal = args.goal || args.instruction || args.prompt || args.task || args.edit || null;
  let filePath = args.filePath || args.path || args.file || args.target || null;
  const agentContext = args.agentContext;

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

  // Binary / office-format guard — never open these as UTF-8.
  const ext = (path.extname(filePath).slice(1) || '').toLowerCase();
  if (BINARY_EXTS.has(ext) || _looksBinary(filePath)) {
    return {
      ok: false,
      error: `Binary or non-text format (${ext || 'unknown'}) — use a format reader (textutil/pdftotext/openpyxl) instead`,
      reason: 'binary_file',
    };
  }

  const mtimeAtRead = stat.mtimeMs;
  const content = _readFile(filePath);
  if (content === null) return { ok: false, error: `Could not read file: ${filePath}`, reason: 'file_missing' };

  if (content.length > SMALL_FILE_MAX) {
    return {
      ok: false,
      error: `File too large for whole-file edit (${content.length} chars > ${SMALL_FILE_MAX}) — use targeted shell edits (sed/python3) or split the task`,
      reason: 'file_too_large',
    };
  }

  logger.info(`[edit.agent] editAgent: goal="${String(goal).slice(0, 80)}", file=${path.basename(filePath)}, size=${content.length} chars`);

  const res = await _editSmallFile(goal, content, agentContext);
  if (res === null) {
    return { ok: false, error: 'LLM edit failed — no output', reason: 'llm_failed' };
  }
  if (res.rejected) {
    return {
      ok: false,
      error: `LLM output rejected — suspiciously short (< ${Math.round(MIN_REWRITE_RATIO * 100)}% of original), refusing to write`,
      reason: 'suspicious_output',
    };
  }

  const edited = res.edited;
  // Trim-insensitive compare — the LLM response is .trim()'d, so a file with a
  // trailing newline would otherwise register a whitespace-only "change" and
  // trigger a pointless write + backup.
  if (edited === content || edited === content.trim()) {
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

module.exports = { editAgent };
