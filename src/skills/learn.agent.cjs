'use strict';
// ---------------------------------------------------------------------------
// learn.agent.cjs — Blocking learn mode for agent domain exploration
//
// This skill provides a blocking learning experience for the user:
// 1. Scans the domain using explore.agent scan mode
// 2. Updates the agent .md file with discovered states
// 3. Sends real-time progress updates to the Electron UI
// 4. Blocks other ThinkDrop interactions until complete
//
// Called from main.js when user clicks "Learn" on an agent
// ---------------------------------------------------------------------------

const http    = require('http');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { execFileSync } = require('child_process');
const logger  = require('../logger.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

const OVERLAY_PORT    = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
const AGENTS_DIR      = path.join(os.homedir(), '.thinkdrop', 'agents');
const PROFILES_DIR    = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
const PROGRESS_CB_URL = `http://127.0.0.1:${OVERLAY_PORT}/learn.progress`;
const SKILLS_DIR      = path.join(os.homedir(), '.thinkdrop', 'skills');
const BROWSER_ACT_PATH = path.join(__dirname, 'browser.act.cjs');
const DOMAIN_MAPS_DIR  = path.join(os.homedir(), '.thinkdrop', 'domain-maps');

// ---------------------------------------------------------------------------
// Composite skill writer — assembles atomic skills from explore.agent output
// ---------------------------------------------------------------------------

/**
 * Write a composite skill that chains existing atomic skills by requiring them.
 * For each executed action, looks up the matching atomic skill on disk (by
 * selector or label) and emits require(path).run() instead of raw browserAct.
 * Falls back to inline browserAct only for fill/press steps with stable selectors.
 * Skips any step whose selector is an ephemeral [ref=eNNN] with no skill match.
 *
 * compositeSkillName: snake_case string
 * actionsExecuted: array of { url, action: { action, selector, value, elementDescription }, result }
 * meta: { agentId, domain, hostname, goal }
 */
function _writeCompositeSkill(compositeSkillName, actionsExecuted, meta) {
  if (!compositeSkillName || !actionsExecuted || actionsExecuted.length === 0) return false;
  const dirName = compositeSkillName.replace(/\./g, '_');
  const skillDir = path.join(SKILLS_DIR, dirName);
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    const defaultSessionId = meta.hostname
      ? meta.hostname.replace(/\..*$/, '').replace(/[^a-z0-9]/gi, '_') + '_agent'
      : 'default_agent';

    // Build lookup maps from all atomic skills on disk for this domain
    // Maps: normalizedSelector → skillPath, normalizedLabel → skillPath
    const selectorToSkill = new Map();
    const labelToSkill = new Map();
    try {
      const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sjPath = path.join(SKILLS_DIR, entry.name, 'skill.json');
        const idxPath = path.join(SKILLS_DIR, entry.name, 'index.cjs');
        if (!fs.existsSync(sjPath) || !fs.existsSync(idxPath)) continue;
        try {
          const sj = JSON.parse(fs.readFileSync(sjPath, 'utf8'));
          // Only include atomic skills for this domain (not other composite skills)
          if (sj.composite) continue;
          const skillDomain = sj.domain || sj.source_domain || '';
          if (skillDomain && !skillDomain.includes(meta.hostname)) continue;
          if (sj.selector) selectorToSkill.set(sj.selector.trim().toLowerCase(), idxPath);
          if (sj.source_action) labelToSkill.set(sj.source_action.trim().toLowerCase(), idxPath);
          if (sj.name) labelToSkill.set(sj.name.trim().toLowerCase(), idxPath);
        } catch (_) {}
      }
    } catch (_) {}

    // Helper: find best matching skill path for an executed action
    function _matchSkill(a) {
      const sel = (a.selector || '').trim();
      const label = (a.elementDescription || a.label || '').trim().toLowerCase();
      // Exact selector match
      if (sel && selectorToSkill.has(sel.toLowerCase())) return selectorToSkill.get(sel.toLowerCase());
      // Label match
      if (label && labelToSkill.has(label)) return labelToSkill.get(label);
      // Partial label match (skill label contains the action label)
      if (label) {
        for (const [k, v] of labelToSkill) {
          if (k.includes(label) || label.includes(k)) return v;
        }
      }
      return null;
    }

    // Helper: is selector ephemeral (session-scoped ref)
    function _isEphemeralSel(sel) {
      return /^\[ref=e\d+\]$/i.test((sel || '').trim());
    }

    // Deduplicate consecutive identical skill paths and build steps
    const steps = [];
    let lastSkillPath = null;
    const seenFills = new Set();
    const hasFillStep = actionsExecuted.some(e => (e.action?.action || e.action?.interaction) === 'fill');

    for (let i = 0; i < actionsExecuted.length; i++) {
      const e = actionsExecuted[i];
      const a = e.action || {};
      const actionType = a.action || a.interaction || 'click';
      const sel = (a.selector || '').trim();
      const val = (a.value || '').trim();

      if (actionType === 'fill') {
        // Fill steps — emit inline browserAct with query param (skip duplicates)
        const fillKey = sel + '::' + val;
        if (seenFills.has(fillKey)) continue;
        seenFills.add(fillKey);
        const escapedSel = sel.replace(/'/g, "\\'");
        const escapedVal = val.replace(/'/g, "\\'");
        if (!_isEphemeralSel(sel) || sel) {
          steps.push(`    // Step: fill input\n    await browserAct({ action: 'fill', selector: '${escapedSel}', text: args.query || args.text || '${escapedVal}', sessionId, headed, timeoutMs: 10000 });`);
          steps.push(`    await browserAct({ action: 'press', key: 'Enter', selector: '${escapedSel}', sessionId, headed, timeoutMs: 5000 }).catch(() => {});`);
        }
        lastSkillPath = null;
        continue;
      }

      if (actionType === 'press') {
        // Standalone press — skip if a fill step already added it
        if (!hasFillStep) {
          const escapedKey = (val || 'Enter').replace(/'/g, "\\'");
          steps.push(`    // Step: press key\n    await browserAct({ action: 'press', key: '${escapedKey}', sessionId, headed, timeoutMs: 5000 }).catch(() => {});`);
        }
        lastSkillPath = null;
        continue;
      }

      // Click/hover/etc — try to match an atomic skill
      const matchedPath = _matchSkill(a);

      if (matchedPath) {
        // Deduplicate consecutive identical skill invocations
        if (matchedPath === lastSkillPath) continue;
        lastSkillPath = matchedPath;
        const escaped = matchedPath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        steps.push(`    // Step: ${a.elementDescription || sel}\n    await require('${escaped}').run({ sessionId, headed });`);
      } else if (!_isEphemeralSel(sel)) {
        // Stable selector, no skill match — inline browserAct
        const escapedSel = sel.replace(/'/g, "\\'");
        if (sel) {
          steps.push(`    // Step: ${actionType} ${a.elementDescription || sel}\n    await browserAct({ action: '${actionType}', selector: '${escapedSel}', sessionId, headed, timeoutMs: 10000 });`);
        }
        lastSkillPath = null;
      }
      // else: ephemeral selector with no skill match — skip (exploration noise)
    }

    if (steps.length === 0) {
      logger.warn(`[learn.agent] _writeCompositeSkill: no valid steps for ${compositeSkillName} — skipping`);
      return false;
    }

    const needsBrowserAct = steps.some(s => s.includes('browserAct('));
    const imports = needsBrowserAct
      ? `const { browserAct } = require('${BROWSER_ACT_PATH}');\n`
      : '';

    const code = `'use strict';
// Auto-generated composite skill: ${compositeSkillName}
// Goal: ${(meta.goal || '').replace(/'/g, "\\'").slice(0, 100)}
// Source domain: ${meta.domain || meta.hostname}
${imports}
module.exports = {
  name: '${compositeSkillName}',
  description: '${(meta.goal || compositeSkillName).replace(/'/g, "\\'").slice(0, 100)}',
  parameters: {
    query: { type: 'string', required: false, description: 'Topic or search query' },
    text:  { type: 'string', required: false, description: 'Text input' },
  },
  async run(args = {}) {
    const sessionId = args.sessionId || '${defaultSessionId}';
    const headed = args.headed !== undefined ? args.headed : false;
${steps.join('\n')}
    return { success: true };
  }
};
`;
    fs.writeFileSync(path.join(skillDir, 'index.cjs'), code, 'utf8');
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify({
      name: compositeSkillName,
      description: meta.goal || compositeSkillName,
      agentId: meta.agentId,
      agent_id: meta.agentId,
      domain: meta.domain || meta.hostname,
      source_domain: meta.domain || meta.hostname,
      source_action: compositeSkillName,
      composite: true,
      step_count: steps.length,
      created_at: now,
    }, null, 2), 'utf8');
    logger.info(`[learn.agent] Composite skill written: ${compositeSkillName} (${steps.length} steps, ${actionsExecuted.length} raw actions)`);
    return true;
  } catch (e) {
    logger.warn(`[learn.agent] _writeCompositeSkill failed for ${compositeSkillName}: ${e.message}`);
    return false;
  }
}

// CDN / tracking cookie names that are written on first site visit and do NOT indicate login
const CDN_COOKIE_RE = /^(__cf|cf_|_dd_|pplx\.visitor|pplx\.tracking|pplx\.edge|pplx\.session-id|__frs|homepage-|_ga|_gid|_fbp|__utm)/i;
// Cookie name patterns that suggest a real auth session token (not a visitor/tracking cookie)
const AUTH_NAME_RE = /(session|auth[_-]?token|user[_-]?session|access[_-]?token|id[_-]?token|__Secure-|__Host-|logged[_-]?in|remember[_-]?me|jwt)/i;

// Check if the browser profile for a session already has auth cookies for a given hostname.
// Returns true if >=1 non-CDN, non-expired persistent cookie with an auth-like name OR a
// sufficiently long value (≥20 chars, ruling out simple visitor flags) exists.
function _checkProfileAuth(sessionId, hostname) {
  try {
    const cookiesDb = path.join(PROFILES_DIR, sessionId, 'Default', 'Cookies');
    if (!fs.existsSync(cookiesDb)) return false;
    // Chrome stores expiry as microseconds since 1601-01-01; convert 'now' to same epoch.
    const nowChrome = (Date.now() + 11644473600000) * 1000;
    // Fetch name + value length so we can filter out short visitor tokens.
    const sql = `SELECT name, length(value) as vlen FROM cookies WHERE (host_key LIKE '%.${hostname}' OR host_key LIKE '%${hostname}%') AND expires_utc > ${nowChrome} AND is_persistent = 1;`;
    const raw = execFileSync('sqlite3', [cookiesDb, sql], { timeout: 5000, encoding: 'utf8' });
    const rows = raw.trim().split('\n').filter(Boolean).map(r => {
      const parts = r.split('|');
      return { name: parts[0] || '', vlen: parseInt(parts[1] || '0', 10) };
    });
    const authCookies = rows.filter(({ name, vlen }) => {
      if (CDN_COOKIE_RE.test(name)) return false;   // known CDN/tracking → skip
      if (AUTH_NAME_RE.test(name)) return true;      // known auth name pattern → accept
      return vlen >= 20;                             // long value = likely real session token
    });
    logger.info(`[learn.agent] _checkProfileAuth session=${sessionId} host=${hostname}: ${rows.length} persistent cookies, ${authCookies.length} auth cookies`);
    return authCookies.length > 0;
  } catch (e) {
    logger.debug(`[learn.agent] _checkProfileAuth failed (non-fatal): ${e.message}`);
    return false; // fail open — proceed with normal auth flow
  }
}

// Login wall detector — mirrors logic from explore.agent for use during pre-auth verification
const LOGIN_URL_PATTERNS = ['/login', '/signin', '/sign-in', '/auth/', '/oauth', '/accounts/'];
function _isLoginWallSnap(snapshot, currentUrl) {
  if (currentUrl) {
    try {
      const u = new URL(currentUrl).pathname.toLowerCase();
      if (LOGIN_URL_PATTERNS.some(p => u.includes(p))) return true;
    } catch (_) {}
  }
  const t = (snapshot || '').toLowerCase();
  const signals = ['password', 'sign in', 'log in', 'create account',
    'forgot password', 'continue with google', 'continue with apple',
    'enter your email', 'welcome back'];
  let hits = 0;
  for (const s of signals) { if (t.includes(s)) hits++; }
  return hits >= 2;
}

// Track active learn sessions
const activeLearnSessions = new Map(); // agentId -> { startTime, progress, cancelRequested }

// ---------------------------------------------------------------------------
// Progress reporting to Electron UI
// ---------------------------------------------------------------------------
function _postLearnProgress(agentId, payload) {
  try {
    const data = JSON.stringify({ ...payload, agentId, timestamp: Date.now() });
    const req = http.request({
      hostname: '127.0.0.1',
      port: OVERLAY_PORT,
      path: '/learn.progress',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => { /* ignore response */ });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(data);
    req.end();
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Goal normalization — extract core automation intent from raw user text
// Handles typos, vague sentences, filler words via LLM with regex fallback
// ---------------------------------------------------------------------------
const FILLER_RE = /\b(i need to|i want to|i would like to|i'd like to|i have to|please|help me|can you|could you|just|really|basically|actually|use this to|using this to|this is to|need to use this|this just to)\b/gi;

async function _normalizeGoal(rawGoal, hostname) {
  if (!rawGoal || rawGoal.length < 10) return rawGoal || `explore ${hostname}`;
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You extract the core automation intent from user-provided goal text. Reply with ONLY 3-6 words describing what the user wants to DO on the website. No punctuation, no explanation. Examples: "search for answers" / "post messages to channels" / "create new tasks" / "manage email inbox".' },
      { role: 'user',   content: `Goal: "${rawGoal}"\nWebsite: ${hostname}\nCore intent (3-6 words):` },
    ], { temperature: 0.1, maxTokens: 20, responseTimeoutMs: 8000 });
    const normalized = (raw || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (normalized && normalized.length >= 3 && normalized.length <= 60) {
      logger.info(`[learn.agent] Goal normalized: "${rawGoal}" → "${normalized}"`);
      return normalized;
    }
  } catch (e) {
    logger.debug(`[learn.agent] _normalizeGoal LLM failed (${e.message}) — using regex fallback`);
  }
  // Regex fallback: strip filler, collapse whitespace, take first 8 words
  const stripped = rawGoal.replace(FILLER_RE, ' ').replace(/\s+/g, ' ').trim();
  return stripped.split(' ').slice(0, 8).join(' ') || rawGoal;
}

// ---------------------------------------------------------------------------
// Main learn action — progressive learning cascade
//
// Cascade: explore (scan) → web research → video tutorial → needs training
// ---------------------------------------------------------------------------
const MIN_STATES_THRESHOLD = 3;

async function actionLearn(args) {
  const {
    agentId,
    goals: goalsOverride,
    maxScanDepth = 2,
    _progressCallbackUrl,
    options = {},
  } = args || {};

  if (!agentId) {
    return { ok: false, error: 'agentId is required' };
  }

  // Check if already learning
  if (activeLearnSessions.has(agentId)) {
    return { ok: false, error: 'Learning already in progress for this agent' };
  }

  // Load agent descriptor
  const agentPath = path.join(AGENTS_DIR, `${agentId}.agent.md`);
  if (!fs.existsSync(agentPath)) {
    return { ok: false, error: `Agent not found: ${agentId}` };
  }

  const descriptor = fs.readFileSync(agentPath, 'utf8');
  
  // Extract start_url from frontmatter
  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) {
    return { ok: false, error: 'Agent missing start_url in frontmatter' };
  }
  
  const startUrl = startUrlMatch[1].trim();
  const hostname = new URL(startUrl).hostname.replace(/^www\./, '');

  // Extract user_goals from frontmatter, or use goals passed in from UI
  const goalsMatch = descriptor.match(/^user_goals:[\s\S]*?(?=^\w|$)/m);
  let userGoals = [];
  if (goalsMatch) {
    const goalLines = goalsMatch[0].split('\n').slice(1);
    userGoals = goalLines
      .map(line => line.match(/^\s*-\s*"?([^"\n]+)"?/)?.[1])
      .filter(Boolean);
  }
  
  // Goals from UI override frontmatter (user just set them via EditAgentModal)
  if (Array.isArray(goalsOverride) && goalsOverride.length > 0) {
    userGoals = goalsOverride;
    // Persist goals to agent .md frontmatter so future runs have them
    try {
      const goalYaml = userGoals.map(g => `  - "${g.replace(/"/g, '\\"')}"`).join('\n');
      const updatedDescriptor = descriptor.includes('user_goals:')
        ? descriptor.replace(/^user_goals:[\s\S]*?(?=^\w)/m, `user_goals:\n${goalYaml}\n`)
        : descriptor.replace(/^---/, `---\nuser_goals:\n${goalYaml}`);
      fs.writeFileSync(agentPath, updatedDescriptor, 'utf8');
      logger.info(`[learn.agent] Saved ${userGoals.length} goal(s) to ${agentId} descriptor`);
    } catch (e) {
      logger.warn(`[learn.agent] Could not save goals to descriptor: ${e.message}`);
    }
  }
  
  // Build list of URLs to scan
  // 1. Filter to valid URLs (must start with http:// or https://)
  const validUrls = userGoals.filter(g => {
    const trimmed = g.trim();
    return trimmed.length > 0 && /^https?:\/\/.+/.test(trimmed);
  });
  
  // 2. Determine if we should include landing page
  const includeLandingPage = options.includeLandingPage || validUrls.length === 0;
  
  // 3. Build final URL list
  let urlsToScan = [];
  if (includeLandingPage) {
    urlsToScan.push(startUrl);
  }
  urlsToScan = [...urlsToScan, ...validUrls];
  
  // Remove duplicates (in case landing page was also in the list)
  urlsToScan = [...new Set(urlsToScan)];
  
  if (urlsToScan.length === 0) {
    return { ok: false, error: 'No valid URLs to scan. Please provide at least one URL or check "Include landing page".' };
  }
  
  logger.info(`[learn.agent] Will scan ${urlsToScan.length} URL(s): ${urlsToScan.join(', ')}`);
  
  const primaryGoal = userGoals[0] || `explore ${hostname}`;

  // Stable browser session ID for this agent — always defined at function scope.
  // Appending '_agent' ensures shouldUsePersistentProfile() in browser.act.cjs returns true
  // so cookies are written to ~/.thinkdrop/browser-profiles/<_learnSessionId>/ and persist.
  const _learnSessionId = `${agentId.replace(/[^a-z0-9_]/gi, '_')}_agent`;

  // Create learn session
  const session = {
    agentId,
    startUrl,
    hostname,
    primaryGoal,
    startTime: Date.now(),
    progress: 0,
    cancelRequested: false,
    discoveredStates: [],
    insights: [],
  };
  activeLearnSessions.set(agentId, session);

  logger.info(`[learn.agent] Starting progressive learn mode for ${agentId}`);
  _postLearnProgress(agentId, { type: 'learn:start', hostname, startUrl, goal: primaryGoal });

  try {
    // === STEP 0: AUTHENTICATION CHECK ===
    // Check if auth is required and prompt user to log in first
    const signInUrlMatch = descriptor.match(/^sign_in_url:\s*(.+)$/m);
    const authPatternMatch = descriptor.match(/^auth_success_pattern:\s*(.+)$/m);
    const isOAuthOnlySite = /google\.com|perplexity\.ai|openai\.com|chatgpt\.com|claude\.ai/i.test(hostname);
    const hasExplicitSignIn = signInUrlMatch || /login|signin|auth/i.test(startUrl);
    // For OAuth-only sites without explicit sign_in_url, don't require auth unless we detect no cookies
    const requiresAuth = hasExplicitSignIn || (!isOAuthOnlySite && /login|signin|auth/i.test(startUrl));
    
    if (requiresAuth || isOAuthOnlySite) {
      // Use browser.agent's waitForAuth pattern
      const { browserAct } = require('./browser.act.cjs');
      const signInUrl = signInUrlMatch ? signInUrlMatch[1].trim() : (isOAuthOnlySite ? `https://${hostname}` : startUrl);
      const authPattern = authPatternMatch ? authPatternMatch[1].trim() : hostname;
      
      // Phase 1: Pre-auth check — if profile already has auth cookies, skip browser login entirely.
      // This check runs SILENTLY before showing any overlay — already-logged-in users never see the auth prompt.
      let preAuthed = _checkProfileAuth(_learnSessionId, hostname);
      
      // For OAuth-only sites with auth cookies, skip verification navigation entirely
      // Just do a quick homepage check to confirm we're logged in
      if (preAuthed && isOAuthOnlySite) {
        logger.info(`[learn.agent] OAuth-only site with auth cookies — doing quick homepage verification`);
        try {
          const homeRes = await browserAct({
            action: 'navigate',
            url: `https://${hostname}`,
            sessionId: _learnSessionId,
            headed: true,
            timeoutMs: 15000,
          });
          await browserAct({ action: 'waitForStableText', sessionId: _learnSessionId, headed: true, timeoutMs: 5000 }).catch(() => {});
          const snapRes = await browserAct({ action: 'snapshot', sessionId: _learnSessionId, headed: true, timeoutMs: 5000 }).catch(() => null);
          const snap = snapRes?.ok ? (snapRes.result || '') : '';
          
          // For OAuth sites, check if we see user profile elements (not login buttons)
          const hasUserProfile = /(account|profile|sign out|log out|dashboard|history)/i.test(snap);
          const hasLoginButton = /(sign in|log in|get started)/i.test(snap) && !hasUserProfile;
          
          if (!hasLoginButton || hasUserProfile) {
            logger.info(`[learn.agent] OAuth site verified: user is logged in ✓ — skipping auth overlay`);
            _postLearnProgress(agentId, { type: 'learn:auth_success', message: 'Already signed in — starting site scan…' });
            preAuthed = true;
          } else {
            logger.info(`[learn.agent] OAuth site shows login button — will show auth overlay`);
            preAuthed = false;
          }
        } catch (e) {
          logger.warn(`[learn.agent] OAuth verification failed (${e.message}) — will show auth overlay`);
          preAuthed = false;
        }
      } else if (preAuthed) {
        // Traditional sites: verify the page is actually logged in — cookies can be stale or visitor-only.
        logger.info(`[learn.agent] Pre-auth cookie check passed — verifying page is truly logged in`);
        try {
          const verifyRes = await browserAct({
            action: 'navigate',
            url: signInUrl,
            sessionId: _learnSessionId,
            headed: true,
            timeoutMs: 20000,
          });
          await browserAct({ action: 'waitForStableText', sessionId: _learnSessionId, headed: true, timeoutMs: 6000 }).catch(() => {});
          const snapRes = await browserAct({ action: 'snapshot', sessionId: _learnSessionId, headed: true, timeoutMs: 8000 }).catch(() => null);
          const snap = snapRes?.ok ? (snapRes.result || '') : '';
          const loginWall = _isLoginWallSnap(snap, verifyRes?.finalUrl || signInUrl);
          if (loginWall) {
            logger.info(`[learn.agent] Pre-auth verified: page shows login wall — will show auth overlay`);
            preAuthed = false;
          } else {
            logger.info(`[learn.agent] Pre-auth verified: page is logged in ✓ — skipping auth overlay`);
            _postLearnProgress(agentId, { type: 'learn:auth_success', message: 'Already signed in — starting site scan…' });
          }
        } catch (e) {
          logger.warn(`[learn.agent] Pre-auth verification failed (${e.message}) — will show auth overlay`);
          preAuthed = false;
        }
      }

      // Only show auth overlay if NOT pre-authed
      if (!preAuthed) {
        _postLearnProgress(agentId, { 
          type: 'learn:auth_required', 
          message: `🔐 A browser window is opening — sign in to ${hostname} using Google, Apple, or email. Come back here once you're in.`
        });
        
        logger.info(`[learn.agent] Prompting for auth at ${signInUrl}`);

        // Guard: user may have cancelled while we were setting up
        if (session.cancelRequested) {
          activeLearnSessions.delete(agentId);
          _postLearnProgress(agentId, { type: 'learn:cancelled', message: 'Learn cancelled by user.' });
          return { ok: false, reason: 'cancelled', error: 'Cancelled by user' };
        }
        
        const authResult = await browserAct({
          action: 'waitForAuth',
          url: signInUrl,
          authSuccessUrl: authPattern,
          sessionId: _learnSessionId,
          headed: true,
          timeoutMs: 120000,
          _progressCallbackUrl: PROGRESS_CB_URL,
        });

        // Guard: user may have cancelled during the auth wait
        if (session.cancelRequested) {
          activeLearnSessions.delete(agentId);
          _postLearnProgress(agentId, { type: 'learn:cancelled', message: 'Learn cancelled by user.' });
          return { ok: false, reason: 'cancelled', error: 'Cancelled by user' };
        }
        
        if (!authResult.ok) {
          _postLearnProgress(agentId, { 
            type: 'learn:auth_failed', 
            error: 'Authentication not completed. Learn mode cancelled.'
          });
          return { ok: false, error: 'Authentication required but not completed' };
        }
        
        _postLearnProgress(agentId, {
          type: 'learn:auth_success',
          message: 'Authenticated successfully. Proceeding with scan...'
        });
        // Small delay to let overlay dismiss before scan starts (avoids race condition flash)
        await new Promise(r => setTimeout(r, 800));
      } else {
        // Already logged in — skip overlay entirely
        logger.info(`[learn.agent] Skipping auth overlay — user is already logged in`);
      }
      
      // Store preAuthed status for explore.agent to use (e.g., close original tab when preAuthed)
      session.preAuthed = preAuthed;
    }

    // === STEP 1: EXPLORE AGENT SCAN ===
    _postLearnProgress(agentId, { type: 'learn:exploring', message: `Scanning ${urlsToScan.length} URL(s)...`, totalUrls: urlsToScan.length });
    
    const exploreAgent = require('./explore.agent.cjs');
    // Normalize all goals for multi-goal learning support
    const normalizedGoals = await Promise.all(userGoals.map(g => _normalizeGoal(g, hostname)));
    
    // Scan all URLs in a single scanDomain call (handles multiple URLs sequentially)
    const exploreResult = await exploreAgent.scanDomain({
      urls: urlsToScan,
      agentId,
      sessionId: _learnSessionId, // reuse the already-open, already-logged-in browser session
      maxScanDepth,
      goals: normalizedGoals, // Pass ALL goals to guide exploration toward multiple relevant actions
      _progressCallbackUrl: PROGRESS_CB_URL,
      _trigger: 'learn_mode',
      headed: true, // ALWAYS headed for learn scans — headless Chrome is blocked by Cloudflare/bot protection
      _preAuthed: session.preAuthed, // pass pre-auth status so explore can close original tab
    });

    if (!exploreResult.ok) {
      _postLearnProgress(agentId, { type: 'learn:error', error: exploreResult.error });
      return { ok: false, error: exploreResult.error };
    }

    // Detect bot-protection block — if any URL had bot protection
    if (exploreResult.botBlocked) {
      _postLearnProgress(agentId, {
        type: 'learn:bot_detected',
        message: `⚠️ ${hostname} uses bot protection (Cloudflare/security check). The scan ran in visible browser mode but was still challenged. Try signing in manually in the browser window, then click Learn again.`,
      });
      logger.warn(`[learn.agent] Bot protection detected on ${hostname} — scan may be incomplete`);
    }

    // Get discovered states
    const domainMapPath = path.join(os.homedir(), '.thinkdrop', 'domain-maps', `${hostname}.json`);
    let discoveredStates = [];
    
    if (fs.existsSync(domainMapPath)) {
      try {
        const domainMap = JSON.parse(fs.readFileSync(domainMapPath, 'utf8'));
        discoveredStates = Object.keys(domainMap.states || {});
        session.discoveredStates = discoveredStates;
        logger.info(`[learn.agent] Step 1 complete: ${discoveredStates.length} states discovered`);
      } catch (e) {
        logger.warn(`[learn.agent] Failed to read domain map: ${e.message}`);
      }
    }

    // === STEP 2: WEB RESEARCH (if insufficient states) ===
    if (discoveredStates.length < MIN_STATES_THRESHOLD) {
      _postLearnProgress(agentId, { 
        type: 'learn:web_research', 
        message: `Found only ${discoveredStates.length} states. Researching web for guidance...` 
      });

      try {
        const webAgent = require('./web.agent.cjs');
        // Normalize the raw goal to a clean 3-6 word core intent before building the search query.
        // Users often type full sentences, typos, or vague phrasing — the LLM extracts the intent.
        const normalizedGoal = await _normalizeGoal(primaryGoal, hostname);
        const webResult = await webAgent({
          action: 'get_tutorial_steps',
          query: `${normalizedGoal} on ${hostname}`
        });

        if (webResult.skipped) {
          logger.info(`[learn.agent] Web research skipped (not configured) — continuing without web insights`);
        } else if (webResult.ok && webResult.mergedSteps?.length > 0) {
          session.insights.push({
            source: 'web',
            steps: webResult.mergedSteps,
            confidence: webResult.confidence
          });
          
          _postLearnProgress(agentId, {
            type: 'learn:web_learned',
            message: `Found ${webResult.mergedSteps.length} steps from web research`,
            stepCount: webResult.mergedSteps.length
          });

          // Re-scan with web insights
          _postLearnProgress(agentId, { type: 'learn:re_exploring', message: 'Re-scanning with web insights...' });
          
          const exploreResult2 = await exploreAgent.scanDomain({
            url: startUrl,
            agentId,
            sessionId: _learnSessionId, // reuse same logged-in session
            maxScanDepth,
            goals: normalizedGoals, // Pass ALL goals to re-scan as well
            _progressCallbackUrl: PROGRESS_CB_URL,
            _trigger: 'learn_mode_web_enhanced',
            guidedBy: webResult.mergedSteps,
            headed: true, // ALWAYS headed — same reason as Step 1
          });

          if (exploreResult2.ok && fs.existsSync(domainMapPath)) {
            try {
              const domainMap2 = JSON.parse(fs.readFileSync(domainMapPath, 'utf8'));
              discoveredStates = Object.keys(domainMap2.states || {});
              session.discoveredStates = discoveredStates;
              // Merge skills from second scan
              if (exploreResult2.generatedSkills?.length > 0) {
                exploreResult.generatedSkills = exploreResult2.generatedSkills;
              }
            } catch (e) {
              logger.warn(`[learn.agent] Failed to read updated domain map: ${e.message}`);
            }
          }
        }
      } catch (err) {
        logger.warn(`[learn.agent] Web research failed: ${err.message}`);
      }
    }

    // === STEP 3: DETERMINE IF TRAINING NEEDED ===
    const needsTraining = discoveredStates.length < MIN_STATES_THRESHOLD;

    // Update agent descriptor with discovered states and generated skills
    const generatedSkills = exploreResult.generatedSkills || [];
    _updateAgentWithLearnedStates(agentPath, descriptor, discoveredStates, session.insights, generatedSkills);

    const duration = Date.now() - session.startTime;
    
    if (needsTraining) {
      _postLearnProgress(agentId, { 
        type: 'learn:needs_training', 
        message: `Could not fully auto-learn (${discoveredStates.length} states found). Training recommended.`,
        states: discoveredStates,
        stateCount: discoveredStates.length,
        duration,
      });

      return {
        ok: true,
        agentId,
        hostname,
        states: discoveredStates,
        stateCount: discoveredStates.length,
        duration,
        needsTraining: true,
        reason: 'Insufficient states discovered through automated methods',
      };
    }

    _postLearnProgress(agentId, { 
      type: 'learn:complete', 
      message: exploreResult.summary ? 
        `✨ Scan complete! Found ${exploreResult.summary.successful} actions, collected ${exploreResult.summary.dataItems || 0} data items, generated ${exploreResult.summary.skillsGenerated} skills` :
        `Successfully learned ${discoveredStates.length} states`,
      states: discoveredStates,
      duration,
      stateCount: discoveredStates.length,
      insights: session.insights.length,
      requiresDismissal: true,
      scanStats: exploreResult.summary || null
    });

    logger.info(`[learn.agent] Progressive learn complete for ${agentId} — ${discoveredStates.length} states, ${session.insights.length} insights, ${duration}ms`);

    return {
      ok: true,
      agentId,
      hostname,
      states: discoveredStates,
      stateCount: discoveredStates.length,
      duration,
      needsTraining: false,
      insights: session.insights,
    };

  } catch (err) {
    logger.error(`[learn.agent] Learn mode error: ${err.message}`);
    _postLearnProgress(agentId, { type: 'learn:error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeLearnSessions.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Update agent .md file with learned states and insights
// ---------------------------------------------------------------------------
function _updateAgentWithLearnedStates(agentPath, descriptor, states, insights = [], generatedSkills = []) {
  try {
    let updated = descriptor;
    
    // Update status based on learning success
    const status = states.length >= MIN_STATES_THRESHOLD ? 'learned' : 'needs_training';
    if (/^status:\s*.+$/m.test(updated)) {
      updated = updated.replace(/^status:\s*.+$/m, `status: ${status}`);
    } else {
      // Add status field after id: if no status exists
      updated = updated.replace(/^(id:\s*.*)$/m, `$1\nstatus: ${status}`);
    }
    
    // Add or update last_learned timestamp
    const now = new Date().toISOString();
    if (/^last_learned:\s*.+$/m.test(updated)) {
      updated = updated.replace(/^last_learned:\s*.+$/m, `last_learned: ${now}`);
    } else {
      // Add last_learned after status
      updated = updated.replace(/^(status:\s*.*)$/m, `$1\nlast_learned: ${now}`);
    }
    
    // Add or update learned_states list (only valid http/https URLs)
    const validStates = (states || []).filter(s => typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://')));
    if (validStates.length > 0) {
      const statesYaml = validStates.map(s => `  - ${s}`).join('\n');
      
      if (/^learned_states:/m.test(updated)) {
        // Replace only the bullet lines under learned_states: (stop at next top-level key or end-of-frontmatter)
        updated = updated.replace(/^learned_states:\s*\n(?:\s+-[^\n]*\n?)*/m, `learned_states:\n${statesYaml}\n`);
      } else {
        updated = updated.replace(/^(last_learned:\s*.*)$/m, `$1\nlearned_states:\n${statesYaml}`);
      }
    }
    
    // Add research insights if available
    if (insights.length > 0) {
      const webInsight = insights.find(i => i.source === 'web');
      if (webInsight && !updated.includes('## Research Insights')) {
        const insightsSection = `\n\n## Research Insights\n\n### Web Research\n${webInsight.steps.map(s => `- ${s.text}`).join('\n')}`;
        updated += insightsSection;
      }
    }
    
    // Add ## Learned States section if not present
    if (!updated.includes('## Learned States')) {
      const statesSection = `\n\n## Learned States\n${states.map(s => `- **${s}**: ${s.replace(/_/g, ' ')}`).join('\n')}`;
      updated += statesSection;
    }
    
    // Add generated skills to ## Capabilities section
    if (generatedSkills.length > 0) {
      // Update frontmatter capabilities list - replace with clean deduped list
      const skillNames = generatedSkills.map(s => s.name || s);
      const uniqueSkills = [...new Set(skillNames)]; // dedupe
      const skillsYaml = uniqueSkills.map(s => `  - ${s}`).join('\n');
      
      if (/^capabilities:/m.test(updated)) {
        // Merge new skills with existing ones, then deduplicate
        const existingCapMatch = updated.match(/^capabilities:\s*\n((?:\s+-\s+[^\n]*\n?)*)/m);
        const existingCaps = existingCapMatch
          ? existingCapMatch[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
          : [];
        const mergedUnique = [...new Set([...existingCaps, ...skillNames])];
        const mergedYaml = mergedUnique.map(s => `  - ${s}`).join('\n');
        updated = updated.replace(/^(capabilities:[\s\S]*?)(?=\n\w|$)/m, `capabilities:\n${mergedYaml}`);
      }
      
      // Add to ## Capabilities section - append only new skills, keep existing ones
      if (updated.includes('## Capabilities')) {
        updated = updated.replace(/(## Capabilities[\s\S]*?)(?=\n##|$)/, (match) => {
          // Get existing skill names from the section
          const existingSkills = match.split('\n')
            .filter(l => l.trim().startsWith('-'))
            .map(l => {
              const nameMatch = l.match(/^-\s+(\w+)/);
              return nameMatch ? nameMatch[1] : null;
            }).filter(Boolean);
          
          // Only add skills that don't already exist
          const newSkills = generatedSkills.filter(s => !existingSkills.includes(s.name || s));
          if (newSkills.length === 0) return match; // nothing new to add
          
          const skillsList = newSkills.map(s => `- ${s.name || s} - ${s.description || 'Auto-generated skill from scan'}`).join('\n');
          return match + '\n' + skillsList;
        });
      } else {
        // Create ## Capabilities section if it doesn't exist
        const skillsList = generatedSkills.map(s => `- ${s.name || s} - ${s.description || 'Auto-generated skill from scan'}`).join('\n');
        const capabilitiesSection = `\n\n## Capabilities\n\n${skillsList}`;
        
        // Insert before ## Learned States if it exists, otherwise append at end
        if (updated.includes('## Learned States')) {
          updated = updated.replace(/(## Learned States)/, capabilitiesSection + '\n\n$1');
        } else {
          updated += capabilitiesSection;
        }
      }
    }
    
    fs.writeFileSync(agentPath, updated, 'utf8');
    logger.info(`[learn.agent] Updated agent file with ${states.length} states, ${insights.length} insights, ${generatedSkills.length} skills`);
  } catch (err) {
    logger.error(`[learn.agent] Failed to update agent file: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Goal-directed learning — LLM path planner + per-goal skill synthesis
// ---------------------------------------------------------------------------

const PATH_PLANNER_SYSTEM = `You are a browser automation expert executing a single focused navigation step.

You will receive a CURRENT STEP OBJECTIVE — a narrow, specific sub-task (not the full end goal). Focus ONLY on completing that one step.

CRITICAL: Your ENTIRE reply must be a single JSON object and NOTHING ELSE. No explanation, no preamble, no markdown fences, no prose. Start your reply with { and end with }.

JSON format when action needed:
{"action":"click","selector":"[aria-label=\"History\"]","value":"","elementDescription":"History link in sidebar","purpose":"Opens search history panel","goalAchieved":false}

JSON format when this step is already complete on the current page:
{"action":null,"selector":null,"value":null,"elementDescription":null,"purpose":"Step already complete","goalAchieved":true}

Valid action values: click, fill, select, hover, scroll, press
For fill: set value to the text to type.
For press: set value to key name (Enter, Escape, Tab, ArrowDown, etc.)
For click/hover/scroll: set value to empty string.

Rules:
- ONE action only — pick the element that most directly completes THIS STEP
- Use the selector EXACTLY as listed in AVAILABLE ACTIONS — do NOT substitute or invent [ref=eNNN] values
- Do NOT pick the main search box unless this step explicitly asks to search something
- Do NOT repeat an action already listed under ALREADY TRIED
- If no element on this page can complete this step, set goalAchieved:true
- ONLY output JSON — any prose will break parsing

Navigation guidance:
- For goals involving finding/navigating to existing content (history, library, settings, etc.), prefer navigation links and menu items in sidebars or headers over the search box
- Only use the search box if the goal explicitly asks to "search for" or "find by keyword"
- When navigating, look for links with labels like "History", "Library", "Saved", "Bookmarks", "Settings", "Menu" in sidebars or top navigation`;


const DECOMPOSE_SYSTEM = `You decompose a browser automation goal into 2-5 ordered micro-steps.
Each step is a single focused navigation or interaction objective achievable in 1-3 browser actions.
Starting point is always the site's landing page.

CRITICAL: Reply ONLY with a valid JSON array of strings. No prose, no markdown fences.
["step 1", "step 2", ...]

Rules:
- Be specific: "click the History link in the left sidebar" not "go to history"
- Each step should unlock the next (navigation first, then interaction)
- Last step = the final action that completes the original goal
- If the goal is achievable in a single action, return a 1-element array
- ONLY output a JSON array`;

/**
 * Decompose a user goal into ordered micro-steps.
 * Returns string[] of 2-5 step descriptions. Falls back to [goal] on failure.
 */
async function _decomposeGoal(goal, hostname, landingSnapshot) {
  try {
    const userMsg = `GOAL: ${goal}\nSITE: ${hostname}\n\nLANDING PAGE SNAPSHOT (top elements):\n${(landingSnapshot || '').slice(0, 3000)}\n\nDecompose into ordered micro-steps (JSON array of strings):`;
    const raw = await askWithMessages([
      { role: 'system', content: DECOMPOSE_SYSTEM },
      { role: 'user', content: userMsg },
    ], { temperature: 0.1, maxTokens: 300, responseTimeoutMs: 20000 });
    if (!raw) return [goal];
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!arrMatch) return [goal];
    const parsed = JSON.parse(arrMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return [goal];
    const steps = parsed.map(s => String(s).trim()).filter(Boolean).slice(0, 5);
    logger.info(`[learn.agent] Decomposed "${goal}" → ${steps.length} micro-steps: ${JSON.stringify(steps)}`);
    return steps;
  } catch (e) {
    logger.warn(`[learn.agent] _decomposeGoal failed (${e.message}) — using goal as single step`);
    return [goal];
  }
}

/**
 * Lightweight check — ask LLM if the current micro-step has been completed.
 * Returns boolean.
 */
async function _checkMicroStepAchieved(microStep, snapshot) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You determine if a browser navigation step has been completed. Reply with ONLY "yes" or "no".' },
      { role: 'user', content: `STEP OBJECTIVE: ${microStep}\n\nCURRENT PAGE SNAPSHOT:\n${(snapshot || '').slice(0, 3000)}\n\nHas this step been completed?` },
    ], { temperature: 0, maxTokens: 5, responseTimeoutMs: 10000 });
    return /^yes/i.test((raw || '').trim());
  } catch (e) {
    return false;
  }
}

/**
 * Extract the current page URL from a Playwright snapshot string.
 * Snapshot always contains: "- Page URL: <url>"
 */
function _extractUrlFromSnapshot(snapshot) {
  const m = (snapshot || '').match(/^-\s*Page URL:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

// Generic/dynamic labels that shouldn't be used alone as aria-label selectors
const GENERIC_LABELS = new Set([
  'new', 'search', 'home', 'menu', 'more', 'settings', 'profile', 'close', 'open',
  'cancel', 'submit', 'ok', 'yes', 'no', 'back', 'next', 'done', 'save', 'edit',
  'delete', 'remove', 'add', 'create', 'update', 'share', 'copy', 'paste', 'send',
]);

/**
 * Derive a stable DOM selector from snapshot element attributes.
 * Does NOT make browser calls — uses label/type from snapshot text only.
 * Priority: aria-label → role+name → placeholder → text-based → ref fallback
 *
 * @param {string} type  - element type from snapshot (button, link, textbox, etc.)
 * @param {string} label - visible/accessible label text from snapshot
 * @param {string} ref   - playwright ref id (e.g. e44) — fallback only
 * @returns {string} CSS selector string
 */
function _deriveStableSelector(type, label, ref) {
  const trimmed = (label || '').trim();
  const lower = trimmed.toLowerCase();

  // Empty label → can't build stable selector, use ref
  if (!trimmed) return `[ref=${ref}]`;

  // Very long labels (>50 chars) are likely dynamic content — use text match
  if (trimmed.length > 50) {
    const snippet = trimmed.slice(0, 40).replace(/"/g, '\\"');
    return `*:has-text("${snippet}")`;
  }

  const escaped = trimmed.replace(/"/g, '\\"');
  const isGeneric = GENERIC_LABELS.has(lower);

  // For textbox/combobox: use placeholder-style or input selector
  if (type === 'textbox' || type === 'combobox') {
    // Empty label — can't build a specific selector; use broad input fallback
    if (!trimmed) return `textarea, [role="textbox"], [contenteditable="true"]`;
    if (!isGeneric) {
      return `[aria-label="${escaped}"], input[placeholder="${escaped}"], textarea[placeholder="${escaped}"]`;
    }
    return `input[placeholder="${escaped}"], textarea[placeholder="${escaped}"], [role="combobox"][aria-label="${escaped}"]`;
  }

  // For checkbox/select: use aria-label
  if (type === 'checkbox' || type === 'select') {
    return `[aria-label="${escaped}"]`;
  }

  // For link: prefer aria-label if not generic, else text-based
  if (type === 'link') {
    if (!isGeneric) return `[aria-label="${escaped}"]`;
    return `a:has-text("${escaped}")`;
  }

  // For button/menuitem/tab/listitem: prefer aria-label if not generic, else role+text
  if (!isGeneric) {
    return `[aria-label="${escaped}"]`;
  }
  // Generic button label — use text match with tag hint
  const tag = type === 'button' ? 'button' : type === 'menuitem' ? '[role="menuitem"]' : '';
  return tag ? `${tag}:has-text("${escaped}")` : `*:has-text("${escaped}")`;
}

/**
 * Parse interactive elements from a Playwright accessibility snapshot.
 * Returns array of { interaction, label, selector, primary, skillName, ref }.
 */
function _parseSnapshotActions(snapshot) {
  const lines = (snapshot || '').split('\n');
  const actions = [];
  const seen = new Set();
  for (const line of lines) {
    // Match: - button "Label" [ref=eNNN] or link, textbox, combobox, checkbox, menuitem, tab, select, listitem
    const m = line.match(/^\s*-\s+(button|link|textbox|combobox|checkbox|menuitem|listitem|tab|select)\s+"([^"]*?)"\s+\[ref=([\w\d]+)\]/i);
    if (!m) continue;
    const [, rawType, label, ref] = m;
    const type = rawType.toLowerCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const interaction = (type === 'textbox' || type === 'combobox') ? 'fill' : 'click';
    // Derive stable DOM selector — ref is kept as fallback only for live navigation
    const stableSelector = _deriveStableSelector(type, label, ref);
    actions.push({
      interaction,
      label: label || ref,
      ref,                          // keep original ref for live click/highlight
      selector: stableSelector,     // stable selector for skill files
      primary: stableSelector,
      skillName: label || ref,
    });
  }
  return actions;
}

/**
 * Count interactive elements in a snapshot.
 * Uses same pattern as _parseSnapshotActions for consistency.
 */
function _countInteractiveElements(snapshot) {
  if (!snapshot) return 0;
  const lines = snapshot.split('\n');
  let count = 0;
  for (const line of lines) {
    if (/^\s*-\s+(button|link|textbox|combobox|checkbox|menuitem|listitem|tab|select)\s+/i.test(line)) {
      count++;
    }
  }
  return count;
}

/**
 * Infer a human-readable name for a UI state from snapshot patterns.
 * Used ONLY for naming, not detection.
 */
function _inferStateName(snapshot) {
  if (!snapshot) return 'ui change';
  
  const patterns = [
    { regex: /\b(create|new)\s+(space|project|item|task)/i, name: 'create dialog' },
    { regex: /\b(history|recent|past|previous)/i, name: 'history dropdown' },
    { regex: /\b(search|find|query|lookup)/i, name: 'search dropdown' },
    { regex: /\b(share|invite|send\s+to|collaborate)/i, name: 'share dialog' },
    { regex: /\b(settings|preferences|options|config)/i, name: 'settings panel' },
    { regex: /\b(profile|account|user\s+menu|my\s+account)/i, name: 'user menu' },
    { regex: /\b(more|additional|extra|actions)/i, name: 'more options' },
    { regex: /\b(filter|sort|organize|refine)/i, name: 'filter dropdown' },
    { regex: /\b(dialog|modal|popup|overlay)\b/i, name: 'modal' },
    { regex: /\b(menu|dropdown|submenu)\b/i, name: 'dropdown' },
    { regex: /\b(tooltip|hint|info)\b/i, name: 'tooltip' },
  ];
  
  for (const p of patterns) {
    if (p.regex.test(snapshot)) return p.name;
  }
  return 'ui change';
}

/**
 * Detect UI state changes (modals, dropdowns, popovers) by comparing pre/post snapshots.
 * Primary detection: element count difference (eliminates false positives from patterns).
 * Secondary: pattern matching for naming and borderline cases (3-4 elements).
 * Returns array of state descriptions like "create dialog (18 elements)".
 */
function _detectUIStatesByComparison(preSnapshot, postSnapshot, preUrl, postUrl) {
  // Must be same URL (not navigation)
  if (preUrl !== postUrl) return [];
  
  const preCount = _countInteractiveElements(preSnapshot);
  const postCount = _countInteractiveElements(postSnapshot);
  const added = postCount - preCount;
  
  // Primary threshold: 5+ elements = confident UI state detection
  if (added >= 5) {
    const name = _inferStateName(postSnapshot);
    return [`${name} (${added} elements)`];
  }
  
  // Borderline: 3-4 elements + pattern match = probable small dropdown/tooltip
  if (added >= 3 && added < 5) {
    const name = _inferStateName(postSnapshot);
    if (name !== 'ui change') {
      return [`${name} (${added} elements)`];
    }
  }
  
  // <3 elements or no patterns = ignore (noise, inline changes)
  return [];
}

/**
 * Format a UI state for pagesVisited array.
 * Format: "url -> [state description]"
 */
function _formatUIState(currentUrl, stateDescription) {
  return `${currentUrl} -> [${stateDescription}]`;
}

/**
 * Ask LLM which single action completes the current micro-step.
 * alreadyTried: array of selectors already attempted this micro-step (for loop-detection hint).
 * Returns { action, selector, value, elementDescription, purpose, goalAchieved }, { goalAchieved: true }, or null on failure.
 */
async function _planNextStep(microStep, currentUrl, snapshot, pageActions, alreadyTried = [], extraHint = '') {
  const _attempt = async (hint = extraHint) => {
    const actionList = pageActions.slice(0, 40).map((a, i) => {
      const sel = a.selector || a.primary || '';
      const label = a.skillName || a.label || '';
      return `${i + 1}. [${a.interaction || 'click'}] ${label} — ${sel}`;
    }).join('\n');

    const triedSection = alreadyTried.length > 0
      ? `\n\nALREADY TRIED (do NOT pick these again):\n${alreadyTried.map(s => `- ${s}`).join('\n')}`
      : '';

    const userMsg = `CURRENT STEP OBJECTIVE: ${microStep}\nCURRENT URL: ${currentUrl}${hint}${triedSection}\n\nAVAILABLE ACTIONS (use the selector exactly as shown):\n${actionList || '(none detected)'}\n\nPAGE SNAPSHOT:\n${(snapshot || '').slice(0, 6000)}`;

    const raw = await askWithMessages([
      { role: 'system', content: PATH_PLANNER_SYSTEM },
      { role: 'user', content: userMsg },
    ], { temperature: 0.1, maxTokens: 300, responseTimeoutMs: 20000 });

    if (!raw) return null;
    const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.goalAchieved === true) return { goalAchieved: true };
    if (!parsed.action || !parsed.selector) return null;

    // Resolve LLM-returned selector back to the stable selector from pageActions.
    // The LLM may return a [ref=eNNN] even though pageActions has the stable selector.
    const llmSel = (parsed.selector || '').trim();
    const refMatch = llmSel.match(/^\[ref=(e[\w\d]+)\]$/i);
    if (refMatch) {
      const ref = refMatch[1];
      const matchedAction = pageActions.find(a => a.ref === ref || `[ref=${a.ref}]` === llmSel);
      if (matchedAction && matchedAction.selector && !/^\[ref=/.test(matchedAction.selector)) {
        parsed.selector = matchedAction.selector;
      }
    } else {
      // Non-ref selector: try to confirm against pageActions for label enrichment
      const byLabel = pageActions.find(a =>
        (a.label || a.skillName || '').toLowerCase() === (parsed.elementDescription || '').toLowerCase()
      );
      if (byLabel && byLabel.selector && !/^\[ref=/.test(byLabel.selector)) {
        parsed.selector = byLabel.selector;
      }
    }

    return parsed;
  };

  try {
    return await _attempt();
  } catch (e) {
    logger.warn(`[learn.agent] _planNextStep attempt 1 failed: ${e.message} — retrying`);
    try {
      return await _attempt();
    } catch (e2) {
      logger.warn(`[learn.agent] _planNextStep attempt 2 failed: ${e2.message}`);
      return null;
    }
  }
}

/**
 * Execute a single planned action via browserAct.
 * Returns { ok, newUrl, error }.
 */
async function _executeAction(plannedAction, sessionId, headed) {
  const { browserAct } = require('./browser.act.cjs');
  const { action, selector, value } = plannedAction;
  try {
    let res;
    if (action === 'fill') {
      // Dismiss any open autocomplete/dropdown, then clear existing text via triple-click select-all
      await browserAct({ action: 'press', key: 'Escape', selector, sessionId, headed, timeoutMs: 2000 }).catch(() => {});
      await browserAct({ action: 'dblclick', selector, sessionId, headed, timeoutMs: 3000 }).catch(() => {});
      await browserAct({ action: 'press', key: 'Control+a', selector, sessionId, headed, timeoutMs: 2000 }).catch(() => {});
      res = await browserAct({ action: 'fill', selector, text: value || '', sessionId, headed, timeoutMs: 10000 });
    } else if (action === 'press') {
      res = await browserAct({ action: 'press', key: value || 'Enter', selector, sessionId, headed, timeoutMs: 8000 });
    } else if (action === 'scroll') {
      res = await browserAct({ action: 'scroll', selector, sessionId, headed, timeoutMs: 8000 });
    } else {
      // click, hover, select, etc.
      res = await browserAct({ action: action || 'click', selector, sessionId, headed, timeoutMs: 10000 });
    }
    // After action, get current URL via snapshot (run-code returns full output block, not just URL)
    await browserAct({ action: 'waitForStableText', sessionId, headed, timeoutMs: 4000 }).catch(() => {});
    const postSnapRes = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 6000 }).catch(() => null);
    const postSnap = postSnapRes?.ok ? (postSnapRes.result || '') : '';
    const newUrl = _extractUrlFromSnapshot(postSnap);
    return { ok: res?.ok ?? false, newUrl, error: res?.error || null, _postSnap: postSnap };
  } catch (e) {
    return { ok: false, newUrl: null, error: e.message };
  }
}

/**
 * Lightweight goal-achieved check — ask LLM if the current snapshot satisfies the goal.
 * Returns boolean.
 */
async function _checkGoalAchieved(goal, snapshot) {
  try {
    const raw = await askWithMessages([
      { role: 'system', content: 'You determine if a browser automation goal has been achieved. Reply with ONLY "yes" or "no".' },
      { role: 'user', content: `GOAL: ${goal}\n\nCURRENT PAGE SNAPSHOT:\n${(snapshot || '').slice(0, 4000)}\n\nHas the goal been achieved?` },
    ], { temperature: 0, maxTokens: 5, responseTimeoutMs: 10000 });
    return /^yes/i.test((raw || '').trim());
  } catch (e) {
    return false;
  }
}

/**
 * Synthesize a composite skill name from a list of executed actions + goal.
 * Returns a snake_case skill name string.
 */
async function _synthesizeGoalSkill(actionsExecuted, goal, hostname) {
  if (!actionsExecuted || actionsExecuted.length === 0) return null;
  try {
    const actionSummary = actionsExecuted.map(a => `${a.action?.action || 'action'} on ${a.action?.elementDescription || a.action?.selector || '?'}`).join(' → ');
    const raw = await askWithMessages([
      { role: 'system', content: 'You name browser automation composite skills. Reply with ONLY a snake_case skill name, 2-5 words, no prefix. Examples: history_search, create_thread, upload_document.' },
      { role: 'user', content: `GOAL: ${goal}\nSITE: ${hostname}\nACTIONS TAKEN: ${actionSummary}\n\nSkill name (snake_case, 2-5 words):` },
    ], { temperature: 0.1, maxTokens: 15, responseTimeoutMs: 8000 });
    const name = (raw || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_').replace(/^_|_$/g, '');
    return name && name.length >= 4 ? name : null;
  } catch (e) {
    return null;
  }
}

/**
 * Explore a single goal starting from startUrl.
 * Uses cache-first action extraction, LLM path planning, visual highlights.
 * Returns { goal, actionsExecuted, compositeSkillName, pagesVisited }.
 */
async function _exploreGoalPath(args) {
  const { agentId, startUrl, goal, sessionId, headed, allDiscoveredActions, hostname } = args;
  const { browserAct } = require('./browser.act.cjs');
  const { INJECT_STYLES_CODE, buildHighlightAllCode, buildHighlightActiveCode } = require('../utils/visualFeedback.js');

  const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
  const MAX_ACTIONS_PER_STEP = 5;
  const actionsExecuted = [];
  const pagesVisited = [];
  let _scanDomainPromise = null; // tracks background scanDomain for awaiting before composite write
  let currentUrl = startUrl;

  // Inject visual styles once
  await browserAct({ action: 'run-code', code: INJECT_STYLES_CODE.trim(), sessionId, headed, timeoutMs: 5000 }).catch(() => {});

  // --- Phase 1: Take landing snapshot and decompose goal into micro-steps ---
  const landingSnapRes = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 }).catch(() => null);
  const landingSnapshot = landingSnapRes?.ok ? (landingSnapRes.result || '') : '';
  const snapshotStartUrl = _extractUrlFromSnapshot(landingSnapshot);
  if (snapshotStartUrl && !snapshotStartUrl.startsWith('about:')) currentUrl = snapshotStartUrl;
  if (!pagesVisited.includes(currentUrl)) pagesVisited.push(currentUrl);

  const microSteps = await _decomposeGoal(goal, hostname, landingSnapshot);
  _postLearnProgress(agentId, {
    type: 'learn:decomposed',
    goal,
    microSteps,
    message: `🗺 Decomposed into ${microSteps.length} step(s): ${microSteps[0]}…`,
  });

  // --- Phase 2: Execute each micro-step sequentially ---
  for (let msIdx = 0; msIdx < microSteps.length; msIdx++) {
    const microStep = microSteps[msIdx];
    logger.info(`[learn.agent] Micro-step ${msIdx + 1}/${microSteps.length}: "${microStep}"`);
    _postLearnProgress(agentId, {
      type: 'learn:micro_step_start',
      microStep,
      microStepIndex: msIdx + 1,
      totalMicroSteps: microSteps.length,
      message: `↳ Step ${msIdx + 1}/${microSteps.length}: ${microStep}`,
    });

    const alreadyTried = []; // selectors tried this micro-step (for loop detection)
    let lastSelector = null;
    let sameSelectCount = 0;

    for (let action = 0; action < MAX_ACTIONS_PER_STEP; action++) {
      // Get fresh snapshot
      const snapRes = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 10000 }).catch(() => null);
      const snapshot = snapRes?.ok ? (snapRes.result || '') : '';

      // Update currentUrl from snapshot
      const snapshotUrl = _extractUrlFromSnapshot(snapshot);
      if (snapshotUrl && snapshotUrl !== currentUrl && !snapshotUrl.startsWith('about:')) {
        _postLearnProgress(agentId, { type: 'learn:page_transition', from: currentUrl, to: snapshotUrl });
        if (currentUrl?.startsWith('http') && !pagesVisited.includes(currentUrl)) pagesVisited.push(currentUrl);
        // Invalidate old URL cache so a return visit gets a fresh snapshot
        allDiscoveredActions.delete(currentUrl);
        currentUrl = snapshotUrl;
      }
      if (currentUrl?.startsWith('http') && !pagesVisited.includes(currentUrl)) pagesVisited.push(currentUrl);

      // Cache-first action extraction
      let pageActions;
      const cacheKey = currentUrl;
      const cached = allDiscoveredActions.get(cacheKey);
      if (cached && (Date.now() - cached.cachedAt) < STALE_THRESHOLD_MS) {
        pageActions = cached.actions;
        // Only emit progress event, skip verbose info log for cache hits
        _postLearnProgress(agentId, { type: 'learn:cache_hit', url: currentUrl, count: pageActions.length });
      } else {
        pageActions = _parseSnapshotActions(snapshot);
        allDiscoveredActions.set(cacheKey, { cachedAt: Date.now(), ttl: STALE_THRESHOLD_MS, actions: pageActions });
        _postLearnProgress(agentId, { type: 'learn:cache_miss', url: currentUrl, count: pageActions.length });
        logger.info(`[learn.agent] Goal path: cache MISS for ${currentUrl} (${pageActions.length} actions extracted)`);

        if (pageActions.length > 0) {
          // Use live [ref=eNNN] for highlight (valid in current session), not stable selectors
          const hlCode = buildHighlightAllCode(pageActions.map(a => ({ selector: a.ref ? `[ref=${a.ref}]` : (a.selector || a.primary), skillName: a.skillName || a.label, label: a.label || a.skillName })));
          const hlRes = await browserAct({ action: 'run-code', code: hlCode, sessionId, headed, timeoutMs: 5000 }).catch(() => null);
          logger.info(`[learn.agent] Highlight injection: ${hlRes?.ok ? `${hlRes.result || 0} elements highlighted` : `failed — ${hlRes?.error || 'unknown'}`}`);

          // Kick off explore.agent.scanDomain in the background to write atomic skills to disk.
          // This runs concurrently with goal execution — atomic skills will be ready by the time
          // _writeCompositeSkill is called at the end of the goal path.
          if (!allDiscoveredActions.get('__scanDomain:' + currentUrl)) {
            allDiscoveredActions.set('__scanDomain:' + currentUrl, true); // mark to avoid duplicate scans
            logger.info(`[learn.agent] Triggering background scanDomain for ${currentUrl} to generate atomic skills`);
            const exploreAgent = require('./explore.agent.cjs');
            _scanDomainPromise = exploreAgent.scanDomain({
              url: currentUrl,
              agentId,
              sessionId,
              headed,
              maxScanDepth: 1,
              _preAuthed: true,
              _progressCallbackUrl: PROGRESS_CB_URL,
            }).then(r => {
              logger.info(`[learn.agent] Background scanDomain complete: ${r.ok ? `${r.actionsFound || 0} actions, ${(r.generatedSkills || []).length} skills written` : `failed — ${r.error || 'unknown'}`}`);
              return r;
            }).catch(e => {
              logger.warn(`[learn.agent] Background scanDomain error: ${e.message}`);
              return null;
            });
          }
        }
      }

      // Check if micro-step is already satisfied before executing anything
      if (action === 0) {
        const alreadyDone = await _checkMicroStepAchieved(microStep, snapshot);
        if (alreadyDone) {
          logger.info(`[learn.agent] Micro-step ${msIdx + 1} already satisfied on arrival`);
          break;
        }
      }

      // LLM: pick the single action that completes this micro-step
      const nextAction = await _planNextStep(microStep, currentUrl, snapshot, pageActions, alreadyTried);

      // Micro-step complete per LLM
      if (nextAction && nextAction.goalAchieved === true) {
        logger.info(`[learn.agent] Micro-step ${msIdx + 1} complete (LLM signal)`);
        break;
      }

      // LLM parse failure — Option 3: retry once with stronger hint, then skip micro-step
      if (!nextAction) {
        logger.warn(`[learn.agent] _planNextStep null for micro-step ${msIdx + 1} — skipping to next step`);
        break;
      }

      // Loop detection: same selector picked twice in a row → Option 3 retry with explicit hint
      if (nextAction.selector === lastSelector) {
        sameSelectCount++;
        if (sameSelectCount >= 2) {
          logger.warn(`[learn.agent] Same selector "${nextAction.selector}" picked ${sameSelectCount}x — retrying with exclusion hint`);
          const retryHint = `\n\nIMPORTANT: Do NOT pick "${nextAction.selector}" again — it did not advance the step.`;
          const retryAction = await _planNextStep(microStep, currentUrl, snapshot, pageActions, alreadyTried, retryHint).catch(() => null);
          if (!retryAction || retryAction.goalAchieved || retryAction.selector === nextAction.selector) {
            logger.warn(`[learn.agent] Retry still stuck on micro-step ${msIdx + 1} — skipping to next step`);
            break;
          }
          // Use retry result
          Object.assign(nextAction, retryAction);
          sameSelectCount = 0;
        }
      } else {
        sameSelectCount = 0;
      }
      lastSelector = nextAction.selector;
      if (nextAction.selector && !alreadyTried.includes(nextAction.selector)) {
        alreadyTried.push(nextAction.selector);
      }

      // Visual: highlight active element (green)
      if (nextAction.selector) {
        const activeCode = buildHighlightActiveCode(nextAction.selector, nextAction.elementDescription || nextAction.label);
        await browserAct({ action: 'run-code', code: activeCode, sessionId, headed, timeoutMs: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
      }

      _postLearnProgress(agentId, {
        type: 'learn:action_executing',
        goal,
        microStep,
        microStepIndex: msIdx + 1,
        totalMicroSteps: microSteps.length,
        step: actionsExecuted.length + 1,
        action: nextAction.action,
        element: nextAction.elementDescription || nextAction.selector,
        purpose: nextAction.purpose,
        message: `▶ Step ${msIdx + 1}/${microSteps.length}: ${nextAction.action} — ${nextAction.elementDescription || nextAction.selector}`,
      });

      // Execute the action
      const result = await _executeAction(nextAction, sessionId, headed);
      actionsExecuted.push({ url: currentUrl, action: nextAction, result });

      _postLearnProgress(agentId, {
        type: 'learn:action_executed',
        step: actionsExecuted.length,
        ok: result.ok,
        newUrl: result.newUrl,
      });

      // Check micro-step completion after action
      await new Promise(r => setTimeout(r, 400));
      const snapAfter = result._postSnap || '';
      
      // Detect and track UI state changes (modals, dropdowns, etc.)
      const uiStates = _detectUIStatesByComparison(snapshot, snapAfter, currentUrl, currentUrl);
      for (const state of uiStates) {
        const formattedState = _formatUIState(currentUrl, state);
        if (!pagesVisited.includes(formattedState)) {
          pagesVisited.push(formattedState);
          _postLearnProgress(agentId, { type: 'learn:ui_state_detected', url: currentUrl, state, formattedState });
          logger.info(`[learn.agent] UI state detected: ${formattedState}`);
        }
      }
      
      const stepDone = await _checkMicroStepAchieved(microStep, snapAfter);
      if (stepDone) {
        const postUrl = _extractUrlFromSnapshot(snapAfter);
        if (postUrl && !postUrl.startsWith('about:') && postUrl !== currentUrl) {
          _postLearnProgress(agentId, { type: 'learn:page_transition', from: currentUrl, to: postUrl });
          if (currentUrl?.startsWith('http') && !pagesVisited.includes(currentUrl)) pagesVisited.push(currentUrl);
          currentUrl = postUrl;
          if (currentUrl?.startsWith('http') && !pagesVisited.includes(currentUrl)) pagesVisited.push(currentUrl);
        }
        logger.info(`[learn.agent] Micro-step ${msIdx + 1} complete after action`);
        break;
      }
    }
  }

  // --- Phase 3: Final check — did the full original goal get achieved? ---
  const finalSnapRes = await browserAct({ action: 'snapshot', sessionId, headed, timeoutMs: 8000 }).catch(() => null);
  const finalSnapshot = finalSnapRes?.ok ? (finalSnapRes.result || '') : '';
  const goalMet = await _checkGoalAchieved(goal, finalSnapshot);
  _postLearnProgress(agentId, { type: 'learn:goal_achieved', goal, steps: actionsExecuted.length, achieved: goalMet });
  logger.info(`[learn.agent] Goal "${goal}" final check: ${goalMet ? 'ACHIEVED' : 'INCOMPLETE'} (${actionsExecuted.length} actions, ${pagesVisited.length} pages)`);

  // Await background scanDomain completion (atomic skills are the primary output now)
  if (_scanDomainPromise) {
    logger.info(`[learn.agent] Awaiting background scanDomain completion…`);
    await _scanDomainPromise.catch(() => {});
  }

  // COMPOSITE SKILL GENERATION DISABLED (Atomic Index model)
  // Previous: _synthesizeGoalSkill + _writeCompositeSkill would create composite skills
  // Now: We only extract atomic skills via scanDomain. Users use atomic skills directly
  // or use Training Mode for complex multi-step workflows.

  return { goal, actionsExecuted, pagesVisited, goalAchieved: goalMet };
}

/**
 * Goal-directed learn — processes ALL user goals sequentially, each starting from landing page.
 * Shared atomic skill cache across goals avoids re-scanning the same pages.
 */
async function actionGoalDirectedLearn(args) {
  const {
    agentId,
    goals: goalsOverride,
    _progressCallbackUrl,
    options = {},
  } = args || {};

  if (!agentId) return { ok: false, error: 'agentId is required' };
  if (activeLearnSessions.has(agentId)) return { ok: false, error: 'Learning already in progress for this agent' };

  const agentPath = path.join(AGENTS_DIR, `${agentId}.agent.md`);
  if (!fs.existsSync(agentPath)) return { ok: false, error: `Agent not found: ${agentId}` };

  const descriptor = fs.readFileSync(agentPath, 'utf8');
  const startUrlMatch = descriptor.match(/^start_url:\s*(.+)$/m);
  if (!startUrlMatch) return { ok: false, error: 'Agent missing start_url in frontmatter' };

  const startUrl = startUrlMatch[1].trim();
  const hostname = new URL(startUrl).hostname.replace(/^www\./, '');

  // Resolve goals
  const goalsMatch = descriptor.match(/^user_goals:[\s\S]*?(?=^\w|$)/m);
  let userGoals = [];
  if (goalsMatch) {
    userGoals = goalsMatch[0].split('\n').slice(1)
      .map(line => line.match(/^\s*-\s*"?([^"\n]+)"?/)?.[1])
      .filter(Boolean);
  }
  if (Array.isArray(goalsOverride) && goalsOverride.length > 0) {
    userGoals = goalsOverride;
  }
  if (userGoals.length === 0) userGoals = [`explore ${hostname}`];

  const _learnSessionId = `${agentId.replace(/[^a-z0-9_]/gi, '_')}_agent`;
  const headed = true; // Always headed for visual feedback

  const session = {
    agentId, startUrl, hostname,
    primaryGoal: userGoals[0],
    startTime: Date.now(),
    progress: 0,
    cancelRequested: false,
    discoveredStates: [],
    insights: [],
  };
  activeLearnSessions.set(agentId, session);

  logger.info(`[learn.agent] Goal-directed learn starting for ${agentId} — ${userGoals.length} goal(s)`);
  _postLearnProgress(agentId, {
    type: 'learn:start',
    hostname,
    startUrl,
    goal: userGoals[0],
    totalGoals: userGoals.length,
  });

  try {
    // === AUTH CHECK (reuse existing logic) ===
    const { browserAct } = require('./browser.act.cjs');
    const signInUrlMatch = descriptor.match(/^sign_in_url:\s*(.+)$/m);
    const authPatternMatch = descriptor.match(/^auth_success_pattern:\s*(.+)$/m);
    const isOAuthOnlySite = /google\.com|perplexity\.ai|openai\.com|chatgpt\.com|claude\.ai/i.test(hostname);
    const hasExplicitSignIn = signInUrlMatch || /login|signin|auth/i.test(startUrl);
    const requiresAuth = hasExplicitSignIn || (!isOAuthOnlySite && /login|signin|auth/i.test(startUrl));

    if (requiresAuth || isOAuthOnlySite) {
      const signInUrl = signInUrlMatch ? signInUrlMatch[1].trim() : (isOAuthOnlySite ? `https://${hostname}` : startUrl);
      const authPattern = authPatternMatch ? authPatternMatch[1].trim() : hostname;
      let preAuthed = _checkProfileAuth(_learnSessionId, hostname);

      if (preAuthed && isOAuthOnlySite) {
        try {
          await browserAct({ action: 'navigate', url: `https://${hostname}`, sessionId: _learnSessionId, headed, timeoutMs: 15000 });
          await browserAct({ action: 'waitForStableText', sessionId: _learnSessionId, headed, timeoutMs: 5000 }).catch(() => {});
          const snapRes = await browserAct({ action: 'snapshot', sessionId: _learnSessionId, headed, timeoutMs: 5000 }).catch(() => null);
          const snap = snapRes?.ok ? (snapRes.result || '') : '';
          const hasUserProfile = /(account|profile|sign out|log out|dashboard|history)/i.test(snap);
          const hasLoginButton = /(sign in|log in|get started)/i.test(snap) && !hasUserProfile;
          preAuthed = !hasLoginButton || hasUserProfile;
        } catch (e) {
          preAuthed = false;
        }
      }

      if (!preAuthed) {
        _postLearnProgress(agentId, {
          type: 'learn:auth_required',
          message: `🔐 Sign in to ${hostname} in the browser window, then come back.`
        });
        if (session.cancelRequested) {
          activeLearnSessions.delete(agentId);
          return { ok: false, reason: 'cancelled' };
        }
        const authResult = await browserAct({
          action: 'waitForAuth', url: signInUrl, authSuccessUrl: authPattern,
          sessionId: _learnSessionId, headed, timeoutMs: 120000, _progressCallbackUrl: PROGRESS_CB_URL,
        });
        if (session.cancelRequested || !authResult.ok) {
          activeLearnSessions.delete(agentId);
          return { ok: false, reason: session.cancelRequested ? 'cancelled' : 'auth_failed' };
        }
        _postLearnProgress(agentId, { type: 'learn:auth_success', message: 'Authenticated — starting goal-directed scan…' });
        await new Promise(r => setTimeout(r, 800));
      } else {
        logger.info(`[learn.agent] Goal-directed: already logged in — skipping auth`);
        _postLearnProgress(agentId, { type: 'learn:auth_success', message: 'Already signed in — starting…' });
      }
    }

    // === ATOMIC INDEX SCAN ===
    // Instead of goal decomposition + composite synthesis, we scan each relevant URL
    // to extract atomic skills. Users get atomic skills they can use directly or
    // chain together manually.
    
    const allDiscoveredActions = new Map();
    const goalResults = [];
    const detectedUIStates = new Set(); // Track unique UI states to prevent duplicates

    for (let i = 0; i < userGoals.length; i++) {
      if (session.cancelRequested) break;

      const rawGoal = userGoals[i];
      const goal = await _normalizeGoal(rawGoal, hostname);

      _postLearnProgress(agentId, {
        type: 'learn:goal_start',
        agentId,
        goal,
        goalIndex: i + 1,
        totalGoals: userGoals.length,
        message: `🎯 Scanning ${i + 1}/${userGoals.length}: ${goal}`,
      });

      // Navigate back to start for each goal (fresh start)
      await browserAct({ action: 'navigate', url: startUrl, sessionId: _learnSessionId, headed, timeoutMs: 15000 }).catch(() => {});
      await browserAct({ action: 'waitForStableText', sessionId: _learnSessionId, headed, timeoutMs: 5000 }).catch(() => {});

      const goalResult = await _exploreGoalPath({
        agentId,
        startUrl,
        goal,
        sessionId: _learnSessionId,
        headed,
        allDiscoveredActions,
        hostname,
      });

      goalResults.push(goalResult);

      // Deduplicate UI states across goals (prevent "history dropdown" appearing 4x)
      goalResult.pagesVisited = goalResult.pagesVisited.filter(state => {
        const normalized = state.replace(/\(\d+ elements\)/, '(N elements)'); // Normalize element counts
        if (normalized.includes(' -> [')) {
          if (detectedUIStates.has(normalized)) return false;
          detectedUIStates.add(normalized);
        }
        return true;
      });

      _postLearnProgress(agentId, {
        type: 'learn:goal_complete',
        agentId,
        goal,
        goalIndex: i + 1,
        totalGoals: userGoals.length,
        actionsExecuted: goalResult.actionsExecuted.length,
        pagesVisited: goalResult.pagesVisited.length,
        message: `✅ Scanned ${goal} — found ${goalResult.pagesVisited.length} states`,
      });
    }

    // === CACHE STATS ===
    const totalActionsCached = [...allDiscoveredActions.values()]
      .filter(p => p && typeof p === 'object' && Array.isArray(p.actions))
      .reduce((s, p) => s + p.actions.length, 0);
    const duration = Date.now() - session.startTime;

    // Collect all page URLs visited as "discovered states" 
    const discoveredStateUrls = [...new Set(goalResults.flatMap(r => r.pagesVisited))]
      .filter(u => typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://')));

    // Update agent descriptor (no composite skills in Atomic Index model)
    _updateAgentWithLearnedStates(agentPath, descriptor, discoveredStateUrls, session.insights, []);

    _postLearnProgress(agentId, {
      type: 'learn:complete',
      message: `✨ Atomic index complete! Indexed ${goalResults.length} URL(s), ${discoveredStateUrls.length} total states`,
      states: discoveredStateUrls,
      duration,
      stateCount: discoveredStateUrls.length,
      cacheStats: { pagesCached: allDiscoveredActions.size, totalActionsCached },
      requiresDismissal: true,
    });

    logger.info(`[learn.agent] Atomic index complete for ${agentId} — ${goalResults.length} URLs indexed, ${discoveredStateUrls.length} states, ${duration}ms`);

    return {
      ok: true,
      agentId,
      hostname,
      goalsProcessed: goalResults.length,
      cacheStats: { pagesCached: allDiscoveredActions.size, totalActionsCached },
      duration,
    };

  } catch (err) {
    logger.error(`[learn.agent] Goal-directed learn error: ${err.message}`);
    _postLearnProgress(agentId, { type: 'learn:error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    activeLearnSessions.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Cancel learn mode
// ---------------------------------------------------------------------------
function actionCancelLearn(args) {
  const { agentId } = args || {};
  
  if (!agentId) {
    return { ok: false, error: 'agentId is required' };
  }
  
  const session = activeLearnSessions.get(agentId);
  if (!session) {
    return { ok: false, error: 'No active learn session for this agent' };
  }
  
  session.cancelRequested = true;
  _postLearnProgress(agentId, { type: 'learn:cancelling' });

  // Signal the active scanDomain call to exit at its next cancel checkpoint.
  try {
    const exploreAgent = require('./explore.agent.cjs');
    exploreAgent.cancelActiveScan();
  } catch (_) {}

  // Navigate the browser session to about:blank to interrupt the waitForAuth poll loop.
  // Without this, waitForAuth blocks for up to 120s before the cancelRequested flag is checked.
  try {
    const { browserAct } = require('./browser.act.cjs');
    const cancelSessionId = `${agentId.replace(/[^a-z0-9_]/gi, '_')}_agent`;
    browserAct({ action: 'navigate', url: 'about:blank', sessionId: cancelSessionId, headed: true, timeoutMs: 5000 }).catch(() => {});
  } catch (_) {}

  return { ok: true, message: 'Learn mode cancellation requested' };
}

// ---------------------------------------------------------------------------
// Get learn status
// ---------------------------------------------------------------------------
function actionGetLearnStatus(args) {
  const { agentId } = args || {};
  
  if (agentId) {
    const session = activeLearnSessions.get(agentId);
    if (!session) {
      return { ok: true, active: false, agentId };
    }
    
    return {
      ok: true,
      active: true,
      agentId,
      progress: session.progress,
      startTime: session.startTime,
      discoveredStates: session.discoveredStates,
    };
  }
  
  // Return all active sessions
  const sessions = Array.from(activeLearnSessions.entries()).map(([id, s]) => ({
    agentId: id,
    progress: s.progress,
    startTime: s.startTime,
  }));
  
  return { ok: true, active: sessions.length > 0, sessions };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------
module.exports = {
  actionLearn,
  actionGoalDirectedLearn,
  actionCancelLearn,
  actionGetLearnStatus,
};
