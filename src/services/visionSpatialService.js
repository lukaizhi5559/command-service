/**
 * Vision Spatial Service
 * 
 * Provides spatial awareness for Nut.js automation using vision AI.
 * Captures screenshots and uses LLM vision models to identify UI elements
 * with their positions, enabling dynamic clicking without hard-coded coordinates.
 * 
 * Supported providers: OpenAI (gpt-4o), Anthropic (claude-3-opus/sonnet)
 */

const { screen, mouse, straightTo, centerOf, Region, Point } = require('@nut-tree-fork/nut-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------- CONFIGURATION ----------
const API = {
  provider: process.env.VISION_PROVIDER || 'openai', // "openai" | "anthropic"
  model: process.env.VISION_MODEL || 'gpt-4o',
  key: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
};

const OUTPUT_DIR = path.join(__dirname, '../../.temp/screenshots');

// Ensure directory exists
function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}
ensureOutputDir();

// Cache for UI maps to reduce API calls
const mapCache = new Map();
const CACHE_TTL = 120000; // 30 seconds

/**
 * Capture a screenshot of the current screen
 * @returns {Promise<{buffer: Buffer, path: string}>}
 */
async function captureScreen() {
  try {
    // Ensure output directory exists
    ensureOutputDir();
    
    const timestamp = Date.now();
    const tempFileName = `screen-${timestamp}.png`;
    const filePath = path.join(OUTPUT_DIR, tempFileName);
    
    // Capture screenshot - Nut.js saves to current working directory by default
    // We'll capture with just the filename, then move it
    await screen.capture(tempFileName);
    
    // Check if file was created in current directory
    const cwdPath = path.join(process.cwd(), tempFileName);
    
    if (fs.existsSync(cwdPath)) {
      // Move from CWD to our target directory
      fs.renameSync(cwdPath, filePath);
    } else if (!fs.existsSync(filePath)) {
      throw new Error(`Screenshot file was not created at ${cwdPath} or ${filePath}`);
    }
    
    // Read the PNG file (use async version)
    const buffer = await fs.promises.readFile(filePath);
    
    // Verify it's a valid PNG
    const isPNG = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
    
    if (!isPNG) {
      throw new Error('Captured file is not a valid PNG');
    }
    
    console.log(`📸 [VISION] Screenshot saved: ${filePath} (${(buffer.length / 1024).toFixed(2)} KB)`);
    
    return { buffer, path: filePath };
  } catch (error) {
    console.error('❌ [VISION] Screenshot capture failed:', error.message);
    throw error;
  }
}

/**
 * Analyze an image using vision AI to extract UI element map
 * @param {Buffer} buffer - Screenshot image buffer
 * @returns {Promise<Array<{label: string, role: string, bbox: {x: number, y: number, w: number, h: number}}>>}
 */
async function analyzeImage(buffer) {
  try {
    console.log(`🔍 [VISION] Analyzing image with ${API.provider} (${API.model})...`);
    
    if (!API.key) {
      throw new Error(`No API key found for ${API.provider}. Set OPENAI_API_KEY or ANTHROPIC_API_KEY.`);
    }

    // Convert buffer to base64
    const base64Image = buffer.toString('base64');
    
    console.log(`📊 [VISION] Image size: ${(buffer.length / 1024).toFixed(2)} KB, Base64 length: ${base64Image.length}`);
    
    if (API.provider === 'anthropic') {
      return await analyzeWithAnthropic(base64Image);
    } else {
      return await analyzeWithOpenAI(base64Image);
    }
  } catch (error) {
    console.error('❌ [VISION] Image analysis failed:', error.message);
    throw error;
  }
}

/**
 * Analyze image using OpenAI GPT-4o
 */
async function analyzeWithOpenAI(base64Image) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: API.model,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: 'You are a UI layout analyst. Return ONLY a JSON array of objects with fields: label (short description), role (button|link|input|checkbox|radio|heading|text|icon), bbox (x,y,w,h in pixels from top-left). No markdown, no explanation, just the JSON array.'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Analyze this screenshot and identify every interactive UI element (buttons, links, inputs, etc.) with their exact positions. Return a JSON array.'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`,
                  detail: 'high' // Request high detail analysis
                }
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${API.key}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const text = response.data.choices[0].message.content;
    return parseVisionResponse(text);
  } catch (error) {
    if (error.response) {
      console.error('❌ [VISION] OpenAI API error:', error.response.status, error.response.data);
      throw new Error(`OpenAI API error: ${error.response.data?.error?.message || error.response.statusText}`);
    }
    throw error;
  }
}

/**
 * Analyze image using Anthropic Claude
 */
async function analyzeWithAnthropic(base64Image) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: API.model,
      max_tokens: 2000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'You are a UI layout analyst. Analyze this screenshot and identify every interactive UI element (buttons, links, inputs, etc.). Return ONLY a JSON array with objects containing: label (short description), role (button|link|input|checkbox|radio|heading|text|icon), bbox (x,y,w,h in pixels from top-left). No markdown, no explanation.'
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image
              }
            }
          ]
        }
      ]
    },
    {
      headers: {
        'x-api-key': API.key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    }
  );

  const text = response.data.content[0].text;
  return parseVisionResponse(text);
}

/**
 * Parse vision API response and extract JSON
 */
function parseVisionResponse(text) {
  // The model sometimes wraps JSON in ```json ... ``` – strip it
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('❌ [VISION] No JSON found in response:', text);
    throw new Error('No valid JSON returned from vision model');
  }
  
  const elements = JSON.parse(jsonMatch[0]);
  
  // Normalize bbox format - convert array [x,y,w,h] to object {x,y,w,h}
  const normalizedElements = elements.map(el => {
    if (Array.isArray(el.bbox) && el.bbox.length === 4) {
      return {
        ...el,
        bbox: {
          x: el.bbox[0],
          y: el.bbox[1],
          w: el.bbox[2],
          h: el.bbox[3]
        }
      };
    }
    return el;
  });
  
  console.log(`✅ [VISION] Found ${normalizedElements.length} UI elements`);
  
  return normalizedElements;
}

/**
 * Find a UI element by label and optional role
 * @param {Array} map - UI element map from analyzeImage
 * @param {string} label - Label to search for (case-insensitive, partial match)
 * @param {string} [role] - Optional role filter (button, link, input, etc.)
 * @returns {Object|null} - Matching element or null
 */
function findElement(map, label, role = null) {
  const lowerLabel = label.toLowerCase();
  
  const element = map.find(el => {
    const matchesLabel = el.label.toLowerCase().includes(lowerLabel);
    const matchesRole = !role || el.role === role;
    return matchesLabel && matchesRole;
  });
  
  if (element) {
    console.log(`🎯 [VISION] Found element: "${element.label}" (${element.role}) at`, element.bbox);
  } else {
    console.warn(`⚠️ [VISION] Element not found: "${label}"${role ? ` (${role})` : ''}`);
  }
  
  return element || null;
}

/**
 * Convert bbox to center point for clicking
 * @param {{x: number, y: number, w: number, h: number}} bbox
 * @returns {Point}
 */
function bboxToCenter(bbox) {
  const { x, y, w, h } = bbox;
  
  // Manually calculate center for accuracy
  const centerX = Math.round(x + (w / 2));
  const centerY = Math.round(y + (h / 2));
  
  console.log(`📐 [VISION] Bbox: (${x}, ${y}, ${w}, ${h}) → Center: (${centerX}, ${centerY})`);
  
  return new Point(centerX, centerY);
}

/**
 * Find and click a UI element by label
 * @param {string} label - Element label to find
 * @param {string} [role] - Optional role filter
 * @param {boolean} [useCache=true] - Use cached map if available
 * @returns {Promise<boolean>} - True if clicked successfully
 */
async function findAndClick(label, role = null, useCache = true) {
  try {
    console.log(`🔍 [VISION] Finding and clicking: "${label}"${role ? ` (${role})` : ''}`);
    
    // Check cache first
    let map;
    const cacheKey = 'current-screen';
    const cached = mapCache.get(cacheKey);
    
    if (useCache && cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log('📦 [VISION] Using cached UI map');
      map = cached.map;
    } else {
      // Capture and analyze
      const { buffer } = await captureScreen();
      map = await analyzeImage(buffer);
      
      // Cache the result
      mapCache.set(cacheKey, {
        map,
        timestamp: Date.now()
      });
    }
    
    // Find element
    const element = findElement(map, label, role);
    if (!element) {
      console.warn(`⚠️ [VISION] Element not found: "${label}"${role ? ` (${role})` : ''}`);
      console.log(`📋 [VISION] Available elements (${map.length}):`, map.map(el => `${el.label} (${el.role})`).join(', '));
      throw new Error(`Element not found: "${label}"${role ? ` (${role})` : ''}`);
    }
    
    console.log(`✅ [VISION] Found element: "${element.label}" at bbox (${element.bbox.x}, ${element.bbox.y}, ${element.bbox.w}, ${element.bbox.h})`);
    
    // Click center of element
    const center = bboxToCenter(element.bbox);
    console.log(`🖱️ [VISION] Moving mouse to center (${center.x}, ${center.y})`);
    await mouse.move(straightTo(center));
    await new Promise(resolve => setTimeout(resolve, 200)); // Small delay before click
    await mouse.leftClick();
    
    console.log(`✅ [VISION] Successfully clicked "${element.label}"`);
    return true;
  } catch (error) {
    console.error(`❌ [VISION] findAndClick failed:`, error.message);
    throw error; // Re-throw to propagate to step executor
  }
}

/**
 * Get current UI map (capture and analyze)
 * @param {boolean} [forceRefresh=false] - Force new capture, ignore cache
 * @returns {Promise<Array>} - UI element map
 */
async function getUIMap(forceRefresh = false) {
  const cacheKey = 'current-screen';
  const cached = mapCache.get(cacheKey);
  
  if (!forceRefresh && cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log('📦 [VISION] Returning cached UI map');
    return cached.map;
  }
  
  const { buffer } = await captureScreen();
  const map = await analyzeImage(buffer);
  
  mapCache.set(cacheKey, {
    map,
    timestamp: Date.now()
  });
  
  return map;
}

/**
 * Clear the UI map cache
 */
function clearCache() {
  mapCache.clear();
  console.log('🗑️ [VISION] Cache cleared');
}

module.exports = {
  captureScreen,
  analyzeImage,
  findElement,
  findAndClick,
  getUIMap,
  clearCache,
  bboxToCenter
};
