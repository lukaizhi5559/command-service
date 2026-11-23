'use strict';

// ---------------------------------------------------------------------------
// shortcut-cache.cjs — runtime shortcut discovery + cache for desktop apps.
//
// resolveShortcut(app, intent) — five tiers, everything learned writes back:
//   1. cache   ~/.thinkdrop/app-shortcuts/<app>.json  (+ appKnowledge entries)
//   2. menubar /screen/menubar — real AX key equivalents (any app, deterministic)
//   3. model   skill-llm text recall (famous non-menu accelerators: Slack ⌘K)
//   4. web     web.agent research_app_behavior → shortcut entries → saveKnowledge
//   5. null    caller falls back to on-screen match/model pick
//
// Nothing is hand-seeded except the universal '*' table in app-shortcuts.cjs —
// discovery happens once per app+intent at runtime, cached for reuse. Stale /
// sparse coverage re-researches via appKnowledge's isShortcutCoverageStale.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const logger = require('../logger.cjs');
const { loadAppKnowledge, saveAppKnowledge, isShortcutCoverageStale } = require('../skills/lib/appKnowledge.cjs');
const { lookupShortcut } = require('./app-shortcuts.cjs');

const SCREEN_URL = process.env.MCP_SCREEN_URL || 'http://127.0.0.1:3008';
const CACHE_DIR = path.join(os.homedir(), '.thinkdrop', 'app-shortcuts');

// CGKeyCode → daemon KEYMAP name (mirror of td-ui-parse.swift KEYMAP).
const VKEY2NAME = {
  36: 'return', 48: 'tab', 49: 'space', 51: 'delete', 53: 'escape',
  123: 'left', 124: 'right', 125: 'down', 126: 'up', 115: 'home', 119: 'end',
  116: 'pageup', 121: 'pagedown',
  122: 'f1', 120: 'f2', 99: 'f3', 118: 'f4', 96: 'f5', 97: 'f6', 98: 'f7',
  100: 'f8', 101: 'f9', 109: 'f10', 103: 'f11', 111: 'f12',
  0: 'a', 11: 'b', 8: 'c', 2: 'd', 14: 'e', 3: 'f', 5: 'g', 4: 'h', 34: 'i',
  38: 'j', 40: 'k', 37: 'l', 46: 'm', 45: 'n', 31: 'o', 35: 'p', 12: 'q',
  15: 'r', 1: 's', 17: 't', 32: 'u', 9: 'v', 13: 'w', 7: 'x', 16: 'y', 6: 'z',
  29: '0', 18: '1', 19: '2', 20: '3', 21: '4', 23: '5', 22: '6', 26: '7',
  28: '8', 25: '9',
  27: '-', 24: '=', 33: '[', 30: ']', 39: "'", 41: ';', 42: '\\',
  43: ',', 44: '/', 47: '.', 50: '`',
};

// Menu glyph chars → daemon key name (PUA arrows/F-keys + symbols).
const GLYPH2NAME = {
  '⎋': 'escape', '\u{238b}': 'escape', '↩': 'return', '⏎': 'return',
  '⇥': 'tab', '\t': 'tab', '⌫': 'delete', '⌦': 'delete', '␣': 'space', ' ': 'space',
  '←': 'left', '→': 'right', '↑': 'up', '↓': 'down',
  '\u{f702}': 'left', '\u{f703}': 'right', '\u{f700}': 'up', '\u{f701}': 'down',
  '⇞': 'pageup', '⇟': 'pagedown', '↖': 'home', '↘': 'end',
  // PUA function keys F1..F19 (0xF704..0xF716)
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String.fromCodePoint(0xF704 + i), `f${i + 1}`])),
};

const normApp = (a) => String(a || '').toLowerCase().replace(/\.app$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const normIntent = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const _cachePath = (app) => path.join(CACHE_DIR, `${normApp(app)}.json`);

function _readCache(app) {
  try {
    const p = _cachePath(app);
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    return d && d.intents ? d : null;
  } catch { return null; }
}

function _writeCache(app, intent, entry) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const p = _cachePath(app);
    let d = { app, intents: {} };
    try { d = { ...d, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; } catch {}
    d.intents = d.intents || {};
    d.intents[normIntent(intent)] = { ...entry, at: new Date().toISOString() };
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  } catch (err) { logger.warn(`[shortcut-cache] write failed: ${err.message}`); }
}

// menubar item → {key, mods} in daemon-KEYMAP names, or null if unresolvable.
function _itemToCombo(item) {
  const mods = Array.isArray(item.mods) ? item.mods.slice() : [];
  let key = null;
  if (item.vkey != null && VKEY2NAME[item.vkey]) key = VKEY2NAME[item.vkey];
  else if (item.key) {
    const ch = String(item.key);
    const lower = ch.toLowerCase();
    key = GLYPH2NAME[ch] || GLYPH2NAME[lower]
      || (/^[a-z0-9\-=\[\]';\\,./`]$/.test(lower) ? lower : null);
  }
  return key ? { key, mods } : null;
}

// Score a menu item against an intent: exact > substring > token overlap.
function _menuScore(item, intentNorm) {
  const title = normIntent(item.title || '');
  const p = normIntent(item.path || '');
  if (!title && !p) return 0;
  if (title === intentNorm) return 100;
  if (title.includes(intentNorm) || p.includes(intentNorm)) return 80;
  const tw = new Set(title.split(' ').filter(w => w.length > 1));
  const iw = intentNorm.split(' ').filter(w => w.length > 1);
  if (!iw.length) return 0;
  const hit = iw.filter(w => tw.has(w) || p.includes(w)).length;
  const r = hit / iw.length;
  return r >= 0.5 ? Math.round(60 * r) : 0;
}

// Parse "cmd+shift+p" / "⌘⇧P" / "Ctrl+Alt+Space" → {key,mods}
function parseComboText(s) {
  if (!s) return null;
  const t = String(s).trim();
  // split "cmd+shift+p" / "⌘⇧P" into mod tokens + final key token
  const tokens = t.split(/\s*\+\s*/);
  let keyTok, modToks;
  if (/[⌘⇧⌥⌃]/.test(t)) {
    const glyphs = t.match(/[⌘⇧⌥⌃]/g) || [];
    modToks = glyphs;
    keyTok = t.replace(/[⌘⇧⌥⌃\s]/g, '');
  } else {
    if (tokens.length < 2) return null;
    keyTok = tokens.pop();
    modToks = tokens;
  }
  const mods = [];
  for (const mt of modToks.map(x => x.toLowerCase())) {
    if (/⌘|cmd|command|meta|win/.test(mt)) mods.push('cmd');
    else if (/⇧|shift/.test(mt)) mods.push('shift');
    else if (/⌥|alt|option/.test(mt)) mods.push('alt');
    else if (/⌃|ctrl|control/.test(mt)) mods.push('ctrl');
    else return null; // unrecognized mod token — not a combo
  }
  let key = keyTok.trim().toLowerCase()
    .replace(/enter|↩|⏎/g, 'return').replace(/esc(ape)?/g, 'escape')
    .replace(/space|␣/g, 'space').replace(/del(ete)?|⌫/g, 'delete')
    .replace(/←|left/g, 'left').replace(/→|right/g, 'right')
    .replace(/↑|up/g, 'up').replace(/↓|down/g, 'down');
  const keyOk = /^[a-z0-9]$/.test(key)
    || /^[\-=\[\]';\\,./`]$/.test(key)
    || /^(return|escape|space|delete|tab|left|right|up|down|f\d{1,2}|pageup|pagedown|home|end)$/.test(key);
  if (!keyOk || !mods.length) return null;
  return { key, mods };
}

async function _menubarItems() {
  try {
    const res = await new Promise((resolve, reject) => {
      const body = JSON.stringify({});
      const req = http.request(`${SCREEN_URL}/screen/menubar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 8000,
      }, (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end(body);
    });
    return res && res.items ? res : null;
  } catch { return null; }
}

// Cache + appKnowledge lookup (tier 1).
function _cacheLookup(app, intentNorm) {
  const c = _readCache(app);
  const hit = c?.intents?.[intentNorm];
  if (hit && hit.key) return { key: hit.key, mods: hit.mods || [], src: 'cache', path: hit.path };
  // appKnowledge shortcut entries: match details.action/summary to intent
  for (const e of loadAppKnowledge(app)) {
    if (e.type !== 'shortcut' || !e.details?.shortcut) continue;
    const names = [e.details.action, e.summary].filter(Boolean).map(normIntent);
    if (names.some(n => n === intentNorm || n.includes(intentNorm) || intentNorm.includes(n))) {
      const combo = parseComboText(e.details.shortcut);
      if (combo) return { ...combo, src: 'knowledge', path: e.summary };
    }
  }
  return null;
}

/**
 * resolveShortcut(app, intent, opts) → {key, mods, src, path?} | null
 * opts: { webResearch: async (app,intent)=>entries?, skipWeb, skipModel }
 */
async function resolveShortcut(app, intent, opts = {}) {
  const intentNorm = normIntent(intent);
  if (!intentNorm) return null;

  // 1) cache + appKnowledge
  const cached = _cacheLookup(app, intentNorm);
  if (cached) return cached;

  // 2) AX menubar — real key equivalents, discovered at runtime.
  // Reads the FRONTMOST app — caller must focus first. Guard against caching
  // a different app's items under this app's name.
  const mb = await _menubarItems();
  const mbApp = normApp(mb?.app || '');
  const wantApp = normApp(app);
  const appMatches = mbApp && wantApp && (mbApp === wantApp || mbApp.includes(wantApp) || wantApp.includes(mbApp));
  if (mb?.items?.length && !appMatches) {
    logger.warn(`[shortcut-cache] menubar is ${mb.app}, not ${app} — skipping menubar tier`);
  }
  if (mb?.items?.length && appMatches) {
    let best = null, bestScore = 0;
    for (const item of mb.items) {
      const s = _menuScore(item, intentNorm);
      if (s > bestScore) { bestScore = s; best = item; }
    }
    if (best && bestScore >= 60) {
      const combo = _itemToCombo(best);
      if (combo) {
        const entry = { ...combo, path: best.path, src: 'menubar' };
        _writeCache(app, intentNorm, entry);
        saveAppKnowledge(app, [{
          type: 'shortcut', summary: best.path,
          details: { shortcut: `${combo.mods.join('+')}${combo.mods.length ? '+' : ''}${combo.key}`, action: intentNorm, menuPath: best.path },
          source: 'ax_menubar', confidence: 0.9,
        }]);
        logger.info(`[shortcut-cache] menubar hit: ${app} "${intentNorm}" → "${best.path}" ${combo.mods.join('+')}+${combo.key}`);
        return { ...combo, src: 'menubar', path: best.path };
      }
    }
    // Menubar is also the app-level shortcut universe — persist a few for knowledge
    // (only when coverage is thin; cheap write-through for later lookups).
    if (isShortcutCoverageStale(app)) {
      const entries = mb.items.filter(i => i.key || i.vkey != null).slice(0, 60).map(i => {
        const c = _itemToCombo(i);
        return c ? { type: 'shortcut', summary: i.path, details: { shortcut: `${c.mods.join('+')}${c.mods.length ? '+' : ''}${c.key}`, action: i.title || i.path, menuPath: i.path }, source: 'ax_menubar', confidence: 0.85 } : null;
      }).filter(Boolean);
      if (entries.length) saveAppKnowledge(app, entries);
    }
    // Re-check knowledge after the bulk save — a differently-worded menu title may match
    const again = _cacheLookup(app, intentNorm);
    if (again) { _writeCache(app, intentNorm, again); return again; }
  }

  // 3) Local text-LLM recall — famous non-menu accelerators (Slack ⌘K, etc.)
  if (!opts.skipModel) {
    try {
      const { ask, isAvailable } = require('./skill-llm.cjs');
      if (isAvailable()) {
        const prompt = `On macOS, what is the keyboard shortcut for "${intentNorm}" in the ${app} app? Answer ONLY with the shortcut like "cmd+k" or "ctrl+shift+p", or "none" if unknown. No explanation.`;
        const text = await ask(prompt, { maxTokens: 30, temperature: 0 });
        const combo = parseComboText(text);
        if (combo) {
          _writeCache(app, intentNorm, { ...combo, src: 'model' });
          saveAppKnowledge(app, [{ type: 'shortcut', summary: `${intentNorm} → ${combo.mods.join('+')}+${combo.key}`, details: { shortcut: `${combo.mods.join('+')}${combo.mods.length ? '+' : ''}${combo.key}`, action: intentNorm }, source: 'model_recall', confidence: 0.55 }]);
          logger.info(`[shortcut-cache] model recall: ${app} "${intentNorm}" → ${combo.mods.join('+')}+${combo.key}`);
          return { ...combo, src: 'model' };
        }
      }
    } catch (err) { logger.warn(`[shortcut-cache] model recall failed: ${err.message}`); }
  }

  // 4) Online research — writes to appKnowledge so next lookup is tier-1
  if (!opts.skipWeb) {
    try {
      const { actionResearchAppBehavior } = require('../skills/web.agent.cjs');
      const res = await actionResearchAppBehavior({ domain: app, query: `${intentNorm} keyboard shortcut macos` });
      const entries = (res?.entries || []).filter(e => e.type === 'shortcut' && e.details?.shortcut);
      let best = null, bestScore = 0;
      for (const e of entries) {
        const names = [e.details.action, e.summary].filter(Boolean).map(normIntent);
        const s = Math.max(...names.map(n => _menuScore({ title: n, path: n }, intentNorm)));
        if (s > bestScore) { bestScore = s; best = e; }
      }
      if (best && bestScore >= 60) {
        const combo = parseComboText(best.details.shortcut);
        if (combo) {
          _writeCache(app, intentNorm, { ...combo, path: best.summary, src: 'web' });
          saveAppKnowledge(app, [best]);
          logger.info(`[shortcut-cache] web research: ${app} "${intentNorm}" → ${combo.mods.join('+')}+${combo.key}`);
          return { ...combo, src: 'web', path: best.summary };
        }
      }
    } catch (err) { logger.warn(`[shortcut-cache] web research failed: ${err.message}`); }
  }

  // 5) universal '*' fallback table (find/open/save/quit etc.)
  const generic = lookupShortcut(app, intentNorm);
  if (generic?.table === '*') {
    _writeCache(app, intentNorm, { key: generic.key, mods: generic.mods, path: generic.desc, src: 'generic' });
    return { key: generic.key, mods: generic.mods, src: 'generic', path: generic.desc };
  }
  return null; // caller: on-screen match/model pick
}

module.exports = { resolveShortcut, parseComboText, VKEY2NAME, GLYPH2NAME, _cachePath, _readCache, _menuScore };
