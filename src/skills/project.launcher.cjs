'use strict';
/**
 * project.launcher.cjs
 *
 * Starts a previously built ThinkDrop project and opens it in the default browser.
 *
 * Looks up the project by name (fuzzy match against ~/.thinkdrop/projects/) and
 * reads its .thinkdrop-project.json manifest to get the projectDir and defaultPort.
 *
 * Steps:
 *   1. Resolve project dir from projectName arg (or from recent build context)
 *   2. Read .thinkdrop-project.json for port
 *   3. Check if server is already running on that port
 *   4. If not, spawn `node server/index.js` detached (persists after this call)
 *   5. Wait for HTTP /health to respond
 *   6. Open http://127.0.0.1:<port> in the default browser via `open`
 *
 * Args:
 *   projectName  string  — project slug e.g. "build-a-tic-tac-toe-game" or fuzzy "tic tac toe"
 *   port         number  — optional override port (uses manifest defaultPort if not set)
 *
 * Returns:
 *   { ok, projectName, projectDir, port, url, output }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const http   = require('http');
const { spawn, execFileSync } = require('child_process');
const logger = require('../logger.cjs');

const PROJECTS_BASE  = path.join(os.homedir(), '.thinkdrop', 'projects');
const START_TIMEOUT  = 20000; // 20s

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Find best matching project dir for a user-supplied name (exact or fuzzy). */
function resolveProjectDir(nameArg) {
  if (!nameArg) return null;

  const slug = slugify(nameArg);

  // 1. Exact slug match
  const exactPath = path.join(PROJECTS_BASE, slug);
  if (fs.existsSync(path.join(exactPath, '.thinkdrop-project.json'))) return exactPath;

  // 2. List all projects, pick best substring match
  let entries = [];
  try { entries = fs.readdirSync(PROJECTS_BASE, { withFileTypes: true }).filter(e => e.isDirectory()); } catch (_) {}

  const needle = slug.replace(/-/g, '');
  let best = null;
  let bestScore = 0;
  for (const entry of entries) {
    const haystack = entry.name.replace(/-/g, '');
    if (haystack === needle) return path.join(PROJECTS_BASE, entry.name); // exact
    // Count matching chars
    let score = 0;
    for (const ch of needle) { if (haystack.includes(ch)) score++; }
    const ratio = score / Math.max(needle.length, haystack.length);
    if (ratio > bestScore) { bestScore = ratio; best = entry.name; }
  }

  // Accept fuzzy match if >60% character overlap
  if (best && bestScore >= 0.6) return path.join(PROJECTS_BASE, best);

  return null;
}

async function isPortOpen(port) {
  return new Promise(resolve => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function projectLaunch(args) {
  const { projectName: nameArg, port: portOverride } = args || {};

  const projectDir = resolveProjectDir(nameArg);
  if (!projectDir) {
    return {
      ok: false,
      error: `No built ThinkDrop project found matching "${nameArg}". Available projects: ${
        (() => { try { return fs.readdirSync(PROJECTS_BASE).join(', ') || '(none)'; } catch (_) { return '(none)'; } })()
      }`,
    };
  }

  // Read manifest
  const manifestPath = path.join(projectDir, '.thinkdrop-project.json');
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    return { ok: false, error: `Could not read project manifest at ${manifestPath}` };
  }

  const projectName = manifest.projectName || path.basename(projectDir);
  const port = portOverride || manifest.defaultPort;

  if (!port) {
    return { ok: false, error: `No port found in manifest for project "${projectName}". Manifest: ${JSON.stringify(manifest)}` };
  }

  logger.info(`[project.launcher] Launching "${projectName}" on port ${port} from ${projectDir}`);

  // Check if already running
  const alreadyUp = await isPortOpen(port);
  if (alreadyUp) {
    logger.info(`[project.launcher] Server already running on port ${port} — opening browser`);
  } else {
    // Start server detached so it persists
    logger.info(`[project.launcher] Starting server: node server/index.js`);
    const serverProc = spawn('node', ['server/index.js'], {
      cwd: projectDir,
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    serverProc.unref(); // let it outlive this process

    const ready = await waitForServer(port, START_TIMEOUT);
    if (!ready) {
      return {
        ok: false,
        error: `Server for "${projectName}" failed to start on port ${port} within ${START_TIMEOUT / 1000}s. Check ${projectDir}/server/index.js`,
      };
    }
    logger.info(`[project.launcher] Server ready on port ${port}`);
  }

  const url = `http://127.0.0.1:${port}`;

  // Open in default browser
  try {
    execFileSync('open', [url], { timeout: 5000 });
    logger.info(`[project.launcher] Opened ${url} in browser`);
  } catch (openErr) {
    logger.warn(`[project.launcher] open browser failed (non-fatal): ${openErr.message}`);
  }

  return {
    ok: true,
    projectName,
    projectDir,
    port,
    url,
    output: `"${projectName}" is running at ${url} and has been opened in your browser.`,
  };
}

module.exports = { projectLaunch };
