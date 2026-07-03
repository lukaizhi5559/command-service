'use strict';

/**
 * ad-block-updater.cjs — Self-updating ad domain blocklist
 *
 * Fetches ad server domain lists from two authoritative, community-maintained
 * sources and caches them locally. Merged with a hardcoded baseline so blocking
 * always works even when offline.
 *
 * Sources:
 *   1. EasyList adservers  — ~3,000 domains, updated multiple times/week
 *   2. PGL YoYo adservers  — ~3,500 additional domains, independent coverage
 *
 * Cache: ~/.thinkdrop/adblock-domains.json
 * Refresh interval: ADBLOCK_REFRESH_DAYS env (default 7)
 *
 * API:
 *   getBlockedDomains()  → string[]  (sync, reads cache or returns baseline)
 *   refreshIfStale()     → Promise<{ refreshed, count, source }>
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

const CACHE_FILE = path.join(os.homedir(), '.thinkdrop', 'adblock-domains.json');
const REFRESH_DAYS = parseInt(process.env.ADBLOCK_REFRESH_DAYS || '7', 10);
const REFRESH_MS   = REFRESH_DAYS * 24 * 60 * 60 * 1000;

// ── Hardcoded baseline — always present, even if all fetches fail ─────────────
// Top ad networks by global traffic volume (EasyList + manual curation).
const BASELINE_DOMAINS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'pagead2.googlesyndication.com',
  'tpc.googlesyndication.com',
  'googleads.g.doubleclick.net',
  'adservice.google.com',
  'adnxs.com',
  'adnxs-simple.com',
  'taboola.com',
  'cdn.taboola.com',
  'trc.taboola.com',
  'media.net',
  'adsafeprotected.com',
  'moatads.com',
  'scorecardresearch.com',
  'quantserve.com',
  'pubmatic.com',
  'rubiconproject.com',
  'openx.net',
  'casalemedia.com',
  'contextweb.com',
  'criteo.com',
  'criteo.net',
  'bidswitch.net',
  'outbrain.com',
  'ads.twitter.com',
  'static.ads-twitter.com',
  'amazon-adsystem.com',
  'advertising.com',
  'yieldmanager.com',
  '2mdn.net',
  'adroll.com',
  'servedby.flashtalking.com',
  'flashtalking.com',
  'eyeota.net',
  'exelate.com',
  'bluekai.com',
  'turn.com',
  'spotxchange.com',
  'spotx.tv',
  'lijit.com',
  'sovrn.com',
  'indexexchange.com',
  'triplelift.com',
  'sharethrough.com',
  'smartadserver.com',
  'teads.tv',
  'outbrain.com',
  'zemanta.com',
];

// ── Remote sources ────────────────────────────────────────────────────────────
const SOURCES = [
  {
    name: 'easylist-adservers',
    url: 'https://raw.githubusercontent.com/easylist/easylist/master/easylist/easylist_adservers.txt',
    parse: parseEasyListHosts,
  },
  {
    name: 'pgl-yoyo',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&mimetype=plaintext&showintro=0',
    parse: parseHostsFile,
  },
];

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseEasyListHosts(text) {
  const domains = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;
    // EasyList adservers format: ||hostname^ or |https://hostname^
    const m = t.match(/^\|\|([a-z0-9._-]+)\^/i);
    if (m) {
      const d = m[1].toLowerCase().replace(/^\*\./, '');
      if (d && d.includes('.') && !d.startsWith('.')) domains.add(d);
    }
  }
  return [...domains];
}

function parseHostsFile(text) {
  const domains = new Set();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // hosts file: "127.0.0.1 hostname" or "0.0.0.0 hostname"
    const parts = t.split(/\s+/);
    if (parts.length >= 2) {
      const d = parts[1].toLowerCase();
      if (d && d.includes('.') && d !== 'localhost' && !d.startsWith('#')) {
        domains.add(d);
      }
    }
  }
  return [...domains];
}

// ── HTTP fetch (Node built-in, no npm) ────────────────────────────────────────

function fetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

// ── Cache helpers ─────────────────────────────────────────────────────────────

function _readCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (Array.isArray(raw.domains) && raw.domains.length > 0) return raw;
    }
  } catch (_) {}
  return null;
}

function _writeCache(domains) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      domains,
      fetchedAt: new Date().toISOString(),
      count: domains.length,
    }, null, 2), 'utf8');
  } catch (_) {}
}

function _isCacheStale(cache) {
  if (!cache?.fetchedAt) return true;
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  return age > REFRESH_MS;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sync — returns current blocklist from cache, or baseline if cache is missing.
 * Always fast (file read only). Call this from browser.act.cjs at require-time.
 */
function getBlockedDomains() {
  const cache = _readCache();
  if (cache?.domains?.length) return cache.domains;
  return [...BASELINE_DOMAINS];
}

/**
 * Async — fetches both sources, merges with baseline, writes cache.
 * No-ops if cache is fresh. Non-fatal: always resolves (never rejects).
 * Returns { refreshed: bool, count: number, source: string }
 */
async function refreshIfStale() {
  const cache = _readCache();
  if (!_isCacheStale(cache)) {
    return { refreshed: false, count: cache.domains.length, source: 'cache' };
  }

  const merged = new Set(BASELINE_DOMAINS);
  const sourcesUsed = [];

  for (const src of SOURCES) {
    try {
      const text = await fetchText(src.url);
      const domains = src.parse(text);
      let added = 0;
      for (const d of domains) { if (!merged.has(d)) { merged.add(d); added++; } }
      sourcesUsed.push(`${src.name}(+${added})`);
    } catch (err) {
      sourcesUsed.push(`${src.name}(failed: ${err.message?.slice(0, 60)})`);
    }
  }

  const domains = [...merged];
  _writeCache(domains);
  return { refreshed: true, count: domains.length, source: sourcesUsed.join(', ') };
}

module.exports = { getBlockedDomains, refreshIfStale, BASELINE_DOMAINS };
// BASELINE_DOMAINS is exported above for use in injected browser scripts where
// size constraints (macOS ARG_MAX ~1MB) prevent embedding the full cached list.
