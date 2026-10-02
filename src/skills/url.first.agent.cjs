'use strict';

// ---------------------------------------------------------------------------
// url.first.agent.cjs — Atomic agent: navigate to a service URL (deep-linked).
//
// Owns the "URL-first" tier: resolve the best URL for the task (deep-link
// resolution via the existing resolver), navigate the shared browser session,
// and detect auth walls. Performs NO on-page interaction — that's what the
// other atomic agents are for.
//
// Contract:
//   args: { service?, agentId?, task?, url?, sessionId?, headed?, _progressCallbackUrl? }
//   returns { ok, url, sessionId, needsAuth?, deepLinkSource?, error? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { browserAct } = require('./browser.act.cjs');
const { resolveServiceTarget } = require('./lib/browserCore/services.cjs');
const { isSigninWall } = require('./lib/browserCore/auth.cjs');
const { deriveSessionId, withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

async function urlFirstAgent(args = {}) {
  const { service, agentId: _agentId, task = '', url: _explicitUrl, headed = true, _progressCallbackUrl } = args;
  const agentId = _agentId || (service ? `${String(service).toLowerCase().replace(/\s+/g, '_')}.agent` : 'default.agent');
  const sessionId = args.sessionId || deriveSessionId(agentId);

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'url-first', message: `url.first.agent: resolving destination for ${agentId}` });

    // 1. Resolve start URL: explicit arg > deep-link resolution > service startUrl
    let targetUrl = _explicitUrl || null;
    let deepLinkSource = _explicitUrl ? 'explicit' : null;
    let serviceInfo = null;

    try {
      serviceInfo = await resolveServiceTarget(service || agentId);
    } catch (_) {}

    if (!targetUrl && serviceInfo?.startUrl && task) {
      try {
        const { browserAgent } = require('./browser.agent.cjs');
        const dl = await browserAgent({
          action: 'resolve_deep_link',
          agentId, serviceKey: serviceInfo.serviceKey,
          startUrl: serviceInfo.startUrl, task, sessionId,
          headed, hidden: !headed,
        });
        if (dl?.ok && dl.deepLinkUrl) {
          targetUrl = dl.deepLinkUrl;
          deepLinkSource = dl.deepLinkSource || 'resolved';
        }
      } catch (e) {
        logger.warn(`[url.first.agent] deep-link resolution failed: ${e.message}`);
      }
    }
    if (!targetUrl) targetUrl = serviceInfo?.startUrl || null;
    if (!targetUrl) {
      return { ok: false, sessionId, agentId, error: `No URL resolved for ${agentId}` , suggestedAgent: null };
    }

    // 2. Navigate the shared session
    logger.info(`[url.first.agent] navigating ${sessionId} → ${targetUrl} (source=${deepLinkSource || 'startUrl'})`);
    const nav = await browserAct({ action: 'navigate', sessionId, url: targetUrl, headed, timeoutMs: 30000 });
    if (!nav?.ok) {
      return { ok: false, sessionId, agentId, url: targetUrl, error: `Navigation failed: ${nav?.error || 'unknown'}` };
    }

    // 3. Auth-wall check on the landed URL
    let landedUrl = targetUrl;
    try {
      const res = await browserAct({ action: 'evaluate', sessionId, headed, timeoutMs: 3000, text: 'window.location.href' });
      const raw = res?.result;
      landedUrl = (typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : raw) || targetUrl;
    } catch (_) {}

    if (isSigninWall(landedUrl)) {
      logger.warn(`[url.first.agent] signin wall detected at ${landedUrl}`);
      postProgress(_progressCallbackUrl, { tier: 'url-first', message: `url.first.agent: auth wall at ${landedUrl}` });
      return { ok: false, needsAuth: true, sessionId, agentId, url: landedUrl, error: `Sign-in wall detected at ${landedUrl}` };
    }

    // Deep-link type tells downstream steps what the landing page already did:
    // 'compose'/'creation' → a dialog auto-opened; 'search' → results already
    // loaded. Passed through so the next step's LLM doesn't redo it.
    let deepLinkType = 'none';
    try {
      deepLinkType = require('../skill-helpers/deep-link-types.cjs').classifyDeepLinkType(landedUrl) || 'none';
    } catch (_) {}

    postProgress(_progressCallbackUrl, { tier: 'url-first', message: `url.first.agent: landed ${landedUrl}` });
    return { ok: true, sessionId, agentId, url: landedUrl, deepLinkSource, deepLinkType, output: landedUrl };
  });
}

module.exports = { urlFirstAgent };
