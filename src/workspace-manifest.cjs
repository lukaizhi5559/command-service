'use strict';

/**
 * workspace-manifest.cjs
 *
 * Generates ~/.thinkdrop/manifest.json at startup (and on demand).
 * Contains a snapshot of ThinkDrop's capabilities for self-awareness injection.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('./logger.cjs');

const THINKDROP_DIR = path.join(os.homedir(), '.thinkdrop');
const MANIFEST_PATH = path.join(THINKDROP_DIR, 'manifest.json');
const SKILLS_DIR = path.join(THINKDROP_DIR, 'skills');
const AGENTS_DIR = path.join(THINKDROP_DIR, 'agents');

async function generateManifest() {
  const t0 = Date.now();
  const manifest = {
    generatedAt: new Date().toISOString(),
    version: '1.0',
    agents: { count: 0, items: [] },
    skills: { count: 0, items: [] },
    databases: [],
    contextRules: { count: 0 },
    workspace: { path: THINKDROP_DIR, entries: [] },
    applications: [],
  };

  // ── Agents ──────────────────────────────────────────────────────────────────
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      const agentFiles = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
      manifest.agents.count = agentFiles.length;
      manifest.agents.items = agentFiles.map(f => f.replace('.md', ''));
    }
  } catch (e) {
    logger.debug(`[manifest] agents scan failed: ${e.message}`);
  }

  // ── Skills ──────────────────────────────────────────────────────────────────
  try {
    if (fs.existsSync(SKILLS_DIR)) {
      const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());
      manifest.skills.count = skillDirs.length;
      manifest.skills.items = skillDirs.map(d => d.name);
    }
  } catch (e) {
    logger.debug(`[manifest] skills scan failed: ${e.message}`);
  }

  // ── Databases ───────────────────────────────────────────────────────────────
  const dbPaths = [
    { name: 'agents.db', path: path.join(THINKDROP_DIR, 'agents.db') },
    { name: 'user_memory.duckdb', path: path.resolve(__dirname, '../../thinkdrop-user-memory-service/data/user_memory.duckdb') },
    { name: 'conversation.duckdb', path: path.resolve(__dirname, '../../conversation-service/data/conversation.duckdb') },
  ];
  for (const db of dbPaths) {
    if (fs.existsSync(db.path)) {
      const stat = fs.statSync(db.path);
      manifest.databases.push({ name: db.name, sizeBytes: stat.size, exists: true });
    } else {
      manifest.databases.push({ name: db.name, exists: false });
    }
  }

  // ── Context rules count ─────────────────────────────────────────────────────
  try {
    const skillDb = require('./skill-helpers/skill-db.cjs');
    if (typeof skillDb.listAllContextRules === 'function') {
      const grouped = await skillDb.listAllContextRules();
      let count = 0;
      if (typeof grouped === 'object') {
        for (const key of Object.keys(grouped)) {
          count += Array.isArray(grouped[key]) ? grouped[key].length : 0;
        }
      }
      manifest.contextRules.count = count;
    }
  } catch (e) {
    logger.debug(`[manifest] context rules count failed: ${e.message}`);
  }

  // ── Workspace top-level entries ─────────────────────────────────────────────
  try {
    if (fs.existsSync(THINKDROP_DIR)) {
      const items = fs.readdirSync(THINKDROP_DIR, { withFileTypes: true });
      manifest.workspace.entries = items.slice(0, 50).map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'dir' : 'file',
      }));
    }
  } catch (e) {
    logger.debug(`[manifest] workspace scan failed: ${e.message}`);
  }

  // ── macOS Applications (top-level only) ────────────────────────────────────
  try {
    const appsDir = '/Applications';
    if (fs.existsSync(appsDir)) {
      const apps = fs.readdirSync(appsDir)
        .filter(f => f.endsWith('.app'))
        .map(f => f.replace('.app', ''))
        .sort();
      manifest.applications = apps;
    }
  } catch (e) {
    logger.debug(`[manifest] apps scan failed: ${e.message}`);
  }

  // ── User folders summary ────────────────────────────────────────────────────
  const userFolders = ['Desktop', 'Downloads', 'Documents'].map(folder => {
    const folderPath = path.join(os.homedir(), folder);
    try {
      if (fs.existsSync(folderPath)) {
        const items = fs.readdirSync(folderPath);
        return { name: folder, itemCount: items.length };
      }
    } catch {}
    return { name: folder, itemCount: 0 };
  });
  manifest.userFolders = userFolders;

  // ── Write manifest ──────────────────────────────────────────────────────────
  try {
    fs.mkdirSync(THINKDROP_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info(`[manifest] Generated in ${Date.now() - t0}ms → ${MANIFEST_PATH}`);
  } catch (e) {
    logger.error(`[manifest] Write failed: ${e.message}`);
  }

  return manifest;
}

/**
 * Read the current manifest (does not regenerate)
 */
function readManifest() {
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    }
  } catch {}
  return null;
}

/**
 * Get a compact summary string suitable for LLM system prompt injection
 */
function getManifestSummary() {
  const m = readManifest();
  if (!m) return null;

  const lines = [
    `═══ THINKDROP WORKSPACE MANIFEST (generated ${m.generatedAt}) ═══`,
    `Agents: ${m.agents.count}${m.agents.items.length ? ' — ' + m.agents.items.join(', ') : ''}`,
    `Skills: ${m.skills.count}${m.skills.items.length ? ' — ' + m.skills.items.slice(0, 10).join(', ') + (m.skills.items.length > 10 ? ` +${m.skills.items.length - 10} more` : '') : ''}`,
    `Databases: ${m.databases.filter(d => d.exists).map(d => d.name).join(', ') || 'none'}`,
    `Context rules: ${m.contextRules.count}`,
    `Applications: ${m.applications?.length || 0} installed`,
    `User folders: ${(m.userFolders || []).map(f => `${f.name}(${f.itemCount})`).join(', ')}`,
  ];
  return lines.join('\n');
}

module.exports = { generateManifest, readManifest, getManifestSummary, MANIFEST_PATH };
