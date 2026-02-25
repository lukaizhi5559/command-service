'use strict';

/**
 * ui.typeText skill
 *
 * Types text into the currently focused UI element using nut-js keyboard input.
 * Works in any native app (Slack, Finder, VS Code, Terminal, etc.) — no selector needed.
 * The element must already be focused (e.g. after a ui.findAndClick on an input field).
 *
 * Special tokens in text (same as browser.act smartType):
 *   {ENTER}     — press Return
 *   {TAB}       — press Tab
 *   {ESC}       — press Escape
 *   {BACKSPACE} — press Backspace
 *   {UP}        — press Up arrow
 *   {DOWN}      — press Down arrow
 *   {CMD+K}     — press Cmd+K
 *   {CMD+C}     — press Cmd+C
 *   {CMD+V}     — press Cmd+V
 *   {CMD+A}     — press Cmd+A
 *   {CMD+Z}     — press Cmd+Z
 *
 * Args:
 *   text      {string}  Required. Text to type. May include special tokens above.
 *   delayMs   {number}  Delay between keystrokes in ms. Default: 0 (fast). Max: 500.
 *
 * Returns:
 *   { success: true,  typed, elapsed }
 *   { success: false, error: string }
 */

const logger = require('../logger.cjs');

const DEFAULT_DELAY_MS = 0;
const MAX_DELAY_MS     = 500;

// ---------------------------------------------------------------------------
// Token map: special tokens → nut-js Key names
// ---------------------------------------------------------------------------

const TOKEN_MAP = {
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

// Combo tokens: {CMD+X} → [Key.LeftSuper, Key.X]
const COMBO_PATTERN = /^\{(CMD|CTRL|ALT|SHIFT)\+(.+)\}$/i;

// ---------------------------------------------------------------------------
// Parse text into segments: plain string chunks and special key tokens
// ---------------------------------------------------------------------------

function parseTextSegments(text) {
  const segments = [];
  // Match {TOKEN} patterns or plain text between them
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

// ---------------------------------------------------------------------------
// Main skill
// ---------------------------------------------------------------------------

async function uiTypeText(args = {}) {
  const { text } = args;
  const delayMs = Math.min(MAX_DELAY_MS, Math.max(0, parseInt(args.delayMs ?? DEFAULT_DELAY_MS, 10)));

  if (!text && text !== '') {
    return { success: false, error: 'text is required' };
  }

  logger.info('[ui.typeText] Starting', { textLength: text.length, delayMs });

  const startTime = Date.now();

  let keyboard, Key;
  try {
    const nutjs = require('@nut-tree-fork/nut-js');
    keyboard = nutjs.keyboard;
    Key = nutjs.Key;
  } catch (err) {
    return { success: false, error: `nut-js not available: ${err.message}` };
  }

  // Set typing speed
  keyboard.config.autoDelayMs = delayMs;

  // Convert literal \n to {SHIFT+ENTER} so multiline text types correctly in chat inputs
  // (plain \n passed to keyboard.type() is silently ignored or errors in nut-js)
  const normalizedText = text.replace(/\n/g, '{SHIFT+ENTER}');

  const segments = parseTextSegments(normalizedText);

  try {
    for (const seg of segments) {
      if (seg.type === 'text') {
        if (seg.value.length > 0) {
          await keyboard.type(seg.value);
        }
      } else {
        // Special token
        const token = seg.value.toUpperCase();
        const comboMatch = COMBO_PATTERN.exec(seg.value);

        if (comboMatch) {
          // Combo key: {CMD+K}, {CTRL+A}, etc.
          const modifier = comboMatch[1].toUpperCase();
          const keyName  = comboMatch[2].toUpperCase();

          const modifierKey = {
            'CMD':   Key.LeftSuper,
            'CTRL':  Key.LeftControl,
            'ALT':   Key.LeftAlt,
            'SHIFT': Key.LeftShift
          }[modifier];

          const targetKey = Key[keyName] || Key[keyName.charAt(0).toUpperCase() + keyName.slice(1).toLowerCase()];

          if (modifierKey && targetKey) {
            await keyboard.pressKey(modifierKey, targetKey);
            await keyboard.releaseKey(modifierKey, targetKey);
          } else {
            logger.warn('[ui.typeText] Unknown combo key', { token: seg.value });
          }
        } else if (TOKEN_MAP[token]) {
          const keyName = TOKEN_MAP[token];
          const nutKey = Key[keyName];
          if (nutKey !== undefined) {
            await keyboard.pressKey(nutKey);
            await keyboard.releaseKey(nutKey);
          } else {
            logger.warn('[ui.typeText] Unknown key name', { keyName });
          }
        } else {
          logger.warn('[ui.typeText] Unrecognized token — typing literally', { token: seg.value });
          await keyboard.type(seg.value);
        }
      }
    }
  } catch (err) {
    logger.error('[ui.typeText] Keyboard input failed', { error: err.message });
    return { success: false, error: `Keyboard input failed: ${err.message}` };
  }

  const elapsed = Date.now() - startTime;
  logger.info('[ui.typeText] Done', { typed: text.length, elapsed });

  return {
    success: true,
    typed: text,
    elapsed
  };
}

module.exports = { uiTypeText };
