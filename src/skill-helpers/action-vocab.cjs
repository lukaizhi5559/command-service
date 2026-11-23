'use strict';

// ---------------------------------------------------------------------------
// action-vocab.cjs — the ONE place action vocabulary lives.
//
// Replaces the ~200 scattered `const _x = /vocab/` literals: English-seeded,
// per-ACTION (not per-app) tables + normalized + fuzzy matching. This module
// is the FAST TIER of the classifier — free and deterministic — not the gate:
// what the table misses falls to Tier-3 (askDecision, in-language, no
// translation hop) or needsUser. Learned labels (Tier-3 hits) persist to
// ~/.thinkdrop/action-labels.json keyed by app — model cost paid once per
// app/language, then table-fast forever.
//
// Migration note: only the bulk-delete lane consumes this today. Other lanes
// keep their inline regexes — migrate incrementally, matching on the same
// normalize+fuzzy rules when you touch them.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../logger.cjs');

// ── Tables ─────────────────────────────────────────────────────────────────
// 'unfollow' is deliberately absent: an artist pin's only remove option is
// Unfollow, which the user defines as SKIP (pin ≠ playlist row).
const ACTION_VOCAB = {
  delete:  ['delete', 'remove', 'remove from', 'leave', 'archive', 'move to trash', 'clear'],
  confirm: ['delete', 'remove', 'confirm', 'ok', 'yes'],
  cancel:  ['cancel', 'keep', "don't", 'no'],
  add:     ['add', 'add to', 'save to'],
};
// Anti-vocab — a label that CONTAINS a delete word but does something else.
const ACTION_EXCLUDE = {
  delete: ['add to', 'save to', 'move to playlist', 'share', 'copy', 'export', 'pin',
           'create', 'new', 'rename', 'edit', 'details', 'invite', 'collaborat',
           'report', 'about', 'download', 'go to', 'open'],
  confirm: ['cancel', 'keep', "don't", 'no'],
};
// Nav chrome — short labeled singletons that are app furniture, not work rows.
const _NAV_LIST = ['home', 'search', 'browse', 'library', 'your library',
  'recents', 'recent', 'create', 'create playlist', 'new playlist', 'new', 'filter',
  'sort', 'grid', 'list', 'compact', 'upgrade', 'install', 'install app',
  'download', 'download app', 'settings', 'feed', 'discover', 'podcasts',
  'liked songs', 'your episodes', 'playlists', 'artists', 'albums', 'audiobooks'];
const NAV_FURNITURE = new Set(_NAV_LIST);
// OCR drops spaces — "YourLibrary" must hit the same veto as "Your Library".
const NAV_FURNITURE_SQUASH = new Set(_NAV_LIST.map(s => s.replace(/ /g, '')));
function isNavFurniture(label) {
  const n = normalizeLabel(label);
  return NAV_FURNITURE.has(n) || NAV_FURNITURE_SQUASH.has(n.replace(/ /g, ''));
}
const TRANSPORT_VOCAB = /\bplay\b|\bpause\b|\bnext\b|\bprevious\b|shuffle|repeat|volume|mute|lyrics|install|upgrade|\bdownload\b/i;
// Browser-native context-menu vocabulary — a right-click on dead space opens
// THIS menu (separate OS layer), not the app's row menu. ≥2 hits near the
// click point = browser chrome, never the work item's menu.
const BROWSER_MENU = /\bback\b|\bforward\b|\breload\b|save as|\bprint\b|inspect|select all|open quick search|view page source|translate|reading mode|open in reading/i;
// Regions that are never the work surface — icon strip, media bar, overlays.
const CHROME_REGION = /rail|media|panel|menu|tab|header|footer|omnibox|toolbar/i;
const ROW_ROLE = /listitem|row|cell|treeitem|article/i;
const LIST_CONTAINER = /list|listbox|tree|table|grid|outline|menu/i;

// ── Normalization ──────────────────────────────────────────────────────────
function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Token set for overlap math — drops sub-2-char noise.
function _tokens(s) { return normalizeLabel(s).split(' ').filter(t => t.length > 1); }

// ── Matching ───────────────────────────────────────────────────────────────
// classifyAction — is this label a member of `action`'s vocabulary?
// Word-boundary containment + fuzzy token overlap; `exclude` vetoes labels
// whose anti-vocab would mis-fire ("Move to playlist" contains no delete word
// but "Move to trash" does — exclusions keep the pair apart).
// Strong phrases override anti-vocab — OCR merges adjacent menu rows into
// one blob ("Report Remove from Your Library"), and excluding on 'report'
// vetoes the real action. No legitimate row is named "Remove from…".
const STRONG_PHRASE = {
  // remov.{0,2}from tolerates 1-2 OCR-mutated chars ("remov8from", "removXfrom")
  delete: /\bdelete\b|remov.{0,2}from|move to trash|\bleave\b/i,
  confirm: /\bdelete\b|\bconfirm\b/i,
};
function classifyAction(label, action, { extra = [], exclude } = {}) {
  const norm = normalizeLabel(label);
  if (!norm) return false;
  const excl = exclude || ACTION_EXCLUDE[action] || [];
  if (STRONG_PHRASE[action] && STRONG_PHRASE[action].test(norm)) return true;
  if (excl.some(x => norm.includes(x))) return false;
  const vocab = [...(ACTION_VOCAB[action] || []), ...extra];
  for (const v of vocab) {
    const nv = normalizeLabel(v);
    if (!nv) continue;
    if (norm === nv) return true;
    // Word-boundary containment — 'remove' hits 'Remove from profile',
    // never 'Removerly' or 'preremove'.
    if (norm.split(' ').includes(nv)) return true;
    if (nv.includes(' ') && norm.includes(nv)) return true;
    // Fuzzy: OCR drops a space or a char — "BandArtist" ≡ "Band Artist";
    // edit-tolerant containment on labels ≥8 normalized chars.
    if (norm.length >= 8) {
      const squashed = norm.replace(/ /g, ''), vsq = nv.replace(/ /g, '');
      if (vsq.length >= 5 && squashed.includes(vsq)) return true;
    }
  }
  return false;
}
// fuzzyMatch — generic label≈label equality for work-key/doneWork-style use.
// Normalized equality, squashed equality (space-drops), or ≥60% token overlap.
function fuzzyMatch(label, target) {
  const a = normalizeLabel(label), b = normalizeLabel(target);
  if (!a || !b) return false;
  if (a === b) return true;
  const asq = a.replace(/ /g, ''), bsq = b.replace(/ /g, '');
  if (asq.length >= 6 && bsq.length >= 6 && (asq.includes(bsq) || bsq.includes(asq))) return true;
  const at = _tokens(label), bt = new Set(_tokens(target));
  if (!at.length || !bt.size) return false;
  const hit = at.filter(t => bt.has(t)).length;
  return hit / Math.max(at.length, bt.size) >= 0.6;
}

// ── Learned labels — Tier-3 classifications persist per app ────────────────
const LABELS_FILE = path.join(os.homedir(), '.thinkdrop', 'action-labels.json');
function _load() { try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8')); } catch { return {}; } }
function _save(m) { try { fs.mkdirSync(path.dirname(LABELS_FILE), { recursive: true }); fs.writeFileSync(LABELS_FILE, JSON.stringify(m, null, 1)); } catch {} }
// learnedAction(app, label) → 'delete'|null — check the cache before the model.
function learnedAction(app, label) {
  const store = _load();
  return store[`${app || 'app'}:${normalizeLabel(label)}`] || null;
}
// learnAction — persist a Tier-3 classification (menu label → action).
function learnAction(app, label, action) {
  const store = _load();
  const key = `${app || 'app'}:${normalizeLabel(label)}`;
  if (store[key] === action) return;
  store[key] = action;
  _save(store);
  logger.info(`[vocab] learned ${app}:${normalizeLabel(label).slice(0, 30)} → ${action}`);
}

// ── Row admission (app-agnostic) ───────────────────────────────────────────
// A candidate work row is: structural row, OR inside a list-like container,
// OR a substantial label in a non-chrome region. Region names like 'library'
// are a hint — chrome regions and nav furniture are the hard exclusions.
function isWorkRowCandidate(e) {
  const label = String(e?.label || '').trim();
  const role = String(e?._role || e?.type || '');
  const containerRole = String(e?._containerRole || '');
  const region = String(e?._regionRole || e?.region || '');
  const ancestors = (e?.ancestors || []).map(a => String(a.role || a || '')).join(' ');
  if (label.length <= 2) return false;
  if (CHROME_REGION.test(region)) return false;
  if (isNavFurniture(label)) return false;
  if (TRANSPORT_VOCAB.test(label)) return false;
  if (e?._isRow || (e?._members || []).length >= 2 || ROW_ROLE.test(role) || ROW_ROLE.test(containerRole)) return true;
  if (LIST_CONTAINER.test(containerRole) || LIST_CONTAINER.test(ancestors)) return true;
  return label.length > 10;
}

module.exports = {
  ACTION_VOCAB, ACTION_EXCLUDE, NAV_FURNITURE, TRANSPORT_VOCAB, BROWSER_MENU, isNavFurniture,
  CHROME_REGION, ROW_ROLE, LIST_CONTAINER,
  normalizeLabel, classifyAction, fuzzyMatch,
  learnedAction, learnAction, isWorkRowCandidate,
};
