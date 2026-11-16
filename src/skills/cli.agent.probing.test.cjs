'use strict';
/* Regression tests for cli.agent's discovery/probe path — the 'dentist'
 * incident: a recovery loop handed the malformed app.agent step to the
 * generic run loop, the auto-register regex matched 'add the dentist', an
 * unawaited whichCli guard waved it through, and a PTY prompt line made an
 * EMPTY `npm view dentist bin` look like a string-form bin — so the run did
 * `npm i -g dentist`, a no-bin library, for a calendar task.
 *
 * The registry probe hits npm/brew/PyPI live — run where network is fine.
 * Run: node mcp-services/command-service/src/skills/cli.agent.probing.test.cjs */

const assert = require('assert');
const { _autoRegisterInstalledCli, _probeRegistryCandidates } = require('./cli.agent.cjs');

(async () => {
  // ── _autoRegisterInstalledCli — verb/task gating ─────────────────────────
  {
    const r = await _autoRegisterInstalledCli(
      'Diagnose and complete: "Add the dentist appointment to the primary calendar using the Reminders app agent" failed: task or (filePath + prompt) is required. Probe reality first (command -v, npm view, brew info, --help) before retrying — report honestly if the step is impossible.',
      [], new Set()
    );
    assert(r === null, 'add-the-dentist task must not register a cli');
  }
  {
    // 'add'/'get' are not install verbs — a fetch task must not register
    const r = await _autoRegisterInstalledCli('add remindctl to my reminders', [], new Set());
    assert(r === null, "'add <tool>' is not an install task");
  }
  {
    // install-shaped task but NO install command ran this session
    const r = await _autoRegisterInstalledCli('Install and set up remindctl', [], new Set());
    assert(r === null, 'install-shaped task with no executed install must not register');
  }
  {
    // install ran but FAILED (sig absent from succeededSigs) → no register
    const transcript = [{ action: { action: 'run_shell', script: 'npm i -g remindctl' } }];
    const r = await _autoRegisterInstalledCli('Install and set up remindctl', transcript, new Set());
    assert(r === null, 'a failed install must not register');
  }
  {
    // filler capture — 'Install and set up X' must not extract svc='and'
    const transcript = [{ action: { action: 'run_shell', script: 'npm i -g and' } }];
    const sig = JSON.stringify({ a: 'run_shell', s: 'npm i -g and', argv: null, url: '' });
    const r = await _autoRegisterInstalledCli('Install and set up remindctl', transcript, new Set([sig]));
    assert(r === null, '"and" is filler — never a service');
  }
  {
    // full gates pass (verb + successful install + PATH) but the binary isn't
    // actually there → whichCli returns null → still no register. Exercises
    // the awaited whichCli guard (unawaited, a Promise is truthy → dead guard).
    const transcript = [{ action: { action: 'run_shell', script: 'npm i -g nonexistent-cli-zzz-9x' } }];
    const sig = JSON.stringify({ a: 'run_shell', s: 'npm i -g nonexistent-cli-zzz-9x', argv: null, url: '' });
    const r = await _autoRegisterInstalledCli('Install and set up nonexistent-cli-zzz-9x', transcript, new Set([sig]));
    assert(r === null, 'install of a nonexistent binary must not register');
  }

  // ── _probeRegistryCandidates — packages without a bin are libraries ──────
  // 'dentist' exists on npm but ships NO binary (string-dedenting library).
  // The probe must classify it as a library, never a CLI hit.
  {
    const hit = await _probeRegistryCandidates('dentist', { sessionId: null });
    assert(hit && hit.isLibrary === true && !hit.cli,
      `dentist must classify as library, got: ${JSON.stringify(hit)}`);
  }
  {
    // a real CLI package still resolves — the library gate must not over-block
    const hit = await _probeRegistryCandidates('http-server', { sessionId: null });
    if (hit) {
      assert(hit.isLibrary !== true && hit.cli, `http-server is a CLI: ${JSON.stringify(hit)}`);
    }
  }

  console.log('cli.agent.probing.test.cjs: all assertions passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
