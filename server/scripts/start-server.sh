#!/usr/bin/env bash
#
# start-server.sh — service entrypoint with startup self-repair
#
# This runs before dist/index.js so dependency/build corruption can be fixed
# even when the Node server itself cannot start.

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SERVER_DIR"

if [[ "$(uname -s)" == "Darwin" && "${SOCKETAGENT_MACOS_HELPER:-}" != "1" ]]; then
  MACOS_HELPER_INSTALLER="$SERVER_DIR/scripts/install-macos-helper.sh"
  if [[ -x "$MACOS_HELPER_INSTALLER" ]]; then
    "$MACOS_HELPER_INSTALLER" --configure-service || \
      echo "[startup] Warning: could not install SocketAgent Server.app" >&2
  fi
fi

RECOVERY_SCRIPT="$SERVER_DIR/scripts/recovery-guard.sh"
NODE_MIN_VERSION="${SOCKETAGENT_NODE_MIN_VERSION:-22}"
NODE_RUNTIME_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
USER_NODE_DIR="${SOCKETAGENT_NODE_DIR:-$HOME/.local/share/socketagent/node}"
NODE_BIN=""
NPM_BIN=""
NPX_BIN=""
RETRY_WINDOW_SECONDS="${SOCKETAGENT_STARTUP_REPAIR_RETRY_SECONDS:-300}"
LOCK_DIR="$SERVER_DIR/.startup-repair.lock"
LOCK_PID_FILE="$LOCK_DIR/pid"
LOCK_STALE_SECONDS="${SOCKETAGENT_STARTUP_LOCK_STALE_SECONDS:-600}"
LOCK_HELD=false
STARTUP_RECOVERY_ID=""

log() {
  echo "[startup] $*"
}

mark_failure() {
  local name="$1"
  date +%s > "$SERVER_DIR/.startup-${name}-failed-at"
}

clear_failure() {
  local name="$1"
  rm -f "$SERVER_DIR/.startup-${name}-failed-at"
}

recent_failure() {
  local name="$1"
  local stamp="$SERVER_DIR/.startup-${name}-failed-at"
  [[ -f "$stamp" ]] || return 1

  local last now age
  last="$(cat "$stamp" 2>/dev/null || echo 0)"
  [[ "$last" =~ ^[0-9]+$ ]] || return 1
  now="$(date +%s)"
  age=$((now - last))

  if (( age < RETRY_WINDOW_SECONDS )); then
    log "Previous ${name} repair failed ${age}s ago; waiting before retrying to avoid a restart storm"
    return 0
  fi
  return 1
}

lock_age_seconds() {
  local mtime now
  if [[ "$(uname -s)" == "Darwin" ]]; then
    mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)"
  else
    mtime="$(stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)"
  fi
  [[ "$mtime" =~ ^[0-9]+$ ]] || mtime=0
  now="$(date +%s)"
  echo $((now - mtime))
}

lock_is_stale() {
  if [[ ! -d "$LOCK_DIR" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$LOCK_PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    if kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    log "Removing stale startup repair lock (dead pid=$pid)"
    rm -rf "$LOCK_DIR"
    return 0
  fi

  local age
  age="$(lock_age_seconds)"
  if [[ -z "$pid" && "$age" -lt 10 ]]; then
    return 1
  fi

  if [[ -z "$pid" || "$age" -ge "$LOCK_STALE_SECONDS" ]]; then
    log "Removing stale startup repair lock (pid=${pid:-none}, age=${age}s)"
    rm -rf "$LOCK_DIR"
    return 0
  fi

  return 1
}

release_lock() {
  if [[ "$LOCK_HELD" == "true" ]]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=false
    trap - EXIT
  fi
}

arm_startup_recovery() {
  if [[ -n "$STARTUP_RECOVERY_ID" || ! -x "$RECOVERY_SCRIPT" ]]; then
    return
  fi

  STARTUP_RECOVERY_ID="$("$RECOVERY_SCRIPT" arm startup-repair 600 2>/dev/null || true)"
  if [[ -n "$STARTUP_RECOVERY_ID" ]]; then
    log "Startup recovery guard armed: $STARTUP_RECOVERY_ID"
  else
    log "Warning: failed to arm startup recovery guard"
  fi
}

acquire_lock() {
  if [[ "$LOCK_HELD" == "true" ]]; then
    return
  fi

  local waited=0
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    lock_is_stale && continue
    if (( waited >= 60 )); then
      log "Timed out waiting for startup repair lock"
      exit 1
    fi
    log "Waiting for another startup repair to finish..."
    sleep 2
    waited=$((waited + 2))
  done
  echo "$$" > "$LOCK_PID_FILE"
  LOCK_HELD=true
  trap 'release_lock' EXIT
}

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

set_node_runtime() {
  local candidate="$1"
  if [[ "$candidate" != */* ]]; then
    candidate="$(command -v "$candidate" 2>/dev/null || true)"
  fi

  NODE_BIN="$candidate"
  local node_dir
  node_dir="$(dirname "$NODE_BIN")"
  export PATH="$node_dir:$PATH"

  NPM_BIN="$node_dir/npm"
  NPX_BIN="$node_dir/npx"

  if [[ -n "${SOCKETAGENT_NPM:-}" && -x "${SOCKETAGENT_NPM:-}" ]]; then
    NPM_BIN="$SOCKETAGENT_NPM"
  elif [[ ! -x "$NPM_BIN" ]]; then
    NPM_BIN="$(command -v npm 2>/dev/null || true)"
  fi

  if [[ -n "${SOCKETAGENT_NPX:-}" && -x "${SOCKETAGENT_NPX:-}" ]]; then
    NPX_BIN="$SOCKETAGENT_NPX"
  elif [[ ! -x "$NPX_BIN" ]]; then
    NPX_BIN="$(command -v npx 2>/dev/null || true)"
  fi

  log "Using Node.js $("$NODE_BIN" --version) at $NODE_BIN"
}

install_managed_node() {
  command -v curl >/dev/null 2>&1 || {
    log "curl is required to install managed Node.js"
    return 1
  }
  command -v tar >/dev/null 2>&1 || {
    log "tar is required to install managed Node.js"
    return 1
  }

  local node_arch
  case "$(uname -m)" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    armv7l) node_arch="armv7l" ;;
    *)
      log "Unsupported architecture for managed Node.js: $(uname -m)"
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

  log "Installing managed Node.js v${NODE_RUNTIME_VERSION} to $USER_NODE_DIR"
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
    set_node_runtime "$configured_node"
    return
  fi

  if [[ -n "$configured_node" ]]; then
    log "Configured Node.js at $configured_node is missing or older than v${NODE_MIN_VERSION}; checking managed runtime"
  fi

  if node_is_usable "$USER_NODE_DIR/bin/node"; then
    set_node_runtime "$USER_NODE_DIR/bin/node"
    return
  fi

  local system_node
  system_node="$(command -v node 2>/dev/null || true)"
  if node_is_usable "$system_node"; then
    set_node_runtime "$system_node"
    return
  fi

  if [[ -n "$system_node" ]]; then
    log "System Node.js at $system_node is missing or older than v${NODE_MIN_VERSION}; installing managed runtime"
  else
    log "Node.js v${NODE_MIN_VERSION}+ not found; installing managed runtime"
  fi

  acquire_lock
  arm_startup_recovery
  if ! node_is_usable "$USER_NODE_DIR/bin/node"; then
    run_repair "node" install_managed_node
  fi
  set_node_runtime "$USER_NODE_DIR/bin/node"
}

deps_resolve() {
  "$NODE_BIN" - <<'NODE'
const modules = [
  "@anthropic-ai/claude-agent-sdk",
  "dotenv",
  "tweetnacl",
  "ws",
  "zod",
];

for (const name of modules) {
  require.resolve(name);
}
NODE
}

deps_need_install() {
  [[ -d node_modules ]] || return 0
  [[ -f node_modules/.package-lock.json ]] || return 0
  if [[ -f package-lock.json && package-lock.json -nt node_modules/.package-lock.json ]]; then
    return 0
  fi
  if [[ -f package.json && package.json -nt node_modules/.package-lock.json ]]; then
    return 0
  fi

  local deps_log="${TMPDIR:-/tmp}/socketagent-startup-deps-$$.log"
  deps_resolve >"$deps_log" 2>&1 && return 1
  log "Dependency check failed:"
  sed 's/^/[startup]   /' "$deps_log" || true
  return 0
}

run_repair() {
  local name="$1"
  shift

  if recent_failure "$name"; then
    exit 1
  fi

  log "Running repair: $*"
  if "$@"; then
    clear_failure "$name"
    log "Repair complete: $name"
  else
    mark_failure "$name"
    log "Repair failed: $name"
    exit 1
  fi
}

build_needs_compile() {
  [[ -f dist/index.js ]] || return 0
  if [[ -f tsconfig.json && tsconfig.json -nt dist/index.js ]]; then
    return 0
  fi

  if find src -type f -name '*.ts' -newer dist/index.js -print -quit 2>/dev/null | grep -q .; then
    return 0
  fi

  return 1
}

select_node_runtime

if deps_need_install; then
  acquire_lock
  arm_startup_recovery
  if deps_need_install; then
    run_repair "npm" "$NPM_BIN" ci --include=optional
  fi
fi

if build_needs_compile; then
  acquire_lock
  arm_startup_recovery
  if build_needs_compile; then
    run_repair "tsc" "$NPX_BIN" tsc
  fi
fi

if ! "$NODE_BIN" scripts/install-browser-runtime.js; then
  log "Browser runtime is unavailable; BrowserSession will remain disabled"
fi

log "Starting SocketAgent server"
release_lock
exec "$NODE_BIN" "$SERVER_DIR/dist/index.js"
