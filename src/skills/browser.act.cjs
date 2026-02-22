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

const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Session pool — one browser + page per sessionId
// ---------------------------------------------------------------------------

const sessions = new Map(); // sessionId → { page, lastUsed }

// Shared browser + persistent context — all sessions are tabs in the same window
// with shared cookies, localStorage, and login state across tasks.
let sharedBrowser = null;
let sharedContext = null;

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
  logger.info('[browser.act] Created shared persistent browser context');
  return sharedContext;
}

// Periodic cleanup of idle session tabs
setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastUsed > SESSION_IDLE_MS) {
      logger.info(`[browser.act] Closing idle session tab: ${id}`);
      try { await session.page.close(); } catch (_) {}
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

async function getSession(sessionId, timeoutMs) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    // Verify page is still alive
    try {
      s.page.url();
      s.lastUsed = Date.now();
      return s;
    } catch (_) {
      sessions.delete(sessionId);
    }
  }

  const context = await getSharedContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs || 15000);

  const session = { page, lastUsed: Date.now() };
  sessions.set(sessionId, session);
  return session;
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
      await page.keyboard.press('Meta+A');
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

    const session = await getSession(sessionId, timeoutMs);
    const { page } = session;
    page.setDefaultTimeout(timeoutMs);

    let result;

    switch (action) {
      // ── navigate ──────────────────────────────────────────────────────────
      case 'navigate': {
        if (!url) return { ok: false, error: 'url is required for navigate' };
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
            (c.id || '').toLowerCase().includes(hint)
          );
          if (hinted) best = hinted;
        }

        // Build a reliable CSS selector for the chosen element
        // CSS.escape is browser-only — use a safe manual fallback for Node.js
        const cssEscape = (str) => str.replace(/([\0-\x1f\x7f]|^-?\d|^-$|[^\w-])/g, (c) => `\\${c}`);
        let resolvedSelector;
        if (best.id) {
          resolvedSelector = `#${cssEscape(best.id)}`;
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

    // Clean up session on fatal browser errors
    if (err.message.includes('Target closed') || err.message.includes('Browser closed')) {
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
