'use strict';

/**
 * skill: video.agent
 *
 * Universal video watching agent with HYBRID intelligence:
 * 1. CLI transcription (fast, reliable, uses transcribe-anything if available)
 * 2. Targeted OCR sampling (captures visual context at key moments)
 * 3. Combined synthesis for complete understanding
 *
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
const adHandler = require('./ad-handler.cjs');

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
    } else if (hostname.includes('rumble.com')) {
      return 'rumble';
    } else if (hostname.includes('facebook.com') || hostname.includes('fb.watch')) {
      return 'facebook';
    } else if (hostname.includes('tiktok.com')) {
      return 'tiktok';
    }
    return 'generic';
  } catch (e) {
    return 'generic';
  }
}

/**
 * Validate a YouTube video ID — must be exactly 11 alphanumeric/dash/underscore chars.
 * Returns the video ID string if valid, null otherwise.
 */
function extractYouTubeVideoId(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const v = url.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    // Also handle youtu.be/ID short URLs
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      if (/^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Check if a YouTube URL is a valid watchable video page (not a channel/search/home).
 */
function isValidYouTubeVideoUrl(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const host = url.hostname.toLowerCase();
    if (!host.includes('youtube.com') && host !== 'youtu.be') return true; // non-YT: pass through
    return extractYouTubeVideoId(videoUrl) !== null;
  } catch (e) {
    return false;
  }
}

/**
 * Decode a fake watch?v= URL back into a usable search query.
 * e.g. "https://youtube.com/watch?v=Bake+the+Perfect+Sourdough" → "Bake the Perfect Sourdough"
 */
function decodeInvalidVideoUrl(videoUrl) {
  try {
    const url = new URL(videoUrl);
    const v = url.searchParams.get('v');
    if (v) {
      // URL-encoded title like "Bake+the+Perfect..."
      return decodeURIComponent(v.replace(/\+/g, ' ')).trim();
    }
    // Channel URL: extract last path segment as hint
    const pathParts = url.pathname.split('/').filter(Boolean);
    return pathParts.join(' ');
  } catch (e) {
    return '';
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
      const err = new Error(`HTTP ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    return data.result || { available: false };
  } catch (err) {
    logger.warn(`[video.agent] Failed to get OCR: ${err.message}`);
    return { available: false, statusCode: err.statusCode || 0 };
  }
}

/**
 * Extract metadata from video page
 */
async function extractMetadata(videoUrl, platform, browserAct, sessionId = 'default') {
  try {
    // Navigate to video
    await browserAct({ action: 'navigate', url: videoUrl });
    await new Promise(r => setTimeout(r, 2000)); // Wait for player load

    // Handle pre-roll ads
    logger.info('[video.agent] Checking for pre-roll ads...');
    const adResult = await adHandler.handleAds(platform, browserAct, sessionId, {
      initialWaitMs: 3000,
      skipCountdownMs: 5000,
      maxAdWaitMs: 30000
    });
    
    if (adResult.success) {
      if (adResult.skipped) {
        logger.info('[video.agent] Ad was skipped');
      } else if (adResult.waited) {
        logger.info('[video.agent] Ad finished after waiting');
      } else {
        logger.info('[video.agent] No ad detected');
      }
    } else {
      logger.warn(`[video.agent] Ad handling issue: ${adResult.error}`);
    }

    // Extract duration based on platform
    let duration = 0;

    if (platform === 'youtube') {
      // Try to get duration from YouTube's movie_player or video element
      const durationResult = await browserAct({
        action: 'evaluate',
        expression: `
          (() => {
            const player = document.getElementById('movie_player');
            if (player && player.getDuration) return player.getDuration();
            const video = document.querySelector('video');
            return video ? video.duration : 0;
          })()
        `
      });
      duration = durationResult?.result || parseFloat(durationResult?.stdout || 0) || 0;
    } else {
      // Generic: try to find video element
      const durationResult = await browserAct({
        action: 'evaluate',
        expression: `document.querySelector('video')?.duration || 0`
      });
      duration = durationResult?.result || parseFloat(durationResult?.stdout || 0) || 0;
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
    // Try to get transcript - use evaluate to check and click transcript button
    const hasTranscriptBtn = await browserAct({
      action: 'evaluate',
      expression: `!!document.querySelector('button[aria-label*="transcript"], button[title*="transcript"]')`
    });
    
    if (hasTranscriptBtn?.result) {
      await browserAct({
        action: 'click',
        selector: 'button[aria-label*="transcript"], button[title*="transcript"]'
      });
      await new Promise(r => setTimeout(r, 1000));
    }
    
    // Extract transcript segments using evaluate
    const transcriptResult = await browserAct({
      action: 'evaluate',
      expression: `
        (() => {
          const segments = document.querySelectorAll('ytd-transcript-segment-renderer');
          if (segments.length === 0) return null;
          
          const texts = [];
          segments.forEach(seg => {
            const text = seg.querySelector('.segment-text')?.textContent;
            const time = seg.querySelector('.segment-timestamp')?.textContent;
            if (text) texts.push({ time, text });
          });
          return texts;
        })()
      `
    });
    
    if (transcriptResult?.result) {
      sources.transcript = transcriptResult.result;
    }

    // Get description using evaluate
    const descResult = await browserAct({
      action: 'evaluate',
      expression: `
        document.querySelector('#description-inline-expander, #description, [class*="description"]')?.textContent?.substring(0, 2000) || null
      `
    });
    
    sources.description = descResult?.result || descResult?.stdout;

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

    let ocrAvailable = true; // Track if OCR service is reachable

    for (const seconds of samplePoints) {
      if (!ocrAvailable) break; // Bail if service is down

      // Seek to timestamp
      await browserAct({
        action: 'evaluate',
        expression: `
          (() => {
            const video = document.querySelector('video');
            if (video) video.currentTime = ${seconds};
            return true;
          })()
        `
      });
      
      await new Promise(r => setTimeout(r, 1500)); // Wait for frame + UI
      
      // Trigger screen capture and get OCR
      const ocrResult = await getRecentOcr(15);

      // If OCR service returned 401/403, bail immediately — don't waste time retrying
      if (ocrResult.statusCode === 401 || ocrResult.statusCode === 403) {
        logger.warn(`[video.agent] OCR service returned ${ocrResult.statusCode} — skipping remaining samples`);
        ocrAvailable = false;
        break;
      }
      
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
    
    let transcriptText = 'No transcript available';
    if (textSources.transcript) {
      if (Array.isArray(textSources.transcript)) {
        transcriptText = textSources.transcript.map(t => `[${t.time || ''}] ${t.text || t}`).join('\n');
      } else if (typeof textSources.transcript === 'string') {
        transcriptText = textSources.transcript;
      }
    }
    
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
 * Analyze OCR samples to extract actionable steps
 */
async function analyzeOcrSamples(ocrSamples, goal, skillLlm) {
  if (!skillLlm || ocrSamples.length === 0) {
    return { steps: [], confidence: 0 };
  }

  try {
    const { ask } = skillLlm;
    
    const ocrText = ocrSamples.map(s => `[${s.timestamp}s] ${s.text}`).join('\n');

    const prompt = `Analyze these video frame captures (OCR text) and extract actionable steps for: "${goal}"

CAPTURED FRAMES (timestamp + visible text):
${ocrText}

Extract 5-10 clear, actionable steps based on what the video shows. If the OCR text is insufficient or unclear, respond with "INSUFFICIENT" and explain why.

Format as:
1. [Action] [Target]
2. ...

STEPS:`;

    const response = await ask(prompt, { maxTokens: 600, temperature: 0.3 });

    if (response.includes('INSUFFICIENT')) {
      return { confidence: 0, steps: [] };
    }

    const steps = response
      .split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 10);

    return {
      confidence: Math.min(0.85, 0.5 + (steps.length * 0.05)),
      steps: steps.map((text, i) => ({ step: i + 1, text }))
    };
  } catch (err) {
    logger.warn(`[video.agent] OCR analysis failed: ${err.message}`);
    return { steps: [], confidence: 0 };
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
 * Transcribe video using CLI tool (e.g., transcribe-anything)
 * Fast path: gets full transcript in ~10 seconds
 */
async function transcribeWithCli(videoUrl, cliAgent, skillLlm) {
  if (!cliAgent) {
    return { ok: false, error: 'cliAgent not available' };
  }

  try {
    // Check if video-transcription CLI agent exists
    const queryResult = await cliAgent({
      action: 'query_agent',
      service: 'video-transcription'
    });

    if (!queryResult.ok || !queryResult.agent) {
      logger.info('[video.agent] No video-transcription CLI agent found');
      return { ok: false, error: 'No transcription CLI agent found' };
    }

    const agentId = queryResult.agent.id;
    logger.info(`[video.agent] Using CLI agent ${agentId} for transcription`);

    // Run transcription
    const runResult = await cliAgent({
      action: 'run',
      agentId: agentId,
      task: `transcribe ${videoUrl} to text`
    });

    if (!runResult.ok) {
      logger.warn(`[video.agent] CLI transcription failed: ${runResult.error}`);
      return { ok: false, error: runResult.error };
    }

    // Extract transcript from stdout
    const transcript = runResult.stdout || '';
    if (!transcript || transcript.length < 50) {
      return { ok: false, error: 'Transcript too short or empty' };
    }

    logger.info(`[video.agent] CLI transcription successful: ${transcript.length} chars`);
    return { ok: true, transcript, source: 'cli' };

  } catch (err) {
    logger.warn(`[video.agent] CLI transcription error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Extract key visual moments from transcript that would benefit from OCR
 */
async function extractKeyMoments(transcript, goal, skillLlm) {
  if (!skillLlm || !transcript) {
    return { moments: [] };
  }

  try {
    const { ask } = skillLlm;

    const prompt = `From this video transcript, identify 3-4 key moments where visual context would help understand: "${goal}"

Transcript:
${transcript.substring(0, 3000)}

For each moment:
1. Identify the timestamp (estimate based on content flow, format as MM:SS)
2. Describe what visual information would be helpful
3. Explain why this moment matters

Return ONLY a JSON array like:
[
  { "timestamp": "02:30", "reason": "Shows the dough consistency after folding" },
  { "timestamp": "05:45", "reason": "Demonstrates the scoring technique" }
]`;

    const response = await ask(prompt, { maxTokens: 400, temperature: 0.3 });

    // Parse JSON array from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const moments = JSON.parse(jsonMatch[0]);
      logger.info(`[video.agent] Extracted ${moments.length} key moments from transcript`);
      return { moments: moments.slice(0, 4) }; // Max 4 moments
    }

    return { moments: [] };
  } catch (err) {
    logger.warn(`[video.agent] Failed to extract key moments: ${err.message}`);
    return { moments: [] };
  }
}

/**
 * Sample specific timestamps with OCR (targeted, not random)
 */
async function sampleTimestamps(videoUrl, moments, platform, browserAct) {
  if (!moments || moments.length === 0 || !browserAct) {
    return [];
  }

  const ocrSamples = [];

  try {
    // Navigate to video
    await browserAct({ action: 'navigate', url: videoUrl });
    await new Promise(r => setTimeout(r, 2000));

    // Make fullscreen for better OCR
    await browserAct({ action: 'press', key: 'f' });
    await new Promise(r => setTimeout(r, 1000));

    for (const moment of moments) {
      try {
        const timestamp = moment.timestamp; // Format: MM:SS or HH:MM:SS
        const seconds = timestampToSeconds(timestamp);

        if (seconds === null) continue;

        // Seek to timestamp
        await browserAct({
          action: 'evaluate',
          expression: `
            (() => {
              const video = document.querySelector('video');
              if (video) {
                video.currentTime = ${seconds};
                video.pause();
                return true;
              }
              return false;
            })()
          `
        });

        await new Promise(r => setTimeout(r, 1500)); // Wait for frame

        // Trigger screen capture and get OCR
        const ocrResult = await getRecentOcr(15);

        if (ocrResult.available && ocrResult.capture) {
          ocrSamples.push({
            timestamp: timestamp,
            seconds: seconds,
            text: ocrResult.capture.text,
            reason: moment.reason,
            appName: ocrResult.capture.appName
          });
        }
      } catch (err) {
        logger.warn(`[video.agent] Failed to sample timestamp ${moment.timestamp}: ${err.message}`);
      }
    }

    // Exit fullscreen
    await browserAct({ action: 'press', key: 'Escape' });

    logger.info(`[video.agent] Targeted OCR captured ${ocrSamples.length}/${moments.length} moments`);
    return ocrSamples;

  } catch (err) {
    logger.error(`[video.agent] Timestamp sampling failed: ${err.message}`);
    return [];
  }
}

/**
 * Helper: Convert MM:SS or HH:MM:SS to seconds
 */
function timestampToSeconds(timestamp) {
  if (!timestamp) return null;

  const parts = timestamp.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return null;
}

/**
 * Combine CLI transcript with targeted OCR samples
 */
async function combineTranscriptAndVisuals(transcript, ocrSamples, goal, skillLlm) {
  if (!skillLlm) {
    return { confidence: 0, steps: [] };
  }

  try {
    const { ask } = skillLlm;

    const ocrText = ocrSamples.map(s =>
      `[${s.timestamp}] (Visual: ${s.reason})\n${s.text}`
    ).join('\n\n');

    const prompt = `Synthesize this video content into clear actionable steps for: "${goal}"

=== AUDIO TRANSCRIPT (What they said) ===
${transcript.substring(0, 4000)}

=== VISUAL CONTEXT (What was shown) ===
${ocrText || 'No visual samples captured'}

Extract 5-10 clear, actionable steps. For each step that has visual context, include a brief visual description.

Format as:
1. [Action] [Detail] [Visual context if available]
2. ...

STEPS:`;

    const response = await ask(prompt, { maxTokens: 800, temperature: 0.3 });

    // Parse steps
    const steps = response
      .split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 10);

    const confidence = Math.min(0.95, 0.7 + (steps.length * 0.02) + (ocrSamples.length * 0.05));

    return {
      confidence,
      steps: steps.map((text, i) => ({ step: i + 1, text })),
      hasVisualContext: ocrSamples.length > 0
    };

  } catch (err) {
    logger.warn(`[video.agent] Combined synthesis failed: ${err.message}`);
    return { confidence: 0, steps: [], hasVisualContext: false };
  }
}

/**
 * Main action: Watch a specific video with hybrid CLI+OCR approach
 */
async function actionWatchVideo({ videoUrl, goal, options = {} }, dependencies = {}) {
  const { browserAct, skillLlm, cliAgent } = dependencies;
  const { 
    maxDuration = 1800,
    context = 'standalone',
    allowLongVideos = false,
    sessionId = 'default'
  } = options;

  const effectiveMax = context === 'agent_learning' ? 600 : maxDuration;

  if (!videoUrl) {
    return { ok: false, error: 'videoUrl is required' };
  }

  if (!browserAct) {
    return { ok: false, error: 'browserAct is required' };
  }

  // ── URL validation: catch fake/malformed YouTube URLs before wasting time ──
  const platform = detectPlatform(videoUrl);
  if (platform === 'youtube' && !isValidYouTubeVideoUrl(videoUrl)) {
    const searchQuery = decodeInvalidVideoUrl(videoUrl);
    logger.warn(`[video.agent] Invalid YouTube URL detected: ${videoUrl}`);
    if (searchQuery) {
      logger.info(`[video.agent] Redirecting to find_and_watch_tutorial with query: "${searchQuery}"`);
      return actionFindAndWatchTutorial(
        { platform: 'youtube', query: searchQuery, goal },
        dependencies
      );
    }
    return { ok: false, error: `Invalid YouTube video URL: ${videoUrl}. Provide a URL with a valid 11-character video ID.` };
  }
  logger.info(`[video.agent] Watching ${platform} video: ${videoUrl}`);

  // Extract metadata (with ad handling)
  const metadata = await extractMetadata(videoUrl, platform, browserAct, sessionId);
  
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
        warning: `Video is ${Math.round(metadata.duration/60)} minutes.`,
        duration: metadata.duration,
        requiresConfirmation: true
      };
    }
  }

  // ===================================================================
  // HYBRID APPROACH: CLI transcription first, then targeted OCR
  // ===================================================================

  // STEP 1: Try CLI transcription (fastest, most reliable)
  logger.info('[video.agent] Attempting CLI transcription first');
  let cliResult = null;
  
  if (cliAgent) {
    cliResult = await transcribeWithCli(videoUrl, cliAgent, skillLlm);
  } else {
    logger.info('[video.agent] cliAgent not provided, skipping CLI transcription');
  }

  if (cliResult?.ok) {
    logger.info(`[video.agent] CLI transcription successful: ${cliResult.transcript.length} chars`);

    // STEP 2: Extract key moments from transcript for targeted OCR
    const keyMoments = await extractKeyMoments(cliResult.transcript, goal, skillLlm);
    
    // STEP 3: Do targeted OCR at those moments
    let ocrSamples = [];
    if (keyMoments.moments.length > 0) {
      logger.info(`[video.agent] Targeted OCR at ${keyMoments.moments.length} key moments`);
      ocrSamples = await sampleTimestamps(videoUrl, keyMoments.moments, platform, browserAct);
    }

    // STEP 4: Combine transcript + visuals
    const combinedResult = await combineTranscriptAndVisuals(
      cliResult.transcript, 
      ocrSamples, 
      goal, 
      skillLlm
    );

    if (combinedResult.confidence > 0.6) {
      const cliSteps = combinedResult.steps || [];
      const cliStepsText = cliSteps.map((s, i) => `${i + 1}. ${s.text || s}`).join('\n');
      return { 
        ok: true, 
        steps: cliSteps,
        stdout: cliStepsText || `Watched video: ${videoUrl}`,
        source: ocrSamples.length > 0 ? 'cli+targeted_ocr' : 'cli_transcript',
        platform,
        duration: metadata.duration,
        visualSamples: ocrSamples.length,
        confidence: combinedResult.confidence
      };
    }
  }

  // ===================================================================
  // FALLBACK: Traditional OCR-based approach if CLI fails
  // ===================================================================
  logger.info('[video.agent] CLI approach insufficient, falling back to traditional OCR');

  const samplePoints = calculateSamplePoints(metadata.duration);
  logger.info(`[video.agent] Sampling ${samplePoints.length} points with OCR`);
  
  let ocrSamples = [];
  try {
    ocrSamples = await sampleVideoWithOcr(videoUrl, samplePoints, platform, browserAct);
    logger.info(`[video.agent] OCR captured ${ocrSamples.length} samples`);
  } catch (err) {
    logger.warn(`[video.agent] OCR sampling failed: ${err.message}`);
  }

  // If OCR captured substantial content, use it immediately
  if (ocrSamples.length > 0 && skillLlm) {
    const ocrAnalysis = await analyzeOcrSamples(ocrSamples, goal, skillLlm);
    
    if (ocrAnalysis.confidence > 0.6) {
      const ocrSteps = ocrAnalysis.steps || [];
      const ocrStepsText = ocrSteps.map((s, i) => `${i + 1}. ${s.text || s}`).join('\n');
      return { 
        ok: true, 
        steps: ocrSteps,
        stdout: ocrStepsText || `Watched video: ${videoUrl}`,
        source: 'ocr',
        platform,
        duration: metadata.duration,
        sampleCount: ocrSamples.length
      };
    }
  }

  // STEP 2: Fall back to transcript/text extraction if OCR insufficient
  logger.info(`[video.agent] OCR insufficient, falling back to text extraction`);
  
  let textSources = null;
  if (platform === 'youtube') {
    textSources = await extractYouTubeText(videoUrl, browserAct);
  }

  // Synthesize text sources
  let textAnalysis = null;
  if (textSources && skillLlm) {
    textAnalysis = await synthesizeTextSources(textSources, goal, skillLlm);
    
    if (textAnalysis.confidence > 0.8) {
      const txtSteps = textAnalysis.steps || [];
      const txtStepsText = txtSteps.map((s, i) => `${i + 1}. ${s.text || s}`).join('\n');
      return { 
        ok: true, 
        steps: txtSteps,
        stdout: txtStepsText || `Watched video: ${videoUrl}`,
        source: 'text',
        platform,
        duration: metadata.duration
      };
    }
  }

  // STEP 3: Combine both sources if both available
  const combinedAnalysis = await combineTextAndVisual(textAnalysis, ocrSamples, goal, skillLlm);

  const finalSteps = combinedAnalysis.steps || [];
  const stepsText = finalSteps.map((s, i) => `${i + 1}. ${s.text || s}`).join('\n');

  return { 
    ok: true, 
    steps: finalSteps,
    stdout: stepsText || `Watched video: ${videoUrl}`,
    source: textSources ? 'text+ocr' : 'ocr',
    platform,
    duration: metadata.duration,
    sampleCount: ocrSamples.length
  };
}

// Platform search URL builders — generic so any video platform can be supported.
// Each entry: { searchUrl(query), videoSelectors, durationSelectors }
const PLATFORM_CONFIG = {
  youtube: {
    searchUrl: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
    videoSelectors: 'ytd-video-renderer, ytd-grid-video-renderer',
    titleSelector: '#video-title, .video-title',
    linkSelector: 'a#video-title, a[title]',
    durationSelector: '.ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text',
  },
  vimeo: {
    searchUrl: (q) => `https://vimeo.com/search?q=${encodeURIComponent(q)}`,
    videoSelectors: '.iris_row, [data-test-id="clip-card"]',
    titleSelector: '.clip_info-wrapper a, [data-test-id="clip-name"]',
    linkSelector: 'a[href*="/"]',
    durationSelector: '.duration, [data-test-id="duration"]',
  },
  rumble: {
    searchUrl: (q) => `https://rumble.com/search/video?q=${encodeURIComponent(q)}`,
    videoSelectors: '.video-item, article.video',
    titleSelector: '.video-item--title, h3',
    linkSelector: 'a[href*="/v"]',
    durationSelector: '.video-item--duration, .duration',
  },
  facebook: {
    searchUrl: (q) => `https://www.facebook.com/search/videos/?q=${encodeURIComponent(q)}`,
    videoSelectors: '[data-pagelet*="SearchResult"]',
    titleSelector: 'span[dir="auto"]',
    linkSelector: 'a[href*="/videos/"]',
    durationSelector: '[aria-label*="minute"], [aria-label*="second"]',
  },
  tiktok: {
    searchUrl: (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q)}`,
    videoSelectors: '[data-e2e="search_top-item"], .tiktok-x6y88p-DivItemContainerV2',
    titleSelector: '[data-e2e="search-card-desc"], .tiktok-j2a19r-SpanText',
    linkSelector: 'a[href*="/@"]',
    durationSelector: '[data-e2e="video-duration"], .video-duration',
  },
};

// Web search MCP config (same env vars as web.agent.cjs)
const _WS_API_URL = process.env.MCP_WEB_SEARCH_API_URL;
const _WS_API_KEY = process.env.MCP_WEB_SEARCH_API_KEY;

/**
 * Normalize a raw query string before using it in a search:
 * - Strip possessive apostrophes (Natasha's → Natasha)
 * - Collapse double-spaces
 */
function _normalizeQuery(q) {
  return (q || '')
    .replace(/\u2019s|\u0027s/g, '') // smart + straight apostrophe-s
    .replace(/'/g, '')               // any remaining apostrophes
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Compute word-overlap score (0–1) between two strings.
 * Used to measure how well a search result title matches the user query.
 */
function _wordOverlap(a, b) {
  const words = (s) => new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let hits = 0;
  for (const w of wa) { if (wb.has(w)) hits++; }
  return hits / Math.max(wa.size, wb.size);
}

/**
 * Score a web search result as a direct video URL candidate.
 * Returns a confidence value 0.0–1.0.
 *
 * Signals (additive):
 *   +0.40  URL contains a valid platform video ID (watch?v=, /video/, /v/ etc.)
 *   +0.30  Title word overlap with rawQuery ≥ 60%
 *   +0.15  Title word overlap 30–60%
 *   +0.10  Snippet mentions at least 2 query keywords
 *   +0.05  Result domain matches the expected platform domain
 */
function _scoreVideoResult(result, rawQuery, platformDomain) {
  let score = 0;
  const url = result.url || '';
  const title = result.title || '';
  const snippet = result.snippet || '';

  // +0.40 — valid video URL
  if (/youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}/.test(url) ||
      /youtu\.be\/[a-zA-Z0-9_-]{11}/.test(url) ||
      /vimeo\.com\/\d{6,}/.test(url) ||
      /rumble\.com\/v[a-z0-9]/.test(url) ||
      /tiktok\.com\/@[^/]+\/video\/\d+/.test(url)) {
    score += 0.40;
  }

  // +0.30 / +0.15 — title similarity
  const overlap = _wordOverlap(rawQuery, title);
  if (overlap >= 0.6) score += 0.30;
  else if (overlap >= 0.3) score += 0.15;

  // +0.10 — snippet keyword coverage
  const queryWords = rawQuery.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const snippetLower = snippet.toLowerCase();
  const snippetHits = queryWords.filter(w => snippetLower.includes(w)).length;
  if (snippetHits >= 2) score += 0.10;

  // +0.05 — domain match
  if (platformDomain && url.includes(platformDomain)) score += 0.05;

  return Math.min(score, 1.0);
}

/**
 * Use web search MCP to find a direct video URL for the given query and platform.
 *
 * Returns { resolved: true, url, title, score } when a high-confidence match is found,
 * or { resolved: false, cleanQuery } when web search is unavailable / no confident match —
 * caller should fall back to platform search page with cleanQuery.
 *
 * CONFIDENCE_THRESHOLD = 0.50 — must have valid video URL + reasonable title match.
 */
const _VIDEO_RESOLVE_CONFIDENCE = 0.50;

const PLATFORM_DOMAIN = {
  youtube: 'youtube.com',
  vimeo:   'vimeo.com',
  rumble:  'rumble.com',
  tiktok:  'tiktok.com',
  facebook:'facebook.com',
};

async function _resolveVideoUrl(rawQuery, platformKey) {
  const cleanQuery = _normalizeQuery(rawQuery);
  const platformDomain = PLATFORM_DOMAIN[platformKey] || '';

  if (!_WS_API_URL) {
    logger.info(`[video.agent] _resolveVideoUrl: web search not configured — using platform search page with cleaned query`);
    return { resolved: false, cleanQuery };
  }

  const siteQuery = platformDomain
    ? `${cleanQuery} site:${platformDomain}`
    : cleanQuery;

  logger.info(`[video.agent] _resolveVideoUrl: searching web for "${siteQuery}"`);

  try {
    let wsHostname, wsPort;
    try {
      const _u = new URL(_WS_API_URL);
      wsHostname = _u.hostname;
      wsPort = parseInt(_u.port) || 3002;
    } catch (_) {
      return { resolved: false, cleanQuery };
    }

    const http = require('http');
    const results = await new Promise((resolve) => {
      const body = JSON.stringify({
        version: 'mcp.v1',
        service: 'web-search',
        requestId: `va_resolve_${Date.now()}`,
        action: 'search',
        payload: { query: siteQuery, maxResults: 8 },
      });
      const req = http.request({
        hostname: wsHostname,
        port: wsPort,
        path: '/web.search',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${_WS_API_KEY || ''}`,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.data?.results || parsed?.results || []);
          } catch (_) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(7000, () => { req.destroy(); resolve([]); });
      req.write(body);
      req.end();
    });

    if (!results.length) {
      logger.info(`[video.agent] _resolveVideoUrl: no results — falling back to platform search`);
      return { resolved: false, cleanQuery };
    }

    // Score each result and pick the best
    const scored = results.map(r => ({
      url: r.url,
      title: r.title || '',
      snippet: r.snippet || '',
      score: _scoreVideoResult(r, cleanQuery, platformDomain),
    })).sort((a, b) => b.score - a.score);

    const best = scored[0];
    logger.info(`[video.agent] _resolveVideoUrl: best="${best.url}" score=${best.score.toFixed(2)} title="${best.title.substring(0, 60)}"`);

    if (best.score >= _VIDEO_RESOLVE_CONFIDENCE) {
      logger.info(`[video.agent] _resolveVideoUrl: HIGH CONFIDENCE — navigating directly to video URL`);
      return { resolved: true, url: best.url, title: best.title, score: best.score };
    }

    logger.info(`[video.agent] _resolveVideoUrl: score ${best.score.toFixed(2)} below threshold ${_VIDEO_RESOLVE_CONFIDENCE} — falling back to platform search`);
    return { resolved: false, cleanQuery };

  } catch (err) {
    logger.warn(`[video.agent] _resolveVideoUrl failed: ${err.message} — falling back to platform search`);
    return { resolved: false, cleanQuery };
  }
}

/**
 * Tier 1 — Fast-path regex patterns for known video platforms.
 * Returns { url, title, duration } entries from snapshot text.
 */
const PLATFORM_VIDEO_PATTERNS = {
  youtube: {
    urlRx: /https:\/\/(?:www\.)?youtube\.com\/watch\?[^\s\])"]+/g,
    skip: (url) => url.includes('/shorts/'),
    validate: (url) => !!extractYouTubeVideoId(url),
  },
  vimeo: {
    urlRx: /https:\/\/(?:www\.)?vimeo\.com\/(?:\d+|channels\/[^/]+\/\d+|[^/]+\/[^/]+\/[^/\s\])"]+)[^\s\])"]{0,30}/g,
    skip: () => false,
    validate: (url) => /vimeo\.com\/\d+/.test(url),
  },
  rumble: {
    urlRx: /https:\/\/rumble\.com\/v[a-zA-Z0-9-]+\.html[^\s\])"]{0,30}/g,
    skip: () => false,
    validate: () => true,
  },
  facebook: {
    urlRx: /https:\/\/(?:www\.)?facebook\.com\/(?:watch\/\?v=\d+|[^/]+\/videos\/\d+)[^\s\])"]{0,30}/g,
    skip: () => false,
    validate: () => true,
  },
  tiktok: {
    urlRx: /https:\/\/(?:www\.)?tiktok\.com\/@[^/]+\/video\/\d+[^\s\])"]{0,30}/g,
    skip: () => false,
    validate: () => true,
  },
  dailymotion: {
    urlRx: /https:\/\/(?:www\.)?dailymotion\.com\/video\/[a-zA-Z0-9]+[^\s\])"]{0,30}/g,
    skip: () => false,
    validate: () => true,
  },
};

/**
 * Extract ALL https:// URLs from a snapshot/page text (for Tier 2 LLM filtering).
 */
function extractAllUrlsFromSnapshot(text) {
  const seen = new Set();
  const results = [];
  // Match any URL-like token in snapshot lines — href=, url=, or bare https://
  const rx = /https:\/\/[^\s\])"<>]{8,}/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const url = m[0].replace(/[)\]".,;:!?]+$/, '').trim();
    if (!seen.has(url)) {
      seen.add(url);
      results.push(url);
    }
  }
  return results;
}

/**
 * Tier 3 — Heuristic regex fallback: matches common video URL patterns across all platforms.
 */
function heuristicVideoUrlFilter(urls) {
  const videoRx = /(?:watch\?v=|vimeo\.com\/\d+|rumble\.com\/v|tiktok\.com\/@[^/]+\/video\/|dailymotion\.com\/video\/)/ ;
  return urls.filter(u => videoRx.test(u));
}

/**
 * Tier 2 — LLM classifier: ask LLM which of the extracted URLs are video watch pages.
 * Returns filtered URL array. Falls back to heuristic if LLM unavailable.
 */
async function llmFilterVideoUrls(urls, platformKey, query, skillLlm) {
  if (!skillLlm || urls.length === 0) {
    return heuristicVideoUrlFilter(urls);
  }

  const candidates = urls.slice(0, 30);

  try {
    const { ask } = skillLlm;
    const prompt = `You are classifying URLs from a ${platformKey} search results page.
Search query: "${query}"

From the list below, return ONLY the URLs that are video watch pages (not channel pages, playlists, ads, or navigation links).
Return a JSON array of URL strings only. No explanations.

URLs:
${candidates.map((u, i) => `${i + 1}. ${u}`).join('\n')}

JSON array:`;

    const response = await ask(prompt, { maxTokens: 400, temperature: 0 });
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        logger.info(`[video.agent] LLM filtered ${candidates.length} URLs → ${parsed.length} video URLs`);
        return parsed.map(u => String(u).replace(/[)\]".,;:!?]+$/, '').trim());
      }
    }
  } catch (err) {
    logger.warn(`[video.agent] LLM URL filter failed: ${err.message} — falling back to heuristic`);
  }

  return heuristicVideoUrlFilter(candidates);
}

/**
 * Extract duration text near a URL line in the snapshot (±3 lines).
 */
function extractDurationNearLine(lines, lineIndex) {
  const durationRx = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/;
  const start = Math.max(0, lineIndex - 1);
  const end = Math.min(lines.length - 1, lineIndex + 3);
  for (let i = start; i <= end; i++) {
    const m = lines[i].match(durationRx);
    if (m) return m[1];
  }
  return '';
}

/**
 * Parse video entries from a playwright-cli snapshot (YAML accessibility tree).
 *
 * 3-tier strategy:
 *   Tier 1 — Fast-path regex for known platforms (YouTube, Vimeo, Rumble, Facebook, TikTok, Dailymotion)
 *   Tier 2 — LLM filter for unknown platforms or when Tier 1 finds nothing
 *   Tier 3 — Heuristic regex safety net when LLM is unavailable
 *
 * Works around YouTube CSP which blocks evaluate()/getPageLinks() IIFE on search result pages.
 */
async function parseVideosFromSnapshot(snapshotText, platformKey, query, skillLlm) {
  const lines = snapshotText.split('\n');
  const seen = new Set();

  // ── Tier 1: Fast-path for known platforms ────────────────────────────────
  const pattern = PLATFORM_VIDEO_PATTERNS[platformKey];
  if (pattern) {
    const videos = [];
    let m;
    const rx = new RegExp(pattern.urlRx.source, pattern.urlRx.flags);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      rx.lastIndex = 0;
      while ((m = rx.exec(line)) !== null) {
        const url = m[0].replace(/[)\]".,;:!?]+$/, '').trim();
        if (seen.has(url)) continue;
        if (pattern.skip(url)) continue;
        if (!pattern.validate(url)) continue;
        seen.add(url);

        // Title: text in quotes on the same line
        const titleMatch = line.match(/"([^"]{3,120})"/);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // Skip ads/sponsored
        if (/^(sponsored|ad |promoted)/i.test(title)) continue;

        const durationStr = extractDurationNearLine(lines, i);
        videos.push({ title, url, duration: parseDurationString(durationStr) });
      }
    }

    if (videos.length > 0) {
      logger.info(`[video.agent] Tier 1 (fast-path ${platformKey}): found ${videos.length} video(s)`);
      return videos;
    }
    logger.info(`[video.agent] Tier 1 found nothing for ${platformKey} — trying Tier 2`);
  }

  // ── Tier 2 / 3: Extract all URLs then LLM-filter (or heuristic fallback) ─
  const allUrls = extractAllUrlsFromSnapshot(snapshotText);
  logger.info(`[video.agent] Extracted ${allUrls.length} total URLs for Tier 2/3 filtering`);

  const videoUrls = await llmFilterVideoUrls(allUrls, platformKey, query || '', skillLlm);

  if (videoUrls.length === 0) {
    return [];
  }

  // Enrich with title + duration from snapshot context
  return videoUrls.slice(0, 8).map(url => {
    // Find line index of this URL in snapshot
    const lineIdx = lines.findIndex(l => l.includes(url));
    const title = lineIdx >= 0
      ? (lines[lineIdx].match(/"([^"]{3,120})"/) || [])[1] || ''
      : '';
    const durationStr = lineIdx >= 0 ? extractDurationNearLine(lines, lineIdx) : '';
    return { title: title.trim(), url, duration: parseDurationString(durationStr) };
  });
}

/**
 * Parse duration string "MM:SS" or "H:MM:SS" → seconds. Returns 0 if unparseable.
 */
function parseDurationString(str) {
  if (!str) return 0;
  const parts = str.replace(/[^0-9:]/g, '').split(':').map(Number).filter(n => !isNaN(n));
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Search for and watch tutorial video — supports YouTube, Vimeo, Rumble, Facebook Video, TikTok
 */
async function actionFindAndWatchTutorial({ platform, query, goal }, dependencies = {}) {
  const { browserAct, skillLlm } = dependencies;
  
  if (!browserAct) {
    return { ok: false, error: 'browserAct is required' };
  }

  const platformKey = (platform || 'youtube').toLowerCase().replace(/[^a-z]/g, '');
  const config = PLATFORM_CONFIG[platformKey];

  if (!config) {
    return { 
      ok: false, 
      error: `Unsupported platform: ${platform}. Supported: ${Object.keys(PLATFORM_CONFIG).join(', ')}` 
    };
  }

  logger.info(`[video.agent] Finding ${platformKey} tutorial: "${query}"`);

  try {
    // ── Step 0: Web-search-based URL resolution ───────────────────────────────────────────
    // Use web search MCP to find a direct watch URL before touching the platform search page.
    // This bypasses YouTube's apostrophe/encoding truncation bug AND the CSP/link-extraction
    // issues on search results pages.  Falls back gracefully to the platform search page.
    const resolved = await _resolveVideoUrl(query, platformKey);

    if (resolved.resolved) {
      // High-confidence direct URL found — skip the search results page entirely
      logger.info(`[video.agent] Resolved direct URL (score=${resolved.score.toFixed(2)}): ${resolved.url}`);
      return actionWatchVideo({
        videoUrl: resolved.url,
        goal,
        options: { context: 'agent_learning', maxDuration: 1200 }
      }, dependencies);
    }

    // Low confidence or web search unavailable — navigate to platform search page.
    // Use cleanQuery (apostrophes stripped) to avoid URL truncation.
    const effectiveQuery = resolved.cleanQuery || _normalizeQuery(query);
    const searchUrl = config.searchUrl(effectiveQuery);
    logger.info(`[video.agent] Falling back to platform search page with query: "${effectiveQuery}"`);
    await browserAct({ action: 'navigate', url: searchUrl });

    // Wait for results to load — use waitForStableText which reliably waits for dynamic content
    await browserAct({ action: 'waitForStableText', timeoutMs: 8000 });

    let videos = [];

    // ── Path A: getPageLinks (CSP-safe with .playwright/cli.config.json bypassCSP:true) ──
    // Returns { links: [{href, text, title}] } — real DOM href attributes, not snapshot YAML
    try {
      const linksResult = await browserAct({ action: 'getPageLinks' });
      const allLinks = linksResult?.links || [];
      logger.info(`[video.agent] getPageLinks returned ${allLinks.length} total links`);

      const pattern = PLATFORM_VIDEO_PATTERNS[platformKey];
      if (pattern && allLinks.length > 0) {
        const seen = new Set();
        for (const link of allLinks) {
          const href = (link.href || link.url || '').trim();
          if (!href || seen.has(href)) continue;
          // Reset regex state between iterations
          const rx = new RegExp(pattern.urlRx.source, pattern.urlRx.flags);
          const m = rx.exec(href);
          if (!m) continue;
          const url = m[0].replace(/[)\]".,;:!?]+$/, '').trim();
          if (pattern.skip(url) || !pattern.validate(url)) continue;
          seen.add(url);
          const title = (link.text || link.title || '').trim().substring(0, 150);
          if (/^(sponsored|ad |promoted)/i.test(title)) continue;
          videos.push({ title, url, duration: 0 });
        }
        logger.info(`[video.agent] Path A (getPageLinks): found ${videos.length} video(s)`);
      }
    } catch (err) {
      logger.warn(`[video.agent] getPageLinks failed: ${err.message}`);
    }

    // ── Path B: evaluate querySelectorAll (also CSP-safe with bypassCSP:true) ─────────────
    if (videos.length === 0) {
      try {
        const evalExpr = `(function(){
          var anchors = Array.from(document.querySelectorAll('a[href*="watch?v="],a[href*="/video/"],a[href*="vimeo.com/"],a[href*="rumble.com/v"]'));
          return JSON.stringify(anchors.slice(0,25).map(function(a){
            return {
              href: a.href,
              title: (a.getAttribute('aria-label') || a.innerText || '').trim().substring(0,150)
            };
          }));
        })()`;
        const evalResult = await browserAct({ action: 'evaluate', expression: evalExpr });
        const evalText = evalResult?.stdout || evalResult?.result || '';
        const jsonMatch = evalText.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const items = JSON.parse(jsonMatch[0]);
          const seen = new Set();
          const pattern = PLATFORM_VIDEO_PATTERNS[platformKey];
          for (const item of items) {
            const url = (item.href || '').trim().replace(/[)\]".,;:!?]+$/, '');
            if (!url || seen.has(url)) continue;
            if (pattern && (pattern.skip(url) || !pattern.validate(url))) continue;
            seen.add(url);
            const title = (item.title || '').trim();
            if (/^(sponsored|ad |promoted)/i.test(title)) continue;
            videos.push({ title, url, duration: 0 });
          }
          logger.info(`[video.agent] Path B (evaluate): found ${videos.length} video(s)`);
        }
      } catch (err) {
        logger.warn(`[video.agent] evaluate fallback failed: ${err.message}`);
      }
    }

    // ── Path C: "videoId" JSON regex from raw page text (CSP-immune last resort) ──────────
    // YouTube embeds all video data as JSON in the page source — always present regardless of CSP.
    if (videos.length === 0 && platformKey === 'youtube') {
      try {
        const pageTextResult = await browserAct({ action: 'getPageText' });
        const rawText = pageTextResult?.stdout || pageTextResult?.result || '';
        logger.info(`[video.agent] Path C: getPageText returned ${rawText.length} chars`);

        // Extract videoId + title pairs from YouTube's embedded JSON data
        const videoIdRx = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
        const titleRx = /"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]{3,150})"/g;
        const ids = [], titles = [];
        let m;
        while ((m = videoIdRx.exec(rawText)) !== null) ids.push(m[1]);
        while ((m = titleRx.exec(rawText)) !== null) titles.push(m[1]);

        // Also try simpler title format: "title":{"simpleText":"..."}
        const simpleTitleRx = /"title"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]{3,150})"/g;
        const simpleTitles = [];
        while ((m = simpleTitleRx.exec(rawText)) !== null) simpleTitles.push(m[1]);
        const allTitles = titles.length >= ids.length ? titles : simpleTitles;

        const seen = new Set();
        for (let i = 0; i < ids.length && videos.length < 15; i++) {
          const videoId = ids[i];
          if (seen.has(videoId)) continue;
          seen.add(videoId);
          const url = `https://www.youtube.com/watch?v=${videoId}`;
          const title = (allTitles[i] || '').trim();
          videos.push({ title, url, duration: 0 });
        }
        logger.info(`[video.agent] Path C (videoId regex): found ${videos.length} video(s)`);
      } catch (err) {
        logger.warn(`[video.agent] Path C failed: ${err.message}`);
      }
    }

    // ── Path D: generic platform URL regex from page text (non-YouTube fallback) ──────────
    if (videos.length === 0 && platformKey !== 'youtube') {
      try {
        const pageTextResult = await browserAct({ action: 'getPageText' });
        const rawText = pageTextResult?.stdout || pageTextResult?.result || '';
        videos = await parseVideosFromSnapshot(rawText, platformKey, query, skillLlm);
        logger.info(`[video.agent] Path D (page text fallback): found ${videos.length} video(s)`);
      } catch (err) {
        logger.warn(`[video.agent] Path D failed: ${err.message}`);
      }
    }

    if (videos.length === 0) {
      return { ok: false, error: `No suitable videos found on ${platformKey} for query: "${query}"` };
    }

    // Prefer tutorial-length videos (5-20 min = 300-1200s)
    // Fall back to any video with a valid URL if none in range
    const withKnownDuration = videos.filter(v => v.duration > 0);
    const tutorialVideos = withKnownDuration.filter(v => v.duration >= 300 && v.duration <= 1200);
    
    let selected;
    if (tutorialVideos.length > 0) {
      selected = tutorialVideos[0];
      logger.info(`[video.agent] Selected tutorial-length (${Math.round(selected.duration/60)}min): "${selected.title}"`);
    } else if (withKnownDuration.length > 0) {
      // Prefer longest video with known duration (more likely to be a full tutorial)
      selected = withKnownDuration.sort((a, b) => b.duration - a.duration)[0];
      logger.info(`[video.agent] No ideal length — using longest with known duration (${Math.round(selected.duration/60)}min): "${selected.title}"`);
    } else {
      // No duration info available — take first result
      selected = videos[0];
      logger.info(`[video.agent] No duration info — using first result: "${selected.title || selected.url}"`);
    }

    logger.info(`[video.agent] Watching: ${selected.url}`);
    
    return actionWatchVideo({
      videoUrl: selected.url,
      goal,
      options: { context: 'agent_learning', maxDuration: 1200 }
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
