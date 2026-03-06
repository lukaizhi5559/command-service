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
const logger = require('./logger.cjs');

const MEMORY_SERVICE_PORT  = parseInt(process.env.MEMORY_SERVICE_PORT  || '3001', 10);
const COMMAND_SERVICE_PORT = parseInt(process.env.PORT                  || '3007', 10);
const SYNC_INTERVAL_MS     = 5 * 60 * 1000; // re-sync every 5 min

// Map of cronId → { job, skillName, schedule } — kept in module scope
const _jobs = new Map();

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

async function fireSkill(skillName, execPath) {
  logger.info(`[SkillScheduler] Firing scheduled skill: ${skillName}`);
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

    if (!schedule || schedule === 'on_demand') continue;

    const execPath = full?.execPath || row.execPath || path.join(os.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');
    const cronId   = `skill_${skillName.replace(/\./g, '_')}`;
    activeCronIds.add(cronId);

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
      if (existing.schedule === schedule) continue; // unchanged
      try { existing.job.stop(); } catch (_) {}
      _jobs.delete(cronId);
      logger.info(`[SkillScheduler] Rescheduled ${skillName}: ${existing.schedule} → ${schedule}`);
    }

    const job = cron.schedule(schedule, () => fireSkill(skillName, execPath), {
      scheduled: true,
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    });
    _jobs.set(cronId, { job, skillName, schedule, execPath });
    logger.info(`[SkillScheduler] Registered cron: ${skillName} @ "${schedule}"`);
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
async function registerSkill(skillName, schedule, execPath) {
  if (!skillName || !schedule || schedule === 'on_demand') return;

  const cronId = `skill_${skillName.replace(/\./g, '_')}`;
  const resolvedPath = execPath || path.join(os.homedir(), '.thinkdrop', 'skills', skillName, 'index.cjs');

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

  const job = cron.schedule(schedule, () => fireSkill(skillName, resolvedPath), {
    scheduled: true,
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
  });
  _jobs.set(cronId, { job, skillName, schedule, execPath: resolvedPath });
  logger.info(`[SkillScheduler] registerSkill: ${skillName} @ "${schedule}"`);
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
    id, skillName: e.skillName, schedule: e.schedule, execPath: e.execPath, type: 'cron',
  }));
  const windows = Array.from(_rwJobs.entries()).map(([id, e]) => ({
    id, skillName: e.skillName,
    schedule: `RANDOM_WINDOW(count=${e.rw.count},start=${e.rw.start},end=${e.rw.end},min_gap_minutes=${e.rw.minGap},days=${e.rw.days})`,
    pendingFires: e.pendingTimeouts?.length || 0, type: 'random_window',
  }));
  return [...crons, ...windows];
}

module.exports = { start, sync: syncScheduledSkills, registerSkill, unregisterSkill, listJobs, toggleSkill };
