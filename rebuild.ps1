# rebuild.ps1 — Kill gateway, optionally build, restart, wake Scaff via cron
# Usage: .\rebuild.ps1              (restart only)
#        .\rebuild.ps1 -Build       (build + restart)
# Scaff wakes up via a one-shot cron job that fires ~30s after restart.

param([switch]$Build)

$root = $PSScriptRoot
Write-Host "`n=== OpenClaw Rebuild ===" -ForegroundColor Cyan

# 1. Kill
Write-Host "[1/4] Stopping gateway..." -ForegroundColor Yellow
$gwPid = (netstat -ano | Select-String ":18789.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1)
if ($gwPid) {
    Write-Host "  Killing PID $gwPid" -ForegroundColor DarkGray
    taskkill /PID $gwPid /F 2>$null | Out-Null
    Start-Sleep -Seconds 3
} else {
    Write-Host "  No gateway running" -ForegroundColor DarkGray
}

# 2. Build
if ($Build) {
    Write-Host "[2/4] Building..." -ForegroundColor Yellow
    Push-Location $root
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Host "  BUILD FAILED!" -ForegroundColor Red; Pop-Location; exit 1 }
    Pop-Location
    Write-Host "  Build OK" -ForegroundColor Green
} else {
    Write-Host "[2/4] Skipping build" -ForegroundColor DarkGray
}

# 3. Start gateway
Write-Host "[3/4] Starting gateway..." -ForegroundColor Yellow
Start-Process cmd -ArgumentList "/c cd /d `"$root`" && pnpm openclaw gateway" -WorkingDirectory $root
Write-Host "  Gateway launching..." -ForegroundColor Green

# 4. Schedule wake-up cron BEFORE restart (gateway must be up to accept it)
#    Then wait for new gateway to come up
Write-Host "[4/4] Scheduling wake-up cron..." -ForegroundColor Yellow
# Note: This step runs from the rebuild.ps1 script context.
# When Scaff calls this himself, he schedules the cron before killing the gateway.
# When run standalone, gateway is already restarting so we wait for it first.
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 2
    $check = netstat -ano 2>$null | Select-String ":18789.*LISTENING"
    if ($check) {
        Write-Host "  Gateway is up! ($($i * 2)s)" -ForegroundColor Green
        Start-Sleep -Seconds 3
        $wakeTime = (Get-Date).AddSeconds(30).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        & pnpm openclaw cron add --at $wakeTime --session main --system-event "Gateway rebuilt and restarted. Scaff is back online." --delete-after-run --name "rebuild-wake" 2>$null
        Write-Host "  Wake-up cron scheduled" -ForegroundColor Green
        break
    }
    Write-Host "  Waiting... ($($i * 2)s)" -ForegroundColor DarkGray
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
