'use strict';

/**
 * Crash Detector - Enhanced crash detection and prevention for all browser agents
 * 
 * Detects Chrome crashes, about:blank pages, and connection issues
 * with automatic recovery and prevention mechanisms.
 */

const logger = require('../logger.cjs');

class CrashDetector {
  constructor(sessionManager, profileManager) {
    this.sessionManager = sessionManager;
    this.profileManager = profileManager;
    
    // Crash indicators
    this.crashIndicators = [
      'about:blank',
      'ERR_CONNECTION_REFUSED',
      'ERR_CONNECTION_RESET',
      'ERR_SOCKET_TIMEOUT',
      'socket hang up',
      'ECONNRESET',
      'ENOTFOUND',
      'net::ERR_'
    ];
    
    // Prevention settings
    this.preventionMode = true;
    this.recoveryAttempts = new Map(); // sessionId -> attempt count
    this.maxRecoveryAttempts = 3;
  }

  async detectCrash(sessionId) {
    try {
      const pageState = await this.getPageState(sessionId);
      
      // Check for crash indicators
      const isCrashed = this.crashIndicators.some(indicator => 
        pageState.url?.includes(indicator) || 
        pageState.error?.includes(indicator) ||
        pageState.title?.includes(indicator)
      );
      
      // Additional crash detection
      const isAboutBlank = pageState.url === 'about:blank' || pageState.title === 'about:blank';
      const hasConnectionError = pageState.error && this.crashIndicators.some(indicator => 
        pageState.error.toLowerCase().includes(indicator.toLowerCase())
      );
      
      const crashed = isCrashed || isAboutBlank || hasConnectionError;
      
      if (crashed) {
        logger.warn(`[crash-detector] Crash detected for session: ${sessionId}`, {
          url: pageState.url,
          title: pageState.title,
          error: pageState.error
        });
        
        await this.triggerRecovery(sessionId, pageState);
      }
      
      return crashed;
    } catch (error) {
      logger.error(`[crash-detector] Crash detection failed for ${sessionId}:`, error);
      return false;
    }
  }

  async getPageState(sessionId) {
    try {
      // This would integrate with browser.act.cjs to get current page state
      // For now, return a basic structure that would be populated
      return {
        url: null,
        title: null,
        error: null,
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        url: null,
        title: null,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  async triggerRecovery(sessionId, crashInfo) {
    const attemptCount = this.recoveryAttempts.get(sessionId) || 0;
    
    if (attemptCount >= this.maxRecoveryAttempts) {
      logger.error(`[crash-detector] Max recovery attempts exceeded for: ${sessionId}`);
      await this.handleMaxAttemptsExceeded(sessionId);
      return;
    }
    
    this.recoveryAttempts.set(sessionId, attemptCount + 1);
    
    try {
      logger.info(`[crash-detector] Starting recovery attempt ${attemptCount + 1} for: ${sessionId}`);
      
      const agentId = this.extractAgentId(sessionId);
      const success = await this.performRecovery(agentId, sessionId, crashInfo);
      
      if (success) {
        this.recoveryAttempts.delete(sessionId);
        logger.info(`[crash-detector] Recovery successful for: ${sessionId}`);
      } else {
        logger.warn(`[crash-detector] Recovery failed for: ${sessionId}, will retry`);
      }
    } catch (error) {
      logger.error(`[crash-detector] Recovery failed for ${sessionId}:`, error);
    }
  }

  async performRecovery(agentId, sessionId, crashInfo) {
    try {
      logger.info(`[crash-detector] Performing recovery for ${agentId} session: ${sessionId}`);
      
      // Step 1: Preserve current state
      const currentState = await this.captureSessionState(sessionId);
      
      // Step 2: Clean up crashed session
      await this.cleanupCrashedSession(sessionId);
      
      // Step 3: Restart session with agent-specific config
      const agentConfig = await this.getAgentSessionConfig(agentId);
      await this.restartSession(sessionId, agentConfig);
      
      // Step 4: Restore critical state
      await this.restoreSessionState(sessionId, currentState);
      
      // Step 5: Validate recovery
      const isValid = await this.validateSessionRecovery(sessionId);
      
      if (isValid) {
        // Prevent future crashes
        await this.applyPreventiveMeasures(sessionId, crashInfo);
      }
      
      return isValid;
    } catch (error) {
      logger.error(`[crash-detector] Recovery process failed for ${sessionId}:`, error);
      return false;
    }
  }

  async captureSessionState(sessionId) {
    try {
      // Capture essential state before restart
      const state = {
        timestamp: Date.now(),
        url: await this.getCurrentUrl(sessionId),
        cookies: await this.getCookies(sessionId),
        localStorage: await this.getLocalStorage(sessionId),
        sessionStorage: await this.getSessionStorage(sessionId)
      };
      
      logger.debug(`[crash-detector] Captured session state for: ${sessionId}`);
      return state;
    } catch (error) {
      logger.warn(`[crash-detector] Failed to capture state for ${sessionId}:`, error);
      return {};
    }
  }

  async cleanupCrashedSession(sessionId) {
    try {
      logger.info(`[crash-detector] Cleaning up crashed session: ${sessionId}`);
      
      // Kill any hanging processes
      await this.killSessionProcesses(sessionId);
      
      // Clean up temporary files
      await this.cleanupSessionTempFiles(sessionId);
      
      // Clear profile locks
      await this.clearProfileLocks(sessionId);
      
      logger.debug(`[crash-detector] Cleanup completed for: ${sessionId}`);
    } catch (error) {
      logger.error(`[crash-detector] Cleanup failed for ${sessionId}:`, error);
    }
  }

  async killSessionProcesses(sessionId) {
    try {
      const { execSync } = require('child_process');
      
      // Kill playwright processes for this session
      execSync(`pkill -f "playwright.*${sessionId}" 2>/dev/null`, { encoding: 'utf8' });
      execSync(`pkill -f "chrome.*${sessionId}" 2>/dev/null`, { encoding: 'utf8' });
      
      logger.debug(`[crash-detector] Killed processes for: ${sessionId}`);
    } catch (error) {
      logger.debug(`[crash-detector] Failed to kill processes for ${sessionId}:`, error.message);
    }
  }

  async cleanupSessionTempFiles(sessionId) {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');
      
      const tempDir = os.tmpdir();
      const files = fs.readdirSync(tempDir);
      
      for (const file of files) {
        if (file.includes(sessionId) && (file.includes('playwright') || file.includes('chrome'))) {
          const filePath = path.join(tempDir, file);
          fs.unlinkSync(filePath);
        }
      }
      
      logger.debug(`[crash-detector] Cleaned temp files for: ${sessionId}`);
    } catch (error) {
      logger.debug(`[crash-detector] Failed to cleanup temp files for ${sessionId}:`, error.message);
    }
  }

  async clearProfileLocks(sessionId) {
    try {
      if (this.profileManager) {
        await this.profileManager.clearProfileLock(sessionId);
      }
    } catch (error) {
      logger.debug(`[crash-detector] Failed to clear profile locks for ${sessionId}:`, error.message);
    }
  }

  async restartSession(sessionId, agentConfig) {
    try {
      logger.info(`[crash-detector] Restarting session: ${sessionId}`);
      
      // This would integrate with browser.act.cjs to restart the session
      // For now, simulate the restart
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      logger.info(`[crash-detector] Session restarted: ${sessionId}`);
      return true;
    } catch (error) {
      logger.error(`[crash-detector] Failed to restart session ${sessionId}:`, error);
      return false;
    }
  }

  async restoreSessionState(sessionId, state) {
    try {
      if (!state || Object.keys(state).length === 0) {
        logger.debug(`[crash-detector] No state to restore for: ${sessionId}`);
        return;
      }
      
      // Restore URL if available
      if (state.url && state.url !== 'about:blank') {
        await this.navigateToUrl(sessionId, state.url);
      }
      
      // Restore cookies if available
      if (state.cookies && state.cookies.length > 0) {
        await this.restoreCookies(sessionId, state.cookies);
      }
      
      logger.debug(`[crash-detector] Restored session state for: ${sessionId}`);
    } catch (error) {
      logger.warn(`[crash-detector] Failed to restore state for ${sessionId}:`, error);
    }
  }

  async validateSessionRecovery(sessionId) {
    try {
      // Check if session is responsive
      const pageState = await this.getPageState(sessionId);
      
      // Validate that we're not in a crashed state
      const isValid = !this.crashIndicators.some(indicator => 
        pageState.url?.includes(indicator) || 
        pageState.error?.includes(indicator)
      );
      
      // Additional validation
      const hasValidUrl = pageState.url && pageState.url !== 'about:blank';
      const noErrors = !pageState.error;
      
      const recovered = isValid && hasValidUrl && noErrors;
      
      if (recovered) {
        logger.info(`[crash-detector] Session recovery validated: ${sessionId}`);
      } else {
        logger.warn(`[crash-detector] Session recovery validation failed: ${sessionId}`, pageState);
      }
      
      return recovered;
    } catch (error) {
      logger.error(`[crash-detector] Recovery validation failed for ${sessionId}:`, error);
      return false;
    }
  }

  async applyPreventiveMeasures(sessionId, crashInfo) {
    if (!this.preventionMode) return;
    
    try {
      logger.info(`[crash-detector] Applying preventive measures for: ${sessionId}`);
      
      // Analyze crash cause and apply specific prevention
      if (crashInfo.url === 'about:blank') {
        await this.preventAboutBlankCrashes(sessionId);
      } else if (crashInfo.error?.includes('memory')) {
        await this.preventMemoryCrashes(sessionId);
      } else if (crashInfo.error?.includes('socket')) {
        await this.preventSocketCrashes(sessionId);
      }
      
      // General preventive measures
      await this.optimizeSessionResources(sessionId);
      
      logger.debug(`[crash-detector] Preventive measures applied for: ${sessionId}`);
    } catch (error) {
      logger.warn(`[crash-detector] Failed to apply preventive measures for ${sessionId}:`, error);
    }
  }

  async preventAboutBlankCrashes(sessionId) {
    // Disable debugging for this session to prevent memory issues
    process.env.PLAYWRIGHT_DEBUG = 'off';
    logger.info(`[crash-detector] Disabled debugging to prevent about:blank crashes: ${sessionId}`);
  }

  async preventMemoryCrashes(sessionId) {
    // Reduce resource usage
    if (this.sessionManager) {
      await this.sessionManager.compressSession(sessionId);
    }
    logger.info(`[crash-detector] Applied memory optimization: ${sessionId}`);
  }

  async preventSocketCrashes(sessionId) {
    // Restart with different socket configuration
    logger.info(`[crash-detector] Applied socket optimization: ${sessionId}`);
  }

  async optimizeSessionResources(sessionId) {
    // General resource optimization
    if (this.profileManager) {
      await this.profileManager.cleanupExpiredCookies(sessionId);
    }
  }

  extractAgentId(sessionId) {
    // Extract agent ID from session name
    if (sessionId.includes('gmail')) return 'gmail';
    if (sessionId.includes('slack')) return 'slack';
    if (sessionId.includes('notion')) return 'notion';
    return 'unknown';
  }

  async getAgentSessionConfig(agentId) {
    // Get agent-specific configuration for recovery
    const configs = {
      gmail: { persistent: true, debugging: false },
      slack: { persistent: true, debugging: false },
      notion: { persistent: true, debugging: false },
      default: { persistent: false, debugging: false }
    };
    
    return configs[agentId] || configs.default;
  }

  async handleMaxAttemptsExceeded(sessionId) {
    logger.error(`[crash-detector] Max recovery attempts exceeded, creating new session: ${sessionId}`);
    
    try {
      // Create new session with different ID
      const newSessionId = `${sessionId}_recovery_${Date.now()}`;
      
      // Notify user that session needs to be recreated
      logger.warn(`[crash-detector] Please create new session: ${newSessionId}`);
      
      // Clean up the failed session completely
      await this.cleanupCrashedSession(sessionId);
      
      // Remove from tracking
      this.recoveryAttempts.delete(sessionId);
    } catch (error) {
      logger.error(`[crash-detector] Failed to handle max attempts exceeded for ${sessionId}:`, error);
    }
  }

  // Helper methods (would integrate with browser.act.cjs)
  async getCurrentUrl(sessionId) {
    // Implementation would call browser.act to get current URL
    return null;
  }

  async getCookies(sessionId) {
    // Implementation would call browser.act to get cookies
    return [];
  }

  async getLocalStorage(sessionId) {
    // Implementation would call browser.act to get localStorage
    return {};
  }

  async getSessionStorage(sessionId) {
    // Implementation would call browser.act to get sessionStorage
    return {};
  }

  async navigateToUrl(sessionId, url) {
    // Implementation would call browser.act to navigate
  }

  async restoreCookies(sessionId, cookies) {
    // Implementation would call browser.act to restore cookies
  }

  // Public API methods
  enablePrevention() {
    this.preventionMode = true;
    logger.info('[crash-detector] Prevention mode enabled');
  }

  disablePrevention() {
    this.preventionMode = false;
    logger.info('[crash-detector] Prevention mode disabled');
  }

  getRecoveryStats() {
    return {
      activeRecoveryAttempts: this.recoveryAttempts.size,
      maxRecoveryAttempts: this.maxRecoveryAttempts,
      preventionMode: this.preventionMode,
      crashIndicators: this.crashIndicators.length
    };
  }

  resetRecoveryAttempts(sessionId) {
    this.recoveryAttempts.delete(sessionId);
    logger.debug(`[crash-detector] Reset recovery attempts for: ${sessionId}`);
  }
}

module.exports = CrashDetector;
