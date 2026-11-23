'use strict';

// ---------------------------------------------------------------------------
// app-shortcuts.cjs — per-app keyboard shortcut registry (data, not code).
//
// Desktop counterpart to the browser-side loadShortcutTable (keyed by
// hostname). Keyed by app name / bundle-id aliases; each entry maps a
// normalized action name → { key, mods, desc }. App-mode shortcut.keys looks
// up the frontmost (or named) app here and fires via keyboard.agent —
// CGEvent mods+key through td-ui-parse.
//
// Resolution order for an action:
//   1. app's own table (exact, then case-insensitive fuzzy on words)
//   2. '*' generic table (universal macOS shortcuts)
// ---------------------------------------------------------------------------

const APP_SHORTCUTS = {
  // ── Visual Studio Code / Code forks (com.microsoft.VSCode, Windsurf, Cursor)
  vscode: {
    'command palette':   { key: 'p', mods: ['cmd', 'shift'], desc: 'Command Palette' },
    'quick open':        { key: 'p', mods: ['cmd'],          desc: 'Quick Open (files by name)' },
    'copilot chat':      { key: 'i', mods: ['ctrl', 'cmd'],  desc: 'Open Copilot Chat view' },
    'chat':              { key: 'i', mods: ['ctrl', 'cmd'],  desc: 'Open Chat view' },
    'new file':          { key: 'n', mods: ['cmd'],          desc: 'New untitled file' },
    'new window':        { key: 'n', mods: ['cmd', 'shift'], desc: 'New window' },
    'terminal':          { key: '`', mods: ['ctrl'],         desc: 'Toggle terminal' },
    'find in files':     { key: 'f', mods: ['cmd', 'shift'], desc: 'Search across files' },
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find in file' },
    'goto line':         { key: 'g', mods: ['ctrl'],         desc: 'Go to line' },
    'goto symbol':       { key: 'o', mods: ['cmd', 'shift'], desc: 'Go to symbol' },
    'sidebar':           { key: 'b', mods: ['cmd'],          desc: 'Toggle sidebar' },
    'explorer':          { key: 'e', mods: ['cmd', 'shift'], desc: 'Explorer view' },
    'save':              { key: 's', mods: ['cmd'],          desc: 'Save' },
    'save all':          { key: 's', mods: ['cmd', 'alt'],   desc: 'Save all' },
    'settings':          { key: ',', mods: ['cmd'],          desc: 'Settings' },
    'close editor':      { key: 'w', mods: ['cmd'],          desc: 'Close editor' },
    'zen mode':          { key: 'z', mods: ['cmd', 'k'],     desc: 'Zen mode' }, // chord: cmd+k then z — treat as cmd+k prefix
  },
  // ── Browsers (Chrome family + Safari) ─────────────────────────────────────
  chrome: {
    'address bar':       { key: 'l', mods: ['cmd'],          desc: 'Focus address bar' },
    'new tab':           { key: 't', mods: ['cmd'],          desc: 'New tab' },
    'close tab':         { key: 'w', mods: ['cmd'],          desc: 'Close tab' },
    'reopen tab':        { key: 't', mods: ['cmd', 'shift'], desc: 'Reopen closed tab' },
    'reload':            { key: 'r', mods: ['cmd'],          desc: 'Reload' },
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find on page' },
    'next tab':          { key: 'tab', mods: ['ctrl'],       desc: 'Next tab' },
    'previous tab':      { key: 'tab', mods: ['ctrl', 'shift'], desc: 'Previous tab' },
    'history':           { key: 'y', mods: ['cmd'],          desc: 'History' },
    'bookmarks':         { key: 'b', mods: ['cmd', 'alt'],   desc: 'Bookmarks' },
    'zoom in':           { key: '=', mods: ['cmd'],          desc: 'Zoom in' },
    'zoom out':          { key: '-', mods: ['cmd'],          desc: 'Zoom out' },
    'settings':          { key: ',', mods: ['cmd'],          desc: 'Settings' },
  },
  safari: {
    'address bar':       { key: 'l', mods: ['cmd'],          desc: 'Focus address bar' },
    'new tab':           { key: 't', mods: ['cmd'],          desc: 'New tab' },
    'close tab':         { key: 'w', mods: ['cmd'],          desc: 'Close tab' },
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find on page' },
    'reload':            { key: 'r', mods: ['cmd'],          desc: 'Reload' },
  },
  // ── Finder ────────────────────────────────────────────────────────────────
  finder: {
    'new window':        { key: 'n', mods: ['cmd'],          desc: 'New Finder window' },
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find' },
    'go to folder':      { key: 'g', mods: ['cmd', 'shift'], desc: 'Go to folder…' },
    'documents':         { key: 'o', mods: ['cmd', 'shift'], desc: 'Documents folder' },
    'desktop':           { key: 'd', mods: ['cmd', 'shift'], desc: 'Desktop folder' },
    'downloads':         { key: 'l', mods: ['cmd', 'alt'],   desc: 'Downloads folder' },
    'home':              { key: 'h', mods: ['cmd', 'shift'], desc: 'Home folder' },
    'applications':      { key: 'a', mods: ['cmd', 'shift'], desc: 'Applications folder' },
    'get info':          { key: 'i', mods: ['cmd'],          desc: 'Get Info' },
    'quick look':        { key: 'space', mods: [],           desc: 'Quick Look' },
    'list view':         { key: '2', mods: ['cmd'],          desc: 'List view' },
    'icon view':         { key: '1', mods: ['cmd'],          desc: 'Icon view' },
  },
  // ── Terminal / iTerm ──────────────────────────────────────────────────────
  terminal: {
    'new tab':           { key: 't', mods: ['cmd'],          desc: 'New tab' },
    'new window':        { key: 'n', mods: ['cmd'],          desc: 'New window' },
    'clear':             { key: 'k', mods: ['cmd'],          desc: 'Clear buffer' },
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find' },
  },
  // ── Mail / Slack / Notes-style generic already covered by '*' ─────────────
  // ── Universal macOS shortcuts (fallback for any app) ─────────────────────
  '*': {
    'find':              { key: 'f', mods: ['cmd'],          desc: 'Find' },
    'open':              { key: 'o', mods: ['cmd'],          desc: 'Open' },
    'save':              { key: 's', mods: ['cmd'],          desc: 'Save' },
    'print':             { key: 'p', mods: ['cmd'],          desc: 'Print' },
    'settings':          { key: ',', mods: ['cmd'],          desc: 'Preferences/Settings' },
    'preferences':       { key: ',', mods: ['cmd'],          desc: 'Preferences/Settings' },
    'close window':      { key: 'w', mods: ['cmd'],          desc: 'Close window' },
    'quit':              { key: 'q', mods: ['cmd'],          desc: 'Quit' },
    'undo':              { key: 'z', mods: ['cmd'],          desc: 'Undo' },
    'redo':              { key: 'z', mods: ['cmd', 'shift'], desc: 'Redo' },
    'copy':              { key: 'c', mods: ['cmd'],          desc: 'Copy' },
    'paste':             { key: 'v', mods: ['cmd'],          desc: 'Paste' },
    'cut':               { key: 'x', mods: ['cmd'],          desc: 'Cut' },
    'select all':        { key: 'a', mods: ['cmd'],          desc: 'Select all' },
    'spotlight':         { key: 'space', mods: ['cmd'],      desc: 'Spotlight search' },
    'screenshot area':   { key: '4', mods: ['cmd', 'shift'], desc: 'Screenshot area' },
    'force quit':        { key: 'escape', mods: ['cmd', 'alt'], desc: 'Force Quit dialog' },
  },
};

// App aliases — anything matching these names maps to the registry table.
const APP_ALIASES = {
  'visual studio code': 'vscode', 'code': 'vscode', 'vscode': 'vscode',
  'windsurf': 'vscode', 'cursor': 'vscode', 'com.microsoft.vscode': 'vscode',
  'com.visualstudio.code.oss': 'vscode', 'com.exafunction.windsurf': 'vscode',
  'google chrome': 'chrome', 'chrome': 'chrome', 'com.google.chrome': 'chrome',
  'chromium': 'chrome', 'arc': 'chrome', 'company.thebrowser.browser': 'chrome',
  'microsoft edge': 'chrome', 'brave': 'chrome', 'com.brave.browser': 'chrome',
  'safari': 'safari', 'com.apple.safari': 'safari',
  'firefox': 'chrome', 'org.mozilla.firefox': 'chrome', // close enough — same core combos
  'finder': 'finder', 'com.apple.finder': 'finder',
  'terminal': 'terminal', 'com.apple.terminal': 'terminal',
  'iterm2': 'terminal', 'com.googlecode.iterm2': 'terminal',
};

function normalizeAppKey(app) {
  if (!app) return null;
  const n = String(app).toLowerCase().replace(/\.app$/i, '').trim();
  if (APP_SHORTCUTS[n]) return n;
  if (APP_ALIASES[n]) return APP_ALIASES[n];
  // partial match over aliases (e.g. "Visual Studio Code.app" already stripped)
  for (const [alias, key] of Object.entries(APP_ALIASES)) {
    if (n === alias || n.includes(alias)) return key;
  }
  return null;
}

/**
 * lookUpShortcut(app, action) → { key, mods, desc, table } | null
 * app: app name / bundle id (or null for frontmost — caller resolves name).
 * action: e.g. 'copilot chat', 'command palette', 'find'.
 */
function lookupShortcut(app, action) {
  const tableKey = normalizeAppKey(app);
  const norm = String(action || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!norm) return null;

  const tryTable = (key) => {
    const table = APP_SHORTCUTS[key];
    if (!table) return null;
    if (table[norm]) return { ...table[norm], table: key };
    // fuzzy: action words all present in entry name or vice-versa
    const words = norm.split(' ').filter(w => w.length > 1);
    for (const [name, sc] of Object.entries(table)) {
      const nw = name.split(' ');
      const hit = words.every(w => name.includes(w)) || nw.every(w => norm.includes(w));
      if (hit) return { ...sc, table: key, matched: name };
    }
    return null;
  };

  if (tableKey) {
    const hit = tryTable(tableKey);
    if (hit) return hit;
  }
  return tryTable('*');
}

/** List actions known for an app (registry + generic). */
function listShortcuts(app) {
  const tableKey = normalizeAppKey(app);
  const out = [];
  if (tableKey && APP_SHORTCUTS[tableKey]) {
    for (const [name, sc] of Object.entries(APP_SHORTCUTS[tableKey])) {
      out.push({ action: name, ...sc, table: tableKey });
    }
  }
  for (const [name, sc] of Object.entries(APP_SHORTCUTS['*'])) {
    out.push({ action: name, ...sc, table: '*' });
  }
  return out;
}

module.exports = { lookupShortcut, listShortcuts, normalizeAppKey, APP_SHORTCUTS };
