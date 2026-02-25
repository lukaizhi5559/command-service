'use strict';

/**
 * skill: file.watch
 *
 * Event-driven file watcher — like IDE file watching but with AI reaction.
 * Uses Node's built-in fs.watch (no deps) with debounce and diff detection.
 *
 * Use cases:
 *   - Watch a Windsurf/Cursor file change → post to Jira
 *   - Watch a log file → alert on error patterns
 *   - Watch build output → notify when done
 *   - Watch config file → re-run dependent task
 *
 * Actions:
 *   start    — start watching a file or directory, returns watchId
 *   stop     — stop a watcher by watchId
 *   list     — list all active watchers
 *   read     — read the current content of a watched file (with last-change info)
 *   poll     — check if a watched file has changed since last poll (non-blocking)
 *
 * Args schema:
 * {
 *   action:      string   — 'start' | 'stop' | 'list' | 'read' | 'poll'
 *   path:        string   — file or directory to watch (required for start/read/poll)
 *   watchId:     string   — watcher ID (required for stop/read/poll)
 *   label:       string   — human label for this watcher (optional)
 *   debounceMs:  number   — debounce window (default 500ms)
 *   recursive:   boolean  — watch directory recursively (default false)
 *   pattern:     string   — regex pattern to filter events (e.g. '\\.js$')
 *   pollTimeoutMs: number — for poll: max ms to wait for a change (default 0 = instant check)
 * }
 *
 * Returns:
 * {
 *   ok:       boolean
 *   action:   string
 *   watchId?: string
 *   watchers?: object[]
 *   changed?: boolean
 *   event?:   object  — { type, path, timestamp, content?, diff? }
 *   error?:   string
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// In-process watcher registry (survives across skill calls within same process)
// ---------------------------------------------------------------------------

// Map<watchId, WatcherState>
const WATCHERS = new Map();

// Max watchers to prevent runaway resource use
const MAX_WATCHERS = 20;
const MAX_FILE_SIZE_FOR_CONTENT = 500 * 1024; // 500KB
const DEFAULT_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePath(inputPath) {
  if (!inputPath) return null;
  return path.resolve(inputPath.replace(/^~/, os.homedir()));
}

function isPathSafe(resolvedPath) {
  const home = os.homedir();
  const safePrefixes = [home, '/tmp', '/var/tmp'];
  return safePrefixes.some(prefix => resolvedPath === prefix || resolvedPath.startsWith(prefix + path.sep));
}

function generateWatchId(filePath, label) {
  const base = label || path.basename(filePath);
  const hash = crypto.createHash('md5').update(filePath + Date.now()).digest('hex').slice(0, 6);
  return `watch_${base.replace(/[^a-z0-9]/gi, '_').slice(0, 20)}_${hash}`;
}

function hashContent(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function readFileContent(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_FOR_CONTENT) {
      return { ok: true, content: null, size: stat.size, truncated: true };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content, size: stat.size, truncated: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function simpleDiff(oldContent, newContent) {
  if (!oldContent || !newContent) return null;

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const added = [];
  const removed = [];
  const newSet = new Set(newLines);
  const oldSet = new Set(oldLines);

  for (const line of newLines) {
    if (!oldSet.has(line) && line.trim()) added.push(line);
  }
  for (const line of oldLines) {
    if (!newSet.has(line) && line.trim()) removed.push(line);
  }

  return {
    linesAdded: added.length,
    linesRemoved: removed.length,
    addedSample: added.slice(0, 5),
    removedSample: removed.slice(0, 5),
    totalLinesOld: oldLines.length,
    totalLinesNew: newLines.length,
  };
}

// ---------------------------------------------------------------------------
// Action: start — begin watching a file or directory
// ---------------------------------------------------------------------------

function actionStart(resolvedPath, options) {
  if (WATCHERS.size >= MAX_WATCHERS) {
    return {
      ok: false,
      error: `Max watcher limit (${MAX_WATCHERS}) reached. Stop an existing watcher first.`,
    };
  }

  const { label, debounceMs = DEFAULT_DEBOUNCE_MS, recursive = false, pattern } = options;

  // Check if already watching this path
  for (const [id, state] of WATCHERS) {
    if (state.path === resolvedPath) {
      return {
        ok: true,
        watchId: id,
        alreadyWatching: true,
        message: `Already watching: ${resolvedPath} (watchId: ${id})`,
        state: serializeWatcher(state),
      };
    }
  }

  const watchId = generateWatchId(resolvedPath, label);
  const patternRegex = pattern ? new RegExp(pattern) : null;

  // Read initial content/hash for change detection
  let initialContent = null;
  let initialHash = null;
  const stat = fs.statSync(resolvedPath);
  const isDir = stat.isDirectory();

  if (!isDir) {
    const readResult = readFileContent(resolvedPath);
    if (readResult.ok && readResult.content !== null) {
      initialContent = readResult.content;
      initialHash = hashContent(initialContent);
    }
  }

  const watcherState = {
    watchId,
    path: resolvedPath,
    label: label || path.basename(resolvedPath),
    isDirectory: isDir,
    recursive,
    debounceMs,
    pattern: pattern || null,
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    lastContent: initialContent,
    lastHash: initialHash,
    eventCount: 0,
    events: [], // ring buffer, last 20 events
    watcher: null,
  };

  let debounceTimer = null;

  const handleChange = (eventType, filename) => {
    const changedPath = filename ? path.join(isDir ? resolvedPath : path.dirname(resolvedPath), filename) : resolvedPath;

    // Apply pattern filter
    if (patternRegex && !patternRegex.test(changedPath)) return;

    // Debounce
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const now = new Date().toISOString();
      watcherState.lastEventAt = now;
      watcherState.eventCount++;

      let newContent = null;
      let newHash = null;
      let diff = null;

      if (!isDir) {
        const readResult = readFileContent(resolvedPath);
        if (readResult.ok && readResult.content !== null) {
          newContent = readResult.content;
          newHash = hashContent(newContent);

          // Skip if content unchanged (some editors trigger spurious events)
          if (newHash === watcherState.lastHash) return;

          diff = simpleDiff(watcherState.lastContent, newContent);
          watcherState.lastContent = newContent;
          watcherState.lastHash = newHash;
        }
      }

      const event = {
        type: eventType,
        path: changedPath,
        timestamp: now,
        diff,
        hasContent: newContent !== null,
      };

      // Keep last 20 events
      watcherState.events.push(event);
      if (watcherState.events.length > 20) watcherState.events.shift();

      logger.info('file.watch event', { watchId, eventType, path: changedPath });
    }, debounceMs);
  };

  try {
    const fsWatchOptions = { recursive: isDir && recursive, persistent: false };
    const watcher = fs.watch(resolvedPath, fsWatchOptions, handleChange);

    watcher.on('error', (err) => {
      logger.warn('file.watch watcher error', { watchId, error: err.message });
      watcherState.error = err.message;
    });

    watcherState.watcher = watcher;
    WATCHERS.set(watchId, watcherState);

    logger.info('file.watch started', { watchId, path: resolvedPath, isDir, recursive });

    return {
      ok: true,
      watchId,
      path: resolvedPath,
      label: watcherState.label,
      isDirectory: isDir,
      startedAt: watcherState.startedAt,
      message: `Now watching: ${resolvedPath}`,
    };
  } catch (err) {
    return { ok: false, error: `Failed to start watcher: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: stop — stop a watcher
// ---------------------------------------------------------------------------

function actionStop(watchId) {
  if (!watchId) {
    return { ok: false, error: 'watchId is required' };
  }

  const state = WATCHERS.get(watchId);
  if (!state) {
    return { ok: false, error: `Watcher not found: ${watchId}` };
  }

  try {
    if (state.watcher) state.watcher.close();
  } catch (_) {}

  WATCHERS.delete(watchId);

  logger.info('file.watch stopped', { watchId });

  return {
    ok: true,
    watchId,
    path: state.path,
    label: state.label,
    stoppedAt: new Date().toISOString(),
    totalEvents: state.eventCount,
    message: `Stopped watching: ${state.path}`,
  };
}

// ---------------------------------------------------------------------------
// Action: list — list all active watchers
// ---------------------------------------------------------------------------

function serializeWatcher(state) {
  return {
    watchId: state.watchId,
    path: state.path,
    label: state.label,
    isDirectory: state.isDirectory,
    recursive: state.recursive,
    startedAt: state.startedAt,
    lastEventAt: state.lastEventAt,
    eventCount: state.eventCount,
    recentEvents: state.events.slice(-5),
    error: state.error || null,
  };
}

function actionList() {
  const watchers = Array.from(WATCHERS.values()).map(serializeWatcher);
  return {
    ok: true,
    count: watchers.length,
    watchers,
  };
}

// ---------------------------------------------------------------------------
// Action: poll — check if file changed since last poll (non-blocking or with timeout)
// ---------------------------------------------------------------------------

async function actionPoll(watchId, options) {
  if (!watchId) {
    return { ok: false, error: 'watchId is required' };
  }

  const state = WATCHERS.get(watchId);
  if (!state) {
    return { ok: false, error: `Watcher not found: ${watchId}` };
  }

  const { pollTimeoutMs = 0 } = options;
  const startTime = Date.now();

  // Poll loop — wait up to pollTimeoutMs for a change event
  const checkForChange = () => {
    const lastEventTime = state.lastEventAt ? new Date(state.lastEventAt).getTime() : 0;
    return lastEventTime > startTime;
  };

  if (pollTimeoutMs > 0 && !checkForChange()) {
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (checkForChange() || Date.now() - startTime >= pollTimeoutMs) {
          clearInterval(interval);
          resolve();
        }
      }, 250);
    });
  }

  const changed = checkForChange();
  const recentEvent = state.events[state.events.length - 1] || null;

  return {
    ok: true,
    watchId,
    path: state.path,
    label: state.label,
    changed,
    lastEventAt: state.lastEventAt,
    totalEvents: state.eventCount,
    recentEvent,
    currentContent: changed && !state.isDirectory ? state.lastContent : undefined,
  };
}

// ---------------------------------------------------------------------------
// Action: read — read current content of watched file
// ---------------------------------------------------------------------------

function actionRead(watchId) {
  if (!watchId) {
    return { ok: false, error: 'watchId is required' };
  }

  const state = WATCHERS.get(watchId);
  if (!state) {
    return { ok: false, error: `Watcher not found: ${watchId}` };
  }

  if (state.isDirectory) {
    return { ok: false, error: 'Cannot read directory content — use fs.read tree instead' };
  }

  const readResult = readFileContent(state.path);
  if (!readResult.ok) {
    return { ok: false, error: readResult.error };
  }

  return {
    ok: true,
    watchId,
    path: state.path,
    label: state.label,
    content: readResult.content,
    size: readResult.size,
    truncated: readResult.truncated,
    lastEventAt: state.lastEventAt,
    eventCount: state.eventCount,
  };
}

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

async function fileWatch(args) {
  const {
    action = 'list',
    path: inputPath,
    watchId,
    label,
    debounceMs,
    recursive,
    pattern,
    pollTimeoutMs,
  } = args || {};

  logger.info('file.watch invoked', { action, path: inputPath, watchId });

  let resolvedPath = null;
  if (inputPath) {
    resolvedPath = resolvePath(inputPath);

    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, action, error: `Path does not exist: ${resolvedPath}` };
    }

    if (!isPathSafe(resolvedPath)) {
      return {
        ok: false,
        action,
        error: `Path is outside allowed roots (must be under home dir or /tmp): ${resolvedPath}`,
      };
    }
  }

  let result;

  switch (action) {
    case 'start':
      if (!resolvedPath) return { ok: false, action, error: 'path is required for start' };
      result = actionStart(resolvedPath, { label, debounceMs, recursive, pattern });
      break;

    case 'stop':
      result = actionStop(watchId);
      break;

    case 'list':
      result = actionList();
      break;

    case 'poll':
      result = await actionPoll(watchId, { pollTimeoutMs });
      break;

    case 'read':
      result = actionRead(watchId);
      break;

    default:
      return {
        ok: false,
        action,
        error: `Unknown action: "${action}". Valid: start | stop | list | poll | read`,
      };
  }

  logger.info('file.watch completed', { action, ok: result.ok });

  return { ...result, action };
}

module.exports = { fileWatch, WATCHERS };
