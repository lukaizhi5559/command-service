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
const GeminiOAuthClient = require('./GeminiOAuthClient.cjs');
const UsageTracker = require('./UsageTracker.cjs');
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
    
    this.geminiClient = new GeminiOAuthClient({
      model: process.env.GEMINI_MODEL,
      enabled: process.env.ENABLE_GEMINI !== 'false'
    });
    
    this.usageTracker = new UsageTracker({
      dailyLimit: parseInt(process.env.GEMINI_DAILY_LIMIT) || 1500
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
      geminiEnabled: this.geminiClient.enabled,
      geminiConfigured: this.geminiClient.isAvailable(),
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
            
            case 'gemini.oauth.start':
              response = await this.startGeminiOAuth();
              break;
            
            case 'gemini.oauth.revoke':
              response = await this.revokeGeminiOAuth();
              break;
            
            case 'gemini.status':
              response = await this.getGeminiStatus();
              break;
            
            case 'usage.status':
              response = await this.getUsageStatus();
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
   * Routing: Pattern Matching → Gemini → Ollama (fallback)
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
      let interpretation;
      let interpretationSource = 'unknown';
      
      // Step 1: Try pattern matching first (instant, no API calls)
      const os = context.os || process.platform;
      const patternMatch = this.ollamaClient._quickMatchCommand(command, os);
      
      if (patternMatch) {
        logger.info('Command matched via pattern', {
          naturalCommand: command,
          shellCommand: patternMatch
        });
        
        interpretation = {
          success: true,
          shellCommand: patternMatch
        };
        interpretationSource = 'pattern';
      }
      // Step 2: Try Gemini if available and not rate limited
      else if (this.geminiClient.isAvailable()) {
        const usageCheck = this.usageTracker.recordCall({
          command,
          timestamp: new Date().toISOString()
        });
        
        if (!usageCheck.allowed) {
          logger.warn('Gemini rate limit reached, falling back to Ollama', {
            count: usageCheck.count,
            limit: usageCheck.limit
          });
          
          // Fall through to Ollama
          interpretation = await this.ollamaClient.interpretCommand(command, context);
          interpretationSource = 'ollama-fallback';
        } else {
          logger.info('Attempting Gemini interpretation', {
            command,
            usage: `${usageCheck.count}/${usageCheck.limit}`
          });
          
          interpretation = await this.geminiClient.interpretCommand(command, os, context);
          
          if (interpretation.success) {
            interpretationSource = 'gemini';
            logger.info('Command interpreted by Gemini', {
              naturalCommand: command,
              shellCommand: interpretation.command,
              usage: `${usageCheck.count}/${usageCheck.limit}`
            });
            
            // Normalize response format
            interpretation.shellCommand = interpretation.command;
            
            // Warn user if approaching limit
            if (usageCheck.warning) {
              interpretation.usageWarning = usageCheck.warning;
            }
          } else {
            // Gemini failed, fall back to Ollama
            logger.warn('Gemini interpretation failed, falling back to Ollama', {
              error: interpretation.error
            });
            interpretation = await this.ollamaClient.interpretCommand(command, context);
            interpretationSource = 'ollama-fallback';
            
            // Add warning about Gemini failure
            interpretation.geminiWarning = {
              message: 'Gemini API failed. Using less reliable local model. Please check your Gemini connection in the MCP panel.',
              action: 'configure_gemini',
              severity: 'error',
              details: interpretation.error
            };
          }
        }
      }
      // Step 3: Fall back to Ollama (offline mode or Gemini not configured)
      else {
        logger.warn('Using Ollama for interpretation (Gemini not available) - results may be unreliable');
        interpretation = await this.ollamaClient.interpretCommand(command, context);
        interpretationSource = 'ollama';
        
        // Add warning about Gemini configuration
        interpretation.geminiWarning = {
          message: 'Command interpretation is using a less reliable local model. For better results, please connect to Gemini.',
          action: 'configure_gemini',
          severity: 'warning'
        };
      }
      
      if (!interpretation.success) {
        return {
          success: false,
          error: `Failed to interpret command: ${interpretation.error}`,
          originalCommand: command,
          interpretationSource
        };
      }
      
      const shellCommand = interpretation.shellCommand;
      
      // Step 4: Validate shell command
      const validation = this.validator.validate(shellCommand);
      
      if (!validation.isValid) {
        return {
          success: false,
          error: validation.error,
          originalCommand: command,
          interpretedCommand: shellCommand,
          riskLevel: validation.riskLevel,
          interpretationSource
        };
      }
      
      // Step 5: Check if confirmation is required (unless bypassed by user approval)
      const bypassConfirmation = context.bypassConfirmation === true;
      
      if (validation.requiresConfirmation && !bypassConfirmation) {
        logger.info('Command requires confirmation', {
          command: shellCommand,
          category: validation.category,
          riskLevel: validation.riskLevel
        });
        
        return {
          success: false,
          requiresConfirmation: true,
          message: 'This command requires user confirmation before execution',
          originalCommand: command,
          interpretedCommand: shellCommand,
          category: validation.category,
          riskLevel: validation.riskLevel,
          interpretationSource
        };
      }
      
      // Log if confirmation was bypassed
      if (bypassConfirmation && validation.requiresConfirmation) {
        logger.info('Command confirmation bypassed by user approval', {
          command: shellCommand,
          category: validation.category
        });
      }
      
      // Step 6: Execute command
      const execution = await this.executor.execute(shellCommand);
      
      if (!execution.success) {
        return {
          success: false,
          error: execution.error,
          originalCommand: command,
          executedCommand: shellCommand,
          interpretationSource
        };
      }
      
      // Step 7: Interpret output for concise summary (respecting privacy mode)
      let interpretedOutput = execution.output;
      let outputInterpretationSource = 'raw';
      
      // Only interpret if output is large (>500 chars)
      if (execution.output && execution.output.length > 500) {
        try {
          // Check if user is in online mode (passed in context)
          const useOnlineMode = payload.context?.useOnlineMode || false;
          
          // Smart truncation based on command type
          let truncatedOutput = execution.output;
          const maxLength = useOnlineMode ? 5000 : 2000; // Smaller for local Ollama
          
          if (execution.output.length > maxLength) {
            // For list-style outputs (ps, ls, etc), take first N lines + last few lines
            const lines = execution.output.split('\n');
            if (lines.length > 50) {
              const firstLines = lines.slice(0, 30).join('\n');
              const lastLines = lines.slice(-5).join('\n');
              truncatedOutput = `${firstLines}\n... (${lines.length - 35} more lines) ...\n${lastLines}`;
            } else {
              truncatedOutput = execution.output.substring(0, maxLength);
            }
          }
          
          const interpretationPrompt = `The user asked: "${command}"
The command executed was: ${shellCommand}
The output is:
${truncatedOutput}

Please provide a clear, concise answer to the user's question based on this output. Be specific and helpful. If there are multiple items, list the most relevant ones.`;

          if (useOnlineMode && this.geminiClient.isConfigured()) {
            // Online Mode: Use Gemini (cloud)
            const canUseGemini = await this.usageTracker.canMakeRequest();
            if (canUseGemini) {
              logger.info('Interpreting command output with Gemini (Online Mode)', {
                originalCommand: command,
                outputLength: execution.output.length
              });
              
              const interpretation = await this.geminiClient.generateContent(interpretationPrompt);
              await this.usageTracker.recordRequest();
              
              interpretedOutput = interpretation;
              outputInterpretationSource = 'gemini';
              
              logger.info('Output interpreted by Gemini', {
                originalLength: execution.output.length,
                interpretedLength: interpretation.length
              });
            }
          } else {
            // Private Mode: Use local Ollama (privacy-first)
            logger.info('Interpreting command output with Ollama (Private Mode)', {
              originalCommand: command,
              outputLength: execution.output.length
            });
            
            const interpretation = await this.ollamaClient.generateText(interpretationPrompt);
            interpretedOutput = interpretation;
            outputInterpretationSource = 'ollama';
            
            logger.info('Output interpreted by Ollama (private)', {
              originalLength: execution.output.length,
              interpretedLength: interpretation.length
            });
          }
        } catch (error) {
          logger.warn('Failed to interpret output, using raw output', {
            error: error.message
          });
        }
      }
      
      // Step 8: Return success with interpreted output
      const response = {
        success: true,
        output: interpretedOutput,
        rawOutput: execution.output.length > 1000 ? execution.output.substring(0, 1000) + '...(truncated)' : execution.output,
        originalCommand: command,
        executedCommand: shellCommand,
        category: validation.category,
        executionTime: execution.executionTime,
        interpretationSource,
        outputInterpretationSource
      };
      
      // Include usage warning if present
      if (interpretation.usageWarning) {
        response.usageWarning = interpretation.usageWarning;
      }
      
      // Include Gemini configuration warning if present
      if (interpretation.geminiWarning) {
        response.geminiWarning = interpretation.geminiWarning;
      }
      
      return response;
      
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
   * Start Gemini OAuth flow
   */
  async startGeminiOAuth() {
    try {
      logger.info('Starting Gemini OAuth flow');
      const result = await this.geminiClient.startOAuthFlow();
      
      if (result.success) {
        // Test the connection
        const testResult = await this.geminiClient.testConnection();
        
        if (testResult.success) {
          logger.info('Gemini OAuth completed and tested successfully');
          return {
            success: true,
            message: 'Successfully authenticated with Google Gemini',
            status: this.geminiClient.getStatus()
          };
        } else {
          return {
            success: false,
            error: `OAuth succeeded but connection test failed: ${testResult.error}`
          };
        }
      } else {
        return result;
      }
      
    } catch (error) {
      logger.error('OAuth flow failed', { error: error.message });
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Revoke Gemini OAuth token
   */
  async revokeGeminiOAuth() {
    try {
      const result = await this.geminiClient.revokeToken();
      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get Gemini status
   */
  async getGeminiStatus() {
    try {
      const status = this.geminiClient.getStatus();
      const usageStatus = this.usageTracker.getStatus();
      
      return {
        success: true,
        gemini: status,
        usage: usageStatus
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Get usage status
   */
  async getUsageStatus() {
    try {
      const status = this.usageTracker.getStatus();
      
      return {
        success: true,
        ...status
      };
      
    } catch (error) {
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
      const ollamaHealthy = await this.ollamaClient.checkHealth();
      const usageStatus = this.usageTracker.getStatus();
      
      return {
        success: true,
        service: this.serviceName,
        status: 'healthy',
        ollama: {
          healthy: ollamaHealthy,
          host: this.ollamaClient.host,
          model: this.ollamaClient.model
        },
        gemini: {
          enabled: this.geminiClient.enabled,
          configured: this.geminiClient.isAvailable(),
          model: this.geminiClient.model
        },
        usage: usageStatus,
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
