<#
.SYNOPSIS
    Stop the running sdlc-fabric pipeline orchestrator.
#>

$ErrorActionPreference = "Stop"

$sdlcHome = if ($env:SDLC_FABRIC_HOME) { $env:SDLC_FABRIC_HOME } else { "C:\Users\Temp User\sdlc-fabric" }
$orchestratorDir = Join-Path $sdlcHome "orchestrator"

$pidFile = Join-Path $orchestratorDir "orchestrator.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found. Orchestrator is not running." -ForegroundColor Yellow
    exit 0
}

$pid = (Get-Content $pidFile -Raw).Trim()

try {
    $proc = Get-Process -Id $pid -ErrorAction Stop
    Write-Host "Stopping orchestrator (PID $pid)..." -ForegroundColor Cyan

    # Graceful stop first
    $proc.Kill()
    $proc.WaitForExit(5000) | Out-Null

    if (-not $proc.HasExited) {
        Write-Host "Force killing..." -ForegroundColor Yellow
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }

    Write-Host "Orchestrator stopped." -ForegroundColor Green
} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
    Write-Host "Process $pid not found. Orchestrator was not running." -ForegroundColor Yellow
} finally {
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
