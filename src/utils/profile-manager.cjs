'use strict';

/**
 * Profile Manager - Automated profile management and cleanup
 * 
 * Handles profile lifecycle, integrity validation, and automated cleanup
 * to prevent staleness and resource bloat in browser profiles.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../logger.cjs');

class ProfileManager {
  constructor() {
    this.profilesDir = path.join(os.homedir(), '.thinkdrop', 'browser-profiles');
    this.sessionsDir = path.join(os.homedir(), '.thinkdrop', 'browser-sessions');
    
    // Configuration
    this.cleanupInterval = 24 * 60 * 60 * 1000; // 24 hours
    this.maxProfileAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.maxProfileSize = 50 * 1024 * 1024; // 50MB
    this.maxCookieAge = 30 * 24 * 60 * 60 * 1000; // 30 days for cookies
    
    // Ensure directories exist
    fs.mkdirSync(this.profilesDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    
    // Setup automated cleanup
    this.setupAutomatedCleanup();
  }

  setupAutomatedCleanup() {
    // Initial cleanup after 1 hour
    setTimeout(() => this.performAutomatedCleanup(), 60 * 60 * 1000);
    
    // Schedule regular cleanup every 24 hours
    setInterval(() => this.performAutomatedCleanup(), this.cleanupInterval);
    
    logger.info('[profile-manager] Automated cleanup scheduler initialized');
  }

  async validateProfileIntegrity(sessionId) {
    const profilePath = this.getProfilePath(sessionId);
    const statePath = this.getStatePath(sessionId);
    
    try {
      logger.debug(`[profile-manager] Validating profile integrity: ${sessionId}`);
      
      // Check profile directory
      if (!fs.existsSync(profilePath)) {
        logger.warn(`[profile-manager] Profile directory missing: ${sessionId}`);
        return false;
      }
      
      // Check and validate state file
      if (fs.existsSync(statePath)) {
        const isValid = await this.validateStateFile(statePath);
        if (!isValid) {
          logger.warn(`[profile-manager] Invalid state file for: ${sessionId}`);
          await this.repairProfile(sessionId);
        }
      }
      
      // Check for expired cookies
      await this.cleanupExpiredCookies(sessionId);
      
      // Check profile size
      const size = await this.getProfileSize(sessionId);
      if (size > this.maxProfileSize) {
        logger.warn(`[profile-manager] Profile too large (${size} bytes): ${sessionId}`);
        await this.compressProfile(sessionId);
      }
      
      logger.debug(`[profile-manager] Profile integrity validated: ${sessionId}`);
      return true;
    } catch (error) {
      logger.error(`[profile-manager] Profile validation failed for ${sessionId}:`, error);
      return false;
    }
  }

  async validateStateFile(statePath) {
    try {
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      
      // Basic structure validation
      if (!stateData.cookies || !Array.isArray(stateData.cookies)) {
        return false;
      }
      
      // Check for valid cookie structure
      for (const cookie of stateData.cookies) {
        if (!cookie.name || !cookie.domain) {
          return false;
        }
      }
      
      return true;
    } catch (error) {
      return false;
    }
  }

  async repairProfile(sessionId) {
    try {
      logger.info(`[profile-manager] Repairing profile: ${sessionId}`);
      
      const statePath = this.getStatePath(sessionId);
      
      // Backup existing state
      if (fs.existsSync(statePath)) {
        const backupPath = `${statePath}.backup.${Date.now()}`;
        fs.copyFileSync(statePath, backupPath);
        logger.debug(`[profile-manager] Created backup: ${backupPath}`);
      }
      
      // Create minimal valid state structure
      const minimalState = {
        cookies: [],
        origins: []
      };
      
      fs.writeFileSync(statePath, JSON.stringify(minimalState, null, 2));
      logger.info(`[profile-manager] Profile repaired: ${sessionId}`);
    } catch (error) {
      logger.error(`[profile-manager] Failed to repair profile ${sessionId}:`, error);
    }
  }

  async cleanupExpiredCookies(sessionId) {
    const statePath = this.getStatePath(sessionId);
    
    if (!fs.existsSync(statePath)) {
      return;
    }
    
    try {
      const stateData = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const now = Date.now();
      let cleanedCount = 0;
      
      if (stateData.cookies) {
        const originalCount = stateData.cookies.length;
        stateData.cookies = stateData.cookies.filter(cookie => {
          // Keep session cookies (no expires)
          if (!cookie.expires) {
            return true;
          }
          
          // Remove expired cookies
          const expiresTime = cookie.expires * 1000; // Convert to milliseconds
          if (expiresTime < now) {
            cleanedCount++;
            return false;
          }
          
          // Remove very old cookies even if not expired
          const cookieAge = now - (cookie.created || expiresTime);
          if (cookieAge > this.maxCookieAge) {
            cleanedCount++;
            return false;
          }
          
          return true;
        });
        
        if (cleanedCount > 0) {
          fs.writeFileSync(statePath, JSON.stringify(stateData, null, 2));
          logger.info(`[profile-manager] Cleaned ${cleanedCount} expired cookies for: ${sessionId}`);
        }
      }
    } catch (error) {
      logger.error(`[profile-manager] Failed to cleanup expired cookies for ${sessionId}:`, error);
    }
  }

  async getProfileSize(sessionId) {
    const profilePath = this.getProfilePath(sessionId);
    
    try {
      if (!fs.existsSync(profilePath)) {
        return 0;
      }
      
      const stats = await this.getDirectorySize(profilePath);
      return stats;
    } catch (error) {
      logger.error(`[profile-manager] Failed to get profile size for ${sessionId}:`, error);
      return 0;
    }
  }

  async getDirectorySize(dirPath) {
    let totalSize = 0;
    
    try {
      const files = fs.readdirSync(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        
        if (stats.isDirectory()) {
          totalSize += await this.getDirectorySize(filePath);
        } else {
          totalSize += stats.size;
        }
      }
    } catch (error) {
      logger.error(`[profile-manager] Failed to calculate directory size: ${dirPath}`, error);
    }
    
    return totalSize;
  }

  async compressProfile(sessionId) {
    try {
      logger.info(`[profile-manager] Compressing profile: ${sessionId}`);
      
      // Clean expired cookies first
      await this.cleanupExpiredCookies(sessionId);
      
      // Remove cache directories
      const profilePath = this.getProfilePath(sessionId);
      const cacheDirs = ['Cache', 'Code Cache', 'GPUCache'];
      
      for (const cacheDir of cacheDirs) {
        const cachePath = path.join(profilePath, cacheDir);
        if (fs.existsSync(cachePath)) {
          fs.rmSync(cachePath, { recursive: true, force: true });
          logger.debug(`[profile-manager] Removed cache directory: ${cacheDir}`);
        }
      }
      
      logger.info(`[profile-manager] Profile compressed: ${sessionId}`);
    } catch (error) {
      logger.error(`[profile-manager] Failed to compress profile ${sessionId}:`, error);
    }
  }

  async performAutomatedCleanup() {
    try {
      logger.info('[profile-manager] Starting automated cleanup');
      
      const profiles = await this.getAllProfiles();
      const now = Date.now();
      
      let cleanedCount = 0;
      let validatedCount = 0;
      let compressedCount = 0;
      
      for (const profile of profiles) {
        const age = now - profile.lastModified;
        
        // Skip important profiles
        if (this.isImportantProfile(profile.name)) {
          await this.validateProfileIntegrity(profile.name);
          validatedCount++;
          continue;
        }
        
        // Delete very old profiles
        if (age > this.maxProfileAge) {
          await this.deleteProfile(profile.name);
          cleanedCount++;
          continue;
        }
        
        // Compress large profiles
        if (profile.size > this.maxProfileSize) {
          await this.compressProfile(profile.name);
          compressedCount++;
        }
        
        // Validate other profiles
        await this.validateProfileIntegrity(profile.name);
      }
      
      logger.info(`[profile-manager] Automated cleanup completed: ${cleanedCount} deleted, ${compressedCount} compressed, ${validatedCount} validated`);
    } catch (error) {
      logger.error('[profile-manager] Automated cleanup failed:', error);
    }
  }

  async getAllProfiles() {
    const profiles = [];
    
    try {
      // Check both profile directories and session files
      const profileDirs = fs.existsSync(this.profilesDir) ? fs.readdirSync(this.profilesDir) : [];
      const sessionFiles = fs.existsSync(this.sessionsDir) ? fs.readdirSync(this.sessionsDir) : [];
      
      // Process profile directories
      for (const dir of profileDirs) {
        const profilePath = path.join(this.profilesDir, dir);
        const stats = fs.statSync(profilePath);
        
        profiles.push({
          name: dir,
          path: profilePath,
          type: 'directory',
          lastModified: stats.mtime.getTime(),
          size: await this.getDirectorySize(profilePath)
        });
      }
      
      // Process session files
      for (const file of sessionFiles) {
        if (file.endsWith('.json')) {
          const sessionName = file.replace('.json', '');
          const sessionPath = path.join(this.sessionsDir, file);
          const stats = fs.statSync(sessionPath);
          
          // Avoid duplicates
          if (!profiles.find(p => p.name === sessionName)) {
            profiles.push({
              name: sessionName,
              path: sessionPath,
              type: 'session',
              lastModified: stats.mtime.getTime(),
              size: stats.size
            });
          }
        }
      }
    } catch (error) {
      logger.warn('[profile-manager] Failed to list profiles:', error);
    }
    
    return profiles;
  }

  isImportantProfile(profileName) {
    // Important profiles that should never be automatically deleted
    const importantProfiles = ['gmail_agent', 'slack_agent', 'notion_agent', 'default'];
    return importantProfiles.some(pattern => profileName.includes(pattern));
  }

  async deleteProfile(profileName) {
    try {
      const profilePath = this.getProfilePath(profileName);
      const statePath = this.getStatePath(profileName);
      
      // Delete profile directory
      if (fs.existsSync(profilePath)) {
        fs.rmSync(profilePath, { recursive: true, force: true });
        logger.info(`[profile-manager] Deleted profile directory: ${profileName}`);
      }
      
      // Delete state file
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        logger.info(`[profile-manager] Deleted state file: ${profileName}`);
      }
      
      logger.info(`[profile-manager] Deleted profile: ${profileName}`);
    } catch (error) {
      logger.error(`[profile-manager] Failed to delete profile ${profileName}:`, error);
    }
  }

  getProfilePath(sessionId) {
    return path.join(this.profilesDir, sessionId);
  }

  getStatePath(sessionId) {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  // Manual cleanup trigger
  async triggerCleanup() {
    logger.info('[profile-manager] Manual cleanup triggered');
    await this.performAutomatedCleanup();
  }

  // Get profile statistics
  async getProfileStats() {
    const profiles = await this.getAllProfiles();
    const totalSize = profiles.reduce((sum, profile) => sum + profile.size, 0);
    const importantProfiles = profiles.filter(p => this.isImportantProfile(p.name));
    const oldProfiles = profiles.filter(p => Date.now() - p.lastModified > this.maxProfileAge);
    
    return {
      totalProfiles: profiles.length,
      totalSize,
      importantProfiles: importantProfiles.length,
      oldProfiles: oldProfiles.length,
      largestProfiles: profiles.sort((a, b) => b.size - a.size).slice(0, 5)
    };
  }
}

module.exports = ProfileManager;
