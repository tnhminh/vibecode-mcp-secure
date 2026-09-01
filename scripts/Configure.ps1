param(
  [string]$Workspace,
  [string]$TunnelId,
  [string]$Alias = 'vibecode-local',
  [int]$Port = 7317
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EnvPath = Join-Path $Root '.env'

if (-not $Workspace) { $Workspace = Read-Host 'Workspace path MCP may modify (example E:\projects\my-app)' }
if (-not (Test-Path $Workspace -PathType Container)) { throw "Workspace folder does not exist: $Workspace" }
if (-not $TunnelId) { $TunnelId = Read-Host 'OpenAI Secure MCP tunnel_id (tunnel_...)' }
if ($TunnelId -notmatch '^tunnel_') { Write-Warning "Tunnel ID normally starts with tunnel_. Check the value before START." }

$content = @"
VIBECODE_WORKSPACE=$Workspace
VIBECODE_HOST=127.0.0.1
VIBECODE_PORT=$Port
CONTROL_PLANE_TUNNEL_ID=$TunnelId
TUNNEL_ALIAS=$Alias
VIBECODE_SHELL_MODE=allowlist
VIBECODE_ALLOW_DANGEROUS=0
VIBECODE_BROWSER_ALLOW_EXTERNAL=0
VIBECODE_MAX_READ_BYTES=262144
VIBECODE_MAX_COMMAND_OUTPUT_BYTES=262144
"@
Set-Content -Path $EnvPath -Value $content -Encoding UTF8
Write-Host "Saved non-secret configuration to $EnvPath" -ForegroundColor Green
Write-Host "Runtime API key is intentionally NOT saved. START.cmd will request it securely if CONTROL_PLANE_API_KEY is not already set." -ForegroundColor Yellow
