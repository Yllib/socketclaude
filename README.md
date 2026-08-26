# SocketAgent

Use Claude Code or OpenAI Codex from your Android phone. Install the Android app, install the SocketAgent server on your computer, then pair them with a QR code.

## Download the Android App

Download the latest APK:

[Download SocketAgent for Android](https://github.com/Yllib/socketagent/releases/latest/download/app-release.apk)

## Install the Server

Install the server on the computer you want SocketAgent to control.

### Windows

Open PowerShell and paste this command:

```powershell
irm https://raw.githubusercontent.com/Yllib/socketagent/master/install-windows.ps1 | iex
```

### macOS, Linux, or WSL

Open a terminal and paste this command:

```bash
curl -fsSL https://raw.githubusercontent.com/Yllib/socketagent/master/install.sh | bash
```

The installer needs no choices or sign-in prompts. It installs SocketAgent plus
both supported agent CLIs, starts SocketAgent, and then shows the pairing QR
code. Sign in to Claude or Codex later from the app or the relevant CLI.

## Pair the App

At the end of setup, the installer shows a QR code.

1. Open SocketAgent on your phone.
2. Scan the QR code.
3. Start a session from the app.

If you missed the QR code, run this on the server computer:

```bash
socketagent pair
```

## What Gets Installed

The installer sets up:

- Git if needed
- Node.js if needed
- The SocketAgent server
- Claude and Codex support
- A background service so SocketAgent starts automatically
- A `socketagent` command for pairing, repair, logs, and status

## Useful Commands

Run these on the server computer:

```bash
socketagent pair      # show a new pairing QR code
socketagent status    # check server status
socketagent logs      # view server logs
socketagent doctor    # run basic diagnostics
socketagent restart   # restart the server safely
```

## Notifications

Relay-connected phones use SocketAgent's Firebase project and need no Firebase
setup of their own. Open the computer in the app, choose **Notifications**, grant
Android notification permission, and enroll the phone.

A phone that connects only over the local network needs a Firebase project so
the computer can deliver notifications while the app is closed:

1. Create or open a project in the [Firebase console](https://console.firebase.google.com/).
2. Add an Android app with the package name `com.socketagent.app`. The app
   nickname can be anything. A signing certificate is not required for push
   notifications.
3. Download `google-services.json` to the phone.
4. In SocketAgent, open the computer, choose **Notifications**, then choose
   **Manage Firebase** and **Import JSON**. Close and reopen SocketAgent when it
   asks.
5. In the Firebase console, open **Project settings**, then **Service accounts**.
   Generate a private key for the Firebase Admin SDK and save that JSON file on
   the computer. Do not put this private file on the phone or commit it to Git.
6. Add its absolute path to `server/.env` in the SocketAgent checkout:

   ```env
   FIREBASE_SERVICE_ACCOUNT_PATH=/absolute/path/service-account.json
   ```

7. Run `socketagent restart`, reconnect the app, and enroll the phone under
   **Notifications**.

The phone's `google-services.json` and the computer's service-account JSON must
come from the same Firebase project. The app reports missing permission,
missing registration, unreadable credentials, and project mismatches in the
Notifications section.

## Requirements

- Android phone
- Windows, macOS, Linux, or WSL computer
- Claude Code account if you want Claude sessions
- ChatGPT/Codex account if you want Codex sessions

## Notes

- The server must run from a git checkout. Do not install from a downloaded ZIP.
- Re-running the installer is safe. It keeps existing pairing and auth data.
- Installed servers auto-update when no sessions are active.
- Local data is stored under `~/.claude-assistant/` so existing installs keep their history and pairing.

## Troubleshooting

**The app cannot connect after install**

Run:

```bash
socketagent status
socketagent pair
```

Then scan the new QR code.

**Windows says scripts are blocked**

Run the PowerShell command from this README exactly as written. It includes `-ExecutionPolicy Bypass` for the installer run.

**The QR code disappeared**

Run:

```bash
socketagent pair
```

**The app says a backend is not ready**

Open the server in SocketAgent settings and use the repair or sign-in action for Claude or Codex.

## License

Server: MIT
