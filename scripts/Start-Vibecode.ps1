$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Common.ps1')
Import-DotEnv (Join-Path $Root '.env')

if (-not $env:VIBECODE_WORKSPACE -or $env:VIBECODE_WORKSPACE -match 'your-project') { throw "Run CONFIGURE.cmd first." }
if (-not (Test-Path $env:VIBECODE_WORKSPACE -PathType Container)) { throw "Workspace not found: $env:VIBECODE_WORKSPACE" }
if (-not $env:CONTROL_PLANE_TUNNEL_ID -or $env:CONTROL_PLANE_TUNNEL_ID -match 'REPLACE_ME') { throw "Configure CONTROL_PLANE_TUNNEL_ID first." }

$Port = if ($env:VIBECODE_PORT) { [int]$env:VIBECODE_PORT } else { 1167 }
$Health = "http://127.0.0.1:$Port/healthz"
$Ready = "http://127.0.0.1:$Port/readyz"
$McpUrl = "http://127.0.0.1:$Port/mcp"
$RuntimeDir = Join-Path $Root '.runtime'
$PidFile = Join-Path $RuntimeDir 'mcp.pid'
$StdOut = Join-Path $RuntimeDir 'mcp.stdout.log'
$StdErr = Join-Path $RuntimeDir 'mcp.stderr.log'
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

if (-not (Wait-HttpOk $Health 2)) {
  Write-Host "Starting local MCP server..." -ForegroundColor Cyan
  Remove-Item $StdOut,$StdErr -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath 'node' -ArgumentList @('src/server.mjs') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr -PassThru
  Set-Content -Path $PidFile -Value $p.Id -Encoding ASCII
  if (-not (Wait-HttpOk $Health 40)) {
    Write-Host "MCP failed to start. stderr:" -ForegroundColor Red
    if (Test-Path $StdErr) { Get-Content $StdErr -Tail 100 }
    throw "Local MCP health check failed."
  }
}
Write-Host "Local MCP healthy: $Health" -ForegroundColor Green
if (-not (Wait-HttpOk $Ready 4)) { throw "MCP is alive but not ready. Check workspace and $Ready" }
Write-Host "Local MCP ready: $Ready" -ForegroundColor Green
Write-Host "Control Center: http://127.0.0.1:$Port/" -ForegroundColor Cyan

$TunnelExe = Join-Path $Root 'bin\tunnel-client.exe'
if (-not (Test-Path $TunnelExe)) { throw "tunnel-client.exe not found. Run SETUP.cmd." }

if (-not $env:CONTROL_PLANE_API_KEY) {
  $secure = Read-Host 'OpenAI Runtime API key (Tunnels Read + Use; not saved)' -AsSecureString
  $env:CONTROL_PLANE_API_KEY = Get-PlainTextFromSecureString $secure
}
if (-not $env:CONTROL_PLANE_API_KEY) { throw "CONTROL_PLANE_API_KEY is empty." }

$Alias = if ($env:TUNNEL_ALIAS) { $env:TUNNEL_ALIAS } else { 'vibecode-local' }
Write-Host "Connecting Secure MCP Tunnel alias '$Alias' -> $McpUrl ..." -ForegroundColor Cyan
& $TunnelExe runtimes connect --alias $Alias --tunnel-id $env:CONTROL_PLANE_TUNNEL_ID --runtime-api-key env:CONTROL_PLANE_API_KEY --mcp-server-url $McpUrl
if ($LASTEXITCODE -ne 0) { throw "tunnel-client runtimes connect failed." }

Write-Host "Checking tunnel runtime status..."
& $TunnelExe runtimes status $Alias --json
if ($LASTEXITCODE -ne 0) { throw "Tunnel runtime status check failed." }

Write-Host ""
Write-Host "VIBECODE MCP IS RUNNING" -ForegroundColor Green
Write-Host "MCP:     $McpUrl"
Write-Host "Tunnel:  $($env:CONTROL_PLANE_TUNNEL_ID)"
Write-Host "Alias:   $Alias"
Write-Host ""
Write-Host "Now in ChatGPT: Settings -> Connectors -> create/select MCP connector -> Connection: Tunnel -> choose/paste this tunnel_id." -ForegroundColor Yellow
