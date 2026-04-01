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
// OAuth environment variable injection
// Loads OAuth access/refresh tokens from keychain and exposes them as env vars
// (e.g. GOOGLE_ACCESS_TOKEN, GITHUB_ACCESS_TOKEN) so shell scripts don't need
// to know internal keychain key names.
// ---------------------------------------------------------------------------
const OAUTH_PROVIDERS = [
  'google','github','microsoft','facebook','twitter',
  'linkedin','slack','notion','spotify','dropbox',
  'discord','zoom','atlassian','salesforce','hubspot',
];

// Token refresh endpoints per provider
const REFRESH_ENDPOINTS = {
  google:    'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  github:    null,       // GitHub PATs don't expire / use different flow
  facebook:  null,       // Facebook short-lived tokens use a different exchange
  twitter:   null,       // Twitter OAuth 2.0 tokens use a different exchange
  linkedin:  null,       // LinkedIn tokens use a different exchange
  slack:     null,       // Slack app/user tokens use a different exchange
  notion:    null,       // Notion integration tokens don't expire
  discord:   null,       // Discord bot tokens don't expire
  salesforce: null,      // Salesforce needs instance URL — handled separately
  spotify:   'https://accounts.spotify.com/api/token',
  dropbox:   'https://api.dropboxapi.com/oauth2/token',
  zoom:      'https://zoom.us/oauth/token',
  atlassian: 'https://auth.atlassian.com/oauth/token',
  hubspot:   'https://api.hubapi.com/oauth/v1/token',
};

/**
 * Returns true if the access token in `tok` is known to be expired.
 * Checks `issued_at + expires_in` if present, otherwise assumes stale if
 * the token has been in keytar for more than 50 minutes (conservative —
 * Google access tokens last 60 minutes).
 */
// Conservative max-age: even if issued_at claims the token is fresh, if it's
// older than MAX_TOKEN_AGE_S we treat it as expired. This guards against
// tokens whose issued_at was recorded at storage time (e.g. seeded via a
// script) rather than at Google issuance time.
const MAX_TOKEN_AGE_S = 45 * 60; // 45 minutes (Google tokens last 60 min)

function _isTokenExpired(tok) {
  if (!tok.access_token) return true;
  const now = Date.now() / 1000;
  if (tok.issued_at && tok.expires_in) {
    // Primary check: explicit deadline with 2-min buffer
    if (now > (tok.issued_at + tok.expires_in - 120)) return true;
    // Secondary check: guard against wrong issued_at (e.g., set at storage time)
    if (now > (tok.issued_at + MAX_TOKEN_AGE_S)) return true;
    return false;
  }
  // No timestamp — we don't know. Try refreshing if we have a refresh_token.
  return !!tok.refresh_token;
}

/**
 * Attempts to refresh the access token using the refresh_token.
 * Returns the updated token blob on success, or null on failure.
 */
async function _refreshToken(provider, tok) {
  const endpoint = REFRESH_ENDPOINTS[provider];
  if (!endpoint || !tok.refresh_token) return null;

  // Read client credentials: prefer token blob, fall back to keytar
  let clientId     = tok.client_id;
  let clientSecret = tok.client_secret;
  if (!clientId || !clientSecret) {
    try {
      const keytar = require('keytar');
      clientId     = clientId     || await keytar.getPassword('thinkdrop', `${provider.toUpperCase()}_CLIENT_ID`);
      clientSecret = clientSecret || await keytar.getPassword('thinkdrop', `${provider.toUpperCase()}_CLIENT_SECRET`);
    } catch (_) {}
  }
  if (!clientId || !clientSecret) return null;

  try {
    const https = require('https');
    const body  = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tok.refresh_token,
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString();

    const refreshed = await new Promise((resolve, reject) => {
      const url  = new URL(endpoint);
      const opts = {
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (!refreshed.access_token) {
      logger.warn(`[loadOAuthEnv] ${provider} token refresh failed:`, refreshed.error || refreshed);
      return null;
    }

    // Merge — preserve refresh_token + client creds if not returned in response
    const updated = {
      ...tok,
      access_token: refreshed.access_token,
      expires_in:   refreshed.expires_in   || tok.expires_in,
      scope:        refreshed.scope        || tok.scope,
      issued_at:    Math.floor(Date.now() / 1000),
    };
    if (refreshed.refresh_token) updated.refresh_token = refreshed.refresh_token;

    // Persist updated token back to keytar and token file
    try {
      const keytar = require('keytar');
      await keytar.setPassword('thinkdrop', `oauth:${provider}`, JSON.stringify(updated));
      logger.info(`[loadOAuthEnv] ${provider} access token refreshed and saved to keytar`);
    } catch (_) {}

    // Also update the per-skill token file if it exists and matches this provider
    try {
      const fs   = require('fs');
      const path = require('path');
      const tokenDir = path.join(os.homedir(), '.thinkdrop', 'tokens');
      if (fs.existsSync(tokenDir)) {
        fs.readdirSync(tokenDir)
          .filter(f => f.endsWith('.json'))
          .forEach(f => {
            try {
              const fp  = path.join(tokenDir, f);
              const fd  = JSON.parse(fs.readFileSync(fp, 'utf8'));
              // Only overwrite if the file's refresh_token matches (same credential)
              if (fd.refresh_token && fd.refresh_token === tok.refresh_token) {
                fs.writeFileSync(fp, JSON.stringify({ ...fd, access_token: updated.access_token, issued_at: updated.issued_at }, null, 2), 'utf8');
                logger.info(`[loadOAuthEnv] updated token file: ${f}`);
              }
            } catch (_) {}
          });
      }
    } catch (_) {}

    return updated;
  } catch (e) {
    logger.warn(`[loadOAuthEnv] ${provider} refresh request failed:`, e.message);
    return null;
  }
}

async function loadOAuthEnv() {
  let keytar;
  try { keytar = require('keytar'); } catch (_) { return {}; }
  const vars = {};
  await Promise.all(OAUTH_PROVIDERS.map(async (provider) => {
    try {
      const raw = await keytar.getPassword('thinkdrop', `oauth:${provider}`);
      if (!raw) return;
      let tok = JSON.parse(raw);

      // Auto-refresh stale/expired access tokens before injecting into env
      if (_isTokenExpired(tok)) {
        logger.info(`[loadOAuthEnv] ${provider} access token may be expired — attempting refresh`);
        const refreshed = await _refreshToken(provider, tok);
        if (refreshed) tok = refreshed;
        else logger.warn(`[loadOAuthEnv] ${provider} refresh failed — using existing token`);
      }

      const px = provider.toUpperCase();
      if (tok.access_token)  vars[`${px}_ACCESS_TOKEN`]  = tok.access_token;
      if (tok.refresh_token) vars[`${px}_REFRESH_TOKEN`] = tok.refresh_token;
      if (tok.client_id)     vars[`${px}_CLIENT_ID`]     = tok.client_id;
      if (tok.client_secret) vars[`${px}_CLIENT_SECRET`] = tok.client_secret;
    } catch (_) {}
  }));
  return vars;
}

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

  // ── Cloud CLIs ────────────────────────────────────────────────────────────
  'aws', 'awslocal',             // AWS CLI
  'gcloud', 'gsutil', 'bq',     // Google Cloud
  'az',                          // Azure CLI
  'gh',                          // GitHub CLI
  'heroku',                      // Heroku CLI
  's3cmd', 'rclone',             // S3-compatible tools
  'doctl',                       // DigitalOcean CLI
  'fly',                         // Fly.io CLI
  'vercel', 'netlify',           // Deployment CLIs
  'wrangler',                    // Cloudflare CLI

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

  // ── Browser automation ────────────────────────────────────────────────────
  'playwright-cli',  // brew install playwright-cli — headed browser sessions

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
// Pattern that detects direct reads from ~/.thinkdrop/tokens/ — blocked to enforce
// $<PROVIDER>_ACCESS_TOKEN usage. The env vars are pre-injected and auto-refreshed;
// reading the token files directly risks using stale access tokens.
const OAUTH_TOKEN_FILE_PATTERN = /\.thinkdrop\/tokens\//;
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

  // Shell interpreters and osascript pass scripts inline — skip pipe/backtick checks,
  // audit for truly dangerous patterns instead
  const isShellInterpreter = ['bash', 'sh', 'zsh'].includes(baseName);
  const isScriptInterpreter = isShellInterpreter || baseName === 'osascript';

  for (const arg of argv) {
    if (typeof arg !== 'string') {
      return { ok: false, error: `All argv entries must be strings, got: ${typeof arg}` };
    }
    // For bash/sh/zsh/osascript, skip pipe/redirect/backtick checks — they're valid in scripts.
    // osascript uses -e flags with inline AppleScript that legitimately contains backticks,
    // quotes, and message content (e.g. sending a summary via iMessage).
    // Instead, audit the script content for truly dangerous patterns.
    if (isScriptInterpreter) {
      for (const pattern of DANGEROUS_SCRIPT_PATTERNS) {
        if (pattern.test(arg)) {
          return { ok: false, error: `Blocked dangerous pattern in shell script: "${arg.substring(0, 80)}"` };
        }
      }
      // Block direct reads from ~/.thinkdrop/tokens/ inside shell scripts.
      // Use $GOOGLE_ACCESS_TOKEN (or $<PROVIDER>_ACCESS_TOKEN) instead — these are
      // pre-injected and auto-refreshed by the runtime before every shell.run call.
      if (isShellInterpreter && OAUTH_TOKEN_FILE_PATTERN.test(arg)) {
        return {
          ok: false,
          error:
            'BLOCKED: Do not read OAuth tokens from ~/.thinkdrop/tokens/ files directly. ' +
            'Use the pre-injected env var $GOOGLE_ACCESS_TOKEN (or $<PROVIDER>_ACCESS_TOKEN ' +
            'for other providers). These env vars are automatically refreshed and available ' +
            'in every shell.run call.'
        };
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
  const oauthEnv = await loadOAuthEnv();
  const result = await runProcess(cmd, argv, {
    cwd,
    // OAuth vars are the lowest priority — explicit env arg and process.env override them
    env: { ...oauthEnv, ...env },
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    stdin,
  });

  logger.info('shell.run completed', {
    cmd,
    exitCode: result.exitCode,
    executionTime: result.executionTime,
    ok: result.ok
  });

  // ── 401/403 auto-retry ──────────────────────────────────────────────────
  // If the command output contains signs of an auth failure AND OAuth tokens
  // were injected, force-refresh all providers and retry the command once.
  // This handles the case where issued_at was recorded incorrectly (e.g., at
  // storage time rather than at Google token-issuance time).
  const combinedOutput = (result.stdout || '') + (result.stderr || '');
  const hasOAuthVars   = Object.keys(oauthEnv).some(k => k.endsWith('_ACCESS_TOKEN'));
  const looksLike401   = hasOAuthVars && (
    /"code"\s*:\s*40[13]/.test(combinedOutput)     ||
    /HTTP\/[\d.]+ 40[13]/.test(combinedOutput)      ||
    /401 Unauthorized/i.test(combinedOutput)         ||
    /403 Forbidden/i.test(combinedOutput)            ||
    /UNAUTHENTICATED/i.test(combinedOutput)          ||
    /Invalid Credentials/i.test(combinedOutput)      ||
    /invalid_token/i.test(combinedOutput)
  );

  if (looksLike401) {
    logger.warn('[shell.run] 401/403 detected in output — forcing token refresh and retrying once');
    // Invalidate all cached tokens by clearing issued_at so loadOAuthEnv
    // re-evaluates expiry and refreshes each provider.
    try {
      const keytar = require('keytar');
      for (const provider of OAUTH_PROVIDERS) {
        const raw = await keytar.getPassword('thinkdrop', `oauth:${provider}`).catch(() => null);
        if (!raw) continue;
        const tok = JSON.parse(raw);
        if (tok.refresh_token && REFRESH_ENDPOINTS[provider]) {
          // Strip issued_at so _isTokenExpired falls through to: return !!tok.refresh_token
          const invalidated = { ...tok, issued_at: undefined };
          await keytar.setPassword('thinkdrop', `oauth:${provider}`, JSON.stringify(invalidated)).catch(() => {});
        }
      }
    } catch (_) {}

    const freshEnv   = await loadOAuthEnv();
    const retryResult = await runProcess(cmd, argv, {
      cwd,
      env: { ...freshEnv, ...env },
      timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      stdin,
    });
    logger.info('shell.run retry completed', {
      cmd, exitCode: retryResult.exitCode, executionTime: retryResult.executionTime, ok: retryResult.ok,
    });
    return { ...retryResult, cmd: cmdString, dryRun: false, retried: true };
  }
  // ────────────────────────────────────────────────────────────────────────

  return {
    ...result,
    cmd: cmdString,
    dryRun: false
  };
}

module.exports = { shellRun, validate, ALLOWED_COMMANDS, DANGEROUS_COMMANDS };
