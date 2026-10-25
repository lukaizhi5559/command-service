'use strict';

/**
 * stateEyes.cjs — shared "eyes" for the tab-flow skills.
 *
 * Every tab-flow skill (tab.map, just.type, gesture, shortcut.keys,
 * meta.find, turn.loop) is only appropriate for certain page states. This
 * helper produces ONE canonical typed state read + a deterministic
 * state→skill contract table, with the tev1 decision model as the residual
 * tie-breaker for genuinely ambiguous states. Replaces the per-skill ad-hoc
 * probes that diverged — the calendar 'c' popin died because tab.map's own
 * guard was right but its sensor couldn't see the dialog.
 *
 *   const gate = await preflightStateGate({ sessionId, skill: 'tab.map', goal });
 *   if (gate.redirect) return { ok:false, suggestedAgent: gate.redirect, why: gate.why, sessionId };
 *   if (gate.abort)    return { ok:false, error: gate.reason, sessionId };
 */

const { browserAct } = require('../../browser.act.cjs');
const { hasVisibleDialog } = require('./overlayProbe.cjs');
const { askDecision, boundedDecision } = require('../../../skill-helpers/decision.cjs');

const _stateCache = new Map(); // sessionId → {state, at} — 3s reuse across the step's skills
const _STATE_TTL_MS = 3000;

const DIALOG_GOAL_RE = /\b(dialog|modal|popup|popover|compose|create.?event|new event|quick.?add|reminder|settings|preferences|share)\b/i;
const FIELD_GOAL_RE  = /\b(type|fill|enter|set|write|input|name|title|date|time|search)\b/i;
const READ_GOAL_RE   = /\b(find|read|look for|locate|search for|scan|extract|what|list|show)\b/i;

/**
 * assessPage — one cheap probe: dialog presence (widened selector),
 * fillable/clickable counts, active element, url. Dead bindings surface
 * as { dead:true } — that IS the signal.
 */
async function assessPage(sessionId) {
  const cached = _stateCache.get(sessionId);
  if (cached && Date.now() - cached.at < _STATE_TTL_MS) return cached.state;

  const state = { sessionId, dead: false, dialogOpen: false, url: '', title: '', fillables: 0, clickables: 0, activeTag: '', probeError: null };
  try {
    const [dialog, dom] = await Promise.all([
      hasVisibleDialog(sessionId).catch(() => false),
      browserAct({
        action: 'evaluate', sessionId, headed: true, timeoutMs: 3000,
        text: `JSON.stringify({u:location.href.slice(0,160),t:(document.title||'').slice(0,80),ae:(document.activeElement&&document.activeElement.tagName)||'',fl:document.querySelectorAll('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="combobox"]').length,cl:document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="link"]').length})`,
      }).then(r => {
        const raw = r?.result ?? r?.stdout;
        const s = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : '';
        try { return JSON.parse(s); } catch { return null; }
      }).catch(e => ({ probeError: String(e?.message || e) })),
    ]);
    state.dialogOpen = !!dialog;
    if (dom && !dom.probeError) {
      state.url = dom.u || ''; state.title = dom.t || '';
      state.fillables = dom.fl || 0; state.clickables = dom.cl || 0;
      state.activeTag = dom.ae || '';
    } else if (dom?.probeError) {
      state.probeError = dom.probeError;
      if (/no live tab|no engine page|no sessionId|not found|detached/i.test(dom.probeError)) state.dead = true;
    }
  } catch (e) {
    state.probeError = String(e?.message || e);
    if (/no live tab|no engine page|no sessionId|detached/i.test(state.probeError)) state.dead = true;
  }
  _stateCache.set(sessionId, { state, at: Date.now() });
  return state;
}

/**
 * preflightStateGate — deterministic state→skill contract, tev1 for the
 * uncertain bucket only. Returns {go|redirect|abort|satisfied, state, why?}.
 */
// Goals that ask to OPEN a creation surface — if the URL already IS that
// surface (eventedit, compose, /new), the goal is satisfied before any key is
// pressed. This is the primitive every layer missed: "open the create-event
// dialog via 'c'" pressed 'c' on the already-open event form and typed a
// literal 'c' into the title field.
const _OPEN_GOAL_RE = /\b(?:open|show|bring up|pull up|launch|start|create|new|add|compose|begin)\b[^.]{0,50}\b(?:dialog|modal|popup|popover|form|event|compose|page|window|doc(?:ument)?|email|task|meeting|appointment|reminder|post|message)\b/i;
const _CREATION_URL_RE = /eventedit|action=TEMPLATE|\/new\b|compose|\/create|deeplink|\/draft|\/editor/i;

function _goalAlreadySatisfied(goal, state) {
  if (!_OPEN_GOAL_RE.test(goal)) return null;
  // Creation-surface goal + creation-surface URL → the surface IS open.
  if (_CREATION_URL_RE.test(state.url || '')) {
    return `goal satisfied — creation surface already open at ${state.url.slice(0, 80)}`;
  }
  // Dialog-named goal + live dialog → the dialog IS open.
  if (state.dialogOpen && /dialog|modal|popup|popover|compose/i.test(goal)) {
    return 'goal satisfied — dialog already open';
  }
  return null;
}

async function preflightStateGate({ sessionId, skill, goal = '' }) {
  const state = await assessPage(sessionId);

  // ── Deterministic contract table ──
  if (state.dead) {
    return { abort: true, reason: 'session_dead: no live tab to act on', state };
  }
  // ── Already-satisfied check — runs before any skill-fit verdict. A step
  // asking to open a surface that's already open needs NO action at all;
  // acting on it is how 'c' got typed into the event title.
  const _sat = _goalAlreadySatisfied(goal, state);
  if (_sat) return { satisfied: true, why: _sat, state };
  if (state.probeError && !state.url) {
    // Probe failed but not clearly dead — uncertain, let tev1 break the tie
    // (fallthrough below to the model check).
  } else {
    const dialogGoal = DIALOG_GOAL_RE.test(goal);
    const fieldGoal  = FIELD_GOAL_RE.test(goal);
    const readGoal   = READ_GOAL_RE.test(goal);

    // Dialog open + skill that operates inside dialogs → go
    if (state.dialogOpen) {
      if (skill === 'just.type' || skill === 'shortcut.keys' || skill === 'gesture') return { go: true, state };
      if (skill === 'tab.map')   return { go: true, state, skipReset: true, dialogScoped: true };
      if (skill === 'meta.find' || skill === 'turn.loop' || skill === 'dom.act') return { go: true, state };
    }

    // Dialog expected by the goal but NOT open
    if (!state.dialogOpen && dialogGoal && (skill === 'just.type' || skill === 'gesture')) {
      return { redirect: 'tab.map.agent', why: 'goal expects a dialog but none is open — re-map to find the trigger', state };
    }

    // Type/fill goal with no fillable fields visible → wrong state for typing
    if (!state.dialogOpen && fieldGoal && state.fillables === 0 && skill === 'just.type') {
      return { redirect: 'tab.map.agent', why: 'no fillable fields on the page — re-map before typing', state };
    }

    // Read/find goals on a page with almost nothing → abort to replan
    if (readGoal && state.fillables === 0 && state.clickables === 0 && (skill === 'meta.find' || skill === 'tab.map')) {
      return { abort: true, reason: 'page state is empty — nothing to read or act on', state };
    }

    // Live page, no contradiction → go
    if (state.url) return { go: true, state };
  }

  // ── Uncertain bucket → tev1 tie-breaker ──
  try {
    const verdict = await boundedDecision({
      site: 'stateeyes.preflight',
      askDecision,
      questions: [{
        id: 'fit', type: 'choice',
        question: `Is "${skill}" the right action for this page state and goal?`,
        options: ['go — appropriate', 'redirect — a different skill fits better', 'abort — state too uncertain'],
      }],
      state: `goal="${String(goal).slice(0, 120)}" url=${state.url || 'unknown'} dialog=${state.dialogOpen} fillables=${state.fillables} clickables=${state.clickables} probeError=${state.probeError || 'none'}`,
      local: (a) => a.fit?.index ?? null,
      remote: async () => 0, // fail-open: go
    });
    if (verdict === 1) return { redirect: 'tab.map.agent', why: 'eyes: state ambiguous — re-map first', state };
    if (verdict === 2) return { abort: true, reason: 'eyes: state too uncertain for this skill', state };
  } catch (_) { /* decision down → deterministic default: go */ }

  return { go: true, state };
}

module.exports = { assessPage, preflightStateGate };
