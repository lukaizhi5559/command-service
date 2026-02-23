'use strict';

/**
 * ui.click skill
 *
 * Clicks at the current mouse position (or optionally at explicit x/y coordinates).
 * Designed to be used AFTER ui.moveMouse has already positioned the cursor on the
 * target element — avoiding a second OmniParser screenshot+inference call.
 *
 * Flow:
 *   1. If x/y provided: move mouse to those coordinates first
 *   2. Hold any modifier keys (ctrl/cmd/shift/alt)
 *   3. Click (left / right / double)
 *   4. Release modifier keys
 *   5. Optional: wait settleMs for UI to react
 *
 * Args:
 *   button    {string}  'left' | 'right' | 'double'. Default: 'left'.
 *   modifier  {string}  Optional modifier key: 'ctrl' | 'cmd' | 'shift' | 'alt'.
 *                       e.g. 'cmd' for Cmd+Click (open in new tab), 'ctrl' for Ctrl+Click (context menu on some apps).
 *   x         {number}  Optional. Logical pixel X to move to before clicking.
 *   y         {number}  Optional. Logical pixel Y to move to before clicking.
 *   settleMs  {number}  Milliseconds to wait before clicking (lets UI settle). Default: 150.
 *
 * Returns:
 *   { success: true, button, modifier, x, y, elapsed }
 *   { success: false, error: string }
 */

const logger = require('../logger.cjs');

const DEFAULT_SETTLE_MS = 150;

const MODIFIER_KEY_MAP = {
  ctrl:  'LeftControl',
  cmd:   'LeftSuper',
  shift: 'LeftShift',
  alt:   'LeftAlt',
  meta:  'LeftSuper',
};

async function uiClick(args = {}) {
  const button   = args.button || 'left';
  const modifier = args.modifier ? String(args.modifier).toLowerCase() : null;
  const settleMs = Math.min(5000, Math.max(0, parseInt(args.settleMs ?? DEFAULT_SETTLE_MS, 10)));
  const x        = args.x !== undefined ? parseFloat(args.x) : undefined;
  const y        = args.y !== undefined ? parseFloat(args.y) : undefined;

  if (!['left', 'right', 'double'].includes(button)) {
    return { success: false, error: `Unknown button "${button}". Must be: left | right | double` };
  }
  if (modifier && !MODIFIER_KEY_MAP[modifier]) {
    return { success: false, error: `Unknown modifier "${modifier}". Must be: ctrl | cmd | shift | alt` };
  }

  const startTime = Date.now();

  logger.info('[ui.click] Starting', { button, modifier, x, y, settleMs });

  try {
    const { mouse, keyboard, Key, straightTo } = require('@nut-tree-fork/nut-js');

    // If explicit coordinates provided, move there first
    if (x !== undefined && y !== undefined) {
      logger.debug('[ui.click] Moving to explicit coords before click', { x, y });
      await mouse.move(straightTo({ x, y }));
    }

    // Brief settle before click so the element is under the cursor
    if (settleMs > 0) {
      await new Promise(r => setTimeout(r, settleMs));
    }

    // Hold modifier key if requested
    const nutKey = modifier ? Key[MODIFIER_KEY_MAP[modifier]] : null;
    if (nutKey !== null && nutKey !== undefined) {
      await keyboard.pressKey(nutKey);
    }

    try {
      switch (button) {
        case 'right':
          await mouse.rightClick();
          break;
        case 'double':
          await mouse.leftClick();
          await new Promise(r => setTimeout(r, 80));
          await mouse.leftClick();
          break;
        case 'left':
        default:
          await mouse.leftClick();
          break;
      }
    } finally {
      // Always release modifier key even if click throws
      if (nutKey !== null && nutKey !== undefined) {
        await keyboard.releaseKey(nutKey);
      }
    }
  } catch (err) {
    logger.error('[ui.click] Click failed', { error: err.message });
    return { success: false, error: `Click failed: ${err.message}` };
  }

  const elapsed = Date.now() - startTime;
  const pos = x !== undefined ? { x, y } : {};

  logger.info('[ui.click] Done', { button, modifier, ...pos, elapsed });

  return { success: true, button, modifier, ...pos, elapsed };
}

module.exports = { uiClick };
