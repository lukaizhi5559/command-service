'use strict';

// ---------------------------------------------------------------------------
// keyboard.agent.cjs — Atomic agent: physical keyboard input via CGEvent.
//
// Types text or presses named keys (+ modifiers) through the td-ui-parse
// daemon. Use after focusing a field (screen.act.agent click) — this types
// wherever the OS focus currently is, like a real keyboard.
//
// Contract:
//   args: { text? | key?, mods? = ['cmd','shift','alt','ctrl'], sessionId? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const http = require('http');
const logger = require('../logger.cjs');

const HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const TIMEOUT_MS = 20000;

function post(path, body, timeoutMs = TIMEOUT_MS, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`bad JSON from ${path}: ${data.slice(0, 200)}`)); }
      });
    });
    const onAbort = () => req.destroy(new Error('cancelled'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    req.on('close', () => { if (signal) signal.removeEventListener('abort', onAbort); });
    req.end(payload);
  });
}

async function keyboardAgent(args = {}) {
  const sig = args._abortSignal;
  if (sig?.aborted) return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
  const { text, key, mods = [], sessionId } = args;
  if (text == null && !key) return { ok: false, error: 'keyboard.agent: need text or key', sessionId };

  const cmd = key
    ? { cmd: 'key', key, mods }
    : { cmd: 'type', text: String(text) };

  try {
    const res = await post('/screen/act', { action: cmd.cmd, ...cmd }, TIMEOUT_MS, sig);
    if (!res.success) {
      return {
        ok: false,
        error: res.error || 'act failed',
        suggestedAgent: res.error === 'accessibility_permission_denied' ? 'user.agent' : undefined,
        sessionId,
      };
    }
    logger.info(`[keyboard.agent] ${key ? `key ${key}` : `type ${String(text).length} chars`}`);
    return {
      ok: true,
      output: key ? `key ${key}${mods.length ? '+' + mods.join('+') : ''}` : `typed "${String(text).slice(0, 40)}"`,
      sessionId,
    };
  } catch (e) {
    if (e.message === 'cancelled') return { ok: false, error: 'cancelled', cancelled: true, sessionId };
    return { ok: false, error: `keyboard.agent: ${e.message}`, sessionId };
  }
}

module.exports = { keyboardAgent };
