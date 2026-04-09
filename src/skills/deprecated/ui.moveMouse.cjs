'use strict';

/**
 * ui.moveMouse skill
 *
 * Moves the mouse to a UI element on screen by natural-language description,
 * WITHOUT clicking. Useful for hover-to-reveal patterns where hovering over
 * an element makes hidden controls, tooltips, or menus visible before clicking.
 *
 * Flow:
 *   1. Capture screenshot via nut-js screen.grab() → PNG buffer → base64
 *   2. POST to thinkdrop-backend /api/omniparser/detect with screenshot + description
 *      → returns { coordinates: {x, y}, confidence, selectedElement }
 *   3. Move mouse to coordinates (no click)
 *   4. Optional: wait settleMs for hover effects to appear
 *
 * Args:
 *   label        {string}  Required. Natural-language description of the element to hover.
 *                          e.g. "chrisakers row in the DMs list", "File menu item"
 *   settleMs     {number}  Milliseconds to wait AFTER moving the mouse (for hover effects).
 *                          Default: 500. Use 800-1500 for slow hover animations.
 *   confidence   {number}  Minimum confidence threshold (0-1). Default: 0.3.
 *   timeoutMs    {number}  Max time for OmniParser call. Default: 60000.
 *
 * Returns:
 *   { success: true,  x, y, confidence, selectedElement, elapsed }
 *   { success: false, error: string }
 */

const http = require('http');
const logger = require('../logger.cjs');
const { hideOverlay, showOverlay } = require('./overlayControl.cjs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKEND_HOST = process.env.THINKDROP_BACKEND_HOST || '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.THINKDROP_BACKEND_PORT || '4000', 10);

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS     = 300000;
const MIN_CONFIDENCE     = 0.3;
const DEFAULT_SETTLE_MS  = 500;

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

  const { width, height, data, pixelDensity } = image;
  const scale = (pixelDensity && pixelDensity.scaleX) ? pixelDensity.scaleX
    : (typeof pixelDensity === 'number' ? pixelDensity : 1);

  const rgbaBuffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    rgbaBuffer[offset]     = data[offset + 2];
    rgbaBuffer[offset + 1] = data[offset + 1];
    rgbaBuffer[offset + 2] = data[offset];
    rgbaBuffer[offset + 3] = data[offset + 3];
  }

  let jimpImage = new Jimp({ data: rgbaBuffer, width, height });

  const MAX_WIDTH = 1280;
  let resizedWidth = width;
  let resizedHeight = height;
  let resizeRatio = 1;
  if (width > MAX_WIDTH) {
    resizeRatio = MAX_WIDTH / width;
    resizedWidth = MAX_WIDTH;
    resizedHeight = Math.round(height * resizeRatio);
    jimpImage = jimpImage.resize(resizedWidth, resizedHeight);
  }

  const pngBuffer = await jimpImage.getBufferAsync(Jimp.MIME_PNG);

  return {
    base64: pngBuffer.toString('base64'),
    mimeType: 'image/png',
    width: resizedWidth,
    height: resizedHeight,
    physicalWidth: width,
    physicalHeight: height,
    pixelScale: scale,
    resizeRatio
  };
}

// ---------------------------------------------------------------------------
// Window context for cache key
// ---------------------------------------------------------------------------

async function getWindowContext() {
  try {
    const { activeWindow } = await import('active-win');
    const win = await activeWindow();
    return {
      windowTitle: win?.title || '',
      activeApp: win?.owner?.name || '',
    };
  } catch (_) {
    return { windowTitle: '', activeApp: '' };
  }
}

// ---------------------------------------------------------------------------
// OmniParser detect call
// ---------------------------------------------------------------------------

function inferIntentType(description) {
  const d = description.toLowerCase();
  if (/\b(folder|file|icon|desktop|drive|disk)\b/.test(d)) return 'desktop_folder';
  if (/\b(input|text field|search box|search field|type here|enter text)\b/.test(d)) return 'type_text';
  if (/\b(address bar|url|navigate|browser)\b/.test(d)) return 'browser_navigation';
  if (/\b(spotlight|search result|finder result)\b/.test(d)) return 'spotlight_search';
  return undefined;
}

async function detectElement(description, screenshot, timeoutMs, windowContext) {
  const intentType = inferIntentType(description);
  const { windowTitle, activeApp } = windowContext || {};
  const body = {
    screenshot: {
      base64: screenshot.base64,
      mimeType: screenshot.mimeType
    },
    description,
    context: {
      screenWidth: screenshot.width,
      screenHeight: screenshot.height,
      screenshotWidth: screenshot.width,
      screenshotHeight: screenshot.height,
      ...(windowTitle && { windowTitle }),
      ...(activeApp && { activeApp }),
      ...(intentType && { intentType })
    }
  };

  return httpPost(BACKEND_HOST, BACKEND_PORT, '/api/omniparser/detect', body, timeoutMs);
}

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiMoveMouse(args = {}) {
  const { label } = args;
  const settleMs  = Math.min(5000, Math.max(0, parseInt(args.settleMs  ?? DEFAULT_SETTLE_MS,  10)));
  const minConf   = args.confidence !== undefined ? parseFloat(args.confidence) : MIN_CONFIDENCE;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT_MS, 10)));

  if (!label) {
    return { success: false, error: 'label is required — natural-language description of the element to hover over' };
  }

  logger.info('[ui.moveMouse] Starting', { label, settleMs, minConf, timeoutMs });

  const startTime = Date.now();

  // Capture window context BEFORE hiding the overlay — once the overlay hides,
  // the Electron window may steal focus and active-win returns 'Electron' instead
  // of the real foreground app (Chrome, Slack, etc.), producing cache key 'unknown'.
  const windowContext = await getWindowContext();
  logger.debug('[ui.moveMouse] Window context', windowContext);

  // Step 1: Capture screenshot (hide overlay so it doesn't appear in the image)
  let screenshot;
  try {
    await hideOverlay();
    try {
      screenshot = await captureScreenshot();
    } finally {
      await showOverlay();
    }
    logger.debug('[ui.moveMouse] Screenshot captured', { width: screenshot.width, height: screenshot.height, pixelScale: screenshot.pixelScale });
  } catch (err) {
    logger.error('[ui.moveMouse] Screenshot capture failed', { error: err.message });
    return { success: false, error: `Screenshot capture failed: ${err.message}` };
  }

  // Step 2: Detect element via OmniParser (cache hit skips the API call on the backend)
  let detection;
  try {
    detection = await detectElement(label, screenshot, timeoutMs, windowContext);
  } catch (err) {
    logger.warn('[ui.moveMouse] OmniParser detect failed', { error: err.message });
    return { success: false, error: `OmniParser unavailable: ${err.message}` };
  }

  if (!detection?.success) {
    const msg = detection?.message || detection?.error || 'OmniParser returned no result';
    logger.warn('[ui.moveMouse] Detection unsuccessful', { label, msg });
    return { success: false, error: `Element not found: ${msg}` };
  }

  const { coordinates, confidence, selectedElement, cacheHit } = detection;

  if (!coordinates?.x || !coordinates?.y) {
    return { success: false, error: 'OmniParser returned no coordinates' };
  }

  if (confidence < minConf) {
    logger.warn('[ui.moveMouse] Confidence below threshold', { label, confidence, minConf });
    return { success: false, error: `Low confidence: ${(confidence * 100).toFixed(0)}% (threshold ${(minConf * 100).toFixed(0)}%)`, coordinates, confidence };
  }

  // Coordinate conversion: resized-image space → physical pixels → logical points.
  // Backend bbox is in [0..screenshotWidth] space (resized physical pixels, MAX_WIDTH=1280).
  // Same formula applies on both cache hit and miss — the stored screenshotWidth is always
  // 1280 (the resized width we sent), so resizeRatio and pixelScale are stable.
  const pixelScale  = screenshot.pixelScale  || 1;
  const resizeRatio = screenshot.resizeRatio || 1;
  const logicalCoords = {
    x: Math.round((coordinates.x / resizeRatio) / pixelScale),
    y: Math.round((coordinates.y / resizeRatio) / pixelScale)
  };

  logger.info('[ui.moveMouse] Element detected, moving mouse', {
    label, selectedElement, cacheHit: !!cacheHit,
    omniCoords: coordinates,
    logicalCoords,
    pixelScale,
    resizeRatio,
    confidence: confidence.toFixed(3)
  });

  // Step 3: Move mouse (no click)
  try {
    const { mouse, straightTo } = require('@nut-tree-fork/nut-js');
    await mouse.move(straightTo({ x: logicalCoords.x, y: logicalCoords.y }));
  } catch (err) {
    logger.error('[ui.moveMouse] Mouse move failed', { error: err.message });
    return { success: false, error: `Mouse move failed: ${err.message}`, coordinates: logicalCoords, confidence, selectedElement };
  }

  // Step 4: Wait for hover effects to appear
  if (settleMs > 0) {
    await new Promise(r => setTimeout(r, settleMs));
  }

  const elapsed = Date.now() - startTime;
  logger.info('[ui.moveMouse] Done', { label, logicalCoords, confidence, cacheHit: !!cacheHit, elapsed });

  return {
    success: true,
    x: logicalCoords.x,
    y: logicalCoords.y,
    confidence,
    selectedElement,
    cacheHit: !!cacheHit,
    elapsed
  };
}

module.exports = { uiMoveMouse };
