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

  async _skillFileBridge(args) {
    return await fileBridge(args);
  }

  async _skillExternal(args) {
    return await externalSkillRun(args);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck() {
    return {
      success: true,
      service: this.serviceName,
      status: 'healthy',
      skills: ['shell.run', 'browser.act', 'ui.axClick', 'ui.findAndClick', 'ui.moveMouse', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.screen.verify', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'external.skill']
    };
  }

  // ---------------------------------------------------------------------------
  // stdio transport (MCP protocol)
  // ---------------------------------------------------------------------------

  async start() {
    logger.info('Starting Command Service MCP server (stdio)');

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
          skills: ['shell.run', 'browser.act', 'ui.axClick', 'ui.findAndClick', 'ui.moveMouse', 'ui.click', 'ui.typeText', 'ui.waitFor', 'ui.screen.verify', 'image.analyze', 'fs.read', 'file.watch', 'file.bridge', 'external.skill']
        }));
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

// Start server if run directly
if (require.main === module) {
  const server = new CommandServiceMCPServer();
  server.start().catch((error) => {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  });
}

module.exports = CommandServiceMCPServer;
