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
// present in the action handler: close only fires when _dlHiddenResolved AND
// the session did not already exist before the call (live-session kill fix).
const src = require('fs').readFileSync(path.join(__dirname, '../src/skills/browser.agent.cjs'), 'utf8');
const caseBlock = src.match(/case 'resolve_deep_link':[\s\S]{0,3000}/);
check('resolve_deep_link case found', !!caseBlock);
const caseSrc = caseBlock ? caseBlock[0] : '';
check('close is gated on _dlHiddenResolved', /_sid\s*&&\s*_dlHiddenResolved/.test(caseSrc), caseSrc.slice(0, 900));
check('liveness is snapshotted BEFORE resolution', /_wasActive\s*=.*isSessionActive[\s\S]{0,400}_resolveTaskDeepLink/.test(caseSrc));
check('liveSession is threaded into _resolveTaskDeepLink', /liveSession:\s*_wasActive/.test(caseSrc));
check('close is gated on !_wasActive (pre-existing live session never closed)', /_sid\s*&&\s*_dlHiddenResolved\s*&&\s*!_wasActive/.test(caseSrc));

console.log('\n--- off-domain verify never hijacks a live session (source-level) ---');
check('off-domain candidates rejected when session is live', /_dlLiveSession[\s\S]{0,400}off-domain candidate rejected/.test(src));
check('verifyDeepLinkUrl forwards headed/hidden flags', /verifyDeepLinkUrl\([^)]*\{[^}]*headed:\s*_dlHeaded/.test(src) || /_vFlags\.headed/.test(src));

console.log('\n--- actionRun live-session probe guards (source-level) ---');
check('_preExistingLiveSession computed for silent preflight probes', /_preExistingLiveSession\s*=\s*_silentPreflightProbe[\s\S]{0,200}isSessionActive/.test(src));
check('restart block skipped for live session', /!_domainContinuitySkip\s*&&\s*!_preExistingLiveSession/.test(src));
check('probe navigate skipped for live session', /_preExistingLiveSession\s*\?\s*\{\s*ok:\s*true/.test(src));
check('hidden hydration retry skipped for live session', /_silentPreflightProbe\s*&&\s*!_preExistingLiveSession/.test(src));
check('self-heal retry nav skipped for live session', /_healedUrl\s*&&\s*!_preExistingLiveSession/.test(src));
check('_closeProbeSession helper guards probe closes', /_closeProbeSession[\s\S]{0,300}_preExistingLiveSession[\s\S]{0,200}not closing/.test(src));
check('auth-needed probe exit uses _closeProbeSession', /preflightProbe detected auth-needed[\s\S]{0,300}_closeProbeSession/.test(src));
check('auth-only exit uses _closeProbeSession', /auth-only call, stop here[\s\S]{0,400}_closeProbeSession/.test(src));

console.log('\n--- browser.act close-all except + resurrection (source-level) ---');
const actSrc = require('fs').readFileSync(path.join(__dirname, '../src/skills/browser.act.cjs'), 'utf8');
const closeAllBlock = actSrc.match(/case 'close-all':[\s\S]{0,1500}/);
check('close-all case found', !!closeAllBlock);
check('close-all honors args.except', /except/.test(closeAllBlock ? closeAllBlock[0] : '') && /_except\.has\(sid\)/.test(closeAllBlock ? closeAllBlock[0] : ''));
check('pre-switch resurrection block exists', /_PAGE_ACTION_RE[\s\S]{0,400}resurrecting at last URL/.test(actSrc));
check('_ensureEngine resumes at lastUrlFor', /lastUrlFor[\s\S]{0,600}resuming/.test(actSrc));
check('navigate passes skipResume', /_ensureEngine\([^)]*\{\s*skipResume:\s*true\s*\}\)/.test(actSrc));

const engSrc = require('fs').readFileSync(path.join(__dirname, '../src/skills/browser-engine.cjs'), 'utf8');
check('engine tracks lastUrl on getPage', /s\.lastUrl\s*=\s*_u/.test(engSrc));
check('closeSession stashes lastUrl into _lastUrls', /_lastUrls\.set\(sessionId/.test(engSrc));
check('lastUrlFor exported with TTL', /function lastUrlFor\(sessionId, ttlMs/.test(engSrc));

console.log('\n--- turn-loop OS OCR fallback gate (source-level) ---');
const pwSrc = require('fs').readFileSync(path.join(__dirname, '../src/skills/playwright.agent.cjs'), 'utf8');
check('turn-loop skips OCR tier when no engine page', /skipping OCR tier — no engine page/.test(pwSrc));
check('decomposition prompt forbids invented params', /NEVER invent parameter values absent from the goal/.test(pwSrc));

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log(`Failures: ${failures.join(', ')}`);
process.exit(failed ? 1 : 0);
