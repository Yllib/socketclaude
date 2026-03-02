#!/bin/bash
#
# restart-server.sh — Restart SocketClaude server with app notifications
#
# Queries the running server for active sessions before restarting, writes
# restart notifications to ALL running sessions' history, and resumes them
# all after the server comes back up.
#
# Usage: ./restart-server.sh [--no-compile] [--session SESSION_ID]
#   --no-compile   Skip TypeScript compilation
#   --session      Target a specific session ID (in addition to running ones)
#
# The script:
# 1. Queries GET /running-sessions to find all actively running sessions
# 2. Appends "Server restart initiated" to all their histories
# 3. Optionally compiles TypeScript
# 4. Restarts the systemd service
# 5. Waits for the server to come back up
# 6. Appends "Server restart complete" and continues ALL sessions
#
# NOTE: This script escapes the socketclaude service's cgroup on first run
# (via systemd-run) so it survives the service restart.

set -euo pipefail

# Ignore SIGPIPE — after systemctl restart, the Bash tool's stdout pipe is
# broken (old server is dead). Without this, `echo` to a broken pipe kills
# the script before it can write the success message to history.
trap '' PIPE

# ── Escape the service cgroup so we survive the restart ──
# When called from within the socketclaude service (e.g., via Claude SDK),
# systemd kills everything in the cgroup on restart. Re-launch ourselves
# under a transient scope unit to escape.
if [[ -z "${_RESTART_DETACHED:-}" ]]; then
  export _RESTART_DETACHED=1
  exec systemd-run --user --scope --unit="socketclaude-restart-$$" "$0" "$@"
fi

STORE_DIR="$HOME/.claude-assistant"
SESSIONS_FILE="$STORE_DIR/sessions.json"
HISTORY_DIR="$STORE_DIR/history"
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="socketclaude"

COMPILE=true
EXTRA_SESSION=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-compile) COMPILE=false; shift ;;
    --compile) COMPILE=true; shift ;;
    --session) EXTRA_SESSION="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Fall back to CLAUDE_SESSION_ID env var if --session wasn't passed
if [[ -z "$EXTRA_SESSION" && -n "${CLAUDE_SESSION_ID:-}" ]]; then
  EXTRA_SESSION="$CLAUDE_SESSION_ID"
fi

# Load .env for PORT and AUTH_TOKEN
if [[ -f "$SERVER_DIR/.env" ]]; then
  set -a
  source "$SERVER_DIR/.env"
  set +a
fi
PORT="${PORT:-8085}"
AUTH_TOKEN="${AUTH_TOKEN:-}"

# Ensure history directory exists
mkdir -p "$HISTORY_DIR"

# Inject a message into a session's history file
# Usage: inject_history SESSION_ID ROLE CONTENT
inject_history() {
  local session_id="$1"
  local role="$2"
  local content="$3"
  local history_file="$HISTORY_DIR/${session_id}.json"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

  # Use node for safe JSON manipulation
  node -e "
    const fs = require('fs');
    const file = '${history_file}';
    let entries = [];
    if (fs.existsSync(file)) {
      try { entries = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    }
    entries.push({
      role: $(printf '%s' "$role" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)))"),
      content: $(printf '%s' "$content" | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)))"),
      timestamp: '${timestamp}'
    });
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
  "
}

# Query the running server for actively running session IDs
get_running_sessions() {
  if [[ -z "$AUTH_TOKEN" ]]; then
    echo ""
    return
  fi
  # curl the running-sessions endpoint; fail silently if server is unreachable
  local response
  response=$(curl -s --max-time 3 "http://localhost:${PORT}/running-sessions?token=${AUTH_TOKEN}" 2>/dev/null) || true
  if [[ -n "$response" ]]; then
    echo "$response" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        try {
          const obj = JSON.parse(d);
          (obj.sessions || []).forEach(s => console.log(s));
        } catch {}
      });
    " 2>/dev/null || true
  fi
}

# Check if server is responding
check_server() {
  local port
  port=$(grep -oP 'PORT=\K\d+' "$SERVER_DIR/.env" 2>/dev/null || echo "8085")
  (echo > /dev/tcp/localhost/"$port") 2>/dev/null
}

echo "=== SocketClaude Server Restart ==="
echo ""

# Get running sessions from the live server
echo "Querying server for running sessions..."
RUNNING_SESSIONS=$(get_running_sessions)

# Merge with extra session (dedup)
ALL_SESSIONS="$RUNNING_SESSIONS"
if [[ -n "$EXTRA_SESSION" ]]; then
  if ! echo "$ALL_SESSIONS" | grep -qx "$EXTRA_SESSION" 2>/dev/null; then
    if [[ -n "$ALL_SESSIONS" ]]; then
      ALL_SESSIONS="$ALL_SESSIONS"$'\n'"$EXTRA_SESSION"
    else
      ALL_SESSIONS="$EXTRA_SESSION"
    fi
  fi
fi

# Fall back to most recently active session if we found nothing
if [[ -z "$ALL_SESSIONS" ]] && [[ -f "$SESSIONS_FILE" ]]; then
  echo "  No running sessions found, falling back to most recently active..."
  ALL_SESSIONS=$(node -e "
    const sessions = JSON.parse(require('fs').readFileSync('${SESSIONS_FILE}', 'utf-8'));
    const sorted = sessions.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
    if (sorted.length > 0) console.log(sorted[0].id);
  " 2>/dev/null || true)
fi

if [[ -z "$ALL_SESSIONS" ]]; then
  echo "Warning: No sessions found"
  echo "Proceeding with restart anyway..."
else
  echo "Target sessions:"
  echo "$ALL_SESSIONS" | while read -r sid; do
    [[ -z "$sid" ]] && continue
    # Mark if it was actively running
    if echo "$RUNNING_SESSIONS" | grep -qx "$sid" 2>/dev/null; then
      echo "  - $sid (running)"
    else
      echo "  - $sid"
    fi
  done
fi

# Step 1: Write "restart initiated" to session history
echo ""
echo "[1/4] Writing restart notification to history..."
echo "$ALL_SESSIONS" | while read -r sid; do
  [[ -z "$sid" ]] && continue
  inject_history "$sid" "assistant" "[Server restart initiated — compiling and restarting service...]"
  echo "  Wrote to session $sid"
done

# Step 2: Compile if requested
if $COMPILE; then
  echo ""
  echo "[2/4] Compiling TypeScript..."
  cd "$SERVER_DIR"
  if npx tsc 2>&1; then
    echo "  Compilation successful"
  else
    echo "  Compilation failed!"
    echo "$ALL_SESSIONS" | while read -r sid; do
      [[ -z "$sid" ]] && continue
      inject_history "$sid" "assistant" "[Server restart FAILED — TypeScript compilation error. Server was NOT restarted.]"
    done
    exit 1
  fi

  # Also compile plugins if they have a tsconfig
  if [[ -f "$SERVER_DIR/plugins/tsconfig.json" ]]; then
    echo "  Compiling plugins..."
    cd "$SERVER_DIR/plugins" && npx tsc 2>&1 || true
  fi
else
  echo ""
  echo "[2/4] Skipping compilation (--no-compile)"
fi

# Step 3: Restart the systemd service
echo ""
echo "[3/4] Restarting $SERVICE_NAME service..."
systemctl --user restart "$SERVICE_NAME"

# After restart, the parent process (Claude SDK) is dead, so stdout is a broken
# pipe. trap '' PIPE prevents SIGPIPE death, but echo still fails with EPIPE and
# set -e would exit. Redirect all subsequent output to a log file.
RESTART_LOG="/tmp/socketclaude-restart-$$.log"
exec > "$RESTART_LOG" 2>&1
echo "  Restart command sent"

# Write success to history immediately after systemctl returns.
# systemd has forked the new process but Node.js hasn't opened the port yet,
# so this lands in history before the app reconnects and requests it.
echo "$ALL_SESSIONS" | while read -r sid; do
  [[ -z "$sid" ]] && continue
  inject_history "$sid" "assistant" "[Server restart complete.]"
  echo "  Wrote success to session $sid"
done

# Step 4: Verify server actually came back up
echo ""
echo "[4/4] Verifying server is up..."
MAX_WAIT=15
WAITED=0
while ! check_server 2>/dev/null; do
  sleep 1
  WAITED=$((WAITED + 1))
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    echo "  Server did not start within ${MAX_WAIT}s"
    echo "$ALL_SESSIONS" | while read -r sid; do
      [[ -z "$sid" ]] && continue
      inject_history "$sid" "assistant" "[Server restart FAILED — service did not come back up within ${MAX_WAIT} seconds.]"
    done
    echo ""
    echo "Check logs: journalctl --user -u $SERVICE_NAME -n 50"
    exit 1
  fi
  printf "  Waiting... (%ds)\n" "$WAITED"
done

echo "  Server is up! (took ${WAITED}s)"

# Step 5: Continue ALL sessions that were running
echo ""
echo "[5/5] Continuing sessions..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "$ALL_SESSIONS" | while read -r sid; do
  [[ -z "$sid" ]] && continue
  echo "  Continuing session $sid..."
  node "$SCRIPT_DIR/continue-session.js" "$sid" \
    "[System: The server restart completed successfully (${WAITED}s). Continue where you left off.]" \
    2>&1 || echo "  Warning: continue-session failed for $sid (non-fatal)"
done

echo ""
echo "=== Restart complete ==="
