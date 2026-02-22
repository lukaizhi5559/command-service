# Skill Dispatch Architecture
## How the LLM communicates automation skills through the stategraph → command-service MCP

---

## The Short Answer

**No new endpoint or WebSocket is needed for skill dispatch.**

The existing MCP stdio transport + `mcpAdapter` in the stategraph is the correct and sufficient channel. The only thing that changes is the *payload shape* — from a natural language string to a structured skill call.

---

## Full Request Flow — Adaptive Cycle

```
User: "create a folder on my root and add hello-world.txt to it"
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  stategraph-module                                              │
│                                                                 │
│  parseIntent → intent.type = 'command_automate'                 │
│         │                                                       │
│         ▼                                                       │
│  ┌─────────────────┐                                            │
│  │   planSkills    │  LLM converts request → skill[] plan       │
│  │   (LLM call)    │  [                                         │
│  └────────┬────────┘    { skill:'shell.run',                    │
│           │               args:{ cmd:'mkdir', argv:['/myfolder']│
│           ▼               cwd:'/' } },                          │
│  ┌─────────────────┐    { skill:'shell.run',                    │
│  │ executeCommand  │      args:{ cmd:'touch',                   │
│  │ (one step/pass) │◄──── argv:['/myfolder/hello-world.txt'] } }│
│  └────────┬────────┘  ]                                         │
│           │                                                     │
│     step ok? ──yes──► advance cursor ──► next step / done       │
│           │                                                     │
│          no (permission denied on /)                            │
│           │                                                     │
│           ▼                                                     │
│  ┌─────────────────┐                                            │
│  │  recoverSkill   │  LLM (or fast-path) reasons about failure  │
│  └────────┬────────┘                                            │
│           │                                                     │
│    ┌──────┴──────────────────────────┐                          │
│    │              │                  │                          │
│    ▼              ▼                  ▼                          │
│ AUTO_PATCH     REPLAN            ASK_USER                       │
│ patch args  rebuild plan    surface question                     │
│ retry step  from scratch    to user                             │
│    │              │                  │                          │
│    └──► executeCommand               │                          │
│                   └──► planSkills    │                          │
│                                      ▼                          │
│                         "I don't have permission to create      │
│                          a folder there. Create on Desktop?"    │
│                          1. Yes, use Desktop                    │
│                          2. Choose different location           │
│                          3. Cancel                              │
└─────────────────────────────────────────────────────────────────┘
         │  mcpAdapter.callService('command', 'command.automate', { skill, args })
         ▼
┌─────────────────────────────────────────────────────┐
│  command-service MCP  (stdio transport)             │
│                                                     │
│  server.cjs → executeAutomation({ skill, args })    │
│    ├─ shell.run       → skills/shell.run.cjs        │
│    ├─ browser.act     → skills/browser.act.cjs      │
│    ├─ ui.findAndClick → skills/ui.findAndClick.cjs  │
│    ├─ ui.typeText     → skills/ui.typeText.cjs      │
│    └─ ui.waitFor      → skills/ui.waitFor.cjs       │
└─────────────────────────────────────────────────────┘
         │  { ok, stdout, stderr, exitCode, ... }
         ▼
  executeCommand updates skillResults + skillCursor
  → graph routes based on state (next step / recover / done)
```

---

## Transport: Why stdio MCP, Not WebSocket

| Concern | stdio MCP | WebSocket |
|---|---|---|
| Skill dispatch (LLM → command) | ✅ Perfect fit | Overkill |
| Live terminal streaming to UI | ❌ Not designed for it | ✅ Use this |
| Session state between calls | Handled by skill session pools | N/A |
| Latency | Negligible (local process) | Negligible (local) |
| Complexity | Low | Higher |

**WebSocket is only needed if** you want to stream live `stdout` from a long-running `shell.run` back to the frontend UI in real-time (e.g. showing `npm install` output as it runs). That is a separate streaming concern, not skill dispatch.

---

## What Changes in `executeCommand.js`

The current node sends natural language to the old command service:

```js
// OLD — sends a string, expects the service to interpret it
await mcpAdapter.callService('command', 'command.automate', {
  command: commandMessage,   // "open Slack and message #general"
  intent: 'command_automate'
});
```

The new node receives a **pre-planned skill array** from the LLM planner node upstream, then dispatches each skill step sequentially:

```js
// NEW — sends structured skill calls, service just actuates
for (const step of state.skillPlan) {
  const result = await mcpAdapter.callService('command', 'command.automate', {
    skill: step.skill,   // 'shell.run' | 'browser.act' | etc.
    args:  step.args     // skill-specific structured args
  });
  if (!result.ok) { /* handle failure, retry, or abort */ }
}
```

The LLM **never sends a natural language string to the command-service**. It sends structured skill calls. All interpretation happens upstream in the stategraph planner node.

---

## Skill Call Payloads Reference

### `shell.run`
```json
{
  "skill": "shell.run",
  "args": {
    "cmd": "git",
    "argv": ["status"],
    "cwd": "/Users/lukaizhi/projects/myapp",
    "timeoutMs": 30000,
    "dryRun": false
  }
}
```

### `browser.act`
```json
{
  "skill": "browser.act",
  "args": {
    "action": "navigate",
    "url": "https://github.com",
    "sessionId": "session-abc123",
    "timeoutMs": 15000
  }
}
```
```json
{
  "skill": "browser.act",
  "args": {
    "action": "click",
    "selector": "button:has-text('Sign in')",
    "sessionId": "session-abc123"
  }
}
```

### `ui.findAndClick`
```json
{
  "skill": "ui.findAndClick",
  "args": {
    "label": "Submit",
    "app": "Safari",
    "confidence": 0.85
  }
}
```

### `ui.typeText`
```json
{
  "skill": "ui.typeText",
  "args": {
    "text": "Hello world{ENTER}",
    "delayMs": 30
  }
}
```

Special tokens in `text`: `{ENTER}`, `{TAB}`, `{ESC}`, `{CMD+K}`, `{CMD+C}`, `{CMD+V}`, `{BACKSPACE}`, `{UP}`, `{DOWN}`

### `ui.waitFor`
```json
{
  "skill": "ui.waitFor",
  "args": {
    "condition": "textIncludes",
    "value": "Build succeeded",
    "timeoutMs": 60000,
    "pollIntervalMs": 1000
  }
}
```

Condition types: `textIncludes`, `textRegex`, `appIsActive`, `titleIncludes`, `urlIncludes`, `changed`

---

## Where the LLM Skill Planner Lives

The LLM that converts user intent → skill plan should be a **dedicated planner node** in the stategraph, upstream of `executeCommand`. It does NOT live in the command-service.

```
resolveIntent node
      ↓
planSkills node  ← LLM call here: "given this intent, produce a skill[] plan"
      ↓
executeCommand node  ← iterates skill plan, calls mcpAdapter per step
      ↓
formatAnswer node
```

The system prompt for the planner node should include:
- The 5 available skills and their arg schemas (from this doc)
- The policy constraints (no sudo, no arbitrary shell strings, cwd must be specified)
- Output format: a JSON array of `{ skill, args }` objects

---

## bibscrip-backend `/ws/stream` — No Changes Needed

The existing WebSocket handler in `bibscrip-backend/dist/websocket/streamingHandler.js` already handles everything the new skill nodes need.

### How `planSkills` and `recoverSkill` use it

Both nodes call `backend.generateAnswer()` via `VSCodeLLMBackend`, which sends:

```json
{
  "type": "llm_request",
  "payload": {
    "prompt": "User request: 'create a folder...'",
    "context": {
      "systemInstructions": "You are an automation planner. Convert the user's request into...",
      "sessionId": "...",
      "userId": "..."
    }
  }
}
```

The backend's `buildThinkdropAIPrompt()` already reads `context.systemInstructions` (line 433 of `streamingHandler.js`) and appends it to the prompt. The skill planner system prompt flows through cleanly — no backend changes required.

### Response flow

```
planSkills / recoverSkill
    │  VSCodeLLMBackend.generateAnswer()
    ▼
ws://localhost:4000/ws/stream
    │  { type: 'llm_request', payload: { prompt, context: { systemInstructions } } }
    ▼
streamingHandler.handleLLMRequest()
    │  buildThinkdropAIPrompt() injects systemInstructions
    │  llmStreamingRouter.processPromptWithStreaming()
    ▼
{ type: 'llm_stream_start' }
{ type: 'llm_stream_chunk', payload: { chunk: '[\n  { "skill":...' } }
{ type: 'llm_stream_end' }
    │
    ▼
VSCodeLLMBackend accumulates chunks → returns full JSON string
    │
    ▼
planSkills parsePlan() → skillPlan[]
```

### What the backend does NOT need to know about

- Skill names, args, or execution — it just generates text
- The command-service MCP — it never talks to it
- Recovery decisions — `recoverSkill` sends its own system prompt and gets back a JSON decision

### WebSocket: When and Where to Add It (future)

If you later need **live streaming stdout** (e.g. show `npm install` progress in the UI as it runs):

1. `shell.run` emits stdout chunks via an EventEmitter as the process runs
2. `executeCommand` node forwards chunks over the existing `bridgeWs` connection in `main.js`
3. The frontend receives `{ type: 'skill_stdout_chunk', payload: { chunk, step, skill } }` and renders it live
4. The command-service MCP itself stays stdio — no changes needed there either

This keeps the command-service pure actuation and the streaming concern in the Electron main process layer.

---

## Summary

| Question | Answer |
|---|---|
| New REST endpoint needed? | No |
| WebSocket needed for skill dispatch? | No (only for live streaming, later) |
| Where does LLM → skill translation happen? | Planner node in stategraph, upstream of executeCommand |
| What changes in executeCommand.js? | Receives `skillPlan[]`, iterates and dispatches each step via mcpAdapter |
| Does command-service interpret language? | Never — pure actuation only |
| Transport between stategraph and command-service? | Existing stdio MCP via mcpAdapter |
