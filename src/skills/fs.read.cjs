'use strict';

/**
 * skill: fs.read
 *
 * Codebase explorer and file reader — like what Windsurf/Cursor do to understand a project.
 * Combines directory tree mapping, selective file reading, and pattern search into one skill.
 *
 * Actions:
 *   tree     — map directory structure (respects .gitignore patterns, depth limit)
 *   read     — read one or more files and return their content
 *   search   — search for patterns across files using ripgrep or grep fallback
 *   explore  — full codebase understanding: tree + read key files + search entry points
 *   tail     — read last N lines of a file (for logs, output files)
 *   stat     — get file/directory metadata (size, modified, type)
 *
 * Args schema:
 * {
 *   action:     string   — 'tree' | 'read' | 'search' | 'explore' | 'tail' | 'stat'
 *   path:       string   — target file or directory path (supports ~)
 *   paths:      string[] — multiple file paths (for 'read' action)
 *   pattern:    string   — search pattern (for 'search' action)
 *   maxDepth:   number   — max directory depth for tree (default 4)
 *   maxFileSize: number  — max file size in bytes to read (default 100KB)
 *   maxFiles:   number   — max files to read in explore (default 20)
 *   lines:      number   — number of lines for tail (default 50)
 *   extensions: string[] — file extensions to include in search (e.g. ['.js', '.ts'])
 *   exclude:    string[] — patterns to exclude (default: node_modules, .git, dist, build)
 *   encoding:   string   — file encoding (default 'utf8')
 * }
 *
 * Returns:
 * {
 *   ok:      boolean
 *   action:  string
 *   result:  object   — action-specific result
 *   error?:  string
 * }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const logger = require('../logger.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_FILE_SIZE = 100 * 1024; // 100KB
const DEFAULT_MAX_FILES = 20;
const DEFAULT_TAIL_LINES = 50;
const MAX_OUTPUT_CHARS = 500 * 1024; // 500KB total output cap

const DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  '.DS_Store',
  '*.lock',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.turbo',
  'out',
  '.cache',
];

// Files to prioritize when doing explore — these explain a project best
const KEY_FILES_PRIORITY = [
  'README.md',
  'README.txt',
  'README',
  'package.json',
  'pyproject.toml',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'pom.xml',
  'build.gradle',
  '.env.example',
  'docker-compose.yml',
  'Dockerfile',
  'Makefile',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'CONTRIBUTING.md',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'rollup.config.js',
  'next.config.js',
  'nuxt.config.ts',
  'tailwind.config.js',
];

// Common entry points to read for code understanding
const ENTRY_POINT_PATTERNS = [
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'src/main.js',
  'src/app.ts',
  'src/app.js',
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'app.ts',
  'app.js',
  'server.ts',
  'server.js',
  'src/main/main.js',
  'src/main/index.js',
  'src/renderer/App.tsx',
  'src/renderer/App.jsx',
  'src/renderer/index.tsx',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Common project root candidates to search when a relative path is given
const PROJECT_ROOT_CANDIDATES = [
  // Try environment-provided project root first
  process.env.THINKDROP_PROJECT_ROOT,
  // Common Desktop project layouts on macOS
  path.join(os.homedir(), 'Desktop', 'projects'),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'projects'),
  path.join(os.homedir(), 'code'),
  path.join(os.homedir(), 'dev'),
  path.join(os.homedir(), 'workspace'),
].filter(Boolean);

function resolvePath(inputPath) {
  if (!inputPath) return null;

  // Expand ~ to home dir
  const expanded = inputPath.replace(/^~/, os.homedir());

  // Already absolute — return as-is
  if (path.isAbsolute(expanded)) return expanded;

  // Relative path — try to find it under common project roots
  // Walk one level of subdirectories under each candidate root
  for (const root of PROJECT_ROOT_CANDIDATES) {
    // Direct child: ~/Desktop/projects/src/renderer/components
    const direct = path.join(root, expanded);
    if (fs.existsSync(direct)) return direct;

    // One level of project subdirs: ~/Desktop/projects/myapp/src/renderer/components
    try {
      const subdirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      for (const sub of subdirs) {
        const candidate = path.join(root, sub, expanded);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_) {}
  }

  // Fallback: resolve relative to cwd
  return path.resolve(expanded);
}

function isPathSafe(resolvedPath) {
  const home = os.homedir();
  const safePrefixes = [home, '/tmp', '/var/tmp'];
  return safePrefixes.some(prefix => resolvedPath === prefix || resolvedPath.startsWith(prefix + path.sep));
}

function shouldExclude(name, excludePatterns) {
  return excludePatterns.some(pattern => {
    if (pattern.includes('*')) {
      // Simple glob: *.lock matches yarn.lock
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(name);
    }
    return name === pattern;
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// Action: tree — directory structure map
// ---------------------------------------------------------------------------

function buildTree(dirPath, options, depth = 0, prefix = '') {
  const { maxDepth, exclude } = options;
  const lines = [];

  if (depth > maxDepth) {
    lines.push(`${prefix}... (max depth ${maxDepth} reached)`);
    return lines;
  }

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    lines.push(`${prefix}[error reading dir: ${err.message}]`);
    return lines;
  }

  // Filter and sort: dirs first, then files, both alphabetical
  const filtered = entries.filter(e => !shouldExclude(e.name, exclude));
  const dirs = filtered.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const files = filtered.filter(e => !e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...dirs, ...files];

  sorted.forEach((entry, idx) => {
    const isLast = idx === sorted.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${entry.name}/`);
      const subLines = buildTree(
        path.join(dirPath, entry.name),
        options,
        depth + 1,
        childPrefix
      );
      lines.push(...subLines);
    } else {
      let size = '';
      try {
        const stat = fs.statSync(path.join(dirPath, entry.name));
        size = ` (${formatBytes(stat.size)})`;
      } catch (_) {}
      lines.push(`${prefix}${connector}${entry.name}${size}`);
    }
  });

  return lines;
}

function actionTree(resolvedPath, options) {
  const stat = fs.statSync(resolvedPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `Path is not a directory: ${resolvedPath}` };
  }

  const exclude = [...DEFAULT_EXCLUDES, ...(options.exclude || [])];
  const maxDepth = options.maxDepth || DEFAULT_MAX_DEPTH;

  const treeLines = buildTree(resolvedPath, { maxDepth, exclude });
  const treeStr = resolvedPath + '/\n' + treeLines.join('\n');

  return {
    ok: true,
    path: resolvedPath,
    tree: treeStr,
    lineCount: treeLines.length,
  };
}

// ---------------------------------------------------------------------------
// Action: read — read one or more files
// ---------------------------------------------------------------------------

function readSingleFile(filePath, options) {
  const { maxFileSize = DEFAULT_MAX_FILE_SIZE, encoding = 'utf8' } = options;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { path: filePath, ok: false, error: err.message };
  }

  if (stat.isDirectory()) {
    return { path: filePath, ok: false, error: 'Path is a directory, not a file' };
  }

  if (stat.size > maxFileSize) {
    return {
      path: filePath,
      ok: false,
      error: `File too large: ${formatBytes(stat.size)} (limit ${formatBytes(maxFileSize)}) — use tail to read last N lines`,
      size: stat.size,
    };
  }

  try {
    const content = fs.readFileSync(filePath, encoding);
    return {
      path: filePath,
      ok: true,
      content,
      size: stat.size,
      lines: content.split('\n').length,
      modified: stat.mtime.toISOString(),
    };
  } catch (err) {
    return { path: filePath, ok: false, error: err.message };
  }
}

function actionRead(args) {
  const { maxFileSize, encoding } = args;
  const options = { maxFileSize, encoding };

  // Multiple files
  if (args.paths && Array.isArray(args.paths)) {
    const results = args.paths.map(p => readSingleFile(resolvePath(p), options));
    const allOk = results.every(r => r.ok);
    return {
      ok: allOk,
      files: results,
      totalFiles: results.length,
      successCount: results.filter(r => r.ok).length,
    };
  }

  // Single file
  const resolvedPath = resolvePath(args.path);
  const result = readSingleFile(resolvedPath, options);
  return {
    ok: result.ok,
    files: [result],
    totalFiles: 1,
    successCount: result.ok ? 1 : 0,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Action: search — ripgrep or grep fallback
// ---------------------------------------------------------------------------

function actionSearch(resolvedPath, options) {
  const { pattern, extensions, exclude } = options;

  if (!pattern) {
    return { ok: false, error: 'pattern is required for search action' };
  }

  const excludeList = [...DEFAULT_EXCLUDES, ...(exclude || [])];

  // Try ripgrep first (faster, respects .gitignore)
  const rgPath = (() => {
    try { return execFileSync('which', ['rg'], { encoding: 'utf8' }).trim(); } catch (_) { return null; }
  })();

  if (rgPath) {
    const argv = ['-n', '--no-heading', '--color=never', '--max-count=5'];
    excludeList.forEach(ex => argv.push('--glob', `!${ex}`));
    if (extensions && extensions.length > 0) {
      extensions.forEach(ext => argv.push('--glob', `*${ext}`));
    }
    argv.push(pattern, resolvedPath);

    const result = spawnSync('rg', argv, { encoding: 'utf8', timeout: 30000 });
    const output = (result.stdout || '').slice(0, MAX_OUTPUT_CHARS);
    const matches = output.split('\n').filter(Boolean);

    return {
      ok: true,
      tool: 'ripgrep',
      pattern,
      path: resolvedPath,
      matches,
      matchCount: matches.length,
      output,
    };
  }

  // Fallback to grep
  const argv = ['-rn', '--include=*.*', '--color=never', '-m', '5'];
  if (extensions && extensions.length > 0) {
    // grep doesn't support multiple --include easily, use first
    argv.splice(argv.indexOf('--include=*.*'), 1, `--include=*${extensions[0]}`);
  }
  excludeList.forEach(ex => {
    if (!ex.includes('*')) argv.push('--exclude-dir', ex);
  });
  argv.push(pattern, resolvedPath);

  const result = spawnSync('grep', argv, { encoding: 'utf8', timeout: 30000 });
  const output = (result.stdout || '').slice(0, MAX_OUTPUT_CHARS);
  const matches = output.split('\n').filter(Boolean);

  return {
    ok: true,
    tool: 'grep',
    pattern,
    path: resolvedPath,
    matches,
    matchCount: matches.length,
    output,
  };
}

// ---------------------------------------------------------------------------
// Action: explore — full codebase understanding
// ---------------------------------------------------------------------------

function actionExplore(resolvedPath, options) {
  const { maxFiles = DEFAULT_MAX_FILES, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxDepth = DEFAULT_MAX_DEPTH, exclude } = options;
  const excludeList = [...DEFAULT_EXCLUDES, ...(exclude || [])];

  // Step 1: Build tree
  const treeResult = actionTree(resolvedPath, { maxDepth, exclude: excludeList });
  if (!treeResult.ok) return treeResult;

  const summary = {
    ok: true,
    path: resolvedPath,
    tree: treeResult.tree,
    keyFiles: [],
    entryPoints: [],
    totalFilesRead: 0,
  };

  const readOptions = { maxFileSize, encoding: 'utf8' };
  let filesRead = 0;

  // Step 2: Read key files (README, package.json, etc.)
  for (const keyFile of KEY_FILES_PRIORITY) {
    if (filesRead >= maxFiles) break;
    const candidate = path.join(resolvedPath, keyFile);
    if (fs.existsSync(candidate)) {
      const result = readSingleFile(candidate, readOptions);
      if (result.ok) {
        summary.keyFiles.push({
          name: keyFile,
          path: candidate,
          content: result.content,
          lines: result.lines,
          size: result.size,
        });
        filesRead++;
      }
    }
  }

  // Step 3: Read common entry points
  for (const entryPattern of ENTRY_POINT_PATTERNS) {
    if (filesRead >= maxFiles) break;
    const candidate = path.join(resolvedPath, entryPattern);
    if (fs.existsSync(candidate)) {
      // Don't double-read if already in keyFiles
      const alreadyRead = summary.keyFiles.some(f => f.path === candidate);
      if (!alreadyRead) {
        const result = readSingleFile(candidate, readOptions);
        if (result.ok) {
          summary.entryPoints.push({
            name: entryPattern,
            path: candidate,
            content: result.content,
            lines: result.lines,
            size: result.size,
          });
          filesRead++;
        }
      }
    }
  }

  summary.totalFilesRead = filesRead;
  return summary;
}

// ---------------------------------------------------------------------------
// Action: tail — last N lines of a file
// ---------------------------------------------------------------------------

function actionTail(resolvedPath, options) {
  const { lines = DEFAULT_TAIL_LINES } = options;

  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (stat.isDirectory()) {
    return { ok: false, error: 'Path is a directory, not a file' };
  }

  // Use tail command for efficiency on large files
  const result = spawnSync('tail', ['-n', String(lines), resolvedPath], {
    encoding: 'utf8',
    timeout: 10000,
  });

  if (result.error) {
    // Fallback: read whole file and slice
    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const allLines = content.split('\n');
      const tailLines = allLines.slice(-lines);
      return {
        ok: true,
        path: resolvedPath,
        lines: tailLines.length,
        requestedLines: lines,
        content: tailLines.join('\n'),
        totalLines: allLines.length,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  const content = result.stdout || '';
  return {
    ok: true,
    path: resolvedPath,
    lines: content.split('\n').filter(Boolean).length,
    requestedLines: lines,
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Action: stat — file/directory metadata
// ---------------------------------------------------------------------------

function actionStat(resolvedPath) {
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const result = {
    ok: true,
    path: resolvedPath,
    type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
    size: stat.size,
    sizeFormatted: formatBytes(stat.size),
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString(),
    accessed: stat.atime.toISOString(),
    mode: stat.mode.toString(8),
  };

  if (stat.isDirectory()) {
    try {
      const entries = fs.readdirSync(resolvedPath);
      result.entries = entries.length;
    } catch (_) {}
  }

  return result;
}

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

async function fsRead(args) {
  const {
    action = 'explore',
    path: inputPath,
    paths,
    pattern,
    maxDepth,
    maxFileSize,
    maxFiles,
    lines,
    extensions,
    exclude,
    encoding,
  } = args || {};

  logger.info('fs.read invoked', { action, path: inputPath });

  // Resolve and validate path
  const targetPath = inputPath ? resolvePath(inputPath) : null;

  if (action !== 'read' || !paths) {
    // Most actions need a single path
    if (!targetPath) {
      return { ok: false, action, error: 'path is required' };
    }

    if (!fs.existsSync(targetPath)) {
      return { ok: false, action, error: `Path does not exist: ${targetPath}` };
    }

    if (!isPathSafe(targetPath)) {
      return { ok: false, action, error: `Path is outside allowed roots (must be under home dir or /tmp): ${targetPath}` };
    }
  }

  let result;

  switch (action) {
    case 'tree':
      result = actionTree(targetPath, { maxDepth, exclude });
      break;

    case 'read':
      result = actionRead({ path: inputPath, paths, maxFileSize, encoding });
      break;

    case 'search':
      result = actionSearch(targetPath, { pattern, extensions, exclude });
      break;

    case 'explore':
      result = actionExplore(targetPath, { maxFiles, maxFileSize, maxDepth, exclude });
      break;

    case 'tail':
      result = actionTail(targetPath, { lines });
      break;

    case 'stat':
      result = actionStat(targetPath);
      break;

    default:
      return { ok: false, action, error: `Unknown action: "${action}". Valid: tree | read | search | explore | tail | stat` };
  }

  logger.info('fs.read completed', { action, ok: result.ok });

  return { ...result, action };
}

module.exports = { fsRead };
