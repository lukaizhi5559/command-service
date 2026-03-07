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

// Remove Chrome's SingletonLock file so a post-crash restart can reuse the profile
// without Chrome deciding to start fresh (losing the logged-in session).
function clearProfileLock(sessionId) {
  try {
    const lockFile = path.join(sessionProfileDir(sessionId), 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      logger.info(`[browser.act] Removed stale SingletonLock for session=${sessionId}`);
    }
  } catch (_) {}
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

// ── Element ref resolution ────────────────────────────────────────────────
// Roles that are interactive input types — what we want to fill into
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'input', 'textarea']);
// Context patterns that indicate nav/sidebar/history elements — deprioritise these
const EXCLUDE_CONTEXT = /search.{0,20}(chat|history|conversation|message)|filter|sidebar|nav\b|navigation|recent|previous/i;

// Parse snapshot YAML lines into structured candidate objects
function parseSnapshotCandidates(snap) {
  const candidates = [];
  const lines = snap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match: optional indent + [eN] + role + "label" + optional attributes
    const m = line.match(/^(\s*)-?\s*\[?(e\d+)\]?\s+(\w[\w-]*)\s+"([^"]*)"(.*)/i);
    if (!m) continue;
    const [, indent, ref, role, label, attrs] = m;
    candidates.push({
      ref,
      role: role.toLowerCase(),
      label,
      attrs,
      depth: indent.length, // deeper = more nested = more likely to be a sub-element
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
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(sessionId) || '';
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
function resolveRefForClick(sessionId, labelOrRef) {
  if (!labelOrRef) return null;
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(sessionId) || '';
  if (!snap) return null;

  const candidates = parseSnapshotCandidates(snap);
  let best = null, bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidateForClick(cand, labelOrRef);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && bestScore > 0) {
    logger.info(`[browser.act] resolveRefForClick "${labelOrRef}" → ${best.ref} (${best.role} "${best.label}" score=${bestScore})`);
    return best.ref;
  }
  return null;
}

// Async resolver: tries scored pick first, falls back to phi4 LLM when ambiguous
async function resolveRefSmart(sessionId, labelOrRef, intentHint) {
  if (!labelOrRef) return null;
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(sessionId) || '';
  if (!snap) return null;

  const candidates = parseSnapshotCandidates(snap);
  // Score all candidates
  const scored = candidates
    .map(c => ({ ...c, score: scoreCandidateForSelector(c, labelOrRef) }))
    .filter(c => c.score > -Infinity)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const top = scored[0];
  const second = scored[1];

  // Clear winner: top score is 50+ points ahead of second, or only one candidate
  const CLEAR_MARGIN = 50;
  if (!second || (top.score - second.score) >= CLEAR_MARGIN) {
    logger.info(`[browser.act] resolveRefSmart clear winner: ${top.ref} (${top.role} "${top.label}" score=${top.score})`);
    return top.ref;
  }

  // Ambiguous — ask the LLM backend (ws://localhost:4000/ws/stream) to pick the right element
  logger.info(`[browser.act] resolveRefSmart ambiguous top2: ${top.ref}(${top.score}) vs ${second.ref}(${second.score}) — asking LLM`);
  try {
    const skillLlm = require('../skill-llm.cjs');
    const topN = scored.slice(0, Math.min(5, scored.length));
    const elementList = topN.map(c => `${c.ref}: ${c.role} "${c.label}"`).join('\n');
    const prompt = `You are selecting the correct HTML element to fill text into.\n\nUser wants to fill: "${labelOrRef}"${intentHint ? `\nContext: ${intentHint}` : ''}\n\nAvailable elements:\n${elementList}\n\nRespond with ONLY the ref (e.g. e4). No explanation.`;
    const answer = await skillLlm.ask(prompt, { temperature: 0.0, responseTimeoutMs: 8000 });
    const pickedRef = (answer || '').trim().match(/^(e\d+)/i)?.[1];
    if (pickedRef && scored.find(c => c.ref === pickedRef)) {
      logger.info(`[browser.act] resolveRefSmart LLM picked: ${pickedRef}`);
      return pickedRef;
    }
  } catch (err) {
    logger.warn(`[browser.act] resolveRefSmart LLM fallback failed: ${err.message}`);
  }

  // LLM failed or gave bad answer — fall back to top scored candidate
  logger.info(`[browser.act] resolveRefSmart LLM fallback to top: ${top.ref}`);
  return top.ref;
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
      // Before cold-starting, remove any stale SingletonLock from a previous crash
      if (!alreadyOpen) clearProfileLock(sessionId);
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
      // After navigation, auto-dismiss Chrome "Restore pages" crash-recovery dialog.
      // This is a native browser UI bubble — NOT in the page DOM — so eval won't work.
      // Press Escape to dismiss it, then wait for page to settle.
      if (res.ok) {
        await new Promise(r => setTimeout(r, 700));
        const bodyText = await cliRun([...S, 'eval', 'document.body.innerText'], 3000);
        if (/restore pages?\?|chrome didn't shut down|didn't shut down correctly/i.test(bodyText.stdout || '')) {
          logger.info(`[browser.act] Chrome restore dialog detected after navigate — pressing Escape to dismiss`);
          await cliRun([...S, 'press', 'Escape'], 3000);
          await new Promise(r => setTimeout(r, 500));
          // Double-tap Escape in case dialog needs two dismissals
          await cliRun([...S, 'press', 'Escape'], 3000);
          await new Promise(r => setTimeout(r, 400));
        }
      }
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
      const ref = resolveRefForClick(sessionId, selector);
      if (!ref) {
        // No ref found in snapshot — eval fallback with progressive word-drop
        // "Bible Study Project" → tries "Bible Study Project", "Bible Study", "Bible"
        logger.warn(`[browser.act] click: could not resolve ref for "${selector}" — trying eval click`);
        const words = selector.trim().split(/\s+/);
        const attempts = [];
        for (let len = words.length; len >= 1; len--) {
          attempts.push(words.slice(0, len).join(' '));
        }
        // Build JS that tries each progressively shorter text
        const tryTexts = attempts.map(t => JSON.stringify(t)).join(', ');
        const evalScript = `
          (function() {
            const texts = [${tryTexts}];
            for (const t of texts) {
              const el = document.querySelector('[aria-label="' + t + '"]')
                || [...document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],li')]
                    .find(e => e.textContent.trim() === t
                            || e.textContent.trim().startsWith(t)
                            || e.getAttribute('data-testid') === t);
              if (el) { el.click(); return 'clicked:' + t; }
            }
            return 'not-found';
          })()
        `.replace(/\s+/g, ' ').trim();
        const evalRes = await cliRun([...S, 'eval', evalScript], timeoutMs);
        const evalOut = (evalRes.stdout || '').trim();
        if (evalOut.includes('not-found') || (!evalOut.includes('clicked:') && evalRes.exitCode !== 0)) {
          logger.warn(`[browser.act] eval-click: element not found for "${selector}" — stdout: ${evalOut.slice(0, 80)}`);
          return {
            ok: false,
            action,
            sessionId,
            result: evalOut,
            executionTime: Date.now() - start,
            error: `Element not found: "${selector}" — could not locate a matching link, button, or item on the page`,
          };
        }
        logger.info(`[browser.act] eval-click "${selector}" → ${evalOut}`, { stderr: evalRes.stderr?.slice(0, 80) });
        return { ok: true, action, sessionId, result: evalOut, executionTime: Date.now() - start };
      }
      return run([cmd, ref], `${cmd} ${ref}`);
    }

    // ── Fill / Type ─────────────────────────────────────────────────────────
    case 'fill': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      // Use intent-aware smart resolver: scored snapshot matching + phi4 LLM for ambiguous cases
      const ref = await resolveRefSmart(sessionId, selector, text);
      const fillTarget = ref || selector;
      logger.info(`[browser.act] fill resolved: "${selector}" → ${ref ? `ref ${ref}` : `direct selector "${selector}"`}`);
      const fillRes = await cliRun([...S, 'fill', fillTarget, text || ''], timeoutMs);
      logger.info(`[browser.act] fill ${fillTarget} → exit ${fillRes.exitCode}`, { stderr: fillRes.stderr?.slice(0, 200) });

      // playwright-cli exits 0 even on fill errors — check stdout for error markers
      // Two cases: (1) contenteditable div → "Element is not an <input>" → click+type fallback
      //            (2) ref not found → try click+type on same ref
      const NOT_INPUT_ERR = /Element is not an? <(input|textarea|select)|Ref .+ not found/i;
      const stdoutHasErr = NOT_INPUT_ERR.test(fillRes.stdout || '') || NOT_INPUT_ERR.test(fillRes.stderr || '');

      if (stdoutHasErr) {
        // The resolved element is a contenteditable div (common on AI chat UIs).
        // Fall back to: click to focus → select-all → type keystrokes.
        // resolveRefSmart already found the intent-correct element — we just use a
        // different interaction method, not a different element.
        logger.info(`[browser.act] fill not-input → click+type fallback on same target "${fillTarget}"`);
        await cliRun([...S, 'click', fillTarget], timeoutMs);
        await cliRun([...S, 'press', 'Meta+a'], timeoutMs);
        const typeRes = await cliRun([...S, 'type', text || ''], timeoutMs);
        logger.info(`[browser.act] click+type → exit ${typeRes.exitCode}`);
        return {
          ok: typeRes.ok,
          action, sessionId,
          result: typeRes.stdout.trim() || undefined,
          stdout: typeRes.stdout,
          executionTime: Date.now() - start,
          error: typeRes.ok ? undefined : typeRes.error || typeRes.stderr?.trim(),
        };
      }

      return {
        ok: fillRes.ok,
        action,
        sessionId,
        result: fillRes.stdout.trim() || undefined,
        stdout: fillRes.stdout,
        executionTime: Date.now() - start,
        error: fillRes.ok ? undefined : fillRes.error || fillRes.stderr?.trim(),
      };
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
      // Auth-wall patterns — text that indicates a login/sign-in page, not real content
      const AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple|sign in to x|sign in with google|sign in with apple|login to|log into|happening now|where should we begin)\b/i;
      const AUTH_WALL_BODY = /\b(sign in|log in|sign up|join today|create account)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password|sign up with|continue with)\b/i;
      // Logged-out UI patterns — sites that show a guest/unauthenticated landing page
      const AUTH_WALL_LOGGEDOUT = /\b(log in|sign in|sign up for free)\b[\s\S]{0,200}\b(where should we begin|get started|create account|free account|try for free)\b/i;
      // Chrome crash-restore dialog
      const RESTORE_DIALOG = /restore pages?\?|chrome didn't shut down correctly|help make google chrome better/i;

      let prev = '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await cliRun([...S, 'eval', 'document.body.innerText'], 5000);
        const cur = r.stdout.trim();

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

        if (cur && cur === prev) {
          // Check if stable content is an auth wall
          const firstLine = cur.split('\n')[0].trim();
          const isAuthWall = AUTH_WALL_FIRST.test(firstLine) || AUTH_WALL_BODY.test(cur.slice(0, 500)) || AUTH_WALL_LOGGEDOUT.test(cur.slice(0, 600));
          if (isAuthWall) {
            logger.info(`[browser.act] waitForStableText: auth wall detected for session=${sessionId}`);
            // Return authRequired:true and EMPTY stdout so synthesize knows this site had no data
            return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: cur.slice(0, 100), executionTime: Date.now() - start };
          }
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
    // tab-new: opens a new tab; if url provided, navigates to it in the new tab
    case 'tab-new': {
      const tabNewRaw = await cliRun([...S, 'tab-new'], timeoutMs);
      logger.info(`[browser.act] tab-new → exit ${tabNewRaw.exitCode}`, { stderr: tabNewRaw.stderr?.slice(0, 100) });
      if (!tabNewRaw.ok) {
        return { ok: false, action, sessionId, error: tabNewRaw.error || tabNewRaw.stderr?.trim(), executionTime: Date.now() - start };
      }
      // Clear stale snapshot cache — new tab has a fresh page, old refs are invalid
      snapshotCache.delete(sessionId);
      if (url) {
        // Give playwright-cli a moment to register the new tab
        await new Promise(r => setTimeout(r, 400));
        // Get current tab list to find the index of the new (last) tab
        const listRaw = await cliRun([...S, 'tab-list'], 5000);
        const tabCount = ((listRaw.stdout || '').match(/^\s*-\s+\d+:/gm) || []).length;
        const lastIdx = Math.max(0, tabCount - 1);
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
          result: listRaw.stdout.trim() || undefined,
          stdout: gotoRaw.stdout || listRaw.stdout,
          executionTime: Date.now() - start,
          error: gotoRaw.ok ? undefined : gotoRaw.error || gotoRaw.stderr?.trim(),
        };
      }
      return {
        ok: true,
        action,
        sessionId,
        result: tabNewRaw.stdout.trim() || undefined,
        stdout: tabNewRaw.stdout,
        executionTime: Date.now() - start,
      };
    }
    case 'tab-list':   return run(['tab-list'], 'tab-list');
    // Accept tabIndex (LLM convention) or index (legacy)
    case 'tab-close': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab-close', String(idx)], `tab-close ${idx}`);
    }
    case 'tab-select': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab-select', String(idx)], `tab-select ${idx}`);
    }

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
      await captureSnapshot(sessionId, headed, timeoutMs);
      const snap = snapshotCache.get(sessionId) || '';
      const urlRes = await cliRun([...S, 'eval', 'location.href'], 3000);
      const pageUrl = urlRes.stdout.trim() || 'unknown';
      const titleRes = await cliRun([...S, 'eval', 'document.title'], 3000);
      const pageTitle = titleRes.stdout.trim() || '';

      if (!snap) {
        return { ok: false, action, sessionId, error: 'No snapshot available for examination', executionTime: Date.now() - start };
      }

      // 2. Parse snapshot into candidates (structured ARIA data)
      const candidates = parseSnapshotCandidates(snap);

      // 3. Fast-path heuristic checks before calling LLM
      // Check for prominent auth elements (saves LLM call for obvious cases)
      const AUTH_LABELS = /^(log in|sign in|sign in to|sign up|sign up for free|create account|get started|login|signin|join free|join now)$/i;
      const authEl = candidates.find(c =>
        (c.role === 'link' || c.role === 'button') &&
        AUTH_LABELS.test(c.label.trim()) &&
        c.depth <= 24
      );

      // Build a compact element summary for LLM (top 60 most relevant)
      const elementSummary = candidates
        .filter(c => c.role !== 'generic' && c.role !== 'none' && c.label.length > 1)
        .slice(0, 60)
        .map(c => `[${c.role}] "${c.label}"${c.attrs ? ' ' + c.attrs.slice(0, 60) : ''}`)
        .join('\n');

      // 4. LLM diagnosis
      let diagnosis = null;
      try {
        const { ask } = require('../skill-llm.cjs');
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
          const db = require('../skill-db.cjs');
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
