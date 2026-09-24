'use strict';

// Tests for the protected-path sandbox (Seatbelt):
//   - write to an attached file is denied (EPERM), any mechanism
//   - read of an attached file is allowed
//   - write to a NON-protected file is allowed
//   - no protectedPaths → unsandboxed (no `sandboxed` marker)
//   - marker `sandboxed: true` is present on results when protection active

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellRun } = require('../src/skills/shell.run.cjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const hasSandbox = fs.existsSync('/usr/bin/sandbox-exec');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-test-'));
  const protectedFile = path.join(dir, 'attached.txt');
  const otherFile = path.join(dir, 'other.txt');
  fs.writeFileSync(protectedFile, 'original content\n');
  fs.writeFileSync(otherFile, 'other\n');
  const resolvedProtected = fs.realpathSync(protectedFile);
  const prot = [{ original: protectedFile, resolved: resolvedProtected }];

  // 1. Direct write to protected file — denied, file unchanged.
  let r = await shellRun({
    cmd: 'python3',
    argv: ['-c', `open(${JSON.stringify(protectedFile)}, 'w').write('hacked')`],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  check('protected write denied', hasSandbox ? (r.ok === false && r.sandboxed === true) : r.sandboxed === undefined, JSON.stringify({ ok: r.ok, err: r.error }));
  check('protected file unchanged', fs.readFileSync(protectedFile, 'utf8') === 'original content\n');

  // 2. Redirect write to protected file — denied.
  r = await shellRun({
    cmd: 'bash',
    argv: ['-c', `echo hacked > ${JSON.stringify(protectedFile)}`],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  if (hasSandbox) check('redirect write denied', r.ok === false, `ok=${r.ok}`);
  check('protected file still unchanged', fs.readFileSync(protectedFile, 'utf8') === 'original content\n');

  // 3. Read of protected file — allowed.
  r = await shellRun({
    cmd: 'python3',
    argv: ['-c', `print(open(${JSON.stringify(protectedFile)}).read().strip())`],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  check('protected read allowed', r.ok === true && r.stdout.trim() === 'original content', JSON.stringify({ ok: r.ok, out: r.stdout, err: (r.stderr || '').slice(0, 120) }));

  // 4. Write to a NON-protected file in the same dir — allowed.
  const newFile = path.join(dir, 'created.txt');
  r = await shellRun({
    cmd: 'python3',
    argv: ['-c', `open(${JSON.stringify(newFile)}, 'w').write('new')`],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  check('other write allowed', r.ok === true && fs.readFileSync(newFile, 'utf8') === 'new', JSON.stringify({ ok: r.ok, err: (r.stderr || '').slice(0, 120) }));

  // 5. rm of protected file — denied (file-write* covers unlink).
  r = await shellRun({
    cmd: 'rm',
    argv: [protectedFile],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  if (hasSandbox) check('rm protected denied', r.ok === false && fs.existsSync(protectedFile), `ok=${r.ok} exists=${fs.existsSync(protectedFile)}`);

  // 6. No protectedPaths → runs unsandboxed (no marker).
  r = await shellRun({ cmd: 'echo', argv: ['hello'], timeoutMs: 15000 });
  check('no protectedPaths → no sandbox marker', r.ok === true && r.sandboxed === undefined, JSON.stringify({ ok: r.ok, sandboxed: r.sandboxed }));

  // 7. EPERM text detectable in failure output (drives the edit.agent reroute).
  r = await shellRun({
    cmd: 'python3',
    argv: ['-c', `open(${JSON.stringify(protectedFile)}, 'a').write('x')`],
    protectedPaths: prot,
    timeoutMs: 15000,
  });
  if (hasSandbox) {
    const hay = `${r.stderr || ''}${r.stdout || ''}${r.error || ''}`;
    check('EPERM visible in failure output', /operation not permitted|permission denied|deny file-write/i.test(hay), hay.slice(0, 150));
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
