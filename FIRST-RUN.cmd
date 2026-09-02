@echo off
setlocal
cd /d "%~dp0"
echo ==================================================
echo   VIBECODE MCP SECURE - FIRST RUN
echo ==================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Setup.ps1"
if errorlevel 1 goto :fail

if exist ".\VibecodeMCP.exe" (
  ".\VibecodeMCP.exe" --configure
  if errorlevel 1 goto :fail
  ".\VibecodeMCP.exe"
  if errorlevel 1 goto :fail
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Configure.ps1"
  if errorlevel 1 goto :fail
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Start-Vibecode.ps1"
  if errorlevel 1 goto :fail
)

echo.
echo First run completed successfully.
pause
exit /b 0
:fail
echo.
echo FIRST RUN FAILED. Run DOCTOR.cmd and inspect the message above.
pause
exit /b 1
