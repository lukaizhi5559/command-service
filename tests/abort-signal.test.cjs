'use strict';
/**
 * abort-signal.test.cjs — cancellation propagation through the skill layer:
 *
 *   - shell.run kills its spawned process when _abortSignal fires (the
 *     "cancel left sleep/git/browser children running" bug);
 *   - a pre-aborted signal short-circuits before spawn;
 *   - browser.act's ALS context binds the signal per-invocation — a cancelled
 *     call returns before touching playwright-cli, and nested calls inside
 *     runWithActSignal inherit it;
 *   - instruction.runner exits its step loop on a cancelled signal.
 *
 * Run: node mcp-services/command-service/tests/abort-signal.test.cjs
 */
const { shellRun } = require('../src/skills/shell.run.cjs');
const { browserAct, runWithActSignal, _currentSignal } = require('../src/skills/browser.act.cjs');
const { runInstructionSkill } = require('../src/skills/instruction.runner.cjs');

let passed = 0, failed = 0;
function ok(cond, label, extra = '') {
  if (cond) { passed++; console.log('  PASS:', label); }
  else { failed++; console.error(`  FAIL: ${label} ${extra}`); }
}

(async () => {
  // ── shell.run ──────────────────────────────────────────────────────────────

  // 1. Pre-aborted signal → immediate cancel, no spawn.
  {
    const c = new AbortController();
    c.abort();
    const r = await shellRun({ cmd: 'echo', argv: ['hi'], _abortSignal: c.signal });
    ok(r.ok === false && r.cancelled === true, 'shell.run: pre-aborted signal → cancelled', JSON.stringify(r));
  }

  // 2. Abort mid-run → the spawned child is killed and the promise settles.
  {
    const c = new AbortController();
    const t0 = Date.now();
    const p = shellRun({ cmd: 'bash', argv: ['-c', 'sleep 30'], timeoutMs: 30000, _abortSignal: c.signal });
    setTimeout(() => c.abort(), 100);
    const r = await p;
    const elapsed = Date.now() - t0;
    ok(r.ok === false && r.cancelled === true, 'shell.run: mid-run abort → cancelled', JSON.stringify(r));
    ok(elapsed < 5000, `shell.run: abort settled fast (${elapsed}ms, expected < 5000)`);
  }

  // 3. No signal → normal execution unchanged.
  {
    const r = await shellRun({ cmd: 'echo', argv: ['ok'], timeoutMs: 5000 });
    ok(r.ok === true && r.stdout.trim() === 'ok', 'shell.run: no signal still works', JSON.stringify(r));
  }

  // ── browser.act ALS signal context ─────────────────────────────────────────

  // 4. _currentSignal is null outside any bound context.
  ok(_currentSignal() === null, 'browser.act: no signal outside a bound context');

  // 5. runWithActSignal exposes the signal to the inner context.
  {
    const c = new AbortController();
    const seen = runWithActSignal(c.signal, () => _currentSignal());
    ok(seen === c.signal, 'browser.act: runWithActSignal binds the signal');
  }

  // 6. Pre-aborted signal → browserAct returns cancelled before any lane work.
  {
    const c = new AbortController();
    c.abort();
    const r = await browserAct({ action: 'press', sessionId: 't', key: 'Tab', _abortSignal: c.signal });
    ok(r.ok === false && r.cancelled === true, 'browser.act: pre-aborted → cancelled', JSON.stringify(r));
  }

  // 7. A call inside a cancelled context inherits the abort (no explicit arg).
  {
    const c = new AbortController();
    c.abort();
    const r = await runWithActSignal(c.signal, () => browserAct({ action: 'press', sessionId: 't', key: 'Tab' }));
    ok(r.ok === false && r.cancelled === true, 'browser.act: inherited abort → cancelled', JSON.stringify(r));
  }

  // ── instruction.runner ─────────────────────────────────────────────────────

  // 8. Pre-aborted → runInstructionSkill exits immediately (no browser spawn).
  {
    const c = new AbortController();
    c.abort();
    const r = await runInstructionSkill({
      sessionId: 't', instructions: '1. press Tab', timeoutMs: 5000, _abortSignal: c.signal,
    });
    ok(r.ok === false && r.cancelled === true, 'instruction.runner: pre-aborted → cancelled', JSON.stringify(r));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
