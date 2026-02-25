'use strict';

/**
 * skill: browser.act
 *
 * Full Playwright wrapper for browser automation. Runs a headed Chromium browser
 * (visible window) so the user can see what's happening. Maintains a session pool
 * so multiple browser.act calls within the same sessionId share one browser context.
 *
 * Args schema:
 * {
 *   action:      string   — one of: navigate | click | type | screenshot | waitForSelector |
 *                                   evaluate | scroll | hover | select | keyboard | close |
 *                                   getText | getAttribute | waitForNavigation | newPage | back | forward | reload
 *   sessionId:   string   — browser session identifier (reused across calls, default: 'default')
 *   timeoutMs:   number   — per-action timeout in ms (default: 15000)
 *
 *   // navigate
 *   url:         string   — URL to navigate to
 *   waitUntil:   string   — 'load' | 'domcontentloaded' | 'networkidle' (default: 'load')
 *
 *   // click
 *   selector:    string   — CSS or Playwright selector (e.g. "button:has-text('Sign in')")
 *   button:      string   — 'left' | 'right' | 'middle' (default: 'left')
 *   clickCount:  number   — number of clicks (default: 1)
 *   position:    {x,y}    — click at specific position within element
 *
 *   // type
 *   text:        string   — text to type (supports {ENTER}, {TAB}, {ESC}, {BACKSPACE})
 *   delay:       number   — delay between keystrokes in ms (default: 30)
 *   clear:       boolean  — clear existing value before typing (default: false)
 *
 *   // screenshot
 *   path:        string   — file path to save screenshot (optional, returns base64 if omitted)
 *   fullPage:    boolean  — capture full scrollable page (default: false)
 *   clip:        {x,y,width,height} — clip region
 *
 *   // waitForSelector
 *   state:       string   — 'visible' | 'hidden' | 'attached' | 'detached' (default: 'visible')
 *
 *   // evaluate
 *   expression:  string   — JavaScript expression to evaluate in page context
 *
 *   // scroll
 *   x:           number   — horizontal scroll amount in pixels
 *   y:           number   — vertical scroll amount in pixels
 *
 *   // hover
 *   selector:    string   — element to hover over
 *
 *   // select (dropdown)
 *   value:       string | string[] — option value(s) to select
 *   label:       string | string[] — option label(s) to select
 *
 *   // keyboard
 *   key:         string   — key combo (e.g. 'Control+A', 'Meta+C', 'Enter', 'Escape')
 *
 *   // getText / getAttribute
 *   attribute:   string   — attribute name for getAttribute action
 *
 *   // newPage
 *   (no extra args — opens a new tab in the session)
 * }
 *
 * Returns:
 * {
 *   ok:            boolean
 *   action:        string
 *   sessionId:     string
 *   result?:       any     — action-specific result (text, base64 screenshot, evaluate result, etc.)
 *   url?:          string  — current page URL after action
 *   title?:        string  — current page title after action
 *   executionTime: number  (ms)
 *   error?:        string
 * }
 */

const path = require('path');
const os = require('os');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Session pool — one browser + page per sessionId
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId → { page, lastUsed, contextKey }

// Shared browser + in-memory context — all sessions are tabs in the same window
// with shared cookies, localStorage, and login state across tasks.
let sharedBrowser = null;
let sharedContext = null;

// ---------------------------------------------------------------------------
// Persistent context pool — keyed by userDataDir
// Each persistent context survives process restarts (cookies/session stored on disk).
// Used when args.userDataDir is provided (e.g. for Gmail, GitHub, etc.)
// ---------------------------------------------------------------------------
const persistentContexts = new Map(); // userDataDir → BrowserContext

// Base directory for all persistent browser profiles
const PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-sessions');

/**
 * Get or create a persistent browser context for the given profile name.
 * The profile is stored at ~/.thinkdrop/browser-sessions/<profileName>/
 * and survives process restarts — cookies, localStorage, and session tokens
 * are preserved so the user only needs to log in once.
 */
async function getPersistentContext(profileName) {
  const userDataDir = path.join(PROFILES_DIR, profileName);

  // Reuse existing live context
  if (persistentContexts.has(userDataDir)) {
    const ctx = persistentContexts.get(userDataDir);
    try {
      ctx.pages(); // throws if context is closed
      return { context: ctx, userDataDir };
    } catch (_) {
      persistentContexts.delete(userDataDir);
    }
  }

  // Ensure profile directory exists
  const fs = require('fs');
  fs.mkdirSync(userDataDir, { recursive: true });

  const { chromium } = require('playwright');
  logger.info(`[browser.act] Launching persistent context for profile: ${profileName} (${userDataDir})`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  context.on('close', () => {
    logger.info(`[browser.act] Persistent context closed: ${profileName}`);
    persistentContexts.delete(userDataDir);
    // Remove any sessions that used this context
    for (const [sid, s] of sessions.entries()) {
      if (s.contextKey === userDataDir) sessions.delete(sid);
    }
  });

  persistentContexts.set(userDataDir, context);
  logger.info(`[browser.act] Persistent context ready: ${profileName}`);
  return { context, userDataDir };
}

const SESSION_IDLE_MS = 10 * 60 * 1000; // 10 minutes idle → close tab

async function getSharedContext() {
  // Reuse existing live context
  if (sharedContext) {
    try {
      if (sharedContext.isClosed && sharedContext.isClosed()) {
        sharedContext = null;
        sessions.clear();
      } else {
        sharedContext.pages();
        return sharedContext;
      }
    } catch (_) {
      sharedContext = null;
      sessions.clear();
    }
  }

  // Reuse or launch browser
  if (!sharedBrowser) {
    const { chromium } = require('playwright');
    sharedBrowser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    sharedBrowser.on('disconnected', () => {
      logger.info('[browser.act] Shared browser disconnected — clearing sessions');
      sharedBrowser = null;
      sharedContext = null;
      sessions.clear();
    });
  }

  sharedContext = await sharedBrowser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  // When the user closes the browser window, the context fires 'close'.
  // Without this, sharedBrowser keeps the Chrome Testing process alive as a zombie
  // and the user has to force-quit it. Calling browser.close() here kills the process.
  sharedContext.on('close', async () => {
    logger.info('[browser.act] Shared context closed by user — shutting down browser process');
    sessions.clear();
    sharedContext = null;
    if (sharedBrowser) {
      try { await sharedBrowser.close(); } catch (_) {}
      sharedBrowser = null;
    }
  });

  logger.info('[browser.act] Created shared browser context');
  return sharedContext;
}

// Periodic cleanup of idle session tabs
// Guide sessions (guideActive=true) are EXEMPT — waitForTrigger blocks for up to 5 min
// and idle cleanup would kill the page mid-wait causing a 300s timeout cascade.
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.guideActive) continue; // skip sessions with active guide.step
    if (now - session.lastUsed > SESSION_IDLE_MS) {
      logger.info(`[browser.act] Closing idle session tab: ${id}`);
      try { await session.page.close(); } catch (_) {}
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Find the most recently active non-blank page in a context.
// When user clicks a link that opens in a new tab, the old page navigates to
// about:blank while the new tab has the real content. We want that new tab.
// ---------------------------------------------------------------------------
function getMostRecentPage(context) {
  try {
    const pages = context.pages();
    // Filter to non-blank, non-error pages
    const live = pages.filter(p => {
      try {
        const u = p.url();
        return u && u !== 'about:blank' && u !== '' && !p.isClosed();
      } catch (_) { return false; }
    });
    if (live.length === 0) return null;
    // Return the last one (most recently opened)
    return live[live.length - 1];
  } catch (_) { return null; }
}

async function getSession(sessionId, timeoutMs, profileName) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    // Verify page is still alive
    try {
      const currentUrl = s.page.url();
      s.lastUsed = Date.now();
      // If page navigated to about:blank (e.g. user clicked a link opening a new tab),
      // refresh the session's page ref to the most recently active page in the context.
      if (currentUrl === 'about:blank' || currentUrl === '') {
        const ctx = s.contextKey === 'shared' ? sharedContext : null;
        if (ctx) {
          const freshPage = getMostRecentPage(ctx);
          if (freshPage) {
            logger.info(`[browser.act] getSession: page was about:blank — refreshing to ${freshPage.url()}`);
            s.page = freshPage;
            freshPage.setDefaultTimeout(timeoutMs || 15000);
          }
        }
      }
      return s;
    } catch (_) {
      sessions.delete(sessionId);
    }
  }

  let context;
  let contextKey = 'shared';

  if (profileName) {
    // Use persistent context (cookies survive restarts)
    const { context: pCtx, userDataDir } = await getPersistentContext(profileName);
    context = pCtx;
    contextKey = userDataDir;
  } else {
    context = await getSharedContext();
  }

  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs || 15000);
  page.on('console', msg => {
    if (msg.text().startsWith('[ThinkDrop]')) logger.info(`[browser.act] PAGE_CONSOLE: ${msg.text()}`);
  });

  const session = { page, lastUsed: Date.now(), contextKey, triggerResolver: null, triggerBound: false, triggerGeneration: 0, triggerArmTime: 0 };
  sessions.set(sessionId, session);

  // Bind __tdTrigger once per session — CSP-safe CDP channel.
  // The highlight listener calls window.__tdTrigger() which resolves
  // the current step's Promise stored in session.triggerResolver.
  // triggerGeneration ensures stale debounce timers from a previous step
  // cannot fire into the next step's resolver.
  try {
    await page.exposeBinding('__tdTrigger', (source) => {
      const elapsed = Date.now() - session.triggerArmTime;
      const frameUrl = source?.frame?.url?.() || 'unknown';
      const isMain = source?.frame === page.mainFrame();
      logger.info(`[browser.act] __tdTrigger called — resolver=${!!session.triggerResolver} elapsed=${elapsed}ms isMain=${isMain} frame=${frameUrl.slice(0,60)}`);
      // Only accept triggers from the main frame — iframes (ads, trackers) must not advance the guide
      if (!isMain) { logger.info(`[browser.act] __tdTrigger: non-main frame — dropped`); return; }
      // Ignore if no resolver is waiting
      if (!session.triggerResolver) { logger.info(`[browser.act] __tdTrigger: no resolver — dropped`); return; }
      // Ignore if called before the arm window (300ms grace after waitForTrigger starts)
      if (elapsed < 300) { logger.info(`[browser.act] __tdTrigger: within grace window (${elapsed}ms) — dropped`); return; }
      logger.info(`[browser.act] __tdTrigger: ACCEPTED after ${elapsed}ms — resolving step`);
      const resolve = session.triggerResolver;
      session.triggerResolver = null;
      resolve('triggered');
    });
    session.triggerBound = true;
  } catch (bindErr) {
    logger.warn(`[browser.act] getSession: could not bind __tdTrigger — ${bindErr.message?.slice(0,80)}`);
  }

  return session;
}

// ---------------------------------------------------------------------------
// Shared DOM element extractor — used by both scanSite and scanCurrentPage
// Returns up to 80 visible interactive elements with label + selector.
// ---------------------------------------------------------------------------
async function extractPageElements(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    function getLabel(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
      const text = el.innerText || el.textContent || '';
      if (text.trim()) return text.trim().substring(0, 80);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
      const title = el.getAttribute('title');
      if (title) return title.trim();
      const name = el.getAttribute('name');
      if (name) return name.trim();
      const id = el.getAttribute('id');
      if (id) return id.trim();
      return null;
    }

    function getSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
      if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
      // Use visible text as a Playwright text= selector — most reliable for links/buttons
      const visibleText = (el.innerText || el.textContent || '').trim().substring(0, 60);
      if (visibleText.length > 2) return `text=${JSON.stringify(visibleText)}`;
      return el.tagName.toLowerCase() + (el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    }

    const selectors = [
      'button:not([disabled])',
      'a[href]',
      'input:not([type="hidden"])',
      'select',
      '[role="button"]:not([disabled])',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
    ];

    for (const sel of selectors) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const lbl = getLabel(el);
        if (!lbl || lbl.length < 2) continue;
        const key = `${el.tagName}:${lbl}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || el.getAttribute('role') || el.tagName.toLowerCase(),
          label: lbl,
          selector: getSelector(el),
          href: el.getAttribute('href') || undefined,
        });
        if (results.length >= 80) break;
      }
      if (results.length >= 80) break;
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Special key token map for type action
// ---------------------------------------------------------------------------

const KEY_TOKENS = {
  '{ENTER}': 'Enter',
  '{TAB}': 'Tab',
  '{ESC}': 'Escape',
  '{ESCAPE}': 'Escape',
  '{BACKSPACE}': 'Backspace',
  '{DELETE}': 'Delete',
  '{UP}': 'ArrowUp',
  '{DOWN}': 'ArrowDown',
  '{LEFT}': 'ArrowLeft',
  '{RIGHT}': 'ArrowRight',
  '{HOME}': 'Home',
  '{END}': 'End',
  '{PAGEUP}': 'PageUp',
  '{PAGEDOWN}': 'PageDown',
  '{SPACE}': ' ',
};

async function typeWithTokens(page, selector, text, delay, clear) {
  const locator = selector ? page.locator(selector).first() : null;

  // Detect if target is a contenteditable div (e.g. ChatGPT, Notion, Slack web)
  let isContentEditable = false;
  if (locator) {
    try {
      const tag = await locator.evaluate(el => el.tagName.toLowerCase());
      const ce = await locator.evaluate(el => el.getAttribute('contenteditable'));
      isContentEditable = (tag !== 'input' && tag !== 'textarea' && ce !== null && ce !== 'false');
    } catch (_) {}
  }

  if (clear && locator) {
    if (isContentEditable) {
      await locator.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
    } else {
      await locator.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
    }
  }

  // For contenteditable: click to focus then use keyboard.type (fill() doesn't work)
  if (isContentEditable && locator) {
    await locator.click();
  }

  // Split text on special tokens
  const parts = text.split(/(\{[A-Z]+(?:\+[A-Z]+)*\})/);
  for (const part of parts) {
    if (KEY_TOKENS[part]) {
      await page.keyboard.press(KEY_TOKENS[part]);
    } else if (part) {
      if (locator && !isContentEditable) {
        // Use fill() for long text — pressSequentially times out on 500+ char strings
        if (part.length > 200) {
          await locator.fill(part);
        } else {
          await locator.pressSequentially(part, { delay: delay ?? 30 });
        }
      } else {
        await page.keyboard.type(part, { delay: delay ?? 30 });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main skill entry point
// ---------------------------------------------------------------------------

async function browserAct(args) {
  const {
    action,
    sessionId = 'default',
    timeoutMs = 15000,
    url,
    waitUntil = 'load',
    selector,
    button = 'left',
    clickCount = 1,
    position,
    text,
    delay = 30,
    clear = false,
    path: screenshotPath,
    fullPage = false,
    clip,
    state = 'visible',
    expression,
    x: scrollX = 0,
    y: scrollY = 0,
    value,
    label,
    key,
    attribute,
    // Persistent auth args
    profile,          // profile name → ~/.thinkdrop/browser-sessions/<profile>/
    authSuccessUrl,   // URL pattern that indicates successful login (e.g. 'mail.google.com/mail')
    authTimeoutMs,    // max ms to wait for user to complete login (default: 5 minutes)
  } = args || {};

  if (!action) {
    return { ok: false, error: 'action is required' };
  }

  const startTime = Date.now();

  logger.info(`[browser.act] action=${action} sessionId=${sessionId}`);

  try {
    // close action — closes this session's tab only, shared context/login state preserved
    if (action === 'close') {
      if (sessions.has(sessionId)) {
        const s = sessions.get(sessionId);
        try { await s.page.close(); } catch (_) {}
        sessions.delete(sessionId);
      }
      return { ok: true, action, sessionId, executionTime: Date.now() - startTime };
    }

    // ── scanCurrentPage ───────────────────────────────────────────────────────
    // Scans the ALREADY-OPEN visible session page for interactive elements.
    // No headless browser, no URL guessing, no 404 risk.
    // Use this instead of scanSite for guide plans — the visible browser already
    // has the real page loaded with correct redirects, auth state, etc.
    // Args: sessionId (required)
    if (action === 'scanCurrentPage') {
      if (!sessions.has(sessionId)) {
        return { ok: false, error: `No active session: ${sessionId}`, action, sessionId, executionTime: Date.now() - startTime };
      }
      const scanSession = sessions.get(sessionId);
      // Refresh stale page ref — if the session's page is closed, about:blank, or navigated
      // away (user clicked a link opening a new tab), find the most recently active page.
      if (scanSession.contextKey === 'shared' && sharedContext) {
        try {
          const isStale = scanSession.page.isClosed() || scanSession.page.url() === 'about:blank' || scanSession.page.url() === '';
          if (isStale) {
            const freshPage = getMostRecentPage(sharedContext);
            if (freshPage) {
              logger.info(`[browser.act] scanCurrentPage: refreshing stale/closed page → ${freshPage.url()}`);
              scanSession.page = freshPage;
            }
          }
        } catch (_) {}
      }
      const scanPage = scanSession.page;
      try {
        // Wait a moment for any pending JS/renders to settle
        await scanPage.waitForTimeout(800);
        const pageTitle = await scanPage.title().catch(() => '');
        const pageUrl = scanPage.url();

        // Detect 404/error pages — check title and body text for common error patterns.
        // These pages have nav elements but no useful interactive content for guide steps.
        const is404 = await scanPage.evaluate(() => {
          const title = document.title || '';
          const body = (document.body && document.body.innerText) ? document.body.innerText.substring(0, 500) : '';
          const h1 = document.querySelector('h1');
          const h1Text = h1 ? h1.innerText || h1.textContent || '' : '';
          const errorPatterns = [
            /\b404\b/i,
            /page not found/i,
            /couldn't find/i,
            /could not find/i,
            /sorry.*find that page/i,
            /this page.*not exist/i,
            /no longer available/i,
          ];
          return errorPatterns.some(p => p.test(title) || p.test(h1Text) || p.test(body.substring(0, 300)));
        }).catch(() => false);

        if (is404) {
          logger.warn(`[browser.act] scanCurrentPage: detected 404/error page at ${pageUrl} — skipping scan`);
          return { ok: false, error: 'page_not_found', errorType: 'page_not_found', action, sessionId, url: pageUrl, executionTime: Date.now() - startTime };
        }

        const elements = await extractPageElements(scanPage);
        logger.info(`[browser.act] scanCurrentPage: ${elements.length} elements on ${pageUrl}`);
        return { ok: true, action, sessionId, result: { title: pageTitle, url: pageUrl, elements }, executionTime: Date.now() - startTime };
      } catch (err) {
        logger.warn(`[browser.act] scanCurrentPage failed: ${err.message}`);
        return { ok: false, error: err.message, action, sessionId, executionTime: Date.now() - startTime };
      }
    }

    // ── scanUrl ───────────────────────────────────────────────────────────────
    // Navigates to a URL in a fully ISOLATED headless context (never touches the
    // shared visible browser), scans interactive elements, detects 404 pages,
    // and cleans up — all in one call. Use this for guide plan prescans.
    // Args: url (required), timeoutMs (default 15000)
    if (action === 'scanUrl') {
      if (!url) return { ok: false, error: 'url is required for scanUrl' };
      const { chromium: scanChromium } = require('playwright');
      const isolatedBrowser = await scanChromium.launch({ headless: true });
      try {
        const isolatedCtx = await isolatedBrowser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const scanPage = await isolatedCtx.newPage();
        scanPage.setDefaultTimeout(timeoutMs || 15000);
        await scanPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 15000 });
        await scanPage.waitForTimeout(1000);

        const pageTitle = await scanPage.title().catch(() => '');
        const pageUrl = scanPage.url();

        // Detect 404/error pages
        const is404 = await scanPage.evaluate(() => {
          const title = document.title || '';
          const h1 = document.querySelector('h1');
          const h1Text = h1 ? (h1.innerText || h1.textContent || '') : '';
          const body = document.body ? document.body.innerText.substring(0, 400) : '';
          const patterns = [/\b404\b/i, /page not found/i, /couldn't find/i, /could not find/i, /sorry.*find that page/i];
          return patterns.some(p => p.test(title) || p.test(h1Text) || p.test(body));
        }).catch(() => false);

        if (is404) {
          logger.warn(`[browser.act] scanUrl: 404 detected at ${pageUrl}`);
          return { ok: false, error: 'page_not_found', errorType: 'page_not_found', action, sessionId, url: pageUrl, executionTime: Date.now() - startTime };
        }

        const elements = await extractPageElements(scanPage);
        logger.info(`[browser.act] scanUrl: ${elements.length} elements on ${pageUrl}`);
        return { ok: true, action, sessionId, result: { title: pageTitle, url: pageUrl, elements }, executionTime: Date.now() - startTime };
      } finally {
        try { await isolatedBrowser.close(); } catch (_) {}
      }
    }

    // ── scanSite ──────────────────────────────────────────────────────────────
    // Headlessly navigates to a URL and extracts interactive elements.
    // NOTE: Prefer scanUrl for guide plan prescans — it uses an isolated context.
    // Args: url (required), timeoutMs (default 15000)
    if (action === 'scanSite') {
      if (!url) return { ok: false, error: 'url is required for scanSite' };
      const { chromium } = require('playwright');
      const scanBrowser = await chromium.launch({ headless: true });
      let scanResult = null;
      try {
        const scanContext = await scanBrowser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const scanPage = await scanContext.newPage();
        scanPage.setDefaultTimeout(timeoutMs || 15000);
        const response = await scanPage.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 15000 });

        const httpStatus = response ? response.status() : 0;
        if (httpStatus >= 400) {
          logger.warn(`[browser.act] scanSite: ${url} returned HTTP ${httpStatus} — skipping scan`);
          await scanContext.close();
          return { ok: false, error: `HTTP ${httpStatus}`, action, sessionId, url, executionTime: Date.now() - startTime };
        }

        await scanPage.waitForTimeout(1500);
        const elements = await extractPageElements(scanPage);
        const pageTitle = await scanPage.title();
        const pageUrl = scanPage.url();
        await scanContext.close();

        scanResult = { title: pageTitle, url: pageUrl, elements };
        logger.info(`[browser.act] scanSite found ${elements.length} interactive elements on ${pageUrl}`);
      } finally {
        try { await scanBrowser.close(); } catch (_) {}
      }
      return { ok: true, action, sessionId, result: scanResult, url, executionTime: Date.now() - startTime };
    }

    // ── waitForAuth ───────────────────────────────────────────────────────────
    // Navigates to a URL using a persistent profile context. If the page is a
    // login/auth page, waits for the user to complete login manually (up to
    // authTimeoutMs). Once the success URL pattern is detected, returns ok:true
    // so the plan can continue. On subsequent runs the session is already logged
    // in and this step completes instantly.
    //
    // Args:
    //   url            — the site to open (e.g. 'https://mail.google.com')
    //   profile        — profile name for persistent storage (e.g. 'gmail')
    //   authSuccessUrl — URL substring that confirms login (e.g. 'mail.google.com/mail')
    //   authTimeoutMs  — max wait for user login in ms (default: 300000 = 5 min)
    if (action === 'waitForAuth') {
      if (!url) return { ok: false, error: 'url is required for waitForAuth' };
      if (!profile) return { ok: false, error: 'profile is required for waitForAuth' };

      const profileName = profile;
      const successPattern = authSuccessUrl || url;
      const maxWait = authTimeoutMs || 300000; // 5 minutes default

      logger.info(`[browser.act] waitForAuth: profile=${profileName} url=${url} successPattern=${successPattern}`);

      // Get or create persistent context for this profile
      const { context: pCtx, userDataDir } = await getPersistentContext(profileName);

      // Reuse or create a page for this sessionId
      let page;
      if (sessions.has(sessionId)) {
        try {
          page = sessions.get(sessionId).page;
          page.url(); // verify alive
        } catch (_) {
          sessions.delete(sessionId);
          page = null;
        }
      }
      if (!page) {
        page = await pCtx.newPage();
        page.setDefaultTimeout(timeoutMs);
        sessions.set(sessionId, { page, lastUsed: Date.now(), contextKey: userDataDir });
      }

      // Navigate to the target URL
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      } catch (navErr) {
        logger.warn(`[browser.act] waitForAuth: navigation error (may be redirect): ${navErr.message}`);
      }

      const currentUrl = page.url();
      logger.info(`[browser.act] waitForAuth: landed on ${currentUrl}`);

      // Check if already authenticated (URL matches success pattern)
      if (currentUrl.includes(successPattern)) {
        logger.info(`[browser.act] waitForAuth: already authenticated (${currentUrl})`);
        return {
          ok: true,
          action,
          sessionId,
          url: currentUrl,
          title: await page.title().catch(() => ''),
          alreadyAuthenticated: true,
          executionTime: Date.now() - startTime
        };
      }

      // Not authenticated — wait for user to log in manually
      logger.info(`[browser.act] waitForAuth: login required — waiting up to ${maxWait}ms for user`);

      const deadline = Date.now() + maxWait;
      let authenticated = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        let pollUrl = '';
        try { pollUrl = page.url(); } catch (_) { break; }
        if (pollUrl.includes(successPattern)) {
          authenticated = true;
          logger.info(`[browser.act] waitForAuth: login detected — URL: ${pollUrl}`);
          break;
        }
      }

      if (!authenticated) {
        return {
          ok: false,
          action,
          sessionId,
          error: `Authentication timed out after ${maxWait}ms. User did not complete login to ${url}.`,
          executionTime: Date.now() - startTime
        };
      }

      const finalUrl = page.url();
      return {
        ok: true,
        action,
        sessionId,
        url: finalUrl,
        title: await page.title().catch(() => ''),
        alreadyAuthenticated: false,
        executionTime: Date.now() - startTime
      };
    }

    const session = await getSession(sessionId, timeoutMs, profile);
    const { page } = session;
    page.setDefaultTimeout(timeoutMs);

    let result;

    switch (action) {
      // ── navigate ──────────────────────────────────────────────────────────
      case 'navigate': {
        if (!url) return { ok: false, error: 'url is required for navigate' };
        await page.bringToFront();
        await page.goto(url, { waitUntil, timeout: timeoutMs });
        break;
      }

      // ── back / forward / reload ───────────────────────────────────────────
      case 'back': {
        await page.goBack({ waitUntil, timeout: timeoutMs });
        break;
      }
      case 'forward': {
        await page.goForward({ waitUntil, timeout: timeoutMs });
        break;
      }
      case 'reload': {
        await page.reload({ waitUntil, timeout: timeoutMs });
        break;
      }

      // ── click ─────────────────────────────────────────────────────────────
      case 'click': {
        if (!selector) return { ok: false, error: 'selector is required for click' };
        const clickOpts = { button, clickCount, timeout: timeoutMs };
        if (position) clickOpts.position = position;
        await page.locator(selector).first().click(clickOpts);
        break;
      }

      // ── hover ─────────────────────────────────────────────────────────────
      case 'hover': {
        if (!selector) return { ok: false, error: 'selector is required for hover' };
        await page.locator(selector).first().hover({ timeout: timeoutMs });
        break;
      }

      // ── type ──────────────────────────────────────────────────────────────
      case 'type': {
        if (text === undefined || text === null) return { ok: false, error: 'text is required for type' };
        await typeWithTokens(page, selector, String(text), delay, clear);
        break;
      }

      // ── keyboard ──────────────────────────────────────────────────────────
      case 'keyboard': {
        if (!key) return { ok: false, error: 'key is required for keyboard' };
        await page.keyboard.press(key);
        break;
      }

      // ── screenshot ────────────────────────────────────────────────────────
      case 'screenshot': {
        const screenshotOpts = { fullPage, timeout: timeoutMs };
        if (clip) screenshotOpts.clip = clip;
        if (screenshotPath) {
          screenshotOpts.path = screenshotPath;
          await page.screenshot(screenshotOpts);
          result = screenshotPath;
        } else {
          const buf = await page.screenshot(screenshotOpts);
          result = buf.toString('base64');
        }
        break;
      }

      // ── waitForSelector ───────────────────────────────────────────────────
      case 'waitForSelector': {
        if (!selector) return { ok: false, error: 'selector is required for waitForSelector' };
        await page.locator(selector).first().waitFor({ state, timeout: timeoutMs });
        break;
      }

      // ── waitForNavigation ─────────────────────────────────────────────────
      case 'waitForNavigation': {
        await page.waitForLoadState(waitUntil === 'networkidle' ? 'networkidle' : 'load', { timeout: timeoutMs });
        break;
      }

      // ── sleep ─────────────────────────────────────────────────────────────
      // Wait N milliseconds in Node.js (not browser context).
      // Args: delay (ms, default 2000)
      case 'sleep': {
        const sleepMs = args.delay || args.ms || 2000;
        await new Promise(r => setTimeout(r, sleepMs));
        result = `slept ${sleepMs}ms`;
        break;
      }

      // ── waitForContent ────────────────────────────────────────────────────
      // Generic wait: polls page text every pollMs until it stops growing
      // (2 consecutive stable checks). Works on any streaming AI response,
      // search results page, or dynamically loaded content.
      // Args:
      //   minLength?  (default 800)  — minimum chars before stability check starts
      //   pollMs?     (default 2000) — polling interval in ms
      //   stableFor?  (default 3)    — number of consecutive stable polls to confirm done
      //   timeoutMs?  (default 60000)— give up after this many ms
      //   selector?   (optional)     — scope to a specific element instead of full page
      case 'waitForContent': {
        const minLength  = args.minLength  || 800;
        const pollMs     = args.pollMs     || 2000;
        const stableFor  = args.stableFor  || 3;
        const maxWait    = timeoutMs       || 60000;

        const getLen = async () => {
          try {
            if (selector) {
              return (await page.locator(selector).first().innerText({ timeout: 3000 })).length;
            }
            return await page.evaluate(() => {
              const main = document.querySelector('main') ||
                           document.querySelector('article') ||
                           document.querySelector('[role="main"]') ||
                           document.body;
              return (main ? main.innerText : document.body.innerText).trim().length;
            });
          } catch (_) { return 0; }
        };

        const deadline = Date.now() + maxWait;
        let lastLen = 0;
        let stableCount = 0;
        let elapsed = 0;

        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, pollMs));
          elapsed += pollMs;
          const curLen = await getLen();
          if (curLen >= minLength && curLen === lastLen) {
            stableCount++;
            if (stableCount >= stableFor) break;
          } else {
            stableCount = 0;
          }
          lastLen = curLen;
        }

        result = `content stable after ${elapsed}ms (${lastLen} chars)`;
        break;
      }

      // ── evaluate ──────────────────────────────────────────────────────────
      case 'evaluate': {
        if (!expression) return { ok: false, error: 'expression is required for evaluate' };
        result = await page.evaluate(expression);
        break;
      }

      // ── waitForTrigger ────────────────────────────────────────────────────
      // Event-driven, CSP-safe wait. __tdTrigger is bound once per session in
      // getSession() via page.exposeBinding (CDP channel, not eval — immune to
      // Facebook/Google CSP). Each step sets session.triggerResolver to a new
      // Promise resolve function. When the user interacts with the highlighted
      // element, the page calls window.__tdTrigger() → binding fires → resolver
      // called → this Promise resolves. No rebinding, no eval, no polling.
      case 'waitForTrigger': {
        const wftTimeout = args.timeoutMs || timeoutMs || 300000;
        const wftSession = sessions.get(sessionId);
        if (!wftSession) return { ok: false, error: 'session not found for waitForTrigger' };
        wftSession.guideActive = true;
        // Null out any stale resolver and record arm time BEFORE awaiting the Promise.
        wftSession.triggerResolver = null;
        wftSession.triggerArmTime = Date.now();
        logger.info(`[browser.act] waitForTrigger: armed at ${wftSession.triggerArmTime} url=${page.url()}`);
        let navListener = null;
        try {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              wftSession.triggerResolver = null;
              resolve('timeout');
            }, wftTimeout);

            // Store resolver — the exposeBinding callback (set in getSession) will call it.
            // Set AFTER triggerArmTime so the 300ms grace window is measured from now.
            wftSession.triggerResolver = (reason) => {
              clearTimeout(timer);
              resolve(reason);
            };

            // Resolve if page navigates to a DIFFERENT path (not a hash/fragment change).
            // Facebook and other SPAs fire framenavigated on every hash change — we must
            // ignore those or the guide auto-advances every few seconds.
            // Use page.on (not page.once) so a single hash-change doesn't consume the listener.
            const urlBeforeWait = page.url();
            const stripHash = (u) => { try { const p = new URL(u); return p.origin + p.pathname + p.search; } catch(_) { return u; } };
            navListener = () => {
              const newUrl = page.url();
              const before = stripHash(urlBeforeWait);
              const after = stripHash(newUrl);
              logger.info(`[browser.act] framenavigated: before=${before} after=${after} changed=${before !== after}`);
              if (before !== after) {
                page.off('framenavigated', navListener);
                navListener = null;
                if (wftSession.triggerResolver) {
                  wftSession.triggerResolver = null;
                  clearTimeout(timer);
                  resolve('navigated');
                }
              }
              // else: hash-only change — ignore, keep waiting for user input
            };
            page.on('framenavigated', navListener);
          });
        } finally {
          wftSession.guideActive = false;
          wftSession.triggerResolver = null;
          if (navListener) { try { page.off('framenavigated', navListener); } catch(_) {} navListener = null; }
        }
        result = true;
        break;
      }

      // ── scroll ────────────────────────────────────────────────────────────
      case 'scroll': {
        if (selector) {
          await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: timeoutMs });
        } else {
          await page.mouse.wheel(scrollX, scrollY);
        }
        break;
      }

      // ── select (dropdown) ─────────────────────────────────────────────────
      case 'select': {
        if (!selector) return { ok: false, error: 'selector is required for select' };
        const selectOpts = {};
        if (value !== undefined) selectOpts.value = Array.isArray(value) ? value : [value];
        if (label !== undefined) selectOpts.label = Array.isArray(label) ? label : [label];
        result = await page.locator(selector).first().selectOption(selectOpts, { timeout: timeoutMs });
        break;
      }

      // ── getText ───────────────────────────────────────────────────────────
      case 'getText': {
        if (!selector) return { ok: false, error: 'selector is required for getText' };
        result = await page.locator(selector).first().innerText({ timeout: timeoutMs });
        break;
      }

      // ── getPageText ───────────────────────────────────────────────────────
      // Smart full-page text extraction for comparison/synthesis tasks.
      // Strips nav, footer, scripts, ads — returns meaningful body content.
      // Args: maxChars? (default 4000), selector? (override to specific element)
      case 'getPageText': {
        const maxChars = args.maxChars || 4000;
        if (selector) {
          result = await page.locator(selector).first().innerText({ timeout: timeoutMs });
        } else {
          result = await page.evaluate(() => {
            // Remove chrome/noise elements before extracting — generic structural selectors only
            const remove = [
              'nav', 'footer', 'header', 'script', 'style', 'noscript', 'aside',
              '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]',
              '[role="dialog"]', '[role="alertdialog"]',
              '.cookie-banner', '.ad', '.advertisement', '#cookie', '#banner',
            ];
            remove.forEach(sel => {
              try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (_) {}
            });

            // Prefer semantic content containers — generic, works on any site
            const answerSelectors = [
              'main', 'article', '[role="main"]', '[role="article"]',
            ];
            for (const sel of answerSelectors) {
              try {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                  // Concatenate all matching elements (e.g. multiple assistant turns)
                  const text = Array.from(els).map(el => el.innerText.trim()).filter(Boolean).join('\n\n');
                  if (text.length > 100) return text.replace(/\n{3,}/g, '\n\n').trim();
                }
              } catch (_) {}
            }
            // Fallback: full body
            return document.body.innerText.replace(/\n{3,}/g, '\n\n').trim();
          });
        }
        if (typeof result === 'string' && result.length > maxChars) {
          result = result.substring(0, maxChars) + '…';
        }
        break;
      }

      // ── getAttribute ──────────────────────────────────────────────────────
      case 'getAttribute': {
        if (!selector) return { ok: false, error: 'selector is required for getAttribute' };
        if (!attribute) return { ok: false, error: 'attribute is required for getAttribute' };
        result = await page.locator(selector).first().getAttribute(attribute, { timeout: timeoutMs });
        break;
      }

      // ── newPage ───────────────────────────────────────────────────────────
      case 'newPage': {
        const newPage = await session.context.newPage();
        newPage.setDefaultTimeout(timeoutMs);
        session.page = newPage;
        break;
      }

      // ── discoverInputs ────────────────────────────────────────────────────
      // Returns a ranked list of all interactable inputs on the page.
      // Use this when you don't know the selector — inspect the result and
      // then use the correct selector in a follow-up type/click step.
      case 'discoverInputs': {
        result = await page.evaluate(() => {
          const score = (el) => {
            let s = 0;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return -1; // hidden
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return -1;
            if (rect.top >= 0 && rect.top < window.innerHeight) s += 10; // in viewport
            if (el.getAttribute('autofocus') !== null) s += 5;
            if (el.getAttribute('placeholder')) s += 3;
            if (el.getAttribute('aria-label')) s += 2;
            if (el.id) s += 1;
            return s;
          };

          const inputs = [];
          const seen = new Set();

          const add = (el) => {
            if (seen.has(el)) return;
            seen.add(el);
            const s = score(el);
            if (s < 0) return;
            const rect = el.getBoundingClientRect();
            inputs.push({
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || null,
              id: el.id || null,
              name: el.getAttribute('name') || null,
              placeholder: el.getAttribute('placeholder') || null,
              ariaLabel: el.getAttribute('aria-label') || null,
              contenteditable: el.getAttribute('contenteditable') || null,
              role: el.getAttribute('role') || null,
              classes: el.className ? el.className.split(' ').filter(Boolean).slice(0, 5) : [],
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              score: s
            });
          };

          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])').forEach(add);
          document.querySelectorAll('textarea').forEach(add);
          document.querySelectorAll('[contenteditable]:not([contenteditable="false"])').forEach(add);

          return inputs.sort((a, b) => b.score - a.score).slice(0, 10);
        });
        break;
      }

      // ── getPageSnapshot ───────────────────────────────────────────────────
      // Returns a compact summary of the current page state for LLM recovery:
      // visible inputs (id, name, aria-label, placeholder), visible buttons
      // (aria-label, text), current URL, and page title.
      // Used by recoverSkill to give the LLM real DOM evidence before replanning.
      // Args: maxChars? (default 1200)
      case 'getPageSnapshot': {
        const maxSnapChars = args.maxChars || 1200;
        const snapshot = await page.evaluate(() => {
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
              && rect.top < window.innerHeight && rect.bottom > 0;
          };

          // Visible inputs
          const inputs = [];
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, [contenteditable]:not([contenteditable="false"])').forEach(el => {
            if (!isVisible(el)) return;
            const desc = [
              el.id ? `id="${el.id}"` : null,
              el.getAttribute('name') ? `name="${el.getAttribute('name')}"` : null,
              el.getAttribute('aria-label') ? `aria-label="${el.getAttribute('aria-label')}"` : null,
              el.getAttribute('placeholder') ? `placeholder="${el.getAttribute('placeholder')}"` : null,
              el.getAttribute('contenteditable') ? `contenteditable` : null,
              el.value ? `value="${String(el.value).substring(0, 40)}"` : null,
            ].filter(Boolean).join(', ');
            inputs.push(`  <${el.tagName.toLowerCase()} ${desc}>`);
          });

          // Visible buttons and clickable elements
          const buttons = [];
          document.querySelectorAll('button, [role="button"], a[href]').forEach(el => {
            if (!isVisible(el)) return;
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText?.trim().substring(0, 60) || '';
            if (!label) return;
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            buttons.push(`  <${role} "${label}">`);
          });

          return {
            url: window.location.href,
            title: document.title.substring(0, 80),
            inputs: inputs.slice(0, 10),
            buttons: buttons.slice(0, 15),
          };
        });

        const lines = [
          `URL: ${snapshot.url}`,
          `Title: ${snapshot.title}`,
          `Visible inputs (${snapshot.inputs.length}):`,
          snapshot.inputs.length ? snapshot.inputs.join('\n') : '  (none)',
          `Visible buttons/links (${snapshot.buttons.length}):`,
          snapshot.buttons.length ? snapshot.buttons.join('\n') : '  (none)',
        ].join('\n');

        result = lines.substring(0, maxSnapChars);
        break;
      }

      // ── smartType ─────────────────────────────────────────────────────────
      // Auto-discovers the best visible input on the page and types into it.
      // Use when you don't know the exact selector — works for input, textarea,
      // and contenteditable divs (ChatGPT, Notion, Slack web, etc.).
      // Args: text (required), hint (optional keyword to prefer matching inputs)
      case 'smartType': {
        if (text === undefined || text === null) return { ok: false, error: 'text is required for smartType' };

        const hint = (args.hint || '').toLowerCase();

        // Scoring function (shared between retry attempts)
        const discoverCandidates = () => page.evaluate(() => {
          const score = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return -1;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return -1;
            let s = 0;
            if (rect.top >= 0 && rect.top < window.innerHeight) s += 10;
            if (el.getAttribute('autofocus') !== null) s += 5;
            if (el.getAttribute('placeholder')) s += 3;
            if (el.getAttribute('aria-label')) s += 2;
            if (el.id) s += 1;
            // Penalize login/auth fields — search boxes should always win
            const t = (el.getAttribute('type') || '').toLowerCase();
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            const nm = (el.getAttribute('name') || '').toLowerCase();
            const isAuthField = t === 'email' || t === 'password' || t === 'tel' ||
              ph.includes('email') || ph.includes('password') || ph.includes('sign in') ||
              al.includes('email') || al.includes('password') ||
              nm === 'email' || nm === 'password';
            if (isAuthField) s -= 20;
            return s;
          };
          const results = [];
          const seen = new Set();
          const add = (el) => {
            if (seen.has(el)) return;
            seen.add(el);
            const s = score(el);
            if (s < 0) return;
            results.push({
              tag: el.tagName.toLowerCase(),
              id: el.id || null,
              name: el.getAttribute('name') || null,
              placeholder: el.getAttribute('placeholder') || null,
              ariaLabel: el.getAttribute('aria-label') || null,
              contenteditable: el.getAttribute('contenteditable') || null,
              score: s
            });
          };
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])').forEach(add);
          document.querySelectorAll('textarea').forEach(add);
          document.querySelectorAll('[contenteditable]:not([contenteditable="false"])').forEach(add);
          return results.sort((a, b) => b.score - a.score);
        }); // end discoverCandidates

        // Retry loop: SPAs (Perplexity, Notion, etc.) render inputs after JS hydration.
        // Poll up to 5 times with 1s delay until a positive-score candidate appears.
        let candidates = await discoverCandidates();
        const hasGoodCandidate = (list) => list.some(c => c.score > 0);
        let retries = 0;
        while (!hasGoodCandidate(candidates) && retries < 5) {
          logger.info(`[browser.act] smartType: no good input yet, waiting 1s (attempt ${retries + 1}/5)`);
          await new Promise(r => setTimeout(r, 1000));
          candidates = await discoverCandidates();
          retries++;
        }

        if (!candidates.length || !hasGoodCandidate(candidates)) {
          // Grab a short page text snippet so recoverSkill can detect login/blocked pages
          let pageContext = '';
          try {
            pageContext = await page.evaluate(() => {
              const el = document.querySelector('main') || document.querySelector('article') || document.body;
              return (el ? el.innerText : document.body.innerText).trim().substring(0, 400);
            });
          } catch (_) {}
          return { ok: false, error: 'smartType: no visible input elements found on the page after waiting', pageContext, action, sessionId, url: page.url(), executionTime: Date.now() - startTime };
        }

        // Pick best candidate — prefer one matching the hint keyword
        let best = candidates[0];
        if (hint) {
          const hinted = candidates.find(c =>
            (c.placeholder || '').toLowerCase().includes(hint) ||
            (c.ariaLabel || '').toLowerCase().includes(hint) ||
            (c.id || '').toLowerCase().includes(hint) ||
            (c.name || '').toLowerCase().includes(hint)
          );
          if (hinted) best = hinted;
        }

        // Build a reliable CSS selector for the chosen element
        // CSS.escape is browser-only — use a safe manual fallback for Node.js
        const cssEscape = (str) => str.replace(/([\0-\x1f\x7f]|^-?\d|^-$|[^\w-])/g, (c) => `\\${c}`);
        let resolvedSelector;
        if (best.id) {
          resolvedSelector = `#${cssEscape(best.id)}`;
        } else if (best.name && !best.id) {
          resolvedSelector = `${best.tag}[name="${best.name}"]`;
        } else if (best.placeholder) {
          resolvedSelector = best.contenteditable
            ? `[contenteditable][placeholder="${best.placeholder}"]`
            : `${best.tag}[placeholder="${best.placeholder}"]`;
        } else if (best.ariaLabel) {
          resolvedSelector = `[aria-label="${best.ariaLabel}"]`;
        } else if (best.contenteditable) {
          resolvedSelector = `[contenteditable]:not([contenteditable="false"])`;
        } else {
          resolvedSelector = best.tag;
        }

        logger.info(`[browser.act] smartType: resolved selector="${resolvedSelector}" (tag=${best.tag}, hint="${hint}")`);

        // Always clear before typing when text is long (avoids accumulation on retry)
        const effectiveClear = clear || String(text).length > 200;
        await typeWithTokens(page, resolvedSelector, String(text), delay, effectiveClear);
        result = { usedSelector: resolvedSelector, candidate: best };
        break;
      }

      // ── smartFill ─────────────────────────────────────────────────────────
      // Inspects the live DOM to identify To, Subject, and Body fields in any
      // compose window, then fills them — works for any webmail provider.
      // No hardcoded selectors needed. Uses attribute heuristics, not LLM.
      //
      // Args:
      //   to:      string  — recipient email address (appends {TAB} to confirm chip)
      //   subject: string  — subject line
      //   body:    string  — email body text
      //   sessionId: string
      case 'smartFill': {
        const toText      = args.to      || null;
        const subjectText = args.subject || null;
        const bodyText    = args.body    || null;

        if (!toText && !subjectText && !bodyText) {
          return { ok: false, error: 'smartFill requires at least one of: to, subject, body' };
        }

        // ── Step 1: Inspect the DOM — collect all visible interactable fields ──
        const fields = await page.evaluate(() => {
          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
              && rect.top < window.innerHeight && rect.bottom > 0;
          };

          const results = [];
          const seen = new Set();

          const add = (el) => {
            if (seen.has(el)) return;
            seen.add(el);
            if (!isVisible(el)) return;
            const rect = el.getBoundingClientRect();
            results.push({
              tag:             el.tagName.toLowerCase(),
              id:              el.id || null,
              name:            el.getAttribute('name') || null,
              type:            el.getAttribute('type') || null,
              placeholder:     el.getAttribute('placeholder') || null,
              ariaLabel:       el.getAttribute('aria-label') || null,
              dataTestId:      el.getAttribute('data-testid') || null,
              contenteditable: el.getAttribute('contenteditable') || null,
              role:            el.getAttribute('role') || null,
              value:           el.value ? String(el.value).substring(0, 60) : null,
              y:               Math.round(rect.top),   // vertical position for ordering
            });
          };

          document.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="search"]):not([type="password"]), textarea, [contenteditable]:not([contenteditable="false"])'
          ).forEach(add);

          return results.sort((a, b) => a.y - b.y); // top-to-bottom order
        });

        logger.info(`[browser.act] smartFill: discovered ${fields.length} fields`);
        logger.debug(`[browser.act] smartFill fields: ${JSON.stringify(fields.map(f => ({ tag: f.tag, name: f.name, ariaLabel: f.ariaLabel, placeholder: f.placeholder, dataTestId: f.dataTestId, y: f.y })))}`);

        // ── Step 2: Map fields to roles via attribute heuristics ──────────────
        const score = (field, role) => {
          let s = 0;
          const al  = (field.ariaLabel   || '').toLowerCase();
          const ph  = (field.placeholder || '').toLowerCase();
          const nm  = (field.name        || '').toLowerCase();
          const tid = (field.dataTestId  || '').toLowerCase();
          const id  = (field.id          || '').toLowerCase();

          if (role === 'to') {
            if (al === 'to' || al === 'to recipients')             s += 30; // exact match
            if (al.includes('to') || al.includes('recipient'))     s += 20;
            if (ph.includes('to') || ph.includes('recipient'))     s += 15;
            if (nm === 'to' || nm.includes('recipient'))           s += 15;
            if (tid.includes('to') || tid.includes('recipient'))   s += 15;
            if (id.includes('to') || id.includes('recipient'))     s += 10;
            if (field.type === 'email')                            s += 5;  // email inputs likely to/cc fields
            // Penalise search boxes hard
            if (nm === 'q' || al.includes('search') || ph.includes('search') || id === 'gbqfq') s -= 50;
          } else if (role === 'subject') {
            if (al.includes('subject'))                            s += 20;
            if (ph.includes('subject'))                            s += 15;
            if (nm === 'subjectbox' || nm.includes('subject'))     s += 20;
            if (tid.includes('subject'))                           s += 15;
            if (id.includes('subject'))                            s += 10;
          } else if (role === 'body') {
            if (al.includes('body') || al.includes('message'))     s += 20;
            if (ph.includes('body') || ph.includes('message'))     s += 15;
            if (field.contenteditable)                             s += 10;
            if (field.tag === 'textarea')                          s += 8;
            if (tid.includes('body') || tid.includes('editor') || tid.includes('rooster')) s += 15;
            if (id.includes('body') || id.includes('editor'))     s += 10;
          }
          return s;
        };

        const bestFor = (role) => {
          let best = null, bestScore = -Infinity;
          for (const f of fields) {
            const s = score(f, role);
            if (s > bestScore) { bestScore = s; best = f; }
          }
          return bestScore >= 0 && best ? best : null;
        };

        const toField      = toText      ? bestFor('to')      : null;
        const subjectField = subjectText ? bestFor('subject')  : null;
        const bodyField    = bodyText    ? bestFor('body')     : null;

        // ── Step 3: Build CSS selectors for each matched field ─────────────────
        const cssEscape = (str) => str.replace(/([\0-\x1f\x7f]|^-?\d|^-$|[^\w-])/g, (c) => `\\${c}`);
        const selectorFor = (f) => {
          if (!f) return null;
          if (f.id)              return `#${cssEscape(f.id)}`;
          if (f.name)            return `${f.tag}[name="${f.name}"]`;
          if (f.ariaLabel)       return `[aria-label="${f.ariaLabel}"]`;
          if (f.dataTestId)      return `[data-testid="${f.dataTestId}"]`;
          if (f.placeholder)     return f.contenteditable
            ? `[contenteditable][placeholder="${f.placeholder}"]`
            : `${f.tag}[placeholder="${f.placeholder}"]`;
          if (f.contenteditable) return `[contenteditable]:not([contenteditable="false"])`;
          return f.tag;
        };

        const toSel      = selectorFor(toField);
        const subjectSel = selectorFor(subjectField);
        const bodySel    = selectorFor(bodyField);

        logger.info(`[browser.act] smartFill resolved — to: "${toSel}", subject: "${subjectSel}", body: "${bodySel}"`);

        const filled = [];
        const skipped = [];
        const errors = [];

        // ── Helper: read current value of a field (handles input, textarea, contenteditable) ──
        const readFieldValue = async (sel) => {
          try {
            return await page.evaluate((selector) => {
              const el = document.querySelector(selector);
              if (!el) return null;
              if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
              // contenteditable — return innerText
              return el.innerText || el.textContent || '';
            }, sel);
          } catch (_) { return null; }
        };

        // ── Helper: check if Gmail-style recipient chips already contain this address ──
        const recipientChipExists = async (email) => {
          try {
            return await page.evaluate((addr) => {
              // Gmail renders confirmed recipients as chips with data-hovercard-id or aria-label
              const chips = document.querySelectorAll('[data-hovercard-id], .vR span[email], .afV [email]');
              for (const chip of chips) {
                const chipEmail = chip.getAttribute('data-hovercard-id') || chip.getAttribute('email') || chip.textContent || '';
                if (chipEmail.toLowerCase().includes(addr.toLowerCase())) return true;
              }
              return false;
            }, email);
          } catch (_) { return false; }
        };

        // ── Step 4: Fill each field — skip if already correct, clear if wrong ─────
        if (toText && toSel) {
          try {
            // Check for existing recipient chip first (Gmail confirms chips on TAB/Enter)
            const chipAlreadyExists = await recipientChipExists(toText);
            if (chipAlreadyExists) {
              skipped.push(`to — already confirmed as chip`);
              logger.info(`[browser.act] smartFill: skipping "to" — recipient chip already exists`);
            } else {
              // Check raw input value
              const currentVal = await readFieldValue(toSel);
              const normalised = (currentVal || '').trim().toLowerCase();
              const targetNorm = toText.trim().toLowerCase();
              if (normalised && normalised.includes(targetNorm)) {
                skipped.push(`to — already filled`);
                logger.info(`[browser.act] smartFill: skipping "to" — already contains "${currentVal}"`);
              } else {
                // Clear if has stale/partial content, then type
                const needsClear = normalised.length > 0;
                await typeWithTokens(page, toSel, `${toText}{TAB}`, delay, needsClear);
                filled.push(`to → ${toSel}`);
              }
            }
          } catch (e) { errors.push(`to: ${e.message}`); }
        } else if (toText) {
          errors.push('to: no matching field found in DOM');
        }

        if (subjectText && subjectSel) {
          try {
            const currentVal = await readFieldValue(subjectSel);
            const normalised = (currentVal || '').trim().toLowerCase();
            const targetNorm = subjectText.trim().toLowerCase();
            if (normalised && normalised === targetNorm) {
              skipped.push(`subject — already filled`);
              logger.info(`[browser.act] smartFill: skipping "subject" — already contains "${currentVal}"`);
            } else {
              const needsClear = normalised.length > 0;
              await typeWithTokens(page, subjectSel, subjectText, delay, needsClear);
              filled.push(`subject → ${subjectSel}`);
            }
          } catch (e) { errors.push(`subject: ${e.message}`); }
        } else if (subjectText) {
          errors.push('subject: no matching field found in DOM');
        }

        if (bodyText && bodySel) {
          try {
            const currentVal = await readFieldValue(bodySel);
            const normalised = (currentVal || '').trim();
            const targetNorm = bodyText.trim();
            if (normalised && normalised === targetNorm) {
              skipped.push(`body — already filled`);
              logger.info(`[browser.act] smartFill: skipping "body" — already filled`);
            } else {
              const needsClear = normalised.length > 0;
              await page.locator(bodySel).first().click({ timeout: timeoutMs });
              await typeWithTokens(page, bodySel, bodyText, delay, needsClear);
              filled.push(`body → ${bodySel}`);
            }
          } catch (e) { errors.push(`body: ${e.message}`); }
        } else if (bodyText) {
          errors.push('body: no matching field found in DOM');
        }

        if (errors.length && !filled.length) {
          return { ok: false, error: errors.join('; '), fields: fields.map(f => ({ tag: f.tag, name: f.name, ariaLabel: f.ariaLabel, placeholder: f.placeholder })) };
        }

        result = { filled, skipped: skipped.length ? skipped : undefined, errors: errors.length ? errors : undefined, selectors: { to: toSel, subject: subjectSel, body: bodySel } };
        break;
      }

      // ── highlight ─────────────────────────────────────────────────────────
      // Injects a premium conic-gradient spinning border glow around a selector.
      // Used by guide.step to visually point at elements the user needs to interact with.
      // The glow uses a rotating conic-gradient + outer diffuse bloom — same visual
      // language as the ThinkDrop ResultsWindow border glow.
      //
      // When `instruction` is provided, also renders an AI speech bubble inside
      // the browser page showing what the user needs to do.
      //
      // When `trigger=true`, attaches a blur/change/click listener (per element type)
      // that calls window.__tdTrigger() — a CDP binding that resolves the guide.step wait.
      //
      // Args:
      //   selector    — CSS selector of element to highlight
      //   label       — short floating badge text (e.g. "Click here")
      //   instruction — full instruction text shown in AI speech bubble
      //   color       — primary glow color (default: '#818cf8' indigo-400)
      //   trigger     — if true, attaches event listener that calls window.__tdTrigger()
      //   clear       — if true, removes all highlights without adding a new one
      case 'highlight': {
        await page.bringToFront();
        const hlColor = args.color || '#818cf8';
        const hlLabel = args.label || null;
        const hlInstruction = args.instruction || null;
        const hlTrigger = args.trigger !== false; // default true
        const hlClear = args.clear === true;

        // If no CSS selector provided but label is, resolve it via DOM fuzzy text search
        let resolvedSelector = selector || null;

        // Convert Playwright text= selectors to CSS — document.querySelector only accepts CSS.
        // text="exact" → find element by text via Playwright locator and tag it with data-td-target.
        if (resolvedSelector && resolvedSelector.startsWith('text=') && !hlClear) {
          try {
            const textSel = resolvedSelector;
            const locator = page.locator(textSel).first();
            const isVis = await locator.isVisible({ timeout: 3000 }).catch(() => false);
            if (isVis) {
              await locator.evaluate(el => el.setAttribute('data-td-target', '1')).catch(() => {});
              resolvedSelector = '[data-td-target="1"]';
            } else {
              resolvedSelector = null; // fall through to fuzzy search
            }
          } catch (_) {
            resolvedSelector = null;
          }
        }

        if (!resolvedSelector && hlLabel && !hlClear) {
          resolvedSelector = await page.evaluate((labelText) => {
            // Tokenize: lowercase words only, strip punctuation
            const tokenize = (s) => s.toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
            const queryTokens = tokenize(labelText);
            // Remove trailing UI-type words from query tokens
            const UI_WORDS = new Set(['button','link','tab','icon','field','input','checkbox','dropdown','menu','item','row','section','panel','card','header','footer','badge','label','text','image','img','svg','div','span','online','here','click','the','a','an','in','on','at','to','for','of','and','or','your','my','our','their','its','this','that','these','those','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','need','dare','ought','used']);
            const keyTokens = queryTokens.filter(w => !UI_WORDS.has(w));
            if (!keyTokens.length) keyTokens.push(...queryTokens.slice(0, 3)); // fallback: use first 3 tokens

            // Score an element's own visible text (not children) against keyTokens
            const ownText = (el) => Array.from(el.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
            const score = (el) => {
              // Use own text first (avoids container elements scoring high from child text)
              const own = ownText(el).trim();
              const elTokens = tokenize(own.length > 2 ? own : (el.textContent || ''));
              if (!elTokens.length) return 0;
              const matches = keyTokens.filter(qt => elTokens.some(et => et.includes(qt) || qt.includes(et)));
              return matches.length / keyTokens.length;
            };

            // For submit-like labels, first try form-scoped buttons/inputs to avoid
            // matching nav links (e.g. "Sign Up" nav link vs actual form submit button).
            const SUBMIT_WORDS = new Set(['sign','signup','submit','create','register','next','continue','save','send','join','finish','done','apply','confirm','proceed']);
            const isSubmitLabel = keyTokens.some(w => SUBMIT_WORDS.has(w));

            if (isSubmitLabel) {
              const forms = Array.from(document.querySelectorAll('form'));
              for (const form of forms) {
                const formBtns = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
                  .filter(el => el.offsetParent !== null);
                let bestForm = null, bestFormScore = 0;
                for (const el of formBtns) {
                  const s = score(el);
                  if (s > bestFormScore) { bestFormScore = s; bestForm = el; }
                }
                if (bestForm && bestFormScore >= 0.5) {
                  if (bestForm.id) return `#${CSS.escape(bestForm.id)}`;
                  if (bestForm.getAttribute('data-testid')) return `[data-testid="${bestForm.getAttribute('data-testid')}"]`;
                  bestForm.setAttribute('data-td-target', '1');
                  return '[data-td-target="1"]';
                }
              }
            }

            // Prefer leaf-level interactive elements first, then containers
            const LEAF_CANDIDATES = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label';
            const CONTAINER_CANDIDATES = 'h1, h2, h3, h4, li';
            const leafEls = Array.from(document.querySelectorAll(LEAF_CANDIDATES)).filter(el => el.offsetParent !== null);
            const containerEls = Array.from(document.querySelectorAll(CONTAINER_CANDIDATES)).filter(el => el.offsetParent !== null);
            const els = [...leafEls, ...containerEls];

            // Find best scoring visible element
            let best = null, bestScore = 0;
            for (const el of els) {
              const s = score(el);
              if (s > bestScore) { bestScore = s; best = el; }
            }

            // Require at least 50% keyword overlap
            if (best && bestScore >= 0.5) {
              if (best.id) return `#${CSS.escape(best.id)}`;
              if (best.getAttribute('data-testid')) return `[data-testid="${best.getAttribute('data-testid')}"]`;
              // Build a data attribute to uniquely identify the element
              best.setAttribute('data-td-target', '1');
              return '[data-td-target="1"]';
            }

            // Strategy 2: aria-label / placeholder / title fuzzy match
            const attrEls = Array.from(document.querySelectorAll('[aria-label],[placeholder],[title]')).filter(el => el.offsetParent !== null);
            let bestAttr = null, bestAttrScore = 0;
            for (const el of attrEls) {
              const attrs = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title')].filter(Boolean);
              for (const attr of attrs) {
                const attrTokens = tokenize(attr);
                const matches = keyTokens.filter(qt => attrTokens.some(et => et.includes(qt) || qt.includes(et)));
                const s = matches.length / keyTokens.length;
                if (s > bestAttrScore) { bestAttrScore = s; bestAttr = { el, attr }; }
              }
            }
            if (bestAttr && bestAttrScore >= 0.5) {
              const { el, attr } = bestAttr;
              if (el.id) return `#${CSS.escape(el.id)}`;
              const attrName = el.getAttribute('aria-label') === attr ? 'aria-label' : el.getAttribute('placeholder') === attr ? 'placeholder' : 'title';
              return `[${attrName}*="${attr.substring(0, 40)}"]`;
            }

            return null;
          }, hlLabel).catch(() => null);

          // Playwright text selector fallback — try key words from the label
          if (!resolvedSelector && hlLabel) {
            // Extract key words (3+ chars, not UI words)
            const UI_WORDS = new Set(['button','link','tab','icon','field','input','online','here','click','the','for','and','your']);
            const keyWords = hlLabel.toLowerCase().replace(/[''`]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !UI_WORDS.has(w));
            for (const word of keyWords) {
              const sel = `text=/${word}/i`;
              const visible = await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false);
              if (visible) { resolvedSelector = sel; break; }
            }
          }
        }

        await page.evaluate(({ sel, color, label, instruction, trigger, clearAll }) => {
          // ── Teardown: remove all existing ThinkDrop overlays ──────────────
          document.querySelectorAll('[data-td-hl]').forEach(el => el.remove());
          const oldStyle = document.getElementById('td-hl-style');
          if (oldStyle) oldStyle.remove();
          // Remove any existing click trigger
          if (window.__tdTriggerCleanup) { window.__tdTriggerCleanup(); window.__tdTriggerCleanup = null; }
          // Increment generation counter — stale click handlers from previous
          // highlight steps check this and no-op if they fire after teardown.
          window.__tdTriggerGeneration = ((window.__tdTriggerGeneration || 0) + 1);
          const myGeneration = window.__tdTriggerGeneration;

          if (clearAll) {
            // Full teardown: also strip data-td-target off real DOM elements so
            // page layout is not corrupted after automation completes.
            document.querySelectorAll('[data-td-target]').forEach(el => el.removeAttribute('data-td-target'));
            return;
          }

          // ── No-target fallback: floating speech bubble + Done button ───────────
          // When no selector was found, inject a floating overlay so the user
          // can still advance the guide by clicking "Done" (calls window.__tdTrigger()).
          if (!sel) {
            const styleEl = document.createElement('style');
            styleEl.id = 'td-hl-style';
            styleEl.textContent = `
              @keyframes td-bubble-in { from { opacity:0; transform:translateY(8px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }
              @keyframes td-badge-in  { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
            `;
            document.head.appendChild(styleEl);

            const bubble = document.createElement('div');
            bubble.setAttribute('data-td-hl', '1');
            bubble.style.cssText = `
              position:fixed; bottom:80px; right:24px;
              max-width:320px; min-width:220px;
              background:rgba(15,15,25,0.97);
              border:1px solid ${color}55; border-radius:14px;
              padding:14px 16px 12px; z-index:2147483647;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              box-shadow:0 8px 32px rgba(0,0,0,0.7), 0 0 0 1px ${color}22, 0 0 24px ${color}44;
              animation:td-bubble-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
              backdrop-filter:blur(14px);
            `;

            const aiLabel = document.createElement('div');
            aiLabel.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};`;
            aiLabel.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> ThinkDrop AI`;
            bubble.appendChild(aiLabel);

            if (label) {
              const lbl = document.createElement('div');
              lbl.style.cssText = `font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${color};margin-bottom:6px;`;
              lbl.textContent = label;
              bubble.appendChild(lbl);
            }

            if (instruction) {
              const txt = document.createElement('div');
              txt.style.cssText = `font-size:13px;line-height:1.55;color:#e5e7eb;font-weight:400;margin-bottom:12px;`;
              txt.textContent = instruction;
              bubble.appendChild(txt);
            }

            if (trigger) {
              const btn = document.createElement('button');
              btn.setAttribute('data-td-hl', '1');
              btn.style.cssText = `
                display:block; width:100%; padding:8px 0;
                background:linear-gradient(135deg,${color}dd,${color}99);
                color:#fff; font-size:12px; font-weight:700; letter-spacing:0.04em;
                border:none; border-radius:8px; cursor:pointer;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                box-shadow:0 2px 8px ${color}66;
              `;
              btn.textContent = '✓ Done — Continue';
              btn.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                if (window.__tdTriggerGeneration !== myGeneration) return;
                setTimeout(() => { document.querySelectorAll('[data-td-hl]').forEach(el => el.remove()); const s = document.getElementById('td-hl-style'); if (s) s.remove(); }, 300);
                if (typeof window.__tdTrigger === 'function') window.__tdTrigger();
              });
              bubble.appendChild(btn);
            }

            document.body.appendChild(bubble);
            return;
          }

          let target = document.querySelector(sel);
          // Clean up any temporary targeting attribute we set
          document.querySelectorAll('[data-td-target]').forEach(el => el.removeAttribute('data-td-target'));
          if (!target) {
            // Selector resolved but element not found in DOM — inject no-target bubble instead
            // (same bubble as the !sel path above, duplicated here to avoid goto)
            const styleEl2 = document.createElement('style');
            styleEl2.id = 'td-hl-style';
            styleEl2.textContent = `@keyframes td-bubble-in { from { opacity:0; transform:translateY(8px) scale(0.96); } to { opacity:1; transform:translateY(0) scale(1); } }`;
            document.head.appendChild(styleEl2);
            const bubble2 = document.createElement('div');
            bubble2.setAttribute('data-td-hl', '1');
            bubble2.style.cssText = `position:fixed;bottom:80px;right:24px;max-width:320px;min-width:220px;background:rgba(15,15,25,0.97);border:1px solid ${color}55;border-radius:14px;padding:14px 16px 12px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 8px 32px rgba(0,0,0,0.7),0 0 0 1px ${color}22,0 0 24px ${color}44;animation:td-bubble-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;backdrop-filter:blur(14px);`;
            const aiLbl2 = document.createElement('div');
            aiLbl2.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${color};`;
            aiLbl2.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> ThinkDrop AI`;
            bubble2.appendChild(aiLbl2);
            if (label) { const lbl2 = document.createElement('div'); lbl2.style.cssText = `font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${color};margin-bottom:6px;`; lbl2.textContent = label; bubble2.appendChild(lbl2); }
            if (instruction) { const txt2 = document.createElement('div'); txt2.style.cssText = `font-size:13px;line-height:1.55;color:#e5e7eb;font-weight:400;margin-bottom:12px;`; txt2.textContent = instruction; bubble2.appendChild(txt2); }
            if (trigger) {
              const btn2 = document.createElement('button');
              btn2.setAttribute('data-td-hl', '1');
              btn2.style.cssText = `display:block;width:100%;padding:8px 0;background:linear-gradient(135deg,${color}dd,${color}99);color:#fff;font-size:12px;font-weight:700;letter-spacing:0.04em;border:none;border-radius:8px;cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;box-shadow:0 2px 8px ${color}66;`;
              btn2.textContent = '✓ Done — Continue';
              btn2.addEventListener('click', (e) => {
                if (!e.isTrusted) return;
                if (window.__tdTriggerGeneration !== myGeneration) return;
                setTimeout(() => { document.querySelectorAll('[data-td-hl]').forEach(el => el.remove()); const s = document.getElementById('td-hl-style'); if (s) s.remove(); }, 300);
                if (typeof window.__tdTrigger === 'function') window.__tdTrigger();
              });
              bubble2.appendChild(btn2);
            }
            document.body.appendChild(bubble2);
            return;
          }

          // Scroll into view instantly — smooth scroll is async so getBoundingClientRect
          // would measure the pre-scroll (wrong) position. Instant scroll is synchronous.
          target.scrollIntoView({ behavior: 'instant', block: 'center' });

          // ── Inject keyframe styles ────────────────────────────────────────
          const styleEl = document.createElement('style');
          styleEl.id = 'td-hl-style';
          styleEl.textContent = `
            @keyframes td-spin {
              from { transform: translate(-50%,-50%) rotate(0deg); }
              to   { transform: translate(-50%,-50%) rotate(360deg); }
            }
            @keyframes td-bloom {
              0%,100% { opacity:0.55; transform:scale(1); }
              50%     { opacity:0.85; transform:scale(1.04); }
            }
            @keyframes td-badge-in {
              from { opacity:0; transform:translateY(6px) scale(0.92); }
              to   { opacity:1; transform:translateY(0) scale(1); }
            }
            @keyframes td-bubble-in {
              from { opacity:0; transform:translateY(10px) scale(0.95); }
              to   { opacity:1; transform:translateY(0) scale(1); }
            }
            @keyframes td-triggered {
              0%   { box-shadow: 0 0 0 0 ${color}99; }
              70%  { box-shadow: 0 0 0 20px ${color}00; }
              100% { box-shadow: 0 0 0 0 ${color}00; }
            }
          `;
          document.head.appendChild(styleEl);

          const getRect = () => target.getBoundingClientRect();
          const PAD = 6;

          // Declared early so updatePositions closure can reference them
          let badge = null, bubble = null, arrow = null;

          // ── Conic spinning border ring ────────────────────────────────────
          const ring = document.createElement('div');
          ring.setAttribute('data-td-hl', '1');
          const spinner = document.createElement('div');
          ring.appendChild(spinner);
          document.body.appendChild(ring);

          // ── Outer diffuse bloom ───────────────────────────────────────────
          const bloom = document.createElement('div');
          bloom.setAttribute('data-td-hl', '1');
          document.body.appendChild(bloom);

          const updatePositions = () => {
            const r = getRect();
            const w = r.width + PAD * 2;
            const h = r.height + PAD * 2;
            const size = Math.max(w, h) * 2.2;

            ring.style.cssText = `
              position:fixed; top:${r.top-PAD}px; left:${r.left-PAD}px;
              width:${w}px; height:${h}px; border-radius:10px;
              z-index:2147483646; pointer-events:none; overflow:hidden;
              -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
              -webkit-mask-composite:xor; mask-composite:exclude; padding:3px;
            `;
            spinner.style.cssText = `
              position:absolute; top:50%; left:50%;
              width:${size}px; height:${size}px; border-radius:50%;
              background:conic-gradient(
                from 0deg,
                transparent 0deg, ${color}cc 60deg, #fff 120deg,
                ${color}cc 180deg, transparent 240deg, ${color}55 300deg, transparent 360deg
              );
              animation:td-spin 2s linear infinite;
            `;
            bloom.style.cssText = `
              position:fixed; top:${r.top-PAD-8}px; left:${r.left-PAD-8}px;
              width:${r.width+(PAD+8)*2}px; height:${r.height+(PAD+8)*2}px;
              border-radius:14px; z-index:2147483645; pointer-events:none;
              box-shadow:0 0 18px 6px ${color}66, 0 0 40px 12px ${color}33, 0 0 70px 20px ${color}18;
              animation:td-bloom 2s ease-in-out infinite;
            `;
            // Reposition badge anchored above the element
            if (badge) {
              badge.style.top = Math.max(r.top - PAD - 36, 4) + 'px';
              badge.style.left = (r.left - PAD) + 'px';
            }
            // Reposition bubble anchored below (or above) the element
            if (bubble) {
              const spaceBelow = window.innerHeight - r.bottom;
              const arrowUp = spaceBelow > 120;
              const bubbleTop = arrowUp ? r.bottom + PAD + 10 : r.top - PAD - bubble.offsetHeight - 10;
              const bubbleLeft = Math.max(8, Math.min(r.left - PAD, window.innerWidth - 340));
              bubble.style.top = bubbleTop + 'px';
              bubble.style.left = bubbleLeft + 'px';
              if (arrow) {
                if (arrowUp) {
                  arrow.style.top = '-7px'; arrow.style.bottom = '';
                  arrow.style.transform = 'rotate(45deg)';
                } else {
                  arrow.style.bottom = '-7px'; arrow.style.top = '';
                  arrow.style.transform = 'rotate(225deg)';
                }
              }
            }
          };

          updatePositions();
          const reposition = () => updatePositions();
          window.addEventListener('scroll', reposition, { passive: true });
          window.addEventListener('resize', reposition, { passive: true });

          // ── Floating action badge ─────────────────────────────────────────
          if (label) {
            badge = document.createElement('div');
            badge.setAttribute('data-td-hl', '1');
            badge.style.cssText = `
              position:fixed; top:0px; left:0px;
              background:linear-gradient(135deg,${color}ee,${color}99);
              color:#fff; font-size:11px; font-weight:700; letter-spacing:0.04em;
              padding:3px 10px; border-radius:5px; z-index:2147483647;
              pointer-events:none;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              white-space:nowrap; text-transform:uppercase;
              box-shadow:0 2px 12px ${color}88, 0 1px 3px rgba(0,0,0,0.5);
              animation:td-badge-in 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;
            `;
            badge.textContent = label;
            document.body.appendChild(badge);
          }

          // ── AI speech bubble with instruction text ────────────────────────
          if (instruction) {
            bubble = document.createElement('div');
            bubble.setAttribute('data-td-hl', '1');
            bubble.style.cssText = `
              position:fixed; top:0px; left:0px;
              max-width:320px; min-width:200px;
              background:rgba(15,15,25,0.96);
              border:1px solid ${color}55;
              border-radius:12px;
              padding:12px 14px 10px;
              z-index:2147483647;
              pointer-events:none;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              box-shadow:0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px ${color}22, 0 0 20px ${color}33;
              animation:td-bubble-in 0.35s cubic-bezier(0.34,1.56,0.64,1) forwards;
              backdrop-filter:blur(12px);
            `;

            // Arrow pointer — direction set by repositionBubble
            arrow = document.createElement('div');
            arrow.style.cssText = `
              position:absolute; top:-7px; left:20px;
              width:14px; height:14px;
              background:rgba(15,15,25,0.96);
              border-left:1px solid ${color}55; border-top:1px solid ${color}55;
              transform:rotate(45deg);
              border-radius:2px;
            `;
            bubble.appendChild(arrow);

            // ThinkDrop AI label
            const aiLabel = document.createElement('div');
            aiLabel.style.cssText = `
              display:flex; align-items:center; gap:6px;
              margin-bottom:7px;
              font-size:10px; font-weight:700; letter-spacing:0.06em;
              text-transform:uppercase; color:${color};
            `;
            aiLabel.innerHTML = `
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4l3 3"/>
              </svg>
              ThinkDrop AI
            `;
            bubble.appendChild(aiLabel);

            // Instruction text
            const text = document.createElement('div');
            text.style.cssText = `
              font-size:13px; line-height:1.55; color:#e5e7eb;
              font-weight:400;
            `;
            text.textContent = instruction;
            bubble.appendChild(text);

            document.body.appendChild(bubble);
          }

          // Initial position for badge + bubble (they were null when updatePositions first ran)
          updatePositions();

          // ── Event-driven trigger — event type matches element semantics ──
          // Text inputs: debounced 'input' — fires 1s after user stops typing.
          //   This means "M","I","K","E" → debounce resets each keypress → 1s
          //   after "E" → trigger fires. Clicking into the field does NOT advance.
          // select / radio / checkbox → 'change' fires only on user selection.
          // button / link / anything else → 'click' explicit user click.
          if (trigger) {
            const tag = target.tagName.toLowerCase();
            const inputType = (target.getAttribute('type') || '').toLowerCase();
            const role = (target.getAttribute('role') || '').toLowerCase();
            const isContentEditable = target.isContentEditable || target.getAttribute('contenteditable') === 'true' || target.getAttribute('contenteditable') === '';
            const isTextInput = (tag === 'input' && !['button','submit','reset','checkbox','radio','file','image'].includes(inputType))
              || tag === 'textarea'
              || isContentEditable
              || role === 'textbox'
              || role === 'searchbox';
            const isChoice = tag === 'select' || inputType === 'checkbox' || inputType === 'radio';

            const fire = (eventType) => {
              if (window.__tdTriggerGeneration !== myGeneration) return;
              console.log('[ThinkDrop] fire() called via:', eventType, new Error().stack?.split('\n')[1] || '');
              window.__tdTriggerCleanup = null;
              bloom.style.animation = 'td-triggered 0.6s ease-out forwards';
              setTimeout(() => {
                document.querySelectorAll('[data-td-hl]').forEach(el => el.remove());
                const s = document.getElementById('td-hl-style');
                if (s) s.remove();
              }, 600);
              if (typeof window.__tdTrigger === 'function') window.__tdTrigger();
            };

            if (isTextInput) {
              // Debounce: advance 1 second after user stops typing.
              // Walk down to the actual editable leaf in case highlight targeted a wrapper div.
              // input events don't bubble from contenteditable in all cases, so we must
              // attach to the leaf node directly.
              let inputTarget = target;
              if (!target.isContentEditable && target.tagName.toLowerCase() !== 'input' && target.tagName.toLowerCase() !== 'textarea') {
                const leaf = target.querySelector('input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"]');
                if (leaf) inputTarget = leaf;
              }
              let debounceTimer = null;
              const onInput = (e) => {
                if (!e.isTrusted) return;
                if (window.__tdTriggerGeneration !== myGeneration) return;
                // Support both standard inputs (.value) and contenteditable (.textContent)
                const content = inputTarget.value !== undefined ? inputTarget.value : (inputTarget.textContent || inputTarget.innerText || '');
                if (!content || content.trim().length < 1) return;
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                  inputTarget.removeEventListener('input', onInput, { capture: true });
                  fire('input-debounce');
                }, 1000);
              };
              inputTarget.addEventListener('input', onInput, { capture: true });
              window.__tdTriggerCleanup = () => {
                clearTimeout(debounceTimer);
                inputTarget.removeEventListener('input', onInput, { capture: true });
              };
            } else {
              const triggerEvent = isChoice ? 'change' : 'click';
              const onTrigger = (e) => {
                if (!e.isTrusted) return;
                if (window.__tdTriggerGeneration !== myGeneration) return;
                target.removeEventListener(triggerEvent, onTrigger, { capture: true });
                fire(triggerEvent);
              };
              target.addEventListener(triggerEvent, onTrigger, { capture: true });
              window.__tdTriggerCleanup = () => {
                target.removeEventListener(triggerEvent, onTrigger, { capture: true });
              };
            }
          }

        }, { sel: resolvedSelector, color: hlColor, label: hlLabel, instruction: hlInstruction, trigger: hlTrigger, clearAll: hlClear });

        result = hlClear ? 'highlights cleared' : `highlighted: ${resolvedSelector || hlLabel || 'unknown'}`;
        break;
      }

      default:
        return { ok: false, error: `Unknown browser.act action: ${action}` };
    }

    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => '');

    const response = {
      ok: true,
      action,
      sessionId,
      url: currentUrl,
      title: currentTitle,
      executionTime: Date.now() - startTime
    };

    if (result !== undefined) response.result = result;

    logger.info(`[browser.act] ${action} completed in ${response.executionTime}ms`);
    return response;

  } catch (err) {
    const executionTime = Date.now() - startTime;
    logger.error(`[browser.act] ${action} failed: ${err.message}`);

    // Clean up session only on truly fatal browser errors (browser process gone).
    // Do NOT delete on "Target page, context or browser has been closed" — this fires
    // transiently during page navigation (e.g. after user clicks a link in guide mode)
    // and the session is still valid once the new page loads.
    if (err.message.includes('Browser closed') || err.message.includes('browser has been closed') || err.message.includes('disconnected')) {
      sessions.delete(sessionId);
    }

    let errUrl = '';
    try { errUrl = session?.page?.url() || ''; } catch (_) {}
    return {
      ok: false,
      action,
      sessionId,
      url: errUrl,
      error: err.message,
      executionTime
    };
  }
}

module.exports = { browserAct };
