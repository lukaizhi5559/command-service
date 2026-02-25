'use strict';

/**
 * skill: file.bridge
 *
 * Bidirectional .md file communication channel between ThinkDrop AI and external tools
 * (Windsurf, Cursor, Warp, any editor/agent that can read/write files).
 *
 * Protocol:
 *   The shared bridge file (~/.thinkdrop/bridge.md by default) uses structured comment
 *   blocks that both sides can parse without breaking Markdown rendering:
 *
 *   <!-- TD:INSTRUCTION id=<id> ts=<iso> status=pending -->
 *   <message body — plain text or markdown>
 *   <!-- TD:END -->
 *
 *   <!-- WS:RESPONSE id=<id> ref=<td-id> ts=<iso> status=done -->
 *   <response body>
 *   <!-- WS:END -->
 *
 *   Prefixes:
 *     TD: — written by ThinkDrop AI
 *     WS: — written by Windsurf / Cursor / external agent
 *   (Custom prefix configurable via `prefix` arg)
 *
 * Actions:
 *   write    — write/append a TD: instruction block to the bridge file
 *   read     — read all message blocks, optionally filtered by prefix/status
 *   poll     — wait for a new WS: (or any non-TD) response block since last write
 *   clear    — remove all blocks with a given prefix (or all blocks)
 *   status   — show bridge file path, block counts, last activity
 *   init     — create/reset the bridge file with a header comment
 *
 * Args schema:
 * {
 *   action:       string    — 'write' | 'read' | 'poll' | 'clear' | 'status' | 'init'
 *   message:      string    — body text to write (for 'write')
 *   bridgeFile:   string    — path to bridge .md file (default: ~/.thinkdrop/bridge.md)
 *   prefix:       string    — block prefix for write: 'TD' (default) or custom
 *   blockType:    string    — block type label, e.g. 'INSTRUCTION', 'RESULT', 'QUESTION' (default 'INSTRUCTION')
 *   status:       string    — status tag: 'pending' | 'done' | 'error' | 'info' (default 'pending')
 *   refId:        string    — reference ID of a prior block this responds to
 *   filterPrefix: string    — for read/poll: only return blocks with this prefix (e.g. 'WS')
 *   filterStatus: string    — for read: only return blocks with this status
 *   pollTimeoutMs: number   — for poll: max ms to wait for a response block (default 120000 = 2min)
 *   sinceTs:      string    — for poll/read: only return blocks after this ISO timestamp
 *   label:        string    — human label for this bridge channel (shown in status)
 * }
 *
 * Returns:
 * {
 *   ok:          boolean
 *   action:      string
 *   bridgeFile:  string
 *   blockId?:    string    — ID of the block written
 *   blocks?:     Block[]   — parsed blocks (for read/poll)
 *   newBlocks?:  Block[]   — new blocks found (for poll)
 *   changed?:    boolean   — whether any new blocks arrived (for poll)
 *   error?:      string
 * }
 *
 * Block shape:
 * {
 *   id:        string    — unique block ID
 *   prefix:    string    — 'TD' | 'WS' | custom
 *   type:      string    — 'INSTRUCTION' | 'RESPONSE' | custom
 *   ts:        string    — ISO timestamp
 *   status:    string    — 'pending' | 'done' | 'error' | 'info'
 *   refId?:    string    — reference to another block's ID
 *   body:      string    — block body content (trimmed)
 *   raw:       string    — full raw block text
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const logger = require('../logger.cjs');

// In-process watcher daemon registry (survives across skill calls in same process)
const WATCHER_PROCS = new Map(); // bridgeFile → { proc, pid, ide, startedAt }

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BRIDGE_FILE = path.join(os.homedir(), '.thinkdrop', 'bridge.md');
const DEFAULT_PREFIX = 'TD';
const DEFAULT_BLOCK_TYPE = 'INSTRUCTION';
const DEFAULT_POLL_TIMEOUT_MS = 120000; // 2 minutes
const POLL_INTERVAL_MS = 500;

const BRIDGE_HEADER = `# ThinkDrop Bridge

This file is the communication channel between ThinkDrop AI and external tools (Windsurf, Cursor, Warp, etc.).

- **ThinkDrop** writes \`TD:\` blocks with instructions or results
- **External agents** write \`WS:\` (or custom prefix) blocks with responses

Each block is a structured HTML comment that renders invisibly in Markdown previews.
The body between the open/close tags is plain Markdown that renders normally.

---

`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBridgeFile(inputPath) {
  if (!inputPath) return DEFAULT_BRIDGE_FILE;
  return path.resolve(inputPath.replace(/^~/, os.homedir()));
}

function generateBlockId(prefix, type) {
  const hash = crypto.randomBytes(3).toString('hex');
  const ts = Date.now().toString(36);
  return `${prefix.toLowerCase()}_${type.toLowerCase()}_${ts}${hash}`;
}

function formatIso() {
  return new Date().toISOString();
}

function ensureBridgeDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Block parser — extracts all structured blocks from the bridge file content
// ---------------------------------------------------------------------------

// Matches: <!-- PREFIX:TYPE id=X ts=Y status=Z [ref=R] -->
//          ...body...
//          <!-- PREFIX:END -->
const BLOCK_OPEN_RE = /<!--\s*([A-Z][A-Z0-9_]*):([\w]+)\s+(.*?)-->/g;
const ATTR_RE = /(\w+)=([^\s>]+)/g;

function parseBlocks(content) {
  const blocks = [];
  // Split on close tags to find block regions
  const blockPattern = /<!--\s*([A-Z][A-Z0-9_]*):([\w]+)\s+(.*?)-->([\s\S]*?)<!--\s*\1:END\s*-->/g;
  let match;
  while ((match = blockPattern.exec(content)) !== null) {
    const [raw, prefix, type, attrsStr, body] = match;
    if (type === 'END') continue;

    const attrs = {};
    let attrMatch;
    const attrRe = /(\w+)=([^\s>]+)/g;
    while ((attrMatch = attrRe.exec(attrsStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    blocks.push({
      id: attrs.id || `${prefix}_${type}_unknown`,
      prefix,
      type,
      ts: attrs.ts || null,
      status: attrs.status || 'unknown',
      refId: attrs.ref || null,
      body: body.trim(),
      raw,
    });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Action: init — create/reset the bridge file
// ---------------------------------------------------------------------------

function actionInit(bridgeFile, options) {
  const { label } = options;
  ensureBridgeDir(bridgeFile);

  const header = BRIDGE_HEADER + (label ? `**Channel:** ${label}\n\n---\n\n` : '');

  try {
    fs.writeFileSync(bridgeFile, header, 'utf8');
    logger.info('file.bridge init', { bridgeFile });
    return {
      ok: true,
      bridgeFile,
      message: `Bridge file initialized: ${bridgeFile}`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to init bridge file: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: write — append a block to the bridge file
// ---------------------------------------------------------------------------

function actionWrite(bridgeFile, options) {
  const {
    message,
    prefix = DEFAULT_PREFIX,
    blockType = DEFAULT_BLOCK_TYPE,
    status = 'pending',
    refId,
  } = options;

  if (!message || !message.trim()) {
    return { ok: false, error: 'message is required for write action' };
  }

  ensureBridgeDir(bridgeFile);

  // Create bridge file with header if it doesn't exist
  if (!fs.existsSync(bridgeFile)) {
    fs.writeFileSync(bridgeFile, BRIDGE_HEADER, 'utf8');
  }

  const blockId = generateBlockId(prefix, blockType);
  const ts = formatIso();
  const refAttr = refId ? ` ref=${refId}` : '';

  const block = [
    `<!-- ${prefix}:${blockType} id=${blockId} ts=${ts} status=${status}${refAttr} -->`,
    message.trim(),
    `<!-- ${prefix}:END -->`,
    '',
  ].join('\n');

  try {
    fs.appendFileSync(bridgeFile, '\n' + block, 'utf8');
    logger.info('file.bridge write', { bridgeFile, blockId, prefix, blockType, status });

    return {
      ok: true,
      bridgeFile,
      blockId,
      prefix,
      blockType,
      status,
      ts,
      message: `Block written: ${blockId}`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to write to bridge file: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: read — read and parse all blocks
// ---------------------------------------------------------------------------

function actionRead(bridgeFile, options) {
  const { filterPrefix, filterStatus, sinceTs } = options;

  if (!fs.existsSync(bridgeFile)) {
    return {
      ok: true,
      bridgeFile,
      blocks: [],
      count: 0,
      message: 'Bridge file does not exist yet',
    };
  }

  let content;
  try {
    content = fs.readFileSync(bridgeFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `Failed to read bridge file: ${err.message}` };
  }

  let blocks = parseBlocks(content);

  if (filterPrefix) {
    blocks = blocks.filter(b => b.prefix === filterPrefix.toUpperCase());
  }
  if (filterStatus) {
    blocks = blocks.filter(b => b.status === filterStatus);
  }
  if (sinceTs) {
    const since = new Date(sinceTs).getTime();
    blocks = blocks.filter(b => b.ts && new Date(b.ts).getTime() > since);
  }

  return {
    ok: true,
    bridgeFile,
    blocks,
    count: blocks.length,
  };
}

// ---------------------------------------------------------------------------
// Action: poll — wait for a response block from external agent
// ---------------------------------------------------------------------------

async function actionPoll(bridgeFile, options) {
  const {
    filterPrefix,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    sinceTs,
  } = options;

  // Determine the baseline timestamp — only show blocks newer than this
  const baseline = sinceTs ? new Date(sinceTs).getTime() : Date.now();
  const deadline = Date.now() + pollTimeoutMs;

  logger.info('file.bridge poll start', { bridgeFile, filterPrefix, pollTimeoutMs });

  while (Date.now() < deadline) {
    if (!fs.existsSync(bridgeFile)) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(bridgeFile, 'utf8');
    } catch (_) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    let blocks = parseBlocks(content);

    // Filter to blocks newer than baseline
    const newBlocks = blocks.filter(b => {
      if (!b.ts) return false;
      return new Date(b.ts).getTime() > baseline;
    });

    // Apply prefix filter (default: anything NOT written by ThinkDrop)
    const responseBlocks = newBlocks.filter(b => {
      if (filterPrefix) return b.prefix === filterPrefix.toUpperCase();
      return b.prefix !== DEFAULT_PREFIX; // any non-TD block is a response
    });

    if (responseBlocks.length > 0) {
      logger.info('file.bridge poll found response', { count: responseBlocks.length });
      return {
        ok: true,
        bridgeFile,
        changed: true,
        newBlocks: responseBlocks,
        count: responseBlocks.length,
        latestBlock: responseBlocks[responseBlocks.length - 1],
      };
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timed out — no response
  logger.info('file.bridge poll timed out', { pollTimeoutMs });
  return {
    ok: true,
    bridgeFile,
    changed: false,
    newBlocks: [],
    count: 0,
    message: `No response received within ${pollTimeoutMs}ms`,
  };
}

// ---------------------------------------------------------------------------
// Action: clear — remove blocks from the bridge file
// ---------------------------------------------------------------------------

function actionClear(bridgeFile, options) {
  const { filterPrefix } = options;

  if (!fs.existsSync(bridgeFile)) {
    return { ok: true, bridgeFile, message: 'Bridge file does not exist, nothing to clear' };
  }

  let content;
  try {
    content = fs.readFileSync(bridgeFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `Failed to read bridge file: ${err.message}` };
  }

  let newContent;
  if (!filterPrefix) {
    // Clear all blocks but keep the header
    newContent = content.replace(
      /\n<!-- [A-Z][A-Z0-9_]*:[\w]+ [\s\S]*?<!-- [A-Z][A-Z0-9_]*:END -->/g,
      ''
    );
  } else {
    const prefix = filterPrefix.toUpperCase();
    // Remove only blocks with this prefix
    const blockRe = new RegExp(
      `\\n<!-- ${prefix}:[\\w]+ [\\s\\S]*?<!-- ${prefix}:END -->`,
      'g'
    );
    newContent = content.replace(blockRe, '');
  }

  try {
    fs.writeFileSync(bridgeFile, newContent, 'utf8');
    const clearedDesc = filterPrefix ? `${filterPrefix.toUpperCase()} blocks` : 'all blocks';
    return {
      ok: true,
      bridgeFile,
      message: `Cleared ${clearedDesc} from bridge file`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to write bridge file: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: status — bridge file metadata and block counts
// ---------------------------------------------------------------------------

function actionStatus(bridgeFile) {
  const exists = fs.existsSync(bridgeFile);

  if (!exists) {
    return {
      ok: true,
      bridgeFile,
      exists: false,
      message: `Bridge file not yet created: ${bridgeFile}`,
      tdBlocks: 0,
      wsBlocks: 0,
      totalBlocks: 0,
    };
  }

  let content, stat;
  try {
    content = fs.readFileSync(bridgeFile, 'utf8');
    stat = fs.statSync(bridgeFile);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const blocks = parseBlocks(content);
  const tdBlocks = blocks.filter(b => b.prefix === 'TD');
  const wsBlocks = blocks.filter(b => b.prefix === 'WS');
  const otherBlocks = blocks.filter(b => b.prefix !== 'TD' && b.prefix !== 'WS');

  const lastBlock = blocks[blocks.length - 1] || null;

  return {
    ok: true,
    bridgeFile,
    exists: true,
    size: stat.size,
    modified: stat.mtime.toISOString(),
    totalBlocks: blocks.length,
    tdBlocks: tdBlocks.length,
    wsBlocks: wsBlocks.length,
    otherBlocks: otherBlocks.length,
    pendingTD: tdBlocks.filter(b => b.status === 'pending').length,
    lastBlock: lastBlock ? { id: lastBlock.id, prefix: lastBlock.prefix, ts: lastBlock.ts, status: lastBlock.status } : null,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Action: watch — start/stop/status the bridge-watcher daemon
// ---------------------------------------------------------------------------

const WATCHER_SCRIPT = path.join(__dirname, '..', 'bridge-watcher.cjs');

function actionWatchStart(bridgeFile, options) {
  const { ide = 'windsurf', notify = true, label } = options;

  // Already watching this file?
  if (WATCHER_PROCS.has(bridgeFile)) {
    const existing = WATCHER_PROCS.get(bridgeFile);
    return {
      ok: true,
      alreadyRunning: true,
      pid: existing.pid,
      ide: existing.ide,
      startedAt: existing.startedAt,
      bridgeFile,
      message: `Bridge watcher already running (pid ${existing.pid}) for ${bridgeFile}`,
    };
  }

  if (!fs.existsSync(WATCHER_SCRIPT)) {
    return { ok: false, error: `bridge-watcher.cjs not found at: ${WATCHER_SCRIPT}` };
  }

  const watcherArgs = [
    WATCHER_SCRIPT,
    '--bridge-file', bridgeFile,
    '--ide', ide,
    '--notify', String(notify),
  ];

  const proc = spawn(process.execPath, watcherArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const startedAt = new Date().toISOString();

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        logger.info('bridge-watcher IPC', msg);
      } catch (_) {
        logger.debug('bridge-watcher stdout', { line });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    logger.warn('bridge-watcher stderr', { data: data.toString().slice(0, 200) });
  });

  proc.on('exit', (code) => {
    logger.info('bridge-watcher exited', { bridgeFile, code });
    WATCHER_PROCS.delete(bridgeFile);
  });

  WATCHER_PROCS.set(bridgeFile, { proc, pid: proc.pid, ide, startedAt, label });

  logger.info('file.bridge watch started', { bridgeFile, pid: proc.pid, ide });

  return {
    ok: true,
    bridgeFile,
    pid: proc.pid,
    ide,
    startedAt,
    message: `Bridge watcher started (pid ${proc.pid}) — watching ${bridgeFile} for ${ide}`,
  };
}

function actionWatchStop(bridgeFile) {
  const entry = WATCHER_PROCS.get(bridgeFile);
  if (!entry) {
    return { ok: true, bridgeFile, message: 'No active watcher for this bridge file' };
  }
  try {
    entry.proc.kill('SIGTERM');
  } catch (_) {}
  WATCHER_PROCS.delete(bridgeFile);
  logger.info('file.bridge watch stopped', { bridgeFile, pid: entry.pid });
  return {
    ok: true,
    bridgeFile,
    pid: entry.pid,
    message: `Bridge watcher stopped (pid ${entry.pid})`,
  };
}

function actionWatchList() {
  const watchers = Array.from(WATCHER_PROCS.entries()).map(([file, entry]) => ({
    bridgeFile: file,
    pid: entry.pid,
    ide: entry.ide,
    startedAt: entry.startedAt,
    label: entry.label || null,
  }));
  return { ok: true, count: watchers.length, watchers };
}

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

async function fileBridge(args) {
  const {
    action = 'status',
    message,
    bridgeFile: bridgeFilePath,
    prefix,
    blockType,
    status,
    refId,
    filterPrefix,
    filterStatus,
    pollTimeoutMs,
    sinceTs,
    label,
    ide,
    notify,
    watchAction,
  } = args || {};

  const bridgeFile = resolveBridgeFile(bridgeFilePath);

  logger.info('file.bridge invoked', { action, bridgeFile });

  let result;

  switch (action) {
    case 'init':
      result = actionInit(bridgeFile, { label });
      break;

    case 'write':
      result = actionWrite(bridgeFile, { message, prefix, blockType, status, refId });
      break;

    case 'read':
      result = actionRead(bridgeFile, { filterPrefix, filterStatus, sinceTs });
      break;

    case 'poll':
      result = await actionPoll(bridgeFile, { filterPrefix, pollTimeoutMs, sinceTs });
      break;

    case 'clear':
      result = actionClear(bridgeFile, { filterPrefix });
      break;

    case 'status':
      result = actionStatus(bridgeFile);
      break;

    case 'watch':
      // watchAction: 'start' | 'stop' | 'list'
      if (watchAction === 'stop') {
        result = actionWatchStop(bridgeFile);
      } else if (watchAction === 'list') {
        result = actionWatchList();
      } else {
        // default: start
        result = actionWatchStart(bridgeFile, { ide, notify, label });
      }
      break;

    default:
      return {
        ok: false,
        action,
        error: `Unknown action: "${action}". Valid: init | write | read | poll | clear | status | watch`,
      };
  }

  logger.info('file.bridge completed', { action, ok: result.ok });

  return { ...result, action };
}

module.exports = { fileBridge };
