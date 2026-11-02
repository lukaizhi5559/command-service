#!/usr/bin/env node
'use strict';

/**
 * cleanup-intent-url-poison.cjs — purge intent_url entries that carry
 * task-specific query strings out of ~/.thinkdrop/app-knowledge/*.json.
 *
 * Background: the intent_url cache is meant to hold reusable destination
 * SHAPES (compose page, upload page, create form). For a stretch it stored
 * landed URLs verbatim — including per-task search queries — and those
 * entries get served to unrelated future tasks ("goto the latest AI video"
 * → youtube.com/results?search_query=his+videos from an old "his videos"
 * run; google.com/search?q=best+vegan+food+in+Philadelphia for any google
 * search).
 *
 * What it does per entry:
 *   - query-bearing / entity-parameterized URL → REMOVE from intent_url.
 *   - if the URL's query can be templated ({query} placeholder), salvage it
 *     into the search-pattern cache via recordSearchUrlPattern — the learned
 *     value is the URL SHAPE, not the baked string.
 *   - benign action params (compose=new, shareActive, action=TEMPLATE) → KEEP.
 *
 * Usage:
 *   node scripts/cleanup-intent-url-poison.cjs            # dry run — report only
 *   node scripts/cleanup-intent-url-poison.cjs --write    # apply changes
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Env for the search-pattern salvage — recordSearchUrlPattern → skill-db →
// user-memory service (:3001) requires MCP_USER_MEMORY_API_KEY. Without this
// standalone runs 401 and every salvage silently no-ops (first-pass did: 14
// "salvage failures").
try { require('dotenv').config({ path: path.join(__dirname, '../../../.env') }); } catch (_) {}

const DIR = path.join(os.homedir(), '.thinkdrop', 'app-knowledge');
const WRITE = process.argv.includes('--write');

const { _searchPatternFromQueryUrl, recordSearchUrlPattern } = require('../src/skill-helpers/destination-resolver.cjs');

// Same shape as appKnowledge.cjs's _intentUrlCarriesTaskContent — kept here so
// the script runs standalone (also exports nothing it shouldn't).
const TASK_QUERY_PARAM_RE = /[?&#](?:q|k|query|search_query|searchterm|search|keyword|keywords|term|field-keywords|s|st|find_desc|_nkw|text|body|channel|subject|message|caption|title|dtstart|dtend|location|redir)=/i;
function _carriesTaskContent(url) {
  const u = String(url || '');
  if (!u) return false;
  if (u.includes('{query}')) return true;
  if (TASK_QUERY_PARAM_RE.test(u)) return true;
  if (/#\/?!?\/?(?:search|results|find|query|q|s)[\/=]/i.test(u)) return true;
  return false;
}

function _serviceKeyFromHost(host) {
  return String(host || '').replace(/^www\./, '').replace(/[^a-z0-9]/g, '');
}

(async () => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.json')) : [];
  let hosts = 0, removed = 0, kept = 0, salvaged = 0, salvageFailed = 0;

  for (const file of files) {
    const p = path.join(DIR, file);
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(data?.entries)) continue;
    const host = data.hostname || file.replace(/\.json$/, '');
    const svcKey = _serviceKeyFromHost(host);

    let dirty = false;
    const next = [];
    for (const e of data.entries) {
      if (e.type !== 'intent_url' || !e.details?.url) { next.push(e); continue; }
      const url = e.details.url;
      if (!_carriesTaskContent(url)) { next.push(e); kept++; continue; }

      removed++;
      console.log(`REMOVE ${host} :: ${e.details.intent || '?'} → ${url.slice(0, 110)}`);

      const tmpl = _searchPatternFromQueryUrl(url);
      if (tmpl) {
        if (WRITE) {
          try {
            const ok = await recordSearchUrlPattern(svcKey, tmpl, null, 'cleanup-salvage', host);
            if (ok) { salvaged++; console.log(`  ↳ salvaged pattern → ${tmpl.slice(0, 110)}`); }
            else salvageFailed++;
          } catch (_) { salvageFailed++; }
        } else {
          console.log(`  ↳ would salvage pattern → ${tmpl.slice(0, 110)}`);
        }
      }
      dirty = true;
    }

    if (dirty) {
      hosts++;
      if (WRITE) {
        data.entries = next;
        data.lastUpdated = new Date().toISOString();
        fs.writeFileSync(p, JSON.stringify(data, null, 2));
      }
    }
  }

  console.log(`\n${WRITE ? 'APPLIED' : 'DRY RUN'} — ${hosts} host file(s) affected, ${removed} poisoned intent_url entries removed, ${kept} clean intent_url entries kept, ${salvaged} patterns salvaged${salvageFailed ? `, ${salvageFailed} salvage failures` : ''}.`);
  if (!WRITE) console.log('Run with --write to apply.');
})().catch(e => { console.error('cleanup failed:', e); process.exit(1); });
