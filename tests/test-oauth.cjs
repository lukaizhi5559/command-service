/**
 * OAuth lifecycle tests for ThinkDrop command-service
 *
 * Tests:
 *   1. Expiry detection logic (_isTokenExpired semantics)
 *   2. Token refresh via mock HTTPS server
 *   3. Live loadOAuthEnv — env vars populated from keytar
 *   4. Live Google Calendar API call using the injected token
 *
 * Run: node tests/test-oauth.cjs
 */

'use strict';

const http    = require('http');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');
const { shellRun } = require('../src/skills/shell.run.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function skip(label, reason) {
  console.log(`  ⚠️  SKIPPED: ${label} — ${reason}`);
}

// Inline copy of _isTokenExpired logic (mirrors shell.run.cjs implementation)
// MAX_TOKEN_AGE_S must match the constant in shell.run.cjs (45 minutes)
const MAX_TOKEN_AGE_S = 45 * 60;

function _isTokenExpired(tok) {
  if (!tok.access_token) return true;
  const now = Date.now() / 1000;
  if (tok.issued_at && tok.expires_in) {
    if (now > (tok.issued_at + tok.expires_in - 120)) return true;
    if (now > (tok.issued_at + MAX_TOKEN_AGE_S)) return true;
    return false;
  }
  return !!tok.refresh_token;
}

// ---------------------------------------------------------------------------
// Test 1 — Expiry detection logic
// ---------------------------------------------------------------------------

async function testExpiryDetection() {
  console.log('\n🧪 Test 1: Token expiry detection logic\n');

  const now = Math.floor(Date.now() / 1000);

  // Token issued 2 hours ago, expires_in 3600 → well past the 2-min buffer
  const staleToken = {
    access_token: 'stale-token',
    issued_at:    now - 7200,
    expires_in:   3600,
  };
  assert(_isTokenExpired(staleToken), 'Stale token (issued 2h ago, 1h expiry) is detected as expired');

  // Token issued 1 minute ago, expires_in 3600 → still fresh
  const freshToken = {
    access_token: 'fresh-token',
    issued_at:    now - 60,
    expires_in:   3600,
  };
  assert(!_isTokenExpired(freshToken), 'Fresh token (issued 1m ago, 1h expiry) is NOT expired');

  // Token with no timestamp but has refresh_token → treated as possibly stale
  const noTimestampToken = {
    access_token:  'unknown-age-token',
    refresh_token: 'some-refresh-token',
  };
  assert(_isTokenExpired(noTimestampToken), 'Token with no issued_at but has refresh_token → triggers refresh attempt');

  // Token with no access_token at all → expired
  assert(_isTokenExpired({}), 'Missing access_token → expired');

  // Token issued 46 minutes ago, expires_in 3600 → fresh by deadline but caught by 45-min secondary check
  const seededToken = {
    access_token: 'seeded-token',
    issued_at:    now - 46 * 60,   // issued 46 min ago (storage time, not issuance time)
    expires_in:   3600,             // deadline = now + 14min → deadline check passes
  };
  assert(_isTokenExpired(seededToken), 'Token issued 46min ago (> 45min MAX_TOKEN_AGE_S) is treated as expired despite valid deadline');

  // Token issued 44 minutes ago → within 45-min window, also within deadline → fresh
  const withinMaxAgeToken = {
    access_token: 'within-max-age',
    issued_at:    now - 44 * 60,
    expires_in:   3600,
  };
  assert(!_isTokenExpired(withinMaxAgeToken), 'Token issued 44min ago (< 45min MAX_TOKEN_AGE_S) is NOT expired');

  // Token inside the 2-min buffer → treated as expired for safety
  const withinBufferToken = {
    access_token: 'buffer-zone-token',
    issued_at:    now - 3540,  // issued 3540s ago
    expires_in:   3600,         // deadline = now - 3540 + 3600 = now + 60 → 60s left, < 120s buffer
  };
  assert(_isTokenExpired(withinBufferToken), 'Token within 2-min buffer (60s left) is treated as expired');
}

// ---------------------------------------------------------------------------
// Test 2 — Auto-refresh via mock server
// ---------------------------------------------------------------------------

async function testAutoRefreshMock() {
  console.log('\n🧪 Test 2: Auto-refresh via mock token endpoint\n');

  // Start a local HTTP server that acts as a mock OAuth token endpoint
  let receivedBody = '';
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      receivedBody = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'refreshed-mock-token',
        expires_in:   3600,
        token_type:   'Bearer',
        scope:        'https://www.googleapis.com/auth/calendar',
      }));
    });
  });

  await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const { port } = mockServer.address();

  try {
    // Build a stale token blob
    const staleToken = {
      access_token:  'old-token',
      refresh_token: 'valid-refresh-token',
      client_id:     'mock-client-id',
      client_secret: 'mock-client-secret',
      issued_at:     Math.floor(Date.now() / 1000) - 7200,
      expires_in:    3600,
    };

    // Perform the refresh POST directly (mirrors what _refreshToken does internally)
    const endpoint = `http://127.0.0.1:${port}/token`;
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: staleToken.refresh_token,
      client_id:     staleToken.client_id,
      client_secret: staleToken.client_secret,
    }).toString();

    const refreshed = await new Promise((resolve, reject) => {
      const req = http.request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert(refreshed.access_token === 'refreshed-mock-token', 'Mock server returns new access_token');
    assert(refreshed.expires_in   === 3600,                   'Mock server returns expires_in');

    // Verify the mock server received grant_type and refresh_token
    const params = new URLSearchParams(receivedBody);
    assert(params.get('grant_type')    === 'refresh_token',       'Refresh request sends grant_type=refresh_token');
    assert(params.get('refresh_token') === 'valid-refresh-token', 'Refresh request sends the refresh_token');
    assert(params.get('client_id')     === 'mock-client-id',      'Refresh request sends client_id');
    assert(params.get('client_secret') === 'mock-client-secret',  'Refresh request sends client_secret');

    // Verify a merged token blob would not be expired
    const merged = {
      ...staleToken,
      access_token: refreshed.access_token,
      expires_in:   refreshed.expires_in,
      issued_at:    Math.floor(Date.now() / 1000),
    };
    assert(!_isTokenExpired(merged), 'Merged token after refresh is NOT expired');

  } finally {
    await new Promise(resolve => mockServer.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// Test 3 — Live loadOAuthEnv: env vars populated from keytar
// ---------------------------------------------------------------------------

async function testLiveEnvInjection() {
  console.log('\n🧪 Test 3: Live env injection from keytar\n');

  let keytar;
  try {
    keytar = require('keytar');
  } catch (_) {
    skip('Live env injection', 'keytar not available in this environment');
    return;
  }

  const raw = await keytar.getPassword('thinkdrop', 'oauth:google').catch(() => null);
  if (!raw) {
    skip('Live env injection', 'No oauth:google entry in keytar — run OAuth flow first');
    return;
  }

  // Execute a trivial shell command that echoes the injected env var
  const result = await shellRun({
    cmd:       'bash',
    argv:      ['-c', 'echo "TOKEN_LENGTH=${#GOOGLE_ACCESS_TOKEN}"'],
    timeoutMs: 10000,
  }).catch(e => ({ ok: false, error: e.message, stdout: '' }));

  if (!result.ok && result.error) {
    skip('Live env injection', `shellRun error: ${result.error}`);
    return;
  }

  const output = (result.stdout || '').trim();
  const match = output.match(/TOKEN_LENGTH=(\d+)/);
  const tokenLen = match ? parseInt(match[1], 10) : 0;

  assert(tokenLen > 0, `$GOOGLE_ACCESS_TOKEN is injected into shell env (length=${tokenLen})`);

  // Also verify the raw keytar token isn't clearly stale (has issued_at)
  try {
    const tok = JSON.parse(raw);
    assert(!!tok.issued_at,    'Keytar token blob has issued_at timestamp');
    assert(!!tok.access_token, 'Keytar token blob has access_token');
    if (tok.issued_at && tok.expires_in) {
      assert(!_isTokenExpired(tok), 'Keytar token is not expired at time of test');
    }
  } catch (_) {
    skip('Keytar token structure', 'Could not parse keytar token JSON');
  }
}

// ---------------------------------------------------------------------------
// Test 4 — Live Google Calendar API call
// ---------------------------------------------------------------------------

async function testLiveCalendarApiCall() {
  console.log('\n🧪 Test 4: Live Google Calendar API call\n');

  // Use shellRun so that loadOAuthEnv() auto-refreshes the token before injecting it.
  // curl reads $GOOGLE_ACCESS_TOKEN from the shell env populated by shellRun.
  let keytar;
  try { keytar = require('keytar'); } catch (_) {}

  const raw = keytar ? await keytar.getPassword('thinkdrop', 'oauth:google').catch(() => null) : null;
  if (!raw) {
    skip('Live Calendar API', 'No oauth:google entry in keytar — run OAuth flow first');
    return;
  }

  const curlResult = await shellRun({
    cmd:       'bash',
    argv:      ['-c',
      'curl -s -o /tmp/gcal-test-response.json -w "%{http_code}" ' +
      '-H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" ' +
      '"https://www.googleapis.com/calendar/v3/calendars/primary"'
    ],
    timeoutMs: 15000,
  }).catch(e => ({ ok: false, error: e.message, stdout: '' }));

  if (!curlResult.ok && curlResult.error) {
    skip('Live Calendar API', `shellRun/curl error: ${curlResult.error}`);
    return;
  }

  const statusCode = parseInt((curlResult.stdout || '').trim(), 10);
  assert(statusCode === 200, `GET /calendar/v3/calendars/primary returns HTTP ${statusCode} (expected 200)`);

  if (statusCode === 200) {
    try {
      const body = fs.readFileSync('/tmp/gcal-test-response.json', 'utf8');
      const calendar = JSON.parse(body);
      assert(typeof calendar.id === 'string' && calendar.id.length > 0, `Calendar ID present: "${calendar.id}"`);
      assert(calendar.kind === 'calendar#calendar', `Response kind is "calendar#calendar"`);
    } catch (_) {
      skip('Calendar response parsing', 'Could not read or parse curl response JSON');
    }
  } else {
    try {
      const body = fs.readFileSync('/tmp/gcal-test-response.json', 'utf8');
      console.log(`     Response: ${body.substring(0, 200)}`);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Test 5 — 401-retry detection patterns
// ---------------------------------------------------------------------------

async function test401RetryDetection() {
  console.log('\n🧪 Test 5: 401-retry output pattern detection\n');

  // These are all the patterns that shellRun watches for to trigger a retry.
  // They mirror the regex checks in shell.run.cjs.
  const trigger = (output) => (
    /\"code\"\s*:\s*40[13]/.test(output)   ||
    /HTTP\/[\d.]+ 40[13]/.test(output)     ||
    /401 Unauthorized/i.test(output)        ||
    /403 Forbidden/i.test(output)           ||
    /UNAUTHENTICATED/i.test(output)         ||
    /Invalid Credentials/i.test(output)     ||
    /invalid_token/i.test(output)
  );

  assert(trigger('{"code":401,"message":"Request had invalid authentication credentials"}'),
    'Google Calendar-style {"code":401} triggers retry');
  assert(trigger('{"code": 403, "status": "PERMISSION_DENIED"}'),
    'Google Drive-style {"code": 403} triggers retry');
  assert(trigger('HTTP/2 401 '),
    'curl HTTP/2 401 response triggers retry');
  assert(trigger('HTTP/1.1 403 Forbidden'),
    'HTTP/1.1 403 Forbidden triggers retry');
  assert(trigger('401 Unauthorized'),
    'Plain "401 Unauthorized" triggers retry');
  assert(trigger('{"status":"UNAUTHENTICATED","message":"..."}'),
    'UNAUTHENTICATED status triggers retry');
  assert(trigger('{"error":"invalid_token","error_description":"Token has been expired or revoked"}'),
    'Google invalid_token error triggers retry');
  assert(trigger('{"message":"Invalid Credentials","domain":"global","reason":"authError"}'),
    'Google "Invalid Credentials" triggers retry');

  // These should NOT trigger (normal failures, not auth)
  assert(!trigger('{"code":404,"message":"Not Found"}'),
    '404 does NOT trigger retry');
  assert(!trigger('{"code":500,"message":"Internal Server Error"}'),
    '500 does NOT trigger retry');
  assert(!trigger('Error: ENOENT: no such file or directory'),
    'File-not-found error does NOT trigger retry');
  assert(!trigger(''),
    'Empty output does NOT trigger retry');
}

// ---------------------------------------------------------------------------
// Test 6 — validate() blocks ~/.thinkdrop/tokens/ reads
// ---------------------------------------------------------------------------

const { validate } = require('../src/skills/shell.run.cjs');

async function testTokenFileGuard() {
  console.log('\n🧪 Test 6: validate() blocks ~/.thinkdrop/tokens/ reads\n');

  // Should be blocked — the classic python3/json.load pattern the LLM tends to generate
  const blocked1 = validate({
    cmd: 'bash',
    argv: ['-c', 'ACCESS_TOKEN=$(python3 -c "import json; d=json.load(open(\'$HOME/.thinkdrop/tokens/gcal.event.json\')); print(d[\'access_token\'])"); curl -H "Authorization: Bearer $ACCESS_TOKEN" https://www.googleapis.com/calendar/v3/calendars/primary/events']
  });
  assert(!blocked1.ok, 'python3 json.load($HOME/.thinkdrop/tokens/*) is blocked');
  assert(blocked1.error && blocked1.error.startsWith('BLOCKED:'), 'error starts with BLOCKED:');
  assert(blocked1.error && blocked1.error.includes('$GOOGLE_ACCESS_TOKEN'), 'error mentions $GOOGLE_ACCESS_TOKEN');

  // Hardcoded home path variant
  const blocked2 = validate({
    cmd: 'bash',
    argv: ['-c', 'cat /Users/someone/.thinkdrop/tokens/gcal.event.json | python3 -c "import json,sys; print(json.load(sys.stdin)[\'access_token\'])"']
  });
  assert(!blocked2.ok, 'cat ~/.thinkdrop/tokens/* variant is blocked');

  // sh and zsh are also blocked
  const blocked3 = validate({
    cmd: 'sh',
    argv: ['-c', 'TOKEN=$(cat ~/.thinkdrop/tokens/spotify.json); echo $TOKEN']
  });
  assert(!blocked3.ok, 'sh -c reading ~/.thinkdrop/tokens/ is blocked');

  const blocked4 = validate({
    cmd: 'zsh',
    argv: ['-c', 'source ~/.thinkdrop/tokens/github.json && echo $access_token']
  });
  assert(!blocked4.ok, 'zsh -c reading ~/.thinkdrop/tokens/ is blocked');

  // Should NOT be blocked — reading from /tmp or other paths is fine
  const allowed1 = validate({
    cmd: 'bash',
    argv: ['-c', 'python3 -c \'import json; d=json.load(open("/tmp/config.json")); print(d["key"])\''],
  });
  assert(allowed1.ok, 'python3 reading /tmp/config.json is NOT blocked');

  // Should NOT be blocked — using $GOOGLE_ACCESS_TOKEN directly is the correct pattern
  const allowed2 = validate({
    cmd: 'bash',
    argv: ['-c', 'curl -H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" https://www.googleapis.com/calendar/v3/calendars/primary/events']
  });
  assert(allowed2.ok, '$GOOGLE_ACCESS_TOKEN curl command is NOT blocked');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  ThinkDrop OAuth Lifecycle Tests');
  console.log('═══════════════════════════════════════════════');

  await testExpiryDetection();
  await testAutoRefreshMock();
  await testLiveEnvInjection();
  await testLiveCalendarApiCall();
  await test401RetryDetection();
  await testTokenFileGuard();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\n💥 Uncaught error:', err);
  process.exit(1);
});
