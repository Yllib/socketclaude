param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$serverDir = Join-Path $repoRoot "server"
$serviceName = "SocketAgent"

function Get-SocketAgentTaskName {
    $task = Get-ScheduledTask -TaskName $serviceName -ErrorAction SilentlyContinue
    if ($task) { return $serviceName }
    $legacy = Get-ScheduledTask -TaskName "SocketClaude" -ErrorAction SilentlyContinue
    if ($legacy) { return "SocketClaude" }
    return $serviceName
}

function Show-Usage {
    Write-Host "SocketAgent command line"
    Write-Host ""
    Write-Host "Usage:"
    Write-Host "  socketagent pair [--raw]        Show pairing QR or raw pairing payload"
    Write-Host "  socketagent direct [--json]     Show direct/manual IP connection settings"
    Write-Host "  socketagent token               Show direct/manual auth token only"
    Write-Host "  socketagent install [args...]   Re-run the SocketAgent installer"
    Write-Host "  socketagent status              Show scheduled task status"
    Write-Host "  socketagent logs                Follow server logs"
    Write-Host "  socketagent restart             Restart scheduled task"
    Write-Host "  socketagent doctor              Print basic install diagnostics"
    Write-Host "  socketagent help                Show this help"
}

function Register-SocketAgentRecovery {
    $recoveryBat = Join-Path $serverDir "run-recovery.bat"
    if (-not (Test-Path $recoveryBat)) { return }

    $action = New-ScheduledTaskAction `
        -Execute $env:ComSpec `
        -Argument ('/d /c "' + $recoveryBat + '"')
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5)
    Register-ScheduledTask `
        -TaskName "SocketAgentRecovery" `
        -Action $action `
        -Trigger $trigger `
        -Force | Out-Null
}

$cmd = if ($Args.Count -gt 0) { $Args[0] } else { "help" }
$rest = if ($Args.Count -gt 1) { $Args[1..($Args.Count - 1)] } else { @() }

switch ($cmd.ToLowerInvariant()) {
    { $_ -in @("pair", "qr") } {
        & node (Join-Path $serverDir "scripts\show-pairing.js") @rest
        exit $LASTEXITCODE
    }
    { $_ -in @("direct", "manual") } {
        & node (Join-Path $serverDir "scripts\show-direct-auth.js") @rest
        exit $LASTEXITCODE
    }
    { $_ -in @("token", "auth-token", "authtoken") } {
        & node (Join-Path $serverDir "scripts\show-direct-auth.js") "--raw"
        exit $LASTEXITCODE
    }
    { $_ -in @("install", "setup") } {
        & powershell -ExecutionPolicy Bypass -File (Join-Path $repoRoot "install.ps1") @rest
        exit $LASTEXITCODE
    }
    "status" {
        Get-ScheduledTask -TaskName (Get-SocketAgentTaskName)
    }
    "logs" {
        Get-Content (Join-Path $serverDir "socketagent.log") -Tail 50 -Wait
    }
    "restart" {
        $taskName = Get-SocketAgentTaskName
        Register-SocketAgentRecovery
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $taskName
        Get-ScheduledTask -TaskName $taskName
    }
    "doctor" {
        Write-Host "SocketAgent diagnostics"
        Write-Host "Repo: $repoRoot"
        Write-Host "Server: $serverDir"
        $node = Get-Command node -ErrorAction SilentlyContinue
        Write-Host "Node: $(if ($node) { $node.Source } else { 'not found' })"
        if ($node) { Write-Host "Node version: $(& node --version)" }
        $claude = Get-Command claude -ErrorAction SilentlyContinue
        Write-Host "Claude CLI: $(if ($claude) { $claude.Source } else { 'not found' })"
        $codex = Get-Command codex -ErrorAction SilentlyContinue
        Write-Host "Codex CLI: $(if ($codex) { $codex.Source } else { 'not found' })"
        $task = Get-ScheduledTask -TaskName (Get-SocketAgentTaskName) -ErrorAction SilentlyContinue
        Write-Host "Task: $(if ($task) { $task.State } else { 'not found' })"
    }
    { $_ -in @("help", "-h", "--help") } {
        Show-Usage
    }
    default {
        Write-Error "Unknown command: $cmd"
        Show-Usage
        exit 2
    }
}
