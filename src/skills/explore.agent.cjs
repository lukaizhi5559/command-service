'use strict';
// ---------------------------------------------------------------------------
// explore.agent.cjs — Unified navigate + explore loop agent
//
// Accepts a goal + seed URL and autonomously:
//   Phase 0   : Navigate to the URL (fast-path auth hint via KNOWN_BROWSER_SERVICES)
//   Phase 0.5 : Detect + resolve login walls (waitForAuth → full Phase 0 restart)
//   Phase 1   : Validate (and optionally evict) learned context_rules
//   Phase 2   : Immediate goal-check on the landing page
//   Phase 3   : Explore loop — score nav items, LLM picks click/search/goal_met/none
//               Fast-path: if domain map has verified selectors, use_cached skips LLM scoring
//
// Mode A (execute) — goal-driven, uses cached domain map selectors when available
// Mode B (scan)    — no goal, background probing, builds domain map for a site
//
// Scan triggers:
//   1. Post-automation (lazy, fired by browser.agent after successful run)
//   2. Maintenance Scan — idle-triggered (30min idle + 24h cooldown) or user/scheduled
//   3. Self-heal on failure (_resolveLocator all-fallbacks-fail)
//
// Domain maps stored at: ~/.thinkdrop/domain-maps/<hostname>.json
// Called from browser.agent.cjs `actionExplore()`.
// ---------------------------------------------------------------------------

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const skillDb = require('../skill-helpers/skill-db.cjs');

const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const logger             = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BROWSER_ACT_PORT      = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const SCREEN_SERVICE_PORT   = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const AGENT_BROWSER_PROFILE = path.join(os.homedir(), '.thinkdrop', 'agent-profile');
const DOMAIN_MAPS_DIR       = path.join(os.homedir(), '.thinkdrop', 'domain-maps');
const AGENTS_DIR            = path.join(os.homedir(), '.thinkdrop', 'agents');

const MAP_STALE_MS          = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MAP_LAZY_RESCAN_MS    = 24 * 60 * 60 * 1000;       // 24 hours (post-automation gate)
const OVERLAY_PORT          = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);

// Known browser services map — isOAuth=true means skip dynamic login detection and
// go straight to waitForAuth. Shared reference with browser.agent.cjs.
const KNOWN_BROWSER_SERVICES = (() => {
  try { return require('./browser.agent.cjs').KNOWN_BROWSER_SERVICES || {}; }
  catch (_) { return {}; }
})();

// ---------------------------------------------------------------------------
// LLM System Prompts
// ---------------------------------------------------------------------------

const GOAL_CHECK_PROMPT = `You are a browser automation agent checking whether the current page already satisfies a user goal.
Given the GOAL and the SNAPSHOT (YAML accessibility tree), reply ONLY with a JSON object:
{
  "satisfied": true|false,
  "result": "<extracted answer or empty string>",
  "confidence": 0.0-1.0
}
Rules:
- satisfied=true only when the page clearly contains the answer or the requested content.
- result should contain the extracted answer (≤500 chars).
- confidence should reflect how certain you are.
- If unsure, return satisfied=false with confidence<0.5.
Reply with ONLY valid JSON, no preamble.`;

const EXPLORE_PICK_PROMPT = `You are a browser navigation expert. Given a GOAL, a list of scored navigation items (label + score), the current URL, a VISITED set, and optionally a CACHED_ACTIONS map, pick the SINGLE best action to take.
Reply ONLY with a valid JSON object:
{
  "decision": "click"|"search"|"goal_met"|"none"|"need_login"|"use_cached",
  "ref": "@eN or null",
  "label": "<chosen item label or empty>",
  "cachedActionKey": "<key from CACHED_ACTIONS — only when decision=use_cached>",
  "searchQuery": "<query string — only when decision=search>",
  "rationale": "<one line why>"
}
Decision rules:
- "use_cached"  → CACHED_ACTIONS has a pre-mapped action that directly matches the goal step (fastest path).
- "click"       → follow a nav item that likely leads toward the goal.
- "search"      → a search box is the best route (fill it + press Enter).
- "goal_met"    → the current page already appears to satisfy the goal.
- "need_login"  → a login wall or auth gate is blocking access.
- "none"        → goal cannot be reached from current page; go back to anchor.
NEVER revisit a URL already in VISITED. Prefer use_cached when a matching cached action exists.
Reply with ONLY valid JSON, no preamble.`;

const RULE_VALIDATE_PROMPT = `You are a browser automation verifier. A learned path rule describes steps previously used to reach a goal from a specific starting page.
Given the RULE TEXT and the CURRENT PAGE SNAPSHOT, decide whether the current page looks like the expected starting checkpoint described in the rule.
Reply ONLY with a valid JSON object:
{
  "valid": true|false,
  "reason": "<one line explanation>"
}
valid=true  → the page layout matches what the rule expects (safe to follow the rule).
valid=false → the page has changed significantly since the rule was recorded (rule is stale, discard it).
Reply with ONLY valid JSON, no preamble.`;

const STABLE_SELECTOR_PROMPT = `You are a Lead Automation Engineer. Given a DOM element's attributes extracted from a live page, produce a "Resilient Identity Profile" — a set of stable selectors that will survive minor website redesigns.

Selector priority rules:
  Rank 1 (User Intent): ARIA labels, roles, visible text — e.g. button:has-text("Log in"), [aria-label="Search"]
  Rank 2 (Developer Intent): data-testid, data-qa, id attributes — e.g. [data-testid="login-button"]
  Rank 3 (Structural): Simple CSS — avoid fragile chains. e.g. header .login-btn (not div>div>span>button)

Reply ONLY with a valid JSON object:
{
  "locators": {
    "primary": "<most stable selector — prefer Rank 1>",
    "fallback_1": "<second selector using different attribute>",
    "fallback_2": "<text-based or role-based selector>"
  },
  "fingerprint": {
    "tag": "<tagName>",
    "text": "<visible text, ≤60 chars or null>",
    "aria_label": "<aria-label or null>",
    "data_testid": "<data-testid or null>"
  },
  "success_criteria": {
    "expected_url_change": true|false,
    "element_to_appear": "<selector for confirmation element, or null>"
  }
}
Never use temporary refs like e1, e12 as selectors. Never produce empty string selectors.
Reply with ONLY valid JSON, no preamble.`;

const STATE_IDENTIFY_PROMPT = `You are a browser automation expert. Given a page snapshot and current URL, identify the canonical "page state" — a stable, reusable key describing what type of page this is.
Reply ONLY with a valid JSON object:
{
  "state_key": "<snake_case key, e.g. landing_page_logged_out | search_results | user_dashboard | login_modal>",
  "identification": "<one-line description of how to detect this state, e.g. URL='/' AND Login button visible>"
}
Rules:
- state_key must be lowercase snake_case, ≤40 chars
- Be specific: "landing_page_logged_out" not "home"
- Focus on auth state + page type as the two axes
Reply with ONLY valid JSON, no preamble.`;

// ---------------------------------------------------------------------------
// HTTP helper — POST to browser.act (same as callBrowserAct in browser.agent.cjs)
// ---------------------------------------------------------------------------
function _browserAct(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ payload: { skill: 'browser.act', args } });
    const req = http.request({
      hostname: '127.0.0.1',
      port: BROWSER_ACT_PORT,
      path: '/command.automate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw).data || JSON.parse(raw)); }
        catch (e) { reject(new Error('explore.agent browser.act parse error: ' + e.message)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('explore.agent browser.act timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// JSON parser — tolerates markdown code fences
// ---------------------------------------------------------------------------
function _parseJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// ---------------------------------------------------------------------------
// Progress event poster — non-fatal HTTP POST to a callback URL
// ---------------------------------------------------------------------------
function _postProgress(callbackUrl, event) {
  if (!callbackUrl) return;
  try {
    const body = JSON.stringify(event);
    const u = new URL(callbackUrl);
    const req = http.request({
      hostname: u.hostname,
      port: parseInt(u.port || '80', 10),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Domain Map I/O helpers
// ---------------------------------------------------------------------------

function _ensureMapsDir() {
  try { fs.mkdirSync(DOMAIN_MAPS_DIR, { recursive: true }); } catch (_) {}
}

function _mapPath(hostname) {
  return path.join(DOMAIN_MAPS_DIR, `${hostname.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}

function _loadDomainMap(hostname) {
  _ensureMapsDir();
  const p = _mapPath(hostname);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { domain: hostname, version: '1.0', last_scanned: null, states: {} };
  }
}

function _saveDomainMap(hostname, map) {
  _ensureMapsDir();
  const p = _mapPath(hostname);
  try {
    map.last_scanned = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf8');
    logger.info(`[explore.agent] domain map saved: ${p}`);
  } catch (err) {
    logger.warn(`[explore.agent] failed to save domain map: ${err.message}`);
  }
}

function _isDomainMapStale(hostname, thresholdMs = MAP_STALE_MS) {
  const p = _mapPath(hostname);
  try {
    const stat = fs.statSync(p);
    return (Date.now() - stat.mtimeMs) > thresholdMs;
  } catch (_) { return true; }
}

function _domainMapExists(hostname) {
  try { fs.accessSync(_mapPath(hostname)); return true; } catch (_) { return false; }
}

/**
 * Merge new state data into an existing domain map.
 * Verified actions with failure_count < 3 are never overwritten.
 * New states/actions are always added.
 */
function _mergeDomainMap(existing, incoming) {
  const merged = { ...existing };
  for (const [stateKey, stateData] of Object.entries(incoming.states || {})) {
    if (!merged.states[stateKey]) {
      merged.states[stateKey] = stateData;
      continue;
    }
    const existingState = merged.states[stateKey];
    for (const [actionKey, actionData] of Object.entries(stateData.actions || {})) {
      const existingAction = existingState.actions?.[actionKey];
      if (existingAction && existingAction.verified && (existingAction.failure_count || 0) < 3) {
        continue;
      }
      if (!existingState.actions) existingState.actions = {};
      existingState.actions[actionKey] = actionData;
    }
  }
  // Merge content_extraction if present in incoming
  if (incoming.content_extraction) {
    merged.content_extraction = incoming.content_extraction;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Content Extraction Discovery — analyze DOM to find content selectors
// ---------------------------------------------------------------------------

async function _extractContentSignals(sessionId, headed) {
  try {
    const result = await _browserAct({
      action: 'run-code',
      code: `async page => {
        // Analyze DOM structure to find content containers
        const signals = {
          primary_selector: null,
          fallback_selector: null,
          content_type: 'unknown',
          confidence: 0,
          detected_patterns: []
        };
        
        // Check for common content patterns
        const tests = [
          { selector: 'article', type: 'article', weight: 0.9 },
          { selector: 'main', type: 'main_content', weight: 0.85 },
          { selector: '[role="main"]', type: 'main_landmark', weight: 0.8 },
          { selector: '.content, #content', type: 'content_class', weight: 0.7 },
          { selector: '[data-message-author-role]', type: 'conversation', weight: 0.9 },
          { selector: '.message, .chat-message', type: 'chat', weight: 0.8 },
          { selector: '[role="listitem"]', type: 'list_items', weight: 0.75 },
          { selector: '.email, .thread', type: 'email_thread', weight: 0.8 },
          { selector: '.prose, .answer, .response', type: 'prose_content', weight: 0.75 },
          { selector: '.result, .search-result', type: 'search_results', weight: 0.7 },
          { selector: 'table tbody tr', type: 'table_rows', weight: 0.6 },
        ];
        
        for (const test of tests) {
          try {
            const elements = await page.locator(test.selector).all();
            if (elements.length > 0) {
              const text = await page.locator(test.selector).first().innerText({ timeout: 1000 });
              if (text && text.length > 50) {
                signals.detected_patterns.push({
                  selector: test.selector,
                  type: test.type,
                  count: elements.length,
                  sample_length: text.length,
                  weight: test.weight
                });
              }
            }
          } catch (_) {}
        }
        
        // Sort by weight and pick best candidates
        signals.detected_patterns.sort((a, b) => b.weight - a.weight);
        
        if (signals.detected_patterns.length > 0) {
          signals.primary_selector = signals.detected_patterns[0].selector;
          signals.content_type = signals.detected_patterns[0].type;
          signals.confidence = signals.detected_patterns[0].weight;
          
          // Set fallback to second best if available
          if (signals.detected_patterns.length > 1) {
            signals.fallback_selector = signals.detected_patterns[1].selector;
          }
        }
        
        return signals;
      }`,
      sessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 15000
    }, 18000);
    
    if (result?.ok && result.result) {
      return result.result;
    }
    return null;
  } catch (err) {
    logger.debug(`[explore.agent] content extraction discovery failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stable selector extraction — page.evaluate() → LLM → locator profile
// ---------------------------------------------------------------------------

async function _extractStableSelectors(ref, sessionId, headed, skillName, interaction) {
  if (!ref) return null;
  try {
    const evalCode = `async page => {
      const el = page.locator('[data-ref="${ref}"], [ref="${ref}"]').first();
      try {
        const handle = await el.elementHandle({ timeout: 3000 });
        if (!handle) return null;
        return await handle.evaluate(node => ({
          tag: node.tagName.toLowerCase(),
          text: (node.innerText || node.textContent || '').trim().slice(0, 80),
          ariaLabel: node.getAttribute('aria-label'),
          dataTestId: node.getAttribute('data-testid') || node.getAttribute('data-qa'),
          role: node.getAttribute('role'),
          type: node.getAttribute('type'),
          href: node.getAttribute('href'),
          id: node.id || null,
          name: node.getAttribute('name'),
          placeholder: node.getAttribute('placeholder'),
          className: (node.className || '').slice(0, 100),
        }));
      } catch (_) { return null; }
    }`;

    const evalRes = await _browserAct({
      action: 'run-code',
      code: evalCode,
      sessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 8000,
    }, 10000).catch(() => null);

    const attrs = evalRes?.ok ? evalRes.result : null;
    if (!attrs) return null;

    const attrsText = JSON.stringify(attrs, null, 2);
    const llmRaw = await askWithMessages([
      { role: 'system', content: STABLE_SELECTOR_PROMPT },
      { role: 'user',   content: `ELEMENT_ATTRIBUTES:\n${attrsText}\n\nSKILL_NAME: ${skillName || 'unknown'}\nINTERACTION: ${interaction || 'click'}` },
    ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 12000 }).catch(() => null);

    const parsed = _parseJson(llmRaw);
    if (!parsed?.locators?.primary) return null;
    return parsed;
  } catch (err) {
    logger.warn(`[explore.agent] _extractStableSelectors failed for ${ref}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locator resolver — tries primary → fallback_1 → fallback_2 in order
// ---------------------------------------------------------------------------

async function _resolveLocator(locators, sessionId, headed) {
  if (!locators) return null;
  const order = ['primary', 'fallback_1', 'fallback_2'];
  for (const strategy of order) {
    const selector = locators[strategy];
    if (!selector) continue;
    try {
      const res = await _browserAct({
        action: 'waitForSelector',
        selector,
        sessionId,
        headed,
        chromeProfile: AGENT_BROWSER_PROFILE,
        timeoutMs: 2000,
      }, 4000).catch(() => null);
      if (res?.ok) {
        logger.info(`[explore.agent] _resolveLocator: resolved via ${strategy} = "${selector}"`);
        return { selector, strategy };
      }
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page state identifier — snapshot → canonical state key
// ---------------------------------------------------------------------------

async function _identifyPageState(snapshot, currentUrl) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: STATE_IDENTIFY_PROMPT },
      { role: 'user',   content: `CURRENT_URL: ${currentUrl || 'unknown'}\n\nSNAPSHOT:\n${snapshot.slice(0, 5000)}` },
    ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 10000 });
    const parsed = _parseJson(raw);
    return parsed?.state_key ? parsed : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Scan queue — sequential drain with concurrency cap (prevents browser flood)
// ---------------------------------------------------------------------------

const _MAX_CONCURRENT_SCANS = 1;          // never run more than 1 background scan at once
const _scanQueueSet  = new Set();          // hostnames currently queued OR active (dedup)
const _scanQueueList = [];                 // ordered pending items: { args, trigger, hostname }
let   _activeScanCount = 0;

function _drainScanQueue() {
  while (_activeScanCount < _MAX_CONCURRENT_SCANS && _scanQueueList.length > 0) {
    const { args, trigger, hostname } = _scanQueueList.shift();
    _activeScanCount++;
    logger.info(`[explore.agent] scan starting: ${hostname} (trigger=${trigger} active=${_activeScanCount} queued=${_scanQueueList.length})`);
    scanDomain({ ...args, _trigger: trigger })
      .catch(err => logger.warn(`[explore.agent] background scan failed for ${hostname}: ${err.message}`))
      .finally(() => {
        _activeScanCount--;
        _scanQueueSet.delete(hostname);
        _drainScanQueue(); // start next
      });
  }
}

function _enqueueScan(args, trigger = 'unknown') {
  let hostname;
  try { hostname = new URL(args.url).hostname.replace(/^www\./, ''); } catch (_) { return; }
  if (_scanQueueSet.has(hostname)) {
    logger.debug(`[explore.agent] scan already queued/active for ${hostname} — skipping`);
    return;
  }
  _scanQueueSet.add(hostname);
  _scanQueueList.push({ args, trigger, hostname });
  logger.info(`[explore.agent] scan queued: ${hostname} (trigger=${trigger} queueDepth=${_scanQueueList.length})`);
  _drainScanQueue();
}

// ---------------------------------------------------------------------------
// Login wall detector
// ---------------------------------------------------------------------------
const LOGIN_URL_PATTERNS = ['/login', '/signin', '/sign-in', '/auth/', '/oauth', '/accounts/'];

function _isLoginWall(snapshot, currentUrl) {
  if (currentUrl) {
    try {
      const u = new URL(currentUrl).pathname.toLowerCase();
      if (LOGIN_URL_PATTERNS.some(p => u.includes(p))) return true;
    } catch (_) {}
  }
  const t = (snapshot || '').toLowerCase();
  const signals = [
    'password', 'sign in', 'log in', 'create account',
    'forgot password', 'continue with google', 'continue with apple',
    'enter your email', 'welcome back',
  ];
  let hits = 0;
  for (const s of signals) { if (t.includes(s)) hits++; }
  return hits >= 2;
}

// ---------------------------------------------------------------------------
// Navigation item extraction — pulls ALL links + buttons from YAML snapshot
// ---------------------------------------------------------------------------
function _extractNavItems(snapshot) {
  const items = [];
  const lines = (snapshot || '').split('\n');
  const refRe = /^\s*-\s*ref=(@e\d+)/;
  let currentRef = null;
  let currentRole = null;
  let currentName = null;

  for (const line of lines) {
    const refMatch = line.match(refRe);
    if (refMatch) {
      if (currentRef && currentName && (currentRole === 'link' || currentRole === 'button')) {
        items.push({ ref: currentRef, label: currentName.trim(), role: currentRole });
      }
      currentRef  = refMatch[1];
      currentRole = null;
      currentName = null;
      continue;
    }
    if (currentRef) {
      const roleMatch = line.match(/role=["']?(\w+)/);
      if (roleMatch) currentRole = roleMatch[1].toLowerCase();
      const nameMatch = line.match(/name=["']([^"']+)/);
      if (nameMatch) currentName = nameMatch[1];
      const textMatch = line.match(/text=["']([^"']+)/);
      if (textMatch && !currentName) currentName = textMatch[1];
    }
  }
  // flush last
  if (currentRef && currentName && (currentRole === 'link' || currentRole === 'button')) {
    items.push({ ref: currentRef, label: currentName.trim(), role: currentRole });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Nav item scorer — word overlap between label and goal words (0-1)
// ---------------------------------------------------------------------------
function _scoreNavItem(label, goal) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at', 'is', 'be', 'my', 'i']);
  const goalWords = goal.toLowerCase().split(/\W+/).filter(w => w.length > 2 && !stop.has(w));
  if (goalWords.length === 0) return 0;
  const labelWords = label.toLowerCase().split(/\W+/);
  let hits = 0;
  for (const w of goalWords) {
    if (labelWords.some(lw => lw.includes(w) || w.includes(lw))) hits++;
  }
  return hits / goalWords.length;
}

// ---------------------------------------------------------------------------
// Get current URL from browser session
// ---------------------------------------------------------------------------
async function _getCurrentUrl(sessionId, headed) {
  try {
    const res = await _browserAct({
      action: 'evaluate',
      text: 'window.location.href',
      sessionId,
      headed,
      timeoutMs: 5000,
    }, 8000);
    return (res?.ok && typeof res?.result === 'string') ? res.result : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Learn successful navigation path as a context rule
// ---------------------------------------------------------------------------
async function _learnPath(agentId, history, goal, hostname) {
  if (!history || history.length < 1) return;
  try {
    const pathSummary = history.map(h => h.label || h.url || '').filter(Boolean).join(' → ');
    const ruleText = `For "${goal.slice(0, 40)}": ${pathSummary}`.slice(0, 150);
    await skillDb.setContextRule(agentId, ruleText, 'agent');
    if (hostname) await skillDb.setContextRule(hostname, ruleText, 'site');
    logger.info(`[explore.agent] learned path saved: "${ruleText}"`);
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
async function exploreAgent(args) {
  const {
    goal,
    url:          anchorUrl,
    agentId       = 'explore_agent',
    sessionId:    callerSessionId,
    maxDepth      = 4,
    maxNavItems   = 20,
    mode          = 'execute',
    _progressCallbackUrl,
  } = args || {};

  // Mode B — scan (no goal required, background probing)
  if (mode === 'scan') {
    if (!anchorUrl) throw new Error('[explore.agent] url is required for scan mode');
    return scanDomain({ url: anchorUrl, agentId, sessionId: callerSessionId, _progressCallbackUrl });
  }

  if (!goal)      throw new Error('[explore.agent] goal is required');
  if (!anchorUrl) throw new Error('[explore.agent] url is required');

  const start           = Date.now();
  const exploreSessionId = callerSessionId || `${agentId}_explore`;
  const headed          = true;

  let hostname;
  try { hostname = new URL(anchorUrl).hostname.replace(/^www\./, ''); } catch (_) { hostname = null; }

  const domainLockBlock = hostname
    ? `\n\nDOMAIN LOCK — ABSOLUTE:\nYou are automating '${hostname}'. NEVER navigate outside '${hostname}'.`
    : '';

  // Derive service key for fast-path OAuth hint
  const serviceKey = hostname ? hostname.split('.').slice(-2, -1)[0] : null;
  const serviceInfo = serviceKey ? (KNOWN_BROWSER_SERVICES[serviceKey] || null) : null;

  let _authAttempted = false;
  let _usedLearnedRules = false;
  let learnedRulesBlock = '';
  const history = []; // { label, url } steps taken

  // ── Phase 0 — Navigate ──────────────────────────────────────────────────
  const _navigate = async () => {
    logger.info(`[explore.agent] phase 0: navigating to ${anchorUrl}`);
    const navRes = await _browserAct({
      action: 'navigate',
      url: anchorUrl,
      sessionId: exploreSessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 20000,
    }, 25000);

    if (!navRes?.ok) {
      logger.warn(`[explore.agent] navigate failed: ${navRes?.error} — proceeding anyway`);
    }

    // settle + wait for nav bar (non-fatal)
    await _browserAct({
      action: 'waitForStableText',
      sessionId: exploreSessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 6000,
    }, 8000).catch(() => {});

    await _browserAct({
      action: 'waitForSelector',
      selector: '[role=navigation]',
      sessionId: exploreSessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 3000,
    }, 5000).catch(() => {});
  };

  // ── Phase 0.5 — Auth flow ───────────────────────────────────────────────
  const _handleAuth = async (currentUrl) => {
    if (_authAttempted) {
      logger.warn('[explore.agent] auth already attempted — skipping to avoid infinite loop');
      return;
    }
    logger.info(`[explore.agent] phase 0.5: login wall detected — starting waitForAuth`);
    _authAttempted = true;

    const authRes = await _browserAct({
      action: 'waitForAuth',
      url: currentUrl || anchorUrl,
      authSuccessUrl: anchorUrl,
      sessionId: exploreSessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 120000,
    }, 125000).catch(err => ({ ok: false, error: err.message }));

    if (authRes?.ok) {
      logger.info('[explore.agent] auth succeeded — restarting Phase 0');
      // Record login requirement as a rule
      if (hostname) {
        await skillDb.setContextRule(hostname, `${hostname}: requires login, use persistent profile`, 'site').catch(() => {});
      }
      // Full Phase 0 restart
      await _navigate();
    } else {
      logger.warn(`[explore.agent] waitForAuth failed or timed out: ${authRes?.error}`);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Fast-path: if service is known OAuth → don't even navigate, go straight to auth
  if (serviceInfo?.isOAuth && !_authAttempted) {
    logger.info(`[explore.agent] fast-path: ${serviceKey} is known OAuth — triggering waitForAuth first`);
    await _handleAuth(serviceInfo.signInUrl || anchorUrl);
  } else {
    await _navigate();
  }

  // Take initial snapshot
  let currentSnapshot = '';
  const initSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 10000 }, 12000).catch(() => null);
  if (initSnap?.ok && initSnap.result) currentSnapshot = initSnap.result;

  // Check for login wall after navigation
  const initUrl = await _getCurrentUrl(exploreSessionId, headed);
  if (_isLoginWall(currentSnapshot, initUrl)) {
    await _handleAuth(initUrl || anchorUrl);
    // Re-snapshot after auth
    const postAuthSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 10000 }, 12000).catch(() => null);
    if (postAuthSnap?.ok && postAuthSnap.result) currentSnapshot = postAuthSnap.result;
  }

  // ── Phase 1 — Validate learned rules ───────────────────────────────────
  logger.info('[explore.agent] phase 1: loading and validating learned rules');
  try {
    const ruleKeys = [agentId];
    if (hostname) ruleKeys.push(hostname);
    const rules = await skillDb.getContextRulesByKeys(ruleKeys);

    if (rules.length > 0) {
      logger.info(`[explore.agent] ${rules.length} learned rule(s) found — validating against current page`);
      let allValid = true;

      for (const rule of rules) {
        let validateRaw;
        try {
          validateRaw = await askWithMessages([
            { role: 'system', content: RULE_VALIDATE_PROMPT },
            { role: 'user',   content: `RULE TEXT: ${rule}\n\nCURRENT PAGE SNAPSHOT:\n${currentSnapshot.slice(0, 4000)}` },
          ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 10000 });
        } catch (_) { continue; }

        const validateParsed = _parseJson(validateRaw);
        if (validateParsed?.valid === false) {
          logger.warn(`[explore.agent] stale rule detected: "${rule.slice(0, 60)}..." — evicting all rules for [${ruleKeys.join(', ')}]`);
          allValid = false;
          break;
        }
      }

      if (!allValid) {
        // Evict stale rules for all keys
        for (const key of ruleKeys) {
          await skillDb.deleteContextRulesByKey(key).catch(() => {});
        }
        logger.info('[explore.agent] stale rules evicted — continuing without learned rules');
      } else {
        learnedRulesBlock = `\n\nLEARNED RULES (from prior runs — follow exactly):\n${rules.map(r => `- ${r}`).join('\n')}`;
        _usedLearnedRules = true;
        logger.info('[explore.agent] learned rules validated and injected');
      }
    }
  } catch (_) { /* non-fatal */ }

  // ── Phase 2 — Immediate goal check ─────────────────────────────────────
  logger.info('[explore.agent] phase 2: immediate goal check on landing page');
  try {
    const gcRaw = await askWithMessages([
      { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
      { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
    ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });

    const gcParsed = _parseJson(gcRaw);
    if (gcParsed?.satisfied && (gcParsed.confidence ?? 0) >= 0.7) {
      logger.info('[explore.agent] goal already satisfied on landing page');
      const landingUrl = await _getCurrentUrl(exploreSessionId, headed);
      if (landingUrl) history.push({ label: anchorUrl, url: landingUrl });
      await _learnPath(agentId, history, goal, hostname);
      return { ok: true, goal, sessionId: exploreSessionId, result: gcParsed.result || 'Goal satisfied on landing page', turns: 0, done: true, executionTime: Date.now() - start };
    }
  } catch (err) {
    logger.warn(`[explore.agent] phase 2 goal-check error: ${err.message} — proceeding to loop`);
  }

  // ── Phase 3 — Explore loop ──────────────────────────────────────────────
  logger.info(`[explore.agent] phase 3: explore loop (maxDepth=${maxDepth})`);
  const visited = new Set();
  visited.add(anchorUrl);

  let depth = 0;
  while (depth < maxDepth) {
    depth++;
    logger.info(`[explore.agent] explore loop depth ${depth}/${maxDepth}`);

    // Fresh snapshot
    const snapRes = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 10000 }, 12000).catch(() => null);
    if (snapRes?.ok && snapRes.result) currentSnapshot = snapRes.result;

    const currentUrl = await _getCurrentUrl(exploreSessionId, headed);

    // Detect login wall in loop
    if (_isLoginWall(currentSnapshot, currentUrl) && !_authAttempted) {
      await _handleAuth(currentUrl || anchorUrl);
      continue;
    }

    // ── Execute fast-path: check domain map for cached selectors ──────────
    let cachedActionsBlock = '';
    let domainMapRef = null;
    if (hostname) {
      try {
        domainMapRef = _loadDomainMap(hostname);
        const pageState = await _identifyPageState(currentSnapshot, currentUrl);
        if (pageState?.state_key && domainMapRef.states?.[pageState.state_key]?.actions) {
          const stateActions = domainMapRef.states[pageState.state_key].actions;
          const actionKeys = Object.keys(stateActions);
          if (actionKeys.length > 0) {
            cachedActionsBlock = `\n\nCACHED_ACTIONS (pre-mapped stable selectors for state "${pageState.state_key}"):\n` +
              actionKeys.map(k => `- ${k}: interaction=${stateActions[k].interaction} selector=${stateActions[k].locators?.primary || '?'}`).join('\n');
          }
        }
      } catch (_) { domainMapRef = null; }
    }

    // Extract + score nav items
    const allItems = _extractNavItems(currentSnapshot);
    const scored   = allItems
      .map(item => ({ ...item, score: _scoreNavItem(item.label, goal) }))
      .filter(item => !visited.has(item.ref))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxNavItems);

    const itemList = scored.map((it, i) => `${i + 1}. [${it.ref}] "${it.label}" (score=${it.score.toFixed(2)})`).join('\n');

    let pickRaw;
    try {
      pickRaw = await askWithMessages([
        { role: 'system', content: EXPLORE_PICK_PROMPT + domainLockBlock + learnedRulesBlock },
        { role: 'user',   content: [
          `GOAL: ${goal}`,
          `CURRENT_URL: ${currentUrl || 'unknown'}`,
          `ANCHOR_URL: ${anchorUrl}`,
          `VISITED: ${[...visited].join(', ')}`,
          ``,
          `NAV_ITEMS (top ${scored.length}):`,
          itemList || '(none found)',
          cachedActionsBlock,
          ``,
          `SNAPSHOT_EXCERPT:\n${currentSnapshot.slice(0, 3000)}`,
        ].join('\n') },
      ], { temperature: 0.1, maxTokens: 256, responseTimeoutMs: 15000 });
    } catch (err) {
      logger.warn(`[explore.agent] EXPLORE_PICK LLM error: ${err.message} — breaking`);
      break;
    }

    const pick = _parseJson(pickRaw);
    if (!pick) {
      logger.warn('[explore.agent] EXPLORE_PICK unparseable — breaking');
      break;
    }

    logger.info(`[explore.agent] EXPLORE_PICK decision=${pick.decision} ref=${pick.ref} label="${pick.label}" | ${pick.rationale}`);

    // ── Handle each decision ─────────────────────────────────────────────

    // use_cached — execute a pre-mapped stable selector directly
    if (pick.decision === 'use_cached' && pick.cachedActionKey && domainMapRef && hostname) {
      logger.info(`[explore.agent] use_cached: executing "${pick.cachedActionKey}" from domain map`);
      const pageState2 = await _identifyPageState(currentSnapshot, currentUrl);
      const cachedAction = pageState2?.state_key
        ? domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]
        : null;

      if (cachedAction?.locators) {
        const resolved = await _resolveLocator(cachedAction.locators, exploreSessionId, headed);
        if (resolved) {
          // Execute the cached action
          let execRes;
          if (cachedAction.interaction === 'fill') {
            execRes = await _browserAct({
              action: 'fill',
              selector: resolved.selector,
              text: goal,
              sessionId: exploreSessionId,
              headed,
              chromeProfile: AGENT_BROWSER_PROFILE,
              timeoutMs: 10000,
            }, 12000).catch(err => ({ ok: false, error: err.message }));
            if (execRes?.ok) {
              await _browserAct({ action: 'press', key: 'Enter', sessionId: exploreSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 5000 }, 7000).catch(() => {});
            }
          } else {
            execRes = await _browserAct({
              action: 'click',
              selector: resolved.selector,
              sessionId: exploreSessionId,
              headed,
              chromeProfile: AGENT_BROWSER_PROFILE,
              timeoutMs: 10000,
            }, 12000).catch(err => ({ ok: false, error: err.message }));
          }

          if (execRes?.ok) {
            // Update verified status + reset failure count
            if (pageState2?.state_key && domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]) {
              const act = domainMapRef.states[pageState2.state_key].actions[pick.cachedActionKey];
              act.verified = true;
              act.last_verified = new Date().toISOString();
              act.failure_count = 0;
              _saveDomainMap(hostname, domainMapRef);
            }
            await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
            const cachedUrl = await _getCurrentUrl(exploreSessionId, headed);
            if (cachedUrl) visited.add(cachedUrl);
            history.push({ label: pick.cachedActionKey, url: cachedUrl || '' });

            // Post-action goal check
            const cachedSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
            if (cachedSnap?.ok && cachedSnap.result) currentSnapshot = cachedSnap.result;
            try {
              const cachedGcRaw = await askWithMessages([
                { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
                { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
              ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
              const cachedGc = _parseJson(cachedGcRaw);
              if (cachedGc?.satisfied && (cachedGc.confidence ?? 0) >= 0.7) {
                await _learnPath(agentId, history, goal, hostname);
                return { ok: true, goal, sessionId: exploreSessionId, result: cachedGc.result || `Reached via cached: ${pick.cachedActionKey}`, turns: depth, done: true, executionTime: Date.now() - start };
              }
            } catch (_) {}
            continue;
          } else {
            // Cached selector failed — increment failure_count, trigger self-heal re-scan
            logger.warn(`[explore.agent] use_cached execution failed for "${pick.cachedActionKey}" — incrementing failure_count, enqueuing re-scan`);
            if (pageState2?.state_key && domainMapRef.states?.[pageState2.state_key]?.actions?.[pick.cachedActionKey]) {
              const act = domainMapRef.states[pageState2.state_key].actions[pick.cachedActionKey];
              act.failure_count = (act.failure_count || 0) + 1;
              act.verified = false;
              _saveDomainMap(hostname, domainMapRef);
            }
            _postProgress(_progressCallbackUrl, { type: 'explore:relearn_triggered', hostname, state: pageState2?.state_key, action: pick.cachedActionKey, reason: 'cached_selector_failed', trigger: 'self_heal' });
            _enqueueScan({ url: anchorUrl, agentId, _progressCallbackUrl }, 'self_heal');
          }
        } else {
          // All fallbacks failed — self-heal
          logger.warn(`[explore.agent] _resolveLocator failed for all fallbacks on "${pick.cachedActionKey}" — enqueuing re-scan`);
          _postProgress(_progressCallbackUrl, { type: 'explore:relearn_triggered', hostname, state: pageState2?.state_key, action: pick.cachedActionKey, reason: 'locator_resolve_failed', trigger: 'self_heal' });
          _enqueueScan({ url: anchorUrl, agentId, _progressCallbackUrl }, 'self_heal');
        }
      }
      // Fall through to standard explore loop for this iteration
    }

    if (pick.decision === 'goal_met') {
      // Double-check with GOAL_CHECK_PROMPT for full extraction
      let finalResult = pick.label || 'Goal met';
      try {
        const gcRaw2 = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const gc2 = _parseJson(gcRaw2);
        if (gc2?.result) finalResult = gc2.result;
      } catch (_) {}

      if (currentUrl) history.push({ label: pick.label || '', url: currentUrl });
      await _learnPath(agentId, history, goal, hostname);
      return { ok: true, goal, sessionId: exploreSessionId, result: finalResult, turns: depth, done: true, executionTime: Date.now() - start };
    }

    if (pick.decision === 'need_login') {
      if (!_authAttempted) {
        await _handleAuth(currentUrl || anchorUrl);
        depth--; // re-try this depth after auth
      } else {
        logger.warn('[explore.agent] need_login but auth already attempted — breaking');
        break;
      }
      continue;
    }

    if (pick.decision === 'none') {
      // Navigate back to anchor
      if (currentUrl && currentUrl === anchorUrl) {
        logger.info('[explore.agent] already at anchor — exploration exhausted');
        break;
      }
      logger.info('[explore.agent] no useful item found — navigating back to anchor');
      await _browserAct({ action: 'navigate', url: anchorUrl, sessionId: exploreSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 15000 }, 18000).catch(() => {});
      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 6000 }, 8000).catch(() => {});
      continue;
    }

    if (pick.decision === 'search') {
      logger.info(`[explore.agent] search decision — filling searchbox with: "${pick.searchQuery}"`);
      const fillRes = await _browserAct({
        action: 'run-code',
        code: `async page => { await page.getByRole('searchbox').first().fill(${JSON.stringify(pick.searchQuery || goal)}); await page.keyboard.press('Enter'); }`,
        sessionId: exploreSessionId,
        headed,
        chromeProfile: AGENT_BROWSER_PROFILE,
        timeoutMs: 10000,
      }, 12000).catch(err => ({ ok: false, error: err.message }));

      if (!fillRes?.ok) {
        logger.warn(`[explore.agent] search fill failed: ${fillRes?.error} — trying find-label fallback`);
        await _browserAct({
          action: 'run-code',
          code: `async page => { const inp = page.getByLabel('Search') || page.getByPlaceholder('Search'); await inp.fill(${JSON.stringify(pick.searchQuery || goal)}); await page.keyboard.press('Enter'); }`,
          sessionId: exploreSessionId,
          headed,
          chromeProfile: AGENT_BROWSER_PROFILE,
          timeoutMs: 10000,
        }, 12000).catch(() => {});
      }

      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});

      // Immediate goal check on search results
      const srSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
      if (srSnap?.ok && srSnap.result) currentSnapshot = srSnap.result;

      try {
        const srGcRaw = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const srGc = _parseJson(srGcRaw);
        if (srGc?.satisfied && (srGc.confidence ?? 0) >= 0.6) {
          const srUrl = await _getCurrentUrl(exploreSessionId, headed);
          if (srUrl) history.push({ label: `search:${pick.searchQuery}`, url: srUrl });
          await _learnPath(agentId, history, goal, hostname);
          return { ok: true, goal, sessionId: exploreSessionId, result: srGc.result || 'Search results satisfied goal', turns: depth, done: true, executionTime: Date.now() - start };
        }
      } catch (_) {}

      continue;
    }

    if (pick.decision === 'click' && pick.ref) {
      // Mark as visited
      visited.add(pick.ref);

      const clickRes = await _browserAct({
        action: 'click',
        selector: pick.ref,
        sessionId: exploreSessionId,
        headed,
        chromeProfile: AGENT_BROWSER_PROFILE,
        timeoutMs: 10000,
      }, 12000).catch(err => ({ ok: false, error: err.message }));

      if (!clickRes?.ok) {
        logger.warn(`[explore.agent] click ${pick.ref} failed: ${clickRes?.error} — skipping`);
        continue;
      }

      await _browserAct({ action: 'waitForStableText', sessionId: exploreSessionId, headed, timeoutMs: 5000 }, 7000).catch(() => {});
      const postClickUrl = await _getCurrentUrl(exploreSessionId, headed);
      if (postClickUrl) visited.add(postClickUrl);
      history.push({ label: pick.label || pick.ref, url: postClickUrl || '' });

      // Extract stable selectors for this element and save to domain map (lazy learning)
      if (hostname && pick.ref) {
        const selectorProfile = await _extractStableSelectors(pick.ref, exploreSessionId, headed, pick.label, 'click');
        if (selectorProfile?.locators?.primary) {
          try {
            const pageStateForLearn = await _identifyPageState(currentSnapshot, currentUrl);
            if (pageStateForLearn?.state_key) {
              const existingMap = _loadDomainMap(hostname);
              if (!existingMap.states[pageStateForLearn.state_key]) {
                existingMap.states[pageStateForLearn.state_key] = { identification: pageStateForLearn.identification || '', actions: {} };
              }
              const actionKey = (pick.label || pick.ref).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
              existingMap.states[pageStateForLearn.state_key].actions[actionKey] = {
                skill_name: actionKey,
                interaction: 'click',
                locators: selectorProfile.locators,
                fingerprint: selectorProfile.fingerprint,
                success_criteria: selectorProfile.success_criteria || { expected_url_change: true, element_to_appear: null },
                verified: false,
                last_verified: null,
                failure_count: 0,
              };
              _saveDomainMap(hostname, existingMap);
              logger.info(`[explore.agent] learned selector for "${actionKey}" on state "${pageStateForLearn.state_key}"`);
            }
          } catch (_) { /* non-fatal */ }
        }
      }

      // Post-click goal check
      const postClickSnap = await _browserAct({ action: 'snapshot', sessionId: exploreSessionId, headed, timeoutMs: 8000 }, 10000).catch(() => null);
      if (postClickSnap?.ok && postClickSnap.result) currentSnapshot = postClickSnap.result;

      try {
        const postGcRaw = await askWithMessages([
          { role: 'system', content: GOAL_CHECK_PROMPT + domainLockBlock },
          { role: 'user',   content: `GOAL: ${goal}\n\nSNAPSHOT:\n${currentSnapshot.slice(0, 8000)}` },
        ], { temperature: 0.1, maxTokens: 512, responseTimeoutMs: 15000 });
        const postGc = _parseJson(postGcRaw);
        if (postGc?.satisfied && (postGc.confidence ?? 0) >= 0.7) {
          await _learnPath(agentId, history, goal, hostname);
          return { ok: true, goal, sessionId: exploreSessionId, result: postGc.result || `Reached: ${pick.label}`, turns: depth, done: true, executionTime: Date.now() - start };
        }
      } catch (_) {}

      continue;
    }

    // Unknown decision — break
    logger.warn(`[explore.agent] unknown decision "${pick.decision}" — breaking`);
    break;
  }

  // ── Exhausted loop ───────────────────────────────────────────────────────
  if (_usedLearnedRules) {
    logger.warn('[explore.agent] goal not met after using learned rules — evicting stale rules');
    const evictKeys = [agentId];
    if (hostname) evictKeys.push(hostname);
    for (const key of evictKeys) {
      await skillDb.deleteContextRulesByKey(key).catch(() => {});
    }
  }

  logger.info(`[explore.agent] explore exhausted after ${depth} steps — goal not met`);
  return {
    ok: false,
    goal,
    sessionId: exploreSessionId,
    result: `Could not reach goal after ${depth} exploration step(s)`,
    turns: depth,
    done: false,
    executionTime: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// scanDomain — Mode B: background domain probe, builds/extends domain map
// ---------------------------------------------------------------------------
async function scanDomain(args) {
  const {
    url,
    agentId       = 'explore_agent',
    sessionId:    callerSessionId,
    maxScanDepth  = 1,
    _progressCallbackUrl,
    _trigger      = 'manual',
  } = args || {};

  if (!url) return { ok: false, error: 'url is required for scanDomain' };

  let hostname;
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {
    return { ok: false, error: `Invalid url: ${url}` };
  }

  const start          = Date.now();
  const scanSessionId  = callerSessionId || `${hostname}_scan_${Date.now()}`;
  const headed         = false;  // background scans are always headless — never open visible windows
  let totalActions     = 0;

  logger.info(`[explore.agent] scanDomain start: ${hostname} (trigger=${_trigger} maxScanDepth=${maxScanDepth})`);
  _postProgress(_progressCallbackUrl, { type: 'explore:scan_start', hostname, trigger: _trigger, agentId });

  try {
    // Navigate to URL
    await _browserAct({
      action: 'navigate',
      url,
      sessionId: scanSessionId,
      headed,
      chromeProfile: AGENT_BROWSER_PROFILE,
      timeoutMs: 25000,
    }, 28000).catch(() => {});

    await _browserAct({ action: 'waitForStableText', sessionId: scanSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 6000 }, 8000).catch(() => {});

    // Extract content extraction signals from the landing page
    logger.info(`[explore.agent] scan: extracting content signals for ${hostname}`);
    const contentSignals = await _extractContentSignals(scanSessionId, headed);
    if (contentSignals?.primary_selector) {
      logger.info(`[explore.agent] scan: detected content type="${contentSignals.content_type}" selector="${contentSignals.primary_selector}" confidence=${contentSignals.confidence}`);
    }

    const existingMap = _loadDomainMap(hostname);
    const newMap      = { 
      domain: hostname, 
      version: '1.0', 
      last_scanned: null, 
      states: {},
      ...(contentSignals?.primary_selector ? {
        content_extraction: {
          primary_selector: contentSignals.primary_selector,
          fallback_selector: contentSignals.fallback_selector,
          content_type: contentSignals.content_type,
          confidence: contentSignals.confidence,
          last_updated: new Date().toISOString()
        }
      } : {})
    };

    const visitedUrls = new Set([url]);
    const scanQueue   = [{ url, depth: 0 }];

    while (scanQueue.length > 0) {
      const { url: pageUrl, depth } = scanQueue.shift();

      // Navigate if not already there
      const currentScanUrl = await _getCurrentUrl(scanSessionId, headed);
      if (currentScanUrl !== pageUrl) {
        await _browserAct({ action: 'navigate', url: pageUrl, sessionId: scanSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 20000 }, 23000).catch(() => {});
        await _browserAct({ action: 'waitForStableText', sessionId: scanSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 5000 }, 7000).catch(() => {});
      }

      const snapRes = await _browserAct({ action: 'snapshot', sessionId: scanSessionId, headed, chromeProfile: AGENT_BROWSER_PROFILE, timeoutMs: 10000 }, 12000).catch(() => null);
      const snapshot = snapRes?.ok && snapRes.result ? snapRes.result : '';
      if (!snapshot) continue;

      const pageStateInfo = await _identifyPageState(snapshot, pageUrl);
      const stateKey = pageStateInfo?.state_key || `page_${depth}_${visitedUrls.size}`;
      const identification = pageStateInfo?.identification || `URL contains '${new URL(pageUrl).pathname}'`;

      logger.info(`[explore.agent] scan: state="${stateKey}" at ${pageUrl}`);

      if (!newMap.states[stateKey]) {
        newMap.states[stateKey] = { identification, actions: {} };
      }

      // Extract all interactable items from snapshot
      const allItems = _extractNavItems(snapshot);

      // Also extract inputs/selects from snapshot
      const inputRefs = [];
      const inputRe   = /^\s*-\s*ref=(@e\d+)/;
      let capRef = null, capRole = null, capName = null;
      for (const line of snapshot.split('\n')) {
        const rm = line.match(inputRe);
        if (rm) { capRef = rm[1]; capRole = null; capName = null; continue; }
        if (capRef) {
          const roleM = line.match(/role=["']?(\w+)/);
          if (roleM) capRole = roleM[1].toLowerCase();
          const nameM = line.match(/name=["']([^"']+)/);
          if (nameM) capName = nameM[1];
          const phM = line.match(/placeholder=["']([^"']+)/);
          if (phM && !capName) capName = phM[1];
          if (capRole && (capRole === 'textbox' || capRole === 'searchbox' || capRole === 'combobox' || capRole === 'spinbutton')) {
            inputRefs.push({ ref: capRef, label: capName || capRole, role: capRole });
            capRef = null;
          }
        }
      }

      // Merge links/buttons + inputs
      const allScanItems = [...allItems, ...inputRefs];
      let pageActions = 0;

      for (const item of allScanItems.slice(0, 30)) {
        const interaction = (item.role === 'textbox' || item.role === 'searchbox' || item.role === 'combobox') ? 'fill' : 'click';
        const selectorProfile = await _extractStableSelectors(item.ref, scanSessionId, headed, item.label, interaction);
        if (!selectorProfile?.locators?.primary) continue;

        const actionKey = item.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
        newMap.states[stateKey].actions[actionKey] = {
          skill_name: actionKey,
          interaction,
          locators: selectorProfile.locators,
          fingerprint: selectorProfile.fingerprint,
          success_criteria: selectorProfile.success_criteria || { expected_url_change: true, element_to_appear: null },
          verified: false,
          last_verified: null,
          failure_count: 0,
        };
        pageActions++;
        totalActions++;
      }

      _postProgress(_progressCallbackUrl, { type: 'explore:scan_progress', hostname, state: stateKey, actionsFound: pageActions, depth });

      // Enqueue same-hostname links for next depth level
      if (depth < maxScanDepth) {
        for (const item of allItems.slice(0, 10)) {
          // Only follow links with hrefs that stay on the same hostname
          // (we extract href from the snapshot fingerprint where possible)
          const hrefMatch = snapshot.match(new RegExp(`ref=${item.ref.replace('@', '@?')}[\\s\\S]{0,200}?href=["']([^"']+)`));
          if (hrefMatch) {
            try {
              const linkUrl = new URL(hrefMatch[1], url).href;
              const linkHostname = new URL(linkUrl).hostname.replace(/^www\./, '');
              if (linkHostname === hostname && !visitedUrls.has(linkUrl)) {
                visitedUrls.add(linkUrl);
                scanQueue.push({ url: linkUrl, depth: depth + 1 });
              }
            } catch (_) {}
          }
        }
      }
    }

    // Merge with existing map and save
    const mergedMap = _mergeDomainMap(existingMap, newMap);
    _saveDomainMap(hostname, mergedMap);

    const mapPath = _mapPath(hostname);
    const duration = Date.now() - start;
    logger.info(`[explore.agent] scanDomain complete: ${hostname} — ${totalActions} actions in ${duration}ms`);
    _postProgress(_progressCallbackUrl, { type: 'explore:scan_complete', hostname, totalActions, mapPath, duration, trigger: _trigger });

    return { ok: true, hostname, actionsFound: totalActions, mapPath, duration };

  } catch (err) {
    logger.warn(`[explore.agent] scanDomain error for ${hostname}: ${err.message}`);
    _postProgress(_progressCallbackUrl, { type: 'explore:scan_error', hostname, error: err.message });
    return { ok: false, hostname, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Maintenance Scan — state files + constants
// ---------------------------------------------------------------------------
const BROWSER_PROFILES_DIR = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
const SCAN_STATE_FILE       = path.join(os.homedir(), '.thinkdrop', 'scan-state.json');
const SCAN_SCHEDULE_FILE    = path.join(os.homedir(), '.thinkdrop', 'scan-schedule.json');
const USER_MEMORY_PORT      = parseInt(process.env.MCP_USER_MEMORY_PORT || '3001', 10);
const IDLE_THRESHOLD_MS     = 30 * 60 * 1000;   // 30 min idle before triggering
const SCAN_COOLDOWN_MS      = 24 * 60 * 60 * 1000; // 24h between auto scans
const IDLE_POLL_MS          = 5 * 60 * 1000;    // check idle every 5 min

let _idleWatcherTimer  = null;
let _scanSchedulerJob  = null;
let _maintenanceRunning = false;
let _maintenanceCancelRequested = false;

// ---------------------------------------------------------------------------
// Scan state I/O
// ---------------------------------------------------------------------------
function _loadScanState() {
  try {
    if (fs.existsSync(SCAN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SCAN_STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return { lastRunTs: null, lastRunAgents: [], lastDiscovery: [] };
}

function _saveScanState(state) {
  try {
    fs.mkdirSync(path.dirname(SCAN_STATE_FILE), { recursive: true });
    fs.writeFileSync(SCAN_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[explore.agent] could not save scan state: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Browser profile cleanup — removes leftover *_scan_* dirs, logs orphan *_agent dirs
// ---------------------------------------------------------------------------
function _cleanBrowserProfiles(knownAgentIds) {
  if (!fs.existsSync(BROWSER_PROFILES_DIR)) return;
  let cleaned = 0;
  let orphans = [];
  try {
    const entries = fs.readdirSync(BROWSER_PROFILES_DIR);
    for (const entry of entries) {
      if (/_scan_\d+$/.test(entry)) {
        try {
          fs.rmSync(path.join(BROWSER_PROFILES_DIR, entry), { recursive: true, force: true });
          cleaned++;
        } catch (e) {
          logger.warn(`[explore.agent] could not remove stale profile dir ${entry}: ${e.message}`);
        }
      } else if (entry.endsWith('_agent')) {
        const agentId = entry.replace(/_agent$/, '').replace(/_/g, '.') + '.agent';
        const simpleId = entry.replace(/_agent$/, '');
        const known = knownAgentIds.some(id =>
          id === agentId || id === simpleId || id.startsWith(simpleId)
        );
        if (!known) orphans.push(entry);
      }
    }
    if (cleaned > 0) logger.info(`[explore.agent] cleaned ${cleaned} stale scan profile dir(s)`);
    if (orphans.length > 0) logger.info(`[explore.agent] orphan browser profiles (no .md descriptor): ${orphans.join(', ')}`);
  } catch (err) {
    logger.warn(`[explore.agent] browser profile cleanup error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Collect agent list — merges agents/*.md + browser-profiles/*_agent, deduped
// ---------------------------------------------------------------------------
function _collectAgentList() {
  const agents = new Map(); // agentId → { agentId, startUrl, source }

  // Primary: ~/.thinkdrop/agents/*.md
  if (fs.existsSync(AGENTS_DIR)) {
    try {
      const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
          const startUrlMatch = content.match(/^start_url:\s*(.+)$/m);
          if (!startUrlMatch) continue;
          const startUrl = startUrlMatch[1].trim();
          const agentId = file.replace('.md', '');
          agents.set(agentId, { agentId, startUrl, source: 'agents_dir' });
        } catch (_) {}
      }
    } catch (err) {
      logger.warn(`[explore.agent] could not read agents dir: ${err.message}`);
    }
  }

  // Secondary: ~/.thinkdrop/browser-profiles/*_agent (catches profiles missing .md)
  if (fs.existsSync(BROWSER_PROFILES_DIR)) {
    try {
      const entries = fs.readdirSync(BROWSER_PROFILES_DIR).filter(e => e.endsWith('_agent'));
      for (const entry of entries) {
        const simpleId = entry.replace(/_agent$/, '');
        // Convert underscore-name to dot-name (e.g. gmail_agent → gmail.agent)
        const agentId = simpleId + '.agent';
        if (!agents.has(agentId)) {
          // No .md — we have a profile but no descriptor; log but skip (can't get start_url)
          logger.debug(`[explore.agent] browser profile ${entry} has no .md descriptor — skipping scan`);
        }
      }
    } catch (err) {
      logger.warn(`[explore.agent] could not read browser-profiles dir: ${err.message}`);
    }
  }

  return Array.from(agents.values());
}

// ---------------------------------------------------------------------------
// Browsing discovery — queries memory for frequently visited URLs not yet covered
// ---------------------------------------------------------------------------
async function _queryBrowsingDiscovery(knownHostnames) {
  try {
    const body = JSON.stringify({
      version: 'mcp.v1', service: 'user-memory', action: 'memory.retrieve',
      payload: { query: 'browser website url visit', topK: 200, type: 'screen_capture' },
    });
    const raw = await new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1', port: USER_MEMORY_PORT,
        path: '/memory.retrieve', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      }, (r) => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });

    const results = raw?.data?.results || raw?.results || [];
    const hostCount = new Map();
    const cutoffTs = Date.now() - 30 * 24 * 60 * 60 * 1000; // last 30 days

    for (const item of results) {
      let meta;
      try { meta = typeof item.metadata === 'string' ? JSON.parse(item.metadata) : item.metadata; } catch (_) { continue; }
      const url = meta?.url;
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (item.created_at && new Date(item.created_at).getTime() < cutoffTs) continue;
      let hostname;
      try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
      // Skip already-known agents
      if (knownHostnames.has(hostname)) continue;
      // Skip trivial/utility domains
      if (/^(localhost|127\.|192\.|google\.com$|bing\.com$|duckduckgo\.com$|accounts\.|login\.)/.test(hostname)) continue;
      hostCount.set(hostname, (hostCount.get(hostname) || 0) + 1);
    }

    // Filter ≥ 3 visits, sort descending
    return Array.from(hostCount.entries())
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([hostname, visits]) => ({ hostname, visits }));
  } catch (err) {
    logger.warn(`[explore.agent] browsing discovery error: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// _postMaintenanceProgress — emit progress to Electron renderer via /scan.progress
// ---------------------------------------------------------------------------
function _postMaintenanceProgress(payload) {
  try {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1', port: OVERLAY_PORT,
      path: '/scan.progress', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 2000,
    }, (r) => { r.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(body);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Core: _runMaintenanceScan
// ---------------------------------------------------------------------------
async function _runMaintenanceScan(opts = {}) {
  if (_maintenanceRunning) {
    logger.info('[explore.agent] maintenance scan already running — skipping');
    return { ok: false, reason: 'already_running' };
  }
  _maintenanceRunning = true;
  _maintenanceCancelRequested = false;
  const trigger = opts.trigger || 'user';
  const start = Date.now();

  try {
    logger.info(`[explore.agent] maintenance scan starting (trigger=${trigger})`);

    // Step 1 — Collect agent list (needed for cleanup cross-ref)
    const agentList = _collectAgentList();
    const knownAgentIds = agentList.map(a => a.agentId);

    // Step 2 — Clean up stale scan profiles
    _cleanBrowserProfiles(knownAgentIds);

    // Step 3 — Discovery: find frequently visited sites not yet covered
    const knownHostnames = new Set(agentList.map(a => {
      try { return new URL(a.startUrl).hostname.replace(/^www\./, ''); } catch (_) { return null; }
    }).filter(Boolean));

    const suggestions = await _queryBrowsingDiscovery(knownHostnames);
    if (suggestions.length > 0) {
      logger.info(`[explore.agent] discovery found ${suggestions.length} candidate site(s): ${suggestions.map(s => s.hostname).join(', ')}`);
      _postMaintenanceProgress({ type: 'maintenance_scan_discovery', suggestions });
    }

    // Step 4 — Emit scan start
    const total = agentList.length;
    _postMaintenanceProgress({ type: 'maintenance_scan_start', total, agents: agentList.map(a => a.agentId), trigger });

    // Step 5 — Enqueue each agent sequentially via existing drain queue
    let completed = 0;
    for (const agent of agentList) {
      if (_maintenanceCancelRequested) {
        logger.info('[explore.agent] maintenance scan cancelled by user');
        _postMaintenanceProgress({ type: 'maintenance_scan_cancelled', completed, total });
        return { ok: false, reason: 'cancelled' };
      }

      // Wait for queue to drain before enqueuing next (ensures sequential, not concurrent)
      await new Promise((resolve) => {
        const tryEnqueue = () => {
          if (_activeScanCount < _MAX_CONCURRENT_SCANS && _scanQueueList.length === 0) {
            _enqueueScan({ url: agent.startUrl, agentId: agent.agentId }, 'maintenance');
            // Wait for this agent's scan to finish
            const waitDone = setInterval(() => {
              if (!_scanQueueSet.has(new URL(agent.startUrl).hostname.replace(/^www\./, ''))) {
                clearInterval(waitDone);
                completed++;
                _postMaintenanceProgress({
                  type: 'maintenance_scan_agent_done',
                  agentId: agent.agentId,
                  index: completed,
                  total,
                });
                resolve();
              }
            }, 1000);
          } else {
            setTimeout(tryEnqueue, 2000);
          }
        };
        try { tryEnqueue(); } catch (_) { completed++; resolve(); }
      });
    }

    const duration = Date.now() - start;
    const state = _loadScanState();
    _saveScanState({
      ...state,
      lastRunTs: new Date().toISOString(),
      lastRunAgents: knownAgentIds,
      lastDiscovery: suggestions,
    });

    logger.info(`[explore.agent] maintenance scan complete — ${completed}/${total} agents, ${duration}ms (trigger=${trigger})`);
    _postMaintenanceProgress({ type: 'maintenance_scan_complete', total: completed, duration, trigger });
    return { ok: true, completed, total, duration };

  } catch (err) {
    logger.warn(`[explore.agent] maintenance scan error: ${err.message}`);
    _postMaintenanceProgress({ type: 'maintenance_scan_error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    _maintenanceRunning = false;
  }
}

function cancelMaintenanceScan() {
  _maintenanceCancelRequested = true;
}

// ---------------------------------------------------------------------------
// getScanStatus — returns current state for UI polling
// ---------------------------------------------------------------------------
function getScanStatus() {
  const state = _loadScanState();
  let schedule = null;
  try {
    if (fs.existsSync(SCAN_SCHEDULE_FILE)) {
      schedule = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {
    active: _maintenanceRunning,
    queued: _scanQueueList.length,
    activeScanCount: _activeScanCount,
    lastRunTs: state.lastRunTs,
    lastRunAgents: state.lastRunAgents || [],
    lastDiscovery: state.lastDiscovery || [],
    schedule: schedule || null,
  };
}

// ---------------------------------------------------------------------------
// startScanScheduler — reads scan-schedule.json, registers a node-cron job
// ---------------------------------------------------------------------------
function startScanScheduler() {
  if (_scanSchedulerJob) {
    try { _scanSchedulerJob.stop(); } catch (_) {}
    _scanSchedulerJob = null;
  }
  if (!fs.existsSync(SCAN_SCHEDULE_FILE)) return;
  try {
    const config = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
    if (!config.enabled || !config.cron) return;

    let nodeCron;
    try { nodeCron = require('node-cron'); } catch (_) {
      logger.warn('[explore.agent] node-cron not available — scan scheduler disabled');
      return;
    }

    if (!nodeCron.validate(config.cron)) {
      logger.warn(`[explore.agent] invalid cron expression in scan-schedule.json: ${config.cron}`);
      return;
    }

    _scanSchedulerJob = nodeCron.schedule(config.cron, () => {
      logger.info(`[explore.agent] scheduled maintenance scan firing (cron=${config.cron})`);
      _runMaintenanceScan({ trigger: 'scheduled' })
        .then(r => {
          const schedData = JSON.parse(fs.readFileSync(SCAN_SCHEDULE_FILE, 'utf8'));
          fs.writeFileSync(SCAN_SCHEDULE_FILE, JSON.stringify({
            ...schedData, lastRun: new Date().toISOString(),
          }, null, 2), 'utf8');
          logger.info(`[explore.agent] scheduled scan complete: ${JSON.stringify(r)}`);
        })
        .catch(err => logger.warn(`[explore.agent] scheduled scan error: ${err.message}`));
    });
    logger.info(`[explore.agent] scan scheduler registered (cron=${config.cron})`);
  } catch (err) {
    logger.warn(`[explore.agent] could not start scan scheduler: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// startIdleWatcher — polls ioreg every 5min, fires scan when idle ≥ 30min
// ---------------------------------------------------------------------------
function startIdleWatcher() {
  if (_idleWatcherTimer) return;

  async function _idleTick() {
    try {
      // Use ioreg via screen-intelligence-service /screen.idle
      const idleMs = await new Promise((resolve) => {
        const req = http.request({
          hostname: '127.0.0.1', port: SCREEN_SERVICE_PORT,
          path: '/screen.idle', method: 'GET',
          timeout: 3000,
        }, (r) => {
          let data = '';
          r.on('data', c => { data += c; });
          r.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed?.idleMs ?? parsed?.data?.idleMs ?? null);
            } catch (_) { resolve(null); }
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      });

      if (idleMs === null) return; // service unavailable — skip
      if (idleMs < IDLE_THRESHOLD_MS) return; // not idle enough

      // Check cooldown
      const state = _loadScanState();
      const lastRun = state.lastRunTs ? new Date(state.lastRunTs).getTime() : 0;
      if (Date.now() - lastRun < SCAN_COOLDOWN_MS) {
        logger.debug('[explore.agent] idle watcher: cooldown not elapsed — skipping');
        return;
      }

      // Gate: don't start if already running or a foreground scan is active
      if (_maintenanceRunning || _activeScanCount > 0) return;

      logger.info(`[explore.agent] idle watcher: system idle ${Math.round(idleMs / 60000)}min — triggering maintenance scan`);
      _runMaintenanceScan({ trigger: 'idle' }).catch(err =>
        logger.warn(`[explore.agent] idle-triggered scan error: ${err.message}`)
      );
    } catch (_) { /* non-fatal */ }
  }

  _idleWatcherTimer = setInterval(_idleTick, IDLE_POLL_MS);
  logger.info('[explore.agent] idle watcher started (poll=5min, threshold=30min, cooldown=24h)');
}

function stopIdleWatcher() {
  if (_idleWatcherTimer) { clearInterval(_idleWatcherTimer); _idleWatcherTimer = null; }
}

module.exports = {
  exploreAgent,
  scanDomain,
  startIdleWatcher,
  stopIdleWatcher,
  startScanScheduler,
  runMaintenanceScan: _runMaintenanceScan,
  cancelMaintenanceScan,
  getScanStatus,
  enqueueScan: _enqueueScan,
};
