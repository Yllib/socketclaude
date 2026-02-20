# SocketClaude

Chat with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) from your phone. Voice or text, full tool output, file transfer, session management — all through a lightweight server that wraps the Claude Agent SDK.

## Setup

### 1. Install the server

```powershell
git clone https://github.com/Yllib/socketclaude.git
cd socketclaude
powershell -ExecutionPolicy Bypass -File install.ps1
```

The installer handles Node.js, Claude Code CLI, authentication, server build, encryption keys, and Windows service registration.

### 2. Scan the QR code

A QR code appears at the end of installation. Open the SocketClaude app and scan it. Done.

### 3. Management

```powershell
Get-ScheduledTask -TaskName SocketClaude          # Status
Stop-ScheduledTask -TaskName SocketClaude          # Stop
Start-ScheduledTask -TaskName SocketClaude         # Start
Get-Content server\socketclaude.log -Tail 50       # Logs
powershell -File uninstall.ps1                     # Uninstall
```

To update, pull new code and re-run the installer. Existing pairings are preserved.

## How It Works

```
Phone App  <──E2E Encrypted──>  Relay  <──E2E Encrypted──>  Server  <──Agent SDK──>  Claude
```

All communication between your phone and server is end-to-end encrypted (NaCl box: X25519 + XSalsa20-Poly1305). The relay cannot read your messages.

## Features

- Streamed chat with full markdown rendering
- Voice input (speech-to-text) and TTS output
- Interactive question and plan review cards
- Collapsible tool output blocks with live streaming
- Chunked file transfer (upload and download)
- Session management (create, resume, fork, clear context)
- Message injection while Claude is working
- Background task tracking
- Todo list and reminder integration
- Token usage and cost tracking
- Auto-reconnect with missed message recovery
- Samsung AI button integration

## Plugins

Extend the server with private integrations. Drop compiled `.js` files in `server/plugins/` — loaded automatically at startup. See [server/plugins/README.md](server/plugins/README.md).

## License

Server: MIT
