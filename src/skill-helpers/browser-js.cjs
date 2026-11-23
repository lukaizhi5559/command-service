'use strict';

// ---------------------------------------------------------------------------
// browser-js.cjs — evaluate JS in the frontmost browser tab via AppleScript.
//
// Canvas-surface truth: Google Sheets/Docs render content on canvas — OCR
// can't read cells — but the page exposes DOM oracles (the Sheets name box
// #t-name-box, the Docs title). Requires Chrome's "View ▸ Developer ▸ Allow
// JavaScript from Apple Events"; a failure returns null so callers fall back
// to OCR/AX lanes instead of breaking.
// ---------------------------------------------------------------------------

const { execFile } = require('child_process');
const logger = require('../logger.cjs');

/**
 * browserJs(app, code) → string result | null.
 * code runs as the javascript body — the LAST expression's value returns.
 * Keep code single-expression-friendly and short; embedded double quotes are
 * escaped for the AppleScript string literal.
 */
function browserJs(app, code, timeoutMs = 6000) {
  if (!app || !code) return Promise.resolve(null);
  const esc = String(code).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile('osascript', ['-e',
      `tell application "${app}" to execute front window's active tab javascript "${esc}"`],
      { timeout: timeoutMs },
      (e, o, se) => {
        if (e) {
          if (se) logger.warn(`[browser-js] ${String(se).slice(0, 120)}`);
          resolve(null);
        } else resolve(String(o || '').trim());
      });
  });
}

module.exports = { browserJs };
