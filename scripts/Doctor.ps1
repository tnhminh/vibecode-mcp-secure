$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Common.ps1')
Import-DotEnv (Join-Path $Root '.env')
$Port = if ($env:VIBECODE_PORT) { [int]$env:VIBECODE_PORT } else { 1167 }
$TunnelExe = Join-Path $Root 'bin\tunnel-client.exe'
$Alias = if ($env:TUNNEL_ALIAS) { $env:TUNNEL_ALIAS } else { 'vibecode-local' }

Write-Host "== Vibecode MCP Doctor ==" -ForegroundColor Cyan
Write-Host "Workspace: $env:VIBECODE_WORKSPACE"
Write-Host "Tunnel ID: $env:CONTROL_PLANE_TUNNEL_ID"
Write-Host "Alias: $Alias"
Write-Host ""

try { $h = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 3; Write-Host "MCP health: PASS" -ForegroundColor Green; $h | ConvertTo-Json -Depth 5 } catch { Write-Host "MCP health: FAIL - $($_.Exception.Message)" -ForegroundColor Red }
try { $r = Invoke-RestMethod "http://127.0.0.1:$Port/readyz" -TimeoutSec 3; Write-Host "MCP ready: PASS" -ForegroundColor Green; $r | ConvertTo-Json -Depth 5 } catch { Write-Host "MCP ready: FAIL - $($_.Exception.Message)" -ForegroundColor Red }

if (Test-Path $TunnelExe) {
  Write-Host ""
  Write-Host "tunnel-client version:"
  & $TunnelExe version
  Write-Host ""
  Write-Host "Tunnel runtime status:"
  & $TunnelExe runtimes status $Alias --json
} else {
  Write-Host "tunnel-client: MISSING (run SETUP.cmd)" -ForegroundColor Red
}

Write-Host ""
Write-Host "Recent MCP stderr:"
$err = Join-Path $Root '.runtime\mcp.stderr.log'
if (Test-Path $err) { Get-Content $err -Tail 50 } else { Write-Host '(none)' }
