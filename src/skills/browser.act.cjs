'use strict';

/**
 * skill: browser.act
 *
 * Pure terminal browser automation — 100% playwright-cli subprocess calls.
 * No Playwright Node API. No npm packages. Just playwright-cli + shell.
 *
 * Binary: /opt/homebrew/bin/playwright-cli  (brew install playwright-cli)
 * Sessions: -s=<sessionId> keeps a browser alive between calls.
 * Snapshot: captures accessibility tree with numbered refs (e1, e21, …)
 *           used for ref-based click/fill/hover/select.
 *
 * Actions supported:
 *   navigate | goto | back | forward | reload | close | snapshot
 *   click | dblclick | fill | type | hover | select | check | uncheck | upload
 *   keyboard | press | scroll | screenshot | pdf
 *   getText | getPageText | evaluate | scanCurrentPage
 *   waitForSelector | waitForContent | waitForStableText
 *   tab-new | tab-list | tab-close | tab-select
 *   state-save | state-load | resize
 *
 * Args schema:
 * {
 *   action:     string   — action name
 *   sessionId:  string   — browser session id (default: 'default')
 *   url:        string   — URL for navigate/goto
 *   selector:   string   — element ref (e1, e21) or label to resolve via snapshot
 *   text:       string   — text to type/fill
 *   key:        string   — key for keyboard/press actions
 *   value:      string   — option value for select
 *   dx:         number   — horizontal scroll delta
 *   dy:         number   — vertical scroll delta
 *   width:      number   — width for resize
 *   height:     number   — height for resize
 *   filePath:   string   — path for screenshot/pdf/state-save/state-load
 *   headed:     boolean  — show browser window (default: true)
 *   timeoutMs:  number   — per-action timeout ms (default: 15000)
 * }
 *
 * Returns: { ok, action, sessionId, result?, stdout?, error?, executionTime }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');

// Generic debugging control for all playwright-cli tools
const playwrightDebugEnabled = process.env.PLAYWRIGHT_DEBUG === 'true' || 
                              process.env.PLAYWRIGHT_DEBUG === 'on' || 
                              process.env.PLAYWRIGHT_DEBUG === '1';

function shouldEnableDebugging(sessionId, action = null) {
  // Generic debugging control for all sessions and agents
  return playwrightDebugEnabled;
}

function getDebugConfig(sessionId, action) {
  const baseConfig = {
    console: playwrightDebugEnabled,
    network: playwrightDebugEnabled,
    tracing: playwrightDebugEnabled,
    video: playwrightDebugEnabled,
    devTools: playwrightDebugEnabled
  };
  
  // Agent-specific adjustments can be added here if needed
  return baseConfig;
}

// ---------------------------------------------------------------------------
// Debugging Tracing Infrastructure
// ---------------------------------------------------------------------------

// Track active debugging sessions
const debuggingSessions = new Map(); // sessionId -> debug data

// Debug data structure for each session
function createDebugSession(sessionId) {
  return {
    sessionId,
    startTime: Date.now(),
    tracingActive: false,
    videoActive: false,
    devToolsActive: false,
    traceFile: null,
    videoFile: null,
    devToolsUrl: null,
    snapshots: [],
    networkErrors: [],
    consoleErrors: [],
    actionHistory: [],
    devToolsData: {
      networkRequests: [],
      consoleLogs: [],
      performanceMetrics: {}
    }
  };
}

// Start debugging tracing for a session
async function startSessionTracing(sessionId) {
  if (!shouldEnableDebugging(sessionId)) {
    logger.debug(`[browser.act] Debugging disabled for ${sessionId} (PLAYWRIGHT_DEBUG=${process.env.PLAYWRIGHT_DEBUG})`);
    return;
  }
  
  if (debuggingSessions.has(sessionId)) {
    logger.debug(`[browser.act] Debugging session already exists for ${sessionId}`);
    return;
  }

  const debugSession = {
    sessionId,
    startTime: Date.now(),
    tracingActive: false,
    videoActive: false,
    devToolsActive: false,
    devToolsUrl: null,
    traceFile: null,
    videoFile: null,
    snapshots: [],
    networkErrors: [],
    consoleErrors: [],
    actionHistory: [],
    devToolsData: {
      networkRequests: [],
      consoleLogs: [],
      performanceMetrics: {}
    }
  };

  debuggingSessions.set(sessionId, debugSession);
  logger.info(`[browser.act] Started debugging session for ${sessionId}`);

  // Start tracing
  try {
    const traceResult = await cliRun([...sessionFlags(sessionId), 'tracing-start'], 5000);
    if (traceResult.ok) {
      debugSession.tracingActive = true;
      logger.info(`[browser.act] Started tracing for session=${sessionId}`);
    } else {
      logger.warn(`[browser.act] Failed to start tracing for session=${sessionId}: ${traceResult.error}`);
    }
  } catch (error) {
    logger.warn(`[browser.act] Failed to start tracing for session=${sessionId}: ${error.message}`);
  }

  // Start video recording
  try {
    const videoResult = await cliRun([...sessionFlags(sessionId), 'video-start'], 5000);
    if (videoResult.ok) {
      debugSession.videoActive = true;
      logger.info(`[browser.act] Started video recording for session=${sessionId}`);
    } else {
      logger.warn(`[browser.act] Failed to start video recording for session=${sessionId}: ${videoResult.error}`);
    }
  } catch (error) {
    logger.warn(`[browser.act] Failed to start video recording for session=${sessionId}: ${error.message}`);
  }

  // Start DevTools for enhanced debugging
  try {
    const devToolsResult = await cliRun([...sessionFlags(sessionId), 'devtools-start'], 5000);
    if (devToolsResult.ok) {
      // Extract WebSocket URL from DevTools output
      const devToolsOutput = devToolsResult.stdout || '';
      const urlMatch = devToolsOutput.match(/Server is listening on:\s*(ws:\/\/[^\s]+)/);
      if (urlMatch) {
        const devToolsUrl = urlMatch[1].trim();
        debugSession.devToolsActive = true;
        debugSession.devToolsUrl = devToolsUrl;
        logger.info(`[browser.act] Started DevTools for session=${sessionId}, URL: ${devToolsUrl}`);
      } else {
        logger.warn(`[browser.act] Could not extract DevTools URL from output: ${devToolsOutput.slice(0, 200)}`);
      }
    } else {
      logger.warn(`[browser.act] Failed to start DevTools for session=${sessionId}: ${devToolsResult.error}`);
    }
  } catch (error) {
    logger.warn(`[browser.act] Failed to start DevTools for session=${sessionId}: ${error.message}`);
  }
}

// Stop tracing for a session
async function stopSessionTracing(sessionId) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  const traceData = {
    traceFile: null,
    videoFile: null,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory
  };
  
  if (debugSession.tracingActive) {
    try {
      const traceResult = await cliRun([...sessionFlags(sessionId), 'tracing-stop'], 5000);
      if (traceResult.ok) {
        // Extract trace file path from playwright-cli output
        const traceOutput = traceResult.stdout || '';
        const traceMatch = traceOutput.match(/\[Trace\]\(([^)]+)\)/);
        if (traceMatch) {
          const traceFile = traceMatch[1].trim();
          debugSession.traceFile = traceFile;
          traceData.traceFile = traceFile;
          logger.info(`[browser.act] Stopped tracing for session=${sessionId}, trace file: ${traceFile}`);
        } else {
          logger.warn(`[browser.act] Could not extract trace file path from output: ${traceOutput.slice(0, 200)}`);
        }
        debugSession.tracingActive = false;
      }
    } catch (error) {
      logger.warn(`[browser.act] Failed to stop tracing for session=${sessionId}: ${error.message}`);
    }
  }
  
  if (debugSession.videoActive) {
    try {
      const videoResult = await cliRun([...sessionFlags(sessionId), 'video-stop'], 5000);
      if (videoResult.ok) {
        // Extract video file path from playwright-cli output
        const videoOutput = videoResult.stdout || '';
        const videoMatch = videoOutput.match(/\[Video\]\(([^)]+)\)/);
        if (videoMatch) {
          const videoFile = videoMatch[1].trim();
          debugSession.videoFile = videoFile;
          traceData.videoFile = videoFile;
          logger.info(`[browser.act] Stopped video recording for session=${sessionId}, video file: ${videoFile}`);
        } else {
          // Video recording might not be available or failed to start - this is non-fatal
          logger.debug(`[browser.act] Video recording not available or failed for session=${sessionId}`);
        }
        debugSession.videoActive = false;
      }
    } catch (error) {
      logger.warn(`[browser.act] Failed to stop video recording for session=${sessionId}: ${error.message}`);
    }
  }
  
  // Stop DevTools and capture final debugging data
  if (debugSession.devToolsActive) {
    try {
      // DevTools doesn't need explicit stopping, but we can capture final state
      traceData.devToolsUrl = debugSession.devToolsUrl;
      traceData.devToolsData = debugSession.devToolsData;
      debugSession.devToolsActive = false;
      logger.info(`[browser.act] DevTools session ended for session=${sessionId}`);
    } catch (error) {
      logger.warn(`[browser.act] Failed to cleanup DevTools for session=${sessionId}: ${error.message}`);
    }
  }
  
  return traceData;
}

// Capture debugging context for failed actions
async function captureDebugContext(sessionId, failedAction) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  return {
    sessionId,
    traceFile: debugSession.traceFile,
    videoFile: debugSession.videoFile,
    devToolsUrl: debugSession.devToolsUrl,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    devToolsData: debugSession.devToolsData,
    failedAction: {
      action: failedAction.action,
      args: failedAction.args,
      error: failedAction.error,
      executionTime: failedAction.executionTime,
      crashDetected: failedAction.crashDetected
    },
    sessionDuration: Date.now() - debugSession.startTime
  };
}

// Store action in history for debugging
function storeActionForDebugging(sessionId, actionData) {
  // Skip storing action data if debugging is disabled
  if (!shouldEnableDebugging(sessionId)) return;
  
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession) {
    debugSession.actionHistory.push(actionData);
    
    // Keep only last 50 actions
    if (debugSession.actionHistory.length > 50) {
      debugSession.actionHistory = debugSession.actionHistory.slice(-50);
    }
  }
}

// Detect Chrome crash (about:blank) and trigger debugging repair
async function detectAndHandleChromeCrash(sessionId, action, args, error) {
  try {
    // Check if current page is about:blank (indicates Chrome crash)
    const checkResult = await cliRun([...sessionFlags(sessionId), 'eval', 'window.location.href'], 3000);
    if (checkResult.ok && checkResult.stdout && checkResult.stdout.includes('about:blank')) {
      logger.error(`[browser.act] Chrome crash detected for session=${sessionId} - page is about:blank`);
      
      // Capture debugging context before recovery
      const debugContext = captureDebugContext(sessionId, {
        action,
        args,
        error: `Chrome crash detected: ${error}`,
        crashDetected: true
      });
      
      // Store crash event in debugging session
      const debugSession = debuggingSessions.get(sessionId);
      if (debugSession) {
        debugSession.networkErrors.push(`Chrome crash: ${error}`);
        debugSession.consoleErrors.push('Browser navigated to about:blank');
      }
      
      return {
        crashDetected: true,
        debugContext,
        error: `Chrome browser crashed - page is about:blank`
      };
    }
  } catch (checkError) {
    logger.warn(`[browser.act] Failed to check for Chrome crash: ${checkError.message}`);
  }
  
  return { crashDetected: false };
}

// Store snapshot for debugging
function storeSnapshotForDebugging(sessionId, snapshotText) {
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession && snapshotText) {
    debugSession.snapshots.push({
      timestamp: Date.now(),
      snapshot: snapshotText
    });
    
    // Keep only last 20 snapshots
    if (debugSession.snapshots.length > 20) {
      debugSession.snapshots = debugSession.snapshots.slice(-20);
    }
  }
}

// Cleanup old debugging sessions (call periodically)
function cleanupOldDebugSessions() {
  const oneHour = 60 * 60 * 1000;
  const now = Date.now();
  
  for (const [sessionId, debugSession] of debuggingSessions.entries()) {
    if (now - debugSession.startTime > oneHour) {
      debuggingSessions.delete(sessionId);
      logger.info(`[browser.act] Cleaned up old debugging session=${sessionId}`);
    }
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldDebugSessions, 30 * 60 * 1000);

// Detect Chrome crash and capture debugging context
async function handleDetectCrash(sessionId, step, error) {
  logger.error(`[browser.act] Chrome crash detection requested for session=${sessionId}`);
  
  // Capture debugging context before recovery
  const debugContext = captureDebugContext(sessionId, {
    action: step?.action || 'unknown',
    args: step || {},
    error: error || 'Chrome crash detected',
    crashDetected: true
  });
  
  // Store crash event in debugging session
  const debugSession = debuggingSessions.get(sessionId);
  if (debugSession) {
    debugSession.networkErrors.push(`Chrome crash: ${error}`);
    debugSession.consoleErrors.push('Browser navigated to about:blank during automation');
  }
  
  return {
    ok: true,
    action: 'detectCrash',
    sessionId,
    executionTime: 0,
    debugContext,
    result: 'Chrome crash detected and debugging context captured'
  };
}

// Handle file upload using playwright-cli upload command
async function handleUpload(sessionId, filePath, headed, timeoutMs) {
  const start = Date.now();
  
  try {
    // Validate file exists and is accessible
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return {
        ok: false,
        action: 'upload',
        sessionId,
        executionTime: Date.now() - start,
        error: `File does not exist: ${filePath}`
      };
    }
    
    // Check if file is readable
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch (accessError) {
      return {
        ok: false,
        action: 'upload',
        sessionId,
        executionTime: Date.now() - start,
        error: `File is not accessible: ${filePath} - ${accessError.message}`
      };
    }
    
    logger.info(`[browser.act] Uploading file: ${filePath} for session=${sessionId}`);
    
    // Use playwright-cli upload command - requires file chooser modal to be active
    const S = sessionFlags(sessionId, headed);
    const uploadResult = await cliRun([...S, 'upload', filePath], timeoutMs);
    
    if (uploadResult.ok) {
      logger.info(`[browser.act] File upload successful: ${filePath} for session=${sessionId}`);
      return {
        ok: true,
        action: 'upload',
        sessionId,
        filePath,
        executionTime: Date.now() - start,
        result: uploadResult.stdout || 'File uploaded successfully'
      };
    } else {
      logger.error(`[browser.act] File upload failed: ${filePath} for session=${sessionId} - ${uploadResult.error}`);
      
      // Check if the error is about missing modal state
      if (uploadResult.error && uploadResult.error.includes('modal state')) {
        return {
          ok: false,
          action: 'upload',
          sessionId,
          filePath,
          executionTime: Date.now() - start,
          error: `File chooser modal not active. You must first click on a file input or attachment button to trigger the file chooser, then use upload. Error: ${uploadResult.error}`
        };
      }
      
      return {
        ok: false,
        action: 'upload',
        sessionId,
        filePath,
        executionTime: Date.now() - start,
        error: uploadResult.error || uploadResult.stderr || 'Upload command failed'
      };
    }
  } catch (error) {
    logger.error(`[browser.act] Upload error for session=${sessionId}: ${error.message}`);
    return {
      ok: false,
      action: 'upload',
      sessionId,
      filePath,
      executionTime: Date.now() - start,
      error: error.message
    };
  }
}

// Collect DevTools data during action execution
async function collectDevToolsData(sessionId, action, result) {
  // Skip data collection if debugging is disabled
  if (!shouldEnableDebugging(sessionId)) return;
  
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession || !debugSession.devToolsActive) return;

  try {
    // Collect network requests and console logs via eval commands
    const networkData = await cliRun([...sessionFlags(sessionId), 'eval', `
      (function() {
        const requests = [];
        const logs = [];
        
        // Get network requests from performance entries
        if (window.performance && window.performance.getEntriesByType) {
          const entries = window.performance.getEntriesByType('resource');
          entries.forEach(entry => {
            if (entry.initiatorType !== 'script' || entry.name.includes('.js')) {
              requests.push({
                url: entry.name,
                method: 'GET', // Simplified - real implementation would need more sophisticated tracking
                status: entry.responseStatus || 200,
                duration: Math.round(entry.duration),
                size: entry.transferSize || 0
              });
            }
          });
        }
        
        // Get console logs (simplified - real implementation would need console override)
        if (window.console && window.console.logs) {
          logs.push(...window.console.logs.slice(-10)); // Last 10 logs
        }
        
        return JSON.stringify({ requests: requests.slice(-20), logs: logs });
      })();
    `], 3000);

    if (networkData.ok && networkData.stdout) {
      try {
        const data = JSON.parse(networkData.stdout.replace(/###\s*Result\s*\n([\s\S]*?)\n###.*$/, '$1').replace(/^"|"$/g, ''));
        debugSession.devToolsData.networkRequests.push(...data.requests);
        debugSession.devToolsData.consoleLogs.push(...data.logs);
        
        // Keep only recent data to prevent memory bloat
        debugSession.devToolsData.networkRequests = debugSession.devToolsData.networkRequests.slice(-50);
        debugSession.devToolsData.consoleLogs = debugSession.devToolsData.consoleLogs.slice(-20);
      } catch (parseError) {
        logger.debug(`[browser.act] Failed to parse DevTools data: ${parseError.message}`);
      }
    }
  } catch (error) {
    logger.debug(`[browser.act] Failed to collect DevTools data: ${error.message}`);
  }
}

// Export debugging functions for other agents
function getDebuggingContext(sessionId, failedStep) {
  const debugSession = debuggingSessions.get(sessionId);
  if (!debugSession) return null;
  
  return {
    sessionId,
    traceFile: debugSession.traceFile,
    videoFile: debugSession.videoFile,
    devToolsUrl: debugSession.devToolsUrl,
    snapshots: debugSession.snapshots,
    actionHistory: debugSession.actionHistory,
    networkErrors: debugSession.networkErrors,
    consoleErrors: debugSession.consoleErrors,
    devToolsData: debugSession.devToolsData,
    failedStep,
    sessionDuration: Date.now() - debugSession.startTime
  };
}

// Export for use by playwright.agent and other debugging tools
module.exports = { 
  browserAct, 
  getDebuggingContext,
  captureDebugContext,
  stopSessionTracing,
  debuggingSessions: debuggingSessions
};

// ---------------------------------------------------------------------------
// Auth form loop — LLM prompt used by waitForAuth agentic fill
// ---------------------------------------------------------------------------
const AUTH_FORM_PROMPT = `You are a browser automation agent filling a login form.
Given a page snapshot and the available credential types, decide the SINGLE next action.
Reply ONLY with valid JSON — no markdown fences, no extra text:
{"action":"fill_email","selector":"<CSS selector>","rationale":"<one line>"}

action values:
- fill_email    : An unfilled email/username input is visible. Use when has_email=true.
- fill_password : A password input is visible. Use when has_password=true.
- click_submit  : Credentials entered; a Next/Sign in/Log in button is visible and should be clicked.
- done          : No more credential fields to fill (2FA page, CAPTCHA, or past login).

Rules:
- If both email AND password fields are visible at once, return fill_email first.
- Prefer #id selectors. Then [name=x]. Then input[type="email"] or input[type="password"].
- Never return fill_email if has_email=false. Never return fill_password if has_password=false.
- Return done for 2FA prompts, CAPTCHA challenges, or when page has advanced past credential entry.
- fill_email and fill_password are ONE-SHOT — never repeat an action already in "Completed actions".
- click_submit MAY be retried: if credentials are filled but a submit button is still visible and the page has not yet transitioned, return click_submit again. Do NOT return done just because click_submit is already in Completed actions.
- Only return done when you see a 2FA challenge, CAPTCHA, or the page is clearly past credential entry (e.g. inbox, dashboard).
- "Visible inputs:" lists ONLY inputs that are truly visible (display!=none, visibility!=hidden, opacity>=0.9, height>0). Trust this over the ARIA snapshot which may include hidden inputs.
- Never return fill_password unless "password" appears in the Visible inputs line.
- selector must be a valid CSS selector string, or null for action=done.`;

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const CLI_CANDIDATES = [
  '/opt/homebrew/bin/playwright-cli',
  '/usr/local/bin/playwright-cli',
  path.join(os.homedir(), '.npm-global', 'bin', 'playwright-cli'),
];

function findCli() {
  for (const c of CLI_CANDIDATES) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (_) {}
  }
  return 'playwright-cli'; // hope it's on PATH
}

const CLI_BIN = findCli();
logger.info(`[browser.act] playwright-cli binary: ${CLI_BIN}`);

// ---------------------------------------------------------------------------
// Core executor — runs playwright-cli with given args
// Returns: { ok, stdout, stderr, exitCode, executionTime }
// ---------------------------------------------------------------------------

function cliRun(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const proc = spawn(CLI_BIN, args, {
      env: { ...process.env },
      timeout: timeoutMs,
    });

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve({ ok: false, stdout, stderr, exitCode: -1, executionTime: Date.now() - start, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs + 2000);

    proc.on('close', code => {
      clearTimeout(timer);
      const executionTime = Date.now() - start;
      const ok = code === 0;
      resolve({ ok, stdout, stderr, exitCode: code ?? -1, executionTime, error: ok ? undefined : stderr.trim() || `exit code ${code}` });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, exitCode: -1, executionTime: Date.now() - start, error: err.message });
    });
  });
}

// Persistent profile directory per session — preserves cookies/login across restarts
function sessionProfileDir(sessionId) {
  const dir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Remove Chrome's SingletonLock file so a post-crash restart can reuse the profile
// without Chrome deciding to start fresh (losing the logged-in session).
function clearProfileLock(sessionId) {
  try {
    const lockFile = path.join(sessionProfileDir(sessionId), 'SingletonLock');
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      logger.info(`[browser.act] Removed stale SingletonLock for session=${sessionId}`);
    }
  } catch (_) {}
}

// Determine if session should use persistent profile (skills best practice)
function shouldUsePersistentProfile(sessionId) {
  // Use persistent profiles for agent sessions to preserve auth state
  return sessionId.includes('agent') || sessionId.includes('gmail') || sessionId.includes('slack') || sessionId.includes('notion');
}

// Build base flags for a session (with skills-based persistent profiles)
function sessionFlags(sessionId, headed = true) {
  const flags = [`-s=${sessionId}`];
  if (headed) flags.push('--headed');
  
  // Skills best practice: use persistent profiles for agent sessions
  if (shouldUsePersistentProfile(sessionId)) {
    flags.push('--persistent');
    logger.debug(`[browser.act] Using persistent profile for session=${sessionId}`);
  }
  
  // NOTE: We use --persistent instead of --profile for better session management
  // Auth persistence is handled via state-save/state-load in combination with persistent profiles
  return flags;
}

// ---------------------------------------------------------------------------
// Snapshot cache — stores last snapshot text per session for ref resolution
// ---------------------------------------------------------------------------
const snapshotCache = new Map(); // sessionId → snapshot text (cleared on navigate)

// Track which sessions have been opened (daemon started)
const openSessions = new Set();

// Probe whether a playwright-cli daemon is already alive for a session.
// Used on navigate after app restart (openSessions cleared) to avoid cold-starting
// a new Chrome tab when the browser is already open from a previous run.
async function isDaemonAlive(sessionId, headed) {
  try {
    // Always probe headlessly — we only want to know if the daemon process exists.
    // Passing `headed` here causes playwright-cli to briefly open a visible blank
    // Chrome window then immediately close it when the daemon isn't running, which
    // is jarring to the user. The probe result is the same either way.
    const probe = await cliRun([...sessionFlags(sessionId, false), 'eval', '1'], 4000);
    return probe.ok;
  } catch (_) {
    return false;
  }
}

// Track the last selector/ref that was successfully filled, per session.
// Used by press Enter to refocus the input before submitting.
const lastFilledTarget = new Map(); // sessionId → { target, ref }

async function captureSnapshot(sessionId, headed, timeoutMs) {
  const res = await cliRun([...sessionFlags(sessionId, headed), 'snapshot'], timeoutMs);
  // playwright-cli snapshot writes the YAML tree to a .yml file and only
  // prints the file path in stdout (e.g. "[Snapshot](.playwright-cli/page-xxx.yml)").
  // We must read the file to get the actual accessibility tree with element refs.
  let snapshotText = res.stdout || '';
  const fileMatch = snapshotText.match(/\[Snapshot\]\(([^)]+\.yml)\)/);
  if (fileMatch) {
    try {
      const ymlPath = path.resolve(process.cwd(), fileMatch[1]);
      snapshotText = fs.readFileSync(ymlPath, 'utf8');
    } catch (_) {
      // fall back to stdout if file read fails
    }
  }
  if (snapshotText) {
    snapshotCache.set(sessionId, snapshotText);
    // Store snapshot for debugging
    storeSnapshotForDebugging(sessionId, snapshotText);
  }
  res.snapshotText = snapshotText;
  return res;
}

// ── Element ref resolution ────────────────────────────────────────────────
// Roles that are interactive input types — what we want to fill into
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'input', 'textarea']);
// Context patterns that indicate nav/sidebar/history elements — deprioritise these
const EXCLUDE_CONTEXT = /search.{0,20}(chat|history|conversation|message)|filter|sidebar|nav\b|navigation|recent|previous/i;

// Parse snapshot YAML lines into structured candidate objects.
// Handles two formats emitted by playwright-cli:
//   Format A (old stdout):  "  - [e12] link "Bible Study" [href=...]"
//   Format B (.yml file):   "    - link "Bible Study" [ref=e52] [cursor=pointer]:"
//   Format C (no label):    "    - textbox [ref=e52]"
function parseSnapshotCandidates(snap) {
  const candidates = [];
  const lines = snap.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let indent = '', ref = null, role = '', label = '', attrs = '';

    // Format A: optional indent + dash + [eN] BEFORE role + "label" + optional attrs
    const mA = line.match(/^(\s*)-?\s*\[?(e\d+)\]?\s+(\w[\w-]*)\s+"([^"]*)"(.*)/i);
    if (mA) {
      [, indent, ref, role, label, attrs] = mA;
    } else {
      // Format B (.yml): optional indent + dash + role + optional "label" + optional attrs
      // ref appears in attrs as [ref=eN]
      const mB = line.match(/^(\s*)-\s+(\w[\w-]*)(?:\s+"([^"]*)")?(.*)/i);
      if (mB) {
        [, indent, role, label, attrs] = mB;
        label = label || '';
        // Extract [ref=eN] from attrs if present
        const refMatch = attrs && attrs.match(/\[ref=(e\d+)\]/i);
        ref = refMatch ? refMatch[1] : `line_${i}`;
      }
    }

    if (!role) continue;
    // Skip lines that are just attribute continuations (e.g. "- /url: ...")
    if (role.startsWith('/')) continue;
    candidates.push({
      ref,
      role: role.toLowerCase(),
      label,
      attrs,
      depth: indent.length,
      lineIndex: i,
    });
  }
  return candidates;
}

// Score a candidate element for FILL — textboxes preferred, links/buttons excluded
function scoreCandidateForFill(cand, selectorLabel) {
  const needle = selectorLabel.toLowerCase().trim();
  const label = cand.label.toLowerCase();
  const role = cand.role;
  const context = (cand.label + ' ' + (cand.attrs || '')).toLowerCase();

  // Hard exclude: non-interactive roles we can never type into
  const NON_INTERACTIVE = new Set(['link', 'button', 'img', 'image', 'heading',
    'listitem', 'list', 'article', 'region', 'banner', 'navigation', 'main',
    'complementary', 'contentinfo', 'dialog', 'alertdialog', 'status', 'log',
    'marquee', 'timer', 'alert', 'tooltip', 'menu', 'menuitem', 'menubar',
    'tab', 'tabpanel', 'tablist', 'tree', 'treeitem', 'grid', 'row', 'cell',
    'columnheader', 'rowheader', 'table', 'separator', 'scrollbar', 'slider',
    'spinbutton', 'progressbar', 'meter', 'figure', 'definition',
    'term', 'note', 'code', 'math', 'presentation', 'none']);
  if (NON_INTERACTIVE.has(role)) return -Infinity;

  // Hard exclude: history/nav/filter context
  if (EXCLUDE_CONTEXT.test(context)) return -Infinity;

  let score = 0;

  // Role bonus — textbox/combobox/searchbox are the right type for fill
  if (INPUT_ROLES.has(role)) score += 100;
  else if (role === 'generic' || role === 'text') score += 10;

  // Label match
  if (label === needle) score += 200;
  else if (label.startsWith(needle)) score += 150;
  else if (label.includes(needle)) score += 100;
  else {
    const needleTokens = needle.split(/\W+/).filter(Boolean);
    const labelTokens = label.split(/\W+/).filter(Boolean);
    const overlap = needleTokens.filter(t => labelTokens.includes(t)).length;
    if (overlap > 0) score += overlap * 30;
  }

  // Penalize subscribe/newsletter "sign-up email" boxes — NOT actual login email inputs.
  // A plain "email" label on a login form (e.g. Google's "Email or phone") should NOT be
  // penalized. Only penalize when the label clearly indicates a newsletter/subscribe context
  // AND the selector is not explicitly targeting an email-type input.
  const SUBSCRIBE_FIELD = /\b(subscribe|newsletter|sign[\s-]?up|your\s+email|enter.*email|email.*here)\b/i;
  const selectorIsEmailInput = /type[=\s'"]*email|name[=\s'"]*(?:email|identifier|username)|autocomplete[=\s'"]*(?:email|username)/i.test(needle);
  if (SUBSCRIBE_FIELD.test(label) && !selectorIsEmailInput) score -= 150;
  // Bonus when selector explicitly targets an email/login input AND the label confirms it
  if (selectorIsEmailInput && /\b(email|phone|username|identifier)\b/i.test(label)) score += 100;

  score -= Math.min(cand.depth * 0.5, 20);
  if (score <= 0) return -Infinity;
  return score;
}

// Score a candidate element for CLICK — links and buttons are preferred targets
function scoreCandidateForClick(cand, selectorLabel) {
  const needle = selectorLabel.toLowerCase().trim();
  const label = cand.label.toLowerCase();
  const role = cand.role;

  // For click: links and buttons are the BEST targets, not excluded
  const CLICK_ROLES = new Set(['link', 'button', 'menuitem', 'option', 'tab', 'treeitem']);
  // Hard exclude: purely decorative/structural roles
  const STRUCTURAL = new Set(['img', 'image', 'heading', 'list', 'article', 'region', 'banner',
    'navigation', 'main', 'complementary', 'contentinfo', 'separator',
    'progressbar', 'scrollbar', 'meter', 'figure', 'definition', 'term',
    'note', 'code', 'math', 'presentation', 'none']);
  if (STRUCTURAL.has(role)) return -Infinity;

  let score = 0;

  // Role bonus for click targets
  if (CLICK_ROLES.has(role)) score += 100;
  else if (INPUT_ROLES.has(role)) score += 40; // inputs can be clicked too
  else if (role === 'generic' || role === 'text') score += 5;

  // Label match — try full needle first, then progressive prefix (drops trailing noise words)
  if (label === needle) {
    score += 300;
  } else if (label.startsWith(needle) || needle.startsWith(label)) {
    // "Bible Study" startsWith "Bible" — but require label covers >50% of needle chars
    // to avoid "New" matching "New project in ChatGPT"
    const coverage = Math.min(label.length, needle.length) / Math.max(label.length, needle.length);
    score += coverage >= 0.5 ? 200 : 80;
  } else {
    // Token overlap — handles "Bible Study Project" → "Bible Study"
    const needleTokens = needle.split(/\W+/).filter(Boolean);
    const labelTokens = label.split(/\W+/).filter(Boolean);
    const overlap = needleTokens.filter(t => labelTokens.includes(t)).length;
    if (overlap > 0 && labelTokens.length > 0) {
      // Score proportional to how much of the LABEL is covered by needle tokens
      // Full label coverage = all label tokens appear in needle = strong signal (e.g. "Bible Study" in "Bible Study Project")
      const labelCoverage = overlap / labelTokens.length;
      // Also require the label is at least 4 chars to prevent "New", "App" etc. matching everything
      if (label.length >= 4) {
        score += Math.round(labelCoverage * 180);
      } else {
        // Short labels only score if they're a perfect full match (handled above) or exact token
        score += overlap === needleTokens.length ? 60 : 0;
      }
    }
  }

  score -= Math.min(cand.depth * 0.5, 20);
  if (score <= 0) return -Infinity;
  return score;
}

// Backward-compat alias used by fill path
function scoreCandidateForSelector(cand, selectorLabel) {
  return scoreCandidateForFill(cand, selectorLabel);
}

// Synchronous resolver for FILL: returns best ref or null
function resolveRef(sessionId, labelOrRef) {
  if (!labelOrRef) return null;
  if (/^e\d+$/i.test(labelOrRef.trim())) return labelOrRef.trim();

  const snap = snapshotCache.get(sessionId) || '';
  if (!snap) return null;

  const candidates = parseSnapshotCandidates(snap);
  let best = null, bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidateForFill(cand, labelOrRef);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && bestScore > 0) {
    logger.info(`[browser.act] resolveRef "${labelOrRef}" → ${best.ref} (${best.role} "${best.label}" score=${bestScore})`);
    return best.ref;
  }
  return null;
}

// Synchronous resolver for CLICK: scores links/buttons as preferred
// Returns { ref, label } so callers can use the matched label even when ref is synthetic.
function resolveRefForClick(sessionId, labelOrRef) {
  if (!labelOrRef) return { ref: null, label: null };
  if (/^e\d+$/i.test(labelOrRef.trim())) return { ref: labelOrRef.trim(), label: labelOrRef.trim() };

  const snap = snapshotCache.get(sessionId) || '';
  if (!snap) return { ref: null, label: null };

  const candidates = parseSnapshotCandidates(snap);
  let best = null, bestScore = -Infinity;
  for (const cand of candidates) {
    const s = scoreCandidateForClick(cand, labelOrRef);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  if (best && bestScore > 0) {
    logger.info(`[browser.act] resolveRefForClick "${labelOrRef}" → ${best.ref} (${best.role} "${best.label}" score=${bestScore})`);
    return { ref: best.ref, label: best.label };
  }
  return { ref: null, label: null };
}

// ---------------------------------------------------------------------------
// Main skill entry point
// ---------------------------------------------------------------------------

async function browserAct(args) {
  const {
    action,
    sessionId  = 'default',
    url,
    selector,
    text,
    key,
    value,
    dx = 0,
    dy = 100,
    width,
    height,
    filePath,
    headed     = true,
    timeoutMs  = 15000,
    authSuccessUrl,
    credentials,
    _progressCallbackUrl,
  } = args || {};

  const start = Date.now();

  if (!action) {
    return { ok: false, error: 'action is required', executionTime: 0 };
  }

  logger.info(`[browser.act] ${action} session=${sessionId}`, { url, selector, text, key });

  // Start debugging tracing if enabled and not upload action
  if (action !== 'upload' && shouldEnableDebugging(sessionId)) {
    await startSessionTracing(sessionId);
  }

  const S = sessionFlags(sessionId, headed);

  // Helper: run + return standardised result with debugging
  async function run(cmdArgs, label) {
    const actionStart = Date.now();
    const res = await cliRun([...S, ...cmdArgs], timeoutMs);
    const executionTime = Date.now() - actionStart;
    
    logger.info(`[browser.act] ${label} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 200) });
    
    // Store action for debugging (skip if debugging disabled or upload to prevent hanging)
    if (action !== 'upload' && shouldEnableDebugging(sessionId)) {
      storeActionForDebugging(sessionId, {
        label,
        cmdArgs,
        result: res,
        executionTime,
        ok: res.ok
      });
      
      // Collect DevTools data after action execution (both success and failure)
      await collectDevToolsData(sessionId, action, res);
    }
    
    // If action failed, check for Chrome crash and capture debugging context
    if (!res.ok) {
      // Check if this is a Chrome crash
      const crashInfo = await detectAndHandleChromeCrash(sessionId, action, cmdArgs, res.error || res.stderr?.trim());
      
      const debugContext = await captureDebugContext(sessionId, {
        action,
        args: cmdArgs,
        error: crashInfo.crashDetected ? crashInfo.error : (res.error || res.stderr?.trim()),
        executionTime,
        crashDetected: crashInfo.crashDetected
      });
      
      logger.info(`[browser.act] Captured debug context for failed action: ${label}${crashInfo.crashDetected ? ' (Chrome crash detected)' : ''}`);
      
      // If Chrome crash detected, add special error info
      if (crashInfo.crashDetected) {
        return {
          ok: false,
          action,
          sessionId,
          executionTime,
          error: crashInfo.error,
          chromeCrash: true,
          debugContext
        };
      }
    }
    
    return {
      ok:            res.ok,
      action,
      sessionId,
      result:        (res.stdout || '').trim() || undefined,
      stdout:        res.stdout,
      executionTime: executionTime,
      error:         res.ok ? undefined : res.error || res.stderr?.trim(),
    };
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  switch (action) {

    // ── Navigation ──────────────────────────────────────────────────────────
    case 'navigate':
    case 'goto': {
      if (!url) return { ok: false, action, sessionId, error: 'url required for navigate', executionTime: 0 };
      // Use 'open' to cold-start the daemon + navigate in one shot.
      // Use 'goto' if daemon is already running — avoids spawning a new blank Chrome tab.
      // After app restart openSessions is cleared, so probe the daemon directly with isDaemonAlive().
      const navTimeout = Math.max(timeoutMs, 30000);
      let alreadyOpen = openSessions.has(sessionId);
      if (!alreadyOpen) {
        // Probe whether the daemon survived the app restart (Chrome still open from last run)
        alreadyOpen = await isDaemonAlive(sessionId, headed);
        if (alreadyOpen) {
          openSessions.add(sessionId);
          logger.info(`[browser.act] navigate: daemon alive for session=${sessionId} (post-restart probe) — using goto`);
        }
      }
      const navCmd = alreadyOpen ? 'goto' : 'open';
      // Invalidate snapshot cache and last-filled target — the page is changing
      snapshotCache.delete(sessionId);
      lastFilledTarget.delete(sessionId);
      // Before cold-starting, remove any stale SingletonLock from a previous crash
      if (!alreadyOpen) clearProfileLock(sessionId);
      const res = await cliRun([...S, navCmd, url], navTimeout);
      if (res.ok) {
        openSessions.add(sessionId);
        // For cold-starts: Chrome may show a "Restore pages?" crash-recovery dialog.
        // Only bypass it if we actually detect the dialog text — unconditionally sending
        // a second goto clears the page mid-load and causes about:blank flicker.
        if (!alreadyOpen) {
          const probeSnap = await cliRun([...S, 'snapshot'], 4000).catch(() => null);
          const probeText = (probeSnap?.stdout || '').toLowerCase();
          const RESTORE_DIALOG = /restore pages?\?|chrome didn't shut down correctly|help make google chrome better/i;
          if (RESTORE_DIALOG.test(probeText)) {
            logger.info(`[browser.act] cold-start: Chrome restore dialog detected — sending goto ${url} to dismiss`);
            await cliRun([...S, 'goto', url], navTimeout).catch(() => {});
          }
        }

        // Non-blocking post-nav verification so we can detect successful command
        // execution that still lands on about:blank during tab/session instability.
        try {
          const _urlProbe = await cliRun([...S, 'eval', 'window.location.href'], 3000);
          const _rawProbe = (_urlProbe.stdout || '').trim();
          const _probeMatch = _rawProbe.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          const _curUrl = (_probeMatch ? _probeMatch[1] : _rawProbe).trim().replace(/^"|"$/g, '');
          if (/about:blank/i.test(_curUrl)) {
            logger.warn(`[browser.act] navigate: command succeeded but current URL is about:blank (session=${sessionId})`);
          }
        } catch (_) {
          // Probe failure is non-fatal — navigation result stands.
        }
      } else if (alreadyOpen && !res.ok) {
        // goto failed (daemon may have died) — retry with open to restart it
        logger.info(`[browser.act] goto failed, retrying with open for session=${sessionId}`);
        const retryRes = await cliRun([...S, 'open', url], navTimeout);
        if (retryRes.ok) { openSessions.add(sessionId); }
        logger.info(`[browser.act] open ${url} → exit ${retryRes.exitCode}`, { stderr: retryRes.stderr?.slice(0, 200) });
        return {
          ok:            retryRes.ok,
          action,
          sessionId,
          url:           retryRes.ok ? url : undefined,
          result:        (retryRes.stdout || '').trim() || undefined,
          executionTime: Date.now() - start,
          error:         retryRes.ok ? undefined : retryRes.error || retryRes.stderr?.trim(),
        };
      }
      logger.info(`[browser.act] ${navCmd} ${url} → exit ${res.exitCode}`, { stderr: res.stderr?.slice(0, 200) });
      return {
        ok:            res.ok,
        action,
        sessionId,
        url:           res.ok ? url : undefined,
        result:        (res.stdout || '').trim() || undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error || res.stderr?.trim(),
      };
    }

    case 'back':    return run(['go-back'],    'go-back');
    case 'forward': return run(['go-forward'], 'go-forward');
    case 'reload':  return run(['reload'],     'reload');

    case 'close': {
      const res = await cliRun([...S, 'close'], timeoutMs);
      snapshotCache.delete(sessionId);
      openSessions.delete(sessionId);
      return { ok: res.ok, action, sessionId, executionTime: Date.now() - start, error: res.ok ? undefined : res.error };
    }

    // ── Snapshot ─────────────────────────────────────────────────────────────
    case 'snapshot': {
      const res = await captureSnapshot(sessionId, headed, timeoutMs);
      const content = res.snapshotText || res.stdout || '';
      return {
        ok:            res.ok || !!content,
        action,
        sessionId,
        result:        content.trim(),
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── Click ────────────────────────────────────────────────────────────────
    case 'click':
    case 'dblclick': {
      const cmd = action === 'dblclick' ? 'dblclick' : 'click';
      // Ensure snapshot is fresh for ref resolution
      await captureSnapshot(sessionId, headed, timeoutMs);
      const { ref: rawRef, label: matchedLabel } = resolveRefForClick(sessionId, selector);
      // Only use refs that playwright-cli actually understands (eN format).
      // Synthetic refs (line_N) come from the .yml file format — playwright-cli rejects them.
      const ref = rawRef && /^e\d+$/i.test(rawRef) ? rawRef : null;
      if (rawRef && !ref) {
        logger.info(`[browser.act] click: synthetic ref "${rawRef}" (matched label="${matchedLabel}") — using eval-click fallback for "${selector}"`);
      }
      if (!ref) {
        // No real eN ref — use eval fallback.
        // IMPORTANT: if resolveRefForClick already found a matched label (e.g. "Lemans" for selector "LeMans"),
        // use that as the first attempt so case/spacing differences don't cause miss.
        logger.warn(`[browser.act] click: could not resolve ref for "${selector}" — trying eval click (matchedLabel=${matchedLabel || 'none'})`);
        // Build attempts: matched label first, then word-drops of original selector
        const seen = new Set();
        const attempts = [];
        if (matchedLabel && matchedLabel !== selector) {
          attempts.push(matchedLabel);
          seen.add(matchedLabel.toLowerCase());
        }
        const words = selector.trim().split(/\s+/);
        for (let len = words.length; len >= 1; len--) {
          const t = words.slice(0, len).join(' ');
          if (!seen.has(t.toLowerCase())) { attempts.push(t); seen.add(t.toLowerCase()); }
        }
        // playwright-cli eval expects a FUNCTION expression: () => value
        // Case-insensitive matching so "LeMans" finds "Lemans", "lemans", etc.
        // NOTE: never use querySelector("[aria-label='...']") with dynamic values — single-quotes in
        // the value break the CSS selector syntax. Use getAttribute comparisons instead.
        const tryTexts = attempts.map(t => JSON.stringify(t)).join(', ');
        // Match priority: aria-label exact → textContent exact → textContent startsWith → textContent includes (for nested spans)
        // NO form-submit fallback: that was causing silent false-positives (clicked:form) when the real target wasn't found.
        // Two-pass strategy: pass 1 = strict (aria-label/exact/startsWith/data-testid), pass 2 = includes() but only on short-text elements (≤50 chars) to avoid matching long conversation titles that happen to contain the target text.
        const evalScript = `() => { const texts = [${tryTexts}]; const CANDIDATES = 'a,button,input[type=submit],[role=button],[role=link],[role=menuitem],li'; for (const t of texts) { const tl = t.toLowerCase(); const all = [...document.querySelectorAll(CANDIDATES)]; const el = all.find(e => (e.getAttribute('aria-label') || '').toLowerCase() === tl || (e.getAttribute('aria-label') || '') === t || e.textContent.trim().toLowerCase() === tl || e.textContent.trim().toLowerCase().startsWith(tl) || e.getAttribute('data-testid') === t || (e.getAttribute('name') || '').toLowerCase() === tl || (e.getAttribute('value') || '').toLowerCase() === tl) || all.find(e => e.textContent.trim().length <= 50 && e.textContent.trim().toLowerCase().includes(tl)); if (el) { el.click(); return 'clicked:' + t; } } return 'not-found'; }`;
        const evalRes = await cliRun([...S, 'eval', evalScript], timeoutMs);
        const evalRaw = (evalRes.stdout || '').trim();
        // playwright-cli echoes back the script source in "### Ran Playwright code" block
        // so we must extract ONLY the ### Result section to avoid false-positive 'not-found' match
        const resultMatch = evalRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
        const evalResult = resultMatch ? resultMatch[1].trim().replace(/^["']|["']$/g, '') : evalRaw;
        // 'clicked:form' and 'clicked:form-submit' were from the old fallback — treat as failure.
        const clickSucceeded = (evalResult.startsWith('clicked:') || evalResult.includes('clicked:')) &&
          evalResult !== 'clicked:form' && evalResult !== 'clicked:form-submit';
        if (!clickSucceeded) {
          logger.warn(`[browser.act] eval-click: element not found for "${selector}" — result: ${evalResult.slice(0, 80)}`);
          return {
            ok: false,
            action,
            sessionId,
            result: evalRaw,
            executionTime: Date.now() - start,
            error: `Element not found: "${selector}" — could not locate a matching link, button, or item on the page`,
          };
        }
        logger.info(`[browser.act] eval-click "${selector}" → ${evalResult}`, { stderr: evalRes.stderr?.slice(0, 80) });
        return { ok: true, action, sessionId, result: evalResult, executionTime: Date.now() - start };
      }
      return run([cmd, ref], `${cmd} ${ref}`);
    }

    // ── Fill / Type ─────────────────────────────────────────────────────────
    case 'fill': {
      // Always use click → select-all → type (real keyboard events) rather than
      // playwright-cli's native 'fill' which sets element.value directly. React,
      // Vue, and other framework-controlled inputs (e.g. Google's sign-in page)
      // ignore programmatic .value assignments — only actual keyboard events
      // trigger their internal state updates and allow the form to submit correctly.
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawFillRef = resolveRef(sessionId, selector);
      // Only use real eN refs — synthetic line_N refs from .yml format are rejected by playwright-cli
      const ref = rawFillRef && /^e\d+$/i.test(rawFillRef) ? rawFillRef : null;
      const fillTarget = ref || selector;
      const fillText = (text ?? value) || '';
      const unresolvedCred = fillText.match(/\{\{[a-z0-9_.-]+:[a-z0-9_]+\}\}/i);
      if (unresolvedCred) {
        logger.warn(`[browser.act] fill: refusing unresolved credential token ${unresolvedCred[0]}`);
        return {
          ok: false,
          action,
          sessionId,
          loginWallDetected: true,
          needsCredentials: true,
          executionTime: Date.now() - start,
          error: `Unresolved credential token ${unresolvedCred[0]} — credentials must be resolved before fill`,
        };
      }
      const placeholderEmail = fillText.match(/\b(?:example@domain\.com|user@example\.com|your-email@gmail\.com)\b|<\s*email\s*>/i);
      if (placeholderEmail) {
        logger.warn(`[browser.act] fill: refusing placeholder email value ${placeholderEmail[0]}`);
        return {
          ok: false,
          action,
          sessionId,
          executionTime: Date.now() - start,
          error: `Placeholder recipient value rejected: ${placeholderEmail[0]}`,
        };
      }
      logger.info(`[browser.act] fill resolved: "${selector}" → ${ref ? `ref ${ref}` : `direct selector "${selector}"`} (click+type strategy)`);

      // Step 1: click to focus
      const clickRes = await cliRun([...S, 'click', fillTarget], timeoutMs);
      logger.info(`[browser.act] fill click ${fillTarget} → exit ${clickRes.exitCode}`, { stderr: clickRes.stderr?.slice(0, 200) });

      // Hard error on click (element not found / timeout) — abort early
      const PLAYWRIGHT_HARD_ERR = /^### Error|TimeoutError:/im;
      if (PLAYWRIGHT_HARD_ERR.test(clickRes.stdout || '')) {
        const errMatch = (clickRes.stdout || '').match(/([A-Za-z]*Error:[^\n]+)/);
        const errMsg = errMatch ? errMatch[1].trim() : 'playwright-cli: element not clickable';
        logger.warn(`[browser.act] fill ${fillTarget}: click hard error — ${errMsg}`);
        return {
          ok: false, action, sessionId,
          result: (clickRes.stdout || '').trim(),
          stdout: clickRes.stdout,
          executionTime: Date.now() - start,
          error: errMsg,
        };
      }

      // Step 2: detect chip/combobox fields (Gmail To, Outlook To, tag inputs, etc.)
      // Meta+a triggers "Select All" globally in some SPAs (e.g. Gmail) which kills
      // focus on contenteditable chip fields — skip it for those field types.
      await new Promise(r => setTimeout(r, 100));
      const _chipProbe = await cliRun([...S, 'eval',
        'document.activeElement && (document.activeElement.isContentEditable || ' +
        'document.activeElement.getAttribute("role") === "combobox" || ' +
        'document.activeElement.getAttribute("aria-autocomplete") !== null || ' +
        '!!document.activeElement.closest("[role=combobox]")) ? "chip" : "normal"'
      ], 2000).catch(() => null);
      const _chipRaw = (_chipProbe?.stdout || '').trim();
      const _chipResultMatch = _chipRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
      const _isChipField = (_chipResultMatch ? _chipResultMatch[1].trim() : _chipRaw).replace(/^["']|["']$/g, '') === 'chip';
      logger.info(`[browser.act] fill chip-detect: ${_isChipField ? 'chip/combobox — skipping Meta+a' : 'normal input'}`);

      let typeRes;
      if (_isChipField) {
        // Chip/combobox: type directly + Tab to confirm the chip (no Meta+a)
        typeRes = await cliRun([...S, 'type', fillText], timeoutMs);
        await cliRun([...S, 'press', 'Tab'], 2000).catch(() => {});
      } else {
        // Normal input: select-all to clear existing value, then type
        await cliRun([...S, 'press', 'Meta+a'], 3000).catch(() => {});
        typeRes = await cliRun([...S, 'type', fillText], timeoutMs);
      }
      logger.info(`[browser.act] fill type → exit ${typeRes.exitCode}`, { stderr: typeRes.stderr?.slice(0, 200) });

      // After click+type the keyboard focus is already on the correct element.
      // Do NOT store ref in lastFilledTarget for contenteditable containers — if press
      // Enter later re-clicks that element it can navigate away unexpectedly.
      if (typeRes.ok) lastFilledTarget.delete(sessionId);
      return {
        ok: typeRes.ok,
        action, sessionId,
        result: (typeRes.stdout || '').trim() || undefined,
        stdout: typeRes.stdout,
        executionTime: Date.now() - start,
        error: typeRes.ok ? undefined : typeRes.error || typeRes.stderr?.trim(),
      };
    }

    case 'type': {
      return run(['type', text || ''], `type "${text}"`);
    }

    // ── Hover ────────────────────────────────────────────────────────────────
    case 'hover': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawHoverRef = resolveRef(sessionId, selector);
      const hoverTarget = (rawHoverRef && /^e\d+$/i.test(rawHoverRef) ? rawHoverRef : null) || selector;
      return run(['hover', hoverTarget], `hover ${hoverTarget}`);
    }

    // ── Select ───────────────────────────────────────────────────────────────
    case 'select': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawSelRef = resolveRef(sessionId, selector);
      const selTarget = (rawSelRef && /^e\d+$/i.test(rawSelRef) ? rawSelRef : null) || selector;
      return run(['select', selTarget, value || ''], `select ${selTarget}`);
    }

    // ── Check / Uncheck ──────────────────────────────────────────────────────
    case 'check': {
      await captureSnapshot(sessionId, headed, timeoutMs);
      const rawCheckRef = resolveRef(sessionId, selector);
      const checkTarget = (rawCheckRef && /^e\d+$/i.test(rawCheckRef) ? rawCheckRef : null) || selector;
      return run(['check', checkTarget], `check ${checkTarget}`);
    }

    // ── Upload ───────────────────────────────────────────────────────────────
    // playwright-cli upload takes ONLY file paths — no element ref.
    // The correct sequence is:
    //   1. click <ref>          — triggers the browser's file chooser dialog
    //   2. wait 2s              — let the file chooser initialize
    //   3. upload <filepath>    — playwright-cli intercepts the active chooser
    //                             and feeds the file in (CLI handles the timing)
    // Retry upload with different delays if first attempt fails.
    case 'upload': {
      const uploadFiles = (args.files && Array.isArray(args.files) ? args.files
        : args.file ? [args.file]
        : args.path ? [args.path] : []).filter(Boolean);
      if (args.path && !args.files) {
        logger.warn(`[browser.act] upload: "path" param used — prefer "files" array. Normalizing to files=[${args.path}]`);
      }
      if (!uploadFiles.length) {
        return { ok: false, action, sessionId, error: 'upload: files[] or file is required', executionTime: Date.now() - start };
      }

      // Debug logging
      logger.info(`[browser.act] upload: starting upload for files: ${uploadFiles.join(', ')}`);

      // Ensure browser session exists before upload - use existing session if available
      try {
        const sessionCheck = await cliRun([...sessionFlags(sessionId, false), 'snapshot'], 3000);
        if (!sessionCheck.ok) {
          logger.warn(`[browser.act] Browser session not active, attempting to start session for ${sessionId}`);
          const startResult = await cliRun([...sessionFlags(sessionId, false), 'open'], 5000);
          if (!startResult.ok) {
            // If socket error occurs, try with a different session name
            if (startResult.error?.includes('EINVAL') || startResult.error?.includes('socket')) {
              const altSessionId = `${sessionId}_${Date.now()}`;
              logger.info(`[browser.act] Retrying with alternative session: ${altSessionId}`);
              const retryResult = await cliRun([...sessionFlags(altSessionId, false), 'open'], 5000);
              if (!retryResult.ok) {
                return {
                  ok: false,
                  action,
                  sessionId,
                  error: `Failed to start browser session for upload (socket error): ${retryResult.error}`,
                  executionTime: Date.now() - start,
                };
              }
              // Update sessionId for rest of function
              sessionId = altSessionId;
            } else {
              return {
                ok: false,
                action,
                sessionId,
                error: `Failed to start browser session for upload: ${startResult.error}`,
                executionTime: Date.now() - start,
              };
            }
          }
          // Wait a moment for session to fully initialize
          await cliRun([...sessionFlags(sessionId, false), 'wait', '1000'], 2000);
        }
      } catch (sessionError) {
        return {
          ok: false,
          action,
          sessionId,
          error: `Session check failed: ${sessionError.message}`,
          executionTime: Date.now() - start,
        };
      }

      for (const _f of uploadFiles) {
        let _raw = String(_f || '');
        
        // Fix path resolution for /previous_step/ references
        if (_raw.startsWith('/previous_step/')) {
          const filename = _raw.replace('/previous_step/', '');
          // Map to common user directories
          const possiblePaths = [
            `/Users/lukaizhi/Desktop/${filename}`,
            `/Users/lukaizhi/Documents/${filename}`,
            `/Users/lukaizhi/Downloads/${filename}`,
            `/Users/lukaizhi/${filename}`
          ];
          
          // Find the first existing file
          for (const possiblePath of possiblePaths) {
            if (fs.existsSync(possiblePath)) {
              _raw = possiblePath;
              logger.info(`[browser.act] upload: resolved /previous_step/${filename} to ${_raw}`);
              break;
            }
          }
          
          // If still using /previous_step/ path, default to Desktop
          if (_raw.startsWith('/previous_step/')) {
            _raw = `/Users/lukaizhi/Desktop/${filename}`;
            logger.warn(`[browser.act] upload: /previous_step/${filename} not found, defaulting to Desktop: ${_raw}`);
          }
        }
        
        if (!path.isAbsolute(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: path must be absolute: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
        if (/\/path\/to\/|\/Users\/the_user\/|\{\{[^}]+\}\}|<\s*file/i.test(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: placeholder file path rejected: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
        if (!fs.existsSync(_raw)) {
          return {
            ok: false,
            action,
            sessionId,
            error: `upload: file not found: ${_raw}`,
            executionTime: Date.now() - start,
          };
        }
      }

      // Step 1: click the selector to open the file chooser (if selector provided)
      if (selector) {
        logger.info(`[browser.act] upload: clicking attach button: ${selector}`);
        // Direct CLI call without debugging infrastructure
        const clickFlags = sessionFlags(sessionId, false); // Force headed=false to avoid DevTools
        const _triggerRes = await cliRun([...clickFlags, 'click', selector], timeoutMs);
        if (!_triggerRes.ok) {
          return {
            ok: false,
            action,
            sessionId,
            error: `Failed to click attach button "${selector}": ${_triggerRes.error}`,
            executionTime: Date.now() - start,
          };
        }
        // Brief wait to let file chooser initialize
        logger.info(`[browser.act] upload: waiting 500ms for file chooser`);
        await cliRun([...clickFlags, 'wait', '500'], timeoutMs);
      }

      // Step 2: upload files using playwright-cli upload command (direct CLI only)
      const uploadFlags = sessionFlags(sessionId, false); // Force headed=false to avoid DevTools
      for (const _f of uploadFiles) {
        logger.info(`[browser.act] upload: attempting playwright-cli upload for: ${_f}`);
        const _uploadResult = await cliRun([...uploadFlags, 'upload', _f], timeoutMs);
        
        if (!_uploadResult.ok) {
          logger.error(`[browser.act] upload: failed for ${_f} - ${_uploadResult.error}`);
          return {
            ok: false,
            action,
            sessionId,
            error: `Upload failed for ${_f}: ${_uploadResult.error}`,
            executionTime: Date.now() - start,
          };
        }
        
        logger.info(`[browser.act] upload: file attached successfully — ${_f}`);
      }

      logger.info(`[browser.act] upload: upload completed successfully for: ${uploadFiles.join(', ')}`);
      
      const result = {
        ok: true,
        action,
        sessionId,
        files: uploadFiles,
        executionTime: Date.now() - start,
        result: `Successfully uploaded ${uploadFiles.length} file(s)`
      };
      
      // Force process cleanup to prevent hanging (only for standalone testing)
      if (process.env.NODE_ENV !== 'production' && !process.env.ELECTRON_RUN_AS_NODE) {
        setTimeout(() => {
          process.exit(0);
        }, 100);
      }
      
      return result;
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────
    case 'keyboard':
    case 'press': {
      const pressKey = key || text || '';
      // For Enter/Return: refocus the last filled input first so the form submits correctly.
      // After fill+click+type fallback, focus may have drifted — this guarantees the
      // keypress lands on the right element and triggers form submission.
      if (/^(Enter|Return)$/i.test(pressKey)) {
        const lastFill = lastFilledTarget.get(sessionId);
        if (lastFill) {
          const refocusTarget = lastFill.ref || lastFill.target;
          logger.info(`[browser.act] press Enter: refocusing last filled target "${refocusTarget}" before submit`);
          await cliRun([...S, 'click', refocusTarget], 3000).catch(() => {});
          await new Promise(r => setTimeout(r, 150));
        }
        // Enter triggers navigation — invalidate snapshot cache and lastFilledTarget
        // so any subsequent fill/click gets a fresh snapshot with valid refs.
        snapshotCache.delete(sessionId);
        lastFilledTarget.delete(sessionId);

        // Run press and treat navigation-kill exits as success.
        // playwright-cli exits with -1 or null when the page navigates away mid-keypress —
        // that is the expected outcome of a form submit via Enter.
        const pressRes = await cliRun([...S, 'press', pressKey], timeoutMs);
        logger.info(`[browser.act] press ${pressKey} → exit ${pressRes.exitCode}`, { stderr: pressRes.stderr?.slice(0, 200) });
        const navigationKill = pressRes.exitCode === -1 || pressRes.exitCode === null;
        if (navigationKill) {
          // Daemon process was killed by the navigation. Remove from openSessions so the
          // next navigate re-probes the daemon (isDaemonAlive) rather than blindly using
          // goto on a dead session — which would succeed but leave the tab on about:blank.
          openSessions.delete(sessionId);
          // Give the browser ~2s to finish loading the new page before the next action.
          await new Promise(r => setTimeout(r, 2000));
          // Re-add to openSessions: the browser window is still open, just the session
          // daemon needs a fresh probe. isDaemonAlive will confirm on next navigate call.
        }
        return {
          ok:            pressRes.ok || navigationKill,
          action,
          sessionId,
          result:        (pressRes.stdout || '').trim() || undefined,
          stdout:        pressRes.stdout,
          executionTime: Date.now() - start,
          error:         (pressRes.ok || navigationKill) ? undefined : pressRes.error || pressRes.stderr?.trim(),
        };
      }
      // playwright-cli exits 0 even for invalid keys but writes the error into stdout.
      // Detect and surface those as failures so plan repair fires instead of silently continuing.
      const _pressRes = await run(['press', pressKey], `press ${pressKey}`);
      if (_pressRes.ok && /\bError\b/i.test(_pressRes.stdout || '')) {
        const _pressErr = (_pressRes.stdout || '').match(/Error[:\s].+/i)?.[0]?.trim() || `press failed: unknown key '${pressKey}'`;
        logger.warn(`[browser.act] press ${pressKey}: stdout error detected — ${_pressErr}`);
        return { ..._pressRes, ok: false, error: _pressErr };
      }
      return _pressRes;
    }
    case 'keydown': return run(['keydown', key || ''], `keydown ${key}`);
    case 'keyup':   return run(['keyup',   key || ''], `keyup ${key}`);

    // ── Scroll ───────────────────────────────────────────────────────────────
    // Accepts: direction ('up'|'down'|'left'|'right'), distance ('100%'|number px),
    // dx/dy raw pixels (legacy). Maps to playwright-cli mousewheel <dx> <dy>.
    case 'scroll': {
      const direction = args.direction || 'down';
      const distance  = args.distance;
      let scrollDx = dx;
      let scrollDy = dy;
      // Parse distance: '100%' → full document height, numeric string → pixels
      if (distance !== undefined) {
        if (String(distance) === '100%' || String(distance).toLowerCase() === 'bottom') {
          // Scroll to absolute bottom via eval, then mousewheel a large value
          scrollDy = 99999;
        } else if (String(distance) === '0%' || String(distance).toLowerCase() === 'top') {
          scrollDy = -99999;
        } else {
          const px = parseInt(String(distance), 10);
          if (!isNaN(px)) scrollDy = px;
        }
      }
      // Apply direction to sign
      if (direction === 'up')    scrollDy = -Math.abs(scrollDy);
      if (direction === 'down')  scrollDy =  Math.abs(scrollDy);
      if (direction === 'left')  { scrollDx = -Math.abs(scrollDy); scrollDy = 0; }
      if (direction === 'right') { scrollDx =  Math.abs(scrollDy); scrollDy = 0; }
      logger.info(`[browser.act] scroll dx=${scrollDx} dy=${scrollDy} (direction=${direction} distance=${distance ?? 'default'})`);
      return run(['mousewheel', String(scrollDx), String(scrollDy)], `scroll dx=${scrollDx} dy=${scrollDy}`);
    }

    // ── Screenshot ───────────────────────────────────────────────────────────
    case 'screenshot': {
      const outPath = filePath || path.join(os.tmpdir(), `screenshot_${sessionId}_${Date.now()}.png`);
      const res = await cliRun([...S, 'screenshot', outPath], timeoutMs);
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.ok ? outPath : undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── PDF ──────────────────────────────────────────────────────────────────
    case 'pdf': {
      const outPath = filePath || path.join(os.tmpdir(), `page_${sessionId}_${Date.now()}.pdf`);
      const res = await cliRun([...S, 'pdf', outPath], timeoutMs);
      return {
        ok:            res.ok,
        action,
        sessionId,
        result:        res.ok ? outPath : undefined,
        executionTime: Date.now() - start,
        error:         res.ok ? undefined : res.error,
      };
    }

    // ── getText / getPageText ─────────────────────────────────────────────────
    case 'getText':
    case 'getPageText': {
      // Eval expression: wait for readyState complete, then grab innerText (fall back to textContent).
      // Truncated to 100k to avoid timeout on large pages. Wrapping in an IIFE avoids
      // playwright-cli treating multi-statement code as a syntax error.
      const evalExpr = '(function(){var b=document.body;return b?(b.innerText||b.textContent||"").slice(0,100000):"";})()';
      const res = await cliRun([...S, 'eval', evalExpr], Math.min(timeoutMs, 20000));
      // playwright-cli eval wraps output as: ### Result\n"<value>"\n### Ran Playwright code...
      // Extract just the bare value from the ### Result block
      const rawOut = (res.stdout || '').trim();
      const resultMatch = rawOut.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
      const pageText = resultMatch
        ? resultMatch[1].trim().replace(/^"|"$/g, '')
        : rawOut;

      // Non-ok with partial stdout: the eval ran but exited non-zero (common on SPA pages
      // with pending microtasks). If we got usable text, treat as ok.
      // Non-ok with empty stdout: page not ready — return soft-pass with empty string so
      // the synthesize step can still work with whatever prior steps collected.
      const effectiveOk = res.ok || pageText.length > 0;
      return {
        ok:            effectiveOk,
        action,
        sessionId,
        stdout:        pageText,
        result:        pageText,
        executionTime: Date.now() - start,
        error:         effectiveOk ? undefined : res.error,
      };
    }

    // ── evaluate ─────────────────────────────────────────────────────────────
    case 'evaluate': {
      const expr = text || selector || args.expression || '';
      const evalRef = args.ref || null;
      const evalArgs = evalRef ? ['eval', expr, evalRef] : ['eval', expr];
      return run(evalArgs, `eval "${expr.slice(0, 60)}"`);
    }

    // ── run-code ──────────────────────────────────────────────────────────────
    // Runs a full multi-line Playwright Node.js snippet in the current page context.
    // `page` is available. Use a `return` statement to emit a result value.
    // playwright-cli prints the return value as "### Result\n<value>".
    case 'run-code': {
      let code = (args.code || text || '').trim();
      if (!code) {
        return { ok: false, action, sessionId, error: 'run-code: code is required', executionTime: Date.now() - start };
      }
      // playwright-cli run-code requires: async page => { ... }
      // Auto-wrap raw statement snippets — top-level const/let are invalid in the
      // Function() context playwright-cli uses internally.
      const isWrapped = /^async\s+page\s*=>/.test(code) || /^async\s*\(/.test(code);
      if (!isWrapped) {
        code = `async page => {\n${code}\n}`;
      }
      const rcRes = await cliRun([...S, 'run-code', code], timeoutMs);
      logger.info(`[browser.act] run-code → exit ${rcRes.exitCode}`, { stderr: rcRes.stderr?.slice(0, 200) });
      // Extract the result value from "### Result\n<value>" in stdout
      const rcStdout = rcRes.stdout || '';
      const rcMatch = rcStdout.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
      const rcResult = rcMatch ? rcMatch[1].trim().replace(/^"|"$/g, '') : rcStdout.trim();
      const PLAYWRIGHT_HARD_ERR = /^### Error|Error:/im;
      if (!rcRes.ok || PLAYWRIGHT_HARD_ERR.test(rcStdout)) {
        const errMatch = rcStdout.match(/([A-Za-z]*Error:[^\n]+)/);
        const errMsg = errMatch ? errMatch[1].trim() : (rcRes.error || rcRes.stderr?.trim() || 'run-code failed');
        logger.warn(`[browser.act] run-code error: ${errMsg}`);
        return { ok: false, action, sessionId, result: rcStdout.trim(), stdout: rcStdout, error: errMsg, executionTime: Date.now() - start };
      }
      return { ok: true, action, sessionId, result: rcResult, stdout: rcStdout, executionTime: Date.now() - start };
    }

    // ── dialog-accept / dialog-dismiss ────────────────────────────────────────
    case 'dialog-accept': {
      const prompt = args.prompt || text || undefined;
      return run(prompt ? ['dialog-accept', prompt] : ['dialog-accept'], 'dialog-accept');
    }
    case 'dialog-dismiss': {
      return run(['dialog-dismiss'], 'dialog-dismiss');
    }

    // ── waitForSelector ───────────────────────────────────────────────────────
    case 'waitForSelector': {
      // "body" is not in the accessibility tree so resolveRef will never find it,
      // but it trivially always exists — treat as a post-navigation settle wait.
      if (!selector || /^body$/i.test(selector.trim())) {
        await new Promise(r => setTimeout(r, 1500));
        return { ok: true, action, sessionId, result: 'body', executionTime: Date.now() - start };
      }
      // Poll snapshot until ref matching selector appears
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await captureSnapshot(sessionId, headed, 5000);
        const ref = resolveRef(sessionId, selector);
        if (ref) {
          return { ok: true, action, sessionId, result: ref, executionTime: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { ok: false, action, sessionId, error: `Timeout waiting for selector: "${selector}"`, executionTime: Date.now() - start };
    }

    // ── waitForContent ────────────────────────────────────────────────────────
    case 'waitForContent': {
      const needle = text || selector || '';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapRes = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,50000)'], 8000);
        if (snapRes.stdout.includes(needle)) {
          return { ok: true, action, sessionId, result: needle, executionTime: Date.now() - start };
        }
        await new Promise(r => setTimeout(r, 1500));
      }
      return { ok: false, action, sessionId, error: `Timeout waiting for content: "${needle}"`, executionTime: Date.now() - start };
    }

    // ── waitForTrigger ────────────────────────────────────────────────────────
    // TRUE event-driven wait: injects a one-shot event listener, polls for the
    // flag or a URL change. Unlike waitForStableText, this does NOT fire until the
    // user actually clicks, types, or submits something on the page.
    case 'waitForTrigger': {
      // Minified inject script — registers a trusted-click-only listener on the page.
      // isTrusted=false for synthetic JS-dispatched events (framework side-effects,
      // mouse move events that bubble as clicks, etc.) — only real user clicks advance.
      const injectScript = `(function(){if(window.__tdListenerAttached)return;window.__tdTriggered=false;window.__tdListenerAttached=true;document.addEventListener('click',function h(e){if(!e.isTrusted)return;window.__tdTriggered=true;document.removeEventListener('click',h,true);},{capture:true});})()`;
      await cliRun([...S, 'eval', injectScript], 5000).catch(() => {});

      const TRG_AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple)\b/i;
      const TRG_AUTH_WALL_BODY  = /\b(sign in|log in|sign up)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password)\b/i;

      // Capture initial URL so we can detect navigation
      const extractResult = (stdout) => {
        const m = stdout.trim().match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
        return (m ? m[1].trim() : stdout.trim()).replace(/^"|"$/g, '');
      };
      let prevUrl = '';
      try {
        prevUrl = extractResult((await cliRun([...S, 'eval', 'location.href'], 4000)).stdout);
      } catch (_) {}

      const effectiveTriggerTimeout = Math.min(timeoutMs, 300000);
      const triggerDeadline = Date.now() + effectiveTriggerTimeout;
      let authCheckCounter = 0;
      let consecutivePollErrors = 0;

      while (Date.now() < triggerDeadline) {
        await new Promise(r => setTimeout(r, 1200));
        try {
          // 1. Check interaction flag
          const flagVal = extractResult((await cliRun([...S, 'eval', '!!(window.__tdTriggered)'], 4000)).stdout);
          if (flagVal === 'true') {
            await cliRun([...S, 'eval', 'window.__tdTriggered=false;window.__tdListenerAttached=false;'], 3000).catch(() => {});
            return { ok: true, action, sessionId, result: 'triggered', executionTime: Date.now() - start };
          }

          // 2. Check URL change (user clicked a navigation link / submitted a form)
          const curUrl = extractResult((await cliRun([...S, 'eval', 'location.href'], 4000)).stdout);
          if (prevUrl && curUrl && curUrl !== prevUrl && !curUrl.startsWith('about:')) {
            return { ok: true, action, sessionId, result: 'navigation', currentUrl: curUrl, executionTime: Date.now() - start };
          }
          if (curUrl && !curUrl.startsWith('about:')) prevUrl = curUrl;

          // 3. Auth-wall check every 3 polls (saves bandwidth on static pages)
          authCheckCounter++;
          if (authCheckCounter % 3 === 0) {
            const curTxt = extractResult((await cliRun([...S, 'eval', '(document.body.innerText||"").slice(0,800)'], 5000)).stdout);
            const firstLine = curTxt.split('\n')[0].trim();
            if (TRG_AUTH_WALL_FIRST.test(firstLine) || TRG_AUTH_WALL_BODY.test(curTxt.slice(0, 500))) {
              return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: curTxt.slice(0, 100), executionTime: Date.now() - start };
            }
            // Re-inject listener after page potentially changed (navigation, SPA route)
            await cliRun([...S, 'eval', injectScript], 5000).catch(() => {});
          }
          // Reset consecutive error counter on any successful poll
          consecutivePollErrors = 0;
        } catch (pollErr) {
          consecutivePollErrors++;
          // If every poll is failing, the browser session doesn't exist — fail fast
          // instead of looping silently for up to 5 minutes.
          if (consecutivePollErrors >= 3) {
            return { ok: false, action, sessionId, error: `waitForTrigger: no active browser session "${sessionId}" — playwright-cli is not running or the session was never opened`, executionTime: Date.now() - start };
          }
          logger.debug?.(`[browser.act] waitForTrigger: poll error — ${pollErr.message?.slice(0, 60)}`);
        }
      }
      return { ok: false, action, sessionId, error: `waitForTrigger: timeout after ${timeoutMs}ms — no user interaction detected`, executionTime: Date.now() - start };
    }

    // ── waitForNavigation — alias to waitForStableText ────────────────────────
    // Falls through to waitForStableText which polls until page text stabilises.
    case 'waitForNavigation':
    // ── waitForStableText ─────────────────────────────────────────────────────
    case 'waitForStableText': {
      // Auth-wall patterns — text that indicates a login/sign-in page, not real content
      const AUTH_WALL_FIRST = /^(sign in|log in|sign up|create account|join today|continue with google|continue with apple|sign in to x|sign in with google|sign in with apple|login to|log into|happening now|where should we begin)\b/i;
      const AUTH_WALL_BODY = /\b(sign in|log in|sign up|join today|create account)\b[\s\S]{0,400}\b(google|apple|email|phone|username|password|sign up with|continue with)\b/i;
      // Logged-out UI patterns — sites that show a guest/unauthenticated landing page
      const AUTH_WALL_LOGGEDOUT = /\b(log in|sign in|sign up for free)\b[\s\S]{0,200}\b(where should we begin|get started|create account|free account|try for free)\b/i;
      // Chrome crash-restore dialog
      const RESTORE_DIALOG = /restore pages?\?|chrome didn't shut down correctly|help make google chrome better/i;

      // Cap effective timeout at 30s — MCPClient transport timeout is 60s.
      // Each cliRun eval can take up to 8s, so we need a hard pre-check before
      // each iteration to avoid overshooting. Stop if <10s remain to leave buffer.
      const effectiveTimeout = Math.min(timeoutMs, 30000);
      let prev = '';
      const loopStart = Date.now();
      const deadline = loopStart + effectiveTimeout;
      while (Date.now() < deadline) {
        // Hard bail: if less than 10s left, don't start another 8s eval — return what we have
        if (deadline - Date.now() < 10000) break;

        // Fail fast on about:blank so callers can recover instead of re-planning on empty data.
        try {
          const urlProbe = await cliRun([...S, 'eval', 'window.location.href'], 2000);
          const urlRaw = (urlProbe.stdout || '').trim();
          const urlMatch = urlRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          const curUrl = (urlMatch ? urlMatch[1] : urlRaw).trim().replace(/^"|"$/g, '');
          if (/about:blank/i.test(curUrl)) {
            logger.warn(`[browser.act] waitForStableText: page is about:blank for session=${sessionId}`);
            return {
              ok: true,
              action,
              sessionId,
              result: '',
              stdout: '',
              aboutBlankDetected: true,
              executionTime: Date.now() - start,
            };
          }
        } catch (_) {
          // URL probe failures are transient; continue polling page text.
        }

        // Truncate to 50k chars to prevent huge pages (YouTube, Reddit) from timing out the eval.
        // A SIGTERM to playwright-cli mid-eval causes it to navigate the tab to about:blank as cleanup.
        const r = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,50000)'], 8000);
        // playwright-cli eval wraps output as: ### Result\n"<value>"\n### Ran Playwright code...
        // Extract just the bare innerText value
        const rawOut = (r.stdout || '').trim();
        const resultMatch = rawOut.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
        const cur = resultMatch
          ? resultMatch[1].trim().replace(/^"|"$/g, '')
          : rawOut;

        // Detect Chrome restore dialog — dismiss it with Escape (native browser UI, not page DOM)
        if (RESTORE_DIALOG.test(cur)) {
          logger.info(`[browser.act] waitForStableText: Chrome restore dialog detected — pressing Escape`);
          await cliRun([...S, 'press', 'Escape'], 3000);
          await new Promise(r2 => setTimeout(r2, 600));
          await cliRun([...S, 'press', 'Escape'], 3000);
          await new Promise(r2 => setTimeout(r2, 600));
          prev = '';
          continue;
        }

        if (cur && cur === prev) {
          // Check if stable content is an auth wall
          const firstLine = cur.split('\n')[0].trim();
          const isAuthWall = AUTH_WALL_FIRST.test(firstLine) || AUTH_WALL_BODY.test(cur.slice(0, 500)) || AUTH_WALL_LOGGEDOUT.test(cur.slice(0, 600));
          if (isAuthWall) {
            logger.info(`[browser.act] waitForStableText: auth wall detected for session=${sessionId}`);
            return { ok: true, action, sessionId, result: '', stdout: '', authRequired: true, authWallText: cur.slice(0, 100), executionTime: Date.now() - start };
          }
          return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
        }
        // Early-exit: if content is substantial and barely changed since last poll,
        // treat as "stable enough". Pages like YouTube search keep micro-updating
        // (ad slots, counters) so perfect equality never happens within the window.
        if (prev && cur && cur.length > 1000) {
          const longer = Math.max(prev.length, cur.length);
          const changeRatio = Math.abs(cur.length - prev.length) / longer;
          if (changeRatio < 0.05) {
            logger.info(`[browser.act] waitForStableText: near-stable (${(changeRatio * 100).toFixed(1)}% change) — returning early`);
            return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
          }
          // Streaming-growth exit: AI answer pages (Grok, Perplexity, ChatGPT) keep growing
          // continuously — content never stabilizes. If we've been polling >15s and have
          // substantial content, accept what we have rather than waiting for the full timeout.
          const elapsed = Date.now() - loopStart;
          if (elapsed > 15000 && cur.length > 2000) {
            logger.info(`[browser.act] waitForStableText: streaming page, ${elapsed}ms elapsed with ${cur.length} chars — accepting`);
            return { ok: true, action, sessionId, result: cur, executionTime: Date.now() - start };
          }
        }
        prev = cur;
        await new Promise(r2 => setTimeout(r2, 800));
      }
      // Timeout — page never stabilized (e.g. YouTube infinite scroll, live feeds).
      // Return whatever we last captured so the user gets real content instead of nothing.
      let finalText = prev;
      if (!finalText) {
        const lastRes = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,50000)'], 8000);
        const lastRaw = (lastRes.stdout || '').trim();
        const lastMatch = lastRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
        finalText = lastMatch ? lastMatch[1].trim().replace(/^"|"$/g, '') : lastRaw;
      }
      return { ok: true, action, sessionId, result: finalText, executionTime: Date.now() - start };
    }

    // ── waitForAuth ───────────────────────────────────────────────────────────
    // Polls the page until it is NO LONGER on a login/auth wall.
    // Used after a login sub-plan to confirm authentication succeeded before
    // the parent plan resumes.
    //
    // Returns:
    //   { ok: true,  authResolved: true }   — page has left the login wall
    //   { ok: false, authTimedOut: true }   — timed out still on login page
    //   { ok: false, authFailed: true }     — explicit error/redirect detected
    case 'waitForAuth': {
      // URL-host state machine — no hardcoded domain lists.
      // authOriginHost = hostname of the sign-in URL (e.g. 'accounts.google.com').
      // Derived dynamically at runtime so any OAuth provider works automatically.
      //
      //  IN_AUTH_FLOW: currentHost === authOriginHost  (email, pwd, 2FA, consent, etc.)
      //  SUCCESS:      currentHost !== authOriginHost  AND urlWithoutQuery includes authSuccessUrl
      //  LIMBO:        currentHost !== authOriginHost  AND NOT at authSuccessUrl
      let authOriginHost = null;
      let authSignInPath   = null; // for same-domain path exit (e.g. notion.so/login → notion.so/onboarding)
      try { if (url) { const _u = new URL(url); authOriginHost = _u.hostname; authSignInPath = _u.pathname; } } catch (_) {}
      const getHost = (u) => { try { return new URL(u).hostname; } catch (_) { return ''; } };
      let lastLimboUrl = null;     // anti-loop guard
      let backToSignInCount = 0;   // RC2: hard stop — max 3 code-triggered back-to-sign-in navigations

      // Default timeout: 120s — enough for a human to complete 2FA or MFA
      const effectiveTimeout = Math.min(timeoutMs || 120000, 120000);
      const pollInterval = 2000;

      // ── Step 1: navigate to url first so the browser actually opens ──────
      // Without this the daemon never starts, eval returns empty text, and we
      // spin until timeout on about:blank (the session's last page or nothing).
      if (url) {
        const navTimeout = 30000;
        let alreadyOpen = openSessions.has(sessionId);
        if (!alreadyOpen) {
          alreadyOpen = await isDaemonAlive(sessionId, headed);
          if (alreadyOpen) openSessions.add(sessionId);
        }
        const navCmd = alreadyOpen ? 'goto' : 'open';
        if (!alreadyOpen) clearProfileLock(sessionId);
        snapshotCache.delete(sessionId);
        const navRes = await cliRun([...S, navCmd, url], navTimeout);
        if (navRes.ok) openSessions.add(sessionId);
        logger.info(`[browser.act] waitForAuth: navigated to ${url} on session=${sessionId} (cmd=${navCmd}, ok=${navRes.ok})`);
      }

      // ── Step 1b: Agentic auth form loop ──────────────────────────────────
      // snapshot → LLM → execute → snapshot → LLM → repeat.
      // All page-transition waits are event-driven (URL change / element visibility)
      // rather than fixed sleeps. No hardcoded timing or branch logic.
      const _credentials = credentials || {};
      try {
        const _hasEmail    = !!(_credentials.email);
        const _hasPassword = !!(_credentials.password);
        let _loopFilledEmail    = false;
        let _loopFilledPassword = false;
        const _actionHistory   = []; // actions completed this session
        let _stallCount        = 0;  // consecutive click_submit stalls

        // ── Helper: extract URL value from playwright-cli eval stdout
        const _parseUrl = (stdout) => {
          const raw = (stdout || '').trim();
          const m = raw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          return (m ? m[1].trim().replace(/^"|"$/g, '') : raw).trim();
        };

        // ── Helper: inline 2-poll text settle (~600–1200ms).
        // waitForStableText exits immediately on auth pages (auth-wall early-exit pattern)
        // so we do our own lightweight settle: two eval polls 600ms apart.
        const _textSettle = async () => {
          const _et = async () => {
            const r = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,500)'], 5000).catch(() => ({}));
            const raw = (r.stdout || '').trim();
            const m = raw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
            return m ? m[1].trim().replace(/^"|"$/g, '') : raw;
          };
          const t1 = await _et();
          await new Promise(r => setTimeout(r, 600));
          const t2 = await _et();
          if (t1 !== t2) await new Promise(r => setTimeout(r, 600)); // still changing — one more pause
        };

        // ── Helper: poll until a matching input is fully visible on screen.
        // Checks display, visibility, opacity (>= 0.9), offsetHeight/Width — catches
        // Google's hidden input[type="password"] on the email page (opacity:0, height:0).
        // Returns the most specific selector available (#id > [name=x] > fallback) or null.
        const _waitVisible = async (type /* 'email' | 'password' */, fallbackSel, timeoutMs = 15000) => {
          const query = type === 'email'
            ? 'input[type="email"],input[autocomplete="email"],input[autocomplete="username"],input[name="email"],input[name="username"],input[name="identifier"],input#identifierId'
            : 'input[type="password"]';
          const jsCheck = `() => {
            const els = [...document.querySelectorAll(${JSON.stringify(query)})];
            const vis = els.find(el => {
              const cs = window.getComputedStyle(el);
              return cs.display !== 'none'
                && cs.visibility !== 'hidden'
                && parseFloat(cs.opacity || '1') >= 0.9
                && el.offsetHeight > 0
                && el.offsetWidth > 0;
            });
            if (!vis) return null;
            if (vis.id) return '#' + vis.id;
            if (vis.name) return '[name="' + vis.name + '"]';
            return ${JSON.stringify(fallbackSel)};
          }`;
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const r = await cliRun([...S, 'eval', jsCheck], 5000).catch(() => ({}));
            const raw = (r.stdout || '').trim();
            const m = raw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
            const val = (m ? m[1].trim().replace(/^"|"$/g, '') : raw).trim();
            if (val && val !== 'null' && val !== '') {
              await new Promise(r2 => setTimeout(r2, 500)); // 500ms buffer: animation completing
              return val; // specific selector of the visible element
            }
            await new Promise(r2 => setTimeout(r2, 500));
          }
          return null; // timed out
        };

        // ── Helper: get comma-separated list of truly-visible input types for LLM hint.
        // Filters hidden inputs (Google hides password input during email page via opacity:0/height:0)
        // so the LLM gets an accurate picture of what's actually on screen.
        const _visibleInputsHint = async () => {
          const jsVis = `() => [...document.querySelectorAll('input')].filter(el => {
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden'
              && parseFloat(cs.opacity || '1') >= 0.9 && el.offsetHeight > 0;
          }).map(el => el.type + (el.id ? '#' + el.id : (el.name ? '[' + el.name + ']' : ''))).join(',') || 'none'`;
          const r = await cliRun([...S, 'eval', jsVis], 5000).catch(() => ({}));
          const raw = (r.stdout || '').trim();
          const m = raw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          return (m ? m[1].trim().replace(/^"|"$/g, '') : raw) || 'unknown';
        };

        for (let _step = 0; _step < 8; _step++) {
          // 1. Inline text settle — waits for DOM text to stop changing
          await _textSettle();

          // 2. Snapshot (ARIA accessibility tree)
          const _snapRes = await cliRun([...S, 'snapshot'], 8000).catch(() => ({}));
          const _snapText = (_snapRes.stdout || '').trim();
          if (!_snapText) { logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — empty snapshot, stopping`); break; }
          snapshotCache.set(sessionId, _snapText);

          // 3. Check if URL has left auth domain
          const _luProbe = await cliRun([...S, 'eval', 'location.href'], 5000).catch(() => ({}));
          const _luUrl   = _parseUrl(_luProbe.stdout);
          const _luHost  = _luUrl ? (() => { try { return new URL(_luUrl).hostname; } catch (_) { return ''; } })() : '';
          if (authOriginHost && _luHost && _luHost !== authOriginHost) {
            logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — navigated away from auth domain (${_luHost}), done`);
            break;
          }

          // 4. Get truly-visible inputs — filters CSS-hidden inputs from LLM context
          const _visHint = await _visibleInputsHint();
          logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} visible-inputs=${_visHint}`);

          // 5. Ask LLM what to do next
          let _dec = null;
          try {
            const _credHint = `Available credentials: has_email=${_hasEmail}, has_password=${_hasPassword}`;
            const _histHint = _actionHistory.length ? `Completed actions: ${_actionHistory.join(' → ')}` : 'Completed actions: none';
            const _llmRaw = await askWithMessages([
              { role: 'system', content: AUTH_FORM_PROMPT },
              { role: 'user',   content: `${_credHint}\n${_histHint}\nVisible inputs: ${_visHint}\n\nPAGE SNAPSHOT:\n${_snapText.slice(0, 6000)}` },
            ], { temperature: 0.1, maxTokens: 128, responseTimeoutMs: 15000 });
            let _s = _llmRaw.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
            try { _dec = JSON.parse(_s); } catch (_) {
              const _m = _s.match(/\{[\s\S]*?\}/);
              if (_m) try { _dec = JSON.parse(_m[0]); } catch (_) {}
            }
          } catch (_le) {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} LLM error — ${_le.message}`);
            break;
          }

          if (!_dec?.action) {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — unparseable LLM response, stopping`);
            break;
          }

          const _sel = _dec.selector ? String(_dec.selector).replace(/^@/, '') : null;
          logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} action=${_dec.action} sel="${_sel}" | ${_dec.rationale}`);

          // 6. Execute action
          if (_dec.action === 'fill_email' && _hasEmail) {
            // Poll until email input is truly visible before clicking
            const _visSel = await _waitVisible('email', _sel || 'input[type="email"]');
            if (!_visSel) {
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} fill_email — email input not visible after 15s, re-snapshotting`);
              continue;
            }
            await cliRun([...S, 'click', _visSel], 5000).catch(() => {});
            await new Promise(r => setTimeout(r, 150));
            await cliRun([...S, 'press', 'Meta+a'], 3000).catch(() => {});
            await cliRun([...S, 'type', _credentials.email], 8000).catch(() => {});
            _loopFilledEmail = true;
            _actionHistory.push('fill_email');

          } else if (_dec.action === 'fill_password' && _hasPassword) {
            // Poll until password input is truly visible (opacity >= 0.9, height > 0).
            // Google keeps a hidden input[type="password"] in the email page DOM during the
            // slide transition. _waitVisible returns the specific selector of the VISIBLE
            // element (e.g. "#password"), not the generic css which would hit the hidden copy.
            const _visSel = await _waitVisible('password', _sel || 'input[type="password"]');
            if (!_visSel) {
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} fill_password — password input not visible after 15s, re-snapshotting`);
              continue;
            }
            await cliRun([...S, 'click', _visSel], 5000).catch(() => {});
            await new Promise(r => setTimeout(r, 150));
            await cliRun([...S, 'press', 'Meta+a'], 3000).catch(() => {});
            await cliRun([...S, 'type', _credentials.password], 8000).catch(() => {});
            _loopFilledPassword = true;
            _actionHistory.push('fill_password');

          } else if (_dec.action === 'click_submit') {
            // Capture pre-click state for both transition signals.
            // Signal 1 (URL): works for traditional multi-page sites and SPA pushState/replaceState.
            // Signal 2 (DOM): works for SPA DOM-only transitions — e.g. Google GlifWebSignIn
            //   keeps accounts.google.com/v3/signin/identifier URL CONSTANT throughout
            //   the email→password transition; only visible inputs change.
            const _preClickUrl = _luUrl;
            const _preVisHint  = _visHint; // captured earlier this iteration, free re-use
            if (_sel) {
              const _cr = await cliRun([...S, 'click', _sel], 5000).catch(() => ({ ok: false }));
              if (!_cr?.ok) await cliRun([...S, 'press', 'Return'], 3000).catch(() => {});
            } else {
              await cliRun([...S, 'press', 'Return'], 3000).catch(() => {});
            }
            // Poll until URL OR visible-inputs changes — whichever fires first confirms transition.
            // 12s deadline: Google CSS slide animation + network round-trip can take 2-3s.
            const _navDeadline = Date.now() + 12000;
            let _navConfirmed = false;
            let _transitionReason = '';
            while (Date.now() < _navDeadline) {
              await new Promise(r => setTimeout(r, 500));
              // Signal 1: URL change (traditional multi-page + SPA pushState)
              const _postProbe = await cliRun([...S, 'eval', 'location.href'], 5000).catch(() => ({}));
              const _postUrl   = _parseUrl(_postProbe.stdout);
              if (_postUrl && _postUrl !== _preClickUrl) {
                _transitionReason = `URL: ${_preClickUrl} → ${_postUrl}`;
                _navConfirmed = true;
                _stallCount = 0;
                break;
              }
              // Signal 2: visible-inputs DOM change (SPA DOM-only transition, e.g. Google)
              const _postVis = await _visibleInputsHint();
              if (_postVis && _postVis !== 'unknown' && _postVis !== _preVisHint) {
                _transitionReason = `DOM: ${_preVisHint} → ${_postVis}`;
                _navConfirmed = true;
                _stallCount = 0;
                break;
              }
            }
            if (_navConfirmed) {
              logger.info(`[browser.act] waitForAuth: auth-loop step ${_step + 1} click_submit transition confirmed (${_transitionReason})`);
            } else {
              _stallCount++;
              logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} click_submit no transition after 12s, stall=${_stallCount}`);
              if (_stallCount >= 1) {
                // First stall: press Return as keyboard-submit fallback
                logger.info(`[browser.act] waitForAuth: auth-loop stall fallback — pressing Return`);
                await cliRun([...S, 'press', 'Return'], 3000).catch(() => {});
                _stallCount = 0;
                await new Promise(r => setTimeout(r, 1500));
              }
            }
            _actionHistory.push('click_submit');

          } else if (_dec.action === 'done') {
            logger.info(`[browser.act] waitForAuth: auth-loop done after ${_step + 1} step(s) for session=${sessionId}`);
            break;

          } else {
            logger.warn(`[browser.act] waitForAuth: auth-loop step ${_step + 1} — action "${_dec.action}" skipped/unexpected, stopping`);
            break;
          }
        }

        // ── OAuth / SSO button fallback ────────────────────────────────────
        // If the loop ran but no credentials were filled (no credential form found),
        // look for a "Continue with Google" / SSO button.
        if (!_loopFilledEmail && !_loopFilledPassword) {
          const _oauthEval = `() => {
            const RE = /Continue with Google|Sign in with Google|Log in with Google|Sign in with SSO/i;
            const btn = [...document.querySelectorAll('button,[role=button],[role=link],a')]
              .find(b => RE.test((b.textContent || '').trim()) || RE.test(b.getAttribute('aria-label') || ''));
            if (btn) { btn.click(); return 'clicked'; }
            return 'not-found';
          }`;
          const _oauthRes = await cliRun([...S, 'eval', _oauthEval], 6000).catch(() => ({}));
          if ((_oauthRes.stdout || '').includes('clicked')) {
            logger.info(`[browser.act] waitForAuth: OAuth button clicked for session=${sessionId}`);
            await new Promise(r => setTimeout(r, 2000));
          } else {
            logger.info(`[browser.act] waitForAuth: no form or OAuth button found for session=${sessionId} — passive poll`);
          }
        }
      } catch (_formErr) {
        logger.warn(`[browser.act] waitForAuth: form handler error (non-fatal): ${_formErr.message}`);
      }

      // ── Step 2: poll until auth wall clears ──────────────────────────────
      // Start deadline AFTER navigation so the full effectiveTimeout is for the login wait.
      const deadline = Date.now() + effectiveTimeout;

      logger.info(`[browser.act] waitForAuth: waiting for auth wall to clear on session=${sessionId} (timeout=${effectiveTimeout}ms)`);

      // On first auth wall detection, immediately notify the UI via _progressCallbackUrl
      // then keep polling until the user signs in — no second request needed.
      let authWallDetections = 0;
      let loginNotificationSent = false;

      while (Date.now() < deadline) {
        await new Promise(r2 => setTimeout(r2, pollInterval));

        try {
          // Two separate evals — playwright-cli JSON-stringifies results so \n in a
          // JS string literal becomes the two chars \ and n in stdout; combined eval
          // separator indexOf always returns -1 and currentUrl silently stays empty.
          const urlRes = await cliRun([...S, 'eval', 'location.href'], 5000);
          const urlRaw = (urlRes.stdout || '').trim();
          const urlMatch = urlRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
          const currentUrl = (urlMatch ? urlMatch[1].trim().replace(/^"|"$/g, '') : urlRaw).trim();

          if (!currentUrl) continue;

          const currentHost     = getHost(currentUrl);
          const urlWithoutQuery = currentUrl.split('?')[0];

          // State 1: SUCCESS — different host from auth domain AND at success URL
          const atSuccess = authSuccessUrl
            ? (urlWithoutQuery.includes(authSuccessUrl) && currentHost !== authOriginHost)
            : (!!currentHost && !!authOriginHost && currentHost !== authOriginHost);
          if (atSuccess) {
            logger.info(`[browser.act] waitForAuth: success URL matched (${currentUrl}) for session=${sessionId}`);
            return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
          }

          // State 2: IN AUTH FLOW — same hostname as sign-in URL
          // Covers: email entry, password challenge, 2FA, MFA, consent screen — never navigate away
          const inAuthFlow = !!authOriginHost && currentHost === authOriginHost;
          if (inAuthFlow) {
            authWallDetections++;
            if (!loginNotificationSent) {
              loginNotificationSent = true;
              logger.info(`[browser.act] waitForAuth: auth wall confirmed — notifying user, continuing to poll session=${sessionId} loginUrl=${url}`);
              if (_progressCallbackUrl) {
                const http = require('http');
                const serviceDisplay = sessionId.replace('_agent', '');
                const _payload = JSON.stringify({
                  type: 'needs_login', sessionId, loginUrl: url, serviceDisplay,
                  message: `Please sign in to **${serviceDisplay}** in the Chrome window that just opened (${url}).`,
                });
                const _req = http.request({
                  hostname: '127.0.0.1',
                  port: parseInt(new URL(_progressCallbackUrl).port, 10),
                  path: new URL(_progressCallbackUrl).pathname,
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(_payload) },
                  timeout: 2000,
                });
                _req.on('error', () => {});
                _req.write(_payload);
                _req.end();
              }
            }
            // Spot-check for error signals every 5th poll (wrong password, account locked, etc.)
            if (authWallDetections % 5 === 0) {
              const errRes = await cliRun([...S, 'eval', 'document.body.innerText.slice(0,600)'], 5000);
              const errRaw = (errRes.stdout || '').trim();
              const errMatch = errRaw.match(/###\s*Result\s*\n([\s\S]*?)(?=###|$)/i);
              const errText = (errMatch ? errMatch[1].trim().replace(/^"|"$/g, '') : errRaw).trim();
              const errorSignals = /wrong password|incorrect password|invalid credentials|account locked|too many attempts|verify it's you/i;
              if (errorSignals.test(errText)) {
                logger.warn(`[browser.act] waitForAuth: auth error detected on session=${sessionId}`);
                return { ok: false, action, sessionId, authFailed: true, error: 'Authentication error detected — wrong credentials or account locked', executionTime: Date.now() - start };
              }
            }
            // ── Same-domain path exit ────────────────────────────────────────
            // Handles services like Notion where sign-in URL and workspace URL share
            // the same hostname (notion.so/login → notion.so/onboarding).
            // If the path has moved away from the sign-in path, auth is complete.
            if (authSignInPath) {
              try {
                const currentPath = new URL(currentUrl).pathname;
                const leftLoginPage = currentPath !== authSignInPath &&
                  !/\/(login|signin|sign-in|sign_in|auth|oauth|authorize)\b/i.test(currentPath);
                if (leftLoginPage) {
                  logger.info(`[browser.act] waitForAuth: same-domain path exit — left login page (${authSignInPath} → ${currentPath}) for session=${sessionId}`);
                  return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
                }
              } catch (_) {}
            }
            logger.debug(`[browser.act] waitForAuth: in auth flow at ${currentUrl} (${authWallDetections} polls), ${Math.round((deadline - Date.now()) / 1000)}s remaining`);
            continue;
          }

          // State 3: LIMBO — different domain, not at success URL
          if (!authSuccessUrl) {
            // No success URL to validate against — different domain means auth cleared
            logger.info(`[browser.act] waitForAuth: auth wall cleared (different domain) for session=${sessionId}`);
            return { ok: true, action, sessionId, authResolved: true, executionTime: Date.now() - start };
          }

          // RC1: skip transient non-http URLs (about:blank, chrome://, data:, etc.).
          // These appear briefly during any OAuth popup or redirect handshake — they are
          // never a real destination and must NEVER trigger a back-to-sign-in navigation.
          // This applies universally across all services (Notion, Google, GitHub, etc.).
          if (!currentUrl.startsWith('http')) {
            logger.debug(`[browser.act] waitForAuth: transient non-http URL (${currentUrl}) — skipping, waiting for OAuth redirect session=${sessionId}`);
            continue;
          }

          if (lastLimboUrl === currentUrl) {
            // RC2: count how many times the CODE navigates back to sign-in for a stuck URL.
            // The user only signed in once — this counter tracks code-triggered retries only.
            // On the 3rd attempt, give up: the auth flow is genuinely broken.
            backToSignInCount++;
            if (backToSignInCount >= 3) {
              logger.warn(`[browser.act] waitForAuth: back-to-sign-in loop detected (${backToSignInCount} attempts) for stuck URL ${currentUrl} — aborting session=${sessionId}`);
              return { ok: false, action, sessionId, authTimedOut: true, authLoopDetected: true, error: `waitForAuth: stuck in redirect loop at ${currentUrl} — authentication could not complete`, executionTime: Date.now() - start };
            }
            // Stuck in same limbo URL — navigate back to sign-in URL
            logger.info(`[browser.act] waitForAuth: limbo stuck at ${currentUrl} (back-to-sign-in attempt ${backToSignInCount}/3) — navigating back to sign-in`);
            if (url) await cliRun([...S, 'goto', url], 15000).catch(() => {});
            lastLimboUrl = null;
          } else {
            // First time at this intermediate URL — navigate toward authSuccessUrl only if it
            // is a full navigable URL. Pattern substrings (e.g. 'notion.com') are not valid
            // goto targets and cause a redirect oscillation loop.
            lastLimboUrl = currentUrl;
            if (/^https?:\/\//i.test(authSuccessUrl)) {
              logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — navigating to authSuccessUrl=${authSuccessUrl} for session=${sessionId}`);
              await cliRun([...S, 'goto', authSuccessUrl], 15000).catch(() => {});
            } else {
              // authSuccessUrl is a bare hostname pattern (e.g. 'mail.google.com', 'notion.com').
              // Construct a navigable https:// URL from it so we can drive the browser there.
              // This restores the pre-Phase-1 behavior for services like Gmail where the OAuth
              // landing page (myaccount.google.com) differs from the target (mail.google.com).
              const bareHostMatch = /^([\w.-]+\.[a-z]{2,})(\/.*)?$/i.exec(authSuccessUrl);
              if (bareHostMatch) {
                const gotoUrl = `https://${bareHostMatch[1]}`;
                logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — authSuccessUrl is a pattern, constructing goto=${gotoUrl} for session=${sessionId}`);
                await cliRun([...S, 'goto', gotoUrl], 15000).catch(() => {});
              } else {
                logger.info(`[browser.act] waitForAuth: limbo state (${currentUrl}) — authSuccessUrl is a pattern (not a URL), waiting for redirect for session=${sessionId}`);
              }
            }
          }
        } catch (pollErr) {
          logger.debug(`[browser.act] waitForAuth: poll error — ${pollErr.message?.slice(0, 60)}`);
        }
      }

      logger.warn(`[browser.act] waitForAuth: timed out after ${effectiveTimeout}ms on session=${sessionId}`);
      return { ok: false, action, sessionId, authTimedOut: true, error: `waitForAuth: timed out (${effectiveTimeout}ms) — authentication not completed`, executionTime: Date.now() - start };
    }

    // ── scanCurrentPage ───────────────────────────────────────────────────────
    // Returns elements array parsed from snapshot for planSkills pre-scan
    case 'scanCurrentPage': {
      const snapRes = await captureSnapshot(sessionId, headed, timeoutMs);
      const elements = parseSnapshotToElements(snapRes.stdout);
      // Also grab current URL via eval
      const urlRes = await cliRun([...S, 'eval', 'location.href'], 5000);
      return {
        ok:            true,
        action,
        sessionId,
        result: {
          url:      (urlRes.stdout || '').trim() || '',
          elements,
          snapshot: snapRes.stdout,
        },
        executionTime: Date.now() - start,
      };
    }

    // ── Tabs ──────────────────────────────────────────────────────────────────
    // tab-new: opens a new tab; if url provided, navigates to it in the new tab
    case 'tab-new': {
      const tabNewRaw = await cliRun([...S, 'tab-new'], timeoutMs);
      logger.info(`[browser.act] tab-new → exit ${tabNewRaw.exitCode}`, { stderr: tabNewRaw.stderr?.slice(0, 100) });
      if (!tabNewRaw.ok) {
        return { ok: false, action, sessionId, error: tabNewRaw.error || tabNewRaw.stderr?.trim(), executionTime: Date.now() - start };
      }
      // Clear stale snapshot cache — new tab has a fresh page, old refs are invalid
      snapshotCache.delete(sessionId);
      if (url) {
        // Give playwright-cli a moment to register the new tab
        await new Promise(r => setTimeout(r, 400));
        // Get current tab list to find the index of the new (last) tab
        const listRaw = await cliRun([...S, 'tab-list'], 5000);
        const tabCount = ((listRaw.stdout || '').match(/^\s*-\s+\d+:/gm) || []).length;
        const lastIdx = Math.max(0, tabCount - 1);
        // Explicitly select the newest tab so goto targets it, not an older one
        await cliRun([...S, 'tab-select', String(lastIdx)], 5000);
        await new Promise(r => setTimeout(r, 200));
        const gotoRaw = await cliRun([...S, 'goto', url], Math.max(timeoutMs, 30000));
        logger.info(`[browser.act] tab-new[${lastIdx}] goto ${url} → exit ${gotoRaw.exitCode}`, { stderr: gotoRaw.stderr?.slice(0, 100) });
        // After tab navigation, give page time to load before any fill
        await new Promise(r => setTimeout(r, 1200));
        return {
          ok: gotoRaw.ok,
          action,
          sessionId,
          result: (listRaw.stdout || '').trim() || undefined,
          stdout: gotoRaw.stdout || listRaw.stdout,
          executionTime: Date.now() - start,
          error: gotoRaw.ok ? undefined : gotoRaw.error || gotoRaw.stderr?.trim(),
        };
      }
      return {
        ok: true,
        action,
        sessionId,
        result: (tabNewRaw.stdout || '').trim() || undefined,
        stdout: tabNewRaw.stdout,
        executionTime: Date.now() - start,
      };
    }
    case 'tab-list':   return run(['tab-list'], 'tab-list');
    // Accept tabIndex (LLM convention) or index (legacy)
    case 'tab-close': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab-close', String(idx)], `tab-close ${idx}`);
    }
    case 'tab-select': {
      const idx = args.tabIndex ?? args.index ?? 0;
      return run(['tab-select', String(idx)], `tab-select ${idx}`);
    }

    // ── Auth state persistence ────────────────────────────────────────────────
    case 'state-save': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return run(['state-save', p], `state-save ${p}`);
    }
    case 'state-load': {
      const p = filePath || path.join(os.homedir(), '.thinkdrop', 'browser-sessions', `${sessionId}.json`);
      return run(['state-load', p], `state-load ${p}`);
    }

    // ── Resize ────────────────────────────────────────────────────────────────
    case 'resize': {
      return run(['resize', String(width || 1280), String(height || 800)], 'resize');
    }

    // ── newPage (alias tab-new) ───────────────────────────────────────────────
    case 'newPage': {
      return run(['tab-new', url || ''], 'newPage');
    }

    // ── diagnose ──────────────────────────────────────────────────────────────
    // Self-healing action: when a browser.act command fails with a tool error,
    // diagnose() probes playwright-cli --help, identifies the correct usage,
    // writes a context_rule so the same mistake never repeats, and returns a fix.
    // Args: failedAction (string), errorText (string), sessionId
    case 'diagnose': {
      const failedAction = args.failedAction || selector || '';
      const errorText    = args.errorText    || text    || '';

      logger.info(`[browser.act] diagnose: failedAction="${failedAction}" error="${errorText.slice(0, 120)}"`);

      // 1. Probe playwright-cli --help to get ground-truth command list
      const { spawnSync } = require('child_process');
      const helpProc = spawnSync(CLI_BIN, ['--help'], { encoding: 'utf8', timeout: 5000 });
      const helpText = (helpProc.stdout || '') + (helpProc.stderr || '');

      // 2. If specific command failed, probe its --help too
      let cmdHelp = '';
      if (failedAction) {
        const cmdHelpProc = spawnSync(CLI_BIN, ['--help', failedAction], { encoding: 'utf8', timeout: 5000 });
        cmdHelp = (cmdHelpProc.stdout || '') + (cmdHelpProc.stderr || '');
      }

      // 3. Pattern-match known failure signatures → generate fix rule
      const fixes = [];

      // TypeError: result is not a function → eval expects () => expr not IIFE
      if (/TypeError: result is not a function/i.test(errorText)) {
        fixes.push('playwright-cli eval expects a function expression: `() => value` — NOT an IIFE `(() => {...})()`. Pass the function without calling it.');
      }

      // scroll with distance/direction not working → mousewheel
      if (/scroll/i.test(failedAction) && /mousewheel|scroll/i.test(helpText)) {
        const mwLine = helpText.split('\n').find(l => /mousewheel/i.test(l)) || '';
        fixes.push(`scroll maps to playwright-cli mousewheel <dx> <dy>. Usage: ${mwLine.trim()}`);
      }

      // click with text selector rejected → needs snapshot ref
      if (/click/i.test(failedAction) && /ref.*snapshot/i.test(helpText)) {
        fixes.push('playwright-cli click only accepts element refs from snapshot (e.g. e12). Use eval with a function expression to click by text.');
      }

      const fixSummary = fixes.length > 0
        ? fixes.join(' | ')
        : `playwright-cli ${failedAction} usage: ${(cmdHelp || helpText).slice(0, 300)}`;

      // 4. Write permanent context_rule so planner never repeats this mistake
      try {
        const db = require('../skill-helpers/skill-db.cjs');
        const ruleKey = `playwright-cli:${failedAction || 'general'}`;
        await db.setContextRule(ruleKey, fixSummary);
        logger.info(`[browser.act] diagnose: wrote context_rule for "${ruleKey}": ${fixSummary.slice(0, 120)}`);
      } catch (e) {
        logger.warn(`[browser.act] diagnose: failed to write context_rule — ${e.message}`);
      }

      return {
        ok: true,
        action,
        sessionId,
        diagnosis:     fixSummary,
        failedAction,
        errorText,
        helpText:      helpText.slice(0, 800),
        cmdHelp:       cmdHelp.slice(0, 400),
        fixes,
        result:        fixSummary,
        executionTime: Date.now() - start,
      };
    }

    // ── examine ───────────────────────────────────────────────────────────────
    // Scans the current page snapshot against the planned next actions.
    // Uses LLM to diagnose: auth walls, missing elements, wrong page/section,
    // modals blocking content, etc.
    // Returns: { ok, status, issue, recovery, contextRule, needsUser }
    //   status: 'OK' | 'RECOVERABLE' | 'NEEDS_USER' | 'BLOCKED'
    //   RECOVERABLE → auto-writes context_rule, replan can fix it
    //   NEEDS_USER  → surfaces message to user, halts plan
    case 'examine': {
      const intent = args.intent || text || '';  // what the plan is trying to do
      const nextActions = args.nextActions || []; // upcoming plan steps

      // 1. Capture fresh snapshot + current URL
      // Retry once if cache is empty — Chrome restore dialog may have blocked the first attempt.
      // captureSnapshot sends blind Escapes first, so the retry should land on a clean page.
      await captureSnapshot(sessionId, headed, timeoutMs);
      let snap = snapshotCache.get(sessionId) || '';
      if (!snap) {
        logger.info(`[browser.act] examine: snapshot empty — retrying after 600ms (dialog may have blocked first attempt)`);
        await new Promise(r => setTimeout(r, 600));
        await captureSnapshot(sessionId, headed, timeoutMs);
        snap = snapshotCache.get(sessionId) || '';
      }

      // playwright-cli eval returns markdown-wrapped output: "### Result\n\"value\"\n### Ran..."
      // Strip everything except the quoted value on the second line
      function extractEvalValue(raw) {
        const stripped = (raw || '').replace(/###[^\n]*\n?/g, '').replace(/```[^`]*```/g, '').trim();
        // Remove surrounding quotes if present
        return stripped.replace(/^["']|["']$/g, '').trim();
      }

      const urlRes = await cliRun([...S, 'eval', 'location.href'], 3000);
      const pageUrl = extractEvalValue(urlRes.stdout) || 'unknown';
      const titleRes = await cliRun([...S, 'eval', 'document.title'], 3000);
      const pageTitle = extractEvalValue(titleRes.stdout) || '';

      if (!snap) {
        return { ok: false, action, sessionId, error: 'No snapshot available for examination', executionTime: Date.now() - start };
      }

      // 2. Parse snapshot into candidates (structured ARIA data)
      const candidates = parseSnapshotCandidates(snap);
      const snapPreview = snap.split('\n').slice(0, 3).join(' | ');
      logger.info(`[browser.act] examine: ${candidates.length} candidates parsed (snap ${snap.length} chars). Preview: ${snapPreview.slice(0, 200)}`);
      if (candidates.length > 0) {
        logger.info(`[browser.act] examine: first 10 candidates: ${candidates.slice(0, 10).map(c => `${c.role}:"${c.label}"`).join(', ')}`);
      }

      // 3. Fast-path heuristic checks before calling LLM
      const AUTH_LABELS = /^(log in|sign in|sign in to|sign up|sign up for free|create account|get started|login|signin|join free|join now)$/i;
      const authEl = candidates.find(c =>
        (c.role === 'link' || c.role === 'button') &&
        AUTH_LABELS.test(c.label.trim()) &&
        c.depth <= 24
      );

      // Build element summary for LLM — keep all roles (sidebar links are often 'link' or 'generic')
      // Include up to 120 candidates so the project list is visible to the LLM
      const elementSummary = candidates
        .filter(c => c.label.length > 0)
        .slice(0, 120)
        .map(c => `[${c.role}] "${c.label}"${c.attrs ? ' ' + c.attrs.slice(0, 60) : ''}`)
        .join('\n');

      // 3b. Fast-path OK check — if intent keywords directly match a candidate, skip LLM entirely
      // This prevents false NEEDS_USER when the element IS visible but LLM misreads summary
      if (intent && candidates.length > 0) {
        const intentTokens = intent.toLowerCase().split(/\W+/).filter(t => t.length >= 3);
        const directMatch = candidates.find(c => {
          const lbl = c.label.toLowerCase();
          return intentTokens.some(t => lbl.includes(t));
        });
        if (directMatch) {
          logger.info(`[browser.act] examine: fast-path OK — intent token matched candidate ${directMatch.role}:"${directMatch.label}"`);
          return {
            ok: true, action, sessionId,
            status: 'OK',
            issue: null, recovery: null, userMessage: null, contextRule: null,
            missingElements: [], availableAlternatives: [],
            authRequired: false, needsUser: false,
            result: 'Page ready',
            executionTime: Date.now() - start,
          };
        }
      }

      // 4. LLM diagnosis
      let diagnosis = null;
      try {
        const { ask } = require('../skill-helpers/skill-llm.cjs');
        const prompt = `You are a browser automation assistant examining a web page to determine if the planned actions can be completed.

PAGE URL: ${pageUrl}
PAGE TITLE: ${pageTitle}

PLANNED INTENT: ${intent}
NEXT ACTIONS: ${JSON.stringify(nextActions, null, 2)}

CURRENT PAGE ELEMENTS (accessibility tree):
${elementSummary}

Analyze whether the page is in the right state to complete the planned actions.

Diagnose ONE of these statuses:
- OK: Page is ready, all needed elements are present
- RECOVERABLE: Page has an issue but automation can fix it (wrong sub-page, needs scroll, modal to dismiss, wrong tab)
- NEEDS_USER: Human must act first (not logged in, paywall, captcha, missing API key setup, requested item doesn't exist on page)
- BLOCKED: Page is broken, 404, redirect loop, or completely wrong site

Respond ONLY with valid JSON:
{
  "status": "OK|RECOVERABLE|NEEDS_USER|BLOCKED",
  "issue": "one sentence describing what is wrong, or null if OK",
  "recovery": "one sentence describing what automation can do to fix it, or null if not RECOVERABLE",
  "userMessage": "clear message to show the user explaining what they need to do, or null if not NEEDS_USER",
  "contextRule": "short rule to store for future plans on this domain, or null if OK",
  "missingElements": ["list of element labels the plan needs but are not on page"],
  "availableAlternatives": ["similar items found that might be what user meant"]
}`;

        const raw = await ask(prompt, { maxTokens: 400, temperature: 0 });
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) diagnosis = JSON.parse(jsonMatch[0]);
      } catch (e) {
        logger.warn(`[browser.act] examine: LLM call failed — ${e.message}`);
      }

      // 5. Fall back to heuristic if LLM unavailable
      if (!diagnosis) {
        if (authEl) {
          diagnosis = {
            status: 'NEEDS_USER',
            issue: `Not logged in — "${authEl.label}" button is visible`,
            recovery: null,
            userMessage: `You need to log in to ${pageUrl} before I can complete this task. Please log in and try again.`,
            contextRule: `User must be logged in. "${authEl.label}" button visible = not authenticated.`,
            missingElements: [],
            availableAlternatives: [],
          };
        } else {
          diagnosis = { status: 'OK', issue: null, recovery: null, userMessage: null, contextRule: null, missingElements: [], availableAlternatives: [] };
        }
      }

      // 6. For RECOVERABLE: auto-write context_rule so replan has the info
      if ((diagnosis.status === 'RECOVERABLE' || diagnosis.status === 'NEEDS_USER') && diagnosis.contextRule) {
        try {
          const db = require('../skill-helpers/skill-db.cjs');
          const domain = pageUrl.replace(/^https?:\/\//, '').split('/')[0];
          await db.setContextRule(domain, diagnosis.contextRule);
          logger.info(`[browser.act] examine: wrote context_rule for "${domain}": ${diagnosis.contextRule}`);
        } catch (e) {
          logger.warn(`[browser.act] examine: failed to write context_rule — ${e.message}`);
        }
      }

      logger.info(`[browser.act] examine: status=${diagnosis.status} issue="${diagnosis.issue || 'none'}" url=${pageUrl}`);

      return {
        ok: diagnosis.status === 'OK',
        action,
        sessionId,
        status:               diagnosis.status,
        issue:                diagnosis.issue || null,
        recovery:             diagnosis.recovery || null,
        userMessage:          diagnosis.userMessage || null,
        contextRule:          diagnosis.contextRule || null,
        missingElements:      diagnosis.missingElements || [],
        availableAlternatives: diagnosis.availableAlternatives || [],
        authRequired:         diagnosis.status === 'NEEDS_USER' && !!authEl,
        needsUser:            diagnosis.status === 'NEEDS_USER',
        result:               diagnosis.issue || (diagnosis.status === 'OK' ? 'Page ready' : diagnosis.status),
        executionTime:        Date.now() - start,
        error:                diagnosis.status !== 'OK' ? diagnosis.issue : undefined,
      };
    }

    // ── Chrome Crash Detection ─────────────────────────────────────────────────
    case 'detectCrash': {
      return await handleDetectCrash(sessionId, args.step || {}, args.error || 'Chrome crash detected');
    }

    
    // ── Fallback ─────────────────────────────────────────────────────────────
    default: {
      logger.warn(`[browser.act] Unknown action "${action}" — attempting direct passthrough`);
      return run([action, ...(url ? [url] : []), ...(selector ? [selector] : [])], action);
    }
  }
}

// ---------------------------------------------------------------------------
// Parse playwright-cli snapshot output into elements array for pre-scan
// Snapshot format (YAML-like):
//   - [e1] link "Wikipedia" [href=...]
//   - [e4] textbox "Search Wikipedia" [focused]
// ---------------------------------------------------------------------------
function parseSnapshotToElements(snapshotText) {
  if (!snapshotText) return [];
  const elements = [];
  const lines = snapshotText.split('\n');
  for (const line of lines) {
    const m = line.match(/\[?(e\d+)\]?\s+(\w+)\s+"([^"]+)"/i);
    if (m) {
      const [, ref, tag, label] = m;
      const hrefM = line.match(/\[href=([^\]]+)\]/);
      elements.push({
        ref,
        tag:   tag.toLowerCase(),
        label,
        href:  hrefM ? hrefM[1] : undefined,
      });
    }
  }
  return elements;
}
