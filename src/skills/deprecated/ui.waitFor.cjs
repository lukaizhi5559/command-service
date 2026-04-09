'use strict';

/**
 * ui.waitFor skill
 *
 * Polls screen state until a condition is met or timeout expires.
 *
 * Each poll:
 *   1. Try memory.getRecentOcr (fast, no screenshot cost) — returns cached OCR
 *      from the background monitor if fresh enough (within maxAgeMs window).
 *   2. Fallback to screen.analyze (live screenshot + OCR) if cache miss or stale.
 *
 * All service call logic is self-contained here — no hidden indirection.
 *
 * Condition types (args.condition):
 *   - "text"        — OCR text contains args.value (case-insensitive substring)
 *   - "app"         — active appName matches args.value (case-insensitive contains)
 *   - "url"         — active browser URL contains args.value
 *   - "windowTitle" — active window title contains args.value (case-insensitive)
 *
 * Args:
 *   condition   {string}  Required. One of: text | app | url | windowTitle
 *   value       {string}  Required. The string to match against.
 *   pollMs      {number}  Polling interval in ms. Default: 2000. Min: 500.
 *   timeoutMs   {number}  Max wait time in ms. Default: 30000. Max: 300000.
 *   maxAgeMs    {number}  Max age of cached OCR to accept (ms). Default: pollMs + 1000.
 *                         Set to 0 to always force a live screen.analyze call.
 *
 * Returns:
 *   { success: true,  matched: true,  matchedOn, appName, windowTitle, url, text, elapsed }
 *   { success: false, matched: false, reason, elapsed }
 *   { success: false, error: string }
 */

const http = require('http');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEMORY_SERVICE_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const MEMORY_SERVICE_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const SCREEN_SERVICE_HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
const SCREEN_SERVICE_PORT = parseInt(process.env.SCREEN_SERVICE_PORT || '3008', 10);

const DEFAULT_POLL_MS    = 500;   // reduced from 2000 — app/url/windowTitle conditions are fast (no OCR)
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS     = 300000;
const MIN_POLL_MS        = 250;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpPost(host, port, path, body, timeoutMs = 8000) {
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
// Service calls
// ---------------------------------------------------------------------------

/**
 * Fast path: GET /screen.context — returns active window info (appName, windowTitle, url)
 * WITHOUT any screenshot or OCR. Used for condition=app|url|windowTitle.
 * Returns snapshot object or null on failure.
 */
async function getActiveWindowFast() {
  try {
    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: SCREEN_SERVICE_HOST,
        port: SCREEN_SERVICE_PORT,
        path: '/screen.context',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2' },
        timeout: 3000
      };
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('screen.context timeout')); });
      req.write('{}');
      req.end();
    });
    const win = result?.data?.windows?.[0];
    if (win) {
      return {
        appName:     win.appName     || 'unknown',
        windowTitle: win.title       || 'unknown',
        url:         win.url         || null,
        text:        '',
        fromCache:   false
      };
    }
    return null;
  } catch (err) {
    logger.debug('[ui.waitFor] screen.context failed', { error: err.message });
    return null;
  }
}

/**
 * Step 1: Try memory.getRecentOcr — returns cached OCR from the background
 * monitor if a capture exists within maxAgeSeconds. Free, no screenshot cost.
 * Returns snapshot object or null if unavailable/stale.
 */
async function getRecentOcr(maxAgeSeconds) {
  try {
    const res = await httpPost(
      MEMORY_SERVICE_HOST,
      MEMORY_SERVICE_PORT,
      '/memory.getRecentOcr',
      { payload: { maxAgeSeconds }, context: { userId: 'local_user' } },
      5000
    );
    const data = res?.result || res;
    if (data?.available && data?.capture) {
      const c = data.capture;
      return {
        appName:     c.appName     || 'unknown',
        windowTitle: c.windowTitle || 'unknown',
        url:         c.url         || null,
        text:        c.text        || '',
        fromCache:   true
      };
    }
    return null;
  } catch (err) {
    logger.debug('[ui.waitFor] memory.getRecentOcr unavailable, will use screen.analyze', { error: err.message });
    return null;
  }
}

/**
 * Step 2: Live screen.analyze — full screenshot + OCR via screen-intelligence service.
 * Returns snapshot object or null on failure.
 */
async function liveScreenAnalyze() {
  try {
    const res = await httpPost(
      SCREEN_SERVICE_HOST,
      SCREEN_SERVICE_PORT,
      '/screen.analyze',
      { payload: {} },
      15000
    );
    if (res?.success && res?.text) {
      return {
        appName:     res.appName     || 'unknown',
        windowTitle: res.windowTitle || 'unknown',
        url:         res.url         || null,
        text:        res.text,
        fromCache:   false
      };
    }
    return null;
  } catch (err) {
    logger.debug('[ui.waitFor] screen.analyze failed', { error: err.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Condition checker
// ---------------------------------------------------------------------------

/**
 * Check if a screen snapshot satisfies the condition.
 * Returns { matched: boolean, matchedOn: string|null }
 */
function checkCondition(snapshot, condition, value) {
  if (!snapshot) return { matched: false, matchedOn: null };

  const valueLower = value.toLowerCase();

  switch (condition) {
    case 'text': {
      const text = (snapshot.text || '').toLowerCase();
      const matched = text.includes(valueLower);
      return { matched, matchedOn: matched ? 'text' : null };
    }

    case 'app': {
      const appName = (snapshot.appName || '').toLowerCase();
      const matched = appName.includes(valueLower);
      return { matched, matchedOn: matched ? 'app' : null };
    }

    case 'url': {
      const url = (snapshot.url || '').toLowerCase();
      const matched = url.includes(valueLower);
      return { matched, matchedOn: matched ? 'url' : null };
    }

    case 'windowTitle': {
      const title = (snapshot.windowTitle || '').toLowerCase();
      const matched = title.includes(valueLower);
      return { matched, matchedOn: matched ? 'windowTitle' : null };
    }

    default:
      return { matched: false, matchedOn: null };
  }
}

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiWaitFor(args = {}) {
  const {
    condition,
    value,
  } = args;

  // Validate required args
  if (!condition) {
    return { success: false, error: 'condition is required (text | app | url | windowTitle)' };
  }
  if (!['text', 'app', 'url', 'windowTitle'].includes(condition)) {
    return { success: false, error: `Unknown condition "${condition}". Must be: text | app | url | windowTitle` };
  }
  if (!value) {
    return { success: false, error: 'value is required — the string to match against' };
  }

  const pollMs    = Math.max(MIN_POLL_MS, parseInt(args.pollMs    || DEFAULT_POLL_MS,    10));
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, parseInt(args.timeoutMs || DEFAULT_TIMEOUT_MS, 10)));
  // maxAgeMs: how stale a cached OCR is acceptable. Default = pollMs + 1s (so we accept captures from the last poll window)
  const maxAgeMs  = args.maxAgeMs !== undefined ? parseInt(args.maxAgeMs, 10) : (pollMs + 1000);
  const maxAgeSeconds = Math.ceil(maxAgeMs / 1000);

  logger.info('[ui.waitFor] Starting', { condition, value, pollMs, timeoutMs, maxAgeMs });

  const startTime = Date.now();
  let pollCount = 0;

  while (true) {
    const elapsed = Date.now() - startTime;

    if (elapsed >= timeoutMs) {
      logger.info('[ui.waitFor] Timed out', { condition, value, elapsed, pollCount });
      return {
        success: false,
        matched: false,
        reason: `Condition "${condition}=${value}" not met within ${timeoutMs}ms (${pollCount} polls)`,
        elapsed
      };
    }

    pollCount++;

    let snapshot;

    if (condition === 'app' || condition === 'url' || condition === 'windowTitle') {
      // Fast path: no OCR needed — just query active window info directly
      snapshot = await getActiveWindowFast();
      // Fallback to live analyze only if fast path fails
      if (!snapshot) snapshot = await liveScreenAnalyze();
    } else {
      // condition === 'text': needs OCR — try cache first, then live
      snapshot = maxAgeMs > 0 ? await getRecentOcr(maxAgeSeconds) : null;
      if (!snapshot) snapshot = await liveScreenAnalyze();
    }

    if (snapshot) {
      logger.debug('[ui.waitFor] Got snapshot', {
        poll: pollCount, fromCache: snapshot.fromCache,
        appName: snapshot.appName, url: snapshot.url || '—'
      });
    }

    // Check condition against snapshot
    if (snapshot) {
      const { matched, matchedOn } = checkCondition(snapshot, condition, value);
      if (matched) {
        const elapsed = Date.now() - startTime;
        logger.info('[ui.waitFor] Condition met', {
          condition, value, matchedOn, elapsed, pollCount,
          appName: snapshot.appName, url: snapshot.url || '—'
        });
        return {
          success: true,
          matched: true,
          matchedOn,
          condition,
          value,
          appName: snapshot.appName,
          windowTitle: snapshot.windowTitle,
          url: snapshot.url || null,
          text: snapshot.text,
          elapsed,
          pollCount
        };
      }

      logger.debug('[ui.waitFor] Condition not yet met', {
        poll: pollCount, condition, value,
        appName: snapshot.appName, url: snapshot.url || '—',
        textPreview: (snapshot.text || '').slice(0, 80)
      });
    } else {
      logger.debug('[ui.waitFor] No snapshot available this poll', { poll: pollCount });
    }

    // Wait before next poll
    const remaining = timeoutMs - (Date.now() - startTime);
    if (remaining <= 0) continue; // will exit at top of loop
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

module.exports = { uiWaitFor };
