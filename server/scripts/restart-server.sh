#!/bin/bash
# Startup owns durable recovery; this worker only prepares and restarts.
set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_CONTROL="$SERVER_DIR/scripts/service-control.sh"
if [[ -z "${_RESTART_DETACHED:-}" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    JOB_LABEL="com.socketagent.restart.$$"
    DETACH_LOG="${TMPDIR:-/tmp}/socketagent-restart-$$.log"
    launchctl submit -l "$JOB_LABEL" -o "$DETACH_LOG" -e "$DETACH_LOG" -- \
      /usr/bin/env _RESTART_DETACHED=1 _RESTART_LAUNCHD_LABEL="$JOB_LABEL" /bin/bash "$SCRIPT_PATH" "$@"
    echo "Restart job scheduled as $JOB_LABEL"
  else
    systemd-run --user --unit="socketagent-restart-$$" --collect \
      --setenv="_RESTART_DETACHED=1" /bin/bash "$SCRIPT_PATH" "$@"
    echo "Restart job scheduled as socketagent-restart-$$.service"
  fi
  exit 0
fi
COMPILE=true
BOOTSTRAP_SESSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-compile) COMPILE=false; shift ;;
    --compile) COMPILE=true; shift ;;
    --bootstrap-session)
      [[ $# -ge 2 ]] || { echo "--bootstrap-session requires an ID" >&2; exit 1; }
      BOOTSTRAP_SESSION="$2"; shift 2 ;;
    --session)
      [[ $# -ge 2 ]] || { echo "--session requires an ID" >&2; exit 1; }
      echo "Only interrupted runs will resume; explicit idle session selection is ignored."
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
SERVICE_DIR="$("$SERVICE_CONTROL" directory)"
SERVICE_ENV_PATH="$("$SERVICE_CONTROL" environment-file)"
ENV_PATH="${SERVICE_ENV_PATH:-$SERVICE_DIR/.env}"
if [[ -f "$ENV_PATH" ]]; then
  set -a
  source "$ENV_PATH"
  set +a
fi
export PORT="${PORT:-8085}"
if [[ -z "${AUTH_TOKEN:-}" ]]; then
  echo "Restart aborted: AUTH_TOKEN was not found in the active service environment file: $ENV_PATH" >&2
  exit 1
fi
export AUTH_TOKEN
STORE_DIR="${SOCKETAGENT_DATA_DIR:-$HOME/.socket-agent}"
if [[ ! -d "$STORE_DIR" && -d "$HOME/.claude-assistant" ]]; then STORE_DIR="$HOME/.claude-assistant"; fi
mkdir -p "$STORE_DIR/recovery"
exec > "$STORE_DIR/recovery/restart-worker-$$.log" 2>&1
if [[ "$(uname -s)" == "Linux" ]]; then
  # Held by this detached worker across the service restart and released by
  # the OS on exit, including crashes. Never run two compilation/restarts.
  exec 9> "$STORE_DIR/recovery/restart.lock"
  flock -n 9 || { echo "Another restart worker is already running"; exit 1; }
fi
# Do not install or replace Node while attempting a restart.
RESTART_NODE="${SOCKETAGENT_NODE:-}"
if [[ ! -x "$RESTART_NODE" ]]; then RESTART_NODE="$HOME/.local/share/socketagent/node/bin/node"; fi
if [[ ! -x "$RESTART_NODE" ]]; then RESTART_NODE="$(command -v node)"; fi
export PATH="$(dirname "$RESTART_NODE"):$PATH"
CONTROL="$SERVER_DIR/scripts/restart-control.js"
RECOVERY_SCRIPT="$SERVER_DIR/scripts/recovery-guard.sh"
PREPARED=false
cleanup() {
  if $PREPARED; then
    if [[ -n "$BOOTSTRAP_SESSION" ]]; then
      "$RESTART_NODE" "$SERVER_DIR/scripts/bootstrap-restart.js" cancel "$BOOTSTRAP_SESSION" "$OLD_PID" || true
    else
      "$RESTART_NODE" "$CONTROL" cancel || true
    fi
  fi
  if [[ -n "${_RESTART_LAUNCHD_LABEL:-}" ]]; then launchctl remove "$_RESTART_LAUNCHD_LABEL" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
if $COMPILE; then
  cd "$SERVICE_DIR"
  npx --no-install tsc
  if [[ -f plugins/tsconfig.json ]]; then (cd plugins && npx --no-install tsc); fi
fi
# Captures current runs after compilation. Rejects concurrent prepared restarts.
if [[ -n "$BOOTSTRAP_SESSION" ]]; then
  OLD_PID="$("$RESTART_NODE" "$SERVER_DIR/scripts/bootstrap-restart.js" seed "$BOOTSTRAP_SESSION")"
else
  OLD_PID="$("$RESTART_NODE" "$CONTROL" prepare)"
fi
PREPARED=true
RECOVERY_ID="$("$RECOVERY_SCRIPT" arm manual-restart 180)"
"$SERVICE_CONTROL" restart
PREPARED=false
# Verify initialized process identity. The queue survives this worker and boot.
for ((attempt=0; attempt<60; attempt++)); do
  if "$RESTART_NODE" "$CONTROL" status "$OLD_PID"; then
    "$RECOVERY_SCRIPT" cancel "$RECOVERY_ID" || true
    echo "New server is ready. Startup owns continuation and retries."
    exit 0
  fi
  sleep 1
done
echo "Readiness not confirmed. Guard remains armed; saved runs will recover at startup." >&2
exit 1
