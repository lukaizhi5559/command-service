'use strict';
/**
 * tests/test-agents.cjs
 *
 * Unit tests for cli.agent and browser.agent skills.
 *
 * Strategy: inject mocks into require.cache BEFORE loading skill modules so
 * that top-level destructured bindings (e.g. `const { spawn } = require('child_process')`)
 * pick up the fake implementations. http.request is patched on the live module
 * object after load (browser.agent holds a reference, not a copy).
 *
 * Run: node tests/test-agents.cjs
 */

const assert  = require('assert').strict;
const path    = require('path');
const { EventEmitter } = require('events');

// ─── Shared mutable mock state (reset between tests) ─────────────────────────
let mockLLMResponse = null;   // string → callLLM returns this; null → emit error
const mockDbRows    = {};     // tableName → rows[]
let mockSpawnResult = null;   // { stdout, stderr, exitCode } for non-which spawns
const mockExecFileMap = {};   // cmd → { err, stdout, stderr }
const execFileCalls = [];     // tracks every execFile(cmd, ...) call

// ─── Fake WebSocket (ws) ──────────────────────────────────────────────────────
// callLLM opens a WS, waits for open, sends a request, accumulates stream chunks.
// MockWebSocket immediately emits the configured mockLLMResponse as a stream.
class MockWebSocket extends EventEmitter {
  constructor(_url) {   // url arg accepted but ignored
    super();
    setImmediate(() => {
      this.emit('open');
      const reply = mockLLMResponse;
      setImmediate(() => {
        if (reply !== null) {
          this.emit('message', Buffer.from(JSON.stringify({ type: 'llm_stream_start' })));
          this.emit('message', Buffer.from(JSON.stringify({ type: 'llm_stream_chunk', payload: { chunk: reply } })));
          this.emit('message', Buffer.from(JSON.stringify({ type: 'llm_stream_end' })));
        } else {
          this.emit('error', new Error('mock: no LLM response configured'));
        }
      });
    });
  }
  send()      {}
  close()     {}
  terminate() {}
}

// ─── Fake DuckDB (callback-style, matches duckdb package API) ────────────────
// getDb() in cli/browser.agent caches _db in a module-level var after first call.
// mockDbRows is read dynamically so changing it between tests changes responses.

class MockDuckdbDatabase {
  constructor(_dbPath, cb) {
    // Async success callback — code does: const raw = await new Promise((res, rej) => { const db = new Database(path, (err) => { if (err) rej(err); else res(db); }); });
    setImmediate(() => { if (cb) cb(null); });
  }
  run(sql, ...p) {
    const cb = p.find(x => typeof x === 'function');
    if (cb) process.nextTick(() => cb(null));
  }
  all(sql, ...p) {
    const cb = p.find(x => typeof x === 'function');
    const m = sql.match(/FROM\s+(\w+)/i);
    const rows = m ? (mockDbRows[m[1]] || []) : [];
    if (cb) process.nextTick(() => cb(null, rows));
  }
  get(sql, ...p) {
    const cb = p.find(x => typeof x === 'function');
    const m = sql.match(/FROM\s+(\w+)/i);
    const rows = m ? (mockDbRows[m[1]] || []) : [];
    if (cb) process.nextTick(() => cb(null, rows[0] || null));
  }
  close(cb) { if (cb) process.nextTick(cb); }
}
const mockDuckdb = { Database: MockDuckdbDatabase };

// duckdb-async (optional/unlikely to be installed) — if present, provide same interface via promises
const mockDuckdbAsync = {
  Database: {
    create: async () => {
      const raw = new MockDuckdbDatabase('', null);
      return {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise(res => raw.close(res)),
      };
    }
  }
};

// ─── Fake child_process ───────────────────────────────────────────────────────
// Must be injected BEFORE loading cli.agent.cjs since it destructures spawn at the top level.
const origCp = require('child_process');
const fakeCp = {
  ...origCp,
  spawn: (cmd, argv, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin  = { write: () => {}, end: () => {} };
    // 'which' lookups must succeed so whichCli() resolves a binary path.
    const isWhich = (cmd === 'which');
    const res = isWhich
      ? { stdout: `/usr/local/bin/${argv[0]}\n`, stderr: '', exitCode: 0 }
      : (mockSpawnResult || { stdout: '', stderr: '', exitCode: 0 });
    setImmediate(() => {
      if (res.stdout) proc.stdout.emit('data', res.stdout);
      if (res.stderr) proc.stderr.emit('data', res.stderr);
      proc.emit('close', res.exitCode ?? 0);
    });
    return proc;
  },
  execFile: (cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    execFileCalls.push(cmd);
    if (cmd in mockExecFileMap) {
      const r = mockExecFileMap[cmd];
      return process.nextTick(() => cb(r.err || null, r.stdout || '', r.stderr || ''));
    }
    return origCp.execFile(cmd, args, opts, cb);
  },
};

// ─── Inject into require.cache before loading skill modules ──────────────────
const cpKey = require.resolve('child_process');
require.cache[cpKey] = { id: cpKey, filename: cpKey, loaded: true, exports: fakeCp };

// ws (3rd-party) — may or may not be installed at this path level
let wsKey;
try { wsKey = require.resolve('ws'); } catch { wsKey = null; }
if (wsKey) {
  require.cache[wsKey] = { id: wsKey, filename: wsKey, loaded: true, exports: MockWebSocket };
}

// duckdb-async (optional — try to resolve, inject if present)
let ddbAsyncKey;
try { ddbAsyncKey = require.resolve('duckdb-async'); } catch { ddbAsyncKey = null; }
if (ddbAsyncKey) {
  require.cache[ddbAsyncKey] = { id: ddbAsyncKey, filename: ddbAsyncKey, loaded: true, exports: mockDuckdbAsync };
}

// duckdb (production fallback used when duckdb-async is absent)
let ddbKey;
try { ddbKey = require.resolve('duckdb'); } catch { ddbKey = null; }
if (ddbKey) {
  require.cache[ddbKey] = { id: ddbKey, filename: ddbKey, loaded: true, exports: mockDuckdb };
}

// ─── Load skill modules (picks up all mocked dependencies) ───────────────────
const { cliAgent }     = require('../src/skills/cli.agent.cjs');
const { browserAgent } = require('../src/skills/browser.agent.cjs');

// ─── http mock (mutate after load — browser.agent holds a ref to the http obj) ─
const http = require('http');
let _origHttpRequest = null;
function mockHttp(responseBody) {
  _origHttpRequest = http.request;
  http.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    setImmediate(() => {
      if (cb) cb(res);
      setImmediate(() => { res.emit('data', responseBody); res.emit('end'); });
    });
    const req = { write: () => {}, end: () => {}, on: (_e, _f) => req, destroy: () => {} };
    return req;
  };
}
function restoreHttp() {
  if (_origHttpRequest) { http.request = _origHttpRequest; _origHttpRequest = null; }
}

// ─── Test runner ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

async function test(name, fn) {
  // Reset all shared mock state before each test
  mockLLMResponse = null;
  mockSpawnResult = null;
  Object.keys(mockDbRows).forEach(k => delete mockDbRows[k]);
  Object.keys(mockExecFileMap).forEach(k => delete mockExecFileMap[k]);
  execFileCalls.length = 0;
  restoreHttp();
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌  ${name}`);
    console.log(`       ${err.message}`);
    failed++;
  }
}

// ─── Test cases ──────────────────────────────────────────────────────────────
async function runAll() {
  console.log('\n🧪  test-agents.cjs\n');

  // U-01: cli.agent agentic run — happy path
  await test('U-01: cli.agent agentic run returns ok + inferredArgv', async () => {
    mockDbRows['agents']  = [{ id: 'github.agent', cli_tool: 'gh', status: 'healthy', descriptor: 'type: cli\nservice: github' }];
    mockLLMResponse       = JSON.stringify({ argv: ['repo', 'list'], reasoning: 'list all repos' });
    mockSpawnResult       = { stdout: 'org/repo1\norg/repo2\n', stderr: '', exitCode: 0 };

    const result = await cliAgent({ action: 'run', agentId: 'github.agent', task: 'list my repos' });

    assert.equal(result.ok, true,                              `ok should be true, got: ${JSON.stringify(result)}`);
    assert.equal(result.agentId,     'github.agent');
    assert.deepEqual(result.inferredArgv, ['repo', 'list'],   `inferredArgv mismatch: ${JSON.stringify(result.inferredArgv)}`);
    assert.ok(result.stdout.includes('repo1'),                 `stdout should contain repo1: ${result.stdout}`);
  });

  // U-02: cli.agent unknown agentId → needsBuild
  await test('U-02: cli.agent unknown agentId returns needsBuild=true', async () => {
    mockDbRows['agents'] = [];   // empty — agent not found

    const result = await cliAgent({ action: 'run', agentId: 'notion.agent', task: 'create a page' });

    assert.equal(result.ok,        false,  `ok should be false, got: ${JSON.stringify(result)}`);
    assert.equal(result.needsBuild, true,  `needsBuild should be true, got: ${JSON.stringify(result)}`);
  });

  // U-03: cli.agent backward compat { cli, argv } — raw path, no agentId
  await test('U-03: cli.agent raw path (backward compat) returns stdout', async () => {
    mockSpawnResult = { stdout: 'hello world\n', stderr: '', exitCode: 0 };

    const result = await cliAgent({ action: 'run', cli: 'echo', argv: ['hello', 'world'] });

    assert.equal(result.ok, true,                      `ok should be true, got: ${JSON.stringify(result)}`);
    assert.ok(result.stdout.includes('hello world'),   `stdout should contain "hello world": ${result.stdout}`);
    assert.equal(result.inferredArgv, undefined,       'raw path must not set inferredArgv');
  });

  // U-04: browser.agent type=api_key — env var provides credential, curl succeeds
  await test('U-04: browser.agent api_key run succeeds with env-var credential', async () => {
    process.env.OPENAI_PRIMARY = 'sk-test-key';
    mockDbRows['agents'] = [{
      id:         'openai.agent',
      type:       'browser',
      service:    'openai',
      status:     'healthy',
      descriptor: 'type: api_key\nservice: openai\nstart_url: https://api.openai.com',
    }];
    mockLLMResponse = JSON.stringify({
      curlArgs:  ['-s', '-f', 'https://api.openai.com/v1/models', '-H', 'Authorization: Bearer $CRED_PRIMARY'],
      credVars:  ['PRIMARY'],
      reasoning: 'fetch models list',
    });
    mockExecFileMap['curl'] = { err: null, stdout: '{"object":"list","data":[]}', stderr: '' };

    const result = await browserAgent({ action: 'run', agentId: 'openai.agent', task: 'list models' });
    delete process.env.OPENAI_PRIMARY;

    assert.equal(result.ok,     true,           `ok should be true, got: ${JSON.stringify(result)}`);
    assert.equal(result.agentId,'openai.agent');
    assert.ok(result.stdout.includes('"object"'), `stdout should contain JSON, got: ${result.stdout}`);
  });

  // U-05: browser.agent type=api_key — no credential → needsCredentials
  await test('U-05: browser.agent api_key missing credential returns needsCredentials=true', async () => {
    // Explicitly clear any lingering env vars for this service
    delete process.env.STRIPE_PRIMARY;
    delete process.env.STRIPE_API_KEY;
    delete process.env.STRIPE_TOKEN;

    mockDbRows['agents'] = [{
      id:         'stripe.agent',
      type:       'browser',
      service:    'stripe',
      status:     'healthy',
      descriptor: 'type: api_key\nservice: stripe\nstart_url: https://api.stripe.com',
    }];
    mockLLMResponse = JSON.stringify({
      curlArgs:  ['-s', '-f', 'https://api.stripe.com/v1/customers', '-H', 'Authorization: Bearer $CRED_PRIMARY'],
      credVars:  ['PRIMARY'],
      reasoning: 'list customers',
    });
    // security returns an error (key not in Keychain)
    mockExecFileMap['security'] = { err: new Error('security: not found'), stdout: '', stderr: '' };

    const result = await browserAgent({ action: 'run', agentId: 'stripe.agent', task: 'list customers' });

    assert.equal(result.ok,              false, `ok should be false, got: ${JSON.stringify(result)}`);
    assert.equal(result.needsCredentials, true, `needsCredentials should be true, got: ${JSON.stringify(result)}`);
  });

  // U-06: browser.agent type=browser → delegates to playwright.agent via callSkill
  await test('U-06: browser.agent browser type propagates playwright.agent result', async () => {
    mockDbRows['agents'] = [{
      id:         'notion.agent',
      type:       'browser',
      service:    'notion',
      status:     'healthy',
      descriptor: 'type: browser\nservice: notion\nstart_url: https://notion.so\nsign_in_url: https://notion.so/login\nauth_success_pattern: notion.so/dashboard',
    }];

    // Two sequential HTTP calls: waitForAuth → playwright.agent delegation
    let callIdx = 0;
    const httpResponses = [
      JSON.stringify({ data: { ok: true } }),
      JSON.stringify({ data: { ok: true, result: 'page created', transcript: [], turns: 3, done: true } }),
    ];
    _origHttpRequest = http.request;
    http.request = (_opts, cb) => {
      const body = httpResponses[callIdx++] || JSON.stringify({ data: { ok: false, error: 'unexpected call' } });
      const res  = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        if (cb) cb(res);
        setImmediate(() => { res.emit('data', body); res.emit('end'); });
      });
      const req = { write: () => {}, end: () => {}, on: (_e, _f) => req, destroy: () => {} };
      return req;
    };

    const result = await browserAgent({ action: 'run', agentId: 'notion.agent', task: 'create a test page' });
    restoreHttp();

    assert.equal(result.ok,            true,          `ok should be true, got: ${JSON.stringify(result)}`);
    assert.equal(result.agentId,       'notion.agent');
    assert.equal(result.authenticated, true,          'authenticated flag should be true');
    assert.ok(result.result.includes('page created'),  `result should contain "page created": ${result.result}`);
  });

  // U-07: resolveCredential uses env var — Keychain (security execFile) must NOT be called
  await test('U-07: resolveCredential uses env var; skips Keychain security call', async () => {
    // Set env vars for ALL three credential slots so every resolveCredential call
    // returns early before reaching the macOS Keychain / security execFile lookup.
    process.env.HUBSPOT_PRIMARY  = 'hs-test-token';
    process.env.HUBSPOT_USERNAME = 'testuser';
    process.env.HUBSPOT_DOMAIN   = 'hub.test';
    mockDbRows['agents'] = [{
      id:         'hubspot.agent',
      type:       'browser',
      service:    'hubspot',
      status:     'healthy',
      descriptor: 'type: api_key\nservice: hubspot\nstart_url: https://api.hubapi.com',
    }];
    mockLLMResponse = JSON.stringify({
      curlArgs:  ['-s', 'https://api.hubapi.com/contacts/v1/lists', '-H', 'Authorization: Bearer $CRED_PRIMARY'],
      credVars:  ['PRIMARY'],
      reasoning: 'list contact lists',
    });
    mockExecFileMap['curl'] = { err: null, stdout: '{"lists":[]}', stderr: '' };

    const result = await browserAgent({ action: 'run', agentId: 'hubspot.agent', task: 'list contacts' });
    delete process.env.HUBSPOT_PRIMARY;
    delete process.env.HUBSPOT_USERNAME;
    delete process.env.HUBSPOT_DOMAIN;

    const securityCalls = execFileCalls.filter(c => c === 'security').length;
    assert.equal(result.ok,    true,   `ok should be true, got: ${JSON.stringify(result)}`);
    assert.equal(securityCalls, 0,     `security should not be called when env var is present, called ${securityCalls} time(s)`);
  });

  // U-08: callSkill returns malformed JSON → browser.agent catches parse error
  await test('U-08: callSkill malformed JSON response surfaces parse error in result', async () => {
    mockDbRows['agents'] = [{
      id:         'slack.agent',
      type:       'browser',
      service:    'slack',
      status:     'healthy',
      descriptor: 'type: browser\nservice: slack\nstart_url: https://slack.com\nsign_in_url: https://slack.com/signin\nauth_success_pattern: slack.com/client',
    }];

    let callIdx = 0;
    const httpResponses = [
      JSON.stringify({ data: { ok: true } }),  // waitForAuth succeeds
      'THIS IS NOT VALID JSON',                 // playwright.agent responds with garbage → parse error
    ];
    _origHttpRequest = http.request;
    http.request = (_opts, cb) => {
      const body = httpResponses[callIdx++] || '';
      const res  = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => {
        if (cb) cb(res);
        setImmediate(() => { res.emit('data', body); res.emit('end'); });
      });
      const req = { write: () => {}, end: () => {}, on: (_e, _f) => req, destroy: () => {} };
      return req;
    };

    const result = await browserAgent({ action: 'run', agentId: 'slack.agent', task: 'send a message' });
    restoreHttp();

    assert.equal(result.ok, false, `ok should be false, got: ${JSON.stringify(result)}`);
    assert.ok(
      result.error && (result.error.toLowerCase().includes('parse') || result.error.toLowerCase().includes('failed')),
      `expected parse/delegation error in result.error, got: ${result.error}`
    );
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}\n`);
  if (failed > 0) process.exit(1);
}

runAll().catch(err => {
  console.error('\nTest runner crashed:', err);
  process.exit(1);
});
