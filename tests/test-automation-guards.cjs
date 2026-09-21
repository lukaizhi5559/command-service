'use strict';

// Focused tests for the automation-flow regression fixes:
//  - _sampleTextForGoal: goal-aware OCR/page-text sampling (Amazon 500-char bug)
//  - _extractSearchText: rejects/salvages LLM prose (Meta+F typed an explanation)
//  - _extractShortcut: strict numeric parse (prose → null)
//  - _extractValue: preamble-prose guard (salvage quoted value or SKIP)
//  - _checkDone: prose → NO
//  - _selectTierLLM: strict tier parse + ArrowGrid (tier 6) spreadsheet-only
//
// LLM calls are stubbed via require.cache on skill-llm.cjs — all target
// functions require() it lazily at call time.

const path = require('path');
const llmPath = require.resolve('../src/skill-helpers/skill-llm.cjs');

let _llmResponse = '';
// Seed the cache BEFORE requiring modules that lazily require it.
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: {
    askWithMessages: async () => _llmResponse,
  },
};

const browserAgent = require('../src/skills/browser.agent.cjs');
const runner = require('../src/skills/instruction.runner.cjs');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

async function main() {

// ── _sampleTextForGoal ──────────────────────────────────────────────
console.log('\n--- _sampleTextForGoal ---');
{
  const { _sampleTextForGoal } = browserAgent;

  // Short text passes through untouched
  check('short text returned as-is', _sampleTextForGoal('hello world', 'g') === 'hello world');
  check('empty text → empty', _sampleTextForGoal('', 'g') === '');

  // Amazon-like page: 500+ chars of nav junk, product results deep in body.
  const navJunk = 'Deliver to Chicago 60601 All Account & Lists Returns & Orders Cart '.repeat(10);
  const results = `RESULTS Children's Bible Storybook: 100 Stories Hardcover $14.99 by Example Author ` +
    `The Beginner's Bible Storybook $11.39 ` + 'sponsored filler '.repeat(30);
  const tailJunk = 'footer links privacy conditions '.repeat(20);
  const page = navJunk + results + tailJunk;

  const sampled = _sampleTextForGoal(page, "search for 'children's Bible storybook'");
  check('sampled includes head', sampled.includes('Deliver to'));
  check('sampled includes product text deep in body', sampled.includes('Bible Storybook: 100 Stories'));
  check('sampled within maxChars bound', sampled.length <= 2100);
  check('old 500-char window would have missed results', !page.slice(0, 500).includes('100 Stories'));
  check('sampled text is not just the head', sampled.length > 500);

  // Unquoted goal → falls back to keyword needles
  const kwSample = _sampleTextForGoal(page, 'find the bible storybook product');
  check('keyword needle found in body', kwSample.includes('Bible'));
}

// ── _extractSearchText prose rejection ──────────────────────────────
console.log('\n--- _extractSearchText ---');
{
  const { _extractSearchText } = browserAgent;
  const goal = 'search for children\'s Bible storybook';
  const hist = ['Opened amazon.com'];

  _llmResponse = 'children\'s Bible storybook';
  check('clean short answer passes through',
    (await _extractSearchText(goal, hist)) === 'children\'s Bible storybook');

  _llmResponse = 'Based on the goal provided, the search text to use on Amazon would be "children\'s Bible storybook." This phrase captures the essence of what you\'re looking for.';
  check('prose with quoted phrase → salvages the phrase',
    (await _extractSearchText(goal, hist)) === 'children\'s Bible storybook');

  _llmResponse = 'Based on the goal, you should search for something related to the item described. The best approach is to look for relevant products in the category that matches.';
  check('pure prose (no quotes) → rejected as empty',
    (await _extractSearchText(goal, hist)) === '');

  _llmResponse = 'Add to Cart';
  check('short clean answer accepted', (await _extractSearchText(goal, hist)) === 'Add to Cart');
}

// ── _extractShortcut strict parse ───────────────────────────────────
console.log('\n--- _extractShortcut ---');
{
  const { _extractShortcut } = browserAgent;
  const args = ['click the first result', [], 'amazon.com', null, 'https://www.amazon.com/s?k=x', false, null, 'shopping', null];

  _llmResponse = 'I would recommend pressing the down arrow (action 3) because it navigates to the next element on the page.';
  check('prose response → null', (await _extractShortcut(...args)) === null);

  _llmResponse = '3';
  const picked = await _extractShortcut(...args);
  check('bare number picks action', picked && picked.key === 'ArrowDown');

  _llmResponse = '0';
  check('0 → null (no match)', (await _extractShortcut(...args)) === null);
}

// ── _extractValue prose guard ───────────────────────────────────────
console.log('\n--- _extractValue ---');
{
  const { _extractValue } = browserAgent;
  const focused = { tag: 'input', text: 'Search', role: 'searchbox' };

  _llmResponse = 'PRESS_ENTER';
  check('PRESS_ passthrough', (await _extractValue('g', focused, [], null, '')) === 'PRESS_ENTER');

  _llmResponse = 'hello world';
  check('normal value passthrough', (await _extractValue('g', focused, [], null, '')) === 'hello world');

  _llmResponse = 'Based on the goal, the value to type is "Trip Budget" into the title field.';
  check('prose with quoted value → salvaged',
    (await _extractValue('g', focused, [], null, '')) === 'Trip Budget');

  _llmResponse = 'Based on the goal and the current page state, I would recommend typing the appropriate search terms into the focused field.';
  check('pure prose → SKIP', (await _extractValue('g', focused, [], null, '')) === 'SKIP');
}

// ── _checkDone prose → NO ───────────────────────────────────────────
console.log('\n--- _checkDone ---');
{
  const { _checkDone } = runner;
  const hist = ['Just-type typed "x"'];

  _llmResponse = 'YES';
  check('YES → true', (await _checkDone('search for books', hist, 'https://a.com', 'A', 0)) === true);

  _llmResponse = 'Based on the action history, the goal has not yet been fully completed because the item was not added.';
  check('prose → false', (await _checkDone('search for books', hist, 'https://a.com', 'A', 0)) === false);

  _llmResponse = 'NO';
  check('NO → false', (await _checkDone('search for books', hist, 'https://a.com', 'A', 0)) === false);
}

// ── _selectTierLLM: strict parse + ArrowGrid guard ──────────────────
console.log('\n--- _selectTierLLM ---');
{
  const { _selectTierLLM } = runner;
  const probe = {
    fillableCount: 0,
    clickableCount: 500,
    hasAutoFocus: false,
    fillableTypes: { inputCount: 0, contenteditableCount: 0 },
    pageTitle: 'Amazon.com : children\'s bible storybook',
    visibleText: '',
  };
  const url = 'https://www.amazon.com/s?k=children%27s+bible+storybook';

  _llmResponse = 'Based on the goal provided, the appropriate strategy to select the first product result would be to use Tab-Map (4) since it can scan and click elements.';
  const tierFromProse = await _selectTierLLM('sess', 'add the first result to cart', [], 'shopping', 0, null, url, probe, null);
  check('prose → safe fallback (not digit-stripped into a tier)', tierFromProse === 1);

  _llmResponse = '6';
  const tier6onShopping = await _selectTierLLM('sess', 'add the first result to cart', [], 'shopping', 0, null, url, probe, null);
  check('tier 6 rejected on shopping page (not in allowed tiers)', tier6onShopping === 1);

  const sheetProbe = { ...probe, fillableCount: 1, clickableCount: 20 };
  _llmResponse = '6';
  const tier6onSheet = await _selectTierLLM('sess', 'enter A1 value', [], 'spreadsheet', 0, null, 'https://docs.google.com/spreadsheets/d/x', sheetProbe, null);
  check('tier 6 allowed on spreadsheet', tier6onSheet === 6);

  _llmResponse = '4';
  const tier4 = await _selectTierLLM('sess', 'add the first result to cart', [], 'shopping', 0, null, url, probe, null);
  check('valid bare tier accepted', tier4 === 4);

  _llmResponse = '-1';
  const esc = await _selectTierLLM('sess', 'add the first result to cart', [], 'shopping', 0, null, url, probe, null);
  check('-1 escalate accepted', esc === -1);
}

console.log(`\n=== Results: ${passed}/${passed + failed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
