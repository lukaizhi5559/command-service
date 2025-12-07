/**
 * Command Service MCP Server
 * 
 * MCP service for natural language command execution using fast pattern matching + embeddings.
 * Handles command interpretation, validation, and safe execution.
 */

require('dotenv').config();
const readline = require('readline');
const CommandInterpreter = require('./CommandInterpreter.cjs');
const EmbeddingClient = require('./EmbeddingClient.cjs');
const CommandValidator = require('./CommandValidator.cjs');
const CommandExecutor = require('./CommandExecutor.cjs');
const NutjsAutomationHandler = require('./NutjsAutomationHandler.cjs');
const logger = require('./logger.cjs');

class CommandServiceMCPServer {
  constructor() {
    // Initialize components
    this.embeddingClient = new EmbeddingClient(
      process.env.PHI4_SERVICE_URL || 'http://localhost:3002'
    );
    
    this.interpreter = new CommandInterpreter({
      platform: process.platform === 'win32' ? 'windows' : 'mac',
      generateEmbedding: (text) => this.embeddingClient.generateEmbedding(text),
      similarityThreshold: 0.75
    });
    
    this.validator = new CommandValidator({
      allowedCategories: (process.env.ALLOWED_COMMAND_CATEGORIES || 'open_app,system_info,file_read').split(','),
      validationEnabled: process.env.ENABLE_COMMAND_VALIDATION !== 'false'
    });
    
    this.executor = new CommandExecutor({
      timeout: parseInt(process.env.COMMAND_TIMEOUT) || 30000,
      maxOutputLength: parseInt(process.env.MAX_OUTPUT_LENGTH) || 10000
    });
    
    this.nutjsHandler = new NutjsAutomationHandler();
    
    this.serviceName = process.env.SERVICE_NAME || 'command-service';
    
    logger.info('CommandServiceMCPServer initialized', {
      serviceName: this.serviceName,
      interpreter: 'Pattern Matching + HuggingFace Embeddings',
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
        
        case 'command.automate':
          return await this.executeAutomation(payload);
        
        case 'command.prompt-anywhere':
          return await this.handlePromptAnywhere(payload);
        
        case 'command.guide':
          return await this.executeGuide(payload);
        
        case 'command.guide.execute':
          return await this.executeGuideSteps(payload);
        
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
      // Step 1: Interpret natural language to shell command (FAST: 10-300ms)
      const interpretation = await this.interpreter.interpretCommand(command, context);
      
      if (!interpretation.success) {
        return {
          success: false,
          error: `Failed to interpret command: ${interpretation.error}`,
          originalCommand: command,
          confidence: interpretation.confidence
        };
      }
      
      const shellCommand = interpretation.shellCommand;
      
      logger.debug(`Command interpreted via ${interpretation.method}`, {
        originalCommand: command,
        shellCommand,
        confidence: interpretation.confidence,
        category: interpretation.category
      });
      
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
      const interpretation = await this.interpreter.interpretCommand(command, context);
      
      if (!interpretation.success) {
        return interpretation;
      }
      
      const validation = this.validator.validate(interpretation.shellCommand);
      
      return {
        success: true,
        originalCommand: command,
        shellCommand: interpretation.shellCommand,
        method: interpretation.method,
        confidence: interpretation.confidence,
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
      // Use interpreter to convert query to shell command
      const interpretation = await this.interpreter.interpretCommand(query);
      
      if (!interpretation.success) {
        return {
          success: false,
          error: `Failed to interpret query: ${interpretation.error}`,
          query
        };
      }
      
      // Execute the interpreted command
      const execution = await this.executor.execute(interpretation.shellCommand);
      
      return {
        success: execution.success,
        result: execution.output,
        shellCommand: interpretation.shellCommand,
        method: interpretation.method,
        query
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message,
        query
      };
    }
  }
  
  /**
   * Execute desktop automation via Nut.js API
   * @param {Object} payload - { command, context }
   */
  async executeAutomation(payload) {
    const { command, context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      logger.info('Executing desktop automation', { command, context });
      
      // Call Nut.js automation handler
      const result = await this.nutjsHandler.handleAutomationCommand(command);
      
      if (!result.success) {
        logger.warn('Desktop automation failed', {
          command,
          error: result.error
        });
        
        return {
          success: false,
          error: result.error,
          originalCommand: command,
          requiresService: result.requiresService,
          provider: result.provider
        };
      }
      
      logger.info('Desktop automation completed', {
        command,
        provider: result.metadata?.provider,
        totalTime: result.metadata?.totalTime
      });
      
      return {
        success: true,
        result: result.result,
        originalCommand: command,
        metadata: result.metadata
      };
      
    } catch (error) {
      logger.error('Error executing automation', {
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
   * Execute educational guide mode
   * @param {Object} payload - { command, context }
   */
  async executeGuide(payload) {
    const { command, context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      logger.info('Generating educational guide', { command, context });
      
      // Call the guide API endpoint
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('http://localhost:4000/api/nutjs/guide', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.BACKEND_API_KEY || ''
        },
        body: JSON.stringify({
          command,
          context: {
            os: context.os || process.platform,
            userId: context.userId,
            failedStep: context.failedStep,
            failureType: context.failureType,
            error: context.error
          }
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.warn('Guide API request failed', {
          command,
          status: response.status,
          error: errorText
        });
        
        return {
          success: false,
          error: `Guide API error: ${response.statusText}`,
          originalCommand: command
        };
      }
      
      const data = await response.json();
      
      if (!data.success) {
        logger.warn('Guide generation failed', {
          command,
          error: data.error
        });
        
        return {
          success: false,
          error: data.error || 'Guide generation failed',
          originalCommand: command
        };
      }
      
      logger.info('Guide generated successfully', {
        command,
        provider: data.provider,
        totalSteps: data.guide.totalSteps,
        latency: data.latencyMs
      });
      
      return {
        success: true,
        guide: data.guide,
        provider: data.provider,
        latencyMs: data.latencyMs,
        originalCommand: command
      };
      
    } catch (error) {
      logger.error('Error generating guide', {
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
   * Handle "Prompted Anywhere" command
   * Captures text + screenshot from any app, generates and executes response
   * @param {Object} payload - { text, screenshot, context }
   */
  async handlePromptAnywhere(payload) {
    const { text, screenshot, context = {} } = payload;
    
    try {
      logger.info('Handling Prompted Anywhere request', {
        hasText: !!text,
        hasScreenshot: !!screenshot,
        textLength: text?.length || 0
      });
      
      // Step 1: Determine the command
      let command;
      if (text && text.trim()) {
        // User highlighted text - use it as the prompt
        command = text.trim();
        logger.info('Using highlighted text as command', { 
          command: command.substring(0, 100) + (command.length > 100 ? '...' : '')
        });
      } else {
        // No highlighted text - use default with screenshot context
        command = 'Answer the question or provide helpful information based on what you see on screen';
        logger.info('Using default command with screenshot analysis');
      }
      
      // Step 2: Call backend with vision support
      const result = await this.generatePromptAnywhereCode(command, screenshot, context);
      
      if (!result.success) {
        return {
          success: false,
          error: result.error,
          command
        };
      }
      
      // Step 3: Execute the generated code (which will type the response)
      const execution = await this.executor.execute(result.code);
      
      if (!execution.success) {
        return {
          success: false,
          error: `Failed to execute automation: ${execution.error}`,
          generatedCode: result.code
        };
      }
      
      // Step 4: Return success
      logger.info('Prompted Anywhere completed successfully', {
        command: command.substring(0, 50) + '...',
        executionTime: execution.executionTime
      });
      
      return {
        success: true,
        result: 'Response typed successfully',
        metadata: {
          command,
          usedVision: result.usedVision,
          provider: result.provider,
          latencyMs: result.latencyMs,
          executionTime: execution.executionTime
        }
      };
      
    } catch (error) {
      logger.error('Prompted Anywhere failed', {
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Generate code for Prompted Anywhere
   * @param {string} command - User command or highlighted text
   * @param {string} screenshot - Base64 screenshot
   * @param {Object} context - Additional context
   */
  async generatePromptAnywhereCode(command, screenshot, context) {
    try {
      const fetch = (await import('node-fetch')).default;
      
      const requestBody = {
        command,
        context: {
          mode: 'prompt-anywhere',
          os: context.os || process.platform,
          timestamp: Date.now()
        }
      };
      
      // Add screenshot if available
      if (screenshot) {
        requestBody.screenshot = {
          base64: screenshot,
          mimeType: 'image/png'
        };
      }
      
      logger.info('Calling backend for Prompted Anywhere code generation', {
        command: command.substring(0, 50) + '...',
        hasScreenshot: !!screenshot
      });
      
      const response = await fetch(process.env.NUTJS_API_URL || 'http://localhost:4000/api/nutjs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.THINKDROP_API_KEY || process.env.BACKEND_API_KEY
        },
        body: JSON.stringify(requestBody),
        timeout: 60000 // 60 seconds
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Backend error: ${response.statusText} - ${errorText}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Backend returned unsuccessful response');
      }
      
      logger.info('Code generated successfully', {
        provider: data.provider,
        usedVision: data.usedVision,
        latencyMs: data.latencyMs,
        codeLength: data.code.length
      });
      
      return {
        success: true,
        code: data.code,
        provider: data.provider,
        usedVision: data.usedVision,
        latencyMs: data.latencyMs
      };
      
    } catch (error) {
      logger.error('Failed to generate Prompted Anywhere code', {
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Health check
   */
  async healthCheck() {
    try {
      const nutjsHealthy = await this.nutjsHandler.healthCheck();
      
      // Test embedding service connectivity
      let embeddingHealthy = false;
      try {
        await this.embeddingClient.generateEmbedding('test');
        embeddingHealthy = true;
      } catch (error) {
        logger.warn('Embedding service health check failed:', error.message);
      }
      
      return {
        success: true,
        service: this.serviceName,
        status: 'healthy',
        interpreter: {
          type: 'Pattern Matching + HuggingFace Embeddings',
          platform: this.interpreter.platform,
          embeddingService: embeddingHealthy ? 'healthy' : 'unhealthy',
          similarityThreshold: this.interpreter.similarityThreshold
        },
        nutjs: {
          healthy: nutjsHealthy,
          apiUrl: this.nutjsHandler.apiBaseUrl,
          hasApiKey: !!this.nutjsHandler.apiKey
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
    
    // Check embedding service health on startup
    try {
      await this.embeddingClient.generateEmbedding('test');
      logger.info('✅ Embedding service is healthy');
    } catch (error) {
      logger.warn('⚠️  Embedding service health check failed - pattern matching will still work, but semantic matching may fail');
      logger.warn(`Make sure Phi4 service is running at ${this.embeddingClient.phi4ServiceUrl}`);
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
