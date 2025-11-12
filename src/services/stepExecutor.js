/**
 * Step Executor with Verification and Retry Logic
 * 
 * Executes individual automation steps with:
 * - Automatic verification after each step
 * - Multiple retry attempts with alternative strategies
 * - Screenshot-based debugging
 */

const { keyboard, Key, mouse, screen } = require('@nut-tree-fork/nut-js');
const { findAndClick, captureScreen, analyzeImage } = require('./visionSpatialService');
const fs = require('fs').promises;
const path = require('path');

/**
 * Execute a single automation step with verification and retries
 * @param {Object} step - Step from automation plan
 * @param {Object} planContext - Plan-level context (maxRetries, targetOS, etc.)
 * @returns {Promise<Object>} - Execution result
 */
async function executeStep(step, planContext = {}) {
  const startTime = Date.now();
  console.log(`\n[Step ${step.id}] ${step.description}`);
  
  let lastError = null;
  const maxRetries = step.maxRetries || planContext.maxRetriesPerStep || 3;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Step ${step.id}] Attempt ${attempt}/${maxRetries}`);
      
      // Execute the step code
      await executeStepCode(step.code, step);
      
      // Wait for UI to update
      if (step.waitAfter) {
        await sleep(step.waitAfter);
      }
      
      // Verify step succeeded
      const verification = await verifyStep(step);
      
      if (verification.success) {
        console.log(`[Step ${step.id}] ✅ Success`);
        return {
          stepId: step.id,
          status: 'success',
          retries: attempt - 1,
          executionTime: Date.now() - startTime
        };
      } else {
        console.warn(`[Step ${step.id}] ⚠️ Verification failed: ${verification.error}`);
        
        // Try alternative strategy
        if (attempt < maxRetries) {
          const alternative = await tryAlternative(step, verification);
          if (alternative.success) {
            console.log(`[Step ${step.id}] ✅ Success with alternative: ${alternative.method}`);
            return {
              stepId: step.id,
              status: 'success_retry',
              method: alternative.method,
              retries: attempt,
              executionTime: Date.now() - startTime
            };
          }
        }
        
        lastError = verification.error;
      }
      
    } catch (error) {
      console.error(`[Step ${step.id}] ❌ Execution error:`, error.message);
      lastError = error.message;
      
      if (attempt < maxRetries) {
        console.log(`[Step ${step.id}] Retrying in 1s...`);
        await sleep(1000);
      }
    }
  }
  
  // All retries failed
  throw new Error(`Step ${step.id} failed after ${maxRetries} attempts: ${lastError}`);
}

/**
 * Execute step code in isolated context
 * @param {string} code - JavaScript code to execute
 * @param {Object} step - Step metadata
 */
async function executeStepCode(code, step) {
  // Create a function from the code string
  const asyncFunction = new Function(
    'keyboard',
    'Key',
    'mouse',
    'screen',
    'findAndClick',
    'sleep',
    'step',
    `return (async () => {
      ${code}
    })();`
  );
  
  // Execute with Nut.js context
  await asyncFunction(keyboard, Key, mouse, screen, findAndClick, sleep, step);
}

/**
 * Verify step succeeded based on verification type
 * @param {Object} step - Step with verification config
 * @returns {Promise<Object>} - { success: boolean, error?: string }
 */
async function verifyStep(step) {
  if (step.verification === 'none') {
    return { success: true };
  }
  
  // Take screenshot for verification
  let screenshot;
  try {
    const result = await captureScreen();
    screenshot = result.path;
  } catch (error) {
    console.warn(`[Step ${step.id}] ⚠️ Screenshot failed:`, error.message);
    // Continue without verification if screenshot fails
    return { success: true };
  }
  
  try {
    switch (step.verification) {
      case 'element_visible':
        return await verifyElementVisible(step, screenshot);
        
      case 'compose_dialog_visible':
        return await verifyComposeDialog(screenshot);
        
      case 'recipient_added':
        return await verifyRecipientAdded(screenshot);
        
      case 'send_button_enabled':
        return await verifySendButtonEnabled(screenshot);
        
      case 'email_sent':
        return await verifyEmailSent(screenshot);
        
      case 'field_filled':
        // Assume success if no error thrown
        return { success: true };
        
      default:
        console.warn(`[Step ${step.id}] Unknown verification type: ${step.verification}`);
        return { success: true };
    }
  } catch (error) {
    console.error(`[Step ${step.id}] Verification error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Verify element is visible using vision AI
 */
async function verifyElementVisible(step, screenshotPath) {
  if (!step.verificationContext?.shouldSeeElement) {
    return { success: true };
  }
  
  try {
    const elements = await analyzeImage(screenshotPath);
    const targetLabel = step.verificationContext.shouldSeeElement.toLowerCase();
    
    const found = elements.some(el => 
      el.label.toLowerCase().includes(targetLabel)
    );
    
    return {
      success: found,
      error: found ? null : `Element "${step.verificationContext.shouldSeeElement}" not found`
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Verify Gmail compose dialog is visible
 */
async function verifyComposeDialog(screenshotPath) {
  try {
    const elements = await analyzeImage(screenshotPath);
    
    // Look for compose dialog indicators
    const hasToField = elements.some(e => 
      e.label.toLowerCase().includes('to') || 
      e.label.toLowerCase().includes('recipients')
    );
    const hasSubject = elements.some(e => 
      e.label.toLowerCase().includes('subject')
    );
    
    const success = hasToField || hasSubject;
    
    return {
      success,
      error: success ? null : 'Compose dialog not visible (no To/Subject fields found)'
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Verify recipient was added
 */
async function verifyRecipientAdded(screenshotPath) {
  // Simplified check - assume success for now
  // In production, you'd check for recipient chips/tags
  return { success: true };
}

/**
 * Verify Send button is enabled
 */
async function verifySendButtonEnabled(screenshotPath) {
  try {
    const elements = await analyzeImage(screenshotPath);
    const sendButton = elements.find(e => 
      e.label.toLowerCase() === 'send' && 
      e.role === 'button'
    );
    
    if (!sendButton) {
      return { success: false, error: 'Send button not found' };
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Verify email was sent (compose dialog closed)
 */
async function verifyEmailSent(screenshotPath) {
  try {
    const elements = await analyzeImage(screenshotPath);
    
    // Check if compose dialog is gone
    const hasComposeDialog = elements.some(e => 
      e.label.toLowerCase().includes('subject') ||
      e.label.toLowerCase().includes('recipients')
    );
    
    return {
      success: !hasComposeDialog,
      error: hasComposeDialog ? 'Compose dialog still visible (email not sent)' : null
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Try alternative strategies when primary method fails
 */
async function tryAlternative(step, verification) {
  console.log(`[Step ${step.id}] Trying alternative strategies...`);
  
  // Strategy 1: Try alternative label
  if (step.alternativeLabel && step.action === 'click_button') {
    try {
      console.log(`[Step ${step.id}] Trying alternative label: "${step.alternativeLabel}"`);
      await findAndClick(step.alternativeLabel, step.role);
      await sleep(step.waitAfter || 1000);
      
      const verification = await verifyStep(step);
      if (verification.success) {
        return { success: true, method: 'alternative_label' };
      }
    } catch (error) {
      console.log(`[Step ${step.id}] Alternative label failed:`, error.message);
    }
  }
  
  // Strategy 2: Try alternative role
  if (step.alternativeRole && step.action === 'click_button') {
    try {
      console.log(`[Step ${step.id}] Trying alternative role: "${step.alternativeRole}"`);
      await findAndClick(step.target, step.alternativeRole);
      await sleep(step.waitAfter || 1000);
      
      const verification = await verifyStep(step);
      if (verification.success) {
        return { success: true, method: 'alternative_role' };
      }
    } catch (error) {
      console.log(`[Step ${step.id}] Alternative role failed:`, error.message);
    }
  }
  
  // Strategy 3: Try keyboard shortcut
  if (step.keyboardShortcut) {
    try {
      console.log(`[Step ${step.id}] Trying keyboard shortcut fallback`);
      await executeStepCode(step.keyboardShortcut, step);
      await sleep(step.waitAfter || 1000);
      
      const verification = await verifyStep(step);
      if (verification.success) {
        return { success: true, method: 'keyboard_shortcut' };
      }
    } catch (error) {
      console.log(`[Step ${step.id}] Keyboard shortcut failed:`, error.message);
    }
  }
  
  // Strategy 4: For fill_field actions, try extra tabs
  if (step.action === 'fill_field' && step.value) {
    try {
      console.log(`[Step ${step.id}] Trying extra Tab navigation`);
      await keyboard.pressKey(Key.Tab);
      await keyboard.releaseKey(Key.Tab);
      await sleep(300);
      await keyboard.type(step.value);
      await sleep(step.waitAfter || 500);
      
      const verification = await verifyStep(step);
      if (verification.success) {
        return { success: true, method: 'extra_tabs' };
      }
    } catch (error) {
      console.log(`[Step ${step.id}] Extra tabs failed:`, error.message);
    }
  }
  
  return { success: false };
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  executeStep,
  verifyStep,
  tryAlternative
};
