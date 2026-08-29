'use strict';

/**
 * skill: browser.act
 *
 * Hybrid browser automation — engine-first via Playwright Node API, with
 * playwright-cli as a fallback for sessions not owned by the engine.
 *
 * Engine: Playwright Node API (browser-engine.cjs) — primary driver.
 *   Sessions: engine.launch() keeps a browser context alive between calls.
 *   Snapshot: ariaSnapshot() with numbered refs (e1, e21, …)
 *             used for ref-based click/fill/hover/select via getByRole().
 *   Refs: resolved through _engineSnapshots refMap, bound to snapshot generation.
 *
 * CLI fallback: playwright-cli subprocess — only for sessions NOT owned by engine.
 *   Binary: /opt/homebrew/bin/playwright-cli  (brew install playwright-cli)
 *   Sessions: -s=<sessionId> keeps a browser alive between calls.
 *
 * Actions supported:
 *   navigate | goto | back | forward | reload | close | snapshot
 *   click | dblclick | fill | type | hover | select | check | uncheck | upload
 *   reactFill | clickByText | clickBySelector  (injection-first, React-aware)
 *   keyboard | press | scroll | screenshot | pdf
 *   getText | getPageText | evaluate | scanCurrentPage
 *   waitForSelector | waitForContent | waitForStableText
 *   tab-new | tab-list | tab-close | tab-select
 *   state-save | state-load | resize
 *   paste | pasteAttachment
 *
 * Args schema:
 * {
 *   action:     string   — action name
 *   sessionId:  string   — browser session id (default: 'default')
 *   url:        string   — URL for navigate/goto
 *   selector:   string   — element ref (e1, e21) or label to resolve via snapshot
 *   text:       string   — text to type/fill
 *   key:        string   — key for keyboard/press actions
 *   value:      string   — option value for select
 *   dx:         number   — horizontal scroll delta
 *   dy:         number   — vertical scroll delta
 *   width:      number   — width for resize
 *   height:     number   — height for resize
 *   filePath:   string   — path for screenshot/pdf/state-save/state-load
 *   headed:     boolean  — show browser window (default: true)
 *   timeoutMs:  number   — per-action timeout ms (default: 15000)
 * }
 *
 * Returns: { ok, action, sessionId, result?, stdout?, error?, executionTime }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn, exec } = require('child_process');
const logger = require('../logger.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const shellRun = require('./shell.run.cjs');
const { buildAdBlockScript } = require('../utils/ad-block-init.js');
const { BASELINE_DOMAINS } = require('../utils/ad-block-updater.cjs');
const { setupInterception, clearAdBlockSession } = require('../utils/ad-block-network.cjs');
const engine = require('./browser-engine.cjs');

// ── LiteParse CLI resolution (for clickByText coordinate fallback) ──
const _LIT_CANDIDATES = [
  '/opt/homebrew/bin/lit',
  '/usr/local/bin/lit',
  path.join(os.homedir(), '.npm-global', 'bin', 'lit'),
  path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'lit'),
];
function _findLitCli() {
  for (const c of _LIT_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  try { exec('which lit', { timeout: 3000, stdio: 'pipe' }); return 'lit'; } catch (_) {}
  return null;
}
let _LIT_BIN = _findLitCli();

// ── CSS selector sanitizer ──────────────────────────────────────────────────
// Fixes selectors like button[aria-label='God's Not Dead'] where the single
// quote inside the attribute value breaks the CSS parser. Rewrites
// attr='value with ' inside' to attr="value with ' inside" (and escapes any
// inner double quotes). Also handles the reverse case (double-quote wrapper
// with inner double quotes).
function _sanitizeCssSelector(sel) {
  if (!sel || typeof sel !== 'string') return sel;
  // Match attr='...' patterns. The value may contain embedded single quotes,
  // so we use non-greedy .+? to match up to the LAST ' before ].
  // This handles: [aria-label='God's Not Dead'] → value = "God's Not Dead"
  // Edge case: multiple attributes in one selector may mismatch, but LLM-generated
  // selectors for our use case are typically single-attribute.
  let _out = sel.replace(/\[([\w-]+)='(.+?)'\]/g, (match, attr, value) => {
    // If the value contains a single quote, rewrite using double quotes as wrapper
    if (value.includes("'")) {
      const _escaped = value.replace(/"/g, '\\"');
      return `[${attr}="${_escaped}"]`;
    }
    return match;
  });
  // Same for double-quote wrappers with inner double quotes
  _out = _out.replace(/\[([\w-]+)="(.+?)"\]/g, (match, attr, value) => {
    if (value.includes('"')) {
      const _escaped = value.replace(/'/g, "\\'");
      return `[${attr}='${_escaped}"]`;
    }
    return match;
  });
  return _out;
}


// LiteParser coordinate fallback for clickByText:
// When DOM-based clickByText fails (shadow DOM, zero-size elements, etc.),
// take a screenshot, run LiteParse to find text items with bounding boxes,
// and click at the center coordinates. This is deterministic — LiteParse
// sees what the user sees, bypassing all CSS/shadow DOM visibility issues.
async function _clickByTextViaLiteParse(page, targetText, exact) {
  if (!_LIT_BIN) {
    // Try to find it again (may have been installed since module load)
    _LIT_BIN = _findLitCli();
    if (!_LIT_BIN) return { ok: false, error: 'LiteParse CLI not available' };
  }
  const _screenshotPath = path.join(os.tmpdir(), `clickbytext_${Date.now()}.png`);
  try { await page.screenshot({ path: _screenshotPath, fullPage: false }); }
  catch (e) { return { ok: false, error: `screenshot failed: ${e.message}` }; }

  const _outputPath = path.join(os.tmpdir(), `litparse_${Date.now()}.json`);
  return new Promise((resolve) => {
    const lit = spawn(_LIT_BIN, ['parse', _screenshotPath, '--format', 'json', '-o', _outputPath], { timeout: 30000 });
    let stderr = '';
    lit.stderr.on('data', (d) => { stderr += d.toString(); });
    lit.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(_screenshotPath); } catch (_) {}
        resolve({ ok: false, error: `LiteParse exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        if (!fs.existsSync(_outputPath)) { resolve({ ok: false, error: 'LiteParse output not created' }); return; }
        const output = JSON.parse(fs.readFileSync(_outputPath, 'utf8'));
        const textItems = [];
        const _rawItems = output.pages?.[0]?.textItems || output.texts || [];
        for (const item of _rawItems) {
          if (!item.text) continue;
          if (item.x !== undefined && item.y !== undefined) {
            textItems.push({ text: item.text, x: item.x || 0, y: item.y || 0, width: item.width || 0, height: item.height || 0 });
          } else if (item.prov && item.prov[0] && item.prov[0].bbox) {
            const b = item.prov[0].bbox;
            textItems.push({ text: item.text, x: b.l, y: b.t, width: b.r - b.l, height: b.b - b.t });
          }
        }
        // Get screenshot dimensions for scaling
        let imgW = 1280, imgH = 800;
        try {
          const { PNG } = require('pngjs');
          const png = PNG.sync.read(fs.readFileSync(_screenshotPath));
          imgW = png.width; imgH = png.height;
        } catch (_) {}
        try { fs.unlinkSync(_screenshotPath); fs.unlinkSync(_outputPath); } catch (_) {}

        // Find best match for target text
        const lower = targetText.toLowerCase();
        const matches = [];
        for (const item of textItems) {
          const it = (item.text || '').trim().toLowerCase();
          if (!it) continue;
          const isExact = it === lower;
          const isSub = it.includes(lower) || lower.includes(it);
          if (exact ? isExact : isSub) {
            matches.push({ ...item, isExact, len: it.length, fuzzy: false, distance: 0 });
          }
        }
        // Fuzzy matching fallback: if no exact/substring matches, try Levenshtein
        // Handles OCR misreads like "Save" → "sve" (distance=1)
        if (matches.length === 0 && lower.length <= 30) {
          for (const item of textItems) {
            const it = (item.text || '').trim().toLowerCase();
            if (!it || it.length > 30) continue;
            // Levenshtein distance for short strings
            const m = lower.length, n = it.length;
            if (Math.abs(m - n) > 2) continue; // can't be within distance 2
            const dp = Array(n + 1).fill(0).map((_, i) => i);
            for (let i = 1; i <= m; i++) {
              let prev = dp[0]; dp[0] = i;
              for (let j = 1; j <= n; j++) {
                const tmp = dp[j];
                dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (lower[i - 1] === it[j - 1] ? 0 : 1));
                prev = tmp;
              }
            }
            const dist = dp[n];
            if (dist <= 2 && dist > 0) {
              matches.push({ ...item, isExact: false, len: it.length, fuzzy: true, distance: dist });
            }
          }
          if (matches.length > 0) {
            logger.info(`[browser.act] clickByText LiteParse: fuzzy match found for "${targetText}" (${matches.length} candidates)`);
          }
        }
        if (matches.length === 0) { resolve({ ok: false, error: `LiteParse: no text match for "${targetText}"` }); return; }
        // Sort: exact first, then non-fuzzy, then shortest, then lowest distance
        matches.sort((a, b) => {
          if (a.isExact !== b.isExact) return b.isExact - a.isExact;
          if (a.fuzzy !== b.fuzzy) return a.fuzzy ? 1 : -1; // non-fuzzy before fuzzy
          if (a.fuzzy && b.fuzzy) return a.distance - b.distance; // lower distance first
          return a.len - b.len;
        });
        const best = matches[0];
        // Scale from screenshot coords to viewport coords
        const vpW = page.viewportSize()?.width || 1280;
        const vpH = page.viewportSize()?.height || 800;
        const scaleX = vpW / imgW;
        const scaleY = vpH / imgH;
        const clickX = Math.round((best.x + best.width / 2) * scaleX);
        const clickY = Math.round((best.y + best.height / 2) * scaleY);
        logger.info(`[browser.act] clickByText LiteParse fallback: clicking "${best.text}" at (${clickX}, ${clickY}) (scaled from ${best.x + best.width / 2},${best.y + best.height / 2} scaleX=${scaleX.toFixed(2)} scaleY=${scaleY.toFixed(2)})`);
        page.mouse.click(clickX, clickY).then(() => {
          resolve({ ok: true, clickedText: best.text, x: clickX, y: clickY, matchCount: matches.length });
        }).catch((e) => {
          resolve({ ok: false, error: `LiteParse click failed: ${e.message}` });
        });
      } catch (e) {
        try { fs.unlinkSync(_screenshotPath); fs.unlinkSync(_outputPath); } catch (_) {}
        resolve({ ok: false, error: `LiteParse parse error: ${e.message}` });
      }
    });
    lit.on('error', () => resolve({ ok: false, error: 'LiteParse spawn failed' }));
  });
}

// Build the ad-block script once at module load.
// Use only BASELINE_DOMAINS (~30 top ad networks) — NOT the full 46K cached list.
// The full list inflates the script to ~971KB which exceeds macOS ARG_MAX when
// passed as a spawn() arg, causing silent injection failure. BASELINE_DOMAINS
// covers doubleclick, googlesyndication, taboola, criteo etc. — the vast majority
// of ads on any site. Script size: ~3KB.
const _AD_BLOCK_SCRIPT = buildAdBlockScript(BASELINE_DOMAINS);

// Write the ad-block script to a stable temp file so injectAdBlock can read it
// via a short inline eval rather than passing ~4KB as a CLI arg (avoids quoting issues).
const _AD_BLOCK_SCRIPT_FILE = path.join(os.tmpdir(), 'td-adblock.js');
try {
  fs.writeFileSync(_AD_BLOCK_SCRIPT_FILE, _AD_BLOCK_SCRIPT, 'utf8');
  logger.info(`[browser.act] Ad-block script written to ${_AD_BLOCK_SCRIPT_FILE} (${_AD_BLOCK_SCRIPT.length} chars)`);
} catch (e) {
  logger.warn(`[browser.act] Could not write ad-block script file: ${e.message}`);
}

// ── Auth-cookie sniffing via CDP (Chrome DevTools Protocol) ──────────────────
// Used by waitForAuth (interactive login wait) and the browser.agent preflight
// probe to auto-detect that the user has signed in, so the manual "I've signed
// in" button is rarely needed. Reads HttpOnly session cookies that document.cookie
// cannot see. Only the Playwright engine path exposes CDP; the CLI fallback path
// returns { ok: false } and existing heuristics + the manual button remain.

// Cookie-name stems that strongly indicate an authenticated session.
// Matched as a case-insensitive substring — real cookie names embed stems in
// varied ways (connect.sid, __Secure-1PSIDTS, sessionid, JWT_TOKEN) so we rely
// on the exclude list + httpOnly/strong-name gate for false-positive control.
const _AUTH_COOKIE_NAME_RE = /(sid|sess|session|token|jwt|auth|login|user|acct|account|remember|passport|phpsessid|jsessionid|sails\.sid|koa:sess)/i;
// Cookies that look auth-like but are NOT authentication (pre-auth / analytics /
// prefs). Excluded even when their name matches an auth stem.
const _AUTH_COOKIE_EXCLUDE_RE = /(csrf|xsrf|locale|lang|theme|mode|guest|anonymous|_ga|_gid|_gat|ab[_-]?test|opt[_-]?out|consent|cookie[_-]?consent|pref|currency|cart|wishlist|recently[_-]?viewed|server|route|sticky|hsession|gdpr|ccpa|euconsent|visitor|anon|feature[_-]?flag)/i;
// Strong session indicators — a cookie counts as an auth signal only if it is
// non-empty AND (httpOnly === true OR its name matches this pattern).
const _STRONG_SESSION_NAME_RE = /(sid|sess|session|token|jwt|auth)/i;

// Pure classifier — unit-testable without a browser.
// cookies: array of { name, value, domain, httpOnly, ... } (CDP/Playwright shape)
// targetDomain: e.g. 'slack.com' (leading 'www.' stripped by caller)
// Returns: { authed: boolean, cookies: string[], reason: string }
function _classifyAuthCookies(cookies, targetDomain) {
  if (!Array.isArray(cookies) || !targetDomain) return { authed: false, cookies: [], reason: 'no-input' };
  const target = targetDomain.toLowerCase().replace(/^www\./, '');
  const matched = [];
  for (const c of cookies) {
    if (!c || typeof c.name !== 'string') continue;
    const name = c.name;
    if (!c.value) continue;                       // empty value → not a live session
    if (_AUTH_COOKIE_EXCLUDE_RE.test(name)) continue;
    // Domain filter: cookie domain '.slack.com' matches target 'slack.com' and
    // any subdomain; exact 'slack.com' also matches. Subdomain-only cookies
    // (e.g. domain='app.slack.com' when target='slack.com') are still relevant
    // because the browser is on that subdomain during auth.
    const cDomain = String(c.domain || '').toLowerCase().replace(/^\./, '');
    if (cDomain && cDomain !== target && !cDomain.endsWith(`.${target}`) && !target.endsWith(`.${cDomain}`)) {
      // Allow when the cookie domain is a subdomain of the target (common during
      // auth flows that set the session cookie on the app subdomain).
      continue;
    }
    const isHttpOnly = c.httpOnly === true;
    const isStrongName = _STRONG_SESSION_NAME_RE.test(name);
    // HttpOnly cookies are universally server-set session/auth state — JS cannot
    // read them, so analytics/tracking cookies are never HttpOnly. Trust HttpOnly
    // as an auth signal regardless of name (e.g. Spotify's sp_dc, Slack's d).
    // Non-HttpOnly cookies must match a strong session-name stem to avoid counting
    // analytics/prefs cookies that happen to be on the target domain.
    if (isHttpOnly) {
      matched.push(name);
    } else if (isStrongName && _AUTH_COOKIE_NAME_RE.test(name)) {
      matched.push(name);
    }
  }
  if (matched.length === 0) return { authed: false, cookies: [], reason: 'no-auth-cookies' };
  return { authed: true, cookies: matched, reason: `auth-cookies:${matched.join(',')}` };
}

// Per-page CDP session cache for cookie sniffing (WeakMap so it GCs with the page).
const _cookieSniffCdpSessions = new WeakMap();

// Sniff auth cookies via CDP. Never throws.
// engine: the browser-engine module (required at top of file)
// sessionId, page: the active Playwright page
// targetDomain: e.g. 'slack.com'
// Returns: { ok, authed, cookies, reason } — ok:false means CDP unavailable
// (CLI path or browser blocks CDP); caller falls back to existing heuristics.
async function _sniffAuthCookies(engine, sessionId, page, targetDomain) {
  if (!page || !targetDomain) return { ok: false, authed: false, cookies: [], reason: 'missing-args' };
  const ctx = engine && typeof engine.getContext === 'function' ? engine.getContext(sessionId) : null;
  if (!ctx) return { ok: false, authed: false, cookies: [], reason: 'no-engine-context' };
  let cdp = _cookieSniffCdpSessions.get(page);
  try {
    if (!cdp) {
      cdp = await ctx.newCDPSession(page);
      _cookieSniffCdpSessions.set(page, cdp);
    }
    let cookies = null;
    // Network.getCookies is deprecated in newer Chrome → fall back to Storage.getCookies.
    try {
      const res = await cdp.send('Network.getCookies');
      cookies = res && Array.isArray(res.cookies) ? res.cookies : null;
    } catch (_) {
      const res2 = await cdp.send('Storage.getCookies');
      cookies = res2 && Array.isArray(res2.cookies) ? res2.cookies : null;
    }
    if (!cookies) return { ok: false, authed: false, cookies: [], reason: 'no-cookies-returned' };
    const cls = _classifyAuthCookies(cookies, targetDomain);
    return { ok: true, ...cls };
  } catch (err) {
    return { ok: false, authed: false, cookies: [], reason: `cdp-error:${(err && err.message) || 'unknown'}` };
  }
}

// Detach a cached CDP sniff session for a page (call on waitForAuth exit).
function _detachCookieSniffCdp(page) {
  if (!page) return;
  const cdp = _cookieSniffCdpSessions.get(page);
  if (cdp) {
    _cookieSniffCdpSessions.delete(page);
    try { cdp.detach(); } catch (_) {}
  }
}

// Generic debugging control for all browser automation tools
const playwrightDebugEnabled = process.env.PLAYWRIGHT_DEBUG === 'true' ||
                              process.env.PLAYWRIGHT_DEBUG === 'on' ||
                              process.env.PLAYWRIGHT_DEBUG === '1';

function shouldEnableDebugging(sessionId, action = null) {
  // Generic debugging control for all sessions and agents
  return playwrightDebugEnabled;
}

function getDebugConfig(sessionId, action) {
  const baseConfig = {
    console: playwrightDebugEnabled,
    network: playwrightDebugEnabled,
    tracing: playwrightDebugEnabled,
    video: playwrightDebugEnabled,
    devTools: playwrightDebugEnabled
  };
  
  // Agent-specific adjustments can be added here if needed
  return baseConfig;
}

// ---------------------------------------------------------------------------
// Debugging Tracing Infrastructure
// ---------------------------------------------------------------------------

// Track active debugging sessions
const debuggingSessions = new Map(); // sessionId -> debug data

// Debug data structure for each session
function createDebugSession(sessionId) {
  return {
    sessionId,
    startTime: Date.now(),
    tracingActive: false,
    videoActive: false,
    devToolsActive: false,
    traceFile: null,
    videoFile: null,
    devToolsUrl: null,
    snapshots: [],
    networkErrors: [],
    consoleErrors: [],
    actionHistory: [],
    devToolsData: {
      networkRequests: [],
      consoleLogs: [],
      performanceMetrics: {}
    }
  };
}

// Start debugging tracing for a session
async function startSessionTracing(sessionId) {
  if (!shouldEnableDebugging(sessionId)) {
    logger.debug(`[browser.act] Debugging disabled for ${sessionId} (PLAYWRIGHT_DEBUG=${process.env.PLAYWRIGHT_DEBUG})`);
    return;
  }
  
  if (debuggingSessions.has(sessionId)) {
    logger.debug(`[browser.act] Debugging session already exists for ${sessionId}`);
    return;
  }

  const debugSession = {
    sessionId,
    startTime: Date.now(),
    tracingActive: false,
    videoActive: false,
    devToolsActive: false,
    devToolsUrl: null,
    traceFile: null,
    videoFile: null,
    snapshots: [],
    networkErrors: [],
    consoleErrors: [],
    actionHistory: [],
    devToolsData: {
      networkRequests: [],
      consoleLogs: [],
      performanceMetrics: {}
    }
  };

  debuggingSessions.set(sessionId, debugSession);
  logger.info(`[browser.act] Started debugging session for ${sessionId}`);

  // Start tracing — engine path
  const _ctx = engine.getContext(sessionId);
  if (_ctx) {
    try {
      await _ctx.tracing.start({ screenshots: true, snapshots: true });
      debugSession.tracingActive = true;
      logger.info(`[browser.act] Started tracing (engine) for session=${sessionId}`);
    } catch (e) { logger.warn(`[browser.act] Tracing start (engine) failed: ${e.message}`); }
  } else {
    try {
      const traceResult = await cliRun([...sessionFlags(sessionId), 'tracing-start'], 5000);
      if (traceResult.ok) {
        debugSession.tracingActive = true;
        logger.info(`[browser.act] Started tracing for session=${sessionId}`);
      } else {
        logger.warn(`[browser.act] Failed to start tracing for session=${sessionId}: ${traceResult.error}`);
      }
    } catch (error) {
      logger.warn(`[browser.act] Failed to start tracing for session=${sessionId}: ${error.message}`);
    }
  }

  // Start video recording — engine handles via context options, skip for CLI
  if (!_ctx) {
    try {
      const videoResult = await cliRun([...sessionFlags(sessionId), 'video-start'], 5000);
      if (videoResult.ok) {
        debugSession.videoActive = true;
        logger.info(`[browser.act] Started video recording for session=${sessionId}`);
      } else {
        logger.warn(`[browser.act] Failed to start video recording for session=${sessionId}: ${videoResult.error}`);
      }
    } catch (error) {
      logger.warn(`[browser.act] Failed to start video recording for session=${sessionId}: ${error.message}`);
    }
  }

  // Start DevTools — engine path uses CDP session
  if (_ctx) {
    try {
      const cdpSession = await _ctx.newCDPSession(_ctx.pages()[0] || await _ctx.newPage());
      debugSession.devToolsActive = true;
      debugSession.devToolsUrl = 'cdp-session';
      logger.info(`[browser.act] Started CDP session (engine) for session=${sessionId}`);
    } catch (e) { logger.warn(`[browser.act] DevTools start (engine) failed: ${e.message}`); }
  } else {
    try {
      const devToolsResult = await cliRun([...sessionFlags(sessionId), 'devtools-start'], 5000);
      if (devToolsResult.ok) {
        const devToolsOutput = devToolsResult.stdout || '';
        const urlMatch = devToolsOutput.match(/Server is listening on:\s*(ws:\/\/[^\s]+)/);
        if (urlMatch) {
          const devToolsUrl = urlMatch[1].trim();
          debugSession.devToolsActive = true;
          debugSession.devToolsUrl = devToolsUrl;
          logger.info(`[browser.act] Started DevTools for session=${sessionId}, URL: ${devToolsUrl}`);
        } else {
          logger.warn(`[browser.act] Could not extract DevTools URL from output: ${devToolsOutput.slice(0, 200)}`);
        }
      } else {
        logger.warn(`[browser.act] Failed to start DevTools for session=${sessionId}: ${devToolsResult.error}`);
      }
    } catch (error) {
      logger.warn(`[browser.act] Failed to start DevTools for session=${sessionId}: ${error.message}`);
    }
  }
}

// Stop tracing for a session
async function stopSessionTracing(sessionId) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  const traceData = {
    traceFile: null,
    videoFile: null,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory
  };
  
  if (debugSession.tracingActive) {
    const _ctx = engine.getContext(sessionId);
    if (_ctx) {
      try {
        const tracePath = path.join(os.homedir(), '.thinkdrop', 'traces', `${sessionId}-${Date.now()}.zip`);
        fs.mkdirSync(path.dirname(tracePath), { recursive: true });
        await _ctx.tracing.stop({ path: tracePath });
        debugSession.traceFile = tracePath;
        traceData.traceFile = tracePath;
        debugSession.tracingActive = false;
        logger.info(`[browser.act] Stopped tracing (engine) for session=${sessionId}, trace file: ${tracePath}`);
      } catch (e) { logger.warn(`[browser.act] Failed to stop tracing (engine): ${e.message}`); }
    } else {
      try {
        const traceResult = await cliRun([...sessionFlags(sessionId), 'tracing-stop'], 5000);
        if (traceResult.ok) {
          const traceOutput = traceResult.stdout || '';
          const traceMatch = traceOutput.match(/\[Trace\]\(([^)]+)\)/);
          if (traceMatch) {
            const traceFile = traceMatch[1].trim();
            debugSession.traceFile = traceFile;
            traceData.traceFile = traceFile;
            logger.info(`[browser.act] Stopped tracing for session=${sessionId}, trace file: ${traceFile}`);
          } else {
            logger.warn(`[browser.act] Could not extract trace file path from output: ${traceOutput.slice(0, 200)}`);
          }
          debugSession.tracingActive = false;
        }
      } catch (error) {
        logger.warn(`[browser.act] Failed to stop tracing for session=${sessionId}: ${error.message}`);
      }
    }
  }
  
  if (debugSession.videoActive) {
    const _ctx = engine.getContext(sessionId);
    if (_ctx) {
      // Engine video is handled by context options — nothing to stop
      debugSession.videoActive = false;
    } else {
      try {
        const videoResult = await cliRun([...sessionFlags(sessionId), 'video-stop'], 5000);
        if (videoResult.ok) {
          const videoOutput = videoResult.stdout || '';
          const videoMatch = videoOutput.match(/\[Video\]\(([^)]+)\)/);
          if (videoMatch) {
            const videoFile = videoMatch[1].trim();
            debugSession.videoFile = videoFile;
            traceData.videoFile = videoFile;
            logger.info(`[browser.act] Stopped video recording for session=${sessionId}, video file: ${videoFile}`);
          } else {
            logger.debug(`[browser.act] Video recording not available or failed for session=${sessionId}`);
          }
          debugSession.videoActive = false;
        }
      } catch (error) {
        logger.warn(`[browser.act] Failed to stop video recording for session=${sessionId}: ${error.message}`);
      }
    }
  }
  
  // Stop DevTools and capture final debugging data
  if (debugSession.devToolsActive) {
    try {
      // DevTools doesn't need explicit stopping, but we can capture final state
      traceData.devToolsUrl = debugSession.devToolsUrl;
      traceData.devToolsData = debugSession.devToolsData;
      debugSession.devToolsActive = false;
      logger.info(`[browser.act] DevTools session ended for session=${sessionId}`);
    } catch (error) {
      logger.warn(`[browser.act] Failed to cleanup DevTools for session=${sessionId}: ${error.message}`);
    }
  }
  
  return traceData;
}

// Capture debugging context for failed actions
async function captureDebugContext(sessionId, failedAction) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  return {
    sessionId,
    traceFile: debugSession.traceFile,
    videoFile: debugSession.videoFile,
    devToolsUrl: debugSession.devToolsUrl,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    devToolsData: debugSession.devToolsData,
    failedAction: {
      action: failedAction.action,
      args: failedAction.args,
      error: failedAction.error,
      executionTime: failedAction.executionTime,
      crashDetected: failedAction.crashDetected
    },
    sessionDuration: Date.now() - debugSession.startTime
  };
}

// Store action in history for debugging
function storeActionForDebugging(sessionId, actionData) {
  // Skip storing action data if debugging is disabled
  if (!shouldEnableDebugging(sessionId)) return;
  
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession) {
    debugSession.actionHistory.push(actionData);
    
    // Keep only last 50 actions
    if (debugSession.actionHistory.length > 50) {
      debugSession.actionHistory = debugSession.actionHistory.slice(-50);
    }
  }
}

// Detect Chrome crash (about:blank) and trigger debugging repair
async function detectAndHandleChromeCrash(sessionId, action, args, error) {
  // If the session was intentionally closed (e.g. user cancelled), skip crash detection.
  // The eval would re-launch Chrome and show an about:blank window to the user.
  if (!openSessions.has(sessionId)) {
    return { crashDetected: false };
  }
  try {
    // Check if current page is about:blank (indicates Chrome crash)
    const _ePage = engine.getPage(sessionId);
    let isAboutBlank = false;
    if (_ePage) {
      try { isAboutBlank = String(await _ePage.evaluate('window.location.href')).includes('about:blank'); }
      catch (_) {}
    } else {
      const checkResult = await cliRun([...sessionFlags(sessionId), 'eval', 'window.location.href'], 3000);
      isAboutBlank = checkResult.ok && checkResult.stdout && checkResult.stdout.includes('about:blank');
    }
    if (isAboutBlank) {
      logger.error(`[browser.act] Chrome crash detected for session=${sessionId} - page is about:blank`);
      
      // Capture debugging context before recovery
      const debugContext = captureDebugContext(sessionId, {
        action,
        args,
        error: `Chrome crash detected: ${error}`,
        crashDetected: true
      });
      
      // Store crash event in debugging session
      const debugSession = debuggingSessions.get(sessionId);
      if (debugSession) {
        debugSession.networkErrors.push(`Chrome crash: ${error}`);
        debugSession.consoleErrors.push('Browser navigated to about:blank');
      }
      
      return {
        crashDetected: true,
        debugContext,
        error: `Chrome browser crashed - page is about:blank`
      };
    }
  } catch (checkError) {
    logger.warn(`[browser.act] Failed to check for Chrome crash: ${checkError.message}`);
  }
  
  return { crashDetected: false };
}

// Store snapshot for debugging
function storeSnapshotForDebugging(sessionId, snapshotText) {
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession && snapshotText) {
    debugSession.snapshots.push({
      timestamp: Date.now(),
      snapshot: snapshotText
    });
    
    // Keep only last 20 snapshots
    if (debugSession.snapshots.length > 20) {
      debugSession.snapshots = debugSession.snapshots.slice(-20);
    }
  }
}

// Cleanup old debugging sessions (call periodically)
function cleanupOldDebugSessions() {
  const oneHour = 60 * 60 * 1000;
  const now = Date.now();
  
  for (const [sessionId, debugSession] of debuggingSessions.entries()) {
    if (now - debugSession.startTime > oneHour) {
      debuggingSessions.delete(sessionId);
      logger.info(`[browser.act] Cleaned up old debugging session=${sessionId}`);
    }
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldDebugSessions, 30 * 60 * 1000);

// Detect Chrome crash and capture debugging context
async function handleDetectCrash(sessionId, step, error) {
  logger.error(`[browser.act] Chrome crash detection requested for session=${sessionId}`);
  
  // Capture debugging context before recovery
  const debugContext = captureDebugContext(sessionId, {
    action: step?.action || 'unknown',
    args: step || {},
    error: error || 'Chrome crash detected',
    crashDetected: true
  });
  
  // Store crash event in debugging session
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession) {
    debugSession.networkErrors.push(`Chrome crash: ${error}`);
    debugSession.consoleErrors.push('Browser navigated to about:blank during automation');
  }
  
  return {
    ok: true,
    action: 'detectCrash',
    sessionId,
    executionTime: 0,
    debugContext,
    result: 'Chrome crash detected and debugging context captured'
  };
}

// Handle file upload using engine file chooser
async function handleUpload(sessionId, filePath, headed, timeoutMs) {
  const start = Date.now();
  
  try {
    // Validate file exists and is accessible
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        action: 'upload',
        sessionId,
        executionTime: Date.now() - start,
        error: `File does not exist: ${filePath}`
      };
    }
    
    // Check if file is readable
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch (accessError) {
      return {
        ok: false,
        action: 'upload',
        sessionId,
        executionTime: Date.now() - start,
        error: `File is not accessible: ${filePath} - ${accessError.message}`
      };
    }
    
    logger.info(`[browser.act] Uploading file: ${filePath} for session=${sessionId}`);
    
    // ── Engine path ──
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      try {
        const fileInput = await _ePage.locator('input[type="file"]').first();
        await fileInput.setInputFiles(filePath);
        logger.info(`[browser.act] File upload successful (engine): ${filePath} for session=${sessionId}`);
        return { ok: true, action: 'upload', sessionId, filePath, executionTime: Date.now() - start, result: 'File uploaded successfully' };
      } catch (e) { logger.warn(`[browser.act] uploadFileToGmail (engine) failed: ${e.message} — falling back to CLI`); }
    }
    // ── CLI fallback ──
    const S = sessionFlags(sessionId, headed);
    const uploadResult = await cliRun([...S, 'upload', filePath], timeoutMs);
    
    if (uploadResult.ok) {
      logger.info(`[browser.act] File upload successful: ${filePath} for session=${sessionId}`);
      return {
        ok: true,
        action: 'upload',
        sessionId,
        filePath,
        executionTime: Date.now() - start,
        result: uploadResult.stdout || 'File uploaded successfully'
      };
    } else {
      logger.error(`[browser.act] File upload failed: ${filePath} for session=${sessionId} - ${uploadResult.error}`);
      
      // Check if the error is about missing modal state
      if (uploadResult.error && uploadResult.error.includes('modal state')) {
        return {
          ok: false,
          action: 'upload',
          sessionId,
          filePath,
          executionTime: Date.now() - start,
          error: `File chooser modal not active. You must first click on a file input or attachment button to trigger the file chooser, then use upload. Error: ${uploadResult.error}`
        };
      }
      
      return {
        ok: false,
        action: 'upload',
        sessionId,
        filePath,
        executionTime: Date.now() - start,
        error: uploadResult.error || uploadResult.stderr || 'Upload command failed'
      };
    }
  } catch (error) {
    logger.error(`[browser.act] Upload error for session=${sessionId}: ${error.message}`);
    return {
      ok: false,
      action: 'upload',
      sessionId,
      filePath,
      executionTime: Date.now() - start,
      error: error.message
    };
  }
}

// Collect DevTools data during action execution
async function collectDevToolsData(sessionId, action, result) {
  // Skip data collection if debugging is disabled
  if (!shouldEnableDebugging(sessionId)) return;
  
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession || !debugSession.devToolsActive) return;

  try {
    // ── Engine path ──
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      const data = await _ePage.evaluate(() => {
        const requests = [];
        const logs = [];
        if (window.performance && window.performance.getEntriesByType) {
          const entries = window.performance.getEntriesByType('resource');
          entries.forEach(entry => {
            if (entry.initiatorType !== 'script' || entry.name.includes('.js')) {
              requests.push({ url: entry.name, method: 'GET', status: entry.responseStatus || 200, duration: Math.round(entry.duration), size: entry.transferSize || 0 });
            }
          });
        }
        if (window.console && window.console.logs) { logs.push(...window.console.logs.slice(-10)); }
        return { requests: requests.slice(-20), logs };
      });
      debugSession.devToolsData.networkRequests.push(...(data.requests || []));
      debugSession.devToolsData.consoleLogs.push(...(data.logs || []));
      debugSession.devToolsData.networkRequests = debugSession.devToolsData.networkRequests.slice(-50);
      debugSession.devToolsData.consoleLogs = debugSession.devToolsData.consoleLogs.slice(-20);
      return;
    }
    // ── CLI fallback ──
    const networkData = await cliRun([...sessionFlags(sessionId), 'eval', `
      (function() {
        const requests = [];
        const logs = [];
        
        // Get network requests from performance entries
        if (window.performance && window.performance.getEntriesByType) {
          const entries = window.performance.getEntriesByType('resource');
          entries.forEach(entry => {
            if (entry.initiatorType !== 'script' || entry.name.includes('.js')) {
              requests.push({
                url: entry.name,
                method: 'GET', // Simplified - real implementation would need more sophisticated tracking
                status: entry.responseStatus || 200,
                duration: Math.round(entry.duration),
                size: entry.transferSize || 0
              });
            }
          });
        }
        
        // Get console logs (simplified - real implementation would need console override)
        if (window.console && window.console.logs) {
          logs.push(...window.console.logs.slice(-10)); // Last 10 logs
        }
        
        return JSON.stringify({ requests: requests.slice(-20), logs: logs });
      })();
    `], 3000);

    if (networkData.ok && networkData.stdout) {
      try {
        const rawMatch = networkData.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
        const rawJson = (rawMatch ? rawMatch[1] : networkData.stdout).trim().replace(/^"|"$/g, '');
        const data = JSON.parse(rawJson);
        debugSession.devToolsData.networkRequests.push(...data.requests);
        debugSession.devToolsData.consoleLogs.push(...data.logs);
        
        // Keep only recent data to prevent memory bloat
        debugSession.devToolsData.networkRequests = debugSession.devToolsData.networkRequests.slice(-50);
        debugSession.devToolsData.consoleLogs = debugSession.devToolsData.consoleLogs.slice(-20);
      } catch (parseError) {
        logger.debug(`[browser.act] Failed to parse DevTools data: ${parseError.message}`);
      }
    }
  } catch (error) {
    logger.debug(`[browser.act] Failed to collect DevTools data: ${error.message}`);
  }
}

// Export debugging functions for other agents
function getDebuggingContext(sessionId, failedStep) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  return {
    sessionId,
    traceFile: debugSession.traceFile,
    videoFile: debugSession.videoFile,
    devToolsUrl: debugSession.devToolsUrl,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    devToolsData: debugSession.devToolsData,
    failedStep,
    sessionDuration: Date.now() - debugSession.startTime
  };
}

// ---------------------------------------------------------------------------
// Auth form loop — LLM prompt used by waitForAuth agentic fill
// ---------------------------------------------------------------------------
const AUTH_FORM_PROMPT = `You are a browser automation agent filling a login form.
Given a page snapshot and the available credential types, decide the SINGLE next action.
Reply ONLY with valid JSON — no markdown fences, no extra text:
{"action":"fill_email","selector":"<CSS selector>","rationale":"<one line>"}

action values:
- fill_email    : An unfilled email/username input is visible. Use when has_email=true.
- fill_password : A password input is visible. Use when has_password=true.
- click_submit  : Credentials entered; a Next/Sign in/Log in button is visible and should be clicked.
- done          : No more credential fields to fill (2FA page, CAPTCHA, or past login).

Rules:
- If both email AND password fields are visible at once, return fill_email first.
- Prefer #id selectors. Then [name=x]. Then input[type="email"] or input[type="password"].
- Never return fill_email if has_email=false. Never return fill_password if has_password=false.
- Return done for 2FA prompts, CAPTCHA challenges, or when page has advanced past credential entry.
- fill_email and fill_password are ONE-SHOT — never repeat an action already in "Completed actions".
- click_submit MAY be retried: if credentials are filled but a submit button is still visible and the page has not yet transitioned, return click_submit again. Do NOT return done just because click_submit is already in Completed actions.
- Only return done when you see a 2FA challenge, CAPTCHA, or the page is clearly past credential entry (e.g. inbox, dashboard).
- "Visible inputs:" lists ONLY inputs that are truly visible (display!=none, visibility!=hidden, opacity>=0.9, height>0). Trust this over the ARIA snapshot which may include hidden inputs.
- Never return fill_password unless "password" appears in the Visible inputs line.
- selector must be a valid CSS selector string, or null for action=done.`;

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const CLI_CANDIDATES = [
  '/opt/homebrew/bin/playwright-cli',
  '/usr/local/bin/playwright-cli',
  path.join(os.homedir(), '.npm-global', 'bin', 'playwright-cli'),
];

function findCli() {
  for (const c of CLI_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return 'playwright-cli'; // hope it's on PATH
}

const CLI_BIN = findCli();
logger.info(`[browser.act] playwright-cli binary: ${CLI_BIN}`);

// Check if playwright-cli is actually available
const PLAYWRIGHT_CLI_AVAILABLE = (() => {
  try {
    // Check if binary exists and is executable
    const fs = require('fs');
    const isBinary = CLI_BIN.startsWith('/') || CLI_BIN.startsWith('\\');
    if (isBinary) {
      fs.accessSync(CLI_BIN, fs.constants.X_OK);
    }
    // Try a quick version check
    const { execSync } = require('child_process');
    execSync(`${CLI_BIN} --version`, { timeout: 5000, stdio: 'pipe' });
    logger.info('[browser.act] playwright-cli is available and working');
    return true;
  } catch (err) {
    logger.warn(`[browser.act] playwright-cli not available: ${err.message}`);
    return false;
  }
})();

// ---------------------------------------------------------------------------
// Core executor — runs playwright-cli with given args
// Returns: { ok, stdout, stderr, exitCode, executionTime }
// ---------------------------------------------------------------------------

function cliRun(args, timeoutMs = 15000) {
  const sessionFlag = args.find((arg) => typeof arg === 'string' && arg.startsWith('-s='));
  const shortId = sessionFlag ? sessionFlag.slice(3) : null;
  const sessionId = shortId ? (_sidCache.get(shortId) || shortId) : null;
  if (sessionId && engine.isSessionActive(sessionId)) {
    const error = `Engine owns session ${sessionId}; playwright-cli execution is blocked`;
    logger.warn(`[browser.act] ${error}`);
    return Promise.resolve({ ok: false, stdout: '', stderr: error, exitCode: -1, executionTime: 0, error, engineOwned: true });
  }
  return new Promise((resolve) => {
    const start = Date.now();

    // ── Check playwright-cli availability ────────────────────────────────────
    if (!PLAYWRIGHT_CLI_AVAILABLE) {
      logger.error('[browser.act] playwright-cli is not available - cannot execute browser actions');
      resolve({
        ok: false,
        stdout: '',
        stderr: 'playwright-cli is not installed or not executable',
        exitCode: -1,
        executionTime: 0,
        error: 'playwright-cli is not available. Please install with: brew install playwright-cli',
        playwrightCliMissing: true
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn(CLI_BIN, args, {
      env: { ...process.env },
      // Remove timeout to prevent Node.js from killing the process
      // timeout: timeoutMs,
    });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Timeout handling: resolve with ok:false so the caller can proceed.
    // Do NOT kill the process — cliRun is used for short internal probes
    // (2000ms hostname check, URL probe) as well as main actions. Killing
    // on any timeout destroys the playwright-cli daemon = kills the browser
    // session. The overallTimeoutMs in playwright.agent handles task-level
    // timeout enforcement at the correct layer.
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn(`[browser.act] cliRun timeout after ${timeoutMs}ms (pid=${proc.pid}) — letting process finish naturally`);
        resolve({ 
          ok: false, 
          stdout, 
          stderr, 
          exitCode: -1, 
          executionTime: Date.now() - start, 
          error: `Timed out after ${timeoutMs}ms` 
        });
      }
    }, timeoutMs);

    proc.on('close', code => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        const executionTime = Date.now() - start;
        const ok = code === 0;
        resolve({ ok, stdout, stderr, exitCode: code ?? -1, executionTime, error: ok ? undefined : stderr.trim() || `exit code ${code}` });
      }
    });

    proc.on('error', err => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: false, stdout, stderr, exitCode: -1, executionTime: Date.now() - start, error: err.message });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Ad-block injection helper
// ---------------------------------------------------------------------------

/**
 * Injects the ad-blocking script into the currently loaded page for a session.
 * Non-blocking, non-fatal — never throws, never delays the caller.
 * Guard in the script prevents double-injection on repeated navigate calls.
 *
 * @param {string}  sessionId
 * @param {boolean} headed
 */
// run-code snippet: clicks skip button if visible, removes ad-showing class so
// the video player resumes. Handles the "stuck ad" state that occurs when route
// blocking freezes the ad video stream but YouTube's JS still shows the ad overlay.
const _AD_DISMISS_CODE = `async (page) => {
  try {
    return await page.evaluate(() => {
      const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button');
      if (skipBtn) { skipBtn.click(); return 'skipped'; }
      const adEl = document.querySelector('.ad-showing');
      if (adEl) {
        adEl.classList.remove('ad-showing');
        const vid = document.querySelector('video');
        if (vid && vid.paused) vid.play().catch(() => {});
        return 'dismissed';
      }
      return 'no-ad';
    });
  } catch(e) { return 'error:' + e.message; }
}`;

async function injectAdBlock(sessionId, headed) {
  try {
    // ── Engine path ──
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      try {
        await _ePage.evaluate(_AD_BLOCK_SCRIPT);
        logger.info(`[browser.act] injectAdBlock: ✓ CSS cosmetics injected (engine, session=${sessionId})`);
      } catch (e) {
        logger.warn(`[browser.act] injectAdBlock: engine eval failed (session=${sessionId}): ${e.message}`);
      }
      try {
        const dismissOutcome = await _ePage.evaluate(_AD_DISMISS_CODE);
        logger.info(`[browser.act] injectAdBlock: ad dismiss → ${dismissOutcome} (engine, session=${sessionId})`);
      } catch (e) {
        logger.warn(`[browser.act] injectAdBlock: engine dismiss failed (session=${sessionId}): ${e.message}`);
      }
      return;
    }
    // ── CLI fallback ──
    const injectResult = await cliRun(
      [...sessionFlags(sessionId, headed), 'eval', _AD_BLOCK_SCRIPT],
      8000
    );

    if (injectResult?.ok || injectResult?.exitCode === 0) {
      logger.info(`[browser.act] injectAdBlock: ✓ CSS cosmetics injected (session=${sessionId})`);
    } else {
      logger.warn(`[browser.act] injectAdBlock: eval failed (session=${sessionId}) exitCode=${injectResult?.exitCode} stderr=${(injectResult?.stderr || '').slice(0, 200)}`);
    }

    const dismissResult = await cliRun(
      [...sessionFlags(sessionId, headed), 'run-code', _AD_DISMISS_CODE],
      5000
    );
    if (dismissResult?.ok) {
      const outcome = (dismissResult.stdout || '').match(/["']?(skipped|dismissed|no-ad)["']?/)?.[1] || 'unknown';
      logger.info(`[browser.act] injectAdBlock: ad dismiss → ${outcome} (session=${sessionId})`);
    }
  } catch (err) {
    logger.warn(`[browser.act] injectAdBlock error (session=${sessionId}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Gmail-Optimized Content Detection
// ---------------------------------------------------------------------------

// Lightweight content detection for Gmail pages to avoid timeout crashes
async function getGmailPageContent(sessionId, timeoutMs = 5000) {
  try {
    // ── Engine path ──
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      const exprs = [
        ['title', 'document.title'],
        ['url', 'window.location.href'],
        ['minimal-content', 'document.body.innerText.slice(0,1000)'],
        ['gmail-main', 'document.querySelector("[role=main]")?.innerText.slice(0,2000) || ""'],
        ['gmail-compose', 'document.querySelector("div[role=dialog]")?.innerText.slice(0,1500) || ""'],
      ];
      for (const [name, expr] of exprs) {
        try {
          const content = await _ePage.evaluate(expr);
          if (content && content !== '' && content !== 'null') {
            logger.debug(`[browser.act] Gmail content detected via ${name} (engine): ${String(content).length} chars`);
            return String(content);
          }
        } catch (_) { continue; }
      }
      return '';
    }
    // ── CLI fallback ──
    const strategies = [
      { name: 'title', fn: () => cliRun([...sessionFlags(sessionId), 'eval', 'document.title'], 2000) },
      { name: 'url', fn: () => cliRun([...sessionFlags(sessionId), 'eval', 'window.location.href'], 2000) },
      { name: 'minimal-content', fn: () => cliRun([...sessionFlags(sessionId), 'eval', 'document.body.innerText.slice(0,1000)'], 3000) },
      { name: 'gmail-main', fn: () => cliRun([...sessionFlags(sessionId), 'eval', 'document.querySelector("[role=main]")?.innerText.slice(0,2000) || ""'], 3000) },
      { name: 'gmail-compose', fn: () => cliRun([...sessionFlags(sessionId), 'eval', 'document.querySelector("div[role=dialog]")?.innerText.slice(0,1500) || ""'], 3000) },
    ];

    for (const strategy of strategies) {
      try {
        const result = await strategy.fn();
        if (result.ok && result.stdout) {
          const match = result.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
          const content = match ? match[1].trim().replace(/^"|"$/g, '') : result.stdout.trim();
          if (content && content !== '' && content !== 'null') {
            logger.debug(`[browser.act] Gmail content detected via ${strategy.name}: ${content.length} chars`);
            return content;
          }
        }
      } catch (error) {
        logger.debug(`[browser.act] Gmail content strategy ${strategy.name} failed: ${error.message}`);
        continue;
      }
    }
    
    logger.debug(`[browser.act] All Gmail content strategies failed, returning empty string`);
    return '';
  } catch (error) {
    logger.warn(`[browser.act] Gmail page content detection failed: ${error.message}`);
    return '';
  }
}

// Gmail-specific stable text detection with about:blank recovery
async function waitForGmailStableText(sessionId, timeoutMs = 15000) {
  const start = Date.now();
  let prev = '';
  let stableCount = 0;
  const maxStableCount = 2; // Need 2 consecutive stable reads
  const checkInterval = 1500; // Check every 1.5 seconds

  logger.info(`[browser.act] waitForGmailStableText: starting for session=${sessionId}`);

  while (Date.now() - start < timeoutMs) {
    try {
      // Check for about:blank first (fast check)
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          const _url = await _ePage.evaluate('window.location.href');
          if (String(_url).includes('about:blank')) {
            logger.warn(`[browser.act] waitForGmailStableText: about:blank detected for session=${sessionId}`);
            return { ok: true, result: '', aboutBlankDetected: true, executionTime: Date.now() - start };
          }
        } catch (_) {}
      } else {
        const urlCheck = await cliRun([...sessionFlags(sessionId), 'eval', 'window.location.href'], 2000);
        if (urlCheck.ok && urlCheck.stdout.includes('about:blank')) {
          logger.warn(`[browser.act] waitForGmailStableText: about:blank detected for session=${sessionId}`);
          return { ok: true, result: '', aboutBlankDetected: true, executionTime: Date.now() - start };
        }
      }

      // Use Gmail-optimized content detection
      const cur = await getGmailPageContent(sessionId);
      
      if (cur === prev && cur !== '') {
        stableCount++;
        logger.debug(`[browser.act] waitForGmailStableText: stable count ${stableCount}/${maxStableCount}`);
        
        if (stableCount >= maxStableCount) {
          logger.info(`[browser.act] waitForGmailStableText: content stabilized after ${Date.now() - start}ms`);
          return { ok: true, result: cur, executionTime: Date.now() - start };
        }
      } else {
        stableCount = 0;
        prev = cur;
        logger.debug(`[browser.act] waitForGmailStableText: content changed, resetting stability (${cur.length} chars)`);
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    } catch (error) {
      logger.warn(`[browser.act] waitForGmailStableText: check failed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  logger.info(`[browser.act] waitForGmailStableText: timeout after ${Date.now() - start}ms, returning last content`);
  return { ok: true, result: prev, executionTime: Date.now() - start }; // Return last known content
}

// Recover from about:blank without losing session
async function recoverFromAboutBlank(sessionId, originalUrl = 'https://mail.google.com') {
  try {
    logger.info(`[browser.act] Recovering from about:blank for session=${sessionId}`);
    
    // Step 1: Check if browser window is still responsive
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      try {
        await _ePage.evaluate('window.navigator.userAgent');
        logger.info(`[browser.act] Browser responsive, navigating back (engine) for session=${sessionId}`);
        await _ePage.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
        logger.info(`[browser.act] Recovery successful via navigation (engine) for session=${sessionId}`);
        return { recovered: true, method: 'navigate' };
      } catch (e) { logger.warn(`[browser.act] recoverFromAboutBlank (engine) failed: ${e.message} — falling back to CLI`); }
    }
    const ping = await cliRun([...sessionFlags(sessionId), 'eval', 'window.navigator.userAgent'], 3000);
    if (ping.ok && ping.stdout) {
      logger.info(`[browser.act] Browser responsive, navigating back to Gmail for session=${sessionId}`);
      const navResult = await cliRun([...sessionFlags(sessionId), 'goto', originalUrl], 10000);
      if (navResult.ok) {
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        logger.info(`[browser.act] Recovery successful via navigation for session=${sessionId}`);
        return { recovered: true, method: 'navigate' };
      }
    }
    
    // Step 2: Browser unresponsive, restart session
    logger.info(`[browser.act] Browser unresponsive, restarting session=${sessionId}`);
    openSessions.delete(sessionId);
    clearAdBlockSession(sessionId);
    
    const restartResult = await cliRun([...sessionFlags(sessionId), 'open', ...openFlags(), originalUrl], 15000);
    if (restartResult.ok) {
      openSessions.add(sessionId);
      await new Promise(resolve => setTimeout(resolve, 5000));
      logger.info(`[browser.act] Recovery successful via restart for session=${sessionId}`);
      return { recovered: true, method: 'restart' };
    }
    
    logger.error(`[browser.act] Recovery failed for session=${sessionId}`);
    return { recovered: false, error: 'Failed to recover session - both navigation and restart failed' };
  } catch (error) {
    logger.error(`[browser.act] Recovery error for session=${sessionId}: ${error.message}`);
    return { recovered: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Gmail Copy-Paste Attachment Method
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Session Recovery and Enhanced Error Handling
// ---------------------------------------------------------------------------

// Persistent profile directory per session — preserves cookies/login across restarts
function sessionProfileDir(sessionId) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Remove Chrome's SingletonLock file so a post-crash restart can reuse the profile
// without Chrome deciding to start fresh (losing the logged-in session).
// Also patches Default/Preferences exit_type → Normal to suppress the
// "Chrome didn't shut down correctly / Restore pages?" dialog that appears
// whenever the playwright-cli daemon was killed without a clean browser exit.
function clearProfileLock(sessionId) {
  try {
    const lockFile = path.join(sessionProfileDir(sessionId), 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      logger.info(`[browser.act] Removed stale SingletonLock for session=${sessionId}`);
    }
  } catch (_) {}
  try {
    const prefsPath = path.join(sessionProfileDir(sessionId), 'Default', 'Preferences');
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      let patched = false;
      if (prefs?.profile?.exit_type === 'Crashed') { prefs.profile.exit_type = 'Normal'; patched = true; }
      if (prefs?.profile?.exited_cleanly === false) { prefs.profile.exited_cleanly = true; patched = true; }
      if (patched) {
        fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
        logger.info(`[browser.act] Patched Preferences exit_type → Normal for session=${sessionId}`);
      }
    }
  } catch (_) {}
}

// Kill any existing Chrome process using this session's profile directory.
// Prevents the "Opening in existing browser session" issue that creates blank tabs.
// Also kills zombie Chrome processes that lost their SingletonLock after crashing.
function killExistingChromeForProfile(sessionId) {
  let killed = false;
  try {
    if (!shouldUsePersistentProfile(sessionId)) return false;
    const profileDir = sessionProfileDir(sessionId);
    const lockFile = path.join(profileDir, 'SingletonLock');
    
    // Method 1: Kill via SingletonLock PID (clean shutdown path)
    if (fs.existsSync(lockFile)) {
      let target = '';
      try { target = fs.readlinkSync(lockFile); } catch (_) {}
      const m = String(target).match(/-(\d+)$/);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (pid) {
          try {
            process.kill(pid, 0); // Check if process exists
            logger.info(`[browser.act] Killing existing Chrome process ${pid} for session=${sessionId}`);
            try { process.kill(pid, 'SIGTERM'); } catch (_) {}
            for (let i = 0; i < 10; i++) {
              try {
                process.kill(pid, 0);
                const start = Date.now();
                while (Date.now() - start < 200) {} // 200ms busy wait
              } catch (_) { break; }
            }
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            killed = true;
          } catch (_) {}
          try { fs.unlinkSync(lockFile); } catch (_) {}
        }
      }
    }
    
    // Method 2: Kill any Chrome processes with this profile dir in their cmdline
    // This catches zombies that lost their SingletonLock after crashing
    try {
      const { spawnSync } = require('child_process');
      // Find Chrome processes using this specific profile directory
      const pgrepResult = spawnSync('pgrep', ['-f', `Google Chrome.*${profileDir}`], { encoding: 'utf8' });
      if (pgrepResult.status === 0 && pgrepResult.stdout) {
        const pids = pgrepResult.stdout.trim().split('\n').filter(p => p.trim());
        for (const pidStr of pids) {
          const pid = parseInt(pidStr, 10);
          if (!pid) continue;
          try {
            process.kill(pid, 0); // Verify process exists
            logger.info(`[browser.act] Killing zombie Chrome process ${pid} for session=${sessionId} (no lock)`);
            try { process.kill(pid, 'SIGTERM'); } catch (_) {}
            // Brief wait then force kill
            const start = Date.now();
            while (Date.now() - start < 500) {} // 500ms busy wait
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
            killed = true;
          } catch (_) {}
        }
      }
    } catch (_) {}
    
    return killed;
  } catch (e) {
    logger.warn(`[browser.act] Error killing existing Chrome: ${e.message}`);
    return killed;
  }
}

// Close any about:blank / chrome://newtab tabs that accumulated from failed navigations.
// Called after a successful navigate to clean up ghost tabs.
async function closeBlankTabs(sessionId, headed = true) {
  // ── Engine path ──
  const _ctx = engine.getContext(sessionId);
  if (_ctx) {
    try {
      const pages = _ctx.pages();
      let closed = 0;
      for (let i = pages.length - 1; i >= 0; i--) {
        const url = pages[i].url();
        if (url === 'about:blank' || url === 'chrome://newtab/') {
          await pages[i].close();
          closed++;
        }
      }
      if (closed > 0) logger.info(`[browser.act] closeBlankTabs: closed ${closed} blank tab(s) (engine, session=${sessionId})`);
      return closed;
    } catch (e) { logger.warn(`[browser.act] closeBlankTabs (engine) failed: ${e.message} — falling back to CLI`); }
  }
  // ── CLI fallback ──
  const S = sessionFlags(sessionId, headed);
  try {
    const listRes = await cliRun([...S, 'tab-list'], 5000);
    if (!listRes.ok) return 0;
    const lines = (listRes.stdout || '').split('\n');
    const blankIndices = [];
    for (const line of lines) {
      const m = line.match(/^\s*-\s+(\d+):\s+(about:blank|chrome:\/\/newtab)/);
      if (m) blankIndices.push(parseInt(m[1], 10));
    }
    if (blankIndices.length === 0) return 0;
    for (const idx of blankIndices.sort((a, b) => b - a)) {
      await cliRun([...S, 'tab-select', String(idx)], 3000);
      await cliRun([...S, 'tab-close'], 3000);
    }
    logger.info(`[browser.act] closeBlankTabs: closed ${blankIndices.length} blank tab(s) for session=${sessionId}`);
    return blankIndices.length;
  } catch (e) {
    logger.warn(`[browser.act] closeBlankTabs error: ${e.message}`);
    return 0;
  }
}

// Determine if session should use persistent profile (skills best practice)
function shouldUsePersistentProfile(sessionId) {
  // Use persistent profiles for all sessions except explicitly ephemeral/one-shot ones.
  // Ephemeral sessions are anonymous, test, or temp — everything else persists cookies.
  const ephemeral = ['anon', 'temp', 'test'];
  return !ephemeral.some(k => sessionId.includes(k));
}

// macOS limits Unix domain socket paths to 104 bytes (sun_path). The playwright-cli
// daemon socket lives at: <tmpdir>/playwright-cli/<hash>/<sessionId>.sock
// With a typical macOS tmpdir the prefix is ~81 chars, leaving ~18 chars for the
// session name + ".sock" (5 chars) = max 13 chars for the session name.
// Longer names cause EINVAL on Node 25+. We hash them to fit.
const _sidCache = new Map(); // shortId → original sessionId (for logging)
function shortSessionId(sessionId) {
  if (sessionId.length <= 12) return sessionId;
  const crypto = require('crypto');
  const short = crypto.createHash('md5').update(sessionId).digest('hex').slice(0, 12);
  _sidCache.set(short, sessionId);
  return short;
}

// Build base flags for a session (with skills-based persistent profiles)
// Each agent session gets its OWN profile directory under ~/.thinkdrop/browser-profiles/
// so cookies/localStorage survive restarts without any cross-contamination between
// agents. Fixes the "Chrome didn't shut down correctly" Restore-pages banner that
// appears when multiple sessions fight over a single shared persistent profile.
function sessionFlags(sessionId, headed = true) {
  const flags = [`-s=${shortSessionId(sessionId)}`];
  if (headed) flags.push('--headed');

  // Use real Chrome by default — bundled Chrome for Testing is bot-detected by
  // Google OAuth / Cloudflare Turnstile (ChatGPT login spinner issue).
  // Override with THINKDROP_BROWSER_CHANNEL=cft for bundled Chromium.
  const _envChannel = String(process.env.THINKDROP_BROWSER_CHANNEL || '').toLowerCase();
  if (_envChannel !== 'cft') {
    flags.push('--browser=chrome');
  }

  if (shouldUsePersistentProfile(sessionId)) {
    const profileDir = sessionProfileDir(sessionId);
    flags.push(`--profile=${profileDir}`);
    logger.debug(`[browser.act] Using persistent profile dir ${profileDir} for session=${sessionId}`);
  }

  return flags;
}

// Returns ['--config=<path>'] to be inserted after 'open' subcommand.
// --config is an open-subcommand flag in playwright-cli — it MUST come after 'open',
// not in the pre-subcommand session flags. Returns [] if config file is missing.
//
// When isAuth=true, returns [] — auth/OAuth flows need service workers enabled
// (Google FedCM API requires SW registration). cli.config.json sets
// serviceWorkers:"block" which silently hangs Google OAuth. Ad blocking is not
// needed during the short auth flow.
function openFlags(isAuth = false) {
  if (isAuth) return [];
  const cliConfig = path.join(os.homedir(), '.thinkdrop', 'cli.config.json');
  return fs.existsSync(cliConfig) ? [`--config=${cliConfig}`] : [];
}

// ---------------------------------------------------------------------------
// Snapshot cache — stores last snapshot text per session+tab for ref resolution
// Keyed as "sessionId:tabIndex" so switching tabs restores the correct refs.
// ---------------------------------------------------------------------------
const snapshotCache = new Map();    // "sessionId:tabIndex" → snapshot text
const currentTabIndex = new Map();  // sessionId → current tab index (default 0)

function _tabKey(sessionId) {
  return `${sessionId}:${currentTabIndex.get(sessionId) || 0}`;
}
function _tabKeyFor(sessionId, idx) {
  return `${sessionId}:${idx}`;
}

// Track which sessions have been opened (daemon started)
const openSessions = new Set();

// ── Engine helpers ──────────────────────────────────────────────────────────
// Check if the Node API engine is managing this session (vs playwright-cli daemon).
function _engineActive(sessionId) {
  return engine.isSessionActive(sessionId);
}

// Ensure engine session is launched. Returns the Page or null on failure.
async function _ensureEngine(sessionId, headed) {
  if (engine.isSessionActive(sessionId)) {
    return engine.getPage(sessionId);
  }
  try {
    await engine.launch(sessionId, { headed });
    openSessions.add(sessionId);
    return engine.getPage(sessionId);
  } catch (err) {
    logger.warn(`[browser.act] engine launch failed for session=${sessionId}: ${err.message}`);
    return null;
  }
}

// Store the current refMap per session (from the last snapshot via engine)
const _engineRefMaps = new Map(); // sessionId → refMap (Map: ref → { role, name, ... })
const _engineSnapshots = new Map();

async function _captureEngineSnapshot(sessionId, page) {
  const { yaml, refMap, lowConfidenceRefs, activeElement, scannerUsed } = await engine.buildRefTree(page);
  if (!yaml) return null;
  const previous = _engineSnapshots.get(sessionId);
  const snapshot = {
    generation: (previous?.generation || 0) + 1,
    page,
    url: page.url(),
    yaml,
    refMap,
    lowConfidenceRefs: !!lowConfidenceRefs,
    activeElement: activeElement || null,
    scannerUsed: !!scannerUsed,
  };
  _engineSnapshots.set(sessionId, snapshot);
  _engineRefMaps.set(sessionId, refMap);
  snapshotCache.set(_tabKey(sessionId), yaml);
  storeSnapshotForDebugging(sessionId, yaml);
  return snapshot;
}

function _engineActionFailure(action, sessionId, error, extra = {}) {
  return { ok: false, action, sessionId, error, engineOwned: true, ...extra };
}

function _engineRefEntry(sessionId, page, selector) {
  // Accept ref formats: [ref=e93], [e93], bare e93 (ARIA) AND [ref=td93], [td93], bare td93 (DOM scanner)
  // (repair LLMs sometimes emit [e93] instead of [ref=e93] or e93)
  const refMatch = selector?.trim().match(/^\[ref=(e\d+)\]$/i) || selector?.trim().match(/^\[(e\d+)\]$/i)
    || selector?.trim().match(/^\[ref=(td\d+)\]$/i) || selector?.trim().match(/^\[(td\d+)\]$/i);
  const ref = refMatch ? refMatch[1] : (/^(?:e|td)\d+$/i.test((selector || '').trim()) ? selector.trim() : null);
  if (!ref) return { ref: null, entry: null, stale: false };
  const snapshot = _engineSnapshots.get(sessionId);
  if (!snapshot || snapshot.page !== page || snapshot.url !== page.url()) return { ref, entry: null, stale: true };
  return { ref, entry: snapshot.refMap.get(ref) || null, stale: !snapshot.refMap.has(ref) };
}

// Check if a ref is a DOM scanner ref (tdN) vs ARIA ref (eN)
function _isTdRef(ref) {
  return /^td\d+$/i.test(ref || '');
}

// Re-tag-on-miss: when [data-td-ref="tdN"] doesn't resolve (SPA re-rendered),
// re-run a lightweight scan to re-tag visible interactive elements.
// Returns the new ref matching the original element's characteristics, or null.
async function _reTagAndResolve(page, originalRef, originalEntry) {
  if (!page || !originalEntry) return null;
  logger.info(`[browser.act] re-tag-on-miss: [data-td-ref="${originalRef}"] not found — re-scanning DOM`);
  try {
    const raw = await page.evaluate(engine._DOM_SCANNER_SCRIPT);
    if (!raw) return null;
    const result = JSON.parse(raw);
    // Find a matching element by comparing key characteristics
    const match = result.elements.find(el =>
      el.role === originalEntry.role &&
      el.label === originalEntry.name &&
      el.tag === originalEntry.tag &&
      el.type === originalEntry.type
    );
    if (match) {
      logger.info(`[browser.act] re-tag-on-miss: matched element found as ${match.ref} (role=${match.role}, label="${match.label}")`);
      return match.ref;
    }
    // Fallback: match by label + role only
    const looseMatch = result.elements.find(el =>
      el.label === originalEntry.name && el.role === originalEntry.role
    );
    if (looseMatch) {
      logger.info(`[browser.act] re-tag-on-miss: loose match found as ${looseMatch.ref} (role=${looseMatch.role}, label="${looseMatch.label}")`);
      return looseMatch.ref;
    }
    logger.warn(`[browser.act] re-tag-on-miss: no matching element found after re-scan`);
    return null;
  } catch (err) {
    logger.warn(`[browser.act] re-tag-on-miss: re-scan failed: ${err.message}`);
    return null;
  }
}

// Pre-click occlusion check + coordinate-click fallback
// Returns true if click was handled (either succeeded or failed definitively),
// false if caller should continue with other fallback paths.
async function _tdRefClick(page, ref, entry, cmd, forceClick, timeoutMs) {
  const selector = `[data-td-ref="${ref}"]`;
  const clickTimeout = Math.min(timeoutMs, 15000);

  // Step 1: Try direct locator click
  try {
    const locator = page.locator(selector);
    if (cmd === 'dblclick') {
      await locator.dblclick({ timeout: clickTimeout, force: forceClick });
    } else {
      await locator.click({ timeout: clickTimeout, force: forceClick });
    }
    logger.info(`[browser.act] click (engine) tdRef=${ref} ok${forceClick ? ' (force)' : ''}`);
    return true;
  } catch (clickErr) {
    logger.warn(`[browser.act] click (engine) tdRef=${ref} failed: ${clickErr.message.slice(0, 80)}`);
    // Step 2: Re-tag-on-miss (element exists but click failed — try re-tag)
    const reTaggedRef = await _reTagAndResolve(page, ref, entry);
    if (reTaggedRef && reTaggedRef !== ref) {
      const reTagSelector = `[data-td-ref="${reTaggedRef}"]`;
      try {
        const locator = page.locator(reTagSelector);
        if (cmd === 'dblclick') {
          await locator.dblclick({ timeout: clickTimeout, force: forceClick });
        } else {
          await locator.click({ timeout: clickTimeout, force: forceClick });
        }
        logger.info(`[browser.act] click (engine) re-tagged tdRef=${reTaggedRef} ok${forceClick ? ' (force)' : ''}`);
        return true;
      } catch (reTagErr) {
        logger.warn(`[browser.act] click (engine) re-tagged tdRef=${reTaggedRef} failed: ${reTagErr.message.slice(0, 80)}`);
      }
    }
  }

  // Step 3: Occlusion re-check + scroll-into-view retry
  if (entry && entry.rect) {
    const occluded = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { exists: false };
      el.scrollIntoViewIfNeeded ? el.scrollIntoViewIfNeeded() : el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        exists: true,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        occluded: top && top !== el && !el.contains(top) && !top.contains(el),
      };
    }, selector).catch(() => null);

    if (occluded && occluded.exists) {
      // Wait briefly after scroll, then try again
      await new Promise(r => setTimeout(r, 300));
      try {
        const locator = page.locator(selector);
        if (cmd === 'dblclick') {
          await locator.dblclick({ timeout: 5000, force: forceClick });
        } else {
          await locator.click({ timeout: 5000, force: forceClick });
        }
        logger.info(`[browser.act] click (engine) tdRef=${ref} ok after scroll${forceClick ? ' (force)' : ''}`);
        return true;
      } catch (scrollErr) {
        logger.warn(`[browser.act] click (engine) tdRef=${ref} scroll-retry failed: ${scrollErr.message.slice(0, 80)}`);
      }

      // Step 4: Trusted coordinate click (bypasses Playwright actionability gate)
      if (occluded.rect && occluded.rect.width > 0 && occluded.rect.height > 0) {
        const cx = occluded.rect.x + occluded.rect.width / 2;
        const cy = occluded.rect.y + occluded.rect.height / 2;
        logger.info(`[browser.act] click (engine) tdRef=${ref} coordinate-click at (${cx}, ${cy})${occluded.occluded ? ' [occluded]' : ''}`);
        try {
          await page.mouse.click(cx, cy);
          logger.info(`[browser.act] click (engine) tdRef=${ref} coordinate-click ok`);
          return true;
        } catch (coordErr) {
          logger.warn(`[browser.act] click (engine) tdRef=${ref} coordinate-click failed: ${coordErr.message}`);
        }
      }
    }
  }

  return false;
}

async function _handoffEngineToCli(sessionId) {
  if (!engine.isSessionActive(sessionId)) return { ok: true, handedOff: false };
  try {
    await engine.closeSession(sessionId);
    _engineRefMaps.delete(sessionId);
    _engineSnapshots.delete(sessionId);
    snapshotCache.delete(_tabKey(sessionId));
    return { ok: true, handedOff: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function invalidateEngineSnapshot(sessionId) {
  _engineSnapshots.delete(sessionId);
  _engineRefMaps.delete(sessionId);
}

// Probe whether a playwright-cli daemon is already alive for a session.
// Used on navigate after app restart (openSessions cleared) to avoid cold-starting
// a new Chrome tab when the browser is already open from a previous run.
//
// We intentionally avoid spawning a Chrome process to probe — with per-session
// persistent profiles (see sessionFlags), a headless probe would lock the profile
// and the subsequent headed open would collide on Chrome's SingletonLock,
// producing the "window flashes blank then closes + reopens" symptom.
//
// Instead we check for an active SingletonLock symlink in the profile dir —
// Chrome creates it at startup and removes it on clean exit. If it's alive and
// pointing to a live pid, a Chrome process is running against this profile,
// which means a daemon is alive.
async function isDaemonAlive(sessionId, headed) {
  // ── Engine path: check if engine session is active ──
  if (engine.isSessionActive(sessionId)) return true;
  // ── CLI fallback: check SingletonLock ──
  try {
    if (!shouldUsePersistentProfile(sessionId)) {
      const probe = await cliRun([...sessionFlags(sessionId, false), 'eval', '1'], 4000);
      return probe.ok;
    }
    const profileDir = sessionProfileDir(sessionId);
    const lockPath = path.join(profileDir, 'SingletonLock');
    if (!fs.existsSync(lockPath)) return false;
    // SingletonLock is a symlink like "<host>-<pid>"; extract the pid and verify.
    let target = '';
    try { target = fs.readlinkSync(lockPath); } catch (_) { return false; }
    const m = String(target).match(/-(\d+)$/);
    if (!m) return false;
    const pid = parseInt(m[1], 10);
    if (!pid) return false;
    try {
      process.kill(pid, 0); // signal 0 = existence check, does not actually signal
      return true;
    } catch (_) {
      // Stale lock — pid is gone. Treat as dead daemon.
      try { fs.unlinkSync(lockPath); } catch (_) {}
      return false;
    }
  } catch (_) {
    return false;
  }
}

// Track the last selector/ref that was successfully filled, per session.
// Used by press Enter to refocus the input before submitting.
const lastFilledTarget = new Map(); // sessionId → { target, ref }

// Batch probe — single page.evaluate returning multiple page properties.
// Replaces 2-5 separate page.evaluate() calls with one round-trip.
async function batchProbe(page, opts = {}) {
  const sliceLen = opts.sliceLen || 25000;
  try {
    return await page.evaluate(`(() => ({
      href: location.href,
      title: document.title,
      hostname: location.hostname,
      bodyText: (document.body && document.body.innerText || '').slice(0, ${sliceLen}),
      bodyLength: (document.body && document.body.innerText || '').length,
      hasContentEditable: !!document.querySelector('[contenteditable], textarea'),
      activeElement: document.activeElement ? document.activeElement.tagName : null
    }))()`);
  } catch (e) {
    return null;
  }
}

async function captureSnapshot(sessionId, headed, timeoutMs) {
  // ── Engine path: use buildRefTree directly ──
  const _ePage = engine.getPage(sessionId);
  if (_ePage) {
    try {
      const snapshot = await _captureEngineSnapshot(sessionId, _ePage);
      if (snapshot) return { ok: true, stdout: snapshot.yaml, snapshotText: snapshot.yaml, executionTime: 0, generation: snapshot.generation, activeElement: snapshot.activeElement || null, scannerUsed: snapshot.scannerUsed || false };
    } catch (e) {
      logger.warn(`[browser.act] captureSnapshot (engine) failed: ${e.message}`);
      return _engineActionFailure('snapshot', sessionId, `Engine snapshot failed: ${e.message}`, { engineHealthFailure: true });
    }
  }
  // ── CLI fallback ──
  const res = await cliRun([...sessionFlags(sessionId, headed), 'snapshot'], timeoutMs);
  let snapshotText = res.stdout || '';
  const fileMatch = snapshotText.match(/\[Snapshot\]\(([^)]+\.yml)\)/);
  if (fileMatch) {
    try {
      const ymlPath = path.resolve(process.cwd(), fileMatch[1]);
      snapshotText = fs.readFileSync(ymlPath, 'utf8');
    } catch (_) {}
  }
  if (snapshotText) {
    snapshotCache.set(_tabKey(sessionId), snapshotText);
    storeSnapshotForDebugging(sessionId, snapshotText);
  }
  res.snapshotText = snapshotText;
  return res;
}

// ── Element ref resolution ────────────────────────────────────────────────
// Roles that are interactive input types — what we want to fill into
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'input', 'textarea']);
// Context patterns that indicate nav/sidebar/history elements — deprioritise these
const EXCLUDE_CONTEXT = /search.{0,20}(chat|history|conversation|message)|filter|sidebar|nav\b|navigation|recent|previous/i;

// Parse snapshot YAML lines into structured candidate objects.
// Handles two formats emitted by ariaSnapshot:
//   Format A (old stdout):  "  - [e12] link "Bible Study" [href=...]"
//   Format B (.yml file):   "    - link "Bible Study" [ref=e52] [cursor=pointer]:"
//   Format C (no label):    "    - textbox [ref=e52]"
function parseSnapshotCandidates(snap) {
  const candidates = [];
  const lines = snap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let indent = '', ref = null, role = '', label = '', attrs = '';

    // Format A: optional indent + dash + [eN] BEFORE role + "label" + optional attrs
    const mA = line.match(/^(\s*)-?\s*\[?(e\d+)\]?\s+(\w[\w-]*)\s+"([^"]*)"(.*)/i);
    if (mA) {
      [, indent, ref, role, label, attrs] = mA;
    } else {
      // Format B (.yml): optional indent + dash + role + optional "label" + optional attrs
      // ref appears in attrs as [ref=eN]
      const mB = line.match(/^(\s*)-\s+(\w[\w-]*)(?:\s+"([^"]*)")?(.*)/i);
      if (mB) {
        [, indent, role, label, attrs] = mB;
        label = label || '';
        // Extract [ref=eN] from attrs if present
        const refMatch = attrs && attrs.match(/\[ref=(e\d+)\]/i);
        ref = refMatch ? refMatch[1] : `line_${i}`;
      }
    }

    if (!role) continue;
    // Skip lines that are just attribute continuations (e.g. "- /url: ...")
    if (role.startsWith('/')) continue;
    candidates.push({
      ref,
      role: role.toLowerCase(),
      label,
      attrs,
      depth: indent.length,
      lineIndex: i,
    });
  }
  return candidates;
}

// Score a candidate element for FILL — textboxes preferred, links/buttons excluded
function scoreCandidateForFill(cand, selectorLabel) {
  const needle = selectorLabel.toLowerCase().trim();
  const label = cand.label.toLowerCase();
  const role = cand.role;
  const context = (cand.label + ' ' + (cand.attrs || '')).toLowerCase();

  // Hard exclude: non-interactive roles we can never type into
  const NON_INTERACTIVE = new Set(['link', 'button', 'img', 'image', 'heading',
    'listitem', 'list', 'article', 'region', 'banner', 'navigation', 'main',
    'complementary', 'contentinfo', 'dialog', 'alertdialog', 'status', 'log',
    'marquee', 'timer', 'alert', 'tooltip', 'menu', 'menuitem', 'menubar',
    'tab', 'tabpanel', 'tablist', 'tree', 'treeitem', 'grid', 'row', 'cell',
    'columnheader', 'rowheader', 'table', 'separator', 'scrollbar', 'slider',
    'spinbutton', 'progressbar', 'meter', 'figure', 'definition',
    'term', 'note', 'code', 'math', 'presentation', 'none']);
  if (NON_INTERACTIVE.has(role)) return -Infinity;

  // Hard exclude: history/nav/filter context
  if (EXCLUDE_CONTEXT.test(context)) return -Infinity;

  let score = 0;

  // Role bonus — textbox/combobox/searchbox are the right type for fill
  if (INPUT_ROLES.has(role)) score += 100;
  else if (role === 'generic' || role === 'text') score += 10;

  // Label match
  if (label === needle) score += 200;
  else if (label.startsWith(needle)) score += 150;
  else if (label.includes(needle)) score += 100;
  else {
    const needleTokens = needle.split(/\W+/).filter(Boolean);
    const labelTokens = label.split(/\W+/).filter(Boolean);
    const overlap = needleTokens.filter(t => labelTokens.includes(t)).length;
    if (overlap > 0) score += overlap * 30;
  }

  // Penalize subscribe/newsletter "sign-up email" boxes — NOT actual login email inputs.
  // A plain "email" label on a login form (e.g. Google's "Email or phone") should NOT be
  // penalized. Only penalize when the label clearly indicates a newsletter/subscribe context
  // AND the selector is not explicitly targeting an email-type input.
  const SUBSCRIBE_FIELD = /\b(subscribe|newsletter|sign[\s-]?up|your\s+email|enter.*email|email.*here)\b/i;
  const selectorIsEmailInput = /type[=\s'"]*email|name[=\s'"]*(?:email|identifier|username)|autocomplete[=\s'"]*(?:email|username)/i.test(needle);
  if (SUBSCRIBE_FIELD.test(label) && !selectorIsEmailInput) score -= 150;
  // Bonus when selector explicitly targets an email/login input AND the label confirms it
  if (selectorIsEmailInput && /\b(email|phone|username|identifier)\b/i.test(label)) score += 100;

  score -= Math.min(cand.depth * 0.5, 20);
  if (score <= 0) return -Infinity;
  return score;
}

// Score a candidate element for CLICK — links and buttons are preferred targets
function scoreCandidateForClick(cand, selectorLabel) {
  const needle = selectorLabel.toLowerCase().trim();
  const label = cand.label.toLowerCase();
  const role = cand.role;

  // For click: links and buttons are the BEST targets, not excluded
  const CLICK_ROLES = new Set(['link', 'button', 'menuitem', 'option', 'tab', 'treeitem']);
  // Hard exclude: purely decorative/structural roles
  const STRUCTURAL = new Set(['img', 'image', 'heading', 'list', 'article', 'region', 'banner',
    'navigation', 'main', 'complementary', 'contentinfo', 'separator',
    'progressbar', 'scrollbar', 'meter', 'figure', 'definition', 'term',
    'note', 'code', 'math', 'presentation', 'none']);
  if (STRUCTURAL.has(role)) return -Infinity;

  let score = 0;

  // Role bonus for click targets
  if (CLICK_ROLES.has(role)) score += 100;
  else if (INPUT_ROLES.has(role)) score += 40; // inputs can be clicked too
  else if (role === 'generic' || role === 'text') score += 5;

  // Label match — try full needle first, then progressive prefix (drops trailing noise words)
  if (label === needle) {
    score += 300;
  } else if (label.startsWith(needle) || needle.startsWith(label)) {
    // "Bible Study" startsWith "Bible" — but require label covers >50% of needle chars
    // to avoid "New" matching "New project in ChatGPT"
    const coverage = Math.min(label.length, needle.length) / Math.max(label.length, needle.length);
    score += coverage >= 0.5 ? 200 : 80;
  } else {
    // Token overlap — handles "Bible Study Project" → "Bible Study"
    const needleTokens = needle.split(/\W+/).filter(Boolean);
    const labelTokens = label.split(/\W+/).filter(Boolean);
    const overlap = needleTokens.filter(t => labelTokens.includes(t)).length;
    if (overlap > 0 && labelTokens.length > 0) {
      // Score proportional to how much of the LABEL is covered by needle tokens
      // Full label coverage = all label tokens appear in needle = strong signal (e.g. "Bible Study" in "Bible Study Project")
      const labelCoverage = overlap / labelTokens.length;
      // Also require the label is at least 4 chars to prevent "New", "App" etc. matching everything
      if (label.length >= 4) {
        score += Math.round(labelCoverage * 180);
      } else {
        // Short labels only score if they're a perfect full match (handled above) or exact token
        score += overlap === needleTokens.length ? 60 : 0;
      }
    }
  }

  score -= Math.min(cand.depth * 0.5, 20);
  if (score <= 0) return -Infinity;
  return score;
}

// Backward-compat alias used by fill path
function scoreCandidateForSelector(cand, selectorLabel) {
  return scoreCandidateForFill(cand, selectorLabel);
}

// Synchronous resolver for FILL: returns best ref or null
function resolveRef(sessionId, labelOrRef) {
  if (!labelOrRef) return null;
  // Strip [ref=eNNN] wrapper → honor exact ref directly, bypass fuzzy scoring
  const refBracketMatch = labelOrRef.trim().match(/^\[ref=(e\d+)\]$/i);
  if (refBracketMatch) return refBracketMatch[1];
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(_tabKey(sessionId)) || '';
  if (!snap) return null;

  const candidates = parseSnapshotCandidates(snap);
  let best = null, bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidateForFill(cand, labelOrRef);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && bestScore > 0) {
    logger.info(`[browser.act] resolveRef "${labelOrRef}" → ${best.ref} (${best.role} "${best.label}" score=${bestScore})`);
    return best.ref;
  }
  return null;
}

// Synchronous resolver for CLICK: scores links/buttons as preferred
// Returns { ref, label } so callers can use the matched label even when ref is synthetic.
function resolveRefForClick(sessionId, labelOrRef) {
  if (!labelOrRef) return { ref: null, label: null };
  // Strip [ref=eNNN] wrapper → honor exact ref directly, bypass fuzzy scoring
  const refBracketMatch = labelOrRef.trim().match(/^\[ref=(e\d+)\]$/i);
  if (refBracketMatch) return { ref: refBracketMatch[1], label: refBracketMatch[1] };
  if (/^e\d+$/i.test(labelOrRef.trim())) return { ref: labelOrRef.trim(), label: labelOrRef.trim() };
  // CSS attribute/pseudo selectors (e.g. div[aria-label='Message Body'], button.send, #id)
  // must be passed directly to the engine — fuzzy scoring against snapshot text
  // will mis-resolve them (e.g. matching 'body' in 'Message Body' to 'Create new label').
  if (/[\[\]#.>:()"'=~^$*|]/.test(labelOrRef.trim())) return { ref: null, label: null };

  const snap = snapshotCache.get(_tabKey(sessionId)) || '';
  if (!snap) return { ref: null, label: null };

  const candidates = parseSnapshotCandidates(snap);
  let best = null, bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidateForClick(cand, labelOrRef);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && bestScore > 0) {
    logger.info(`[browser.act] resolveRefForClick "${labelOrRef}" → ${best.ref} (${best.role} "${best.label}" score=${bestScore})`);
    return { ref: best.ref, label: best.label };
  }
  return { ref: null, label: null };
}

// ── Semantic selector derivation + probe-then-commit ──────────────────────────
// Derives stable CSS selectors from a refMap entry's name/role.
// These often work better than getByRole for contenteditable hybrids, custom
// widgets, and shadow DOM elements where the ARIA snapshot ref is unreliable.
function _deriveSemanticSelectors(entry, action) {
  if (!entry) return [];
  const selectors = [];
  const name = entry.name || '';
  const role = (entry.role || '').toLowerCase();
  const isInputRole = INPUT_ROLES.has(role) || role === 'generic' || role === 'unknown';

  // Extract key words from the entry name (skip common noise words)
  const STOP_WORDS = new Set(['the', 'a', 'an', 'your', 'enter', 'type', 'click', 'here', 'this', 'field', 'input', 'box', 'text', 'area']);
  const keyWords = (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 3);

  // Build aria-label selectors from key words
  for (const kw of keyWords) {
    selectors.push(`[aria-label*="${kw}" i]`);
  }
  // Build placeholder selectors from key words
  for (const kw of keyWords) {
    selectors.push(`[placeholder*="${kw}" i]`);
  }
  // Build title attribute selectors from key words
  for (const kw of keyWords) {
    selectors.push(`[title*="${kw}" i]`);
  }

  // Contenteditable selectors for textbox/editable roles
  if (isInputRole) {
    selectors.push('[contenteditable="true"]:visible');
    selectors.push('[contenteditable]:visible');
  }

  // De-duplicate
  return [...new Set(selectors)];
}

// Probe: check which semantic selectors match ≥1 visible element on the page.
// Returns an array of matching selectors (in priority order) or empty array.
// Runs in a single page.evaluate — near-instant, no timeout risk.
async function _probeSemanticSelectors(page, selectors) {
  if (!page || !selectors || selectors.length === 0) return [];
  try {
    const probeCode = `(() => {
      const sels = ${JSON.stringify(selectors)};
      const results = [];
      for (const sel of sels) {
        try {
          const els = document.querySelectorAll(sel);
          let visibleCount = 0;
          for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) { visibleCount++; break; }
          }
          if (visibleCount > 0) results.push(sel);
        } catch (_) {}
      }
      return JSON.stringify(results);
    })()`;
    const result = await page.evaluate(probeCode, { timeout: 3000 }).catch(() => null);
    if (!result) return [];
    const matched = JSON.parse(String(result).replace(/^"|"$/g, '').replace(/\\"/g, '"'));
    return Array.isArray(matched) ? matched : [];
  } catch (_) {
    return [];
  }
}

// Detect if an element is a microphone/voice search button based on its properties
// Works with parsed snapshot candidates (label, role, attrs) or DOM elements (ariaLabel, title, html)
function _isMicrophoneButton(element) {
  if (!element) return false;
  
  // Handle both parsed snapshot candidates and DOM element formats
  const label = (element.label || '').toLowerCase();
  const ariaLabel = (element.ariaLabel || element.aria_label || '').toLowerCase();
  const title = (element.title || '').toLowerCase();
  const role = (element.role || '').toLowerCase();
  const attrs = (element.attrs || '').toLowerCase();
  
  // Check for microphone/voice related labels in any text property
  const voiceKeywords = ['microphone', 'mic', 'voice', 'audio', 'speak', 'speech'];
  const hasVoiceLabel = voiceKeywords.some(kw => 
    label.includes(kw) || 
    ariaLabel.includes(kw) || 
    title.includes(kw) ||
    attrs.includes(kw)
  );
  
  // Check for microphone icon indicators in element attributes/html
  // YouTube's mic button often has specific aria-labels or SVG icons
  const html = (element.html || '').toLowerCase();
  const hasMicIcon = html.includes('m9.6') || html.includes('voice') || attrs.includes('m9.6');
  
  return hasVoiceLabel || hasMicIcon;
}

// Filter out microphone buttons from candidates when purpose is "search"
function _filterMicrophoneButtons(candidates, purpose) {
  if (!candidates || candidates.length === 0) return candidates;
  if (purpose === 'voice-input' || purpose === 'audio') return candidates; // Allow mic for voice tasks
  
  // For search/find purposes, filter out microphone buttons
  const filtered = candidates.filter(c => !_isMicrophoneButton(c));
  if (filtered.length < candidates.length) {
    logger.info(`[browser.act] Filtered out ${candidates.length - filtered.length} microphone button(s) for purpose="${purpose}"`);
  }
  return filtered.length > 0 ? filtered : candidates; // Return original if all were filtered
}

// Get element details from snapshot cache by ref
function _getElementByRef(sessionId, ref) {
  const snap = snapshotCache.get(_tabKey(sessionId)) || '';
  if (!snap || !ref) return null;
  
  const candidates = parseSnapshotCandidates(snap);
  return candidates.find(c => c.ref === ref) || null;
}

// ---------------------------------------------------------------------------
// Main skill entry point
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gmail Attachment and Send Verification Functions
// ---------------------------------------------------------------------------

async function waitForAttachmentProcessing(sessionId, fileName) {
  logger.info(`[browser.act] waitForAttachmentProcessing: checking attachment for ${fileName}`);
  
  const baseName = path.basename(fileName, path.extname(fileName));
  const fileNameLower = baseName.toLowerCase();
  const fullFileNameLower = path.basename(fileName).toLowerCase();
  
  let attempts = 0;
  const maxAttempts = 15; // Increased from 10
  
  while (attempts < maxAttempts) {
    try {
      const snapshot = await captureSnapshot(sessionId, false, 5000);
      
      if (!snapshot.ok) {
        logger.warn(`[browser.act] waitForAttachmentProcessing: snapshot failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;
        continue;
      }
      
      const content = snapshot.stdout;
      const contentLower = content.toLowerCase();
      
      // Gmail-specific attachment indicators
      const gmailAttachmentPatterns = [
        // Filename variations
        fileNameLower,
        fullFileNameLower,
        `${fileNameLower}.txt`,
        `${baseName}`,
        
        // Gmail UI elements
        'data-tooltip="Remove attachment"',
        'aria-label="Remove attachment"',
        'data-tooltip*="attachment"',
        'aria-label*="attachment"',
        
        // Gmail attachment classes and elements
        'class="attachment"',
        'class*="attachment"',
        'div[role="button"][data-tooltip*="attachment"]',
        
        // Gmail filename display patterns
        `title="${fileNameLower}"`,
        `aria-label="${fileNameLower}"`,
        `title="${fullFileNameLower}"`,
        `aria-label="${fullFileNameLower}"`,
        
        // Download and attachment indicators
        'download',
        '1 attachment',
        'attachments',
        'file attached',
        'uploaded',
        
        // Generic indicators (fallback)
        'attachment',
        'attached'
      ];
      
      const hasAttachment = gmailAttachmentPatterns.some(pattern => {
        if (pattern.includes('*')) {
          // Handle wildcard patterns
          const regexPattern = pattern.replace(/\*/g, '.*');
          return new RegExp(regexPattern, 'i').test(content);
        }
        return content.includes(pattern) || contentLower.includes(pattern.toLowerCase());
      });
      
      if (hasAttachment) {
        logger.info(`[browser.act] waitForAttachmentProcessing: Gmail attachment detected for ${fileName} (attempt ${attempts + 1})`);
        // Additional wait for full processing
        await new Promise(resolve => setTimeout(resolve, 3000)); // Increased from 2000
        return true;
      }
      
      logger.debug(`[browser.act] waitForAttachmentProcessing: Gmail attachment not yet visible for ${fileName} (attempt ${attempts + 1})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    } catch (error) {
      logger.error(`[browser.act] waitForAttachmentProcessing: error checking attachment: ${error.message}`);
      attempts++;
    }
  }
  
  // Log debug information for troubleshooting
  try {
    const debugSnapshot = await captureSnapshot(sessionId, false, 5000);
    const preview = debugSnapshot.stdout?.substring(0, 500) || 'No content';
    logger.warn(`[browser.act] waitForAttachmentProcessing: timeout waiting for Gmail attachment ${fileName}. Content preview: ${preview}`);
  } catch (debugError) {
    logger.warn(`[browser.act] waitForAttachmentProcessing: timeout and debug snapshot failed: ${debugError.message}`);
  }
  
  return false;
}

async function verifyAttachmentPresent(sessionId, fileName) {
  try {
    const snapshot = await captureSnapshot(sessionId, false, 5000);
    
    if (!snapshot.ok) {
      logger.warn(`[browser.act] verifyAttachmentPresent: snapshot failed`);
      return false;
    }
    
    const content = snapshot.stdout;
    const contentLower = content.toLowerCase();
    const baseName = path.basename(fileName, path.extname(fileName));
    const fileNameLower = baseName.toLowerCase();
    const fullFileNameLower = path.basename(fileName).toLowerCase();
    
    // Enhanced Gmail attachment verification patterns
    const gmailAttachmentPatterns = [
      // Filename variations
      fileNameLower,
      fullFileNameLower,
      `${fileNameLower}.txt`,
      `${baseName}`,
      
      // Gmail UI elements
      'data-tooltip="Remove attachment"',
      'aria-label="Remove attachment"',
      'data-tooltip*="attachment"',
      'aria-label*="attachment"',
      
      // Gmail attachment classes and elements
      'class="attachment"',
      'class*="attachment"',
      'div[role="button"][data-tooltip*="attachment"]',
      
      // Gmail filename display patterns
      `title="${fileNameLower}"`,
      `aria-label="${fileNameLower}"`,
      `title="${fullFileNameLower}"`,
      `aria-label="${fullFileNameLower}"`,
      
      // Download and attachment indicators
      'download',
      '1 attachment',
      'attachments',
      'file attached',
      'uploaded',
      
      // HTML tag patterns
      `>${fileNameLower}<`,
      `"${fileNameLower}"`,
      `'${fileNameLower}'`,
      
      // Generic indicators
      'attachment',
      'attached'
    ];
    
    const isAttached = gmailAttachmentPatterns.some(pattern => {
      if (pattern.includes('*')) {
        // Handle wildcard patterns
        const regexPattern = pattern.replace(/\*/g, '.*');
        return new RegExp(regexPattern, 'i').test(content);
      }
      return content.includes(pattern) || contentLower.includes(pattern.toLowerCase());
    });
    
    logger.info(`[browser.act] verifyAttachmentPresent: ${fileName} Gmail attachment verified: ${isAttached}`);
    return isAttached;
  } catch (error) {
    logger.error(`[browser.act] verifyAttachmentPresent: error verifying Gmail attachment: ${error.message}`);
    return false;
  }
}

async function checkForGmailErrors(sessionId) {
  try {
    const snapshot = await captureSnapshot(sessionId, false, 5000);
    
    if (!snapshot.ok) {
      return 'snapshot_failed';
    }
    
    const content = snapshot.stdout.toLowerCase();
    
    // Common Gmail error messages
    const errorPatterns = [
      { pattern: 'attachment too large', message: 'attachment too large' },
      { pattern: 'failed to attach', message: 'failed to attach' },
      { pattern: 'unable to send', message: 'unable to send' },
      { pattern: 'message not sent', message: 'message not sent' },
      { pattern: 'please try again', message: 'please try again' },
      { pattern: 'error occurred', message: 'error occurred' },
      { pattern: 'some attachments', message: 'attachment issue' },
      { pattern: 'couldn\'t attach', message: 'couldn\'t attach' }
    ];
    
    for (const { pattern, message } of errorPatterns) {
      if (content.includes(pattern)) {
        logger.warn(`[browser.act] checkForGmailErrors: detected error: ${message}`);
        return message;
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`[browser.act] checkForGmailErrors: error checking for errors: ${error.message}`);
    return 'error_check_failed';
  }
}

async function sendEmailWithVerification(sessionId, sendSelector) {
  logger.info(`[browser.act] sendEmailWithVerification: pre-send validation + send for session=${sessionId}`);

  // ── Step 1: Pre-send validation ──────────────────────────────────────────
  // Run page.evaluate to verify: (a) at least 1 recipient chip, (b) subject non-empty,
  // (c) compose window is visible. Surface actionable errors before clicking Send.
  try {
    // ── Engine path ──
    const _ePage = engine.getPage(sessionId);
    if (_ePage) {
      const valData = await _ePage.evaluate(() => {
        const chips = document.querySelectorAll('[data-hovercard-id],[email],[data-name].vM,.vR,.afV');
        const recipientInput = document.querySelector('input[name="to"],textarea[name="to"]');
        const rawToText = (recipientInput?.value || '').trim();
        const hasChip = chips.length > 0;
        const hasRawTo = rawToText.length > 3 && rawToText.includes('@');
        const subject = (document.querySelector('input[name="subjectbox"]')?.value || '').trim();
        const body = (document.querySelector('div[aria-label="Message Body"]')?.innerText || '').trim();
        const composeVisible = !!document.querySelector('div[gh="cm"] + div, .T-I-KE, div[aria-label="New Message"], div[aria-label="Message"]');
        return { hasChip, hasRawTo, rawToText: rawToText.slice(0,50), subject: subject.slice(0,50), bodyLen: body.length, composeVisible };
      });
      if (valData) {
        if (!valData.hasChip && !valData.hasRawTo) {
          throw new Error('sendEmailWithVerification: No recipient chip confirmed — fill the To field and press Enter to create a chip before sending');
        }
        if (valData.hasRawTo && !valData.hasChip) {
          logger.warn(`[browser.act] sendEmailWithVerification: recipient "${valData.rawToText}" is raw text, not chip — pressing Enter to confirm`);
          await _ePage.keyboard.press('Enter').catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        }
        logger.info(`[browser.act] sendEmailWithVerification: validation ok (engine) — chips=${valData.hasChip}, subject="${valData.subject}", bodyLen=${valData.bodyLen}`);
      }
    } else {
    // ── CLI fallback ──
    const S = sessionFlags(sessionId, false);
    const validationCode = `async page => {
      return await page.evaluate(() => {
        const chips = document.querySelectorAll('[data-hovercard-id],[email],[data-name].vM,.vR,.afV');
        const recipientInput = document.querySelector('input[name="to"],textarea[name="to"]');
        const rawToText = (recipientInput?.value || '').trim();
        const hasChip = chips.length > 0;
        const hasRawTo = rawToText.length > 3 && rawToText.includes('@');
        const subject = (document.querySelector('input[name="subjectbox"]')?.value || '').trim();
        const body = (document.querySelector('div[aria-label="Message Body"]')?.innerText || '').trim();
        const composeVisible = !!document.querySelector('div[gh="cm"] + div, .T-I-KE, div[aria-label="New Message"], div[aria-label="Message"]');
        return JSON.stringify({ hasChip, hasRawTo, rawToText: rawToText.slice(0,50), subject: subject.slice(0,50), bodyLen: body.length, composeVisible });
      });
    }`;
    const valRes = await cliRun([...S, 'run-code', validationCode], 8000);
    if (valRes.ok && valRes.stdout) {
      let valData = null;
      try { valData = JSON.parse(valRes.stdout.trim().replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch (_) {}
      if (valData) {
        if (!valData.hasChip && !valData.hasRawTo) {
          throw new Error('sendEmailWithVerification: No recipient chip confirmed — fill the To field and press Enter to create a chip before sending');
        }
        if (valData.hasRawTo && !valData.hasChip) {
          logger.warn(`[browser.act] sendEmailWithVerification: recipient "${valData.rawToText}" is raw text, not chip — pressing Enter to confirm`);
          await cliRun([...S, 'press', 'Enter'], 3000).catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        }
        logger.info(`[browser.act] sendEmailWithVerification: validation ok — chips=${valData.hasChip}, subject="${valData.subject}", bodyLen=${valData.bodyLen}`);
      }
    }
    } // end CLI fallback
  } catch (valErr) {
    if (valErr.message.startsWith('sendEmailWithVerification:')) throw valErr; // re-throw actionable errors
    logger.warn(`[browser.act] sendEmailWithVerification: pre-send validation failed (non-fatal): ${valErr.message}`);
  }

  // ── Step 2: Click Send — multi-strategy ──────────────────────────────────
  const _ePage2 = engine.getPage(sessionId);
  let sendClicked = false;

  if (_ePage2) {
    // ── Engine path: try CSS selectors directly ──
    const sendSelectors = [
      sendSelector,
      'div[data-tooltip*="Send"]',
      'div[aria-label*="Send"]',
    ];
    for (const sel of sendSelectors) {
      if (!sel) continue;
      try {
        await _ePage2.click(sel, { timeout: 4000 });
        logger.info(`[browser.act] sendEmailWithVerification: send clicked (engine) via selector: ${sel}`);
        sendClicked = true;
        break;
      } catch (_) {}
    }
    if (!sendClicked) {
      try {
        await _ePage2.click('div[aria-label="Message Body"]', { timeout: 2000 }).catch(() => {});
        await _ePage2.keyboard.press('Control+Enter');
        logger.info(`[browser.act] sendEmailWithVerification: send clicked (engine) via Ctrl+Enter`);
        sendClicked = true;
      } catch (_) {}
    }
  } else {
  // ── CLI fallback ──
  const S = sessionFlags(sessionId, false);
  const sendStrategies = [
    { label: 'selector', fn: () => cliRun([...S, 'click', sendSelector], 5000) },
    { label: 'css-tooltip', fn: () => cliRun([...S, 'click', 'div[data-tooltip*="Send"]'], 4000) },
    { label: 'css-aria-send', fn: () => cliRun([...S, 'click', 'div[aria-label*="Send"]'], 4000) },
    { label: 'keyboard-ctrl-enter', fn: async () => {
      // Focus body first so Ctrl+Enter hits compose, not the browser
      await cliRun([...S, 'click', 'div[aria-label="Message Body"]'], 2000).catch(() => {});
      return cliRun([...S, 'press', 'Control+Enter'], 4000);
    }},
  ];

  for (const strategy of sendStrategies) {
    try {
      const res = await strategy.fn();
      if (res.ok) {
        logger.info(`[browser.act] sendEmailWithVerification: send clicked via ${strategy.label}`);
        sendClicked = true;
        break;
      }
      logger.warn(`[browser.act] sendEmailWithVerification: strategy "${strategy.label}" failed — trying next`);
    } catch (_) {}
  }
  } // end CLI fallback

  if (!sendClicked) {
    throw new Error('sendEmailWithVerification: all send strategies failed — could not locate or click Send button');
  }

  // ── Step 3: Wait for result — compose close OR dialog ───────────────────
  await new Promise(r => setTimeout(r, 1500));
  const postSnap = await captureSnapshot(sessionId, false, 8000);
  if (!postSnap.ok) {
    // Can't verify — assume sent since click succeeded
    logger.warn(`[browser.act] sendEmailWithVerification: post-send snapshot failed — assuming sent`);
    return true;
  }

  const snapText = (postSnap.stdout || '').toLowerCase();

  // ── Step 4: Detect and classify dialogs ─────────────────────────────────
  // "Send without subject?" / "Send without body?" → auto-accept (user intent to send)
  const isSendAnywayDialog = /send\s*anyway|send\s*without\s*(subject|text|body)|missing\s*subject|no\s*subject/i.test(postSnap.stdout || '');
  if (isSendAnywayDialog) {
    logger.info(`[browser.act] sendEmailWithVerification: "send anyway" dialog detected — auto-accepting`);
    // ── Engine path: accept dialog via page ──
    if (_ePage2) {
      _ePage2.once('dialog', async d => { await d.accept(); });
    }
    const acceptRes = _ePage2 ? { ok: true } : await cliRun([...sessionFlags(sessionId, false), 'dialog-accept'], 3000).catch(() => ({ ok: false }));
    if (!acceptRes.ok) {
      // Try clicking "Send" in the dialog text
      const _S = sessionFlags(sessionId, false);
      await cliRun([..._S, 'find-text', 'Send anyway'], 3000).catch(() => {});
      await cliRun([..._S, 'find-text', 'OK'], 3000).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1500));
    const afterAcceptSnap = await captureSnapshot(sessionId, false, 5000).catch(() => ({ ok: false }));
    const afterText = ((afterAcceptSnap.ok && afterAcceptSnap.stdout) || '').toLowerCase();
    const sentAfterAccept = /message sent|email sent|sent successfully/i.test(afterText) ||
      !/compose|new message/i.test(afterText);
    logger.info(`[browser.act] sendEmailWithVerification: sent after dialog accept: ${sentAfterAccept}`);
    return sentAfterAccept;
  }

  // "Address not recognized" → surface as structured error
  const isAddressError = /address.*not recognized|invalid.*address|couldn.t find.*user|no account found/i.test(postSnap.stdout || '');
  if (isAddressError) {
    const errMatch = (postSnap.stdout || '').match(/[^\n]*(?:address.*not recognized|invalid.*address|couldn.t find|no account found)[^\n]*/i);
    throw new Error(`sendEmailWithVerification: recipient address error — ${(errMatch?.[0] || 'address not recognized').trim()}`);
  }

  // ── Step 5: Confirm "Message sent" snackbar / compose closed ────────────
  const confirmedSent = /message sent|email sent|sent successfully|your message has been sent/i.test(postSnap.stdout || '');
  const composeGone = !/new message|compose.*window|aria-label="new message"/i.test(postSnap.stdout || '');
  const wasSent = confirmedSent || composeGone;

  if (wasSent) {
    logger.info(`[browser.act] sendEmailWithVerification: email sent (confirmedSent=${confirmedSent}, composeGone=${composeGone})`);
  } else {
    const gmailErr = await checkForGmailErrors(sessionId);
    if (gmailErr) throw new Error(`sendEmailWithVerification: Gmail error after send — ${gmailErr}`);
    throw new Error('sendEmailWithVerification: compose window still open with no confirmation — send may not have fired');
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main Browser Action Function
// ---------------------------------------------------------------------------

async function browserAct(args) {
  const {
    action,
    sessionId  = 'default',
    url,
    selector,
    text,
    key,
    value,
    dx = 0,
    dy = 100,
    width,
    height,
    filePath,
    headed     = true,
    timeoutMs  = 15000,
    authSuccessUrl: _authSuccessUrl,
    currentUrl,
    credentials,
    noAutofill = false,
    hostAliases,
    postAuthUrl,
    _progressCallbackUrl,
  } = args || {};
  let authSuccessUrl = _authSuccessUrl;

  const start = Date.now();

  if (!action) {
    return { ok: false, error: 'action is required', executionTime: 0 };
  }

  logger.info(`[browser.act] ${action} session=${sessionId}`, { url, selector, text, key });

  // Start debugging tracing if enabled and not upload action
  if (action !== 'upload' && shouldEnableDebugging(sessionId)) {
    await startSessionTracing(sessionId);
  }

  const S = sessionFlags(sessionId, headed);

  // Helper: run + return standardised result with debugging
  async function run(cmdArgs, label) {
    const actionStart = Date.now();
    if (engine.isSessionActive(sessionId)) {
      return _engineActionFailure(action, sessionId, `Engine owns session ${sessionId}; ${label} must use an engine-native action`, { executionTime: Date.now() - actionStart });
    }
    const res = await cliRun([...S, ...cmdArgs], timeoutMs);
    const executionTime = Date.now() - actionStart;
    
    logger.info(`[browser.act] ${label} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 200) });
    
    // Store action for debugging (skip if debugging disabled or upload to prevent hanging)
    if (action !== 'upload' && shouldEnableDebugging(sessionId)) {
      storeActionForDebugging(sessionId, {
        label,
        cmdArgs,
        result: res,
        executionTime,
        ok: res.ok
      });
      
      // Collect DevTools data after action execution (both success and failure)
      await collectDevToolsData(sessionId, action, res);
    }
    
    // If action failed, check for Chrome crash and capture debugging context
    if (!res.ok) {
      // Check if this is a Chrome crash
      const crashInfo = await detectAndHandleChromeCrash(sessionId, action, cmdArgs, res.error || res.stderr?.trim());
      
      const debugContext = await captureDebugContext(sessionId, {
        action,
        args: cmdArgs,
        error: crashInfo.crashDetected ? crashInfo.error : (res.error || res.stderr?.trim()),
        executionTime,
        crashDetected: crashInfo.crashDetected
      });
      
      logger.info(`[browser.act] Captured debug context for failed action: ${label}${crashInfo.crashDetected ? ' (Chrome crash detected)' : ''}`);
      
      // If Chrome crash detected, add special error info
      if (crashInfo.crashDetected) {
        return {
          ok: false,
          action,
          sessionId,
          executionTime,
          error: crashInfo.error,
          chromeCrash: true,
          debugContext
        };
      }
      
      // ── Auto-fallback to shell.run with playwright-cli ────────────────────
      // If browser action fails (not Chrome crash), try shell.run as fallback
      // This helps with YouTube extraction and other challenging scenarios
      if (!crashInfo.crashDetected && !res.ok) {
        logger.info(`[browser.act] Attempting fallback to shell.run for action: ${action}`);
        
        try {
          // Build playwright-cli command from session flags and command args
          const playwrightCmd = [
            'playwright-cli',
            '--session', sessionId,
            ...(headed ? [] : ['--headless']),
            ...cmdArgs
          ].join(' ');
          
          const fallbackResult = await shellRun.shellRun({
            command: playwrightCmd,
            timeout: timeoutMs + 10000, // Extra timeout for fallback
            workingDir: process.cwd()
          });
          
          if (fallbackResult.ok) {
            logger.info(`[browser.act] shell.run fallback succeeded for action: ${action}`);
            return {
              ok: true,
              action,
              sessionId,
              result: (fallbackResult.stdout || '').trim() || undefined,
              stdout: fallbackResult.stdout,
              executionTime: executionTime + (fallbackResult.executionTime || 0),
              fallback: 'shell.run',
              error: undefined
            };
          } else {
            logger.warn(`[browser.act] shell.run fallback failed: ${fallbackResult.error || fallbackResult.stderr}`);
          }
        } catch (fallbackError) {
          logger.error(`[browser.act] shell.run fallback error: ${fallbackError.message}`);
        }
      }
    }
    
    return {
      ok:            res.ok,
      action,
      sessionId,
      result:        (res.stdout || '').trim() || undefined,
      stdout:        res.stdout,
      executionTime: executionTime,
      error:         res.ok ? undefined : res.error || res.stderr?.trim(),
    };
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  // Fix 34/36: Placeholder-verify helper for fill action.
  // Declared outside the switch to avoid temporal dead zone errors when the
  // switch jumps directly to `case 'fill':` (const declarations before a case
  // label are not executed when the switch matches a later case).
  // Captures pre-snapshot (placeholder, pseudo-placeholder, value-before),
  // then post-snapshot (value-after), and checks all 3 PASS conditions:
  //   (a) text present in value/textContent
  //   (b) placeholder gone (attr removed / ql-blank removed / Draft.js placeholder gone)
  //   (c) pseudo-placeholder replaced (pre-value "Untitled document" → post-value includes typed text)
  // Returns { verified, actualValue, reason }
  const _fillPlaceholderVerify = async (_ePage, _typedText) => {
    try {
      const _preSnap = await _ePage.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const ph = el.getAttribute('placeholder') ||
          el.getAttribute('data-placeholder') ||
          el.getAttribute('aria-placeholder') || '';
        const draftPlaceholder = document.querySelector('.public-DraftEditorPlaceholder-inner');
        const draftPlaceholderText = draftPlaceholder ? (draftPlaceholder.textContent || '').trim() : '';
        const val = (el.value || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const tooltip = el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
        const pseudoPlaceholder = (val && (val === aria || val === tooltip)) ? val : '';
        return {
          placeholder: ph,
          draftPlaceholderText,
          hasBlankClass: el.classList.contains('ql-blank'),
          pseudoPlaceholder,
          valueBefore: (el.value || el.textContent || el.innerText || '').slice(0, 200),
        };
      }).catch(() => null);
      if (!_preSnap) return { verified: false, actualValue: '', reason: 'no pre-snapshot' };
      // Post-snapshot: re-read activeElement (fill already clicked, so focus is set)
      const _postSnap = await _ePage.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const ph = el.getAttribute('placeholder') ||
          el.getAttribute('data-placeholder') ||
          el.getAttribute('aria-placeholder') || '';
        const draftPlaceholder = document.querySelector('.public-DraftEditorPlaceholder-inner');
        const val = el.value || el.textContent || el.innerText || '';
        return {
          placeholderAfter: ph,
          hasBlankClass: el.classList.contains('ql-blank'),
          draftPlaceholderGone: !draftPlaceholder,
          valueAfter: val.slice(0, 500),
        };
      }).catch(() => null);
      if (!_postSnap) return { verified: false, actualValue: '', reason: 'no post-snapshot' };
      const _textPresent = _postSnap.valueAfter && _postSnap.valueAfter.includes(_typedText.slice(0, 50));
      const _placeholderGone = !!(
        (_preSnap.placeholder && _preSnap.placeholder.length > 0 && !_postSnap.placeholderAfter) ||
        (_preSnap.hasBlankClass && !_postSnap.hasBlankClass) ||
        (_preSnap.draftPlaceholderText && _postSnap.draftPlaceholderGone)
      );
      const _pseudoPlaceholderGone = !!(
        _preSnap.pseudoPlaceholder &&
        _preSnap.pseudoPlaceholder.length > 0 &&
        _postSnap.valueAfter !== _preSnap.pseudoPlaceholder &&
        _postSnap.valueAfter.includes(_typedText.slice(0, 50))
      );
      const _verified = _textPresent || _placeholderGone || _pseudoPlaceholderGone;
      return {
        verified: _verified,
        actualValue: _postSnap.valueAfter,
        reason: `textPresent=${_textPresent} placeholderGone=${_placeholderGone} pseudoPlaceholderGone=${_pseudoPlaceholderGone}`,
      };
    } catch (_err) {
      return { verified: false, actualValue: '', reason: `verify error: ${_err.message}` };
    }
  };

  switch (action) {

    case 'engine-handoff': {
      if (!args.engineHealthFailure) {
        return _engineActionFailure(action, sessionId, 'Engine handoff requires a confirmed engine health failure', { executionTime: Date.now() - start });
      }
      const handoff = await _handoffEngineToCli(sessionId);
      return { ...handoff, action, sessionId, executionTime: Date.now() - start };
    }

    // ── Navigation ──────────────────────────────────────────────────────────
    case 'navigate':
    case 'goto': {
      if (!url) return { ok: false, action, sessionId, error: 'url required for navigate', executionTime: 0 };
      // Guard: detect unresolved template variables (e.g., {{prev_stdout.besturl}})
      if (/\{\{[a-zA-Z_0-9.]+\}\}/.test(url)) {
        const unresolvedToken = (url.match(/\{\{[a-zA-Z_0-9.]+\}\}/) || [])[0];
        logger.error(`[browser.act] navigate: unresolved template variable ${unresolvedToken} in URL: ${url}`);
        return { ok: false, action, sessionId, error: `Unresolved template variable ${unresolvedToken} in URL. Use {{bestUrl}} for web.agent results, not {{prev_stdout.property}}.` };
      }
      // Sanitize: extract bare URL in case caller passes "Best URL: https://... — title" formatted text
      const _m = /https?:\/\/[^\s"'\`>\),]+/.exec(url);
      const sanitizedUrl = _m ? _m[0] : url;

      // Invalidate snapshot cache for current tab — the page is changing
      snapshotCache.delete(_tabKey(sessionId));
      lastFilledTarget.delete(sessionId);

      // ── Engine path (Node API) ──────────────────────────────────────────
      // Fast path: no subprocess, no daemon probing, no about:blank dance.
      // Ad-block init script is registered at launch time via context.addInitScript()
      // and persists automatically for all future navigations.
      if (_engineActive(sessionId) || !openSessions.has(sessionId)) {
        let page = await _ensureEngine(sessionId, headed);
        if (!page) {
          // Engine launch failed — likely "Opening in existing browser session".
          // Kill any Chrome holding this profile, clear the lock, and retry once.
          const _killed = killExistingChromeForProfile(sessionId);
          if (_killed) {
            logger.info(`[browser.act] navigate: killed conflicting Chrome for session=${sessionId} — retrying engine launch`);
            clearProfileLock(sessionId);
            await new Promise(r => setTimeout(r, 500));
            page = await _ensureEngine(sessionId, headed);
          }
        }
        if (page) {
          try {
            logger.info(`[browser.act] navigate (engine) ${sanitizedUrl} (session=${sessionId})`);
            await page.goto(sanitizedUrl, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) });
            openSessions.add(sessionId);
            // Inject CSS cosmetic ad-hiding (Layer 3) — non-blocking
            try { await page.evaluate(_AD_BLOCK_SCRIPT); } catch (_) {}
            return {
              ok: true,
              action,
              sessionId,
              url: sanitizedUrl,
              result: undefined,
              executionTime: Date.now() - start,
            };
          } catch (navErr) {
            logger.warn(`[browser.act] navigate (engine) failed: ${navErr.message} — falling back to CLI`);
            // Fall through to CLI path
          }
        }
      }

      // ── CLI fallback path (playwright-cli subprocess) ───────────────────
      const navTimeout = Math.max(timeoutMs, 30000);
      let alreadyOpen = openSessions.has(sessionId);
      if (!alreadyOpen) {
        alreadyOpen = await isDaemonAlive(sessionId, headed);
        if (alreadyOpen) {
          openSessions.add(sessionId);
          logger.info(`[browser.act] navigate: daemon alive for session=${sessionId} (post-restart probe) — using goto`);
        }
      }
      if (!alreadyOpen) {
        const killed = killExistingChromeForProfile(sessionId);
        if (killed) logger.info(`[browser.act] Killed existing Chrome for session=${sessionId}, will cold-start fresh`);
      }
      if (!alreadyOpen) clearProfileLock(sessionId);

      let res;
      if (!alreadyOpen) {
        const openRes = await cliRun([...S, 'open', ...openFlags(), 'about:blank'], Math.min(navTimeout, 15000));
        if (openRes.ok) {
          openSessions.add(sessionId);
          await setupInterception(cliRun, sessionFlags, sessionId, headed);
          res = await cliRun([...S, 'goto', sanitizedUrl], navTimeout);
        } else {
          res = openRes;
        }
      } else {
        await cliRun([...S, 'goto', 'about:blank'], 5000);
        await setupInterception(cliRun, sessionFlags, sessionId, headed);
        res = await cliRun([...S, 'goto', sanitizedUrl], navTimeout);
      }
      if (res.ok) {
        openSessions.add(sessionId);
        if (!alreadyOpen) {
          const probeSnap = await cliRun([...S, 'snapshot'], 4000).catch(() => null);
          const probeText = (probeSnap?.stdout || '').toLowerCase();
          const RESTORE_DIALOG = /restore pages\?|chrome didn't shut down correctly|help make google chrome better/i;
          if (RESTORE_DIALOG.test(probeText)) {
            logger.info(`[browser.act] cold-start: Chrome restore dialog detected — sending goto ${sanitizedUrl} to dismiss`);
            await cliRun([...S, 'goto', sanitizedUrl], navTimeout).catch(() => {});
          }
        }
        const permissionProbe = await cliRun([...S, 'snapshot'], 3000).catch(() => null);
        const permissionText = (permissionProbe?.stdout || '').toLowerCase();
        const PERMISSION_DIALOG = /wants to|would like to|permission|microphone|camera|notifications/i;
        if (PERMISSION_DIALOG.test(permissionText)) {
          logger.info(`[browser.act] Permission dialog detected — dismissing with Escape`);
          await cliRun([...S, 'press', 'Escape'], 2000).catch(() => {});
          await new Promise(r => setTimeout(r, 200));
          await cliRun([...S, 'press', 'Tab'], 2000).catch(() => {});
        }
        try {
          const _urlProbe = await cliRun([...S, 'eval', 'window.location.href'], 3000);
          const _rawProbe = (_urlProbe.stdout || '').trim();
          const _probeMatch = _rawProbe.match(/^([\s\S]*?)(?=###\s|$)/i);
          const _curUrl = (_probeMatch ? _probeMatch[1] : _rawProbe).trim().replace(/^"|"$/g, '');
          if (/about:blank/i.test(_curUrl)) {
            logger.warn(`[browser.act] navigate: command succeeded but current URL is about:blank (session=${sessionId})`);
          }
        } catch (_) {}
        closeBlankTabs(sessionId, headed).catch(() => {});
        injectAdBlock(sessionId, headed).catch(() => {});
      } else if (alreadyOpen && !res.ok) {
        logger.info(`[browser.act] goto failed, killing Chrome and retrying with open for session=${sessionId}`);
        killExistingChromeForProfile(sessionId);
        await new Promise(r => setTimeout(r, 1000));
        clearProfileLock(sessionId);
        openSessions.delete(sessionId);
        clearAdBlockSession(sessionId);
        const retryOpenRes = await cliRun([...S, 'open', ...openFlags(), 'about:blank'], Math.min(navTimeout, 15000));
        let retryRes = retryOpenRes;
        if (retryOpenRes.ok) {
          openSessions.add(sessionId);
          await setupInterception(cliRun, sessionFlags, sessionId, headed);
          retryRes = await cliRun([...S, 'goto', url], navTimeout);
        }
        if (retryRes.ok) { openSessions.add(sessionId); }
        return {
          ok: retryRes.ok, action, sessionId,
          url: retryRes.ok ? url : undefined,
          result: (retryRes.stdout || '').trim() || undefined,
          executionTime: Date.now() - start,
          error: retryRes.ok ? undefined : retryRes.error || retryRes.stderr?.trim(),
        };
      }
      logger.info(`[browser.act] navigate ${url} → exit ${res.exitCode} (session=${sessionId})`, { stderr: res.stderr?.slice(0, 200) });
      return {
        ok: res.ok, action, sessionId,
        url: res.ok ? url : undefined,
        result: (res.stdout || '').trim() || undefined,
        executionTime: Date.now() - start,
        error: res.ok ? undefined : res.error || res.stderr?.trim(),
      };
    }

    case 'back': {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.goBack({ timeout: Math.max(timeoutMs, 15000) }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        catch (e) { logger.warn(`[browser.act] back (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['go-back'], 'go-back');
    }
    case 'forward': {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.goForward({ timeout: Math.max(timeoutMs, 15000) }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        catch (e) { logger.warn(`[browser.act] forward (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['go-forward'], 'go-forward');
    }
    case 'reload': {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 15000) }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        catch (e) { logger.warn(`[browser.act] reload (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['reload'], 'reload');
    }

    case 'close': {
      openSessions.delete(sessionId);
      // Close engine session if active
      if (engine.isSessionActive(sessionId)) {
        await engine.closeSession(sessionId);
      }
      // Also try CLI close (in case CLI daemon is running)
      const res = await cliRun([...S, 'close'], timeoutMs).catch(() => ({ ok: false }));
      for (const k of snapshotCache.keys()) { if (k.startsWith(`${sessionId}:`)) snapshotCache.delete(k); }
      currentTabIndex.delete(sessionId);
      _engineRefMaps.delete(sessionId);
      clearAdBlockSession(sessionId);
      return { ok: true, action, sessionId, executionTime: Date.now() - start, error: undefined };
    }

    case 'close-all': {
      const sessions = [...openSessions];
      // Also close engine sessions
      for (const sid of engine.listSessions()) {
        if (!sessions.includes(sid)) sessions.push(sid);
      }
      let closed = 0;
      for (const sid of sessions) {
        openSessions.delete(sid);
        if (engine.isSessionActive(sid)) {
          await engine.closeSession(sid);
          closed++;
        }
        const S2 = sessionFlags(sid);
        const res = await cliRun([...S2, 'close'], Math.min(timeoutMs, 8000)).catch(() => ({ ok: false }));
        if (res.ok && !engine.isSessionActive(sid)) closed++;
        for (const k of snapshotCache.keys()) { if (k.startsWith(`${sid}:`)) snapshotCache.delete(k); }
        currentTabIndex.delete(sid);
        _engineRefMaps.delete(sid);
        clearAdBlockSession(sid);
      }
      logger.info(`[browser.act] close-all: closed ${closed}/${sessions.length} sessions`);
      return { ok: true, action, closed, total: sessions.length, executionTime: Date.now() - start };
    }

    // ── Snapshot ─────────────────────────────────────────────────────────────
    case 'snapshot': {
      // ── Engine path ──
      const _enginePage = engine.getPage(sessionId);
      if (_enginePage) {
        try {
          const snapshot = await _captureEngineSnapshot(sessionId, _enginePage);
          if (snapshot) {
            return {
              ok: true,
              action,
              sessionId,
              result: snapshot.yaml,
              generation: snapshot.generation,
              activeElement: snapshot.activeElement || null,
              scannerUsed: snapshot.scannerUsed || false,
              executionTime: Date.now() - start,
            };
          }
        } catch (snapErr) {
          logger.warn(`[browser.act] snapshot (engine) failed: ${snapErr.message}`);
          return _engineActionFailure(action, sessionId, `Engine snapshot failed: ${snapErr.message}`, { engineHealthFailure: true, executionTime: Date.now() - start });
        }
      }

      // ── CLI fallback ──
      const res = await captureSnapshot(sessionId, headed, timeoutMs);
      const content = res.snapshotText || res.stdout || '';
      return {
        ok:            res.ok || !!content,
        action,
        sessionId,
        result:        content.trim(),
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── Click by CSS selector (real Playwright click for focus reset) ────────
    case 'clickSelector': {
      const selector = args?.selector || 'body';
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.click(selector, { timeout: 3000 });
          logger.info(`[browser.act] clickSelector "${selector}" ok (engine)`);
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (e) {
          logger.warn(`[browser.act] clickSelector "${selector}" failed: ${e.message}`);
          return { ok: false, action, sessionId, error: e.message, executionTime: Date.now() - start };
        }
      }
      return { ok: false, action, sessionId, error: 'No engine page for session', executionTime: Date.now() - start };
    }

    // ── Click at coordinates (real mouse click for focus reset) ──────────────
    case 'clickAt': {
      const cx = Number(args?.x);
      const cy = Number(args?.y);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        return { ok: false, action, sessionId, error: 'clickAt requires numeric x and y', executionTime: Date.now() - start };
      }
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.mouse.click(cx, cy);
          logger.info(`[browser.act] clickAt (${cx}, ${cy}) ok (engine)`);
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (e) {
          logger.warn(`[browser.act] clickAt (${cx}, ${cy}) failed: ${e.message}`);
          return { ok: false, action, sessionId, error: e.message, executionTime: Date.now() - start };
        }
      }
      return { ok: false, action, sessionId, error: 'No engine page for session', executionTime: Date.now() - start };
    }

    // ── Click ────────────────────────────────────────────────────────────────
    case 'click':
    case 'dblclick': {
      const cmd = action === 'dblclick' ? 'dblclick' : 'click';
      const clickPurpose = args?.purpose || args?.intent || 'default';
      const forceClick = args?.force === true;  // bypass actionability checks (overlay recovery)

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const { ref: cleanRef, entry: plannedEntry, stale } = _engineRefEntry(sessionId, _ePage, selector);
        if (stale) return _engineActionFailure(action, sessionId, `Stale ref ${cleanRef}: take a fresh snapshot and re-plan before clicking`, { staleRef: true, executionTime: Date.now() - start });
        if (cleanRef && !plannedEntry) return _engineActionFailure(action, sessionId, `Unresolvable ref ${cleanRef}: take a fresh snapshot and re-plan before clicking`, { staleRef: true, executionTime: Date.now() - start });
        const refMap = _engineSnapshots.get(sessionId)?.refMap || new Map();
        const _lowConfRefs = _engineSnapshots.get(sessionId)?.lowConfidenceRefs || false;

        // ── DOM scanner ref (tdN): use _tdRefClick with occlusion check + coordinate fallback ──
        if (cleanRef && _isTdRef(cleanRef) && refMap.has(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            if (entry.occluded) {
              logger.info(`[browser.act] click (engine) tdRef=${cleanRef} is marked occluded — trying _tdRefClick with fallbacks`);
            }
            const _tdClickOk = await _tdRefClick(_ePage, cleanRef, entry, cmd, forceClick, timeoutMs);
            if (_tdClickOk) {
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            }
            logger.warn(`[browser.act] click (engine) tdRef=${cleanRef} all strategies failed — falling through to CSS/eval`);
          }
        }

        if (cleanRef && refMap && !_lowConfRefs && !_isTdRef(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            // ── Probe-then-commit: try semantic CSS selectors before getByRole ──
            const _semSels = _deriveSemanticSelectors(entry, 'click');
            if (_semSels.length > 0) {
              const _matched = await _probeSemanticSelectors(_ePage, _semSels);
              if (_matched.length > 0) {
                for (const _sel of _matched) {
                  try {
                    if (cmd === 'dblclick') {
                      await _ePage.dblclick(_sel, { timeout: 5000, force: forceClick });
                    } else {
                      await _ePage.click(_sel, { timeout: 5000, force: forceClick });
                    }
                    logger.info(`[browser.act] click (engine) semantic="${_sel}" ok (ref=${cleanRef} bypassed${forceClick ? ' force' : ''})`);
                    return { ok: true, action, sessionId, executionTime: Date.now() - start };
                  } catch (_semErr) {
                    logger.debug(`[browser.act] click (engine) semantic="${_sel}" failed: ${_semErr.message} — trying next`);
                  }
                }
                logger.info(`[browser.act] click (engine) semantic selectors matched but click failed — falling through to getByRole`);
              }
            }
            // ── Fall through to getByRole (existing path) ──
            try {
              // Cap per-click timeout to avoid multi-minute hangs on a bad locator
              const clickTimeout = Math.min(timeoutMs, 15000);
              let locator;
              if ((entry.role === 'unknown' || entry.role === 'generic') && entry.name) {
                // ariaSnapshot omitted the role token; fall back to visible text match
                locator = _ePage.locator('*:visible').filter({ hasText: entry.name }).first();
              } else if (entry.name) {
                locator = _ePage.getByRole(entry.role, { name: entry.name }).first();
              } else {
                locator = _ePage.getByRole(entry.role).first();
              }
              if (cmd === 'dblclick') {
                await locator.dblclick({ timeout: clickTimeout, force: forceClick });
              } else {
                await locator.click({ timeout: clickTimeout, force: forceClick });
              }
              logger.info(`[browser.act] click (engine) ref=${cleanRef} role=${entry.role} name="${entry.name}" ok${forceClick ? ' (force)' : ''}`);
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            } catch (clickErr) {
              logger.warn(`[browser.act] click (engine) ref=${cleanRef} failed: ${clickErr.message} — trying CSS/eval fallback`);
            }
          }
        } else if (_lowConfRefs && cleanRef && refMap) {
          const entry = refMap.get(cleanRef);
          if (entry && entry.name) {
            try {
              const clickTimeout = Math.min(timeoutMs, 15000);
              const locator = _ePage.locator('*:visible').filter({ hasText: entry.name }).first();
              if (cmd === 'dblclick') {
                await locator.dblclick({ timeout: clickTimeout, force: forceClick });
              } else {
                await locator.click({ timeout: clickTimeout, force: forceClick });
              }
              logger.info(`[browser.act] click (engine) ref=${cleanRef} text="${entry.name}" (lowConf) ok${forceClick ? ' (force)' : ''}`);
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            } catch (textErr) {
              logger.warn(`[browser.act] click (engine) ref=${cleanRef} text fallback failed: ${textErr.message}`);
            }
          }
          logger.info(`[browser.act] click (engine) lowConfidenceRefs — no text fallback for ref=${cleanRef}, trying CSS/eval`);
        } else if (_lowConfRefs) {
          logger.info(`[browser.act] click (engine) lowConfidenceRefs — skipping role-based locators, using CSS/text fallback`);
        }

        // CSS selector path
        if (selector && /[\[\]#.>:()"'=~^$*|]/.test(selector.trim())) {
          try {
            // ── Try all matches + verify state change ──────────────────────────
            // When a CSS selector matches multiple elements (e.g. button:has-text('Post')
            // matches 3 Post buttons on LinkedIn), Playwright picks the first which may
            // be hidden. Instead: get all matches, force-click each, verify ANY state
            // change (URL, modal count, body text). First one that causes a state
            // change is the right button.
            const _cssLocator = _ePage.locator(selector);
            const _cssCount = await _cssLocator.count();
            if (_cssCount > 1 && cmd === 'click') {
              // Capture state before clicking
              const _stateBefore = await _ePage.evaluate(() => ({
                url: window.location.href,
                modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
                bodyLen: (document.body?.innerText || '').length,
              })).catch(() => ({ url: '', modalCount: 0, bodyLen: 0 }));
              logger.info(`[browser.act] click (engine) CSS="${selector}" matched ${_cssCount} elements — trying each with force + state verification`);

              let _clickedIdx = -1;
              for (let _ci = 0; _ci < _cssCount; _ci++) {
                try {
                  await _cssLocator.nth(_ci).click({ timeout: 5000, force: true });
                  // Wait briefly for state change to manifest
                  await new Promise(r => setTimeout(r, 500));
                  const _stateAfter = await _ePage.evaluate(() => ({
                    url: window.location.href,
                    modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
                    bodyLen: (document.body?.innerText || '').length,
                  })).catch(() => null);
                  if (_stateAfter) {
                    const _urlChanged = _stateAfter.url !== _stateBefore.url;
                    const _modalClosed = _stateAfter.modalCount < _stateBefore.modalCount;
                    const _contentChanged = Math.abs(_stateAfter.bodyLen - _stateBefore.bodyLen) > 50;
                    if (_urlChanged || _modalClosed || _contentChanged) {
                      _clickedIdx = _ci;
                      logger.info(`[browser.act] click (engine) CSS="${selector}" nth=${_ci} caused state change (url=${_urlChanged}, modal=${_modalClosed}, content=${_contentChanged}) — success`);
                      break;
                    }
                    logger.debug(`[browser.act] click (engine) CSS="${selector}" nth=${_ci} — no state change, trying next`);
                  }
                } catch (_nthErr) {
                  logger.debug(`[browser.act] click (engine) CSS="${selector}" nth=${_ci} click failed: ${_nthErr.message} — trying next`);
                }
              }
              if (_clickedIdx >= 0) {
                return { ok: true, action, sessionId, executionTime: Date.now() - start };
              }
              // All matches exhausted — fall through to error
              logger.warn(`[browser.act] click (engine) CSS="${selector}" — all ${_cssCount} matches clicked but no state change — falling back to CLI`);
            } else {
              // Single match (or dblclick) — cap visibility-wait to 8s, then force retry
              const _singleTimeout = Math.min(timeoutMs, 8000);
              try {
                if (cmd === 'dblclick') {
                  await _ePage.dblclick(selector, { timeout: _singleTimeout, force: forceClick });
                } else {
                  await _ePage.click(selector, { timeout: _singleTimeout, force: forceClick });
                }
                logger.info(`[browser.act] click (engine) CSS="${selector}" ok${forceClick ? ' (force)' : ''}`);
                return { ok: true, action, sessionId, executionTime: Date.now() - start };
              } catch (_singleErr) {
                // On "not visible"/timeout: retry with force:true + state-change verification
                if (cmd === 'click' && /not visible|not stable|timeout/i.test(_singleErr.message)) {
                  logger.info(`[browser.act] click (engine) CSS="${selector}" single-match failed (${_singleErr.message.slice(0, 60)}) — retrying with force + state verification`);
                  try {
                    // Capture state before force-click
                    const _stateBefore = await _ePage.evaluate(() => ({
                      url: window.location.href,
                      modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
                      bodyLen: (document.body?.innerText || '').length,
                    })).catch(() => ({ url: '', modalCount: 0, bodyLen: 0 }));
                    await _ePage.click(selector, { timeout: 3000, force: true });
                    await new Promise(r => setTimeout(r, 500));
                    const _stateAfter = await _ePage.evaluate(() => ({
                      url: window.location.href,
                      modalCount: document.querySelectorAll('[role="dialog"], #interop-outlet, .share-creation, [data-testid*="modal"], [data-testid*="share"]').length,
                      bodyLen: (document.body?.innerText || '').length,
                    })).catch(() => null);
                    if (_stateAfter) {
                      const _urlChanged = _stateAfter.url !== _stateBefore.url;
                      const _modalClosed = _stateAfter.modalCount < _stateBefore.modalCount;
                      const _contentChanged = Math.abs(_stateAfter.bodyLen - _stateBefore.bodyLen) > 50;
                      if (_urlChanged || _modalClosed || _contentChanged) {
                        logger.info(`[browser.act] click (engine) CSS="${selector}" force-click caused state change (url=${_urlChanged}, modal=${_modalClosed}, content=${_contentChanged}) — success`);
                        return { ok: true, action, sessionId, executionTime: Date.now() - start };
                      }
                    }
                    logger.warn(`[browser.act] click (engine) CSS="${selector}" force-click succeeded but no state change — falling back to CLI`);
                  } catch (_forceErr) {
                    logger.warn(`[browser.act] click (engine) CSS="${selector}" force-click failed: ${_forceErr.message} — falling back to CLI`);
                  }
                } else {
                  throw _singleErr;
                }
              }
            }
          } catch (cssErr) {
            logger.warn(`[browser.act] click (engine) CSS="${selector}" failed: ${cssErr.message} — falling back to CLI`);
          }
        }

        // Text-based click via page.evaluate (replaces eval-click CLI path)
        if (selector && !cleanRef) {
          try {
            const words = selector.trim().split(/\s+/);
            const tryTexts = [selector];
            for (let len = words.length; len >= 1; len--) {
              const t = words.slice(0, len).join(' ');
              if (!tryTexts.includes(t)) tryTexts.push(t);
            }
            const textsJson = JSON.stringify(tryTexts);
            const isSearchPurpose = clickPurpose === 'search' || clickPurpose === 'find' || clickPurpose === 'submit';
            const evalResult = await _ePage.evaluate(`(() => {
              const texts = ${textsJson};
              const CANDIDATES = 'a,button,input[type=submit],[role=button],[role=link],[role=menuitem],li';
              const isSearch = ${isSearchPurpose};
              const isMic = (el) => {
                const al = (el.getAttribute('aria-label') || '').toLowerCase();
                return ['microphone','mic','voice','audio','speak','speech'].some(k => al.includes(k));
              };
              for (const t of texts) {
                const tl = t.toLowerCase();
                const all = [...document.querySelectorAll(CANDIDATES)];
                const candidates = isSearch ? all.filter(e => !isMic(e)) : all;
                const el = candidates.find(e =>
                  (e.getAttribute('aria-label') || '').toLowerCase() === tl ||
                  e.textContent.trim().toLowerCase() === tl ||
                  e.textContent.trim().toLowerCase().startsWith(tl) ||
                  e.getAttribute('data-testid') === t ||
                  (e.getAttribute('name') || '').toLowerCase() === tl ||
                  (e.getAttribute('value') || '').toLowerCase() === tl
                ) || candidates.find(e => e.textContent.trim().length <= 50 && e.textContent.trim().toLowerCase().includes(tl));
                if (el) { el.click(); return 'clicked:' + t; }
              }
              return 'not-found';
            })()`);
            if (evalResult && evalResult.startsWith('clicked:') && evalResult !== 'clicked:form') {
              logger.info(`[browser.act] click (engine) eval → ${evalResult}`);
              return { ok: true, action, sessionId, result: evalResult, executionTime: Date.now() - start };
            }
            logger.warn(`[browser.act] click (engine) eval: not found for "${selector}" — falling back to CLI`);
          } catch (evalErr) {
            logger.warn(`[browser.act] click (engine) eval failed: ${evalErr.message} — falling back to CLI`);
          }
        }
      }

      // Engine owns session — no CLI fallback
      if (engine.isSessionActive(sessionId)) {
        return _engineActionFailure(action, sessionId, `Engine click failed for selector="${selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
      }

      // ── CLI fallback (full original path) ──
      await captureSnapshot(sessionId, headed, timeoutMs);
      
      // Get all candidates and filter out microphone buttons if purpose is search
      const snapText = snapshotCache.get(_tabKey(sessionId)) || '';
      let clickCandidates = snapText ? parseSnapshotCandidates(snapText) : [];
      if (clickCandidates.length > 0 && (clickPurpose === 'search' || clickPurpose === 'find' || clickPurpose === 'submit')) {
        const beforeCount = clickCandidates.length;
        clickCandidates = _filterMicrophoneButtons(clickCandidates, clickPurpose);
        if (clickCandidates.length < beforeCount) {
          logger.info(`[browser.act] click: filtered microphone buttons for purpose="${clickPurpose}"`);
        }
      }
      
      const { ref: rawRef, label: matchedLabel } = resolveRefForClick(sessionId, selector);
      
      // Check if resolved element is a microphone button for search purposes
      let finalRef = rawRef;
      let finalLabel = matchedLabel;
      const resolvedElement = rawRef ? _getElementByRef(sessionId, rawRef) : null;
      
      if (resolvedElement && _isMicrophoneButton(resolvedElement) && 
          (clickPurpose === 'search' || clickPurpose === 'find' || clickPurpose === 'submit')) {
        logger.info(`[browser.act] Resolved ref ${rawRef} is microphone button - finding alternative`);
        
        // Find alternative non-mic button
        const candidates = parseSnapshotCandidates(snapshotCache.get(_tabKey(sessionId)) || '');
        const alternative = candidates.find(c => {
          if (_isMicrophoneButton(c)) return false;
          // Prefer buttons near search boxes or with submit-like roles
          return ['button', 'submit'].includes(c.role?.toLowerCase()) ||
                 (c.label?.toLowerCase().includes('search'));
        });
        
        if (alternative) {
          logger.info(`[browser.act] Using alternative button ${alternative.ref} instead of mic button`);
          finalRef = alternative.ref;
          finalLabel = alternative.label;
        }
      }
      
      // Only use refs that playwright-cli actually understands (eN format).
      // Synthetic refs (line_N) come from the .yml file format — playwright-cli rejects them.
      const ref = finalRef && /^e\d+$/i.test(finalRef) ? finalRef : null;
      if (finalRef && !ref) {
        logger.info(`[browser.act] click: synthetic ref "${finalRef}" (matched label="${finalLabel}") — using eval-click fallback for "${selector}"`);
      }
      if (!ref) {
        // CSS selector path: try playwright-cli native click first.
        // Playwright supports: button:has-text("Post"), [aria-label="Save"], #id, etc.
        // resolveRefForClick already returns null for CSS selectors — this is the intended path.
        if (/[[\]#.>:()"'=~^$*|]/.test(selector.trim())) {
          logger.info(`[browser.act] click: trying native playwright selector "${selector}"`);
          const nativeRes = await run(['click', selector], `click ${selector}`);
          if (nativeRes.ok) return nativeRes;
          logger.warn(`[browser.act] click: native selector "${selector}" failed — falling back to eval-click`);
        }
        // No real eN ref — use eval fallback.
        // IMPORTANT: if resolveRefForClick already found a matched label (e.g. "Lemans" for selector "LeMans"),
        // use that as the first attempt so case/spacing differences don't cause miss.
        logger.warn(`[browser.act] click: could not resolve ref for "${selector}" — trying eval click (matchedLabel=${matchedLabel || 'none'})`);
        // Build attempts: matched label first, then word-drops of original selector
        const seen = new Set();
        const attempts = [];
        if (matchedLabel && matchedLabel !== selector) {
          attempts.push(matchedLabel);
          seen.add(matchedLabel.toLowerCase());
        }
        const words = selector.trim().split(/\s+/);
        for (let len = words.length; len >= 1; len--) {
          const t = words.slice(0, len).join(' ');
          if (!seen.has(t.toLowerCase())) { attempts.push(t); seen.add(t.toLowerCase()); }
        }
        // playwright-cli eval expects a FUNCTION expression: () => value
        // Case-insensitive matching so "LeMans" finds "Lemans", "lemans", etc.
        // NOTE: never use querySelector("[aria-label='...']") with dynamic values — single-quotes in
        // the value break the CSS selector syntax. Use getAttribute comparisons instead.
        const tryTexts = attempts.map(t => JSON.stringify(t)).join(', ');
        // Match priority: aria-label exact → textContent exact → textContent startsWith → textContent includes (for nested spans)
        // NO form-submit fallback: that was causing silent false-positives (clicked:form) when the real target wasn't found.
        // Two-pass strategy: pass 1 = strict (aria-label/exact/startsWith/data-testid), pass 2 = includes() but only on short-text elements (≤50 chars) to avoid matching long conversation titles that happen to contain the target text.
        // Microphone button avoidance: when purpose is search/find, skip elements with voice/mic related aria-labels
        const isSearchPurpose = clickPurpose === 'search' || clickPurpose === 'find' || clickPurpose === 'submit';
        const evalScript = `() => { 
          const texts = [${tryTexts}]; 
          const CANDIDATES = 'a,button,input[type=submit],[role=button],[role=link],[role=menuitem],li';
          const isSearch = ${isSearchPurpose};
          const isMic = (el) => {
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            return ['microphone','mic','voice','audio','speak','speech'].some(k => al.includes(k));
          };
          for (const t of texts) { 
            const tl = t.toLowerCase(); 
            const all = [...document.querySelectorAll(CANDIDATES)];
            const candidates = isSearch ? all.filter(e => !isMic(e)) : all;
            const el = candidates.find(e => (e.getAttribute('aria-label') || '').toLowerCase() === tl || (e.getAttribute('aria-label') || '') === t || e.textContent.trim().toLowerCase() === tl || e.textContent.trim().toLowerCase().startsWith(tl) || e.getAttribute('data-testid') === t || (e.getAttribute('name') || '').toLowerCase() === tl || (e.getAttribute('value') || '').toLowerCase() === tl) || candidates.find(e => e.textContent.trim().length <= 50 && e.textContent.trim().toLowerCase().includes(tl)); 
            if (el) { el.click(); return 'clicked:' + t; } 
          } 
          return 'not-found'; 
        }`;
        const evalRes = await cliRun([...S, 'eval', evalScript], timeoutMs);
        const evalRaw = (evalRes.stdout || '').trim();
        // playwright-cli echoes back the script source in "### Ran Playwright code" block
        // so we must extract ONLY the ### Result section to avoid false-positive 'not-found' match
        // playwright-cli output format: <result>\n### Ran Playwright code\n...
        // No "### Result" header exists — extract everything BEFORE the first ### header.
        const resultMatch = evalRaw.match(/^([\s\S]*?)(?=###\s|$)/i);
        const evalResult = resultMatch ? resultMatch[1].trim().replace(/^["']|["']$/g, '') : evalRaw.trim();
        // Use startsWith only — the actual result is always "clicked:<text>" or "not-found".
        // includes() would match the script source in the output (e.g. return 'clicked:' + t;).
        const clickSucceeded = evalResult.startsWith('clicked:') &&
          evalResult !== 'clicked:form' && evalResult !== 'clicked:form-submit';
        if (!clickSucceeded) {
          logger.warn(`[browser.act] eval-click: element not found for "${selector}" — result: ${evalResult.slice(0, 80)}`);
          return {
            ok: false,
            action,
            sessionId,
            result: evalRaw,
            executionTime: Date.now() - start,
            error: `Element not found: "${selector}" — could not locate a matching link, button, or item on the page`,
          };
        }
        logger.info(`[browser.act] eval-click "${selector}" → ${evalResult}`, { stderr: evalRes.stderr?.slice(0, 80) });
        return { ok: true, action, sessionId, result: evalResult, executionTime: Date.now() - start };
      }
      return run([cmd, ref], `${cmd} ${ref}`);
    }

    // ── Fill / Type ─────────────────────────────────────────────────────────
    case 'fill': {
      const fillText = (text ?? value) || '';
      const unresolvedCred = fillText.match(/\{\{[a-z0-9_.-]+:[a-z0-9_]+\}\}/i);
      if (unresolvedCred) {
        logger.warn(`[browser.act] fill: refusing unresolved credential token ${unresolvedCred[0]}`);
        return {
          ok: false, action, sessionId,
          loginWallDetected: true, needsCredentials: true,
          executionTime: Date.now() - start,
          error: `Unresolved credential token ${unresolvedCred[0]} — credentials must be resolved before fill`,
        };
      }
      const placeholderEmail = fillText.match(/\b(?:example@domain\.com|user@example\.com|your-email@gmail\.com)\b|<\s*email\s*>/i);
      if (placeholderEmail) {
        logger.warn(`[browser.act] fill: refusing placeholder email value ${placeholderEmail[0]}`);
        return {
          ok: false, action, sessionId,
          executionTime: Date.now() - start,
          error: `Placeholder recipient value rejected: ${placeholderEmail[0]}`,
        };
      }

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const { ref: cleanRef, entry: plannedEntry, stale } = _engineRefEntry(sessionId, _ePage, selector);
        if (stale) return _engineActionFailure(action, sessionId, `Stale ref ${cleanRef}: take a fresh snapshot and re-plan before filling`, { staleRef: true, executionTime: Date.now() - start });
        if (cleanRef && !plannedEntry) return _engineActionFailure(action, sessionId, `Unresolvable ref ${cleanRef}: take a fresh snapshot and re-plan before filling`, { staleRef: true, executionTime: Date.now() - start });
        const refMap = _engineSnapshots.get(sessionId)?.refMap || new Map();
        const _fillLowConf = _engineSnapshots.get(sessionId)?.lowConfidenceRefs || false;

        // ── DOM scanner ref (tdN): click via [data-td-ref] then type ──
        if (cleanRef && _isTdRef(cleanRef) && refMap.has(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            try {
              const fillClickTimeout = Math.min(timeoutMs, 15000);
              const tdSelector = `[data-td-ref="${cleanRef}"]`;
              // Click to focus
              try {
                await _ePage.click(tdSelector, { timeout: fillClickTimeout });
                logger.info(`[browser.act] fill (engine) tdRef=${cleanRef} click ok`);
              } catch (tdClickErr) {
                // Re-tag-on-miss (element may have been re-rendered)
                const reTaggedRef = await _reTagAndResolve(_ePage, cleanRef, entry);
                if (reTaggedRef && reTaggedRef !== cleanRef) {
                  await _ePage.click(`[data-td-ref="${reTaggedRef}"]`, { timeout: fillClickTimeout });
                  logger.info(`[browser.act] fill (engine) re-tagged tdRef=${reTaggedRef} click ok`);
                } else {
                  throw tdClickErr;
                }
              }
              // Detect field type and type accordingly
              const fieldType = await _ePage.evaluate(() => {
                const ae = document.activeElement;
                if (!ae) return 'normal';
                if (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT' &&
                    ae.getAttribute('aria-multiline') !== 'true' &&
                    (ae.isContentEditable ||
                     ae.getAttribute('role') === 'combobox' ||
                     ae.getAttribute('aria-autocomplete') !== null ||
                     !!ae.closest('[role=combobox]'))) {
                  if (ae.isContentEditable || ae.getAttribute('aria-multiline') === 'true') return 'rich-text';
                  return 'chip';
                }
                return 'normal';
              });
              if (fieldType === 'chip') {
                logger.info(`[browser.act] fill (engine) tdRef chip-detect: chip/combobox — skipping Meta+a`);
                await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
                await _ePage.keyboard.press('Tab');
              } else if (fieldType === 'rich-text') {
                // Use insertText for long text containing hashtags/mentions — character-by-character
                // typing triggers autocomplete popups (e.g. Facebook #hashtag suggestions) which
                // intercept keystrokes and cause the fill to fail verification.
                const _hasHashtags = /#\w{2,}/.test(fillText);
                const _isLongText = fillText.length > 200;
                if (_hasHashtags || _isLongText) {
                  logger.info(`[browser.act] fill (engine) tdRef rich-text-detect: contenteditable — using insertText (hashtags=${_hasHashtags}, len=${fillText.length})`);
                  await _ePage.keyboard.insertText(fillText);
                } else {
                  logger.info(`[browser.act] fill (engine) tdRef rich-text-detect: contenteditable — typing without Meta+a`);
                  await _ePage.keyboard.type(fillText, { delay: 10 });
                }
              } else {
                await _ePage.keyboard.press('Meta+a');
                await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
              }
              logger.info(`[browser.act] fill (engine) tdRef=${cleanRef} type ok`);
              // Fix 34: Placeholder-verify
              const _tdVerify = await _fillPlaceholderVerify(_ePage, fillText);
              logger.info(`[browser.act] fill (engine) tdRef=${cleanRef} verified=${_tdVerify.verified} (${_tdVerify.reason})`);
              lastFilledTarget.delete(sessionId);
              return { ok: true, action, sessionId, verified: _tdVerify.verified, actualValue: _tdVerify.actualValue, executionTime: Date.now() - start };
            } catch (tdFillErr) {
              logger.warn(`[browser.act] fill (engine) tdRef=${cleanRef} failed: ${tdFillErr.message} — falling through to ARIA/CSS`);
            }
          }
        }

        try {
          // Click to focus
          // Use a shorter timeout when the selector was inferred/hallucinated (no snapshot ref)
          // — 15s on a nonexistent element wastes budget. 4s is enough for a real element.
          const _isInferredSelector = !cleanRef || (cleanRef && !refMap?.has(cleanRef) && !_isTdRef(cleanRef));
          const fillClickTimeout = _isInferredSelector ? Math.min(timeoutMs, 4000) : Math.min(timeoutMs, 15000);
          if (cleanRef && refMap && !_fillLowConf && !_isTdRef(cleanRef)) {
            const entry = refMap.get(cleanRef);
            // ── Probe-then-commit: try semantic CSS selectors before getByRole ──
            if (entry) {
              const _semSels = _deriveSemanticSelectors(entry, 'fill');
              if (_semSels.length > 0) {
                const _matched = await _probeSemanticSelectors(_ePage, _semSels);
                if (_matched.length > 0) {
                  let _semClicked = false;
                  for (const _sel of _matched) {
                    try {
                      await _ePage.click(_sel, { timeout: 5000 });
                      logger.info(`[browser.act] fill (engine) semantic click="${_sel}" ok (ref=${cleanRef} bypassed)`);
                      _semClicked = true;
                      break;
                    } catch (_semErr) {
                      logger.debug(`[browser.act] fill (engine) semantic click="${_sel}" failed: ${_semErr.message} — trying next`);
                    }
                  }
                  if (_semClicked) {
                    // Skip getByRole focus — semantic click already focused the element
                    // Jump directly to field-type detection + type
                    const fieldType = await _ePage.evaluate(() => {
                      const ae = document.activeElement;
                      if (!ae) return 'normal';
                      if (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT' &&
                          ae.getAttribute('aria-multiline') !== 'true' &&
                          (ae.isContentEditable ||
                           ae.getAttribute('role') === 'combobox' ||
                           ae.getAttribute('aria-autocomplete') !== null ||
                           !!ae.closest('[role=combobox]'))) {
                        if (ae.isContentEditable || ae.getAttribute('aria-multiline') === 'true') {
                          return 'rich-text';
                        }
                        return 'chip';
                      }
                      return 'normal';
                    });
                    if (fieldType === 'chip') {
                      logger.info(`[browser.act] fill (engine) chip-detect: chip/combobox — skipping Meta+a`);
                      await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
                      await _ePage.keyboard.press('Tab');
                    } else if (fieldType === 'rich-text') {
                      logger.info(`[browser.act] fill (engine) rich-text-detect: contenteditable — typing without Meta+a`);
                      await _ePage.keyboard.type(fillText, { delay: 10 });
                    } else {
                      await _ePage.keyboard.press('Meta+a');
                      await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
                    }
                    logger.info(`[browser.act] fill (engine) semantic path ok`);
                    // Fix 34: Placeholder-verify
                    const _semVerify = await _fillPlaceholderVerify(_ePage, fillText);
                    logger.info(`[browser.act] fill (engine) semantic path verified=${_semVerify.verified} (${_semVerify.reason})`);
                    lastFilledTarget.delete(sessionId);
                    return { ok: true, action, sessionId, verified: _semVerify.verified, actualValue: _semVerify.actualValue, executionTime: Date.now() - start };
                  }
                  logger.info(`[browser.act] fill (engine) semantic selectors matched but click failed — falling through to getByRole`);
                }
              }
            }
            // ── Fall through to getByRole (existing path) ──
            if (entry && entry.name) {
              let clickLocator;
              if (entry.role === 'unknown' || entry.role === 'generic') {
                clickLocator = _ePage.locator('*:visible').filter({ hasText: entry.name }).first();
              } else {
                clickLocator = _ePage.getByRole(entry.role, { name: entry.name }).first();
              }
              await clickLocator.click({ timeout: fillClickTimeout });
            } else if (entry) {
              await _ePage.getByRole(entry.role).first().click({ timeout: fillClickTimeout });
            } else {
              await _ePage.click(selector, { timeout: fillClickTimeout });
            }
          } else {
            if (_fillLowConf && cleanRef && refMap) {
              const entry = refMap.get(cleanRef);
              if (entry && entry.name) {
                try {
                  const clickLocator = _ePage.locator('*:visible').filter({ hasText: entry.name }).first();
                  await clickLocator.click({ timeout: fillClickTimeout });
                  logger.info(`[browser.act] fill (engine) click ref=${cleanRef} text="${entry.name}" (lowConf) ok`);
                } catch (textErr) {
                  logger.warn(`[browser.act] fill (engine) text fallback failed: ${textErr.message} — trying CSS selector`);
                  await _ePage.click(selector, { timeout: fillClickTimeout });
                }
              } else {
                await _ePage.click(selector, { timeout: fillClickTimeout });
              }
            } else {
              if (_fillLowConf) logger.info(`[browser.act] fill (engine) lowConfidenceRefs — skipping role-based locators, using CSS selector`);
              await _ePage.click(selector, { timeout: fillClickTimeout });
            }
          }

          // Detect chip/combobox field AND contenteditable rich-text editors.
          // For contenteditable (LinkedIn/Gmail composers), skip Meta+a — it can
          // select text outside the editor (e.g. the entire page) and cause the
          // typed text to replace the wrong content. Instead, focus and type directly.
          const fieldType = await _ePage.evaluate(() => {
            const ae = document.activeElement;
            if (!ae) return 'normal';
            // Chip/combobox: non-standard input that needs Tab to commit
            if (ae.tagName !== 'TEXTAREA' && ae.tagName !== 'INPUT' &&
                ae.getAttribute('aria-multiline') !== 'true' &&
                (ae.isContentEditable ||
                 ae.getAttribute('role') === 'combobox' ||
                 ae.getAttribute('aria-autocomplete') !== null ||
                 !!ae.closest('[role=combobox]'))) {
              // Distinguish: contenteditable rich-text editor vs chip/combobox
              if (ae.isContentEditable || ae.getAttribute('aria-multiline') === 'true') {
                return 'rich-text';
              }
              return 'chip';
            }
            return 'normal';
          });

          if (fieldType === 'chip') {
            logger.info(`[browser.act] fill (engine) chip-detect: chip/combobox — skipping Meta+a`);
            await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
            await _ePage.keyboard.press('Tab');
          } else if (fieldType === 'rich-text') {
            // Contenteditable rich-text editor (LinkedIn, Gmail, Quill, DraftJS):
            // Focus is already set by the click. Type directly without Meta+a —
            // Meta+a can select text outside the editor on some sites.
            logger.info(`[browser.act] fill (engine) rich-text-detect: contenteditable — typing without Meta+a`);
            await _ePage.keyboard.type(fillText, { delay: 10 });
          } else {
            await _ePage.keyboard.press('Meta+a');
            await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
          }

          logger.info(`[browser.act] fill (engine) "${selector}" → ok`);
          // Fix 34: Placeholder-verify
          const _mainVerify = await _fillPlaceholderVerify(_ePage, fillText);
          logger.info(`[browser.act] fill (engine) "${selector}" verified=${_mainVerify.verified} (${_mainVerify.reason})`);
          lastFilledTarget.delete(sessionId);
          return { ok: true, action, sessionId, verified: _mainVerify.verified, actualValue: _mainVerify.actualValue, executionTime: Date.now() - start };
        } catch (fillErr) {
          logger.warn(`[browser.act] fill (engine) click failed: ${fillErr.message} — trying gated visible-input fallback`);
          // ── Gated visible-input fallback ──────────────────────────────────────
          // Only accept a candidate whose aria-label/placeholder/name shares a
          // meaningful token with the intended field (extracted from the selector).
          // Never accept "first visible editable" blindly — that caused the Google
          // Docs title to be typed into the document body.
          try {
            // Extract intent tokens from the requested selector (e.g., "title", "search", "name")
            const _intentTokens = (selector || '')
              .replace(/[[\]'"=*]/g, ' ')
              .split(/[\s,]+/)
              .map(w => w.toLowerCase().trim())
              .filter(w => w.length > 2 && !['input', 'textarea', 'text', 'type', 'role', 'aria', 'label', 'placeholder', 'contenteditable', 'true', 'false', 'visible', 'class', 'data', 'td', 'ref'].includes(w));

            // Find all visible editables and score them by token overlap with the intent
            const _candidates = await _ePage.evaluate((tokens) => {
              const editables = Array.from(document.querySelectorAll('input[type="text"], input[role="searchbox"], input[aria-label*="Search"], textarea, [contenteditable="true"], [contenteditable], [role="textbox"]'));
              return editables.map(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null; // not visible
                const attrs = [
                  el.getAttribute('aria-label') || '',
                  el.getAttribute('placeholder') || '',
                  el.getAttribute('aria-placeholder') || '',
                  el.getAttribute('name') || '',
                  el.getAttribute('id') || '',
                  el.getAttribute('title') || '',
                ].join(' ').toLowerCase();
                const overlap = tokens.filter(t => attrs.includes(t));
                return {
                  selector: el.id ? `#${el.id}` :
                    el.getAttribute('aria-label') ? `[aria-label="${el.getAttribute('aria-label')}"]` :
                    el.getAttribute('placeholder') ? `[placeholder="${el.getAttribute('placeholder')}"]` :
                    el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` :
                    el.tagName.toLowerCase(),
                  tag: el.tagName,
                  isInput: el.tagName === 'INPUT',
                  score: overlap.length,
                  label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || '',
                };
              }).filter(Boolean);
            }, _intentTokens).catch(() => []);

            // Only proceed if we have a candidate with at least 1 token overlap
            const _bestCandidate = Array.isArray(_candidates) && _candidates.length > 0
              ? _candidates.sort((a, b) => b.score - a.score)[0]
              : null;

            if (_bestCandidate && _bestCandidate.score > 0) {
              logger.info(`[browser.act] fill (engine) gated fallback: candidate="${_bestCandidate.selector}" label="${_bestCandidate.label}" score=${_bestCandidate.score}/${_intentTokens.length}`);
              await _ePage.click(_bestCandidate.selector, { timeout: 5000 });
              // Use fill() for input fields (more reliable than Meta+a + type)
              if (_bestCandidate.isInput) {
                await _ePage.fill(_bestCandidate.selector, fillText, { timeout: timeoutMs });
              } else if (/#\w{2,}/.test(fillText) || fillText.length > 200) {
                // insertText for long/hashtag text — avoids autocomplete popup interception
                await _ePage.keyboard.press('Meta+a');
                await _ePage.keyboard.insertText(fillText);
              } else {
                await _ePage.keyboard.press('Meta+a');
                await _ePage.keyboard.type(fillText, { timeout: timeoutMs });
              }
              // ── Verify the text landed ───────────────────────────────────────
              const _verifyResult = await _ePage.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return { verified: false, actual: '' };
                const actual = el.value || el.innerText || el.textContent || '';
                return { verified: actual.length > 0, actual: actual.slice(0, 200) };
              }, _bestCandidate.selector).catch(() => ({ verified: false, actual: '' }));

              if (_verifyResult.verified) {
                logger.info(`[browser.act] fill (engine) gated fallback verified: actual="${_verifyResult.actual.slice(0, 60)}"`);
                lastFilledTarget.delete(sessionId);
                return { ok: true, action, sessionId, verified: true, executionTime: Date.now() - start };
              } else {
                logger.warn(`[browser.act] fill (engine) gated fallback typed but verification failed — returning ok:false to trigger re-plan`);
                return _engineActionFailure(action, sessionId, `Fill fallback typed but could not verify text landed in "${_bestCandidate.selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
              }
            } else {
              logger.warn(`[browser.act] fill (engine) no gated fallback candidate with token overlap (intent tokens: ${_intentTokens.join(', ')}) — falling through`);
            }
          } catch (fallbackErr) {
            logger.warn(`[browser.act] fill (engine) gated visible-input fallback failed: ${fallbackErr.message}`);
          }
        }

        // ── Focus+type fallback: when click times out (React apps re-rendering,
        // Notion, Linear, Figma), try focusing the element via JS and typing directly.
        // This bypasses Playwright's actionability/stability checks which fail on
        // dynamically re-rendered elements.
        if (engine.isSessionActive(sessionId)) {
          try {
            // Resolve td-refs to [data-td-ref="..."] CSS selectors.
            const _rawSel = selector || args.selector;
            const _fbSel = (cleanRef && _isTdRef(cleanRef)) ? `[data-td-ref="${cleanRef}"]` : _rawSel;
            logger.info(`[browser.act] fill (engine) trying focus+type fallback for selector="${_fbSel}"`);
            const _focused = await _ePage.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (!el) return false;
              el.focus();
              return document.activeElement === el;
            }, _fbSel).catch(() => false);
            if (_focused) {
              // Clear existing content (Meta+a + Delete) then type
              await _ePage.keyboard.press('Meta+a').catch(() => {});
              await _ePage.keyboard.press('Delete').catch(() => {});
              // insertText for long/hashtag text — avoids autocomplete popup interception
              if (/#\w{2,}/.test(fillText) || fillText.length > 200) {
                await _ePage.keyboard.insertText(fillText);
              } else {
                await _ePage.keyboard.type(fillText, { delay: 20, timeout: Math.min(timeoutMs, 10000) });
              }
              // Verify by reading the element's own content (source of truth)
              const _actualVal = await _ePage.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return '';
                return (el.value || el.textContent || el.innerText || '').slice(0, 200);
              }, _fbSel).catch(() => '');
              const _verified = _actualVal.toLowerCase().includes(fillText.toLowerCase());
              logger.info(`[browser.act] fill (engine) focus+type fallback: typed ${fillText.length} chars, verified=${_verified}, actualValue="${_actualVal.slice(0, 80)}"`);
              if (_verified) {
                lastFilledTarget.delete(sessionId);
                return { ok: true, action, sessionId, method: 'focus-type-fallback', verified: true, executionTime: Date.now() - start };
              }
            }
          } catch (_focusTypeErr) {
            logger.warn(`[browser.act] fill (engine) focus+type fallback failed: ${_focusTypeErr.message}`);
          }
          return _engineActionFailure(action, sessionId, `Engine fill failed for selector="${selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
        }
      }

      // ── CLI fallback (full original path) ──
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawFillRef = resolveRef(sessionId, selector);
      const ref = rawFillRef && /^e\d+$/i.test(rawFillRef) ? rawFillRef : null;
      const fillTarget = ref || selector;
      logger.info(`[browser.act] fill resolved: "${selector}" → ${ref ? `ref ${ref}` : `direct selector "${selector}"`} (click+type strategy)`);

      // Step 1: click to focus
      const clickRes = await cliRun([...S, 'click', fillTarget], timeoutMs);
      logger.info(`[browser.act] fill click ${fillTarget} → exit ${clickRes.exitCode}`, { stderr: clickRes.stderr?.slice(0, 200) });

      const PLAYWRIGHT_HARD_ERR = /^### Error|TimeoutError:/im;
      if (PLAYWRIGHT_HARD_ERR.test(clickRes.stdout || '')) {
        const errMatch = (clickRes.stdout || '').match(/([A-Za-z]*Error:[^\n]+)/);
        const errMsg = errMatch ? errMatch[1].trim() : 'playwright-cli: element not clickable';
        logger.warn(`[browser.act] fill ${fillTarget}: click hard error — ${errMsg}`);
        return {
          ok: false, action, sessionId,
          result: (clickRes.stdout || '').trim(),
          stdout: clickRes.stdout,
          executionTime: Date.now() - start,
          error: errMsg,
        };
      }

      // Step 2: detect chip/combobox fields
      await new Promise(r => setTimeout(r, 100));
      const _chipProbe = await cliRun([...S, 'eval',
        'document.activeElement && ' +
        'document.activeElement.tagName !== "TEXTAREA" && ' +
        'document.activeElement.tagName !== "INPUT" && ' +
        'document.activeElement.getAttribute("aria-multiline") !== "true" && ' +
        '(document.activeElement.isContentEditable || ' +
        'document.activeElement.getAttribute("role") === "combobox" || ' +
        'document.activeElement.getAttribute("aria-autocomplete") !== null || ' +
        '!!document.activeElement.closest("[role=combobox]")) ? "chip" : "normal"'
      ], 2000).catch(() => null);
      const _chipRaw = (_chipProbe?.stdout || '').trim();
      const _chipResultMatch = _chipRaw.match(/^([\s\S]*?)(?=###\s|$)/i);
      const _isChipField = (_chipResultMatch ? _chipResultMatch[1] : _chipRaw).replace(/^["']|["']$/g, '') === 'chip';
      logger.info(`[browser.act] fill chip-detect: ${_isChipField ? 'chip/combobox — skipping Meta+a' : 'normal input'}`);

      let typeRes;
      if (_isChipField) {
        typeRes = await cliRun([...S, 'type', '--', fillText], timeoutMs);
        await cliRun([...S, 'press', 'Tab'], 2000).catch(() => {});
      } else {
        await cliRun([...S, 'press', 'Meta+a'], 3000).catch(() => {});
        typeRes = await cliRun([...S, 'type', '--', fillText], timeoutMs);
      }
      logger.info(`[browser.act] fill type → exit ${typeRes.exitCode}`, { stderr: typeRes.stderr?.slice(0, 200) });

      if (typeRes.ok) lastFilledTarget.delete(sessionId);
      return {
        ok: typeRes.ok,
        action, sessionId,
        result: (typeRes.stdout || '').trim() || undefined,
        stdout: typeRes.stdout,
        executionTime: Date.now() - start,
        error: typeRes.ok ? undefined : typeRes.error || typeRes.stderr?.trim(),
      };
    }

    case 'type': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        let _typeErr = null;
        try {
          const _typedText = text || '';

          // ── Snapshot-comparison verification (Fix 2) ──
          // Before typing: capture the focused element's placeholder + position (rect).
          // After typing: re-find the element at the SAME position and compare:
          //   (a) text present in textContent/value (primary, universal)
          //   (b) placeholder gone (bonus — Quill removes ql-blank class,
          //       Draft.js removes the placeholder element, Notion keeps the
          //       attribute but text replaces it).
          // Position-aware — solves "same placeholder in multiple places"
          // (e.g. Notion title "New Page" at top vs sidebar "New Page" at left).
          let _preSnap = null;
          if (_typedText.length > 0) {
            _preSnap = await _ePage.evaluate(() => {
              let el = document.activeElement;
              if (!el) return null;
              // ── Leaf detection for contenteditable wrappers ──
              // Same logic as _readActiveElement: if activeElement is a container
              // with contenteditable children, use the selection anchor to find
              // the actual focused leaf. This ensures hasContent checks the leaf's
              // text, not the container's (which would include title + body).
              if (el.isContentEditable) {
                try {
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) {
                    let node = sel.getRangeAt(0).startContainer;
                    if (node.nodeType === 3) node = node.parentElement;
                    while (node && !node.isContentEditable) node = node.parentElement;
                    if (node && node !== el && el.contains(node)) {
                      el = node;
                    }
                  }
                } catch (_) {}
              }
              const rect = el.getBoundingClientRect();
              const ph = el.getAttribute('placeholder') ||
                el.getAttribute('data-placeholder') ||
                el.getAttribute('aria-placeholder') || '';
              // Draft.js: check for sibling placeholder element
              const draftPlaceholder = document.querySelector('.public-DraftEditorPlaceholder-inner');
              const draftPlaceholderText = draftPlaceholder ? (draftPlaceholder.textContent || '').trim() : '';
              // Fix 30c: Pseudo-placeholder detection — value matches aria-label or data-tooltip
              // (Google Docs pattern: value="Untitled document" + aria-label="Untitled document")
              const val = (el.value || '').trim();
              const aria = el.getAttribute('aria-label') || '';
              const tooltip = el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
              const pseudoPlaceholder = (val && (val === aria || val === tooltip)) ? val : '';
              // hasContent: does the focused LEAF have actual content to replace?
              // NOT aria-label/placeholder — those are shown when the field is empty.
              // For containers (has contenteditable children): always false — Meta+a
              // would select the entire page (title + body), not just this field.
              const isContainer = el.querySelectorAll('[contenteditable="true"], [contenteditable=""]').length > 0;
              const actualContent = (el.value !== undefined && el.value !== ''
                ? String(el.value)
                : (el.isContentEditable ? (el.innerText || el.textContent || '') : '')
              ).trim();
              const hasContent = !isContainer && actualContent.length > 0;
              return {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                editable: el.isContentEditable,
                placeholder: ph,
                draftPlaceholderText,
                hasBlankClass: el.classList.contains('ql-blank'),
                pseudoPlaceholder, // Fix 30c
                hasContent,
                rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                textBefore: (el.value || el.textContent || el.innerText || '').slice(0, 200),
              };
            }).catch(() => null);
          }

          // Select all existing text before typing — prevents appending to
          // already-filled elements (e.g. Reddit's <post-composer-title> where
          // Tier 1.5 typed into a hidden syncing textarea, then Tier 2.5 types
          // again here, doubling the title).
          // Conditional: only Meta+a when the leaf has actual content (hasContent).
          // Skip for empty fields and containers — Meta+a in a container div
          // (e.g. Notion wrapper) selects the entire page (title + body).
          if (_typedText.length > 0 && _preSnap && _preSnap.hasContent) {
            await _ePage.keyboard.press('Meta+a').catch(() => {});
          }
          // insertText for long/hashtag text — avoids autocomplete popup interception
          if (/#\w{2,}/.test(_typedText) || _typedText.length > 200) {
            await _ePage.keyboard.insertText(_typedText);
          } else {
            await _ePage.keyboard.type(_typedText, { timeout: timeoutMs });
          }

          // After typing: re-find element at same position, compare
          if (_typedText.length > 0 && _preSnap) {
            const _postSnap = await _ePage.evaluate((pre) => {
              if (!pre) return null;
              // Re-find by position (most stable — refs may change after re-scan,
              // but position is stable). Find the editable element nearest the
              // original rect.
              const allEditables = Array.from(document.querySelectorAll(
                '[contenteditable="true"], [role="textbox"], input, textarea'
              ));
              let bestMatch = null;
              let bestDist = Infinity;
              for (const el of allEditables) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const dist = Math.abs(r.top - pre.rect.top) + Math.abs(r.left - pre.rect.left);
                if (dist < bestDist) {
                  bestDist = dist;
                  bestMatch = el;
                }
              }
              // Fallback to activeElement if no position match
              const el = bestMatch || document.activeElement;
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              const ph = el.getAttribute('placeholder') ||
                el.getAttribute('data-placeholder') ||
                el.getAttribute('aria-placeholder') || '';
              const draftPlaceholder = document.querySelector('.public-DraftEditorPlaceholder-inner');
              const val = el.value || el.textContent || el.innerText || '';
              return {
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                editable: el.isContentEditable,
                placeholderAfter: ph,
                hasBlankClass: el.classList.contains('ql-blank'),
                draftPlaceholderGone: !draftPlaceholder,
                value: val.slice(0, 500),
                rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                posMatch: bestDist < 50, // close to original position
              };
            }, _preSnap).catch(() => null);

            if (_postSnap) {
              const _textPresent = _postSnap.value && _postSnap.value.includes(_typedText.slice(0, 50));
              // Placeholder gone: (a) attribute removed, (b) ql-blank removed, (c) Draft.js placeholder element removed
              const _placeholderGone = !!(
                (_preSnap.placeholder && _preSnap.placeholder.length > 0 && !_postSnap.placeholderAfter) ||
                (_preSnap.hasBlankClass && !_postSnap.hasBlankClass) ||
                (_preSnap.draftPlaceholderText && _postSnap.draftPlaceholderGone)
              );
              // Fix 30c: Pseudo-placeholder replaced — pre value (e.g. "Untitled document")
              // changed to a different value that includes the typed text
              const _pseudoPlaceholderGone = !!(
                _preSnap.pseudoPlaceholder &&
                _preSnap.pseudoPlaceholder.length > 0 &&
                _postSnap.value !== _preSnap.pseudoPlaceholder &&
                _postSnap.value.includes(_typedText.slice(0, 50))
              );
              // PASS: text present (primary) OR placeholder gone OR pseudo-placeholder replaced
              if (!_textPresent && !_placeholderGone && !_pseudoPlaceholderGone) {
                logger.warn(`[browser.act] type (engine) verification failed — textPresent=${_textPresent} placeholderGone=${_placeholderGone} pseudoPlaceholderGone=${_pseudoPlaceholderGone} value="${_postSnap.value.slice(0, 80)}" posMatch=${_postSnap.posMatch}`);
                return {
                  ok: false, action, sessionId,
                  error: `type verification failed: text not present and placeholder still shown. Use reactFill with a selector instead.`,
                  verified: false,
                  executionTime: Date.now() - start,
                };
              }
              logger.info(`[browser.act] type (engine) verified — textPresent=${_textPresent} placeholderGone=${_placeholderGone} pseudoPlaceholderGone=${_pseudoPlaceholderGone} posMatch=${_postSnap.posMatch} tag=${_postSnap.tag}`);
            } else {
              // Post-snapshot failed — fall back to activeElement check
              const _verify = await _ePage.evaluate(() => {
                const el = document.activeElement;
                if (!el) return { hasFocus: false, value: '' };
                const val = el.value || el.textContent || el.innerText || '';
                return { hasFocus: true, value: val.slice(0, 500), tag: el.tagName, editable: el.isContentEditable };
              }).catch(() => null);
              if (_verify) {
                const _typedOk = _verify.value && _verify.value.includes(_typedText.slice(0, 50));
                if (!_typedOk) {
                  logger.warn(`[browser.act] type (engine) verification failed (fallback) — focused <${_verify.tag}> value="${_verify.value.slice(0, 80)}" does not contain typed text`);
                  return {
                    ok: false, action, sessionId,
                    error: `type verification failed: focused element (${_verify.tag}) does not contain typed text. Use reactFill with a selector instead.`,
                    verified: false,
                    executionTime: Date.now() - start,
                  };
                }
                logger.info(`[browser.act] type (engine) verified (fallback) — focused <${_verify.tag}> contains text`);
              }
            }
          }
          return { ok: true, action, sessionId, verified: true, executionTime: Date.now() - start };
        } catch (typeErr) {
          _typeErr = typeErr;
          logger.warn(`[browser.act] type (engine) failed: ${typeErr.message}`);
        }
        if (engine.isSessionActive(sessionId)) {
          return _engineActionFailure(action, sessionId, `Engine type failed: ${_typeErr?.message || 'unknown error'}`, { executionTime: Date.now() - start });
        }
      }
      // ── CLI fallback ──
      return run(['type', '--', text || ''], `type "${text}"`);
    }

    // ── reactFill ────────────────────────────────────────────────────────────
    // React-aware fill: sets value on React-controlled inputs/textareas via the
    // native setter + input event dispatch technique, and on contenteditable
    // elements via focus + execCommand('insertText'). Bypasses snapshot-ref
    // resolution entirely — queries by CSS selector directly. Returns a
    // deterministic verification result (did the value get set?).
    //
    // Args: { selector, text, clearFirst? }
    //   selector    — CSS selector for the target element (e.g. '[role="textbox"]',
    //                 'textarea[name="body"]', 'div[contenteditable="true"]')
    //   text        — text to set
    //   clearFirst  — if true (default), clear existing content before setting
    case 'reactFill': {
      const fillText = (text ?? value) || '';
      const clearFirst = args.clearFirst !== false; // default true
      const _ePage = engine.getPage(sessionId);
      if (!_ePage) {
        return _engineActionFailure(action, sessionId,
          `reactFill requires an engine-owned session (got none for ${sessionId})`,
          { executionTime: Date.now() - start });
      }
      try {
        const result = await _ePage.evaluate(({ selector, text, clearFirst }) => {
          const matchCount = document.querySelectorAll(selector).length;
          const el = document.querySelector(selector);
          if (!el) return { ok: false, error: `Element not found: ${selector}` };

          // ── Element info for disambiguation ──
          // Returned in every path so the caller (LLM) can verify it filled
          // the RIGHT element when multiple elements match the selector.
          const _elementInfo = {
            tag: el.tagName,
            role: el.getAttribute('role'),
            placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            matchCount,
          };

          // ── Path 1: <input> / <textarea> — native setter + input event ──
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            // Fix 35: Capture pre-state for Placeholder-verify in delayed recheck
            const _preValue = (el.value || '').slice(0, 200);
            const _prePlaceholder = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '';
            const _preAria = el.getAttribute('aria-label') || '';
            const _preTooltip = el.getAttribute('data-tooltip') || el.getAttribute('title') || '';
            const _prePseudoPlaceholder = (_preValue && (_preValue === _preAria || _preValue === _preTooltip)) ? _preValue : '';
            const proto = el.tagName === 'INPUT'
              ? window.HTMLInputElement.prototype
              : window.HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value');
            if (setter && setter.set) {
              setter.set.call(el, clearFirst ? text : (el.value + text));
            } else {
              el.value = clearFirst ? text : (el.value + text);
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            // Sync verify (fast path) — reads el.value immediately after the setter.
            // Some frameworks (Google Docs rename, controlled inputs that revert on
            // blur) will overwrite this value on the next microtask, so the caller
            // does a delayed re-read below to produce the honest `verified` signal.
            const actualSync = el.value || '';
            return {
              ok: true,
              method: 'native-setter',
              verified: actualSync.includes(text),
              actualValue: actualSync.slice(0, 200),
              _needsDelayedRecheck: true,
              _selector: selector,
              _expectedText: text,
              _elementInfo,
              // Fix 35: pre-state for Placeholder-verify
              _preValue, _prePlaceholder, _prePseudoPlaceholder,
            };
          }

          // ── Path 2: contenteditable — focus + execCommand insertText ──
          if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' ||
              el.getAttribute('role') === 'textbox') {
            el.focus();
            if (clearFirst) {
              // Select all + delete
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
              document.execCommand('delete');
            }
            // Try execCommand insertText (works in Chrome/Edge)
            const inserted = document.execCommand('insertText', false, text);
            if (!inserted) {
              // Fallback: dispatch InputEvent (React 16+ listens for 'beforeinput'/'input')
              el.dispatchEvent(new InputEvent('beforeinput', {
                data: text, inputType: 'insertText', bubbles: true, cancelable: true,
              }));
              el.dispatchEvent(new InputEvent('input', {
                data: text, inputType: 'insertText', bubbles: true,
              }));
              // Last resort: textContent (may not trigger React state update)
              if (!el.textContent || el.textContent.length === 0) {
                el.textContent = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            }
            const actual = el.textContent || el.innerText || '';
            // Normalize for verification: contenteditable editors (Notion, DraftJS,
            // ProseMirror) re-render text into block structure with different whitespace,
            // line breaks, and block-level formatting. Strip whitespace and check if
            // the key phrases from the fill text are present.
            const _normalize = (s) => s.replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
            const _actualNorm = _normalize(actual);
            const _textNorm = _normalize(text);
            // Check if the full text is present (exact match after normalization)
            let _verified = _actualNorm.includes(_textNorm);
            // If not, check if key phrases (lines/sentences from the fill text) are present
            if (!_verified && text.length > 5) {
              const _phrases = text.split(/[\n.!?;]+/).map(p => _normalize(p)).filter(p => p.length > 3);
              if (_phrases.length > 0) {
                const _matched = _phrases.filter(p => _actualNorm.includes(p));
                _verified = _matched.length >= Math.ceil(_phrases.length * 0.5);
              }
            }
            return {
              ok: true,
              method: 'contenteditable',
              verified: _verified,
              actualValue: actual.slice(0, 200),
              _elementInfo,
            };
          }

          // ── Path 3: unknown element type — try native setter, fall back to textContent ──
          el.focus();
          if (clearFirst) el.textContent = '';
          el.textContent = (clearFirst ? '' : (el.textContent || '')) + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          const actual = el.textContent || '';
          // Same normalized verification as contenteditable
          const _normalize3 = (s) => s.replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
          const _actualNorm3 = _normalize3(actual);
          const _textNorm3 = _normalize3(text);
          let _verified3 = _actualNorm3.includes(_textNorm3);
          if (!_verified3 && text.length > 5) {
            const _phrases3 = text.split(/[\n.!?;]+/).map(p => _normalize3(p)).filter(p => p.length > 3);
            if (_phrases3.length > 0) {
              const _matched3 = _phrases3.filter(p => _actualNorm3.includes(p));
              _verified3 = _matched3.length >= Math.ceil(_phrases3.length * 0.5);
            }
          }
          return {
            ok: true,
            method: 'textcontent-fallback',
            verified: _verified3,
            actualValue: actual.slice(0, 200),
            _elementInfo,
          };
        }, { selector: selector || args.selector, text: fillText, clearFirst });

        // ── Delayed re-verification for INPUT/TEXTAREA ──
        // The synchronous `verified` above reads el.value immediately after the native
        // setter. Frameworks that only commit on focus+Enter/blur (Google Docs rename,
        // some controlled inputs) revert the value on the next microtask, so the sync
        // check reports verified=true while the page actually shows the OLD value.
        // Re-read after a short settle and downgrade to verified=false if the value
        // was reverted — callers (turn-loop, Plan-Execute) treat this as "unconfirmed"
        // and can follow up with a press/Enter to commit.
        // Fix 35: Upgraded to full Placeholder-verify — checks all 3 PASS conditions:
        //   (a) text present, (b) placeholder gone, (c) pseudo-placeholder replaced
        if (result.ok && result._needsDelayedRecheck) {
          await _ePage.waitForTimeout(500).catch(() => {});
          try {
            const _recheck = await _ePage.evaluate(({ selector, expectedText }) => {
              const el = document.querySelector(selector);
              if (!el) return { reverted: true, actualValue: '', placeholderAfter: '', hasBlankClass: false, draftPlaceholderGone: false };
              const actual = (el.value || '');
              const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || '';
              const draftPlaceholder = document.querySelector('.public-DraftEditorPlaceholder-inner');
              return {
                actualValue: actual.slice(0, 200),
                placeholderAfter: ph,
                hasBlankClass: el.classList.contains('ql-blank'),
                draftPlaceholderGone: !draftPlaceholder,
                // text present = value includes typed text
                textPresent: actual.includes(expectedText),
              };
            }, { selector: result._selector, expectedText: result._expectedText });
            // Fix 35: Full Placeholder-verify — all 3 PASS conditions
            const _textPresent = _recheck.textPresent;
            const _placeholderGone = !!(
              (result._prePlaceholder && result._prePlaceholder.length > 0 && !_recheck.placeholderAfter) ||
              (_recheck.hasBlankClass === false) || // ql-blank removed
              (_recheck.draftPlaceholderGone) // Draft.js placeholder gone
            );
            const _pseudoPlaceholderGone = !!(
              result._prePseudoPlaceholder &&
              result._prePseudoPlaceholder.length > 0 &&
              _recheck.actualValue !== result._prePseudoPlaceholder &&
              _recheck.actualValue.includes(result._expectedText.slice(0, 50))
            );
            const _fullVerified = _textPresent || _placeholderGone || _pseudoPlaceholderGone;
            if (!_fullVerified) {
              logger.info(`[browser.act] reactFill selector="${selector}" delayed recheck: not verified (textPresent=${_textPresent} placeholderGone=${_placeholderGone} pseudoPlaceholderGone=${_pseudoPlaceholderGone}) actualValue="${_recheck.actualValue}"`);
              result.verified = false;
              result.actualValue = _recheck.actualValue;
            } else {
              // Confirmed — keep verified=true and refresh actualValue
              result.verified = true;
              result.actualValue = _recheck.actualValue;
              if (!_textPresent) {
                logger.info(`[browser.act] reactFill selector="${selector}" delayed recheck: verified via placeholder/pseudo-placeholder gone (textPresent=${_textPresent} placeholderGone=${_placeholderGone} pseudoPlaceholderGone=${_pseudoPlaceholderGone})`);
              }
            }
          } catch (_) { /* non-fatal — keep sync result */ }
        }

        // ── Element info + multi-match warning ──
        const _info = result._elementInfo || {};
        const _multiMatch = _info.matchCount > 1;
        if (_multiMatch) {
          logger.warn(`[browser.act] reactFill: selector "${selector}" matched ${_info.matchCount} elements — filled the first (<${_info.tag} role=${_info.role} placeholder="${_info.placeholder}">) — may be wrong element, use a more specific selector`);
        }
        logger.info(`[browser.act] reactFill selector="${selector}" method=${result.method} verified=${result.verified} element=<${_info.tag} role=${_info.role} placeholder="${_info.placeholder}"> (${_info.matchCount} matches)`);
        if (!result.ok) {
          return { ok: false, action, sessionId, error: result.error, executionTime: Date.now() - start };
        }
        return {
          ok: true, action, sessionId,
          result: result.actualValue,
          verified: result.verified,
          method: result.method,
          elementInfo: _info,
          ...( _multiMatch ? { warning: `Selector matched ${_info.matchCount} elements — filled first match (<${_info.tag}>). Use a more specific selector (e.g. by placeholder, aria-label, or tag) to target the correct element.` } : {}),
          executionTime: Date.now() - start,
        };
      } catch (fillErr) {
        logger.warn(`[browser.act] reactFill failed: ${fillErr.message}`);
        return _engineActionFailure(action, sessionId, `reactFill error: ${fillErr.message}`, { executionTime: Date.now() - start });
      }
    }

    // ── clickByText ──────────────────────────────────────────────────────────
    // Click an element by its visible text content. Bypasses snapshot-ref
    // resolution — queries the DOM directly. Useful for buttons whose text
    // is stable ("Post", "Send", "Submit") even when CSS classes/refs change.
    //
    // Args: { text, tag?, exact?, shadow?, scope? }
    //   text   — visible text to match (case-insensitive substring by default)
    //   tag    — optional tag filter (e.g. 'button', 'a', 'div')
    //   exact  — if true, require exact text match (default false)
    //   shadow — if true, search shadow DOM roots too (default false)
    //   scope  — optional CSS selector to limit search to a container (e.g. modal)
    case 'clickByText': {
      const targetText = (text || '').trim();
      const tagFilter = args.tag || args.tagName || null;
      const exact = args.exact === true;
      const searchShadow = args.shadow !== false; // default: search shadow DOM (Spotify and other web components hide buttons in shadow roots)
      const scopeSelector = args.scope || null;
      // menuScope: when an open menu is detected, scope candidates to that menu
      // container. This prevents clickByText "Christian Music" from hitting a
      // sidebar SPAN when the intended target is a menu item inside an open
      // "Add to playlist" submenu. General — works for any open menu/dialog.
      const menuScope = args.menuScope || null;
      // scopeRect: when an overlay is detected but no CSS selector is available
      // (no id/data-testid), scope candidates by bounding box instead. Works for
      // any overlay type (menu, popup, dropdown, modal).
      const scopeRect = args.scopeRect || null;
      if (!targetText) {
        return { ok: false, action, sessionId, error: 'clickByText: text is required', executionTime: Date.now() - start };
      }
      const _ePage = engine.getPage(sessionId);
      if (!_ePage) {
        return _engineActionFailure(action, sessionId,
          `clickByText requires an engine-owned session (got none for ${sessionId})`,
          { executionTime: Date.now() - start });
      }
      try {
        const result = await _ePage.evaluate(({ text, tag, exact, shadow, scope, menuScope, scopeRect }) => {
          const lower = text.toLowerCase();
          // Build candidate list: tag filter + visible elements
          const candidates = [];
          const baseSelector = tag ? tag.toLowerCase() : 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], input:not([type="hidden"]), textarea, div, span';
          const root = scope ? document.querySelector(scope) : document;
          if (!root) return { ok: false, error: `Scope element not found: ${scope}` };
          let els = Array.from(root.querySelectorAll(baseSelector));
          // ── Menu scope filtering ──
          // When menuScope is provided (an open menu was detected), restrict
          // candidates to elements inside the menu container. This prevents
          // clickByText from hitting sidebar/header elements when the intended
          // target is a menu item. Only applies if the menu element exists and
          // has visible children — otherwise fall through to normal behavior.
          if (menuScope) {
            const menuEl = document.querySelector(menuScope);
            if (menuEl) {
              const menuRect = menuEl.getBoundingClientRect();
              const menuStyle = window.getComputedStyle(menuEl);
              if (menuRect.width > 2 && menuRect.height > 2 && menuStyle.display !== 'none' && menuStyle.visibility !== 'hidden') {
                // Filter candidates to those inside the menu
                const menuEls = Array.from(menuEl.querySelectorAll(baseSelector));
                // If the menu has matching candidates, use ONLY those
                const _menuMatched = els.filter(el => menuEl.contains(el));
                if (_menuMatched.length > 0) {
                  els = _menuMatched;
                }
              }
            }
          }
          // ── Scope rect filtering ──
          // When scopeRect is provided (overlay detected by geometry but no CSS
          // selector available), filter candidates to those whose center is within
          // the rect. Works for any overlay type (menu, popup, dropdown, modal).
          if (scopeRect) {
            els = els.filter(el => {
              const r = el.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              return cx >= scopeRect.x && cx <= scopeRect.x + scopeRect.width &&
                     cy >= scopeRect.y && cy <= scopeRect.y + scopeRect.height;
            });
          }
          for (const el of els) {
            // Skip hidden / display:none
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const elText = (el.innerText || el.textContent || '').trim();
            // Also check placeholder attributes (for input/textarea fields with no innerText)
            const placeholder = (el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '').trim();
            const matchText = elText || placeholder;
            if (!matchText) continue;
            const isExact = matchText.toLowerCase() === lower;
            const isSub = matchText.toLowerCase().includes(lower);
            if (exact ? isExact : isSub) candidates.push({ el, text: matchText, len: matchText.length, isExact, isPlaceholder: !elText && !!placeholder });
          }
          // Search shadow DOM if requested
          if (shadow && candidates.length === 0) {
            for (const host of document.querySelectorAll('*')) {
              if (host.shadowRoot) {
                const shadowEls = Array.from(host.shadowRoot.querySelectorAll(baseSelector));
                for (const el of shadowEls) {
                  const elText = (el.innerText || el.textContent || '').trim();
                  const placeholder = (el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '').trim();
                  const matchText = elText || placeholder;
                  if (!matchText) continue;
                  const isExact = matchText.toLowerCase() === lower;
                  const isSub = matchText.toLowerCase().includes(lower);
                  if (exact ? isExact : isSub) candidates.push({ el, text: matchText, len: matchText.length, isExact, isPlaceholder: !elText && !!placeholder });
                }
              }
            }
          }
          if (candidates.length === 0) return { ok: false, error: `No visible element with text "${text}"` };
          // When many matches exist (>5), prefer elements inside a menu/dialog/
          // listbox container or with role='menuitem'. This fixes the case where
          // clickByText "Christian Music" matches 43 elements (sidebar, playlist
          // header, etc.) but the intended target is a submenu item inside an
          // "Add to playlist" menu that was just opened.
          const _inMenuOrDialog = (el) => {
            if (el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'menuitemcheckbox' || el.getAttribute('role') === 'menuitemradio') return true;
            let parent = el.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
              const role = parent.getAttribute('role');
              if (role === 'menu' || role === 'dialog' || role === 'listbox' || role === 'menu') return true;
              parent = parent.parentElement;
            }
            return false;
          };
          const _manyMatches = candidates.length > 5;
          // Sort: exact match first, then (if many matches) menu/dialog preference,
          // then button/submit, then shortest length
          candidates.sort((a, b) => {
            if (a.isExact && !b.isExact) return -1;
            if (!a.isExact && b.isExact) return 1;
            if (_manyMatches) {
              const aInMenu = _inMenuOrDialog(a.el);
              const bInMenu = _inMenuOrDialog(b.el);
              if (aInMenu && !bInMenu) return -1;
              if (!aInMenu && bInMenu) return 1;
            }
            const aIsButton = a.el.tagName === 'BUTTON' || a.el.getAttribute('role') === 'button' || (a.el.tagName === 'INPUT' && (a.el.type === 'submit' || a.el.type === 'button'));
            const bIsButton = b.el.tagName === 'BUTTON' || b.el.getAttribute('role') === 'button' || (b.el.tagName === 'INPUT' && (b.el.type === 'submit' || b.el.type === 'button'));
            if (aIsButton && !bIsButton) return -1;
            if (!aIsButton && bIsButton) return 1;
            // In an overlay scope (menu, popup, dropdown, modal), prefer the
            // outermost/row element (largest area). The inner text spans are
            // smaller and clicking them may not trigger the row's click handler.
            if (menuScope || scopeRect) {
              const aRect = a.el.getBoundingClientRect();
              const bRect = b.el.getBoundingClientRect();
              const aArea = aRect.width * aRect.height;
              const bArea = bRect.width * bRect.height;
              if (aArea !== bArea) return bArea - aArea;
            }
            return a.len - b.len;
          });
          const target = candidates[0].el;
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          target.click();
          return { ok: true, clickedText: candidates[0].text, tag: target.tagName, matchCount: candidates.length };
        }, { text: targetText, tag: tagFilter, exact, shadow: searchShadow, scope: scopeSelector, menuScope, scopeRect });
        if (!result.ok) {
          logger.warn(`[browser.act] clickByText "${targetText}" failed (DOM): ${result.error} — trying LiteParser coordinate fallback`);
          // LiteParser fallback: screenshot → OCR text → click at coordinates
          // This catches elements in shadow DOM, zero-size bounding boxes, etc.
          const _litResult = await _clickByTextViaLiteParse(_ePage, targetText, exact);
          if (_litResult.ok) {
            logger.info(`[browser.act] clickByText "${targetText}" -> clicked via LiteParse at (${_litResult.x}, ${_litResult.y}) "${_litResult.clickedText}" (${_litResult.matchCount} matches)`);
            return {
              ok: true, action, sessionId,
              result: `Clicked via LiteParse at (${_litResult.x}, ${_litResult.y}) "${_litResult.clickedText}"`,
              clickedText: _litResult.clickedText,
              matchCount: _litResult.matchCount,
              clickedViaLiteParse: true,
              executionTime: Date.now() - start,
            };
          }
          logger.warn(`[browser.act] clickByText "${targetText}" LiteParse fallback also failed: ${_litResult.error}`);
          return { ok: false, action, sessionId, error: result.error, executionTime: Date.now() - start };
        }
        logger.info(`[browser.act] clickByText "${targetText}" -> clicked <${result.tag}> "${result.clickedText}" (${result.matchCount} matches)`);
        return {
          ok: true, action, sessionId,
          result: `Clicked <${result.tag}> "${result.clickedText}"`,
          clickedText: result.clickedText,
          matchCount: result.matchCount,
          executionTime: Date.now() - start,
        };
      } catch (clickErr) {
        logger.warn(`[browser.act] clickByText failed: ${clickErr.message}`);
        return _engineActionFailure(action, sessionId, `clickByText error: ${clickErr.message}`, { executionTime: Date.now() - start });
      }
    }

    // ── clickBySelector ──────────────────────────────────────────────────────
    // Click an element by a direct CSS selector. Bypasses snapshot-ref
    // resolution. Use when a stable CSS selector is known (e.g. from a
    // playbook or from inspecting the page). More reliable than ref-based
    // click for elements inside modals/overlays where refs go stale.
    //
    // Args: { selector, force?, waitForVisible? }
    //   selector       — CSS selector for the target element
    //   force          — if true, bypass actionability checks (default false)
    //   waitForVisible — if true, wait for element to be visible before clicking (default true)
    case 'clickBySelector': {
      let cssSelector = selector || args.selector;
      if (!cssSelector) {
        return { ok: false, action, sessionId, error: 'clickBySelector: selector is required', executionTime: Date.now() - start };
      }
      // Sanitize: fix attribute selectors with embedded quotes (e.g. aria-label='God's Not Dead')
      const _origSelector = cssSelector;
      cssSelector = _sanitizeCssSelector(cssSelector);
      if (cssSelector !== _origSelector) {
        logger.info(`[browser.act] clickBySelector: sanitized selector "${_origSelector}" → "${cssSelector}"`);
      }
      const forceClick = args.force === true;
      const waitForVisible = args.waitForVisible !== false; // default true
      const _ePage = engine.getPage(sessionId);
      if (!_ePage) {
        return _engineActionFailure(action, sessionId,
          `clickBySelector requires an engine-owned session (got none for ${sessionId})`,
          { executionTime: Date.now() - start });
      }
      try {
        const clickTimeout = Math.min(timeoutMs, 15000);
        if (waitForVisible) {
          await _ePage.waitForSelector(cssSelector, { state: 'visible', timeout: clickTimeout });
        }
        await _ePage.click(cssSelector, { timeout: clickTimeout, force: forceClick });
        logger.info(`[browser.act] clickBySelector "${cssSelector}" ok${forceClick ? ' (force)' : ''}`);
        return {
          ok: true, action, sessionId,
          result: `Clicked selector "${cssSelector}"`,
          executionTime: Date.now() - start,
        };
      } catch (clickErr) {
        // Fallback: direct DOM click via evaluate (bypasses Playwright actionability)
        logger.info(`[browser.act] clickBySelector Playwright click failed: ${clickErr.message} — trying eval click`);
        try {
          const evalResult = await _ePage.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: `Element not found: ${sel}` };
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.click();
            return { ok: true, tag: el.tagName };
          }, cssSelector);
          if (evalResult.ok) {
            logger.info(`[browser.act] clickBySelector eval-click "${cssSelector}" ok (<${evalResult.tag}>)`);
            return {
              ok: true, action, sessionId,
              result: `Clicked selector "${cssSelector}" (eval)`,
              method: 'eval-click',
              executionTime: Date.now() - start,
            };
          }
          return { ok: false, action, sessionId, error: evalResult.error, executionTime: Date.now() - start };
        } catch (evalErr) {
          logger.warn(`[browser.act] clickBySelector eval-click failed: ${evalErr.message}`);
          return _engineActionFailure(action, sessionId, `clickBySelector error: ${clickErr.message}`, { executionTime: Date.now() - start });
        }
      }
    }

    // ── Hover ────────────────────────────────────────────────────────────────
    case 'hover': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const { ref: cleanRef, entry: plannedEntry, stale } = _engineRefEntry(sessionId, _ePage, selector);
        if (stale) return _engineActionFailure(action, sessionId, `Stale ref ${cleanRef}: take a fresh snapshot and re-plan before hovering`, { staleRef: true, executionTime: Date.now() - start });
        if (cleanRef && !plannedEntry) return _engineActionFailure(action, sessionId, `Unresolvable ref ${cleanRef}: take a fresh snapshot and re-plan before hovering`, { staleRef: true, executionTime: Date.now() - start });
        const refMap = _engineSnapshots.get(sessionId)?.refMap || new Map();
        const _lowConfRefs = _engineSnapshots.get(sessionId)?.lowConfidenceRefs || false;

        // ── DOM scanner ref (tdN): hover via [data-td-ref] locator ──
        if (cleanRef && _isTdRef(cleanRef) && refMap.has(cleanRef)) {
          try {
            await _ePage.locator(`[data-td-ref="${cleanRef}"]`).hover({ timeout: Math.min(timeoutMs, 15000) });
            logger.info(`[browser.act] hover (engine) tdRef=${cleanRef} ok`);
            return { ok: true, action, sessionId, executionTime: Date.now() - start };
          } catch (tdHoverErr) {
            logger.warn(`[browser.act] hover (engine) tdRef=${cleanRef} failed: ${tdHoverErr.message} — falling through`);
          }
        }

        if (cleanRef && refMap && !_lowConfRefs && !_isTdRef(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            try {
              const locator = entry.name
                ? _ePage.getByRole(entry.role, { name: entry.name }).first()
                : _ePage.getByRole(entry.role).first();
              await locator.hover({ timeout: timeoutMs });
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            } catch (e) { logger.warn(`[browser.act] hover (engine) ref=${cleanRef} failed: ${e.message}`); }
          }
        }
        // CSS selector path (only for genuine CSS selectors, not eN refs)
        if (selector && !cleanRef && /[[\]#.>:()"'=~^$*|]/.test(selector.trim())) {
          try { await _ePage.hover(selector, { timeout: timeoutMs }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
          catch (e) { logger.warn(`[browser.act] hover (engine) CSS="${selector}" failed: ${e.message}`); }
        }
        if (engine.isSessionActive(sessionId)) {
          return _engineActionFailure(action, sessionId, `Engine hover failed for selector="${selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
        }
      }
      // ── CLI fallback ──
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawHoverRef = resolveRef(sessionId, selector);
      const hoverTarget = (rawHoverRef && /^e\d+$/i.test(rawHoverRef) ? rawHoverRef : null) || selector;
      return run(['hover', hoverTarget], `hover ${hoverTarget}`);
    }

    // ── Select ───────────────────────────────────────────────────────────────
    case 'select': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const { ref: cleanRef, entry: plannedEntry, stale } = _engineRefEntry(sessionId, _ePage, selector);
        if (stale) return _engineActionFailure(action, sessionId, `Stale ref ${cleanRef}: take a fresh snapshot and re-plan before selecting`, { staleRef: true, executionTime: Date.now() - start });
        if (cleanRef && !plannedEntry) return _engineActionFailure(action, sessionId, `Unresolvable ref ${cleanRef}: take a fresh snapshot and re-plan before selecting`, { staleRef: true, executionTime: Date.now() - start });
        const refMap = _engineSnapshots.get(sessionId)?.refMap || new Map();
        const _lowConfRefs = _engineSnapshots.get(sessionId)?.lowConfidenceRefs || false;

        // ── DOM scanner ref (tdN): select via [data-td-ref] locator ──
        if (cleanRef && _isTdRef(cleanRef) && refMap.has(cleanRef)) {
          try {
            await _ePage.locator(`[data-td-ref="${cleanRef}"]`).selectOption(value || '', { timeout: Math.min(timeoutMs, 15000) });
            logger.info(`[browser.act] select (engine) tdRef=${cleanRef} ok`);
            return { ok: true, action, sessionId, executionTime: Date.now() - start };
          } catch (tdSelectErr) {
            logger.warn(`[browser.act] select (engine) tdRef=${cleanRef} failed: ${tdSelectErr.message} — falling through`);
          }
        }

        if (cleanRef && refMap && !_lowConfRefs && !_isTdRef(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            try {
              const locator = entry.name
                ? _ePage.getByRole(entry.role, { name: entry.name }).first()
                : _ePage.getByRole(entry.role).first();
              await locator.selectOption(value || '', { timeout: timeoutMs });
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            } catch (e) { logger.warn(`[browser.act] select (engine) ref=${cleanRef} failed: ${e.message}`); }
          }
        }
        // CSS selector path (only for genuine CSS selectors, not eN refs)
        if (selector && !cleanRef && /[[\]#.>:()"'=~^$*|]/.test(selector.trim())) {
          try { await _ePage.selectOption(selector, value || '', { timeout: timeoutMs }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
          catch (e) { logger.warn(`[browser.act] select (engine) CSS="${selector}" failed: ${e.message}`); }
        }
        // ── Custom dropdown fallback: when selectOption fails (element is not a
        // native <select> — div-based React Select, MUI, etc.), try click-to-open
        // then click the matching option by text.
        if (engine.isSessionActive(sessionId)) {
          try {
            logger.info(`[browser.act] select (engine) trying custom dropdown fallback for selector="${selector}" value="${value}"`);
            const _selTarget = selector || (cleanRef && _isTdRef(cleanRef) ? `[data-td-ref="${cleanRef}"]` : null);
            if (_selTarget) {
              // Click to open the dropdown
              await _ePage.click(_selTarget, { timeout: 5000 }).catch(() => {});
              await _ePage.waitForTimeout(300);
              // Find and click the option matching the value
              const _optionClicked = await _ePage.evaluate(({ sel, val }) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                // Search for option-like elements in the dropdown or nearby
                const container = el.closest('[role="listbox"], [role="menu"], .dropdown, .select') || el.parentElement || el;
                const opts = container.querySelectorAll('[role="option"], [role="menuitem"], li, .option, [data-value]');
                const _valLower = val.toLowerCase();
                for (const opt of opts) {
                  const _optText = (opt.textContent || opt.getAttribute('data-value') || '').trim().toLowerCase();
                  if (_optText.includes(_valLower) || _valLower.includes(_optText)) {
                    opt.click();
                    return true;
                  }
                }
                return false;
              }, { sel: _selTarget, val: value || '' }).catch(() => false);
              if (_optionClicked) {
                logger.info(`[browser.act] select (engine) custom dropdown fallback: clicked option "${value}" ok`);
                return { ok: true, action, sessionId, method: 'custom-dropdown-click', executionTime: Date.now() - start };
              }
            }
          } catch (_customDropdownErr) {
            logger.warn(`[browser.act] select (engine) custom dropdown fallback failed: ${_customDropdownErr.message}`);
          }
          return _engineActionFailure(action, sessionId, `Engine select failed for selector="${selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
        }
      }
      // ── CLI fallback ──
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawSelRef = resolveRef(sessionId, selector);
      const selTarget = (rawSelRef && /^e\d+$/i.test(rawSelRef) ? rawSelRef : null) || selector;
      return run(['select', '--', selTarget, value || ''], `select ${selTarget}`);
    }

    // ── Check / Uncheck ──────────────────────────────────────────────────────
    case 'check': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const { ref: cleanRef, entry: plannedEntry, stale } = _engineRefEntry(sessionId, _ePage, selector);
        if (stale) return _engineActionFailure(action, sessionId, `Stale ref ${cleanRef}: take a fresh snapshot and re-plan before checking`, { staleRef: true, executionTime: Date.now() - start });
        if (cleanRef && !plannedEntry) return _engineActionFailure(action, sessionId, `Unresolvable ref ${cleanRef}: take a fresh snapshot and re-plan before checking`, { staleRef: true, executionTime: Date.now() - start });
        const refMap = _engineSnapshots.get(sessionId)?.refMap || new Map();
        const _lowConfRefs = _engineSnapshots.get(sessionId)?.lowConfidenceRefs || false;

        // ── DOM scanner ref (tdN): check via [data-td-ref] locator ──
        if (cleanRef && _isTdRef(cleanRef) && refMap.has(cleanRef)) {
          try {
            await _ePage.locator(`[data-td-ref="${cleanRef}"]`).check({ timeout: Math.min(timeoutMs, 15000) });
            logger.info(`[browser.act] check (engine) tdRef=${cleanRef} ok`);
            return { ok: true, action, sessionId, executionTime: Date.now() - start };
          } catch (tdCheckErr) {
            logger.warn(`[browser.act] check (engine) tdRef=${cleanRef} failed: ${tdCheckErr.message} — falling through`);
          }
        }

        if (cleanRef && refMap && !_lowConfRefs && !_isTdRef(cleanRef)) {
          const entry = refMap.get(cleanRef);
          if (entry) {
            try {
              const locator = entry.name
                ? _ePage.getByRole(entry.role, { name: entry.name }).first()
                : _ePage.getByRole(entry.role).first();
              await locator.check({ timeout: timeoutMs });
              return { ok: true, action, sessionId, executionTime: Date.now() - start };
            } catch (e) { logger.warn(`[browser.act] check (engine) ref=${cleanRef} failed: ${e.message}`); }
          }
        }
        // CSS selector path (only for genuine CSS selectors, not eN refs)
        if (selector && !cleanRef && /[[\]#.>:()"'=~^$*|]/.test(selector.trim())) {
          try { await _ePage.check(selector, { timeout: timeoutMs }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
          catch (e) { logger.warn(`[browser.act] check (engine) CSS="${selector}" failed: ${e.message}`); }
        }
        if (engine.isSessionActive(sessionId)) {
          return _engineActionFailure(action, sessionId, `Engine check failed for selector="${selector}": take a fresh snapshot and re-plan`, { executionTime: Date.now() - start });
        }
      }
      // ── CLI fallback ──
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawCheckRef = resolveRef(sessionId, selector);
      const checkTarget = (rawCheckRef && /^e\d+$/i.test(rawCheckRef) ? rawCheckRef : null) || selector;
      return run(['check', checkTarget], `check ${checkTarget}`);
    }

    // ── Upload ───────────────────────────────────────────────────────────────
    // playwright-cli upload takes ONLY file paths — no element ref.
    // The correct sequence is:
    //   1. click <ref>          — triggers the browser's file chooser dialog
    //   2. wait 2s              — let the file chooser initialize
    //   3. upload <filepath>    — playwright-cli intercepts the active chooser
    //                             and feeds the file in (CLI handles the timing)
    // Retry upload with different delays if first attempt fails.
    case 'upload': {
      const uploadFiles = (args.files && Array.isArray(args.files) ? args.files
        : args.file ? [args.file]
        : args.path ? [args.path] : []).filter(Boolean);
      if (args.path && !args.files) {
        logger.warn(`[browser.act] upload: "path" param used — prefer "files" array. Normalizing to files=[${args.path}]`);
      }
      if (!uploadFiles.length) {
        return { ok: false, action, sessionId, error: 'upload: files[] or file is required', executionTime: Date.now() - start };
      }

      // Debug logging
      logger.info(`[browser.act] upload: starting upload for files: ${uploadFiles.join(', ')}`);

      // Ensure browser session exists before upload - use existing session if available
      try {
        const sessionCheck = await cliRun([...sessionFlags(sessionId, false), 'snapshot'], 3000);
        if (!sessionCheck.ok) {
          logger.warn(`[browser.act] Browser session not active, attempting to start session for ${sessionId}`);
          const startResult = await cliRun([...sessionFlags(sessionId, false), 'open'], 5000);
          if (!startResult.ok) {
            // If socket error occurs, try with a different session name
            if (startResult.error?.includes('EINVAL') || startResult.error?.includes('socket')) {
              const altSessionId = `${sessionId}_${Date.now()}`;
              logger.info(`[browser.act] Retrying with alternative session: ${altSessionId}`);
              const retryResult = await cliRun([...sessionFlags(altSessionId, false), 'open'], 5000);
              if (!retryResult.ok) {
                return {
                  ok: false,
                  action,
                  sessionId,
                  error: `Failed to start browser session for upload (socket error): ${retryResult.error}`,
                  executionTime: Date.now() - start,
                };
              }
              // Update sessionId for rest of function
              sessionId = altSessionId;
            } else {
              return {
                ok: false,
                action,
                sessionId,
                error: `Failed to start browser session for upload: ${startResult.error}`,
                executionTime: Date.now() - start,
              };
            }
          }
          // Wait a moment for session to fully initialize
          await cliRun([...sessionFlags(sessionId, false), 'wait', '1000'], 2000);
        }
      } catch (sessionError) {
        return {
          ok: false,
          action,
          sessionId,
          error: `Session check failed: ${sessionError.message}`,
          executionTime: Date.now() - start,
        };
      }

      for (const _f of uploadFiles) {
        let _raw = String(_f || '');
        
        // Fix path resolution for /previous_step/ references
        if (_raw.startsWith('/previous_step/')) {
          const filename = _raw.replace('/previous_step/', '');
          // Map to common user directories
          const possiblePaths = [
            `/Users/lukaizhi/Desktop/${filename}`,
            `/Users/lukaizhi/Documents/${filename}`,
            `/Users/lukaizhi/Downloads/${filename}`,
            `/Users/lukaizhi/${filename}`
          ];
          
          // Find the first existing file
          for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
              _raw = possiblePath;
              logger.info(`[browser.act] upload: resolved /previous_step/${filename} to ${_raw}`);
              break;
            }
          }
          
          // If still using /previous_step/ path, default to Desktop
          if (_raw.startsWith('/previous_step/')) {
            _raw = `/Users/lukaizhi/Desktop/${filename}`;
            logger.warn(`[browser.act] upload: /previous_step/${filename} not found, defaulting to Desktop: ${_raw}`);
          }
        }
        
        if (!path.isAbsolute(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: path must be absolute: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
        if (/\/path\/to\/|\/Users\/the_user\/|\{\{[^}]+\}\}|<\s*file/i.test(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: placeholder file path rejected: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
        if (!fs.existsSync(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: file not found: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
      }

      // ── Engine path: use Playwright file chooser API ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          if (selector) {
            logger.info(`[browser.act] upload: clicking attach button (engine): ${selector}`);
            const [fileChooser] = await Promise.all([
              _ePage.waitForFileChooser({ timeout: timeoutMs }),
              _ePage.click(selector),
            ]);
            await fileChooser.setFiles(uploadFiles);
          } else {
            const fileInput = await _ePage.locator('input[type="file"]').first();
            await fileInput.setInputFiles(uploadFiles);
          }
          logger.info(`[browser.act] upload: files set successfully (engine): ${uploadFiles.join(', ')}`);
          if (sessionId.includes('gmail') || sessionId.includes('mail')) {
            for (const _f of uploadFiles) { await waitForAttachmentProcessing(sessionId, _f); }
          }
          return { ok: true, action, sessionId, files: uploadFiles, result: `Successfully uploaded ${uploadFiles.length} file(s)`, executionTime: Date.now() - start };
        } catch (e) {
          logger.warn(`[browser.act] upload (engine) failed: ${e.message} — falling back to CLI`);
        }
      }

      // ── CLI fallback ──
      if (selector) {
        logger.info(`[browser.act] upload: clicking attach button: ${selector}`);
        const clickFlags = sessionFlags(sessionId, false);
        const _triggerRes = await cliRun([...clickFlags, 'click', selector], timeoutMs);
        if (!_triggerRes.ok) {
          return {
            ok: false,
            action,
            sessionId,
            error: `Failed to click attach button "${selector}": ${_triggerRes.error}`,
            executionTime: Date.now() - start,
          };
        }
        await cliRun([...clickFlags, 'wait', '500'], timeoutMs);
      }

      // Step 2: upload files using playwright-cli upload command (direct CLI only)
      const uploadFlags = sessionFlags(sessionId, false);
      for (const _f of uploadFiles) {
        logger.info(`[browser.act] upload: attempting playwright-cli upload for: ${_f}`);
        const _uploadResult = await cliRun([...uploadFlags, 'upload', _f], timeoutMs);
        
        if (!_uploadResult.ok) {
          logger.error(`[browser.act] upload: failed for ${_f} - ${_uploadResult.error}`);
          return {
            ok: false,
            action,
            sessionId,
            error: `Upload failed for ${_f}: ${_uploadResult.error}`,
            executionTime: Date.now() - start,
          };
        }
        
        logger.info(`[browser.act] upload: file attached successfully — ${_f}`);
        
        // Wait for Gmail to process the attachment
        if (sessionId.includes('gmail') || sessionId.includes('mail')) {
          logger.info(`[browser.act] upload: waiting for Gmail to process attachment: ${_f}`);
          await waitForAttachmentProcessing(sessionId, _f);
        }
      }

      logger.info(`[browser.act] upload: upload completed successfully for: ${uploadFiles.join(', ')}`);
      
      const result = {
        ok: true,
        action,
        sessionId,
        files: uploadFiles,
        executionTime: Date.now() - start,
        result: `Successfully uploaded ${uploadFiles.length} file(s)`
      };
      
      // Force process cleanup to prevent hanging (only for standalone testing)
      if (process.env.NODE_ENV !== 'production' && !process.env.ELECTRON_RUN_AS_NODE) {
        setTimeout(() => {
          process.exit(0);
        }, 100);
      }
      
      return result;
    }

    // ── Paste ───────────────────────────────────────────────────────────────
    // Low-level paste primitive — presses Meta+V (macOS) or Ctrl+V (other) on
    // whatever element currently has focus. Prefer `pasteAttachment` for file
    // attachments because it focuses the compose body first.
    case 'paste': {
      logger.info(`[browser.act] Pasting clipboard content for session=${sessionId}`);
      const pasteKey = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.keyboard.press(pasteKey); return { ok: true, action, sessionId, executionTime: Date.now() - start, result: 'Clipboard content pasted successfully' }; }
        catch (e) { logger.warn(`[browser.act] paste (engine) failed: ${e.message} — falling back to CLI`); }
      }
      try {
        const pasteResult = await run(['press', pasteKey], `paste ${pasteKey}`);
        if (!pasteResult.ok) throw new Error(`Failed to paste: ${pasteResult.error || pasteResult.stderr}`);
        return { ok: true, action, sessionId, executionTime: Date.now() - start, result: 'Clipboard content pasted successfully' };
      } catch (error) {
        logger.error(`[browser.act] Paste failed: ${error.message}`);
        return { ok: false, action, sessionId, executionTime: Date.now() - start, error: error.message };
      }
    }

    // ── PasteAttachment ─────────────────────────────────────────────────────
    // High-level action for attaching a file to Gmail/chat compose windows via
    // clipboard. Matches the human workflow:
    //   1. (caller ran shell.run osascript earlier to put the file on the clipboard)
    //   2. focus the COMPOSE BODY (contentEditable — NOT the attach/paperclip button,
    //      whose native file chooser modal blocks keyboard events in playwright-cli)
    //   3. press Meta+V (macOS) / Ctrl+V — the contentEditable receives a paste event
    //      with a File in clipboardData, and Gmail auto-converts it to an attachment
    // Caller may supply `selector` to explicitly target a body ref; otherwise we
    // scan the snapshot for the best candidate.
    case 'pasteAttachment': {
      logger.info(`[browser.act] pasteAttachment: session=${sessionId}`);

      try {
        await captureSnapshot(sessionId, headed, timeoutMs);
        const snap = snapshotCache.get(_tabKey(sessionId)) || '';

        // Locate the compose body. Caller can pin it via selector; otherwise
        // search the snapshot for a textbox whose name/label matches body-ish tokens.
        let bodyRef = null;
        let bodyLabel = null;

        if (selector) {
          bodyRef = resolveRef(sessionId, selector);
          bodyLabel = selector;
        }

        if (!bodyRef && snap) {
          const candidates = parseSnapshotCandidates(snap);
          const BODY_NAME_RX = /\b(message\s*body|body|message|compose|email\s*body)\b/i;
          // Prefer textbox/richtext roles. Deprioritise anything mentioning attach/paperclip.
          const ROLE_SCORE = { textbox: 4, combobox: 2, searchbox: 1 };
          let best = null, bestScore = -Infinity;
          for (const cand of candidates) {
            const roleScore = ROLE_SCORE[String(cand.role || '').toLowerCase()] || 0;
            if (roleScore === 0) continue;
            const label = String(cand.label || '');
            let s = roleScore;
            if (BODY_NAME_RX.test(label)) s += 6;
            if (/subject/i.test(label)) s -= 5;          // not the subject line
            if (/to|recipient|cc|bcc/i.test(label)) s -= 5; // not the recipients row
            if (/attach|paperclip|file/i.test(label)) s -= 8;
            if (s > bestScore) { bestScore = s; best = cand; }
          }
          if (best && bestScore > 0) {
            bodyRef = best.ref;
            bodyLabel = best.label;
            logger.info(`[browser.act] pasteAttachment: resolved compose body → ${bodyRef} ("${bodyLabel}" score=${bestScore})`);
          }
        }

        if (!bodyRef || !/^e\d+$/i.test(String(bodyRef).trim())) {
          const err = `pasteAttachment: could not locate compose body textbox in snapshot. Hint: supply selector="Message Body" or equivalent.`;
          logger.error(`[browser.act] ${err}`);
          return { ok: false, action, sessionId, error: err, executionTime: Date.now() - start };
        }

        // Focus the body by clicking it, then paste.
        // ── Engine path ──
        const _ePagePaste = engine.getPage(sessionId);
        if (_ePagePaste) {
          const refMap = _engineRefMaps.get(sessionId);
          if (refMap && refMap.has(bodyRef)) {
            const entry = refMap.get(bodyRef);
            try {
              const locator = entry.name
                ? _ePagePaste.getByRole(entry.role, { name: entry.name }).first()
                : _ePagePaste.getByRole(entry.role).first();
              await locator.click({ timeout: 5000 });
              logger.info(`[browser.act] pasteAttachment: clicked body ref ${bodyRef} (engine) ok`);
            } catch (clickErr) {
              logger.warn(`[browser.act] pasteAttachment: click on body ref ${bodyRef} (engine) failed: ${clickErr.message} — continuing to paste anyway`);
            }
          } else {
            logger.warn(`[browser.act] pasteAttachment: ref ${bodyRef} not in refMap — trying CSS click`);
            try { await _ePagePaste.click(`[aria-label="${bodyLabel || 'Message Body'}"]`, { timeout: 5000 }).catch(() => {}); }
            catch (_) {}
          }

          await new Promise(r => setTimeout(r, 150));

          const pasteKey = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
          try {
            await _ePagePaste.keyboard.press(pasteKey);
            logger.info(`[browser.act] pasteAttachment: paste key pressed (engine) ok`);
            return { ok: true, action, sessionId, executionTime: Date.now() - start, result: 'Pasted into compose body' };
          } catch (pressErr) {
            logger.warn(`[browser.act] pasteAttachment: paste key (engine) failed: ${pressErr.message} — falling back to CLI`);
          }
        }

        // ── CLI fallback ──
        const clickRes = await run(['click', bodyRef], `pasteAttachment focus ${bodyRef}`);
        if (!clickRes.ok) {
          logger.warn(`[browser.act] pasteAttachment: click on body ref ${bodyRef} failed — continuing to paste anyway`);
        }

        // Short settle so the contentEditable is truly focused before keypress.
        await new Promise(r => setTimeout(r, 150));

        const pasteKey = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
        const pasteRes = await run(['press', pasteKey], `pasteAttachment press ${pasteKey}`);

        if (!pasteRes.ok) {
          throw new Error(`Failed to paste into body: ${pasteRes.error || pasteRes.stderr}`);
        }

        // Detect the known "modal state" error early so callers don't burn
        // repair cycles: it means the caller clicked the attach button before
        // calling us, which is the anti-pattern this action was built to avoid.
        const stdout = String(pasteRes.stdout || '');
        if (/does not handle the modal state/i.test(stdout)) {
          return {
            ok: false,
            action,
            sessionId,
            error: 'pasteAttachment: a modal (likely the native file chooser) is open and blocks keyboard events. Do NOT click the Attach button before pasteAttachment — paste directly into the compose body.',
            executionTime: Date.now() - start
          };
        }

        // ── Wait for upload to complete before returning ─────────────────────
        // Web mail clients (Gmail, Outlook, Yahoo, etc.) upload files asynchronously
        // after the paste event. Returning immediately causes the agent to click Send
        // while the upload is still in progress, triggering "images still uploading" alerts.
        //
        // Generic approach: poll the accessibility tree for DOM stability.
        // An in-progress upload continuously mutates the tree (progress %, spinner state,
        // byte count). Once the tree is unchanged for STABLE_REQUIRED consecutive polls
        // the upload is done. This works for any service without hardcoded strings.
        //
        // uploadWaitMs defaults to 120s (2 min) — safe for images/documents.
        // Callers handling video/audio/multi-file should pass a larger value.
        const uploadWaitMs = args.uploadWaitMs || 120000;
        const UPLOAD_MIN_WAIT_MS = 1500;  // minimum settle (XHR pipeline startup)
        const UPLOAD_POLL_MS = 800;
        const STABLE_REQUIRED = 2;        // consecutive unchanged polls = done (~1.6s stable)

        logger.info(`[browser.act] pasteAttachment: waiting for upload to complete (max ${Math.round(uploadWaitMs / 1000)}s)`);
        await new Promise(r => setTimeout(r, UPLOAD_MIN_WAIT_MS));

        const uploadStart = Date.now();
        let prevSnapText = '';
        let stableCount = 0;
        while (Date.now() - uploadStart < uploadWaitMs) {
          await new Promise(r => setTimeout(r, UPLOAD_POLL_MS));
          await captureSnapshot(sessionId, headed, 5000).catch(() => null);
          const snapText = (snapshotCache.get(_tabKey(sessionId)) || '').slice(0, 3000);
          if (snapText === prevSnapText) {
            stableCount++;
            if (stableCount >= STABLE_REQUIRED) break;
          } else {
            stableCount = 0;
            prevSnapText = snapText;
            logger.info(`[browser.act] pasteAttachment: DOM changing — upload in progress (${Math.round((Date.now() - uploadStart) / 1000)}s / ${Math.round(uploadWaitMs / 1000)}s max)`);
          }
        }
        logger.info(`[browser.act] pasteAttachment: DOM stable or timeout — proceeding (${Math.round((Date.now() - uploadStart) / 1000)}s)`);

        return {
          ok: true,
          action,
          sessionId,
          executionTime: Date.now() - start,
          result: `Attachment pasted into compose body (${bodyLabel || bodyRef})`
        };
      } catch (error) {
        logger.error(`[browser.act] pasteAttachment failed: ${error.message}`);
        return {
          ok: false,
          action,
          sessionId,
          executionTime: Date.now() - start,
          error: error.message
        };
      }
    }

    // ── Send Email with Verification ───────────────────────────────────────
    case 'sendEmailWithVerification': {
      if (!selector) {
        return { ok: false, action, sessionId, error: 'sendEmailWithVerification: selector (send button) is required', executionTime: Date.now() - start };
      }

      try {
        logger.info(`[browser.act] sendEmailWithVerification: starting send verification for session=${sessionId}`);
        
        const wasSent = await sendEmailWithVerification(sessionId, selector);
        
        return {
          ok: true,
          action,
          sessionId,
          result: 'Email sent and verified successfully',
          executionTime: Date.now() - start,
        };
      } catch (error) {
        logger.error(`[browser.act] sendEmailWithVerification failed: ${error.message}`);
        return {
          ok: false,
          action,
          sessionId,
          error: error.message,
          executionTime: Date.now() - start,
        };
      }
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────
    case 'keyboard':
    case 'press': {
      const pressKey = key || text || '';

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          // For Enter/Return: refocus last filled input before submit
          if (/^(Enter|Return)$/i.test(pressKey)) {
            const lastFill = lastFilledTarget.get(sessionId);
            if (lastFill) {
              const refocusTarget = lastFill.ref || lastFill.target;
              logger.info(`[browser.act] press Enter (engine): refocusing "${refocusTarget}"`);
              // Try clicking by ref or CSS selector
              try {
                const refMap = _engineRefMaps.get(sessionId);
                const loc = refMap?.get(refocusTarget);
                if (loc) {
                  await _ePage.getByRole(loc.role, { name: loc.name }).first().click({ timeout: 3000 }).catch(() => {});
                } else {
                  await _ePage.click(refocusTarget, { timeout: 3000 }).catch(() => {});
                }
              } catch (_) {}
              await new Promise(r => setTimeout(r, 150));
            }
            snapshotCache.delete(_tabKey(sessionId));
            lastFilledTarget.delete(sessionId);
          }

          // ── Normalize LLM-style key names to Playwright key names ──────────
          // LLMs often generate "Ctrl" instead of "Control", "Cmd" instead of "Meta",
          // "Option" instead of "Alt", "Esc" instead of "Escape". Normalize each
          // +-separated segment before passing to _ePage.keyboard.press().
          const _KEY_NORMALIZE_MAP = { 'ctrl': 'Control', 'cmd': 'Meta', 'command': 'Meta', 'option': 'Alt', 'opt': 'Alt', 'esc': 'Escape', 'return': 'Enter', 'del': 'Delete', 'ins': 'Insert', 'pgup': 'PageUp', 'pgdn': 'PageDown', 'home': 'Home', 'end': 'End', 'space': 'Space' };
          const _normalizedKey = pressKey.split('+').map(seg => {
            const _lower = seg.trim().toLowerCase();
            return _KEY_NORMALIZE_MAP[_lower] || seg.trim();
          }).join('+');
          if (_normalizedKey !== pressKey) {
            logger.info(`[browser.act] press: normalized "${pressKey}" → "${_normalizedKey}"`);
          }
          await _ePage.keyboard.press(_normalizedKey);
          logger.info(`[browser.act] press ${_normalizedKey} (engine) ok`);

          // For Enter: wait for potential navigation
          if (/^(Enter|Return)$/i.test(pressKey)) {
            try {
              await _ePage.waitForLoadState('domcontentloaded', { timeout: 3000 });
            } catch (_) {}
            snapshotCache.delete(_tabKey(sessionId));
          }
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (pressErr) {
          logger.warn(`[browser.act] press (engine) failed: ${pressErr.message} — falling back to CLI`);
        }
      }

      // ── CLI fallback ──
      if (/^(Enter|Return)$/i.test(pressKey)) {
        const lastFill = lastFilledTarget.get(sessionId);
        if (lastFill) {
          const refocusTarget = lastFill.ref || lastFill.target;
          logger.info(`[browser.act] press Enter: refocusing last filled target "${refocusTarget}" before submit`);
          await cliRun([...S, 'click', refocusTarget], 3000).catch(() => {});
          await new Promise(r => setTimeout(r, 150));
        }
        snapshotCache.delete(_tabKey(sessionId));
        lastFilledTarget.delete(sessionId);

        const pressRes = await cliRun([...S, 'press', pressKey], timeoutMs);
        logger.info(`[browser.act] press ${pressKey} → exit ${pressRes.exitCode}`, { stderr: pressRes.stderr?.slice(0, 200) });
        const navigationKill = pressRes.exitCode === -1 || pressRes.exitCode === null;
        if (navigationKill) {
          openSessions.delete(sessionId);
          await new Promise(r => setTimeout(r, 2000));
        }
        return {
          ok:            pressRes.ok || navigationKill,
          action,
          sessionId,
          result:        (pressRes.stdout || '').trim() || undefined,
          stdout:        pressRes.stdout,
          executionTime: Date.now() - start,
          error:         (pressRes.ok || navigationKill) ? undefined : pressRes.error || pressRes.stderr?.trim(),
        };
      }
      const _pressRes = await run(['press', pressKey], `press ${pressKey}`);
      if (_pressRes.ok && /\bError\b/i.test(_pressRes.stdout || '')) {
        const _pressErr = (_pressRes.stdout || '').match(/Error[:\s].+/i)?.[0]?.trim() || `press failed: unknown key '${pressKey}'`;
        logger.warn(`[browser.act] press ${pressKey}: stdout error detected — ${_pressErr}`);
        return { ..._pressRes, ok: false, error: _pressErr };
      }
      return _pressRes;
    }
    case 'keydown': return run(['keydown', key || ''], `keydown ${key}`);
    case 'keyup':   return run(['keyup',   key || ''], `keyup ${key}`);

    // ── Drag ─────────────────────────────────────────────────────────────────
    // Drags the source element (selector/ref) to the targetSelector element.
    case 'drag': {
      const targetSel = args.targetSelector || args.target;
      if (!targetSel) {
        return { ok: false, action, sessionId, error: 'drag requires targetSelector', executionTime: Date.now() - start };
      }
      const sourceSel = resolvedSelector || ref;
      if (!sourceSel) {
        return { ok: false, action, sessionId, error: 'drag requires a source selector or ref', executionTime: Date.now() - start };
      }
      logger.info(`[browser.act] drag from="${sourceSel}" to="${targetSel}"`);
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.dragAndDrop(sourceSel, targetSel, { timeout: timeoutMs });
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (dragErr) {
          logger.warn(`[browser.act] drag (engine) failed: ${dragErr.message} — falling back to CLI`);
        }
      }
      // ── CLI fallback ──
      const dragRes = await cliRun([...S, 'drag-and-drop', sourceSel, targetSel], timeoutMs);
      if (dragRes.ok) return { ok: true, action, sessionId, executionTime: Date.now() - start };
      // Fallback: mouse-based drag via evaluate
      const fallbackRes = await cliRun([
        ...S, 'evaluate',
        `async () => {
          const src = document.querySelector(${JSON.stringify(sourceSel)});
          const tgt = document.querySelector(${JSON.stringify(targetSel)});
          if (!src || !tgt) throw new Error('drag: element not found');
          const srcR = src.getBoundingClientRect();
          const tgtR = tgt.getBoundingClientRect();
          src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: srcR.x + srcR.width/2, clientY: srcR.y + srcR.height/2 }));
          src.dispatchEvent(new MouseEvent('dragstart', { bubbles: true }));
          tgt.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientX: tgtR.x + tgtR.width/2, clientY: tgtR.y + tgtR.height/2 }));
          tgt.dispatchEvent(new MouseEvent('drop', { bubbles: true }));
          src.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
        }`
      ], timeoutMs);
      return {
        ok: fallbackRes.ok,
        action,
        sessionId,
        error: fallbackRes.ok ? undefined : (fallbackRes.stderr || 'drag failed'),
        executionTime: Date.now() - start,
      };
    }

    // ── Scroll ───────────────────────────────────────────────────────────────
    // Accepts: direction ('up'|'down'|'left'|'right'), distance ('100%'|number px),
    // dx/dy raw pixels (legacy).
    case 'scroll': {
      const direction = args.direction || 'down';
      const distance  = args.distance;
      let scrollDx = dx;
      let scrollDy = dy;
      // Parse distance: '100%' → full document height, numeric string → pixels
      if (distance !== undefined) {
        if (String(distance) === '100%' || String(distance).toLowerCase() === 'bottom') {
          scrollDy = 99999;
        } else if (String(distance) === '0%' || String(distance).toLowerCase() === 'top') {
          scrollDy = -99999;
        } else {
          const px = parseInt(String(distance), 10);
          if (!isNaN(px)) scrollDy = px;
        }
      }
      // Apply direction to sign
      if (direction === 'up')    scrollDy = -Math.abs(scrollDy);
      if (direction === 'down')  scrollDy =  Math.abs(scrollDy);
      if (direction === 'left')  { scrollDx = -Math.abs(scrollDy); scrollDy = 0; }
      if (direction === 'right') { scrollDx =  Math.abs(scrollDy); scrollDy = 0; }
      logger.info(`[browser.act] scroll dx=${scrollDx} dy=${scrollDy} (direction=${direction} distance=${distance ?? 'default'})`);
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.mouse.wheel(scrollDx || 0, scrollDy || 0);
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (scrollErr) {
          logger.warn(`[browser.act] scroll (engine) failed: ${scrollErr.message} — falling back to CLI`);
        }
      }
      // ── CLI fallback ──
      return run(['mousewheel', String(scrollDx), String(scrollDy)], `scroll dx=${scrollDx} dy=${scrollDy}`);
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    case 'screenshot': {
      const outPath = filePath || path.join(os.tmpdir(), `screenshot_${sessionId}_${Date.now()}.png`);

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.screenshot({ path: outPath, fullPage: false });
          return { ok: true, action, sessionId, result: outPath, executionTime: Date.now() - start };
        } catch (ssErr) {
          logger.warn(`[browser.act] screenshot (engine) failed: ${ssErr.message} — falling back to CLI`);
        }
      }

      // ── CLI fallback ──
      const res = await cliRun([...S, 'screenshot', outPath], timeoutMs);
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.ok ? outPath : undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── PDF ──────────────────────────────────────────────────────────────────
    case 'pdf': {
      const outPath = filePath || path.join(os.tmpdir(), `page_${sessionId}_${Date.now()}.pdf`);
      const res = await cliRun([...S, 'pdf', outPath], timeoutMs);
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.ok ? outPath : undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── Universal Content Extraction ───────────────────────────────────────────
    case 'extractContent': {
      // Multi-layer extraction: DOM-based + regex fallback + structured data
      const evalExpr = `(function(){
        try {
          // Layer 1: DOM-based extraction
          const content = {
            links: [],
            images: [],
            videos: [],
            documents: [],
            structured: []
          };
          
          // Extract all links
          document.querySelectorAll('a[href]').forEach(a => {
            const href = a.href;
            const text = (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 200);
            if (href && !href.startsWith('javascript:') && !href.startsWith('javascript:void')) {
              content.links.push({ href, text, title: a.title || '' });
            }
          });
          
          // Extract all images
          document.querySelectorAll('img[src]').forEach(img => {
            const src = img.src;
            const alt = img.alt || '';
            const title = img.title || '';
            if (src) {
              content.images.push({ src, alt, title });
            }
          });
          
          // Extract videos
          document.querySelectorAll('video[src], source[src]').forEach(el => {
            const src = el.src || el.dataset.src;
            if (src) {
              content.videos.push({ src });
            }
          });
          
          // Extract documents
          document.querySelectorAll('a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".xls"], a[href$=".xlsx"], a[href$=".ppt"], a[href$=".pptx"]').forEach(a => {
            const href = a.href;
            const text = (a.innerText || a.textContent || '').trim();
            if (href) {
              content.documents.push({ href, text });
            }
          });
          
          // Layer 2: Schema.org structured data
          const scripts = document.querySelectorAll('script[type="application/ld+json"]');
          scripts.forEach(script => {
            try {
              const data = JSON.parse(script.textContent);
              if (data) {
                content.structured.push({ type: 'schema.org', data });
              }
            } catch (e) {
              // Ignore malformed JSON
            }
          });
          
          // Layer 3: Meta tags for social media
          const metaTags = {};
          ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:url'].forEach(prop => {
            const meta = document.querySelector(\`meta[property="\${prop}"], meta[name="\${prop}"]\`);
            if (meta && meta.content) {
              metaTags[prop] = meta.content;
            }
          });
          if (Object.keys(metaTags).length > 0) {
            content.structured.push({ type: 'meta', data: metaTags });
          }
          
          return JSON.stringify(content);
        } catch (e) {
          return JSON.stringify({ error: e.message });
        }
      })()`;
      
      const res = await cliRun([...S, 'eval', evalExpr], Math.min(timeoutMs, 20000));
      const rawOut = (res.stdout || '').trim();
      const resultMatch = rawOut.match(/^([\s\S]*?)(?=###\s|$)/i);
      let jsonStr;
      if (resultMatch) {
        jsonStr = resultMatch[1].trim().replace(/^["']|["']$/g, '');
      } else {
        jsonStr = rawOut;
      }

      let extractedContent = null;
      try {
        extractedContent = JSON.parse(jsonStr);
      } catch (e) {
        logger.warn(`[browser.act] Failed to parse extracted content JSON: ${e.message}`);
        extractedContent = { error: 'Failed to parse content' };
      }

      // Layer 4: Text-based regex extraction as fallback
      const pageTextRes = await cliRun([...S, 'eval', '(function(){var b=document.body;return b?(b.innerText||b.textContent||"").slice(0,50000):"";})()'], Math.min(timeoutMs, 10000));
      const pageRawOut = (pageTextRes.stdout || '').trim();
      // Use greedy match to capture everything until the LAST ### marker
      const pageResultMatch = pageRawOut.match(/^([\s\S]*?)(?=###\s|$)/i);
      let pageText;
      if (pageResultMatch) {
        pageText = pageResultMatch[1].trim().replace(/^"/, '').replace(/"$/, '');
      } else {
        pageText = pageRawOut;
      }

      // Regex extraction for URLs
      const urlRegex = /https?:\/\/[^\s"'\`>\),]+/g;
      const imageRegex = /\.(jpg|jpeg|png|gif|webp|svg|avif)(?:\?[^\s]*)?/gi;
      const videoRegex = /\.(mp4|webm|ogg|mov|avi)(?:\?[^\s]*)?/gi;
      const documentRegex = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx)(?:\?[^\s]*)?/gi;
      
      const regexUrls = pageText.match(urlRegex) || [];
      const regexImages = pageText.match(imageRegex) || [];
      const regexVideos = pageText.match(videoRegex) || [];
      const regexDocuments = pageText.match(documentRegex) || [];

      // Merge DOM and regex results
      const mergedContent = {
        links: extractedContent?.links || [],
        images: extractedContent?.images || [],
        videos: extractedContent?.videos || [],
        documents: extractedContent?.documents || [],
        structured: extractedContent?.structured || [],
        // Add regex-only results
        regexOnly: {
          urls: regexUrls.filter(url => !extractedContent?.links?.some(link => link.href === url)),
          images: regexImages.filter(img => !extractedContent?.images?.some(image => image.src.includes(img))),
          videos: regexVideos.filter(video => !extractedContent?.videos?.some(vid => vid.src.includes(video))),
          documents: regexDocuments.filter(doc => !extractedContent?.documents?.some(document => document.href.includes(doc)))
        }
      };

      // Format as markdown for display
      let markdownContent = '';
      
      if (mergedContent.links.length > 0) {
        markdownContent += '\\n## Links\\n';
        mergedContent.links.slice(0, 20).forEach(link => {
          markdownContent += `- [${link.text || link.href}](${link.href})\\n`;
        });
        if (mergedContent.links.length > 20) {
          markdownContent += `- ... and ${mergedContent.links.length - 20} more links\\n`;
        }
      }
      
      if (mergedContent.images.length > 0) {
        markdownContent += '\\n## Images\\n';
        mergedContent.images.slice(0, 10).forEach(img => {
          markdownContent += `![${img.alt || 'image'}](${img.src})\\n`;
        });
        if (mergedContent.images.length > 10) {
          markdownContent += `- ... and ${mergedContent.images.length - 10} more images\\n`;
        }
      }
      
      if (mergedContent.videos.length > 0) {
        markdownContent += '\\n## Videos\\n';
        mergedContent.videos.forEach(video => {
          markdownContent += `- [Video](${video.src})\\n`;
        });
      }
      
      if (mergedContent.documents.length > 0) {
        markdownContent += '\\n## Documents\\n';
        mergedContent.documents.forEach(doc => {
          markdownContent += `- [${doc.text || 'Document'}](${doc.href})\\n`;
        });
      }
      
      if (Object.values(mergedContent.regexOnly).some(arr => arr.length > 0)) {
        markdownContent += '\\n## Additional Content (Regex Extracted)\\n';
        if (mergedContent.regexOnly.urls.length > 0) {
          markdownContent += '### URLs\\n';
          mergedContent.regexOnly.urls.slice(0, 10).forEach(url => {
            markdownContent += `- ${url}\\n`;
          });
        }
        if (mergedContent.regexOnly.images.length > 0) {
          markdownContent += '### Images\\n';
          mergedContent.regexOnly.images.slice(0, 5).forEach(img => {
            markdownContent += `- ${img}\\n`;
          });
        }
      }

      // Layer 5: LLM smart extraction for YouTube and complex pages when no links found
      if (mergedContent.links.length === 0 && pageText.length > 100) {
        try {
          const { ask } = require('../skill-helpers/skill-llm.cjs');
          const llmExtractionPrompt = `Extract all video links from this page text. Look for video titles and their corresponding YouTube watch URLs.

Page text (first 15000 chars):
${pageText.slice(0, 15000)}

Return ONLY a JSON array of objects with these exact fields:
- title: the video title
- href: the full YouTube URL (https://www.youtube.com/watch?v=...)
- channel: channel name if visible

Example: [{"title": "10 Min Workout", "href": "https://www.youtube.com/watch?v=AbC123", "channel": "Fitness"}]

If no videos found, return []. Do not explain, only output the JSON array.`;

          const llmResult = await ask(llmExtractionPrompt, { maxTokens: 2000, temperature: 0.1 });
          const jsonMatch = llmResult.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsedLinks = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsedLinks) && parsedLinks.length > 0) {
              const llmLinks = parsedLinks.map(v => ({
                text: v.title || 'Video',
                href: v.href,
                title: v.title || 'Video',
                source: 'llm-extraction',
                channel: v.channel
              })).filter(l => l.href && l.href.includes('watch?v='));
              
              if (llmLinks.length > 0) {
                mergedContent.links = llmLinks;
                logger.info(`[browser.act] LLM Layer 5 extraction found ${llmLinks.length} video(s)`);
                
                // Rebuild markdown with LLM-extracted links
                markdownContent = '\n## Links (LLM Extracted)\n';
                llmLinks.slice(0, 20).forEach(link => {
                  markdownContent += `- [${link.title}](${link.href})${link.channel ? ` — ${link.channel}` : ''}\n`;
                });
              }
            }
          }
        } catch (e) {
          logger.warn(`[browser.act] Layer 5 LLM extraction failed: ${e.message}`);
        }
      }

      const effectiveOk = res.ok || extractedContent;
      return {
        ok: effectiveOk,
        action,
        sessionId,
        stdout: markdownContent || pageText,
        result: markdownContent || pageText,
        extractedContent: mergedContent,
        pageText: pageText,
        executionTime: Date.now() - start,
        error: effectiveOk ? undefined : res.error,
      };
    }

    // ── getText / getPageText ─────────────────────────────────────────────────
    case 'getText':
    case 'getPageText': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          const pageText = await _ePage.evaluate(
            '(function(){var b=document.body;var t=document.title||"";var text=b?(b.innerText||b.textContent||"").slice(0,100000):"";return t?"[Page Title: "+t+"]\\n"+text:text;})()'
          );
          if (pageText.length < 200) {
            logger.info(`[browser.act] getPageText (engine): short content (${pageText.length} chars)`);
          }
          return {
            ok: true,
            action,
            sessionId,
            stdout: pageText,
            result: pageText,
            executionTime: Date.now() - start,
          };
        } catch (gtErr) {
          logger.warn(`[browser.act] getPageText (engine) failed: ${gtErr.message} — falling back to CLI`);
        }
      }

      // ── CLI fallback ──
      const evalExpr = '(function(){var b=document.body;var t=document.title||"";var text=b?(b.innerText||b.textContent||"").slice(0,100000):"";return t?"[Page Title: "+t+"]\\n"+text:text;})()';
      const res = await cliRun([...S, 'eval', evalExpr], Math.min(timeoutMs, 20000));
      const rawOut = (res.stdout || '').trim();
      const resultMatch = rawOut.match(/^([\s\S]*?)(?=###\s|$)/i);
      let pageText;
      if (resultMatch) {
        pageText = resultMatch[1].trim().replace(/^"/, '').replace(/"$/, '');
      } else {
        pageText = rawOut;
      }
      if (pageText.length < 200) {
        logger.info(`[browser.act] getPageText: short content (${pageText.length} chars), raw: ${rawOut.slice(0,200)}`);
      }
      const effectiveOk = res.ok || pageText.length > 0;
      return {
        ok:            effectiveOk,
        action,
        sessionId,
        stdout:        pageText,
        result:        pageText,
        executionTime: Date.now() - start,
        error:         effectiveOk ? undefined : res.error,
      };
    }

    // ── getPageLinks ──────────────────────────────────────────────────────────
    case 'getPageLinks': {
      // Extract all visible links with their text and href
      const evalExpr = `(function(){
        return JSON.stringify(Array.from(document.querySelectorAll('a[href]')).map(a => ({
          text: (a.innerText || a.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 200),
          href: a.href,
          title: (a.title || '').trim()
        })).filter(l => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('javascript:void')));
      })()`;
      const res = await cliRun([...S, 'eval', evalExpr], Math.min(timeoutMs, 20000));
      const rawOut = (res.stdout || '').trim();
      const resultMatch = rawOut.match(/^([\s\S]*?)(?=###\s|$)/i);
      let jsonStr;
      if (resultMatch) {
        jsonStr = resultMatch[1].trim().replace(/^["']|["']$/g, '');
      } else {
        jsonStr = rawOut;
      }

      let links = [];
      try {
        links = JSON.parse(jsonStr);
      } catch (e) {
        // Return empty array on parse failure
      }

      return {
        ok:            res.ok || links.length > 0,
        action,
        sessionId,
        links:         Array.isArray(links) ? links : [],
        stdout:        jsonStr,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── evaluate ─────────────────────────────────────────────────────────────
    case 'evaluate': {
      const expr = text || selector || args.expression || '';

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          // page.evaluate returns JS values directly — no regex parsing needed.
          // Wrap in IIFE if the expression isn't already a function.
          let evalResult;
          if (/^(async\s*)?\(/.test(expr.trim()) || /^(async\s*)?function/.test(expr.trim())) {
            evalResult = await _ePage.evaluate(expr);
          } else {
            // Wrap raw expression in an IIFE for multi-statement support
            evalResult = await _ePage.evaluate(`(() => { return ${expr}; })()`);
          }
          return {
            ok: true,
            action,
            sessionId,
            result: evalResult,
            stdout: String(evalResult ?? ''),
            executionTime: Date.now() - start,
          };
        } catch (evalErr) {
          logger.warn(`[browser.act] evaluate (engine) failed: ${evalErr.message} — falling back to CLI`);
        }
      }

      // ── CLI fallback ──
      const evalRef = args.ref || null;
      const evalArgs = evalRef ? ['eval', '--', expr, evalRef] : ['eval', '--', expr];
      const evalRes = await run(evalArgs, `eval "${expr.slice(0, 60)}"`);
      if (!evalRes.ok) return evalRes;
      
      const stdout = evalRes.stdout || '';
      const match = stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      const rawResult = match ? match[1].trim().replace(/^["']|["']$/g, '') : stdout.trim();
      let result = rawResult;
      if (typeof rawResult === 'string' && (rawResult.startsWith('{') || rawResult.startsWith('['))) {
        try { result = JSON.parse(rawResult); } catch { /* keep as string */ }
      }
      
      return {
        ok: true,
        action,
        sessionId,
        result,
        stdout: evalRes.stdout,
        executionTime: evalRes.executionTime
      };
    }

    // ── run-code ──────────────────────────────────────────────────────────────
    // Runs a full multi-line Playwright Node.js snippet in the current page context.
    // `page` is available. Use a `return` statement to emit a result value.
    // playwright-cli prints the return value as "### Result\n<value>".
    case 'run-code': {
      let code = (args.code || text || '').trim();
      if (!code) {
        return { ok: false, action, sessionId, error: 'run-code: code is required', executionTime: Date.now() - start };
      }
      // ── Engine path: evaluate the code with page context ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          // Build an async function that receives the page object
          const isWrapped = /^async\s+page\s*=>/.test(code) || /^async\s*\(/.test(code);
          const wrappedCode = isWrapped ? code : `async page => {\n${code}\n}`;
          const fn = eval(wrappedCode);
          const result = await fn(_ePage);
          return { ok: true, action, sessionId, result: result, stdout: String(result ?? ''), executionTime: Date.now() - start };
        } catch (e) {
          logger.warn(`[browser.act] run-code (engine) failed: ${e.message} — falling back to CLI`);
        }
      }
      // ── CLI fallback ──
      const isWrapped = /^async\s+page\s*=>/.test(code) || /^async\s*\(/.test(code);
      if (!isWrapped) {
        code = `async page => {\n${code}\n}`;
      }
      const rcRes = await cliRun([...S, 'run-code', '--', code], timeoutMs);
      logger.info(`[browser.act] run-code → exit ${rcRes.exitCode}`, { stderr: rcRes.stderr?.slice(0, 200) });
      const rcStdout = rcRes.stdout || '';
      const rcMatch = rcStdout.match(/^([\s\S]*?)(?=###\s|$)/i);
      const rcResult = rcMatch ? rcMatch[1].trim().replace(/^"|"$/g, '') : rcStdout.trim();
      const PLAYWRIGHT_HARD_ERR = /^### Error/im;
      if (!rcRes.ok || PLAYWRIGHT_HARD_ERR.test(rcStdout)) {
        const errMatch = rcStdout.match(/([A-Za-z]*Error:[^\n]+)/);
        const errMsg = errMatch ? errMatch[1].trim() : (rcRes.error || rcRes.stderr?.trim() || 'run-code failed');
        logger.warn(`[browser.act] run-code error: ${errMsg}`);
        return { ok: false, action, sessionId, result: rcStdout.trim(), stdout: rcStdout, error: errMsg, executionTime: Date.now() - start };
      }
      return { ok: true, action, sessionId, result: rcResult, stdout: rcStdout, executionTime: Date.now() - start };
    }

    // ── dialog-accept / dialog-dismiss ────────────────────────────────────────
    case 'dialog-accept': {
      const prompt = args.prompt || text || undefined;
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          _ePage.once('dialog', async d => { await d.accept(prompt); });
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (e) { logger.warn(`[browser.act] dialog-accept (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(prompt ? ['dialog-accept', '--', prompt] : ['dialog-accept'], 'dialog-accept');
    }
    case 'dialog-dismiss': {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          _ePage.once('dialog', async d => { await d.dismiss(); });
          return { ok: true, action, sessionId, executionTime: Date.now() - start };
        } catch (e) { logger.warn(`[browser.act] dialog-dismiss (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['dialog-dismiss'], 'dialog-dismiss');
    }

    // ── waitForSelector ───────────────────────────────────────────────────────
    case 'waitForSelector': {
      // "body" is not in the accessibility tree so resolveRef will never find it,
      // but it trivially always exists — treat as a post-navigation settle wait.
      if (!selector || /^body$/i.test(selector.trim())) {
        await new Promise(r => setTimeout(r, 1500));
        return { ok: true, action, sessionId, result: 'body', executionTime: Date.now() - start };
      }
      // ── Engine path: page.waitForSelector with visible-element fallback ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          await _ePage.waitForSelector(selector, { timeout: Math.min(timeoutMs, 30000), state: 'visible' });
          return { ok: true, action, sessionId, result: selector, executionTime: Date.now() - start };
        } catch (waitErr) {
          // Playwright's waitForSelector picks the FIRST matching element and waits
          // for it to become visible. When multiple elements match (e.g. LinkedIn has
          // hidden [role="dialog"] video.js modals), it may wait on a permanently-hidden
          // element. Fall back to a custom poll that checks if ANY matching element is visible.
          logger.warn(`[browser.act] waitForSelector (engine) failed: ${waitErr.message.slice(0, 120)} — trying visible-element poll`);
          const _pollDeadline = Date.now() + Math.min(timeoutMs, 10000);
          while (Date.now() < _pollDeadline) {
            try {
              const _visibleMatch = await _ePage.evaluate((sel) => {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                  if (el.getAttribute('aria-hidden') === 'true') continue;
                  if (el.classList?.contains('vjs-hidden') || el.classList?.contains('hidden')) continue;
                  const rect = el.getBoundingClientRect();
                  if (rect.width === 0 && rect.height === 0) continue;
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden') continue;
                  return { found: true, tag: el.tagName, text: (el.innerText || '').slice(0, 80) };
                }
                return { found: false };
              }, selector);
              if (_visibleMatch?.found) {
                logger.info(`[browser.act] waitForSelector visible-poll found <${_visibleMatch.tag}> "${_visibleMatch.text}"`);
                return { ok: true, action, sessionId, result: selector, executionTime: Date.now() - start };
              }
            } catch (_) {}
            await new Promise(r => setTimeout(r, 1000));
          }
          logger.warn(`[browser.act] waitForSelector visible-poll also failed — falling back to CLI`);
        }
      }
      // ── CLI fallback: poll snapshot until ref matching selector appears ──
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await captureSnapshot(sessionId, headed, 5000);
        const ref = resolveRef(sessionId, selector);
        if (ref) {
          return { ok: true, action, sessionId, result: ref, executionTime: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { ok: false, action, sessionId, error: `Timeout waiting for selector: "${selector}"`, executionTime: Date.now() - start };
    }

    // ── waitForContent ────────────────────────────────────────────────────────
    case 'waitForContent': {
      const needle = text || selector || '';
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            const pageText = await _ePage.evaluate('document.body.innerText.slice(0,50000)');
            if (String(pageText || '').includes(needle)) {
              return { ok: true, action, sessionId, result: needle, executionTime: Date.now() - start };
            }
          } catch (_) {}
          await new Promise(r => setTimeout(r, 1500));
        }
        return { ok: false, action, sessionId, error: `Timeout waiting for content: "${needle}"`, executionTime: Date.now() - start };
      }
      // ── CLI fallback ──
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const evalRes = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,50000)'], 8000);
        if (evalRes.ok) {
          const pageText = evalRes.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
          const textContent = pageText ? pageText[1].trim() : evalRes.stdout.trim();
          if (textContent.includes(needle)) {
            return { ok: true, action, sessionId, result: needle, executionTime: Date.now() - start };
          }
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      return { ok: false, action, sessionId, error: `Timeout waiting for content: "${needle}"`, executionTime: Date.now() - start };
    }

    // ── waitForTrigger ────────────────────────────────────────────────────────
    // TRUE event-driven wait: injects a one-shot event listener, polls for the
    // flag or a URL change. Unlike waitForStableText, this does NOT fire until the
    // user actually clicks, types, or submits something on the page.
    case 'waitForTrigger': {
      // Minified inject script — registers a trusted-click-only listener on the page.
      const injectScript = `(function(){if(window.__tdListenerAttached)return;window.__tdTriggered=false;window.__tdListenerAttached=true;document.addEventListener('click',function h(e){if(!e.isTrusted)return;window.__tdTriggered=true;document.removeEventListener('click',h,true);},{capture:true});})()`;

      const TRG_AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple)\b/i;
      const TRG_AUTH_WALL_BODY  = /\b(sign in|log in|sign up)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password)\b/i;

      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.evaluate(injectScript); } catch (_) {}

        let prevUrl = '';
        try { prevUrl = String(await _ePage.evaluate('location.href') || ''); } catch (_) {}

        const effectiveTriggerTimeout = Math.min(timeoutMs, 300000);
        const triggerDeadline = Date.now() + effectiveTriggerTimeout;
        let authCheckCounter = 0;

        while (Date.now() < triggerDeadline) {
          await new Promise(r => setTimeout(r, 1200));
          try {
            // 1. Batch check: interaction flag + URL in one evaluate
            const pollResult = await _ePage.evaluate(() => ({
              triggered: !!(window.__tdTriggered),
              href: location.href,
              bodySnippet: (document.body && document.body.innerText || '').slice(0, 800)
            }));

            if (pollResult.triggered) {
              try { await _ePage.evaluate('window.__tdTriggered=false;window.__tdListenerAttached=false;'); } catch (_) {}
              return { ok: true, action, sessionId, result: 'triggered', executionTime: Date.now() - start };
            }

            // 2. Check URL change
            const curUrl = String(pollResult.href || '');
            if (prevUrl && curUrl && curUrl !== prevUrl && !curUrl.startsWith('about:')) {
              return { ok: true, action, sessionId, result: 'navigation', currentUrl: curUrl, executionTime: Date.now() - start };
            }
            if (curUrl && !curUrl.startsWith('about:')) prevUrl = curUrl;

            // 3. Auth-wall check every 3 polls (uses bodySnippet from batch)
            authCheckCounter++;
            if (authCheckCounter % 3 === 0) {
              const curTxt = String(pollResult.bodySnippet || '');
              const firstLine = curTxt.split('\n')[0].trim();
              if (TRG_AUTH_WALL_FIRST.test(firstLine) || TRG_AUTH_WALL_BODY.test(curTxt.slice(0, 500))) {
                return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: curTxt.slice(0, 100), executionTime: Date.now() - start };
              }
              try { await _ePage.evaluate(injectScript); } catch (_) {}
            }
          } catch (pollErr) {
            logger.debug?.(`[browser.act] waitForTrigger (engine): poll error — ${pollErr.message?.slice(0, 60)}`);
          }
        }
        return { ok: false, action, sessionId, error: `waitForTrigger: timeout after ${timeoutMs}ms — no user interaction detected`, executionTime: Date.now() - start };
      }

      // ── CLI fallback ──
      await cliRun([...S, 'eval', injectScript], 5000).catch(() => {});

      // Capture initial URL so we can detect navigation
      const extractResult = (stdout) => {
        const m = stdout.trim().match(/^([\s\S]*?)(?=###\s|$)/i);
        return (m ? m[1].trim() : stdout.trim()).replace(/^"|"$/g, '');
      };
      let prevUrl = '';
      try {
        prevUrl = extractResult((await cliRun([...S, 'eval', 'location.href'], 4000)).stdout);
      } catch (_) {}

      const effectiveTriggerTimeout = Math.min(timeoutMs, 300000);
      const triggerDeadline = Date.now() + effectiveTriggerTimeout;
      let authCheckCounter = 0;
      let consecutivePollErrors = 0;

      while (Date.now() < triggerDeadline) {
        await new Promise(r => setTimeout(r, 1200));
        try {
          // 1. Check interaction flag
          const flagVal = extractResult((await cliRun([...S, 'eval', '!!(window.__tdTriggered)'], 4000)).stdout);
          if (flagVal === 'true') {
            await cliRun([...S, 'eval', 'window.__tdTriggered=false;window.__tdListenerAttached=false;'], 3000).catch(() => {});
            return { ok: true, action, sessionId, result: 'triggered', executionTime: Date.now() - start };
          }

          // 2. Check URL change (user clicked a navigation link / submitted a form)
          const curUrl = extractResult((await cliRun([...S, 'eval', 'location.href'], 4000)).stdout);
          if (prevUrl && curUrl && curUrl !== prevUrl && !curUrl.startsWith('about:')) {
            return { ok: true, action, sessionId, result: 'navigation', currentUrl: curUrl, executionTime: Date.now() - start };
          }
          if (curUrl && !curUrl.startsWith('about:')) prevUrl = curUrl;

          // 3. Auth-wall check every 3 polls (saves bandwidth on static pages)
          authCheckCounter++;
          if (authCheckCounter % 3 === 0) {
            const curTxt = extractResult((await cliRun([...S, 'eval', '(document.body.innerText||"").slice(0,800)'], 5000)).stdout);
            const firstLine = curTxt.split('\n')[0].trim();
            if (TRG_AUTH_WALL_FIRST.test(firstLine) || TRG_AUTH_WALL_BODY.test(curTxt.slice(0, 500))) {
              return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: curTxt.slice(0, 100), executionTime: Date.now() - start };
            }
            // Re-inject listener after page potentially changed (navigation, SPA route)
            await cliRun([...S, 'eval', injectScript], 5000).catch(() => {});
          }
          // Reset consecutive error counter on any successful poll
          consecutivePollErrors = 0;
        } catch (pollErr) {
          consecutivePollErrors++;
          // If every poll is failing, the browser session doesn't exist — fail fast
          // instead of looping silently for up to 5 minutes.
          if (consecutivePollErrors >= 3) {
            return { ok: false, action, sessionId, error: `waitForTrigger: no active browser session "${sessionId}" — playwright-cli is not running or the session was never opened`, executionTime: Date.now() - start };
          }
          logger.debug?.(`[browser.act] waitForTrigger: poll error — ${pollErr.message?.slice(0, 60)}`);
        }
      }
      return { ok: false, action, sessionId, error: `waitForTrigger: timeout after ${timeoutMs}ms — no user interaction detected`, executionTime: Date.now() - start };
    }

    // ── waitForNavigation — alias to waitForStableText ────────────────────────
    // Falls through to waitForStableText which polls until page text stabilises.
    case 'waitForNavigation':
    // ── waitForStableText ─────────────────────────────────────────────────────
    case 'waitForStableText': {
      // ── Engine path: use page.evaluate() for all polling ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        // Batch probe: get hostname + initial page state in one call
        const initialProbe = await batchProbe(_ePage);
        const isGmailSession = initialProbe
          ? (initialProbe.hostname || '').includes('mail.google.com')
          : sessionId.includes('gmail');

        if (isGmailSession) {
          logger.info(`[browser.act] Using Gmail-optimized waitForStableText (engine) for session=${sessionId}`);
          // Engine path for Gmail: change-then-stable two-phase polling
          const effectiveTimeout = Math.min(timeoutMs, 30000);
          const deadline = Date.now() + effectiveTimeout;
          const isComposeUrl = (u) => /compose=new/.test(String(u));

          // Change-then-stable: Phase 1 waits for content to change from baseline,
          // Phase 2 waits for 2 consecutive stable reads. No fixed delays.
          let baselineText = null;
          let baselineHref = null;
          let phase = 1; // 1 = waiting for change, 2 = waiting for stability
          let prev = '';
          let stableCount = 0;
          const maxStableCount = 2;
          let lastContent = '';

          while (Date.now() < deadline) {
            if (deadline - Date.now() < 3000) break;
            const probe = await batchProbe(_ePage);
            if (probe) {
              if (/about:blank/i.test(String(probe.href))) {
                return { ok: true, action, sessionId, result: '', stdout: '', aboutBlankDetected: true, executionTime: Date.now() - start };
              }

              // For compose=new deep-link, wait for the compose modal to actually render
              if (isComposeUrl(probe.href)) {
                try {
                  const composeState = await _ePage.evaluate(() => {
                    const dialog = document.querySelector('div[role="dialog"]');
                    const text = (dialog ? dialog.innerText : document.body ? document.body.innerText : '') || '';
                    const hasContentEditable = [...document.querySelectorAll('[contenteditable="true"]')].some(el => el.offsetParent !== null);
                    return { text: text.slice(0, 2000), hasContentEditable, hasCompose: /new message|subject|to/i.test(text) };
                  });
                  if (composeState && composeState.hasContentEditable && composeState.hasCompose) {
                    logger.info(`[browser.act] waitForStableText (engine): Gmail compose modal ready (${composeState.text.length} chars)`);
                    return { ok: true, action, sessionId, result: composeState.text, executionTime: Date.now() - start };
                  }
                } catch (_) {}
              } else {
                const cur = String(probe.bodyText || '');
                const curHref = String(probe.href || '');
                lastContent = cur;

                // Early exit: "no results" pages are already stable — no need to wait
                // for content to change. This avoids a 27s timeout when a search returns
                // zero matches (e.g., Gmail "No messages matched your search").
                if (/\b(no messages matched|no results?\s*(?:found|matched)?|nothing (?:found|matched)|no matching)\b/i.test(cur)) {
                  logger.info(`[browser.act] waitForStableText (engine): Gmail "no results" detected (${cur.length} chars) — returning immediately`);
                  return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
                }

                if (phase === 1) {
                  // Phase 1 — Wait for change from baseline
                  if (baselineText === null) {
                    baselineText = cur;
                    baselineHref = curHref;
                    logger.info(`[browser.act] waitForStableText (engine): Gmail baseline captured (${cur.length} chars, href=${curHref})`);
                  } else {
                    const hrefChanged = curHref !== baselineHref;
                    const textChanged = cur.length > 100 && Math.abs(cur.length - baselineText.length) / Math.max(cur.length, baselineText.length, 1) > 0.2;
                    if (hrefChanged || textChanged) {
                      phase = 2;
                      prev = cur;
                      stableCount = 0;
                      logger.info(`[browser.act] waitForStableText (engine): Gmail content changed (hrefChanged=${hrefChanged}, textLen ${baselineText.length}→${cur.length}) — entering stability phase`);
                    }
                  }
                } else {
                  // Phase 2 — Wait for stability (2 consecutive matching reads)
                  if (cur === prev) {
                    stableCount++;
                    logger.debug(`[browser.act] waitForStableText (engine): Gmail stable count ${stableCount}/${maxStableCount}`);
                    if (stableCount >= maxStableCount) {
                      logger.info(`[browser.act] waitForStableText (engine): Gmail content stabilized after ${Date.now() - start}ms (${cur.length} chars)`);
                      return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
                    }
                  } else {
                    // Near-stable: <5% change ratio counts as stable
                    const longer = Math.max(prev.length, cur.length);
                    const changeRatio = Math.abs(cur.length - prev.length) / longer;
                    if (changeRatio < 0.05) {
                      stableCount++;
                      logger.debug(`[browser.act] waitForStableText (engine): Gmail near-stable (${(changeRatio * 100).toFixed(1)}% change) count ${stableCount}/${maxStableCount}`);
                      if (stableCount >= maxStableCount) {
                        logger.info(`[browser.act] waitForStableText (engine): Gmail content near-stable after ${Date.now() - start}ms (${cur.length} chars)`);
                        return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
                      }
                    } else {
                      stableCount = 0;
                    }
                    prev = cur;
                  }
                }
              }
            }
            await new Promise(r => setTimeout(r, 1500));
          }
          // Timeout — return last known content (graceful degradation)
          logger.info(`[browser.act] waitForStableText (engine): Gmail timeout after ${Date.now() - start}ms — returning last content (${lastContent.length} chars, phase=${phase})`);
          return { ok: true, action, sessionId, result: lastContent, executionTime: Date.now() - start };
        }

        // Standard waitForStableText with engine polling
        logger.info(`[browser.act] Using standard waitForStableText (engine) for session=${sessionId}`);

        const AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple|sign in to x|sign in with google|sign in with apple|login to|log into|happening now|where should we begin)\b/i;
        const AUTH_WALL_BODY = /\b(sign in|log in|sign up|join today|create account)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password|sign up with|continue with)\b/i;
        const AUTH_WALL_LOGGEDOUT = /\b(log in|sign in|sign up for free)\b[\s\S]{0,200}\b(where should we begin|get started|create account|free account|try for free)\b/i;
        const RESTORE_DIALOG = /restore pages?\?|chrome didn't shut down correctly|help make google chrome better/i;

        const effectiveTimeout = Math.min(timeoutMs, 30000);
        let prev = '';
        let nearStableCount = 0;
        const loopStart = Date.now();
        const deadline = loopStart + effectiveTimeout;

        while (Date.now() < deadline) {
          if (deadline - Date.now() < 3000) break;

          // Batch probe: single evaluate for URL + body text
          const probe = await batchProbe(_ePage);
          if (!probe) { await new Promise(r => setTimeout(r, 200)); continue; }

          // Fail fast on about:blank
          if (/about:blank/i.test(String(probe.href))) {
            logger.warn(`[browser.act] waitForStableText (engine): page is about:blank for session=${sessionId}`);
            return { ok: true, action, sessionId, result: '', stdout: '', aboutBlankDetected: true, executionTime: Date.now() - start };
          }

          const cur = String(probe.bodyText || '');

          // Detect Chrome restore dialog
          if (RESTORE_DIALOG.test(cur)) {
            logger.info(`[browser.act] waitForStableText (engine): Chrome restore dialog detected — pressing Escape`);
            try { await _ePage.keyboard.press('Escape'); } catch (_) {}
            await new Promise(r => setTimeout(r, 600));
            try { await _ePage.keyboard.press('Escape'); } catch (_) {}
            await new Promise(r => setTimeout(r, 600));
            prev = '';
            continue;
          }

          // Universal skeleton content detection
          const wordCount = cur.split(/\s+/).filter(w => w.length > 0).length;
          if (wordCount < 20 && !cur.includes('about:blank')) {
            nearStableCount = 0;
            prev = cur;
            await new Promise(r => setTimeout(r, 200));
            continue;
          }

          if (cur && cur === prev) {
            const firstLine = cur.split('\n')[0].trim();
            const isAuthWall = AUTH_WALL_FIRST.test(firstLine) || AUTH_WALL_BODY.test(cur.slice(0, 500)) || AUTH_WALL_LOGGEDOUT.test(cur.slice(0, 600));
            if (isAuthWall) {
              const wc = cur.trim().split(/\s+/).filter(Boolean).length;
              if (wc > 100) {
                logger.info(`[browser.act] waitForStableText (engine): auth overlay detected but page has ${wc} words — returning content`);
                return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
              }
              logger.info(`[browser.act] waitForStableText (engine): auth wall detected for session=${sessionId}`);
              return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: cur.slice(0, 100), executionTime: Date.now() - start };
            }
            return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
          }

          // Near-stable exit — requires 3 consecutive reads with < 5% change
          // AND at least 3 seconds elapsed (prevents premature exit before AI
          // response streaming starts — bodyLen can be > 3000 from page chrome alone).
          // Previously was 1 consecutive read which exited during natural 200ms
          // pauses in LLM streaming, truncating the captured response.
          if (prev && cur && cur.length > 3000) {
            const longer = Math.max(prev.length, cur.length);
            const changeRatio = Math.abs(cur.length - prev.length) / longer;
            const elapsed = Date.now() - loopStart;
            if (changeRatio < 0.05) {
              nearStableCount++;
              if (nearStableCount >= 3 && elapsed > 3000) {
                logger.info(`[browser.act] waitForStableText (engine): near-stable (${(changeRatio * 100).toFixed(1)}% change, ${cur.length} chars, ${nearStableCount} consecutive, ${elapsed}ms elapsed) — returning`);
                return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
              }
            } else {
              nearStableCount = 0;
            }
            if (elapsed > 15000 && cur.length > 1500) {
              logger.info(`[browser.act] waitForStableText (engine): streaming page, ${elapsed}ms elapsed with ${cur.length} chars — accepting`);
              return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
            }
          }
          prev = cur;
          await new Promise(r => setTimeout(r, 200));
        }

        // Timeout — return ok:false instead of stale content
        logger.info(`[browser.act] waitForStableText (engine): timeout after ${Date.now() - start}ms — page did not stabilize`);
        const finalProbe = await batchProbe(_ePage);
        if (finalProbe && finalProbe.bodyText && finalProbe.bodyText.length > 100) {
          return { ok: true, action, sessionId, result: String(finalProbe.bodyText), executionTime: Date.now() - start };
        }
        return { ok: false, action, sessionId, error: `waitForStableText: page did not stabilize within ${timeoutMs}ms`, executionTime: Date.now() - start };
      }

      // ── CLI fallback (original path) ──
      // Check if this is a Gmail session - use Gmail-optimized version if so
      let isGmailSession = false;
      try {
        const hostnameCheck = await cliRun([...S, 'eval', 'window.location.hostname'], 2000);
        if (hostnameCheck.ok && hostnameCheck.stdout) {
          const hostname = hostnameCheck.stdout.match(/^([\s\S]*?)(?=###\s|$)/i);
          isGmailSession = hostname && hostname[1] && hostname[1].includes('mail.google.com');
        }
      } catch (error) {
        // If hostname check fails, try session name as fallback
        isGmailSession = sessionId.includes('gmail');
      }
      
      if (isGmailSession) {
        // Use Gmail-optimized stable text detection
        logger.info(`[browser.act] Using Gmail-optimized waitForStableText for session=${sessionId}`);
        const gmailResult = await waitForGmailStableText(sessionId, timeoutMs);
        
        return {
          ok: gmailResult.ok,
          action,
          sessionId,
          result: gmailResult.result,
          stdout: gmailResult.result,
          aboutBlankDetected: gmailResult.aboutBlankDetected,
          executionTime: gmailResult.executionTime || Date.now() - start
        };
      } else {
        // Use standard waitForStableText with universal skeleton detection for dynamic sites
        logger.info(`[browser.act] Using standard waitForStableText for session=${sessionId}`);
        
        // Auth-wall patterns — text that indicates a login/sign-in page, not real content
        const AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple|sign in to x|sign in with google|sign in with apple|login to|log into|happening now|where should we begin)\b/i;
        const AUTH_WALL_BODY = /\b(sign in|log in|sign up|join today|create account)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password|sign up with|continue with)\b/i;
        // Logged-out UI patterns — sites that show a guest/unauthenticated landing page
        const AUTH_WALL_LOGGEDOUT = /\b(log in|sign in|sign up for free)\b[\s\S]{0,200}\b(where should we begin|get started|create account|free account|try for free)\b/i;
        // Chrome crash-restore dialog
        const RESTORE_DIALOG = /restore pages?\?|chrome didn't shut down correctly|help make google chrome better/i;

        // Cap effective timeout at 30s — MCPClient transport timeout is 60s.
        // Each cliRun eval can take up to 8s, so we need a hard pre-check before
        // each iteration to avoid overshooting. Stop if <10s remain to leave buffer.
        const effectiveTimeout = Math.min(timeoutMs, 30000);
        let prev = '';
        let nearStableCount = 0; // Require 2 consecutive near-stable polls before early-exit
        const loopStart = Date.now();
        const deadline = loopStart + effectiveTimeout;
        while (Date.now() < deadline) {
          // Hard bail: if less than 10s left, don't start another 8s eval — return what we have
          if (deadline - Date.now() < 10000) break;

          // Fail fast on about:blank so callers can recover instead of re-planning on empty data.
          try {
            const urlProbe = await cliRun([...S, 'eval', 'window.location.href'], 2000);
            const urlRaw = (urlProbe.stdout || '').trim();
            const urlMatch = urlRaw.match(/^([\s\S]*?)(?=###\s|$)/i);
            const curUrl = (urlMatch ? urlMatch[1] : urlRaw).trim().replace(/^"|"$/g, '');
            if (/about:blank/i.test(curUrl)) {
              logger.warn(`[browser.act] waitForStableText: page is about:blank for session=${sessionId}`);
              return {
                ok: true,
                action,
                sessionId,
                result: '',
                stdout: '',
                aboutBlankDetected: true,
                executionTime: Date.now() - start,
              };
            }
          } catch (_) {
            // URL probe failures are transient; continue polling page text.
          }

          // Use lighter eval for non-Gmail pages to reduce timeout risk
          const r = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,25000)'], 6000);
          // playwright-cli output format: <result>\n### Ran Playwright code\n...
          // No "### Result" header — extract everything BEFORE the first ### header.
          const rawOut = (r.stdout || '').trim();
          const resultMatch = rawOut.match(/^([\s\S]*?)(?=###\s|$)/i);
          const cur = resultMatch
            ? resultMatch[1].trim().replace(/^"|"$/g, '')
            : rawOut;

          // Detect Chrome restore dialog — dismiss it with Escape (native browser UI, not page DOM)
          if (RESTORE_DIALOG.test(cur)) {
            logger.info(`[browser.act] waitForStableText: Chrome restore dialog detected — pressing Escape`);
            await cliRun([...S, 'press', 'Escape'], 3000);
            await new Promise(r2 => setTimeout(r2, 600));
            await cliRun([...S, 'press', 'Escape'], 3000);
            await new Promise(r2 => setTimeout(r2, 600));
            prev = '';
            continue;
          }

          // Universal skeleton content detection for ALL dynamic sites (YouTube, Facebook, etc.)
          // If content is suspiciously sparse (<20 words), it's not "stable" yet
          const wordCount = cur.split(/\s+/).filter(w => w.length > 0).length;
          if (wordCount < 20 && !cur.includes('about:blank')) {
            logger.debug(`[browser.act] waitForStableText: skeleton content detected (${wordCount} words), continuing wait...`);
            nearStableCount = 0; // Reset - skeleton is not "stable enough"
            prev = cur;
            await new Promise(r => setTimeout(r, 800));
            continue;
          }

          if (cur && cur === prev) {
            // Check if stable content is an auth wall
            const firstLine = cur.split('\n')[0].trim();
            const isAuthWall = AUTH_WALL_FIRST.test(firstLine) || AUTH_WALL_BODY.test(cur.slice(0, 500)) || AUTH_WALL_LOGGEDOUT.test(cur.slice(0, 600));
            if (isAuthWall) {
              // If the page has substantial content (>100 words), the auth overlay is
              // transient (e.g. Gemini "sign in to save history" banner on top of a real
              // response). Return the content rather than blanking it out.
              const wordCount = cur.trim().split(/\s+/).filter(Boolean).length;
              if (wordCount > 100) {
                logger.info(`[browser.act] waitForStableText: auth overlay detected but page has ${wordCount} words — returning content (transient overlay)`);
                return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
              }
              logger.info(`[browser.act] waitForStableText: auth wall detected for session=${sessionId}`);
              return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: cur.slice(0, 100), executionTime: Date.now() - start };
            }
            return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
          }
          // Early-exit: if content is substantial and barely changed since last poll,
          // treat as "stable enough". Pages like YouTube search keep micro-updating
          // (ad slots, counters) so perfect equality never happens within the window.
          // REQUIRE 2 consecutive near-stable polls to prevent false positives on skeleton pages
          // that appear stable before hydration completes.
          if (prev && cur && cur.length > 3000) {
            const longer = Math.max(prev.length, cur.length);
            const changeRatio = Math.abs(cur.length - prev.length) / longer;
            if (changeRatio < 0.05) {
              nearStableCount++;
              if (nearStableCount >= 2) {
                logger.info(`[browser.act] waitForStableText: near-stable x2 (${(changeRatio * 100).toFixed(1)}% change, ${cur.length} chars) — returning early`);
                return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
              }
              logger.debug(`[browser.act] waitForStableText: near-stable (${(changeRatio * 100).toFixed(1)}% change) — count ${nearStableCount}/2`);
            } else {
              nearStableCount = 0; // Reset counter if content changed significantly
            }
            // Streaming-growth exit: AI answer pages (Grok, Perplexity, ChatGPT) keep growing
            // continuously — content never stabilizes. If we've been polling >15s and have
            // substantial content, accept what we have rather than waiting for the full timeout.
            const elapsed = Date.now() - loopStart;
            if (elapsed > 15000 && cur.length > 1500) {
              logger.info(`[browser.act] waitForStableText: streaming page, ${elapsed}ms elapsed with ${cur.length} chars — accepting`);
              return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
            }
          }
          prev = cur;
          await new Promise(r2 => setTimeout(r2, 800));
        }
        // Timeout — page never stabilized (e.g. hydration-delayed pages, infinite scroll, live feeds).
        // Always do a final fetch here — prev may contain stale skeleton content from early polls.
        // The final fetch captures whatever is actually on the page now, even if it never "stabilized".
        logger.info(`[browser.act] waitForStableText: timeout after ${Date.now() - start}ms — doing final content fetch`);
        const lastRes = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,25000)'], 6000);
        const lastRaw = (lastRes.stdout || '').trim();
        const lastMatch = lastRaw.match(/^([\s\S]*?)(?=###\s|$)/i);
        const finalText = lastMatch ? lastMatch[1].trim().replace(/^"|"$/g, '') : lastRaw;
        const wordCount = finalText.trim().split(/\s+/).filter(Boolean).length;
        logger.info(`[browser.act] waitForStableText: final fetch returned ${finalText.length} chars, ${wordCount} words`);
        return { ok: true, action, sessionId, result: finalText, executionTime: Date.now() - start };
      }
    }

    // ── waitForAuth ───────────────────────────────────────────────────────────
    // Polls the page until it is NO LONGER on a login/auth wall.
    // Used after a login sub-plan to confirm authentication succeeded before
    // the parent plan resumes.
    //
    // Returns:
    //   { ok: true,  authResolved: true }   — page has left the login wall
    //   { ok: false, authTimedOut: true }   — timed out still on login page
    //   { ok: false, authFailed: true }     — explicit error/redirect detected
    case 'waitForAuth': {
      // ── Engine-aware local helpers ──
      const _ePage = engine.getPage(sessionId);
      const _authEval = async (expr, tMs = 5000) => {
        if (_ePage) {
          try { return { ok: true, val: await _ePage.evaluate(expr), stdout: '' }; }
          catch (e) { return { ok: false, val: null, stdout: '', error: e.message }; }
        }
        const r = await cliRun([...S, 'eval', expr], tMs).catch(() => ({}));
        const raw = (r.stdout || '').trim();
        const m = raw.match(/^([\s\S]*?)(?=###\s|$)/i);
        return { ok: r.ok, val: m ? m[1].trim().replace(/^"|"$/g, '') : raw, stdout: r.stdout || '' };
      };
      const _authClick = async (sel, tMs = 5000) => {
        if (_ePage) { try { await _ePage.click(sel, { timeout: tMs }); return { ok: true }; } catch (_) {} }
        return cliRun([...S, 'click', sel], tMs).catch(() => ({ ok: false }));
      };
      const _authType = async (txt, tMs = 8000) => {
        if (_ePage) { try { await _ePage.keyboard.type(txt, { timeout: tMs }); return { ok: true }; } catch (_) {} }
        return cliRun([...S, 'type', '--', txt], tMs).catch(() => ({ ok: false }));
      };
      const _authPress = async (key, tMs = 3000) => {
        if (_ePage) { try { await _ePage.keyboard.press(key); return { ok: true }; } catch (_) {} }
        return cliRun([...S, 'press', key], tMs).catch(() => ({ ok: false }));
      };
      const _authGoto = async (url, tMs = 15000) => {
        if (_ePage) { try { await _ePage.goto(url, { waitUntil: 'domcontentloaded', timeout: tMs }); return { ok: true }; } catch (_) {} }
        return cliRun([...S, 'goto', url], tMs).catch(() => ({ ok: false }));
      };
      const _authSnapshot = async (tMs = 8000) => {
        if (_ePage) {
          try {
            const { yaml } = await engine.buildRefTree(_ePage);
            if (yaml) { snapshotCache.set(_tabKey(sessionId), yaml); return { ok: true, stdout: yaml }; }
          } catch (_) {}
        }
        return cliRun([...S, 'snapshot'], tMs).catch(() => ({ ok: false, stdout: '' }));
      };

      // URL-host state machine — no hardcoded domain lists.
      // authOriginHost = hostname of the sign-in URL (e.g. 'accounts.google.com').
      // Derived dynamically at runtime so any OAuth provider works automatically.
      // hostAliases = optional array of equivalent hostnames (e.g. notion.so ↔ notion.com).
      //
      //  IN_AUTH_FLOW: isHostEquivalent(currentHost, authOriginHost)  (email, pwd, 2FA, consent, etc.)
      //  SUCCESS:      !isHostEquivalent(currentHost, authOriginHost) AND urlWithoutQuery includes authSuccessUrl
      //  LIMBO:        !isHostEquivalent(currentHost, authOriginHost) AND NOT at authSuccessUrl
      const _aliases = Array.isArray(hostAliases) ? hostAliases.map(h => String(h).toLowerCase()).filter(Boolean) : [];
      const isHostEquivalent = (a, b) => {
        if (!a || !b) return false;
        const ah = a.toLowerCase(), bh = b.toLowerCase();
        if (ah === bh) return true;
        // Parent-domain check: www.example.com is equivalent to example.com,
        // but accounts.google.com is NOT equivalent to myaccount.google.com
        if (ah.endsWith(`.${bh}`) || bh.endsWith(`.${ah}`)) return true;
        for (const alias of _aliases) {
          const alb = alias.toLowerCase();
          if (alb === ah || alb === bh) return true;
          if (ah.endsWith(`.${alb}`) || bh.endsWith(`.${alb}`)) return true;
          if (alb.endsWith(`.${ah}`) || alb.endsWith(`.${bh}`)) return true;
        }
        return false;
      };
      let authOriginHost = null;
      let authSignInPath   = null; // for same-domain path exit (e.g. notion.so/login → notion.so/onboarding)
      try { if (url) { const _u = new URL(url); authOriginHost = _u.hostname; authSignInPath = _u.pathname; } } catch (_) {}
      const getHost = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
      let lastLimboUrl = null;     // anti-loop guard
      let backToSignInCount = 0;   // RC2: hard stop — max 3 code-triggered back-to-sign-in navigations
      let _wasOnOAuthProvider = false; // tracks that user visited a 3rd-party OAuth provider this session

      // ── CDP cookie-sniff baseline (auth auto-detection) ───────────────────
      // On the first poll inside the auth flow, snapshot existing auth-cookie
      // names so we only declare success when NEW auth cookies appear (defence
      // against pre-existing CSRF/locale cookies that survived the exclude rules).
      let _authCookieBaseline = null;   // Set<string> | null
      // Target domain for cookie sniffing: prefer authSuccessUrl host (the
      // authenticated app host), else authOriginHost. Strip leading 'www.'.
      let _cookieSniffDomain = null;
      try {
        const _csHost = authSuccessUrl
          ? (new URL(authSuccessUrl.includes('://') ? authSuccessUrl : `https://${authSuccessUrl}`).hostname || '')
          : authOriginHost;
        _cookieSniffDomain = String(_csHost || '').replace(/^www\./, '');
      } catch (_) {}

      // Default timeout: 120s — enough for a human to complete 2FA or MFA
      const effectiveTimeout = Math.min(timeoutMs || 120000, 120000);
      const pollInterval = 2000;

      // ── Step 1: navigate to url first so the browser actually opens ──────
      // Without this the daemon never starts, eval returns empty text, and we
      // spin until timeout on about:blank (the session's last page or nothing).
      if (url) {
        const navTimeout = 30000;
        let alreadyOpen = openSessions.has(sessionId);
        if (!alreadyOpen) {
          alreadyOpen = await isDaemonAlive(sessionId, headed);
          if (alreadyOpen) openSessions.add(sessionId);
        }
        // Skip navigation if browser is already on the target login URL's hostname.
        // currentUrl is passed by browser.agent (the URL it already probed) — avoids
        // an extra eval call and brittle stdout regex parsing.
        let _skipNav = false;
        if (alreadyOpen && currentUrl) {
          try {
            const _curHost = new URL(currentUrl).hostname;
            const _targetHost = new URL(url).hostname;
            if (isHostEquivalent(_curHost, _targetHost)) {
              _skipNav = true;
              logger.info(`[browser.act] waitForAuth: already on ${_curHost} (equivalent to ${_targetHost}) — skipping redundant navigation (session=${sessionId})`);
            }
          } catch (_) { /* URL parse failed — proceed with navigation */ }
        }
        if (!_skipNav) {
          if (!alreadyOpen) clearProfileLock(sessionId);
          snapshotCache.delete(_tabKey(sessionId));
          let navOk = false;
          if (_ePage && alreadyOpen) {
            navOk = (await _authGoto(url, navTimeout)).ok;
          } else {
            const navCmd = alreadyOpen ? 'goto' : 'open';
            const navRes = await cliRun([...S, navCmd, ...(navCmd === 'open' ? openFlags(true) : []), url], navTimeout);
            navOk = navRes.ok;
          }
          if (navOk) openSessions.add(sessionId);
          logger.info(`[browser.act] waitForAuth: navigated to ${url} on session=${sessionId} (ok=${navOk})`);
        }
      }

      // ── Step 1c: Detect service-level domain redirect ─────────────────────
      // After navigating to the sign-in URL, some services redirect to a different
      // domain (e.g., twitter.com → x.com). Without detecting this, the state
      // machine treats the new domain as "limbo" and loops navigating back to the
      // original sign-in URL. This reads the actual URL after the redirect settles
      // and, if the host changed before any user interaction, treats the new host
      // as a runtime alias for the original auth origin host.
      if (url && authOriginHost) {
        await new Promise(r => setTimeout(r, 1500)); // allow redirect to settle
        try {
          const _postNavProbe = await _authEval('location.href', 5000);
          const _postNavUrl = String(_postNavProbe.val || '').trim();
          if (_postNavUrl) {
            const _postNavHost = getHost(_postNavUrl);
            if (_postNavHost && _postNavHost !== authOriginHost && !isHostEquivalent(_postNavHost, authOriginHost)) {
              // ── Check if redirect target is actually a sign-in page ──────────
              // The alias was added for twitter.com → x.com (where x.com/i/flow/login
              // IS still a sign-in page). But Google redirects accounts.google.com →
              // myaccount.google.com when the user is ALREADY logged in — aliasing
              // myaccount.google.com traps the state machine in "IN AUTH FLOW" forever.
              // Only add as alias if the redirect target page is actually a login wall.
              let _isRedirectSignInPage = true; // default: assume sign-in (preserves prior behavior)
              try {
                const _redirectMetaExpr = `(() => {
                  const title = (document.title || '').toLowerCase();
                  const titleIsLogin = /sign.?in|log.?in|\\\\blogin\\\\b|authenticate|verify|two.factor|2fa/.test(title);
                  const signInLinks = document.querySelectorAll(
                    'a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="signup"], a[href*="register"]'
                  );
                  const signInButtons = Array.from(
                    document.querySelectorAll('button, a[role="button"], [data-testid]')
                  ).filter(el => {
                    const text = (el.textContent || el.innerText || '').toLowerCase().trim();
                    return /^(sign\\s*in|log\\s*in|sign\\s*up|register)\\b/.test(text);
                  });
                  const hasSignInButton = signInLinks.length > 0 || signInButtons.length > 0;
                  const bodyText = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 500) : '';
                  const hasLoginForm = !!document.querySelector('input[type="email"], input[type="password"], input[name="identifier"], input#identifierId');
                  return JSON.stringify({ titleIsLogin, hasSignInButton, hasLoginForm, title: document.title || '', bodyLen: bodyText.length });
                })()`;
                const _redirectMetaRes = await _authEval(_redirectMetaExpr, 5000);
                const _redirectMeta = JSON.parse(String(_redirectMetaRes.val || '{}').trim());
                _isRedirectSignInPage = _redirectMeta.titleIsLogin || _redirectMeta.hasSignInButton || _redirectMeta.hasLoginForm;
                logger.info(`[browser.act] waitForAuth: redirect target ${_postNavHost} sign-in check: titleIsLogin=${_redirectMeta.titleIsLogin} hasSignInButton=${_redirectMeta.hasSignInButton} hasLoginForm=${_redirectMeta.hasLoginForm} → isSignInPage=${_isRedirectSignInPage} (session=${sessionId})`);
              } catch (_redirectMetaErr) {
                logger.debug(`[browser.act] waitForAuth: redirect target meta check failed (non-fatal): ${_redirectMetaErr.message}`);
              }

              if (_isRedirectSignInPage) {
                // Redirect target IS a sign-in page (e.g. twitter.com → x.com/i/flow/login)
                // → add as alias so the state machine treats it as IN AUTH FLOW
                _aliases.push(_postNavHost);
                logger.info(`[browser.act] waitForAuth: service redirected ${authOriginHost} → ${_postNavHost} (sign-in page) — adding as runtime alias for session=${sessionId}`);
                if (authSuccessUrl && authSuccessUrl.includes(authOriginHost)) {
                  authSuccessUrl = authSuccessUrl.replace(authOriginHost, _postNavHost);
                  logger.info(`[browser.act] waitForAuth: updated authSuccessUrl to ${authSuccessUrl} for session=${sessionId}`);
                }
              } else {
                // Redirect target is NOT a sign-in page (e.g. accounts.google.com → myaccount.google.com)
                // → user is already logged in. Don't alias — navigate to authSuccessUrl
                // so the state machine can detect SUCCESS (or LIMBO if still not at target).
                logger.info(`[browser.act] waitForAuth: service redirected ${authOriginHost} → ${_postNavHost} (NOT a sign-in page — user likely logged in) — navigating to authSuccessUrl for session=${sessionId}`);
                if (authSuccessUrl) {
                  // authSuccessUrl may be a bare hostname pattern (e.g. 'mail.google.com')
                  const _gotoUrl = /^https?:\/\//i.test(authSuccessUrl)
                    ? authSuccessUrl
                    : `https://${authSuccessUrl.split(/[,|]/)[0].trim()}`;
                  await _authGoto(_gotoUrl, 15000);
                }
              }
            }
          }
        } catch (_) {}
      }

      // ── Step 1b: Agentic auth form loop ──────────────────────────────────
      // snapshot → LLM → execute → snapshot → LLM → repeat.
      // All page-transition waits are event-driven (URL change / element visibility)
      // rather than fixed sleeps. No hardcoded timing or branch logic.
      const _credentials = credentials || {};
      if (!noAutofill) {
      try {
        const _hasEmail    = !!(_credentials.email);
        const _hasPassword = !!(_credentials.password);
        let _loopFilledEmail    = false;
        let _loopFilledPassword = false;
        const _actionHistory   = []; // actions completed this session
        let _stallCount        = 0;  // consecutive click_submit stalls
        let _consecutiveInvisibleFailures = 0; // circuit breaker: too many invisible-input steps
        let _doneWithoutAction = false; // circuit breaker: LLM said done but no creds filled

        // ── Helper: inline 2-poll text settle (~600–1200ms).
        const _textSettle = async () => {
          const _et = async () => {
            const r = await _authEval('document.body.innerText.slice(0,500)', 5000);
            return String(r.val || '').trim();
          };
          const t1 = await _et();
          await new Promise(r => setTimeout(r, 600));
          const t2 = await _et();
          if (t1 !== t2) await new Promise(r => setTimeout(r, 600));
        };

        // ── Helper: poll until a matching input is fully visible on screen.
        // Checks display, visibility, opacity (>= 0.9), offsetHeight/Width — catches
        // Google's hidden input[type="password"] on the email page (opacity:0, height:0).
        // Returns the most specific selector available (#id > [name=x] > fallback) or null.
        const _waitVisible = async (type /* 'email' | 'password' */, fallbackSel, timeoutMs = 15000) => {
          const query = type === 'email'
            ? 'input[type="email"],input[autocomplete="email"],input[autocomplete="username"],input[name="email"],input[name="username"],input[name="identifier"],input#identifierId'
            : 'input[type="password"]';
          const jsCheck = `() => {
            const els = [...document.querySelectorAll(${JSON.stringify(query)})];
            const vis = els.find(el => {
              const cs = window.getComputedStyle(el);
              return cs.display !== 'none'
                && cs.visibility !== 'hidden'
                && parseFloat(cs.opacity || '1') >= 0.9
                && el.offsetHeight > 0
                && el.offsetWidth > 0;
            });
            if (!vis) return null;
            if (vis.id) return '#' + vis.id;
            if (vis.name) return '[name="' + vis.name + '"]';
            return ${JSON.stringify(fallbackSel)};
          }`;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const r = await _authEval(jsCheck, 5000);
            const val = String(r.val || '').trim();
            if (val && val !== 'null' && val !== '') {
              await new Promise(r2 => setTimeout(r2, 500)); // 500ms buffer: animation completing
              return val; // specific selector of the visible element
            }
            await new Promise(r2 => setTimeout(r2, 500));
          }
          return null; // timed out
        };

        // ── Helper: get comma-separated list of truly-visible input types for LLM hint.
        // Filters hidden inputs (Google hides password input during email page via opacity:0/height:0)
        // so the LLM gets an accurate picture of what's actually on screen.
        const _visibleInputsHint = async () => {
          const jsVis = `() => [...document.querySelectorAll('input')].filter(el => {
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden'
              && parseFloat(cs.opacity || '1') >= 0.9 && el.offsetHeight > 0;
          }).map(el => el.type + (el.id ? '#' + el.id : (el.name ? '[' + el.name + ']' : ''))).join(',') || 'none'`;
          const r = await _authEval(jsVis, 5000);
          return String(r.val || '') || 'unknown';
        };

        // Capture initial URL for done-without-action circuit breaker
        let _initialAuthUrl = '';
        try {
          const _initProbe = await _authEval('location.href', 5000);
          _initialAuthUrl = String(_initProbe.val || '').trim();
        } catch (_) {}

        for (let _step = 0; _step < 8; _step++) {
          // 1. Inline text settle — waits for DOM text to stop changing
          await _textSettle();

          // 2. Snapshot (ARIA accessibility tree)
          const _snapRes = await _authSnapshot(8000);
          const _snapText = (_snapRes.stdout || '').trim();
          if (!_snapText) { logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — empty snapshot, stopping`); break; }
          snapshotCache.set(_tabKey(sessionId), _snapText);

          // 3. Check if URL has left auth domain
          const _luProbe = await _authEval('location.href', 5000);
          const _luUrl   = String(_luProbe.val || '').trim();
          const _luHost  = _luUrl ? (() => { try { return new URL(_luUrl).hostname; } catch (_) { return ''; } })() : '';
          if (authOriginHost && _luHost && !isHostEquivalent(_luHost, authOriginHost)) {
            logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — navigated away from auth domain (${_luHost}), done`);
            break;
          }

          // 4. Get truly-visible inputs — filters CSS-hidden inputs from LLM context
          const _visHint = await _visibleInputsHint();
          logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} visible-inputs=${_visHint}`);

          // 5. Ask LLM what to do next
          let _dec = null;
          try {
            const _credHint = `Available credentials: has_email=${_hasEmail}, has_password=${_hasPassword}`;
            const _histHint = _actionHistory.length ? `Completed actions: ${_actionHistory.join(' → ')}` : 'Completed actions: none';
            const _llmRaw = await askWithMessages([
              { role: 'system', content: AUTH_FORM_PROMPT },
              { role: 'user',   content: `${_credHint}\n${_histHint}\nVisible inputs: ${_visHint}\n\nPAGE SNAPSHOT:\n${_snapText.slice(0, 6000)}` },
            ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 15000 });
            let _s = _llmRaw.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
            try { _dec = JSON.parse(_s); } catch (_) {
              const _m = _s.match(/\{[\s\S]*?\}/);
              if (_m) try { _dec = JSON.parse(_m[0]); } catch (_) {}
            }
          } catch (_le) {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} LLM error — ${_le.message}`);
            break;
          }

          if (!_dec?.action) {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — unparseable LLM response, stopping`);
            break;
          }

          const _sel = _dec.selector ? String(_dec.selector).replace(/^@/, '') : null;
          logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} action=${_dec.action} sel="${_sel}" | ${_dec.rationale}`);

          // 6. Execute action
          if (_dec.action === 'fill_email' && _hasEmail) {
            // Poll until email input is truly visible before clicking
            const _visSel = await _waitVisible('email', _sel || 'input[type="email"]');
            if (!_visSel) {
              _consecutiveInvisibleFailures++;
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} fill_email — email input not visible after 15s, re-snapshotting (invisible failures=${_consecutiveInvisibleFailures})`);
              if (_consecutiveInvisibleFailures >= 3) {
                logger.warn(`[browser.act] waitForAuth: auth-loop circuit breaker — 3 consecutive invisible-input failures, page is not a login form, stopping`);
                break;
              }
              continue;
            }
            _consecutiveInvisibleFailures = 0;
            await _authClick(_visSel, 5000);
            await new Promise(r => setTimeout(r, 150));
            await _authPress('Meta+a', 3000);
            await _authType(_credentials.email, 8000);
            _loopFilledEmail = true;
            _actionHistory.push('fill_email');

          } else if (_dec.action === 'fill_password' && _hasPassword) {
            // Poll until password input is truly visible (opacity >= 0.9, height > 0).
            // Google keeps a hidden input[type="password"] in the email page DOM during the
            // slide transition. _waitVisible returns the specific selector of the VISIBLE
            // element (e.g. "#password"), not the generic css which would hit the hidden copy.
            const _visSel = await _waitVisible('password', _sel || 'input[type="password"]');
            if (!_visSel) {
              _consecutiveInvisibleFailures++;
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} fill_password — password input not visible after 15s, re-snapshotting (invisible failures=${_consecutiveInvisibleFailures})`);
              if (_consecutiveInvisibleFailures >= 3) {
                logger.warn(`[browser.act] waitForAuth: auth-loop circuit breaker — 3 consecutive invisible-input failures, page is not a login form, stopping`);
                break;
              }
              continue;
            }
            _consecutiveInvisibleFailures = 0;
            await _authClick(_visSel, 5000);
            await new Promise(r => setTimeout(r, 150));
            await _authPress('Meta+a', 3000);
            await _authType(_credentials.password, 8000);
            _loopFilledPassword = true;
            _actionHistory.push('fill_password');

          } else if (_dec.action === 'click_submit') {
            // Capture pre-click state for both transition signals.
            // Signal 1 (URL): works for traditional multi-page sites and SPA pushState/replaceState.
            // Signal 2 (DOM): works for SPA DOM-only transitions — e.g. Google GlifWebSignIn
            //   keeps accounts.google.com/v3/signin/identifier URL CONSTANT throughout
            //   the email→password transition; only visible inputs change.
            const _preClickUrl = _luUrl;
            const _preVisHint  = _visHint; // captured earlier this iteration, free re-use
            if (_sel) {
              const _cr = await _authClick(_sel, 5000);
              if (!_cr?.ok) await _authPress('Return', 3000);
            } else {
              await _authPress('Return', 3000);
            }
            // Poll until URL OR visible-inputs changes — whichever fires first confirms transition.
            // 12s deadline: Google CSS slide animation + network round-trip can take 2-3s.
            const _navDeadline = Date.now() + 12000;
            let _navConfirmed = false;
            let _transitionReason = '';
            while (Date.now() < _navDeadline) {
              await new Promise(r => setTimeout(r, 500));
              // Signal 1: URL change (traditional multi-page + SPA pushState)
              const _postProbe = await _authEval('location.href', 5000);
              const _postUrl   = String(_postProbe.val || '').trim();
              if (_postUrl && _postUrl !== _preClickUrl) {
                _transitionReason = `URL: ${_preClickUrl} → ${_postUrl}`;
                _navConfirmed = true;
                _stallCount = 0;
                break;
              }
              // Signal 2: visible-inputs DOM change (SPA DOM-only transition, e.g. Google)
              const _postVis = await _visibleInputsHint();
              if (_postVis && _postVis !== 'unknown' && _postVis !== _preVisHint) {
                _transitionReason = `DOM: ${_preVisHint} → ${_postVis}`;
                _navConfirmed = true;
                _stallCount = 0;
                break;
              }
            }
            if (_navConfirmed) {
              logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} click_submit transition confirmed (${_transitionReason})`);
            } else {
              _stallCount++;
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} click_submit no transition after 12s, stall=${_stallCount}`);
              if (_stallCount >= 1) {
                // First stall: press Return as keyboard-submit fallback
                logger.info(`[browser.act] waitForAuth: auth-loop stall fallback — pressing Return`);
                await _authPress('Return', 3000);
                _stallCount = 0;
                await new Promise(r => setTimeout(r, 1500));
              }
            }
            _actionHistory.push('click_submit');

          } else if (_dec.action === 'done') {
            logger.info(`[browser.act] waitForAuth: auth-loop done after ${_step + 1} step(s) for session=${sessionId}`);
            if (!_loopFilledEmail && !_loopFilledPassword) {
              _doneWithoutAction = true;
            }
            break;

          } else {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — action "${_dec.action}" skipped/unexpected, stopping`);
            break;
          }
        }

        // ── Done-without-action circuit breaker ─────────────────────────────
        // If the LLM said "done" but no credentials were filled AND the URL hasn't
        // changed from the initial URL, the page is likely already authenticated
        // (the auth gate just couldn't prove it via pattern matching) or isn't a
        // login form at all. Skip the OAuth fallback and the long poll loop —
        // return a soft success so the caller can proceed to the task.
        if (_doneWithoutAction) {
          let _currentUrl = '';
          try {
            const _curProbe = await _authEval('location.href', 5000);
            _currentUrl = String(_curProbe.val || '').trim();
          } catch (_) {}
          if (_currentUrl === _initialAuthUrl) {
            logger.info(`[browser.act] waitForAuth: done-without-action circuit breaker — URL unchanged (${_currentUrl}), no creds filled, skipping OAuth fallback and poll loop for session=${sessionId}`);
            return { ok: true, action, sessionId, authResolved: true, authCircuitBreaker: true, executionTime: Date.now() - start };
          }
          logger.info(`[browser.act] waitForAuth: done-without-action but URL changed (${_initialAuthUrl} → ${_currentUrl}), proceeding to OAuth fallback for session=${sessionId}`);
        }

        // ── OAuth / SSO button fallback ────────────────────────────────────
        // If the loop ran but no credentials were filled (no credential form found),
        // look for a "Continue with Google" / SSO button.
        if (!_loopFilledEmail && !_loopFilledPassword) {
          const _oauthEval = `() => {
            const RE = /Continue with Google|Sign in with Google|Log in with Google|Sign in with SSO/i;
            const btn = [...document.querySelectorAll('button,[role=button],[role=link],a')]
              .find(b => RE.test((b.textContent || '').trim()) || RE.test(b.getAttribute('aria-label') || ''));
            if (btn) { btn.click(); return 'clicked'; }
            return 'not-found';
          }`;
          const _oauthRes = await _authEval(_oauthEval, 6000);
          if (String(_oauthRes.val || '').includes('clicked') || (_oauthRes.stdout || '').includes('clicked')) {
            logger.info(`[browser.act] waitForAuth: OAuth button clicked for session=${sessionId}`);
            await new Promise(r => setTimeout(r, 2000));
          } else {
            logger.info(`[browser.act] waitForAuth: no form or OAuth button found for session=${sessionId} — passive poll`);
          }
        }
      } catch (_formErr) {
        logger.warn(`[browser.act] waitForAuth: form handler error (non-fatal): ${_formErr.message}`);
      }
      } else {
        logger.info(`[browser.act] waitForAuth: noAutofill=true — skipping auth-loop form fill for session=${sessionId}`);
      }

      // ── Step 2: poll until auth wall clears ──────────────────────────────
      // Start deadline AFTER navigation so the full effectiveTimeout is for the login wait.
      const deadline = Date.now() + effectiveTimeout;

      logger.info(`[browser.act] waitForAuth: waiting for auth wall to clear on session=${sessionId} (timeout=${effectiveTimeout}ms)`);

      // On first auth wall detection, immediately notify the UI via _progressCallbackUrl
      // then keep polling until the user signs in — no second request needed.
      let authWallDetections = 0;
      let loginNotificationSent = false;

      while (Date.now() < deadline) {
        await new Promise(r2 => setTimeout(r2, pollInterval));

        // Early exit if session was closed externally (e.g. cancel handler)
        if (!openSessions.has(sessionId)) {
          logger.info(`[browser.act] waitForAuth: session ${sessionId} closed externally — aborting poll`);
          return { ok: false, action, sessionId, authTimedOut: true, error: 'Session closed (cancelled)', executionTime: Date.now() - start };
        }

        // Manual auth completion — user clicked "I have signed in" button in UI
        if (global.__manualAuthCompleteSessions && global.__manualAuthCompleteSessions.has(sessionId)) {
          global.__manualAuthCompleteSessions.delete(sessionId);
          logger.info(`[browser.act] waitForAuth: manual auth complete for session=${sessionId} — returning success`);
          return { ok: true, action, sessionId, authResolved: true, manualConfirm: true, executionTime: Date.now() - start };
        }

        try {
          const urlRes = await _authEval('location.href', 5000);
          const currentUrl = String(urlRes.val || '').trim();

          if (!currentUrl) continue;

          const currentHost     = getHost(currentUrl);
          const urlWithoutQuery = currentUrl.split('?')[0];

          // ── Popup / multi-page awareness ──────────────────────────────────────
          // OAuth flows (Google, Apple, Microsoft, etc.) often open a popup window
          // for the identity provider. The main page stays put while the popup
          // handles the auth handshake. Without scanning all context pages, the
          // state machine is blind to the popup and times out.
          //
          // Each poll: enumerate every open page, log URLs (diagnostic), and check
          // whether any popup has reached the success host or is mid-OAuth.
          const _ctx = engine.getContext(sessionId);
          if (_ctx) {
            try {
              const _allPages = _ctx.pages();
              if (_allPages.length > 1) {
                const _popupUrls = [];
                for (const _p of _allPages) {
                  let _pUrl = '';
                  try { _pUrl = _p.url(); } catch (_) { _pUrl = ''; }
                  if (!_pUrl || _pUrl === currentUrl || _pUrl === 'about:blank') continue;
                  _popupUrls.push(_pUrl);
                  const _pHost = getHost(_pUrl);
                  const _pUrlNoQuery = _pUrl.split('?')[0];
                  // OAuth redirect in a popup → mark in-flight, never back-navigate
                  const _oauthQueryRe2 = /[?&](redirect_uri|response_type=code|code_challenge|flowName=[^&]*[Oo]auth)=/i;
                  const _oauthPathRe2  = /\/(oauth2?|authorize|login\/oauth|signin\/oauth|connect\/oauth|v\d+\/signin\/identifier|auth\/callback|api\/auth\/callback)\b/i;
                  if (_oauthQueryRe2.test(_pUrl) || _oauthPathRe2.test(_pUrlNoQuery)) {
                    _wasOnOAuthProvider = true;
                  }
                  // Popup landed on the success host → auth complete
                  if (authSuccessUrl) {
                    if (_pUrlNoQuery.includes(authSuccessUrl) && !isHostEquivalent(_pHost, authOriginHost)) {
                      logger.info(`[browser.act] waitForAuth: popup reached success host (${_pUrl}) for session=${sessionId}`);
                      return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
                    }
                  } else if (!!_pHost && !!authOriginHost && !isHostEquivalent(_pHost, authOriginHost) && _pUrl.startsWith('http')) {
                    logger.info(`[browser.act] waitForAuth: popup left auth domain (${_pUrl}) for session=${sessionId}`);
                    return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
                  }
                }
                if (_popupUrls.length > 0) {
                  logger.debug(`[browser.act] waitForAuth: ${_popupUrls.length} popup page(s) open: ${_popupUrls.join(' | ')} (session=${sessionId})`);
                }
              }
            } catch (_popupErr) {
              logger.debug(`[browser.act] waitForAuth: popup scan failed (non-fatal): ${_popupErr.message}`);
            }
          }

          // State 1: SUCCESS — different host from auth domain AND at success URL
          const atSuccess = authSuccessUrl
            ? (urlWithoutQuery.includes(authSuccessUrl) && !isHostEquivalent(currentHost, authOriginHost))
            : (!!currentHost && !!authOriginHost && !isHostEquivalent(currentHost, authOriginHost));
          if (atSuccess) {
            logger.info(`[browser.act] waitForAuth: success URL matched (${currentUrl}) for session=${sessionId}`);
            return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
          }

          // State 2: IN AUTH FLOW — same hostname as sign-in URL (or a configured alias)
          // Covers: email entry, password challenge, 2FA, MFA, consent screen — never navigate away
          const inAuthFlow = !!authOriginHost && isHostEquivalent(currentHost, authOriginHost);
          if (inAuthFlow) {
            authWallDetections++;
            // ── Metadata eval: title + robots noindex ────────────────────────
            // Runs every poll to determine if the current page is still a login
            // wall regardless of URL path or form structure. Works for:
            // - Multi-step login (Google: email first, no password field on step 1)
            // - Passkey flows (no traditional inputs)
            // - 2FA screens (text/number input, not email/password)
            // titleIsLogin OR isNoIndex = confirmed login wall → suppress same-domain success check
            // hasUserGlobal = true → authenticated immediately (SPA injected user object)
            let _pageMetaLoginWall = false;
            let _pageMetaAuthed = false;
            let _pageTitle = '';
            try {
              const _metaExpr = `(() => {
  const title = document.title || '';
  const titleLower = title.toLowerCase();
  const titleIsLogin = /sign.?in|log.?in|\\blogin\\b|authenticate|verify|two.factor|2fa/.test(titleLower);
  const robotsMeta = document.querySelector('meta[name="robots"]');
  const robotsContent = robotsMeta ? (robotsMeta.getAttribute('content') || '').toLowerCase() : '';
  const isNoIndex = robotsContent.includes('noindex');
  const hasUserGlobal = !!(window.__user || window.currentUser ||
    (window.App && window.App.user) || (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.user));
  const signInLinks = document.querySelectorAll(
    'a[href*="login"], a[href*="signin"], a[href*="sign-in"], a[href*="signup"], a[href*="register"]'
  );
  const signInButtons = Array.from(
    document.querySelectorAll('button, a[role="button"], [data-testid]')
  ).filter(el => {
    const text = (el.textContent || el.innerText || '').toLowerCase().trim();
    return /^(sign\s*in|log\s*in|sign\s*up|register)\b/.test(text);
  });
  const hasSignInButton = signInLinks.length > 0 || signInButtons.length > 0;
  return JSON.stringify({ titleIsLogin, isNoIndex, hasUserGlobal, title, hasSignInButton });
})()`;
              const _metaRes = await _authEval(_metaExpr, 3000);
              const _metaStr = String(_metaRes.val || '').trim();
              const _meta = JSON.parse(_metaStr);
              _pageTitle = _meta.title || '';
              let _hasSignInButton = !!_meta.hasSignInButton;
              if (_meta.hasUserGlobal) {
                logger.info(`[browser.act] waitForAuth: JS user global detected — auth complete for session=${sessionId}`);
                _pageMetaAuthed = true;
              } else {
                _pageMetaLoginWall = _meta.titleIsLogin || _meta.isNoIndex;
                logger.debug(`[browser.act] waitForAuth: meta check — title="${_meta.title}" titleIsLogin=${_meta.titleIsLogin} isNoIndex=${_meta.isNoIndex} loginWall=${_pageMetaLoginWall}`);
              }
            } catch (_metaErr) {
              logger.debug(`[browser.act] waitForAuth: metadata eval failed (non-fatal): ${_metaErr.message}`);
            }
            // JS user global confirmed authenticated — return success immediately
            if (_pageMetaAuthed) {
              return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
            }
            if (!loginNotificationSent) {
              loginNotificationSent = true;
              logger.info(`[browser.act] waitForAuth: auth wall confirmed — notifying user, continuing to poll session=${sessionId} loginUrl=${url}`);
              if (_progressCallbackUrl) {
                const http = require('http');
                const serviceDisplay = sessionId.replace('_agent', '');
                const _payload = JSON.stringify({
                  type: 'needs_login', sessionId, loginUrl: url, serviceDisplay,
                  pageTitle: _pageTitle,
                  message: `Please sign in to **${serviceDisplay}** in the Chrome window that just opened (${url}).`,
                });
                const _req = http.request({
                  hostname: '127.0.0.1',
                  port: parseInt(new URL(_progressCallbackUrl).port, 10),
                  path: new URL(_progressCallbackUrl).pathname,
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_payload) },
                  timeout: 2000,
                });
                _req.on('error', () => {});
                _req.write(_payload);
                _req.end();
              }
            }
            // Spot-check for error signals every 5th poll (wrong password, account locked, etc.)
            if (authWallDetections % 5 === 0) {
              const errRes = await _authEval('document.body.innerText.slice(0,600)', 5000);
              const errText = String(errRes.val || '').trim();
              const errorSignals = /wrong password|incorrect password|invalid credentials|account locked|too many attempts|verify it's you/i;
              if (errorSignals.test(errText)) {
                logger.warn(`[browser.act] waitForAuth: auth error detected on session=${sessionId}`);
                return { ok: false, action, sessionId, authFailed: true, error: 'Authentication error detected — wrong credentials or account locked', executionTime: Date.now() - start };
              }
            }
            // ── OAuth return exit ─────────────────────────────────────────
            // If user visited a 3rd-party OAuth provider (Google, Apple, etc.) and
            // is now BACK on the origin host (inAuthFlow), they completed OAuth.
            // Perplexity.ai is the canonical example: sign_in_url IS the app URL,
            // so after Google OAuth the browser returns to perplexity.ai — which
            // looks like inAuthFlow but is actually a successful post-OAuth landing.
            if (_wasOnOAuthProvider) {
              logger.info(`[browser.act] waitForAuth: returned to origin after OAuth provider — auth complete for session=${sessionId} url=${currentUrl}`);
              return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
            }
            // ── Same-domain auth success check ──────────────────────────────
            // Uses authSuccessUrl (always populated from descriptor/seed/LLM) to
            // determine if the browser has actually reached the authenticated app.
            // Gated by metadata: if title or robots noindex still signals a login
            // wall, suppress this check even if the URL pattern would match — this
            // prevents SPAs that auto-redirect within the auth domain (e.g. ProtonMail
            // account.proton.me/login → /mail while still unauthenticated) from
            // producing a false positive.
            //
            // For cross-host services (ProtonMail, Gmail, Outlook): authSuccessUrl
            // host differs from authOriginHost so the pattern never matches on the
            // auth domain — State 1 (host-change) handles those correctly instead.
            //
            // For same-host services (Discord, Twitter, GitHub, Reddit): the
            // authSuccessUrl substring IS present once the user lands on the app
            // (e.g. discord.com/channels/@me includes 'discord.com/channels') ✓
            if (authSuccessUrl) {
              try {
                const urlWithoutQuery = currentUrl.split('?')[0];
                const currentPath = new URL(currentUrl).pathname;
                const notOnLoginPath = !/\/(login|signin|sign-in|sign_in|auth|oauth|authorize)\b/i.test(currentPath);
                // Metadata gate: skip success check if page still signals a login wall
                const _metaSuppressed = _pageMetaLoginWall;
                if (!_metaSuppressed && urlWithoutQuery.includes(authSuccessUrl) && notOnLoginPath && !_hasSignInButton) {
                  logger.info(`[browser.act] waitForAuth: same-domain success pattern matched (${currentUrl}) for session=${sessionId}`);
                  return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
                }
                if (_metaSuppressed && urlWithoutQuery.includes(authSuccessUrl)) {
                  logger.debug(`[browser.act] waitForAuth: authSuccessUrl matched but metadata confirms still login wall — suppressing (${currentUrl})`);
                }
              } catch (_) {}
            } else if (authSignInPath) {
              try {
                const currentPath = new URL(currentUrl).pathname;
                const elapsedMs = Date.now() - start;
                const leftLoginPage = authWallDetections >= 3 &&
                  elapsedMs >= 8000 &&
                  currentPath !== authSignInPath &&
                  !/\/(login|signin|sign-in|sign_in|auth|oauth|authorize)\b/i.test(currentPath);
                if (leftLoginPage) {
                  logger.info(`[browser.act] waitForAuth: same-domain path exit (no authSuccessUrl) — left login page (${authSignInPath} → ${currentPath}) for session=${sessionId}`);
                  return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
                }
              } catch (_) {}
            }
            // ── CDP cookie-sniff auth detection ───────────────────────────────
            // Catches same-domain SPAs that don't change URL and don't expose a
            // JS user global — the case the manual "I've signed in" button was
            // built for. On the first in-auth-flow poll we snapshot the existing
            // auth-cookie names as a baseline; on subsequent polls we declare
            // success only when NEW auth cookies appear. Non-fatal on any CDP
            // failure — falls through to the manual button.
            if (_cookieSniffDomain && _ePage) {
              try {
                if (_authCookieBaseline === null) {
                  const _baseSniff = await _sniffAuthCookies(engine, sessionId, _ePage, _cookieSniffDomain);
                  _authCookieBaseline = new Set(_baseSniff.ok && _baseSniff.authed ? _baseSniff.cookies : []);
                  logger.info(`[browser.act] waitForAuth: cookie baseline captured (${_authCookieBaseline.size} cookies, domain=${_cookieSniffDomain}) for session=${sessionId}`);
                } else {
                  const _sniff = await _sniffAuthCookies(engine, sessionId, _ePage, _cookieSniffDomain);
                  if (_sniff.ok && _sniff.authed) {
                    const _newCookies = _sniff.cookies.filter(n => !_authCookieBaseline.has(n));
                    if (_newCookies.length > 0) {
                      logger.info(`[browser.act] waitForAuth: CDP auth cookies detected (new: ${_newCookies.join(',')}) — auth complete for session=${sessionId}`);
                      return { ok: true, action, sessionId, authResolved: true, detectedVia: 'cdp_cookies', executionTime: Date.now() - start };
                    }
                  } else if (!_sniff.ok) {
                    logger.info(`[browser.act] waitForAuth: cookie sniff unavailable (reason: ${_sniff.reason}) — relying on URL/JS heuristics for session=${sessionId}`);
                  }
                }
              } catch (_sniffErr) {
                logger.info(`[browser.act] waitForAuth: cookie sniff failed (non-fatal): ${_sniffErr.message}`);
              }
            } else {
              // Only log once when entering the in-auth-flow branch without
              // cookie sniff capability (avoids spamming every poll).
              if (authWallDetections === 1) {
                logger.info(`[browser.act] waitForAuth: cookie sniff skipped (domain=${_cookieSniffDomain || 'null'}, hasPage=${!!_ePage}) for session=${sessionId}`);
              }
            }
            logger.debug(`[browser.act] waitForAuth: in auth flow at ${currentUrl} (${authWallDetections} polls), ${Math.round((deadline - Date.now()) / 1000)}s remaining`);

            // ── Fallback: navigate to authSuccessUrl if page is not a login wall ──
            // Safety net for cases where the redirect target was aliased but is
            // actually an authenticated page (e.g. myaccount.google.com after
            // Google sign-in). If we've been stuck in auth flow for >15s and the
            // page doesn't look like a login wall, try navigating to the
            // authSuccessUrl to check if the user is actually logged in.
            if (authWallDetections >= 8 && !_pageMetaLoginWall && !_hasSignInButton && authSuccessUrl) {
              try {
                const _currentPath = new URL(currentUrl).pathname;
                const _onLoginPath = /\/(login|signin|sign-in|sign_in|auth|oauth|authorize)\b/i.test(_currentPath);
                if (!_onLoginPath) {
                  logger.info(`[browser.act] waitForAuth: in-auth-flow fallback — page is not a login wall after ${authWallDetections} polls, navigating to authSuccessUrl for session=${sessionId}`);
                  const _gotoUrl = /^https?:\/\//i.test(authSuccessUrl)
                    ? authSuccessUrl
                    : `https://${authSuccessUrl.split(/[,|]/)[0].trim()}`;
                  await _authGoto(_gotoUrl, 15000);
                  // Let the next poll iteration evaluate the new URL — it will
                  // hit State 1 (SUCCESS) if we're at the auth success URL, or
                  // State 3 (LIMBO) if we get redirected back to sign-in.
                }
              } catch (_fallbackErr) {
                logger.debug(`[browser.act] waitForAuth: in-auth-flow fallback nav failed (non-fatal): ${_fallbackErr.message}`);
              }
            }
            continue;
          }

          // State 2.5: OAUTH REDIRECT — a third-party identity provider handling the OAuth flow.
          // Detected by RFC 6749 standard query parameters (redirect_uri, response_type=code,
          // client_id, code_challenge, flowName=...OAuthFlow) or OAuth path patterns.
          // These appear on EVERY OAuth 2.0 provider (Google, Apple, GitHub, Discord, Slack,
          // Microsoft, Okta, Auth0, Twitter/X, LinkedIn, etc.) — no provider list needed.
          // Must NEVER trigger a back-to-sign-in navigation — they are in-flight auth redirects.
          const _oauthQueryRe = /[?&](redirect_uri|response_type=code|code_challenge|flowName=[^&]*[Oo]auth)=/i;
          const _oauthPathRe  = /\/(oauth2?|authorize|login\/oauth|signin\/oauth|connect\/oauth|v\d+\/signin\/identifier|auth\/callback|api\/auth\/callback)\b/i;
          const isOAuthRedirect = _oauthQueryRe.test(currentUrl) || _oauthPathRe.test(urlWithoutQuery);
          if (isOAuthRedirect) {
            _wasOnOAuthProvider = true; // user has navigated to a 3rd-party OAuth provider
            logger.debug(`[browser.act] waitForAuth: OAuth redirect in progress at ${currentHost} — waiting for callback, session=${sessionId}`);
            continue;
          }

          // State 3: LIMBO — different domain, not at success URL
          if (!authSuccessUrl) {
            // No success URL to validate against — different domain means auth cleared
            logger.info(`[browser.act] waitForAuth: auth wall cleared (different domain) for session=${sessionId}`);
            return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
          }

          // RC1: skip transient non-http URLs (about:blank, chrome://, data:, etc.).
          // These appear briefly during any OAuth popup or redirect handshake — they are
          // never a real destination and must NEVER trigger a back-to-sign-in navigation.
          // This applies universally across all services (Notion, Google, GitHub, etc.).
          if (!currentUrl.startsWith('http')) {
            logger.debug(`[browser.act] waitForAuth: transient non-http URL (${currentUrl}) — skipping, waiting for OAuth redirect session=${sessionId}`);
            continue;
          }

          if (lastLimboUrl === currentUrl) {
            // RC2: count how many times the CODE navigates back to sign-in for a stuck URL.
            // The user only signed in once — this counter tracks code-triggered retries only.
            // On the 3rd attempt, give up: the auth flow is genuinely broken.
            backToSignInCount++;
            if (backToSignInCount >= 3) {
              logger.warn(`[browser.act] waitForAuth: back-to-sign-in loop detected (${backToSignInCount} attempts) for stuck URL ${currentUrl} — aborting session=${sessionId}`);
              return { ok: false, action, sessionId, authTimedOut: true, authLoopDetected: true, error: `waitForAuth: stuck in redirect loop at ${currentUrl} — authentication could not complete`, executionTime: Date.now() - start };
            }
            // Stuck in same limbo URL — navigate back to sign-in URL
            logger.info(`[browser.act] waitForAuth: limbo stuck at ${currentUrl} (back-to-sign-in attempt ${backToSignInCount}/3) — navigating back to sign-in`);
            if (url) await _authGoto(url, 15000);
            lastLimboUrl = null;
          } else {
            // First time at this intermediate URL — navigate toward the canonical post-auth URL.
            // Prefer postAuthUrl (a full navigable URL) over authSuccessUrl (which may be a bare pattern).
            lastLimboUrl = currentUrl;
            if (postAuthUrl && /^https?:\/\//i.test(postAuthUrl)) {
              logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — navigating to postAuthUrl=${postAuthUrl} for session=${sessionId}`);
              await _authGoto(postAuthUrl, 15000);
            } else if (/^https?:\/\//i.test(authSuccessUrl)) {
              logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — navigating to authSuccessUrl=${authSuccessUrl} for session=${sessionId}`);
              await _authGoto(authSuccessUrl, 15000);
            } else {
              // authSuccessUrl is a bare hostname pattern (e.g. 'mail.google.com', 'notion.com').
              // Construct a navigable https:// URL from it so we can drive the browser there.
              // This restores the pre-Phase-1 behavior for services like Gmail where the OAuth
              // landing page (myaccount.google.com) differs from the target (mail.google.com).
              const bareHostMatch = /^([\w.-]+\.[a-z]{2,})(\/.*)?$/i.exec(authSuccessUrl);
              if (bareHostMatch) {
                const gotoUrl = `https://${bareHostMatch[1]}`;
                logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — authSuccessUrl is a pattern, constructing goto=${gotoUrl} for session=${sessionId}`);
                await _authGoto(gotoUrl, 15000);
              } else {
                logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — authSuccessUrl is a pattern (not a URL), waiting for redirect for session=${sessionId}`);
              }
            }
          }
        } catch (pollErr) {
          logger.debug(`[browser.act] waitForAuth: poll error — ${pollErr.message?.slice(0, 60)}`);
        }
      }

      logger.warn(`[browser.act] waitForAuth: timed out after ${effectiveTimeout}ms on session=${sessionId}`);
      return { ok: false, action, sessionId, authTimedOut: true, error: `waitForAuth: timed out (${effectiveTimeout}ms) — authentication not completed`, executionTime: Date.now() - start };
    }

    // ── scanCurrentPage ───────────────────────────────────────────────────────
    // Returns elements array parsed from snapshot for planSkills pre-scan
    case 'scanCurrentPage': {
      // ── Engine path ──
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try {
          const { yaml } = await engine.buildRefTree(_ePage);
          if (yaml) { snapshotCache.set(_tabKey(sessionId), yaml); }
          const elements = parseSnapshotToElements(yaml || '');
          const pageUrl = await _ePage.evaluate('location.href');
          return {
            ok: true, action, sessionId,
            result: { url: String(pageUrl || ''), elements, snapshot: yaml || '' },
            executionTime: Date.now() - start,
          };
        } catch (e) { logger.warn(`[browser.act] scanCurrentPage (engine) failed: ${e.message} — falling back to CLI`); }
      }
      // ── CLI fallback ──
      const snapRes = await captureSnapshot(sessionId, headed, timeoutMs);
      const elements = parseSnapshotToElements(snapRes.stdout);
      const urlRes = await cliRun([...S, 'eval', 'location.href'], 5000);
      return {
        ok:            true,
        action,
        sessionId,
        result: {
          url:      (urlRes.stdout || '').trim() || '',
          elements,
          snapshot: snapRes.stdout,
        },
        executionTime: Date.now() - start,
      };
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    // tab-new: opens a new tab; if url provided, navigates to it in the new tab.
    // Tracks the new tab index in currentTabIndex so per-tab snapshot cache works.
    case 'tab-new': {
      // ── Engine fast-path ──
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try {
          const newPage = await _ctx.newPage();
          const pages = _ctx.pages();
          const newIdx = pages.length - 1;
          currentTabIndex.set(sessionId, newIdx);
          snapshotCache.delete(_tabKeyFor(sessionId, newIdx));
          if (url) {
            await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) });
            await new Promise(r => setTimeout(r, 400));
          }
          logger.info(`[browser.act] tab-new (engine): created tab ${newIdx} for session=${sessionId}`);
          return { ok: true, action, sessionId, tabIndex: newIdx, executionTime: Date.now() - start };
        } catch (e) { logger.warn(`[browser.act] tab-new (engine) failed: ${e.message} — falling back to CLI`); }
      }
      // ── CLI fallback ──
      // Check if daemon is alive (like navigate does) — tab-new requires running browser
      let alreadyOpen = openSessions.has(sessionId);
      if (!alreadyOpen) {
        alreadyOpen = await isDaemonAlive(sessionId, headed);
        if (alreadyOpen) {
          openSessions.add(sessionId);
          logger.info(`[browser.act] tab-new: daemon alive for session=${sessionId}`);
        }
      }
      // If not already open, probe to see if browser actually exists (might be missing SingletonLock)
      if (!alreadyOpen && url) {
        logger.info(`[browser.act] tab-new: probing browser directly despite daemon check failure`);
        try {
          const probe = await cliRun([...S, 'eval', 'window.location.href'], 5000);
          if (probe.ok) {
            logger.info(`[browser.act] tab-new: browser exists! using goto instead of open`);
            alreadyOpen = true;
            openSessions.add(sessionId);
            // Navigate to URL in existing browser
            const gotoRes = await cliRun([...S, 'goto', url], Math.max(timeoutMs, 30000));
            logger.info(`[browser.act] tab-new: goto result: ok=${gotoRes.ok}`);
            if (!gotoRes.ok) {
              return {
                ok: false,
                action,
                sessionId,
                error: `Failed to navigate: ${gotoRes.error || gotoRes.stderr?.trim()}`,
                executionTime: Date.now() - start,
              };
            }
            await new Promise(r => setTimeout(r, 400));
            const listRaw = await cliRun([...S, 'tab-list'], 5000).catch(() => ({ stdout: '' }));
            const tabCount = ((listRaw.stdout || '').match(/^\s*-\s+\d+:/gm) || []).length;
            const lastIdx = Math.max(0, tabCount - 1);
            currentTabIndex.set(sessionId, lastIdx);
            snapshotCache.delete(_tabKeyFor(sessionId, lastIdx));
            await run(['waitForStableText'], 'waitForStableText', { timeoutMs: 15000 });
            return {
              ok: true,
              action,
              sessionId,
              tabIndex: lastIdx,
              result: listRaw.stdout?.trim() || undefined,
              executionTime: Date.now() - start,
            };
          }
        } catch (e) {
          logger.info(`[browser.act] tab-new: browser probe failed, will cold-start`);
        }
      }
      // If not already open, kill any existing Chrome and clear profile locks
      if (!alreadyOpen) {
        const killed = killExistingChromeForProfile(sessionId);
        if (killed) {
          logger.info(`[browser.act] tab-new: killed existing Chrome for session=${sessionId}`);
        }
        clearProfileLock(sessionId);
      }
      // If daemon not running and URL provided, use 'open' to cold-start instead of tab-new
      if (!alreadyOpen && url) {
        logger.info(`[browser.act] tab-new: cold-starting browser with open for session=${sessionId}`);
        // Use open with URL parameter - more reliable for navigation
        const openRes = await cliRun([...S, 'open', ...openFlags(), url], Math.max(timeoutMs, 30000));
        logger.info(`[browser.act] tab-new cold-start: open command result: ok=${openRes.ok}, exitCode=${openRes.exitCode}`);    
        if (openRes.ok) {
          openSessions.add(sessionId);
          
          // Give Chrome time to initialize
          await new Promise(r => setTimeout(r, 1000));
          
          // Determine tab index after open
          const listRaw = await cliRun([...S, 'tab-list'], 5000).catch(() => ({ stdout: '' }));
          const tabCount = ((listRaw.stdout || '').match(/^\s*-\s+\d+:/gm) || []).length;
          const lastIdx = Math.max(0, tabCount - 1);
          currentTabIndex.set(sessionId, lastIdx);
          snapshotCache.delete(_tabKeyFor(sessionId, lastIdx));
          logger.info(`[browser.act] tab-new cold-start: tab index set to ${lastIdx}`);
          
          // Check current URL - if we're on about:blank, Chrome is in a broken state
          let actualUrl = '';
          try {
            const urlProbe = await cliRun([...S, 'eval', 'window.location.href'], 3000);
            const probeMatch = urlProbe.stdout?.match(/^([\s\S]*?)(?=###\s|$)/i);
            actualUrl = (probeMatch ? probeMatch[1] : urlProbe.stdout || '').trim().replace(/^"|"$/g, '');
            logger.info(`[browser.act] tab-new cold-start: current URL is ${actualUrl}`);
          } catch (e) {
            logger.warn(`[browser.act] tab-new cold-start: URL check error: ${e.message}`);
          }
          
          // If on about:blank, Chrome session is broken (no SingletonLock) - kill and restart
          if (actualUrl === 'about:blank' || actualUrl === 'chrome://newtab/' || actualUrl === '') {
            logger.warn(`[browser.act] tab-new cold-start: Chrome opened to blank page (broken session), killing and restarting`);
            
            // Kill the broken Chrome session
            killExistingChromeForProfile(sessionId);
            openSessions.delete(sessionId);
            await new Promise(r => setTimeout(r, 1500));
            
            // Clear profile lock and try fresh
            clearProfileLock(sessionId);
            
            // Try open again with URL
            logger.info(`[browser.act] tab-new cold-start: retrying open with ${url}`);
            const retryRes = await cliRun([...S, 'open', ...openFlags(), url], Math.max(timeoutMs, 30000));
            logger.info(`[browser.act] tab-new cold-start: retry result: ok=${retryRes.ok}`);
            
            if (!retryRes.ok) {
              return {
                ok: false,
                action,
                sessionId,
                error: `Failed to open browser after retry: ${retryRes.error || retryRes.stderr?.trim()}`,
                executionTime: Date.now() - start,
              };
            }
          }
          
          // Wait for page to stabilize
          logger.info(`[browser.act] tab-new cold-start: waiting for page to stabilize`);
          const stableRes = await run(['waitForStableText'], 'waitForStableText', { timeoutMs: 15000 });
          logger.info(`[browser.act] tab-new cold-start: waitForStableText returned: ok=${stableRes.ok}, aboutBlank=${stableRes.aboutBlankDetected}`);
          
          // If still on about:blank after retry, something is seriously wrong
          if (stableRes.aboutBlankDetected) {
            logger.error(`[browser.act] tab-new cold-start: still on about:blank after retry - giving up`);
            return {
              ok: false,
              action,
              sessionId,
              error: 'Browser repeatedly opened to about:blank instead of target URL',
              executionTime: Date.now() - start,
            };
          }
          
          return {
            ok: true,
            action,
            sessionId,
            tabIndex: lastIdx,
            result: listRaw.stdout?.trim() || undefined,
            stdout: openRes.stdout,
            executionTime: Date.now() - start,
          };
        }
        logger.error(`[browser.act] tab-new cold-start: open command failed: ${openRes.error || openRes.stderr}`);
        return {
          ok: false,
          action,
          sessionId,
          error: openRes.error || openRes.stderr?.trim(),
          executionTime: Date.now() - start,
        };
      }
      // Daemon is running: use tab-new
      const tabNewRaw = await cliRun([...S, 'tab-new'], timeoutMs);
      logger.info(`[browser.act] tab-new → exit ${tabNewRaw.exitCode}`, { stderr: tabNewRaw.stderr?.slice(0, 100) });
      if (!tabNewRaw.ok) {
        return { ok: false, action, sessionId, error: tabNewRaw.error || tabNewRaw.stderr?.trim(), executionTime: Date.now() - start };
      }
      // Give playwright-cli a moment to register the new tab, then determine its index
      await new Promise(r => setTimeout(r, 400));
      const listRaw = await cliRun([...S, 'tab-list'], 5000);
      const tabCount = ((listRaw.stdout || '').match(/^\s*-\s+\d+:/gm) || []).length;
      const lastIdx = Math.max(0, tabCount - 1);
      // Update current tab tracker — new tab is now active
      currentTabIndex.set(sessionId, lastIdx);
      // Snapshot cache for this new tab starts empty (fresh page)
      snapshotCache.delete(_tabKeyFor(sessionId, lastIdx));
      if (url) {
        // Explicitly select the newest tab so goto targets it, not an older one
        await cliRun([...S, 'tab-select', String(lastIdx)], 5000);
        await new Promise(r => setTimeout(r, 200));
        const gotoRaw = await cliRun([...S, 'goto', url], Math.max(timeoutMs, 30000));
        logger.info(`[browser.act] tab-new[${lastIdx}] goto ${url} → exit ${gotoRaw.exitCode}`, { stderr: gotoRaw.stderr?.slice(0, 100) });
        // After tab navigation, give page time to load before any fill
        await new Promise(r => setTimeout(r, 1200));
        return {
          ok: gotoRaw.ok,
          action,
          sessionId,
          tabIndex: lastIdx,
          result: (listRaw.stdout || '').trim() || undefined,
          stdout: gotoRaw.stdout || listRaw.stdout,
          executionTime: Date.now() - start,
          error: gotoRaw.ok ? undefined : gotoRaw.error || gotoRaw.stderr?.trim(),
        };
      }
      return {
        ok: true,
        action,
        sessionId,
        tabIndex: lastIdx,
        result: (listRaw.stdout || '').trim() || undefined,
        stdout: tabNewRaw.stdout,
        executionTime: Date.now() - start,
      };
    }
    case 'tab-list': {
      // ── Engine path ──
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try {
          const _pages = _ctx.pages();
          const _lines = _pages.map((p, i) => `  - ${i}: ${p.url()}`);
          return { ok: true, action, sessionId, result: _lines.join('\n'), stdout: _lines.join('\n'), executionTime: Date.now() - start };
        } catch (e) { logger.warn(`[browser.act] tab-list (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['tab-list'], 'tab-list');
    }
    // Accept tabIndex (LLM convention) or index (legacy)
    case 'tab-close': {
      const idx = args.tabIndex ?? args.index ?? 0;
      snapshotCache.delete(_tabKeyFor(sessionId, idx));
      if ((currentTabIndex.get(sessionId) || 0) === idx) {
        currentTabIndex.set(sessionId, 0);
      }
      // ── Engine path ──
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try {
          const _pages = _ctx.pages();
          if (_pages[idx]) { await _pages[idx].close(); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        } catch (e) { logger.warn(`[browser.act] tab-close (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['tab-close', String(idx)], `tab-close ${idx}`);
    }
    case 'tab-select': {
      const idx = args.tabIndex ?? args.index ?? 0;
      currentTabIndex.set(sessionId, idx);
      logger.info(`[browser.act] tab-select ${idx}: switched active tab for session=${sessionId}`);
      // ── Engine path ──
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try {
          const _pages = _ctx.pages();
          if (_pages[idx]) {
            await _pages[idx].bringToFront();
            // Update the engine's active page so subsequent getPage() calls
            // (e.g. for recorder injection) return the newly-selected tab.
            engine.setActivePage(sessionId, _pages[idx]);
            return { ok: true, action, sessionId, executionTime: Date.now() - start };
          }
        } catch (e) { logger.warn(`[browser.act] tab-select (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['tab-select', String(idx)], `tab-select ${idx}`);
    }

    // ── Auth state persistence ────────────────────────────────────────────────
    case 'state-save': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // Engine path: use context.storageState()
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try { await _ctx.storageState({ path: p }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        catch (e) { logger.warn(`[browser.act] state-save (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['state-save', p], `state-save ${p}`);
    }
    case 'state-load': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      // Engine path: persistent context already restores state — no-op if engine active
      if (engine.isSessionActive(sessionId)) {
        logger.info(`[browser.act] state-load: engine active, state already persisted in profile dir`);
        return { ok: true, action, sessionId, executionTime: Date.now() - start };
      }
      return run(['state-load', p], `state-load ${p}`);
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    case 'resize': {
      const _ePage = engine.getPage(sessionId);
      if (_ePage) {
        try { await _ePage.setViewportSize({ width: width || 1280, height: height || 800 }); return { ok: true, action, sessionId, executionTime: Date.now() - start }; }
        catch (e) { logger.warn(`[browser.act] resize (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['resize', String(width || 1280), String(height || 800)], 'resize');
    }

    // ── newPage (alias tab-new) ───────────────────────────────────────────────
    case 'newPage': {
      const _ctx = engine.getContext(sessionId);
      if (_ctx) {
        try {
          const newPage = await _ctx.newPage();
          if (url) await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeoutMs, 30000) });
          const newIdx = _ctx.pages().length - 1;
          currentTabIndex.set(sessionId, newIdx);
          return { ok: true, action, sessionId, tabIndex: newIdx, executionTime: Date.now() - start };
        } catch (e) { logger.warn(`[browser.act] newPage (engine) failed: ${e.message} — falling back to CLI`); }
      }
      return run(['tab-new', url || ''], 'newPage');
    }

    // ── diagnose ──────────────────────────────────────────────────────────────
    // Self-healing action: when a browser.act command fails with a tool error,
    // diagnose() probes playwright-cli --help, identifies the correct usage,
    // writes a context_rule so the same mistake never repeats, and returns a fix.
    // Args: failedAction (string), errorText (string), sessionId
    case 'diagnose': {
      const failedAction = args.failedAction || selector || '';
      const errorText    = args.errorText    || text    || '';

      logger.info(`[browser.act] diagnose: failedAction="${failedAction}" error="${errorText.slice(0, 120)}"`);

      // 1. Probe playwright-cli --help to get ground-truth command list
      const { spawnSync } = require('child_process');
      const helpProc = spawnSync(CLI_BIN, ['--help'], { encoding: 'utf8', timeout: 5000 });
      const helpText = (helpProc.stdout || '') + (helpProc.stderr || '');

      // 2. If specific command failed, probe its --help too
      let cmdHelp = '';
      if (failedAction) {
        const cmdHelpProc = spawnSync(CLI_BIN, ['--help', failedAction], { encoding: 'utf8', timeout: 5000 });
        cmdHelp = (cmdHelpProc.stdout || '') + (cmdHelpProc.stderr || '');
      }

      // 3. Pattern-match known failure signatures → generate fix rule
      const fixes = [];

      // TypeError: result is not a function → eval expects () => expr not IIFE
      if (/TypeError: result is not a function/i.test(errorText)) {
        fixes.push('playwright-cli eval expects a function expression: `() => value` — NOT an IIFE `(() => {...})()`. Pass the function without calling it.');
      }

      // scroll with distance/direction not working → mousewheel
      if (/scroll/i.test(failedAction) && /mousewheel|scroll/i.test(helpText)) {
        const mwLine = helpText.split('\n').find(l => /mousewheel/i.test(l)) || '';
        fixes.push(`scroll maps to playwright-cli mousewheel <dx> <dy>. Usage: ${mwLine.trim()}`);
      }

      // click with text selector rejected → needs snapshot ref
      if (/click/i.test(failedAction) && /ref.*snapshot/i.test(helpText)) {
        fixes.push('playwright-cli click only accepts element refs from snapshot (e.g. e12). Use eval with a function expression to click by text.');
      }

      // Serialization/deserialization errors → session restart required
      if (/Failed to deserialize|Serialization Error|expected end of object/i.test(errorText)) {
        fixes.push('Node.js IPC serialization error detected. The browser session may be corrupted. Restart the browser session with a fresh sessionId.');
      }

      const fixSummary = fixes.length > 0
        ? fixes.join(' | ')
        : `playwright-cli ${failedAction} usage: ${(cmdHelp || helpText).slice(0, 300)}`;

      // 4. Write permanent context_rule so planner never repeats this mistake
      try {
        const db = require('../skill-helpers/skill-db.cjs');
        const ruleKey = `playwright-cli:${failedAction || 'general'}`;
        await db.setContextRule(ruleKey, fixSummary);
        logger.info(`[browser.act] diagnose: wrote context_rule for "${ruleKey}": ${fixSummary.slice(0, 120)}`);
      } catch (e) {
        logger.warn(`[browser.act] diagnose: failed to write context_rule — ${e.message}`);
      }

      return {
        ok: true,
        action,
        sessionId,
        diagnosis:     fixSummary,
        failedAction,
        errorText,
        helpText:      helpText.slice(0, 800),
        cmdHelp:       cmdHelp.slice(0, 400),
        fixes,
        result:        fixSummary,
        executionTime: Date.now() - start,
      };
    }

    // ── examine ───────────────────────────────────────────────────────────────
    // Scans the current page snapshot against the planned next actions.
    // Uses LLM to diagnose: auth walls, missing elements, wrong page/section,
    // modals blocking content, etc.
    // Returns: { ok, status, issue, recovery, contextRule, needsUser }
    //   status: 'OK' | 'RECOVERABLE' | 'NEEDS_USER' | 'BLOCKED'
    //   RECOVERABLE → auto-writes context_rule, replan can fix it
    //   NEEDS_USER  → surfaces message to user, halts plan
    case 'examine': {
      const intent = args.intent || text || '';  // what the plan is trying to do
      const nextActions = args.nextActions || []; // upcoming plan steps

      // 1. Capture fresh snapshot + current URL
      // Retry once if cache is empty — Chrome restore dialog may have blocked the first attempt.
      // captureSnapshot sends blind Escapes first, so the retry should land on a clean page.
      await captureSnapshot(sessionId, headed, timeoutMs);
      let snap = snapshotCache.get(_tabKey(sessionId)) || '';
      if (!snap) {
        logger.info(`[browser.act] examine: snapshot empty — retrying after 600ms (dialog may have blocked first attempt)`);
        await new Promise(r => setTimeout(r, 600));
        await captureSnapshot(sessionId, headed, timeoutMs);
        snap = snapshotCache.get(_tabKey(sessionId)) || '';
      }

      // playwright-cli output format: <result>\n### Ran Playwright code\n...
      // Extract the value BEFORE the first ### header.
      function extractEvalValue(raw) {
        const m = (raw || '').match(/^([\s\S]*?)(?=###\s|$)/i);
        const val = m ? m[1].trim() : (raw || '').trim();
        return val.replace(/^["']|["']$/g, '').trim();
      }

      const urlRes = await cliRun([...S, 'eval', 'location.href'], 3000);
      const pageUrl = extractEvalValue(urlRes.stdout) || 'unknown';
      const titleRes = await cliRun([...S, 'eval', 'document.title'], 3000);
      const pageTitle = extractEvalValue(titleRes.stdout) || '';

      if (!snap) {
        return { ok: false, action, sessionId, error: 'No snapshot available for examination', executionTime: Date.now() - start };
      }

      // 2. Parse snapshot into candidates (structured ARIA data)
      const candidates = parseSnapshotCandidates(snap);
      const snapPreview = snap.split('\n').slice(0, 3).join(' | ');
      logger.info(`[browser.act] examine: ${candidates.length} candidates parsed (snap ${snap.length} chars). Preview: ${snapPreview.slice(0, 200)}`);
      if (candidates.length > 0) {
        logger.info(`[browser.act] examine: first 10 candidates: ${candidates.slice(0, 10).map(c => `${c.role}:"${c.label}"`).join(', ')}`);
      }

      // 3. Fast-path heuristic checks before calling LLM
      const AUTH_LABELS = /^(log in|sign in|sign in to|sign up|sign up for free|create account|get started|login|signin|join free|join now)$/i;
      const authEl = candidates.find(c =>
        (c.role === 'link' || c.role === 'button') &&
        AUTH_LABELS.test(c.label.trim()) &&
        c.depth <= 24
      );

      // Build element summary for LLM — keep all roles (sidebar links are often 'link' or 'generic')
      // Include up to 120 candidates so the project list is visible to the LLM
      const elementSummary = candidates
        .filter(c => c.label.length > 0)
        .slice(0, 120)
        .map(c => `[${c.role}] "${c.label}"${c.attrs ? ' ' + c.attrs.slice(0, 60) : ''}`)
        .join('\n');

      // 3b. Fast-path OK check — if intent keywords directly match a candidate, skip LLM entirely
      // This prevents false NEEDS_USER when the element IS visible but LLM misreads summary
      if (intent && candidates.length > 0) {
        const intentTokens = intent.toLowerCase().split(/\W+/).filter(t => t.length >= 3);
        const directMatch = candidates.find(c => {
          const lbl = c.label.toLowerCase();
          return intentTokens.some(t => lbl.includes(t));
        });
        if (directMatch) {
          logger.info(`[browser.act] examine: fast-path OK — intent token matched candidate ${directMatch.role}:"${directMatch.label}"`);
          return {
            ok: true, action, sessionId,
            status: 'OK',
            issue: null, recovery: null, userMessage: null, contextRule: null,
            missingElements: [], availableAlternatives: [],
            authRequired: false, needsUser: false,
            result: 'Page ready',
            executionTime: Date.now() - start,
          };
        }
      }

      // 4. LLM diagnosis
      let diagnosis = null;
      try {
        const { ask } = require('../skill-helpers/skill-llm.cjs');
        const prompt = `You are a browser automation assistant examining a web page to determine if the planned actions can be completed.

PAGE URL: ${pageUrl}
PAGE TITLE: ${pageTitle}

PLANNED INTENT: ${intent}
NEXT ACTIONS: ${JSON.stringify(nextActions, null, 2)}

CURRENT PAGE ELEMENTS (accessibility tree):
${elementSummary}

Analyze whether the page is in the right state to complete the planned actions.

Diagnose ONE of these statuses:
- OK: Page is ready, all needed elements are present
- RECOVERABLE: Page has an issue but automation can fix it (wrong sub-page, needs scroll, modal to dismiss, wrong tab)
- NEEDS_USER: Human must act first (not logged in, paywall, captcha, missing API key setup, requested item doesn't exist on page)
- BLOCKED: Page is broken, 404, redirect loop, or completely wrong site

Respond ONLY with valid JSON:
{
  "status": "OK|RECOVERABLE|NEEDS_USER|BLOCKED",
  "issue": "one sentence describing what is wrong, or null if OK",
  "recovery": "one sentence describing what automation can do to fix it, or null if not RECOVERABLE",
  "userMessage": "clear message to show the user explaining what they need to do, or null if not NEEDS_USER",
  "contextRule": "short rule to store for future plans on this domain, or null if OK",
  "missingElements": ["list of element labels the plan needs but are not on page"],
  "availableAlternatives": ["similar items found that might be what user meant"]
}`;

        const raw = await ask(prompt, { maxTokens: 400, temperature: 0 });
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) diagnosis = JSON.parse(jsonMatch[0]);
      } catch (e) {
        logger.warn(`[browser.act] examine: LLM call failed — ${e.message}`);
      }

      // 5. Fall back to heuristic if LLM unavailable
      if (!diagnosis) {
        if (authEl) {
          diagnosis = {
            status: 'NEEDS_USER',
            issue: `Not logged in — "${authEl.label}" button is visible`,
            recovery: null,
            userMessage: `You need to log in to ${pageUrl} before I can complete this task. Please log in and try again.`,
            contextRule: `User must be logged in. "${authEl.label}" button visible = not authenticated.`,
            missingElements: [],
            availableAlternatives: [],
          };
        } else {
          diagnosis = { status: 'OK', issue: null, recovery: null, userMessage: null, contextRule: null, missingElements: [], availableAlternatives: [] };
        }
      }

      // 6. For RECOVERABLE: auto-write context_rule so replan has the info
      if ((diagnosis.status === 'RECOVERABLE' || diagnosis.status === 'NEEDS_USER') && diagnosis.contextRule) {
        try {
          const db = require('../skill-helpers/skill-db.cjs');
          const domain = pageUrl.replace(/^https?:\/\//, '').split('/')[0];
          await db.setContextRule(domain, diagnosis.contextRule);
          logger.info(`[browser.act] examine: wrote context_rule for "${domain}": ${diagnosis.contextRule}`);
        } catch (e) {
          logger.warn(`[browser.act] examine: failed to write context_rule — ${e.message}`);
        }
      }

      logger.info(`[browser.act] examine: status=${diagnosis.status} issue="${diagnosis.issue || 'none'}" url=${pageUrl}`);

      return {
        ok: diagnosis.status === 'OK',
        action,
        sessionId,
        status:               diagnosis.status,
        issue:                diagnosis.issue || null,
        recovery:             diagnosis.recovery || null,
        userMessage:          diagnosis.userMessage || null,
        contextRule:          diagnosis.contextRule || null,
        missingElements:      diagnosis.missingElements || [],
        availableAlternatives: diagnosis.availableAlternatives || [],
        authRequired:         diagnosis.status === 'NEEDS_USER' && !!authEl,
        needsUser:            diagnosis.status === 'NEEDS_USER',
        result:               diagnosis.issue || (diagnosis.status === 'OK' ? 'Page ready' : diagnosis.status),
        executionTime:        Date.now() - start,
        error:                diagnosis.status !== 'OK' ? diagnosis.issue : undefined,
      };
    }

    // ── Chrome Crash Detection ─────────────────────────────────────────────────
    case 'detectCrash': {
      return await handleDetectCrash(sessionId, args.step || {}, args.error || 'Chrome crash detected');
    }

    // ── Session Recovery ───────────────────────────────────────────────────────
    case 'recoverSession': {
      const recovery = await recoverFromAboutBlank(sessionId, args.url || 'https://mail.google.com');
      return {
        ok: recovery.recovered,
        action,
        sessionId,
        result: recovery.method || recovery.error,
        executionTime: Date.now() - start
      };
    }

    
    // ── Minimize ─────────────────────────────────────────────────────────────
    case 'minimize': {
      const platform = process.platform;
      const minimizeCommands = [];
      
      if (platform === 'darwin') {
        // macOS: minimize front Chrome window
        minimizeCommands.push(`osascript -e 'tell application "Google Chrome" to set miniaturized of front window to true'`);
      } else if (platform === 'win32') {
        // Windows: minimize using PowerShell and user32.dll
        minimizeCommands.push(`powershell -Command "Add-Type '[DllImport(\"user32.dll\")]public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);' -Name Win -Namespace Native; \$chrome = Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -First 1; if (\$chrome -and \$chrome.MainWindowHandle -ne 0) { [Native.Win]::ShowWindowAsync(\$chrome.MainWindowHandle, 2) | Out-Null; 'Minimized' } else { 'No Chrome window found' }"`);
      } else if (platform === 'linux') {
        // Linux: try multiple fallback commands
        minimizeCommands.push('xdotool getactivewindow windowminimize 2>/dev/null || wmctrl -r :ACTIVE: -b add,hidden 2>/dev/null || wlrctl window minimize 2>/dev/null || true');
      }
      
      let minimized = false;
      for (const cmd of minimizeCommands) {
        try {
          await new Promise((resolve) => {
            exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
              if (!error) {
                minimized = true;
                logger.info(`[browser.act] minimize succeeded: ${stdout?.trim() || 'ok'}`);
              } else {
                logger.debug(`[browser.act] minimize attempt failed: ${error.message}`);
              }
              resolve();
            });
          });
          if (minimized) break;
        } catch (e) {
          logger.debug(`[browser.act] minimize error: ${e.message}`);
        }
      }
      
      return { ok: true, action, sessionId, minimized, executionTime: Date.now() - start };
    }
    
    // ── Fallback ─────────────────────────────────────────────────────────────
    default: {
      logger.warn(`[browser.act] Unknown action "${action}" — attempting direct passthrough`);
      return run([action, ...(url ? [url] : []), ...(selector ? [selector] : [])], action);
    }
  }
}

// ---------------------------------------------------------------------------
// Parse playwright-cli snapshot output into elements array for pre-scan
// Snapshot format (YAML-like):
//   - [e1] link "Wikipedia" [href=...]
//   - [e4] textbox "Search Wikipedia" [focused]
// ---------------------------------------------------------------------------
function parseSnapshotToElements(snapshotText) {
  if (!snapshotText) return [];
  const elements = [];
  const lines = snapshotText.split('\n');
  for (const line of lines) {
    const m = line.match(/\[?(e\d+)\]?\s+(\w+)\s+"([^"]+)"/i);
    if (m) {
      const [, ref, tag, label] = m;
      const hrefM = line.match(/\[href=([^\]]+)\]/);
      elements.push({
        ref,
        tag:   tag.toLowerCase(),
        label,
        href:  hrefM ? hrefM[1] : undefined,
      });
    }
  }
  return elements;
}

// Export for use by playwright.agent and other debugging tools
module.exports = {
  browserAct,
  getDebuggingContext,
  captureDebugContext,
  stopSessionTracing,
  debuggingSessions: debuggingSessions,
  killExistingChromeForProfile,
  clearProfileLock,
  findCli,
  shortSessionId,
  injectAdBlock,
  PLAYWRIGHT_CLI_AVAILABLE,
  engine,
  invalidateEngineSnapshot,
  _classifyAuthCookies,
  _sniffAuthCookies,
  _detachCookieSniffCdp,
};
