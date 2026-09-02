@echo off
setlocal
cd /d "%~dp0"
if exist ".\VibecodeMCP.exe" (
  ".\VibecodeMCP.exe"
  set "RC=%ERRORLEVEL%"
  if not "%RC%"=="0" pause
  exit /b %RC%
)
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Start-Vibecode.ps1"
pause
