'use strict';

// ---------------------------------------------------------------------------
// just.type.agent.cjs — Atomic agent: type a value into the focused element,
// or send a single keypress (PRESS_<KEY>) for press/scroll/submit goals.
//
// Tier-1 executor. Runs when a field is already focused (autofocus or the
// previous step focused it). Refuses to type blindly when nothing is focused
// and no overlay is open — returns suggestedAgent so the graph can replan.
//
// Contract:
//   args: { goal, value?, sessionId, agentId?, pageCategory?, agentContext?, _progressCallbackUrl? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const { _executeJustType } = require('./lib/browserCore/typing.cjs');
const { _extractValue } = require('./browser.agent.cjs');
const { readActiveElement, detectOverlay } = require('./lib/browserCore/pageState.cjs');
const { withSessionMutex } = require('./lib/browserCore/session.cjs');
const { postProgress } = require('./lib/browserCore/progress.cjs');
const { inferPageCategory } = require('../skill-helpers/page-category.cjs');
const { PRESS_KEY_RE } = require('./lib/browserCore/router.cjs');

// Map a press/scroll goal to a PRESS_<KEY> value the typing layer understands.
function _pressKeyFromGoal(goal) {
  const g = String(goal || '').toLowerCase();
  if (/\bscroll\b[\s\S]{0,30}?\bbottom\b/.test(g) || /\bpress\b[^.]*\bend\b/.test(g)) return 'PRESS_END';
  if (/\bscroll\b[\s\S]{0,30}?\btop\b/.test(g) || /\bpress\b[^.]*\bhome\b/.test(g)) return 'PRESS_HOME';
  if (/\bscroll\s*down\b|\bpage\s*down\b|\bpress\b[^.]*\bpage\s*down\b/.test(g)) return 'PRESS_PAGEDOWN';
  if (/\bscroll\s*up\b|\bpage\s*up\b|\bpress\b[^.]*\bpage\s*up\b/.test(g)) return 'PRESS_PAGEUP';
  if (/\benter\b|\breturn\b/.test(g)) return 'PRESS_ENTER';
  if (/\btab\b/.test(g)) return 'PRESS_TAB';
  if (/\besc(?:ape)?\b/.test(g)) return 'PRESS_ESCAPE';
  if (/\bspace(?:\s*bar)?\b/.test(g)) return 'PRESS_SPACE';
  if (/\bbackspace\b/.test(g)) return 'PRESS_BACKSPACE';
  if (/\bdelete\b/.test(g)) return 'PRESS_DELETE';
  if (/\b(?:arrow\s*)?down\b/.test(g)) return 'PRESS_DOWN';
  if (/\b(?:arrow\s*)?up\b/.test(g)) return 'PRESS_UP';
  if (/\b(?:arrow\s*)?left\b/.test(g)) return 'PRESS_LEFT';
  if (/\b(?:arrow\s*)?right\b/.test(g)) return 'PRESS_RIGHT';
  if (/\bend\b/.test(g)) return 'PRESS_END';
  if (/\bhome\b/.test(g)) return 'PRESS_HOME';
  return 'PRESS_ENTER';
}

async function justTypeAgent(args = {}) {
  const { goal = '', sessionId, agentId = '', agentContext = '', _progressCallbackUrl } = args;
  let pageCategory = args.pageCategory || 'web_generic';
  if (!sessionId) return { ok: false, error: 'just.type.agent: no sessionId' };
  if (!goal) return { ok: false, error: 'just.type.agent: no goal' };

  // Self-derive category for standalone/direct calls (the dom.act path already
  // resolves it; keep a fallback so direct skill calls get category gating too).
  if (pageCategory === 'web_generic') {
    try { pageCategory = await inferPageCategory({ agentId, task: goal }); } catch (_) {}
  }

  return withSessionMutex(sessionId, async () => {
    const [focused, overlay] = await Promise.all([
      readActiveElement(sessionId).catch(() => null),
      detectOverlay(sessionId, pageCategory).catch(() => null),
    ]);
    const overlayActive = !!(overlay && overlay.active);

    // Press-key / scroll goal — a keystroke needs no fillable target.
    if (PRESS_KEY_RE.test(goal)) {
      const value = _pressKeyFromGoal(goal);
      postProgress(_progressCallbackUrl, { tier: 'just-type', message: `just.type.agent: ${value}` });
      const res = await _executeJustType(sessionId, value, focused, pageCategory, goal, agentContext, null, overlayActive, []);
      const obs = res?.observation;
      return {
        ok: !!res?.ok,
        output: res?.ok
          ? `Pressed ${value.replace('PRESS_', '')}` + (obs ? ` — scroll ${obs.scrollY}/${obs.scrollHeight}px${obs.atBottom ? ' (bottom reached)' : ''}` : '')
          : undefined,
        error: res?.error,
        observation: obs,
        // No focus and no scrollable page → let turn.loop observe+act.
        suggestedAgent: res?.ok ? undefined : (res?.suggestedAgent || 'turn.loop.agent'),
        sessionId,
        actionHistory: [`${value} ${res?.ok ? '→ ok' : '→ FAILED'}`],
      };
    }

    if (!focused && !overlayActive) {
      logger.warn('[just.type.agent] no focused element and no overlay — cannot type blindly');
      return { ok: false, error: 'No focused element and no overlay open', suggestedAgent: 'tab.map.agent' };
    }

    let value = args.value;
    if (!value) {
      try { value = await _extractValue(goal, focused, [], agentContext); } catch (_) {}
    }
    if (!value) return { ok: false, error: 'Could not extract value to type from goal', suggestedAgent: 'tab.map.agent' };

    postProgress(_progressCallbackUrl, { tier: 'just-type', message: `just.type.agent: typing "${String(value).slice(0, 50)}"` });
    const actionHistory = [];
    const res = await _executeJustType(sessionId, value, focused, pageCategory, goal, agentContext, null, overlayActive, actionHistory);
    // Record what happened — the returned history/fill feeds the cross-step
    // browser digest and lets the next step's LLM see this field as filled.
    const _label = (focused?.ariaLabel || focused?.text || focused?.placeholder || '').slice(0, 80);
    actionHistory.push(`Just-type "${String(value).slice(0, 40)}"${_label ? ` into "${_label}"` : ''} ${res?.ok ? '→ ok' : '→ FAILED'}`);
    const filledFields = res?.ok ? [{ ref: focused?.ref || null, label: _label || 'focused element', value }] : [];
    // A mis-landed/not-landed value is a focus problem — hand off to an agent
    // that can click the right field (turn.loop), not another typing tier.
    const failAgent = res?.suggestedAgent || 'tab.map.agent';
    return { ok: !!res?.ok, output: res?.ok ? `Typed "${String(value).slice(0, 60)}"` : undefined, error: res?.error, suggestedAgent: res?.ok ? undefined : failAgent, sessionId, actionHistory, filledFields };
  });
}

module.exports = { justTypeAgent };
