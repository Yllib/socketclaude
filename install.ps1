#Requires -Version 5.1
<#
.SYNOPSIS
    SocketAgent Windows Installer
.DESCRIPTION
    Installs everything needed to run SocketAgent on Windows: Node.js, both
    supported agent CLIs, server dependencies, configuration, and scheduled
    task. Agent sign-in happens later in the app or directly through the CLI.
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
$RELAY_URL = "wss://relay.jarofdirt.info"
$TASK_NAME = "SocketAgent"
$NODE_MIN_VERSION = [version]"22.0.0"

# ── Paths ──
$REPO_ROOT = $PSScriptRoot
$SERVER_DIR = Join-Path $REPO_ROOT "server"
$ENV_FILE = Join-Path $SERVER_DIR ".env"
$SOCKET_AGENT_HOME = if ($env:SOCKET_AGENT_HOME) { $env:SOCKET_AGENT_HOME } else { Join-Path $env:USERPROFILE ".socket-agent" }
$DATA_DIR = if ($env:SOCKETAGENT_DATA_DIR) {
    $env:SOCKETAGENT_DATA_DIR
} elseif ($env:SOCKET_AGENT_DATA_DIR) {
    $env:SOCKET_AGENT_DATA_DIR
} else {
    $SOCKET_AGENT_HOME
}
$LEGACY_DATA_DIR = Join-Path $env:USERPROFILE ".claude-assistant"
$KEYS_FILE = Join-Path $DATA_DIR "relay-keys.json"
$LOG_FILE = Join-Path $SERVER_DIR "socketagent.log"
$SETUP_SCRIPT = Join-Path (Join-Path $SERVER_DIR "scripts") "setup.js"
$NPM_GLOBAL_DIR = if ($env:SOCKETAGENT_NPM_GLOBAL_DIR) {
    $env:SOCKETAGENT_NPM_GLOBAL_DIR
} elseif ($env:SOCKET_AGENT_NPM_PREFIX) {
    $env:SOCKET_AGENT_NPM_PREFIX
} else {
    Join-Path (Join-Path $SOCKET_AGENT_HOME "toolchains") "npm-global"
}
$NPM_BIN_DIR = $NPM_GLOBAL_DIR
New-Item -ItemType Directory -Path $NPM_BIN_DIR -Force | Out-Null
$env:NPM_CONFIG_PREFIX = $NPM_GLOBAL_DIR

$currentPhase = ""
$serverBuildDone = $false

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

function Assert-GitCheckout {
    $gitMarker = Join-Path $REPO_ROOT ".git"
    if (-not (Test-Path $gitMarker)) {
        Write-Fail "SocketAgent must be installed from a git checkout; zip/archive installs are not supported."
        Write-Host "  Install Git, then run:"
        Write-Host "    git clone https://github.com/Yllib/socketagent.git"
        Write-Host "    cd socketagent"
        Write-Host "    & .\install.ps1"
        throw "SocketAgent requires a valid git checkout"
    }

    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if (-not $gitCmd) { return }

    $inside = (& git -C $REPO_ROOT rev-parse --is-inside-work-tree 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $inside -ne "true") {
        Write-Fail "SocketAgent repository check failed. This server must run from a valid git checkout."
        throw "SocketAgent repository validation failed"
    }
}

Assert-GitCheckout

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

function Test-PathListContains($pathList, $directory) {
    if (-not $pathList -or -not $directory) { return $false }
    $needle = $directory.TrimEnd("\")
    foreach ($part in $pathList.Split(";")) {
        if ($part.TrimEnd("\") -ieq $needle) { return $true }
    }
    return $false
}

function Add-DirectoryToPath($directory, [bool]$persistUser = $false) {
    if (-not $directory -or -not (Test-Path $directory)) { return }
    if (-not (Test-PathListContains $env:PATH $directory)) {
        $env:PATH = "$env:PATH;$directory"
    }
    if ($persistUser) {
        $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (-not (Test-PathListContains $userPath $directory)) {
            $newPath = if ($userPath) { "$userPath;$directory" } else { $directory }
            [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
            Write-Ok "Added $directory to user PATH"
        }
    }
}

function Ensure-NpmGlobalBinOnPath {
    $dirs = @($NPM_BIN_DIR)
    if (-not (Test-CommandExists "npm")) { return }
    $prefixResult = Invoke-NativeCapture { npm prefix -g }
    if ($prefixResult.ExitCode -eq 0) {
        $prefix = ($prefixResult.Output | Where-Object { $_ } | Select-Object -First 1).ToString().Trim()
        if ($prefix) { $dirs += $prefix }
    }

    # npm's Windows shims normally live here; keep these as explicit fallbacks
    # for fresh installs where the current terminal has not picked up PATH yet.
    if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA "npm") }
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA "npm") }

    foreach ($dir in ($dirs | Where-Object { $_ } | Select-Object -Unique)) {
        Add-DirectoryToPath $dir $true
    }
}

function Add-CommandDirectoryToPath($commandName) {
    $cmd = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        Add-DirectoryToPath (Split-Path $cmd.Source -Parent) $true
    }
}

function Get-ManagedCommandPath($commandName) {
    $extensions = @(".cmd", ".exe", ".bat", "")
    foreach ($ext in $extensions) {
        $candidate = Join-Path $NPM_BIN_DIR "$commandName$ext"
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Test-CommandExists($cmd) {
    $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Get-CommandWithoutStoreAlias($commandName) {
    $resolved = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($resolved -and $resolved.Source -like "*\Microsoft\WindowsApps\*") {
        return $null
    }
    return $resolved
}

function Get-CurrentPowerShellExecutable {
    $currentProcess = Get-Process -Id $PID -ErrorAction SilentlyContinue
    if ($currentProcess -and $currentProcess.Path -and (Test-Path $currentProcess.Path)) {
        return $currentProcess.Path
    }

    foreach ($candidate in @(
        (Join-Path $PSHOME "pwsh.exe"),
        (Join-Path $PSHOME "powershell.exe")
    )) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }

    foreach ($name in @("pwsh", "powershell")) {
        $resolved = Get-CommandWithoutStoreAlias $name
        if ($resolved -and $resolved.Source -and (Test-Path $resolved.Source)) {
            return $resolved.Source
        }
    }

    throw "Cannot locate the PowerShell executable that is running this installer"
}

function Set-NpmWindowsScriptShell {
    $cmdPath = $env:ComSpec
    if (-not $cmdPath -and $env:SystemRoot) {
        $cmdPath = Join-Path $env:SystemRoot "System32\cmd.exe"
    }
    if (-not $cmdPath -or -not (Test-Path $cmdPath)) {
        throw "Cannot locate cmd.exe for npm package scripts"
    }

    # npm can inherit a user-level script-shell=powershell setting. Several
    # native dependencies use cmd.exe operators such as || in install scripts.
    # Override the setting for this process and every npm child it starts.
    $env:npm_config_script_shell = $cmdPath
}

function Test-CodexAppServer($codexPath = "codex") {
    $result = Invoke-NativeCapture { & $codexPath app-server --help }
    return $result.ExitCode -eq 0
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$Command
    )

    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $Command 2>&1
        $exitCode = $LASTEXITCODE
    } catch {
        $output = @($_.Exception.Message)
        $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 1 }
    } finally {
        $ErrorActionPreference = $oldPreference
    }

    return [pscustomobject]@{
        Output = @($output)
        ExitCode = $exitCode
    }
}

function Install-ServerDependenciesAndBuild {
    if ($script:serverBuildDone) {
        Write-Ok "Server dependencies already installed and built"
        return
    }

    Push-Location $SERVER_DIR
    try {
        $packageLock = Join-Path $SERVER_DIR "package-lock.json"
        if (Test-Path $packageLock) {
            Write-Host "  Running npm ci --include=optional..."
            $npmResult = Invoke-NativeCapture { npm ci --include=optional }
            $installLabel = "npm ci --include=optional"
        } else {
            Write-Host "  Running npm install --include=optional..."
            $npmResult = Invoke-NativeCapture { npm install --include=optional }
            $installLabel = "npm install --include=optional"
        }
        $npmOutput = $npmResult.Output
        $npmExit = $npmResult.ExitCode
        $npmOutput | ForEach-Object { Write-Host "    $_" }
        if ($npmExit -ne 0) { throw "$installLabel failed (exit code $npmExit)" }
        Write-Ok "Dependencies installed"

        Write-Host "  Compiling TypeScript..."
        $tscResult = Invoke-NativeCapture { npx tsc }
        $tscOutput = $tscResult.Output
        $tscExit = $tscResult.ExitCode
        $tscOutput | ForEach-Object { Write-Host "    $_" }
        if ($tscExit -ne 0) { throw "TypeScript compilation failed (exit code $tscExit)" }
        Write-Ok "Server built successfully"
        $script:serverBuildDone = $true
    } finally {
        Pop-Location
    }
}

function Show-QrCode($payload) {
    $qrScript = "const q=require('qrcode-terminal');q.generate(process.argv[1],{small:true},c=>{c.split('\n').forEach(l=>console.log('  '+l))})"
    Push-Location $SERVER_DIR
    try {
        $qrResult = Invoke-NativeCapture { node -e $qrScript $payload }
        if ($qrResult.ExitCode -eq 0) {
            $qrResult.Output | ForEach-Object { Write-Host $_ }
        } else {
            Write-Warn "QR code rendering failed. Paste this pairing code into the app:"
            Write-Host "  $payload" -ForegroundColor Gray
        }
    } finally {
        Pop-Location
    }
}

function Install-SocketAgentCli {
    $toolsDir = Join-Path $env:LOCALAPPDATA "SocketAgent\bin"
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null

    $targetPs1 = Join-Path $REPO_ROOT "bin\socketagent.ps1"
    $socketAgentCmd = Join-Path $toolsDir "socketagent.cmd"
    $socketClaudeCmd = Join-Path $toolsDir "socketclaude.cmd"
    $powerShellExe = Get-CurrentPowerShellExecutable
    $cmdContent = "@echo off`r`n`"$powerShellExe`" -NoProfile -ExecutionPolicy Bypass -File `"$targetPs1`" %*`r`n"
    Set-Content -Path $socketAgentCmd -Value $cmdContent -Encoding ASCII
    Set-Content -Path $socketClaudeCmd -Value $cmdContent -Encoding ASCII

    $userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
    $parts = @()
    if ($userPath) { $parts = $userPath.Split(";") | Where-Object { $_ } }
    $alreadyOnPath = $parts | Where-Object { $_.TrimEnd("\") -ieq $toolsDir.TrimEnd("\") }
    if (-not $alreadyOnPath) {
        $newPath = if ($userPath) { "$userPath;$toolsDir" } else { $toolsDir }
        [System.Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        $env:PATH = "$env:PATH;$toolsDir"
        Write-Ok "Added $toolsDir to user PATH"
    }

    Write-Ok "Installed socketagent command to $toolsDir"
}

# ══════════════════════════════════════════════
#  Banner
# ══════════════════════════════════════════════

Write-Host ""
Write-Host "  SocketAgent Installer" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

# Verify we're in the right directory
if (-not (Test-Path $SERVER_DIR)) {
    Write-Fail "Cannot find server/ directory. Run this script from the SocketAgent repo root."
    throw "SocketAgent server directory is missing"
}

if (-not (Test-Path (Join-Path $SERVER_DIR "package.json"))) {
    Write-Fail "Cannot find server/package.json. Is this the SocketAgent repository?"
    throw "SocketAgent server package is missing"
}

try {

# ── Pre-flight: check if port is available ──
$existingTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
$portInUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($portInUse) {
    # Check if it's our own task — that's fine, we'll stop it in Phase 6
    $ourPids = @()
    if ($existingTask -and $existingTask.State -eq "Running") {
        $ourPids = (Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -in
            (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$TASK_NAME*" -or $_.CommandLine -like "*run-service*" }).ProcessId -or
            $_.CommandLine -like "*socketagent*dist*index.js*"
        }).ProcessId
    }
    $conflictPids = $portInUse.OwningProcess | Where-Object { $_ -notin $ourPids }
    if ($conflictPids) {
        $procInfo = Get-Process -Id $conflictPids[0] -ErrorAction SilentlyContinue
        $procName = if ($procInfo) { "$($procInfo.ProcessName) (PID $($conflictPids[0]))" } else { "PID $($conflictPids[0])" }
        Write-Fail "Port $Port is already in use by $procName"
        Write-Host ""
        Write-Host "  Use a different port:  & .\install.ps1 -Port 8086" -ForegroundColor Yellow
        Write-Host ""
        throw "Port $Port is already in use"
    }
}

# ══════════════════════════════════════════════
#  Phase 1: Node.js & Git
# ══════════════════════════════════════════════

Write-Phase "Phase 1: Node.js & Git"

# ── Git ──
$gitCmd = Get-CommandWithoutStoreAlias "git"
if ($gitCmd) {
    $gitVer = & git --version 2>$null
    Write-Ok "Git already installed ($gitVer)"
} else {
    Write-Host "  Git is required for auto-updates. Installing..."
    $gitInstalledWithWinget = $false
    if (Test-CommandExists "winget") {
        Write-Host "  Installing Git from the WinGet community repository..."
        $wingetResult = Invoke-NativeCapture { winget install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --silent }
        $wingetOutput = $wingetResult.Output
        $wingetExit = $wingetResult.ExitCode
        if ($wingetExit -eq 0 -or $wingetExit -eq -1978335189) {
            Refresh-Path
            $gitInstalledWithWinget = $null -ne (Get-CommandWithoutStoreAlias "git")
            if (-not $gitInstalledWithWinget) {
                Write-Warn "WinGet finished, but Git is not runnable. Falling back to the GitHub installer."
            }
        } else {
            Write-Warn "WinGet install Git failed (exit code $wingetExit). Falling back to the GitHub installer."
            $wingetOutput | ForEach-Object { Write-Host "    $_" }
        }
    }
    if (-not $gitInstalledWithWinget) {
        Write-Host "  Downloading Git installer from GitHub..."
        $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.2/Git-2.47.1.2-64-bit.exe"
        $gitPath = Join-Path $env:TEMP "git-installer.exe"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitPath -UseBasicParsing
        Write-Host "  Running Git installer (may request admin)..."
        $gitProc = Start-Process $gitPath -ArgumentList "/VERYSILENT /NORESTART" -Verb RunAs -Wait -PassThru
        if ($gitProc.ExitCode -ne 0) {
            throw "Git installer failed or was canceled (exit code $($gitProc.ExitCode))"
        }
    }

    Refresh-Path

    $gitVer = & git --version 2>$null
    if (-not $gitVer) {
        Write-Warn "Git installation may require a terminal restart. Auto-updates will be unavailable until git is on PATH."
    } else {
        Write-Ok "Git installed ($gitVer)"
    }
}
Refresh-Path
Assert-GitCheckout

# ── Node.js ──
$nodeInstalled = $false
$nodeCmd = Get-CommandWithoutStoreAlias "node"
if ($nodeCmd) {
    $rawVersion = & $nodeCmd.Source --version 2>$null
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
    $nodeInstalledWithWinget = $false
    if (Test-CommandExists "winget") {
        Write-Host "  Installing Node.js from the WinGet community repository..."
        $wingetResult = Invoke-NativeCapture { winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements --silent }
        $wingetOutput = $wingetResult.Output
        $wingetExit = $wingetResult.ExitCode
        if ($wingetExit -eq 0 -or $wingetExit -eq -1978335189) {
            # -1978335189 = "already installed" in winget. Still verify the
            # executable so Windows' Microsoft Store app alias cannot masquerade
            # as a working Node.js installation.
            Refresh-Path
            $nodeCmd = Get-CommandWithoutStoreAlias "node"
            if ($nodeCmd) {
                $wingetNodeVersion = & $nodeCmd.Source --version 2>$null
                if ($wingetNodeVersion) {
                    $nodeInstalledWithWinget = ([version]($wingetNodeVersion -replace "^v", "")) -ge $NODE_MIN_VERSION
                }
            }
            if (-not $nodeInstalledWithWinget) {
                Write-Warn "WinGet finished, but Node.js $NODE_MIN_VERSION+ is not runnable. Falling back to the direct installer."
            }
        } else {
            Write-Warn "WinGet install Node.js failed (exit code $wingetExit). Falling back to the direct installer."
            $wingetOutput | ForEach-Object { Write-Host "    $_" }
        }
    }
    if (-not $nodeInstalledWithWinget) {
        Write-Host "  Downloading Node.js installer..."
        $msiUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        $msiPath = Join-Path $env:TEMP "nodejs-installer.msi"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
        Write-Host "  Running Node.js installer (may request admin)..."
        $nodeProc = Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Verb RunAs -Wait -PassThru
        if ($nodeProc.ExitCode -ne 0) {
            throw "Node.js installer failed or was canceled (exit code $($nodeProc.ExitCode))"
        }
    }

    Refresh-Path

    $nodeCmd = Get-CommandWithoutStoreAlias "node"
    $rawVersion = if ($nodeCmd) { & $nodeCmd.Source --version 2>$null } else { $null }
    if (-not $rawVersion) {
        throw "Node.js installation failed. Please install Node.js 22+ manually from https://nodejs.org/"
    }
    Write-Ok "Node.js $rawVersion installed"
}
Ensure-NpmGlobalBinOnPath
Set-NpmWindowsScriptShell

# ══════════════════════════════════════════════
#  Phase 2: Claude Code CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 2: Claude Code CLI"

$claudePath = Get-ManagedCommandPath "claude"
if ($claudePath) {
    $claudeVer = & $claudePath --version 2>$null
    Write-Ok "Managed Claude Code CLI already installed ($claudeVer)"
} else {
    Write-Host "  Installing managed Claude Code CLI..."
    $cliResult = Invoke-NativeCapture { npm install -g --include=optional @anthropic-ai/claude-code@latest }
    $cliOutput = $cliResult.Output
    $cliExit = $cliResult.ExitCode
    $cliOutput | ForEach-Object { Write-Host "    $_" }
    if ($cliExit -ne 0) {
        throw "managed npm install @anthropic-ai/claude-code failed (exit code $cliExit)"
    }

    Refresh-Path
    Add-DirectoryToPath $NPM_BIN_DIR $true

    $claudePath = Get-ManagedCommandPath "claude"
    $claudeVer = if ($claudePath) { & $claudePath --version 2>$null } else { $null }
    if (-not $claudeVer) {
        throw "Claude Code CLI installation failed in $NPM_GLOBAL_DIR"
    }
    Write-Ok "Managed Claude Code CLI installed ($claudeVer)"
}
Add-DirectoryToPath $NPM_BIN_DIR $true

# ══════════════════════════════════════════════
#  Phase 3: OpenAI Codex CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 3: OpenAI Codex CLI"

$codexInstalled = $false
$codexPath = Get-ManagedCommandPath "codex"
if ($codexPath) {
    $codexVer = & $codexPath --version 2>$null
    if (Test-CodexAppServer $codexPath) {
        Write-Ok "Managed OpenAI Codex CLI already installed ($codexVer)"
        $codexInstalled = $true
    } else {
        Write-Warn "Managed OpenAI Codex CLI found ($codexVer) but app-server is unavailable. Updating..."
    }
}

if (-not $codexInstalled) {
    Write-Host "  Installing managed OpenAI Codex CLI..."
    $codexResult = Invoke-NativeCapture { npm install -g --include=optional @openai/codex@latest }
    $codexOutput = $codexResult.Output
    $codexExit = $codexResult.ExitCode
    $codexOutput | ForEach-Object { Write-Host "    $_" }
    if ($codexExit -ne 0) {
        throw "managed npm install @openai/codex failed (exit code $codexExit)"
    }

    Refresh-Path
    Add-DirectoryToPath $NPM_BIN_DIR $true

    $codexPath = Get-ManagedCommandPath "codex"
    if (-not $codexPath) {
        throw "OpenAI Codex CLI installation failed in $NPM_GLOBAL_DIR"
    }
    $codexVer = & $codexPath --version 2>$null
    if (-not (Test-CodexAppServer $codexPath)) {
        throw "OpenAI Codex CLI installed, but 'codex app-server' is unavailable."
    }
    Write-Ok "Managed OpenAI Codex CLI installed ($codexVer)"
}
Add-DirectoryToPath $NPM_BIN_DIR $true

# ══════════════════════════════════════════════
#  Phase 4: Install Dependencies & Build
# ══════════════════════════════════════════════

Write-Phase "Phase 4: Install Dependencies & Build"

Install-ServerDependenciesAndBuild

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

if ((Test-Path $LEGACY_DATA_DIR) -and ($DATA_DIR -ine $LEGACY_DATA_DIR)) {
    $legacyItem = Get-Item $LEGACY_DATA_DIR -Force
    $legacyIsLink = ($legacyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if (-not (Test-Path $DATA_DIR)) {
        Move-Item -Path $LEGACY_DATA_DIR -Destination $DATA_DIR
        try {
            New-Item -ItemType Junction -Path $LEGACY_DATA_DIR -Target $DATA_DIR -Force | Out-Null
        } catch {
            Write-Warn "Could not create legacy data directory junction: $($_.Exception.Message)"
        }
        Write-Ok "Migrated SocketAgent data to $DATA_DIR"
    } elseif ($legacyIsLink) {
        Write-Ok "Legacy SocketAgent data link already points to migrated data"
    } else {
        Copy-Item -Path (Join-Path $LEGACY_DATA_DIR "*") -Destination $DATA_DIR -Recurse -ErrorAction SilentlyContinue
        Write-Ok "Merged legacy SocketAgent data into $DATA_DIR"
    }
}
New-Item -ItemType Directory -Path $DATA_DIR -Force | Out-Null

$setupResult = Invoke-NativeCapture {
    node $SETUP_SCRIPT `
        --envfile $ENV_FILE `
        --keysfile $KEYS_FILE `
        --relay-url $RELAY_URL `
        --default-cwd $env:USERPROFILE `
        --port $Port
}
$setupOutput = $setupResult.Output

if ($setupResult.ExitCode -ne 0) { throw "Configuration generation failed (exit code $($setupResult.ExitCode))" }

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
$powerShellExe = Get-CurrentPowerShellExecutable
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

# Generate run-service.bat with restart loop
# This ensures the server auto-restarts after updates (process.exit(1))
$batFile = Join-Path $SERVER_DIR "run-service.bat"
$recoveryBatFile = Join-Path $SERVER_DIR "run-recovery.bat"
$servicePath = $env:PATH -replace '"', ''
if (-not (Test-PathListContains $servicePath $NPM_BIN_DIR)) {
    $servicePath = "$NPM_BIN_DIR;$servicePath"
}
foreach ($commandName in @("claude", "codex")) {
    $cmd = Get-Command $commandName -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        $cmdDir = (Split-Path $cmd.Source -Parent) -replace '"', ''
        if (-not (Test-PathListContains $servicePath $cmdDir)) {
            $servicePath = "$servicePath;$cmdDir"
        }
    }
}
$batContent = @"
@echo off
setlocal EnableExtensions
rem SocketAgent Windows service wrapper v2
set "HOME=$env:USERPROFILE"
set "PATH=$servicePath"
set "SERVER_DIR=$SERVER_DIR"
set "REPO_ROOT=$REPO_ROOT"
set "LOG_FILE=$LOG_FILE"
set "NODE_EXE=$nodeExe"
set "POWERSHELL_EXE=$powerShellExe"
set "npm_config_script_shell=%ComSpec%"
set "SERVER_SCRIPT=$serverScript"
set "RECOVERY_BAT=$recoveryBatFile"
set "NPM_CMD=npm.cmd"
set "NPX_CMD=npx.cmd"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if exist "%ProgramFiles%\nodejs\npx.cmd" set "NPX_CMD=%ProgramFiles%\nodejs\npx.cmd"

:loop
call :arm_recovery
call :preflight >> "%LOG_FILE%" 2>&1
if errorlevel 1 echo [startup] Preflight update failed; launching existing build. >> "%LOG_FILE%" 2>&1
cd /d "%SERVER_DIR%"
"%NODE_EXE%" "%SERVER_SCRIPT%" >> "%LOG_FILE%" 2>&1
echo Server exited (%ERRORLEVEL%), restarting in 5s... >> "%LOG_FILE%" 2>&1
timeout /t 5 /nobreak >nul
goto loop

:arm_recovery
if not exist "%RECOVERY_BAT%" exit /b 0
"%POWERSHELL_EXE%" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "`$a=New-ScheduledTaskAction -Execute `$env:ComSpec -Argument ('/d /c ' + [char]34 + `$env:RECOVERY_BAT + [char]34); `$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5); `$p=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited; `$s=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable; Register-ScheduledTask -TaskName 'SocketAgentRecovery' -Action `$a -Trigger `$t -Principal `$p -Settings `$s -Force | Out-Null" >nul 2>&1
exit /b 0

:preflight
cd /d "%REPO_ROOT%"
if /I "%SOCKETAGENT_AUTO_UPDATE%"=="0" exit /b 0
if /I "%SOCKETAGENT_AUTO_UPDATE%"=="false" exit /b 0
if /I "%SOCKETAGENT_AUTO_UPDATE%"=="off" exit /b 0
git rev-parse --is-inside-work-tree >nul 2>&1 || exit /b 0
git fetch origin
if errorlevel 1 exit /b 0
set "BRANCH="
set "LOCAL_HASH="
set "REMOTE_HASH="
for /f %%B in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BRANCH=%%B"
if not defined BRANCH exit /b 0
for /f %%H in ('git rev-parse HEAD 2^>nul') do set "LOCAL_HASH=%%H"
for /f %%H in ('git rev-parse origin/%BRANCH% 2^>nul') do set "REMOTE_HASH=%%H"
if not defined REMOTE_HASH exit /b 0
if "%LOCAL_HASH%"=="%REMOTE_HASH%" exit /b 0
call :verify_update "%REMOTE_HASH%"
if errorlevel 1 exit /b 1
echo [Auto-update] Applying %REMOTE_HASH:~0,7% from origin/%BRANCH%
git reset --hard origin/%BRANCH%
if errorlevel 1 exit /b 1
cd /d "%SERVER_DIR%"
call "%NPM_CMD%" ci --include=optional
if errorlevel 1 exit /b 1
call "%NPX_CMD%" tsc
if errorlevel 1 exit /b 1
> "%REPO_ROOT%\.last-auto-update-hash" echo %REMOTE_HASH%
exit /b 0

:verify_update
set "VERIFY_MODE=%SOCKETAGENT_AUTO_UPDATE_VERIFY%"
set "REQUIRE_SIGNED=%SOCKETAGENT_AUTO_UPDATE_REQUIRE_SIGNED_COMMITS%"
if not defined VERIFY_MODE set "VERIFY_MODE=commit"
if /I "%VERIFY_MODE%"=="none" exit /b 0
if /I "%VERIFY_MODE%"=="0" exit /b 0
if /I "%VERIFY_MODE%"=="false" exit /b 0
if /I "%VERIFY_MODE%"=="off" exit /b 0
if /I "%SOCKETAGENT_UPDATE_VERIFY%"=="commit" set "VERIFY_MODE=commit"
if /I "%SOCKETAGENT_UPDATE_VERIFY%"=="signed-commit" set "VERIFY_MODE=commit"
if /I "%SOCKETAGENT_UPDATE_REQUIRE_SIGNED_COMMITS%"=="1" set "REQUIRE_SIGNED=1"
if /I "%REQUIRE_SIGNED%"=="0" exit /b 0
if /I "%REQUIRE_SIGNED%"=="false" exit /b 0
if /I "%REQUIRE_SIGNED%"=="off" exit /b 0
if /I "%VERIFY_MODE%"=="signed" set "VERIFY_MODE=commit"
if /I "%VERIFY_MODE%"=="signed-commit" set "VERIFY_MODE=commit"
if /I "%REQUIRE_SIGNED%"=="true" set "VERIFY_MODE=commit"
if /I "%REQUIRE_SIGNED%"=="yes" set "VERIFY_MODE=commit"
if "%REQUIRE_SIGNED%"=="1" set "VERIFY_MODE=commit"
if /I not "%VERIFY_MODE%"=="commit" exit /b 0
set "SIGNERS=%REPO_ROOT%\.github\allowed_signers"
if not exist "%SIGNERS%" exit /b 1
git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=%SIGNERS%" verify-commit "%~1"
exit /b %ERRORLEVEL%
"@
Set-Content -Path $batFile -Value $batContent -Encoding ASCII
Write-Ok "Generated run-service.bat"

$recoveryContent = @"
@echo off
setlocal EnableExtensions
rem SocketAgent Windows recovery guard
set "SERVER_DIR=$SERVER_DIR"
set "LOG_FILE=$LOG_FILE"
set "POWERSHELL_EXE=$powerShellExe"
set "PORT=8085"
for /f "tokens=1,* delims==" %%A in ('findstr /b "PORT=" "%SERVER_DIR%\.env" 2^>nul') do if /i "%%A"=="PORT" set "PORT=%%B"
set "PORT=%PORT:"=%"
"%POWERSHELL_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "`$p=[int]`$env:PORT; `$c=New-Object Net.Sockets.TcpClient; try { `$iar=`$c.BeginConnect('127.0.0.1',`$p,`$null,`$null); if (-not `$iar.AsyncWaitHandle.WaitOne(1500,`$false)) { exit 1 }; `$c.EndConnect(`$iar); exit 0 } catch { exit 1 } finally { `$c.Close() }"
if not errorlevel 1 goto done
echo [recovery] SocketAgent is not listening on port %PORT%; restarting scheduled task. >> "%LOG_FILE%" 2>&1
set "TASK_NAME=SocketAgent"
schtasks /Query /TN SocketAgent >nul 2>&1 || set "TASK_NAME=SocketClaude"
schtasks /End /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1
timeout /t 2 /nobreak >nul
schtasks /Run /TN "%TASK_NAME%" >> "%LOG_FILE%" 2>&1
:done
schtasks /Delete /TN SocketAgentRecovery /F >nul 2>&1
exit /b 0
"@
Set-Content -Path $recoveryBatFile -Value $recoveryContent -Encoding ASCII
Write-Ok "Generated run-recovery.bat"

$action = New-ScheduledTaskAction `
    -Execute "cmd.exe" `
    -Argument "/c `"$batFile`"" `
    -WorkingDirectory $SERVER_DIR

# Settings: run indefinitely, restart on failure, allow on battery
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$registeredTaskMode = "startup"
try {
    # Preferred: current user, S4U logon, at startup. This runs without an
    # active desktop session, but some Windows account/policy setups reject it.
    $startupTrigger = New-ScheduledTaskTrigger -AtStartup
    $startupPrincipal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType S4U `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Action $action `
        -Trigger $startupTrigger `
        -Settings $settings `
        -Principal $startupPrincipal `
        -Description "SocketAgent WebSocket server" | Out-Null
} catch {
    Write-Warn "Could not register startup task using S4U: $($_.Exception.Message)"
    Write-Warn "Falling back to an interactive logon task for this Windows account."
    $partialTask = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($partialTask) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    }

    $registeredTaskMode = "logon"
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    $logonPrincipal = New-ScheduledTaskPrincipal `
        -UserId $env:USERNAME `
        -LogonType Interactive `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TASK_NAME `
        -Action $action `
        -Trigger $logonTrigger `
        -Settings $settings `
        -Principal $logonPrincipal `
        -Description "SocketAgent WebSocket server" | Out-Null
}

if ($registeredTaskMode -eq "startup") {
    Write-Ok "Registered as scheduled task '$TASK_NAME' (startup)"
} else {
    Write-Ok "Registered as scheduled task '$TASK_NAME' (logon fallback)"
}

# Add Windows Firewall rule (requires admin — skip silently if not elevated)
$fwRuleName = "SocketAgent Server (TCP $Port)"
try {
    $existingRule = Get-NetFirewallRule -DisplayName $fwRuleName -ErrorAction SilentlyContinue
    if (-not $existingRule) {
        New-NetFirewallRule `
            -DisplayName $fwRuleName `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $Port `
            -Profile Private,Domain `
            -Description "Allow inbound connections to SocketAgent server" | Out-Null
        Write-Ok "Firewall rule added for port $Port (Private/Domain networks)"
    } else {
        Write-Ok "Firewall rule already exists for port $Port"
    }
} catch {
    Write-Warn "Could not add firewall rule (requires admin). You may need to allow port $Port manually."
}

# Start immediately
try {
    Start-ScheduledTask -TaskName $TASK_NAME
    Write-Host "  Starting server..."
} catch {
    Write-Warn "Could not start scheduled task: $($_.Exception.Message)"
    Write-Warn "Starting server directly for this session; it will start from the task on next logon/startup."
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$batFile`"" -WindowStyle Hidden | Out-Null
}
Start-Sleep -Seconds 3

$taskInfo = Get-ScheduledTask -TaskName $TASK_NAME
if ($taskInfo.State -eq "Running") {
    Write-Ok "Server is running on port $Port"
} else {
    Write-Warn "Server may not have started. Check: Get-ScheduledTask -TaskName $TASK_NAME"
    Write-Warn "Logs: $LOG_FILE"
}

# ══════════════════════════════════════════════
#  Phase 7: Install CLI
# ══════════════════════════════════════════════

Write-Phase "Phase 7: Install CLI"
Install-SocketAgentCli

# ══════════════════════════════════════════════
#  Phase 8: Finish & Phone Pairing
# ══════════════════════════════════════════════

Write-Phase "Phase 8: Finish"

# Set UTF-8 for QR code rendering in legacy terminals
if ($null -eq $env:WT_SESSION) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 | Out-Null
}

Write-Host ""
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host "   Installation complete!" -ForegroundColor Green
Write-Host "  ===========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  SocketAgent starts automatically when you log in."
Write-Host ""
Write-Host "  Claude and Codex are installed. Sign in later from the app or CLI if needed."
Write-Host ""
Write-Host "  Open SocketAgent, choose Add Computer, and scan this pairing code:" -ForegroundColor Cyan
Write-Host ""
Show-QrCode $qrPayload
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
            Write-Host "    - Install Node.js 22+ manually: https://nodejs.org/"
            Write-Host "    - Then re-run this installer"
        }
        "*Claude Code CLI*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: npm install -g --prefix `"$NPM_GLOBAL_DIR`" --include=optional @anthropic-ai/claude-code@latest"
        }
        "*OpenAI Codex CLI*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: npm install -g --prefix `"$NPM_GLOBAL_DIR`" --include=optional @openai/codex@latest"
        }
        "*Dependencies*" {
            Write-Host "    - Check your internet connection"
            Write-Host "    - Try: cd server && npm install --include=optional"
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
    throw "SocketAgent installation failed during $currentPhase"
}
