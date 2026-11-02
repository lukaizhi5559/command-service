'use strict';
/**
 * decision.test.cjs — boundedDecision fallback observability.
 *
 * The local→remote fallback transition must log at warn level — remote
 * fallbacks cost money/latency and debug-level lines never reach persisted
 * logs (observed: zero [Decision] lines during a run that fell back 23×).
 *
 * Run: node src/skill-helpers/decision.test.cjs
 */

const { boundedDecision } = require('./decision.cjs');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}
function loggerCap() {
  const logs = { info: [], warn: [], debug: [] };
  return {
    logs,
    info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m),
    debug: (m) => logs.debug.push(m),
  };
}

(async () => {
  // 1. Local success → info-level local line, no warn
  {
    const log = loggerCap();
    const v = await boundedDecision({
      site: 'test.local',
      questions: [{ id: 'q', type: 'choice', question: 'pick', options: ['a', 'b'] }],
      state: '',
      askDecision: async () => ({ answers: { q: { index: 1 } }, elapsedMs: 5, model: 'tev1:0.8b' }),
      local: (a) => a.q.index === 1 ? 'b' : 'a',
      remote: async () => 'remote-val',
      logger: log,
    });
    check('local answer returned', v === 'b');
    check('local logs info line', log.logs.info.some(m => m.includes('local') && m.includes('ms')));
    check('local logs no warn', log.logs.warn.length === 0);
  }

  // 2. Local null → remote fallback + WARN line (was debug — invisible)
  {
    const log = loggerCap();
    const v = await boundedDecision({
      site: 'test.null',
      questions: [{ id: 'q', type: 'choice', question: 'pick', options: ['a', 'b'] }],
      state: '',
      askDecision: async () => null,
      local: () => 'never',
      remote: async () => 'remote-val',
      logger: log,
    });
    check('remote fallback returned', v === 'remote-val');
    check('fallback logs WARN', log.logs.warn.some(m => m.includes('remote fallback')));
  }

  // 3. Local throw → remote fallback + WARN line
  {
    const log = loggerCap();
    const v = await boundedDecision({
      site: 'test.throw',
      questions: [{ id: 'q', type: 'choice', question: 'pick', options: ['a', 'b'] }],
      state: '',
      askDecision: async () => { throw new Error('phi4 down'); },
      local: () => 'never',
      remote: async () => 'remote-val',
      logger: log,
    });
    check('throw → remote fallback', v === 'remote-val');
    check('throw logs WARN', log.logs.warn.some(m => m.includes('failed') && m.includes('remote fallback')));
  }

  // 4. Low-confidence → remote fallback + WARN line
  {
    const log = loggerCap();
    const v = await boundedDecision({
      site: 'test.lowconf',
      questions: [{ id: 'q', type: 'choice', question: 'pick', options: ['a', 'b'] }],
      state: '',
      askDecision: async () => ({ answers: { q: { index: 0, confidence: 0.2 } }, elapsedMs: 5 }),
      local: (a) => 'a',
      remote: async () => 'remote-val',
      minConfidence: 0.6,
      logger: log,
    });
    check('low-conf → remote fallback', v === 'remote-val');
    check('low-conf logs WARN', log.logs.warn.some(m => m.includes('low-confidence')));
  }

  // 5. Disabled → remote directly, no warn (nothing to surface)
  {
    const log = loggerCap();
    const v = await boundedDecision({
      site: 'test.disabled',
      questions: [{ id: 'q', type: 'choice', question: 'pick', options: ['a', 'b'] }],
      state: '',
      askDecision: null,
      local: () => 'never',
      remote: async () => 'remote-val',
      logger: log,
    });
    check('disabled → remote', v === 'remote-val');
    check('disabled → no warn', log.logs.warn.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
