'use strict';

/**
 * overlayControl.cjs
 *
 * Hides / shows the Electron overlay windows (ResultsWindow + PromptCapture)
 * before and after screenshotting so they don't appear in OmniParser or
 * vision LLM screenshots.
 *
 * Calls the overlay control HTTP server running in the Electron main process
 * on port 3010 (OVERLAY_CONTROL_PORT env var).
 */

const http = require('http');
const logger = require('../logger.cjs');

const OVERLAY_HOST = '127.0.0.1';
const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const OVERLAY_TIMEOUT_MS = 2000; // fast — local loopback only

function overlayRequest(action) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: OVERLAY_HOST,
        port: OVERLAY_PORT,
        path: `/overlay/${action}`,
        method: 'POST',
        timeout: OVERLAY_TIMEOUT_MS,
        headers: { 'Content-Length': '0' }
      },
      (res) => {
        res.resume(); // drain
        resolve(true);
      }
    );
    req.on('error', (err) => {
      logger.debug(`[overlayControl] ${action} failed (overlay server not running?)`, { error: err.message });
      resolve(false); // non-fatal — proceed without hiding
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/**
 * Hide overlay windows and wait for the OS to composite the frame.
 * Returns a restore function — call it after screenshotting.
 */
async function hideOverlay() {
  const hidden = await overlayRequest('hide');
  if (hidden) {
    // Give macOS one frame (~16ms) to remove the windows from the compositor
    await new Promise(r => setTimeout(r, 80));
  }
  return hidden;
}

/**
 * Show overlay windows again (restores to pre-hide visibility state).
 */
async function showOverlay() {
  await overlayRequest('show');
}

/**
 * Convenience wrapper: hide overlay, run fn(), show overlay, return result.
 * Always restores even if fn() throws.
 */
async function withOverlayHidden(fn) {
  const hidden = await hideOverlay();
  try {
    return await fn();
  } finally {
    if (hidden) await showOverlay();
  }
}

module.exports = { hideOverlay, showOverlay, withOverlayHidden };
