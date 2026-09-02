param(
  [switch]$SkipBrowser,
  [switch]$SkipTunnelClient
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== Vibecode MCP Secure Setup ==" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not installed. Install Node.js 20+ first."
}
$nodeVersion = (& node -p "process.versions.node").Trim()
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) { throw "Node.js 20+ is required. Found $nodeVersion" }
Write-Host "Node.js $nodeVersion OK" -ForegroundColor Green

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is not available." }
Write-Host "Installing npm dependencies..."
& npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

if (-not $SkipBrowser) {
  Write-Host "Installing Playwright Chromium (for browser_* MCP tools)..."
  & npx playwright install chromium
  if ($LASTEXITCODE -ne 0) { Write-Warning "Chromium install failed. MCP will still run; browser_* tools will not work until you run: npx playwright install chromium" }
}

if (-not (Test-Path (Join-Path $Root '.env'))) {
  Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
  Write-Host "Created .env from .env.example" -ForegroundColor Yellow
}

if (-not $SkipTunnelClient) {
  $BinDir = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  $TunnelExe = Join-Path $BinDir 'tunnel-client.exe'
  Write-Host "Fetching latest official openai/tunnel-client Windows x64 release metadata..."
  $headers = @{ 'User-Agent' = 'vibecode-mcp-secure-setup' }
  $release = Invoke-RestMethod -Headers $headers -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest'
  $asset = $release.assets | Where-Object { $_.name -match '^tunnel-client-v.+-windows-amd64\.zip$' } | Select-Object -First 1
  if (-not $asset) { throw "Could not find windows-amd64 tunnel-client asset in latest release $($release.tag_name)." }
  $zipPath = Join-Path $env:TEMP $asset.name
  Write-Host "Downloading $($asset.name) ($($release.tag_name))..."
  Invoke-WebRequest -Headers $headers -Uri $asset.browser_download_url -OutFile $zipPath

  $checksumAsset = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
  if ($checksumAsset) {
    $checksumPath = Join-Path $env:TEMP 'tunnel-client-SHA256SUMS.txt'
    Invoke-WebRequest -Headers $headers -Uri $checksumAsset.browser_download_url -OutFile $checksumPath
    $line = Get-Content $checksumPath | Where-Object { $_ -match [regex]::Escape($asset.name) } | Select-Object -First 1
    if ($line) {
      $expected = ($line -split '\s+')[0].Trim().ToUpperInvariant()
      $actual = (Get-FileHash -Algorithm SHA256 $zipPath).Hash.ToUpperInvariant()
      if ($actual -ne $expected) { throw "SHA256 mismatch for tunnel-client archive." }
      Write-Host "Tunnel archive checksum verified." -ForegroundColor Green
    }
  }

  $extract = Join-Path $env:TEMP ("vibecode-tunnel-" + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $found = Get-ChildItem -Path $extract -Filter 'tunnel-client.exe' -Recurse | Select-Object -First 1
  if (-not $found) { throw "tunnel-client.exe not found inside archive." }
  Copy-Item $found.FullName $TunnelExe -Force
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  Write-Host "Installed tunnel-client: $TunnelExe" -ForegroundColor Green
  & $TunnelExe --version
}

Write-Host "Running syntax check..."
& npm run check
if ($LASTEXITCODE -ne 0) { throw "Project check failed." }

Write-Host "Running local MCP protocol self-test..."
& npm run selftest
if ($LASTEXITCODE -ne 0) { throw "MCP self-test failed." }

$Launcher = Join-Path $Root 'VibecodeMCP.exe'
if (Test-Path $Launcher) {
  Write-Host "Running Windows launcher self-test..."
  & $Launcher --self-test
  if ($LASTEXITCODE -ne 0) { throw "VibecodeMCP.exe self-test failed." }
}

Write-Host ""
Write-Host "SETUP COMPLETE" -ForegroundColor Green
Write-Host "Next: double-click VibecodeMCP.exe or run FIRST-RUN.cmd for guided configuration."
