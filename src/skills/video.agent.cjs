'use strict';

/**
 * skill: video.agent
 *
 * Universal video extraction agent:
 * 1. Extract rich page content (metadata, description, comments)
 * 2. Audio transcription via transcribe-anything Python API (when available)
 * 3. Combine for comprehensive video understanding
 *
 * Works with YouTube, Vimeo, Rumble, BitChute, news embeds, or any video page.
 *
 * Actions:
 *   watch_video          { videoUrl, goal, options }     → watch specific video
 *   find_and_watch       { platform, query, goal }      → search and watch tutorial
 *   watch_from_page      { pageUrl, videoSelector, goal } → watch video on any page
 */

const logger = require('../logger.cjs');
const path = require('path');
const { injectAdBlock } = require('./browser.act.cjs');

// User Memory MCP configuration
const USER_MEMORY_URL = process.env.USER_MEMORY_MCP_URL || 'http://localhost:3001';

// ── yt-dlp version management ────────────────────────────────────────────────
// yt-dlp tracks YouTube's internal API and must be updated every ~4-6 weeks.
// We check once per process startup and auto-upgrade if the binary is stale.
let _ytdlpChecked = false;  // true after the first successful check this process
let _ytdlpUpgrading = null; // Promise<void> while upgrade is in progress

/**
 * Parse a yt-dlp version string like "2026.03.17" into a Date.
 * Returns null if unparseable.
 */
function _parseYtDlpDate(versionStr) {
  const m = (versionStr || '').match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}`);
}

/**
 * Run pip3 install --upgrade yt-dlp.
 * Returns { ok, newVersion } — always resolves (never throws).
 */
async function _upgradeYtDlp() {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    logger.info('[video.agent] Upgrading yt-dlp via pip3...');
    const proc = spawn('pip3', ['install', '--upgrade', 'yt-dlp', '--quiet'], { timeout: 60000 });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      logger.warn(`[video.agent] pip3 upgrade failed: ${err.message}`);
      resolve({ ok: false });
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        logger.warn(`[video.agent] pip3 upgrade exited ${code}: ${stderr.slice(0, 200)}`);
        resolve({ ok: false });
        return;
      }
      // Read the new version after upgrade
      const { spawnSync } = require('child_process');
      const ytdlpPath = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' }).stdout.trim() || 'yt-dlp';
      const vRes = spawnSync(ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const newVersion = (vRes.stdout || '').trim();
      logger.info(`[video.agent] yt-dlp upgraded successfully → ${newVersion}`);
      resolve({ ok: true, newVersion });
    });
  });
}

/**
 * Ensure yt-dlp is fresh (≤60 days old). Runs at most once per process.
 * If stale, upgrades in-place before returning.
 * On any error, logs a warning and proceeds — never blocks transcription.
 */
async function ensureYtDlpFresh() {
  if (_ytdlpChecked) return;           // already verified this process
  if (_ytdlpUpgrading) return _ytdlpUpgrading; // upgrade already in flight

  _ytdlpUpgrading = (async () => {
    try {
      const { spawnSync } = require('child_process');
      const ytdlpPath = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' }).stdout.trim() || 'yt-dlp';
      const vRes = spawnSync(ytdlpPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const versionStr = (vRes.stdout || '').trim();
      const vDate = _parseYtDlpDate(versionStr);

      if (!vDate) {
        logger.warn(`[video.agent] Could not parse yt-dlp version: "${versionStr}" — skipping freshness check`);
        return;
      }

      const ageMs = Date.now() - vDate.getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      logger.info(`[video.agent] yt-dlp version ${versionStr} (${ageDays} days old)`);

      if (ageDays > 60) {
        logger.info(`[video.agent] yt-dlp is ${ageDays} days old (threshold: 60) — auto-upgrading...`);
        await _upgradeYtDlp();
      } else {
        logger.info(`[video.agent] yt-dlp is fresh (${ageDays} days old) — no upgrade needed`);
      }
    } catch (err) {
      logger.warn(`[video.agent] yt-dlp freshness check failed (non-fatal): ${err.message}`);
    } finally {
      _ytdlpChecked = true;
    }
  })();

  return _ytdlpUpgrading;
}

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
 * Extract metadata from video page
 */
async function extractMetadata(videoUrl, platform, browserAct, sessionId = 'default') {
  try {
    // Navigate to video
    await browserAct({ action: 'navigate', url: videoUrl });
    // Explicitly inject ad-blocker (belt-and-suspenders — also fires via browser.act hook)
    // This now sets up: Layer 1 (network route blocking) + Layer 2 (document-start init
    // script that strips YouTube ad data before the player reads it) + Layer 3 (CSS cosmetics).
    injectAdBlock(sessionId, true).catch(() => {});
    await new Promise(r => setTimeout(r, 2000)); // Wait for player load

    // Ads are now blocked at the network/player-data level — no DOM polling needed.
    // The document-start init script (Layer 2) strips adPlacements/playerAds/adSlots
    // from ytInitialPlayerResponse before YouTube's player can queue any ads.

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
 * Extract YouTube-specific text sources (description only).
 * NOTE: Transcript extraction via in-page button click has been intentionally removed.
 * browser.act's resolveRefForClick can match sidebar recommendation links instead of the
 * transcript toggle button, causing navigation to a different video before metadata is read.
 * Full transcription is handled by transcribeWithYtDlp (yt-dlp subtitles → Whisper fallback).
 */
async function extractYouTubeText(videoUrl, browserAct) {
  const sources = { transcript: null, description: null, comments: [] };
  
  try {
    // Get description using evaluate (no click actions — avoids risk of navigation)
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
 * Extract generic page content for any video platform
 */
async function extractGenericPageContent(videoUrl, browserAct) {
  const content = {
    title: null,
    description: null,
    channel: null,
    views: null,
    duration: null,
    topComments: []
  };

  try {
    // Verify we are still on the expected page before extracting any metadata.
    // A misresolved click earlier in the pipeline could have navigated away.
    try {
      const urlCheck = await browserAct({
        action: 'evaluate',
        expression: `window.location.href`
      });
      const currentUrl = String(urlCheck?.result || urlCheck?.stdout || '').replace(/^"|"$/g, '').trim();
      if (currentUrl && videoUrl && !currentUrl.includes(new URL(videoUrl).hostname)) {
        logger.warn(`[video.agent] URL drift detected: expected ${videoUrl}, got ${currentUrl} — re-navigating`);
        await browserAct({ action: 'navigate', url: videoUrl });
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (_) { /* non-fatal — proceed with extraction */ }

    // Extract page title — prefer og:title (set at page load, stable) over document.title (can drift)
    const titleResult = await browserAct({
      action: 'evaluate',
      expression: `
        document.querySelector('meta[property="og:title"]')?.content ||
        document.title?.replace(/ - YouTube$| - Vimeo$/, '') ||
        null
      `
    });
    content.title = titleResult?.result || titleResult?.stdout;

    // Extract meta description
    const descResult = await browserAct({
      action: 'evaluate',
      expression: `
        document.querySelector('meta[name="description"]')?.content ||
        document.querySelector('meta[property="og:description"]')?.content ||
        document.querySelector('[class*="description" i]')?.textContent?.substring(0, 2000) ||
        null
      `
    });
    content.description = descResult?.result || descResult?.stdout;

    // Try to extract channel/uploader info
    const channelResult = await browserAct({
      action: 'evaluate',
      expression: `
        document.querySelector('[class*="channel" i]')?.textContent?.trim() ||
        document.querySelector('[class*="author" i]')?.textContent?.trim() ||
        document.querySelector('[class*="uploader" i]')?.textContent?.trim() ||
        document.querySelector('meta[property="og:site_name"]')?.content ||
        null
      `
    });
    content.channel = channelResult?.result || channelResult?.stdout;

    // Try to extract view count
    const viewsResult = await browserAct({
      action: 'evaluate',
      expression: `
        document.querySelector('[class*="view" i]')?.textContent?.match(/[\d,]+(?:\.\d+)?\s*[KM]?\s*(?:views?|views)/i)?.[0] ||
        document.querySelector('[class*="count" i]')?.textContent?.match(/[\d,]+/)?.[0] ||
        null
      `
    });
    content.views = viewsResult?.result || viewsResult?.stdout;

    // Try to extract top comments (first 3)
    const commentsResult = await browserAct({
      action: 'evaluate',
      expression: `
        (() => {
          const comments = document.querySelectorAll('[class*="comment" i] [class*="text" i], [class*="comment" i] [class*="content" i], .comment');
          const texts = [];
          for (let i = 0; i < Math.min(comments.length, 3); i++) {
            const text = comments[i]?.textContent?.trim();
            if (text && text.length > 20) texts.push(text.substring(0, 300));
          }
          return texts;
        })()
      `
    });
    content.topComments = commentsResult?.result || [];

    logger.info(`[video.agent] Generic extraction: title="${content.title?.substring(0, 50)}...", desc=${content.description?.length || 0} chars`);
  } catch (err) {
    logger.warn(`[video.agent] Generic page content extraction failed: ${err.message}`);
  }

  return content;
}


/**
 * Strip SRT/VTT timestamp lines and formatting, leaving only plain spoken text.
 * Handles: "00:00:01,000 --> 00:00:03,000", "WEBVTT", sequence numbers, HTML tags,
 * VTT metadata headers (Kind:, Language:, X-TIMESTAMP-MAP:), and inline position tags.
 */
function stripSubtitleFormatting(raw) {
  return raw
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t) return false;
      if (/^WEBVTT/.test(t)) return false;
      if (/^\d+$/.test(t)) return false; // SRT sequence numbers
      if (/^\d{2}:\d{2}/.test(t)) return false; // timestamp lines (SRT + VTT)
      if (/^NOTE\b/.test(t)) return false;
      if (/^Kind:/i.test(t)) return false;     // VTT metadata
      if (/^Language:/i.test(t)) return false; // VTT metadata
      if (/^X-TIMESTAMP-MAP:/i.test(t)) return false; // VTT metadata
      return true;
    })
    .map(line => line.replace(/<[^>]+>/g, '').trim()) // strip HTML/VTT inline tags
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * PRIMARY: Transcribe/caption a video using yt-dlp --write-auto-subs.
 * Downloads only the subtitle file (~2s), no audio download needed.
 * Works for YouTube auto-captions via the android API (no JS runtime required).
 *
 * FALLBACK: transcribe-anything (Whisper) — for videos with no auto-captions
 * (private videos, live streams, non-YouTube platforms without captions).
 */
async function transcribeWithYtDlp(videoUrl) {
  const { spawnSync, spawn } = require('child_process');
  const os = require('os');
  const crypto = require('crypto');
  const fs = require('fs');

  // Ensure yt-dlp is up to date before attempting extraction (once per process)
  await ensureYtDlpFresh();

  const hash = crypto.createHash('md5').update(videoUrl).digest('hex').slice(0, 8);
  const outTemplate = path.join(os.tmpdir(), `thinkdrop_transcript_${hash}`);

  // ── Helper: run yt-dlp subtitle extraction ───────────────────────────────
  const _runYtDlpSubs = () => {
    const ytdlpPath = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' }).stdout.trim() || 'yt-dlp';
    return new Promise((resolve) => {
      const proc = spawn(ytdlpPath, [
        videoUrl,
        '--write-auto-subs',
        '--sub-lang', 'en',
        '--skip-download',
        '--no-playlist',
        '--js-runtimes', 'node',
        '-o', outTemplate,
        '--quiet',
      ], { timeout: 30000 });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => resolve({ ok: false, error: err.message }));
      proc.on('close', code => resolve({ ok: code === 0, code, stderr }));
    });
  };

  // ── PRIMARY: yt-dlp subtitle extraction ──────────────────────────────────
  logger.info(`[video.agent] transcribeWithYtDlp: extracting subtitles for ${videoUrl}`);

  let ytResult = await _runYtDlpSubs();

  // ── Reactive staleness recovery ───────────────────────────────────────────
  // If yt-dlp itself warned about being outdated in stderr, upgrade and retry once.
  // This catches the case where ensureYtDlpFresh() ran but the version was borderline,
  // or the binary changed between startup and now.
  const _stalenessWarning = /older than \d+ days/i.test(ytResult.stderr || '');
  if (_stalenessWarning && !ytResult.ok) {
    logger.info('[video.agent] yt-dlp reported staleness warning on failure — upgrading and retrying once...');
    _ytdlpChecked = false; // reset so ensureYtDlpFresh will re-run upgrade
    await _upgradeYtDlp();
    _ytdlpChecked = true;
    ytResult = await _runYtDlpSubs();
    logger.info(`[video.agent] yt-dlp retry after upgrade: ok=${ytResult.ok}`);
  }

  // yt-dlp writes <outTemplate>.en.vtt (native, no ffmpeg needed) or .en.srt if conversion was possible
  let subFile = null;
  try {
    const tmpDir = os.tmpdir();
    const prefix = `thinkdrop_transcript_${hash}`;
    // Prefer .vtt (written without ffmpeg); fall back to .srt if somehow present
    const candidates = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix) && (f.endsWith('.vtt') || f.endsWith('.srt')));
    if (candidates.length > 0) {
      // Prefer .vtt over .srt
      const vtt = candidates.find(f => f.endsWith('.vtt'));
      subFile = path.join(tmpDir, vtt || candidates[0]);
    }
  } catch (_) { /* ignore */ }

  if (subFile && fs.existsSync(subFile)) {
    try {
      const raw = fs.readFileSync(subFile, 'utf8');
      fs.unlinkSync(subFile); // clean up
      const transcript = stripSubtitleFormatting(raw);
      if (transcript.length > 50) {
        logger.info(`[video.agent] yt-dlp subtitles: ${transcript.length} chars`);
        return { ok: true, transcript, source: 'yt-dlp-subs' };
      }
    } catch (readErr) {
      logger.warn(`[video.agent] Failed to read subtitle file: ${readErr.message}`);
    }
  }

  logger.info(`[video.agent] yt-dlp subtitles unavailable (${ytResult.stderr?.slice(0, 120) || 'no subtitle file written'}) — trying transcribe-anything fallback`);

  // ── FALLBACK: transcribe-anything (Whisper) ───────────────────────────────
  const _platform = os.platform();
  const _arch = os.arch();
  let device = 'cpu';
  if (_platform === 'darwin' && _arch === 'arm64') {
    device = 'mlx';
    logger.info('[video.agent] Using MLX backend (Apple Silicon)');
  }

  try {
    const checkResult = spawnSync('python3', ['-c', 'import transcribe_anything'], { timeout: 5000, encoding: 'utf8' });
    if (checkResult.status !== 0) {
      logger.info('[video.agent] transcribe-anything not found — attempting pip3 install...');
      const installResult = spawnSync('pip3', ['install', 'transcribe-anything', '--quiet', '--user'], { timeout: 120000, encoding: 'utf8' });
      if (installResult.status !== 0) {
        logger.warn(`[video.agent] pip3 install transcribe-anything failed: ${installResult.stderr}`);
        return { ok: false, error: 'No subtitles available and transcribe-anything could not be installed' };
      }
      logger.info('[video.agent] transcribe-anything installed successfully');
    }
  } catch (installErr) {
    return { ok: false, error: `transcribe-anything check failed: ${installErr.message}` };
  }

  return new Promise((resolve) => {
    const pythonScript = `
import sys, json
try:
    from transcribe_anything import transcribe
    result = transcribe(url_or_file="${videoUrl}", device="${device}", model="large", task="transcribe")
    print(json.dumps({"success": True, "transcript": result}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
`;
    const pythonProcess = spawn('python3', ['-c', pythonScript], { timeout: 120000 });
    let stdout = '', stderr = '';
    pythonProcess.stdout.on('data', d => { stdout += d.toString(); });
    pythonProcess.stderr.on('data', d => { stderr += d.toString(); });
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        logger.warn(`[video.agent] transcribe-anything exited ${code}: ${stderr.slice(0, 200)}`);
        resolve({ ok: false, error: `Transcription failed: ${stderr || 'exit ' + code}` });
        return;
      }
      try {
        const result = JSON.parse(stdout);
        if (result.success && result.transcript) {
          logger.info(`[video.agent] transcribe-anything: ${result.transcript.length} chars`);
          resolve({ ok: true, transcript: result.transcript, source: 'transcribe-anything' });
        } else {
          resolve({ ok: false, error: result.error || 'Unknown transcription error' });
        }
      } catch (_) {
        if (stdout && stdout.length > 100) {
          resolve({ ok: true, transcript: stdout, source: 'transcribe-anything-raw' });
        } else {
          resolve({ ok: false, error: 'Could not parse transcription output' });
        }
      }
    });
    pythonProcess.on('error', err => resolve({ ok: false, error: `Python not available: ${err.message}` }));
  });
}

/**
 * Combine page content and transcription using LLM
 */
async function synthesizeVideoContent(pageContent, transcription, goal, skillLlm) {
  // Pre-calculate hasTranscript so it's available in catch block
  const hasTranscript = transcription && transcription.length > 100;

  if (!skillLlm) {
    return { confidence: 0, steps: [], hasTranscript };
  }

  try {
    const { ask } = skillLlm;

    let prompt;
    if (hasTranscript) {
      // Have both page content AND transcription
      prompt = `Synthesize this video content into clear actionable steps for: "${goal}"

=== VIDEO METADATA ===
Title: ${pageContent.title || 'Unknown'}
Channel: ${pageContent.channel || 'Unknown'}
Duration: ${pageContent.duration || 'Unknown'}
Views: ${pageContent.views || 'Unknown'}

=== VIDEO DESCRIPTION ===
${pageContent.description?.substring(0, 2000) || 'No description'}

=== AUDIO TRANSCRIPT (What was said) ===
${transcription.substring(0, 4000)}

=== TOP COMMENTS (Viewer insights) ===
${(Array.isArray(pageContent.topComments) ? pageContent.topComments : []).map(c => `- ${c}`).join('\n') || 'No comments'}

Extract 5-10 clear, actionable steps. Format as:
1. [Action] [Detail]
2. ...

If the content is insufficient for clear steps, respond with "INSUFFICIENT" and explain why.

STEPS:`;
    } else {
      // Page content only
      prompt = `Extract actionable steps from this video information for: "${goal}"

=== VIDEO METADATA ===
Title: ${pageContent.title || 'Unknown'}
Channel: ${pageContent.channel || 'Unknown'}
Duration: ${pageContent.duration || 'Unknown'}
Views: ${pageContent.views || 'Unknown'}

=== VIDEO DESCRIPTION ===
${pageContent.description?.substring(0, 3000) || 'No description'}

=== TOP COMMENTS ===
${(Array.isArray(pageContent.topComments) ? pageContent.topComments : []).map(c => `- ${c}`).join('\n') || 'No comments'}

Extract 3-10 clear, actionable steps based on the information available. Format as:
1. [Action] [Detail]
2. ...

If the content is insufficient, respond with "INSUFFICIENT".

STEPS:`;
    }

    const response = await ask(prompt, { maxTokens: 800, temperature: 0.3 });

    if (response.includes('INSUFFICIENT')) {
      return { confidence: 0, steps: [], hasTranscript };
    }

    const steps = response
      .split('\n')
      .map(line => line.replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 10);

    // Higher confidence if we have transcript
    const baseConfidence = hasTranscript ? 0.85 : 0.7;
    const confidence = Math.min(0.95, baseConfidence + (steps.length * 0.02));

    return {
      confidence,
      steps: steps.map((text, i) => ({ step: i + 1, text })),
      hasTranscript
    };
  } catch (err) {
    logger.warn(`[video.agent] Video synthesis failed: ${err.message}`);
    return { confidence: 0, steps: [], hasTranscript };
  }
}

/**
 * Main action: Watch a specific video with page content + transcription approach
 */
async function actionWatchVideo({ videoUrl, goal, options = {} }, dependencies = {}) {
  const { browserAct, skillLlm } = dependencies;
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
  // NEW APPROACH: Page content extraction + Audio transcription
  // ===================================================================

  // STEP 1: Extract rich page content (always works)
  logger.info('[video.agent] Extracting page content...');
  let pageContent = null;
  if (platform === 'youtube') {
    pageContent = await extractYouTubeText(videoUrl, browserAct);
  }

  // If platform-specific extraction failed or not available, try generic
  if (!pageContent || !pageContent.title) {
    pageContent = await extractGenericPageContent(videoUrl, browserAct);
  }

  // STEP 2: Try subtitle/transcript extraction (best effort - don't block on failure)
  logger.info('[video.agent] Attempting transcript extraction (yt-dlp subs → transcribe-anything fallback)...');
  let transcription = null;
  try {
    const txResult = await transcribeWithYtDlp(videoUrl);
    if (txResult.ok) {
      transcription = txResult.transcript;
      logger.info(`[video.agent] Transcript acquired via ${txResult.source}: ${transcription.length} chars`);
    } else {
      logger.info(`[video.agent] Transcript unavailable: ${txResult.error}`);
    }
  } catch (err) {
    logger.info(`[video.agent] Transcript error (non-blocking): ${err.message}`);
  }

  // STEP 3: Combine page content + transcription using LLM
  if (!skillLlm) {
    return {
      ok: true,
      steps: [],
      stdout: `Watched video: ${pageContent?.title || videoUrl}`,
      source: transcription ? 'page+transcription' : 'page_only',
      platform,
      duration: metadata.duration,
      pageContent,
      pageTitle: pageContent?.title || null,
      transcriptLength: transcription?.length || 0
    };
  }

  const synthesis = await synthesizeVideoContent(pageContent, transcription, goal, skillLlm);

  const _pageTitle = pageContent?.title || null;

  if (synthesis.confidence > 0.5 && synthesis.steps.length > 0) {
    const stepsText = synthesis.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
    return {
      ok: true,
      steps: synthesis.steps,
      stdout: stepsText || `Watched video: ${_pageTitle || videoUrl}`,
      source: synthesis.hasTranscript ? 'page+transcription' : 'page_only',
      platform,
      duration: metadata.duration,
      confidence: synthesis.confidence,
      transcriptLength: transcription?.length || 0,
      pageTitle: _pageTitle
    };
  }

  // Low confidence — return richest available content so the synthesize step has real data
  const _descText = pageContent?.description?.substring(0, 1000) || '';
  const _transcriptSnippet = transcription ? `\n\nTranscript (excerpt):\n${transcription.substring(0, 1500)}` : '';
  const _stdoutFallback = [
    `Watched video: ${_pageTitle || videoUrl}`,
    _descText ? `\nDescription:\n${_descText}` : '',
    _transcriptSnippet,
  ].join('').trim();

  return {
    ok: true,
    steps: [],
    stdout: _stdoutFallback,
    source: transcription ? 'page+transcription' : 'page_only',
    platform,
    duration: metadata.duration,
    confidence: synthesis.confidence,
    transcriptLength: transcription?.length || 0,
    pageContent,
    pageTitle: _pageTitle,
    lowConfidence: true
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
 * Extract potential channel/creator name from a search query.
 * Returns { channel: string|null, topic: string } where topic is the query minus channel.
 *
 * Patterns:
 *   - "by [Channel]": "sourdough by Natasha Kitchen" → channel="Natasha Kitchen"
 *   - "from [Channel]": "recipe from Bon Appetit" → channel="Bon Appetit"
 *   - Possessive: "Natasha's Kitchen" → "Natasha Kitchen"
 *   - Capitalized words at start: "Joshua Weissman pasta" → channel="Joshua Weissman"
 */
function _extractChannelFromQuery(query) {
  if (!query) return { channel: null, topic: query || '' };

  let cleanQuery = query.trim();

  // Strip possessive apostrophes: "Natasha's Kitchen" → "Natasha Kitchen"
  cleanQuery = cleanQuery.replace(/(\w+)'s\s+(Kitchen|Cooking|Food|Channel)/gi, '$1 $2');

  // Pattern 1: "by [Channel]" or "from [Channel]"
  const byMatch = cleanQuery.match(/\bby\s+([A-Z][A-Za-z\s]+?)(?:\s+(?:about|on|for|tutorial|recipe|video|how)|$)/i) ||
                    cleanQuery.match(/\bfrom\s+([A-Z][A-Za-z\s]+?)(?:\s+(?:about|on|for|tutorial|recipe|video|how)|$)/i);
  if (byMatch) {
    const channel = byMatch[1].trim();
    const topic = cleanQuery.replace(byMatch[0], '').trim();
    return { channel, topic };
  }

  // Pattern 2: Leading capitalized words (potential channel name)
  // Look for 1-3 capitalized words at the start followed by lowercase topic words
  const leadingMatch = cleanQuery.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+([a-z].+)$/);
  if (leadingMatch) {
    const potentialChannel = leadingMatch[1].trim();
    const topic = leadingMatch[2].trim();
    // Only treat as channel if it's not common words
    const commonWords = ['how', 'what', 'why', 'when', 'where', 'the', 'best', 'easy', 'quick', 'simple'];
    if (!commonWords.includes(potentialChannel.toLowerCase())) {
      return { channel: potentialChannel, topic };
    }
  }

  return { channel: null, topic: cleanQuery };
}

/**
 * Check if a result contains the channel name (exact or fuzzy match).
 * Returns match confidence: 1.0 = exact, 0.5 = partial, 0 = no match
 */
function _channelMatchScore(result, channelName) {
  if (!channelName) return 0;

  const searchText = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();
  const channelLower = channelName.toLowerCase();

  // Exact match
  if (searchText.includes(channelLower)) return 1.0;

  // Fuzzy match - each word of channel appears
  const channelWords = channelLower.split(/\s+/).filter(w => w.length > 2);
  if (channelWords.length > 1) {
    const matchedWords = channelWords.filter(w => searchText.includes(w));
    if (matchedWords.length === channelWords.length) return 1.0;
    if (matchedWords.length >= Math.ceil(channelWords.length * 0.7)) return 0.5;
  }

  return 0;
}

/**
 * Score a web search result as a direct video URL candidate.
 * Returns a confidence value 0.0–1.0.
 *
 * Signals (additive):
 *   +0.40  URL contains a valid platform video ID (watch?v=, /video/, /v/ etc.)
 *   +0.35  Channel name appears in result (exact match)
 *   +0.20  Channel name appears in result (partial/fuzzy match)
 *   -0.30  Query has channel name but result doesn't match (penalty)
 *   +0.30  Title word overlap with rawQuery ≥ 60%
 *   +0.15  Title word overlap 30–60%
 *   +0.10  Snippet mentions at least 2 query keywords
 *   +0.05  Result domain matches the expected platform domain
 */
function _scoreVideoResult(result, rawQuery, platformDomain, channelName) {
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

  // Channel name scoring — CRITICAL for correct video selection
  if (channelName) {
    const channelScore = _channelMatchScore(result, channelName);
    if (channelScore === 1.0) {
      // +0.35 — exact channel match (high priority)
      score += 0.35;
      logger.info(`[video.agent] Channel match: "${channelName}" found in result "${title.substring(0, 50)}"`);
    } else if (channelScore === 0.5) {
      // +0.20 — partial/fuzzy channel match
      score += 0.20;
      logger.info(`[video.agent] Partial channel match: "${channelName}" partially found in result "${title.substring(0, 50)}"`);
    } else {
      // -0.30 — penalty if query has channel but result doesn't match
      score -= 0.30;
      logger.info(`[video.agent] Channel mismatch: query has "${channelName}" but result "${title.substring(0, 50)}" doesn't match — applying penalty`);
    }
  }

  return Math.min(Math.max(score, 0), 1.0);
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

  // Extract channel name from query for better video matching
  const { channel: extractedChannel, topic } = _extractChannelFromQuery(cleanQuery);
  if (extractedChannel) {
    logger.info(`[video.agent] _resolveVideoUrl: extracted channel="${extractedChannel}", topic="${topic}"`);
  }

  if (!_WS_API_URL) {
    logger.info(`[video.agent] _resolveVideoUrl: web search not configured — using platform search page with cleaned query`);
    return { resolved: false, cleanQuery };
  }

  // If we have a channel, include it in the search query for better results
  const siteQuery = platformDomain
    ? extractedChannel
      ? `${cleanQuery} "${extractedChannel}" site:${platformDomain}`
      : `${cleanQuery} site:${platformDomain}`
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
      score: _scoreVideoResult(r, cleanQuery, platformDomain, extractedChannel),
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
