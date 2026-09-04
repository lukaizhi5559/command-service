// ---------------------------------------------------------------------------
// Shared LLM-based auth detection — used by browser.agent.cjs and browser.act.cjs
// ---------------------------------------------------------------------------
// Returns: 0 = authenticated, 1 = auth required
// Uses a fast light model with maxTokens=5 for minimal latency and cost.
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

/**
 * Detect whether a page is authenticated via LLM semantic analysis.
 * @param {string} title - page title
 * @param {string} body - page body text (first ~800-1000 chars)
 * @param {string} [agentId] - for logging only
 * @param {object} [logger] - optional logger with .info/.warn methods
 * @returns {Promise<number>} 0 = authenticated, 1 = auth required
 */
async function detectAuthViaLLM(title, body, agentId, logger) {
  try {
    const { askWithMessages } = require('./skill-llm.cjs');
    const raw = await askWithMessages([
      { role: 'system', content: AUTH_CHECK_PROMPT },
      { role: 'user', content: `TITLE: ${(title || '').slice(0, 200)}\n\nBODY: ${(body || '').slice(0, 1000)}` }
    ], { temperature: 0, maxTokens: 5, responseTimeoutMs: 5000 });

    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num === 0 || num === 1) {
      if (logger) logger.info(`[auth-check] LLM auth detection: ${num === 1 ? 'auth required' : 'authenticated'} for ${agentId || 'unknown'}`);
      return num; // 0 = authed, 1 = auth required
    }
    if (logger) logger.info(`[auth-check] LLM auth detection: invalid "${raw}" → defaulting to 1 (auth required) for ${agentId || 'unknown'}`);
    return 1; // default: auth required (safer)
  } catch (err) {
    if (logger) logger.warn(`[auth-check] LLM auth detection failed (non-fatal): ${err.message}`);
    return 1; // default: auth required (safer)
  }
}

module.exports = { AUTH_CHECK_PROMPT, detectAuthViaLLM };
