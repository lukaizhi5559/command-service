/**
 * Gmail Compose Example with Vision Spatial Awareness
 * 
 * This example demonstrates how to use the vision service to reliably
 * click the Gmail Compose button without hard-coded coordinates.
 * 
 * It uses a hybrid approach:
 * 1. Try keyboard shortcut (fast)
 * 2. Try fixed coordinates (fast, works for standard layout)
 * 3. Fall back to vision AI (robust, works for any layout)
 */

const { keyboard, Key, mouse, straightTo, Point } = require('@nut-tree-fork/nut-js');
const { findAndClick, getUIMap } = require('../src/services/visionSpatialService');

// Configure Nut.js for reliability
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openGmail() {
  console.log('🌐 Opening Gmail...');
  
  // Open Spotlight/Launcher
  await keyboard.pressKey(Key.LeftSuper, Key.Space);
  await keyboard.releaseKey(Key.LeftSuper, Key.Space);
  await sleep(500);
  
  // Open Chrome
  await keyboard.type('Google Chrome');
  await keyboard.pressKey(Key.Return);
  await keyboard.releaseKey(Key.Return);
  await sleep(3000);
  
  // Open new tab
  await keyboard.pressKey(Key.LeftSuper, Key.T);
  await keyboard.releaseKey(Key.LeftSuper, Key.T);
  await sleep(500);
  
  // Navigate to Gmail
  await keyboard.type('https://mail.google.com');
  await keyboard.pressKey(Key.Return);
  await keyboard.releaseKey(Key.Return);
  
  console.log('⏳ Waiting for Gmail to load...');
  await sleep(6000); // Wait for page to fully load
}

async function clickComposeWithVision() {
  console.log('🔍 Using vision AI to find Compose button...');
  
  const success = await findAndClick('Compose', 'button');
  
  if (success) {
    console.log('✅ Compose button clicked successfully!');
    return true;
  } else {
    console.error('❌ Could not find Compose button');
    return false;
  }
}

async function clickComposeHybrid() {
  console.log('📧 Attempting to open Gmail Compose...');
  
  // Strategy 1: Try keyboard shortcut (fastest)
  console.log('1️⃣ Trying keyboard shortcut (C)...');
  try {
    await keyboard.type('c');
    await sleep(1500);
    
    // Check if compose window opened by looking for "To" field
    const map = await getUIMap();
    const toField = map.find(el => 
      el.label.toLowerCase().includes('to') && 
      el.role === 'input'
    );
    
    if (toField) {
      console.log('✅ Keyboard shortcut worked!');
      return true;
    }
  } catch (error) {
    console.log('⚠️ Keyboard shortcut failed:', error.message);
  }
  
  // Strategy 2: Try fixed coordinates (fast, works for standard layout)
  console.log('2️⃣ Trying fixed coordinates (70, 175)...');
  try {
    await mouse.move(straightTo(new Point(70, 175)));
    await mouse.leftClick();
    await sleep(1500);
    
    // Check if compose opened
    const map = await getUIMap();
    const toField = map.find(el => 
      el.label.toLowerCase().includes('to') && 
      el.role === 'input'
    );
    
    if (toField) {
      console.log('✅ Fixed coordinates worked!');
      return true;
    }
  } catch (error) {
    console.log('⚠️ Fixed coordinates failed:', error.message);
  }
  
  // Strategy 3: Use vision AI (most reliable)
  console.log('3️⃣ Falling back to vision AI...');
  return await clickComposeWithVision();
}

async function fillEmailWithVision(to, subject, body) {
  console.log('✍️ Filling email fields...');
  
  // Get UI map
  const map = await getUIMap();
  
  // Fill "To" field
  const toField = map.find(el => 
    el.label.toLowerCase().includes('to') && 
    el.role === 'input'
  );
  
  if (toField) {
    console.log('📧 Filling To field...');
    await findAndClick('To', 'input');
    await sleep(300);
    await keyboard.type(to);
  }
  
  // Fill "Subject" field
  await sleep(500);
  const subjectField = map.find(el => 
    el.label.toLowerCase().includes('subject') && 
    el.role === 'input'
  );
  
  if (subjectField) {
    console.log('📝 Filling Subject field...');
    await findAndClick('Subject', 'input');
    await sleep(300);
    await keyboard.type(subject);
  }
  
  // Fill body
  await sleep(500);
  console.log('💬 Filling email body...');
  await keyboard.pressKey(Key.Tab);
  await keyboard.releaseKey(Key.Tab);
  await sleep(300);
  await keyboard.type(body);
  
  console.log('✅ Email filled successfully!');
}

// Main execution
(async () => {
  try {
    console.log('🚀 Starting Gmail Compose automation with Vision AI...\n');
    
    // Step 1: Open Gmail
    await openGmail();
    
    // Step 2: Click Compose (hybrid approach)
    const composeOpened = await clickComposeHybrid();
    
    if (!composeOpened) {
      throw new Error('Failed to open compose window');
    }
    
    // Step 3: Fill email fields
    await sleep(1000);
    await fillEmailWithVision(
      'friend@example.com',
      'Test Email from Vision AI',
      'This email was composed using vision-based spatial awareness! 🎉'
    );
    
    console.log('\n✅ Automation complete!');
    console.log('📧 Email draft is ready to send');
    
  } catch (error) {
    console.error('\n❌ Automation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
