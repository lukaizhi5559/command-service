'use strict';

/**
 * skill: system.introspect
 *
 * Self-awareness queries — lets ThinkDrop answer questions about its own state:
 *   - agents:        count + list of CLI and browser agents
 *   - skills:        installed external skills
 *   - databases:     DuckDB table counts across all stores
 *   - context_rules: learned rules grouped by agent
 *   - workspace:     ~/.thinkdrop directory listing
 *
 * Args: { query: string }
 *   query is one of: 'agents' | 'skills' | 'databases' | 'context_rules' | 'workspace' | 'all'
 *
 * Returns: { ok: true, query, result: {...} }
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const logger = require('../logger.cjs');
const { withDb } = require('@thinkdrop/agents-db');

const THINKDROP_DIR = path.join(os.homedir(), '.thinkdrop');
const AGENTS_DB_PATH = path.join(THINKDROP_DIR, 'agents.db');
const SKILLS_DIR = path.join(THINKDROP_DIR, 'skills');
const AGENTS_DIR = path.join(THINKDROP_DIR, 'agents');

// Lazy DuckDB loader — tries duckdb-async first, then duckdb
let _duckdb = null;
async function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  if (!_duckdb) {
    try { _duckdb = require('duckdb-async'); } catch {
      try { _duckdb = require('duckdb'); } catch { return null; }
    }
  }
  try {
    if (_duckdb.Database?.create) {
      return await _duckdb.Database.create(dbPath, { access_mode: 'READ_ONLY' });
    }
    // Sync duckdb fallback
    return await new Promise((resolve, reject) => {
      const db = new _duckdb.Database(dbPath, { access_mode: 'READ_ONLY' }, (err) => {
        if (err) reject(err); else resolve(db);
      });
    });
  } catch (e) {
    logger.debug(`[system.introspect] Failed to open ${dbPath}: ${e.message}`);
    return null;
  }
}

async function dbAll(db, sql) {
  if (!db) return [];
  try {
    if (typeof db.all === 'function' && db.all.constructor?.name === 'AsyncFunction') {
      return await db.all(sql);
    }
    return await new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => { if (err) reject(err); else resolve(rows || []); });
    });
  } catch { return []; }
}

async function closeDb(db) {
  if (!db) return;
  try {
    if (typeof db.close === 'function') {
      if (db.close.constructor?.name === 'AsyncFunction') await db.close();
      else db.close(() => {});
    }
  } catch {}
}

// ── Query handlers ───────────────────────────────────────────────────────────

async function queryAgents() {
  // Use withDb from agents-db.cjs to ensure proper connection management
  try {
    return await withDb(async (db) => {
      const rows = await db.all("SELECT id, type, service, cli_tool, status, last_validated FROM agents ORDER BY created_at DESC");
      return {
        count: rows.length,
        agents: rows.map(r => ({
          id: r.id,
          type: r.type,
          service: r.service,
          cliTool: r.cli_tool,
          status: r.status,
          lastValidated: r.last_validated,
        })),
      };
    });
  } catch (e) {
    logger.warn(`[system.introspect] Failed to query agents: ${e.message}`);
    // Fallback: read .md files from agents dir
    if (!fs.existsSync(AGENTS_DIR)) return { count: 0, agents: [] };
    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));
    return { count: files.length, agents: files.map(f => ({ id: f.replace('.md', ''), source: 'file' })) };
  }
}

async function querySkills() {
  if (!fs.existsSync(SKILLS_DIR)) return { count: 0, skills: [] };
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contractPath = path.join(SKILLS_DIR, entry.name, 'contract.md');
    const indexPath = path.join(SKILLS_DIR, entry.name, 'index.cjs');
    skills.push({
      name: entry.name,
      hasContract: fs.existsSync(contractPath),
      hasIndex: fs.existsSync(indexPath),
    });
  }
  return { count: skills.length, skills };
}

async function queryDatabases() {
  // Use withDb for agents.db (single source of truth), openDb for others
  const otherDbFiles = [
    { name: 'user_memory.duckdb', path: path.resolve(__dirname, '../../..', 'thinkdrop-user-memory-service/data/user_memory.duckdb') },
    { name: 'conversation.duckdb', path: path.resolve(__dirname, '../../..', 'conversation-service/data/conversation.duckdb') },
  ];

  const results = [];

  // Handle agents.db using withDb (single source of truth)
  if (fs.existsSync(AGENTS_DB_PATH)) {
    try {
      const agentsResult = await withDb(async (db) => {
        const tables = await db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
        const tableDetails = [];
        for (const t of tables) {
          const name = t.table_name;
          const countRows = await db.all(`SELECT COUNT(*) as cnt FROM "${name}"`);
          tableDetails.push({ name, rowCount: countRows[0]?.cnt ?? 0 });
        }
        return { name: 'agents.db', exists: true, tables: tableDetails };
      });
      results.push(agentsResult);
    } catch (e) {
      logger.warn(`[system.introspect] Failed to query agents.db: ${e.message}`);
      results.push({ name: 'agents.db', exists: true, tables: [], error: e.message });
    }
  } else {
    results.push({ name: 'agents.db', exists: false, tables: [] });
  }

  // Handle other databases using openDb/closeDb
  for (const dbFile of otherDbFiles) {
    if (!fs.existsSync(dbFile.path)) {
      results.push({ name: dbFile.name, exists: false, tables: [] });
      continue;
    }
    const db = await openDb(dbFile.path);
    if (!db) {
      results.push({ name: dbFile.name, exists: true, tables: [], error: 'could not open' });
      continue;
    }
    try {
      const tables = await dbAll(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'");
      const tableDetails = [];
      for (const t of tables) {
        const name = t.table_name;
        const countRows = await dbAll(db, `SELECT COUNT(*) as cnt FROM "${name}"`);
        tableDetails.push({ name, rowCount: countRows[0]?.cnt ?? 0 });
      }
      results.push({ name: dbFile.name, exists: true, tables: tableDetails });
    } finally { await closeDb(db); }
  }
  return { databases: results };
}

async function queryContextRules() {
  try {
    const skillDb = require('../skill-helpers/skill-db.cjs');
    if (typeof skillDb.listAllContextRules === 'function') {
      const all = await skillDb.listAllContextRules();
      return { count: all.length, rules: all };
    }
    // Fallback: no listAll, just return empty
    return { count: 0, rules: [], note: 'listAllContextRules not available' };
  } catch (e) {
    return { count: 0, rules: [], error: e.message };
  }
}

async function queryWorkspace() {
  if (!fs.existsSync(THINKDROP_DIR)) return { exists: false, entries: [] };
  const entries = [];
  const items = fs.readdirSync(THINKDROP_DIR, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(THINKDROP_DIR, item.name);
    if (item.isDirectory()) {
      try {
        const sub = fs.readdirSync(fullPath);
        entries.push({ name: item.name, type: 'dir', itemCount: sub.length });
      } catch {
        entries.push({ name: item.name, type: 'dir', itemCount: '?' });
      }
    } else {
      try {
        const stat = fs.statSync(fullPath);
        entries.push({ name: item.name, type: 'file', sizeBytes: stat.size });
      } catch {
        entries.push({ name: item.name, type: 'file' });
      }
    }
  }
  return { exists: true, path: THINKDROP_DIR, entries };
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function systemIntrospect(args = {}) {
  const { query } = args;
  if (!query) {
    return { ok: false, error: 'query is required. Valid: agents | skills | databases | context_rules | workspace | all' };
  }

  const q = query.toLowerCase().trim();
  logger.info(`[system.introspect] query="${q}"`);

  try {
    switch (q) {
      case 'agents':
        return { ok: true, query: q, result: await queryAgents() };
      case 'skills':
        return { ok: true, query: q, result: await querySkills() };
      case 'databases':
        return { ok: true, query: q, result: await queryDatabases() };
      case 'context_rules':
        return { ok: true, query: q, result: await queryContextRules() };
      case 'workspace':
        return { ok: true, query: q, result: await queryWorkspace() };
      case 'all': {
        const [agents, skills, databases, contextRules, workspace] = await Promise.all([
          queryAgents(), querySkills(), queryDatabases(), queryContextRules(), queryWorkspace(),
        ]);
        return { ok: true, query: q, result: { agents, skills, databases, contextRules, workspace } };
      }
      default:
        return { ok: false, error: `Unknown introspection query: "${q}". Valid: agents | skills | databases | context_rules | workspace | all` };
    }
  } catch (e) {
    logger.error(`[system.introspect] Error: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = { systemIntrospect };
