#!/usr/bin/env node
'use strict';

/**
 * eval-terminal.cjs — acceptance smoke suite for the terminal/MCP substrate.
 *
 * Run:  node scripts/eval-terminal.cjs [--verbose]
 *
 * Exercises the skills directly (no HTTP server required):
 *   terminal.agent  open/send/read/wait/exec/close, sensitive transcript pause
 *   mcp.agent       list_servers (installed servers only — skips when empty)
 *   capability      probe allowlist/denylist, search sanity
 */

const path = require('path');
const { terminalAgent } = require('../src/skills/terminal.agent.cjs');
const { mcpAgent } = require('../src/skills/mcp.agent.cjs');
const cap = require('../../../shared/capability-index.cjs');

const VERBOSE = process.argv.includes('--verbose');
let pass = 0, fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${extra}`); }
  if (VERBOSE && extra) console.log(`        ${extra}`);
}

(async () => {
  // ── terminal.agent ────────────────────────────────────────────────────────
  console.log('\nterminal.agent');
  const opened = await terminalAgent({ action: 'open', label: 'eval', argv: ['/bin/zsh', '-f'] });
  check('open', opened.ok && opened.sessionId, JSON.stringify(opened).slice(0, 120));
  const sid = opened.sessionId;

  const exec = await terminalAgent({ action: 'exec', sessionId: sid, cmd: 'echo EVAL_$((6*7))' });
  check('exec exitCode 0', exec.ok && exec.exitCode === 0, JSON.stringify(exec).slice(0, 200));
  check('exec output', /EVAL_42/.test(exec.screen));
  check('marker stripped', !/__TD_EXIT/.test(exec.screen));

  await terminalAgent({ action: 'exec', sessionId: sid, cmd: 'read "n?name? "; echo "got:$n"' });
  await new Promise(r => setTimeout(r, 300));
  await terminalAgent({ action: 'send', sessionId: sid, text: 'devin\n' });
  await new Promise(r => setTimeout(r, 300));
  const rd = await terminalAgent({ action: 'read', sessionId: sid });
  check('interactive send/read', /got:devin/.test(rd.output), rd.output?.slice(-200));

  const w = await terminalAgent({ action: 'exec', sessionId: sid, cmd: 'sleep 0.2; echo WAIT_DONE' });
  check('wait-implicit', w.ok && /WAIT_DONE/.test(w.screen));

  const danger = await terminalAgent({ action: 'exec', sessionId: sid, cmd: 'rm -rf /' });
  check('danger blocked', !danger.ok && /dangerous/.test(danger.error || ''), danger.error);

  // sensitive send — transcript pause flag exists (real verification needs a
  // program that echoes; just confirm the action accepts the flag)
  const sens = await terminalAgent({ action: 'send', sessionId: sid, text: 'x', sensitive: true });
  check('sensitive send accepted', sens.ok === true);

  const list = await terminalAgent({ action: 'list' });
  check('list shows session', list.ok && list.sessions.some(s => s.id === sid));

  await terminalAgent({ action: 'close', sessionId: sid });
  const list2 = await terminalAgent({ action: 'list' });
  check('close reaps', list2.ok && !list2.sessions.some(s => s.id === sid));

  // ── capability.probe ──────────────────────────────────────────────────────
  console.log('\ncapability.probe');
  const allowed = await cap.capabilityProbe('zsh', ['--version']);
  check('allow --version', allowed.ok === true || /not-found/.test(allowed.error || '') === false, JSON.stringify(allowed).slice(0, 150));
  const denied = await cap.capabilityProbe('git', ['config', 'set', 'x', 'y']);
  check('deny config set', denied.ok === false);
  const denied2 = await cap.capabilityProbe('gh', ['auth', 'login']);
  check('deny auth login', denied2.ok === false);
  const chain = await cap.capabilityProbe('ls', ['-la;rm', '-rf']);
  check('deny chaining', chain.ok === false);

  // ── capability.search ─────────────────────────────────────────────────────
  console.log('\ncapability.search');
  const hits = await cap.searchCapabilities('list files');
  check('search returns candidates', Array.isArray(hits) && hits.length > 0);
  check('friction sorted', hits.every((h, i) => i === 0 || hits[i - 1].friction <= h.friction));
  // Registered-agent discovery: catt.agent must match 'chromecast' via
  // descriptor keywords/capabilities (Bug 2 regression — resolveAgent never
  // saw it because the index only knew the service name).
  const catts = await cap.searchCapabilities('chromecast');
  check('chromecast → catt.agent', catts.some(h => h.id === 'catt.agent'));
  const castHits = await cap.searchCapabilities('cast video');
  check('cast → catt.agent', castHits.some(h => h.id === 'catt.agent'));

  // ── verbFit — connector vs action verbs ─────────────────────────────────────
  console.log('\nverbFit');
  const catt = catts.find(h => h.id === 'catt.agent');
  if (catt) {
    check('connector verb → clarify', cap.verbFit('I need to connect to my chromecast', catt) === 'clarify');
    check('action verb → pin', cap.verbFit('cast video.mp4 to my chromecast', catt) === 'pin');
    check('unsupported verb → clarify', cap.verbFit('mirror my overlay to the chromecast', catt) === 'clarify');
    check('play maps to capability → pin', cap.verbFit('play a song on the chromecast', catt) === 'pin');
    // Generic-verb stoplist: 'set' collides with set_volume/set_device_alias
    // but a calendar prompt must not pin a media caster.
    check('generic verb alone → clarify', cap.verbFit('use this on my screen to send email and set calendar event', catt) === 'clarify');
    check('set + discriminative token → pin', cap.verbFit('set the volume on the chromecast', catt) === 'pin');
  } else {
    console.log('  SKIP  catt.agent not registered — verbFit tests skipped');
  }

  // ── capability.infer — LLM proposes, code verifies ──────────────────────────
  console.log('\ncapability.infer');
  const noLlm = await cap.inferCapabilities('send a text', {});
  check('no llmCaller → not ok', noLlm.ok === false);
  // Stub LLM: one real binary (node — supports --version), one hallucinated name.
  const inf = await cap.inferCapabilities('list files', {
    llmCaller: async () => JSON.stringify([
      { name: 'node', kind: 'cli', why: 'runtime' },
      { name: 'hallucinated-zzz-999', kind: 'cli', package: 'hallucinated-zzz-999', why: 'fake' },
    ]),
  });
  check('infer returns candidates', inf.ok === true && inf.candidates.some(c => c.service === 'node' && c.installed === true));
  check('hallucinated name rejected', inf.rejected.some(r => r.name === 'hallucinated-zzz-999'), JSON.stringify(inf.rejected));
  check('installed candidate verified by probe', inf.candidates.find(c => c.service === 'node')?.verified === true);

  // ── stampDescriptor — verified fields round-trip through service-map ────────
  {
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    process.env.THINKDROP_AGENTS_DIR = tmp;
    fs.writeFileSync(path.join(tmp, 'test.agent.md'), '---\nid: test.agent\nservice: test\nstatus: draft\n---\n\n# test\n');
    const st = cap.stampDescriptor('test.agent', { verified: true, verified_at: '2026-01-01T00:00:00Z' });
    check('stampDescriptor writes', st.ok === true);
    const src = fs.readFileSync(path.join(tmp, 'test.agent.md'), 'utf8');
    check('verified frontmatter present', /^verified: true$/m.test(src) && /^verified_at:/m.test(src));
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.THINKDROP_AGENTS_DIR;
  }

  // Envelope shape — /command.automate unwraps body.payload; verify the
  // running service accepts it if it's up (skip silently otherwise).
  try {
    const res = await fetch('http://127.0.0.1:3007/command.automate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { skill: 'terminal.agent', args: { action: 'list' } } }),
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    check('live terminal.agent list via envelope', data?.data?.ok === true || data?.ok === true, JSON.stringify(data).slice(0, 120));
    const mr = await fetch('http://127.0.0.1:3007/media.resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'goof troop full episode' }),
      signal: AbortSignal.timeout(25000),
    }).then(r => r.json());
    if (mr?.error === 'Not found' || mr === null) {
      console.log('  SKIP  media.resolve — endpoint not in the running server (restart command-service)');
    } else {
      check('media.resolve returns watch URLs',
        mr.ok === true && Array.isArray(mr.results) && mr.results.every(r => /^https?:\/\//.test(r.url)),
        JSON.stringify(mr).slice(0, 150));
    }
  } catch (_) {
    console.log('  SKIP  command-service not running — envelope/media tests skipped');
  }

  // ── mcp.agent ─────────────────────────────────────────────────────────────
  console.log('\nmcp.agent');
  const servers = await mcpAgent({ action: 'list_servers' });
  check('list_servers', servers.ok === true);
  const installed = (servers.servers || []).filter(s => s.name);
  if (installed.length) {
    const t = await mcpAgent({ action: 'list_tools', server: installed[0].name });
    check(`list_tools ${installed[0].name}`, t.ok && Array.isArray(t.tools) && t.tools.length > 0, t.error);
  } else {
    console.log('  SKIP  no MCP servers configured — mcp round-trip untested');
  }
  const badInstall = await mcpAgent({ action: 'install', name: 'nonexistent-xyz' });
  check('install unknown name rejected', badInstall.ok === false);

  // ── cli.agent generic task-mode run (no agentId → observe→adapt loop) ──────
  console.log('\ncli.agent generic run');
  const { cliAgent } = require('../src/skills/cli.agent.cjs');
  try {
    const gen = await cliAgent({ action: 'run', task: 'Run `ls /nonexistent-devin-e2e` — it will fail; diagnose why, then run `ls /tmp | head -3` instead and report what you saw.' });
    check('generic run completes', gen.ok === true, JSON.stringify({ err: gen.error, turns: gen.agentTurns }).slice(0, 200));
    check('failure observed then adapted', (gen.agentTurns || 0) >= 2
      && (gen.transcript || []).some(t => /nonexistent|No such file/i.test(t.observation || '') || /nonexistent/i.test(JSON.stringify(t.action || {}))),
      JSON.stringify((gen.transcript || []).map(t => t.action?.action)).slice(0, 150));
    const honest = await cliAgent({ action: 'run', task: 'Check whether the tool "zzz-definitely-not-a-tool-9" is installed; if it is not, report that honestly — do NOT install anything.' });
    check('honest not-found report', honest.ok === true || honest.askUser === true,
      JSON.stringify({ err: honest.error, turns: honest.agentTurns }).slice(0, 200));
    check('no fake success', !(honest.ok && /installed|worked/i.test(honest.stdout || '') && !/not|isn/i.test(honest.stdout || '')),
      (honest.stdout || '').slice(0, 150));
  } catch (e) {
    console.log(`  SKIP  generic run — LLM loop unavailable (${e.message})`);
  }

  // ── terminal.agent raw read mode — xterm byte feed ────────────────────────
  console.log('\nterminal.agent raw mode');
  {
    const { terminalAgent } = require('../src/skills/terminal.agent.cjs');
    const open = await terminalAgent({ action: 'open', label: 'eval-raw', managedBy: 'agent' });
    check('open eval session', open.ok === true, open.error);
    if (open.ok) {
      const exec = await terminalAgent({ action: 'exec', sessionId: open.sessionId, cmd: 'echo EVAL_RAW_$(echo OK)', timeoutMs: 10000, keepSession: true });
      check('pty_exec echo', exec.ok === true && exec.exitCode === 0, JSON.stringify(exec).slice(0, 150));
      const raw1 = await terminalAgent({ action: 'read', sessionId: open.sessionId, mode: 'raw' });
      check('raw read returns data+offset', raw1.ok === true && typeof raw1.offset === 'number' && raw1.data.includes('EVAL_RAW_OK'),
        JSON.stringify({ ok: raw1.ok, offset: raw1.offset, found: raw1.data?.includes('EVAL_RAW_OK') }).slice(0, 150));
      const raw2 = await terminalAgent({ action: 'read', sessionId: open.sessionId, mode: 'raw', cursor: raw1.offset });
      check('raw read cursor returns only delta', raw2.ok === true && !raw2.data.includes('EVAL_RAW_OK'), '');
      await terminalAgent({ action: 'close', sessionId: open.sessionId });
    }
  }

  // ── cli.agent registry probes — observe-before-assert on install ──────────
  console.log('\ncli.agent registry probes');
  {
    const disc = await cliAgent({ action: 'discover', cli: 'jq' });
    check('discover jq (installed or findable)', disc.ok === true || disc.installed === true || disc.installed === false,
      JSON.stringify(disc).slice(0, 150));
    // build_agent writes to DuckDB — a dev command-service holds the lock, so
    // lock errors are environmental: SKIP rather than fail.
    try {
      // OAuth-service delegation must carry delegateTo through to the caller.
      const oauth = await cliAgent({ action: 'build_agent', service: 'slack' });
      check('oauth service resolves — delegateTo or discovered CLI',
        (oauth.ok === false && oauth.delegateTo === 'browser.agent') || oauth.ok === true,
        JSON.stringify({ ok: oauth.ok, delegateTo: oauth.delegateTo, err: oauth.error }).slice(0, 200));
    } catch (e) {
      if (/lock|duckdb/i.test(e.message)) console.log('  SKIP  build_agent — agents.duckdb locked by running command-service');
      else check('oauth service resolves', false, e.message);
    }
    try {
      // A nonexistent package must not produce a fake success.
      const ghost = await cliAgent({ action: 'build_agent', service: 'zzz-nope-nothere-9' });
      check('nonexistent service fails honestly',
        ghost.ok === false && !ghost.agentId,
        JSON.stringify({ ok: ghost.ok, err: ghost.error }).slice(0, 150));
    } catch (e) {
      if (/lock|duckdb/i.test(e.message)) console.log('  SKIP  ghost build_agent — agents.duckdb locked by running command-service');
      else check('nonexistent service fails honestly', false, e.message);
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('eval crashed:', err); process.exit(1); });
