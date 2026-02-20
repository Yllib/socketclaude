#Requires -Version 5.1
<#
.SYNOPSIS
    SocketClaude Windows Installer
.DESCRIPTION
    Installs everything needed to run SocketClaude server on Windows:
    Node.js, Claude Code CLI, server dependencies, configuration, and scheduled task.
    Displays a QR code at the end for phone pairing.
.PARAMETER ResetPairing
    Force regeneration of pairing token and relay keys (breaks existing phone pairings).
.PARAMETER Port
    Server port (default: 8085).
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1
#>

param(
    [switch]$ResetPairing,
    [int]$Port = 8085
)

$ErrorActionPreference = "Stop"

# ── Configuration ──
$RELAY_URL = "ws://jarofdirt.info:9988"
$TASK_NAME = "SocketClaude"
$NODE_MIN_VERSION = [version]"18.0.0"

# ── Paths ──
$REPO_ROOT = $PSScriptRoot
$SERVER_DIR = Join-Path $REPO_ROOT "server"
$ENV_FILE = Join-Path $SERVER_DIR ".env"
$DATA_DIR = Join-Path $env:USERPROFILE ".claude-assistant"
$KEYS_FILE = Join-Path $DATA_DIR "relay-keys.json"
$LOG_FILE = Join-Path $SERVER_DIR "socketclaude.log"
$SETUP_SCRIPT = Join-Path (Join-Path $SERVER_DIR "scripts") "setup.js"

$currentPhase = ""

function Write-Phase($name) {
    $script:currentPhase = $name
    Write-Host ""
    Write-Host "--- $name ---" -ForegroundColor Cyan
}

function Write-Ok($msg) {
    Write-Host "  [OK] $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "  [!] $msg" -ForegroundColor Yellow
}

function Write-Fail($msg) {
    Write-Host "  [X] $msg" -ForegroundColor Red
}

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

function Test-CommandExists($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

# ══════════════════════════════════════════════
#  Banner
# ══════════════════════════════════════════════

Write-Host ""
Write-Host "  SocketClaude Installer" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

# Verify we're in the right directory
if (-not (Test-Path $SERVER_DIR)) {
    Write-Fail "Cannot find server/ directory. Run this script from the SocketClaude repo root."
    exit 1
}

if (-not (Test-Path (Join-Path $SERVER_DIR "package.json"))) {
    Write-Fail "Cannot find server/package.json. Is this the SocketClaude repository?"
    exit 1
}

try {

# ══════════════════════════════════════════════
#  Phase 1: Node.js
# ══════════════════════════════════════════════

Write-Phase "Phase 1: Node.js"

$nodeInstalled = $false
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $rawVersion = & node --version 2>$null
    if ($rawVersion) {
        $nodeVersion = [version]($rawVersion -replace "^v", "")
        if ($nodeVersion -ge $NODE_MIN_VERSION) {
            Write-Ok "Node.js $rawVersion already installed"
            $nodeInstalled = $true
        } else {
            Write-Warn "Node.js $rawVersion found but $NODE_MIN_VERSION+ required. Upgrading..."
        }
    }
}

if (-not $nodeInstalled) {
    if (Test-CommandExists "winget") {
        Write-Host "  Installing Node.js via winget..."
        & winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
        if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
            # -1978335189 = "already installed" in winget
            throw "winget install failed (exit code $LASTEXITCODE)"
        }
    } else {
        Write-Host "  winget not found. Downloading Node.js installer..."
        $msiUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "nodejs-installer.msi"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "  Running Node.js installer (may request admin)..."
        Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Verb RunAs -Wait
    }

    Refresh-Path

    $rawVersion = & node --version 2>$null
    if (-not $rawVersion) {
        throw "Node.js installation failed. Please install Node.js 18+ manually from https://nodejs.org/"
    }
    Write-Ok "Node.js $rawVersion installed"
}

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 2: Claude Code CLI"

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $claudeVer = & claude --version 2>$null
    Write-Ok "Claude Code CLI already installed ($claudeVer)"
} else {
    Write-Host "  Installing Claude Code CLI..."
    & npm install -g @anthropic-ai/claude-code 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) {
        throw "npm install -g @anthropic-ai/claude-code failed"
    }

    Refresh-Path

    $claudeVer = & claude --version 2>$null
    if (-not $claudeVer) {
        throw "Claude Code CLI installation failed. Try running: npm install -g @anthropic-ai/claude-code"
    }
    Write-Ok "Claude Code CLI installed ($claudeVer)"
}

# ══════════════════════════════════════════════
#  Phase 3: Claude Code Authentication
# ══════════════════════════════════════════════

Write-Phase "Phase 3: Claude Code Authentication"

$claudeDir = Join-Path $env:USERPROFILE ".claude"
$credFiles = @(
    (Join-Path $claudeDir "credentials.json"),
    (Join-Path $claudeDir ".credentials.json")
)

$isAuthenticated = $false
foreach ($f in $credFiles) {
    if (Test-Path $f) {
        $isAuthenticated = $true
        break
    }
}

if ($isAuthenticated) {
    Write-Ok "Claude Code credentials found"
} else {
    Write-Warn "Claude Code is not authenticated."
    Write-Host "  Running 'claude login' -- this will open your browser."
    Write-Host "  Complete the login, then return to this window."
    Write-Host ""
    Read-Host "  Press Enter to start login"

    & claude login

    # Re-check
    $isAuthenticated = $false
    foreach ($f in $credFiles) {
        if (Test-Path $f) {
            $isAuthenticated = $true
            break
        }
    }
    if ($isAuthenticated) {
        Write-Ok "Authentication successful"
    } else {
        Write-Warn "Could not verify authentication. You can run 'claude login' later."
    }
}

# ══════════════════════════════════════════════
#  Phase 4: Install Dependencies & Build
# ══════════════════════════════════════════════

Write-Phase "Phase 4: Install Dependencies & Build"

Write-Host "  Running npm install..."
Push-Location $SERVER_DIR
try {
    & npm install 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Ok "Dependencies installed"

    Write-Host "  Compiling TypeScript..."
    & npx tsc 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "TypeScript compilation failed" }
    Write-Ok "Server built successfully"
} finally {
    Pop-Location
}

# ══════════════════════════════════════════════
#  Phase 5: Generate Configuration
# ══════════════════════════════════════════════

Write-Phase "Phase 5: Generate Configuration"

# Handle --ResetPairing flag
if ($ResetPairing) {
    Write-Warn "Resetting pairing data..."
    if (Test-Path $KEYS_FILE) { Remove-Item $KEYS_FILE -Force }
    # Remove PAIRING_TOKEN from .env so setup.js regenerates it
    if (Test-Path $ENV_FILE) {
        $envContent = Get-Content $ENV_FILE | Where-Object { $_ -notmatch "^PAIRING_TOKEN=" }
        Set-Content $ENV_FILE $envContent
    }
}

$isUpgrade = Test-Path $ENV_FILE

$setupOutput = & node $SETUP_SCRIPT `
    --env-file $ENV_FILE `
    --keys-file $KEYS_FILE `
    --relay-url $RELAY_URL `
    --default-cwd $env:USERPROFILE `
    --port $Port

if ($LASTEXITCODE -ne 0) { throw "Configuration generation failed" }

# QR payload is the last line of output
$qrPayload = ($setupOutput | Select-Object -Last 1)

# Print non-QR output
$setupOutput | Select-Object -SkipLast 1 | ForEach-Object { Write-Host "    $_" }

if ($isUpgrade) {
    Write-Ok "Configuration updated (existing tokens preserved)"
} else {
    Write-Ok "Configuration generated"
}

# ══════════════════════════════════════════════
#  Phase 6: Register Scheduled Task
# ══════════════════════════════════════════════

Write-Phase "Phase 6: Register Windows Service"

$nodeExe = (Get-Command node).Source
$serverScript = Join-Path (Join-Path $SERVER_DIR "dist") "index.js"

# Stop and remove existing task
$existing = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TASK_NAME
        Start-Sleep -Seconds 2
    }
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "  Removed existing task"
}

# Build action: cmd.exe wrapper for output redirection
# Set HOME so Node.js can find ~/.claude-assistant/ and ~/.claude/
$cmdArgs = "/c set HOME=$env:USERPROFILE && `"$nodeExe`" `"$serverScript`" >> `"$LOG_FILE`" 2>&1"
$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument $cmdArgs `
    -WorkingDirectory $SERVER_DIR

# Trigger: at user logon
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: run indefinitely, restart on failure, allow on battery
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

# Principal: current user, interactive (no password needed)
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TASK_NAME `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "SocketClaude WebSocket server" | Out-Null

Write-Ok "Registered as scheduled task '$TASK_NAME'"

# Start immediately
Start-ScheduledTask -TaskName $TASK_NAME
Write-Host "  Starting server..."
Start-Sleep -Seconds 3

$taskInfo = Get-ScheduledTask -TaskName $TASK_NAME
if ($taskInfo.State -eq "Running") {
    Write-Ok "Server is running on port $Port"
} else {
    Write-Warn "Server may not have started. Check: Get-ScheduledTask -TaskName $TASK_NAME"
    Write-Warn "Logs: $LOG_FILE"
}

# ══════════════════════════════════════════════
#  Phase 7: QR Code & Summary
# ══════════════════════════════════════════════

Write-Phase "Phase 7: Phone Pairing"

# Set UTF-8 for QR code rendering in legacy terminals
if ($null -eq $env:WT_SESSION) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 | Out-Null
}

Write-Host ""
Write-Host "  Scan this QR code with the SocketClaude app:" -ForegroundColor Cyan
Write-Host ""

# Generate QR using server's qrcode-terminal package
Push-Location $SERVER_DIR
try {
    $qrScript = "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>console.log(c))"
    & node -e $qrScript $qrPayload 2>$null | ForEach-Object { Write-Host "  $_" }
} catch {
    Write-Warn "QR code rendering failed. Use manual pairing below."
}
Pop-Location

Write-Host ""
Write-Host "  If QR scan doesn't work, paste this in the app:" -ForegroundColor Yellow
Write-Host "  $qrPayload" -ForegroundColor Gray
Write-Host ""

# ── Success ──
Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "   Installation complete!" -ForegroundColor Green
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  The server starts automatically when you log in."
Write-Host ""
Write-Host "  Management commands:" -ForegroundColor Cyan
Write-Host "    Status:   Get-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Start:    Start-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Stop:     Stop-ScheduledTask -TaskName $TASK_NAME"
Write-Host "    Logs:     Get-Content '$LOG_FILE' -Tail 50"
Write-Host "    Uninstall: powershell -File uninstall.ps1"
Write-Host ""

} catch {
    Write-Host ""
    Write-Host "  ===========================================" -ForegroundColor Red
    Write-Host "   Installation failed!" -ForegroundColor Red
    Write-Host "  ===========================================" -ForegroundColor Red
    Write-Host ""
    Write-Fail "Phase: $currentPhase"
    Write-Fail "Error: $($_.Exception.Message)"
    Write-Host ""
    Write-Host "  Troubleshooting:" -ForegroundColor Yellow

    switch -Wildcard ($currentPhase) {
        "*Node*" {
            Write-Host "    - Install Node.js 18+ manually: https://nodejs.org/"
            Write-Host "    - Then re-run this installer"
        }
        "*Claude Code CLI*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: npm install -g @anthropic-ai/claude-code"
        }
        "*Authentication*" {
            Write-Host "    - Run 'claude login' manually"
            Write-Host "    - Then re-run this installer"
        }
        "*Dependencies*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: cd server && npm install"
        }
        "*Configuration*" {
            Write-Host "    - Check that server/scripts/setup.js exists"
            Write-Host "    - Try: cd server && node scripts/setup.js --help"
        }
        "*Service*" {
            Write-Host "    - Check Task Scheduler for errors"
            Write-Host "    - Try starting manually: cd server && node dist/index.js"
        }
        default {
            Write-Host "    - Check the error message above"
            Write-Host "    - Re-run the installer to retry"
        }
    }
    Write-Host ""
    exit 1
}
