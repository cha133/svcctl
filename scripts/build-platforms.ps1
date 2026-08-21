# Build both Windows npm platform packages from a Windows x64 host.

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\build-launcher.ps1" -Target "x86_64-pc-windows-msvc" -NoSync
if ($LASTEXITCODE -ne 0) { throw "x64 launcher build failed" }

& "$PSScriptRoot\build-launcher.ps1" -Target "aarch64-pc-windows-msvc" -NoSync
if ($LASTEXITCODE -ne 0) { throw "ARM64 launcher build failed" }

Write-Host "[build-platforms] both Windows platform packages are ready." -ForegroundColor Green
