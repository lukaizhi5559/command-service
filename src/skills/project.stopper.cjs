'use strict';
/**
 * project.stopper.cjs
 *
 * Stops a running ThinkDrop project by killing the node server on its port.
 *
 * Args:
 *   projectName  string  — slug or fuzzy name
 *   port         number  — optional override
 *
 * Returns:
 *   { ok, projectName, port, output }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { execSync } = require('child_process');
const logger = require('../logger.cjs');

const PROJECTS_BASE = path.join(os.homedir(), '.thinkdrop', 'projects');

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

async function projectStop(args) {
  const { projectName: nameArg, port: portOverride } = args || {};

  const projectDir = resolveProjectDir(nameArg);
  if (!projectDir) {
    return { ok: false, error: `No built project found matching "${nameArg}"` };
  }

  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(path.join(projectDir, '.thinkdrop-project.json'), 'utf8')); } catch (_) {}
  const projectName = manifest.projectName || path.basename(projectDir);
  const port = portOverride || manifest.defaultPort;

  if (!port) {
    return { ok: false, error: `No port found for project "${projectName}"` };
  }

  logger.info(`[project.stopper] Stopping "${projectName}" on port ${port}`);

  let killed = false;
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); killed = true; } catch (_) {}
    }
  } catch (_) {}

  if (killed) {
    logger.info(`[project.stopper] ✅ Killed server on port ${port}`);
    return {
      ok: true,
      projectName,
      port,
      output: `Stopped "${projectName}" (port ${port}).`,
    };
  } else {
    logger.info(`[project.stopper] No process found on port ${port} — already stopped`);
    return {
      ok: true,
      projectName,
      port,
      output: `"${projectName}" was not running (port ${port} was free).`,
    };
  }
}

module.exports = { projectStop };
