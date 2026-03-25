<#
.SYNOPSIS
    Start the sdlc-fabric pipeline orchestrator as a background daemon.
.PARAMETER PipelineRoot
    Path to the pipeline root directory containing task stage folders.
.PARAMETER DbPath
    Relative path to the SQLite database (from orchestrator dir). Default: orchestrator/pipeline.db
.PARAMETER Port
    REST API port. Default: 3000
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$PipelineRoot,

    [string]$DbPath = "orchestrator/pipeline.db",

    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

$sdlcHome = if ($env:SDLC_FABRIC_HOME) { $env:SDLC_FABRIC_HOME } else { "C:\Users\Temp User\sdlc-fabric" }
$orchestratorDir = Join-Path $sdlcHome "orchestrator"

$pidFile = Join-Path $orchestratorDir "orchestrator.pid"

# Check if already running
if (Test-Path $pidFile) {
    $existingPid = Get-Content $pidFile -Raw
    $existingPid = $existingPid.Trim()
    try {
        $proc = Get-Process -Id $existingPid -ErrorAction Stop
        Write-Host "Orchestrator already running (PID $existingPid). Use stop.ps1 first." -ForegroundColor Yellow
        exit 1
    } catch {
        Write-Host "Stale PID file found. Cleaning up..." -ForegroundColor Yellow
        Remove-Item $pidFile -Force
    }
}

# Resolve pipeline root to absolute path
$PipelineRoot = (Resolve-Path $PipelineRoot).Path

Write-Host "Starting orchestrator..." -ForegroundColor Cyan
Write-Host "  Pipeline root: $PipelineRoot"
Write-Host "  DB path:       $DbPath"
Write-Host "  REST port:     $Port"
Write-Host "  Orchestrator:  $orchestratorDir"

# Start the orchestrator in background
$logFile = Join-Path $orchestratorDir "orchestrator.log"

$process = Start-Process -FilePath "uv" `
    -ArgumentList "run", "python", "main.py", "serve", "--root", $PipelineRoot, "--db-path", $DbPath, "--rest-port", $Port `
    -WorkingDirectory $orchestratorDir `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError (Join-Path $orchestratorDir "orchestrator.err.log") `
    -PassThru `
    -WindowStyle Hidden

# Write PID file
$process.Id | Out-File -FilePath $pidFile -NoNewline -Encoding ascii

Write-Host "Orchestrator started (PID $($process.Id))" -ForegroundColor Green
Write-Host "  PID file: $pidFile"
Write-Host "  Log file: $logFile"
Write-Host ""
Write-Host "Health check: curl http://localhost:$Port/health" -ForegroundColor Gray
