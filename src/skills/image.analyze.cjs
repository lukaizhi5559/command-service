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
 *   filePath    {string}   Required*. Absolute path to the image file.
 *   filePaths   {string[]} Optional. Multiple image paths — analyzes each and
 *                          returns an aggregated result (capped at 10).
 *   query       {string}   Optional. What to ask about the image. Default: "Describe this image in detail."
 *   timeoutMs   {number}   Optional. Max time for vision LLM call. Default: 30000.
 *   priorContracts {Array} Optional. Prior step output contracts for auto-discovery.
 *   * one of filePath / filePaths / auto-discovery must yield at least one path.
 *
 * Returns (single image):
 *   { ok: true, success: true, description, answer, uiState, relevantElements, provider, elapsed, stdout, filePath }
 * Returns (multiple images):
 *   { ok: true, success: true, analyses: [{filePath, answer, ...}], filePaths, stdout, analyzedCount, partialErrors? }
 *   { ok: false, success: false, error: string }
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
const MAX_IMAGES      = 10;

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

const IMAGE_EXT_RE     = /\.(png|jpg|jpeg|gif|webp|bmp|tiff|tif|heic|heif)$/i;
const TEMPLATE_TOKEN_RE = /\{\{[^}]+\}\}/;

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

// Normalize path — macOS screenshot filenames use U+202F NARROW NO-BREAK SPACE
// before AM/PM. The clipboard delivers a regular space, so existsSync fails.
// Try: original → replace Unicode spaces → NFC → NFD until one resolves.
function resolveFilePath(p) {
  // macOS screenshot filenames use U+202F NARROW NO-BREAK SPACE before AM/PM.
  // Clipboard delivers a regular space — replace space before AM/PM with U+202F.
  const withNarrowSpace = p.replace(/ (AM|PM)\./g, ' $1.');
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

/**
 * Analyze a single resolved image file.
 * Returns { ok, filePath, answer, description, uiState, relevantElements, provider, confidence, elapsed, error }.
 */
async function _analyzeOneImage(filePath, ext, effectiveQuery, timeoutMs, startTime) {
  logger.info('[image.analyze] Starting', { filePath, query: effectiveQuery, timeoutMs });

  // Resize large images before sending to vision API — Retina screenshots can be
  // 5120×2880 (~15MB base64) which wastes tokens and slows the API call.
  // Use sips (macOS built-in) to downscale to max 1920px wide, output as JPEG.
  let effectiveFilePath = filePath;
  let tempResizedPath = null;
  if (process.platform === 'darwin' && ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.heic', '.heif'].includes(ext)) {
    try {
      // Unique name per call — safe when iterating filePaths
      tempResizedPath = path.join(os.tmpdir(), `thinkdrop_img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
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
    return { ok: false, filePath, error: `Failed to read image file: ${err.message}` };
  }

  // Cleanup temp file after reading
  if (tempResizedPath) try { fs.unlinkSync(tempResizedPath); } catch (_) {}

  const mimeType = (effectiveFilePath !== filePath) ? 'image/jpeg' : (MIME_MAP[ext] || 'image/png');

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
          ok: true,
          filePath,
          description: answer,
          answer,
          uiState: '',
          relevantElements: [],
          provider: 'tesseract-ocr',
          confidence: ocrResult.confidence,
          elapsed,
        };
      }
      return { ok: false, filePath, error: ocrResult?.error || 'OCR fallback returned no text' };
    } catch (ocrErr) {
      logger.warn('[image.analyze] OCR fallback also failed', { error: ocrErr.message });
      return { ok: false, filePath, error: `Vision API unavailable and OCR fallback failed: ${ocrErr.message}` };
    }
  }

  const elapsed = Date.now() - startTime;

  logger.info('[image.analyze] Done', { provider: result.provider, elapsed, usedOcrFallback });

  // Backend wraps the analysis under result.analysis (not top-level)
  const analysis = result.analysis || result;
  const answerText = analysis.answer || analysis.description || '';

  return {
    ok: true,
    filePath,
    description: analysis.description || analysis.answer || '',
    answer: answerText,
    uiState: analysis.uiState || '',
    relevantElements: analysis.relevantElements || [],
    provider: result.provider,
    elapsed,
  };
}

async function imageAnalyze(args = {}) {
  let { filePath, filePaths, query, priorContracts } = args;
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT, 10)));

  // Reject unresolved template tokens early — a literal {{...}} arg means the
  // dispatcher skipped template resolution, and it would otherwise surface as a
  // confusing "Unsupported image format: ." (extname('{{PREV_OUTPUT}}') === '').
  if (typeof filePath === 'string' && TEMPLATE_TOKEN_RE.test(filePath)) {
    return { ok: false, success: false, error: `filePath contains an unresolved template token: ${filePath.match(TEMPLATE_TOKEN_RE)[0]}` };
  }

  // Multi-line filePath (e.g. {{PREV_OUTPUT}} resolved to a whole file list) —
  // take the first line that resolves to an existing file.
  if (typeof filePath === 'string' && filePath.includes('\n')) {
    const lines = filePath.split('\n').map(l => l.trim()).filter(Boolean);
    const found = lines.map(resolveFilePath).find(Boolean);
    filePath = found || lines[0] || '';
  }
  if (typeof filePath === 'string') filePath = filePath.trim();

  // Auto-discover filePath (and filePaths) from prior step contracts if not provided
  if (!filePath && !(Array.isArray(filePaths) && filePaths.length) && Array.isArray(priorContracts) && priorContracts.length > 0) {
    for (let i = priorContracts.length - 1; i >= 0; i--) {
      const contract = priorContracts[i];

      // Look for image files in shell.run stdout
      if (contract.skill === 'shell.run' && contract.outputs?.filePaths?.value?.length > 0) {
        const imagePaths = contract.outputs.filePaths.value.filter(p => IMAGE_EXT_RE.test(p));
        if (imagePaths.length > 0) {
          filePath = imagePaths[0];
          if (imagePaths.length > 1) filePaths = imagePaths;
          logger.info(`[image.analyze] Auto-discovered ${imagePaths.length} filePath(s) from prior shell.run: ${filePath}`);
          break;
        }
      }

      // Look for image files in fs.read results
      if (contract.skill === 'fs.read' && contract.outputs?.files?.value?.length > 0) {
        const imagePaths = contract.outputs.files.value.filter(f => IMAGE_EXT_RE.test(f));
        if (imagePaths.length > 0) {
          filePath = imagePaths[0];
          if (imagePaths.length > 1) filePaths = imagePaths;
          logger.info(`[image.analyze] Auto-discovered ${imagePaths.length} filePath(s) from prior fs.read: ${filePath}`);
          break;
        }
      }
    }
  }

  const targets = Array.isArray(filePaths) && filePaths.length
    ? filePaths
    : (filePath ? [filePath] : []);

  if (!targets.length) {
    return { ok: false, success: false, error: 'filePath is required — provide the absolute path to the image file, or pass priorContracts to auto-discover' };
  }

  const truncated = targets.length > MAX_IMAGES;
  const list = truncated ? targets.slice(0, MAX_IMAGES) : targets;
  if (truncated) {
    logger.warn(`[image.analyze] ${targets.length} files requested — analyzing first ${MAX_IMAGES}`);
  }

  // Validate extension + resolve each path up front so bad inputs fail fast
  const toAnalyze = [];
  const inputErrors = [];
  for (const t of list) {
    if (typeof t !== 'string' || !t.trim()) { inputErrors.push('Empty filePath entry'); continue; }
    const p = t.trim();
    if (TEMPLATE_TOKEN_RE.test(p)) {
      inputErrors.push(`Unresolved template token in filePath: ${p.match(TEMPLATE_TOKEN_RE)[0]}`);
      continue;
    }
    const ext = path.extname(p).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      inputErrors.push(`Unsupported image format: ${ext || '(none)'} — ${path.basename(p) || p}. Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}`);
      continue;
    }
    const resolved = resolveFilePath(p);
    if (!resolved) {
      inputErrors.push(`File not found: ${p}`);
      continue;
    }
    toAnalyze.push({ filePath: resolved, ext });
  }

  if (!toAnalyze.length) {
    return { ok: false, success: false, error: inputErrors.join('; ') || 'No valid image files' };
  }

  const startTime = Date.now();
  const effectiveQuery = query || 'Describe this image in detail. What does it show? What text is visible?';

  const analyses = [];
  for (const { filePath: fp, ext } of toAnalyze) {
    analyses.push(await _analyzeOneImage(fp, ext, effectiveQuery, timeoutMs, startTime));
  }

  const okOnes = analyses.filter(a => a.ok);
  if (!okOnes.length) {
    return { ok: false, success: false, error: analyses[0]?.error || 'Image analysis failed' };
  }

  const elapsed = Date.now() - startTime;

  // Single-image result keeps the original flat shape
  if (toAnalyze.length === 1 && !inputErrors.length) {
    const a = okOnes[0];
    return {
      ok: true,
      success: true,
      filePath: a.filePath,
      description: a.description,
      answer: a.answer,
      uiState: a.uiState,
      relevantElements: a.relevantElements,
      provider: a.provider,
      confidence: a.confidence,
      elapsed,
      stdout: a.answer,
    };
  }

  // Multi-image: aggregate. stdout carries every analysis so a downstream
  // synthesize step sees them all.
  const stdout = okOnes.map(a => `=== ${a.filePath} ===\n${a.answer}`).join('\n\n');
  const failedErrors = analyses.filter(a => !a.ok).map(a => `${a.filePath}: ${a.error}`);

  return {
    ok: true,
    success: true,
    filePath: okOnes[0].filePath,
    filePaths: okOnes.map(a => a.filePath),
    analyses: okOnes,
    description: stdout,
    answer: stdout,
    provider: okOnes[0].provider,
    elapsed,
    stdout,
    analyzedCount: okOnes.length,
    ...(inputErrors.length || failedErrors.length || truncated
      ? { partialErrors: [...inputErrors, ...failedErrors], truncated }
      : {}),
  };
}

/**
 * Generate an output contract for this skill's execution result.
 */
function getOutputContract(result) {
  if (!result) return null;

  const isSuccess = result.ok === true || result.success === true;

  return {
    skill: 'image.analyze',
    timestamp: Date.now(),
    success: isSuccess,
    summary: isSuccess
      ? `Image analysis completed (${result.provider || 'unknown'})${result.analyzedCount > 1 ? ` — ${result.analyzedCount} images` : ''}`
      : `Image analysis failed: ${result.error || 'Unknown error'}`,
    outputs: {
      analysis: { type: 'text', value: result.answer || result.description || '' },
      filePath: { type: 'text', value: result.filePath || '' },
      filePaths: { type: 'array', value: result.filePaths || [result.filePath].filter(Boolean) },
      provider: { type: 'text', value: result.provider || '' },
      confidence: { type: 'number', value: result.confidence || null }
    },
    error: isSuccess ? undefined : {
      message: result.error || 'Image analysis failed'
    }
  };
}

module.exports = { imageAnalyze, getOutputContract };
