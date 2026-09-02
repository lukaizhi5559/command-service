'use strict';

/**
 * appKnowledge.cjs — Per-hostname web-app knowledge cache.
 *
 * Stores dynamically-acquired operational knowledge about web apps:
 * UI modes, shortcuts, element semantics, quirks, recovery moves,
 * verification signals. Populated by web.agent (research_app_behavior),
 * explore.agent (app-scan mode), failure postmortems, and user corrections.
 *
 * Cache location: ~/.thinkdrop/app-knowledge/<hostname>.json
 *
 * Schema (per file):
 * {
 *   hostname: "docs.google.com",
 *   lastUpdated: "2025-01-15T12:00:00Z",
 *   entries: [ { id, type, summary, details, source, confidence, verifiedRuns, lastVerified, ttlDays } ]
 * }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const logger = require('../../logger.cjs');

const APP_KNOWLEDGE_DIR = path.join(os.homedir(), '.thinkdrop', 'app-knowledge');
const DEFAULT_TTL_DAYS = 30;
const MAX_ENTRIES_PER_HOST = 50;
const MAX_SUMMARY_LEN = 280;

// ─── Internal helpers ──────────────────────────────────────────────────────

function _safeHostname(hostname) {
  if (!hostname) return null;
  const h = String(hostname).trim().toLowerCase().replace(/^www\./, '');
  // Sanitize for filename safety
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

function _cachePath(hostname) {
  return path.join(APP_KNOWLEDGE_DIR, `${hostname}.json`);
}

function _ensureDir() {
  try {
    if (!fs.existsSync(APP_KNOWLEDGE_DIR)) {
      fs.mkdirSync(APP_KNOWLEDGE_DIR, { recursive: true });
    }
  } catch (err) {
    logger.warn(`[appKnowledge] could not create ${APP_KNOWLEDGE_DIR}: ${err.message}`);
  }
}

function _nowISO() {
  return new Date().toISOString();
}

function _isExpired(entry, nowMs = Date.now()) {
  if (!entry || !entry.lastVerified) return true;
  const ttlDays = Number(entry.ttlDays) > 0 ? Number(entry.ttlDays) : DEFAULT_TTL_DAYS;
  const ageMs = nowMs - new Date(entry.lastVerified).getTime();
  return ageMs > ttlDays * 24 * 60 * 60 * 1000;
}

function _truncate(s, max) {
  s = String(s || '').trim();
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

// Stable id from hostname + summary fingerprint
function _makeId(hostname, summary) {
  const fp = String(summary || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const host = String(hostname || '').replace(/^www\./, '').split('.')[0];
  return `${host}.${fp || 'entry'}`.slice(0, 80);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Load cached knowledge entries for a hostname.
 * Expired entries are filtered out (and pruned from the file as a side effect).
 * Returns a confidence-sorted array of valid entries.
 */
function loadAppKnowledge(hostname) {
  const h = _safeHostname(hostname);
  if (!h) return [];

  try {
    const p = _cachePath(h);
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return [];

    const now = Date.now();
    const fresh = data.entries.filter(e => !_isExpired(e, now));
    // Prune expired entries in background if any were dropped
    if (fresh.length !== data.entries.length) {
      setImmediate(() => {
        try {
          _ensureDir();
          fs.writeFileSync(p, JSON.stringify({ ...data, entries: fresh, lastUpdated: _nowISO() }, null, 2));
        } catch (_) { /* non-fatal */ }
      });
    }
    // Sort by confidence desc, then verifiedRuns desc
    return fresh.sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.verifiedRuns || 0) - (a.verifiedRuns || 0));
  } catch (err) {
    logger.warn(`[appKnowledge] loadAppKnowledge(${h}) failed: ${err.message}`);
    return [];
  }
}

/**
 * Save (merge) new entries into the cache for a hostname.
 * Existing entries with the same id are updated (higher confidence wins for fields,
 * verifiedRuns is preserved). New entries are appended.
 * Returns the merged entry count.
 */
function saveAppKnowledge(hostname, newEntries) {
  const h = _safeHostname(hostname);
  if (!h || !Array.isArray(newEntries) || newEntries.length === 0) return 0;

  try {
    _ensureDir();
    const p = _cachePath(h);
    let data = { hostname: h, lastUpdated: _nowISO(), entries: [] };
    if (fs.existsSync(p)) {
      try { data = JSON.parse(fs.readFileSync(p, 'utf8')) || data; } catch (_) { /* keep default */ }
    }
    if (!Array.isArray(data.entries)) data.entries = [];

    const byId = new Map(data.entries.map(e => [e.id, e]));
    for (const ne of newEntries) {
      if (!ne || !ne.summary) continue;
      const id = ne.id || _makeId(h, ne.summary);
      const existing = byId.get(id);
      if (existing) {
        // Merge: take the higher-confidence summary/details; preserve verifiedRuns
        const newConf = Number(ne.confidence) || 0;
        const oldConf = Number(existing.confidence) || 0;
        byId.set(id, {
          ...existing,
          type: ne.type || existing.type,
          summary: newConf >= oldConf ? _truncate(ne.summary, MAX_SUMMARY_LEN) : existing.summary,
          details: { ...(existing.details || {}), ...(ne.details || {}) },
          source: newConf >= oldConf ? (ne.source || existing.source) : existing.source,
          confidence: Math.max(oldConf, newConf),
          verifiedRuns: existing.verifiedRuns || 0,
          lastVerified: newConf >= oldConf ? _nowISO() : existing.lastVerified,
          ttlDays: ne.ttlDays || existing.ttlDays || DEFAULT_TTL_DAYS,
        });
      } else {
        byId.set(id, {
          id,
          type: ne.type || 'quirk',
          summary: _truncate(ne.summary, MAX_SUMMARY_LEN),
          details: ne.details || {},
          source: ne.source || 'web_research',
          confidence: Math.min(1, Math.max(0, Number(ne.confidence) || 0.5)),
          verifiedRuns: 0,
          lastVerified: _nowISO(),
          ttlDays: ne.ttlDays || DEFAULT_TTL_DAYS,
        });
      }
    }

    // Cap entries: keep top N by confidence
    let merged = Array.from(byId.values());
    merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || (b.verifiedRuns || 0) - (a.verifiedRuns || 0));
    if (merged.length > MAX_ENTRIES_PER_HOST) merged = merged.slice(0, MAX_ENTRIES_PER_HOST);

    data.entries = merged;
    data.lastUpdated = _nowISO();
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
    return merged.length;
  } catch (err) {
    logger.warn(`[appKnowledge] saveAppKnowledge(${h}) failed: ${err.message}`);
    return 0;
  }
}

/**
 * Record verification outcome for an entry.
 * success=true → verifiedRuns++ and bump lastVerified + confidence slightly.
 * success=false → decay confidence; if it falls below 0.2, drop the entry.
 */
function recordVerification(hostname, entryId, success) {
  const h = _safeHostname(hostname);
  if (!h || !entryId) return;

  try {
    const p = _cachePath(h);
    if (!fs.existsSync(p)) return;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.entries)) return;

    let changed = false;
    data.entries = data.entries.filter(e => {
      if (e.id !== entryId) return true;
      if (success) {
        e.verifiedRuns = (e.verifiedRuns || 0) + 1;
        e.confidence = Math.min(1, (e.confidence || 0.5) + 0.05);
        e.lastVerified = _nowISO();
      } else {
        e.confidence = Math.max(0, (e.confidence || 0.5) - 0.15);
        if (e.confidence < 0.2) { changed = true; return false; } // drop
      }
      changed = true;
      return true;
    });
    if (changed) {
      data.lastUpdated = _nowISO();
      _ensureDir();
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    logger.warn(`[appKnowledge] recordVerification(${h}, ${entryId}, ${success}) failed: ${err.message}`);
  }
}

/**
 * Format entries as a markdown block for injection into _agentContext.
 * Size-capped; confidence-ranked; only includes entries above a minimum threshold.
 * Shortcuts are extracted into a dedicated section for easy LLM scanning.
 */
function formatForContext(entries, maxChars = 1200) {
  if (!Array.isArray(entries) || entries.length === 0) return '';

  const hostname = entries[0]._hostname || '';
  const shortcuts = entries.filter(e => e.type === 'shortcut' && e.details?.shortcut);
  const others = entries.filter(e => e.type !== 'shortcut');

  const lines = [];
  let total = 0;

  // Non-shortcut entries first (command_system, ui_mode, workflow, quirk, etc.)
  for (const e of others) {
    if ((e.confidence || 0) < 0.3) continue;
    const tag = e.type ? `[${e.type}]` : '';
    const line = `- ${tag} ${e.summary}`;
    if (total + line.length + 1 > maxChars * 0.6) break;
    lines.push(line);
    total += line.length + 1;
  }

  // Dedicated shortcuts section (easy for LLM to scan and pick)
  if (shortcuts.length > 0) {
    const shortcutLines = [];
    for (const e of shortcuts) {
      if ((e.confidence || 0) < 0.3) continue;
      const key = e.details.shortcut || '';
      // Extract the action from the summary (text after "to")
      const action = e.summary.replace(/^.*?\bto\s+/i, '').replace(/\.$/, '').slice(0, 60);
      const line = `- ${key}: ${action}`;
      if (total + line.length + 1 > maxChars) break;
      shortcutLines.push(line);
      total += line.length + 1;
    }
    if (shortcutLines.length > 0) {
      lines.push(`\n## App Shortcuts (${hostname})`);
      lines.push(...shortcutLines);
    }
  }

  if (lines.length === 0) return '';
  return `## App Knowledge (${hostname})\n${lines.join('\n')}`;
}

/**
 * Convenience: load + format in one call. Returns the markdown block (or empty string).
 */
function loadAndFormat(hostname, maxChars = 800) {
  const entries = loadAppKnowledge(hostname);
  if (entries.length === 0) return '';
  // Stamp hostname for the header
  const h = _safeHostname(hostname) || '';
  entries.forEach(e => { e._hostname = h; });
  return formatForContext(entries, maxChars);
}

/**
 * Returns true if the cache for a hostname is empty or all entries are stale
 * (i.e. a fresh research pass is warranted).
 */
function isCacheStale(hostname) {
  const entries = loadAppKnowledge(hostname);
  if (entries.length === 0) return true;
  // Stale if ALL entries are low-confidence (snippet-based fallback, not LLM-synthesized).
  // Snippet-based entries (confidence 0.5) are just article titles — not actionable.
  // LLM-synthesized entries (confidence >= 0.7) contain actionable knowledge.
  // JIT research entries (confidence 0.8) are highly actionable recovery moves.
  const hasHighConfidence = entries.some(e => (e.confidence || 0) >= 0.6);
  if (hasHighConfidence) return false;
  // Snippet-only entries (snippetOnly=true) are cached with a 1h TTL.
  // They're not actionable but provide context — reuse for 1h before re-researching.
  const _now = Date.now();
  const _hasFreshSnippet = entries.some(e =>
    e.snippetOnly && e.cachedAt && (_now - e.cachedAt) < 3600000 // 1 hour
  );
  if (_hasFreshSnippet) return false;
  return true;
}

/**
 * Returns true if the shortcut coverage for a hostname is sparse or outdated.
 * Triggers re-research when an app has fewer than 5 shortcut entries AND the
 * cache is older than 7 days. This catches apps with incomplete/wrong shortcut
 * data (e.g. twitter.com with 1 wrong Slack shortcut that never gets re-researched
 * because isCacheStale sees one high-confidence entry and returns false).
 */
function isShortcutCoverageStale(hostname) {
  const entries = loadAppKnowledge(hostname);
  const shortcuts = entries.filter(e => e.type === 'shortcut');
  if (shortcuts.length < 5) {
    // Sparse shortcuts — check age of oldest entry
    const now = Date.now();
    const oldest = entries.reduce((max, e) => {
      const age = now - new Date(e.lastVerified || 0).getTime();
      return age > max ? age : max;
    }, 0);
    // Re-research if older than 7 days AND fewer than 5 shortcuts
    return oldest > 7 * 24 * 60 * 60 * 1000;
  }
  return false;
}

// ─── Intent → URL mappings ─────────────────────────────────────────────────
// Verified intent→URL cache: stores the correct starting URL for a given
// hostname + intent (e.g. docs.google.com + content_create → /document/create).
// Populated by browser.agent after successful runs, seeded from
// KNOWN_BROWSER_SERVICES.intentUrls on first run. Verified via recordVerification.

/**
 * Load a verified intent→URL mapping for a hostname + intent.
 * Returns { url, confidence, verifiedRuns } or null if no entry exists.
 * Only returns entries with confidence >= 0.4 (below = decayed/untrusted).
 */
function loadIntentUrl(hostname, intent) {
  const h = _safeHostname(hostname);
  if (!h || !intent) return null;
  const entries = loadAppKnowledge(h);
  const match = entries.find(e =>
    e.type === 'intent_url' &&
    e.details?.intent === intent &&
    e.details?.url &&
    (e.confidence || 0) >= 0.4
  );
  if (!match) return null;
  return { url: match.details.url, confidence: match.confidence || 0, verifiedRuns: match.verifiedRuns || 0 };
}

/**
 * Save a verified intent→URL mapping for a hostname.
 * Uses a stable id so re-saves merge (update) rather than duplicate.
 * Confidence starts at 0.8 for seeded/template URLs, bumps via recordVerification.
 */
function saveIntentUrl(hostname, intent, url, taskPattern = null) {
  const h = _safeHostname(hostname);
  if (!h || !intent || !url) return 0;
  const id = `${h}.intent_url.${intent}`;
  return saveAppKnowledge(h, [{
    id,
    type: 'intent_url',
    summary: `${intent} → ${url}`,
    details: { intent, url, taskPattern },
    source: 'browser_agent_verified',
    confidence: 0.8,
    ttlDays: 90, // intent URLs are stable — longer TTL than quirks/shortcuts
  }]);
}

module.exports = {
  APP_KNOWLEDGE_DIR,
  loadAppKnowledge,
  saveAppKnowledge,
  recordVerification,
  formatForContext,
  loadAndFormat,
  isCacheStale,
  isShortcutCoverageStale,
  loadIntentUrl,
  saveIntentUrl,
  // Exposed for testing
  _makeId,
  _isExpired,
};
