'use strict';

/**
 * Resource Monitor - Universal resource monitoring for all browser agents
 * 
 * Monitors memory usage, socket connections, and session age to prevent
 * resource exhaustion and crashes across all browser automation.
 */

const fs = require('fs');
const logger = require('../logger.cjs');

class ResourceMonitor {
  constructor() {
    this.thresholds = {
      memory: 500 * 1024 * 1024, // 500MB
      sockets: 50,
      sessionAge: 60 * 60 * 1000, // 1 hour
      openFiles: 100
    };
    
    this.monitoringInterval = 5 * 60 * 1000; // 5 minutes
    this.activeSessions = new Map(); // sessionId -> session info
    
    // Setup monitoring
    this.setupMonitoring();
  }

  setupMonitoring() {
    // Start monitoring every 5 minutes
    setInterval(() => this.performResourceCheck(), this.monitoringInterval);
    
    logger.info('[resource-monitor] Resource monitoring initialized');
  }

  registerSession(sessionId, agentId = 'unknown') {
    this.activeSessions.set(sessionId, {
      sessionId,
      agentId,
      startTime: Date.now(),
      lastCheck: Date.now(),
      resourceUsage: {
        memory: 0,
        sockets: 0,
        openFiles: 0
      }
    });
    
    logger.debug(`[resource-monitor] Registered session: ${sessionId} (${agentId})`);
  }

  unregisterSession(sessionId) {
    this.activeSessions.delete(sessionId);
    logger.debug(`[resource-monitor] Unregistered session: ${sessionId}`);
  }

  async checkSessionResources(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return { ok: false, error: 'Session not found' };
    }

    try {
      const usage = await this.getResourceUsage(sessionId);
      session.resourceUsage = usage;
      session.lastCheck = Date.now();
      
      if (this.exceedsThresholds(usage)) {
        logger.warn(`[resource-monitor] Resource threshold exceeded for session: ${sessionId}`, usage);
        await this.performPreventiveCleanup(sessionId);
        return { ok: false, warning: 'Resource cleanup performed', usage };
      }
      
      return { ok: true, usage };
    } catch (error) {
      logger.error(`[resource-monitor] Failed to check resources for ${sessionId}:`, error);
      return { ok: false, error: error.message };
    }
  }

  async getResourceUsage(sessionId) {
    // Get resource usage for a specific session
    const usage = {
      memory: await this.getMemoryUsage(sessionId),
      sockets: await this.getSocketCount(sessionId),
      openFiles: await this.getOpenFileCount(sessionId),
      sessionAge: Date.now() - (this.activeSessions.get(sessionId)?.startTime || Date.now())
    };
    
    return usage;
  }

  async getMemoryUsage(sessionId) {
    try {
      // Try to get memory usage from system
      const { execSync } = require('child_process');
      
      // Get process memory usage (approximation)
      const memoryInfo = execSync('ps aux | grep playwright | grep -v grep', { encoding: 'utf8' });
      const lines = memoryInfo.split('\n');
      
      let totalMemory = 0;
      for (const line of lines) {
        if (line.includes(sessionId)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 5) {
            // RSS memory is in KB, convert to bytes
            const rssKb = parseInt(parts[5], 10);
            if (!isNaN(rssKb)) {
              totalMemory += rssKb * 1024;
            }
          }
        }
      }
      
      return totalMemory;
    } catch (error) {
      logger.debug(`[resource-monitor] Could not get memory usage for ${sessionId}:`, error.message);
      return 0;
    }
  }

  async getSocketCount(sessionId) {
    try {
      const { execSync } = require('child_process');
      
      // Count sockets related to playwright processes
      const socketInfo = execSync('lsof -i -P | grep playwright | grep -v grep', { encoding: 'utf8' });
      const lines = socketInfo.split('\n');
      
      let socketCount = 0;
      for (const line of lines) {
        if (line.includes('ESTABLISHED') || line.includes('LISTEN')) {
          socketCount++;
        }
      }
      
      return socketCount;
    } catch (error) {
      logger.debug(`[resource-monitor] Could not get socket count for ${sessionId}:`, error.message);
      return 0;
    }
  }

  async getOpenFileCount(sessionId) {
    try {
      const { execSync } = require('child_process');
      
      // Count open files for playwright processes
      const fileInfo = execSync('lsof -p $(pgrep playwright) 2>/dev/null | wc -l', { encoding: 'utf8' });
      return parseInt(fileInfo.trim(), 10) || 0;
    } catch (error) {
      logger.debug(`[resource-monitor] Could not get open file count for ${sessionId}:`, error.message);
      return 0;
    }
  }

  exceedsThresholds(usage) {
    return (
      usage.memory > this.thresholds.memory ||
      usage.sockets > this.thresholds.sockets ||
      usage.openFiles > this.thresholds.openFiles ||
      usage.sessionAge > this.thresholds.sessionAge
    );
  }

  async performPreventiveCleanup(sessionId) {
    logger.info(`[resource-monitor] Performing preventive cleanup for session: ${sessionId}`);
    
    try {
      // Clear expired sessions
      await this.clearExpiredSessions();
      
      // Cleanup temporary files
      await this.cleanupTempFiles();
      
      // Close idle connections
      await this.closeIdleConnections();
      
      // Restart session if needed
      if (await this.shouldRestartSession(sessionId)) {
        await this.restartSession(sessionId);
      }
      
      logger.info(`[resource-monitor] Preventive cleanup completed for: ${sessionId}`);
    } catch (error) {
      logger.error(`[resource-monitor] Preventive cleanup failed for ${sessionId}:`, error);
    }
  }

  async clearExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];
    
    for (const [sessionId, session] of this.activeSessions) {
      const age = now - session.startTime;
      if (age > this.thresholds.sessionAge) {
        expiredSessions.push(sessionId);
      }
    }
    
    for (const sessionId of expiredSessions) {
      logger.info(`[resource-monitor] Clearing expired session: ${sessionId}`);
      await this.forceCloseSession(sessionId);
      this.unregisterSession(sessionId);
    }
  }

  async cleanupTempFiles() {
    try {
      const tempDir = '/tmp';
      const files = fs.readdirSync(tempDir);
      let cleanedCount = 0;
      
      for (const file of files) {
        if (file.includes('playwright') || file.includes('chrome')) {
          const filePath = path.join(tempDir, file);
          const stats = fs.statSync(filePath);
          
          // Delete temp files older than 1 hour
          const age = Date.now() - stats.mtime.getTime();
          if (age > 60 * 60 * 1000) {
            fs.unlinkSync(filePath);
            cleanedCount++;
          }
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`[resource-monitor] Cleaned ${cleanedCount} temporary files`);
      }
    } catch (error) {
      logger.error('[resource-monitor] Failed to cleanup temp files:', error);
    }
  }

  async closeIdleConnections() {
    try {
      const { execSync } = require('child_process');
      
      // Close idle sockets
      execSync('lsof -i | grep TIME_WAIT | awk \'{print $2}\' | xargs -r kill -9 2>/dev/null', { encoding: 'utf8' });
      
      logger.debug('[resource-monitor] Closed idle connections');
    } catch (error) {
      logger.debug('[resource-monitor] Failed to close idle connections:', error.message);
    }
  }

  async shouldRestartSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    
    const usage = session.resourceUsage;
    
    // Restart if memory usage is very high or session is very old
    return usage.memory > this.thresholds.memory * 0.8 || 
           session.sessionAge > this.thresholds.sessionAge * 0.8;
  }

  async restartSession(sessionId) {
    try {
      logger.info(`[resource-monitor] Restarting session: ${sessionId}`);
      
      // This would integrate with browser.act.cjs to restart the session
      // For now, just log the action
      logger.info(`[resource-monitor] Session restart requested: ${sessionId}`);
      
      // Mark session for restart
      const session = this.activeSessions.get(sessionId);
      if (session) {
        session.needsRestart = true;
      }
    } catch (error) {
      logger.error(`[resource-monitor] Failed to restart session ${sessionId}:`, error);
    }
  }

  async forceCloseSession(sessionId) {
    try {
      const { execSync } = require('child_process');
      
      // Kill playwright processes for this session
      execSync(`pkill -f "playwright.*${sessionId}" 2>/dev/null`, { encoding: 'utf8' });
      
      logger.info(`[resource-monitor] Force closed session: ${sessionId}`);
    } catch (error) {
      logger.debug(`[resource-monitor] Failed to force close session ${sessionId}:`, error.message);
    }
  }

  async performResourceCheck() {
    try {
      logger.debug('[resource-monitor] Performing resource check');
      
      const sessions = Array.from(this.activeSessions.keys());
      let issuesFound = 0;
      
      for (const sessionId of sessions) {
        const result = await this.checkSessionResources(sessionId);
        if (!result.ok) {
          issuesFound++;
        }
      }
      
      if (issuesFound > 0) {
        logger.warn(`[resource-monitor] Resource check completed: ${issuesFound} issues found`);
      } else {
        logger.debug('[resource-monitor] Resource check completed: no issues');
      }
    } catch (error) {
      logger.error('[resource-monitor] Resource check failed:', error);
    }
  }

  // Get monitoring statistics
  getMonitoringStats() {
    const sessions = Array.from(this.activeSessions.values());
    const totalMemory = sessions.reduce((sum, session) => sum + session.resourceUsage.memory, 0);
    const totalSockets = sessions.reduce((sum, session) => sum + session.resourceUsage.sockets, 0);
    
    return {
      activeSessions: sessions.length,
      totalMemory,
      totalSockets,
      thresholds: this.thresholds,
      sessionsNeedingRestart: sessions.filter(s => s.needsRestart).length
    };
  }

  // Update thresholds
  updateThresholds(newThresholds) {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    logger.info('[resource-monitor] Thresholds updated:', this.thresholds);
  }
}

module.exports = ResourceMonitor;
