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
const { deriveSessionId, withSessionMutex, qualifyOpenTab, resolveExtSession } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');

// Deep-link semantics live in the REQUESTED URL — create/compose/search
// deep-links redirect after doing their work (docs.google.com/document/create
// → /d/<id>/edit), so classifying only the landed URL degrades 'creation'
// to 'none' and downstream steps redo the action. Prefer the target's type;
// fall back to the landed URL's type for server-driven semantics.
function _resolveDeepLinkType(targetUrl, landedUrl) {
  try {
    const { classifyDeepLinkType } = require('../skill-helpers/deep-link-types.cjs');
    const targetType = classifyDeepLinkType(targetUrl) || 'none';
    if (targetType !== 'none') return targetType;
    return classifyDeepLinkType(landedUrl) || 'none';
  } catch (_) {
    return 'none';
  }
}

// Normalize create-intent deep links that resolve to inert bare URLs. A bare
// Google Calendar /eventedit (learned into the deep-link cache from prior
// edit-page traffic) renders the month GRID, not the event form — the create
// surface needs ?action=TEMPLATE. Only applied for create-ish tasks.
function _normalizeCreateUrl(url, task) {
  try {
    const u = new URL(url);
    const isCreateTask = /\b(create|add|new|schedule|book|make)\b/i.test(task || '');
    if (isCreateTask && u.hostname === 'calendar.google.com' &&
        /\/eventedit\/?$/i.test(u.pathname) && !u.searchParams.get('action')) {
      u.searchParams.set('action', 'TEMPLATE');
      return u.toString();
    }
  } catch (_) {}
  return url;
}

// Best-effort destination-name extraction for unregistered services — the
// task text carries the name ("Navigate to search for Cathay Pacific").
// Strip leading nav/search verbs + filler and cut at the first clause
// boundary; the residue names the place. Registry lookups can't enumerate
// real-world names, so web.agent resolves it.
function _extractDestinationName(task) {
  let s = String(task || '').trim();
  if (!s) return null;
  s = s
    .replace(/^\s*(?:please\s+)?(?:navigate\s+(?:to|over\s+to|back\s+to)|go\s+(?:to|back\s+to)|goto|visit|open|browse|launch|head\s+(?:to|over\s+to)|pull\s+up|bring\s+up|fire\s+up|log\s*(?:in|into)|sign\s*(?:in|into)|take\s+me\s+to)\b/i, '')
    .replace(/^\s*(?:to\s+)?(?:the\s+)?(?:search(?:ing)?\s+(?:for\s+|the\s+)?|look(?:ing)?\s+(?:for|up|at)|find|check|read|view|see|get|fetch|show)\s*/i, '')
    .trim();
  if (!s) return null;
  s = s.split(/\s+(?:and|then|&|on|in|with|using|via|from|for)\b|[,;]/i)[0].trim();
  // Trailing content nouns describe WHAT to look up, not where — strip in a
  // loop ("cathay pacific flights tickets" → "cathay pacific").
  let prev;
  do {
    prev = s;
    s = s.replace(/\s+(?:flights?|tickets?|results?|items?|deals?|products?|listings?|prices?|reviews?|photos?|pics|pictures?|images?|videos?|news|jobs?)$/i, '').trim();
  } while (s !== prev);
  if (!s || /^https?:/i.test(s) || s.length > 60) return null;
  return s;
}

async function urlFirstAgent(args = {}) {
  const { service, agentId: _agentId, task = '', url: _explicitUrl, headed = true, _progressCallbackUrl } = args;
  const agentId = _agentId || (service ? `${String(service).toLowerCase().replace(/\s+/g, '_')}.agent` : 'default.agent');
  const sessionId = qualifyOpenTab(await resolveExtSession(args.sessionId || deriveSessionId(agentId)), task);

  return withSessionMutex(sessionId, async () => {
    postProgress(_progressCallbackUrl, { tier: 'url-first', message: `url.first.agent: resolving destination for ${agentId}` });

    // 1. Resolve start URL: explicit arg > deep-link resolution > service startUrl
    let targetUrl = _explicitUrl || null;
    let deepLinkSource = _explicitUrl ? 'explicit' : null;
    let serviceInfo = null;

    try {
      serviceInfo = await resolveServiceTarget(service || agentId);
    } catch (_) {}

    // taskFacts.destination — resolved ONCE in preflightAgents and carried to
    // this step in args. Re-resolving here would duplicate the resolution
    // chain (~seconds) and could disagree with what the planner annotated —
    // a second independent judgment on the same question. Facts win.
    if (!targetUrl && args.taskFacts?.destination?.url
        && (!args.taskFacts.agentId || args.taskFacts.agentId === agentId)) {
      targetUrl = args.taskFacts.destination.url;
      deepLinkSource = `taskFacts:${args.taskFacts.destination.source || 'preflight'}`;
    }

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

    // Named-destination discovery — the service registry can't enumerate
    // real-world names ("cathay pacific"), so an unregistered destination
    // resolves through web.agent's search tier (the same discovery the
    // url_open template and nav_task use). Extract the name from the task,
    // search for its official site, navigate to the best result.
    if (!targetUrl && task) {
      const _destName = _extractDestinationName(task);
      const _serviceKey = String(service || agentId || '').replace(/\.agent$/i, '').toLowerCase();
      // Skip only when the name just restates the service (already searched).
      if (_destName && _destName.toLowerCase().replace(/[^a-z0-9]+/g, '') !== _serviceKey) {
        try {
          const { actionSearchAndNavigate } = require('./web.agent.cjs');
          const _sr = await actionSearchAndNavigate({ query: `${_destName} official website`, maxResults: 5 });
          const _best = _sr?.bestUrl || null;
          if (_sr?.ok && _best && /^https?:\/\//i.test(_best)) {
            targetUrl = _best;
            deepLinkSource = 'web-discovery';
            logger.info(`[url.first.agent] destination "${_destName}" resolved via web.agent → ${_best}`);
          }
        } catch (e) {
          logger.warn(`[url.first.agent] web discovery failed for "${_destName}": ${e.message}`);
        }
      }
    }
    if (!targetUrl) {
      return { ok: false, sessionId, agentId, error: `No URL resolved for ${agentId}` , suggestedAgent: null };
    }
    targetUrl = _normalizeCreateUrl(targetUrl, task) || targetUrl;

    // 2. Navigate the shared session
    logger.info(`[url.first.agent] navigating ${sessionId} → ${targetUrl} (source=${deepLinkSource || 'startUrl'})`);
    const nav = await browserAct({ action: 'navigate', sessionId, url: targetUrl, headed, timeoutMs: 30000, activate: true });
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
    const deepLinkType = _resolveDeepLinkType(targetUrl, landedUrl);

    postProgress(_progressCallbackUrl, { tier: 'url-first', message: `url.first.agent: landed ${landedUrl}` });
    return { ok: true, sessionId, agentId, url: landedUrl, deepLinkSource, deepLinkType, output: landedUrl };
  });
}

module.exports = { urlFirstAgent, _resolveDeepLinkType, _normalizeCreateUrl, _extractDestinationName };
