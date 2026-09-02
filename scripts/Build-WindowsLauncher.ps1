$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $Root 'launcher\VibecodeLauncher.cs'
$Out = Join-Path $Root 'VibecodeMCP.exe'

$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "Windows .NET Framework C# compiler not found." }
if (-not (Test-Path $Source)) { throw "Launcher source not found: $Source" }

Write-Host "Building VibecodeMCP.exe with $csc" -ForegroundColor Cyan
& $csc /nologo /target:exe /optimize+ /platform:anycpu /out:$Out /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll $Source
if ($LASTEXITCODE -ne 0) { throw "Launcher compile failed." }

Write-Host "Running launcher self-test..." -ForegroundColor Cyan
& $Out --self-test
if ($LASTEXITCODE -ne 0) { throw "Launcher self-test failed." }

$item = Get-Item $Out
Write-Host ("Built: {0} ({1:N0} bytes)" -f $item.FullName, $item.Length) -ForegroundColor Green
