'use strict';
/**
 * project.builder.cjs
 *
 * Builds a self-contained Vite+React+Express app from the fixed scaffold template.
 * The LLM fills in server/app.js and client/App.jsx only — scaffold plumbing never changes.
 *
 * Loop: generate → npm install → build → start → Playwright smoke test → fix → retry (max 5x)
 *
 * Args:
 *   capability   string  — what the project needs to do (from needs_skill args)
 *   description  string  — full user request
 *   projectName  string  — optional, derived from capability if not set
 *
 * Returns:
 *   { ok, projectName, projectDir, port, iterations, error? }
 */

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn, execSync } = require('child_process');
const http   = require('http');
const logger = require('../logger.cjs');

const SCAFFOLD_DIR    = path.join(__dirname, '..', 'project-scaffold');
const PROJECTS_BASE   = path.join(os.homedir(), '.thinkdrop', 'projects');
const MAX_ITERATIONS  = 5;
const BUILD_TIMEOUT   = 120000;  // 2 min for npm install + build
const START_TIMEOUT   = 15000;   // 15s for server to become ready
const PORT_MIN        = 40000;
const PORT_MAX        = 49999;

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function pickPort() {
  return Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1)) + PORT_MIN;
}

function copyScaffold(projectDir) {
  const copyDir = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
      const srcPath  = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  };
  copyDir(SCAFFOLD_DIR, projectDir);
}

function patchPackageJson(projectDir, projectName, description) {
  const pkgPath = path.join(projectDir, 'package.json');
  let content = fs.readFileSync(pkgPath, 'utf8');
  content = content
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, description || '');
  // Rename from .tpl if still named that
  if (!fs.existsSync(pkgPath) || pkgPath.endsWith('.tpl')) {
    fs.writeFileSync(path.join(projectDir, 'package.json'), content, 'utf8');
  } else {
    fs.writeFileSync(pkgPath, content, 'utf8');
  }
}

async function runCommand(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false, env: { ...process.env } });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', d => { stdout += d.toString(); });
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr, error: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
    proc.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
  });
}

async function waitForServer(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, res => {
          resolve(res.statusCode === 200);
        });
        req.on('error', reject);
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch (_) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

async function pingCommandChannel(port) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ action: 'ping' });
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/thinkdrop/command',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', d => { data += d.toString(); });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ ok: parsed.ok === true, data: parsed });
        } catch (_) {
          resolve({ ok: false, error: 'Invalid JSON response' });
        }
      });
    });
    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: false, error: 'Ping timed out' }); });
    req.write(body);
    req.end();
  });
}

async function playwrightSmokeTest(port) {
  // Use existing Playwright from browser.act if available, otherwise skip visual test
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page    = await context.newPage();

    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', err => errors.push(err.message));

    try {
      await page.goto(`http://127.0.0.1:${port}`, { timeout: 10000, waitUntil: 'domcontentloaded' });
      // Give it a moment to load
      await page.waitForTimeout(2000);
    } catch (navErr) {
      await browser.close();
      return { ok: false, errors: [`Navigation failed: ${navErr.message}`] };
    }

    await browser.close();

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true, errors: [] };
  } catch (playwrightErr) {
    // Playwright not available — skip visual test, HTTP ping is enough
    logger.warn(`[project.builder] Playwright not available, skipping visual smoke test: ${playwrightErr.message}`);
    return { ok: true, errors: [], skipped: true };
  }
}

// ── LLM code generation ───────────────────────────────────────────────────────

async function generateAppCode(llm, promptTemplate, userRequest, capabilities, projectName, previousErrors) {
  const prompt = promptTemplate
    .replace('{{USER_REQUEST}}', userRequest)
    .replace('{{CAPABILITIES}}', capabilities)
    .replace('{{PROJECT_NAME}}', projectName)
    .replace('{{APP_TITLE}}', projectName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

  const fixContext = previousErrors && previousErrors.length > 0
    ? `\n\n## PREVIOUS ATTEMPT ERRORS (fix these):\n${previousErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nGenerate corrected versions of server/app.js and client/App.jsx that fix ALL of the above errors.`
    : '';

  const fullPrompt = prompt + fixContext;

  const raw = await llm.ask(fullPrompt, { maxTokens: 4000, temperature: 0.2 });
  if (!raw) throw new Error('LLM returned empty response');
  return parseGeneratedCode(raw);
}

function parseGeneratedCode(raw) {
  const result = { serverApp: null, clientApp: null };

  // Match ### FILE: server/app.js ... ```js ... ```
  const serverMatch = raw.match(/###\s*FILE:\s*server\/app\.js[\s\S]*?```(?:js|javascript)?\n([\s\S]*?)```/i);
  if (serverMatch) result.serverApp = serverMatch[1].trim();

  // Match ### FILE: client/App.jsx ... ```jsx ... ```
  const clientMatch = raw.match(/###\s*FILE:\s*client\/App\.jsx[\s\S]*?```(?:jsx|javascript|js)?\n([\s\S]*?)```/i);
  if (clientMatch) result.clientApp = clientMatch[1].trim();

  // Fallback: try to extract any code blocks if structured format was not followed
  if (!result.serverApp || !result.clientApp) {
    const blocks = [...raw.matchAll(/```(?:js|jsx|javascript)?\n([\s\S]*?)```/g)].map(m => m[1].trim());
    if (blocks.length >= 2 && !result.serverApp) result.serverApp = blocks[0];
    if (blocks.length >= 2 && !result.clientApp) result.clientApp = blocks[1];
    if (blocks.length === 1) {
      // Single block — use as server/app.js if it has handleCommand, else App.jsx
      if (blocks[0].includes('handleCommand')) result.serverApp = blocks[0];
      else result.clientApp = blocks[0];
    }
  }

  return result;
}

function writeGeneratedFiles(projectDir, serverApp, clientApp) {
  if (serverApp) {
    fs.mkdirSync(path.join(projectDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'server', 'app.js'), serverApp, 'utf8');
  }
  if (clientApp) {
    fs.mkdirSync(path.join(projectDir, 'client'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'client', 'App.jsx'), clientApp, 'utf8');
  }
}

// ── Registration ──────────────────────────────────────────────────────────────

async function registerProject(projectName, projectDir, description, capability, port) {
  try {
    const userMemoryUrl = process.env.MCP_USER_MEMORY_URL || 'http://localhost:3001';
    const body = JSON.stringify({
      version: 'mcp.v1',
      service: 'user-memory',
      action: 'skill.install',
      payload: {
        name: projectName,
        displayName: projectName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description,
        execType: 'project',
        execPath: projectDir,
        contractMd: `---\nname: ${projectName}\ndescription: ${description}\ncapability: ${capability}\nexec_type: project\nexec_path: ${projectDir}\ndefault_port: ${port}\nschedule: null\nsecrets: []\n---\n## Plan\nLaunched as a self-contained Vite+React+Express app via project.builder.\n`,
        enabled: true,
        source: 'project-builder',
      },
      requestId: `pb-reg-${Date.now()}`
    });

    await new Promise((resolve, reject) => {
      const url = new URL('/skill.install', userMemoryUrl);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 3001,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = '';
        res.on('data', d => { data += d.toString(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    logger.info(`[project.builder] Registered project "${projectName}" in user-memory`);
  } catch (err) {
    logger.warn(`[project.builder] Registration failed (non-fatal): ${err.message}`);
  }

  // Write a local .thinkdrop-project.json manifest for runtime use
  fs.writeFileSync(
    path.join(projectDir, '.thinkdrop-project.json'),
    JSON.stringify({ projectName, description, capability, defaultPort: port, builtAt: new Date().toISOString() }, null, 2),
    'utf8'
  );
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run(args) {
  const { capability, description, projectName: nameArg } = args || {};

  if (!capability && !description) {
    return { ok: false, error: 'project.builder requires capability or description' };
  }

  const llm = require('../skill-llm.cjs');
  if (!await llm.isAvailable()) {
    return { ok: false, error: 'LLM backend not available for project generation' };
  }

  const projectName = nameArg || slugify(capability || description || 'thinkdrop-app');
  const projectDir  = path.join(PROJECTS_BASE, projectName);

  logger.info(`[project.builder] Building project "${projectName}" at ${projectDir}`);

  // Load prompt template — try multiple candidate paths
  let promptTemplate;
  const promptCandidates = [
    // Running from command-service/src/skills/ (4 levels deep) → monorepo root/stategraph-module
    path.join(__dirname, '..', '..', '..', '..', 'stategraph-module', 'src', 'prompts', 'project-build.md'),
    // Installed under node_modules at the monorepo root
    path.join(__dirname, '..', '..', '..', '..', 'node_modules', '@thinkdrop', 'stategraph', 'src', 'prompts', 'project-build.md'),
    // Running from command-service/src/skills/ with local node_modules
    path.join(__dirname, '..', 'node_modules', '@thinkdrop', 'stategraph', 'src', 'prompts', 'project-build.md'),
    // ~/.thinkdrop/prompts fallback
    path.join(os.homedir(), '.thinkdrop', 'prompts', 'project-build.md'),
  ];
  for (const candidate of promptCandidates) {
    try {
      promptTemplate = fs.readFileSync(candidate, 'utf8');
      logger.info(`[project.builder] Loaded prompt template from: ${candidate}`);
      break;
    } catch (_) { /* try next */ }
  }
  if (!promptTemplate) {
    return { ok: false, error: 'Could not load project-build.md prompt template' };
  }

  // Set up project directory from scaffold
  if (fs.existsSync(projectDir)) {
    logger.info(`[project.builder] Project dir exists — cleaning for rebuild`);
    // Preserve node_modules if present to speed up reinstall
    const nmPath = path.join(projectDir, 'node_modules');
    const nmBackup = nmPath + '_backup_' + Date.now();
    if (fs.existsSync(nmPath)) fs.renameSync(nmPath, nmBackup);
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.mkdirSync(projectDir, { recursive: true });
    if (fs.existsSync(nmBackup)) fs.renameSync(nmBackup, nmPath);
  } else {
    fs.mkdirSync(projectDir, { recursive: true });
  }

  copyScaffold(projectDir);

  // Rename package.json.tpl → package.json
  const tplPath = path.join(projectDir, 'package.json.tpl');
  if (fs.existsSync(tplPath)) {
    let content = fs.readFileSync(tplPath, 'utf8');
    content = content
      .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
      .replace(/\{\{PROJECT_DESCRIPTION\}\}/g, description || capability || '');
    fs.writeFileSync(path.join(projectDir, 'package.json'), content, 'utf8');
    fs.unlinkSync(tplPath);
  }

  let iterations = 0;
  let previousErrors = [];
  let serverProc = null;
  const port = pickPort();

  try {
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      logger.info(`[project.builder] Iteration ${iterations}/${MAX_ITERATIONS}`);

      // ── Step 1: Generate code ───────────────────────────────────────────────
      logger.info(`[project.builder] Generating app code...`);
      let generated;
      try {
        generated = await generateAppCode(llm, promptTemplate, description || capability, capability, projectName, previousErrors);
      } catch (genErr) {
        previousErrors = [`Code generation failed: ${genErr.message}`];
        continue;
      }

      if (!generated.serverApp && !generated.clientApp) {
        previousErrors = ['LLM did not return valid code blocks (expected ### FILE: server/app.js and ### FILE: client/App.jsx)'];
        continue;
      }

      writeGeneratedFiles(projectDir, generated.serverApp, generated.clientApp);
      logger.info(`[project.builder] Code written — server/app.js: ${generated.serverApp ? 'yes' : 'no'}, client/App.jsx: ${generated.clientApp ? 'yes' : 'no'}`);

      // ── Step 2: npm install ─────────────────────────────────────────────────
      logger.info(`[project.builder] Running npm install...`);
      const installResult = await runCommand('npm', ['install', '--prefer-offline', '--legacy-peer-deps'], projectDir, BUILD_TIMEOUT);
      if (!installResult.ok) {
        previousErrors = [`npm install failed:\n${installResult.stderr || installResult.error}`];
        logger.warn(`[project.builder] npm install failed: ${previousErrors[0]}`);
        continue;
      }

      // ── Step 3: Vite build ──────────────────────────────────────────────────
      logger.info(`[project.builder] Running vite build...`);
      const buildResult = await runCommand('npm', ['run', 'build'], projectDir, BUILD_TIMEOUT);
      if (!buildResult.ok) {
        const buildErr = (buildResult.stderr || buildResult.stdout || buildResult.error || '').slice(0, 2000);
        previousErrors = [`Vite build failed:\n${buildErr}`];
        logger.warn(`[project.builder] Build failed on iteration ${iterations}`);
        continue;
      }

      // ── Step 4: Start server ────────────────────────────────────────────────
      if (serverProc) {
        try { serverProc.kill('SIGTERM'); } catch (_) {}
        serverProc = null;
        await new Promise(r => setTimeout(r, 500));
      }

      logger.info(`[project.builder] Starting server on port ${port}...`);
      serverProc = spawn('node', ['server/index.js'], {
        cwd: projectDir,
        env: { ...process.env, PORT: String(port) },
        detached: false,
      });

      let serverStartErr = '';
      serverProc.stderr?.on('data', d => { serverStartErr += d.toString(); });

      const serverReady = await waitForServer(port, START_TIMEOUT);
      if (!serverReady) {
        const errMsg = serverStartErr.slice(0, 1000) || 'Server did not become ready in time';
        previousErrors = [`Server failed to start on port ${port}:\n${errMsg}`];
        logger.warn(`[project.builder] Server start failed on iteration ${iterations}`);
        try { serverProc.kill('SIGTERM'); } catch (_) {}
        serverProc = null;
        continue;
      }

      // ── Step 5: Smoke tests ─────────────────────────────────────────────────
      logger.info(`[project.builder] Running smoke tests...`);

      // HTTP ping
      const pingResult = await pingCommandChannel(port);
      if (!pingResult.ok) {
        previousErrors = [`/thinkdrop/command ping failed: ${pingResult.error || JSON.stringify(pingResult.data)}`];
        try { serverProc.kill('SIGTERM'); } catch (_) {}
        serverProc = null;
        continue;
      }

      // Playwright visual test
      const playwrightResult = await playwrightSmokeTest(port);
      if (!playwrightResult.ok) {
        previousErrors = [`UI errors detected:\n${playwrightResult.errors.join('\n')}`];
        try { serverProc.kill('SIGTERM'); } catch (_) {}
        serverProc = null;
        continue;
      }

      // ── All tests passed ────────────────────────────────────────────────────
      logger.info(`[project.builder] ✅ Project "${projectName}" built successfully in ${iterations} iteration(s)`);

      // Stop dev server — runtime will manage it via external.skill
      try { serverProc.kill('SIGTERM'); } catch (_) {}
      serverProc = null;

      // Register in user-memory
      await registerProject(projectName, projectDir, description || capability, capability, port);

      return {
        ok: true,
        projectName,
        projectDir,
        port,
        iterations,
        output: `Project "${projectName}" built and ready. Located at ${projectDir}.`,
      };
    }

    // Max iterations reached
    logger.error(`[project.builder] Failed after ${MAX_ITERATIONS} iterations. Last errors: ${previousErrors.join('; ')}`);
    return {
      ok: false,
      projectName,
      projectDir,
      iterations,
      error: `Could not build project after ${MAX_ITERATIONS} attempts. Last error: ${previousErrors[0] || 'unknown'}`,
    };

  } finally {
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch (_) {}
    }
  }
}

module.exports = { run };
