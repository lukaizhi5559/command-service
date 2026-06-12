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

// ---------------------------------------------------------------------------
// Phase 1: Element Finding & Highlighting
// ---------------------------------------------------------------------------

/**
 * Find text elements matching a search query
 * @param {Object} args - searchText, textItems (from LiteParse)
 * @returns {Promise<{ok: boolean, matches: Array}>}
 */
async function actionFindElements(args = {}) {
  const { searchText, textItems = [], fuzzy = true } = args;
  
  if (!searchText) {
    return { ok: false, error: 'searchText is required' };
  }
  
  const searchLower = searchText.toLowerCase();
  const matches = [];
  
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
  
  // Sort by match score
  matches.sort((a, b) => b.matchScore - a.matchScore);
  
  return {
    ok: true,
    matches,
    count: matches.length,
    searchText
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
    
    // 2. Highlight all elements (persistent)
    return await actionHighlightElements({
      elements: parseResult.textItems,
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
    // Send scanning start
    logger.info('[actionHighlightSearch] Starting scan');
    await sendOverlayIpc({ type: 'scanning_start' });
    
    // 1. Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return parseResult;
    }
    
    // 2. Find matching elements
    const findResult = await actionFindElements({
      searchText,
      textItems: parseResult.textItems
    });
    
    if (!findResult.ok || findResult.matches.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: `No elements found matching "${searchText}"` };
    }
    
    // 3. Add padding to search matches for better visibility
    const paddedMatches = findResult.matches.map(match => ({
      ...match,
      x: match.x - 8,        // 8px left padding
      y: match.y - 4,        // 4px top padding
      width: match.width + 16, // 8px each side
      height: match.height + 8 // 4px each side
    }));
    
    // 4. Highlight matches in different color (persistent)
    const result = await actionHighlightElements({
      elements: paddedMatches,
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
 * DBSCAN clustering for text items - groups nearby text into clusters
 * @param {Array} textItems - Text items with x, y, width, height
 * @param {Object} options - Clustering parameters
 * @returns {Array} - Clusters with bounds and items
 */
function clusterTextItemsDBSCAN(textItems, options = {}) {
  const { eps = 150, minPts = 5 } = options;

  if (!textItems || textItems.length === 0) return [];

  // Calculate center points
  const points = textItems.map((item, idx) => ({
    ...item,
    idx,
    cx: item.x + item.width / 2,
    cy: item.y + item.height / 2
  }));

  const labels = new Array(points.length).fill(undefined);
  let clusterId = 0;

  // Find neighbors within eps distance
  function getNeighbors(pIdx) {
    const neighbors = [];
    const p = points[pIdx];
    for (let i = 0; i < points.length; i++) {
      if (i === pIdx) continue;
      const q = points[i];
      const dist = Math.sqrt((p.cx - q.cx) ** 2 + (p.cy - q.cy) ** 2);
      if (dist <= eps) neighbors.push(i);
    }
    return neighbors;
  }

  for (let i = 0; i < points.length; i++) {
    if (labels[i] !== undefined) continue;

    const neighbors = getNeighbors(i);

    if (neighbors.length < minPts) {
      labels[i] = -1; // Noise
      continue;
    }

    // Start new cluster
    clusterId++;
    labels[i] = clusterId;
    const seeds = [...neighbors];

    for (let j = 0; j < seeds.length; j++) {
      const seedIdx = seeds[j];

      if (labels[seedIdx] === -1) labels[seedIdx] = clusterId;
      if (labels[seedIdx] !== undefined) continue;

      labels[seedIdx] = clusterId;
      const seedNeighbors = getNeighbors(seedIdx);

      if (seedNeighbors.length >= minPts) {
        seeds.push(...seedNeighbors);
      }
    }
  }

  // Group by cluster ID
  const clusters = new Map();
  for (let i = 0; i < points.length; i++) {
    const id = labels[i];
    if (id <= 0) continue; // Skip noise
    if (!clusters.has(id)) clusters.set(id, []);
    clusters.get(id).push(points[i]);
  }

  // Convert to bounding boxes
  return Array.from(clusters.values()).map((items, idx) => {
    const xs = items.map(i => i.x);
    const ys = items.map(i => i.y);
    const rights = items.map(i => i.x + i.width);
    const bottoms = items.map(i => i.y + i.height);

    return {
      x: Math.min(...xs) - 15,
      y: Math.min(...ys) - 15,
      width: Math.max(...rights) - Math.min(...xs) + 30,
      height: Math.max(...bottoms) - Math.min(...ys) + 30,
      items: items,
      label: `Cluster ${idx + 1} (${items.length} items)`,
      color: '#00aaff'
    };
  });
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
 * Merge close boxes using edge-to-edge distance and BFS
 * Based on LLM's mathematical approach for text proximity clustering
 * @param {Array} textItems - Text items
 * @param {Object} options - distance thresholds
 * @returns {Array} - Merged sections
 */
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

    const textItems = parseResult.textItems || [];
    if (textItems.length === 0) {
      sendOverlayIpc({ type: 'scanning_complete' });
      return { ok: false, error: 'No text found' };
    }

    // Step 2: Edge-to-edge clustering with BFS
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
  
  // Placeholder for future phases
  // actionAnalyzeViewport,
  // actionDecideScroll,
  // actionMonitorWithBackoff,
  // actionTeleportToElement,
  // actionDiscoverShortcuts,
  // actionExecuteShortcut,
  // actionVirtualDocumentEdit,
};
