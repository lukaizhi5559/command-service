'use strict';

/**
 * web.crawl — Fetch and extract readable text from a URL using playwright-cli.
 *
 * Uses a dedicated headless-style crawl session (_crawl_<hash>) so it never
 * interferes with the user's visible browser sessions.  After extraction the
 * session is closed so it doesn't leave stale Chrome processes.
 *
 * Args:
 *   url           {string}  — URL to crawl (required)
 *   fallbackUrls  {string[]}— alternate URLs to retry when the primary returns
 *                             an error page / thin content (e.g. from web.agent
 *                             search_and_navigate fallbackUrls)
 *   maxChars      {number}  — truncate content to this many chars (default: 12000)
 *   timeoutMs     {number}  — navigation + stabilise timeout (default: 20000)
 *   waitMs        {number}  — extra settle wait after navigation (default: 1500)
 *   extractLinks  {boolean} — extract <a href> links (default: false)
 *   extractItems  {boolean} — extract structured page cards via shared utility (default: false)
 *
 * Bot-wall handling: candidates are tried headless first. If all are rejected
 * with an error-page signature, the primary URL is retried once in headed real
 * Chrome (--headed --browser=chrome --profile=~/.thinkdrop/browser-profiles/
 * _crawl_warm — same flags browser.act uses). If that is still blocked the
 * result is { ok:false, botBlocked:true } so the caller can escalate.
 *
 * Returns:
 *   { ok, url, title, content, contentLength, truncated, links, items,
 *     elapsedMs, attempts, warmRetry?, botBlocked?, rejectedReason?, error? }
 */

const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');

const logger = require('../logger.cjs');
const { buildAdBlockScript } = require('../utils/ad-block-init.js');
const { BASELINE_DOMAINS } = require('../utils/ad-block-updater.cjs');
const { buildExtractItemsScript, parseExtractedItems } = require('./extract-page-items.cjs');

const _WC_AD_BLOCK_SCRIPT = buildAdBlockScript(BASELINE_DOMAINS);

// ── playwright-cli binary resolution (mirrors browser.act.cjs) ──────────────
const CLI_CANDIDATES = [
  '/opt/homebrew/bin/playwright-cli',
  '/usr/local/bin/playwright-cli',
  path.join(os.homedir(), '.npm-global', 'bin', 'playwright-cli'),
];

function findCli() {
  for (const c of CLI_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return 'playwright-cli';
}

const CLI_BIN = findCli();

// ── Subprocess helper ────────────────────────────────────────────────────────
function cliRun(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(CLI_BIN, args, {
      env: { ...process.env },
      timeout: timeoutMs,
    });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ ok: code === 0, stdout, stderr, exitCode: code, executionTime: Date.now() - start });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, stdout, stderr: err.message, exitCode: -1, executionTime: Date.now() - start });
    });
  });
}

// ── Extract <title> from innerText heuristic (first non-empty short line) ───
function extractTitleFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 10)) {
    if (line.length > 4 && line.length < 120) return line;
  }
  return null;
}

// ── Unwrap playwright-cli eval output ───────────────────────────────────────
// playwright-cli eval wraps output in a markdown code block like:
//   ### Ran Playwright code
//   ```js
//   await page.evaluate('...');
//   ```
//   <return value here>
// We want just the return value after the closing ```.
function unwrapEvalResult(stdout) {
  const s = stdout || '';

  // Strip the "### Ran Playwright code\n```js\n...\n```\n" header block
  // and return everything after the closing fence
  const fenceEnd = s.lastIndexOf('```');
  if (fenceEnd !== -1) {
    const afterFence = s.slice(fenceEnd + 3).trim();
    if (afterFence.length > 0) return afterFence;
  }

  // Fallback: look for "Result" header
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^#+\s*Result/i.test(lines[i].trim()) || lines[i].trim() === 'Result') {
      return lines.slice(i + 1).join('\n').trim();
    }
  }

  return s.trim();
}

// ── Error-page heuristic ─────────────────────────────────────────────────────
// Detects error/blocked/empty pages so the caller's fallback URLs can be tried.
// Content match is gated on a thin page to avoid flagging pages that merely
// mention "error"/"404" in normal prose.
const _ERROR_PAGE_RE = /error page|page not found|\b404\b|access denied|forbidden|blocked|captcha|pardon our interruption|unusual traffic|are you a robot|service unavailable|temporarily unavailable/i;

// Returns { reason, signature } — signature:true means an error-page/bot-wall
// signature matched (safe to report as blocked); signature:false means only the
// weak thin-page heuristic fired (could be a legitimately sparse page).
function _badCrawlReason(res, extractItems) {
  if (!res.ok) return { reason: res.error || 'request failed', signature: false };
  const title = res.title || '';
  if (_ERROR_PAGE_RE.test(title)) {
    return { reason: `error-page title: "${title.slice(0, 80)}"`, signature: true };
  }
  const len = res.contentLength || (res.content || '').length;
  if (len < 1500 && _ERROR_PAGE_RE.test((res.content || '').slice(0, 500))) {
    return { reason: `error-page signature in thin content (${len} chars)`, signature: true };
  }
  if (extractItems && (!res.items || res.items.length === 0) && len < 1500) {
    return { reason: `thin page with 0 extracted items (${len} chars)`, signature: false };
  }
  return null;
}

// ── Single-URL crawl ─────────────────────────────────────────────────────────
// warm:true relaunches in headed real Chrome with a shared persistent profile
// (~/.thinkdrop/browser-profiles/_crawl_warm/) — the same flags browser.act uses
// for agent sessions. Headless bundled Chromium is bot-walled by sites like
// eBay; a warm headed session closely mimics a real returning user.
async function _crawlOnce(normalizedUrl, { maxChars, timeoutMs, effectiveWaitMs, extractLinks, extractItems, progress, startTime, warm = false }) {
  // Unique session per crawl — never reuses a user-facing session
  const sessionId = warm
    ? '_crawl_warm'
    : `_crawl_${crypto.createHash('md5').update(normalizedUrl).digest('hex').slice(0, 8)}`;
  const S = warm
    ? [`-s=${sessionId}`, '--headed', '--browser=chrome', `--profile=${path.join(os.homedir(), '.thinkdrop', 'browser-profiles', '_crawl_warm')}`]
    : [`-s=${sessionId}`];

  progress(`Opening ${warm ? 'headed Chrome (warm retry)' : 'browser'} and navigating to ${normalizedUrl}`);

  try {
    // Step 1: Open browser + navigate in one command (playwright-cli requires 'open' first)
    const navRes = await cliRun([...S, 'open', normalizedUrl], timeoutMs);
    if (!navRes.ok && navRes.exitCode !== 0) {
      const fatal = /net::ERR|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ENOTFOUND/i.test(navRes.stderr);
      if (fatal) {
        await cliRun([...S, 'close'], 5000).catch(() => {});
        return { ok: false, url: normalizedUrl, error: `Navigation failed: ${navRes.stderr.slice(0, 200)}`, elapsedMs: Date.now() - startTime };
      }
    }

    // Step 1b: Inject ad-blocker into crawl page (non-blocking, non-fatal)
    cliRun([...S, 'eval', _WC_AD_BLOCK_SCRIPT], 5000).catch(() => {});

    // Step 2: Wait for JS to render (settle delay)
    if (effectiveWaitMs > 0) {
      progress(`Waiting ${effectiveWaitMs}ms for page to render...`);
      await new Promise(r => setTimeout(r, effectiveWaitMs));
    }

    // Step 3: Extract page title via document.title
    progress('Extracting page content...');
    const titleRes = await cliRun([...S, 'eval', '() => document.title'], 8000);
    const rawTitle = unwrapEvalResult(titleRes.stdout).replace(/^["']|["']$/g, '').trim();
    const title = rawTitle && rawTitle.length > 2 && rawTitle.length < 200 ? rawTitle : null;

    // Step 4: Extract full rendered text
    const evalExpr = `() => (document.body ? (document.body.innerText || document.body.textContent || '') : '').slice(0, ${Math.min(maxChars * 2, 80000)})`;
    const textRes = await cliRun([...S, 'eval', evalExpr], timeoutMs);
    let rawText = unwrapEvalResult(textRes.stdout);

    // Strip playwright-cli noise: header blocks, code fences, and short bracket lines
    rawText = rawText
      .replace(/###\s*Ran Playwright code[\s\S]*?```\s*/g, '')
      .split('\n')
      .filter(l => !/^\s*(`{3}|---|\$\s|>\s)/.test(l) || l.trim().length > 60)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const truncated = rawText.length > maxChars;
    const content   = rawText.slice(0, maxChars);
    const contentLength = rawText.length;

    progress(`Crawl complete — ${contentLength} chars extracted${truncated ? ' (truncated)' : ''}`);

    // Step 5: Optionally extract <a href> links from the page
    let links = null;
    if (extractLinks) {
      progress('Extracting page links...');
      const linkExpr = `() => Array.from(document.querySelectorAll('a[href]')).map(a => ({ href: a.href, text: (a.innerText || a.textContent || '').trim().slice(0, 100) })).filter(l => l.href && l.href.startsWith('http')).slice(0, 200)`;
      const linkRes = await cliRun([...S, 'eval', linkExpr], 8000);
      const linkRaw = unwrapEvalResult(linkRes.stdout);
      try {
        links = JSON.parse(linkRaw);
      } catch (_) {
        // Fallback: try to extract JSON array from the raw output
        const jsonMatch = linkRaw.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try { links = JSON.parse(jsonMatch[0]); } catch (_) { links = null; }
        }
      }
      if (links && Array.isArray(links)) {
        progress(`Extracted ${links.length} links from page`);
      }
    }

    // Step 6: Optionally extract structured page cards (items)
    let items = null;
    if (extractItems) {
      progress('Extracting page cards (items)...');
      // Scroll pass to trigger lazy-loaded images before extraction
      try {
        const scrollSteps = 4;
        for (let i = 1; i <= scrollSteps; i++) {
          await cliRun([...S, 'eval', `() => window.scrollTo(0, document.body.scrollHeight * ${i / scrollSteps})`], 3000).catch(() => {});
          await new Promise(r => setTimeout(r, 400));
        }
        // Scroll back to top so subsequent snapshots/extracts start fresh
        await cliRun([...S, 'eval', `() => window.scrollTo(0, 0)`], 3000).catch(() => {});
      } catch (_) { /* scroll pass is best-effort */ }

      const itemsExpr = `() => ${buildExtractItemsScript()}`;
      const itemsRes = await cliRun([...S, 'eval', itemsExpr], 12000);
      const itemsRaw = unwrapEvalResult(itemsRes.stdout);
      items = parseExtractedItems(itemsRaw);
      if (items && items.length > 0) {
        progress(`Extracted ${items.length} items from page`);
      } else {
        items = null;
      }
    }

    return {
      ok: true,
      url: normalizedUrl,
      title: title || extractTitleFromText(content),
      content,
      contentLength,
      truncated,
      links,
      items,
      elapsedMs: Date.now() - startTime,
    };

  } catch (err) {
    return { ok: false, url: normalizedUrl, error: err.message, elapsedMs: Date.now() - startTime };
  } finally {
    // Always close the crawl session to free Chrome resources
    cliRun([...S, 'close'], 5000).catch(() => {});
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.url
 * @param {string[]} [args.fallbackUrls] — alternate URLs to retry on bad pages
 * @param {number} [args.maxChars=12000]
 * @param {number} [args.timeoutMs=20000]
 * @param {number} [args.waitMs=1500]
 * @param {function} [args.onProgress]  — optional progress callback(message)
 */
async function webCrawl(args) {
  const {
    url,
    fallbackUrls = [],
    maxChars  = 12000,
    timeoutMs = 20000,
    waitMs    = 1500,
    extractLinks = false,
    extractItems = false,
    onProgress = null,
  } = args || {};

  const startTime = Date.now();

  if (!url || typeof url !== 'string') {
    return { ok: false, url, error: 'url is required', elapsedMs: 0 };
  }

  // Bump settle wait when extracting items — lazy images need render time
  const effectiveWaitMs = extractItems && waitMs < 2500 ? 2500 : waitMs;

  // Candidate list: primary first, then fallbacks (http(s) only, deduped,
  // max 3 total attempts to bound crawl time).
  const seen = new Set();
  const candidates = [url, ...(Array.isArray(fallbackUrls) ? fallbackUrls : [])]
    .filter(u => typeof u === 'string' && u.trim())
    .map(u => (/^https?:\/\//i.test(u.trim()) ? u.trim() : 'https://' + u.trim()))
    .filter(u => { if (seen.has(u)) return false; seen.add(u); return true; })
    .slice(0, 3);

  const progress = (msg) => {
    logger.info(`[web.crawl] ${msg}`);
    if (typeof onProgress === 'function') onProgress(msg);
  };

  let lastRes = null;
  let lastBad = null;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    const candidate = candidates[attempt];
    if (attempt > 0) progress(`Retrying fallback URL ${attempt + 1}/${candidates.length}: ${candidate}`);

    const res = await _crawlOnce(candidate, {
      maxChars, timeoutMs, effectiveWaitMs, extractLinks, extractItems, progress, startTime,
    });
    lastRes = res;

    const bad = _badCrawlReason(res, extractItems);
    if (!bad) {
      return { ...res, elapsedMs: Date.now() - startTime, attempts: attempt + 1 };
    }
    lastBad = bad;
    progress(`Attempt ${attempt + 1} rejected — ${bad.reason}`);
  }

  // All headless candidates rejected — if any rejection looked like an
  // error-page/bot-wall signature, retry the primary URL once in headed real
  // Chrome with a warm persistent profile (same flags browser.act uses).
  if (lastBad && lastBad.signature) {
    progress(`All headless attempts blocked — warm retry in headed Chrome: ${candidates[0]}`);
    const warmRes = await _crawlOnce(candidates[0], {
      maxChars, timeoutMs, effectiveWaitMs, extractLinks, extractItems, progress, startTime, warm: true,
    });
    const warmBad = _badCrawlReason(warmRes, extractItems);
    if (!warmBad) {
      return { ...warmRes, elapsedMs: Date.now() - startTime, attempts: candidates.length + 1, warmRetry: true };
    }
    // Still rejected with an error-page signature → honest failure so the
    // recovery path (reviewExecution/replan) can escalate to browser.agent.
    if (warmBad.signature) {
      return {
        ...warmRes,
        ok: false,
        botBlocked: true,
        error: `Page blocked or error page on all attempts (last: ${warmBad.reason})`,
        rejectedReason: warmBad.reason,
        elapsedMs: Date.now() - startTime,
        attempts: candidates.length + 1,
        warmRetry: true,
      };
    }
    // Warm retry got a real but sparse page — return it as ok.
    return { ...warmRes, elapsedMs: Date.now() - startTime, attempts: candidates.length + 1, warmRetry: true, rejectedReason: warmBad.reason };
  }

  // Rejections were thin-page only (no error signature) — legitimately sparse
  // pages. Return the last result as ok so content stays usable.
  return { ...lastRes, elapsedMs: Date.now() - startTime, attempts: candidates.length, rejectedReason: lastBad?.reason || null };
}

module.exports = { webCrawl };
