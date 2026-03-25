<#
.SYNOPSIS
    Check the status of the sdlc-fabric pipeline orchestrator.
.PARAMETER Port
    REST API port to check. Default: 3000
#>
param([int]$Port = 3000)

$ErrorActionPreference = "Stop"

$sdlcHome = if ($env:SDLC_FABRIC_HOME) { $env:SDLC_FABRIC_HOME } else { "C:\Users\Temp User\sdlc-fabric" }
$orchestratorDir = Join-Path $sdlcHome "orchestrator"

$pidFile = Join-Path $orchestratorDir "orchestrator.pid"

# Check PID file
if (-not (Test-Path $pidFile)) {
    Write-Host "STOPPED — No PID file found." -ForegroundColor Red
    exit 1
}

$pid = (Get-Content $pidFile -Raw).Trim()

try {
    $proc = Get-Process -Id $pid -ErrorAction Stop
    Write-Host "RUNNING — PID $pid (uptime: $(((Get-Date) - $proc.StartTime).ToString('hh\:mm\:ss')))" -ForegroundColor Green
} catch {
    Write-Host "DEAD — PID $pid in PID file but process not found." -ForegroundColor Red
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Cleaned up stale PID file." -ForegroundColor Yellow
    exit 1
}

# Health check via REST API
Write-Host ""
Write-Host "REST API health check:" -ForegroundColor Cyan
try {
    $response = Invoke-RestMethod -Uri "http://localhost:$Port/health" -TimeoutSec 3
    Write-Host "  Status:       $($response.status)" -ForegroundColor Green
    Write-Host "  Active tasks: $($response.tasks_active)"
} catch {
    Write-Host "  REST API not responding on port $Port" -ForegroundColor Yellow
    Write-Host "  The process is running but the API may still be starting up." -ForegroundColor Gray
}
