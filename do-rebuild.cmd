@echo off
taskkill /F /PID 24776
timeout /t 5 /nobreak
cd /d "C:\Users\Temp User\.openclaw"
start "OpenClaw Gateway" cmd /k "pnpm start"
