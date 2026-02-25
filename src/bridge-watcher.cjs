'use strict';

/**
 * bridge-watcher.cjs
 *
 * Standalone daemon that watches ~/.thinkdrop/bridge.md for new TD: blocks
 * and automatically triggers the target IDE (Windsurf, Cursor, VS Code, Warp).
 *
 * When ThinkDrop writes a TD:INSTRUCTION block, this watcher:
 *   1. Detects the new block via fs.watch (debounced)
 *   2. Sends a macOS notification with the instruction summary
 *   3. Copies the instruction to the system clipboard
 *   4. Optionally opens/focuses the target IDE
 *   5. Optionally writes a trigger file the IDE's rules can detect
 *
 * When the IDE writes back a WS: block, this watcher:
 *   1. Detects the response
 *   2. Sends a notification back to ThinkDrop (via stdout IPC or notification)
 *   3. Writes a response-ready marker so ThinkDrop's poll loop unblocks fast
 *
 * Usage (as a child process started by file.bridge skill):
 *   node bridge-watcher.cjs [--bridge-file PATH] [--ide windsurf|cursor|vscode|warp] [--notify true]
 *
 * IPC (stdout JSON lines — read by parent process):
 *   { type: 'ready', bridgeFile, pid }
 *   { type: 'td_block', block: { id, type, ts, status, body } }
 *   { type: 'ws_block', block: { id, type, ts, status, refId, body } }
 *   { type: 'error', error }
 *   { type: 'exit' }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync, execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Config from args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(name) {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : null;
}

const DEFAULT_BRIDGE_FILE = path.join(os.homedir(), '.thinkdrop', 'bridge.md');
const BRIDGE_FILE = getArg('--bridge-file') || DEFAULT_BRIDGE_FILE;
const TARGET_IDE = (getArg('--ide') || 'windsurf').toLowerCase();
const NOTIFY = getArg('--notify') !== 'false';
const DEBOUNCE_MS = parseInt(getArg('--debounce') || '600', 10);
const WRITE_TRIGGER_FILE = getArg('--trigger-file') !== 'false'; // writes .bridge-trigger file

const TRIGGER_FILE = path.join(path.dirname(BRIDGE_FILE), '.bridge-trigger.md');

// IDE app names for macOS `open -a`
const IDE_APP_NAMES = {
  windsurf: 'Windsurf',
  cursor: 'Cursor',
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
  warp: 'Warp',
};

// ---------------------------------------------------------------------------
// Block parser (same protocol as file.bridge.cjs)
// ---------------------------------------------------------------------------

function parseBlocks(content) {
  const blocks = [];
  const blockPattern = /<!--\s*([A-Z][A-Z0-9_]*):([\w]+)\s+(.*?)-->([\s\S]*?)<!--\s*\1:END\s*-->/g;
  let match;
  while ((match = blockPattern.exec(content)) !== null) {
    const [raw, prefix, type, attrsStr, body] = match;
    if (type === 'END') continue;
    const attrs = {};
    const attrRe = /(\w+)=([^\s>]+)/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    blocks.push({
      id: attrs.id || `${prefix}_${type}_unknown`,
      prefix, type,
      ts: attrs.ts || null,
      status: attrs.status || 'unknown',
      refId: attrs.ref || null,
      body: body.trim(),
      raw,
    });
  }
  return blocks;
}

function hashBlocks(blocks) {
  return crypto.createHash('md5').update(JSON.stringify(blocks.map(b => b.id))).digest('hex');
}

// ---------------------------------------------------------------------------
// macOS notification via osascript
// ---------------------------------------------------------------------------

function sendNotification(title, body) {
  if (!NOTIFY) return;
  try {
    const safeTitle = title.replace(/"/g, '\\"').replace(/\n/g, ' ');
    const safeBody = body.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 200);
    spawnSync('osascript', [
      '-e',
      `display notification "${safeBody}" with title "${safeTitle}" sound name "Ping"`
    ], { timeout: 3000 });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Copy to clipboard via pbcopy
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  try {
    const result = spawnSync('pbcopy', [], {
      input: text,
      encoding: 'utf8',
      timeout: 3000,
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Focus IDE app
// ---------------------------------------------------------------------------

function focusIDE(ideName) {
  const appName = IDE_APP_NAMES[ideName] || ideName;
  try {
    spawnSync('open', ['-a', appName], { timeout: 5000 });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Write trigger file — IDE rules can watch for this to appear/change
// ---------------------------------------------------------------------------

function writeTriggerFile(block) {
  if (!WRITE_TRIGGER_FILE) return;
  try {
    const content = [
      `# ThinkDrop Bridge Trigger`,
      ``,
      `**New instruction from ThinkDrop** — ${block.ts || new Date().toISOString()}`,
      `**Block ID:** \`${block.id}\``,
      `**Status:** ${block.status}`,
      ``,
      `## Instruction`,
      ``,
      block.body,
      ``,
      `---`,
      `*To respond: append a \`<!-- WS:RESPONSE ref=${block.id} ... -->\` block to \`${BRIDGE_FILE}\`*`,
    ].join('\n');
    fs.writeFileSync(TRIGGER_FILE, content, 'utf8');
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// IPC — emit JSON lines to stdout (parent process reads these)
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// Main watcher loop
// ---------------------------------------------------------------------------

// Ensure bridge dir exists
const bridgeDir = path.dirname(BRIDGE_FILE);
if (!fs.existsSync(bridgeDir)) {
  fs.mkdirSync(bridgeDir, { recursive: true });
}
// Create bridge file if missing
if (!fs.existsSync(BRIDGE_FILE)) {
  fs.writeFileSync(BRIDGE_FILE, '# ThinkDrop Bridge\n\n', 'utf8');
}

// Read initial state so we only react to NEW blocks
let lastContent = fs.existsSync(BRIDGE_FILE) ? fs.readFileSync(BRIDGE_FILE, 'utf8') : '';
let lastBlocks = parseBlocks(lastContent);
let lastBlockHash = hashBlocks(lastBlocks);
let lastTDCount = lastBlocks.filter(b => b.prefix === 'TD').length;
let lastWSCount = lastBlocks.filter(b => b.prefix !== 'TD').length;

emit({ type: 'ready', bridgeFile: BRIDGE_FILE, pid: process.pid, ide: TARGET_IDE });

let debounceTimer = null;

const watcher = fs.watch(BRIDGE_FILE, { persistent: true }, (eventType) => {
  if (eventType !== 'change' && eventType !== 'rename') return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(BRIDGE_FILE)) return;
      const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
      const blocks = parseBlocks(content);
      const newHash = hashBlocks(blocks);

      if (newHash === lastBlockHash) return; // no actual change

      const newTDBlocks = blocks.filter(b =>
        b.prefix === 'TD' && !lastBlocks.some(lb => lb.id === b.id)
      );
      const newWSBlocks = blocks.filter(b =>
        b.prefix !== 'TD' && !lastBlocks.some(lb => lb.id === b.id)
      );

      // React to new TD blocks (ThinkDrop wrote an instruction for the IDE)
      for (const block of newTDBlocks) {
        if (block.status !== 'pending') continue;

        emit({ type: 'td_block', block });

        const summary = block.body.split('\n')[0].slice(0, 100);

        // 1. macOS notification
        sendNotification(`ThinkDrop → ${TARGET_IDE.charAt(0).toUpperCase() + TARGET_IDE.slice(1)}`, summary);

        // 2. Copy full instruction to clipboard so IDE can paste/read it
        const clipboardText = [
          `## ThinkDrop Instruction [${block.id}]`,
          ``,
          block.body,
          ``,
          `---`,
          `When done, append to ${BRIDGE_FILE}:`,
          `<!-- WS:RESPONSE id=ws_response_<id> ref=${block.id} ts=<ISO> status=done -->`,
          `<your summary>`,
          `<!-- WS:END -->`,
        ].join('\n');
        copyToClipboard(clipboardText);

        // 3. Write trigger file (IDE can watch this file in its rules)
        writeTriggerFile(block);

        // 4. Focus the IDE
        focusIDE(TARGET_IDE);
      }

      // React to new WS blocks (IDE wrote a response back to ThinkDrop)
      for (const block of newWSBlocks) {
        emit({ type: 'ws_block', block });

        const summary = block.body.split('\n')[0].slice(0, 100);
        sendNotification(
          `${block.prefix} responded to ThinkDrop`,
          `${block.status}: ${summary}`
        );
      }

      lastContent = content;
      lastBlocks = blocks;
      lastBlockHash = newHash;
    } catch (err) {
      emit({ type: 'error', error: err.message });
    }
  }, DEBOUNCE_MS);
});

watcher.on('error', (err) => {
  emit({ type: 'error', error: err.message });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  watcher.close();
  emit({ type: 'exit' });
  process.exit(0);
});
process.on('SIGINT', () => {
  watcher.close();
  emit({ type: 'exit' });
  process.exit(0);
});
