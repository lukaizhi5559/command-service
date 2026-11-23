'use strict';

// ---------------------------------------------------------------------------
// mouse.agent.cjs — Atomic agent: physical mouse actions via CGEvent.
//
// Clicks/moves/scrolls at real screen coordinates through the td-ui-parse
// daemon (screen-intelligence-service :3008). Pair with screen.act.agent,
// which resolves element IDs → centers; this skill is the raw executor.
//
// Contract:
//   args: { x?, y?, action? = 'click'|'right-click'|'double-click'|'move'|'scroll',
//           button?, double?, dx?, dy?, sessionId? }
//   returns { ok, output?, error?, suggestedAgent? }
// ---------------------------------------------------------------------------

const http = require('http');
const logger = require('../logger.cjs');

const HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const TIMEOUT_MS = 15000;

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

async function mouseAgent(args = {}) {
  const sig = args._abortSignal;
  if (sig?.aborted) return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
  const action = args.action || (args.double ? 'double-click' : 'click');
  const x = Number(args.x), y = Number(args.y);

  let cmd;
  switch (action) {
    case 'click':
      cmd = { cmd: 'click', x, y, button: 'left' }; break;
    case 'right-click':
      cmd = { cmd: 'click', x, y, button: 'right' }; break;
    case 'double-click':
      cmd = { cmd: 'click', x, y, button: 'left', double: true }; break;
    case 'scroll':
      cmd = { cmd: 'scroll', x, y, dx: args.dx || 0, dy: args.dy || 0 }; break;
    case 'move':
      cmd = { cmd: 'move', x, y }; break;
    default:
      return { ok: false, error: `mouse.agent: unknown action '${action}'` };
  }

  if ((action !== 'scroll' || cmd.dx !== undefined) && (isNaN(x) || isNaN(y))) {
    return { ok: false, error: 'mouse.agent: x and y are required' };
  }

  try {
    const res = await post('/screen/act', { action: cmd.cmd, ...cmd }, TIMEOUT_MS, sig);
    if (!res.success) {
      return {
        ok: false,
        error: res.error || 'act failed',
        suggestedAgent: res.error === 'accessibility_permission_denied' ? 'user.agent' : undefined,
        sessionId: args.sessionId,
      };
    }
    logger.info(`[mouse.agent] ${action} @ (${x}, ${y})`);
    return { ok: true, output: `${action} @ (${x},${y})`, sessionId: args.sessionId };
  } catch (e) {
    if (e.message === 'cancelled') return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
    return { ok: false, error: `mouse.agent: ${e.message}`, sessionId: args.sessionId };
  }
}

module.exports = { mouseAgent };
