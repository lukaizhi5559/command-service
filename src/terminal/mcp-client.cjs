'use strict';

/**
 * terminal/mcp-client.cjs — external MCP (Model Context Protocol) client.
 *
 * ThinkDrop's internal services speak an `mcp.v1` HTTP envelope — this is
 * DIFFERENT: real MCP JSON-RPC 2.0 over stdio (newline-delimited) or
 * streamable HTTP. It manages a pool of spawned server processes:
 *
 *   initialize → notifications/initialized → tools/list → tools/call
 *
 * Server config comes from ~/.thinkdrop/mcp-servers.json (Claude-Desktop-
 * compatible):
 *   { "mcpServers": { "name": { "command", "args", "env" | "url" } } }
 *
 * Env values support "${VAR}" interpolation resolved at spawn through
 * secret-resolve under the `credential:mcp.<name>:<VAR>` key — plaintext is
 * never written to the config file or logs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');

const CONFIG_PATH = path.join(os.homedir(), '.thinkdrop', 'mcp-servers.json');
const PROTOCOL_VERSION = '2024-11-05';
const INIT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 60000;
const IDLE_REAP_MS = 10 * 60 * 1000;
const MAX_MSG = 2 * 1024 * 1024;

// ── config ──────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return raw.mcpServers || raw || {};
  } catch (_) {
    return {};
  }
}

function writeConfig(servers) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf8');
}

// ── env interpolation ───────────────────────────────────────────────────────

async function resolveEnv(name, envDef = {}) {
  const vars = [];
  for (const v of Object.values(envDef)) {
    const m = String(v).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (m) vars.push(m[1]);
  }
  let found = {};
  if (vars.length) {
    try {
      const { resolveAgentSecrets } = require('../../../../shared/secret-resolve.cjs');
      const r = await resolveAgentSecrets(`mcp.${name}`, vars);
      found = r.found || {};
    } catch (_) {}
  }
  const out = {};
  for (const [k, v] of Object.entries(envDef)) {
    const m = String(v).match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    if (m) out[k] = found[m[1]] || process.env[m[1]] || '';
    else out[k] = v;
  }
  // Vars the server expects but that weren't declared in env — surface them.
  const missing = vars.filter(v => !out[v] && !found[v]);
  return { env: out, missing };
}

// ── process pool ────────────────────────────────────────────────────────────

const _pool = new Map(); // name → {proc, pending, tools, ready, lastUse, buf}

function _touch(entry) { entry.lastUse = Date.now(); }

function _kill(name) {
  const e = _pool.get(name);
  if (!e) return;
  _pool.delete(name);
  try { e.proc.kill('SIGTERM'); } catch (_) {}
  for (const [, p] of e.pending) p.resolve({ error: 'server-killed' });
  e.pending.clear();
}

async function _spawnStdio(name, def, env) {
  const proc = spawn(def.command, def.args || [], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const entry = { proc, pending: new Map(), tools: null, nextId: 1, buf: '', lastUse: Date.now(), def };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    entry.buf += chunk;
    // newline-delimited JSON-RPC
    let idx;
    while ((idx = entry.buf.indexOf('\n')) !== -1) {
      const line = entry.buf.slice(0, idx).trim();
      entry.buf = entry.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && entry.pending.has(msg.id)) {
        const p = entry.pending.get(msg.id);
        entry.pending.delete(msg.id);
        p.resolve(msg.error ? { error: msg.error.message || JSON.stringify(msg.error) } : msg.result);
      }
    }
    if (entry.buf.length > MAX_MSG) entry.buf = entry.buf.slice(-MAX_MSG);
  });
  proc.stderr.on('data', (c) => logger.debug(`[mcp:${name}] ${String(c).trim().slice(0, 300)}`));
  proc.on('close', () => {
    for (const [, p] of entry.pending) p.resolve({ error: 'server-exited' });
    entry.pending.clear();
    if (_pool.get(name) === entry) _pool.delete(name);
  });
  proc.on('error', () => {
    for (const [, p] of entry.pending) p.resolve({ error: 'spawn-failed' });
    entry.pending.clear();
    if (_pool.get(name) === entry) _pool.delete(name);
  });
  return entry;
}

function _rpc(entry, method, params, timeoutMs = CALL_TIMEOUT_MS) {
  const id = entry.nextId++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      resolve({ error: 'timeout' });
    }, timeoutMs);
    entry.pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r); },
    });
    try {
      entry.proc.stdin.write(msg + '\n');
    } catch (err) {
      entry.pending.delete(id);
      clearTimeout(timer);
      resolve({ error: err.message });
    }
  });
}

function _notify(entry, method, params) {
  try {
    entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }) + '\n');
  } catch (_) {}
}

async function _ensure(name) {
  const cfg = readConfig();
  const def = cfg[name];
  if (!def) throw new Error(`mcp-server-not-configured: ${name}`);

  let entry = _pool.get(name);
  if (entry && !entry.proc.killed && entry.tools) { _touch(entry); return entry; }

  if (def.url) {
    // Remote HTTP server — no process, direct JSON-RPC POST per call.
    entry = { remote: true, url: def.url, headers: def.headers || {}, tools: null, nextId: 1, pending: new Map(), lastUse: Date.now(), def };
    const init = await _rpcRemote(entry, 'initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'thinkdrop', version: '1.0' },
    }, INIT_TIMEOUT_MS);
    if (init.error) throw new Error(`init-failed: ${init.error}`);
    const tools = await _rpcRemote(entry, 'tools/list', {}, CALL_TIMEOUT_MS);
    entry.tools = tools?.tools || [];
    _pool.set(name, entry);
    return entry;
  }

  const { env, missing } = await resolveEnv(name, def.env || {});
  if (missing.length) logger.warn(`[mcp:${name}] env vars unresolved: ${missing.join(', ')}`);
  entry = await _spawnStdio(name, def, env);
  const init = await _rpc(entry, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'thinkdrop', version: '1.0' },
  }, INIT_TIMEOUT_MS);
  if (init.error) {
    _kill(name);
    throw new Error(`init-failed: ${init.error}`);
  }
  _notify(entry, 'notifications/initialized', {});
  const tools = await _rpc(entry, 'tools/list', {}, CALL_TIMEOUT_MS);
  entry.tools = tools?.tools || [];
  _pool.set(name, entry);
  _touch(entry);
  return entry;
}

async function _rpcRemote(entry, method, params, timeoutMs = CALL_TIMEOUT_MS) {
  try {
    const res = await fetch(entry.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...entry.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: entry.nextId++, method, ...(params !== undefined ? { params } : {}) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    if (ct.includes('text/event-stream')) {
      // parse last data: line
      const dataLines = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      const last = dataLines[dataLines.length - 1];
      const msg = JSON.parse(last);
      return msg.error ? { error: msg.error.message } : msg.result;
    }
    const msg = JSON.parse(text);
    return msg.error ? { error: msg.error.message } : msg.result;
  } catch (err) {
    return { error: err.message };
  }
}

// ── public API ──────────────────────────────────────────────────────────────

async function listServers() {
  const cfg = readConfig();
  return Object.entries(cfg).map(([name, def]) => ({
    name,
    transport: def.url ? 'http' : 'stdio',
    command: def.url || [def.command, ...(def.args || [])].join(' '),
    envKeys: Object.keys(def.env || {}),
    running: _pool.has(name),
    tools: _pool.get(name)?.tools?.length ?? null,
  }));
}

async function listTools(name) {
  const entry = await _ensure(name);
  _touch(entry);
  return entry.tools || [];
}

async function callTool(name, tool, args = {}) {
  const entry = await _ensure(name);
  _touch(entry);
  const res = entry.remote
    ? await _rpcRemote(entry, 'tools/call', { name: tool, arguments: args })
    : await _rpc(entry, 'tools/call', { name: tool, arguments: args });
  if (res?.error) return { ok: false, error: res.error };
  // MCP result shape: {content: [{type:'text',text}|{type:'resource',...}], isError?}
  const content = res?.content || [];
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { ok: !res?.isError, text, content, isError: Boolean(res?.isError) };
}

// idle reaper
setInterval(() => {
  const now = Date.now();
  for (const [name, e] of _pool) {
    if (!e.remote && now - e.lastUse > IDLE_REAP_MS) _kill(name);
  }
}, 60 * 1000).unref?.();

module.exports = { listServers, listTools, callTool, readConfig, writeConfig, resolveEnv, _kill, CONFIG_PATH };
