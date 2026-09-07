@echo off
setlocal
cd /d "%~dp0"
if exist ".\VibecodeMCP.Cli.exe" (
  ".\VibecodeMCP.Cli.exe" --stop
  set "RC=%ERRORLEVEL%"
  if not "%RC%"=="0" pause
  exit /b %RC%
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Stop-Vibecode.ps1"
pause
