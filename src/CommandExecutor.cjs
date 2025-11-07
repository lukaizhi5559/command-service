/**
 * CommandExecutor
 * 
 * Safely executes validated shell commands and captures output.
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger.cjs');

const execAsync = promisify(exec);

class CommandExecutor {
  constructor(config = {}) {
    this.timeout = config.timeout || parseInt(process.env.COMMAND_TIMEOUT) || 30000;
    this.maxOutputLength = config.maxOutputLength || parseInt(process.env.MAX_OUTPUT_LENGTH) || 10000;
    
    logger.info('CommandExecutor initialized', {
      timeout: this.timeout,
      maxOutputLength: this.maxOutputLength
    });
  }
  
  /**
   * Execute a shell command safely
   * @param {string} command - The shell command to execute
   * @param {Object} options - Execution options
   * @returns {Promise<Object>} - { success, output, error, exitCode }
   */
  async execute(command, options = {}) {
    const startTime = Date.now();
    
    try {
      logger.info('Executing command', { command });
      
      const { stdout, stderr } = await execAsync(command, {
        timeout: this.timeout,
        maxBuffer: this.maxOutputLength,
        shell: '/bin/bash',
        env: { ...process.env, ...options.env }
      });
      
      const executionTime = Date.now() - startTime;
      
      // Combine stdout and stderr
      let output = stdout || '';
      if (stderr) {
        output += (output ? '\n' : '') + stderr;
      }
      
      // Truncate if too long
      if (output.length > this.maxOutputLength) {
        output = output.substring(0, this.maxOutputLength) + '\n... (output truncated)';
      }
      
      logger.info('Command executed successfully', {
        command,
        executionTime,
        outputLength: output.length
      });
      
      return {
        success: true,
        output: output.trim(),
        exitCode: 0,
        executionTime
      };
      
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      logger.error('Command execution failed', {
        command,
        error: error.message,
        exitCode: error.code,
        executionTime
      });
      
      // Handle timeout
      if (error.killed && error.signal === 'SIGTERM') {
        return {
          success: false,
          error: `Command timed out after ${this.timeout}ms`,
          exitCode: -1,
          executionTime
        };
      }
      
      // Handle other errors
      return {
        success: false,
        output: error.stdout || '',
        error: error.stderr || error.message,
        exitCode: error.code || -1,
        executionTime
      };
    }
  }
  
  /**
   * Execute command and provide human-readable interpretation
   * @param {string} command - The shell command to execute
   * @param {string} originalCommand - The original natural language command
   * @returns {Promise<Object>} - { success, output, interpretation, error }
   */
  async executeWithInterpretation(command, originalCommand) {
    const result = await this.execute(command);
    
    if (!result.success) {
      return {
        ...result,
        interpretation: this._interpretError(command, result.error)
      };
    }
    
    return {
      ...result,
      interpretation: this._interpretOutput(command, result.output, originalCommand)
    };
  }
  
  /**
   * Interpret command output for human readability
   * @private
   */
  _interpretOutput(command, output, originalCommand) {
    // If output is empty
    if (!output || output.trim() === '') {
      if (command.startsWith('open ')) {
        return 'Application opened successfully';
      }
      return 'Command executed successfully';
    }
    
    // For specific command types
    if (command.startsWith('df ')) {
      return this._interpretDiskSpace(output);
    }
    
    if (command.startsWith('ps ') || command.startsWith('top ')) {
      return this._interpretProcesses(output);
    }
    
    if (command.startsWith('ls ')) {
      return this._interpretFileList(output);
    }
    
    // Default: return output as-is if short, summarize if long
    if (output.length < 500) {
      return output;
    }
    
    const lines = output.split('\n');
    return `Command executed successfully. Output has ${lines.length} lines. First few lines:\n${lines.slice(0, 5).join('\n')}`;
  }
  
  /**
   * Interpret disk space output
   * @private
   */
  _interpretDiskSpace(output) {
    const lines = output.split('\n');
    if (lines.length < 2) return output;
    
    // Parse df output
    const dataLine = lines[1];
    const parts = dataLine.split(/\s+/);
    
    if (parts.length >= 5) {
      const used = parts[2];
      const available = parts[3];
      const percent = parts[4];
      
      return `Disk space: ${available} available out of ${used} used (${percent} full)`;
    }
    
    return output;
  }
  
  /**
   * Interpret process list output
   * @private
   */
  _interpretProcesses(output) {
    const lines = output.split('\n').filter(l => l.trim());
    const processCount = lines.length - 1; // Minus header
    
    return `Found ${processCount} processes. Top processes:\n${lines.slice(0, 6).join('\n')}`;
  }
  
  /**
   * Interpret file list output
   * @private
   */
  _interpretFileList(output) {
    const lines = output.split('\n').filter(l => l.trim());
    const fileCount = lines.length;
    
    if (fileCount === 0) {
      return 'Directory is empty';
    }
    
    if (fileCount <= 10) {
      return `Found ${fileCount} items:\n${output}`;
    }
    
    return `Found ${fileCount} items. First 10:\n${lines.slice(0, 10).join('\n')}`;
  }
  
  /**
   * Interpret error messages
   * @private
   */
  _interpretError(command, error) {
    if (error.includes('command not found')) {
      return `The command or application was not found. Make sure it's installed.`;
    }
    
    if (error.includes('Permission denied')) {
      return `Permission denied. You may need elevated privileges for this command.`;
    }
    
    if (error.includes('No such file or directory')) {
      return `File or directory not found. Please check the path.`;
    }
    
    if (error.includes('timed out')) {
      return `Command took too long to execute and was stopped.`;
    }
    
    return `Command failed: ${error}`;
  }
  
  /**
   * Test if a command exists in the system
   * @param {string} commandName - Name of the command to test
   * @returns {Promise<boolean>}
   */
  async commandExists(commandName) {
    try {
      await execAsync(`which ${commandName}`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = CommandExecutor;
