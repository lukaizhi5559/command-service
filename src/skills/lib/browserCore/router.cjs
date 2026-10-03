'use strict';

// ---------------------------------------------------------------------------
// browserCore/router.cjs — deterministic on-page-action router.
//
// Picks which atomic agent should execute an `on-page-action` step AFTER the
// page has loaded, using real DOM signals (probePageStructure) instead of a
// plan-time guess. Pure heuristics — no LLM calls.
//
// Cascade order (first match wins; gated by category allowedTiers):
//   1. agentHint        — valid planner hint overrides everything
//   2. gesture verbs    — drag/slider/swipe goal               → gesture.agent
//   3. spreadsheet grid — grid+formula-bar signals             → arrow.grid.agent
//   4. autofocus+type   — editable element already focused     → just.type.agent
//   5. shortcut match   — goal verb matches a known app hotkey → shortcut.keys.agent
//   6. find-text goal   — locate text on the current page      → meta.find.agent
//   7. commerce mut.    — dense product host + cart/checkout   → turn.loop.agent
//   8. default          — actionable elements present          → tab.map.agent
//   9. fallback         — nothing actionable                   → turn.loop.agent
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { probePageStructure, readActiveElement, detectOverlay } = require('./pageState.cjs');
const { loadShortcutTable } = require('./knowledge.cjs');
const { getCategoryConfig } = require('../../../skill-helpers/category-config.cjs');
const { browserAct } = require('../../browser.act.cjs');

const ONPAGE_AGENTS = new Set([
  'just.type.agent', 'meta.find.agent', 'shortcut.keys.agent',
  'tab.map.agent', 'gesture.agent', 'arrow.grid.agent', 'turn.loop.agent',
]);

// tier → agent mapping (mirrors instruction.runner tier numbers so
// category-config allowedTiers can gate agent choices unchanged)
const TIER_TO_AGENT = {
  1: 'just.type.agent',
  2: 'meta.find.agent',
  3: 'shortcut.keys.agent',
  4: 'tab.map.agent',
  5: 'gesture.agent',
  6: 'arrow.grid.agent',
};

const GESTURE_VERB_RE = /\b(drag|drop|drag\s+and\s+drop|slider|swipe|resize|reorder|scrub)\b/i;
const FIND_VERB_RE = /\b(find|locate|search\s+for|jump\s+to|go\s+to)\s+(the\s+)?(text|word|phrase|cell|row|item|entry|message|email|post|comment)\b/i;
const TYPE_GOAL_RE = /\b(type|enter|fill|input|write|paste|set)\b/i;
const COMMERCE_HOST_RE = /^(www\.)?(amazon|ebay|etsy|walmart|target|aliexpress|bestbuy|shopify|costco|homedepot|lowes)\./i;
const COMMERCE_MUTATION_RE = /\b(add\s+to\s+(cart|bag|basket)|checkout|buy\s+now|purchase|place\s+order|filter\s+by|sort\s+by|add_to_cart|place_order)\b/i;
// Verb → likely shortcut-bearing goal ("open the create dialog", "compose")
const SHORTCUT_VERB_RE = /\b(create|compose|new|open|search|navigate|switch|jump|focus)\b/i;
// Read/extract intent — "search for unread emails", "check my inbox",
// "read the messages". Content-search goals must NOT reach the keyboard
// layer — they need navigate-and-extract (tab.map / turn.loop).
const READ_EXTRACT_RE = /\b(search|find|look|check|read|list|show|get|extract|summari[sz]e|review)\b[\s\S]{0,60}?\b(emails?|mail|messages?|inbox|posts?|comments?|notifications?|results?|items?|documents?|files?|videos?|events?|content|unread|threads?|repl(?:y|ies)|responses?)\b/i;

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

function allowedAgents(pageCategory) {
  const cfg = getCategoryConfig(pageCategory);
  const tiers = cfg?.allowedTiers || (pageCategory === 'spreadsheet' ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]);
  const agents = new Set(tiers.map(t => TIER_TO_AGENT[t]).filter(Boolean));
  agents.add('turn.loop.agent'); // turn-loop is always an eligible fallback
  return agents;
}

// Cheap deterministic "does the goal match a known app shortcut" check.
// Abstention-biased: a single-word desc overlap is not enough for a long
// goal ("search gmail for unread emails" ↔ desc "search mail") — only
// short goals ("compose", "open compose") keep the single-hit path.
function matchShortcut(goal, shortcutTable) {
  if (!SHORTCUT_VERB_RE.test(goal)) return null;
  const g = goal.toLowerCase();
  const goalWordCount = g.split(/\s+/).filter(Boolean).length;
  let best = null;
  for (const s of shortcutTable) {
    const desc = (s.desc || '').toLowerCase();
    if (!desc) continue;
    // e.g. goal "create a new event" matches desc "create a new event" / "create"
    const words = desc.split(/\W+/).filter(w => w.length >= 4);
    // Whole-word match — "mail" must not hit inside "gmail".
    const hits = words.filter(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(goal)).length;
    const confident = hits >= 2 || (hits === 1 && goalWordCount <= 3);
    if (confident && (!best || hits > best.hits)) best = { hits, shortcut: s };
  }
  return best?.shortcut || null;
}

// Ambiguous-verb fallback — word-boundary regexes cannot separate
// "press the search shortcut" from "search my inbox". One cheap semantic
// call classifies the lane; on any error we abstain (fall through to the
// generalist cascade) rather than guess.
async function _confirmGoalLane(goal) {
  try {
    const { askWithMessages } = require('../../../skill-helpers/skill-llm.cjs');
    const raw = await askWithMessages([
      { role: 'system', content: 'Classify a browser on-page action goal into exactly one lane. Answer with ONLY the lane name.\n- "shortcut" — press a keyboard shortcut / app hotkey (e.g. "press the compose shortcut", "open the create dialog")\n- "read" — search/read/extract page content for the user (e.g. "search my inbox", "check unread emails", "read the messages")\n- "find" — locate specific text on the current page (e.g. "find the word hello", "jump to the message")\n- "action" — a UI action: click, type, navigate, submit (e.g. "click save", "fill the form")' },
      { role: 'user', content: `Goal: "${String(goal).slice(0, 200)}"` },
    ], { maxTokens: 12, temperature: 0, responseTimeoutMs: 4000 });
    const lane = (raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    return ['shortcut', 'read', 'find', 'action'].includes(lane) ? lane : null;
  } catch (e) {
    logger.warn(`[router] lane-confirm LLM failed (${e.message}) — abstaining`);
    return null;
  }
}

// True when a mutation goal carries several distinct values or a structural
// spec — beyond tab.map's single-lane step budget; the generalist loop
// observes+acts across multi-field forms.
function _isMultiPartGoal(goal) {
  const g = String(goal || '');
  return (g.match(/'[^']{2,120}'|"[^"]{2,120}"/g) || []).length >= 2
    || /\bwith\b[^.]{0,80}\b(columns?|headers?|fields?|rows?|sections?|slides?)\b/i.test(g)
    || /\b(columns?|headers?|fields?|rows?|sections?)\s+(for|named|called|of)\b[^.]{0,100},/i.test(g);
}

/**
 * Route an on-page-action goal to an atomic agent.
 * @param {object} p
 * @param {string} p.sessionId — active browser session
 * @param {string} p.goal — the step's task text
 * @param {string} [p.pageCategory] — known/guessed page category
 * @param {string} [p.agentHint] — planner-provided override (validated)
 * @param {Set<string>} [p.triedAgents] — agents already tried for this step (replan)
 * @param {string} [p.currentUrl] — if known; else probed from the page
 * @returns {Promise<{agent:string, rule:string, probe:object, overlayActive:boolean, currentUrl:string, focused:object}>}
 */
async function routeOnPageAction({ sessionId, goal, pageCategory = 'web_generic', agentHint = null, triedAgents = null, currentUrl = '' }) {
  const [probe, focused, overlay] = await Promise.all([
    probePageStructure(sessionId).catch(() => null),
    readActiveElement(sessionId).catch(() => null),
    detectOverlay(sessionId, pageCategory).catch(() => null),
  ]);
  const overlayActive = !!(overlay && overlay.active);
  if (!currentUrl) {
    try {
      const res = await browserAct({ action: 'evaluate', sessionId, headed: true, timeoutMs: 2000, text: 'window.location.href' });
      const raw = res?.result;
      currentUrl = typeof raw === 'string' ? raw.replace(/^"|"$/g, '') : (raw || '');
    } catch (_) {}
  }
  const allowed = allowedAgents(pageCategory);
  const tried = triedAgents instanceof Set ? triedAgents : new Set(triedAgents || []);
  const pick = (agent, rule) => {
    if (!allowed.has(agent) || tried.has(agent)) return null;
    return { agent, rule, probe, overlayActive, currentUrl, focused };
  };

  // 1. Planner hint — valid on-page agent that isn't tried wins outright.
  if (agentHint && ONPAGE_AGENTS.has(agentHint)) {
    const hit = pick(agentHint, `hint:${agentHint}`);
    if (hit) return hit;
    logger.warn(`[router] agentHint "${agentHint}" not allowed for category=${pageCategory} or already tried — falling back to cascade`);
  } else if (agentHint) {
    logger.warn(`[router] ignoring invalid agentHint "${agentHint}"`);
  }

  // 2. Gesture verbs
  if (GESTURE_VERB_RE.test(goal)) {
    const hit = pick('gesture.agent', 'gesture-verb');
    if (hit) return hit;
  }

  // 3. Spreadsheet grid — only for cell nav/fill goals. Google Sheets renders
  //    its grid in CANVAS — DOM grid signals never fire there, so detect the
  //    editor by URL too (covers docs.google.com/spreadsheets).
  const sig = probe?.categorySignals || {};
  const isGrid = pageCategory === 'spreadsheet'
    || /\/spreadsheets?\//i.test(currentUrl)
    || (sig.hasGrid && (sig.hasFormulaBar || sig.hasGridCell));
  if (isGrid && /\b(cell|column|row|spreadsheet|sheet|fill|enter|type|a1|b2)\b/i.test(goal)) {
    const hit = pick('arrow.grid.agent', 'spreadsheet-grid');
    if (hit) return hit;
  }

  // 4. Autofocused editable element + type/fill goal — but only for SINGLE-
  //    field goals. just.type.agent performs exactly one type action; compound
  //    goals (multiple fields, quoted values, submit verbs, "and" clauses)
  //    need the tab.map loop (observed: "Fill To/Subject/Body and send"
  //    routed here → only To filled → step falsely reported done).
  const focusedEditable = !!(focused && (focused.isContentEditable || /^(INPUT|TEXTAREA)$/.test(focused.tag) || focused.role === 'textbox' || focused.role === 'combobox'));
  const _compoundGoal =
    /\b(?:send|submit|save|post|publish|click|attach|sign)\b/i.test(goal) ||
    /\b(?:to|subject|body|cc|bcc|from|message|title|description)\s*:/i.test(goal) ||
    (goal.match(/"[^"]+"/g) || []).length > 1 ||
    /\band\b[\s\S]*\b(?:type|fill|enter|click|send|press)\b/i.test(goal);
  if (!_compoundGoal && (probe?.hasAutoFocus || focusedEditable) && TYPE_GOAL_RE.test(goal)) {
    const hit = pick('just.type.agent', 'autofocus-type');
    if (hit) return hit;
  }

  // 4.5 Read/extract goal — "search for unread emails", "check the inbox".
  // These are navigate-and-extract tasks (perform the search UI, read the
  // results), NOT keyboard-shortcut presses — route before the shortcut rule.
  if (READ_EXTRACT_RE.test(goal)) {
    const hit = pick('tab.map.agent', 'read-extract')
      || pick('turn.loop.agent', 'read-extract-fallback');
    if (hit) return hit;
  }

  // 5. Known app shortcut matches the goal verb
  const shortcuts = loadShortcutTable(hostnameOf(currentUrl));
  if (shortcuts.length > 0 && matchShortcut(goal, shortcuts)) {
    const hit = pick('shortcut.keys.agent', 'shortcut-match');
    if (hit) return hit;
  }

  // 5b. Ambiguous-verb zone — goal has a shortcut-ish verb but no confident
  // table match and no read/extract object. One semantic call resolves what
  // word-boundary regexes can't ("search" = press `/` vs. find content).
  // Abstains to the generalist cascade on error/timeout.
  if (SHORTCUT_VERB_RE.test(goal)) {
    const lane = await _confirmGoalLane(goal);
    if (lane === 'shortcut') {
      const hit = pick('shortcut.keys.agent', 'llm-confirm:shortcut');
      if (hit) return hit;
    } else if (lane === 'find') {
      const hit = pick('meta.find.agent', 'llm-confirm:find');
      if (hit) return hit;
    } else if (lane === 'read' || lane === 'action') {
      const hit = pick('tab.map.agent', `llm-confirm:${lane}`)
        || pick('turn.loop.agent', `llm-confirm:${lane}-fallback`);
      if (hit) return hit;
    }
  }

  // 6. Find-text-on-page goal
  if (FIND_VERB_RE.test(goal)) {
    const hit = pick('meta.find.agent', 'find-text');
    if (hit) return hit;
  }

  // 7. Commerce mutation on a dense product host
  if (COMMERCE_HOST_RE.test(hostnameOf(currentUrl)) && COMMERCE_MUTATION_RE.test(goal)) {
    const hit = pick('turn.loop.agent', 'commerce-mutation');
    if (hit) return hit;
  }

  // 7.5 Multi-part mutation goals — several distinct values or a structural
  //     spec ("with column headers for a, b, c") exceed tab.map's single-lane
  //     step budget: it fills one field then exhausts before committing the
  //     rest. The generalist loop observes+acts across multi-field forms.
  if (_isMultiPartGoal(goal)) {
    const hit = pick('turn.loop.agent', 'multi-part-goal');
    if (hit) return hit;
  }

  // 8. Default: actionable elements present → Tab-Map
  if ((probe?.fillableCount || 0) + (probe?.clickableCount || 0) > 0) {
    const hit = pick('tab.map.agent', 'default-actionable');
    if (hit) return hit;
  }

  // 9. Nothing actionable — general fallback
  const fallback = pick('turn.loop.agent', 'fallback')
    || { agent: 'turn.loop.agent', rule: 'fallback-forced', probe, overlayActive, currentUrl, focused };
  return fallback;
}

module.exports = { routeOnPageAction, ONPAGE_AGENTS, TIER_TO_AGENT, _isMultiPartGoal };
