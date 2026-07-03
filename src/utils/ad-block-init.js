'use strict';

/**
 * ad-block-init.js — Browser-context ad-blocking script builder
 *
 * Exports buildAdBlockScript(domains) which returns an IIFE string to be
 * injected into live pages via playwright-cli `evaluate`. The script runs
 * entirely in the browser page context (no Node.js APIs).
 *
 * Strategy:
 *   Part A — CSS cosmetic hiding (YouTube + generic ad selectors)
 *   Part B — Domain-based iframe/script removal (MutationObserver for dynamic ads)
 *   Part C — Idempotency guard (window.__tdAdBlockActive)
 *
 * NOTE: YouTube video ad skipping (DOM polling, seek, skip-button click) has been
 * removed. Ads are now blocked at the network/player-data level by ad-block-network.cjs:
 *   Layer 1 — Network route blocking (ad network requests aborted)
 *   Layer 2 — Document-start init script (strips adPlacements/playerAds/adSlots from
 *             ytInitialPlayerResponse before YouTube's player reads it)
 * This IIFE is now Layer 3 — purely cosmetic (hides sidebar/banner ad containers).
 */

/**
 * Build the IIFE string to inject into a browser page.
 * @param {string[]} blockedDomains  — hostname list from ad-block-updater
 * @returns {string}  — self-contained JS IIFE, safe to pass to playwright-cli eval
 */
function buildAdBlockScript(blockedDomains) {
  const domainsJson = JSON.stringify(blockedDomains || []);

  return `(function() {
  if (window.__tdAdBlockActive) return;
  window.__tdAdBlockActive = true;

  /* ── Part A: CSS cosmetic hiding ─────────────────────────────── */
  var _tdStyle = document.getElementById('td-adblock-style');
  if (!_tdStyle) {
    _tdStyle = document.createElement('style');
    _tdStyle.id = 'td-adblock-style';
    _tdStyle.textContent = [
      /* YouTube in-player ad overlays */
      '.ytp-ad-overlay-container',
      '.ytp-ad-text-overlay',
      '.ytp-ad-overlay-slot',
      '.ytp-ad-overlay-image',
      '.ytp-ad-player-overlay',
      '.ytp-ad-player-overlay-instream-info',
      '#player-ads',
      '.video-ads',
      /* YouTube sidebar / feed ads */
      'ytd-promoted-video-renderer',
      'ytd-display-ad-renderer',
      'ytd-banner-promo-renderer',
      'ytd-promoted-sparkles-text-search-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-masthead-ad-v4-renderer',
      'ytd-action-companion-ad-renderer',
      'ytd-player-legacy-desktop-watch-ads-renderer',
      '#masthead-ad',
      /* YouTube cards overlay */
      '.ytp-ce-element',
      /* Generic ad networks */
      '.adsbygoogle',
      'ins.adsbygoogle',
      '[id^="google_ads_iframe"]',
      '[id^="google_ads_"]',
      '[id*="div-gpt-ad"]',
      '[class*="ad-slot"]',
      '[class*="banner-ad"]',
      '[class*="ad-banner"]',
      '[class*="ad-container"]',
      '[class*="ad-wrapper"]',
      '.popup-ad',
      '.overlay-ad',
      '.dfp-ad',
      '[data-ad-slot]',
      '[data-google-av-cxn]',
      /* Ad iframes by src pattern */
      'iframe[src*="doubleclick.net"]',
      'iframe[src*="googlesyndication.com"]',
      'iframe[src*="adnxs.com"]',
      'iframe[src*="taboola.com"]',
      'iframe[src*="outbrain.com"]',
      'iframe[src*="amazon-adsystem.com"]',
      'iframe[src*="moatads.com"]',
      'iframe[src*="criteo.com"]',
      'iframe[src*="pubmatic.com"]',
      'iframe[src*="rubiconproject.com"]',
    ].join(',\n') + ' { display: none !important; visibility: hidden !important; height: 0 !important; }';
    (document.head || document.documentElement).appendChild(_tdStyle);
  }

  /* ── Part E helpers: domain check ───────────────────────────── */
  var _tdBlocked = ${domainsJson};
  function _tdIsBadSrc(src) {
    if (!src) return false;
    for (var i = 0; i < _tdBlocked.length; i++) {
      if (src.indexOf(_tdBlocked[i]) !== -1) return true;
    }
    return false;
  }

  /* Remove ad iframes already in DOM */
  function _tdNukeExistingAds() {
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      if (_tdIsBadSrc(iframes[i].src)) iframes[i].remove();
    }
  }
  _tdNukeExistingAds();

  /* ── Part B: MutationObserver — catch dynamically injected ad iframes ── */
  var _tdObserver = new MutationObserver(function(mutations) {
    for (var m = 0; m < mutations.length; m++) {
      var nodes = mutations[m].addedNodes;
      for (var n = 0; n < nodes.length; n++) {
        var node = nodes[n];
        if (!node || node.nodeType !== 1) continue;
        /* Remove ad iframes injected after load */
        if (node.tagName === 'IFRAME' && _tdIsBadSrc(node.src)) {
          node.remove();
          continue;
        }
        /* Check children for iframes */
        if (node.querySelectorAll) {
          var childIframes = node.querySelectorAll('iframe');
          for (var ci = 0; ci < childIframes.length; ci++) {
            if (_tdIsBadSrc(childIframes[ci].src)) childIframes[ci].remove();
          }
        }
      }
    }
  });

  if (document.body) {
    _tdObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      _tdObserver.observe(document.body, { childList: true, subtree: true });
    });
  }
})();`;
}

module.exports = { buildAdBlockScript };
