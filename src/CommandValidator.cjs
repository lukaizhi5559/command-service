/**
 * CommandValidator
 * 
 * Security layer for validating shell commands before execution.
 * Implements whitelist-based validation and blocks dangerous patterns.
 */

const logger = require('./logger.cjs');

class CommandValidator {
  constructor(config = {}) {
    this.allowedCategories = config.allowedCategories || ['open_app', 'system_info', 'file_read'];
    this.validationEnabled = config.validationEnabled !== false;
    
    // Dangerous patterns that should always be blocked
    this.blockedPatterns = [
      /rm\s+-rf\s+[\/~]/i,           // rm -rf / or ~
      /:\(\)\{\s*:\|:&\s*\};:/,      // Fork bomb
      /mkfs/i,                        // Format filesystem
      /dd\s+if=/i,                    // Disk operations
      />\/dev\/sd[a-z]/i,             // Write to disk
      /chmod\s+777/i,                 // Dangerous permissions
      /wget.*\|\s*sh/i,               // Download and execute
      /curl.*\|\s*sh/i,               // Download and execute
      /eval\s*\(/i,                   // Eval injection
      /;\s*rm\s+-rf/i,                // Chained rm -rf
      /&&\s*rm\s+-rf/i,               // Chained rm -rf
      /\|\s*rm\s+-rf/i,               // Piped rm -rf
    ];
    
    // Command patterns by category
    this.categoryPatterns = {
      open_app: [
        /^open\s+-a\s+["']?[\w\s]+["']?$/i,           // macOS: open -a "App Name"
        /^open\s+["']?[\w\s\/\.]+["']?$/i,            // macOS: open file/url
        /^xdg-open\s+/i,                               // Linux: xdg-open
        /^start\s+/i,                                  // Windows: start
      ],
      system_info: [
        /^(top|htop|ps|uptime|w|who|whoami)(\s|$)/i,  // Process/user info
        /^(df|du|free|vm_stat)(\s|$)/i,               // Disk/memory info
        /^(uname|hostname|sw_vers)(\s|$)/i,           // System info
        /^(ifconfig|ip\s+addr|netstat)(\s|$)/i,       // Network info
        /^(date|cal|uptime)(\s|$)/i,                  // Time info
        /^system_profiler/i,                           // macOS system info
      ],
      file_read: [
        /^(ls|ll|la)(\s|$)/i,                         // List files
        /^cat\s+[\w\/\.\-]+$/i,                       // Read file
        /^head\s+/i,                                   // Read file start
        /^tail\s+/i,                                   // Read file end
        /^less\s+/i,                                   // Page through file
        /^more\s+/i,                                   // Page through file
        /^find\s+/i,                                   // Find files
        /^grep\s+/i,                                   // Search in files
        /^pwd$/i,                                      // Print working directory
      ],
      file_write: [
        /^(touch|mkdir|cp|mv)(\s|$)/i,                // Create/move files
        /^echo\s+.*>\s*/i,                            // Write to file
        /^tee\s+/i,                                    // Write to file
      ],
      network: [
        /^(ping|curl|wget|nc|telnet)(\s|$)/i,         // Network commands
        /^(ssh|scp|rsync)(\s|$)/i,                    // Remote commands
      ],
      process: [
        /^(kill|killall|pkill)(\s|$)/i,               // Kill processes
        /^(systemctl|service)(\s|$)/i,                // Service management
      ],
    };
    
    logger.info('CommandValidator initialized', {
      allowedCategories: this.allowedCategories,
      validationEnabled: this.validationEnabled
    });
  }
  
  /**
   * Validate a shell command
   * @param {string} command - The shell command to validate
   * @returns {Object} - { isValid, error, category, riskLevel, requiresConfirmation }
   */
  validate(command) {
    if (!this.validationEnabled) {
      return {
        isValid: true,
        category: 'unrestricted',
        riskLevel: 'unknown',
        requiresConfirmation: false
      };
    }
    
    // Sanitize command
    const sanitized = command.trim();
    
    if (!sanitized) {
      return {
        isValid: false,
        error: 'Empty command',
        riskLevel: 'none'
      };
    }
    
    // Check for blocked patterns
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(sanitized)) {
        logger.warn('Command blocked by dangerous pattern', { command: sanitized });
        return {
          isValid: false,
          error: 'Command blocked for security: dangerous pattern detected',
          riskLevel: 'critical'
        };
      }
    }
    
    // Check for sudo/elevated privileges
    if (/^sudo\s+/i.test(sanitized)) {
      logger.warn('Command requires sudo', { command: sanitized });
      return {
        isValid: false,
        error: 'Commands requiring elevated privileges (sudo) are not allowed',
        riskLevel: 'high'
      };
    }
    
    // Determine category and validate
    const category = this._determineCategory(sanitized);
    
    if (!category) {
      logger.warn('Command does not match any allowed category', { command: sanitized });
      return {
        isValid: false,
        error: 'Command not in allowed categories',
        riskLevel: 'medium'
      };
    }
    
    if (!this.allowedCategories.includes(category)) {
      logger.warn('Command category not allowed', { command: sanitized, category });
      return {
        isValid: false,
        error: `Command category '${category}' is not allowed`,
        riskLevel: 'medium'
      };
    }
    
    // Determine if confirmation is needed
    const requiresConfirmation = this._requiresConfirmation(category, sanitized);
    const riskLevel = this._assessRiskLevel(category, sanitized);
    
    logger.info('Command validated', {
      command: sanitized,
      category,
      riskLevel,
      requiresConfirmation
    });
    
    return {
      isValid: true,
      category,
      riskLevel,
      requiresConfirmation
    };
  }
  
  /**
   * Determine the category of a command
   * @private
   */
  _determineCategory(command) {
    for (const [category, patterns] of Object.entries(this.categoryPatterns)) {
      for (const pattern of patterns) {
        if (pattern.test(command)) {
          return category;
        }
      }
    }
    return null;
  }
  
  /**
   * Assess the risk level of a command
   * @private
   */
  _assessRiskLevel(category, command) {
    const riskLevels = {
      open_app: 'low',
      system_info: 'low',
      file_read: 'low',
      file_write: 'medium',
      network: 'medium',
      process: 'high'
    };
    
    return riskLevels[category] || 'medium';
  }
  
  /**
   * Determine if a command requires user confirmation
   * @private
   */
  _requiresConfirmation(category, command) {
    const confirmationRequired = ['file_write', 'network', 'process'];
    return confirmationRequired.includes(category);
  }
  
  /**
   * Sanitize command output for safe display
   * @param {string} output - Raw command output
   * @returns {string} - Sanitized output
   */
  sanitizeOutput(output) {
    if (!output) return '';
    
    // Limit length
    const maxLength = 10000;
    if (output.length > maxLength) {
      output = output.substring(0, maxLength) + '\n... (output truncated)';
    }
    
    // Remove ANSI color codes
    output = output.replace(/\x1b\[[0-9;]*m/g, '');
    
    return output;
  }
}

module.exports = CommandValidator;
