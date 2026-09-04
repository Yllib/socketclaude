#!/usr/bin/env bash

set -euo pipefail

OS_NAME="$(uname -s)"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_LABEL="com.socketagent.server"
MAC_DOMAIN="gui/$(id -u)"
MAC_TARGET="$MAC_DOMAIN/$MAC_LABEL"
MAC_PLIST="$HOME/Library/LaunchAgents/$MAC_LABEL.plist"
MAC_LOG="$SERVER_DIR/socketagent.log"

linux_service_name() {
  if systemctl --user list-unit-files socketagent.service >/dev/null 2>&1; then
    echo "socketagent"
  elif systemctl --user status socketclaude.service >/dev/null 2>&1; then
    echo "socketclaude"
  else
    echo "socketagent"
  fi
}

mac_require_plist() {
  if [[ ! -f "$MAC_PLIST" ]]; then
    echo "SocketAgent launch agent is missing: $MAC_PLIST" >&2
    echo "Run the SocketAgent installer again." >&2
    exit 1
  fi
}

mac_is_loaded() {
  launchctl print "$MAC_TARGET" >/dev/null 2>&1
}

mac_bootstrap() {
  mac_require_plist
  if ! mac_is_loaded; then
    local attempt
    for attempt in $(seq 1 10); do
      if launchctl bootstrap "$MAC_DOMAIN" "$MAC_PLIST" >/dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    if ! mac_is_loaded; then
      launchctl bootstrap "$MAC_DOMAIN" "$MAC_PLIST"
    fi
  fi
  launchctl enable "$MAC_TARGET" >/dev/null 2>&1 || true
}

service_name() {
  case "$OS_NAME" in
    Darwin) echo "$MAC_LABEL" ;;
    Linux) linux_service_name ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

is_active() {
  case "$OS_NAME" in
    Darwin)
      launchctl print "$MAC_TARGET" 2>/dev/null | grep -Eq 'state = running|pid = [0-9]+'
      ;;
    Linux)
      systemctl --user is-active --quiet "$(linux_service_name)"
      ;;
    *) return 1 ;;
  esac
}

start_service() {
  case "$OS_NAME" in
    Darwin)
      mac_bootstrap
      launchctl kickstart "$MAC_TARGET"
      ;;
    Linux)
      systemctl --user start "$(linux_service_name)"
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

stop_service() {
  case "$OS_NAME" in
    Darwin)
      if mac_is_loaded; then
        launchctl bootout "$MAC_TARGET"
      fi
      ;;
    Linux)
      systemctl --user stop "$(linux_service_name)"
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

restart_service() {
  case "$OS_NAME" in
    Darwin)
      mac_bootstrap
      launchctl kickstart -k "$MAC_TARGET"
      ;;
    Linux)
      systemctl --user restart "$(linux_service_name)"
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

status_service() {
  case "$OS_NAME" in
    Darwin)
      launchctl print "$MAC_TARGET"
      ;;
    Linux)
      systemctl --user status "$(linux_service_name)" "$@"
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

service_directory() {
  case "$OS_NAME" in
    Darwin)
      mac_require_plist
      /usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$MAC_PLIST"
      ;;
    Linux)
      systemctl --user show "$(linux_service_name)" --property=WorkingDirectory --value
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

service_environment_file() {
  case "$OS_NAME" in
    Darwin)
      printf '%s/.env\n' "$(service_directory)"
      ;;
    Linux)
      systemctl --user show "$(linux_service_name)" \
        --property=EnvironmentFiles --value \
        | sed -E 's/[[:space:]]+\(ignore_errors=(yes|no)\)$//' \
        | head -n 1
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

logs_service() {
  case "$OS_NAME" in
    Darwin)
      touch "$MAC_LOG"
      exec tail -F "$MAC_LOG" "$@"
      ;;
    Linux)
      exec journalctl --user -u "$(linux_service_name)" -f "$@"
      ;;
    *) echo "Unsupported service platform: $OS_NAME" >&2; exit 1 ;;
  esac
}

case "${1:-}" in
  name)
    service_name
    ;;
  target)
    if [[ "$OS_NAME" == "Darwin" ]]; then echo "$MAC_TARGET"; else linux_service_name; fi
    ;;
  is-active)
    is_active
    ;;
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    restart_service
    ;;
  status)
    shift
    status_service "$@"
    ;;
  directory)
    service_directory
    ;;
  environment-file)
    service_environment_file
    ;;
  logs)
    shift
    logs_service "$@"
    ;;
  *)
    echo "Usage: $0 name|target|directory|environment-file|is-active|start|stop|restart|status|logs" >&2
    exit 2
    ;;
esac
