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
      path:     parsed.pathname,
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

// ── Goal Signature Extraction ───────────────────────────────────────────────
// LLM extracts the goal-type + sub-goals + entities from the goal text.
// No app-specific examples — generic action names only.

async function _extractGoalSignature(goal, appName, category) {
  const systemPrompt = `You analyze a desktop automation goal and extract its sub-goal signature.
Return JSON only:
{
  "type": "examine_file" | "send_message" | "create_doc" | "search" | "navigate" | "open_app" | "monitor" | "custom",
  "subGoals": ["open_file", "focus_ai", "ask_question", "monitor_response"],
  "entities": { "filename": "instruction.runner.cjs", "question": "what is this file about" }
}

Rules:
- "subGoals" are GENERIC action names (not app-specific): open_file, focus_ai, ask_question, type_value, press_enter, monitor_response, save, copy, paste, find, scroll, etc.
- "entities" are the concrete values extracted from the goal (filenames, questions, search terms, etc.) — these get swapped when reusing a cached playbook.
- "type" is a coarse classification for cache lookup.

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

// ── Sub-Goal → Tier mapping ──────────────────────────────────────────────────
// Maps semantic sub-goal names (from _extractGoalSignature) to App-Flow tiers.
// Tier 6 = shell.run (open file/folder/document — more reliable than quick-open).
const _subGoalToTier = {
  // File / app operations
  open_file:        6,   // shell.run (open -a "<App>" "<path>")
  open_folder:      6,   // shell.run
  open_document:    6,   // shell.run
  focus_ai:         1,   // App Shortcut: focus_ai (per-app: Cmd+L for Devin/VS Code, Option+Shift+C for Teams, etc.)
  quick_open:       1,   // App Shortcut: quick_open (per-app: Cmd+P for editors, Cmd+L for browsers)
  save:             1,   // App Shortcut: save (Cmd+S — universal)
  new_tab:          1,   // App Shortcut: new_tab (Cmd+T — most apps)
  close_window:     1,   // App Shortcut: close_window (Cmd+W — most apps)
  new_message:      1,   // App Shortcut: new_message (Cmd+N — most chat apps)
  quick_switcher:   1,   // App Shortcut: quick_switcher (Cmd+K — Slack, Telegram)

  // Editing operations (system-wide keyboard shortcuts)
  select_all:       1,   // Cmd+A — works in all text fields / document views
  highlight_all_text: 1, // alias for select_all
  copy:             1,   // Cmd+C — works when text is selected
  paste:            1,   // Cmd+V — works in all text fields
  cut:              1,   // Cmd+X — works when text is selected
  undo:             1,   // Cmd+Z — works in most apps
  redo:             1,   // Cmd+Shift+Z — works in most apps
  find:             1,   // Cmd+F — universalFind, works in most apps

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
  try {
    // Search common project roots for the file by basename
    const searchRoots = [
      process.cwd(),
      path.join(os.homedir(), 'Desktop', 'projects'),
      path.join(os.homedir(), 'Desktop'),
      os.homedir(),
    ];
    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      try {
        const found = execSync(`find "${root}" -name "${filename}" -type f -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -1`, {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        if (found) {
          _pathSearchCache.set(filename, found);
          return found;
        }
      } catch (_) { /* ignore find errors */ }
    }
  } catch (_) { /* ignore */ }

  // Fallback — return the filename as-is (shell.run will fail if it doesn't exist)
  return filename;
}

// ── Open file/folder/document via shell.run ──────────────────────────────────
// Uses `open -a "<App>" "<path>"` on macOS, `start` on Windows, `xdg-open` on Linux.
// More reliable than quick-open shortcuts (Cmd+P) because it doesn't depend on
// the app's quick-open index or shortcut bindings.

async function _openFileWithShell(appName, filename) {
  const { shellRun } = require('./shell.run.cjs');
  const resolved = _resolveFilePath(filename);
  if (!resolved) {
    return { ok: false, error: `Could not resolve file path for "${filename}"` };
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
6 = shell.run (open a file/folder/document in the app via shell command — more reliable than quick-open)
0 = Done (goal achieved)

Sub-goal → tier mapping (use this to decide the tier for each sub-goal):
- open_file / open_folder / open_document → tier 6 (shell.run: open -a "<App>" "<path>")
- focus_ai / quick_open / save / new_tab / close_window / new_message / quick_switcher → tier 1 (use the matching shortcut)
- select_all / copy / paste / cut / undo / redo / find → tier 1 (use the matching shortcut)
- type_value → tier 2 (type the value into the focused field)
- ask_question → tier 1 (focus_ai shortcut), then tier 2 (type the question)
- press_enter / press_tab / press_escape / press_arrow → tier 3
- monitor_response → tier 5
- done → tier 0

Mapping rules:
- For open_file/open_folder/open_document → tier 6, action = "open -a '<App>' '<filename>' via shell.run"
- If a sub-goal has a matching shortcut → tier 1, action = "press <shortcut> (<action>)"
- If a sub-goal needs typing a value → tier 2, action = "type '<value>' (<sub-mode>)"
  Sub-modes: type-plain (chat/simple), type-commands (/slash), type-edit (long-form/code), type-search (@mentions/pickers), type-list-item (todos), type-filter (quick-open file picker)
- If a sub-goal needs a global key (Enter, Tab, Escape) → tier 3, action = "press <key>"
- If a sub-goal needs monitoring a long-running op → tier 5, action = "monitor until <condition>"
- End with tier 0, action = "done"

CRITICAL RULES:
- Tier 6 (shell.run) is the PRIMARY way to open files/folders/documents. Do NOT use quick_open (Cmd+P) for opening files — use tier 6 instead.
- Tier 1 (App Shortcuts) is the PRIMARY tier for in-app actions (80-90% of use). Prefer it when a shortcut can accomplish the sub-goal.
- Tier 2 (Just-type) is for typing into the currently focused field. Use AFTER a tier 1 shortcut has focused the field.
- Tier 3 (Global Shortcuts) is a fallback for navigation (Enter to confirm, Escape to close, Tab between fields).
- Tier 5 (Monitoring) is for waiting on long-running operations. Use AFTER an action that triggers a long-running process.
- Use the entities from the goal signature to fill in concrete values (filenames, questions, etc.).
- Be specific about what action each tier should take. For tier 2, include the sub-mode in parentheses.
- Output ONLY the JSON array, no other text.

Output format: JSON array of steps, each with:
- state: expected app state description
- tier: tier number (0, 1, 2, 3, 4, 5, or 6)
- action: what the tier should do`;

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

// ── Check if all sub-goals have matching shortcuts ───────────────────────────
// Returns list of sub-goals that have NO matching shortcut action AND are not
// handled by tier 6 (shell.run) or other non-shortcut tiers.

// Sub-goals that don't need a shortcut (handled by other tiers)
const _subGoalsWithoutShortcuts = new Set([
  'open_file', 'open_folder', 'open_document',  // tier 6 (shell.run)
  'type_value',                                  // tier 2 (just-type)
  'press_enter', 'press_tab', 'press_escape', 'press_arrow', // tier 3 (global keys)
  'monitor_response',                            // tier 5 (monitoring)
  'done',                                        // tier 0
]);

// Map sub-goal names to shortcut action names (for the ones that DO use shortcuts)
const _subGoalToShortcutAction = {
  focus_ai: 'focus_ai',
  quick_open: 'quick_open',
  save: 'save',
  new_tab: 'new_tab',
  close_window: 'close_window',
  new_message: 'new_message',
  quick_switcher: 'quick_switcher',
  select_all: 'select_all',
  highlight_all_text: 'select_all',
  copy: 'copy',
  paste: 'paste',
  cut: 'cut',
  undo: 'undo',
  redo: 'redo',
  find: 'find',
  ask_question: 'focus_ai',  // ask_question uses focus_ai shortcut
};

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
  // 1. DONE check (only if we've taken actions) — deterministic first
  if (actionHistory.length > 0) {
    const doneResult = await _ocrVerifyAppGoal(currentOcrText, goal, actionHistory);
    if (doneResult.num === 1) return 0;
    if (doneResult.num === 2) return 0; // wait → caller handles sleep, but tier 0 means "no action needed this iteration"
  }

  // 2. Build available tiers (exclude tried tiers)
  const _availableTiers = [1, 2, 3, 4, 5, 6].filter(t => !triedTiers.has(t));

  // If all tiers are tried, return -1 to signal exhaustion
  if (_availableTiers.length === 0) {
    logger.warn(`[app.runner] _selectAppTierLLM: all tiers tried — returning -1 (exhaustion)`);
    return -1;
  }

  // 3. App-Flow fast-path — if we have a pre-computed flow and the current state
  //    matches the expected state, skip the LLM call and use the flow's tier.
  if (appFlow && flowIndex < appFlow.length) {
    const _expected = appFlow[flowIndex];
    if (_expected.tier !== 0 && _availableTiers.includes(_expected.tier)) {
      logger.info(`[app.runner] _selectAppTierLLM: App-Flow fast-path → ${_expected.tier} (flow step ${flowIndex}: ${_expected.action || ''})`);
      return _expected.tier;
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
6 = shell.run (open a file/folder/document in the app via shell command)

Decision rules:
- If a file/folder/document needs to be opened → return 6 (shell.run is more reliable than quick-open)
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
      return { ok: true, typed: value, subMode: 'type-search', note: 'no dropdown — submitted as plain search' };
    }

    // 3. Press Enter to select top match
    await keyboard.pressKey(Key.Return);
    await keyboard.releaseKey(Key.Return);
    logger.info(`[app.runner] type-search: pressed Enter to select match for "${plan.query}"`);

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
${(ocrText || '').slice(0, 500)}
Actions taken:
${historyStr}

Number (0-2)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000, taskType: 'classification' });

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

async function _ocrVerifyMonitorState(ocrText, goal, appName) {
  const systemPrompt = `You verify the state of a long-running operation in a desktop app by looking at the OCR text.
Return ONLY a single number — nothing else:
0 = not sure (cannot determine — OCR is jumbled, incomplete, or unclear)
1 = still processing (spinner, "thinking", "working", streaming text, progress bar, live timer)
2 = done (response complete, build finished, upload complete — final state is visible)
3 = error (clear failure — error message, crash, "failed", "cancelled")

Rules:
- 2 (done): the OCR shows the final result (complete answer, "build succeeded", "upload complete", success toast). The input box is ready/enabled again. No spinner/progress/timer is still running.
- 1 (still processing): the OCR shows a spinner, "thinking", "working", "generating", streaming text, a progress bar, or a live elapsed timer. The input box is disabled or a "Stop"/"Cancel" button is visible.
- 0 (not sure): the OCR is jumbled, truncated, or unclear. Do NOT guess — return 0 so the system retries the capture.
- 3 (error): the OCR shows an explicit error message, crash, "failed", "cancelled", or "timed out".
- When in doubt → return 0 (not sure, retry)`;

  const userPrompt = `Goal: ${goal}
App: ${appName || 'unknown'}
OCR text (first 500 chars): ${(ocrText || '').slice(0, 500)}

Number (0-3)?`;

  try {
    const raw = await askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { maxTokens: 5, temperature: 0, responseTimeoutMs: 5000, taskType: 'classification' });

    const _cleanRaw = (raw || '').toLowerCase().trim();
    if (!_cleanRaw) return { num: 0, reason: 'llm-empty-response' };
    const _numMatch = _cleanRaw.match(/\b([0123])\b/);
    const num = _numMatch ? parseInt(_numMatch[1], 10) : NaN;
    if (num >= 0 && num <= 3) {
      logger.info(`[app.runner] _ocrVerifyMonitorState: ${num} for goal="${String(goal).slice(0, 60)}"`);
      return { num, reason: ['not-sure', 'still-processing', 'done', 'error'][num] };
    }
    return { num: 0, reason: 'invalid-llm-response' };
  } catch (e) {
    logger.warn(`[app.runner] _ocrVerifyMonitorState failed: ${e.message}`);
    return { num: 0, reason: 'llm-provider-failure' };
  }
}

async function _executeMonitoring({ goal, appName, mode = 'passive', maxDurationMs = 300000, actionHistory }) {
  logger.info(`[app.runner] _executeMonitoring: goal="${String(goal).slice(0, 60)}", mode=${mode}, maxDuration=${maxDurationMs}ms`);

  const startTime = Date.now();
  let checkInterval = 10000; // 10s initial
  let llmCalls = 0;
  const MAX_LLM_CALLS = 20;
  let stableCount = 0;
  let sawProgress = false;
  const STABLE_POLLS_FOR_COMPLETION = 2;
  const CHANGE_THRESHOLD = 0.90;

  // Simple text-based change detection (no embeddings — keep it lightweight)
  let baselineText = await _captureOcr({ appName });

  while (Date.now() - startTime < maxDurationMs) {
    await _sleep(checkInterval);
    if (llmCalls >= MAX_LLM_CALLS) {
      logger.warn(`[app.runner] _executeMonitoring: hit LLM call limit (${MAX_LLM_CALLS}) — returning timeout`);
      return { ok: false, error: 'Monitoring LLM call limit reached', llmCalls, elapsed: Date.now() - startTime, finalStatus: 0 };
    }

    const currentText = await _captureOcr({ appName });
    if (!currentText || currentText.trim().length < 10) {
      logger.warn(`[app.runner] _executeMonitoring: empty OCR — retrying quickly`);
      checkInterval = 3000;
      continue;
    }

    // Detect change (simple text comparison)
    const changed = currentText !== baselineText;

    if (!changed) {
      // Screen is STABLE — check completion
      stableCount++;
      const shouldCheckCompletion =
        stableCount >= STABLE_POLLS_FOR_COMPLETION &&
        (sawProgress || stableCount >= STABLE_POLLS_FOR_COMPLETION * 2) &&
        llmCalls < MAX_LLM_CALLS;

      if (shouldCheckCompletion) {
        stableCount = 0;
        llmCalls++;
        const stateResult = await _ocrVerifyMonitorState(currentText, goal, appName);
        if (stateResult.num === 2) {
          logger.info(`[app.runner] _executeMonitoring: stability completion confirmed — ${stateResult.reason}`);
          return { ok: true, summary: currentText, llmCalls, elapsed: Date.now() - startTime, finalStatus: 2 };
        }
        if (stateResult.num === 3) {
          return { ok: false, error: currentText, llmCalls, elapsed: Date.now() - startTime, finalStatus: 3 };
        }
        // 0 (not sure) or 1 (still processing) — continue polling
      }

      // Back off
      checkInterval = mode === 'active'
        ? Math.min(checkInterval * 1.2, 30000)
        : Math.min(checkInterval * 1.5, 60000);
      continue;
    }

    // Screen changed → progress
    sawProgress = true;
    stableCount = 0;
    baselineText = currentText;

    // Check state on change
    llmCalls++;
    const stateResult = await _ocrVerifyMonitorState(currentText, goal, appName);
    if (stateResult.num === 2) {
      logger.info(`[app.runner] _executeMonitoring: completion confirmed on change — ${stateResult.reason}`);
      return { ok: true, summary: currentText, llmCalls, elapsed: Date.now() - startTime, finalStatus: 2 };
    }
    if (stateResult.num === 3) {
      return { ok: false, error: currentText, llmCalls, elapsed: Date.now() - startTime, finalStatus: 3 };
    }
    // 0 (not sure) or 1 (still processing) — reset interval and continue
    checkInterval = 10000;
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

async function runAppFlow({ goal, appName, category, bounds, shortcuts, timeoutMs = 120000, agentContext = null, progressCallbackUrl = null, stepIndex = 0 }) {
  if (!goal) return { ok: false, error: 'goal is required' };
  if (!appName) return { ok: false, error: 'appName is required' };

  const appAgent = require('./app.agent.cjs');
  const startTime = Date.now();
  const actionHistory = [];
  let triedTiers = new Set();
  let flowIndex = 0;

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

  // 2. Capture initial OCR state
  let currentOcr = await _captureOcr({ appName });
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
      appFlow = cached.playbook;
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
      _savePlaybookCache(appName, signature, appFlow, signature.entities);
    }
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
    // 5a. Capture current OCR
    currentOcr = await _captureOcr({ appName });

    // 5b. Select tier (force classification)
    const tier = await _selectAppTierLLM(
      goal, actionHistory, category, shortcutCount, shortcutLabels,
      currentOcr, null, appFlow, flowIndex, triedTiers
    );

    if (tier === 0) {
      // Done
      logger.info(`[app.runner] runAppFlow: DONE — goal achieved`);
      _postProgress(progressCallbackUrl, {
        type: 'app_flow:done',
        stepIndex,
        ok: true,
        flowIndex,
        totalSteps: appFlow?.length || 0,
        actionHistory,
      });
      return { ok: true, output: currentOcr.slice(0, 500), actionHistory, elapsed: Date.now() - startTime };
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

    // 5c. Capture before-OCR for step verification
    const beforeOcr = currentOcr;

    // 5d. Determine step goal from App-Flow or use generic
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
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _executeAppShortcut({ appName, action: shortcutAction });
      } else if (tier === 2) {
        // Just-type — extract value from flow or goal
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : '';
        let value = _extractTypeValueFromFlow(flowAction, goal);
        stepActionLabel = `Just-type: "${String(value).slice(0, 40)}"`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _executeJustType({ appName, value, goal, appCategory: category, actionHistory, agentContext });
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
        stepResult = await _executeMonitoring({
          goal: stepGoal, appName, mode: 'passive',
          maxDurationMs: Math.min(timeoutMs - (Date.now() - startTime), 300000),
          actionHistory,
        });
      } else if (tier === 6) {
        // shell.run — open file/folder/document via shell command
        const flowAction = (appFlow && flowIndex < appFlow.length) ? appFlow[flowIndex].action : '';
        // Extract filename from flow action or entities
        let filename = signature?.entities?.filename;
        if (!filename) {
          const fnMatch = flowAction.match(/'([^']+)'/);
          if (fnMatch) filename = fnMatch[1];
        }
        if (!filename) {
          // Try to extract from goal
          const goalMatch = goal.match(/(\S+\.\S+)/);
          if (goalMatch) filename = goalMatch[1];
        }
        stepActionLabel = `shell.run: open "${filename}" in ${appName}`;
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_start',
          stepIndex, flowIndex, tier, action: stepActionLabel,
        });
        stepResult = await _openFileWithShell(appName, filename);
      }
    } catch (e) {
      stepResult = { ok: false, error: e.message };
    }

    // 5f. Capture after-OCR (skip for tier 5 — monitor already captured final state)
    const afterOcr = tier === 5 ? (stepResult?.summary || '') : await _captureOcr({ appName });

    // 5g. Verify step (before/after diff)
    if (tier === 5) {
      // Monitoring tier — its result IS the verification
      if (stepResult?.ok) {
        actionHistory.push(`${stepActionLabel} → verified (monitor complete)`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: true, action: stepActionLabel,
          message: 'Monitoring complete',
        });
        flowIndex++;
        triedTiers.clear();
        // Check if this was the last step
        if (appFlow && flowIndex >= appFlow.length) {
          logger.info(`[app.runner] runAppFlow: App-Flow complete after monitoring`);
          _postProgress(progressCallbackUrl, {
            type: 'app_flow:done',
            stepIndex, ok: true, flowIndex, totalSteps: appFlow.length, actionHistory,
          });
          return { ok: true, output: stepResult.summary?.slice(0, 500) || '', actionHistory, elapsed: Date.now() - startTime };
        }
      } else {
        actionHistory.push(`${stepActionLabel} → FAILED (${stepResult?.error || 'monitor failed'})`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: false, action: stepActionLabel,
          error: stepResult?.error || 'monitor failed',
        });
        triedTiers.add(tier);
        if (signature) _markPlaybookCacheFail(appName, signature);
      }
    } else if (tier === 6) {
      // shell.run tier — step result IS the verification (open command succeeded or not)
      if (stepResult?.ok) {
        actionHistory.push(`${stepActionLabel} → verified (file opened)`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: true, action: stepActionLabel,
        });
        flowIndex++;
        triedTiers.clear();
      } else {
        actionHistory.push(`${stepActionLabel} → FAILED (${stepResult?.error || 'open failed'})`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: false, action: stepActionLabel,
          error: stepResult?.error || 'open failed',
        });
        triedTiers.add(tier);
      }
    } else {
      // Other tiers — verify via before/after OCR diff
      const stepVerify = await _ocrVerifyAppStep(beforeOcr, afterOcr, stepGoal, actionHistory);
      if (stepVerify.num === 1) {
        // Step succeeded
        actionHistory.push(`${stepActionLabel} → verified`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: true, action: stepActionLabel,
        });
        flowIndex++;
        triedTiers.clear();
      } else if (stepVerify.num === 2) {
        // Loading — wait and retry
        actionHistory.push(`${stepActionLabel} → loading`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: true, action: stepActionLabel,
          status: 'loading', message: 'Page loading — waiting…',
        });
        await _sleep(1000);
      } else {
        // Step failed — mark tier as tried
        actionHistory.push(`${stepActionLabel} → FAILED (${stepVerify.reason})`);
        _postProgress(progressCallbackUrl, {
          type: 'app_flow:action_done',
          stepIndex, flowIndex, tier, ok: false, action: stepActionLabel,
          error: stepVerify.reason || 'verification failed',
        });
        triedTiers.add(tier);
      }
    }

    // 5h. Brief pause between steps
    await _sleep(500);
  }

  // Timeout
  logger.warn(`[app.runner] runAppFlow: timeout after ${Date.now() - startTime}ms`);
  if (signature) _markPlaybookCacheFail(appName, signature);
  _postProgress(progressCallbackUrl, {
    type: 'app_flow:done',
    stepIndex, ok: false, error: 'App-Flow timeout',
    actionHistory,
  });
  return { ok: false, error: 'App-Flow timeout', actionHistory, elapsed: Date.now() - startTime };
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
  _resolveFilePath,
  _subGoalToTier,
};
