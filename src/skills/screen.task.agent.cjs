// screen.task.agent.cjs — Prompt-level orchestrator for the pure-vision loop.
//
//   prompt → ui-plan (setup+steps) → setup (open/focus/url) →
//   screenActAgent (observe→resolve→act→verify per step) → report
//
// The ONLY skill that takes a raw natural-language prompt for screen
// automation. Emits progress lines so wall-clock never reads as dead air —
// "focused Slack", "clicked chrisakers", "verified hello on screen".

const { execFile } = require('child_process');
const os = require('os');
const logger = require('../logger.cjs');
const { deriveSteps } = require('../skill-helpers/ui-plan.cjs');
const { screenActAgent } = require('./screen.act.agent.cjs');

// ── Cancellation ─────────────────────────────────────────────────────────────
// _TASK_SIGNAL binds the caller's AbortSignal for the duration of
// screenTaskAgent (the screen lane serializes screen runs). Every await
// boundary re-checks it and sleep() resolves early on abort — a cancel
// mid-typing/clicking stops before the next CGEvent instead of draining.
let _TASK_SIGNAL = null;
const _aborted = () => !!_TASK_SIGNAL?.aborted;
const sleep = (ms) => new Promise(r => {
  if (_aborted()) return r();
  const t = setTimeout(r, ms);
  _TASK_SIGNAL?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
const sh = (cmd, a) => new Promise(r => execFile(cmd, a, e => r(!e)));
const shOut = (cmd, a, timeoutMs = 5000) => new Promise(r =>
  execFile(cmd, a, { timeout: timeoutMs }, (e, o) => r(e ? null : String(o || ''))));

async function progress(args, msg) {
  logger.info(`[screen.task] ${msg}`);
  if (_aborted()) return;
  const cb = args._progressCallbackUrl;
  if (cb) {
    // terminal:activity is whitelisted on /agent-turn — reaches the overlay
    // ticker and (when the avatar surface is up) the one-liner thinking label.
    fetch(cb, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'terminal:activity', line: msg, ts: Date.now() }) }).catch(() => {});
  }
}

// Live step rows for the AutomationProgress card — agent:turn_live is the same
// shape cli.agent uses; stepIndex ties rows to the plan step this task runs as.
function stepLive(args, i, n, label) {
  const cb = args._progressCallbackUrl;
  if (!cb || _aborted()) return;
  fetch(cb, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'agent:turn_live', agentId: 'screen.agent',
      turn: i + 1, maxTurns: n || 1, stepIndex: args._stepIndex ?? 0,
      currentAction: String(label || 'working').slice(0, 80) }) }).catch(() => {});
}

// App → bundle-id pinning. Same-prefix siblings are separate apps — "Google
// Chrome" vs "Google Chrome for Testing" share a name prefix, so `open -a`
// can raise the wrong one and a fuzzy name check can accept it. The bundle
// id is the only unambiguous identity.
const _BUNDLE = {
  'google chrome': 'com.google.Chrome',
  'chrome': 'com.google.Chrome',
  'google chrome for testing': 'com.google.Chrome.for.testing',
  'chrome for testing': 'com.google.Chrome.for.testing',
  'safari': 'com.apple.Safari',
  'microsoft edge': 'com.microsoft.edgemac',
  'firefox': 'org.mozilla.firefox',
  'brave browser': 'com.brave.Browser',
  'arc': 'company.thebrowser.Browser',
  'spotify': 'com.spotify.client',
  'warp': 'dev.warp.Warp-Stable',
};
const _bundleFor = app => _BUNDLE[String(app || '').toLowerCase()] || null;

async function frontWindow() {
  try {
    const r = await fetch('http://localhost:3008/screen/parse', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display: -1 }),
    }).then(x => x.json());
    return { app: r?.front_app || null, bundle: r?.front_bundle || null };
  } catch { return { app: null, bundle: null }; }
}

async function frontApp() {
  return (await frontWindow()).app;
}

async function ensureFrontmost(app, args) {
  // Setup verify — `open -a`/focus can silently no-op (multi-window, dialogs).
  // Check eyes before firing shortcuts into the void.
  const wantB = _bundleFor(app);
  for (let i = 0; i < 3; i++) {
    if (_aborted()) return false;
    const w = await frontWindow();
    const fa = w.app;
    // Bundle match is authoritative when the app is mapped and the service
    // reports it — a name-similar sibling (Chrome for Testing) can NEVER
    // satisfy a bundle-pinned check. Name-exact is the fallback for unmapped
    // apps or services that omit front_bundle.
    if (wantB && w.bundle && w.bundle.toLowerCase() === wantB.toLowerCase()) return true;
    if (wantB && !w.bundle && fa && fa.toLowerCase() === app.toLowerCase()) return true;
    if (!wantB && fa && fa.toLowerCase() === app.toLowerCase()) return true;
    // Unmapped apps keep the fuzzy retry — mapped apps must match by bundle,
    // so a sibling's prefix name passing on the last retry is a real bug,
    // not a fallback.
    if (!wantB && fa && fa.toLowerCase().includes(app.toLowerCase()) && i === 2) return true;
    await progress(args, `${app} not frontmost (got ${fa || w.bundle || '?'}) — retry ${i + 1}`);
    await focusApp(app); await sleep(800);
  }
  return false;
}

// Which browser owns URLs — LaunchServices' https handler, resolved once.
// `open <url>` alone creates the tab but can leave the browser unfocused
// (other space, slow raise) — so we `open -a <browser> <url>` and verify.
let _browser = null;
async function defaultBrowser() {
  if (_browser) return _browser;
  try {
    const out = await sh('plutil', ['-p', `${os.homedir()}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`]);
    const m = String(out || '').match(/LSHandlerURLScheme[^=]*=\s*"?https[\s\S]*?LSHandlerRoleAll\s*=\s*"([^"]+)"/);
    const bid = m?.[1];
    if (bid) {
      const p = await sh('mdfind', [`kMDItemCFBundleIdentifier == '${bid}'`]);
      const appPath = (p || '').split('\n').find(l => /\.app\s*$/.test(l.trim()));
      if (appPath) _browser = appPath.trim().split('/').pop().replace(/\.app$/, '');
    }
  } catch {}
  _browser = _browser || 'Google Chrome';
  return _browser;
}

async function runSetup(spec, args) {
  const browser = await defaultBrowser();
  for (const s of spec || []) {
    if (_aborted()) return;
    if (s.waitMs) { await progress(args, `waiting ${s.waitMs}ms`); await sleep(s.waitMs); continue; }
    if (s.openApp) {
      const app = typeof s.openApp === 'string' ? s.openApp : s.openApp.name;
      // App-or-browser: probe whether the app is actually installed before
      // `open -a` fails into an unfocusable void. A miss falls back to
      // destination discovery (cache → model recall → verified web URL), so
      // "open Spotify" on a machine without the app still reaches the web
      // player instead of burning the task on a nonexistent binary.
      const installed = await sh('mdfind', [`kMDItemContentTypeTree == 'com.apple.application-bundle'`, '-name', app])
        .then(o => (o || '').split('\n').some(l => l.trim().toLowerCase().endsWith('.app') && l.toLowerCase().includes(app.toLowerCase())))
        .catch(() => true); // probe failure → assume installed, let `open -a` decide
      if (!installed) {
        await progress(args, `${app} not installed — discovering a web destination`);
        try {
          const { resolveDestination } = require('../skill-helpers/destination-cache.cjs');
          const r = await resolveDestination(app, {});
          if (r?.kind === 'url') {
            await progress(args, `opening ${r.value} in ${browser} (${r.src})`);
            await sh('open', ['-a', browser, r.value]);
            args._frontApp = browser; args._startUrl = r.value; args._browserName = browser;
            await sleep(1200); await ensureFrontmost(browser, args);
          } else {
            await progress(args, `${app} not installed and no web destination found`);
          }
        } catch (e) {
          await progress(args, `${app} not installed; discovery failed: ${e.message}`);
        }
        continue;
      }
      await progress(args, `opening ${app}`);
      await sh('open', ['-a', app]);
      args._frontApp = app;
      if (s.focus !== false) { await sleep(800); await ensureFrontmost(app, args); }
      continue;
    }
    if (s.focus) { await progress(args, `focusing ${s.focus}`); await ensureFrontmost(s.focus, args); args._frontApp = s.focus; continue; }
    if (s.focusTab) {
      // Open-doc tab resolution — "my open Google Sheet" claims a live doc
      // tab, which may sit in ANY window; app focus alone can leave an
      // unrelated tab/window frontmost (observed: paste splatted into the
      // doc-picker's search field; front window drifted to YouTube mid-run).
      // AppleScript enumerates every window's tabs, activates the first URL
      // containing s.focusTab.match, and raises that window.
      const app = s.focusTab.app || browser;
      const match = String(s.focusTab.match || '').replace(/"/g, '');
      const isSafari = /safari/i.test(app);
      const enumScript = `tell application "${app}"\n`
        + `  set out to ""\n`
        + `  repeat with w from 1 to count of windows\n`
        + `    repeat with t from 1 to count of tabs of window w\n`
        + `      set out to out & w & "," & t & "," & (URL of tab t of window w) & linefeed\n`
        + `    end repeat\n`
        + `  end repeat\n`
        + `  return out\n`
        + `end tell`;
      let out = await shOut('osascript', ['-e', enumScript]);
      if (out == null) {
        // Browser may not be running — bring it up and retry once.
        await sh('open', ['-a', app]).catch(() => null);
        await sleep(900);
        out = await shOut('osascript', ['-e', enumScript]);
      }
      const hit = String(out || '').split('\n')
        .map(l => l.trim())
        .filter(l => l && l.includes(match))
        .map(l => l.split(','))
        .filter(parts => parts.length >= 2)[0];
      if (hit) {
        const [w, t] = hit;
        const activate = isSafari
          ? `tell application "${app}" to set current tab of window ${w} to tab ${t} of window ${w}`
          : `tell application "${app}" to set active tab index of window ${w} to ${t}`;
        await sh('osascript', ['-e', activate]).catch(() => null);
        await sh('osascript', ['-e', `tell application "${app}" to set index of window ${w} to 1`]).catch(() => null);
        await progress(args, `tab ${w},${t} matched "${match}" — activating`);
        args._tabMatch = match;
      } else if (s.focusTab.fallbackUrl) {
        // No live doc tab — navigate to a real surface instead of splatting
        // the task onto an unrelated frontmost tab (observed: TSV paste into
        // a Google search page). .new lands on a real /d/ URL, so the drift
        // pin stays armed on the SAME marker.
        await progress(args, `no tab matching "${match}" — opening ${s.focusTab.fallbackUrl}`);
        await sh('open', ['-a', app, s.focusTab.fallbackUrl]);
        args._startUrl = s.focusTab.fallbackUrl;
        args._tabMatch = match;
        await sleep(2500);
      } else {
        await progress(args, `no tab matching "${match}" — continuing on frontmost`);
      }
      args._frontApp = app;
      await sleep(600);
      await ensureFrontmost(app, args);
      continue;
    }
    if (s.openUrl) {
      await progress(args, `opening ${s.openUrl} in ${browser}`);
      await sh('open', ['-a', browser, s.openUrl]);
      args._frontApp = browser;
      args._startUrl = s.openUrl;
      args._browserName = browser;
      await sleep(1200);
      await ensureFrontmost(browser, args);
      continue;
    }
    if (s.discover) {
      // Destination discovery — resolveDestination (cache → app probe →
      // model recall → web discovery → HTTP-verify → cache). An app win
      // gets open+focus-verify; a verified URL gets `open -a browser` +
      // frontmost check. create intent → .new shortcut (docs.new …).
      // A miss fails honestly instead of clicking a random matched element.
      await progress(args, `discovering ${s.discover}`);
      try {
        const { resolveDestination } = require('../skill-helpers/destination-cache.cjs');
        const create = !!(args.text || args.title || (args.plan?.steps || []).some(st => st.action === 'paste' || st.action === 'type'));
        const r = await resolveDestination(s.discover, { create });
        if (r?.kind === 'app') {
          await progress(args, `opening ${r.value} (${r.src})`);
          await sh('open', ['-a', r.value]);
          args._frontApp = r.value;
          await sleep(800);
          await ensureFrontmost(r.value, args);
        } else if (r?.kind === 'url') {
          await progress(args, `opening ${r.value} in ${browser} (${r.src})`);
          await sh('open', ['-a', browser, r.value]);
          args._frontApp = browser;
          args._startUrl = r.value;
          args._browserName = browser;
          await sleep(1200);
          await ensureFrontmost(browser, args);
        } else {
          await progress(args, `could not resolve "${s.discover}" — no verified app or URL`);
        }
      } catch (e) {
        await progress(args, `discovery failed for "${s.discover}": ${e.message}`);
      }
      continue;
    }
    if (s.jsEval) {
      // DOM-side setup — e.g. focusing the Sheets grid via the name box, a
      // deterministic move that keystrokes can't reach on a fresh tab.
      const app = s.jsEvalApp || browser;
      const out = await require('../skill-helpers/browser-js.cjs').browserJs(app, s.jsEval);
      await progress(args, out != null ? `js: ${String(out).slice(0, 60)}` : 'js eval unavailable — continuing');
      continue;
    }
    if (s.key) {
      const { keyboardAgent } = require('./keyboard.agent.cjs');
      await keyboardAgent({ key: s.key, mods: s.mods || [], sessionId: args.sessionId, _abortSignal: _TASK_SIGNAL });
      continue;
    }
  }
}

async function focusApp(app) {
  // Bundle-pinned raise first — `open -b com.google.Chrome` can't resolve to
  // "Chrome for Testing" the way a fuzzy `open -a "Google Chrome"` can.
  const b = _bundleFor(app);
  if (b) { try { await sh('open', ['-b', b]); return true; } catch (_) {} }
  try {
    const r = await fetch('http://localhost:3008/screen/act', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'focus', app }),
    }).then(x => x.json());
    if (!r?.success) await sh('open', ['-a', app]);
    return r?.success;
  } catch { await sh('open', ['-a', app]); return true; }
}

// ── Map-tree: procedural knowledge for novel UI goals ────────────────────────
// Before walking blind, research "how to <verb> <object> in <app>" and distill
// the tutorial into BOTH a vocabulary map {controls, order, avoid} (scoring
// priors for the walk) and bite-size executable steps (click X → type entity →
// click Add → verify). Maps persist per task-shape in ~/.thinkdrop/ui-maps —
// first run pays the research cost ("learning how to X"), later runs replay.
const _uiMapCache = new Map();
const _UIMAP_DIR = `${os.homedir()}/.thinkdrop/ui-maps`;

function _uiMapFile(taskKey) { return `${_UIMAP_DIR}/${taskKey}.json`; }
function _loadPersistedMap(taskKey) {
  try { const m = JSON.parse(require('fs').readFileSync(_uiMapFile(taskKey), 'utf8')); return m?.steps?.length || m?.controls?.length ? m : null; }
  catch { return null; }
}
function _persistMap(taskKey, map) {
  try { require('fs').mkdirSync(_UIMAP_DIR, { recursive: true }); require('fs').writeFileSync(_uiMapFile(taskKey), JSON.stringify({ ...map, savedAt: Date.now() }, null, 2)); } catch {}
}

// Whitelist + hydrate synthesized steps. The model sees generic task text;
// {{entity}} slots get filled with THIS prompt's payload (song, file, …).
// Anything outside the action vocabulary is dropped — a hallucinated action
// is worse than no step.
const _MAP_ACTIONS = new Set(['click', 'type', 'key', 'shortcut', 'scroll', 'verify', 'paste', 'select']);
function _sanitizeMapSteps(raw, entities) {
  if (!Array.isArray(raw)) return [];
  const ent = entities?.[0] || null;
  const out = [];
  for (const s of raw.slice(0, 10)) {
    if (!s || !_MAP_ACTIONS.has(s.action)) continue;
    const step = { action: s.action, why: `maptree:${s.why || s.action}` };
    let text = s.match != null ? String(s.match) : (s.text != null ? String(s.text) : null);
    if (text && /\{\{\s*entity\s*\}\}/i.test(text)) { if (!ent) continue; text = text.replace(/\{\{\s*entity\s*\}\}/gi, ent); }
    if (s.action === 'click' || s.action === 'select') {
      if (!text || text.length > 60) continue;
      step.match = text; step.waitMatchMs = 5000;
    } else if (s.action === 'type' || s.action === 'paste') {
      if (!text) continue;
      step.text = text;
    } else if (s.action === 'key') {
      if (!s.key || !/^[a-z0-9.]+$/i.test(String(s.key))) continue;
      step.key = String(s.key).toLowerCase();
      if (Array.isArray(s.mods)) step.mods = s.mods.map(String);
    } else if (s.action === 'shortcut') {
      if (!s.intent) continue;
      step.intent = String(s.intent);
    } else if (s.action === 'scroll') {
      step.dy = /up/i.test(String(s.dir || s.dy || '')) ? 400 : -400;
    } else if (s.action === 'verify') {
      const chk = (s.check || text || ent || '').toString().slice(0, 60);
      if (!chk) continue;
      step.check = chk; step.waitMatchMs = 8000;
    }
    out.push(step);
  }
  // A map with no mutating step is a paragraph, not a procedure.
  return out.some(s => ['click', 'type', 'key', 'paste', 'shortcut', 'select'].includes(s.action)) ? out : [];
}

// The how-to query + cache key belong to the user's ASK, not the materialized
// goal — an appended extraction block ("Extracted from attached image:\n…")
// or leftover system tags poison the tutorial search with path junk and
// entity text (observed: map-tree queried a /var/… path + all 4 song names).
function _originalAsk(prompt) {
  const cut = String(prompt || '').split(/\n\s*Extracted from attached image/i)[0];
  return typeof _stripSystemTags === 'function' ? _stripSystemTags(cut) : cut.trim();
}

async function researchUimap(prompt, args) {
  const fc = require('../skill-helpers/flow-cache.cjs');
  const askText = _originalAsk(prompt);
  const taskKey = fc.taskKey(askText);
  const key = taskKey || String(askText || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120);
  if (_uiMapCache.has(key)) return _uiMapCache.get(key);
  const persisted = taskKey && _loadPersistedMap(taskKey);
  if (persisted) {
    await progress(args, `map-tree: replaying learned "${key}" (${persisted.steps?.length || 0} steps)`);
    _uiMapCache.set(key, persisted);
    return persisted;
  }
  let map = null;
  try {
    const webAgent = require('./web.agent.cjs');
    const { ask } = require('../skill-helpers/skill-llm.cjs');
    // Compact how-to query — verb + object + app, entities/destination stripped:
    // "add Lecrae songs to my Quiet Hour playlist on Spotify" → "add to playlist in Spotify"
    const { extractEntities } = require('../skill-helpers/flow-cache.cjs');
    const appM = String(askText || '').match(/\b(?:on|in|using)\s+([A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)?)\s*$/);
    const destM = String(askText || '').match(/\b(?:to|into|in)\s+(?:my|your|our|the|a|an|that|this)\s+([A-Za-z0-9][A-Za-z0-9 .&'’-]{1,60}?)(?=\s+(?:playlist|folder|list|album|collection|board|notebook|note|document|doc|file|group|channel|section|page)s?\b)/i);
    let q = ` ${String(askText || '').toLowerCase()} `;
    if (appM) q = q.replace(new RegExp(`\\b(?:on|in|using)\\s+${appM[1].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), ' ');
    for (const ent of (extractEntities(askText) || [])) {
      q = q.replace(new RegExp(`\\b${String(ent).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
    }
    if (destM) q = q.replace(new RegExp(`\\b${destM[1].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
    q = q.replace(/\b(please|can you|could you|would you|to|into|my|your|our|the|a|an|this|that|on|in)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    q = appM ? `${q} in ${appM[1]}` : q;
    // Learning stage is user-visible from map-miss time — the user should see
    // the one-time research cost up front, not mid-pipeline.
    await progress(args, `Learning how to interact with ${appM ? appM[1] : 'this app'} — one-time research…`);
    const res = await Promise.race([
      webAgent.actionGetTutorialSteps({ query: q, maxResults: 3 }),
      new Promise(r => setTimeout(() => r(null), 12000)),
    ]);
    const steps = res?.mergedSteps?.length ? res.mergedSteps
      : (res?.tutorials || []).flatMap(t => t.steps || []);
    // No numbered steps → distill straight from titles+snippets — the vocab
    // ("click ⋯", "Add", "Search") lives there too.
    let source = steps.length ? steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : (res?.tutorials || []).map(t => `${t.title || ''} — ${t.rawSnippet || ''}`).join('\n');
    // Text research came back thin → instructional video transcripts are the
    // next-best how-to source (yt-dlp captions → Whisper fallback).
    if (!source.trim()) {
      try {
        const videoAgent = require('./video.agent.cjs');
        // browser.act.cjs exports { browserAct } — the dep slot wants the
        // callable, not the module (observed: "browserAct is not a function"
        // crashed the video-tutorial lane → unguided walk).
        const _ba = require('./browser.act.cjs');
        const browserAct = _ba.browserAct || _ba.default || _ba;
        const skillLlm = require('../skill-helpers/skill-llm.cjs');
        const vres = await Promise.race([
          videoAgent.actionFindAndWatchTutorial({ platform: 'youtube', query: q, goal: askText }, { browserAct, skillLlm }),
          new Promise(r => setTimeout(() => r(null), 60000)),
        ]);
        const vtext = vres?.transcript || vres?.summary || (Array.isArray(vres?.steps) ? vres.steps.join('\n') : '');
        if (vtext && vtext.trim()) { await progress(args, 'learning from video tutorial…'); source = vtext; }
      } catch (e) { logger.warn(`[screen.task] video fallback failed: ${e.message}`); }
    }
    if (source.trim()) {
      await progress(args, `learning how to ${q} — building map-tree`);
      const distilled = await Promise.race([
        ask(`From these tutorial steps for the task "${askText}", extract JSON only:
{"controls":["UI control labels in click order, e.g. Add, Search for songs, +"],
 "order":["short stage names in order"],
 "avoid":["controls the tutorial never mentions that lead off-task, e.g. Install App, Choose photo"],
 "steps":[
   {"action":"click","match":"+","why":"open create/add menu"},
   {"action":"click","match":"Search for songs","why":"focus search field"},
   {"action":"type","text":"{{entity}}","why":"search payload"},
   {"action":"click","match":"Add","why":"add the result"},
   {"action":"verify","check":"{{entity}}","why":"confirm added"}
 ]}
Rules for steps: 4-9 bite-size UI actions; click/select need "match" (a short
control label under 60 chars); type needs "text" (use {{entity}} for the
task's payload); key needs "key" (letter/digit) plus optional "mods" array
(["cmd","ctrl","alt","shift"]) — PREFER a documented keyboard shortcut when
the tutorial names one (Cmd+K palette, Ctrl+J name box); shortcut needs
"intent". End with a verify of the goal state.
Only include actions the tutorial material supports.
Tutorial material:
${source.slice(0, 3000)}`, { json: true, timeoutMs: 20000 }),
        new Promise(r => setTimeout(() => r(null), 22000)),
      ]);
      const parsed = typeof distilled === 'string' ? JSON.parse(distilled.replace(/^```(?:json)?|```$/g, '').trim()) : distilled;
      if (parsed && (parsed.controls?.length || parsed.order?.length || parsed.steps?.length)) {
        const entities = extractEntities(askText);
        map = {
          controls: (parsed.controls || []).map(String).slice(0, 12),
          order: (parsed.order || []).map(String).slice(0, 8),
          avoid: (parsed.avoid || []).map(String).slice(0, 8),
          steps: _sanitizeMapSteps(parsed.steps, entities),
        };
        if (map.steps.length && taskKey) _persistMap(taskKey, map);
      }
    }
  } catch (e) {
    logger.warn(`[screen.task] uimap research failed: ${e.message}`);
  }
  const _nKeys = (map?.steps || []).filter(s => s.action === 'key' || s.action === 'shortcut').length;
  await progress(args, map
    ? `map-tree learned: ${map.steps?.length || 0} steps + ${_nKeys} shortcuts (${map.controls?.length || 0} controls, ${map.avoid?.length || 0} avoids)`
    : 'map-tree: unavailable — walking unguided');
  _uiMapCache.set(key, map);
  return map;
}

async function screenTaskAgent(args = {}) {
  const prev = _TASK_SIGNAL;
  _TASK_SIGNAL = args._abortSignal || null;
  try { return await _screenTaskAgent(args); }
  finally { _TASK_SIGNAL = prev; }
}

// ── Input materialization ──────────────────────────────────────────────────
// Defense in depth for the "verbatim goal" doctrine: a goal referencing an
// image file ([File: x.png] tag or a bare image path) can't be executed —
// this driver sees the screen, not the filesystem. Materialize refs via
// image.analyze (same process) and rewrite the goal with the extracted
// content before deriveSteps. Any planner shape (compiled, stepgen, internal)
// is protected; failure degrades to the original goal.
const _IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;
// System tags injected by gatherPlanContext/preflight/attachment plumbing —
// they carry pointers (or highlight context), never user intent. The
// executable goal must not contain them (observed: a [Resolved file path:]
// tag leaked into the prompt → map-tree queried the path, entities drifted).
const _SYS_TAG_RE = /\[(?:File|Folder|Context|Thought|Highlighted|Resolved file path):\s*[^\]]*\]/gi;
function _stripSystemTags(text, consumedPaths = new Set()) {
  return String(text)
    .replace(_SYS_TAG_RE, ' ')
    .split(/\s+/).filter(t => {
      const p = t.replace(/^['"([<{]+|['")\]>}.:;,]+$/g, '');
      return !(p.startsWith('/') && (_IMAGE_EXT_RE.test(p) || consumedPaths.has(p)));
    })
    .join(' ').replace(/\s{2,}/g, ' ').trim();
}
// An extraction block's itemized content ("1. Song — Artist\n2. …") parses
// into the entity list — one COMPLETE line per item. extractEntities on the
// same blob returns clipped fragments ("the Ice)", "by Russ Taff (Album:")
// that get typed verbatim into search fields.
function _parseExtractedItems(extraction) {
  const items = [];
  for (const line of String(extraction || '').split(/\r?\n/)) {
    const t = line.replace(/^\s*(?:[-*•·]|\d{1,2}[.)、])\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
    if (t.length < 4 || t.length > 90) continue;
    if (/^(extracted|attached image|the (?:songs|items|list|image|content)|screenshot|=+)/i.test(t)) continue;
    items.push(t);
    if (items.length >= 20) break;
  }
  return items.length >= 2 ? items : null;
}

async function _materializeImageRefs(goal, args) {
  const fs = require('fs');
  const paths = new Set();
  for (const m of String(goal).matchAll(/\[(?:File|Context|Thought|Resolved file path):\s*([^\]]+)\]/gi)) {
    const p = m[1].trim().replace(/^['"]|['"]$/g, '');
    if (_IMAGE_EXT_RE.test(p)) try { if (fs.existsSync(p)) paths.add(p); } catch (_) {}
  }
  for (const tok of String(goal).split(/\s+/)) {
    const p = tok.replace(/^['"([<{]+|['")\]>}.:;,]+$/g, '');
    if (p.startsWith('/') && _IMAGE_EXT_RE.test(p)) try { if (fs.existsSync(p) && fs.statSync(p).isFile()) paths.add(p); } catch (_) {}
  }
  // No refs → still strip system tags ([Highlighted:], [Resolved file path:]
  // on non-image files) so they never reach deriveSteps/research/act.
  if (!paths.size || _aborted()) return { goal: _stripSystemTags(goal), items: null };
  try {
    const { imageAnalyze, _lookupMaterialized } = require('./image.analyze.cjs');
    const list = [...paths].slice(0, 5);
    // Idempotent — a path already analyzed upstream (the image.analyze plan
    // step runs in this same process) comes back from the shared cache
    // instead of a second vision call.
    const cached = new Map(), misses = [];
    for (const p of list) {
      const hit = typeof _lookupMaterialized === 'function' ? _lookupMaterialized(p) : null;
      if (hit) cached.set(p, hit); else misses.push(p);
    }
    const parts = [];
    if (misses.length) {
      await progress(args, `reading ${misses.length} image${misses.length > 1 ? 's' : ''}…`);
      const r = await imageAnalyze({
        ...(misses.length === 1 ? { filePath: misses[0] } : { filePaths: misses }),
        query: `Extract the content needed to complete this task: ${goal}`,
        _abortSignal: _TASK_SIGNAL,
      });
      if (_aborted()) return { goal: _stripSystemTags(goal), items: null };
      const extracted = String(r?.stdout || r?.answer || r?.description || '').trim();
      if (!r?.ok || !extracted) {
        logger.warn(`[screen.task] image materialization failed: ${r?.error || 'empty result'}`);
        return { goal: _stripSystemTags(goal), items: null };
      }
      parts.push(extracted);
    }
    for (const p of list) if (cached.has(p)) parts.push(cached.get(p));
    if (!parts.length) return { goal: _stripSystemTags(goal), items: null };
    const extracted = parts.join('\n\n');
    const cleaned = _stripSystemTags(goal, paths);
    const items = _parseExtractedItems(extracted);
    // {{prev_stdout}} may already carry this exact extraction — compare
    // whitespace-normalized (the tag strip joins on single spaces, so the
    // embedded copy is one line while `extracted` keeps newlines).
    const _norm = s => String(s).replace(/\s+/g, ' ').trim();
    if (extracted && _norm(cleaned).includes(_norm(extracted.slice(0, 160)))) return { goal: cleaned, items };
    logger.info(`[screen.task] materialized ${list.length} image ref(s) into goal (${cached.size} cached, ${items?.length || 0} items)`);
    return { goal: `${cleaned}\n\nExtracted from attached image${list.length > 1 ? 's' : ''}:\n${extracted}`, items };
  } catch (e) {
    logger.warn(`[screen.task] image materialization error: ${e.message}`);
    return { goal: _stripSystemTags(goal), items: null };
  }
}

// ── Plan build (no side effects) ────────────────────────────────────────────
// The whole prompt → {goal, plan, entityItems} derivation: materialize image
// refs → deriveSteps → entityItems injection → title/text bridge → URL-first
// search seed. Exposed via /screen.plan for plan inspection — nothing in here
// runs setup or touches the screen.
// Grid value fill — one bounded model call for plausible TSV rows matching
// the headers; falls back to incrementing numbers when the model is away.
async function _gridValues(args, headers, rows) {
  try {
    const { ask } = require('../skill-helpers/skill-llm.cjs');
    const out = await Promise.race([
      ask(`Return EXACTLY ${rows} TSV rows (tab-separated, ${headers.length} columns, no header, no prose) of realistic sample values for a spreadsheet with headers: ${headers.join(', ')}`),
      new Promise(r => setTimeout(() => r(null), 8000)),
    ]);
    const lines = String(out || '').trim().split('\n').map(l => l.trim()).filter(l => l.split('\t').length === headers.length).slice(0, rows);
    if (lines.length) return lines.join('\n');
  } catch (_) {}
  return Array.from({ length: rows }, (_, i) => headers.map(() => String(i + 1)).join('\t')).join('\n');
}

async function buildTaskPlan(args = {}) {
  const { prompt } = args;
  const _mat = args.plan && args.plan.steps
    ? { goal: prompt || args.goal || '', items: null }
    : await _materializeImageRefs(prompt || args.goal || '', args);
  const goal = _mat.goal;
  const _entityItems = _mat.items;
  if (_aborted()) return { aborted: true, goal, plan: null, entityItems: _entityItems };
  const plan = args.plan && args.plan.steps ? args.plan
    : deriveSteps(goal, { service: args.service });
  // Grid recipe — a tsv step carries {headers, rows, value}; literal values
  // fill directly, otherwise one bounded model call produces plausible
  // values matching the headers (user opted into LLM values).
  for (const s of (plan.steps || [])) {
    if (s.tsv && s.text == null) {
      const { headers, rows, value } = s.tsv;
      const body = value != null
        ? Array.from({ length: rows }, () => headers.map(() => value).join('\t')).join('\n')
        : await _gridValues(args, headers, rows);
      s.text = headers.join('\t') + '\n' + body + '\n';
    }
  }
  // Itemized extraction → "for EACH item" semantics: the complete lines ride
  // the auto step as its entity list so the walk processes every item and
  // never types a clipped fragment of the list into a field.
  if (_entityItems?.length) {
    const _s = (plan.steps || []).find(s => s.action === 'auto');
    if (_s) {
      _s.entityItems = _entityItems;
      _s.goal = `${_s.goal || goal} — process EACH of the ${_entityItems.length} listed items one at a time, verifying each before moving to the next`;
      logger.info(`[screen.task] entityItems[${_entityItems.length}] → auto step`);
    }
  }
  // Content bridge — planner carries generated text ({{prev_stdout}}-injected)
  // as args.text; we paste it into the app rather than typing 3KB at 25ms/char.
  // args.title renames the doc via its title field (Google Docs "Untitled").
  // Title BEFORE paste — File ▸ Rename is a deterministic menu path (the
  // "Untitled document" element's center misses the live input). If it
  // still misses, ⌘A fires in an empty body — harmless vs deleting paste.
  // Escape before paste drops the "Help me write" composer focus so the
  // clipboard lands in the body, not a Gemini prompt (stray Return there
  // submits a generation).
  // The upstream chain already produced the content — the destination is
  // open (URL-first emit ran before us); rename+paste is the whole task.
  // Clauses derived from the original prompt (its research leg) would just
  // spin an auto-loop in an already-composed doc.
  if ((args.title || args.text) && !args.plan?.steps?.length) plan.steps = [];
  if (args.title) {
    plan.steps = plan.steps || [];
    plan.steps.unshift(
      { action: 'click', match: 'File', why: 'menu' },
      { action: 'click', match: 'Rename', waitMatchMs: 4000, why: 'menuitem' },
      { action: 'type', text: String(args.title), why: 'title' },
      { action: 'key', key: 'return', settleMs: 800, why: 'title-commit' });
  }
  if (args.text) {
    plan.steps = plan.steps || [];
    plan.steps.push(
      { action: 'key', key: 'escape', settleMs: 400, why: 'pre-paste-focus' },
      { action: 'paste', text: String(args.text), why: 'content-paste' });
  }
  // URL-first acquire — when the task must LOCATE an entity on a catalog
  // site, open its search URL directly instead of the homepage. The walk
  // lands on results and goes straight to ACT — zero field-hunting.
  // Bulk plans (delete/remove rows) are never "locate an entity" tasks —
  // extractEntities mangles the spec ("s left sidebar (Your Library), delete…")
  // into a search query and navigates to a junk URL. The surface is the
  // list itself; no seed.
  const _bulkSteps = (plan.steps || []).some(s => s.bulk);
  if (!_bulkSteps && !/\b(type|write|paste|dict(ate)?)\b.{0,40}\b(into|in|to)\b|\bfill\b/i.test(goal || '')) {
    const { searchUrlFor, cleanEntity } = require('../skill-helpers/search-urls.cjs');
    const { extractEntities } = require('../skill-helpers/flow-cache.cjs');
    const ent = cleanEntity((extractEntities(goal || '') || [])[0] || '');
    if (ent) {
      for (const s of plan.setup || []) {
        const search = s.openUrl && searchUrlFor(s.openUrl, ent);
        if (search) {
          s.openUrl = search; args._searchSeeded = ent;
          break;
        }
      }
    }
    // Container goals ("remove X from Y", "open Y") do NOT seed a search
    // URL up front — "my playlist/folder" lives in the library region, and
    // a global search can hit someone else's same-named public container.
    // The auto-loop probes the library first; URL search is its dead-end
    // fallback (kind-filtered, e.g. /search/{q}/playlists).
  }
  return { goal, plan, entityItems: _entityItems };
}

async function _screenTaskAgent(args = {}) {
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
  const { sessionId, display = -1 } = args;
  const started = Date.now();
  const _bp = await buildTaskPlan(args);
  if (_aborted() || _bp.aborted) return { ok: false, error: 'cancelled', cancelled: true, sessionId: args.sessionId };
  const goal = _bp.goal;
  const plan = _bp.plan;
  if (!plan.steps?.length && !plan.setup?.length) {
    return { ok: false, error: 'screen.task.agent: plan produced no steps', sessionId };
  }
  await progress(args, `plan: ${plan.setup?.length || 0} setup, ${plan.steps?.length || 0} steps`);
  if (args._searchSeeded) await progress(args, `search URL → "${args._searchSeeded}"`);
  logger.info(`[screen.task] goal=${JSON.stringify(String(goal || '').slice(0, 140))} notes=${(plan.notes || []).join(' | ').slice(0, 200)}`);

  const t0 = Date.now();
  await runSetup(plan.setup, args);
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, sessionId };
  const setupMs = Date.now() - t0;

  // A discover NAME is not an app — "row 1" passed as ctx.app pinned the walk
  // to a phantom and refocused forever. Only real app destinations (or an
  // explicit plan.destination) may pin; url/discover kinds resolve through
  // args._frontApp after runSetup opens them.
  const destName = plan.destination || plan.dest?.app || null;
  const destApp = (destName && !/[.\/]/.test(destName) ? destName : null) || args._frontApp || null;
  // Map-tree research — novel goals get a distilled UI vocabulary before the
  // walk starts. Runs while the destination opens. Skip it when the plan is
  // already fully deterministic (explicit args.plan, or every derived step
  // carries a concrete action and nothing needs the auto-loop) — researching
  // a recipe burned ~25s and once followed a tutorial-video redirect that
  // hijacked the browser to a dead tracker.
  const _needsMap = !(plan.steps?.length
    && (args.plan?.steps?.length || !plan.steps.some(s => s.action === 'auto')));
  const uiMap = (_aborted() || !_needsMap) ? null : await researchUimap(goal, args);
  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, sessionId };

  // Map-tree injection — researched bite-size steps slot in ahead of the
  // auto-loop: direction first, wandering only as recovery. They land AFTER
  // container-nav steps (reach the playlist/folder first) and BEFORE auto.
  if (uiMap?.steps?.length && plan.steps?.length) {
    // Route-direction check — a recipe learned for "add songs from inside
    // the playlist" (open +/create → "Search for songs" field → type) is
    // the WRONG flow when setup seeded a search URL: our route is
    // results-row → ⋯ → Add to playlist → picker. Replaying it burns the
    // iteration budget on a dead flow; skip and let live strategy run.
    const _seededSearch = /\/search[/?]|search_query=|\?k=|\?q=/i.test(String(args._startUrl || ''));
    const _dir = uiMap.steps.map(s => `${s.action} ${s.match || s.text || ''}`).join(' | ').toLowerCase();
    const _insideContainerSearch = /search for|search songs|search playlist/i.test(_dir)
      && /click (\+|plus|create|new)/i.test(_dir);
    // A bulk/remove plan can never use a search-inside-container recipe —
    // that flow ADDS songs; replaying it opens the wrong panel entirely.
    // Bulk plans skip map-tree injection ENTIRELY: learned recipes are
    // coordinate/label steps for a different task shape — a stale "click
    // Delete" recipe just fired a blind commit at a wrong element. The
    // bulk lanes are self-directed (arm → enumerate → commit → verify).
    const _bulkPlan = (plan.steps || []).some(s => s.bulk);
    if (_bulkPlan) {
      await progress(args, 'map-tree: skipped — bulk plan is self-directed');
    } else if (_seededSearch && _insideContainerSearch) {
      await progress(args, `map-tree: recipe direction mismatch (search-inside-container ≠ results→picker) — skipped`);
    } else {
      const autoIdx = plan.steps.findIndex(s => s.action === 'auto');
      const insertAt = autoIdx >= 0 ? autoIdx : plan.steps.length;
      plan.steps.splice(insertAt, 0, ...uiMap.steps);
      await progress(args, `map-tree: injected ${uiMap.steps.length} directed steps`);
    }
  }

  if (_aborted()) return { ok: false, error: 'cancelled', cancelled: true, sessionId };
  // needsUser resume — the caller answers a previous run's question via
  // args.answers [{label, decision:'commit'|'skip'}]; inject into bulk
  // steps so the lane's entry seed applies them.
  if (Array.isArray(args.answers) && args.answers.length)
    (plan.steps || []).forEach(s => { if (s.bulk) s.answers = args.answers; });
  const res = plan.steps?.length
    ? await screenActAgent({ goal: destName || goal || '', steps: plan.steps,
        flowPrompt: goal, sessionId, display, app: destApp, windowOnly: args.windowOnly,
        fastAx: args.fastAx, tabMatch: args._tabMatch || null,
        destination: (() => {
          const rawStep = (plan.steps || []).find(s => /container-nav|container-open|subtractive-container/i.test(String(s.why || s.action || '')));
          const raw = (Array.isArray(rawStep?.match) ? rawStep.match[0] : rawStep?.match) || null;
          if (!raw) return null;
          // "spotify playlist Quiet Hour" → "Quiet Hour" — the picker's
          // search field needs the container's NAME, not venue/type words.
          const stripped = String(raw)
            .replace(/^(?:my\s+)?(?:spotify|apple|music|itunes|youtube|amazon|google|chrome|safari|firefox|edge|notion|figma|slack|discord)\s+/i, '')
            .replace(/\b(?:playlist|playlists|folder|folders|list|lists|board|boards|collection|collections|album|cart|library)\b/gi, '')
            .replace(/\s{2,}/g, ' ').trim();
          return stripped || raw;
        })(),
        startUrl: args._startUrl, browserName: args._browserName, uiMap,
        searchSeeded: args._searchSeeded || null,
        containerSearch: args._containerSearch || null,
        _abortSignal: _TASK_SIGNAL,
        onStep: (t, i, n) => {
          const line = typeof t === 'string' ? t
            : `step ${i + 1}/${n}${t.iter != null ? ` ·auto ${t.iter + 1}` : ''}: ${t.action} ${typeof t.match === 'string' ? t.match : Array.isArray(t.match) ? t.match.map(m => typeof m === 'string' ? m : String(m?.re || '')).join(' | ') : ''}${t.verified === false ? ' (unverified)' : ''}${t.recovers ? ` +${t.recovers}r` : ''}`;
          progress(args, line);
          if (typeof t === 'object' && t && t.action) stepLive(args, i, n, `${t.action} ${typeof t.match === 'string' ? t.match : ''}`);
        } })
    : { ok: true, output: 'setup only' };

  // Poisoned-recipe accounting — a replayed learned flow whose run failed
  // earns a strike; two strikes and flowCache stops serving it.
  const learnedNote = (plan.notes || []).find(n => /learned-flow "([^"]+)"/.test(n));
  if (learnedNote && res.ok === false) {
    try {
      const fc = require('../skill-helpers/flow-cache.cjs');
      fc.noteFailure(learnedNote.match(/learned-flow "([^"]+)"/)[1]);
      logger.warn(`[screen.task] learned flow ${learnedNote.match(/"([^"]+)"/)[1]} failed — strike recorded`);
    } catch (_) {}
  }

  return {
    ok: res.ok !== false,
    output: res.output,
    error: res.error || null,
    plan: { setup: plan.setup, steps: plan.steps, destination: plan.destination },
    stepsRun: res.stepsRun || [],
    needsUser: res.needsUser || null,
    timings: { setupMs, actMs: Date.now() - t0 - setupMs, totalMs: Date.now() - started },
    sessionId,
  };
}

module.exports = { screenTaskAgent, buildTaskPlan, _internals: { _materializeImageRefs, _stripSystemTags, _parseExtractedItems, _originalAsk, runSetup, ensureFrontmost, frontApp, frontWindow, focusApp, _bundleFor } };
