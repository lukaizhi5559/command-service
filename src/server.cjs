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
   *   skill: 'shell.run' | 'browser.act' | 'ui.findAndClick' | 'ui.typeText' | 'ui.waitFor'
   *   args:  skill-specific arguments (see skills/ implementations)
   */
  async executeAutomation(payload) {
    const { skill, args = {} } = payload || {};

    if (!skill) {
      return {
        success: false,
        error: 'skill is required (shell.run | browser.act | ui.findAndClick | ui.typeText | ui.waitFor)'
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
    // TODO: implement in skills/ui.findAndClick.cjs (nut.js + OmniParser)
    return { success: false, error: 'ui.findAndClick not yet implemented' };
  }

  async _skillTypeText(args) {
    // TODO: implement in skills/ui.typeText.cjs (nut.js, token-aware)
    return { success: false, error: 'ui.typeText not yet implemented' };
  }

  async _skillWaitFor(args) {
    // TODO: implement in skills/ui.waitFor.cjs (polls /memory.getRecentOcr)
    return { success: false, error: 'ui.waitFor not yet implemented' };
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck() {
    return {
      success: true,
      service: this.serviceName,
      status: 'healthy',
      skills: ['shell.run', 'browser.act', 'ui.findAndClick', 'ui.typeText', 'ui.waitFor']
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
          skills: ['shell.run', 'browser.act', 'ui.findAndClick', 'ui.typeText', 'ui.waitFor']
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
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: err.message }));
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
