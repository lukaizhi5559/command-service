// ---------------------------------------------------------------------------
// Shared LLM-based auth detection — used by browser.agent.cjs and browser.act.cjs
// ---------------------------------------------------------------------------
// Returns: 0 = authenticated, 1 = auth required, null = LLM unavailable
// Uses a fast light model with maxTokens=5 for minimal latency and cost.
// Retries up to 3 times with backoff so transient provider outages don't
// force a fresh sign-in when the user is already authenticated.
// ---------------------------------------------------------------------------

const AUTH_CHECK_PROMPT = `You are analyzing a web page to determine if the user is authenticated.
Given the page TITLE and BODY TEXT, return ONLY a single number:
0 = authenticated (user is logged in — page shows real app content: calendar events, emails, files, dashboard data)
1 = auth required (page is a login form, sign-in page, marketing/landing page, or "create account" page)

Rules:
- 1 (auth required): login forms, "Sign in" buttons, marketing pages, "Get started", "Create account", "Sign in to continue", "Workspace not found"
- 0 (authenticated): page shows actual app content (calendar with events, inbox with emails, dashboard with data, documents)
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
 * @returns {Promise<number|null>} 0 = authenticated, 1 = auth required, null = LLM unavailable
 */
async function detectAuthViaLLM(title, body, agentId, logger) {
  const { askWithMessages } = require('./skill-llm.cjs');
  const messages = [
    { role: 'system', content: AUTH_CHECK_PROMPT },
    { role: 'user', content: `TITLE: ${(title || '').slice(0, 200)}\n\nBODY: ${(body || '').slice(0, 1000)}` }
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
