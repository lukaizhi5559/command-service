/**
 * Regression tests — the Spotify-screenshot failure chain:
 *  1. System tags ([File:], [Resolved file path:], [Highlighted:]) must be
 *     stripped from executable goals — they leaked into map-tree queries and
 *     entity extraction.
 *  2. Image materialization must be IDEMPOTENT — an upstream image.analyze
 *     step already extracted the image; a second analysis duplicated the
 *     list and re-polluted the goal.
 *  3. Extracted item lists parse COMPLETE lines — extractEntities clipped
 *     fragments ("the Ice)", "by Russ Taff (Album:") that got typed into
 *     Spotify's search field.
 *  4. Source guards — planning's read tools can never regress to the chord
 *     lane (app.agent scan_page OS / read_screen typed Cmd+L/Cmd+A/Escape
 *     into a live Calendar page).
 */
'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.resolve(__dirname, '../src');
const REPO = path.resolve(__dirname, '../../..');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.log(`  FAIL: ${name}${extra ? ` — ${extra}` : ''}`); }
}

const { _internals } = require(path.join(SRC, 'skills/screen.task.agent.cjs'));
const { _recordMaterialized, _lookupMaterialized } = require(path.join(SRC, 'skills/image.analyze.cjs'));

async function main() {
  // ── 1. System-tag strip ────────────────────────────────────────────────
  {
    const goal = 'add the songs to my Quiet Hour playlist\n[Resolved file path: /var/folders/x/Screenshot.png]\n[Highlighted: some context]\n[Folder: /Users/me/Desktop]';
    const clean = _internals._stripSystemTags(goal);
    ok(!/\[Resolved file path/i.test(clean), 'strips [Resolved file path:]');
    ok(!/\[Highlighted/i.test(clean), 'strips [Highlighted:]');
    ok(!/\[Folder/i.test(clean), 'strips [Folder:]');
    ok(/Quiet Hour/.test(clean), 'keeps user intent text');
  }

  // ── 2. Itemized extraction → complete lines, no fragments ──────────────
  {
    const extraction = '1. King Without a Crown — Matisyahu\n2. Walls of Time — Russ Taff\n3. The Ice — KB\n4. Grace — Lecrae';
    const items = _internals._parseExtractedItems(extraction);
    ok(Array.isArray(items) && items.length === 4, `parses 4 items (got ${items?.length})`);
    const expected = ['King Without a Crown — Matisyahu', 'Walls of Time — Russ Taff', 'The Ice — KB', 'Grace — Lecrae'];
    ok(items?.every((t, i) => t === expected[i]), 'every item is a COMPLETE line (no clipped fragments)');
    // fewer than 2 items → null (not a list)
    ok(_internals._parseExtractedItems('Just one thing here') === null, 'single line is not a list');
  }

  // ── 3. Idempotent materialization — cache hit skips re-analysis ────────
  {
    const tmp = path.join(os.tmpdir(), `td-mat-${process.pid}.png`);
    fs.writeFileSync(tmp, Buffer.from('fake-png-bytes'));
    const songList = 'King Without a Crown — Matisyahu\nWalls of Time — Russ Taff';
    _recordMaterialized(tmp, songList);
    ok(_lookupMaterialized(tmp) === songList, 'materialization cache records by path+mtime');

    // Upstream already injected the extraction via {{prev_stdout}} AND the
    // residue tag survived — must NOT re-analyze and NOT double-append.
    const already = `add the songs to my Quiet Hour playlist\n${songList}\n[Resolved file path: ${tmp}]`;
    const r1 = await _internals._materializeImageRefs(already, {});
    ok(!/\[Resolved file path/i.test(r1.goal), 'residue tag stripped on already-materialized goal');
    ok((r1.goal.match(/King Without a Crown/g) || []).length === 1, 'extraction not double-appended');

    // Goal does NOT carry the extraction (re-dispatch without prior step) —
    // the cache still supplies it without a second vision call.
    const r2 = await _internals._materializeImageRefs(`add the songs to my Quiet Hour playlist [File: ${tmp}]`, {});
    ok(r2.goal.includes('King Without a Crown'), 'cache supplies extraction without re-analyzing');
    ok(!/\[File:/i.test(r2.goal), 'file tag stripped');
    ok(Array.isArray(r2.items) && r2.items.length === 2, 'items parsed from cached extraction');
    fs.unlinkSync(tmp);
  }

  // ── 4. Map-tree ask isolation ──────────────────────────────────────────
  {
    const goal = 'add the songs to my Quiet Hour playlist on Spotify\n\nExtracted from attached image:\nKing Without a Crown — Matisyahu\nWalls of Time — Russ Taff\n[Resolved file path: /var/x.png]';
    const ask = _internals._originalAsk(goal);
    ok(!/Extracted from attached image/i.test(ask), 'research ask cuts the extraction block');
    ok(!/Matisyahu|Russ Taff/.test(ask), 'entity text stays out of the tutorial query');
    ok(/Quiet Hour/.test(ask), 'destination survives');
  }

  // ── 5. Source guards — the chord lane must never come back ─────────────
  {
    const planningSrc = fs.readFileSync(path.join(REPO, 'comms-graph/src/nodes/planning.cjs'), 'utf8');
    const srBody = planningSrc.match(/async function _toolScreenRead[\s\S]*?\n\}/)?.[0] || '';
    const srCode = srBody.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''); // comments may name the retired lane
    ok(srBody.length > 0, '_toolScreenRead exists');
    ok(!/app\.agent/.test(srCode), 'screen.read never dispatches app.agent');
    ok(!/command\.automate/.test(srCode), 'screen.read never hits /command.automate');
    ok(!/keyboard|clipboard|read_screen/i.test(srCode), 'screen.read has no keyboard/clipboard path');
    ok(/\/screen\/parse/.test(srBody), 'screen.read uses capture-only /screen/parse');

    const prBody = planningSrc.match(/async function _toolPageRead[\s\S]*?\n\}/)?.[0] || '';
    ok(/extOnly:\s*true/.test(prBody), 'page.read pins extOnly (no OS-lane fallback)');

    const appAgentSrc = fs.readFileSync(path.join(SRC, 'skills/app.agent.cjs'), 'utf8');
    ok(/extOnly/.test(appAgentSrc), 'app.agent scan_page honors the extOnly flag');

    const serverSrc = fs.readFileSync(path.join(SRC, 'server.cjs'), 'utf8');
    ok(/dormant_driver/.test(serverSrc), 'command-service hard-blocks dormant drivers');
    ok(/extOnly\s*===?\s*true/.test(serverSrc), 'dormant block allowlists only ext-lane reads');

    const planHelpers = fs.readFileSync(path.join(REPO, 'stategraph-module/src/utils/planHelpers.js'), 'utf8');
    ok(!/_OFF_(?:ACTION|READ)_PICKS = \[\s*'app\.agent'\s*\]/.test(planHelpers), 'browser-off repair picks never emit app.agent');
    const allState = [ 'stategraph-module/src/nodes/planSkillsV2.js', 'stategraph-module/src/utils/planHelpers.js', 'stategraph-module/src/utils/localPlanTemplates.js', 'stategraph-module/src/nodes/fastLanePlan.js' ]
      .map(f => fs.readFileSync(path.join(REPO, f), 'utf8')).join('\n');
    ok(!/preferOs:\s*true/.test(allState), 'no preferOs emitters remain (the chord-forcing flag is gone)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
