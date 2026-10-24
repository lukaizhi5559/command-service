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

    case 'reactFill':
    case 'fill': {
      const res = await gateway.sendCmd({ sessionId, action: 'fill', args: { selector: selector || args.ref || '', text: text ?? value ?? '', ..._fwd } }, timeoutMs + 5000);
      if (!res.ok) return _envErr(action, sessionId, start, res.error);
      return _env(action, sessionId, start, { result: res.focused });
    }

    case 'click':
    case 'clickSelector':
    case 'clickBySelector':
    case 'dblclick': {
      const _sel = selector || args.ref || '';
      // Ref-stale fingerprint: for tdN/eN refs, forward the tag+label the
      // snapshot recorded so the extension refuses to click when the live
      // DOM renumbered the ref onto a different element (Gmail SPA re-render).
      let _expect = null;
      if (/^(td|e|ff)\d+$/i.test(_sel)) {
        const _meta = _extRefMaps.get(sessionId)?.get(_sel);
        if (_meta) _expect = { expectTag: _meta.tag || '', expectLabel: String(_meta.name || '').slice(0, 80) };
      }
      const res = await gateway.sendCmd({ sessionId, action: action === 'clickBySelector' ? 'clickSelector' : action, args: { selector: _sel, ..._fwd, ...(_expect || {}) } }, timeoutMs + 5000);
      if (!res.ok) {
        if (res.error === 'ref-stale' || /^ref-stale/i.test(res.error || '')) {
          // Invalidate the cached snapshot so the next action re-scans fresh
          // refs instead of repeating the dead ref.
          _extSnapshots.delete(sessionId);
          _extRefMaps.delete(sessionId);
          logger.warn(`[browser.ext] ref-stale on ${_sel} (session=${sessionId}) — snapshot invalidated; ${res.detail || ''}`);
          return _envErr(action, sessionId, start, `ref-stale: ${res.detail || `ref ${_sel} no longer matches its snapshot element — re-snapshot and retry`}`);
        }
        // a[href='X'] selectors fail when the DOM attribute differs from the
        // absolute href (re-encoded params, relative form). Clicking a link
        // is navigating it — fall through to a bound-tab navigate on X.
        const _hrefM = /^\s*a\[href\s*=\s*['"](https?:\/\/[^'"]+)['"]\s*\]\s*$/i.exec(selector || '');
        if (_hrefM) {
          const nav = await gateway.sendCmd({ sessionId, action: 'navigate', args: { url: _hrefM[1], ..._fwd } }, timeoutMs + 5000).catch((e) => ({ ok: false, error: `nav threw: ${e.message}` }));
          if (nav?.ok) {
            logger.info(`[browser.ext] click ${selector.slice(0, 50)} not found → navigated bound tab to its href`);
            return _env(action, sessionId, start, { result: { navigated: _hrefM[1] } });
          }
          logger.warn(`[browser.ext] a[href] click fallback: navigate failed → ${nav?.error || 'no result'} (url=${_hrefM[1].slice(0, 90)})`);
        }
        return _envErr(action, sessionId, start, res.error);
      }
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

    case 'sendEmailWithVerification': {
      // Verified Gmail send over the extension transport — mirrors the
      // engine/CLI sequence in browser.act (validate → commit raw recipient
      // → click Send → post-send verify) via evaluate/press/click commands.
      const _eval = async (expression, t = 8000) => {
        const r = await gateway.sendCmd({ sessionId, action: 'evaluate', args: { expression, ..._fwd } }, t + 5000);
        if (!r?.ok) return null;
        try { return typeof r.result === 'string' ? JSON.parse(r.result) : r.result; } catch (_) { return r.result; }
      };
      const _VALIDATE = `(() => {
        const chips = document.querySelectorAll('[data-hovercard-id],[email],[data-name].vM,.vR,.afV');
        const recipientInput = document.querySelector('input[name="to"],textarea[name="to"]');
        const rawToText = (recipientInput?.value || '').trim();
        const subject = (document.querySelector('input[name="subjectbox"]')?.value || '').trim();
        const body = (document.querySelector('div[aria-label="Message Body"]')?.innerText || '').trim();
        const composeVisible = !!document.querySelector('div[aria-label="New Message"],div[aria-label="Message Body"],.T-I-KE');
        return JSON.stringify({ hasChip: chips.length > 0, hasRawTo: rawToText.length > 3 && rawToText.includes('@'), rawToText: rawToText.slice(0,50), subject: subject.slice(0,50), bodyLen: body.length, composeVisible });
      })()`;
      const _POST = `(() => {
        const composeOpen = !!document.querySelector('div[aria-label="Message Body"],div[aria-label="New Message"]');
        const t = (document.body?.innerText || '').toLowerCase().slice(0, 3000);
        const sentToast = /message sent|view message/.test(t);
        const sendAnyway = /send anyway|send without|without subject|no subject/.test(t);
        const errEl = document.querySelector('[role="alert"],.Kj-JD-Jz');
        return JSON.stringify({ composeOpen, sentToast, sendAnyway, errText: (errEl?.innerText || '').slice(0, 120) });
      })()`;

      // 1. Pre-send validation — recipient chip or committable raw text.
      let val = await _eval(_VALIDATE);
      if (val && !val.hasChip && !val.hasRawTo) {
        return _envErr(action, sessionId, start, 'sendEmailWithVerification: No recipient chip confirmed — fill the To field and press Enter to create a chip before sending');
      }
      if (val && val.hasRawTo && !val.hasChip) {
        logger.info(`[browser.ext] sendEmailWithVerification: recipient "${val.rawToText}" raw text — Enter to commit chip`);
        await gateway.sendCmd({ sessionId, action: 'press', args: { key: 'Enter', ..._fwd } }, 8000).catch(() => {});
        await new Promise(r => setTimeout(r, 600));
        val = await _eval(_VALIDATE);
        if (val && !val.hasChip && !val.hasRawTo) {
          return _envErr(action, sessionId, start, 'sendEmailWithVerification: recipient did not commit to a chip');
        }
      }
      logger.info(`[browser.ext] sendEmailWithVerification: validation ok — chip=${val?.hasChip} subject="${val?.subject}" bodyLen=${val?.bodyLen}`);

      // 2. Click Send — selector → tooltip → aria → Ctrl+Enter on body focus.
      let sendClicked = false;
      const _tryClick = async (sel) => {
        if (!sel) return false;
        const r = await gateway.sendCmd({ sessionId, action: 'click', args: { selector: sel, ..._fwd } }, 8000).catch(() => null);
        return !!r?.ok;
      };
      for (const sel of [selector, 'div[data-tooltip*="Send"]', 'div[role="button"][aria-label*="Send"]', 'div[aria-label*="Send"]']) {
        if (await _tryClick(sel)) { sendClicked = true; break; }
      }
      if (!sendClicked) {
        await gateway.sendCmd({ sessionId, action: 'click', args: { selector: 'div[aria-label="Message Body"]', ..._fwd } }, 5000).catch(() => {});
        const r = await gateway.sendCmd({ sessionId, action: 'press', args: { key: 'Control+Enter', ..._fwd } }, 8000).catch(() => null);
        sendClicked = !!r?.ok;
      }
      if (!sendClicked) {
        return _envErr(action, sessionId, start, 'sendEmailWithVerification: all send strategies failed — could not locate or click Send button');
      }

      // 3. Post-send verify — compose closed or sent toast; "send anyway"
      //    dialogs auto-accepted; error banners surfaced.
      await new Promise(r => setTimeout(r, 1500));
      let post = await _eval(_POST);
      if (post?.sendAnyway) {
        logger.info('[browser.ext] sendEmailWithVerification: "send anyway" dialog — auto-accepting');
        await gateway.sendCmd({ sessionId, action: 'clickByText', args: { text: 'Send anyway', ..._fwd } }, 8000).catch(() => {});
        await gateway.sendCmd({ sessionId, action: 'clickByText', args: { text: 'OK', ..._fwd } }, 5000).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        post = await _eval(_POST);
      }
      if (post?.errText) {
        return _envErr(action, sessionId, start, `sendEmailWithVerification: Gmail error after send — ${post.errText}`);
      }
      if (post && (post.sentToast || !post.composeOpen)) {
        logger.info(`[browser.ext] sendEmailWithVerification: email sent (sentToast=${post.sentToast}, composeGone=${!post.composeOpen})`);
        return _env(action, sessionId, start, { result: 'Email sent and verified successfully' });
      }
      if (!post) {
        logger.warn('[browser.ext] sendEmailWithVerification: post-send probe failed — click succeeded, assuming sent');
        return _env(action, sessionId, start, { result: 'Email sent (unverified — post-send probe failed)' });
      }
      return _envErr(action, sessionId, start, 'sendEmailWithVerification: compose window still open with no confirmation — send may not have fired');
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
