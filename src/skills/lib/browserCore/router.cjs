'use strict';

// ---------------------------------------------------------------------------
// browserCore/router.cjs — deterministic on-page-action router.
//
// Picks which atomic agent should execute an `on-page-action` step AFTER the
// page has loaded, using real DOM signals (probePageStructure) instead of a
// plan-time guess. Pure heuristics — one optional cheap LLM lane-confirm call.
//
// Cascade order (first match wins; gated by category allowedTiers):
//   1. agentHint        — valid planner hint overrides everything
//   2. gesture verbs    — drag/slider/swipe goal               → gesture.agent
//   3. spreadsheet grid — grid+formula-bar signals             → arrow.grid.agent
//   3.9 press-key       — press Enter/scroll/submit-key goals  → just.type.agent
//   4. autofocus+type   — editable element already focused     → just.type.agent
//   4.5 read-extract    — leading read verb + content noun     → tab.map.agent
//   4.7 click-named     — open/click a quoted named item       → meta.find.agent
//   5. shortcut match   — goal verb matches a known app hotkey → shortcut.keys.agent
//   5b. llm-confirm     — ambiguous verb, one semantic call    → (resolved lane)
//   6. find-text goal   — locate text on the current page      → meta.find.agent
//   7. commerce mut.    — dense product host + cart/checkout   → turn.loop.agent
//   7.5 multi-part      — form surface → tab.map / seq → turn.loop
//   7.6 type-unfocused  — single-field type, no focus          → turn.loop.agent
//   8. default          — actionable elements present          → tab.map.agent
//   9. fallback         — nothing actionable                   → turn.loop.agent
//
// Lane regexes run on a QUOTE-STRIPPED copy of the goal — payload text inside
// '…'/"…" must not register verbs ("type 'Search for X'" is not a search goal).
// Quoted-EXISTENCE checks (multi-value, click-named) use the raw goal.
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');
const { probePageStructure, readActiveElement, detectOverlay } = require('./pageState.cjs');
const { loadShortcutTable } = require('./knowledge.cjs');
const { getCategoryConfig } = require('../../../skill-helpers/category-config.cjs');
const { hostCategory } = require('../../../skill-helpers/page-category.cjs');
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
const COMMERCE_MUTATION_RE = /\b(?:add\b[^.]{0,40}?\b(?:to|into)\s+(?:my\s+|the\s+|your\s+)?(?:cart|bag|basket)|checkout|buy\s+now|purchase|place\s+order|filter\s+by|sort\s+by|add_to_cart|place_order)\b/i;
// Verb → likely shortcut-bearing goal ("open the create dialog", "compose")
const SHORTCUT_VERB_RE = /\b(create|compose|new|open|search|navigate|switch|jump|focus)\b/i;
// Read/extract intent — "search for unread emails", "check my inbox",
// "read the messages". Content-search goals must NOT reach the keyboard
// layer — they need navigate-and-extract (tab.map / turn.loop).
const READ_EXTRACT_RE = /\b(search|find|look|check|read|list|show|get|extract|summari[sz]e|review)\b[\s\S]{0,60}?\b(emails?|mail|messages?|inbox|posts?|comments?|notifications?|results?|items?|documents?|files?|videos?|events?|content|unread|threads?|repl(?:y|ies)|responses?)\b/i;

// Press-key goals — a single keystroke answers the whole goal ("press Enter to
// submit", "scroll to the bottom"). just.type sends the key on the focused
// element/body — no DOM scan needed. Scroll variants fold in via key map.
// (single regex — `||` between regex literals would silently keep only the
// first; a RegExp object is always truthy)
const PRESS_KEY_RE = /(?:\b(?:press|hit|push|tap)\s+(?:the\s+)?(?:enter|return|tab|esc(?:ape)?|space(?:\s*bar)?|backspace|delete|end|home|page\s*(?:up|down)|up|down|left|right|arrow\s*(?:up|down|left|right))\b)|(?:\bscroll\b[\s\S]{0,30}?\b(?:up|down|top|bottom|left|right)\b)|(?:^scroll\s*(?:up|down)?$)/i;

// Named-item goals — "open the chat 'frog legs'", "click 'Save'", "go to the
// 'Settings' tab". meta.find locates the text and clicks it. Quoted names are
// the strong signal; bare well-known button labels ("click Send") also qualify.
const CLICK_NAMED_VERB_RE = /\b(open|click|select|choose|go\s*to|goto|jump\s+to|switch\s+to|expand|view)\b/i;
const CLICK_BUTTON_RE = /\bclick\s+(?:the\s+)?(send|submit|post|confirm|save|close|ok|next|continue|back|add|buy|sign\s*in|log\s*in|yes|no|agree|accept)\b/i;

// First action-class verb in the (sanitized) goal — used to keep mutation
// goals out of the read lane: "send an email with the list of videos" leads
// with `send`, so read-extract must not fire.
const _FIRST_VERB_RE = /\b(send|compose|reply|forward|post|tweet|publish|create|upload|book|schedule|buy|purchase|checkout|order|delete|remove|comment|like|follow|subscribe|add|fill|type|click|enter|submit|sign|rsvp|invite|download|play|open|navigate|visit|press|hit|push|scroll|drag|select|choose|attach|archive|star|mute|print|save)\b/i;
const _LEADING_READ_RE = /^\s*(?:please\s+|can you\s+|could you\s+)?(search|find|look|check|read|list|show|get|extract|summari[sz]e|review|go\s+to|jump\s+to)\b/i;

// Categories whose canonical task is a SINGLE text field — a focused editable
// + a type goal should hit just.type even when the goal carries click/submit
// verbs ("click the message input and type 'X'"). The click is already
// satisfied by autofocus; multi-field markers still block.
const _SINGLE_FIELD_CATS = new Set([
  'ai_chat', 'messaging', 'search_engine', 'shopping',
  'social_feed', 'cloud_storage', 'media_player', 'news_content',
]);

// Strip quoted payload spans ('…', "…", `…`) so lane regexes see only the
// goal's own verbs — the value being typed must not register as a command.
function stripQuoted(goal) {
  return String(goal || '')
    .replace(/'[^']{0,400}'|"[^"]{0,400}"|`[^`]{0,400}`/g, ' ')
    .replace(/\s+/g, ' ');
}

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
// spec — beyond a single type/click. Split at routing time by surface: form
// fields present → tab.map's ref-assigned fill loop; no form surface →
// turn.loop's observe+act sequence.
function _isMultiPartGoal(goal) {
  const g = String(goal || '');
  return (g.match(/'[^']{1,120}'|"[^"]{1,120}"/g) || []).length >= 2
    || /\bwith\b[^.]{0,80}\b(columns?|headers?|fields?|rows?|sections?|slides?|subject|body|message)\b/i.test(g)
    || /\b(columns?|headers?|fields?|rows?|sections?)\s+(for|named|called|of)\b[^.]{0,100},/i.test(g)
    // field-name + quoted value specs: "subject 'X' and body 'Y'"
    || (g.match(/\b(?:to|subject|body|cc|bcc|from|message|title|description|name|date|time|location|city|zip|quantity|size)\s*[:=]?\s*['"`]/gi) || []).length >= 2;
}

/**
 * _routeFromSignals — pure cascade over already-gathered page signals.
 * Exported for headless tests; `confirmLane` is injectable (default: real LLM
 * call) so tests never hit the network.
 */
async function _routeFromSignals({ goal, pageCategory = 'web_generic', focused, probe, overlayActive, currentUrl, triedAgents, agentHint, confirmLane }) {
  const allowed = allowedAgents(pageCategory);
  const tried = triedAgents instanceof Set ? triedAgents : new Set(triedAgents || []);
  const pick = (agent, rule) => {
    if (!allowed.has(agent) || tried.has(agent)) return null;
    return { agent, rule, probe, overlayActive, currentUrl, focused, pageCategory };
  };

  const goalVerbs = stripQuoted(goal);
  const focusedEditable = !!(focused && (focused.isContentEditable || /^(INPUT|TEXTAREA)$/.test(focused.tag) || focused.role === 'textbox' || focused.role === 'combobox'));

  // 1. Planner hint — valid on-page agent that isn't tried wins outright.
  if (agentHint && ONPAGE_AGENTS.has(agentHint)) {
    const hit = pick(agentHint, `hint:${agentHint}`);
    if (hit) return hit;
    logger.warn(`[router] agentHint "${agentHint}" not allowed for category=${pageCategory} or already tried — falling back to cascade`);
  } else if (agentHint) {
    logger.warn(`[router] ignoring invalid agentHint "${agentHint}"`);
  }

  // 2. Gesture verbs
  if (GESTURE_VERB_RE.test(goalVerbs)) {
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
  if (isGrid && /\b(cell|column|row|spreadsheet|sheet|fill|enter|type|a1|b2)\b/i.test(goalVerbs)) {
    const hit = pick('arrow.grid.agent', 'spreadsheet-grid');
    if (hit) return hit;
  }

  // 3.9 Press-key goal — "press Enter to submit", "scroll to the bottom".
  //     Single keystroke on the focused element/body; no DOM scan needed.
  //     Runs BEFORE autofocus-type: "enter" is both a key name and a type verb,
  //     and an autofocused field must not turn a keypress goal into a typing
  //     one. Goals that actually carry type/fill payload skip this lane.
  const _goalHasTypePayload = /\b(?:type|fill|write|paste|input)\b/i.test(goalVerbs)
    || (goal.match(/"[^"]{1,80}"|'[^']{1,80}'|`[^`]{1,80}`/g) || []).length > 0;
  if (PRESS_KEY_RE.test(goalVerbs) && !_goalHasTypePayload) {
    const hit = pick('just.type.agent', 'press-key')
      || pick('turn.loop.agent', 'press-key-fallback');
    if (hit) return hit;
  }

  // 4. Autofocused editable element + type/fill goal — but only for SINGLE-
  //    field goals. just.type.agent performs exactly one type action; compound
  //    goals (multiple fields, quoted values, "and" chains) need a looping
  //    executor. Split by category: single-field cats (ai_chat, search, …)
  //    ignore click/submit verbs — the field is already focused, and just.type
  //    presses Enter itself to submit.
  const _multiField =
    /\b(?:to|subject|body|cc|bcc|from|message|title|description)\s*:/i.test(goalVerbs) ||
    (goal.match(/"[^"]+"|'[^']+'|`[^`]+`/g) || []).length > 1;
  const _submitishChain =
    /\band\b[\s\S]*\b(?:type|fill|enter|click|send|press)\b/i.test(goalVerbs) ||
    /\b(?:send|submit|save|post|publish|click|attach|sign)\b/i.test(goalVerbs);
  const _compoundGoal = _multiField || (_submitishChain && !_SINGLE_FIELD_CATS.has(pageCategory));
  if (!_compoundGoal && (probe?.hasAutoFocus || focusedEditable) && TYPE_GOAL_RE.test(goalVerbs)) {
    const hit = pick('just.type.agent', 'autofocus-type');
    if (hit) return hit;
  }

  // 4.5 Read/extract goal — "search for unread emails", "check the inbox".
  // Leading-verb gate: a mutation goal that merely mentions read-class nouns
  // ("send an email with the list of X's videos") must NOT take this lane.
  const _firstVerb = (goalVerbs.match(_FIRST_VERB_RE) || [])[0];
  const _leadsRead = _LEADING_READ_RE.test(goalVerbs) || (READ_EXTRACT_RE.test(goalVerbs) && !_firstVerb);
  if (_leadsRead && READ_EXTRACT_RE.test(goalVerbs)) {
    const hit = pick('tab.map.agent', 'read-extract')
      || pick('turn.loop.agent', 'read-extract-fallback');
    if (hit) return hit;
  }

  // 4.7 Click-named — open/click a specific quoted item ("the chat 'frog
  //     legs'") or a well-known button label ("click Send"). meta.find does a
  //     page find + click — cheaper and more accurate than a full map scan.
  const _hasQuotedName = (goal.match(/"[^"]{2,80}"|'[^']{2,80}'|`[^`]{2,80}`/g) || []).length > 0;
  if ((_hasQuotedName && CLICK_NAMED_VERB_RE.test(goalVerbs)) || CLICK_BUTTON_RE.test(goalVerbs)) {
    const hit = pick('meta.find.agent', 'click-named')
      || pick('tab.map.agent', 'click-named-fallback');
    if (hit) return hit;
  }

  // 5. Known app shortcut matches the goal verb
  const shortcuts = loadShortcutTable(hostnameOf(currentUrl));
  if (shortcuts.length > 0 && matchShortcut(goalVerbs, shortcuts)) {
    const hit = pick('shortcut.keys.agent', 'shortcut-match');
    if (hit) return hit;
  }

  // 5b. Ambiguous-verb zone — goal has a shortcut-ish verb but no confident
  //     table match and no read/extract object. One semantic call resolves
  //     what word-boundary regexes can't. Runs on the sanitized goal.
  if (SHORTCUT_VERB_RE.test(goalVerbs)) {
    const lane = await (confirmLane || _confirmGoalLane)(goalVerbs);
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
  if (FIND_VERB_RE.test(goalVerbs)) {
    const hit = pick('meta.find.agent', 'find-text');
    if (hit) return hit;
  }

  // 7. Commerce mutation on a dense product host
  if (COMMERCE_HOST_RE.test(hostnameOf(currentUrl)) && COMMERCE_MUTATION_RE.test(goalVerbs)) {
    const hit = pick('turn.loop.agent', 'commerce-mutation');
    if (hit) return hit;
  }

  // 7.5 Multi-part goals — several distinct values or a structural spec.
  //     Form surface (overlay open or ≥2 fillables) → tab.map's ref-assigned
  //     fill loop (To/Subj/Body/Send is its wheelhouse). No form → an action
  //     sequence → turn.loop observes+acts.
  if (_isMultiPartGoal(goal)) {
    const _formSurface = overlayActive || (probe?.fillableCount || 0) >= 2;
    const hit = _formSurface
      ? (pick('tab.map.agent', 'multi-field-form') || pick('turn.loop.agent', 'multi-field-fallback'))
      : (pick('turn.loop.agent', 'multi-part-seq') || pick('tab.map.agent', 'multi-part-fallback'));
    if (hit) return hit;
  }

  // 7.6 Single-field type goal on an UNFOCUSED field (no overlay) — turn.loop
  //     clicks the field then types; cheaper than a full map scan for one
  //     input. Multi-part/overlay goals were handled above.
  if (TYPE_GOAL_RE.test(goalVerbs) && !(probe?.hasAutoFocus || focusedEditable)
      && (probe?.fillableCount || 0) > 0 && !overlayActive) {
    const hit = pick('turn.loop.agent', 'type-unfocused')
      || pick('tab.map.agent', 'type-unfocused-fallback');
    if (hit) return hit;
  }

  // 8. Default: actionable elements present → Tab-Map
  if ((probe?.fillableCount || 0) + (probe?.clickableCount || 0) > 0) {
    const hit = pick('tab.map.agent', 'default-actionable');
    if (hit) return hit;
  }

  // 9. Nothing actionable — general fallback
  return pick('turn.loop.agent', 'fallback')
    || { agent: 'turn.loop.agent', rule: 'fallback-forced', probe, overlayActive, currentUrl, focused, pageCategory };
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
  // A bare 'web_generic' category can often be refined deterministically from
  // the live URL — e.g. a dom.act step with no agentId still learns chatgpt.com
  // is ai_chat from the hostname map.
  if ((!pageCategory || pageCategory === 'web_generic') && currentUrl) {
    const refined = hostCategory(currentUrl);
    if (refined && refined !== 'web_generic') {
      logger.info(`[router] pageCategory refined web_generic → ${refined} (host=${hostnameOf(currentUrl)})`);
      pageCategory = refined;
    }
  }
  return _routeFromSignals({ goal, pageCategory, focused, probe, overlayActive, currentUrl, triedAgents, agentHint });
}

module.exports = {
  routeOnPageAction, ONPAGE_AGENTS, TIER_TO_AGENT, _isMultiPartGoal,
  _routeFromSignals, stripQuoted, PRESS_KEY_RE, CLICK_NAMED_VERB_RE,
  _SINGLE_FIELD_CATS, READ_EXTRACT_RE, TYPE_GOAL_RE,
};
