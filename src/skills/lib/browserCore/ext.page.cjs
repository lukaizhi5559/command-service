'use strict';

// ---------------------------------------------------------------------------
// ext.page.cjs — Playwright-`page`-shaped adapter over the ThinkDrop Chrome
// extension transport (ext.gateway).
//
// playwright.agent.cjs historically required a real Playwright page; for
// `ext:` sessions engine.getPage() returns null → the turn loop spawned a
// Chrome-for-Testing window even though the user's logged-in browser had the
// tab. This adapter implements the measured page API surface (evaluate,
// waitForTimeout, url, goto, click, screenshot, waitFor*, locator/getBy*,
// mainFrame/frames, isClosed, on/removeListener) so the same code drives the
// real browser.
//
// Usage: const page = extPage(sessionId) — page-like object, or null when the
// extension is unavailable. Gated by gateway.hasExtension().
// ---------------------------------------------------------------------------

const logger = require('../../../logger.cjs');

function _gw() {
  try { return require('../../../ext.gateway.cjs'); } catch (_) { return null; }
}

function _serializeEval(fnOrExpr, arg) {
  if (typeof fnOrExpr === 'function') {
    return `(${fnOrExpr.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
  }
  return String(fnOrExpr);
}

function extPage(sessionId) {
  const sid = String(sessionId || '');
  if (!sid.startsWith('ext:')) return null;
  const gw = _gw();
  if (!gw || !gw.hasExtension || !gw.hasExtension()) return null;

  const send = (action, args = {}, timeoutMs = 30000) =>
    gw.sendCmd({ sessionId: sid, action, args }, timeoutMs + 5000).catch(e => ({ ok: false, error: e.message }));

  const page = {
    _isExtPage: true,
    sessionId: sid,

    async evaluate(fnOrExpr, arg) {
      const res = await send('run-code', { code: _serializeEval(fnOrExpr, arg) }, 30000);
      if (!res?.ok) throw new Error(res?.error || 'ext evaluate failed');
      return res.result !== undefined ? res.result : res.value;
    },

    async waitForTimeout(ms) { return new Promise(r => setTimeout(r, ms)); },

    url() { return this.evaluate('location.href').catch(() => ''); },

    async viewportSize() {
      const r = await this.evaluate('({ width: window.innerWidth, height: window.innerHeight })').catch(() => null);
      return r && typeof r === 'object' ? r : { width: 1366, height: 900 };
    },

    async goto(url, opts = {}) {
      const res = await send('navigate', { url, timeoutMs: opts.timeout || 30000 }, (opts.timeout || 30000));
      return res?.ok ? { url } : Promise.reject(new Error(res?.error || 'ext navigate failed'));
    },

    async click(target, opts = {}) {
      // Supports page.click('css') and page.click(x, y)
      if (typeof target === 'string') {
        return this.evaluate(`(document.querySelector(${JSON.stringify(target)})||{click(){throw new Error('not found')}}).click()`);
      }
      const res = await send('click', { x: target, y: opts, timeoutMs: 15000 });
      if (!res?.ok) throw new Error(res?.error || 'ext click failed');
      return res;
    },

    async screenshot(opts = {}) {
      const res = await send('screenshot', { fullPage: !!opts.fullPage, type: opts.type || 'png' }, 45000);
      if (!res?.ok) throw new Error(res?.error || 'ext screenshot failed');
      // Playwright returns Buffer; ext returns base64 string — normalize.
      return res.data ? Buffer.from(res.data, 'base64') : res;
    },

    async press(selOrKey, maybeKey) {
      const key = maybeKey || selOrKey;
      const res = await send('press', { key, timeoutMs: 15000 });
      if (!res?.ok) throw new Error(res?.error || 'ext press failed');
      return res;
    },

    async type(selector, text, _opts = {}) {
      const res = await send('type', { selector, text, timeoutMs: 20000 });
      if (!res?.ok) throw new Error(res?.error || 'ext type failed');
      return res;
    },

    async fill(selector, value) {
      const res = await send('fill', { selector, text: value, timeoutMs: 20000 });
      if (!res?.ok) throw new Error(res?.error || 'ext fill failed');
      return res;
    },

    async waitForSelector(selector, opts = {}) {
      const deadline = Date.now() + (opts.timeout || 10000);
      while (Date.now() < deadline) {
        const found = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
        if (found) return { _extEl: true, selector };
        if (opts.state === 'detached') return null;
        await this.waitForTimeout(250);
      }
      if (opts.state === 'detached') return null;
      throw new Error(`ext waitForSelector timeout: ${selector}`);
    },

    async waitForLoadState(_state = 'load', opts = {}) {
      const deadline = Date.now() + (opts.timeout || 15000);
      while (Date.now() < deadline) {
        const rs = await this.evaluate('document.readyState').catch(() => 'loading');
        if (rs === 'complete' || rs === 'interactive') return;
        await this.waitForTimeout(250);
      }
    },

    async waitForFunction(fnOrExpr, arg, opts = {}) {
      const deadline = Date.now() + (opts.timeout || 15000);
      while (Date.now() < deadline) {
        const v = await this.evaluate(_serializeEval(fnOrExpr, arg)).catch(() => false);
        if (v) return v;
        await this.waitForTimeout(250);
      }
      throw new Error('ext waitForFunction timeout');
    },

    async waitForNavigation(opts = {}) {
      const before = await this.url().catch(() => '');
      const deadline = Date.now() + (opts.timeout || 15000);
      while (Date.now() < deadline) {
        const now = await this.url().catch(() => before);
        if (now && now !== before) { await this.waitForLoadState(); return; }
        await this.waitForTimeout(300);
      }
    },

    _loc(sel) {
      const p = this;
      return {
        selector: sel,
        async click() { return p.click(sel); },
        async fill(v) { return p.fill(sel, v); },
        async type(t) { return p.type(sel, t); },
        async count() { return p.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`).catch(() => 0); },
        first() { return this; },
        last() { return this; },
        nth() { return this; },
        async textContent() { return p.evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||null`); },
        async innerText() { return p.evaluate(`(document.querySelector(${JSON.stringify(sel)})||{}).innerText||''`); },
        async isVisible() { return p.evaluate(`!!(document.querySelector(${JSON.stringify(sel)})||{offsetParent:null}).offsetParent`).catch(() => false); },
        async evaluate(fn, arg) { return p.evaluate(`(${fn.toString()})(document.querySelector(${JSON.stringify(sel)}), ${JSON.stringify(arg)})`); },
      };
    },

    locator(sel) { return this._loc(sel); },
    getByRole(role, opts = {}) {
      const nameSrc = opts.name instanceof RegExp ? opts.name.source : String(opts.name || '');
      const p = this;
      return {
        async click() {
          return p.evaluate(`(() => {
            const re = ${nameSrc ? `new RegExp(${JSON.stringify(nameSrc)}, 'i')` : 'null'};
            const cands = [...document.querySelectorAll('[role="${role}"], ${role}, button, a, input, [tabindex]')]
              .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .filter(el => !re || re.test(el.innerText || el.textContent || el.getAttribute('aria-label') || ''));
            if (!cands[0]) throw new Error('getByRole: no match');
            cands[0].click(); return true;
          })()`);
        },
        async count() { return 1; },
        first() { return this; },
      };
    },
    getByText(text, opts = {}) {
      const p = this; const t = String(text);
      return {
        async click() {
          return p.evaluate(`(() => {
            const els = [...document.querySelectorAll('a,button,[role="button"],[role="link"],span,div,p,li')]
              .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
              .filter(el => (el.innerText || el.textContent || '').trim() === ${JSON.stringify(t)} || (el.innerText || '').includes(${JSON.stringify(t)}));
            if (!els[0]) throw new Error('getByText: no match');
            els[0].click(); return true;
          })()`);
        },
        async count() { return 1; },
        first() { return this; },
      };
    },
    getByLabel(text) { return this._loc(`[aria-label="${text}"]`); },

    mainFrame() { return this; },
    frames() { return [this]; },
    async isClosed() {
      const res = await send('tab-list', {}, 5000);
      const tabs = res?.tabs || res?.sessions || [];
      return !tabs.some(t => t && t.alive !== false);
    },

    // Event listeners are no-ops on ext — navigation waits poll the URL.
    on() {}, removeListener() {}, off() {}, once() {},
  };

  return page;
}

module.exports = { extPage };
