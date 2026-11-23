'use strict';

// ---------------------------------------------------------------------------
// ui-plan.cjs — prompt → {setup[], steps[]} deriver for screen.task.agent.
//
// Deterministic-first: destinations, quoted text, verbs, account hints are
// extracted without a model. The model (skill-llm) is ONLY the residue path —
// when a prompt can't be split deterministically. Every step carries enough
// structure for the cheapest mechanism to win: app shortcuts before clicks,
// clicks before model picks, and explicit expect for the verify loop.
//
// setup[] (run by screen.task.agent, before screen.act):
//   {focus:'Slack'} | {openApp:'Notes'} | {openUrl:'https://…'} | {openAppUrl}
//   {waitMs}
// steps[] (run by screen.act):
//   {action:'click'|'type'|'key'|'shortcut'|'scroll', match?, text?, key?,
//    mods?, intent?, expect?, settleMs?, waitMatchMs?}
// ---------------------------------------------------------------------------

const logger = require('../logger.cjs');
const flowCache = require('./flow-cache.cjs');
const { homeUrlFor } = require('../../../../shared/service-map.cjs');

// ── Destination aliases → how to reach them ─────────────────────────────────
// app: focus-or-open via /screen/act focus + open -a fallback
// url: open in default browser (url.first 'open' transport)
const DESTINATIONS = [
  { re: /\bslack\b/i, app: 'Slack' },
  { re: /\bgrok\b/i, url: 'https://grok.com/' },
  { re: /\bgmail\b|mail\.google\.com/i, url: 'https://mail.google.com/' },
  { re: /\bgoogle\s+sheets?\b|\bsheets\.google\.com/i, url: 'https://sheets.google.com/' },
  { re: /\bgoogle\s+docs?\b|\bdocs\.google\.com/i, url: 'https://docs.google.com/' },
  { re: /\bgoogle\s+slides?\b/i, url: 'https://slides.google.com/' },
  { re: /\bgoogle\s+drive\b/i, url: 'https://drive.google.com/' },
  { re: /\bgoogle\s+forms?\b/i, url: 'https://forms.google.com/' },
  { re: /\bgoogle\s+keep\b/i, url: 'https://keep.google.com/' },
  { re: /\bgoogle\s+meet\b/i, url: 'https://meet.google.com/' },
  { re: /\bgoogle\s+calendar\b/i, discover: 'google calendar' },
  { re: /\bcalendar\b/i, app: 'Calendar' },
  { re: /\bnotes?\b/i, app: 'Notes' },
  { re: /\breminders?\b/i, app: 'Reminders' },
  { re: /\bterminal\b/i, app: 'Terminal' },
  { re: /\bfinder\b/i, app: 'Finder' },
  { re: /\btext\s*edit\b/i, app: 'TextEdit' },
  { re: /\bvs\s*code\b|visual studio|vscode/i, app: 'Code' },
  { re: /\bsafari\b/i, app: 'Safari' },
  { re: /\bchrome\b/i, app: 'Google Chrome' },
  { re: /\byoutube\b/i, url: 'https://www.youtube.com/' },
  // spotify.com is the marketing site — the logged-in player is open.spotify.com.
  // The web player works even when the native app isn't installed.
  { re: /\bspotify\b/i, url: 'https://open.spotify.com/' },
  { re: /\bmusic\b/i, app: 'Music' },
  { re: /\bmessages?\b/i, app: 'Messages' },
  { re: /\bmail\b/i, app: 'Mail' },
  { re: /\bphotos?\b/i, app: 'Photos' },
  { re: /\bpreview\b/i, app: 'Preview' },
  { re: /\bmaps?\b/i, app: 'Maps' },
];

// Email addresses in prompt → authuser hints for Google services
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i;

// Open-doc tab markers — "my open Google Sheet" claims a live document tab;
// focusing the browser is not enough when another window/tab is frontmost
// (observed: paste landed in the doc-picker's search field; mid-run the front
// window drifted to YouTube). /d/ markers prefer real docs over the picker.
const OPEN_DOC_TAB_MARKERS = {
  google_sheets: { match: 'spreadsheets/d/', createUrl: 'https://sheet.new', homeUrl: 'https://sheets.google.com/' },
  google_docs: { match: 'document/d/', createUrl: 'https://doc.new', homeUrl: 'https://docs.google.com/' },
  google_slides: { match: 'presentation/d/', createUrl: null, homeUrl: 'https://slides.google.com/' },
  gmail: { match: 'mail.google.com/', createUrl: null, homeUrl: 'https://mail.google.com/' },
};
// Possessive/active "open" claims a live doc ("my open sheet", "the open doc",
// "already open", "the active sheet"); bare 'open' stays a nav verb.
const _OPEN_DOC_RE = /\b(?:my|your|the|this|an?|its)\s+open\b|\b(?:already|currently)\s+open\b/i;
const _ACTIVE_DOC_RE = /\b(?:the\s+)?(?:active|current|existing)\s+(?:[a-z]+\s+){0,2}(?:sheet|doc|spreadsheet|document|file|tab|page|window|note|email|presentation|slide)s?\b/i;
const openDocClaim = (prompt) => _OPEN_DOC_RE.test(prompt) || _ACTIVE_DOC_RE.test(prompt);

// Open-doc entry for a dest/service: prefer the service table; a Google
// doc-family dest URL maps by path; otherwise the host itself is the marker —
// any tab on the service's host beats an unrelated front window.
function _openDocEntryFor(dest, service) {
  const svc = service ? String(service).toLowerCase() : null;
  if (svc && OPEN_DOC_TAB_MARKERS[svc]) return OPEN_DOC_TAB_MARKERS[svc];
  const url = dest?.url || '';
  if (/docs\.google\.com\/spreadsheets|sheets\.google/i.test(url)) return OPEN_DOC_TAB_MARKERS.google_sheets;
  if (/docs\.google\.com\/document|docs\.google/i.test(url)) return OPEN_DOC_TAB_MARKERS.google_docs;
  if (/docs\.google\.com\/presentation|slides\.google/i.test(url)) return OPEN_DOC_TAB_MARKERS.google_slides;
  if (/mail\.google/i.test(url)) return OPEN_DOC_TAB_MARKERS.gmail;
  let host = null;
  try { if (url) host = new URL(url).hostname; } catch { /* fallthrough */ }
  if (!host) {
    const home = svc ? homeUrlFor(svc) : null;
    try { if (home) host = new URL(home).hostname; } catch { /* fallthrough */ }
  }
  return host ? { match: host, createUrl: null, homeUrl: `https://${host}/` } : null;
}

// Shortcut-intent vocabulary → what to ask resolveShortcut for.
// Order matters: first match wins. Intent phrasing chosen to fuzzy-hit real
// menu titles ("Switch to Channel", "New Event or Reminder", "New Message").
const INTENT_PATTERNS = [
  { re: /quick switch|jump to|switch to channel|switch workspace|quick open/i, intent: 'switch to channel' },
  { re: /new message|compose|new dm/i, intent: 'new message' },
  { re: /new event|create (an )?event|set an event|add (an )?event/i, intent: 'new event' },
  { re: /new note|create (a )?note/i, intent: 'new note' },
  { re: /new reminder|create (a )?reminder|add (a )?reminder/i, intent: 'new reminder' },
  { re: /new tab/i, intent: 'new tab' },
  { re: /new window/i, intent: 'new window' },
  { re: /new file|new document/i, intent: 'new' },
  { re: /address bar|location bar|url bar/i, intent: 'address bar' },
  { re: /search\b/i, intent: 'search' },
  { re: /find\b/i, intent: 'find' },
  { re: /go to today|today\b/i, intent: 'today' },
];

function _destSetup(prompt) {
  const email = prompt.match(EMAIL_RE)?.[0];
  for (const d of DESTINATIONS) {
    if (d.re.test(prompt)) {
      if (d.app) return { kind: 'app', app: d.app };
      if (d.discover) return { kind: 'discover', name: d.discover };
      if (d.url) {
        let url = d.url;
        if (email && /google/i.test(url)) {
          url = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}`;
        }
        return { kind: 'url', url, email };
      }
    }
  }
  const m = prompt.match(/(?:goto|go to|open|visit|navigate to)\s+(?:the\s+|my\s+)?([a-z0-9][a-z0-9-]*\.[a-z]{2,}(?:\/\S*)?)/i);
  if (m) return { kind: 'url', url: 'https://' + m[1] };
  // No table hit → destination DISCOVERY, not a blind click. Emit the name
  // token; runSetup resolves it through destination-cache (app probe →
  // model recall → web discovery → HTTP-verify → cache write). Handles the
  // whole world of services/apps the static table can't enumerate.
  // Only explicit NAV verbs may claim a destination — 'in' is a context
  // marker ("in my open Sheet", "in row 1"), never navigation (observed:
  // "in row 1" → discover "row 1" → phantom app refocus loop).
  const g = prompt.match(/(?:goto|go\s+to|open|launch|visit|navigate\s+to)\s+(?:the\s+|my\s+|a\s+)?(?:app\s+|site\s+|page\s+)?([a-z0-9][a-z0-9 .&-]{1,30}?)(?:\s+(?:and|then|to|for|where|that|in|on|with)\b|[,.]|$)/i);
  if (g && g[1] && !/^(the\s+)?(url|browser|page|site|app|it|this|that|file|folder|document|desktop|screen|box|field|input|area|space|bar|window|tab|button|menu|message|text|row|rows|column|columns|cell|cells|line|item|items|list|lists|value|values|header|headers|col)\b/i.test(g[1].trim())
      && g[1].trim().length >= 2 && !/[0-9]{1,}/.test(g[1])) {
    return { kind: 'discover', name: g[1].trim() };
  }
  return null;
}

// ── Spreadsheet grid spec → TSV-paste recipe ────────────────────────────────
// "headers item, qty, price … 4 rows of values" / "3 column phone food
// electric/water … values like 3" → deterministic TSV block splatted from A1
// in one paste — never per-cell clicking on a canvas grid.
function _sheetSpec(prompt) {
  const h = prompt.match(/(?:headers?|columns?|cols)\s+(?:called\s+|named\s+)?([a-z0-9 ,/&'_-]{3,80}?)(?=\s+(?:in|into|at|then|and|with|below|under|row|rows)\b|\s*$)/i);
  if (!h) return null;
  const headers = h[1].split(/\s*,\s*|\s+and\s+|\s+or\s+/i).map(s => s.trim()).filter(s => s && !/^(the|a|an|of|for|in|on|at)$/i.test(s));
  if (headers.length < 2) return null;
  const rm = prompt.match(/\b(\d{1,2})\s+rows?\b/i) || prompt.match(/\b(\d{1,2})\s+(?:rows?\s+of\s+)?values?\b/i);
  const vm = prompt.match(/\bvalues?\s+(?:like\s+|of\s+|at\s+)?(\d+(?:\.\d+)?)\b/i)
         || prompt.match(/\blike\s+(\d+(?:\.\d+)?)\b/i);
  return { headers, rows: rm ? Math.min(+rm[1], 20) : 3, value: vm ? vm[1] : null };
}

// ── Calendar event spec → deterministic render URL ─────────────────────────
// "event dec 1st at 3pm take out the trash" → {title, start, end} for
// calendar.google.com/calendar/render?action=TEMPLATE — the same URL every
// "Add to Google Calendar" button on the web uses. Pre-fills the form, so
// the only UI step left is clicking Save. Returns {partial:true} when the
// date or time can't be parsed (caller falls back to form-filling).
function _eventSpec(prompt) {
  const ev = prompt.match(/(?:set|create|add|make|schedule)\s+(?:a\s+|an?\s+)?(?:google\s+)?(?:calendar\s+)?event\b/i);
  if (!ev) return null;
  let rest = prompt.slice(ev.index + ev[0].length);

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let d = null, hh = null, mm = 0;

  // time — "at 3pm", "3:30pm", "15:00"
  const tm = rest.match(/\b(?:at\s*(?:about\s*)?|around\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
          || rest.match(/\b(?:at\s+)?(\d{1,2}):(\d{2})\b/);
  if (tm) {
    hh = +tm[1]; mm = +(tm[2] || 0);
    if (tm[3]) { const ap = tm[3].toLowerCase(); if (ap === 'pm' && hh < 12) hh += 12; if (ap === 'am' && hh === 12) hh = 0; }
    rest = rest.replace(tm[0], ' ');
  }

  // date — "dec 1st", "december 1 2025", "12/1", tomorrow, today, next <weekday>
  const dm = rest.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i)
          || rest.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  const wday = rest.match(/\bnext\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i);
  if (/\btomorrow\b/i.test(rest)) {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    rest = rest.replace(/\btomorrow\b/i, ' ');
  } else if (/\btoday\b/i.test(rest)) {
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    rest = rest.replace(/\btoday\b/i, ' ');
  } else if (wday) {
    const want = 'sunmontuewedthufrisat'.indexOf(wday[1].slice(0, 3).toLowerCase()) / 3;
    const delta = (want - now.getDay() + 7) % 7 || 7;
    d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
    rest = rest.replace(wday[0], ' ');
  } else if (dm) {
    if (/[a-z]/i.test(dm[1])) {
      const mi = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(dm[1].slice(0, 3).toLowerCase()) / 3;
      const yr = dm[3] ? +dm[3] : now.getFullYear();
      d = new Date(yr, mi, +dm[2]);
      if (!dm[3] && d < now) d = new Date(yr + 1, mi, +dm[2]);   // next occurrence
    } else {
      const yr = dm[3] ? (+dm[3] < 100 ? 2000 + +dm[3] : +dm[3]) : now.getFullYear();
      d = new Date(yr, +dm[1] - 1, +dm[2]);
      if (!dm[3] && d < now) d = new Date(yr + 1, +dm[1] - 1, +dm[2]);
    }
    rest = rest.replace(dm[0], ' ');
  }

  const title = rest.replace(/["'`]/g, ' ')
    .replace(/\b(for|on|at|to|called|titled|named|that says|saying|about|google|calendar)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!d || hh == null) return { partial: true, title };
  const ymd = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return {
    title: title || 'Event',
    start: `${ymd}T${pad(hh)}${pad(mm)}00`,
    end: `${ymd}T${pad((hh + 1) % 24)}${pad(mm)}00`,
  };
}

// ── Clause splitting ────────────────────────────────────────────────────────
// "goto X and click on Y and send a message saying Z" → actionable clauses.
function _clauses(prompt) {
  return prompt
    .replace(/^(please\s+|can you\s+|could you\s+)/i, '')
    .split(/\s*(?:,\s*(?:and|then)\s+|\s+and then\s+|\s+then\s+|\s+and\s+|;\s*|\.\s+)/i)
    .map(s => s.trim()).filter(Boolean);
}

// "saying hello" / "saying 'hello'" → 'hello'
function _messageText(clause) {
  const m = clause.match(/(?:saying|that says|with (?:the )?text|message|body|says?)\s+["'`]?(.+?)["'`]?\s*$/i)
        || clause.match(/["'`](.+?)["'`]/);
  if (!m) return null;
  return m[1].trim().replace(/^(saying|that says|says)\s+/i, '').replace(/^["'`]|["'`]$/g, '').trim();
}

// Recipient/target names: "click on chrisakers" / "click chrisakers" /
// "on the 'Chat' tab" / "workspace" contexts
function _clickTarget(clause) {
  const m = clause.match(/(?:click|press|tap|select|choose|hit|open)\s+(?:on\s+)?(?:the\s+)?["'`]?(.+?)["'`]?\s*$/i);
  return m ? m[1].trim().replace(/\s+(tab|button|icon|link|field|input|box|workspace|channel|dm|conversation)s?$/i, '') : null;
}

/**
 * deriveSteps(prompt) → { setup, steps, notes, dest }
 * setup: [{focus}|{openApp}|{openUrl}|{waitMs}] — run before screen.act.
 * steps: screen.act step objects.
 */
function deriveSteps(prompt, opts = {}) {
  const notes = [];
  const steps = [];
  const setup = [];

  // Mask quoted/named entity values before destination resolution — a
  // playlist called "Grace Notes" must not route to Notes.app over 'spotify'.
  const destPrompt = prompt
    .replace(/(?:called|named|titled|titled as)\s+["'`][^"'`]+["'`]/gi, 'named')
    .replace(/(?:called|named|titled)\s+\S+(?:\s+\S+){0,3}?(?=\s+(?:and|with|to)\b|$)/gi, 'named');
  // Google Calendar event spec → the render URL IS the destination + the
  // whole recipe: pre-filled form → click Save. Nothing else to click.
  const gcalSpec = _eventSpec(prompt);
  let dest = _destSetup(destPrompt);
  // Envelope service is authoritative — 'in my open google sheet' extracts no
  // destination lexically but the classifier already named google_sheets.
  if (!dest && opts.service) {
    const u = homeUrlFor(opts.service);
    if (u) dest = { kind: 'url', url: u };
  }
  let gcalSaveStep = null;
  if (gcalSpec && !gcalSpec.partial && /google\s+calendar|calendar\.google/i.test(prompt)) {
    dest = {
      kind: 'url',
      url: `https://calendar.google.com/calendar/render?action=TEMPLATE`
         + `&text=${encodeURIComponent(gcalSpec.title)}`
         + `&dates=${gcalSpec.start}/${gcalSpec.end}`,
    };
    notes.push(`gcal event → render URL "${gcalSpec.title}" ${gcalSpec.start}–${gcalSpec.end}`);
    gcalSaveStep = { action: 'click', match: 'Save', waitMatchMs: 8000, why: 'gcal-save' };
  }
  if (dest?.kind === 'app') setup.push({ openApp: dest.app, focus: dest.app });
  else if (dest?.kind === 'url') setup.push({ openUrl: dest.url });
  else if (dest?.kind === 'discover') setup.push({ discover: dest.name });
  if (dest) setup.push({ waitMs: dest.kind === 'url' || dest.kind === 'discover' ? 3000 : 1500 });
  else notes.push('no-destination — steps run on whatever is frontmost');

  // ── Open-doc — "my open / already open / the active" claims a LIVE doc tab.
  // sheets.google.com opens a doc-picker and the paste lands in its search
  // box; and focusing the browser alone can leave YouTube frontmost when the
  // doc lives in another window. The right setup is a tab resolution: find
  // the doc-marker tab, raise its window, make it active.
  const _openDoc = openDocClaim(prompt);
  const _openDocEntry = _openDoc ? _openDocEntryFor(dest, opts.service) : null;
  if (_openDoc && _openDocEntry?.match) {
    // No matching tab ≠ give up: additive tasks (fill/add/write) get a fresh
    // doc via the service's .new URL; anything else gets the service home —
    // "continuing on frontmost" splatted a TSV into a Google search tab once.
    const _additive = /\b(create|new|add|write|put|fill|insert|draft|make|build|type|paste|enter|list)\b/i.test(prompt);
    const fb = (_additive && _openDocEntry.createUrl) || _openDocEntry.homeUrl || null;
    dest = { kind: 'app', app: 'Google Chrome' };
    setup.length = 0;
    setup.push({ focusTab: { match: _openDocEntry.match, fallbackUrl: fb } }, { waitMs: 1200 });
    notes.push(`open-doc → focusTab "${_openDocEntry.match}"${fb ? ` fallback ${fb}` : ''}`);
  }

  // ── Spreadsheet grid recipe — a TSV block pasted at the active cell fills
  // the range in ONE action (proved on Google Sheets: canvas grids can't be
  // per-cell driven). Fires when the destination is a sheet surface and the
  // prompt carries a header list. Value cells fill from an explicit literal
  // ("values like 3") or a plan-time model fill downstream (step.tsv).
  const _sheetDest = (dest?.url && /sheets\.google|docs\.google\.com\/spreadsheets|excel|numbers/i.test(dest.url))
    || (opts.service && /sheets?|excel|numbers/i.test(String(opts.service)));
  const sheetSpec = _sheetSpec(prompt);
  if (sheetSpec && (_sheetDest || /\bsheet|spreadsheet|excel|grid\b/i.test(prompt))) {
    // Grid anchor via the name box — JS in the tab sets #t-name-box to 'A1'
    // and commits Enter; Sheets navigates selection to A1 and the grid takes
    // focus. Deterministic where Ctrl+Home needs keyboard focus the fresh
    // tab may not have. Ctrl+Home stays as a harmless fallback keystroke.
    const _nameBoxJs = `var nb=document.querySelector('#t-name-box');if(nb){nb.focus();nb.value='A1';nb.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true}));nb.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,which:13,bubbles:true}));'ok'}else{'none'}`;
    setup.push({ jsEval: _nameBoxJs });
    steps.push({ action: 'key', key: 'home', mods: ['ctrl'], settleMs: 400, why: 'grid-anchor' });
    steps.push({ action: 'paste', text: null, tsv: sheetSpec, why: 'tsv-grid' });
    // Exact expected range — 3 cols × (1 header + N data rows) pasted at A1
    // selects 'A1:C5' in the name box. JS oracle reads #t-name-box directly;
    // 'A1:C5' on-screen is the same needle for the OCR fallback.
    const _colLetter = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
    const _range = `A1:${_colLetter(sheetSpec.headers.length)}${sheetSpec.rows + 1}`;
    steps.push({ action: 'verify', check: _range, js: "document.querySelector('#t-name-box')?.value || ''", why: 'grid-verify' });
    notes.push(`grid recipe — ${sheetSpec.headers.length} cols × ${sheetSpec.rows} rows${sheetSpec.value != null ? ` ×${sheetSpec.value}` : ''}`);
    return { setup, steps, notes, dest, sendRequested: false };
  }

  const clauses = _clauses(prompt);
  const residueClauses = [];
  let sendRequested = /\bsend\b|\bemail\b|\bmessage\b|\breply\b|\bdm\b/i.test(prompt);
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appStrip = dest?.app ? new RegExp('^(in|inside|on|within|into)\\s+(the\\s+|my\\s+)?' + esc(dest.app) + '\\b\\s*', 'i') : null;

  // ── Learned-flow replay ─────────────────────────────────────────────────
  // Recipes are earned at runtime, never authored: a previously-verified task
  // of the same shape (normalized prompt signature — entity values masked)
  // replays its proven step trace. Verify gates still run at execution, so a
  // stale recipe fails honestly. Typed text travels as entity slots re-filled
  // from THIS prompt's entities. Miss → generic clause derivation below.
  const flowKey = flowCache.taskKey(prompt);
  let flowSteps = null;
  {
    const rec = (flowKey && flowCache.get(flowKey)) || flowCache.getFuzzy(prompt);
    if (rec?.steps?.length) {
      flowSteps = flowCache.hydrateSteps(rec.steps, flowCache.extractEntities(prompt));
      steps.push(...flowSteps);
      notes.push(`learned-flow "${rec.key}" (${rec.runs || 1} prior runs${rec.fuzzyScore ? `, fuzzy ${rec.fuzzyScore}` : ''})`);
    }
  }


  for (let raw of flowSteps ? [] : clauses) {
    let c = raw.trim();
    if (!c) continue;

    // strip leading destination prefix — "in slack <rest>" keeps the rest
    if (appStrip) c = c.replace(appStrip, '').trim();
    if (!c) continue;

    // ── workspace switch — "goto the X workspace" (before generic nav) ──────
    const ws = c.match(/^(?:goto|go to|go|open|switch to|join)\s+(?:the\s+|my\s+)?["'`]?([\w .&@'+-]+?)["'`]?\s+workspace\b/i)
            || c.match(/\b["'`]([\w .&@'+-]+)["'`]\s+workspace\b/i)
            || c.match(/workspace\s+(?:called|named)\s+["'`]([\w .&@'+-]+)["'`]/i);
    if (ws) {
      const name = ws[1].trim();
      steps.push({ action: 'shortcut', intent: name, waitMatchMs: 5000, why: 'workspace' });
      steps.push({ action: 'click', match: name, waitMatchMs: 3000, why: 'workspace-fallback' });
      // remainder after "workspace" may carry a click target ("… workspace click on Y")
      const rest = c.slice(c.toLowerCase().indexOf('workspace') + 9).trim();
      const restClick = rest.match(/^(?:,?\s*(?:and\s+)?)(?:click|press|tap|select|choose|open)\s+(?:on\s+)?["'`]?(.+?)["'`]?\s*$/i);
      if (restClick) steps.push({ action: 'click', match: restClick[1].trim(), waitMatchMs: 4000, why: 'workspace-then-click' });
      continue;
    }

    // ── "goto X" inside an app → click match (app/url nav already in setup) ─
    if (/^(goto|go to|go|open|launch|start|pull up|bring up|visit|navigate to)\b/i.test(c)) {
      if (dest && !dest.inAppNav) continue;
      const t = c.replace(/^(goto|go to|go|open|visit|navigate to|launch|start|pull up|bring up)\s+(?:the\s+|my\s+|on\s+my\s+\w+\s+)?/i, '').trim();
      if (t) { steps.push({ action: 'click', match: t, waitMatchMs: 3000, why: 'goto→click' }); continue; }
      continue;
    }

    // ── "send an email to X saying Y" — Gmail compose recipe ────────────────
    const em = c.match(/(?:send|write|compose)\s+(?:an?\s+)?e?mail\s+(?:to\s+)?([\w.+-]+@[\w-]+\.[\w.]+|myself|me\b)?/i);
    if (em && /\bmail\b|gmail/i.test(prompt)) {
      const msg = _messageText(c);
      const to = em[1] && em[1] !== 'myself' && em[1] !== 'me' ? em[1] : (dest?.email || 'myself');
      steps.push({ action: 'click', match: 'Compose', waitMatchMs: 5000, settleMs: 1200, why: 'compose' });
      steps.push({ action: 'type', text: to === 'myself' && dest?.email ? dest.email : to, why: 'email-to' });
      steps.push({ action: 'key', key: 'return', settleMs: 600, why: 'to-confirm' });
      steps.push({ action: 'key', key: 'tab', settleMs: 300, why: 'to-subject' });
      steps.push({ action: 'type', text: msg || '', why: 'email-subject' });
      steps.push({ action: 'key', key: 'tab', settleMs: 300, why: 'subject-body' });
      if (msg) steps.push({ action: 'type', text: msg, why: 'email-body' });
      if (sendRequested) steps.push({ action: 'key', key: 'return', mods: ['cmd'], settleMs: 1500, why: 'email-send' });
      continue;
    }

    // ── "add/put X to|into Y" — container goals (playlist, folder, album) ────
    // Direction: reach the container first, then the auto-loop decomposes the
    // add-interaction (open dialog → search → pick → confirm) live. The
    // container label Y gets a click step; X rides along as the auto goal's
    // verify entity so containment proves the add, not the typing.
    const addC = c.match(/^(?:add|put|save|move|copy)\s+(.+?)\s+(?:to|into)\s+(?:my\s+|your\s+|our\s+|the\s+|a\s+|an\s+)?(.+?)$/i);
    if (addC) {
      let container = addC[2].trim();
      if (dest?.app) container = container.replace(new RegExp('\\s+(?:on|in|inside|within)\\s+' + esc(dest.app) + 's?\\s*$', 'i'), '').trim();
      if (dest?.url) container = container.replace(/\s+(?:on|in|inside|within)\s+\S+\s*$/i, m => /spotify|youtube|gmail|slack|music/i.test(m) ? '' : m).trim();
      if (container && container.length > 1 && !/^(it|there|here|that)$/i.test(container)) {
        // Sidebar rows label by NAME ("Quiet Hour"), not "Quiet Hour
        // playlist" — match the bare name first, full phrase as alternate.
        const navLabel = container
          .replace(/\b(playlist|playlists|folder|folders|list|lists|board|boards|collection|collections|album|cart|library|channel|space|project)s?\b/gi, '')
          .replace(/["'`]/g, '').replace(/\s{2,}/g, ' ').trim() || container;
        steps.push({ action: 'click', match: [navLabel, container], waitMatchMs: 5000, why: 'container-nav' });
      }
      steps.push({ action: 'auto', goal: c, maxIters: 20, check: addC[1].trim().slice(0, 60), why: 'container-add' });
      continue;
    }

    // ── "remove/delete/clear X from|in|inside Y" — subtractive container ────
    // Same container-nav targeting as adds (the container is the navigate-to
    // regardless of verb); the action inside differs. Goal-shape:
    // BULK_INTERACT {container, action:remove, entities:[*]} — no entity to
    // type, so the auto-loop commits bulk semantics (select-all or per-row).
    const remC = c.match(/^(?:remove|delete|clear|empty|erase|get rid of|take|strip)\s+(.+?)\s+(?:from|out of|off(?:\s+of)?|in|inside|within)\s+(?:my\s+|your\s+|our\s+|the\s+|a\s+|an\s+)?["'`]?(.+?)["'`]?[.\s]*$/i);
    if (remC) {
      let container = remC[2].trim().replace(/["'`]/g, '').replace(/[.\s]+$/, '').trim();
      if (dest?.app) container = container.replace(new RegExp('\\s+(?:on|in|inside|within)\\s+' + esc(dest.app) + 's?\\s*$', 'i'), '').trim();
      if (dest?.url) container = container.replace(/\s+(?:on|in|inside|within)\s+\S+\s*$/i, m => /spotify|youtube|gmail|slack|music/i.test(m) ? '' : m).trim();
      if (container && container.length > 1 && !/^(it|there|here|that)$/i.test(container)) {
        const navLabel = container
          .replace(/\b(playlist|playlists|folder|folders|list|lists|board|boards|collection|collections|album|cart|library|channel|space|project)s?\b/gi, '')
          .replace(/["'`]/g, '').replace(/\s{2,}/g, ' ').trim() || container;
        steps.push({ action: 'click', match: [navLabel, container], waitMatchMs: 5000, why: 'container-nav' });
      }
      steps.push({ action: 'auto', goal: c, maxIters: 20, bulk: 'remove', why: 'container-remove' });
      continue;
    }

    // ── "delete all/every X except Y" — LIST-scope delete: the visible rows ─
    // ARE the work items (library playlists, cart rows, file lists). No
    // container-nav — the list view is the surface, and exclusion names must
    // NEVER become click targets (earlier runs navigated INTO 'Quiet Hour').
    // remC above owns "remove X from Y" (contents of a container); this owns
    // the quantified delete of the items themselves.
    const delC = c.match(/^(?:in\s+.*?,\s*)?(?:delete|remove|clear|empty|erase|get rid of)\s+(?:all|every|each|any)\s+(?:of\s+)?(?:my\s+|the\s+|your\s+|our\s+)?["'`]?(.+?)["'`]?$/i)
      && !/\bfrom\b|\binside\b|\bwithin\b|\bout of\b/i.test(c);
    if (delC) {
      const excl = [];
      const _em = c.match(/(?:except|but|other than|apart from|excluding|save|keeping?)\s+(?:for\s+)?(.+?)$/i);
      if (_em) for (const q of _em[1].match(/["'`]([^"'`]+)["'`]|([\w'&\- ]{2,40})/g) || []) {
        const name = q.replace(/["'`]/g, '').replace(/[.,;!\s]+$/, '').trim();
        if (name && name.length > 1 && !/^(the|a|an|my|its?|it|that)$/i.test(name)) excl.push(name);
      }
      // goal = the WHOLE prompt, not the clause — multi-sentence specs carry
      // mechanism/skip/termination slots that clause-splitting would sever.
      steps.push({ action: 'auto', goal: prompt, bulk: 'delete',
        ...(excl.length ? { except: excl } : {}), maxIters: 40, why: 'list-delete' });
      notes.push(`bulk list-delete${excl.length ? ` except ${excl.join(', ')}` : ''}`);
      continue;
    }

    // ── "click on X" ────────────────────────────────────────────────────────
    if (/^(click|press|tap|select|choose|hit)\b/i.test(c)) {
      const t = _clickTarget(c);
      if (t) { steps.push({ action: 'click', match: t, waitMatchMs: 3000, why: 'click' }); continue; }
    }

    // ── "run/execute CMD" in a terminal ─────────────────────────────────────
    if (/^(run|execute|type|enter)\s+/i.test(c) && /terminal|console|shell/i.test(prompt)) {
      const cmd = c.replace(/^(run|execute|type|enter)\s+/i, '').replace(/["'`]/g, '').trim();
      // multi-window apps: ⌘N gives a fresh window that is guaranteed key+visible
      steps.push({ action: 'key', key: 'n', mods: ['cmd'], settleMs: 900, why: 'new-window' });
      steps.push({ action: 'type', text: cmd, clickWindow: true, why: 'cli' });
      steps.push({ action: 'key', key: 'return', settleMs: 900, why: 'cli-run' });
      continue;
    }

    // ── "set an event for DATE to TITLE" — Calendar quick-event parses ──────
    const ev = c.match(/(?:set|create|add|make|schedule)\s+(?:an?\s+)?event\s+(?:for\s+|on\s+)?(.+?)\s+(?:to|called|titled|that says)\s+["'`]?(.+?)["'`]?\s*$/i);
    if (ev) {
      steps.push({ action: 'shortcut', intent: 'new event', settleMs: 1200, why: 'new-event' });
      // Calendar's quick-event field parses natural dates from the title
      steps.push({ action: 'type', text: `${ev[2].trim()} ${ev[1].trim()}`, settleMs: 600, why: 'event-title+date' });
      steps.push({ action: 'key', key: 'return', settleMs: 800, why: 'event-save' });
      continue;
    }

    // ── "write a note / reminder / text" — create the entity first ──────────
    const entity = c.match(/(?:write|create|add|make|new|type)\s+(?:a\s+|an?\s+)?(new\s+)?(note|reminder|file|document)\b/i);
    if (entity) {
      const ent = entity[2].toLowerCase();
      const intent = { note: 'new note', reminder: 'new reminder', file: 'new', document: 'new' }[ent] || 'new';
      steps.push({ action: 'shortcut', intent, settleMs: 900, why: `new-${ent}` });
      const wr = _messageText(c) || c.match(/["'`](.+?)["'`]/)?.[1] || c.match(/(?:says?|saying|titled|called|with)\s+["'`]?(.+?)["'`]?\s*$/i)?.[1];
      if (wr) steps.push({ action: 'type', text: wr.trim(), why: `${ent}-text` });
      else { const bare = c.match(/(?:write|type)\s+(?:a\s+\w+\s+)?["'`]?(.+?)["'`]?\s*$/i); if (bare) steps.push({ action: 'type', text: bare[1].trim(), why: `${ent}-text` }); }
      continue;
    }

    // ── "send a message saying X" / "message X" ─────────────────────────────
    const msg = _messageText(c);
    if (msg && /\b(message|saying|text|say|tell|ask|write|type|enter|dm)\b/i.test(c)) {
      steps.push({ action: 'type', text: msg, why: 'message' });
      if (sendRequested) steps.push({ action: 'key', key: 'return', settleMs: 800, why: 'send' });
      continue;
    }

    // ── "find/search X on the page" — in-page find (⌘F → type → Esc) ────────
    // The human read flow: ⌘F jumps to and highlights the match, Esc clears
    // the find box leaving the match in view. Doubles as a passive read.
    const inpage = c.match(/(?:find|search for|search|look for|locate)\s+["'`]?(.+?)["'`]?\s+on\s+(?:the|this|that)\s+(?:page|document|file|email|thread|screen)/i);
    if (inpage && inpage[1]) {
      const q = inpage[1].trim().replace(/^the\s+(?:word|text|phrase|string|term)\s+/i, '');
      steps.push({ action: 'shortcut', intent: 'find', settleMs: 500, why: 'inpage-find-open' });
      steps.push({ action: 'type', text: q, waitMatchMs: 3000, why: 'inpage-find-type' });
      steps.push({ action: 'key', key: 'escape', settleMs: 600, why: 'inpage-find-close' });
      continue;
    }

    // ── "look up / search for X" ────────────────────────────────────────────
    const look = c.match(/(?:look ?up|search for|search|find|look for)\s+["'`]?(.+?)["'`]?\s*$/i);
    if (look && look[1]) {
      steps.push({ action: 'type', text: look[1].trim(), waitMatchMs: 3000, why: 'lookup' });
      steps.push({ action: 'key', key: 'return', settleMs: 1500, why: 'lookup-enter' });
      continue;
    }

    // ── "scroll down/up" ────────────────────────────────────────────────────
    const sc = c.match(/scroll\s+(down|up|to the bottom|to the top)/i);
    if (sc) {
      const down = !/up|top/i.test(sc[1]);
      steps.push({ action: 'scroll', dy: down ? -400 : 400, why: 'scroll' });
      continue;
    }

    // ── generic "type/write TEXT" ─────────────────────────────────────────
    const ty = c.match(/^(?:type|write|enter|input)\s+(?:a\s+\w+\s+)?["'`]?(.+?)["'`]?\s*$/i);
    if (ty && ty[1] && !/^(a|an|the)\s/i.test(ty[1])) {
      // editor apps that open with a file dialog need a document first
      if (dest?.app && /textedit|word|pages|notepad/i.test(dest.app)) {
        steps.push({ action: 'key', key: 'n', mods: ['cmd'], settleMs: 900, why: 'new-doc' });
      }
      steps.push({ action: 'type', text: ty[1].trim(), why: 'type' });
      continue;
    }

    // ── "save as / name it / title it X" — document title field ────────────
    // Google Docs & editors name the file via the title field (top-left,
    // "Untitled document"). Click it, select-all, type the name, Enter.
    const sv = c.match(/(?:save|name|title|rename)\s+(?:it\s+|this\s+|the\s+\w+\s+)?(?:as|to)\s+["'`]?(.+?)["'`]?\s*$/i);
    if (sv && sv[1]) {
      steps.push({ action: 'click', match: 'Untitled document', why: 'title-field' });
      steps.push({ action: 'key', key: 'a', mods: ['cmd'], settleMs: 300, why: 'title-select' });
      steps.push({ action: 'type', text: sv[1].trim(), why: 'title' });
      steps.push({ action: 'key', key: 'return', settleMs: 800, why: 'title-commit' });
      continue;
    }

    // ── shortcut-intent clauses ─────────────────────────────────────────────
    const ip = INTENT_PATTERNS.find(p => p.re.test(c));
    if (ip) { steps.push({ action: 'shortcut', intent: ip.intent, why: 'shortcut' }); continue; }

    // ── residue → model pick ────────────────────────────────────────────────
    if (c.length > 2) {
      residueClauses.push(c);
      steps.push({ action: 'click', match: c.slice(0, 60), why: 'residue-click' });
      notes.push(`residue clause fell to screen pick: "${c.slice(0, 60)}"`);
    }
  }

  // ── Multi-intent residue → runtime auto-loop ─────────────────────────────
  // Two+ clauses that matched NO deterministic pattern aren't labels — clause
  // text ("make a playlist called X on spotify") fuzzy-matches OCR noise and
  // clicks garbage. Hand them to screen.act's observe→decide→act loop instead:
  // it decomposes against the LIVE element list one micro-action at a time,
  // and a verified run earns a learned recipe. Single residue clauses keep
  // the literal-click path (runStep's modelPick fallback already covers them).
  // A bulk-delete step already carries the ENTIRE prompt (mechanism/skip/
  // termination sentences included) — residue steps from those same
  // sentences would re-derive the task and fight the delete lane.
  if (steps.some(s => s.bulk === 'delete')) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].why === 'residue-click') steps.splice(i, 1);
    }
  }
  if (!flowSteps && residueClauses.length >= 1 && !steps.some(s => s.bulk === 'delete')) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].why === 'residue-click') steps.splice(i, 1);
    }
    const autoGoal = residueClauses.join(' and ');
    const named = flowCache.extractEntities(prompt)[0];
    steps.push({
      action: 'auto', goal: autoGoal, maxIters: 20,
      ...(named && named.length > 1 ? { check: named } : {}),
      why: 'auto-loop',
    });
    notes.push(`auto-loop for ${residueClauses.length} residue clauses`);
  }

  // The render URL carries title + date + time — the only interaction left
  // is the Save button. Drop any residue-click noise for the same clause.
  if (gcalSaveStep) steps.splice(0, steps.length, gcalSaveStep);

  // ── Terminal state check ────────────────────────────────────────────────
  // Every create/named deliverable ends with an observed-state gate: the
  // named entity must be visible on screen. Step-level verifies pass on
  // partial progress; this is the "did the task actually happen" check that
  // stops synthesize from narrating success off step text. Learned flows
  // already carry their own verify — don't double-append.
  if (!steps.some(s => s.action === 'verify')) {
    const nameable = /\b(playlist|document|doc|note|event|calendar|file|page|post|comment|task|reminder|list|folder|album|station|spreadsheet|presentation|deck)\b/i.test(prompt);
    const named = nameable && /(?:called|named|titled|create|make|new|add|save|write|build)/i.test(prompt)
      ? flowCache.extractEntities(prompt)[0] : null;
    if (named && named.length > 1) {
      steps.push({ action: 'verify', check: named, waitMatchMs: 8000, why: 'final-state' });
      notes.push(`final-state verify appended for "${named}"`);
    }
  }
  return { setup, steps, notes, dest, sendRequested };
}

module.exports = { deriveSteps, DESTINATIONS, INTENT_PATTERNS };
