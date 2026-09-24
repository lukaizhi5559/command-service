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
 *   goal:       string   — plain-language goal (alternative to cmd+argv); resolved via internal LLM
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

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger.cjs');
const skillLlm = require('../skill-helpers/skill-llm.cjs');
const { parseLlmJson } = require('../skill-helpers/parseLlmJson.cjs');
// Canonical patterns live in shared/text-patterns.cjs — update there, not here.
const { isFileWriteGoal } = require('../../../../shared/text-patterns.cjs');

// Robust JSON parser for LLM output — handles truncated strings, dangling
// commas, missing values, markdown fences, and unbalanced braces.
// Delegates to the shared parseLlmJson utility (same one used by
// stategraph-module and all other command-service skills).
function _parseGoalJson(raw) {
  return parseLlmJson(raw, logger, 'shell.run');
}

// ---------------------------------------------------------------------------
// Layer 1: Force-classification for known system queries.
// Asks the LLM to pick a category number (1-N) or 0 (unknown). When a known
// category is matched, the pre-validated dump command from SYSTEM_QUERY_REGISTRY
// is used directly — zero LLM generation, zero field-name hallucination.
// Mirrors the "return ONLY a single number" pattern from instruction.runner.cjs.
// ---------------------------------------------------------------------------
async function _classifySystemQuery(goal, onProgress) {
  if (!skillLlm.isAvailable()) return 0;
  const numberedList = SYSTEM_QUERY_REGISTRY.map((r, i) => `${i + 1}. ${r.label}`).join('\n');
  const systemPrompt = `You classify a shell automation goal into a known system query category.
Return ONLY a single number — nothing else.
  1-${SYSTEM_QUERY_REGISTRY.length} = the matching category
  0 = none of the above (custom task, not a system info query)

Rules:
- If the goal asks for system/hardware info (disk, memory, CPU, battery, network, OS, processes, display, USB, audio) → return the matching number
- If the goal is about file operations, app automation, text processing, or anything else → return 0
- When in doubt → return 0 (let the free-generation path handle it)`;

  try {
    const raw = await skillLlm.askWithMessages([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Goal: ${goal}\n\nCategories:\n${numberedList}\n\nWhich category number? (0 = none)` },
    ], { maxTokens: 5, temperature: 0, taskType: 'classification' });
    const num = parseInt((raw || '').trim().replace(/\D/g, ''), 10);
    if (num >= 1 && num <= SYSTEM_QUERY_REGISTRY.length) {
      if (onProgress) onProgress({ type: 'shell:system_query_classified', category: num, label: SYSTEM_QUERY_REGISTRY[num - 1].label });
      logger.info(`[shell.run] System query classified: #${num} (${SYSTEM_QUERY_REGISTRY[num - 1].label})`);
      return num;
    }
    logger.info(`[shell.run] System query classification: 0 (no match) — raw="${(raw || '').trim()}"`);
    return 0;
  } catch (e) {
    logger.warn(`[shell.run] _classifySystemQuery failed: ${e.message} — defaulting to 0 (free-generation)`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Internal LLM prompt — translates a plain-language goal into a concrete bash
// command. Fires ONLY when a plan step passes args.goal (natural language) instead
// of args.argv (pre-built command). The pre-built argv path is 100% unchanged.
// ---------------------------------------------------------------------------
const SHELL_RUN_SYSTEM = `You are a macOS shell expert. Your job is to convert a plain-language automation goal into a single, safe bash -c command.

Rules:
- Return ONLY valid JSON: { "cmd": "bash", "argv": ["-c", "<script>"] }
- No explanation, no markdown, no code fences — only JSON.
- Always use bash -c as the outer command.
- Prefer single-line pipelines. For multi-step logic, use a heredoc or temp script.

BARE FOLDER/FILE NAME RULE (most important rule — read first):
When the goal mentions a folder or file by name only with no absolute path (e.g. "gongzuo folder", "my projects folder", "resume.pdf"):
- NEVER hard-code ~/folderName or /Users/<user>/folderName — this path almost certainly does not exist.
- ALWAYS locate first using mdfind, then act on the result:
  SRC=$(mdfind -name "FOLDERNAME" -onlyin "$HOME" | grep -v node_modules | head -1)
  [ -d "$SRC" ] && <your command using "$SRC"> || echo "Folder not found: FOLDERNAME"
- Example — "list files in the gongzuo folder":
  SRC=$(mdfind -name "gongzuo" -onlyin "$HOME" | grep -v node_modules | head -1); [ -d "$SRC" ] && find "$SRC" -type f || echo "Folder not found: gongzuo"
- Example — "count files in the gongzuo folder":
  SRC=$(mdfind -name "gongzuo" -onlyin "$HOME" | grep -v node_modules | head -1); [ -d "$SRC" ] && find "$SRC" -type f | wc -l || echo "0"
- For other unknown paths: SRC=$(mdfind -name "FILENAME" | grep -v node_modules | head -1)

find grouping rule (CRITICAL — unbalanced groupings cause find to exit 1):
- When using find with \\( ... -o ... \\) groupings, the \\( and \\) must ALWAYS be balanced.
- Every \\( must have a matching \\) before any pipe (|) or end of command.
- Missing \\) causes find to exit with code 1 and produce no output.
- Example — "list all image files in /path/to/folder":
  { "cmd": "bash", "argv": ["-c", "find '/path/to/folder' -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.bmp' -o -iname '*.tiff' -o -iname '*.heic' \\) | sort"] }
- WRONG (missing closing \\) — will exit 1):
  find '/path/to/folder' -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.gif'

File move/copy safety rules (CRITICAL — bash loop bugs are the #1 failure):
- NEVER use wildcards that include the destination: mv ~/Desktop/* ~/Desktop/dest/ WRONG (moves dest into itself)
- ALWAYS use find with -type f: find SRC -maxdepth 1 -type f -exec mv -n {} DEST/ \\;
- In while/for loops: use the loop variable ($file), NOT the source dir variable ($SRC) as the mv source argument
- Unknown path: SRC=$(mdfind -name "FOLDERNAME" -onlyin "$HOME" | head -1); [ -d "$SRC" ] && find "$SRC" -maxdepth 1 -type f -exec mv -n {} ~/Desktop/ \\;
- For any loop-based file move: prefer python3 shutil.move() — eliminates the loop-variable class of bugs entirely
  Example: python3 -c "import shutil,pathlib; [shutil.move(str(f), 'DEST') for f in pathlib.Path('SRC').iterdir() if f.is_file()]"

Available runtimes and what they handle:

bash       — file ops (mv, cp, find, mkdir, rm), text processing (grep, awk, sed, cut),
             process control, system queries, piping. Best for: single-line transforms,
             file/folder ops, OS-level tasks.

python3    — the general-purpose workhorse. Handles ANY file format, data transform,
             document generation, network call, or complex multi-step logic. stdlib covers
             most needs (pathlib, shutil, json, csv, subprocess, os, re). For tasks that
             need a third-party package, install it inline:
               python3 -m pip install PKG --quiet --user
             then import and use it in the same -c script or /tmp script. The ecosystem is
             vast — use your knowledge to pick the right package for the task; don't limit
             yourself to a fixed list. Never approximate with the wrong tool (e.g. touch to
             "create" a file that needs real content — always generate actual bytes).

node       — JavaScript execution. Use when the task is JS-native (JSON transforms, quick
             HTTP fetch, node scripts). Install packages inline with npm install if needed.

brew       — macOS package manager for CLI binaries (ffmpeg, imagemagick, pandoc, jq,
             ripgrep, fd, poppler, etc.). Prefer brew when a native binary is cleaner than
             a python3 script. Check if installed first: command -v TOOL || brew install TOOL.

osascript  — macOS Finder and desktop UI automation. Use ONLY for complex GUI actions that
             no other skill can do (open Finder windows, click menus, move windows). Do NOT use
             for bringing apps to the front or activating them — that is handled by app.agent.

open       — Launch files and URLs by association. Do NOT use for app focus/activation; route
             those goals to app.agent instead.

lp / lpr   — CUPS printing. Sends a file to the default printer.
             For "print this file" / "print the document" / "print <path>" → use lp, NOT cat.
             cat displays content on screen; lp sends to a physical printer.
             Example: lp "/path/to/file.pdf"

GUI focus / app activation rule:
When the goal is to bring an application to the front, focus it, or activate it, do NOT generate
a shell command. Instead, return an error indicating that this should be handled by app.agent.

Discovery rule: if the right package or CLI tool is not immediately obvious, reason from
first principles — what file format or protocol is involved, which runtime handles it best,
what is the canonical library in that ecosystem — then install and use it inline.

macOS system query field names (CRITICAL — do NOT guess field names):
- diskutil info / outputs: "Disk Size:", "Container Total Space:", "Container Free Space:", "Volume Used Space:"
- There is NO field called "Total Size" or "Available Space" — never grep for those.
- For disk space, prefer: df -h /  (POSIX standard, always works, no field-name dependency)
- For memory, prefer: sysctl -n hw.memsize  (returns bytes — convert with awk)
- For battery, prefer: pmset -g batt  (raw output, no extraction needed)
- When unsure about field names, run the source command WITHOUT a pipe first to see the actual output format.

Idempotency rule (CRITICAL — prevents false retry loops):
For rename, move, create, mkdir, or install operations: ALWAYS check if the goal is already
achieved BEFORE failing. If the result already exists, exit 0 and print a confirmation.
- Rename/move: check if destination already exists → if yes, echo "already done: DEST exists" && exit 0
- Create file/folder: check if already exists → if yes, echo "already done: PATH exists" && exit 0
- Install: check if already installed → if yes, echo "already done: TOOL already installed" && exit 0
Example for rename (correct idempotent pattern):
  SRC="$HOME/Desktop/some-folder"; DEST="$HOME/Desktop/test-folder"
  if [ -d "$DEST" ]; then echo "already done: $DEST already exists"; exit 0; fi
  if [ ! -d "$SRC" ]; then echo "Error: source $SRC not found" >&2; exit 1; fi
  mv -v "$SRC" "$DEST"
Never exit 1 when the goal state is already observably complete.

Exception — clipboard/pipe writes: when the goal writes clipboard or piped output to a file
(pbpaste, stdin redirect, echo/printf redirection), ALWAYS overwrite the file directly.
Do NOT check if the file exists first — content changes every run.
Use: pbpaste > "$FILE"  (no existence guard, no idempotency check)

File-content rule (CRITICAL): when the goal asks to write content/code to a file,
the file must contain the COMPLETE content — never abbreviate, elide, or end with
placeholder comments like "// rest of code". Use a quoted heredoc:
  cat > "$FILE" <<'EOF'
  ...full content...
  EOF

Platform: macOS. Home dir: ${os.homedir()}
`;

// ---------------------------------------------------------------------------
// System Query Registry — pre-validated dump commands for known system info queries.
// Each entry is a RAW DUMP command (no grep/awk extraction) so there is zero
// field-name hallucination risk. The synthesize step interprets the raw output.
// Used by Layer 1 (force-classification) when the goal matches a known category.
// ---------------------------------------------------------------------------
const SYSTEM_QUERY_REGISTRY = [
  {
    label: 'Disk storage / disk space',
    cmd: 'bash',
    argv: ['-c', 'df -h / && echo "---" && diskutil info /'],
  },
  {
    label: 'Memory / RAM',
    cmd: 'bash',
    argv: ['-c', 'sysctl hw.memsize && echo "---" && vm_stat'],
  },
  {
    label: 'CPU / processor info',
    cmd: 'bash',
    argv: ['-c', 'sysctl machdep.cpu.brand_string hw.ncpu hw.physicalcpu hw.logicalcpu'],
  },
  {
    label: 'Battery / power',
    cmd: 'bash',
    argv: ['-c', 'pmset -g batt && echo "---" && pmset -g | head -15'],
  },
  {
    label: 'Network / IP addresses',
    cmd: 'bash',
    argv: ['-c', 'ifconfig && echo "---" && networksetup -listallhardwareports'],
  },
  {
    label: 'OS version / system info',
    cmd: 'bash',
    argv: ['-c', 'sw_vers && echo "---" && uname -a && echo "---" && system_profiler SPHardwareDataType | head -20'],
  },
  {
    label: 'Running processes',
    cmd: 'bash',
    argv: ['-c', 'ps aux | head -30'],
  },
  {
    label: 'Screen / display info',
    cmd: 'bash',
    argv: ['-c', 'system_profiler SPDisplaysDataType | head -50'],
  },
  {
    label: 'USB / connected devices',
    cmd: 'bash',
    argv: ['-c', 'system_profiler SPUSBDataType | head -50'],
  },
  {
    label: 'Audio / sound devices',
    cmd: 'bash',
    argv: ['-c', 'system_profiler SPAudioDataType | head -40'],
  },
];

// ---------------------------------------------------------------------------
// File-Operation Registry — pre-validated commands for known file ops.
// Each entry has a regex to match the goal, a path extractor, and a cmd builder.
// Used by Layer 1.5 (force-classification for file operations) when the goal
// matches a known file-op pattern. Zero LLM generation, zero hallucination.
// Same pattern as SYSTEM_QUERY_REGISTRY but for parameterized file operations.
// ---------------------------------------------------------------------------
const FILE_OP_REGISTRY = [
  {
    label: 'Print file',
    regex: /\bprint\s+(?:this|that|the|current)?\s*(?:file|document|doc)\b/i,
    extractPath: (goal) => {
      // Extract /path from the goal string (absolute path with extension)
      const m = goal.match(/\/[^\s"']+\.\w{1,10}/);
      return m ? m[0] : null;
    },
    buildCmd: (filePath) => ({ cmd: 'lp', argv: [filePath] }),
  },
];

/**
 * Resolve a plain-language goal to a concrete { cmd, argv } using the internal LLM.
 * Only called when args.goal is provided instead of args.argv.
 *
 * @param {string} goal
 * @param {function} [onProgress] — optional callback for progress events:
 *   { type: 'shell:goal_resolving', attempt, maxAttempts, goal }
 *   { type: 'shell:goal_resolved', cmd, argv }
 *   { type: 'shell:goal_failed', error }
 */

// Validate a generated shell script's syntax with `<interpreter> -n`.
// Returns null if the script parses cleanly, or the stderr error string if not.
// `<interpreter> -n` only checks syntax (not semantics) and runs no commands, so
// it is safe and fast. This catches the class of failures where the LLM emits
// shell-sensitive characters (e.g. unescaped `(` `)` in `find` expressions) that
// the shell rejects before the command ever runs.
//
// `interpreter` defaults to 'bash'. When the LLM returns cmd: "sh" or "zsh",
// we use that interpreter's own -n parser so zsh-specific syntax is validated
// against zsh, not bash. If the requested interpreter binary is unavailable,
// we fall back to `bash -n` (valid sh is always valid bash; zsh is a near
// superset of bash for syntax-checking purposes).
//
// ZSH DUAL-CHECK: zsh's parser accepts unescaped `(` `)` as valid syntax (it
// treats them as glob qualifiers / array syntax), so `zsh -n` does NOT catch
// the unescaped-parens class of errors that `bash -n` catches. Since the system
// prompt instructs the LLM to "Always use bash -c", a zsh-labeled command that
// fails `bash -n` almost certainly contains bash-style syntax that zsh parses
// differently — and would fail confusingly at runtime (e.g. "unknown file
// attribute"). So for zsh, we run `zsh -n` first (catches zsh-specific syntax
// errors), then `bash -n` as a secondary check (catches the unescaped-parens
// class). If `bash -n` fails, we return its error so the LLM can fix the syntax.
function _bashSyntaxCheck(scriptBody, interpreter = 'bash') {
  if (typeof scriptBody !== 'string' || !scriptBody.trim()) return null;
  try {
    const r = spawnSync(interpreter, ['-n', '-c', scriptBody], { encoding: 'utf8' });
    if (r.status === 0) {
      // zsh -n passed; run bash -n as a secondary check for the unescaped-parens
      // class that zsh's parser accepts but that indicates a bash-style command
      // mislabeled as zsh (the system prompt says "Always use bash -c").
      if (interpreter === 'zsh') {
        try {
          const r2 = spawnSync('bash', ['-n', '-c', scriptBody], { encoding: 'utf8' });
          if (r2.status !== 0) {
            return (r2.stderr || '').trim() || `bash -n (zsh secondary) exited with status ${r2.status}`;
          }
        } catch (_) { /* bash unavailable — zsh -n passed, accept */ }
      }
      return null;
    }
    return (r.stderr || '').trim() || `${interpreter} -n exited with status ${r.status}`;
  } catch (err) {
    // If the requested interpreter isn't available, fall back to bash -n.
    // (bash is a superset of sh; valid sh is always valid bash. zsh is a
    // near-superset of bash, so bash -n catches most zsh syntax errors too.)
    if (interpreter !== 'bash') {
      try {
        const r2 = spawnSync('bash', ['-n', '-c', scriptBody], { encoding: 'utf8' });
        if (r2.status === 0) return null;
        return (r2.stderr || '').trim() || `bash -n (fallback) exited with status ${r2.status}`;
      } catch (_) { /* fall through to warn below */ }
    }
    // If bash -n itself can't run, don't block execution — let the real run surface the error.
    logger.warn(`[shell.run] ${interpreter} -n check unavailable: ${err.message}`);
    return null;
  }
}

// Truncation guard: `bash -n` does NOT reject an unterminated heredoc (it only
// warns on stdin), so a maxTokens-truncated generated script would silently
// write a partial file. Detect heredoc openers with no matching closer line.
// Openers are only recognised at end-of-line (`cat > f << 'EOF'` style) so
// bit-shift operators like `a << b` inside heredoc bodies don't false-positive.
function _looksTruncated(script) {
  if (typeof script !== 'string') return null;
  const openerRe = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/gm;
  let m;
  while ((m = openerRe.exec(script)) !== null) {
    const tag = m[1];
    const closerRe = new RegExp(`^${tag}\\s*$`, 'm');
    // closer must appear on a line AFTER the opener
    if (!closerRe.test(script.slice(m.index + m[0].length))) {
      return `unterminated heredoc (missing ${tag} delimiter)`;
    }
  }
  return null;
}

async function _resolveGoalToCommand(goal, onProgress) {
  if (!skillLlm.isAvailable()) {
    return { ok: false, error: 'LLM not available to resolve shell goal — provide cmd/argv directly' };
  }
  const MAX_ATTEMPTS = 3;
  let lastErr = '';
  let syntaxFeedback = ''; // carried into the next LLM attempt when bash -n rejects a script
  // File-writing goals must inline the full content (usually a heredoc), which
  // easily exceeds a 300-token cap — truncation then writes a partial file.
  // Scale the budget up; retries go higher still to recover a truncated script.
  // isFileWriteGoal: explicit path-in-goal (primary) or write-verb+file-noun.
  const _isWriteGoal = isFileWriteGoal(goal);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (onProgress) onProgress({ type: 'shell:goal_resolving', attempt, maxAttempts: MAX_ATTEMPTS, goal });
    try {
      const userContent = syntaxFeedback
        ? `Goal: ${goal}\n\nYour previous attempt failed a bash syntax check:\n${syntaxFeedback}\nFix the shell syntax (e.g. escape parentheses passed to find as \\( \\), quote arguments, balance constructs) and return a valid command.`
        : `Goal: ${goal}`;
      const response = await skillLlm.askWithMessages([
        { role: 'system', content: SHELL_RUN_SYSTEM },
        { role: 'user', content: userContent },
      ], { maxTokens: _isWriteGoal ? (attempt === 1 ? 4096 : 8192) : 300, temperature: 0 });
      const raw = (response || '').trim();
      if (!raw) {
        lastErr = 'LLM returned empty response';
        syntaxFeedback = '';
        continue;
      }
      const parsed = _parseGoalJson(raw);
      if (!parsed) {
        lastErr = `LLM returned unparseable JSON: ${raw.slice(0, 120)}`;
        syntaxFeedback = '';
        continue;
      }
      if (!parsed.cmd || !Array.isArray(parsed.argv)) {
        lastErr = `LLM returned invalid command shape: ${raw.slice(0, 120)}`;
        syntaxFeedback = '';
        continue;
      }
      // Structural guard: find groupings must be balanced.
      // find's \( and \) are arguments to find, not shell syntax, so `bash -n`
      // cannot catch unbalanced groupings. An unclosed \( causes find to exit 1.
      const script = (parsed.argv || []).join(' ');
      if (/\bfind\b/.test(script)) {
        const openCount = (script.match(/\\\(/g) || []).length;
        const closeCount = (script.match(/\\\)/g) || []).length;
        if (openCount !== closeCount) {
          lastErr = `LLM generated find command with unbalanced grouping (${openCount} '\\(' vs ${closeCount} '\\)') — retrying`;
          syntaxFeedback = lastErr;
          logger.warn(`[shell.run] ${lastErr}: ${script.slice(0, 120)}`);
          continue;
        }
      }
      // Truncation guard: a maxTokens-cut script fails open inside bash -n
      // (unterminated heredoc is a warning, not an error) and would write a
      // partial file — refuse and let the retry regenerate at a larger budget.
      const truncReason = _looksTruncated(script);
      if (truncReason) {
        lastErr = `LLM-generated command looks truncated (${truncReason}) — refusing to execute a partial script`;
        syntaxFeedback = lastErr;
        logger.warn(`[shell.run] ${lastErr}: ${script.slice(-120)}`);
        continue;
      }
      // Syntax check: <interpreter> -n catches shell-level errors the structural
      // guard misses — most importantly unescaped `(` `)` that the shell parses as
      // syntax rather than passing to find. Without this, a temperature-0 retry
      // regenerates the identical broken command (observed in task_94e38046).
      // Covers bash, sh, and zsh — uses the actual interpreter's -n parser so
      // zsh-specific syntax is validated against zsh, not bash.
      const _SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh']);
      const _baseName = path.basename(parsed.cmd || '');
      if (_SHELL_INTERPRETERS.has(_baseName) && Array.isArray(parsed.argv) && parsed.argv[0] === '-c' && typeof parsed.argv[1] === 'string') {
        const syntaxErr = _bashSyntaxCheck(parsed.argv[1], _baseName);
        if (syntaxErr) {
          lastErr = `${_baseName} -n syntax check failed: ${syntaxErr}`;
          syntaxFeedback = syntaxErr;
          logger.warn(`[shell.run] ${lastErr} (script: ${parsed.argv[1].slice(0, 120)})`);
          continue;
        }
      }
      syntaxFeedback = '';
      if (onProgress) onProgress({ type: 'shell:goal_resolved', cmd: parsed.cmd, argv: parsed.argv });
      return { ok: true, cmd: parsed.cmd, argv: parsed.argv };
    } catch (err) {
      lastErr = `Goal resolution failed: ${err.message}`;
      syntaxFeedback = '';
    }
  }
  if (onProgress) onProgress({ type: 'shell:goal_failed', error: lastErr });
  return { ok: false, error: lastErr };
}

// ---------------------------------------------------------------------------
// Layer 2: Discovery retry for failed pipelines.
// When a goal-resolved command like `diskutil info / | grep 'Total Size'` fails
// with exit≠0 and empty stdout, the LLM likely hallucinated field names. This
// function:
//   1. Splits the script on the first `|` to get the source command
//   2. Runs the source raw (no pipe) to see actual output
//   3. Passes the actual output + goal to the LLM → regenerates extraction
//   4. Runs the new command
// Returns the retry result, or null if discovery retry didn't apply / failed.
// ---------------------------------------------------------------------------
async function _discoveryRetry(scriptBody, goal, cwd, env, oauthEnv, timeoutMs, stdin, _progressCallback, protectedPaths) {
  if (!scriptBody || !scriptBody.includes('|')) return null;
  if (!goal) return null; // only applies to goal-resolved commands, not pre-built argv
  if (!skillLlm.isAvailable()) return null;

  // 1. Extract source command (everything before the first pipe)
  const pipeIdx = scriptBody.indexOf('|');
  const sourceCmd = scriptBody.slice(0, pipeIdx).trim();
  if (!sourceCmd) return null;

  logger.info(`[shell.run] Discovery retry: running source raw: ${sourceCmd.slice(0, 120)}`);
  if (_progressCallback) _progressCallback({ type: 'shell:discovery_retry', sourceCmd });

  // 2. Run source raw
  const sourceResult = await runProcess('bash', ['-c', sourceCmd], {
    cwd,
    env: { ...oauthEnv, ...env },
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    stdin,
    protectedPaths,
  }, null);

  if (!sourceResult.stdout || !sourceResult.stdout.trim()) {
    logger.warn('[shell.run] Discovery retry: source command produced no output — aborting');
    return null;
  }

  // 3. Pass actual output + goal to LLM → regenerate extraction
  const discoveryPrompt = `You are a macOS shell expert. A previous command failed because it guessed wrong field names or patterns.
Here is the ACTUAL output of the source command. Generate a new extraction command based on what is ACTUALLY in the output.

Rules:
- Return ONLY valid JSON: { "cmd": "bash", "argv": ["-c", "<script>"] }
- No explanation, no markdown, no code fences — only JSON.
- Use the ACTUAL field names/labels/columns from the output below — do NOT guess.
- Keep it simple — prefer grep/awk with patterns that match the actual output.
- If the source output already contains the answer (no extraction needed), just echo it.

Source command: ${sourceCmd}
Actual output (first 2000 chars):
${sourceResult.stdout.slice(0, 2000)}`;

  try {
    const response = await skillLlm.askWithMessages([
      { role: 'system', content: discoveryPrompt },
      { role: 'user', content: `Goal: ${goal}` },
    ], { maxTokens: 300, temperature: 0 });

    const parsed = _parseGoalJson(response);
    if (!parsed || !parsed.cmd || !Array.isArray(parsed.argv)) {
      logger.warn(`[shell.run] Discovery retry: LLM returned unparseable JSON — aborting`);
      return null;
    }

    // Syntax check the regenerated command before executing — same rationale as
    // _resolveGoalToCommand: a shell syntax error here would surface as a
    // confusing retry failure instead of falling back to the original error.
    // Covers bash, sh, and zsh.
    const _SHELL_INTERPRETERS_DR = new Set(['bash', 'sh', 'zsh']);
    const _baseNameDR = path.basename(parsed.cmd || '');
    if (_SHELL_INTERPRETERS_DR.has(_baseNameDR) && Array.isArray(parsed.argv) && parsed.argv[0] === '-c' && typeof parsed.argv[1] === 'string') {
      const syntaxErr = _bashSyntaxCheck(parsed.argv[1], _baseNameDR);
      if (syntaxErr) {
        logger.warn(`[shell.run] Discovery retry: ${_baseNameDR} -n rejected regenerated command: ${syntaxErr} — aborting`);
        return null;
      }
    }

    logger.info(`[shell.run] Discovery retry: regenerated command: ${(parsed.argv || []).join(' ').slice(0, 120)}`);

    // 4. Run the new command
    const retryResult = await runProcess(parsed.cmd, parsed.argv, {
      cwd,
      env: { ...oauthEnv, ...env },
      timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      stdin,
      protectedPaths,
    }, _progressCallback || null);

    // Verify the retry result
    const baseName = path.basename(parsed.cmd);
    const verifiedRetry = _verifyExpectedOutputs(retryResult, baseName, parsed.argv, cwd);

    logger.info(`[shell.run] Discovery retry completed`, {
      exitCode: verifiedRetry.exitCode,
      ok: verifiedRetry.ok,
      stdoutLen: (verifiedRetry.stdout || '').length,
    });

    return {
      ...verifiedRetry,
      cmd: [parsed.cmd, ...(parsed.argv || [])].join(' '),
      dryRun: false,
      retried: true,
      discoveryRetry: true,
      strictModeInjected: false,
    };
  } catch (e) {
    logger.warn(`[shell.run] Discovery retry failed: ${e.message}`);
    return null;
  }
}

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
  'yt-dlp', 'gallery-dl', 'whisper', 'spotdl',  // media download / transcription
  'convert', 'identify',  // ImageMagick
  'exiftool',

  // ── Document / OCR / utility tools ─────────────────────────────────────────
  'pandoc', 'wkhtmltopdf', 'tectonic',
  'gs', 'pdf2ps', 'pdftk', 'pdftotext',
  'magick',
  'tesseract',
  'mmdc', 'mermaid',
  'nmap',
  'http', 'httpie',
  'fd', 'bat', 'fzf',
  'mkcert',
  'act',

  // ── Printing (CUPS) ──────────────────────────────────────────────────────────
  'lp', 'lpr', 'lpstat', 'lpoptions', 'cancel',

  // ── macOS system / desktop ───────────────────────────────────────────────────
  'sips', 'qlmanage', 'mas', 'softwareupdate', 'installer', 'ditto',
  'xcodebuild', 'swift', 'xcrun', 'iconv', 'lsof', 'top',

  // ── Text / data processing ───────────────────────────────────────────────────
  'bc', 'expr', 'test', 'column', 'paste', 'join', 'split', 'tac', 'nl',
  'xxd', 'perl',

  // ── Crypto / security ────────────────────────────────────────────────────────
  'openssl', 'gpg', 'age', 'certbot',

  // ── Filesystem (non-destructive) ────────────────────────────────────────────
  'realpath', 'truncate', 'mktemp',

  // ── Scheduling ──────────────────────────────────────────────────────────────
  'crontab', 'at', 'atrm', 'atq',

  // ── System info / logging ───────────────────────────────────────────────────
  'logger', 'dmesg', 'hostnamectl', 'users', 'last', 'logname',
  'vmstat', 'iostat', 'mpstat', 'sar', 'pstree',

  // ── Database ────────────────────────────────────────────────────────────────
  'pg_dump',

  // ── PDF / LaTeX ──────────────────────────────────────────────────────────────
  'pdftoppm', 'pdftocairo', 'pdflatex', 'xelatex', 'lualatex', 'tex',

  // ── Network ──────────────────────────────────────────────────────────────────
  'nc', 'traceroute', 'ftp', 'sftp', 'telnet',

  // ── Windows / cross-platform ────────────────────────────────────────────────
  'pwsh', 'powershell', 'reg', 'wmic', 'winget', 'choco', 'scoop',

  // ── Linux package managers ──────────────────────────────────────────────────
  'apt', 'apt-get', 'dpkg', 'snap', 'flatpak', 'pacman', 'yay', 'paru',

  // ── systemd / init ──────────────────────────────────────────────────────────
  'systemctl', 'service', 'journalctl', 'timedatectl',

  // NOTE: Destructive system commands (shutdown, reboot, halt, init, telinit,
  // runlevel, fdisk, parted, fsck, mount, umount) are deliberately NOT in this
  // list — they surface the allowlist ask_user card so the user explicitly
  // approves before running. The allowlist is a "recognized command" gate, not
  // the safety boundary (that's DANGEROUS_COMMANDS + DANGEROUS_SCRIPT_PATTERNS).
]);

const USER_ALLOWLIST_PATH = path.join(os.homedir(), '.thinkdrop', 'allowed-commands.json');

function _loadUserAllowedCommands() {
  try {
    if (!fs.existsSync(USER_ALLOWLIST_PATH)) return new Set();
    const raw = fs.readFileSync(USER_ALLOWLIST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.commands) ? parsed.commands : []);
    const normalized = entries
      .filter((v) => typeof v === 'string')
      .map((v) => path.basename(v.trim()))
      .filter(Boolean);
    return new Set(normalized);
  } catch (err) {
    logger.warn(`[shell.run] Failed to load user allowlist ${USER_ALLOWLIST_PATH}: ${err.message}`);
    return new Set();
  }
}

let USER_ALLOWED_COMMANDS = _loadUserAllowedCommands();
let USER_ALLOWLIST_MTIME_MS = (() => {
  try { return fs.existsSync(USER_ALLOWLIST_PATH) ? fs.statSync(USER_ALLOWLIST_PATH).mtimeMs : 0; } catch (_) { return 0; }
})();

function _refreshUserAllowedCommandsIfNeeded() {
  try {
    const mtimeMs = fs.existsSync(USER_ALLOWLIST_PATH) ? fs.statSync(USER_ALLOWLIST_PATH).mtimeMs : 0;
    if (mtimeMs !== USER_ALLOWLIST_MTIME_MS) {
      USER_ALLOWED_COMMANDS = _loadUserAllowedCommands();
      USER_ALLOWLIST_MTIME_MS = mtimeMs;
    }
  } catch (_) {}
}

function _isCommandAllowed(baseName) {
  _refreshUserAllowedCommandsIfNeeded();
  return ALLOWED_COMMANDS.has(baseName) || USER_ALLOWED_COMMANDS.has(baseName);
}

/**
 * Add a command to the user's allowlist.
 * @param {string} commandName - The command to add
 * @returns {boolean} - True if successfully added
 */
function addCommandToAllowlist(commandName) {
  try {
    _refreshUserAllowedCommandsIfNeeded();
    const normalized = path.basename(commandName.trim());
    if (!normalized) return false;

    // Add to in-memory set
    USER_ALLOWED_COMMANDS.add(normalized);

    // Persist to file
    const existing = _loadUserAllowedCommands();
    existing.add(normalized);

    const data = {
      commands: Array.from(existing),
      updatedAt: new Date().toISOString()
    };

    // Ensure directory exists
    const dir = path.dirname(USER_ALLOWLIST_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(USER_ALLOWLIST_PATH, JSON.stringify(data, null, 2), 'utf8');
    USER_ALLOWLIST_MTIME_MS = fs.statSync(USER_ALLOWLIST_PATH).mtimeMs;

    logger.info(`[shell.run] Added '${normalized}' to user allowlist`);
    return true;
  } catch (err) {
    logger.warn(`[shell.run] Failed to add command to allowlist: ${err.message}`);
    return false;
  }
}

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

// Patterns that are dangerous inside bash -c scripts.
// NOTE: sudo by itself is NOT blocked — package installers (sudo installer, sudo brew)
// are legitimate. Only block sudo paired with high-risk targets.
const DANGEROUS_SCRIPT_PATTERNS = [
  /\bsudo\s+(rm|shred|mkfs|fdisk|parted|dd|wipefs)\b/,   // sudo + destructive disk/file ops
  /\bsudo\s+chmod\s+[0-7]*7[0-7]*\s+\/(?!Users|tmp)/,   // sudo chmod 7xx on system paths
  /\bsu\b\s+-[\s]*[cslp]/,                               // su -c / su -l / su -s / su -p
  /\bpasswd\b/,
  /rm\s+-rf\s+\/(?!Users|tmp|var\/tmp)/,  // rm -rf on system paths
  /:\s*\(\s*\)\s*\{.*fork bomb/i,          // fork bomb
  />\/dev\/sd[a-z]/,                       // writing to raw disk devices
  /dd\s+.*of=\/dev\/(?!null|zero)/,        // dd to disk devices
];

// sudo operations that are safe to allow but require user visibility
// When a script contains these, emit shell:sudo_required before execution
const SUDO_INSTALL_PATTERN = /\bsudo\b/;
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

function _resolveOutputPath(rawPath, cwd) {
  if (!rawPath || rawPath === '-' || rawPath === '/dev/null') return null;
  let candidate = String(rawPath).trim().replace(/^['"]|['"]$/g, '');
  if (!candidate || candidate.startsWith('-')) return null;
  if (candidate.includes('$')) return null;  // Shell variable — can't verify statically
  if (candidate.startsWith('~/')) {
    candidate = path.join(os.homedir(), candidate.slice(2));
  }
  if (!path.isAbsolute(candidate)) {
    candidate = path.resolve(cwd || process.cwd(), candidate);
  }
  return candidate;
}

function _isValidOutputPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return false;
  const p = rawPath.trim();
  if (p.length < 2 || p.length > 4096) return false;
  // Reject tokens with shell-incompatible chars that slipped through pathToken
  if (/[(){}=]/.test(p)) return false;       // exist_ok=True) , foo(bar)
  if (p.startsWith('-')) return false;        // flag, not a path
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(p)) return false; // VAR=value
  return true;
}

function _extractExpectedOutputs(baseName, argv = [], cwd) {
  const expected = [];
  const seen = new Set();
  const pushExpected = (rawPath, type, toolName) => {
    if (!_isValidOutputPath(rawPath)) return;
    const absPath = _resolveOutputPath(rawPath, cwd);
    if (!absPath || seen.has(absPath)) return;
    seen.add(absPath);
    expected.push({ path: absPath, type, toolName });
  };

  const isShellInterpreter = ['bash', 'sh', 'zsh'].includes(baseName);
  const hasScript = isShellInterpreter && Array.isArray(argv) && argv[0] === '-c' && typeof argv[1] === 'string';

  if (baseName === 'pandoc') {
    const i = argv.findIndex((a) => a === '-o' || a === '--output');
    if (i !== -1 && argv[i + 1]) pushExpected(argv[i + 1], 'file', 'pandoc');
  }
  if (baseName === 'curl') {
    const i = argv.findIndex((a) => a === '-o' || a === '--output');
    if (i !== -1 && argv[i + 1]) pushExpected(argv[i + 1], 'file', 'curl');
  }
  if (baseName === 'wget') {
    const i = argv.findIndex((a) => a === '-O' || a === '--output-document');
    if (i !== -1 && argv[i + 1]) pushExpected(argv[i + 1], 'file', 'wget');
  }
  if (baseName === 'touch') {
    argv.filter((a) => typeof a === 'string' && !a.startsWith('-')).forEach((p) => pushExpected(p, 'file', 'touch'));
  }
  if (baseName === 'mkdir') {
    argv.filter((a) => typeof a === 'string' && !a.startsWith('-')).forEach((p) => pushExpected(p, 'dir', 'mkdir'));
  }
  if (baseName === 'cp' || baseName === 'mv') {
    const positional = argv.filter((a) => typeof a === 'string' && !a.startsWith('-'));
    if (positional.length >= 2) {
      const dest = positional[positional.length - 1];
      // If destination ends with /, it's a directory target
      // Also check if glob was used (multiple source args expanded)
      const isDirTarget = dest.endsWith('/') || positional.length > 2;
      pushExpected(dest, isDirTarget ? 'dir' : 'file', baseName);
    }
  }

  if (!hasScript) return expected;

  const script = argv[1];

  // ── Skip script-body regex parsing for inner-interpreter one-liners ───────
  // When bash -c invokes python3 -c '...', node -e '...', perl -e '...', etc.,
  // the inner language's syntax is opaque to shell regex. Method calls like
  // pathlib.Path(...).mkdir(...) would be misread as shell mkdir commands,
  // producing false "expected output" paths (e.g. exist_ok=True)).
  const INNER_INTERPRETER_RE = /\b(python3?|node|ruby|perl|awk)\b\s+(-[ec]|--command|--eval)\b/;
  if (INNER_INTERPRETER_RE.test(script)) {
    return expected; // only direct-tool checks (already collected above) apply
  }

  const pathToken = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s\"\'`;|&]+))';

  let match;
  const pandocOut = new RegExp(`\\bpandoc\\b[^\\n;|&]*?\\s-o\\s+${pathToken}`, 'g');
  while ((match = pandocOut.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'file', 'pandoc');

  const curlOut = new RegExp(`\\bcurl\\b[^\\n;|&]*?\\s-o\\s+${pathToken}`, 'g');
  while ((match = curlOut.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'file', 'curl');

  const wgetOut = new RegExp(`\\bwget\\b[^\\n;|&]*?\\s-O\\s+${pathToken}`, 'g');
  while ((match = wgetOut.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'file', 'wget');

  const writeOps = new RegExp(`(?:echo|printf|cat)\\b[^\\n]*?>+\\s*${pathToken}`, 'g');
  while ((match = writeOps.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'file', 'bash');

  const teeOps = new RegExp(`\\btee\\b(?:\\s+-[a-zA-Z]+)*\\s+${pathToken}`, 'g');
  while ((match = teeOps.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'file', 'bash');

  // Skip scripts that use find -exec mv — destination is N individual files, not a single path we can verify statically.
  const hasFindExecMove = /\bfind\b[^\n]*-exec\s+mv\b/.test(script);
  if (!hasFindExecMove) {
    const copyMoveOps = new RegExp(`\\b(cp|mv)\\b[^\\n;|&]*?\\s+(?:"[^"]+"|'[^']+'|[^\\s"';|&]+)\\s+${pathToken}`, 'g');
    while ((match = copyMoveOps.exec(script)) !== null) {
      const dest = match[2] || match[3] || match[4];
      if (!dest || dest === '{}') continue; // {} is a find placeholder, not a real path
      pushExpected(dest, 'file', match[1]);
    }
  }

  const mkdirOps = new RegExp(`\\bmkdir\\b[^\\n;|&]*?\\s+${pathToken}`, 'g');
  while ((match = mkdirOps.exec(script)) !== null) pushExpected(match[1] || match[2] || match[3], 'dir', 'mkdir');

  return expected;
}

function _applyStrictShellMode(baseName, argv = []) {
  const isShellInterpreter = ['bash', 'sh', 'zsh'].includes(baseName);
  if (!isShellInterpreter || !Array.isArray(argv) || argv[0] !== '-c' || typeof argv[1] !== 'string') {
    return { argv, strictModeInjected: false };
  }

  const script = argv[1];

  // Already has explicit set -e — respect the script author's intent
  if (/^\s*set\s+-e/m.test(script)) {
    return { argv, strictModeInjected: false };
  }

  // Skip strict mode for loop constructs (for/while/until).
  // Loop bodies routinely invoke commands that return non-zero for expected,
  // non-error conditions: xattr -d on a file without that attribute, grep with
  // no match, diff on differing files, etc.  set -e would abort the entire loop
  // on the first benign failure, defeating the purpose of the loop.
  // Linear scripts (curl, mv, cp && rm, pipelines) retain full strict mode protection.
  if (/^\s*(for|while|until)\b/m.test(script)) {
    return { argv, strictModeInjected: false };
  }

  const strictPrefix = baseName === 'bash' ? 'set -euo pipefail\n' : 'set -e\n';
  const nextArgv = [...argv];
  nextArgv[1] = strictPrefix + script;
  return { argv: nextArgv, strictModeInjected: true };
}

function _verifyExpectedOutputs(result, baseName, argv, cwd) {
  if (!result.ok) return result;

  const expected = _extractExpectedOutputs(baseName, argv, cwd);
  if (expected.length === 0) return result;

  const missing = expected.find((entry) => {
    try {
      if (!fs.existsSync(entry.path)) return true;
      if (entry.type === 'dir') return !fs.statSync(entry.path).isDirectory();
      // For mv/cp where dest is an existing directory, the files land inside it —
      // the directory itself existing is sufficient verification; don't require isFile().
      const stat = fs.statSync(entry.path);
      if (stat.isDirectory()) return false;
      return !stat.isFile();
    } catch (_) {
      return true;
    }
  });

  if (!missing) {
    return {
      ...result,
      outputVerified: true,
      verifiedOutputs: expected.map((entry) => entry.path),
    };
  }

  // ── Soft-warning when the command succeeded but the verifier couldn't confirm ──
  // The verifier is a heuristic — false positives are possible (e.g. complex
  // pipelines, inner interpreters, dynamic paths). When the command itself
  // succeeded (exit 0), don't override that with a hard failure. Surface as a
  // warning so executeCommand can proceed and downstream synthesis can still
  // verify the actual result from the filesystem. Only hard-fail when the
  // command itself failed (non-zero exit) — there the verifier adds useful
  // diagnostic context about what didn't get created.
  if (result.ok && result.exitCode === 0) {
    return {
      ...result,
      outputVerified: false,
      verificationWarning: `Could not verify expected output: ${missing.path}`,
      unverifiedPath: missing.path,
    };
  }

  return {
    ...result,
    ok: false,
    error: `Output not created: ${missing.path}`,
    missingPath: missing.path,
    toolName: missing.toolName || baseName,
    stderrHint: String(result.stderr || '').trim().slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(args) {
  const { cmd, argv = [], cwd, timeoutMs } = args;

  if (!cmd || typeof cmd !== 'string') {
    return { ok: false, error: 'cmd is required and must be a string' };
  }

  // Detect full shell string in cmd (spaces, globs, operators) — spawn cannot handle these.
  // Return a structural error with clear guidance instead of a misleading allowlist gate.
  // (path.basename("mv /path/to/Desktop/") = "Desktop" → wrong allowlist check otherwise)
  if (/[\s*?|;&]/.test(cmd)) {
    const needsShell = /[*?|;&$`]/.test(cmd);
    return {
      ok: false,
      error: needsShell
        ? `cmd contains shell operators/globs — use cmd:"bash", argv:["-c","<command>"] instead`
        : `cmd contains spaces — split into cmd (binary name only) and argv (arguments array)`,
      _shellStringInCmd: true,
    };
  }

  const baseName = path.basename(cmd);

  if (!_isCommandAllowed(baseName)) {
    // Return askUser response for unknown commands
    // This triggers the ASK_USER flow in the UI
    return {
      ok: false,
      askUser: true,
      question: `The command '${baseName}' is not in the allowlist. Would you like to allow this command?`,
      options: ['Yes, add to allowlist and run', 'Yes, run once without adding', 'No, skip this step'],
      commandName: baseName,
      userAllowlistPath: USER_ALLOWLIST_PATH,
      _isShellAllowlist: true,  // Marker for executeCommand to handle specially
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
          return {
            ok: false,
            error:
              `Blocked pattern in argv: "${arg}" — spawn() does not expand shell ` +
              `syntax ($(), backticks). For command substitution or pipes use ` +
              `cmd:"bash", argv:["-c","<command>"].`
          };
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

// Detect commands that capture the screen — direct `screencapture` or a
// bash/sh/zsh -c script containing screencapture.
function _involvesScreencapture(baseName, argv) {
  if (process.platform !== 'darwin') return false;
  if (baseName === 'screencapture') return true;
  const isShell = ['bash', 'sh', 'zsh'].includes(baseName);
  return isShell && Array.isArray(argv) && argv[0] === '-c'
    && typeof argv[1] === 'string' && /\bscreencapture\b/.test(argv[1]);
}

// Flash-hide ThinkDrop's own overlay UI around a screenshot so captures look
// like clean native macOS screenshots (same pattern as app.agent._withFlash).
// If the overlay control server is unreachable the capture still proceeds —
// it just includes whatever overlay UI is on screen.
async function _withScreenshotFlash(fn) {
  const http = require('http');
  const port = parseInt(process.env.OVERLAY_CONTROL_PORT || '3010', 10);
  const post = (urlPath, timeoutMs) => new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', timeout: timeoutMs },
      () => finish(true)
    );
    req.on('error', () => finish(false));
    req.on('timeout', () => { req.destroy(); finish(false); });
    req.end();
  });

  const flashOk = await post('/overlay/flash', 800);
  if (!flashOk) {
    logger.warn('[shell.run] /overlay/flash unreachable — screenshot will include any visible overlay UI');
  } else {
    await new Promise(r => setTimeout(r, 250)); // settle so overlay is fully hidden
  }

  try {
    return await fn();
  } finally {
    if (flashOk) await post('/overlay/unflash', 800);
  }
}

// ── Protected-path sandbox (Seatbelt) ────────────────────────────────────
// Attached user files ([File: …]/[Folder: …] tags) must never be rewritten by
// raw shell commands — they route through edit.agent's draft/backup/diff
// rails. Rather than parsing scripts for write patterns (unbounded: open(w),
// sed -i, >, tee, dd, rm, mv, compiled tools, …), deny file-write* on the
// protected paths at the kernel boundary — every write mechanism fails EPERM,
// reads unaffected, and it works even when the command references the file
// indirectly (cwd-relative paths, env vars, child processes).
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
let _sandboxAvailable = null;
function _sandboxProfile(protectedPaths) {
  if (!Array.isArray(protectedPaths) || protectedPaths.length === 0) return null;
  if (_sandboxAvailable === null) {
    try { _sandboxAvailable = fs.existsSync(SANDBOX_EXEC); } catch (_) { _sandboxAvailable = false; }
    if (!_sandboxAvailable) logger.warn('[shell.run] sandbox-exec unavailable — protected-path enforcement disabled (fail-open)');
  }
  if (!_sandboxAvailable) return null;
  const rules = [];
  for (const entry of protectedPaths) {
    const resolved = typeof entry === 'string' ? entry : entry?.resolved;
    if (!resolved) continue;
    // Seatbelt literals match canonical paths — callers must realpath-resolve.
    const esc = String(resolved).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    rules.push(`(deny file-write* (literal "${esc}"))`);
  }
  return rules.length ? `(version 1)(allow default)${rules.join('')}` : null;
}

function runProcess(cmd, argv, options, onProgress) {
  return new Promise((_resolve) => {
    const _sbxProfile = _sandboxProfile(options?.protectedPaths);
    const resolve = (r) => _resolve(_sbxProfile ? { ...r, sandboxed: true } : r);
    if (_sbxProfile) {
      argv = ['-p', _sbxProfile, cmd, ...(argv || [])];
      cmd = SANDBOX_EXEC;
    }
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

    // Debounce chunk emission so rapid output doesn't flood the UI bridge
    let _chunkTimer = null;
    let _pendingChunk = '';
    function _flushChunk() {
      if (_pendingChunk && onProgress) {
        onProgress({ type: 'shell:stdout_chunk', text: _pendingChunk });
      }
      _pendingChunk = '';
      _chunkTimer = null;
    }

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += text;
      } else if (!truncated) {
        stdoutBuf += '\n[output truncated]';
        truncated = true;
      }
      if (onProgress) {
        _pendingChunk += text;
        if (!_chunkTimer) _chunkTimer = setTimeout(_flushChunk, 120);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += text;
      }
      if (onProgress) {
        _pendingChunk += text;
        if (!_chunkTimer) _chunkTimer = setTimeout(_flushChunk, 120);
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
  let {
    cmd,
    argv = [],
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    dryRun = false,
    stdin,
    goal,
    _progressCallback,
    protectedPaths,
  } = args || {};

  // ── Goal resolution path ─────────────────────────────────────────────────
  // When the planner passes a plain-language args.goal instead of args.argv,
  // resolve it to a concrete command via the internal LLM before proceeding.
  if (goal && !cmd) {
    logger.info('[shell.run] Resolving goal via internal LLM', { goal });

    // ── Layer 1: Force-classification for known system queries ──────────
    // Ask the LLM to pick a category number (1-N) or 0 (unknown). When a
    // known category is matched, use the pre-validated dump command from
    // SYSTEM_QUERY_REGISTRY — zero LLM generation, zero field-name hallucination.
    const categoryNum = await _classifySystemQuery(goal, _progressCallback || null);
    if (categoryNum > 0) {
      const entry = SYSTEM_QUERY_REGISTRY[categoryNum - 1];
      cmd = entry.cmd;
      argv = entry.argv;
      logger.info('[shell.run] Goal matched system query registry', { category: categoryNum, label: entry.label, cmd, argv });
    } else {
      // ── Layer 1.5: Force-classification for known file operations ──────
      // Check FILE_OP_REGISTRY for patterns like "print this file" that have
      // pre-validated commands. Zero LLM generation, zero hallucination.
      // Same pattern as SYSTEM_QUERY_REGISTRY but for parameterized file ops.
      let _fileOpMatched = false;
      for (const entry of FILE_OP_REGISTRY) {
        if (entry.regex.test(goal)) {
          const filePath = entry.extractPath(goal);
          if (filePath) {
            const built = entry.buildCmd(filePath);
            cmd = built.cmd;
            argv = built.argv;
            logger.info('[shell.run] Goal matched file-op registry', { label: entry.label, cmd, argv });
            _fileOpMatched = true;
            break;
          }
        }
      }

      if (!_fileOpMatched) {
        // ── Fallback: free-generation for custom tasks (existing path) ─────
        const resolved = await _resolveGoalToCommand(goal, _progressCallback || null);
        if (!resolved.ok) {
          return { ok: false, stdout: '', stderr: '', exitCode: -1, executionTime: 0, cmd: '', dryRun, error: resolved.error };
        }
        cmd = resolved.cmd;
        argv = resolved.argv;
        logger.info('[shell.run] Goal resolved to command', { cmd, argv });
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const originalCmdString = [cmd, ...(argv || [])].join(' ');

  logger.info('shell.run invoked', { cmd, argv, cwd, timeoutMs, dryRun });

  // Validate
  const validation = validate({ ...args, cmd, argv });
  if (!validation.ok) {
    logger.warn('shell.run validation failed', { error: validation.error, cmd, argv });
    return {
      ok: false,
      stdout: '',
      stderr: '',
      exitCode: -1,
      executionTime: 0,
      cmd: originalCmdString,
      dryRun,
      error: validation.error,
      // Propagate allowlist ask_user fields so executeCommand.js can surface
      // the "Allow X and retry" card instead of a generic "failed: null".
      askUser: validation.askUser || false,
      question: validation.question || null,
      options: validation.options || null,
      _isShellAllowlist: validation._isShellAllowlist || false,
      // Fix: validation returns userAllowlistPath (not userAllowlistHint);
      // the hint is true when either the path or the _isShellAllowlist marker is set.
      userAllowlistHint: !!validation.userAllowlistPath || !!validation._isShellAllowlist,
      commandName: validation.commandName || null,
      userAllowlistPath: validation.userAllowlistPath || null,
      _shellStringInCmd: !!validation._shellStringInCmd,
    };
  }

  const baseName = path.basename(cmd);
  const { argv: runArgv, strictModeInjected } = _applyStrictShellMode(baseName, argv);
  const resolvedCmdString = [cmd, ...runArgv].join(' ');

  // Dry-run: return preview without executing
  if (dryRun) {
    logger.info('shell.run dry-run', { cmd, argv: runArgv, cwd });
    return {
      ok: true,
      stdout: '',
      stderr: '',
      exitCode: 0,
      executionTime: 0,
      cmd: resolvedCmdString,
      dryRun: true,
      preview: `Would run: ${resolvedCmdString}${cwd ? ` (in ${cwd})` : ''}`,
      strictModeInjected,
    };
  }

  // Execute
  const oauthEnv = await loadOAuthEnv();

  // ── sudo visibility — emit event before execution so the UI can warn the user ──
  const isShellScript = ['bash', 'sh', 'zsh'].includes(path.basename(cmd));
  const scriptBody = isShellScript && Array.isArray(runArgv) && runArgv[0] === '-c' ? (runArgv[1] || '') : '';
  if (scriptBody && SUDO_INSTALL_PATTERN.test(scriptBody) && _progressCallback) {
    _progressCallback({
      type: 'shell:sudo_required',
      message: 'This step requires administrator access (sudo). You may be prompted for your system password in the terminal.',
      cmd: resolvedCmdString,
    });
  }

  const _runStep = () => runProcess(cmd, runArgv, {
    cwd,
    // OAuth vars are the lowest priority — explicit env arg and process.env override them
    env: { ...oauthEnv, ...env },
    timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
    stdin,
    protectedPaths,
  }, _progressCallback || null);

  // Hide ThinkDrop's own UI while screencapture runs (clean screenshots).
  const result = _involvesScreencapture(baseName, runArgv)
    ? await _withScreenshotFlash(_runStep)
    : await _runStep();

  const verifiedResult = _verifyExpectedOutputs(result, baseName, runArgv, cwd);

  logger.info('shell.run completed', {
    cmd,
    exitCode: verifiedResult.exitCode,
    executionTime: verifiedResult.executionTime,
    ok: verifiedResult.ok,
    strictModeInjected,
    // Include truncated stderr for diagnostics — distinguishes missing file,
    // AppleScript/TCC failure, wrong active app, invalid command, printer failure.
    // Never log stdout (may contain file contents); stderr is usually short error text.
    stderr: verifiedResult.ok ? undefined : String(verifiedResult.stderr || '').trim().slice(0, 500),
  });

  // ── Layer 2: Discovery retry for failed pipelines ─────────────────────
  // If the command was a goal-resolved pipeline that failed with empty stdout,
  // the LLM likely hallucinated field names. Run the source raw, show the LLM
  // the actual output, and regenerate the extraction.
  if (
    verifiedResult.exitCode !== 0 &&
    !(verifiedResult.stdout || '').trim() &&
    scriptBody &&
    scriptBody.includes('|') &&
    goal  // only for goal-resolved commands, not pre-built argv
  ) {
    const discoveryResult = await _discoveryRetry(
      scriptBody, goal, cwd, env, oauthEnv, timeoutMs, stdin, _progressCallback || null, protectedPaths
    );
    if (discoveryResult) {
      // Return the discovery retry result (whether it succeeded or failed).
      // If it failed too, thin-recovery (Layer 3) in executeCommand.js will handle it.
      return discoveryResult;
    }
    // If discovery retry didn't apply (e.g. source had no output), fall through
    // to normal return — thin-recovery will handle the failure.
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── 401/403 auto-retry ──────────────────────────────────────────────────
  // If the command output contains signs of an auth failure AND OAuth tokens
  // were injected, force-refresh all providers and retry the command once.
  // This handles the case where issued_at was recorded incorrectly (e.g., at
  // storage time rather than at Google token-issuance time).
  const combinedOutput = (verifiedResult.stdout || '') + (verifiedResult.stderr || '');
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
    const _retryStep = () => runProcess(cmd, runArgv, {
      cwd,
      env: { ...freshEnv, ...env },
      timeoutMs: Math.min(timeoutMs, MAX_TIMEOUT_MS),
      stdin,
    });
    const retryResult = _involvesScreencapture(baseName, runArgv)
      ? await _withScreenshotFlash(_retryStep)
      : await _retryStep();
    const verifiedRetryResult = _verifyExpectedOutputs(retryResult, baseName, runArgv, cwd);
    logger.info('shell.run retry completed', {
      cmd, exitCode: verifiedRetryResult.exitCode, executionTime: verifiedRetryResult.executionTime, ok: verifiedRetryResult.ok,
    });
    return {
      ...verifiedRetryResult,
      cmd: resolvedCmdString,
      dryRun: false,
      retried: true,
      strictModeInjected,
    };
  }
  // ────────────────────────────────────────────────────────────────────────

  return {
    ...verifiedResult,
    cmd: resolvedCmdString,
    dryRun: false,
    strictModeInjected,
  };
}

/**
 * Generate an output contract for this skill's execution result.
 * This allows downstream steps to understand what this step produced.
 */
function getOutputContract(result) {
  if (!result) return null;

  // Extract file paths from stdout
  const filePaths = [];
  if (result.stdout && typeof result.stdout === 'string') {
    // Match absolute paths: /Users/name/... or ~/...
    const pathPatterns = [
      /(?:^|\s)(\/[^\s\n]+\.\w+)(?=\s|$)/gm,
      /(?:^|\s)(~\/[^\s\n]+\.\w+)(?=\s|$)/gm,
      /"([^"]+\.\w+)"/g,
      /'([^']+\.\w+)'/g
    ];

    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(result.stdout)) !== null) {
        const path = match[1] || match[0];
        if (path && !filePaths.includes(path)) {
          filePaths.push(path);
        }
      }
    }
  }

  return {
    skill: 'shell.run',
    timestamp: Date.now(),
    success: result.ok === true,
    summary: result.ok
      ? `Shell command '${result.cmd}' completed (exit ${result.exitCode})`
      : `Shell command '${result.cmd}' failed (exit ${result.exitCode})`,
    outputs: {
      stdout: { type: 'text', value: result.stdout || '' },
      stderr: { type: 'text', value: result.stderr || '' },
      exitCode: { type: 'number', value: result.exitCode ?? null },
      filePaths: { type: 'array', value: filePaths },
      cmd: { type: 'text', value: result.cmd || '' }
    },
    error: result.ok ? undefined : {
      message: result.error || 'Command failed',
      exitCode: result.exitCode
    }
  };
}

module.exports = { shellRun, validate, getOutputContract, addCommandToAllowlist, ALLOWED_COMMANDS, DANGEROUS_COMMANDS, _looksTruncated };
