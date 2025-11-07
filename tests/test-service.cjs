/**
 * Test script for Command Service
 * 
 * Tests the service components without requiring full MCP integration.
 */

require('dotenv').config();
const OllamaClient = require('../src/OllamaClient.cjs');
const CommandValidator = require('../src/CommandValidator.cjs');
const CommandExecutor = require('../src/CommandExecutor.cjs');

async function testValidator() {
  console.log('\n🧪 Testing Command Validator...\n');
  
  const validator = new CommandValidator({
    allowedCategories: ['open_app', 'system_info', 'file_read']
  });
  
  const testCases = [
    { cmd: 'open -a Slack', shouldPass: true, desc: 'Open app' },
    { cmd: 'ls -la', shouldPass: true, desc: 'List files' },
    { cmd: 'df -h', shouldPass: true, desc: 'Disk space' },
    { cmd: 'rm -rf /', shouldPass: false, desc: 'Dangerous rm' },
    { cmd: 'sudo reboot', shouldPass: false, desc: 'Sudo command' },
    { cmd: 'ps aux', shouldPass: true, desc: 'Process list' },
  ];
  
  for (const test of testCases) {
    const result = validator.validate(test.cmd);
    const status = result.isValid === test.shouldPass ? '✅' : '❌';
    console.log(`${status} ${test.desc}: "${test.cmd}"`);
    console.log(`   Valid: ${result.isValid}, Category: ${result.category || 'none'}, Risk: ${result.riskLevel}`);
    if (result.error) console.log(`   Error: ${result.error}`);
    console.log();
  }
}

async function testExecutor() {
  console.log('\n🧪 Testing Command Executor...\n');
  
  const executor = new CommandExecutor();
  
  // Test 1: Simple echo
  console.log('Test 1: echo command');
  const result1 = await executor.execute('echo "Hello from Command Service"');
  console.log(`Success: ${result1.success}`);
  console.log(`Output: ${result1.output}`);
  console.log();
  
  // Test 2: System info
  console.log('Test 2: uname command');
  const result2 = await executor.execute('uname -a');
  console.log(`Success: ${result2.success}`);
  console.log(`Output: ${result2.output.substring(0, 100)}...`);
  console.log();
  
  // Test 3: With interpretation
  console.log('Test 3: Command with interpretation');
  const result3 = await executor.executeWithInterpretation('df -h', 'check disk space');
  console.log(`Success: ${result3.success}`);
  console.log(`Interpretation: ${result3.interpretation}`);
  console.log();
}

async function testOllamaClient() {
  console.log('\n🧪 Testing Ollama Client...\n');
  
  const client = new OllamaClient();
  
  // Test 1: Health check
  console.log('Test 1: Health check');
  const healthy = await client.checkHealth();
  console.log(`Ollama healthy: ${healthy ? '✅' : '❌'}`);
  
  if (!healthy) {
    console.log('⚠️  Ollama not available. Skipping interpretation tests.');
    console.log('   Make sure Ollama is running: ollama serve');
    console.log(`   Make sure model is available: ollama pull ${client.model}`);
    return;
  }
  console.log();
  
  // Test 2: Command interpretation
  console.log('Test 2: Interpret "Open Slack"');
  const result1 = await client.interpretCommand('Open Slack', { os: 'darwin' });
  console.log(`Success: ${result1.success}`);
  console.log(`Shell command: ${result1.shellCommand}`);
  console.log();
  
  // Test 3: System query
  console.log('Test 3: System query');
  const result2 = await client.querySystem('How do I check disk space?');
  console.log(`Success: ${result2.success}`);
  if (result2.success && result2.answer) {
    console.log(`Answer: ${result2.answer.substring(0, 200)}...`);
  } else {
    console.log(`Error: ${result2.error}`);
  }
  console.log();
}

async function testFullFlow() {
  console.log('\n🧪 Testing Full Flow...\n');
  
  const client = new OllamaClient();
  const validator = new CommandValidator({
    allowedCategories: ['open_app', 'system_info', 'file_read']
  });
  const executor = new CommandExecutor();
  
  const naturalCommand = 'show me disk space';
  
  console.log(`Natural command: "${naturalCommand}"`);
  console.log();
  
  // Step 1: Interpret
  console.log('Step 1: Interpreting...');
  const interpretation = await client.interpretCommand(naturalCommand);
  if (!interpretation.success) {
    console.log(`❌ Failed: ${interpretation.error}`);
    return;
  }
  console.log(`✅ Interpreted as: ${interpretation.shellCommand}`);
  console.log();
  
  // Step 2: Validate
  console.log('Step 2: Validating...');
  const validation = validator.validate(interpretation.shellCommand);
  if (!validation.isValid) {
    console.log(`❌ Validation failed: ${validation.error}`);
    return;
  }
  console.log(`✅ Valid (category: ${validation.category}, risk: ${validation.riskLevel})`);
  console.log();
  
  // Step 3: Execute
  console.log('Step 3: Executing...');
  const execution = await executor.executeWithInterpretation(
    interpretation.shellCommand,
    naturalCommand
  );
  if (!execution.success) {
    console.log(`❌ Execution failed: ${execution.error}`);
    return;
  }
  console.log(`✅ Executed successfully`);
  console.log(`Interpretation: ${execution.interpretation}`);
  console.log();
}

async function main() {
  console.log('=' .repeat(60));
  console.log('🚀 Command Service - Test Suite');
  console.log('='.repeat(60));
  
  try {
    await testValidator();
    await testExecutor();
    await testOllamaClient();
    await testFullFlow();
    
    console.log('='.repeat(60));
    console.log('✅ All tests completed!');
    console.log('='.repeat(60));
    console.log('\n📝 Next steps:');
    console.log('1. Start service: npm start');
    console.log('2. Test via MCP: echo \'{"action":"health","payload":{}}\' | node src/server.cjs');
    console.log('3. Integrate with ThinkDrop AI');
    
  } catch (error) {
    console.error('\n❌ Test suite failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
