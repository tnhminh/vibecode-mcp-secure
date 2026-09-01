$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Common.ps1')
Import-DotEnv (Join-Path $Root '.env')
$TunnelExe = Join-Path $Root 'bin\tunnel-client.exe'
$Alias = if ($env:TUNNEL_ALIAS) { $env:TUNNEL_ALIAS } else { 'vibecode-local' }
if (Test-Path $TunnelExe) {
  Write-Host "Stopping tunnel runtime '$Alias'..."
  & $TunnelExe runtimes stop $Alias
}
$PidFile = Join-Path $Root '.runtime\mcp.pid'
if (Test-Path $PidFile) {
  $pidValue = (Get-Content $PidFile | Select-Object -First 1).Trim()
  if ($pidValue -match '^\d+$') {
    Write-Host "Stopping MCP PID $pidValue..."
    & taskkill /PID $pidValue /T /F | Out-Null
  }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped." -ForegroundColor Green
