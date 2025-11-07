/**
 * Command Service HTTP Server
 * 
 * HTTP wrapper for the Command MCP service to match ThinkDrop AI's architecture.
 * Provides REST API endpoints for command execution.
 */

require('dotenv').config();
const http = require('http');
const url = require('url');
const OllamaClient = require('./OllamaClient.cjs');
const CommandValidator = require('./CommandValidator.cjs');
const CommandExecutor = require('./CommandExecutor.cjs');
const logger = require('./logger.cjs');

class CommandHTTPServer {
  constructor() {
    this.port = parseInt(process.env.SERVICE_PORT) || 3007;
    this.host = process.env.SERVICE_HOST || 'localhost';
    
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
      maxOutputLength: parseInt(process.env.MAX_OUTPUT_LENGTH) || 10000,
      ollamaClient: this.ollamaClient,  // Pass OllamaClient for AI interpretation
      useAIInterpretation: process.env.USE_AI_INTERPRETATION !== 'false'  // Default to true
    });
    
    this.serviceName = process.env.SERVICE_NAME || 'command-service';
    this.apiKey = process.env.MCP_COMMAND_API_KEY || 'auto-generated-key-command';
    
    logger.info('CommandHTTPServer initialized', {
      serviceName: this.serviceName,
      port: this.port,
      host: this.host,
      ollamaModel: this.ollamaClient.model,
      allowedCategories: this.validator.allowedCategories
    });
  }
  
  /**
   * Handle incoming HTTP request
   */
  async handleRequest(req, res) {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Service-Name, X-Request-ID');
    
    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // Parse URL
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // Check API key
    const authHeader = req.headers['authorization'];
    if (authHeader !== this.apiKey) {
      logger.warn('Unauthorized request', { authHeader });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return;
    }
    
    // Route to action handler
    try {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const mcpRequest = JSON.parse(body);
          const { action, payload } = mcpRequest;
          
          logger.info('Received HTTP request', { 
            action, 
            pathname,
            requestId: req.headers['x-request-id']
          });
          
          let response;
          
          // Route based on action or pathname
          const actionName = action || pathname.substring(1); // Remove leading /
          
          switch (actionName) {
            case 'command.execute':
              response = await this.executeCommand(payload);
              break;
            
            case 'command.interpret':
              response = await this.interpretCommand(payload);
              break;
            
            case 'system.query':
              response = await this.systemQuery(payload);
              break;
            
            case 'health':
              response = await this.healthCheck();
              break;
            
            default:
              response = {
                success: false,
                error: `Unknown action: ${actionName}`
              };
          }
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          
        } catch (error) {
          logger.error('Error processing request', {
            error: error.message,
            stack: error.stack
          });
          
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: error.message
          }));
        }
      });
      
    } catch (error) {
      logger.error('Error handling request', {
        error: error.message,
        stack: error.stack
      });
      
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: error.message
      }));
    }
  }
  
  /**
   * Execute a natural language command
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
      
      // Step 4: Execute command (raw output only, no interpretation)
      const execution = await this.executor.execute(shellCommand);
      
      if (!execution.success) {
        return {
          success: false,
          error: execution.error,
          originalCommand: command,
          executedCommand: shellCommand
        };
      }
      
      // Step 5: Return success with raw output (answer node will interpret)
      return {
        success: true,
        output: execution.output, // Raw output for answer node to interpret
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
   * Start HTTP server
   */
  async start() {
    // Check Ollama health on startup
    const healthy = await this.ollamaClient.checkHealth();
    if (!healthy) {
      logger.warn('Ollama health check failed - service may not work correctly');
      logger.warn(`Make sure Ollama is running and model ${this.ollamaClient.model} is available`);
    }
    
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });
    
    server.listen(this.port, this.host, () => {
      logger.info(`Command Service HTTP server listening`, {
        host: this.host,
        port: this.port,
        url: `http://${this.host}:${this.port}`
      });
      console.log(`✅ Command Service running at http://${this.host}:${this.port}`);
    });
    
    // Handle process signals
    process.on('SIGINT', () => {
      logger.info('Received SIGINT, shutting down');
      server.close(() => {
        process.exit(0);
      });
    });
    
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down');
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

// Start server if run directly
if (require.main === module) {
  const server = new CommandHTTPServer();
  server.start().catch((error) => {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  });
}

module.exports = CommandHTTPServer;
