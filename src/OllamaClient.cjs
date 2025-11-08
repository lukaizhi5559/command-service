/**
 * OllamaClient
 * 
 * Client for interacting with Ollama to interpret natural language commands
 * into shell commands.
 */

const { Ollama } = require('ollama');
const { execSync } = require('child_process');
const fuzzysort = require('fuzzysort');
const logger = require('./logger.cjs');

class OllamaClient {
  constructor(config = {}) {
    this.host = config.host || process.env.OLLAMA_HOST || 'http://localhost:11434';
    this.model = config.model || process.env.OLLAMA_MODEL || 'qwen2:1.5b';
    this.timeout = config.timeout || 30000;
    
    this.ollama = new Ollama({ host: this.host });
    
    // Dynamic app cache for fuzzy matching
    this.appCache = null;
    this._loadInstalledApps();
    
    logger.info('OllamaClient initialized', {
      host: this.host,
      model: this.model
    });
  }
  
  /**
   * Load installed apps dynamically (one-time on startup)
   * Builds a cache of installed apps for fast fuzzy matching
   * @private
   */
  _loadInstalledApps() {
    try {
      const os = process.platform;
      let appList = [];

      if (os === 'darwin') {
        // macOS: List .app bundles from /Applications and ~/Applications
        const systemApps = execSync('ls -1 /Applications/*.app 2>/dev/null | xargs -n1 basename', { encoding: 'utf8' })
          .split('\n')
          .map(name => name.replace(/\.app:?$/, '').trim()) // Remove .app or .app: suffix
          .filter(name => name);
        
        const userApps = execSync('ls -1 ~/Applications/*.app 2>/dev/null | xargs -n1 basename || true', { encoding: 'utf8' })
          .split('\n')
          .map(name => name.replace(/\.app:?$/, '').trim()) // Remove .app or .app: suffix
          .filter(name => name);
        
        appList = [...new Set([...systemApps, ...userApps])]; // Deduplicate
      } else if (os === 'win32') {
        // Windows: Use PowerShell
        appList = execSync('powershell -Command "Get-StartApps | Select-Object -ExpandProperty Name"', { encoding: 'utf8' })
          .split('\n')
          .map(name => name.trim())
          .filter(name => name && !name.startsWith('Microsoft.'));
      } else if (os === 'linux') {
        // Linux: List .desktop files
        appList = execSync('ls /usr/share/applications/*.desktop 2>/dev/null | xargs -I {} basename {} .desktop || true', { encoding: 'utf8' })
          .split('\n')
          .map(name => name.trim())
          .filter(name => name);
      }

      // Build fuzzy-searchable cache
      this.appCache = {};
      appList.forEach(appName => {
        const lower = appName.toLowerCase();
        this.appCache[lower] = appName;
        
        // Add common abbreviations (e.g., "Visual Studio Code" → "vscode", "vs code")
        const words = lower.split(/\s+/);
        if (words.length > 1) {
          // First word
          this.appCache[words[0]] = appName;
          // First two words
          if (words.length > 2) {
            this.appCache[words.slice(0, 2).join(' ')] = appName;
          }
          // Initials (e.g., "vsc" for "Visual Studio Code")
          const initials = words.map(w => w[0]).join('');
          if (initials.length >= 2) {
            this.appCache[initials] = appName;
          }
        }
      });

      logger.info('Loaded installed apps dynamically', { 
        count: appList.length, 
        os,
        sample: appList.slice(0, 5)
      });
    } catch (error) {
      logger.warn('Failed to load installed apps, using fallback', { error: error.message });
      // Fallback to common apps
      this.appCache = {
        'slack': 'Slack',
        'chrome': 'Google Chrome',
        'safari': 'Safari',
        'firefox': 'Firefox',
        'vscode': 'Visual Studio Code',
        'code': 'Visual Studio Code',
        'terminal': 'Terminal',
        'finder': 'Finder'
      };
    }
  }
  
  /**
   * Normalize app name using dynamic cache + fuzzy matching
   * @param {string} raw - User input (e.g., "vs code", "slack app")
   * @returns {string|null} Normalized app name (e.g., "Visual Studio Code")
   * @private
   */
  _normalizeAppName(raw) {
    if (!this.appCache) return null;

    const lowerRaw = raw.toLowerCase().trim()
      .replace(/\s+(app|application|program|window)$/i, '') // Remove trailing "app"
      .replace(/^the\s+/i, ''); // Remove leading "the"
    
    // Exact match first
    if (this.appCache[lowerRaw]) {
      logger.debug('App matched exactly', { input: raw, matched: this.appCache[lowerRaw] });
      return this.appCache[lowerRaw];
    }

    // Fuzzy match (e.g., "vscode" → "Visual Studio Code")
    const keys = Object.keys(this.appCache);
    const results = fuzzysort.go(lowerRaw, keys, { 
      limit: 1, 
      threshold: -10000 // Very permissive
    });
    
    if (results.length > 0 && results[0].score > -5000) {
      const match = this.appCache[results[0].target];
      logger.debug('App matched via fuzzy search', { 
        input: raw, 
        matched: match, 
        score: results[0].score 
      });
      return match;
    }

    logger.debug('No app match found', { input: raw });
    return null;
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
4. System info:
   - Disk: df -h
   - Memory: top -l 1 | grep PhysMem
   - Processes: ps aux
   - IP address: curl -s ifconfig.me
   - Local IP: ipconfig getifaddr en0
5. If unsure, output: echo "Cannot execute: [reason]"

Command:`;
  }
  
  /**
   * Quick pattern matching for ONLY the most reliable commands
   * Returns shell command if matched, null otherwise (then uses Gemini/Ollama)
   * Simplified to ~10 ultra-reliable patterns to reduce maintenance
   */
  _quickMatchCommand(naturalCommand, os) {
    if (!naturalCommand) return null;
    
    const lower = naturalCommand.toLowerCase().trim();
    
    // macOS patterns - ONLY exact, unambiguous matches
    if (os === 'darwin') {
      // Exact phrase matches for system info
      if (lower === 'disk space' || lower === 'storage') {
        return 'df -h';
      }
      
      if (lower === 'memory' || lower === 'ram') {
        return 'top -l 1 | grep PhysMem';
      }
      
      if (lower === 'battery') {
        return 'pmset -g batt';
      }
      
      if (lower === 'what time is it' || lower === 'current time') {
        return 'date "+%I:%M %p on %A, %B %d, %Y"';
      }
      
      // IP address queries
      if (/\b(what|show|get|my|the)\s+(is\s+)?(my\s+)?(ip|ip address|external ip|public ip)\b/i.test(lower)) {
        // External IP
        return 'curl -s ifconfig.me';
      }
      
      if (/\b(local|internal|private)\s+ip\b/i.test(lower)) {
        // Local IP
        return 'ipconfig getifaddr en0 || ipconfig getifaddr en1';
      }
      
      // App control with fuzzy matching (most reliable use case)
      if (/^(open|launch)\s+/i.test(lower)) {
        const match = lower.match(/^(?:open|launch)\s+(.+?)(?:\s+for me)?$/i);
        if (match) {
          const rawAppName = match[1].trim();
          const normalizedApp = this._normalizeAppName(rawAppName);
          
          if (normalizedApp) {
            logger.info('App open command matched', { 
              input: rawAppName, 
              normalized: normalizedApp 
            });
            return `open -a "${normalizedApp}"`;
          }
        }
      }
      
      if (/^(close|quit)\s+/i.test(lower)) {
        const match = lower.match(/^(?:close|quit)\s+(.+?)(?:\s+for me)?$/i);
        if (match) {
          const rawAppName = match[1].trim();
          const normalizedApp = this._normalizeAppName(rawAppName);
          
          if (normalizedApp) {
            logger.info('App close command matched', { 
              input: rawAppName, 
              normalized: normalizedApp 
            });
            return `osascript -e 'quit app "${normalizedApp}"'`;
          }
        }
      }
    }
    
    // Linux patterns
    if (os === 'linux') {
      if (lower === 'disk space') return 'df -h';
      if (lower === 'memory') return 'free -h';
    }
    
    // No match - let Gemini/Ollama handle it
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
