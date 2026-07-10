'use strict';
/**
 * test-browser-signin-wall.cjs
 *
 * Regression tests for browser.agent sign-in-wall detection.
 *
 * Run from repo root with:
 *   node mcp-services/command-service/tests/test-browser-signin-wall.cjs
 */

const path = require('path');
const { _isSigninWall } = require(path.resolve(__dirname, '..', 'src/skills/browser.agent.cjs'));

let _passed = 0;
let _failed = 0;
const _failures = [];

function it(label, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    _failed++;
    _failures.push({ label, error: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function section(label) {
  console.log(`\n${'─'.repeat(72)}\n  ${label}\n${'─'.repeat(72)}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

section('Sign-in wall detection');

it('detects accounts.google.com as a sign-in wall', () => {
  assert(_isSigninWall('https://accounts.google.com/signin/v2/identifier'), 'expected sign-in wall');
});

it('detects workspace.google.com Gmail marketing page as a sign-in wall', () => {
  assert(_isSigninWall('https://workspace.google.com/intl/en-US/gmail/'), 'expected sign-in wall');
});

it('detects non-mail host with /gmail/ path as a sign-in wall', () => {
  assert(_isSigninWall('https://www.google.com/gmail/about/'), 'expected sign-in wall');
});

it('does NOT detect mail.google.com inbox as a sign-in wall', () => {
  assert(!_isSigninWall('https://mail.google.com/mail/u/0/#inbox'), 'should not be sign-in wall');
});

it('does NOT detect mail.google.com /gmail/ path as a sign-in wall', () => {
  assert(!_isSigninWall('https://mail.google.com/gmail/u/0/'), 'should not be sign-in wall');
});

it('detects generic /login paths', () => {
  assert(_isSigninWall('https://example.com/login'), 'expected sign-in wall');
});

it('returns false for empty/short hrefs', () => {
  assert(!_isSigninWall(''), 'empty href');
  assert(!_isSigninWall('abc'), 'short href');
  assert(!_isSigninWall(null), 'null href');
});

console.log(`\n${'─'.repeat(72)}`);
if (_failed === 0) {
  console.log(`✅ All ${_passed} tests passed.`);
} else {
  console.log(`❌ ${_passed} passed, ${_failed} failed.`);
  for (const f of _failures) {
    console.log(`   - ${f.label}: ${f.error}`);
  }
  process.exitCode = 1;
}
