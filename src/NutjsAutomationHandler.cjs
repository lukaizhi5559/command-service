/**
 * Nut.js Automation Handler
 * 
 * Integrates with the Nut.js Code Generation API to enable natural language desktop automation.
 * Handles code generation, validation, and execution.
 */

require('dotenv').config();
const fetch = require('node-fetch');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger.cjs');

const execAsync = promisify(exec);

class NutjsAutomationHandler {
  constructor() {
    this.apiBaseUrl = process.env.NUTJS_API_URL || 'http://localhost:4000/api/nutjs';
    this.apiKey = process.env.THINKDROP_API_KEY;
    this.tempDir = path.join(process.cwd(), '.temp');
    
    if (!this.apiKey) {
      logger.warn('THINKDROP_API_KEY not set - Nut.js automation will not work');
    }
    
    logger.info('NutjsAutomationHandler initialized', {
      apiBaseUrl: this.apiBaseUrl,
      hasApiKey: !!this.apiKey,
      tempDir: this.tempDir
    });
  }
  
  /**
   * Check if the Nut.js API service is healthy
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/health`, {
        method: 'GET',
        timeout: 5000
      });
      
      if (!response.ok) {
        return false;
      }
      
      const data = await response.json();
      return data.status === 'healthy';
      
    } catch (error) {
      logger.error('Nut.js API health check failed', { error: error.message });
      return false;
    }
  }
  
  /**
   * Generate Nut.js code from natural language command
   * @param {string} command - Natural language command
   * @returns {Promise<Object>} - { success, code, provider, latencyMs, validation }
   */
  async generateNutjsCode(command) {
    if (!this.apiKey) {
      throw new Error('THINKDROP_API_KEY is not configured');
    }
    
    try {
      logger.info('Generating Nut.js code', { command });
      
      const response = await fetch(this.apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.apiKey,
        },
        body: JSON.stringify({ command }),
        timeout: 300000 // 300 seconds (5 minutes)
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || data.message || 'Failed to generate Nut.js code');
      }
      
      if (!data.success || !data.code) {
        throw new Error(data.error || 'No code generated');
      }
      
      logger.info('Nut.js code generated successfully', {
        provider: data.provider,
        latencyMs: data.latencyMs,
        codeLength: data.code.length,
        valid: data.validation?.valid
      });
      
      // Inject vision service import if code interacts with UI elements
      const enhancedCode = this.injectVisionService(data.code);
      
      return {
        ...data,
        code: enhancedCode,
        visionInjected: enhancedCode !== data.code
      };
      
    } catch (error) {
      logger.error('Failed to generate Nut.js code', {
        command,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Execute Nut.js code
   * @param {string} code - Nut.js code to execute
   * @param {string} command - Original command (for logging)
   * @returns {Promise<Object>} - { success, output, error, executionTime }
   */
  async executeNutjsCode(code, command) {
    const startTime = Date.now();
    
    try {
      // Ensure temp directory exists
      await fs.mkdir(this.tempDir, { recursive: true });
      
      // Save code to temporary file
      const timestamp = Date.now();
      const codeFilePath = path.join(this.tempDir, `automation_${timestamp}.js`);
      await fs.writeFile(codeFilePath, code, 'utf-8');
      
      logger.info('Executing Nut.js automation', {
        command,
        codeFile: codeFilePath
      });
      
      // Execute the code with proper module support
      const { stdout, stderr } = await execAsync(`node --input-type=module ${codeFilePath}`, {
        timeout: 300000, // 300 seconds (5 minutes) max execution time
        maxBuffer: 1024 * 1024, // 1MB buffer
        env: { ...process.env, NODE_OPTIONS: '--experimental-modules' }
      });
      
      // Clean up temporary file
      await fs.unlink(codeFilePath).catch(err => {
        logger.warn('Failed to delete temp file', { file: codeFilePath, error: err.message });
      });
      
      const executionTime = Date.now() - startTime;
      
      if (stderr) {
        logger.warn('Automation execution warnings', { stderr });
      }
      
      logger.info('Automation executed successfully', {
        command,
        executionTime,
        outputLength: stdout?.length || 0
      });
      
      return {
        success: true,
        output: stdout || 'Automation completed successfully',
        executionTime
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      logger.error('Automation execution failed', {
        command,
        error: error.message,
        executionTime
      });
      
      return {
        success: false,
        error: error.message,
        executionTime
      };
    }
  }
  
  /**
   * Handle desktop automation command (full flow)
   * @param {string} command - Natural language command
   * @param {Object} context - Additional context (os, userId, sessionId)
   * @returns {Promise<Object>} - { success, result, error, metadata }
   */
  async handleAutomationCommand(command, context = {}) {
    try {
      // Step 1: Check if service is healthy
      const isHealthy = await this.healthCheck();
      if (!isHealthy) {
        return {
          success: false,
          error: 'Nut.js API service is not available. Please check the backend server.',
          requiresService: true
        };
      }
      
      // Step 2: Try plan-based execution first (Phase 1)
      const usePlanExecution = process.env.USE_PLAN_EXECUTION !== 'false'; // Default to true
      let planFailureInfo = null;
      
      if (usePlanExecution) {
        try {
          logger.info('Attempting plan-based execution (Phase 1)');
          const result = await this.handlePlanBasedAutomation(command, context);
          
          if (result.success) {
            return result;
          }
          
          // Store plan failure info for fallback response
          planFailureInfo = {
            partialSuccess: result.partialSuccess,
            completedSteps: result.metadata?.completedSteps,
            totalSteps: result.metadata?.totalSteps,
            completionRate: result.metadata?.completionRate,
            error: result.error
          };
          
          // If plan execution fails, fall back to raw code
          logger.warn('Plan execution failed, falling back to raw code execution', {
            error: result.error
          });
        } catch (planError) {
          logger.warn('Plan-based execution error, falling back to raw code', {
            error: planError.message
          });
        }
      }
      
      // Fallback: Raw code execution (old method)
      logger.info('Using raw code execution (fallback)');
      const fallbackResult = await this.handleRawCodeAutomation(command);
      
      // If we had a plan failure (partial or complete), mark as uncertain success
      if (planFailureInfo) {
        // Change success to uncertain when plan failed but fallback "succeeded"
        if (fallbackResult.success) {
          fallbackResult.success = false; // Mark as failure since we can't verify
          fallbackResult.uncertainResult = true; // Flag for UI to show special message
          fallbackResult.warning = planFailureInfo.partialSuccess
            ? `⚠️ The structured plan partially completed (${planFailureInfo.completedSteps}/${planFailureInfo.totalSteps} steps), ` +
              `but couldn't finish. A fallback method was attempted, but the result cannot be verified. ` +
              `**Please check if the task completed correctly.**`
            : `⚠️ The structured plan failed, and a fallback method was attempted. ` +
              `The result cannot be verified. **Please check if the task completed correctly.**`;
          fallbackResult.planFailure = planFailureInfo;
          
          logger.warn('Fallback executed after plan failure - result uncertain', {
            command,
            planSteps: `${planFailureInfo.completedSteps}/${planFailureInfo.totalSteps}`
          });
        }
      }
      
      return fallbackResult;
      
    } catch (error) {
      logger.error('Desktop automation failed', {
        command,
        error: error.message
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * Handle automation using structured plans (Phase 1)
   * @param {string} command - Natural language command
   * @param {Object} context - Additional context
   * @returns {Promise<Object>}
   */
  async handlePlanBasedAutomation(command, context = {}) {
    const { fetchAutomationPlan } = require('./services/backendClient.cjs');
    const { executePlan, generateSummary } = require('./services/planExecutor.cjs');
    
    try {
      // Step 1: Fetch structured plan from backend
      const plan = await fetchAutomationPlan(command, context);
      
      // Step 2: Execute plan with verification and retries
      const result = await executePlan(plan);
      
      // Step 3: Return result
      if (result.status === 'completed') {
        return {
          success: true,
          result: generateSummary(result),
          metadata: {
            planId: result.planId,
            executionMode: 'plan',
            totalSteps: result.summary.totalSteps,
            successfulSteps: result.summary.successful,
            retriedSteps: result.summary.withRetries,
            totalRetries: result.summary.totalRetries,
            executionTime: result.totalTime
          }
        };
      } else {
        // Check if most steps completed (partial success)
        const completionRate = result.summary.completed / result.summary.totalSteps;
        const isPartialSuccess = completionRate >= 0.7; // 70% or more steps completed
        
        return {
          success: false,
          partialSuccess: isPartialSuccess,
          error: generateSummary(result),
          metadata: {
            planId: result.planId,
            executionMode: 'plan',
            failedStep: result.failedStep,
            completedSteps: result.summary.completed,
            totalSteps: result.summary.totalSteps,
            completionRate: Math.round(completionRate * 100),
            executionTime: result.totalTime
          }
        };
      }
      
    } catch (error) {
      logger.error('Plan-based automation failed', {
        command,
        error: error.message
      });
      throw error;
    }
  }
  
  /**
   * Handle automation using raw code (fallback/old method)
   * @param {string} command - Natural language command
   * @returns {Promise<Object>}
   */
  async handleRawCodeAutomation(command) {
    try {
      // Step 1: Generate Nut.js code
      const generation = await this.generateNutjsCode(command);
      
      if (!generation.success || !generation.code) {
        return {
          success: false,
          error: generation.error || 'Failed to generate automation code',
          provider: generation.provider
        };
      }
      
      // Step 2: Execute the code
      const execution = await this.executeNutjsCode(generation.code, command);
      
      if (!execution.success) {
        return {
          success: false,
          error: `Automation execution failed: ${execution.error}`,
          generatedCode: generation.code,
          provider: generation.provider,
          executionTime: execution.executionTime
        };
      }
      
      // Step 3: Return success
      return {
        success: true,
        result: execution.output,
        metadata: {
          executionMode: 'raw_code',
          provider: generation.provider,
          codeGenerationTime: generation.latencyMs,
          executionTime: execution.executionTime,
          totalTime: generation.latencyMs + execution.executionTime,
          codeValidation: generation.validation
        }
      };
      
    } catch (error) {
      throw error;
    }
  }
  
  /**
   * Inject vision service import into generated code
   * @param {string} code - Generated Nut.js code
   * @returns {string} - Enhanced code with vision service
   */
  injectVisionService(code) {
    // Check if code already has vision service import
    if (code.includes('visionSpatialService')) {
      return code;
    }
    
    // Check if code uses mouse clicks or UI interaction that could benefit from vision
    const needsVision = 
      code.includes('mouse.move') ||
      code.includes('mouse.click') ||
      code.includes('leftClick') ||
      code.includes('Point(');
    
    if (!needsVision) {
      return code;
    }
    
    // Find the first require statement
    const requireMatch = code.match(/(const.*require.*\n)/);
    
    if (!requireMatch) {
      // No requires found, add at the top
      const visionImport = `const { findAndClick, getUIMap } = require('./services/visionSpatialService');\n\n`;
      return visionImport + code;
    }
    
    // Add vision import after the first require
    const visionImport = `const { findAndClick, getUIMap } = require('./services/visionSpatialService');\n`;
    const enhancedCode = code.replace(requireMatch[0], requireMatch[0] + visionImport);
    
    logger.info('Vision service import injected into generated code');
    
    return enhancedCode;
  }
  
  /**
   * Get example commands for reference
   * @returns {Promise<Object|null>}
   */
  async getExamples() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/examples`, {
        timeout: 5000
      });
      
      if (!response.ok) {
        return null;
      }
      
      return await response.json();
      
    } catch (error) {
      logger.error('Failed to get examples', { error: error.message });
      return null;
    }
  }
}

module.exports = NutjsAutomationHandler;
