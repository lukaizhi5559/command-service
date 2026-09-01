'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger.cjs');
const { setupInterceptionNode, clearAdBlockSession } = require('../utils/ad-block-network.cjs');

let _chromium = null;
function getChromium() {
  if (!_chromium) _chromium = require('playwright').chromium;
  return _chromium;
}

// Cached result of whether the user's real Google Chrome is installed.
// null = not yet checked; true/false = checked. When real Chrome launch fails,
// a cooldown timestamp is recorded so we skip real Chrome for a while but
// retry it again after the cooldown expires (transient failures like profile
// locks shouldn't permanently disable real Chrome).
let _realChromeAvailable = null;
let _realChromeCooldownUntil = 0;
const _REAL_CHROME_COOLDOWN_MS = 60 * 1000; // 1 minute cooldown after a launch failure

// Track which sessions are currently using real Chrome (channel='chrome').
// On macOS, launching a 2nd real Chrome instance redirects to the 1st one's
// window (creating a blank tab there) and fails with "Opening in existing
// browser session". To avoid this, concurrent agents skip real Chrome and
// use bundled Chrome for Testing (CfT) directly — they're already
// authenticated via persistent profiles, so OAuth isn't needed.
const _activeRealChromeSessions = new Set();

/**
 * Detect whether the user's real Google Chrome is installed.
 * Checks common install paths per platform. Returns true/false.
 */
function _detectRealChrome() {
  try {
    const platform = process.platform;
    const fsLocal = require('fs');
    if (platform === 'darwin') {
      const osLocal = require('os');
      const home = osLocal.homedir();
      return fsLocal.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ||
             fsLocal.existsSync(`${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`);
    }
    if (platform === 'win32') {
      const path = require('path');
      const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
      const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const localAppData = process.env['LOCALAPPDATA'] || '';
      return fsLocal.existsSync(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
             fsLocal.existsSync(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')) ||
             (localAppData && fsLocal.existsSync(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    }
    // Linux: check common binary locations
    if (platform === 'linux') {
      return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
        .some(p => fsLocal.existsSync(p));
    }
  } catch (_) {}
  return false;
}

const _sessions = new Map();
const _telRe = /analytics|telemetry|beacon|metrics|sentry|collect|jot|log_event|track|amplitude|datadog|newrelic|rum|perf|\btapi\b|gen_?204|pixel|csp-report|\/li\/track|clienttelemetry|ingraph/i;

function sessionProfileDir(sessionId) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clearProfileLock(sessionId) {
  try {
    const lockFile = path.join(sessionProfileDir(sessionId), 'SingletonLock');
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (_) {}
  try {
    const prefsPath = path.join(sessionProfileDir(sessionId), 'Default', 'Preferences');
    if (fs.existsSync(prefsPath)) {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      let patched = false;
      if (prefs?.profile?.exit_type === 'Crashed') { prefs.profile.exit_type = 'Normal'; patched = true; }
      if (prefs?.profile?.exited_cleanly === false) { prefs.profile.exited_cleanly = true; patched = true; }
      if (patched) fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8');
    }
  } catch (_) {}
}

function _attachNetLog(page, netLog) {
  page.on('response', async (res) => {
    try {
      const m = res.request().method();
      if (!/^(POST|PUT|PATCH|DELETE)$/i.test(m)) return;
      const u = res.url();
      if (_telRe.test(u)) return;
      let _payload = null;
      try { _payload = res.request().postData() || null; } catch (_) {}
      if (_payload && _payload.length > 2000) _payload = _payload.slice(0, 2000);

      // Capture response body for failed responses (4xx/5xx) — contains error message
      let _responseBody = null;
      const _status = res.status();
      if (_status >= 400) {
        try { _responseBody = (await res.text()).slice(0, 1000); } catch (_) { /* body may be consumed or unavailable */ }
      }

      netLog.push({ method: m.toUpperCase(), url: u, status: _status, ts: Date.now(), payload: _payload, responseBody: _responseBody });
      if (netLog.length > 100) netLog.shift();
    } catch (_) {}
  });
}

// Native dialog handler — prevents beforeunload/confirm/alert from blocking automation.
// Without this, Playwright auto-dismisses dialogs silently (beforeunload navigates away,
// losing form state). We handle each type appropriately:
// - beforeunload: accept (STAY on page — don't lose form data)
// - confirm: dismiss (don't confirm destructive actions like "Discard changes?")
// - alert/prompt: accept (just dismiss)
function _attachDialogHandler(page) {
  page.on('dialog', async (dialog) => {
    const _type = dialog.type();
    const _message = dialog.message();
    logger.info(`[browser-engine] Native dialog: type=${_type}, message="${_message.slice(0, 100)}"`);
    try {
      if (_type === 'beforeunload') {
        await dialog.accept(); // stay on the page — don't lose form data
      } else if (_type === 'confirm') {
        await dialog.dismiss(); // don't confirm destructive actions
      } else {
        await dialog.accept(); // alert/prompt — just dismiss
      }
    } catch (_) {}
  });
}

async function launch(sessionId, opts = {}) {
  const existing = _sessions.get(sessionId);
  if (existing?.context) return existing.context;

  const headed = opts.headed !== false;
  const profileDir = opts.profileDir || sessionProfileDir(sessionId);

  // Check if Chrome is already running with this profile via SingletonLock.
  // If a live Chrome process exists, kill it so we can launch cleanly.
  // Without this, launchPersistentContext exits with "Opening in existing browser session"
  // and leaves an about:blank tab.
  try {
    const lockPath = path.join(profileDir, 'SingletonLock');
    if (fs.existsSync(lockPath)) {
      let target = '';
      try { target = fs.readlinkSync(lockPath); } catch (_) { target = ''; }
      const m = String(target).match(/-(\d+)$/);
      if (m) {
        const pid = parseInt(m[1], 10);
        if (pid) {
          try {
            process.kill(pid, 0); // check if process is alive
            // Chrome is running — kill it so we can launch cleanly
            logger.info(`[browser-engine] killing existing Chrome pid=${pid} for session=${sessionId}`);
            try { process.kill(pid, 'SIGTERM'); } catch (_) {}
            await new Promise(r => setTimeout(r, 1000));
          } catch (_) {
            // Stale lock — pid is gone, will be cleaned by clearProfileLock
          }
        }
      }
    }
  } catch (_) { /* non-fatal */ }

  clearProfileLock(sessionId);

  // ── Block protocol handler permission popups ──────────────────────────────
  // Chrome shows "X wants to Open web calendar links" / "Open mail links" popups
  // for webcal:, mailto:, tel: schemes. --disable-features=ProtocolHandler alone
  // doesn't suppress them. Write Chrome Preferences to exclude these schemes so
  // the permission prompt never appears. Also clear any cached "Ask" decisions.
  try {
    const _prefsDir = path.join(profileDir, 'Default');
    const _prefsPath = path.join(_prefsDir, 'Preferences');
    let _prefs = {};
    if (fs.existsSync(_prefsPath)) {
      try { _prefs = JSON.parse(fs.readFileSync(_prefsPath, 'utf8')); } catch (_) { _prefs = {}; }
    }
    if (!fs.existsSync(_prefsDir)) fs.mkdirSync(_prefsDir, { recursive: true });
    // protocol_handler.excluded_schemes: true = don't ask, block silently
    if (!_prefs.protocol_handler) _prefs.protocol_handler = {};
    if (!_prefs.protocol_handler.excluded_schemes) _prefs.protocol_handler.excluded_schemes = {};
    _prefs.protocol_handler.excluded_schemes.webcal = true;
    _prefs.protocol_handler.excluded_schemes.mailto = true;
    _prefs.protocol_handler.excluded_schemes.tel = true;
    _prefs.protocol_handler.excluded_schemes.sms = true;
    // Clear any previously cached "Ask" / allowed protocol decisions so Chrome
    // doesn't reuse them and show the popup again.
    if (_prefs.protocol_handler.allowed_origin_protocol_pairs) {
      delete _prefs.protocol_handler.allowed_origin_protocol_pairs;
    }
    if (_prefs.protocol_handler.excluded_origins) {
      delete _prefs.protocol_handler.excluded_origins;
    }
    fs.writeFileSync(_prefsPath, JSON.stringify(_prefs));
  } catch (_) { /* non-fatal — popup may appear but won't break automation */ }

  // ── Block "Show notifications" permission popup ───────────────────────────
  // Chrome shows "X wants to show notifications" popup which steals focus
  // from the page. Write Chrome Preferences to block notifications globally.
  try {
    const _prefsDir2 = path.join(profileDir, 'Default');
    const _prefsPath2 = path.join(_prefsDir2, 'Preferences');
    let _prefs2 = {};
    if (fs.existsSync(_prefsPath2)) {
      try { _prefs2 = JSON.parse(fs.readFileSync(_prefsPath2, 'utf8')); } catch (_) { _prefs2 = {}; }
    }
    if (!_prefs2.profile) _prefs2.profile = {};
    if (!_prefs2.profile.content_settings) _prefs2.profile.content_settings = {};
    if (!_prefs2.profile.content_settings.exceptions) _prefs2.profile.content_settings.exceptions = {};
    if (!_prefs2.profile.content_settings.exceptions.notifications) _prefs2.profile.content_settings.exceptions.notifications = {};
    // setting: 2 = block (1 = allow, 3 = ask)
    _prefs2.profile.content_settings.exceptions.notifications["*,*"] = { setting: 2 };
    fs.writeFileSync(_prefsPath2, JSON.stringify(_prefs2));
  } catch (_) { /* non-fatal */ }

  // ── Browser channel selection ──────────────────────────────────────────────
  // Default to the user's installed Google Chrome (channel: 'chrome') instead of
  // Playwright's bundled "Chrome for Testing". Real Chrome is required for OAuth
  // flows — Google and Cloudflare bot-detect CDP-controlled Chrome for Testing and
  // silently hang/refuse the OAuth handshake (e.g. ChatGPT "Continue with Google").
  //
  // Override via env:
  //   THINKDROP_BROWSER_CHANNEL=chrome  → force real Chrome (default)
  //   THINKDROP_BROWSER_CHANNEL=cft     → force bundled Chrome for Testing
  // If real Chrome is not installed, gracefully fall back to bundled CfT.
  const launchOpts = {
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    // deviceScaleFactor is a CONTEXT option, not a viewport property. At 1x, screenshots
    // are 1280x800 and LiteParse/OCR can barely read the small UI text; at 2x they are
    // 2560x1600 which reads cleanly. Coordinate scaling reads the real PNG dimensions.
    deviceScaleFactor: 2,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-features=ProtocolHandler,RegisterProtocolHandler', '--disable-notifications'],
  };

  const _envChannel = String(process.env.THINKDROP_BROWSER_CHANNEL || '').toLowerCase();
  const _wantChrome = _envChannel !== 'cft'; // default: real Chrome; 'cft' opts out
  let _usedChannel = null;
  let ctx = null;

  if (_wantChrome) {
    // Check if real Chrome is available (cached after first check).
    if (_realChromeAvailable === null) {
      _realChromeAvailable = _detectRealChrome();
      logger.info(`[browser-engine] real Chrome available: ${_realChromeAvailable}`);
    }
    const _inCooldown = _realChromeAvailable && Date.now() < _realChromeCooldownUntil;
    if (_inCooldown) {
      logger.info(`[browser-engine] real Chrome in cooldown (until ${new Date(_realChromeCooldownUntil).toISOString()}) — using bundled CfT`);
    }

    // ── Concurrent real Chrome guard ──────────────────────────────────────
    // On macOS, launching a 2nd real Chrome instance redirects to the 1st
    // one's window (creating a blank tab there) and fails with "Opening in
    // existing browser session". Skip real Chrome if another session is
    // already using it — concurrent agents use CfT directly (they're already
    // authenticated via persistent profiles, so OAuth isn't needed).
    const _otherRealChromeActive = [..._activeRealChromeSessions].some(s => s !== sessionId);
    if (_otherRealChromeActive) {
      logger.info(`[browser-engine] skipping real Chrome — ${_activeRealChromeSessions.size} session(s) already using it (${[..._activeRealChromeSessions].join(', ')}) — using bundled CfT for session=${sessionId}`);
    }

    if (_realChromeAvailable && !_inCooldown && !_otherRealChromeActive) {
      try {
        ctx = await getChromium().launchPersistentContext(profileDir, { ...launchOpts, channel: 'chrome' });
        _usedChannel = 'chrome';
        _activeRealChromeSessions.add(sessionId);
      } catch (chromeErr) {
        // On "Opening in existing browser session" or profile lock errors,
        // fall back to CfT immediately — do NOT retry (the retry produces
        // extra blank tabs for no benefit, since the SingletonLock cleanup
        // at the top of launch() already handled zombie processes).
        if (/already in use|profile.*lock|Opening in existing browser session/i.test(chromeErr.message)) {
          logger.warn(`[browser-engine] real Chrome launch failed (${chromeErr.message}) — falling back to bundled CfT (no retry — avoids blank tabs)`);
        } else {
          logger.warn(`[browser-engine] real Chrome launch failed (${chromeErr.message}) — falling back to bundled CfT (cooldown ${_REAL_CHROME_COOLDOWN_MS}ms)`);
          _realChromeCooldownUntil = Date.now() + _REAL_CHROME_COOLDOWN_MS;
        }
      }
    }
  }

  if (!ctx) {
    ctx = await getChromium().launchPersistentContext(profileDir, launchOpts);
    _usedChannel = 'cft';
  }

  const netLog = [];
  const pages = ctx.pages();
  ctx.on('page', (p) => { _attachNetLog(p, netLog); _attachDialogHandler(p); });
  for (const p of pages) { _attachNetLog(p, netLog); _attachDialogHandler(p); }

  // Register ad-block interception (route blocking + init script) for all future navigations
  await setupInterceptionNode(ctx, sessionId);

  _sessions.set(sessionId, { context: ctx, netLog, refMaps: new Map(), activePage: pages.find((p) => !/^about:blank$/i.test(p.url())) || pages[0] || null });
  logger.info(`[browser-engine] session=${sessionId} launched (channel=${_usedChannel}, ${pages.length} page(s))`);
  return ctx;
}

function getPage(sessionId) {
  const s = _sessions.get(sessionId);
  if (!s?.context) return null;
  const pages = s.context.pages();
  if (s.activePage && pages.includes(s.activePage) && !s.activePage.isClosed()) return s.activePage;
  s.activePage = pages.find((p) => !p.isClosed() && !/^about:blank$/i.test(p.url())) || pages.find((p) => !p.isClosed()) || null;
  return s.activePage;
}

function setActivePage(sessionId, page) {
  const s = _sessions.get(sessionId);
  if (!s?.context || !page || page.isClosed() || !s.context.pages().includes(page)) return false;
  s.activePage = page;
  return true;
}

function getContext(sessionId) {
  return _sessions.get(sessionId)?.context || null;
}

async function closeSession(sessionId) {
  const s = _sessions.get(sessionId);
  if (!s) return;
  try { await s.context.close(); } catch (e) { logger.warn(`[browser-engine] close: ${e.message}`); }
  clearAdBlockSession(sessionId);
  _activeRealChromeSessions.delete(sessionId);
  _sessions.delete(sessionId);
}

function listSessions() { return [..._sessions.keys()]; }
function isSessionActive(sessionId) {
  const s = _sessions.get(sessionId);
  if (!s?.context) return false;
  try { return s.context.pages().length > 0; } catch (_) { return false; }
}

function getNetLog(sessionId) { return _sessions.get(sessionId)?.netLog || []; }
function clearNetLog(sessionId) {
  const s = _sessions.get(sessionId);
  if (s?.netLog) s.netLog.length = 0;
}

// ── DOM Scanner: tags real interactive elements with data-td-ref ─────────
// Replaces the ARIA-snapshot-based buildRefTree. Scans the DOM for interactive
// elements, checks visibility/occlusion, assigns stable refs, and produces a
// YAML-like text for LLM consumption. Falls back to page.ariaSnapshot() when
// the scanner finds 0 candidates (shadow DOM, canvas, SPA not yet rendered).

const _DOM_SCANNER_SCRIPT = `(() => {
  const EXCLUDE_CONTEXT = /\\b(search|filter|sort|history|recent|sidebar|nav|footer|breadcrumb|pagination|prev|next|page-?number|load-?more|show-?more|sign-?up|sign-?in|log-?in|subscribe|newsletter|cookie|accept|reject|settings|preferences|privacy|terms|about|help|support|contact|feedback|share|follow|social|footer-?link|copyright|skip-?to-?content|skip-?link|screen-?reader|sr-?only|aria-?hidden|hidden|back-?to-?top|scroll-?to-?top|avatar|notification|bell-?icon|inbox-?count|message-?count|unread|badge|tooltip|carousel|slider|banner|promo|ad-?container|sponsor|advertisement|google-?ads|adsense|doubleclick)\\b/i;

  const SEMANTIC_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], [contenteditable], [onclick], [tabindex]:not([tabindex="-1"])';
  const CLASS_HEURISTIC = /\\b(btn|button|clickable|toggle|switch|tab|link|action|submit|send|post|share|reply|compose|edit|delete|remove|close|cancel|save|confirm|apply|select|choose|pick|upload|attach|download|play|pause|next|prev|previous|forward|back|expand|collapse|open|show|hide|reveal|more|menu|dropdown|filter|search|sort|clear|reset|refresh|reload|star|like|follow|unfollow|subscribe|unsubscribe|join|leave|add|create|new|delete|archive|move|copy|cut|paste|undo|redo|zoom|fit|fullscreen|exit-?fullscreen)\\b/i;

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (style.position === 'fixed' && rect.width < 3 && rect.height < 3) return false;
    // offsetParent check — but skip for fixed-position elements
    if (style.position !== 'fixed' && !el.offsetParent) return false;
    return true;
  }

  function getRect(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  function isOccluded(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    try {
      const top = document.elementFromPoint(cx, cy);
      if (!top) return false;
      if (top === el) return false;
      // Check if top is a descendant of el (e.g. span inside button)
      if (el.contains(top)) return false;
      // Check if el is inside the top element (e.g. button inside a container)
      if (top.contains(el)) return false;
      // Check if top is a known overlay pattern (transparent, full-viewport)
      const topStyle = window.getComputedStyle(top);
      const topRect = top.getBoundingClientRect();
      const isFullViewport = topRect.width >= window.innerWidth * 0.9 && topRect.height >= window.innerHeight * 0.9;
      const isTransparent = parseFloat(topStyle.opacity) < 0.3 || topStyle.backgroundColor === 'transparent' || topStyle.backgroundColor === 'rgba(0, 0, 0, 0)';
      if (isFullViewport && isTransparent) return false; // skip known overlay pattern
      return true;
    } catch (_) { return false; }
  }

  function getLabel(el) {
    return el.getAttribute('aria-label') ||
           el.getAttribute('title') ||
           el.getAttribute('placeholder') ||
           el.getAttribute('alt') ||
           (el.innerText || el.textContent || '').trim().slice(0, 80) ||
           '';
  }

  function getRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input' || tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }

  function getType(el) {
    if (el.tagName === 'INPUT') return el.type || 'text';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    if (el.isContentEditable) return 'contenteditable';
    if (el.tagName === 'SELECT') return 'select';
    return null;
  }

  function getContext(el) {
    // Walk up to find a meaningful context label
    let parent = el.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
      const label = parent.getAttribute('aria-label') || parent.getAttribute('data-testid') || '';
      if (label) return label;
      parent = parent.parentElement;
    }
    return '';
  }

  // Clear stale data-td-ref attributes from previous scans before re-tagging.
  // Without this, re-scans assign the same refs (td1, td2, ...) to new elements
  // while old elements keep their stale tags → duplicate refs → querySelector
  // returns the wrong element (e.g. a button instead of the title textbox).
  document.querySelectorAll('[data-td-ref]').forEach(el => el.removeAttribute('data-td-ref'));

  // Gather candidates
  const seen = new Set();
  const candidates = [];

  // Pass 1: semantic selectors
  for (const el of document.querySelectorAll(SEMANTIC_SELECTOR)) {
    if (seen.has(el)) continue;
    seen.add(el);
    candidates.push({ el, source: 'semantic' });
  }

  // Pass 2: class-name heuristic (catch div-wrapped custom controls)
  for (const el of document.querySelectorAll('div, span, li')) {
    if (seen.has(el)) continue;
    const cls = el.className || '';
    if (typeof cls === 'string' && CLASS_HEURISTIC.test(cls)) {
      // Only add if it looks interactive (has role, onclick, tabindex, or cursor pointer)
      const style = window.getComputedStyle(el);
      if (el.getAttribute('role') || el.getAttribute('onclick') || el.getAttribute('tabindex') || style.cursor === 'pointer') {
        seen.add(el);
        candidates.push({ el, source: 'heuristic' });
      }
    }
  }

  // Filter and build element list
  const elements = [];
  let counter = 1;

  for (const { el, source } of candidates) {
    if (!isVisible(el)) continue;
    const label = getLabel(el);
    const context = getContext(el);
    // Exclude nav/sidebar noise
    if (EXCLUDE_CONTEXT.test(label) && EXCLUDE_CONTEXT.test(context) && !el.matches('input, textarea, [contenteditable], select')) continue;
    // Skip option elements inside selects (they're not independently interactive)
    if (el.tagName === 'OPTION') continue;

    const ref = 'td' + counter++;
    el.setAttribute('data-td-ref', ref);

    const rect = getRect(el);
    const occluded = isOccluded(el);
    const role = getRole(el);
    const type = getType(el);
    const tag = el.tagName.toLowerCase();

    elements.push({
      ref, tag, role, type, label,
      visible: true,
      occluded,
      rect,
      source,
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      name: el.getAttribute('name') || '',
      contenteditable: el.isContentEditable,
      context,
    });
  }

  // Detect activeElement
  const ae = document.activeElement;
  let activeElement = null;
  if (ae && ae !== document.body && ae !== document.documentElement) {
    const aeTag = ae.tagName.toLowerCase();
    const aeType = getType(ae);
    const aeRect = ae.getBoundingClientRect();
    const aeRole = ae.getAttribute('role');
    const aeAriaPlaceholder = ae.getAttribute('aria-placeholder');
    const isInput = aeTag === 'input' || aeTag === 'textarea' || ae.isContentEditable ||
      aeRole === 'textbox' || aeRole === 'searchbox' || aeRole === 'combobox' ||
      !!aeAriaPlaceholder;
    const hasRect = aeRect.width > 5 && aeRect.height > 5;
    const aeRef = ae.getAttribute('data-td-ref') || null;
    // isPrimaryInput: focused element is a visible textarea/contenteditable/input
    // with a meaningful rect (not hidden/button/checkbox/radio)
    const isPrimaryInput = isInput && hasRect &&
      !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'image'].includes(aeType);
    activeElement = {
      tag: aeTag,
      type: aeType,
      role: aeRole || '',
      placeholder: ae.getAttribute('placeholder') || '',
      ariaPlaceholder: aeAriaPlaceholder || '',
      ref: aeRef,
      isPrimaryInput,
      isContentEditable: ae.isContentEditable,
      ariaLabel: ae.getAttribute('aria-label') || '',
    };
  }

  // Build YAML-like text for LLM consumption
  const lines = [];
  if (activeElement) {
    lines.push('# Active element: ' + activeElement.tag + (activeElement.type ? ' (' + activeElement.type + ')' : '') + (activeElement.placeholder ? ' placeholder="' + activeElement.placeholder + '"' : '') + (activeElement.ref ? ' ref=' + activeElement.ref : '') + (activeElement.isPrimaryInput ? ' [primary-input]' : ''));
    lines.push('');
  }

  // Sort: inputs first, then buttons/links, then rest
  const inputType = el => (el.role === 'textbox' || el.role === 'combobox' || el.role === 'searchbox' || el.contenteditable || el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select');
  const sorted = [...elements].sort((a, b) => {
    if (inputType(a) && !inputType(b)) return -1;
    if (!inputType(a) && inputType(b)) return 1;
    return 0;
  });

  // Cap at 80 elements
  const capped = sorted.slice(0, 80);
  for (const el of capped) {
    const flags = [];
    if (el.occluded) flags.push('occluded');
    if (el.contenteditable) flags.push('contenteditable');
    if (el.source === 'heuristic') flags.push('heuristic');
    const flagStr = flags.length > 0 ? ' [' + flags.join(', ') + ']' : '';
    const typeStr = el.type ? ' type=' + el.type : '';
    const ctxStr = el.context ? ' context="' + el.context.slice(0, 40) + '"' : '';
    lines.push('- [' + el.ref + '] ' + el.role + ' "' + el.label + '"' + typeStr + ctxStr + flagStr);
  }

  return JSON.stringify({
    elements: capped,
    activeElement,
    yaml: lines.join('\\n'),
    count: capped.length,
  });
})()`;

// ── buildRefTree: DOM scanner (primary) → ARIA snapshot (fallback) ──────────
// Returns { yaml, refMap, lowConfidenceRefs, activeElement, scannerUsed }
// - scannerUsed: true when DOM scanner produced refs (tdN), false for ARIA (eN)
// - activeElement: { tag, type, placeholder, ref, isPrimaryInput } or null

async function buildRefTree(page) {
  let scannerResult = null;
  try {
    const raw = await page.evaluate(_DOM_SCANNER_SCRIPT);
    if (raw) {
      scannerResult = JSON.parse(raw);
    }
  } catch (scannerErr) {
    logger.warn(`[browser-engine] DOM scanner failed: ${scannerErr.message} — falling back to ARIA`);
  }

  // If scanner found elements, build refMap from scanner output
  if (scannerResult && scannerResult.count > 0) {
    const refMap = new Map();
    for (const el of scannerResult.elements) {
      refMap.set(el.ref, {
        role: el.role,
        name: el.label,
        tag: el.tag,
        type: el.type,
        visible: el.visible,
        occluded: el.occluded,
        rect: el.rect,
        source: el.source,
        placeholder: el.placeholder,
        contenteditable: el.contenteditable,
        context: el.context,
      });
    }
    // Low-confidence: if >50% of elements are occluded or from heuristic source
    let _lowConf = 0;
    for (const [, v] of refMap) {
      if (v.source === 'heuristic') _lowConf++;
    }
    const lowConfidenceRefs = refMap.size > 0 && (_lowConf / refMap.size) > 0.5;

    logger.info(`[browser-engine] DOM scanner: ${refMap.size} elements tagged${scannerResult.activeElement ? ', activeElement=' + scannerResult.activeElement.tag + (scannerResult.activeElement.isPrimaryInput ? ' [primary-input]' : '') : ''}${lowConfidenceRefs ? ' (low-confidence)' : ''}`);
    return {
      yaml: scannerResult.yaml,
      refMap,
      lowConfidenceRefs,
      activeElement: scannerResult.activeElement || null,
      scannerUsed: true,
    };
  }

  // Fallback: ARIA snapshot (shadow DOM, canvas, SPA not yet rendered)
  logger.info(`[browser-engine] DOM scanner found ${scannerResult?.count || 0} elements — falling back to ARIA snapshot`);
  const raw = await page.ariaSnapshot();
  const refMap = new Map();
  let counter = 1;
  const outLines = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const indentMatch = line.match(/^(\s*)-/);
    if (!indentMatch) {
      outLines.push(line);
      continue;
    }
    const indent = indentMatch[1];
    const rest = line.slice(indentMatch[0].length).trimStart();

    const ref = `e${counter++}`;
    outLines.push(`${indent}- [${ref}] ${rest}`);

    const roleMatch = rest.match(/^(\w[\w-]*)/);
    const nameMatch = rest.match(/"([^"]*)"/);
    const name = nameMatch ? nameMatch[1] : '';
    let role = roleMatch ? roleMatch[1] : 'unknown';
    if (!roleMatch && name) role = 'generic';
    const levelMatch = rest.match(/\[level=(\d+)\]/);
    refMap.set(ref, {
      role,
      name,
      level: levelMatch ? parseInt(levelMatch[1]) : undefined,
    });
  }

  let _lowConf = 0;
  for (const [, v] of refMap) {
    if (v.role === 'unknown' || v.role === 'generic') _lowConf++;
  }
  const lowConfidenceRefs = refMap.size > 0 && (_lowConf / refMap.size) > 0.5;

  return {
    yaml: outLines.join('\n'),
    refMap,
    lowConfidenceRefs,
    activeElement: null,
    scannerUsed: false,
  };
}

module.exports = {
  launch, getPage, setActivePage, getContext, closeSession, listSessions, isSessionActive,
  getNetLog, clearNetLog, buildRefTree, _DOM_SCANNER_SCRIPT,
  sessionProfileDir, clearProfileLock,
};
