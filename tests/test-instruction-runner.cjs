'use strict';
/**
 * tests/test-instruction-runner.cjs
 *
 * Unit tests for the instruction runner parser (parseInstructions / parseStep).
 * Verifies the fix for the Step 3 bug where `Type {{playlist_name}} into the "Name" field`
 * produced value="{{undefined}}" and target=null.
 *
 * Run: node tests/test-instruction-runner.cjs
 */

const assert = require('assert').strict;
const path = require('path');

// ─── Test helpers ─────────────────────────────────────────────────────────────

let _testCount = 0;
let _passCount = 0;
let _failCount = 0;

function test(name, fn) {
  _testCount++;
  try {
    fn();
    _passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    _failCount++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) console.error(`    ${err.stack.split('\n').slice(1, 3).join('\n    ')}`);
  }
}

function summary() {
  console.log(`\n=== Results: ${_passCount}/${_testCount} passed, ${_failCount} failed ===`);
  process.exit(_failCount > 0 ? 1 : 0);
}

// ─── Load module ──────────────────────────────────────────────────────────────

const { parseInstructions, parseStep } = require(path.resolve(__dirname, '../src/skills/instruction.runner.cjs'));

// ─── Tests: Type ... into ... ─────────────────────────────────────────────────

console.log('\n--- Type ... into ... parser ---');

test('Type "value" into the "Name" field (double-quoted value + target)', () => {
  const step = parseStep('Type "test it" into the "Name" field');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'test it');
});

test('Type \'value\' into the \'Name\' field (single-quoted)', () => {
  const step = parseStep("Type 'hello world' into the 'Name' field");
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'hello world');
});

test('Type {{playlist_name}} into the "Name" field (placeholder, no quotes)', () => {
  // This was the bug case — used to produce value="{{undefined}}"
  const step = parseStep('Type {{playlist_name}} into the "Name" field');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, '{{playlist_name}}');
});

test('Type "{{playlist_name}}" into the "Name" field (quoted placeholder)', () => {
  const step = parseStep('Type "{{playlist_name}}" into the "Name" field');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, '{{playlist_name}}');
});

test('Type test it into the "Name" field (unquoted multi-word value)', () => {
  const step = parseStep('Type test it into the "Name" field');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'test it');
});

test('Type hello into the Name field (unquoted single-word value + bare target)', () => {
  const step = parseStep('Type hello into the Name field');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'hello');
});

test('Type "value" into "Field" (no "the", no field suffix)', () => {
  const step = parseStep('Type "abc" into "Email"');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Email');
  assert.equal(step.value, 'abc');
});

test('Type "value" into the "Name" input (input suffix)', () => {
  const step = parseStep('Type "abc" into the "Name" input');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'abc');
});

test('Type "value" into the "Name" field. (trailing period)', () => {
  const step = parseStep('Type "abc" into the "Name" field.');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, 'Name');
  assert.equal(step.value, 'abc');
});

// ─── Tests: Type ... (no target) ──────────────────────────────────────────────

console.log('\n--- Type ... (no target) parser ---');

test('Type "value" (double-quoted, no target)', () => {
  const step = parseStep('Type "hello"');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, null);
  assert.equal(step.value, 'hello');
});

test('Type \'value\' (single-quoted, no target)', () => {
  const step = parseStep("Type 'hello'");
  assert.equal(step.action, 'fill');
  assert.equal(step.target, null);
  assert.equal(step.value, 'hello');
});

test('Type {{param}} (placeholder, no target)', () => {
  const step = parseStep('Type {{playlist_name}}');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, null);
  assert.equal(step.value, '{{playlist_name}}');
});

test('Type hello world (unquoted, no target)', () => {
  const step = parseStep('Type hello world');
  assert.equal(step.action, 'fill');
  assert.equal(step.target, null);
  assert.equal(step.value, 'hello world');
});

// ─── Tests: Click ─────────────────────────────────────────────────────────────

console.log('\n--- Click parser ---');

test('Click the "Create Playlist" button', () => {
  const step = parseStep('Click the "Create Playlist" button');
  assert.equal(step.action, 'click');
  assert.equal(step.target, 'Create Playlist');
});

test('Click "Save"', () => {
  const step = parseStep('Click "Save"');
  assert.equal(step.action, 'click');
  assert.equal(step.target, 'Save');
});

test('Click Save (unquoted)', () => {
  const step = parseStep('Click Save');
  assert.equal(step.action, 'click');
  assert.equal(step.target, 'Save');
});

// ─── Tests: Select ────────────────────────────────────────────────────────────

console.log('\n--- Select parser ---');

test('Select "Option 1" from the "Country" dropdown', () => {
  const step = parseStep('Select "Option 1" from the "Country" dropdown');
  assert.equal(step.action, 'select');
  assert.equal(step.target, 'Country');
  assert.equal(step.value, 'Option 1');
});

// ─── Tests: Press / Check / Submit / Double-click ─────────────────────────────

console.log('\n--- Other actions ---');

test('Press Enter', () => {
  const step = parseStep('Press Enter');
  assert.equal(step.action, 'key');
  assert.equal(step.key, 'Enter');
});

test('Press Tab', () => {
  const step = parseStep('Press Tab');
  assert.equal(step.action, 'key');
  assert.equal(step.key, 'Tab');
});

test('Check "Remember me"', () => {
  const step = parseStep('Check "Remember me"');
  assert.equal(step.action, 'check');
  assert.equal(step.target, 'Remember me');
});

test('Submit the form', () => {
  const step = parseStep('Submit the form');
  assert.equal(step.action, 'key');
  assert.equal(step.key, 'Enter');
});

test('Double-click "Item"', () => {
  const step = parseStep('Double-click "Item"');
  assert.equal(step.action, 'dblclick');
  assert.equal(step.target, 'Item');
});

// ─── Tests: parseInstructions (multi-step) ────────────────────────────────────

console.log('\n--- parseInstructions (multi-step) ---');

test('Parses 4-step Spotify playlist instruction', () => {
  const steps = parseInstructions(
    'Click the "Create Playlist" button. Click "Name & details". Type "{{playlist_name}}" into the "Name" field. Click "Save".'
  );
  assert.equal(steps.length, 4);
  assert.equal(steps[0].action, 'click');
  assert.equal(steps[0].target, 'Create Playlist');
  assert.equal(steps[1].action, 'click');
  assert.equal(steps[1].target, 'Name & details');
  assert.equal(steps[2].action, 'fill');
  assert.equal(steps[2].target, 'Name');
  assert.equal(steps[2].value, '{{playlist_name}}');
  assert.equal(steps[3].action, 'click');
  assert.equal(steps[3].target, 'Save');
});

test('Parses instruction with unquoted placeholder (the original bug case)', () => {
  // After LLM generates `Type {{playlist_name}} into the "Name" field`
  // (without quotes around the placeholder), parser should still work.
  const steps = parseInstructions(
    'Click the "Create Playlist" button. Click "Name & details". Type {{playlist_name}} into the "Name" field. Click "Save".'
  );
  assert.equal(steps.length, 4);
  assert.equal(steps[2].action, 'fill');
  assert.equal(steps[2].target, 'Name');
  assert.equal(steps[2].value, '{{playlist_name}}');
});

test('Parses instruction with unquoted multi-word value', () => {
  const steps = parseInstructions(
    'Click "Search". Type test it into the "Search" field. Press Enter.'
  );
  assert.equal(steps.length, 3);
  assert.equal(steps[1].action, 'fill');
  assert.equal(steps[1].target, 'Search');
  assert.equal(steps[1].value, 'test it');
  assert.equal(steps[2].action, 'key');
  assert.equal(steps[2].key, 'Enter');
});

test('Returns empty array for unrecognized text', () => {
  const steps = parseInstructions('blah blah blah');
  assert.equal(steps.length, 0);
});

// ─── Run ──────────────────────────────────────────────────────────────────────

summary();
