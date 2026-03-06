/**
 * Command Service MCP Server
 *
 * Actuation-only MCP service. Owns all "can touch the machine" skills:
 *   - command.automate  → skill router (shell.run, browser.act, ui.findAndClick, ui.typeText, ui.waitFor)
 *   - health            → service health check
 *
 * Perception, planning, memory, and intent resolution live in other services.
 */

require('dotenv').config();
const http = require('http');
const logger = require('./logger.cjs');
const { shellRun } = require('./skills/shell.run.cjs');
const { browserAct } = require('./skills/browser.act.cjs');
const { uiWaitFor } = require('./skills/ui.waitFor.cjs');
const { uiFindAndClick } = require('./skills/ui.findAndClick.cjs');
const { uiTypeText } = require('./skills/ui.typeText.cjs');
const { uiScreenVerify } = require('./skills/ui.screen.verify.cjs');
const { imageAnalyze } = require('./skills/image.analyze.cjs');
const { uiMoveMouse } = require('./skills/ui.moveMouse.cjs');
const { uiClick } = require('./skills/ui.click.cjs');
const { uiAxClick } = require('./skills/ui.axClick.cjs');
const { fsRead } = require('./skills/fs.read.cjs');
const { fileWatch } = require('./skills/file.watch.cjs');
const { fileBridge } = require('./skills/file.bridge.cjs');
const { run: externalSkillRun } = require('./skills/external.skill.cjs');
const { cliAgent } = require('./skills/cli.agent.cjs');
const { browserAgent } = require('./skills/browser.agent.cjs');
const creatorAgent = require('./skills/creator.agent.cjs');
const reviewerAgent = require('./skills/reviewer.agent.cjs');
const skillCreator = require('./skills/skillCreator.skill.cjs');
const { screenCapture } = require('./skills/screen.capture.cjs');
const skillScheduler = require('./skill-scheduler.cjs');

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
   *   skill: 'shell.run' | 'browser.act' | 'ui.findAndClick' | 'ui.typeText' | 'ui.waitFor' | 'fs.read' | 'file.watch'
   *   args:  skill-specific arguments (see skills/ implementations)
   */
  async executeAutomation(payload) {
    const { skill, args = {} } = payload || {};

    if (!skill) {
      return {
        success: false,
        error: 'skill is required (shell.run | browser.act | ui.findAndClick | ui.typeText | ui.waitFor | ui.screen.verify)'
      };
    }

    logger.info('Routing automation skill', { skill });

    switch (skill) {
      case 'shell.run':
        return await this._skillShellRun(args);

      case 'browser.act':
        return await this._skillBrowserAct(args);

      case 'ui.findAndClick':
        return await this._skillFindAndClick(args);

      case 'ui.typeText':
        return await this._skillTypeText(args);

      case 'ui.waitFor':
        return await this._skillWaitFor(args);

      case 'ui.screen.verify':
        return await this._skillScreenVerify(args);

      case 'image.analyze':
        return await this._skillImageAnalyze(args);

      case 'ui.moveMouse':
        return await this._skillMoveMouse(args);

      case 'ui.click':
        return await this._skillClick(args);

      case 'ui.axClick':
        return await this._skillAxClick(args);

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

      case 'creator.agent':
        return await this._skillCreatorAgent(args);

      case 'reviewer.agent':
        return await this._skillReviewerAgent(args);

      case 'skillCreator.skill':
        return await this._skillCreator(args);

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

  async _skillFindAndClick(args) {
    return await uiFindAndClick(args);
  }

  async _skillTypeText(args) {
    return await uiTypeText(args);
  }

  async _skillWaitFor(args) {
    return await uiWaitFor(args);
  }

  async _skillScreenVerify(args) {
    return await uiScreenVerify(args);
  }

  async _skillImageAnalyze(args) {
    return await imageAnalyze(args);
  }

  async _skillMoveMouse(args) {
    return await uiMoveMouse(args);
  }

  async _skillClick(args) {
    return await uiClick(args);
  }

  async _skillAxClick(args) {
    return await uiAxClick(args);
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

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck() {
    return {
      success: true,
      service: this.serviceName,
      status: 'healthy',
      skills: ['shell.run', 'browser.act', 'ui.axClick', 'ui.findAndClick', 'ui.moveMouse', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.screen.verify', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'external.skill', 'cli.agent', 'browser.agent', 'creator.agent', 'reviewer.agent']
    };
  }

  // ---------------------------------------------------------------------------
  // stdio transport (MCP protocol)
  // ---------------------------------------------------------------------------

  async start() {
    logger.info('Starting Command Service MCP server (stdio)');

    // ── Warm up creator.agent DB (ensures projects table exists) ────────────
    creatorAgent({ action: 'list_projects' }).catch(() => {});
    reviewerAgent({ action: 'status', projectId: '__warmup__' }).catch(() => {});

    // ── Start skill scheduler daemon ─────────────────────────────────────────
    // Reads installed skills from user-memory MCP, registers node-cron jobs
    // for any skill with a schedule ≠ on_demand. Re-syncs every 5 min.
    skillScheduler.start().catch(err => logger.warn('[Server] Skill scheduler start failed', { error: err.message }));

    // ── Minimal HTTP health server ───────────────────────────────────────────
    // Keeps the Node.js event loop alive (no active I/O = process exits) and
    // satisfies the service manager's health check at http://localhost:3007/health
    const PORT = parseInt(process.env.PORT || '3007', 10);
    const healthServer = http.createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/health' || req.url === '/service.health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          service: this.serviceName,
          skills: ['shell.run', 'browser.act', 'ui.axClick', 'ui.findAndClick', 'ui.moveMouse', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.screen.verify', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'external.skill', 'cli.agent', 'browser.agent', 'screen.capture']
        }));
        return;
      }

      // ── POST /skill.schedule — register/refresh a skill's cron immediately ──
      // Called by skillCreator after writing a new scheduled skill.
      if (req.method === 'POST' && req.url === '/skill.schedule') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { skillName, schedule, execPath } = JSON.parse(body || '{}');
            await skillScheduler.registerSkill(skillName, schedule, execPath);
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

      // ── POST /skill.schedule/sync — force immediate re-sync from user-memory ──
      if (req.method === 'POST' && req.url === '/skill.schedule/sync') {
        skillScheduler.sync().catch(() => {});
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
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

      if (req.method === 'POST' && req.url === '/command.automate') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { payload } = JSON.parse(body);
            const result = await this.executeAutomation(payload);
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

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });
    healthServer.listen(PORT, () => {
      logger.info(`Health endpoint listening on http://localhost:${PORT}/health`);
    });

    const shutdown = (signal) => {
      logger.info(`${signal} received — shutting down`);
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

// Start server if run directly
if (require.main === module) {
  ensurePlaywrightCli();
  const server = new CommandServiceMCPServer();
  server.start().catch((error) => {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  });
}

module.exports = CommandServiceMCPServer;
