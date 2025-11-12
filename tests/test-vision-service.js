/**
 * Vision Spatial Service Test
 * 
 * Tests the vision service by:
 * 1. Capturing the current screen
 * 2. Analyzing it with vision AI
 * 3. Displaying detected UI elements
 */

require('dotenv').config();
const {
  captureScreen,
  analyzeImage,
  findElement,
  getUIMap,
  findAndClick
} = require('../src/services/visionSpatialService');

async function testVisionService() {
  console.log('🧪 Testing Vision Spatial Service...\n');
  
  // Check configuration
  console.log('📋 Configuration:');
  console.log(`   Provider: ${process.env.VISION_PROVIDER || 'openai'}`);
  console.log(`   Model: ${process.env.VISION_MODEL || 'gpt-4o'}`);
  console.log(`   API Key: ${process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log('');
  
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('❌ Error: No API key found!');
    console.error('   Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env file');
    process.exit(1);
  }
  
  try {
    // Step 1: Capture screen
    console.log('📸 Step 1: Capturing current screen...');
    const { buffer, path } = await captureScreen();
    console.log(`✅ Screenshot saved: ${path}`);
    console.log(`   Size: ${(buffer.length / 1024).toFixed(2)} KB\n`);
    
    // Step 2: Analyze with vision AI
    console.log('🔍 Step 2: Analyzing screenshot with vision AI...');
    console.log('   (This may take 5-10 seconds...)\n');
    
    const startTime = Date.now();
    const uiMap = await analyzeImage(buffer);
    const duration = Date.now() - startTime;
    
    console.log(`✅ Analysis complete in ${(duration / 1000).toFixed(2)}s`);
    console.log(`   Found ${uiMap.length} UI elements\n`);
    
    // Step 3: Display results
    console.log('📊 Step 3: Detected UI Elements:');
    console.log('─'.repeat(80));
    
    // Group by role
    const byRole = {};
    uiMap.forEach(el => {
      if (!byRole[el.role]) byRole[el.role] = [];
      byRole[el.role].push(el);
    });
    
    // Display grouped
    Object.keys(byRole).sort().forEach(role => {
      console.log(`\n${role.toUpperCase()} (${byRole[role].length}):`);
      byRole[role].forEach((el, idx) => {
        console.log(`   ${idx + 1}. "${el.label}"`);
        console.log(`      Position: (${el.bbox.x}, ${el.bbox.y})`);
        console.log(`      Size: ${el.bbox.w}×${el.bbox.h}px`);
      });
    });
    
    console.log('\n' + '─'.repeat(80));
    
    // Step 4: Test findElement
    console.log('\n🔍 Step 4: Testing findElement()...');
    
    // Try to find common elements
    const testSearches = [
      { label: 'search', role: 'input' },
      { label: 'button', role: 'button' },
      { label: 'menu', role: null },
      { label: 'close', role: 'button' }
    ];
    
    testSearches.forEach(({ label, role }) => {
      const found = findElement(uiMap, label, role);
      if (found) {
        console.log(`   ✅ Found "${label}"${role ? ` (${role})` : ''}: "${found.label}" at (${found.bbox.x}, ${found.bbox.y})`);
      } else {
        console.log(`   ❌ Not found: "${label}"${role ? ` (${role})` : ''}`);
      }
    });
    
    // Step 5: Summary
    console.log('\n' + '='.repeat(80));
    console.log('✅ Vision Service Test Complete!');
    console.log('='.repeat(80));
    console.log('\n📊 Summary:');
    console.log(`   • Screenshot: ${path}`);
    console.log(`   • Elements detected: ${uiMap.length}`);
    console.log(`   • Analysis time: ${(duration / 1000).toFixed(2)}s`);
    console.log(`   • Provider: ${process.env.VISION_PROVIDER || 'openai'}`);
    console.log(`   • Model: ${process.env.VISION_MODEL || 'gpt-4o'}`);
    
    console.log('\n💡 Next steps:');
    console.log('   1. Review the detected elements above');
    console.log('   2. Try findAndClick() in your automation scripts');
    console.log('   3. Use hybrid approach (coordinates → vision fallback)');
    
    console.log('\n📖 Example usage:');
    console.log('   const { findAndClick } = require("./visionSpatialService");');
    console.log('   await findAndClick("Compose", "button");');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run test
testVisionService();
