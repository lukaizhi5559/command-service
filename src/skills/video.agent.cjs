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
const _lt = require('../../../../shared/live-tabs.cjs');
const { transcribeAnything } = require('../skill-helpers/transcribe-anything.cjs');

// User Memory MCP configuration
const USER_MEMORY_URL = process.env.USER_MEMORY_MCP_URL || 'http://localhost:3001';
const MEMORY_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || '';

// ── Extraction session policy ────────────────────────────────────────────────
// A 'default'-named browserAct session auto-prefers ext:default — the user's
// REAL front tab — so extractMetadata's navigate used to hijack whatever page
// was open (observed: "watch this video" reloaded the video tab mid-playback).
// Extraction work belongs on a dedicated background tab: ext:bg:<name> adopts
// or creates a tab that never activates (real profile, bot walls bypassed);
// a plain named session falls back to the Playwright engine when the
// extension is down (headless — also invisible).
const EXTRACT_BG_SESSION = 'ext:bg:video_extract';
const EXTRACT_ENGINE_SESSION = 'video_extract';

function _extractSession(options = {}) {
  if (options.liveTab) return options.sessionId || 'ext:default';
  if (options.sessionId) return options.sessionId;
  try {
    const gw = require('../ext.gateway.cjs');
    if (gw.hasExtension()) return EXTRACT_BG_SESSION;
  } catch (_) { /* gateway unavailable — engine path */ }
  return EXTRACT_ENGINE_SESSION;
}

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
async function extractMetadata(videoUrl, platform, browserAct, sessionId = 'default', { skipNavigate = false } = {}) {
  try {
    // Navigate to video — skipped when the live tab is already on it (reloading
    // a playing tab kills playback position; the 'in front of me' case).
    if (!skipNavigate) {
      await browserAct({ action: 'navigate', url: videoUrl, sessionId });
    }
    // Explicitly inject ad-blocker (belt-and-suspenders — also fires via browser.act hook)
    // This now sets up: Layer 1 (network route blocking) + Layer 2 (document-start init
    // script that strips YouTube ad data before the player reads it) + Layer 3 (CSS cosmetics).
    // skipNavigate = the user's own live tab — never inject into it mid-playback.
    if (!skipNavigate) injectAdBlock(sessionId, true).catch(() => {});
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
        sessionId,
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
        sessionId,
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
async function extractYouTubeText(videoUrl, browserAct, sessionId = 'default') {
  const sources = { transcript: null, description: null, comments: [] };
  
  try {
    // Get description using evaluate (no click actions — avoids risk of navigation)
    const descResult = await browserAct({
      action: 'evaluate',
      sessionId,
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
async function extractGenericPageContent(videoUrl, browserAct, sessionId = 'default') {
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
        sessionId,
        expression: `window.location.href`
      });
      const currentUrl = String(urlCheck?.result || urlCheck?.stdout || '').replace(/^"|"$/g, '').trim();
      if (currentUrl && videoUrl && !currentUrl.includes(new URL(videoUrl).hostname)) {
        logger.warn(`[video.agent] URL drift detected: expected ${videoUrl}, got ${currentUrl} — re-navigating`);
        await browserAct({ action: 'navigate', url: videoUrl, sessionId });
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (_) { /* non-fatal — proceed with extraction */ }

    // Extract page title — prefer og:title (set at page load, stable) over document.title (can drift)
    const titleResult = await browserAct({
      action: 'evaluate',
      sessionId,
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
      sessionId,
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
      sessionId,
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
      sessionId,
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
      sessionId,
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

  // ── FALLBACK: transcribe-anything (Whisper) via the shared helper ─────────
  // The helper owns the known footguns: out.txt extraction, static_ffmpeg PATH,
  // scratch-cwd cleanup, TD_RESULT parsing, cpu default (mlx dep-broken).
  // 'base' model — 'large' on cpu exceeds any reasonable inline timeout.
  const tx = await transcribeAnything({ target: videoUrl, model: 'base', timeoutMs: 600000 });
  if (!tx.ok) return { ok: false, error: `No subtitles and whisper fallback failed: ${tx.error}` };
  return { ok: true, transcript: tx.transcript, source: 'transcribe-anything' };
}

/**
 * Combine page content and transcription using LLM
 */
async function synthesizeVideoContent(pageContent, transcription, goal, skillLlm) {
  // Pre-calculate hasTranscript so it's available in catch block
  const hasTranscript = transcription && transcription.length > 100;
  const pc = pageContent || {};

  if (!skillLlm) {
    return { confidence: 0, steps: [], hasTranscript };
  }

  // Goal shape: "what's this video about / summarize / what did they say" wants
  // a summary — forcing "actionable steps" onto a descriptive goal produces
  // INSUFFICIENT or nonsense. Tutorial/imperative goals keep the steps prompt.
  const descriptiveGoal = /\b(what(?:'s| is| does| did| are| was)|summar|explain|about|describe|gist|overview|purpose|tell me|who|when|where|why)\b/i.test(goal || '');

  try {
    const { ask } = skillLlm;

    const metaBlock = `=== VIDEO METADATA ===
Title: ${pc.title || 'Unknown'}
Channel: ${pc.channel || 'Unknown'}
Duration: ${pc.duration || 'Unknown'}
Views: ${pc.views || 'Unknown'}

=== VIDEO DESCRIPTION ===
${pc.description?.substring(0, 2000) || 'No description'}`;

    const commentsBlock = `=== TOP COMMENTS (Viewer insights) ===
${(Array.isArray(pc.topComments) ? pc.topComments : []).map(c => `- ${c}`).join('\n') || 'No comments'}`;

    const transcriptBlock = hasTranscript
      ? `=== AUDIO TRANSCRIPT (What was said) ===\n${transcription.substring(0, 4000)}\n\n`
      : '';

    let prompt;
    if (descriptiveGoal) {
      prompt = `Summarize this video/audio for: "${goal}"

${metaBlock}

${transcriptBlock}${commentsBlock}

Describe what the video/audio is about, its purpose, and the key points.
If the available information is thin, say so honestly — do not invent detail.
If there is genuinely nothing usable, respond with "INSUFFICIENT".

SUMMARY:`;
    } else if (hasTranscript) {
      // Have both page content AND transcription
      prompt = `Synthesize this video content into clear actionable steps for: "${goal}"

${metaBlock}

${transcriptBlock}${commentsBlock}

Extract 5-10 clear, actionable steps. Format as:
1. [Action] [Detail]
2. ...

If the content is insufficient for clear steps, respond with "INSUFFICIENT" and explain why.

STEPS:`;
    } else {
      // Page content only
      prompt = `Extract actionable steps from this video information for: "${goal}"

${metaBlock}

${commentsBlock}

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

    if (descriptiveGoal) {
      const summary = response.trim();
      if (summary.length < 20) {
        return { confidence: 0, steps: [], hasTranscript };
      }
      return {
        confidence: hasTranscript ? 0.85 : 0.65,
        steps: [],
        summary,
        hasTranscript
      };
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
    liveTab = false,
    mode = 'auto'
  } = options;

  // mode:'live' — user asked us to actually play+watch; delegate to the
  // live-observation path (media.play + ambient audio + OCR samples).
  if (mode === 'live') {
    return actionWatchLive({ videoUrl, goal, options }, dependencies);
  }

  const effectiveMax = context === 'agent_learning' ? 600 : maxDuration;

  // Live-tab mode: the plan resolved a bound ext session ("this video"). Read
  // the URL off that tab when the step didn't bake one in — and never navigate
  // it away from the page the user is watching.
  let sessionId = _extractSession(options);
  let sameTab = false;

  if (!browserAct) {
    return { ok: false, error: 'browserAct is required' };
  }

  if (liveTab || sessionId.startsWith('ext:')) {
    // ANY ext session: check what it's actually on before navigating. A baked/
    // hinted session already at the target URL gets sameTab → read-only
    // extraction (no reload → no lost playback position). A tab on a different
    // page must NOT be navigated for extraction — demote to a background tab.
    const liveUrl = await _evalOnTab(browserAct, sessionId, 'window.location.href');
    if (liveUrl && /^https?:/.test(liveUrl)) {
      if (!videoUrl) {
        videoUrl = liveUrl;
        logger.info(`[video.agent] liveTab: resolved videoUrl from ${sessionId} → ${liveUrl}`);
      }
      sameTab = _sameVideoPage(liveUrl, videoUrl);
      if (!sameTab) {
        logger.warn(`[video.agent] liveTab: ${sessionId} is on ${liveUrl}, not ${videoUrl} — extracting on background tab instead`);
        sessionId = _extractSession({ ...options, liveTab: false, sessionId: null });
      }
    }
  }

  if (!videoUrl) {
    return { ok: false, error: 'videoUrl is required (no live video tab resolved)' };
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

  // Whether tier-3 live playback is reachable — exposed on results so the
  // answer layer can offer it instead of claiming the video is unwatchable.
  let liveCapable = false;
  try { liveCapable = !!require('../ext.gateway.cjs').hasExtension(); } catch (_) {}

  // Extract metadata (with ad handling). sameTab → read the live page as-is,
  // no navigate — the user's playback position is preserved. A metadata failure
  // no longer aborts the run: the headless transcript path and the generic page
  // read can still succeed — a dead browser used to kill all three.
  const metadata = await extractMetadata(videoUrl, platform, browserAct, sessionId, { skipNavigate: sameTab });

  if (!metadata.ok) {
    logger.warn(`[video.agent] Metadata extraction failed (${metadata.error}) — continuing with transcript + page fallback`);
    metadata.duration = metadata.duration || 0;
  }

  // Check duration limits (only meaningful when metadata succeeded)
  if (metadata.ok && metadata.duration > effectiveMax) {
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

  // STEP 1+2 in parallel: page content (browser) and transcript (headless
  // yt-dlp subs → whisper) are independent — neither gates the other.
  logger.info('[video.agent] Extracting page content + transcript in parallel (yt-dlp subs → transcribe-anything fallback)...');
  const [pageRes, txRes] = await Promise.allSettled([
    (async () => {
      let pc = platform === 'youtube'
        ? await extractYouTubeText(videoUrl, browserAct, sessionId)
        : null;
      // If platform-specific extraction failed or not available, try generic
      if (!pc || !pc.title) {
        pc = await extractGenericPageContent(videoUrl, browserAct, sessionId);
      }
      return pc;
    })(),
    transcribeWithYtDlp(videoUrl),
  ]);

  const pageContent = pageRes.status === 'fulfilled' ? pageRes.value : null;
  if (pageRes.status === 'rejected') {
    logger.warn(`[video.agent] Page content extraction failed: ${pageRes.reason?.message || pageRes.reason}`);
  }

  let transcription = null;
  if (txRes.status === 'fulfilled' && txRes.value?.ok) {
    transcription = txRes.value.transcript;
    logger.info(`[video.agent] Transcript acquired via ${txRes.value.source}: ${transcription.length} chars`);
  } else {
    const txErr = txRes.status === 'rejected' ? (txRes.reason?.message || String(txRes.reason)) : txRes.value?.error;
    logger.info(`[video.agent] Transcript unavailable: ${txErr}`);
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
      transcriptLength: transcription?.length || 0,
      canWatchLive: liveCapable
    };
  }

  const synthesis = await synthesizeVideoContent(pageContent, transcription, goal, skillLlm);

  const _pageTitle = pageContent?.title || null;

  // Descriptive goals ("what's this about") return a prose summary, not steps.
  if (synthesis.summary && synthesis.confidence > 0.4) {
    return {
      ok: true,
      steps: [],
      stdout: synthesis.summary,
      summary: synthesis.summary,
      source: synthesis.hasTranscript ? 'page+transcription' : 'page_only',
      platform,
      duration: metadata.duration,
      confidence: synthesis.confidence,
      transcriptLength: transcription?.length || 0,
      pageTitle: _pageTitle,
      pageContent,
      canWatchLive: liveCapable
    };
  }

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
      pageTitle: _pageTitle,
      canWatchLive: liveCapable
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
    lowConfidence: true,
    canWatchLive: liveCapable
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
const _WS_API_URL = process.env.MCP_WEB_SEARCH_URL;
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
async function actionFindAndWatchTutorial({ platform, query, goal, options = {} }, dependencies = {}) {
  const { browserAct, skillLlm } = dependencies;
  const sessionId = _extractSession(options);
  
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
        options: { ...options, context: 'agent_learning', maxDuration: 1200 }
      }, dependencies);
    }

    // Low confidence or web search unavailable — navigate to platform search page.
    // Use cleanQuery (apostrophes stripped) to avoid URL truncation.
    const effectiveQuery = resolved.cleanQuery || _normalizeQuery(query);
    const searchUrl = config.searchUrl(effectiveQuery);
    logger.info(`[video.agent] Falling back to platform search page with query: "${effectiveQuery}"`);
    await browserAct({ action: 'navigate', url: searchUrl, sessionId });

    // Wait for results to load — use waitForStableText which reliably waits for dynamic content
    await browserAct({ action: 'waitForStableText', timeoutMs: 8000, sessionId });

    let videos = [];

    // ── Path A: getPageLinks (CSP-safe with .playwright/cli.config.json bypassCSP:true) ──
    // Returns { links: [{href, text, title}] } — real DOM href attributes, not snapshot YAML
    try {
      const linksResult = await browserAct({ action: 'getPageLinks', sessionId });
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
        const evalResult = await browserAct({ action: 'evaluate', expression: evalExpr, sessionId });
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
        const pageTextResult = await browserAct({ action: 'getPageText', sessionId });
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
        const pageTextResult = await browserAct({ action: 'getPageText', sessionId });
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
      options: { ...options, context: 'agent_learning', maxDuration: 1200 }
    }, dependencies);

  } catch (err) {
    logger.error(`[video.agent] Find and watch failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 3 — live watch: play the video on a resolved tab, verify ambient audio
// capture actually lands, and sample OCR + transcript segments while it runs.
// ═══════════════════════════════════════════════════════════════════════════

const _EXT_DEFAULT_SESSION = 'ext:default';
const _LIVE_SESSION = 'ext:video_live';
// Videos longer than this get an explicit heads-up before we settle in to watch.
const _LIVE_CONFIRM_SEC = 15 * 60;
const _DEFAULT_POLL_MS = 20000;
// Media-element readiness after a navigation — SPA players mount late.
const _MEDIA_PROBE_MS = 8000;
const _MEDIA_PROBE_INTERVAL_MS = 800;

/**
 * Evaluate an expression on a browser session; returns the raw value or null.
 */
async function _evalOnTab(browserAct, sessionId, expression) {
  try {
    const r = await browserAct({ action: 'evaluate', sessionId, expression });
    const v = r?.result ?? r?.stdout;
    if (typeof v === 'string') return v.replace(/^"|"$/g, '').trim();
    return v ?? null;
  } catch (_) {
    return null;
  }
}

// Media-state evals stringify on-page, but evaluate may also return the raw
// object — accept either shape.
function _parseMediaState(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || 'null'); } catch (_) { return null; }
}

/**
 * Do two URLs point at the same video page? Compares YouTube video IDs
 * (tracking params differ), else normalized origin+pathname.
 */
function _sameVideoPage(a, b) {
  if (!a || !b) return false;
  const idA = extractYouTubeVideoId(a), idB = extractYouTubeVideoId(b);
  if (idA && idB) return idA === idB;
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch (_) {
    return a === b;
  }
}

/**
 * Minimal JSON http GET for in-process MCP services.
 */
function _httpJsonGet(url, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = require('http').request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      }, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
      req.end();
    } catch (_) { resolve(null); }
  });
}

/**
 * Fetch ambient audio-journal status — the ground truth for whether capture
 * is actually confirmed, not just requested.
 */
async function _audioStatus() {
  const base = USER_MEMORY_URL.replace(/\/$/, '');
  return _httpJsonGet(`${base}/audio.status`, {
    'Authorization': `Bearer ${MEMORY_API_KEY}`
  });
}

/**
 * Bound extension sessions (playing flags included) — empty when the gateway
 * or extension is unavailable.
 */
async function _extSessions() {
  try {
    const gw = require('../ext.gateway.cjs');
    const list = await gw.sessions();
    return Array.isArray(list?.sessions) ? list.sessions : (Array.isArray(list) ? list : []);
  } catch (_) {
    return [];
  }
}

/**
 * Pick which live tab a watch_live request should use.
 *   1. Tab whose URL matches the requested video
 *   2. Tab flagged `playing` by the media probe
 *   3. ext:default (only when the caller gave us nothing else to go on)
 * Never picks a bg: extraction tab.
 */
async function _resolveLiveSession(browserAct, videoUrl) {
  const sessions = await _extSessions();
  const usable = sessions.filter(s => s && s.sessionId && !s.sessionId.startsWith('ext:bg:'));

  if (videoUrl) {
    const match = usable.find(s => _sameVideoPage(s.url || s.pageUrl || '', videoUrl));
    if (match) return { sessionId: match.sessionId, url: match.url || videoUrl, how: 'url-match' };
  }
  const playing = usable.find(s => s.playing);
  if (playing) return { sessionId: playing.sessionId, url: playing.url || playing.pageUrl || null, how: 'media-playing' };
  if (!videoUrl) return { sessionId: _EXT_DEFAULT_SESSION, url: null, how: 'front-tab' };
  return null;
}

/** JS that reads the first media element's state on the page. */
const _MEDIA_STATE_EXPR = `(() => {
  const m = document.querySelector('video') || document.querySelector('audio');
  if (!m) return JSON.stringify({ found: false });
  return JSON.stringify({
    found: true,
    duration: isFinite(m.duration) ? m.duration : 0,
    currentTime: m.currentTime || 0,
    paused: !!m.paused,
    ended: !!m.ended,
    muted: !!m.muted,
    title: document.title || ''
  });
})()`;

/** JS that unmutes and (re)starts playback of the media element. */
const _MEDIA_PLAY_EXPR = `(() => {
  const m = document.querySelector('video') || document.querySelector('audio');
  if (!m) return 'no-media';
  try { m.muted = false; } catch (e) {}
  const p = m.play();
  if (p && p.catch) { p.catch(() => {}); }
  return 'ok';
})()`;

/**
 * watch_live — deliberately play a video on a resolved tab and observe it with
 * the ambient audio pipeline + OCR samples. This is the tier that makes
 * "watch this video" mean "actually watch it" rather than "fetch a transcript".
 */
async function actionWatchLive({ videoUrl, goal, options = {} }, dependencies = {}) {
  const { browserAct, skillLlm } = dependencies;
  const {
    maxWatchMs = 0,            // 0 = derive from duration
    pollMs = _DEFAULT_POLL_MS,
    liveTab = true,
    sessionId: requestedSession = null,
  } = options;

  if (!browserAct) return { ok: false, error: 'browserAct is required' };

  // ── Resolve the tab ──────────────────────────────────────────────────────
  let sessionId = requestedSession;
  if (_lt.isBackgroundSession(sessionId)) {
    logger.warn(`[video.agent] watch_live: ignoring bg sessionId '${sessionId}' — re-resolving live tab`);
    sessionId = null;
  }
  // Normalize a bare agent-derived session (youtube_agent) to the bound ext
  // form (ext:youtube_agent) — the same mapping url.first applies when it
  // navigated the session this plan's watch step is bound to.
  if (sessionId && !/^(ext:|open:|bg:|_)/i.test(sessionId)) {
    try {
      const { resolveExtSession } = require('./lib/browserCore/session.cjs');
      sessionId = await resolveExtSession(sessionId);
    } catch (_) {}
  }
  let resolvedUrl = videoUrl || null;

  if (!sessionId) {
    const pick = await _resolveLiveSession(browserAct, videoUrl);
    if (pick) {
      sessionId = pick.sessionId;
      if (!resolvedUrl) resolvedUrl = pick.url;
      logger.info(`[video.agent] watch_live: resolved live tab via ${pick.how} → ${sessionId}`);
    } else if (videoUrl) {
      // No live tab on it — open a dedicated bound tab (visible; does NOT
      // navigate whatever the user currently has open in ext:default).
      sessionId = _LIVE_SESSION;
      const nav = await browserAct({ action: 'navigate', url: videoUrl, sessionId, activate: true });
      if (nav?.ok === false) return { ok: false, error: `Could not open live tab: ${nav.error || 'navigate failed'}` };
      await new Promise(r => setTimeout(r, 2500));
    } else {
      return { ok: false, error: 'watch_live: no live video tab found and no videoUrl supplied' };
    }
  }

  // ── Verify a media element is really there ────────────────────────────────
  // SPA players render late — url.first resolves at domcontentloaded but the
  // <video> tag mounts seconds later. Poll briefly before declaring absence
  // (auto-stored recovery rule prescribed wait-for-stable before watch_live).
  let media = null;
  const _mediaDeadline = Date.now() + _MEDIA_PROBE_MS;
  while (Date.now() <= _mediaDeadline) {
    try { media = _parseMediaState(await _evalOnTab(browserAct, sessionId, _MEDIA_STATE_EXPR)); } catch (_) {}
    if (media?.found) break;
    media = null;
    await new Promise(r => setTimeout(r, _MEDIA_PROBE_INTERVAL_MS));
  }
  if (!media || !media.found) {
    return {
      ok: false,
      error: `watch_live: no <video>/<audio> element on ${sessionId}`,
      sessionId,
      canWatchLive: false
    };
  }
  const durationSec = media.duration || 0;
  const pageTitle = media.title || '';

  // ── Long-video heads-up ──────────────────────────────────────────────────
  if (durationSec > _LIVE_CONFIRM_SEC && !options.confirmLong) {
    return {
      ok: true,
      requiresConfirmation: true,
      durationSec,
      etaMinutes: Math.ceil(durationSec / 60),
      sessionId,
      stdout: `This video is ${Math.ceil(durationSec / 60)} minutes long — watching it in real time will take about that long. Want me to go ahead and watch it anyway?`,
      warning: `Video is ${Math.ceil(durationSec / 60)}min — live watch takes real time.`
    };
  }

  // ── Start playback ────────────────────────────────────────────────────────
  await _evalOnTab(browserAct, sessionId, _MEDIA_PLAY_EXPR);
  await new Promise(r => setTimeout(r, 1500));
  media = null;
  try { media = _parseMediaState(await _evalOnTab(browserAct, sessionId, _MEDIA_STATE_EXPR)); } catch (_) {}
  if (media && media.paused && !media.ended) {
    return {
      ok: false,
      error: 'watch_live: playback did not start (autoplay blocked or element not ready)',
      sessionId,
      pageTitle
    };
  }

  // ── Verify ambient audio capture is actually landing ─────────────────────
  const statusBefore = await _audioStatus();
  const segsBefore = statusBefore?.data?.session?.segments ?? statusBefore?.session?.segments ?? 0;

  let audioConfirmed = false;
  const audioWait = Math.min(30000, Math.max(12000, pollMs));
  const audioDeadline = Date.now() + audioWait;
  while (Date.now() < audioDeadline) {
    await new Promise(r => setTimeout(r, 4000));
    const st = await _audioStatus();
    const segsNow = st?.data?.session?.segments ?? st?.session?.segments ?? 0;
    if (segsNow > segsBefore || st?.data?.capture?.state === 'active' || st?.capture?.state === 'active') {
      audioConfirmed = true;
      break;
    }
  }
  logger.info(`[video.agent] watch_live: ambient capture ${audioConfirmed ? 'CONFIRMED' : 'NOT confirmed'} after ${audioWait}ms`);

  // ── Watch loop ────────────────────────────────────────────────────────────
  const cap = maxWatchMs > 0
    ? maxWatchMs
    : Math.min((durationSec ? durationSec * 1150 : 600 * 1000) + 120000, 3600000);
  const deadline = Date.now() + cap;
  const segments = [];
  let lastSegCount = segsBefore;
  let ended = false;
  let watchedSec = 0;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    let m = null;
    try { m = _parseMediaState(await _evalOnTab(browserAct, sessionId, _MEDIA_STATE_EXPR)); } catch (_) {}
    if (m && m.found) {
      watchedSec = m.currentTime || watchedSec;
      if (m.ended) { ended = true; break; }
      if (m.paused) await _evalOnTab(browserAct, sessionId, _MEDIA_PLAY_EXPR);
    }
    const st = await _audioStatus();
    const sess = st?.data?.session || st?.session || {};
    const recent = st?.data?.recentSegments || st?.recentSegments || [];
    if (Array.isArray(recent) && recent.length) {
      for (const s of recent.slice(-5)) {
        const t = typeof s === 'string' ? s : (s?.text || s?.transcript || '');
        if (t && segments[segments.length - 1] !== t) segments.push(t);
      }
    }
    const segsNow = sess.segments ?? lastSegCount;
    if (segsNow > lastSegCount) { audioConfirmed = true; lastSegCount = segsNow; }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const transcriptText = segments.join(' ').trim();

  // ── Summarize what was actually observed ─────────────────────────────────
  let summary = '';
  if (skillLlm && transcriptText) {
    try {
      const { ask } = skillLlm;
      summary = (await ask(
        `Summarize what was heard/seen while watching this video${goal ? ` for the user's goal: "${goal}"` : ''}.\n` +
        `Page: ${pageTitle}\nWatched ${Math.round(watchedSec)}s of ${Math.round(durationSec)}s.\n\n` +
        `Captured audio transcript:\n${transcriptText.substring(0, 6000)}\n\nSummary:`,
        { maxTokens: 700, temperature: 0.3 }
      )).trim();
    } catch (_) {}
  }

  return {
    ok: true,
    source: 'live_watch',
    sessionId,
    platform: resolvedUrl ? detectPlatform(resolvedUrl) : 'unknown',
    videoUrl: resolvedUrl,
    pageTitle,
    durationSec,
    watchedSec,
    elapsedSec: elapsed,
    ended,
    audioCapture: audioConfirmed ? 'confirmed' : 'degraded',
    audioSegments: segments.length,
    transcript: transcriptText.substring(0, 12000) || null,
    stdout: summary ||
      `Watched "${pageTitle || resolvedUrl || 'video'}" live for ${Math.round(elapsed / 60)}min` +
      ` (${Math.round(watchedSec)}s of ${Math.round(durationSec)}s). ` +
      (audioConfirmed ? `Captured ${segments.length} audio segments.` :
        'No ambient audio segments landed — audio capture may not be running; check /audio.status.') +
      (transcriptText ? `\n\nHeard: ${transcriptText.substring(0, 1500)}` : ''),
    canWatchLive: true
  };
}

// Main export handler
module.exports = async function videoAgent(args, dependencies = {}) {
  const { action, ...params } = args || {};

  // Flat step args (mode/sessionId/liveTab/...) double as options — the
  // contract declares them at args top level, not under an options object.
  const mergedOpts = { ...params, ...(params.options || {}) };
  delete mergedOpts.action;

  switch (action) {
    case 'watch_video':
      return await actionWatchVideo({ ...params, options: mergedOpts }, dependencies);
    case 'watch_live':
      return await actionWatchLive({ ...params, options: mergedOpts }, dependencies);
    case 'find_and_watch':
    case 'find_and_watch_tutorial':
      return await actionFindAndWatchTutorial({ ...params, options: mergedOpts }, dependencies);
    case 'watch_from_page':
      // Same as watch_video but hints live-tab resolution (URL may be absent —
      // the plan/guard resolves the current tab or passes pageUrl).
      if (!params.videoUrl && params.pageUrl) params.videoUrl = params.pageUrl;
      return await actionWatchVideo({ ...params, options: { ...mergedOpts, liveTab: true } }, dependencies);
    default:
      return { ok: false, error: `Unknown action: ${action}` };
  }
};

// Export individual actions for direct use
module.exports.actionWatchVideo = actionWatchVideo;
module.exports.actionWatchLive = actionWatchLive;
module.exports.actionFindAndWatchTutorial = actionFindAndWatchTutorial;
