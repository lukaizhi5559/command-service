/**
 * Guide State Manager - Persistence layer for guide state
 * Stores guide state in a simple JSON file for now (can be upgraded to SQLite later)
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('../logger.cjs');

class GuideStateManager {
  constructor() {
    this.stateDir = path.join(__dirname, '../../data');
    this.stateFile = path.join(this.stateDir, 'guide-state.json');
    this.state = new Map(); // In-memory cache
    this.initialized = false;
  }

  /**
   * Initialize the state manager
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // Ensure data directory exists
      await fs.mkdir(this.stateDir, { recursive: true });

      // Load existing state if available
      try {
        const data = await fs.readFile(this.stateFile, 'utf8');
        const parsed = JSON.parse(data);
        this.state = new Map(Object.entries(parsed));
        logger.info('Guide state loaded', { guides: this.state.size });
      } catch (err) {
        if (err.code !== 'ENOENT') {
          logger.warn('Failed to load guide state, starting fresh', { error: err.message });
        }
        // File doesn't exist yet, that's ok
      }

      this.initialized = true;
      logger.info('GuideStateManager initialized');
    } catch (error) {
      logger.error('Failed to initialize GuideStateManager', { error: error.message });
      throw error;
    }
  }

  /**
   * Save state to disk
   */
  async persist() {
    try {
      const obj = Object.fromEntries(this.state);
      await fs.writeFile(this.stateFile, JSON.stringify(obj, null, 2), 'utf8');
      logger.debug('Guide state persisted', { guides: this.state.size });
    } catch (error) {
      logger.error('Failed to persist guide state', { error: error.message });
      throw error;
    }
  }

  /**
   * Create or update guide state
   * @param {string} guideId - Unique guide identifier
   * @param {Object} guideData - Guide data from backend
   * @param {Object} options - Additional options
   */
  async saveGuideState(guideId, guideData, options = {}) {
    if (!this.initialized) await this.initialize();

    const state = {
      guideId,
      command: options.command || guideData.originalCommand,
      guide: guideData,
      currentStepIndex: options.currentStepIndex || 0,
      status: options.status || 'active', // active, executing, completed, aborted
      executionHistory: options.executionHistory || [],
      createdAt: options.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        totalSteps: guideData.totalSteps || guideData.steps?.length || 0,
        completedSteps: options.completedSteps || 0,
        ...options.metadata
      }
    };

    this.state.set(guideId, state);
    await this.persist();

    logger.info('Guide state saved', {
      guideId,
      status: state.status,
      currentStep: state.currentStepIndex,
      totalSteps: state.metadata.totalSteps
    });

    return state;
  }

  /**
   * Get guide state by ID
   * @param {string} guideId
   * @returns {Object|null}
   */
  async getGuideState(guideId) {
    if (!this.initialized) await this.initialize();
    return this.state.get(guideId) || null;
  }

  /**
   * Update guide step position
   * @param {string} guideId
   * @param {number} stepIndex
   */
  async updateStepPosition(guideId, stepIndex) {
    if (!this.initialized) await this.initialize();

    const state = this.state.get(guideId);
    if (!state) {
      throw new Error(`Guide state not found: ${guideId}`);
    }

    state.currentStepIndex = stepIndex;
    state.updatedAt = new Date().toISOString();

    this.state.set(guideId, state);
    await this.persist();

    logger.debug('Guide step position updated', { guideId, stepIndex });
    return state;
  }

  /**
   * Update guide status
   * @param {string} guideId
   * @param {string} status - active, executing, completed, aborted
   * @param {Object} metadata - Additional metadata
   */
  async updateGuideStatus(guideId, status, metadata = {}) {
    if (!this.initialized) await this.initialize();

    const state = this.state.get(guideId);
    if (!state) {
      throw new Error(`Guide state not found: ${guideId}`);
    }

    state.status = status;
    state.updatedAt = new Date().toISOString();
    state.metadata = { ...state.metadata, ...metadata };

    this.state.set(guideId, state);
    await this.persist();

    logger.info('Guide status updated', { guideId, status, metadata });
    return state;
  }

  /**
   * Add execution result to history
   * @param {string} guideId
   * @param {Object} executionResult
   */
  async addExecutionResult(guideId, executionResult) {
    if (!this.initialized) await this.initialize();

    const state = this.state.get(guideId);
    if (!state) {
      throw new Error(`Guide state not found: ${guideId}`);
    }

    state.executionHistory.push({
      timestamp: new Date().toISOString(),
      ...executionResult
    });

    state.updatedAt = new Date().toISOString();
    this.state.set(guideId, state);
    await this.persist();

    logger.debug('Execution result added to guide history', { guideId });
    return state;
  }

  /**
   * Get all active guides
   * @returns {Array}
   */
  async getActiveGuides() {
    if (!this.initialized) await this.initialize();

    return Array.from(this.state.values()).filter(
      state => state.status === 'active' || state.status === 'executing'
    );
  }

  /**
   * Delete guide state
   * @param {string} guideId
   */
  async deleteGuideState(guideId) {
    if (!this.initialized) await this.initialize();

    const deleted = this.state.delete(guideId);
    if (deleted) {
      await this.persist();
      logger.info('Guide state deleted', { guideId });
    }

    return deleted;
  }

  /**
   * Clear all guide states (for testing/cleanup)
   */
  async clearAll() {
    if (!this.initialized) await this.initialize();

    this.state.clear();
    await this.persist();
    logger.info('All guide states cleared');
  }
}

// Singleton instance
const guideStateManager = new GuideStateManager();

module.exports = guideStateManager;
