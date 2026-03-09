#!/usr/bin/env bash
set -euo pipefail

# ══════════════════════════════════════════════
#  SocketClaude Linux Installer
# ══════════════════════════════════════════════
#
# Installs everything needed to run SocketClaude server on Linux:
# Node.js, Claude Code CLI, server dependencies, configuration,
# and systemd user service.
#
# Usage:
#   bash install.sh [--reset-pairing] [--port PORT]
#
# Re-running is safe — existing tokens and pairings are preserved.

RELAY_URL="ws://jarofdirt.info:9988"
SERVICE_NAME="socketclaude"
NODE_MIN_VERSION=22
PORT=8085
RESET_PAIRING=false

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
DATA_DIR="$HOME/.claude-assistant"
KEYS_FILE="$DATA_DIR/relay-keys.json"
SETUP_SCRIPT="$SERVER_DIR/scripts/setup.js"

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

echo ""
echo -e "  ${CYAN}SocketClaude Installer${NC}"
echo -e "  ${CYAN}======================${NC}"
echo ""

# Verify repo structure
if [[ ! -d "$SERVER_DIR" ]] || [[ ! -f "$SERVER_DIR/package.json" ]]; then
  fail "Cannot find server/package.json. Run this script from the SocketClaude repo root."
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
  if command -v apt-get &>/dev/null; then
    # Debian/Ubuntu — use NodeSource
    echo "  Installing via NodeSource (may need sudo)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf &>/dev/null; then
    # Fedora/RHEL
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo dnf install -y nodejs
  elif command -v pacman &>/dev/null; then
    # Arch
    sudo pacman -S --noconfirm nodejs npm
  elif command -v brew &>/dev/null; then
    brew install node
  else
    fail "Could not detect package manager. Install Node.js 18+ manually: https://nodejs.org/"
    exit 1
  fi

  # Refresh PATH — package managers may install to dirs not yet on PATH
  hash -r 2>/dev/null
  export PATH="/usr/local/bin:/usr/bin:$PATH"

  if ! command -v node &>/dev/null; then
    fail "Node.js installation failed. Install manually: https://nodejs.org/"
    exit 1
  fi
  ok "Node.js $(node --version) installed"
fi # NEED_NODE_INSTALL

# Verify npm is available (some distros package it separately)
if ! command -v npm &>/dev/null; then
  warn "npm not found, attempting to install..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get install -y npm
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y npm
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm npm
  fi
  hash -r 2>/dev/null
  if ! command -v npm &>/dev/null; then
    fail "npm not found. Install it manually or reinstall Node.js from https://nodejs.org/"
    exit 1
  fi
  ok "npm installed"
fi

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

phase "Phase 2: Claude Code CLI"

if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null || echo "unknown")
  ok "Claude Code CLI already installed ($CLAUDE_VER)"
else
  echo "  Installing Claude Code CLI..."
  npm install -g @anthropic-ai/claude-code
  if ! command -v claude &>/dev/null; then
    fail "Claude Code CLI installation failed. Try: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  ok "Claude Code CLI installed ($(claude --version 2>/dev/null))"
fi

# ══════════════════════════════════════════════
#  Phase 3: Claude Code Authentication
# ══════════════════════════════════════════════

phase "Phase 3: Claude Code Authentication"

CLAUDE_DIR="$HOME/.claude"
if [[ -f "$CLAUDE_DIR/credentials.json" ]] || [[ -f "$CLAUDE_DIR/.credentials.json" ]]; then
  ok "Claude Code credentials found"
else
  warn "Claude Code is not authenticated."
  echo "  Running 'claude login' -- this will open your browser."
  echo "  Complete the login, then return to this terminal."
  echo ""
  read -rp "  Press Enter to start login..."
  claude login

  if [[ -f "$CLAUDE_DIR/credentials.json" ]] || [[ -f "$CLAUDE_DIR/.credentials.json" ]]; then
    ok "Authentication successful"
  else
    warn "Could not verify authentication. You can run 'claude login' later."
  fi
fi

# ══════════════════════════════════════════════
#  Phase 4: Install Dependencies & Build
# ══════════════════════════════════════════════

phase "Phase 4: Install Dependencies & Build"

echo "  Running npm install..."
(cd "$SERVER_DIR" && npm install)
ok "Dependencies installed"

echo "  Compiling TypeScript..."
(cd "$SERVER_DIR" && npx tsc)
ok "Server built successfully"

# ══════════════════════════════════════════════
#  Phase 5: Generate Configuration
# ══════════════════════════════════════════════

phase "Phase 5: Generate Configuration"

if [[ "$RESET_PAIRING" == "true" ]]; then
  warn "Resetting pairing data..."
  rm -f "$KEYS_FILE"
  if [[ -f "$ENV_FILE" ]]; then
    sed -i '/^PAIRING_TOKEN=/d' "$ENV_FILE"
  fi
fi

IS_UPGRADE=false
[[ -f "$ENV_FILE" ]] && IS_UPGRADE=true

# Ensure data directory exists for keys file
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
echo "$SETUP_OUTPUT" | head -n -1 | while read -r line; do echo "    $line"; done

if [[ "$IS_UPGRADE" == "true" ]]; then
  ok "Configuration updated (existing tokens preserved)"
else
  ok "Configuration generated"
fi

# ══════════════════════════════════════════════
#  Phase 6: Register systemd Service
# ══════════════════════════════════════════════

phase "Phase 6: Register systemd Service"

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/$SERVICE_NAME.service"
NODE_PATH=$(command -v node)

mkdir -p "$SERVICE_DIR"

NODE_DIR=$(dirname "$NODE_PATH")
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=SocketClaude WebSocket Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_PATH $SERVER_DIR/dist/index.js
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
Environment=PATH=$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
UnsetEnvironment=CLAUDECODE

[Install]
WantedBy=default.target
EOF

ok "Created $SERVICE_FILE"

# Enable linger so service runs without active login
if command -v loginctl &>/dev/null; then
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
fi

# Reload, enable, and start
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"

# Stop if already running, then start fresh
systemctl --user restart "$SERVICE_NAME"
sleep 3

if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  ok "Server is running on port $PORT"
else
  warn "Server may not have started. Check: systemctl --user status $SERVICE_NAME"
  warn "Logs: journalctl --user -u $SERVICE_NAME -f"
fi

# ══════════════════════════════════════════════
#  Phase 7: QR Code & Summary
# ══════════════════════════════════════════════

phase "Phase 7: Phone Pairing"

echo ""
echo -e "  ${CYAN}Scan this QR code with the SocketClaude app:${NC}"
echo ""

# Generate QR using server's qrcode-terminal package
(cd "$SERVER_DIR" && node -e "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})" "$QR_PAYLOAD" 2>/dev/null) || \
  warn "QR code rendering failed. Use manual pairing below."

echo ""
echo -e "  ${YELLOW}If QR scan doesn't work, paste this in the app:${NC}"
echo -e "  ${NC}$QR_PAYLOAD"
echo ""

# ── Success ──
echo ""
echo -e "  ${GREEN}===========================================${NC}"
echo -e "  ${GREEN} Installation complete!${NC}"
echo -e "  ${GREEN}===========================================${NC}"
echo ""
echo "  The server starts automatically on boot."
echo ""
echo -e "  ${CYAN}Management commands:${NC}"
echo "    Status:    systemctl --user status $SERVICE_NAME"
echo "    Start:     systemctl --user start $SERVICE_NAME"
echo "    Stop:      systemctl --user stop $SERVICE_NAME"
echo "    Logs:      journalctl --user -u $SERVICE_NAME -f"
echo "    Restart:   systemctl --user restart $SERVICE_NAME"
echo ""
echo "  To update, run: git pull && bash install.sh"
echo "  Existing pairings are preserved."
echo ""
