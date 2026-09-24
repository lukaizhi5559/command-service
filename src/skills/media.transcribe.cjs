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
 *   model            {string}  Optional. Whisper model name (default 'large',
 *                              matching video.agent). 'small' is faster.
 *   timeoutMs        {number}  Optional. Transcription timeout (default 600s).
 *
 * Returns:
 *   { ok: true, path, transcript, chars, method, stdout }
 *   { ok: false, reason: 'no_file'|'file_missing'|'not_a_file'|'unsupported'|'missing_dep'|'transcribe_failed', error }
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');
const { ensure } = require('../skill-helpers/deps.cjs');

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

  // Deps: transcribe-anything (pip, silent --user install) + ffmpeg (brew rail).
  const tDep = await ensure('transcribe-anything', { confirm: args.confirmInstall });
  if (!tDep.ok) return { ok: false, error: tDep.error, reason: 'missing_dep' };
  const ffDep = await ensure('ffmpeg', { confirm: args.confirmInstall });
  if (!ffDep.ok) {
    logger.warn(`[media.transcribe] ffmpeg unavailable (${ffDep.error}) — transcription may fail on compressed formats`);
  }

  // Apple Silicon → MLX backend (video.agent precedent), else CPU.
  const device = (os.platform() === 'darwin' && os.arch() === 'arm64') ? 'mlx' : 'cpu';
  const model = String(args.model || 'large');
  const timeoutMs = Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 600000;
  const safePath = filePath.replace(/["\\]/g, '');
  const safeModel = model.replace(/["\\]/g, '');
  const safeDevice = device.replace(/["\\]/g, '');

  logger.info(`[media.transcribe] ${path.basename(filePath)} via transcribe-anything (device=${device}, model=${model})`);

  return new Promise((resolve) => {
    const pythonScript = `
import sys, json
try:
    from transcribe_anything import transcribe
    result = transcribe(url_or_file="${safePath}", device="${safeDevice}", model="${safeModel}", task="transcribe")
    print("TD_RESULT:" + json.dumps({"success": True, "transcript": str(result)}))
except Exception as e:
    print("TD_RESULT:" + json.dumps({"success": False, "error": str(e)}))
`;
    const proc = spawn('python3', ['-c', pythonScript]);
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const m = stdout.match(/TD_RESULT:(\{[\s\S]*\})/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed.success && parsed.transcript) {
            const transcript = parsed.transcript;
            logger.info(`[media.transcribe] ${path.basename(filePath)}: ${transcript.length} chars`);
            return resolve({
              ok: true, path: filePath, transcript, chars: transcript.length,
              method: `transcribe-anything/${device}`,
              summary: `Transcribed ${path.basename(filePath)}: ${transcript.length} chars`,
              stdout: transcript,
            });
          }
          return resolve({ ok: false, error: parsed.error || 'Transcription failed', reason: 'transcribe_failed' });
        } catch (_) { /* fall through */ }
      }
      resolve({ ok: false, error: `Transcription failed: ${(stderr || 'no result').slice(0, 400)}`, reason: 'transcribe_failed' });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `python3 unavailable: ${e.message}`, reason: 'missing_dep' });
    });
  });
}

module.exports = { mediaTranscribe };
