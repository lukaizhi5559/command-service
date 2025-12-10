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
const NutjsAutomationHandler = require('./NutjsAutomationHandler.cjs');
const logger = require('./logger.cjs');
const modelSelector = require('./utils/model-selector');

// Smart model selection on startup
const modelSelection = modelSelector.selectBestModel(process.env.OLLAMA_MODEL);
process.env.OLLAMA_MODEL = modelSelection.model; // Override with selected model

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
    
    this.nutjsHandler = new NutjsAutomationHandler();
    
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
    
    // Check API key (support both raw key and Bearer token format)
    const authHeader = req.headers['authorization'];
    const providedKey = authHeader?.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : authHeader;
    
    if (providedKey !== this.apiKey) {
      logger.warn('Unauthorized request', { 
        authHeader: authHeader ? `${authHeader.substring(0, 10)}...` : 'missing',
        expectedKey: `${this.apiKey.substring(0, 10)}...`
      });
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
            
            case 'command.automate':
              // Deprecated: Use nutjs.plan instead
              response = await this.generateAutomationPlan(payload);
              break;
            
            case 'command.prompt-anywhere':
              response = await this.handlePromptAnywhere(payload);
              break;
            
            case 'command.cancel-automation':
              response = await this.handleCancelAutomation(payload);
              break;
            
            case 'command.guide':
              response = await this.executeGuide(payload);
              break;
            
            case 'command.guide.execute':
              response = await this.executeGuideSteps(payload);
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
            
            // Automation primitives
            case 'keyboard.type':
              response = await this.keyboardType(payload);
              break;
            
            case 'keyboard.hotkey':
              response = await this.keyboardHotkey(payload);
              break;
            
            case 'mouse.click':
              response = await this.mouseClick(payload);
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
        logger.info('OAuth completed successfully');
        
        // Generate Google Cloud API key for Vision, Maps, YouTube, etc.
        let apiKey = null;
        try {
          logger.info('Generating Google Cloud API key...');
          apiKey = await this.geminiClient.createGoogleCloudAPIKey();
          logger.info('Google Cloud API key generated successfully');
        } catch (apiKeyError) {
          logger.warn('Failed to generate Google Cloud API key', { error: apiKeyError.message });
          // Don't fail the whole OAuth flow if API key generation fails
        }
        
        return {
          success: true,
          message: 'Successfully authenticated with Google',
          status: this.geminiClient.getStatus(),
          apiKey: apiKey, // Include the generated API key
          tokens: this.geminiClient.oauth2Client?.credentials // Include OAuth tokens
        };
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
   * Execute desktop automation via Nut.js API
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
      
      // Call Nut.js automation handler with context
      const result = await this.nutjsHandler.handleAutomationCommand(command, context);
      
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
   * Generate automation plan (replaces executeAutomation)
   * Returns structured plan instead of executing immediately
   * Calls backend API at http://localhost:4000/api/nutjs/plan
   * @param {Object} payload - { command, intent, context }
   */
  async generateAutomationPlan(payload) {
    const { command, intent = 'command_automate', context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      logger.info('Generating automation plan via backend API', { command, intent });
      
      // Call backend API for plan generation
      const fetch = (await import('node-fetch')).default;
      const backendUrl = process.env.NUTJS_API_URL || 'http://localhost:4000/api/nutjs';
      const planEndpoint = backendUrl.replace('/api/nutjs', '/api/nutjs/plan');
      
      logger.info('Calling backend plan API', { endpoint: planEndpoint });
      
      const response = await fetch(planEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.BACKEND_API_KEY || process.env.THINKDROP_API_KEY
        },
        body: JSON.stringify({
          command,
          intent,
          context: {
            os: context.os || process.platform,
            userId: context.userId,
            sessionId: context.sessionId
          }
        }),
        timeout: 60000 // 60 seconds
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Backend plan API error', {
          status: response.status,
          statusText: response.statusText,
          error: errorText
        });
        
        // Check if backend is offline
        if (response.status === 0 || !response.status) {
          return {
            success: false,
            error: 'Backend automation service is offline. Please ensure the backend server is running at http://localhost:4000',
            requiresBackend: true
          };
        }
        
        return {
          success: false,
          error: `Backend API error: ${response.statusText} - ${errorText}`,
          originalCommand: command
        };
      }
      
      const data = await response.json();
      
      if (!data.success || !data.plan) {
        logger.error('Backend returned unsuccessful response', {
          success: data.success,
          error: data.error
        });
        
        return {
          success: false,
          error: data.error || 'Backend failed to generate plan',
          originalCommand: command
        };
      }
      
      logger.info('Automation plan generated successfully', {
        planId: data.plan.planId,
        stepCount: data.plan.steps?.length || 0,
        provider: data.plan.metadata?.provider
      });
      
      return {
        success: true,
        plan: data.plan
      };
      
    } catch (error) {
      logger.error('Error calling backend plan API', {
        command,
        error: error.message,
        stack: error.stack
      });
      
      // Check if it's a connection error (backend offline)
      if (error.code === 'ECONNREFUSED' || error.message.includes('ECONNREFUSED')) {
        return {
          success: false,
          error: 'Cannot connect to backend automation service. Please ensure the backend server is running at http://localhost:4000',
          requiresBackend: true,
          originalCommand: command
        };
      }
      
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
      const execution = await this.nutjsHandler.executeNutjsCode(result.code, command);
      
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
          timestamp: Date.now(),
          requestId: `pa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Unique ID to prevent caching
          typingStrategy: 'chunked', // Hint: Type in chunks with delays
          maxChunkSize: 200, // Hint: Max characters per chunk
          disableAutoCorrect: true, // Hint: Add Ctrl+Z workaround for autocorrect
          useCodeBlock: true, // Hint: For code, insert into code block if possible
          responseMode: 'type-only', // CRITICAL: Only generate typing automation, never click/navigate UI
          instruction: 'Generate NutJS code that ONLY types a helpful response. Do NOT use vision service or click any UI elements. Just type text using keyboard.type().'
        }
      };
      
      // Add screenshot if available
      if (screenshot) {
        requestBody.screenshot = {
          base64: screenshot,
          mimeType: 'image/png'
        };
      }
      
      // Log screenshot hash to verify it's changing (use middle section to avoid PNG header)
      const screenshotHash = screenshot ? screenshot.substring(100, 132) : 'none';
      
      logger.info('Calling backend for Prompted Anywhere code generation', {
        command: command.substring(0, 50) + '...',
        hasScreenshot: !!screenshot,
        screenshotHash: screenshotHash,
        screenshotSize: screenshot ? screenshot.length : 0,
        requestId: requestBody.context.requestId
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
      
      // Post-process code to add typing speed configuration
      let processedCode = this.addTypingDelayConfig(data.code);
      // let processedCode = data.code;
      
      return {
        success: true,
        code: processedCode,
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
   * Fetch educational guide (no execution)
   * @param {Object} payload - { command, context }
   */
  async executeGuide(payload) {
    const guideStateManager = require('./services/guideStateManager.cjs');
    const { command, context = {} } = payload;
    
    if (!command) {
      return {
        success: false,
        error: 'Command is required'
      };
    }
    
    try {
      logger.info('Fetching educational guide', { command, context });
      
      // Fetch guide from backend API
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
          error: `Guide API error: ${response.status} - ${errorText}`,
          originalCommand: command
        };
      }
      
      const data = await response.json();
      
      if (!data.success || !data.guide) {
        return {
          success: false,
          error: data.error || 'Failed to generate guide',
          originalCommand: command
        };
      }
      
      const guide = data.guide;
      const guideId = guide.id || `guide_${Date.now()}`;
      
      // Save guide state to persistence layer
      await guideStateManager.saveGuideState(guideId, guide, {
        command,
        currentStepIndex: 0,
        status: 'active'
      });
      
      logger.info('Educational guide fetched and saved', {
        guideId,
        command,
        totalSteps: guide.totalSteps,
        provider: data.provider
      });
      
      // Return guide data WITHOUT execution
      return {
        success: true,
        guideId,
        guide: guide,
        originalCommand: command,
        metadata: {
          provider: data.provider,
          generationTime: data.latencyMs
        }
      };
      
    } catch (error) {
      logger.error('Error fetching guide', {
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
   * Execute guide steps (triggered by "Do it for me")
   * @param {Object} payload - { guideId, fromStep, toStep, abort }
   */
  async executeGuideSteps(payload) {
    const guideStateManager = require('./services/guideStateManager.cjs');
    const { guideId, fromStep, toStep, abort = false } = payload;
    
    if (!guideId) {
      return {
        success: false,
        error: 'guideId is required'
      };
    }
    
    try {
      // Get guide state
      const state = await guideStateManager.getGuideState(guideId);
      if (!state) {
        return {
          success: false,
          error: `Guide not found: ${guideId}`
        };
      }

      // Handle abort
      if (abort) {
        await guideStateManager.updateGuideStatus(guideId, 'aborted');
        logger.info('Guide execution aborted', { guideId });
        return {
          success: true,
          aborted: true,
          guideId
        };
      }
      
      // Update status to executing
      await guideStateManager.updateGuideStatus(guideId, 'executing');
      
      logger.info('Starting guide execution in background', {
        guideId,
        fromStep: fromStep || state.currentStepIndex,
        toStep: toStep || state.guide.totalSteps - 1
      });
      
      // Get updated state before starting background execution
      const updatedState = await guideStateManager.getGuideState(guideId);
      
      // Start background execution AFTER we've prepared the response
      // Use setImmediate to ensure response is sent first
      setImmediate(() => {
        this.executeGuideInBackground(guideId, state).catch(error => {
          logger.error('Background guide execution failed', {
            guideId,
            error: error.message,
            stack: error.stack
          });
        });
      });
      
      // Return immediately with executing status
      return {
        success: true,
        guideId,
        status: 'executing',
        message: 'Guide execution started in background',
        state: updatedState
      };
      
    } catch (error) {
      logger.error('Error executing guide steps', {
        guideId,
        error: error.message
      });
      
      // Update state to reflect error
      try {
        await guideStateManager.updateGuideStatus(guideId, 'active', {
          lastError: error.message
        });
      } catch (stateError) {
        logger.error('Failed to update guide state after error', {
          guideId,
          error: stateError.message
        });
      }
      
      return {
        success: false,
        error: error.message,
        guideId
      };
    }
  }
  
  /**
   * Execute guide in background (async, non-blocking)
   * @param {string} guideId - Guide identifier
   * @param {Object} state - Guide state from state manager
   */
  async executeGuideInBackground(guideId, state) {
    const guideStateManager = require('./services/guideStateManager.cjs');
    
    try {
      logger.info('Background execution started', { guideId });
      
      // Execute guide via Nut.js handler
      const executionResult = await this.nutjsHandler.handleGuideCommand(
        state.guide,
        state.command
      );
      
      // Update state with execution result
      await guideStateManager.addExecutionResult(guideId, executionResult);
      
      if (executionResult.success) {
        await guideStateManager.updateGuideStatus(guideId, 'completed', {
          completedSteps: state.guide.totalSteps
        });
        
        logger.info('Background guide execution completed', {
          guideId,
          totalSteps: state.guide.totalSteps
        });
      } else {
        await guideStateManager.updateGuideStatus(guideId, 'active', {
          lastError: executionResult.error
        });
        
        logger.warn('Background guide execution failed', {
          guideId,
          error: executionResult.error
        });
      }
      
      return executionResult;
      
    } catch (error) {
      logger.error('Error in background guide execution', {
        guideId,
        error: error.message,
        stack: error.stack
      });
      
      // Update state to reflect error
      try {
        await guideStateManager.updateGuideStatus(guideId, 'active', {
          lastError: error.message
        });
      } catch (stateError) {
        logger.error('Failed to update guide state after background error', {
          guideId,
          error: stateError.message
        });
      }
      
      throw error;
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
        url: `http://${this.host}:${this.port}`,
        model: modelSelection.model,
        modelReason: modelSelection.reason
      });
      console.log(`✅ Command Service running at http://${this.host}:${this.port}`);
      console.log(`   🤖 Model: ${modelSelection.model} (${modelSelection.reason})`);
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
  
  /**
   * Cancel currently running automation
   * @param {Object} payload - Request payload
   * @returns {Promise<Object>} - Cancellation result
   */
  async handleCancelAutomation(payload) {
    try {
      logger.info('Cancelling automation');
      
      const cancelled = this.nutjsHandler.cancelCurrentAutomation();
      
      return {
        success: true,
        cancelled: cancelled,
        message: cancelled 
          ? 'Automation cancelled successfully' 
          : 'No automation was running'
      };
      
    } catch (error) {
      logger.error('Failed to cancel automation', {
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Add typing delay configuration to generated code
   * Prevents dropped characters when typing in web applications
   * @param {string} code - Generated NutJS code
   * @returns {string} - Code with typing delays added
   */
  addTypingDelayConfig(code) {
    // Check if code already has typing configuration
    if (code.includes('keyboard.config.autoDelayMs')) {
      return code;
    }
    
    // Add typing delay configuration after the require statement
    const configCode = `
// Configure typing speed for reliability (prevents dropped characters)
keyboard.config.autoDelayMs = 100; // 75ms delay between keystrokes
`;
    
    // Insert after the first require statement
    const requireMatch = code.match(/(const.*require\(['"]@nut-tree.*?\);)/);
    if (requireMatch) {
      const insertPos = code.indexOf(requireMatch[0]) + requireMatch[0].length;
      code = code.slice(0, insertPos) + '\n' + configCode + code.slice(insertPos);
      
      logger.info('Added typing delay configuration to generated code');
    }
    
    return code;
  }

  /**
   * Type text using keyboard
   * @param {Object} payload - { text, submit }
   * @returns {Promise<Object>} - Execution result
   */
  async keyboardType(payload) {
    const { text, submit = false } = payload;
    
    if (!text) {
      return {
        success: false,
        error: 'Text is required'
      };
    }
    
    try {
      logger.info('Typing text', { length: text.length, submit });
      
      // Import NutJS keyboard
      const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
      
      // Configure typing speed for reliability
      keyboard.config.autoDelayMs = 100;
      
      // Type the text
      await keyboard.type(text);
      
      // Press Enter if submit is true
      if (submit) {
        await keyboard.type(Key.Enter);
      }
      
      return {
        success: true,
        typed: text.length,
        submitted: submit
      };
      
    } catch (error) {
      logger.error('Failed to type text', {
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Press a hotkey combination
   * @param {Object} payload - { keys }
   * @returns {Promise<Object>} - Execution result
   */
  async keyboardHotkey(payload) {
    const { keys } = payload;
    
    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return {
        success: false,
        error: 'Keys array is required'
      };
    }
    
    try {
      logger.info('Pressing hotkey', { keys });
      
      // Import NutJS keyboard and Key
      const { keyboard, Key } = await import('@nut-tree-fork/nut-js');
      
      // Map key names to Key constants
      const keyObjects = keys.map(keyName => {
        // Handle special keys
        const normalizedKey = keyName.charAt(0).toUpperCase() + keyName.slice(1).toLowerCase();
        
        // Check if it's a special key
        if (Key[normalizedKey]) {
          return Key[normalizedKey];
        }
        
        // Otherwise, treat as a regular character
        return keyName;
      });
      
      // Press the hotkey combination
      await keyboard.pressKey(...keyObjects);
      await keyboard.releaseKey(...keyObjects);
      
      return {
        success: true,
        keys: keys
      };
      
    } catch (error) {
      logger.error('Failed to press hotkey', {
        error: error.message,
        keys
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Click at specific coordinates
   * @param {Object} payload - { x, y }
   * @returns {Promise<Object>} - Execution result
   */
  async mouseClick(payload) {
    const { x, y } = payload;
    
    if (x === undefined || y === undefined) {
      return {
        success: false,
        error: 'Coordinates (x, y) are required'
      };
    }
    
    try {
      logger.info('Clicking at coordinates', { x, y });
      
      // Import NutJS mouse and Point
      const { mouse, Point } = await import('@nut-tree-fork/nut-js');
      
      // Move to position and click
      await mouse.setPosition(new Point(x, y));
      await mouse.click();
      
      return {
        success: true,
        x,
        y
      };
      
    } catch (error) {
      logger.error('Failed to click', {
        error: error.message,
        x,
        y
      });
      
      return {
        success: false,
        error: error.message
      };
    }
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
