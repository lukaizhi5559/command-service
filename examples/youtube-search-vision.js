/**
 * YouTube Search Example with Vision Spatial Awareness
 * 
 * This example demonstrates how to use the vision service to:
 * 1. Open YouTube
 * 2. Find and click the search box
 * 3. Perform a search
 */

const { keyboard, Key, mouse, straightTo, Point } = require('@nut-tree-fork/nut-js');
const { findAndClick } = require('../src/services/visionSpatialService');

// Configure Nut.js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openYouTube() {
  console.log('🌐 Opening YouTube...');
  
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
  
  // Navigate to YouTube
  await keyboard.type('https://youtube.com');
  await keyboard.pressKey(Key.Return);
  await keyboard.releaseKey(Key.Return);
  
  console.log('⏳ Waiting for YouTube to load...');
  await sleep(4000);
}

async function searchYouTube(query) {
  console.log(`🔍 Searching for: "${query}"`);
  
  // Find and click search box using vision
  console.log('👁️ Using vision AI to find search box...');
  const searchClicked = await findAndClick('Search', 'input');
  
  if (!searchClicked) {
    // Try alternative labels
    const altClicked = await findAndClick('search', 'input');
    if (!altClicked) {
      throw new Error('Could not find search box');
    }
  }
  
  console.log('✅ Search box clicked!');
  await sleep(500);
  
  // Type search query
  console.log('⌨️ Typing search query...');
  await keyboard.type(query);
  await sleep(500);
  
  // Press Enter
  await keyboard.pressKey(Key.Return);
  await keyboard.releaseKey(Key.Return);
  
  console.log('✅ Search submitted!');
}

// Main execution
(async () => {
  try {
    console.log('🚀 Starting YouTube search automation with Vision AI...\n');
    
    // Step 1: Open YouTube
    await openYouTube();
    
    // Step 2: Search for videos
    await searchYouTube('AI tutorials 2024');
    
    console.log('\n✅ Automation complete!');
    console.log('📺 Search results should now be displayed');
    
  } catch (error) {
    console.error('\n❌ Automation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
