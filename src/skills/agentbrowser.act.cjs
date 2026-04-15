'use strict';

/**
 * skill: agentbrowser.act
 *
 * Low-level browser action driver using Vercel's agent-browser CLI.
 * Agent-browser returns compact interactive-only accessibility snapshots
 * with @eN refs — designed for AI agent token efficiency, not YAML storage.
 *
 * Key differences from browser.act (playwright-cli):
 *   - `snapshot -i` returns plain text (@e1 [button] "Compose") — no YAML, no file
 *   - `get url` returns the current URL directly on stdout — no eval + regex needed
 *   - `--session-name` auto-persists auth state to ~/.agent-browser/sessions/
 *   - `eval` runs browser-side JS — document/window/fetch available, NO page object
 *   - `keyboard type` replaces contenteditable fill (no page.keyboard.type())
 *   - No snapshotCache, no resolveRef — refs are @eN tokens passed through directly
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Binary resolution — check candidates in priority order
// ---------------------------------------------------------------------------
function findCli() {
  const candidates = [
    // Local project dependency (most portable)
    path.join(__dirname, '../../node_modules/.bin/agent-browser'),
    path.join(__dirname, '../../../node_modules/.bin/agent-browser'),
    // nvm-managed node (macOS common)
    path.join(os.homedir(), '.nvm', 'versions', 'node', 'v22.16.0', 'bin', 'agent-browser'),
    // Homebrew global (macOS)
    '/opt/homebrew/bin/agent-browser',
    '/usr/local/bin/agent-browser',
    // npm global
    path.join(os.homedir(), '.npm-global', 'bin', 'agent-browser'),
    // PATH fallback
    'agent-browser',
  ];
  for (const c of candidates) {
    try {
      if (c !== 'agent-browser' && fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return 'agent-browser';
}

const CLI_BIN = findCli();
logger.info(`[agentbrowser.act] binary: ${CLI_BIN}`);

// ---------------------------------------------------------------------------
// Session name sanitization — agent-browser requires [a-z0-9_-] only
// ---------------------------------------------------------------------------
function sanitizeSessionName(id) {
  return (id || 'default').replace(/[^a-z0-9_-]/gi, '_');
}

// ---------------------------------------------------------------------------
// Session flags — --session for isolation, --session-name for auth persistence.
// When chromeProfile is set (e.g. 'Default'), use --profile instead so agent-browser
// loads the real Chrome user profile. This makes Google OAuth work because the
// existing Google session cookie is present — Google never shows the sign-in rejection.
// ---------------------------------------------------------------------------
function sessionFlags(sessionId, headed = true, chromeProfile = null) {
  if (chromeProfile) {
    // Use real Chrome profile — inherits auth cookies, bypasses Google automation detection
    const flags = ['--profile', chromeProfile];
    if (headed) flags.push('--headed');
    return flags;
  }
  const flags = [
    '--session', sessionId,
    '--session-name', sanitizeSessionName(sessionId),
  ];
  if (headed) flags.push('--headed');
  return flags;
}

// ---------------------------------------------------------------------------
// Core subprocess spawner — mirrors browser.act cliRun pattern
// ---------------------------------------------------------------------------
function cliRun(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    let proc;
    try {
      proc = spawn(CLI_BIN, args, {
        env: { ...process.env },
      });
    } catch (spawnErr) {
      return resolve({
        ok: false, stdout: '', stderr: spawnErr.message, exitCode: -1,
        executionTime: 0, error: `spawn failed: ${spawnErr.message}`,
      });
    }

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    // Hard timeout — CLI may hang despite process timeout
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve({
        ok: false, stdout, stderr, exitCode: -1,
        executionTime: Date.now() - start,
        error: `Timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs + 2000);

    proc.on('close', code => {
      clearTimeout(timer);
      const ok = code === 0;
      resolve({
        ok, stdout, stderr, exitCode: code ?? -1,
        executionTime: Date.now() - start,
        error: ok ? undefined : stderr.trim() || stdout.trim() || `exit code ${code}`,
      });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({
        ok: false, stdout, stderr, exitCode: -1,
        executionTime: Date.now() - start,
        error: err.message,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Normalize ref — agent-browser requires @ prefix on all @eN refs.
// Handles LLM output that omits the @: "e24" → "@e24"
// ---------------------------------------------------------------------------
function normalizeRef(sel) {
  if (!sel) return sel;
  const s = String(sel);
  // Plain eN format without @ — add prefix
  if (/^e\d+$/.test(s)) return `@${s}`;
  return s;
}

// ---------------------------------------------------------------------------
// Parse the current URL from `agent-browser get url` stdout.
// Unlike playwright-cli eval, agent-browser returns the value directly.
// ---------------------------------------------------------------------------
function parseGetUrl(stdout) {
  return (stdout || '').trim().split('\n')[0].trim();
}

// ---------------------------------------------------------------------------
// Fire-and-forget progress notification (same pattern as browser.act)
// ---------------------------------------------------------------------------
function notifyUser(callbackUrl, payload) {
  if (!callbackUrl) return;
  try {
    const http = require('http');
    const body = JSON.stringify(payload);
    const parsed = new URL(callbackUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parseInt(parsed.port, 10),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  2000,
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Main action dispatcher
// ---------------------------------------------------------------------------
async function agentbrowserAct(args) {
  const {
    action,
    sessionId       = 'default',
    url,
    selector,
    ref:    _refField,          // LLM sometimes outputs "ref" instead of "selector" — accept both
    text,
    key,
    value,
    code,
    direction       = 'down',
    dy              = 300,
    dx              = 0,
    filePath,
    pattern,
    role,
    name: roleName,
    label,
    target,
    headed          = true,
    timeoutMs       = 15000,
    authSuccessUrl,
    chromeProfile   = null,   // --profile <name> instead of --session (for Google OAuth)
    _progressCallbackUrl,
  } = args || {};

  const start = Date.now();
  const S = sessionFlags(sessionId, headed, chromeProfile);

  // Convenience wrapper for simple passthrough commands
  const run = async (cmdArgs, label) => {
    const res = await cliRun([...S, ...cmdArgs], timeoutMs);
    logger.info(`[agentbrowser.act] ${label} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 120) });
    return {
      ok:            res.ok,
      action,
      sessionId,
      result:        res.stdout?.trim() || undefined,
      stdout:        res.stdout,
      executionTime: Date.now() - start,
      error:         res.ok ? undefined : res.error || res.stderr?.trim(),
    };
  };

  if (!action) {
    return { ok: false, action: 'unknown', sessionId, error: 'action is required', executionTime: 0 };
  }

  switch (action) {

    // ── Navigation ───────────────────────────────────────────────────────────
    case 'navigate':
    case 'goto': {
      if (!url) return { ok: false, action, sessionId, error: 'url required for navigate', executionTime: 0 };
      const navTimeout = Math.max(timeoutMs, 30000);
      const res = await cliRun([...S, 'open', url], navTimeout);
      logger.info(`[agentbrowser.act] open ${url} → exit ${res.exitCode}`);
      return {
        ok:            res.ok,
        action,
        sessionId,
        url:           res.ok ? url : undefined,
        result:        res.stdout?.trim() || undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error || res.stderr?.trim(),
      };
    }

    case 'back':    return run(['back'],    'back');
    case 'forward': return run(['forward'], 'forward');
    case 'reload':  return run(['reload'],  'reload');

    case 'close': {
      const res = await cliRun([...S, 'close'], timeoutMs);
      return { ok: res.ok, action, sessionId, executionTime: Date.now() - start, error: res.ok ? undefined : res.error };
    }

    // ── Close all sessions / kill daemon globally (‘close --all’ with no session flags).
    // ── Unlike the session-scoped ‘close’, this terminates the agent-browser daemon process
    // ── entirely so the next call restarts it clean with correct flags (--headed, etc.).
    case 'close-all': {
      const res = await cliRun(['close', '--all'], Math.min(timeoutMs, 8000));
      return { ok: res.ok, action, sessionId, executionTime: Date.now() - start, error: res.ok ? undefined : res.error };
    }

    // ── Snapshot ─────────────────────────────────────────────────────────────
    // agent-browser snapshot -i returns interactive-only compact text directly.
    // No YAML, no file path — the stdout IS the snapshot.
    case 'snapshot': {
      const res = await cliRun([...S, 'snapshot', '-i'], timeoutMs);
      const content = (res.stdout || '').trim();
      return {
        ok:            res.ok || !!content,
        action,
        sessionId,
        result:        content,
        executionTime: Date.now() - start,
        error:         (res.ok || content) ? undefined : res.error,
      };
    }

    // ── Click / Double-click ─────────────────────────────────────────────────
    case 'click':
    case 'dblclick': {
      const cmd = action === 'dblclick' ? 'dblclick' : 'click';
      const ref = normalizeRef(selector || _refField);
      if (!ref) return { ok: false, action, sessionId, error: 'selector required for click', executionTime: Date.now() - start };
      return run([cmd, ref], `${cmd} ${ref}`);
    }

    // ── Fill ─────────────────────────────────────────────────────────────────
    // For standard input/textarea fields. For contenteditable use keyboard-type.
    case 'fill': {
      const ref = normalizeRef(selector || _refField);
      if (!ref) return { ok: false, action, sessionId, error: 'selector required for fill', executionTime: Date.now() - start };
      const fillText = (text ?? value) || '';
      return run(['fill', ref, fillText], `fill ${ref}`);
    }

    // ── Type ─────────────────────────────────────────────────────────────────
    case 'type': {
      const ref = normalizeRef(selector || _refField);
      if (!ref) return { ok: false, action, sessionId, error: 'selector required for type', executionTime: Date.now() - start };
      return run(['type', ref, text || ''], `type ${ref}`);
    }

    // ── Keyboard type — types at current focus (contenteditable, AI chat, etc.)
    // This is the correct approach for Gmail body, Notion, any rich-text editor.
    // No selector needed — chrome focuses the element before calling this.
    case 'keyboard-type': {
      return run(['keyboard', 'type', text || ''], `keyboard type`);
    }

    // ── Press key ────────────────────────────────────────────────────────────
    case 'press':
    case 'keyboard': {
      const pressKey = key || text || '';
      return run(['press', pressKey], `press ${pressKey}`);
    }

    // ── Select dropdown ──────────────────────────────────────────────────────
    case 'select': {
      const ref = normalizeRef(selector || _refField);
      if (!ref) return { ok: false, action, sessionId, error: 'selector required for select', executionTime: Date.now() - start };
      return run(['select', ref, value || ''], `select ${ref}`);
    }

    // ── Check / Uncheck ──────────────────────────────────────────────────────
    case 'check': {
      const ref = normalizeRef(selector || _refField);
      return run(['check', ref], `check ${ref}`);
    }
    case 'uncheck': {
      const ref = normalizeRef(selector || _refField);
      return run(['uncheck', ref], `uncheck ${ref}`);
    }

    // ── Hover ────────────────────────────────────────────────────────────────
    case 'hover': {
      const ref = normalizeRef(selector || _refField);
      return run(['hover', ref], `hover ${ref}`);
    }

    // ── Scroll ───────────────────────────────────────────────────────────────
    case 'scroll': {
      const scrollDir = args.direction || direction || 'down';
      const scrollPx  = String(args.dy || dy || 300);
      return run(['scroll', scrollDir, scrollPx], `scroll ${scrollDir} ${scrollPx}`);
    }

    // ── Drag ─────────────────────────────────────────────────────────────────
    case 'drag': {
      const src = normalizeRef(selector || _refField);
      const dst = normalizeRef(target || args.targetSelector);
      if (!src || !dst) return { ok: false, action, sessionId, error: 'selector and target required for drag', executionTime: Date.now() - start };
      return run(['drag', src, dst], `drag ${src} → ${dst}`);
    }

    // ── Dialog ───────────────────────────────────────────────────────────────
    case 'dialog-accept': {
      const prompt = args.prompt || text;
      return run(prompt ? ['dialog', 'accept', prompt] : ['dialog', 'accept'], 'dialog accept');
    }
    case 'dialog-dismiss': {
      return run(['dialog', 'dismiss'], 'dialog dismiss');
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    case 'screenshot': {
      const outPath = filePath || path.join(os.tmpdir(), `ab_screenshot_${sessionId}_${Date.now()}.png`);
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

    // ── Eval — browser-side JavaScript only ──────────────────────────────────
    // document, window, fetch are available. NO page object. NO require().
    // agent-browser returns the result directly in stdout (no ### Result wrapper).
    case 'eval':
    case 'evaluate': {
      const expr = code || text || selector || args.expression || '';
      if (!expr) return { ok: false, action, sessionId, error: 'code/expression required for eval', executionTime: Date.now() - start };
      const res = await cliRun([...S, 'eval', expr], timeoutMs);
      const result = (res.stdout || '').trim();
      return {
        ok:            res.ok,
        action,
        sessionId,
        result,
        stdout:        res.stdout,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error || res.stderr?.trim(),
      };
    }

    // ── getPageText — returns document.body.innerText via eval ───────────────
    case 'getPageText': {
      const expr = `document.body.innerText.slice(0,50000)`;
      const res = await cliRun([...S, 'eval', expr], Math.min(timeoutMs, 20000));
      const pageText = (res.stdout || '').trim();
      const effectiveOk = res.ok || pageText.length > 0;
      return {
        ok:            effectiveOk,
        action,
        sessionId,
        result:        pageText,
        stdout:        res.stdout,
        executionTime: Date.now() - start,
        error:         effectiveOk ? undefined : res.error,
      };
    }

    // ── waitForStableText — wait for networkidle ──────────────────────────────
    case 'waitForStableText':
    case 'waitForNavigation': {
      return run(['wait', '--load', 'networkidle'], 'wait networkidle');
    }

    // ── wait-url / wait-text — declarative waits ──────────────────────────────
    case 'wait-url': {
      const urlPattern = args.pattern || pattern || '';
      return run(['wait', '--url', urlPattern], `wait url ${urlPattern}`);
    }
    case 'wait-text': {
      const textPattern = args.text || text || '';
      return run(['wait', '--text', textPattern], `wait text "${textPattern}"`);
    }
    case 'waitForSelector': {
      if (!selector || /^body$/i.test(selector.trim())) {
        await new Promise(r => setTimeout(r, 1500));
        return { ok: true, action, sessionId, result: 'body', executionTime: Date.now() - start };
      }
      return run(['wait', selector], `wait selector ${selector}`);
    }
    case 'waitForContent': {
      const needle = text || selector || '';
      return run(['wait', '--text', needle], `wait text "${needle}"`);
    }

    // ── Semantic find commands — fallbacks when refs are stale ────────────────
    case 'find-role': {
      const findRole = role || args.role || '';
      const findAction = args.findAction || 'click';
      const findName = roleName || args.name;
      const roleArgs = ['find', 'role', findRole, findAction];
      if (findName) roleArgs.push('--name', findName);
      return run(roleArgs, `find role ${findRole} ${findAction}${findName ? ` name="${findName}"` : ''}`);
    }
    case 'find-label': {
      const findLabel = label || args.label || '';
      const findAction = args.findAction || 'click';
      const findValue = value || args.value;
      const labelArgs = ['find', 'label', findLabel, findAction];
      if (findValue) labelArgs.push(findValue);
      return run(labelArgs, `find label "${findLabel}" ${findAction}`);
    }
    case 'find-text': {
      const findText = text || args.text || '';
      return run(['find', 'text', findText, 'click'], `find text "${findText}"`);
    }

    // ── Get URL / Get Title ───────────────────────────────────────────────────
    case 'get-url': {
      const res = await cliRun([...S, 'get', 'url'], 5000);
      const currentUrl = parseGetUrl(res.stdout);
      return { ok: res.ok, action, sessionId, result: currentUrl, executionTime: Date.now() - start };
    }
    case 'get-title': {
      const res = await cliRun([...S, 'get', 'title'], 5000);
      return { ok: res.ok, action, sessionId, result: (res.stdout || '').trim(), executionTime: Date.now() - start };
    }

    // ── State save / load ─────────────────────────────────────────────────────
    // agent-browser auto-persists via --session-name, so explicit save/load
    // is only needed for cross-session state transfer or backup.
    case 'state-save': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'ab-sessions', `${sanitizeSessionName(sessionId)}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return run(['state', 'save', p], `state save ${p}`);
    }
    case 'state-load': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'ab-sessions', `${sanitizeSessionName(sessionId)}.json`);
      return run(['state', 'load', p], `state load ${p}`);
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    case 'tab-new': {
      const res = await cliRun([...S, 'tab', 'new', ...(url ? [url] : [])], timeoutMs);
      return { ok: res.ok, action, sessionId, result: res.stdout?.trim(), executionTime: Date.now() - start, error: res.ok ? undefined : res.error };
    }
    case 'tab-list':   return run(['tab'], 'tab list');
    case 'tab-select': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab', String(idx)], `tab select ${idx}`);
    }
    case 'tab-close': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab', 'close', String(idx)], `tab close ${idx}`);
    }

    // ── waitForAuth ───────────────────────────────────────────────────────────
    // Polls current URL via `get url` until the browser has left the sign-in path.
    // Uses agent-browser's --session-name so auth state auto-persists after success.
    //
    // Returns:
    //   { ok: true,  authResolved: true }  — left the sign-in page
    //   { ok: false, authTimedOut: true }  — 120s timeout
    case 'waitForAuth': {
      let authSignInPath = null;
      let authOriginHost = null;
      try {
        if (url) {
          const _u = new URL(url);
          authSignInHost = _u.hostname;
          authSignInPath = _u.pathname;
          authOriginHost = _u.hostname;
        }
      } catch (_) {}

      const effectiveTimeout = Math.min(timeoutMs || 120000, 120000);
      const pollInterval = 2000;

      // Step 1 — Open sign-in URL (triggers --session-name to bind persistence)
      if (url) {
        const navRes = await cliRun([...S, 'open', url], 30000);
        logger.info(`[agentbrowser.act] waitForAuth: opened ${url} ok=${navRes.ok}`);
      }

      const deadline = Date.now() + effectiveTimeout;
      logger.info(`[agentbrowser.act] waitForAuth: polling for auth completion on session=${sessionId} (timeout=${effectiveTimeout}ms)`);

      // Step 2 — Immediately notify user via callback
      let loginNotificationSent = false;
      const sendLoginNotification = () => {
        if (loginNotificationSent || !_progressCallbackUrl) return;
        loginNotificationSent = true;
        const serviceDisplay = sessionId.replace(/_agent$/, '');
        logger.info(`[agentbrowser.act] waitForAuth: notifying user — loginUrl=${url} session=${sessionId}`);
        notifyUser(_progressCallbackUrl, {
          type: 'needs_login',
          sessionId,
          loginUrl: url,
          serviceDisplay,
          message: `Please sign in to **${serviceDisplay}** in the Chrome window that just opened (${url}).`,
        });
      };

      let consecutiveEmpty = 0;

      // Step 3 — Poll
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));

        try {
          const urlRes = await cliRun([...S, 'get', 'url'], 5000);
          const currentUrl = parseGetUrl(urlRes.stdout);

          // Empty / non-http — browser may be loading or crashed
          if (!currentUrl || !currentUrl.startsWith('http')) {
            consecutiveEmpty++;
            logger.debug(`[agentbrowser.act] waitForAuth: empty url poll ${consecutiveEmpty} for session=${sessionId}`);
            if (consecutiveEmpty >= 5 && url) {
              // Browser likely crashed — re-open sign-in page
              logger.info(`[agentbrowser.act] waitForAuth: browser likely crashed (${consecutiveEmpty} empty polls) — re-opening ${url}`);
              consecutiveEmpty = 0;
              loginNotificationSent = false; // reset so notification fires again after re-open
              await cliRun([...S, 'open', url], 30000).catch(() => {});
            }
            continue;
          }
          consecutiveEmpty = 0;

          let currentPath = '';
          let currentHost = '';
          try {
            const _cu = new URL(currentUrl);
            currentPath = _cu.pathname;
            currentHost = _cu.hostname;
          } catch (_) {}

          const onSignInPath = authSignInPath && currentPath === authSignInPath;
          const onAuthPath   = /\/(login|signin|sign-in|sign_in|auth|oauth|authorize)\b/i.test(currentPath);

          if (onSignInPath || onAuthPath) {
            // Still on login page — notify user and keep polling
            sendLoginNotification();
            logger.debug(`[agentbrowser.act] waitForAuth: still on auth path ${currentUrl} (${Math.round((deadline - Date.now()) / 1000)}s remaining)`);
            continue;
          }

          // For cross-domain services (e.g. Gmail: accounts.google.com → mail.google.com)
          // verify we reached the success URL if provided
          if (authSuccessUrl && !currentUrl.includes(authSuccessUrl)) {
            // We left the login path but haven't reached success URL yet — still in OAuth flow
            sendLoginNotification();
            logger.debug(`[agentbrowser.act] waitForAuth: left auth path but not at success URL yet (${currentUrl}) for session=${sessionId}`);
            continue;
          }

          // Left the sign-in path → auth complete
          logger.info(`[agentbrowser.act] waitForAuth: success — left sign-in path (${authSignInPath || 'auth'} → ${currentPath}) for session=${sessionId}`);
          return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };

        } catch (pollErr) {
          logger.debug(`[agentbrowser.act] waitForAuth: poll error — ${pollErr.message?.slice(0, 60)}`);
        }
      }

      logger.warn(`[agentbrowser.act] waitForAuth: timed out after ${effectiveTimeout}ms on session=${sessionId}`);
      return {
        ok: false, action, sessionId,
        authTimedOut: true,
        error: `waitForAuth: timed out (${effectiveTimeout}ms) — authentication not completed`,
        executionTime: Date.now() - start,
      };
    }

    // ── scanCurrentPage ───────────────────────────────────────────────────────
    // Returns snapshot text + current URL for pre-scan
    case 'scanCurrentPage': {
      const [snapRes, urlRes] = await Promise.all([
        cliRun([...S, 'snapshot', '-i'], timeoutMs),
        cliRun([...S, 'get', 'url'], 5000),
      ]);
      return {
        ok:            snapRes.ok,
        action,
        sessionId,
        result: {
          url:      parseGetUrl(urlRes.stdout) || '',
          snapshot: (snapRes.stdout || '').trim(),
        },
        executionTime: Date.now() - start,
      };
    }

    // ── Fallback passthrough ──────────────────────────────────────────────────
    default: {
      logger.warn(`[agentbrowser.act] Unknown action "${action}" — attempting direct passthrough`);
      const passArgs = [action];
      if (url)      passArgs.push(url);
      if (selector) passArgs.push(normalizeRef(selector));
      return run(passArgs, action);
    }
  }
}

module.exports = { agentbrowserAct };
