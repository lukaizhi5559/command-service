'use strict';

/**
 * skill: screen.display
 *
 * Pushes a ScreenOutput onto the GhostLayer — the screen surface of its own
 * (charts, docs, decks, scenes, three.js presets, text, images, alerts,
 * effects, emoji). This is the ONLY step-level surface into the screen layer:
 * plan skills can end a deliverable task with a `screen.display` step instead
 * of inventing python/file renderers.
 *
 * Payload is validated through shared/screen-output.cjs (the canonical
 * contract) before POSTing to the overlay-control server.
 *
 * Actions:
 *   display — POST /screen/display  (default)
 *   clear   — POST /screen/clear    (dismiss one id or everything)
 *
 * Args (display): ScreenOutput fields —
 *   kind:      'text'|'image'|'chart'|'effect'|'emoji'|'alert'|'deck'|'scene'|'three'|'doc'
 *   title, text, position, scrim, durationMs, mood, dismiss, blocking,
 *   interactive, priority, animate, emoji
 *   chart:  { type: 'pie|donut|bar|line|area|stat', data: [...], xKey, yKey, label }
 *   doc:    { markdown, editable, sourcePath }
 *   deck:   { slides: [{title?, text, image?}], transition, slideMs, controls }
 *   scene:  { name? | html?, css?, js?, libs? }   — generated markup (sandboxed)
 *   three:  { scene: 'starfield|particles|wave|cube|knot|globe', color, speed, density, text }
 *   effect: 'rain|snow|confetti|fireworks|emoji-rain', intensity
 *   image:  url|path|dataUrl|images[], caption, fit
 *   alert:  severity 'info|warn|block', text/title
 *
 * Returns: { ok, action, id?, error? }
 */

const http = require('http');
const logger = require('../logger.cjs');

const OVERLAY_PORT = parseInt(process.env.OVERLAY_CONTROL_PORT || process.env.THINKDROP_MAIN_PORT || '3010', 10);

function _post(pathname, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: OVERLAY_PORT,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw || null }); }
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

async function screenDisplay(args = {}) {
  const action = String(args.action || 'display').toLowerCase();

  if (action === 'clear') {
    const res = await _post('/screen/clear', args.id ? { id: args.id } : {});
    if (res.status && res.status < 300) return { ok: true, action: 'clear' };
    return { ok: false, action: 'clear', error: res.error || `clear failed (HTTP ${res.status})` };
  }

  if (action !== 'display') {
    return { ok: false, error: `unknown action "${action}" — use display|clear` };
  }

  let normalizeScreenOutput;
  try {
    ({ normalizeScreenOutput } = require('../../../../shared/screen-output.cjs'));
  } catch (e) {
    return { ok: false, error: `screen-output contract unavailable: ${e.message}` };
  }
  const norm = normalizeScreenOutput(args);
  if (!norm.ok) return { ok: false, action: 'display', error: norm.error };

  const res = await _post('/screen/display', norm.output);
  if (res.status && res.status < 300) {
    logger.info('[screen.display] displayed', { kind: norm.output.kind, id: norm.output.id });
    return { ok: true, action: 'display', id: norm.output.id, kind: norm.output.kind };
  }
  return { ok: false, action: 'display', error: res.error || `display failed (HTTP ${res.status})` };
}

module.exports = { screenDisplay };
