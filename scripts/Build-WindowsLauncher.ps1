$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CliSource = Join-Path $Root 'launcher\VibecodeLauncher.cs'
$GuiSource = Join-Path $Root 'launcher\VibecodeDesktop.cs'
$CliOut = Join-Path $Root 'VibecodeMCP.Cli.exe'
$GuiOut = Join-Path $Root 'VibecodeMCP.exe'

$candidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $csc) { throw "Windows .NET Framework C# compiler not found." }
if (-not (Test-Path $CliSource)) { throw "CLI source not found: $CliSource" }
if (-not (Test-Path $GuiSource)) { throw "GUI source not found: $GuiSource" }

Write-Host "Building VibecodeMCP.Cli.exe..." -ForegroundColor Cyan
& $csc /nologo /target:exe /optimize+ /platform:anycpu /out:$CliOut /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll $CliSource
if ($LASTEXITCODE -ne 0) { throw "CLI compile failed." }

Write-Host "Running CLI self-test..." -ForegroundColor Cyan
& $CliOut --self-test
if ($LASTEXITCODE -ne 0) { throw "CLI self-test failed." }

Write-Host "Building native VibecodeMCP.exe Windows app..." -ForegroundColor Cyan
& $csc /nologo /target:winexe /optimize+ /platform:anycpu /out:$GuiOut /reference:System.dll /reference:System.Core.dll /reference:System.Security.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll $GuiSource
if ($LASTEXITCODE -ne 0) { throw "GUI compile failed." }

Write-Host "Running GUI self-test..." -ForegroundColor Cyan
& $GuiOut --self-test
if ($LASTEXITCODE -ne 0) { throw "GUI self-test failed." }

$cliItem = Get-Item $CliOut
$guiItem = Get-Item $GuiOut
Write-Host ("Built CLI: {0} ({1:N0} bytes)" -f $cliItem.FullName, $cliItem.Length) -ForegroundColor Green
Write-Host ("Built APP: {0} ({1:N0} bytes)" -f $guiItem.FullName, $guiItem.Length) -ForegroundColor Green
