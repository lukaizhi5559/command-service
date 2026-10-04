'use strict';

// Deterministic cascade tests for browserCore/router._routeFromSignals.
//
// The cascade is exercised headlessly — probe/focused/overlay/currentUrl are
// injected, confirmLane is stubbed to abstain. No browser, no LLM.

const { _routeFromSignals, stripQuoted } = require('../src/skills/lib/browserCore/router.cjs');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

const abstain = async () => null;
const PROBE_AI_CHAT = { hasAutoFocus: true, fillableCount: 1, clickableCount: 40, fillableTypes: { inputCount: 0, contenteditableCount: 1 }, categorySignals: {} };
const PROBE_GMAIL_COMPOSE = { hasAutoFocus: false, fillableCount: 4, clickableCount: 30, fillableTypes: { inputCount: 3, contenteditableCount: 1 }, categorySignals: {} };
const PROBE_AMAZON = { hasAutoFocus: true, fillableCount: 2, clickableCount: 400, fillableTypes: { inputCount: 2 }, categorySignals: {} };
const PROBE_SHEET = { hasAutoFocus: false, fillableCount: 1, clickableCount: 20, categorySignals: { hasGrid: true, hasFormulaBar: true, hasGridCell: true } };
const FOCUSED_EDITABLE = { tag: 'DIV', role: 'textbox', isContentEditable: true };

async function main() {

console.log('\n--- stripQuoted ---');
check('strips single-quoted payload', stripQuoted(`type 'Search for frog legs'`) === 'type ');
check('strips double-quoted payload', stripQuoted(`type "add to cart" now`) === 'type now');
check('unbalanced quote untouched-safe', typeof stripQuoted(`Mike Winger's videos`) === 'string');

console.log('\n--- autofocus + single-field categories ---');
{
  const r = await _routeFromSignals({
    goal: `click the message input field and type: 'Search for frog legs and places to eat them in China'`,
    pageCategory: 'ai_chat', probe: PROBE_AI_CHAT, focused: FOCUSED_EDITABLE,
    overlayActive: false, currentUrl: 'https://chatgpt.com/', confirmLane: abstain,
  });
  check('ai_chat type-and-send goal → just.type', r.agent === 'just.type.agent' && r.rule === 'autofocus-type');

  // Quoted "Search for" must NOT register as a shortcut/search verb.
  const r2 = await _routeFromSignals({
    goal: `type 'Search for information on gluten free restaurants' into the composer`,
    pageCategory: 'ai_chat', probe: PROBE_AI_CHAT, focused: FOCUSED_EDITABLE,
    overlayActive: false, currentUrl: 'https://chatgpt.com/', confirmLane: abstain,
  });
  check('quoted "Search for…" payload → just.type, not llm-confirm', r2.agent === 'just.type.agent');
}

console.log('\n--- read vs mutation ---');
{
  const r = await _routeFromSignals({
    goal: `Send an email to mike@example.com with subject 'Status update' and body containing the list of Mike Winger's video titles`,
    pageCategory: 'email_compose', probe: PROBE_GMAIL_COMPOSE, focused: null,
    overlayActive: true, currentUrl: 'https://mail.google.com/mail/u/0/#inbox', confirmLane: abstain,
  });
  check('mutation goal with incidental "list of videos" → NOT read-extract', r.rule !== 'read-extract');
  check('multi-field compose + overlay → tab.map multi-field-form', r.agent === 'tab.map.agent' && r.rule === 'multi-field-form');

  const r2 = await _routeFromSignals({
    goal: 'check my inbox for unread emails',
    pageCategory: 'email_compose', probe: { ...PROBE_GMAIL_COMPOSE, fillableCount: 0 }, focused: null,
    overlayActive: false, currentUrl: 'https://mail.google.com/mail/u/0/#inbox', confirmLane: abstain,
  });
  check('leading read verb → read-extract lane', r2.rule === 'read-extract');
}

console.log('\n--- press-key / scroll ---');
{
  for (const goal of [
    'press Enter or click Send',
    'scroll to the bottom of this page',
    'scroll down',
    'press the End key',
    'scroll to the top of the page',
  ]) {
    const r = await _routeFromSignals({
      goal, pageCategory: 'shopping', probe: PROBE_AMAZON, focused: null,
      overlayActive: false, currentUrl: 'https://www.amazon.com/s?k=bible', confirmLane: abstain,
    });
    check(`"${goal.slice(0, 40)}" → press-key lane`, r.agent === 'just.type.agent' && r.rule === 'press-key');
  }
}

console.log('\n--- click-named ---');
{
  const r = await _routeFromSignals({
    goal: `open the chat 'frog legs'`,
    pageCategory: 'ai_chat', probe: PROBE_AI_CHAT, focused: null,
    overlayActive: false, currentUrl: 'https://chatgpt.com/', confirmLane: abstain,
  });
  check('quoted named item → meta.find (tier 2 now allowed for ai_chat)', r.agent === 'meta.find.agent' && r.rule === 'click-named');

  const r2 = await _routeFromSignals({
    goal: 'click the Send button',
    pageCategory: 'email_compose', probe: PROBE_GMAIL_COMPOSE, focused: null,
    overlayActive: true, currentUrl: 'https://mail.google.com/', confirmLane: abstain,
  });
  // email_compose allowedTiers excludes meta.find (tier 2) — overlay-scoped
  // tab.map is the safer clicker inside a compose dialog.
  check('bare "click Send" on compose → click-named lane (tab.map fallback)', r2.rule === 'click-named-fallback' || (r2.agent === 'meta.find.agent' && r2.rule === 'click-named'));
}

console.log('\n--- multi-part form vs sequence ---');
{
  const r = await _routeFromSignals({
    goal: `fill To 'a@b.com', Subject 'hi', Body 'hello there' and send`,
    pageCategory: 'email_compose', probe: PROBE_GMAIL_COMPOSE, focused: null,
    overlayActive: true, currentUrl: 'https://mail.google.com/', confirmLane: abstain,
  });
  check('multi-field + overlay → tab.map', r.agent === 'tab.map.agent' && r.rule === 'multi-field-form');

  const r2 = await _routeFromSignals({
    goal: `enter 'New York' in the city field and '90210' in the zip field`,
    pageCategory: 'web_generic', probe: { hasAutoFocus: false, fillableCount: 3, clickableCount: 10, categorySignals: {} }, focused: null,
    overlayActive: false, currentUrl: 'https://example.com/form', confirmLane: abstain,
  });
  check('multi-field + ≥2 fillables → tab.map', r2.agent === 'tab.map.agent' && r2.rule === 'multi-field-form');

  const r3 = await _routeFromSignals({
    goal: `set the quantity to '2' and the size to 'Large'`,
    pageCategory: 'shopping', probe: { hasAutoFocus: false, fillableCount: 0, clickableCount: 50, categorySignals: {} }, focused: null,
    overlayActive: false, currentUrl: 'https://www.amazon.com/dp/xyz', confirmLane: abstain,
  });
  check('multi-part, no form surface → turn.loop seq', r3.agent === 'turn.loop.agent' && r3.rule === 'multi-part-seq');
}

console.log('\n--- commerce / unfocused type / grid ---');
{
  const r = await _routeFromSignals({
    goal: 'add the first result to cart',
    pageCategory: 'shopping', probe: PROBE_AMAZON, focused: null,
    overlayActive: false, currentUrl: 'https://www.amazon.com/s?k=bible', confirmLane: abstain,
  });
  check('commerce mutation on amazon → turn.loop', r.agent === 'turn.loop.agent' && r.rule === 'commerce-mutation');

  const r2 = await _routeFromSignals({
    goal: `type 'hello world' in the comment box`,
    pageCategory: 'web_generic', probe: { hasAutoFocus: false, fillableCount: 1, clickableCount: 10, categorySignals: {} }, focused: null,
    overlayActive: false, currentUrl: 'https://example.com/post', confirmLane: abstain,
  });
  check('single unfocused field type → turn.loop', r2.agent === 'turn.loop.agent' && r2.rule === 'type-unfocused');

  const r3 = await _routeFromSignals({
    goal: 'fill cell B2 with the total',
    pageCategory: 'spreadsheet', probe: PROBE_SHEET, focused: null,
    overlayActive: false, currentUrl: 'https://docs.google.com/spreadsheets/d/x', confirmLane: abstain,
  });
  check('spreadsheet cell goal → arrow.grid', r3.agent === 'arrow.grid.agent' && r3.rule === 'spreadsheet-grid');
}

console.log('\n--- category gating ---');
{
  const r = await _routeFromSignals({
    goal: 'drag the slider to 50%',
    pageCategory: 'ai_chat', probe: PROBE_AI_CHAT, focused: null,
    overlayActive: false, currentUrl: 'https://chatgpt.com/', confirmLane: abstain,
  });
  check('gesture verb on ai_chat → gesture blocked by allowedTiers', r.agent !== 'gesture.agent');

  const r2 = await _routeFromSignals({
    goal: 'drag the slider to 50%',
    pageCategory: 'web_generic', probe: PROBE_AI_CHAT, focused: null,
    overlayActive: false, currentUrl: 'https://example.com/', confirmLane: abstain,
  });
  check('gesture verb on web_generic → gesture.agent', r2.agent === 'gesture.agent');
}

console.log('\n--- agentHint ---');
{
  const r = await _routeFromSignals({
    goal: 'do anything',
    pageCategory: 'web_generic', probe: PROBE_AMAZON, focused: null,
    overlayActive: false, currentUrl: 'https://www.amazon.com/', confirmLane: abstain,
    agentHint: 'tab.map.agent',
  });
  check('valid hint wins outright', r.agent === 'tab.map.agent' && r.rule === 'hint:tab.map.agent');

  const r2 = await _routeFromSignals({
    goal: 'do anything',
    pageCategory: 'web_generic', probe: PROBE_AMAZON, focused: null,
    overlayActive: false, currentUrl: 'https://www.amazon.com/', confirmLane: abstain,
    agentHint: 'tab.map.agent', triedAgents: ['tab.map.agent'],
  });
  check('tried hint falls through to cascade', r2.agent !== 'tab.map.agent' || r2.rule !== 'hint:tab.map.agent');
}

console.log(`\n=== Results: ${passed}/${passed + failed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
