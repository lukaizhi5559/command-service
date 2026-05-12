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
      '[class*="ad-showing"]',
      '.ytp-ad-display',
      '.ytp-ad-text'
    ],
    skipButtons: [
      '.ytp-skip-ad-button',
      '.ytp-ad-skip-button',
      'button.ytp-skip-ad-button',
      '[class*="skip-ad" i]',
      '[aria-label*="skip" i]'
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

// Generic ad indicators that work across platforms
const AD_KEYWORDS = [
  'skip ad',
  'skip advertisement', 
  'advertisement',
  'sponsored',
  'your video will begin',
  'video will play after',
  'ad in',
  'seconds'
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
      code: `(() => {
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
        
        // Check video player state
        const video = document.querySelector('video');
        const player = document.querySelector('.html5-video-player, .video-player, #player');
        
        // Ad indicators from player classes
        const playerClasses = player?.className?.toLowerCase() || '';
        const isAdClass = playerClasses.includes('ad-') || playerClasses.includes('ads');
        
        // Check if controls are hidden (common during ads)
        const controlsHidden = playerClasses.includes('hide-controls') || 
                              playerClasses.includes('controls-hidden');
        
        // Text-based detection
        const bodyText = document.body?.innerText?.toLowerCase() || '';
        const foundKeywords = ${JSON.stringify(AD_KEYWORDS)}.filter(kw => bodyText.includes(kw));
        
        // Check for short video duration (ads are typically < 60s)
        const videoDuration = video?.duration || 0;
        const isShortVideo = videoDuration > 0 && videoDuration < 60;
        
        return {
          hasAdModule: !!adElement,
          hasSkipButton: !!skipButton,
          skipSelector: foundSkipSelector,
          isAdClass,
          controlsHidden,
          foundKeywords,
          videoDuration,
          isShortVideo,
          playerClasses
        };
      })()`,
      sessionId
    });
    
    if (!result.ok) {
      return { isPlaying: false, hasSkipButton: false, skipSelector: null, duration: 0 };
    }
    
    const data = result.result || {};
    
    // Determine if ad is playing based on multiple signals
    const isPlaying = data.hasAdModule || 
                      data.isAdClass || 
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
    initialWaitMs = 3000,      // Wait for page render
    skipCountdownMs = 5000,    // Wait for YouTube's "Skip in 5..."
    maxAdWaitMs = 30000,       // Max wait for ad
    pollIntervalMs = 3000      // Polling frequency
  } = options;
  
  try {
    logger.info(`[ad-handler] Starting ad handling for ${platform}`);
    
    // Step 1: Initial wait for page to render
    logger.info(`[ad-handler] Waiting ${initialWaitMs}ms for initial render`);
    await sleep(initialWaitMs);
    
    // Quick check if there's an ad immediately
    const initialCheck = await detectAd(platform, browserAct, sessionId);
    if (!initialCheck.isPlaying) {
      logger.info('[ad-handler] No ad detected, proceeding');
      return { success: true, skipped: false, waited: false, error: null };
    }
    
    logger.info('[ad-handler] Ad detected, beginning ad handling');
    
    // Step 2: Wait for skip countdown (YouTube's "Skip in 5...")
    logger.info(`[ad-handler] Waiting ${skipCountdownMs}ms for skip countdown`);
    await sleep(skipCountdownMs);
    
    // Step 3: Check for skip button and try to click
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
    }
    
    // Step 4: If still playing, wait for ad to end
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
  waitForAdEnd,
  PLATFORM_PATTERNS
};
