'use strict';

// ---------------------------------------------------------------------------
// instruction.runner.cjs — Deterministic instruction executor for recorded skills
//
// Instead of using the autonomous playwrightAgent turn-loop (which over-plans,
// restarts tasks, and creates duplicate actions), this runner:
//   1. Parses the instruction into discrete steps
//   2. For each step: snapshots the DOM → asks LLM to pick the best tdN ref →
//      calls browserAct directly to execute
//   3. Returns the result
//
// No autonomous planning. No 12-turn loop. Just deterministic step-by-step execution.
// ---------------------------------------------------------------------------

const { browserAct } = require('./browser.act.cjs');
const { askWithMessages } = require('../skill-helpers/skill-llm.cjs');
const { _executeOverlayInteraction } = require('./playwright.agent.cjs');

const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Per-session overlay cache — stores the overlay detected by state diff
// after a click step, so the next step can resolve items inside it.
// ---------------------------------------------------------------------------
const _sessionOverlays = new Map(); // sessionId → { rect, items, capturedAt }

// ---------------------------------------------------------------------------
// State diff helpers — capture visible interactive elements, diff to find
// newly visible ones (the overlay that appeared after a click).
// ---------------------------------------------------------------------------
const _STATE_DIFF_ITEM_SELS =
  'button, a, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
  '[role="option"], [role="button"], [role="tab"], [role="listitem"], [role="treeitem"], ' +
  '[role="checkbox"], [role="radio"], [role="switch"], ' +
  'input[type="submit"], input[type="button"], input[type="text"], input[type="search"], ' +
  'input[type="email"], input[type="url"], input[type="password"], input[type="tel"], ' +
  'input[type="number"], input, textarea, select, [contenteditable="true"], ' +
  '[tabindex]:not([tabindex="-1"]), [onclick]';

async function _captureVisibleState(sessionId) {
  const code = `(() => {
    const sels = ${JSON.stringify(_STATE_DIFF_ITEM_SELS)};
    return Array.from(document.querySelectorAll(sels))
      .filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        if (s.pointerEvents === 'none') return false;
        if (r.bottom < 0 || r.top > window.innerHeight) return false;
        if (r.right < 0 || r.left > window.innerWidth) return false;
        return true;
      })
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
          role: el.getAttribute('role') || '',
          ref: el.getAttribute('data-td-ref') || '',
          x: Math.round(r.x / 5) * 5,
          y: Math.round(r.y / 5) * 5,
          w: Math.round(r.width / 5) * 5,
          h: Math.round(r.height / 5) * 5,
        };
      });
  })()`;
  const res = await browserAct({ action: 'evaluate', text: code, sessionId, headed: true, timeoutMs: 5000 });
  if (!res?.ok) return [];
  try {
    const raw = res.result;
    const json = typeof raw === 'string' ? raw.replace(/^"|"$/g, '').replace(/\\"/g, '"') : raw;
    return Array.isArray(json) ? json : (typeof json === 'string' ? JSON.parse(json) : []);
  } catch { return []; }
}

function _diffVisibleState(before, after) {
  const beforeKeys = new Set(before.map(e => `${e.tag}|${e.text}|${e.x}|${e.y}|${e.w}|${e.h}`));
  return after.filter(e => !beforeKeys.has(`${e.tag}|${e.text}|${e.x}|${e.y}|${e.w}|${e.h}`));
}

function _unionRect(elements) {
  if (!elements || elements.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const el of elements) {
    if (el.w < 2 || el.h < 2) continue;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    maxX = Math.max(maxX, el.x + el.w);
    maxY = Math.max(maxY, el.y + el.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function runInstructionSkill({ instructions, params, skillArgs, startUrl, sessionId, timeoutMs }) {
  if (!instructions) return { ok: false, error: 'No instructions provided' };
  if (!sessionId) return { ok: false, error: 'No sessionId provided' };

  // Clear any stale overlay cache from a previous run
  _sessionOverlays.delete(sessionId);

  const overallTimeout = timeoutMs || 90000;
  const deadline = Date.now() + overallTimeout;

  // Resolve {{param}} placeholders from skillArgs
  let resolvedInstructions = instructions;
  const unresolved = [];
  resolvedInstructions = resolvedInstructions.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    const val = skillArgs?.[name];
    if (val !== undefined && val !== null && val !== '') return String(val);
    unresolved.push(name);
    return `{{${name}}}`;
  });
  if (unresolved.length > 0) {
    return { ok: false, error: `Unresolved parameter(s): ${unresolved.join(', ')}` };
  }

  // Parse into steps
  const steps = parseInstructions(resolvedInstructions);
  if (steps.length === 0) {
    return { ok: false, error: 'Could not parse any steps from instructions' };
  }

  logger.info(`[instruction.runner] Resolved instructions: ${resolvedInstructions}`);
  logger.info(`[instruction.runner] Parsed ${steps.length} steps from instructions for session=${sessionId}`);

  // Navigate to startUrl if provided
  if (startUrl) {
    try {
      logger.info(`[instruction.runner] Navigating to startUrl: ${startUrl}`);
      const navResult = await browserAct({ action: 'navigate', sessionId, url: startUrl, headed: true, timeoutMs: 30000 });
      if (!navResult?.ok) {
        return { ok: false, error: `Failed to navigate to start URL: ${navResult?.error || 'unknown'}` };
      }
      await _sleep(2000); // Wait for page to settle
    } catch (e) {
      return { ok: false, error: `Navigation failed: ${e.message}` };
    }
  }

  // Execute each step
  const stepResults = [];
  for (let i = 0; i < steps.length; i++) {
    if (Date.now() > deadline) {
      return { ok: false, error: `Timeout after ${overallTimeout}ms at step ${i + 1}/${steps.length}`, stepResults };
    }

    const step = steps[i];
    logger.info(`[instruction.runner] Step ${i + 1}/${steps.length}: ${JSON.stringify(step)}`);

    try {
      const result = await executeStep(step, sessionId, deadline);
      stepResults.push({ step: i + 1, ...step, ...result });
      if (!result.ok) {
        return { ok: false, error: `Step ${i + 1} failed: ${result.error}`, stepResults };
      }
      // Wait between steps for page to settle
      await _sleep(1500);
    } catch (e) {
      logger.error(`[instruction.runner] Step ${i + 1} threw: ${e.message}`);
      stepResults.push({ step: i + 1, ...step, ok: false, error: e.message });
      return { ok: false, error: `Step ${i + 1} threw: ${e.message}`, stepResults };
    }
  }

  logger.info(`[instruction.runner] All ${steps.length} steps completed successfully`);
  return { ok: true, output: `Completed ${steps.length} steps`, stepResults };
}

// ---------------------------------------------------------------------------
// Instruction parser — converts natural language to structured steps
// ---------------------------------------------------------------------------
function parseInstructions(instructions) {
  const steps = [];
  // Split on sentence boundaries (period followed by space or end)
  const sentences = instructions.split(/\.\s+|\.$/).map(s => s.trim()).filter(Boolean);

  for (const sentence of sentences) {
    const step = parseStep(sentence);
    if (step) steps.push(step);
  }

  return steps;
}

function parseStep(sentence) {
  const s = sentence.trim();
  if (!s) return null;

  // Navigate to URL
  let m = s.match(/^navigate\s+to\s+(?:https?:\/\/\S+|["']?(https?:\/\/\S+)["']?)$/i);
  if (m) return { action: 'navigate', url: m[1] || s.replace(/^navigate\s+to\s+/i, '').replace(/["']/g, '') };

  // Click the "X" button/link/element
  m = s.match(/^click\s+(?:the\s+)?["']([^"']+)["'](?:\s+(?:button|link|element|tab|menu|item))?$/i);
  if (m) return { action: 'click', target: m[1] };

  // Click X (without quotes)
  m = s.match(/^click\s+(?:the\s+)?(.+?)(?:\s+(?:button|link|element|tab|menu|item))?$/i);
  if (m && !m[1].match(/^(?:type|select|press|navigate|check|uncheck|submit)/i)) {
    return { action: 'click', target: m[1].replace(/^["']|["']$/g, '') };
  }

  // Type "value" into the "field" field/input/textarea
  // Supports quoted values, {{placeholder}} values, and unquoted multi-word values.
  // Capture groups:
  //   1 = double-quoted value, 2 = single-quoted value,
  //   3 = {{placeholder}} name, 4 = unquoted value (lazy, up to " into"),
  //   5 = double-quoted target, 6 = single-quoted target, 7 = bare target
  m = s.match(/^type\s+(?:"([^"]*)"|'([^']*)'|\{\{([^}]+)\}\}|(.+?))\s+into\s+(?:the\s+)?(?:"([^"]+)"|'([^']+)'|([^\s.]+))(?:\s+(?:field|input|textarea|box|area))?\.?$/i);
  if (m) {
    let value;
    if (m[1] !== undefined) value = m[1];
    else if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = `{{${m[3]}}}`;
    else value = (m[4] || '').trim();
    let target;
    if (m[5] !== undefined) target = m[5];
    else if (m[6] !== undefined) target = m[6];
    else target = m[7];
    return { action: 'fill', target, value };
  }

  // Type "value" (no target specified — will use active input)
  m = s.match(/^type\s+(?:"([^"]*)"|'([^']*)'|\{\{([^}]+)\}\}|(.+))$/i);
  if (m) {
    let value;
    if (m[1] !== undefined) value = m[1];
    else if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = `{{${m[3]}}}`;
    else value = (m[4] || '').trim();
    return { action: 'fill', target: null, value };
  }

  // Select "value" from "dropdown"
  m = s.match(/^select\s+["']([^"']+)["']\s+from\s+(?:the\s+)?["']?([^"']+)["']?(?:\s+dropdown)?$/i);
  if (m) return { action: 'select', target: m[2], value: m[1] };

  // Press Enter / Tab / Escape
  m = s.match(/^press\s+(enter|tab|escape|return|space)$/i);
  if (m) return { action: 'key', key: m[1].toLowerCase() === 'return' ? 'Enter' : m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() };

  // Check "X"
  m = s.match(/^check\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'check', target: m[1] };

  // Uncheck "X"
  m = s.match(/^uncheck\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'uncheck', target: m[1] };

  // Submit the form
  m = s.match(/^submit\s+(?:the\s+)?form$/i);
  if (m) return { action: 'key', key: 'Enter' };

  // Double-click "X"
  m = s.match(/^double[- ]click\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (m) return { action: 'dblclick', target: m[1] };

  // Unknown — log warning
  logger.warn(`[instruction.runner] Could not parse step: "${s}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Step executor — snapshot → resolve ref → browserAct
// ---------------------------------------------------------------------------
async function executeStep(step, sessionId, deadline) {
  // Navigate steps don't need a snapshot
  if (step.action === 'navigate') {
    _sessionOverlays.delete(sessionId); // navigation invalidates any cached overlay
    const result = await browserAct({ action: 'navigate', sessionId, url: step.url, headed: true, timeoutMs: 30000 });
    await _sleep(2000);
    return { ok: !!result?.ok, error: result?.error };
  }

  // Key press steps don't need element resolution
  if (step.action === 'key') {
    const result = await browserAct({ action: 'press', sessionId, key: step.key, headed: true, timeoutMs: 10000 });
    return { ok: !!result?.ok, error: result?.error };
  }

  // For click/fill/select/check/uncheck/dblclick — we need to find the element
  if (!step.target) {
    // No target — use the active element (e.g. for fill into focused input)
    if (step.action === 'fill') {
      const result = await browserAct({ action: 'fill', sessionId, text: step.value, headed: true, timeoutMs: 10000 });
      return { ok: !!result?.ok, error: result?.error, verified: result?.verified };
    }
    return { ok: false, error: `Step requires a target but none was specified: ${JSON.stringify(step)}` };
  }

  // Snapshot the DOM
  const snapshotResult = await browserAct({ action: 'snapshot', sessionId, headed: true, timeoutMs: 15000 });
  if (!snapshotResult?.ok || !snapshotResult?.result) {
    return { ok: false, error: `Failed to snapshot DOM: ${snapshotResult?.error || 'no result'}` };
  }

  const snapshot = snapshotResult.result;
  const activeElement = snapshotResult.activeElement;

  // Retrieve cached overlay from a previous click step (state-diff based).
  // This is the overlay that was detected by comparing visible elements
  // before and after the previous click — it's the actual dropdown/menu/modal,
  // not a heuristic guess.
  const cachedOverlay = _sessionOverlays.get(sessionId);
  let overlayRect = cachedOverlay?.rect || null;
  let overlayItems = cachedOverlay?.items || [];
  if (cachedOverlay) {
    logger.info(`[instruction.runner] Cached overlay from previous click: ${overlayItems.length} items, rect=${JSON.stringify(overlayRect)}`);
  }

  // ── Ref resolution ──────────────────────────────────────────────────────
  // Try deterministic overlay item match first (if cached overlay exists),
  // then fall back to LLM resolver with scoped snapshot.
  let ref = null;
  let scopedSnapshot = snapshot;

  if (overlayItems.length > 0) {
    if (step.action === 'click' || step.action === 'dblclick') {
      ref = _resolveOverlayItem(step, [{ items: overlayItems }]);
      if (ref) {
        const itemText = _getOverlayItemText(ref, [{ items: overlayItems }]);
        logger.info(`[instruction.runner] Cached overlay item match for "${step.target}" → ref=${ref} text="${itemText}"`);
      }
    } else if (step.action === 'fill' && step.target) {
      ref = _resolveOverlayInput(step, [{ items: overlayItems }]);
      if (ref) {
        logger.info(`[instruction.runner] Cached overlay input match for "${step.target}" → ${ref}`);
      }
    }
    if (!ref) {
      // Scope snapshot to the overlay items for the LLM
      scopedSnapshot = _filterSnapshotToOverlay(snapshot, { items: overlayItems });
      logger.info(`[instruction.runner] Scoped snapshot to cached overlay (${overlayItems.length} items) from ${snapshot.length} to ${scopedSnapshot.length} chars`);
    } else {
      scopedSnapshot = _filterSnapshotToRefs(snapshot, [ref]);
    }
  }

  // Fall back to LLM resolver if deterministic matching didn't find a ref
  if (!ref) {
    ref = await resolveRefByIntent(step, scopedSnapshot, activeElement, deadline, {
      overlayActive: !!overlayRect,
    });
  }

  // ── No ref resolved — try clickByText with scopeRect, then Tier 1.6 ──────
  if (!ref) {
    if ((step.action === 'click' || step.action === 'dblclick') && overlayRect) {
      // Try clickByText scoped to the overlay rect — finds the largest element
      // with matching text inside the overlay (the clickable row, not inner span)
      logger.info(`[instruction.runner] No ref — trying clickByText "${step.target}" in cached overlay scope`);
      const ctResult = await browserAct({
        action: 'clickByText', sessionId, text: step.target,
        scopeRect: overlayRect, exact: false, headed: true, timeoutMs: 10000,
      });
      if (ctResult?.ok) {
        // Click succeeded — capture post-click state for the next step's overlay
        await _captureAndStoreOverlayDiff(sessionId, step);
        return { ok: true, ref: null, verified: true, clickedText: ctResult.clickedText };
      }
      logger.info(`[instruction.runner] clickByText in overlay scope failed: ${ctResult?.error}`);
    }

    // Tier 1.6: OCR the overlay and let the LLM pick the correct row
    if (step.action === 'click' || step.action === 'dblclick') {
      logger.info(`[instruction.runner] No ref — Tier 1.6 fallback for click "${step.target}"`);
      const overlayResult = await _executeOverlayInteraction({
        goal: `Click "${step.target}"`,
        sessionId, headed: true, timeoutMs: 15000,
        skipTriggerClick: true,
        overlayRect: overlayRect || undefined,
      });
      if (overlayResult?.ok && overlayResult.action === 'pick') {
        await _captureAndStoreOverlayDiff(sessionId, step);
        return { ok: true, ref: null, verified: true, clickedText: overlayResult.selectedText, clickedAt: overlayResult.clickedAt };
      }
      logger.info(`[instruction.runner] Tier 1.6 fallback failed: ${overlayResult?.error}`);
    } else if (step.action === 'fill') {
      logger.info(`[instruction.runner] No ref — Tier 1.6 fallback for fill "${step.target}"`);
      const overlayResult = await _executeOverlayInteraction({
        goal: `Type "${step.value}" into the "${step.target}" field`,
        sessionId, headed: true, timeoutMs: 15000,
        skipTriggerClick: true,
        overlayRect: overlayRect || undefined,
      });
      if (overlayResult?.ok && overlayResult.action === 'fill_and_click') {
        return { ok: true, ref: null, verified: true, transcript: overlayResult.transcript };
      }
      logger.info(`[instruction.runner] Tier 1.6 fill fallback failed: ${overlayResult?.error}`);
    }
    return { ok: false, error: `Could not find element matching "${step.target}" in the current page` };
  }

  logger.info(`[instruction.runner] Resolved "${step.target}" → ref ${ref}`);

  // ── For click/dblclick: capture pre-click state before executing ────────
  let preState = null;
  if (step.action === 'click' || step.action === 'dblclick') {
    preState = await _captureVisibleState(sessionId);
  }

  // Execute the action
  let result;
  switch (step.action) {
    case 'click':
      result = await browserAct({ action: 'click', sessionId, selector: ref, headed: true, timeoutMs: 10000 });
      if (!result?.ok && overlayRect) {
        // Ref click failed — try clickByText in overlay scope
        logger.info(`[instruction.runner] Ref click failed — clickByText in overlay scope for "${step.target}"`);
        const ctResult = await browserAct({
          action: 'clickByText', sessionId, text: step.target,
          scopeRect: overlayRect, exact: false, headed: true, timeoutMs: 10000,
        });
        if (ctResult?.ok) result = { ok: true, clickedText: ctResult.clickedText };
      }
      if (!result?.ok) {
        // Tier 1.6 OCR fallback
        logger.info(`[instruction.runner] Ref click failed — Tier 1.6 for "${step.target}"`);
        const overlayResult = await _executeOverlayInteraction({
          goal: `Click "${step.target}"`,
          sessionId, headed: true, timeoutMs: 15000,
          skipTriggerClick: true,
          overlayRect: overlayRect || undefined,
        });
        if (overlayResult?.ok && overlayResult.action === 'pick') {
          result = { ok: true, clickedText: overlayResult.selectedText };
        }
      }
      break;
    case 'dblclick':
      result = await browserAct({ action: 'dblclick', sessionId, selector: ref, headed: true, timeoutMs: 10000 });
      if (!result?.ok && overlayRect) {
        const ctResult = await browserAct({
          action: 'clickByText', sessionId, text: step.target,
          scopeRect: overlayRect, exact: false, headed: true, timeoutMs: 10000,
        });
        if (ctResult?.ok) result = { ok: true, clickedText: ctResult.clickedText };
      }
      if (!result?.ok) {
        const overlayResult = await _executeOverlayInteraction({
          goal: `Click "${step.target}"`,
          sessionId, headed: true, timeoutMs: 15000,
          skipTriggerClick: true,
          overlayRect: overlayRect || undefined,
        });
        if (overlayResult?.ok && overlayResult.action === 'pick') {
          result = { ok: true, clickedText: overlayResult.selectedText };
        }
      }
      break;
    case 'fill':
      result = await browserAct({ action: 'fill', sessionId, selector: ref, text: step.value, headed: true, timeoutMs: 10000 });
      if (!result?.ok) {
        logger.info(`[instruction.runner] Fill failed — Tier 1.6 for "${step.target}"`);
        const overlayResult = await _executeOverlayInteraction({
          goal: `Type "${step.value}" into the "${step.target}" field`,
          sessionId, headed: true, timeoutMs: 15000,
          skipTriggerClick: true,
          overlayRect: overlayRect || undefined,
        });
        if (overlayResult?.ok && overlayResult.action === 'fill_and_click') {
          result = { ok: true, transcript: overlayResult.transcript };
        }
      }
      break;
    case 'select':
      result = await browserAct({ action: 'select', sessionId, selector: ref, value: step.value, headed: true, timeoutMs: 10000 });
      break;
    case 'check':
      result = await browserAct({ action: 'check', sessionId, selector: ref, headed: true, timeoutMs: 10000 });
      break;
    case 'uncheck':
      result = await browserAct({ action: 'uncheck', sessionId, selector: ref, headed: true, timeoutMs: 10000 });
      break;
    default:
      return { ok: false, error: `Unknown action: ${step.action}` };
  }

  // ── For click/dblclick: capture post-click state and diff to find overlay ─
  if ((step.action === 'click' || step.action === 'dblclick') && preState && result?.ok) {
    await new Promise(r => setTimeout(r, 400)); // wait for overlay animation
    const postState = await _captureVisibleState(sessionId);
    const newEls = _diffVisibleState(preState, postState);
    if (newEls.length >= 2) {
      const rect = _unionRect(newEls);
      if (rect && rect.width >= 30 && rect.height >= 30) {
        _sessionOverlays.set(sessionId, { rect, items: newEls, capturedAt: Date.now() });
        logger.info(`[instruction.runner] State-diff overlay detected: ${newEls.length} new elements, rect=${JSON.stringify(rect)}`);
      }
    } else {
      // No new overlay appeared — clear the cache (e.g. clicking inside the overlay closed it)
      if (newEls.length === 0) {
        _sessionOverlays.delete(sessionId);
        logger.info(`[instruction.runner] State-diff: no new elements after click — cleared overlay cache`);
      }
    }
  }

  return {
    ok: !!result?.ok,
    error: result?.error,
    ref,
    verified: result?.verified,
    actualValue: result?.actualValue,
  };
}

// Helper: capture post-click state and store overlay diff (used after clickByText/Tier1.6 fallbacks)
async function _captureAndStoreOverlayDiff(sessionId, step) {
  try {
    // For fallback clicks, we don't have a preState, so we can't diff.
    // But we can still try to detect the overlay that's now open by checking
    // if the cached overlay is still valid. The overlay was set by the previous
    // step's diff. If this click navigated or closed the overlay, clear it.
    // For now, just wait and let the next step's preState capture handle it.
    await new Promise(r => setTimeout(r, 400));
    // Don't clear — the next step will re-evaluate. If the overlay closed,
    // the next step's LLM resolver will fail and Tier 1.6 will be tried.
  } catch (_) {}
}

function _resolveOverlayItem(step, overlays) {
  if (!overlays || overlays.length === 0) return null;
  const target = (step.target || '').toLowerCase().trim();
  if (!target) return null;

  for (const overlay of overlays) {
    for (const item of overlay.items) {
      const text = (item.text || '').toLowerCase().trim();
      if (!text) continue;

      // Exact match
      if (text === target) return item.ref;

      // One contains the other (e.g. "Create a playlist" matches "Create a playlist with songs")
      if (text.includes(target) || target.includes(text)) return item.ref;

      // First significant word matches (e.g. target "Create" matches item "Create a playlist")
      const targetWords = target.split(/\s+/).filter(w => w.length > 2);
      const itemWords = text.split(/\s+/).filter(w => w.length > 2);
      if (targetWords.length > 0 && itemWords.length > 0) {
        if (targetWords[0] === itemWords[0]) return item.ref;
        // All target words appear in item text in order
        let tIdx = 0;
        for (let i = 0; i < itemWords.length && tIdx < targetWords.length; i++) {
          if (itemWords[i] === targetWords[tIdx]) tIdx++;
        }
        if (tIdx === targetWords.length) return item.ref;
      }
    }
  }
  return null;
}

function _getOverlayItemText(ref, overlays) {
  if (!ref || !overlays) return '';
  for (const overlay of overlays) {
    for (const item of overlay.items) {
      if (item.ref === ref) return item.text;
    }
  }
  return '';
}

function _resolveOverlayInput(step, overlays) {
  if (!overlays || overlays.length === 0) return null;
  const target = (step.target || '').toLowerCase().trim();
  if (!target) return null;

  for (const overlay of overlays) {
    for (const item of overlay.items) {
      if (!['input', 'textarea', 'select'].includes(item.tag) && !item.type && !item.placeholder) continue;
      const text = (item.text || item.placeholder || '').toLowerCase().trim();
      if (text && (text === target || text.includes(target) || target.includes(text))) return item.ref;
      const placeholder = (item.placeholder || '').toLowerCase().trim();
      if (placeholder && (placeholder.includes(target) || target.includes(placeholder))) return item.ref;
    }
  }
  return null;
}

function _filterSnapshotToOverlay(snapshot, overlay) {
  if (!overlay || !overlay.items || overlay.items.length === 0) return snapshot;
  const refSet = new Set(overlay.items.map(i => i.ref));
  return _filterSnapshotToRefs(snapshot, [...refSet]);
}

function _filterSnapshotToRefs(snapshot, refs) {
  if (!refs || refs.length === 0) return snapshot;
  const refSet = new Set(refs);
  const lines = snapshot.split('\n');
  const filtered = lines.filter(line => {
    const m = line.match(/^\s*-\s*\[(td\d+)\]/);
    if (!m) return true; // keep non-element lines
    return refSet.has(m[1]);
  });
  return filtered.join('\n');
}

// ---------------------------------------------------------------------------
// Element resolution — ask LLM which tdN ref matches the target description
// ---------------------------------------------------------------------------
async function resolveRefByIntent(step, snapshot, activeElement, deadline, context = {}) {
  // Build a concise prompt with the snapshot elements
  // The snapshot is already a YAML-like string with tdN refs
  const actionVerb = step.action === 'fill' ? 'type into' : (step.action === 'select' ? 'select from' : step.action);

  const overlayNote = context.overlayActive
    ? `\nNOTE: A dropdown/menu/modal is currently OPEN. The snapshot above shows ONLY elements inside it. Pick from these — do NOT look for elements behind the overlay.`
    : '';

  const prompt = `You are picking the best DOM element for a browser action.

ACTION: ${actionVerb} "${step.target}"
${step.value ? `VALUE TO TYPE: "${step.value}"` : ''}

Here are the visible interactive elements on the page (YAML format):
${snapshot}

${activeElement ? `Currently focused element: ${activeElement.tag} (ref=${activeElement.ref || 'none'})` : ''}${overlayNote}

Pick the SINGLE BEST element ref for this action. Consider:
- Match by text content, aria-label, placeholder, or role
- Prefer visible, non-occluded elements
- For "type" actions, prefer text inputs or textareas with matching placeholder/label (e.g. "Name", "Title", "Description")
- For "click" actions, prefer buttons/links with matching text
- The "Click" target might be one of the items in the snapshot above

Output ONLY valid JSON:
{ "ref": "td12", "confidence": "high", "reasoning": "..." }

If no element matches, output:
{ "ref": null, "confidence": "none", "reasoning": "..." }`;

  let ref = null;
  try {
    const remainingMs = deadline - Date.now();
    const response = await askWithMessages([
      { role: 'system', content: 'You pick DOM elements for browser automation. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ], { maxTokens: 200, temperature: 0.1, responseTimeoutMs: Math.min(15000, remainingMs) });

    let json = (response || '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      // Repair: extract just the JSON object (handles truncated responses)
      const objMatch = json.match(/\{[\s\S]*\}/);
      if (objMatch) {
        parsed = JSON.parse(objMatch[0]);
      } else {
        throw e;
      }
    }
    if (parsed.ref && typeof parsed.ref === 'string') {
      logger.info(`[instruction.runner] LLM resolved "${step.target}" → ${parsed.ref} (confidence=${parsed.confidence})`);
      ref = parsed.ref;
    } else {
      logger.warn(`[instruction.runner] LLM could not resolve "${step.target}": ${parsed.reasoning || 'no ref'}`);
    }
  } catch (e) {
    logger.warn(`[instruction.runner] LLM resolution failed for "${step.target}": ${e.message}`);
  }

  // Fallback: try to find by text match in the snapshot
  if (!ref) {
    ref = findRefByText(step.target, snapshot);
  }

  // Final fallback: for fill actions, use the currently focused input if nothing matched
  if (!ref && step.action === 'fill' && activeElement?.ref && (activeElement.isPrimaryInput || activeElement.tag === 'input' || activeElement.tag === 'textarea' || activeElement.isContentEditable)) {
    logger.info(`[instruction.runner] Using active element for fill "${step.target}" → ${activeElement.ref}`);
    ref = activeElement.ref;
  }

  return ref;
}

// ---------------------------------------------------------------------------
// Fallback: simple text matching in snapshot YAML
// ---------------------------------------------------------------------------
function findRefByText(target, snapshot) {
  if (!snapshot || typeof snapshot !== 'string') return null;
  const targetLower = target.toLowerCase().trim();

  // Parse lines like: "- [td12] button "Save" type=submit"
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const refMatch = line.match(/^\s*-\s*\[(td\d+)\]\s+(\w+)\s+"([^"]+)"/);
    if (refMatch) {
      const ref = refMatch[1];
      const tag = refMatch[2];
      const text = refMatch[3].toLowerCase();
      if (text.includes(targetLower) || targetLower.includes(text)) {
        logger.info(`[instruction.runner] Text fallback: "${target}" → ${ref} (${tag} "${refMatch[3]}")`);
        return ref;
      }
    }
  }

  // Try partial match
  for (const line of lines) {
    const refMatch = line.match(/^\s*-\s*\[(td\d+)\]\s+(\w+)\s+"([^"]+)"/);
    if (refMatch) {
      const ref = refMatch[1];
      const text = refMatch[3].toLowerCase();
      // Check for word overlap
      const targetWords = targetLower.split(/\s+/).filter(w => w.length > 2);
      const textWords = text.split(/\s+/).filter(w => w.length > 2);
      const overlap = targetWords.some(w => textWords.includes(w));
      if (overlap) {
        logger.info(`[instruction.runner] Partial text fallback: "${target}" → ${ref} ("${refMatch[3]}")`);
        return ref;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { runInstructionSkill, parseInstructions, parseStep, findRefByText };
