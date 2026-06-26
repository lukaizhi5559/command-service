/**
 * Command Service MCP Server
 *
 * Actuation-only MCP service. Owns all "can touch the machine" skills:
 *   - command.automate  → skill router (shell.run, browser.act, image.analyze, fs.read, file.watch, file.bridge, screen.capture, external.skill, cli.agent, browser.agent, web.agent, video.agent, creator.agent, reviewer.agent)
 *   - health            → service health check
 *
 * Perception, planning, memory, and intent resolution live in other services.
 */

require('dotenv').config();
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const logger = require('./logger.cjs');
// Shared infrastructure for skills — intelligence + storage
// Any skill can require these directly:
//   const { ask } = require('../skill-llm.cjs');
//   const db = require('../skill-db.cjs');
const skillLlm = require('./skill-helpers/skill-llm.cjs');
const skillDb = require('./skill-helpers/skill-db.cjs');
const { shellRun } = require('./skills/shell.run.cjs');
const { browserAct } = require('./skills/browser.act.cjs');
const { webCrawl } = require('./skills/web.crawl.cjs');
const { imageAnalyze } = require('./skills/image.analyze.cjs');
const { fsRead } = require('./skills/fs.read.cjs');
const { fileWatch } = require('./skills/file.watch.cjs');
const { fileBridge } = require('./skills/file.bridge.cjs');
const { run: externalSkillRun } = require('./skills/external.skill.cjs');
const { run: projectBuilderRun } = require('./skills/project.builder.cjs');
const { projectLaunch } = require('./skills/project.launcher.cjs');
const { projectEdit } = require('./skills/project.editor.cjs');
const { projectStop } = require('./skills/project.stopper.cjs');
const { cliAgent } = require('./skills/cli.agent.cjs');
const { browserAgent } = require('./skills/browser.agent.cjs');
const { playwrightAgent } = require('./skills/playwright.agent.cjs');
const creatorAgent = require('./skills/creator.agent.cjs');
const reviewerAgent = require('./skills/reviewer.agent.cjs');
const skillCreator = require('./skills/skillCreator.skill.cjs');
const { screenCapture } = require('./skills/screen.capture.cjs');
const { userAgent } = require('./skills/user.agent.cjs');
const webAgent   = require('./skills/web.agent.cjs');
const videoAgent = require('./skills/video.agent.cjs');
const appAgent   = require('./skills/app.agent.cjs');
const skillScheduler = require('./skill-helpers/skill-scheduler.cjs');
const { startIdleWatcher, stopIdleWatcher, startScanScheduler, runMaintenanceScan, cancelMaintenanceScan, getScanStatus } = require('./skills/explore.agent.cjs');
const { systemIntrospect } = require('./skills/system.introspect.cjs');

class CommandServiceMCPServer {
  constructor() {
    this.serviceName = process.env.SERVICE_NAME || 'command-service';

    logger.info('CommandServiceMCPServer initialized', {
      serviceName: this.serviceName
    });
  }

  /**
   * Skill router — dispatches to the appropriate automation skill
   * @param {Object} payload - { skill, args }
   *   skill: 'shell.run' | 'browser.act' | 'image.analyze' | 'fs.read' | 'file.watch' | 'file.bridge' | 'screen.capture' | 'external.skill' | 'cli.agent' | 'browser.agent'
   *   args:  skill-specific arguments (see skills/ implementations)
   */
  async executeAutomation(payload, opts = {}) {
    const { skill, args = {} } = payload || {};

    if (!skill) {
      return {
        success: false,
        error: 'skill is required (shell.run | browser.act | image.analyze | fs.read | file.watch | file.bridge | screen.capture | external.skill | cli.agent | browser.agent)'
      };
    }

    logger.info('Routing automation skill', { skill });

    switch (skill) {
      case 'shell.run':
        return await this._skillShellRun(args);

      case 'browser.act':
        return await this._skillBrowserAct(args);

      case 'web.crawl':
        return await this._skillWebCrawl(args);

      case 'image.analyze':
        return await this._skillImageAnalyze(args);

      case 'fs.read':
        return await this._skillFsRead(args);

      case 'file.watch':
        return await this._skillFileWatch(args);

      case 'file.bridge':
        return await this._skillFileBridge(args);

      case 'external.skill':
        return await this._skillExternal(args, payload);

      case 'screen.capture':
        return await this._skillScreenCapture(args);

      case 'cli.agent':
        return await this._skillCliAgent(args);

      case 'browser.agent':
        return await this._skillBrowserAgent(args);

      case 'playwright.agent':
        return await this._skillPlaywrightAgent(args);

      case 'creator.agent':
        return await this._skillCreatorAgent(args);

      case 'reviewer.agent':
        return await this._skillReviewerAgent(args);

      case 'skillCreator.skill':
        return await this._skillCreator(args);

      case 'project.builder':
        return await this._skillProjectBuilder(args);

      case 'project.launcher':
        return await this._skillProjectLauncher(args);

      case 'project.editor':
        return await this._skillProjectEditor(args);

      case 'project.stopper':
        return await this._skillProjectStopper(args);

      case 'user.agent':
        return await this._skillUserAgent(args);

      case 'web.agent':
        return await this._skillWebAgent(args);

      case 'video.agent':
        return await this._skillVideoAgent(args);

      case 'app.agent':
        return await this._skillAppAgent(args, opts);

      case 'system.introspect':
        return await this._skillSystemIntrospect(args);

      default:
        return {
          success: false,
          error: `Unknown skill: ${skill}`
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Skills — stubs, implementations will live in skills/ and be required here
  // ---------------------------------------------------------------------------

  async _skillShellRun(args) {
    return await shellRun(args);
  }

  async _skillBrowserAct(args) {
    return await browserAct(args);
  }

  async _skillWebCrawl(args) {
    return await webCrawl(args);
  }

  async _skillWebAgent(args) {
    return await webAgent(args);
  }

  async _skillVideoAgent(args) {
    return await videoAgent(args, { browserAct, skillLlm, cliAgent });
  }

  async _skillImageAnalyze(args) {
    return await imageAnalyze(args);
  }

  async _skillFsRead(args) {
    return await fsRead(args);
  }

  async _skillFileWatch(args) {
    return await fileWatch(args);
  }

  async _skillScreenCapture(args) {
    return await screenCapture(args);
  }

  async _skillFileBridge(args) {
    return await fileBridge(args);
  }

  async _skillExternal(args) {
    return await externalSkillRun(args);
  }

  async _skillCliAgent(args) {
    return await cliAgent(args);
  }

  async _skillBrowserAgent(args) {
    return await browserAgent(args);
  }

  async _skillCreatorAgent(args) {
    return await creatorAgent(args);
  }

  async _skillReviewerAgent(args) {
    return await reviewerAgent(args);
  }

  async _skillCreator(args) {
    return await skillCreator(args);
  }

  async _skillProjectBuilder(args) {
    return await projectBuilderRun(args);
  }

  async _skillProjectLauncher(args) {
    return await projectLaunch(args);
  }

  async _skillProjectEditor(args) {
    return await projectEdit(args);
  }

  async _skillProjectStopper(args) {
    return await projectStop(args);
  }

  async _skillUserAgent(args) {
    return await userAgent(args);
  }

  async _skillPlaywrightAgent(args) {
    return await playwrightAgent(args);
  }

  async _skillSystemIntrospect(args) {
    return await systemIntrospect(args);
  }

  async _skillAppAgent(args, opts = {}) {
    const { action, ...rest } = args || {};
    // Long-running monitor actions honor an AbortSignal so the server-side loop
    // stops when the HTTP client times out and destroys the socket.
    if (opts.signal) rest.signal = opts.signal;
    const ACTION_MAP = {
      parse_screenshot:          appAgent.actionParseScreenshot,
      parse_screenshot_docling:  appAgent.actionParseScreenshotDocling,
      find_elements:             appAgent.actionFindElements,
      highlight_elements:        appAgent.actionHighlightElements,
      highlight_all:             appAgent.actionHighlightAll,
      highlight_search:          appAgent.actionHighlightSearch,
      highlight_boundaries:      appAgent.actionHighlightBoundaries,
      highlight_assets:          appAgent.actionHighlightAssets,
      analyze_spatial_grid:      appAgent.actionAnalyzeSpatialGrid,
      capture_screen:            appAgent.actionCaptureScreen,
      clear_highlights:          appAgent.actionClearHighlights,
      // Phase 2
      enrich_app_context:        appAgent.enrichAppContext,
      discover_shortcuts:        appAgent.actionDiscoverShortcuts,
      clear_boundary_cache:      appAgent.actionClearBoundaryCache,
      // Phase 3
      pre_scroll_plan:           appAgent.actionPreScrollPlan,
      scroll:                    appAgent.actionScroll,
      search_scroll:             appAgent.actionSearchScroll,
      ai_response_scroll:        appAgent.actionAiResponseScroll,
      monitor_with_backoff:      appAgent.actionMonitorWithBackoff,
      execute_shortcut:          appAgent.actionExecuteShortcut,
      get_recent_ocr:            appAgent.getRecentOCR,
      // Phase 3 additional use cases
      monitor_file_upload:       appAgent.actionMonitorFileUpload,
      monitor_build_completion:  appAgent.actionMonitorBuildCompletion,
      monitor_form_submission:   appAgent.actionMonitorFormSubmission,
      // Phase 3 new actions
      live_chat_scroll:          appAgent.actionLiveChatScroll,
      passive_read_scroll:       appAgent.actionPassiveReadScroll,
      teleport_to_element:       appAgent.actionTeleportToElement,
      search_and_click:          appAgent.actionSearchAndClick,
      infer_main_region:         appAgent.inferMainRegion,
      get_boundaries:            appAgent.getBoundariesFromCache,
      verify_app_focused:        appAgent.verifyAppFocused,
      get_active_bounds:         appAgent.actionGetActiveBounds,
      // Phase 3.5
      verify_shortcut:               appAgent.actionVerifyShortcut,
      verify_action:                 appAgent.actionVerifyAction,
      // Phase 4
      clipboard_backup:              appAgent.actionClipboardBackup,
      clipboard_restore:             appAgent.actionClipboardRestore,
      extract_content_via_clipboard: appAgent.actionExtractContentViaClipboard,
    };

    const fn = ACTION_MAP[action];
    if (!fn) {
      return { success: false, error: `Unknown app.agent action: ${action}. Valid: ${Object.keys(ACTION_MAP).join(', ')}` };
    }

    try {
      const result = await fn(rest);
      return { success: true, ...result };
    } catch (err) {
      logger.error(`[app.agent] action=${action} error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck() {
    return {
      success: true,
      service: this.serviceName,
      status: 'healthy',
      skills: ['shell.run', 'browser.act', 'web.crawl', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'screen.capture', 'external.skill', 'cli.agent', 'browser.agent', 'playwright.agent', 'creator.agent', 'reviewer.agent', 'skillCreator.skill', 'project.builder', 'project.launcher', 'project.editor', 'project.stopper', 'app.agent', 'system.introspect']
    };
  }

  // ---------------------------------------------------------------------------
  // stdio transport (MCP protocol)
  // ---------------------------------------------------------------------------

  async start() {
    logger.info('Starting Command Service MCP server (stdio)');

    // ── Prune stale ephemeral browser profile dirs ───────────────────────────
    // Background scans create per-hostname _scan_ and _validate_ dirs. With stable
    // session names these only grow by 1 dir per hostname, but old timestamped dirs
    // from before the fix accumulate. Delete any *_scan_* / *_validate_* dirs older
    // than 48h so disk usage stays bounded. Named agent dirs are never touched.
    try {
      const profilesDir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
      const cutoffMs    = 48 * 60 * 60 * 1000;
      const entries     = fs.readdirSync(profilesDir, { withFileTypes: true });
      let pruned = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const isEphemeral = /_scan_\d|_validate_\d/.test(entry.name);
        if (!isEphemeral) continue;
        const fullPath = path.join(profilesDir, entry.name);
        const { mtimeMs } = fs.statSync(fullPath);
        if (Date.now() - mtimeMs > cutoffMs) {
          fs.rmSync(fullPath, { recursive: true, force: true });
          pruned++;
        }
      }
      if (pruned > 0) logger.info(`[Server] Pruned ${pruned} stale ephemeral browser profile dir(s)`);
    } catch (err) {
      logger.debug(`[Server] Profile dir cleanup skipped: ${err.message}`);
    }

    // ── Warm up creator.agent DB (ensures projects table exists) ────────────
    creatorAgent({ action: 'list_projects' }).catch(() => {});
    reviewerAgent({ action: 'status', projectId: '__warmup__' }).catch(() => {});

    // ── Generate workspace manifest ────────────────────────────────────────────
    // Creates ~/.thinkdrop/manifest.json with agents, skills, DB info for self-awareness
    const { generateManifest } = require('./workspace-manifest.cjs');
    generateManifest().catch(err => logger.warn('[Server] Manifest generation failed (non-fatal)', { error: err.message }));

    // ── Start skill scheduler daemon ─────────────────────────────────────────
    // Reads installed skills from user-memory MCP, registers node-cron jobs
    // for any skill with a schedule ≠ on_demand. Re-syncs every 5 min.
    skillScheduler.start().catch(err => logger.warn('[Server] Skill scheduler start failed', { error: err.message }));

    // ── explore.agent maintenance scan services ──────────────────────────────
    // Idle watcher: polls system idle every 5min, fires maintenance scan after 30min idle + 24h cooldown
    // Scan scheduler: reads ~/.thinkdrop/scan-schedule.json, registers node-cron job if configured
    // Auto-scan is opt-in — check settings file before starting idle watcher
    try {
      let autoScanEnabled = false;
      try {
        const settingsPath = path.join(os.homedir(), '.thinkdrop', 'settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
          autoScanEnabled = !!settings.autoScanEnabled;
        }
      } catch (_) { /* ignore read errors, default to false */ }
      
      if (autoScanEnabled) {
        startIdleWatcher();
        logger.info('[Server] Idle watcher started (auto-scan enabled)');
      } else {
        logger.info('[Server] Idle watcher not started (auto-scan disabled by default — enable in Agents tab)');
      }
      startScanScheduler(); // Always start scan scheduler (cron-based, user-configured)
    } catch (err) {
      logger.warn('[Server] explore.agent maintenance services failed to start (non-fatal)', { error: err.message });
    }

    // ── Startup skill health scan ─────────────────────────────────────────────
    // Runs once after the scheduler starts — validates all installed skills and
    // writes health records to the skill_health table. Non-blocking and non-fatal.
    try {
      const skillReview = require('./skills/skill.review.cjs');
      skillReview({ action: 'scan_all' }, { logger })
        .then(report => {
          if (report?.summary) logger.info(`[skill.review] ${report.summary}`);
          if (report?.invalidSkills?.length > 0) {
            logger.warn('[skill.review] Invalid skills detected at startup', {
              count: report.invalidSkills.length,
              names: report.invalidSkills.map(s => s.name),
            });
          }
        })
        .catch(err => logger.warn('[skill.review] Startup scan failed (non-fatal)', { error: err.message }));
    } catch (e) {
      logger.warn('[skill.review] Could not load skill.review.cjs (non-fatal)', { error: e.message });
    }

    // ── Minimal HTTP health server ───────────────────────────────────────────
    // Keeps the Node.js event loop alive (no active I/O = process exits) and
    // satisfies the service manager's health check at http://localhost:3007/health
    const PORT = parseInt(process.env.PORT || '3007', 10);
    const healthServer = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      // Handle preflight OPTIONS
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.url === '/health' || req.url === '/service.health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          service: this.serviceName,
          skills: ['shell.run', 'browser.act', 'web.crawl', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'screen.capture', 'external.skill', 'cli.agent', 'browser.agent', 'playwright.agent', 'creator.agent', 'reviewer.agent', 'skillCreator.skill', 'project.builder', 'project.launcher', 'project.editor', 'project.stopper', 'app.agent', 'system.introspect']
        }));
        return;
      }

      // ── GET /agents.list ────────────────────────────────────────────────────
      // List all agents: DB rows merged with disk-scan of .agent.md files.
      // Disk-scan ensures agents that haven't been migrated to DB are visible.
      if (req.method === 'GET' && req.url === '/agents.list') {
        try {
          const fsL = require('fs');
          const pathL = require('path');
          const osL = require('os');
          const { actionListAllAgents } = require('./skills/cli.agent.cjs');

          // DB agents (may be partial)
          let dbAgents = [];
          try {
            const result = await actionListAllAgents();
            dbAgents = result?.agents || [];
          } catch (_) {}

          // Disk-scan fallback — parse .agent.md frontmatter
          const agentsDir = pathL.join(osL.homedir(), '.thinkdrop', 'agents');
          const diskAgents = [];
          try {
            if (fsL.existsSync(agentsDir)) {
              const files = fsL.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
              for (const file of files) {
                try {
                  const content = fsL.readFileSync(pathL.join(agentsDir, file), 'utf8');
                  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
                  if (!fmMatch) continue;
                  const fm = {};
                  for (const line of fmMatch[1].split('\n')) {
                    if (/^[ \t]/.test(line)) continue; // skip indented sub-keys (nested YAML blocks)
                    const ci = line.indexOf(':');
                    if (ci === -1) continue;
                    const k = line.slice(0, ci).trim();
                    const v = line.slice(ci + 1).trim().replace(/^['"]|['"]$/g, '');
                    if (k && !k.startsWith('-')) fm[k] = v;
                  }
                  if (!fm.id) continue;
                  const capMatch = content.match(/^capabilities:\s*\n((?:[ \t]+-[^\n]*\n?)*)/m);
                  const capabilities = capMatch
                    ? capMatch[1].split('\n').map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
                    : [];
                  diskAgents.push({
                    id: fm.id,
                    type: fm.type || 'browser',
                    service: fm.service || fm.id.replace('.agent', ''),
                    cliTool: fm.cli_tool || null,
                    capabilities,
                    status: fm.status || 'healthy',
                    lastValidated: null,
                    descriptor: content,
                  });
                } catch (_) {}
              }
            }
          } catch (_) {}

          // Dedup within DB results: legacy rows stored id='youtube' alongside canonical id='youtube.agent'
          // Keep the .agent-suffixed row when both exist for the same service.
          const _normKey = id => (id || '').replace(/\.agent$/, '').toLowerCase().trim();
          const _seen = new Map();
          for (const a of dbAgents) {
            const key = _normKey(a.id);
            const existing = _seen.get(key);
            if (!existing || a.id.endsWith('.agent')) _seen.set(key, a);
          }
          dbAgents = [..._seen.values()];

          // Merge: DB takes priority, disk fills in missing agents
          const dbIds = new Set(dbAgents.map(a => _normKey(a.id)));
          const merged = [...dbAgents, ...diskAgents.filter(a => !dbIds.has(_normKey(a.id)))];

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, agents: merged }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // ── GET /debug/resolve-credentials?agentId=gmail.agent ──────────────────
      // Test what resolveCredentials returns including all fallback steps.
      // Usage: open http://localhost:3007/debug/resolve-credentials?agentId=gmail.agent
      if (req.method === 'GET' && req.url?.startsWith('/debug/resolve-credentials')) {
        const agentId = new URL(req.url, 'http://localhost').searchParams.get('agentId') || 'gmail.agent';
        try {
          const { userAgent } = require('./skills/user.agent.cjs');
          const result = await userAgent({ action: 'resolve_credentials', agentId });
          res.writeHead(200);
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── GET /debug/profile?key=self:email ────────────────────────────────────
      // Directly query a profile KV key to verify storage.
      // Usage: open http://localhost:3007/debug/profile?key=self:email
      if (req.method === 'GET' && req.url?.startsWith('/debug/profile')) {
        const key = new URL(req.url, 'http://localhost').searchParams.get('key') || 'self:email';
        try {
          const http2 = require('http');
          const body = JSON.stringify({ version: 'mcp.v1', service: 'user-memory', action: 'profile.get', payload: { key } });
          const memUrl = process.env.MCP_USER_MEMORY_URL || 'http://127.0.0.1:3001';
          const memKey = process.env.MCP_USER_MEMORY_API_KEY || '';
          const parsed = new URL(memUrl);
          const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
          if (memKey) reqHeaders['Authorization'] = `Bearer ${memKey}`;
          const raw = await new Promise((resolve, reject) => {
            const r = http2.request({ hostname: parsed.hostname, port: Number(parsed.port) || 3001, path: '/profile.get', method: 'POST', headers: reqHeaders }, (resp) => {
              let d = ''; resp.on('data', c => d += c); resp.on('end', () => resolve(d));
            });
            r.on('error', reject); r.write(body); r.end();
          });
          res.writeHead(200);
          res.end(raw);
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // ── POST /skill.schedule — register/refresh a skill's cron immediately ──
      // Called by skillCreator after writing a new scheduled skill.
      if (req.method === 'POST' && req.url === '/skill.schedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName, schedule, execPath, metadata } = JSON.parse(body || '{}');
            await skillScheduler.registerSkill(skillName, schedule, execPath, metadata || {});
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── GET /skill.schedule/list — list active cron jobs ─────────────────────
      if (req.method === 'GET' && req.url === '/skill.schedule/list') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, jobs: skillScheduler.listJobs() }));
        return;
      }

      // ── POST /skill.fire — immediately fire a scheduled skill ("Run now") ────
      if (req.method === 'POST' && req.url === '/skill.fire') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName, forced } = JSON.parse(body || '{}');
            if (!skillName) {
              res.writeHead(400);
              res.end(JSON.stringify({ ok: false, error: 'skillName required' }));
              return;
            }
            const result = await skillScheduler.runSkillNow(skillName, forced === true);
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.schedule/sync — force immediate re-sync from user-memory ──
      if (req.method === 'POST' && req.url === '/skill.schedule/sync') {
        skillScheduler.sync().catch(() => {});
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── POST /skill.unschedule — remove a skill's cron job (called on skill delete) ─
      if (req.method === 'POST' && req.url === '/skill.unschedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { skillName } = JSON.parse(body || '{}');
            if (skillName) skillScheduler.unregisterSkill(skillName);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.schedule/toggle — pause or resume a skill's cron job ─────
      if (req.method === 'POST' && req.url === '/skill.schedule/toggle') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { skillName, action } = JSON.parse(body || '{}');
            if (skillName && (action === 'pause' || action === 'resume')) {
              skillScheduler.toggleSkill(skillName, action);
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /reminder.register — register a one-shot reminder ────────────────
      if (req.method === 'POST' && req.url === '/reminder.register') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { id, delayMs, label, triggerIntent, triggerPrompt, pendingSteps } = JSON.parse(body || '{}');
            const result = skillScheduler.registerReminder({ id, delayMs, label, triggerIntent, triggerPrompt, pendingSteps });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── GET /reminder.list — list pending reminders ────────────────────────────
      if (req.method === 'GET' && req.url === '/reminder.list') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, reminders: skillScheduler.listReminders() }));
        return;
      }

      // ── POST /reminder.cancel — cancel a pending reminder ──────────────────────
      if (req.method === 'POST' && req.url === '/reminder.cancel') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { id } = JSON.parse(body || '{}');
            const cancelled = skillScheduler.cancelReminder(id);
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, cancelled }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // ── POST /skill.oauth-status — check OAuth token presence for a skill ──────
      // Lightweight pre-flight check used by executeCommand.js before dispatching
      // an external.skill step. Returns connected/expired state per provider without
      // performing any token exchange or modification.
      if (req.method === 'POST' && req.url === '/skill.oauth-status') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName = '', providers = [] } = JSON.parse(body || '{}');
            let keytar = null;
            try { keytar = require('keytar'); } catch (_) {}
            const statuses = await Promise.all(providers.map(async (provider) => {
              if (!keytar) return { provider, connected: false, expired: false };
              try {
                // Mirror buildSkillContext key lookup order
                let raw = await keytar.getPassword('thinkdrop', `oauth:${provider}:${skillName}`);
                if (!raw) raw = await keytar.getPassword('thinkdrop', `oauth:${provider}`);
                if (!raw) return { provider, connected: false, expired: false };
                let tok;
                try { tok = JSON.parse(raw); } catch (_) { return { provider, connected: true, expired: false }; }
                // Blobs with only client creds (no access/refresh token) are not yet connected
                const hasToken = !!(tok.access_token || tok.refresh_token);
                if (!hasToken) return { provider, connected: false, expired: false };
                const expired = !!(tok.expires_at && Date.now() >= Number(tok.expires_at));
                return { provider, connected: true, expired };
              } catch (_) { return { provider, connected: false, expired: false }; }
            }));
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, statuses }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /scan.run — trigger maintenance scan immediately ──────────────
      if (req.method === 'POST' && req.url === '/scan.run') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { trigger = 'user' } = JSON.parse(body || '{}');
            const result = await runMaintenanceScan({ trigger });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /scan.cancel — cancel an in-progress maintenance scan ─────────
      if (req.method === 'POST' && req.url === '/scan.cancel') {
        cancelMaintenanceScan();
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ── GET /scan.status — return current scan state for UI polling ─────────
      if (req.method === 'GET' && req.url === '/scan.status') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, ...getScanStatus() }));
        return;
      }

      // ── POST /scan.schedule — write scan-schedule.json + restart scheduler ──
      if (req.method === 'POST' && req.url === '/scan.schedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const fs = require('fs');
            const os = require('os');
            const path = require('path');
            const schedFile = path.join(os.homedir(), '.thinkdrop', 'scan-schedule.json');
            const { cron, enabled } = JSON.parse(body || '{}');
            let existing = {};
            try { existing = JSON.parse(fs.readFileSync(schedFile, 'utf8')); } catch (_) {}
            const updated = { ...existing, ...(cron !== undefined ? { cron } : {}), ...(enabled !== undefined ? { enabled } : {}) };
            fs.mkdirSync(path.dirname(schedFile), { recursive: true });
            fs.writeFileSync(schedFile, JSON.stringify(updated, null, 2), 'utf8');
            startScanScheduler(); // re-register with new schedule
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, schedule: updated }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /scan.idle-watcher — enable/disable idle watcher ────────────────
      if (req.method === 'POST' && req.url === '/scan.idle-watcher') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { enabled } = JSON.parse(body || '{}');
            if (enabled) {
              startIdleWatcher();
              logger.info('[IdleWatcher] Started via /scan.idle-watcher');
            } else {
              stopIdleWatcher();
              logger.info('[IdleWatcher] Stopped via /scan.idle-watcher');
            }
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, enabled: !!enabled }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/command.automate') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        // Thread an AbortSignal tied to the socket lifecycle. The MCP client
        // (ThinkDropMCPClient._httpPost) calls req.destroy() on timeout, which
        // closes this socket. Long-running skills (app.agent monitors) honor the
        // signal so the server-side loop actually stops instead of running on.
        const controller = new AbortController();
        let responded = false;
        const onClose = () => { if (!responded) controller.abort(); };
        req.on('close', onClose);
        req.on('aborted', onClose);
        req.on('end', async () => {
          try {
            const { payload } = JSON.parse(body);
            const result = await this.executeAutomation(payload, { signal: controller.signal });
            responded = true;
            // Wrap in MCP envelope: envelope success=true always (HTTP 200).
            // The skill's own success/failure is inside data — the StateGraph
            // reads result.data and handles skill-level failures (needsManualStep, etc.)
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: result }));
          } catch (err) {
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, data: { success: false, error: err.message } }));
          }
        });
        return;
      }

      // ── POST /agent.list — list all agents from DuckDB ─────────────────────
      // Used by user-memory proxy and main.js; replaces direct DB access in those processes.
      if (req.method === 'POST' && req.url === '/agent.list') {
        try {
          const { actionListAllAgents } = require('./skills/cli.agent.cjs');
          const agents = await actionListAllAgents();
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', action: 'agent.list', data: agents.agents || [] }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ status: 'error', error: err.message }));
        }
        return;
      }

      // ── POST /agent.update — update agent fields in DuckDB ───────────────────
      if (req.method === 'POST' && req.url === '/agent.update') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { id, status, descriptor, failureLog } = JSON.parse(body || '{}');
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
            const { withDb } = require('@thinkdrop/agents-db');
            await withDb(async (db) => {
              if (descriptor !== undefined) {
                await db.run('UPDATE agents SET descriptor = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?', descriptor, id);
              }
              if (status !== undefined) {
                const fl = failureLog !== undefined ? failureLog : null;
                await db.run('UPDATE agents SET status = ?, failure_log = ?, last_validated = CURRENT_TIMESTAMP WHERE id = ?', status, fl, id);
              }
            });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /agent.delete — delete all artifacts for an agent ─────────────
      if (req.method === 'POST' && req.url === '/agent.delete') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { id } = JSON.parse(body || '{}');
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
            const { actionDeleteAgent } = require('./skills/browser.agent.cjs');
            const result = await actionDeleteAgent({ id });
            res.writeHead(result.ok ? 200 : 500);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /agent.query — query a single agent by id ───────────────────────
      if (req.method === 'POST' && req.url === '/agent.query') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { id } = JSON.parse(body || '{}');
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'id required' })); return; }
            const { cliAgent } = require('./skills/cli.agent.cjs');
            const result = await cliAgent({ action: 'query_agent', id });
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, data: result }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /agent.migrate — migrate legacy .agent.md files to DuckDB ───────
      if (req.method === 'POST' && req.url === '/agent.migrate') {
        (async () => {
          try {
            const fsM = require('fs');
            const pathM = require('path');
            const osM = require('os');
            const { withDb } = require('@thinkdrop/agents-db');
            const agentsDir = pathM.join(osM.homedir(), '.thinkdrop', 'agents');
            if (!fsM.existsSync(agentsDir)) { res.writeHead(200); res.end(JSON.stringify({ ok: true, migrated: 0 })); return; }
            await withDb(async (db) => {
              const existingRows = await db.all("SELECT id FROM agents WHERE type = 'browser' OR type IS NULL");
              const existingIds = new Set(existingRows.map(r => r.id));
              const files = fsM.readdirSync(agentsDir).filter(f => f.endsWith('.agent.md'));
              let migrated = 0;
              for (const file of files) {
                const id = file.replace('.agent.md', '');
                if (existingIds.has(id)) continue;
                const content = fsM.readFileSync(pathM.join(agentsDir, file), 'utf8');
                const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
                const fm = fmMatch ? fmMatch[1] : '';
                const getField = (key) => { const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm')); return m ? m[1].trim() : undefined; };
                const service = getField('service') || id.replace('.agent', '');
                const status = getField('status') || 'pending';
                const capabilities = getField('capabilities') || '[]';
                try {
                  await db.run(
                    `INSERT OR REPLACE INTO agents (id, type, service, cli_tool, capabilities, descriptor, last_validated, status, created_at) VALUES (?, 'browser', ?, NULL, ?, ?, CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)`,
                    id, service, capabilities, content, status === 'healthy' ? 'learned' : status
                  );
                  migrated++;
                } catch (_) {}
              }
              res.writeHead(200);
              res.end(JSON.stringify({ ok: true, migrated }));
            });
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        })();
        return;
      }

      // ── POST /agent.build — build a browser agent (owns DuckDB lock here) ────
      if (req.method === 'POST' && req.url === '/agent.build') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { service, startUrl, goals, force } = JSON.parse(body || '{}');
            if (!service) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'service is required' })); return; }
            const { browserAgent } = require('./skills/browser.agent.cjs');
            const result = await browserAgent({ action: 'build_agent', service, startUrl, goals, force: !!force });
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      // ── POST /app.agent — desktop application automation via LiteParse ──────
      if (req.method === 'POST' && req.url === '/app.agent') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { action, ...args } = JSON.parse(body || '{}');
            if (!action) {
              res.writeHead(400);
              res.end(JSON.stringify({ ok: false, error: 'action is required' }));
              return;
            }

            logger.info(`[app.agent] Executing action: ${action}`);

            let result;
            switch (action) {
              case 'parse_screenshot':
                result = await appAgent.actionParseScreenshot(args);
                break;
              case 'find_elements':
                result = await appAgent.actionFindElements(args);
                break;
              case 'highlight_all':
                result = await appAgent.actionHighlightAll(args);
                break;
              case 'highlight_search':
                result = await appAgent.actionHighlightSearch(args);
                break;
              case 'highlight_boundaries':
                result = await appAgent.actionHighlightBoundaries(args);
                break;
              case 'highlight_assets':
                result = await appAgent.actionHighlightAssets(args);
                break;
              case 'clear_highlights':
                result = await appAgent.actionClearHighlights();
                break;
              case 'capture_screen':
                result = await appAgent.actionCaptureScreen();
                break;
              default:
                res.writeHead(400);
                res.end(JSON.stringify({ ok: false, error: `Unknown action: ${action}` }));
                return;
            }

            // Always return 200 for successful action execution, even if action returned an error result
            // The result.ok flag indicates business logic success/failure, not HTTP status
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            logger.error(`[app.agent] Error: ${err.message}`);
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    healthServer.listen(PORT, () => {
      logger.info(`Health endpoint listening on http://localhost:${PORT}/health`);
    });

    const shutdown = async (signal) => {
      logger.info(`${signal} received — shutting down`);
      try { const { closeDb } = require('@thinkdrop/agents-db'); await closeDb(); } catch (_) {}
      healthServer.close(() => process.exit(0));
    };

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('Command Service ready');
  }
}

// ---------------------------------------------------------------------------
// Ensure playwright-cli is installed (brew install playwright-cli)
// Runs async at startup — does not block the server from starting.
// ---------------------------------------------------------------------------
function ensurePlaywrightCli() {
  const { execFile } = require('child_process');
  const fs = require('fs');

  const CLI_CANDIDATES = [
    '/opt/homebrew/bin/playwright-cli',
    '/usr/local/bin/playwright-cli',
  ];

  const found = CLI_CANDIDATES.some(c => { try { fs.accessSync(c, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (found) {
    logger.info('[startup] playwright-cli already installed ✓');
    return;
  }

  logger.info('[startup] playwright-cli not found — installing via brew...');
  execFile('brew', ['install', 'playwright-cli'], { timeout: 120000 }, (err, stdout, stderr) => {
    if (err) {
      logger.warn('[startup] brew install playwright-cli failed — browser.act will degrade gracefully', { error: err.message });
    } else {
      logger.info('[startup] playwright-cli installed ✓');
    }
  });
}

/**
 * Seed OAuth client credentials from environment variables into the keychain.
 * Runs once on startup so skills can find client_id/client_secret without
 * requiring the user to complete a full OAuth connect flow first.
 * Never overwrites an existing value (preserves live access/refresh tokens).
 */
async function seedOAuthCredentials() {
  let keytar;
  try { keytar = require('keytar'); } catch (_) {
    logger.warn('[startup] keytar unavailable — skipping OAuth credential seeding');
    return;
  }

  const PROVIDERS = [
    'google', 'github', 'microsoft', 'facebook', 'twitter',
    'linkedin', 'slack', 'notion', 'spotify', 'dropbox',
    'discord', 'zoom', 'atlassian', 'salesforce', 'hubspot',
  ];

  for (const provider of PROVIDERS) {
    const prefix = provider.toUpperCase();
    const envClientId     = process.env[`${prefix}_CLIENT_ID`];
    const envClientSecret = process.env[`${prefix}_CLIENT_SECRET`];
    if (!envClientId && !envClientSecret) continue;

    const keychainKey = `oauth:${provider}`;
    let blob = {};
    try {
      const raw = await keytar.getPassword('thinkdrop', keychainKey);
      if (raw) blob = JSON.parse(raw);
    } catch (_) { /* start fresh */ }

    let changed = false;
    if (envClientId && !blob.client_id) {
      blob.client_id = envClientId;
      changed = true;
    }
    if (envClientSecret && !blob.client_secret) {
      blob.client_secret = envClientSecret;
      changed = true;
    }

    if (changed) {
      try {
        await keytar.setPassword('thinkdrop', keychainKey, JSON.stringify(blob));
        logger.info(`[startup] Seeded keychain oauth:${provider} from .env`);
      } catch (err) {
        logger.warn(`[startup] Failed to seed keychain oauth:${provider}`, { error: err.message });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Nuke stale playwright-cli sessions from a previous ThinkDrop run.
// No browser sessions should survive an app restart.
// ---------------------------------------------------------------------------
function cleanupStalePlaywrightSessions() {
  const { spawnSync } = require('child_process');
  const { findCli } = require('./skills/browser.act.cjs');
  try {
    const cli = findCli();
    const closeAll = spawnSync(cli, ['close-all'], { timeout: 10000, encoding: 'utf8' });
    if (closeAll.status === 0) logger.info('[startup] playwright-cli close-all ✓');
    const killAll = spawnSync(cli, ['kill-all'], { timeout: 10000, encoding: 'utf8' });
    if (killAll.status === 0) logger.info('[startup] playwright-cli kill-all ✓');
    // Kill orphaned Chrome processes that used ThinkDrop browser profiles.
    // close-all/kill-all only kills playwright-cli daemons, not the Chrome
    // instances they spawned. On macOS, a running Chrome from any profile
    // intercepts new launchPersistentContext calls and causes "Failed to launch".
    const pkillRes = spawnSync('pkill', ['-f', 'Google Chrome.*user-data-dir=.*\\.thinkdrop/browser-profiles'], { timeout: 5000, encoding: 'utf8' });
    if (pkillRes.status === 0) logger.info('[startup] killed orphaned Chrome browser-profile processes ✓');
  } catch (err) {
    logger.warn('[startup] playwright-cli session cleanup failed (non-fatal)', { error: err.message });
  }
}

// Start server if run directly
if (require.main === module) {
  ensurePlaywrightCli();
  cleanupStalePlaywrightSessions();
  seedOAuthCredentials().catch(err => logger.warn('[startup] seedOAuthCredentials failed', { error: err.message }));
  const server = new CommandServiceMCPServer();
  server.start().catch((error) => {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  });
}

module.exports = CommandServiceMCPServer;
