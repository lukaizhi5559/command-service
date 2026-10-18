'use strict';

// ---------------------------------------------------------------------------
// browser.ext.cjs — Extension transport adapter for browser.act.
//
// Translates the Tab-Flow action surface into WebSocket commands executed by
// the ThinkDrop Chrome extension (chrome.debugger / chrome.tabs) inside the
// user's REAL browser — real sessions, real cookies, no bot walls.
//
// Routed to from browser.act when sessionId starts with 'ext:' or
// args.transport === 'extension'. Sessions:
//   ext:default   → active tab (interactive, "this page")
//   ext:bg:<name> → dedicated background tab (cron/non-interactive)
//   ext:<name>    → find-adopt-or-create by URL host
// ---------------------------------------------------------------------------

const fs = require('fs');
const logger = require('../logger.cjs');
const gateway = require('../ext.gateway.cjs');
const engine = require('./browser-engine.cjs'); // for _DOM_SCANNER_SCRIPT

// Snapshot state mirrors browser.act's _engineSnapshots/_engineRefMaps so
// downstream ref resolution semantics stay identical.
const _extSnapshots = new Map(); // sessionId → {generation, url, yaml, refMap}
const _extRefMaps   = new Map(); // sessionId → refMap

function _env(action, sessionId, start, extra = {}) {
  return { ok: true, action, sessionId, executionTime: Date.now() - start, ...extra };
}
function _envErr(action, sessionId, start, error, extra = {}) {
  return { ok: false, action, sessionId, error, executionTime: Date.now() - start, ...extra };
}

function _stdoutOf(val) {
  if (val == null) return '';
  return typeof val === 'string' ? val : JSON.stringify(val);
}

// Build the same refMap shape as browser-engine.buildRefTree from the
// DOM scanner's parsed output.
function _buildRefMapFromScan(scan) {
  const refMap = new Map();
  for (const el of scan?.elements || []) {
    refMap.set(el.ref, {
      role: el.role, name: el.label, tag: el.tag, type: el.type,
      visible: el.visible, occluded: el.occluded, rect: el.rect,
      source: el.source, placeholder: el.placeholder,
      contenteditable: el.contenteditable, context: el.context, region: el.region,
    });
  }
  return refMap;
}

function _storeSnapshot(sessionId, url, yaml, refMap, activeElement) {
  const prev = _extSnapshots.get(sessionId);
  const snapshot = {
    generation: (prev?.generation || 0) + 1,
    url, yaml, refMap,
    activeElement: activeElement || null,
  };
  _extSnapshots.set(sessionId, snapshot);
  _extRefMaps.set(sessionId, refMap);
  return snapshot;
}

/**
 * Extension-backed browserAct. Returns the same envelope as engine-path
 * actions: { ok, action, sessionId, result?, stdout?, error?, executionTime }
 */
async function browserExtAct(args = {}) {
  const {
    action,
    sessionId = 'ext:default',
    url, selector, text, key, value,
    dx = 0, dy = 100,
    filePath,
    timeoutMs = 20000,
  } = args;
  const start = Date.now();

  if (!action) return _envErr(action, sessionId, start, 'action is required');
  if (!gateway.hasExtension()) {
    return _envErr(action, sessionId, start,
      'ThinkDrop Chrome extension not connected — click the ThinkDrop icon in Chrome to connect this browser');
  }

  // Serialize input-producing actions per session (matches engine session mutex)
  const needsLock = ['press', 'keyboard', 'key', 'type', 'click', 'clickAt', 'dblclick', 'insertText', 'fill', 'clickByText'].includes(action);
  const run = () => _dispatch(args, start);
  return needsLock
    ? gateway.withSessionLock(sessionId, run)
    : run();
}

async function _dispatch(args, start) {
  const { action, sessionId, url, selector, text, key, value, dx = 0, dy = 100, filePath, timeoutMs = 20000 } = args;
  // Resolution-relevant fields forwarded on every cmd — any call may be the
  // first bind for its session (tabPolicy/activate shape resolveTab's policy).
  const _fwd = { url, activate: args.activate, tabPolicy: args.tabPolicy, hostHint: args.hostHint };

  switch (action) {
    case 'navigate':
    case 'goto': {
      const res = await gateway.sendCmd({ sessionId, action: 'navigate', args: { ..._fwd, timeoutMs: timeoutMs || 30000 } }, (timeoutMs || 30000) + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.url || url, stdout: res.url || url });
    }

    case 'evaluate': {
      const expr = text || args.expression || selector || '';
      const res = await gateway.sendCmd({ sessionId, action: 'evaluate', args: { expression: expr, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.result, stdout: _stdoutOf(res.result) });
    }

    case 'run-code': {
      const res = await gateway.sendCmd({ sessionId, action: 'run-code', args: { code: text || args.code || '', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.result, stdout: _stdoutOf(res.result) });
    }

    case 'snapshot': {
      const res = await gateway.sendCmd({ sessionId, action: 'snapshot', args: { scannerScript: engine._DOM_SCANNER_SCRIPT, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      const scan = res.result;
      if (!scan || !scan.count) {
        return _envErr(action, sessionId, start, 'ext snapshot: scanner returned no elements', { lowConfidenceRefs: true });
      }
      const refMap = _buildRefMapFromScan(scan);
      const snap = _storeSnapshot(sessionId, scan.url || url || '', scan.yaml, refMap, scan.activeElement);
      logger.info(`[browser.ext] snapshot session=${sessionId}: ${refMap.size} elements (gen ${snap.generation})`);
      return _env(action, sessionId, start, {
        result: scan.yaml,
        generation: snap.generation,
        activeElement: scan.activeElement || null,
        scannerUsed: true,
      });
    }

    case 'press':
    case 'keyboard':
    case 'key': {
      const res = await gateway.sendCmd({ sessionId, action: 'press', args: { key: key || 'Enter', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      if (res.virtualTab && res.virtualTab.moved) {
        logger.info(`[browser.ext] virtual-tab used for "${key}" → focused ${res.virtualTab.tag} ${res.virtualTab.ref || ''} "${(res.virtualTab.label || '').slice(0, 40)}"`);
      }
      return _env(action, sessionId, start, { result: res.pressed });
    }

    case 'type':
    case 'insertText': {
      const res = await gateway.sendCmd({ sessionId, action: 'type', args: { text: text || '', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start);
    }

    case 'fill': {
      const res = await gateway.sendCmd({ sessionId, action: 'fill', args: { selector: selector || args.ref || '', text: text ?? value ?? '', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.focused });
    }

    case 'click':
    case 'clickSelector':
    case 'dblclick': {
      const res = await gateway.sendCmd({ sessionId, action, args: { selector: selector || args.ref || '', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.clicked });
    }

    case 'clickAt': {
      const res = await gateway.sendCmd({ sessionId, action: 'clickAt', args: { x: args.x, y: args.y, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start);
    }

    case 'clickByText': {
      const res = await gateway.sendCmd({ sessionId, action: 'clickByText', args: { ..._fwd, text: text || selector || '' } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.clicked });
    }

    case 'scroll': {
      const res = await gateway.sendCmd({ sessionId, action: 'scroll', args: { dx, dy, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.result });
    }

    case 'screenshot': {
      const res = await gateway.sendCmd({ sessionId, action: 'screenshot', args: { ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      if (filePath && res.data) {
        try { fs.writeFileSync(filePath, Buffer.from(res.data, 'base64')); } catch (e) {
          return _envErr(action, sessionId, start, `screenshot write failed: ${e.message}`);
        }
      }
      return _env(action, sessionId, start, { result: filePath || 'captured' });
    }

    case 'getText':
    case 'getPageText': {
      const res = await gateway.sendCmd({ sessionId, action: 'getPageText', args: { selector, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.result, stdout: _stdoutOf(res.result) });
    }

    case 'waitForSelector':
    case 'waitForStableText':
    case 'waitForContent': {
      const res = await gateway.sendCmd({ sessionId, action, args: { selector, timeoutMs, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok && !res.timedOut) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start);
    }

    case 'back': case 'forward': case 'reload': case 'close': {
      const res = await gateway.sendCmd({ sessionId, action, args: { ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start);
    }

    case 'tab-list': {
      const res = await gateway.sendCmd({ sessionId, action: 'tab-list', args: {} }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.tabs, stdout: JSON.stringify(res.tabs) });
    }
    case 'tab-new':
    case 'tab-close':
    case 'tab-select': {
      const res = await gateway.sendCmd({ sessionId, action, args: { url, tabId: args.tabId, active: args.active } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.tabId });
    }

    case 'cookies': {
      const res = await gateway.sendCmd({ sessionId, action: 'cookies', args: { domain: args.domain, ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.cookies, stdout: JSON.stringify(res.cookies?.length || 0) });
    }

    case 'resize':
      return _env(action, sessionId, start, { note: 'resize is a no-op on real browser tabs' });

    default:
      return _envErr(action, sessionId, start, `ext transport does not support action '${action}' yet`);
  }
}

function getExtSnapshot(sessionId) { return _extSnapshots.get(sessionId) || null; }
function getExtRefMap(sessionId) { return _extRefMaps.get(sessionId) || null; }

module.exports = { browserExtAct, getExtSnapshot, getExtRefMap };
