@echo off
REM Start Ollama serve in background
start "" /B "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
