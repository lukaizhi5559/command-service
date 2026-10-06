# Terminal / Integration Architecture

ThinkDrop's execution substrate — three layers, three different jobs.

## Layers

| Layer | Module | Role |
|---|---|---|
| `shell.run` | `mcp-services/command-service/src/skills/shell.run.cjs` | Deterministic one-shot commands. Allowlisted, danger-scanned, Seatbelt-sandboxed, dry-run aware. Fast path for ~80% of commands — no PTY, no LLM. |
| `terminal.agent` | `mcp-services/command-service/src/skills/terminal.agent.cjs` | PTY session substrate — the *hands*. Interactive prompts, menus, REPLs, sudo, device-login flows, persistent cwd/env/session state, resize, user-visible attachment. |
| `cli.agent` | `mcp-services/command-service/src/skills/cli.agent.cjs` | Policy layer — the *brain*. Descriptor→argv inference, `run_help` probing, learned rules, failure categories, auto-auth. Gained `pty_exec`/`pty_send` so interactive flows are drivable instead of punting. |
| `mcp.agent` | `mcp-services/command-service/src/skills/mcp.agent.cjs` | External MCP servers — real JSON-RPC 2.0 over stdio/HTTP (not the internal mcp.v1 envelope). install/list_tools/call/remove. |

## PTY backend

`src/terminal/pty-session.cjs` prefers `node-pty` (prebuilds since 1.1.0), falls back to `src/terminal/pty_shim.py` (Python `pty` bridge — ships with macOS CLT). Backend is reported on every session (`ptyBackend()`). `spawn-helper` execute-bit self-heal is built in for zip-extract installs.

Screen state comes from `@xterm/headless` (`screen-buffer.cjs`); sessions live in `session-store.cjs` with idle reaping (30min agent / 2h user-attached) and ANSI-stripped transcripts in `~/.thinkdrop/logs/terminal/*.log`.

## terminal.agent actions

```
open    { cwd?, env?, cols?, rows?, shell?, argv?, label?, managedBy?, ownerRunId? }
send    { sessionId, text } | { sessionId, ctrl } | sensitive: true
read    { sessionId, mode?: 'screen'|'tail', lines? }
wait    { sessionId, match?, idleMs?, timeoutMs? }
exec    { cmd, sessionId?, timeoutMs?, keepSession? }   → exit-marker wrapped
resize  { sessionId, cols, rows }
list / close / kill_all
```

## Security model

- All `send`/`exec` text passes `DANGEROUS_SCRIPT_PATTERNS` (shared with shell.run).
- Password/passphrase output sets `session.meta.prompt='password'` and emits `terminal:prompt_wait` — the agent must `ask_user` or hand the user the live pane; it never invents credentials.
- `send {sensitive:true}` pauses transcript capture ~4s so echoed user-typed secrets never reach the audit log.
- Transcripts are ANSI-stripped; sessions are swept on TTL and on `/automation.cancel` (`_abortSignal` → kill).

## Capability resolution (planning)

`shared/capability-index.cjs` powers three read-only planning tools:

- `capability.search` — unified candidate search across registered agents, `cli-registry.json`, MCP servers (installed + `mcp-registry-seed.json`), and zero-install platform affordances. Ranked by friction score (0 = works now → 6 = paid/manual) with canned `setupSummary` strings.
- `capability.probe` — read-only verb-gated CLI inspection (`--help`, `whoami`, `auth status`, `list`, `doctor`, `scan`, …). Spawned **without a shell**; denylist blocks mutating tokens (`login`, `set`, `install`, `exec`, …). The verb table lives in code constants only — nothing user-influenced can widen it. Denied probes are logged.
- `capability.select` — commits the user's `<choices>` pick as a draft `.agent.md` (metadata-only).

Setup itself happens at the **readiness card**: `cli-setup` plan-check rows → `/agent.cli-build` → `/agent.cli-install` (PTY-driven for interactive installers) → secret entry via `secret-resolve` → recheck → approve → run.

## External MCP

- Config: `~/.thinkdrop/mcp-servers.json` (Claude-Desktop-compatible).
- Client: `src/terminal/mcp-client.cjs` — `initialize` → `notifications/initialized` → `tools/list`/`tools/call`; per-server process pool, 10min idle reaper; `${VAR}` env values resolved through `secret-resolve` as `credential:mcp.<name>:<VAR>` (plaintext never in config or logs).
- `mcp.agent install` vets `npx -y <pkg>` via `npm view`, handshakes to verify MCP, and writes the `mcp.<name>.agent` descriptor with the discovered tool list.

## Visible terminal

`TerminalPane.tsx` inside the re-enabled `AIActivityPanel` (Activity/Terminal tabs). Renderer → `terminal:action` IPC → main.js → `/command.automate terminal.agent`. Polls `read` ~1Hz; input via `send`; a lock-icon "sensitive" toggle pairs with the transcript pause for password entry.

## Platform seams

macOS-first, schema-ready for win32/linux: `platforms[]`, `platform.affordances` (darwin: osascript/say/afplay/crontab/open), `platform.sandbox` (Seatbelt now; Job Objects / bubblewrap later), `platform.shell` (zsh / powershell / bash).

## Learning & recovery

- `terminal/knowledge.cjs` — `~/.thinkdrop/terminal-knowledge.json` caches flags/prompts that worked per CLI; injected into cli.agent's learned-rules context next run.
- Two-strike detection — identical screen after `pty_send` injects a "stop guessing" observation so the loop asks the user instead of looping.
- Flags-over-menus is a prompt-level preference (`run_help` probe first, PTY last).

## Eval

`mcp-services/command-service/scripts/eval-terminal.cjs` — 19-check acceptance suite (PTY round-trip, marker stripping, danger block, sensitive send, probe allow/deny, friction sorting, MCP handshake/call). Run: `node scripts/eval-terminal.cjs`.
