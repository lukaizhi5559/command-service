'use strict';

/**
 * image.analyze skill
 *
 * Reads an image file from disk and sends it to the backend vision API
 * (/api/vision/analyze) to get a description and answer a query about it.
 *
 * Use this when the user has tagged an image file ([File: *.png/jpg/jpeg/gif/webp/bmp])
 * and wants to know what is in it.
 *
 * Args:
 *   filePath    {string}  Required. Absolute path to the image file.
 *   query       {string}  Optional. What to ask about the image. Default: "Describe this image in detail."
 *   timeoutMs   {number}  Optional. Max time for vision LLM call. Default: 30000.
 *
 * Returns:
 *   { success: true, description, answer, uiState, relevantElements, provider, elapsed }
 *   { success: false, error: string }
 */

const fs             = require('fs');
const path           = require('path');
const http           = require('http');
const os             = require('os');
const { execFileSync } = require('child_process');
const logger         = require('../logger.cjs');

const BACKEND_HOST    = process.env.THINKDROP_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT    = parseInt(process.env.THINKDROP_BACKEND_PORT || '4000', 10);
const SCREEN_INTEL_PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT     = 120000;

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif']);

const MIME_MAP = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.tiff': 'image/tiff',
  '.tif':  'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function httpPost(host, port, urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: host,
      port,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${host}:${port}${urlPath}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request to ${host}:${port}${urlPath} timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function imageAnalyze(args = {}) {
  let { filePath, query } = args;
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT, 10)));

  if (!filePath) {
    return { success: false, error: 'filePath is required — provide the absolute path to the image file' };
  }

  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return { success: false, error: `Unsupported image format: ${ext}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}` };
  }

  // Normalize path — macOS screenshot filenames use U+202F NARROW NO-BREAK SPACE
  // before AM/PM. The clipboard delivers a regular space, so existsSync fails.
  // Try: original → replace Unicode spaces → NFC → NFD until one resolves.
  function resolveFilePath(p) {
    // macOS screenshot filenames use U+202F NARROW NO-BREAK SPACE before AM/PM.
    // Clipboard delivers a regular space — replace space before AM/PM with U+202F.
    const withNarrowSpace = p.replace(/ (AM|PM)\./g, '\u202F$1.');
    const candidates = [
      p,
      withNarrowSpace,
      p.normalize('NFC'),
      p.normalize('NFD'),
      withNarrowSpace.normalize('NFC'),
      withNarrowSpace.normalize('NFD'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const resolvedPath = resolveFilePath(filePath);
  if (!resolvedPath) {
    return { success: false, error: `File not found: ${filePath}` };
  }
  filePath = resolvedPath;

  logger.info('[image.analyze] Starting', { filePath, query: query || '(default)', timeoutMs });

  const startTime = Date.now();

  // Resize large images before sending to vision API — Retina screenshots can be
  // 5120×2880 (~15MB base64) which wastes tokens and slows the API call.
  // Use sips (macOS built-in) to downscale to max 1920px wide, output as JPEG.
  let effectiveFilePath = filePath;
  let tempResizedPath = null;
  if (process.platform === 'darwin' && ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.heic', '.heif'].includes(ext)) {
    try {
      tempResizedPath = path.join(os.tmpdir(), `thinkdrop_img_${Date.now()}.jpg`);
      execFileSync('sips', [
        '--resampleWidth', '1920',
        '--setProperty', 'formatOptions', '85',
        '-s', 'format', 'jpeg',
        filePath,
        '--out', tempResizedPath
      ], { timeout: 10000 });
      if (fs.existsSync(tempResizedPath)) {
        effectiveFilePath = tempResizedPath;
        logger.info('[image.analyze] Resized image for vision API', { original: filePath, resized: tempResizedPath });
      }
    } catch (resizeErr) {
      logger.warn('[image.analyze] sips resize failed, using original', { error: resizeErr.message });
      tempResizedPath = null;
    }
  }

  let base64;
  try {
    const buffer = fs.readFileSync(effectiveFilePath);
    base64 = buffer.toString('base64');
  } catch (err) {
    if (tempResizedPath) try { fs.unlinkSync(tempResizedPath); } catch (_) {}
    return { success: false, error: `Failed to read image file: ${err.message}` };
  }

  // Cleanup temp file after reading
  if (tempResizedPath) try { fs.unlinkSync(tempResizedPath); } catch (_) {}

  const mimeType = (effectiveFilePath !== filePath) ? 'image/jpeg' : (MIME_MAP[ext] || 'image/png');
  const effectiveQuery = query || 'Describe this image in detail. What does it show? What text is visible?';

  // ── Primary: vision LLM via thinkdrop-backend ────────────────────────────
  let result;
  let usedOcrFallback = false;
  try {
    result = await httpPost(
      BACKEND_HOST,
      BACKEND_PORT,
      '/api/vision/analyze',
      {
        screenshot: { base64, mimeType },
        query: effectiveQuery,
        context: { activeApp: 'file', activeUrl: filePath },
      },
      timeoutMs
    );
  } catch (err) {
    logger.warn('[image.analyze] Vision backend unavailable — falling back to Tesseract OCR', { error: err.message });
    result = null;
  }

  // ── Fallback: Tesseract OCR via screen-intelligence-service ──────────────
  if (!result?.success) {
    logger.info('[image.analyze] Trying OCR fallback via screen-intelligence-service', { filePath });
    usedOcrFallback = true;
    try {
      const ocrResult = await httpPost(
        BACKEND_HOST,
        SCREEN_INTEL_PORT,
        '/screen.analyze-file',
        { filePath, query: effectiveQuery },
        timeoutMs
      );
      if (ocrResult?.success && ocrResult.text) {
        const elapsed = Date.now() - startTime;
        const answer = ocrResult.text.trim();
        logger.info('[image.analyze] OCR fallback succeeded', { confidence: ocrResult.confidence, elapsed });
        return {
          success: true,
          description: answer,
          answer,
          uiState: '',
          relevantElements: [],
          provider: 'tesseract-ocr',
          confidence: ocrResult.confidence,
          elapsed,
          stdout: answer,
        };
      } else {
        return { success: false, error: ocrResult?.error || 'OCR fallback returned no text' };
      }
    } catch (ocrErr) {
      logger.warn('[image.analyze] OCR fallback also failed', { error: ocrErr.message });
      return { success: false, error: `Vision API unavailable and OCR fallback failed: ${ocrErr.message}` };
    }
  }

  const elapsed = Date.now() - startTime;

  logger.info('[image.analyze] Done', { provider: result.provider, elapsed, usedOcrFallback });

  // Backend wraps the analysis under result.analysis (not top-level)
  const analysis = result.analysis || result;
  const answerText = analysis.answer || analysis.description || '';

  return {
    success: true,
    description: analysis.description || analysis.answer || '',
    answer: answerText,
    uiState: analysis.uiState || '',
    relevantElements: analysis.relevantElements || [],
    provider: result.provider,
    elapsed,
    stdout: answerText,
  };
}

module.exports = { imageAnalyze };
