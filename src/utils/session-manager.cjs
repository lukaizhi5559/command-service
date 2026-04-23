'use strict';

/**
 * Session Manager - Skills-based session management for ThinkDrop
 * 
 * Implements best practices from playwright-cli skills:
 * - Session isolation properties
 * - Storage state management  
 * - Persistent profile handling
 * - Automated cleanup and validation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger.cjs');

class SessionManager {
  constructor() {
    this.sessionsDir = path.join(os.homedir(), '.thinkdrop', 'browser-sessions');
    this.profilesDir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
    this.skillsConfig = this.loadSkillsConfiguration();
    
    // Ensure directories exist
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.profilesDir, { recursive: true });
    
    // Setup cleanup scheduler
    this.setupCleanupScheduler();
  }

  loadSkillsConfiguration() {
    // Load skills-based configuration patterns
    return {
      sessionIsolation: {
        independentCookies: true,
        independentLocalStorage: true,
        independentSessionStorage: true,
        independentCache: true,
        independentHistory: true,
        independentTabs: true
      },
      storageState: {
        preserveCookies: true,
        preserveLocalStorage: true,
        preserveSessionStorage: true,
        validateIntegrity: true,
        cleanupExpired: true
      },
      persistentProfiles: {
        enabled: ['agent', 'gmail', 'slack', 'notion'],
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        maxSize: 50 * 1024 * 1024, // 50MB
        autoCleanup: true
      }
    };
  }

  // From session-management.md: session isolation properties
  createIsolatedSession(sessionId, options = {}) {
    const config = {
      isolated: true, // Independent cookies, storage, cache
      persistent: options.persistent || this.shouldUsePersistentProfile(sessionId),
      debugging: this.shouldEnableDebugging(sessionId),
      agentId: options.agentId || 'default',
      ...options
    };

    logger.debug(`[session-manager] Creating isolated session: ${sessionId}`, config);
    return this.applySkillsPatterns(sessionId, config);
  }

  applySkillsPatterns(sessionId, config) {
    // Apply skills-based session management patterns
    const sessionConfig = {
      sessionId,
      flags: [`-s=${sessionId}`],
      ...config
    };

    // Skills pattern: persistent profiles for agent sessions
    if (config.persistent) {
      sessionConfig.flags.push('--persistent');
      logger.debug(`[session-manager] Applied persistent profile pattern for: ${sessionId}`);
    }

    // Skills pattern: session isolation
    if (config.isolated) {
      sessionConfig.isolation = this.skillsConfig.sessionIsolation;
    }

    return sessionConfig;
  }

  // From storage-state.md: storage state management
  async preserveStorageState(sessionId) {
    const statePath = this.getStorageStatePath(sessionId);
    
    try {
      logger.debug(`[session-manager] Preserving storage state for: ${sessionId}`);
      
      // Use playwright-cli state-save (skills pattern)
      const { cliRun } = require('../skills/browser.act.cjs');
      await cliRun(['state-save', statePath]);
      
      // Validate and clean state (skills pattern)
      await this.validateAndCleanStorageState(statePath);
      
      logger.info(`[session-manager] Storage state preserved for: ${sessionId}`);
      return statePath;
    } catch (error) {
      logger.error(`[session-manager] Failed to preserve storage state for ${sessionId}:`, error);
      throw error;
    }
  }

  async loadStorageState(sessionId) {
    const statePath = this.getStorageStatePath(sessionId);
    
    if (!fs.existsSync(statePath)) {
      logger.warn(`[session-manager] No storage state found for: ${sessionId}`);
      return null;
    }

    try {
      logger.debug(`[session-manager] Loading storage state for: ${sessionId}`);
      
      // Use playwright-cli state-load (skills pattern)
      const { cliRun } = require('../skills/browser.act.cjs');
      await cliRun(['state-load', statePath]);
      
      logger.info(`[session-manager] Storage state loaded for: ${sessionId}`);
      return true;
    } catch (error) {
      logger.error(`[session-manager] Failed to load storage state for ${sessionId}:`, error);
      throw error;
    }
  }

  getStorageStatePath(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  async validateAndCleanStorageState(statePath) {
    try {
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      
      // Skills pattern: validate and clean expired data
      if (stateData.cookies) {
        const now = Date.now();
        stateData.cookies = stateData.cookies.filter(cookie => {
          // Remove expired cookies
          if (cookie.expires && cookie.expires * 1000 < now) {
            return false;
          }
          return true;
        });
      }

      // Write cleaned state back
      fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
      logger.debug(`[session-manager] Storage state validated and cleaned: ${statePath}`);
    } catch (error) {
      logger.warn(`[session-manager] Failed to validate storage state ${statePath}:`, error);
    }
  }

  shouldUsePersistentProfile(sessionId) {
    // Skills pattern: persistent profiles for agent sessions
    return this.skillsConfig.persistentProfiles.enabled.some(pattern => 
      sessionId.includes(pattern)
    );
  }

  shouldEnableDebugging(sessionId) {
    // Generic debugging control (from browser.act.cjs)
    return process.env.PLAYWRIGHT_DEBUG === 'true' || 
           process.env.PLAYWRIGHT_DEBUG === 'on' || 
           process.env.PLAYWRIGHT_DEBUG === '1';
  }

  // Automated profile cleanup (skills pattern)
  setupCleanupScheduler() {
    // Run cleanup every 24 hours
    const cleanupInterval = 24 * 60 * 60 * 1000;
    
    // Initial cleanup after 1 hour
    setTimeout(() => this.cleanupStaleProfiles(), 60 * 60 * 1000);
    
    // Schedule regular cleanup
    setInterval(() => this.cleanupStaleProfiles(), cleanupInterval);
    
    logger.info('[session-manager] Automated cleanup scheduler initialized');
  }

  async cleanupStaleProfiles() {
    try {
      logger.info('[session-manager] Starting automated profile cleanup');
      
      const sessions = await this.getAllSessions();
      const now = Date.now();
      const config = this.skillsConfig.persistentProfiles;
      
      let cleanedCount = 0;
      let preservedCount = 0;

      for (const session of sessions) {
        const age = now - session.lastModified;
        
        // Skip important profiles (gmail_agent, etc.)
        if (this.isImportantProfile(session.name)) {
          await this.validateProfileIntegrity(session.name);
          preservedCount++;
          continue;
        }
        
        // Delete old profiles
        if (age > config.maxAge) {
          await this.deleteSession(session.name);
          cleanedCount++;
        } else if (session.size > config.maxSize) {
          await this.compressSession(session.name);
          cleanedCount++;
        }
      }

      logger.info(`[session-manager] Cleanup completed: ${cleanedCount} cleaned, ${preservedCount} preserved`);
    } catch (error) {
      logger.error('[session-manager] Automated cleanup failed:', error);
    }
  }

  async getAllSessions() {
    const sessions = [];
    
    try {
      const files = fs.readdirSync(this.sessionsDir);
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.sessionsDir, file);
          const stats = fs.statSync(filePath);
          
          sessions.push({
            name: file.replace('.json', ''),
            path: filePath,
            lastModified: stats.mtime.getTime(),
            size: stats.size
          });
        }
      }
    } catch (error) {
      logger.warn('[session-manager] Failed to list sessions:', error);
    }
    
    return sessions;
  }

  isImportantProfile(sessionName) {
    // Important profiles that should never be automatically deleted
    const importantProfiles = ['gmail_agent', 'slack_agent', 'notion_agent'];
    return importantProfiles.some(pattern => sessionName.includes(pattern));
  }

  async validateProfileIntegrity(sessionName) {
    const statePath = this.getStorageStatePath(sessionName);
    
    try {
      if (!fs.existsSync(statePath)) {
        logger.warn(`[session-manager] Profile file missing for: ${sessionName}`);
        return false;
      }

      // Validate JSON structure
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      
      // Basic validation
      if (!stateData.cookies || !Array.isArray(stateData.cookies)) {
        logger.warn(`[session-manager] Invalid profile structure for: ${sessionName}`);
        return false;
      }

      // Clean expired data
      await this.validateAndCleanStorageState(statePath);
      
      logger.debug(`[session-manager] Profile integrity validated: ${sessionName}`);
      return true;
    } catch (error) {
      logger.error(`[session-manager] Profile validation failed for ${sessionName}:`, error);
      return false;
    }
  }

  async deleteSession(sessionName) {
    try {
      const statePath = this.getStorageStatePath(sessionName);
      const profilePath = path.join(this.profilesDir, sessionName);
      
      // Delete state file
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
      
      // Delete profile directory
      if (fs.existsSync(profilePath)) {
        fs.rmSync(profilePath, { recursive: true, force: true });
      }
      
      logger.info(`[session-manager] Deleted session: ${sessionName}`);
    } catch (error) {
      logger.error(`[session-manager] Failed to delete session ${sessionName}:`, error);
    }
  }

  async compressSession(sessionName) {
    try {
      const statePath = this.getStorageStatePath(sessionName);
      
      if (fs.existsSync(statePath)) {
        // Read, clean, and rewrite the state file to remove bloat
        await this.validateAndCleanStorageState(statePath);
        logger.info(`[session-manager] Compressed session: ${sessionName}`);
      }
    } catch (error) {
      logger.error(`[session-manager] Failed to compress session ${sessionName}:`, error);
    }
  }

  // Skills pattern: session lifecycle management
  async createSession(sessionId, options = {}) {
    const sessionConfig = this.createIsolatedSession(sessionId, options);
    
    logger.info(`[session-manager] Created session: ${sessionId}`, {
      persistent: sessionConfig.persistent,
      isolated: sessionConfig.isolated
    });
    
    return sessionConfig;
  }

  async cleanupSession(sessionId) {
    try {
      // Preserve state before cleanup (skills pattern)
      if (this.shouldUsePersistentProfile(sessionId)) {
        await this.preserveStorageState(sessionId);
      }
      
      // Clean up session resources
      logger.info(`[session-manager] Cleaned up session: ${sessionId}`);
      return true;
    } catch (error) {
      logger.error(`[session-manager] Failed to cleanup session ${sessionId}:`, error);
      return false;
    }
  }
}

module.exports = SessionManager;
