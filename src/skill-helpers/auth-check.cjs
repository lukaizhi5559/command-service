// ---------------------------------------------------------------------------
// Shared LLM-based auth detection — used by browser.agent.cjs and browser.act.cjs
// ---------------------------------------------------------------------------
// Returns: 0 = authenticated, 1 = auth required, null = LLM unavailable
// Uses a fast light model with maxTokens=5 for minimal latency and cost.
// Retries up to 3 times with backoff so transient provider outages don't
// force a fresh sign-in when the user is already authenticated.
// ---------------------------------------------------------------------------

const AUTH_CHECK_PROMPT = `You are analyzing a web page to determine if the user is authenticated.
Given the page TITLE, BODY TEXT, and EVIDENCE block, return ONLY a single number:
0 = authenticated (user is logged in — page shows real app content OR evidence confirms a live session)
1 = auth required (page is a login form, sign-in page, marketing/landing page, or "create account" page)

Rules:
- 1 (auth required): login forms, password fields, "Sign in" buttons, marketing pages, "Get started", "Create account", "Sign in to continue", "Workspace not found"
- 0 (authenticated): page shows actual app content (calendar with events, inbox with emails, dashboard with data, documents)
- 0 (authenticated): EVIDENCE lists authenticated session cookies AND there is no visible login form or password field — even when body text is sparse (chat apps and SPAs render minimal text when logged in)
- 1 (auth required): a visible login form or password field, or an identity endpoint returning 401/403 — regardless of cookies (cookies may be stale)
- When in doubt, return 1 (auth required — safer to re-authenticate)
Return ONLY the number.`;

const AUTH_MAX_RETRIES = 3;
const AUTH_RETRY_BACKOFF_MS = [0, 500, 1000];

/**
 * Detect whether a page is authenticated via LLM semantic analysis.
 * @param {string} title - page title
 * @param {string} body - page body text (first ~800-1000 chars)
 * @param {string} [agentId] - for logging only
 * @param {object} [logger] - optional logger with .info/.warn methods
 * @param {object} [evidence] - optional signals: { endpointStatus, authCookieNames,
 *   hasSignInButton, hasPasswordField, hasUserGlobal, jsUserSignals }
 * @returns {Promise<number|null>} 0 = authenticated, 1 = auth required, null = LLM unavailable
 */
async function detectAuthViaLLM(title, body, agentId, logger, evidence) {
  const { askWithMessages } = require('./skill-llm.cjs');
  let evidenceBlock = '';
  if (evidence && typeof evidence === 'object') {
    const lines = [];
    if (evidence.endpointStatus != null) lines.push(`identityEndpoint: ${evidence.endpointStatus}`);
    if (Array.isArray(evidence.authCookieNames) && evidence.authCookieNames.length > 0) {
      lines.push(`sessionCookiesPresent: ${evidence.authCookieNames.join(', ')}`);
    }
    if (evidence.hasSignInButton != null) lines.push(`hasSignInButton: ${evidence.hasSignInButton}`);
    if (evidence.hasPasswordField != null) lines.push(`hasPasswordField: ${evidence.hasPasswordField}`);
    if (evidence.hasUserGlobal != null) lines.push(`hasUserGlobal: ${evidence.hasUserGlobal}`);
    if (Array.isArray(evidence.jsUserSignals) && evidence.jsUserSignals.length > 0) {
      lines.push(`jsUserSignals: ${evidence.jsUserSignals.join(', ')}`);
    }
    if (lines.length > 0) evidenceBlock = `\n\nEVIDENCE:\n${lines.join('\n')}`;
  }
  const messages = [
    { role: 'system', content: AUTH_CHECK_PROMPT },
    { role: 'user', content: `TITLE: ${(title || '').slice(0, 200)}\n\nBODY: ${(body || '').slice(0, 1000)}${evidenceBlock}` }
  ];
  const opts = { temperature: 0, maxTokens: 5, responseTimeoutMs: 5000 };

  for (let attempt = 1; attempt <= AUTH_MAX_RETRIES; attempt++) {
    if (AUTH_RETRY_BACKOFF_MS[attempt - 1] > 0) {
      await new Promise(r => setTimeout(r, AUTH_RETRY_BACKOFF_MS[attempt - 1]));
      if (logger) logger.warn(`[auth-check] LLM auth detection retry ${attempt}/${AUTH_MAX_RETRIES} after previous failure`);
    }
    try {
      const raw = await askWithMessages(messages, opts);
      const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
      if (num === 0 || num === 1) {
        if (logger) logger.info(`[auth-check] LLM auth detection: ${num === 1 ? 'auth required' : 'authenticated'} for ${agentId || 'unknown'}`);
        return num; // 0 = authed, 1 = auth required
      }
      if (logger) logger.warn(`[auth-check] LLM auth detection: unparseable response "${raw}" on attempt ${attempt}/${AUTH_MAX_RETRIES}`);
    } catch (err) {
      if (logger) logger.warn(`[auth-check] LLM auth detection attempt ${attempt}/${AUTH_MAX_RETRIES} failed: ${err.message}`);
    }
  }
  // All retries exhausted — return null so caller can fall back to heuristics
  if (logger) logger.warn(`[auth-check] LLM auth detection: all ${AUTH_MAX_RETRIES} attempts failed — returning null for ${agentId || 'unknown'}`);
  return null;
}

module.exports = { AUTH_CHECK_PROMPT, detectAuthViaLLM };
