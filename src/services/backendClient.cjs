/**
 * Backend Client for Automation Plan Generation
 * 
 * Communicates with bibscrip-backend to fetch structured automation plans
 * instead of raw code. Enables step-by-step execution with verification.
 */

const axios = require('axios');

// Configuration from environment
const BACKEND_API_URL = process.env.NUTJS_API_URL || 'http://localhost:4000/api/nutjs';
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || process.env.THINKDROP_API_KEY;
const MAX_RETRIES_PER_STEP = parseInt(process.env.MAX_RETRIES_PER_STEP || '3', 10);
const PLAN_TIMEOUT_MS = parseInt(process.env.PLAN_TIMEOUT_MS || '300000', 10);

/**
 * Fetch structured automation plan from backend
 * @param {string} command - Natural language command
 * @param {Object} context - Additional context (os, userId, etc.)
 * @returns {Promise<Object>} - AutomationPlan object
 */
async function fetchAutomationPlan(command, context = {}) {
  console.log(`\n🔄 [BACKEND] Fetching automation plan for: "${command}"`);
  
  const planEndpoint = BACKEND_API_URL.replace('/api/nutjs', '/api/nutjs/plan');
  
  try {
    const response = await axios.post(
      planEndpoint,
      {
        command,
        context: {
          os: context.os || process.platform,
          userId: context.userId,
          sessionId: context.sessionId
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': BACKEND_API_KEY
        },
        timeout: PLAN_TIMEOUT_MS // 30 seconds for plan generation
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Backend returned unsuccessful response');
    }

    const plan = response.data.plan;
    
    // Ensure plan has maxRetriesPerStep set (use env var as fallback)
    if (!plan.maxRetriesPerStep) {
      plan.maxRetriesPerStep = MAX_RETRIES_PER_STEP;
    }
    
    // Ensure plan has totalTimeout set (use env var as fallback)
    if (!plan.totalTimeout) {
      plan.totalTimeout = PLAN_TIMEOUT_MS;
    }
    
    console.log(`✅ [BACKEND] Plan generated successfully`);
    console.log(`   📋 Plan ID: ${plan.planId}`);
    console.log(`   📊 Steps: ${plan.steps.length}`);
    console.log(`   🎯 Target: ${plan.targetApp || 'unknown'}`);
    console.log(`   ⏱️  Timeout: ${plan.totalTimeout}ms`);
    console.log(`   🔄 Max retries per step: ${plan.maxRetriesPerStep}`);
    
    return plan;
    
  } catch (error) {
    if (error.response) {
      // Backend returned an error response
      console.error(`❌ [BACKEND] API error (${error.response.status}):`, error.response.data);
      throw new Error(`Backend API error: ${error.response.data.error || error.response.statusText}`);
    } else if (error.request) {
      // Request was made but no response received
      console.error(`❌ [BACKEND] No response from backend:`, error.message);
      throw new Error(`Backend not responding: ${error.message}`);
    } else {
      // Something else went wrong
      console.error(`❌ [BACKEND] Request error:`, error.message);
      throw new Error(`Failed to fetch plan: ${error.message}`);
    }
  }
}

/**
 * Fallback: Fetch raw code (old endpoint) if plan endpoint fails
 * @param {string} command - Natural language command
 * @param {Object} context - Additional context
 * @returns {Promise<string>} - Raw automation code
 */
async function fetchAutomationCode(command, context = {}) {
  console.log(`\n🔄 [BACKEND] Fetching raw code (fallback) for: "${command}"`);
  
  try {
    const response = await axios.post(
      BACKEND_URL,
      {
        command,
        context: {
          os: context.os || process.platform,
          userId: context.userId,
          sessionId: context.sessionId
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(BACKEND_API_KEY && { 'Authorization': `Bearer ${BACKEND_API_KEY}` })
        },
        timeout: 300000
      }
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'Backend returned unsuccessful response');
    }

    console.log(`✅ [BACKEND] Code generated successfully`);
    return response.data.code;
    
  } catch (error) {
    console.error(`❌ [BACKEND] Failed to fetch code:`, error.message);
    throw error;
  }
}

module.exports = {
  fetchAutomationPlan,
  fetchAutomationCode
};
