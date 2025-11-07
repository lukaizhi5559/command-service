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
    this.model = config.model || process.env.OLLAMA_MODEL || 'qwen2:1.5b';
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
      
      // Quick pattern matching for common commands (avoid slow LLM)
      const quickMatch = this._quickMatchCommand(naturalCommand, os);
      if (quickMatch) {
        logger.info('Command matched via pattern', {
          naturalCommand,
          shellCommand: quickMatch
        });
        return {
          success: true,
          shellCommand: quickMatch,
          originalCommand: naturalCommand,
          method: 'pattern'
        };
      }
      
      const prompt = this._buildCommandPrompt(naturalCommand, os, context);
      
      logger.debug('Interpreting command via LLM', { naturalCommand, os });
      
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
    
    return `Convert this to a shell command for ${osInfo}:

"${naturalCommand}"

CRITICAL RULES:
1. Output ONLY the command - NO explanations, NO markdown, NO quotes
2. macOS app commands:
   - Open: open -a "AppName"
   - Close: osascript -e 'quit app "AppName"'
   - List: ps aux
3. File search: mdfind "kMDItemFSName == 'filename'"
4. System info: df -h (disk), top -l 1 (memory), ps aux (processes)
5. If unsure, output: echo "Cannot execute: [reason]"

Command:`;
  }
  
  /**
   * Quick pattern matching for common commands (fast, no LLM)
   * @private
   */
  _quickMatchCommand(naturalCommand, os) {
    const lower = naturalCommand.toLowerCase().trim();
    
    // macOS patterns
    if (os === 'darwin') {
      // List running apps/processes - FIXED: more specific patterns
      if (/^what (apps?|applications?|programs?|processes) (are|is) (open|running)/i.test(lower) ||
          /^(show|list|display) (running|open|all)?\s*(apps?|applications?|programs?|processes)/i.test(lower)) {
        return 'ps aux';
      }
      
      // Open app
      const openMatch = lower.match(/^open\s+(\w+)/i);
      if (openMatch) {
        const appName = openMatch[1].charAt(0).toUpperCase() + openMatch[1].slice(1);
        return `open -a ${appName}`;
      }
      
      // Close/quit app
      const closeMatch = lower.match(/^(close|quit|kill)\s+(\w+)/i);
      if (closeMatch) {
        const appName = closeMatch[2].charAt(0).toUpperCase() + closeMatch[2].slice(1);
        return `pkill -x ${appName}`;
      }
      
      // System info - disk/storage
      if (/disk (space|usage)/i.test(lower) || 
          /(how much|check).*(storage|disk|space).*(left|available|free|remaining)/i.test(lower)) {
        return 'df -h';
      }
      
      // System info - memory/RAM
      if (/memory usage/i.test(lower) ||
          /(how much|check).*(memory|ram).*(left|available|free|remaining)/i.test(lower)) {
        return 'top -l 1 | grep PhysMem';
      }
      
      // System info - CPU
      if (/cpu usage/i.test(lower)) return 'top -l 1 | grep "CPU usage"';
      
      // App control - Open/Launch/Start/Run
      // Match: "open [the] AppName [app]" or "open AppName"
      if (/^(open|launch|start|run)\s+/i.test(lower)) {
        // Try "open [the] X app" pattern first
        let match = lower.match(/^(?:open|launch|start|run)\s+(?:the\s+)?([\w]+)(?:\s+app)?/i);
        if (match) {
          const appName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
          return `open -a "${appName}"`;
        }
      }
      
      // App control - Close/Quit/Exit/Kill/Stop
      // Match: "close [the] AppName [app]"
      if (/^(close|quit|exit|kill|stop)\s+/i.test(lower)) {
        let match = lower.match(/^(?:close|quit|exit|kill|stop)\s+(?:the\s+)?([\w]+)(?:\s+app)?/i);
        if (match) {
          const appName = match[1].charAt(0).toUpperCase() + match[1].slice(1);
          return `osascript -e 'quit app "${appName}"'`;
        }
      }
      
      // File search
      if (/do i have.*folder.*called/i.test(lower) || /find.*folder.*called/i.test(lower)) {
        const match = lower.match(/(?:folder|directory)\s+(?:called|named)\s+([a-z0-9_-]+)/i);
        if (match) {
          const folderName = match[1];
          return `mdfind "kMDItemKind == 'Folder' && kMDItemFSName == '${folderName}'"`;
        }
      }
      
      // Count running apps
      if (/how many apps.*open/i.test(lower) || /count.*apps.*running/i.test(lower)) {
        return 'ps aux | grep -i ".app/Contents/MacOS" | grep -v grep | wc -l';
      }
    }
    
    // Linux patterns
    if (os === 'linux') {
      if (/^what (apps?|applications?|programs?|processes) (are|is) (open|running)/i.test(lower)) {
        return 'ps aux';
      }
      if (/disk (space|usage)/i.test(lower)) return 'df -h';
      if (/memory usage/i.test(lower)) return 'free -h';
    }
    
    return null;
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
