'use strict';

/**
 * ui.screen.verify skill
 *
 * Takes a screenshot and asks a vision LLM to verify whether an automation
 * step succeeded. Calls POST /api/vision/verify on thinkdrop-backend.
 *
 * Provider fallback chain (handled by backend): GPT-4o → Claude → Gemini.
 *
 * Args:
 *   prompt          {string}  Required. What to verify — be specific about
 *                             what visual evidence to look for.
 *                             e.g. "Verify Chris Akers' DM is open — the chat
 *                             header should show 'chrisakers' or 'Chris Akers'"
 *   stepDescription {string}  Optional. Human-readable label for the step.
 *   timeoutMs       {number}  Max time for vision LLM call. Default: 30000.
 *
 * Returns:
 *   { success: true,  verified: true,  confidence, reasoning, suggestion, provider, elapsed }
 *   { success: true,  verified: false, confidence, reasoning, suggestion, provider, elapsed }
 *   { success: false, error: string }
 */

const http = require('http');
const logger = require('../logger.cjs');
const { hideOverlay, showOverlay } = require('./overlayControl.cjs');

const BACKEND_HOST    = process.env.THINKDROP_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT    = parseInt(process.env.THINKDROP_BACKEND_PORT || '4000', 10);
const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT     = 120000;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function httpPost(host, port, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: host,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from ${host}:${port}${path}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request to ${host}:${port}${path} timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Screenshot capture via nut-js (same as ui.findAndClick)
// ---------------------------------------------------------------------------

async function captureScreenshot() {
  const { screen } = require('@nut-tree-fork/nut-js');
  const image = await screen.grab();
  const Jimp = require('jimp');

  const { width, height, data } = image;

  const rgbaBuffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    rgbaBuffer[offset]     = data[offset + 2];
    rgbaBuffer[offset + 1] = data[offset + 1];
    rgbaBuffer[offset + 2] = data[offset];
    rgbaBuffer[offset + 3] = data[offset + 3];
  }

  let jimpImage = new Jimp({ data: rgbaBuffer, width, height });

  // Resize to max 1280px wide — reduces Retina screenshot payload ~4x
  const MAX_WIDTH = 1280;
  let resizedWidth = width;
  let resizedHeight = height;
  if (width > MAX_WIDTH) {
    resizedWidth = MAX_WIDTH;
    resizedHeight = Math.round(height * (MAX_WIDTH / width));
    jimpImage = jimpImage.resize(resizedWidth, resizedHeight);
  }

  const pngBuffer = await jimpImage.getBufferAsync(Jimp.MIME_PNG);

  return {
    base64: pngBuffer.toString('base64'),
    mimeType: 'image/png',
    width: resizedWidth,
    height: resizedHeight
  };
}

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiScreenVerify(args = {}) {
  const { prompt, stepDescription } = args;
  const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT, 10)));
  const settleMs  = Math.min(5000, Math.max(0, parseInt(args.settleMs || 0, 10)));

  if (!prompt) {
    return { success: false, error: 'prompt is required — describe what to verify visually' };
  }

  logger.info('[ui.screen.verify] Starting', { stepDescription, timeoutMs, settleMs });

  const startTime = Date.now();

  // Optional settle delay — let the UI finish animating/navigating before screenshotting
  if (settleMs > 0) {
    await new Promise(r => setTimeout(r, settleMs));
  }

  // Capture screenshot — hide overlay, screenshot, restore overlay immediately.
  // Do NOT keep overlay hidden during vision LLM call (that takes 5-10s).
  let screenshot;
  try {
    await hideOverlay();
    try {
      screenshot = await captureScreenshot();
    } finally {
      await showOverlay(); // restore immediately after screenshot, before vision LLM
    }
    logger.debug('[ui.screen.verify] Screenshot captured');
  } catch (err) {
    logger.error('[ui.screen.verify] Screenshot capture failed', { error: err.message });
    return { success: false, error: `Screenshot capture failed: ${err.message}` };
  }

  // Call backend vision verify
  let result;
  try {
    result = await httpPost(
      BACKEND_HOST,
      BACKEND_PORT,
      '/api/vision/verify',
      {
        screenshot: { base64: screenshot.base64, mimeType: screenshot.mimeType },
        prompt,
        stepDescription: stepDescription || prompt,
        context: {}
      },
      timeoutMs
    );
  } catch (err) {
    logger.warn('[ui.screen.verify] Vision verify call failed — returning degraded (skip verification)', { error: err.message });
    return {
      success: true,
      verified: null,
      confidence: 0,
      reasoning: `Vision check unavailable: ${err.message}`,
      suggestion: 'Vision unavailable — skipping verification',
      provider: 'none',
      elapsed: Date.now() - startTime,
      degraded: true
    };
  }

  if (!result?.success) {
    logger.warn('[ui.screen.verify] Vision API returned failure — returning degraded (skip verification)', { error: result?.error });
    return {
      success: true,
      verified: null,
      confidence: 0,
      reasoning: `Vision check failed: ${result?.error || 'unknown error'}`,
      suggestion: 'Vision unavailable — skipping verification',
      provider: 'none',
      elapsed: Date.now() - startTime,
      degraded: true
    };
  }

  const elapsed = Date.now() - startTime;

  logger.info('[ui.screen.verify] Done', {
    verified: result.verified,
    confidence: result.confidence,
    provider: result.provider,
    elapsed
  });

  return {
    success: true,
    verified: result.verified,
    confidence: result.confidence,
    reasoning: result.reasoning,
    suggestion: result.suggestion,
    provider: result.provider,
    elapsed
  };
}

module.exports = { uiScreenVerify };
