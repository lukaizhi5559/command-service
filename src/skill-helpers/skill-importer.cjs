'use strict';

/**
 * skill-importer.cjs
 *
 * Imports external "agent skill" packs (SKILL.md instruction packs in the
 * vercel-labs `skills` ecosystem format) into ThinkDrop.
 *
 * Two-phase flow:
 *   inspectSkill({ url }) → preview { skillMd, files, risks, requiredBins,
 *                                      requiredSecrets, installCmds, ... }
 *   installSkill(preview, opts) → writes ~/.thinkdrop/skills/<dotname>/skill.md
 *                                  (+ sibling files), creates a cli.agent
 *                                  descriptor per declared binary, registers
 *                                  the skill with user-memory.
 *
 * Source forms accepted by inspectSkill:
 *   - Raw markdown URL (…/SKILL.md, raw.githubusercontent.com/…)
 *   - github.com/<owner>/<repo>(/tree/<branch>/<subdir>)?
 *   - <owner>/<repo> shorthand (GitHub)
 *   - Directory/catalog pages (mcpservers.org, skillsmp.com, …) — resolves the
 *     first github.com/<o>/<r> link found on the page.
 *   - `… --skill <name>` suffix selects a named skill inside a multi-skill repo.
 *
 * When the pack declares required binaries, installSkill creates a CLI agent
 * whose descriptor is built FROM THE SKILL.md's documented commands (no
 * --help crawl — run_help self-heals at runtime). Missing bins produce agents
 * with status 'not_installed'; install commands are surfaced to the UI and
 * only run when the user clicks Install.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');
const logger = require('../logger.cjs');

const { withDb, AGENTS_DIR } = require('@thinkdrop/agents-db');

const SKILLS_BASE = path.join(os.homedir(), '.thinkdrop', 'skills');
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
const MAX_RESPONSE = 8 * 1024 * 1024;   // 8 MB — tarballs can exceed the 5 MB md limit
const MAX_FILE_TEXT = 512 * 1024;       // vet text files up to 512 KB
const TIMEOUT_MS = 20000;
const TEXT_EXT_RE = /\.(md|txt|markdown|json|ya?ml|toml|sh|bash|zsh|py|js|ts|cjs|mjs|env|example)$/i;

const MEM_PORT = parseInt(process.env.MEMORY_SERVICE_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.USER_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

// ── Fetching ────────────────────────────────────────────────────────────────

function fetchUrl(url, { redirectsLeft = 5, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'ThinkDrop-SkillImporter/1.0', 'Accept': '*/*' },
      timeout: TIMEOUT_MS,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        resolve(fetchUrl(next, { redirectsLeft: redirectsLeft - 1, binary }));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE) { tooLarge = true; res.destroy(); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (tooLarge) return reject(new Error('Response exceeded 8MB limit'));
        const buf = Buffer.concat(chunks);
        resolve(binary ? buf : buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out fetching ${url}`)); });
  });
}

function extractTarball(buf) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-skill-'));
  const tgz = path.join(tmpDir, 'repo.tar.gz');
  fs.writeFileSync(tgz, buf);
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', tmpDir], { timeout: 30000 });
  } catch (e) {
    throw new Error(`Could not extract repository archive: ${e.message}`);
  }
  // GitHub tarballs extract into <owner>-<repo>-<sha>/
  const top = fs.readdirSync(tmpDir).filter(d =>
    d !== 'repo.tar.gz' && fs.statSync(path.join(tmpDir, d)).isDirectory());
  return top.length ? path.join(tmpDir, top[0]) : tmpDir;
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walkFiles(full, base, out);
    } else {
      out.push({ abs: full, rel: path.relative(base, full), size: entry.size || fs.statSync(full).size });
    }
  }
  return out;
}

// ── Source resolution ───────────────────────────────────────────────────────

function parseGithubSpec(input) {
  // Returns { owner, repo, subdir, skillName } or null
  let s = String(input || '').trim();
  let skillName = null;
  const skillArg = s.match(/\s+--skill[=\s]+([\w.-]+)\s*$/i);
  if (skillArg) { skillName = skillArg[1]; s = s.slice(0, skillArg.index).trim(); }
  s = s.replace(/\.git\/?$/, '').replace(/\/+$/, '');

  const ghMatch = s.match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w.-]+)\/(.+))?/i);
  if (ghMatch) {
    return { owner: ghMatch[1], repo: ghMatch[2], subdir: ghMatch[4] || null, skillName };
  }
  const shortMatch = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], subdir: null, skillName };
  return null;
}

async function resolveSource(url) {
  // → { kind:'pack', root, files } | { kind:'raw', skillMd }
  const spec = parseGithubSpec(url);
  if (spec) {
    const buf = await fetchUrl(`https://api.github.com/repos/${spec.owner}/${spec.repo}/tarball`, { binary: true });
    const root = extractTarball(buf);
    let files = walkFiles(root);
    // Narrow to a subdirectory / named skill when requested
    if (spec.subdir) {
      const sub = spec.subdir.replace(/\/+$/, '') + '/';
      files = files.filter(f => f.rel === spec.subdir || f.rel.startsWith(sub));
    } else if (spec.skillName) {
      const needle = spec.skillName.toLowerCase();
      const matches = files.filter(f =>
        /skill\.md$/i.test(f.rel) && f.rel.toLowerCase().includes(needle));
      if (matches.length) {
        const dir = path.dirname(matches[0].rel);
        files = files.filter(f => f.rel === dir || f.rel.startsWith(dir + '/'));
      }
    }
    return { kind: 'pack', root, files, spec };
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Invalid source — must be a URL, github.com link, or owner/repo');
  }
  if (/\.(md|markdown|txt)$/i.test(url) || url.includes('raw.githubusercontent.com')) {
    return { kind: 'raw', skillMd: await fetchUrl(url) };
  }

  // Directory/catalog page — resolve the GitHub repo it points to
  const html = await fetchUrl(url);
  const ghLink = html.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (ghLink) return resolveSource(`https://github.com/${ghLink[1]}/${ghLink[2]}`);

  // Maybe the page embeds the SKILL.md itself (mcpservers.org renders it)
  const mdBlock = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (mdBlock) {
    const text = mdBlock[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
    if (text.includes('---') && /(^|\n)name:/.test(text)) {
      return { kind: 'raw', skillMd: text };
    }
  }
  throw new Error('Could not find a SKILL.md or GitHub repository at that URL');
}

// ── Frontmatter + requirements parsing ──────────────────────────────────────

function parseFrontmatter(content) {
  const m = String(content).match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return { fm: {}, body: String(content) };
  const fm = {};
  const body = String(content).slice(m[0].length).trim();

  // Minimal indentation-aware YAML subset parser (maps + string lists).
  const stack = [{ indent: -1, obj: fm }];
  let pendingKey = null; // key awaiting a list or nested map
  for (const rawLine of m[1].split('\n')) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    const listItem = line.match(/^-\s+(.+)$/);
    if (listItem) {
      if (pendingKey != null && Array.isArray(parent[pendingKey])) {
        parent[pendingKey].push(listItem[1].trim().replace(/^['"]|['"]$/g, ''));
      } else if (pendingKey != null) {
        parent[pendingKey] = [listItem[1].trim().replace(/^['"]|['"]$/g, '')];
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '');
    // Inline YAML list: key: [a, b]
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    if (value === '') {
      // Nested map or list — push map now; `- ` items convert it later via pendingKey
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
      pendingKey = key;
      // mark parent for list conversion
      parent[key].__list__ = true;
    } else {
      parent[key] = value;
      pendingKey = null;
    }
  }
  // Convert __list__ marker maps that stayed empty into real lists when needed
  const clean = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') {
        if (v.__list__ && Object.keys(v).length === 1) o[k] = [];
        else { delete v.__list__; clean(v); }
      }
    }
  };
  clean(fm);
  return { fm, body };
}

function collectBins(fm, body) {
  const bins = new Set();
  const walkReq = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'bins' || k === 'bin' || k === 'commands') {
        (Array.isArray(v) ? v : [v]).forEach(b => typeof b === 'string' && bins.add(b));
      } else if (typeof v === 'object') walkReq(v);
    }
  };
  walkReq(fm.metadata); walkReq(fm.requires); walkReq(fm.requirements);
  for (const m of body.matchAll(/command -v\s+([\w.-]+)/g)) bins.add(m[1]);
  for (const m of body.matchAll(/npm\s+(?:i|install)\s+-g\s+([\w@./-]+)/g)) {
    const pkg = m[1].split('@')[0] || m[1];
    bins.add(pkg);
  }
  for (const m of body.matchAll(/brew\s+install\s+([\w@./-]+)/g)) bins.add(m[1]);
  return [...bins];
}

function collectInstallCmds(fm, body) {
  const cmds = new Set();
  const walkInstall = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'install' || k === 'installer') {
        if (typeof v === 'string') cmds.add(v);
        else for (const vv of Object.values(v)) typeof vv === 'string' && cmds.add(vv);
      } else if (typeof v === 'object') walkInstall(v);
    }
  };
  walkInstall(fm.metadata); walkInstall(fm);
  for (const m of body.matchAll(/npm\s+(?:i|install)\s+-g\s+([\w@./-]+)/g)) cmds.add(`npm install -g ${m[1]}`);
  for (const m of body.matchAll(/brew\s+install\s+([\w@./-]+)/g)) cmds.add(`brew install ${m[1]}`);
  // Keep only real install commands
  return [...cmds].filter(c => /\b(npm|pnpm|yarn|brew|pip3?|cargo|go install|curl|uv)\b/.test(c));
}

function collectSecrets(fm, body) {
  const secrets = new Set();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (['secrets', 'env', 'env_vars', 'credentials'].includes(k)) {
        (Array.isArray(v) ? v : [v]).forEach(s => typeof s === 'string' && secrets.add(s));
      } else if (typeof v === 'object') walk(v);
    }
  };
  walk(fm);
  // Env vars that look like credentials — must end in a credential suffix.
  for (const m of body.matchAll(/\b[A-Z][A-Z0-9_]{2,}?(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY|_ACCESS_TOKEN|_API_SECRET)\b/g)) {
    secrets.add(m[0]);
  }
  return [...secrets];
}

function collectValidateCmds(body, bins) {
  const cmds = [];
  for (const m of body.matchAll(/`?((?:[\w.-]+\s+)?(?:validate|verify|credits|whoami|status|version|auth\s+status|auth\s+check)[^\n`]*?)`?\s*$/gm)) {
    const c = m[1].trim();
    if (c && c.length < 120 && bins.some(b => c.startsWith(b))) cmds.push(c);
  }
  return [...new Set(cmds)].slice(0, 5);
}

// ── Vetting ─────────────────────────────────────────────────────────────────

const RISK_PATTERNS = [
  { re: /curl[^|\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/i, label: 'Pipes remote content into a shell (curl | sh)' },
  { re: /wget[^|\n]*\|\s*(?:sudo\s+)?(?:ba)?sh/i, label: 'Pipes remote content into a shell (wget | sh)' },
  { re: /\brm\s+-[rf]{1,2}\b/i, label: 'Recursive file deletion (rm -rf)' },
  { re: /\bsudo\b/i, label: 'Requests elevated privileges (sudo)' },
  { re: /~?\/\.ssh\//i, label: 'Reads SSH keys (~/.ssh)' },
  { re: /\bsecurity\s+find-(?:generic|internet)-password|\bkeychain\b/i, label: 'Touches macOS Keychain' },
  { re: /\beval\s*\(/i, label: 'Uses eval()' },
  { re: /base64\s+(?:-d|--decode)|Buffer\.from\([^)]*['"]base64/i, label: 'Decodes base64 payloads (possible obfuscation)' },
  { re: /osascript|tell\s+application/i, label: 'Controls other apps via AppleScript' },
  { re: /LaunchAgents|launchctl\s+(?:load|bootstrap)/i, label: 'Installs background launch agents' },
];

function vetFiles(files) {
  const risks = [];
  const seen = new Set();
  for (const f of files) {
    if (!TEXT_EXT_RE.test(f.rel) || f.size > MAX_FILE_TEXT) continue;
    let text;
    try { text = fs.readFileSync(f.abs, 'utf8'); } catch (_) { continue; }
    for (const { re, label } of RISK_PATTERNS) {
      if (re.test(text) && !seen.has(label)) { seen.add(label); risks.push({ file: f.rel, label }); }
    }
  }
  return risks;
}

// ── Name normalization (mirrors main.js installer rules) ─────────────────────

function normalizeDotName(raw, sourceUrl) {
  let name = String(raw || '').toLowerCase()
    .replace(/\.agent$/, '')
    .replace(/[^a-z0-9.]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .split('.')
    .filter(seg => seg.length > 0 && !/^\d/.test(seg))
    .join('.');
  if (!name) {
    try { name = new URL(sourceUrl).hostname.split('.')[0]; } catch (_) { name = 'imported'; }
  }
  if (!name.includes('.')) name = `${name}.skill`;
  return SKILL_NAME_RE.test(name) ? name : null;
}

// ── Phase 1: inspect ─────────────────────────────────────────────────────────

async function inspectSkill({ url }) {
  const resolved = await resolveSource(url);

  let skillMd, files = [], fileList = [];
  if (resolved.kind === 'raw') {
    skillMd = resolved.skillMd;
    fileList = [{ rel: 'SKILL.md', size: Buffer.byteLength(skillMd) }];
  } else {
    const skillFiles = resolved.files.filter(f => /(^|\/)skill\.md$/i.test(f.rel));
    if (!skillFiles.length) throw new Error('No SKILL.md found in that repository/path');
    const picked = skillFiles.sort((a, b) => a.rel.length - b.rel.length)[0];
    const dirPrefix = path.dirname(picked.rel);
    files = resolved.files.filter(f =>
      f.rel === picked.rel || f.rel.startsWith(dirPrefix === '.' ? '' : dirPrefix + '/'));
    skillMd = fs.readFileSync(picked.abs, 'utf8');
    fileList = files.map(f => ({ rel: f.rel, abs: f.abs, size: f.size }));
  }

  const { fm, body } = parseFrontmatter(skillMd);
  const requiredBins = collectBins(fm, body);
  const installCmds = collectInstallCmds(fm, body);
  const requiredSecrets = collectSecrets(fm, body);
  const validateCmds = collectValidateCmds(body, requiredBins);
  const risks = resolved.kind === 'pack'
    ? vetFiles(files)
    : RISK_PATTERNS.filter(({ re }) => re.test(skillMd)).map(({ label }) => ({ file: 'SKILL.md', label }));

  const binProbes = requiredBins.map(bin => ({ bin, installed: !!probeBin(bin) }));

  const hasExecutableFiles = files.some(f => TEXT_EXT_RE.test(f.rel) && /\.(sh|py|js|cjs|mjs|ts)$/i.test(f.rel));
  const nameGuess = fm.name || '';

  return {
    ok: true,
    preview: {
      sourceUrl: url,
      suggestedName: normalizeDotName(nameGuess, url) || nameGuess,
      name: fm.name || '',
      description: fm.description || '',
      license: fm.license || '',
      compatibility: typeof fm.compatibility === 'string' ? fm.compatibility : '',
      allowedTools: Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'] : (fm['allowed-tools'] ? [fm['allowed-tools']] : []),
      skillMd,
      bodyPreview: body.slice(0, 4000),
      files: fileList,
      requiredBins,
      binProbes,
      installCmds,
      requiredSecrets,
      validateCmds,
      risks,
      hasExecutableFiles,
      needsCliAgent: requiredBins.length > 0,
    },
  };
}

// ── Phase 2: install ─────────────────────────────────────────────────────────

function _registerCliInAllowlist(cliName) {
  try {
    const allowPath = path.join(os.homedir(), '.thinkdrop', 'allowed-commands.json');
    fs.mkdirSync(path.dirname(allowPath), { recursive: true });
    let existing = [];
    if (fs.existsSync(allowPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
        existing = Array.isArray(raw) ? raw : (Array.isArray(raw?.commands) ? raw.commands : []);
      } catch (_) {}
    }
    const normalized = [...new Set([...existing, path.basename(cliName)])].sort();
    fs.writeFileSync(allowPath, JSON.stringify({ commands: normalized }, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[skill-importer] allowlist write failed for ${cliName}: ${err.message}`);
  }
}

function probeBin(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { timeout: 5000 });
  return r.status === 0 ? (r.stdout || '').toString().trim().split('\n')[0] : null;
}

function _installHints(preview, bin) {
  // Derive { method, pkg } from the pack's declared install commands.
  for (const cmd of preview.installCmds || []) {
    let m = cmd.match(/npm\s+(?:i|install)\s+-g\s+(\S+)/);
    if (m) return { method: 'npm', pkg: m[1].replace(/@latest$/, '') };
    m = cmd.match(/brew\s+install\s+(\S+)/);
    if (m) return { method: 'brew', pkg: m[1] };
    m = cmd.match(/pip3?\s+install\s+(\S+)/);
    if (m) return { method: 'pip', pkg: m[1] };
  }
  return { method: null, pkg: bin };
}

function buildPackDescriptor({ agentId, serviceKey, bin, preview, installed }) {
  const secretsYaml = preview.requiredSecrets.length
    ? `secrets:\n${preview.requiredSecrets.map(s => `  - ${s}`).join('\n')}\n`
    : '';
  const hint = _installHints(preview, bin);
  const { body } = parseFrontmatter(preview.skillMd);
  return [
    '---',
    `id: ${agentId}`,
    'type: cli',
    `service: ${serviceKey}`,
    `cli_tool: ${bin}`,
    hint.method ? `install_method: ${hint.method}` : '',
    hint.pkg ? `install_pkg: ${hint.pkg}` : '',
    'capabilities:',
    `  - run`,
    `version: unknown`,
    `installed: ${!!installed}`,
    `source_url: ${preview.sourceUrl}`,
    secretsYaml ? secretsYaml.trimEnd() : '',
    '---',
    '',
    '## Instructions',
    `Use \`${bin}\` CLI for all ${preview.name || serviceKey} operations.`,
    preview.requiredSecrets.length
      ? `Credentials: set ${preview.requiredSecrets.join(' / ')} (stored via agent credentials — never echo values).`
      : '',
    'Always use `run_help` to check flag syntax before running unfamiliar commands.',
    '',
    '## Skill Pack Documentation (authoritative)',
    body.slice(0, 12000),
  ].filter(l => l !== '').join('\n');
}

async function createCliAgentForBin({ bin, preview }) {
  const serviceKey = bin.toLowerCase().replace(/[^a-z0-9]/g, '') || 'external';
  const agentId = `${serviceKey}.agent`;
  const binPath = probeBin(bin);
  const descriptor = buildPackDescriptor({ agentId, serviceKey, bin, preview, installed: !!binPath });

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const mdPath = path.join(AGENTS_DIR, `${agentId}.md`);
  fs.writeFileSync(mdPath, descriptor, 'utf8');
  if (binPath) _registerCliInAllowlist(bin);

  await withDb(async (db) => {
    await db.run(
      `INSERT OR REPLACE INTO agents
         (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at)
       VALUES (?, 'cli', ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
      agentId, serviceKey, bin, JSON.stringify(['run']), descriptor,
      binPath ? 'needs_validation' : 'not_installed'
    );
  });
  logger.info(`[skill-importer] created CLI agent ${agentId} (bin=${bin}, installed=${!!binPath})`);
  return { agentId, bin, installed: !!binPath, binPath, mdPath };
}

function installSkillFiles(preview, { nameOverride, descriptionOverride } = {}) {
  const { fm, body } = parseFrontmatter(preview.skillMd);
  const skillName = normalizeDotName(nameOverride || fm.name || preview.name, preview.sourceUrl);
  if (!skillName) return { ok: false, error: `Could not derive a valid dot-notation skill name (got "${nameOverride || fm.name}"). Use nameOverride.` };

  const underscore = skillName.replace(/\./g, '_');
  let dirName = underscore, suffix = 2;
  while (fs.existsSync(path.join(SKILLS_BASE, dirName))) dirName = `${underscore}_${suffix++}`;
  const skillDir = path.join(SKILLS_BASE, dirName);
  fs.mkdirSync(skillDir, { recursive: true });

  const description = descriptionOverride || fm.description || preview.description || skillName.replace(/\./g, ' ');
  const contractMd = [
    '---',
    `name: ${skillName}`,
    `description: ${description}`,
    `exec_path: ~/.thinkdrop/skills/${dirName}/skill.md`,
    'exec_type: instruction',
    `version: ${fm.version || '1.0.0'}`,
    `source: skill-pack`,
    `source_url: ${preview.sourceUrl}`,
    ...(preview.requiredBins.length ? [`agents: ${preview.requiredBins.map(b => `${b.toLowerCase().replace(/[^a-z0-9]/g, '')}.agent`).join(', ')}`] : []),
    ...(preview.requiredSecrets.length ? [`secrets: ${preview.requiredSecrets.join(', ')}`] : []),
    `installed_at: ${new Date().toISOString()}`,
    '---',
    '',
    body,
  ].join('\n');
  fs.writeFileSync(path.join(skillDir, 'skill.md'), contractMd, 'utf8');

  // Copy sibling files from the pack (skip the SKILL.md itself — normalized above)
  const copied = [];
  for (const f of preview.files || []) {
    if (!f.abs || /skill\.md$/i.test(f.rel)) continue;
    const dest = path.join(skillDir, path.basename(f.rel));
    try { fs.copyFileSync(f.abs, dest); copied.push(path.basename(f.rel)); } catch (_) {}
  }

  const skillJson = {
    name: skillName, description, exec_type: 'instruction',
    source: 'skill-pack', source_url: preview.sourceUrl,
    required_bins: preview.requiredBins, required_secrets: preview.requiredSecrets,
    files: copied, installed_at: new Date().toISOString(), trusted: false,
  };
  fs.writeFileSync(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson, null, 2), 'utf8');
  return { ok: true, skillName, skillDir, contractMd, copied };
}

async function registerSkillWithMemory(contractMd) {
  const body = JSON.stringify({
    version: 'mcp.v1', service: 'user-memory', action: 'skill.install',
    payload: { contractMd }, requestId: 'skill-import-' + Date.now(),
  });
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: MEM_PORT, path: '/skill.install', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                 ...(MEM_API_KEY ? { Authorization: `Bearer ${MEM_API_KEY}` } : {}) },
      timeout: 8000,
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (_) { resolve(null); } });
    });
    req.on('error', (e) => { logger.warn(`[skill-importer] user-memory registration failed: ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

async function installSkill(preview, opts = {}) {
  if (!preview || !preview.skillMd) return { ok: false, error: 'preview with skillMd is required' };

  const filesResult = installSkillFiles(preview, opts);
  if (!filesResult.ok) return filesResult;

  const agents = [];
  for (const bin of preview.requiredBins || []) {
    try {
      agents.push(await createCliAgentForBin({ bin, preview }));
    } catch (e) {
      logger.warn(`[skill-importer] agent creation failed for ${bin}: ${e.message}`);
      agents.push({ bin, error: e.message });
    }
  }

  await registerSkillWithMemory(filesResult.contractMd);
  logger.info(`[skill-importer] installed ${filesResult.skillName} → ${filesResult.skillDir}; agents: ${agents.map(a => a.agentId).join(', ') || 'none'}`);

  return {
    ok: true,
    name: filesResult.skillName,
    path: filesResult.skillDir,
    agents,
    requiredSecrets: preview.requiredSecrets,
    installCmds: preview.installCmds,
    validateCmds: preview.validateCmds,
    needsSetup: agents.some(a => !a.installed) || (preview.requiredSecrets || []).length > 0,
  };
}

module.exports = { inspectSkill, installSkill, normalizeDotName, parseFrontmatter };
