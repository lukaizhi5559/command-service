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
      return findCompoundMatches(textItems, parts, searchText);
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

    // 2. Find matching elements
    const pageText = parseResult.raw && parseResult.raw.pages && parseResult.raw.pages[0]
      ? (parseResult.raw.pages[0].text || '')
      : '';
    const findResult = await actionFindElements({
      searchText,
      textItems: parseResult.textItems,
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
// Phase 2: App Taxonomy & Category System
// ---------------------------------------------------------------------------

const db = require('../skill-helpers/skill-db.cjs');
const { ask: skillLlmAsk } = require('../skill-helpers/skill-llm.cjs');
const webAgent = require('./web.agent.cjs');
const { webCrawl } = require('./web.crawl.cjs');

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
  'Spark': 'email'
};

const CATEGORY_SCHEMAS = {
  browser: {
    regions: {
      addressBar: { x: [150, 800], y: [70, 100], type: 'url_input' },
      tabBar: { x: [0, 1200], y: [35, 70], type: 'tabs' },
      contentArea: { x: [0, 1280], y: [100, 800], type: 'page_content' }
    },
    inferBoundaryType: (width, height, x, y) => {
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
    inferBoundaryType: (width, height, x, y) => {
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
    inferBoundaryType: (width, height, x, y) => {
      if (width < 250 && x < 220) return { type: 'sidebar', confidence: 0.95 };
      if (y > 700 && height < 100) return { type: 'input', confidence: 0.9 };
      if (x > 220 && y < 700) return { type: 'messages', confidence: 0.85 };
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
    inferBoundaryType: (width, height, x, y) => {
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
    inferBoundaryType: (width, height, x, y) => {
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
    inferBoundaryType: (width, height, x, y) => {
      if (x < 200) return { type: 'folders', confidence: 0.9 };
      if (x > 200 && x < 600) return { type: 'message_list', confidence: 0.85 };
      return { type: 'reading_pane', confidence: 0.8 };
    },
    clipboardBehavior: { cmdA: 'select_all_messages', extractionStrategy: 'Focus reading pane then Cmd+A' },
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

function _buildBoundaryCacheKey(appName, windowTitle) {
  const titleHash = windowTitle
    ? windowTitle.slice(0, 40).replace(/[^a-z0-9]/gi, '_').toLowerCase()
    : 'default';
  return `${appName.replace(/\s+/g, '_').toLowerCase()}_${titleHash}`;
}

function _isStale(lastUpdated, maxAgeMs) {
  return !lastUpdated || (Date.now() - lastUpdated) > maxAgeMs;
}

async function _shouldInvalidateBoundaryCache(appName, windowTitle, currentDiffRatio, currentDimensions) {
  try {
    const cacheKey = _buildBoundaryCacheKey(appName, windowTitle);
    const cached = await db.get('boundary_layout', cacheKey);
    if (!cached) return true;

    const dimsChanged = currentDimensions &&
      (Math.abs((currentDimensions.width || 0) - (cached.screenWidth || 0)) > 100 ||
       Math.abs((currentDimensions.height || 0) - (cached.screenHeight || 0)) > 100);
    if (dimsChanged) return true;

    if (currentDiffRatio > 0.30) return true;

    if (cached.capturedAt && (Date.now() - cached.capturedAt) > 60000) return true;

    return false;
  } catch (_) {
    return true;
  }
}

async function getBoundariesFromCache(appName, windowTitle) {
  try {
    const cacheKey = _buildBoundaryCacheKey(appName, windowTitle);
    const cached = await db.get('boundary_layout', cacheKey);
    if (cached && !_isStale(cached.capturedAt, 60000)) {
      return cached.boundaries || [];
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function _storeBoundaryCache(appName, windowTitle, boundaries, category) {
  try {
    const cacheKey = _buildBoundaryCacheKey(appName, windowTitle);
    await db.set('boundary_layout', cacheKey, {
      boundaries,
      screenWidth: 1440,
      screenHeight: 900,
      capturedAt: Date.now(),
      category
    });
  } catch (_) {}
}

async function actionClearBoundaryCache({ appName, windowTitle }) {
  try {
    const cacheKey = _buildBoundaryCacheKey(appName, windowTitle);
    await db.delete('boundary_layout', cacheKey);
    logger.info(`[app.agent] Boundary cache cleared: ${cacheKey}`);
    return { ok: true, cacheKey };
  } catch (err) {
    logger.warn(`[app.agent] Failed to clear boundary cache: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function actionDiscoverShortcuts({ appName, category }) {
  const cacheKey = `${appName.toLowerCase().replace(/\s+/g, '_')}_${category || 'other'}`;
  try {
    const cached = await db.get('app_shortcuts', cacheKey);
    if (cached && !_isStale(cached.lastUpdated, 7 * 24 * 60 * 60 * 1000)) {
      logger.info(`[app.agent] Shortcuts served from cache for ${appName}`);
      return { ok: true, shortcuts: cached.shortcuts, source: 'cache' };
    }
  } catch (_) {}

  try {
    const searchResult = await webAgent.actionSearchAndNavigate({
      query: `${appName} keyboard shortcuts cheat sheet macOS`,
      maxResults: 5
    });

    if (!searchResult || !searchResult.ok || !searchResult.bestUrl) {
      logger.warn(`[app.agent] No web result for ${appName} shortcuts`);
      return { ok: false, shortcuts: [], error: 'No search result' };
    }

    const crawlResult = await webCrawl({ url: searchResult.bestUrl, maxChars: 15000 });
    if (!crawlResult || !crawlResult.ok) {
      return { ok: false, shortcuts: [], error: 'Crawl failed' };
    }

    const llmResult = await skillLlmAsk(`
Extract keyboard shortcuts from this content.
App: ${appName}
Category: ${category}

Return JSON only:
{
  "shortcuts": [
    { "action": "open_file", "shortcut": "Cmd+O", "context": "file" }
  ]
}

Content:
${crawlResult.content.slice(0, 8000)}
`);

    let shortcuts = [];
    try {
      const parsed = JSON.parse(llmResult.replace(/```json|```/g, '').trim());
      shortcuts = parsed.shortcuts || [];
    } catch (_) {
      logger.warn(`[app.agent] LLM shortcut parse failed for ${appName}`);
    }

    try {
      await db.set('app_shortcuts', cacheKey, {
        shortcuts,
        sourceUrl: searchResult.bestUrl,
        category,
        lastUpdated: Date.now()
      });
    } catch (_) {}

    logger.info(`[app.agent] Shortcuts discovered and cached for ${appName}: ${shortcuts.length} shortcuts`);
    return { ok: true, shortcuts, source: 'web' };
  } catch (err) {
    logger.error(`[app.agent] actionDiscoverShortcuts error: ${err.message}`);
    return { ok: false, shortcuts: [], error: err.message };
  }
}

async function enrichAppContext(appName, windowTitle, { background = false } = {}) {
  try {
    const category = KNOWN_APPS[appName] || 'other';

    let boundaries = await getBoundariesFromCache(appName, windowTitle);
    if (!boundaries) {
      const parseResult = await actionParseScreenshot({});
      if (parseResult.ok && parseResult.textItems && parseResult.textItems.length > 0) {
        boundaries = groupTextItemsIntoBoundaries(parseResult.textItems);
        await _storeBoundaryCache(appName, windowTitle, boundaries, category);
      } else {
        boundaries = [];
      }
    }

    const shortcutsResult = await actionDiscoverShortcuts({ appName, category });

    logger.info(`[app.agent] enrichAppContext complete: ${appName} (${category}), boundaries: ${boundaries.length}, shortcuts: ${shortcutsResult.shortcuts.length}`);
    return { category, boundaries, shortcuts: shortcutsResult.shortcuts };
  } catch (err) {
    logger.error(`[app.agent] enrichAppContext error: ${err.message}`);
    return { category: KNOWN_APPS[appName] || 'other', boundaries: [], shortcuts: [] };
  }
}

function inferMainRegion(boundaries, category) {
  const schema = CATEGORY_SCHEMAS[category] || CATEGORY_SCHEMAS.other;
  if (!boundaries || boundaries.length === 0) {
    return { centerX: 640, centerY: 400 };
  }

  const scored = boundaries.map(b => {
    const inferred = schema.inferBoundaryType(b.width, b.height, b.x, b.y);
    const isMain = inferred.type === 'content' || inferred.type === 'messages' ||
                   inferred.type === 'editor' || inferred.type === 'scrollback' ||
                   inferred.type === 'canvas' || inferred.type === 'reading_pane';
    return { ...b, isMain, confidence: inferred.confidence };
  }).filter(b => b.isMain);

  if (scored.length === 0) {
    const largest = [...boundaries].sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    return { centerX: largest.x + largest.width / 2, centerY: largest.y + largest.height / 2 };
  }

  const best = scored.sort((a, b) => b.confidence - a.confidence)[0];
  return { centerX: best.x + best.width / 2, centerY: best.y + best.height / 2 };
}

// ---------------------------------------------------------------------------
// Phase 3: Monitoring, Scroll Modes, and getRecentOCR
// ---------------------------------------------------------------------------

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEMORY_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const MEMORY_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || '';

async function getRecentOCR({ maxAgeSeconds = 3, appName: targetApp = null } = {}) {
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
    logger.info(`[app.agent] getRecentOCR: DB has "${dbResult.appName}" but target is "${targetApp}" — falling back to live screen capture`);
    try {
      const { screenCapture } = require('./screen.capture.cjs');
      const live = await screenCapture({});
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

async function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function actionPreScrollPlan({ goal, appName, category, maxScrolls }) {
  try {
    const currentOCR = await getRecentOCR();
    const prompt = `
User goal: "${goal}"
App: ${appName} (category: ${category})
Current screen OCR: ${(currentOCR.text || '').slice(0, 600)}

Think like a human. Determine:
1. direction: "up" or "down"
2. scrollMode: "search" (finding specific past content), "ai_response" (waiting for desktop AI), "live_chat" (waiting for human reply), or "passive_read" (consuming document content)
3. stopKeyword: the specific word, date, or phrase that signals success
4. purposeStatement: one sentence describing what success looks like
5. maxScrolls: how many scroll steps before giving up (10-30)

Return JSON only, no markdown fences.`;

    const result = await skillLlmAsk(prompt);
    const parsed = JSON.parse(result.replace(/```json|```/g, '').trim());
    return {
      ok: true,
      direction: parsed.direction || 'down',
      scrollMode: parsed.scrollMode || 'passive_read',
      stopKeyword: parsed.stopKeyword || '',
      purposeStatement: parsed.purposeStatement || goal,
      maxScrolls: parsed.maxScrolls || maxScrolls || 20
    };
  } catch (err) {
    logger.warn(`[app.agent] actionPreScrollPlan failed: ${err.message}`);
    return { ok: false, direction: 'down', scrollMode: 'passive_read', stopKeyword: '', purposeStatement: goal, maxScrolls: maxScrolls || 20 };
  }
}

async function actionSearchScroll({ scrollPlan, appName, windowTitle, category }) {
  const { direction, stopKeyword, purposeStatement, maxScrolls } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, found: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  const boundaries = await getBoundariesFromCache(appName, windowTitle) || [];
  const mainRegion = inferMainRegion(boundaries, category);

  try {
    await nut.mouse.move([{ x: mainRegion.centerX, y: mainRegion.centerY }]);
    await _sleep(200);
  } catch (_) {}

  let scrollCount = 0;
  let lastOCR = await getRecentOCR();
  let noChangeStreak = 0;

  while (scrollCount < maxScrolls) {
    try {
      if (direction === 'up') await nut.mouse.scrollUp(3);
      else await nut.mouse.scrollDown(3);
    } catch (err) {
      return { ok: false, found: false, stopReason: 'scroll_error', error: err.message };
    }
    await _sleep(500);

    const currentOCR = await getRecentOCR();

    if (stopKeyword && currentOCR.text.toLowerCase().includes(stopKeyword.toLowerCase())) {
      return { ok: true, found: true, scrolls: scrollCount, stopReason: 'keyword_found' };
    }

    const topBefore = _getTopWords(lastOCR.text, 5);
    const topAfter = _getTopWords(currentOCR.text, 5);
    const scrolled = topBefore.some(w => !topAfter.includes(w));
    if (!scrolled) {
      noChangeStreak++;
      if (noChangeStreak >= 2) {
        return { ok: false, found: false, scrolls: scrollCount, stopReason: 'content_boundary_reached' };
      }
    } else {
      noChangeStreak = 0;
    }

    if (scrollCount % 5 === 4) {
      try {
        const check = await skillLlmAsk(`
Purpose: ${purposeStatement}
Looking for: "${stopKeyword}"
Screen now: ${currentOCR.text.slice(0, 500)}
Scrolls done: ${scrollCount + 1}/${maxScrolls}
Respond with exactly one word: FOUND, KEEP_SCROLLING, or GIVE_UP`);
        const answer = check.trim().toUpperCase();
        if (answer === 'FOUND') return { ok: true, found: true, scrolls: scrollCount, stopReason: 'llm_confirmed' };
        if (answer === 'GIVE_UP') return { ok: false, found: false, scrolls: scrollCount, stopReason: 'llm_gave_up' };
      } catch (_) {}
    }

    lastOCR = currentOCR;
    scrollCount++;
  }
  return { ok: false, found: false, scrolls: scrollCount, stopReason: 'max_scrolls_exhausted' };
}

async function actionAiResponseScroll({ scrollPlan, appName, windowTitle, category }) {
  const { stopKeyword, purposeStatement, maxScrolls } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, found: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  const boundaries = await getBoundariesFromCache(appName, windowTitle) || [];
  const mainRegion = inferMainRegion(boundaries, category);
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

      if (stopKeyword && joined.toLowerCase().includes(stopKeyword.toLowerCase())) {
        resolved = true;
        try {
          const monSvc = require('../monitor/monitorService');
          if (monSvc && monSvc.deactivateWatchMode) monSvc.deactivateWatchMode(sessionId);
        } catch (_) {}
        resolve({ ok: true, found: true, stopReason: 'keyword_found', content: joined });
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

async function actionPassiveReadScroll({ scrollPlan, appName, windowTitle, category }) {
  const { stopKeyword, purposeStatement, maxScrolls = 30 } = scrollPlan;
  let nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
  } catch (err) {
    return { ok: false, stopReason: 'nutjs_unavailable', error: err.message };
  }

  const boundaries = await getBoundariesFromCache(appName, windowTitle) || [];
  const mainRegion = inferMainRegion(boundaries, category);
  let scrollCount = 0;
  const accumulatedText = [];

  await nut.mouse.move([{ x: mainRegion.centerX, y: mainRegion.centerY }]);
  await _sleep(200);

  while (scrollCount < maxScrolls) {
    const currentOCR = await getRecentOCR();
    if (currentOCR.text) accumulatedText.push(currentOCR.text);

    if (stopKeyword && currentOCR.text.toLowerCase().includes(stopKeyword.toLowerCase())) {
      return { ok: true, found: true, stopReason: 'keyword_found', scrolls: scrollCount, text: accumulatedText.join('\n') };
    }

    const topWordsBefore = currentOCR.text.split(/\s+/).slice(0, 5);

    try {
      await nut.mouse.scrollDown(3);
      await _sleep(600);
    } catch (_) {}
    scrollCount++;

    const afterOCR = await getRecentOCR();
    const topWordsAfter = afterOCR.text.split(/\s+/).slice(0, 5);
    const scrollOccurred = topWordsBefore.some(w => w.length > 3 && !topWordsAfter.includes(w));

    if (!scrollOccurred && scrollCount > 2) {
      return { ok: true, found: false, stopReason: 'end_of_content', scrolls: scrollCount, text: accumulatedText.join('\n') };
    }
  }

  return { ok: true, found: false, stopReason: 'max_scrolls_exhausted', scrolls: scrollCount, text: accumulatedText.join('\n') };
}

async function actionTeleportToElement({ appName, searchText, followWithTab = false }) {
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

async function actionMonitorWithBackoff({ goal, mode = 'passive', maxDurationMs = 300000, appName, useSemanticComparison = true }) {
  const startTime = Date.now();
  let baseline = await getRecentOCR();
  let checkInterval = 10000;
  let llmCalls = 0;
  const MAX_LLM_CALLS = 20; // Phase 3 success criteria: <20 LLM calls for 10-min tasks

  // Compute baseline embedding
  let baselineEmbedding = useSemanticComparison ? computeSimpleEmbedding(baseline.text) : null;

  while (Date.now() - startTime < maxDurationMs) {
    await _sleep(checkInterval);
    const current = await getRecentOCR();

    if (!current.text) {
      checkInterval = mode === 'active'
        ? Math.min(checkInterval * 1.2, 30000)
        : Math.min(checkInterval * 1.5, 60000);
      continue;
    }

    // Phase 3: Semantic early-exit to save LLM calls
    if (useSemanticComparison && baselineEmbedding) {
      const currentEmbedding = computeSimpleEmbedding(current.text);
      const similarity = cosineSimilarity(baselineEmbedding, currentEmbedding);

      if (similarity > 0.95) {
        // No meaningful change - increase backoff (skip LLM call)
        checkInterval = mode === 'active'
          ? Math.min(checkInterval * 1.2, 30000)
          : Math.min(checkInterval * 1.5, 60000);
        continue;
      }

      // Meaningful change detected - proceed to LLM evaluation
      baselineEmbedding = currentEmbedding;
    } else if (current.text === baseline.text) {
      // Fallback: naive text equality check
      checkInterval = mode === 'active'
        ? Math.min(checkInterval * 1.2, 30000)
        : Math.min(checkInterval * 1.5, 60000);
      continue;
    }

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
}

// ---------------------------------------------------------------------------
// Phase 3: Additional Monitoring Use Cases
// ---------------------------------------------------------------------------

/**
 * Monitor for file upload completion.
 * Detects upload progress bars, percentage indicators, and completion messages.
 */
async function actionMonitorFileUpload({ uploadIndicator, successIndicator, maxDurationMs = 300000, appName }) {
  const UPLOAD_KEYWORDS = ['upload', 'uploading', 'progress', '%', 'transfer', 'sent'];
  const COMPLETION_KEYWORDS = ['complete', 'done', 'uploaded', 'finished', 'success', 'checkmark', '✓'];
  const FAILURE_KEYWORDS = ['failed', 'error', 'retry', 'cancelled', 'network error', 'timed out'];

  return actionMonitorWithBackoff({
    goal: `Wait for file upload to complete. Current indicator: "${uploadIndicator || 'upload in progress'}". Success indicator: "${successIndicator || 'upload complete'}"`,
    mode: 'active',
    maxDurationMs,
    appName
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

  const current = await getRecentOCR({ appName });
  if (current.appName && _matches(current.appName, appName)) {
    return { focused: true, appName: current.appName, waited: 0 };
  }

  try {
    const { execSync } = require('child_process');
    execSync(`open -a "${appName}"`, { timeout: 3000 });
  } catch (_) {}

  const pollInterval = 500;
  while (Date.now() - start < waitMs) {
    await _sleep(pollInterval);
    const after = await getRecentOCR({ appName });
    if (after.appName && _matches(after.appName, appName)) {
      return { focused: true, appName: after.appName, waited: Date.now() - start };
    }
  }

  const final = await getRecentOCR({ appName });
  return { focused: false, appName: final.appName || 'unknown', waited: Date.now() - start };
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

  const beforeOCR = await getRecentOCR();

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
      else key = Key[part.toUpperCase()] || Key[part];
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

  if (verifyWith) {
    const appeared = afterOCR.text.toLowerCase().includes(verifyWith.toLowerCase());
    const changed = afterOCR.text !== beforeOCR.text;
    return { ok: changed || appeared, shortcut: shortcutStr, beforeOCR: beforeOCR.text.slice(0, 200), afterOCR: afterOCR.text.slice(0, 200) };
  }

  return { ok: afterOCR.text !== beforeOCR.text, shortcut: shortcutStr };
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
        else key = Key[part.toUpperCase()] || Key[part];
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
    // 2. Execute category-specific selection chain
    const categorySchema = CATEGORY_SCHEMAS[category] || CATEGORY_SCHEMAS.other;
    const extractionStrategy = categorySchema?.clipboardBehavior?.extractionStrategy || 'Cmd+A then Cmd+C';
    
    logger.info(`[app.agent] Extracting content from ${appName} using strategy: ${extractionStrategy}`);
    
    // Browser: Cmd+L -> Tab -> Cmd+A -> Cmd+C
    if (category === 'browser') {
      await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+L' }); // Focus address bar
      await _sleep(100);
      await actionExecuteShortcut({ appName, shortcutOverride: 'Tab' });   // Move to content
      await _sleep(100);
      await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+A' }); // Select all
      await _sleep(100);
      await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+C' }); // Copy
      await _sleep(100);
    } else {
      // Generic: just Cmd+A -> Cmd+C
      await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+A' });
      await _sleep(100);
      await actionExecuteShortcut({ appName, shortcutOverride: 'Cmd+C' });
      await _sleep(100);
    }
    
    // 3. Read clipboard
    const { execSync } = require('child_process');
    const extractedContent = execSync('pbpaste', { encoding: 'utf8', timeout: 5000 });
    
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
  actionMonitorWithBackoff,
  verifyAppFocused,
  actionExecuteShortcut,
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
