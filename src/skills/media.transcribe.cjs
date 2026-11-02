'use strict';
/**
 * skill: media.transcribe
 *
 * Transcribe a LOCAL audio/video file to text — the file-based counterpart to
 * video.agent (which handles web video URLs/pages).
 *
 * Pipeline: transcribe-anything (Whisper) via python3 — accepts a local file
 * path directly (url_or_file arg); ffmpeg is required underneath for decoding.
 * Deps resolve through skill-helpers/deps.cjs (silent pip --user install).
 *
 * Args:
 *   path | filePath  {string}  Required. Absolute path to a media file
 *                              (.mp3 .m4a .wav .aac .flac .ogg .mp4 .mov .mkv .webm .m4v).
 *   language         {string}  Optional. Hint for the transcription language.
 *   model            {string}  Optional. Whisper model name (default 'base' —
 *                              'large' is too slow for inline cpu transcription).
 *   device           {string}  Optional. 'cpu' (default) | 'mlx' — mlx is opt-in
 *                              only: lightning-whisper-mlx dep resolution is
 *                              currently broken (tiktoken conflict).
 *   timeoutMs        {number}  Optional. Transcription timeout (default 600s).
 *
 * Returns:
 *   { ok: true, path, transcript, chars, method, stdout }
 *   { ok: false, reason: 'no_file'|'file_missing'|'not_a_file'|'unsupported'|'missing_dep'|'transcribe_failed', error }
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const logger = require('../logger.cjs');
const { ensure } = require('../skill-helpers/deps.cjs');
const { transcribeAnything } = require('../skill-helpers/transcribe-anything.cjs');

const MEDIA_EXTS = new Set([
  'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus',
  'mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi',
]);

function _expandHome(p) {
  return typeof p === 'string' && p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

async function mediaTranscribe(args = {}) {
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
  if (!MEDIA_EXTS.has(ext)) {
    return {
      ok: false,
      error: `Unsupported media format '.${ext || 'none'}' — media.transcribe covers ${[...MEDIA_EXTS].join('/')}`,
      reason: 'unsupported',
    };
  }

  // ffmpeg is a soft dep for compressed formats (transcribe-anything itself is
  // ensured inside the shared helper).
  const ffDep = await ensure('ffmpeg', { confirm: args.confirmInstall });
  if (!ffDep.ok) {
    logger.warn(`[media.transcribe] ffmpeg unavailable (${ffDep.error}) — transcription may fail on compressed formats`);
  }

  const device = (args.device === 'cpu' || args.device === 'mlx') ? args.device : undefined;
  const model = String(args.model || 'base');
  const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : undefined;

  logger.info(`[media.transcribe] ${path.basename(filePath)} via transcribe-anything`);

  const r = await transcribeAnything({
    target: filePath,
    device,
    model,
    timeoutMs,
    confirmInstall: args.confirmInstall,
  });
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason || 'transcribe_failed' };

  return {
    ok: true, path: filePath, transcript: r.transcript, chars: r.chars,
    method: r.method,
    summary: `Transcribed ${path.basename(filePath)}: ${r.transcript.length} chars`,
    stdout: r.transcript,
  };
}

module.exports = { mediaTranscribe };
