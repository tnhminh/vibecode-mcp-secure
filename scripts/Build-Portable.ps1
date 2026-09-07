param(
  [string]$OutputDirectory,
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "Required file was not found: $Source" }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { throw "Required directory was not found: $Source" }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $Root 'dist'
}

$NodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($NodeExe)) { throw 'Node.js was not found on PATH; a portable runtime cannot be assembled.' }
$nodeMajor = [int]((& $NodeExe -p 'process.versions.node').Trim().Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20+ is required; found $nodeMajor." }

$TunnelExe = Join-Path $Root 'bin\tunnel-client.exe'
$BrowserCache = Join-Path $env:LOCALAPPDATA 'ms-playwright'
$Stage = Join-Path $OutputDirectory 'VibecodeMCP-Portable'
$Zip = Join-Path $OutputDirectory 'VibecodeMCP-Portable.zip'

if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Write-Host 'Building Windows launchers...' -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\Build-WindowsLauncher.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Windows launcher build failed.' }

Write-Host 'Copying portable application files...' -ForegroundColor Cyan
foreach ($file in @('VibecodeMCP.Cli.exe', 'package.json', 'package-lock.json', 'README.md')) {
  Copy-RequiredFile (Join-Path $Root $file) (Join-Path $Stage $file)
}
foreach ($dir in @('src', 'node_modules', 'bin')) {
  Copy-RequiredDirectory (Join-Path $Root $dir) (Join-Path $Stage $dir)
}
Copy-RequiredFile $NodeExe (Join-Path $Stage 'runtime\node\node.exe')

if (-not $SkipBrowser) {
  if (-not (Test-Path -LiteralPath $BrowserCache)) {
    throw "Playwright browser cache was not found: $BrowserCache. Re-run with -SkipBrowser to create a smaller package without browser_* tools."
  }
  Write-Host 'Bundling Playwright Chromium...' -ForegroundColor Cyan
  Copy-RequiredDirectory $BrowserCache (Join-Path $Stage 'runtime\playwright-browsers')
}

New-Item -ItemType Directory -Force -Path (Join-Path $Stage '.runtime') | Out-Null
@'
# This file is created automatically on first launch.
# Tunnel credentials are intentionally not bundled in a portable release.
'@ | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $Stage '.runtime\.gitkeep'), $_ + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false))) }

@'
@echo off
setlocal
cd /d "%~dp0"
"%~dp0VibecodeMCP.Cli.exe" --no-open
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $Stage 'RUN-Vibecode-MCP.cmd') -Encoding ascii

@'
@echo off
setlocal
cd /d "%~dp0"
"%~dp0VibecodeMCP.Cli.exe" --stop
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $Stage 'STOP-Vibecode-MCP.cmd') -Encoding ascii

Copy-RequiredFile (Join-Path $Root 'docs\PORTABLE-VI.md') (Join-Path $Stage 'HUONG-DAN-PORTABLE.md')

$hashLines = Get-ChildItem -LiteralPath $Stage -Recurse -File |
  Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
  Sort-Object FullName |
  ForEach-Object {
    $relative = $_.FullName.Substring($Stage.Length + 1).Replace('\', '/')
    "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
  }
$hashLines | Set-Content -LiteralPath (Join-Path $Stage 'SHA256SUMS.txt') -Encoding ascii

Write-Host 'Creating ZIP archive...' -ForegroundColor Cyan
Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $Zip -CompressionLevel Optimal

$stageBytes = (Get-ChildItem -LiteralPath $Stage -Recurse -File | Measure-Object -Property Length -Sum).Sum
$zipBytes = (Get-Item -LiteralPath $Zip).Length
Write-Host ("Portable folder: {0}" -f $Stage) -ForegroundColor Green
Write-Host ("Portable ZIP:    {0}" -f $Zip) -ForegroundColor Green
Write-Host ("Size: {0:N1} MB folder, {1:N1} MB ZIP" -f ($stageBytes / 1MB), ($zipBytes / 1MB)) -ForegroundColor Green
