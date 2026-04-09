'use strict';

/**
 * ui.findAndClick skill
 *
 * Finds a UI element on screen by natural-language description and clicks it.
 *
 * Flow:
 *   1. Capture screenshot via nut-js screen.grab() → PNG buffer → base64
 *   2. Get screen dimensions (width/height) for OmniParser context
 *   3. POST to thinkdrop-backend /api/omniparser/detect with screenshot + description
 *      → returns { coordinates: {x, y}, confidence, selectedElement }
 *   4. Move mouse to coordinates + click (left/right/double)
 *
 * Args:
 *   label        {string}  Required. Natural-language description of the element to find.
 *                          e.g. "Submit button", "Search box", "Close icon", "File menu"
 *   button       {string}  Click button: "left" | "right" | "double". Default: "left"
 *   confidence   {number}  Minimum confidence threshold (0-1). Default: 0.3. Fail if below.
 *   timeoutMs    {number}  Max time for OmniParser call. Default: 60000. Max: 300000.
 *   app          {string}  Optional. Expected active app name (for context, not enforced).
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

const DEFAULT_TIMEOUT_MS   = 60000;
const MAX_TIMEOUT_MS       = 300000;
const MIN_CONFIDENCE       = 0.65;
const POST_CLICK_SETTLE_MS = 150; // brief pause after click for UI to react

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
// Screenshot capture via nut-js
// ---------------------------------------------------------------------------

async function captureScreenshot() {
  const { screen } = require('@nut-tree-fork/nut-js');

  // Grab full screen as nut-js Image object
  const image = await screen.grab();

  // nut-js Image has .data (raw BGRA/RGBA buffer), .width, .height, .pixelDensity
  // We need to encode as PNG base64. Use jimp (already in node_modules) to convert.
  const Jimp = require('jimp');

  const { width, height, data, pixelDensity } = image;

  // pixelDensity is the display scale factor (2.0 on Retina, 1.0 on standard).
  // OmniParser coordinates are in physical pixels (screenshot space).
  // nut-js mouse.move() expects logical pixels (points).
  // We must divide OmniParser coords by pixelDensity before clicking.
  const scale = (pixelDensity && pixelDensity.scaleX) ? pixelDensity.scaleX
    : (typeof pixelDensity === 'number' ? pixelDensity : 1);

  // nut-js returns raw BGRA data — convert to RGBA for jimp
  const rgbaBuffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    rgbaBuffer[offset]     = data[offset + 2]; // R (from B)
    rgbaBuffer[offset + 1] = data[offset + 1]; // G
    rgbaBuffer[offset + 2] = data[offset];     // B (from R)
    rgbaBuffer[offset + 3] = data[offset + 3]; // A
  }

  let jimpImage = new Jimp({ data: rgbaBuffer, width, height });

  // Resize to max 1280px wide before encoding — reduces a 2x Retina screenshot
  // from ~4.7MB base64 to ~1.2MB, cutting OmniParser transfer + inference time.
  // Track the resize ratio so OmniParser coordinates can be scaled back up.
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
    width: resizedWidth,    // actual dimensions of the encoded image sent to OmniParser
    height: resizedHeight,
    physicalWidth: width,   // original full-res dimensions (for reference)
    physicalHeight: height,
    pixelScale: scale,      // e.g. 2.0 on Retina — divide OmniParser coords by this
    resizeRatio             // OmniParser coords are in resized space; multiply by 1/resizeRatio to get physical, then divide by pixelScale for logical
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

  const result = await httpPost(
    BACKEND_HOST,
    BACKEND_PORT,
    '/api/omniparser/detect',
    body,
    timeoutMs
  );

  return result;
}

// ---------------------------------------------------------------------------
// Mouse click via nut-js
// ---------------------------------------------------------------------------

async function clickAt(x, y, button) {
  const { mouse, straightTo, Button } = require('@nut-tree-fork/nut-js');

  // Move mouse to target coordinates
  await mouse.move(straightTo({ x, y }));

  // Small settle pause
  await new Promise(resolve => setTimeout(resolve, POST_CLICK_SETTLE_MS));

  // Click
  switch (button) {
    case 'right':
      await mouse.rightClick();
      break;
    case 'double':
      await mouse.leftClick();
      await new Promise(resolve => setTimeout(resolve, 80));
      await mouse.leftClick();
      break;
    case 'left':
    default:
      await mouse.leftClick();
      break;
  }
}

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiFindAndClick(args = {}) {
  const { label, app } = args;
  const button     = args.button     || 'left';
  const minConf    = args.confidence !== undefined ? parseFloat(args.confidence) : MIN_CONFIDENCE;
  const timeoutMs  = Math.min(MAX_TIMEOUT_MS, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT_MS, 10)));
  const settleMs   = Math.min(5000, Math.max(0, parseInt(args.settleMs || 0, 10)));

  if (!label) {
    return { success: false, error: 'label is required — natural-language description of the element to find' };
  }
  if (!['left', 'right', 'double'].includes(button)) {
    return { success: false, error: `Unknown button "${button}". Must be: left | right | double` };
  }

  logger.info('[ui.findAndClick] Starting', { label, button, minConf, timeoutMs, settleMs });

  const startTime = Date.now();

  // Optional settle delay — let the UI finish animating after a previous click
  if (settleMs > 0) {
    logger.debug('[ui.findAndClick] Settling UI', { settleMs });
    await new Promise(r => setTimeout(r, settleMs));
  }

  // Capture window context BEFORE hiding the overlay — active-win must see the real
  // foreground app (Chrome, Slack, etc.), not the Electron overlay that steals focus.
  const windowContext = await getWindowContext();
  logger.debug('[ui.findAndClick] Window context', windowContext);

  // Step 1: Capture screenshot — hide overlay, screenshot, restore overlay immediately.
  // Do NOT keep overlay hidden during OmniParser call (that takes 15-20s).
  let screenshot;
  try {
    await hideOverlay();
    try {
      screenshot = await captureScreenshot();
    } finally {
      await showOverlay(); // restore immediately after screenshot, before OmniParser
    }
    logger.debug('[ui.findAndClick] Screenshot captured', { width: screenshot.width, height: screenshot.height, pixelScale: screenshot.pixelScale });
  } catch (err) {
    logger.error('[ui.findAndClick] Screenshot capture failed', { error: err.message });
    return { success: false, error: `Screenshot capture failed: ${err.message}` };
  }

  // Step 2: Detect element via OmniParser
  let detection;
  try {
    detection = await detectElement(label, screenshot, timeoutMs, windowContext);
  } catch (err) {
    logger.warn('[ui.findAndClick] OmniParser detect failed — requesting manual step', { error: err.message });
    return {
      success: false,
      needsManualStep: true,
      instruction: `Please ${button === 'double' ? 'double-click' : button + '-click'} "${label}" on screen, then confirm when done.`,
      reason: `OmniParser unavailable: ${err.message}`
    };
  }

  // OmniParser not configured (503) or element not found
  if (!detection?.success) {
    const msg = detection?.message || detection?.error || 'OmniParser returned no result';
    const isUnavailable = msg.toLowerCase().includes('not available') || msg.toLowerCase().includes('configure');
    logger.warn('[ui.findAndClick] Detection unsuccessful — requesting manual step', { label, msg });
    return {
      success: false,
      needsManualStep: true,
      instruction: `Please ${button === 'double' ? 'double-click' : button + '-click'} "${label}" on screen, then confirm when done.`,
      reason: isUnavailable ? 'OmniParser is not configured' : `Element not found: ${msg}`
    };
  }

  const { coordinates, confidence, selectedElement } = detection;

  // Coordinate conversion chain:
  //   OmniParser coords  →  in resized-image space (max 1280px wide)
  //   ÷ resizeRatio      →  physical pixels (full Retina resolution)
  //   ÷ pixelScale       →  logical pixels / points (what nut-js mouse.move expects)
  const pixelScale  = screenshot.pixelScale  || 1;
  const resizeRatio = screenshot.resizeRatio || 1;
  const logicalCoords = {
    x: Math.round((coordinates.x / resizeRatio) / pixelScale),
    y: Math.round((coordinates.y / resizeRatio) / pixelScale)
  };

  if (!coordinates?.x || !coordinates?.y) {
    return {
      success: false,
      needsManualStep: true,
      instruction: `Please ${button === 'double' ? 'double-click' : button + '-click'} "${label}" on screen, then confirm when done.`,
      reason: 'OmniParser returned no coordinates'
    };
  }

  if (confidence < minConf) {
    const reason = `Low confidence: ${(confidence * 100).toFixed(0)}% (threshold ${(minConf * 100).toFixed(0)}%)`;
    logger.warn('[ui.findAndClick] Confidence below threshold — requesting manual step', { label, confidence, minConf });
    return {
      success: false,
      needsManualStep: true,
      error: reason,
      instruction: `Please ${button === 'double' ? 'double-click' : button + '-click'} "${label}" on screen, then confirm when done.`,
      reason,
      coordinates,
      confidence,
      selectedElement
    };
  }

  logger.info('[ui.findAndClick] Element detected', {
    label, selectedElement,
    omniCoords: coordinates,
    logicalCoords,
    pixelScale,
    resizeRatio,
    confidence: confidence.toFixed(3)
  });

  // Step 3: Click at logical (point) coordinates — nut-js uses logical pixels
  try {
    await clickAt(logicalCoords.x, logicalCoords.y, button);
  } catch (err) {
    logger.error('[ui.findAndClick] Mouse click failed', { error: err.message });
    return { success: false, error: `Mouse click failed: ${err.message}`, coordinates: logicalCoords, confidence, selectedElement };
  }

  const elapsed = Date.now() - startTime;

  logger.info('[ui.findAndClick] Done', { label, button, logicalCoords, pixelScale, confidence, elapsed });

  return {
    success: true,
    x: logicalCoords.x,
    y: logicalCoords.y,
    confidence,
    selectedElement,
    button,
    pixelScale,
    elapsed
  };
}

module.exports = { uiFindAndClick };
