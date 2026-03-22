# SocketClaude

Chat with Claude Code from your phone. Voice or text, full tool output, file transfer, session management — all through a lightweight server that wraps the Claude Agent SDK.

## Architecture

```
Flutter App (Android) ←—WebSocket (JSON)—→ Node.js Server ←—Agent SDK—→ Claude
                                              ↕
                                         Relay Server (wss://, NaCl E2E encrypted)
```

- **Server** (`server/`): Node.js + TypeScript WebSocket server on port 8085. Wraps the Claude Agent SDK, manages sessions, streams responses to the app. Supports a plugin API for extensibility and optional relay for remote connections.
- **App** (`app/`): Flutter Android app. Closed-source, lives as a nested git repo inside `app/` (gitignored from this repo). Private repo: `Yllib/socketclaude-app`.
- **Relay** (`~/claude/socketclaude-relay/`): Separate Node.js service on port 9988, proxied via SWAG at `wss://relay.jarofdirt.info`. Handles pairing, NaCl key exchange, Stripe subscription validation ($5/month, 7-day trial), and message forwarding. Runs as `socketclaude-relay.service`.

## Server (`server/`)

### Folder Structure
- `src/` — TypeScript source. Key files: `index.ts` (WebSocket server, auto-update, .env migrations), `claude-session.ts` (SDK wrapper, MCP tools), `protocol.ts` (all message type interfaces), `session-store.ts` (persistence), `relay-client.ts`/`relay-crypto.ts` (relay + NaCl)
- `plugins/` — Gitignored private plugins implementing `SocketClaudePlugin` from `src/plugin-api.ts`
- `scripts/` — `restart-server.sh`, `setup.js`
- `.env` — PORT, AUTH_TOKEN, RELAY_URL, PAIRING_TOKEN, DEFAULT_CWD

### Build & Run

Compile: `cd /home/rdp/claude/socketclaude-public/server && npx tsc`

Runs as **systemd user service** (`socketclaude.service`). Auto-restarts on crash, auto-updates from git every 60s (resets to origin, installs deps with `npm ci`, compiles, restarts when no sessions active).

**CRITICAL: Do NOT restart the server manually unless absolutely necessary.** To deploy server changes, just commit and push — the auto-update will pick it up within 60s. This applies to all servers (local and remote).

**If a manual restart is truly needed (e.g. server is crashed/stuck), use the restart script** instead of raw `systemctl restart`:
```bash
/home/rdp/claude/socketclaude-public/server/scripts/restart-server.sh
# Or skip compilation if already compiled:
/home/rdp/claude/socketclaude-public/server/scripts/restart-server.sh --no-compile
```
The script escapes the service cgroup (so it survives the restart), writes restart status cards to session history, and compiles before restarting.

### WebSocket Protocol
All message types (client→server and server→client) are defined in `src/protocol.ts`. Key behaviors are documented inline in `src/index.ts` and `src/claude-session.ts`.

## Flutter App (`app/`)

### Folder Structure
- `lib/screens/` — UI screens (home, sessions, onboarding, pairing, paywall, scheduled tasks, etc.)
  - `settings/` — Settings hub with sub-screens (servers, voice/speech, MCP, about)
- `lib/services/` — Business logic (`chat_provider.dart` is the central state manager)
- `lib/widgets/` — Reusable UI components (chat view, tool output, cards, etc.)
- `lib/models/` — Data models (messages, server config, raw events)
- `android/` — Native config (manifest, build.gradle with release signing, Samsung AI button integration)

### Build & Deploy

**CRITICAL: NEVER run `flutter build` directly. ALWAYS use the build script below.** Running `flutter build` directly will bypass signing, version management, and output path conventions. This is a hard rule with no exceptions.

```bash
# Build only (for testing / sending to user):
/home/rdp/claude/socketclaude-public/build-app.sh

# Build + bump patch version + deploy to GitHub Releases:
/home/rdp/claude/socketclaude-public/build-app.sh --deploy

# Build + bump minor/major version + deploy:
/home/rdp/claude/socketclaude-public/build-app.sh --deploy --bump minor
```

The deploy script bumps the version in `pubspec.yaml`, builds the APK, commits, pushes both repos, creates a GitHub Release with the APK attached, and updates `app-version.json` so existing users see the update banner.

**Delivering the APK:**
- Check `adb devices` first — if a device is connected, use `adb install`
- If no device connected, use the SendFile MCP tool to deliver the APK
- APK location after build: `app/build/app/outputs/flutter-apk/app-release.apk`

**Auto-update:** The app checks `app-version.json` from the public server repo (`Yllib/socketclaude`) on startup. If a newer version exists, it shows an update banner. Users can download and install from Settings > About.

## Data Files
- `~/.claude-assistant/` — Session metadata, chat history, relay keys, scheduled tasks, recent CWDs, protected files config, keystore credentials, Outlook tokens
- `~/.claude/projects/` — Claude Code session JSONL files (used for missed message recovery)

## Installers
- `install.ps1` — Windows installer (Node.js, Claude Code CLI, server deps, scheduled task, QR pairing)
- `install.sh` — Linux installer (Node.js, Claude Code CLI, server deps, systemd service, QR pairing)
- `uninstall.ps1` — Windows uninstaller
