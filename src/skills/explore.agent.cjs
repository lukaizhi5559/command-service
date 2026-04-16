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
//
// Called from browser.agent.cjs `actionExplore()`.
// ---------------------------------------------------------------------------

const http    = require('http');
const os      = require('os');
const path    = require('path');
const skillDb = require('../skill-helpers/skill-db.cjs');

const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const logger             = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BROWSER_ACT_PORT    = parseInt(process.env.COMMAND_SERVICE_PORT || '3007', 10);
const AGENT_BROWSER_PROFILE = path.join(os.homedir(), '.thinkdrop', 'agent-profile');

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

const EXPLORE_PICK_PROMPT = `You are a browser navigation expert. Given a GOAL, a list of scored navigation items (label + score), the current URL, and a VISITED set, pick the SINGLE best action to take.
Reply ONLY with a valid JSON object:
{
  "decision": "click"|"search"|"goal_met"|"none"|"need_login",
  "ref": "@eN or null",
  "label": "<chosen item label or empty>",
  "searchQuery": "<query string — only when decision=search>",
  "rationale": "<one line why>"
}
Decision rules:
- "click"      → follow a nav item that likely leads toward the goal.
- "search"     → a search box is the best route (fill it + press Enter).
- "goal_met"   → the current page already appears to satisfy the goal.
- "need_login" → a login wall or auth gate is blocking access.
- "none"       → goal cannot be reached from current page; go back to anchor.
NEVER revisit a URL already in VISITED. Prefer items with higher scores.
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
    _progressCallbackUrl,
  } = args || {};

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

module.exports = { exploreAgent };
