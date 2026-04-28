'use strict';

/**
 * skill: video.agent
 *
 * Universal video watching agent with OCR-based "viewing".
 * Works with YouTube, Vimeo, or any video page.
 * Uses screen-intelligence MCP with tesseract.js for text extraction.
 *
 * Actions:
 *   watch_video          { videoUrl, goal, options }     → watch specific video
 *   find_and_watch       { platform, query, goal }      → search and watch tutorial
 *   watch_from_page      { pageUrl, videoSelector, goal } → watch video on any page
 */

const logger = require('../logger.cjs');
const path = require('path');

// User Memory MCP configuration
const USER_MEMORY_URL = process.env.USER_MEMORY_MCP_URL || 'http://localhost:3001';

/**
 * Detect video platform from URL
 */
function detectPlatform(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const hostname = url.hostname.toLowerCase();
    
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
      return 'youtube';
    } else if (hostname.includes('vimeo.com')) {
      return 'vimeo';
    }
    return 'generic';
  } catch (e) {
    return 'generic';
  }
}

/**
 * Call user-memory MCP for recent OCR
 */
async function getRecentOcr(maxAgeSeconds = 15) {
  try {
    const response = await fetch(`${USER_MEMORY_URL}/memory.getRecentOcr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: { maxAgeSeconds },
        context: {},
        requestId: `video_${Date.now()}`
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.result || { available: false };
  } catch (err) {
    logger.warn(`[video.agent] Failed to get OCR: ${err.message}`);
    return { available: false };
  }
}

/**
 * Extract metadata from video page
 */
async function extractMetadata(videoUrl, platform, browserAct) {
  try {
    // Navigate to video
    await browserAct({ action: 'navigate', url: videoUrl });
    await new Promise(r => setTimeout(r, 2000)); // Wait for player load

    // Extract duration based on platform
    let duration = 0;
    
    if (platform === 'youtube') {
      // Try to get duration from player
      const result = await browserAct({
        action: 'run-code',
        code: `async page => {
          const player = document.querySelector('video');
          if (player) return { duration: player.duration || 0 };
          // Fallback: extract from DOM
          const timeEl = document.querySelector('.ytp-time-duration');
          if (timeEl) {
            const parts = timeEl.textContent.split(':').map(Number);
            if (parts.length === 2) return { duration: parts[0] * 60 + parts[1] };
            if (parts.length === 3) return { duration: parts[0] * 3600 + parts[1] * 60 + parts[2] };
          }
          return { duration: 0 };
        }`
      });
      duration = result?.duration || 0;
    } else {
      // Generic: try to find video element
      const result = await browserAct({
        action: 'run-code',
        code: `async page => {
          const video = document.querySelector('video');
          return { duration: video?.duration || 0 };
        }`
      });
      duration = result?.duration || 0;
    }

    return { ok: true, duration };
  } catch (err) {
    logger.error(`[video.agent] Failed to extract metadata: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Extract YouTube-specific text sources (transcript, description)
 */
async function extractYouTubeText(videoUrl, browserAct) {
  const sources = { transcript: null, description: null, comments: [] };
  
  try {
    // Try to get transcript
    await browserAct({
      action: 'run-code',
      code: `async page => {
        // Click transcript button if available
        const transcriptBtn = document.querySelector('button[aria-label*="transcript"], button[title*="transcript"]');
        if (transcriptBtn) transcriptBtn.click();
        return { clicked: !!transcriptBtn };
      }`
    });
    
    await new Promise(r => setTimeout(r, 1000));
    
    const transcriptResult = await browserAct({
      action: 'run-code',
      code: `async page => {
        const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
        if (segments.length === 0) return { transcript: null };
        
        const texts = [];
        segments.forEach(seg => {
          const text = seg.querySelector('.segment-text')?.textContent;
          const time = seg.querySelector('.segment-timestamp')?.textContent;
          if (text) texts.push({ time, text });
        });
        return { transcript: texts };
      }`
    });
    
    if (transcriptResult?.transcript) {
      sources.transcript = transcriptResult.transcript;
    }

    // Get description
    const descResult = await browserAct({
      action: 'run-code',
      code: `async page => {
        const desc = document.querySelector('#description-inline-expander, #description, [class*="description"]');
        return { description: desc?.textContent?.substring(0, 2000) || null };
      }`
    });
    
    sources.description = descResult?.description;

  } catch (err) {
    logger.warn(`[video.agent] Failed to extract YouTube text: ${err.message}`);
  }
  
  return sources;
}

/**
 * Calculate sample points based on video duration
 */
function calculateSamplePoints(durationSeconds) {
  // Tier 1: Short tutorials (3-5 min)
  if (durationSeconds <= 300) {
    const interval = Math.max(30, Math.floor(durationSeconds / 6));
    return generatePoints(durationSeconds, interval, 12);
  }
  
  // Tier 2: Medium (5-10 min)
  if (durationSeconds <= 600) {
    const interval = Math.max(60, Math.floor(durationSeconds / 8));
    return generatePoints(durationSeconds, interval, 12);
  }
  
  // Tier 3: Longer (10-20 min)
  if (durationSeconds <= 1200) {
    const interval = Math.max(90, Math.floor(durationSeconds / 12));
    return generatePoints(durationSeconds, interval, 15);
  }
  
  // Tier 4: Maximum (20-30 min)
  const interval = Math.max(120, Math.floor(durationSeconds / 15));
  return generatePoints(durationSeconds, interval, 18);
}

function generatePoints(duration, interval, maxSamples) {
  const points = [];
  let current = 0;
  while (current < duration && points.length < maxSamples - 1) {
    points.push(current);
    current += interval;
  }
  // ALWAYS include final frame
  if (points[points.length - 1] !== duration) {
    points.push(duration);
  }
  return points;
}

/**
 * Sample video with OCR
 */
async function sampleVideoWithOcr(videoUrl, samplePoints, platform, browserAct) {
  const ocrTexts = [];
  
  try {
    // Make fullscreen
    await browserAct({ action: 'press', key: 'f' });
    await new Promise(r => setTimeout(r, 1000));

    for (const seconds of samplePoints) {
      // Seek to timestamp
      if (platform === 'youtube') {
        await browserAct({
          action: 'run-code',
          code: `async page => { 
            const player = document.querySelector('video');
            if (player) player.currentTime = ${seconds};
          }`
        });
      } else {
        await browserAct({
          action: 'run-code',
          code: `async page => {
            const video = document.querySelector('video');
            if (video) video.currentTime = ${seconds};
          }`
        });
      }
      
      await new Promise(r => setTimeout(r, 1500)); // Wait for frame + UI
      
      // Trigger screen capture and get OCR
      const ocrResult = await getRecentOcr(15);
      
      if (ocrResult.available && ocrResult.capture) {
        ocrTexts.push({
          timestamp: seconds,
          text: ocrResult.capture.text,
          appName: ocrResult.capture.appName
        });
      }
    }

    // Exit fullscreen
    await browserAct({ action: 'press', key: 'Escape' });
    
  } catch (err) {
    logger.error(`[video.agent] OCR sampling failed: ${err.message}`);
  }
  
  return ocrTexts;
}

/**
 * Synthesize text sources with LLM
 */
async function synthesizeTextSources(textSources, goal, skillLlm) {
  if (!skillLlm) {
    return { confidence: 0, steps: [] };
  }

  try {
    const { ask } = skillLlm;
    
    const transcriptText = textSources.transcript 
      ? textSources.transcript.map(t => `[${t.time}] ${t.text}`).join('\n')
      : 'No transcript available';
    
    const prompt = `Analyze this video content and extract actionable steps for: "${goal}"

TRANSCRIPT:
${transcriptText}

DESCRIPTION:
${textSources.description || 'No description available'}

Extract 5-10 clear, actionable steps. Format as:
1. [Action] [Target/Detail]
2. ...

If the content doesn't provide enough information for clear steps, respond with "INSUFFICIENT".

STEPS:`;

    const response = await ask(prompt, { maxTokens: 500, temperature: 0.3 });
    
    if (response.includes('INSUFFICIENT')) {
      return { confidence: 0, steps: [] };
    }

    // Parse steps from response
    const steps = response
      .split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 10);

    return {
      confidence: steps.length >= 5 ? 0.85 : steps.length >= 3 ? 0.6 : 0.3,
      steps: steps.map((text, i) => ({ step: i + 1, text }))
    };
  } catch (err) {
    logger.warn(`[video.agent] Text synthesis failed: ${err.message}`);
    return { confidence: 0, steps: [] };
  }
}

/**
 * Combine text and OCR analysis
 */
async function combineTextAndVisual(textAnalysis, ocrSamples, goal, skillLlm) {
  if (!skillLlm || ocrSamples.length === 0) {
    return textAnalysis || { steps: [], confidence: 0 };
  }

  try {
    const { ask } = skillLlm;
    
    const ocrText = ocrSamples.map(s => `[${s.timestamp}s] ${s.text}`).join('\n');
    const textSteps = textAnalysis?.steps?.map(s => s.text).join('\n') || 'No text analysis available';

    const prompt = `Combine these video analysis sources to extract steps for: "${goal}"

FROM VIDEO TEXT (transcript/description):
${textSteps}

FROM OCR SCREENSHOTS:
${ocrText}

Synthesize into 5-10 clear, actionable steps. Format as:
1. [Action] [Target]
2. ...

STEPS:`;

    const response = await ask(prompt, { maxTokens: 600, temperature: 0.3 });

    const steps = response
      .split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 10);

    return {
      confidence: Math.min(0.9, (textAnalysis?.confidence || 0) + 0.1),
      steps: steps.map((text, i) => ({ step: i + 1, text }))
    };
  } catch (err) {
    logger.warn(`[video.agent] Combined analysis failed: ${err.message}`);
    return textAnalysis || { steps: [], confidence: 0 };
  }
}

/**
 * Main action: Watch a specific video
 */
async function actionWatchVideo({ videoUrl, goal, options = {} }, { browserAct, skillLlm } = {}) {
  const { 
    maxDuration = 1800,
    context = 'standalone',
    allowLongVideos = false
  } = options;

  const effectiveMax = context === 'agent_learning' ? 600 : maxDuration;

  if (!videoUrl) {
    return { ok: false, error: 'videoUrl is required' };
  }

  if (!browserAct) {
    return { ok: false, error: 'browserAct is required' };
  }

  const platform = detectPlatform(videoUrl);
  logger.info(`[video.agent] Watching ${platform} video: ${videoUrl}`);

  // Extract metadata
  const metadata = await extractMetadata(videoUrl, platform, browserAct);
  
  if (!metadata.ok) {
    return metadata;
  }

  // Check duration limits
  if (metadata.duration > effectiveMax) {
    if (context === 'agent_learning') {
      return { 
        ok: false, 
        error: `Video too long for learning: ${Math.round(metadata.duration/60)}min > ${Math.round(effectiveMax/60)}min limit` 
      };
    } else if (!allowLongVideos) {
      return {
        ok: false,
        warning: `Video is ${Math.round(metadata.duration/60)} minutes. This will take ~${Math.ceil(metadata.duration/120)} OCR samples.`,
        duration: metadata.duration,
        requiresConfirmation: true
      };
    }
  }

  // Extract text sources (platform-specific)
  let textSources = null;
  if (platform === 'youtube') {
    textSources = await extractYouTubeText(videoUrl, browserAct);
  }

  // Synthesize text sources
  let textAnalysis = null;
  if (textSources && skillLlm) {
    textAnalysis = await synthesizeTextSources(textSources, goal, skillLlm);
    
    if (textAnalysis.confidence > 0.8) {
      return { 
        ok: true, 
        steps: textAnalysis.steps, 
        source: 'text',
        platform,
        duration: metadata.duration
      };
    }
  }

  // OCR-based sampling
  const samplePoints = calculateSamplePoints(metadata.duration);
  logger.info(`[video.agent] Sampling ${samplePoints.length} points`);
  
  const ocrSamples = await sampleVideoWithOcr(videoUrl, samplePoints, platform, browserAct);

  // Combine analysis
  const combinedAnalysis = await combineTextAndVisual(textAnalysis, ocrSamples, goal, skillLlm);

  return { 
    ok: true, 
    steps: combinedAnalysis.steps,
    source: textSources ? 'text+ocr' : 'ocr',
    platform,
    duration: metadata.duration,
    sampleCount: ocrSamples.length
  };
}

/**
 * Search for and watch tutorial video
 */
async function actionFindAndWatchTutorial({ platform, query, goal }, dependencies = {}) {
  const { browserAct, skillLlm } = dependencies;
  
  if (!browserAct) {
    return { ok: false, error: 'browserAct is required' };
  }

  logger.info(`[video.agent] Finding ${platform} tutorial: ${query}`);

  try {
    // Navigate to platform and search
    if (platform === 'youtube') {
      await browserAct({ 
        action: 'navigate', 
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` 
      });
    } else {
      return { ok: false, error: `Unsupported platform: ${platform}` };
    }

    await new Promise(r => setTimeout(r, 2000));

    // Extract video results with durations
    const videos = await browserAct({
      action: 'run-code',
      code: `async page => {
        const results = [];
        const items = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer');
        
        for (const item of items.slice(0, 5)) {
          const link = item.querySelector('a#video-title, a[title]');
          const titleEl = item.querySelector('#video-title, .video-title');
          const durationEl = item.querySelector('.ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text');
          
          if (link && titleEl) {
            const durationText = durationEl?.textContent?.trim() || '';
            const parts = durationText.split(':').map(Number);
            let seconds = 0;
            if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
            if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
            
            // Filter: 3-10 minutes for tutorials
            if (seconds >= 180 && seconds <= 600) {
              results.push({
                title: titleEl.textContent.trim(),
                url: link.href,
                duration: seconds
              });
            }
          }
        }
        return results;
      }`
    }) || [];

    if (videos.length === 0) {
      return { ok: false, error: 'No suitable tutorials found (looking for 3-10 min videos)' };
    }

    // Watch first suitable video
    logger.info(`[video.agent] Watching: ${videos[0].title}`);
    
    return actionWatchVideo({
      videoUrl: videos[0].url,
      goal,
      options: { context: 'agent_learning', maxDuration: 600 }
    }, dependencies);

  } catch (err) {
    logger.error(`[video.agent] Find and watch failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Main export handler
module.exports = async function videoAgent(args, dependencies = {}) {
  const { action, ...params } = args || {};
  
  switch (action) {
    case 'watch_video':
      return await actionWatchVideo(params, dependencies);
    case 'find_and_watch_tutorial':
      return await actionFindAndWatchTutorial(params, dependencies);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};

// Export individual actions for direct use
module.exports.actionWatchVideo = actionWatchVideo;
module.exports.actionFindAndWatchTutorial = actionFindAndWatchTutorial;
