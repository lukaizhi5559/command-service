/**
 * skill-db.cjs — Persistent storage for command-service skills
 *
 * HTTP client to the user-memory MCP service (port 3001).
 * Provides two APIs:
 *
 * 1. Key-Value store — arbitrary skill state, per skill+key namespace:
 *      const db = require('../skill-db.cjs');
 *      await db.set('pr-reviewer', 'last_seen_pr', '42');
 *      const val = await db.get('pr-reviewer', 'last_seen_pr');
 *      await db.del('pr-reviewer', 'last_seen_pr');
 *      const all = await db.list('pr-reviewer');
 *
 * 2. Memory store — semantic memories (same store the stategraph uses):
 *      await db.remember('pr-reviewer', 'PR #42 was reviewed and approved');
 *      const mems = await db.recall('pr-reviewer', 'open PRs needing review');
 *
 * 3. Context rules — per-site/app prompt injection rules:
 *      await db.setContextRule('grok.com', 'Use https://grok.com not x.com/i/grok');
 *      const rules = await db.getContextRules('grok.com');
 *
 * All methods return null / [] / false on error — skills should degrade gracefully.
 */

'use strict';

const http = require('http');
const logger = require('../logger.cjs');

const MEMORY_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEMORY_HOST = process.env.MEMORY_SERVICE_HOST || '127.0.0.1';
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

// ── HTTP helper ──────────────────────────────────────────────────────────────

function httpPost(path, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (MEM_API_KEY) headers['Authorization'] = `Bearer ${MEM_API_KEY}`;
    const req = http.request({
      hostname: MEMORY_HOST,
      port: MEMORY_PORT,
      path,
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', (err) => {
      logger.warn(`[skill-db] HTTP error ${path}: ${err.message}`);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

function httpGet(path, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: MEMORY_HOST,
      port: MEMORY_PORT,
      path,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', (err) => {
      logger.warn(`[skill-db] HTTP error GET ${path}: ${err.message}`);
      resolve(null);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Key-Value store ──────────────────────────────────────────────────────────
// Uses the memory store with type='skill_kv', namespace=skillName, key=key

async function set(skillName, key, value) {
  const res = await httpPost('/memory.store', {
    type: 'skill_kv',
    namespace: skillName,
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
    overwrite: true,
  });
  return res?.success !== false;
}

async function get(skillName, key) {
  const res = await httpPost('/memory.retrieve', {
    type: 'skill_kv',
    namespace: skillName,
    key,
  });
  if (!res || !res.value) return null;
  try { return JSON.parse(res.value); } catch (_) { return res.value; }
}

async function del(skillName, key) {
  const res = await httpPost('/memory.delete', {
    type: 'skill_kv',
    namespace: skillName,
    key,
  });
  return res?.success !== false;
}

async function list(skillName) {
  const res = await httpPost('/memory.list', {
    type: 'skill_kv',
    namespace: skillName,
  });
  return Array.isArray(res?.items) ? res.items : [];
}

// ── Semantic memory store ────────────────────────────────────────────────────

async function remember(skillName, text, metadata = {}) {
  const res = await httpPost('/memory.store', {
    type: 'skill_memory',
    namespace: skillName,
    value: text,
    metadata,
  });
  return res?.success !== false;
}

async function recall(skillName, query, topK = 5) {
  const res = await httpPost('/memory.search', {
    query,
    type: 'skill_memory',
    namespace: skillName,
    topK,
  });
  return Array.isArray(res?.results) ? res.results : [];
}

// ── Context rules (per-site/app LLM prompt injection) ───────────────────────

async function setContextRule(contextKey, ruleText, contextType = 'site') {
  const res = await httpPost('/context_rule.upsert', {
    version: 'mcp.v1',
    service: 'user-memory',
    action: 'context_rule.upsert',
    payload: { contextKey, ruleText, contextType },
  });
  if (res?.status !== 'ok') {
    logger.warn(`[skill-db] setContextRule failed: ${JSON.stringify(res?.error || res)?.slice(0, 120)}`);
  }
  return res?.status === 'ok';
}

async function getContextRules(contextKey) {
  const res = await httpPost('/context_rule.search', {
    version: 'mcp.v1',
    service: 'user-memory',
    action: 'context_rule.search',
    payload: { contextKeys: [contextKey] },
  });
  if (res && res.status !== 'ok') {
    logger.warn(`[skill-db] getContextRules failed: ${JSON.stringify(res?.error || res)?.slice(0, 120)}`);
  }
  const results = res?.data?.results;
  return Array.isArray(results) ? results.map(r => r.ruleText || r.rule_text || '').filter(Boolean) : [];
}

// ── Skill registry helpers ───────────────────────────────────────────────────

async function getSkill(skillName) {
  const res = await httpPost('/skill.get', { name: skillName });
  return res?.skill || null;
}

async function upsertSkill(skillData) {
  const res = await httpPost('/skill.upsert', skillData);
  return res?.success !== false;
}

module.exports = {
  // Key-value
  set, get, del, list,
  // Semantic memory
  remember, recall,
  // Context rules
  setContextRule, getContextRules,
  // Skill registry
  getSkill, upsertSkill,
};
