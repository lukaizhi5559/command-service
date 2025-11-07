/**
 * UsageTracker
 * 
 * Tracks API usage for Gemini to monitor daily limits and costs
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger.cjs');

class UsageTracker {
  constructor(config = {}) {
    this.configDir = config.configDir || path.join(process.env.HOME || process.env.USERPROFILE, '.thinkdrop');
    this.usageFile = path.join(this.configDir, 'gemini-usage.json');
    
    // Limits (Gemini 2.0 Flash free tier)
    this.dailyLimit = config.dailyLimit || 1500;
    this.warningThreshold = config.warningThreshold || 0.66; // Warn at 66%
    
    this.usage = this._loadUsage();
    
    logger.info('UsageTracker initialized', {
      dailyLimit: this.dailyLimit,
      currentUsage: this.usage.count,
      date: this.usage.date
    });
  }
  
  /**
   * Load usage data from disk
   * @private
   */
  _loadUsage() {
    try {
      if (fs.existsSync(this.usageFile)) {
        const data = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'));
        
        // Check if it's a new day (reset counter)
        const today = new Date().toISOString().split('T')[0];
        if (data.date !== today) {
          logger.info('New day detected, resetting usage counter', {
            oldDate: data.date,
            newDate: today,
            oldCount: data.count
          });
          return this._createNewUsage();
        }
        
        return data;
      }
    } catch (error) {
      logger.warn('Failed to load usage data', { error: error.message });
    }
    
    return this._createNewUsage();
  }
  
  /**
   * Create new usage object for today
   * @private
   */
  _createNewUsage() {
    return {
      date: new Date().toISOString().split('T')[0],
      count: 0,
      history: []
    };
  }
  
  /**
   * Save usage data to disk
   * @private
   */
  _saveUsage() {
    try {
      // Ensure config directory exists
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      
      fs.writeFileSync(this.usageFile, JSON.stringify(this.usage, null, 2), 'utf8');
    } catch (error) {
      logger.error('Failed to save usage data', { error: error.message });
    }
  }
  
  /**
   * Record a Gemini API call
   * @param {Object} metadata - Call metadata (command, success, etc.)
   * @returns {Object} - { allowed, count, limit, warning }
   */
  recordCall(metadata = {}) {
    // Check if new day
    const today = new Date().toISOString().split('T')[0];
    if (this.usage.date !== today) {
      this.usage = this._createNewUsage();
    }
    
    // Check if limit reached
    if (this.usage.count >= this.dailyLimit) {
      logger.warn('Gemini daily limit reached', {
        count: this.usage.count,
        limit: this.dailyLimit
      });
      
      return {
        allowed: false,
        count: this.usage.count,
        limit: this.dailyLimit,
        warning: `Daily limit of ${this.dailyLimit} requests reached. Resets at midnight UTC.`
      };
    }
    
    // Increment counter
    this.usage.count++;
    this.usage.history.push({
      timestamp: new Date().toISOString(),
      ...metadata
    });
    
    // Keep only last 100 history entries
    if (this.usage.history.length > 100) {
      this.usage.history = this.usage.history.slice(-100);
    }
    
    this._saveUsage();
    
    // Check if warning threshold reached
    const percentage = this.usage.count / this.dailyLimit;
    const warning = percentage >= this.warningThreshold 
      ? `Warning: ${this.usage.count}/${this.dailyLimit} requests used (${Math.round(percentage * 100)}%)`
      : null;
    
    if (warning) {
      logger.warn('Gemini usage warning', {
        count: this.usage.count,
        limit: this.dailyLimit,
        percentage: Math.round(percentage * 100)
      });
    }
    
    logger.debug('Gemini API call recorded', {
      count: this.usage.count,
      limit: this.dailyLimit
    });
    
    return {
      allowed: true,
      count: this.usage.count,
      limit: this.dailyLimit,
      warning
    };
  }
  
  /**
   * Get current usage status
   * @returns {Object}
   */
  getStatus() {
    const today = new Date().toISOString().split('T')[0];
    
    // Reset if new day
    if (this.usage.date !== today) {
      this.usage = this._createNewUsage();
      this._saveUsage();
    }
    
    const percentage = (this.usage.count / this.dailyLimit) * 100;
    const remaining = this.dailyLimit - this.usage.count;
    
    return {
      date: this.usage.date,
      count: this.usage.count,
      limit: this.dailyLimit,
      remaining,
      percentage: Math.round(percentage),
      limitReached: this.usage.count >= this.dailyLimit,
      warningThreshold: Math.round(this.warningThreshold * 100)
    };
  }
  
  /**
   * Reset usage counter (for testing)
   */
  reset() {
    this.usage = this._createNewUsage();
    this._saveUsage();
    logger.info('Usage counter reset');
  }
}

module.exports = UsageTracker;
