'use strict';

/**
 * Ad Detection and Skipping Handler
 * 
 * Detects pre-roll ads across video platforms and handles skip/wait logic.
 * Designed to work with YouTube, Vimeo, Rumble, and other video platforms.
 */

const logger = require('../logger.cjs');

// Platform-specific ad patterns
const PLATFORM_PATTERNS = {
  youtube: {
    adModules: [
      '.ytp-ad-module',
      '.ytp-ad-player-overlay',
      '.ytp-ads',
      '.ytp-ad-overlay',
      '[class*="ad-showing"]',
      '[class*="ad-overlay"]',
      '.ytp-ad-display',
      '.ytp-ad-text',
      '.ytp-skip-ad-button' // Skip button presence indicates ad
    ],
    skipButtons: [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      'button.ytp-skip-ad-button',
      '.ytp-skip-ad-button__text',
      '[class*="skip-ad" i]',
      '[class*="skip-button" i]',
      '[aria-label*="skip" i]',
      'button:has-text("Skip")',
      '.ytp-ad-skip-button-modern'
    ]
  },
  vimeo: {
    adModules: [
      '.vp-ad-unit',
      '[data-ad]',
      '.vimeo-ads'
    ],
    skipButtons: [
      '.vp-skip-button',
      '.skip-ad'
    ]
  },
  rumble: {
    adModules: [
      '[class*="rumble-ad"]',
      '.video-ad',
      '[class*="ad-overlay"]'
    ],
    skipButtons: [
      '.skip-ad',
      '.skip-button',
      '[class*="skip"]'
    ]
  }
};

// Generic ad indicators that work across platforms.
// IMPORTANT: Only multi-word / unambiguous phrases — standalone words like 'skip',
// 'seconds', 'sponsored' appear on regular YouTube pages and cause false positives.
const AD_KEYWORDS = [
  'skip ad',
  'skip advertisement',
  'your video will begin',
  'video will play after',
  'video will resume',
  'ad in',
  '1 of 2',
  '2 of 2',
  'learn more about this ad'
];

/**
 * Check if an ad is currently playing
 * @param {string} platform - Platform name (youtube, vimeo, etc.)
 * @param {Function} browserAct - Browser act function
 * @param {string} sessionId - Browser session ID
 * @returns {Promise<{isPlaying: boolean, hasSkipButton: boolean, skipSelector: string|null, duration: number}>}
 */
async function detectAd(platform, browserAct, sessionId) {
  try {
    const patterns = PLATFORM_PATTERNS[platform] || { adModules: [], skipButtons: [] };
    
    const result = await browserAct({
      action: 'evaluate',
      expression: `(() => {
        // Check for platform-specific ad modules
        const adSelectors = ${JSON.stringify(patterns.adModules)};
        let adElement = null;
        for (const sel of adSelectors) {
          try {
            adElement = document.querySelector(sel);
            if (adElement) break;
          } catch (e) {}
        }
        
        // Check for skip buttons
        const skipSelectors = ${JSON.stringify(patterns.skipButtons)};
        let skipButton = null;
        let foundSkipSelector = null;
        for (const sel of skipSelectors) {
          try {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetParent !== null) {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                skipButton = btn;
                foundSkipSelector = sel;
                break;
              }
            }
          } catch (e) {}
        }
        
        // Check video player state — look for ad-specific player class
        const player = document.querySelector('.html5-video-player, .video-player, #player');
        const playerClasses = player?.className?.toLowerCase() || '';
        const isAdClass = playerClasses.includes('ad-showing') || playerClasses.includes('ad-interrupting');
        
        // Check if controls are hidden (common during ads)
        const controlsHidden = playerClasses.includes('hide-controls') || 
                              playerClasses.includes('controls-hidden');
        
        // Text-based detection
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const foundKeywords = ${JSON.stringify(AD_KEYWORDS)}.filter(kw => bodyText.includes(kw));
        
        // Target the AD video element specifically (.ad-showing video or .ad-interrupting video)
        // YouTube plays pre-rolls in a separate video element, not the main one
        const adVideo = document.querySelector('.ad-showing video, .ad-interrupting video') ||
                        (isAdClass ? document.querySelector('video') : null);
        const mainVideo = document.querySelector('video:not([src*="blob:"])') || document.querySelector('video');
        const adVideoDuration = adVideo?.duration || 0;
        const isShortVideo = adVideoDuration > 0 && adVideoDuration < 60;
        
        return {
          hasAdModule: !!adElement,
          hasSkipButton: !!skipButton,
          skipSelector: foundSkipSelector,
          isAdClass,
          controlsHidden,
          foundKeywords,
          videoDuration: adVideoDuration,
          isShortVideo,
          playerClasses,
          hasAdVideo: !!adVideo
        };
      })()`,
      sessionId
    });
    
    if (!result.ok) {
      return { isPlaying: false, hasSkipButton: false, skipSelector: null, duration: 0 };
    }
    
    const raw = result.result;
    // result.result is now auto-parsed by browser.act evaluate handler (JSON objects
    // come back as objects, not strings). Defensive fallback for scalar returns.
    const data = (typeof raw === 'object' && raw !== null) ? raw :
                 (() => { try { return JSON.parse(String(raw)); } catch { return {}; } })();

    logger.debug(`[ad-handler] detectAd raw signals: hasAdModule=${data.hasAdModule} isAdClass=${data.isAdClass} hasAdVideo=${data.hasAdVideo} hasSkipButton=${data.hasSkipButton} keywords=${JSON.stringify(data.foundKeywords)} playerClasses="${(data.playerClasses||'').slice(0,80)}"`);

    // Determine if ad is playing based on multiple signals
    const isPlaying = data.hasAdModule || 
                      data.isAdClass || 
                      data.hasAdVideo ||
                      (data.isShortVideo && data.controlsHidden) ||
                      (data.foundKeywords && data.foundKeywords.length > 0);
    
    return {
      isPlaying,
      hasSkipButton: data.hasSkipButton,
      skipSelector: data.skipSelector,
      duration: data.videoDuration || 0,
      debug: data
    };
  } catch (err) {
    logger.warn(`[ad-handler] Detection error: ${err.message}`);
    return { isPlaying: false, hasSkipButton: false, skipSelector: null, duration: 0 };
  }
}

/**
 * Click a skip button if present
 * @param {string} selector - CSS selector for skip button
 * @param {Function} browserAct - Browser act function
 * @param {string} sessionId - Browser session ID
 * @returns {Promise<boolean>} - True if clicked successfully
 */
async function clickSkipButton(selector, browserAct, sessionId) {
  try {
    if (!selector) return false;
    
    logger.info(`[ad-handler] Clicking skip button: ${selector}`);
    
    const result = await browserAct({
      action: 'click',
      selector,
      sessionId
    });
    
    if (result.ok) {
      logger.info('[ad-handler] Skip button clicked successfully');
      // Wait a moment for ad to transition
      await sleep(1000);
      return true;
    }
    
    return false;
  } catch (err) {
    logger.warn(`[ad-handler] Skip click failed: ${err.message}`);
    return false;
  }
}

/**
 * Seek the ad video to its end (unskippable ad fallback).
 * Targets the ad-specific video element (.ad-showing video / .ad-interrupting video)
 * rather than the main video, so we don't disrupt the real content.
 * @param {Function} browserAct - Browser act function
 * @param {string} sessionId - Browser session ID
 * @returns {Promise<boolean>} - True if seek was attempted
 */
async function seekAdToEnd(browserAct, sessionId) {
  try {
    logger.info('[ad-handler] Attempting seek-to-end on ad video (unskippable ad fallback)');
    const result = await browserAct({
      action: 'evaluate',
      expression: `(() => {
        // Target the ad video specifically — not the main content video
        const adVideo = document.querySelector('.ad-showing video, .ad-interrupting video');
        const player = document.querySelector('.html5-video-player, #player');
        const playerClasses = player?.className?.toLowerCase() || '';
        const isAdShowing = playerClasses.includes('ad-showing') || playerClasses.includes('ad-interrupting');
        const vid = adVideo || (isAdShowing ? document.querySelector('video') : null);
        if (vid && vid.duration && isFinite(vid.duration) && vid.duration > 0) {
          vid.muted = true;
          vid.playbackRate = 16;
          vid.currentTime = vid.duration - 0.1;
          return { sought: true, duration: vid.duration, wasAdVideo: !!adVideo };
        }
        // Fallback: try YouTube Player API
        const moviePlayer = document.getElementById('movie_player');
        if (moviePlayer && isAdShowing) {
          if (typeof moviePlayer.seekTo === 'function' && typeof moviePlayer.getDuration === 'function') {
            moviePlayer.seekTo(moviePlayer.getDuration() - 0.1, true);
            return { sought: true, duration: moviePlayer.getDuration(), wasAdVideo: false, usedAPI: true };
          }
        }
        return { sought: false };
      })()`,
      sessionId
    });
    const sought = result?.result?.sought || false;
    if (sought) {
      logger.info(`[ad-handler] Seek-to-end: duration=${result?.result?.duration?.toFixed(1)}s adVideo=${result?.result?.wasAdVideo}`);
    } else {
      logger.warn('[ad-handler] Seek-to-end: no suitable video element found');
    }
    return sought;
  } catch (err) {
    logger.warn(`[ad-handler] seekAdToEnd error: ${err.message}`);
    return false;
  }
}

/**
 * Wait for ad to finish playing
 * @param {string} platform - Platform name
 * @param {Function} browserAct - Browser act function
 * @param {string} sessionId - Browser session ID
 * @param {number} maxWaitMs - Maximum wait time in milliseconds (default 30000)
 * @param {number} pollIntervalMs - Polling interval (default 3000)
 * @returns {Promise<boolean>} - True if ad finished, false if timeout
 */
async function waitForAdEnd(platform, browserAct, sessionId, maxWaitMs = 30000, pollIntervalMs = 3000) {
  logger.info(`[ad-handler] Waiting up to ${maxWaitMs}ms for ad to finish`);
  
  const startTime = Date.now();
  let lastStatus = null;
  
  while (Date.now() - startTime < maxWaitMs) {
    const status = await detectAd(platform, browserAct, sessionId);
    
    // Log status change
    if (JSON.stringify(status) !== JSON.stringify(lastStatus)) {
      logger.info(`[ad-handler] Ad status: playing=${status.isPlaying}, skip=${status.hasSkipButton}`);
      lastStatus = status;
    }
    
    // Try to click skip if available
    if (status.hasSkipButton && status.skipSelector) {
      const clicked = await clickSkipButton(status.skipSelector, browserAct, sessionId);
      if (clicked) {
        // Re-check after clicking
        await sleep(1000);
        const afterClick = await detectAd(platform, browserAct, sessionId);
        if (!afterClick.isPlaying) {
          logger.info('[ad-handler] Ad skipped successfully');
          return true;
        }
      }
    } else if (status.isPlaying) {
      // No skip button available — seek the ad video to its end (unskippable ad)
      const sought = await seekAdToEnd(browserAct, sessionId);
      if (sought) {
        await sleep(1500);
        const afterSeek = await detectAd(platform, browserAct, sessionId);
        if (!afterSeek.isPlaying) {
          logger.info('[ad-handler] Ad ended via seek-to-end');
          return true;
        }
      }
    }
    
    // Check if ad finished
    if (!status.isPlaying) {
      logger.info('[ad-handler] Ad finished naturally');
      return true;
    }
    
    await sleep(pollIntervalMs);
  }
  
  logger.warn('[ad-handler] Ad wait timeout reached');
  return false;
}

/**
 * Main entry point: Handle ads for a video
 * @param {string} platform - Platform name
 * @param {Function} browserAct - Browser act function
 * @param {string} sessionId - Browser session ID
 * @param {Object} options - Options
 * @returns {Promise<{success: boolean, skipped: boolean, waited: boolean, error: string|null}>}
 */
async function handleAds(platform, browserAct, sessionId, options = {}) {
  const {
    initialWaitMs = 8000,      // Wait for page render + ad load (increased from 3s)
    skipCountdownMs = 5000,    // Wait for YouTube's "Skip in 5..."
    maxAdWaitMs = 30000,       // Max wait for ad
    pollIntervalMs = 2000        // Polling frequency (more frequent)
  } = options;
  
  try {
    logger.info(`[ad-handler] Starting ad handling for ${platform}`);
    
    // Step 1: Pre-wait 3s before polling — YouTube injects its ad player after the
    // main page renders, typically 3–6s after load. Polling too early means the
    // .ad-showing / .ytp-ad-module elements don't exist yet.
    logger.info('[ad-handler] Pre-wait 3s for ad player to initialize...');
    await sleep(3000);

    // Step 2: Poll during initial wait period to catch ads that load gradually
    logger.info(`[ad-handler] Polling for ${initialWaitMs}ms during initial load`);
    const initialStart = Date.now();
    let adDetected = null;
    
    while (Date.now() - initialStart < initialWaitMs) {
      const check = await detectAd(platform, browserAct, sessionId);
      if (check.isPlaying) {
        adDetected = check;
        logger.info(`[ad-handler] Ad detected after ${Date.now() - initialStart}ms: skip=${check.hasSkipButton}`);
        break;
      }
      await sleep(pollIntervalMs);
    }
    
    if (!adDetected) {
      logger.info('[ad-handler] No ad detected during initial wait, proceeding');
      return { success: true, skipped: false, waited: false, error: null };
    }
    
    logger.info('[ad-handler] Ad detected, beginning ad handling');
    
    // Step 2: If skip button already available, try clicking immediately
    if (adDetected.hasSkipButton && adDetected.skipSelector) {
      logger.info('[ad-handler] Skip button available immediately, attempting click');
      const clicked = await clickSkipButton(adDetected.skipSelector, browserAct, sessionId);
      if (clicked) {
        await sleep(1000);
        const verifySkip = await detectAd(platform, browserAct, sessionId);
        if (!verifySkip.isPlaying) {
          logger.info('[ad-handler] Ad skipped immediately');
          return { success: true, skipped: true, waited: false, error: null };
        }
      }
    }
    
    // Step 3: Wait for skip countdown (YouTube's "Skip in 5...")
    logger.info(`[ad-handler] Waiting ${skipCountdownMs}ms for skip countdown`);
    await sleep(skipCountdownMs);
    
    // Step 4: Check for skip button again and try to click
    const afterCountdown = await detectAd(platform, browserAct, sessionId);
    if (afterCountdown.hasSkipButton && afterCountdown.skipSelector) {
      const clicked = await clickSkipButton(afterCountdown.skipSelector, browserAct, sessionId);
      if (clicked) {
        // Verify ad was actually skipped
        await sleep(1000);
        const verifySkip = await detectAd(platform, browserAct, sessionId);
        if (!verifySkip.isPlaying) {
          logger.info('[ad-handler] Ad skipped via button');
          return { success: true, skipped: true, waited: false, error: null };
        }
      }
    } else if (afterCountdown.isPlaying) {
      // No skip button after countdown — unskippable ad. Seek to end immediately.
      logger.info('[ad-handler] No skip button after countdown — seeking ad to end');
      const sought = await seekAdToEnd(browserAct, sessionId);
      if (sought) {
        await sleep(1500);
        const afterSeek = await detectAd(platform, browserAct, sessionId);
        if (!afterSeek.isPlaying) {
          logger.info('[ad-handler] Unskippable ad ended via seek-to-end');
          return { success: true, skipped: true, waited: false, error: null };
        }
      }
    }
    
    // Step 5: If still playing, wait for ad to end (final fallback)
    const waited = await waitForAdEnd(platform, browserAct, sessionId, maxAdWaitMs, pollIntervalMs);
    
    if (waited) {
      logger.info('[ad-handler] Ad handling complete - ad finished');
      return { success: true, skipped: false, waited: true, error: null };
    } else {
      logger.warn('[ad-handler] Ad handling incomplete - timeout');
      return { success: false, skipped: false, waited: false, error: 'Ad timeout' };
    }
    
  } catch (err) {
    logger.error(`[ad-handler] Error: ${err.message}`);
    return { success: false, skipped: false, waited: false, error: err.message };
  }
}

/**
 * Utility: Sleep for N milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  handleAds,
  detectAd,
  clickSkipButton,
  seekAdToEnd,
  waitForAdEnd,
  PLATFORM_PATTERNS
};
