'use strict';
/**
 * transcribe-anything.cjs — shared Whisper transcription via the
 * transcribe-anything Python package. Callers:
 *   - media.transcribe (local audio/video files)
 *   - video.agent      (web video/audio URLs — yt-dlp subs fallback)
 *
 * Wraps the known footguns of transcribe_anything.transcribe():
 *   - returns an OUTPUT DIRECTORY (out.txt/.srt/.json), not transcript text
 *   - shells out to a `static_ffmpeg` CLI that pip --user drops in
 *     ~/Library/Python/<ver>/bin — not on the service PATH
 *   - writes text_<name>/ output dirs into CWD — run in a scratch dir + cleanup
 *   - prints progress/logs on stdout — TD_RESULT marker for reliable parsing
 *   - device 'mlx' (Apple Silicon) fails dep resolution today
 *     (lightning-whisper-mlx==0.0.10 requires tiktoken==0.3.3, env has >=0.5.0)
 *     → default 'cpu'; mlx only on explicit opt-in
 *
 *   const { transcribeAnything } = require('../skill-helpers/transcribe-anything.cjs');
 *   const r = await transcribeAnything({ target: urlOrFilePath, model: 'base' });
 *   // → { ok:true, transcript, chars, method } | { ok:false, reason, error }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');
const { ensure } = require('./deps.cjs');

/**
 * @param {object} opts
 * @param {string} opts.target      Local media file path or http(s) URL.
 * @param {string} [opts.device]    'cpu' | 'mlx' — default 'cpu'. mlx is opt-in
 *                                  only: its dep resolution is broken today.
 * @param {string} [opts.model]     Whisper model — default 'base' (fast enough
 *                                  for inline use; 'large' exceeds timeouts on cpu).
 * @param {number} [opts.timeoutMs] Kill timeout — default 600s.
 * @param {Function} [opts.confirmInstall] Passed to deps.ensure for consent cards.
 */
async function transcribeAnything(opts = {}) {
  const target = String(opts.target || '').trim();
  if (!target) return { ok: false, reason: 'no_target', error: 'No target provided' };

  const tDep = await ensure('transcribe-anything', { confirm: opts.confirmInstall });
  if (!tDep.ok) return { ok: false, reason: 'missing_dep', error: tDep.error };

  const device = (opts.device === 'cpu' || opts.device === 'mlx') ? opts.device : 'cpu';
  const model = String(opts.model || 'base');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 600000;

  logger.info(`[transcribe-anything] ${target.slice(0, 80)} (device=${device}, model=${model})`);

  return new Promise((resolve) => {
    // transcribe_anything writes its text_<name>/ output dir into CWD —
    // run in a scratch dir; the result dir is deleted on close.
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ta-'));
    const pythonScript = `
import sys, json, os
try:
    from transcribe_anything import transcribe
    result = transcribe(url_or_file=os.environ["TD_TARGET"], device=os.environ["TD_DEVICE"], model=os.environ["TD_MODEL"], task="transcribe")
    # transcribe-anything returns the OUTPUT DIRECTORY (out.txt/.srt/.json
    # inside), not transcript text — read out.txt so callers get speech.
    text = str(result)
    out_txt = os.path.join(text, "out.txt")
    if os.path.isfile(out_txt):
        with open(out_txt, encoding="utf-8", errors="replace") as f:
            text = f.read().strip()
    print("TD_RESULT:" + json.dumps({"success": True, "transcript": text}))
except Exception as e:
    print("TD_RESULT:" + json.dumps({"success": False, "error": str(e)}))
`;
    // transcribe_anything shells out to a `static_ffmpeg` CLI — pip --user
    // drops it in ~/Library/Python/3.x/bin, which is not on the service PATH.
    let userBin = '';
    try {
      const pyRoot = path.join(os.homedir(), 'Library', 'Python');
      const ver = fs.readdirSync(pyRoot).find(d => /^\d+\.\d+$/.test(d));
      if (ver) userBin = path.join(pyRoot, ver, 'bin') + ':';
    } catch (_) {}

    const proc = spawn('python3', ['-c', pythonScript], {
      cwd: scratchDir,
      env: {
        ...process.env,
        PATH: `${userBin}${process.env.PATH || ''}`,
        // Target/model/device via env — never interpolated into python source.
        TD_TARGET: target,
        TD_DEVICE: device,
        TD_MODEL: model,
      },
    });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
      const m = stdout.match(/TD_RESULT:(\{[\s\S]*\})/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          if (parsed.success && parsed.transcript) {
            logger.info(`[transcribe-anything] ${parsed.transcript.length} chars`);
            return resolve({
              ok: true,
              transcript: parsed.transcript,
              chars: parsed.transcript.length,
              method: `transcribe-anything/${device}`,
            });
          }
          return resolve({ ok: false, error: parsed.error || 'Transcription failed', reason: 'transcribe_failed' });
        } catch (_) { /* fall through */ }
      }
      resolve({ ok: false, error: `Transcription failed: ${(stderr || 'no result').slice(0, 400)}`, reason: 'transcribe_failed' });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {}
      resolve({ ok: false, error: `python3 unavailable: ${e.message}`, reason: 'missing_dep' });
    });
  });
}

module.exports = { transcribeAnything };
