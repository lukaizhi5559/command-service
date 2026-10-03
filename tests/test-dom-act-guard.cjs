'use strict';

// Regression tests for the false-"Done" run (doc/event/sheet):
//  1. _mutationApplied must only credit verify-REJECTED done attempts —
//     exhaustion/element-mismatch/parse errors mean incomplete work.
//  2. Values typed into an UNSUBMITTED creation/compose form (still on
//     /eventedit, ?action=TEMPLATE, /new) are transient — not applied.
//  3. Router must send multi-part mutation goals to turn.loop.agent —
//     tab.map's single-lane step budget exhausts mid-form.

const { _mutationApplied, _isUnsubmittedFormUrl } = require('../src/skills/dom.act.cjs');
const { _isMultiPartGoal } = require('../src/skills/lib/browserCore/router.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const filled = (v) => ({ filledFields: [{ field: 'x', value: v }], actionHistory: [], transcript: [] });

console.log('\n--- _mutationApplied: failure-shape gate ---');
// The doc run: executor claimed done, verify over-rejected it, value applied,
// URL already off the creation surface → applied.
check('Done-rejected + applied value → applied',
  _mutationApplied({ ok: false, error: 'Done rejected: goal implies submit/send but no submit action or send-API success was recorded', ...filled('Vacation Itinerary') },
    "Create a new Google Doc titled 'Vacation Itinerary'") === true);
// The calendar run: exhausted mid-form — NOT over-strict verification.
check('Exceeded-max-steps → NOT applied',
  _mutationApplied({ ok: false, error: 'Exceeded 15 inner steps', ...filled('Flight to Denver') },
    "Create a new Google Calendar event for July 15th titled 'Flight to Denver'") === false);
// The sheets run: element mismatch after typing — NOT applied.
check('Element-mismatch → NOT applied',
  _mutationApplied({ ok: false, error: 'Element mismatch: picked "rename" for target "text field"', ...filled('Trip Budget') },
    "Create a new Google Sheet named 'Trip Budget' with column headers") === false);
check('timeout/transport → NOT applied',
  _mutationApplied({ ok: false, error: 'browser.act evaluate timed out', ...filled('X Y') },
    "fill 'X Y'") === false);
check('null result → NOT applied', _mutationApplied(null, "fill 'X'") === false);
check('ok result → NOT applied', _mutationApplied({ ok: true, ...filled('X') }, "fill 'X'") === false);
check('Done-rejected but NO quoted value → NOT applied',
  _mutationApplied({ ok: false, error: 'Done rejected: no submit action', ...filled('something') }, 'fill the form') === false);
check('Done-rejected but value absent from transcript → NOT applied',
  _mutationApplied({ ok: false, error: 'Done rejected: no submit action', ...filled('other') }, "fill 'Trip Budget'") === false);

console.log('\n--- _isUnsubmittedFormUrl ---');
check('/eventedit → unsubmitted form', _isUnsubmittedFormUrl('https://calendar.google.com/calendar/u/0/r/eventedit') === true);
check('eventedit with params → true', _isUnsubmittedFormUrl('https://calendar.google.com/calendar/u/0/r/eventedit?action=TEMPLATE&text=x') === true);
check('?action=TEMPLATE → true', _isUnsubmittedFormUrl('https://calendar.google.com/calendar/r?action=TEMPLATE') === true);
check('/new shortcut → true', _isUnsubmittedFormUrl('https://docs.new') === true);
check('docs entity page → NOT unsubmitted', _isUnsubmittedFormUrl('https://docs.google.com/document/d/1lkkhz9WVwBnJk08eeQZYyJWd8v4YEg_7LVNzhpCIZqU/edit?tab=t.0') === false);
check('sheets entity page → NOT unsubmitted', _isUnsubmittedFormUrl('https://docs.google.com/spreadsheets/d/1tpK2iq5gbv4oovQ3qq8xyWysUc90g1IX8_laFSUu3ZQ/edit?gid=0#gid=0') === false);
check('calendar month view → NOT unsubmitted', _isUnsubmittedFormUrl('https://calendar.google.com/calendar/u/0/r/month/2026/7/1') === false);
check('empty url → false', _isUnsubmittedFormUrl('') === false);

console.log('\n--- _isMultiPartGoal (router turn.loop lane) ---');
check('sheet + column headers list → multi-part',
  _isMultiPartGoal("Create a new Google Sheet named 'Trip Budget' with column headers for item, estimated cost, and actual cost") === true);
check('two quoted values → multi-part',
  _isMultiPartGoal("fill 'To' with 'bob@x.com' and 'Subject' with 'hi'") === true);
check('single quoted create event → NOT multi-part (tab.map stays)',
  _isMultiPartGoal("Create a new Google Calendar event for July 15th titled 'Flight to Denver'") === false);
check('simple fill → NOT multi-part', _isMultiPartGoal("type 'hello' into the field") === false);
check('simple click → NOT multi-part', _isMultiPartGoal('click the Save button') === false);

console.log('\n--- _normalizeCreateUrl (eventedit create needs ?action=TEMPLATE) ---');
const { _normalizeCreateUrl } = require('../src/skills/url.first.agent.cjs');
check('bare eventedit + create task → action=TEMPLATE appended',
  _normalizeCreateUrl('https://calendar.google.com/calendar/u/0/r/eventedit', 'create a new calendar event') === 'https://calendar.google.com/calendar/u/0/r/eventedit?action=TEMPLATE');
check('bare eventedit + non-create task → unchanged',
  _normalizeCreateUrl('https://calendar.google.com/calendar/u/0/r/eventedit', 'edit my event') === 'https://calendar.google.com/calendar/u/0/r/eventedit');
check('eventedit already paramed → unchanged',
  _normalizeCreateUrl('https://calendar.google.com/calendar/u/0/r/eventedit?action=TEMPLATE', 'create event') === 'https://calendar.google.com/calendar/u/0/r/eventedit?action=TEMPLATE');
check('non-calendar URL → unchanged',
  _normalizeCreateUrl('https://docs.google.com/document/create', 'create doc') === 'https://docs.google.com/document/create');

console.log('\n--- _goalCompletionRejectReason (stateChanged gate) ---');
const { _goalCompletionRejectReason } = require('../src/skills/lib/browserCore/tabMap.cjs');
(async () => {
  // The run-3 calendar bug: compound goal, last action page-changed → reject.
  check('compound goal + page-changed click → rejected',
    (await _goalCompletionRejectReason("fill the event with title 'Flight to Denver' and date July 15",
      ['Click "Previous month" → page changed'], null)) !== null);
  // Nav goal legitimately ends on nav.
  check('nav goal + navigate action → allowed',
    (await _goalCompletionRejectReason('navigate to gmail.com',
      ['navigate → page changed'], null)) === null);
  // Submit goal + no submit act → rejected.
  check('submit goal + no submit act → rejected',
    (await _goalCompletionRejectReason('send the email to bob',
      ['Type "hi" into the "Body" field → ok'], null)) !== null);
  // Submit goal + submit act → allowed.
  check('submit goal + submit act → allowed',
    (await _goalCompletionRejectReason('send the email to bob',
      ['Type "hi" into the "Body" field → ok', 'Click "Send" → page changed'], null)) === null);
  // Single-clause non-mutation goal → allowed.
  check('simple fill goal done → allowed',
    (await _goalCompletionRejectReason("fill 'item' into the name field",
      ['Type "item" into the "Name" field → ok'], null)) === null);

  console.log('\n--- source-level: stateChanged goes through the gate ---');
  const _tabMapSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/skills/lib/browserCore/tabMap.cjs'), 'utf8');
  check('stateChanged path calls _goalCompletionRejectReason', /_goalCompletionRejectReason\(goal, \[\.\.\.\(actionHistory/.test(_tabMapSrc));
  check('rejected stateChanged rescans instead of done', /stateChanged but goal gate rejected/.test(_tabMapSrc));

    if (failures.length) { console.log('FAILURES:', failures.join(' | ')); process.exit(1); }
  process.exit(0);
})();
