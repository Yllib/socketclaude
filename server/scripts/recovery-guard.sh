#!/usr/bin/env bash
#
# recovery-guard.sh — OS-level deadman recovery for SocketAgent restarts.
#
# Arm this before an update/restart operation that may stop the server. If the
# server does not come back before the delay expires, the guard runs outside the
# SocketAgent service job and tries to recover the user service.

set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
SERVER_DIR="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
SERVICE_CONTROL="$SERVER_DIR/scripts/service-control.sh"
OS_NAME="$(uname -s)"
STORE_DIR="${SOCKETAGENT_DATA_DIR:-$HOME/.socket-agent}"
if [[ ! -d "$STORE_DIR" && -d "$HOME/.claude-assistant" ]]; then
  STORE_DIR="$HOME/.claude-assistant"
fi
RECOVERY_DIR="$STORE_DIR/recovery"
LOG_FILE="$RECOVERY_DIR/recovery.log"

log() {
  mkdir -p "$RECOVERY_DIR"
  printf '[%s] %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >> "$LOG_FILE"
}

detect_service_name() {
  "$SERVICE_CONTROL" name
}

read_port() {
  if [[ "${PORT:-}" =~ ^[0-9]+$ ]]; then echo "$PORT"; return; fi
  local env_file
  env_file="$("$SERVICE_CONTROL" environment-file 2>/dev/null || true)"
  env_file="${env_file:-$SERVER_DIR/.env}"
  local port
  port="$(grep -E '^PORT=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  echo "${port:-8085}"
}

unit_safe_id() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '-'
}

marker_file() {
  printf '%s/%s.armed' "$RECOVERY_DIR" "$1"
}

port_is_open() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 2 127.0.0.1 "$port" >/dev/null 2>&1
  elif command -v timeout >/dev/null 2>&1; then
    timeout 2 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  else
    bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1
  fi
}

cleanup_startup_lock() {
  local mode="${1:-safe}"
  local lock_dir="$SERVER_DIR/.startup-repair.lock"
  local pid_file="$lock_dir/pid"
  [[ -d "$lock_dir" ]] || return 0

  if [[ "$mode" == "force" ]]; then
    log "Removing startup repair lock before recovery restart at $lock_dir"
    rm -rf "$lock_dir"
    return 0
  fi

  local pid=""
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    log "Startup repair lock is held by live pid=$pid; leaving it alone"
    return 0
  fi

  if pgrep -u "$(id -u)" -f 'npm ci|npx tsc|git reset|git fetch' >/dev/null 2>&1; then
    log "Startup/update process appears active; leaving startup repair lock alone"
    return 0
  fi

  log "Removing stale startup repair lock at $lock_dir"
  rm -rf "$lock_dir"
}

arm_guard() {
  local reason="${1:-restart}"
  local delay="${2:-180}"
  local service port id unit marker
  service="$(detect_service_name)"
  port="$(read_port)"
  id="$(date +%s)-$$-$(unit_safe_id "$reason")"
  unit="socketagent-recovery-$(unit_safe_id "$id")"
  marker="$(marker_file "$id")"

  mkdir -p "$RECOVERY_DIR"
  printf 'reason=%q\nservice=%q\nport=%q\nserver_dir=%q\narmed_at=%q\n' \
    "$reason" "$service" "$port" "$SERVER_DIR" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" > "$marker"

  local armed=false
  if [[ "$OS_NAME" == "Darwin" ]]; then
    local label="com.socketagent.recovery.$(unit_safe_id "$id")"
    if launchctl submit -l "$label" -o "$LOG_FILE" -e "$LOG_FILE" -- \
      /bin/bash "$SCRIPT_PATH" wait-run "$delay" "$id" "$service" "$port" "$SERVER_DIR" >/dev/null 2>&1; then
      armed=true
    fi
  elif systemd-run --user \
    --unit="$unit" \
    --collect \
    --on-active="${delay}s" \
    "$SCRIPT_PATH" run "$id" "$service" "$port" "$SERVER_DIR" >/dev/null 2>&1; then
    armed=true
  fi

  if [[ "$armed" != "true" ]]; then
    rm -f "$marker"
    log "Failed to arm recovery guard reason=$reason delay=${delay}s"
    return 1
  fi

  log "Armed recovery guard id=$id reason=$reason service=$service port=$port delay=${delay}s"
  echo "$id"
}

cancel_guard() {
  local id="${1:-}"
  [[ -n "$id" ]] || return 0
  local unit="socketagent-recovery-$(unit_safe_id "$id")"
  rm -f "$(marker_file "$id")"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    local label="com.socketagent.recovery.$(unit_safe_id "$id")"
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl bootout "user/$(id -u)/$label" >/dev/null 2>&1 || true
    launchctl remove "$label" >/dev/null 2>&1 || true
  else
    systemctl --user stop "${unit}.timer" "${unit}.service" >/dev/null 2>&1 || true
  fi
  log "Cancelled recovery guard id=$id"
}

run_guard() {
  local id="$1"
  local service="${2:-$(detect_service_name)}"
  local port="${3:-$(read_port)}"
  local marker
  marker="$(marker_file "$id")"

  if [[ ! -f "$marker" ]]; then
    log "Recovery guard id=$id skipped; marker is gone"
    return 0
  fi

  if port_is_open "$port"; then
    log "Recovery guard id=$id complete; server is already listening on port $port"
    rm -f "$marker"
    return 0
  fi

  log "Recovery guard id=$id firing; service=$service port=$port is not listening"
  cleanup_startup_lock force
  if [[ "$OS_NAME" == "Linux" ]]; then
    systemctl --user reset-failed "${service}.service" >/dev/null 2>&1 || true
  fi
  "$SERVICE_CONTROL" restart || "$SERVICE_CONTROL" start

  for _ in $(seq 1 60); do
    if port_is_open "$port"; then
      log "Recovery guard id=$id recovered service=$service on port=$port"
      rm -f "$marker"
      return 0
    fi
    sleep 1
  done

  log "Recovery guard id=$id failed; service=$service did not listen on port=$port after restart"
  return 1
}

wait_and_run_guard() {
  local delay="$1"
  shift
  sleep "$delay"
  local status=0
  run_guard "$@" || status=$?
  if [[ "$OS_NAME" == "Darwin" ]]; then
    local id="$1"
    launchctl remove "com.socketagent.recovery.$(unit_safe_id "$id")" >/dev/null 2>&1 || true
  fi
  return "$status"
}

case "${1:-}" in
  arm)
    arm_guard "${2:-restart}" "${3:-180}"
    ;;
  cancel)
    cancel_guard "${2:-}"
    ;;
  run)
    run_guard "${2:?missing recovery id}" "${3:-}" "${4:-}" "${5:-}"
    ;;
  wait-run)
    wait_and_run_guard "${2:?missing delay}" "${3:?missing recovery id}" "${4:-}" "${5:-}" "${6:-}"
    ;;
  *)
    echo "Usage: $0 arm [reason] [delay_seconds] | cancel <id> | run <id> [service] [port] [server_dir]" >&2
    exit 2
    ;;
esac
