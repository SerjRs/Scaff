# daily-backup.ps1 — Full workspace backup to Google Drive (timestamped folder)
# Runs daily at 04:00 via cron. Each backup gets its own folder.

param(
    [string]$WorkspacePath = "C:\Users\Temp User\.openclaw\workspace",
    [string]$Remote = "gdrive-backup:",
    [switch]$DryRun
)

$timestamp = (Get-Date).ToString("yyyy-MM-dd_HHmm")
$destination = "${Remote}${timestamp}/"

$excludes = @(
    # Legacy archive path exclusion (Qdrant retired)
    "--exclude", "tools/qdrant/**",
    "--exclude", "tools/whisper/source/**",
    "--exclude", "tools/whisper/Release/**",
    "--exclude", "tools/ffmpeg*/**",
    "--exclude", "tools/call-handler/chrome-profile/**",
    "--exclude", "tools/sqlite/**",
    "--exclude", "node_modules/**",
    "--exclude", "_archive/**",
    "--exclude", "_backups/**",
    "--exclude", "_tmp/**",
    "--exclude", ".git/**",
    "--exclude", "openclaw-upstream/**",
    "--exclude", "openclaw-ui-testing-solution/**",
    "--exclude", "workspaces/**",
    "--exclude", "qdrant/**",
    "--exclude", "*.tmp",
    "--exclude", "*.log"
)

$args = @("copy", $WorkspacePath, $destination) + $excludes + @(
    "--transfers", "8",
    "--checkers", "4",
    "--log-level", "INFO"
)

if ($DryRun) {
    $args += "--dry-run"
    Write-Host "[DRY RUN] rclone $($args -join ' ')"
}

Write-Host "Starting backup to $destination ..."
$startTime = Get-Date

& rclone @args

# Backup keys directory (outside workspace)
$keysDir = Join-Path $env:USERPROFILE ".openclaw\keys"
if (Test-Path $keysDir) {
    $keysDestination = "${Remote}${timestamp}/keys/"
    Write-Host "Backing up keys to $keysDestination ..."
    & rclone copy $keysDir $keysDestination --transfers 2 --log-level INFO
}

$duration = ((Get-Date) - $startTime).ToString("mm\:ss")
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
    Write-Host "Backup complete ($duration) -> $destination"
    # Journal success
    $journalScript = Join-Path $WorkspacePath "scripts\journal.ps1"
    if (Test-Path $journalScript) {
        & $journalScript -Action write -Category task_status -Content "Daily backup complete -> $destination ($duration)" -Tags "backup,gdrive"
    }
} else {
    Write-Host "Backup FAILED (exit $exitCode) after $duration"
    if (Test-Path (Join-Path $WorkspacePath "scripts\journal.ps1")) {
        & (Join-Path $WorkspacePath "scripts\journal.ps1") -Action write -Category error -Content "Daily backup FAILED (exit $exitCode) -> $destination" -Tags "backup,gdrive,error"
    }
}

exit $exitCode
