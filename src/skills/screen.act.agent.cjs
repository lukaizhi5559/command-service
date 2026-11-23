'use strict';

// ---------------------------------------------------------------------------
// screen.act.agent.cjs — Human-style UI interaction: observe → act → verify.
//
// Tier-6 executor. Cheapest-mechanism-first per step: a `steps[]` plan or a
// goal shape that splits deterministically (click 'X', type 'T' into 'Y')
// runs with ZERO model calls; the decision model only picks elements when no
// deterministic match exists — and judges "did it work" after every act.
// No DOM, no Playwright — works on any app including canvas/Electron.
//
//   observe : POST /screen/parse  → [{id,type,label,bbox,center,region}]
//   resolve : match (exact/substring on label) → model pick among matches →
//             model pick over shortlist (last resort)
//   act     : click center / type text / key press / scroll
//   verify  : deterministic expected-state check → decision YES/NO → recover
//
// Contract:
//   args: { goal?, steps?, display?, windowOnly?, maxSteps?, sessionId? }
//   returns { ok, output?, error?, stepsRun?, verified?, sessionId }
// ---------------------------------------------------------------------------

const http = require('http');
const { execFile } = require('child_process');
const logger = require('../logger.cjs');
const { askDecision, decisionEnabled } = require('../skill-helpers/decision.cjs');
const { mouseAgent: _mouseAgent } = require('./mouse.agent.cjs');
const { keyboardAgent: _keyboardAgent } = require('./keyboard.agent.cjs');
const flowCache = require('../skill-helpers/flow-cache.cjs');
const _vocab = require('../skill-helpers/action-vocab.cjs');

// ── Cancellation ─────────────────────────────────────────────────────────────
// _ACT_SIGNAL binds the caller's AbortSignal for the duration of screenActAgent
// (the screen lane serializes screen runs, so one binding is live at a time).
// post/mouseAgent/keyboardAgent all honour it: checks reject 'cancelled' before
// any CGEvent fires, and an in-flight HTTP request is destroyed on abort so a
// cancel mid-parse stops the pipeline instead of acting on stale elements.
let _ACT_SIGNAL = null;
const _aborted = () => !!_ACT_SIGNAL?.aborted;
const _cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });
const mouseAgent = (a) => _mouseAgent({ _abortSignal: _ACT_SIGNAL, ...a });
const keyboardAgent = (a) => _keyboardAgent({ _abortSignal: _ACT_SIGNAL, ...a });
// Abortable sleep — resolves early on abort so waits don't outlive the cancel.
function _sleep(ms) {
  return new Promise(r => {
    if (_aborted()) return r();
    const t = setTimeout(r, ms);
    _ACT_SIGNAL?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
}

const HOST = process.env.SCREEN_SERVICE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.SCREEN_INTEL_PORT || '3008', 10);
const PARSE_TIMEOUT_MS = 20000;
const MAX_CANDIDATES = 24;   // phi4 choice max is 26 options; +2 sentinel (done/none)
const MAX_STEPS = 20;        // bounded steps per call
const MAX_RECOVER = 3;       // bounded recoveries per step (escalating ladder)

// Coordinate-space normalization — the daemon's windowOnly capture path
// scales by SCWindow.frame (its own source: "SCWindow.frame vs CGEvent
// space has proven unreliable"), reporting elements in a stretched+offset
// space (scale [1.333,1.388] off [0,122] vs canonical [1.333,1.2] [0,0] on
// this display). Recover capture-px via the reported transform and
// re-project through the canonical scale, cached from the last non-
// windowOnly parse. Without this every element sits ~one row low at the
// top of the screen — clicks land on the wrong row entirely.
let _coordRefScale = null;
function _normParseSpace(res, wo) {
  const sc = res?.scale, off = res?.offset || [0, 0];
  if (!sc || sc.length < 2) return res;
  if (!wo) { _coordRefScale = sc; return res; }
  const ref = _coordRefScale || [4 / 3, 1.2];
  const mx = sc[0] / ref[0], my = sc[1] / ref[1];
  if (Math.abs(mx - 1) < .02 && Math.abs(my - 1) < .02 && !off[0] && !off[1]) return res;
  const fx = v => (v - off[0]) * mx, fy = v => (v - off[1]) * my;
  const fixBox = b => [fx(b[0]), fy(b[1]), b[2] * mx, b[3] * my];
  for (const e of res.elements || []) {
    if (e.center) e.center = [fx(e.center[0]), fy(e.center[1])];
    if (e.bbox && e.bbox.length === 4) e.bbox = fixBox(e.bbox);
    for (const s of [...(e.rows || []), ...(e.words || [])])
      if (s.bbox && s.bbox.length === 4) s.bbox = fixBox(s.bbox);
  }
  return res;
}

function post(path, body, timeoutMs = PARSE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (_aborted()) return reject(_cancelledError());
    // windowOnly capture is broken on this display — the daemon scales by
    // SCWindow.frame (its own source calls it unreliable): offset/scale
    // drift puts elements ~a row low, and the SAME wrong transform is used
    // to cut the crop, so crop probes read a region that isn't the one
    // asked for (ghost elements → wrong-row clicks). Display-wide capture
    // reports true CGEvent points and crops land correctly; keep the flag
    // for /screen/act only.
    if (path === '/screen/parse' && body && body.windowOnly)
      body = { ...body, windowOnly: false };
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (path === '/screen/parse' && parsed?.elements?.length)
            _normParseSpace(parsed, !!body?.windowOnly);
          resolve(parsed);
        }
        catch (e) { reject(new Error(`bad JSON from ${path}: ${data.slice(0, 200)}`)); }
      });
    });
    const onAbort = () => req.destroy(_cancelledError());
    _ACT_SIGNAL?.addEventListener('abort', onAbort, { once: true });
    const unbind = () => _ACT_SIGNAL?.removeEventListener('abort', onAbort);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { unbind(); reject(e); });
    req.on('close', unbind);
    req.end(payload);
  });
}

// ── DOM element source (browser tasks) ──────────────────────────────────────
// When the destination is a web page, the DOM IS the authoritative element
// list — real aria-labels, real button bounds, no OCR. The ThinkDrop Chrome
// extension's snapshot supplies it; macOS chrome (file pickers) stays on the
// OCR path since it isn't DOM. Coordinates map viewport CSS px → screen
// points via the window's bounds and innerHeight-derived toolbar height.
const _DOM_ROLES = { textbox: 'field', searchbox: 'field',
  combobox: 'select', listbox: 'select',
  button: 'button', link: 'link', tab: 'tab', menuitem: 'menuitem',
  option: 'option', checkbox: 'checkbox', switch: 'checkbox', radio: 'radio' };
let _domGeo = { t: 0, win: null };
async function _domObserve(ctx) {
  const bail = (why) => { if (!ctx._domBail) { ctx._domBail = true; logger.warn(`[screen.act] dom observe unavailable: ${why}`); } return null; };
  let gw;
  try { gw = require('../ext.gateway.cjs'); } catch { return bail('no gateway'); }
  if (!gw.hasExtension()) return bail('extension not connected');
  // Geometry: window bounds (AppleScript, cached ~1.5s) + viewport size.
  if (Date.now() - _domGeo.t > 1500) {
    const app = ctx.browserName || ctx.app || 'Google Chrome';
    const out = await new Promise(r => execFile('osascript',
      ['-e', `tell application "${app}" to get bounds of front window`],
      (e, o) => r(e ? null : o))).catch(() => null);
    const b = out && out.trim().split(',').map(Number);
    _domGeo = { t: Date.now(), win: b && b.length === 4 && b.every(n => isFinite(n)) ? b : null };
  }
  if (!_domGeo.win) return bail('no window bounds');
  const [wx, wy, ww, wh] = _domGeo.win;
  let scanner = null;
  try { scanner = require('./browser-engine.cjs')._DOM_SCANNER_SCRIPT; } catch {}
  if (!scanner) return bail('no DOM scanner script');
  const [snapRes, geoRes] = await Promise.all([
    gw.sendCmd({ sessionId: 'default', action: 'snapshot', args: { scannerScript: scanner } }, 15000).catch(() => null),
    gw.sendCmd({ sessionId: 'default', action: 'evaluate', args: { expression: 'JSON.stringify({w:innerWidth,h:innerHeight})' } }, 8000).catch(() => null),
  ]);
  if (!snapRes?.ok) return bail(`snapshot failed: ${snapRes?.error || 'no result'}`);
  if (!snapRes.result?.elements?.length) return bail('snapshot returned 0 elements');
  let vp = null;
  try { vp = JSON.parse(geoRes?.result || 'null'); } catch {}
  const sx = vp?.w ? ww / vp.w : 1;
  const toolbarH = vp?.h ? Math.max(0, wh - vp.h * sx) : 0;
  const elements = snapRes.result.elements
    .filter(e => e.visible !== false && e.rect && e.rect.width >= 2 && e.rect.height >= 2)
    .map((e, i) => {
      const x = wx + e.rect.x * sx, y = wy + toolbarH + e.rect.y * sx;
      const w = e.rect.width * sx, h = e.rect.height * sx;
      // Only genuinely typable inputs are 'text' — range sliders (volume,
      // seek), checkboxes, hidden/button inputs accept .value writes but
      // aren't text fields and must never receive typed entity text.
      const _typable = e.tag === 'textarea'
        || (e.tag === 'input' && /^(|text|search|email|url|password|number|tel)$/i.test(e.type || ''));
      return {
        id: `dom_${e.ref || i}`, type: _typable ? 'text' : 'icon',
        label: String(e.label || e.placeholder || '').slice(0, 120),
        bbox: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)],
        center: [Math.round(x + w / 2), Math.round(y + h / 2)],
        w: Math.round(w), h: Math.round(h),
        _role: (_DOM_ROLES[e.role] || _DOM_ROLES[e.type] || null) === 'field' && !_typable
          ? null : (_DOM_ROLES[e.role] || _DOM_ROLES[e.type] || null),
        _dom: true, _ref: e.ref, tag: e.tag, occluded: !!e.occluded,
        ancestors: e.ancestors || [], state: e.state || {}, keys: e.keys || '',
        region: e.region, placeholder: e.placeholder || '',
      };
    });
  if (elements.length < 3) return bail(`only ${elements.length} usable elements`);
  // Scene graph — the tree is the world-model; flat elements get annotated
  // with container/scope/membership so the walk keeps working unchanged.
  const sg = require('../skill-helpers/scene.graph.cjs');
  sg.annotateElements(elements, 'dom');
  const { tree } = sg.buildDomTree(elements, {
    app: ctx.browserName || ctx.app || 'Google Chrome',
    domain: snapRes.result.url || 'unknown' });
  return { flat: elements, tree, domain: snapRes.result.url || 'unknown', title: snapRes.result.title || '' };
}

// ── AX element source (native + browser — no extension) ─────────────────────
// td-ax walks the frontmost/target app's accessibility tree. Chromium and
// Electron publish their real DOM under --enhance, so a browser page and a
// native window arrive in the same shape: role, label, geometry, ancestors
// (nearest-first), state, value — everything the scene tree consumes.
// macOS only exposes AXWindows for the fronted app, so this runs AFTER the
// focus guard refocuses ctx.app; an unfocused/background target yields 0
// elements and the caller falls through to OCR.
const _AX_BIN = require('path').join(__dirname, '..', '..', '..', 'screen-intelligence-service', 'native', 'bin', 'td-ax');
const _AX_ROLES = {
  button: 'button', link: 'link', tab: 'tab', menuitem: 'menuitem',
  menuitemradio: 'menuitem', menubutton: 'button', popupbutton: 'select',
  textfield: 'field', textarea: 'field', searchfield: 'field',
  combobox: 'field', checkbox: 'checkbox', radiobutton: 'radio',
  switch: 'checkbox', slider: 'slider',
  list: 'listbox', listbox: 'listbox', outline: 'listbox', grid: 'listbox',
  table: 'listbox', browser: 'container', scrollarea: 'container',
  row: 'listitem', cell: 'listitem', listitem: 'listitem', outlinegroup: 'listitem',
  option: 'menuitem', radiogroup: 'container', tabgroup: 'container',
  menu: 'menu', popover: 'popover', dialog: 'dialog', sheet: 'dialog',
  group: 'group', heading: 'heading', image: 'icon', statictext: 'doctext',
  toolbar: 'container', webarea: 'webarea', disclosuretriangle: 'button',
  incrementor: 'button', valueindicator: 'doctext', busyindicator: 'doctext',
};
async function _axObserve(ctx, frontApp, _retried) {
  const bail = (why, permanent = false) => {
    if (permanent) ctx._axBail = true;               // missing binary — never retry
    if (!ctx._axBailWarned?.has(why)) {
      (ctx._axBailWarned || (ctx._axBailWarned = new Set())).add(why);
      logger.warn(`[screen.act] ax observe unavailable: ${why}`);
    }
    return null;
  };
  try { require('fs').accessSync(_AX_BIN); } catch { return bail('td-ax binary missing', true); }
  const app = ctx.app || ctx.browserName || frontApp;
  // Bundle id when the app is mapped — "--app 'Google Chrome'" fuzzy-matches
  // "Google Chrome for Testing" (a separate bundle) and returns its chrome
  // chrome instead of the real window's web tree.
  const _bf = require('./screen.task.agent.cjs')._internals?._bundleFor;
  const args = ['--enhance', '--max-elements', '500', '--json-only'];
  if (app) args.unshift('--app', String(_bf?.(app) || app));
  const run = () => new Promise(r => execFile(_AX_BIN, args,
    { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
    (e, o) => r(e ? null : o)));
  let out = await run();
  let doc = null;
  try { doc = out && JSON.parse(out); } catch {}
  // AXWindows is empty until the app has a fronted window — activate and
  // retry once before bailing to OCR.
  if ((!doc || (doc.meta?.windows === 0) || (doc.elements || []).length < 3) && app) {
    await new Promise(r => execFile('osascript',
      ['-e', `tell application "${app}" to activate`], () => setTimeout(r, 600)));
    out = await run();
    try { doc = out && JSON.parse(out); } catch { doc = null; }
  }
  if (!doc) return bail(out == null ? 'td-ax exited non-zero or timed out' : 'td-ax bad JSON');
  const raw = doc?.elements || [];
  if (raw.length < 3) return bail(`only ${raw.length} elements`);
  // Window scope — other windows' elements (background tabs, second
  // windows) can carry stale coordinates that click through onto whatever
  // is on top. Keep the focused window; when no focus info, keep window 0.
  // Window choice is by WEB-CONTENT count, not raw count — a focused window
  // whose active tab isn't the task page publishes a stub webarea (28 els
  // vs Spotify's ~150), and a tool palette can out-count a real page in raw
  // elements while having zero web content.
  const focusWin = doc.meta?.focused_window ?? 0;
  const _isWebEl = e => (e.ancestors || []).some(a =>
    /^(AX)?(webarea|browser)$/i.test(String(a.role || '')));
  const webCount = w => raw.filter(e => (e.win < 0 || e.win === w) && _isWebEl(e)).length;
  let scopeWin = focusWin;
  if ((doc.meta?.windows || 0) > 1) {
    let best = scopeWin, bestN = webCount(scopeWin);
    for (let w = 0; w < (doc.meta.windows || 0); w++) {
      const n = webCount(w);
      if (n > bestN) { best = w; bestN = n; }
    }
    // Yield to a richer web window only when the focused one is thin —
    // otherwise focus still wins (stale-coordinate clicks).
    if (bestN >= 25 && webCount(focusWin) < 25) scopeWin = best;
  }
  let scoped = (doc.meta?.windows || 0) > 1
    ? raw.filter(e => e.win < 0 || e.win === scopeWin
        || /^AX(Menu|Popover|Dialog|Sheet)/.test(String(e.role || ''))
        || (e.ancestors || []).some(a => /^AX(Menu|Popover|Dialog|Sheet)/.test(String(a.role || ''))))
    : raw;
  const normAnc = a => ({
    role: String(a.role || '').replace(/^AX/, '').toLowerCase(),
    label: String(a.label || '').slice(0, 80),
  });
  let elements = scoped
    .filter(e => e.w >= 2 && e.h >= 2)
    .map(e => {
      const role = String(e.role || '').replace(/^AX/, '').toLowerCase();
      const typable = _AX_ROLES[role] === 'field';
      return {
        id: `ax_${e.id}`, type: typable ? 'text' : 'icon',
        label: String(e.label || '').slice(0, 120),
        bbox: [Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h)],
        center: [Math.round(e.x + e.w / 2), Math.round(e.y + e.h / 2)],
        w: Math.round(e.w), h: Math.round(e.h),
        _role: _AX_ROLES[role] || null,
        _ax: true, tag: role,
        ancestors: (e.ancestors || []).map(normAnc),
        state: { focused: !!e.focused, expanded: !!e.expanded, selected: !!e.selected },
        keys: e.keys || '',
        region: e.region || 'content',
        placeholder: '',
        value: e.value || '',
      };
    });
  // Web-content scope — browser chrome (tab strip, omnibox, toolbar,
  // bookmarks) is in the same AX tree but never a web-task target. Elements
  // under a webarea/browser ancestor are page content; when the app has
  // none (native app), keep everything.
  const inWeb = elements.filter(e =>
    (e.ancestors || []).some(a => /^(webarea|browser)$/.test(a.role)));
  // Transient layers (menus, popovers, dialogs) hang off AXMenu/AXPopover
  // ancestors, not the webarea — scope filtering must never drop them or an
  // open menu becomes invisible to the armed lanes.
  const inLayer = elements.filter(e =>
    (e.ancestors || []).some(a => /^(menu|popover|dialog|sheet|listbox)$/.test(a.role)));
  const hasWebTree = elements.some(e =>
    (e.ancestors || []).some(a => /^webarea$/.test(a.role)) || e.tag === 'webarea');
  if (hasWebTree || (ctx._domain === 'url')) {
    // Browser: page content only — tab strip, omnibox, toolbar, and
    // extension buttons live in the same tree but are never web-task
    // targets. No published web tree on a url task → bail to OCR rather
    // than walk browser chrome.
    if (inWeb.length < 10) {
      // Chrome publishes web AX lazily — the first walk after focus can
      // return a stub tree (~0-3 web children). Real pages are richer;
      // Spotify virtualizes (~28 visible rows) which is content, not a
      // stub — so only retry when the count is truly degenerate.
      if (!_retried) {
        await new Promise(r => setTimeout(r, 700));
        return _axObserve(ctx, frontApp, true);
      }
      if (inWeb.length < 3 && inLayer.length < 3) return bail('no web-area content published');
    }
    elements = [...inWeb, ...inLayer.filter(e => !inWeb.includes(e))];
  }
  const sg = require('../skill-helpers/scene.graph.cjs');
  sg.annotateElements(elements, 'dom');
  const domain = doc.meta?.url || doc.meta?.app || 'native';
  const { tree } = sg.buildDomTree(elements, { app: doc.meta?.app || app || 'app', domain });
  return { flat: elements, tree, domain, title: '', src: 'ax',
           windows: doc.meta?.windows ?? null, focusedWindow: doc.meta?.focused_window ?? null,
           url: doc.meta?.url || '' };
}

// ── Region parse + fingerprint diff ─────────────────────────────────────────
// rect:[x,y,w,h] points (screen space — same as element bbox). Crops parse
// ~10x faster than full frames and run .accurate OCR. cursor:false excludes
// the rendered glyph so hover/verify diffs aren't polluted by the pointer.
async function rectParse(rectPt, { display, windowOnly, wantImage = false, cursor = false } = {}) {
  return post('/screen/parse', { display, windowOnly, rect: rectPt, wantImage, cursor }).catch(() => null);
}

// Focused menu-region probe — a transient context menu is routinely missed
// by whole-window merged OCR (sparse text, short dwell). A tight crop around
// the click point re-parses with .accurate OCR at ~10x speed and catches the
// popup every time. Coords come back crop-local → translate to screen space.
async function _probeRect(rect, { display, windowOnly } = {}) {
  const [rx, ry, rw, rh] = rect.map(Math.round);
  const scan = await rectParse([rx, ry, rw, rh], { display, windowOnly, cursor: false });
  return (scan?.elements || []).filter(e => e.center);
}

async function _menuProbe(armPt, { display, windowOnly } = {}) {
  if (!armPt) return [];
  // Menus open downward from the click — but rows near the window bottom
  // flip upward. Cover both directions: 300px above, 260 below.
  return _probeRect(
    [Math.max(0, armPt[0] - 40), Math.max(0, armPt[1] - 300), 620, 560],
    { display, windowOnly },
  );
}

// Element bbox + padding — crop needs context edges, not a sliver of glyph.
function cropRectFor(e, pad = 26) {
  const [x, y, w, h] = e?.bbox || [0, 0, 0, 0];
  return [Math.max(0, Math.round(x - pad)), Math.max(0, Math.round(y - pad)),
          Math.round(w + pad * 2), Math.round(h + pad * 2)];
}

function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  const POP = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

// 256-bit aHash: brightness-invariant — structure changes flip many bits,
// a uniform glow/darken flips few. lum captures the brightness shift itself:
//   structural (h>40)      → icon swap, dialog open, content change
//   glow (h 12-40 | lumΔ>8) → hover highlight, underline, shade shift
//   none                    → unchanged region
function fpDiff(before, after) {
  const h = hammingHex(before?.phash, after?.phash);
  if (h < 0) return { changed: null };
  const lumDelta = Math.abs((before?.lum ?? 0) - (after?.lum ?? 0));
  const structural = h > 40;
  const glow = !structural && (h > 12 || lumDelta > 8);
  return { hamming: h, lumDelta, changed: structural || glow,
           kind: structural ? 'structural' : glow ? 'glow' : 'none' };
}

// ── Recursive hover-reveal probing ──────────────────────────────────────────
// A hover is a traversal, not a check: hovering an element diffs the WHOLE
// focused-window domain for newly-appeared elements (a ••• in region A can
// reveal a flyout menu in region B). Each revealed element is itself a probe
// node — DFS until leaves yield only style/tooltip change → decision points.
async function _probeDomain(ctx, display, windowOnly, parsed) {
  const ax = await _axObserve(ctx, parsed?.front_app).catch(() => null);
  if (ax?.flat?.length) return ax.flat;
  const wp = await rectParse(null, { display, windowOnly }).catch(() => null);
  return wp?.elements || [];
}

// Evidence classes: 'fit' (goal action+object), 'route' (advances toward the
// goal without naming it — More options, Add to playlist), 'wrong-object'
// (verb matches but object doesn't — Add to Liked Songs), 'none'.
function _evidenceFit(label, goal, ctx, role) {
  const g = String(goal || '');
  const appWord = (g.match(/\b(?:on|in|using)\s+([A-Za-z0-9]+)\s*$/i) || [])[1];
  const gWords = new Set(g.toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && w !== String(appWord || '').toLowerCase()));
  const l = String(label || '');
  // Categorical affordance veto — Follow/Subscribe/Upgrade/Play/Shuffle are
  // actions with their own objects; on a non-matching goal they're traps,
  // not candidates.
  if (/\b(follow|following|subscribe|upgrade|premium|install|donate|buy now|sign up)\b/i.test(l)
      && !new RegExp(l.toLowerCase().match(/follow|subscribe|upgrade|premium|install|donate|buy|sign/)?.[0] || '$^', 'i').test(g))
    return 'wrong-object';
  const dest = ctx?.destination ? String(ctx.destination).toLowerCase() : null;
  if (dest) {
    const GENERIC = /^(playlists?|folders?|lists?|albums?|collections?|boards?|carts?|queues?|library|songs?|items?|files?|selection|it)$/i;
    const obj = l.toLowerCase()
      .match(/\b(?:add|save|put|insert|move|copy|send|share|assign)\b[^a-z0-9]+(?:to\s+)?(?:my\s+|the\s+|a\s+|your\s+)?([a-z0-9][a-z0-9 '&-]{1,40})/i)?.[1]?.trim();
    // Merged labels fuse CTA/placeholder text into the object tail ("Add to
    // playlist Let's find s Q Search fo" → "playlist let's find s q...").
    // The LEADING noun is the real object — generic container stays legal.
    const objHead = (obj || '').split(/\s+/)[0] || '';
    if (obj && !GENERIC.test(obj) && !GENERIC.test(objHead)
        && !obj.includes(dest) && !dest.includes(obj))
      return 'wrong-object';
    // Route-forward — advances toward the destination without naming it.
    if (ctx.memory?.pendingVerify?.length
        && /more\b|options?\b|…|⋯|\.\.\.|•••|add to (playlist|folder|list|collection|board|library)/i.test(l))
      return 'route';
  }
  const fits = l.toLowerCase().split(/[^a-z0-9]+/).some(w => gWords.has(w));
  // A word-fit alone isn't a hit for plain nouns ("Lecrae playlist" is a
  // navigational row, not an action) — hits need an action affordance or a
  // decisive role.
  const ACTIONISH = /add|remove|more|options?|…|⋯|•••|\.\.\.|\+|plus|delete|share|save|edit|new|create|search|open|queue/i;
  if (fits && (ACTIONISH.test(l) || /menuitem|button|option|checkbox|radio/.test(String(role || ''))))
    return 'fit';
  return 'none';
}

// Tight reveal fingerprint — 16px/role bucket. The coarse _fpLoose bucket
// re-renders ambient text as "new"; a same-role element within ~16px is the
// SAME one. MUST be identical for seeding and diffing — mixing fps makes
// every ambient element a false reveal.
// fp is position + label-head, NOT role — els is an OCR+AX merge while
// _probeDomain prefers AX-then-OCR, so the same physical element arrives
// with different type/_role strings across sources. Position+label is the
// source-agnostic identity.
const _probeFp = e => `${Math.round((e.center?.[0] || 0) / 24)}:${Math.round((e.center?.[1] || 0) / 24)}|${
  String(e.label || e._role || e.tag || e.type || '').toLowerCase().replace(/[^a-z0-9+]/g, '').slice(0, 14)}`;

async function probeReveal(node, { display, windowOnly, sessionId, ctx, parsed, goal, emit, state }) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true };
  if (!node?.center || state.budget.n <= 0) return { hit: null, fit: null, revealed: [] };
  state.budget.n--;
  await mouseAgent({ action: 'move', x: node.center[0], y: node.center[1], sessionId }).catch(() => null);
  await new Promise(r => setTimeout(r, 800)); // hover affordances publish ~600-800ms
  let after = await _probeDomain(ctx, display, windowOnly, parsed);
  const fp = _probeFp;
  let fresh = after.filter(e => e.center && !state.before.has(fp(e)));
  if (!fresh.length) {
    // Slow-publish retry — hover-only buttons (Spotify +/•••) mount into the
    // AX tree asynchronously; a second snapshot catches them. Glyph fallback:
    // a row-band crop parse isolates •••/+ icons the domain-wide OCR misses.
    await new Promise(r => setTimeout(r, 400));
    after = await _probeDomain(ctx, display, windowOnly, parsed);
    fresh = after.filter(e => e.center && !state.before.has(fp(e)));
    if (!fresh.length && node.bbox) {
      const _bx = Math.max(0, Math.round(node.bbox[0] - 20)), _by = Math.round(node.bbox[1] - 6);
      const _bw = Math.round(node.bbox[2] + 160), _bh = Math.round(node.bbox[3] + 12);
      const band = await rectParse([_bx, _by, _bw, _bh], { display, windowOnly }).catch(() => null);
      const bandEls = (band?.elements || []).filter(e => e.center);
      // Crop-local coords → translate by the crop origin (same convention as
      // deep-parse above).
      const local = bandEls.every(e => e.center[0] <= _bw + 8 && e.center[1] <= _bh + 8);
      if (local) bandEls.forEach(e => {
        e.center = [e.center[0] + _bx, e.center[1] + _by];
        if (e.bbox) e.bbox = [e.bbox[0] + _bx, e.bbox[1] + _by, e.bbox[2], e.bbox[3]];
      });
      fresh = bandEls.filter(e => e.center && !state.before.has(fp(e)));
    }
  }
  const revealed = [];
  for (const e of fresh) {
    state.before.add(fp(e));
    e._revealedBy = node.id || String(node.label || '').slice(0, 30);
    e._depth = state.depth;
    revealed.push(e);
  }
  // Leaf decision — a revealed element whose own evidence fits the goal
  // (or the route toward it) is the commit target.
  const _INTERACTIVE = /button|menuitem|link|option|field|checkbox|tab|menu|listbox|dialog|radio|select|listitem/;
  const interactive = revealed.filter(e => _INTERACTIVE.test(String(e._role || e.tag || e.type || ''))
    // Containment > role — elements inside an open menu/dialog are
    // interactive whatever their own role (unmapped AX roles emit null).
    || e._inOpenMenu || (e.ancestors || []).some(a => /menu|dialog|listbox|popover/.test(String(a.role || ''))));
  for (const e of revealed) {
    const fit = _evidenceFit(e.label, goal, ctx, e._role || e.tag);
    if (fit === 'fit' || fit === 'route') {
      emit(`probe: reveal-hit "${String(e.label || '').slice(0, 40)}" d${state.depth} (${fit})`);
      return { hit: e, fit, revealed };
    }
  }
  // Recurse — every revealed element is a probe node: interactive roles
  // first, then icons/small elements (a "+" is only meaningful via ITS
  // reveal). Menus fly out of menus; hover shows what each node opens.
  if (state.depth < 4) {
    const rest = revealed.filter(e => !interactive.includes(e));
    const nodes = interactive.concat(rest).slice(0, 6);
    for (const e of nodes) {
      const k = fp(e);
      if (state.visited.has(k)) continue;
      state.visited.add(k);
      emit(`probe: d${state.depth + 1} hovering "${String(e.label || e.tag || 'icon').slice(0, 34)}"`);
      const r = await probeReveal(e, { display, windowOnly, sessionId, ctx, parsed, goal, emit,
        state: { ...state, depth: state.depth + 1 } });
      revealed.push(...(r.revealed || []));
      if (r.hit) return { ...r, revealed };
    }
  }
  return { hit: null, fit: null, revealed };
}

// ── Tab/window awareness ────────────────────────────────────────────────────
// A click can spawn a tab or window without the domain string changing.
// AppleScript drives tab/window jumps deterministically — NO keystrokes
// (Cmd+Shift+Tab/Cmd+W injection triggered the app switcher once already).
async function _tabProbe(ctx) {
  const app = ctx.app || ctx.browserName || '';
  const isSafari = /safari/i.test(app);
  const script = /chrome|edge|brave|arc|chromium|vivaldi|opera/i.test(app) || isSafari
    ? `tell application "${app}" to get {count of tabs of front window, URL of ${isSafari ? 'current' : 'active'} tab of front window}`
    : null;
  if (!script) return null;
  // "index of active tab" throws on some Chrome builds — query count+URL
  // only; a URL change already signals the tab jump we care about.
  const out = await new Promise(r => execFile('osascript', ['-e', script],
    { timeout: 3000 }, (e, o) => r(e ? null : String(o).trim())));
  const m = out && out.match(/(\d+),\s*(.+)/);
  return m ? { count: +m[1], active: null, url: m[2] } : null;
}

// Deterministic jumps — focus a tab, raise a window, close the active tab.
async function _focusTab(app, index) {
  if (!app || !index) return false;
  const script = /safari/i.test(app)
    ? `tell application "${app}" to set current tab of front window to tab ${index} of front window`
    : `tell application "${app}" to set active tab index of front window to ${index}`;
  return new Promise(r => execFile('osascript', ['-e', script],
    { timeout: 3000 }, (e) => r(!e)));
}

// Re-pin by URL marker — the front WINDOW can drift to another Chrome window
// mid-run (observed: doc surface swapped for a YouTube window); enumerate
// every window's tabs, activate the marker match, raise its window.
async function _focusTabMatch(app, match) {
  if (!app || !match) return false;
  const isSafari = /safari/i.test(app);
  const esc = String(match).replace(/"/g, '');
  const script = `tell application "${app}"\n`
    + `  repeat with w from 1 to count of windows\n`
    + `    repeat with t from 1 to count of tabs of window w\n`
    + `      if (URL of tab t of window w) contains "${esc}" then\n`
    + `        ${isSafari ? `set current tab of window w to tab t of window w` : `set active tab index of window w to t`}\n`
    + `        set index of window w to 1\n`
    + `        return "ok"\n`
    + `      end if\n`
    + `    end repeat\n`
    + `  end repeat\n`
    + `end tell`;
  const out = await new Promise(r => execFile('osascript', ['-e', script],
    { timeout: 4000 }, (e, o) => r(e ? null : String(o).trim())));
  return out === 'ok';
}
async function _closeActiveTab(app) {
  if (!app) return false;
  const script = /safari/i.test(app)
    ? `tell application "${app}" to close current tab of front window`
    : `tell application "${app}" to close active tab of front window`;
  return new Promise(r => execFile('osascript', ['-e', script],
    { timeout: 3000 }, (e) => r(!e)));
}
async function _raiseWindow(app, winIndex) {
  if (!app) return false;
  const script = /safari|chrome|edge|brave|arc|chromium|vivaldi|opera/i.test(app)
    ? `tell application "${app}" to set index of window ${winIndex} to 1`
    : `tell application "System Events" to tell process "${app}" to perform action "AXRaise" of window ${winIndex}`;
  return new Promise(r => execFile('osascript', ['-e', script],
    { timeout: 3000 }, (e) => r(!e)));
}

// ── Hover probe: pre-commit evidence gather ─────────────────────────────────
// Move → settle → re-parse the element rect (affordance diff) + the zone
// below (tooltip OCR). Returns {affordance, kind, tooltip, dead} — the
// caller decides; the probe never clicks.
async function probeCandidate(cand, { display, windowOnly, sessionId, ctx, els, parsed, intent, goal } = {}) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true };
  const elRect = cropRectFor(cand, 26);
  const [cx, cy] = cand.center || [];
  if (cx == null) return { dead: true, reason: 'no center' };
  const emit = (msg) => { try { ctx?.emit?.(msg); } catch (_) {} };
  // Infer before Hover — a categorical role veto kills the candidate without
  // moving the mouse (omnibox for type intent, doctext, windowchrome).
  inferRole(cand, els || [], parsed);
  const veto = roleVeto(cand, intent || 'click', goal);
  if (veto) { emit(`infer: ${veto}`); return { dead: true, reason: `role:${cand._role}`, veto }; }
  emit(`probe: hovering "${String(cand.label || `#${cand.id}`).slice(0, 40)}"`);
  const before = await rectParse(elRect, { display, windowOnly });
  await mouseAgent({ action: 'move', x: cx, y: cy, sessionId }).catch(() => null);
  // Reveal latency (~150ms) beats tooltip latency (~450ms): hover-surfaced
  // controls render at CSS speed — rescan early, and only pay the remaining
  // tooltip wait when nothing revealed (a label is the evidence left).
  await new Promise(r => setTimeout(r, 160));
  // tooltip zone: element rect extended below (macOS tooltips render under
  // the element); element-only diff needs its own fingerprint pass.
  const tipRect = [elRect[0], elRect[1], elRect[2], elRect[3] + 110];
  const afterEl = await rectParse(elRect, { display, windowOnly });
  const _beforeFps = new Set((before?.elements || []).map(_probeFp));
  if (!(afterEl?.elements || []).some(e => !_beforeFps.has(_probeFp(e))))
    await new Promise(r => setTimeout(r, 290));
  const afterZone = await rectParse(tipRect, { display, windowOnly });
  const d = fpDiff(before, afterEl);
  const beforeLbl = new Set((before?.elements || []).map(e => String(e.label || '')));
  const ownLbl = String(cand.label || '');
  const tooltip = (afterZone?.elements || [])
    .map(e => String(e.label || '').trim())
    .filter(l => l && !beforeLbl.has(l) && l !== ownLbl)
    .join(' ').trim();
  // Domain reveal-diff — the WHOLE focused window/webarea, not a region:
  // a ••• hover can reveal a flyout menu in region B. probeReveal recurses
  // into revealed nodes (menu → submenu) until leaves yield nothing new.
  const state = { before: new Set((els || []).map(_probeFp)),
    visited: new Set([_probeFp(cand)]), budget: { n: ctx._probeBudget ?? 7 }, depth: 0 };
  const rr = await probeReveal(cand, { display, windowOnly, sessionId, ctx, parsed, goal, emit, state });
  const revealed = rr.revealed || [];
  if (tooltip) emit(`probe: tooltip "${tooltip.slice(0, 50)}"`);
  else if (rr.hit) { /* reveal-hit already emitted */ }
  else if (revealed.length) emit(`probe: hover revealed ${revealed.length} element(s)`);
  else if (d.changed) emit(`probe: hover state changed (${d.kind})`);
  else emit('probe: no evidence');
  return { affordance: d.changed === true, kind: d.kind || 'none',
           tooltip: tooltip || null, revealed, hit: rr.hit || null, hitFit: rr.fit || null,
           dead: !tooltip && !rr.hit && !revealed.length && d.changed === false };
}

// The decision model can't pick well over 90+ options — rank and cap.
// Priority: labeled elements > icons > doc-text lines; keyword overlap with
// the goal boosts rank hard. Menubar/dock/system noise excluded by caller.
function shortlist(elements, goal, parsed) {
  // Scoring words — whole-word matches only ("and" must not hit "L**and**"),
  // minus stopwords/verbs that carry no target meaning. Entity terms ("KB",
  // quoted names, called/named spans) score regardless of length — they're
  // the payload, not noise.
  const STOP = new Set(['the','and','for','with','from','that','this','your','you','all','any','some','into','onto','out','off','are','was','were','been','have','has','had','not','but','can','will','would','should','could','get','got','make','made','add','put','set','new','use','using','via','per','each','every','them','they','their','then','than','when','what','who','how','why','which','while','about','after','before','over','under','again','once','just','also','too','more','most','other','another','much','many','few','now','still','back','only','even','well','here','there','please']);
  // Venue words name the DESTINATION, not a target on it — "spotify" appears
  // on every Spotify-branded element (promos, download banners, the logo), so
  // scoring it sends the walk into download buttons. Same for browser/app
  // framing words that describe where, not what.
  const VENUE = new Set(['spotify','youtube','gmail','google','slack','docs','calendar','chrome','safari','firefox','edge','desktop','browser','website','site','web','online','app','application','player','page','screen','window']);
  const words = new Set(goal.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w) && !VENUE.has(w)));
  for (const t of flowCache.extractEntities(goal)) {
    const tl = String(t).toLowerCase();
    if (!VENUE.has(tl)) words.add(tl);
  }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wantsType = /\b(type|enter|input|fill|write|rename|search|name)\b/i.test(goal || '');
  const scored = elements.map(e => {
    inferRole(e, elements, parsed);
    const label = (e.label || '').toLowerCase();
    let s = 0;
    if (e.type === 'icon' && label) s += 3;
    if (e.type === 'text') s += 1;
    if (_looksLikeInput(e)) s += 4;                    // typing targets matter
    // Role-aware scoring — inferRole's category tree replaces ad-hoc
    // penalties: omnibox/windowchrome are near-dead candidates for any
    // UI goal; fields lead when the goal is typing.
    if (e._role === 'omnibox' || e._role === 'windowchrome') s -= 12;
    if (e._role === 'doctext' && e._roleConf === 'hard') s -= 6;
    if (wantsType && e._role === 'field') s += 6;
    for (const w of words) {
      if (!new RegExp(`\\b${esc(w)}\\b`, 'i').test(label)) continue;
      // Unit collisions — "1,824 KB" (a file size) is not artist "KB".
      if (/^(kb|mb|gb|tb|px|ms|min|hr|hrs|sec)$/.test(w) && new RegExp(`[\\d,.]\\s*${esc(w)}\\b`, 'i').test(label)) continue;
      s += 10;
    }
    s += (e.conf || 0);                     // detector confidence tiebreak
    if (label.length > 80) s -= 2;          // long OCR lines are usually doc text
    e._score = s;                           // walk uses this as commit floor
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.filter(x => x.s > 0).slice(0, MAX_CANDIDATES).map(x => x.e);
}

// Placeholder-like OCR text or wide-thin bbox → probably an input field.
// Element inside an open menu/dialog/listbox/popover — containment over
// role, same test the scoring loop inlines.
function _menuishEl(e) {
  return !!(e._inOpenMenu || e._ocrMenu
    || /menuitem|option|radio/.test(String(e._role || ''))
    || /menu|dialog|listbox|popover/.test(String(e._containerRole || ''))
    || (e.ancestors || []).some(a => /menu|dialog|listbox|popover/.test(String(a.role || ''))));
}

// Work-item identity — value, not render noise: "…2 seconds ago" recency
// tails and OCR punctuation must not make a just-removed row look new.
function _workKey(l) {
  return String(l || '').toLowerCase()
    .replace(/\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago.*$/i, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}
// Stable tail identity — OCR noise mutates label HEADS ("About tri
// ForArtists" → "tWbout ForArtists") but the trailing tokens survive.
// armTries/badWork keyed on the tail can't be dodged by head mutation.
function _workTail(l) {
  const w = _workKey(l).split(' ').filter(t => t.length > 1);
  return w.slice(-2).join(' ');
}
// Work-item row — carries a duration/recency cell or composite member
// structure. The add and remove lanes share this admission bar: container
// cards ABOUT an entity ("Lecrae playlist") never pass it.
function _isWorkRow(e) {
  const l = String(e?.label || '');
  return !!(e?._isRow || (e?._members || []).length >= 2
    || /\d{1,2}:\d{2}/.test(l)
    || /\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/i.test(l));
}

// Work-item equality: full-key containment OR tail equality (tail ≥6 chars
// so "to" / "3 42" fragments can't collide).
function _sameWork(a, b) {
  if (!a || !b) return false;
  const ka = _workKey(a), kb = _workKey(b);

  if (ka === kb || (ka.length >= 8 && (ka.includes(kb) || kb.includes(ka)))) return true;
  // Shared head ≥15 chars — OCR appends row-member text ("…5 songs
  // Createfold" vs "…5 songs Getting started") mutating the TAIL; the
  // leading entity name is what survives.
  let i = 0;
  while (i < ka.length && i < kb.length && ka[i] === kb[i]) i++;
  if (i >= 15) return true;
  const ta = _workTail(a), tb = _workTail(b);
  return ta.length >= 6 && ta === tb;
}

// ── Position-aware post-arm freshness ─────────────────────────────────────
// Label-only set-diff fails twice: a stale menu left open during the arm
// snapshot poisons preArmLabels with menu item text ("Delete" reads as
// pre-existing → the REAL menu diffs to nothing), and OCR-mutated row labels
// read as fresh ("Liked Songs Pla*st" isn't an exact member). Store
// label → [y-bins] (40px granularity): fuzzy label match within ±1 bin is
// the SAME element; a matching label at a NEW position IS fresh — menus
// re-use item text, and "Delete" at y=600 wasn't the "Delete" at y=300.
function _preArmSnap(els) {
  const m = new Map();
  for (const e of els) {
    const l = String(e.label || '').trim();
    if (l.length < 2) continue;
    const yb = e.center ? Math.round(e.center[1] / 40) : -9999;
    const arr = m.get(l); if (arr) arr.push(yb); else m.set(l, [yb]);
  }
  return m;
}
function _freshAfterArm(preArm, label, center) {
  const t = String(label || '').trim();
  if (!t || !preArm) return false;
  const yb = center ? Math.round(center[1] / 40) : null;
  for (const [pl, ys] of preArm) {
    if (pl !== t && !_vocab.fuzzyMatch(pl, t)) continue;
    if (yb == null) return false;                        // label existed pre-arm
    if (ys.some(y => Math.abs(y - yb) <= 1)) return false; // same label, same place
    // matching label but elsewhere → fresh (new menu item / moved row)
  }
  return true;
}
function _isBrowserMenu(els) {
  return els.filter(e => _vocab.BROWSER_MENU.test(String(e.label || ''))).length >= 2;
}

function _looksLikeInput(e) {
  const l = (e.label || '').toLowerCase();
  if (/\b(ask|search|type|enter|write|chat|message|comment|reply|input)\b/.test(l)) return true;
  // Content rows are also wide+short text — a substantive label (song title,
  // list row, prose) is FILLED content, not an empty input. Real placeholders
  // stay short ("Search…", "Name") and carry no sentence punctuation,
  // artist separators, or durations.
  if (e._isRow || l.length > 30) return false;
  if (/[.!?•]|\d{1,2}:\d{2}|\bfeat\.?\b|\bft\.?\b|\bby\b/i.test(l)) return false;
  const [x, y, w, h] = e.bbox || [0, 0, 0, 0];
  return w > 120 && h > 0 && h < 45 && e.type === 'text';
}

// A filled input's OCR label is its VALUE ('My Playlist #7'), not its purpose —
// two fields in one dialog are indistinguishable without the caption text that
// sits above/beside them ('Name', 'Description'). Attach the nearest small
// label directly above the field (or left-aligned at its top edge) so the model
// can tell "field: Name" from "field: Description".
function _attachCaptions(els) {
  const fields = els.filter(e => e.bbox && (_looksLikeInput(e) || e._role === 'field'));
  const labels = els.filter(e => e.bbox && e !== undefined && String(e.label || '').trim()
    && String(e.label).trim().length < 24 && (e.bbox[3] || 99) < 30);
  for (const f of fields) {
    let best = null, bd = 1e9;
    for (const l of labels) {
      if (l === f) continue;
      const lx = l.bbox[0], ly = l.bbox[1], lw = l.bbox[2], lh = l.bbox[3];
      const fx = f.bbox[0], fy = f.bbox[1];
      // caption sits above the field, left edges roughly aligned
      const dy = fy - (ly + lh);
      if (dy < -8 || dy > 55) continue;
      const dx = Math.abs(lx - fx);
      if (dx > 80 + lw) continue;
      const d = dy + dx * 0.5;
      if (d < bd) { bd = d; best = l; }
    }
    if (best) f._caption = String(best.label).trim();
  }
}

function describe(e) {
  const [x, y, w, h] = e.bbox || [e.center?.[0] || 0, e.center?.[1] || 0, 0, 0];
  // [role@container] — the model sorts on kind+location+content, not a bare
  // label: '[row@dialog] "Only Sixteen KB"' beats 'Only Sixteen' naked.
  const roleHint = e._role && e._role !== 'unknown' ? e._role : (_looksLikeInput(e) ? 'input' : '');
  const scopeHint = e._scope ? `:${e._scope}` : '';
  const hint = roleHint ? ` [${roleHint}${scopeHint}${e._containerPath || e._container ? `@${e._containerPath || e._container}` : ''}]` : '';
  const cap = e._caption ? ` caption="${e._caption}"` : '';
  const ctx_ = e._rowCtx ? ` ${e._rowCtx}` : '';
  // Affordance surface — a row shows its trailing control as a unit ("…[Add]")
  // so the model sees row+button together instead of an orphan unlabeled icon.
  const aff = e._isRow && e._ctl ? ` [ctl ${e._ctl._afford && e._ctl._afford !== 'ctl' ? `${e._ctl._afford} ` : ''}"${String(e._ctl.label || 'icon').slice(0, 20)}"]`
    : (e._afford && e._afford !== 'ctl' ? ` [afford:${e._afford}]` : '');
  return `#${e.id} ${e.type} "${(e.label || '').slice(0, 60)}" @(${x},${y},${w}x${h})${hint}${cap}${ctx_}${aff}`;
}

// Dialog-focused scene sketch — when a modal is open the picker's subtree IS
// the live context; the window's first 30 serialize() lines may never reach
// it. Build the dialog's structure from elements inside its rect: fields,
// rows, and each row's right-edge affordance child (the commit control an
// unlabeled icon otherwise hides behind).
function _dialogSketch(els, dlg) {
  if (!dlg) return '';
  const inside = els.filter(e => e.center
    && e.center[0] >= dlg.rect[0] - 4 && e.center[0] <= dlg.rect[0] + dlg.rect[2] + 4
    && e.center[1] >= dlg.rect[1] - 4 && e.center[1] <= dlg.rect[1] + dlg.rect[3] + 4)
    .sort((a, b) => a.center[1] - b.center[1] || a.center[0] - b.center[0]);
  if (!inside.length) return '';
  const rows = inside.filter(e => e._role !== 'field' && !_looksLikeInput(e)
    && String(e.label || '').trim() && (e.bbox ? e.bbox[2] > 120 : true));
  const fields = inside.filter(e => e._role === 'field' || _looksLikeInput(e));
  const icons = inside.filter(e => !String(e.label || '').trim() || /icon|radio|checkbox/.test(String(e._role || e.type || '')));
  const lines = [`dialog "${String(dlg.label || 'modal').slice(0, 40)}"`];
  for (const f of fields.slice(0, 3))
    lines.push(`  ├ field "${String(f.label || '').slice(0, 40)}"${f._caption ? ` [${f._caption}]` : ''}`);
  // Dedup — overlapping OCR groups surface the same row 2-3× ("Lecrae
  // playlist Playlist • vicfolorin" repeated); collapse by normalized label,
  // keep the first (topmost) occurrence, annotate the count.
  const _seenRow = new Map();
  for (const r of rows) {
    const k = String(r.label || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const prev = _seenRow.get(k);
    if (prev) prev.n++; else _seenRow.set(k, { r, n: 1 });
  }
  const _rowsDedup = [..._seenRow.values()].map(v => ({ ...v.r, _dupN: v.n }));
  for (const r of _rowsDedup.slice(0, 10)) {
    lines.push(`  ├ row "${String(r.label).slice(0, 50)}"${r._dupN > 1 ? ` ×${r._dupN}` : ''}`);
    // Right-edge affordance children — an icon/radio sharing the row's band
    // on its right half is the row's commit control.
    const kids = icons.filter(ic => ic !== r && ic.center
      && Math.abs(ic.center[1] - r.center[1]) < Math.max(18, (r.bbox?.[3] || 40) / 2)
      && r.bbox && ic.center[0] > r.bbox[0] + r.bbox[2] * 0.6);
    for (const k of kids.slice(0, 2))
      lines.push(`  │   └ ${k._role || 'icon'} right-edge @(${Math.round(k.center[0])},${Math.round(k.center[1])})${k._afford ? ` [${k._afford}]` : ''}`);
  }
  return lines.join('\n');
}

// ── Region scoping ──────────────────────────────────────────────────────────
// Nothing is deleted globally — app goals exclude menubar/dock noise; menu or
// dock goals INCLUDE those regions (the goal decides, the data stays).
// Dialog/modal overlay = interaction trap: affordance buttons (Save/Cancel/OK/
// Close…) clustered in a compact rect mean everything outside is unreachable
// chrome — the URL bar beside a Spotify "Edit details" dialog is the canonical
// trap (typed "Quiet Hour" into the omnibox, navigated away).
const _DIALOG_BTN = /^\s*(save|cancel|ok|done|close|submit|confirm|continue|discard|sign in|log in|allow|got it|next|back|finish|apply|make private|create)\s*$/i;
function detectDialog(elements) {
  let best = null;
  for (const b of elements) {
    if (!b.center || !_DIALOG_BTN.test(String(b.label || '').trim())) continue;
    const near = elements.filter(e => e.center && e.bbox &&
      Math.abs(e.center[0] - b.center[0]) < 380 &&
      Math.abs(e.center[1] - b.center[1]) < 300);
    if (near.length < 4) continue;
    const x0 = Math.min(...near.map(e => e.bbox[0])), y0 = Math.min(...near.map(e => e.bbox[1]));
    const x1 = Math.max(...near.map(e => e.bbox[0] + e.bbox[2])), y1 = Math.max(...near.map(e => e.bbox[1] + e.bbox[3]));
    const w = x1 - x0, h = y1 - y0;
    if (w > 1100 || h > 800) continue; // whole-page cluster ≠ dialog
    const score = near.length + near.filter(e => _DIALOG_BTN.test(String(e.label || '').trim())).length * 3;
    if (!best || score > best.score) best = { rect: [x0 - 24, y0 - 24, w + 48, h + 48], score };
  }
  if (!best) {
    // Second seed: button labels often OCR-merge with neighbors ('Mak• private
    // Save y procoading…'), defeating _DIALOG_BTN exact match. A tight cluster
    // of ≥2 input fields is itself strong evidence of a modal form.
    const inputs = elements.filter(e => e.center && e.bbox && _looksLikeInput(e));
    for (const a of inputs) {
      const near = elements.filter(e => e.center && e.bbox &&
        Math.abs(e.center[0] - a.center[0]) < 380 &&
        Math.abs(e.center[1] - a.center[1]) < 300);
      const nearInputs = near.filter(e => _looksLikeInput(e));
      if (nearInputs.length < 2 || near.length < 4) continue;
      const x0 = Math.min(...near.map(e => e.bbox[0])), y0 = Math.min(...near.map(e => e.bbox[1]));
      const x1 = Math.max(...near.map(e => e.bbox[0] + e.bbox[2])), y1 = Math.max(...near.map(e => e.bbox[1] + e.bbox[3]));
      if (x1 - x0 > 1100 || y1 - y0 > 800) continue;
      best = { rect: [x0 - 24, y0 - 24, x1 - x0 + 48, y1 - y0 + 48], score: near.length };
      break;
    }
    if (!best) return null;
  }
  const [rx, ry, rw, rh] = best.rect;
  return { rect: best.rect,
    elements: elements.filter(e => e.center &&
      e.center[0] >= rx && e.center[0] <= rx + rw &&
      e.center[1] >= ry && e.center[1] <= ry + rh) };
}

function scopeElements(elements, goal, domain, furniture, parsed) {
  const wantsSystem = /\b(menu ?bar|apple menu|file menu|edit menu|view menu|go menu|window menu|help menu|dock|notification|spotlight)\b/i.test(goal || '');
  let pool = wantsSystem ? elements
    : elements.filter(e => e.region !== 'menubar' && e.region !== 'dock');
  // Domain isolation: a URL task owns only the browser's content viewport —
  // tab strip, omnibox, bookmark band, downloads popovers, and elements
  // outside the front window are never candidates, so they can neither be
  // probed nor committed. App/desktop domains keep the whole window.
  if (domain === 'url' && !wantsSystem) {
    pool = pool.filter(e => e.region !== 'other' && e.center && e.center[1] > 112);
  }
  const dlg = wantsSystem ? null : detectDialog(pool);
  // Furniture guard — a "dialog" that is an edge strip (wide+short media
  // bar), a side panel (narrow+tall), or covers most of the window is page
  // furniture by SHAPE — restricting the pool to it blinds the whole page.
  if (dlg) {
    const _w = _pxW(parsed);
    const _h = _pxH(parsed);
    const strip = dlg.rect[2] > _w * 0.7 && dlg.rect[3] < _h * 0.25;
    const panel = dlg.rect[2] < _w * 0.4 && dlg.rect[3] > _h * 0.6;
    const huge = dlg.rect[2] * dlg.rect[3] > _w * _h * 0.55;
    if (!(strip || panel || huge) && !(furniture && furniture.has(_dlgFp(dlg))))
      return dlg.elements;
  }
  return pool;
}

// ── Layout enrichment: flat elements → rows, containers, icon bindings ─────
// The parser emits context-free elements; the walk needs structure. Derive it
// from coordinates: y-band clusters become composite row candidates (a search
// result row is title text + duration + a hover '+' icon — three fragments
// that each die alone), unlabeled icons bind to their nearest same-line
// label, and every element gets a container tag for role inference and the
// model's [role@container] descriptors.
const _dlgFp = (dlg) => dlg.rect.map(v => Math.round(v / 20)).join(',');
// Parse scale is [sx, sy] (per-axis fit) or a scalar — dividing by the raw
// value produced NaN window metrics and silently disabled every geometric
// gate (rail strip, panel exclusion, media cutoff).
const _pxW = (p) => p?.size_px ? p.size_px[0] / (Array.isArray(p.scale) ? p.scale[0] : (p.scale || 1)) : 1440;
const _pxH = (p) => p?.size_px ? p.size_px[1] / (Array.isArray(p.scale) ? p.scale[1] : (p.scale || 1)) : 900;
// Geometric region role — the human's "what zone is this" pass. Dialog
// containment wins; then position maps to a coarse region vocabulary.
function _regionRole(e, dlg, w, h) {
  if (!e.center) return 'content';
  const [x, y] = e.center;
  if (dlg && x >= dlg.rect[0] && x <= dlg.rect[0] + dlg.rect[2]
      && y >= dlg.rect[1] && y <= dlg.rect[1] + dlg.rect[3]) return 'dialog';
  // Edge strips win over the x-bands: the now-playing bar spans full width
  // (its left-edge track label would otherwise classify as "library"), and
  // the menubar/nav strip spans the rail too.
  if (y > h - 90) return 'media';
  if (y < 150) return 'nav';
  if (x < 80) return 'rail';
  if (x < 330) return 'library';
  if (x > w * 0.75) return 'panel';
  return 'content';
}

function enrichLayout(els, parsed, furniture) {
  const ROW_Y = 15;
  const rows = [];
  const bands = [];
  for (const e of els.filter(e => e.center && e.bbox).sort((a, b) => a.center[1] - b.center[1])) {
    const band = bands.find(b => Math.abs(b.y - e.center[1]) <= ROW_Y);
    if (band) { band.members.push(e); band.y = band.members.reduce((s, m) => s + m.center[1], 0) / band.members.length; }
    else bands.push({ y: e.center[1], members: [e] });
  }
  for (const band of bands) {
    if (band.members.length < 2) continue;
    band.members.sort((a, b) => a.center[0] - b.center[0]);
    const labeled = band.members.filter(m => String(m.label || '').trim());
    if (!labeled.length) continue;
    const x0 = Math.min(...band.members.map(m => m.bbox[0])), y0 = Math.min(...band.members.map(m => m.bbox[1]));
    const x1 = Math.max(...band.members.map(m => m.bbox[0] + m.bbox[2])), y1 = Math.max(...band.members.map(m => m.bbox[1] + m.bbox[3]));
    if (x1 - x0 > 900 || y1 - y0 > 80) continue; // whole-width band = a region, not a row
    const row = {
      _isRow: true, type: 'row', src: 'layout',
      id: `row_${band.members.map(m => m.id).join('_')}`,
      label: labeled.map(m => String(m.label).trim()).join(' ').replace(/\s+/g, ' ').slice(0, 120),
      center: [(x0 + x1) / 2, (y0 + y1) / 2], bbox: [x0, y0, x1 - x0, y1 - y0],
      conf: Math.max(...band.members.map(m => m.conf || 0)), _members: band.members,
    };
    band.members.forEach(m => { m._row = row; });
    rows.push(row);
  }
  els.push(...rows);
  // Columns — sibling rows share x-anchors (title, album, date, duration,
  // actions). Cluster member x-centers across all rows → each member gets a
  // column index, so triggers address "the last column" (•••, ⋮, Delete)
  // app-agnostically instead of label-matching glyphs.
  {
    const anchors = [];
    for (const r of rows) for (const m of (r._members || [])) if (m.center) anchors.push(m.center[0]);
    anchors.sort((a, b) => a - b);
    const cols = [];
    for (const x of anchors) {
      const c = cols.find(c => Math.abs(c.x - x) < 42);
      if (c) { c.xs.push(x); c.x = c.xs.reduce((s, v) => s + v, 0) / c.xs.length; }
      else cols.push({ x, xs: [x] });
    }
    cols.sort((a, b) => a.x - b.x);
    if (cols.length >= 2) {
      for (const r of rows) {
        r._cols = cols.length;
        for (const m of (r._members || [])) {
          if (!m.center) continue;
          let best = 0, bd = 1e9;
          cols.forEach((c, i) => { const d = Math.abs(c.x - m.center[0]); if (d < bd) { bd = d; best = i; } });
          m._col = best;
        }
      }
    }
  }
  // Affordance hints — glyph priors + row trailing controls (› / Add / ⋯).
  _annotateAffords(els);
  let dlg = detectDialog(els.filter(e => !e._isRow));
  const _w = _pxW(parsed);
  const _h = _pxH(parsed);
  // A "dialog" covering most of the window isn't a dialog — it's the page
  // (or a bottom media bar). Coverage cap prevents whole-window modal
  // classification that marks every element 'dialog'.
  if (dlg && dlg.rect[2] * dlg.rect[3] > _w * _h * 0.55) dlg = null;
  // Furniture rule — a "dialog" fingerprinted as persistent page furniture
  // (right-side panel, now-playing card) must not mark containment.
  if (dlg && furniture && furniture.has(_dlgFp(dlg))) dlg = null;
  for (const e of els) {
    if (!e.center) continue;
    e._regionRole = _regionRole(e, dlg, _w, _h);
    e._container = e._regionRole === 'dialog' ? 'dialog'
      : e._regionRole === 'rail' || e._regionRole === 'library' ? 'sidebar' : 'content';
    if (e._container === 'dialog') e._dlgTopInset = e.center[1] - dlg.rect[1];
  }
  for (const e of els) {
    if (String(e.label || '').trim() || e.type !== 'icon' || !e.center || e._isRow) continue;
    let best = null, bd = 1e9;
    for (const o of els) {
      if (o === e || o._isRow || !String(o.label || '').trim() || !o.center) continue;
      // 3x vertical weight → same-line neighbors win over stacked ones
      const d = Math.hypot(e.center[0] - o.center[0], (e.center[1] - o.center[1]) * 3);
      if (d < bd) { bd = d; best = o; }
    }
    if (best && bd < 90) e._boundLabel = String(best.label).slice(0, 40);
  }
  return dlg;
}

// ── Structural role inference: Infer → Hover → Commit ───────────────────────
// Deterministic element category BEFORE any mouse movement. Hard vetoes
// reject outright; soft classifications are priors — hover arbitrates
// ambiguity (I-beam vs pointer, tooltip, affordance diff).
const _URL_LABEL = /^(https?[:.]?\/\/|www\.|[a-z0-9-]+\.(?:com|net|org|io|dev|app|fm|co|ai|so|sh|tv|me|gg)\b)/i;
const _BROWSER_APP = /chrome|safari|firefox|edge|brave|arc|vivaldi|opera|webkit|webview|browser/i;
// Browser side panels (Gemini, Copilot, share banners) are browser chrome —
// they overlay page space but aren't part of the site being driven.
const _BROWSER_PANEL = /gemini|copilot|ideas to explore|type\s*\/\s*to use skills|stop sharing|sharing\s+.{0,30}(web player|screen|tab)/i;
// ThinkDrop's own overlays (plan card, step HUD, result confirm) float over
// the target window — their labels get OCR'd as elements and, fatally, the
// card echoes the goal text verbatim so it tops the shortlist and gets
// clicked. Veto our own chrome from the candidate pool entirely.
const _OWN_CHROME = /drive the ui|executing steps|screen\.task\.agent|screen\.act\.agent|confirm the result|synthesize\b|step\s*\d+\s*\/\s*\d+\s*—\s*drive|plan:\s*\d+\s*setup|action required|thinkdrop couldn|javascript error occurred|err_http_headers_sent|uncaught exception/i;
let _lastParsed = null; // front_app context for lazy describe() hints
let _CUR_GOAL = '';      // active goal — goal-relative vetoes (pickers, edit ctrls)
// A goal that asks for a file/photo upload owns the macOS picker — it's the
// task, not a trap. Everything else treats the picker as foreign.
const _PICKER_GOAL = /\b(upload|attach|choose\s+(?:a\s+|an\s+|the\s+)?(?:file|photo|image|picture|video)|select\s+(?:a\s+|an\s+|the\s+)?(?:file|image|photo|video)|import|resume|cv\b|document|cover\s+(?:image|photo|art)|profile\s+(?:pic|picture|photo)|browse\w*\s+(?:a\s+|the\s+)?file)\b/i;
const _goalExpectsPicker = goal => _PICKER_GOAL.test(String(goal || ''));

// Element identity across reparses — el.id is a per-parse positional index
// (renumbered every observation), so excluding by id silently masks random
// elements on the next parse — including the goal itself. Fingerprints are
// stable across reparses: normalized label + role + ~24px center cell.
// Query-addressable search URLs — navigating IS the acquire step for catalog
// sites (a power-user's Cmd+L + type, without the typing). Keyed by host.
const { SEARCH_URL_TEMPLATES, cleanEntity: _cleanSharedEnt, searchUrlFor: _searchUrlFor } = require('../skill-helpers/search-urls.cjs');

const _fp = e => e ? `${String(e.label || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 40)}|${e._role || e.type || ''}|${e.center ? Math.round(e.center[0] / 24) : '?'}:${e.center ? Math.round(e.center[1] / 24) : '?'}` : '?';
// Role is part of the fingerprint → exclusions auto-expire on promotion: a
// text element rejected as doctext that later clusters into a row gets a new
// fingerprint and re-enters the pool instead of staying masked all run.
// Label-free fingerprint — OCR jitters labels every parse ("Q SeaTch" vs
// "Q Search"), so label-bearing fps let the same element get re-probed
// forever. Position+kind survive OCR; a wrong match costs one probe, not
// a click.
const _fpLoose = e => e ? `${e._role || e.type || ''}|${e.center ? Math.round(e.center[0] / 32) : '?'}:${e.center ? Math.round(e.center[1] / 32) : '?'}` : '?';
// Field-content ≠ committed state: a hit that IS or CONTAINS an input is an
// unsaved value (typed text, stale search) — never goal state. OCR merges a
// field with its surroundings into composites ("…Q Lecrae songs"), so also
// check whether any field element lives inside the hit's bbox.
const _fieldContentHit = (set, hitEl) => !!(hitEl && (
  hitEl._role === 'field' || _looksLikeInput(hitEl) ||
  (hitEl.bbox && set.some(f => (f._role === 'field' || _looksLikeInput(f)) && f.center &&
    f.center[0] >= hitEl.bbox[0] && f.center[0] <= hitEl.bbox[0] + hitEl.bbox[2] &&
    f.center[1] >= hitEl.bbox[1] && f.center[1] <= hitEl.bbox[1] + hitEl.bbox[3]))));
// The element we typed into can't prove containment — its label echoing the
// term is the field's own content, not membership. typed: Map<term, fieldFp>.
const _isTypedField = (mem, hitEl) => !!(mem && hitEl &&
  [...(mem.typed?.values?.() || [])].includes(_fpLoose(hitEl)));
// Wide row composite whose label ENDS in an affordance token — the clickable
// control sits at the row's right edge ("… · Add"), not its center. Pure
// buttons (label is only the token) are excluded — center is correct there.
function _affordancePoint(el) {
  if (!el?.bbox || !el.center) return null;
  // A discovered trailing control beats the edge guess — its center is exact.
  if (el._ctl?.center) return [Math.round(el._ctl.center[0]), Math.round(el._ctl.center[1])];
  const [bx, by, bw, bh] = el.bbox;
  if (bw < 250 || bh < 12 || bh > 110) return null;
  const label = String(el.label || '').trim();
  if (!/\b(add|remove|\+|save|send|post|submit|join|follow)\s*$/i.test(label)) return null;
  if (/^\s*(add|remove|\+|save|send|post|submit|join|follow)\s*$/i.test(label)) return null;
  return [Math.round(bx + bw - 34), Math.round(by + bh / 2)];
}

// ── Affordance hints: glyph priors + structural trailing controls ──────────
// Priors, not truth — a closed glyph table can never enumerate every app's
// icon vocabulary, so structure (a control sitting on a row's trailing edge)
// is the real signal; the table just names the common cases. Verification
// stays with commit→delta.
const _AFFORD_GLYPH = [
  [/^(?:>+|›+|»|→|➜|▸|❯|>>)$/, 'goto'],
  [/^(?:\+|＋|⊕|✚|➕|add\b.*|plus)$/i, 'add'],
  [/^(?:…|⋯|⋮|•+|…\.|\.\.\.|more)$/i, 'menu'],
  [/^(?:×|✕|✖|x|close|dismiss)$/i, 'dismiss'],
  [/^(?:⬇|↓|⇩|download|get|install)$/i, 'acquire'],
  [/^(?:▶|⏵|►|play)$/i, 'play'],
  [/^(?:♥|♡|heart|like)$/i, 'like'],
];
// A row member is a control candidate when it's glyph-hit, icon/button-role
// with a short label, or an unlabeled narrow element (a bare icon glyph).
function _isCtl(m) {
  if (!m?.center || !m?.bbox) return false;
  const l = String(m.label || '').trim();
  if (m._afford) return true;
  if (!l) return m.bbox[2] < 90;
  return l.length <= 12 && /icon|btn|button|link|radio|checkbox/.test(String(m._role || m.type || ''));
}
// Two passes: glyph labels first (they also flag controlish-ness), then each
// row composite's rightmost controlish member in the trailing 40% becomes its
// _ctl — the commit control a bare row click would miss.
function _annotateAffords(els) {
  for (const e of els) {
    if (e._afford != null) continue;
    const l = String(e.label || '').trim();
    if (!l || l.length > 30) continue;
    for (const [re, a] of _AFFORD_GLYPH) if (re.test(l)) { e._afford = a; break; }
  }
  for (const r of els) {
    if (!r._isRow || r._ctl || !r.bbox) continue;
    const [rx, , rw] = r.bbox;
    const cands = (r._members || []).filter(m => m !== r && _isCtl(m)
      && m.center[0] > rx + rw * 0.6);
    if (!cands.length) continue;
    cands.sort((a, b) => b.center[0] - a.center[0]);
    r._ctl = cands[0];
    r._ctl._rowCtl = r;
    if (!r._ctl._afford) r._ctl._afford = 'ctl';
  }
}
// macOS file-open/save dialog detection — an Open/Cancel button pair plus
// Finder location vocabulary. Spawned by app "Choose photo"-type controls
// while keeping the same front_app, so domain scoping can't see it.
// Unexpected modal detection — macOS file-open/save pickers and print sheets
// spawned by app controls while keeping the same front_app (domain scoping
// can't see them). File: Open/Cancel + Finder vocab or filename-like labels.
// Print: Print/Cancel + Copies/Pages/PDF/Layout vocabulary.
function _isSystemDialogOpen(els) {
  // Button must look like a real button — a short standalone label, not
  // paragraph text containing the word ("Open.spotify.com" doesn't count).
  const hasBtn = els.some(e => /^\s*(open|cancel|save|print)\s*(?:\.\.\.)?$/i.test(String(e.label || '').trim()));
  if (!hasBtn) return false;
  const fileVocab = els.filter(e => /^\s*(icloud drive|documents|downloads|desktop|recents|applications|finder|movies|music|pictures|show options|choose file|save as|file name|tags|favorites)\s*$/i.test(String(e.label || '').trim()));
  const hasPrintVocab = els.filter(e => /^\s*(copies|page range|layout|pdf|printer|presets|paper size|orientation|two-sided)\b/i.test(String(e.label || '').trim())).length >= 2;
  const hasFiles = els.filter(e => /^\s*[^/\\\s]{2,40}\.[a-z0-9]{2,5}\s*$/i.test(String(e.label || '').trim())).length >= 2;
  // A picker is a compact modal — its evidence must sit inside a dialog-sized
  // cluster, not spread across a whole page of text.
  if (fileVocab.length < 2 && !hasFiles && !hasPrintVocab) return false;
  const ev = [...fileVocab, ...els.filter(e => /^\s*(open|cancel|save|print)\s*(?:\.\.\.)?$/i.test(String(e.label || '').trim()))].filter(e => e.center);
  if (ev.length < 2) return false;
  const cx = ev.map(e => e.center[0]), cy = ev.map(e => e.center[1]);
  return (Math.max(...cx) - Math.min(...cx)) < 1100 && (Math.max(...cy) - Math.min(...cy)) < 900;
}
const _isFileDialogOpen = _isSystemDialogOpen;
// Goal-irrelevant app dialog — a modal whose TITLE vocabulary shares no goal
// content-word is a trap the walk clicked into ("Edit details" during an
// add-songs goal). "Add to playlist" stays (shares 'playlist').
function _isForeignDialog(els, goal, ctx) {
  const dlg = detectDialog(els);
  if (!dlg) return false;
  // Goal-advancement — a surface carrying the destination or an owed entity
  // is never foreign, however its title reads: pickers and menus routinely
  // carry no title at all, and a wrong-object dialog ("Edit details") is
  // caught by its CONTENT lacking goal terms, not by title mismatch alone.
  const _dEls = dlg.elements || [];
  const _dest = String(ctx?.destination || '').toLowerCase();
  if (_dest && _dEls.some(e => String(e.label || '').toLowerCase().includes(_dest))) return false;
  if ((ctx?.memory?.pendingVerify || []).some(t =>
      t && _dEls.some(e => String(e.label || '').toLowerCase().includes(String(t).toLowerCase())))) return false;
  const gWords = new Set(String(goal || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const titleWords = _dEls
    .filter(e => e.center && e.center[1] < dlg.rect[1] + 70)
    .flatMap(e => String(e.label || '').toLowerCase().split(/[^a-z0-9]+/))
    .filter(w => w.length > 2);
  return titleWords.length > 0 && !titleWords.some(w => gWords.has(w));
}

function inferRole(e, els, parsed) {
  if (e._role) return e._role;
  parsed = parsed || _lastParsed || {};
  const [x, y, w, h] = e.bbox || [0, 0, 0, 0];
  const label = String(e.label || '').trim();
  const browser = _BROWSER_APP.test(parsed.front_app || parsed.front_bundle || '');
  const topBand = y < 115;
  const wideThin = w > 200 && h > 0 && h < 50;
  const _fileDialogOpen = _isFileDialogOpen(els || []);
  let role = 'unknown', conf = 'soft';
  if (_URL_LABEL.test(label))                          { role = 'omnibox';      conf = 'hard'; }
  else if (browser && _BROWSER_PANEL.test(label))      { role = 'windowchrome'; conf = 'hard'; }
  else if (_OWN_CHROME.test(label))                    { role = 'windowchrome'; conf = 'hard'; }
  // App-install/download CTAs ("Install App", "Download the free app",
  // "Download Spotify for Mac") — ads for the native client, never a step
  // toward a UI goal on the web page being driven.
  else if (/\b(download|install)\b[\s\S]{0,20}\b(app|mac|desktop|windows|free)\b|\b(download|install)\s*app\b/i.test(label)) { role = 'windowchrome'; conf = 'hard'; }
  // Dialog title — the dialog's own heading text (top band inside its rect)
  // is context, not a control: "Add to playlist" the caption is not the
  // button. Committing it wastes a click on static text.
  else if (e._container === 'dialog' && e._dlgTopInset != null && e._dlgTopInset < 64 && e.type === 'text') { role = 'dialogtitle'; conf = 'hard'; }
  // Transient toasts ("Link copied to clipboard", "Added to …") — ephemeral
  // confirmations that vanish next parse, never task targets.
  else if (e.type === 'text' && /\b(copied to clipboard|added to|removed from|saved to|undo|dismiss)\b/i.test(label)) { role = 'toast'; conf = 'hard'; }
  // macOS file-open/save dialog — a Chrome "Choose photo" can spawn a system
  // picker that stays under the same front_app; its files/locations are not
  // page content and typing in it corrupts the walk.
  else if (_fileDialogOpen && !_goalExpectsPicker(_CUR_GOAL) && /\b(icloud drive|documents|desktop|downloads|recents|applications|movies|music|pictures|open|cancel|save|show options|tags|file name|copies|page range|layout|pdf|printer|presets|paper size)\b/i.test(label)) { role = 'sysdialog'; conf = 'hard'; }
  // Edit-dialog controls ("Choose photo", "Name & details") — traps during
  // content goals, legitimate targets during edit/upload goals.
  else if (/\b(choose photo|name\s*&\s*details|edit details|make private|change cover)\b/i.test(label)
      && !_goalExpectsPicker(_CUR_GOAL)
      && !/\b(edit|rename|describ|detail|private|photo|cover|image|upload)\b/i.test(_CUR_GOAL)) { role = 'sysedit'; conf = 'hard'; }
  // Layout rows — a y-band composite is the clickable row itself (result row,
  // sidebar entry). Its text members stay doctext; the composite is the target.
  else if (e._isRow)                                 { role = 'listitem';     conf = 'soft'; }
  else if (browser && topBand && wideThin && w > 350)  { role = 'omnibox';      conf = 'hard'; }
  // Bookmarks band — Chrome's strip sits below the omnibox (~y 75–115);
  // small items there are bookmarks, not page content. Clicking one
  // navigates the tab away from the task's page entirely.
  else if (browser && topBand && y >= 70 && h > 0 && h < 45) { role = 'bookmark'; conf = 'hard'; }
  else if (browser && topBand)                         { role = 'tab';          conf = 'soft'; }
  else if (e.region === 'menubar' || e.region === 'dock') { role = 'windowchrome'; conf = 'hard'; }
  else if (label.length > 90 || (label.split(/\s+/).length > 8 && w > 300)) { role = 'doctext'; conf = 'hard'; }
  else if (_looksLikeInput(e))                         { role = 'field';        conf = 'soft'; }
  else if (e.type === 'icon' && !label)                { role = 'icon';         conf = 'soft'; }
  else if (e.type === 'icon' && label)                 { role = 'button';       conf = 'soft'; }
  else if (label && label.length < 30 && w < 280 && h < 60) { role = 'button';  conf = 'soft'; }
  else if (x < 290 && label && h < 50)                 { role = 'listitem';     conf = 'soft'; }
  else if (label)                                      { role = 'doctext';      conf = 'soft'; }
  e._role = role; e._roleConf = conf;
  return role;
}

// Can this category receive intent at all? Hard vetoes only — soft roles
// return null (allowed) and let the hover probe arbitrate ambiguity.
function roleVeto(e, intent, goal, named) {
  const role = e._role || inferRole(e);
  if (role === 'windowchrome') return 'windowchrome is system chrome, not a target';
  if (role === 'dialogtitle') return 'dialog heading is context, not a control';
  if (role === 'toast') return 'toast is a transient confirmation, not a control';
  if (role === 'sysdialog') return 'system file dialog is not page content';
  if (role === 'sysedit') return 'edit-dialog control is off-goal';
  if (role === 'bookmark' && !/\b(bookmark|favorite|tab)\b/i.test(goal || ''))
    return 'bookmark bar navigates away from the page';
  if (intent === 'type') {
    if (role === 'omnibox' && !/\b(url|address|search bar|go to)\b/i.test(goal || ''))
      return 'omnibox is browser chrome — typing navigates away';
    if (role === 'doctext' && e._roleConf === 'hard') return 'doctext cannot receive input';
    if (role === 'icon' || role === 'tab') return `${role} cannot receive input`;
  }
  // doctext blocks blind clicks but yields when the goal explicitly named it.
  // A bulk work-set row is legal by stage — OCR/AX often stamps row
  // composites doctext; the veto exists to stop page-text clicks, not rows.
  if (intent === 'click' && role === 'doctext' && e._roleConf === 'hard' && !named && !e._bulkRow)
    return 'doctext is not a control';
  return null;
}

// Type-commit pool: field ∪ explicit-named ∪ unknown-that-looks-input —
// hard-role elements (omnibox/doctext/icon) can never enter.
function roleAllowsType(e, goal) {
  inferRole(e);
  if (roleVeto(e, 'type', goal)) return false;
  return _looksLikeInput(e) || e._role === 'field';
}

// @icon:<anchor> — the universal "unlabeled icon button beside a labeled
// region" pattern (Spotify '+' in Your Library, toolbar pencils, etc.).
// The icon lives in the anchor's horizontal band (headers/toolbars), usually
// right of the label text — OCR merges change the anchor's shape wildly, so
// match on the band, not strict containment. Leftmost candidate wins: the
// leading icon is the primary action.
// @iconbelow:<anchor> — unlabeled icons BELOW the anchor (list-row action
// buttons under a section heading); topmost = first row.
function iconAnchor(els, spec, prev = null) {
  const below = String(spec).startsWith('@iconbelow:');
  const anchorQ = String(spec).slice(below ? 11 : 6).trim();
  // '@prev' — the previous step's resolved anchor element. Learned flows use
  // it to chain spatial relations (field → chip → row '+') without baking
  // term-specific match strings into the recipe.
  const anchors = anchorQ === '@prev'
    ? (prev?.bbox ? [prev] : [])
    : matchElements(els, anchorQ).filter(e => e.bbox);
  // below-mode anchors on the TOPMOST hit (the field/heading above the rows);
  // band-mode anchors on the biggest (the merged region).
  anchors.sort((a, b) => below
    ? ((a.center?.[1] ?? 0) - (b.center?.[1] ?? 0))
    : ((b.bbox[2] * b.bbox[3]) - (a.bbox[2] * a.bbox[3])));
  if (!anchors.length) return null;
  if (below) {
    const anchor = anchors[0];
    const bottom = (anchor.bbox ? anchor.bbox[1] + anchor.bbox[3] : anchor.center[1]) - 10;
    // Right-of + below the anchor — panel/row action icons sit to the right of
    // their field/heading and below it. Anchor-agnostic (works for element,
    // offset-point, or '@prev' pseudo-targets) and immune to column-width
    // variance: icons LEFT of the anchor (content area, card art) can't win.
    const rightOf = anchor.center[0] + 10;
    const cands = els.filter(e => e !== anchor && e.center && e.bbox &&
      !String(e.label || '').trim() && e.center[1] > bottom &&
      e.center[0] > rightOf);
    cands.sort((a, b) => (a.center[1] - b.center[1]) || (a.center[0] - b.center[0]));
    return cands[0] || null;
  }
  // Try anchors largest-first; OCR merges reshape the anchor wildly, so the
  // icon may be inside the bbox OR just in its row-band right of the label.
  for (const anchor of anchors) {
    const [ax, ay, aw, ah] = anchor.bbox;
    const cands = els.filter(e => {
      if (e === anchor || !e.center || !e.bbox || String(e.label || '').trim()) return false;
      const [cx, cy] = e.center;
      const contained = cx >= ax && cx <= ax + aw && cy >= ay && cy <= ay + ah;
      const inBand = cy >= ay - 30 && cy <= ay + ah + 30;
      const rightish = cx >= ax + aw * 0.6;
      return contained || (inBand && rightish);
    });
    cands.sort((a, b) => (a.center[0] - b.center[0]) || (a.center[1] - b.center[1]));
    if (cands[0]) return cands[0];
  }
  return null;
}

// ── Deterministic match ─────────────────────────────────────────────────────
// match: literal string (exact, then case-insensitive substring), or
// /regex/ pattern. Returns matched elements sorted by label-length precision.
function matchElements(elements, match) {
  if (match == null || match === '') return [];
  let rx;
  if (typeof match === 'string' && match.length > 2 && match.startsWith('/') && match.endsWith('/')) {
    try { rx = new RegExp(match.slice(1, -1), 'i'); } catch { rx = null; }
  }
  const norm = String(match).toLowerCase().trim();
  const hits = elements.filter(e => {
    const l = String(e.label || '');
    if (rx) return rx.test(l);
    return l.toLowerCase() === norm || l.toLowerCase().includes(norm);
  });
  // exact matches first, then shortest-label (most precise) first
  hits.sort((a, b) => {
    const ea = String(a.label || '').toLowerCase() === norm ? 0 : 1;
    const eb = String(b.label || '').toLowerCase() === norm ? 0 : 1;
    if (ea !== eb) return ea - eb;
    return String(a.label || '').length - String(b.label || '').length;
  });
  if (hits.length) return hits;

  // Fuzzy fallback — OCR noise misreads characters ('Chat with Copilot' →
  // 'khat with Copilot'). Score = fraction of match tokens present (or a
  // single-char-different variant) in the label; ≥ 0.6 required.
  // Anchored regexes ('/^add$/') express exact intent — a fuzzy hit on 'and'
  // (edit-dist 1) would silently click the wrong thing.
  if (rx && /[\^$]/.test(match.slice(1, -1))) return hits;
  const mtoks = [...new Set(norm.split(/[^a-z0-9]+/).filter(w => w.length > 2))];
  if (!mtoks.length) return hits;
  const fuzzy = elements
    .map(e => {
      const ltoks = String(e.label || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const lset = new Set(ltoks);
      let score = 0;
      for (const t of mtoks) {
        if (lset.has(t) || String(e.label || '').toLowerCase().includes(t)) score += 1;
        else if (ltoks.some(lt => Math.abs(lt.length - t.length) <= 1 && _editDist1(lt, t))) score += 0.8;
      }
      return { e, score: score / mtoks.length };
    })
    .filter(x => x.score >= 0.6)
    .sort((a, b) => b.score - a.score);
  return fuzzy.map(x => x.e);
}

// Edit distance ≤ 1 (substitution/insert/delete) — enough for one OCR misread.
function _editDist1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a === b) return true;
  if (a.length === b.length) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
    return d === 1;
  }
  // length differs by 1 — single insertion
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, d = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; } else { j++; if (++d > 1) return false; }
  }
  return true;
}

// ── Goal → steps[] auto-split ───────────────────────────────────────────────
// Deterministic shapes: "click 'X'" / "type 'T' into 'Y'" / "press 'x'".
// Anything else → one model-driven step (the observe→decide→act fallback).
function splitGoal(goal) {
  const g = String(goal || '');

  // "type 'T' into|in(to)? [the] 'Y'" — quoted field name optional
  let m = g.match(/(?:type|enter|write|input)\s+["'`](.+?)["'`]\s+(?:into|in(?:to)? the|in)\s+(?:the\s+)?["'`]?(.+?)["'`]?\s*$/i);
  if (m) return [{ action: 'type', text: m[1], match: m[2], why: 'type-into' }];

  // "click|press|open|select 'X'"
  m = g.match(/(?:click|press|tap|open|select|hit)\s+(?:the\s+|on\s+)?["'`](.+?)["'`]\s*$/i);
  if (m) return [{ action: 'click', match: m[1], why: 'click-quoted' }];

  // "click|open <thing>" unquoted — last 1-4 words as the match
  m = g.match(/(?:click|press|tap|open|select|hit)\s+(?:the\s+|on\s+)?([A-Za-z][\w .-]{0,40})\s*$/i);
  if (m) return [{ action: 'click', match: m[1].trim(), why: 'click-unquoted' }];

  // "press cmd+shift+p" / "press return"
  m = g.match(/(?:press|hit)\s+((?:cmd|ctrl|alt|shift|option)\+[\w+]+|escape|esc|return|enter|tab|space)\s*$/i);
  if (m) {
    const parts = m[1].toLowerCase().split('+');
    return [{ action: 'key', key: parts.pop(), mods: parts, why: 'key-combo' }];
  }

  return [{ action: 'auto', goal: g, why: 'model' }];
}

// ── Model pick (decision model — last resort / ambiguity only) ──────────────
// The exact {state, questions} the model sees — factored out so the debug
// endpoints (/screen.scene, /screen.debug.step) can return the write-up
// verbatim without asking. Options are scored sequentially on the small
// model — a 2-option call is ~3.5s, a 26-option call >25s and can never beat
// any sane timeout, so the model sorts the shortlist HEAD; the exhaust walk
// covers the tail anyway.
function _pickPayload(cands, goal, { extraNote = '', layout = '' } = {}) {
  const ranked = cands.slice(0, 8);
  const options = ranked.map((e, i) => `${i} = ${describe(e)}`);
  return {
    ranked,
    options,
    questions: [{
      id: 'pick', type: 'choice',
      question: `Screen elements are listed as "index = #id type "label" @(x,y,w×h)". ` +
                `${extraNote}Which index is the BEST element to interact with next to make progress toward the goal? ` +
                `If the goal appears already satisfied, pick "done". If none are relevant, pick "none".`,
      options: [...options, 'done — goal already satisfied', 'none — nothing relevant'],
      // 24-option picks run 4.5–7s on the small model under load — well past the
      // default ~6.4s batch timeout, which surfaced as "decision model
      // unavailable" and killed otherwise healthy runs.
    }],
    state: `GOAL: ${goal}${layout ? `\nSCREEN LAYOUT:\n${layout}` : ''}`,
  };
}

async function modelPick(cands, goal, { extraNote = '', layout = '' } = {}) {
  if (!decisionEnabled()) return { error: 'decision model disabled' };
  const _pp = _pickPayload(cands, goal, { extraNote, layout });
  const { ranked, options } = _pp;
  const r = await askDecision(_pp.questions, { state: _pp.state, timeoutMs: 20000 });

  const idx = r?.answers?.pick?.index;
  if (idx == null) return { error: 'decision model returned no answer' };
  if (idx === options.length - 2) return { done: true };
  // Any index past the real candidates is a 'nothing here' verdict — the
  // model sometimes answers 1-based (none = options.length, not length-1),
  // which used to surface as a spurious error instead of 'none'.
  if (idx === options.length - 1 || idx >= ranked.length) return { none: true, error: 'decision model found no relevant element' };
  return { element: ranked[idx] };
}

// ── Human-style hover fix: proximity → measure → drift → click ─────────────
// Elements' px positions are ground truth (inverse of the parse's own
// transform); cursorfind reports the cursor's true px via a cursor-hidden vs
// cursor-shown capture diff — the SAME image space, so the comparison needs
// no coordinate transform. Residual px error → pt delta via the best-known
// scale; converges in 1–2 iterations even when the scale guess is wrong.
// Each cursorfind also feeds the daemon's transform fit, healing the scale.
async function hoverFixClick(target, ctx, sessionId) {
  let clickPt = { x: target.center[0], y: target.center[1] };
  for (let i = 0; i < 3; i++) {
    const cf = await post('/screen/act',
      { action: 'cursorfind', windowOnly: ctx.windowOnly }, 20000).catch(() => null);
    if (!cf?.success || !Array.isArray(cf.cursor_px) || !Array.isArray(cf.cursor_pt)) break;
    if (Array.isArray(cf.fit_scale)) ctx.scale = cf.fit_scale;
    const [sx, sy] = ctx.scale || [1, 1];
    const [ox, oy] = ctx.offset || [0, 0];
    const [cxp, cyp] = cf.cursor_px;
    // element box back in image px (exact inverse of the parse transform)
    const bb = target.bbox || [];
    const pxBox = bb.length === 4
      ? { x: (bb[0] - ox) * sx, y: (bb[1] - oy) * sy, w: bb[2] * sx, h: bb[3] * sy } : null;
    // where the intended click point lands in image px
    const tp = { x: (clickPt.x - ox) * sx, y: (clickPt.y - oy) * sy };
    if (pxBox &&
        cxp >= pxBox.x - 2 && cxp <= pxBox.x + pxBox.w + 2 &&
        cyp >= pxBox.y - 2 && cyp <= pxBox.y + pxBox.h + 2) {
      return { pt: clickPt, iters: i, inBox: true };
    }
    const dx = (tp.x - cxp) / sx, dy = (tp.y - cyp) / sy;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return { pt: clickPt, iters: i, inBox: true };
    clickPt = { x: cf.cursor_pt[0] + dx, y: cf.cursor_pt[1] + dy };
    await mouseAgent({ action: 'move', x: clickPt.x, y: clickPt.y, sessionId }).catch(() => null);
  }
  return { pt: clickPt, iters: 3, inBox: false };
}

// ── Act on a resolved element ───────────────────────────────────────────────
async function actOnElement(step, target, sessionId, ctx = {}) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true };
  let [cx, cy] = target.center;
  // Composite OCR element — labels like "+ Add / Name & details" fuse
  // adjacent controls into one bbox; clicking its center lands on the wrong
  // control. When the step match resolves to one '/'/'|'-separated segment,
  // click that segment's proportional band inside the bbox instead.
  const _box = target.bbox || target.rect;
  if (step.match && Array.isArray(_box)) {
    const lbl = String(target.label || '');
    const m = String(step.match).toLowerCase().trim();
    if (/[/|]/.test(lbl)) {
      // Slash-fused controls ("+ Add / Name & details") — segment band.
      const segs = lbl.split(/\s*[/|]\s*/).filter(Boolean);
      const idx = segs.findIndex(s => {
        const sl = s.toLowerCase();
        return sl.includes(m) || (m.length > 1 && m.includes(sl.trim()));
      });
      if (idx >= 0 && segs.length > 1) {
        const total = segs.reduce((a, s) => a + s.length, 0);
        let off = 0;
        for (let i = 0; i < idx; i++) off += segs[i].length;
        cx = _box[0] + _box[2] * ((off + segs[idx].length / 2) / total);
        logger.info(`[screen.act] composite "${lbl.slice(0,40)}" — segment ${idx} "${segs[idx].slice(0,30)}" → x=${Math.round(cx)}`);
      }
    } else if (!target._dom && (!target._ax || /statictext|text|group/.test(String(target.tag || '')))
        && m.length > 1 && m.length < lbl.trim().length * 0.8) {
      // OCR/AX composite spanning adjacent links ("Andy Mineo, Lecrae") — the
      // match's char-offset band approximates its sub-span; center clicks
      // hit the FIRST link. AX/DOM targets are real nodes — skip them.
      const off = lbl.toLowerCase().indexOf(m);
      if (off >= 0) {
        const band = (off + m.length / 2) / lbl.length;
        const nx = _box[0] + _box[2] * band;
        if (nx > _box[0] + 2 && nx < _box[0] + _box[2] - 2) {
          cx = nx;
          logger.info(`[screen.act] composite "${lbl.slice(0,40)}" — subspan "${m}" @${band.toFixed(2)} → x=${Math.round(cx)}`);
        }
      }
    }
  }
  // DOM fast path — the extension drives the real node: React-aware fill for
  // fields (native setter + InputEvent), CDP-dispatched trusted click for
  // buttons. Physical typing into React controlled inputs drops keystrokes;
  // this path can't miss. Refs are per-snapshot — a stale ref fails honestly
  // and falls through to the physical path.
  // An affordance-moved target (right-edge row point, panel-edge point) must
  // NOT use dom:click — that resolves the node and clicks its center,
  // defeating the affordance. Physical click at the moved point instead.
  if (target._dom && target._ref && !target._affordMoved) {
    try {
      const gw = require('../ext.gateway.cjs');
      const action = step.action === 'type' ? 'fill' : 'click';
      const r = await gw.sendCmd({ sessionId: 'default', action,
        args: { selector: target._ref, text: step.text, expectLabel: String(target.label || '').slice(0, 60), expectTag: target.tag } }, 12000);
      if (r?.ok) {
        logger.info(`[screen.act] dom:${action} ref=${target._ref} "${String(target.label || '').slice(0, 40)}"`);
        if (step.action === 'type') {
          // Read the field's live value back — deterministic verify. OCR region
          // reads miss filled text (React renders it in the input, not flat
          // pixels the OCR reliably sees), which kept entities pinned in
          // pendingVerify and fuelled the retype loop.
          try {
            const rb = await gw.sendCmd({ sessionId: 'default', action: 'evaluate',
              args: { expression: `(() => { const el = document.querySelector('[data-td-ref="${target._ref}"]'); return el ? String(el.value || el.textContent || '') : null; })()` } }, 8000);
            let raw = rb;
            while (raw && typeof raw === 'object') raw = raw.value ?? raw.result ?? raw.data ?? '';
            const val = String(raw ?? '');
            const want = String(step.text || '').trim().toLowerCase();
            const got = val.trim().toLowerCase();
            const confirmed = want && got && (got.includes(want) || want.includes(got));
            logger.info(`[screen.act] dom:fill readback ref=${target._ref} value="${val.slice(0, 40)}" ${confirmed ? 'CONFIRMED' : 'MISMATCH'}`);
            if (val !== 'null' && !confirmed) return { ok: false, error: `fill readback: "${val.slice(0, 30)}"` };
          } catch (_) { /* readback failure doesn't undo a successful fill */ }
          if (/\benter\b/i.test(String(step.then || '')))
            await keyboardAgent({ key: 'return', sessionId });
        }
        return { ok: true };
      }
      logger.warn(`[screen.act] dom:${action} failed (${r?.error || 'no result'}) — physical fallback`);
    } catch (e) {
      logger.warn(`[screen.act] dom act error (${e.message}) — physical fallback`);
    }
  }
  // hover — position the cursor over the element without clicking. Reveals
  // hover-only controls (Spotify's '+', toolbar icons) for the NEXT step's
  // parse to see.
  if (step.action === 'hover' || step.action === 'move') {
    const r = await mouseAgent({ action: 'move', x: cx, y: cy, sessionId });
    return r.ok ? { ok: true } : { ok: false, error: `mouse: ${r.error}` };
  }
  const clickType = step.action === 'right-click' ? 'right-click'
    : step.action === 'double-click' ? 'double-click' : 'click';

  let px = cx, py = cy;
  if (clickType === 'click' && step.hoverFix !== false && ctx.scale) {
    await mouseAgent({ action: 'move', x: cx, y: cy, sessionId }).catch(() => null);
    const fix = await hoverFixClick(target, ctx, sessionId);
    if (fix.iters > 0) logger.info(`[screen.act] hoverFix iters=${fix.iters} inBox=${fix.inBox}`);
    px = fix.pt.x; py = fix.pt.y;
  }

  const actRes = await mouseAgent({ action: clickType, x: px, y: py, sessionId });
  logger.info(`[screen.act] ${clickType} @ (${Math.round(px)},${Math.round(py)}) target="${String(target.label || '').slice(0, 40)}" anchorCenter=(${Math.round(cx)},${Math.round(cy)})`);
  if (!actRes.ok) return { ok: false, error: `mouse: ${actRes.error}` };

  if (step.action === 'type') {
    // Focus settle — click→type needs a beat for web inputs to bind their
    // key handler (observed: 'KB' typed immediately after focusing Spotify's
    // React search field landed 'B' — the first keystroke was swallowed
    // before focus bound).
    await new Promise(r => setTimeout(r, step.focusSettleMs ?? 700));
    // selectAll — clicked into a field holding old content ("My Playlist #7")
    // that the typed text must REPLACE, not append to. The Cmd+A select itself
    // re-renders React fields — without a settle the next keystroke drops
    // (observed: 'Quiet Hour' → 'uiet Hour' every attempt).
    if (step.selectAll) {
      await keyboardAgent({ key: 'a', mods: ['cmd'], sessionId }).catch(() => null);
      await new Promise(r => setTimeout(r, step.selectAllSettleMs ?? 300));
    }
    if (step.text) {
      const t = await keyboardAgent({ text: String(step.text), sessionId });
      if (!t.ok) return { ok: false, error: `type: ${t.error}` };
    }
    if (/\benter\b/i.test(String(step.then || ''))) {
      await keyboardAgent({ key: 'return', sessionId });
    }
  }
  if (step.action === 'scroll') {
    await mouseAgent({ action: 'scroll', x: cx, y: cy, dx: step.dx || 0, dy: step.dy || -300, sessionId });
  }
  return { ok: true };
}

// ── Per-step verify: deterministic expected-state first ────────────────────
async function verifyStep(step, target, beforeEls, { display, windowOnly, sessionId }) {
  // hover/move positions the cursor — possibly revealing hover-only controls,
  // but it carries no expected state change of its own.
  if (step.action === 'hover' || step.action === 'move') return { verified: true, reason: 'positioned' };
  await new Promise(r => setTimeout(r, step.verifyDelayMs || 500)); // UI settle

  // Zoom-loop verify: park the cursor off-element (hover glow/tooltip fade →
  // the "after" shows the resting state), then diff the SAME crop captured
  // pre-act. Free and deterministic — decided before any label/model work.
  let regionDiff = null;
  if (step._preFp && target?.center) {
    const [cx, cy] = target.center;
    const parkX = cx - 180 > 20 ? cx - 180 : cx + 180;
    await mouseAgent({ action: 'move', x: parkX, y: cy, sessionId }).catch(() => null);
    await new Promise(r => setTimeout(r, 300));
    const after = await rectParse(step._preFp.rect, { display, windowOnly });
    regionDiff = fpDiff(step._preFp, after);
  }

  const check = await post('/screen/parse', { display, windowOnly }).catch(() => null);
  if (!check?.success) return { verified: null, reason: 're-parse failed' };
  const afterEls = check.elements || [];

  // expect — explicit post-state declared by the plan/deriver
  // {text:'x'|'!x', match:'x'|'!x', app:'x'|'!x'} — '!' prefix negates.
  // A HIT verifies fast. A MISS is only a stale-OCR-regex miss until proven
  // otherwise — fall through to the delta+model verify below so the observed
  // state decides, rather than retrying the same click blindly.
  let expectMiss = null;
  if (step.expect) {
    const ex = step.expect;
    const has = (needle) => !!afterEls.find(e =>
      String(e.label || '').toLowerCase().includes(needle.toLowerCase())
      && (step.action === 'type' || !_fieldContentHit(afterEls, e)));
    let ok = true; const why = [];
    if (ex.text)  { const neg = ex.text.startsWith('!'), n = neg ? ex.text.slice(1) : ex.text; if (has(n) === neg) ok = false; why.push(`text ${neg ? 'not ' : ''}"${n}"`); }
    if (ok && ex.match) { const neg = ex.match.startsWith('!'), n = neg ? ex.match.slice(1) : ex.match; if ((matchElements(afterEls, n).length > 0) === neg) ok = false; why.push(`match ${neg ? 'not ' : ''}"${n}"`); }
    if (ok && ex.app)   { const neg = ex.app.startsWith('!'), n = neg ? ex.app.slice(1) : ex.app; const fa = String(check.front_app || '').toLowerCase(); if (fa.includes(n.toLowerCase()) === neg) ok = false; why.push(`app ${neg ? 'not ' : ''}"${n}"`); }
    if (ok) return { verified: true, reason: `expect met: ${why.join(', ')}`, evidence: null };
    expectMiss = `expect regex missed — ${why.join(', ')}`;
  }

  // type step: the typed text should appear on screen — CORRECTLY.
  // Human verify reads the field, it doesn't pattern-match a prefix:
  // `randallakers.work@GMAIL>COM` must fail, not pass on "@gm" substring.
  if (step.action === 'type' && step.text) {
    const raw = String(step.text);
    const strict = /@/.test(raw) || (/^\S+$/.test(raw.trim()) && /[._]/.test(raw)); // emails, URLs, usernames, filenames
    const matches = (els) => els.find(e => {
      const label = String(e.label || '').toLowerCase();
      if (strict) return label.replace(/\s+/g, '').includes(raw.toLowerCase().replace(/\s+/g, ''));
      return label.includes(raw.toLowerCase().slice(0, 20))
        || label.split(/\s+/).some(w => w === raw.toLowerCase().split(/\s+/)[0]);
    });
    // Short text verifies anywhere on screen too easily — 'kb' matches a song
    // title's 'KB' far from the field we clicked. For ≤4 chars the text must
    // appear NEAR the click point, whatever capture it was seen in.
    // Region verify first — read the FIELD's own crop (.accurate OCR), not
    // the whole screen: "Quiet Hour" inside the name field verifies; the same
    // text sitting in a description or a page title does NOT.
    if (target?.bbox) {
      const rp = await rectParse(cropRectFor(target, 34), { display, windowOnly });
      const want = raw.toLowerCase().replace(/\s+/g, '');
      const rHit = (rp?.elements || []).find(e =>
        String(e.label || '').toLowerCase().replace(/\s+/g, '').includes(want));
      if (rHit) return { verified: true, reason: `field region shows "${String(rHit.label).slice(0, 40)}"`, evidence: rHit };
    }
    const inZone = (e) => !target?.center || (e.center &&
      Math.abs(e.center[0] - target.center[0]) < 120 &&
      Math.abs(e.center[1] - target.center[1]) < 80);
    const zoneReq = raw.length <= 4 && target?.center;
    let hit = matches(afterEls.filter(e => !zoneReq || inZone(e)));
    let near = !hit && afterEls.find(e => {
      const l = String(e.label || '').toLowerCase();
      return strict && l.replace(/\s+/g, '').includes(raw.toLowerCase().replace(/[\W_]+/g, '').slice(0, 12));
    });
    // Occlusion fallback: keys went to the KEY WINDOW even if another app's
    // dialog is z-order on top — SCK captures window content behind occlusion.
    if (!hit) {
      const wc = await post('/screen/parse', { display, windowOnly: true }).catch(() => null);
      const wEls = wc?.elements || [];
      hit = matches(wEls.filter(e => !zoneReq || inZone(e)));
      if (!near) near = wEls.find(e => {
        const l = String(e.label || '').toLowerCase();
        return strict && l.replace(/\s+/g, '').includes(raw.toLowerCase().replace(/[\W_]+/g, '').slice(0, 12));
      });
      if (hit) return { verified: true, reason: `text visible in window capture: "${hit.label}"`, evidence: hit };
    }
    if (!hit && near) {
      // text landed but CORRUPTED — the eyes saw it, now we judge it
      return { verified: false, reason: `typed text landed corrupted: expected "${raw.slice(0, 40)}" but screen shows "${near.label}"`, evidence: near };
    }
    // Focused field read — custom inputs (Spotify's React search box) don't
    // expose their value to the element parse, so "not found" fires even
    // when text landed. Re-click the RESOLVED field (the same point the act
    // clicked), then select-all+copy reads the REAL content. Never Cmd+A
    // unfocused — a page-context select-all highlights the whole page and
    // poisons the clipboard (observed: Spotify page fully selected).
    if (!hit && target?.center) {
      try {
        await mouseAgent({ action: 'click', x: target.center[0], y: target.center[1], sessionId }).catch(() => null);
        await new Promise(r => setTimeout(r, 350));
        await keyboardAgent({ key: 'a', mods: ['cmd'], sessionId }).catch(() => null);
        await new Promise(r => setTimeout(r, 150));
        await keyboardAgent({ key: 'c', mods: ['cmd'], sessionId }).catch(() => null);
        await new Promise(r => setTimeout(r, 200));
        const { spawnSync } = require('child_process');
        const rd = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 4000 });
        const clip = String(rd.stdout || '').replace(/\s+/g, ' ').trim();
        const want = raw.replace(/\s+/g, ' ').trim();
        if (clip === want) {
          return { verified: true, reason: `field value matches via clipboard: "${clip.slice(0, 40)}"` };
        }
        // Short clipboard = a field held focus and its content differs from
        // what we meant to type → corrupted landing, evidence feeds retype.
        if (clip && clip.length <= Math.max(want.length + 12, 60)) {
          return { verified: false, reason: `field value mismatched: expected "${want.slice(0, 40)}", field holds "${clip.slice(0, 40)}"`, evidence: target };
        }
        // Huge/empty clipboard = focus never bound in the field. Evidence
        // carries the resolved FIELD so recovery refocuses it, not a label
        // guess that blurs further.
      } catch (_) {}
      // collapse the selection, keep focus in the field for the next act
      await keyboardAgent({ key: 'arrowright', sessionId }).catch(() => null);
    }
    if (!hit) {
      return { verified: false, reason: 'typed text not found on re-parse', evidence: target || null };
    }
    return { verified: true, reason: `text visible: "${hit.label}"`, evidence: hit };
  }

  // ── Screen delta — what the eyes actually observed after the act ─────────
  const beforeLabels = new Set((beforeEls || []).map(e => String(e.label || '')));
  const afterLabelSet = new Set(afterEls.map(e => String(e.label || '')));
  const addedL = [...afterLabelSet].filter(l => l && !beforeLabels.has(l));
  const removedL = [...beforeLabels].filter(l => l && !afterLabelSet.has(l));
  const meanY = (list) => list.length ? list.reduce((s, e) => s + (e.center?.[1] || 0), 0) / list.length : 0;
  const delta = {
    added: addedL.length, removed: removedL.length,
    addedLabels: addedL, removedLabels: removedL,
    frontAppAfter: check.front_app || null,
    frontBundleAfter: check.front_bundle || null,
    toast: addedL.some(l => /\bundo\b|archived|deleted|moved to|sent\b/i.test(l)),
    contentShift: Math.round(meanY(afterEls) - meanY(beforeEls || [])),
    targetStillPresent: target ? !!afterEls.find(e => e.label === target.label && e.id === target.id) : null,
  };

  // Zoom-loop verdict — the target's own region changed. Stronger than label
  // deltas: catches icon swaps and dialogs OCR can't name. "Unchanged" only
  // feeds delta (a click can change far-away UI — let label-delta/model say).
  if (regionDiff?.changed === true && !expectMiss && step.action !== 'type' && step.action !== 'scroll') {
    return { verified: true, delta,
      reason: `region changed (${regionDiff.kind}, h=${regionDiff.hamming} lumΔ=${regionDiff.lumDelta})` };
  }
  if (regionDiff?.changed === false) delta.regionUnchanged = true;

  // scroll step: content should shift opposite to dy (scroll down ⇒ content up)
  if (step.action === 'scroll') {
    const dy = step.dy || -300;
    const ok = Math.abs(delta.contentShift) > 15 && (dy < 0 ? delta.contentShift < 0 : delta.contentShift > 0);
    return { verified: ok, delta,
      reason: ok ? `content shifted ${delta.contentShift}px`
                 : `scroll had no/wrong effect (shift ${delta.contentShift}px)` };
  }

  // click step: did the element we clicked disappear/state change, or did
  // new content arrive? Deterministic diff first. When an expect regex just
  // missed, a bare "something changed" isn't proof — a negated expectation
  // can still be violated — so route to the model with the miss in view.
  if (delta.added + delta.removed > 2 && !expectMiss)
    return { verified: true, delta, reason: `screen changed (+${delta.added} −${delta.removed} labels)` };

  // miss short-circuit — target still right there, nothing changed.
  // Don't pay ~2.4s for the model on the most common failure.
  if (target && delta.targetStillPresent)
    return { verified: false, delta, reason: 'miss: screen unchanged, target still present' };

  // Fuzzy state → decision YES/NO (the eyes).
  const v = await askDecision([{
    id: 'verify', type: 'choice',
    question: `After clicking element "${(target?.label || '').slice(0, 40)}" at (${target?.center}), ` +
              `did the screen state change in a way consistent with the goal? ` +
              `Compare the goal, the clicked label, and the new element labels.`,
    options: ['yes — expected change happened', 'no — screen unchanged / wrong result'],
  }], { state: `GOAL: ${step.goal || step.match || ''}${expectMiss ? `\nNOTE: ${expectMiss} — the learned expectation may be stale; judge whether the intended state change actually happened from what's on screen NOW.` : ''}\nNEW ELEMENTS: ${afterEls.filter(e => e.label).slice(0, 30).map(e => e.label).join(' | ')}`, timeoutMs: 20000 });
  const verified = v?.answers?.verify?.index === 0 ? true : (v?.answers?.verify?.index === 1 ? false : null);
  return { verified, delta, reason: verified ? 'model: change confirmed' : 'model: no change seen' };
}

// ── Mistake classification: what did the eyes actually see? ────────────────
// A human doesn't "undo the step" — they read the CURRENT screen and fix
// THAT state. Kinds (first match wins), corrections are all existing
// primitives — keyboard/mouse/focus stay dumb hands, this is the brain.
function classifyMistake(step, res, ctx, dialogUp) {
  const d = res.delta || {};
  if (dialogUp) return 'modal';
  if (ctx.app && d.frontAppAfter &&
      !String(d.frontAppAfter).toLowerCase().includes(ctx.app.toLowerCase())) return 'app-switch';
  if (step.action === 'type' && step.text) return 'field';
  if (step.action === 'scroll') return 'over-scroll';
  const removalIntent = /delete|remove|close|archive|trash|dismiss|clear/i
    .test(`${step.goal || ''} ${step.match || ''} ${step.why || ''}`);
  if (d.toast || (d.removed > d.added && d.removed > 2 && !removalIntent)) return 'mutation';
  if (/chrome|safari|arc|edge|firefox|finder/i.test(d.frontBundleAfter || '') &&
      (d.added + d.removed) > 15 && d.targetStillPresent === false) return 'navigation';
  if (d.added + d.removed <= 2) return 'miss';
  return 'unknown';
}

// ── Recovery on verify failure — human-style: notice → correct → proceed ───
async function recoverStep(step, sessionId, ctx, evidence, attempt = 1, res = {}) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true };
  const sleep = _sleep; // abortable — resolves early when _ACT_SIGNAL aborts
  const display = ctx?.display ?? -1;

  // stray-dialog detection (window-scoped) — feeds classification
  const w = await post('/screen/parse', { display, windowOnly: true }).catch(() => null);
  const wEls = w?.elements || [];
  const wLabels = wEls.map(e => String(e.label || ''));
  const dialogUp = wLabels.some(l => /^(cancel|close|discard|don'?t save|ok)$/i.test(l.trim()))
    && wLabels.some(l => /open|save|choose|are you sure/i.test(l));

  const kind = classifyMistake(step, res, ctx, dialogUp);
  logger.warn(`[screen.act] recovery kind=${kind} attempt=${attempt}`);

  // Re-observe before correcting — recovery acts on the CURRENT screen, not
  // the state at act-time. A crashed page ("went wrong", reload prompt) can't
  // be fixed by clicking around inside a dead renderer: escalate ONCE per run
  // to a fresh browser window at the same URL instead of reload-looping.
  const obs = await post('/screen/parse', { display, windowOnly: ctx.windowOnly }).catch(() => null);
  const curLabels = (obs?.elements || []).map(e => String(e.label || '')).join(' | ');
  if (ctx.startUrl && !ctx._newCtxUsed &&
      /went wrong|try reloading|can'?t be reached|page isn'?t working|error occurred|something went wrong/i.test(curLabels)) {
    ctx._newCtxUsed = true;
    logger.warn(`[screen.act] recovery: page crashed — opening ${ctx.startUrl} in a fresh window`);
    require('child_process').spawnSync('open',
      ctx.browserName ? ['-na', ctx.browserName, ctx.startUrl] : [ctx.startUrl]);
    await sleep(3000);
    if (ctx.app) await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
    return;
  }

  switch (kind) {
    case 'modal': {
      // Escape reaches the key window even when the panel owns a different app
      await keyboardAgent({ key: 'escape', sessionId });
      await sleep(400);
      const w2 = await post('/screen/parse', { display, windowOnly: true }).catch(() => null);
      const still = (w2?.elements || []).some(e => /^(cancel|close|discard)$/i.test(String(e.label || '').trim()));
      if (still) {
        const btn = (w2.elements || []).find(e => /^(cancel|close|discard|don'?t save)$/i.test(String(e.label || '').trim()));
        if (btn?.center) await mouseAgent({ action: 'click', x: btn.center[0], y: btn.center[1], sessionId }).catch(() => null);
        await sleep(400);
      }
      break;
    }
    case 'app-switch':
      // wrong app on top — switch back, retry
      await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
      await sleep(800);
      break;
    case 'navigation':
      // wrong link took us somewhere — back, then re-pick
      await keyboardAgent({ key: '[', mods: ['cmd'], sessionId });
      await sleep(700);
      break;
    case 'mutation':
      // something got deleted/moved/archived — undo OUR act, once per step
      if (!ctx._undoUsed) {
        ctx._undoUsed = true;
        await keyboardAgent({ key: 'z', mods: ['cmd'], sessionId });
        await sleep(500);
      }
      break;
    case 'over-scroll':
      await mouseAgent({ action: 'scroll', x: step.x || 0, y: step.y || 0,
        dx: -(step.dx || 0), dy: -(step.dy || -300), sessionId }).catch(() => null);
      await sleep(400);
      break;
    case 'field': {
      // evidence = the resolved field element (verify returns it). Click IT —
      // not a label guess — so focus lands in the input, then read its real
      // content via select-all+copy. Retype ONLY when the read proves a text
      // field holds focus (short clipboard); a page-sized copy means the
      // click missed and typing would go to the page. No Cmd+Z: unfocused
      // undo can revert real work (observed: page-level select-all + undo
      // after Spotify's search blurred).
      if (evidence?.center) {
        logger.warn(`[screen.act] field recovery: refocusing "${String(evidence.label || '').slice(0, 40)}" @${evidence.center}`);
        await mouseAgent({ action: 'click', x: evidence.center[0], y: evidence.center[1], sessionId }).catch(() => null);
        await sleep(450);
      }
      await keyboardAgent({ key: 'a', mods: ['cmd'], sessionId }).catch(() => null);
      await sleep(150);
      await keyboardAgent({ key: 'c', mods: ['cmd'], sessionId }).catch(() => null);
      await sleep(200);
      let clip = '';
      try {
        const { spawnSync } = require('child_process');
        clip = String(spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 4000 }).stdout || '').replace(/\s+/g, ' ').trim();
      } catch (_) {}
      const want = String(step.text || '').replace(/\s+/g, ' ').trim();
      const fieldFocused = clip && clip.length < 200;
      if (fieldFocused && clip !== want) {
        // selection is live in the field — typing replaces it wholesale
        logger.warn(`[screen.act] field recovery: field holds "${clip.slice(0, 40)}" — retyping "${want.slice(0, 40)}"`);
        await keyboardAgent({ text: want, sessionId }).catch(() => null);
        await sleep(300);
      } else if (!fieldFocused && evidence?.center && attempt < 3) {
        // Focus never bound — one more deliberate refocus, leave it settled
        // for the retry's click+settle+type sequence.
        logger.warn('[screen.act] field recovery: focus not in field — refocusing again');
        await mouseAgent({ action: 'click', x: evidence.center[0], y: evidence.center[1], sessionId }).catch(() => null);
        await sleep(500);
      }
      return; // skip the universal Escape — it would blur the refocused field
    }
    case 'miss':
    case 'unknown':
    default:
      // retry re-picks a different candidate (excludeIds) — just dismiss menus
      break;
  }

  // universal cheap dismiss — menus/popovers swallowed by a wrong click
  await keyboardAgent({ key: 'escape', sessionId });
  await sleep(300);
}

// ── Single-step executor with verify+recover ───────────────────────────────
async function runStep(step, ctx) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true };
  const { display, windowOnly, sessionId, goal, excludeIds } = ctx;

  const sleep = _sleep; // abortable — resolves early when _ACT_SIGNAL aborts

  // Anchor-alternative steps mutate step.match/dx/dy during resolution (the
  // winning alt's re+offset get written back for the pick). Restore the
  // originals at the top of EVERY attempt so retries re-evaluate which
  // landmark actually OCR'd this parse instead of probing a stale string.
  if (step._alts) { step.match = step._alts; step.dx = step._dx0; step.dy = step._dy0; }
  else if (Array.isArray(step.match)) { step._alts = step.match; step._dx0 = step.dx; step._dy0 = step.dy; }

  // waitMatchMs — poll until the match target appears (page loads, popouts,
  // workspace switches). Timeout → honest failure, not a blind click.
  let parsed = await post('/screen/parse', { display, windowOnly });
  if (!parsed.success) return { ok: false, error: parsed.error || 'parse failed' };
  // Frontmost guard — if focus was stolen between steps (user click, dialog,
  // another app), re-focus the expected app BEFORE matching; otherwise every
  // match/click lands on the wrong window's elements.
  if (ctx.app && parsed.front_app && !parsed.front_app.toLowerCase().includes(String(ctx.app).toLowerCase())) {
    await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
    await sleep(800);
    parsed = await post('/screen/parse', { display, windowOnly }).catch(() => parsed);
  }
  let els = scopeElements(parsed.elements || [], `${goal || ''} ${step.match || ''}`, null, ctx.memory?.dlgFurniture, parsed);
  // The transform that produced THESE elements — needed to invert pt→px for
  // the hover-fix loop. Refresh whenever a new parse replaces `parsed`.
  ctx.scale = parsed.scale; ctx.offset = parsed.offset;
  // optional — conditional repair step ("if the error state shows, fix it").
  // Absent target → skip cleanly instead of failing the whole task.
  if (step.optional && step.match) {
    const hit = String(step.match).startsWith('@icon')
      ? iconAnchor(els, step.match, ctx.lastTarget)
      : matchElements(els, step.match).length;
    if (!hit) return { ok: true, skipped: true };
  }
  if (step.waitMatchMs && step.match) {
    // @icon: probes resolve through iconAnchor — the raw string never labels
    // anything, and the icon itself is detector-flaky so the poll must check
    // the real anchor→icon resolution.
    const probe = (list) => Array.isArray(step.match)
      ? step.match.some(a => matchElements(list, String(a.re || '')).length)
      : step.match === '@prev'
      ? !!ctx.lastTarget
      : String(step.match).startsWith('@icon')
      ? !!iconAnchor(list, step.match, ctx.lastTarget)
      : matchElements(list, step.match).length;
    const deadline = Date.now() + step.waitMatchMs;
    while (!probe(els) && Date.now() < deadline) {
      await sleep(400);
      const p2 = await post('/screen/parse', { display, windowOnly }).catch(() => null);
      if (p2?.success) { parsed = p2; els = scopeElements(p2.elements || [], `${goal || ''} ${step.match || ''}`, null, ctx.memory?.dlgFurniture, p2); ctx.scale = p2.scale; ctx.offset = p2.offset; }
    }
    if (!probe(els)) {
      return { ok: false, error: `waitMatch timeout: "${step.match}" never appeared` };
    }
  }
  // pre/preUnless — prerequisite UI state (an open menu, an expanded panel).
  // If the unless-pattern is absent, run the pre-action and re-parse. On
  // retries this re-opens whatever transient UI closed between steps — the
  // recover loop can't reach backward, but the gate runs before every attempt.
  if (step.pre?.match && step.preUnless &&
      !matchElements(els, step.preUnless).length) {
    const pt = String(step.pre.match).startsWith('@icon')
      ? iconAnchor(els.filter(e => !excludeIds.has(_fpLoose(e))), step.pre.match, ctx.lastTarget)
      : matchElements(els, step.pre.match).filter(e => !excludeIds.has(_fpLoose(e)))[0];
    if (pt) {
      await actOnElement(step.pre, pt, sessionId, ctx).catch(() => null);
      await sleep(step.pre.settleMs || 700);
      const p3 = await post('/screen/parse', { display, windowOnly }).catch(() => null);
      if (p3?.success) {
        parsed = p3; els = scopeElements(p3.elements || [], `${goal || ''} ${step.match || ''}`, null, ctx.memory?.dlgFurniture, p3);
        ctx.scale = p3.scale; ctx.offset = p3.offset;
      }
    }
  }
  ctx.lastEls = els;
  if (!els.length) return { ok: false, error: 'no elements detected' };

  // auth-wall detection — don't flail against a login screen
  const labels = els.map(e => String(e.label || '').toLowerCase()).join(' | ');
  if (/\b(sign in|log in|log in to|create (an )?account|enter (your )?password|choose an account)\b/.test(labels)
      && !/(sign in|log in|password|account)/i.test(String(step.match || '') + String(step.text || ''))) {
    return { ok: false, error: 'auth-wall', verifyReason: 'sign-in wall detected on screen' };
  }

  // key steps need no element
  if (step.action === 'key') {
    const r = await keyboardAgent({ key: step.key, mods: step.mods || [], sessionId });
    if (step.settleMs) await sleep(step.settleMs);
    const kv = step.expect ? await verifyStep(step, null, els, { display, windowOnly, sessionId }) : { verified: null };
    return r.ok ? { ok: kv.verified !== false, output: `key ${step.mods?.join('+') ? step.mods.join('+') + '+' : ''}${step.key}`, verified: kv.verified, verifyReason: kv.reason }
                : { ok: false, error: `key: ${r.error}` };
  }

  // shortcut steps — runtime discovery chain: cache → menubar → model → web
  if (step.action === 'shortcut') {
    const { resolveShortcut } = require('../skill-helpers/shortcut-cache.cjs');
    const combo = await resolveShortcut(parsed.front_app || step.app || '', step.intent || step.match || '', step.shortcutOpts || {});
    if (!combo) {
      if (step.required !== false) return { ok: false, error: `no shortcut found for "${step.intent || step.match}"` };
      return { ok: false, soft: true, error: 'shortcut-miss' };
    }
    const r = await keyboardAgent({ key: combo.key, mods: combo.mods || [], sessionId });
    if (step.settleMs) await sleep(step.settleMs);
    const sv = step.expect ? await verifyStep(step, null, els, { display, windowOnly, sessionId }) : { verified: null };
    return r.ok
      ? { ok: sv.verified !== false, output: `shortcut ${combo.mods.join('+')}${combo.mods.length ? '+' : ''}${combo.key} [${combo.src}]`, pickPath: `shortcut-${combo.src}`, verified: sv.verified, verifyReason: sv.reason }
      : { ok: false, error: `shortcut: ${r.error}` };
  }

  // paste — long content via clipboard: pbcopy → ⌘V → verify.
  // ~1s for any length vs ~25ms/char typing. step.via==='clipboard' on a type
  // step aliases here. Cursor lands at the END of pasted text, so verify the
  // tail, not the head.
  if ((step.action === 'paste' || (step.action === 'type' && step.via === 'clipboard')) && step.text) {
    if (ctx.app && parsed.front_app &&
        !parsed.front_app.toLowerCase().includes(ctx.app.toLowerCase())) {
      logger.warn(`[screen.act] front_app "${parsed.front_app}" ≠ "${ctx.app}" — refocusing before paste`);
      await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
      await sleep(700);
    }
    const { spawnSync } = require('child_process');
    const wr = spawnSync('pbcopy', [], { input: String(step.text) });
    if (wr.status !== 0) return { ok: false, error: `pbcopy: ${wr.stderr || wr.status}` };
    const pv = await keyboardAgent({ key: 'v', mods: ['cmd'], sessionId });
    if (!pv.ok) return { ok: false, error: `paste: ${pv.error}` };
    await sleep(step.settleMs || 700);
    // verify via a synthetic type step carrying the text tail
    const tail = String(step.text).replace(/\s+/g, ' ').trim();
    const v = await verifyStep(
      { ...step, action: 'type', text: tail.slice(-40) }, null, els,
      { display, windowOnly, sessionId });
    return { ok: v.verified !== false, lowConfidence: v.verified === false,
      output: `pasted ${tail.length} chars`, pickPath: 'clipboard',
      verified: v.verified, verifyReason: v.reason, evidence: v.evidence, delta: v.delta };
  }

  // copy_page — NutJS-free 'scan_page': select-all + copy the focused page via
  // keyboard.agent (CGEvent), then read the clipboard. Replaces app.agent's
  // scan_page for page-content reads inside the physical-interaction model.
  if (step.action === 'copy_page') {
    await keyboardAgent({ key: 'a', mods: ['cmd'], sessionId }).catch(() => null);
    await sleep(250);
    await keyboardAgent({ key: 'c', mods: ['cmd'], sessionId }).catch(() => null);
    await sleep(step.settleMs || 800);
    const { spawnSync } = require('child_process');
    const rd = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 5000 });
    const text = String(rd.stdout || '');
    if (!text.trim()) return { ok: false, error: 'copy_page: clipboard empty after Cmd+A/Cmd+C', pickPath: 'copy_page' };
    return { ok: true, output: text, pickPath: 'copy_page', verified: true };
  }

  // verify — final-state gate. Parses the screen and requires step.check
  // (substring or /regex/) to appear in element labels. This is the honest
  // "did the task actually happen" check — no click, just observation.
  // check may be {"$slot":n} hydrated upstream; plain strings are fine.
  if (step.action === 'verify') {
    const want = step.check ?? step.text;
    if (!want) return { ok: false, error: 'verify: no check value', pickPath: 'verify' };
    // JS oracle — canvas surfaces (Sheets/Docs) expose DOM truth OCR can't
    // read (name box #t-name-box shows the pasted range 'A1:C5'). Requires
    // "Allow JavaScript from Apple Events"; null → fall through to OCR.
    if (step.js) {
      const { browserJs } = require('../skill-helpers/browser-js.cjs');
      const out = await browserJs(ctx.browserName || ctx.app || 'Google Chrome', step.js);
      if (out != null) {
        if (String(out).toLowerCase().includes(String(want).toLowerCase()))
          return { ok: true, verified: true, output: `verify(js): "${String(out).slice(0, 60)}"`, pickPath: 'verify' };
        return { ok: false, error: `verify(js): got "${String(out).slice(0, 50)}" ≠ "${String(want).slice(0, 40)}"`,
          verified: false, pickPath: 'verify' };
      }
      emit('verify: js oracle unavailable — falling back to OCR');
    }
    const re = String(want).startsWith('/')
      ? new RegExp(String(want).slice(1, String(want).lastIndexOf('/')), 'i')
      : null;
    const needle = re ? null : String(want).toLowerCase();
    const deadline = Date.now() + (step.waitMatchMs || 4000);
    for (;;) {
      const vp = await post('/screen/parse', { display, windowOnly }).catch(() => null);
      const els2 = vp?.elements || [];
      const hit = els2.find(e => {
        const lbl = String(e.label || e.text || '');
        return (re ? re.test(lbl) : lbl.toLowerCase().includes(needle)) && !_fieldContentHit(els2, e);
      });
      if (hit) return { ok: true, verified: true, output: `verify: found "${String(hit.label || hit.text).slice(0, 60)}"`, pickPath: 'verify' };
      if (Date.now() >= deadline) {
        return { ok: false, error: `verify: "${String(want).slice(0, 50)}" not found after ${step.waitMatchMs || 4000}ms`,
          verified: false, pickPath: 'verify' };
      }
      await sleep(800);
    }
  }

  // bare type with no match — type at current focus (webview-focus rule:
  // app commands focus fields; a blind click can defocus them).
  // But CGEvent keys go to the KEY WINDOW, not the active app — `open -a` can
  // leave key focus on a different window (multi-window apps, dialogs). Human
  // fix: click the largest content area of the target window first.
  if (step.action === 'type' && !step.match && !step._target && step.text) {
    if (ctx.app && parsed.front_app &&
        !parsed.front_app.toLowerCase().includes(ctx.app.toLowerCase())) {
      logger.warn(`[screen.act] front_app "${parsed.front_app}" ≠ "${ctx.app}" — refocusing before type`);
      await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
      await sleep(700);
    }
    if (step.clickWindow === true) {
      // click the largest content area of the frontmost window to make it key
      const wp = await post('/screen/parse', { display, windowOnly: true }).catch(() => null);
      const we = (wp?.elements || []).filter(e => e.region !== 'menubar' && e.center);
      if (we.length) {
        const big = we.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
        await mouseAgent({ action: 'click', x: big.center[0], y: big.center[1], sessionId }).catch(() => null);
        await sleep(350);
      }
    }
    const t = await keyboardAgent({ text: String(step.text), sessionId });
    if (!t.ok) return { ok: false, error: `type: ${t.error}` };
    if (step.settleMs) await sleep(step.settleMs);
    const v = await verifyStep(step, null, els, { display, windowOnly, sessionId });
    return { ok: v.verified !== false, lowConfidence: v.verified === false,
      output: `typed "${String(step.text).slice(0, 30)}" at focus`, pickPath: 'focus',
      verified: v.verified, verifyReason: v.reason, evidence: v.evidence, delta: v.delta };
  }

  // scroll needs no element pick — explicit coords, or the biggest content
  // area of the frontmost window (humans scroll the window, not an icon)
  if (step.action === 'scroll') {
    let sx = step.x, sy = step.y;
    if (sx == null || sy == null) {
      const we = els.filter(e => e.region !== 'menubar' && e.center && e.w && e.h);
      const big = we.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      if (!big) return { ok: false, error: 'no scrollable area found' };
      sx = big.center[0]; sy = big.center[1];
    }
    await mouseAgent({ action: 'scroll', x: sx, y: sy,
      dx: step.dx || 0, dy: step.dy || -300, sessionId }).catch(() => null);
    if (step.settleMs) await sleep(step.settleMs);
    const v = await verifyStep(step, null, els, { display, windowOnly, sessionId });
    return { ok: v.verified !== false, lowConfidence: v.verified === false,
      output: `scroll @(${sx},${sy}) dy:${step.dy || -300}`, pickPath: 'coords',
      verified: v.verified, verifyReason: v.reason, delta: v.delta };
  }

  // resolve target
  let target = null;
  let pickPath = 'none';
  // _target — element picked by the auto loop's own fresh parse. Bypasses
  // label matching entirely (the model already chose it); runStep still owns
  // act + verify so hoverFix/recover semantics stay identical.
  if (!target && step._target?.center) { target = step._target; pickPath = 'model-direct'; }
  if (!target && step.element_id != null) {
    target = els.find(e => e.id === step.element_id && !excludeIds.has(_fpLoose(e)));
    pickPath = 'element_id';
  }
  // match-alternatives — [{re, dx, dy}] tries each anchor in order; the first
  // with hits sets the step's own offset. For "click X relative to whichever
  // landmark actually OCR'd this parse" — different anchors need different
  // offsets, which a single match+dy can't express.
  if (!target && Array.isArray(step.match)) {
    for (const alt of step.match) {
      const hits = matchElements(els, String(alt.re || '')).filter(e => !excludeIds.has(_fpLoose(e)));
      if (hits.length) {
        step.match = String(alt.re);
        step.dx = alt.dx || 0; step.dy = alt.dy || 0;
        break;
      }
    }
    if (typeof step.match !== 'string') return { ok: false, error: 'match-alternatives: no anchor appeared' };
  }
  // '@prev' — reuse the previous step's resolved anchor. Learned flows chain
  // spatial relations (field → chip offset → row icon) without baking
  // term-specific match strings into the recipe.
  if (!target && step.match === '@prev') {
    if (ctx.lastTarget?.center) { target = ctx.lastTarget; pickPath = 'prev'; }
    else return { ok: false, error: 'prev-anchor: no previous resolved element' };
  } else if (!target && step.match && String(step.match).startsWith('@icon')) {
    target = iconAnchor(els.filter(e => !excludeIds.has(_fpLoose(e))), step.match, ctx.lastTarget);
    if (target) pickPath = 'icon-anchor';
    else return { ok: false, error: `icon-anchor miss "${step.match}"` };
  } else if (!target && step.match) {
    let hits = matchElements(els, step.match).filter(e => !excludeIds.has(_fpLoose(e)));
    // tipLabel fallback — the probe-mined tooltip name, matched when the
    // stored OCR label misses (the tooltip says what the icon really is).
    if (!hits.length && step.tipLabel) {
      hits = matchElements(els, step.tipLabel).filter(e => !excludeIds.has(_fpLoose(e)));
      if (hits.length) pickPath = 'tip-label';
    }
    const norm = String(step.match).toLowerCase().trim();
    const exact = hits.filter(e => String(e.label || '').toLowerCase() === norm);
    if (exact.length === 1) { target = exact[0]; pickPath = 'match-exact'; }
    else if (hits.length === 1) { target = hits[0]; pickPath = 'match'; }
    else if (hits.length > 1) {
      const pick = await modelPick(hits, goal || step.match, { extraNote: 'These candidates matched the target label — pick the best one. ' });
      if (pick.element) { target = pick.element; pickPath = 'match+model'; }
      else if (pick.error) {
        // Model unavailable — deterministic disambiguation. When every hit
        // carries the SAME merged label tiled across a row ("File Edit View…
        // Help" per menu item), the match's char-offset fraction in the label
        // maps to the tile holding those glyphs ("File"→leftmost tile).
        const pool = (exact.length ? exact : hits).filter(e => e.region === 'app');
        const rank = pool.length ? pool : (exact.length ? exact : hits);
        const lbl0 = String(rank[0]?.label || '').toLowerCase();
        const midx = lbl0.indexOf(norm);
        if (midx >= 0 && rank.every(e => String(e.label || '').toLowerCase() === lbl0)) {
          const xs = rank.map(e => e.center?.[0] ?? 0);
          const lo = Math.min(...xs), hi = Math.max(...xs);
          // Identical SHORT labels ("Add" per result row) are repeated
          // buttons, not one tiled label — the frac map doesn't apply;
          // the topmost is the first result, which is what a human picks.
          if (hi > lo && lbl0.length > 8) {
            const wantX = lo + ((midx + norm.length / 2) / lbl0.length) * (hi - lo);
            target = [...rank].sort((a, b) =>
              Math.abs((a.center?.[0] ?? 0) - wantX) - Math.abs((b.center?.[0] ?? 0) - wantX))[0];
          } else {
            target = [...rank].sort((a, b) =>
              ((a.center?.[1] ?? 1e9) - (b.center?.[1] ?? 1e9)) ||
              ((a.center?.[0] ?? 1e9) - (b.center?.[0] ?? 1e9)))[0];
          }
        }
        if (!target) {
          target = [...rank].sort((a, b) =>
            (String(a.label || '').length - String(b.label || '').length) ||
            ((a.center?.[1] ?? a.bbox?.[1] ?? 1e9) - (b.center?.[1] ?? b.bbox?.[1] ?? 1e9)) ||
            ((a.center?.[0] ?? a.bbox?.[0] ?? 1e9) - (b.center?.[0] ?? b.bbox?.[0] ?? 1e9)))[0] || null;
        }
        if (!target) return { ok: false, error: pick.error };
        pickPath = 'match-precise';
      }
    } else {
      pickPath = 'match-miss';
    }
  }
  if (!target && step.action !== 'auto') {
    // match missed (or no match given for click) — model over full shortlist
    const cands = shortlist(els.filter(e => !excludeIds.has(_fpLoose(e))), `${goal || ''} ${step.match || ''}`, parsed);
    const pick = await modelPick(cands, goal || step.match || step.text || '');
    if (pick.done) return { ok: true, alreadySatisfied: true, output: 'goal already satisfied' };
    if (pick.element) { target = pick.element; pickPath = 'model'; }
    else return { ok: false, error: pick.error || 'no relevant element' };
  }

  if (!target) return { ok: false, error: `no element resolved for step ${JSON.stringify(step.match || step.action)}` };

  // Infer-veto — the resolved target's category can't serve the action
  // (type→omnibox/doctext, click→windowchrome). Free reject before the
  // mouse moves; recovery re-resolves with this id excluded.
  if (target.center) {
    _lastParsed = parsed;
    inferRole(target, els, parsed);
    const veto = roleVeto(target, step.action === 'type' ? 'type' : 'click', step.match || step.goal || goal, Boolean(step.match));
    if (veto) {
      excludeIds?.add?.(_fpLoose(target));
      return { ok: false, error: `infer: ${veto}`, lowConfidence: true };
    }
  }

  // Click-point refinement — a MERGED label ("Untitled document Saved to
  // Drive") centers on whitespace/icons, not the widget. Descend into the
  // detector/OCR elements inside the label bbox: click the tightest one
  // whose own label carries the match, else leftmost (text leads icons).
  // Skipped when dx/dy is set — the offset is relative to the anchor's
  // center, not the match's glyph position.
  if (step.match && !(step.dx || step.dy) && target.bbox && String(target.label || '').length > String(step.match).length * 1.5 && target.bbox[2] > 100) {
    const [bx, by, bw, bh] = target.bbox;
    const m = String(step.match).toLowerCase();
    const inside = els.filter(e => e !== target && e.center && e.bbox &&
      e.center[0] >= bx - 6 && e.center[0] <= bx + bw + 6 &&
      e.center[1] >= by - 6 && e.center[1] <= by + bh + 6 &&
      (e.bbox[2] || 0) < bw * 0.9);
    if (inside.length) {
      const named = inside.filter(e => String(e.label || '').toLowerCase().includes(m));
      const labeled = inside.filter(e => String(e.label || '').trim());
      // match text leads a merged label — prefer the element carrying the
      // label itself; else any labeled sub-element; else leftmost widget.
      const pool = named.length ? named : (labeled.length ? labeled : inside);
      const tighter = [...pool].sort((a, b) =>
        (a.center[0] - b.center[0]) || (a.center[1] - b.center[1]))[0];
      if (tighter) { target = tighter; pickPath += '+inner'; }
    } else {
      // No sub-element — estimate the match's position inside the merged
      // label from its char fraction, applied to the DOMINANT merge axis:
      // a stacked menu ("Rename 11 Move to trash") merges vertically → the
      // y-fraction locates the item row; a tiled row (menubar) merges
      // horizontally → the x-fraction locates the tile.
      const lbl = String(target.label || '').toLowerCase();
      const idx = lbl.indexOf(m);
      if (idx >= 0) {
        const frac = Math.min(0.95, Math.max(0.05, (idx + m.length / 2) / Math.max(1, lbl.length)));
        // A tall merged box = stacked rows (menu items) → match maps to a
        // y-offset; a thin box = one text row (tiled labels) → x-offset.
        target = bh > 40
          ? { ...target, center: [bx + bw / 2, by + frac * bh] }
          : { ...target, center: [bx + frac * bw, by + bh / 2] };
        pickPath += '+textoff';
      }
    }
  }

  // dx/dy offset — click relative to the anchor, for elements the detector
  // can't see at all (hover-highlighted menu rows read as background). The
  // bbox shifts too so hover-fix compares against the intended cell.
  if (target && (step.dx || step.dy)) {
    const [ox, oy] = [step.dx || 0, step.dy || 0];
    target = { ...target,
      center: [target.center[0] + ox, target.center[1] + oy],
      bbox: target.bbox ? [target.bbox[0] + ox, target.bbox[1] + oy, target.bbox[2], target.bbox[3]] : target.bbox,
      label: `${target.label || ''}@+${ox},${oy}` };
    pickPath += '+off';
  }

  // Replay target validation — an anchor+offset resolution must land on the
  // CATEGORY recorded at learn time (step.role). Layout shifts retarget
  // dx/dy onto unrelated controls (observed: "your library"+offset →
  // "Browse videos" promo card). Role drift ⇒ resolution miss → recovery
  // re-picks instead of committing blind.
  if (target && step.role && target.center) {
    _lastParsed = parsed;
    inferRole(target, els, parsed);
    const want = String(step.role);
    if (target._role != 'unknown' && target._role != want)
      return { ok: false, error: `replay role drift: stored ${want} got ${target._role}`, lowConfidence: true };
  }

  // @icon: contract — an icon-spec step must resolve to an UNLABELED
  // element. A labeled hit means resolution fell through to generic
  // matching and committed to an unrelated control (observed: @icon:your
  // library → "Browse videos" promo card after layout shift).
  if (target && String(step.match || '').startsWith('@icon')) {
    const lbl = String(target.label || '').replace(/@[+-][0-9-]+,[0-9-]+$/, '').trim();
    if (lbl)
      return { ok: false, error: `icon-spec resolved to labeled "${lbl.slice(0, 30)}"`, lowConfidence: true };
  }

  // '@prev' anchor = the point this step actually acted on (post-offset) —
  // spatial chains compose: field → chip offset → row icon all hang off it.
  ctx.lastTarget = target;

  // Hover probe — pre-commit evidence for ambiguous targets: unlabeled icons
  // the model guessed at. A tooltip names the icon (carried into the learned
  // recipe as _tipLabel); an affordance diff confirms interactivity; neither
  // → dead target handed to recovery instead of a blind commit.
  if (/click|double-click|right-click/.test(step.action) &&
      !String(target.label || '').trim() && target.type === 'icon' &&
      step.probe !== false) {
    const probe = await probeCandidate(target, { display, windowOnly, sessionId, ctx, els, parsed, intent: 'click', goal: step.goal || goal });
    if (probe.tooltip) target = { ...target, _tipLabel: probe.tooltip };
    if (probe.dead) {
      excludeIds?.add?.(_fpLoose(target));
      return { ok: false, error: `probe: dead target #${target.id} — no tooltip, no hover state`, lowConfidence: true };
    }
  }

  // Pre-act region fingerprint — verify diffs the SAME crop afterwards.
  // Cursorless capture so the moving pointer can't pollute either side.
  if (/click|double-click|right-click|type/.test(step.action) && target?.bbox) {
    const fp = await rectParse(cropRectFor(target), { display, windowOnly });
    if (fp?.phash) step._preFp = { phash: fp.phash, lum: fp.lum, rect: cropRectFor(target) };
  }

  // act
  const actRes = await actOnElement(step, target, sessionId, ctx);
  if (!actRes.ok) return { ok: false, error: actRes.error };
  if (step.settleMs) await sleep(step.settleMs);

  // verify
  const v = await verifyStep(step, target, els, { display, windowOnly, sessionId });
  return {
    ok: v.verified !== false,
    output: `${step.action === 'type' ? 'typed in' : step.action} #${target.id} "${(target.label || '').slice(0, 50)}" @ (${target.center}) [${pickPath}]`,
    element: target,
    pickPath,
    verified: v.verified,
    verifyReason: v.reason,
    evidence: v.evidence,
    delta: v.delta,
    lowConfidence: v.verified === false,
  };
}

// ── Auto loop: runtime observe→decide→act for goals no recipe covers ──────
// planSkillsV2 emits ONE screen.task step carrying the full goal; when
// deriveSteps misses the flow-cache and clauses match no deterministic
// pattern, ui-plan emits {action:'auto'} instead of clause→literal-click
// gibberish. This loop decomposes at RUNTIME against the live element list:
// each iteration shortlists real candidates, the decision model picks ONE
// index for the next micro-action, runStep owns act+verify, and the trace
// serializes into a learned recipe — so run 2+ replays deterministically.

// Unlabeled element → anchor to the previously acted element ('@prev'+offset)
// or the nearest labeled element + offset. Replay resolves the anchor, then
// clicks anchor-center+Δ — lands on the icon without baking coords into JSON.
function _unlabeledAnchor(el, prev, els) {
  if (prev?.center) {
    const dx = Math.round(el.center[0] - prev.center[0]);
    const dy = Math.round(el.center[1] - prev.center[1]);
    if (Math.abs(dx) < 400 && Math.abs(dy) < 400) return { match: '@prev', dx, dy };
  }
  let best = null, bd = 1e9;
  for (const e of els || []) {
    const l = String(e.label || '').trim();
    if (!l || !e.center || e === el) continue;
    const d = Math.hypot(e.center[0] - el.center[0], e.center[1] - el.center[1]);
    if (d < bd) { bd = d; best = e; }
  }
  if (best && bd < 350) {
    return { match: String(best.label).slice(0, 60),
      dx: Math.round(el.center[0] - best.center[0]),
      dy: Math.round(el.center[1] - best.center[1]) };
  }
  return null;
}

// Micro-action → replayable recipe step. Labeled picks keep their OCR label;
// unlabeled icons become anchor+offset. Type text travels as an entity slot
// via serializeSteps downstream.
function _serializeAutoStep(micro, el, prev, els, tipLabel) {
  if (!el?.center) return null;
  // tipLabel — a tooltip mined by the hover probe. Stored so replay can match
  // the element by its REAL name when OCR never labeled it.
  const tip = tipLabel ? { tipLabel: String(tipLabel).slice(0, 60) } : {};
  // role — the inferred category at learn time; replay can veto a target
  // whose role flipped (element recycled for a different control).
  const role = el._role && el._role !== 'unknown' ? { role: el._role } : {};
  const label = String(el.label || '').trim();
  if (label) {
    const base = { match: label.slice(0, 60), ...tip, ...role };
    if (micro.action === 'type') return { action: 'type', ...base, text: micro.text, why: 'auto' };
    return { action: 'click', ...base, why: 'auto' };
  }
  const base = _unlabeledAnchor(el, prev, els);
  if (!base) return null;
  if (micro.action === 'type') return { action: 'type', match: base.match, dx: base.dx, dy: base.dy, text: micro.text, why: 'auto', ...tip, ...role };
  return { action: 'click', match: base.match, dx: base.dx, dy: base.dy, why: 'auto', ...tip, ...role };
}

async function runAutoLoop(step, ctx, outerIdx, onStep, totalSteps, opts = {}) {
  const { display, windowOnly, sessionId, goal, excludeIds } = ctx;
  const sleep = _sleep; // abortable — resolves early when _ACT_SIGNAL aborts
  const g = step.goal || goal;
  _CUR_GOAL = g;
  // Progress buys time — a bulk work-set drains at ~6-10 iters per item,
  // so each verified removal extends the budget instead of running a flat
  // cap that dies mid-set. Stagnation still exhausts normally.
  let maxIters = step.bulk
    // Navigation alone eats ~10 iters; the first arm→menu→commit→verify
    // cycle ~8-10 more, then ~4 per additional item under replay. A 20-cap
    // dies before chain #1 verifies — bulk drains need room up front. The
    // planner's maxIters is a floor, not a cap, for bulk work-sets.
    ? Math.max(step.maxIters || 0, 40)
    : (step.maxIters || 20);
  maxIters = Math.min(maxIters, step.bulk ? 60 : 30);
  // Entities in extraction order — playlist name first, then add/search terms.
  // Each input-like pick types the next un-typed entity. A mid-plan fallback
  // passes only the entities whose steps haven't run yet (pendingOverride) —
  // re-typing already-typed values would corrupt fields.
  const _GENERIC_ENT = /^(songs?|episodes?|playlists?|tracks?|music|podcasts?|items?)$/i;
  // "a song from artist Lecrae" is extracted whole — the searchable term is
  // the proper noun, not the wrapper. Strip catalog-noun prefixes so the
  // search field and the URL template get "Lecrae", not the full phrase.
  const _cleanEnt = _cleanSharedEnt;
  // entityItems — complete items the materialization layer parsed from an
  // attachment extraction ("songs in the screenshot" → the full list). They
  // win over extractEntities(g): on a blob-carrying goal the extractor emits
  // clipped fragments that get typed verbatim into search fields.
  const pending = ((Array.isArray(step.entityItems) && step.entityItems.filter(Boolean).length
    ? [...step.entityItems]
    : Array.isArray(opts.pendingOverride) && opts.pendingOverride.filter(Boolean).length
      ? [...opts.pendingOverride]
      : flowCache.extractEntities(g)).map(_cleanEnt)
    .filter(t => t && !_GENERIC_ENT.test(String(t).trim())));
  // The destination is a NAVIGATE target, never a type payload —
  // extractEntities can't tell "Lecrae" (entity) from "Quiet Hour"
  // (destination), so "Quiet Hour" stayed in pending and got typed into the
  // in-playlist search (searching the destination as a song). Strip it in
  // both directions of containment.
  if (ctx.destination) {
    const _d = String(ctx.destination).toLowerCase().trim();
    for (let i = pending.length - 1; i >= 0; i--) {
      const t = String(pending[i]).toLowerCase().trim();
      if (t === _d || _d.includes(t) || t.includes(_d)) pending.splice(i, 1);
    }
  }
  // Bulk goals have no entity to type — the container is the anchor and the
  // action is per-row. Stop extractEntities from re-deriving one ("Quiet
  // Hour" must be a navigate target, never typed into a field).
  if (step.bulk) pending.length = 0;
  // A URL-seeded search entity is already located on the results page —
  // it goes to pendingVerify (row-find + commit), never back into typing.
  if (ctx._searchSeeded) {
    const ss = String(ctx._searchSeeded).toLowerCase();
    for (let i = pending.length - 1; i >= 0; i--)
      if (String(pending[i]).toLowerCase().includes(ss)) pending.splice(i, 1);
    if (!ctx.memory.pendingVerify.some(t => String(t).toLowerCase() === ss))
      ctx.memory.pendingVerify.push(ctx._searchSeeded);
    ctx.memory.acquired = ctx.memory.acquired ?? 0;
    // Settle once — a URL-seeded page still loading yields a truncated
    // tree (first observe saw 25 elements mid-render); give it a beat
    // before the walk's first act.
    if (!ctx.memory.seededSettled) { ctx.memory.seededSettled = true; await sleep(1800); }
  }
  const checkRaw = step.check ?? (step.verify && typeof step.verify === 'object' ? step.verify.check : null);
  const checkStr = (checkRaw == null || typeof checkRaw === 'object') ? null : String(checkRaw);
  // Bulk goal-shape — "remove all the songs from X": no entity to type, the
  // container is the navigate-to target, and once inside it the commit is a
  // per-row remove loop until the row set is empty.
  if (step.bulk) ctx.memory.bulk = String(step.bulk);
  // List-delete exclusions — "except 'Quiet Hour'" names the work rows that
  // must never be armed. Vetoed from queue + arm selection below.
  if (Array.isArray(step.except) && step.except.length) {
    ctx.memory.exceptSet = new Set(step.except.map(s => String(s).toLowerCase().trim()).filter(Boolean));
    logger.info(`[screen.act] bulk-delete exceptSet: ${[...ctx.memory.exceptSet].join(' | ')}`);
  }
  // needsUser resume — caller passed answers from a previous run's
  // question: [{label, decision:'commit'|'skip'}]. Commit-answers extend
  // the delete vocab for this app (learned), skip-answers feed badWork.
  if (Array.isArray(step.answers) && step.answers.length) {
    for (const a of step.answers) {
      const lab = String(a?.label || '').trim();
      if (!lab) continue;
      if (a.decision === 'commit') {
        _vocab.learnAction(String(ctx.app || ctx._goalApp || "app").toLowerCase(), lab, 'delete');
        // A queued row was badWork'ed when its question was raised — a
        // commit answer must RELEASE it or it can never re-arm.
        if (ctx.memory.badWork) for (const bk of [...ctx.memory.badWork])
          if (_sameWork(bk, lab)) ctx.memory.badWork.delete(bk);
      } else if (a.decision === 'skip') (ctx.memory.badWork ||= new Set()).add(_workKey(lab));
    }
    logger.info(`[screen.act] bulk delete: ${step.answers.length} user answer(s) applied`);
  }
  // Container-open detection — the destination page is "open" when a big
  // header/title element matches it, or after we've committed a destination
  // item. Until then, destination matches are NAVIGATE commits, not actions.
  ctx.memory.containerOpenedAt = ctx.memory.containerOpenedAt ?? null;

  const trace = [], learned = [], acts = [...(opts.seedActs || [])];
  let prev = null;                    // last acted {center,label}
  let lastId = null, sameCount = 0;
  let parseErrs = 0, exhaustRounds = 0;

  const emit = (t) => { if (!_aborted() && typeof onStep === 'function') { try { onStep(t, outerIdx, totalSteps || 1); } catch (_) {} } };
  ctx.emit = emit; // probe/verify events reach the same progress channel

  // ── Preflight: fail fast on dead services instead of discovering it 8
  // iterations in. The phi4 ping doubles as tev1:0.8b pre-warm — the first
  // real decision then hits a loaded model, not a cold one.
  if (!ctx._preflighted) {
    ctx._preflighted = true;
    const pp = await post('/screen/parse', { display, windowOnly }, 8000).catch(() => null);
    if (!pp?.success) return { ok: false, error: 'preflight: screen-intel unreachable', iters: 0, trace, learned, acts };
    const warm = await askDecision([{ id: 'pw', type: 'choice', question: 'pick one', options: ['a', 'b'] }],
      { state: 'preflight warm-up', timeoutMs: 30000 });
    if (!warm) emit('preflight: decision model cold/slow — walk will use structural order');
  }

  const fail = (error, iters) => {
    logger.warn(`[screen.act] auto-loop FAIL: ${error} (${iters} iters) — acts: ${acts.slice(-5).join('; ')}`);
    return { ok: false, error: `auto: ${error} (${iters} iters)`, iters, trace, learned, acts };
  };
  const pass = (output, iters, verified) => {
    logger.info(`[screen.act] auto-loop PASS: ${output}`);
    return { ok: true, output, verified, iters, trace, learned, acts };
  };

  for (let iters = 0; iters < maxIters; iters++) {
    if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, iters, trace, learned, acts };
    // ── observe ──────────────────────────────────────────────────────────
    // AX-first fast lane (ctx.fastAx) — td-ax returns the full web tree in
    // ~0.6s; the 2-9s OCR parse is redundant on AX-rich iterations. Element-
    // set diffs verify commits in place of phash; a real parse still runs to
    // seed dims and as an audit every 5th iteration.
    let _axPre = null;
    // Slow-menu settle — DOM context menus render ~300-600ms after the
    // right-click; a parse that lands mid-render enumerates nothing and
    // the arm reads as "menu never materialized".
    if (ctx.memory?.bulk === 'delete' && ctx.memory?.armedLabel
        && ctx.memory.bulkClickedAt != null && iters - ctx.memory.bulkClickedAt <= 2)
      await sleep(400);
    // Armed bulk-delete rows need the OCR lane: Chrome's native context
    // menu is a separate window layer the window-scoped AX tree never
    // publishes, so _domObs would drop every menu item.
    if (ctx.fastAx && !ctx._axBail && ctx._lastDims && !ctx.memory?.armedLabel
        && (ctx._axIter = (ctx._axIter || 0) + 1) % 5 !== 0)
      _axPre = await _axObserve(ctx, ctx._goalApp || ctx.app).catch(() => null);
    if (!ctx._axLogOnce) { ctx._axLogOnce = true;
      logger.info(`[screen.act] fastAx gate: fastAx=${ctx.fastAx} bail=${!!ctx._axBail} dims=${!!ctx._lastDims} pre=${_axPre ? _axPre.flat.length : 'null'}`); }
    let parsed = (_axPre && _axPre.flat.length >= 20)
      ? { success: true, front_app: ctx._goalApp || ctx.app || null, elements: [],
          scale: ctx.scale || [1, 1], offset: ctx.offset || [0, 0], size_px: ctx._lastDims,
          _axFast: true }
      : await post('/screen/parse', { display, windowOnly }).catch(() => null);
    if (parsed?.size_px && !parsed._axFast) ctx._lastDims = parsed.size_px;
    if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, iters, trace, learned, acts };
    if (!parsed?.success) {
      if (++parseErrs > 3) return fail('parse failed repeatedly', iters);
      await sleep(800); iters--; continue;
    }
    parseErrs = 0;
    ctx.scale = parsed.scale; ctx.offset = parsed.offset;
    // Front-app pinning — windowOnly follows whatever window is frontmost, so
    // a sideways click that shifts focus (to a terminal, a toast, a different
    // app) reparses the WRONG window and the walk starts driving it. Pin the
    // app that was frontmost when the walk began and refocus on drift.
    if (!ctx._goalApp && parsed.front_app) ctx._goalApp = parsed.front_app;
    const goalApp = ctx.app || ctx._goalApp;
    if (goalApp && parsed.front_app &&
        !parsed.front_app.toLowerCase().includes(String(goalApp).toLowerCase())) {
      emit(`focus drifted to "${parsed.front_app}" — refocusing ${goalApp}`);
      await post('/screen/act', { action: 'focus', app: goalApp }).catch(() => null);
      await sleep(700);
      iters--; continue; // reparse the correct window next iteration
    }
    // Domain isolation: url tasks own only the content viewport — elements
    // outside it (tabs, omnibox, bookmark band, popovers, other windows)
    // never become candidates, so they cost zero probes and can never commit.
    const _domain = ctx._domain || (ctx._domain =
      ctx.startUrl || ctx.browserName ? 'url' : ctx.app ? 'app' : 'desktop');
    const _ocrEls = scopeElements(parsed.elements || [], g, _domain, ctx.memory?.dlgFurniture, parsed);
    // Precise element source — macOS AX first (native + Chromium/Electron
    // web content under --enhance; no extension needed). The extension DOM
    // path is legacy opt-in via TD_EXTENSION=1. OCR stays available for
    // non-AX evidence (file pickers, print sheets) via ctx._ocrEls.
    // Armed lanes get AX too — web-rendered menus (Spotify's) are in the
    // enhanced AX tree as menu/menuitem elements with real bboxes. Native
    // menus (separate window layer) still need the OCR lane, so while armed
    // the merge below is a forced union: AX can never drop OCR evidence.
    let _domObs = _axPre || (ctx._axBail ? null : await _axObserve(ctx, parsed.front_app).catch(() => null));
    if (!ctx._axLogTwice) { ctx._axLogTwice = true;
      logger.info(`[screen.act] fastAx domObs: ${_domObs ? _domObs.flat.length : 'null'} flat, ocr=${_ocrEls.length}`); }
    if (!_domObs && _domain === 'url' && process.env.TD_EXTENSION === '1') {
      _domObs = await _domObserve(ctx).catch(() => null);
    }
    // Sparse-AX merge — Chromium sometimes publishes only chrome-level nodes
    // (webarea children lag or never arrive): AX said "25 elements" while
    // OCR saw a full results page. When AX is far thinner than OCR, union
    // the sources instead of discarding the richer one.
    let els;
    const _armed = !!ctx.memory?.armedLabel;
    if (!_domObs) els = _ocrEls;
    else if (!_armed && _domObs.flat.length >= Math.max(30, _ocrEls.length * 0.6)) els = _domObs.flat;
    else {
      const _fpMerge = (e) => `${Math.round((e.center?.[0] || 0) / 12)}:${Math.round((e.center?.[1] || 0) / 12)}:${String(e.label || '').toLowerCase().slice(0, 20)}`;
      const seen = new Set(_domObs.flat.map(_fpMerge));
      els = [..._domObs.flat, ..._ocrEls.filter(e => !seen.has(_fpMerge(e)))];
      if (!ctx._sparseAxLogged) { ctx._sparseAxLogged = true; emit(`ax: sparse (${_domObs.flat.length} ax vs ${_ocrEls.length} ocr) — merged`); }
    }
    ctx._ocrEls = _ocrEls;
    // Frame-voting ring — last 3 parses' element fingerprints. Elements that
    // appear in ≥2 frames are temporally stable (real rows); single-frame
    // sightings are flicker/virtualization ghosts. Menu items are exempt by
    // caller (transient by design — they'd never survive a vote).
    const _fpEl = (e) => `${Math.round((e.center?.[0] || 0) / 12)}:${Math.round((e.center?.[1] || 0) / 12)}:${String(e.label || '').toLowerCase().slice(0, 20)}`;
    (ctx._frames || (ctx._frames = [])).push(new Set(els.map(_fpEl)));
    if (ctx._frames.length > 3) ctx._frames.shift();
    const _voted = (e) => {
      if (e._ax || e._dom) return true;         // structural sources are trusted
      const k = _fpEl(e);
      return ctx._frames.filter(f => f.has(k)).length >= 2
        || ctx._frames.length < 2;              // not enough history yet
    };
    ctx._voted = _voted;
    // Window/tab awareness — a click can spawn a tab or window without the
    // domain string changing (target=_blank with no URL swap on AX, app
    // windows). Track counts + active index each observe; a change is a
    // scene-level event — the old page's candidates are dead by definition.
    {
      const _tab = await _tabProbe(ctx).catch(() => null);
      const _cur = { windows: _domObs?.windows ?? null, tabs: _tab?.count ?? null,
                     active: _tab?.active ?? null, url: _tab?.url || _domObs?.url || '' };
      const _prev = ctx.memory.winState;
      ctx.memory.winState = _cur;
      // URL changes are already a scene domain-jump — this tracks what the
      // scene can't see: window count, tab count, active-tab index.
      if (_prev && ((_cur.windows != null && _prev.windows != null && _cur.windows !== _prev.windows)
          || (_cur.tabs != null && _prev.tabs != null && _cur.tabs !== _prev.tabs)
          || (_cur.active != null && _prev.active != null && _cur.active !== _prev.active))) {
        emit(`domain: jump ${(_prev.url || '?').slice(0, 45)} → ${(_cur.url || '?').slice(0, 45)}`
          + ` (win ${_prev.windows ?? '?'}→${_cur.windows ?? '?'}, tab ${_prev.active ?? '?'}→${_cur.active ?? '?'})`);
        ctx.memory.domainJumps = (ctx.memory.domainJumps || 0) + 1;
        ctx.memory.prevTab = _prev.active ?? null; // for tab-aware back-out
        lastId = null;
      }
    }
    // Scene graph — the world-model: domain anchors, cursor, trail, views.
    // DOM observations arrive pre-treed; OCR gets the thin clustering pass.
    const _sg = require('../skill-helpers/scene.graph.cjs');
    if (!ctx.scene) ctx.scene = _sg.initScene(_domObs?.domain || parsed.front_app || ctx.app || 'unknown');
    const _sceneTree = _domObs?.tree
      || _sg.buildOcrTree(els, { app: parsed.front_app || ctx.app || 'app',
           domain: parsed.front_app || 'native', dlg: detectDialog(els),
           size: parsed.size_px || [1440, 900] }).tree;
    if (!_domObs) _sg.annotateElements(els, 'ocr');
    else {
      // Sparse-AX merge unions bare OCR elements into the AX list — those
      // never saw annotateElements, so no _scope (search fields never become
      // type targets), no _containerRole, no _inOpenMenu. Annotate only the
      // un-annotated subset; dom elements keep their richer AX annotations.
      const _bare = els.filter(e => e._container === undefined && e._scope === undefined);
      if (_bare.length) _sg.annotateElements(_bare, 'ocr');
    }
    const _sceneEv = _sg.observeScene(ctx.scene, _sceneTree, _domObs?.domain || ctx.scene.domain);
    // Overlay-layer lifecycle — CGWindowList popup truth + dialog-tree
    // evidence feed open/close events. A foreign layer that persists is
    // foreign UI stealing focus (dead-space menus, stuck panels); the lane
    // reads ctx._layerEvents for its dismiss policy.
    ctx._layerEvents = (_sg.observeLayers ? _sg.observeLayers(ctx.scene, {
      popups: parsed.layers || [], dlg: detectDialog(els), iter: iters,
    }) : []);
    if (_sceneEv.domainJump) {
      emit(`scene: domain → ${_sceneEv.to}`);
      logger.info(`[screen.act] scene domain-jump ${_sceneEv.from} → ${_sceneEv.to}`);
      logger.info(`[screen.act] scene:\n${_sg.serialize(ctx.scene.tree, { cursor: ctx.scene.cursor })}`);
    }
    if (_domObs && !ctx._domAnnounced) { ctx._domAnnounced = true; emit(`${_domObs.src || 'dom'}: ${els.length} live elements`); }
    if (!els.length) { await sleep(700); iters--; continue; }
    // Infer layer — enrichLayout derives rows/containers/icon-bindings from
    // coordinates FIRST so inferRole can promote composites; then every
    // element gets a structural category before any decision runs.
    _lastParsed = parsed;
    enrichLayout(els, parsed, ctx.memory.dlgFurniture);
    els.forEach(e => inferRole(e, els, parsed));
    _attachCaptions(els);
    // State-diff: elements unseen since the last parse are what the last
    // commit produced (a dialog's field, a results list) — they lead the
    // queue. Flag lasts exactly one observation.
    for (const e of els) {
      const k = _fpLoose(e);
      e._isNew = !ctx.memory.seen.has(k);
      ctx.memory.seen.add(k);
    }

    // Front-app guard — the walk owns ctx.app's window. If a different app is
    // frontmost (IDE left over, stray focus steal), refocus rather than act on
    // the wrong window. Capped so a stubborn app doesn't consume the run.
    if (ctx.app && parsed.front_app &&
        !String(parsed.front_app).toLowerCase().includes(String(ctx.app).toLowerCase())) {
      ctx.memory.focusMisses = (ctx.memory.focusMisses || 0) + 1;
      if (ctx.memory.focusMisses <= 4) {
        acts.push(`(wrong front app "${parsed.front_app}" — refocusing ${ctx.app})`);
        emit(`focus: ${parsed.front_app} front — refocusing ${ctx.app}`);
        await post('/screen/act', { action: 'focus', app: ctx.app }).catch(() => null);
        await sleep(500);
        continue;
      }
    } else ctx.memory.focusMisses = 0;

    // Tab-drift guard — same app is frontmost but the active tab is NOT the
    // task's doc marker (the front window flipped to another browser window
    // mid-run — observed: sheet task wandered onto a YouTube window). Re-pin
    // to the marker tab, bounded so a missing doc fails honestly.
    if (ctx._tabMatch && ctx.app && parsed.front_app
        && String(parsed.front_app).toLowerCase().includes(String(ctx.app).toLowerCase())
        && ctx.memory.winState?.url && !String(ctx.memory.winState.url).includes(ctx._tabMatch)
        && (ctx.memory.tabRepins || 0) < 2) {
      ctx.memory.tabRepins = (ctx.memory.tabRepins || 0) + 1;
      emit(`tab drift: "${String(ctx.memory.winState.url).slice(0, 45)}" ≠ "${ctx._tabMatch}" — re-pinning`);
      if (await _focusTabMatch(ctx.browserName || ctx.app, ctx._tabMatch)) {
        await sleep(600);
        continue;
      }
      // No matching tab — drop the pin claim so it doesn't loop forever.
      ctx._tabMatch = null;
    }

    // Unexpected modal = interaction trap that domain scoping can't see
    // (same front_app): file pickers, print sheets, or a goal-irrelevant app
    // dialog the walk clicked into. Escape → Cancel/OK → Cmd+. then give up —
    // a "dialog" that survives 3 escapes is page furniture (in-page panel),
    // not a modal, so it's fingerprinted and ignored for the rest of the run.
    let _dlgNow = detectDialog(els);
    // Geometry veto first — a wide+short strip (media/transport bar), a tall
    // side panel (now-playing), or a cluster covering most of the window is
    // page furniture BY SHAPE, never a modal. scopeElements applies the same
    // rule to the pool; the trap path must not wait 4 sightings while it
    // fires Escape into a persistent panel (observed: Spotify's now-playing
    // strip eaten 3 escapes + identity back-outs).
    if (_dlgNow) {
      const _fw = _pxW(parsed), _fh = _pxH(parsed);
      const _isStrip = _dlgNow.rect[2] > _fw * 0.7 && _dlgNow.rect[3] < _fh * 0.25;
      const _isPanel = _dlgNow.rect[2] < _fw * 0.4 && _dlgNow.rect[3] > _fh * 0.6;
      const _isHuge = _dlgNow.rect[2] * _dlgNow.rect[3] > _fw * _fh * 0.55;
      if (_isStrip || _isPanel || _isHuge) _dlgNow = null;
    }
    // Dialog-furniture accounting — a "dialog" whose rect fingerprint is
    // unchanged across ≥4 observes is page furniture (in-page panel), not a
    // modal. Real dialogs mutate or close; furniture doesn't.
    if (_dlgNow) {
      const fp = _dlgFp(_dlgNow);
      ctx.memory.dlgCounts = ctx.memory.dlgCounts || new Map();
      ctx.memory.dlgFurniture = ctx.memory.dlgFurniture || new Set();
      const n = (ctx.memory.dlgCounts.get(fp) || 0) + 1;
      ctx.memory.dlgCounts.set(fp, n);
      if (n >= 4) {
        if (!ctx.memory.dlgFurniture.has(fp)) emit(`dialog: persistent panel → furniture (${fp})`);
        ctx.memory.dlgFurniture.add(fp);
        _dlgNow = null;
      }
    }
    // Container-open state — the destination page is "open" when a
    // header-ish element in the main region matches the destination, or a
    // destination item was committed earlier. Until it opens, a destination
    // match is a NAVIGATE commit (opens the container), not a nav trap.
    const _destLo2 = String(ctx.destination || '').toLowerCase().trim();
    const _destKind = (String(g).toLowerCase().match(/\b(playlist|folder|album|board|collection|channel|project|space)\b/) || [])[1] || null;
    const _MAIN_X = 300;
    const _destHeader = _destLo2 && els.find(e => {
      const l = String(e.label || '').toLowerCase().trim();
      if (!e.center || l.length < 2) return false;
      if (!(l === _destLo2 || (l.startsWith(_destLo2) && l.length < _destLo2.length + 20))) return false;
      // Page header = content region only. A "Quiet Hour" card in the
      // now-playing/right PANEL (x > .75w) is furniture, not the header.
      // Phantom-dialog iters stamp content 'dialog' — a top-of-page dest
      // title is still the header (menu items can't sit at y<380, x>300
      // while stage<3 anyway).
      return (e._regionRole === 'content' || (e._regionRole === 'dialog' && !_menuishEl(e)))
        && e.center[0] > _MAIN_X && e.center[1] < 380;
    });
    // Scene-identity latch — a dest-click only OPENS the container when the
    // scene confirms it: header matches, or the page left the search route.
    // A bare-text click that didn't navigate must not flip IN-CONTAINER.
    // Identity URL — _domObs.domain is empty on AX/OCR-path iters; the tab
    // probe's AppleScript URL is the deterministic source and is refreshed
    // every iteration.
    const _dom = String(ctx.memory.winState?.url || _domObs?.domain || '');
    // URL latch — not "left search" (home → /album/ satisfies that too and
    // was the recurring false-open). With a known kind, latch ONLY on a
    // kind-route match (/playlist/<id>); kind unknown → any deep non-root
    // route counts.
    const _leftSearch = ctx.memory.transPending != null && iters > ctx.memory.transPending
      && _dom && (_destKind
        ? (_dom.toLowerCase().includes(`/${_destKind}/`)
          // Collection-style containers ("/collection/tracks") are the same
          // entity class as "playlist" — the kind word is a user-level noun,
          // not a URL segment guarantee.
          || (_destKind === 'playlist' && /\/collection\//i.test(_dom)))
        : !/\/(search|$|\?)/i.test(_dom.replace(/^https?:\/\/[^/]+/i, '')));
    // No URL (ocr path) → scene-turnover is the evidence: the element set
    // after a dest-click looks nothing like the results page it came from.
    const _fp = els.slice(0, 30).map(e => String(e.label || '')).sort().join('|');
    const _sceneChanged = ctx.memory.transPending != null && iters > ctx.memory.transPending
      && ctx.memory.preTransFp && ctx.memory.preTransFp !== _fp;
    if (ctx.memory.transPending != null && iters > ctx.memory.transPending + 4) {
      // Unconfirmed transition — the clicked label led nowhere verifiable.
      // Mark it dead so the same decoy ("Quiet Hour" track inside the wrong
      // album) stops being re-picked as a transition candidate.
      if (ctx.memory.lastTransLabel)
        (ctx.memory.badTrans || (ctx.memory.badTrans = new Set())).add(ctx.memory.lastTransLabel);
      ctx.memory.transPending = null;
      ctx.memory.verifying = null;
    }
    // Scene-identity MISMATCH — a transition committed and the URL moved,
    // but to the WRONG entity type ("/track/" when the goal's container is
    // a playlist). Back out and mark that route dead so it isn't re-picked.
    if (ctx.memory.transPending != null && iters > ctx.memory.transPending
        && _destKind && _dom && !/\/search\//i.test(_dom)
        && /\/(track|album|artist|episode|show|genre|user|video|watch)\//i.test(_dom)
        && !_dom.toLowerCase().includes(_destKind)) {
      const _dead = ctx.memory.lastTransLabel || '';
      (ctx.memory.badTrans || (ctx.memory.badTrans = new Set())).add(_dead);
      emit(`identity: "${_dead}" → ${_dom.split('/').slice(3, 5).join('/')} ≠ ${_destKind} — back out`);
      ctx.memory.transPending = null;
      // Back-keypress only where Back is real — a parsed URL means browser
      // semantics. In native apps the chord walks app history to an
      // unrelated page (observed: Spotify alt+left → a previous artist).
      if (_dom) await keyboardAgent({ key: 'left', mods: ['alt'], sessionId }).catch(() => null);
      await sleep(700);
      continue;
    }
    // A root-page "Quiet Hour" card on the home feed is a recommendation,
    // not the container's header — header-latch only counts on a deep URL.
    // The clicked tile itself is a y<380 content label, so latching on
    // _destHeader while still on home is a false-open. When the URL is
    // visible, a root path ('/' or '') vetoes header-latch outright; when
    // no URL is available, require the scene to have actually changed.
    const _domPath = _dom ? (_dom.replace(/^https?:\/\//i, '').replace(/^[^/]+/, '') || '/') : '';
    const _rootPage = !!_dom && /^\/?.?$/.test(_domPath);
    const _headerLatch = _destHeader && ctx.memory.transPending != null
      && !_rootPage && (_dom ? true : !!_sceneChanged);
    if ((_headerLatch || _leftSearch) && ctx.memory.containerOpenedAt == null) {
      ctx.memory.containerOpenedAt = iters;
      ctx.memory.containerHost = String(_dom).replace(/^https?:\/\//, '').split('/')[0] || null;
      ctx.memory.verifying = null;
      ctx._containerSearch = false;
      emit(`container: "${ctx.destination}" page open${!_destHeader ? ' (via url)' : ''}`);
    }
    const _containerOpen = ctx.memory.containerOpenedAt != null;
    // Continuous scene-identity — the latch is not a lifetime pass. Inside
    // the container, a scene that moved to a wrong entity route or left the
    // latched host entirely (user browsed elsewhere, stray nav) is a
    // MISMATCH: back out and re-latch on return.
    if (_containerOpen && _dom) {
      const _host = String(_dom).replace(/^https?:\/\//, '').split('/')[0];
      const _wrongRoute = _destKind
        && /\/(track|album|artist|episode|show|genre|user|video|watch)\//i.test(_dom)
        && !_dom.toLowerCase().includes(_destKind);
      const _wrongHost = ctx.memory.containerHost && _host && _host !== ctx.memory.containerHost;
      // Wrong-header — same KIND of page, different container ("80s Mix" is
      // a playlist too). A confident top header sharing no word with the
      // destination = wrong container → back out.
      const _destWords = _destLo2.split(/\s+/).filter(w => w.length >= 3);
      const _hdr = els.filter(e => e.center && e._regionRole === 'content'
          && e.center[1] < 400 && String(e.label || '').trim().length > 3
          && !/^(#|title|album|artist|date added|name|no\.?|track|type|genre|home|search|library|all|music|podcasts|audiobooks)$/i.test(String(e.label || '').trim()))
        .sort((a, b) => a.center[1] - b.center[1])[0];
      const _hdrTxt = String(_hdr?.label || '').toLowerCase();
      // Settle window — a mid-render header read on latch+0/latch+1 is the
      // PREVIOUS page's paint, not identity evidence.
      // Header-mismatch is fallback evidence ONLY — when the URL is visible
      // it already proves or disproves identity (kind-route above). A stale
      // OCR header must never eject a URL-verified container.
      const _prelimWrong = !_dom && iters - (ctx.memory.containerOpenedAt || 0) >= 3
        && _hdrTxt && !_hdrTxt.includes(_destLo2)
        && !_destWords.some(w => _hdrTxt.includes(w));
      // Header evidence must be STABLE — a mid-render read that disagrees
      // once is the previous page's paint, not a wrong container.
      const _wrongHeader = _prelimWrong && ctx.memory.lastWrongHdr === _hdrTxt;
      ctx.memory.lastWrongHdr = _prelimWrong ? _hdrTxt : null;
      if (_wrongRoute || _wrongHost || _wrongHeader) {
        const _boN = (ctx.memory.identityBacks || 0) + 1;
        ctx.memory.identityBacks = _boN;
        emit(`identity: scene left "${ctx.destination}" (${_host || _dom.slice(0, 40)}) — back out ${_boN}`);
        if (_boN > 2 || _wrongHost)
          return fail(`identity: container "${ctx.destination}" scene lost at ${_host || _dom}`, iters);
        ctx.memory.containerOpenedAt = null;
        ctx.memory.transPending = null;
        ctx.memory.preTransFp = null;
        if (_dom) await keyboardAgent({ key: 'left', mods: ['alt'], sessionId }).catch(() => null);
        await sleep(700);
        continue;
      }
    }

    // ── SceneFSM state inputs ────────────────────────────────────────────
    const _winW = _pxW(parsed);
    const _winH = _pxH(parsed);
    // Collapsed rail — icon-dense left strip with almost no labels. Its top
    // icons are EXPLORE candidates ("expand the library" is a free,
    // reversible reveal a human does before concluding "not here").
    const _railEls = els.filter(e => e._regionRole === 'rail' && e.center && e.center[1] < _winH * 0.7);
    // Collapsed rail — a real-word label is what expansion produces; OCR
    // junk glyphs ("-> C", "Q)") must not count as labels.
    const _railLabeled = _railEls.filter(e => /[a-z]{3,}/i.test(String(e.label || '')));
    const _railCollapsed = _railEls.length >= 3
      && _railLabeled.length < Math.max(3, Math.ceil(_railEls.length * 0.5));
    ctx.memory.triedExpanders = ctx.memory.triedExpanders || new Set();
    // A labeled rail cover for a DIFFERENT entity is a transition, not an
    // expander — "Evening Grace Playlist" clicked while hunting "Liked
    // Songs" navigates away. Only unlabeled icons and affordance labels
    // (Your Library, ≡, +) are true expander candidates.
    const _namedOther = e => {
      const l = String(e.label || '').trim().toLowerCase();
      return _destLo2 && l.length > 4 && /[a-z]{4,}/i.test(l)
        && !l.includes(_destLo2)
        && !/library|expand|create|new playlist|your|home|search|browse|≡|\+/.test(l);
    };
    const _expanders = (_railCollapsed
      ? _railEls.filter(e => e.center && !ctx.memory.triedExpanders.has(_fpLoose(e)) && !_namedOther(e))
          .sort((a, b) => a.center[1] - b.center[1])
      : els.filter(e => e.center && e._regionRole !== 'content' && e._regionRole !== 'dialog'
          && /your library|expand|show more|more playlists|browse all|≡/.test(String(e.label || '').toLowerCase())
          && !ctx.memory.triedExpanders.has(_fpLoose(e))))
      // Rail "open" but no container rows visible → the library panel itself
      // still needs opening: its "Your Library"-ish header and top icons are
      // EXPLORE candidates (clicking them is free and reversible). Home/
      // Search nav is excluded — those leave the scene, not expand it.
      .concat(els.filter(e => e.center
          && (e._regionRole === 'library' || e._regionRole === 'rail')
          && !/home|search|back|forward/i.test(String(e.label || ''))
          && !_namedOther(e)
          && !ctx.memory.triedExpanders.has(_fpLoose(e))
          && (_destLo2 && !String(e.label || '').toLowerCase().includes(_destLo2))
          && (/library|playlist|≡/.test(String(e.label || '').toLowerCase())
            || (!String(e.label || '').trim() && e.center[1] < _winH * 0.35))))
      .slice(0, 5);
    const _libEls = els.filter(e => (e._regionRole === 'library' || e._regionRole === 'rail') && e.center);
    const _libX = _libEls.length
      ? Math.round(_libEls.reduce((s, e) => s + e.center[0], 0) / _libEls.length) : 160;
    // Region-diff — a scene change repaints only some regions; rail, library,
    // panel and the media bar typically persist. Regions whose label
    // fingerprint changed are FRESH (probe/act priority); identical ones are
    // inert chrome — their elements must not compete for commits.
    const _roleBag = {};
    for (const e of els) {
      if (!e._regionRole || !e.center) continue;
      const l = String(e.label || '').toLowerCase().trim();
      if (l) (_roleBag[e._regionRole] ||= []).push(l);
    }
    const _prevFp = ctx.memory.regionFp || {};
    ctx.memory.regionFp = {};
    ctx.memory.freshRegions = new Set();
    for (const [role, labels] of Object.entries(_roleBag)) {
      const fp = labels.sort().join('|');
      ctx.memory.regionFp[role] = fp;
      if (_prevFp[role] !== fp) ctx.memory.freshRegions.add(role);
    }
    const _contentStable = _prevFp.content != null && _prevFp.content === ctx.memory.regionFp.content;
    // Scene identity — a TRANSITION commit should produce a scene whose
    // header carries the destination. A content header sharing nothing with
    // destination or goal vocab means the click landed wrong → MISMATCH.
    const _pageHeader = els.find(e => e._regionRole === 'content' && e.center
      && e.center[1] < 400 && String(e.label || '').trim().length > 3);
    const _headerTxt = String(_pageHeader?.label || '').toLowerCase();
    const _goalWords = (String(g || '').toLowerCase().match(/[a-z']{4,}/g) || [])
      .filter(w => !/remove|delete|clear|songs?|playlist|from|with|that|this|them|into|onto/.test(w));
    // URL outranks the OCR header — a tab already on the kind route IS the
    // container mid-render; a stale "Home" header must not back it out.
    const _urlConfirmed = _destKind && _dom && _dom.toLowerCase().includes(`/${_destKind}/`);
    const _identityMismatch = _destLo2 && ctx.memory.lastTransitionAt != null
      && iters - ctx.memory.lastTransitionAt >= 2 && iters - ctx.memory.lastTransitionAt <= 4
      && !_containerOpen && _pageHeader && !_urlConfirmed
      && _headerTxt && !_headerTxt.includes(_destLo2)
      && !/^(home|search|back|forward|library|explore|feed)$/i.test(_headerTxt)
      && !_goalWords.some(w => _headerTxt.includes(w))
      && !ctx.memory.identityBlind;
    if (_identityMismatch) {
      const backs = (ctx.memory.mismatchBacks || 0) + 1;
      ctx.memory.mismatchBacks = backs;
      emit(`scene: identity mismatch — "${String(_pageHeader.label).slice(0, 40)}" ≠ "${ctx.destination}" — back-out ${backs}/2`);
      if (backs <= 2) {
        ctx.memory.lastTransitionAt = null;
        await keyboardAgent({ key: '[', mods: ['cmd'], sessionId }).catch(() => null);
        await sleep(900); continue;
      }
      ctx.memory.identityBlind = true; // stop fighting — navigate onward
    }
    // Dialog signature by coarse rect bucket — OCR title jitter re-arms a
    // fresh escape epoch every iteration; position is far more stable for
    // the same persistent panel. A GLOBAL cap also stops a stream of novel
    // dialogs from consuming the whole run.
    const _dlgSig = _dlgNow ? _dlgNow.rect.map((v, i) => Math.round(v / (i < 2 ? 60 : 120))).join(',') : null;
    // ≥2 consecutive sightings before the trap may fire — a one-frame
    // OCR/parse glitch is not a modal, and single-sighting escapes are
    // exactly how persistent surfaces got keyed in the first place.
    const _seenBefore = _dlgSig != null && ctx.memory._lastDlgSig === _dlgSig;
    ctx.memory._lastDlgSig = _dlgSig;
    const _escTotal = ctx.memory.dlgEscTotal || 0;
    const _sysTrap = _isSystemDialogOpen(ctx._ocrEls || els) && !ctx.memory.sysGiveUp && !_goalExpectsPicker(g);
    const _expectedMenu = (ctx.memory.expectMenuAt != null && iters - ctx.memory.expectMenuAt <= 6)
      || (ctx.memory.menuOpenedAt != null && iters - ctx.memory.menuOpenedAt <= 6
        && els.some(e => e._inOpenMenu || e._ocrMenu))
      // A destination pick is owed — the picker surface IS the expectation,
      // however long it takes to open (menu expectation windows expire while
      // a flyout/picker persists).
      || ctx.memory.destPickPending != null;
    // Inside a bulk-remove container every "dialog" surface is expected —
    // context menus, persistent now-playing panels, confirmation sheets.
    // Escaping them spams keys against the playlist page itself. True
    // system dialogs still go through _sysTrap.
    const _inBulkContainer = ctx.memory.bulk === 'remove' && _containerOpen;
    const _foreignTrap = _escTotal < 10 && _dlgNow && _dlgSig && _seenBefore && !_expectedMenu && !_inBulkContainer &&
      !(ctx.memory.dlgGiveUpSigs || (ctx.memory.dlgGiveUpSigs = new Set())).has(_dlgSig) &&
      _isForeignDialog(els, g, ctx);
    if (_sysTrap || _foreignTrap) {
      ctx.memory.dlgEscTotal = _escTotal + 1;
      const kind = _sysTrap ? 'sys' : 'foreign';
      const counts = ctx.memory.dlgEsc || (ctx.memory.dlgEsc = new Map());
      const sig = _sysTrap ? 'sys' : _dlgSig;
      const n = (counts.get(sig) || 0) + 1;
      counts.set(sig, n);
      const _dlgTitle = (_dlgNow?.elements || [])
        .filter(e => e.center && e.center[1] < _dlgNow.rect[1] + 70)
        .map(e => String(e.label || '').trim()).filter(Boolean).slice(0, 3).join(' | ');
      acts.push(`(${kind} dialog trap — escaping ${n}: "${_dlgTitle.slice(0, 60)}")`);
      emit(`sysdialog: escaping unexpected ${kind} dialog (${n}) — "${_dlgTitle.slice(0, 80)}"`);
      // Trail bookkeeping — the cursor re-anchors at the domain when the
      // trap crossed a URL/file boundary, else pops the offending edge.
      const _bo = ctx.scene ? _sg.backOut(ctx.scene) : null;
      if (_bo) acts.push(`(trail: backOut ${ _bo.kind}${_bo.to ? ` → ${_bo.to}` : _bo.note ? ` — ${_bo.note}` : ''})`);
      if (_bo && _bo.kind === 'anchor' && _domain === 'url') {
        // A click edge jumped domains — but a nav keypress is never a
        // dismissal. Escape closes the surface; domain-jump recovery is the
        // identity layer's job (and in native apps the alt+left chord walks
        // app history — observed: Spotify sent back to a previous artist).
        await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
        await sleep(600);
        continue;
      }
      if (n === 1) {
        await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
      } else if (n === 2) {
        const cancel = els.find(e => e.center && /^\s*(cancel|close|ok|dismiss)\s*$/i.test(String(e.label || '').trim()));
        if (cancel) await mouseAgent({ action: 'click', x: cancel.center[0], y: cancel.center[1], sessionId }).catch(() => null);
        else await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
      } else if (n === 3) {
        await keyboardAgent({ key: '.', mods: ['cmd'], sessionId }).catch(() => null);
        if (ctx.memory.lastCommittedLoose) excludeIds.add(ctx.memory.lastCommittedLoose);
      } else {
        if (_sysTrap) ctx.memory.sysGiveUp = true;
        else {
          ctx.memory.dlgGiveUpSigs.add(_dlgSig);
          // Remember the FOREIGN rect — a dialog that survived escapes is
          // still foreign. Its fields must never receive task text; giving
          // up on escaping it can't make its contents legal targets.
          (ctx.memory.dlgForeignRects || (ctx.memory.dlgForeignRects = [])).push(_dlgNow.rect);
        }
        acts.push(`(${kind} escape gave up — treating as page furniture)`);
      }
      await sleep(500);
      continue;
    }

    // Context restore / destination gate — the destination name in a SIDEBAR
    // nav row is a target, not active context. Only a main-area occurrence
    // (wide header element, or center-x inside the content column) means the
    // container is actually open. If the goal names a container and only a
    // nav entry carries it, click the nav entry BEFORE anything else —
    // typing into another container's add-panel writes to the wrong one.
    const _destStr0 = (() => {
      // ctx.destination is the canonical extraction — the raw regex here
      // greedily captures venue words ("my spotify playlist" → "spotify")
      // and "restore" then clicks the brand logo back to the homepage.
      if (ctx.destination) return String(ctx.destination);
      const m = String(g || '').match(/\b(?:to|into|in)\s+(?:my|your|our|the|a|an|that|this)\s+([A-Za-z0-9][A-Za-z0-9 .&'’-]{1,60}?)(?=\s+(?:playlist|folder|list|album|collection|board|notebook|note|document|doc|file|group|channel|section|page)s?\b)/i);
      const cand = m ? m[1].trim() : null;
      return cand && !/^(spotify|youtube|gmail|google|slack|chrome|safari|amazon|ebay)$/i.test(cand) ? cand : null;
    })();
    if (_destStr0 && !ctx._searchSeeded) {
      const destHits = els.filter(e => e.center && e._role !== 'field' &&
        String(e.label || '').toLowerCase().includes(_destStr0.toLowerCase()));
      const mainHit = destHits.find(e => (e.bbox ? e.bbox[2] : 0) > 200 || e.center[0] > 300);
      if (!mainHit) {
        const anchor = destHits[0] || els.find(e => e.center && e._role !== 'field' &&
          String(e.label || '').toLowerCase().includes(_destStr0.toLowerCase().split(/\s+/)[0]));
        const tries = ctx.memory.restoreTries || 0;
        if (anchor && tries < 3) {
          ctx.memory.restoreTries = tries + 1;
          acts.push(`(context lost — restoring "${_destStr0}" ${tries + 1})`);
          emit(`restore: back to "${_destStr0}"`);
          await mouseAgent({ action: 'click', x: anchor.center[0], y: anchor.center[1], sessionId }).catch(() => null);
          await sleep(700);
          continue;
        }
      } else ctx.memory.restoreTries = 0;
    }

    // Observed goal-state beats model opinion — the derived check appearing
    // on screen IS completion, regardless of what the model thinks remains.
    // EXCEPT: the text sitting inside an open edit dialog is a pending value,
    // not a committed state — 'Quiet Hour' in an unsaved Name field must not
    // end the loop; the model still has to commit it (Save/Enter).
    const _checkHit = checkStr ? matchElements(els, checkStr)[0] : null;
    // Containment gate — 'add X to Y' goal state requires the payload INSIDE
    // the destination's column, not merely on screen. A search-result row,
    // artist card, sidebar echo, or typed field text all carry the entity
    // without it being added. Committed = the hit sits below the
    // destination's main-area header, in the same column band. Falls back to
    // plain presence when the goal names no container.
    const _destStr = (() => {
      const m = String(g || '').match(/\b(?:to|into|in)\s+(?:my|your|our|the|a|an|that|this)\s+([A-Za-z0-9][A-Za-z0-9 .&'’-]{1,60}?)(?=\s+(?:playlist|folder|list|album|collection|board|notebook|note|document|doc|file|group|channel|section|page)s?\b)/i);
      return m ? m[1].trim() : null;
    })();
    const _hitContained = (set, hitEl) => {
      if (!_destStr || !hitEl || !hitEl.center) return true;
      const hdrs = matchElements(set, _destStr)
        .filter(e => e.center && e._role !== 'field' && !_looksLikeInput(e))
        .sort((a, b) => (b.w || 1) * (b.h || 1) - (a.w || 1) * (a.h || 1));
      const hdr = hdrs[0];
      if (!hdr) return false;
      const below = hitEl.center[1] > hdr.center[1] &&
        Math.abs(hitEl.center[0] - hdr.center[0]) <= Math.max(340, hdr.w || 0);
      if (!below) return false;
      // Suggestion/result rows sit BELOW a search field — they are not
      // destination membership. A "contained" hit inside a field's under-region
      // is search output, not a saved row.
      const underField = set.some(e => (e._role === 'field' || _looksLikeInput(e)) && e.center &&
        hitEl.center[1] > e.center[1] + 10 &&
        Math.abs(hitEl.center[0] - e.center[0]) <= Math.max(320, (e.bbox ? e.bbox[2] : 0)));
      if (underField) return false;
      // Hits inside an open dialog (add-to-playlist suggestions, search
      // panels) are interaction context — not destination membership.
      const _d = detectDialog(set);
      if (_d && hitEl.center[0] >= _d.rect[0] && hitEl.center[0] <= _d.rect[0] + _d.rect[2]
          && hitEl.center[1] >= _d.rect[1] && hitEl.center[1] <= _d.rect[1] + _d.rect[3]) return false;
      // A composite hit that itself carries search UI vocabulary ("find
      // something… Q Search … i Add") is the suggestion panel merged into
      // one label — not a saved row.
      const hl = String(hitEl.label || '').toLowerCase();
      if (/find something|songs or episodes|search for/.test(hl)) return false;
      // Scene-tree scoping — a hit living inside a pick/search container is
      // interaction output by construction. The suggestion list under "Add
      // to playlist" can never BE destination membership; only rows inside
      // the destination's own subtree count.
      const _cp = String(hitEl._containerPath || hitEl._container || '').toLowerCase();
      if (_cp && /add to|find something|search|suggest|find a|browse|filter/i.test(_cp)) return false;
      return true;
    };
    // Drain pendingVerify: an entity confirmed inside the destination
    // container stops driving typing/scoring. Presence alone (a search-result
    // row, sidebar echo) doesn't drain it — same container check as the goal.
    if (ctx.memory.pendingVerify.length) {
      const _seeded = String(ctx._searchSeeded || '').toLowerCase();
      const _destLo = String(ctx.destination || '').toLowerCase();
      ctx.memory.pendingVerify = ctx.memory.pendingVerify.filter(t => {
        // The DESTINATION term was the picker's filter text — its only
        // screen presence is the field's own value, which _isTypedField
        // vetoes forever. Once the pick commits it has no further job.
        if (_destLo && String(t).toLowerCase().includes(_destLo)
            && ctx.memory.pickCommittedAt != null) return false;
        // A URL-seeded entity never drains on containment — it is owed a
        // row + action, not a presence check. The Quiet Hour sidebar panel
        // legitimately contains "Lecrae" rows; ambient membership is not
        // task completion.
        if (_seeded && String(t).toLowerCase() === _seeded) {
          // …unless its destination pick committed: the picker's close (or a
          // 3-iter stale pick = membership toggled, dialog persisted) IS the
          // completion signal — ambient containment was never the point.
          const picked = ctx.memory.pickCommittedAt != null
            && (!_dlgNow || (iters - ctx.memory.pickCommittedAt) > 3);
          if (!picked) return true;
        }
        const hit = matchElements(els, t).find(e => e.center);
        return !(hit && _hitContained(els, hit) && !_fieldContentHit(els, hit) && !_isTypedField(ctx.memory, hit));
      });
    }
    // Confirmation toasts are ground truth — "Added to X" names where the
    // commit ACTUALLY landed. Record sightings for the semantic verify.
    const _toastEl = els.find(e => e.center
      && /\b(?:added|saved|moved|removed|copied)\s+to\b/i.test(String(e.label || '')));
    if (_toastEl) ctx.memory.lastToast = { label: String(_toastEl.label), at: iters };
    if (ctx.memory.lastToast && iters - ctx.memory.lastToast.at > 12) ctx.memory.lastToast = null;
    // Pick-committed completion — the destination pick landed and the
    // picker closed (or persisted stale = membership toggled, dialog kept
    // open). Neither done-path can catch this: the model always answers
    // "nothing relevant" and checkStr is a phrase no element matches. The
    // pick + close IS the verification — gated on the toast's object: a
    // confirmation naming a DIFFERENT destination means the pick committed
    // wrong, and "picker closed" is not a pass.
    const _toastObj = String(ctx.memory.lastToast?.label || '').toLowerCase()
      .match(/\b(?:added|saved|moved|removed|copied)\s+to\s+(.{1,50})/i)?.[1]?.trim();
    const _destLoToast = String(ctx.destination || '').toLowerCase();
    if (ctx.memory.pickCommittedAt != null && _toastObj && _destLoToast
        && !_toastObj.includes(_destLoToast) && !_destLoToast.includes(_toastObj)) {
      emit(`verify: toast "added to ${_toastObj.slice(0, 30)}" ≠ "${ctx.destination}" — wrong pick, re-owing`);
      acts.push(`(toast object "${_toastObj.slice(0, 24)}" ≠ destination — pick was wrong)`);
      ctx.memory.pickCommittedAt = null;
      ctx.memory.destPickPending = iters;
      ctx.memory.lastToast = null;
      // The entity's verify was dropped on the wrong pick — re-owe it so
      // its row re-arms (menu → picker → pick again).
      if (ctx._searchSeeded && !ctx.memory.pendingVerify.includes(ctx._searchSeeded))
        ctx.memory.pendingVerify.push(ctx._searchSeeded);
      await sleep(400); continue;
    }
    if (ctx.memory.pickCommittedAt != null
        && !pending.length && !ctx.memory.pendingVerify.length
        && (!_dlgNow || (iters - ctx.memory.pickCommittedAt) > 3)) {
      trace.push({ step: outerIdx, iter: iters, action: 'verify', verified: true, pickPath: 'auto-pick+close', ok: true });
      emit(trace[trace.length - 1]);
      return pass(`auto: destination pick committed + picker closed (${iters} iters)`, iters, true);
    }
    // Drop pending entities already satisfied — destination labels ("Quiet
    // Hour" header) and previously-added rows pass containment; typing them
    // again wastes a field. One-time, on the first parse. A SEARCH entity
    // is never dropped: ambient page text containing "Lecrae" (home rows,
    // artist links) is not a located result — visibility ≠ acquisition.
    const _payloadGoal = /\b(type|write|paste|dict(ate)?)\b.{0,40}\b(into|in|to)\b|\bfill\b/i.test(g);
    if (!ctx.memory.pendingFiltered && pending.length) {
      ctx.memory.pendingFiltered = true;
      const destWord = String(ctx.destination || '').toLowerCase().split(/\s+/)[0];
      for (let i = pending.length - 1; i >= 0; i--) {
        const isDest = destWord && String(pending[i]).toLowerCase().includes(destWord);
        if (!_payloadGoal && !isDest) continue;
        const hit = matchElements(els, pending[i]).find(e => e.center);
        if (hit && _hitContained(els, hit) && !_fieldContentHit(els, hit) && !_isTypedField(ctx.memory, hit)) pending.splice(i, 1);
      }
    }
    // Phase gate — ACQUIRE: pending entities must be LOCATED via a search
    // affordance before any interaction commits. Inverted trigger (no verb
    // whitelist): acquire unless the goal is literal text-entry ("type X
    // into notes" — entity is a payload, not a search target). Exits:
    // entity typed into a search field (ctx.memory.acquired), pending
    // drained, or ~4 fruitless acquire iters (self-correcting).
    if (ctx.memory.acquired == null) {
      if (pending.length && !_payloadGoal) {
        if (ctx.memory.acquireSince == null) ctx.memory.acquireSince = iters;
        ctx.phase = (iters - ctx.memory.acquireSince) < 4 ? 'acquire' : 'act';
      } else ctx.phase = 'act';
      if (ctx.phase !== ctx.memory.phase) {
        emit(ctx.phase === 'acquire' ? `phase: acquire — searching for "${pending[0]}"` : 'phase: act');
        ctx.memory.phase = ctx.phase;
      }
    } else ctx.phase = 'act';
    // URL-first acquire — for domains with a query-addressable search URL,
    // navigating IS the search field. Zero mouse moves, zero field-hunting:
    // `open.spotify.com/search/<q>` lands directly on results. Seeded
    // templates cover the common catalog sites; unknown domains fall
    // through to the in-page acquire gate.
    if (ctx.phase === 'acquire' && !ctx.memory.acquireUrlTried && pending.length) {
      ctx.memory.acquireUrlTried = true;
      const host = String(ctx.scene?.domain || '').replace(/^https?:\/\//, '').split('/')[0];
      const tpl = SEARCH_URL_TEMPLATES[host] || SEARCH_URL_TEMPLATES[host.replace(/^www\./, '')];
      if (tpl) {
        const url = tpl.replace('{q}', encodeURIComponent(pending[0]));
        emit(`acquire: ${host} search URL → "${pending[0]}"`);
        // In-tab navigate via AppleScript `open location` (no extension);
        // `open` as fallback lands in the default browser's new tab.
        const browser = ctx.browserName || 'Google Chrome';
        let navOk = await new Promise(r => execFile('osascript',
          ['-e', `tell application "${browser}" to open location "${url}"`],
          (e) => r(!e)));
        if (!navOk) navOk = await new Promise(r =>
          execFile('open', [url], (e) => r(!e)));
        if (navOk) {
          ctx.memory.acquired = iters; ctx.phase = 'act';
          emit('phase: act (search results loaded)');
          await sleep(2000); continue;
        }
      }
    }
    // Pending ≠ committed: the goal text inside an editable field, or inside
    // any detected dialog region, is an unsaved value — not goal state. OCR
    // regularly merges dialog buttons into neighbors ('Mak• private Save …'),
    // so exact-label button scans alone can't be trusted for this.
    const _hitInField = _checkHit && _fieldContentHit(els, _checkHit);
    const _dlg = detectDialog(parsed.elements || []);
    // Deep-parse: typed entities' result rows ("Lecrae Episode", its Add
    // button) OCR too faint for the full-frame pass — they never become
    // elements at all. Crop the region below the typed field (dialog when
    // open) at rect-quality and merge what it finds. Once per goal.
    if (ctx.memory.pendingVerify.length && !ctx.memory.deepParsed) {
      const _pvTerms = ctx.memory.pendingVerify.map(t => String(t).toLowerCase().split(/\s+/)[0]).filter(Boolean);
      const _fld = els.find(e => (e._role === 'field' || _looksLikeInput(e)) && e.center);
      const _covered = els.some(e => e._role !== 'field' && !_looksLikeInput(e)
        && !_fieldContentHit(els, e)
        && _pvTerms.some(t => String(e.label || '').toLowerCase().includes(t)));
      if (_fld && !_covered) {
        const x0 = Math.max(0, Math.round((_dlg ? _dlg.rect[0] : (_fld.bbox ? _fld.bbox[0] : _fld.center[0]) - 80)));
        const y0 = Math.round(_fld.center[1] + 14);
        const x1 = _dlg ? _dlg.rect[0] + _dlg.rect[2] : (_pxW(parsed));
        const y1 = _dlg ? _dlg.rect[1] + _dlg.rect[3] : (_pxH(parsed));
        if (x1 - x0 > 80 && y1 - y0 > 60) {
          const rp = await rectParse([x0, y0, Math.round(x1 - x0), Math.round(y1 - y0)], { display, windowOnly });
          const extra = (rp?.elements || []).filter(e => e.center);
          if (extra.length) {
            // Crop-local coords → translate into full-parse space when the
            // elements all sit inside the crop bounds.
            const local = extra.every(e => e.center[0] <= x1 - x0 + 8 && e.center[1] <= y1 - y0 + 8);
            if (local) extra.forEach(e => {
              e.center = [e.center[0] + x0, e.center[1] + y0];
              if (e.bbox) e.bbox = [e.bbox[0] + x0, e.bbox[1] + y0, e.bbox[2], e.bbox[3]];
            });
            extra.forEach(e => {
              inferRole(e, els, parsed);
              const k = _fpLoose(e);
              e._isNew = !ctx.memory.seen.has(k);
              ctx.memory.seen.add(k);
            });
            els.push(...extra);
            acts.push(`(deep-parse: +${extra.length} elements below field)`);
            emit(`deep-parse: ${extra.length} elements in results region`);
          }
        }
      }
      // Composite decomposition — detector composites spanning a whole section
      // (suggestion list, results panel) absorb/suppress the row OCR inside
      // them (buildElements drops >70%-contained OCR). Re-parse the composite's
      // bbox: children re-emerge as their own elements. Zero-yield → strip tiles.
      for (const big of els.slice()) {
        if (!big.bbox || !big.center) continue;
        const [bx, by, bw, bh] = big.bbox;
        const area = bw * bh;
        // Inside a dialog a 2-row composite ("Quiet Hour + New playlist",
        // ~520×80) is small by page standards but still fuses two distinct
        // targets — decompose at a much lower floor.
        const _inDlg = _dlg && big.center
          && big.center[0] >= _dlg.rect[0] && big.center[0] <= _dlg.rect[0] + _dlg.rect[2]
          && big.center[1] >= _dlg.rect[1] && big.center[1] <= _dlg.rect[1] + _dlg.rect[3];
        if (area < (_inDlg ? 20000 : 60000) && bh < (_inDlg ? 44 : 140)) continue;
        if (String(big.label || '').length >= area / 4000) continue;
        let kids = [];
        const rp2 = await rectParse(big.bbox.map(Math.round), { display, windowOnly }).catch(() => null);
        kids = (rp2?.elements || []).filter(e => e.center && e.bbox &&
          e.center[0] > bx && e.center[0] < bx + bw && e.center[1] > by && e.center[1] < by + bh &&
          _fpLoose(e) !== _fpLoose(big));
        if (!kids.length) {
          // Strip-tile fallback — row-height bands, accurate OCR per strip.
          for (let sy = by; sy < by + bh; sy += 60) {
            const strip = [Math.round(bx), Math.round(sy), Math.round(bw), Math.min(60, Math.round(by + bh - sy))];
            if (strip[3] < 20) break;
            const sr = await rectParse(strip, { display, windowOnly }).catch(() => null);
            for (const e of (sr?.elements || [])) {
              if (!e.center || !e.bbox) continue;
              if (!(e.center[0] > bx && e.center[0] < bx + bw && e.center[1] > by && e.center[1] < by + bh)) continue;
              kids.push(e);
            }
          }
        }
        const seen = new Set(els.map(e => _fpLoose(e)));
        const fresh = kids.filter(e => !seen.has(_fpLoose(e)));
        if (fresh.length) {
          fresh.forEach(e => {
            inferRole(e, els, parsed);
            const k = _fpLoose(e);
            e._isNew = !ctx.memory.seen.has(k);
            ctx.memory.seen.add(k);
            e._insideComposite = true;
            seen.add(k);
          });
          els.push(...fresh);
          acts.push(`(decompose: +${fresh.length} children in composite)`);
          emit(`decompose: ${fresh.length} children in oversized element`);
        }
      }
      ctx.memory.deepParsed = true;
    }
    const _hitInDialog = _checkHit && _dlg && _checkHit.center &&
      _checkHit.center[0] >= _dlg.rect[0] && _checkHit.center[0] <= _dlg.rect[0] + _dlg.rect[2] &&
      _checkHit.center[1] >= _dlg.rect[1] && _checkHit.center[1] <= _dlg.rect[1] + _dlg.rect[3];
    const _modalOpen = _checkHit && (_hitInField || _hitInDialog ||
      els.some(e => /^\s*(save|cancel|discard|ok|done|close)\s*$/i.test(String(e.label || ''))));
    if (_checkHit && !_modalOpen && _hitContained(els, _checkHit)) {
      // Partial completion: the check term landed but un-typed or
      // un-verified entities remain (e.g. "KB" added, "Lecrae" still
      // pending) — record progress and keep walking.
      if (pending.length || ctx.memory.pendingVerify.length) {
        acts.push(`("${checkStr}" contained — ${pending.length + ctx.memory.pendingVerify.length} entities remain)`);
      } else {
        trace.push({ step: outerIdx, iter: iters, action: 'verify', verified: true, pickPath: 'auto-check', ok: true });
        learned.push({ action: 'verify', check: checkStr, waitMatchMs: 8000, why: 'auto-final' });
        emit(trace[trace.length - 1]);
        return pass(`auto: goal state "${checkStr}" observed after ${iters} iters`, iters, true);
      }
    }
    if (_checkHit && !_modalOpen && !_hitContained(els, _checkHit)) {
      acts.push(`("${checkStr}" on screen but outside "${_destStr}" — not committed yet)`);
    }
    if (_checkHit && _modalOpen) acts.push(`(goal text "${checkStr}" visible inside open dialog — commit it first)`);

    // Name the unlabeled — icon-only controls (a '+' create button, toolbar
    // glyphs) are invisible to a text-based shortlist, so the model circles
    // labeled landmarks forever. Give each unlabeled interactive element a
    // describable name from its nearest labeled neighbor ("icon near 'Your
    // Library'") — the model can then reason about it.
    for (const e of els) {
      if (String(e.label || '').trim() || !e.center) continue;
      let best = null, bd = 1e9;
      // Same-band labels first — an icon at a row's right edge belongs to
      // THAT row ("Quiet Hour"), not the dialog title 60px above it. Fall
      // back to nearest-by-distance when no band-mate exists.
      for (const o of els) {
        if (o === e || !String(o.label || '').trim() || !o.center) continue;
        const dy = Math.abs(e.center[1] - o.center[1]);
        const d = Math.hypot(e.center[0] - o.center[0], dy) + (dy < 20 ? 0 : 400);
        if (d < bd) { bd = d; best = o; }
      }
      if (best && bd < 350) {
        e.label = `icon near "${String(best.label).slice(0, 30)}"`;
        // Edge position relative to the owning row — "right-edge of 'Quiet
        // Hour'" is the commit-affordance signature a bare icon can't carry.
        if (best.bbox && e.center[0] > best.bbox[0] + best.bbox[2] * 0.6)
          e._rowCtx = `[right-edge of "${String(best.label).slice(0, 30)}"]`;
      }
    }

    // ── decide + probe-walk: Infer → Hover → Exhaust → Commit ─────────────
    // The model SORTS the walk queue; it never gates it. Candidates are
    // probed in order — each infer-veto or dead probe costs ~1s and shrinks
    // the queue, vs ~10s+recovery for a blind wrong commit. The first
    // candidate whose evidence converges gets committed; the walk only ends
    // when every element is probed-and-rejected (true exhaustion) or a
    // commit lands. Suppress recently-picked labels — clicking the same
    // landmarks with no progress is how the loop circles.
    const _recentPicks = acts.slice(-6).map(a => a.replace(/^click "|"$/g, '').slice(0, 24)).filter(Boolean);
    const _recentFiltered = e => !excludeIds.has(_fpLoose(e))
      && !_recentPicks.some(p => p && String(e.label || '').includes(p.slice(0, 16)));
    const cands = shortlist(els.filter(_recentFiltered), g, parsed);
    // Entity boost: a non-field element carrying a pending or awaiting-
    // verification term is the actual add-target ("KB Mike" row, "Lecrae ▸"
    // artist) — outrank landmarks. Artist/nav rows are legitimate progress.
    const _entityTerms = [...pending, ...ctx.memory.pendingVerify]
      .flatMap(t => String(t).toLowerCase().split(/\s+/)).filter(w => w.length > 1);
    // Menu surface by set-diff — a post-arm menu is, structurally, a
    // vertical stack of elements that did not exist pre-arm. No label
    // vocabulary: works for context menus, dropdowns, pickers in any app.
    const _armWindow = ctx.memory.bulkClickedAt != null && iters - ctx.memory.bulkClickedAt <= 6;
    if (ctx.memory.preArmLabels && _armWindow) {
      const _fresh = els.filter(e => e.center && String(e.label || '').trim().length > 1
        && _freshAfterArm(ctx.memory.preArmLabels, e.label, e.center));
      // Cluster fresh elements into x-bands; a band whose members form a
      // ≥3-tall stack with menu row spacing is a menu surface. Gap bound is
      // generous — OCR routinely drops menu rows (real stacks arrived with
      // 78–98px holes).
      const _bands = new Map();
      for (const e of _fresh) {
        const k = Math.round(e.center[0] / 64);
        (_bands.get(k) || _bands.set(k, []).get(k)).push(e);
      }
      for (const band of _bands.values()) {
        if (band.length < 3) continue;
        band.sort((a, b) => a.center[1] - b.center[1]);
        let chain = 1;
        for (let i = 1; i < band.length; i++) {
          const d = band[i].center[1] - band[i - 1].center[1];
          if (d > 10 && d < 90) chain++;
        }
        if (chain >= 3) {
          for (const e of band) e._ocrMenu = true;
          // Pin the surface — preArmLabels expires with the armed-label
          // cycle but the menu may live several iters. Elements inside its
          // rect keep flagging while it is observed open.
          const x0 = Math.min(...band.map(e => e.bbox ? e.bbox[0] : e.center[0] - 40));
          const y0 = Math.min(...band.map(e => e.bbox ? e.bbox[1] : e.center[1] - 12));
          const x1 = Math.max(...band.map(e => e.bbox ? e.bbox[0] + e.bbox[2] : e.center[0] + 40));
          const y1 = Math.max(...band.map(e => e.bbox ? e.bbox[1] + e.bbox[3] : e.center[1] + 12));
          ctx.memory.menuRect = [x0 - 12, y0 - 12, x1 - x0 + 24, y1 - y0 + 24];
          ctx.memory.menuRectLabels = new Set(band.map(e => String(e.label || '').trim()).filter(Boolean));
          break;
        }
      }
    }
    if (ctx.memory.menuRect && ctx.memory.menuOpenedAt != null && iters - ctx.memory.menuOpenedAt <= 6) {
      const [rx, ry, rw, rh] = ctx.memory.menuRect;
      const inside = els.filter(e => e.center
        && e.center[0] >= rx && e.center[0] <= rx + rw
        && e.center[1] >= ry && e.center[1] <= ry + rh);
      // Liveness is identity-based: a live menu still shows ITS OWN labels
      // inside the rect. Content rows drifting under the old rect (post-
      // removal scroll) are NOT menu items — expire, don't flag them.
      const _ownLabels = ctx.memory.menuRectLabels;
      const _live = _ownLabels
        ? inside.filter(e => _ownLabels.has(String(e.label || '').trim()))
        : inside;
      if (_live.length >= 2) for (const e of _live) e._ocrMenu = true;
      else { ctx.memory.menuRect = null; ctx.memory.menuOpenedAt = null; ctx.memory.menuRectLabels = null; }
    } else if (ctx.memory.menuRect && ctx.memory.menuOpenedAt != null && iters - ctx.memory.menuOpenedAt > 6) {
      ctx.memory.menuRect = null;
      ctx.memory.menuOpenedAt = null;
      ctx.memory.menuRectLabels = null;
    }
    // Route death — a ⋯/context-menu commit that produced no menu
    // container marks that route dead; entity rows re-commit via
    // right-click (a different menu surface) next iteration.
    if (ctx.memory.expectMenuAt != null) {
      const menuNow = els.some(e => e._inOpenMenu || e._ocrMenu
        || /menuitem|option/.test(String(e._role || ''))
        || /menu|dialog|listbox|popover/.test(String(e._containerRole || '')));
      if (menuNow) {
        // Menu observed inside the expectation window — hand off to stage 4.
        ctx.memory.expectMenuAt = null;
        ctx.memory.menuOpenedAt = iters;
      } else if (iters - ctx.memory.expectMenuAt > 6) {
        // The window _expectedMenu grants (6 iters) must fully expire before
        // the route is called dead — menus/flyouts routinely take 2-3
        // iterations to render AND classify; clearing after one iter left
        // the freshly-opened menu unprotected and it escaped as "foreign".
        ctx.memory.expectMenuAt = null;
        ctx.memory.moreMenuDead = true;
        if (!ctx.memory.moreMenuDeadLogged) {
          ctx.memory.moreMenuDeadLogged = true;
          emit('route: ⋯ menu did not open — trying context-menu route');
        }
      }
    }
    const _awaiting = ctx.memory.pendingVerify.length > 0;
    for (const e of cands) {
      const _el = String(e.label || '').toLowerCase();
      // ACQUIRE phase — only search affordances are candidates. You cannot
      // add what you have not found: entity rows, nav links, and playback
      // controls are suppressed entirely until the entity is typed.
      if (ctx.phase === 'acquire') {
        const _searchField = (e._role === 'field' || _looksLikeInput(e))
          && /search:entity|global/.test(String(e._scope || ''));
        const _searchBtn = /button|tab|link/.test(String(e._role || e.type || ''))
          && /\bsearch\b|\bfind\b/i.test(_el);
        if (_searchField) e._score = (e._score || 0) + 80;
        else if (!_searchBtn) e._score = -1e6;
      }
      const _bearsEntity = _entityTerms.some(t => _el.includes(t));
      const _bearsAfford = /(?:^|\s|\+)(add|\+add|remove)\s*$/i.test(String(e.label || '').trim())
        || /\+\s*add|\badd\b/.test(_el) && e._isRow;
      // An entity typed and awaiting its row: affordance-bearing composites
      // ("The Deep End With Lecrae i Add") are the ONLY close-out commits —
      // they outrank everything including goal-word navigation.
      // Destination-named ACTION suffix — "Quiet Hour – Edit details" and
      // "Name & details" are actions ON the container, not the container or
      // the +Add control. A label that carries the destination AND an action
      // verb is a trap, not a target.
      if (ctx.destination && _el.includes(String(ctx.destination).toLowerCase())
          && /edit|detail|share|delete|rename|remove|private|invite|collaborat|settings/i.test(_el))
        e._score = -1e6; // "<dest> – Edit details" is an action ON it, never the goal
      else if (/name\s*&\s*details|edit\s+details/i.test(_el) && !_el.includes('add'))
        e._score = -1e6;
      // Playback transport is never progress toward a non-play goal —
      // "Play/Pause/Shuffle Quiet Hour" buttons carry the destination name
      // but only control audio. (Play-* labels survive when the goal IS
      // playback.)
      if (!/play|listen|watch|pause|shuffle/i.test(g)
          && /^(play|pause|enable( smart)? shuffle|disable( smart)? shuffle|shuffle|skip|next track|previous|repeat|explore)\b/i.test(_el))
        e._score = -1e6;
      // Wrong-object elements are dead on their own label — "Add to Liked
      // Songs", "Follow", "Upgrade" never reach the probe queue.
      if (_evidenceFit(e.label, g, ctx, e._role || e.tag) === 'wrong-object')
        e._score = -1e6;
      // Membership commit — an item inside an OPEN menu/dialog that matches
      // the destination is a structural commit ("Quiet Hour" menuitem under
      // menu "Add to playlist"), not a label-score guess. Once the
      // destination has been typed into its picker field the menuitem is
      // THE outstanding commit — it outranks every entity row/affordance.
      const _destPending = ctx.memory.destPickPending != null
        && (iters - ctx.memory.destPickPending) < 8;
      const _menuish = e._inOpenMenu
        || /menuitem|option|radio/.test(String(e._role || ''))
        || /menu|dialog|listbox|popover/.test(String(e._containerRole || ''))
        // Containment > role — an element inside an open menu/dialog
        // container is menuish whatever its own role says (picker rows).
        || (e.ancestors || []).some(a => /menu|dialog|listbox|popover/.test(String(a.role || '')));
      if (ctx.destination && _menuish) {
        const dl = String(ctx.destination).toLowerCase();
        if (dl && (_el.includes(dl) || (dl.includes(_el) && _el.length > 3)))
          e._score = (e._score || 0) + (_destPending ? 150 : 80);
      }
      // Navigate-to-container — container not yet open: a destination match
      // (sidebar/library item) IS the commit that opens it, not a nav trap.
      // Bulk/remove goals have no entity anchor — this IS their first move.
      if (_destLo2 && !_containerOpen && !_menuish
          && (_el === _destLo2 || (_el.includes(_destLo2) && _el.length < _destLo2.length + 30)))
        e._score = (e._score || 0) + 140;
      // "+ New playlist" inside an open picker creates a real playlist —
      // hard veto while a destination exists (iter-16 side effect last run).
      if (/\bnew playlist\b|\+\s*new\b/i.test(_el) && ctx.destination && (_dlgNow || _menuish))
        e._score = -1e6;
      // Bulk-remove — nothing labeled add/create is legal: opening the
      // add-songs picker is the wrong direction entirely.
      if (ctx.memory.bulk === 'remove' && /\badd\b|new playlist|find a playlist|search for songs/i.test(_el))
        e._score = -1e6;
      // Search-region binding — after acquire, entity-bearing rows in the
      // search field's own region are the results; same-label rows in other
      // regions (playlist table, queue panel) are noise.
      if (_bearsEntity && ctx.memory.acquireRegion != null) {
        const sameRegion = e.region && e.region === ctx.memory.acquireRegion;
        const samePath = ctx.memory.acquirePath && e._containerPath
          && e._containerPath === ctx.memory.acquirePath;
        e._score = (e._score || 0) + (sameRegion || samePath ? 55 : -40);
      }
      // Route B — add-to-container via the row's ⋯/More menu. The "+" on a
      // result row is often a WRONG object ("Add to Liked Songs"); the
      // reliable path is ⋯ → "Add to playlist" → picker → destination.
      // The action-object probe veto kills wrong-object "+" dynamically —
      // ⋯ gets preferred scoring so the menu route wins over a lucky "+".
      if (ctx.destination && _awaiting
          && /more\b|options\b|…|⋯|ellipsis|\.\.\./i.test(_el)
          && !/more\s+(results|options? for|from|about)\b/i.test(_el)) {
        // Dead menu route → ⋯ is suppressed, entity rows get the
        // right-click re-commit boost instead.
        e._score = ctx.memory.moreMenuDead ? -500 : (e._score || 0) + 70;
      }
      if (ctx.memory.moreMenuDead && _awaiting && _bearsEntity)
        e._score = (e._score || 0) + 80;
      // "Add to playlist"-style buttons only count on an ENTITY row's band —
      // the now-playing bar's button adds whatever is currently playing
      // ("He Missed Me" ≠ the Lecrae song). Unscoped adds are floored.
      if (_awaiting && /add to (playlist|folder|list|collection|board|library)/i.test(_el) && !_menuish) {
        const _scoped = e._revealedBy
          || els.some(en => en !== e && en.center
            && _entityTerms.some(t => String(en.label || '').toLowerCase().includes(t))
            && Math.abs(en.center[1] - e.center[1]) < 40);
        if (!_scoped) e._score = -1e6;
      }
      // "Add to playlist"-style menuitems open the destination picker —
      // boosted while a menu is open and the picker field isn't active.
      if (ctx.destination && _menuish
          && /add to (playlist|folder|list|collection|board|library)/i.test(_el))
        e._score = (e._score || 0) + 90;
      if (!_destPending && _awaiting && _bearsEntity && /(\+\s*add|\badd\b)/.test(_el)) e._score = (e._score || 0) + 60;
      else if (!_destPending && _awaiting && _bearsAfford) e._score = (e._score || 0) + 40;
      // Bare navigation ("Quiet Hour", "Liked Songs", "Evening Grace") while
      // a typed entity still needs its row → leaving the context forfeits the
      // add. Penalize unless the element also carries entity/affordance.
      else if (_awaiting && !_bearsEntity) e._score = (e._score || 0) - 30;
      if (e._role !== 'field' && !_looksLikeInput(e) && _bearsEntity) {
        e._score = (e._score || 0) + 15;
        // The add-affordance is the sibling 'Add'/'+' button on the SAME row
        // band — clicking the row text navigates/plays; its button adds. DOM
        // sources give real labels ("Add to playlist", "Add I'll Find You") —
        // prefix match, not exact.
        for (const b of els) {
          if (b === e || !b.center || b._role === 'field' || excludeIds.has(_fpLoose(b))) continue;
          const bl = String(b.label || '').trim();
          if (!/^(add\b|\+|plus)/i.test(bl)) continue;
          if (Math.abs(b.center[1] - e.center[1]) < 40 && b.center[0] > e.center[0] + 40) {
            // A real same-band Add button outranks the row's right-edge
            // convention — dom:click on the actual button is deterministic.
            b._score = (b._score || 0) + (_awaiting ? 70 : 30);
            if (!cands.includes(b)) cands.push(b);
          }
        }
      }
      // Affordance hints — structural trailing controls and glyph priors
      // carry intent the label alone misses: an unlabeled "›" on an entity
      // row drills deeper; a dismiss ✕ forfeits the in-flight add.
      if (e._afford === 'add' && _awaiting && !_destPending) e._score = (e._score || 0) + 50;
      if (e._afford === 'goto' && /\b(open|view|see|browse|artist|detail|songs?|more from|drill)\b/i.test(g || '')) e._score = (e._score || 0) + 40;
      if (ctx.destination && _awaiting && e._afford === 'menu')
        e._score = ctx.memory.moreMenuDead ? Math.min(e._score || 0, -500) : (e._score || 0) + 70;
      if (e._afford === 'dismiss' && _awaiting) e._score = (e._score || 0) - 40;
    }
    // Map-tree priors — tutorial-derived vocabulary ranks the live queue.
    // controls: labels the task path uses (+10). avoid: off-task traps the
    // tutorial never touches (Install App, Choose photo) — hard-excluded.
    const _map = ctx.uiMap;
    if (_map) {
      const ctrl = (_map.controls || []).map(s => String(s).toLowerCase()).filter(w => w.length > 1);
      const avoid = (_map.avoid || []).map(s => String(s).toLowerCase()).filter(w => w.length > 2);
      for (const e of cands.slice()) {
        const l = String(e.label || '').toLowerCase();
        if (avoid.some(w => l.includes(w))) { excludeIds.add(_fpLoose(e)); cands.splice(cands.indexOf(e), 1); continue; }
        if (ctrl.some(w => l.includes(w) || w.includes(l) && l.length > 3)) e._score = (e._score || 0) + 10;
      }
    }
    // Exhaustive tail — the shortlist only ranks keyword-overlap elements;
    // the affordance we need may live in a zero-score row (a song row in
    // search results, an unlabeled icon). Append every remaining plausible
    // element so the walk *probes* them instead of circling labeled
    // landmarks forever. Tail items get probed even when labeled — earning
    // no score means their label alone isn't commit evidence.
    const _inCands = new Set(cands.map(c => c.id));
    const _avoidWords = _map ? (_map.avoid || []).map(s => String(s).toLowerCase()).filter(w => w.length > 2) : [];
    const tail = els.filter(e => e.center && _recentFiltered(e) && !_inCands.has(e.id)
      && (e._score ?? 0) > -9999
      && e._role !== 'windowchrome' && e._role !== 'omnibox' && e._role !== 'doctext' && e._role !== 'bookmark'
      && e.region !== 'menubar' && e.region !== 'dock'
      && !_avoidWords.some(w => String(e.label || '').toLowerCase().includes(w))
      // Tail bypasses the cands score-eval — run the label-level wrong-object
      // veto here or "Add to Liked Songs" (/\badd\b/ survives the awaiting
      // keep-check) commits on a bare word-fit.
      && _evidenceFit(e.label, g, ctx, e._role || e.tag) !== 'wrong-object');
    tail.forEach(e => { e._probeFirst = true; });
    // Awaiting-verify mode-lock: a typed entity only closes out via its row
    // or an add-affordance. Everything else — playback chrome ("Play Quiet
    // Hour", "Mute", "Enable Shuffle"), nav, stray icons — is how the walk
    // burns the budget wandering. Drop non-entity/non-affordance candidates
    // outright while pendingVerify is non-empty.
    if (_awaiting) {
      const _keep = e => {
        const l = String(e.label || '').toLowerCase();
        return _entityTerms.some(t => l.includes(t)) || /\badd\b/.test(l) || /^\s*\+\s*$/.test(l);
      };
      for (let i = cands.length - 1; i >= 0; i--) if (!_keep(cands[i])) cands.splice(i, 1);
      for (let i = tail.length - 1; i >= 0; i--) if (!_keep(tail[i])) tail.splice(i, 1);
    }
    if (!cands.length && !tail.length) {
      if (++exhaustRounds >= 3) {
        // True exhaustion: nothing left to probe and scope expansion already
        // tried (scroll, dialog-drop, window widening happen on each round).
        return fail('all candidates probed-and-rejected — nothing on screen satisfies the goal', iters);
      }
      if (exhaustRounds === 1) {
        // Expand: scroll the active region — inside the open dialog when one
        // exists, else the window center.
        const sx = _dlg ? _dlg.rect[0] + _dlg.rect[2] / 2 : (parsed.size_px ? _pxW(parsed) / 2 : 700);
        const sy = _dlg ? _dlg.rect[1] + _dlg.rect[3] / 2 : (parsed.size_px ? _pxH(parsed) / 2 : 400);
        await post('/screen/act', { action: 'scroll', x: sx, y: sy, dx: 0, dy: -400 }).catch(() => null);
        acts.push(`(exhausted queue — scrolling ${_dlg ? 'dialog' : 'window'})`);
      } else {
        await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
        acts.push('(exhausted queue — escape + re-observe)');
      }
      await sleep(700); continue;
    }

    // Model ordering (optional): a live answer just moves its pick to the
    // front of the queue — the rest of the walk still happens if it's wrong.
    const recent = acts.slice(-4).join('; ');
    // New-element priority: unseen elements are the consequence of the last
    // commit (an opened dialog's field, fresh results) — they probe first.
    // Fields INSIDE an open dialog outrank everything when an entity awaits
    // typing — a second page field (playlist search, omnibox) must not steal
    // the type.
    const _hasEntity = pending.length > 0 || ctx.memory.pendingVerify.length > 0;
    const _inRect = (e, r) => !!(r && e.center && e.center[0] >= r[0] && e.center[0] <= r[0] + r[2]
      && e.center[1] >= r[1] && e.center[1] <= r[1] + r[3]);
    const _dlgFields = _hasEntity && _dlg
      ? els.filter(e => e.center && _recentFiltered(e) && e._role === 'field' && _inRect(e, _dlg.rect)) : [];
    // Add-panel fields — a field sitting under an add-context header ("Add to
    // playlist", "find something", "suggested songs") is task-scoped input;
    // a bare "Search" elsewhere is global navigation. Header-adjacency, not
    // dialog detection — panels aren't modals and won't reliably cluster.
    const _addHdrs = els.filter(e => e.center && e._role !== 'field' &&
      /add to playlist|add songs|find something|suggested|add items|add to\b/i.test(String(e.label || '')));
    const _panelFields = _hasEntity
      ? els.filter(e => e.center && _recentFiltered(e) && (e._role === 'field' || _looksLikeInput(e))
          && !_dlgFields.includes(e)
          && _addHdrs.some(h => e.center[1] > h.center[1] && e.center[1] - h.center[1] < 260
              && Math.abs(e.center[0] - h.center[0]) < Math.max(320, (h.bbox ? h.bbox[2] : 0))))
      : [];
    _dlgFields.forEach(e => { e._probeFirst = false; });
    _panelFields.forEach(e => { e._probeFirst = false; });
    const _dlgFieldSet = new Set([..._dlgFields, ..._panelFields]);
    // Acquire phase: search-scope fields LEAD the queue — the structural
    // walk picks queue order when the model abstains, so the searchbox must
    // be first, not merely high-scored.
    const _searchFields = ctx.phase === 'acquire'
      ? cands.filter(e => (e._role === 'field' || _looksLikeInput(e))
          && /search:entity|global/.test(String(e._scope || '')) && !_dlgFieldSet.has(e))
      : [];
    const _searchSet = new Set(_searchFields);
    // Hard-floor exclusion — _score ≤ -9999 elements (foreign-phase clicks,
    // "<dest> – Edit details", playback transport during non-play goals) are
    // not candidates at all: scoring only gates probing, so a floor without
    // exclusion still commits after a wasted hover.
    let queue = [..._searchFields, ..._dlgFields, ..._panelFields,
      ...cands.filter(e => e._isNew && !_dlgFieldSet.has(e) && !_searchSet.has(e) && (e._score ?? 0) > -9999),
      ...cands.filter(e => !e._isNew && !_dlgFieldSet.has(e) && !_searchSet.has(e) && (e._score ?? 0) > -9999), ...tail];
    // Bulk remove — container open, no dialog: right-click a main-region row
    // to open the item's context menu; the "Remove from playlist" menuitem
    // then commits through the normal selfFit path next iteration.
    let _bulkTarget = null;
    if (ctx.memory.bulk === 'remove' && _containerOpen && !_dlgNow
        && (ctx.memory.bulkClicks || 0) < 25
        && iters - (ctx.memory.bulkClickedAt ?? -9) > 1) {
      // Occlusion guard — while the armed row's own menu (or its expectation
      // window) is live, a missing row label is the surface hiding it, not
      // removal evidence. The arm resolves only via a real remove commit or
      // once the menu is gone.
      const _menuLive = els.some(e => e._inOpenMenu || e._ocrMenu
        || /menuitem|option/.test(String(e._role || ''))
        || /menu|listbox|popover/.test(String(e._containerRole || '')))
        || (ctx.memory.expectMenuAt != null && iters - ctx.memory.expectMenuAt <= 4);
      // WORK-SET verification — the armed row's label must be GONE next
      // observe: that's the removal's proof, not the right-click. Rows are
      // identified by label fingerprint (positions shift after each remove).
      if (ctx.memory.armedLabel) {
        const k = _workKey(ctx.memory.armedLabel);
        const gone = !els.some(e => _workKey(e.label) === k);
        // Occlusion is a grace, not an amnesty — a menu surface that keeps
        // the row hidden without a commit for 4+ observes is a dead surface
        // (browser context menu on page furniture); the arm fails then.
        const _occluded = gone && !ctx.memory.removeCommitted && _menuLive
          && (ctx.memory.armOccluded || 0) < 4;
        if (gone && !ctx.memory.removeCommitted && _menuLive)
          ctx.memory.armOccluded = (ctx.memory.armOccluded || 0) + 1;
        else ctx.memory.armOccluded = 0;
        if (ctx.memory.removeCommitted) {
          // A remove-item actually committed — the row's disappearance is
          // real progress; its persistence means the removal failed.
          if (gone) {
            ctx.memory.removeChains = (ctx.memory.removeChains || 0) + 1;
            (ctx.memory.doneWork ||= new Set()).add(k);
            maxIters = Math.min(maxIters + 10, 90); // verified progress extends the budget
            emit(`bulk: verified removal "${k.slice(0, 30)}" (chains=${ctx.memory.removeChains})`);
            // removeSig — the verified trace becomes a soft playbook for the
            // NEXT row: same container identity, same commit offset relative
            // to the arm point. Replay is gated live and verified by
            // outcome, never load-bearing.
            ctx.memory.removeSig = {
              containerFp: (_domPath || _dom || '') || `hdr:${_workKey(ctx.destination)}`,
              rowSlotY: ctx.memory.lastArmPoint ? ctx.memory.lastArmPoint[1] : null,
              arm: ctx.memory.lastArmRoute || 'right-click',
              commitOffset: ctx.memory.lastCommitOffset || null,
            };
            ctx.memory.sigFails = 0;
            ctx.memory.sigCommitted = null;
          } else if (ctx.memory.sigCommitted) {
            // The replayed coordinate commit did not remove the row — the
            // sig's geometry is drifting; strike it and fall back to derive.
            ctx.memory.sigFails = (ctx.memory.sigFails || 0) + 1;
            ctx.memory.sigCommitted = null;
            emit(`replay: sig commit left row armed — sig failing (${ctx.memory.sigFails})`);
          }
          ctx.memory.removeCommitted = null;
        } else if (_occluded) {
          // Row hidden behind its own menu — stay armed; armTries must not
          // consume the arm on an occlusion illusion.
        } else {
          if (gone)
            emit('bulk: armed label vanished WITHOUT a remove commit — not counted (label flicker?)');
          if (!ctx.memory.doneWork?.has(k)) {
            // Failure identity is the label TAIL — head-mutating OCR
            // ("About tri…" → "tWbout…") must not reset the try counter.
            const tk = _workTail(ctx.memory.armedLabel) || k;
            const tries = (ctx.memory.armTries ||= {})[tk] = ((ctx.memory.armTries || {})[tk] || 0) + 1;
            if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
          }
        }
        if (!_occluded) {
          ctx.memory.lastArmedKey = k;
          ctx.memory.armedLabel = null;
          ctx.memory.preArmLabels = null;
          // Arm cycle closed — the menu is either consumed or dismissed; its
          // pinned rect is poison (track rows behind it read as menu items).
          ctx.memory.menuRect = null;
          ctx.memory.menuRectLabels = null;
          ctx.memory.menuOpenedAt = null;
          ctx.memory.bulkClickedAt = null;
          ctx.memory.sigArmed = null;
        }
      }
      // Suggestion-section boundary — a "Recommended / You might also like"
      // header ends the container's OWN list: everything below it is
      // suggestion content (carries Add affordances), never remove targets.
      const _suggY = Math.min(...els.filter(e => e.center
          && e._regionRole === 'content'
          && /recommended|suggested|you might|more like|based on|for you|discover|similar|popular|trending|new releases?/i.test(String(e.label || ''))
          && String(e.label || '').trim().length < 60)
        .map(e => e.center[1] - 12).concat([Infinity]));
      // Footer furniture — site nav links ("About For Artists Support") and
      // legal rows are page chrome below the work list.
      const _footWords = /about|jobs|for artists|for creators|support|premium|individual|free mobile|advertising|developers|investors|vendors|legal|privacy|cookies|accessibility|company|communities|useful links|spotify plans|plans|instagram|twitter|facebook/gi;
      _bulkTarget = els.filter(e => e.center
          && e.center[1] < _suggY
          // 'dialog'-stamped rows are admitted: a false-positive dialog rect
          // over the content column marks real track rows; live menu items
          // stay excluded via _menuishEl/_ocrMenu below.
          && (e._regionRole === 'content' || (e._regionRole === 'dialog' && !_menuishEl(e)))
          && e.center[1] > 380
          && e.center[0] < _winW * 0.7
          && e.center[1] < _winH - 120
          && !_looksLikeInput(e)
          // A tracklist IS a list — listbox-contained rows are the target,
          // only live open-menu items are not.
          && !e._inOpenMenu && !/menuitem|option|radio/.test(String(e._role || ''))
          && String(e.label || '').trim().length > 2
          // "icon near …" labels are member glyphs, not rows — right-click
          // targets the row itself ("group"/composite rows stay legal).
          && !/^icon near/i.test(String(e.label || '').trim())
          // Bare structural shells ("group", "section") are containers and
          // furniture, never work items — a valid candidate's label carries
          // item content, not just a role name.
          && !/^(group|row|list|listitem|region|section|container|generic|content|main|panel|scroll\s*area?|web\s*area|layout)$/i.test(String(e.label || '').trim())
          // Column-header bands ("# Title Album Date added") are sort
          // chrome, not rows — ≥2 header-vocab words marks them, and a
          // label made ONLY of header vocab is the same chrome fragmented.
          && (String(e.label || '').toLowerCase()
              .match(/\b(title|track|album|artist|date|added|duration|time|subject|sender|from|to|status|received|size|type|name)\b/g) || []).length < 2
          && !/^[#\s]*(title|track|album|artist|date|added|duration|time|subject|sender|from|to|status|received|size|type|name|datg)[\s#:]*$/i.test(String(e.label || '').trim())
          // Footer-nav furniture — a label made ONLY of site-footer words
          // ("About For Artists Support") is page chrome, not a work row.
          // Collapsed-space OCR ("ForArtists", "InstallApp") defeats the
          // spaced regex — strip the words from the alpha-only form too.
          && String(e.label || '').replace(_footWords, '')
              .replace(/[\s#|·•\-–—:,.]+/g, '').length > 0
          && String(e.label || '').toLowerCase().replace(/[^a-z]/g, '')
              .replace(/about|jobs|forartists|forcreators|support|premium|individual|freemobile|advertising|developers|investors|vendors|legal|privacy|cookies|accessibility|company|communities|usefullinks|spotifyplans|plans|instagram|twitter|facebook|install|download|app|upgrade|getourapp/g, '').length > 3
          // doneWork/badWork match by containment, not just equality — a
          // re-parsed row can carry a longer label ("… 6 minutes ago",
          // merged neighbors) and must still be recognized as the same item.
          && !(ctx.memory.doneWork && [...ctx.memory.doneWork].some(k => _sameWork(e.label, k)))
          && !(ctx.memory.badWork && [...ctx.memory.badWork].some(k => _sameWork(e.label, k)))
          // Transient toasts ("Removed from Liked Songs.", "Added to …",
          // "Undo") are notifications, not work rows or menu items.
          && !/removed from|added to|undo|copied|saved to/i.test(String(e.label || ''))
          // Empty-state CTAs ("Invite collaborators", "Let's find something
          // for your playlist") are page furniture on an empty container —
          // no row exists to remove, they're the absence of one.
          && !/invite collaborators|let's find|find something|find more|search for songs|add songs|add items|looks like|nothing here|no items|start adding|browse for|it's empty|empty playlist/i.test(String(e.label || ''))
          && !/play|pause|next|previous|shuffle|repeat|skip|volume|mute|lyrics|queue/i.test(String(e.label || ''))
          // Suggestion rows ("Recommended: title … Add") are NOT work items
          // for a remove-workflow — the trailing Add affordance is the
          // structural tell: real container rows carry no Add control.
          && !/\badd\b[\s:|·+-]*\S{0,3}$/i.test(String(e.label || '').trim())
          && !/^\s*\+?\s*add\b/i.test(String(e.label || '').trim())
          && !(e._members || []).some(m => /^\s*\+?\s*add\s*$/i.test(String(m.label || '').trim()))
          && !els.some(m => m !== e && m.center
            // Row-trailing affordance: "Add" and its OCR variants
            // ("Aco", "Ad", "+") — a suggestion row's tell, never on a real
            // container item. Punctuation glyphs (•••) and durations miss
            // the token shape by construction.
            && /^[+\s]*a?[dc+]?[do]?d?\+?$/i.test(String(m.label || '').trim())
            && /a|\+/.test(String(m.label || ''))
            && String(m.label || '').trim().length <= 6
            && Math.abs(m.center[1] - e.center[1]) < 35 && m.center[0] > e.center[0])
          // Positive membership — a work row is a composite (≥2 cells) or
          // list-semantic role. Bare button/link/icon roles with no cell
          // signal (duration, recency, date, price) and no members are promo
          // cards/furniture, never rows — "Forthe Record"/"App"/"ForAuthors"
          // type this way; a real track row carries "… ago 3:40" or cells.
          && (((e._isRow || (e._members || []).length >= 2) && (e._members || []).length >= 2)
            || /listitem|row|cell|treeitem|option/.test(String(e._role || e.type || ''))
            || (/(text|static|group|doctext)/.test(String(e._role || e.type || ''))
              && (/\d+\s*[:：]\s*\d{2}|\bago\b|yesterday|\$|€|£|\d{1,2}\/\d{1,2}|\d{4}-\d{2}/.test(String(e.label || ''))
                || (e._members || []).length >= 2 || String(e.label || '').trim().length > 30))))
        // Composite rows first — they carry members (the ••• trigger lives
        // in the last column); bare text fragments are fallback targets.
        .sort((a, b) => (b._isRow ? 1 : 0) - (a._isRow ? 1 : 0) || a.center[1] - b.center[1])[0] || null;
      // "No rows remain" passes only on a VERIFIED remove-chain — a bare
      // right-click proves nothing; or on the strict empty verdict below.
      if (!_bulkTarget && (ctx.memory.removeChains || 0) > 0)
        return pass(`bulk remove: no rows remain in "${ctx.destination}" (${ctx.memory.removeChains} removed)`, iters, true);
      // Empty container — a latched container page that shows no content
      // rows after a settle window IS the goal state for remove-all.
      if (!_bulkTarget) {
        if (ctx.memory.noRowSince == null) {
          ctx.memory.noRowSince = iters;
          // One reveal scroll inside the content region before concluding
          // "empty" — lazy rows may sit below the fold.
          await post('/screen/act', { action: 'scroll', x: Math.round(_winW * 0.55), y: Math.round(_winH * 0.55), dx: 0, dy: -400 }).catch(() => null);
          await sleep(500);
        } else if (iters - ctx.memory.noRowSince > 6) {
          // "Empty" needs evidence, not just absence: an empty-state
          // affordance ("Add songs", "looks like", "empty") confirms the
          // container truly has no rows — invisible rows ≠ no rows.
          const _emptyState = els.some(e => e.center && e._regionRole === 'content'
            && /add songs|add items|find something|looks like|empty|nothing here|no items|start adding|recommended|find more|based on|suggested|you might also/i.test(String(e.label || '')));
          // Strict verdict — "empty" only counts when the container is
          // IDENTITY-VERIFIED: a deep kind-route URL, or (no URL) an
          // unambiguous top header naming the destination. A latch on a
          // home-feed card must never conclude "already empty".
          const _verified = (_dom && _destKind && _dom.toLowerCase().includes(`/${_destKind}/`))
            || (_dom && !/^\/?.?$/.test(_domPath) && _destHeader)
            || (!_dom && _destHeader);
          if (_verified && (_emptyState || iters - ctx.memory.noRowSince > 12))
            return pass(`bulk remove: "${ctx.destination}" has no rows — already empty${_emptyState ? '' : ' (assumed)'}`, iters, true);
          if (!_verified && iters - ctx.memory.noRowSince > 12)
            return fail(`bulk remove: no rows visible but container "${ctx.destination}" not identity-verified`, iters);
        }
        ctx.memory.rowStreak = 0;
      } else {
        // Hysteresis — a one-iter row flicker (OCR noise on the "Add"
        // affordance) must not reset the empty clock; only a candidate
        // stable across consecutive observes counts as real work remaining.
        ctx.memory.rowStreak = (ctx.memory.rowStreak || 0) + 1;
        if (ctx.memory.rowStreak >= 2) ctx.memory.noRowSince = null;
      }
      if (!_bulkTarget && iters % 5 === 0) {
        const _inDone = e => ctx.memory.doneWork && [...ctx.memory.doneWork].some(k => k && (k === _workKey(e.label) || (_workKey(e.label).length >= 8 && (k.includes(_workKey(e.label)) || _workKey(e.label).includes(k)))));
        const _inBad = e => ctx.memory.badWork && [...ctx.memory.badWork].some(k => k && (k === _workKey(e.label) || (_workKey(e.label).length >= 8 && (k.includes(_workKey(e.label)) || _workKey(e.label).includes(k)))));
        const _why = e => !e.center ? 'nocenter'
          : e.center[1] >= _suggY ? 'suggestion-zone'
          : e._regionRole !== 'content' ? `role:${e._regionRole}`
          : e.center[1] <= 380 ? 'y<=380'
          : e.center[1] >= _winH - 120 ? `y>=${_winH - 120}`
          : _looksLikeInput(e) ? 'input'
          : _menuishEl(e) ? 'menuish'
          : String(e.label || '').trim().length <= 2 ? 'short'
          : /^icon near/i.test(String(e.label || '').trim()) ? 'icon-near'
          : /^(group|row|list|listitem|region|section|container|generic|content|main|panel|scroll\s*area?|web\s*area|layout)$/i.test(String(e.label || '').trim()) ? 'shell'
          : (String(e.label || '').toLowerCase().match(/\b(title|track|album|artist|date|added|duration|time|subject|sender|from|to|status|received|size|type|name)\b/g) || []).length >= 2 ? 'header-vocab'
          : !String(e.label || '').replace(_footWords, '').replace(/[\s#|·•\-–—:,.]+/g, '').length ? 'footer'
          : _inDone(e) ? 'doneWork'
          : _inBad(e) ? 'badWork'
          : /removed from|added to|undo|copied|saved to/i.test(String(e.label || '')) ? 'toast'
          : /play|pause|next|previous|shuffle|repeat|skip|volume|mute|lyrics|queue/i.test(String(e.label || '')) ? 'mediaword'
          : /\badd\b[\s:|·+-]*\S{0,3}$/i.test(String(e.label || '').trim()) || /^\s*\+?\s*add\b/i.test(String(e.label || '').trim()) ? 'add-token'
          : 'OK';
        emit(`bulk: no rows (els=${els.length}) — band rejects: [${els.filter(e => e.center && e.center[1] > 380 && e.center[1] < _winH - 120 && String(e.label || '').trim().length > 2).slice(0, 16).map(e => `${String(e.label || '').slice(0, 14)}→${_why(e)}`).join(' | ')}]`);
      }
      if (_bulkTarget) {
        const _bk = _workKey(_bulkTarget.label);
        // removeSig usability — same container identity, the new top row
        // sitting at (near) the recorded slot, sig not retired. Replay is a
        // soft hint: it arms the row and lets the commit happen by recorded
        // geometry, verified by outcome.
        const _fpNow = (_domPath || _dom || '') || `hdr:${_workKey(ctx.destination)}`;
        ctx.memory.sigUsable = !!(ctx.memory.removeSig && (ctx.memory.sigFails || 0) < 2
          && ctx.memory.removeSig.commitOffset
          && ctx.memory.removeSig.containerFp === _fpNow
          && ctx.memory.removeSig.rowSlotY != null
          && Math.abs(_bulkTarget.center[1] - ctx.memory.removeSig.rowSlotY) <= 30);
        // Route-B never fires while a menu surface is live — a slot click
        // would land on the menu, not the in-row affordance.
        if (ctx.memory.menuDead && [...ctx.memory.menuDead].some(k => _sameWork(_bulkTarget.label, k)) && !_menuLive) {
          // ROUTE B — the context menu carried no remove item: the remove
          // affordance is an in-row control revealed on hover (a ✓/unlike
          // toggle in the gap between the last two columns, or the row's
          // right edge). Hover-wait-click it; the surface it opens (a
          // membership picker like "Add to playlist") flows through the
          // normal stage-4 menu path, where the destination row is the
          // toggle. Bounded by affordTries → badWork.
          const _at = ((ctx.memory.affordTries ||= {})[_workTail(_bulkTarget.label) || _bk]
            = ((ctx.memory.affordTries || {})[_workTail(_bulkTarget.label) || _bk] || 0) + 1);
          if (_at > 2) {
            (ctx.memory.badWork ||= new Set()).add(_bk);
            emit(`bulk: affordance route exhausted for "${_bk.slice(0, 30)}" — skipping item`);
          } else {
            const _mems = (_bulkTarget._members || []).filter(m => m.center)
              .sort((a, b) => a.center[0] - b.center[0]);
            const _lastM = _mems[_mems.length - 1];
            const _prevM = _mems[_mems.length - 2];
            let _slot = null;
            if (_lastM && _prevM) {
              const rPrev = _prevM.bbox ? _prevM.bbox[0] + _prevM.bbox[2] : _prevM.center[0] + 25;
              const lLast = _lastM.bbox ? _lastM.bbox[0] : _lastM.center[0] - 25;
              _slot = [Math.round((rPrev + lLast) / 2), Math.round(_lastM.center[1])];
            } else if (_bulkTarget.bbox) {
              _slot = [Math.round(_bulkTarget.bbox[0] + _bulkTarget.bbox[2] - 105), Math.round(_bulkTarget.center[1])];
            }
            if (_slot) {
              emit(`bulk: menu carried no remove item — in-row affordance @(${_slot[0]},${_slot[1]})`);
              await mouseAgent({ action: 'move', x: _slot[0], y: _slot[1], sessionId }).catch(() => null);
              await sleep(700); // hover latency — the control renders under the cursor
              await mouseAgent({ action: 'click', x: _slot[0], y: _slot[1], sessionId }).catch(() => null);
              ctx.memory.armedLabel = String(_bulkTarget.label || '').trim();
              ctx.memory.lastArmedKey = _bk;
              ctx.memory.lastArmPoint = _slot;
              ctx.memory.lastArmRoute = 'affordance';
              ctx.memory.expectMenuAt = iters;
              ctx.memory.bulkClickedAt = iters;
              ctx.memory.preArmLabels = _preArmSnap(els);
              if (ctx.memory.sigUsable) {
                ctx.memory.sigArmed = true;
                ctx.memory.sigArmPoint = _slot;
                ctx.memory.sigArmIter = iters;
              }
              await sleep(600);
              continue;
            }
            (ctx.memory.badWork ||= new Set()).add(_bk);
          }
        }
        _bulkTarget._bulkRow = true;
        queue = [_bulkTarget, ...queue.filter(c => c !== _bulkTarget)];
      }
    }
    // Bulk delete — LIST-scope: the rows themselves are the work items (each
    // sidebar playlist row deleted via ITS context menu), not contents of an
    // opened container. exceptSet rows are vetoed outright — never armed,
    // never left-clicked (a click navigates INTO the thing we must keep).
    if (ctx.memory.bulk === 'delete') {
      if (iters % 3 === 0) emit(`bulk delete: iter ${iters} armed=${!!ctx.memory.armedLabel} dlg=${!!_dlgNow} menuLive=${!!ctx.memory._lastMenuLive} fresh=${ctx.memory._lastFreshNear ?? '-'} menuClicks=${ctx.memory.bulkClicks || 0} chains=${ctx.memory.removeChains || 0}`);
      if (!ctx.memory.delElsDumped) {
        ctx.memory.delElsDumped = true;
        emit(`bulk delete: els[${els.length}] = [${els.filter(e => String(e.label || '').trim().length > 2).slice(0, 40).map(e => `${String(e.label || '').slice(0, 18)}@${e._regionRole || e.region || '?'}${e.center ? '' : ':nocenter'}`).join(' | ')}]`);
        emit(`bulk delete: lib-ish = [${els.filter(e => /library|sidebar|rail|nav/i.test(String(e._regionRole || e.region || '')) || /playlist|artist|liked|need|hour|sweet|lecrae|all4/i.test(String(e.label || ''))).slice(0, 30).map(e => `${String(e.label || '').slice(0, 22)}@${e._regionRole || e.region || '?'}:${e._role || e.type || '?'}${e.center ? '' : ':nocenter'}`).join(' | ')}]`);
      }
      const _exSet = ctx.memory.exceptSet || new Set();
      // Exclusion is FUZZY — OCR mutates the protected row too ("Quiet Hour"
      // → "quiet kknr playlist"), and a mutated label dodging the veto means
      // arming the one row we must never touch.
      const _excluded = l => { const t = String(l || '').toLowerCase();
        return [..._exSet].some(x => t.includes(x) || _vocab.fuzzyMatch(t, x)); };
      // ── Scene-driven work surface ──────────────────────────────────────
      // Build the OCR-style clustered tree over the merged element set every
      // iter, whatever the backend — geometric container clustering is the
      // uniform structure (a real AX ancestor group can span the whole
      // window and dilute everything). The container densest in x-aligned
      // excluded rows IS the work list; its rect and children are the
      // admission surface.
      const _workTree = _sg.buildOcrTree(els, {
        app: parsed.front_app || ctx.app || 'app',
        domain: _domObs?.domain || ctx.scene?.domain || 'dom',
        dlg: _dlgNow ? { rect: _dlgNow.rect, title: '' } : null,
        size: [_winW, _winH] });
      // Surface is FROZEN while armed — an open context menu sits inside the
      // column and pollutes the clustering (menu items become fake rows,
      // the rect balloons). Re-resolve only between arms.
      const _workNode = ctx.memory.armedLabel ? null
        // Footer-band "excluded" labels can't anchor — the now-playing
        // track literally shares the playlist's name, and its bar is not
        // the list.
        : _sg.findContainerWith(_workTree.tree, e => e.center && _excluded(e.label)
          && e.center[1] < _winH - 110);
      if (_workNode) ctx.memory.workContainer = { label: _workNode.label, rect: _workNode.rect };
      const _workSet = _workNode ? new Set(_sg.childrenIn(_workNode)) : null;
      let _workRect = _workNode?.rect || ctx.memory.workContainer?.rect || null;
      // Tail-membership — elements BELOW the last excluded row can't ride the
      // loose rect (now-playing bar, sidebar footer buttons sit right under
      // the stack). Below that y they must be real container children.
      const _lastExYLive = els.reduce((m, e) => (e.center && _excluded(e.label)
        && e.center[1] < _winH - 110) ? Math.max(m, e.center[1]) : m, 0);
      if (_lastExYLive) ctx.memory._lastExY = _lastExYLive;
      const _lastExY = _lastExYLive || ctx.memory._lastExY || null;
      let _workRows = _workRect
        ? els.filter(e => e.center
            && (_lastExY == null || e.center[1] <= _lastExY + 140)
            && (_workSet?.has(e)
              || (e.center[0] >= _workRect[0] - 20 && e.center[0] <= _workRect[0] + _workRect[2] + 20
                && e.center[1] >= _workRect[1] - 20 && e.center[1] <= _workRect[1] + _workRect[3] + 170)))
            .sort((a, b) => a.center[1] - b.center[1])
        : null;
      // Contiguous-run trim — the work stack is pitch-locked. Header
      // furniture ("Your Library +", bookmarks bleed) can share the
      // container's column but is separated from the excluded rows by a
      // gap larger than the row pitch. Keep only the contiguous run
      // containing the excluded members: expand from the excluded span
      // while consecutive gaps stay ≤ 2.5× median pitch.
      let _cleanSurface = false;
      if (_workRows && _workRows.length > 2) {
        // Row-height gate — stack members share the excluded rows' height
        // class (h ≥ 0.55× median excluded h ≈ 30px for 55px rows). Dense
        // header debris (bookmark icons h≈9-24px) fills the column at small
        // pitch and defeats the gap trim alone.
        const _exHs = _workRows.filter(e => _excluded(e.label) && e.bbox).map(e => e.bbox[3]).sort((a, b) => a - b);
        const _rowH0 = _exHs.length ? _exHs[Math.floor(_exHs.length / 2)] : 0;
        if (_rowH0) { ctx.memory._rowH = _rowH0; _workRows.splice(0, _workRows.length, ..._workRows.filter(e => !e.bbox || e.bbox[3] >= _rowH0 * 0.55)); }
        const _exIdx = _workRows.map((e, i) => _excluded(e.label) ? i : -1).filter(i => i >= 0);
        _cleanSurface = _exIdx.length > 0;
        if (_exIdx.length) {
          const ys = _workRows.map(e => e.center[1]);
          const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter(g => g > 4).sort((a, b) => a - b);
          const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 60;
          // gapMax from the excluded rows' OWN height — the member-gap median
          // collapses under dense debris (bookmark labels every ~20px), and a
          // too-small bound trims real rows separated by a tall row's pitch
          // (Evening Grace's 96px gap below the last Quiet Hour).
          const gapMax = Math.max((_rowH0 || 0) * 3, pitch * 2.5, 120);
          let lo = _exIdx[0], hi = _exIdx[_exIdx.length - 1];
          while (lo > 0 && ys[lo] - ys[lo - 1] <= gapMax) lo--;
          // Below the last excluded row the list is still pitch-locked, but
          // footer controls ("Add to playlist") sit after a real gap. Rows
          // continue at ~1.6×rowH; a larger gap means the stack ended.
          while (hi < _workRows.length - 1
            && ys[hi + 1] - ys[hi] <= (ys[hi + 1] > (_lastExY ?? Infinity)
              ? Math.min(gapMax, (_rowH0 || 55) * 1.6) : gapMax)) hi++;
          _workRows.splice(0, lo);
          _workRows.splice(hi - lo + 1);
          const rx = _workRows.map(e => e.bbox ? e.bbox[0] : e.center[0] - 40);
          const ry = _workRows.map(e => e.bbox ? e.bbox[1] : e.center[1] - 10);
          const rr = _workRows.map(e => e.bbox ? e.bbox[0] + e.bbox[2] : e.center[0] + 40);
          const rb = _workRows.map(e => e.bbox ? e.bbox[1] + e.bbox[3] : e.center[1] + 10);
          _workRect = [Math.min(...rx), Math.min(...ry), Math.max(...rr) - Math.min(...rx), Math.max(...rb) - Math.min(...ry)];
        }
      }
      // Row span — the tight vertical bounds of actual member rows. A parse
      // polluted by an open menu/occlusion re-resolves loose (header debris
      // merged in) — only a CLEAN resolution (≥1 excluded member present)
      // may redefine the surface; dirty iters reuse the last clean span.
      let _rowSpan = _workRows?.length
        ? [_workRows[0].center[1] - 30, _workRows[_workRows.length - 1].center[1] + 30]
        : null;
      if (_cleanSurface && _rowSpan) {
        ctx.memory._workSpan = _rowSpan;
        // Row labels persist as the menu-cluster exclusion set — a popup's
        // items are never work-row labels, and _workRows is null exactly
        // when a menu is open (dirty parse).
        ctx.memory._workLabelSet = { _rows: _workRows.slice(), has(e) {
          return this._rows.some(r => _sameWork(r.label, e.label)); } };
        // Member count is the verification unit — a deleted row drops it
        // regardless of how OCR garbles labels. Persisted because _workRows
        // is null exactly when a surface is open (occluded parse).
        ctx.memory._lastRowCount = _workRows.length;
      }
      else if (ctx.memory._workSpan) { _rowSpan = ctx.memory._workSpan; if (_workRect) _workRect[1] = Math.min(_workRect[1], _rowSpan[0] - 20); }
      // A dirty parse's member list is untrusted for the pick — ghosts merge
      // in. Only a clean surface yields a live pick; else registry only.
      if (!_cleanSurface) _workRows = null;
      if (iters % 3 === 0) emit(`bulk delete: workContainer=${_workNode ? `${_workNode.label} rows=${_workRows.length}` : 'NONE'} rect=${JSON.stringify((_workRect || []).map(Math.round))} span=${_rowSpan ? _rowSpan.map(Math.round) : '-'} armed="${String(ctx.memory.armedLabel || '').slice(0, 30)}"`);
      // Consistent verify pool — live member rows when resolved, else flat
      // els scoped to the surface rect. Counts must compare like-for-like;
      // mixing pools (stale snapshot vs live) falsifies the ledger.
      const _surfaceCount = lbl => {
        const pool = (_workRows && _workRows.length) ? _workRows
          : els.filter(e => e.center
            && (!_workRect || (e.center[0] >= _workRect[0] - 30 && e.center[0] <= _workRect[0] + _workRect[2] + 30))
            && (!_rowSpan || (e.center[1] >= _rowSpan[0] - 50 && e.center[1] <= _rowSpan[1] + 50)));
        return pool.filter(e => _sameWork(e.label, lbl)).length;
      };
      // Work-surface column — the work list is a vertical stack of same-x
      // rows, and an EXCLUDED row is on the surface by definition (Quiet
      // Hour). Its center-x anchors the column; registry rows extend it.
      // Rows outside the column ("Explore Premium" x=1048, search debris)
      // are page content, not work items — observed whole-run waste.
      const _colXs = els.filter(e => e.center && _excluded(e.label)
        && e.center[1] < _winH - 110).map(e => e.center[0]);
      if (!_colXs.length && ctx.memory.delSeen?.size)
        _colXs.push(...[...ctx.memory.delSeen.values()].filter(v => iters - v.seen <= 20 && v.center).map(v => v.center[0]));
      _colXs.sort((a, b) => a - b);
      // Low quantile, not median — the work surface is the LEFTMOST dense
      // band (a sidebar). Registry debris at page-center x (cards, buttons)
      // drags a median rightward and admits yet more debris as "rows".
      const _colX = _colXs.length ? _colXs[Math.floor((_colXs.length - 1) * 0.2)] : null;
      // Scene-first admission — the excluded row lives INSIDE the work list
      // by definition; its ancestor container (scene-tree path / AX
      // ancestors) IS the surface. Rows outside that container (bookmarks
      // bar sharing the sidebar's x-band, page cards, omnibox) are never
      // work items no matter how row-shaped they look.
      const _exConts = new Set();
      for (const e of els.filter(e => e.center && _excluded(e.label)
        && e.center[1] < _winH - 110)) {
        for (const a of e.ancestors || [])
          if (a.label || /list|group|section|nav|sidebar|library|menu|scroll/i.test(String(a.role || '')))
            _exConts.add(`${a.role || ''}|${a.label || ''}`.toLowerCase());
        if (e._container) _exConts.add(`cont|${e._container}`.toLowerCase());
      }
      // Shared vertical band for the OCR backend (no ancestors): rows
      // stack at the excluded row's x±row-half-width between its top and
      // the surface bottom — same shape, but bounded by the container's
      // own rows rather than the whole left quarter of the window.
      const _exEls = els.filter(e => e.center && e.bbox && _excluded(e.label)
        && e.center[1] < _winH - 110);
      const _bandX = _exEls.length ? [Math.min(..._exEls.map(e => e.bbox[0])) - 20,
                                    Math.max(..._exEls.map(e => e.bbox[0] + e.bbox[2])) + 20] : null;
      // The list is a pitch-locked vertical stack — rows are uniform height
      // and contiguous. Header furniture ("Your Library +", collapsed
      // section headers) sits ABOVE the stack's top edge; bounding the band
      // to [top - 1.2 rows, bottom + 10 rows] admits list members (incl. the
      // one row directly above the excluded row) without header debris.
      const _rowH = _exEls.length
        ? _exEls.map(e => e.bbox[3]).sort((a, b) => a - b)[Math.floor(_exEls.length / 2)] : 0;
      const _bandY = _exEls.length && _rowH
        ? [Math.min(..._exEls.map(e => e.bbox[1])) - _rowH * 1.2,
           Math.max(..._exEls.map(e => e.bbox[1] + e.bbox[3])) + _rowH * 10]
        : null;
      const _inWorkContainer = e => {
        // Tree membership OR container-rect containment — merged backend
        // elements (AX/DOM unions) are different objects than tree children
        // but occupy the same surface, so geometry is the union test.
        if (_workSet?.has(e)) return true;
        if (_workRect && e.center) {
          const _pad = (_workRect[3] || 200) * 0.15;
          if (e.center[0] >= _workRect[0] - 30 && e.center[0] <= _workRect[0] + _workRect[2] + 30
            && e.center[1] >= _workRect[1] - _pad && e.center[1] <= _workRect[1] + _workRect[3] + _pad) return true;
          if (_workSet) return false;  // container resolved — outside is outside
        }
        if (_exConts.size) {
          const keys = (e.ancestors || []).map(a => `${a.role || ''}|${a.label || ''}`.toLowerCase());
          if (e._container) keys.push(`cont|${e._container}`.toLowerCase());
          if (keys.some(k => _exConts.has(k))) return true;
          // OCR elements carry no ancestry — fall through to the band.
          if (e.ancestors?.length || e._container) return false;
        }
        if (_bandX) {
          if (e.center[0] < _bandX[0] || e.center[0] > _bandX[1]) return false;
          if (_bandY && (e.center[1] < _bandY[0] || e.center[1] > _bandY[1])) return false;
          return true;
        }
        return true;
      };
      const _inWorkCol = e => e.center && (_colX != null ? Math.abs(e.center[0] - _colX) <= 150 : e.center[0] < _winW * 0.5)
        && _inWorkContainer(e);
      const _rowLabel = e => !/^(icon near|unnamed|unlabeled)/i.test(String(e.label || '').trim())
        && !/https?|www\.|\.com|\.eom|\.org|\.net|:\/\//i.test(String(e.label || '').trim());
      // Exclusion veto — excluded rows leave the queue entirely (menu items
      // exempt: a menu's own "Remove" item may contain arbitrary words).
      queue = queue.filter(e => _menuishEl(e) || !_excluded(e.label));
      // Set-diff "menu" items must live NEAR the click — a right-click that
      // re-renders the page produces 40+ "fresh" labels; only the ones by
      // the arm point are the actual native menu.
      const _nearArm = e => !ctx.memory.lastArmPoint || !e.center
        || Math.hypot(e.center[0] - ctx.memory.lastArmPoint[0], e.center[1] - ctx.memory.lastArmPoint[1]) <= 560;
      // Freshness is FUZZY — OCR mutates a row's label ("Liked Songs Pla*st")
      // between observes; an exact-set diff re-admits the ARMED ROW ITSELF as
      // a "menu item" and the lane right-clicks it forever.
      const _freshLabel = e => _freshAfterArm(ctx.memory.preArmLabels, e.label, e.center);
      // Debris — menu items and overlay elements are never work rows, even
      // when they sit inside the work column (a context menu opens right on
      // top of it). Registry admission and the live pick share this bar or
      // "Report…"/"Add to queue" get armed as rows. A label that IS the
      // delete action ("Remove from Your Library") is a menu blob by
      // definition — real rows are never named after the verb.
      const _debris = e => _menuishEl(e) || e._inOpenMenu || e._ocrMenu
        // Menu-item labels persist in els after the menu closes and get
        // armed as rows ("Add to playlist" as a work row). Anything seen in
        // a menu is debris for a window, not just while flagged.
        || (ctx.memory.menuVocab && iters - (ctx.memory.menuVocabAt ?? -99) <= 15
            // Vocab hit on the label OR any sub-box — a merged menu blob
            // ("d3 Create playlist Create fold", h≈60) dodges the label
            // match but its rows[]/words[] ARE menu items.
            && ([...ctx.memory.menuVocab].some(mv => _sameWork(String(e.label || ''), mv)
                  || (e.rows || []).some(r => _sameWork(String(r.text || ''), mv))
                  || (e.words || []).some(w => _sameWork(String(w.text || ''), mv))))
              // Shape exemption: a tall member row can't be a menu item —
              // UNLESS its sub-boxes are menu vocab (merged blob).
            && !(_workRows && _workRows.includes(e) && e.bbox
              && e.bbox[3] >= Math.max((_rowH || 55) * 0.55, 30)
              && !(e.rows || []).some(r => [...ctx.memory.menuVocab].some(mv => _sameWork(String(r.text || ''), mv)))
              && !(e.words || []).some(w => [...ctx.memory.menuVocab].some(mv => _sameWork(String(w.text || ''), mv)))))
        || /menuitem|option|bookmark|omnibox|windowchrome|^tab$|dock|menubar/.test(String(e._role || ''))
        // Browser chrome bands — bookmarks strip and tab row share the
        // left-column x-range with the sidebar but are never work rows.
        || (e.center && e.center[1] < 120)
        || (e._region && /^(rail|nav|header)$/.test(String(e._region)))
        || (ctx.memory.menuRect && e.center
          && e.center[0] >= ctx.memory.menuRect[0] && e.center[0] <= ctx.memory.menuRect[0] + ctx.memory.menuRect[2]
          && e.center[1] >= ctx.memory.menuRect[1] && e.center[1] <= ctx.memory.menuRect[1] + ctx.memory.menuRect[3])
        || (ctx.memory.preArmLabels && iters - (ctx.memory.bulkClickedAt ?? -99) <= 10 && _freshLabel(e))
        || _vocab.classifyAction(String(e.label || ''), 'delete');
      // Focused menu probe — whole-window OCR misses the transient popup;
      // a tight crop at the click point catches it. Once per arm (keyed to
      // the click), items merge in flagged _ocrMenu so the pool finds them.
      if (ctx.memory.armedLabel && ctx.memory.lastArmPoint
          && ctx.memory.bulkClickedAt != null
          && iters - ctx.memory.bulkClickedAt >= 1 && iters - ctx.memory.bulkClickedAt <= 6
          && ctx.memory._menuProbeAt !== ctx.memory.bulkClickedAt) {
        ctx.memory._menuProbeAt = ctx.memory.bulkClickedAt;
        const scanEls = await _menuProbe(ctx.memory.lastArmPoint, { display, windowOnly });
        let _added = 0;
        for (const e of scanEls) {
          if (_freshLabel(e) || _vocab.classifyAction(e.label, 'delete')) {
            e._ocrMenu = true; els.push(e); _added++;
            (ctx.memory.menuVocab ||= new Set()).add(_workKey(e.label));
          }
        }
        if (_added) ctx.memory.menuVocabAt = iters;
        if (_added) emit(`bulk delete: menu probe +${_added} items @(${Math.round(ctx.memory.lastArmPoint[0])},${Math.round(ctx.memory.lastArmPoint[1])})`);
      }
      // Fresh near-arm elements — the menu candidate set. A single
      // delete-shaped item here is menu evidence on its own: menus re-use
      // the verb, page rows are never named after it.
      const _freshNear = els.filter(e => e.center && _nearArm(e)
        && String(e.label || '').trim().length > 1 && _freshLabel(e));
      const _menuLiveDel = els.some(e => e._inOpenMenu || e._ocrMenu
          || /menuitem|option/.test(String(e._role || ''))
          || /menu|listbox|popover/.test(String(e._containerRole || '')))
          || _freshNear.some(e => _vocab.classifyAction(e.label, 'delete'))
          || (ctx.memory.armedLabel && ctx.memory.preArmLabels
            && iters - (ctx.memory.bulkClickedAt ?? -99) <= 10
            && _freshNear.length >= 2);
      ctx.memory._lastMenuLive = _menuLiveDel;
      ctx.memory._lastFreshNear = _freshNear.length;
      // Active overlay surface — the scene container whose children ARE the
      // open menu/popup. Scene-first probing: childrenIn gives the items in
      // screen order; flat els never define the menu. findContainerWith
      // scores by x-aligned pred-hits, so the menu stack (all children
      // menuish) wins over row containers with a stray flagged element.
      const _overlayMenuish = e => e && (e._inOpenMenu || e._ocrMenu
        || /menuitem|option/.test(String(e._role || e.type || ''))
        || /menu|listbox|popover/.test(String(e._containerRole || ''))
        // menuRect membership only counts when the element is ALSO fresh —
        // a stale rect kept footer controls ("Play"/"Previous") menuish.
        || (ctx.memory.menuRect && e.center && _freshLabel(e)
          && e.center[0] >= ctx.memory.menuRect[0] && e.center[0] <= ctx.memory.menuRect[0] + ctx.memory.menuRect[2]
          && e.center[1] >= ctx.memory.menuRect[1] && e.center[1] <= ctx.memory.menuRect[1] + ctx.memory.menuRect[3]));
      const _overlayNode0 = _menuLiveDel && _workTree
        ? _sg.findContainerWith(_workTree.tree, _overlayMenuish) : null;
      // Overlays are SIBLING surfaces, never the work list itself — menu
      // items landing inside the row column can merge into the same
      // container; that node's children stay rows, not menu items.
      const _overlayNode = _overlayNode0 && _overlayNode0 !== _workNode ? _overlayNode0 : null;
      // The menu surface is the contiguous MENUISH run inside the node —
      // menu items share the rows' column, so the container merges them;
      // children-in-order + the contiguous-run split recovers the 9-item
      // menu from a ×28 mixed stack.
      let _overlayItems = null;
      if (_overlayNode) {
        const _kids = _sg.childrenIn(_overlayNode);
        // Contiguous menuish run, tolerating ONE non-menuish child — a merged
        // multi-row blob loses its menu flag but still sits inside the menu.
        let _best = [], _cur = [], _gap = 0;
        for (const e of _kids) {
          if (_overlayMenuish(e)) { _cur.push(e); _gap = 0; }
          else if (_cur.length && _gap < 1) { _cur.push(e); _gap++; }
          else { if (_cur.filter(_overlayMenuish).length > _best.length) _best = _cur; _cur = []; _gap = 0; }
        }
        if (_cur.filter(_overlayMenuish).length > _best.length) _best = _cur;
        _overlayItems = _best.length ? _best : null;
      }
      ctx.memory.activeSurface = _overlayNode
        ? { label: _overlayNode.label, n: _overlayItems.length } : null;
      if (_overlayNode && ctx.memory._lastOverlay !== `${_overlayNode.label}×${_overlayItems.length}`) {
        ctx.memory._lastOverlay = `${_overlayNode.label}×${_overlayItems.length}`;
        emit(`bulk delete: activeSurface=${ctx.memory._lastOverlay} [${_overlayItems.map(e => String(e.label || '').slice(0, 16)).join(' | ')}]`);
      }
      // Menu-label vocabulary — every element observed as part of an open
      // menu joins the debris vocab so post-close persistence can't re-arm
      // it as a work row. Overlay children first (they're authoritative);
      // flat flagged els fill gaps when the overlay node didn't cluster.
      if (_menuLiveDel) {
        for (const e of (_overlayItems && _overlayItems.length ? _overlayItems : els)) {
          if (_overlayMenuish(e) || e._inOpenMenu || e._ocrMenu || /menuitem|option/.test(String(e._role || ''))) {
            const ml = String(e.label || '').trim();
            if (ml.length > 2) (ctx.memory.menuVocab ||= new Set()).add(_workKey(ml));
          }
        }
        ctx.memory.menuVocabAt = iters;
      }
      // Tier-1: central action vocab (normalized + fuzzy, action-vocab.cjs).
      // 'unfollow' stays OUT of 'delete' — a pin's only remove option is
      // Unfollow, which the user defines as SKIP (pin ≠ playlist row).
      const _delMenuItem = e => (e._inOpenMenu || e._ocrMenu || /menuitem|option/.test(String(e._role || '')))
        && _vocab.classifyAction(e.label, 'delete');

      // detectDialog misses some overlays — dialog-REGION elements are
      // evidence enough that a confirm surface is live.
      const _dlgEls = els.filter(e => e.center && (e._regionRole === 'dialog' || e._container === 'dialog'));
      // Structural dialog detection — OCR dialog elements often arrive as
      // icon/text roles with no 'dialog' region. A cancel-word element
      // within ~420px of a confirm-word element IS a confirmation dialog.
      const _cancelEl = e => e.center && _vocab.classifyAction(e.label, 'cancel')
        && String(e.label || '').trim().split(/\s+/).length <= 3;
      const _confEl = e => e.center && _vocab.classifyAction(e.label, 'confirm')
        && !/[.!?…]/.test(String(e.label || '').trim())
        && String(e.label || '').trim().split(/\s+/).length <= 5;
      const _structDlg = _dlgNow || _dlgEls.length >= 2 ? null
        : els.find(e => _confEl(e) && els.some(o => o !== e && _cancelEl(o)
            && Math.abs(o.center[0] - e.center[0]) < 420 && Math.abs(o.center[1] - e.center[1]) < 120));
      // A FRESH confirm-word in the central band shortly after a commit —
      // dialog buttons parse as bare icon/text with no region/Cancel pair.
      const _lateConf = (iters - (ctx.memory.bulkClickedAt ?? -99) <= 20
          || iters - (ctx.memory._lastCommitIter ?? -99) <= 20)
        && els.find(e => _confEl(e)
          && e.center[0] > 380 && e.center[0] < 1300 && e.center[1] > 280 && e.center[1] < 850
          && (!ctx.memory.preArmLabels || _freshLabel(e)));
      const _dlgLive = _dlgNow || _dlgEls.length >= 2 || _structDlg || _lateConf;
      // ── SCENE DRIVER (bulk delete) ─────────────────────────────────────
      // One active surface per scene: a transient bounded rect (dialog |
      // menu | native popup | fresh-diff cluster), else the goal container.
      // The decision layer only sees that surface's children. Moves:
      // match → commit | back-out (Escape) | ask_user. Verification = the
      // next scene's diff. Set ctx.memory.driverOff to fall back to the
      // heuristic lane below.
      if (!ctx.memory.driverOff) {
        const _surf0 = _sg.surfaceRect({ els, dlg: _dlgNow,
          menuRect: ctx.memory.menuRect, layers: ctx.scene?.layers,
          winW: _winW, winH: _winH,
          prevFp: ctx.memory._prevFp || null, fp: _fpLoose,
          armPt: (ctx.memory.armedLabel && !ctx.memory.removeCommitted)
            ? ctx.memory.lastArmPoint : null,
          exclude: ctx.memory._workLabelSet || null });
        ctx.memory._prevFp = new Set(els.map(_fpLoose));
        // Furniture filter — a "surface" that survived 8 dismissals is page
        // furniture (stuck panel, misdetected region), not transient UI.
        let _surf = _surf0 && !(ctx.memory._surfFurniture || []).some(r =>
          // Match furniture by ORIGIN — a persistent panel's x,y is stable
          // while its w,h jitters ±200px across re-parses (track list
          // scrolling under it); w/h matching let the same panel re-enter.
          Math.abs(r[0] - _surf0.rect[0]) < 140 && Math.abs(r[1] - _surf0.rect[1]) < 140)
          ? _surf0 : null;
        const _inSurf = e => _surf && e.center && e.bbox
          && e.center[0] >= _surf.rect[0] - 6 && e.center[0] <= _surf.rect[0] + _surf.rect[2] + 6
          && e.center[1] >= _surf.rect[1] - 6 && e.center[1] <= _surf.rect[1] + _surf.rect[3] + 6;
        // A menu bound that starts BELOW its own click point has lost its
        // top — the first items ("Add to queue…Delete") sit between the arm
        // and the bound, usually fused inside the armed row's merged blob.
        // Membership + scans use the expanded rect, arm→bound top.
        const _menuTop = _surf && ctx.memory.armedLabel && ctx.memory.lastArmPoint
          && _surf.rect[1] > ctx.memory.lastArmPoint[1] + 20
          ? ctx.memory.lastArmPoint[1] - 20 : null;
        const _scanRect = _menuTop != null
          ? [_surf.rect[0], _menuTop, _surf.rect[2], _surf.rect[1] + _surf.rect[3] - _menuTop]
          : _surf?.rect;
        const _inSurfX = _scanRect && _scanRect !== _surf.rect
          ? (e => e.center && e.bbox
            && e.center[0] >= _scanRect[0] - 6 && e.center[0] <= _scanRect[0] + _scanRect[2] + 6
            && e.center[1] >= _scanRect[1] - 6 && e.center[1] <= _scanRect[1] + _scanRect[3] + 6)
          : _inSurf;
        // Transport fingerprint — a surface whose children are ≥40% player
        // controls is the media bar / persistent queue panel wearing a
        // dialog rect. Furniture instantly, no dismissal budget spent.
        if (_surf) {
          const _tk = els.filter(_inSurf);
          const _tn = _tk.filter(e => _vocab.TRANSPORT_VOCAB.test(String(e.label || ''))).length;
          if (_tk.length >= 4 && (_tn >= Math.ceil(_tk.length * 0.4) || _tn >= 5)) {
            (ctx.memory._surfFurniture ||= []).push(_surf.rect);
            emit(`bulk delete: ${_surf.kind} is transport panel — furniture`);
            _surf = null;
          }
        }
        // A "dialog" the enrich pass already fingerprinted as a persistent
        // panel is furniture here too — don't let it re-enter via surf.
        if (_surf && _surf.kind === 'dialog' && _dlgNow
          && ctx.memory.dlgFurniture && ctx.memory.dlgFurniture.has(_dlgFp(_dlgNow))) _surf = null;
        const _surfSig = _surf ? `${_surf.kind}@${_surf.rect.map(v => Math.round(v / 24)).join(',')}` : 'container';
        if (_surfSig !== ctx.memory._surfaceSig) {
          ctx.memory._surfaceSig = _surfSig;
          ctx.memory._noMatch = 0;   // strikes are per-surface
          // Kind-level commit budget — the rect sig jitters every re-parse
          // (±1px, dialog↔native-dialog), so commits are counted per KIND:
          // reset only on container or a genuinely different kind.
          const _k = _surf ? (/dialog/.test(_surf.kind) ? 'dialog' : _surf.kind) : 'container';
          if (_k !== ctx.memory._lastSurfKind) { ctx.memory._lastSurfKind = _k; ctx.memory._kindCommits = null; }
          const _items = _surf ? els.filter(_inSurf)
            .map(e => String(e.label || '').slice(0, 16)).filter(Boolean).slice(0, 12) : [];
          emit(`bulk delete: surface=${_surfSig}${_items.length ? ' [' + _items.join(' | ') + ']' : ''}`);
        }
        // ── verify ledger — a commit's row count must drop, persisted ───
        // Runs ONLY on the base surface: a live surface (the confirm dialog
        // this commit produced) still needs resolving — fall through.
        if (ctx.memory.removeCommitted && !_surf) {
          const k = _workKey(ctx.memory.committedLabel || ctx.memory.armedLabel || '');
          const _armed = ctx.memory.committedLabel || ctx.memory.armedLabel;
          // Row pool is the verification unit. While _workRows is null the
          // parse is still occluded by the closing surface — deferring a few
          // observes beats verdict-ing on a half-seen element list.
          let nowCount = _workRows ? _workRows.length : null;
          if (nowCount == null) {
            const pv = ctx.memory._pendingVerify;
            if (!pv || pv.k !== k) ctx.memory._pendingVerify = { k, at: iters };
            if (iters - ctx.memory._pendingVerify.at < 6) continue;
            nowCount = _surfaceCount(_armed);   // last resort: flat pool
          }
          ctx.memory._pendingVerify = null;
          const before = ctx.memory.committedBefore ?? (nowCount + 1);
          {
            if (nowCount < before && !(before === 1 && nowCount === 0)) {
              ctx.memory.removeChains = (ctx.memory.removeChains || 0) + 1;
              (ctx.memory.delCounts ||= {})[k] = nowCount;
              emit(`bulk delete: verify "${k.slice(0, 30)}" ok (${before}→${nowCount}) chains=${ctx.memory.removeChains}`);
            } else if (before === 1 && nowCount === 0) {
              const pv = ctx.memory._pendingVerify;
              if (!(pv && pv.k === k && iters - pv.at <= 6)) {
                ctx.memory._pendingVerify = { k, at: iters };
                emit(`bulk delete: "${k.slice(0, 30)}" count 1→0 — pending one more observe`);
                continue;
              }
              const _surfaceAlive = _workRows?.length
                || els.some(e => e.center && _excluded(e.label) && _inWorkContainer(e));
              if (_surfaceAlive) {
                ctx.memory.removeChains = (ctx.memory.removeChains || 0) + 1;
                (ctx.memory.doneWork ||= new Set()).add(k);
                emit(`bulk delete: verify "${k.slice(0, 30)}" ok (1→0 persisted) chains=${ctx.memory.removeChains}`);
              } else {
                emit(`bulk delete: "${k.slice(0, 30)}" vanished WITH surface — navigated, back-out`);
                (ctx.memory.badWork ||= new Set()).add(k);
                await keyboardAgent({ key: 'left', mods: ['alt'], sessionId }).catch(() => null);
                await sleep(400);
              }
              ctx.memory._pendingVerify = null;
            } else {
              const _triesObj = ctx.memory.armTries ||= {};
              const tk = Object.keys(_triesObj).find(x => _sameWork(x, k)) || k;
              const tries = _triesObj[tk] = (_triesObj[tk] || 0) + 1;
              if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
            }
            ctx.memory.removeCommitted = null; ctx.memory.committedLabel = null;
            ctx.memory.armedLabel = null; ctx.memory.delArmTarget = null;
            ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
            ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
            ctx.memory._armStale = 0;
          }
          continue;
        }
        // ── transient surface — its children are the whole candidate set ─
        if (_surf) {
          // Anchored test — while a row is armed and uncommitted, the ONLY
          // surface that can be its menu is the one at the arm point. A
          // surface elsewhere is a foreign obstruction: dismiss it, but it
          // must NEVER convict the row (no delete inside ≠ non-deletable).
          const _armedMine = !!(ctx.memory.armedLabel && !ctx.memory.removeCommitted);
          const _ap = ctx.memory.lastArmPoint;
          const _anchored = !_armedMine || !_ap
            || (_ap[0] >= _surf.rect[0] - 120 && _ap[0] <= _surf.rect[0] + _surf.rect[2] + 120
              && _ap[1] >= _surf.rect[1] - 140 && _ap[1] <= _surf.rect[1] + _surf.rect[3] + 240);
          // Post-commit the only legitimate surface is the confirm dialog —
          // it carries a confirm/delete-shaped child. Anything else post-
          // commit is foreign; the verify ledger owns the verdict.
          const _postCommitForeign = !!ctx.memory.removeCommitted
            && !els.some(e => _inSurf(e) && (_vocab.classifyAction(String(e.label || ''), 'confirm')
              || _vocab.classifyAction(String(e.label || ''), 'delete')));
          const _foreign = !ctx.memory.armedLabel || !_anchored || _postCommitForeign;
          if (_foreign) {
            // Key on normalized kind + coarse ORIGIN — the rect w,h and the
            // dialog↔native-dialog kind label jitter every re-parse; keying
            // the counter on the full sig reset it forever and the same
            // undismissable panel kept eating dismissal attempts.
            const _fsig = `${/dialog/.test(_surf.kind) ? 'dialog' : /menu/.test(_surf.kind) ? 'menu' : _surf.kind}@${Math.round(_surf.rect[0] / 96)},${Math.round(_surf.rect[1] / 96)}`;
            if (ctx.memory._foreignSurfSig !== _fsig) { ctx.memory._foreignSurfSig = _fsig; ctx.memory._foreignSurf = 0; }
            ctx.memory._foreignSurf = (ctx.memory._foreignSurf || 0) + 1;
            // While armed, hold off 2 observes — a right-clicked menu may
            // still be rasterizing; Escape would close it too.
            if (!(_armedMine && ctx.memory._foreignSurf <= 2)) {
              if (ctx.memory._foreignSurf >= 8) {
                // Unkillable surface = furniture — never transient again.
                (ctx.memory._surfFurniture ||= []).push(_surf.rect);
                ctx.memory._foreignSurf = 0;
                emit(`bulk delete: ${_surf.kind} survived 8 dismissals — marked furniture`);
                continue;
              }
              if (ctx.memory._foreignSurf >= 2) {
                const _fs = ctx.memory._foreignSurf;
                emit(`bulk delete: foreign ${_surf.kind} → back-out (${_fs})`);
                // Dismiss-shaped child first — Escape doesn't close every
                // modal; a "Got it/OK/Close" button is a real dismiss commit.
                const _dismiss = els.find(e => _inSurf(e) && e.center
                  && _vocab.classifyAction(String(e.label || ''), 'cancel'));
                if (_dismiss) {
                  await mouseAgent({ action: 'click', x: Math.round(_dismiss.center[0]), y: Math.round(_dismiss.center[1]), sessionId }).catch(() => null);
                } else if (_fs >= 5) {
                  // Survived escapes AND no dismiss button — click dead space
                  // outside the bound (page click dismisses most modals).
                  await mouseAgent({ action: 'click',
                    x: Math.round(_surf.rect[0] + _surf.rect[2] + 220 < _winW ? _surf.rect[0] + _surf.rect[2] + 220 : _winW / 2),
                    y: Math.round(Math.min(_winH - 200, _surf.rect[1] + _surf.rect[3] / 2)), sessionId }).catch(() => null);
                } else {
                  await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
                }
                await sleep(300);
              }
            }
            continue;
          }
          ctx.memory._foreignSurf = 0; ctx.memory._foreignSurfSig = null;
          const k = _workKey(ctx.memory.armedLabel);
          let _choices = els.filter(_inSurfX);
          if (ctx.memory._surfProbe !== _surfSig) {
            ctx.memory._surfProbe = _surfSig;
            const _scan = await _probeRect(_scanRect, { display, windowOnly }).catch(() => []);
            for (const se of _scan) {
              if (!se.center) continue;
              if (!_choices.some(c => Math.abs(c.center[0] - se.center[0]) < 14 && Math.abs(c.center[1] - se.center[1]) < 14))
                _choices.push(se);
            }
            emit(`bulk delete: zoom-scan ${_surf.kind} +${_scan.length} items`);
          }
          const _want = _surf.kind === 'dialog' ? 'confirm' : 'delete';
          // VICTIM GUARD — a confirm dialog names its target ("This will
          // delete Quiet Hour from Your Library"). If that name is an
          // excluded row or doesn't match the armed label, the arm landed
          // on the wrong row: cancel the dialog, never commit. This is the
          // hard invariant of a delete lane — surface vocab can never
          // override it.
          if (/dialog/.test(_surf.kind)) {
            const _body = _choices.map(e => String(e.label || '')).join(' ');
            const _vic = (_body.match(/will\s+(?:delete|remove)\s+"?([^".,;]+?)"?\s+from/i)
              || _body.match(/(?:delete|remove)\s+"?([^".,;]+?)"?\s+from/i))?.[1];
            if (_vic && (_excluded(_vic)
              || (ctx.memory.armedLabel && !_sameWork(_vic, ctx.memory.armedLabel)
                && !_sameWork(ctx.memory.armedLabel, _vic)))) {
              const _cancel = _choices.find(e => e.center
                && _vocab.classifyAction(String(e.label || ''), 'cancel'));
              emit(`bulk delete: dialog victim "${_vic.slice(0, 26)}" ≠ armed "${String(ctx.memory.armedLabel || '').slice(0, 26)}" — CANCEL, never commit`);
              // The arm's click point landed on the victim's row — the
              // armed element's geometry is untrusted; skip it a while.
              (ctx.memory._mergedSkip ||= new Map()).set(k, iters);
              if (_cancel) await mouseAgent({ action: 'click', x: Math.round(_cancel.center[0]), y: Math.round(_cancel.center[1]), sessionId }).catch(() => null);
              else await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
              ctx.memory.armedLabel = null; ctx.memory.delArmTarget = null;
              ctx.memory.removeCommitted = null; ctx.memory.committedLabel = null;
              await sleep(350);
              continue;
            }
          }
          // Buttons are short — "Delete" commits, "Delete from Your Library.
          // This can't be undone" is dialog furniture that matches the same
          // vocab. Short-label candidates first, any match as fallback.
          const _short = e => String(e.label || '').trim().split(/\s+/).length <= 2;
          const _m = e => e.center && _vocab.classifyAction(String(e.label || ''), _want);
          const item = _choices.find(e => _short(e) && _m(e))
            || _choices.filter(_m)
              // Bottommost match — the confirm/delete BUTTON is the lowest
              // vocab element in a dialog; the title ("Delete from Your
              // Library?") and body text sit above it in dead space.
              .sort((a, b) => ((b.bbox?.[1] ?? b.center[1]) - (a.bbox?.[1] ?? a.center[1])))[0];
          if (item && item.center) {
            let _cx = Math.round(item.center[0]), _cy = Math.round(item.center[1]);
            // Sub-box pick: the LOWEST matching word/row. A merged blob
            // ("Delete Quiet Hou" = button + body text) centers on dead
            // space — the button's word box sits at the bottom.
            const _subs = [...(item.rows || []), ...(item.words || [])]
              .filter(s => s.bbox && _vocab.classifyAction(s.text || '', _want))
              .sort((a, b) => (b.bbox[1] + b.bbox[3]) - (a.bbox[1] + a.bbox[3]));
            if (_subs[0]) { _cx = Math.round(_subs[0].bbox[0] + _subs[0].bbox[2] / 2); _cy = Math.round(_subs[0].bbox[1] + _subs[0].bbox[3] / 2); }
            let _still = true;
            if (iters - (ctx.memory._lastPreVerify ?? -99) >= 1) {
              ctx.memory._lastPreVerify = iters;
              const _check = await _probeRect(cropRectFor(item, 60), { display, windowOnly }).catch(() => []);
              if (_check.length) _still = _check.some(c => c.center && _vocab.classifyAction(c.label, _want));
            }
            if (_still) {
              // Commit cap — a live surface responds to a commit by
              // changing sig. Same sig ≥2 commits = the clicks are
              // missing; re-clicking the same coords is futile.
              if (ctx.memory._commitSig === _surfSig) ctx.memory._commitCount = (ctx.memory._commitCount || 0) + 1;
              else { ctx.memory._commitSig = _surfSig; ctx.memory._commitCount = 1; }
              // The sig jitters on every re-parse (rect ±1px, kind
              // dialog↔native-dialog) — cap commits per surface KIND too
              // or a dead button gets re-clicked forever.
              const _kind = /dialog/.test(_surf.kind) ? 'dialog' : _surf.kind;
              ctx.memory._kindCommits = ctx.memory._kindCommits || {};
              ctx.memory._kindCommits[_kind] = (ctx.memory._kindCommits[_kind] || 0) + 1;
              if (ctx.memory._commitCount > 2 || ctx.memory._kindCommits[_kind] > 4) {
                emit(`bulk delete: ${_surf.kind} ignored ${ctx.memory._kindCommits[_kind]} commits — back-out, re-resolve`);
                await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
                ctx.memory._commitSig = null; ctx.memory._commitCount = 0;
                ctx.memory._kindCommits = null;
                await sleep(350);
                continue;
              }
              emit(`bulk delete: commit "${String(item.label || '').slice(0, 28)}" @(${_cx},${_cy}) surface=${_surf.kind}`);
              await mouseAgent({ action: 'click', x: _cx, y: _cy, sessionId }).catch(() => null);
              ctx.memory.removeCommitted = iters;
              ctx.memory.committedLabel = ctx.memory.armedLabel;
              // Member count, not label-occurrence — at commit time the menu
              // occludes the row so the flat pool counts 0 and N<0 can never
              // verify. _lastRowCount is the same clean pool the ledger uses.
              ctx.memory.committedBefore = ctx.memory._lastRowCount ?? _surfaceCount(ctx.memory.armedLabel);
              ctx.memory._lastCommitIter = iters;
              ctx.memory._noMatch = 0;
              await sleep(400);
              continue;
            }
            emit('bulk delete: pre-commit verify failed — re-observing');
            ctx.memory._noMatch = (ctx.memory._noMatch || 0) + 1;
          } else ctx.memory._noMatch = (ctx.memory._noMatch || 0) + 1;
          if (ctx.memory._noMatch >= 3) {
            ctx.memory._noMatch = 0;
            if (ctx.memory.removeCommitted) {
              // Commit already fired — the verify ledger owns the verdict.
              // This surface is just slow; back out of it, keep the arm.
              emit(`bulk delete: post-commit ${_surf.kind} unresolved — back-out`);
              await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
              await sleep(300);
              continue;
            }
            (ctx.memory.badWork ||= new Set()).add(k);
            emit(`bulk delete: no ${_want} in ${_surf.kind} for "${k.slice(0, 26)}" — back-out, badWork`);
            // Header learn — an element whose menu had no delete AND sits
            // >1.5 row-pitch above the topmost REAL member is header
            // furniture (filter pills, sort controls): everything above the
            // midpoint cut is the list's header band. Evidence-gated — the
            // verdict requires its menu to have existed; positional only.
            {
              const _armY = ctx.memory.lastArmPoint?.[1];
              const _anchorY = Math.min(
                ...(ctx.memory._workLabelSet?._rows || [])
                  .filter(r => r.center && !_sameWork(r.label, ctx.memory.armedLabel))
                  .map(r => r.center[1]),
                ...els.filter(e => e.center && _excluded(e.label)).map(e => e.center[1]));
              if (_armY != null && _anchorY !== Infinity
                && _anchorY - _armY > (ctx.memory._rowH || 60) * 1.5) {
                ctx.memory._listTopCut = Math.min(ctx.memory._listTopCut ?? Infinity,
                  _armY + (_anchorY - _armY) / 2);
                emit(`bulk delete: header learn — list top ≈ y${Math.round(ctx.memory._listTopCut)}`);
              }
            }
            ctx.memory.armedLabel = null;
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            await sleep(300);
          }
          continue;
        }
        // ── base surface = container rows, top→bottom ────────────────────
        ctx.memory._noMatch = 0;
        if (ctx.memory.armedLabel) {
          ctx.memory._armStale = (ctx.memory._armStale || 0) + 1;
          if (ctx.memory._armStale >= 5) {
            ctx.memory._armStale = 0;
            (ctx.memory.badWork ||= new Set()).add(_workKey(ctx.memory.armedLabel));
            emit(`bulk delete: arm "${_workKey(ctx.memory.armedLabel).slice(0, 26)}" no surface ×5 — badWork`);
            ctx.memory.armedLabel = null;
          }
          continue;
        }
        const _pickRow = e => e.center && e.bbox
          && !(ctx.memory._listTopCut != null && e.center[1] < ctx.memory._listTopCut)
          && !_debris(e) && !_looksLikeInput(e) && e._regionRole !== 'panel'
          && (e.center[1] < _winH - 110 || _inWorkContainer(e))
          && String(e.label || '').trim().length > 2 && !_excluded(e.label)
          && _inWorkCol(e) && _rowLabel(e)
          && !/^(group|row|list|listitem|region|section|container|generic|content|main|panel|scroll\s*area?|web\s*area|layout)$/i.test(String(e.label || '').trim())
          && !/removed from|added to|undo|copied|saved to/i.test(String(e.label || ''))
          && !(ctx.memory.doneWork && [...ctx.memory.doneWork].some(k => _sameWork(e.label, k)))
          && !(ctx.memory.badWork && [...ctx.memory.badWork].some(k => _sameWork(e.label, k)))
          && !(ctx.memory._mergedSkip && [...ctx.memory._mergedSkip].some(([k, at]) => iters - at < 15 && _sameWork(e.label, k)))
          && (_vocab.isWorkRowCandidate(e) || (_inWorkContainer(e) && String(e.label || '').trim().length > 10
            && !_vocab.isNavFurniture(String(e.label || '')) && !_vocab.TRANSPORT_VOCAB.test(String(e.label || ''))));
        const _target = _workRows ? _workRows.find(_pickRow) : null;
        if (_target && _target.center) {
          ctx.memory._noPick = 0;
          // Arm point = the sub-row carrying THIS label, not the element
          // center — a merged element ("Liked Songs…|Quiet Hour…") centers
          // on the wrong row and right-clicks it instead. No matching
          // sub-box in a decomposed element → untrusted center, skip.
          const _labelHead = String(_target.label || '').trim().split(/\s+/).slice(0, 3).join(' ');
          const _rrows = (_target.rows || []).filter(s => s.bbox && s.text);
          let _tx = Math.round(_target.center[0]), _ty = Math.round(_target.center[1]);
          if (_rrows.length >= 2) {
            const _mine = _rrows.find(s => _sameWork(_labelHead, s.text) || _sameWork(s.text, _labelHead));
            if (!_mine) {
              (ctx.memory._mergedSkip ||= new Map()).set(_workKey(_target.label), iters);
              emit(`bulk delete: skip "${String(_target.label || '').slice(0, 24)}" — merged element, no own sub-row`);
              continue;
            }
            _tx = Math.round(_mine.bbox[0] + _mine.bbox[2] / 2);
            _ty = Math.round(_mine.bbox[1] + _mine.bbox[3] / 2);
          }
          // Probe-guided arm — scan the element's own region; whatever
          // carries THIS label is the real click target. Element geometry
          // lies (merged blobs center on the wrong row); the crop scan is
          // ground truth. After redirect, the row at click height must
          // carry the label or the arm is unsafe.
          const _armScan = await _probeRect(
            _target.bbox ? cropRectFor(_target, 40)
              : [Math.max(0, _tx - 120), Math.max(0, _ty - 60), 440, 120],
            { display, windowOnly }).catch(() => []);
          const _hit = _armScan.find(p => p.center
            && Math.abs(p.center[0] - _tx) <= 200   // same column — a match
            // 200+px away is another region's text (main-area card)
            && (_sameWork(_labelHead, String(p.label || '')) || _sameWork(String(p.label || ''), _labelHead)));
          if (_hit && Math.hypot(_hit.center[0] - _tx, _hit.center[1] - _ty) > 30) {
            emit(`bulk delete: arm redirected (${_tx},${_ty}) → (${Math.round(_hit.center[0])},${Math.round(_hit.center[1])}) via scan`);
            _tx = Math.round(_hit.center[0]); _ty = Math.round(_hit.center[1]);
          }
          const _rowAt = _armScan.filter(p => p.center
            && Math.abs(p.center[1] - _ty) <= 26);
          if (_rowAt.length && !_rowAt.some(p =>
            _sameWork(_labelHead, String(p.label || '')) || _sameWork(String(p.label || ''), _labelHead))) {
            (ctx.memory._mergedSkip ||= new Map()).set(_workKey(_target.label), iters);
            emit(`bulk delete: skip "${String(_target.label || '').slice(0, 24)}" — arm point shows "${String(_rowAt[0].label || '').slice(0, 24)}", not the row`);
            continue;
          }
          emit(`bulk delete: arm "${String(_target.label || '').slice(0, 30)}" → right-click @(${_tx},${_ty})`);
          await mouseAgent({ action: 'right-click', x: _tx, y: _ty, sessionId }).catch(() => null);
          ctx.memory.armedLabel = _target.label;
          ctx.memory.lastArmPoint = [_tx, _ty];
          ctx.memory.bulkClickedAt = iters;
          ctx.memory.bulkClicks = (ctx.memory.bulkClicks || 0) + 1;
          await sleep(320);
          continue;
        }
        // Drained — container resolves but every member is excluded/
        // skipped/convicted. A few straight empty picks = done, don't
        // burn the whole iteration budget staring at Quiet Hour.
        if (!_workRows || !_workRows.length || (ctx.memory._noPick = (ctx.memory._noPick || 0) + 1) >= 6) {
          const _done = ctx.memory.removeChains || 0, _skipped = ctx.memory.badWork?.size || 0;
          if (ctx.memory.delPendingUser?.size) {
            const _pend = [...ctx.memory.delPendingUser.entries()].map(([pk, v]) => ({ label: pk, ...v }));
            return { ok: false, iters, trace, learned, acts, needsUser: {
              question: `${_pend.length} row(s) need a decision (${_done} already deleted).`, rows: _pend } };
          }
          return pass(`bulk delete: no deletable rows remain — ${_done} deleted, ${_skipped} skipped${_exSet.size ? `, {${[..._exSet].join(', ')}} preserved` : ''}`, iters, true);
        }
        continue;
      }
      // ── armed-state resolution ─────────────────────────────────────────
      if (ctx.memory.armedLabel) {
        const k = _workKey(ctx.memory.armedLabel);
        // FUZZY count — OCR mutates the row label every observe ("all l ne6d"
        // vs "all l need"). Exact key equality counts a mutation as 0 →
        // false "verified" while the row is still on screen.
        const nowCount = els.filter(e => _sameWork(e.label, ctx.memory.armedLabel)).length;
        // Browser-menu veto — a right-click on dead space opens CHROME's
        // native menu (Select all / Inspect / Open Quick Search), not the
        // row's. It's a separate OS layer that lingers and poisons
        // preArmLabels → count a failed arm and retry, never enumerate it.
        const _bItems = els.filter(e => e.center && _nearArm(e)
          && _vocab.BROWSER_MENU.test(String(e.label || ''))
          // A browser menu is MENU items, not page text matching the vocab
          // — Spotify's Keyboard Shortcuts panel literally contains "Open
          // Quick Search"/"Select all" as body text, and it was vetoing
          // every arm. Require real menu membership (or OCR-probe flag).
          && (_menuishEl(e) || e._inOpenMenu || e._ocrMenu
            || (ctx.memory.menuRect
              && e.center[0] >= ctx.memory.menuRect[0] && e.center[0] <= ctx.memory.menuRect[0] + ctx.memory.menuRect[2]
              && e.center[1] >= ctx.memory.menuRect[1] && e.center[1] <= ctx.memory.menuRect[1] + ctx.memory.menuRect[3])));
        if (!ctx.memory.removeCommitted && ctx.memory.armedLabel
            && iters - (ctx.memory.bulkClickedAt ?? -99) <= 8
            && _bItems.length >= 2) {
          const _triesObj = ctx.memory.armTries ||= {};
          const tk = Object.keys(_triesObj).find(x => _sameWork(x, k)) || k;
          const tries = _triesObj[tk] = (_triesObj[tk] || 0) + 1;
          if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
          emit(`bulk delete: browser menu on "${k.slice(0, 24)}" [${_bItems.map(e => String(e.label || '').slice(0, 18)).join(' | ')}] — Escape, retry arm (tries=${tries})`);
          await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
          ctx.memory.lastArmedKey = k;
          ctx.memory.armedLabel = null; ctx.memory.delArmTarget = null;
          ctx.memory.preArmLabels = null;
          ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
          ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
          ctx.memory.expectMenuAt = null; ctx.memory.delMenuSince = null;
          continue;
        }
        if (ctx.memory.removeCommitted) {
          // COUNT-decrement, not label-absence — duplicate labels ("All I
          // Need Is You" ×3) mean one delete leaves the label still present.
          // Skip while a dialog is live — it OCCLUDES sidebar rows and the
          // count decrement reads as a false "verified".
          const before = (ctx.memory.delCounts || {})[k] ?? (nowCount + 1);
          // A 1→0 "verified" on ONE observe is a lie half the time: OCR
          // flicker, menu/dialog occlusion, or a click that NAVIGATED into
          // the row's page all read as count-0. Defer the singleton case
          // one observation — the label must stay absent (and the work
          // surface stay alive) before it's verified.
          if (!_dlgNow && nowCount < before && !(before === 1 && nowCount === 0)) {
            ctx.memory.removeChains = (ctx.memory.removeChains || 0) + 1;
            maxIters = Math.min(maxIters + 10, 90);
            (ctx.memory.delCounts ||= {})[k] = nowCount;
            emit(`bulk delete: verified "${k.slice(0, 30)}" (${before}→${nowCount}, chains=${ctx.memory.removeChains})`);
          } else if (!_dlgNow && before === 1 && nowCount === 0) {
            const pv = ctx.memory._pendingVerify;
            if (pv && pv.k === k && iters - pv.at <= 6) {
              // Persisted absence — but if the whole surface vanished too,
              // we navigated INTO the row, not deleted it: back out instead.
              const _surfaceAlive = _workRows?.length
                || els.some(e => e.center && _excluded(e.label) && _inWorkContainer(e));
              if (_surfaceAlive) {
                ctx.memory.removeChains = (ctx.memory.removeChains || 0) + 1;
                (ctx.memory.doneWork ||= new Set()).add(k);
                emit(`bulk delete: verified "${k.slice(0, 30)}" (1→0 persisted, chains=${ctx.memory.removeChains})`);
              } else {
                emit(`bulk delete: "${k.slice(0, 30)}" vanished WITH the surface — navigation, backing out`);
                (ctx.memory.badWork ||= new Set()).add(k);
                await keyboardAgent({ key: 'left', mods: ['alt'], sessionId }).catch(() => null);
                await sleep(400);
              }
              ctx.memory._pendingVerify = null;
            } else {
              ctx.memory._pendingVerify = { k, at: iters };
              emit(`bulk delete: "${k.slice(0, 30)}" count 1→0 — pending one more observe`);
            }
          } else if (!_dlgNow) {
            const _triesObj = ctx.memory.armTries ||= {};
            const tk = Object.keys(_triesObj).find(x => _sameWork(x, k)) || k;
            const tries = _triesObj[tk] = (_triesObj[tk] || 0) + 1;
            if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
          }
          ctx.memory.removeCommitted = null;
          ctx.memory.lastArmedKey = k;
          ctx.memory.armedLabel = null;
          ctx.memory.preArmLabels = null;
          ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
          ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
        } else if ((_dlgNow || _dlgLive) && (ctx.memory.armedLabel
            || iters - (ctx.memory.bulkClickedAt ?? -99) <= 20
            || iters - (ctx.memory._lastCommitIter ?? -99) <= 20)) {
          // Confirmation dialog live while armed — click the CONFIRM button
          // inside the dialog rect DIRECTLY (dialog body text like "Delete
          // from Your Library. This can't be undone" classifies as delete
          // but isn't clickable; the button is the commit).
          const _dr2 = _dlgNow ? _dlgNow.rect
            : _dlgEls.length ? [_dlgEls.reduce((a, e) => Math.min(a, e.center[0]), 1e9) - 40,
               _dlgEls.reduce((a, e) => Math.min(a, e.center[1]), 1e9) - 40,
               _dlgEls.reduce((a, e) => Math.max(a, e.center[0]), 0) - _dlgEls.reduce((a2, e) => Math.min(a2, e.center[0]), 1e9) + 80,
               _dlgEls.reduce((a, e) => Math.max(a, e.center[1]), 0) - _dlgEls.reduce((a2, e) => Math.min(a2, e.center[1]), 1e9) + 80]
            : (_structDlg || _lateConf)
              ? [(_structDlg || _lateConf).center[0] - 400, (_structDlg || _lateConf).center[1] - 160, 800, 300]
              : null;
          if (!_dr2) continue;
          const _isOk = e => e.center
            && e.center[0] >= _dr2[0] && e.center[0] <= _dr2[0] + _dr2[2]
            && e.center[1] >= _dr2[1] && e.center[1] <= _dr2[1] + _dr2[3]
            && _vocab.classifyAction(e.label, 'confirm')
            && !/[.!?…]/.test(String(e.label || '').trim());
          const _ok = els.find(e => _isOk(e) && /button|link|menuitem|option/i.test(String(e._role || e.type || '')))
            || els.find(e => _isOk(e) && String(e.label || '').trim().split(/\s+/).length <= 2);
          if (_ok && _ok.center) {
            emit(`bulk delete: confirm "${String(_ok.label || '').slice(0, 24)}" @(${Math.round(_ok.center[0])},${Math.round(_ok.center[1])})`);
            await mouseAgent({ action: 'click', x: Math.round(_ok.center[0]), y: Math.round(_ok.center[1]), sessionId }).catch(() => null);
            ctx.memory.removeCommitted = iters;
            ctx.memory._lastCommitIter = iters;
            await sleep(400);
            continue;
          }
          if (iters - (ctx.memory._dlgProbeAt ?? -99) >= 2) {
            ctx.memory._dlgProbeAt = iters;
            const found = await _probeRect(
              [Math.max(0, _winW / 2 - 500), Math.max(0, _winH / 2 - 320), 1000, 640],
              { display, windowOnly });
            const hit = found.find(e => _confEl(e));
            if (hit?.center) {
              emit(`bulk delete: dialog probe confirm "${String(hit.label || '').slice(0, 24)}" @(${Math.round(hit.center[0])},${Math.round(hit.center[1])})`);
              await mouseAgent({ action: 'click', x: Math.round(hit.center[0]), y: Math.round(hit.center[1]), sessionId }).catch(() => null);
              ctx.memory.removeCommitted = iters;
              ctx.memory._lastCommitIter = iters;
              await sleep(400);
              continue;
            }
          }
        } else if (_menuLiveDel) {
          // Menu observed — the candidate set is the overlay node's ordered
          // children (scene-first). Flat-els admission survives only as the
          // fallback when no overlay container clustered this iter.
          const _pool = _overlayItems && _overlayItems.length
            ? _overlayItems.filter(e => e.center && String(e.label || '').trim().length > 1
                && e._regionRole !== 'dialog' && e._containerRole !== 'dialog'
                && !/[.!?…]/.test(String(e.label || '').trim()))
            : els.filter(e => e.center && String(e.label || '').trim().length > 1
            // Dialog body text masquerades as menu items — exclude elements
            // inside a live dialog rect from menu-pool membership.
            && !(_dlgNow && e.center
              && e.center[0] >= _dlgNow.rect[0] && e.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
              && e.center[1] >= _dlgNow.rect[1] && e.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3])
            && e._regionRole !== 'dialog' && e._containerRole !== 'dialog' && !/dialog/i.test(String(e._region || ''))
            && !/[.!?…]/.test(String(e.label || '').trim()) // sentence text (dialog body, toasts) isn't an item
            && (e._inOpenMenu || e._ocrMenu || /menuitem|option/.test(String(e._role || ''))
              || (ctx.memory.menuRect && e.center[0] >= ctx.memory.menuRect[0] && e.center[0] <= ctx.memory.menuRect[0] + ctx.memory.menuRect[2]
                && e.center[1] >= ctx.memory.menuRect[1] && e.center[1] <= ctx.memory.menuRect[1] + ctx.memory.menuRect[3])
              // Set-diff pool: fresh elements within the arm window ARE the
              // menu — flagging and rect-pinning both drop intermittently.
              || (ctx.memory.preArmLabels && iters - (ctx.memory.bulkClickedAt ?? -99) <= 10
                && _freshLabel(e)
                && _nearArm(e)
                && e._regionRole !== 'media')
              // Semantic admission — a delete-shaped label within reach of
              // the click IS a menu item by meaning. Freshness bookkeeping
              // can't hide it (stale-menu contamination made identical text
              // read as pre-existing → "Delete from Your Library" observed
              // but never pooled).
              || (_nearArm(e) && _vocab.classifyAction(e.label, 'delete'))));
          const item = _pool.find(_delMenuItem)
            || _pool.find(e => _vocab.learnedAction(String(ctx.app || ctx._goalApp || "app").toLowerCase(), e.label) === 'delete')
            || _pool.find(e => _vocab.classifyAction(e.label, 'delete'));
          if (item) {
            // Commit DIRECTLY — probe-synthesized OCR elements don't exist
            // in the downstream pick-model's option set, so queueing hands
            // the item to a picker that can't see it ("model: nothing
            // relevant" → arm stalls). The menu anchors at the arm point
            // and the item's center is already screen-true.
            if (item.center) {
              let _cx = Math.round(item.center[0]), _cy = Math.round(item.center[1]);
              const _lbl = String(item.label || '');
              // Precision boxes first — rows (multi-row merged labels) then
              // words: click the sub-box containing a delete-classified
              // token, not the merged bbox center. Exact geometry beats the
              // segment heuristic below.
              const _subHit = (subs) => (subs || []).find(s =>
                s.bbox && _vocab.classifyAction(s.text || '', 'delete'));
              const _sub = _subHit(item.rows) || _subHit(item.words)
                || (item.words || []).find(s => s.bbox && /remov|delet|trash|unfollow/i.test(String(s.text || '')));
              if (_sub) {
                _cx = Math.round(_sub.bbox[0] + _sub.bbox[2] / 2);
                _cy = Math.round(_sub.bbox[1] + _sub.bbox[3] / 2);
              } else if (item.bbox && item.bbox[3] > 30) {
                // OCR merges whole menu ROWS into one label — segment by
                // action words: "Report Remov8from…" = 2 segments, so the
                // delete segment's row-center is ~0.75 of the bbox height,
                // not its char-fraction (~0.22 → hits "Report").
                const _acts = [..._lbl.toLowerCase().matchAll(
                  /report|edit|add|share|copy|pin|download|remov\w*|delet\w*|trash|archive|leave|clear|unfollow|create|rename/g)];
                const _mi = _acts.findIndex(m => /^remov|^delet|^trash|^archive|^leave|^clear|^unfollow/.test(m[0]));
                if (_mi > 0 || _acts.length > 1) {
                  const _frac = _mi >= 0 ? (_mi + 0.5) / _acts.length : 0.5;
                  _cy = Math.round(item.bbox[1] + item.bbox[3] * Math.min(0.88, Math.max(0.12, _frac)));
                }
              }
              // Pre-commit verify (PUSV) — the observe→act gap lets menus
              // close/rows scroll. Re-parse the item's crop; if nothing
              // delete-shaped still lives near the target, skip the click
              // and let the next observe rebuild the menu rather than
              // landing a blind right-click on dead space.
              let _still = true;
              if (iters - (ctx.memory._lastPreVerify ?? -99) >= 1) {
                ctx.memory._lastPreVerify = iters;
                const _check = await _probeRect(cropRectFor(item, 60), { display, windowOnly });
                if (_check.length) {
                  _still = _check.some(c => c.center
                    && Math.abs(c.center[0] - _cx) < 90 && Math.abs(c.center[1] - _cy) < 60
                    && (_vocab.classifyAction(c.label, 'delete')
                      || _sameWork(String(c.label || ''), _lbl)));
                  if (!_still && _check.some(c => _vocab.classifyAction(c.label, 'delete')))
                    _still = true; // delete item still in crop, coords drifted — take it
                }
              }
              if (_still) {
              emit(`bulk delete: committing "${_lbl.slice(0, 30)}" @(${_cx},${_cy})`);
              await mouseAgent({ action: 'click', x: _cx, y: _cy, sessionId }).catch(() => null);
              ctx.memory.removeCommitted = iters;
            ctx.memory._lastCommitIter = iters;
              if (ctx.memory.lastArmPoint)
                ctx.memory.lastCommitOffset = [Math.round(item.center[0]) - ctx.memory.lastArmPoint[0], Math.round(item.center[1]) - ctx.memory.lastArmPoint[1]];
              await sleep(400);
              continue;
              }
              if (!_still) {
                emit(`bulk delete: pre-commit verify failed — re-observing instead of blind click`);
                // Repeated re-verify failures = the delete item the parse
                // saw is not on screen (menu closed, ghost label). Escape
                // the menu and retire the arm; the row re-registers fresh.
                const _vf = (ctx.memory._verifyFails = (ctx.memory._verifyFails || 0) + 1);
                if (_vf >= 3) {
                  ctx.memory._verifyFails = 0;
                  (ctx.memory.badWork ||= new Set()).add(k);
                  ctx.memory.armedLabel = null;
                  emit(`bulk delete: arm "${k.slice(0, 26)}" unverifiable ×${_vf} — Escape, badWork`);
                  await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
                  await sleep(300);
                }
              }
            }
            queue = [item, ...queue.filter(c => c !== item)];
          } else if (_pool.length >= 2 && ctx.memory.delMenuSince == null) {
            ctx.memory.delMenuSince = iters; // let the pool settle one observe
            emit(`bulk delete: pool[${_pool.length}] = [${_pool.map(e => String(e.label || '').slice(0, 22)).join(' | ')}]`);
          } else if (_pool.length >= 2 && iters - ctx.memory.delMenuSince > 1) {
            // Never offer the model the armed row itself — an OCR-mutated row
            // label leaking into the pool becomes a self-referential pick
            // that re-arms the row instead of resolving the menu.
            const _opts = [...new Set(
                // Fresh near-arm items FIRST — they're the actual menu; the
                // rest of the pool is rect/flag debris that dilutes options.
                [..._freshNear.map(e => String(e.label || '').trim()),
                 ..._pool.map(e => String(e.label || '').trim())])]
              .filter(o => o && !_vocab.fuzzyMatch(o, ctx.memory.armedLabel)).slice(0, 8);
            const _asked = ctx.memory.delModelAsked ||= [];
            if (!_asked.some(a => _sameWork(a, k)) && _opts.length >= 2) {
              _asked.push(k);
            // Tier-1 empty → Tier-3: learned labels first (free), then ONE
            // bounded model call. 'unfollow'-class unhook verbs that the
            // model picks are EXACTLY the ambiguity the user wants surfaced
            // (pin ≠ playlist) → needsUser, not a silent commit.
              const r = await askDecision([{ id: 'menu', type: 'choice',
                question: `Context menu for "${ctx.memory.armedLabel}" — which option deletes or removes THIS item from the list?`,
                options: [..._opts, 'none — nothing deletes it'] }],
                { state: `Bulk task: delete every list row except exclusions. Row armed: "${ctx.memory.armedLabel}".`, timeoutMs: 15000 }).catch(() => null);
              const mi = r?.answers?.menu?.index;
              if (mi != null && mi < _opts.length) {
                const _pick = _pool.find(e => String(e.label || '').trim() === _opts[mi]);
                // Unhook verbs (Unfollow/Unpin/Unsave) are remove-ish but
                // ambiguous per the user's rule — surface, don't commit.
                if (_pick && _vocab.classifyAction(_pick.label, 'delete')) {
                  _vocab.learnAction(String(ctx.app || ctx._goalApp || "app").toLowerCase(), _pick.label, 'delete');
                  emit(`bulk delete: model picked "${_opts[mi].slice(0, 30)}"`);
                  if (_pick.center) {
                    await mouseAgent({ action: 'click', x: Math.round(_pick.center[0]), y: Math.round(_pick.center[1]), sessionId }).catch(() => null);
                    ctx.memory.removeCommitted = iters;
            ctx.memory._lastCommitIter = iters;
                    await sleep(400);
                  }
                  continue;
                }
                if (_pick) {
                  // Model picked something the vocab won't vouch for — the
                  // definition of ambiguous. NEVER blind-commit AND never
                  // learn it — QUEUE the question, skip to other rows, and
                  // surface everything at termination (one stalled row must
                  // not end the whole pass).
                  (ctx.memory.delPendingUser ||= new Map()).set(k, {
                    question: `"${ctx.memory.armedLabel}" — its menu has no clear delete option; the closest candidate is "${_opts[mi]}". Use it to remove this row, or skip the row?`,
                    options: [_opts[mi] + ' — remove it', 'Skip this row'],
                    armedLabel: ctx.memory.armedLabel });
                  emit(`bulk delete: "${_opts[mi].slice(0, 30)}" ambiguous for "${k.slice(0, 24)}" — queued for user`);
                  (ctx.memory.badWork ||= new Set()).add(k);
                  await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
                  ctx.memory.lastArmedKey = k;
                  ctx.memory.armedLabel = null;
                  ctx.memory.preArmLabels = null;
                  ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
                  ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
                  ctx.memory.expectMenuAt = null; ctx.memory.delMenuSince = null;
                  continue;
                }
              }
              if (r == null) {
                // Model unavailable — can't classify at all: queue for user.
                (ctx.memory.delPendingUser ||= new Map()).set(k, {
                  question: `"${ctx.memory.armedLabel}" — menu shows ${_opts.join(', ')}. Which option deletes it, or should this row be skipped?`,
                  options: [..._opts, 'Skip this row'],
                  armedLabel: ctx.memory.armedLabel });
                emit(`bulk delete: model unavailable for "${k.slice(0, 24)}" — queued for user`);
                (ctx.memory.badWork ||= new Set()).add(k);
                await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
                ctx.memory.lastArmedKey = k;
                ctx.memory.armedLabel = null;
                ctx.memory.preArmLabels = null;
                ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
                ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
                ctx.memory.expectMenuAt = null; ctx.memory.delMenuSince = null;
                continue;
              }
              // Model said 'none' → spec's skip rule: straight to badWork.
            }
            (ctx.memory.badWork ||= new Set()).add(k);
            emit(`bulk delete: menu had no delete item (${_pool.length} items) — skip "${k.slice(0, 30)}"`);
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            ctx.memory.lastArmedKey = k;
            ctx.memory.armedLabel = null;
            ctx.memory.preArmLabels = null;
            ctx.memory.menuRect = null; ctx.memory.menuRectLabels = null;
            ctx.memory.menuOpenedAt = null; ctx.memory.bulkClickedAt = null;
            ctx.memory.expectMenuAt = null; ctx.memory.delMenuSince = null;
            continue;
          }
        } else if (ctx.memory.expectMenuAt == null || iters - ctx.memory.expectMenuAt > 6) {
          // Armed but no menu ever materialized — arm failed (6-iter grace:
          // DOM menus render ~300-600ms after the click, and a parse that
          // lands mid-render sees nothing).
          const _triesObj = ctx.memory.armTries ||= {};
          const tk = Object.keys(_triesObj).find(x => _sameWork(x, k)) || k;
          const tries = _triesObj[tk] = (_triesObj[tk] || 0) + 1;
          if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
          ctx.memory.lastArmedKey = k;
          ctx.memory.armedLabel = null;
          ctx.memory.delArmTarget = null;
          ctx.memory.delMenuSince = null; // stale settle stamps must not skip the next arm's resolution
        }
        // Hard arm timeout — a menu-ish surface can hold _menuLiveDel true
        // while yielding <2 pool items forever (artist-pin menus). If the
        // arm has produced no commit for 10 iters, Escape and count it as a
        // failed arm so the lane re-tries or badWorks the row.
        const _armStamp = ctx.memory.menuOpenedAt ?? ctx.memory.expectMenuAt ?? ctx.memory.bulkClickedAt;
        if (ctx.memory.armedLabel && _armStamp != null && iters - _armStamp > 10) {
          const _triesObj = ctx.memory.armTries ||= {};
          const tk = Object.keys(_triesObj).find(x => _sameWork(x, k)) || k;
          const tries = _triesObj[tk] = (_triesObj[tk] || 0) + 1;
          if (tries >= 3) (ctx.memory.badWork ||= new Set()).add(k);
          emit(`bulk delete: arm timeout on "${k.slice(0, 30)}" (tries=${tries}) — Escape`);
          await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
          ctx.memory.lastArmedKey = k;
          ctx.memory.armedLabel = null;
          ctx.memory.delArmTarget = null;
          // Keep menuRect/menuOpenedAt REFRESHED, not cleared — a still-open
          // native menu's items must stay _ocrMenu-flagged so they can't be
          // picked as work rows ("Report..." got armed this way).
          if (ctx.memory.menuRect) ctx.memory.menuOpenedAt = iters;
          ctx.memory.bulkClickedAt = iters;
          ctx.memory.expectMenuAt = null; ctx.memory.delMenuSince = null;
        }
      }

      // ── work registry — Spotify virtualizes: a sidebar row present at
      // iter 0 can vanish from a sparse merged parse 2 iters later. Any
      // library-ish row seen once stays a candidate (by workKey + last
      // center) until done/bad/stale. MUST run before the dlg `continue`
      // below — the flicker itches exactly while panels are up.
      ctx.memory.delSeen ||= new Map();
      // Menu-live iters only ever produce debris — a context menu opens ON
      // TOP of the work column, so nothing observed while armed/menu-live
      // is a trustworthy row sighting.
      const _registryOpen = !ctx.memory.armedLabel && !_menuLiveDel;
      for (const e of els) {
        const l = String(e.label || '').trim();
        if (_registryOpen && l.length > 2 && e.center && _vocab.isWorkRowCandidate(e)
            && _inWorkCol(e) && _rowLabel(e) && !_debris(e) && _voted(e)
            && (!_rowSpan || (e.center[1] >= _rowSpan[0] && e.center[1] <= _rowSpan[1]))
            && e.center[1] > 130 && !_vocab.isNavFurniture(l)
            && !_excluded(l)) {
          const k = _workKey(l);
          const prev = ctx.memory.delSeen.get(k);
          if (!prev || prev.seen < iters) ctx.memory.delSeen.set(k, { label: l, center: e.center, seen: iters });
        }
      }

      // The delete lane OWNS every commit — generic queue picks navigate
      // into rows and churn the surface. Empty it wholesale; lane picks
      // re-add their target below.
      queue = [];
      // Foreign-layer dismiss — a window-layer popup the lane didn't open
      // (dead-space right-clicks, stray native menus) persists on layer 101
      // stealing focus. Escape it after a short persist window; lane-owned
      // layers (owner set by the arm path) are handled by the menu flow.
      // Orphan menu dismiss — a context menu open while UNARMED is one the
      // lane didn't open (stale from a previous run/user). It steals every
      // subsequent click and poisons _freshLabel diffs; Escape it.
      if (!ctx.memory.armedLabel && _menuLiveDel
          && iters - (ctx.memory._orphanMenuEsc ?? -99) >= 2) {
        ctx.memory._orphanMenuEsc = iters;
        emit('bulk delete: menu open while unarmed — Escape');
        await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
        await sleep(250);
        continue;
      }
      if (!ctx.memory.armedLabel && ctx.scene?.layers) {
        for (const [, lyr] of ctx.scene.layers) {
          if (lyr.kind === 'menu' && !lyr.owner && iters - lyr.openedIter > 3
              && iters - (ctx.memory._foreignEscAt ?? -99) >= 2) {
            emit(`bulk delete: foreign overlay ${lyr.src} persisting ${iters - lyr.openedIter} iters — Escape`);
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            ctx.memory._foreignEscAt = iters;
            break;
          }
        }
      }
      // A stale context menu / overlay panel survives as a "dialog" and
      // poisons the parse (native menus are a separate window layer). If
      // nothing is armed: Escape a couple of times, then treat the panel as
      // the furniture it is and proceed with the work-set anyway.
      if (_dlgLive && !ctx.memory.armedLabel) {
        // Unarmed + dialog live — it may be a LATE confirm for a commit the
        // verify pass already closed (or a commit whose row label mutated
        // past workKey matching). If it appeared near a recent arm/commit,
        // confirm it instead of Escaping — Escape cancels the deletion.
        const _recentDel = iters - (ctx.memory.bulkClickedAt ?? -99) <= 20
          || iters - (ctx.memory._lastCommitIter ?? -99) <= 20;
        const _dr = _dlgNow ? _dlgNow.rect
          : _structDlg ? [_structDlg.center[0] - 400, _structDlg.center[1] - 160, 800, 300]
          : _dlgEls.length ? [_dlgEls.reduce((a, e) => Math.min(a, e.center[0]), 1e9) - 40,
                              _dlgEls.reduce((a, e) => Math.min(a, e.center[1]), 1e9) - 40,
                              _dlgEls.reduce((a, e) => Math.max(a, e.center[0]), 0) - _dlgEls.reduce((a2, e) => Math.min(a2, e.center[0]), 1e9) + 80,
                              _dlgEls.reduce((a, e) => Math.max(a, e.center[1]), 0) - _dlgEls.reduce((a2, e) => Math.min(a2, e.center[1]), 1e9) + 80]
          : null;
        // Confirm = an INTERACTIVE confirm-word inside the dialog rect —
        // the actual "Delete"/"Remove" button, not body text like "This
        // will delete the playlist" (no punctuation once OCR truncates).
        const _isConfirmEl = e => e.center
          && e.center[0] >= _dr[0] && e.center[0] <= _dr[0] + _dr[2]
          && e.center[1] >= _dr[1] && e.center[1] <= _dr[1] + _dr[3]
          && _vocab.classifyAction(e.label, 'confirm')
          && !/[.!?…]/.test(String(e.label || '').trim());
        const _ok = (_dr && (_recentDel || _dlgEls.length)
          && (els.find(e => _isConfirmEl(e) && /button|link|menuitem|option/i.test(String(e._role || e.type || '')))
            || els.find(e => _isConfirmEl(e) && String(e.label || '').trim().split(/\s+/).length <= 2)))
          // Last resort: a FRESH confirm-word in the central band after a
          // recent commit — dialog buttons often parse as bare icons/text
          // with no dialog region and no Cancel pair.
          || (_recentDel && els.find(e => _confEl(e)
            && e.center[0] > 380 && e.center[0] < 1300 && e.center[1] > 280 && e.center[1] < 850
            && (!ctx.memory.preArmLabels || _freshLabel(e))));
        if (_ok) {
          emit(`bulk delete: unarmed confirm "${String(_ok.label || '').slice(0, 24)}" @(${Math.round(_ok.center[0])},${Math.round(_ok.center[1])})`);
          await mouseAgent({ action: 'click', x: Math.round(_ok.center[0]), y: Math.round(_ok.center[1]), sessionId }).catch(() => null);
          ctx.memory._lastCommitIter = iters;
          ctx.memory.delDlgStuck = (ctx.memory.delDlgStuck || 0) + 1;
          if (ctx.memory.delDlgStuck > 3) {
            // Confirm clicks aren't landing — don't click body text forever.
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            ctx.memory.delDlgStuck = 0;
          }
          await sleep(400);
          continue;
        }
        // Confirm surface live but no button element — same blind spot the
        // menu probe fixed: crop the screen centre and re-parse accurately.
        if (_recentDel && iters - (ctx.memory._dlgProbeAt ?? -99) >= 2) {
          ctx.memory._dlgProbeAt = iters;
          const found = await _probeRect(
            [Math.max(0, _winW / 2 - 500), Math.max(0, _winH / 2 - 320), 1000, 640],
            { display, windowOnly });
          const hit = found.find(e => _confEl(e));
          if (hit?.center) {
            emit(`bulk delete: dialog probe confirm "${String(hit.label || '').slice(0, 24)}" @(${Math.round(hit.center[0])},${Math.round(hit.center[1])})`);
            await mouseAgent({ action: 'click', x: Math.round(hit.center[0]), y: Math.round(hit.center[1]), sessionId }).catch(() => null);
            ctx.memory._lastCommitIter = iters;
            await sleep(400);
            continue;
          }
          emit(`bulk delete: dialog probe found no confirm (${found.length} items)`);
        }
        ctx.memory.delDlgStuck = (ctx.memory.delDlgStuck || 0) + 1;
        if (ctx.memory.delDlgStuck <= 2) {
          emit('bulk delete: unresolved panel while unarmed — Escape to clear');
          await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
          continue;
        }
        if (ctx.memory.delDlgStuck === 3) emit('bulk delete: panel persists — treating as furniture, proceeding');
      } else if (!_dlgNow) ctx.memory.delDlgStuck = 0;
      // ── confirmation dialogs — "Delete playlist?" confirms on vocab ────
      if (_dlgNow && ctx.memory.armedLabel) {
        const _ok = els.find(e => e.center
          && e.center[0] >= _dlgNow.rect[0] && e.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
          && e.center[1] >= _dlgNow.rect[1] && e.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3]
          && /button|link|menuitem/.test(String(e._role || e.type || ''))
          && _vocab.classifyAction(e.label, 'confirm'));
        if (_ok) queue = [_ok, ...queue.filter(c => c !== _ok)];
      }

      // ── work-set pick — row-ish, not excluded/done/bad, any region ─────
      if (!ctx.memory.armedLabel
          && (ctx.memory.bulkClicks || 0) < 40
          && iters - (ctx.memory.bulkClickedAt ?? -9) > 1) {
        const _rowOk = e => e.center
            && !_debris(e)
            && !_looksLikeInput(e)
            // 'media' veto removed — sidebar playlist rows get mistagged
            // 'media' by region inference; the work-column gate (x≈_colX)
            // already excludes media panels, and the bottom band veto below
            // keeps the now-playing bar out.
            && e._regionRole !== 'panel'
            // now-playing bar / bottom furniture — but a member of the row
            // stack is a row wherever it sits (the last sidebar row abuts
            // the now-playing band).
            && (e.center[1] < _winH - 110 || _inWorkContainer(e))
            && String(e.label || '').trim().length > 2
            && !_excluded(e.label)
            && _inWorkCol(e) && _rowLabel(e)
            && !/^(group|row|list|listitem|region|section|container|generic|content|main|panel|scroll\s*area?|web\s*area|layout)$/i.test(String(e.label || '').trim())
            && !/removed from|added to|undo|copied|saved to/i.test(String(e.label || ''))
            && !(ctx.memory.doneWork && [...ctx.memory.doneWork].some(k => _sameWork(e.label, k)))
            && !(ctx.memory.badWork && [...ctx.memory.badWork].some(k => _sameWork(e.label, k)))
            // App-agnostic admission (action-vocab.cjs): structural row OR
            // list-container member OR substantial label in a non-chrome
            // region. Chrome regions, nav furniture, transport vocab are
            // the module's hard exclusions — no app priors. Container
            // membership OVERRIDES a chrome-region tag: a real row
            // mistagged 'media' by region inference is still a list member —
            // but nav furniture/transport/short labels stay vetoed even
            // inside the rect (Playlists/Artists tabs are members too).
            && (_vocab.isWorkRowCandidate(e)
              || (_inWorkContainer(e) && String(e.label || '').trim().length > 10
                && !_vocab.isNavFurniture(String(e.label || ''))
                && !_vocab.TRANSPORT_VOCAB.test(String(e.label || ''))));
        // Scene-first pick — the container's children in spatial order are
        // the row stack; take the FIRST qualifying child (top-to-bottom).
        // NO flat fallback — a parse without a resolved work container has
        // no trustworthy candidate set; the registry below covers flickers.
        const _delTarget = _workRows ? (_workRows.find(_rowOk) || null) : null;
        // Registry fallback — a row that flickered out of THIS parse still
        // exists on screen; right-click its last position. Excluded rows
        // were never registered; done/bad retire on resolution.
        const _regPick = !_delTarget && [...ctx.memory.delSeen.entries()]
          .filter(([k, v]) => iters - v.seen <= 12 && v.center
            // Untrimmed rects (header-inclusive) would readmit omnibox/
            // bookmark ghosts — a stored point must sit inside the TIGHT
            // rect bounds, not the padded search window.
            && (!_rowSpan || (v.center[1] >= _rowSpan[0] && v.center[1] <= _rowSpan[1]))
            && _rowLabel(v)
            && v.center[1] > 130  // browser-chrome band (omnibox/bookmarks) can never hold a work row
            && !_vocab.isNavFurniture(v.label) && !_vocab.TRANSPORT_VOCAB.test(v.label)
            && !_excluded(v.label)
            // Stored center must not land ON an excluded row — after scroll
            // or reflow a ghost's position can sit inside Quiet Hour's bbox
            // and the arm right-clicks the one row we must never touch.
            && !els.some(o => o.center && _excluded(o.label) && o.bbox
                && v.center[0] >= o.bbox[0] - 8 && v.center[0] <= o.bbox[0] + o.bbox[2] + 8
                && v.center[1] >= o.bbox[1] - 8 && v.center[1] <= o.bbox[1] + o.bbox[3] + 8)
            && !(ctx.memory.doneWork && [...ctx.memory.doneWork].some(d => _sameWork(v.label, d)))
            && !(ctx.memory.badWork && [...ctx.memory.badWork].some(d => _sameWork(v.label, d))))
          .sort((a, b) => b[1].seen - a[1].seen)[0];
        if (_regPick) {
          emit(`bulk delete: registry pick "${String(_regPick[1].label).slice(0, 30)}" (last seen iter ${_regPick[1].seen})`);
        }
        const _delTarget2 = _delTarget || (_regPick && {
          label: _regPick[1].label, center: _regPick[1].center,
          _role: 'button', _regionRole: 'library', _registry: true });
        if (_delTarget2) {
          const _dt = _delTarget2;
          // Count BEFORE arming — dup-label verify compares against this.
          const k = _workKey(_dt.label);
          (ctx.memory.delCounts ||= {})[k] = Math.max(els.filter(e => _workKey(e.label) === k).length, 1);
          _dt._bulkRow = true;
          queue = [_dt, ...queue.filter(c => c !== _dt)];
          if ((ctx.memory.removeChains || 0) === 0 && !ctx.memory.delLaneLogged) {
            ctx.memory.delLaneLogged = true;
            emit(`bulk delete: work-set armed — exclusion set {${[..._exSet].join(', ')}}`);
          }
        } else {
          // Diagnostic — WHY did nothing qualify? (runs every 3 iters)
          if (!ctx.memory.delDiagLogged || iters % 3 === 0) {
            ctx.memory.delDiagLogged = true;
            const _why = e => !e.center ? 'nocenter'
              : _debris(e) ? `debris:${e._role || e.type || '?'}@${e._regionRole || '?'}`
              : _looksLikeInput(e) ? 'input'
              : String(e.label || '').trim().length <= 2 ? 'short'
              : _excluded(e.label) ? 'excluded'
              : (ctx.memory.doneWork && [...ctx.memory.doneWork].some(k => _sameWork(e.label, k))) ? 'doneWork'
              : (ctx.memory.badWork && [...ctx.memory.badWork].some(k => _sameWork(e.label, k))) ? 'badWork'
              : !(e.center[1] < _winH - 110 || _inWorkContainer(e)) ? 'bottomband'
              : !_inWorkCol(e) ? `outofcol@${e._regionRole || '?'}`
              : !_rowLabel(e) ? 'rowlabel'
              : !(_vocab.isWorkRowCandidate(e) || _inWorkContainer(e)) ? `notrowish:${e._role || e.type || '?'}@${e._regionRole || e.region || '?'}`
              : 'OK';
            emit(`bulk delete: no rows — rejects [${els.filter(e => e.center && String(e.label || '').trim().length > 2 && (/playlist|need|liked|all4|hour/i.test(String(e.label || '')) || _why(e) === 'OK')).slice(0, 14).map(e => `${String(e.label || '').slice(0, 24)}→${_why(e)}`).join(' | ')}]`);
          }
          // Termination — no deletable rows left on the surface. A parse
          // that yielded nearly nothing (els < 8) is evidence of a wrong
          // window / lock screen / capture stall — NEVER terminates.
          if (els.length < 8) {
            ctx.memory.delNoRowSince = null;
          } else if (ctx.memory.delNoRowSince == null) {
            ctx.memory.delNoRowSince = iters;
            // One reveal scroll before concluding — lazy rows below the fold.
            await post('/screen/act', { action: 'scroll', x: Math.round(_winW * 0.25), y: Math.round(_winH * 0.5), dx: 0, dy: -300 }).catch(() => null);
            await sleep(500);
          } else if (iters - ctx.memory.delNoRowSince > 5) {
            const _done = ctx.memory.removeChains || 0;
            const _skipped = ctx.memory.badWork ? ctx.memory.badWork.size : 0;
            // Work surface drained — surface queued ambiguities before
            // declaring victory. Each pending row carries its own question;
            // the caller answers via args.answers [{label, decision}].
            if (ctx.memory.delPendingUser?.size) {
              const _pend = [...ctx.memory.delPendingUser.entries()].map(([pk, v]) => ({ label: pk, ...v }));
              return { ok: false, iters, trace, learned, acts, needsUser: {
                question: `${_pend.length} row(s) need a decision (${_done} already deleted, ${_exSet.size ? `{${[..._exSet].join(', ')}} preserved` : 'no exclusions'}).`,
                rows: _pend } };
            }
            return pass(`bulk delete: no deletable rows remain — ${_done} deleted, ${_skipped} skipped${_exSet.size ? `, {${[..._exSet].join(', ')}} preserved` : ''}`, iters, true);
          }
        }
      }
    }
    // Post-pick grace — destination pick committed: hold commits while
    // verification drains (kills the iter-13→16 picker-thrash).
    const _postPick = ctx.memory.pickCommittedAt != null
      && ctx.memory.pendingVerify.length
      && (iters - ctx.memory.pickCommittedAt) <= 2;
    // ── SceneFSM · STAGE PLAYBOOK ────────────────────────────────────────
    // Stage legality is EXHAUSTIVE — a commit outside the stage's set is
    // structurally impossible, not just scored lower.
    //   stage 1 open-library:   expanders only (+ library scroll below)
    //   stage 2 select-container: library-region dest-matches only — feed
    //           cards, panel cards, media-bar items are masked outright.
    //           (After the kind-filtered URL fallback, content matches join.)
    const _navMask = _destLo2 && !_containerOpen && !ctx._searchSeeded
      && !pending.length && !ctx.memory.pendingVerify.length;
    if (_navMask) {
      // VERIFYING — a transition just committed; the legal set is EMPTY
      // while the new scene's identity resolves (URL latch or stable header).
      // Persistent sidebar items can't be re-clicked during scene change.
      if (ctx.memory.verifying != null) {
        if (iters - ctx.memory.verifying > 6) {
          if (ctx.memory.lastTransLabel)
            (ctx.memory.badTrans || (ctx.memory.badTrans = new Set())).add(ctx.memory.lastTransLabel);
          ctx.memory.verifying = null;
          emit(`verifying: scene never resolved — "${ctx.memory.lastTransLabel || ''}" marked dead`);
        } else {
          emit(`verifying: observing new scene (${iters - ctx.memory.verifying}/6) fresh=[${[...(ctx.memory.freshRegions || [])].join(',')}]`);
          await sleep(500);
          continue;
        }
      }
      const _trans = els.filter(e => e.center && !_menuishEl(e)
        && e._regionRole !== 'dialog' && e._regionRole !== 'media' && e._regionRole !== 'panel'
        && !/^(play|shuffle|pause)\b/i.test(String(e.label || '').trim())
        && String(e.label || '').toLowerCase().includes(_destLo2));
      const _contWords = /playlist|folder|album|board|collection|list|channel|space|project/i;
      const _clickRole = /link|listitem|row|button|menuitem|cell|tab/i;
      const _tScore = e => {
        const l = String(e.label || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        return (l === _destLo2 ? 8 : l.startsWith(_destLo2) ? 4 : 1)
          + (_destKind && String(e.label || '').toLowerCase().includes(_destKind) ? 9 : 0)
          + (e._regionRole === 'library' || e._regionRole === 'rail' ? 10 : 0)
          + (_contWords.test(e.label || '') ? 2 : 0)
          + (_clickRole.test(String(e._role || e.type || '')) ? 1 : 0)
          - (ctx.memory.badTrans && ctx.memory.badTrans.has(e.label) ? 100 : 0);
      };
      _trans.sort((a, b) => _tScore(b) - _tScore(a));
      const _liveTrans = _trans.filter(e => !ctx.memory.badTrans || !ctx.memory.badTrans.has(e.label));
      const _libTrans = _liveTrans.filter(e => e._regionRole === 'library' || e._regionRole === 'rail');
      _expanders.forEach(e => { e._cls = 'explore'; });
      const _libRows = _libEls.filter(e => String(e.label || '').trim().length > 2).length;
      // Stage 1 exit: the library has been opened (expander tried) or
      // scrolled to its end — either way "checked my library" is done.
      const _libProbed = ctx.memory.triedExpanders.size > 0 || (ctx.memory.destScrolls || 0) >= 4;
      const _stage = _libProbed || _libTrans.length || ctx._containerSearch ? 2 : 1;
      ctx.memory.stage = _stage;
      if (_stage === 1) {
        queue = [..._expanders];
        // No expanders → the library-scroll block below drives the probe.
      } else {
        const _allowed = ctx._containerSearch ? _liveTrans : _libTrans;
        _allowed.forEach(e => { e._cls = 'transition'; });
        queue = [..._allowed, ..._expanders, ...queue.filter(e => _menuishEl(e))];
      }
      if ((iters % 4) === 0 || _stage === 1)
        emit(`stage ${_stage}: expanders=${_expanders.length} libTrans=${_libTrans.length} trans=${_liveTrans.length} libRows=${_libRows} scrolls=${ctx.memory.destScrolls || 0} rail=${_railEls.length}/${_railLabeled.length}${_railCollapsed ? 'COLLAPSED' : ''} tried=${ctx.memory.triedExpanders.size} q=${queue.length} x<100=[${els.filter(e => e.center && e.center[0] < 100).slice(0, 8).map(e => `${e._regionRole}:${e.region || ''}:${String(e.label || '').slice(0, 10)}`).join(' | ')}]`);
      // Dead end — the destination isn't a library member. Escape hatch in
      // human order: (a) kind-filtered search URL ("/search/{q}/playlists"
      // removes decoys at the source), then (b) the app's main search field.
      if (_stage === 2 && !queue.length && (ctx.memory.destScrolls || 0) >= 6) {
        if (!ctx.memory.destUrlTried) {
          ctx.memory.destUrlTried = true;
          const host = String(_domObs?.domain || ctx.scene?.domain || '')
            .replace(/^https?:\/\//, '').split('/')[0];
          const url = host && _searchUrlFor(host, ctx.destination, _destKind);
          if (url) {
            emit(`fallback: kind-search URL → "${ctx.destination}" (${url})`);
            const browser = ctx.browserName || 'Google Chrome';
            let navOk = await new Promise(r => execFile('osascript',
              ['-e', `tell application "${browser}" to open location "${url}"`],
              (e) => r(!e)));
            if (!navOk) navOk = await new Promise(r =>
              execFile('open', [url], (e) => r(!e)));
            if (navOk) {
              ctx._containerSearch = ctx.destination; // results-settle owns the wait
              await sleep(1200); continue;
            }
          }
        }
        if ((ctx.memory.destSearch || 0) < 2) {
          const _sfs = els.filter(e => e.center && !ctx.memory.typed.has(ctx.destination)
            && e._regionRole !== 'media' && e._regionRole !== 'dialog'
            && (/textfield|searchfield|combobox/.test(String(e._role || ''))
              || (_looksLikeInput(e) && e.center[1] < _winH * 0.3)
              // Search-bar affordance — a wide, query-ish element in the top
              // strip ("What do you want to play?") that OCR emits as icon.
              || (e.bbox && e.bbox[2] > 240 && e.center[1] < _winH * 0.25
                && /search|find|what|play|look|browse/i.test(String(e.label || '')))));
          _sfs.sort((a, b) => (/search|find|play|look|what/i.test(b.label || '') ? 1 : 0)
            - (/search|find|play|look|what/i.test(a.label || '') ? 1 : 0));
          const sf = _sfs[0];
          if (sf) { sf._cls = 'explore'; sf._destType = true; queue = [sf]; }
        }
        if (!queue.length)
          return fail(`scene: destination "${ctx.destination}" unreachable — no rows, expanders, or search field`, iters);
      }
    }
    // ── SceneFSM · stages 3/4 (IN-CONTAINER, bulk) ──────────────────────
    // stage 3 arm-remove:    top content row (right-click) is the only legal
    //                        commit — exit-verify: a menu container appears.
    // stage 4 commit-remove: menu open → ONLY remove-labeled items commit.
    if (_containerOpen && ctx.memory.bulk === 'remove') {
      // Guarded menu test — `listbox` stays out of the stage-4 trigger: a
      // tracklist is a list-ish container and must not pin the stage. Real
      // menus still flag via roles, _inOpenMenu, or the set-diff _ocrMenu.
      const _menuNow = els.some(e => e._inOpenMenu || e._ocrMenu
        || /menuitem|option/.test(String(e._role || ''))
        || /menu|popover/.test(String(e._containerRole || '')));
      const _menuOpen = _menuNow
        || (ctx.memory.expectMenuAt != null && iters - ctx.memory.expectMenuAt <= 4);
      if (_menuOpen) {
        ctx.memory.stage = 4;
        if (_menuNow && ctx.memory.menuOpenedAt == null) ctx.memory.menuOpenedAt = iters;
        // REPLAY — a verified removal recorded (armPoint → commitOffset).
        // The menu anchors at the arm point, so the remove item lands at the
        // same offset for identical rows. Commit by coordinate, verify by
        // outcome — skips the multi-iter OCR wait for the remove label.
        if (ctx.memory.sigArmed && ctx.memory.removeSig?.commitOffset
            && _menuNow && iters - (ctx.memory.sigArmIter || 0) >= 1) {
          const off = ctx.memory.removeSig.commitOffset;
          const pt = [Math.round(ctx.memory.sigArmPoint[0] + off[0]),
                      Math.round(ctx.memory.sigArmPoint[1] + off[1])];
          const near = els.filter(e => e.center
            && Math.abs(e.center[0] - pt[0]) <= 24 && Math.abs(e.center[1] - pt[1]) <= 14);
          const bad = near.find(e => { const l = String(e.label || '');
            return l.trim() && !/remove|delete|clear|trash/i.test(l)
              && /add to|save to|share|queue|radio|open|go to|playlist|artist|album|library|copy|view|report|like|follow/i.test(l); });
          if (bad) {
            // Offset lands on a non-remove action — geometry drifted (menu
            // relaid out for this row); strike the sig and let derive run.
            ctx.memory.sigFails = (ctx.memory.sigFails || 0) + 1;
            ctx.memory.sigArmed = null;
            emit(`replay: sig offset lands on "${String(bad.label).slice(0, 30)}" — derive instead (fails=${ctx.memory.sigFails})`);
          } else {
            emit(`replay: committing at sig offset (${pt[0]},${pt[1]})`);
            await mouseAgent({ action: 'click', x: pt[0], y: pt[1], sessionId }).catch(() => null);
            ctx.memory.removeCommitted = iters;
            ctx.memory._lastCommitIter = iters;
            ctx.memory.sigCommitted = iters;
            ctx.memory.sigArmed = null;
            acts.push(`(replay click @${pt[0]},${pt[1]})`);
            await sleep(500);
            continue;
          }
        }
        queue = els.filter(e => _menuishEl(e)
          && (_vocab.classifyAction(e.label, 'delete') || /select all/i.test(String(e.label || ''))
              // Container-toggle route — ONLY after the menu route proved
              // dead for the armed item (route-B flyout like "Add to
              // playlist"): there the destination row is a checked toggle.
              // In any OTHER menu the same-named row is an ADD action —
              // clicking it re-adds the song (anti-goal).
              || (_destLo2 && ctx.memory.menuDead && ctx.memory.menuDead.has(ctx.memory.lastArmedKey)
                && String(e.label || '').toLowerCase().includes(_destLo2)))
          && !/removed from|added to|undo|save to|add to/i.test(String(e.label || '')));
        // Browser-chrome instant verdict — a right-click on page furniture
        // (promo cards, footer links) opens the BROWSER context menu, not an
        // app menu. ≥2 chrome items is a certain furniture signal: badWork
        // the armed item immediately instead of burning the stability wait
        // and occlusion cap on it. Native-app menus never match this vocab —
        // they still die through the graded chain below.
        {
          const _chromeHits = els.filter(e => _menuishEl(e)
            && /\bback\b|\bforward\b|reload|save as|print|inspect element|view page source|open in new tab|read aloud|translate to|copy link address/i.test(String(e.label || ''))).length;
          if (_chromeHits >= 2 && ctx.memory.lastArmedKey) {
            emit(`menu: browser context menu — armed item is furniture, badWork "${String(ctx.memory.armedLabel || ctx.memory.lastArmedKey).slice(0, 30)}"`);
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            (ctx.memory.badWork ||= new Set()).add(ctx.memory.lastArmedKey);
            ctx.memory.armedLabel = null;
            ctx.memory.lastArmedKey = null;
            ctx.memory.preArmLabels = null;
            ctx.memory.menuRect = null;
            ctx.memory.menuRectLabels = null;
            ctx.memory.menuOpenedAt = null;
            ctx.memory.bulkClickedAt = null;
            ctx.memory.expectMenuAt = null;
            ctx.memory.noRemoveSince = null;
            ctx.memory.menuLabelSet = null;
            ctx.memory.sigArmed = null;
            await sleep(400);
            continue;
          }
        }
        // A menu whose label-set is STABLE and still shows no remove item
        // isn't the armed row's removal menu — dismiss it and mark the menu
        // route dead for the armed item: the in-row affordance route takes
        // over on the next arm. Stability matters because menu items OCR
        // late (observed at +5–8 iters); a hard ceiling bounds the wait.
        if (!queue.length) {
          const _menuKeys = els.filter(e => _menuishEl(e))
            .map(e => _workKey(e.label)).filter(Boolean).sort().join('|');
          if (ctx.memory.noRemoveSince == null || _menuKeys !== ctx.memory.menuLabelSet) {
            ctx.memory.menuLabelSet = _menuKeys;
            ctx.memory.noRemoveSince = iters;
          }
          // "No remove item" is only judgeable once a surface was actually
          // SEEN — an empty label set is trivially stable the iter after
          // the right-click, before the menu has rendered.
          const _stale = ctx.memory.menuOpenedAt != null && iters - ctx.memory.noRemoveSince >= 3;
          const _ceiling = ctx.memory.menuOpenedAt != null && iters - ctx.memory.menuOpenedAt >= 9;
          if (_stale || _ceiling) {
            emit(`menu: no remove item (label-set ${_stale ? 'stable' : 'ceiling'}) — dismissing, menu route dead for item`);
            await keyboardAgent({ key: 'escape', sessionId }).catch(() => null);
            if (ctx.memory.lastArmedKey)
              (ctx.memory.menuDead ||= new Set()).add(ctx.memory.lastArmedKey);
            ctx.memory.noRemoveSince = null;
            ctx.memory.menuLabelSet = null;
            ctx.memory.menuOpenedAt = null;
            ctx.memory.menuRect = null;
            ctx.memory.menuRectLabels = null;
            ctx.memory.sigArmed = null;
            await sleep(400);
            continue;
          }
        } else {
          ctx.memory.noRemoveSince = null;
          ctx.memory.menuLabelSet = null;
        }
      } else {
        ctx.memory.stage = 3;
        queue = queue.filter(e => e._bulkRow || _menuishEl(e)
          || /remove|delete|clear|select all/i.test(String(e.label || '')));
      }
      // Media/footer never participates in the container's work-set —
      // probing the now-playing bar ("DNA. DAMN. 0:00") is pure waste.
      queue = queue.filter(e => e._regionRole !== 'media');
      // Work-set dry → observe only. An empty stage-3/4 queue is the
      // container draining (or drained); wandering into recommended rows
      // or persistent chrome must not produce probes or commits — the
      // empty verdict upstream decides completion.
      if (!queue.length) { await sleep(500); continue; }
      if ((iters % 4) === 0)
        emit(`stage ${ctx.memory.stage}: bulkRow=${!!_bulkTarget} menuOpen=${!!_menuOpen} queue=${queue.length}`
          + (_bulkTarget ? ` pick="${String(_bulkTarget.label || '').slice(0, 40)}"@${Math.round(_bulkTarget.center[0])},${Math.round(_bulkTarget.center[1])} type=${_bulkTarget._role || _bulkTarget.type}` : ''));
    }
    // Destination-scope mask — while an entity awaits its commit, the ONLY
    // legal candidates advance that commit: fields (entity still untyped),
    // entity-bearing rows (the commit surface), open-menu/picker contents
    // (the destination pick), and add-ish elements passing the object check.
    // Playback/rail/unlabeled junk is excluded from the queue, not scored
    // down — score floors are advisory, exclusion is law. Same pattern as
    // the bulk stage masks; goal+state derived, no app vocabulary.
    if (ctx.destination && ctx.memory.pendingVerify.length && ctx.memory.bulk !== 'remove' && queue.length > 1) {
      const _qBefore = queue.length;
      queue = queue.filter(e =>
        _looksLikeInput(e) || e._role === 'field'
        || _menuishEl(e)
        || (_dlgNow && e.center
          && e.center[0] >= _dlgNow.rect[0] - 4 && e.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2] + 4
          && e.center[1] >= _dlgNow.rect[1] - 4 && e.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3] + 4)
        || (_entityTerms.some(t => String(e.label || '').toLowerCase().includes(t))
          && e._regionRole !== 'media' && e._regionRole !== 'rail' && e._regionRole !== 'library'
          // Nav-churn throttle — after two surface-changing navigations the
          // entity's container cards stop being legal (work rows stay legal —
          // they're the commit surface, not a detour).
          && ((ctx.memory.navs || 0) < 2 || _isWorkRow(e)))
        || (/\badd\b|\+|plus|more|options|…|⋯|\.\.\.|•••/i.test(String(e.label || ''))
          && e._regionRole !== 'media' && e._regionRole !== 'rail' && e._regionRole !== 'library'
          && _evidenceFit(e.label, g, ctx, e._role || e.tag) !== 'wrong-object'));
      if (queue.length !== _qBefore)
        emit(`dest-mask: ${_qBefore}→${queue.length} legal (entity outstanding)`);
    }
    // Semantic scene zoom — a live dialog/menu surface IS the current
    // scene: its members order first (advisory sort — hard exclusion lives
    // in the destPickPending gate). Generalizes the _dlgNow pattern.
    if (_dlgNow && queue.length > 2) {
      const _inD = e => _menuishEl(e) || (e.center
        && e.center[0] >= _dlgNow.rect[0] - 4 && e.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2] + 4
        && e.center[1] >= _dlgNow.rect[1] - 4 && e.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3] + 4);
      queue = [...queue.filter(_inD), ...queue.filter(e => !_inD(e))];
    }
    // Acquire with no search affordance on-screen is a wrong phase, not a
    // long wait — flip to act now instead of burning the 4-iter budget.
    if (ctx.phase === 'acquire' && !_searchFields.length
        && !queue.some(e => /button|tab|link/.test(String(e._role || e.type || ''))
          && /\bsearch\b|\bfind\b/i.test(String(e.label || '')))) {
      ctx.memory.acquired = iters; ctx.phase = 'act';
      emit('phase: act (no search affordance on-screen)');
    }

    // Scroll-for-entity: an entity was typed and awaits verification but no
    // visible row carries its terms — its matches are below the fold. Scroll
    // inside the active region (dialog first); revealed rows arrive _isNew.
    if (ctx.memory.pendingVerify.length && (ctx.memory.scrolls || 0) < 4 && !_dlg) {
      const _visible = queue.some(e => e._role !== 'field' && !_looksLikeInput(e)
        && _entityTerms.some(t => String(e.label || '').toLowerCase().includes(t)));
      if (!_visible && _entityTerms.length) {
        const sx = _dlg ? _dlg.rect[0] + _dlg.rect[2] / 2 : (parsed.size_px ? _pxW(parsed) / 2 : 700);
        const sy = _dlg ? _dlg.rect[1] + _dlg.rect[3] / 2 : (parsed.size_px ? _pxH(parsed) / 2 : 400);
        await post('/screen/act', { action: 'scroll', x: sx, y: sy, dx: 0, dy: -400 }).catch(() => null);
        ctx.memory.scrolls = (ctx.memory.scrolls || 0) + 1;
        acts.push(`(scrolled ${_dlg ? 'dialog' : 'content'} for "${_entityTerms[0]}")`);
        await sleep(600); continue;
      }
    }
    // Results-settle — a container-search URL was opened; the destination
    // arrives as results render. Wait and re-observe instead of scrolling.
    if (ctx._containerSearch && !ctx.memory.containerOpenedAt
        && !els.some(e => e.center && String(e.label || '').toLowerCase().includes(_destLo2))
        && (ctx.memory.settleN || 0) < 8) {
      ctx.memory.settleN = (ctx.memory.settleN || 0) + 1;
      emit(`results: waiting for "${ctx.destination}" to render (${ctx.memory.settleN}/8)`);
      await sleep(1400); continue;
    }
    // Scroll-for-container — destination set but its page isn't open and no
    // visible element matches it: the container lives in a sidebar/library
    // region below the fold. Scroll THAT region (left column), not the page.
    if (_destLo2 && !_containerOpen && !ctx._containerSearch
        && (ctx.memory.destScrolls || 0) < 6
        && !(_railCollapsed && _expanders.length)
        && !queue.length) {
      const sy = parsed.size_px ? _pxH(parsed) / 2 : 400;
      await post('/screen/act', { action: 'scroll', x: _libX, y: sy, dx: 0, dy: -400 }).catch(() => null);
      ctx.memory.destScrolls = (ctx.memory.destScrolls || 0) + 1;
      acts.push(`(scrolled sidebar for "${ctx.destination}")`);
      emit(`scroll: sidebar looking for "${ctx.destination}" (${ctx.memory.destScrolls}/6)`);
      await sleep(600); continue;
    } else if (_destLo2 && !ctx.memory.containerOpenedAt) {
      emit(`nav-diag: state=${_navMask ? 'NAVIGATE' : _containerOpen ? 'IN-CONTAINER' : 'FREE'} dest="${ctx.destination}" containerOpen=${!!_containerOpen} dlg=${!!_dlgNow} rail=${_railCollapsed ? 'collapsed' : 'open'} expanders=${_expanders.length} destVisible=${els.some(e => e.center && String(e.label || '').toLowerCase().includes(_destLo2))} scrolls=${ctx.memory.destScrolls || 0} els=${els.length} src=${_domObs?.src || 'ocr'} sample=[${els.filter(e => String(e.label || '').trim()).slice(0, 6).map(e => String(e.label).slice(0, 18)).join(' | ')}]`);
    }
    // Composite layout — the model needs the WHOLE screen, not just the
    // dialog's internals: the destination ("Quiet Hour" in the sidebar),
    // rows above the modal rect, panels, and media all vanish when the
    // sketch is exclusive. Tree first, dialog detail appended as a block.
    const _treeLayout = ctx.scene?.tree
      ? _sg.serialize(ctx.scene.tree, { maxLines: 44, cursor: ctx.scene.cursor }) : '';
    const _dlgSketch = _dlgNow ? _dialogSketch(els, _dlgNow) : '';
    // Boundary map is the model's orientation — the full element tree stays
    // on scene.tree for humans; 44 lines of flat elements is noise as model
    // input. Region map + dialog detail is the right granularity.
    const _sceneUrl = String(ctx.memory.winState?.url || _domObs?.url || _domObs?.domain || '');
    const _bmap = ctx.scene?.tree
      ? _sg.serializeRegions(ctx.scene.tree, { url: _sceneUrl, cursor: ctx.scene.cursor }) : '';
    const _dbgLayout = _dlgSketch ? (_bmap ? `${_bmap}\n${_dlgSketch}` : _dlgSketch) : _bmap;
    const _dbgExtra = `Pick ONE element for the NEXT micro-action only — not the whole plan. ` +
      (ctx.phase === 'acquire' && pending[0] ? `PHASE: acquire — locate "${pending[0]}" via a search/catalog field; ignore rows, nav, playback. ` : '') +
      (opts.subGoal ? `${opts.subGoal} ` : '') +
      `Already did: ${recent || 'nothing yet'}.`;
    // Debug seam — /screen.scene + /screen.debug.* package the live decision
    // context (scene, masked queue, verbatim model payload) and return
    // without asking or committing; a caller-forced micro-action fires in
    // place of the proposal so a human can drive the walk action-by-action.
    if ((opts.debugOnce || opts.forceAction || opts.commitStep) && !(opts.commitStep && iters === 0)) {
      const _pp = _pickPayload(queue, g, { extraNote: _dbgExtra, layout: _dbgLayout });
      const _qset = new Set(queue);
      // Full coverage — every queue member appears with provenance; masked
      // = scored out of the legal set entirely.
      const _allDbg = [...new Set([..._searchFields, ..._dlgFields, ..._panelFields, ...cands, ...tail])];
      const _grp = e => _searchSet.has(e) ? 'field:search' : _dlgFields.includes(e) ? 'field:dlg'
        : _panelFields.includes(e) ? 'field:panel' : _inCands.has(e.id) ? 'shortlist' : 'tail';
      const _rc = {};
      for (const e of els) {
        const r = e._regionRole || 'unscored';
        if (!_rc[r]) _rc[r] = { count: 0, samples: [], rect: null };
        const g = _rc[r]; g.count++;
        if (g.samples.length < 4 && String(e.label || '').trim()) g.samples.push(String(e.label).trim().slice(0, 24));
        if (e.bbox) g.rect = g.rect
          ? [Math.min(g.rect[0], e.bbox[0]), Math.min(g.rect[1], e.bbox[1]),
             Math.max(g.rect[0] + g.rect[2], e.bbox[0] + e.bbox[2]) - Math.min(g.rect[0], e.bbox[0]),
             Math.max(g.rect[1] + g.rect[3], e.bbox[1] + e.bbox[3]) - Math.min(g.rect[1], e.bbox[1])]
          : [...e.bbox];
      }
      const _fa = parsed.front_app || null;
      // Keep the window frame's element list fresh so stack resolution can
      // hit window-scope ids from the seam too.
      if (opts.dbgRun?.viewStack?.length) {
        const _st = opts.dbgRun.viewStack;
        if (_st[_st.length - 1].scope === 'window') _st[_st.length - 1].els = els;
      }
      const _foreign = (ctx._dbgApp && _fa && !_fa.toLowerCase().includes(ctx._dbgApp.toLowerCase())) ? _fa : null;
      const _pack = (extra = {}) => ({ ok: true, debug: true, iters, goal: g, ...extra,
        ...(_foreign ? { foreignApp: _foreign } : {}),
        view: { scope: 'window', depth: 0, changed: _foreign ? 'app' : null },
        scene: { layout: _dbgLayout, tree: _treeLayout, url: _sceneUrl || null,
          dialog: _dlgNow ? { rect: _dlgNow.rect } : null,
          frontApp: _fa, elements: els.length,
          regions: _rc, window: [_pxW(parsed), _pxH(parsed)] },
        candidates: _allDbg.map(e => ({ line: describe(e), score: e._score ?? null, group: _grp(e),
          verdict: _qset.has(e) ? `queued:${queue.indexOf(e)}` : 'masked' })),
        queue: queue.map(e => describe(e)),
        modelPayload: { state: _pp.state, questions: _pp.questions },
        proposal: queue[0] ? describe(queue[0]) : null,
        memory: { pendingVerify: [...(ctx.memory.pendingVerify || [])],
          destPickPending: ctx.memory.destPickPending ?? null,
          navs: ctx.memory.navs || 0, phase: ctx.phase || null,
          destination: ctx.destination || null, stage: ctx.memory.stage ?? null,
          frontApp: _fa, url: _sceneUrl || null },
        acts });
      if (opts.forceAction) {
        const fa = opts.forceAction;
        const el = _dbgFindEl(opts.dbgRun || {}, fa.target ?? fa.id)
          || [...queue, ...cands].find(e => String(e.id) === String(fa.target ?? fa.id));
        let done = `no target ${fa.target}`;
        try {
          if (fa.action === 'right-click' && el) {
            await mouseAgent({ action: 'right-click', x: Math.round(el.center[0]), y: Math.round(el.center[1]), sessionId });
            ctx.memory.expectMenuAt = iters;
            ctx.memory.expectAfford = { row: _fpLoose(el), at: iters, pv: ctx.memory.pendingVerify.length };
            done = `right-click ${describe(el)}`;
          } else if (fa.action === 'click' && (el || (fa.x != null && fa.y != null))) {
            const _cx = el ? Math.round(el.center[0]) : Math.round(+fa.x);
            const _cy = el ? Math.round(el.center[1]) : Math.round(+fa.y);
            await mouseAgent({ action: 'click', x: _cx, y: _cy, sessionId });
            done = `click ${el ? describe(el) : `(${_cx},${_cy})`}`;
          } else if (fa.action === 'move' && el) {
            await mouseAgent({ action: 'move', x: Math.round(el.center[0]), y: Math.round(el.center[1]), sessionId });
            done = `move ${describe(el)}`;
          } else if (fa.action === 'key') {
            await keyboardAgent({ key: fa.key, mods: fa.mods, sessionId });
            done = `key ${fa.key}`;
          } else if (fa.action === 'type') {
            await keyboardAgent({ action: 'type', text: fa.text, sessionId });
            done = `type ${String(fa.text).length}ch`;
          } else if (fa.action === 'scroll') {
            await post('/screen/act', { action: 'scroll', x: fa.x || Math.round(_pxW(parsed) / 2), y: fa.y || Math.round(_pxH(parsed) / 2), dx: fa.dx || 0, dy: fa.dy ?? -400 }).catch(() => null);
            done = `scroll ${fa.dy ?? -400}`;
          }
        } catch (e) { done = `force failed: ${e.message}`; }
        acts.push(`(debug force: ${done})`);
        return _pack({ forced: done });
      }
      return _pack();
    }
    // Gated glyph classify — shortlisted unlabeled controls (a row's trailing
    // icon that OCR couldn't name) get ONE bounded vision question. Priors
    // only: the answer tags _afford for scoring; commit→delta still verifies.
    if (opts.glyphVision !== false && decisionEnabled()) {
      const _unl = queue.filter(e => e._afford === 'ctl' && !String(e.label || '').trim()).slice(0, 5);
      if (_unl.length) {
        const _gc = ctx.memory._glyphs = ctx.memory._glyphs || new Map();
        const _AFF_OPTS = ['open detail / navigate deeper', 'add / save this row item',
          'open a menu of more options', 'dismiss / close', 'download / acquire',
          'play', 'like / favorite', 'other / unclear'];
        const _AFF_MAP = ['goto', 'add', 'menu', 'dismiss', 'acquire', 'play', 'like', 'ctl'];
        for (const e of _unl) {
          const _gk = _fpLoose(e);
          if (_gc.has(_gk)) { e._afford = _gc.get(_gk); continue; }
          const _rp = await rectParse(cropRectFor(e, 20), { display, windowOnly, wantImage: true }).catch(() => null);
          const _img = _rp?.image || _rp?.image_b64 || null;
          if (!_img) { _gc.set(_gk, 'ctl'); continue; }
          const _v = await askDecision([{ id: 'glyph', type: 'choice',
            question: 'This is a crop of an unlabeled icon at the edge of a list row. What does activating it most likely do?',
            options: _AFF_OPTS }], { image: _img, timeoutMs: 12000 }).catch(() => null);
          const _aff = _AFF_MAP[_v?.answers?.glyph?.index ?? 7] || 'ctl';
          _gc.set(_gk, _aff); e._afford = _aff;
        }
      }
    }
    // Model ranks the legal set — cands includes masked elements whose pick
    // would re-enter the queue below; queue is the masked walk order.
    const pick = await modelPick(queue, g, {
      extraNote: _dbgExtra,
      layout: _dbgLayout,
    });
    if (pick?.done) {
      if (checkStr) {
        // 'done' is a claim, not evidence — confirm the derived check fresh.
        const vp = await post('/screen/parse', { display, windowOnly }).catch(() => null);
        const vpEls = vp?.elements || [];
        const hitEl = vpEls.find(e => matchElements([e], checkStr).length);
        const _allDone = !pending.length && !ctx.memory.pendingVerify.length;
        const hit = hitEl && _hitContained(vpEls, hitEl) && !_fieldContentHit(vpEls, hitEl) && !_isTypedField(ctx.memory, hitEl) &&
          !vpEls.some(e => /^\s*(save|cancel|discard|ok|done|close)\s*$/i.test(String(e.label || '')));
        if (hit && _allDone) {
          trace.push({ step: outerIdx, iter: iters, action: 'verify', verified: true, pickPath: 'auto-done+check', ok: true });
          learned.push({ action: 'verify', check: checkStr, waitMatchMs: 8000, why: 'auto-final' });
          emit(trace[trace.length - 1]);
          return pass(`auto: done + "${checkStr}" observed (${iters} iters)`, iters, true);
        }
        acts.push(`(model said done — "${checkStr}" ${hit ? 'contained but entities remain' : 'not visible'})`);
      } else if (iters > 0) {
        // Model claims done — pending entities pass only if already
        // contained on screen (added via row-click without typing).
        const unfulfilled = pending.filter(t => !matchElements(els, t).some(h => h.center && _hitContained(els, h)));
        if (unfulfilled.length) acts.push(`(model done — ${unfulfilled.length} entities not yet contained)`);
        else if (ctx.memory.bulk === 'delete') acts.push('(model done — bulk-delete lane owns termination, continuing)');
        else return pass(`auto: model done after ${iters} iters`, iters, null);
      } else {
        acts.push('(model said done before acting)');
      }
    } else if (pick?.element) {
      queue = [pick.element, ...queue.filter(c => c !== pick.element)];
    } else {
      // Model down/none: structural order stands — the walk works without it.
      const why = pick?.none ? 'model: nothing relevant' : 'model unavailable';
      acts.push(`(${why} — walking structural order)`);
      emit(`pick: ${why}${pick?.error ? ` (${pick.error})` : ''} — walking structural order`);
    }

    // ── walk the queue ───────────────────────────────────────────────────
    let committed = false;
    let probesThisIter = 0;
    for (const el of queue) {
      if (_postPick) { acts.push('(post-pick: holding for verify)'); break; }
      if (!el?.center) { if (el?._bulkRow) emit('bulkRow skip: no center'); continue; }
      const elLoose = _fpLoose(el);
      // Committed-set: don't re-click the same element unless it re-rendered
      // as new (dialog reopened = fresh state). Kills alternate-click loops.
      // _bulkRow is exempt — its fpLoose is position+role only, and rows
      // shift into the vacated slot after each removal; work-set identity
      // lives in doneWork/badWork (work-key), not the generic click set.
      if (!el._bulkRow && ctx.memory.committed.has(elLoose) && !el._isNew) continue;
      if (elLoose === lastId && ++sameCount >= 2) {
        excludeIds.add(elLoose); lastId = null;
        acts.push('(repeat pick excluded)'); continue;
      }
      lastId = elLoose; sameCount = 0;

      // Pending-until-verified: an entity typed earlier stays alive for
      // re-typing into a NEW field (dialog reopened) and keeps scoring row
      // labels until containment confirms it.
      // A field inside a foreign dialog (Edit details, wrong modal) can't be a
      // type target — the entity text would corrupt unrelated app state.
      const _inForeignDlg = !el._bulkRow && el.center && (
        (_foreignTrap && _dlgNow &&
          el.center[0] >= _dlgNow.rect[0] && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2] &&
          el.center[1] >= _dlgNow.rect[1] && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3])
        || (ctx.memory.dlgForeignRects || []).some(r =>
          el.center[0] >= r[0] && el.center[0] <= r[0] + r[2] &&
          el.center[1] >= r[1] && el.center[1] <= r[1] + r[3]));
      // Tree-native foreign check — a FIELD whose container path carries no
      // goal vocabulary is foreign by construction ("Add a name" under
      // "Edit details" shares nothing with "add Lecrae to playlist"). Works
      // even when detectDialog/escape-budget misses the dialog entirely.
      const _containerForeign = (() => {
        if (el._role !== 'field' && el.type !== 'text') return false;
        const cp = String(el._containerPath || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
        // Suspicious dialog vocabulary — data-testids like
        // "playlist-edit-details-modal" must trip on 'details', not pass on
        // 'playlist'. Generic nouns can't rescue it either — and the
        // suspicious words themselves COUNT as identity (stripping them
        // made this path vacuous).
        if (!/edit|details|settings|preferences|share|invite|delete|rename|profile|account|privacy|terms|help|about|upgrade|premium|download|install|make private|choose photo/i.test(cp)) return false;
        const GENERIC = new Set(['add','to','my','the','and','for','playlist','folder','album','board','list','collection','project','channel','space','song','songs','item','items','file','files','create','new','open','your']);
        const gWords = new Set(String(g || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !GENERIC.has(w)));
        const words = cp.split(/\s+/).filter(w => w.length > 3 && !GENERIC.has(w));
        return words.length > 0 && !words.some(w => gWords.has(w));
      })();
      const _blockedField = _inForeignDlg || _containerForeign;
      // A field trapped in a foreign dialog is not just un-typeable — it's
      // not a candidate at all. Clicking it (focus) or typing it corrupts
      // unrelated app state.
      if (_blockedField) {
        excludeIds.add(elLoose);
        if (_containerForeign && !_inForeignDlg)
          acts.push(`(infer: foreign dialog field "${String(el.label || '').slice(0,30)}" @${String(el._containerPath || '').slice(0,40)})`);
        continue;
      }
      // Scope routing — the scene tree says WHAT a field accepts. A
      // pick:destination field ("Find a playlist" inside an Add-to-playlist
      // menu) takes the destination payload and REJECTS entity text by
      // definition ("Lecrae" typed there yields "No results found").
      const _scopeBlocksEntity = el._scope === 'pick:destination';
      // Acquire phase: entity text ONLY goes into a search-scope field —
      // a neutral field during acquire is a trap (it would deposit the
      // entity where nothing searches it).
      const _entityForField = (_blockedField || _scopeBlocksEntity) ? null
        : (ctx.phase === 'acquire' && !/search:entity|global/.test(String(el._scope || ''))) ? null
        : pending.length ? pending[0]
        : ctx.memory.pendingVerify.find(t =>
            // A URL-seeded entity is already located via the GLOBAL search —
            // never re-type it into a global-scope box. But an in-container
            // search:entity field (the playlist's own "Search for songs")
            // needs the entity typed fresh — it was seeded into a different
            // surface.
            !(ctx._searchSeeded && String(t).toLowerCase().includes(String(ctx._searchSeeded).toLowerCase())
              && String(el._scope || '') !== 'search:entity')
            // Destination terms are picker payloads — never entity text for
            // global/search fields ("Quiet Hour" into the main search box
            // searches it instead of picking it).
            && !(ctx.destination && String(t).toLowerCase() === String(ctx.destination).toLowerCase())
            && ctx.memory.typed.get(t) !== elLoose);
      const _destForField = !_blockedField && _scopeBlocksEntity && ctx.destination && !ctx.memory.bulk
        && (ctx.memory.destTypes || 0) < 3 && ctx.memory.destPickPending == null
          ? ctx.destination : null;
      const intent = ((el._destType && ctx.destination) || ((_entityForField || _destForField) && roleAllowsType(el, g))) ? 'type' : 'click';
      // Picker-owed modal scope — a destination pick is outstanding: the
      // ONLY legal commits are elements inside the dialog. An outside click
      // dismisses the picker ("Lecrae Artist Add to playlist Follow" at
      // row-affordance killed it last run). When _dlgNow is unobserved this
      // frame, block clicks entirely rather than blind-commit.
      if (ctx.destination && ctx.memory.destPickPending != null && intent !== 'type') {
        const _inDlg = _dlgNow && el.center
          && el.center[0] >= _dlgNow.rect[0] - 4 && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2] + 4
          && el.center[1] >= _dlgNow.rect[1] - 4 && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3] + 4;
        const _menuCtx = el._inOpenMenu || /menu|dialog|listbox|popover/.test(String(el._containerRole || ''))
          || (el.ancestors || []).some(a => /menu|dialog|listbox|popover/.test(String(a.role || '')));
        if (!_inDlg && !_menuCtx) {
          acts.push(`(pick owed — "${String(el.label || '').slice(0, 24)}" outside picker, skipped)`);
          continue;
        }
      }
      const _veto = roleVeto(el, intent, g);
      if (_veto) {
        excludeIds.add(elLoose); lastId = null;
        acts.push(`(infer: ${_veto})`); emit(`infer: #${el.id} veto — ${_veto}`);
        continue; // free reject — no mouse moved, next candidate
      }
      // Label-level wrong-object — every click path. Labeled elements skip
      // the probe entirely (non-ambiguous → direct commit), so a veto living
      // inside the probe block never sees "Add to Liked Songs" committing
      // to a "Quiet Hour" goal on its own label.
      if (intent === 'click' && ctx.destination
          && _evidenceFit(el.label, g, ctx, el._role || el.tag) === 'wrong-object') {
        excludeIds.add(elLoose); lastId = null;
        acts.push(`(infer: "${String(el.label || '').slice(0, 24)}" wrong object — excluded)`);
        continue;
      }

      // Probe the ambiguous: unlabeled icons (tooltip names them) and
      // soft-role elements (I-beam/pointer arbitrates field-vs-button).
      // Strong label+hard-role candidates commit on their own evidence —
      // probing those wastes the ~1.5s a hover costs.
      const labeled = Boolean(String(el.label || '').trim());
      // Commit floor: a label alone isn't evidence. Anything that scored
      // below a single goal-word hit (< 10) and isn't a typing target gets
      // probed like a tail element — promo text, download rows, and OCR junk
      // prove nothing about the goal until a probe says otherwise.
      const weak = intent === 'click' && (el._score ?? 0) < 10 && !_entityForField && el._cls !== 'explore' && !el._bulkRow;
      // Entity rows awaiting close-out get hover-probed even when they
      // score well — the +/••• they need are hover-revealed and absent
      // from the observe-time queue. The probe clicks the revealed button;
      // a blind right-edge guess point clicks empty space.
      if (intent === 'click' && ctx.destination && ctx.memory?.pendingVerify?.length
          && el._regionRole !== 'media' && el._regionRole !== 'rail' && el._regionRole !== 'library'
          && _entityTerms.some(t => String(el.label || '').toLowerCase().includes(t))
          && !/add|more|options|…|⋯|•••|\.\.\.|\+|plus/i.test(String(el.label || ''))
          // Dialog-contained elements can't be navigation — a row inside the
          // picker IS the commit ("Quiet Hour" bears a pendingVerify term
          // because the destination itself was typed, not because it's a
          // nav row). Trapping it forced "+ New playlist" commits.
          && !el._inOpenMenu && !(_dlgNow && el.center
            && el.center[0] >= _dlgNow.rect[0] && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
            && el.center[1] >= _dlgNow.rect[1] && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3])) {
        el._probeFirst = true;
        el._navRowProbe = true; // center-click = navigation; only its
        // revealed row-buttons are legal commits
      }
      // Bare affordance glyphs ("+", "Add") hide their action object behind
      // a hover tooltip — probe before committing so "Add to Liked Songs"
      // is vetoed on evidence, not clicked on a lucky glyph.
      if (intent === 'click' && ctx.destination
          && /^(\+|plus|add)$/i.test(String(el.label || '').trim())) {
        // Region-scope — an entity is outstanding and its results live in
        // the region it was searched into (acquireRegion). A bare +/Add
        // glyph OUTSIDE that region (the library rail's "+Add") can't be
        // the entity's commit — it wins only when real rows starve.
        if ((ctx.memory?.pendingVerify || []).length && ctx.memory.acquireRegion
            && el.region && el.region !== ctx.memory.acquireRegion) {
          excludeIds.add(elLoose); lastId = null;
          acts.push(`(glyph "${String(el.label || '').slice(0, 16)}" outside entity region "${ctx.memory.acquireRegion}" — excluded)`);
          continue;
        }
        el._probeFirst = true;
      }
      if (weak) el._probeFirst = true;
      // Commit tier — a candidate whose intent is already 'type' carries
      // complete evidence (field + owed payload). Hovering can only LOSE
      // information (tip merges); commit it, don't probe it.
      // Slot-level probe memory — OCR drift shifts centers a few px per
      // parse, minting fresh element ids + loose-fps for the SAME physical
      // control; id-keyed exclusion misses and the slot gets re-hovered
      // forever (the 30-60s ping-pong). One probe per ~24px radius, then
      // the slot is dead — its verdict doesn't depend on box stability.
      ctx.memory.probedSlots = ctx.memory.probedSlots || [];
      const _nearProbed = el.center
        && ctx.memory.probedSlots.some(p =>
          Math.abs(p[0] - el.center[0]) < 24 && Math.abs(p[1] - el.center[1]) < 24);
      if (_nearProbed && intent !== 'type' && !el._bulkRow) {
        excludeIds.add(elLoose); lastId = null;
        acts.push(`(slot already probed — "${String(el.label || '').slice(0, 20)}" excluded)`);
        continue;
      }
      // EXPLORE commits are legal by stage, not by goal-fit — probing an
      // expander for "does its tooltip mention Quiet Hour" vetoes the exact
      // reveal that would make the destination visible.
      const ambiguous = intent !== 'type' && el._cls !== 'explore' && !el._bulkRow
        && (el._probeFirst || !labeled || el._role === 'unknown' || (el._role === 'icon' && !labeled));
      if (ambiguous && probesThisIter < 10) {
        probesThisIter++;
        if (el.center && ctx.memory.probedSlots.length < 40) ctx.memory.probedSlots.push(el.center);
        emit(`probe: hovering #${el.id}`);
        const probe = await probeCandidate(el, { display, windowOnly, sessionId, ctx, els, parsed, intent, goal: g });
        if (probe.dead) {
          excludeIds.add(elLoose); lastId = null;
          acts.push(`(probe: dead #${el.id})`); emit(`probe: dead #${el.id} — trying next`);
          continue;
        }
        // Label-level wrong-object — the tooltip can pass fit on a shared
        // verb ("add") while the element's own label names a different
        // object ("Add to Liked Songs" for a "Quiet Hour" goal). The veto
        // must apply to the element itself, not only its tip.
        if (_evidenceFit(el.label, g, ctx, el._role || el.tag) === 'wrong-object') {
          excludeIds.add(elLoose); lastId = null;
          acts.push(`(probe: "${String(el.label || '').slice(0, 24)}" wrong object — excluded)`);
          emit(`probe: "${String(el.label || '').slice(0, 30)}" is wrong-object — excluded`);
          continue;
        }
        const probeTip = probe.tooltip;
        // Garbage-tip guard — the OCR merge concatenates every text run
        // overlapping the tip zone, so a hover on a real button can yield
        // "Add to playlist Let's find : Q Search fo" (tip + CTA + field
        // placeholder fused). Long or separator-punctuated tips are merge
        // noise: no-evidence, never counter-evidence — skipping ALL
        // tip-derived verdicts (goal-fit AND wrong-object) so a poisoned
        // zone can't veto the correct element.
        const _tipGarbage = probeTip
          && (String(probeTip).length > 50 || /\s[:|·•]\s|\.\s+[A-Z]|\s{3,}/.test(String(probeTip)));
        if (probeTip && _tipGarbage) emit(`probe: tip noise ("${String(probeTip).slice(0, 40)}") — not evidence`);
        if (probeTip && !_tipGarbage) {
          // Breadcrumb tooltips ("Search ‹ Lecrae ‹ Lecrae") echo page
          // context, not the element's own name — only the segment before
          // the first crumb separator counts as element evidence.
          const tipSelf = String(probeTip).split(/[‹›»«→]/)[0].trim();
          // App-name words aren't element evidence — a tooltip mentioning
          // "Spotify" says nothing about THIS element; every element on the
          // page shares that word.
          const _appWord = (String(g || '').match(/\b(?:on|in|using)\s+([A-Za-z0-9]+)\s*$/i) || [])[1];
          const gWords = new Set(String(g || '').toLowerCase().split(/[^a-z0-9]+/)
            .filter(w => w.length > 2 && w !== String(_appWord || '').toLowerCase()));
          const tWords = String(tipSelf || probeTip).toLowerCase().split(/[^a-z0-9]+/);
          // A strong own-label outranks a misattributed tooltip — the zone
          // below the element can capture the row's artist text ("Andy M")
          // instead of the button's tip. When the element's own accessible
          // label already states the goal action, the garbage tip is noise.
          const _lblFits = labeled && String(el.label).toLowerCase()
            .split(/[^a-z0-9]+/).some(w => gWords.has(w));
          if (!tWords.some(w => gWords.has(w)) && !_lblFits) {
            excludeIds.add(elLoose); lastId = null;
            acts.push(`(probe: "${probeTip.slice(0, 30)}" ≠ goal)`);
            emit(`probe: "${probeTip.slice(0, 40)}" doesn't fit — trying next`);
            continue;
          }
          // Action-object check — a verb match isn't enough: the tooltip's
          // object must BE the goal's object. "Add to Liked Songs" shares
          // "add" with the goal but commits to a different destination —
          // evidence against, not for. Generic container nouns ("Add to
          // playlist") stay legal — the picker refines destination later.
          const _goalObj = ctx.destination ? String(ctx.destination).toLowerCase() : null;
          if (_goalObj) {
            const _GENERIC_OBJ = /^(playlists?|folders?|lists?|albums?|collections?|boards?|carts?|queues?|library|songs?|items?|files?|selection|it)$/i;
            const _tipObj = (tipSelf || probeTip).toLowerCase()
              .match(/\b(?:add|save|put|insert|move|copy|send|share|assign)\b[^a-z0-9]+(?:to\s+)?(?:my\s+|the\s+|a\s+|your\s+)?([a-z0-9][a-z0-9 '&-]{1,40})/i)?.[1]?.trim();
            // Merged tips fuse the CTA/field text into the object tail
            // ("Add to playlist Let's find s Q Search fo" → obj "playlist
            // let's find s q search fo"). The LEADING noun is the real
            // object — a generic container noun there stays legal.
            const _objHead = (_tipObj || '').split(/\s+/)[0] || '';
            if (_tipObj && !_GENERIC_OBJ.test(_tipObj) && !_GENERIC_OBJ.test(_objHead)
                && !_tipObj.includes(_goalObj) && !_goalObj.includes(_tipObj)) {
              excludeIds.add(elLoose); lastId = null;
              acts.push(`(probe: "${tipSelf.slice(0, 30)}" wrong object "${_tipObj}" ≠ "${_goalObj}")`);
              emit(`probe: "${tipSelf.slice(0, 40)}" commits to "${_tipObj}" not "${_goalObj}" — excluded`);
              continue;
            }
          }
          el._tipLabel = probeTip;
          emit(`probe: tooltip "${probeTip.slice(0, 60)}"`);
        }
        // Reveal-tree hit — recursive probing found a deeper element whose
        // evidence fits (menu item "Add to playlist" under a ••• hover).
        // Click the leaf directly; it lives in the domain, not the queue.
        let _hitEl = probe.hit || (() => {
          if (!probe.revealed?.length) return null;
          // Action-object veto applies to revealed buttons too — a revealed
          // "Add to Liked Songs" is the WRONG object, not a lucky "+".
          const _rev = probe.revealed.filter(b =>
            _evidenceFit(b.label, g, ctx, b._role || b.tag) !== 'wrong-object'
            // Interactive roles only — a dialog's "Add to playlist" TITLE
            // is a header, not a button; clicking it does nothing and it
            // re-reveals every probe.
            && /button|menuitem|link|option|checkbox|radio|tab/.test(String(b._role || b.tag || ''))
            // Remove flows never commit an add/save — a revealed "Add to
            // Liked Songs" mid-drain re-adds the item being removed.
            && !(ctx.memory.bulk === 'remove' && /\badd\b|\bsave\b|\bplus\b|\+/i.test(String(b.label || ''))));
          return _rev.find(b => /more|options|…|⋯|\.\.\.|•••/i.test(String(b.label || '')))
            || _rev.find(b => /add|\+|plus/i.test(String(b.label || '')))
            || null; // unlabeled right-of-row junk is not a target anymore
        })();
        // Revealed-but-unlabeled affordances — the hover surfaced controls
        // carrying no OCR label (trailing icons). Don't drop them: micro-
        // probe each (hover → tooltip) so commits act on IDENTIFIED elements.
        // A blind right-edge coordinate is how wrong-object affordances get
        // clicked. Rightmost-first (trailing-action convention), ≤2 probes.
        if (!_hitEl?.center && probe.revealed?.length && el.bbox && ctx.destination) {
          const _zoneX = el.bbox[0] + el.bbox[2] * 0.55;
          const _unl = probe.revealed
            .filter(b => !String(b.label || '').trim() && b.center
              && b.center[0] > _zoneX && Math.abs(b.center[1] - el.center[1]) < 40)
            .sort((a, b) => b.center[0] - a.center[0]).slice(0, 2);
          for (const u of _unl) {
            const up = await probeCandidate(u, { display, windowOnly, sessionId, ctx,
              els: [...(els || []), ...(probe.revealed || [])], parsed, intent: 'click', goal: g });
            const ut = String(up?.tooltip || '').trim();
            if (!/\badd\b|\bplus\b|\+|\bmore\b|\boptions?\b|…|⋯|\.\.\.|playlist|folder|list|queue|menu/i.test(ut)) continue;
            if (_evidenceFit(ut, g, ctx, u._role || u.tag) === 'wrong-object') {
              acts.push(`(micro-probe: "${ut.slice(0, 30)}" wrong object — skipped)`);
              continue;
            }
            _hitEl = { ...u, label: ut, _tipLabel: ut, _microProbed: true };
            emit(`probe: micro-probe identified revealed icon → "${ut.slice(0, 40)}"`);
            break;
          }
        }
        if (_hitEl?.center) {
          // Session dedupe — a revealed element clicked once is done. The
          // same button re-reveals on every hover (fresh before-set per
          // probe) and re-clicking it loops forever.
          const _rk = `${Math.round(_hitEl.center[0] / 8)}:${Math.round(_hitEl.center[1] / 8)}`;
          // Attempt-counted, not one-shot — 'already-clicked' after a single
          // click made a possibly-good commit unrecoverable (click fired,
          // unverified, then permanently dead). Two attempts per slot: a
          // focus-click then the real commit; beyond that the route is dead.
          ctx.memory.revealAttempts = ctx.memory.revealAttempts || new Map();
          const _rTries = ctx.memory.revealAttempts.get(_rk) || 0;
          // Picker owed = modal state — a revealed element outside the open
          // picker (or anywhere when the picker is unobserved this frame)
          // can only dismiss/corrupt it. The outstanding action is the
          // destination row inside the dialog, not the trigger again.
          // Only enforce when a pick is owed — detectDialog false-positives
          // on sidebar panels, and ambient-page reveals are legal clicks.
          const _pickOwed = ctx.destination && ctx.memory.destPickPending != null;
          const _outsideDlg = _pickOwed && _dlgNow && !(
            _hitEl.center[0] >= _dlgNow.rect[0] && _hitEl.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
            && _hitEl.center[1] >= _dlgNow.rect[1] && _hitEl.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3]);
          const _skipWhy = _outsideDlg ? 'outside-dialog'
            : (_pickOwed && !_dlgNow) ? 'pick-owed,no-dlg'
            : (_pickOwed && /add to (playlist|folder|list|collection|board|library)/i.test(String(_hitEl.label || ''))) ? 'pick-owed,retrigger'
            : _rTries >= 2 ? 'attempts-exhausted'
            : ctx.memory.committed.has(_fpLoose(_hitEl)) ? 'committed' : null;
          if (_skipWhy) {
            emit(`probe: reveal-hit "${String(_hitEl.label || '').slice(0, 30)}" skipped (${_skipWhy})`);
            excludeIds.add(elLoose); lastId = null;
            continue;
          }
          ctx.memory.revealAttempts.set(_rk, _rTries + 1);
          ctx.memory.committed.add(_fpLoose(_hitEl));
          // Composite-label targeting ("3:20 •••") — click the matched
          // glyph's proportional band, not the label center.
          let hx = _hitEl.center[0], hy = _hitEl.center[1];
          if (_hitEl.bbox) {
            const L = String(_hitEl.label || '');
            const gm = L.match(/•••|⋯|\.\.\.|…|\+/);
            if (gm && L.trim().length > gm[0].length) {
              const i = L.indexOf(gm[0]);
              hx = _hitEl.bbox[0] + _hitEl.bbox[2] * ((i + gm[0].length / 2) / L.length);
            }
          }
          if (/more|options|…|⋯|\.\.\.|•••|add to (playlist|folder|list|collection|board|library)/i
              .test(String(_hitEl.label || '')))
            ctx.memory.expectMenuAt = iters;
          acts.push(`click revealed "${String(_hitEl.label || 'icon').slice(0, 24)}" d${_hitEl._depth || 0}`);
          emit(`probe: revealed "${_hitEl.label || 'icon'}" @(${Math.round(hx)},${Math.round(hy)}) — click`);
          excludeIds.add(elLoose); lastId = null;
          await mouseAgent({ action: 'click', x: Math.round(hx), y: Math.round(hy), sessionId }).catch(() => null);
          continue;
        }
        // Nav trap — an entity-bearing row probed and still standing is a
        // NAVIGATION, never an add: its only legal commits were the
        // revealed row-buttons handled above. A guessed right-edge point
        // clicks empty space; a center click opens the artist page.
        if (el._navRowProbe) {
          // Positional affordance fallback — the probe found no revealable
          // button but the row CARRIES an owed entity: the trailing +/add
          // control sits at the last-column slot by convention (same math
          // as route-B's remove affordance), even when OCR/AX can't see it.
          // One positional commit is owed before exclusion; pendingVerify
          // clearing (or a toast/row-state change) verifies it — else the
          // row is excluded for the rest of the run as before.
          // Row-shape + region guards — "Quiet Hour" in the now-playing bar
          // or a panel header also carries the term; only wide result rows
          // in content/dialog regions get the positional commit.
          const _owedEntity = (ctx.memory?.pendingVerify || []).length
            && _entityTerms.some(t => String(el.label || '').toLowerCase().includes(t))
            && el._regionRole !== 'media' && el._regionRole !== 'rail' && el._regionRole !== 'library'
            && (el._isRow || (el.bbox && el.bbox[2] > 250));
          if (_owedEntity) {
            // No identified affordance — the context menu IS the app's
            // labeled-action enumeration: right-click the row and let menu
            // items carry the destination decision. The old blind right-edge
            // slot landed on whichever trailing affordance was rightmost —
            // wrong-object commits came from that. Right-click lands in the
            // row interior, shifted off member coverage where possible (the
            // row is the hit target; an overlaid link would serve ITS menu).
            let _rx = el.center[0];
            for (const m of (el._members || []).filter(m => m.center).sort((a, b) => a.center[0] - b.center[0])) {
              const x0 = m.bbox ? m.bbox[0] : m.center[0] - 15;
              const x1 = m.bbox ? m.bbox[0] + m.bbox[2] : m.center[0] + 15;
              if (_rx >= x0 - 4 && _rx <= x1 + 4) _rx = x1 + 8;
            }
            emit(`probe: nav row, entity owed, no identified affordance — context-menu route`);
            acts.push(`(probe: right-click entity row "${String(el.label || '').slice(0, 24)}")`);
            ctx.memory.expectMenuAt = iters;
            ctx.memory.expectAfford = { row: elLoose, at: iters, pv: (ctx.memory.pendingVerify || []).length };
            excludeIds.add(elLoose); lastId = null;
            await mouseAgent({ action: 'right-click', x: Math.round(_rx), y: Math.round(el.center[1]), sessionId }).catch(() => null);
            continue;
          }
          excludeIds.add(elLoose); lastId = null;
          acts.push(`(probe: nav row "${String(el.label || '').slice(0, 24)}" — no actionable reveal)`);
          emit(`probe: "${String(el.label || '').slice(0, 30)}" is a nav row — excluded`);
          continue;
        }
        // Commit floor for the exhaustive tail — an interactive element with
        // zero goal evidence (no tooltip overlap, no row/icon affordance) is
        // excluded, not clicked. This is what stops "Explore Premium", promo
        // text, and extension buttons from being blind-committed: they react
        // to hover but prove nothing about the goal. Row-role elements
        // (listitem/icon/unknown) with an affordance still commit — a song
        // row's hover state IS the add-affordance we came for.
        if (el._probeFirst) {
          // Nav rows don't get the affordance pass — a hover glow on a song
          // row is not the add button; only its revealed buttons count.
          const affordOk = probe?.affordance && !el._navRowProbe
            && ['listitem', 'icon', 'unknown'].includes(el._role);
          // Own-label evidence — an AX/DOM element whose accessible label
          // already states a goal word ("Add to playlist") is evidence by
          // itself; no hover tooltip required. The object check above still
          // guards "Add to Liked Songs"-style mismatches when a tip exists.
          const _selfFit = labeled && String(el.label).toLowerCase()
            .split(/[^a-z0-9]+/)
            .some(w => new Set(String(g || '').toLowerCase().split(/[^a-z0-9]+/)
              .filter(x => x.length > 2)).has(w));
          if (!probeTip && !affordOk && !_selfFit) {
            excludeIds.add(elLoose); lastId = null;
            acts.push(`(probe: #${el.id} interactive but no goal evidence)`);
            emit(`probe: #${el.id} no goal evidence — excluded`);
            continue;
          }
        }
      } else if (el._probeFirst && el._cls !== 'explore' && !el._bulkRow) {
        // Probe budget exhausted this iteration — skip, don't reject. A
        // budget miss is not evidence of irrelevance; excluding unprobed
        // elements starves real targets behind junk probes.
        continue;
      }

      // ── commit: input-like + pending payload → type; else click ─────────
      let micro, desc;
      if ((el._destType && ctx.destination) || ((_entityForField || _destForField) && roleAllowsType(el, g))) {
        // Destination payloads don't consume the entity queue — they pick
        // the container a picker field filters by.
        const text = el._destType ? ctx.destination
          : (_destForField || (pending.length ? pending.shift() : _entityForField));
        if (el._destType) {
          ctx.memory.destSearch = (ctx.memory.destSearch || 0) + 1;
          emit(`explore: destination search "${ctx.destination}"`);
        }
        if (_destForField) {
          ctx.memory.destTypes = (ctx.memory.destTypes || 0) + 1;
          ctx.memory.destPickPending = iters; // menuitem click is now owed
        } else if (/search:entity|global/.test(String(el._scope || ''))) {
          ctx.memory.acquired = iters; // entity is in the catalog search —
          // phase flips to act next observe
          // Results live in the field's own region/container — a same-label
          // row in another region ("KB, Lecrae" in the playlist table vs the
          // search panel) is a different element, not the result.
          ctx.memory.acquireRegion = el.region || null;
          ctx.memory.acquirePath = el._containerPath || null;
        }
        // Typed ≠ verified — the entity moves to pendingVerify and only
        // leaves when containment sees it. A different field may re-type it
        // (typed map guards same-field duplicates). A dest-search deposit is
        // navigation, not an entity — it must not reopen the nav mask.
        if (!el._destType && !ctx.memory.pendingVerify.includes(text)) ctx.memory.pendingVerify.push(text);
        ctx.memory.typed.set(text, elLoose);
        // Any entity deposit anchors the results region — the rows that
        // satisfy the entity live where it was searched, not anywhere else.
        if (!_destForField) {
          ctx.memory.acquireRegion = el.region || ctx.memory.acquireRegion || null;
          ctx.memory.acquirePath = el._containerPath || ctx.memory.acquirePath || null;
        }
        micro = { action: 'type', _target: el, text, goal: g, why: 'auto-type', settleMs: 500 };
        desc = `type "${String(text).slice(0, 30)}"`;
      } else {
        // Row affordance — a wide row composite ending in an affordance token
        // ("Lecrae Episode · Add") clicks its right-edge control, not row center
        // (center plays/navigates; the affordance commits the goal action).
        // No token OCR'd? While an entity awaits its row, an entity-bearing
        // wide row still gets the right-edge point — the trailing-action
        // convention (Spotify Add, Mail archive, Files share) holds even when
        // the button's label didn't parse as part of the row.
        const _elBearsEntity = _entityTerms.some(t => String(el.label || '').toLowerCase().includes(t));
        // Work-item admission — an entity-bearing row earns a commit only
        // when it IS the work item, not a container card ABOUT the entity.
        // Container nouns in the label/members ("Lecrae playlist", podcast
        // shows) disqualify; work rows qualify via duration/recency cells
        // or member structure — song rows OCR "Title Artist" while the
        // duration sits in a separate column element.
        const _contNoun = /\b(playlist|album|podcast|show|artist|station|radio|collection|profile|channel|series)\b/i;
        const _isContainerCard = _contNoun.test(String(el.label || ''))
          || (el._members || []).some(m => _contNoun.test(String(m.label || '')));
        const _workSig = _isWorkRow(el);
        const _elBearsEntityRow = _elBearsEntity && !_isContainerCard && _workSig;
        // Narrow panel rows ("Only Sixteen · Craig Douglas ⊕") are too thin
        // for the 250px rule — their trailing + sits at the PANEL's right
        // edge. Same convention, panel-relative point.
        const _panelEdge = _dlgNow && el.center &&
          el.center[0] >= _dlgNow.rect[0] && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
          && el.center[1] >= _dlgNow.rect[1] && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3]
          ? [Math.round(_dlgNow.rect[0] + _dlgNow.rect[2] - 20), Math.round(el.center[1])] : null;
        // An entity-bearing row's center is a NAVIGATION (track/artist page),
        // never an add — its commit lives at the right-edge affordance. Force
        // the affordance point whenever an entity term is outstanding, not
        // only while awaiting-verify.
        const _entityOwed = _awaiting || pending.length > 0;
        // Afford-route verify-gate — last iteration's slot/arm commit must
        // have surfaced a menu/picker or cleared pendingVerify; neither →
        // that row's affordance route is dead → context-menu route next.
        if (ctx.memory.expectAfford && iters > ctx.memory.expectAfford.at) {
          const _exp = ctx.memory.expectAfford; ctx.memory.expectAfford = null;
          if (!_dlgNow && !els.some(e => _menuishEl(e))
              && ctx.memory.pendingVerify.length >= _exp.pv)
            (ctx.memory.affordDead ||= new Set()).add(_exp.row);
        }
        // Identified-affordance requirement — observed is not identified:
        // an element near the right−34 slot must carry a LABEL saying what
        // it does (add/more/options pass the object check; liked/heart/
        // play/follow labels fail it). An unlabeled icon near the slot is
        // still a guess → the row falls through to the context-menu route
        // instead of a blind click on whichever control is rightmost.
        const _slotPt = _entityOwed && _elBearsEntityRow && el.bbox && el.bbox[2] > 250
          ? [Math.round(el.bbox[0] + el.bbox[2] - 34), Math.round(el.bbox[1] + el.bbox[3] / 2)] : null;
        const _slotNear = _slotPt ? els.find(o => o !== el && o.center
          && Math.abs(o.center[0] - _slotPt[0]) < 30 && Math.abs(o.center[1] - _slotPt[1]) < 20) : null;
        const _slotId = _slotNear && !ctx.memory.affordDead?.has(elLoose)
          && String(_slotNear.label || '').trim()
          && !/liked|heart|follow|play|queue|share|save/i.test(String(_slotNear.label))
          && /\badd\b|\+|plus|more|options|…|⋯|\.\.\.|•••|playlist|folder|list|menu/i.test(String(_slotNear.label))
          && _evidenceFit(_slotNear.label, g, ctx, _slotNear._role || _slotNear.tag) !== 'wrong-object';
        const affordPt = _affordancePoint(el)
          || (_entityOwed && _elBearsEntityRow && _panelEdge)
          || (_slotId ? _slotPt : null);
        // Destination pick committed — a destination-matching element inside
        // the open dialog/menu is THE commit ("Quiet Hour" row, its radio
        // circle, or the row composite). Dialog-rect containment covers OCR
        // elements that carry no menuish role or ancestors.
        if (ctx.destination && ctx.memory.destPickPending != null
            && String(el.label || '').toLowerCase().includes(String(ctx.destination).toLowerCase())
            && (el._inOpenMenu || /menuitem|option|radio/.test(String(el._role || ''))
              || /menu|dialog|listbox|popover/.test(String(el._containerRole || ''))
              || (_dlgNow && el.center
                && el.center[0] >= _dlgNow.rect[0] && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2]
                && el.center[1] >= _dlgNow.rect[1] && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3]))) {
          ctx.memory.destPickPending = null; // outstanding pick committed
          ctx.memory.pickCommittedAt = iters; // completion signal: dialog-close → done
        }
        // Route bookkeeping — a ⋯/context-menu commit creates an
        // expectation: a menu/listbox/dialog container should appear next
        // observe. If it doesn't, that route is marked dead and the walk
        // advances (right-click → different context-menu surface).
        if (/more\b|options\b|…|⋯|ellipsis/i.test(String(el.label || '')))
          ctx.memory.expectMenuAt = iters;
        // Route C — the ⋯ menu route died (expectMenuAt passed with no menu
        // container observed): entity rows re-commit as right-click, which
        // opens the OS/app context menu — a different menu surface.
        // Elevated: when an entity is owed and NO affordance is identified,
        // right-click is the PRIMARY row commit — the context menu is the
        // app-agnostic labeled-action enumeration, and destination-scoping
        // becomes label matching instead of a blind coordinate guess.
        // Picker/menu members stay left-click — a destination row inside an
        // open dialog IS the commit, not a menu trigger.
        const _inDlgEl = _dlgNow && el.center
          && el.center[0] >= _dlgNow.rect[0] - 4 && el.center[0] <= _dlgNow.rect[0] + _dlgNow.rect[2] + 4
          && el.center[1] >= _dlgNow.rect[1] - 4 && el.center[1] <= _dlgNow.rect[1] + _dlgNow.rect[3] + 4;
        // Universal interrogation — while a commit context is outstanding,
        // ANY row-shaped candidate with no identified affordance gets
        // right-click first, not a center-click guess: the context menu is
        // the platform's action enumeration (native + web + commerce alike).
        // Menu-exhausted rows (affordDead) earn back their left-click;
        // labeled controls and picker members never interrogate — they ARE
        // identified. Browser-chrome menus verdict as no-item-menu upstream.
        const _rowish = el._isRow || (el._members || []).length >= 2
          || (el.bbox && el.bbox[2] > 320 && /listitem|row|article|generic|group|cell/i.test(String(el._role || el.type || '')));
        const _useRightClick = el._bulkRow
          || (_rowish && !affordPt && !_menuishEl(el) && !_inDlgEl
            && el._regionRole !== 'rail' && el._regionRole !== 'library' && el._regionRole !== 'media'
            && !ctx.memory.affordDead?.has(elLoose)
            && (ctx.destination || _entityOwed));
        if (affordPt || _useRightClick)
          ctx.memory.expectAfford = { row: elLoose, at: iters, pv: ctx.memory.pendingVerify.length };
        if (_useRightClick) ctx.memory.expectMenuAt = iters;
        // Pre-arm validation — registry picks carry stale centers (rows
        // virtualize, labels mutate); right-clicking a dead point opens the
        // browser menu and wastes a retry cycle. Probe a tight crop at the
        // target: nothing work-matching there → drop the ghost, move on.
        if (el._bulkRow && el._registry) {
          const _rowProbe = await _probeRect(
            [Math.max(0, el.center[0] - 80), Math.max(0, el.center[1] - 30), 320, 60],
            { display, windowOnly });
          const _rowAlive = _rowProbe.some(r => r.center
            && Math.abs(r.center[1] - el.center[1]) < 40
            && _sameWork(String(r.label || ''), el.label));
          if (!_rowAlive) {
            emit(`bulk delete: arm-site dead for "${String(el.label || '').slice(0, 26)}" — dropping registry ghost`);
            ctx.memory.delSeen?.forEach((v, k) => { if (_sameWork(v.label, el.label)) ctx.memory.delSeen.delete(k); });
            (ctx.memory.badWork ||= new Set()).add(_workKey(el.label));
            continue;
          }
        }
        micro = { action: _useRightClick ? 'right-click' : 'click', _target: affordPt ? { ...el, center: affordPt, _affordMoved: true } : el, goal: g, why: 'auto-click', settleMs: 600, probe: false };
        // Surface-navigation count — a center-click on an entity-bearing
        // non-work element (container card, artist row) changes the scene.
        // Two is exploration; beyond that it's churn — the mask stops
        // admitting them.
        if (!_useRightClick && !affordPt && _elBearsEntity && !_workSig && !_menuishEl(el) && !_inDlgEl
            && ctx.memory.pendingVerify.length)
          ctx.memory.navs = (ctx.memory.navs || 0) + 1;
        desc = `${_useRightClick ? 'right-click' : 'click'} "${String(el.label || '').slice(0, 30) || '(icon)'}"${affordPt ? ' @row-affordance' : ''}`;
      }
      acts.push(desc);
      logger.info(`[screen.act] auto iter ${iters}: ${desc} (${cands.length} cands, ${pending.length} pending, ${ctx.memory.pendingVerify.length} awaiting-verify)`);

      const res = await runStep(micro, ctx);
      const lx = _serializeAutoStep(micro, res.element || el, prev, els, res.element?._tipLabel);
      if (lx) learned.push(lx);
      const t = {
        step: outerIdx, iter: iters, action: micro.action,
        match: lx?.match ?? null,
        element: { id: el.id, label: el.label, center: el.center },
        pickPath: `auto:${desc}`, verified: res.verified ?? null,
        verifyReason: res.verifyReason || null, recovers: 0,
        ok: res.ok !== false,
      };
      trace.push(t);
      emit(t);
      prev = { center: el.center, label: el.label };
      committed = true;
      if (el._bulkRow && res.ok !== false) {
        ctx.memory.bulkClicks = (ctx.memory.bulkClicks || 0) + 1;
        ctx.memory.bulkClickedAt = iters;
        ctx.memory.expectMenuAt = iters;
        ctx.memory.armedLabel = String(el.label || '').trim();
        ctx.memory.preArmLabels = _preArmSnap(els);
        ctx.memory.lastArmPoint = el.center ? [el.center[0], el.center[1]] : null;
        ctx.memory.lastArmRoute = 'right-click';
        if (ctx.memory.sigUsable) {
          ctx.memory.sigArmed = true;
          ctx.memory.sigArmPoint = ctx.memory.lastArmPoint;
          ctx.memory.sigArmIter = iters;
        }
      }
      // Remove-chain evidence — a remove-ish menuitem inside an open menu
      // committing is the removal action; so is the destination-named row
      // of a membership picker (the container toggle). The armed label's
      // disappearance only counts alongside this.
      if (res.ok !== false && _menuishEl(el)
          && (_vocab.classifyAction(el.label, 'delete')
              || (ctx.memory.armedLabel && _destLo2
                && ctx.memory.menuDead && ctx.memory.menuDead.has(ctx.memory.lastArmedKey)
                && String(el.label || '').toLowerCase().includes(_destLo2)
                && !/save to|add to/i.test(String(el.label || ''))))) {
        ctx.memory.removeCommitted = iters;
            ctx.memory._lastCommitIter = iters;
        // Commit geometry — the menu anchors at the arm point, so the item's
        // offset from it is layout-stable across identical rows (removeSig).
        if (ctx.memory.lastArmPoint && el.center)
          ctx.memory.lastCommitOffset = [el.center[0] - ctx.memory.lastArmPoint[0], el.center[1] - ctx.memory.lastArmPoint[1]];
        ctx.memory.sigArmed = null; // the element path beat the coordinate replay
      }
      if (el._cls === 'explore' && res.ok !== false) {
        ctx.memory.triedExpanders.add(elLoose);
        emit(`explore: opened "${String(el.label || 'icon').slice(0, 30)}" (rail expander)`);
      }
      if (el._cls === 'transition' && res.ok !== false) {
        ctx.memory.lastTransitionAt = iters;
        emit(`transition: → "${String(el.label || '').slice(0, 40)}"`);
      }
      // Navigate commit — clicking a destination item raises a PENDING
      // transition: the container only counts as open once the next observe
      // confirms the scene changed (header match or URL left /search).
      if (res.ok !== false && _destLo2 && !_containerOpen && !_menuishEl(el)
          && String(el.label || '').toLowerCase().includes(_destLo2)) {
        ctx.memory.transPending = iters;
        ctx.memory.lastTransLabel = String(el.label || '');
        ctx.memory.verifying = iters; // VERIFYING — observe only until the new scene's identity resolves
        ctx.memory.preTransFp = els.slice(0, 30).map(e => String(e.label || '')).sort().join('|');
      }
      // Crumbtrail — every committed edge records where it landed so backOut
      // can re-anchor (domain jump) or pop one edge (same-domain undo).
      if (ctx.scene) _sg.trailPush(ctx.scene, {
        edge: micro.action === 'key' ? 'key' : 'commit',
        action: micro.action, label: el.label, nodeId: el._node ? el._node.id : null });
      // Clicks only — a field must never join the committed set: the next
      // entity (Lecrae after KB) retypes into the same dialog field.
      if (res.ok !== false && micro.action === 'click') {
        ctx.memory.committed.add(elLoose);
        ctx.memory.lastCommittedLoose = elLoose;
      }

      if (!res.ok || res.verified === false) {
        const retries = ctx.memory.typeRetries.get(elLoose) || 0;
        if (micro.action === 'type' && retries < 2) {
          // A failed type isn't a dead field — re-arm the typed guard so the
          // entity retargets this field (or another) next parse.
          ctx.memory.typeRetries.set(elLoose, retries + 1);
          ctx.memory.typed.delete(micro.text);
          acts.push(`(type unverified — field re-armed ${retries + 1}/2)`);
        } else {
          // Commit produced no expected change — exclude and keep walking;
          // the screen may have drifted but the loop re-parses next iter.
          if (el.id != null) excludeIds.add(elLoose);
          acts.push(`(${res.error || res.verifyReason || 'no change'} — excluded)`);
        }
      }
      break; // one commit per iteration — re-observe before the next
    }

    if (committed) { exhaustRounds = 0; ctx.memory.deepParsed = false; continue; }
    // Whole queue probed with no commit: count the round; the no-cands
    // branch above performs the scope expansion on the next parse.
    exhaustRounds++;
  }
  return fail(`exhausted ${maxIters} iterations`, maxIters);
}

// Default progress channel — when no onStep is supplied but the stategraph
// injected _progressCallbackUrl, emit the same whitelisted shapes the overlay
// understands: terminal:activity one-liners (ticker + avatar) and
// agent:turn_live step rows (AutomationProgress live steps).
function _defaultOnStep(args) {
  const cb = args._progressCallbackUrl;
  if (!cb) return null;
  const stepIndex = args._stepIndex ?? 0;
  const fmt = (t, i, n) => typeof t === 'string' ? t
    : `step ${i + 1}/${n}${t.iter != null ? ` ·auto ${t.iter + 1}` : ''}: ${t.action} ${typeof t.match === 'string' ? t.match : Array.isArray(t.match) ? t.match.map(m => typeof m === 'string' ? m : String(m?.re || '')).join(' | ') : ''}${t.verified === false ? ' (unverified)' : ''}${t.recovers ? ` +${t.recovers}r` : ''}`;
  return (t, i, n) => {
    if (_aborted()) return;
    const line = fmt(t, i, n).slice(0, 140);
    fetch(cb, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'terminal:activity', line, ts: Date.now() }) }).catch(() => {});
    if (typeof t === 'object' && t && t.action) {
      fetch(cb, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'agent:turn_live', agentId: 'screen.agent',
          turn: i + 1, maxTurns: n || 1, stepIndex,
          currentAction: `${t.action} ${typeof t.match === 'string' ? t.match : ''}`.trim().slice(0, 80) }) }).catch(() => {});
    }
  };
}

async function screenActAgent(args = {}) {
  const prev = _ACT_SIGNAL;
  _ACT_SIGNAL = args._abortSignal || null;
  try { return await _screenActAgent(args); }
  finally { _ACT_SIGNAL = prev; }
}

// The run-ctx _screenActAgent builds — factored out so debug sessions
// (/screen.debug.*) start from the same memory/destination/search-seeded
// state instead of a lookalike.
function _makeActCtx(args, goal, steps = []) {
  const ctx = { display: args.display ?? -1, windowOnly: args.windowOnly || false, sessionId: args.sessionId, goal, app: args.app || null, excludeIds: new Set(), lastEls: null, startUrl: args.startUrl || null, browserName: args.browserName || null, _tabMatch: args.tabMatch || null,
    // Run-memory — the walk is stateful: seen-fps drive new-element priority,
    // committed-fps stop re-clicks, typed guards prevent duplicate input, and
    // pendingVerify keeps typed entities scoring until containment confirms.
    uiMap: args.uiMap || null,
    // AX-first observe lane — skip the per-iteration OCR parse when the
    // accessibility tree is rich (opt-in; args.fastAx).
    fastAx: !!args.fastAx,
    memory: { seen: new Set(), committed: new Set(), typed: new Map(), pendingVerify: [], typeRetries: new Map(), scrolls: 0 },
    emit: typeof args.onStep === 'function' ? (t) => { if (_aborted()) return; try { args.onStep(t, -1, 0); } catch (_) {} } : null };
  // Destination payload — the CONTAINER the task targets ("Quiet Hour"), as
  // distinct from entity payloads ("Lecrae"). pick:destination-scope fields
  // accept this and only this. Sourced from the container-nav plan step,
  // else parsed out of the goal text.
  const _cnv = steps.find(s => /container-nav/i.test(String(s.why || '')));
  ctx.destination = (args.destination
    || (_cnv ? (Array.isArray(_cnv.match) ? _cnv.match[0] : _cnv.match) : null)
    || (String(goal).match(/(?:to|into|onto|from|within|out of|inside)\s+(?:my\s+|the\s+)?["']?([\w'&\- ]{2,40}?)["']?\s+(?:playlist|folder|album|board|list|collection|project|channel|space)\b/i) || [])[1]
    || null)?.replace(/\s+(playlist|folder|album|board|list|collection|project|channel|space)s?$/i, '').trim() || null;
  // Task-level URL-first already navigated to search results — the entity
  // is LOCATED, not pending typing. Seed pendingVerify (find row + commit)
  // and mark acquire done so phase starts at ACT.
  if (args.searchSeeded) {
    ctx._searchSeeded = args.searchSeeded;
    ctx.memory.pendingVerify.push(String(args.searchSeeded));
    ctx.memory.acquired = 0;
  }
  if (args.containerSearch) ctx._containerSearch = args.containerSearch;
  return ctx;
}

async function _screenActAgent(args = {}) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
  if (typeof args.onStep !== 'function') {
    const d = _defaultOnStep(args);
    if (d) args = { ...args, onStep: d };
  }
  const { goal = '', sessionId, display = -1, windowOnly = false } = args;
  const maxSteps = Math.min(args.maxSteps || MAX_STEPS, MAX_STEPS);
  const steps = Array.isArray(args.steps) && args.steps.length ? args.steps : splitGoal(goal);
  if (!steps.length && !goal) return { ok: false, error: 'screen.act.agent: no goal/steps', sessionId };

  const ctx = _makeActCtx(args, goal, steps);
  const trace = [];
  // Learned-flow write-back — the verified trace IS the recipe. flowPrompt is
  // the original natural-language prompt (screen.task passes it separately
  // because `goal` may be a destination name); falls back to goal.
  const flowPrompt = args.flowPrompt || goal;
  const flowKey = flowCache.taskKey(flowPrompt);
  const learned = [];
  let lastVerified = null;
  let autoFallbackStep = -1;   // each step earns ONE fallback of its own
  let autoFallbackCount = 0;   // …but a run can't spend >4 recovering

  for (let i = 0; i < Math.min(steps.length, maxSteps); i++) {
    if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, stepsRun: trace, sessionId };
    const step = { ...steps[i] };
    step.goal = step.goal || goal;

    // action:'auto' — runtime decomposition loop (observe→pick→act→verify
    // per micro-action against the live element list). Its per-iteration
    // trace/learned entries merge into the same verification + recipe gates.
    if (step.action === 'auto') {
      const ares = await runAutoLoop(step, ctx, i, args.onStep, steps.length);
      for (const t of ares.trace || []) trace.push(t);
      learned.push(...(ares.learned || []));
      if (ares.verified === true || ares.ok) lastVerified = ares.verified ?? lastVerified;
      if (!ares.ok) {
        return {
          ok: false,
          error: `step ${i} (auto): ${ares.error}`,
          needsUser: ares.needsUser || null,
          stepsRun: trace, sessionId,
        };
      }
      continue;
    }

    ctx._undoUsed = false; // ⌘Z budget is per-step
    let res = await runStep(step, ctx);
    let recovers = 0;
    while (res.lowConfidence && recovers < MAX_RECOVER) {
      if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, stepsRun: trace, sessionId };
      recovers++;
      if (res.element?.id != null) ctx.excludeIds.add(_fpLoose(res.element));
      await recoverStep(step, sessionId, ctx, res.evidence, recovers, res);
      // typing into a non-key window? escalate: click into the window on retry
      if (step.action === 'type' && recovers >= 1) step.clickWindow = true;
      logger.warn(`[screen.act] step ${i} verify failed (${res.verifyReason || res.error || 'no-reason'}) — recovering (attempt ${recovers})`);
      res = await runStep(step, ctx);
    }

    // Learning: a step that only verified after recoveries merges its winning
    // anchor into the stored recipe as a permanent alternative — the recipe
    // grows caveats for OCR/layout variants it survived.
    if (res.ok !== false && recovers > 0 && flowKey && typeof step.match === 'string') {
      flowCache.mergeVariant(flowKey, i, { match: step.match, dx: step.dx, dy: step.dy });
    }
    // Persist the EFFECTIVE step (post alt-resolution) — _alts keeps the full
    // authored alternative set when it was an array.
    learned.push({
      action: step.action, match: step._alts || step.match || null,
      ...(step.text != null ? { text: step.text } : {}),
      ...(step.key ? { key: step.key } : {}), ...(step.mods?.length ? { mods: step.mods } : {}),
      ...(step.dx ? { dx: step.dx } : {}), ...(step.dy ? { dy: step.dy } : {}),
      ...(step.expect ? { expect: step.expect } : {}),
      ...(step.check ? { check: step.check } : {}),
      ...(step.pre ? { pre: step.pre } : {}), ...(step.preUnless ? { preUnless: step.preUnless } : {}),
      ...(step.selectAll ? { selectAll: true } : {}), ...(step.optional ? { optional: true } : {}),
      ...(step.settleMs ? { settleMs: step.settleMs } : {}),
      ...(step.waitMatchMs ? { waitMatchMs: step.waitMatchMs } : {}),
      ...(step.why ? { why: step.why } : {}),
    });

    trace.push({
      step: i, action: step.action, match: step.match || null,
      pickPath: res.pickPath || null, element: res.element ? { id: res.element.id, label: res.element.label, center: res.element.center } : null,
      verified: res.verified ?? null, verifyReason: res.verifyReason || null,
      recovers, ok: res.ok !== false,
    });
    if (!_aborted() && typeof args.onStep === 'function') {
      try { args.onStep(trace[trace.length - 1], i, steps.length); } catch (_) {}
    }
    if (res.element) ctx.excludeIds.delete(res.element.id); // verified ok → reusable next steps
    lastVerified = res.verified ?? lastVerified;

    if (!res.ok) {
      // Same-plan exhaustion — a hard step failure doesn't mean the goal is
      // unreachable, only that the learned recipe drifted from reality. Hand
      // the REMAINING goal to the runtime auto-loop once per run: it observes
      // the current screen and works forward, rather than replaying the
      // recipe from step 1 and crashing into the same wall. Remaining steps'
      // texts become the pending entities so completed typing isn't redone.
      if (autoFallbackStep !== i && autoFallbackCount < 4 && step.action !== 'auto') {
        autoFallbackStep = i; autoFallbackCount++;
        const pending = steps.slice(i).map(s => (s.text != null ? String(s.text) : null)).filter(Boolean);
        const fbCheck = [...steps].reverse().find(s => s.check != null)?.check;
        const seed = trace.filter(t => t.ok !== false)
          .map(t => `${t.action} ${String(t.match || t.element?.label || '').slice(0, 40)}`.trim()).slice(-8);
        // Sub-goal handoff — the loop decides on the IMMEDIATE objective, not
        // the whole prompt: the failed step's intent + the remaining recipe
        // ("click the unlabeled + near Your Library → rename to X → search Y")
        // is what the model should be picking against (observed: without it
        // the loop circles sidebar rows sharing the goal's keywords).
        const remainingDesc = steps.slice(i)
          .map(s => `${s.action}${s.match ? ' ' + String(s.match).slice(0, 40) : ''}${s.text ? ` "${String(s.text).slice(0, 30)}"` : ''}`)
          .join(' → ');
        const subGoal = `The recipe step "${step.action} ${String(step.match || '').slice(0, 40)}" just failed. ` +
          `Remaining recipe: ${remainingDesc}. Work out what the failed step was doing and continue from there.`;
        logger.warn(`[screen.act] step ${i} failed — auto-loop taking over remaining goal (${pending.length} pending entities)`);
        const ares = await runAutoLoop(
          { action: 'auto', goal: step.goal || goal, check: fbCheck, bulk: steps.find(s => s.bulk)?.bulk || null },
          ctx, i, args.onStep, steps.length, { pendingOverride: pending, seedActs: seed, subGoal });
        for (const t of ares.trace || []) trace.push(t);
        learned.push(...(ares.learned || []));
        if (ares.ok) { lastVerified = ares.verified ?? lastVerified; break; }
        // Fallback exhausted but steps remain — keep going. Each step verifies
        // against live elements; recovery may already have advanced the state
        // (observed: fallback typed the payload the next map step needed).
        logger.warn(`[screen.act] auto-fallback failed — continuing to step ${i + 1} (${steps.length - i - 1} steps remain)`);
        continue;
      }
      return {
        ok: false,
        error: `step ${i} (${step.action} ${step.match || ''}): ${res.error || res.verifyReason || 'verify failed'}`,
        stepsRun: trace, sessionId,
      };
    }
    if (res.alreadySatisfied) {
      return { ok: true, output: res.output, alreadySatisfied: true, stepsRun: trace, sessionId };
    }
  }

  // Recipe earned — serialize prompt-entity text into slots so replay fills
  // THIS prompt's values, then persist keyed by task shape. Gate: the trace
  // must contain a PASSING verify step — observed goal state, not merely
  // completed clicks (a generic plan that clicked plausible elements but
  // achieved nothing must never become a replayable recipe).
  const _verifiedEnd = trace.some(t => t.action === 'verify' && t.verified === true);
  if (flowKey && learned.length && _verifiedEnd) {
    const entities = flowCache.extractEntities(flowPrompt);
    flowCache.put(flowKey, flowCache.serializeSteps(learned, entities), { goal: flowPrompt });
    logger.info(`[screen.act] learned flow "${flowKey}" (${learned.length} steps)`);
  }

  return {
    ok: true,
    output: trace.map(t => `${t.action}${t.match ? ` '${t.match}'` : ''}${t.element ? ` → #${t.element.id}` : ''} [${t.pickPath || 'key'}]${t.verified === false ? ' ⚠unverified' : ''}`).join(' ; '),
    stepsRun: trace,
    verified: lastVerified,
    sessionId,
  };
}

// ── Debug sessions — /screen.debug.* drives runAutoLoop one iteration at a ──
// time with ctx.memory persisted between calls. commit:false packages the
// live decision context (debugOnce — zero physical acts); commit:true runs
// one normal iteration (its own committed-cap still applies); commit:{action}
// fires the caller's chosen micro-action at the same seam the proposal would
// have used.
const _DEBUG_RUNS = new Map();
function _debugCtx(args, steps = []) {
  const goal = args.goal || args.prompt || '';
  // Mirror the production hand-off — buildTaskPlan/runSetup write
  // underscore-prefixed keys (args._searchSeeded, args._startUrl, …) which
  // screen.task maps onto the act call; debug entries must do the same or
  // ctx seeds nothing.
  const mapped = { ...args };
  for (const k of ['searchSeeded', 'containerSearch', 'startUrl', 'browserName']) {
    if (mapped[k] == null && mapped['_' + k] != null) mapped[k] = mapped['_' + k];
  }
  const ctx = _makeActCtx({ ...mapped, goal }, goal, steps);
  ctx.emit = typeof args.onStep === 'function' ? args.onStep : (() => {});
  return ctx;
}
async function screenDebugStep(args = {}) {
  // Sweep stale sessions — ctx.memory holds Sets/Maps; 10 min idle is dead.
  for (const [k, v] of _DEBUG_RUNS) if (Date.now() - v.touched > 10 * 60e3) _DEBUG_RUNS.delete(k);
  let run = args.runId && _DEBUG_RUNS.get(args.runId);
  // A passed runId must resolve — expired/missing ids error loudly instead of
  // minting a context-free run that pins whatever app is frontmost.
  if (args.runId && !run) return { ok: false, error: `no debug run ${args.runId} (expired — run screen.debug.start again)` };
  if (!run) {
    run = { id: `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      ctx: _debugCtx(args, args.steps || []), touched: Date.now() };
    _DEBUG_RUNS.set(run.id, run);
  }
  run.touched = Date.now();
  // App pinning — the goal app's window owns every parse in this run. Learned
  // on the first call's frontApp (or args.app); re-asserted before every
  // probe/commit/observe so a curl fired from another app can't parse the
  // terminal it ran in. settleMs covers focus + animation settle.
  run.app = args.app || run.app || run.ctx.app || run.ctx.browserName || null;
  const _ta = require('./screen.task.agent.cjs')._internals || {};
  let _prevApp = null;
  if (run.app) {
    run.ctx._dbgApp = run.app;
    // Remember the caller's app (Warp) so the screen can flip back after the
    // parse/action — the drill is driven entirely from the terminal.
    if (args.restoreFocus !== false) { try { _prevApp = await _ta.frontApp?.(); } catch (_) {} }
    try { await _ta.ensureFrontmost?.(run.app, { sessionId: args.sessionId }); } catch (_) {}
  }
  if (args.settleMs !== 0) await _sleep(Number.isFinite(+args.settleMs) ? +args.settleMs : 700);
  const goal = args.goal || args.prompt || run.ctx.goal || '';
  const step = { action: 'auto', goal, maxIters: 8, entityItems: args.entityItems };
  // Re-raise the caller's app — skipped while a context menu may be armed
  // (switching apps dismisses menus and kills the expectMenuAt seam).
  const _restore = () => {
    const armed = run.ctx.memory?.expectMenuAt != null;
    if (_prevApp && run.app && !armed && args.restoreFocus !== false
      && !_prevApp.toLowerCase().includes(run.app.toLowerCase())) {
      try { return _ta.focusApp?.(_prevApp).catch(() => null); } catch (_) {}
    }
    return null;
  };
  // Commit runs BEFORE inspect — a combined call is act→observe in one
  // roundtrip; the old order early-returned on inspect and silently dropped
  // the commit entirely.
  let _forced = null;
  if (args.commit && args.inspect) {
    const _copts = { dbgRun: run };
    if (typeof args.commit === 'object') _copts.forceAction = args.commit;
    else _copts.commitStep = true;
    const _cres = await runAutoLoop(step, run.ctx, 0, run.ctx.emit, 1, _copts);
    _forced = _cres?.forced ?? null;
    run._dirty = true;
  }
  if (args.inspect) {
    const r = await _dbgProbeView(run, args, args.inspect.scope || 'window', args.inspect.target);
    await _restore();
    return { runId: run.id, ...(_forced != null ? { forced: _forced } : {}), ...r, next: _dbgNext(run.id) };
  }
  const opts = { dbgRun: run };
  if (args.commit && typeof args.commit === 'object') opts.forceAction = args.commit;
  else if (args.commit) opts.commitStep = true;
  else opts.debugOnce = true;
  const res = await runAutoLoop(step, run.ctx, 0, run.ctx.emit, 1, opts);
  if (args.commit) run._dirty = true;
  if (!run.app && res?.scene?.frontApp && !run.ctx.startUrl && !run.ctx.browserName) {
    run.app = res.scene.frontApp; run.ctx._dbgApp = run.app;
  }
  await _restore();
  return { runId: run.id, ...res, ...(res?.debug ? { next: _dbgNext(run.id) } : {}) };
}

const _dbgNext = id => {
  const _c = inner => `curl -s :3007/screen.debug.step -H 'Content-Type: application/json' -d '${inner}'`;
  return {
    observe: _c(`{"payload":{"runId":"${id}","commit":false,"askModel":true}}`),
    commitProposal: _c(`{"payload":{"runId":"${id}","commit":true,"askModel":true}}`),
    forceAction: _c(`{"payload":{"runId":"${id}","commit":{"action":"right-click","target":"<element-id>"}}}`),
    inspectWindow: _c(`{"payload":{"runId":"${id}","inspect":{"scope":"window"}}}`),
    inspectRegion: _c(`{"payload":{"runId":"${id}","inspect":{"scope":"region","target":"sidebar-left"}}}`),
    inspectElement: _c(`{"payload":{"runId":"${id}","inspect":{"scope":"element","target":"<element-id>"}}}`),
    inspectBack: _c(`{"payload":{"runId":"${id}","inspect":{"scope":"back"}}}`),
    memory: `curl -s :3007/screen.debug.state -H 'Content-Type: application/json' -d '{"payload":{"runId":"${id}"}}'`,
  };
};

// ── Hierarchical probe views — window → region → element, all pre-commit ────
// rectParse does each zoom level; the package shape matches the decision seam
// so modelPayload replays at any depth. viewStack supports back-out; a commit
// sets run._dirty so the next window view reports the delta it caused.
const _dbgBands = dims => ({
  header: [0, 0, dims[0], 110],
  footer: [0, dims[1] - 110, dims[0], 110],
  'sidebar-left': [0, 110, Math.round(dims[0] * 0.22), dims[1] - 220],
  'sidebar-right': [Math.round(dims[0] * 0.72), 110, dims[0] - Math.round(dims[0] * 0.72), dims[1] - 220],
  main: [Math.round(dims[0] * 0.22), 110, Math.round(dims[0] * 0.5), dims[1] - 220],
});
const _REGION_ALIAS = { left: 'sidebar-left', library: 'sidebar-left', rail: 'sidebar-left', sidebar: 'sidebar-left',
  right: 'sidebar-right', panel: 'sidebar-right', lyrics: 'sidebar-right', content: 'main', results: 'main',
  center: 'main', top: 'header', nav: 'header', bottom: 'footer', media: 'footer', player: 'footer' };
const _bandOf = (c, dims) => c[1] < 110 ? 'header' : c[1] > dims[1] - 110 ? 'footer'
  : c[0] < dims[0] * 0.22 ? 'sidebar-left' : c[0] > dims[0] * 0.72 ? 'sidebar-right' : 'main';
function _msDiff(a, b) {
  const ac = {}, bc = {}; let added = 0, removed = 0;
  for (const l of a) ac[l] = (ac[l] || 0) + 1;
  for (const l of b) bc[l] = (bc[l] || 0) + 1;
  for (const l of Object.keys(bc)) { const d = bc[l] - (ac[l] || 0); if (d > 0) added += d; }
  for (const l of Object.keys(ac)) { const d = ac[l] - (bc[l] || 0); if (d > 0) removed += d; }
  return { added, removed };
}

// Resolve an element id across the view stack — deepest scope first. Probe
// elements carry absolute window coords, so a parent-scope id stays valid
// while zoomed into its children (the "no target 23" fix).
const _dbgFindEl = (run, target) => {
  const id = String(target ?? '').replace(/^#/, '');
  if (!id) return null;
  const st = run.viewStack || [];
  for (let i = st.length - 1; i >= 0; i--) {
    const hit = (st[i].els || []).find(e => String(e.id) === id);
    if (hit) return hit;
  }
  return null;
};

async function _dbgProbeView(run, args, scope, target) {
  const ctx = run.ctx;
  const { display, windowOnly } = ctx;
  run.viewStack = run.viewStack || [{ scope: 'window' }];
  if (scope === 'back' && run.viewStack.length > 1) run.viewStack.pop();
  const top = run.viewStack[run.viewStack.length - 1];
  if (scope === 'back') { scope = top.scope; target = top.target; }

  const parsed = await rectParse(null, { display, windowOnly });
  const els = parsed?.elements || [];
  const dims = [_pxW(parsed), _pxH(parsed)];
  const bands = _dbgBands(dims);
  const fa = parsed?.front_app || null;
  if (!run.app && fa && !ctx.startUrl && !ctx.browserName) { run.app = fa; ctx._dbgApp = fa; }
  const foreignApp = (run.app && fa && !fa.toLowerCase().includes(run.app.toLowerCase())) ? fa : null;
  const url = String(ctx.memory.winState?.url || '');
  const identity = `${fa}|${url}`;

  // Per-region label multisets — the same-domain change signal.
  const _labelSets = {};
  for (const e of els) {
    if (!e.center || !String(e.label || '').trim()) continue;
    const b = _bandOf(e.center, dims);
    (_labelSets[b] = _labelSets[b] || []).push(String(e.label).trim());
  }
  // Domain detection is unconditional — an app/url switch between calls is
  // never silent (the Warp-parses-as-sidebar bug). Delta stays post-commit.
  let changed = null, delta = null;
  if (foreignApp) changed = 'app';
  else if (run._prevIdentity != null && run._prevIdentity !== identity) {
    changed = 'domain';
    if (run._dirty) {
      run.viewStack = [{ scope: 'window' }]; scope = 'window'; target = undefined;
      delta = { domain: { from: run._prevIdentity.split('|')[0], to: fa } };
    }
  } else if (run._dirty) {
    changed = 'region'; delta = { regions: {} };
    for (const b of new Set([...Object.keys(run._prevLabels || {}), ...Object.keys(_labelSets)])) {
      const d = _msDiff((run._prevLabels || {})[b] || [], _labelSets[b] || []);
      if (d.added || d.removed) delta.regions[b] = d;
    }
  }
  run._dirty = false; run._prevIdentity = identity; run._prevLabels = _labelSets;

  // Resolve the view rect — stored on stack entries so 'back' re-parses it.
  // Reuse requires scope AND target to match — otherwise a new target in the
  // same scope would silently re-parse the previous frame's crop.
  let rect = (top.scope === scope && top.target === target && scope !== 'window') ? top.rect : null;
  if (scope === 'region' && !rect) {
    // Region rects come from the last window view's own tree (single source);
    // band heuristic only as fallback.
    const rr = run.regionRects || {};
    rect = rr[target] || rr[_REGION_ALIAS[String(target).toLowerCase()]]
      || bands[target] || bands[_REGION_ALIAS[String(target).toLowerCase()]] || null;
    if (!rect) return { ok: false, error: `unknown region "${target}" — one of: ${[...new Set([...Object.keys(rr), ...Object.keys(bands)])].join(' | ')}` };
  } else if (scope === 'element' && !rect) {
    const el = _dbgFindEl(run, target);
    if (!el) return { ok: false, error: `no element "${target}" in view stack (ids refresh per probe)` };
    rect = cropRectFor(el, 26);
  }

  const rp = rect ? await rectParse(rect, { display, windowOnly }) : null;
  const viewEls = rect ? (rp?.elements || []) : els;
  // Probe els carry no row composites (enrichLayout runs in the loop, not the
  // parse), but glyph priors + same-band controls still annotate usefully.
  _annotateAffords(viewEls);

  // Layout per depth — window boundary map, region rows, element children.
  let layout = '';
  if (scope === 'region' || (scope === 'window' && rect)) {
    const rows = viewEls.filter(e => e.center && String(e.label || '').trim())
      .sort((a, b) => a.center[1] - b.center[1]);
    const kids = e => viewEls.filter(o => o !== e && o.center && o.bbox && e.bbox
      && o.center[0] >= e.bbox[0] && o.center[0] <= e.bbox[0] + e.bbox[2]
      && o.center[1] > e.bbox[1] && o.center[1] < e.bbox[1] + e.bbox[3]).length;
    const lines = [`region "${target || 'view'}" @(${rect.map(v => Math.round(v)).join(',')}) — ${rows.length} rows`];
    // Same-band trailing control — the Add/›/⋯ sitting right of the row's own
    // box is its commit affordance, surfaced as a unit for the drill.
    const _ctlOf = r => viewEls.find(o => o !== r && o.center && o.bbox && r.bbox
      && Math.abs(o.center[1] - r.center[1]) < Math.max(16, (r.bbox[3] || 36) / 2)
      && o.center[0] > r.bbox[0] + r.bbox[2] && _isCtl(o));
    for (const r of rows.slice(0, 24)) {
      const k = kids(r);
      const _c = _ctlOf(r);
      const _ct = _c ? ` [ctl${_c._afford && _c._afford !== 'ctl' ? ':' + _c._afford : ''} "${String(_c.label || 'icon').slice(0, 16)}" #${_c.id}]` : '';
      lines.push(`  ├ ${/input|field/i.test(r.type || '') ? 'field' : 'row'} #${r.id} "${String(r.label).slice(0, 44)}"${k ? ` [${k} kids]` : ''}${_ct}`);
    }
    if (viewEls.some(e => e.bbox && e.bbox[1] + e.bbox[3] > rect[1] + rect[3] - 40)) lines.push('  └ … more below fold');
    layout = lines.join('\n');
  } else if (scope === 'element') {
    const lines = [`element "${String(target || '').slice(0, 50)}" @(${rect.map(v => Math.round(v)).join(',')}) — ${viewEls.length} children`];
    for (const c of viewEls.slice(0, 16)) lines.push(`  ├ ${c.type || 'el'} #${c.id} "${String(c.label || '').slice(0, 44)}"`);
    layout = lines.join('\n');
  } else {
    const { buildOcrTree, serializeRegions } = require('../skill-helpers/scene.graph.cjs');
    const _tree = buildOcrTree(els, { app: fa || 'app', domain: 'native', size: dims });
    layout = serializeRegions(_tree.tree,
      { url, changed: delta ? Object.keys(delta.regions || {}) : [] });
    // Region rects from this view's tree — the rect the map advertised is the
    // rect region-probes parse (single source, no band-vs-union drift).
    run.regionRects = {};
    const _domN = (_tree.tree.children || []).find(n => n.kind === 'domain') || _tree.tree;
    for (const rn of _domN.children || []) if (rn.kind === 'region' && rn.rect) run.regionRects[rn.label] = rn.rect;
  }

  if (!(top.scope === scope && top.target === target))
    run.viewStack.push({ scope, target, rect });
  // Each frame remembers its own elements — ids resolve deepest→shallowest.
  run.viewStack[run.viewStack.length - 1].els = viewEls;
  run.viewEls = viewEls;
  const pp = _pickPayload(viewEls, ctx.goal || '', { layout });
  return { ok: true, debug: true, probe: true, ...(foreignApp ? { foreignApp } : {}),
    view: { scope: scope === 'window' ? 'window' : `${scope}:${target}`, depth: run.viewStack.length - 1, rect, changed },
    scene: { layout, url: url || null, frontApp: fa, elements: viewEls.length, delta },
    candidates: viewEls.map(e => ({ line: describe(e), score: null, group: 'view', verdict: 'probe' })),
    queue: viewEls.map(e => describe(e)),
    modelPayload: { state: pp.state, questions: pp.questions },
    memory: { pendingVerify: [...(ctx.memory.pendingVerify || [])],
      destination: ctx.destination || null, phase: ctx.phase || null,
      frontApp: fa, url: url || null },
    acts: [`probe: ${scope}${target ? ` ${target}` : ''}`] };
}
function screenDebugState(args = {}) {
  const run = args.runId && _DEBUG_RUNS.get(args.runId);
  if (!run) return { ok: false, error: `no debug run ${args.runId}` };
  const m = run.ctx.memory || {};
  const dump = {};
  for (const [k, v] of Object.entries(m)) {
    dump[k] = v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v)
      : (Array.isArray(v) ? v : (v && typeof v === 'object' ? { ...v } : v));
  }
  return { ok: true, runId: run.id, destination: run.ctx.destination, phase: run.ctx.phase, memory: dump };
}

module.exports = { screenActAgent, screenDebugStep, screenDebugState };
