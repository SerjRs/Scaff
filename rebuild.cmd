@echo off
REM rebuild.cmd — Kill gateway, optionally build, restart
REM Usage: rebuild.cmd          (restart only)
REM        rebuild.cmd build    (build + restart)

echo === OpenClaw Rebuild ===

echo [1/3] Finding gateway PID...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":18789.*LISTENING" ^| findstr /v "TIME_WAIT"') do set GW_PID=%%a
if not defined GW_PID (
    echo   No gateway running
) else (
    echo   Killing PID %GW_PID%
    taskkill /PID %GW_PID% /F >nul 2>&1
    timeout /t 3 /nobreak >nul
)

if "%1"=="build" (
    echo [2/3] Building...
    cd /d "%USERPROFILE%\.openclaw"
    call pnpm build
    if errorlevel 1 (
        echo BUILD FAILED!
        pause
        exit /b 1
    )
    echo   Build OK
) else (
    echo [2/3] Skipping build
)

echo [3/3] Starting gateway...
cd /d "%USERPROFILE%\.openclaw"
start "OpenClaw Gateway" cmd /k "pnpm openclaw gateway"
echo   Gateway launched. WhatsApp reconnect will wake Scaff.
echo === Done ===
