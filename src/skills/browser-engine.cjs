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

const _sessions = new Map();
const _telRe = /analytics|telemetry|beacon|metrics|sentry|collect|jot|log_event|track|amplitude|datadog|newrelic|rum|perf/i;

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
  page.on('response', (res) => {
    try {
      const m = res.request().method();
      if (!/^(POST|PUT|PATCH|DELETE)$/i.test(m)) return;
      const u = res.url();
      if (_telRe.test(u)) return;
      netLog.push({ method: m.toUpperCase(), url: u, status: res.status(), ts: Date.now() });
      if (netLog.length > 100) netLog.shift();
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

  const ctx = await getChromium().launchPersistentContext(profileDir, {
    headless: !headed,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  });

  const netLog = [];
  const pages = ctx.pages();
  ctx.on('page', (p) => _attachNetLog(p, netLog));
  for (const p of pages) _attachNetLog(p, netLog);

  // Register ad-block interception (route blocking + init script) for all future navigations
  await setupInterceptionNode(ctx, sessionId);

  _sessions.set(sessionId, { context: ctx, netLog, refMaps: new Map(), activePage: pages.find((p) => !/^about:blank$/i.test(p.url())) || pages[0] || null });
  logger.info(`[browser-engine] session=${sessionId} launched (${pages.length} page(s))`);
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

// ── Ref tree: ariaSnapshot() → e1/e2/... refs + YAML ──────────────────────
// page.ariaSnapshot() returns a YAML-like string:
//   - heading "Example Domain" [level=1]
//   - paragraph:
//     - link "Learn more":
//       - /url: https://...
// We parse it, assign e1/e2/... refs, and build a refMap for locator resolution.

async function buildRefTree(page) {
  const raw = await page.ariaSnapshot();
  const refMap = new Map();
  let counter = 1;
  const outLines = [];

  // Parse each line: extract indent depth, role, name, attributes
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // Measure indent (spaces before the leading dash)
    const indentMatch = line.match(/^(\s*)-/);
    if (!indentMatch) {
      // Continuation lines (e.g. "  - /url: ...") — pass through without ref
      outLines.push(line);
      continue;
    }
    const indent = indentMatch[1];
    const rest = line.slice(indentMatch[0].length).trimStart(); // after "- " (trimStart handles the space after dash)

    // Extract role and name: "heading \"Example Domain\" [level=1]" or "paragraph:" or "link \"Learn more\":"
    const ref = `e${counter++}`;
    // Insert [ref=eN] right after the dash
    outLines.push(`${indent}- [${ref}] ${rest}`);

    // Parse role and name for refMap
    const roleMatch = rest.match(/^(\w[\w-]*)/);
    const nameMatch = rest.match(/"([^"]*)"/);
    const name = nameMatch ? nameMatch[1] : '';
    let role = roleMatch ? roleMatch[1] : 'unknown';
    // If ariaSnapshot omitted the role token but gave a name, default to generic
    if (!roleMatch && name) role = 'generic';
    // Extract key attributes
    const levelMatch = rest.match(/\[level=(\d+)\]/);
    refMap.set(ref, {
      role,
      name,
      level: levelMatch ? parseInt(levelMatch[1]) : undefined,
    });
  }

  // Low-confidence flag: if >50% of refs have unknown/generic roles, role-based
  // locators are unreliable. Callers should skip role locators and use CSS/text fallback.
  let _lowConf = 0;
  for (const [, v] of refMap) {
    if (v.role === 'unknown' || v.role === 'generic') _lowConf++;
  }
  const lowConfidenceRefs = refMap.size > 0 && (_lowConf / refMap.size) > 0.5;

  return { yaml: outLines.join('\n'), refMap, lowConfidenceRefs };
}

module.exports = {
  launch, getPage, setActivePage, getContext, closeSession, listSessions, isSessionActive,
  getNetLog, clearNetLog, buildRefTree,
  sessionProfileDir, clearProfileLock,
};
