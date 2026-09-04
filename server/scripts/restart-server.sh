#!/bin/bash
#
# restart-server.sh — Restart SocketAgent server with app notifications
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
# 4. Restarts the OS service
# 5. Waits for the server to come back up
# 6. Appends "Server restart complete" and continues ALL sessions
#
# NOTE: This script detaches a worker from the SocketAgent service on first run
# so it survives the service restart.

set -euo pipefail

# Ignore SIGPIPE — after systemctl restart, the Bash tool's stdout pipe is
# broken (old server is dead). Without this, `echo` to a broken pipe kills
# the script before it can write the success message to history.
trap '' PIPE

cleanup_detached_launchd_job() {
  if [[ "$(uname -s)" == "Darwin" && -n "${_RESTART_LAUNCHD_LABEL:-}" ]]; then
    launchctl remove "$_RESTART_LAUNCHD_LABEL" >/dev/null 2>&1 || true
  fi
}

if [[ -n "${_RESTART_DETACHED:-}" ]]; then
  trap cleanup_detached_launchd_job EXIT
fi

# -- Escape the service job so we survive the restart --
if [[ -z "${_RESTART_DETACHED:-}" ]]; then
  SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    JOB_LABEL="com.socketagent.restart.$$"
    DETACH_LOG="${TMPDIR:-/tmp}/socketagent-restart-$$.log"
    launchctl submit -l "$JOB_LABEL" -o "$DETACH_LOG" -e "$DETACH_LOG" -- \
      /usr/bin/env _RESTART_DETACHED=1 _RESTART_LAUNCHD_LABEL="$JOB_LABEL" /bin/bash "$SCRIPT_PATH" "$@"
    echo "Restart job scheduled as $JOB_LABEL"
  else
    UNIT_NAME="socketagent-restart-$$"
    systemd-run --user \
      --unit="$UNIT_NAME" \
      --collect \
      --setenv="_RESTART_DETACHED=1" \
      "$SCRIPT_PATH" "$@"
    echo "Restart job scheduled as ${UNIT_NAME}.service"
  fi
  exit 0
fi

STORE_DIR="${SOCKETAGENT_DATA_DIR:-$HOME/.socket-agent}"
if [[ ! -d "$STORE_DIR" && -d "$HOME/.claude-assistant" ]]; then
  STORE_DIR="$HOME/.claude-assistant"
fi
SESSIONS_FILE="$STORE_DIR/sessions.json"
HISTORY_DIR="$STORE_DIR/history"
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_CONTROL="$SERVER_DIR/scripts/service-control.sh"
SERVICE_NAME="$("$SERVICE_CONTROL" name)"
SERVICE_DIR="$("$SERVICE_CONTROL" directory 2>/dev/null || true)"
SERVICE_ENV_PATH="$("$SERVICE_CONTROL" environment-file 2>/dev/null || true)"
NODE_MIN_VERSION="${SOCKETAGENT_NODE_MIN_VERSION:-22}"
NODE_RUNTIME_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
USER_NODE_DIR="${SOCKETAGENT_NODE_DIR:-$HOME/.local/share/socketagent/node}"

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

RECOVERY_SCRIPT="$SERVER_DIR/scripts/recovery-guard.sh"
RECOVERY_ID=""

# Load the active service's .env for PORT and AUTH_TOKEN. The restart script may
# be invoked from a development checkout while the installed service runs from
# another checkout, so the file beside this script is only a fallback.
ENV_PATH="$SERVER_DIR/.env"
if [[ -n "$SERVICE_ENV_PATH" && -f "$SERVICE_ENV_PATH" ]]; then
  ENV_PATH="$SERVICE_ENV_PATH"
elif [[ -n "$SERVICE_DIR" && -f "$SERVICE_DIR/.env" ]]; then
  ENV_PATH="$SERVICE_DIR/.env"
fi
if [[ -f "$ENV_PATH" ]]; then
  set -a
  source "$ENV_PATH"
  set +a
fi
export SOCKETAGENT_ENV_PATH="$ENV_PATH"
PORT="${PORT:-8085}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
if [[ -z "$AUTH_TOKEN" ]]; then
  echo "Restart aborted: AUTH_TOKEN was not found in the active service environment file: $ENV_PATH" >&2
  exit 1
fi

# Ensure history directory exists
mkdir -p "$HISTORY_DIR"

node_major_version() {
  local candidate="$1"
  local version
  version="$("$candidate" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 || true)"
  [[ "$version" =~ ^[0-9]+$ ]] || return 1
  echo "$version"
}

node_is_usable() {
  local candidate="$1"
  [[ -n "$candidate" ]] || return 1
  if [[ "$candidate" != */* ]]; then
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
  fi
  [[ -x "$candidate" ]] || return 1

  local major
  major="$(node_major_version "$candidate")" || return 1
  (( major >= NODE_MIN_VERSION ))
}

prepend_node_runtime() {
  local candidate="$1"
  if [[ "$candidate" != */* ]]; then
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
  fi

  local node_dir
  node_dir="$(dirname "$candidate")"
  export PATH="$node_dir:$PATH"
  export SOCKETAGENT_NODE="$candidate"
  export SOCKETAGENT_NPM="$node_dir/npm"
  export SOCKETAGENT_NPX="$node_dir/npx"
  echo "Using Node.js $("$candidate" --version) at $candidate"
}

install_managed_node() {
  command -v curl >/dev/null 2>&1 || {
    echo "curl is required to install managed Node.js"
    return 1
  }
  command -v tar >/dev/null 2>&1 || {
    echo "tar is required to install managed Node.js"
    return 1
  }

  local node_arch
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    armv7l) node_arch="armv7l" ;;
    *)
      echo "Unsupported architecture for managed Node.js: $(uname -m)"
      return 1
      ;;
  esac

  local tarball url tmp
  if [[ "$(uname -s)" == "Darwin" ]]; then
    tarball="node-v${NODE_RUNTIME_VERSION}-darwin-${node_arch}.tar.gz"
  else
    tarball="node-v${NODE_RUNTIME_VERSION}-linux-${node_arch}.tar.xz"
  fi
  url="https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${tarball}"
  tmp="${TMPDIR:-/tmp}/${tarball}.$$"

  echo "Installing managed Node.js v${NODE_RUNTIME_VERSION} to $USER_NODE_DIR"
  curl -fSL --retry 3 --connect-timeout 15 -o "$tmp" "$url"

  rm -rf "$USER_NODE_DIR"
  mkdir -p "$USER_NODE_DIR"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    tar -xzf "$tmp" -C "$USER_NODE_DIR" --strip-components=1
  else
    tar -xJf "$tmp" -C "$USER_NODE_DIR" --strip-components=1
  fi
  rm -f "$tmp"

  node_is_usable "$USER_NODE_DIR/bin/node"
}

select_node_runtime() {
  local configured_node="${SOCKETAGENT_NODE:-}"
  if node_is_usable "$configured_node"; then
    prepend_node_runtime "$configured_node"
    return
  fi

  if node_is_usable "$USER_NODE_DIR/bin/node"; then
    prepend_node_runtime "$USER_NODE_DIR/bin/node"
    return
  fi

  local system_node
  system_node="$(command -v node 2>/dev/null || true)"
  if node_is_usable "$system_node"; then
    prepend_node_runtime "$system_node"
    return
  fi

  if [[ -n "$configured_node" ]]; then
    echo "Configured Node.js at $configured_node is missing or older than v${NODE_MIN_VERSION}"
  fi
  if [[ -n "$system_node" ]]; then
    echo "System Node.js at $system_node is missing or older than v${NODE_MIN_VERSION}"
  fi

  install_managed_node
  prepend_node_runtime "$USER_NODE_DIR/bin/node"
}

select_node_runtime

# Ask the running server to append through its in-process sequence allocator.
# Usage: inject_history SESSION_ID ROLE CONTENT
inject_history() {
  local session_id="$1"
  local role="$2"
  local content="$3"
  local payload
  payload="$(node -e '
    const [sessionId, role, content] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ sessionId, role, content }));
  ' "$session_id" "$role" "$content")"
  curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "$payload" \
    "http://127.0.0.1:${PORT}/internal/session-history" >/dev/null
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
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$PORT" >/dev/null 2>&1
  else
    (echo > /dev/tcp/127.0.0.1/"$PORT") 2>/dev/null
  fi
}

echo "=== SocketAgent Server Restart ==="
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
echo "[1/5] Writing restart notification to history..."
echo "$ALL_SESSIONS" | while read -r sid; do
  [[ -z "$sid" ]] && continue
  if inject_history "$sid" "assistant" "[Server restart initiated — compiling and restarting service...]"; then
    echo "  Wrote to session $sid"
  else
    echo "  Warning: could not write restart notification to session $sid"
  fi
done

# Step 2: Compile if requested
if $COMPILE; then
  echo ""
  echo "[2/5] Compiling TypeScript..."
  cd "$SERVER_DIR"
  if npx tsc 2>&1; then
    echo "  Compilation successful"
  else
    echo "  Compilation failed!"
    echo "$ALL_SESSIONS" | while read -r sid; do
      [[ -z "$sid" ]] && continue
      inject_history "$sid" "assistant" "[Server restart FAILED — TypeScript compilation error. Server was NOT restarted.]" || true
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
  echo "[2/5] Skipping compilation (--no-compile)"
fi

# Step 3: Restart the service
echo ""
echo "[3/5] Restarting $SERVICE_NAME service..."
if [[ -x "$RECOVERY_SCRIPT" ]]; then
  if RECOVERY_ID="$("$RECOVERY_SCRIPT" arm manual-restart 180)"; then
    echo "  Recovery guard armed: $RECOVERY_ID"
  else
    echo "  Failed to arm recovery guard; restart aborted"
    echo "$ALL_SESSIONS" | while read -r sid; do
      [[ -z "$sid" ]] && continue
      inject_history "$sid" "assistant" "[Server restart FAILED — recovery guard could not be armed. Server was NOT restarted.]" || true
    done
    exit 1
  fi
fi
# After restart, the parent process (Claude/Codex session) is dead, so stdout is
# a broken pipe. Redirect before invoking the service manager; otherwise output can
# hit EPIPE and set -e exits before we write completion/continue messages.
RESTART_LOG="/tmp/socketagent-restart-$$.log"
exec > "$RESTART_LOG" 2>&1
"$SERVICE_CONTROL" restart
echo "  Restart command sent"

# Step 4: Verify server actually came back up
echo ""
echo "[4/5] Verifying server is up..."
MAX_WAIT=15
WAITED=0
while ! check_server 2>/dev/null; do
  sleep 1
  WAITED=$((WAITED + 1))
  if [[ $WAITED -ge $MAX_WAIT ]]; then
    echo "  Server did not start within ${MAX_WAIT}s"
    echo ""
    echo "Check logs: socketagent logs"
    exit 1
  fi
  printf "  Waiting... (%ds)\n" "$WAITED"
done

echo "  Server is up! (took ${WAITED}s)"

# The new server now owns the allocator, so completion cards cannot collide
# with transcript positions reserved by the process that was restarted.
echo "$ALL_SESSIONS" | while read -r sid; do
  [[ -z "$sid" ]] && continue
  if inject_history "$sid" "assistant" "[Server restart complete.]"; then
    echo "  Wrote success to session $sid"
  else
    echo "  Warning: could not write restart completion to session $sid"
  fi
done

if [[ -n "$RECOVERY_ID" && -x "$RECOVERY_SCRIPT" ]]; then
  "$RECOVERY_SCRIPT" cancel "$RECOVERY_ID" || true
fi

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
