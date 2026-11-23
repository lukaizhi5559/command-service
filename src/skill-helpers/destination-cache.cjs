'use strict';

// ---------------------------------------------------------------------------
// destination-cache.cjs — verified destination discovery + cache.
//
// resolveDestination(name) — for "goto X / open X / in X" when X isn't in
// ui-plan's static DESTINATIONS table. Five tiers, everything learned writes
// back — same shape as resolveShortcut:
//   1. cache      ~/.thinkdrop/destination-cache.json
//   2. app probe  osascript 'path to application' / mdfind — exists without
//                 launching → {kind:'app'}
//   3. model      skill-llm recall ("official URL for X") → URL candidate
//   4. web        web.agent actionSearchAndNavigate ("X official website")
//   5. verify     HTTP probe on URL candidates BEFORE opening — a model's
//                 guess or a SERP result never launches unverified. Only
//                 verified results are written to cache.
//
// Result: { kind:'app'|'url', value, src } | null — caller decides focus/open.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const logger = require('../logger.cjs');

const CACHE_PATH = path.join(os.homedir(), '.thinkdrop', 'destination-cache.json');
const STALE_MS = 30 * 24 * 3600 * 1000;

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function _readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return {};
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) || {};
  } catch { return {}; }
}

function _writeCache(name, entry) {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const d = _readCache();
    d[normName(name)] = { ...entry, at: Date.now() };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(d, null, 2));
  } catch (err) { logger.warn(`[destination-cache] write failed: ${err.message}`); }
}

// ── Tier 2: local-app existence probe (no launch) ────────────────────────────
const _sh = (cmd, a, input) => new Promise((resolve) => {
  const p = execFile(cmd, a, { timeout: 5000 }, (e, stdout) => resolve(e ? null : String(stdout || '')));
  if (input != null && p.stdin) { p.stdin.write(input); p.stdin.end(); }
});

async function _probeApp(name) {
  // osascript resolves the real app name → .app path without launching.
  // Handles "Google Chrome" / "Visual Studio Code" style names.
  const esc = String(name).replace(/"/g, '');
  const out = await _sh('osascript', ['-e', `POSIX path of (path to application "${esc}")`]);
  if (out && /\.app\/?\s*$/.test(out.trim())) return { kind: 'app', value: out.trim().split('/').pop().replace(/\.app$/, ''), appPath: out.trim() };
  // mdfind fallback — exact-name .app match under /Applications or user dirs
  const md = await _sh('mdfind', [`kMDItemFSName=='${esc}.app'c`]);
  const hit = (md || '').split('\n').map(s => s.trim()).find(s => /\.app$/i.test(s));
  if (hit) return { kind: 'app', value: path.basename(hit, '.app'), appPath: hit };
  return null;
}

// ── URL extraction + verification ────────────────────────────────────────────
const _URL_RE = /https?:\/\/[^\s"'<>\])}]+/i;
const _SERP_HOST_RE = /\b(google|bing|duckduckgo|yahoo|baidu|yandex)\.(com|co|net)\b.*\/(search|s\?)/i;

function _extractUrl(text) {
  const m = String(text || '').match(_URL_RE);
  if (!m) return null;
  try { return new URL(m[0]).href; } catch { return null; }
}

// HTTP(S) GET, follows ≤3 redirects. Returns {ok, finalUrl, status}.
function _probeUrl(url, redirects = 3) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u.href, { timeout: 6000, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) ThinkDrop-destination-probe' } }, (res) => {
      res.resume(); // don't download the body
      const status = res.statusCode || 0;
      const loc = res.headers.location;
      if (status >= 300 && status < 400 && loc && redirects > 0) {
        let next = null;
        try { next = new URL(loc, u.href).href; } catch {}
        return resolve(next ? _probeUrl(next, redirects - 1) : { ok: false, status });
      }
      resolve({ ok: status >= 200 && status < 400, status, finalUrl: u.href });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}

// A URL candidate is openable iff: real http(s), not a SERP, HTTP probe lands.
async function _verifyUrl(url, name) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (_SERP_HOST_RE.test(url)) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    // Sanity: the destination name should plausibly relate to the domain —
    // prevents model/web returning "google.com" for "google docs" (the SERP
    // itself) or an unrelated spam domain. Loose check: any name token of
    // len>3 appears in the host, OR the host is a known-good TLD+second-level
    // matching the service's compact form.
    const tokens = normName(name).split(' ').filter(w => w.length > 2);
    const compactHost = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const compactName = normName(name).replace(/\s+/g, '');
    const nameHit = compactName && compactHost.includes(compactName.slice(0, Math.max(4, compactName.length - 2)));
    const tokenHit = tokens.some(t => compactHost.includes(t));
    if (!nameHit && !tokenHit && tokens.length) {
      logger.warn(`[destination-cache] reject ${url} — host doesn't match "${name}"`);
      return null;
    }
    const probe = await _probeUrl(url);
    // Cache the CANDIDATE, not the redirect target — opening docs.google.com
    // in the browser lands on the signed-in homepage; the probe's redirect
    // chain leads to a session-specific login URL that mustn't be stored.
    if (probe.ok) return url;
    logger.warn(`[destination-cache] probe failed ${url} (status ${probe.status || 'err'})`);
    return null;
  } catch { return null; }
}

// ── Tiers 3+4: model recall + web discovery ──────────────────────────────────
async function _modelRecall(name) {
  try {
    const { ask, isAvailable } = require('./skill-llm.cjs');
    if (!isAvailable()) return null;
    const text = await ask(
      `What is the official website URL for the service or app "${name}"? Answer ONLY with the full URL (https://...) or "none" if unknown. No explanation.`,
      { maxTokens: 40, temperature: 0 });
    return _extractUrl(text);
  } catch (err) { logger.warn(`[destination-cache] model recall failed: ${err.message}`); return null; }
}

async function _webDiscover(name) {
  try {
    const { actionSearchAndNavigate } = require('../skills/web.agent.cjs');
    const res = await actionSearchAndNavigate({ query: `${name} official website`, maxResults: 5 });
    const best = res?.bestUrl || null;
    return best ? _extractUrl(best) : null;
  } catch (err) { logger.warn(`[destination-cache] web discovery failed: ${err.message}`); return null; }
}

/**
 * resolveDestination(name, opts) → {kind:'app'|'url', value, src} | null
 * 'app' value = app name for `open -a`/`focus'; 'url' value = verified URL.
 * opts: { skipModel, skipWeb, create } — create=true means "make a new
 * document/artifact", so the create-URL wins (docs.new, sheets.new, figma.new
 * — the .new TLD convention, verified by probe before trusting).
 */
async function resolveDestination(name, opts = {}) {
  const key = normName(name) + (opts.create ? ' create' : '');
  if (!normName(name)) return null;

  // 1) cache
  const cached = _readCache()[key];
  if (cached && (Date.now() - cached.at < STALE_MS) && cached.kind && cached.value) {
    return { ...cached, src: 'cache' };
  }

  // 1.5) create-intent: <service>.new shortcut — a verified create-URL beats
  //      landing on the service home gallery ("Blank document" click avoided).
  if (opts.create) {
    const short = normName(name).replace(/^google\s+/, '').replace(/\s+/g, '');
    if (short.length > 2) {
      const verified = await _verifyUrl(`https://${short}.new`, name);
      if (verified) {
        _writeCache(key, { kind: 'url', value: verified, resolvedVia: 'new-shortcut' });
        logger.info(`[destination-cache] .new shortcut verified: "${name}" → ${verified}`);
        return { kind: 'url', value: verified, src: 'new-shortcut' };
      }
    }
  }

  // 2) local-app probe — a real .app wins over any URL guess ("figma" the app
  //    vs figma.com — user's apps take precedence, matching human expectation)
  const app = await _probeApp(name);
  if (app) {
    _writeCache(key, { kind: 'app', value: app.value, resolvedVia: 'app-probe' });
    logger.info(`[destination-cache] app probe: "${name}" → ${app.appPath}`);
    return { ...app, src: 'app-probe' };
  }

  // 3) model recall → verify
  if (!opts.skipModel) {
    const candidate = await _modelRecall(name);
    const verified = await _verifyUrl(candidate, name);
    if (verified) {
      _writeCache(key, { kind: 'url', value: verified, resolvedVia: 'model' });
      logger.info(`[destination-cache] model recall verified: "${name}" → ${verified}`);
      return { kind: 'url', value: verified, src: 'model' };
    }
  }

  // 4) web discovery → verify
  if (!opts.skipWeb) {
    const discovered = await _webDiscover(name);
    const verified = await _verifyUrl(discovered, name);
    if (verified) {
      _writeCache(key, { kind: 'url', value: verified, resolvedVia: 'web' });
      logger.info(`[destination-cache] web discovery verified: "${name}" → ${verified}`);
      return { kind: 'url', value: verified, src: 'web' };
    }
  }

  return null; // caller: honest failure, no blind click
}

module.exports = { resolveDestination, normName, _readCache, _writeCache, _probeApp, _verifyUrl, _extractUrl };
