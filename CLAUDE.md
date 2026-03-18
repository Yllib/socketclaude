# SocketClaude

Chat with Claude Code from your phone. Voice or text, full tool output, file transfer, session management — all through a lightweight server that wraps the Claude Agent SDK.

## Architecture

```
Flutter App (Android) ←—WebSocket (JSON)—→ Node.js Server ←—Agent SDK—→ Claude
                                              ↕
                                         Relay Server (optional, for remote access)
```

- **Server** (`server/`): Node.js + TypeScript WebSocket server on port 8085. Wraps the Claude Agent SDK, manages sessions, streams responses to the app. Supports a plugin API for extensibility and optional relay for remote connections.
- **App** (`app/`): Flutter Android app with chat UI, voice input (STT), TTS output, question cards, tool output blocks, file transfer, todo tracking, and session management. Lives as a nested git repo (gitignored from this repo).

## Server (`server/`)

### Key Files
- `src/index.ts` — WebSocket server entry point, auth, session routing, global session registry for background persistence, chunked file transfer handler, CWD validation, plugin loading
- `src/claude-session.ts` — Agent SDK `query()` wrapper. Handles streaming, `canUseTool` for AskUserQuestion relay, tool context injection, message injection via `streamInput()`, per-turn token tracking, compacting detection
- `src/protocol.ts` — TypeScript interfaces for all WebSocket message types (client→server and server→client)
- `src/session-store.ts` — Session metadata and chat history persistence to `~/.claude-assistant/`, paginated history loading, missed message recovery from JSONL
- `src/plugin-api.ts` — Plugin API interfaces — plugins receive server context at init, can register HTTP routes and intercept tool calls
- `src/relay-client.ts` — Connects to a relay server for remote access (pairing-based, encrypted)
- `src/relay-crypto.ts` — NaCl encryption for relay communication (tweetnacl)

### Plugins (`server/plugins/`)

Plugins are gitignored (private). Each plugin exports an `init(context)` function implementing the `SocketClaudePlugin` interface.

- **`outlook-auth-plugin.ts`** — Corporate Outlook/Microsoft token capture via the app's WebView
  - Sends `{ type: "outlook_auth", authRequestId }` to the app (dedicated card, NOT a question card)
  - App shows `OutlookAuthCard` → user taps "Sign In" → opens `OutlookAuthScreen` WebView on `webmail.jci.com`
  - WebView injects JS to intercept XHR/fetch requests and capture OAuth tokens (access tokens, refresh tokens, clientId, tenantId)
  - App sends captured tokens back via the answer flow (authRequestId prefixed with `outlook_auth_`)
  - Plugin's `answerMiddleware` catches the answer, stores tokens to `~/.claude-assistant/outlook-tokens.json`
  - HTTP endpoints: `GET /auth/outlook` (trigger auth card), `GET /auth/outlook/token` (get current access token — auto-sends auth card if expired), `GET /auth/outlook/status` (check token status)
  - `envVars()` injects `OUTLOOK_ACCESS_TOKEN` into SDK queries; `toolContextFragment()` tells Claude about token availability
- **`email-approval-plugin.ts`** — Intercepts email send commands, relays approval cards to the app, resolves HTTP response back to the email tool

Compile plugins:
```bash
cd /home/rdp/claude/socketclaude-public/server/plugins && npx tsc
```

### Scripts (`server/scripts/`)

- **`restart-server.sh`** — Server restart with app notifications and history injection
  - **Use this script to restart the server** instead of raw `systemctl restart`, especially when running from the app
  - Escapes the socketclaude service's cgroup via `systemd-run --user --scope` so the script survives the service restart
  - Writes `[Server restart initiated ...]` to session history → app renders as a dedicated restart card (matched by `^\[Server restart .*\]$` regex)
  - Compiles TypeScript (server + plugins) unless `--no-compile` is passed
  - Restarts the `socketclaude` systemd service
  - Writes `[Server restart complete.]` to history immediately after `systemctl restart` returns (before Node.js opens port, so it's in history before the app reconnects)
  - Verifies server came back up (port check with 15s timeout)
  - Flags: `--no-compile` (skip compilation), `--session SESSION_ID` (target specific session, default: most recently active)
  - History entries use `[Server restart ...]` bracket format — app's history loader matches this regex and renders as `taskNotification` cards with `toolName: 'restarted'`
- **`setup.js`** — Initial server setup (generates auth token, pairing token, NaCl keys, .env)

### Build & Run

**IMPORTANT: You must `cd` into the server directory before starting.** The `.env` file is resolved relative to the server dir, and the process CWD matters.

Compile after code changes:
```bash
cd /home/rdp/claude/socketclaude-public/server && npx tsc
```

The server runs as a **systemd user service** (`socketclaude.service`) that auto-starts on boot.

```bash
# Restart after code changes (compile first, then restart service):
cd /home/rdp/claude/socketclaude-public/server && npx tsc
systemctl --user restart socketclaude
```

```bash
# Check status
systemctl --user status socketclaude
```

```bash
# View live logs
journalctl --user -u socketclaude -f
```

**WARNING:** Restarting the server will kill any active Claude SDK sessions running through it (including the current one if running from the app). The app will auto-reconnect once the new server starts.

**IMPORTANT: When running from the app, always use the restart script** instead of raw `systemctl restart`:
```bash
/home/rdp/claude/socketclaude-public/server/scripts/restart-server.sh
# Or skip compilation if already compiled:
/home/rdp/claude/socketclaude-public/server/scripts/restart-server.sh --no-compile
```
The script escapes the service cgroup (so it survives the restart), writes restart status cards to session history, and compiles before restarting. Both the user and Claude see the restart in chat history.

- Service file: `~/.config/systemd/user/socketclaude.service`
- Auto-restarts on crash (`Restart=on-failure`)
- Runs as user `rdp` with linger enabled (persists without login session)
- `CLAUDECODE` env var is unset automatically by the service

### Config (`.env`)
- `PORT` — WebSocket port (default 8085)
- `AUTH_TOKEN` — Token for client authentication (auto-generated if missing)
- `RELAY_URL` — Relay server WebSocket URL for remote access
- `PAIRING_TOKEN` — Pairing token for relay authentication

### SDK Configuration
The server uses the `claude_code` preset for both system prompt and tools, with these key SDK options:
- `settingSources: ["user", "project"]` — Loads CLAUDE.md files from the session CWD and `~/.claude/`
- `permissionMode: "bypassPermissions"` — Auto-approves tool use (except AskUserQuestion and email sends, which are intercepted via `canUseTool`)
- `includePartialMessages: true` — Enables streaming of partial text and tool calls
- Custom MCP server `tts-tools` registered with Speak and SendFile tools

### WebSocket Protocol

**Client → Server:**
- `prompt` — Send a message (or inject one mid-query via `streamInput()`)
- `answer` — Respond to an AskUserQuestion
- `new_session` — Create a new session (optional `cwd`)
- `resume_session` — Resume an existing session by ID
- `list_sessions` — Get all sessions
- `delete_session` — Delete a session
- `abort` — Stop the current query (calls `query.close()` to kill child processes)
- `set_tts` — Enable/disable text-to-speech
- `request_file` — Request chunked file download
- `load_more_history` — Paginated history loading
- `check_cwd` / `create_cwd` — Validate or create a working directory

**Server → Client:**
- `text` — Streamed text content
- `tool_call` / `tool_result` — Tool invocations and their results
- `question` — AskUserQuestion relayed as interactive card (with optional `emailPreview`)
- `outlook_auth` — Dedicated Outlook auth card (with `authRequestId`) — triggers WebView token capture in app
- `result` — Query complete (includes cost, usage, turn count)
- `session_created` / `session_history` / `session_list` — Session management
- `status` — Running/idle state (sent on resume, always includes running state)
- `status_sync` — Periodic heartbeat (every 10s) with `running`, `serverStartedAt`, `serverPid`, `backgroundTaskIds` — keeps app state in sync after reconnects/restarts
- `compacting` — Context compaction in progress
- `file_chunk` / `file_complete` — Chunked file transfer (512KB chunks, base64)
- `speak` — TTS text
- `file` — File metadata (triggers download button in app)
- `todos` — Todo list updates
- `error` — Error messages

### Important Behaviors
- Sessions survive client disconnects — the server keeps running queries in the background via a global `activeSessions` Map
- On reconnect, the client's WebSocket is swapped onto the running session via `setWebSocket()`
- `canUseTool` intercepts `AskUserQuestion` to relay questions to the Flutter app as interactive cards
- `canUseTool` intercepts email send commands to require explicit user confirmation (shows email preview)
- First message of each new session is prepended with a tool context prompt (general-purpose identity + email tool instructions)
- Session CWD must match the original CWD when resuming (Claude Code stores session files in project-specific directories derived from CWD)
- Message injection: when user sends a message while a query is running, `streamInput()` injects it between tool calls without interrupting current work
- Abort: `query.close()` forcefully terminates the CLI subprocess and all children
- Cancel prefix: when user cancels, next message is prepended with `[The user cancelled your previous action. Follow their instructions below.]`
- Token tracking: per-turn usage from `message_start`/`message_delta` stream events (not cumulative `modelUsage`)
- Missed message recovery: on `resume_session`, reads Claude Code's JSONL session file for messages that occurred while the app was disconnected, persists them to our history store
- Paginated history: loads last 50 entries initially, supports `load_more_history` for older messages
- File transfer: 512KB chunked transfer over WebSocket with progress tracking (no file size limit)
- Relay: optional encrypted relay connection for remote access — pairs via token, encrypts all traffic with NaCl
- Status sync heartbeat: server broadcasts `status_sync` every 10s to all clients with `running`, `serverStartedAt`, `serverPid`, and `backgroundTaskIds` — app uses this to detect server restarts (compares `serverStartedAt`) and reconcile stale processing/task state
- On `resume_session`, server always sends `status` with `running: true/false` (not just when running) so the app resets its processing indicator correctly after restarts
- Restart history cards: messages written to history in `[Server restart ...]` bracket format are rendered as dedicated taskNotification cards in the app (regex: `^\[Server restart .*\]$`, renders with `toolName: 'restarted'`)

## Flutter App (`app/`)

The app lives as a nested git repo inside `app/` (gitignored from this repo).

### Key Files

**Screens:**
- `lib/main.dart` — App entry, theme, provider setup
- `lib/screens/home_screen.dart` — Active chat screen with input bar, token/cost display, compacting banner
- `lib/screens/sessions_screen.dart` — Session list with CWD picker (long-press FAB), delete, resume
- `lib/screens/settings_screen.dart` — Server host/port/token config, TTS voice picker
- `lib/screens/outlook_auth_screen.dart` — WebView-based Outlook OAuth token capture (loads webmail.jci.com, injects JS to intercept XHR/fetch, captures tokens)

**Services:**
- `lib/services/websocket_service.dart` — WebSocket connection with auto-reconnect
- `lib/services/speech_service.dart` — Speech-to-text with session-based listening, auto-restart, text accumulation
- `lib/services/tts_service.dart` — Text-to-speech output via flutter_tts
- `lib/services/chat_provider.dart` — Central state management: messages, sessions, connection, files, todos, TTS, speech, abort/cancel, message injection, download progress

**Widgets:**
- `lib/widgets/chat_view.dart` — Main chat ListView with "Load More" pagination at top
- `lib/widgets/message_bubble.dart` — Text message rendering with markdown
- `lib/widgets/tool_output_block.dart` — Terminal-style tool output (dark, monospace, collapsible)
- `lib/widgets/question_card.dart` — Interactive AskUserQuestion cards with option chips + text input
- `lib/widgets/email_preview_card.dart` — Email send confirmation with To/CC/Subject/Body preview
- `lib/widgets/file_card.dart` — File download card with progress indicator, open/save actions
- `lib/widgets/speak_card.dart` — TTS speech bubble display
- `lib/widgets/todo_list_card.dart` — Collapsible todo list with status indicators
- `lib/widgets/outlook_auth_card.dart` — Dedicated Outlook auth card with "Sign In" button (navigates to OutlookAuthScreen)
- `lib/widgets/voice_button.dart` — Mic toggle for STT

**Models:**
- `lib/models/message.dart` — Chat message types (text, tool_call, tool_result, question, result, file, speak, todos)

### Build & Install
```bash
export PATH="/opt/flutter/bin:/home/rdp/Android/Sdk/platform-tools:$PATH"
cd /home/rdp/claude/socketclaude-public/app && flutter build apk --release
```

- Both `flutter` and `adb` are on PATH via `~/.profile` — use the export above if not available in current shell
- Use `--release` for production builds, `--debug` for development
- Check `adb devices` first — if a device is connected, use `adb install`. If no device, use the SendFile MCP tool to deliver the APK

### Android Integration
- App name: "SocketClaude"
- Samsung AI button: registered as ASSIST intent handler in AndroidManifest.xml — launches app when side key is pressed
- Permissions: RECORD_AUDIO, INTERNET, BLUETOOTH, BLUETOOTH_CONNECT

### App Features
- **Chat**: Full markdown rendering, auto-scroll with smart detection, streamed text display
- **Voice input**: Session-based STT with auto-restart, text accumulation, append mode
- **TTS output**: Speak tool renders speech bubbles, configurable voice in settings
- **Tool output**: Collapsible terminal-style blocks with monospace font, bash command formatting
- **Questions**: Interactive option cards relayed from AskUserQuestion, with multi-select and free text
- **Email**: Send confirmation with full preview card
- **Files**: Chunked download with progress bar, save to Downloads, open with system app
- **Todos**: Collapsible todo list card with pending/in-progress/completed states
- **Sessions**: Create, resume, delete. Long-press FAB for CWD picker with recent paths and custom input
- **History pagination**: Load last 50 messages initially, "Load More" button at top for older messages
- **Message injection**: Send messages while Claude is working — injected between tool calls via `streamInput()`
- **Abort/Cancel**: Stop button kills query and child processes, next message includes cancel context
- **Auto-reconnect**: WebSocket reconnects automatically, re-syncs session state including missed messages
- **Compacting indicator**: Banner shown when Claude is compacting context window
- **Token tracking**: Shows input tokens, cache read/create, context window usage, cost per turn

## Data Files
- `~/.claude-assistant/sessions.json` — Session metadata (title, CWD, timestamps, last usage)
- `~/.claude-assistant/history/` — Per-session chat history (JSON arrays of HistoryEntry)
- `~/.claude-assistant/outlook-tokens.json` — Captured Outlook OAuth tokens (access tokens, refresh tokens, clientId, tenantId)
- `~/.claude-assistant/relay-keys.json` — NaCl keypair for relay encryption
- `~/.claude/projects/` — Claude Code session JSONL files (used for missed message recovery)
- `.uploads/` — Temporary file storage for uploads

## Windows Installer

- `install.ps1` — PowerShell installer for Windows setup (Node.js, server config, systemd-equivalent)
- `uninstall.ps1` — Uninstaller
