/**
 * OllamaClient
 * 
 * Client for interacting with Ollama to interpret natural language commands
 * into shell commands.
 */

const { Ollama } = require('ollama');
const logger = require('./logger.cjs');

class OllamaClient {
  constructor(config = {}) {
    this.host = config.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = config.model || process.env.OLLAMA_MODEL || 'llama3.2:3b';
    this.timeout = config.timeout || 30000;
    
    this.ollama = new Ollama({ host: this.host });
    
    logger.info('OllamaClient initialized', {
      host: this.host,
      model: this.model
    });
  }
  
  /**
   * Interpret natural language command into shell command
   * @param {string} naturalCommand - Natural language command (e.g., "Open Slack")
   * @param {Object} context - Additional context (os, user preferences, etc.)
   * @returns {Promise<Object>} - { success, shellCommand, explanation, error }
   */
  async interpretCommand(naturalCommand, context = {}) {
    try {
      const os = context.os || process.platform;
      const prompt = this._buildCommandPrompt(naturalCommand, os, context);
      
      logger.debug('Interpreting command', { naturalCommand, os });
      
      const response = await this.ollama.chat({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a shell command expert. Convert natural language requests into safe, accurate shell commands. Respond ONLY with the shell command, nothing else. No explanations, no markdown, just the raw command.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: false,
        options: {
          temperature: 0.1,  // Low temperature for consistent, accurate commands
          top_p: 0.9,
          num_predict: 100   // Commands are usually short
        }
      });
      
      const shellCommand = this._parseResponse(response.message.content);
      
      if (!shellCommand) {
        throw new Error('Failed to extract shell command from response');
      }
      
      logger.info('Command interpreted', {
        naturalCommand,
        shellCommand
      });
      
      return {
        success: true,
        shellCommand,
        originalCommand: naturalCommand
      };
      
    } catch (error) {
      logger.error('Failed to interpret command', {
        error: error.message,
        naturalCommand
      });
      
      return {
        success: false,
        error: error.message,
        originalCommand: naturalCommand
      };
    }
  }
  
  /**
   * Query system information using Ollama
   * @param {string} query - Natural language query about system
   * @returns {Promise<Object>} - { success, answer, suggestedCommand, error }
   */
  async querySystem(query) {
    try {
      const os = process.platform;
      const prompt = `System query for ${os}: ${query}\n\nProvide a brief answer and suggest a shell command to get this information.`;
      
      logger.debug('System query', { query });
      
      const response = await this.ollama.chat({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a system information assistant. Answer queries about system information and suggest appropriate shell commands.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 200
        }
      });
      
      const answer = response.message.content.trim();
      
      logger.info('System query answered', { query });
      
      return {
        success: true,
        answer,
        query
      };
      
    } catch (error) {
      logger.error('Failed to answer system query', {
        error: error.message,
        query
      });
      
      return {
        success: false,
        error: error.message,
        query
      };
    }
  }
  
  /**
   * Build prompt for command interpretation
   * @private
   */
  _buildCommandPrompt(naturalCommand, os, context) {
    const osSpecific = {
      darwin: 'macOS (use open -a for apps, standard Unix commands)',
      linux: 'Linux (use xdg-open for apps, standard Unix commands)',
      win32: 'Windows (use start for apps, PowerShell/CMD commands)'
    };
    
    const osInfo = osSpecific[os] || 'Unix-like system';
    
    return `Convert this natural language request into a shell command for ${osInfo}:

"${naturalCommand}"

Rules:
1. Return ONLY the shell command, nothing else
2. No explanations, no markdown code blocks, no quotes around the command
3. Use safe, standard commands
4. For opening apps on macOS: use "open -a AppName"
5. For system info: use appropriate commands (df, top, ps, etc.)
6. Keep it simple and safe

Shell command:`;
  }
  
  /**
   * Parse Ollama response to extract shell command
   * @private
   */
  _parseResponse(content) {
    if (!content) return null;
    
    let command = content.trim();
    
    // Remove markdown code blocks if present
    command = command.replace(/```(?:bash|sh|shell)?\n?/g, '');
    command = command.replace(/```\n?/g, '');
    
    // Remove backticks (inline code)
    command = command.replace(/`/g, '');
    
    // Remove quotes if the entire command is quoted
    if ((command.startsWith('"') && command.endsWith('"')) ||
        (command.startsWith("'") && command.endsWith("'"))) {
      command = command.slice(1, -1);
    }
    
    // Take only the first line (in case there are explanations)
    command = command.split('\n')[0].trim();
    
    // Remove common prefixes
    command = command.replace(/^(Command:|Shell command:|>|\$)\s*/i, '');
    
    return command;
  }
  
  /**
   * Check if Ollama is available
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    try {
      const models = await this.ollama.list();
      const modelExists = models.models.some(m => m.name.includes(this.model.split(':')[0]));
      
      if (!modelExists) {
        logger.warn('Model not found', { model: this.model });
        return false;
      }
      
      logger.info('Ollama health check passed', { model: this.model });
      return true;
      
    } catch (error) {
      logger.error('Ollama health check failed', { error: error.message });
      return false;
    }
  }
}

module.exports = OllamaClient;
