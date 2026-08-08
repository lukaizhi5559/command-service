'use strict';
/**
 * test-cookie-sniff.cjs
 *
 * Unit tests for the CDP auth-cookie classifier (_classifyAuthCookies) used by
 * waitForAuth and the browser.agent preflight probe to auto-detect login.
 *
 * Run from repo root with:
 *   node mcp-services/command-service/tests/test-cookie-sniff.cjs
 */

const path = require('path');
const { _classifyAuthCookies } = require(path.resolve(__dirname, '..', 'src/skills/browser.act.cjs'));

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

function assertAuthed(result, expectedCookies, msg) {
  assert(result.authed === true, `${msg} — expected authed=true, got authed=${result.authed}`);
  if (expectedCookies) {
    for (const c of expectedCookies) {
      assert(result.cookies.includes(c), `${msg} — expected cookies to include "${c}", got [${result.cookies.join(',')}]`);
    }
  }
}

function assertNotAuthed(result, msg) {
  assert(result.authed === false, `${msg} — expected authed=false, got authed=${result.authed} cookies=[${result.cookies.join(',')}]`);
}

// ── Helper to build a cookie object ──────────────────────────────────────────
function cookie(name, opts = {}) {
  return {
    name,
    value: opts.value !== undefined ? opts.value : 'abc123',
    domain: opts.domain || '.slack.com',
    httpOnly: opts.httpOnly !== undefined ? opts.httpOnly : true,
    secure: opts.secure !== undefined ? opts.secure : true,
    path: opts.path || '/',
    expires: opts.expires || 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════
section('Auth-cookie detection — positive cases');
// ════════════════════════════════════════════════════════════════════════════

it('detects a single HttpOnly session cookie (sid)', () => {
  const result = _classifyAuthCookies([cookie('sid')], 'slack.com');
  assertAuthed(result, ['sid'], 'single sid');
});

it('detects connect.sid (Express)', () => {
  const result = _classifyAuthCookies([cookie('connect.sid', { domain: '.example.com' })], 'example.com');
  assertAuthed(result, ['connect.sid'], 'connect.sid');
});

it('detects __Secure-1PSIDTS (Google)', () => {
  const result = _classifyAuthCookies([cookie('__Secure-1PSIDTS', { domain: '.google.com' })], 'google.com');
  assertAuthed(result, ['__Secure-1PSIDTS'], '__Secure-1PSIDTS');
});

it('detects JWT token cookie', () => {
  const result = _classifyAuthCookies([cookie('jwt_token', { domain: '.api.example.com' })], 'api.example.com');
  assertAuthed(result, ['jwt_token'], 'jwt_token');
});

it('detects non-HttpOnly cookie with strong session name (token)', () => {
  const result = _classifyAuthCookies([cookie('token', { httpOnly: false })], 'slack.com');
  assertAuthed(result, ['token'], 'non-HttpOnly token');
});

it('detects remember_me cookie (auth stem, HttpOnly)', () => {
  const result = _classifyAuthCookies([cookie('remember_me', { domain: '.github.com' })], 'github.com');
  assertAuthed(result, ['remember_me'], 'remember_me');
});

it('detects auth cookie on exact domain match (no leading dot)', () => {
  const result = _classifyAuthCookies([cookie('session', { domain: 'slack.com' })], 'slack.com');
  assertAuthed(result, ['session'], 'exact domain');
});

it('detects auth cookie on subdomain of target', () => {
  const result = _classifyAuthCookies([cookie('sid', { domain: 'app.slack.com' })], 'slack.com');
  assertAuthed(result, ['sid'], 'subdomain cookie');
});

it('detects auth cookie when target is subdomain of cookie domain', () => {
  const result = _classifyAuthCookies([cookie('sid', { domain: '.slack.com' })], 'app.slack.com');
  assertAuthed(result, ['sid'], 'parent-domain cookie');
});

it('detects multiple auth cookies', () => {
  const result = _classifyAuthCookies([
    cookie('sid'),
    cookie('token'),
    cookie('remember_me'),
  ], 'slack.com');
  assertAuthed(result, ['sid', 'token', 'remember_me'], 'multiple cookies');
});

// ════════════════════════════════════════════════════════════════════════════
section('Auth-cookie detection — negative cases (excluded cookies)');
// ════════════════════════════════════════════════════════════════════════════

it('excludes CSRF cookies even if HttpOnly', () => {
  const result = _classifyAuthCookies([cookie('csrf_token')], 'slack.com');
  assertNotAuthed(result, 'csrf_token should be excluded');
});

it('excludes XSRF-TOKEN cookies', () => {
  const result = _classifyAuthCookies([cookie('XSRF-TOKEN')], 'slack.com');
  assertNotAuthed(result, 'XSRF-TOKEN should be excluded');
});

it('excludes locale/lang cookies', () => {
  const result = _classifyAuthCookies([cookie('locale', { httpOnly: false })], 'slack.com');
  assertNotAuthed(result, 'locale should be excluded');
});

it('excludes analytics cookies (_ga, _gid)', () => {
  const result = _classifyAuthCookies([
    cookie('_ga', { httpOnly: false, domain: '.slack.com' }),
    cookie('_gid', { httpOnly: false, domain: '.slack.com' }),
  ], 'slack.com');
  assertNotAuthed(result, '_ga/_gid should be excluded');
});

it('excludes consent cookies', () => {
  const result = _classifyAuthCookies([cookie('cookie_consent', { httpOnly: false })], 'slack.com');
  assertNotAuthed(result, 'cookie_consent should be excluded');
});

it('excludes guest/anonymous cookies', () => {
  const result = _classifyAuthCookies([cookie('guest_session', { httpOnly: false })], 'slack.com');
  assertNotAuthed(result, 'guest_session should be excluded');
});

it('excludes theme/pref cookies', () => {
  const result = _classifyAuthCookies([cookie('theme', { httpOnly: false })], 'slack.com');
  assertNotAuthed(result, 'theme should be excluded');
});

// ════════════════════════════════════════════════════════════════════════════
section('Auth-cookie detection — edge cases');
// ════════════════════════════════════════════════════════════════════════════

it('rejects empty-value cookies', () => {
  const result = _classifyAuthCookies([cookie('sid', { value: '' })], 'slack.com');
  assertNotAuthed(result, 'empty-value sid should not count');
});

it('rejects cookies on unrelated domain', () => {
  const result = _classifyAuthCookies([cookie('sid', { domain: '.evil.com' })], 'slack.com');
  assertNotAuthed(result, 'wrong-domain sid should not count');
});

it('rejects non-HttpOnly cookie with weak auth stem (user_lang)', () => {
  // "user_lang" matches "user" stem but is not HttpOnly and not a strong session name
  const result = _classifyAuthCookies([cookie('user_lang', { httpOnly: false })], 'slack.com');
  assertNotAuthed(result, 'user_lang should not count (weak stem, not HttpOnly)');
});

it('accepts non-HttpOnly cookie with strong session name (sessionid)', () => {
  const result = _classifyAuthCookies([cookie('sessionid', { httpOnly: false })], 'slack.com');
  assertAuthed(result, ['sessionid'], 'sessionid — strong name, non-HttpOnly OK');
});

it('returns not-authed for empty cookie array', () => {
  const result = _classifyAuthCookies([], 'slack.com');
  assertNotAuthed(result, 'empty array');
});

it('returns not-authed for null/undefined cookies', () => {
  assertNotAuthed(_classifyAuthCookies(null, 'slack.com'), 'null cookies');
  assertNotAuthed(_classifyAuthCookies(undefined, 'slack.com'), 'undefined cookies');
});

it('returns not-authed for missing targetDomain', () => {
  const result = _classifyAuthCookies([cookie('sid')], '');
  assertNotAuthed(result, 'empty targetDomain');
});

it('strips leading www. from targetDomain', () => {
  const result = _classifyAuthCookies([cookie('sid', { domain: '.slack.com' })], 'www.slack.com');
  assertAuthed(result, ['sid'], 'www. stripped');
});

it('mix of auth and excluded cookies — detects auth only', () => {
  const result = _classifyAuthCookies([
    cookie('_ga', { httpOnly: false }),
    cookie('csrf_token'),
    cookie('sid'),
    cookie('locale', { httpOnly: false }),
  ], 'slack.com');
  assertAuthed(result, ['sid'], 'only sid should match');
  assert(result.cookies.length === 1, `expected exactly 1 cookie, got ${result.cookies.length}`);
});

it('handles PHPSESSID (classic PHP session)', () => {
  const result = _classifyAuthCookies([cookie('PHPSESSID', { domain: '.example.com', httpOnly: true })], 'example.com');
  assertAuthed(result, ['PHPSESSID'], 'PHPSESSID');
});

it('handles JSESSIONID (Java)', () => {
  const result = _classifyAuthCookies([cookie('JSESSIONID', { domain: '.example.com', httpOnly: true })], 'example.com');
  assertAuthed(result, ['JSESSIONID'], 'JSESSIONID');
});

it('handles __Host- prefixed token cookie', () => {
  const result = _classifyAuthCookies([cookie('__Host-token', { domain: 'slack.com' })], 'slack.com');
  assertAuthed(result, ['__Host-token'], '__Host-token');
});

// ════════════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════════════
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
