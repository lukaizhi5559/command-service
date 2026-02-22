'use strict';

/**
 * skill: shell.run
 *
 * Terminal-capable skill. Runs allowlisted commands via spawn (never exec string).
 * Covers everything a developer terminal does: git, npm, node, python, open, osascript,
 * file ops, package managers, system queries, app control, etc.
 *
 * Args schema:
 * {
 *   cmd:        string   — command name (must be in ALLOWED_COMMANDS)
 *   argv:       string[] — argument array (no shell interpolation)
 *   cwd:        string   — working directory (must be under CWD_ROOTS, optional)
 *   env:        object   — additional env vars to merge (optional)
 *   timeoutMs:  number   — max execution time, default 30000, max 300000
 *   dryRun:     boolean  — validate + preview without executing (default false)
 *   stdin:      string   — optional stdin to pipe into the process
 * }
 *
 * Returns:
 * {
 *   ok:            boolean
 *   stdout:        string
 *   stderr:        string
 *   exitCode:      number
 *   executionTime: number  (ms)
 *   cmd:           string  (resolved full command string, for audit)
 *   dryRun:        boolean
 *   error?:        string
 * }
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Policy: allowed commands
// ---------------------------------------------------------------------------
// NOTE: Shell builtins (cd, export, alias, source, set, read, history, etc.)
// are NOT processes — they cannot be spawned. Handle them in the orchestrator:
//   - "change directory" → pass cwd arg to the next shell.run call
//   - "set env var"      → pass env arg to shell.run
//
// Interactive TUI tools (vim, nano, emacs, top, htop, screen, tmux, less, more)
// are excluded — they require a TTY and cannot be used non-interactively.
//
// Privilege escalation (sudo, su, passwd) is permanently excluded.
// ---------------------------------------------------------------------------

const ALLOWED_COMMANDS = new Set([
  // ── Shell interpreters (enables pipes, redirects, multi-command scripts) ────────────
  'bash', 'sh', 'zsh',

  // ── Version control ──────────────────────────────────────────────────────────────────────────────
  'git', 'svn', 'hg',

  // ── Node / package managers ────────────────────────────────────────────────
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun',

  // ── Python ─────────────────────────────────────────────────────────────────
  'python', 'python3', 'pip', 'pip3', 'pipenv', 'poetry', 'uv',

  // ── Ruby / Go / Rust ───────────────────────────────────────────────────────
  'ruby', 'gem', 'bundle', 'go', 'cargo', 'rustc',

  // ── File & directory operations ────────────────────────────────────────────
  'ls', 'pwd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv',
  'find', 'locate', 'which', 'whereis',
  'ln', 'readlink',
  'touch', 'stat', 'file',
  'basename', 'dirname',

  // ── File content ───────────────────────────────────────────────────────────
  'cat', 'head', 'tail',
  'grep', 'egrep', 'fgrep', 'rg',   // rg = ripgrep
  'sed', 'awk',
  'sort', 'uniq', 'wc', 'cut', 'tr', 'fold', 'fmt',
  'tee', 'echo', 'printf',
  'strings', 'hexdump', 'od',
  'jq', 'yq',                        // JSON/YAML processors

  // ── File permissions & ownership ───────────────────────────────────────────
  'chmod', 'chown', 'chgrp',
  'getfacl', 'setfacl',

  // ── Process management ─────────────────────────────────────────────────────
  'ps', 'pgrep', 'kill', 'killall', 'pkill',

  // ── System information ─────────────────────────────────────────────────────
  'uname', 'whoami', 'id', 'who', 'w',
  'uptime', 'date', 'cal',
  'df', 'du', 'free',
  'lscpu', 'lsblk', 'lsusb', 'lspci',
  'hostname', 'sw_vers',             // sw_vers = macOS version
  'system_profiler',

  // ── Network operations ─────────────────────────────────────────────────────
  'ping', 'wget', 'curl',
  'ssh', 'scp', 'rsync',
  'netstat', 'ss', 'ifconfig', 'ip',
  'arp', 'route',
  'dig', 'nslookup', 'host',
  'networksetup',                    // macOS network config
  'airport',                         // macOS Wi-Fi

  // ── Archive & compression ──────────────────────────────────────────────────
  'tar', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz',
  'zip', 'unzip', 'rar', 'unrar', '7z',

  // ── File comparison & patching ─────────────────────────────────────────────
  'diff', 'cmp', 'comm', 'patch',

  // ── Misc utilities ─────────────────────────────────────────────────────────
  'xargs', 'seq', 'sleep', 'timeout', 'watch', 'time',
  'true', 'false',
  'type', 'man',
  'base64', 'md5', 'md5sum', 'shasum', 'sha256sum',
  'ldd',

  // ── Environment & variables (non-builtin forms) ────────────────────────────
  'env', 'printenv',

  // ── Build / test / lint tools ──────────────────────────────────────────────
  'make', 'cmake', 'ninja',
  'jest', 'mocha', 'vitest', 'pytest',
  'eslint', 'prettier', 'tsc',
  'esbuild', 'vite', 'webpack', 'rollup',

  // ── Containers & infra ─────────────────────────────────────────────────────
  'docker', 'docker-compose',
  'kubectl', 'helm', 'k9s',
  'terraform', 'ansible',
  'vagrant',

  // ── Database CLIs ──────────────────────────────────────────────────────────
  'psql', 'mysql', 'sqlite3', 'mongosh', 'redis-cli',

  // ── Editors (non-interactive / CLI use only) ───────────────────────────────
  'code',      // VS Code CLI: code --diff, code --install-extension, etc.
  'cursor',    // Cursor CLI
  'subl',      // Sublime Text CLI

  // ── macOS-specific ─────────────────────────────────────────────────────────
  'open',          // open apps, files, URLs
  'osascript',     // AppleScript — app control, UI scripting
  'pbcopy', 'pbpaste',
  'say',
  'defaults',      // macOS user defaults
  'mdfind',        // Spotlight search
  'screencapture',
  'caffeinate',
  'pmset',
  'diskutil',
  'hdiutil',
  'launchctl',
  'xattr',
  'plutil',
  'security',      // keychain queries
  'brew',          // Homebrew

  // ── Media ──────────────────────────────────────────────────────────────────
  'ffmpeg', 'ffprobe',
  'convert', 'identify',  // ImageMagick
  'exiftool',
]);

// Commands that are always available — no opt-in required.
// All standard terminal operations are enabled by default.
const DANGEROUS_COMMANDS = new Set([
  // Only truly system-critical ops remain gated
  'diskutil', 'hdiutil', 'pmset',
]);

// Blocked argv patterns for non-shell commands
// (bash/sh/zsh -c scripts are exempt — pipes/redirects are valid there)
const BLOCKED_ARG_PATTERNS = [
  /\$\(/,        // command substitution in raw argv
  /`[^`]+`/,     // backtick substitution in raw argv
];

// Patterns that are dangerous inside bash -c scripts
const DANGEROUS_SCRIPT_PATTERNS = [
  /\bsudo\b/,
  /\bsu\b\s/,
  /\bpasswd\b/,
  /rm\s+-rf\s+\/(?!Users|tmp|var\/tmp)/,  // rm -rf on system paths
  /:\s*\(\s*\)\s*\{.*fork bomb/i,          // fork bomb
  />\/dev\/sd[a-z]/,                       // writing to raw disk devices
  /dd\s+.*of=\/dev\/(?!null|zero)/,        // dd to disk devices
];

// CWD roots — if set, cwd must be under one of these
// Defaults to home dir + /tmp. Override via env SHELL_RUN_CWD_ROOTS (colon-separated)
function getCwdRoots() {
  if (process.env.SHELL_RUN_CWD_ROOTS) {
    return process.env.SHELL_RUN_CWD_ROOTS.split(':').map(p => path.resolve(p));
  }
  return [
    os.homedir(),
    '/tmp',
    '/var/tmp',
  ];
}

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2MB

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(args) {
  const { cmd, argv = [], cwd, timeoutMs } = args;

  if (!cmd || typeof cmd !== 'string') {
    return { ok: false, error: 'cmd is required and must be a string' };
  }

  const baseName = path.basename(cmd);

  if (!ALLOWED_COMMANDS.has(baseName)) {
    return {
      ok: false,
      error: `Command not allowed: "${baseName}". Add it to ALLOWED_COMMANDS if needed.`
    };
  }

  if (DANGEROUS_COMMANDS.has(baseName) && process.env.SHELL_RUN_ALLOW_DANGEROUS !== 'true') {
    return {
      ok: false,
      error: `Command "${baseName}" requires explicit opt-in (system-critical operation).`
    };
  }

  if (!Array.isArray(argv)) {
    return { ok: false, error: 'argv must be an array of strings' };
  }

  const isShellInterpreter = ['bash', 'sh', 'zsh'].includes(baseName);

  for (const arg of argv) {
    if (typeof arg !== 'string') {
      return { ok: false, error: `All argv entries must be strings, got: ${typeof arg}` };
    }
    // For bash/sh/zsh, skip pipe/redirect checks — they're valid in -c scripts
    // Instead, audit the script content for truly dangerous patterns
    if (isShellInterpreter) {
      for (const pattern of DANGEROUS_SCRIPT_PATTERNS) {
        if (pattern.test(arg)) {
          return { ok: false, error: `Blocked dangerous pattern in shell script: "${arg.substring(0, 80)}"` };
        }
      }
    } else {
      for (const pattern of BLOCKED_ARG_PATTERNS) {
        if (pattern.test(arg)) {
          return { ok: false, error: `Blocked pattern in argv: "${arg}"` };
        }
      }
    }
  }

  if (cwd) {
    const resolved = path.resolve(cwd);
    const roots = getCwdRoots();
    const allowed = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) {
      return {
        ok: false,
        error: `cwd "${resolved}" is outside allowed roots: ${roots.join(', ')}`
      };
    }
  }

  if (timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
      return {
        ok: false,
        error: `timeoutMs must be a number between 1000 and ${MAX_TIMEOUT_MS}`
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function runProcess(cmd, argv, options) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const spawnOpts = {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    };

    let proc;
    try {
      proc = spawn(cmd, argv, spawnOpts);
    } catch (err) {
      return resolve({
        ok: false,
        stdout: '',
        stderr: '',
        exitCode: -1,
        executionTime: Date.now() - startTime,
        error: `Failed to spawn process: ${err.message}`
      });
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let truncated = false;

    proc.stdout.on('data', (chunk) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString();
      } else if (!truncated) {
        stdoutBuf += '\n[output truncated]';
        truncated = true;
      }
    });

    proc.stderr.on('data', (chunk) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.toString();
      }
    });

    if (options.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 2000);
      resolve({
        ok: false,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode: -1,
        executionTime: Date.now() - startTime,
        error: `Command timed out after ${options.timeoutMs}ms`
      });
    }, options.timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const executionTime = Date.now() - startTime;
      const exitCode = code ?? -1;
      resolve({
        ok: exitCode === 0,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode,
        executionTime,
        error: exitCode !== 0 ? `Process exited with code ${exitCode}` : undefined
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout: stdoutBuf,
        stderr: stderrBuf,
        exitCode: -1,
        executionTime: Date.now() - startTime,
        error: err.message
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

async function shellRun(args) {
  const {
    cmd,
    argv = [],
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    dryRun = false,
    stdin,
  } = args || {};

  const cmdString = [cmd, ...argv].join(' ');

  logger.info('shell.run invoked', { cmd, argv, cwd, timeoutMs, dryRun });

  // Validate
  const validation = validate(args);
  if (!validation.ok) {
    logger.warn('shell.run validation failed', { error: validation.error, cmd, argv });
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      executionTime: 0,
      cmd: cmdString,
      dryRun,
      error: validation.error
    };
  }

  // Dry-run: return preview without executing
  if (dryRun) {
    logger.info('shell.run dry-run', { cmd, argv, cwd });
    return {
      ok: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTime: 0,
      cmd: cmdString,
      dryRun: true,
      preview: `Would run: ${cmdString}${cwd ? ` (in ${cwd})` : ''}`
    };
  }

  // Execute
  const result = await runProcess(cmd, argv, {
    cwd,
    env,
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    stdin,
  });

  logger.info('shell.run completed', {
    cmd,
    exitCode: result.exitCode,
    executionTime: result.executionTime,
    ok: result.ok
  });

  return {
    ...result,
    cmd: cmdString,
    dryRun: false
  };
}

module.exports = { shellRun, validate, ALLOWED_COMMANDS, DANGEROUS_COMMANDS };
