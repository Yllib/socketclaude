#Requires -Version 5.1
<#
.SYNOPSIS
    SocketClaude Windows Uninstaller
.DESCRIPTION
    Stops and removes the SocketClaude scheduled task.
    Optionally removes session data.
    Does NOT uninstall Node.js or Claude Code CLI.
#>

$ErrorActionPreference = "Stop"
$TASK_NAME = "SocketClaude"

Write-Host ""
Write-Host "  SocketClaude Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Stop and remove scheduled task
$task = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq "Running") {
        Write-Host "  Stopping server..."
        Stop-ScheduledTask -TaskName $TASK_NAME
        Start-Sleep -Seconds 2
    }
    Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
    Write-Host "  [OK] Removed scheduled task '$TASK_NAME'" -ForegroundColor Green
} else {
    Write-Host "  No scheduled task found." -ForegroundColor Yellow
}

# Remove log file
$logFile = Join-Path $PSScriptRoot "server" "socketclaude.log"
if (Test-Path $logFile) {
    Remove-Item $logFile -Force
    Write-Host "  [OK] Removed log file" -ForegroundColor Green
}

# Ask about data removal
Write-Host ""
$removeData = Read-Host "  Remove session data (~\.claude-assistant)? (y/N)"
if ($removeData -eq "y") {
    $dataDir = Join-Path $env:USERPROFILE ".claude-assistant"
    if (Test-Path $dataDir) {
        Remove-Item $dataDir -Recurse -Force
        Write-Host "  [OK] Removed $dataDir" -ForegroundColor Green
    }
}

# Ask about .env removal
$removeEnv = Read-Host "  Remove server config (server\.env)? (y/N)"
if ($removeEnv -eq "y") {
    $envFile = Join-Path $PSScriptRoot "server" ".env"
    if (Test-Path $envFile) {
        Remove-Item $envFile -Force
        Write-Host "  [OK] Removed .env" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "  Uninstall complete." -ForegroundColor Green
Write-Host "  Node.js and Claude Code CLI were NOT removed." -ForegroundColor Yellow
Write-Host ""
