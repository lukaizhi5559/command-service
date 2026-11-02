const path = require('path');
const os = require('os');
const fs = require('fs');

const AGENTS_DB_PATH = path.join(os.homedir(), '.thinkdrop', 'data', 'agents.duckdb');
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

// Watchdog bound for a single serialized DB call (queue wait + callback).
// Observed: one wedged native call (duckdb callback that never fires — dead
// connection, blocked lock) holds _mutex forever and EVERY subsequent withDb
// hangs silently (/agent.list callers all timed out at 3s while the service
// answered every other endpoint fine). Bound the wait and self-heal.
const WITHDB_TIMEOUT_MS = parseInt(process.env.AGENTS_DB_TIMEOUT_MS || '10000', 10);

/**
 * Break the wedge: drop the (possibly dead) singleton + the serialized chain,
 * then close the dead handle (bounded) BEFORE reopening — a half-open old
 * connection leaves a live WAL that corrupts the fresh open. _initPromise is
 * pointed at close-then-open so concurrent callers share one recovery.
 */
function _resetDb(reason) {
  logger.warn(`agents-db: resetting connection (${reason})`);
  const dead = _dbSingleton;
  _dbSingleton = null;
  _mutex = Promise.resolve(); // abandon the wedged call — it may never settle
  _initPromise = (async () => {
    if (dead) {
      await Promise.race([dead.close().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    }
    return _openDb();
  })();
  // Side-tap: the recovery promise may reject before any caller awaits it —
  // without a handler that becomes an unhandled rejection and kills the process.
  _initPromise.catch(() => {});
}

async function _getDb() {
  if (_dbSingleton) return _dbSingleton;
  if (!_initPromise) _initPromise = _openDb();
  // A failed open must not poison the slot — clear it so the next call retries
  // (e.g. WAL replay racing a dead connection's close settles on retry).
  try {
    return await _initPromise;
  } catch (e) {
    _initPromise = null;
    throw e;
  }
}

async function _openDb() {
  const db = await (async () => {
    fs.mkdirSync(path.dirname(AGENTS_DB_PATH), { recursive: true });
    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    let db;
    // Native duckdb 1.4.x is required; duckdb-async 0.10.x cannot read DBs created by 1.4.x.
    try {
      const { Database } = require('duckdb');
      const openRaw = () => new Promise((resolve, reject) => {
        const d = new Database(AGENTS_DB_PATH, (err) => {
          if (err) reject(err);
          else resolve(d);
        });
      });
      let raw;
      try {
        raw = await openRaw();
      } catch (e1) {
        // Reopen-after-reset hits a duckdb 1.4.x in-process WAL replay bug when a
        // stale .wal outlives the dead connection ("no default database set").
        // The registry repopulates from ~/.thinkdrop/agents descriptors — drop
        // the orphaned WAL once and retry; a real lock error still fails fast.
        if (/WAL|replaying/i.test(e1.message || '')) {
          logger.warn(`agents-db: open failed on WAL replay — removing orphan .wal and retrying (${e1.message.slice(0, 120)})`);
          try { fs.unlinkSync(AGENTS_DB_PATH + '.wal'); } catch {}
          raw = await openRaw();
        } else {
          throw e1;
        }
      }
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
    // Migration: add auth tracking columns if they don't exist yet (safe on existing tables)
    const _agentCols = await db.all(`SELECT column_name FROM information_schema.columns WHERE table_name = 'agents'`).catch(() => []);
    const _colNames = (_agentCols || []).map(r => (r.column_name || r.COLUMN_NAME || '').toLowerCase());
    if (!_colNames.includes('authed_at'))      await db.run(`ALTER TABLE agents ADD COLUMN authed_at TIMESTAMP`).catch(() => {});
    if (!_colNames.includes('auth_expires_at')) await db.run(`ALTER TABLE agents ADD COLUMN auth_expires_at TIMESTAMP`).catch(() => {});
    await db.run(`CREATE TABLE IF NOT EXISTS browser_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run(`CREATE TABLE IF NOT EXISTS cli_meta_cache (
      service TEXT PRIMARY KEY, meta_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    _dbSingleton = db;
    return db;
  })();
  return db;
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
  // Watchdog: if the call (or a queued predecessor) never settles, reject the
  // caller and reset the connection so the next call rebuilds instead of
  // queuing behind a wedge forever. The timer MUST be cleared on settle —
  // an unchecked setTimeout would reset a healthy connection 10s after
  // every successful call.
  let timer;
  const watchdog = new Promise((_, rej) => {
    timer = setTimeout(() => {
      _resetDb(`withDb timed out after ${WITHDB_TIMEOUT_MS}ms`);
      rej(new Error(`agents-db: timed out after ${WITHDB_TIMEOUT_MS}ms`));
    }, WITHDB_TIMEOUT_MS);
  });
  try {
    return await Promise.race([token, watchdog]);
  } finally {
    clearTimeout(timer);
  }
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
