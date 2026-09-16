'use strict';

/**
 * skill: app.runner
 *
 * App-Flow runner — mirrors instruction.runner.cjs's iterative navigation loop,
 * but for desktop apps instead of browser pages.
 *
 * Replaces URL-first with active-app-history from monitorService.
 * Uses five tiers with force-classification LLM (single number):
 *   0 = Done
 *   1 = App Shortcuts (primary, 80-90%)
 *   2 = Just-type (type into focused field — 5 sub-modes)
 *   3 = Global Shortcuts (fallback — Tab, Enter, Escape, Arrows)
 *   4 = Search Text w/LiteParser (fallback — OCR find + click)
 *   5 = Monitoring (wait for long-running ops — AI response, build, upload)
 *
 * Before/after OCR diff verification runs between each state-changing step.
 *
 * Keeps app.agent.cjs for existing utility actions (highlight, scroll, monitor,
 * clipboard, OCR capture, shortcut execution).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../logger.cjs');
const { askWithMessages, ask: skillLlmAsk } = require('../skill-helpers/skill-llm.cjs');
const { parseLlmJson } = require('../skill-helpers/parseLlmJson.cjs');
const { loadPlaybook, savePlaybook } = require('./lib/appKnowledge.cjs');

// ── Helpers ──────────────────────────────────────────────────────────────────

function _sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) { clearTimeout(t); resolve(); return; }
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });
}

// Diff two OCR text strings — returns only the NEW/changed text (lines in final
// that are not in initial). Filters out unchanged text so the verifier focuses
// on what actually changed (e.g., Devin's AI response, typed question text).
// A no-diff result means the flow had no visible effect.
function _diffOcrText(initialText, finalText) {
  if (!finalText) return '';
  if (!initialText) return finalText;

  const initialLines = new Set(
    initialText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  );
  const finalLines = finalText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Lines in final that are NOT in initial = new/changed content
  const diffLines = finalLines.filter(l => !initialLines.has(l));
  return diffLines.join('\n');
}

/**
 * _postProgress — fire-and-forget progress event POST to the Electron overlay.
 * Same pattern as browser.agent.cjs _postProgress and instruction.runner.cjs _emitProgress.
 * Posts to the /agent-turn endpoint on the overlay control server, which forwards
 * to the renderer's AutomationProgress component.
 */
function _postProgress(callbackUrl, evt) {
  if (!callbackUrl) return;
  try {
    const http = require('http');
    const payload = JSON.stringify(evt);
    const parsed = new URL(callbackUrl);
    const req = http.request({
      hostname: parsed.hostname,
      port:     parseInt(parsed.port, 10),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout:  2000,
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.write(payload);
    req.end();
  } catch (_) { /* non-fatal */ }
}

/**
 * _focusApp — robust "URL-first" style activation for desktop apps.
 *
 * Brings the target app to the foreground BEFORE any OCR or App-Flow work,
 * so the GhostLayer overlay and NutJS keystrokes land on the correct window.
 * Uses `open -a` (raises/launches) + `osascript ... activate` (force-activates
 * an already-running instance), then re-verifies with verifyAppFocused.
 *
 * @param {string} appName - target app display name (e.g. "Devin")
 * @param {object} opts - { maxRetries=3, waitMs=5000 }
 * @returns {Promise<{ok: boolean, appName?: string, error?: string}>}
 */
async function _focusApp(appName, { maxRetries = 3, waitMs = 5000 } = {}) {
  if (!appName) return { ok: false, error: 'appName is required' };
  const appAgent = require('./app.agent.cjs');
  const { execSync } = require('child_process');

  // 1. Quick check — maybe it's already focused.
  let focusResult = await appAgent.verifyAppFocused({ appName, waitMs: 1000 });
  if (focusResult.focused) {
    logger.info(`[app.runner] _focusApp: "${appName}" already focused (detected: "${focusResult.appName}")`);
    return { ok: true, appName: focusResult.appName };
  }

  // 2. Activation loop — try open -a + osascript activate, then re-verify.
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    logger.info(`[app.runner] _focusApp: attempt ${attempt}/${maxRetries} activating "${appName}" (last detected: "${focusResult.appName || 'unknown'}")`);

    // open -a raises an already-running app or launches it if not running.
    try {
      execSync(`open -a "${appName}"`, { timeout: 3000 });
    } catch (e) {
      logger.warn(`[app.runner] _focusApp: open -a "${appName}" failed: ${e.message}`);
    }

    // osascript activate is more reliable for already-running apps that open -a
    // may not bring fully forward (e.g. when ThinkDrop overlay holds foreground).
    try {
      execSync(`osascript -e 'tell application "${appName}" to activate'`, { timeout: 5000 });
    } catch (e) {
      logger.warn(`[app.runner] _focusApp: osascript activate "${appName}" failed: ${e.message}`);
    }

    // Give the OS time to actually switch foreground before re-checking.
    await _sleep(800);

    focusResult = await appAgent.verifyAppFocused({ appName, waitMs });
    if (focusResult.focused) {
      logger.info(`[app.runner] _focusApp: SUCCESS on attempt ${attempt} — focused "${focusResult.appName}"`);
      return { ok: true, appName: focusResult.appName };
    }
  }

  // 3. Hard failure — do NOT proceed with the wrong window.
  logger.error(`[app.runner] _focusApp: FAILED to focus "${appName}" after ${maxRetries} attempts (last detected: "${focusResult.appName || 'unknown'}")`);
  return {
    ok: false,
    error: `Could not focus "${appName}". Please open it and make sure it is in the foreground, then try again. (last detected: "${focusResult.appName || 'unknown'}")`,
  };
}

function _hashGoal(goal) {
  let h = 0;
  const s = String(goal || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// ── Playbook Cache (signature-keyed) ────────────────────────────────────────
// Replaces the old goalHash cache. Playbooks are keyed by app + goal-type +
// sorted sub-goal names, so similar goals (e.g. "examine file A" and
// "examine file B") reuse the same playbook with swapped entities.

const _playbookCache = new Map(); // key → { playbook, entities, successCount, failCount }
const _PLAYBOOK_CACHE_MAX_FAILS = 2;

function _playbookCacheKey(appName, signature) {
  const subGoalsKey = [...(signature.subGoals || [])].sort().join('+');
  return `${appName}::${signature.type || 'custom'}::${subGoalsKey}`;
}

function _loadPlaybookCache(appName, signature) {
  // Check in-memory cache first
  const key = _playbookCacheKey(appName, signature);
  const entry = _playbookCache.get(key);
  if (entry && entry.failCount < _PLAYBOOK_CACHE_MAX_FAILS) {
    return entry;
  }
  // Fall back to persistent cache on disk
  const persistent = loadPlaybook(appName, signature);
  if (persistent && persistent.playbook) {
    // Promote to in-memory cache
    _playbookCache.set(key, { playbook: persistent.playbook, entities: persistent.entities || {}, successCount: 1, failCount: 0 });
    return { playbook: persistent.playbook, entities: persistent.entities || {} };
  }
  return null;
}

function _savePlaybookCache(appName, signature, playbook, entities) {
  const key = _playbookCacheKey(appName, signature);
  _playbookCache.set(key, { playbook, entities: entities || {}, successCount: 1, failCount: 0 });
  // Also persist to disk so it survives restarts
  try { savePlaybook(appName, signature, playbook, entities); } catch (_) { /* non-fatal */ }
}

function _markPlaybookCacheFail(appName, signature) {
  const key = _playbookCacheKey(appName, signature);
  const entry = _playbookCache.get(key);
  if (entry) {
    entry.failCount++;
    if (entry.failCount >= _PLAYBOOK_CACHE_MAX_FAILS) {
      _playbookCache.delete(key);
      logger.info(`[app.runner] Playbook cache invalidated for "${appName}" (${signature.type}) after ${entry.failCount} failures`);
    }
  }
}

// ── Playbook Entity Substitution ────────────────────────────────────────────
// Cached playbooks store literal entity values (filenames, questions) in their
// step actions. When a new run has different entities (same signature type but
// different question/file), substitute the old values with the new ones so the
// cached flow steps use the current run's values instead of stale ones.
function _substitutePlaybookEntities(playbook, oldEntities, newEntities) {
  if (!playbook || !oldEntities || !newEntities) return playbook;
  const subs = [];
  for (const [key, oldVal] of Object.entries(oldEntities)) {
    const newVal = newEntities[key];
    if (newVal != null && oldVal != null && String(newVal) !== String(oldVal)) {
      subs.push([String(oldVal), String(newVal)]);
    }
  }
  if (subs.length === 0) return playbook;
  let json = JSON.stringify(playbook);
  for (const [oldVal, newVal] of subs) {
    // Escape regex special chars in oldVal for safe literal replacement
    const oldEsc = JSON.stringify(oldVal).slice(1, -1);
    const newEsc = JSON.stringify(newVal).slice(1, -1);
    json = json.split(oldEsc).join(newEsc);
  }
  const result = JSON.parse(json);
  logger.info(`[app.runner] _substitutePlaybookEntities: replaced ${subs.length} entity value(s) in cached playbook`);
  return result;
}

// ── Goal Signature Extraction ───────────────────────────────────────────────
// LLM extracts the goal-type + sub-goals + entities from the goal text.
// No app-specific examples — generic action names only.

async function _extractGoalSignature(goal, appName, category) {
  // Build the canonical sub-goal list from the taxonomy for the LLM prompt.
  const _taxSubGoals = Object.keys(APP_SUBGOAL_TAXONOMY).filter(s => s !== 'done' && s !== 'open_app');
  const systemPrompt = `You analyze a desktop automation goal and extract its sub-goal signature.
Return JSON only:
{
  "type": "examine_file" | "send_message" | "create_doc" | "search" | "navigate" | "open_app" | "monitor" | "custom",
  "subGoals": ["new_file", "type_value", "save"],
  "entities": { "filename": "instruction.runner.cjs", "question": "what is this file about", "content": "console.log('hello')" }
}

Rules:
- "subGoals" are GENERIC action names (not app-specific) from this canonical list:
  ${_taxSubGoals.join(', ')}
- "entities" are the concrete values extracted from the goal (filenames, questions, search terms, content to type, line numbers, etc.) — these get swapped when reusing a cached playbook.
- "type" is a coarse classification for cache lookup.

CRITICAL RULES:
- Do NOT extract "new file", "new document", "blank file", or "empty file" as a filename. Use the "new_file" sub-goal and leave "filename" empty.
- Only set "filename" if a specific, existing file path or name is mentioned (e.g. "app.runner.cjs", "/path/to/file.js"). Never set filename to "new_file", "newfile", "untitled", or similar placeholders.
- "open_file" is for opening an EXISTING file. "new_file" is for creating a new file. Do not confuse them.
- "new_file" is handled by shell.run (tier 6), not a keyboard shortcut. Extract the content to be typed as entities.content so the temp file extension can be inferred (e.g. console.log → .js, print() → .py).
- Example: "In VS Code, open a new file and type 'console.log("Hello World");' then save it." → subGoals: ["new_file", "type_value", "save"], entities: { "content": "console.log("Hello World");" }
- If the goal mentions "go to line N", use "goto_line" sub-goal and set entities.lineNumber to N.
- If the goal mentions "comment out", "uncomment", or "toggle comment", use "toggle_comment" sub-goal.
- If the goal mentions "format", "beautify", or "prettify", use "format_document" sub-goal.
- If the goal mentions "find and replace" or "replace", use "find_replace" sub-goal.
- If the goal mentions "save as", use "save_as" sub-goal instead of "save".
- Map user actions to the closest canonical sub-goal from the list above.

Output ONLY the JSON object, no other text.`;

  const userPrompt = `Goal: ${goal}
App: ${appName || 'unknown'}
Category: ${category || 'unknown'}`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 300, temperature: 0, responseTimeoutMs: 10000 });

    if (!response) return null;
    const parsed = parseLlmJson(response, logger, '_extractGoalSignature');
    if (parsed && parsed.type && Array.isArray(parsed.subGoals)) {
      // Force monitor_response when ask_question is present — a question always
      // implies waiting for a response. Without this, the pre-computed flow
      // ends at ask_question and the runner falls into an infinite loop.
      if (parsed.subGoals.includes('ask_question') && !parsed.subGoals.includes('monitor_response')) {
        parsed.subGoals.push('monitor_response');
      }

      // Deterministic override: if the goal clearly asks for a new file, ensure
      // the sub-goal is new_file (not open_file) and filename is null.
      const _preCheck = _preClassifyGoal(goal);
      if (_preCheck && _preCheck.subGoal === 'new_file') {
        // Replace any open_file with new_file
        parsed.subGoals = parsed.subGoals.map(sg => sg === 'open_file' ? 'new_file' : sg);
        if (!parsed.subGoals.includes('new_file')) {
          parsed.subGoals.unshift('new_file');
        }
        // Clear placeholder filenames
        if (parsed.entities?.filename && /^(new[_\s-]?file|new[_\s-]?document|untitled|a new file|blank file|empty file)$/i.test(parsed.entities.filename)) {
          parsed.entities.filename = null;
        }
        logger.info(`[app.runner] _extractGoalSignature: pre-check override → new_file (cleared placeholder filename)`);
      }

      // Sanitize: if filename is a known placeholder, clear it
      if (parsed.entities?.filename && /^(new[_\s-]?file|new[_\s-]?document|untitled|a new file|blank file|empty file)$/i.test(parsed.entities.filename)) {
        parsed.entities.filename = null;
        // If open_file was planned, replace with new_file
        if (parsed.subGoals.includes('open_file')) {
          parsed.subGoals[parsed.subGoals.indexOf('open_file')] = 'new_file';
        }
        logger.info(`[app.runner] _extractGoalSignature: sanitized placeholder filename → new_file`);
      }

      logger.info(`[app.runner] _extractGoalSignature: type="${parsed.type}", subGoals=[${parsed.subGoals.join(', ')}], entities=${JSON.stringify(parsed.entities || {})}`);
      return parsed;
    }
    logger.warn(`[app.runner] _extractGoalSignature: no valid signature parsed`);
    return null;
  } catch (e) {
    logger.warn(`[app.runner] _extractGoalSignature failed: ${e.message}`);
    return null;
  }
}

// ── OCR Capture ──────────────────────────────────────────────────────────────

async function _captureOcr({ appName } = {}) {
  try {
    const appAgent = require('./app.agent.cjs');
    const ocr = await appAgent.getRecentOCR({ maxAgeSeconds: 1, appName, liveOverlayHidden: true });
    return ocr?.text || '';
  } catch (e) {
    logger.warn(`[app.runner] _captureOcr failed: ${e.message}`);
    return '';
  }
}

// Fast screenshot-only capture (~100ms) using screenshot-desktop directly.
// No OCR — just saves a PNG. Used for baseline capture right after Just-Type → Enter.
// IMPORTANT: screenshot-desktop defaults to format:'jpg' on macOS (passes -t jpg
// to screencapture) even when the filename ends in .png. We must explicitly pass
// format:'png' so pngjs/pixelmatch can read the output for pixel-diff settling.
async function _captureScreenshotOnly() {
  try {
    const screenshot = require('screenshot-desktop');
    const tmpPath = path.join(os.tmpdir(), `app-runner-${Date.now()}.png`);
    await screenshot({ filename: tmpPath, format: 'png' });
    return { ok: true, path: tmpPath };
  } catch (e) {
    logger.warn(`[app.runner] _captureScreenshotOnly failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Screenshot capture with the ThinkDrop overlay hidden. Wraps _captureScreenshotOnly
// in app.agent._withFlash, which fades the GhostLayer/UnifiedOverlay out before the
// screenshot and back in after. Without this, the overlay's progress text and
// animations taint both the pixel diff (prevents settle detection) and the OCR
// (mixes ThinkDrop UI text with the target app's response). Falls back to a plain
// capture if the overlay control server (port 3010) is unreachable.
async function _captureScreenshotOnlyHidden() {
  try {
    const appAgent = require('./app.agent.cjs');
    if (typeof appAgent._withFlash === 'function') {
      return await appAgent._withFlash(() => _captureScreenshotOnly());
    }
  } catch (e) {
    logger.warn(`[app.runner] _captureScreenshotOnlyHidden: _withFlash unavailable — capturing with overlay visible: ${e.message}`);
  }
  return await _captureScreenshotOnly();
}

// Pixel-level diff between two PNG files — returns fraction of changed pixels
// (0.0 = identical, 1.0 = completely different). Uses pixelmatch + pngjs
// (both already installed). Runs in ~50-100ms for 1440x900 screenshots.
// This is the industry-standard technique for detecting screen settling:
// OCR re-segments between captures (noisy for change detection), but pixels
// are deterministic — a still screen produces zero diff.
function _pixelDiffPercent(pathA, pathB) {
  try {
    const { PNG } = require('pngjs');
    const pixelmatch = require('pixelmatch');
    const imgA = PNG.sync.read(fs.readFileSync(pathA));
    const imgB = PNG.sync.read(fs.readFileSync(pathB));
    // If sizes differ (unlikely for same display), use the smaller dimensions
    const width = Math.min(imgA.width, imgB.width);
    const height = Math.min(imgA.height, imgB.height);
    const diff = new PNG({ width, height });
    const numDiff = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold: 0.1 });
    return numDiff / (width * height);
  } catch (e) {
    logger.warn(`[app.runner] _pixelDiffPercent failed: ${e.message}`);
    return 1.0; // assume changed on error so we don't get stuck
  }
}

// Run LiteParse on a specific PNG file, returning structured rows + text.
// Wraps appAgent.actionParseScreenshot({ screenshotPath }) so we can OCR a
// pre-captured baseline screenshot without doing a new screen capture.
// Honors an AbortSignal so monitoring stops promptly on cancel.
async function _ocrScreenshot(pngPath, appName, signal) {
  if (signal?.aborted) return { rows: [], text: '', source: 'aborted' };
  try {
    const appAgent = require('./app.agent.cjs');
    const { structureOcrOverlayItems } = require('./ocrOverlayStructure.cjs');

    const parseResult = await appAgent.actionParseScreenshot({ screenshotPath: pngPath });
    if (signal?.aborted) return { rows: [], text: '', source: 'aborted' };
    if (!parseResult?.ok || !parseResult.textItems?.length) {
      return { rows: [], text: '', source: 'liteparser-empty' };
    }

    const appBounds = await appAgent._getActiveAppBounds().catch(() => null);
    if (signal?.aborted) return { rows: [], text: '', source: 'aborted' };
    const textItems = appBounds
      ? appAgent._filterItemsByAppBounds(parseResult.textItems, appBounds)
      : parseResult.textItems;
    const rows = structureOcrOverlayItems(textItems);
    const text = textItems.map(i => i.text).join('\n');
    return { rows, text, appBounds, source: 'liteparser' };
  } catch (e) {
    logger.warn(`[app.runner] _ocrScreenshot failed: ${e.message}`);
    return { rows: [], text: '', source: 'error' };
  }
}

// Line-level diff: returns only lines in current OCR that are NOT in baseline.
// Used to extract just the AI response (or command output) from the full screen.
function _computeOcrDiff(baselineText, currentText) {
  if (!baselineText) return currentText || '';
  const baselineLines = new Set(
    baselineText.split('\n').map(l => l.trim()).filter(l => l.length > 3)
  );
  const currentLines = (currentText || '').split('\n');
  const diffLines = currentLines.filter(l => {
    const trimmed = l.trim();
    return trimmed.length > 3 && !baselineLines.has(trimmed);
  });
  return diffLines.join('\n');
}

// Extract only "content" text from structured OCR rows — excludes UI chrome
// (buttons, input fields, dividers, links) so the diff focuses on actual
// response/output text and is not destabilized by UI elements appearing
// (copy buttons, reaction buttons, timestamps, formatting controls, etc.).
// Includes row-item-description (body text) and heading (titles/sections).
function _contentTextFromRows(rows) {
  if (!Array.isArray(rows)) return '';
  return rows
    .filter(r => r && (r.type === 'row-item-description' || r.type === 'heading'))
    .map(r => (r.text || '').trim())
    .filter(t => t.length > 0)
    .join('\n');
}

// Heuristic: does this short value look like code? Used by _extractAppFieldType
// to keep code snippets classified as type-edit while forcing chat questions,
// search queries, and short form inputs to type-plain regardless of appCategory.
function _looksLikeCode(text) {
  const t = String(text || '');
  if (!t) return false;
  // Common code-leading tokens
  if (/^\s*(const|let|var|function|class|def|import|export|from|return|if|for|while|async|await|public|private|interface|type|enum|struct|fn|package|namespace)\s/.test(t)) {
    return true;
  }
  // High symbol density (code punctuation)
  const symbols = (t.match(/[=;{}()[\]<>|&]/g) || []).length;
  if (symbols >= 3 && symbols / t.length > 0.05) return true;
  // Path-like / file-like (quick-open paths are handled by type-plain though)
  // Multi-line with indentation suggests code block
  if (t.includes('\n') && /\n\s{2,}\S/.test(t)) return true;
  return false;
}

// LiteParser availability cache: null = unknown, true/false after first attempt.
let _liteParserAvailable = null;

// Capture structured OCR via LiteParser + ocrOverlayStructure.cjs.
// Returns { rows, text, textItems, appBounds, source }.
// Falls back to Tesseract flat text (via _captureOcr) if LiteParser is unavailable.
async function _captureStructuredOcr({ appName } = {}) {
  // Try LiteParser first (structured rows with positions)
  if (_liteParserAvailable !== false) {
    try {
      const appAgent = require('./app.agent.cjs');
      const { structureOcrOverlayItems } = require('./ocrOverlayStructure.cjs');

      const parseResult = await appAgent.actionParseScreenshot({});
      if (parseResult.ok && parseResult.textItems && parseResult.textItems.length > 0) {
        _liteParserAvailable = true;
        const appBounds = await appAgent._getActiveAppBounds().catch(() => null);
        const textItems = appBounds
          ? appAgent._filterItemsByAppBounds(parseResult.textItems, appBounds)
          : parseResult.textItems;
        const rows = structureOcrOverlayItems(textItems);
        const text = textItems.map(i => i.text).join(' ');
        return { rows, text, textItems, appBounds, source: 'liteparser' };
      }
      // LiteParser ran but returned no items — mark as available, fall through
      _liteParserAvailable = true;
    } catch (e) {
      logger.warn(`[app.runner] _captureStructuredOcr: LiteParser failed (${e.message}) — falling back to Tesseract`);
      _liteParserAvailable = false;
    }
  }

  // Fallback: Tesseract flat text (no structured rows)
  const text = await _captureOcr({ appName });
  return { rows: [], text, textItems: [], appBounds: null, source: 'tesseract' };
}

// Extract the chat/response area from structured rows.
// For editor/chat apps like Devin, the chat area is the largest contiguous
// block of content rows (not menus, toolbars, buttons, or input fields).
// Returns empty string if no structured rows (Tesseract fallback).
function _extractChatArea(rows) {
  if (!rows || rows.length === 0) return '';

  // Filter to content rows (not icons, dividers, buttons, input fields)
  const contentRows = rows.filter(r =>
    r.type !== 'icon' &&
    r.type !== 'divider' &&
    r.type !== 'button' &&
    r.type !== 'input-field' &&
    r.text && r.text.length > 5
  );

  if (contentRows.length === 0) return '';

  // Sort by y position
  contentRows.sort((a, b) => (a.y || 0) - (b.y || 0));

  // Group rows that are within 50px vertically (contiguous blocks)
  const groups = [];
  let currentGroup = [];
  let lastY = -Infinity;
  for (const row of contentRows) {
    if ((row.y || 0) - lastY > 50 && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
    currentGroup.push(row);
    lastY = row.y || 0;
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // Pick the largest group (most rows = chat area)
  groups.sort((a, b) => b.length - a.length);
  const chatGroup = groups[0] || [];

  return chatGroup.map(r => r.text).join('\n');
}

// ── Sub-Goal → Tier mapping ──────────────────────────────────────────────────
// Maps semantic sub-goal names (from _extractGoalSignature) to App-Flow tiers.
// Tier 6 = shell.run (open file/folder/document, new file, new window, close window,
//          goto line — more reliable than shortcuts for these actions).
const _subGoalToTier = {
  // File / app operations
  open_file:        6,   // shell.run (open -a "<App>" "<path>")
  open_folder:      6,   // shell.run
  open_document:    6,   // shell.run
  new_file:         6,   // shell.run (create temp file + open in app — more reliable than Cmd+N)
  save_as:          1,   // App Shortcut: save_as (Cmd+Shift+S — editors)
  close_tab:        1,   // App Shortcut: close_tab (Cmd+W — most apps)
  print:            1,   // App Shortcut: print (Cmd+P — non-editor)
  focus_ai:         1,   // App Shortcut: focus_ai (per-app: Cmd+L for Devin/VS Code, Option+Shift+C for Teams, etc.)
  quick_open:       1,   // App Shortcut: quick_open (per-app: Cmd+P for editors, Cmd+L for browsers)
  save:             1,   // App Shortcut: save (Cmd+S — universal)
  new_tab:          1,   // App Shortcut: new_tab (Cmd+T — most apps)
  close_window:     6,   // shell.run (osascript quit app — more reliable than Cmd+W)
  new_message:      1,   // App Shortcut: new_message (Cmd+N — most chat apps)
  quick_switcher:   1,   // App Shortcut: quick_switcher (Cmd+K — Slack, Telegram)
  new_window:       6,   // shell.run (open -n -a "App" or code -n — more reliable than Cmd+Shift+N)
  split_editor:     1,   // App Shortcut: split_editor (Cmd+\ — editors)
  send_message:     1,   // App Shortcut: send_message (Enter/Return — chat apps)
  new_chat:         1,   // App Shortcut: new_chat (Cmd+Shift+L — some apps)
  clear_chat:       1,   // App Shortcut: clear_chat (Cmd+K — chat apps)
  regenerate_response: 1, // App Shortcut: regenerate_response (Cmd+R — AI apps)

  // Editing operations (system-wide keyboard shortcuts)
  select_all:       1,   // Cmd+A — works in all text fields / document views
  highlight_all_text: 1, // alias for select_all
  copy:             1,   // Cmd+C — works when text is selected
  paste:            1,   // Cmd+V — works in all text fields
  cut:              1,   // Cmd+X — works when text is selected
  undo:             1,   // Cmd+Z — works in most apps
  redo:             1,   // Cmd+Shift+Z — works in most apps
  find:             1,   // Cmd+F — universalFind, works in most apps
  find_replace:     1,   // Option+Cmd+F — find and replace (editors)
  toggle_comment:   1,   // Cmd+/ — comment/uncomment (editors)
  format_document:  1,   // Shift+Option+F — format/beautify code (editors)

  // Navigation
  goto_line:        6,   // shell.run: code -g <file:line> (falls back to tier 1 Ctrl+G if no file path)
  goto_definition:  1,   // F12 — go to definition (editors)
  goto_symbol:      1,   // Cmd+Shift+O — go to symbol (editors)
  back:             1,   // Cmd+[ / Alt+Left — navigate back
  forward:          1,   // Cmd+] / Alt+Right — navigate forward
  next_tab:         1,   // Ctrl+Tab — next tab
  previous_tab:     1,   // Ctrl+Shift+Tab — previous tab

  // View
  zoom_in:          1,   // Cmd+=
  zoom_out:         1,   // Cmd+-
  reset_zoom:       1,   // Cmd+0
  toggle_sidebar:   1,   // Cmd+B (VS Code)
  toggle_terminal:  1,   // Ctrl+` (VS Code)
  toggle_fullscreen: 1,  // Ctrl+Cmd+F

  // Code-specific
  fold:             1,   // Option+Cmd+[
  unfold:           1,   // Option+Cmd+]
  rename_symbol:    1,   // F2
  quick_fix:        1,   // Cmd+. (VS Code)
  refactor:         1,   // Ctrl+Shift+R / Cmd+Shift+R

  // App-specific
  run:              1,   // F5 / Ctrl+Enter
  build:            1,   // Cmd+Shift+B (VS Code)
  debug:            1,   // F5 (VS Code with debug config)
  test:             1,   // Cmd+Shift+T (some editors)
  refresh:          1,   // Cmd+R

  // Typing / input
  type_value:       2,   // Just-type
  ask_question:     1,   // focus AI shortcut, then type (compound)

  // Navigation (global keys, not Cmd+ shortcuts)
  press_enter:      3,   // Global Shortcut
  press_tab:        3,   // Global Shortcut
  press_escape:     3,   // Global Shortcut
  press_arrow:      3,   // Global Shortcut

  // Monitoring
  monitor_response: 5,   // Monitoring

  // Terminal
  done:             0,
};

// ── File path resolution ─────────────────────────────────────────────────────
// Resolves a filename (basename or path) to an absolute path. If the filename
// is just a basename (e.g. "instruction.runner.cjs"), searches the project tree.

const _pathSearchCache = new Map();

function _resolveFilePath(filename) {
  if (!filename) return null;
  const path = require('path');
  const fs = require('fs');

  // Absolute path — use as-is
  if (path.isAbsolute(filename) && fs.existsSync(filename)) {
    return filename;
  }

  // Relative path — resolve against cwd
  const resolved = path.resolve(filename);
  if (fs.existsSync(resolved)) {
    return resolved;
  }

  // Basename — search cache first, then project tree
  if (_pathSearchCache.has(filename)) {
    return _pathSearchCache.get(filename);
  }

  const { execSync } = require('child_process');
  const base = filename.replace(/\.[a-zA-Z0-9]+$/, '');
  try {
    // Search common project roots for the file by basename (with extension wildcard).
    // Use -maxdepth to avoid timeouts on large directory trees.
    const searchRoots = [
      { root: process.cwd(), maxdepth: 6 },
      { root: path.join(os.homedir(), 'Desktop', 'projects'), maxdepth: 5 },
      { root: path.join(os.homedir(), 'Desktop'), maxdepth: 3 },
    ];
    let candidates = [];
    for (const { root, maxdepth } of searchRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const out = execSync(
          `find "${root}" -maxdepth ${maxdepth} \\( -name "${filename}" -o -name "${base}.*" \\) -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" 2>/dev/null`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();
        if (out) candidates = candidates.concat(out.split('\n').filter(Boolean));
      } catch (_) { /* ignore find errors */ }
      if (candidates.length > 0) break; // Stop after first root with matches
    }

    if (candidates.length === 1) {
      _pathSearchCache.set(filename, candidates[0]);
      return candidates[0];
    }

    if (candidates.length > 1) {
      // Disambiguate: prefer current project, then shortest path, then most recently modified
      const scored = candidates.map(p => {
        let mtime = 0;
        try { mtime = fs.statSync(p).mtimeMs; } catch (_) {}
        return { path: p, mtime, depth: p.split('/').length, inCwd: p.startsWith(process.cwd()) ? 1 : 0 };
      });
      scored.sort((a, b) => (b.inCwd - a.inCwd) || (a.depth - b.depth) || (b.mtime - a.mtime));
      const best = scored[0].path;
      logger.info(`[app.runner] _resolveFilePath: disambiguated "${filename}" to "${best}" (${candidates.length} candidates)`);
      _pathSearchCache.set(filename, best);
      return best;
    }
  } catch (_) { /* ignore */ }

  // No match found — return null so the caller can fail fast and ask for clarification
  logger.warn(`[app.runner] _resolveFilePath: no file found for "${filename}"`);
  return null;
}

// ── Open file/folder/document via shell.run ──────────────────────────────────
// Uses `open -a "<App>" "<path>"` on macOS, `start` on Windows, `xdg-open` on Linux.
// More reliable than quick-open shortcuts (Cmd+P) because it doesn't depend on
// the app's quick-open index or shortcut bindings.

async function _openFileWithShell(appName, filename) {
  const { shellRun } = require('./shell.run.cjs');

  // Known placeholder filenames that should never be treated as real file paths.
  // These indicate the goal asked for a "new file" but the flow incorrectly
  // planned an open_file step. Open the app itself instead of failing.
  const _PLACEHOLDER_FILENAMES = /^(new[_\s-]?file|new[_\s-]?document|untitled|blank[_\s]?file|empty[_\s]?file|a new file|undefined)$/i;
  if (filename && _PLACEHOLDER_FILENAMES.test(String(filename).trim())) {
    logger.warn(`[app.runner] _openFileWithShell: placeholder filename "${filename}" detected — opening app instead`);
    filename = null;
  }

  // No filename supplied → just open/focus the app itself (e.g. "open -a Slack").
  // This handles app-flow steps like `open -a 'Slack' via shell.run` that have no
  // file target, instead of crashing on a file named "undefined".
  if (!filename) {
    let cmd, argv;
    if (process.platform === 'win32') {
      cmd = 'start';
      argv = ['""', appName];
    } else if (process.platform === 'linux') {
      cmd = 'xdg-open';
      argv = [appName];
    } else {
      // macOS
      cmd = 'open';
      argv = ['-a', appName];
    }
    logger.info(`[app.runner] _openFileWithShell: ${cmd} ${argv.join(' ')} (no file)`);
    try {
      const result = await shellRun({ cmd, argv, timeoutMs: 10000 });
      if (!result.ok) {
        return { ok: false, error: `Could not open ${appName}: ${result.error || result.stderr || 'unknown error'}` };
      }
      await _sleep(1500);
      logger.info(`[app.runner] _openFileWithShell: opened/focused ${appName} (no file)`);
      return { ok: true, opened: null };
    } catch (err) {
      return { ok: false, error: `_openFileWithShell failed: ${err.message}` };
    }
  }

  const resolved = _resolveFilePath(filename);
  if (!resolved) {
    return { ok: false, error: `Could not locate a file named "${filename}". Please provide the exact path or a file with a known extension.` };
  }

  let cmd, argv;
  if (process.platform === 'win32') {
    cmd = 'start';
    argv = ['""', appName, resolved];
  } else if (process.platform === 'linux') {
    cmd = 'xdg-open';
    argv = [resolved];
  } else {
    // macOS
    cmd = 'open';
    argv = ['-a', appName, resolved];
  }

  logger.info(`[app.runner] _openFileWithShell: ${cmd} ${argv.join(' ')}`);
  try {
    const result = await shellRun({ cmd, argv, timeoutMs: 10000 });
    if (!result.ok) {
      return { ok: false, error: `Could not open "${resolved}" in ${appName}: ${result.error || result.stderr || 'unknown error'}` };
    }
    // Wait for the app to finish loading the file
    await _sleep(1500);
    logger.info(`[app.runner] _openFileWithShell: opened "${resolved}" in ${appName}`);
    return { ok: true, opened: resolved };
  } catch (err) {
    return { ok: false, error: `_openFileWithShell failed: ${err.message}` };
  }
}

// ── Infer file extension from content ─────────────────────────────────────
// Analyzes the content to be typed to guess the language/extension so the
// temp file gets proper syntax highlighting in the editor.

function _inferFileExtension(content) {
  if (!content || typeof content !== 'string') return 'txt';
  // HTML before TypeScript (HTML tags like <html> would match <\w+> in TS check)
  if (/<!DOCTYPE|<html|<head|<body/i.test(content)) return 'html';
  // TypeScript before JavaScript (TS is a superset)
  if (/\binterface\s+\w+|\btype\s+\w+\s*=|:\s*(string|number|boolean|void)\b/.test(content)) return 'ts';
  if (/console\.log|require\(|module\.exports|import\s+.*from\s+['"]|export\s+default|=>\s*[{(]/.test(content)) return 'js';
  if (/^\s*def\s+\w+|^\s*import\s+\w+|^\s*from\s+\w+\s+import|print\s*\(|if\s+__name__\s*==/.test(content)) return 'py';
  if (/public\s+class|System\.out\.println|import\s+java\./.test(content)) return 'java';
  if (/package\s+main|func\s+\w+|import\s+\(/.test(content)) return 'go';
  if (/#include\s+[<"].*\.h[>"]/.test(content) && /\bstd::|namespace\s+|class\s+\w+/.test(content)) return 'cpp';
  if (/#include\s+[<"]|int\s+main\s*\(/.test(content)) return 'c';
  if (/@media|@import|^\s*\.\w+\s*\{|^\s*#\w+\s*\{/.test(content)) return 'css';
  if (/^\s*[\[{]/.test(content) && /"\w+"\s*:/.test(content)) return 'json';
  if (/^#!\/bin\/(bash|sh)|^echo\s|^export\s/.test(content)) return 'sh';
  if (/^\s*def\s+\w+|puts\s+|require\s+['"]/.test(content)) return 'rb';
  if (/\bfn\s+main\s*\(|\buse\s+std::|pub\s+fn\s+/.test(content)) return 'rs';
  return 'txt';
}

// ── Create a new file via shell.run ────────────────────────────────────────
// Creates a temp file with the inferred extension, then opens it in the app.
// More reliable than Cmd+N (which can mean "new chat" in some apps).

async function _newFileWithShell(appName, content) {
  const { shellRun } = require('./shell.run.cjs');
  const ext = _inferFileExtension(content);
  const tmpFile = path.join(os.tmpdir(), `thinkdrop-untitled-${Date.now()}.${ext}`);

  // Create the temp file
  const touchResult = await shellRun({ cmd: 'bash', argv: ['-c', `touch "${tmpFile}"`], timeoutMs: 5000 });
  if (!touchResult.ok) {
    return { ok: false, error: `Could not create temp file: ${touchResult.error || touchResult.stderr}` };
  }

  // Open it in the app (reuses _openFileWithShell)
  const openResult = await _openFileWithShell(appName, tmpFile);
  if (!openResult.ok) {
    return { ok: false, error: `Could not open temp file: ${openResult.error}` };
  }

  logger.info(`[app.runner] _newFileWithShell: created and opened ${tmpFile}`);
  return { ok: true, opened: tmpFile };
}

// ── Open a new window via shell.run ────────────────────────────────────────
// Tries the app's CLI first (e.g. code -n), falls back to `open -n -a "App"`.
// More reliable than Cmd+Shift+N (ambiguous in some apps).

async function _newWindowWithShell(appName) {
  const { shellRun } = require('./shell.run.cjs');
  const _APP_CLI = {
    'Visual Studio Code': { cmd: 'code', argv: ['-n'] },
    'Code':              { cmd: 'code', argv: ['-n'] },
    'Cursor':            { cmd: 'cursor', argv: ['-n'] },
    'Windsurf':          { cmd: 'windsurf', argv: ['-n'] },
  };
  const cli = _APP_CLI[appName];
  if (cli) {
    try {
      const r = await shellRun({ cmd: cli.cmd, argv: cli.argv, timeoutMs: 10000 });
      if (r.ok) {
        await _sleep(1500);
        logger.info(`[app.runner] _newWindowWithShell: ${cli.cmd} ${cli.argv.join(' ')}`);
        return { ok: true };
      }
    } catch (_) { /* fall through to open -n */ }
  }
  // Fallback: open -n -a "App"
  const r = await shellRun({ cmd: 'open', argv: ['-n', '-a', appName], timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, error: `Could not open new window: ${r.error || r.stderr || 'unknown error'}` };
  }
  await _sleep(1500);
  logger.info(`[app.runner] _newWindowWithShell: open -n -a "${appName}"`);
  return { ok: true };
}

// ── Close window / quit app via shell.run ──────────────────────────────────
// Uses osascript to quit the app. More reliable than Cmd+W (which closes a
// tab, not a window) or Cmd+Q (which some apps intercept).

async function _closeWindowWithShell(appName) {
  const { shellRun } = require('./shell.run.cjs');
  const r = await shellRun({ cmd: 'osascript', argv: ['-e', `quit app "${appName}"`], timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, error: `Could not quit ${appName}: ${r.error || r.stderr || 'unknown error'}` };
  }
  logger.info(`[app.runner] _closeWindowWithShell: quit app "${appName}"`);
  return { ok: true };
}

// ── Go to line via shell.run ───────────────────────────────────────────────
// Uses `code -g <file:line>` for editors that support it.
// Returns null if not supported (caller falls back to tier 1 Ctrl+G).

async function _gotoLineWithShell(appName, filePath, lineNumber) {
  const { shellRun } = require('./shell.run.cjs');
  const _SUPPORTED = {
    'Visual Studio Code': 'code',
    'Code': 'code',
    'Cursor': 'cursor',
    'Windsurf': 'windsurf',
  };
  const cli = _SUPPORTED[appName];
  if (!cli || !filePath || !lineNumber) return null; // not supported → fall back to tier 1
  const r = await shellRun({ cmd: cli, argv: ['-g', `${filePath}:${lineNumber}`], timeoutMs: 10000 });
  if (!r.ok) {
    return { ok: false, error: `goto line failed: ${r.error || r.stderr || 'unknown error'}` };
  }
  await _sleep(1000);
  logger.info(`[app.runner] _gotoLineWithShell: ${cli} -g ${filePath}:${lineNumber}`);
  return { ok: true };
}

// ── 1. App-Flow Pre-computation (V2 — no hardcoded examples) ────────────────
// LLM synthesizes the tier sequence from the actual shortcut list + sub-goals.
// No app-specific examples — the LLM must reason about the sequence itself.

async function _computeAppFlowV2(goal, appCategory, shortcuts, appName, signature) {
  const shortcutLabels = (shortcuts || [])
    .map(s => `   ${s.action}: ${s.shortcut}${s.context ? ` (${s.context})` : ''}`)
    .join('\n') || '   (none discovered)';

  const subGoalsList = (signature?.subGoals || [])
    .map((s, i) => `${i + 1}. ${s}`)
    .join('\n') || '   (none extracted)';

  const entitiesStr = JSON.stringify(signature?.entities || {});

  const systemPrompt = `You plan a desktop app automation sequence.
Given the app's available shortcuts and the goal's sub-goals, produce the step-by-step tier sequence.

Available tiers:
1 = App Shortcuts (press an app-specific keyboard shortcut)
2 = Just-type (type a value into the focused field — sub-modes: plain, commands, edit, search, list-item, filter)
3 = Global Shortcuts (press global keys — Tab, Enter, Escape, Arrow keys, Shift+Tab)
4 = Search Text (use LiteParser OCR to find text on screen, then click/navigate to it)
5 = Monitoring (wait for a long-running operation to complete — AI response, build, upload, form submission)
6 = shell.run (open/create files, new window, close window, goto line — more reliable than shortcuts)
0 = Done (goal achieved)

Sub-goal → tier mapping (use this to decide the tier for each sub-goal):
- open_file / open_folder / open_document → tier 6 (shell.run: open -a "<App>" "<path>")
- new_file → tier 6 (shell.run: create temp file + open in app — MORE RELIABLE than Cmd+N, which can mean "new chat" in some apps)
- new_window → tier 6 (shell.run: open -n -a "<App>" or code -n — MORE RELIABLE than Cmd+Shift+N)
- close_window → tier 6 (shell.run: osascript quit app — MORE RELIABLE than Cmd+W)
- goto_line → tier 6 (shell.run: code -g <file:line> when file path is known; falls back to tier 1 if file path unknown)
- save / save_as → tier 1 (press the save/save_as shortcut — no shell.run equivalent)
- close_tab → tier 1 (press the matching shortcut)
- focus_ai / quick_open / new_tab / new_message / quick_switcher → tier 1 (use the matching shortcut)
- select_all / copy / paste / cut / undo / redo / find → tier 1 (use the matching shortcut)
- toggle_comment / format_document / find_replace → tier 1 (use the matching shortcut)
- goto_definition / goto_symbol → tier 1 (use the matching shortcut, then tier 2 to type the symbol)
- next_tab / previous_tab / back / forward → tier 1 (use the matching shortcut)
- zoom_in / zoom_out / toggle_sidebar / toggle_terminal / toggle_fullscreen → tier 1 (use the matching shortcut)
- fold / unfold / rename_symbol / quick_fix / refactor → tier 1 (use the matching shortcut)
- new_chat / clear_chat / send_message / regenerate_response → tier 1 (use the matching shortcut)
- split_editor → tier 1 (use the matching shortcut)
- run / build / debug / test / refresh → tier 1 (use the matching shortcut)
- print → tier 1 (use the matching shortcut)
- type_value → tier 2 (type the value into the focused field)
- ask_question → tier 1 (focus_ai shortcut), then tier 2 (type the question)
- press_enter / press_tab / press_escape / press_arrow → tier 3
- monitor_response → tier 5
- done → tier 0

Mapping rules:
- For open_file/open_folder/open_document → tier 6, action = "open -a '<App>' '<filename>' via shell.run"
- For new_file → tier 6, action = "new file via shell.run"
- For new_window → tier 6, action = "new window via shell.run"
- For close_window → tier 6, action = "close window via shell.run"
- For goto_line (file path known) → tier 6, action = "goto line <N> via shell.run"
- For goto_line (file path unknown) → tier 1, action = "press <goto_line shortcut> (go to line)", then tier 2 action = "type '<lineNumber>' (type-plain)"
- If a sub-goal has a matching shortcut → tier 1, action = "press <shortcut> (<action>)"
- If a sub-goal needs typing a value → tier 2, action = "type '<value>' (<sub-mode>)"
  Sub-modes: type-plain (chat/simple), type-commands (/slash), type-edit (long-form/code), type-search (@mentions/pickers), type-list-item (todos), type-filter (quick-open file picker)
- If a sub-goal needs a global key (Enter, Tab, Escape) → tier 3, action = "press <key>"
- If a sub-goal needs monitoring a long-running op → tier 5, action = "monitor until <condition>"
- End with tier 0, action = "done"

CRITICAL RULES:
- Tier 6 (shell.run) is the PRIMARY way to open/create files, open new windows, close windows, and goto lines. Prefer shell.run over shortcuts whenever a reliable shell command exists.
- new_file uses tier 6 (shell.run: create temp file + open), NOT tier 1 (Cmd+N). Cmd+N is ambiguous — it can open a new chat in some apps.
- new_window uses tier 6 (shell.run), NOT tier 1 (Cmd+Shift+N). Cmd+Shift+N is ambiguous in some apps.
- close_window uses tier 6 (shell.run: quit app), NOT tier 1 (Cmd+W).
- goto_line uses tier 6 (shell.run: code -g) when the file path is known. Falls back to tier 1 (Ctrl+G) when the file path is unknown.
- save/save_as remains tier 1 (Cmd+S) — no reliable shell.run equivalent for in-app saving.
- If the goal is to create a new file and type content, the flow should be: new_file (tier 6) → type_value (tier 2) → save (tier 1) → done (tier 0).
- Tier 1 (App Shortcuts) is the PRIMARY tier for in-app actions (80-90% of use). Prefer it when a shortcut can accomplish the sub-goal.
- Tier 2 (Just-type) is for typing into the currently focused field. Use AFTER a tier 1 shortcut has focused the field.
- Tier 3 (Global Shortcuts) is a fallback for navigation (Enter to confirm, Escape to close, Tab between fields).
- Tier 5 (Monitoring) is for waiting on long-running operations. Use AFTER an action that triggers a long-running process.
- CRITICAL: if the sub-goals contain "ask_question" or the goal is to ask/chat/explain, ALWAYS include a "monitor_response" step (tier 5) before "done". A question always implies waiting for a response.
- Use the entities from the goal signature to fill in concrete values (filenames, questions, content, line numbers, etc.).
- Be specific about what action each tier should take. For tier 2, include the sub-mode in parentheses.
- Output ONLY the JSON array, no other text.

Output format: JSON array of steps, each with:
- subGoal: canonical sub-goal name from the sub-goals list above (e.g. "new_file", "open_file", "type_value", "save", "goto_line", "done")
- state: expected app state description
- tier: tier number (0, 1, 2, 3, 4, 5, or 6)
- action: human-readable description of what the tier should do

CRITICAL: Every step MUST include the "subGoal" field set to the exact canonical sub-goal it corresponds to.`;

  const userPrompt = `Goal: ${goal}
App: ${appName || 'unknown'}
Category: ${appCategory || 'unknown'}
Entities: ${entitiesStr}

Sub-goals to achieve:
${subGoalsList}

Available shortcuts:
${shortcutLabels}`;

  try {
    const response = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 800, temperature: 0, responseTimeoutMs: 15000 });

    if (!response) return null;
    const flow = parseLlmJson(response, logger, '_computeAppFlowV2');
    if (Array.isArray(flow) && flow.length > 0) {
      logger.info(`[app.runner] _computeAppFlowV2: planned ${flow.length} steps for "${String(goal).slice(0, 60)}" (type=${signature?.type || 'unknown'})`);
      return flow;
    }
    logger.warn(`[app.runner] _computeAppFlowV2: no valid flow parsed from LLM response`);
    return null;
  } catch (e) {
    logger.warn(`[app.runner] _computeAppFlowV2 failed: ${e.message}`);
    return null;
  }
}

// ── On-Demand Web Research for Missing Shortcuts ────────────────────────────
// When a sub-goal has no matching shortcut in the app's shortcut list, research
// it via web.agent.actionGetTutorialSteps and extract a shortcut from the results.

async function _researchMissingShortcut(appName, subGoal, category) {
  const webAgent = require('./web.agent.cjs');

  // Map sub-goal names to "how to" queries
  const queryTemplates = {
    open_file: `How to open a file in ${appName} macOS`,
    focus_ai: `How to focus AI assistant in ${appName}`,
    quick_open: `How to quick open file in ${appName} macOS`,
    save: `How to save in ${appName} macOS`,
    find: `How to find or search in ${appName} macOS`,
    copy: `How to copy in ${appName} macOS`,
    paste: `How to paste in ${appName} macOS`,
    select_all: `How to select all in ${appName} macOS`,
  };
  const query = queryTemplates[subGoal] || `How to ${subGoal.replace(/_/g, ' ')} in ${appName} macOS`;

  logger.info(`[app.runner] _researchMissingShortcut: researching "${subGoal}" for ${appName} — query: "${query}"`);
  try {
    const result = await webAgent.actionGetTutorialSteps({ query, maxResults: 3 });
    if (!result || !result.ok || !result.mergedSteps || result.mergedSteps.length === 0) {
      logger.warn(`[app.runner] _researchMissingShortcut: no tutorial steps found for "${subGoal}"`);
      return null;
    }

    // Extract a shortcut from the tutorial steps via LLM
    const stepsText = result.mergedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const extractPrompt = `Extract a keyboard shortcut for the action "${subGoal.replace(/_/g, ' ')}" in ${appName} from these tutorial steps.
Return JSON only:
{ "action": "${subGoal}", "shortcut": "Cmd+P", "context": "web-research" }
If no shortcut is found, return: { "action": "${subGoal}", "shortcut": null, "context": "web-research" }

Tutorial steps:
${stepsText.slice(0, 4000)}`;

    const llmResult = await skillLlmAsk(extractPrompt);
    if (!llmResult) return null;
    const parsed = parseLlmJson(llmResult, logger, '_researchMissingShortcut');
    if (parsed && parsed.shortcut) {
      logger.info(`[app.runner] _researchMissingShortcut: found shortcut "${parsed.shortcut}" for "${subGoal}" in ${appName}`);
      return { action: subGoal, shortcut: parsed.shortcut, context: 'web-research' };
    }
    logger.warn(`[app.runner] _researchMissingShortcut: no shortcut extracted for "${subGoal}"`);
    return null;
  } catch (e) {
    logger.warn(`[app.runner] _researchMissingShortcut failed for "${subGoal}": ${e.message}`);
    return null;
  }
}

// ── Sub-Goal Taxonomy ────────────────────────────────────────────────────────
// Single source of truth for all canonical sub-goals. Each entry defines:
//   tier:           which execution tier handles this sub-goal
//   shortcutAction: the shortcut action name (for tier 1 sub-goals) or null
//   phrasings:      regex patterns that match user phrasings for this sub-goal
//
// Used by:
//   - _extractGoalSignature prompt (lists valid sub-goals)
//   - _subGoalToShortcutAction (maps sub-goal → shortcut action name)
//   - _subGoalsWithoutShortcuts (derived: all tier !== 1 entries)
//   - _computeAppFlowV2 prompt (sub-goal → tier mapping)
//   - _preClassifyGoal (deterministic pre-check before LLM)

const APP_SUBGOAL_TAXONOMY = {
  // ── File operations ──
  new_file: {
    tier: 6, shortcutAction: null,  // shell.run: create temp file + open in app (more reliable than Cmd+N)
    phrasings: [
      /\b(?:open|create|make|add|start)\s+(?:a\s+)?(?:new|blank|empty)\s+(?:file|document|page)\b/i,
      /\b(?:new|blank|empty)\s+(?:file|document|page)\b/i,
    ],
  },
  open_file: {
    tier: 6, shortcutAction: null,
    phrasings: [
      /\bopen\s+(?:the\s+)?(?:file|document)\b/i,
      /\bopen\s+(?:a\s+)?(?:file|document)\s+(?!new|blank|empty)\b/i,
    ],
  },
  open_folder: {
    tier: 6, shortcutAction: null,
    phrasings: [/\bopen\s+(?:the\s+)?(?:folder|directory)\b/i],
  },
  open_document: {
    tier: 6, shortcutAction: null,
    phrasings: [/\bopen\s+(?:the\s+)?document\b/i],
  },
  save: {
    tier: 1, shortcutAction: 'save',
    phrasings: [/\bsave\b/i, /\bsave\s+(?:it|the\s+file|file)\b/i],
  },
  save_as: {
    tier: 1, shortcutAction: 'save_as',
    phrasings: [/\bsave\s+as\b/i, /\bsave\s+with\s+name\b/i],
  },
  close_tab: {
    tier: 1, shortcutAction: 'close_tab',
    phrasings: [/\bclose\s+(?:tab|file|this)\b/i],
  },
  close_window: {
    tier: 6, shortcutAction: null,  // shell.run: osascript quit app (more reliable than Cmd+W)
    phrasings: [/\bclose\s+(?:window|app|application)\b/i, /\bquit\b/i],
  },
  print: {
    tier: 1, shortcutAction: 'print',
    phrasings: [/\bprint\b/i],
  },

  // ── Edit operations ──
  undo: {
    tier: 1, shortcutAction: 'undo',
    phrasings: [/\bundo\b/i, /\brevert\b/i],
  },
  redo: {
    tier: 1, shortcutAction: 'redo',
    phrasings: [/\bredo\b/i, /\brepeat\b/i],
  },
  cut: {
    tier: 1, shortcutAction: 'cut',
    phrasings: [/\bcut\b/i],
  },
  copy: {
    tier: 1, shortcutAction: 'copy',
    phrasings: [/\bcopy\b/i],
  },
  paste: {
    tier: 1, shortcutAction: 'paste',
    phrasings: [/\bpaste\b/i],
  },
  select_all: {
    tier: 1, shortcutAction: 'select_all',
    phrasings: [/\bselect\s+all\b/i, /\bselect\s+everything\b/i, /\bhighlight\s+all\b/i],
  },
  toggle_comment: {
    tier: 1, shortcutAction: 'toggle_comment',
    phrasings: [/\b(?:comment|uncomment|toggle\s+comment)\b/i, /\bcomment\s+out\b/i],
  },
  format_document: {
    tier: 1, shortcutAction: 'format_document',
    phrasings: [/\b(?:format|beautify|prettify)\b/i, /\bformat\s+(?:code|document)\b/i],
  },
  find: {
    tier: 1, shortcutAction: 'find',
    phrasings: [/\bfind\b/i, /\bsearch\b/i, /\bsearch\s+for\b/i, /\bfind\s+text\b/i],
  },
  find_replace: {
    tier: 1, shortcutAction: 'find_replace',
    phrasings: [/\b(?:find\s+and\s+replace|replace|replace\s+all|substitute)\b/i],
  },

  // ── Navigation ──
  goto_line: {
    tier: 6, shortcutAction: null,  // shell.run: code -g <file:line> (falls back to tier 1 Ctrl+G if no file path)
    phrasings: [/\b(?:goto|go\s+to|jump\s+to)\s+line\b/i, /\bline\s+\d+\b/i],
  },
  goto_definition: {
    tier: 1, shortcutAction: 'goto_definition',
    phrasings: [/\b(?:goto|go\s+to|jump\s+to)\s+definition\b/i],
  },
  goto_symbol: {
    tier: 1, shortcutAction: 'goto_symbol',
    phrasings: [/\b(?:goto|go\s+to|jump\s+to)\s+(?:symbol|function)\b/i],
  },
  quick_open: {
    tier: 1, shortcutAction: 'quick_open',
    phrasings: [/\bquick\s+open\b/i, /\bcommand\s+palette\b/i, /\bgo\s+to\s+file\b/i],
  },
  back: {
    tier: 1, shortcutAction: 'back',
    phrasings: [/\bgo\s+back\b/i, /\bnavigate\s+back\b/i, /\bprevious\s+location\b/i],
  },
  forward: {
    tier: 1, shortcutAction: 'forward',
    phrasings: [/\bgo\s+forward\b/i, /\bnavigate\s+forward\b/i, /\bnext\s+location\b/i],
  },
  next_tab: {
    tier: 1, shortcutAction: 'next_tab',
    phrasings: [/\bnext\s+tab\b/i, /\bswitch\s+to\s+next\s+tab\b/i],
  },
  previous_tab: {
    tier: 1, shortcutAction: 'previous_tab',
    phrasings: [/\bprevious\s+tab\b/i, /\bswitch\s+to\s+previous\s+tab\b/i],
  },

  // ── View ──
  zoom_in: {
    tier: 1, shortcutAction: 'zoom_in',
    phrasings: [/\bzoom\s+in\b/i, /\bmake\s+bigger\b/i],
  },
  zoom_out: {
    tier: 1, shortcutAction: 'zoom_out',
    phrasings: [/\bzoom\s+out\b/i, /\bmake\s+smaller\b/i],
  },
  toggle_sidebar: {
    tier: 1, shortcutAction: 'toggle_sidebar',
    phrasings: [/\btoggle\s+sidebar\b/i, /\b(?:show|hide)\s+sidebar\b/i],
  },
  toggle_terminal: {
    tier: 1, shortcutAction: 'toggle_terminal',
    phrasings: [/\btoggle\s+terminal\b/i, /\b(?:show|hide|open)\s+terminal\b/i],
  },
  toggle_fullscreen: {
    tier: 1, shortcutAction: 'toggle_fullscreen',
    phrasings: [/\bfullscreen\b/i, /\bfull\s+screen\b/i, /\btoggle\s+fullscreen\b/i],
  },

  // ── Code-specific (editor category) ──
  fold: {
    tier: 1, shortcutAction: 'fold',
    phrasings: [/\bfold\b/i, /\bcollapse\b/i],
  },
  unfold: {
    tier: 1, shortcutAction: 'unfold',
    phrasings: [/\bunfold\b/i, /\bexpand\b/i],
  },
  rename_symbol: {
    tier: 1, shortcutAction: 'rename_symbol',
    phrasings: [/\brename\s+(?:symbol|variable|function)\b/i],
  },
  quick_fix: {
    tier: 1, shortcutAction: 'quick_fix',
    phrasings: [/\bquick\s+fix\b/i, /\bshow\s+fixes\b/i, /\bcode\s+action\b/i],
  },
  refactor: {
    tier: 1, shortcutAction: 'refactor',
    phrasings: [/\brefactor\b/i, /\bextract\s+(?:method|variable)\b/i],
  },

  // ── AI / Chat ──
  focus_ai: {
    tier: 1, shortcutAction: 'focus_ai',
    phrasings: [/\bfocus\s+ai\b/i, /\bopen\s+ai\b/i, /\bask\s+ai\b/i, /\bai\s+assistant\b/i, /\bcopilot\b/i],
  },
  ask_question: {
    tier: 1, shortcutAction: 'focus_ai',  // ask_question uses focus_ai shortcut
    phrasings: [/\bask\b/i, /\bquestion\b/i, /\bexplain\b/i, /\breview\b/i, /\banalyze\b/i, /\bwhat\s+does\b/i, /\bhow\s+does\b/i],
  },
  new_chat: {
    tier: 1, shortcutAction: 'new_chat',
    phrasings: [/\bnew\s+chat\b/i, /\bnew\s+conversation\b/i, /\bclear\s+chat\b/i],
  },
  clear_chat: {
    tier: 1, shortcutAction: 'clear_chat',
    phrasings: [/\bclear\s+(?:chat|conversation)\b/i, /\breset\s+chat\b/i],
  },
  send_message: {
    tier: 1, shortcutAction: 'send_message',
    phrasings: [/\bsend\s+message\b/i, /\bsubmit\b/i],
  },
  regenerate_response: {
    tier: 1, shortcutAction: 'regenerate_response',
    phrasings: [/\bregenerate\b/i, /\btry\s+again\b/i, /\bretry\s+ai\b/i],
  },
  monitor_response: {
    tier: 5, shortcutAction: null,
    phrasings: [/\bwait\s+for\s+response\b/i, /\bwait\s+for\s+ai\b/i, /\bmonitor\s+response\b/i],
  },

  // ── Chat-specific shortcuts (kept for backwards compatibility) ──
  new_message: {
    tier: 1, shortcutAction: 'new_message',
    phrasings: [/\bnew\s+message\b/i, /\bcompose\s+new\s+message\b/i],
  },
  quick_switcher: {
    tier: 1, shortcutAction: 'quick_switcher',
    phrasings: [/\bquick\s+switcher\b/i, /\bswitch\s+channel\b/i, /\bswitch\s+conversation\b/i],
  },
  focus_input: {
    tier: 1, shortcutAction: 'focus_input',
    phrasings: [/\bfocus\s+input\b/i, /\bfocus\s+message\b/i, /\bfocus\s+compose\b/i],
  },
  open_file_dialog: {
    tier: 1, shortcutAction: 'open_file_dialog',
    phrasings: [/\bopen\s+file\s+dialog\b/i, /\bopen\s+file\s+picker\b/i],
  },

  // ── Window / Tab management ──
  new_window: {
    tier: 6, shortcutAction: null,  // shell.run: open -n -a "App" or code -n (more reliable than Cmd+Shift+N)
    phrasings: [/\bnew\s+window\b/i, /\bopen\s+new\s+window\b/i],
  },
  new_tab: {
    tier: 1, shortcutAction: 'new_tab',
    phrasings: [/\bnew\s+tab\b/i, /\bopen\s+new\s+tab\b/i],
  },
  split_editor: {
    tier: 1, shortcutAction: 'split_editor',
    phrasings: [/\bsplit\s+(?:editor|view|pane)\b/i],
  },

  // ── Text input ──
  type_value: {
    tier: 2, shortcutAction: null,
    phrasings: [/\b(?:type|enter|write|input|fill\s+in)\b/i],
  },
  press_enter: {
    tier: 3, shortcutAction: null,
    phrasings: [/\bpress\s+enter\b/i, /\bhit\s+enter\b/i, /\bconfirm\b/i],
  },
  press_tab: {
    tier: 3, shortcutAction: null,
    phrasings: [/\bpress\s+tab\b/i, /\bnext\s+field\b/i, /\btab\b/i],
  },
  press_escape: {
    tier: 3, shortcutAction: null,
    phrasings: [/\bpress\s+escape\b/i, /\bcancel\b/i, /\bdismiss\b/i, /\bescape\b/i],
  },
  press_arrow: {
    tier: 3, shortcutAction: null,
    phrasings: [/\barrow\s+(?:up|down|left|right)\b/i],
  },

  // ── App-specific ──
  run: {
    tier: 1, shortcutAction: 'run',
    phrasings: [/\brun\s+(?:code|program)\b/i, /\bexecute\b/i, /\brun\b/i],
  },
  build: {
    tier: 1, shortcutAction: 'build',
    phrasings: [/\bbuild\b/i, /\bcompile\b/i, /\bmake\b/i],
  },
  debug: {
    tier: 1, shortcutAction: 'debug',
    phrasings: [/\bdebug\b/i, /\bstart\s+debugging\b/i, /\bdebugger\b/i],
  },
  test: {
    tier: 1, shortcutAction: 'test',
    phrasings: [/\brun\s+tests\b/i, /\btest\b/i, /\brun\s+test\s+suite\b/i],
  },
  refresh: {
    tier: 1, shortcutAction: 'refresh',
    phrasings: [/\brefresh\b/i, /\breload\b/i, /\breload\s+(?:page|window)\b/i],
  },

  // ── Meta ──
  open_app: {
    tier: 0, shortcutAction: null,  // handled by _focusApp before the flow loop
    phrasings: [/\bopen\s+(?:the\s+)?app\b/i],
  },
  done: {
    tier: 0, shortcutAction: null,
    phrasings: [/\bdone\b/i, /\bcomplete\b/i, /\bfinish\b/i],
  },
};

// Derive _subGoalsWithoutShortcuts from the taxonomy (all tier !== 1 entries)
const _subGoalsWithoutShortcuts = new Set(
  Object.entries(APP_SUBGOAL_TAXONOMY)
    .filter(([, entry]) => entry.tier !== 1)
    .map(([name]) => name)
);

// Derive _subGoalToShortcutAction from the taxonomy (all tier 1 entries with shortcutAction)
const _subGoalToShortcutAction = Object.fromEntries(
  Object.entries(APP_SUBGOAL_TAXONOMY)
    .filter(([, entry]) => entry.tier === 1 && entry.shortcutAction)
    .map(([name, entry]) => [name, entry.shortcutAction])
);
// Add aliases for backwards compatibility
_subGoalToShortcutAction.highlight_all_text = 'select_all';

/**
 * Deterministic pre-check: scan the goal text against the taxonomy phrasings.
 * If a clear match is found for a sub-goal that the LLM commonly misclassifies
 * (e.g. "new file" → new_file, not open_file), return the correct sub-goal.
 * This runs BEFORE _extractGoalSignature to catch obvious cases without LLM latency.
 *
 * @param {string} goal - the user's goal text
 * @returns {{ subGoal: string, clearFilename: string|null } | null}
 */
function _preClassifyGoal(goal) {
  if (!goal || typeof goal !== 'string') return null;

  // Check new_file patterns first — this is the most common misclassification.
  // "open a new file" should be new_file, not open_file.
  const _NEW_FILE_PATTERNS = APP_SUBGOAL_TAXONOMY.new_file.phrasings;
  if (_NEW_FILE_PATTERNS.some(re => re.test(goal))) {
    // Check if a specific filename is also mentioned (e.g. "create a new file called test.js")
    // If so, we still use new_file but the LLM can extract the filename for the save step.
    return { subGoal: 'new_file', clearFilename: null };
  }

  // Check other high-priority patterns
  for (const [subGoal, entry] of Object.entries(APP_SUBGOAL_TAXONOMY)) {
    if (subGoal === 'new_file' || subGoal === 'done' || subGoal === 'open_app') continue;
    if (entry.phrasings && entry.phrasings.some(re => re.test(goal))) {
      return { subGoal, clearFilename: null };
    }
  }

  return null;
}

// ── Layer 2: Deterministic sub-goal inference from action text ─────────────
// Used by _validateAndFixFlowSubGoals when the LLM omits or garbles the subGoal
// field. Infers the canonical sub-goal from the action description + tier number.
// Patterns are broader than the taxonomy phrasings because the LLM writes
// action descriptions (not user goal text).

function _inferSubGoalFromAction(action, tier) {
  if (!action) return null;
  const a = action.toLowerCase();
  // Tier 6 actions (shell.run)
  if (tier === 6) {
    if (/\bnew\s+(?:file|doc|document|page)\b|\bcreate\s+(?:a\s+|the\s+)?(?:new\s+)?(?:temp|temporary|blank|empty|untitled)\s+(?:file|doc|document)\b|\bnew_file\b/.test(a)) return 'new_file';
    if (/\bnew\s+window\b|\bnew_window\b/.test(a)) return 'new_window';
    if (/\bclose\s+window\b|\bquit\s+(?:app|application)\b|\bclose_window\b/.test(a)) return 'close_window';
    if (/\b(?:goto|go\s+to)\s+line\b|\bgoto_line\b/.test(a)) return 'goto_line';
    if (/\bopen\s+(?:file|doc|document|folder|directory)\b/.test(a)) return 'open_file';
  }
  // Tier 1 actions (shortcuts)
  if (tier === 1) {
    if (/\bsave\s+as\b/.test(a)) return 'save_as';
    if (/\bsave\b/.test(a)) return 'save';
    if (/\bclose\s+tab\b/.test(a)) return 'close_tab';
    if (/\bnew\s+tab\b/.test(a)) return 'new_tab';
    if (/\bfocus\s+ai\b|\bask\s+ai\b|\bcopilot\b/.test(a)) return 'focus_ai';
    if (/\bquick\s+open\b|\bcommand\s+palette\b/.test(a)) return 'quick_open';
    if (/\bformat\b|\bbeautify\b|\bprettify\b/.test(a)) return 'format_document';
    if (/\bcomment\b|\buncomment\b|\btoggle\s+comment\b/.test(a)) return 'toggle_comment';
    if (/\bfind\s+(?:and\s+)?replace\b|\breplace\b/.test(a)) return 'find_replace';
    if (/\bfind\b|\bsearch\b/.test(a)) return 'find';
    if (/\bcopy\b/.test(a)) return 'copy';
    if (/\bpaste\b/.test(a)) return 'paste';
    if (/\bcut\b/.test(a)) return 'cut';
    if (/\bundo\b/.test(a)) return 'undo';
    if (/\bredo\b/.test(a)) return 'redo';
    if (/\bselect\s+all\b/.test(a)) return 'select_all';
    if (/\bgoto\s+definition\b|\bgo\s+to\s+definition\b/.test(a)) return 'goto_definition';
    if (/\bgoto\s+symbol\b|\bgo\s+to\s+symbol\b/.test(a)) return 'goto_symbol';
    if (/\brename\s+symbol\b/.test(a)) return 'rename_symbol';
    if (/\bquick\s+fix\b|\bcode\s+action\b/.test(a)) return 'quick_fix';
    if (/\btoggle\s+sidebar\b/.test(a)) return 'toggle_sidebar';
    if (/\btoggle\s+terminal\b|\bopen\s+terminal\b/.test(a)) return 'toggle_terminal';
    if (/\bfullscreen\b/.test(a)) return 'toggle_fullscreen';
    if (/\bfold\b|\bcollapse\b/.test(a)) return 'fold';
    if (/\bunfold\b|\bexpand\b/.test(a)) return 'unfold';
    if (/\bsplit\s+(?:editor|view|pane)\b/.test(a)) return 'split_editor';
    if (/\brun\b/.test(a)) return 'run';
    if (/\bbuild\b|\bcompile\b/.test(a)) return 'build';
    if (/\brefresh\b|\breload\b/.test(a)) return 'refresh';
    if (/\bprint\b/.test(a)) return 'print';
    if (/\bnew\s+chat\b|\bnew\s+conversation\b/.test(a)) return 'new_chat';
    if (/\bsend\s+message\b|\bsubmit\b/.test(a)) return 'send_message';
  }
  // Tier 2 actions (just-type)
  if (tier === 2) {
    if (/\btype\b|\benter\b|\bwrite\b|\binput\b|\bfill\s+in\b/.test(a)) return 'type_value';
  }
  // Tier 3 actions (global keys)
  if (tier === 3) {
    if (/\benter\b|\bconfirm\b|\bsubmit\b/.test(a)) return 'press_enter';
    if (/\btab\b/.test(a)) return 'press_tab';
    if (/\bescape\b|\bcancel\b|\bdismiss\b/.test(a)) return 'press_escape';
    if (/\barrow\b/.test(a)) return 'press_arrow';
  }
  // Tier 5 actions (monitoring)
  if (tier === 5) {
    if (/\bmonitor\b|\bwait\s+for\b/.test(a)) return 'monitor_response';
  }
  // Tier 0 (done)
  if (tier === 0) return 'done';
  return null;
}

// ── Layer 3 helper: count non-done steps before a given index ──────────────
// Used for positional cross-reference with signature.subGoals. Done steps
// (tier 0) don't correspond to a sub-goal, so we skip them when counting.

function _countNonDoneStepsBefore(flow, index) {
  let count = 0;
  for (let i = 0; i < index; i++) {
    if (flow[i] && flow[i].tier !== 0) count++;
  }
  return count;
}

// ── Flow validation: ensure every step has a valid subGoal ──────────────────
// Three-layer defense against LLM omitting or garbling the subGoal field:
//   Layer 1: subGoal present and valid → keep it
//   Layer 2: subGoal missing/invalid → infer from action text + tier
//   Layer 3: action inference fails → positional cross-reference with signature.subGoals

function _validateAndFixFlowSubGoals(flow, signature) {
  if (!Array.isArray(flow)) return flow;
  const validSubGoals = new Set(Object.keys(APP_SUBGOAL_TAXONOMY));
  const sigSubGoals = signature?.subGoals || [];

  for (let i = 0; i < flow.length; i++) {
    const step = flow[i];
    const sg = step.subGoal;

    // Layer 1: subGoal present and valid → keep it
    if (sg && validSubGoals.has(sg)) continue;

    // Layer 2: subGoal missing or invalid → infer from action text
    const inferred = _inferSubGoalFromAction(step.action || '', step.tier);
    if (inferred) {
      logger.warn(`[app.runner] _validateAndFixFlowSubGoals: step ${i} subGoal "${sg || 'missing'}" → inferred "${inferred}" from action "${(step.action || '').slice(0, 60)}"`);
      step.subGoal = inferred;
      continue;
    }

    // Layer 3: cross-reference with signature.subGoals positionally
    if (step.tier === 0) { step.subGoal = 'done'; continue; }
    const sigIdx = _countNonDoneStepsBefore(flow, i);
    if (sigIdx < sigSubGoals.length) {
      const inferredFromSig = sigSubGoals[sigIdx];
      logger.warn(`[app.runner] _validateAndFixFlowSubGoals: step ${i} subGoal "${sg || 'missing'}" → positional "${inferredFromSig}" (sig index ${sigIdx})`);
      step.subGoal = inferredFromSig;
      continue;
    }

    // Last resort: log and leave as-is (the tier dispatch will use regex fallback)
    logger.error(`[app.runner] _validateAndFixFlowSubGoals: step ${i} could not determine subGoal (action="${(step.action || '').slice(0, 80)}", tier=${step.tier})`);
  }
  return flow;
}

function _findMissingSubGoals(signature, shortcuts) {
  if (!signature || !signature.subGoals) return [];
  const shortcutActions = new Set((shortcuts || []).map(s => s.action));
  return signature.subGoals.filter(sg => {
    if (_subGoalsWithoutShortcuts.has(sg)) return false; // handled by other tiers
    const shortcutAction = _subGoalToShortcutAction[sg];
    if (!shortcutAction) return true; // unknown sub-goal — research it
    return !shortcutActions.has(shortcutAction);
  });
}

// ── 2. App-Flow Tier Selection ───────────────────────────────────────────────
// Mirrors _selectTierLLM in instruction.runner.cjs. Force classification — LLM
// returns a single number.

async function _selectAppTierLLM(goal, actionHistory, appCategory, shortcutCount, shortcutLabels,
  currentOcrText, focusedElement, appFlow, flowIndex, triedTiers = new Set()) {
  // 1. App-Flow fast-path — if we have a pre-computed flow, use it directly.
  //    Skip the premature DONE check; per-step verification is handled after
  //    the flow completes via initial-vs-final diff.
  if (appFlow && flowIndex < appFlow.length) {
    const _expected = appFlow[flowIndex];
    if (_expected.tier !== 0) {
      logger.info(`[app.runner] _selectAppTierLLM: App-Flow fast-path → ${_expected.tier} (flow step ${flowIndex}: ${_expected.action || ''})`);
      return _expected.tier;
    }
  }

  // 2. Build available tiers (exclude tried tiers)
  const _availableTiers = [1, 2, 3, 4, 5, 6].filter(t => !triedTiers.has(t));

  // If all tiers are tried, return -1 to signal exhaustion
  if (_availableTiers.length === 0) {
    logger.warn(`[app.runner] _selectAppTierLLM: all tiers tried — returning -1 (exhaustion)`);
    return -1;
  }

  // 3. DONE check — only when flow is exhausted or no flow exists
  if (actionHistory.length > 0 && (!appFlow || flowIndex >= appFlow.length)) {
    const doneResult = await _ocrVerifyAppGoal(currentOcrText, goal, actionHistory);
    if (doneResult.num === 1) return 0;
    if (doneResult.num === 2) {
      // wait/retry — do NOT return 0 (that kills the flow)
      await _sleep(1000);
      return -2;  // sentinel: wait, no action taken, do not advance flowIndex
    }
  }

  // 4. Single tier left — return it without LLM call
  if (_availableTiers.length === 1) {
    logger.info(`[app.runner] _selectAppTierLLM: → ${_availableTiers[0]} (only available tier)`);
    return _availableTiers[0];
  }

  // 5. LLM force classification
  const systemPrompt = `You decide the next action strategy for a desktop app automation task at the CURRENT app state.
Return ONLY a single number — nothing else:
0 = DONE (goal achieved)
1 = App Shortcuts (press an app-specific keyboard shortcut)
2 = Just-type (type a value into the focused field)
3 = Global Shortcuts (press global keys: Tab, Enter, Escape, Arrow keys)
4 = Search Text (use LiteParser to find text on screen, click it)
5 = Monitoring (wait for a long-running operation to complete — AI response, build, upload)
6 = shell.run (open/create files, new window, close window, goto line — more reliable than shortcuts)

Decision rules:
- If a file/folder/document needs to be opened → return 6 (shell.run is more reliable than quick-open)
- If a new file needs to be created → return 6 (shell.run: create temp file + open — more reliable than Cmd+N)
- If a new window needs to be opened → return 6 (shell.run: open -n -a "App" or code -n)
- If the app/window needs to be closed → return 6 (shell.run: osascript quit app)
- If goto line is needed and the file path is known → return 6 (shell.run: code -g <file:line>)
- If an app shortcut can accomplish the next sub-goal (focus field, save, copy, paste) → return 1
- If a field is focused and you need to type a value into it → return 2
- If no shortcut applies but global keys (Tab, Enter, Escape, Arrows) can navigate → return 3
- If you need to find and click a specific text element on screen → return 4
- If a long-running operation was just triggered (AI query submitted, build started, upload began) and you need to wait for it to finish → return 5
- If everything in the goal has been accomplished → return 0
- When in doubt → return 1 (App Shortcuts is the primary tier)

Available strategies:
1 - App Shortcuts: Presses app-specific keyboard shortcuts.
   Available shortcuts:
   ${shortcutLabels}
2 - Just-type: Types a value into the currently focused field. Sub-modes: type-plain (search/chat/simple), type-commands (/slash commands), type-edit (long-form/code), type-search (@mentions/pickers), type-list-item (todos/checklists).
   Current state: focused=${focusedElement ? 'yes' : 'no'}, focusedElement=${focusedElement?.text || 'none'}
3 - Global Shortcuts: Presses global navigation keys (Tab, Enter, Escape, Arrow keys, Shift+Tab).
4 - Search Text: Uses LiteParser OCR to find text on screen, then clicks/navigates to it.
5 - Monitoring: Polls OCR with backoff (10s→60s) and detects completion via stability + LLM cadence checks. Use after triggering a long-running operation (AI response, build, upload, form submission).`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
App category: ${appCategory || 'unknown'}
Available shortcuts: ${shortcutCount} shortcuts
Current OCR (first 300 chars): ${(currentOcrText || '').slice(0, 300)}
Focused element: ${focusedElement ? 'yes' : 'no'}
Recent actions:
${historyStr || '(none)'}

Available tiers (tried tiers excluded): ${_availableTiers.join(', ')}

Number?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 8000, taskType: 'classification' });

    const _cleanRaw = (raw || '').toLowerCase().trim();
    if (!_cleanRaw) {
      logger.warn(`[app.runner] _selectAppTierLLM: empty LLM response — defaulting to 1`);
      return 1;
    }
    const _numMatch = _cleanRaw.match(/\b([012345])\b/);
    const num = _numMatch ? parseInt(_numMatch[1], 10) : NaN;
    if (num >= 0 && num <= 5) {
      logger.info(`[app.runner] _selectAppTierLLM: → ${num} (raw="${_cleanRaw}")`);
      return num;
    }
    logger.warn(`[app.runner] _selectAppTierLLM: invalid "${raw}" → defaulting to 1`);
    return 1;
  } catch (e) {
    logger.warn(`[app.runner] _selectAppTierLLM failed: ${e.message} — defaulting to 1`);
    return 1;
  }
}

// ── 3. Just-type Sub-mode Selection ──────────────────────────────────────────
// Mirrors _extractFieldType in browser.agent.cjs (line 2434).

async function _extractAppFieldType(goal, focusedElement, value, appCategory, actionHistory) {
  const _val = String(value || '');

  // ── Deterministic fast-paths (no LLM) ──
  // Value starts with / → type-commands (Slack /remind, editor slash commands)
  if (_val.startsWith('/')) {
    logger.info(`[app.runner] _extractAppFieldType: → type-commands (value starts with /)`);
    return 'type-commands';
  }
  // Value starts with @ → type-search (@mentions, file pickers)
  if (_val.startsWith('@')) {
    logger.info(`[app.runner] _extractAppFieldType: → type-search (value starts with @)`);
    return 'type-search';
  }

  // Short single-line non-code values are type-plain regardless of appCategory.
  // Forces chat questions, search queries, terminal commands, and short form
  // inputs to type-plain so the LLM classifier doesn't misclassify them as
  // type-edit just because appCategory=editor. Code snippets still go through
  // the LLM path via _looksLikeCode.
  if (_val.length < 200 && !_val.includes('\n') && !_looksLikeCode(_val)) {
    logger.info(`[app.runner] _extractAppFieldType: → type-plain (short single-line non-code, ${_val.length} chars)`);
    return 'type-plain';
  }

  // ── Signal-driven LLM classifier ──
  const systemPrompt = `You decide what KIND of typing a focused desktop app field needs.
Return ONLY one of:
- type-plain: type the value as-is, then submit (Enter). Use for: search boxes, chat inputs, quick-open file paths, simple form fields, short answers. The value IS the final content.
- type-edit: long-form content creation or editing in a document/code editor. The value may need expansion or generation from the goal. Use for: document bodies, code editors, email bodies.
- type-commands: the value starts with '/' and opens a block/command menu (Slack slash commands, editor slash commands).
- type-search: the value filters a dynamic dropdown — @mentions, assignee pickers, file pickers.
- type-list-item: typing into a todo/checklist/task item where Enter creates the next item.

Decision signals (weigh by importance):
1. appCategory: "chat" → type-plain for messages. "editor" → type-edit for code/content. "terminal" → type-plain for commands.
2. Value length: short (<200 chars) and single-line → lean type-plain. Long or multi-line → lean type-edit.
3. Goal intent: "post/send message" → type-plain. "write code/essay" → type-edit. "add todo item" → type-list-item.
4. Existing content: field already has content + goal says "edit/fix/update" → type-edit.
5. List context: todo/checklist app → type-list-item.
6. Default → type-plain (safest — types the value as-is without generating anything).

Return ONLY the type name, nothing else.`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Goal: ${goal}
App category: ${appCategory || 'unknown'}
Value to type: "${_val.slice(0, 200)}"
Recent actions: ${historyStr || '(none)'}

Field type?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 20, temperature: 0.1, responseTimeoutMs: 8000 });
    const val = (raw || '').trim().toLowerCase();
    const valid = ['type-plain', 'type-edit', 'type-commands', 'type-search', 'type-list-item'];
    const match = valid.find(v => val.includes(v));
    const result = match || 'type-plain';
    logger.info(`[app.runner] _extractAppFieldType: LLM → ${result} (raw="${val}")`);
    return result;
  } catch (e) {
    logger.warn(`[app.runner] _extractAppFieldType LLM failed: ${e.message} — defaulting to type-plain`);
    return 'type-plain';
  }
}

// ── 4. Just-type Sub-mode Executors ──────────────────────────────────────────
// All use NutJS keyboard.type instead of Playwright.

async function _getNutKeyboard() {
  try {
    const nut = require('@nut-tree-fork/nut-js');
    return nut;
  } catch (err) {
    logger.error(`[app.runner] NutJS unavailable: ${err.message}`);
    return null;
  }
}

// type-plain: single-line text + Enter (search, chat, quick-open, simple form fields).
async function _executeAppTypePlain({ appName, value, goal, actionHistory }) {
  const nut = await _getNutKeyboard();
  if (!nut) return { ok: false, error: 'NutJS unavailable' };

  const { keyboard, Key } = nut;
  logger.info(`[app.runner] type-plain: typing "${String(value).slice(0, 50)}"`);

  try {
    // Convert literal \n to {SHIFT+ENTER} for multiline contenteditable
    const normalizedText = String(value).replace(/\n/g, '{SHIFT+ENTER}');

    // Use actionTypeText from app.agent for segment parsing (handles {ENTER}, {SHIFT+ENTER}, etc.)
    const appAgent = require('./app.agent.cjs');
    const typeResult = await appAgent.actionTypeText({ appName, text: normalizedText });
    if (!typeResult.ok) return typeResult;

    // For quick-open / search / chat: press Enter to submit
    // (unless the value already ends with {ENTER} which actionTypeText handled)
    if (!String(value).endsWith('{ENTER}')) {
      await _sleep(300);
      await keyboard.pressKey(Key.Return);
      await keyboard.releaseKey(Key.Return);
      logger.info(`[app.runner] type-plain: pressed Enter to submit`);

      // Capture baseline screenshot right after Enter — before any response/output appears.
      // This is used by monitoring (tier 5) to compute a clean diff of the AI/command response.
      // The capture is fast (~100ms) and harmless if no monitoring follows.
      // Use the hidden variant so the ThinkDrop overlay doesn't taint the baseline.
      const baselineShot = await _captureScreenshotOnlyHidden();
      if (baselineShot.ok) {
        logger.info(`[app.runner] type-plain: baseline screenshot captured (${baselineShot.path})`);
        return { ok: true, typed: value, subMode: 'type-plain', baselineScreenshotPath: baselineShot.path };
      }
    }

    return { ok: true, typed: value, subMode: 'type-plain' };
  } catch (e) {
    logger.error(`[app.runner] type-plain failed: ${e.message}`);
    return { ok: false, error: `type-plain failed: ${e.message}` };
  }
}

// type-commands: typing with / or @ commands that open a dropdown.
// Fallback: if type+Enter fails verification, fall back to ArrowDown+LLM.
async function _executeAppTypeCommands({ appName, value, goal, actionHistory }) {
  logger.info(`[app.runner] type-commands: typing "${String(value).slice(0, 50)}"`);

  // Extract command plan: { trigger, commandLabel, content }
  const plan = await _extractCommandPlan(goal, value, actionHistory);
  if (!plan) {
    logger.info(`[app.runner] type-commands: no command plan extracted — falling back to type-plain`);
    return _executeAppTypePlain({ appName, value, goal, actionHistory });
  }

  logger.info(`[app.runner] type-commands: trigger="${plan.trigger}", commandLabel="${plan.commandLabel}", content="${(plan.content || '').slice(0, 50)}"`);

  const nut = await _getNutKeyboard();
  if (!nut) return { ok: false, error: 'NutJS unavailable' };

  const { keyboard, Key } = nut;

  try {
    // 1. Type the trigger (e.g. "/remind")
    await keyboard.type(plan.trigger);
    await _sleep(800);

    // 2. Wait for dropdown to appear (verify via OCR)
    const appAgent = require('./app.agent.cjs');
    let dropdownAppeared = false;
    for (let i = 0; i < 5; i++) {
      const ocr = await _captureOcr({ appName });
      if (ocr && ocr.toLowerCase().includes(plan.commandLabel.toLowerCase().slice(0, 10))) {
        dropdownAppeared = true;
        break;
      }
      await _sleep(500);
    }

    if (!dropdownAppeared) {
      logger.warn(`[app.runner] type-commands: no dropdown appeared after typing "${plan.trigger}" — falling back to type-plain`);
      // Press Escape to clear any partial command
      await keyboard.pressKey(Key.Escape);
      await keyboard.releaseKey(Key.Escape);
      return _executeAppTypePlain({ appName, value, goal, actionHistory });
    }

    // 3. Press Enter to select top match (fast path)
    await keyboard.pressKey(Key.Return);
    await keyboard.releaseKey(Key.Return);
    logger.info(`[app.runner] type-commands: pressed Enter to select top match for "${plan.trigger}"`);
    await _sleep(500);

    // 4. Type content after command selected
    if (plan.content) {
      const typeResult = await appAgent.actionTypeText({ appName, text: plan.content });
      if (!typeResult.ok) {
        logger.warn(`[app.runner] type-commands: content typing failed: ${typeResult.error}`);
      }
      // Press Enter to submit the content
      await _sleep(300);
      await keyboard.pressKey(Key.Return);
      await keyboard.releaseKey(Key.Return);
    }

    // Capture baseline screenshot after final Enter — before any response/output appears
    // Use the hidden variant so the ThinkDrop overlay doesn't taint the baseline.
    const baselineShot = await _captureScreenshotOnlyHidden();
    if (baselineShot.ok) {
      logger.info(`[app.runner] type-commands: baseline screenshot captured (${baselineShot.path})`);
      return { ok: true, typed: value, subMode: 'type-commands', commandPlan: plan, baselineScreenshotPath: baselineShot.path };
    }

    return { ok: true, typed: value, subMode: 'type-commands', commandPlan: plan };
  } catch (e) {
    logger.error(`[app.runner] type-commands failed: ${e.message}`);
    return { ok: false, error: `type-commands failed: ${e.message}` };
  }
}

// type-edit: long-form content (generate or edit).
async function _executeAppTypeEdit({ appName, value, goal, actionHistory, appCategory, agentContext }) {
  logger.info(`[app.runner] type-edit: goal="${String(goal).slice(0, 60)}"`);

  // For desktop apps, we use the generate mode (LLM generates content from goal)
  // The edit mode (clipboard round-trip via edit.agent) is complex and fragile
  // on desktop — fall back to generate for now.
  return _executeAppTypeGenerate({ appName, value, goal, actionHistory, appCategory, agentContext });
}

// type-edit (generate mode): LLM generates long text from the goal, then types it.
async function _executeAppTypeGenerate({ appName, value, goal, actionHistory, appCategory, agentContext }) {
  // If a value is provided, type it as-is via type-plain
  if (value && String(value).length > 0) {
    logger.info(`[app.runner] type-edit (generate): using provided value (${value.length} chars) — typing into field`);
    return _executeAppTypePlain({ appName, value, goal, actionHistory });
  }

  logger.info(`[app.runner] type-edit (generate): generating content from goal`);
  try {
    const genPrompt = `Generate the content to type into a ${appCategory || 'desktop'} app field based on this goal. Return ONLY the content text, nothing else.\n\nGoal: ${goal}\nAgent context: ${String(agentContext || '').slice(0, 400)}`;
    const generated = await skillLlmAsk(genPrompt);

    if (!generated || generated.trim().length < 10) {
      logger.warn(`[app.runner] type-edit (generate): LLM returned too little content — falling back to type-plain`);
      return _executeAppTypePlain({ appName, value, goal, actionHistory });
    }

    logger.info(`[app.runner] type-edit (generate): generated ${generated.length} chars — typing into field`);
    return _executeAppTypePlain({ appName, value: generated, goal, actionHistory });
  } catch (e) {
    logger.warn(`[app.runner] type-edit (generate) failed: ${e.message} — falling back to type-plain`);
    return _executeAppTypePlain({ appName, value, goal, actionHistory });
  }
}

// type-search: typing to filter a dynamic dropdown (@mentions, assignee pickers, file pickers)
async function _executeAppTypeSearch({ appName, value, goal, actionHistory }) {
  logger.info(`[app.runner] type-search: typing "${String(value).slice(0, 50)}"`);

  const plan = await _extractSearchPlan(goal, value, actionHistory);
  if (!plan) {
    logger.info(`[app.runner] type-search: no search plan extracted — falling back to type-plain`);
    return _executeAppTypePlain({ appName, value, goal, actionHistory });
  }

  logger.info(`[app.runner] type-search: trigger="${plan.trigger}", query="${plan.query}", targetLabel="${plan.targetLabel}"`);

  const nut = await _getNutKeyboard();
  if (!nut) return { ok: false, error: 'NutJS unavailable' };
  const { keyboard, Key } = nut;

  try {
    // 1. Type the trigger + query to filter the dropdown
    await keyboard.type(plan.trigger + plan.query);
    await _sleep(800);

    // 2. Wait for dropdown to appear
    let dropdownAppeared = false;
    for (let i = 0; i < 5; i++) {
      const ocr = await _captureOcr({ appName });
      if (ocr && ocr.length > 50) { // dropdown likely appeared if OCR has content
        dropdownAppeared = true;
        break;
      }
      await _sleep(500);
    }

    if (!dropdownAppeared) {
      logger.warn(`[app.runner] type-search: no dropdown appeared — trying Enter to submit as plain search`);
      await keyboard.pressKey(Key.Return);
      await keyboard.releaseKey(Key.Return);
      const baselineShot = await _captureScreenshotOnlyHidden();
      if (baselineShot.ok) {
        return { ok: true, typed: value, subMode: 'type-search', note: 'no dropdown — submitted as plain search', baselineScreenshotPath: baselineShot.path };
      }
      return { ok: true, typed: value, subMode: 'type-search', note: 'no dropdown — submitted as plain search' };
    }

    // 3. Press Enter to select top match
    await keyboard.pressKey(Key.Return);
    await keyboard.releaseKey(Key.Return);
    logger.info(`[app.runner] type-search: pressed Enter to select match for "${plan.query}"`);

    // Capture baseline screenshot after Enter — before any response/output appears
    // Use the hidden variant so the ThinkDrop overlay doesn't taint the baseline.
    const baselineShot = await _captureScreenshotOnlyHidden();
    if (baselineShot.ok) {
      logger.info(`[app.runner] type-search: baseline screenshot captured (${baselineShot.path})`);
      return { ok: true, typed: value, subMode: 'type-search', searchPlan: plan, baselineScreenshotPath: baselineShot.path };
    }

    return { ok: true, typed: value, subMode: 'type-search', searchPlan: plan };
  } catch (e) {
    logger.error(`[app.runner] type-search failed: ${e.message}`);
    return { ok: false, error: `type-search failed: ${e.message}` };
  }
}

// type-list-item: typing into a list/checklist/todo item where Enter creates the next item.
async function _executeAppTypeListItem({ appName, value, goal, actionHistory }) {
  const nut = await _getNutKeyboard();
  if (!nut) return { ok: false, error: 'NutJS unavailable' };
  const { keyboard, Key } = nut;

  logger.info(`[app.runner] type-list-item: typing "${String(value).slice(0, 50)}"`);

  try {
    const appAgent = require('./app.agent.cjs');
    // Type the value (same as type-plain for single-line)
    const typeResult = await appAgent.actionTypeText({ appName, text: value });
    if (!typeResult.ok) return typeResult;

    // Count existing list-item entries in actionHistory
    const _typedItems = (actionHistory || []).filter(a => a.includes('(list-item)')).length;

    // Determine target count from goal (simple heuristic)
    const _targetMatch = String(goal || '').match(/(\d+)\s+(?:items?|todos?|tasks?|entries)/i);
    const _targetCount = _targetMatch ? parseInt(_targetMatch[1], 10) : null;

    if (_targetCount && _typedItems >= _targetCount - 1) {
      logger.info(`[app.runner] type-list-item: last item (${_typedItems}/${_targetCount}) — skipping Enter`);
      return { ok: true, typed: value, subMode: 'type-list-item', listItemIndex: _typedItems };
    }

    // Press Enter to create the next item
    await _sleep(300);
    await keyboard.pressKey(Key.Return);
    await keyboard.releaseKey(Key.Return);
    logger.info(`[app.runner] type-list-item: pressed Enter to create next item`);

    return { ok: true, typed: value, subMode: 'type-list-item', listItemIndex: _typedItems };
  } catch (e) {
    logger.error(`[app.runner] type-list-item failed: ${e.message}`);
    return { ok: false, error: `type-list-item failed: ${e.message}` };
  }
}

// ── Command/Search Plan Extraction (LLM helpers) ────────────────────────────

async function _extractCommandPlan(goal, value, actionHistory) {
  const systemPrompt = `You extract a command plan from a value to type into a desktop app.
The value contains a command trigger (like /remind, /todo, @mention) and possibly content after it.
Return ONLY JSON: {"trigger": "/remind", "commandLabel": "Set a reminder", "content": "me standup at 9am"}
- trigger: the command prefix (e.g. "/remind", "/todo", "@")
- commandLabel: the human-readable label of the dropdown option to select
- content: the text to type AFTER selecting the command (empty string if none)
If the value is just a trigger with no content, set content to "".
- VALIDATION: The trigger MUST appear at the start of the value. If the value does not start with the trigger, return null.`;

  const userPrompt = `Goal: ${goal}
Value to type: "${String(value || '').slice(0, 200)}"

Command plan?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 200, temperature: 0, responseTimeoutMs: 8000 });
    if (!raw) return null;
    const plan = parseLlmJson(raw, logger, '_extractCommandPlan');
    if (plan && plan.trigger) return plan;
    return null;
  } catch (e) {
    logger.warn(`[app.runner] _extractCommandPlan failed: ${e.message}`);
    return null;
  }
}

async function _extractSearchPlan(goal, value, actionHistory) {
  const systemPrompt = `You extract a search plan from a value to type into a desktop app field that filters a dropdown.
Return ONLY JSON: {"trigger": "@", "query": "john", "targetLabel": "John Smith"}
- trigger: the prefix that opens the dropdown (e.g. "@", "/", "#")
- query: the search text to type after the trigger
- targetLabel: the label of the option to select from the filtered dropdown
If the value doesn't look like a search query, return null.`;

  const userPrompt = `Goal: ${goal}
Value to type: "${String(value || '').slice(0, 200)}"

Search plan?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 200, temperature: 0, responseTimeoutMs: 8000 });
    if (!raw) return null;
    const plan = parseLlmJson(raw, logger, '_extractSearchPlan');
    if (plan && plan.query) return plan;
    return null;
  } catch (e) {
    logger.warn(`[app.runner] _extractSearchPlan failed: ${e.message}`);
    return null;
  }
}

// ── 5. Just-type Execution (dispatcher) ──────────────────────────────────────
// Mirrors _executeJustType (instruction.runner.cjs line 5009) and
// _executeTypedField (line 4971).

async function _executeJustType({ appName, value, goal, appCategory, actionHistory, agentContext }) {
  if (!value || value === 'SKIP') {
    return { ok: false, error: 'LLM says skip this field' };
  }

  // Handle PRESS_<KEY> values (Enter, Tab, Escape — no field needed)
  if (value === 'PRESS_ENTER' || (value && value.startsWith('PRESS_'))) {
    const nut = await _getNutKeyboard();
    if (!nut) return { ok: false, error: 'NutJS unavailable' };
    const { keyboard, Key } = nut;

    const _keyMap = {
      enter: Key.Return, tab: Key.Tab, escape: Key.Escape, space: Key.Space,
      arrow_down: Key.ArrowDown, arrow_up: Key.ArrowUp,
      arrow_left: Key.ArrowLeft, arrow_right: Key.ArrowRight,
      backspace: Key.Backspace, delete: Key.Delete,
    };
    const _modMap = { shift: Key.LeftShift, meta: Key.LeftSuper, control: Key.LeftControl, ctrl: Key.LeftControl, alt: Key.LeftAlt };
    const _keySpec = value.replace('PRESS_', '');
    const _parts = _keySpec.split('+');
    let _key, _mods = [];
    if (_parts.length > 1) {
      _mods = _parts.slice(0, -1).map(m => _modMap[m.toLowerCase()] || m);
      _key = _parts[_parts.length - 1];
    } else {
      _key = _parts[0];
    }
    const _finalKey = _keyMap[_key.toLowerCase()] || Key[_key] || Key[_key.toUpperCase()];
    if (!_finalKey) return { ok: false, error: `Unknown key: ${value}` };

    logger.info(`[app.runner] Just-type: pressing ${value}`);
    try {
      await keyboard.pressKey(..._mods, _finalKey);
      await keyboard.releaseKey(..._mods, _finalKey);
      await _sleep(800);
      return { ok: true, typed: value, subMode: 'press-key' };
    } catch (e) {
      return { ok: false, error: `Key press failed: ${e.message}` };
    }
  }

  // Determine field type and dispatch to the right executor
  const fieldType = await _extractAppFieldType(goal, null, value, appCategory, actionHistory);
  logger.info(`[app.runner] _executeJustType: fieldType=${fieldType}, value="${String(value).slice(0, 40)}"`);

  let result;
  switch (fieldType) {
    case 'type-edit':
      result = await _executeAppTypeEdit({ appName, value, goal, actionHistory, appCategory, agentContext });
      break;
    case 'type-commands':
      result = await _executeAppTypeCommands({ appName, value, goal, actionHistory });
      break;
    case 'type-search':
      result = await _executeAppTypeSearch({ appName, value, goal, actionHistory });
      break;
    case 'type-list-item':
      result = await _executeAppTypeListItem({ appName, value, goal, actionHistory });
      break;
    case 'type-plain':
    default:
      result = await _executeAppTypePlain({ appName, value, goal, actionHistory });
      break;
  }

  if (result && typeof result === 'object') result.fieldType = fieldType;
  return result;
}

// ── 6. OCR Verification ──────────────────────────────────────────────────────
// Mirrors _ocrVerifyGoal (browser.agent.cjs line 1731) — force classification.

async function _ocrVerifyAppGoal(ocrText, goal, actionHistory) {
  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const systemPrompt = `You verify if a desktop app automation goal has been achieved by looking at the OCR text captured from the screen.
Return ONLY a single number — nothing else:
0 = failure (goal NOT achieved — expected content is missing, app is in wrong state)
1 = done (goal achieved — expected result is visible, confirmation message shown)
2 = wait (app is loading/processing — retry later)

Rules:
- 1 (done): the OCR text shows the expected result (e.g., file opened, message sent, AI response complete)
- 0 (fail): the OCR text does NOT show the expected result
- 2 (wait): ONLY return 2 if the OCR text shows EXPLICIT loading indicators ("Loading...", "Please wait", "Searching...", spinner, progress bar)
- When in doubt, return 0 (the tier system will try to fix it)

Return ONLY the number.`;

  const userPrompt = `Goal: ${goal}
OCR text from screen:
${(ocrText || '').slice(0, 1500)}
Actions taken:
${historyStr}

Number (0-2)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 10000, taskType: 'classification' });

    const _cleanRaw = (raw || '').toLowerCase().trim();
    if (!_cleanRaw) {
      logger.warn(`[app.runner] _ocrVerifyAppGoal: empty LLM response — returning wait/retry`);
      return { num: 2, reason: 'llm-empty-response' };
    }
    const _numMatch = _cleanRaw.match(/\b([012])\b/);
    const num = _numMatch ? parseInt(_numMatch[1], 10) : NaN;
    if (num >= 0 && num <= 2) {
      logger.info(`[app.runner] _ocrVerifyAppGoal: ${num} for goal="${String(goal).slice(0, 60)}"`);
      return { num, reason: num === 1 ? 'goal-achieved' : (num === 2 ? 'loading' : 'ocr-failed') };
    }
    logger.info(`[app.runner] _ocrVerifyAppGoal: invalid "${raw}" → defaulting to 0`);
    return { num: 0, reason: 'invalid-llm-response' };
  } catch (e) {
    logger.warn(`[app.runner] _ocrVerifyAppGoal failed: ${e.message} — returning wait/retry`);
    return { num: 2, reason: 'llm-provider-failure' };
  }
}

// Before/after OCR diff verification — force classification.
async function _ocrVerifyAppStep(beforeOcr, afterOcr, stepGoal, actionHistory) {
  const systemPrompt = `You verify if a desktop app automation step was achieved by comparing OCR text BEFORE and AFTER the action.
Return ONLY a single number — nothing else:
0 = failure (step goal NOT achieved — no relevant change detected)
1 = success (step goal achieved — expected change is visible in the after-OCR)
2 = wait (app is loading/processing — retry later)

Rules:
- Compare the before and after OCR text. The step goal describes what should have changed.
- 1 (success): the after-OCR shows the expected result (e.g., a panel opened, text appeared, a dialog closed)
- 0 (fail): the after-OCR shows no meaningful change, or the wrong change occurred
- 2 (wait): ONLY if the after-OCR shows explicit loading indicators ("Loading...", "Please wait", spinner)
- If the before and after are nearly identical, return 0 (the action had no effect)
- When in doubt, return 0`;

  const historyStr = (actionHistory || []).slice(-5).map((a, i) => `  ${i + 1}. ${a}`).join('\n');

  const userPrompt = `Step goal: ${stepGoal}
Before OCR (first 500 chars): ${(beforeOcr || '').slice(0, 500)}
After OCR (first 500 chars): ${(afterOcr || '').slice(0, 500)}
Actions taken: ${historyStr}

Number (0-2)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000, taskType: 'classification' });

    const _cleanRaw = (raw || '').toLowerCase().trim();
    if (!_cleanRaw) return { num: 2, reason: 'llm-empty-response' };
    const _numMatch = _cleanRaw.match(/\b([012])\b/);
    const num = _numMatch ? parseInt(_numMatch[1], 10) : NaN;
    if (num >= 0 && num <= 2) {
      logger.info(`[app.runner] _ocrVerifyAppStep: ${num} for stepGoal="${String(stepGoal).slice(0, 60)}"`);
      return { num, reason: num === 1 ? 'success' : (num === 2 ? 'loading' : 'no-change') };
    }
    return { num: 0, reason: 'invalid-llm-response' };
  } catch (e) {
    logger.warn(`[app.runner] _ocrVerifyAppStep failed: ${e.message}`);
    return { num: 2, reason: 'llm-provider-failure' };
  }
}

// ── 7. Monitoring with Force Classification ──────────────────────────────────
// Wraps actionMonitorWithBackoff polling infrastructure but replaces its
// free-form JSON LLM calls with force classification (single number 0-3).

// End-of-run LLM classifier: is the captured text actual content, an error,
// or a loading/streaming indicator? Called ONCE after plateau detection
// confirms the response has stopped growing — not in the monitoring loop.
// This catches frozen spinners and error states that pixel stability can't.
// Returns: 0 = content (accept as done), 1 = loading (rare after plateau),
//          2 = error (return as failure), 3 = unknown (treat as content).
async function _ocrVerifyMonitorState(ocrText, questionToAsk, appName) {
  const systemPrompt = `You are checking whether a screen capture shows actual content, an error, or a loading state.
The text below is the DIFF between a baseline capture and the current screen — it contains only the NEW content that appeared.
The screen has already been confirmed stable (not changing) before this check.
Return ONLY a single number — nothing else:
0 = actual content (normal response/output — accept as done)
1 = loading/streaming indicator (spinner, "thinking", "generating", progress bar)
2 = error message (crash, failure, "cancelled", "timed out", "error occurred")
3 = unknown/ambiguous (treat as content — accept as done)

Rules:
- 0 (content): the text contains a coherent response, answer, or output. Even if short or imperfect, if it's real content (not an error or loading indicator), return 0.
- 1 (loading): the text is ONLY a loading indicator (spinner, "thinking...", "generating response...", progress bar). No actual content yet.
- 2 (error): the text shows an explicit error message, crash, "failed", "cancelled", "timed out", or "error occurred".
- 3 (unknown): the text is too short or ambiguous to classify. Treat as content (0) to avoid false negatives.
- When in doubt → return 0 (content). The screen is already confirmed stable.`;

  const userPrompt = `User's question: ${questionToAsk || '(unknown)'}
App: ${appName || 'unknown'}
OCR text (first 2000 chars): ${(ocrText || '').slice(0, 2000)}

Number (0-3)?`;

  try {
    // Use taskType: 'complex' so the backend routes to a better model that
    // actually returns a number (0|1|2|3) instead of prose like "Based on the
    // provided...". This call is rare (only on stability), so the cost is
    // negligible compared to calling a cheap model on every noisy change.
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 10000, taskType: 'complex' });

    const _cleanRaw = (raw || '').toLowerCase().trim();
    if (!_cleanRaw) return { num: 0, reason: 'llm-empty-response' };
    const _numMatch = _cleanRaw.match(/\b([0123])\b/);
    const num = _numMatch ? parseInt(_numMatch[1], 10) : NaN;
    if (num >= 0 && num <= 3) {
      logger.info(`[app.runner] _ocrVerifyMonitorState: ${num} for question="${String(questionToAsk).slice(0, 60)}"`);
      return { num, reason: ['content', 'loading', 'error', 'unknown'][num] };
    }
    return { num: 0, reason: 'invalid-llm-response' };
  } catch (e) {
    logger.warn(`[app.runner] _ocrVerifyMonitorState failed: ${e.message}`);
    return { num: 0, reason: 'llm-provider-failure' };
  }
}

// Two-phase monitoring: pixel-settle detection + content plateau + end-of-run LLM.
//
// Phase 1 — Settle detection (pixel diff, ~500ms polling):
//   Capture screenshots every 500ms, compute pixel diff between CONSECUTIVE
//   captures. When diff < 0.05% for 2 consecutive captures, the screen has
//   settled. Pixel diff is the industry-standard technique (testdriverai,
//   super-one, OpenAdapt all use it) — OCR re-segments between captures and
//   is noisy for change detection, but pixels are deterministic.
//
// Phase 2 — Content extraction + plateau detection (OCR, no LLM in loop):
//   Run OCR on the settled frame, compute text diff vs baseline. Track the
//   diff length across cycles. When the diff stops growing by more than 5%
//   for 2 consecutive cycles AND exceeds 100 chars, the response is complete.
//   This is deterministic — no LLM judgment needed for completion detection.
//
// Phase 3 — End-of-run LLM check (one call):
//   After plateau is confirmed (or cycles exhausted), do ONE LLM call to
//   classify the captured text as content / error / loading. This catches
//   frozen spinners and error states that pixel stability can't detect.
//
// Phase 4 — Fallback:
//   If the screen never settles in 60s, or all cycles are exhausted, accept
//   the last diff and run the end-of-run LLM check on it.
async function _executeMonitoring({ goal, questionToAsk, appName, mode = 'passive', maxDurationMs = 300000, actionHistory, progressCallbackUrl, stepIndex, flowIndex, baselineScreenshotPath, signal }) {
  logger.info(`[app.runner] _executeMonitoring: goal="${String(goal).slice(0, 60)}", question="${String(questionToAsk || '').slice(0, 60)}", mode=${mode}, maxDuration=${maxDurationMs}ms, baseline=${baselineScreenshotPath ? 'provided' : 'none'}`);

  const startTime = Date.now();
  let llmCalls = 0;

  // ── Constants ──
  const SETTLE_POLL_MS = 500;          // poll every 500ms
  const SETTLE_TIMEOUT_MS = 30000;     // max wait for settling per cycle (was 60s)
  const SETTLE_THRESHOLD = 0.001;     // 0.1% — includes 0.05-0.06% noise floor
  const SETTLE_CONSECUTIVE = 2;        // need 2 consecutive stable captures
  const MAX_SETTLE_CYCLES = 5;         // max settle→OCR rounds (~13s each = ~65s max)
  const MIN_DIFF_CHARS = 100;          // minimum diff to consider as "response present"
  const INSTANT_DONE_CHARS = 1500;     // diff this large on a stable screen = strong completion signal
  const SETTLE_EXTENSION_MS = 10000;   // first extension when initial settle window times out
  const SETTLE_EXTENSION_CAP_MS = 120000; // 2-minute total cap on extensions per cycle

  // 1. Use provided baseline or capture one immediately
  let baselinePath = baselineScreenshotPath || null;
  if (!baselinePath) {
    const baselineShot = await _captureScreenshotOnlyHidden();
    if (baselineShot.ok) {
      baselinePath = baselineShot.path;
      logger.info(`[app.runner] _executeMonitoring: captured baseline screenshot (${baselinePath})`);
    }
  }

  // 2. Start OCR on baseline PNG in parallel with first settle cycle
  const baselineOcrPromise = baselinePath
    ? _ocrScreenshot(baselinePath, appName, signal)
    : Promise.resolve({ rows: [], text: '', source: 'no-baseline' });

  let lastDiffText = '';
  let lastRows = [];
  let lastDiffLen = 0;
  let consecutivePlateau = 0;

  // ── Accumulated text tracking ──
  // During settling, the LLM may stream text that scrolls out of view before
  // the final OCR. We run background OCR on intermediate screenshots, diff
  // each against the previous one, and accumulate new lines. This captures
  // content that would otherwise be lost to scrolling.
  const accumulatedNewLines = new Set(); // trimmed lines seen as "new"
  let prevOcrText = '';                  // full OCR text from last background capture
  let bgOcrPromise = null;               // current background OCR promise
  let bgOcrShotPath = null;              // path of the screenshot being OCR'd

  // 3. Settle → OCR cycles (no LLM in loop)
  for (let cycle = 0; cycle < MAX_SETTLE_CYCLES; cycle++) {
    if (signal?.aborted) {
      logger.info(`[app.runner] _executeMonitoring: aborted before cycle ${cycle + 1}`);
      return { ok: false, error: 'aborted', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0, aborted: true };
    }
    if (Date.now() - startTime >= maxDurationMs) break;

    // ── Phase 1: Settle detection with pixel diff ──
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:monitor_progress',
      stepIndex, flowIndex, tier: 5,
      elapsed: Math.round((Date.now() - startTime) / 1000),
      nextCheckInMs: SETTLE_TIMEOUT_MS,
      message: `Detecting response… (pixel settle, cycle ${cycle + 1}/${MAX_SETTLE_CYCLES})`,
    });

    let prevShotPath = baselinePath;
    let consecutiveStable = 0;
    const settleStart = Date.now();
    let settled = false;

    // Settle deadline starts at SETTLE_TIMEOUT_MS and is extended (10s → 20s → 40s → 80s)
    // when the screen keeps changing. Capped at SETTLE_EXTENSION_CAP_MS (120s) per cycle.
    let settleDeadline = settleStart + SETTLE_TIMEOUT_MS;
    let nextExtensionMs = SETTLE_EXTENSION_MS;
    let extensionCount = 0;

    while (Date.now() - startTime < maxDurationMs) {
      if (signal?.aborted) {
        logger.info(`[app.runner] _executeMonitoring: aborted during settle poll`);
        return { ok: false, error: 'aborted', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0, aborted: true };
      }

      // If the current deadline has passed and we still haven't settled, try to extend.
      if (Date.now() >= settleDeadline) {
        const totalExtensions = settleDeadline - settleStart - SETTLE_TIMEOUT_MS;
        if (totalExtensions + nextExtensionMs > SETTLE_EXTENSION_CAP_MS) {
          logger.info(`[app.runner] _executeMonitoring: settle extension cap reached (${SETTLE_EXTENSION_CAP_MS / 1000}s) — proceeding to OCR`);
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:monitor_progress',
            stepIndex, flowIndex, tier: 5,
            elapsed: Math.round((Date.now() - startTime) / 1000),
            nextCheckInMs: 5000,
            message: `Monitoring: still not stable after ${Math.round((Date.now() - settleStart) / 1000)}s — reading current frame`,
          });
          break;
        }
        extensionCount++;
        settleDeadline = Date.now() + nextExtensionMs;
        logger.info(`[app.runner] _executeMonitoring: settle cycle ${cycle + 1} not stable — extending +${nextExtensionMs / 1000}s (extension ${extensionCount}, total cap ${SETTLE_EXTENSION_CAP_MS / 1000}s)`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:monitor_progress',
          stepIndex, flowIndex, tier: 5,
          elapsed: Math.round((Date.now() - startTime) / 1000),
          nextCheckInMs: nextExtensionMs,
          message: `Monitoring: still not stable, extending ${nextExtensionMs / 1000}s (extension ${extensionCount})`,
        });
        nextExtensionMs *= 2; // 10 → 20 → 40 → 80 → cap
      }

      await _sleep(SETTLE_POLL_MS, signal);
      if (signal?.aborted) {
        logger.info(`[app.runner] _executeMonitoring: aborted during settle wait`);
        return { ok: false, error: 'aborted', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0, aborted: true };
      }

      const newShot = await _captureScreenshotOnlyHidden();
      if (!newShot.ok) {
        logger.warn(`[app.runner] _executeMonitoring: screenshot capture failed during settle — retrying`);
        continue;
      }

      const diffPercent = _pixelDiffPercent(prevShotPath, newShot.path);
      const settleElapsed = Math.round((Date.now() - settleStart) / 1000);
      logger.info(`[app.runner] _executeMonitoring: settle cycle ${cycle + 1} — pixel diff ${(diffPercent * 100).toFixed(2)}% (stable=${consecutiveStable}, ${settleElapsed}s, ext=${extensionCount})`);

      if (diffPercent <= SETTLE_THRESHOLD) {
        consecutiveStable++;
        if (consecutiveStable >= SETTLE_CONSECUTIVE) {
          settled = true;
          prevShotPath = newShot.path; // keep the latest as the settled frame
          break;
        }
      } else {
        consecutiveStable = 0;
      }
      prevShotPath = newShot.path;

      // ── Background OCR accumulation ──
      // While waiting for the screen to settle, run OCR on intermediate
      // screenshots in the background. Diff each against the previous OCR
      // and accumulate new lines. This captures text that streams and then
      // scrolls out of view before the final OCR.
      //
      // OCR takes ~5-7s, so we only start a new one when the previous one
      // has completed. The screenshot is captured at the current moment
      // (mid-stream) and OCR'd while we continue polling.
      if (!bgOcrPromise && newShot.ok) {
        bgOcrShotPath = newShot.path;
        bgOcrPromise = _ocrScreenshot(newShot.path, appName, signal)
          .catch(() => ({ text: '', rows: [] }));
      }
      // Check if the background OCR has completed
      if (bgOcrPromise) {
        const settled_now = await Promise.race([
          bgOcrPromise.then(r => ({ done: true, result: r })),
          _sleep(50, signal).then(() => ({ done: false })),
        ]);
        if (settled_now.done) {
          const bgResult = settled_now.result;
          if (bgResult && bgResult.text && bgResult.text.trim().length > 10) {
            // Diff against previous OCR — keep only new lines not seen before
            const bgLines = bgResult.text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
            let newCount = 0;
            for (const line of bgLines) {
              if (!accumulatedNewLines.has(line)) {
                accumulatedNewLines.add(line);
                newCount++;
              }
            }
            if (newCount > 0) {
              logger.info(`[app.runner] _executeMonitoring: bg OCR accumulated ${newCount} new line(s) (total ${accumulatedNewLines.size}, cycle ${cycle + 1})`);
            }
            prevOcrText = bgResult.text;
          }
          bgOcrPromise = null;
          bgOcrShotPath = null;
        }
      }
    }

    if (!settled) {
      logger.info(`[app.runner] _executeMonitoring: settle cycle ${cycle + 1} ended without stability after ${Math.round((Date.now() - settleStart) / 1000)}s (extensions=${extensionCount})`);
    } else {
      logger.info(`[app.runner] _executeMonitoring: screen settled after ${Math.round((Date.now() - settleStart) / 1000)}s (cycle ${cycle + 1}, extensions=${extensionCount})`);
    }

    // Wait for any pending background OCR before proceeding to Phase 2
    if (bgOcrPromise) {
      logger.info(`[app.runner] _executeMonitoring: waiting for background OCR to complete before Phase 2`);
      try {
        const bgResult = await bgOcrPromise;
        if (bgResult && bgResult.text && bgResult.text.trim().length > 10) {
          const bgLines = bgResult.text.split('\n').map(l => l.trim()).filter(l => l.length > 3);
          let newCount = 0;
          for (const line of bgLines) {
            if (!accumulatedNewLines.has(line)) {
              accumulatedNewLines.add(line);
              newCount++;
            }
          }
          if (newCount > 0) {
            logger.info(`[app.runner] _executeMonitoring: final bg OCR added ${newCount} new line(s) (total ${accumulatedNewLines.size})`);
          }
          prevOcrText = bgResult.text;
        }
      } catch (_) { /* non-fatal */ }
      bgOcrPromise = null;
      bgOcrShotPath = null;
    }

    // ── Phase 2: OCR + content plateau detection ──
    if (signal?.aborted) {
      return { ok: false, error: 'aborted', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0, aborted: true };
    }

    _postProgress(progressCallbackUrl, {
      type: 'app_flow:monitor_progress',
      stepIndex, flowIndex, tier: 5,
      elapsed: Math.round((Date.now() - startTime) / 1000),
      nextCheckInMs: 5000,
      message: `Reading response… (OCR, cycle ${cycle + 1}/${MAX_SETTLE_CYCLES})`,
    });

    const finalOcr = await _ocrScreenshot(prevShotPath, appName, signal);
    if (signal?.aborted) {
      logger.info(`[app.runner] _executeMonitoring: aborted during OCR`);
      return { ok: false, error: 'aborted', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0, aborted: true };
    }
    if (!finalOcr.text || finalOcr.text.trim().length < 10) {
      logger.warn(`[app.runner] _executeMonitoring: empty OCR on settled frame — retrying next cycle`);
      continue;
    }

    lastRows = finalOcr.rows;

    // Compute flat diff vs baseline (all OCR text — the real answer text)
    const baselineOcr = await baselineOcrPromise;
    const baselineText = baselineOcr.text || '';
    const flatDiffText = _computeOcrDiff(baselineText, finalOcr.text);

    // Merge accumulated new lines from background OCR with the final diff.
    // The accumulated lines capture text that streamed and scrolled out of
    // view before the final OCR. Add any accumulated lines not already in
    // the final diff.
    if (accumulatedNewLines.size > 0) {
      const finalDiffLines = new Set(flatDiffText.split('\n').map(l => l.trim()).filter(l => l.length > 3));
      const missingFromFinal = [...accumulatedNewLines].filter(l => !finalDiffLines.has(l));
      if (missingFromFinal.length > 0) {
        const merged = flatDiffText + '\n' + missingFromFinal.join('\n');
        logger.info(`[app.runner] _executeMonitoring: merged ${missingFromFinal.length} accumulated line(s) into final diff (${flatDiffText.length} → ${merged.length} chars)`);
        lastDiffText = merged;
      } else {
        lastDiffText = flatDiffText;
      }
    } else {
      lastDiffText = flatDiffText;
    }

    const diffLen = flatDiffText.length;
    logger.info(`[app.runner] _executeMonitoring: OCR diff=${diffLen} chars (cycle ${cycle + 1}, last=${lastDiffLen})`);

    if (diffLen < MIN_DIFF_CHARS) {
      logger.info(`[app.runner] _executeMonitoring: diff too short (${diffLen} chars) — retrying next cycle`);
      lastDiffLen = diffLen;
      continue;
    }

    const growth = diffLen - lastDiffLen;
    const growthPercent = lastDiffLen > 0 ? growth / lastDiffLen : 1;
    lastDiffLen = diffLen;

    // Plateau detection: the diff has stopped changing for 2 consecutive settled cycles.
    if (settled && Math.abs(growth) < 50 && Math.abs(growthPercent) < 0.05) {
      consecutivePlateau++;
      if (consecutivePlateau >= 2) {
        logger.info(`[app.runner] _executeMonitoring: plateau confirmed — diff stopped growing at ${diffLen} chars (cycle ${cycle + 1})`);
        break;
      }
    } else {
      consecutivePlateau = 0;
    }

    // A large diff on a settled screen is a fast path, but only if the diff has stopped growing.
    // Do not break immediately; wait for plateau confirmation in the next cycle.
    if (settled && diffLen >= INSTANT_DONE_CHARS) {
      logger.info(`[app.runner] _executeMonitoring: large settled diff — ${diffLen} chars (cycle ${cycle + 1})`);
    }

    if (!settled) {
      logger.info(`[app.runner] _executeMonitoring: diff ${diffLen} chars but screen not settled — continuing to next cycle`);
    } else {
      logger.info(`[app.runner] _executeMonitoring: diff ${diffLen} chars — continuing to confirm not growing`);
    }
  }

  // ── Phase 2.5: Scroll to bottom so overflowed content is visible ──
  // Chat/AI panels often stream content past the visible viewport. Jumping to
  // the bottom before the final OCR ensures we capture the latest generated text.
  if (lastDiffText.length >= MIN_DIFF_CHARS) {
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:monitor_progress',
      stepIndex, flowIndex, tier: 5,
      elapsed: Math.round((Date.now() - startTime) / 1000),
      nextCheckInMs: 3000,
      message: `Scrolling to latest content…`,
    });
    const scrolled = await _scrollToBottom({ appName });
    if (scrolled) {
      const postScrollShot = await _captureScreenshotOnlyHidden();
      if (postScrollShot.ok) {
        const postScrollOcr = await _ocrScreenshot(postScrollShot.path, appName, signal);
        if (postScrollOcr.text && postScrollOcr.text.length > 0) {
          const baselineOcr = await baselineOcrPromise;
          const newDiff = _computeOcrDiff(baselineOcr.text || '', postScrollOcr.text);
          if (newDiff.length > lastDiffText.length) {
            logger.info(`[app.runner] _executeMonitoring: post-scroll diff grew ${lastDiffText.length} → ${newDiff.length} chars`);
            lastDiffText = newDiff;
            lastRows = postScrollOcr.rows;
          } else {
            logger.info(`[app.runner] _executeMonitoring: post-scroll diff ${newDiff.length} chars did not exceed ${lastDiffText.length} — keeping pre-scroll capture`);
          }
        }
      }
    }
  }

  // ── Phase 3: End-of-run LLM check (one call) ──
  // Classify the captured text as content / error / loading. This catches
  // frozen spinners and error states that pixel stability can't detect.
  if (lastDiffText.length >= MIN_DIFF_CHARS) {
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:monitor_progress',
      stepIndex, flowIndex, tier: 5,
      elapsed: Math.round((Date.now() - startTime) / 1000),
      nextCheckInMs: 8000,
      message: `Verifying response… (final check, ${lastDiffText.length} chars)`,
    });

    llmCalls++;
    const stateResult = await _ocrVerifyMonitorState(lastDiffText, questionToAsk || goal, appName);
    if (stateResult.num === 2) {
      // Error detected
      logger.info(`[app.runner] _executeMonitoring: error detected by LLM — ${stateResult.reason}`);
      return { ok: false, error: lastDiffText, llmCalls, elapsed: Date.now() - startTime, finalStatus: 3 };
    }
    // num === 0 (content) or 1 (loading — unlikely after plateau) → accept as done
    logger.info(`[app.runner] _executeMonitoring: completion confirmed (LLM=${stateResult.num}, ${lastDiffText.length} chars) — ${stateResult.reason}`);
    return { ok: true, summary: lastDiffText, chatText: lastDiffText, rows: lastRows, llmCalls, elapsed: Date.now() - startTime, finalStatus: 2 };
  }

  // ── Phase 4: Fallback — capture full OCR and accept it ──
  const { rows, text } = await _captureStructuredOcr({ appName });
  if (text && text.trim().length > 50) {
    logger.info(`[app.runner] _executeMonitoring: fallback — accepting full OCR (${text.length} chars)`);
    return { ok: true, summary: text, chatText: _extractChatArea(rows), rows, llmCalls, elapsed: Date.now() - startTime, finalStatus: 2, accepted: true };
  }

  return { ok: false, error: 'Monitoring timeout', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0 };
}

// ── 8. Tier Execution Functions ──────────────────────────────────────────────

// Tier 1: App Shortcuts — calls existing actionExecuteShortcut from app.agent.cjs
async function _executeAppShortcut({ appName, action, shortcutOverride, verifyWith }) {
  try {
    const appAgent = require('./app.agent.cjs');
    const result = await appAgent.actionExecuteShortcut({
      appName, action, shortcutOverride, verifyWith, skipFocusCheck: false,
    });
    return result;
  } catch (e) {
    logger.error(`[app.runner] _executeAppShortcut failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Tier 2: Just-type — dispatches to 5 sub-mode executors (see above)

// Scroll the focused app to the bottom of its content area. Used before final
// OCR in monitoring so any overflowed chat/AI response text becomes visible.
async function _scrollToBottom({ appName }) {
  try {
    const appAgent = require('./app.agent.cjs');
    // Cmd+End is the macOS "jump to bottom" shortcut in editors/chat panels.
    let result = await appAgent.actionExecuteShortcut({
      appName, shortcutOverride: 'Cmd+End', skipFocusCheck: true,
    });
    if (!result?.ok) {
      // Fallback for apps that use Ctrl+End (e.g. some terminals, web views).
      result = await appAgent.actionExecuteShortcut({
        appName, shortcutOverride: 'Ctrl+End', skipFocusCheck: true,
      });
    }
    if (result?.ok) {
      logger.info(`[app.runner] _scrollToBottom: jumped to bottom in ${appName}`);
    } else {
      logger.warn(`[app.runner] _scrollToBottom: jump failed in ${appName} — ${result?.error || 'unknown'}`);
    }
    await _sleep(400); // brief settle so the scroll lands before the next capture
    return result?.ok === true;
  } catch (err) {
    logger.warn(`[app.runner] _scrollToBottom failed: ${err.message}`);
    return false;
  }
}

// Tier 3: Global Shortcuts — uses NutJS directly
async function _executeGlobalShortcut({ appName, key }) {
  const nut = await _getNutKeyboard();
  if (!nut) return { ok: false, error: 'NutJS unavailable' };
  const { keyboard, Key } = nut;

  const _keyMap = {
    enter: Key.Return, tab: Key.Tab, escape: Key.Escape, space: Key.Space,
    arrow_down: Key.ArrowDown, arrow_up: Key.ArrowUp,
    arrow_left: Key.ArrowLeft, arrow_right: Key.ArrowRight,
    backspace: Key.Backspace, delete: Key.Delete,
  };
  const _modMap = { shift: Key.LeftShift, meta: Key.LeftSuper, control: Key.LeftControl, ctrl: Key.LeftControl, alt: Key.LeftAlt };

  const _parts = String(key || '').toLowerCase().split('+');
  let _key, _mods = [];
  if (_parts.length > 1) {
    _mods = _parts.slice(0, -1).map(m => _modMap[m] || m);
    _key = _parts[_parts.length - 1];
  } else {
    _key = _parts[0];
  }
  const _finalKey = _keyMap[_key] || Key[_key.charAt(0).toUpperCase() + _key.slice(1)];
  if (!_finalKey) return { ok: false, error: `Unknown global key: ${key}` };

  logger.info(`[app.runner] _executeGlobalShortcut: pressing ${key}`);
  try {
    await keyboard.pressKey(..._mods, _finalKey);
    await keyboard.releaseKey(..._mods, _finalKey);
    await _sleep(500);
    return { ok: true, key };
  } catch (e) {
    return { ok: false, error: `Global shortcut failed: ${e.message}` };
  }
}

// Tier 4: Search Text w/LiteParser — find text on screen and click it
async function _executeSearchText({ appName, searchText }) {
  try {
    const appAgent = require('./app.agent.cjs');

    // 1. Parse screenshot to get LiteParser text items
    const parseResult = await appAgent.actionParseScreenshot({});
    if (!parseResult.ok || !parseResult.textItems || parseResult.textItems.length === 0) {
      return { ok: false, error: 'LiteParser found no text items' };
    }

    // 2. Find matching elements
    const findResult = await appAgent.actionFindElements({
      searchText,
      textItems: parseResult.textItems,
      highlight: false,
    });
    if (!findResult.ok || !findResult.matches || findResult.matches.length === 0) {
      return { ok: false, error: `No elements found matching "${searchText}"` };
    }

    // 3. Click the first match at its center coordinates
    const match = findResult.matches[0];
    const cx = match.x + match.width / 2;
    const cy = match.y + match.height / 2;

    const nut = await _getNutKeyboard();
    if (!nut) return { ok: false, error: 'NutJS unavailable' };
    const { mouse } = nut;

    logger.info(`[app.runner] _executeSearchText: clicking "${match.text}" at (${cx}, ${cy})`);
    await mouse.setPosition(new nut.Point(cx, cy));
    await mouse.leftClick();

    return { ok: true, clicked: true, text: match.text, coordinates: { x: cx, y: cy } };
  } catch (e) {
    logger.error(`[app.runner] _executeSearchText failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── 9. Main App-Flow Loop ────────────────────────────────────────────────────
// Mirrors runIterativeNavigation in instruction.runner.cjs.

async function runAppFlow({ goal, appName, category, bounds, shortcuts, resolvedFilePath = null, timeoutMs = 120000, agentContext = null, progressCallbackUrl = null, stepIndex = 0, signal = null }) {
  if (!goal) return { ok: false, error: 'goal is required' };
  if (!appName) return { ok: false, error: 'appName is required' };

  const appAgent = require('./app.agent.cjs');
  const startTime = Date.now();
  const actionHistory = [];
  let triedTiers = new Set();
  let flowIndex = 0;
  let finalOcrFromMonitor = null; // reused from monitoring to avoid extra capture
  const stepFailures = {}; // key: `${tier}:${actionLabel}` → count
  let lastTier = 0; // tracks previous tier for settle-delay decisions

  logger.info(`[app.runner] runAppFlow: goal="${String(goal).slice(0, 80)}", app="${appName}", category=${category || 'unknown'}, timeout=${timeoutMs}ms`);

  // Emit flow start so AutomationProgress shows the App-Flow session
  _postProgress(progressCallbackUrl, {
    type: 'app_flow:start',
    stepIndex,
    appName,
    goal: String(goal).slice(0, 120),
    category: category || 'unknown',
    shortcutCount: (shortcuts || []).length,
  });

  // 1. Robustly focus the target app BEFORE any OCR/overlay work (URL-first for desktop).
  //    Without this, the GhostLayer overlay and NutJS keystrokes land on whatever app
  //    happened to be in the foreground (e.g. the terminal used to launch ThinkDrop).
  _postProgress(progressCallbackUrl, {
    type: 'app_flow:focusing',
    stepIndex,
    appName,
    message: `Focusing ${appName}…`,
  });
  const focusResult = await _focusApp(appName, { maxRetries: 3, waitMs: 5000 });
  if (!focusResult.ok) {
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:done',
      stepIndex,
      ok: false,
      error: focusResult.error,
    });
    return { ok: false, error: focusResult.error };
  }
  logger.info(`[app.runner] runAppFlow: focused app confirmed: "${focusResult.appName}"`);

  // 2. Capture initial OCR state (kept for initial-vs-final diff verification)
  const initialOcr = await _captureOcr({ appName });
  let currentOcr = initialOcr;
  let baselineScreenshotPath = null; // set by Just-Type → Enter for monitoring diff
  logger.info(`[app.runner] runAppFlow: initial OCR (${currentOcr.length} chars)`);

  // 3. Build shortcut labels for LLM prompts
  const shortcutLabels = (shortcuts || [])
    .map(s => `   ${s.action}: ${s.shortcut}`)
    .join('\n') || '   (none discovered)';
  const shortcutCount = (shortcuts || []).length;

  // 4. Extract goal signature + pre-compute App-Flow (check playbook cache first)
  const signature = await _extractGoalSignature(goal, appName, category);
  let appFlow = null;
  if (signature) {
    const cached = _loadPlaybookCache(appName, signature);
    if (cached) {
      appFlow = _substitutePlaybookEntities(cached.playbook, cached.entities, signature.entities);
      logger.info(`[app.runner] runAppFlow: playbook cache HIT (type=${signature.type}, subGoals=[${signature.subGoals.join(',')}])`);
    }
  }
  if (!appFlow) {
    // Research missing shortcuts on-demand before synthesizing
    if (signature) {
      const missing = _findMissingSubGoals(signature, shortcuts);
      if (missing.length > 0) {
        logger.info(`[app.runner] runAppFlow: ${missing.length} missing shortcut(s) for sub-goals: ${missing.join(', ')} — researching…`);
        for (const subGoal of missing) {
          const researched = await _researchMissingShortcut(appName, subGoal, category);
          if (researched) {
            shortcuts.push(researched);
            logger.info(`[app.runner] runAppFlow: added researched shortcut ${researched.shortcut} for ${subGoal}`);
          }
        }
      }
    }
    appFlow = await _computeAppFlowV2(goal, category, shortcuts, appName, signature);
    if (appFlow && signature) {
      appFlow = _validateAndFixFlowSubGoals(appFlow, signature);
      _savePlaybookCache(appName, signature, appFlow, signature.entities);
    }
  } else if (appFlow && signature) {
    // Validate cached playbooks too (old caches may lack subGoal fields)
    appFlow = _validateAndFixFlowSubGoals(appFlow, signature);
  }

  // Emit computed flow so the UI can show the planned steps
  if (appFlow && appFlow.length > 0) {
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:computed',
      stepIndex,
      flow: appFlow.map((s, i) => ({ index: i, action: s.action || '', tier: s.tier || null, status: 'pending' })),
      totalSteps: appFlow.length,
    });
  }

  // 5. Main loop
  while (Date.now() - startTime < timeoutMs) {
    if (signal?.aborted) {
      logger.info(`[app.runner] runAppFlow: aborted`);
      return { ok: false, error: 'aborted', actionHistory, elapsed: Date.now() - startTime, aborted: true };
    }
    // If the pre-computed flow is exhausted, break immediately and proceed to
    // final diff verification. Do NOT call _selectAppTierLLM — it loops forever
    // when the LLM returns prose instead of numbers.
    if (appFlow && flowIndex >= appFlow.length) {
      logger.info(`[app.runner] runAppFlow: App-Flow exhausted (flowIndex=${flowIndex}/${appFlow.length}) — proceeding to final verification`);
      break;
    }

    // 5b. Select tier (force classification) — no per-iteration OCR capture;
    //     for app.agent, shortcuts are near-instant and per-step OCR is too
    //     slow + unreliable. Final verification uses initial-vs-final diff.
    const tier = await _selectAppTierLLM(
      goal, actionHistory, category, shortcutCount, shortcutLabels,
      currentOcr, null, appFlow, flowIndex, triedTiers
    );

    if (tier === -2) {
      // Verifier needs wait/retry — do not advance flowIndex, just continue
      continue;
    }

    if (tier === 0) {
      // Flow complete — do final initial-vs-final diff verification
      break;
    }

    if (tier === -1) {
      // All tiers exhausted — press Escape + reset
      logger.warn(`[app.runner] runAppFlow: all tiers tried — pressing Escape + resetting`);
      _postProgress(progressCallbackUrl, {
        type: 'app_flow:tier_reset',
        stepIndex,
        flowIndex,
        message: 'All tiers tried — pressing Escape and retrying',
      });
      const nut = await _getNutKeyboard();
      if (nut) {
        await nut.keyboard.pressKey(nut.Key.Escape);
        await nut.keyboard.releaseKey(nut.Key.Escape);
      }
      await _sleep(500);
      triedTiers.clear();
      continue;
    }

    // 5c. Determine step goal from App-Flow or use generic
    const stepGoal = (appFlow && flowIndex < appFlow.length)
      ? appFlow[flowIndex].action || `tier ${tier} action`
      : `tier ${tier} action`;

    // Emit tier selected so the UI shows the current strategy
    const _tierNames = { 1: 'App Shortcut', 2: 'Just-type', 3: 'Global Shortcut', 4: 'Search Text', 5: 'Monitoring' };
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:tier_selected',
      stepIndex,
      flowIndex,
      totalSteps: appFlow?.length || 0,
      tier,
      tierName: _tierNames[tier] || `Tier ${tier}`,
      stepGoal: String(stepGoal).slice(0, 120),
    });

    // 5e. Execute tier
    let stepResult;
    let lastShortcutAction = null;
    let stepActionLabel = '';

    try {
      if (tier === 1) {
        // App Shortcuts — determine which shortcut to use
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : null;
        let shortcutAction = flowAction;
        // Try to extract action name from flow (e.g., "press Cmd+L (focus AI assistant)" → "focus_ai")
        if (flowAction) {
          const actionMatch = flowAction.match(/\(([a-z_ ]+)\)/i);
          if (actionMatch) {
            const label = actionMatch[1].toLowerCase().replace(/\s+/g, '_');
            // Map common labels to semantic actions
            const labelMap = {
              'focus_ai': 'focus_ai', 'focus_ai_assistant': 'focus_ai',
              'quick_open': 'quick_open', 'open_file': 'quick_open',
              'save': 'save', 'open_file_dialog': 'open_file_dialog',
              'select_all': 'select_all', 'copy': 'copy', 'paste': 'paste',
              'find': 'find', 'search': 'find',
            };
            shortcutAction = labelMap[label] || label;
          }
        }
        stepActionLabel = `App Shortcut: ${shortcutAction || 'auto'}`;
        lastShortcutAction = shortcutAction || null;
        // If this is a done/complete/finish sentinel, break the flow instead of
        // trying to execute a non-existent shortcut (which would abort the flow).
        const _DONE_SENTINELS = new Set(['done', 'complete', 'finish', 'end', 'noop']);
        if (shortcutAction && _DONE_SENTINELS.has(shortcutAction.toLowerCase())) {
          logger.info(`[app.runner] runAppFlow: flow-complete sentinel "${shortcutAction}" — breaking loop`);
          flowIndex++;
          break;
        }
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _executeAppShortcut({ appName, action: shortcutAction });

        // Post-focus_ai verification: confirm the AI input panel actually opened.
        // If not, retry the shortcut once after a longer delay. Without this,
        // the subsequent Just-type step types into the void.
        if (shortcutAction === 'focus_ai' && stepResult?.ok) {
          await _sleep(1000); // allow panel animation
          let verifyOcr;
          try { verifyOcr = await _captureOcr({ appName }); } catch (_) { verifyOcr = ''; }
          const hasInput = /(ask|message|prompt|chat|input|type.*here|send|devin|copilot)/i.test(verifyOcr);
          if (!hasInput) {
            logger.warn(`[app.runner] focus_ai verification: no input field detected in OCR — retrying ${shortcutAction}`);
            await _sleep(1500);
            stepResult = await _executeAppShortcut({ appName, action: shortcutAction });
            if (stepResult?.ok) await _sleep(1000);
          } else {
            logger.info(`[app.runner] focus_ai verification: input field detected ✓`);
          }
        }
      } else if (tier === 2) {
        // Just-type — extract value from flow or goal
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : '';
        let value = _extractTypeValueFromFlow(flowAction, goal);
        stepActionLabel = `Just-type: "${String(value).slice(0, 40)}"`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });

        // Verify the target app is focused before typing — prevents typing
        // into the wrong window (e.g. after a shell.run step that opened the
        // app but focus wasn't verified).
        try {
          const appAgent = require('./app.agent.cjs');
          const focusCheck = await appAgent.verifyAppFocused({ appName, waitMs: 500 });
          if (!focusCheck.focused) {
            logger.warn(`[app.runner] runAppFlow: Just-type — ${appName} not focused (detected: "${focusCheck.appName || 'unknown'}"), re-focusing…`);
            const refocus = await _focusApp(appName, { maxRetries: 2, waitMs: 3000 });
            if (!refocus.ok) {
              stepResult = { ok: false, error: `Cannot type: ${appName} is not focused (detected: ${focusCheck.appName || 'unknown'})` };
              lastTier = tier;
              continue;
            }
            await _sleep(500); // brief settle after re-focus
          }
        } catch (e) {
          logger.warn(`[app.runner] runAppFlow: focus check before Just-type failed: ${e.message} — proceeding anyway`);
        }

        stepResult = await _executeJustType({ appName, value, goal, appCategory: category, actionHistory, agentContext });

        // Store baseline screenshot path from Just-Type → Enter for monitoring diff
        if (stepResult?.baselineScreenshotPath) {
          baselineScreenshotPath = stepResult.baselineScreenshotPath;
          logger.info(`[app.runner] runAppFlow: stored baseline screenshot from Just-Type (${baselineScreenshotPath})`);
        }
      } else if (tier === 3) {
        // Global Shortcuts — extract key from flow or default to Enter
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : '';
        let key = 'Enter';
        const keyMatch = flowAction.match(/press\s+(\S+)/i);
        if (keyMatch) key = keyMatch[1];
        stepActionLabel = `Global Shortcut: ${key}`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _executeGlobalShortcut({ appName, key });
      } else if (tier === 4) {
        // Search Text — extract search text from flow or goal
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : '';
        let searchText = _extractSearchTextFromFlow(flowAction, goal);
        stepActionLabel = `Search Text: "${searchText}"`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _executeSearchText({ appName, searchText });
      } else if (tier === 5) {
        // Monitoring — wait for long-running operation
        stepActionLabel = `Monitoring: ${stepGoal}`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        // Extract the user's actual question from the goal signature entities
        // so the LLM verifier can ask "does this text answer THIS question?"
        // instead of the generic step goal "monitor until response received".
        const questionToAsk = signature?.entities?.question || stepGoal;
        stepResult = await _executeMonitoring({
          goal: stepGoal, questionToAsk, appName, mode: 'passive',
          maxDurationMs: Math.min(timeoutMs - (Date.now() - startTime), 300000),
          actionHistory,
          progressCallbackUrl, stepIndex, flowIndex,
          baselineScreenshotPath,
          signal,
        });
        // Reuse monitoring's final OCR as the final diff OCR (saves ~10s capture)
        if (stepResult?.ok && stepResult.summary) {
          finalOcrFromMonitor = stepResult.summary;
        }
      } else if (tier === 6) {
        // shell.run — open file/folder/document, new file, new window, close window, goto line
        const flowStep = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex] : {};
        let subGoal = flowStep.subGoal;
        const flowAction = flowStep.action || '';

        // Last-resort fallback: if subGoal is missing (shouldn't happen after
        // _validateAndFixFlowSubGoals, but defensive for old cached playbooks),
        // infer from action text with broadened patterns.
        if (!subGoal) {
          if (/\bnew\s+(?:file|doc|document|page)\b|\bcreate\s+(?:a\s+|the\s+)?(?:new\s+)?(?:temp|temporary|blank|empty|untitled)\s+(?:file|doc|document)\b/i.test(flowAction)) subGoal = 'new_file';
          else if (/\bnew\s+window\b/i.test(flowAction)) subGoal = 'new_window';
          else if (/\bclose\s+window\b|\bquit\s+app/i.test(flowAction)) subGoal = 'close_window';
          else if (/\b(?:goto|go\s+to)\s+line\b/i.test(flowAction)) subGoal = 'goto_line';
          else subGoal = 'open_file'; // default
          logger.warn(`[app.runner] runAppFlow: tier 6 subGoal missing — inferred "${subGoal}" from action "${flowAction.slice(0, 60)}"`);
        }

        if (subGoal === 'new_file') {
          // new_file via shell.run: create temp file with inferred extension + open in app
          const content = signature?.entities?.content || signature?.entities?.text || '';
          stepActionLabel = `shell.run: new file in ${appName}`;
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:action_start',
            stepIndex, flowIndex, tier, action: stepActionLabel,
          });
          stepResult = await _newFileWithShell(appName, content);
          // Validate that a temp file was actually created and opened
          if (stepResult?.ok && !stepResult.opened) {
            stepResult = { ok: false, error: 'new_file succeeded but no temp file path was returned' };
          }

        } else if (subGoal === 'new_window') {
          // new_window via shell.run: open -n -a "App" or code -n
          stepActionLabel = `shell.run: new window for ${appName}`;
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:action_start',
            stepIndex, flowIndex, tier, action: stepActionLabel,
          });
          stepResult = await _newWindowWithShell(appName);

        } else if (subGoal === 'close_window') {
          // close_window via shell.run: osascript quit app
          stepActionLabel = `shell.run: close ${appName}`;
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:action_start',
            stepIndex, flowIndex, tier, action: stepActionLabel,
          });
          stepResult = await _closeWindowWithShell(appName);

        } else if (subGoal === 'goto_line') {
          // goto_line via shell.run: code -g <file:line> (falls back to tier 1 Ctrl+G if no file path)
          const lineNumber = signature?.entities?.lineNumber || signature?.entities?.line;
          let filename = resolvedFilePath || signature?.entities?.filename;
          // Fallback: check for pre-resolved file path injected into goal text
          if (!filename) {
            const resolvedMatch = goal.match(/\[Resolved file path:\s*(\S+)\]/);
            if (resolvedMatch) filename = resolvedMatch[1];
          }
          // Fallback: extract any absolute or relative path with a file extension from the goal
          if (!filename) {
            const goalMatch = goal.match(/(\S*\/[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9]+)+)/);
            if (goalMatch) filename = goalMatch[1];
          }
          const gotoResult = await _gotoLineWithShell(appName, filename, lineNumber);
          if (gotoResult === null) {
            // Not supported (no file path or app doesn't support -g) — fall back to tier 1 Ctrl+G
            stepActionLabel = `App Shortcut: goto_line (fallback from shell.run)`;
            _postProgress(progressCallbackUrl, {
              type: 'app_flow:action_start',
              stepIndex, flowIndex, tier: 1, action: stepActionLabel,
            });
            stepResult = await _executeAppShortcut({ appName, action: 'goto_line' });
          } else {
            stepActionLabel = `shell.run: goto line ${lineNumber} in ${filename || appName}`;
            _postProgress(progressCallbackUrl, {
              type: 'app_flow:action_start',
              stepIndex, flowIndex, tier, action: stepActionLabel,
            });
            stepResult = gotoResult;
          }

        } else {
          // Default: open file/folder/document via shell.run (open_file, open_folder, open_document)
          // Prefer structured resolved file path from preflight (passed through
          // planSkillsV2 → app.agent → runAppFlow). This avoids re-parsing the
          // goal text with regex, which is brittle and can match the wrong
          // quoted string (e.g. the app name instead of the file path).
          let filename = resolvedFilePath
            || signature?.entities?.filename;
          // Fallback: check for pre-resolved file path injected into goal text
          if (!filename) {
            const resolvedMatch = goal.match(/\[Resolved file path:\s*(\S+)\]/);
            if (resolvedMatch) filename = resolvedMatch[1];
          }
          // Fallback: extract any absolute or relative path with a file extension from the goal
          if (!filename) {
            const goalMatch = goal.match(/(\S*\/[A-Za-z0-9_\-]+(?:\.[A-Za-z0-9]+)+)/);
            if (goalMatch) filename = goalMatch[1];
          }
          // Last resort: parse the flow action, skipping the app-name quote and taking the path quote
          if (!filename && flowAction) {
            const pathMatch = flowAction.match(/open -a '[^']+' '([^']+)'/);
            if (pathMatch) filename = pathMatch[1];
          }
          stepActionLabel = `shell.run: open "${filename}" in ${appName}`;
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:action_start',
            stepIndex, flowIndex, tier, action: stepActionLabel,
          });
          stepResult = await _openFileWithShell(appName, filename);
        }
      }
    } catch (e) {
      stepResult = { ok: false, error: e.message };
    }

    // 5f. Verify step — for app.agent, shortcuts are near-instant; trust the
    //     step result + delay. No per-step OCR capture (too slow, unreliable
    //     for subtle focus changes, and falsely declares "done" mid-flow).
    //     Final verification is done via initial-vs-final diff after the loop.
    if (stepResult?.ok) {
      actionHistory.push(`${stepActionLabel} → done`);
      _postProgress(progressCallbackUrl, {
        type: 'app_flow:action_done',
        stepIndex, flowIndex, tier, ok: true, action: stepActionLabel,
      });
      flowIndex++;
      triedTiers.clear();
    } else {
      actionHistory.push(`${stepActionLabel} → FAILED (${stepResult?.error || 'unknown'})`);
      _postProgress(progressCallbackUrl, {
        type: 'app_flow:action_done',
        stepIndex, flowIndex, tier, ok: false, action: stepActionLabel,
        error: stepResult?.error || 'unknown',
      });
      triedTiers.add(tier);
      // Retry budget: abort the flow if the same step fails 2+ times
      const _failKey = `${tier}:${stepActionLabel}`;
      stepFailures[_failKey] = (stepFailures[_failKey] || 0) + 1;
      if (stepFailures[_failKey] >= 2) {
        logger.error(`[app.runner] runAppFlow: aborting after repeated failure of "${stepActionLabel}" (${stepFailures[_failKey]}x)`);
        if (signature) _markPlaybookCacheFail(appName, signature);
        return { ok: false, error: stepResult?.error || `Failed step: ${stepActionLabel}`, elapsed: Date.now() - startTime };
      }
    }

    // 5h. Brief pause between steps — focus_ai opens panels/views that need
    //     time to animate and focus their input, so wait longer after those.
    //     After open_file (tier 6), the app needs time to load the file before
    //     subsequent shortcuts (e.g. focus_ai) can work.
    const _settleMs = (lastShortcutAction === 'focus_ai') ? 1500
      : (lastTier === 6) ? 2000
      : 500;
    lastTier = tier;
    await _sleep(_settleMs);
  }

  // 6. Final verification — initial-vs-final diff
  //    Capture final OCR, diff against initial, test the diff against the goal.
  //    No-diff means the flow had no effect (failure). Diff is tested to verify
  //    the goal was achieved.
  const timedOut = Date.now() - startTime >= timeoutMs;
  if (timedOut) {
    logger.warn(`[app.runner] runAppFlow: timeout after ${Date.now() - startTime}ms`);
    if (signature) _markPlaybookCacheFail(appName, signature);
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:done',
      stepIndex, ok: false, error: 'App-Flow timeout',
      actionHistory,
    });
    return { ok: false, error: 'App-Flow timeout', actionHistory, elapsed: Date.now() - startTime };
  }

  logger.info(`[app.runner] runAppFlow: flow complete — capturing final OCR for diff verification`);
  const finalOcr = finalOcrFromMonitor || await _captureOcr({ appName });
  if (finalOcrFromMonitor) {
    logger.info(`[app.runner] runAppFlow: reusing monitoring's final OCR (${finalOcrFromMonitor.length} chars) — skipping extra capture`);
  }
  const diff = _diffOcrText(initialOcr, finalOcr);
  logger.info(`[app.runner] runAppFlow: initial-vs-final diff (${diff.length} chars of new/changed content)`);

  if (!diff || diff.trim().length === 0) {
    // No change between initial and final state — flow did nothing
    logger.warn(`[app.runner] runAppFlow: initial vs final state identical — flow had no effect`);
    if (signature) _markPlaybookCacheFail(appName, signature);
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:done',
      stepIndex, ok: false, error: 'No state change detected between initial and final screen',
      actionHistory,
    });
    return { ok: false, error: 'No state change detected between initial and final screen', actionHistory, elapsed: Date.now() - startTime };
  }

  // Test the diff (new/changed content) against the goal
  const goalVerify = await _ocrVerifyAppGoal(diff, goal, actionHistory);
  if (goalVerify.num === 1) {
    logger.info(`[app.runner] runAppFlow: DONE — goal achieved (diff verified)`);
    _postProgress(progressCallbackUrl, {
      type: 'app_flow:done',
      stepIndex, ok: true, flowIndex, totalSteps: appFlow?.length || 0, actionHistory,
    });
    return { ok: true, output: diff.slice(0, 500), actionHistory, elapsed: Date.now() - startTime };
  }

  // Diff exists but goal not verified — return the diff anyway (partial success)
  logger.warn(`[app.runner] runAppFlow: flow complete but goal not verified (num=${goalVerify.num})`);
  _postProgress(progressCallbackUrl, {
    type: 'app_flow:done',
    stepIndex, ok: true, flowIndex, totalSteps: appFlow?.length || 0, actionHistory,
    verified: false,
  });
  return { ok: true, output: diff.slice(0, 500), actionHistory, elapsed: Date.now() - startTime, verified: false };
}

// ── Flow Action Extraction Helpers ───────────────────────────────────────────

function _extractTypeValueFromFlow(flowAction, goal) {
  if (!flowAction) return goal || '';
  // Try to extract text between quotes: type 'value' or type "value"
  const singleQuoteMatch = flowAction.match(/type\s+'([^']+)'/i);
  if (singleQuoteMatch) return singleQuoteMatch[1];
  const doubleQuoteMatch = flowAction.match(/type\s+"([^"]+)"/i);
  if (doubleQuoteMatch) return doubleQuoteMatch[1];
  // If no quoted value found, use the goal as the value
  return goal || '';
}

function _extractSearchTextFromFlow(flowAction, goal) {
  if (!flowAction) return goal || '';
  // Try to extract text between quotes: find 'value' or search for 'value'
  const singleQuoteMatch = flowAction.match(/(?:find|search(?:\s+for)?)\s+'([^']+)'/i);
  if (singleQuoteMatch) return singleQuoteMatch[1];
  const doubleQuoteMatch = flowAction.match(/(?:find|search(?:\s+for)?)\s+"([^"]+)"/i);
  if (doubleQuoteMatch) return doubleQuoteMatch[1];
  return goal || '';
}

// ── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  runAppFlow,
  _computeAppFlowV2,
  _selectAppTierLLM,
  _extractAppFieldType,
  _ocrVerifyAppStep,
  _ocrVerifyAppGoal,
  _executeJustType,
  _executeAppTypePlain,
  _executeAppTypeCommands,
  _executeAppTypeEdit,
  _executeAppTypeSearch,
  _executeAppTypeListItem,
  _executeAppShortcut,
  _executeGlobalShortcut,
  _executeSearchText,
  _executeMonitoring,
  _ocrVerifyMonitorState,
  _executeMonitorFileUpload: _executeMonitoring, // specialized variants use same force-classification
  _executeMonitorBuildCompletion: _executeMonitoring,
  _executeMonitorFormSubmission: _executeMonitoring,
  _loadPlaybookCache,
  _savePlaybookCache,
  _extractGoalSignature,
  _computeAppFlowV2,
  _researchMissingShortcut,
  _openFileWithShell,
  _newFileWithShell,
  _newWindowWithShell,
  _closeWindowWithShell,
  _gotoLineWithShell,
  _inferFileExtension,
  _resolveFilePath,
  _subGoalToTier,
  _inferSubGoalFromAction,
  _countNonDoneStepsBefore,
  _validateAndFixFlowSubGoals,
};
