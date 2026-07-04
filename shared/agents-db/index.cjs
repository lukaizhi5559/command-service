const path = require('path');
const os = require('os');
const fs = require('fs');

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'agents.db');
const AGENTS_DIR = path.join(os.homedir(), '.thinkdrop', 'agents');

const logger = {
  debug: (msg) => process.env.DEBUG && console.log(`[agents-db:debug] ${msg}`),
  info: (msg) => console.log(`[agents-db] ${msg}`),
  warn: (msg) => console.warn(`[agents-db:warn] ${msg}`),
  error: (msg) => console.error(`[agents-db:error] ${msg}`),
};

// Persistent singleton — one DuckDB connection per process lifetime.
// This is intentional: DuckDB holds an exclusive OS-level file lock.
// Opening/closing on every call leaks FDs and causes "Could not set lock" errors
// when multiple callers race. A single open connection is held for the lifetime
// of this process (command-service), serialized by the mutex below.
let _dbSingleton = null;
let _initPromise = null;

// Promise-chain mutex: serializes all withDb calls within this process.
let _mutex = Promise.resolve();

async function _getDb() {
  if (_dbSingleton) return _dbSingleton;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    let db;
    // Native duckdb 1.4.x is required; duckdb-async 0.10.x cannot read DBs created by 1.4.x.
    try {
      const { Database } = require('duckdb');
      const raw = await new Promise((resolve, reject) => {
        const d = new Database(AGENTS_DB_PATH, (err) => {
          if (err) reject(err);
          else resolve(d);
        });
      });
      db = {
        run: (sql, ...p) => new Promise((res, rej) => { raw.run(sql, ...p, (e) => { if (e) rej(e); else res(); }); }),
        all: (sql, ...p) => new Promise((res, rej) => { raw.all(sql, ...p, (e, rows) => { if (e) rej(e); else res(rows); }); }),
        get: (sql, ...p) => new Promise((res, rej) => { raw.get(sql, ...p, (e, row) => { if (e) rej(e); else res(row); }); }),
        close: () => new Promise((res) => raw.close(() => res())),
      };
      logger.info('Persistent connection opened via duckdb native');
    } catch (e) {
      throw new Error(`Failed to open DuckDB with native driver: ${e.message}`);
    }

    await db.run(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'cli', service TEXT NOT NULL,
      cli_tool TEXT, capabilities TEXT, descriptor TEXT, last_validated TIMESTAMP,
      failure_log TEXT, status TEXT NOT NULL DEFAULT 'healthy', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS browser_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS cli_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    _dbSingleton = db;
    return db;
  })();

  return _initPromise;
}

/**
 * Execute a callback with the persistent DuckDB singleton.
 * Calls are serialized via a promise-chain mutex to prevent concurrent lock conflicts.
 * @param {Function} callback - Async function receiving (db) parameter
 * @returns {Promise<any>} - Result of the callback
 */
async function withDb(callback) {
  const token = _mutex.then(async () => {
    const db = await _getDb();
    return callback(db);
  });
  _mutex = token.catch(() => {});
  return token;
}

/**
 * Cleanly close the singleton connection (call from SIGTERM handler).
 */
async function closeDb() {
  if (_dbSingleton) {
    try {
      await _dbSingleton.close();
      logger.info('Persistent connection closed');
    } catch (e) {
      logger.warn(`closeDb error: ${e.message}`);
    } finally {
      _dbSingleton = null;
      _initPromise = null;
    }
  }
}

/**
 * Legacy no-op for backward compatibility.
 */
function resetDbCache() {}

module.exports = {
  withDb,
  closeDb,
  resetDbCache,
  AGENTS_DB_PATH,
  AGENTS_DIR,
};
