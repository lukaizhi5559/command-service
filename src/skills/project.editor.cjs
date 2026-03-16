'use strict';
/**
 * project.editor.cjs
 *
 * Lightweight LLM-only skill for iterating on a built ThinkDrop project.
 * Skips the full stategraph pipeline — reads current source files, sends them
 * + the user's edit request to the LLM, writes updated files, rebuilds, and
 * restarts the server.
 *
 * Args:
 *   projectName  string  — slug or fuzzy name of the project
 *   prompt       string  — what the user wants changed (e.g. "fix the black squares")
 *   port         number  — optional port override
 *
 * Returns:
 *   { ok, projectName, projectDir, port, changedFiles, output }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const { spawn, execSync } = require('child_process');
const logger = require('../logger.cjs');

const PROJECTS_BASE  = path.join(os.homedir(), '.thinkdrop', 'projects');
const BUILD_TIMEOUT  = 60000;
const START_TIMEOUT  = 15000;

// ── Helpers (shared with project.launcher) ────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function resolveProjectDir(nameArg) {
  if (!nameArg) return null;
  const slug = slugify(nameArg);
  const exactPath = path.join(PROJECTS_BASE, slug);
  if (fs.existsSync(path.join(exactPath, '.thinkdrop-project.json'))) return exactPath;

  let entries = [];
  try { entries = fs.readdirSync(PROJECTS_BASE, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) {}
  const needle = slug.replace(/-/g, '');
  let best = null, bestScore = 0;
  for (const entry of entries) {
    const haystack = entry.name.replace(/-/g, '');
    if (haystack === needle) return path.join(PROJECTS_BASE, entry.name);
    let score = 0;
    for (const ch of needle) { if (haystack.includes(ch)) score++; }
    const ratio = score / Math.max(needle.length, haystack.length);
    if (ratio > bestScore) { bestScore = ratio; best = entry.name; }
  }
  if (best && bestScore >= 0.6) return path.join(PROJECTS_BASE, best);
  return null;
}

function runCommand(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false, env: { ...process.env } });
    let stdout = '', stderr = '';
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, stdout, stderr, code }); });
    proc.on('error', err => { clearTimeout(timer); resolve({ ok: false, stdout, stderr, error: err.message }); });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, res => resolve(res.statusCode === 200));
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function killOnPort(port) {
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
    }
    return pids.length > 0;
  } catch (_) { return false; }
}

// ── Parse LLM response ───────────────────────────────────────────────────────

function parseEditResponse(raw) {
  const result = { serverApp: null, clientApp: null };

  // Match ### FILE: server/app.js ... ```js ... ```
  const serverMatch = raw.match(/###\s*FILE:\s*server\/app\.js[\s\S]*?```(?:js|javascript)?\n([\s\S]*?)```/i);
  if (serverMatch) result.serverApp = serverMatch[1].trim();

  // Match ### FILE: client/App.jsx ... ```jsx ... ```
  const clientMatch = raw.match(/###\s*FILE:\s*client\/App\.jsx[\s\S]*?```(?:jsx|javascript|js)?\n([\s\S]*?)```/i);
  if (clientMatch) result.clientApp = clientMatch[1].trim();

  // Fallback: extract code blocks
  if (!result.serverApp && !result.clientApp) {
    const blocks = [...raw.matchAll(/```(?:js|jsx|javascript)?\n([\s\S]*?)```/g)].map(m => m[1].trim());
    if (blocks.length >= 2) {
      result.serverApp = blocks.find(b => b.includes('handleCommand')) || blocks[0];
      result.clientApp = blocks.find(b => b.includes('import') && b.includes('useState')) || blocks[1];
    } else if (blocks.length === 1) {
      if (blocks[0].includes('handleCommand')) result.serverApp = blocks[0];
      else result.clientApp = blocks[0];
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function projectEdit(args) {
  const { projectName: nameArg, prompt: editPrompt, port: portOverride } = args || {};

  if (!editPrompt) {
    return { ok: false, error: 'project.editor requires a prompt describing the change' };
  }

  const projectDir = resolveProjectDir(nameArg);
  if (!projectDir) {
    return { ok: false, error: `No built project found matching "${nameArg}"` };
  }

  // Read manifest
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(projectDir, '.thinkdrop-project.json'), 'utf8')); } catch (_) {}
  const projectName = manifest.projectName || path.basename(projectDir);
  const port = portOverride || manifest.defaultPort;

  logger.info(`[project.editor] Editing "${projectName}" — prompt: "${editPrompt.substring(0, 100)}"`);

  // ── Step 1: Read current source files ───────────────────────────────────────
  let currentServerApp = '', currentClientApp = '';
  const serverPath = path.join(projectDir, 'server', 'app.js');
  const clientPath = path.join(projectDir, 'client', 'App.jsx');
  try { currentServerApp = fs.readFileSync(serverPath, 'utf8'); } catch (_) {}
  try { currentClientApp = fs.readFileSync(clientPath, 'utf8'); } catch (_) {}

  if (!currentServerApp && !currentClientApp) {
    return { ok: false, error: `No source files found in ${projectDir}` };
  }

  // ── Step 2: Ask LLM to edit ─────────────────────────────────────────────────
  const llm = require('../skill-llm.cjs');
  if (!await llm.isAvailable()) {
    return { ok: false, error: 'LLM backend not available' };
  }

  const editSystemPrompt = `You are editing an existing Vite+React+Express ThinkDrop app.
The app uses shadcn/ui components (Button, Card, Badge, etc.), Tailwind CSS, and a Node.js Express backend.
The backend has a handleCommand(action, args) function called via POST /thinkdrop/command.
The frontend is a single client/App.jsx React component.

RULES:
- Output the COMPLETE updated file(s) — not diffs, not partial snippets
- Only output files that need changes. If only the frontend needs fixing, only output client/App.jsx
- Use this exact format for each file:

### FILE: server/app.js
\`\`\`js
// complete file contents here
\`\`\`

### FILE: client/App.jsx
\`\`\`jsx
// complete file contents here
\`\`\`

- Keep all existing functionality unless explicitly asked to remove it
- Use shadcn/ui components and Tailwind classes for styling
- The server must export { handleCommand }`;

  const editUserPrompt = `Here are the current source files:

### FILE: server/app.js (current)
\`\`\`js
${currentServerApp}
\`\`\`

### FILE: client/App.jsx (current)
\`\`\`jsx
${currentClientApp}
\`\`\`

USER REQUEST: ${editPrompt}

Output the updated file(s) using the ### FILE: format. Only include files that need changes.`;

  let raw;
  try {
    raw = await llm.askWithMessages([
      { role: 'system', content: editSystemPrompt },
      { role: 'user', content: editUserPrompt },
    ], { temperature: 0.2, responseTimeoutMs: 60000 });
  } catch (llmErr) {
    return { ok: false, error: `LLM error: ${llmErr.message}` };
  }

  if (!raw) {
    return { ok: false, error: 'LLM returned empty response' };
  }

  logger.info(`[project.editor] LLM response: ${raw.length} chars`);

  const parsed = parseEditResponse(raw);
  const changedFiles = [];

  // ── Step 3: Write updated files ─────────────────────────────────────────────
  if (parsed.serverApp) {
    fs.writeFileSync(serverPath, parsed.serverApp, 'utf8');
    changedFiles.push('server/app.js');
    logger.info(`[project.editor] Updated server/app.js (${parsed.serverApp.length} chars)`);
  }
  if (parsed.clientApp) {
    fs.writeFileSync(clientPath, parsed.clientApp, 'utf8');
    changedFiles.push('client/App.jsx');
    logger.info(`[project.editor] Updated client/App.jsx (${parsed.clientApp.length} chars)`);
  }

  if (changedFiles.length === 0) {
    return { ok: false, error: 'LLM did not return any updated files — try rephrasing the request' };
  }

  // ── Step 4: Rebuild ─────────────────────────────────────────────────────────
  logger.info(`[project.editor] Rebuilding...`);
  const buildResult = await runCommand('npm', ['run', 'build'], projectDir, BUILD_TIMEOUT);
  if (!buildResult.ok) {
    const buildErr = (buildResult.stderr || buildResult.stdout || buildResult.error || '').slice(0, 1000);
    logger.warn(`[project.editor] Build failed: ${buildErr.substring(0, 200)}`);
    return {
      ok: false,
      error: `Build failed after edit: ${buildErr.substring(0, 500)}`,
      changedFiles,
      projectDir,
    };
  }

  // ── Step 5: Restart server ──────────────────────────────────────────────────
  if (port) {
    logger.info(`[project.editor] Restarting server on port ${port}...`);
    killOnPort(port);
    await new Promise(r => setTimeout(r, 500));

    const serverProc = spawn('node', ['server/index.js'], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    serverProc.unref();

    const ready = await waitForServer(port, START_TIMEOUT);
    if (!ready) {
      logger.warn(`[project.editor] Server did not restart on port ${port}`);
    } else {
      logger.info(`[project.editor] Server ready on port ${port}`);
    }
  }

  logger.info(`[project.editor] ✅ Edit complete — changed: ${changedFiles.join(', ')}`);

  return {
    ok: true,
    projectName,
    projectDir,
    port,
    changedFiles,
    output: `Updated ${changedFiles.join(' and ')} for "${projectName}". ${port ? `Server restarted at http://127.0.0.1:${port} — refresh your browser.` : 'Rebuild complete.'}`,
  };
}

module.exports = { projectEdit };
