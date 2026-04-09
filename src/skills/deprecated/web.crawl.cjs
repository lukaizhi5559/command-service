'use strict';

/**
 * web.crawl — Fetch and extract readable text from a URL using playwright-cli.
 *
 * Uses a dedicated headless-style crawl session (_crawl_<hash>) so it never
 * interferes with the user's visible browser sessions.  After extraction the
 * session is closed so it doesn't leave stale Chrome processes.
 *
 * Args:
 *   url        {string}  — URL to crawl (required)
 *   maxChars   {number}  — truncate content to this many chars (default: 12000)
 *   timeoutMs  {number}  — navigation + stabilise timeout (default: 20000)
 *   waitMs     {number}  — extra settle wait after navigation (default: 1500)
 *
 * Returns:
 *   { ok, url, title, content, contentLength, truncated, elapsedMs, error? }
 */

const { spawn } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');

const logger = require('../logger.cjs');

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

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {string} args.url
 * @param {number} [args.maxChars=12000]
 * @param {number} [args.timeoutMs=20000]
 * @param {number} [args.waitMs=1500]
 * @param {function} [args.onProgress]  — optional progress callback(message)
 */
async function webCrawl(args) {
  const {
    url,
    maxChars  = 12000,
    timeoutMs = 20000,
    waitMs    = 1500,
    onProgress = null,
  } = args || {};

  const startTime = Date.now();

  if (!url || typeof url !== 'string') {
    return { ok: false, url, error: 'url is required', elapsedMs: 0 };
  }

  // Normalise URL
  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  // Unique session per crawl — never reuses a user-facing session
  const sessionId = `_crawl_${crypto.createHash('md5').update(normalizedUrl).digest('hex').slice(0, 8)}`;
  const S = [`-s=${sessionId}`];

  const progress = (msg) => {
    logger.info(`[web.crawl] ${msg}`);
    if (typeof onProgress === 'function') onProgress(msg);
  };

  progress(`Opening browser and navigating to ${normalizedUrl}`);

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

    // Step 2: Wait for JS to render (settle delay)
    if (waitMs > 0) {
      progress(`Waiting ${waitMs}ms for page to render...`);
      await new Promise(r => setTimeout(r, waitMs));
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

    return {
      ok: true,
      url: normalizedUrl,
      title: title || extractTitleFromText(content),
      content,
      contentLength,
      truncated,
      elapsedMs: Date.now() - startTime,
    };

  } catch (err) {
    return { ok: false, url: normalizedUrl, error: err.message, elapsedMs: Date.now() - startTime };
  } finally {
    // Always close the crawl session to free Chrome resources
    cliRun([...S, 'close'], 5000).catch(() => {});
  }
}

module.exports = { webCrawl };
