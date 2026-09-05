'use strict';

/**
 * parseLlmJson — shared utility for parsing JSON from LLM output
 *
 * LLMs frequently produce malformed JSON: missing boolean values ("key":,),
 * dangling commas, truncated strings, unbalanced braces, markdown fences, etc.
 * This utility handles all of these cases gracefully.
 *
 * This is a copy of stategraph-module/src/utils/parseLlmJson.js so that
 * command-service skills can use the same robust parser without a cross-module
 * dependency. Both copies must be kept in sync.
 *
 * Usage:
 *   const { parseLlmJson } = require('../skill-helpers/parseLlmJson.cjs');
 *   const parsed = parseLlmJson(rawLlmOutput, logger, 'SkillName');
 *   if (!parsed) { /* fallback *\/ }
 *
 * The function NEVER throws — it returns null on failure.
 */

let _jsonrepair;
try { _jsonrepair = require('jsonrepair').jsonrepair; } catch (_) { /* optional dep */ }

// ── Strip markdown code fences ──────────────────────────────────────────────
function _stripFences(text) {
  if (!text) return '';
  // Handle ```json\n...\n``` and ```\n...\n```
  const fenceMatch = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Handle bare ``` prefix/suffix
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
}

// ── Extract the outermost balanced JSON object ──────────────────────────────
// Tracks string state so braces inside strings don't confuse the depth counter.
// Returns the substring from the first '{' to its matching '}', or null.
function _extractBalancedJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === '{') { depth++; }
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  // Unbalanced — return everything from start so the repair step can close it
  return text.slice(start);
}

// ── Extract the outermost balanced JSON array ───────────────────────────────
function _extractBalancedArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
    else if (ch === '[') { depth++; }
    else if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

// ── Repair common LLM JSON malformations ─────────────────────────────────────
function _repairJson(text) {
  if (!text) return text;
  let repaired = text;

  // 1. Fill in missing boolean/null values:
  //    "key": }  →  "key": false }
  //    "key": ]  →  "key": false ]
  //    "key": ,  →  "key": false ,
  repaired = repaired.replace(/"([\w]+)":\s*([}\],])/g, '"$1": false$2');

  // 2. Remove dangling commas before closing braces/brackets
  //    Apply twice for nested patterns
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // 3. Close unterminated strings
  let inString = false;
  let escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === '\\') { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; }
  }
  if (inString) { repaired += '"'; }

  // 4. Close unbalanced braces/brackets
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (inStr) {
      if (esc) { esc = false; }
      else if (ch === '\\') { esc = true; }
      else if (ch === '"') { inStr = false; }
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (ch === '{' || ch === '[') { depth++; }
    else if (ch === '}' || ch === ']') { depth--; }
  }
  while (depth > 0) {
    if (repaired.trim().endsWith('[')) { repaired += ']'; }
    else { repaired += '}'; }
    depth--;
  }

  return repaired;
}

/**
 * Parse JSON from LLM output with multi-layer repair.
 *
 * @param {string} text — raw LLM output (may include markdown fences, prose, etc.)
 * @param {object} [logger] — optional logger for debug warnings
 * @param {string} [label] — label for log messages (e.g. 'shell.run')
 * @returns {object|array|null} parsed JSON, or null if all attempts fail
 */
function parseLlmJson(text, logger, label = 'parseLlmJson') {
  if (!text || typeof text !== 'string') return null;

  const stripped = _stripFences(text);
  if (!stripped) return null;

  // Determine if this looks like an array or object
  const firstBrace = stripped.indexOf('{');
  const firstBracket = stripped.indexOf('[');

  let jsonStr;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    jsonStr = _extractBalancedArray(stripped);
  } else if (firstBrace !== -1) {
    jsonStr = _extractBalancedJson(stripped);
  } else {
    if (logger) logger.debug(`[${label}] No JSON object or array found in output`);
    return null;
  }

  if (!jsonStr) return null;

  // Attempt 1: direct parse
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // Attempt 2: repair common malformations (missing values, commas, strings, braces)
  const repaired = _repairJson(jsonStr);
  try {
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}

  // Attempt 3: jsonrepair library (handles truncated output, smart quotes, etc.)
  if (_jsonrepair) {
    try {
      const parsed = JSON.parse(_jsonrepair(jsonStr));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (err) {
      if (logger) logger.debug(`[${label}] All parse attempts failed: ${err.message}`);
    }
  } else {
    if (logger) logger.debug(`[${label}] All parse attempts failed (jsonrepair not available)`);
  }

  return null;
}

module.exports = { parseLlmJson, _stripFences, _extractBalancedJson, _extractBalancedArray, _repairJson };
