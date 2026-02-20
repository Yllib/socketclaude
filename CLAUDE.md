# SocketClaude

Flutter Android chat app backed by Claude via the Agent SDK, with voice I/O, Samsung AI button integration, chunked file transfer, and a plugin system for private extensions.

## Repository Structure

This project uses a **nested repo** layout:

- **Outer repo** (this one) — **PUBLIC** (MIT license). Contains the server, plugin framework, protocol types, and documentation. Published to GitHub.
- **Inner repo** (`app/`) — **PRIVATE**. Contains the Flutter Android app. Lives inside `app/` which is gitignored by the outer repo. Has its own `.git` and is managed independently.

**IMPORTANT: The `app/` directory is a private repository and must NEVER be committed to the outer public repo, pushed to a public remote, or leaked in any way. The outer `.gitignore` excludes it. Do not remove that exclusion.**

When working in this project, remember that `git` commands in the project root operate on the public server repo, while `git` commands run from inside `app/` operate on the private app repo.

## Architecture

```
Flutter App (Android) ←—WebSocket (JSON)—→ Node.js Server ←—Agent SDK—→ Claude
                                                ↑
                                            Plugins (server/plugins/)
```

- **Server** (`server/`): Node.js + TypeScript WebSocket server on port 8085. Wraps the Claude Agent SDK, manages sessions, streams responses to the app.
- **App** (`app/`): Flutter Android app with chat UI, voice input (STT), TTS output, question cards, tool output blocks, file transfer, todo tracking, and session management.
- **Plugins** (`server/plugins/`): Optional private extensions loaded at startup. Not committed to the public repo (gitignored except README.md and tsconfig.json).

## Server (`server/`)

### Key Files
- `src/index.ts` — WebSocket server entry point, auth, session routing, global session registry for background persistence, chunked file transfer handler, CWD validation, plugin loader
- `src/claude-session.ts` — Agent SDK `query()` wrapper. Handles streaming, `canUseTool` for AskUserQuestion relay and ExitPlanMode approval, plugin hook execution, tool context injection, message injection via `streamInput()`, per-turn token tracking, compacting detection
- `src/plugin-api.ts` — TypeScript interfaces for the plugin system (`SocketClaudePlugin`, `PluginContext`, `SessionContext`, etc.)
- `src/protocol.ts` — TypeScript interfaces for all WebSocket message types (client→server and server→client)
- `src/session-store.ts` — Session metadata and chat history persistence to `~/.claude-assistant/`, paginated history loading, missed message recovery from JSONL

### Build & Run

**IMPORTANT: You must `cd` into the server directory before starting.** The `.env` file is resolved relative to the server dir, and the process CWD matters.

Compile server after code changes:
```bash
cd server && npx tsc
```

Compile plugins (if any exist):
```bash
cd server/plugins && npx tsc
```

The server runs as a **systemd user service** (`socketclaude.service`) that auto-starts on boot.

```bash
# Restart after code changes (compile first, then restart service):
cd server && npx tsc
systemctl --user restart socketclaude
```

```bash
# Check status / view live logs:
systemctl --user status socketclaude
journalctl --user -u socketclaude -f
```

**WARNING:** Restarting the server will kill any active Claude SDK sessions running through it (including the current one if running from the app). The app will auto-reconnect once the new server starts.

- Service file: `~/.config/systemd/user/socketclaude.service`
- Auto-restarts on crash (`Restart=on-failure`)
- Runs as the installing user with linger enabled (persists without login session)
- `CLAUDECODE` env var is unset automatically by the service
- Service PATH includes `/opt/flutter/bin` and Android SDK `platform-tools` so `flutter` and `adb` are available in Claude Code Bash tool

### Config (`.env`)
- `PORT` — WebSocket port (default 8085)
- `DEFAULT_CWD` — Default working directory for new sessions
- `AUTH_TOKEN` — Token for client authentication (auto-generated if missing)

**Note:** `dotenv` does NOT override existing environment variables. If `PORT` or `AUTH_TOKEN` are already set in the shell environment, `.env` values are ignored. The systemd service runs in a clean env so `.env` works correctly there.

### SDK Configuration
The server uses the `claude_code` preset for both system prompt and tools, with these key SDK options:
- `settingSources: ["user", "project"]` — Loads CLAUDE.md files from the session CWD and `~/.claude/`
- `permissionMode: "bypassPermissions"` — Auto-approves tool use (except AskUserQuestion and ExitPlanMode, which are intercepted via `canUseTool`)
- `includePartialMessages: true` — Enables streaming of partial text and tool calls
- Custom MCP servers: `tts-tools` (Speak, SendFile) and `reminder-tools` (ScheduleReminder), plus any registered by plugins

### WebSocket Protocol

**Client → Server:**
- `prompt` — Send a message (or inject one mid-query via `streamInput()`)
- `answer` — Respond to an AskUserQuestion
- `new_session` — Create a new session (optional `cwd`)
- `resume_session` — Resume an existing session by ID
- `list_sessions` — Get all sessions
- `delete_session` — Delete a session
- `clear_context` — Clear session context (archives history, starts fresh)
- `abort` — Stop the current query (calls `query.close()` to kill child processes)
- `set_tts` — Enable/disable text-to-speech
- `set_effort` — Set reasoning effort (low/medium/high/max)
- `set_thinking` — Set thinking mode (adaptive/enabled/disabled)
- `stop_task` — Stop a background task
- `fork_session` — Fork an existing session
- `request_file` — Request chunked file download
- `upload_start` / `upload_chunk` — Chunked file upload
- `load_more_history` — Paginated history loading
- `check_cwd` / `create_cwd` — Validate or create a working directory

**Server → Client:**
- `text` — Streamed text content
- `tool_call` / `tool_result` / `tool_result_chunk` / `tool_progress` / `tool_stderr` — Tool invocations, streaming results (with `chunkIndex` for reassembly), and progress
- `question` — AskUserQuestion relayed as interactive card (with optional `emailPreview`)
- `result` — Query complete (includes cost, usage, turn count)
- `session_created` / `session_history` / `session_list` — Session management
- `status` — Running/idle state
- `compacting` / `compact_boundary` — Context compaction events
- `file_chunk` / `file_complete` — Chunked file transfer (512KB chunks, base64)
- `upload_complete` — File upload confirmation
- `speak` — TTS text
- `file` — File metadata (triggers download button in app)
- `todos` — Todo list updates
- `reminder` — Scheduled reminder
- `task_notification` / `bash_backgrounded` — Background task events
- `error` — Error messages

### Important Behaviors
- Sessions survive client disconnects — the server keeps running queries in the background via a global `activeSessions` Map
- On reconnect, the client's WebSocket is swapped onto the running session via `setWebSocket()`
- `canUseTool` intercepts `AskUserQuestion` to relay questions to the Flutter app as interactive cards
- `canUseTool` intercepts `ExitPlanMode` to show the plan to the user for approval
- Plugin `canUseToolInterceptor` hooks run before built-in handlers (return `null` to pass through)
- First message of each new session is prepended with a tool context prompt (general-purpose identity + TTS instructions if enabled + plugin fragments)
- `stderr` callback is set on the SDK query for diagnostic logging and live bash output streaming
- Session CWD must match the original CWD when resuming (Claude Code stores session files in project-specific directories derived from CWD)
- Message injection: when user sends a message while a query is running, `streamInput()` injects it between tool calls without interrupting current work
- Abort: `query.close()` forcefully terminates the CLI subprocess and all children
- Cancel prefix: when user cancels, next message is prepended with `[The user cancelled your previous action. Follow their instructions below.]`
- Token tracking: per-turn usage from `message_start`/`message_delta` stream events (not cumulative `modelUsage`)
- Missed message recovery: on `resume_session`, reads Claude Code's JSONL session file for messages that occurred while the app was disconnected, persists them to our history store
- Paginated history: loads last 50 entries initially, supports `load_more_history` for older messages
- File transfer: 512KB chunked transfer over WebSocket with progress tracking (no file size limit)
- Tool result chunking: large outputs (>500 chars) are split into 200-char chunks with `chunkIndex` for correct reassembly on the app side
- Background tasks: detects Task tool launches with `run_in_background`, tracks agent IDs, supports stopping via `stopTask()`
- Session forking: create a new session branching from an existing conversation

## Plugin System (`server/plugins/`)

Plugins extend the server with private integrations (email, project management, etc.) without modifying core server files. They are gitignored and not included in the public repo.

### Plugin Interface

Plugins export a `SocketClaudePlugin` object from `server/plugins/<name>.ts`. All hooks are optional except `name`:

```typescript
interface SocketClaudePlugin {
  name: string;
  init?(ctx: PluginContext): void | Promise<void>;
  cleanup?(): void | Promise<void>;
  httpHandler?(req, res): boolean;                          // Handle HTTP requests (return true if handled)
  canUseToolInterceptor?(toolName, input, sessionCtx): Promise<CanUseToolResult>;  // Intercept tool calls
  answerMiddleware?(questionId, answers, sessionCtx): AnswerResult;                // Process question answers
  mcpServers?(): Record<string, any>;                       // Register MCP servers with the SDK
  allowedTools?(): string[];                                // Additional tool patterns to allow
  toolContextFragment?(): string;                           // Prompt fragment for tool instructions
  envVars?(): Record<string, string>;                       // Extra env vars for SDK queries
}
```

### Plugin Loading
- Server scans `server/plugins/*.js` at startup via `require()`
- Files that export an object with a `.name` property are registered as plugins
- Plugins are initialized in order after the server starts listening
- **Do not place standalone CLI scripts in `plugins/`** — they will be `require()`'d and execute. Put CLI tools in `server/tools/` instead.

### Plugin Compilation
Plugins have their own `tsconfig.json` in `server/plugins/`:
```bash
cd server/plugins && npx tsc
```
Plugin imports reference compiled server code: `import { ... } from "../dist/plugin-api"` (not `../src/`).

### Tools Directory (`server/tools/`)
Standalone CLI scripts that plugins or MCP servers invoke as subprocesses. These are NOT loaded by the plugin loader. Gitignored along with plugins.

### Hook Execution Order
1. **HTTP**: Plugin `httpHandler` runs before the server's 404 default
2. **canUseTool**: Plugin interceptors run before built-in AskUserQuestion/ExitPlanMode handlers
3. **Answer**: Plugin `answerMiddleware` runs before default question resolution
4. **MCP/Tools/Env**: Merged into SDK query options at query start
5. **Cleanup**: Called on SIGTERM/SIGINT during graceful shutdown

See `server/plugins/README.md` for a full authoring guide with examples.

## Flutter App (`app/`)

### Key Files

**Screens:**
- `lib/main.dart` — App entry, theme, provider setup
- `lib/screens/home_screen.dart` — Active chat screen with input bar, token/cost display, compacting banner
- `lib/screens/sessions_screen.dart` — Session list with CWD picker (long-press FAB), delete, resume
- `lib/screens/settings_screen.dart` — Server host/port/token config, TTS voice picker

**Services:**
- `lib/services/websocket_service.dart` — WebSocket connection with auto-reconnect
- `lib/services/speech_service.dart` — Speech-to-text with session-based listening, auto-restart, text accumulation
- `lib/services/tts_service.dart` — Text-to-speech output via flutter_tts
- `lib/services/notification_service.dart` — Local notification scheduling for reminders
- `lib/services/chat_provider.dart` — Central state management: messages, sessions, connection, files, todos, TTS, speech, abort/cancel, message injection, download progress

**Widgets:**
- `lib/widgets/chat_view.dart` — Main chat ListView with "Load More" pagination at top
- `lib/widgets/message_bubble.dart` — Text message rendering with markdown, strips `<system-reminder>` and `<local-command-caveat>` tags
- `lib/widgets/tool_output_block.dart` — Terminal-style tool output (dark, monospace, collapsible)
- `lib/widgets/question_card.dart` — Interactive AskUserQuestion cards with option chips + text input
- `lib/widgets/email_preview_card.dart` — Email/approval preview card with To/CC/Subject/Body (generic, reusable)
- `lib/widgets/file_card.dart` — File download card with progress indicator, open/save actions
- `lib/widgets/speak_card.dart` — TTS speech bubble display
- `lib/widgets/todo_list_card.dart` — Collapsible todo list with status indicators
- `lib/widgets/reminder_card.dart` — Scheduled reminder display

**Models:**
- `lib/models/message.dart` — Chat message types (text, tool_call, tool_result, question, result, file, speak, todos)

### Build & Install
```bash
cd app && flutter build apk --release
adb install -r app/build/app/outputs/flutter-apk/app-release.apk
```

- Use `--release` for production builds, `--debug` for development
- ADB wireless: `adb connect <phone-ip>:<port>` (check phone's wireless debugging settings for current port)
- Both `flutter` and `adb` are available in PATH via the systemd service configuration

### Android Integration
- App name: "SocketClaude"
- Samsung AI button: registered as ASSIST intent handler in AndroidManifest.xml — launches app when side key is pressed
- Permissions: RECORD_AUDIO, INTERNET, BLUETOOTH, BLUETOOTH_CONNECT, POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM

### App Features
- **Chat**: Full markdown rendering, auto-scroll with smart detection, streamed text display
- **Voice input**: Session-based STT with auto-restart, text accumulation, append mode
- **TTS output**: Speak tool renders speech bubbles, configurable voice in settings
- **Tool output**: Collapsible terminal-style blocks with monospace font, bash command formatting, live streaming
- **Questions**: Interactive option cards relayed from AskUserQuestion, with multi-select and free text
- **Files**: Chunked download with progress bar, save to Downloads, open with system app; chunked upload from phone
- **Todos**: Collapsible todo list card with pending/in-progress/completed states
- **Reminders**: Schedule notifications via ScheduleReminder tool
- **Sessions**: Create, resume, delete, fork, clear context. Long-press FAB for CWD picker with recent paths and custom input
- **History pagination**: Load last 50 messages initially, "Load More" button at top for older messages
- **Message injection**: Send messages while Claude is working — injected between tool calls via `streamInput()`
- **Abort/Cancel**: Stop button kills query and child processes, next message includes cancel context
- **Auto-reconnect**: WebSocket reconnects automatically, re-syncs session state including missed messages
- **Compacting indicator**: Banner shown when Claude is compacting context window
- **Token tracking**: Shows input tokens, cache read/create, context window usage, cost per turn
- **Background tasks**: Track and stop long-running background tasks
- **Effort & Thinking**: Configurable reasoning effort and thinking mode

## Data Files
- `~/.claude-assistant/sessions.json` — Session metadata (title, CWD, timestamps, last usage)
- `~/.claude-assistant/history/` — Per-session chat history (JSON arrays of HistoryEntry)
- `~/.claude-assistant/todos/` — Per-session todo lists
- `~/.claude-assistant/archive/` — Archived session data (from context clears)
- `~/.claude/projects/` — Claude Code session JSONL files (used for missed message recovery)
