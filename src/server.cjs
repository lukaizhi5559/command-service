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
const readline = require('readline');
const logger = require('./logger.cjs');

class CommandServiceMCPServer {
  constructor() {
    this.serviceName = process.env.SERVICE_NAME || 'command-service';

    logger.info('CommandServiceMCPServer initialized', {
      serviceName: this.serviceName
    });
  }

  /**
   * Handle incoming MCP request
   * @param {Object} request - MCP request { action, payload }
   * @returns {Promise<Object>} - MCP response
   */
  async handleRequest(request) {
    const { action, payload } = request;

    logger.info('Received MCP request', { action });

    try {
      switch (action) {
        case 'command.automate':
          return await this.executeAutomation(payload);

        case 'health':
          return await this.healthCheck();

        default:
          return {
            success: false,
            error: `Unknown action: ${action}`
          };
      }
    } catch (error) {
      logger.error('Error handling request', {
        action,
        error: error.message,
        stack: error.stack
      });

      return {
        success: false,
        error: error.message
      };
    }
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
    // TODO: implement in skills/shell.run.cjs
    return { success: false, error: 'shell.run not yet implemented' };
  }

  async _skillBrowserAct(args) {
    // TODO: implement in skills/browser.act.cjs (Playwright)
    return { success: false, error: 'browser.act not yet implemented' };
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

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      try {
        const request = JSON.parse(line);
        const response = await this.handleRequest(request);
        console.log(JSON.stringify(response));
      } catch (error) {
        logger.error('Error processing line', { error: error.message });
        console.log(JSON.stringify({
          success: false,
          error: 'Invalid request format'
        }));
      }
    });

    rl.on('close', () => {
      logger.info('MCP server stopped');
      process.exit(0);
    });

    process.on('SIGINT', () => { logger.info('SIGINT received'); rl.close(); });
    process.on('SIGTERM', () => { logger.info('SIGTERM received'); rl.close(); });

    logger.info('Command Service MCP ready — listening on stdin');
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
