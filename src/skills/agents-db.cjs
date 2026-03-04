'use strict';
/**
 * Shared DuckDB singleton for creator.agent and reviewer.agent.
 * Both skills import this module — Node's require cache ensures a single
 * connection to agents.db regardless of call order.
 */
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const logger = require('../logger.cjs');

const PROJECTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');

let _db   = null;
let _init = null; // Promise — prevents double-init races

async function getDb() {
  if (_db) return _db;
  if (_init) return _init;

  _init = (async () => {
    fs.mkdirSync(path.dirname(PROJECTS_DB_PATH), { recursive: true });

    try {
      const duckdbAsync = require('duckdb-async');
      _db = await duckdbAsync.Database.create(PROJECTS_DB_PATH);
    } catch {
      try {
        const { Database } = require('duckdb');
        const raw = await new Promise((resolve, reject) => {
          const db = new Database(PROJECTS_DB_PATH, (err) => { if (err) reject(err); else resolve(db); });
        });
        _db = {
          run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
          all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
          get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
          close: () => new Promise((res) => raw.close(() => res())),
        };
      } catch (e) {
        logger.warn('[agents-db] DuckDB not available:', e.message);
        _init = null;
        return null;
      }
    }

    // Migration: drop table if it was created with old TIMESTAMP DEFAULT CURRENT_TIMESTAMP schema
    try {
      const cols = await _db.all(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='projects'`);
      if (cols && cols.some(c => c.data_type === 'TIMESTAMP')) {
        logger.info('[agents-db] Migrating projects table: dropping old TIMESTAMP schema');
        await _db.run('DROP TABLE IF EXISTS projects');
      }
    } catch (_) { /* table doesn't exist yet — fine */ }

    await _db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, prompt TEXT NOT NULL, name TEXT,
      bdd_tests TEXT, agents_plan TEXT, tech_stack TEXT, prototype_path TEXT,
      reviewer_verdict TEXT DEFAULT 'pending', reviewer_notes TEXT,
      status TEXT NOT NULL DEFAULT 'planning',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    )`);

    logger.info('[agents-db] projects table ready');
    return _db;
  })();

  return _init;
}

module.exports = { getDb, PROJECTS_DB_PATH };
