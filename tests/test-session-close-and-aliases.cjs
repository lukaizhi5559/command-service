'use strict';

// Regression tests for the session-destabilization fixes:
//  1. resolve_deep_link must NOT close the live shared session (hidden:false
//     callers like url.first.agent). It must still close hidden/preflight
//     eval sessions. The unconditional close was the root destabilizer —
//     every url.first step killed Chrome → dead context → relaunch →
//     "Restore pages?" + about:blank + launch races.
//  2. Canonical 'google' service must treat Google-family hosts and *.new
//     shortcuts as on-domain (isHostAlias) so deep links skip live
//     verifyDeepLinkUrl navigation of the shared session.

const path = require('path');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

// ── Stub the HTTP layer so resolve_deep_link never touches a real browser ──
// resolve_deep_link calls callBrowserAct (http to self) for close and
// _resolveTaskDeepLink (which we stub by intercepting at the module level).
// Simplest: exercise browserAgent() with a stubbed resolver via the
// action dispatcher — but the close is what we're testing, so we intercept
// the HTTP 'close' call through a require.cache shim on the http module is
// heavy. Instead test at the unit level we can reach: isHostAlias coverage,
// plus a static assertion that the close is gated on _dlHiddenResolved.

const { isHostAlias, lookupBrowserService } = require('../src/skills/browser.agent.cjs');

console.log('\n--- isHostAlias: google family on-domain ---');
const googleAliases = lookupBrowserService('google')?.hostAliases || [];
check('google service has hostAliases configured', googleAliases.length > 0, JSON.stringify(googleAliases));
check('sheets.new is on-domain for google', isHostAlias('sheets.new', 'google.com', googleAliases));
check('docs.new is on-domain for google', isHostAlias('docs.new', 'google.com', googleAliases));
check('cal.new is on-domain for google', isHostAlias('cal.new', 'google.com', googleAliases));
check('docs.google.com is on-domain for google', isHostAlias('docs.google.com', 'google.com', googleAliases));
check('calendar.google.com is on-domain for google', isHostAlias('calendar.google.com', 'google.com', googleAliases));
check('evil-sheets.new.attacker.com is NOT on-domain', !isHostAlias('evil-sheets.new.attacker.com', 'google.com', googleAliases));
check('example.com is NOT on-domain', !isHostAlias('example.com', 'google.com', googleAliases));

console.log('\n--- per-service aliases ---');
check('sheets.new on-domain for googlesheets', isHostAlias('sheets.new', 'sheets.google.com', lookupBrowserService('googlesheets')?.hostAliases || []));
check('docs.new on-domain for googledocs', isHostAlias('docs.new', 'docs.google.com', lookupBrowserService('googledocs')?.hostAliases || []));
check('cal.new on-domain for googlecalendar', isHostAlias('cal.new', 'calendar.google.com', lookupBrowserService('googlecalendar')?.hostAliases || []));

console.log('\n--- resolve_deep_link close gate (source-level) ---');
// The close used to run unconditionally on any sessionId. Assert the gate is
// present in the action handler: close only fires when _dlHiddenResolved.
const src = require('fs').readFileSync(path.join(__dirname, '../src/skills/browser.agent.cjs'), 'utf8');
const caseBlock = src.match(/case 'resolve_deep_link':[\s\S]{0,2500}/);
check('resolve_deep_link case found', !!caseBlock);
check('close is gated on _dlHiddenResolved', /if\s*\(\s*_sid\s*&&\s*_dlHiddenResolved\s*\)/.test(caseBlock ? caseBlock[0] : ''), caseBlock ? caseBlock[0].slice(0, 900) : '');

console.log('\n--- turn-loop OS OCR fallback gate (source-level) ---');
const pwSrc = require('fs').readFileSync(path.join(__dirname, '../src/skills/playwright.agent.cjs'), 'utf8');
check('turn-loop skips OCR tier when no engine page', /skipping OCR tier — no engine page/.test(pwSrc));
check('decomposition prompt forbids invented params', /NEVER invent parameter values absent from the goal/.test(pwSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
process.exit(failed ? 1 : 0);
