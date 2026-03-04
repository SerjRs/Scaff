# rebuild.ps1 — Kill gateway, optionally build, restart, wake Scaff via cron
# Usage: .\rebuild.ps1              (restart only)
#        .\rebuild.ps1 -Build       (build + restart)
# Scaff wakes up via a one-shot cron job that fires ~90s after restart.
#
# Can be called inline OR detached:
#   Start-Process powershell -ArgumentList "-File C:\Users\Temp User\.openclaw\rebuild.ps1 -Build"

param([switch]$Build)

$root = $PSScriptRoot
if (-not $root) { $root = "C:\Users\Temp User\.openclaw" }

Write-Host "`n=== OpenClaw Rebuild ===" -ForegroundColor Cyan

# 1. Build (before kill so we don't have downtime during build)
if ($Build) {
    Write-Host "[1/4] Building..." -ForegroundColor Yellow
    Push-Location $root
    & pnpm build
    if ($LASTEXITCODE -ne 0) { Write-Host "  BUILD FAILED!" -ForegroundColor Red; Pop-Location; exit 1 }
    Pop-Location
    Write-Host "  Build OK" -ForegroundColor Green
} else {
    Write-Host "[1/4] Skipping build" -ForegroundColor DarkGray
}

# 2. Find gateway PID (try multiple methods for detached context compatibility)
Write-Host "[2/4] Finding gateway..." -ForegroundColor Yellow
$gwPid = $null

# Method 1: netstat
try {
    $gwPid = (netstat -ano 2>$null | Select-String ":18789.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1)
} catch {}

# Method 2: Get-NetTCPConnection (works in more contexts)
if (-not $gwPid) {
    try {
        $gwPid = (Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    } catch {}
}

# Method 3: tasklist for node processes on port
if (-not $gwPid) {
    try {
        $gwPid = (Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
            $conns = Get-NetTCPConnection -OwningProcess $_.Id -ErrorAction SilentlyContinue
            $conns | Where-Object { $_.LocalPort -eq 18789 }
        } | Select-Object -First 1).Id
    } catch {}
}

if ($gwPid) {
    Write-Host "  Gateway PID: $gwPid" -ForegroundColor DarkGray
} else {
    Write-Host "  No gateway found" -ForegroundColor DarkGray
}

# 3. Kill and restart via detached cmd (survives even if this script's parent dies)
Write-Host "[3/4] Killing and restarting..." -ForegroundColor Yellow
if ($gwPid) {
    Start-Process cmd -ArgumentList "/c taskkill /PID $gwPid /F & timeout /t 3 & cd /d `"$root`" & start cmd /c pnpm openclaw gateway" -WindowStyle Hidden
} else {
    Start-Process cmd -ArgumentList "/c cd /d `"$root`" & start cmd /c pnpm openclaw gateway" -WindowStyle Hidden
}
Write-Host "  Gateway restarting..." -ForegroundColor Green

# 4. Wait for new gateway, then schedule wake-up cron
Write-Host "[4/4] Scheduling wake-up cron..." -ForegroundColor Yellow
$cronScheduled = $false
for ($i = 1; $i -le 40; $i++) {
    Start-Sleep -Seconds 2
    $up = $false
    try { $up = [bool](netstat -ano 2>$null | Select-String ":18789.*LISTENING") } catch {}
    if (-not $up) {
        try { $up = [bool](Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue) } catch {}
    }
    if ($up) {
        Write-Host "  Gateway is up! ($($i * 2)s)" -ForegroundColor Green
        Start-Sleep -Seconds 5  # let it fully initialize
        $wakeTime = (Get-Date).AddSeconds(90).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
        Push-Location $root
        & pnpm openclaw cron add --at $wakeTime --session main --system-event "REBUILD_WAKEUP: Gateway rebuilt and restarted. Send a WhatsApp message to Serj confirming you are back online." --delete-after-run --name "rebuild-wake" 2>$null
        Pop-Location
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Wake-up cron scheduled for $wakeTime" -ForegroundColor Green
            $cronScheduled = $true
        } else {
            Write-Host "  Cron scheduling failed (exit $LASTEXITCODE)" -ForegroundColor Red
        }
        break
    }
    Write-Host "  Waiting... ($($i * 2)s)" -ForegroundColor DarkGray
}

if (-not $cronScheduled) {
    Write-Host "  WARNING: Could not schedule wake-up cron!" -ForegroundColor Red
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
