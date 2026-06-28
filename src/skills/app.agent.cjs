'use strict';

/**
 * skill: app.agent
 *
 * Factory skill for desktop application automation using LiteParse for UI element
 * recognition, NutJS for keyboard/mouse control, and GhostLayer for visual feedback.
 *
 * Actions:
 *   actionParseScreenshot     { screenshotPath? }              → runs LiteParse CLI, returns structured text with bounding boxes
 *   actionFindElements      { searchText, textItems }          → finds text elements matching search
 *   actionHighlightElements { elements, duration? }            → shows bounding boxes via GhostLayer
 *   actionAnalyzeViewport   { goal }                           → determines what's visible vs off-screen
 *   actionDecideScroll      { viewportAnalysis, goal }         → decides if/how to scroll for full content
 *   actionMonitorWithBackoff{ goalDescription, mode }          → smart monitoring with adaptive polling
 *   actionTeleportToElement { appName, searchText }            → uses Find/Search to navigate to element
 *   actionDiscoverShortcuts { appName }                        → discovers shortcuts via web.agent
 *   actionExecuteShortcut   { appName, action }              → executes keyboard shortcut with verification
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('../logger.cjs');

// In-process boundary cache — keyed by "appName::WxH", TTL 5 minutes
// Replaces the broken skill-db KV store for boundary_layout
const _boundaryCache = new Map();
const _BOUNDARY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Agent descriptor directory
const AGENTS_DIR = path.join(os.homedir(), '.thinkdrop', 'agents');

// Quadrant-based coordinate adjustment settings
// Fine-tune these to fix vertical/horizontal offset issues in different screen sections
const QUADRANT_OFFSETS = {
  upperLeft:  { x: -5, y: 0 },   // Top half - no adjustment needed
  upperRight: { x: 10, y: 0 },   // Top half - no adjustment needed
  lowerLeft:  { x: -5, y: 15 },  // Bottom half - push down 15px
  lowerRight: { x: 10, y: 15 }   // Bottom half - push down 15px
};

// Screen center coordinates (updated dynamically from screenshot)
let screenCenterX = 720;  // Default: half of 1440px
let screenCenterY = 450;  // Default: half of 900px

/**
 * Get quadrant-based coordinate adjustment for an element
 * @param {number} x - Element x position
 * @param {number} y - Element y position
 * @returns {Object} - { x: offsetX, y: offsetY }
 */
function getQuadrantOffset(x, y) {
  const isUpper = y < screenCenterY;
  const isLeft = x < screenCenterX;

  if (isUpper && isLeft) return QUADRANT_OFFSETS.upperLeft;
  if (isUpper && !isLeft) return QUADRANT_OFFSETS.upperRight;
  if (!isUpper && isLeft) return QUADRANT_OFFSETS.lowerLeft;
  return QUADRANT_OFFSETS.lowerRight;
}

// Overlay communication settings
const OVERLAY_HOST = process.env.OVERLAY_HOST || '127.0.0.1';
const OVERLAY_PORT = process.env.OVERLAY_PORT || '3010';

/**
 * Send IPC message to overlay window via HTTP
 * @param {Object} data - IPC message data with type property
 */
async function sendOverlayIpc(data) {
  try {
    logger.info(`[sendOverlayIpc] Sending ${data.type} to overlay at ${OVERLAY_HOST}:${OVERLAY_PORT}`);
    
    const response = await fetch(
      `http://${OVERLAY_HOST}:${OVERLAY_PORT}/overlay/highlight`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      }
    );
    
    if (!response.ok) {
      logger.error(`[sendOverlayIpc] HTTP ${response.status} - ${response.statusText}`);
    } else {
      logger.info(`[sendOverlayIpc] Success: ${data.type}`);
    }
    
    return response.ok;
  } catch (error) {
    logger.error(`[sendOverlayIpc] Network error: ${error.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 1: LiteParse Integration
// ---------------------------------------------------------------------------

/**
 * Run LiteParse CLI on a screenshot to get structured text with bounding boxes
 * @param {Object} args - screenshot path
 * @returns {Promise<{ok: boolean, textItems: Array, error?: string}>}
 */
/**
 * Parse Docling JSON output to LiteParse format
 * @param {string} doclingJsonPath - Path to Docling JSON output
 * @returns {Array} - Array of text items in LiteParse format
 */
function parseDoclingOutput(doclingJsonPath) {
  const rawOutput = fs.readFileSync(doclingJsonPath, 'utf8');
  const doclingResult = JSON.parse(rawOutput);
  
  if (!doclingResult.texts || !Array.isArray(doclingResult.texts)) {
    return [];
  }
  
  return doclingResult.texts
    .filter(item => item.text && item.prov && item.prov[0] && item.prov[0].bbox)
    .map(item => {
      const bbox = item.prov[0].bbox;
      return {
        text: item.text,
        x: bbox.l,
        y: bbox.t,
        width: bbox.r - bbox.l,
        height: bbox.b - bbox.t,
        confidence: 1.0
      };
    });
}

/**
 * Parse screenshot using Docling CLI
 * @param {Object} args
 * @returns {Promise<{ok: boolean, textItems: Array, count: number}>}
 */
async function actionParseScreenshotDocling(args = {}) {
  try {
    const { screenshotPath } = args;
    let targetScreenshot = screenshotPath;
    if (!targetScreenshot) {
      const captureResult = await actionCaptureScreen();
      if (!captureResult.ok) {
        return { ok: false, error: captureResult.error };
      }
      targetScreenshot = captureResult.path;
    }
    
    if (!fs.existsSync(targetScreenshot)) {
      return { ok: false, error: `Screenshot not found: ${targetScreenshot}` };
    }
    
    const outputDir = os.tmpdir();
    const baseName = path.basename(targetScreenshot, path.extname(targetScreenshot));
    const expectedOutput = path.join(outputDir, `${baseName}.json`);
    
    logger.info(`[app.agent] Running Docling CLI on ${targetScreenshot}`);
    
    // Docling CLI - remove PDF backend for image files
    const isImage = targetScreenshot.match(/\.(png|jpg|jpeg)$/i);
    
    const args = [
      targetScreenshot,
      '--to', 'json',
      '--no-ocr',
      '--no-enrich-code',
      '--no-enrich-formula'
    ];
    
    // Only add PDF backend for PDF files, not images
    if (!isImage) {
      args.push('--pdf-backend', 'pypdfium2');
    }
    
    const doclingProcess = spawn('docling', args, {
      timeout: 60000,
      cwd: outputDir,
      shell: true,  // Fix PATH/env issues
      env: {
        ...process.env,
        TORCH_DEVICE: 'mps'  // Apple Silicon GPU acceleration
      }
    });
    
    let stdout = '';
    let stderr = '';
    
    doclingProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    doclingProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    return new Promise((resolve) => {
      doclingProcess.on('close', (code) => {
        logger.info(`[app.agent] Docling exit code: ${code}`);
        logger.info(`[app.agent] Docling stdout: ${stdout || '(empty)'}`);
        if (stderr) {
          logger.info(`[app.agent] Docling stderr: ${stderr}`);
        }
        
        const fileExists = fs.existsSync(expectedOutput);
        logger.info(`[app.agent] Output file exists: ${fileExists}, path: ${expectedOutput}`);
        
        if (code !== 0 || !fileExists) {
          logger.error(`[app.agent] Docling failed - exit code: ${code}, file exists: ${fileExists}`);
          resolve({ ok: false, error: `Docling failed (code: ${code}): ${stderr || stdout || 'No output'}` });
          return;
        }
        
        try {
          const textItems = parseDoclingOutput(expectedOutput);
          
          // Clean up temp file
          try {
            fs.unlinkSync(expectedOutput);
          } catch (e) {
            // Ignore cleanup errors
          }
          
          logger.info(`[app.agent] Docling found ${textItems.length} text elements`);
          
          resolve({
            ok: true,
            textItems,
            count: textItems.length,
            screenshotPath: targetScreenshot
          });
        } catch (parseErr) {
          resolve({ ok: false, error: `Failed to parse Docling output: ${parseErr.message}` });
        }
      });
      
      doclingProcess.on('error', (err) => {
        logger.error(`[app.agent] Docling spawn error: ${err.message}`);
        resolve({ ok: false, error: `Failed to run Docling: ${err.message}` });
      });
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function actionParseScreenshot(args = {}) {
  // Let's deactivate Docling for now having issues
  // Try Docling first
  // const doclingResult = await actionParseScreenshotDocling(args);
  // if (doclingResult.ok) {
  //   return doclingResult;
  // }
  
  // Fallback to LiteParse
  // logger.warn('[app.agent] Docling failed, falling back to LiteParse:', doclingResult.error);
  
  const { screenshotPath } = args;
  
  // If no screenshot provided, capture one using existing screen capture
  let targetScreenshot = screenshotPath;
  if (!targetScreenshot) {
    logger.info('[app.agent] No screenshot provided, capturing screen...');
    const captureResult = await actionCaptureScreen();
    if (!captureResult.ok) {
      return { ok: false, error: captureResult.error };
    }
    targetScreenshot = captureResult.path;
  }
  
  // Check if file exists
  if (!fs.existsSync(targetScreenshot)) {
    return { ok: false, error: `Screenshot not found: ${targetScreenshot}` };
  }
  
  return new Promise((resolve) => {
    const outputFile = path.join(os.tmpdir(), `liteparse-${Date.now()}.json`);
    
    logger.info(`[app.agent] Running LiteParse on ${targetScreenshot}`);
    
    // Spawn LiteParse CLI process
    const litProcess = spawn('lit', [
      'parse',
      targetScreenshot,
      '--format', 'json',
      '-o', outputFile
    ], {
      timeout: 30000  // 30 second timeout
    });
    
    let stderr = '';
    litProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    litProcess.on('error', (error) => {
      logger.error(`[app.agent] LiteParse spawn error: ${error.message}`);
      resolve({ 
        ok: false, 
        error: `LiteParse CLI not available. Install with: npm i -g @llamaindex/liteparse` 
      });
    });
    
    litProcess.on('close', (code) => {
      if (code !== 0) {
        logger.error(`[app.agent] LiteParse exited with code ${code}: ${stderr}`);
        resolve({ 
          ok: false, 
          error: `LiteParse failed (exit ${code}): ${stderr || 'Unknown error'}` 
        });
        return;
      }
      
      // Read and parse output
      try {
        if (!fs.existsSync(outputFile)) {
          resolve({ ok: false, error: 'LiteParse output file not created' });
          return;
        }
        
        const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        
        // Extract text items from LiteParse format
        const textItems = extractTextItems(output);
        
        // Clean up temp file
        try {
          fs.unlinkSync(outputFile);
        } catch (e) {
          // Ignore cleanup errors
        }
        
        logger.info(`[app.agent] LiteParse found ${textItems.length} text elements`);
        
        resolve({
          ok: true,
          textItems,
          raw: output,
          summary: {
            elementCount: textItems.length,
            sampleText: textItems.slice(0, 3).map(t => t.text).join(', ')
          }
        });
      } catch (error) {
        logger.error(`[app.agent] Failed to parse LiteParse output: ${error.message}`);
        resolve({ ok: false, error: `Failed to parse LiteParse output: ${error.message}` });
      }
    });
  });
}

/**
 * Extract text items from LiteParse JSON output
 * @param {Object} liteparseOutput - Raw LiteParse JSON
 * @returns {Array} - Normalized text items with bounding boxes
 */
function extractTextItems(liteparseOutput) {
  const items = [];
  
  // LiteParse returns { pages: [{ textItems: [...] }] }
  if (liteparseOutput.pages && Array.isArray(liteparseOutput.pages)) {
    liteparseOutput.pages.forEach(page => {
      if (page.textItems && Array.isArray(page.textItems)) {
        page.textItems.forEach(item => {
          items.push({
            text: item.text || '',
            x: item.x || 0,
            y: item.y || 0,
            width: item.width || 0,
            height: item.height || 0,
            fontName: item.fontName || 'unknown',
            fontSize: item.fontSize || 0,
            confidence: item.confidence || 0,
            page: page.page || 1
          });
        });
      }
    });
  }
  
  // Also extract full page text
  const fullText = liteparseOutput.pages?.[0]?.text || 
                   items.map(i => i.text).join(' ');
  
  return items;
}

/**
 * Capture screen using existing screen capture capability
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
async function actionCaptureScreen() {
  try {
    // Use existing screen.capture skill
    const { screenCapture } = require('./screen.capture.cjs');
    const result = await screenCapture({});
    
    if (result.success && result.text) {
      // For now, we don't get a path back from screenCapture - it returns OCR text
      // We need to call the screenshot-desktop directly for image path
      const screenshot = require('screenshot-desktop');
      const path = require('path');
      const os = require('os');
      const fs = require('fs');
      
      const tmpPath = path.join(os.tmpdir(), `app-agent-${Date.now()}.png`);
      await screenshot({ filename: tmpPath });
      
      return { ok: true, path: tmpPath };
    }
    
    return { ok: false, error: result.error || 'Screen capture failed' };
  } catch (error) {
    logger.error(`[app.agent] Screen capture error: ${error.message}`);
    return { ok: false, error: `Screen capture unavailable: ${error.message}` };
  }
}

/**
 * Get bounds of the current foreground app window using get-windows.
 * Must be called BEFORE hiding our own overlay, because the overlay may steal focus.
 *
 * Uses get-windows (the maintained successor to the deprecated active-win, same
 * library used by screen-intelligence-service and thinkdrop-user-memory-service).
 */
async function _getActiveAppBounds() {
  const startTime = Date.now();
  try {
    logger.debug(`[app.agent] _getActiveAppBounds: starting get-windows check`);
    
    const { activeWindow } = await import('get-windows');
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('get-windows timeout after 3000ms')), 3000);
    });
    
    const win = await Promise.race([
      activeWindow(),
      timeoutPromise
    ]);
    
    const elapsed = Date.now() - startTime;
    
    if (win?.bounds && (win.bounds.width > 0 || win.bounds.height > 0)) {
      const result = { ...win.bounds, appName: win.owner?.name || 'unknown', source: 'get-windows' };
      logger.debug(`[app.agent] _getActiveAppBounds: success - appName: "${result.appName}", bounds: ${JSON.stringify({ x: result.x, y: result.y, width: result.width, height: result.height })}, source: get-windows, elapsed: ${elapsed}ms`);
      return result;
    } else {
      logger.warn(`[app.agent] _getActiveAppBounds: no usable bounds returned - win: ${JSON.stringify(win)}, elapsed: ${elapsed}ms`);
      // Fall through to AppleScript / boundary-scan via the catch's darwin path
      const appName = win?.owner?.name || null;
      if (process.platform === 'darwin') {
        return await _macFallbackBounds(appName);
      }
      return null;
    }
  } catch (err) {
    const elapsed = Date.now() - startTime;
    logger.error(`[app.agent] _getActiveAppBounds failed after ${elapsed}ms: ${err.message}`);
    
    // Try alternative methods on macOS if active-win fails
    if (process.platform === 'darwin') {
      return await _macFallbackBounds(null);
    }
    
    return null;
  }
}

/**
 * macOS bounds fallback chain, used when active-win is unavailable or returns
 * zero-size bounds. Order:
 *   1. AppleScript (System Events) — fast, works for apps that expose window bounds.
 *   2. Boundary-scan — derive {x,y,width,height} from the OCR region scan when
 *      AppleScript returns 0,0,0,0 (e.g. borderless/Electron apps like Devin).
 *
 * @param {string|null} knownAppName - app name already detected by active-win, if any.
 * @returns {Promise<Object|null>} bounds with appName + source, or null.
 */
async function _macFallbackBounds(knownAppName) {
  // 1. AppleScript bounds
  let appName = knownAppName || null;
  try {
    logger.debug(`[app.agent] _macFallbackBounds: trying macOS AppleScript`);
    const { execSync } = require('child_process');
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        try
          set windowBounds to bounds of front window of frontApp
          return appName & "," & item 1 of windowBounds & "," & item 2 of windowBounds & "," & item 3 of windowBounds & "," & item 4 of windowBounds
        on error
          return appName & ",0,0,0,0"
        end try
      end tell
    `;

    const result = execSync(`osascript -e '${script.replace(/'/g, "\\'")}'`, {
      encoding: 'utf8',
      timeout: 2000
    }).trim();

    const [asAppName, x, y, width, height] = result.split(',').map(s => s.trim());
    appName = asAppName || appName;
    const w = parseInt(width) || 0;
    const h = parseInt(height) || 0;

    if (w > 0 && h > 0) {
      logger.info(`[app.agent] _macFallbackBounds: AppleScript succeeded - appName: "${appName}", bounds: ${x},${y},${w},${h}, source: applescript`);
      return {
        x: parseInt(x) || 0,
        y: parseInt(y) || 0,
        width: w,
        height: h,
        appName: appName || 'unknown',
        source: 'applescript'
      };
    }
    logger.info(`[app.agent] _macFallbackBounds: AppleScript returned no usable bounds for "${appName}" — trying boundary scan`);
  } catch (appleScriptErr) {
    logger.debug(`[app.agent] _macFallbackBounds: AppleScript failed: ${appleScriptErr.message}`);
  }

  // 2. Boundary-scan derived bounds (no native deps)
  try {
    const derived = await _deriveBoundsFromScan(appName);
    if (derived) return derived;
  } catch (scanErr) {
    logger.debug(`[app.agent] _macFallbackBounds: boundary scan failed: ${scanErr.message}`);
  }

  return null;
}

/**
 * Derive approximate window bounds from the on-screen OCR region scan when
 * neither active-win nor AppleScript can supply them. Reuses the existing
 * screenshot → mergeCloseBoxes → _scoreBoundariesForMain pipeline and returns
 * the union bounding box of the top-scored main region(s).
 *
 * Results are cached via _storeBoundaryCache (5-min TTL) and looked up via
 * _findBoundaryCacheEntry to avoid re-scanning on every call.
 *
 * @param {string|null} appName
 * @returns {Promise<Object|null>} { x, y, width, height, appName, source: 'boundary-scan'|'cache' }
 */
async function _deriveBoundsFromScan(appName) {
  // Reuse a recent cached scan for this app if available.
  if (appName) {
    const cached = _findBoundaryCacheEntry(appName);
    if (cached?.appBounds && cached.appBounds.width > 0 && cached.appBounds.height > 0) {
      logger.info(`[app.agent] _deriveBoundsFromScan: using cached bounds for "${appName}": ${JSON.stringify(cached.appBounds)}, source: cache`);
      return { ...cached.appBounds, appName, source: 'cache' };
    }
  }

  const category = appName ? (KNOWN_APPS[appName] || 'other') : 'other';

  let parseResult, screenDims;
  await _withCaptureWindow(async () => {
    const captureResult = await actionCaptureScreen();
    screenDims = captureResult.ok ? _getScreenDimsFromScreenshot(captureResult.path) : { width: 1440, height: 900 };
    parseResult = await actionParseScreenshot({ screenshotPath: captureResult.ok ? captureResult.path : undefined });
  });

  if (!parseResult?.ok || !Array.isArray(parseResult.textItems) || parseResult.textItems.length === 0) {
    logger.debug(`[app.agent] _deriveBoundsFromScan: no text items to derive bounds from`);
    return null;
  }

  const boundaries = mergeCloseBoxes(parseResult.textItems, { thresholdX: 50, thresholdY: 25, minItems: 3 });
  if (!boundaries.length) return null;

  // Score regions and keep the main, non-floating ones. Fall back to the
  // largest region if scoring yields nothing.
  const scored = _scoreBoundariesForMain(boundaries, category, screenDims.width, screenDims.height, null)
    .filter(b => b.isMain && !b.isFloating);
  const regions = scored.length
    ? scored.sort((a, z) => z.score - a.score).slice(0, 3)
    : [[...boundaries].sort((a, z) => (z.width * z.height) - (a.width * a.height))[0]];

  // Union bounding box of the selected region(s).
  let minX = Infinity, minY = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
  for (const r of regions) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxRight = Math.max(maxRight, r.x + r.width);
    maxBottom = Math.max(maxBottom, r.y + r.height);
  }

  const bounds = {
    x: Math.max(0, Math.round(minX)),
    y: Math.max(0, Math.round(minY)),
    width: Math.round(maxRight - minX),
    height: Math.round(maxBottom - minY)
  };

  if (!(bounds.width > 0 && bounds.height > 0)) return null;

  // Cache the full scan + derived bounds for reuse within the TTL.
  try {
    _storeBoundaryCache(appName || 'unknown', boundaries, category, screenDims, bounds);
  } catch (_) { /* non-fatal */ }

  logger.info(`[app.agent] _deriveBoundsFromScan: derived bounds for "${appName || 'unknown'}": ${JSON.stringify(bounds)}, source: boundary-scan`);
  return { ...bounds, appName: appName || 'unknown', source: 'boundary-scan' };
}

/**
 * Hide our own overlay window before taking a screenshot, restore it after.
 */
async function _withOverlayHidden(fn) {
  const http = require('http');
  const port = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
  const _post = (path) => new Promise(resolve => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST' });
    req.on('error', () => resolve());
    req.on('response', () => resolve());
    req.end();
    setTimeout(resolve, 600);
  });
  await _post('/overlay/hide');
  await _sleep(250);
  try {
    return await fn();
  } finally {
    await _post('/overlay/show');
  }
}

/**
 * Graceful capture handshake: instead of a hard overlay hide/show, ask the main
 * process to fade the ThinkDrop progress "drop" out (and hide the panel), wait
 * until it confirms the screen is clear, run the screenshot `fn`, then fade the
 * drop back in. Falls back to the hard _withOverlayHidden if the overlay control
 * server is unreachable, so captures are never left exposed to overlay taint.
 */
async function _withCaptureWindow(fn) {
  const http = require('http');
  const port = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
  const _post = (path, timeoutMs) => new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST' }, () => finish(true));
    req.on('error', () => finish(false));
    req.end();
    setTimeout(() => finish(false), timeoutMs);
  });

  // capture-begin resolves once the drop has faded out (renderer handshake) or
  // after the main process's ~700ms fallback; allow headroom before giving up.
  const beganOk = await _post('/overlay/capture-begin', 1500);
  if (!beganOk) {
    logger.warn('[app.agent] _withCaptureWindow: capture-begin unreachable — falling back to hard overlay hide');
    return _withOverlayHidden(fn);
  }

  try {
    return await fn();
  } finally {
    await _post('/overlay/capture-end', 800);
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Element Finding & Highlighting
// ---------------------------------------------------------------------------

/**
 * Find text elements matching a search query
 * @param {Object} args - searchText, textItems (from LiteParse)
 * @returns {Promise<{ok: boolean, matches: Array}>}
 */
async function actionFindElements(args = {}) {
  const { searchText, textItems = [], fuzzy = true, highlight = true, highlightColor = '#ff0000' } = args;
  
  if (!searchText) {
    return { ok: false, error: 'searchText is required' };
  }
  
  const searchLower = searchText.toLowerCase();
  
  // Check if this is a compound term (contains dots, arrows, etc.)
  // These often get split by LiteParse into separate items
  const compoundSeparators = /[.\->_:]/;
  const isCompoundTerm = compoundSeparators.test(searchText) && !searchText.includes(' ');
  
  if (isCompoundTerm) {
    logger.info(`[actionFindElements] Compound term detected: "${searchText}"`);
    
    // First, try substring matching (LiteParse may return full term as single item)
    const substringMatches = [];
    textItems.forEach(item => {
      const itemText = item.text.toLowerCase();
      if (itemText.includes(searchLower)) {
        substringMatches.push({ ...item, matchType: 'compound-substring', matchScore: 1.0 });
      }
    });
    
    if (substringMatches.length > 0) {
      logger.info(`[actionFindElements] Found ${substringMatches.length} substring matches for compound term`);
      if (highlight) {
        await actionHighlightElements({ elements: substringMatches, duration: 0, color: highlightColor });
      }
      return {
        ok: true,
        matches: substringMatches,
        count: substringMatches.length,
        searchText
      };
    }
    
    // Fall back to multi-part matching if no single-item matches found
    const parts = searchLower.split(/[.\->_:]+/).filter(p => p.length > 0);
    if (parts.length > 1) {
      logger.info(`[actionFindElements] Trying multi-part matching: ${parts.join(', ')}`);
      const compoundResult = findCompoundMatches(textItems, parts, searchText);
      if (compoundResult.ok && compoundResult.matches.length > 0 && highlight) {
        await actionHighlightElements({ elements: compoundResult.matches, duration: 0, color: highlightColor });
      }
      return compoundResult;
    }
  }
  
  const searchWords = searchLower.split(/\s+/).filter(w => w.length > 0);
  const matches = [];
  
  // Single word search - use existing logic
  if (searchWords.length === 1) {
    textItems.forEach(item => {
      const itemText = item.text.toLowerCase();
      
      // Exact match
      if (itemText === searchLower) {
        matches.push({ ...item, matchType: 'exact', matchScore: 1.0 });
      }
      // Contains match
      else if (itemText.includes(searchLower)) {
        matches.push({ ...item, matchType: 'contains', matchScore: 0.8 });
      }
      // Fuzzy match (word boundaries)
      else if (fuzzy && fuzzyMatch(searchLower, itemText)) {
        matches.push({ ...item, matchType: 'fuzzy', matchScore: 0.6 });
      }
    });
  } else {
    // Multi-word search: first check if entire phrase appears in a single item
    const fullPhrase = searchLower;

    // DEBUG: Log what we're searching for
    logger.info(`[actionFindElements] Multi-word search: "${searchText}" -> words: [${searchWords.join(', ')}] pageTextLen=${args.pageText ? args.pageText.length : 'MISSING'}`);

    // DEBUG: Log sample of text items to see what LiteParse returns
    const sampleItems = textItems.slice(0, 100).map(i => `"${i.text}"`).join(', ');
    logger.info(`[actionFindElements] First 100 text items: ${sampleItems}`);

    // DEBUG: Also search for items containing "star" to debug
    const starItems = textItems.filter(i => i.text.toLowerCase().includes('star')).map(i => `"${i.text}"`).join(', ');
    logger.info(`[actionFindElements] Items containing 'star': ${starItems || 'NONE FOUND'}`);

    // DEBUG: Log all standalone "1" and "5" items with coordinates
    const numItems = textItems.filter(i => i.text.trim() === searchWords[0]).map(i => `"${i.text}"@(${Math.round(i.x)},${Math.round(i.y)})`).join(', ');
    logger.info(`[actionFindElements] Items matching first word "${searchWords[0]}": ${numItems || 'NONE'}`);

    // Compact phrase: words joined with no space — handles OCR-merged tokens like "1star", "3star"
    const compactPhrase = searchWords.join('');

    textItems.forEach(item => {
      const itemText = item.text.toLowerCase();

      // Check if entire phrase appears in this single item (spaced or compact)
      if (itemText === fullPhrase || itemText.includes(fullPhrase)) {
        logger.info(`[actionFindElements] Single-item phrase match: "${item.text}"`);
        matches.push({ ...item, matchType: 'exact-phrase', matchScore: 1.0 });
      } else if (compactPhrase !== fullPhrase && (itemText === compactPhrase || itemText.includes(compactPhrase))) {
        logger.info(`[actionFindElements] Compact-phrase match: "${item.text}" (compact="${compactPhrase}")`);
        matches.push({ ...item, matchType: 'exact-phrase', matchScore: 1.0 });
      }
    });

    // Also try combining items via spatial proximity
    for (let i = 0; i < textItems.length; i++) {
      const combined = tryCombineItems(textItems, i, searchWords);
      if (combined) {
        logger.info(`[actionFindElements] Combined match: "${combined.text}"`);
        matches.push({
          x: combined.x,
          y: combined.y,
          width: combined.width,
          height: combined.height,
          text: combined.text,
          matchType: 'phrase',
          matchScore: 0.9
        });
        i += combined._consumed - 1;
      }
    }

    // Page-text fallback: if no matches yet, check full-page OCR text string.
    // LiteParse's pages[0].text often contains "5 star" even when textItems are fragmented.
    if (matches.length === 0 && args.pageText) {
      const pageTextLower = args.pageText.toLowerCase();
      // Check both spaced ("5 star") and compact ("5star") forms in page text
      const pageHasPhrase = pageTextLower.includes(fullPhrase) ||
                            (compactPhrase !== fullPhrase && pageTextLower.includes(compactPhrase));
      if (pageHasPhrase) {
        const matchedForm = pageTextLower.includes(fullPhrase) ? fullPhrase : compactPhrase;
        logger.info(`[actionFindElements] Page-text fallback: found "${matchedForm}" in full page text`);
        // Build a union bounding box from all individual word matches found in textItems
        const wordBoxes = searchWords.map(word => {
          return textItems.find(item => {
            const t = item.text.toLowerCase().trim();
            return t === word || new RegExp(`\\b${word}\\b`, 'i').test(t);
          });
        }).filter(Boolean);
        if (wordBoxes.length === searchWords.length) {
          const minX = Math.min(...wordBoxes.map(i => i.x));
          const minY = Math.min(...wordBoxes.map(i => i.y));
          const maxRight = Math.max(...wordBoxes.map(i => i.x + i.width));
          const maxBottom = Math.max(...wordBoxes.map(i => i.y + i.height));
          logger.info(`[actionFindElements] Page-text fallback bbox: (${Math.round(minX)},${Math.round(minY)}) ${Math.round(maxRight-minX)}x${Math.round(maxBottom-minY)}`);
          matches.push({
            x: minX, y: minY,
            width: maxRight - minX,
            height: maxBottom - minY,
            text: fullPhrase,
            matchType: 'page-text-fallback',
            matchScore: 0.7
          });
        }
      }
    }

    // Digit-star special case: "N star" (e.g. "1 star", "5 star") where "N" is absent as a standalone
    // token. Check page text for digit adjacent to "star", then match any "star" or "Nstar" textItem.
    if (matches.length === 0 && searchWords.length === 2 &&
        /^\d+$/.test(searchWords[0]) && searchWords[1] === 'star') {
      const digit = searchWords[0];
      const pageTextLower = (args.pageText || '').toLowerCase();
      const adjacentRegex = new RegExp(`${digit}[\\s\\-]?star`, 'i');
      const foundInPageText = adjacentRegex.test(pageTextLower);
      logger.info(`[actionFindElements] Digit-star check: "${digit} star" in pageText=${foundInPageText}`);
      if (foundInPageText) {
        // Prefer exact "Nstar" concat token, then any standalone "star" item
        const concatItem = textItems.find(i => i.text.toLowerCase().trim() === `${digit}star`);
        const anyStarItem = textItems.find(i => /\bstar\b/i.test(i.text) || i.text.toLowerCase() === 'star');
        const bestMatch = concatItem || anyStarItem;
        if (bestMatch) {
          logger.info(`[actionFindElements] Digit-star match: "${bestMatch.text}" at (${Math.round(bestMatch.x)},${Math.round(bestMatch.y)})`);
          matches.push({ ...bestMatch, matchType: 'digit-star', matchScore: 0.85 });
        }
      }
    }

    // DEBUG: Log final result
    logger.info(`[actionFindElements] Total matches found: ${matches.length}`);
  }
  
  // Sort by match score
  matches.sort((a, b) => b.matchScore - a.matchScore);

  if (matches.length > 0 && highlight) {
    await actionHighlightElements({ elements: matches, duration: 0, color: highlightColor });
  }

  return {
    ok: matches.length > 0,
    matches,
    count: matches.length,
    searchText
  };
}

/**
 * Try to combine text items to match a phrase using spatial proximity.
 * Checks if textItems[startIdx] matches the first word, then spatially
 * finds each subsequent word on the same row (y-diff <= 20px).
 * Returns combined bounding box if all words found, null otherwise.
 */
function tryCombineItems(textItems, startIdx, searchWords) {
  const firstItem = textItems[startIdx];
  if (!firstItem) return null;

  const firstText = firstItem.text.toLowerCase().trim();
  const firstWord = searchWords[0];

  // Check if this item matches the first search word.
  // For pure numeric tokens (e.g. "5", "1"), require exact match to avoid
  // false positives like "5.5s" or "15%" matching \b5\b.
  const isNumericToken = /^\d+$/.test(firstWord);
  const isFirstMatch = isNumericToken
    ? firstText === firstWord
    : (firstText === firstWord || new RegExp(`\\b${firstWord}\\b`, 'i').test(firstText));

  // Diagnostic: log every time first word matches (not too spammy since most items won't match)
  if (isFirstMatch) {
    logger.info(`[tryCombineItems] First word "${firstWord}" matched item "${firstItem.text}" at (${Math.round(firstItem.x)},${Math.round(firstItem.y)}) idx=${startIdx}`);
  }

  if (!isFirstMatch) return null;

  // First word matched — spatially find all remaining words on the same row
  let combinedText = firstItem.text;
  let minX = firstItem.x, minY = firstItem.y;
  let maxRight = firstItem.x + firstItem.width;
  let maxBottom = firstItem.y + firstItem.height;
  let allWordsFound = true;

  for (let w = 1; w < searchWords.length; w++) {
    const targetWord = searchWords[w];
    let bestMatch = null;
    let bestAbsXDist = Infinity;

    // Spatial scan: search ALL items for the closest same-row match
    for (let j = 0; j < textItems.length; j++) {
      const item = textItems[j];
      const itemText = item.text.toLowerCase().trim();

      const isMatch = itemText === targetWord ||
                      new RegExp(`\\b${targetWord}\\b`, 'i').test(itemText);
      if (!isMatch) continue;

      // Same row: y-diff <= 80px.
      // Live OCR may return "5" from "4.4 out of 5" (y≈308) while "star" rows are at y≈373 (65px diff).
      const yDiff = Math.abs(item.y - firstItem.y);
      if (yDiff > 80) continue;

      // Must be within 400px of the FIRST matched word horizontally (same visual cluster).
      // NOTE: do NOT require right-of — the star rating table has "5" in right column
      // and "star" labels in left column (x=432 < x=603).
      const absXDist = Math.abs(item.x - firstItem.x);
      if (absXDist > 400) continue;

      if (absXDist < bestAbsXDist) {
        bestAbsXDist = absXDist;
        bestMatch = item;
      }
    }

    if (!bestMatch) {
      allWordsFound = false;
      break;
    }

    combinedText += ' ' + bestMatch.text;
    minX = Math.min(minX, bestMatch.x);
    minY = Math.min(minY, bestMatch.y);
    maxRight = Math.max(maxRight, bestMatch.x + bestMatch.width);
    maxBottom = Math.max(maxBottom, bestMatch.y + bestMatch.height);
    logger.info(`[tryCombineItems] Spatial match: "${targetWord}" found at (${bestMatch.x.toFixed(0)}, ${bestMatch.y.toFixed(0)}) absXDist=${bestAbsXDist.toFixed(0)}px yDiff=${Math.abs(bestMatch.y - firstItem.y).toFixed(0)}px`);
  }

  if (allWordsFound) {
    logger.info(`[tryCombineItems] Matched phrase: "${combinedText}"`);
    return {
      x: minX,
      y: minY,
      width: maxRight - minX,
      height: maxBottom - minY,
      text: combinedText,
      _consumed: 1
    };
  }

  return null;
}

/**
 * Find matches for compound terms (dot-separated, etc.)
 * Searches for consecutive items that collectively match
 */
function findCompoundMatches(textItems, parts, originalSearch) {
  const matches = [];
  const searchLower = originalSearch.toLowerCase();
  
  for (let i = 0; i < textItems.length; i++) {
    let combinedText = '';
    let minX = Infinity, minY = Infinity, maxRight = 0, maxBottom = 0;
    let partsFound = 0;
    let itemsConsumed = 0;
    
    for (let j = i; j < textItems.length && itemsConsumed < parts.length * 2; j++) {
      const item = textItems[j];
      const itemText = item.text.toLowerCase().trim();
      
      if (!itemText) continue;
      
      const targetPart = parts[partsFound];
      
      // Check if item matches current part (or contains it)
      if (itemText === targetPart || 
          itemText.includes(targetPart) || 
          targetPart.includes(itemText)) {
        combinedText += item.text;
        minX = Math.min(minX, item.x);
        minY = Math.min(minY, item.y);
        maxRight = Math.max(maxRight, item.x + item.width);
        maxBottom = Math.max(maxBottom, item.y + item.height);
        
        partsFound++;
        itemsConsumed++;
        
        if (partsFound >= parts.length) {
          // Combined text found - create match
          matches.push({
            x: minX,
            y: minY,
            width: maxRight - minX,
            height: maxBottom - minY,
            text: combinedText,
            matchType: 'compound',
            matchScore: 1.0
          });
          break;
        }
      } else if (partsFound > 0) {
        // Allow separators (dots, arrows, etc.) between parts
        if (/^[.\->_:]$/.test(itemText)) {
          combinedText += item.text;
          itemsConsumed++;
          // Don't increment partsFound
        } else {
          break; // Non-matching item, stop
        }
      } else {
        break; // First item didn't match
      }
    }
  }
  
  return {
    ok: matches.length > 0,
    matches,
    count: matches.length,
    searchText: originalSearch
  };
}

/**
 * Simple fuzzy matching for text
 */
function fuzzyMatch(search, text) {
  // Check if all search words appear in text
  const searchWords = search.split(/\s+/);
  return searchWords.every(word => text.includes(word));
}

/**
 * Highlight elements on screen using GhostLayer
 * @param {Object} args - elements (bounding boxes), duration
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightElements(args = {}) {
  const { elements = [], duration = 3000, color = '#00ff00' } = args;
  
  try {
    // Send to GhostLayer via HTTP to overlay control server
    const highlightData = {
      type: 'highlight',
      elements: elements.map(el => ({
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        label: el.label || el.text?.substring(0, 20) || '',
        color: el.color || color
      })),
      duration
    };
    
    // Send HTTP POST to overlay control server in main process
    await _sendHighlightToOverlay(highlightData);
    
    logger.info(`[app.agent] Highlighting ${elements.length} elements`);
    
    return { ok: true, highlighted: elements.length };
  } catch (error) {
    logger.error(`[app.agent] Highlight error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Send highlight data to overlay control server (runs in main process)
 */
async function _sendHighlightToOverlay(data) {
  const http = require('http');
  const OVERLAY_HOST = '127.0.0.1';
  const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
  
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request(
      {
        hostname: OVERLAY_HOST,
        port: OVERLAY_PORT,
        path: '/overlay/highlight',
        method: 'POST',
        timeout: 2000,
        headers: { 
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload) 
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.ok) {
              resolve(result);
            } else {
              reject(new Error(result.error || 'Highlight failed'));
            }
          } catch (_) {
            resolve({ ok: true }); // Non-fatal
          }
        });
      }
    );
    
    req.on('error', (err) => {
      logger.debug(`[app.agent] Highlight request failed (overlay server not running?): ${err.message}`);
      resolve({ ok: false, error: err.message }); // Non-fatal - proceed without highlighting
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Timeout' });
    });
    
    req.write(payload);
    req.end();
  });
}

/**
 * Draw a visible border around the currently focused app window.
 * Useful during app.agent steps so the user can see which app is being targeted.
 */
async function actionHighlightAppBoundary({ appName, color = '#ffaa00', label } = {}) {
  const bounds = await _getActiveAppBounds().catch(() => null);
  if (!bounds) {
    logger.debug('[app.agent] Cannot highlight app boundary — no active window bounds');
    return { ok: false, error: 'No active window bounds' };
  }
  const el = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    label: label || bounds.appName || appName || 'active app',
    color
  };
  return actionHighlightElements({ elements: [el], duration: 0, color });
}

/**
 * Return the bounds + name of the currently focused (front) app window.
 * Screenshot-free (uses get-windows / AppleScript fallback) so main.js can draw
 * a persistent session boundary without tainting OCR. Fast — no OCR.
 */
async function actionGetActiveBounds() {
  const bounds = await _getActiveAppBounds().catch(() => null);
  if (!bounds || !(bounds.width > 0 && bounds.height > 0)) {
    return { ok: false, error: 'No active window bounds' };
  }
  return { ok: true, bounds };
}

/**
 * Clear the app boundary highlight from the overlay.
 */
async function actionClearAppBoundary() {
  try {
    await sendOverlayIpc({ type: 'clear' });
    return { ok: true };
  } catch (error) {
    logger.debug(`[app.agent] Clear app boundary failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

/**
 * Highlight all text elements on screen
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightAll(args = {}) {
  try {
    // 1. Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      return parseResult;
    }

    // 2. Clip to active app window — drops menu bar, Dock, overlay, other apps
    const appBounds = await _getActiveAppBounds().catch(() => null);
    const filteredItems = _filterItemsByAppBounds(parseResult.textItems, appBounds);

    // 3. Highlight all elements within app bounds (persistent)
    return await actionHighlightElements({
      elements: filteredItems,
      duration: args.duration || 0,  // 0 = persistent
      color: args.color || '#00ff00'
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Highlight elements matching search text
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightSearch(args = {}) {
  const { searchText, duration = 0 } = args;  // 0 = persistent
  
  if (!searchText) {
    return { ok: false, error: 'searchText is required' };
  }
  
  try {
    // Send scanning start — hides overlay windows for a clean screenshot (no GhostLayer yet)
    logger.info('[actionHighlightSearch] Starting scan');
    await sendOverlayIpc({ type: 'scanning_start' });
    // Wait for macOS to fully composite the hide before capturing
    await new Promise(r => setTimeout(r, 150));

    // 1. Parse screenshot (overlay is hidden — clean capture)
    const parseResult = await actionParseScreenshot({});

    // Now show the GhostLayer scanning animation (screenshot already taken)
    sendOverlayIpc({ type: 'show_scan_overlay' });
    if (!parseResult.ok) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return parseResult;
    }

    // Update screen center from parsed dimensions (if available from LiteParse)
    if (parseResult.imageWidth && parseResult.imageHeight) {
      screenCenterX = parseResult.imageWidth / 2;
      screenCenterY = parseResult.imageHeight / 2;
      logger.info(`[actionHighlightSearch] Screen center updated: ${screenCenterX}x${screenCenterY}`);
    }

    // 2. Clip to active app window — drops menu bar, Dock, overlay, other apps
    const _highlightAppBounds = await _getActiveAppBounds().catch(() => null);
    const _filteredItems = _filterItemsByAppBounds(parseResult.textItems, _highlightAppBounds);

    // 3. Find matching elements within app bounds only
    const pageText = parseResult.raw && parseResult.raw.pages && parseResult.raw.pages[0]
      ? (parseResult.raw.pages[0].text || '')
      : '';
    const findResult = await actionFindElements({
      searchText,
      textItems: _filteredItems,
      pageText
    });
    
    if (!findResult.ok || findResult.matches.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: `No elements found matching "${searchText}"` };
    }
    
    logger.info(`[actionHighlightSearch] Found ${findResult.matches.length} matches for "${searchText}"`);
    findResult.matches.slice(0, 5).forEach((match, i) => {
      const quadrant = match.y < screenCenterY ? (match.x < screenCenterX ? 'UL' : 'UR') : (match.x < screenCenterX ? 'LL' : 'LR');
      logger.info(`[actionHighlightSearch] Match ${i} [${quadrant}]: "${match.text?.substring(0, 40)}" at (${match.x.toFixed(0)}, ${match.y.toFixed(0)})`);
    });
    
    // 3. Add padding and apply quadrant-based coordinate adjustments
    const adjustedMatches = findResult.matches.map(match => {
      const quadrantOffset = getQuadrantOffset(match.x, match.y);
      return {
        ...match,
        x: match.x + 15 + quadrantOffset.x,         // Base padding + quadrant x offset
        y: match.y + 5 + quadrantOffset.y,          // Base padding + quadrant y offset
        width: match.width + 20,  // 5px each side = 10px total
        height: match.height + 20 // 5px each side = 10px total
      };
    });
    
    // 4. Highlight matches in different color (persistent)
    const result = await actionHighlightElements({
      elements: adjustedMatches,
      duration: args.duration || 0,  // 0 = persistent
      color: '#ff0000'  // Red for search matches
    });
    sendOverlayIpc({ type: 'scanning_complete' });
    return result;
  } catch (error) {
    sendOverlayIpc({ type: 'scanning_complete' });
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 1B: Boundary-Based Highlighting (Text Block Grouping)
// ---------------------------------------------------------------------------

/**
 * Group text items into logical boundaries (paragraphs/text blocks) by proximity
 * Uses X position alignment for left-aligned paragraphs instead of strict overlap
 * @param {Array} textItems - LiteParse text items
 * @param {Object} options - grouping parameters
 * @returns {Array} - Boundary boxes
 */
function groupTextItemsIntoBoundaries(textItems, options = {}) {
  const { 
    yThreshold = 30,           // Wider vertical gap tolerance for paragraphs
    xAlignmentThreshold = 100, // Wider horizontal alignment tolerance
    minItemsPerBoundary = 1    // Keep single lines too
  } = options;
  
  if (!textItems || textItems.length === 0) {
    return [];
  }
  
  logger.info(`[groupTextItemsIntoBoundaries] Processing ${textItems.length} text items`);
  
  // 1. Sort by Y position (top to bottom reading order)
  const sorted = [...textItems].sort((a, b) => a.y - b.y);
  
  // 2. Group items by paragraph patterns
  // - Left-aligned: similar X position
  // - Vertical proximity: lines close together
  // - Right edge patterns: paragraphs often have similar right edges too
  const groups = [];
  let currentGroup = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const lastItem = currentGroup[currentGroup.length - 1];
    
    // Vertical gap between lines
    const yGap = item.y - (lastItem.y + lastItem.height);
    
    // Left edge alignment (key for paragraphs)
    const leftEdgeDiff = Math.abs(item.x - lastItem.x);
    
    // Right edge for detecting justified/right-aligned text
    const lastRight = lastItem.x + lastItem.width;
    const itemRight = item.x + item.width;
    const rightEdgeDiff = Math.abs(itemRight - lastRight);
    
    // Horizontal overlap check
    const overlap = Math.max(0, Math.min(itemRight, lastRight) - Math.max(item.x, lastItem.x));
    const hasOverlap = overlap > 0;
    
    // Paragraph continuation logic:
    // 1. Small vertical gap (within line spacing)
    // 2. One of these must be true:
    //    - Similar left edge (left-aligned paragraphs)
    //    - Similar right edge (right-aligned or justified)
    //    - Has horizontal overlap (same text block)
    const isParagraphLine = 
      yGap <= yThreshold && 
      (leftEdgeDiff <= xAlignmentThreshold || 
       rightEdgeDiff <= xAlignmentThreshold ||
       hasOverlap);
    
    if (isParagraphLine) {
      currentGroup.push(item);
    } else {
      if (currentGroup.length >= minItemsPerBoundary) {
        groups.push(currentGroup);
      }
      currentGroup = [item];
    }
  }
  
  // Don't forget the last group
  if (currentGroup.length >= minItemsPerBoundary) {
    groups.push(currentGroup);
  }
  
  logger.info(`[groupTextItemsIntoBoundaries] Created ${groups.length} paragraph groups`);
  
  // 3. Merge into boundary boxes with padding
  const boundaries = groups.map((group, index) => {
    const minX = Math.min(...group.map(i => i.x));
    const maxX = Math.max(...group.map(i => i.x + i.width));
    const minY = Math.min(...group.map(i => i.y));
    const maxY = Math.max(...group.map(i => i.y + i.height));
    
    return {
      x: minX - 10,
      y: minY - 6,
      width: maxX - minX + 20,
      height: maxY - minY + 12,
      text: group.map(i => i.text).join(' ').substring(0, 80),
      label: `Paragraph ${index + 1} (${group.length} lines)`,
      color: '#00aaff'
    };
  });
  
  logger.info(`[groupTextItemsIntoBoundaries] Returning ${boundaries.length} boundaries`);
  return boundaries;
}

/**
 * Group text items into UI sections using grid-based clustering
 * Creates larger bounding boxes around clusters of text for section-level monitoring
 * @param {Array} textItems - array of text items with x, y, width, height
 * @param {Object} options - clustering parameters
 * @returns {Array} - Section boundary boxes with center points for nutjs
 */
function groupTextItemsIntoSections(textItems, options = {}) {
  const {
    gridSize = 200,              // Size of grid cells in pixels
    minClusterSize = 3,          // Minimum items to form a section
    mergeAdjacent = true         // Whether to merge adjacent grid cells
  } = options;

  if (!textItems || textItems.length === 0) {
    return [];
  }

  logger.info(`[groupTextItemsIntoSections] Processing ${textItems.length} text items with gridSize=${gridSize}`);

  // 1. Assign items to grid cells
  const grid = new Map();
  
  textItems.forEach(item => {
    const cellX = Math.floor(item.x / gridSize);
    const cellY = Math.floor(item.y / gridSize);
    const key = `${cellX},${cellY}`;
    
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(item);
  });

  logger.info(`[groupTextItemsIntoSections] Created ${grid.size} grid cells`);

  // 2. Find connected cells (merge adjacent cells with items)
  const visited = new Set();
  const sections = [];

  for (const [key, items] of grid) {
    if (visited.has(key)) continue;
    
    // BFS to find all connected cells
    const section = [...items];
    const queue = [key];
    visited.add(key);

    while (queue.length > 0) {
      const current = queue.shift();
      const [cx, cy] = current.split(',').map(Number);

      // Check 8 neighbors (including diagonals)
      const neighbors = [
        [cx-1, cy-1], [cx, cy-1], [cx+1, cy-1],
        [cx-1, cy],               [cx+1, cy],
        [cx-1, cy+1], [cx, cy+1], [cx+1, cy+1]
      ];

      for (const [nx, ny] of neighbors) {
        const nkey = `${nx},${ny}`;
        if (grid.has(nkey) && !visited.has(nkey)) {
          section.push(...grid.get(nkey));
          visited.add(nkey);
          queue.push(nkey);
        }
      }
    }

    if (section.length >= minClusterSize) {
      sections.push(section);
    }
  }

  logger.info(`[groupTextItemsIntoSections] Created ${sections.length} sections from ${grid.size} cells`);

  // 3. Convert sections to bounding boxes with center points
  const boundaries = sections.map((section, index) => {
    const minX = Math.min(...section.map(i => i.x));
    const maxX = Math.max(...section.map(i => i.x + i.width));
    const minY = Math.min(...section.map(i => i.y));
    const maxY = Math.max(...section.map(i => i.y + i.height));
    
    const width = maxX - minX + 30;
    const height = maxY - minY + 30;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    
    return {
      x: minX - 15,
      y: minY - 15,
      width,
      height,
      centerX,
      centerY,
      text: section[0].text.substring(0, 50),
      label: `Section ${index + 1}`,
      color: index % 2 === 0 ? '#00aaff' : '#ff6b6b',
      itemCount: section.length,
      type: 'section'
    };
  });

  // Sort by item count (largest sections first)
  boundaries.sort((a, b) => b.itemCount - a.itemCount);

  logger.info(`[groupTextItemsIntoSections] Returning ${boundaries.length} section boundaries`);
  return boundaries;
}

/**
 * Step 2: Merge small boundary groups into larger clusters
 * Takes the output from groupTextItemsIntoBoundaries and merges nearby groups
 * @param {Array} boundaries - Array of boundary boxes from step 1
 * @param {Object} options - merging parameters
 * @returns {Array} - Merged boundary clusters
 */
function mergeSmallGroupsIntoClusters(boundaries, options = {}) {
  const { 
    verticalMergeThreshold = 40,   // Max vertical gap to merge (pixels)
    horizontalOverlapRatio = 0.2     // Min horizontal overlap % to merge
  } = options;
  
  if (boundaries.length < 2) return boundaries;
  
  // Sort by Y position (top to bottom)
  const sorted = [...boundaries].sort((a, b) => a.y - b.y);
  const clusters = [];
  let currentCluster = null;
  
  for (const boundary of sorted) {
    if (!currentCluster) {
      currentCluster = { 
        ...boundary, 
        items: [boundary],
        originalCount: 1 
      };
      continue;
    }
    
    // Calculate vertical gap
    const verticalGap = boundary.y - (currentCluster.y + currentCluster.height);
    
    // Calculate horizontal overlap
    const overlapLeft = Math.max(currentCluster.x, boundary.x);
    const overlapRight = Math.min(
      currentCluster.x + currentCluster.width, 
      boundary.x + boundary.width
    );
    const horizontalOverlap = Math.max(0, overlapRight - overlapLeft);
    const minWidth = Math.min(currentCluster.width, boundary.width);
    const overlapRatio = minWidth > 0 ? horizontalOverlap / minWidth : 0;
    
    // Merge if: vertically close AND has horizontal overlap
    if (verticalGap < verticalMergeThreshold && overlapRatio > horizontalOverlapRatio) {
      // Expand cluster to include this boundary
      const newLeft = Math.min(currentCluster.x, boundary.x);
      const newTop = Math.min(currentCluster.y, boundary.y);
      const newRight = Math.max(
        currentCluster.x + currentCluster.width, 
        boundary.x + boundary.width
      );
      const newBottom = Math.max(
        currentCluster.y + currentCluster.height, 
        boundary.y + boundary.height
      );
      
      currentCluster.x = newLeft;
      currentCluster.y = newTop;
      currentCluster.width = newRight - newLeft;
      currentCluster.height = newBottom - newTop;
      currentCluster.centerX = newLeft + currentCluster.width / 2;
      currentCluster.centerY = newTop + currentCluster.height / 2;
      currentCluster.items.push(boundary);
      currentCluster.originalCount = currentCluster.items.length;
    } else {
      // Save current cluster and start new one
      clusters.push(currentCluster);
      currentCluster = { 
        ...boundary, 
        items: [boundary],
        originalCount: 1 
      };
    }
  }
  
  // Don't forget the last cluster
  if (currentCluster) clusters.push(currentCluster);
  
  logger.info(`[mergeSmallGroupsIntoClusters] Merged ${boundaries.length} -> ${clusters.length} clusters`);
  return clusters;
}

/**
 * Merge a group of clusters into a single section boundary
 * @param {Array} clusters - Array of clusters to merge
 * @returns {Object} - Merged section boundary
 */
function mergeClustersIntoSection(clusters) {
  const xs = clusters.map(c => c.x);
  const ys = clusters.map(c => c.y);
  const rights = clusters.map(c => c.x + c.width);
  const bottoms = clusters.map(c => c.y + c.height);

  const allItems = clusters.flatMap(c => c.items || [c]);

  return {
    x: Math.min(...xs) - 10,
    y: Math.min(...ys) - 10,
    width: Math.max(...rights) - Math.min(...xs) + 20,
    height: Math.max(...bottoms) - Math.min(...ys) + 20,
    items: allItems,
    label: `Section (${allItems.length} items)`,
    color: '#00aaff'
  };
}

/**
 * Detect UI sections by finding significant gaps between text clusters
 * @param {Array} clusters - Paragraph/text clusters from groupTextItemsIntoBoundaries
 * @param {Object} options - gap detection parameters
 * @returns {Array} - Merged sections representing UI areas
 */
function detectSectionsByGaps(clusters, options = {}) {
  const {
    minHorizontalGap = 80,   // Min px gap to split horizontally (sidebar vs editor)
    minVerticalGap = 100,    // Min px gap to split vertically (editor vs panel)
    mergeThreshold = 50      // Max distance to merge nearby clusters
  } = options;

  if (!clusters || clusters.length === 0) return [];

  // Get cluster centers and bounds
  const points = clusters.map(c => ({
    ...c,
    cx: c.x + c.width / 2,
    cy: c.y + c.height / 2,
    right: c.x + c.width,
    bottom: c.y + c.height
  }));

  // Sort by horizontal position first to find column groups
  const byX = [...points].sort((a, b) => a.cx - b.cx);

  // Find vertical column boundaries (large horizontal gaps)
  const columns = [];
  let currentColumn = [byX[0]];

  for (let i = 1; i < byX.length; i++) {
    const prev = byX[i - 1];
    const curr = byX[i];
    const gap = curr.x - prev.right;

    if (gap > minHorizontalGap) {
      // Large horizontal gap - start new column
      columns.push(currentColumn);
      currentColumn = [curr];
    } else {
      currentColumn.push(curr);
    }
  }
  columns.push(currentColumn);

  // Within each column, merge clusters that are close vertically
  const sections = [];

  for (const column of columns) {
    // Sort by Y within column
    column.sort((a, b) => a.cy - b.cy);

    let currentSection = [column[0]];

    for (let i = 1; i < column.length; i++) {
      const prev = column[i - 1];
      const curr = column[i];
      const verticalGap = curr.y - prev.bottom;

      if (verticalGap > minVerticalGap) {
        // Large vertical gap - save current section, start new one
        sections.push(mergeClustersIntoSection(currentSection));
        currentSection = [curr];
      } else {
        currentSection.push(curr);
      }
    }
    sections.push(mergeClustersIntoSection(currentSection));
  }

  return sections;
}

/**
 * Create a section from a group of items
 * @param {Array} items - Items to group into section
 * @returns {Object} - Section boundary box
 */
function createSection(items) {
  const xs = items.map(i => i.x);
  const ys = items.map(i => i.y);
  const rights = items.map(i => i.right || (i.x + i.width));
  const bottoms = items.map(i => i.bottom || (i.y + i.height));

  const padding = 25;  // Increased padding for larger, more visible boxes

  return {
    x: Math.min(...xs) - padding,
    y: Math.min(...ys) - padding,
    width: Math.max(...rights) - Math.min(...xs) + (padding * 2),
    height: Math.max(...bottoms) - Math.min(...ys) + (padding * 2),
    items: items,
    label: `Section (${items.length} items)`,
    color: '#00aaff'
  };
}

/**
 * Find the largest whitespace gap in a given direction
 * @param {Array} items - Blocks to analyze
 * @param {string} direction - 'x' or 'y'
 * @param {number} minGap - Minimum gap to consider
 * @returns {Object} - {position, size} of largest gap
 */
function findLargestGap(items, direction, minGap) {
  const isX = direction === 'x';
  const coord = isX ? 'x' : 'y';
  const endCoord = isX ? 'right' : 'bottom';

  // Sort by position
  const sorted = [...items].sort((a, b) => a[coord] - b[coord]);

  let largestGap = { position: 0, size: 0 };

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr[coord] - prev[endCoord];

    if (gap > largestGap.size && gap > minGap) {
      largestGap = {
        position: prev[endCoord] + gap / 2,  // Split at middle of gap
        size: gap
      };
    }
  }

  return largestGap;
}

/**
 * Split items into two groups at a given position
 * @param {Array} items - Blocks to split
 * @param {string} direction - 'x' or 'y'
 * @param {number} position - Split position
 * @returns {Array} - [group1, group2]
 */
function splitAtGap(items, direction, position) {
  const isX = direction === 'x';
  const coord = isX ? 'x' : 'y';
  const endCoord = isX ? 'right' : 'bottom';

  const group1 = [];
  const group2 = [];

  for (const item of items) {
    const itemCenter = item[coord] + (item[endCoord] - item[coord]) / 2;
    if (itemCenter < position) {
      group1.push(item);
    } else {
      group2.push(item);
    }
  }

  return [group1, group2];
}

/**
 * Recursive X-Y cut algorithm for UI section detection
 * Splits page by finding largest whitespace gaps in X or Y direction
 * @param {Array} textItems - Raw text items with bounds
 * @param {Object} options - Thresholds for splitting
 * @returns {Array} - Detected UI sections
 */
function detectSectionsXYCut(textItems, options = {}) {
  const {
    minXGap = 80,        // Min horizontal gap to split (sidebar vs editor)
    minYGap = 60,        // Min vertical gap to split (editor vs panel)
    minSectionSize = 3   // Min items to form a section
  } = options;

  if (!textItems || textItems.length === 0) return [];

  // Convert to blocks with bounds
  const blocks = textItems.map(item => ({
    ...item,
    right: item.x + item.width,
    bottom: item.y + item.height
  }));

  // Recursive function to split regions
  function splitRegion(items) {
    if (items.length < minSectionSize) {
      return items.length > 0 ? [createSection(items)] : [];
    }

    // Find the largest gap in X and Y directions
    const xGap = findLargestGap(items, 'x', minXGap);
    const yGap = findLargestGap(items, 'y', minYGap);

    // Decide whether to split and which direction
    if (xGap.size > minXGap && xGap.size > yGap.size) {
      // Split horizontally at X gap
      const [left, right] = splitAtGap(items, 'x', xGap.position);
      return [...splitRegion(left), ...splitRegion(right)];
    } else if (yGap.size > minYGap) {
      // Split vertically at Y gap
      const [top, bottom] = splitAtGap(items, 'y', yGap.position);
      return [...splitRegion(top), ...splitRegion(bottom)];
    }

    // No significant gap - this is a section
    return [createSection(items)];
  }

  return splitRegion(blocks);
}

/**
 * Simple 2-way horizontal split based on screen midpoint
 * Forces exactly 2 sections regardless of gaps
 * @param {Array} textItems - Text items
 * @returns {Array} - 2 sections (left/right)
 */
function splitHorizontalTwoWay(textItems) {
  if (!textItems || textItems.length === 0) return [];

  // Find screen bounds
  const xs = textItems.map(i => i.x);
  const rights = textItems.map(i => i.x + i.width);
  const minX = Math.min(...xs);
  const maxX = Math.max(...rights);

  // Split at middle
  const midX = (minX + maxX) / 2;

  const left = textItems.filter(i => i.x + i.width / 2 < midX);
  const right = textItems.filter(i => i.x + i.width / 2 >= midX);

  const sections = [];
  if (left.length > 0) sections.push(createSection(left));
  if (right.length > 0) sections.push(createSection(right));

  return sections;
}

/**
 * K-means clustering for UI sections - forces exactly k clusters
 * @param {Array} textItems - Text items with x, y, width, height
 * @param {Object} options - k and weights
 * @returns {Array} - k sections
 */
function clusterKMeans(textItems, options = {}) {
  const { k = 2, xWeight = 2, yWeight = 0.5 } = options;

  if (!textItems || textItems.length === 0) return [];
  if (textItems.length < k) return [createSection(textItems)];

  // Initialize centroids - spread horizontally
  const xs = textItems.map(i => i.x + i.width / 2);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);

  let centroids = [];
  for (let i = 0; i < k; i++) {
    const t = k === 1 ? 0.5 : i / (k - 1);
    centroids.push({
      x: minX + t * (maxX - minX),
      y: 0
    });
  }

  // K-means iterations
  const maxIterations = 20;
  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each point to nearest centroid
    const assignments = textItems.map(item => {
      const itemX = item.x + item.width / 2;
      const itemY = item.y + item.height / 2;

      let minDist = Infinity;
      let bestCluster = 0;

      for (let c = 0; c < k; c++) {
        const dx = (itemX - centroids[c].x) * xWeight;
        const dy = (itemY - centroids[c].y) * yWeight;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < minDist) {
          minDist = dist;
          bestCluster = c;
        }
      }

      return bestCluster;
    });

    // Update centroids
    const newCentroids = centroids.map(() => ({ x: 0, y: 0, count: 0 }));

    for (let i = 0; i < textItems.length; i++) {
      const cluster = assignments[i];
      const item = textItems[i];
      newCentroids[cluster].x += item.x + item.width / 2;
      newCentroids[cluster].y += item.y + item.height / 2;
      newCentroids[cluster].count++;
    }

    // Check for convergence and handle empty clusters
    let changed = false;
    for (let c = 0; c < k; c++) {
      if (newCentroids[c].count === 0) {
        const randomItem = textItems[Math.floor(Math.random() * textItems.length)];
        centroids[c] = {
          x: randomItem.x + randomItem.width / 2,
          y: randomItem.y + randomItem.height / 2
        };
        changed = true;
      } else {
        const newX = newCentroids[c].x / newCentroids[c].count;
        const newY = newCentroids[c].y / newCentroids[c].count;
        if (Math.abs(newX - centroids[c].x) > 1 || Math.abs(newY - centroids[c].y) > 1) {
          changed = true;
        }
        centroids[c] = { x: newX, y: newY };
      }
    }

    if (!changed) break;
  }

  // Group items by final centroid assignment
  const groups = Array.from({ length: k }, () => []);

  for (const item of textItems) {
    const itemX = item.x + item.width / 2;
    const itemY = item.y + item.height / 2;

    let minDist = Infinity;
    let bestCluster = 0;

    for (let c = 0; c < k; c++) {
      const dx = (itemX - centroids[c].x) * xWeight;
      const dy = (itemY - centroids[c].y) * yWeight;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < minDist) {
        minDist = dist;
        bestCluster = c;
      }
    }

    groups[bestCluster].push(item);
  }

  return groups
    .filter(g => g.length > 0)
    .map(g => createSection(g));
}

/**
 * Simple tight proximity clustering - groups nearby items only
 * @param {Array} textItems - Text items with x, y, width, height
 * @param {Object} options - Tight proximity thresholds
 * @returns {Array} - Natural clusters (2-5 sections)
 */
function simpleTightClustering(textItems, options = {}) {
  const {
    itemGap = 15,      // Max px between items to group (very tight!)
    clusterGap = 30,   // Max px between clusters to merge (also tight!)
    minClusterSize = 2 // Min items to form a cluster
  } = options;

  if (!textItems || textItems.length === 0) return [];

  // Step 1: Create micro-clusters with tight item proximity
  let microClusters = [];
  const processed = new Set();

  for (let i = 0; i < textItems.length; i++) {
    if (processed.has(i)) continue;

    const cluster = [textItems[i]];
    processed.add(i);

    // Find all items within itemGap of any item in cluster
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = 0; j < textItems.length; j++) {
        if (processed.has(j)) continue;

        const item = textItems[j];
        const itemCenter = {
          x: item.x + item.width / 2,
          y: item.y + item.height / 2
        };

        // Check if close to any item in current cluster
        for (const cItem of cluster) {
          const cCenter = {
            x: cItem.x + cItem.width / 2,
            y: cItem.y + cItem.height / 2
          };
          const dist = Math.sqrt(
            Math.pow(itemCenter.x - cCenter.x, 2) +
            Math.pow(itemCenter.y - cCenter.y, 2)
          );

          if (dist <= itemGap) {
            cluster.push(item);
            processed.add(j);
            changed = true;
            break;
          }
        }
      }
    }

    if (cluster.length >= minClusterSize) {
      microClusters.push(cluster);
    }
  }

  if (microClusters.length === 0) {
    return textItems.map(item => createSection([item]));
  }

  // Step 2: Merge micro-clusters that are very close
  let merged = true;
  while (merged && microClusters.length > 1) {
    merged = false;

    // Calculate bounds for each cluster
    const bounds = microClusters.map(cluster => ({
      x: Math.min(...cluster.map(i => i.x)),
      y: Math.min(...cluster.map(i => i.y)),
      right: Math.max(...cluster.map(i => i.x + i.width)),
      bottom: Math.max(...cluster.map(i => i.y + i.height))
    }));

    // Find closest pair of clusters
    let closestPair = null;
    let minDistance = Infinity;

    for (let i = 0; i < bounds.length; i++) {
      for (let j = i + 1; j < bounds.length; j++) {
        const a = bounds[i];
        const b = bounds[j];

        // Calculate gap between bounding boxes
        const xGap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.right, b.right));
        const yGap = Math.max(0, Math.max(a.y, b.y) - Math.min(a.bottom, b.bottom));

        // If overlapping or very close
        const distance = Math.sqrt(xGap * xGap + yGap * yGap);

        if (distance < minDistance && distance <= clusterGap) {
          minDistance = distance;
          closestPair = [i, j];
        }
      }
    }

    // Merge closest pair if found
    if (closestPair) {
      const [i, j] = closestPair;
      microClusters[i] = [...microClusters[i], ...microClusters[j]];
      microClusters.splice(j, 1);
      merged = true;
    }
  }

  // Convert to sections
  return microClusters.map(cluster => createSection(cluster));
}

/**
 * Fixed ratio split - assumes sidebar is ~20-25% of screen width
 * @param {Array} textItems - Text items
 * @param {Object} options - split ratio
 * @returns {Array} - 2 sections (sidebar and editor)
 */
function fixedRatioSplit(textItems, options = {}) {
  const { sidebarRatio = 0.22, minSectionItems = 5 } = options;

  if (!textItems || textItems.length === 0) return [];

  // Find overall bounds
  const xs = textItems.map(i => i.x);
  const rights = textItems.map(i => i.x + i.width);
  const minX = Math.min(...xs);
  const maxX = Math.max(...rights);

  // Split at sidebarRatio
  const splitX = minX + (maxX - minX) * sidebarRatio;

  const leftItems = textItems.filter(i => i.x + i.width / 2 < splitX);
  const rightItems = textItems.filter(i => i.x + i.width / 2 >= splitX);

  const sections = [];
  if (leftItems.length >= minSectionItems) sections.push(createSection(leftItems));
  if (rightItems.length >= minSectionItems) sections.push(createSection(rightItems));

  return sections;
}

/**
 * Two-section boundary detection - sidebar vs editor
 * Finds natural split by analyzing X-coordinate distribution
 * @param {Array} textItems - Text items with x, y, width, height
 * @param {Object} options - detection parameters
 * @returns {Array} - 2 sections (sidebar and editor)
 */
function detectTwoSections(textItems, options = {}) {
  const {
    minGapSize = 120,
    minSectionItems = 5
  } = options;

  if (!textItems || textItems.length === 0) return [];

  // Get X coordinates of all items (center points)
  const itemCenters = textItems.map(item => ({
    ...item,
    centerX: item.x + item.width / 2
  }));

  // Sort by X position
  const sortedByX = [...itemCenters].sort((a, b) => a.centerX - b.centerX);

  // Find the largest gap between consecutive items
  let largestGap = { index: -1, size: 0, position: 0 };

  for (let i = 1; i < sortedByX.length; i++) {
    const prev = sortedByX[i - 1];
    const curr = sortedByX[i];
    const gap = curr.centerX - prev.centerX;

    if (gap > largestGap.size && gap >= minGapSize) {
      largestGap = {
        index: i,
        size: gap,
        position: prev.centerX + gap / 2
      };
    }
  }

  // If we found a valid gap, split into two sections
  if (largestGap.size >= minGapSize) {
    const leftItems = sortedByX.slice(0, largestGap.index);
    const rightItems = sortedByX.slice(largestGap.index);

    const sections = [];
    if (leftItems.length >= minSectionItems) sections.push(createSection(leftItems));
    if (rightItems.length >= minSectionItems) sections.push(createSection(rightItems));

    return sections;
  }

  // No significant gap found
  return [];
}

/**
 * Check if two boxes are close using edge-to-edge distance
 * Different thresholds for horizontal (X) and vertical (Y)
 * @param {Object} b1 - First box
 * @param {Object} b2 - Second box
 * @param {number} thresholdX - Max horizontal gap
 * @param {number} thresholdY - Max vertical gap
 * @returns {boolean}
 */
function areBoxesClose(b1, b2, thresholdX, thresholdY) {
  // Horizontal gap between boxes (0 if overlapping)
  const dx = Math.max(0, Math.max(b1.x, b2.x) - Math.min(b1.right, b2.right));
  
  // Vertical gap between boxes (0 if overlapping)
  const dy = Math.max(0, Math.max(b1.y, b2.y) - Math.min(b1.bottom, b2.bottom));
  
  // Both gaps must be within thresholds
  return dx <= thresholdX && dy <= thresholdY;
}

/**
 * Module-level app name matcher — case-insensitive substring match in either direction.
 * Used to verify that active-win's reported app matches the intended target.
 */
function _appNameMatches(a, b) {
  if (!a || !b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.includes(bl) || bl.includes(al);
}

/**
 * Fuzzy-match a stopKeyword against OCR text, tolerating date format variations.
 * Handles: ordinal suffixes (18th→18), month abbreviations (June↔Jun),
 * punctuation differences, and token-level overlap.
 * Returns true if the keyword semantically matches anywhere in the OCR text.
 */
function _keywordFuzzyMatchesOCR(keyword, ocrText) {
  if (!keyword || !ocrText) return false;
  // 1. Fast path: exact case-insensitive substring
  if (ocrText.toLowerCase().includes(keyword.toLowerCase())) return true;
  // 2. Normalize: strip ordinals, abbreviate month names, remove punctuation
  const MONTH_MAP = {
    'january':'jan','february':'feb','march':'mar','april':'apr',
    'may':'may','june':'jun','july':'jul','august':'aug',
    'september':'sep','october':'oct','november':'nov','december':'dec'
  };
  const normalize = (s) => s.toLowerCase()
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g,
             m => MONTH_MAP[m])
    .replace(/[,.\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const normKeyword = normalize(keyword);
  const normOCR = normalize(ocrText);
  // 3. Normalized exact match
  if (normOCR.includes(normKeyword)) return true;
  // 4. Windowed token proximity: all keyword tokens must appear within a 6-word
  // sliding window — prevents "jun" (from date divider) + "18" (from a "9:18 AM"
  // timestamp) combining into a false positive for "June 18th".
  const kwTokens = normKeyword.split(/\s+/).filter(Boolean);
  if (kwTokens.length === 0) return false;
  if (kwTokens.length === 1) return normOCR.includes(kwTokens[0]);
  const ocrTokens = normOCR.split(/\s+/);
  const WINDOW = 6;
  for (let i = 0; i <= ocrTokens.length - kwTokens.length; i++) {
    const win = ocrTokens.slice(i, i + WINDOW).join(' ');
    if (kwTokens.every(tok => win.includes(tok))) return true;
  }
  return false;
}

/**
 * Ask the LLM whether the scroll goal is already satisfied by the current OCR text.
 * Used as a second gate after fuzzy keyword match to distinguish a date label
 * (always visible in viewport) from actual target content that has been scrolled to.
 * Returns 'yes', 'partial', or 'no'.
 */
async function _llmCheckScrollGoalMet(purposeStatement, ocrText) {
  try {
    const answer = await skillLlmAsk(
      `Scroll goal: "${purposeStatement}"\n\nScreen text (OCR):\n${ocrText.slice(0, 3000)}\n\nIs the TARGET content (not just a date label or section divider at the edge of the current view) now visible on screen? Reply with exactly one word: yes, no, or partial.`
    );
    const a = (answer || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    return a === 'yes' ? 'yes' : a === 'partial' ? 'partial' : 'no';
  } catch (_) { return 'no'; }
}

/**
 * Filter LiteParse textItems to only those that overlap the active app window.
 * Discards items from the macOS menu bar, Dock, other app windows, and the
 * ThinkDrop overlay that appear in a full-screen screenshot but are outside
 * the target application's bounds.
 *
 * Uses overlap detection (not strict containment) so items straddling the
 * app window edge are kept.
 *
 * @param {Array}       textItems - Raw LiteParse items with {x, y, width, height}
 * @param {Object|null} appBounds - {x, y, width, height} from active-win, or null
 * @returns {Array} Filtered subset of textItems
 */
function _filterItemsByAppBounds(textItems, appBounds) {
  if (!appBounds || !textItems || textItems.length === 0) return textItems || [];
  const { x: ax, y: ay, width: aw, height: ah } = appBounds;
  const filtered = textItems.filter(item => {
    const itemRight  = item.x + (item.width  || 0);
    const itemBottom = item.y + (item.height || 0);
    return item.x < ax + aw && itemRight  > ax &&
           item.y < ay + ah && itemBottom > ay;
  });
  logger.info(`[app.agent] _filterItemsByAppBounds: kept ${filtered.length}/${textItems.length} items within appBounds (${ax},${ay} ${aw}x${ah})`);
  return filtered;
}

function mergeCloseBoxes(textItems, options = {}) {
  const {
    thresholdX = 40,   // Horizontal: larger gap allowed (words in same line)
    thresholdY = 20,   // Vertical: smaller gap (line spacing)
    minItems = 3,
    minHeight = 20    // Filter out tiny boxes (height <= 20px)
  } = options;

  if (!textItems || textItems.length === 0) return [];

  // Convert items to box format with explicit bounds
  const boxes = textItems.map(item => ({
    ...item,
    right: item.x + item.width,
    bottom: item.y + item.height
  }));

  logger.info(`[mergeCloseBoxes] Processing ${boxes.length} items with thresholds X:${thresholdX}, Y:${thresholdY}`);

  // Build adjacency list - which boxes are close to each other
  const graph = Array.from({ length: boxes.length }, () => []);
  
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (areBoxesClose(boxes[i], boxes[j], thresholdX, thresholdY)) {
        graph[i].push(j);
        graph[j].push(i);
      }
    }
  }

  // Find connected groups using BFS
  const visited = new Set();
  const mergedSections = [];

  for (let i = 0; i < boxes.length; i++) {
    if (visited.has(i)) continue;

    // BFS to find all connected boxes
    const queue = [i];
    visited.add(i);
    const group = [];

    while (queue.length > 0) {
      const current = queue.shift();
      group.push(boxes[current]);

      for (const neighbor of graph[current]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    // Only keep groups with enough items
    if (group.length >= minItems) {
      // Compute bounding box of the group
      const minY = Math.min(...group.map(b => b.y));
      const maxBottom = Math.max(...group.map(b => b.bottom));
      const height = maxBottom - minY;

      // Skip tiny boxes (like single line text fragments)
      if (height <= minHeight) {
        logger.info(`[mergeCloseBoxes] Skipping small section: ${height}px height, ${group.length} items`);
        continue;
      }

      const section = {
        x: Math.min(...group.map(b => b.x)),
        y: minY,
        width: Math.max(...group.map(b => b.right)) - Math.min(...group.map(b => b.x)),
        height: height,
        items: group,
        label: `Section (${group.length} items)`,
        color: '#00aaff'
      };
      mergedSections.push(section);
    }
  }

  logger.info(`[mergeCloseBoxes] Created ${mergedSections.length} sections`);
  return mergedSections;
}

/**
 * Highlight text boundaries - boxes around text clusters
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightBoundaries(args = {}) {
  try {
    logger.info('[actionHighlightBoundaries] Starting edge-to-edge clustering');
    await sendOverlayIpc({ type: 'scanning_start' });

    // Step 1: Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return parseResult;
    }

    const rawTextItems = parseResult.textItems || [];
    if (rawTextItems.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: 'No text found' };
    }

    // Step 2: Clip to active app window before clustering
    const _boundaryAppBounds = await _getActiveAppBounds().catch(() => null);
    const textItems = _filterItemsByAppBounds(rawTextItems, _boundaryAppBounds);

    // Step 3: Edge-to-edge clustering with BFS (app-bounded items only)
    const sections = mergeCloseBoxes(textItems, {
      thresholdX: args.thresholdX || 50,   // Larger horizontal gap for sidebar separation
      thresholdY: args.thresholdY || 25,   // Smaller vertical gap for line grouping
      minItems: args.minItems || 3
    });

    if (sections.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: 'No sections found' };
    }

    logger.info(`[actionHighlightBoundaries] Edge-to-edge: ${sections.length} sections from ${textItems.length} items`);

    // Highlight sections as boxes
    const result = await actionHighlightElements({
      elements: sections,
      duration: args.duration || 0,
      color: null
    });

    sendOverlayIpc({ type: 'scanning_complete' });

    return {
      ok: true,
      sections,
      summary: {
        sectionCount: sections.length,
        itemCount: textItems.length
      }
    };
  } catch (error) {
    sendOverlayIpc({ type: 'scanning_complete' });
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 1C: Inferred Assets/Icons Detection (Heuristic-Based)
// ---------------------------------------------------------------------------

/**
 * Detect inferred icon gaps (empty space left of text where icons typically are)
 * @param {Array} textItems - LiteParse text items
 * @param {Object} options - detection parameters
 * @returns {Array} - Inferred icon locations
 */
function detectIconGaps(textItems, options = {}) {
  const { 
    minGap = 30,    // Min gap to infer icon
    maxGap = 80,    // Max gap (larger = probably not icon)
    iconSize = 24   // Typical icon size assumption
  } = options;
  
  const inferredIcons = [];
  
  for (const item of textItems) {
    // Check space to the LEFT of text
    const gapLeft = item.x; // Distance from screen edge
    
    if (gapLeft >= minGap && gapLeft <= maxGap) {
      // Infer icon exists here
      inferredIcons.push({
        x: Math.max(0, item.x - iconSize - 5),  // 5px padding
        y: item.y,
        width: iconSize,
        height: Math.max(iconSize, item.height),
        text: `Icon? (~${Math.round(gapLeft)}px)`,
        label: `Icon? (~${Math.round(gapLeft)}px)`,
        color: '#ffcc00',  // Yellow
        type: 'icon-gap'
      });
    }
  }
  
  return inferredIcons;
}

/**
 * Detect large blank areas where images/icons could exist
 * @param {Array} textItems - LiteParse text items
 * @param {Object} screenDimensions - { width, height }
 * @param {Object} options - detection parameters
 * @returns {Array} - Inferred blank areas
 */
function detectBlankAreas(textItems, screenDimensions, options = {}) {
  const {
    minArea = 100 * 100,   // Min 100x100px to be significant
    gridSize = 50,         // Grid cell size
    edgeMargin = 50        // Ignore edges (window chrome)
  } = options;
  
  const { width: screenWidth, height: screenHeight } = screenDimensions;
  
  if (!screenWidth || !screenHeight) {
    return [];
  }
  
  // Create grid to track occupied areas
  const occupied = new Set();
  
  for (const item of textItems) {
    const startGridX = Math.floor(Math.max(0, item.x - edgeMargin) / gridSize);
    const endGridX = Math.floor(Math.min(screenWidth, item.x + item.width + edgeMargin) / gridSize);
    const startGridY = Math.floor(Math.max(0, item.y - edgeMargin) / gridSize);
    const endGridY = Math.floor(Math.min(screenHeight, item.y + item.height + edgeMargin) / gridSize);
    
    for (let gx = startGridX; gx <= endGridX; gx++) {
      for (let gy = startGridY; gy <= endGridY; gy++) {
        occupied.add(`${gx},${gy}`);
      }
    }
  }
  
  // Find empty grid cells
  const emptyRegions = [];
  const maxGridX = Math.floor(screenWidth / gridSize);
  const maxGridY = Math.floor(screenHeight / gridSize);
  
  for (let gy = 1; gy < maxGridY - 1; gy++) {  // Skip edges
    for (let gx = 1; gx < maxGridX - 1; gx++) {
      if (!occupied.has(`${gx},${gy}`)) {
        // Check if this is a large enough empty region
        const regionX = gx * gridSize;
        const regionY = gy * gridSize;
        const regionWidth = gridSize;
        const regionHeight = gridSize;
        
        // Only add if area is significant
        if (regionWidth * regionHeight >= minArea / 4) {
          emptyRegions.push({
            x: regionX,
            y: regionY,
            width: regionWidth,
            height: regionHeight,
            text: `Blank? (${regionWidth}x${regionHeight})`,
            label: `Blank? (${regionWidth}x${regionHeight})`,
            color: '#ff8800',  // Orange
            type: 'blank-area'
          });
        }
      }
    }
  }
  
  // Merge adjacent empty regions
  return mergeAdjacentRegions(emptyRegions, gridSize);
}

/**
 * Merge adjacent regions to reduce visual clutter
 */
function mergeAdjacentRegions(regions, threshold) {
  if (regions.length === 0) return [];
  
  const merged = [];
  const used = new Set();
  
  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    
    let region = { ...regions[i] };
    used.add(i);
    
    // Find adjacent regions
    for (let j = i + 1; j < regions.length; j++) {
      if (used.has(j)) continue;
      
      const other = regions[j];
      const adjacent = 
        Math.abs(region.x - other.x) <= threshold &&
        Math.abs(region.y - other.y) <= threshold;
      
      if (adjacent) {
        // Merge
        region.x = Math.min(region.x, other.x);
        region.y = Math.min(region.y, other.y);
        region.width = Math.max(region.x + region.width, other.x + other.width) - region.x;
        region.height = Math.max(region.y + region.height, other.y + other.height) - region.y;
        region.text = `Blank? (${Math.round(region.width)}x${Math.round(region.height)})`;
        region.label = `Blank? (${Math.round(region.width)}x${Math.round(region.height)})`;
        used.add(j);
      }
    }
    
    merged.push(region);
  }
  
  return merged;
}

/**
 * Detect gaps between text clusters
 * @param {Array} textItems - LiteParse text items
 * @param {Object} options - detection parameters
 * @returns {Array} - Cluster gaps
 */
function detectClusterGaps(textItems, options = {}) {
  const { minClusterGap = 50 } = options;
  
  // Group text into clusters
  const clusters = groupTextItemsIntoBoundaries(textItems, {
    yThreshold: 40,
    xAlignmentThreshold: 50,
    minItemsPerBoundary: 1
  });
  
  if (clusters.length < 2) {
    return [];
  }
  
  const gaps = [];
  
  // Find gaps between clusters
  for (let i = 0; i < clusters.length - 1; i++) {
    const current = clusters[i];
    const next = clusters[i + 1];
    
    const gap = next.y - (current.y + current.height);
    
    if (gap >= minClusterGap) {
      gaps.push({
        x: Math.min(current.x, next.x),
        y: current.y + current.height,
        width: Math.max(current.width, next.width),
        height: gap,
        text: `Gap (${Math.round(gap)}px)`,
        label: `Gap (${Math.round(gap)}px)`,
        color: '#cc66ff',  // Purple
        type: 'cluster-gap'
      });
    }
  }
  
  return gaps;
}

/**
 * Step 3: Analyze spatial gaps between clusters to create UI sections
 * Finds significant gaps between clusters and creates a grid layout
 * @param {Array} clusters - Text clusters from Step 2
 * @param {Object} options - Analysis parameters
 * @returns {Array} - UI sections with center points for NutJS
 */
function analyzeSpatialGrid(clusters, options = {}) {
  const { minGapSize = 20, mergeAdjacent = true } = options;

  if (!clusters || clusters.length === 0) {
    return [];
  }

  logger.info(`[analyzeSpatialGrid] Analyzing ${clusters.length} clusters for grid layout`);

  // 1. Find all vertical gaps (gaps along X axis = vertical dividers)
  const sortedByX = [...clusters].sort((a, b) => a.x - b.x);
  const verticalLines = findSignificantGaps(sortedByX, 'x', minGapSize);

  // 2. Find all horizontal gaps (gaps along Y axis = horizontal dividers)
  const sortedByY = [...clusters].sort((a, b) => a.y - b.y);
  const horizontalLines = findSignificantGaps(sortedByY, 'y', minGapSize);

  logger.info(`[analyzeSpatialGrid] Found ${verticalLines.length} vertical lines, ${horizontalLines.length} horizontal lines`);

  // 3. Create grid cells from gap intersections
  const gridCells = createGridFromLines(verticalLines, horizontalLines, clusters);

  // 4. Assign clusters to grid sections
  let sections = assignClustersToSections(clusters, gridCells);

  // 5. Optionally merge adjacent sections
  if (mergeAdjacent) {
    sections = mergeAdjacentSections(sections, minGapSize);
  }

  // 6. Calculate centers and format for NutJS
  return sections.map((section, index) => ({
    x: section.x,
    y: section.y,
    width: section.width,
    height: section.height,
    type: section.clusters.length > 3 ? 'ui-section' : 'text-block',
    clusters: section.clusters,
    centerX: section.x + section.width / 2,
    centerY: section.y + section.height / 2,
    label: section.clusters.length > 3 ? `UI Section ${index + 1}` : `Text Block ${index + 1}`,
    itemCount: section.clusters.reduce((sum, c) => sum + (c.items?.length || 1), 0),
    color: section.clusters.length > 3 ? '#00ff88' : '#00aaff'
  }));
}

/**
 * Find significant gaps between clusters along an axis
 * @param {Array} sortedClusters - Clusters sorted by x or y
 * @param {string} axis - 'x' or 'y'
 * @param {number} minGapSize - Minimum gap to consider significant
 * @returns {Array} - Gap line coordinates
 */
function findSignificantGaps(sortedClusters, axis, minGapSize) {
  const gaps = [];
  const dimension = axis === 'x' ? 'width' : 'height';

  for (let i = 0; i < sortedClusters.length - 1; i++) {
    const current = sortedClusters[i];
    const next = sortedClusters[i + 1];

    const currentEnd = current[axis] + current[dimension];
    const nextStart = next[axis];
    const gap = nextStart - currentEnd;

    if (gap >= minGapSize) {
      gaps.push({
        position: currentEnd + gap / 2,
        size: gap,
        start: currentEnd,
        end: nextStart
      });
    }
  }

  return gaps;
}

/**
 * Create grid cells from vertical and horizontal gap lines
 * @param {Array} verticalLines - Vertical dividers (x positions)
 * @param {Array} horizontalLines - Horizontal dividers (y positions)
 * @param {Array} clusters - All clusters for boundary calculation
 * @returns {Array} - Grid cell boundaries
 */
function createGridFromLines(verticalLines, horizontalLines, clusters) {
  // Get overall bounds
  const allXs = clusters.map(c => c.x);
  const allYs = clusters.map(c => c.y);
  const allRights = clusters.map(c => c.x + c.width);
  const allBottoms = clusters.map(c => c.y + c.height);

  const minX = Math.min(...allXs);
  const maxX = Math.max(...allRights);
  const minY = Math.min(...allYs);
  const maxY = Math.max(...allBottoms);

  // Create sorted arrays of dividers including screen edges
  const xDividers = [minX, ...verticalLines.map(l => l.position), maxX].sort((a, b) => a - b);
  const yDividers = [minY, ...horizontalLines.map(l => l.position), maxY].sort((a, b) => a - b);

  // Create cells from adjacent dividers
  const cells = [];
  for (let i = 0; i < xDividers.length - 1; i++) {
    for (let j = 0; j < yDividers.length - 1; j++) {
      cells.push({
        x: xDividers[i],
        y: yDividers[j],
        width: xDividers[i + 1] - xDividers[i],
        height: yDividers[j + 1] - yDividers[j],
        clusters: []
      });
    }
  }

  return cells;
}

/**
 * Assign clusters to their containing grid cells
 * @param {Array} clusters - All text clusters
 * @param {Array} gridCells - Grid cell boundaries
 * @returns {Array} - Sections with assigned clusters
 */
function assignClustersToSections(clusters, gridCells) {
  // Assign each cluster to the cell that contains its center
  clusters.forEach(cluster => {
    const centerX = cluster.x + cluster.width / 2;
    const centerY = cluster.y + cluster.height / 2;

    const containingCell = gridCells.find(cell =>
      centerX >= cell.x && centerX <= cell.x + cell.width &&
      centerY >= cell.y && centerY <= cell.y + cell.height
    );

    if (containingCell) {
      containingCell.clusters.push(cluster);
    }
  });

  // Filter to cells that contain clusters and calculate actual bounds
  return gridCells
    .filter(cell => cell.clusters.length > 0)
    .map(cell => {
      const clusterXs = cell.clusters.map(c => c.x);
      const clusterYs = cell.clusters.map(c => c.y);
      const clusterRights = cell.clusters.map(c => c.x + c.width);
      const clusterBottoms = cell.clusters.map(c => c.y + c.height);

      return {
        x: Math.min(...clusterXs) - 10,
        y: Math.min(...clusterYs) - 6,
        width: Math.max(...clusterRights) - Math.min(...clusterXs) + 20,
        height: Math.max(...clusterBottoms) - Math.min(...clusterYs) + 12,
        clusters: cell.clusters
      };
    });
}

/**
 * Merge adjacent sections that are very close together
 * @param {Array} sections - Grid sections
 * @param {number} threshold - Distance threshold for merging
 * @returns {Array} - Merged sections
 */
function mergeAdjacentSections(sections, threshold) {
  if (sections.length < 2) return sections;

  const merged = [];
  const visited = new Set();

  for (let i = 0; i < sections.length; i++) {
    if (visited.has(i)) continue;

    let current = { ...sections[i] };
    visited.add(i);

    // Find all adjacent sections
    for (let j = i + 1; j < sections.length; j++) {
      if (visited.has(j)) continue;

      const other = sections[j];
      const gapX = Math.max(0, Math.max(current.x, other.x) - Math.min(current.x + current.width, other.x + other.width));
      const gapY = Math.max(0, Math.max(current.y, other.y) - Math.min(current.y + current.height, other.y + other.height));

      // Merge if close enough (small gap or overlapping)
      if (gapX <= threshold && gapY <= threshold) {
        current.clusters = [...current.clusters, ...other.clusters];
        current.x = Math.min(current.x, other.x);
        current.y = Math.min(current.y, other.y);
        current.width = Math.max(current.x + current.width, other.x + other.width) - current.x;
        current.height = Math.max(current.y + current.height, other.y + other.height) - current.y;
        visited.add(j);
      }
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Run full 3-step pipeline and highlight spatial grid sections
 * @returns {Promise<{ok: boolean, sections?: Array}>}
 */
async function actionAnalyzeSpatialGrid(args = {}) {
  try {
    await sendOverlayIpc({ type: 'scanning_start' });

    // Step 1: Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return parseResult;
    }

    // Step 2: Create clusters
    const clusters = groupTextItemsIntoBoundaries(parseResult.textItems, {
      yThreshold: args.yThreshold || 30,
      xAlignmentThreshold: args.xAlignmentThreshold || 100,
      minItemsPerBoundary: 1
    });

    if (clusters.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: 'No text clusters found' };
    }

    // Step 3: Analyze spatial grid
    const sections = analyzeSpatialGrid(clusters, {
      minGapSize: args.minGapSize || 20,
      mergeAdjacent: args.mergeAdjacent !== false
    });

    if (sections.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: 'No UI sections detected' };
    }

    logger.info(`[actionAnalyzeSpatialGrid] Detected ${sections.length} sections: ${sections.filter(s => s.type === 'ui-section').length} UI sections, ${sections.filter(s => s.type === 'text-block').length} text blocks`);

    // Highlight sections with different colors
    const result = await actionHighlightElements({
      elements: sections,
      duration: args.duration || 0,
      color: null  // Use section-specific colors
    });

    sendOverlayIpc({ type: 'scanning_complete' });

    return {
      ok: true,
      sections,
      summary: {
        totalSections: sections.length,
        uiSections: sections.filter(s => s.type === 'ui-section').length,
        textBlocks: sections.filter(s => s.type === 'text-block').length,
        totalClusters: clusters.length,
        totalItems: parseResult.textItems?.length || 0
      }
    };
  } catch (error) {
    sendOverlayIpc({ type: 'scanning_complete' });
    return { ok: false, error: error.message };
  }
}

/**
 * Highlight inferred assets/icons on screen
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightAssets(args = {}) {
  try {
    // 1. Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      return parseResult;
    }
    
    // 2. Detect inferred assets (icon gaps only - blank areas removed due to false positives)
    const iconGaps = detectIconGaps(parseResult.textItems, {
      minGap: args.minIconGap || 30,
      maxGap: args.maxIconGap || 80
    });
    
    if (iconGaps.length === 0) {
      return { ok: false, error: 'No inferred icons found' };
    }
    
    // 3. Highlight inferred icons (persistent)
    return await actionHighlightElements({
      elements: iconGaps,
      duration: args.duration || 0,  // 0 = persistent
      color: '#ffcc00'  // Yellow for icon gaps
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/**
 * Clear all highlights from screen
 * @returns {Promise<{ok: boolean}>}
 */
async function actionClearHighlights() {
  try {
    await _sendHighlightToOverlay({
      type: 'clear',
      elements: []
    });
    
    logger.info('[app.agent] Highlights cleared');
    return { ok: true, cleared: true };
  } catch (error) {
    logger.error(`[app.agent] Clear highlights error: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Phase 2: App Taxonomy & Category System
// ---------------------------------------------------------------------------

const db = require('../skill-helpers/skill-db.cjs');
const { ask: skillLlmAsk } = require('../skill-helpers/skill-llm.cjs');
const webAgent = require('./web.agent.cjs');
const { webCrawl } = require('./web.crawl.cjs');

const VALID_CATEGORIES = ['browser', 'editor', 'chat', 'design', 'terminal', 'email', 'document', 'other'];

/**
 * Resolve any caller-supplied category string to one of the valid CATEGORY_SCHEMAS keys.
 * Priority: (1) KNOWN_APPS by appName, (2) callerCategory if already valid,
 * (3) LLM classification for unrecognized strings, (4) 'other' fallback.
 */
async function _resolveCategory(appName, callerCategory) {
  if (KNOWN_APPS[appName]) return KNOWN_APPS[appName];
  if (callerCategory && VALID_CATEGORIES.includes(callerCategory)) return callerCategory;
  if (callerCategory) {
    try {
      const answer = await skillLlmAsk(
        `App: "${appName}", described as: "${callerCategory}"\nChoose the single best category from this list: ${VALID_CATEGORIES.join(', ')}\nReply with ONLY the category word, nothing else.`
      );
      const classified = (answer || '').trim().toLowerCase().replace(/[^a-z]/g, '');
      if (VALID_CATEGORIES.includes(classified)) {
        logger.info(`[app.agent] _resolveCategory: "${callerCategory}" → "${classified}" (LLM)`);
        return classified;
      }
    } catch (_) {}
  }
  return 'other';
}

/**
 * Score a candidate scroll region type against the purposeStatement to prefer
 * the region that best matches the user's intent (message panel vs sidebar, etc.).
 * Returns a numeric bonus: positive = preferred, negative = deprioritized.
 */
function _scrollRegionPriority(inferredType, purposeStatement) {
  const ps = (purposeStatement || '').toLowerCase();
  if (/message|date|conversation|thread|post|reply|sent|received/.test(ps)) {
    if (inferredType === 'messages') return 100;
    if (inferredType === 'sidebar' || inferredType === 'channel_list') return -50;
  }
  if (/channel|project|chat name|conversation list|find.*chat|find.*channel/.test(ps)) {
    if (inferredType === 'sidebar' || inferredType === 'channel_list') return 100;
    if (inferredType === 'messages') return -50;
  }
  return 0;
}

const KNOWN_APPS = {
  'Google Chrome': 'browser',
  'Safari': 'browser',
  'Firefox': 'browser',
  'Microsoft Edge': 'browser',
  'Brave Browser': 'browser',
  'Visual Studio Code': 'editor',
  'Code': 'editor',
  'Cursor': 'editor',
  'Windsurf': 'editor',
  'Zed': 'editor',
  'Sublime Text': 'editor',
  'TextEdit': 'editor',
  'Devin': 'editor',
  'Slack': 'chat',
  'Discord': 'chat',
  'Microsoft Teams': 'chat',
  'Telegram': 'chat',
  'WhatsApp': 'chat',
  'Messages': 'chat',
  'Figma': 'design',
  'Adobe Photoshop': 'design',
  'Adobe Illustrator': 'design',
  'Sketch': 'design',
  'Terminal': 'terminal',
  'iTerm': 'terminal',
  'iTerm2': 'terminal',
  'Warp': 'terminal',
  'Hyper': 'terminal',
  'Mail': 'email',
  'Microsoft Outlook': 'email',
  'Spark': 'email',
  'Microsoft Word': 'document',
  'Word': 'document',
  'Pages': 'document',
  'Google Docs': 'document',
  'Writer': 'document',
  'LibreOffice Writer': 'document'
};

const CATEGORY_SCROLL_DEFAULTS = {
  editor: 'up',
  chat: 'up',
  terminal: 'up',
  email: 'down',
  design: 'down',
  document: 'down',
  other: 'down'
};

const CATEGORY_SCHEMAS = {
  browser: {
    regions: {
      addressBar: { x: [150, 800], y: [70, 100], type: 'url_input' },
      tabBar: { x: [0, 1200], y: [35, 70], type: 'tabs' },
      contentArea: { x: [0, 1280], y: [100, 800], type: 'page_content' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relY = y - appBounds.y;
        const ah = appBounds.height;
        if (relY / ah > 0.04 && relY / ah < 0.12 && x > appBounds.x + 150) return { type: 'address_bar', confidence: 0.9 };
        if (relY / ah > 0.12 && width > appBounds.width * 0.6) return { type: 'content', confidence: 0.85 };
        return { type: 'unknown', confidence: 0.3 };
      }
      if (y > 70 && y < 100 && x > 150) return { type: 'address_bar', confidence: 0.9 };
      if (y > 100 && width > 800) return { type: 'content', confidence: 0.85 };
      return { type: 'unknown', confidence: 0.3 };
    },
    clipboardBehavior: { cmdA: 'select_all_page', extractionStrategy: 'Cmd+L then Cmd+A' },
    monitoringModes: ['passive'],
    universalFind: 'Cmd+F'
  },
  editor: {
    regions: {
      sidebar: { x: [0, 250], y: [35, 800], type: 'file_tree' },
      editorPane: { x: [250, 1200], y: [70, 750], type: 'code_editor' },
      terminal: { x: [250, 1200], y: [750, 800], type: 'terminal' },
      tabBar: { x: [250, 1200], y: [35, 70], type: 'tabs' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relX = x - appBounds.x;
        const relY = y - appBounds.y;
        const aw = appBounds.width;
        const ah = appBounds.height;
        if (relX / aw < 0.20 && width / aw < 0.25) return { type: 'sidebar', confidence: 0.9 };
        if (relX / aw > 0.18 && width / aw > 0.45 && relY / ah < 0.88) return { type: 'editor', confidence: 0.9 };
        if (relY / ah > 0.88) return { type: 'terminal', confidence: 0.8 };
        return { type: 'unknown', confidence: 0.3 };
      }
      if (x < 250 && width < 300) return { type: 'sidebar', confidence: 0.9 };
      if (x > 250 && width > 600 && y < 750) return { type: 'editor', confidence: 0.9 };
      if (y > 750) return { type: 'terminal', confidence: 0.8 };
      return { type: 'unknown', confidence: 0.3 };
    },
    clipboardBehavior: { cmdA: 'select_all_file', extractionStrategy: 'Cmd+1 then Cmd+A then Cmd+C' },
    monitoringModes: ['passive'],
    universalFind: 'Cmd+F'
  },
  chat: {
    regions: {
      sidebar: { x: [0, 220], y: [50, 800], type: 'channel_list' },
      messageArea: { x: [220, 1200], y: [50, 700], type: 'messages' },
      inputArea: { x: [220, 1200], y: [700, 800], type: 'input_box' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relX = x - appBounds.x;
        const relY = y - appBounds.y;
        const aw = appBounds.width;
        const ah = appBounds.height;
        if (relX / aw < 0.25 && width / aw < 0.25) return { type: 'sidebar', confidence: 0.95 };
        if (relY / ah > 0.88 && height / ah < 0.15) return { type: 'input', confidence: 0.9 };
        // Exclude header zone (top ~20% of app window) and input area at bottom
        if (relX / aw > 0.18 && relY / ah >= 0.20 && (relY + height) / ah < 0.92) return { type: 'messages', confidence: 0.85 };
        return { type: 'unknown', confidence: 0.3 };
      }
      // Fallback: original hardcoded pixel logic
      if (width < 250 && x < 220) return { type: 'sidebar', confidence: 0.95 };
      if (y > 700 && height < 100) return { type: 'input', confidence: 0.9 };
      // Exclude header/toolbar zone (top ~200px) — channel title bar ends ~180px, messages start below
      if (x > 220 && y >= 200 && y < 700) return { type: 'messages', confidence: 0.85 };
      return { type: 'unknown', confidence: 0.3 };
    },
    clipboardBehavior: { cmdA: 'select_input_only', extractionStrategy: 'Scroll + OCR accumulation' },
    monitoringModes: ['active', 'passive'],
    universalFind: 'Cmd+F'
  },
  design: {
    regions: {
      toolbar: { x: [0, 1280], y: [0, 50], type: 'toolbar' },
      canvas: { x: [200, 1100], y: [50, 800], type: 'canvas' },
      layers: { x: [0, 200], y: [50, 800], type: 'layers' },
      properties: { x: [1100, 1280], y: [50, 800], type: 'properties' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relX = x - appBounds.x;
        const relY = y - appBounds.y;
        const aw = appBounds.width;
        const ah = appBounds.height;
        if (relY / ah < 0.07) return { type: 'toolbar', confidence: 0.9 };
        if (relX / aw < 0.17) return { type: 'layers', confidence: 0.85 };
        if ((relX + width) / aw > 0.87) return { type: 'properties', confidence: 0.85 };
        return { type: 'canvas', confidence: 0.7 };
      }
      if (y < 50) return { type: 'toolbar', confidence: 0.9 };
      if (x < 200) return { type: 'layers', confidence: 0.85 };
      if (x > 1100) return { type: 'properties', confidence: 0.85 };
      return { type: 'canvas', confidence: 0.7 };
    },
    clipboardBehavior: { cmdA: 'select_all_canvas', extractionStrategy: 'Specific element selection only' },
    monitoringModes: ['passive'],
    universalFind: 'Cmd+F'
  },
  terminal: {
    regions: {
      scrollback: { x: [0, 1280], y: [0, 750], type: 'output' },
      input: { x: [0, 1280], y: [750, 800], type: 'input_line' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relY = y - appBounds.y;
        const ah = appBounds.height;
        if (relY / ah > 0.88) return { type: 'input', confidence: 0.9 };
        return { type: 'scrollback', confidence: 0.8 };
      }
      if (y > 750) return { type: 'input', confidence: 0.9 };
      return { type: 'scrollback', confidence: 0.8 };
    },
    clipboardBehavior: { cmdA: 'not_applicable', extractionStrategy: 'Selection copy only' },
    monitoringModes: ['passive'],
    universalFind: null
  },
  email: {
    regions: {
      folders: { x: [0, 200], y: [50, 800], type: 'folder_list' },
      messageList: { x: [200, 600], y: [50, 800], type: 'message_list' },
      readingPane: { x: [600, 1280], y: [50, 800], type: 'reading_pane' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relX = x - appBounds.x;
        const aw = appBounds.width;
        if (relX / aw < 0.17) return { type: 'folders', confidence: 0.9 };
        if (relX / aw >= 0.17 && relX / aw < 0.50) return { type: 'message_list', confidence: 0.85 };
        return { type: 'reading_pane', confidence: 0.8 };
      }
      if (x < 200) return { type: 'folders', confidence: 0.9 };
      if (x > 200 && x < 600) return { type: 'message_list', confidence: 0.85 };
      return { type: 'reading_pane', confidence: 0.8 };
    },
    clipboardBehavior: { cmdA: 'select_all_messages', extractionStrategy: 'Focus reading pane then Cmd+A' },
    monitoringModes: ['passive'],
    universalFind: 'Cmd+F'
  },
  document: {
    regions: {
      toolbar: { x: [0, 1280], y: [0, 80], type: 'toolbar' },
      document: { x: [120, 1160], y: [80, 800], type: 'document_content' }
    },
    inferBoundaryType: (width, height, x, y, appBounds) => {
      if (appBounds) {
        const relY = y - appBounds.y;
        const ah = appBounds.height;
        if (relY / ah < 0.12) return { type: 'toolbar', confidence: 0.85 };
        return { type: 'document_content', confidence: 0.8 };
      }
      if (y < 80) return { type: 'toolbar', confidence: 0.85 };
      return { type: 'document_content', confidence: 0.8 };
    },
    clipboardBehavior: { cmdA: 'select_all_document', extractionStrategy: 'Cmd+A then Cmd+C' },
    monitoringModes: ['passive'],
    universalFind: 'Cmd+F'
  },
  other: {
    regions: {},
    inferBoundaryType: () => ({ type: 'unknown', confidence: 0.3 }),
    clipboardBehavior: { cmdA: 'unknown', extractionStrategy: 'Verify before acting' },
    monitoringModes: ['passive'],
    universalFind: null
  }
};

function _buildBoundaryCacheKey(appName, screenDims = {}) {
  const w = screenDims.width || 0;
  const h = screenDims.height || 0;
  return `${appName.replace(/\s+/g, '_').toLowerCase()}::${w}x${h}`;
}

function _isStale(lastUpdated, maxAgeMs) {
  return !lastUpdated || (Date.now() - lastUpdated) > maxAgeMs;
}

function _inferBoundaryType(b, category, appBounds) {
  const schema = CATEGORY_SCHEMAS[category] || CATEGORY_SCHEMAS.other;
  if (schema && schema.inferBoundaryType) {
    return schema.inferBoundaryType(b.width, b.height, b.x, b.y, appBounds);
  }
  return { type: 'unknown', confidence: 0.3 };
}

function _isLikelyOverlayWindow(b, screenWidth, screenHeight) {
  // Floating panel signature: starts in bottom-right quadrant, not full-screen-sized
  const inBottomRight = b.x > screenWidth * 0.5 && b.y > screenHeight * 0.5;
  const isSmallish = (b.width * b.height) < (screenWidth * screenHeight * 0.4);
  return inBottomRight && isSmallish;
}

function _scoreBoundariesForMain(boundaries, category, screenWidth, screenHeight, appBounds) {
  const schema = CATEGORY_SCHEMAS[category] || CATEGORY_SCHEMAS.other;
  const inferred = boundaries.map(b => ({
    ...b,
    typeInfo: _inferBoundaryType(b, category, appBounds),
    cx: b.x + b.width / 2,
    cy: b.y + b.height / 2
  }));

  // Detect sidebar candidates (for sidebar-implies-main heuristic)
  const sidebars = inferred.filter(b => b.typeInfo.type === 'sidebar');
  let mainBySidebar = null;
  if (sidebars.length > 0 && appBounds) {
    const bestSidebar = sidebars.sort((a, b) => a.width * a.height - b.width * b.height)[0];
    const rightOfSidebar = inferred.filter(b => b.x > bestSidebar.x + bestSidebar.width * 0.5);
    const overlappingVertically = rightOfSidebar.filter(b =>
      b.y < bestSidebar.y + bestSidebar.height && b.y + b.height > bestSidebar.y
    );
    if (overlappingVertically.length > 0) {
      mainBySidebar = overlappingVertically.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    }
  }

  const appCenter = appBounds ? {
    x: appBounds.x + appBounds.width / 2,
    y: appBounds.y + appBounds.height / 2
  } : { x: screenWidth / 2, y: screenHeight / 2 };
  const appWidth = appBounds ? appBounds.width : screenWidth;

  const mainTypes = ['content', 'messages', 'editor', 'scrollback', 'canvas', 'reading_pane'];
  return inferred.map(b => {
    // cy < 150 is always a toolbar/header strip — never a scrollable main region
    const isMain = mainTypes.includes(b.typeInfo.type) && b.cy >= 150;
    const isFloating = _isLikelyOverlayWindow(b, screenWidth, screenHeight);
    const distFromCenter = Math.sqrt((b.cx - appCenter.x) ** 2 + (b.cy - appCenter.y) ** 2);
    const isSidebarRightNeighbor = mainBySidebar && b === mainBySidebar;
    const nearCenter = distFromCenter < appWidth * 0.20;
    const score = (isMain ? b.width * b.height : 0)
                + (isSidebarRightNeighbor ? 500_000 : 0)
                + (nearCenter ? 200_000 : 0)
                - (isFloating ? 999_999 : 0);
    return { ...b, isMain, isFloating, score };
  });
}

function _findBoundaryCacheEntry(appName) {
  const prefix = appName.replace(/\s+/g, '_').toLowerCase() + '::';
  for (const [key, entry] of _boundaryCache.entries()) {
    if (key.startsWith(prefix) && !_isStale(entry.capturedAt, _BOUNDARY_CACHE_TTL_MS)) {
      return entry;
    }
  }
  return null;
}

function getBoundariesFromCache(appName, screenDims = {}) {
  // If screenDims provided, do exact key lookup
  if (screenDims && (screenDims.width || screenDims.height)) {
    const key = _buildBoundaryCacheKey(appName, screenDims);
    const entry = _boundaryCache.get(key);
    if (entry && !_isStale(entry.capturedAt, _BOUNDARY_CACHE_TTL_MS)) {
      logger.info(`[app.agent] Boundary cache HIT for ${key} (${entry.boundaries.length} boundaries)`);
      return entry.boundaries;
    }
    if (entry) _boundaryCache.delete(key);
    return null;
  }
  // No screenDims: prefix scan — return most recent valid entry for this app
  const prefix = appName.replace(/\s+/g, '_').toLowerCase() + '::';
  for (const [key, entry] of _boundaryCache.entries()) {
    if (key.startsWith(prefix) && !_isStale(entry.capturedAt, _BOUNDARY_CACHE_TTL_MS)) {
      logger.info(`[app.agent] Boundary cache prefix HIT for ${key} (${entry.boundaries.length} boundaries)`);
      return entry.boundaries;
    }
  }
  return null;
}

function _storeBoundaryCache(appName, boundaries, category, screenDims = {}, appBounds = null) {
  const key = _buildBoundaryCacheKey(appName, screenDims);
  _boundaryCache.set(key, {
    boundaries,
    screenWidth: screenDims.width || 1440,
    screenHeight: screenDims.height || 900,
    appBounds,
    capturedAt: Date.now(),
    category
  });
  logger.info(`[app.agent] Boundary cache STORED for ${key} (${boundaries.length} boundaries, appBounds: ${appBounds ? 'yes' : 'no'})`);
}

function _getScreenDimsFromScreenshot(screenshotPath) {
  try {
    const { PNG } = require('pngjs');
    const buf = fs.readFileSync(screenshotPath);
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height };
  } catch (_) {
    return { width: 1440, height: 900 };
  }
}

function actionClearBoundaryCache({ appName } = {}) {
  if (appName) {
    const prefix = appName.replace(/\s+/g, '_').toLowerCase();
    for (const key of _boundaryCache.keys()) {
      if (key.startsWith(prefix + '::')) _boundaryCache.delete(key);
    }
    logger.info(`[app.agent] Boundary cache cleared for ${appName}`);
    return { ok: true, appName };
  }
  _boundaryCache.clear();
  logger.info(`[app.agent] Boundary cache cleared (all)`);
  return { ok: true, appName: 'all' };
}

function _appAgentDescriptorPath(appName) {
  const safe = appName.replace(/\s+/g, '_').toLowerCase();
  return path.join(AGENTS_DIR, `${safe}.app.agent.md`);
}

function _readShortcutsFromDescriptor(appName) {
  try {
    const filePath = _appAgentDescriptorPath(appName);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const shortcutsMatch = content.match(/## Shortcuts\n([\s\S]*?)(?=\n## |$)/);
    if (!shortcutsMatch) return null;
    const tableLines = shortcutsMatch[1].trim().split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
    const shortcuts = tableLines.slice(1).map(line => {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length >= 2) return { action: cols[0], shortcut: cols[1], context: cols[2] || '' };
      return null;
    }).filter(Boolean);
    if (shortcuts.length === 0) return null;
    logger.info(`[app.agent] Shortcuts loaded from descriptor for ${appName}: ${shortcuts.length} shortcuts`);
    return shortcuts;
  } catch (_) {
    return null;
  }
}

function _writeShortcutsToDescriptor(appName, category, shortcuts) {
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    const filePath = _appAgentDescriptorPath(appName);
    const safe = appName.replace(/\s+/g, '_').toLowerCase();

    const shortcutRows = shortcuts.map(s =>
      `| ${s.action || ''} | ${s.shortcut || ''} | ${s.context || ''} |`
    ).join('\n');

    const shortcutsSection = `## Shortcuts
| Action | Shortcut | Context |
|--------|----------|----------|
${shortcutRows}
`;

    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.includes('## Shortcuts')) {
        content = content.replace(/## Shortcuts[\s\S]*?(?=\n## |$)/, shortcutsSection);
      } else {
        content = content.trimEnd() + '\n\n' + shortcutsSection;
      }
      fs.writeFileSync(filePath, content, 'utf8');
    } else {
      const descriptor = `---
id: ${safe}.app.agent
type: app
service: ${safe}
category: ${category || 'other'}
capabilities:
  - scroll
  - highlight_boundaries
  - search_scroll
  - execute_shortcut
---

## Instructions
Use app.agent skill for all native ${appName} desktop operations.

${shortcutsSection}`;
      fs.writeFileSync(filePath, descriptor, 'utf8');
    }
    logger.info(`[app.agent] Shortcuts written to descriptor: ${filePath}`);
  } catch (err) {
    logger.warn(`[app.agent] Failed to write shortcuts to descriptor: ${err.message}`);
  }
}

async function actionDiscoverShortcuts({ appName, category }) {
  // 1. Check agent descriptor file first (persists across restarts)
  const cachedShortcuts = _readShortcutsFromDescriptor(appName);
  if (cachedShortcuts) {
    return { ok: true, shortcuts: cachedShortcuts, source: 'descriptor' };
  }

  // 2. Web crawl with multiple targeted queries; pick the result with the most content.
  const queries = [
    `${appName} keyboard shortcuts`,
    `${appName} keyboard shortcuts macOS`,
    `${appName} AI assistant shortcut`,
    `${appName} command palette shortcut`,
    `${appName} docs keyboard shortcuts`,
  ];

  let bestUrl = null;
  let bestContent = '';
  let bestQuery = '';

  for (const query of queries) {
    try {
      const searchResult = await webAgent.actionSearchAndNavigate({ query, maxResults: 3 });
      if (!searchResult || !searchResult.ok || !searchResult.bestUrl) continue;

      const crawlResult = await webCrawl({ url: searchResult.bestUrl, maxChars: 10000 });
      if (!crawlResult || !crawlResult.ok || !crawlResult.content) continue;

      if (crawlResult.content.length > bestContent.length) {
        bestContent = crawlResult.content;
        bestUrl = searchResult.bestUrl;
        bestQuery = query;
      }
      if (bestContent.length > 3000) break; // good enough
    } catch (err) {
      logger.warn(`[app.agent] actionDiscoverShortcuts query failed: ${query} - ${err.message}`);
    }
  }

  let shortcuts = [];
  if (bestContent) {
    const llmResult = await skillLlmAsk(`
Extract keyboard shortcuts from this content.
App: ${appName}
Category: ${category}

Include these semantic actions if they are present:
- quick_open (command palette, quick open, go to file)
- open_file_dialog (open file dialog)
- focus_ai (focus AI assistant, open AI chat/panel)
- save
- select_all
- copy, paste
- find/search

Return JSON only:
{
  "shortcuts": [
    { "action": "quick_open", "shortcut": "Cmd+P", "context": "file" },
    { "action": "focus_ai", "shortcut": "Cmd+L", "context": "ai" }
  ]
}

Content:
${bestContent.slice(0, 8000)}
`);

    try {
      const parsed = JSON.parse(llmResult.replace(/```json|```/g, '').trim());
      shortcuts = parsed.shortcuts || [];
    } catch (_) {
      logger.warn(`[app.agent] LLM shortcut parse failed for ${appName}`);
    }
  }

  // 3. Inject conservative category defaults for missing core actions so the proxy
  //    workflow can still run. Defaults are marked in the context column so the
  //    planner can treat them as unverified if needed.
  const coreActions = ['quick_open', 'focus_ai', 'save', 'select_all', 'open_file_dialog'];
  const categoryDefaults = {
    editor: { quick_open: 'Cmd+P', open_file_dialog: 'Cmd+O', focus_ai: 'Cmd+L', save: 'Cmd+S', select_all: 'Cmd+A' },
    browser: { quick_open: 'Cmd+L', focus_ai: 'Cmd+Shift+A', save: 'Cmd+S', select_all: 'Cmd+A' },
    chat: { focus_ai: 'Cmd+L', save: 'Cmd+S', select_all: 'Cmd+A' },
    terminal: { save: 'Cmd+S', select_all: 'Cmd+A' },
  };

  const defaults = categoryDefaults[category] || {};
  for (const action of coreActions) {
    if (!shortcuts.find(s => s.action === action) && defaults[action]) {
      shortcuts.push({ action, shortcut: defaults[action], context: 'default' });
    }
  }

  // 4. Persist to agent descriptor so future runs skip the web crawl
  _writeShortcutsToDescriptor(appName, category, shortcuts);

  logger.info(`[app.agent] Shortcuts discovered for ${appName}: ${shortcuts.length} shortcuts (best query: ${bestQuery || 'none'}, source: ${bestUrl ? 'web' : 'default'})`);
  return { ok: true, shortcuts, source: bestUrl ? 'web' : 'default' };
}

async function enrichAppContext({ appName, category: callerCategory, background = false } = {}) {
  try {
    const category = await _resolveCategory(appName, callerCategory);

    // 1. Capture active app window bounds BEFORE touching our overlay.
    //    Hiding the overlay may steal focus, so active-win must run first.
    //    If active window is ThinkDrop (Electron), fall back to cached bounds for target app.
    let appBounds = await _getActiveAppBounds().catch(() => null);
    if (!appBounds || !_appNameMatches(appBounds.appName, appName)) {
      const _prevCache = _findBoundaryCacheEntry(appName);
      if (_prevCache?.appBounds) {
        logger.info(`[app.agent] enrichAppContext: active window is "${appBounds?.appName || 'unknown'}" — using cached appBounds for ${appName}`);
        appBounds = _prevCache.appBounds;
      } else {
        logger.info(`[app.agent] enrichAppContext: active app bounds unavailable (active: "${appBounds?.appName || 'unknown'}")`);
        appBounds = null;
      }
    } else {
      logger.info(`[app.agent] enrichAppContext: active app bounds ${JSON.stringify(appBounds)}`);
    }

    // 2. Capture screen + parse with our overlay hidden so ThinkDrop doesn't appear in the screenshot
    let captureResult, screenDims;
    await _withCaptureWindow(async () => {
      captureResult = await actionCaptureScreen();
      screenDims = captureResult.ok ? _getScreenDimsFromScreenshot(captureResult.path) : { width: 1440, height: 900 };
    });

    // 3. Check in-process boundary cache (keyed by appName + screen dimensions)
    let boundaries = getBoundariesFromCache(appName, screenDims);
    if (!boundaries) {
      let parseResult;
      await _withCaptureWindow(async () => {
        parseResult = await actionParseScreenshot({ screenshotPath: captureResult.ok ? captureResult.path : undefined });
      });
      if (parseResult.ok && parseResult.textItems && parseResult.textItems.length > 0) {
        boundaries = mergeCloseBoxes(parseResult.textItems, { thresholdX: 50, thresholdY: 25, minItems: 3 });
        _storeBoundaryCache(appName, boundaries, category, screenDims, appBounds);
      } else {
        boundaries = [];
      }
    }

    // 4. Score boundaries using app context and filter overlay-shaped panels
    if (boundaries.length > 0) {
      const scored = _scoreBoundariesForMain(boundaries, category, screenDims.width, screenDims.height, appBounds);
      const filtered = scored.filter(b => !b.isFloating);
      filtered.sort((a, z) => z.score - a.score);
      const topBounds = filtered.slice(0, 8).map(s => ({
        x: s.x, y: s.y, width: s.width, height: s.height,
        label: s.label || s.typeInfo?.type || '',
        color: '#00aaff'
      }));
      _sendHighlightToOverlay({ type: 'highlight', elements: topBounds, source: 'enrich_app_context' }).catch(() => {});
    }

    // 5. Shortcuts — reads from agent descriptor if present, only web-crawls once ever
    const shortcutsResult = await actionDiscoverShortcuts({ appName, category });

    logger.info(`[app.agent] enrichAppContext complete: ${appName} (${category}), boundaries: ${boundaries.length}, shortcuts: ${shortcutsResult.shortcuts.length}, shortcutSource: ${shortcutsResult.source}`);
    return { category, boundaries, shortcuts: shortcutsResult.shortcuts };
  } catch (err) {
    logger.error(`[app.agent] enrichAppContext error: ${err.message}`);
    return { category: KNOWN_APPS[appName] || 'other', boundaries: [], shortcuts: [] };
  }
}

function inferMainRegion(boundaries, category, appBounds = null, screenWidth = 1440, screenHeight = 900) {
  if (!boundaries || boundaries.length === 0) {
    return { centerX: 640, centerY: 400 };
  }

  const scored = _scoreBoundariesForMain(boundaries, category, screenWidth, screenHeight, appBounds)
    .filter(b => b.isMain && !b.isFloating);

  if (scored.length === 0) {
    const largest = [...boundaries].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    return { centerX: largest.x + largest.width / 2, centerY: largest.y + largest.height / 2 };
  }

  const best = scored.sort((a, b) => b.score - a.score)[0];
  return { centerX: best.x + best.width / 2, centerY: best.y + best.height / 2 };
}

// ---------------------------------------------------------------------------
// Phase 3: Monitoring, Scroll Modes, and getRecentOCR
// ---------------------------------------------------------------------------

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEMORY_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const MEMORY_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || '';

async function getRecentOCR({ maxAgeSeconds = 3, appName: targetApp = null, liveOverlayHidden = false } = {}) {
  const _appMatches = (a, b) => {
    if (!a || !b) return false;
    const al = a.toLowerCase();
    const bl = b.toLowerCase();
    return al.includes(bl) || bl.includes(al);
  };

  const dbResult = await new Promise((resolve) => {
    const http = require('http');
    const body = JSON.stringify({ payload: { maxAgeSeconds }, requestId: `ocr_${Date.now()}` });
    const options = {
      hostname: MEMORY_HOST,
      port: MEMORY_PORT,
      path: '/memory.getRecentOcr',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key': MEMORY_API_KEY
      }
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          const capture = data.result?.capture || data.capture || null;
          resolve({
            text: capture?.text || capture?.source_text || capture?.extracted_text || '',
            appName: capture?.appName || null,
            windowTitle: capture?.windowTitle || null,
            timestamp: capture?.created_at || null,
            available: data.result?.available ?? (capture !== null)
          });
        } catch (_) {
          resolve({ text: '', appName: null, windowTitle: null, timestamp: null, available: false });
        }
      });
    });
    req.on('error', () => resolve({ text: '', appName: null, windowTitle: null, timestamp: null, available: false }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ text: '', appName: null, windowTitle: null, timestamp: null, available: false }); });
    req.write(body);
    req.end();
  });

  // Hybrid fallback: if caller specifies a target app and either:
  //   (a) the DB result is from a different app (stale — e.g. monitorService captured Devin), or
  //   (b) the DB has no capture at all (no record within maxAgeSeconds)
  // fall back to a live screen capture so we always get the correct app's content.
  const _needsLiveFallback = targetApp && (!dbResult.appName || !_appMatches(dbResult.appName, targetApp));
  if (_needsLiveFallback) {
    logger.info(`[app.agent] getRecentOCR: DB has "${dbResult.appName}" but target is "${targetApp}" — falling back to live screen capture${liveOverlayHidden ? ' (overlay hidden)' : ''}`);
    try {
      const { screenCapture } = require('./screen.capture.cjs');
      // When requested (e.g. by the monitor), hide the ThinkDrop overlay during
      // the capture so its UI text doesn't taint the OCR and misreport the app.
      const live = liveOverlayHidden
        ? await _withCaptureWindow(() => screenCapture({}))
        : await screenCapture({});
      if (live.success && live.text) {
        return {
          text: live.text,
          appName: live.appName || targetApp,
          windowTitle: live.windowTitle || null,
          timestamp: new Date().toISOString(),
          available: true,
          source: 'live'
        };
      }
    } catch (liveErr) {
      logger.warn(`[app.agent] getRecentOCR: live screen capture fallback failed: ${liveErr.message}`);
    }
  }

  return dbResult;
}

function _getTopWords(text, n) {
  if (!text) return [];
  return text.trim().split(/\s+/).slice(0, n);
}

/**
 * Deduplicate ordered OCR snapshots from a scroll session into a single
 * coherent transcript. Consecutive snapshots overlap by ~50% (half-viewport
 * scrolls), so deduplication is line-based: only lines not seen before are kept.
 * Capped at MAX_ACCUMULATED chars to prevent context overflow in synthesis.
 */
const _MAX_ACCUMULATED_CHARS = 15000;
function _deduplicateScrollJournal(journal, finalText) {
  const all = finalText ? [...journal, finalText] : [...journal];
  if (!all.length) return finalText || '';
  const seen = new Set();
  const lines = [];
  for (const snapshot of all) {
    if (!snapshot) continue;
    for (const line of snapshot.split(/\n/).map(l => l.trim()).filter(l => l.length > 15)) {
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
  }
  return lines.join('\n').slice(0, _MAX_ACCUMULATED_CHARS);
}

async function _sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Single-flight monitor registry — only one monitor loop may run at a time.
// recoverSkill retries / concurrent calls would otherwise spawn parallel loops
// that keep capturing the screen after the UI already moved on.
let _activeMonitorController = null;

/**
 * Ask the LLM whether the content that appeared after a scroll is semantically
 * relevant to the scroll goal. Catches cases where the wrong region scrolled
 * (e.g. sidebar showing channel names instead of messages).
 * Fails open — returns true if LLM is unavailable.
 */
async function _llmCheckRegionRelevance(purposeStatement, beforeText, afterText) {
  try {
    const beforeWords = new Set(beforeText.toLowerCase().split(/\s+/));
    const addedWords = afterText.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !beforeWords.has(w));
    const addedSample = addedWords.slice(0, 40).join(' ');
    if (!addedSample) return true; // nothing to judge

    // OCR noise gate: if most new words contain non-alphabetic artifacts or there are
    // too few of them, the screenshot captured UI chrome / overlay flicker — not real
    // content. Rejecting a region based on noise falsely discards a working scroll target.
    const noisyWords = addedWords.filter(w => /[^a-z0-9'.,!?\-]/.test(w));
    const noiseRatio = noisyWords.length / Math.max(addedWords.length, 1);
    if (noiseRatio > 0.5 || addedWords.length < 5) {
      logger.info(`[app.agent] _llmCheckRegionRelevance: OCR noise gate triggered (noiseRatio=${noiseRatio.toFixed(2)}, words=${addedWords.length}) — accepting region`);
      return true;
    }

    const answer = await skillLlmAsk(
      `Scroll goal: "${purposeStatement}"\n\nBefore scroll (sample): ${beforeText.slice(0, 300)}\nNew content that appeared after scroll: "${addedSample}"\n\nDoes the new content look like it belongs to the correct area for this goal? (e.g. goal is about messages/dates → new content should be chat messages, not channel names or code lines)\nReply with one word: yes or no.`
    );
    const result = (answer || '').trim().toLowerCase().startsWith('y');
    logger.info(`[app.agent] _llmCheckRegionRelevance → ${result ? 'relevant' : 'irrelevant'} (added: "${addedSample.slice(0, 60)}...")`);
    return result;
  } catch (_) { return true; }
}

/**
 * Probe a candidate scroll region by moving the mouse to (cx, cy), scrolling
 * a few steps, and checking whether the OCR content changed.
 * When purposeStatement is provided, also checks whether the changed content
 * is semantically relevant to the scroll goal.
 * Returns { scrolled: boolean, relevant: boolean }
 */
async function _probeBoundaryForScroll(cx, cy, direction, nut, purposeStatement) {
  try {
    const { screenCapture } = require('./screen.capture.cjs');
    await nut.mouse.move([{ x: cx, y: cy }]);
    await _sleep(400); // longer settle — lets ThinkDrop overlay finish any flicker before OCR
    const beforeCapture = await screenCapture({});
    const beforeText = beforeCapture.success ? (beforeCapture.text || '') : '';
    if (direction === 'up') await nut.mouse.scrollUp(150);
    else await nut.mouse.scrollDown(150);
    await _sleep(1000);
    const afterCapture = await screenCapture({});
    const afterText = afterCapture.success ? (afterCapture.text || '') : '';
    const topBefore = _getTopWords(beforeText, 8);
    const topAfter  = _getTopWords(afterText,  8);
    const changed = topBefore.some(w => !topAfter.includes(w)) || topAfter.some(w => !topBefore.includes(w));
    // Restore position so probe is non-destructive
    try {
      if (direction === 'up') await nut.mouse.scrollDown(150);
      else await nut.mouse.scrollUp(150);
      await _sleep(400);
    } catch (_) {}
    // If changed, check whether the new content is semantically right for the goal
    let relevant = true;
    if (changed && purposeStatement) {
      relevant = await _llmCheckRegionRelevance(purposeStatement, beforeText, afterText);
    }
    logger.info(`[app.agent] _probeBoundaryForScroll (${cx},${cy}) → changed=${changed}, relevant=${relevant}`);
    return { scrolled: changed, relevant };
  } catch (err) {
    logger.warn(`[app.agent] _probeBoundaryForScroll error at (${cx},${cy}): ${err.message || err}`);
    return { scrolled: false, relevant: false };
  }
}

async function actionPreScrollPlan({ goal, appName, category, maxScrolls }) {
  try {
    const currentOCR = await getRecentOCR();
    const defaultDirection = CATEGORY_SCROLL_DEFAULTS[category] || 'down';
    const prompt = `
User goal: "${goal}"
App: ${appName} (category: ${category})
Default scroll direction for this category: ${defaultDirection}
Current screen OCR: ${(currentOCR.text || '').slice(0, 600)}

Think like a human. Determine:
1. direction: "up" or "down". Use the category default above unless the goal explicitly requires the opposite.
2. scrollMode: "search" (finding specific past content), "ai_response" (waiting for desktop AI), "live_chat" (waiting for human reply), or "passive_read" (consuming document content)
3. stopKeyword: the specific word, date, or phrase that signals success
4. purposeStatement: one sentence describing what success looks like
5. maxScrolls: how many scroll steps before giving up (10-30)

Return JSON only, no markdown fences.`;

    const result = await skillLlmAsk(prompt);
    const parsed = JSON.parse(result.replace(/```json|```/g, '').trim());

    let chosenDirection = (parsed.direction || '').toLowerCase();
    if (chosenDirection !== 'up' && chosenDirection !== 'down') {
      logger.info(`[app.agent] actionPreScrollPlan: LLM returned invalid direction "${parsed.direction}" — using category default "${defaultDirection}"`);
      chosenDirection = defaultDirection;
    }

    // For passive read, strongly enforce the category default so bottom-to-top
    // apps (chat/editor/terminal) and top-to-bottom apps (email/design/document)
    // accumulate text in the correct order.
    if ((parsed.scrollMode || 'passive_read') === 'passive_read' && chosenDirection !== defaultDirection) {
      logger.info(`[app.agent] actionPreScrollPlan: overriding LLM direction "${chosenDirection}" to category default "${defaultDirection}" for passive_read (category: ${category})`);
      chosenDirection = defaultDirection;
    }

    return {
      ok: true,
      direction: chosenDirection,
      scrollMode: parsed.scrollMode || 'passive_read',
      stopKeyword: parsed.stopKeyword || '',
      purposeStatement: parsed.purposeStatement || goal,
      maxScrolls: parsed.maxScrolls || maxScrolls || 20
    };
  } catch (err) {
    logger.warn(`[app.agent] actionPreScrollPlan failed: ${err.message}`);
    return { ok: false, direction: CATEGORY_SCROLL_DEFAULTS[category] || 'down', scrollMode: 'passive_read', stopKeyword: '', purposeStatement: goal, maxScrolls: maxScrolls || 20 };
  }
}

async function actionSearchScroll({ scrollPlan, appName, category, scrollCandidates }) {
  const { direction, stopKeyword, purposeStatement, maxScrolls } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, found: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  // ── Step 1: Build candidate scroll regions from boundaries ──────────────────
  // Use in-process boundary cache (dimension-keyed, no DB needed)
  // Try all cached entries for this appName — pick the most recent valid one
  const cacheEntry = _findBoundaryCacheEntry(appName);
  const boundaries = cacheEntry?.boundaries || [];
  const screenHeight = cacheEntry?.screenHeight || 900;
  const screenWidth = cacheEntry?.screenWidth || 1440;
  const appBounds = cacheEntry?.appBounds || null;
  if (boundaries.length > 0) {
    logger.info(`[app.agent] actionSearchScroll: using cached boundaries from ${appName} (${boundaries.length} boundaries)`);
  }

  // Prefer a fresh active-win measurement for scroll-step calculation; fall back to cache.
  // IMPORTANT: only use live bounds if the active window IS the target app (not Electron overlay).
  let liveAppBounds = appBounds;
  try {
    const live = await _getActiveAppBounds();
    if (live && live.height > 100 && _appNameMatches(live.appName, appName)) {
      liveAppBounds = live;
      logger.info(`[app.agent] actionSearchScroll: live appBounds from active-win (${live.appName}) ${live.width}x${live.height}`);
    } else if (live) {
      logger.info(`[app.agent] actionSearchScroll: active window is "${live.appName}" (overlay/other) — using cached appBounds for ${appName}`);
    }
  } catch (_) {}
  const windowHeight = liveAppBounds?.height || screenHeight;
  logger.info(`[app.agent] actionSearchScroll: windowHeight=${windowHeight} (appBounds.height=${liveAppBounds?.height ?? 'n/a'})`);

  // Derive effectiveStopKeyword from purposeStatement via LLM when not explicitly set
  let effectiveStopKeyword = stopKeyword;
  if (!effectiveStopKeyword && purposeStatement) {
    try {
      const derived = (await skillLlmAsk(
        `Scroll goal: "${purposeStatement}"\nWhat single word or short phrase (≤4 words) should appear on screen when this goal is achieved? Reply with ONLY the keyword, nothing else.`
      )).trim().replace(/^["']|["']$/g, '');
      if (derived && derived.length > 0 && derived.length < 50) {
        effectiveStopKeyword = derived;
        logger.info(`[app.agent] actionSearchScroll: LLM-derived stopKeyword "${effectiveStopKeyword}" from purposeStatement`);
      }
    } catch (_) {}
  }

  let candidates = [];

  if (scrollCandidates && scrollCandidates.length > 0) {
    // Caller supplied explicit [cx, cy] pairs — no boundary ref available
    candidates = scrollCandidates.map(c => ({ cx: c[0], cy: c[1], b: null, confidence: 0 }));
  } else if (boundaries.length > 0) {
    // Derive from cached boundaries — score by category schema + layout context
    const scored = _scoreBoundariesForMain(boundaries, category, screenWidth, screenHeight, appBounds)
      .filter(b => b.isMain && !b.isFloating);
    scored.sort((a, z) => z.score - a.score);
    candidates = scored.slice(0, 4)
      .filter(s => Math.round(s.y + s.height / 2) >= 200) // exclude header/toolbar strips (cy<200)
      .map(s => ({
        cx: Math.round(s.x + s.width / 2),
        cy: Math.round(s.y + s.height / 2),
        b: s,
        confidence: s.typeInfo?.confidence || 0,
        inferredType: s.typeInfo?.type || 'unknown'
      }));
  }

  // Append the schema's default center only when no typed candidates were found
  const defaultRegion = inferMainRegion(boundaries, category, appBounds, screenWidth, screenHeight);
  if (candidates.length === 0) {
    candidates.push({ cx: defaultRegion.centerX, cy: defaultRegion.centerY, b: null, confidence: 0 });
  }

  // Sort candidates by purposeStatement intent — prefer the region type that best
  // matches what the user is searching for (messages vs sidebar, etc.)
  if (purposeStatement && candidates.some(c => c.inferredType)) {
    candidates.sort((a, b) =>
      _scrollRegionPriority(b.inferredType, purposeStatement) -
      _scrollRegionPriority(a.inferredType, purposeStatement)
    );
    logger.info(`[app.agent] actionSearchScroll: intent-sorted candidates: ${candidates.map(c => c.inferredType || 'unknown').join(', ')}`);
  }

  // Clamp candidates to the left portion of the screen when appBounds are unavailable.
  // ThinkDrop overlay occupies the right side — any candidate with cx in the overlay
  // region will scroll the overlay panel, not the target app.
  const _maxScrollCandidateX = appBounds ? (appBounds.x + appBounds.width) : Math.round(screenWidth * 0.75);
  const _clampedCandidates = candidates.filter(c => c.cx <= _maxScrollCandidateX);
  if (_clampedCandidates.length > 0) {
    candidates = _clampedCandidates;
    logger.info(`[app.agent] actionSearchScroll: clamped candidates to cx≤${_maxScrollCandidateX} (${candidates.length} remaining)`);
  } else {
    // All candidates were in the overlay — use center-left as safe fallback
    candidates = [{ cx: Math.round(screenWidth * 0.4), cy: Math.round(screenHeight * 0.5), b: null, confidence: 0 }];
    logger.warn(`[app.agent] actionSearchScroll: all candidates beyond overlay threshold — using center-left fallback`);
  }

  // ── Step 2: Probe candidates — skip probe for high-confidence regions ────────
  const _SCROLL_TYPES = ['messages', 'content', 'editor', 'scrollback', 'reading_pane'];
  let activeRegion = null;
  for (const candidate of candidates) {
    const { cx, cy, b, confidence, inferredType } = candidate;
    // High-confidence known scroll panels: trust position, skip OCR-diff probe
    if (b && confidence >= 0.8 && _SCROLL_TYPES.includes(inferredType)) {
      activeRegion = { cx, cy };
      logger.info(`[app.agent] actionSearchScroll: high-confidence region (${inferredType}@${confidence}) at (${cx},${cy}) — skipping probe`);
      break;
    }
    // Low-confidence or unknown: probe with bigger scroll
    const probe = await _probeBoundaryForScroll(cx, cy, direction, nut, purposeStatement);
    if (probe.scrolled && probe.relevant) {
      activeRegion = { cx, cy };
      logger.info(`[app.agent] actionSearchScroll: probe confirmed scroll region at (${cx},${cy})`);
      break;
    }
    if (probe.scrolled && !probe.relevant) {
      logger.info(`[app.agent] actionSearchScroll: (${cx},${cy}) scrolled but content irrelevant for goal — trying next candidate`);
    } else {
      logger.info(`[app.agent] actionSearchScroll: boundary (${cx},${cy}) did not respond, trying next`);
    }
  }

  // ── Step 3: AppleScript keyboard scroll fallback ────────────────────────────
  // When no NutJS candidate was confirmed (all probes rejected or failed),
  // test whether AppleScript Page Up/Down actually moves the screen content.
  // If it does, set useKeyboardScroll=true and enter the real scroll loop
  // using keyboard events instead of NutJS mouse scroll.
  let useKeyboardScroll = false;
  if (!activeRegion) {
    logger.warn('[app.agent] actionSearchScroll: no NutJS region confirmed — probing AppleScript keyboard scroll');
    const { execSync: _execSyncFallback } = require('child_process');
    const _keyCode = direction === 'up' ? '116' : '121'; // Page Up / Page Down
    let _beforeKb = '';
    try {
      const { screenCapture: _scKb } = require('./screen.capture.cjs');
      const _beforeCapKb = await _scKb({});
      _beforeKb = _beforeCapKb.success ? (_beforeCapKb.text || '') : '';
    } catch (_) { _beforeKb = (await getRecentOCR()).text || ''; }
    try {
      _execSyncFallback(`osascript -e 'tell application "${appName}" to activate'`, { timeout: 2000 });
      await _sleep(300);
      _execSyncFallback(`osascript -e 'tell application "System Events" to key code ${_keyCode}'`);
      await _sleep(800);
    } catch (_kbErr) {
      logger.warn(`[app.agent] AppleScript keyboard probe failed: ${_kbErr.message}`);
    }
    let _afterKb = '';
    try {
      const { screenCapture: _scKb2 } = require('./screen.capture.cjs');
      const _afterCapKb = await _scKb2({});
      _afterKb = _afterCapKb.success ? (_afterCapKb.text || '') : '';
    } catch (_) { _afterKb = (await getRecentOCR()).text || ''; }
    const _kbScrolled = _beforeKb !== _afterKb && _afterKb.length > 20;
    if (_kbScrolled) {
      logger.info('[app.agent] actionSearchScroll: AppleScript keyboard scroll works — entering scroll loop in keyboard mode');
      useKeyboardScroll = true;
      activeRegion = { cx: Math.round(screenWidth * 0.4), cy: Math.round(screenHeight * 0.5) };
    } else {
      // Keyboard scroll also failed — truly stuck, surface what we have
      logger.warn('[app.agent] actionSearchScroll: AppleScript keyboard scroll also did not move content — giving up');
      return {
        ok: true, found: false, scrolls: 0,
        stopReason: 'no_scroll_region_found',
        text: _afterKb || _beforeKb
      };
    }
  }

  // ── Step 4: Main scroll loop on confirmed region ────────────────────────────
  // Notify GhostLayer: confirmed scroll region → turn green; others fade out
  _sendHighlightToOverlay({
    type: 'highlight_update',
    cx: activeRegion.cx,
    cy: activeRegion.cy,
    role: 'scroll_active'
  }).catch(() => {});

  // Move mouse to confirmed region once before starting
  try {
    await nut.mouse.move([{ x: activeRegion.cx, y: activeRegion.cy }]);
    await _sleep(150);
  } catch (_) {}

  const { screenCapture: _liveCapture } = require('./screen.capture.cjs');
  // Use cached OCR for most iterations (instant); only do a fresh screenCapture every 3 scrolls
  // This cuts per-iteration time from ~15s (2 full OCR calls) down to ~1s
  const _liveText = async (forceFresh = false) => {
    try {
      if (forceFresh) {
        const r = await _liveCapture({});
        if (r.success) return { text: r.text || '', confidence: r.confidence || 0 };
        const cached = await getRecentOCR();
        return { text: cached.text || '', confidence: 0 };
      }
      const cached = await getRecentOCR();
      return { text: cached.text || '', confidence: cached.confidence || 0 };
    } catch (_) {
      return { text: '', confidence: 0 };
    }
  };

  let scrollCount = 0;
  // Seed lastText from a fresh capture so we have a true pre-scroll baseline
  let { text: lastText, confidence: _lastConf } = await _liveText(true);
  let noChangeStreak = 0;
  // Accumulate OCR snapshots across all scrolls for richer synthesis context
  const scrollJournal = [];
  // Seed journal with the pre-scroll baseline so deduplication has a starting
  // point and accumulatedText always contains at least the opening viewport.
  if (lastText && lastText.length > 20) scrollJournal.push(lastText);
  // Track remaining candidates for mid-loop region switching
  let _candidateIndex = candidates.indexOf(candidates.find(c => c.cx === activeRegion?.cx && c.cy === activeRegion?.cy) || {});
  const _tryNextCandidate = async () => {
    _candidateIndex++;
    const next = candidates[_candidateIndex];
    if (!next) return false;
    activeRegion = { cx: next.cx, cy: next.cy };
    try { await nut.mouse.move([{ x: next.cx, y: next.cy }]); } catch (_) {}
    logger.info(`[app.agent] actionSearchScroll: switched to candidate ${_candidateIndex} at (${next.cx},${next.cy}) after region validation failure`);
    return true;
  };

  // Pre-scroll check: fuzzy-match the stopKeyword against current OCR.
  // Only run when confidence >= 65 — low-confidence OCR misreads digits (e.g. "19"→"18")
  // and would stop the scroll on the wrong date. LLM gate provides the fallback.
  if (effectiveStopKeyword && _lastConf >= 65 && _keywordFuzzyMatchesOCR(effectiveStopKeyword, lastText)) {
    if (purposeStatement) {
      const alreadyMet = await _llmCheckScrollGoalMet(purposeStatement, lastText);
      if (alreadyMet === 'yes') {
        logger.info(`[app.agent] actionSearchScroll: LLM confirmed goal already met — no scroll needed`);
        return { ok: true, found: true, scrolls: 0, stopReason: 'keyword_already_visible', text: lastText };
      }
      logger.info(`[app.agent] actionSearchScroll: fuzzy matched "${effectiveStopKeyword}" but LLM says goal NOT yet met — proceeding with scroll`);
    } else {
      logger.info(`[app.agent] actionSearchScroll: stopKeyword "${effectiveStopKeyword}" already visible — no scroll needed`);
      return { ok: true, found: true, scrolls: 0, stopReason: 'keyword_already_visible', text: lastText };
    }
  }
  // NutJS scroll units are app-defined; Slack needs ~100 units for a half-window scroll.
  // The probe uses 150 and successfully scrolls a full screen — 100 is a safe half-screen.
  const scrollStep = 100;
  logger.info(`[app.agent] actionSearchScroll: scrollStep=${scrollStep} NutJS units (fixed, probe confirmed 150=full-screen)`);

  // Activate target app via AppleScript before scrolling so NutJS events land in the
  // correct window (not in the Electron overlay which may have stolen focus).
  try {
    const { execSync: _execSyncActivate } = require('child_process');
    _execSyncActivate(`osascript -e 'tell application "${appName}" to activate'`, { timeout: 2000 });
    await _sleep(300);
    logger.info(`[app.agent] actionSearchScroll: activated "${appName}" before scroll loop`);
  } catch (_activateErr) {
    logger.warn(`[app.agent] actionSearchScroll: AppleScript activate failed (${_activateErr.message}) — continuing anyway`);
  }

  const _kbKeyCode = direction === 'up' ? '116' : '121'; // Page Up / Page Down
  const { execSync: _execSyncKb } = useKeyboardScroll ? require('child_process') : { execSync: null };

  while (scrollCount < maxScrolls) {
    try {
      if (useKeyboardScroll) {
        // Keyboard scroll mode: send Page Up/Down via AppleScript for each step unit
        const _kbPresses = Math.max(1, Math.ceil(scrollStep / 5));
        for (let _ki = 0; _ki < _kbPresses; _ki++) {
          _execSyncKb(`osascript -e 'tell application "System Events" to key code ${_kbKeyCode}'`);
          await _sleep(80);
        }
      } else {
        if (direction === 'up') await nut.mouse.scrollUp(scrollStep);
        else await nut.mouse.scrollDown(scrollStep);
      }
    } catch (err) {
      return { ok: false, found: false, scrolls: scrollCount, stopReason: 'scroll_error', error: String(err.message || err) };
    }
    // Give the screen time to settle after scroll before reading
    await _sleep(600);

    // Always take a fresh screen capture — stale cache masks whether scroll moved anything
    const { text: currentText, confidence: _curConf } = await _liveText(true);

    // Append to scroll journal if this snapshot contains meaningful new content
    const _lastJournal = scrollJournal[scrollJournal.length - 1] || lastText;
    const _newWordCount = currentText.split(/\s+/).filter(w => w.length > 3 && !_lastJournal.includes(w)).length;
    // Push when >= 3 new unique words appear OR every 4th scroll as a safety net
    // (Slack OCR snapshots overlap ~95% per step so the old >=10 threshold was never met)
    if (_newWordCount >= 3 || scrollCount % 4 === 3) scrollJournal.push(currentText);

    if (effectiveStopKeyword && _curConf >= 65 && _keywordFuzzyMatchesOCR(effectiveStopKeyword, currentText)) {
      // The date divider label (e.g. "Thursday, June 18th") is visible but the actual
      // messages from that date may still be partially below the fold. Do one small
      // extra scroll to bring those messages into view before capturing the final text.
      logger.info(`[app.agent] actionSearchScroll: stopKeyword "${effectiveStopKeyword}" fuzzy-matched — doing one overshoot-correction scroll to bring messages into view`);
      try {
        const _halfStep = Math.max(2, Math.round(scrollStep / 3));
        if (useKeyboardScroll) {
          _execSyncKb(`osascript -e 'tell application "System Events" to key code ${_kbKeyCode}'`);
        } else {
          if (direction === 'up') await nut.mouse.scrollUp(_halfStep);
          else await nut.mouse.scrollDown(_halfStep);
        }
        await _sleep(700);
      } catch (_) {}
      const { text: finalText } = await _liveText(true);
      if (finalText && finalText.length > 20) scrollJournal.push(finalText);
      const accumulatedText = _deduplicateScrollJournal(scrollJournal, finalText || currentText);
      logger.info(`[app.agent] actionSearchScroll: stopKeyword "${effectiveStopKeyword}" found after ${scrollCount + 1} scrolls (journal: ${scrollJournal.length} snapshots, ${accumulatedText.length} chars accumulated)`);
      return { ok: true, found: true, scrolls: scrollCount, stopReason: 'keyword_found', text: finalText || currentText, accumulatedText };
    }

    // After first scroll: validate the region is producing the right type of content.
    // If the region scrolled but content is wrong (e.g. channel names vs messages),
    // switch to the next candidate before continuing.
    if (scrollCount === 0 && purposeStatement && activeRegion) {
      const regionOk = await _llmCheckRegionRelevance(purposeStatement, lastText, currentText);
      if (!regionOk) {
        logger.warn(`[app.agent] actionSearchScroll: first-scroll region validation FAILED — content doesn't match goal, trying next candidate`);
        const switched = await _tryNextCandidate();
        if (!switched) {
          logger.warn(`[app.agent] actionSearchScroll: no more candidates — continuing with current region despite mismatch`);
        }
      } else {
        logger.info(`[app.agent] actionSearchScroll: first-scroll region validation OK — content matches goal`);
      }
    }

    const topBefore = _getTopWords(lastText, 8);
    const topAfter  = _getTopWords(currentText, 8);
    const scrollMoved = topBefore.some(w => !topAfter.includes(w)) || topAfter.some(w => !topBefore.includes(w));
    if (!scrollMoved) {
      noChangeStreak++;
      if (noChangeStreak >= 4) {
        // Soft success — we've hit the content boundary; surface whatever is visible
        return { ok: true, found: false, scrolls: scrollCount, stopReason: 'content_boundary_reached', text: currentText, accumulatedText: _deduplicateScrollJournal(scrollJournal, currentText) };
      }
    } else {
      noChangeStreak = 0;
    }

    if (scrollCount % 3 === 2) {
      try {
        const check = await skillLlmAsk(`
Purpose: ${purposeStatement}
Looking for: "${effectiveStopKeyword || stopKeyword || '(any relevant content)'}"
Accumulated scroll content so far:
${_deduplicateScrollJournal(scrollJournal, null).slice(-800) || currentText.slice(0, 500)}
Current viewport: ${currentText.slice(0, 300)}
Scrolls done: ${scrollCount + 1}/${maxScrolls}
Respond with exactly one word: FOUND, KEEP_SCROLLING, or GIVE_UP`);
        const answer = check.trim().toUpperCase();
        if (answer === 'FOUND') return { ok: true, found: true, scrolls: scrollCount, stopReason: 'llm_confirmed', text: currentText, accumulatedText: _deduplicateScrollJournal(scrollJournal, currentText) };
        if (answer === 'GIVE_UP') return { ok: true, found: false, scrolls: scrollCount, stopReason: 'llm_gave_up', text: currentText, accumulatedText: _deduplicateScrollJournal(scrollJournal, currentText) };
      } catch (_) {}
    }

    lastText = currentText;
    scrollCount++;
  }
  return { ok: true, found: false, scrolls: scrollCount, stopReason: 'max_scrolls_exhausted', text: lastText, accumulatedText: _deduplicateScrollJournal(scrollJournal, lastText) };
}

async function actionAiResponseScroll({ scrollPlan, appName, category }) {
  const { stopKeyword, purposeStatement, maxScrolls } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, found: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  const cacheEntry = _findBoundaryCacheEntry(appName);
  const boundaries = cacheEntry?.boundaries || [];
  const mainRegion = inferMainRegion(boundaries, category, cacheEntry?.appBounds, cacheEntry?.screenWidth || 1440, cacheEntry?.screenHeight || 900);
  let scrollCount = 0;

  while (scrollCount < maxScrolls) {
    await _sleep(5000);
    const currentOCR = await getRecentOCR();

    try {
      const stateResult = await skillLlmAsk(`
Purpose: ${purposeStatement}
Looking for: "${stopKeyword}"
App: ${appName}
Screen: ${currentOCR.text.slice(0, 600)}

What is the AI/app doing right now?
GENERATING | QUESTION | APPROVE | MORE_CONTENT | COMPLETE | STUCK

If QUESTION: include the question text.
If APPROVE: include the button label.

Return JSON only: { "state": "...", "detail": "..." }`);

      let parsed;
      try {
        parsed = JSON.parse(stateResult.replace(/```json|```/g, '').trim());
      } catch (_) {
        parsed = { state: 'GENERATING', detail: '' };
      }

      if (parsed.state === 'COMPLETE') return { ok: true, found: true, stopReason: 'ai_complete' };
      if (parsed.state === 'GENERATING') continue;

      if (parsed.state === 'QUESTION') {
        logger.info(`[app.agent] AI asked question: ${parsed.detail}`);
        continue;
      }

      if (parsed.state === 'MORE_CONTENT') {
        try {
          await nut.mouse.move([{ x: mainRegion.centerX, y: mainRegion.centerY }]);
          await _sleep(200);
          await nut.mouse.scrollDown(3);
          await _sleep(500);
          scrollCount++;
        } catch (_) {}
        continue;
      }

      if (parsed.state === 'STUCK') return { ok: false, found: false, stopReason: 'ai_stuck' };
      if (parsed.state === 'APPROVE') {
        logger.info(`[app.agent] AI needs approval: ${parsed.detail}`);
        continue;
      }
    } catch (_) {}
  }
  return { ok: false, stopReason: 'max_scrolls_exhausted' };
}

async function actionScroll({ goal, appName, windowTitle, category, maxScrolls = 20 }) {
  const scrollPlan = await actionPreScrollPlan({ goal, appName, category, maxScrolls });

  if (scrollPlan.scrollMode === 'search') {
    return await actionSearchScroll({ scrollPlan, appName, windowTitle, category });
  }

  if (scrollPlan.scrollMode === 'ai_response') {
    return await actionAiResponseScroll({ scrollPlan, appName, windowTitle, category });
  }

  if (scrollPlan.scrollMode === 'live_chat') {
    return await actionLiveChatScroll({ scrollPlan, appName, windowTitle, category });
  }

  if (scrollPlan.scrollMode === 'passive_read') {
    return await actionPassiveReadScroll({ scrollPlan, appName, windowTitle, category });
  }

  return await actionSearchScroll({ scrollPlan, appName, windowTitle, category });
}

async function actionLiveChatScroll({ scrollPlan, appName, windowTitle, category }) {
  const { stopKeyword, purposeStatement, maxScrolls = 60 } = scrollPlan;
  const sessionId = `live_chat_${appName}_${Date.now()}`;

  return new Promise((resolve) => {
    let resolved = false;
    const maxWaitMs = maxScrolls * 5000;

    const onNewContent = async (lines) => {
      if (resolved) return;
      const joined = lines.join('\n');
      logger.info(`[app.agent] watchMode newContent: ${joined.slice(0, 100)}`);

      // Fast path: keyword match
      if (stopKeyword && joined.toLowerCase().includes(stopKeyword.toLowerCase())) {
        resolved = true;
        try {
          const monSvc = require('../monitor/monitorService');
          if (monSvc && monSvc.deactivateWatchMode) monSvc.deactivateWatchMode(sessionId);
        } catch (_) {}
        resolve({ ok: true, found: true, stopReason: 'keyword_found', content: joined });
        return;
      }

      // Semantic path: LLM checks if purposeStatement goal is satisfied by new content
      if (purposeStatement) {
        try {
          const check = await skillLlmAsk(
            `Goal: "${purposeStatement}"\nNew content received:\n${joined.slice(0, 400)}\nDoes this content satisfy the goal? Reply with exactly one word: YES or NO`
          );
          if (check.trim().toUpperCase() === 'YES') {
            resolved = true;
            try {
              const monSvc = require('../monitor/monitorService');
              if (monSvc && monSvc.deactivateWatchMode) monSvc.deactivateWatchMode(sessionId);
            } catch (_) {}
            resolve({ ok: true, found: true, stopReason: 'llm_confirmed', content: joined });
          }
        } catch (_) {}
      }
    };

    const onTimeout = () => {
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, found: false, stopReason: 'timeout' });
      }
    };

    try {
      const monSvc = require('../monitor/monitorService');
      if (monSvc && monSvc.activateWatchMode) {
        monSvc.activateWatchMode({
          sessionId,
          appName,
          baselineOCR: '',
          stopKeyword,
          maxWaitMs,
          autoScrollMs: 0,
          onNewContent,
          onTimeout
        });
      } else {
        resolve({ ok: false, stopReason: 'monitor_service_unavailable' });
      }
    } catch (err) {
      resolve({ ok: false, stopReason: 'error', error: err.message });
    }
  });
}

async function actionPassiveReadScroll({ scrollPlan, appName, category }) {
  const direction = scrollPlan?.direction || CATEGORY_SCROLL_DEFAULTS[category] || 'down';
  const { stopKeyword, purposeStatement, maxScrolls = 30 } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  const cacheEntry = _findBoundaryCacheEntry(appName);
  const boundaries = cacheEntry?.boundaries || [];
  const screenHeight = cacheEntry?.screenHeight || 900;

  // Prefer a fresh active-win measurement for scroll-step calculation; fall back to cache.
  // Only use live bounds if the active window IS the target app (not Electron overlay).
  let liveAppBounds = cacheEntry?.appBounds || null;
  try {
    const live = await _getActiveAppBounds();
    if (live && live.height > 100 && _appNameMatches(live.appName, appName)) {
      liveAppBounds = live;
    } else if (live) {
      logger.info(`[app.agent] actionPassiveReadScroll: active window is "${live.appName}" — using cached appBounds for ${appName}`);
    }
  } catch (_) {}
  const windowHeight = liveAppBounds?.height || screenHeight;

  // Half-window scroll: 1 NutJS scroll unit ≈ 20px at macOS default speed
  const PIXELS_PER_NUT_UNIT = 20;
  const scrollStep = Math.max(3, Math.round((windowHeight / 2) / PIXELS_PER_NUT_UNIT));
  logger.info(`[app.agent] actionPassiveReadScroll: direction=${direction}, scrollStep=${scrollStep} NutJS units (windowHeight=${windowHeight}px)`);

  const mainRegion = inferMainRegion(boundaries, category, liveAppBounds, cacheEntry?.screenWidth || 1440, screenHeight);
  let scrollCount = 0;
  const accumulatedText = [];

  // For bottom-to-top categories, jump to the bottom of the content first so we
  // start with the newest text and accumulate history as we scroll up.
  if (direction === 'up' && appName) {
    try {
      logger.info(`[app.agent] actionPassiveReadScroll: jumping to bottom of ${appName} before scrolling up`);
      let jump = await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+End', skipFocusCheck: true });
      if (!jump.ok) {
        jump = await actionExecuteShortcut({ appName, shortcutOverride: 'Ctrl+End', skipFocusCheck: true });
      }
      await _sleep(jump.ok ? 400 : 200);
    } catch (err) {
      logger.warn(`[app.agent] actionPassiveReadScroll: jump-to-bottom failed (${err.message}), continuing from current position`);
    }
  }

  try {
    await nut.mouse.move([{ x: mainRegion.centerX, y: mainRegion.centerY }]);
    await _sleep(200);
  } catch (_) {}

  const { screenCapture: _passiveCapture } = require('./screen.capture.cjs');
  const _freshText = async () => {
    try {
      const r = await _passiveCapture({});
      return r.success ? (r.text || '') : (await getRecentOCR()).text || '';
    } catch (_) { return (await getRecentOCR()).text || ''; }
  };

  while (scrollCount < maxScrolls) {
    // Always fresh OCR so we read what is actually on screen now
    const currentText = await _freshText();
    if (currentText) accumulatedText.push(currentText);

    if (stopKeyword && currentText.toLowerCase().includes(stopKeyword.toLowerCase())) {
      const resultText = accumulatedText.join('\n');
      return { ok: true, found: true, stopReason: 'keyword_found', scrolls: scrollCount, text: resultText, accumulatedText: resultText };
    }

    const topWordsBefore = currentText.split(/\s+/).slice(0, 5);

    try {
      if (direction === 'up') {
        await nut.mouse.scrollUp(scrollStep);
      } else {
        await nut.mouse.scrollDown(scrollStep);
      }
      await _sleep(700);
    } catch (_) {}
    scrollCount++;

    const afterText = await _freshText();
    const topWordsAfter = afterText.split(/\s+/).slice(0, 5);
    const scrollOccurred = topWordsBefore.some(w => w.length > 3 && !topWordsAfter.includes(w));

    if (!scrollOccurred && scrollCount > 2) {
      const resultText = accumulatedText.join('\n');
      return { ok: true, found: false, stopReason: 'end_of_content', scrolls: scrollCount, text: resultText, accumulatedText: resultText };
    }
  }

  const resultText = accumulatedText.join('\n');
  return { ok: true, found: false, stopReason: 'max_scrolls_exhausted', scrolls: scrollCount, text: resultText, accumulatedText: resultText };
}

async function actionTeleportToElement({ searchText, followWithTab = false }) {
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, error: 'NutJS unavailable: ' + err.message };
  }

  const beforeOCR = await getRecentOCR();

  try {
    const { Key } = nut;
    await nut.keyboard.pressKey(Key.LeftSuper, Key.F);
    await nut.keyboard.releaseKey(Key.LeftSuper, Key.F);
    await _sleep(300);

    await nut.keyboard.type(searchText);
    await _sleep(300);

    await nut.keyboard.pressKey(Key.Escape);
    await nut.keyboard.releaseKey(Key.Escape);
    await _sleep(200);

    if (followWithTab) {
      await nut.keyboard.pressKey(Key.Tab);
      await nut.keyboard.releaseKey(Key.Tab);
      await _sleep(100);
    }
  } catch (err) {
    return { ok: false, error: `Keyboard error: ${err.message}` };
  }

  const afterOCR = await getRecentOCR();
  const anchorVisible = afterOCR.text.toLowerCase().includes(searchText.toLowerCase());

  return {
    ok: anchorVisible,
    anchoredAt: searchText,
    verified: anchorVisible,
    beforeSnapshot: beforeOCR.text.slice(0, 200),
    afterSnapshot: afterOCR.text.slice(0, 200)
  };
}

async function actionSearchAndClick({ searchText, appName, category, maxMatches = 3, fallbackToKeyboard = true, signal }) {
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, error: 'NutJS unavailable: ' + err.message };
  }

  if (!searchText) {
    return { ok: false, error: 'searchText is required' };
  }

  if (category && category !== 'browser') {
    logger.warn(`[app.agent] search_and_click is designed for browser category; received category=${category}. Proceeding with caution.`);
  }

  // Hard timeout and abort handling so a timed-out HTTP request does not leave
  // a runaway skill loop running in the command service.
  const MAX_SEARCH_AND_CLICK_MS = 45000;
  const controller = new AbortController();
  const startMs = Date.now();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => { try { controller.abort(); } catch (_) {} }, { once: true });
  }
  const _isExpired = () => Date.now() - startMs > MAX_SEARCH_AND_CLICK_MS;
  const _checkAbort = (label) => {
    if (signal?.aborted || controller.signal.aborted || _isExpired()) {
      logger.info(`[app.agent] search_and_click: aborting at ${label} (elapsed=${Date.now() - startMs}ms)`);
      if (!controller.signal.aborted) controller.abort();
      throw new Error(`search_and_click aborted or timed out after ${Date.now() - startMs}ms`);
    }
  };
  const _isAbortError = (err) => err && err.message && (err.message.includes('timed out') || err.message.includes('aborted'));

  if (appName) {
    _checkAbort('before_verify_app_focus');
    const focus = await verifyAppFocused({ appName, waitMs: 5000 });
    if (!focus.focused) {
      return { ok: false, error: `App "${appName}" could not be focused` };
    }
  }

  // Generate progressively shorter search variants from the original phrase
  // down to two words. This handles cases where the user phrase includes a
  // trailing word that is not actually present on screen (e.g. "channel").
  const _buildSearchVariants = (text) => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const variants = [];
    for (let i = words.length; i >= 2; i--) {
      variants.push(words.slice(0, i).join(' '));
    }
    return variants;
  };
  const searchVariants = _buildSearchVariants(searchText);
  logger.info(`[app.agent] search_and_click: searchText="${searchText}" variants=${JSON.stringify(searchVariants)}`);

  // Capture a fresh baseline before any UI interaction so we compare against
  // the real screen state, not a stale DB cache. Hide the ThinkDrop overlay
  // so its own UI text doesn't taint the OCR comparison.
  const _captureFreshOCR = async () => {
    _checkAbort('before_capture');
    const { screenCapture } = require('./screen.capture.cjs');
    const live = await _withCaptureWindow(() => screenCapture({}));
    if (live.success && live.text) {
      return {
        text: live.text,
        appName: live.appName || appName || null,
        windowTitle: live.windowTitle || null,
        timestamp: new Date().toISOString(),
        available: true,
        source: 'live'
      };
    }
    return getRecentOCR({ appName, liveOverlayHidden: true });
  };

  _checkAbort('before_baseline');
  const baselineOCR = await _captureFreshOCR();
  const baselineText = baselineOCR.text || '';
  logger.info(`[app.agent] search_and_click: baseline captured (${baselineText.length} chars, source: ${baselineOCR.source || 'unknown'})`);

  const _normalized = (text) => (text || '').toLowerCase().replace(/\s+/g, ' ').trim();

  // Compare post-click OCR against the baseline. A successful click opens new
  // UI content, which shows up as: (1) the post-click text is at least 10 chars
  // longer than the baseline, and (2) at least one new meaningful word not present
  // in the baseline. We require a net gain (not just any change) to avoid false
  // positives when a click removes or swaps content without opening the target.
  const _detectStateChangeAgainstBaseline = async (afterTextRaw) => {
    const afterText = afterTextRaw || '';
    const baselineNorm = _normalized(baselineText);
    const afterNorm = _normalized(afterText);

    if (baselineNorm === afterNorm) {
      return { changed: false, afterText, reason: 'identical_to_baseline' };
    }

    const charDiff = afterNorm.length - baselineNorm.length;
    if (charDiff < 10) {
      return { changed: false, afterText, reason: 'char_gain_below_threshold' };
    }

    // Look for new meaningful words (>3 chars, containing at least one letter).
    const baselineWords = new Set(
      baselineNorm.split(/\s+/).filter(w => w.length > 3 && /[a-z]/.test(w))
    );
    const afterWords = afterNorm.split(/\s+/).filter(w => w.length > 3 && /[a-z]/.test(w));
    const newWords = afterWords.filter(w => !baselineWords.has(w));

    if (newWords.length === 0) {
      return { changed: false, afterText, reason: 'no_new_meaningful_words' };
    }

    return { changed: true, afterText, newWords };
  };

  // Discovery phase: find the longest variant that has at least one OCR match.
  // Returns { variant, matches, variantIndex } or { variant: null } if none match.
  const _findBestVariant = async () => {
    for (let variantIndex = 0; variantIndex < searchVariants.length; variantIndex++) {
      const variant = searchVariants[variantIndex];
      logger.info(`[app.agent] search_and_click: searching variant ${variantIndex + 1}/${searchVariants.length} "${variant}"`);
      _checkAbort(`before_find_variant_${variantIndex}`);

      try {
        const parseResult = await _withCaptureWindow(() => actionParseScreenshot({}));
        if (parseResult.ok && parseResult.textItems && parseResult.textItems.length > 0) {
          const findResult = await actionFindElements({ searchText: variant, textItems: parseResult.textItems, highlight: false });
          if (findResult.ok && findResult.matches.length > 0) {
            // Variants are ordered from longest to shortest, so the first match is the longest.
            logger.info(`[app.agent] search_and_click: selected longest matching variant "${variant}" with ${findResult.matches.length} match(es)`);
            return { variant, matches: findResult.matches, variantIndex };
          }
        }
        logger.info(`[app.agent] search_and_click: no OCR matches for variant "${variant}"`);
      } catch (err) {
        if (_isAbortError(err)) throw err;
        logger.warn(`[app.agent] search_and_click: error finding variant "${variant}": ${err.message}`);
      }
    }
    return { variant: null, matches: null, variantIndex: -1 };
  };

  // Click the matches of the selected variant. Returns { ok: true, ... } on success.
  const _clickMatches = async (variant, matches) => {
    const clickMatches = matches.slice(0, 20);
    logger.info(`[app.agent] search_and_click: clicking ${clickMatches.length} match(es) for "${variant}"`);
    for (let matchIndex = 0; matchIndex < clickMatches.length; matchIndex++) {
      const match = clickMatches[matchIndex];
      const centerX = Math.round(match.x + (match.width || 0) / 2);
      const centerY = Math.round(match.y + (match.height || 0) / 2);

      logger.info(`[app.agent] search_and_click: mouse click trying match ${matchIndex + 1}/${clickMatches.length} at (${centerX}, ${centerY}) for "${variant}"`);
      _checkAbort(`mouse_click_${matchIndex}`);
      await nut.mouse.move([{ x: centerX, y: centerY }]);
      await _sleep(200, controller.signal);
      await nut.mouse.leftClick();
      await _sleep(800, controller.signal);

      const afterMouse = await _captureFreshOCR();
      const mouseResult = await _detectStateChangeAgainstBaseline(afterMouse.text);
      logger.info(`[app.agent] search_and_click: mouse click match ${matchIndex + 1} for "${variant}" state change=${mouseResult.changed}${mouseResult.reason ? ` (${mouseResult.reason})` : ''}`);
      if (mouseResult.changed) {
        return {
          ok: true,
          matchIndex: matchIndex + 1,
          method: 'mouse_click',
          stateChanged: true,
          afterText: mouseResult.afterText.slice(0, 200)
        };
      }
    }
    logger.info(`[app.agent] search_and_click: mouse click tried ${clickMatches.length} matches for "${variant}" without state change`);
    return { ok: false };
  };

  // Keyboard find-bar path for a single variant.
  const _tryKeyboardPath = async (variant) => {
    logger.info(`[app.agent] search_and_click: trying keyboard fallback for "${variant}"`);
    try {
      _checkAbort('before_keyboard_open');
      // Open browser find bar and type the search variant.
      await nut.keyboard.pressKey(Key.LeftSuper, Key.F);
      await nut.keyboard.releaseKey(Key.LeftSuper, Key.F);
      await _sleep(500, controller.signal);

      await nut.keyboard.type(variant);
      await _sleep(500, controller.signal);

      // Cycle through find-bar matches.
      for (let matchIndex = 1; matchIndex <= maxMatches; matchIndex++) {
        _checkAbort(`keyboard_match_${matchIndex}`);
        logger.info(`[app.agent] search_and_click: keyboard fallback trying match ${matchIndex}/${maxMatches} for "${variant}"`);

        // Select the next match.
        await nut.keyboard.pressKey(Key.Enter);
        await nut.keyboard.releaseKey(Key.Enter);
        await _sleep(200, controller.signal);

        // Close the find bar while keeping the page highlight.
        await nut.keyboard.pressKey(Key.Escape);
        await nut.keyboard.releaseKey(Key.Escape);
        await _sleep(300, controller.signal);

        // Activate the highlighted element (link/button).
        await nut.keyboard.pressKey(Key.Enter);
        await nut.keyboard.releaseKey(Key.Enter);
        await _sleep(800, controller.signal);

        const afterClick = await _captureFreshOCR();
        const result = await _detectStateChangeAgainstBaseline(afterClick.text);
        logger.info(`[app.agent] search_and_click: keyboard fallback match ${matchIndex} for "${variant}" state change=${result.changed}${result.reason ? ` (${result.reason})` : ''}`);
        if (result.changed) {
          return { ok: true, matchIndex, method: 'find_bar_enter', stateChanged: true, afterText: result.afterText.slice(0, 200) };
        }

        // Reopen the find bar for the next match if there are more attempts.
        if (matchIndex < maxMatches) {
          await nut.keyboard.pressKey(Key.LeftSuper, Key.F);
          await nut.keyboard.releaseKey(Key.LeftSuper, Key.F);
          await _sleep(300, controller.signal);
        }
      }

      // Ensure the find bar is closed.
      await nut.keyboard.pressKey(Key.Escape);
      await nut.keyboard.releaseKey(Key.Escape);
      await _sleep(200, controller.signal);

      return { ok: false, found: false, tried: maxMatches };
    } catch (err) {
      if (_isAbortError(err)) throw err;
      logger.warn(`[app.agent] search_and_click: keyboard path error for "${variant}": ${err.message}`);
      return { ok: false, error: `Keyboard error during search_and_click: ${err.message}` };
    }
  };

  const { Key } = nut;

  try {
    const best = await _findBestVariant();
    if (!best.variant || !best.matches || best.matches.length === 0) {
      return { ok: false, needsManualStep: true, error: `Could not find "${searchText}" on screen. Tried variants: ${searchVariants.join(' → ')}. Please rephrase or point to the target.` };
    }

    _checkAbort(`before_click_variant_${best.variantIndex}`);
    // Show the boundary highlight for the selected variant before clicking.
    await actionHighlightElements({ elements: best.matches.slice(0, 20), duration: 0, color: '#ff0000' });

    const clickResult = await _clickMatches(best.variant, best.matches);
    if (clickResult.ok) return clickResult;

    if (fallbackToKeyboard) {
      _checkAbort(`before_keyboard_variant_${best.variantIndex}`);
      const keyboardResult = await _tryKeyboardPath(best.variant);
      if (keyboardResult.ok) return keyboardResult;
    }

    return { ok: false, needsManualStep: true, error: `Found "${best.variant}" on screen but clicking it did not change the page state. Please rephrase or point to the target.` };
  } catch (err) {
    if (signal?.aborted || controller.signal.aborted || err.message.includes('timed out') || err.message.includes('aborted')) {
      return { ok: false, aborted: true, error: err.message };
    }
    return { ok: false, error: `Error during search_and_click: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Semantic Embedding Helpers
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns 1.0 for identical vectors, 0.0 for orthogonal.
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Compute simple embedding from text (fallback when embedding service unavailable).
 * Uses character n-gram frequency vector.
 */
function computeSimpleEmbedding(text, dims = 128) {
  const vector = new Array(dims).fill(0);
  if (!text) return vector;
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < trigram.length; j++) {
      hash = ((hash << 5) - hash) + trigram.charCodeAt(j);
      hash = hash & hash;
    }
    const idx = Math.abs(hash) % dims;
    vector[idx] += 1;
  }
  // Normalize
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vector.map(v => v / norm) : vector;
}

async function actionMonitorWithBackoff({ goal, mode = 'passive', maxDurationMs = 300000, appName, useSemanticComparison = true, signal = null }) {
  // ── Single-flight: abort any monitor still running before starting a new one.
  // Guarantees only one loop captures the screen even if a socket 'close' was
  // missed or recoverSkill relaunched a monitor concurrently.
  if (_activeMonitorController) {
    try { _activeMonitorController.abort(); } catch (_) {}
    logger.warn('[app.agent] Monitor: aborting previous in-flight monitor before starting new one');
  }
  const controller = new AbortController();
  _activeMonitorController = controller;
  // Link the incoming HTTP signal so a client timeout (socket destroy) aborts us.
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => { try { controller.abort(); } catch (_) {} }, { once: true });
  }
  const monitorSignal = controller.signal;

  try {
  const startTime = Date.now();
  let baseline = await getRecentOCR({ appName, liveOverlayHidden: true });
  let checkInterval = 10000;
  let llmCalls = 0;
  const MAX_LLM_CALLS = 20; // Phase 3 success criteria: <20 LLM calls for 10-min tasks
  let focusCheckCount = 0;
  const FOCUS_CHECK_INTERVAL = 3; // Check focus every 3rd iteration

  // Compute baseline embedding
  let baselineEmbedding = useSemanticComparison ? computeSimpleEmbedding(baseline.text) : null;

  // Stability-as-completion state. For "wait until the AI finishes responding"
  // goals the DONE signal is the screen going *stable*, not changing — so we
  // must trigger a completion check on stability, not back off forever.
  let stableCount = 0;
  let sawProgress = false;
  const STABLE_POLLS_FOR_COMPLETION = 2;

  // Live-UI tolerance: agents like Devin keep spinners/elapsed-timers ticking, so
  // OCR similarity rarely hits 0.95 even when the answer is done. Treat similarity
  // above a slightly lower threshold as "settled" so jitter doesn't block forever.
  const CHANGE_THRESHOLD = 0.90;

  // Time-cadence completion check: regardless of change/stability, ask the LLM
  // "has it finished?" every ~35s (still capped by MAX_LLM_CALLS). This catches
  // done-states that never go fully stable because of animated UI.
  const LLM_CADENCE_MS = 35000;
  let lastLlmCheckTime = 0;

  // Concrete completion cues for the LLM — concise, agent-agnostic but tuned for
  // assistant/agent UIs (Devin, ChatGPT, etc.).
  const COMPLETION_CUES = `Signals the task is FINISHED: the input box is ready/enabled again, there is NO "thinking"/"working"/"running"/"generating" spinner or progress indicator, no elapsed/“running for …” timer is still counting, and a complete answer or result block is present. Signals it is STILL PENDING: a spinner, a "Stop"/"Cancel" button, streaming text, or a live elapsed timer.`;

  // Each OCR capture can take 10–14s (OmniParser), so a too-small caller timeout
  // (e.g. a 20s step timeout) would fire before even one poll completes. Enforce
  // a floor so the monitor always gets enough wall-clock to observe completion.
  const MIN_MONITOR_DURATION_MS = 180000; // 3 min
  const effectiveMaxDuration = Math.max(Number(maxDurationMs) || 0, MIN_MONITOR_DURATION_MS);

  while (Date.now() - startTime < effectiveMaxDuration) {
    if (monitorSignal.aborted) {
      logger.info('[app.agent] Monitor: aborted (client disconnected / superseded) — stopping loop');
      return { ok: false, aborted: true, llmCalls, elapsed: Date.now() - startTime };
    }
    await _sleep(checkInterval, monitorSignal);
    if (monitorSignal.aborted) {
      logger.info('[app.agent] Monitor: aborted during sleep — stopping loop');
      return { ok: false, aborted: true, llmCalls, elapsed: Date.now() - startTime };
    }
    focusCheckCount++;
    
    // Periodically verify app focus if appName is provided
    if (appName && focusCheckCount % FOCUS_CHECK_INTERVAL === 0) {
      logger.debug(`[app.agent] actionMonitorWithBackoff: checking focus for "${appName}" (check #${focusCheckCount})`);
      const focusResult = await verifyAppFocused({ appName, waitMs: 2000 });
      
      if (!focusResult.focused) {
        logger.warn(`[app.agent] actionMonitorWithBackoff: app "${appName}" lost focus (detected: "${focusResult.appName}"), attempting to refocus`);
        
        // Try to refocus the app
        try {
          const { execSync } = require('child_process');
          execSync(`open -a "${appName}"`, { timeout: 3000 });
          await _sleep(1000); // Give it time to focus
          
          // Verify refocus was successful
          const refocusResult = await verifyAppFocused({ appName, waitMs: 2000 });
          if (refocusResult.focused) {
            logger.info(`[app.agent] actionMonitorWithBackoff: successfully refocused "${appName}"`);
          } else {
            logger.warn(`[app.agent] actionMonitorWithBackoff: failed to refocus "${appName}" (still: "${refocusResult.appName}")`);
          }
        } catch (err) {
          logger.error(`[app.agent] actionMonitorWithBackoff: error trying to refocus "${appName}": ${err.message}`);
        }
      }
    }
    
    const current = await getRecentOCR({ appName, liveOverlayHidden: true });

    if (!current.text || current.text.trim().length < 10) {
      // Empty/low-confidence capture is likely a transient capture failure.
      // Retry quickly rather than treating the screen as "stable" and backing off.
      logger.warn('[app.agent] Monitor: empty or low-confidence OCR, retrying capture quickly');
      checkInterval = 3000;
      continue;
    }

    // ── Time-cadence completion check ──────────────────────────────────────
    // Live-UI agents (Devin etc.) keep animating, so neither the change nor the
    // stability path may ever fire a completion check. Independently of those,
    // ask "is it finished?" every ~35s (capped by MAX_LLM_CALLS) so a done-state
    // hidden behind a ticking timer is still detected before timeout.
    if (sawProgress && llmCalls < MAX_LLM_CALLS && (Date.now() - lastLlmCheckTime) >= LLM_CADENCE_MS) {
      lastLlmCheckTime = Date.now();
      try {
        llmCalls++;
        const result = await skillLlmAsk(`
You are monitoring app "${appName || 'unknown'}" to determine if a long-running task has finished.
Goal: ${goal}

${COMPLETION_CUES}

Current screen:
${current.text.slice(0, 1800)}

Return JSON: { "status": "complete|pending|error", "summary": "..." }`);
        let parsed;
        try { parsed = JSON.parse(result.replace(/```json|```/g, '').trim()); }
        catch (_) { parsed = { status: 'pending', summary: 'cadence check unparseable' }; }
        if (parsed.status === 'complete') {
          logger.info(`[app.agent] Monitor: cadence completion confirmed — ${parsed.summary}`);
          return { ok: true, summary: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
        }
        if (parsed.status === 'error') {
          return { ok: false, error: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
        }
      } catch (_) {}
      if (monitorSignal.aborted) {
        return { ok: false, aborted: true, llmCalls, elapsed: Date.now() - startTime };
      }
    }

    // Did the screen change meaningfully since the last baseline?
    let changed;
    if (useSemanticComparison && baselineEmbedding) {
      const currentEmbedding = computeSimpleEmbedding(current.text);
      const similarity = cosineSimilarity(baselineEmbedding, currentEmbedding);
      changed = similarity <= CHANGE_THRESHOLD;
      if (changed) baselineEmbedding = currentEmbedding;
    } else {
      changed = current.text !== baseline.text;
    }

    if (!changed) {
      // Screen is STABLE. For "wait until the AI finishes responding" goals this
      // is the completion signal — not a reason to keep backing off forever (the
      // old bug: it only ever consulted the LLM on CHANGE, so the stable
      // end-state was never evaluated → guaranteed timeout). After a couple of
      // stable polls (and once the response has actually started, i.e. we saw a
      // change), ask the LLM whether the goal is now complete.
      stableCount++;
      const shouldCheckCompletion =
        stableCount >= STABLE_POLLS_FOR_COMPLETION &&
        (sawProgress || stableCount >= STABLE_POLLS_FOR_COMPLETION * 2) &&
        llmCalls < MAX_LLM_CALLS;

      if (shouldCheckCompletion) {
        stableCount = 0; // reset so we re-accumulate stability before re-checking (rate-limits LLM)
        lastLlmCheckTime = Date.now(); // count this toward the cadence budget too
        try {
          llmCalls++;
          const result = await skillLlmAsk(`
The screen for app "${appName || 'unknown'}" has stopped changing.
Goal: ${goal}

${COMPLETION_CUES}

Current screen:
${current.text.slice(0, 1800)}

Has the goal been achieved / has the response finished? Or is it still loading, in progress, or showing an error?
If the screen text is jumbled, incomplete, or unclear, do NOT return "error" — return "pending" so the system can retry the capture. Only return "error" if you can clearly identify an actual failure state.
Return JSON: { "status": "complete|pending|error", "summary": "..." }`);
          let parsed;
          try { parsed = JSON.parse(result.replace(/```json|```/g, '').trim()); }
          catch (_) { parsed = { status: 'pending', summary: 'Screen stable but response unparseable' }; }

          if (parsed.status === 'complete') {
            logger.info(`[app.agent] Monitor: stability completion confirmed — ${parsed.summary}`);
            return { ok: true, summary: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
          }
          if (parsed.status === 'error') {
            return { ok: false, error: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
          }
          logger.debug(`[app.agent] Monitor: screen stable but still pending — ${parsed.summary}`);
        } catch (_) {}
      }

      // Still waiting — back off and keep polling.
      checkInterval = mode === 'active'
        ? Math.min(checkInterval * 1.2, 30000)
        : Math.min(checkInterval * 1.5, 60000);
      continue;
    }

    // Screen changed → the task is actively progressing.
    sawProgress = true;
    stableCount = 0;

    // Rate limit LLM calls for long-running tasks
    if (llmCalls >= MAX_LLM_CALLS) {
      logger.warn(`[app.agent] Monitor hit LLM call limit (${MAX_LLM_CALLS}), switching to text-only mode`);
      useSemanticComparison = false;
    }

    try {
      llmCalls++;
      const result = await skillLlmAsk(`
Compare these two screen states.
Goal: ${goal}
App: ${appName || 'unknown'}

Before:
${baseline.text.slice(0, 1500)}

After:
${current.text.slice(0, 1500)}

Has the goal been achieved? Is there an error? Is progress being made?
If the screen text is jumbled, incomplete, or unclear, do NOT return "error" — return "pending" so the system can retry the capture. Only return "error" if you can clearly identify an actual failure state (error message, crash, or the task cannot continue).
Return JSON: { "status": "complete|progress|error|stalled", "summary": "..." }`);

      let parsed;
      try {
        parsed = JSON.parse(result.replace(/```json|```/g, '').trim());
      } catch (_) {
        parsed = { status: 'progress', summary: 'Screen changed' };
      }

      if (parsed.status === 'complete') {
        return { ok: true, summary: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
      }
      if (parsed.status === 'error') {
        return { ok: false, error: parsed.summary, llmCalls, elapsed: Date.now() - startTime };
      }
      if (parsed.status === 'progress') {
        // Reset interval on meaningful progress
        checkInterval = 10000;
        baseline = current;
        if (useSemanticComparison) {
          baselineEmbedding = computeSimpleEmbedding(current.text);
        }
      }
    } catch (_) {}
  }

  return { ok: false, error: 'Monitoring timeout', llmCalls, elapsed: Date.now() - startTime };
  } finally {
    // Release the single-flight slot only if we still own it (a newer monitor
    // may have replaced us via the abort-previous path above).
    if (_activeMonitorController === controller) _activeMonitorController = null;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Additional Monitoring Use Cases
// ---------------------------------------------------------------------------

/**
 * Monitor for file upload completion.
 * Detects upload progress bars, percentage indicators, and completion messages.
 */
async function actionMonitorFileUpload({ uploadIndicator, successIndicator, maxDurationMs = 300000, appName, signal = null }) {
  const UPLOAD_KEYWORDS = ['upload', 'uploading', 'progress', '%', 'transfer', 'sent'];
  const COMPLETION_KEYWORDS = ['complete', 'done', 'uploaded', 'finished', 'success', 'checkmark', '✓'];
  const FAILURE_KEYWORDS = ['failed', 'error', 'retry', 'cancelled', 'network error', 'timed out'];

  return actionMonitorWithBackoff({
    goal: `Wait for file upload to complete. Current indicator: "${uploadIndicator || 'upload in progress'}". Success indicator: "${successIndicator || 'upload complete'}"`,
    mode: 'active',
    maxDurationMs,
    appName,
    signal
  });
}

/**
 * Monitor for build/test completion in terminal/IDE.
 * Detects build output patterns for success, failure, or completion.
 */
async function actionMonitorBuildCompletion({ buildCommand, successPattern, failurePattern, maxDurationMs = 600000, appName }) {
  const DEFAULT_SUCCESS = ['build successful', 'build succeeded', '✓', 'done', 'completed', 'exit 0', '0 errors', 'passed'];
  const DEFAULT_FAILURE = ['build failed', 'error:', 'failed', 'exit 1', '✗', 'failed to', 'compilation error', 'test failed'];

  const successKeywords = successPattern ? [successPattern] : DEFAULT_SUCCESS;
  const failureKeywords = failurePattern ? [failurePattern] : DEFAULT_FAILURE;

  const startTime = Date.now();
  let baseline = await getRecentOCR();
  let checkInterval = 5000; // Faster polling for builds

  while (Date.now() - startTime < maxDurationMs) {
    await _sleep(checkInterval);
    const current = await getRecentOCR();

    const text = current.text.toLowerCase();

    // Check for success patterns
    const succeeded = successKeywords.some(kw => text.includes(kw.toLowerCase()));
    if (succeeded) {
      return { ok: true, status: 'success', buildCommand, text: current.text.slice(0, 500) };
    }

    // Check for failure patterns
    const failed = failureKeywords.some(kw => text.includes(kw.toLowerCase()));
    if (failed) {
      return { ok: false, status: 'failed', buildCommand, text: current.text.slice(0, 500) };
    }

    // Adaptive backoff - if no new output, slow down
    if (current.text === baseline.text) {
      checkInterval = Math.min(checkInterval * 1.5, 30000);
    } else {
      checkInterval = 5000;
      baseline = current;
    }
  }

  return { ok: false, status: 'timeout', buildCommand, elapsed: Date.now() - startTime };
}

/**
 * Monitor for form submission completion.
 * Detects success messages, redirects, or error states.
 */
async function actionMonitorFormSubmission({ formName, successIndicator, errorIndicator, maxDurationMs = 120000, appName }) {
  const startTime = Date.now();
  const baseline = await getRecentOCR();
  let checkInterval = 3000;

  while (Date.now() - startTime < maxDurationMs) {
    await _sleep(checkInterval);
    const current = await getRecentOCR();
    const text = current.text.toLowerCase();

    // Check for explicit success/error indicators
    if (successIndicator && text.includes(successIndicator.toLowerCase())) {
      return { ok: true, status: 'submitted', form: formName };
    }
    if (errorIndicator && text.includes(errorIndicator.toLowerCase())) {
      return { ok: false, status: 'error', form: formName, error: errorIndicator };
    }

    // Check for generic completion patterns
    const genericSuccess = ['submitted', 'saved', 'success', 'thank you', 'done', 'confirmed'];
    const genericError = ['error', 'failed', 'invalid', 'required', 'retry'];

    if (genericSuccess.some(kw => text.includes(kw))) {
      return { ok: true, status: 'submitted', form: formName, matched: 'generic_success' };
    }
    if (genericError.some(kw => text.includes(kw))) {
      return { ok: false, status: 'error', form: formName, matched: 'generic_error' };
    }

    // Adaptive backoff
    if (current.text === baseline.text) {
      checkInterval = Math.min(checkInterval * 1.3, 15000);
    }
  }

  return { ok: false, status: 'timeout', form: formName };
}

async function verifyAppFocused({ appName, waitMs = 5000 }) {
  const start = Date.now();

  const _matches = (a, b) => {
    const al = (a || '').toLowerCase();
    const bl = (b || '').toLowerCase();
    return al.includes(bl) || bl.includes(al);
  };

  // Use active-win directly — it's faster than OCR and doesn't capture the
  // ThinkDrop overlay when it's visible.
  const liveWin = await _getActiveAppBounds().catch((err) => {
    logger.debug(`[app.agent] verifyAppFocused: initial _getActiveAppBounds failed: ${err.message}`);
    return null;
  });
  const liveAppName = liveWin?.appName || '';
  const OVERLAY_APPS = ['electron', 'thinkdrop'];
  const isOverlayActive = OVERLAY_APPS.some(o => liveAppName.toLowerCase().includes(o));

  const _hasBounds = !!(liveWin && liveWin.width > 0 && liveWin.height > 0);
  logger.info(`[app.agent] verifyAppFocused: initial check - liveWin: ${liveWin ? JSON.stringify({ appName: liveWin.appName, hasBounds: _hasBounds, source: liveWin.source || 'unknown' }) : 'null'}, isOverlayActive: ${isOverlayActive}`);

  // Generic browser sentinel: the planner may pass appName="browser" for any
  // browser-category action. If the active window is a known browser, treat it
  // as focused instead of trying to run `open -a "browser"`, which fails.
  const BROWSER_APP_NAMES = ['Google Chrome', 'Safari', 'Firefox', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Opera'];
  const _isBrowserAppName = (name) => BROWSER_APP_NAMES.some(b => _matches(name, b));
  if (appName && appName.toLowerCase() === 'browser') {
    if (liveWin && _isBrowserAppName(liveWin.appName)) {
      logger.info(`[app.agent] verifyAppFocused: generic "browser" matched active window "${liveWin.appName}"`);
      return { focused: true, appName: liveWin.appName, waited: 0 };
    }
    // No active browser detected yet; fall back to a real app name for focus.
    appName = 'Google Chrome';
    logger.info(`[app.agent] verifyAppFocused: generic "browser" remapped to "${appName}" for focus attempt`);
  }

  if (liveWin && _matches(liveWin.appName, appName)) {
    return { focused: true, appName: liveWin.appName, waited: 0 };
  }

  // If the ThinkDrop overlay is currently in the foreground but we have a
  // boundary cache for the target app, treat it as focused. The overlay will
  // hide before NutJS sends the keystrokes, and the OS will deliver them to
  // the previously-active app (the one the user was looking at).
  if (isOverlayActive) {
    const cached = _findBoundaryCacheEntry(appName);
    if (cached) {
      logger.info(`[app.agent] verifyAppFocused: overlay active but "${appName}" has boundary cache — treating as focused`);
      return { focused: true, appName, waited: 0, viaCache: true };
    }
  }

  // Hide the ThinkDrop overlay before trying to bring the target app forward.
  // If the overlay is visible, macOS keeps our Electron window in the foreground
  // and active-win reports "unknown" even after open -a, so the shortcut step fails.
  return _withOverlayHidden(async () => {
    const { execSync } = require('child_process');

    try {
      execSync(`open -a "${appName}"`, { timeout: 3000 });
      logger.info(`[app.agent] verifyAppFocused: executed 'open -a "${appName}"'`);
    } catch (err) {
      logger.warn(`[app.agent] verifyAppFocused: failed to open app "${appName}": ${err.message}`);
    }

    // Give the target app time to gain focus and for active-win to read it.
    await _sleep(1000);

    // Implement exponential backoff retry logic
    let retryDelay = 500; // Start with 500ms
    const maxRetryDelay = 2000; // Cap at 2 seconds
    let attempts = 0;
    const maxAttempts = Math.floor(waitMs / 500); // Rough estimate of max attempts

    while (Date.now() - start < waitMs && attempts < maxAttempts) {
      attempts++;
      await _sleep(retryDelay);
      
      const after = await _getActiveAppBounds().catch((err) => {
        logger.debug(`[app.agent] verifyAppFocused: attempt ${attempts} - _getActiveAppBounds failed: ${err.message}`);
        return null;
      });
      
      const detectedAppName = after?.appName || 'unknown';
      logger.info(`[app.agent] verifyAppFocused: attempt ${attempts}/${maxAttempts} - detected: "${detectedAppName}", expected: "${appName}", delay: ${retryDelay}ms`);
      
      if (after && _matches(after.appName, appName)) {
        logger.info(`[app.agent] verifyAppFocused: SUCCESS - matched "${after.appName}" after ${Date.now() - start}ms`);
        return { focused: true, appName: after.appName, waited: Date.now() - start, attempts };
      }
      
      // Exponential backoff: double the delay, but don't exceed maxRetryDelay
      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    const final = await _getActiveAppBounds().catch((err) => {
      logger.error(`[app.agent] verifyAppFocused: final _getActiveAppBounds failed: ${err.message}`);
      return null;
    });
    const finalAppName = final?.appName || 'unknown';
    const totalWaited = Date.now() - start;

    // The retry loop's time budget can be exhausted by `open -a` + the initial
    // sleep (yielding "0 attempts"), so the app may already be focused by now.
    // Re-check the final result before declaring failure to avoid a false negative.
    if (final && _matches(final.appName, appName)) {
      logger.info(`[app.agent] verifyAppFocused: SUCCESS (final check) - matched "${final.appName}" after ${totalWaited}ms`);
      return { focused: true, appName: final.appName, waited: totalWaited, attempts };
    }

    logger.error(`[app.agent] verifyAppFocused: FAILED - expected "${appName}", got "${finalAppName}" after ${totalWaited}ms, ${attempts} attempts`);
    
    // Try fallback detection methods if active-win failed
    if (finalAppName === 'unknown' || !final) {
      logger.info(`[app.agent] verifyAppFocused: trying fallback detection methods...`);
      
      // Fallback 1: Try to detect via window title OCR
      const titleResult = await _detectAppByWindowTitle(appName);
      if (titleResult.detected) {
        logger.info(`[app.agent] verifyAppFocused: fallback OCR detected "${appName}"`);
        return { focused: true, appName, waited: totalWaited, attempts, fallback: 'ocr' };
      }
      
      // Fallback 2: Try to detect via OCR difference comparison
      const deltaResult = await _detectAppByOCRDifference(appName);
      if (deltaResult.detected) {
        logger.info(`[app.agent] verifyAppFocused: fallback OCR-delta detected "${appName}" (similarity: ${deltaResult.similarity?.toFixed(3)}, titleChanged: ${deltaResult.titleChanged})`);
        return { focused: true, appName, waited: totalWaited, attempts, fallback: 'ocr-delta', deltaResult };
      }
    }
    
    return { focused: false, appName: finalAppName, waited: totalWaited, attempts };
  });
}

/**
 * Generate dynamic patterns for app name matching without hardcoded mappings
 */
function _generateAppPatterns(appName) {
  const name = appName.toLowerCase();
  const patterns = [name];
  
  // Add common variations
  patterns.push(name.replace(/\s+/g, '')); // Remove spaces
  patterns.push(name.replace(/[^a-z0-9]/g, '')); // Remove special chars
  
  // Add partial matches for longer names (split into words)
  if (name.length > 5) {
    const words = name.split(/\s+/).filter(word => word.length > 3);
    words.forEach(word => {
      if (!patterns.includes(word)) {
        patterns.push(word);
      }
    });
  }
  
  // Add camelCase variations for multi-word names
  const words = name.split(/\s+/);
  if (words.length > 1) {
    const camelCase = words.map((word, index) => 
      index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1)
    ).join('');
    patterns.push(camelCase.toLowerCase());
  }
  
  // Remove duplicates and return
  return [...new Set(patterns)];
}

/**
 * Fallback detection method: Try to detect app by analyzing window titles from recent OCR captures
 */
async function _detectAppByWindowTitle(appName) {
  try {
    // Get recent OCR data from user-memory service
    const { screenCapture } = require('./screen.capture.cjs');
    const recentCapture = await screenCapture({ recent: true });
    
    if (!recentCapture.success || !recentCapture.text) {
      logger.debug(`[app.agent] _detectAppByWindowTitle: no recent OCR data available`);
      return { detected: false };
    }
    
    const windowTitle = recentCapture.windowTitle || '';
    const ocrText = recentCapture.text.toLowerCase();
    const appNameLower = appName.toLowerCase();
    
    logger.debug(`[app.agent] _detectAppByWindowTitle: checking "${appName}" against windowTitle "${windowTitle}" and OCR text`);
    
    // Check window title first
    if (windowTitle.toLowerCase().includes(appNameLower) || appNameLower.includes(windowTitle.toLowerCase())) {
      return { detected: true, method: 'window-title', windowTitle };
    }
    
    // Generate dynamic patterns for the app name
    const patterns = _generateAppPatterns(appName);
    const found = patterns.some(pattern => ocrText.includes(pattern));
    
    if (found) {
      return { detected: true, method: 'ocr-pattern', windowTitle, ocrText, patterns };
    }
    
    return { detected: false };
  } catch (err) {
    logger.error(`[app.agent] _detectAppByWindowTitle error: ${err.message}`);
    return { detected: false };
  }
}

/**
 * Compute similarity between two OCR texts using simple overlap and semantic comparison
 */
function _computeOCRSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  
  // Simple character-level similarity for quick check
  const chars1 = new Set(text1.toLowerCase().replace(/\s+/g, ''));
  const chars2 = new Set(text2.toLowerCase().replace(/\s+/g, ''));
  
  const intersection = new Set([...chars1].filter(x => chars2.has(x)));
  const union = new Set([...chars1, ...chars2]);
  
  const charSimilarity = intersection.size / union.size;
  
  // Word-level similarity for more accuracy
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  
  const wordIntersection = new Set([...words1].filter(x => words2.has(x)));
  const wordUnion = new Set([...words1, ...words2]);
  
  const wordSimilarity = wordUnion.size > 0 ? wordIntersection.size / wordUnion.size : 0;
  
  // Weight word similarity more heavily
  return (charSimilarity * 0.3) + (wordSimilarity * 0.7);
}

/**
 * Generic app detection by comparing OCR states before and after attempting to focus the app
 * This works for any macOS application without requiring hardcoded mappings
 */
async function _detectAppByOCRDifference(appName) {
  try {
    logger.debug(`[app.agent] _detectAppByOCRDifference: starting detection for "${appName}"`);
    
    // 1. Capture baseline OCR state
    const { screenCapture } = require('./screen.capture.cjs');
    const baseline = await screenCapture({ recent: true });
    
    if (!baseline.success || !baseline.text) {
      logger.debug(`[app.agent] _detectAppByOCRDifference: no baseline OCR available`);
      return { detected: false, method: 'ocr-delta', error: 'No baseline OCR' };
    }
    
    // 2. Attempt to focus the target app
    const { execSync } = require('child_process');
    try {
      execSync(`open -a "${appName}"`, { timeout: 3000 });
      logger.debug(`[app.agent] _detectAppByOCRDifference: executed 'open -a "${appName}"'`);
    } catch (err) {
      logger.warn(`[app.agent] _detectAppByOCRDifference: failed to open app "${appName}": ${err.message}`);
      return { detected: false, method: 'ocr-delta', error: 'Failed to open app' };
    }
    
    // 3. Wait for app to focus and UI to stabilize
    await _sleep(1500);
    
    // 4. Trigger a non-invasive action to ensure OCR captures the new state
    // We'll use a harmless function key that most apps don't use
    try {
      const nut = require('@nut-tree-fork/nut-js');
      await nut.keyboard.pressKey(nut.Key.F15);
      await nut.keyboard.releaseKey(nut.Key.F15);
      await _sleep(200); // Small delay for UI to update
    } catch (err) {
      // If NutJS isn't available, just wait a bit longer
      logger.debug(`[app.agent] _detectAppByOCRDifference: NutJS not available, skipping F15 press`);
      await _sleep(500);
    }
    
    // 5. Capture post-focus OCR state
    const afterFocus = await screenCapture({ recent: true });
    
    if (!afterFocus.success || !afterFocus.text) {
      logger.debug(`[app.agent] _detectAppByOCRDifference: no post-focus OCR available`);
      return { detected: false, method: 'ocr-delta', error: 'No post-focus OCR' };
    }
    
    // 6. Compare OCR states
    const similarity = _computeOCRSimilarity(baseline.text, afterFocus.text);
    
    // 7. Check if window title contains app name
    const appNameLower = appName.toLowerCase();
    const beforeTitle = (baseline.windowTitle || '').toLowerCase();
    const afterTitle = (afterFocus.windowTitle || '').toLowerCase();
    
    const titleContainsApp = afterTitle.includes(appNameLower) || 
                           appNameLower.includes(afterTitle) ||
                           afterTitle.includes(appNameLower.replace(/\s+/g, ''));
    
    const titleChanged = beforeTitle !== afterTitle;
    
    // 8. Determine if app was successfully focused
    // App is considered focused if:
    // - OCR similarity is low (significant change) OR
    // - Window title contains app name OR  
    // - Window title changed significantly
    const significantChange = similarity < 0.8;
    const detected = significantChange || titleContainsApp || (titleChanged && afterTitle.length > 0);
    
    logger.debug(`[app.agent] _detectAppByOCRDifference: similarity=${similarity.toFixed(3)}, significantChange=${significantChange}, titleContainsApp=${titleContainsApp}, titleChanged=${titleChanged}`);
    
    return {
      detected,
      method: 'ocr-delta',
      similarity,
      significantChange,
      titleContainsApp,
      titleChanged,
      beforeTitle: baseline.windowTitle,
      afterTitle: afterFocus.windowTitle,
      baselineLength: baseline.text.length,
      afterLength: afterFocus.text.length
    };
    
  } catch (err) {
    logger.error(`[app.agent] _detectAppByOCRDifference error: ${err.message}`);
    return { detected: false, method: 'ocr-delta', error: err.message };
  }
}

async function actionExecuteShortcut({ appName, action, shortcutOverride, verifyWith, skipFocusCheck = false }) {
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, error: 'NutJS unavailable: ' + err.message };
  }

  if (appName && !skipFocusCheck) {
    const focusResult = await verifyAppFocused({ appName, waitMs: 5000 });
    if (!focusResult.focused) {
      return { ok: false, error: `App not focused: expected "${appName}", currently "${focusResult.appName}"`, focusResult };
    }
  }

  const category = KNOWN_APPS[appName] || 'other';
  let shortcutStr = shortcutOverride;

  if (!shortcutStr) {
    const cached = await actionDiscoverShortcuts({ appName, category });
    const match = (cached.shortcuts || []).find(s => s.action === action);
    if (match) shortcutStr = match.shortcut;
  }

  if (!shortcutStr) {
    return { ok: false, error: `No shortcut found for action: ${action}` };
  }

  // Parse the shortcut string into NutJS modifiers + key BEFORE highlighting,
  // so we can fail fast with a descriptive error if it can't be mapped.
  const { Key } = nut;
  const parts = shortcutStr.split('+').map(p => p.trim());
  const modifiers = [];
  let key = null;

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'cmd' || lower === 'command') modifiers.push(Key.LeftSuper);
    else if (lower === 'shift') modifiers.push(Key.LeftShift);
    else if (lower === 'alt' || lower === 'option') modifiers.push(Key.LeftAlt);
    else if (lower === 'ctrl' || lower === 'control') modifiers.push(Key.LeftControl);
    else key = Key[part] ?? Key[part.toUpperCase()] ?? Key[part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()];
  }

  if (!key) {
    logger.warn(`[app.agent] actionExecuteShortcut: could not map key from shortcut "${shortcutStr}"`);
    return { ok: false, error: `Could not map shortcut keys: "${shortcutStr}"`, shortcut: shortcutStr };
  }

  // 1. Dispatch the keystroke FIRST — while verifyAppFocused's confirmation is
  //    still fresh. The boundary highlight is a fullscreen GhostLayer op that can
  //    disturb the foreground app, so it is shown AFTER the key has landed.
  logger.info(`[app.agent] actionExecuteShortcut: dispatching "${shortcutStr}" on "${appName}" (action: ${action || 'override'}, modifiers: ${modifiers.length}, key: ${key})`);
  try {
    await nut.keyboard.pressKey(...modifiers, key);
    await nut.keyboard.releaseKey(...modifiers, key);
  } catch (err) {
    logger.error(`[app.agent] actionExecuteShortcut: dispatch error for "${shortcutStr}": ${err.message}`);
    return { ok: false, error: `Shortcut execution error: ${err.message}`, shortcut: shortcutStr };
  }
  logger.info(`[app.agent] actionExecuteShortcut: dispatched "${shortcutStr}" successfully`);

  // NOTE: The app-boundary highlight is now owned by the drop session in main.js
  // for the whole plan (drawn on app.agent step_start, cleared on the terminal
  // event), so we no longer draw-then-clear a 300ms flash here. Drawing it per
  // shortcut caused a visible flicker and competed with the session boundary.

  // 2. Verify the EFFECT only when the caller asks for it (verifyWith). Capture
  //    with the ThinkDrop overlay hidden so its UI text ("Results"/"Agents"/
  //    "Ask or Drag-Drop") can't pollute the OCR and mask the app's content.
  if (verifyWith) {
    const { screenCapture } = require('./screen.capture.cjs');
    const target = verifyWith.toLowerCase();
    let lastText = '';
    for (let attempt = 0; attempt < 6; attempt++) {
      let live;
      try {
        live = await _withCaptureWindow(() => screenCapture({}));
      } catch (capErr) {
        logger.warn(`[app.agent] actionExecuteShortcut: live capture failed (attempt ${attempt + 1}): ${capErr.message}`);
      }
      lastText = live?.text || lastText;
      if (lastText && lastText.toLowerCase().includes(target)) {
        logger.info(`[app.agent] actionExecuteShortcut: verified "${verifyWith}" appeared after "${shortcutStr}"`);
        return { ok: true, dispatched: true, shortcut: shortcutStr, verifiedWith: verifyWith, afterOCR: lastText.slice(0, 200) };
      }
      await _sleep(500);
    }
    logger.warn(`[app.agent] actionExecuteShortcut: dispatched "${shortcutStr}" but verifyWith "${verifyWith}" not detected after ~3s`);
    return {
      ok: false,
      dispatched: true,
      error: `Shortcut dispatched but verifyWith "${verifyWith}" not detected after ~3s`,
      shortcut: shortcutStr,
      afterOCR: lastText.slice(0, 200)
    };
  }

  // 3. No explicit verification requested: a dispatched keystroke is success.
  //    Response/effect confirmation is the monitor step's responsibility.
  return { ok: true, dispatched: true, shortcut: shortcutStr, note: 'effect verification deferred to monitor step' };
}

// ---------------------------------------------------------------------------
// Phase 3.5: "What Was There Is No Longer" Verification
// ---------------------------------------------------------------------------

/**
 * Verifies a shortcut/action by checking BOTH:
 * 1. Target text appeared
 * 2. Placeholder/initial text disappeared
 *
 * Example: Typing "hello" in field with "Ask Anything" placeholder
 * - Verify "hello" appears in OCR
 * - Verify "Ask Anything" NO LONGER appears
 * If placeholder still visible → text didn't enter field
 */
async function actionVerifyShortcut({ shortcutStr, targetText, placeholder, appName, maxRetries = 2 }) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const beforeOCR = await getRecentOCR();

    // Execute shortcut
    try {
      const { Key } = nut;
      const parts = shortcutStr.split('+').map(p => p.trim());
      const modifiers = [];
      let key = null;

      for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'cmd' || lower === 'command') modifiers.push(Key.LeftSuper);
        else if (lower === 'shift') modifiers.push(Key.LeftShift);
        else if (lower === 'alt' || lower === 'option') modifiers.push(Key.LeftAlt);
        else if (lower === 'ctrl' || lower === 'control') modifiers.push(Key.LeftControl);
        else key = Key[part] ?? Key[part.toUpperCase()] ?? Key[part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()];
      }

      if (key) {
        await nut.keyboard.pressKey(...modifiers, key);
        await nut.keyboard.releaseKey(...modifiers, key);
      }
    } catch (err) {
      return { ok: false, error: `Shortcut execution error: ${err.message}` };
    }

    await _sleep(300);
    const afterOCR = await getRecentOCR();

    // "What was there is no longer" verification
    const targetAppeared = targetText
      ? afterOCR.text.toLowerCase().includes(targetText.toLowerCase())
      : true;

    const placeholderGone = placeholder
      ? !afterOCR.text.toLowerCase().includes(placeholder.toLowerCase())
      : true;

    if (targetAppeared && placeholderGone) {
      return {
        ok: true,
        attempt: attempt + 1,
        verificationMethod: 'what_was_there_is_no_longer',
        targetAppeared,
        placeholderGone,
        shortcut: shortcutStr,
        beforeOCR: beforeOCR.text.slice(0, 200),
        afterOCR: afterOCR.text.slice(0, 200)
      };
    }

    // Failed verification - wait and retry
    if (attempt < maxRetries - 1) {
      logger.warn(`[app.agent] Verification failed for "${shortcutStr}", retrying... (targetAppeared=${targetAppeared}, placeholderGone=${placeholderGone})`);
      await _sleep(500);
    }
  }

  return {
    ok: false,
    error: 'Verification failed after max retries',
    verificationMethod: 'what_was_there_is_no_longer',
    targetAppeared: false,
    placeholderGone: false,
    shortcut: shortcutStr
  };
}

/**
 * Generic action verification using "what was there is no longer" pattern
 */
async function actionVerifyAction({ beforeState, afterState, targetText, placeholder }) {
  const textAppeared = targetText
    ? afterState.toLowerCase().includes(targetText.toLowerCase())
    : true;

  const placeholderGone = placeholder
    ? !afterState.toLowerCase().includes(placeholder.toLowerCase())
    : true;

  return {
    ok: textAppeared && placeholderGone,
    verificationMethod: 'what_was_there_is_no_longer',
    textAppeared,
    placeholderGone,
    stateChanged: beforeState !== afterState,
    beforeSnapshot: beforeState.slice(0, 200),
    afterSnapshot: afterState.slice(0, 200)
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Clipboard Agent - Content Extraction with Style Preservation
// ---------------------------------------------------------------------------

const CLIPBOARD_BACKUP_KEY = 'app_agent_clipboard_backup';
const CLIPBOARD_DIR = path.join(os.homedir(), '.thinkdrop', 'clipboard');

async function ensureClipboardDir() {
  try {
    await fs.promises.mkdir(CLIPBOARD_DIR, { recursive: true });
  } catch (_) {}
}

async function actionClipboardBackup() {
  try {
    const { execSync } = require('child_process');
    const backup = execSync('pbpaste', { encoding: 'utf8', timeout: 5000 });
    await db.set('clipboard', CLIPBOARD_BACKUP_KEY, { content: backup, timestamp: Date.now() });
    return { ok: true, backupSize: backup.length };
  } catch (err) {
    logger.warn(`[app.agent] Clipboard backup failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function actionClipboardRestore() {
  try {
    const backup = await db.get('clipboard', CLIPBOARD_BACKUP_KEY);
    if (!backup || !backup.content) {
      return { ok: false, error: 'No clipboard backup found' };
    }
    const { execSync } = require('child_process');
    execSync('pbcopy', { input: backup.content, timeout: 5000 });
    return { ok: true, restoredSize: backup.content.length };
  } catch (err) {
    logger.warn(`[app.agent] Clipboard restore failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function actionExtractContentViaClipboard({ appName, category = 'browser' }) {
  await ensureClipboardDir();
  
  // 1. Backup current clipboard
  const backupResult = await actionClipboardBackup();
  if (!backupResult.ok) {
    logger.warn('[app.agent] Proceeding without clipboard backup');
  }
  
  try {
    // 2. Execute category-specific selection chain.
    // Hide the overlay first so the target app is visible and can receive focus.
    const categorySchema = CATEGORY_SCHEMAS[category] || CATEGORY_SCHEMAS.other;
    const extractionStrategy = categorySchema?.clipboardBehavior?.extractionStrategy || 'Cmd+A then Cmd+C';
    
    logger.info(`[app.agent] Extracting content from ${appName} using strategy: ${extractionStrategy}`);
    
    let extractedContent = '';
    await _withOverlayHidden(async () => {
      // Bring the target app to the front so NutJS keystrokes land there.
      const { execSync } = require('child_process');
      try { execSync(`open -a "${appName}"`, { timeout: 3000 }); } catch (_) { /* non-fatal */ }
      await _sleep(400); // wait for window focus to settle

      // Browser: Cmd+L -> Tab -> Cmd+A -> Cmd+C
      // Tab moves focus from address bar to first focusable element in page body
      if (category === 'browser') {
        await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+L', skipFocusCheck: true }); // Focus address bar
        await _sleep(150);
        await actionExecuteShortcut({ appName, shortcutOverride: 'Tab', skipFocusCheck: true }); // Move focus to page body
        await _sleep(150);
        await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+A', skipFocusCheck: true }); // Select all page content
        await _sleep(200);
        await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+C', skipFocusCheck: true }); // Copy
        await _sleep(500);
      } else {
        // Generic: just Cmd+A -> Cmd+C
        await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+A', skipFocusCheck: true });
        await _sleep(150);
        await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+C', skipFocusCheck: true });
        await _sleep(400);
      }

      // Read clipboard while overlay is still hidden, so pbpaste sees the new content.
      extractedContent = execSync('pbpaste', { encoding: 'utf8', timeout: 5000 });
    });
    
    // 4. Save to clipboard directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeAppName = appName.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${timestamp}_${safeAppName}_extracted.txt`;
    const filepath = path.join(CLIPBOARD_DIR, filename);
    
    await fs.promises.writeFile(filepath, extractedContent, 'utf8');
    
    // 5. Restore original clipboard
    await actionClipboardRestore();
    
    return {
      ok: true,
      content: extractedContent,
      savedTo: filepath,
      contentLength: extractedContent.length,
      strategy: extractionStrategy
    };
    
  } catch (err) {
    // Try to restore even on error
    await actionClipboardRestore().catch(() => {});
    logger.error(`[app.agent] Content extraction failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Text typing utility (replaces deprecated ui.typeText)
// ---------------------------------------------------------------------------

const _TYPE_TEXT_TOKEN_MAP = {
  '{ENTER}':     'Return',
  '{TAB}':       'Tab',
  '{ESC}':       'Escape',
  '{BACKSPACE}': 'Backspace',
  '{UP}':        'Up',
  '{DOWN}':      'Down',
  '{LEFT}':      'Left',
  '{RIGHT}':     'Right',
  '{DELETE}':    'Delete',
  '{HOME}':      'Home',
  '{END}':       'End',
  '{PAGEUP}':    'PageUp',
  '{PAGEDOWN}':  'PageDown',
  '{SPACE}':     'Space',
};

const _TYPE_TEXT_COMBO_PATTERN = /^\{(CMD|CTRL|ALT|SHIFT)\+(.+)\}$/i;

function _parseTypeTextSegments(text) {
  const segments = [];
  const tokenPattern = /\{[^}]+\}/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'token', value: match[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return segments;
}

async function actionTypeText({ text, appName, delayMs = 0 } = {}) {
  if (!text && text !== '') {
    return { ok: false, error: 'text is required' };
  }

  const resolvedDelayMs = Math.min(500, Math.max(0, parseInt(delayMs ?? 0, 10)));

  if (appName) {
    const focusResult = await verifyAppFocused({ appName, waitMs: 5000 });
    if (!focusResult.focused) {
      return { ok: false, error: `App not focused: expected "${appName}", currently "${focusResult.appName}"`, focusResult };
    }
  }

  let keyboard, Key;
  try {
    const nutjs = require('@nut-tree-fork/nut-js');
    keyboard = nutjs.keyboard;
    Key = nutjs.Key;
  } catch (err) {
    return { ok: false, error: `nut-js not available: ${err.message}` };
  }

  keyboard.config.autoDelayMs = resolvedDelayMs;

  // Convert literal \n to {SHIFT+ENTER} so multiline text types correctly in chat inputs.
  const normalizedText = text.replace(/\n/g, '{SHIFT+ENTER}');
  const segments = _parseTypeTextSegments(normalizedText);
  const startTime = Date.now();

  try {
    for (const seg of segments) {
      if (seg.type === 'text') {
        if (seg.value.length > 0) {
          await keyboard.type(seg.value);
        }
      } else {
        const token = seg.value.toUpperCase();
        const comboMatch = _TYPE_TEXT_COMBO_PATTERN.exec(seg.value);

        if (comboMatch) {
          const modifier = comboMatch[1].toUpperCase();
          const keyName  = comboMatch[2].toUpperCase();

          const modifierKey = {
            'CMD':   Key.LeftSuper,
            'CTRL':  Key.LeftControl,
            'ALT':   Key.LeftAlt,
            'SHIFT': Key.LeftShift
          }[modifier];

          let targetKey = Key[keyName] || Key[keyName.charAt(0).toUpperCase() + keyName.slice(1).toLowerCase()];
          if (!targetKey && keyName === 'ENTER') targetKey = Key.Return;

          if (modifierKey && targetKey) {
            await keyboard.pressKey(modifierKey, targetKey);
            await keyboard.releaseKey(modifierKey, targetKey);
          } else {
            logger.warn(`[app.agent] actionTypeText: unknown combo key ${seg.value}`);
          }
        } else if (_TYPE_TEXT_TOKEN_MAP[token]) {
          const keyName = _TYPE_TEXT_TOKEN_MAP[token];
          const nutKey = Key[keyName];
          if (nutKey !== undefined) {
            await keyboard.pressKey(nutKey);
            await keyboard.releaseKey(nutKey);
          } else {
            logger.warn(`[app.agent] actionTypeText: unknown key name ${keyName}`);
          }
        } else {
          logger.warn(`[app.agent] actionTypeText: unrecognized token — typing literally: ${seg.value}`);
          await keyboard.type(seg.value);
        }
      }
    }
  } catch (err) {
    logger.error(`[app.agent] actionTypeText: keyboard input failed: ${err.message}`);
    return { ok: false, error: `Keyboard input failed: ${err.message}` };
  }

  const elapsed = Date.now() - startTime;
  logger.info(`[app.agent] actionTypeText done`, { typed: text.length, elapsed });
  return { ok: true, typed: text, elapsed };
}

// ---------------------------------------------------------------------------
// Per-app skill runner (skills pattern: single app.agent + per-app packages)
// ---------------------------------------------------------------------------

function _escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _extractFilePathAndPrompt(task) {
  // Find the first absolute path in the task.
  const pathMatch = task.match(/(\/[^\s'"]+)/);
  const filePath = pathMatch ? pathMatch[1] : null;
  if (!filePath) return { filePath: null, prompt: null };

  // Strip common boilerplate and the path to isolate the instruction.
  let prompt = task
    .replace(/open\s+/i, '')
    .replace(new RegExp(_escapeRegex(filePath), 'i'), '')
    .replace(/and\s+use\s+(the\s+)?app'?s?\s+AI\s+assistant\s+to\s+/i, '')
    .replace(/and\s+ask\s+(the\s+)?AI\s+(assistant\s+)?to\s+/i, '')
    .replace(/and\s+then\s+/i, '')
    .replace(/^to\s+/i, '')
    .trim();

  prompt = prompt.replace(/[.!?]$/, '').trim();
  return { filePath, prompt };
}

function _readAgentDescriptor(appName) {
  try {
    const filePath = _appAgentDescriptorPath(appName);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');

    // Parse YAML frontmatter for category and capabilities.
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let category = 'other';
    let capabilities = [];
    if (fmMatch) {
      const fm = fmMatch[1];
      const catMatch = fm.match(/category:\s*(.+)/);
      if (catMatch) category = catMatch[1].trim();
      const capMatch = fm.match(/capabilities:\s*\n([\s\S]*?)(?=\n\w|$)/);
      if (capMatch) {
        capabilities = capMatch[1].split('\n').map(l => l.trim().replace(/^- /, '')).filter(Boolean);
      }
    }

    const shortcuts = _readShortcutsFromDescriptor(appName) || [];
    return { filePath, category, capabilities, shortcuts };
  } catch (err) {
    logger.warn(`[app.agent] _readAgentDescriptor error: ${err.message}`);
    return null;
  }
}

async function _executeShortcutWithFallback({ appName, action, category }) {
  // Try the descriptor action first.
  const result = await actionExecuteShortcut({ appName, action });
  if (result.ok) return result;

  // Conservative category defaults for the proxy workflow.
  const defaults = {
    editor: { quick_open: 'Cmd+P', open_file_dialog: 'Cmd+O', focus_ai: 'Cmd+L', save: 'Cmd+S', select_all: 'Cmd+A' },
    browser: { quick_open: 'Cmd+L', focus_ai: 'Cmd+Shift+A', save: 'Cmd+S', select_all: 'Cmd+A' },
    chat: { focus_ai: 'Cmd+L', save: 'Cmd+S', select_all: 'Cmd+A' },
    terminal: { save: 'Cmd+S', select_all: 'Cmd+A' },
  };

  const defaultShortcut = defaults[category]?.[action];
  if (defaultShortcut) {
    logger.warn(`[app.agent] actionRunAgent: descriptor action ${action} failed for ${appName}, trying default ${defaultShortcut}`);
    return actionExecuteShortcut({ appName, shortcutOverride: defaultShortcut });
  }

  return result;
}

async function actionRunAgent({ appName, task, filePath, prompt, maxDurationMs = 300000 } = {}) {
  if (!appName) {
    return { ok: false, error: 'appName is required' };
  }
  if (!task && (!filePath || !prompt)) {
    return { ok: false, error: 'task or (filePath + prompt) is required' };
  }

  let resolvedFilePath = filePath;
  let resolvedPrompt = prompt;

  if (task && (!resolvedFilePath || !resolvedPrompt)) {
    const extracted = _extractFilePathAndPrompt(task);
    resolvedFilePath = resolvedFilePath || extracted.filePath;
    resolvedPrompt = resolvedPrompt || extracted.prompt;
  }

  if (!resolvedFilePath || !resolvedPrompt) {
    return { ok: false, error: 'Could not extract filePath and prompt from task' };
  }

  const descriptor = _readAgentDescriptor(appName);
  const category = descriptor?.category || KNOWN_APPS[appName] || 'other';

  // 1. Verify app focused.
  const focusResult = await verifyAppFocused({ appName, waitMs: 5000 });
  if (!focusResult.focused) {
    return { ok: false, error: `App not focused: ${appName}`, focusResult };
  }

  // 2. Open quick file switcher.
  const openResult = await _executeShortcutWithFallback({ appName, action: 'quick_open', category });
  if (!openResult.ok) {
    return { ok: false, error: `Failed to open quick_open in ${appName}: ${openResult.error}`, openResult };
  }
  await _sleep(500);

  // 3. Type file path and press Enter.
  const typePathResult = await actionTypeText({ appName, text: `${resolvedFilePath}{ENTER}` });
  if (!typePathResult.ok) {
    return { ok: false, error: `Failed to type file path in ${appName}: ${typePathResult.error}`, typePathResult };
  }
  await _sleep(1000); // allow file to open

  // 4. Focus AI assistant input.
  const aiFocusResult = await _executeShortcutWithFallback({ appName, action: 'focus_ai', category });
  if (!aiFocusResult.ok) {
    return { ok: false, error: `Failed to focus AI in ${appName}: ${aiFocusResult.error}`, aiFocusResult };
  }
  await _sleep(500);

  // 5. Type prompt and press Enter.
  const typePromptResult = await actionTypeText({ appName, text: `${resolvedPrompt}{ENTER}` });
  if (!typePromptResult.ok) {
    return { ok: false, error: `Failed to type prompt in ${appName}: ${typePromptResult.error}`, typePromptResult };
  }

  // Give the app's AI a moment to start responding so the first monitor capture
  // doesn't see a stale/jumbled screen before the response begins.
  await _sleep(8000);

  // 6. Wait for AI assistant to finish editing.
  const monitorResult = await actionMonitorWithBackoff({
    goal: `${appName} AI assistant has finished editing ${resolvedFilePath}`,
    mode: 'passive',
    maxDurationMs,
    appName
  });
  if (!monitorResult.ok) {
    return { ok: false, error: `Monitor failed: ${monitorResult.error}`, monitorResult };
  }

  // 7. Save the file.
  const saveResult = await _executeShortcutWithFallback({ appName, action: 'save', category });
  if (!saveResult.ok) {
    return { ok: false, error: `Failed to save in ${appName}: ${saveResult.error}`, saveResult };
  }

  // 8. Verify the file was actually modified by the app's save action.
  let fileVerified = false;
  try {
    const fs = require('fs');
    const stats = await fs.promises.stat(resolvedFilePath);
    const ageMs = Date.now() - stats.mtime.getTime();
    fileVerified = ageMs < 120000; // saved within the last 2 minutes
    if (!fileVerified) {
      logger.warn(`[app.agent] actionRunAgent: file ${resolvedFilePath} mtime is ${ageMs}ms old; save may not have written through`);
    }
  } catch (statErr) {
    logger.warn(`[app.agent] actionRunAgent: could not stat ${resolvedFilePath}: ${statErr.message}`);
  }

  return {
    ok: true,
    appName,
    filePath: resolvedFilePath,
    prompt: resolvedPrompt,
    fileVerified,
    summary: `Opened ${resolvedFilePath} in ${appName}, sent the prompt to the AI assistant, and saved the file.`
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Phase 1: LiteParse & Highlighting
  actionParseScreenshot,
  actionParseScreenshotDocling,
  parseDoclingOutput,
  actionFindElements,
  actionHighlightElements,
  actionHighlightAll,
  actionHighlightSearch,
  actionCaptureScreen,
  
  // Phase 1B: Boundary-Based Highlighting
  actionHighlightBoundaries,
  groupTextItemsIntoBoundaries,
  groupTextItemsIntoSections,
  mergeSmallGroupsIntoClusters,
  
  // Phase 1C: Inferred Assets Detection
  actionHighlightAssets,
  detectIconGaps,
  detectBlankAreas,
  detectClusterGaps,

  // Phase 1D: Spatial Grid Analysis
  actionAnalyzeSpatialGrid,
  analyzeSpatialGrid,

  // Utility
  actionClearHighlights,
  
  // Phase 2: App Taxonomy & Category System
  KNOWN_APPS,
  CATEGORY_SCHEMAS,
  enrichAppContext,
  actionDiscoverShortcuts,
  getBoundariesFromCache,
  actionClearBoundaryCache,
  inferMainRegion,

  // Phase 3: Monitoring & Intelligent Scroll
  getRecentOCR,
  actionPreScrollPlan,
  actionScroll,
  actionSearchScroll,
  actionAiResponseScroll,
  actionLiveChatScroll,
  actionPassiveReadScroll,
  actionTeleportToElement,
  actionSearchAndClick,
  actionMonitorWithBackoff,
  verifyAppFocused,
  actionGetActiveBounds,
  actionExecuteShortcut,
  actionTypeText,
  actionRunAgent,
  // Phase 3: Additional Use Cases
  actionMonitorFileUpload,
  actionMonitorBuildCompletion,
  actionMonitorFormSubmission,

  // Phase 3.5: "What Was There Is No Longer" Verification
  actionVerifyShortcut,
  actionVerifyAction,

  // Phase 4: Clipboard Agent
  actionClipboardBackup,
  actionClipboardRestore,
  actionExtractContentViaClipboard,
};
