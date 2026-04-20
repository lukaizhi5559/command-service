'use strict';
/**
 * skill-scheduler.cjs
 *
 * Runs inside command-service as a background daemon.
 * Reads all installed skills from the user-memory MCP (port 3001),
 * and registers a node-cron job for every skill whose schedule ≠ 'on_demand'.
 *
 * When a cron fires it calls POST /command.automate on THIS service (port 3007)
 * with skill: 'external.skill' — completely decoupled from Electron.
 *
 * Re-syncs every 5 minutes so newly installed skills are picked up automatically
 * without restarting the service.
 *
 * Architecture note:
 *   Scheduling intentionally lives here (command-service MCP), NOT in main.js.
 *   This keeps StateGraph + MCP services decoupled from the Electron shell so
 *   the same scheduler works with a web app, mobile app, or headless runner.
 */

const http  = require('http');
const https = require('https');
const path  = require('path');
const os    = require('os');
const logger = require('../logger.cjs');

const MEMORY_SERVICE_PORT  = parseInt(process.env.MEMORY_SERVICE_PORT  || '3001', 10);
const COMMAND_SERVICE_PORT = parseInt(process.env.PORT                  || '3007', 10);
const SYNC_INTERVAL_MS     = 5 * 60 * 1000; // re-sync every 5 min

// Map of cronId → { job, skillName, schedule } — kept in module scope
const _jobs = new Map();

// ── Bridge retry persistence ──────────────────────────────────────────────────
// Pending bridge retries are written to disk so they survive process restarts.
// Each entry: { skillName, metadata, retryCount, fireAtMs }
const BRIDGE_PENDING_FILE = path.join(os.homedir(), '.thinkdrop', 'bridge-pending.json');

function loadBridgePending() {
  const fs = require('fs');
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_PENDING_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveBridgePending(entries) {
  const fs = require('fs');
  try {
    fs.mkdirSync(path.join(os.homedir(), '.thinkdrop'), { recursive: true });
    fs.writeFileSync(BRIDGE_PENDING_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[SkillScheduler] saveBridgePending failed: ${err.message}`);
  }
}

function addBridgePending(skillName, metadata, retryCount, fireAtMs) {
  // One entry per skill — replace any existing entry for the same skill
  const entries = loadBridgePending().filter(e => e.skillName !== skillName);
  entries.push({ skillName, metadata, retryCount, fireAtMs });
  saveBridgePending(entries);
}

function removeBridgePending(skillName) {
  const entries = loadBridgePending().filter(e => e.skillName !== skillName);
  saveBridgePending(entries);
}

// On startup: reload any pending bridge retries that survived a process restart.
function reloadBridgePendingRetries() {
  const entries = loadBridgePending();
  if (!entries.length) return;
  logger.info(`[SkillScheduler] Reloading ${entries.length} persisted bridge retry(ies)`);
  const now = Date.now();
  for (const entry of entries) {
    const { skillName, metadata, retryCount, fireAtMs } = entry;
    const delay = Math.max(0, fireAtMs - now);
    logger.info(`[SkillScheduler] bridge retry restored: ${skillName} fires in ${Math.round(delay / 60000)}min (retry=${retryCount})`);
    setTimeout(() => {
      removeBridgePending(skillName);
      fireBridgeSkill(skillName, metadata, retryCount, false);
    }, delay);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

function mcpPost(port, apiPath, payload, action) {
  return new Promise((resolve) => {
    // user-memory (port 3001) requires full MCP envelope + auth header
    const isMemPort = (port === MEMORY_SERVICE_PORT);
    const envelope = isMemPort
      ? { version: 'mcp.v1', service: 'user-memory', action: action || apiPath.replace('/', ''), payload, requestId: `sched-${Date.now()}` }
      : { payload, requestId: `sched-${Date.now()}` };
    const body = JSON.stringify(envelope);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(isMemPort && MEM_API_KEY ? { 'Authorization': `Bearer ${MEM_API_KEY}` } : {}),
    };
    const req = http.request({
      hostname: '127.0.0.1', port, path: apiPath, method: 'POST',
      headers, timeout: 8000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function parseFrontmatter(contractMd) {
  const fm = {};
  const match = (contractMd || '').match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return fm;
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) fm[key] = val;
  }
  return fm;
}

// ── RANDOM_WINDOW pattern support ─────────────────────────────────────────────
// Format: RANDOM_WINDOW(count=N,start=HH:MM,end=HH:MM,min_gap_minutes=M,days=DOW)
// Example: RANDOM_WINDOW(count=3,start=08:00,end=17:00,min_gap_minutes=30,days=1-5)
// Each day at midnight we compute N random fire times within the window and
// schedule one-shot timeouts for them. The midnight cron recomputes daily.

function parseRandomWindow(schedule) {
  if (!schedule || !schedule.startsWith('RANDOM_WINDOW(')) return null;
  const inner = schedule.slice('RANDOM_WINDOW('.length, -1);
  const params = {};
  for (const part of inner.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    params[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return {
    count:      parseInt(params.count || '1', 10),
    start:      params.start  || '08:00',
    end:        params.end    || '22:00',
    minGap:     parseInt(params.min_gap_minutes || '30', 10),
    days:       params.days   || '*',   // DOW string: *, 1-5, 0,6, etc.
  };
}

function todayMatchesDow(dowSpec) {
  if (!dowSpec || dowSpec === '*') return true;
  const today = new Date().getDay(); // 0=Sun, 6=Sat
  // Expand ranges like "1-5" and lists like "1,3,5"
  const parts = dowSpec.split(',');
  for (const part of parts) {
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (today >= lo && today <= hi) return true;
    } else if (parseInt(part, 10) === today) {
      return true;
    }
  }
  return false;
}

function computeRandomFireTimes(rw) {
  const [startH, startM] = rw.start.split(':').map(Number);
  const [endH,   endM  ] = rw.end.split(':').map(Number);
  const windowStartMin = startH * 60 + startM;
  const windowEndMin   = endH   * 60 + endM;
  const windowMin      = windowEndMin - windowStartMin;
  const minGap         = rw.minGap;
  const count          = rw.count;

  if (windowMin <= 0 || count <= 0) return [];

  const picks = [];
  let attempts = 0;
  while (picks.length < count && attempts < 1000) {
    attempts++;
    const candidate = windowStartMin + Math.floor(Math.random() * windowMin);
    const tooClose = picks.some(p => Math.abs(p - candidate) < minGap);
    if (!tooClose) picks.push(candidate);
  }
  picks.sort((a, b) => a - b);
  return picks; // array of minutes-since-midnight
}

// Map of randomWindowId → daily recompute cron job
const _rwJobs = new Map();

function registerRandomWindow(cronId, skillName, execPath, rw) {
  let cron;
  try { cron = require('node-cron'); } catch (_) { return; }

  // Stop existing daily recompute job if any
  if (_rwJobs.has(cronId)) {
    try { _rwJobs.get(cronId).dailyJob.stop(); } catch (_) {}
    // Cancel pending fire timeouts
    for (const t of (_rwJobs.get(cronId).pendingTimeouts || [])) clearTimeout(t);
    _rwJobs.delete(cronId);
  }

  function scheduleTodayFires() {
    if (!todayMatchesDow(rw.days)) return [];
    const fireTimes = computeRandomFireTimes(rw);
    const now       = new Date();
    const nowMin    = now.getHours() * 60 + now.getMinutes();
    const timeouts  = [];

    for (const fireMin of fireTimes) {
      const delayMin = fireMin - nowMin;
      if (delayMin <= 0) continue; // already passed today
      const delayMs = delayMin * 60 * 1000 - now.getSeconds() * 1000;
      const t = setTimeout(() => fireSkill(skillName, execPath), delayMs);
      timeouts.push(t);
      const hh = String(Math.floor(fireMin / 60)).padStart(2, '0');
      const mm = String(fireMin % 60).padStart(2, '0');
      logger.info(`[SkillScheduler] RANDOM_WINDOW ${skillName}: fire at ${hh}:${mm} (${Math.round(delayMs / 60000)}min)`);
    }
    return timeouts;
  }

  // Schedule fires for today immediately
  let pendingTimeouts = scheduleTodayFires();

  // Recompute at midnight every day
  const dailyJob = cron.schedule('0 0 * * *', () => {
    for (const t of pendingTimeouts) clearTimeout(t);
    pendingTimeouts = scheduleTodayFires();
    if (_rwJobs.has(cronId)) _rwJobs.get(cronId).pendingTimeouts = pendingTimeouts;
  }, { scheduled: true });

  _rwJobs.set(cronId, { dailyJob, pendingTimeouts, skillName, rw });
  logger.info(`[SkillScheduler] RANDOM_WINDOW registered: ${skillName} count=${rw.count} ${rw.start}-${rw.end} gap=${rw.minGap}min days=${rw.days}`);
}

// ── Fire a scheduled skill ────────────────────────────────────────────────────

// ── Tier: notify ─────────────────────────────────────────────────────────────
// Fires an osascript display notification directly — no external.skill, no HTTP.
function fireNotifySkill(skillName, metadata) {
  const { execSync } = require('child_process');
  const msg   = (metadata.message || `ThinkDrop: ${skillName}`).replace(/"/g, '\\"');
  const title = (metadata.title   || 'ThinkDrop Reminder').replace(/"/g, '\\"');
  try {
    execSync(`osascript -e 'display notification "${msg}" with title "${title}" sound name "Glass"'`);
    logger.info(`[SkillScheduler] notify fired: ${skillName}`);
  } catch (err) {
    logger.warn(`[SkillScheduler] notify osascript failed for ${skillName}: ${err.message}`);
  }
}

// ── Tier: bridge helpers ──────────────────────────────────────────────────────

// Query the Electron overlay server to check if the user is actively working.
// Falls back to false (treat as idle) on any connection error so tasks never get lost.
function checkUserActivity() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: OVERLAY_PORT, path: '/activity', method: 'GET',
      timeout: 2000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)?.active === true); } catch (_) { resolve(false); }
      });
    });
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Append a WS:INSTRUCTION block to bridge.md so Electron's bridge watcher picks it up.
function writeBridgeInstruction(skillName, instruction) {
  const fs = require('fs');
  const bridgePath = path.join(os.homedir(), '.thinkdrop', 'bridge.md');
  const blockId    = `sched_${skillName.replace(/\./g, '_')}_${Date.now()}`;
  const block = `\n<!-- WS:INSTRUCTION id="${blockId}" status="pending" -->\n${instruction}\n<!-- WS:END -->\n`;
  try {
    fs.appendFileSync(bridgePath, block, 'utf8');
    logger.info(`[SkillScheduler] bridge instruction written: ${blockId}`);
  } catch (err) {
    logger.error(`[SkillScheduler] writeBridgeInstruction failed for ${skillName}: ${err.message}`);
  }
}

// ── Tier: bridge ──────────────────────────────────────────────────────────────
// Checks user activity before writing to bridge.md. If active, defers up to 3
// times at 10-min intervals with a soft "will run soon" notification. After 3
// retries (or if immediately idle), fires unconditionally so no task is lost.
// Ask the Electron overlay to show a "Run now / Later" dialog for a deferred bridge skill.
// Returns: 'run_now' | 'defer' | 'timeout' (on error fallback → treat as defer)
async function askBridgeConfirm(skillName, instruction, retryCount, schedule) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ skillName, instruction, retryCount, schedule });
    const req = http.request({
      hostname: '127.0.0.1', port: OVERLAY_PORT, path: '/bridge/confirm', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 65000, // dialog can wait up to ~60s for user to respond
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)?.action || 'defer'); } catch (_) { resolve('defer'); }
      });
    });
    req.on('error',   () => resolve('defer'));
    req.on('timeout', () => { req.destroy(); resolve('defer'); });
    req.write(body);
    req.end();
  });
}

async function fireBridgeSkill(skillName, metadata, retryCount = 0, forced = false) {
  // forced=true skips activity check (used by Run now — user explicitly triggered it)
  if (!forced) {
    const active = await checkUserActivity();
    if (active && retryCount < 3) {
      logger.info(`[SkillScheduler] bridge deferred (user active) retry=${retryCount + 1}/3: ${skillName} — showing confirm dialog`);
      const action = await askBridgeConfirm(skillName, metadata.instruction || skillName, retryCount, metadata.schedule || null);
      if (action === 'run_now') {
        // User clicked "Run Now" — force fire immediately (dialog already handled it via /skill.fire)
        // The /bridge/confirm handler already called /skill.fire with forced:true, so we're done.
        logger.info(`[SkillScheduler] bridge confirm: user chose Run Now for ${skillName}`);
        removeBridgePending(skillName);
        return;
      }
      // User chose "Later" — persist retry to disk so it survives process restarts
      const fireAtMs = Date.now() + 10 * 60 * 1000;
      addBridgePending(skillName, metadata, retryCount + 1, fireAtMs);
      logger.info(`[SkillScheduler] bridge confirm: user deferred ${skillName}, retrying in 10min (persisted)`);
      setTimeout(() => {
        removeBridgePending(skillName);
        fireBridgeSkill(skillName, metadata, retryCount + 1, false);
      }, 10 * 60 * 1000);
      return;
    }
  }
  // Task is firing — clear any pending-retry entry
  removeBridgePending(skillName);
  writeBridgeInstruction(skillName, metadata.instruction || skillName);
}

// ── Tier dispatch ─────────────────────────────────────────────────────────────
async function fireSkill(skillName, execPath, metadata = {}) {
  const type = metadata.type || 'script';
  logger.info(`[SkillScheduler] Firing scheduled skill: ${skillName} (type=${type})`);

  if (type === 'notify') {
    fireNotifySkill(skillName, metadata);
    return;
  }

  if (type === 'bridge') {
    await fireBridgeSkill(skillName, metadata, 0, metadata.forced === true);
    return;
  }

  // Default: script tier — route through external.skill
  try {
    // /command.automate expects { payload: { skill, args } } — not bare { skill, args }
    const result = await mcpPost(COMMAND_SERVICE_PORT, '/command.automate', {
      skill: 'external.skill',
      args: { name: skillName, skillPath: execPath },
    });
    if (result?.data?.success === false) {
      logger.warn(`[SkillScheduler] Skill run failed: ${skillName}`, { error: result?.data?.error });
    } else {
      logger.info(`[SkillScheduler] Skill run ok: ${skillName}`);
    }
  } catch (err) {
    logger.error(`[SkillScheduler] Error firing skill ${skillName}: ${err.message}`);
  }
}

// ── Sync scheduled skills from user-memory MCP ───────────────────────────────

async function syncScheduledSkills() {
  let cron;
  try {
    cron = require('node-cron');
  } catch (err) {
    logger.warn('[SkillScheduler] node-cron not available — scheduler disabled', { error: err.message });
    return;
  }

  // 1. List all installed skills
  const listRes = await mcpPost(MEMORY_SERVICE_PORT, '/skill.list', {}, 'skill.list');
  const listRows = listRes?.data?.results || listRes?.result?.results || [];

  if (!listRows.length) {
    logger.debug('[SkillScheduler] No installed skills found');
    return;
  }

  // Track which cronIds are still valid this cycle
  const activeCronIds = new Set();

  for (const row of listRows) {
    const skillName = row.name;
    if (!skillName) continue;

    // 2. Fetch full skill to get contract_md with schedule
    const getRes = await mcpPost(MEMORY_SERVICE_PORT, '/skill.get', { name: skillName }, 'skill.get');
    const full = getRes?.data || null;
    const fm = parseFrontmatter(full?.contractMd || '');
    const schedule = fm.schedule || 'on_demand';

    if (!schedule || schedule === 'on_demand' || schedule === 'null' || schedule === 'false' || schedule === 'none') continue;

    const execPath = full?.execPath || row.execPath || path.join(os.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');
    const cronId   = `skill_${skillName.replace(/\./g, '_')}`;
    activeCronIds.add(cronId);

    // ── Parse tier metadata from frontmatter ───────────────────────────────
    const skillType    = fm.type        || 'script';
    const notifMessage = fm.message     || `ThinkDrop: ${skillName}`;
    const notifTitle   = fm.title       || 'ThinkDrop Reminder';
    const instruction  = fm.instruction || '';
    // Bridge skills are scheduled intentionally — always fire without confirm dialog.
    const metadata     = { type: skillType, message: notifMessage, title: notifTitle, instruction, schedule, ...(skillType === 'bridge' ? { forced: true } : {}) };

    // ── RANDOM_WINDOW pattern ───────────────────────────────────────────────
    const rw = parseRandomWindow(schedule);
    if (rw) {
      const existing = _rwJobs.get(cronId);
      if (!existing || JSON.stringify(existing.rw) !== JSON.stringify(rw)) {
        registerRandomWindow(cronId, skillName, execPath, rw);
      }
      continue;
    }

    // ── Standard cron expression ───────────────────────────────────────────
    if (!cron.validate(schedule)) {
      logger.warn(`[SkillScheduler] Invalid schedule for ${skillName}: "${schedule}" — skipping`);
      continue;
    }

    if (_jobs.has(cronId)) {
      const existing = _jobs.get(cronId);
      if (existing.schedule === schedule && existing.type === skillType) continue; // unchanged
      try { existing.job.stop(); } catch (_) {}
      _jobs.delete(cronId);
      logger.info(`[SkillScheduler] Rescheduled ${skillName}: ${existing.schedule} → ${schedule}`);
    }

    const job = cron.schedule(schedule, () => fireSkill(skillName, execPath, metadata), {
      scheduled: true,
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    });
    _jobs.set(cronId, { job, skillName, schedule, execPath, ...metadata });
    logger.info(`[SkillScheduler] Registered cron: ${skillName} @ "${schedule}" (type=${skillType})`);
  }

  // 3. Stop jobs for skills that were uninstalled
  for (const [cronId, entry] of _jobs.entries()) {
    if (!activeCronIds.has(cronId)) {
      try { entry.job.stop(); } catch (_) {}
      _jobs.delete(cronId);
      logger.info(`[SkillScheduler] Removed cron for uninstalled skill: ${entry.skillName}`);
    }
  }
  for (const [cronId, entry] of _rwJobs.entries()) {
    if (!activeCronIds.has(cronId)) {
      try { entry.dailyJob.stop(); } catch (_) {}
      for (const t of (entry.pendingTimeouts || [])) clearTimeout(t);
      _rwJobs.delete(cronId);
      logger.info(`[SkillScheduler] Removed RANDOM_WINDOW for uninstalled skill: ${entry.skillName}`);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the scheduler daemon.
 * Called once from server.cjs on startup.
 */
async function start() {
  logger.info('[SkillScheduler] Starting skill scheduler daemon');

  // Reload any bridge retries that were deferred before a process restart
  reloadBridgePendingRetries();

  // Initial sync after a short delay to let services come up
  setTimeout(async () => {
    await syncScheduledSkills();
  }, 12000);

  // Re-sync on interval to pick up newly installed skills
  setInterval(async () => {
    try {
      await syncScheduledSkills();
    } catch (err) {
      logger.warn(`[SkillScheduler] Re-sync failed (non-fatal): ${err.message}`);
    }
  }, SYNC_INTERVAL_MS);
}

/**
 * Immediately register or refresh a single skill's cron job.
 * Called by skillCreator after installing a scheduled skill.
 */
async function registerSkill(skillName, schedule, execPath, metadata = {}) {
  if (!skillName || !schedule || schedule === 'on_demand') return;

  const cronId = `skill_${skillName.replace(/\./g, '_')}`;
  const resolvedPath = execPath || path.join(os.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');
  const skillType    = metadata.type        || 'script';
  const notifMessage = metadata.message     || `ThinkDrop: ${skillName}`;
  const notifTitle   = metadata.title       || 'ThinkDrop Reminder';
  const instruction  = metadata.instruction || '';
  // Bridge skills are scheduled intentionally — always fire without confirm dialog.
  const fullMeta     = { type: skillType, message: notifMessage, title: notifTitle, instruction, schedule, ...(skillType === 'bridge' ? { forced: true } : {}) };

  // ── RANDOM_WINDOW pattern ─────────────────────────────────────────────────
  const rw = parseRandomWindow(schedule);
  if (rw) {
    registerRandomWindow(cronId, skillName, resolvedPath, rw);
    return;
  }

  // ── Standard cron expression ──────────────────────────────────────────────
  let cron;
  try { cron = require('node-cron'); } catch (_) { return; }
  if (!cron.validate(schedule)) {
    logger.warn(`[SkillScheduler] registerSkill: invalid cron "${schedule}" for ${skillName}`);
    return;
  }

  if (_jobs.has(cronId)) {
    try { _jobs.get(cronId).job.stop(); } catch (_) {}
    _jobs.delete(cronId);
  }

  const job = cron.schedule(schedule, () => fireSkill(skillName, resolvedPath, fullMeta), {
    scheduled: true,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  });
  _jobs.set(cronId, { job, skillName, schedule, execPath: resolvedPath, ...fullMeta });
  logger.info(`[SkillScheduler] registerSkill: ${skillName} @ "${schedule}" (type=${skillType})`);
}

/**
 * Remove a skill's cron job (called on skill uninstall).
 */
function unregisterSkill(skillName) {
  const cronId = `skill_${skillName.replace(/\./g, '_')}`;
  if (_jobs.has(cronId)) {
    try { _jobs.get(cronId).job.stop(); } catch (_) {}
    _jobs.delete(cronId);
    logger.info(`[SkillScheduler] Unregistered cron: ${skillName}`);
  }
  if (_rwJobs.has(cronId)) {
    try { _rwJobs.get(cronId).dailyJob.stop(); } catch (_) {}
    for (const t of (_rwJobs.get(cronId).pendingTimeouts || [])) clearTimeout(t);
    _rwJobs.delete(cronId);
    logger.info(`[SkillScheduler] Unregistered RANDOM_WINDOW: ${skillName}`);
  }
}

/**
 * Pause or resume a skill's cron job.
 * action: 'pause' | 'resume'
 */
function toggleSkill(skillName, action) {
  const cronId = `skill_${skillName.replace(/\./g, '_')}`;
  const entry = _jobs.get(cronId);
  if (entry) {
    try {
      if (action === 'pause') { entry.job.stop();  entry.paused = true;  }
      else                    { entry.job.start(); entry.paused = false; }
      logger.info(`[SkillScheduler] ${action} cron: ${skillName}`);
    } catch (e) {
      logger.warn(`[SkillScheduler] toggleSkill failed for ${skillName}: ${e.message}`);
    }
  }
  // RANDOM_WINDOW: just cancel/reschedule pending timeouts
  const rwEntry = _rwJobs.get(cronId);
  if (rwEntry) {
    if (action === 'pause') {
      for (const t of (rwEntry.pendingTimeouts || [])) clearTimeout(t);
      rwEntry.pendingTimeouts = [];
      rwEntry.paused = true;
      logger.info(`[SkillScheduler] pause RANDOM_WINDOW: ${skillName}`);
    } else {
      rwEntry.paused = false;
      // Re-schedule today's remaining fires
      const rw = rwEntry.rw;
      const execPath = rwEntry.execPath || path.join(os.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');
      registerRandomWindow(cronId, skillName, execPath, rw);
      logger.info(`[SkillScheduler] resume RANDOM_WINDOW: ${skillName}`);
    }
  }
}

/**
 * List all active scheduled jobs (for status/debug).
 */
function listJobs() {
  const crons = Array.from(_jobs.entries()).map(([id, e]) => ({
    id, skillName: e.skillName, schedule: e.schedule, execPath: e.execPath,
    type: e.type || 'script', cronType: 'cron',
  }));
  const windows = Array.from(_rwJobs.entries()).map(([id, e]) => ({
    id, skillName: e.skillName,
    schedule: `RANDOM_WINDOW(count=${e.rw.count},start=${e.rw.start},end=${e.rw.end},min_gap_minutes=${e.rw.minGap},days=${e.rw.days})`,
    pendingFires: e.pendingTimeouts?.length || 0, type: 'random_window',
  }));
  return [...crons, ...windows];
}

// ── One-shot reminders ────────────────────────────────────────────────────────
// Registered by executeCommand's schedule pseudo-skill instead of blocking.
// When the timer fires, POSTs to the Electron overlay (port 3010) which routes
// to notification/TTS (notify intent) or stategraph re-run (command_automate).
//
// Reminder shape: { id, label, triggerIntent, triggerPrompt, pendingSteps, targetMs, timeout, createdAt }
const _reminders = new Map();

const OVERLAY_PORT = parseInt(process.env.OVERLAY_PORT || '3010', 10);

function fireReminder(reminder) {
  logger.info(`[SkillScheduler] 🔔 Reminder fired: "${reminder.label}" (intent=${reminder.triggerIntent})`);
  _reminders.delete(reminder.id);

  // POST to Electron overlay — main.js listens on /reminder/fire
  const firePayload = {
    id: reminder.id,
    label: reminder.label,
    triggerIntent: reminder.triggerIntent,
    triggerPrompt: reminder.triggerPrompt,
    firedAt: new Date().toISOString(),
  };
  if (reminder.pendingSteps) firePayload.pendingSteps = reminder.pendingSteps;
  const payload = JSON.stringify(firePayload);
  const req = http.request({
    hostname: '127.0.0.1',
    port: OVERLAY_PORT,
    path: '/reminder/fire',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 5000,
  }, (res) => {
    let raw = '';
    res.on('data', c => { raw += c; });
    res.on('end', () => logger.info(`[SkillScheduler] Reminder fire POST → ${res.statusCode}`));
  });
  req.on('error', (e) => logger.warn(`[SkillScheduler] Reminder fire POST failed: ${e.message}`));
  req.on('timeout', () => { req.destroy(); });
  req.write(payload);
  req.end();
}

/**
 * Register a one-shot reminder.
 * @param {object} opts
 * @param {string} opts.id           — unique ID (e.g. "reminder_1773485200000")
 * @param {number} opts.delayMs      — ms from now until fire
 * @param {string} opts.label        — human-readable label ("Check the oven")
 * @param {string} opts.triggerIntent — "notify" (show dialog only) or "execute_steps" (run pendingSteps via command-service)
 * @param {string} opts.triggerPrompt — clean human-readable message shown in the dialog/notification
 * @param {string|null} opts.pendingSteps — JSON-serialized array of plan steps to execute when reminder fires
 * @returns {{ id, targetMs }}
 */
function registerReminder({ id, delayMs, label, triggerIntent = 'notify', triggerPrompt = '', pendingSteps = null }) {
  // Cancel existing reminder with same ID if any
  if (_reminders.has(id)) {
    clearTimeout(_reminders.get(id).timeout);
    _reminders.delete(id);
  }

  const targetMs = Date.now() + delayMs;
  const reminder = {
    id,
    label: label || 'Reminder',
    triggerIntent,
    triggerPrompt: triggerPrompt || label || 'Reminder',
    pendingSteps: pendingSteps || null,
    targetMs,
    createdAt: Date.now(),
    timeout: null,
  };

  reminder.timeout = setTimeout(() => fireReminder(reminder), delayMs);
  _reminders.set(id, reminder);

  const targetTime = new Date(targetMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  logger.info(`[SkillScheduler] Reminder registered: "${label}" fires at ${targetTime} (${Math.round(delayMs / 1000)}s, intent=${triggerIntent})`);
  return { id, targetMs };
}

/**
 * Cancel a pending reminder by ID.
 */
function cancelReminder(id) {
  const entry = _reminders.get(id);
  if (entry) {
    clearTimeout(entry.timeout);
    _reminders.delete(id);
    logger.info(`[SkillScheduler] Reminder cancelled: ${id}`);
    return true;
  }
  return false;
}

/**
 * List all pending reminders (for Cron tab display).
 */
function listReminders() {
  return Array.from(_reminders.values()).map(r => ({
    id: r.id,
    label: r.label,
    triggerIntent: r.triggerIntent,
    triggerPrompt: r.triggerPrompt,
    targetMs: r.targetMs,
    remainingMs: Math.max(0, r.targetMs - Date.now()),
    createdAt: r.createdAt,
    type: 'reminder',
  }));
}

/**
 * Immediately fire a scheduled skill by name (used by "Run now" in Cron tab).
 * Looks up the live _jobs entry so bridge/notify/script type is respected.
 * If the skill is not yet in _jobs (e.g. just installed), syncs first then fires.
 */
async function runSkillNow(skillName, forced = true) {
  let entry = _jobs.get(`skill_${skillName.replace(/\./g, '_')}`);
  if (!entry) {
    // Skill may have just been installed — force a sync then retry once
    await syncScheduledSkills();
    entry = _jobs.get(`skill_${skillName.replace(/\./g, '_')}`);
  }
  if (!entry) {
    // Not a cron skill — check random window jobs
    const rwEntry = _rwJobs.get(`skill_${skillName.replace(/\./g, '_')}`);
    if (rwEntry) {
      await fireSkill(skillName, rwEntry.execPath || '', { type: rwEntry.type || 'script', message: rwEntry.message, title: rwEntry.title, instruction: rwEntry.instruction, forced });
      return { ok: true };
    }
    return { ok: false, error: `Skill "${skillName}" is not registered in the scheduler. Make sure it has a valid cron schedule.` };
  }
  // forced:true — Run now bypasses the activity check so bridge tasks fire immediately
  await fireSkill(skillName, entry.execPath, { type: entry.type, message: entry.message, title: entry.title, instruction: entry.instruction, forced });
  return { ok: true };
}

module.exports = { start, sync: syncScheduledSkills, registerSkill, unregisterSkill, listJobs, toggleSkill, registerReminder, cancelReminder, listReminders, runSkillNow };
