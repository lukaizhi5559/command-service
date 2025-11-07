# Command Service

MCP service for natural language command execution in ThinkDrop AI using Ollama.

## Features

- 🤖 **Natural Language Commands** - "Open Slack", "How much memory left?"
- 💬 **AI-Powered Responses** - Human-readable output interpretation using LLM
- 🔒 **Security First** - Whitelist validation, dangerous pattern blocking
- ⚡ **Completely Free** - Uses local Ollama (llama3.2)
- 🎯 **Intent-Based** - Handles `command` intent from ThinkDrop AI
- 🛡️ **Safe Execution** - Timeout protection, output sanitization
- 📊 **Command Categories** - Granular permission control

## Prerequisites

1. **Node.js 18+**
2. **Ollama** installed and running
3. **llama3.2** model (or configure a different model)

## Installation

### 1. Install Dependencies

```bash
cd mcp-services/command-service
npm install
```

### 2. Setup Ollama

If you don't have Ollama yet:

```bash
# Install Ollama (macOS)
brew install ollama

# Start Ollama
ollama serve

# Pull llama3.2 model (in another terminal)
ollama pull llama3.2:3b
```

### 3. Configure Service

```bash
cp .env.example .env
# Edit .env if needed (defaults work for most users)
```

**Key settings:**
```bash
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b
ALLOWED_COMMAND_CATEGORIES=open_app,system_info,file_read
```

### 4. Test Installation

```bash
npm test
```

Expected output:
```
🚀 Command Service - Test Suite
🧪 Testing Command Validator...
✅ Open app: "open -a Slack"
✅ List files: "ls -la"
...
✅ All tests completed!
```

## Usage

### Start Service

```bash
npm start
```

Or with auto-reload:
```bash
npm run dev
```

### AI Output Interpretation

The service now uses AI to interpret command output into human-readable responses. Instead of showing raw terminal output, you get conversational answers.

**Example:**

**User asks:** "What apps are open?"

**Without AI interpretation:**
```
USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
lukaizhi 41903 40.9  0.1 411892480 10784 s001  R+   12:26AM   1:32.43 /opt/homebrew/Cellar/python...
lukaizhi 42661 20.4  0.4 444692480 30208 s002  S+   12:28AM   0:04.35 /Users/lukaizhi/Desktop/projects...
...
```

**With AI interpretation:**
```
Windsurf and Slack are currently active/open apps you have open.
```

**Configuration:**

Enable/disable AI interpretation in `.env`:
```bash
USE_AI_INTERPRETATION=true  # Default: true
```

**How it works:**
1. Command is executed and raw output captured
2. LLM analyzes the output in context of the original question
3. Concise, conversational response is generated (1-2 sentences)
4. Falls back to rule-based interpretation if LLM fails

**Test it:**
```bash
node test-interpretation.cjs
```

### MCP Actions

#### 1. Execute Command

```json
{
  "action": "command.execute",
  "payload": {
    "command": "Open Slack",
    "context": {
      "os": "darwin",
      "userId": "user123"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "result": "Application opened successfully",
  "originalCommand": "Open Slack",
  "executedCommand": "open -a Slack",
  "category": "open_app",
  "executionTime": 245
}
```

#### 2. Interpret Command (without executing)

```json
{
  "action": "command.interpret",
  "payload": {
    "command": "show me disk space"
  }
}
```

**Response:**
```json
{
  "success": true,
  "originalCommand": "show me disk space",
  "shellCommand": "df -h",
  "isValid": true,
  "category": "system_info",
  "riskLevel": "low"
}
```

#### 3. System Query

```json
{
  "action": "system.query",
  "payload": {
    "query": "How do I check running processes?"
  }
}
```

#### 4. Health Check

```json
{
  "action": "health",
  "payload": {}
}
```

## Security

### Command Categories

Control what types of commands are allowed:

- **open_app** - Open applications (`open -a`, `xdg-open`)
- **system_info** - System information (`df`, `ps`, `top`, `uname`)
- **file_read** - Read files/directories (`ls`, `cat`, `find`)
- **file_write** - Create/modify files (`touch`, `mkdir`, `echo >`)
- **network** - Network operations (`ping`, `curl`, `wget`)
- **process** - Process management (`kill`, `systemctl`)

**Configure in `.env`:**
```bash
ALLOWED_COMMAND_CATEGORIES=open_app,system_info,file_read
```

### Blocked Patterns

Always blocked regardless of category:
- `rm -rf /` or `rm -rf ~`
- Fork bombs
- `sudo` commands
- Disk formatting (`mkfs`, `dd`)
- Dangerous permissions (`chmod 777`)
- Download and execute (`curl | sh`)

### Risk Levels

- **Low** - Safe commands (open app, read files)
- **Medium** - Potentially impactful (write files, network)
- **High** - Dangerous (kill processes, system changes)
- **Critical** - Blocked (rm -rf, sudo, etc.)

## Integration with ThinkDrop AI

### 1. Register Service

Edit `/src/main/services/mcp/AgentOrchestrator.cjs`:

```javascript
this.mcpClient = new MCPClient({
  services: {
    // ... existing services
    'command': {
      command: 'node',
      args: ['src/server.cjs'],
      cwd: path.join(__dirname, '../../../mcp-services/command-service'),
      env: process.env
    }
  }
});
```

### 2. Create executeCommand Node

Create `/src/main/services/mcp/nodes/executeCommand.cjs`:

```javascript
module.exports = async function executeCommand(state) {
  const { message, intent, context, mcpClient } = state;
  
  if (intent?.type !== 'command') {
    return state;
  }
  
  try {
    const result = await mcpClient.callService(
      'command',
      'command.execute',
      {
        command: message,
        context: {
          os: process.platform,
          userId: context.userId
        }
      }
    );
    
    if (!result.success) {
      return {
        ...state,
        answer: `I couldn't execute that command: ${result.error}`,
        commandExecuted: false
      };
    }
    
    return {
      ...state,
      answer: result.result,
      commandExecuted: true,
      executedCommand: result.executedCommand
    };
  } catch (error) {
    return {
      ...state,
      answer: `Error executing command: ${error.message}`,
      commandExecuted: false
    };
  }
};
```

### 3. Update StateGraph Routing

Edit `/src/main/services/mcp/AgentOrchestrator.cjs`:

```javascript
// Add node
const executeCommand = require('./nodes/executeCommand.cjs');

// In _buildStateGraph():
graph.addNode('executeCommand', executeCommand);

// Update routing after parseIntent
graph.addEdge('parseIntent', (state) => {
  const intentType = state.intent?.type || 'general_query';
  
  // Command routing
  if (intentType === 'command') {
    return 'executeCommand';
  }
  
  // ... existing routing
});

// Add edge after execution
graph.addEdge('executeCommand', 'storeConversation');
```

## Example Commands

### Open Applications

```
"Open Slack"                    → open -a Slack
"Launch Chrome"                 → open -a "Google Chrome"
"Start VS Code"                 → open -a "Visual Studio Code"
```

### System Information

```
"How much memory left?"         → vm_stat | grep free
"Show disk space"               → df -h
"What's my CPU usage?"          → top -l 1 | grep CPU
"List running processes"        → ps aux
```

### File Operations

```
"List files in Downloads"       → ls ~/Downloads
"Show contents of notes.txt"    → cat notes.txt
"Find all PDF files"            → find . -name "*.pdf"
```

## Configuration

### Environment Variables

```bash
# Ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.2:3b

# Service
SERVICE_NAME=command-service
SERVICE_PORT=3007

# Security
ENABLE_COMMAND_VALIDATION=true
REQUIRE_USER_CONFIRMATION=false
ALLOWED_COMMAND_CATEGORIES=open_app,system_info,file_read

# Execution
COMMAND_TIMEOUT=30000
MAX_OUTPUT_LENGTH=10000
USE_AI_INTERPRETATION=true  # Use LLM for human-readable output

# Logging
LOG_LEVEL=info
DEBUG_MODE=false
```

### Using a Different Model

If llama3.2 isn't working well for commands, try CodeLlama:

```bash
# Pull CodeLlama
ollama pull codellama:7b

# Update .env
OLLAMA_MODEL=codellama:7b
```

CodeLlama is specifically trained for code and commands, so it may be more accurate.

## Troubleshooting

### "Ollama not available"

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not running, start it
ollama serve
```

### "Model not found"

```bash
# Pull the model
ollama pull llama3.2:3b

# Or use a different model
ollama pull codellama:7b
```

### "Command not interpreted correctly"

Try using CodeLlama instead of llama3.2:

```bash
ollama pull codellama:7b
# Update OLLAMA_MODEL in .env
```

### "Command blocked"

Check:
1. Is the command in an allowed category?
2. Does it match a dangerous pattern?
3. Review `.env` ALLOWED_COMMAND_CATEGORIES

## Performance

### Latency

- **Command interpretation**: 500-1500ms (depends on model)
- **Validation**: <5ms
- **Execution**: 100-500ms (depends on command)
- **Total**: ~1-2 seconds

### Model Comparison

| Model | Speed | Accuracy | Size |
|-------|-------|----------|------|
| llama3.2:1b | Very fast | Good | 1.3 GB |
| llama3.2:3b | Fast | Good | 2.0 GB |
| codellama:7b | Moderate | Excellent | 3.8 GB |
| mistral:7b | Moderate | Very good | 4.1 GB |

**Recommendation**: Start with `llama3.2:3b`, upgrade to `codellama:7b` if needed.

## Development

### Project Structure

```
command-service/
├── src/
│   ├── server.cjs              # Main MCP server
│   ├── OllamaClient.cjs        # Ollama integration
│   ├── CommandValidator.cjs    # Security validation
│   ├── CommandExecutor.cjs     # Command execution
│   └── logger.cjs              # Logging utility
├── tests/
│   └── test-service.cjs        # Test suite
├── package.json
├── .env.example
└── README.md
```

### Running Tests

```bash
npm test
```

### Debug Mode

```bash
# Enable debug logging
DEBUG_MODE=true npm start
```

## License

MIT

---

**Questions?** Check the test suite: `npm test`
