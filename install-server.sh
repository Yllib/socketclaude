#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════
#  SocketAgent Linux/macOS Server Installer
# ══════════════════════════════════════════════
#
# Installs everything needed to run SocketAgent server on Linux or macOS:
# Node.js, both supported agent CLIs, server dependencies, configuration, and
# an OS-native background service. Agent sign-in happens later in the app or
# directly through the relevant CLI.
#
# Usage:
#   bash install-server.sh [--reset-pairing] [--port PORT]
#
# Re-running is safe — existing tokens and pairings are preserved.

RELAY_URL="wss://relay.jarofdirt.info"
SERVICE_NAME="socketagent"
NODE_MIN_VERSION=22
NODE_RUNTIME_VERSION="${SOCKETAGENT_NODE_VERSION:-22.22.1}"
PORT=8085
RESET_PAIRING=false
SERVER_BUILD_DONE=false

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --reset-pairing) RESET_PAIRING=true; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Paths
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"
ENV_FILE="$SERVER_DIR/.env"
SOCKET_AGENT_HOME="${SOCKET_AGENT_HOME:-$HOME/.socket-agent}"
DATA_DIR="${SOCKETAGENT_DATA_DIR:-$SOCKET_AGENT_HOME}"
LEGACY_DATA_DIR="$HOME/.claude-assistant"
KEYS_FILE="$DATA_DIR/relay-keys.json"
SETUP_SCRIPT="$SERVER_DIR/scripts/setup.js"
USER_NODE_DIR="${SOCKETAGENT_NODE_DIR:-$HOME/.local/share/socketagent/node}"
NPM_GLOBAL_DIR="${SOCKETAGENT_NPM_GLOBAL_DIR:-$SOCKET_AGENT_HOME/toolchains/npm-global}"
NPM_BIN_DIR="$NPM_GLOBAL_DIR/bin"
OS_NAME="$(uname -s)"

case "$OS_NAME" in
  Linux|Darwin) ;;
  *)
    echo "Unsupported operating system: $OS_NAME" >&2
    echo "Use install.ps1 on Windows." >&2
    exit 1
    ;;
esac

if [[ -x "$USER_NODE_DIR/bin/node" ]]; then
  export PATH="$USER_NODE_DIR/bin:$PATH"
fi
mkdir -p "$NPM_BIN_DIR"
export NPM_CONFIG_PREFIX="$NPM_GLOBAL_DIR"
export PATH="$NPM_BIN_DIR:$PATH"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

phase() { echo -e "\n${CYAN}--- $1 ---${NC}"; }
ok()    { echo -e "  ${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "  ${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "  ${RED}[X]${NC} $1"; }

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Administrator access is required to install system dependencies."
    exit 1
  fi
}

native_build_tools_ready() {
  command -v python3 >/dev/null 2>&1 \
    && command -v make >/dev/null 2>&1 \
    && { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1; }
}

ensure_native_build_tools() {
  native_build_tools_ready && return

  echo "  Installing the compiler tools required by native Node packages..."
  if [[ "$OS_NAME" == "Darwin" ]]; then
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    while ! native_build_tools_ready; do
      if (( waited >= 1800 )); then
        fail "Timed out waiting for the macOS Command Line Tools installation."
        exit 1
      fi
      sleep 10
      waited=$((waited + 10))
    done
  elif command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y gcc-c++ make python3
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y gcc-c++ make python3
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --noconfirm base-devel python
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install gcc-c++ make python3
  elif command -v apk >/dev/null 2>&1; then
    run_as_root apk add build-base python3
  else
    fail "No supported package manager was found for native build tools."
    exit 1
  fi

  native_build_tools_ready || {
    fail "Native build tools were installed, but Python, make, or a C++ compiler is still unavailable."
    exit 1
  }
  ok "Native build tools are ready"
}

require_git_checkout() {
  if ! command -v git >/dev/null 2>&1; then
    fail "Git is required. SocketAgent must be installed from a git checkout."
    echo "  Install git, then run:"
    echo "    git clone https://github.com/Yllib/socketagent.git"
    echo "    cd socketagent"
    echo "    bash install.sh"
    exit 1
  fi
  if ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "SocketAgent must be installed from a git checkout; zip/archive installs are not supported."
    echo "  Run:"
    echo "    git clone https://github.com/Yllib/socketagent.git"
    echo "    cd socketagent"
    echo "    bash install.sh"
    exit 1
  fi
}

ensure_shell_path() {
  local path_entry="$1"
  local label="$2"
  case ":$PATH:" in
    *":$path_entry:"*) return ;;
  esac

  local shell_rc="$HOME/.profile"
  case "$(basename "${SHELL:-}")" in
    bash) shell_rc="$HOME/.bashrc" ;;
    zsh) shell_rc="$HOME/.zshrc" ;;
  esac

  if [[ -f "$shell_rc" ]] && ! grep -q "$path_entry" "$shell_rc"; then
    printf '\n# %s\nexport PATH="%s:$PATH"\n' "$label" "$path_entry" >> "$shell_rc"
    ok "Added $path_entry to PATH in $shell_rc"
  else
    warn "Add this to your shell profile if needed: export PATH=\"$path_entry:\$PATH\""
  fi
}

phase "Repository Check"
require_git_checkout
ok "Repository checkout verified"

install_cli() {
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"
  ln -sf "$REPO_ROOT/bin/socketagent" "$bin_dir/socketagent"
  ln -sf "$REPO_ROOT/bin/socketagent" "$bin_dir/socketclaude"
  ok "Installed socketagent command to $bin_dir"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *)
      warn "$bin_dir is not currently on PATH."
      local shell_rc="$HOME/.profile"
      case "$(basename "${SHELL:-}")" in
        bash) shell_rc="$HOME/.bashrc" ;;
        zsh) shell_rc="$HOME/.zshrc" ;;
      esac
      if [[ -f "$shell_rc" ]] && ! grep -q 'HOME/.local/bin' "$shell_rc"; then
        printf '\n# SocketAgent CLI\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$shell_rc"
        ok "Added ~/.local/bin to PATH in $shell_rc"
      else
        warn "Add this to your shell profile if needed: export PATH=\"\$HOME/.local/bin:\$PATH\""
      fi
      ;;
  esac
}

install_server_dependencies_and_build() {
  if [[ "$SERVER_BUILD_DONE" == "true" ]]; then
    ok "Server dependencies already installed and built"
    return
  fi

  echo "  Running npm install --include=optional..."
  (cd "$SERVER_DIR" && npm install --include=optional)
  ok "Dependencies installed"

  echo "  Compiling TypeScript..."
  (cd "$SERVER_DIR" && npx tsc)
  ok "Server built successfully"
  SERVER_BUILD_DONE=true
}

echo ""
echo -e "  ${CYAN}SocketAgent Installer${NC}"
echo -e "  ${CYAN}======================${NC}"
echo ""

# Verify repo structure
if [[ ! -d "$SERVER_DIR" ]] || [[ ! -f "$SERVER_DIR/package.json" ]]; then
  fail "Cannot find server/package.json. Run this script from the SocketAgent repo root."
  exit 1
fi

# ══════════════════════════════════════════════
#  Phase 1: Node.js
# ══════════════════════════════════════════════

phase "Phase 1: Node.js"

NEED_NODE_INSTALL=false
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [[ "$NODE_VERSION" -ge "$NODE_MIN_VERSION" ]]; then
    ok "Node.js $(node --version) already installed"
  else
    warn "Node.js v$(node --version) found but v$NODE_MIN_VERSION+ required. Upgrading..."
    NEED_NODE_INSTALL=true
  fi
else
  echo "  Node.js not found. Installing..."
  NEED_NODE_INSTALL=true
fi

if [[ "$NEED_NODE_INSTALL" == "true" ]]; then
  # Install a private Node.js runtime so service startup does not depend on a
  # package manager or the user's interactive shell configuration.
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l)
      if [[ "$OS_NAME" == "Darwin" ]]; then
        fail "Unsupported macOS architecture: $ARCH"
        exit 1
      fi
      NODE_ARCH="armv7l"
      ;;
    *) fail "Unsupported architecture: $ARCH"; exit 1 ;;
  esac

  NODE_INSTALL_DIR="$USER_NODE_DIR"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    NODE_TARBALL="node-v${NODE_RUNTIME_VERSION}-darwin-${NODE_ARCH}.tar.gz"
  else
    NODE_TARBALL="node-v${NODE_RUNTIME_VERSION}-linux-${NODE_ARCH}.tar.xz"
  fi
  NODE_URL="https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${NODE_TARBALL}"

  NODE_TMP="${TMPDIR:-/tmp}/${NODE_TARBALL}.$$"
  echo "  Downloading Node.js v${NODE_RUNTIME_VERSION} for ${NODE_ARCH}..."
  curl -fSL --retry 3 --connect-timeout 15 --progress-bar -o "$NODE_TMP" "$NODE_URL"

  echo "  Installing to ${NODE_INSTALL_DIR}..."
  rm -rf "$NODE_INSTALL_DIR"
  mkdir -p "$NODE_INSTALL_DIR"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    tar -xzf "$NODE_TMP" -C "$NODE_INSTALL_DIR" --strip-components=1
  else
    tar -xJf "$NODE_TMP" -C "$NODE_INSTALL_DIR" --strip-components=1
  fi
  rm -f "$NODE_TMP"

  # Refresh PATH
  hash -r 2>/dev/null
  export PATH="$NODE_INSTALL_DIR/bin:$PATH"
  ensure_shell_path "$NODE_INSTALL_DIR/bin" "SocketAgent Node.js"

  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Install manually: https://nodejs.org/"
    exit 1
  fi

  # Verify version
  NODE_VERSION=$(node --version | sed 's/^v//' | cut -d. -f1)
  if [[ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]]; then
    fail "Node.js $(node --version) installed but v$NODE_MIN_VERSION+ required."
    exit 1
  fi
  ok "Node.js $(node --version) installed"
fi # NEED_NODE_INSTALL

# npm is always included in the official Node.js tarball,
# but verify it's on PATH
if ! command -v npm &>/dev/null; then
  fail "npm not found despite Node.js being installed. Check your PATH."
  exit 1
fi
ensure_shell_path "$NPM_CONFIG_PREFIX/bin" "SocketAgent npm global tools"

# ══════════════════════════════════════════════
#  Linux Sandbox Dependency
# ══════════════════════════════════════════════

if [[ "$OS_NAME" == "Linux" ]]; then
  phase "Codex Linux Sandbox"
  CODEX_SANDBOX_REPAIR="$SERVER_DIR/scripts/ensure-codex-linux-sandbox.sh"
  if bash "$CODEX_SANDBOX_REPAIR" --interactive; then
    ok "Codex Linux sandbox dependency is ready"
  else
    warn "Codex can still run unrestricted sessions, but restricted sandbox modes may fail."
    warn "SocketAgent will retry the Bubblewrap repair automatically after the server starts."
  fi
fi

phase "Native Node Build Tools"
ensure_native_build_tools

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

phase "Phase 2: Claude Code CLI"

CLAUDE_BIN="$NPM_BIN_DIR/claude"
if [[ -x "$CLAUDE_BIN" || -f "$CLAUDE_BIN" ]]; then
  CLAUDE_VER=$("$CLAUDE_BIN" --version 2>/dev/null || echo "unknown")
  ok "Managed Claude Code CLI already installed ($CLAUDE_VER)"
else
  echo "  Installing managed Claude Code CLI..."
  npm install -g --include=optional @anthropic-ai/claude-code@latest
  hash -r 2>/dev/null
  if [[ ! -x "$CLAUDE_BIN" && ! -f "$CLAUDE_BIN" ]]; then
    fail "Claude Code CLI installation failed in $NPM_GLOBAL_DIR"
    exit 1
  fi
  ok "Managed Claude Code CLI installed ($("$CLAUDE_BIN" --version 2>/dev/null))"
fi

# ══════════════════════════════════════════════
#  Phase 3: OpenAI Codex CLI
# ══════════════════════════════════════════════

phase "Phase 3: OpenAI Codex CLI"

NEED_CODEX_INSTALL=false
CODEX_BIN="$NPM_BIN_DIR/codex"
if [[ -x "$CODEX_BIN" || -f "$CODEX_BIN" ]]; then
  CODEX_VER=$("$CODEX_BIN" --version 2>/dev/null || echo "unknown")
  if "$CODEX_BIN" app-server --help &>/dev/null; then
    ok "Managed OpenAI Codex CLI already installed ($CODEX_VER)"
  else
    warn "Managed OpenAI Codex CLI found ($CODEX_VER) but app-server is unavailable. Updating..."
    NEED_CODEX_INSTALL=true
  fi
else
  echo "  Installing managed OpenAI Codex CLI..."
  NEED_CODEX_INSTALL=true
fi

if [[ "$NEED_CODEX_INSTALL" == "true" ]]; then
  npm install -g --include=optional @openai/codex@latest
  hash -r 2>/dev/null
  if [[ ! -x "$CODEX_BIN" && ! -f "$CODEX_BIN" ]]; then
    fail "OpenAI Codex CLI installation failed in $NPM_GLOBAL_DIR"
    exit 1
  fi
  if ! "$CODEX_BIN" app-server --help &>/dev/null; then
    fail "OpenAI Codex CLI installed, but 'codex app-server' is unavailable."
    exit 1
  fi
  ok "Managed OpenAI Codex CLI installed ($("$CODEX_BIN" --version 2>/dev/null))"
fi

# ══════════════════════════════════════════════
#  Phase 4: Install Dependencies & Build
# ══════════════════════════════════════════════

phase "Phase 4: Install Dependencies & Build"

install_server_dependencies_and_build

# ══════════════════════════════════════════════
#  Phase 5: Generate Configuration
# ══════════════════════════════════════════════

phase "Phase 5: Generate Configuration"

if [[ "$RESET_PAIRING" == "true" ]]; then
  warn "Resetting pairing data..."
  rm -f "$KEYS_FILE"
  if [[ -f "$ENV_FILE" ]]; then
    sed '/^PAIRING_TOKEN=/d' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
fi

IS_UPGRADE=false
[[ -f "$ENV_FILE" ]] && IS_UPGRADE=true

# Ensure data directory exists for keys file
canonical_dir() {
  (cd "$1" 2>/dev/null && pwd -P)
}

if [[ -d "$LEGACY_DATA_DIR" && "$DATA_DIR" != "$LEGACY_DATA_DIR" ]]; then
  if [[ -e "$DATA_DIR" && "$(canonical_dir "$DATA_DIR")" == "$(canonical_dir "$LEGACY_DATA_DIR")" ]]; then
    :
  elif [[ ! -e "$DATA_DIR" ]]; then
    mv "$LEGACY_DATA_DIR" "$DATA_DIR"
    ln -s "$DATA_DIR" "$LEGACY_DATA_DIR" 2>/dev/null || true
    ok "Migrated SocketAgent data to $DATA_DIR"
  else
    cp -R -n "$LEGACY_DATA_DIR"/. "$DATA_DIR"/ 2>/dev/null || true
    ok "Merged legacy SocketAgent data into $DATA_DIR"
  fi
fi
mkdir -p "$DATA_DIR"

# Run from server dir so require('tweetnacl') resolves
SETUP_OUTPUT=$(cd "$SERVER_DIR" && node "$SETUP_SCRIPT" \
  --envfile "$ENV_FILE" \
  --keysfile "$KEYS_FILE" \
  --relay-url "$RELAY_URL" \
  --default-cwd "$HOME" \
  --port "$PORT")

# QR payload is the last line
QR_PAYLOAD=$(echo "$SETUP_OUTPUT" | tail -1)

# Print non-QR output
printf '%s\n' "$SETUP_OUTPUT" | sed '$d' | while IFS= read -r line; do echo "    $line"; done

if [[ "$IS_UPGRADE" == "true" ]]; then
  ok "Configuration updated (existing tokens preserved)"
else
  ok "Configuration generated"
fi

# ══════════════════════════════════════════════
#  Phase 6: Register Service
# ══════════════════════════════════════════════

phase "Phase 6: Register Service"

NODE_PATH=$(command -v node)
NPM_PATH=$(command -v npm)
NPX_PATH=$(command -v npx)
SERVICE_CONTROL="$SERVER_DIR/scripts/service-control.sh"
chmod +x "$SERVER_DIR/scripts/start-server.sh" "$SERVER_DIR/scripts/restart-server.sh" \
  "$SERVER_DIR/scripts/recovery-guard.sh" "$SERVER_DIR/scripts/install-macos-helper.sh" \
  "$SERVER_DIR/scripts/ensure-codex-linux-sandbox.sh" "$SERVICE_CONTROL"

NODE_DIR=$(dirname "$NODE_PATH")
SERVICE_PATH="$NODE_DIR"
SERVICE_PATH="$SERVICE_PATH:$NPM_BIN_DIR"
SERVICE_PATH="$SERVICE_PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ "$OS_NAME" == "Darwin" ]]; then
  SERVICE_LABEL="com.socketagent.server"
  SERVICE_DIR="$HOME/Library/LaunchAgents"
  SERVICE_FILE="$SERVICE_DIR/$SERVICE_LABEL.plist"
  SERVICE_LOG="$SERVER_DIR/socketagent.log"
  GUI_DOMAIN="gui/$(id -u)"
  MACOS_HELPER_APP="$HOME/Applications/SocketAgent Server.app"
  "$SERVER_DIR/scripts/install-macos-helper.sh"
  MACOS_HELPER_EXECUTABLE="$MACOS_HELPER_APP/Contents/MacOS/socketagent-server"

  xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
  }

  mkdir -p "$SERVICE_DIR"
  touch "$SERVICE_LOG"
  chmod 600 "$SERVICE_LOG"
  SERVER_DIR_XML="$(xml_escape "$SERVER_DIR")"
  START_SCRIPT_XML="$(xml_escape "$SERVER_DIR/scripts/start-server.sh")"
  MACOS_HELPER_EXECUTABLE_XML="$(xml_escape "$MACOS_HELPER_EXECUTABLE")"
  HOME_XML="$(xml_escape "$HOME")"
  PATH_XML="$(xml_escape "$SERVICE_PATH")"
  NODE_XML="$(xml_escape "$NODE_PATH")"
  NPM_XML="$(xml_escape "$NPM_PATH")"
  NPX_XML="$(xml_escape "$NPX_PATH")"
  LOG_XML="$(xml_escape "$SERVICE_LOG")"

  cat > "$SERVICE_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$MACOS_HELPER_EXECUTABLE_XML</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SERVER_DIR_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME_XML</string>
    <key>PATH</key>
    <string>$PATH_XML</string>
    <key>SOCKETAGENT_NODE</key>
    <string>$NODE_XML</string>
    <key>SOCKETAGENT_NPM</key>
    <string>$NPM_XML</string>
    <key>SOCKETAGENT_NPX</key>
    <string>$NPX_XML</string>
    <key>SOCKETAGENT_START_SCRIPT</key>
    <string>$START_SCRIPT_XML</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG_XML</string>
  <key>StandardErrorPath</key>
  <string>$LOG_XML</string>
</dict>
</plist>
EOF

  plutil -lint "$SERVICE_FILE" >/dev/null
  ok "Created $SERVICE_FILE"
  launchctl bootout "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1 || true
  for _ in $(seq 1 10); do
    if ! launchctl print "$GUI_DOMAIN/$SERVICE_LABEL" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  "$SERVICE_CONTROL" start
else
  SERVICE_DIR="$HOME/.config/systemd/user"
  SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
  mkdir -p "$SERVICE_DIR"
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=SocketAgent WebSocket Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=$SERVER_DIR/scripts/start-server.sh
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$SERVICE_PATH
Environment=SOCKETAGENT_NODE=$NODE_PATH
Environment=SOCKETAGENT_NPM=$NPM_PATH
Environment=SOCKETAGENT_NPX=$NPX_PATH
UnsetEnvironment=CLAUDECODE

[Install]
WantedBy=default.target
EOF

  ok "Created $SERVICE_FILE"

  # Enable linger so service runs without active login
  if command -v loginctl &>/dev/null; then
    loginctl enable-linger "$(whoami)" 2>/dev/null || true
  fi

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
fi

sleep 3

if "$SERVICE_CONTROL" is-active; then
  ok "Server is running on port $PORT"
else
  warn "Server may not have started. Check: socketagent status"
  warn "Logs: socketagent logs"
fi

# ══════════════════════════════════════════════
#  Phase 7: Install CLI
# ══════════════════════════════════════════════

phase "Phase 7: Install CLI"
install_cli

# ══════════════════════════════════════════════
#  Phase 8: Finish & Phone Pairing
# ══════════════════════════════════════════════

phase "Phase 8: Finish"

echo ""
echo -e "  ${GREEN}===========================================${NC}"
echo -e "  ${GREEN} Installation complete!${NC}"
echo -e "  ${GREEN}===========================================${NC}"
echo ""
if [[ "$OS_NAME" == "Darwin" ]]; then
  echo "  SocketAgent starts automatically when this macOS user logs in."
else
  echo "  SocketAgent starts automatically on boot."
fi
echo ""
echo "  Claude and Codex are installed. Sign in later from the app or CLI if needed."
echo ""
echo -e "  ${CYAN}Open SocketAgent, choose Add Computer, and scan this pairing code:${NC}"
echo ""

# Keep the pairing code as the installer's final primary output.
(cd "$SERVER_DIR" && node -e "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})" "$QR_PAYLOAD" 2>/dev/null) || \
  warn "QR code rendering failed. Paste this pairing code into the app: $QR_PAYLOAD"
echo ""
