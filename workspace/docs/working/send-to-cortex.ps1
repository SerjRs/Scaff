param([string]$Message = "Hello from stress test")

$timeout = 30
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "pnpm"
$psi.Arguments = "openclaw tui --session main:webchat --message `"$Message`""
$psi.WorkingDirectory = "C:\Users\Temp User\.openclaw"
$psi.UseShellExecute = $false

$proc = [System.Diagnostics.Process]::Start($psi)

$waited = 0
while (-not $proc.HasExited -and $waited -lt $timeout) {
    Start-Sleep -Seconds 1
    $waited++
}

if (-not $proc.HasExited) {
    $proc.Kill()
    Write-Output "Sent (killed after ${waited}s)"
} else {
    Write-Output "Process exited after ${waited}s"
}
