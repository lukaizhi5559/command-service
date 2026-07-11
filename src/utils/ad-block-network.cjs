'use strict';

/**
 * ad-block-network.cjs — Network-layer ad blocking via playwright-cli
 *
 * Single setupInterception() call registers both layers atomically via one run-code:
 *   Layer 1 — page.route catch-all handler that aborts requests to ad network domains
 *   Layer 2 — page.addInitScript() that strips YouTube ad data before the player reads it
 *
 * MUST be called BEFORE navigating to the target URL (e.g. open about:blank first).
 * The route handler and init script persist for the session — only register once.
 */

const logger = require('../logger.cjs');

// Core ad network domains to block at the network layer (all sites)
const AD_NETWORK_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'adnxs.com',
  'moatads.com',
  'taboola.com',
  'outbrain.com',
  'amazon-adsystem.com',
  'criteo.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'adsafeprotected.com',
  'scorecardresearch.com',
  'quantserve.com',
  'adform.net',
  'smartadserver.com',
  'yieldmo.com',
  'triplelift.com',
  'sharethrough.com',
  'sovrn.com',
  'adsrvr.org',
  'adroll.com',
  'segment.com',
  'mixpanel.com',
  'hotjar.com',
  'fullstory.com',
  'chartbeat.com',
  'chartbeat.net',
];

// Track which sessions already have interception set up
const _activeSessions = new Set();

// The init script that runs at document-start on every page/navigation.
// Uses Object.defineProperty to intercept ytInitialPlayerResponse at assignment time.
// YouTube embeds this as a direct JS object literal in HTML — JSON.parse is never called,
// so a JSON.parse proxy misses it entirely. The setter fires on every assignment path.
const _INIT_SCRIPT = `(function() {
  if (window.__tdInitActive) return;
  window.__tdInitActive = true;

  // 1. Intercept ytInitialPlayerResponse via property setter.
  // YouTube assigns this as a direct object literal in an inline <script>:
  //   var ytInitialPlayerResponse = { adPlacements: [...], ... };
  // The setter fires before YouTube's player ever reads the value.
  var _realPlayerResponse;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: function() { return _realPlayerResponse; },
    set: function(v) {
      if (v && typeof v === 'object') {
        delete v.adPlacements;
        delete v.playerAds;
        delete v.adSlots;
        delete v.adBreakHeartbeatParams;
        delete v.adBreakParams;
      }
      _realPlayerResponse = v;
    }
  });

  // 2. Strip ad fields from YouTube SPA player API (fetch path).
  // On SPA navigation, YouTube fetches /youtubei/v1/player — we strip ad fields from
  // the response before it reaches the player.
  var _origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    return _origFetch.apply(this, args).then(function(res) {
      var url = (typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url)) || '';
      if (url.indexOf('youtubei/v1/player') !== -1) {
        return res.clone().json().then(function(json) {
          ['adPlacements','playerAds','adSlots','adBreakHeartbeatParams'].forEach(function(k) {
            delete json[k];
          });
          return new Response(JSON.stringify(json), {
            status: res.status,
            headers: res.headers
          });
        }).catch(function() { return res; });
      }
      return res;
    });
  };

  // 3. Also intercept XMLHttpRequest for older YouTube code paths
  var _origXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._tdUrl = url;
    return _origXhrOpen.apply(this, arguments);
  };
  var _origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    var origOnReady = this.onreadystatechange;
    this.onreadystatechange = function() {
      if (self.readyState === 4 && self._tdUrl &&
          self._tdUrl.indexOf('youtubei/v1/player') !== -1) {
        try {
          var json = JSON.parse(self.responseText);
          ['adPlacements','playerAds','adSlots','adBreakHeartbeatParams'].forEach(function(k) {
            delete json[k];
          });
          Object.defineProperty(self, 'responseText', {
            value: JSON.stringify(json),
            writable: false
          });
        } catch(e) {}
      }
      if (origOnReady) origOnReady.apply(self, arguments);
    };
    return _origXhrSend.apply(this, arguments);
  };
})();`;

/**
 * Register both Layer 1 (network route blocking) and Layer 2 (document-start init script)
 * in a single run-code call. This must be called BEFORE navigating to the target URL.
 *
 * The route handler uses a page.route catch-all with a Set of 30 ad domains — a single
 * registration that intercepts every request with a fast hostname check. No need for
 * 30+ separate playwright-cli route commands.
 *
 * @param {Function} cliRunFn - cliRun function from browser.act.cjs
 * @param {Function} sessionFlagsFn - sessionFlags function from browser.act.cjs
 * @param {string} sessionId - Browser session ID
 * @param {boolean} headed - Whether browser is headed
 * @returns {Promise<boolean>} - Whether interception was successfully registered
 */
async function setupInterception(cliRunFn, sessionFlagsFn, sessionId, headed) {
  if (_activeSessions.has(sessionId)) {
    logger.debug(`[ad-block-network] Interception already active for session=${sessionId}`);
    return true;
  }

  const flags = sessionFlagsFn(sessionId, headed);

  // Build the run-code function that registers both layers atomically.
  // The blocked domains array is embedded directly — no external lookups at runtime.
  const domainsArray = JSON.stringify(AD_NETWORK_DOMAINS);
  const initScriptJson = JSON.stringify(_INIT_SCRIPT);

  const runCodeFn = `async (page) => {
    // Layer 1: Single catch-all route handler with ad domains in an array.
    // Runs in the Playwright Node.js process — fast hostname check, not browser JS.
    const blocked = ${domainsArray};
    await page.context().route('**/*', (route) => {
      try {
        const h = new URL(route.request().url()).hostname;
        for (let i = 0; i < blocked.length; i++) {
          const d = blocked[i];
          if (h === d || h.endsWith('.' + d)) {
            return route.abort();
          }
        }
      } catch(e) {}
      return route.continue();
    });

    // Layer 2: Document-start init script — strips YouTube ad data before player reads it.
    await page.context().addInitScript(${initScriptJson});

    return 'ok';
  }`;

  try {
    const result = await cliRunFn(
      [...flags, 'run-code', runCodeFn],
      10000
    );

    if (result?.ok || result?.exitCode === 0) {
      _activeSessions.add(sessionId);
      logger.info(`[ad-block-network] Interception registered: route handler (30 domains) + init script (session=${sessionId})`);
      return true;
    } else {
      logger.warn(`[ad-block-network] setupInterception: run-code failed exitCode=${result?.exitCode} stderr=${(result?.stderr || '').slice(0, 200)}`);
      return false;
    }
  } catch (err) {
    logger.warn(`[ad-block-network] setupInterception error: ${err.message}`);
    return false;
  }
}

/**
 * Clear the session tracking (called when a session is closed)
 * @param {string} sessionId
 */
function clearSession(sessionId) {
  _activeSessions.delete(sessionId);
}

module.exports = {
  setupInterception,
  clearAdBlockSession: clearSession,
  clearSession,
  AD_NETWORK_DOMAINS,
};
