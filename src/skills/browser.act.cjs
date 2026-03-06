'use strict';

/**
 * skill: browser.act
 *
 * Pure terminal browser automation — 100% playwright-cli subprocess calls.
 * No Playwright Node API. No npm packages. Just playwright-cli + shell.
 *
 * Binary: /opt/homebrew/bin/playwright-cli  (brew install playwright-cli)
 * Sessions: -s=<sessionId> keeps a browser alive between calls.
 * Snapshot: captures accessibility tree with numbered refs (e1, e21, …)
 *           used for ref-based click/fill/hover/select.
 *
 * Actions supported:
 *   navigate | goto | back | forward | reload | close | snapshot
 *   click | dblclick | fill | type | hover | select | check | uncheck
 *   keyboard | press | scroll | screenshot | pdf
 *   getText | getPageText | evaluate | scanCurrentPage
 *   waitForSelector | waitForContent | waitForStableText
 *   tab-new | tab-list | tab-close | tab-select
 *   state-save | state-load | resize
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
const { spawn } = require('child_process');
const logger = require('../logger.cjs');

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

// ---------------------------------------------------------------------------
// Core executor — runs playwright-cli with given args
// Returns: { ok, stdout, stderr, exitCode, executionTime }
// ---------------------------------------------------------------------------

function cliRun(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(CLI_BIN, args, {
      env: { ...process.env },
      timeout: timeoutMs,
    });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve({ ok: false, stdout, stderr, exitCode: -1, executionTime: Date.now() - start, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs + 2000);

    proc.on('close', code => {
      clearTimeout(timer);
      const executionTime = Date.now() - start;
      const ok = code === 0;
      resolve({ ok, stdout, stderr, exitCode: code ?? -1, executionTime, error: ok ? undefined : stderr.trim() || `exit code ${code}` });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, exitCode: -1, executionTime: Date.now() - start, error: err.message });
    });
  });
}

// Persistent profile directory per session — preserves cookies/login across restarts
function sessionProfileDir(sessionId) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Build base flags for a session
function sessionFlags(sessionId, headed = true) {
  const flags = [`-s=${sessionId}`];
  if (headed) flags.push('--headed');
  // --profile persists cookies/localStorage to disk so logins survive restarts
  flags.push(`--profile=${sessionProfileDir(sessionId)}`);
  return flags;
}

// ---------------------------------------------------------------------------
// Snapshot cache — stores last snapshot text per session for ref resolution
// ---------------------------------------------------------------------------
const snapshotCache = new Map(); // sessionId → snapshot stdout

// Track which sessions have been opened (daemon started)
const openSessions = new Set();

async function captureSnapshot(sessionId, headed, timeoutMs) {
  const res = await cliRun([...sessionFlags(sessionId, headed), 'snapshot'], timeoutMs);
  // playwright-cli snapshot writes the YAML tree to a .yml file and only
  // prints the file path in stdout (e.g. "[Snapshot](.playwright-cli/page-xxx.yml)").
  // We must read the file to get the actual accessibility tree with element refs.
  let snapshotText = res.stdout || '';
  const fileMatch = snapshotText.match(/\[Snapshot\]\(([^)]+\.yml)\)/);
  if (fileMatch) {
    try {
      const fs = require('fs');
      const path = require('path');
      const ymlPath = path.resolve(process.cwd(), fileMatch[1]);
      snapshotText = fs.readFileSync(ymlPath, 'utf8');
    } catch (_) {
      // fall back to stdout if file read fails
    }
  }
  if (snapshotText) {
    snapshotCache.set(sessionId, snapshotText);
  }
  res.snapshotText = snapshotText;
  return res;
}

// Resolve a label string to an element ref by scanning snapshot text.
// If arg already looks like a ref (e1, e21, …), return it as-is.
function resolveRef(sessionId, labelOrRef) {
  if (!labelOrRef) return null;
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(sessionId) || '';
  const needle = labelOrRef.toLowerCase();
  const lines = snap.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes(needle)) {
      const m = line.match(/\[?(e\d+)\]?/i);
      if (m) return m[1];
    }
  }
  return null; // caller will use text fallback
}

// ---------------------------------------------------------------------------
// Main skill entry point
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
  } = args || {};

  const start = Date.now();

  if (!action) {
    return { ok: false, error: 'action is required', executionTime: 0 };
  }

  logger.info(`[browser.act] ${action} session=${sessionId}`, { url, selector, text, key });

  const S = sessionFlags(sessionId, headed);

  // Helper: run + return standardised result
  async function run(cmdArgs, label) {
    const res = await cliRun([...S, ...cmdArgs], timeoutMs);
    logger.info(`[browser.act] ${label} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 200) });
    return {
      ok:            res.ok,
      action,
      sessionId,
      result:        res.stdout.trim() || undefined,
      stdout:        res.stdout,
      executionTime: Date.now() - start,
      error:         res.ok ? undefined : res.error || res.stderr?.trim(),
    };
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  switch (action) {

    // ── Navigation ──────────────────────────────────────────────────────────
    case 'navigate':
    case 'goto': {
      if (!url) return { ok: false, action, sessionId, error: 'url required for navigate', executionTime: 0 };
      // Use 'open' to cold-start the daemon + navigate in one shot.
      // Use 'goto' if daemon is already running — avoids exit -1 on re-navigation.
      const navTimeout = Math.max(timeoutMs, 30000);
      const alreadyOpen = openSessions.has(sessionId);
      const navCmd = alreadyOpen ? 'goto' : 'open';
      const res = await cliRun([...S, navCmd, url], navTimeout);
      if (res.ok) {
        openSessions.add(sessionId);
      } else if (alreadyOpen && !res.ok) {
        // goto failed (daemon may have died) — retry with open to restart it
        logger.info(`[browser.act] goto failed, retrying with open for session=${sessionId}`);
        const retryRes = await cliRun([...S, 'open', url], navTimeout);
        if (retryRes.ok) openSessions.add(sessionId);
        logger.info(`[browser.act] open ${url} → exit ${retryRes.exitCode}`, { stderr: retryRes.stderr?.slice(0, 200) });
        return {
          ok:            retryRes.ok,
          action,
          sessionId,
          result:        retryRes.stdout.trim() || undefined,
          executionTime: Date.now() - start,
          error:         retryRes.ok ? undefined : retryRes.error || retryRes.stderr?.trim(),
        };
      }
      logger.info(`[browser.act] ${navCmd} ${url} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 200) });
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.stdout.trim() || undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error || res.stderr?.trim(),
      };
    }

    case 'back':    return run(['go-back'],    'go-back');
    case 'forward': return run(['go-forward'], 'go-forward');
    case 'reload':  return run(['reload'],     'reload');

    case 'close': {
      const res = await cliRun([...S, 'close'], timeoutMs);
      snapshotCache.delete(sessionId);
      openSessions.delete(sessionId);
      return { ok: res.ok, action, sessionId, executionTime: Date.now() - start, error: res.ok ? undefined : res.error };
    }

    // ── Snapshot ─────────────────────────────────────────────────────────────
    case 'snapshot': {
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

    // ── Click ────────────────────────────────────────────────────────────────
    case 'click':
    case 'dblclick': {
      const cmd = action === 'dblclick' ? 'dblclick' : 'click';
      // Ensure snapshot is fresh for ref resolution
      await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      if (!ref) {
        // No ref found — try snapshot + text fallback via eval
        logger.warn(`[browser.act] click: could not resolve ref for "${selector}" — trying eval click`);
        return run(['eval', `document.querySelector('[aria-label="${selector}"]')?.click() || [...document.querySelectorAll('a,button,[role=button]')].find(e=>e.textContent.trim().includes("${selector}"))?.click()`], `eval-click "${selector}"`);
      }
      return run([cmd, ref], `${cmd} ${ref}`);
    }

    // ── Fill / Type ─────────────────────────────────────────────────────────
    case 'fill': {
      const snap = await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      // If ref resolved from snapshot, use it. Otherwise pass selector directly —
      // playwright-cli fill also accepts text labels and CSS selectors natively.
      const fillTarget = ref || selector;
      logger.info(`[browser.act] fill resolved: "${selector}" → ${ref ? `ref ${ref}` : 'direct selector'}`);
      return run(['fill', fillTarget, text || ''], `fill ${fillTarget}`);
    }

    case 'type': {
      return run(['type', text || ''], `type "${text}"`);
    }

    // ── Hover ────────────────────────────────────────────────────────────────
    case 'hover': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      const hoverTarget = ref || selector;
      return run(['hover', hoverTarget], `hover ${hoverTarget}`);
    }

    // ── Select ───────────────────────────────────────────────────────────────
    case 'select': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      const selTarget = ref || selector;
      return run(['select', selTarget, value || ''], `select ${selTarget}`);
    }

    // ── Check / Uncheck ──────────────────────────────────────────────────────
    case 'check': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      return run(['check', ref || selector], `check ${ref || selector}`);
    }
    case 'uncheck': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const ref = resolveRef(sessionId, selector);
      return run(['uncheck', ref || selector], `uncheck ${ref || selector}`);
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────
    case 'keyboard':
    case 'press': {
      return run(['press', key || text || ''], `press ${key || text}`);
    }
    case 'keydown': return run(['keydown', key || ''], `keydown ${key}`);
    case 'keyup':   return run(['keyup',   key || ''], `keyup ${key}`);

    // ── Scroll ───────────────────────────────────────────────────────────────
    case 'scroll': {
      return run(['mousewheel', String(dx), String(dy)], `scroll dx=${dx} dy=${dy}`);
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    case 'screenshot': {
      const outPath = filePath || path.join(os.tmpdir(), `screenshot_${sessionId}_${Date.now()}.png`);
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

    // ── getText / getPageText ─────────────────────────────────────────────────
    case 'getText':
    case 'getPageText': {
      // Use eval to extract innerText of the page body
      const res = await cliRun([...S, 'eval', 'document.body.innerText'], timeoutMs);
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.stdout.trim(),
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── evaluate ─────────────────────────────────────────────────────────────
    case 'evaluate': {
      const expr = text || selector || args.expression || '';
      return run(['eval', expr], `eval "${expr.slice(0, 60)}"`);
    }

    // ── waitForSelector ───────────────────────────────────────────────────────
    case 'waitForSelector': {
      // Poll snapshot until ref matching selector appears
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapRes = await cliRun([...S, 'eval', 'document.body.innerText'], 5000);
        if (snapRes.stdout.includes(needle)) {
          return { ok: true, action, sessionId, result: needle, executionTime: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      return { ok: false, action, sessionId, error: `Timeout waiting for content: "${needle}"`, executionTime: Date.now() - start };
    }

    // ── waitForTrigger / waitForNavigation — alias to waitForStableText ────────
    // playwright-cli has no native waitForTrigger/waitForNavigation commands.
    // Fall through to waitForStableText which polls until page text stabilises.
    case 'waitForTrigger':
    case 'waitForNavigation':
    // ── waitForStableText ─────────────────────────────────────────────────────
    case 'waitForStableText': {
      let prev = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await cliRun([...S, 'eval', 'document.body.innerText'], 5000);
        const cur = r.stdout.trim();
        if (cur && cur === prev) {
          return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
        }
        prev = cur;
        await new Promise(r2 => setTimeout(r2, 1200));
      }
      return { ok: true, action, sessionId, result: prev, executionTime: Date.now() - start };
    }

    // ── scanCurrentPage ───────────────────────────────────────────────────────
    // Returns elements array parsed from snapshot for planSkills pre-scan
    case 'scanCurrentPage': {
      const snapRes = await captureSnapshot(sessionId, headed, timeoutMs);
      const elements = parseSnapshotToElements(snapRes.stdout);
      // Also grab current URL via eval
      const urlRes = await cliRun([...S, 'eval', 'location.href'], 5000);
      return {
        ok:            true,
        action,
        sessionId,
        result: {
          url:      urlRes.stdout.trim() || '',
          elements,
          snapshot: snapRes.stdout,
        },
        executionTime: Date.now() - start,
      };
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    case 'tab-new':    return run(['tab-new',    url || ''],           'tab-new');
    case 'tab-list':   return run(['tab-list'],                        'tab-list');
    case 'tab-close':  return run(['tab-close',  String(args.index || 0)], 'tab-close');
    case 'tab-select': return run(['tab-select', String(args.index || 0)], 'tab-select');

    // ── Auth state persistence ────────────────────────────────────────────────
    case 'state-save': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return run(['state-save', p], `state-save ${p}`);
    }
    case 'state-load': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      return run(['state-load', p], `state-load ${p}`);
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    case 'resize': {
      return run(['resize', String(width || 1280), String(height || 800)], 'resize');
    }

    // ── newPage (alias tab-new) ───────────────────────────────────────────────
    case 'newPage': {
      return run(['tab-new', url || ''], 'newPage');
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

module.exports = { browserAct };
