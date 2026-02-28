'use strict';

/**
 * screen.capture skill
 *
 * Takes a live screenshot via screen-intelligence-service and returns the
 * cleaned OCR text of the current screen. Use this when the user asks to:
 *   - "save what's on screen to a file"
 *   - "extract the information you see right now"
 *   - "read what's currently visible on the screen"
 *
 * This is OCR-based (Tesseract), not vision-LLM. It returns raw visible text.
 * For visual analysis / verification, use ui.screen.verify instead.
 *
 * Args:
 *   (none required)
 *
 * Returns:
 *   { success: true, text, appName, windowTitle, url, confidence, elapsed, stdout }
 *   { success: false, error: string }
 */

const http = require('http');
const logger = require('../logger.cjs');

const SCREEN_SERVICE_HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
const SCREEN_SERVICE_PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const DEFAULT_TIMEOUT = 20000;

function httpPost(host, port, urlPath, body, timeoutMs = 15000) {
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
      req.destroy(new Error(`screen.analyze timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function screenCapture(args = {}) {
  const timeoutMs = Math.min(60000, Math.max(5000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT, 10)));
  const startTime = Date.now();

  logger.info('[screen.capture] Capturing screen via screen-intelligence-service');

  try {
    const result = await httpPost(
      SCREEN_SERVICE_HOST,
      SCREEN_SERVICE_PORT,
      '/screen.analyze',
      {},
      timeoutMs
    );

    if (!result?.success) {
      return { success: false, error: result?.error || 'screen.analyze returned failure' };
    }

    const text = result.text || result.rawText || '';
    const elapsed = Date.now() - startTime;

    logger.info('[screen.capture] Done', {
      chars: text.length,
      confidence: result.confidence,
      app: result.appName,
      elapsed
    });

    return {
      success: true,
      text,
      appName: result.appName || null,
      windowTitle: result.windowTitle || null,
      url: result.url || null,
      confidence: result.confidence || null,
      elapsed,
      stdout: text,  // expose as stdout so synthesize can consume it via {{prev_stdout}}
    };
  } catch (err) {
    logger.error('[screen.capture] Failed', { error: err.message });
    return { success: false, error: `screen.capture failed: ${err.message}` };
  }
}

module.exports = { screenCapture };
