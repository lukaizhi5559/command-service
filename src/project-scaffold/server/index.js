/**
 * ThinkDrop Project Server — FIXED PLUMBING (never LLM-generated)
 *
 * Exposes:
 *   POST /thinkdrop/command   — JSON command channel
 *   WS   /thinkdrop/command   — WebSocket command channel
 *   GET  /health              — health check
 *
 * The app logic lives in ./app.js (LLM-generated).
 * This file never changes between projects.
 */

'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// ── WebSocket support ────────────────────────────────────────────────────────
let expressWs;
try {
  expressWs = require('express-ws')(app, server);
} catch (_) {
  // express-ws optional — HTTP-only mode
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Load LLM-generated app logic ─────────────────────────────────────────────
let appModule = null;
try {
  appModule = require('./app.js');
} catch (err) {
  console.error('[ThinkDropProject] Failed to load app.js:', err.message);
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: process.env.THINKDROP_PROJECT_NAME || 'thinkdrop-project' });
});

// ── HTTP command channel ──────────────────────────────────────────────────────
app.post('/thinkdrop/command', async (req, res) => {
  const { action, args } = req.body || {};

  if (action === 'ping') {
    return res.json({ ok: true, result: 'pong' });
  }

  if (!appModule || typeof appModule.handleCommand !== 'function') {
    return res.status(503).json({ ok: false, error: 'App module not loaded or missing handleCommand export' });
  }

  try {
    const result = await appModule.handleCommand(action, args || {});
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── WebSocket command channel ─────────────────────────────────────────────────
if (expressWs) {
  app.ws('/thinkdrop/command', (ws, _req) => {
    ws.on('message', async (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (_) {
        return ws.send(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }

      const { action, args, id } = parsed;

      if (action === 'ping') {
        return ws.send(JSON.stringify({ ok: true, result: 'pong', id }));
      }

      if (!appModule || typeof appModule.handleCommand !== 'function') {
        return ws.send(JSON.stringify({ ok: false, error: 'App module not loaded', id }));
      }

      try {
        const result = await appModule.handleCommand(action, args || {});
        ws.send(JSON.stringify({ ok: true, result, id }));
      } catch (err) {
        ws.send(JSON.stringify({ ok: false, error: err.message, id }));
      }
    });
  });
}

// ── Serve built Vite frontend ─────────────────────────────────────────────────
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ThinkDropProject] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[ThinkDropProject] Command channel: POST http://127.0.0.1:${PORT}/thinkdrop/command`);
});

module.exports = { app, server };
