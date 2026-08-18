// ocrOverlayStructure.test.cjs
// Standalone test script — run with: node ocrOverlayStructure.test.cjs
// No test framework needed — just assertions + console output.
//
// Tests:
//   1. outfile.json (Spotify "Create" dropdown — menu type)
//   2. outfile-two.json (Spotify playlist context menu — context menu type)
//   3. formatOverlayForLLM output format
//   4. Empty / noise input edge cases
//   5. Modal-like synthetic input (heading + input-field + buttons)

'use strict';

const path = require('path');
const fs = require('fs');
const { structureOcrOverlayItems, formatOverlayForLLM } = require('./ocrOverlayStructure.cjs');

let _pass = 0;
let _fail = 0;

function assert(condition, msg) {
  if (condition) {
    _pass++;
    console.log(`  ✅ ${msg}`);
  } else {
    _fail++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertIncludes(haystack, needle, msg) {
  assert(typeof haystack === 'string' && haystack.includes(needle), msg);
}

function assertRowExists(rows, type, textFragment, msg) {
  const found = rows.some(r => r.type === type && r.text.toLowerCase().includes(textFragment.toLowerCase()));
  assert(found, msg);
}

// ---------------------------------------------------------------------------
// Helper: load textItems from a LiteParser JSON output file
// ---------------------------------------------------------------------------
function loadTextItems(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const page = parsed.pages?.[0];
  if (!page) throw new Error(`No pages[0] in ${filePath}`);
  return page.textItems || [];
}

// ---------------------------------------------------------------------------
// Test 1: outfile.json (Spotify "Create" dropdown)
// ---------------------------------------------------------------------------
console.log('\n=== Test 1: outfile.json (Spotify "Create" dropdown — menu) ===');
try {
  const items = loadTextItems('/Users/lukaizhi/Desktop/outfile.json');
  console.log(`  Loaded ${items.length} text items`);
  const rows = structureOcrOverlayItems(items);
  console.log(`  Structured into ${rows.length} rows:`);
  for (const r of rows) {
    console.log(`    [${r.id}] ${r.type}: "${r.text}"${r.description ? ` — "${r.description}"` : ''}`);
  }

  assert(rows.length >= 3, 'Should have at least 3 rows');
  assertRowExists(rows, 'row-item-link', 'Create a playlist with songs or episodes', 'Should have "Create a playlist with songs or episodes" as row-item-link');
  assertRowExists(rows, 'row-item-link', 'Blend', 'Should have "Blend" as row-item-link');
  assertRowExists(rows, 'row-item-link', 'Folder', 'Should have "Folder" as row-item-link');

  // Check description pairing
  const blend = rows.find(r => r.text.toLowerCase().includes('blend'));
  assert(blend && blend.description && blend.description.toLowerCase().includes('combine your tastes'),
    'Blend should have description containing "Combine your tastes" (friends\' may be filtered due to low OCR confidence)');

  const folder = rows.find(r => r.text.toLowerCase().includes('folder'));
  assert(folder && folder.description && folder.description.toLowerCase().includes('organize your playlists'),
    'Folder should have description "Organize your playlists"');

  // Check heading
  const heading = rows.find(r => r.type === 'heading');
  assert(heading && heading.text.toLowerCase().includes('playlist'), 'First row should be heading "Playlist"');
} catch (e) {
  console.error(`  Test 1 error: ${e.message}`);
  _fail++;
}

// ---------------------------------------------------------------------------
// Test 2: outfile-two.json (Spotify playlist context menu)
// ---------------------------------------------------------------------------
console.log('\n=== Test 2: outfile-two.json (Spotify context menu) ===');
try {
  const items = loadTextItems('/Users/lukaizhi/Desktop/outfile-two.json');
  console.log(`  Loaded ${items.length} text items`);
  const rows = structureOcrOverlayItems(items);
  console.log(`  Structured into ${rows.length} rows:`);
  for (const r of rows) {
    console.log(`    [${r.id}] ${r.type}: "${r.text}"${r.description ? ` — "${r.description}"` : ''}`);
  }

  assert(rows.length >= 7, 'Should have at least 7 rows');
  assertRowExists(rows, 'row-item-link', 'Remove from profile', 'Should have "Remove from profile"');
  assertRowExists(rows, 'row-item-link', 'Edit details', 'Should have "Edit details" (segmented from "Editdetails")');
  // "Delete" should be row-item-link in a context menu (not a modal button)
  const deleteRow = rows.find(r => r.text.toLowerCase().includes('delete'));
  assert(deleteRow && deleteRow.type === 'row-item-link', 'Should have "Delete" as row-item-link (not button in context menu)');
  assertRowExists(rows, 'row-item-link', 'Make private', 'Should have "Make private"');
  assertRowExists(rows, 'row-item-link', 'Invite collaborators', 'Should have "Invite collaborators" (no icon prefix)');
  assertRowExists(rows, 'row-item-link', 'Exclude from your taste profile', 'Should have "Exclude from your taste profile"');
  assertRowExists(rows, 'row-item-link', 'Move to folder', 'Should have "Move to folder"');
  // "Share" should be row-item-link (not heading) — icon prefix "M1" filtered out
  const shareRow = rows.find(r => r.text.toLowerCase().includes('share'));
  assert(shareRow && shareRow.type === 'row-item-link', 'Should have "Share" as row-item-link (icon prefix filtered)');
  // "Desktop app" — note: "Open in" is missing from OCR, only "Desktop app" captured
  assertRowExists(rows, 'row-item-link', 'Desktop app', 'Should have "Desktop app" (note: "Open in" missing from OCR)');
} catch (e) {
  console.error(`  Test 2 error: ${e.message}`);
  _fail++;
}

// ---------------------------------------------------------------------------
// Test 3: formatOverlayForLLM
// ---------------------------------------------------------------------------
console.log('\n=== Test 3: formatOverlayForLLM ===');
try {
  const items = loadTextItems('/Users/lukaizhi/Desktop/outfile.json');
  const rows = structureOcrOverlayItems(items);
  const formatted = formatOverlayForLLM(rows);
  console.log(`  Formatted output:\n${formatted.split('\n').map(l => '    ' + l).join('\n')}`);

  assertIncludes(formatted, 'Overlay items:', 'Should start with "Overlay items:"');
  assertIncludes(formatted, 'row-item-link', 'Should contain type label "row-item-link"');
  assertIncludes(formatted, 'Create a playlist with songs or episodes', 'Should contain the full row text');
  assertIncludes(formatted, '[1]', 'Should contain row ID [1]');
} catch (e) {
  console.error(`  Test 3 error: ${e.message}`);
  _fail++;
}

// ---------------------------------------------------------------------------
// Test 4: Empty / noise input
// ---------------------------------------------------------------------------
console.log('\n=== Test 4: Empty / noise input ===');
try {
  const empty = structureOcrOverlayItems([]);
  assert(Array.isArray(empty) && empty.length === 0, 'Empty input should return empty array');

  const noise = structureOcrOverlayItems([
    { text: '®', x: 0, y: 0, width: 10, height: 10, confidence: 0.7 },
    { text: '©', x: 5, y: 0, width: 10, height: 10, confidence: 0.8 },
    { text: '»', x: 10, y: 0, width: 10, height: 10, confidence: 0.9 },
  ]);
  assert(Array.isArray(noise) && noise.length === 0, 'Icon-only input should return empty array');

  const lowConf = structureOcrOverlayItems([
    { text: 'Hello', x: 0, y: 0, width: 50, height: 12, confidence: 0.3 },
  ]);
  assert(Array.isArray(lowConf) && lowConf.length === 0, 'Low confidence input should return empty array');
} catch (e) {
  console.error(`  Test 4 error: ${e.message}`);
  _fail++;
}

// ---------------------------------------------------------------------------
// Test 5: Modal-like synthetic input
// ---------------------------------------------------------------------------
console.log('\n=== Test 5: Synthetic modal (heading + input + buttons) ===');
try {
  // Simulate a "Create playlist" modal with:
  // - Heading "Create playlist" (large font)
  // - Input placeholder "Playlist name" (medium font)
  // - Button "Cancel" (small font)
  // - Button "Create" (small font)
  const syntheticItems = [
    // Heading: "Create" and "playlist" on same y, large height
    { text: 'Create', x: 50, y: 20, width: 60, height: 24, confidence: 0.95 },
    { text: 'playlist', x: 115, y: 20, width: 70, height: 24, confidence: 0.95 },
    // Input placeholder: "Playlist name" on a different y, medium height
    { text: 'Playlist', x: 50, y: 70, width: 55, height: 14, confidence: 0.9 },
    { text: 'name', x: 110, y: 70, width: 35, height: 14, confidence: 0.9 },
    // Button "Cancel" on a different y, small height
    { text: 'Cancel', x: 50, y: 120, width: 45, height: 10, confidence: 0.95 },
    // Button "Create" on same y as Cancel
    { text: 'Create', x: 120, y: 120, width: 45, height: 10, confidence: 0.95 },
  ];

  const rows = structureOcrOverlayItems(syntheticItems);
  console.log(`  Structured into ${rows.length} rows:`);
  for (const r of rows) {
    console.log(`    [${r.id}] ${r.type}: "${r.text}"`);
  }

  assert(rows.length >= 3, 'Should have at least 3 rows (heading, input, 2 buttons = 4 but buttons may merge)');
  assertRowExists(rows, 'heading', 'Create playlist', 'Should have heading "Create playlist"');
  assertRowExists(rows, 'button', 'Cancel', 'Should have button "Cancel"');
  assertRowExists(rows, 'button', 'Create', 'Should have button "Create"');

  // Check for input-field (Playlist name)
  const inputRow = rows.find(r => r.type === 'input-field');
  assert(inputRow !== undefined, 'Should have an input-field row');
  if (inputRow) {
    assertIncludes(inputRow.text.toLowerCase(), 'playlist', 'Input field should contain "Playlist"');
  }
} catch (e) {
  console.error(`  Test 5 error: ${e.message}`);
  _fail++;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n=== Results: ${_pass} passed, ${_fail} failed ===`);
process.exit(_fail > 0 ? 1 : 0);
