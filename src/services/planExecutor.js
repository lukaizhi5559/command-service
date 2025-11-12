/**
 * Plan Executor
 * 
 * Executes complete automation plans step-by-step with:
 * - Sequential execution
 * - Overall timeout management
 * - Detailed result collection
 */

const { executeStep } = require('./stepExecutor');

/**
 * Execute entire automation plan with step-by-step verification
 * @param {Object} plan - AutomationPlan from backend
 * @returns {Promise<Object>} - Execution result with status and details
 */
async function executePlan(plan) {
  console.log(`\n🚀 [PLAN] Starting automation plan: ${plan.planId}`);
  console.log(`📋 [PLAN] Command: ${plan.originalCommand}`);
  console.log(`📊 [PLAN] Steps: ${plan.steps.length}`);
  console.log(`⏱️  [PLAN] Timeout: ${plan.totalTimeout}ms`);
  console.log(`🔄 [PLAN] Max retries per step: ${plan.maxRetriesPerStep}\n`);
  
  const startTime = Date.now();
  const results = [];
  
  // Set overall timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error('Plan execution timeout')),
      plan.totalTimeout || 300000
    );
  });
  
  try {
    // Execute steps sequentially
    const executionPromise = (async () => {
      for (const step of plan.steps) {
        const result = await executeStep(step, {
          maxRetriesPerStep: plan.maxRetriesPerStep,
          targetOS: plan.targetOS,
          targetApp: plan.targetApp
        });
        
        results.push(result);
        
        // Log progress
        console.log(`[PLAN] Progress: ${results.length}/${plan.steps.length} steps completed`);
      }
    })();
    
    // Race between execution and timeout
    await Promise.race([executionPromise, timeoutPromise]);
    
    const totalTime = Date.now() - startTime;
    
    console.log(`\n✅ [PLAN] Plan completed successfully in ${totalTime}ms`);
    console.log(`📊 [PLAN] Summary:`);
    console.log(`   - Total steps: ${results.length}`);
    console.log(`   - Successful: ${results.filter(r => r.status === 'success').length}`);
    console.log(`   - With retries: ${results.filter(r => r.status === 'success_retry').length}`);
    console.log(`   - Total retries: ${results.reduce((sum, r) => sum + r.retries, 0)}`);
    
    return {
      planId: plan.planId,
      status: 'completed',
      steps: results,
      totalTime,
      summary: {
        totalSteps: results.length,
        successful: results.filter(r => r.status === 'success').length,
        withRetries: results.filter(r => r.status === 'success_retry').length,
        totalRetries: results.reduce((sum, r) => sum + r.retries, 0)
      }
    };
    
  } catch (error) {
    const totalTime = Date.now() - startTime;
    const failedStep = results.length + 1;
    
    console.error(`\n❌ [PLAN] Plan failed at step ${failedStep}: ${error.message}`);
    console.log(`📊 [PLAN] Partial results:`);
    console.log(`   - Completed steps: ${results.length}/${plan.steps.length}`);
    console.log(`   - Failed at: Step ${failedStep}`);
    
    return {
      planId: plan.planId,
      status: 'failed',
      steps: results,
      totalTime,
      failedStep,
      error: error.message,
      summary: {
        totalSteps: plan.steps.length,
        completed: results.length,
        failed: failedStep
      }
    };
  }
}

/**
 * Generate human-readable summary of plan execution
 * @param {Object} result - Plan execution result
 * @returns {string} - Human-readable summary
 */
function generateSummary(result) {
  if (result.status === 'completed') {
    const retryInfo = result.summary.totalRetries > 0
      ? ` (${result.summary.withRetries} steps needed retries)`
      : '';
    
    return `✅ Command completed successfully in ${(result.totalTime / 1000).toFixed(1)}s. ` +
           `Executed ${result.summary.totalSteps} steps${retryInfo}.`;
  } else {
    return `❌ Command failed at step ${result.failedStep}/${result.summary.totalSteps}: ${result.error}. ` +
           `Completed ${result.summary.completed} steps before failure.`;
  }
}

module.exports = {
  executePlan,
  generateSummary
};
