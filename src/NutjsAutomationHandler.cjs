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
        timeout: 30000 // 30 seconds
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
      
      return data;
      
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
        timeout: 30000, // 30 seconds max execution time
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
   * @returns {Promise<Object>} - { success, result, error, metadata }
   */
  async handleAutomationCommand(command) {
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
      
      // Step 2: Generate Nut.js code
      const generation = await this.generateNutjsCode(command);
      
      if (!generation.success || !generation.code) {
        return {
          success: false,
          error: generation.error || 'Failed to generate automation code',
          provider: generation.provider
        };
      }
      
      // Step 3: Execute the code
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
      
      // Step 4: Return success
      return {
        success: true,
        result: execution.output,
        metadata: {
          provider: generation.provider,
          codeGenerationTime: generation.latencyMs,
          executionTime: execution.executionTime,
          totalTime: generation.latencyMs + execution.executionTime,
          codeValidation: generation.validation
        }
      };
      
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
