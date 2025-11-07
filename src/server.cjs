/**
 * Command Service MCP Server
 * 
 * MCP service for natural language command execution using Ollama.
 * Handles command interpretation, validation, and safe execution.
 */

require('dotenv').config();
const readline = require('readline');
const OllamaClient = require('./OllamaClient.cjs');
const CommandValidator = require('./CommandValidator.cjs');
const CommandExecutor = require('./CommandExecutor.cjs');
const logger = require('./logger.cjs');

class CommandServiceMCPServer {
  constructor() {
    // Initialize components
    this.ollamaClient = new OllamaClient({
      host: process.env.OLLAMA_HOST,
      model: process.env.OLLAMA_MODEL
    });
    
    this.validator = new CommandValidator({
      allowedCategories: (process.env.ALLOWED_COMMAND_CATEGORIES || 'open_app,system_info,file_read').split(','),
      validationEnabled: process.env.ENABLE_COMMAND_VALIDATION !== 'false'
    });
    
    this.executor = new CommandExecutor({
      timeout: parseInt(process.env.COMMAND_TIMEOUT) || 30000,
      maxOutputLength: parseInt(process.env.MAX_OUTPUT_LENGTH) || 10000
    });
    
    this.serviceName = process.env.SERVICE_NAME || 'command-service';
    
    logger.info('CommandServiceMCPServer initialized', {
      serviceName: this.serviceName,
      ollamaModel: this.ollamaClient.model,
      allowedCategories: this.validator.allowedCategories
    });
  }
  
  /**
   * Handle incoming MCP request
   * @param {Object} request - MCP request { action, payload }
   * @returns {Promise<Object>} - MCP response
   */
  async handleRequest(request) {
    const { action, payload } = request;
    
    logger.info('Received MCP request', { action, payload });
    
    try {
      switch (action) {
        case 'command.execute':
          return await this.executeCommand(payload);
        
        case 'command.interpret':
          return await this.interpretCommand(payload);
        
        case 'system.query':
          return await this.systemQuery(payload);
        
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
   * Execute a natural language command
   * @param {Object} payload - { command, context }
   */
  async executeCommand(payload) {
    const { command, context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      // Step 1: Interpret natural language to shell command
      const interpretation = await this.ollamaClient.interpretCommand(command, context);
      
      if (!interpretation.success) {
        return {
          success: false,
          error: `Failed to interpret command: ${interpretation.error}`,
          originalCommand: command
        };
      }
      
      const shellCommand = interpretation.shellCommand;
      
      // Step 2: Validate shell command
      const validation = this.validator.validate(shellCommand);
      
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
          originalCommand: command,
          interpretedCommand: shellCommand,
          riskLevel: validation.riskLevel
        };
      }
      
      // Step 3: Check if confirmation is required
      if (validation.requiresConfirmation) {
        return {
          success: false,
          requiresConfirmation: true,
          message: 'This command requires user confirmation before execution',
          originalCommand: command,
          interpretedCommand: shellCommand,
          category: validation.category,
          riskLevel: validation.riskLevel
        };
      }
      
      // Step 4: Execute command
      const execution = await this.executor.executeWithInterpretation(
        shellCommand,
        command
      );
      
      if (!execution.success) {
        return {
          success: false,
          error: execution.error,
          interpretation: execution.interpretation,
          originalCommand: command,
          executedCommand: shellCommand
        };
      }
      
      // Step 5: Return success
      return {
        success: true,
        result: execution.interpretation || execution.output,
        output: execution.output,
        originalCommand: command,
        executedCommand: shellCommand,
        category: validation.category,
        executionTime: execution.executionTime
      };
      
    } catch (error) {
      logger.error('Error executing command', {
        command,
        error: error.message
      });
      
      return {
        success: false,
        error: error.message,
        originalCommand: command
      };
    }
  }
  
  /**
   * Interpret command without executing
   * @param {Object} payload - { command, context }
   */
  async interpretCommand(payload) {
    const { command, context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      const interpretation = await this.ollamaClient.interpretCommand(command, context);
      
      if (!interpretation.success) {
        return interpretation;
      }
      
      const validation = this.validator.validate(interpretation.shellCommand);
      
      return {
        success: true,
        originalCommand: command,
        shellCommand: interpretation.shellCommand,
        isValid: validation.isValid,
        category: validation.category,
        riskLevel: validation.riskLevel,
        requiresConfirmation: validation.requiresConfirmation,
        validationError: validation.error
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        originalCommand: command
      };
    }
  }
  
  /**
   * Query system information
   * @param {Object} payload - { query }
   */
  async systemQuery(payload) {
    const { query } = payload;
    
    if (!query) {
      return {
        success: false,
        error: 'Query is required'
      };
    }
    
    try {
      const result = await this.ollamaClient.querySystem(query);
      return result;
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        query
      };
    }
  }
  
  /**
   * Health check
   */
  async healthCheck() {
    try {
      const ollamaHealthy = await this.ollamaClient.checkHealth();
      
      return {
        success: true,
        service: this.serviceName,
        status: 'healthy',
        ollama: {
          healthy: ollamaHealthy,
          host: this.ollamaClient.host,
          model: this.ollamaClient.model
        },
        validator: {
          enabled: this.validator.validationEnabled,
          allowedCategories: this.validator.allowedCategories
        }
      };
      
    } catch (error) {
      return {
        success: false,
        service: this.serviceName,
        status: 'unhealthy',
        error: error.message
      };
    }
  }
  
  /**
   * Start stdio server (MCP protocol)
   */
  async start() {
    logger.info('Starting MCP server in stdio mode');
    
    // Check Ollama health on startup
    const healthy = await this.ollamaClient.checkHealth();
    if (!healthy) {
      logger.warn('Ollama health check failed - service may not work correctly');
      logger.warn(`Make sure Ollama is running and model ${this.ollamaClient.model} is available`);
    }
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
    
    rl.on('line', async (line) => {
      try {
        const request = JSON.parse(line);
        const response = await this.handleRequest(request);
        
        // Send response as JSON
        console.log(JSON.stringify(response));
        
      } catch (error) {
        logger.error('Error processing line', { error: error.message, line });
        
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
    
    // Handle process signals
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down');
      rl.close();
    });
    
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down');
      rl.close();
    });
    
    logger.info('MCP server ready and listening on stdin');
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
