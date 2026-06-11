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
    
    const outputFile = path.join(os.tmpdir(), `docling-${Date.now()}.json`);
    
    logger.info(`[app.agent] Running Docling CLI on ${targetScreenshot}`);
    
    // Docling CLI with all speed optimizations
    const doclingProcess = spawn('docling', [
      targetScreenshot,
      '--to', 'json',
      '--no-ocr',
      '--pdf-backend', 'pypdfium2',
      '--no-code-enrichment',
      '--no-formula-enrichment',
      '-o', path.dirname(outputFile),
      '--output-filename', path.basename(outputFile)
    ], {
      timeout: 60000,
      env: {
        ...process.env,
        TORCH_DEVICE: 'mps'  // Apple Silicon GPU acceleration
      }
    });
    
    let stderr = '';
    doclingProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    return new Promise((resolve) => {
      doclingProcess.on('close', (code) => {
        if (code !== 0) {
          logger.error(`[app.agent] Docling failed: ${stderr}`);
          resolve({ ok: false, error: `Docling failed: ${stderr}` });
          return;
        }
        
        try {
          const textItems = parseDoclingOutput(outputFile);
          
          // Clean up temp file
          try {
            fs.unlinkSync(outputFile);
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
        resolve({ ok: false, error: `Failed to run Docling: ${err.message}` });
      });
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function actionParseScreenshot(args = {}) {
  // Try Docling first
  const doclingResult = await actionParseScreenshotDocling(args);
  if (doclingResult.ok) {
    return doclingResult;
  }
  
  // Fallback to LiteParse
  logger.warn('[app.agent] Docling failed, falling back to LiteParse:', doclingResult.error);
  
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
        label: el.text?.substring(0, 20) || '',
        color
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
    // 1. Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      return parseResult;
    }
    
    // 2. Find matching elements
    const findResult = await actionFindElements({
      searchText,
      textItems: parseResult.textItems
    });
    
    if (!findResult.ok || findResult.matches.length === 0) {
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
    return await actionHighlightElements({
      elements: paddedMatches,
      duration: args.duration || 0,  // 0 = persistent
      color: '#ff0000'  // Red for search matches
    });
  } catch (error) {
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
    yThreshold = 25,           // Increased for paragraph spacing
    xAlignmentThreshold = 35,  // Allow X position variance for left-aligned text
    minItemsPerBoundary = 2    // Lower for small paragraphs
  } = options;
  
  if (!textItems || textItems.length === 0) {
    return [];
  }
  
  // 1. Sort by Y position (top to bottom)
  const sorted = [...textItems].sort((a, b) => a.y - b.y);
  
  // 2. Group items by column alignment and vertical proximity
  // This handles left-aligned paragraphs with varying line widths
  const groups = [];
  let currentGroup = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    const lastItem = currentGroup[currentGroup.length - 1];
    
    // Check vertical gap (allow larger gaps for paragraph spacing)
    const yGap = item.y - (lastItem.y + lastItem.height);
    
    // Check X position alignment (left-aligned paragraphs have similar X positions)
    const xDiff = Math.abs(item.x - lastItem.x);
    
    // Must have small vertical gap AND similar X position
    // This allows lines of different widths to group (typical of left-aligned paragraphs)
    if (yGap <= yThreshold && xDiff <= xAlignmentThreshold) {
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
  
  // 3. Merge each group's bounding boxes with better padding
  return groups.map(group => ({
    x: Math.min(...group.map(i => i.x)) - 8,  // 8px left padding
    y: Math.min(...group.map(i => i.y)) - 8,  // 8px top padding
    width: Math.max(...group.map(i => i.x + i.width)) - Math.min(...group.map(i => i.x)) + 16, // 8px each side
    height: Math.max(...group.map(i => i.y + i.height)) - Math.min(...group.map(i => i.y)) + 16, // 8px each side
    text: group.map(i => i.text).join(' ').substring(0, 50),
    label: `Paragraph (${group.length} items)`,
    color: '#00aaff',
    items: group
  }));
}

/**
 * Highlight text boundaries (grouped text blocks) on screen
 * @returns {Promise<{ok: boolean}>}
 */
async function actionHighlightBoundaries(args = {}) {
  try {
    // 1. Parse screenshot
    const parseResult = await actionParseScreenshot({});
    if (!parseResult.ok) {
      return parseResult;
    }
    
    // 2. Group into boundaries using improved paragraph detection
    const boundaries = groupTextItemsIntoBoundaries(parseResult.textItems, {
      yThreshold: args.yThreshold || 25,
      xAlignmentThreshold: args.xAlignmentThreshold || 35,
      minItemsPerBoundary: args.minItemsPerBoundary || 2
    });
    
    if (boundaries.length === 0) {
      return { ok: false, error: 'No text boundaries found' };
    }
    
    // 3. Highlight boundaries in blue (persistent)
    return await actionHighlightElements({
      elements: boundaries,
      duration: args.duration || 0,  // 0 = persistent
      color: '#00aaff'  // Blue for boundaries
    });
  } catch (error) {
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
  
  // Phase 1C: Inferred Assets Detection
  actionHighlightAssets,
  detectIconGaps,
  detectBlankAreas,
  detectClusterGaps,
  
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
