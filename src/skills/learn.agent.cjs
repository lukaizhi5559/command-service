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
    _postLearnProgress(agentId, { type: 'learn:exploring', message: 'Scanning domain structure...' });
    
    const exploreAgent = require('./explore.agent.cjs');
    // Normalize all goals for multi-goal learning support
    const normalizedGoals = await Promise.all(userGoals.map(g => _normalizeGoal(g, hostname)));
    const exploreResult = await exploreAgent.scanDomain({
      url: startUrl,
      agentId,
      sessionId: _learnSessionId, // reuse the already-open, already-logged-in browser session
      maxScanDepth,
      goals: normalizedGoals, // Pass ALL goals to guide exploration toward multiple relevant actions
      _progressCallbackUrl: PROGRESS_CB_URL,
      _trigger: 'learn_mode',
      headed: true, // ALWAYS headed for learn scans — headless Chrome is blocked by Cloudflare/bot protection
      _preAuthed: session.preAuthed, // pass pre-auth status so explore can close original tab
    });

    if (session.cancelRequested) {
      _postLearnProgress(agentId, { type: 'learn:cancelled' });
      return { ok: false, reason: 'cancelled' };
    }

    if (!exploreResult.ok) {
      _postLearnProgress(agentId, { type: 'learn:error', error: exploreResult.error });
      return { ok: false, error: exploreResult.error };
    }

    // Detect bot-protection block — if the only discovered state is a bot/security page
    // inform the user clearly so they understand why elements weren't found.
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

    // === STEP 3: VIDEO TUTORIAL (if still insufficient) ===
    if (discoveredStates.length < MIN_STATES_THRESHOLD) {
      _postLearnProgress(agentId, { 
        type: 'learn:video_search', 
        message: `Found ${discoveredStates.length} states. Searching for video tutorials...` 
      });

      try {
        // Note: video.agent requires browserAct dependency - simplified for now
        // In production, this would integrate with a browser session
        _postLearnProgress(agentId, { 
          type: 'learn:video_skipped', 
          message: 'Video analysis queued for future enhancement' 
        });
      } catch (err) {
        logger.warn(`[learn.agent] Video research failed: ${err.message}`);
      }
    }

    // === STEP 4: DETERMINE IF TRAINING NEEDED ===
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
    
    // Add or update learned_states list
    if (states.length > 0) {
      const statesYaml = states.map(s => `  - ${s}`).join('\n');
      
      if (/^learned_states:/m.test(updated)) {
        updated = updated.replace(/learned_states:[\s\S]*?(?=\n\w|$)/, `learned_states:\n${statesYaml}`);
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
        // Replace entire capabilities section with clean list
        updated = updated.replace(/^(capabilities:[\s\S]*?)(?=\n\w|$)/m, `capabilities:\n${skillsYaml}`);
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
  actionCancelLearn,
  actionGetLearnStatus,
};
