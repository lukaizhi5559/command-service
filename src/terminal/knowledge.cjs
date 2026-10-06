'use strict';

/**
 * terminal/knowledge.cjs — per-CLI interaction knowledge cache.
 *
 * ~/.thinkdrop/terminal-knowledge.json:
 *   { "tools": { "<tool>": { "flags": [...], "prompts": [...], "notes": [...] } } }
 *
 * Written after successful PTY-driven runs so the next run prefers known-good
 * flags and recognizes prompts it has already answered. Bounded: max 20
 * entries per list per tool, max ~200 tools (oldest evicted).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const KNOWLEDGE_PATH = path.join(os.homedir(), '.thinkdrop', 'terminal-knowledge.json');
const MAX_LIST = 20;
const MAX_TOOLS = 200;

function _load() {
  try {
    const j = JSON.parse(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
    return j.tools ? j : { tools: {} };
  } catch (_) {
    return { tools: {} };
  }
}

function _save(data) {
  try {
    fs.mkdirSync(path.dirname(KNOWLEDGE_PATH), { recursive: true });
    fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_) {}
}

function lookup(tool) {
  if (!tool) return null;
  return _load().tools[String(tool).toLowerCase()] || null;
}

function _push(list, item) {
  const l = list.filter(x => x !== item);
  l.unshift(item);
  return l.slice(0, MAX_LIST);
}

/**
 * Record knowledge for a tool.
 * @param {string} tool
 * @param {{ flags?: string[], prompt?: string, note?: string }} info
 */
function record(tool, info = {}) {
  const t = String(tool || '').toLowerCase();
  if (!t) return;
  const data = _load();
  const entry = data.tools[t] || { flags: [], prompts: [], notes: [] };
  for (const f of info.flags || []) entry.flags = _push(entry.flags, f);
  if (info.prompt) entry.prompts = _push(entry.prompts, info.prompt);
  if (info.note) entry.notes = _push(entry.notes, info.note);
  entry.updatedAt = new Date().toISOString();
  data.tools[t] = entry;
  // evict oldest beyond cap
  const names = Object.keys(data.tools);
  if (names.length > MAX_TOOLS) {
    names.sort((a, b) => String(data.tools[a].updatedAt).localeCompare(String(data.tools[b].updatedAt)));
    for (const n of names.slice(0, names.length - MAX_TOOLS)) delete data.tools[n];
  }
  _save(data);
}

/** Extract `--flag`/`--flag=value` tokens from a command line for caching. */
function extractFlags(cmd) {
  return (String(cmd || '').match(/(?:^|\s)(-{1,2}[a-zA-Z][\w-]*(?:=\S+)?)/g) || [])
    .map(s => s.trim()).slice(0, 10);
}

module.exports = { lookup, record, extractFlags, KNOWLEDGE_PATH };
