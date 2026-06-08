# Publish to npm
# 流程：build Rust supervisor → copy *nix shim → npm publish
# 不 chain package.ps1 —— npm publish 内部已经 pack + upload，多 pack 一次是冗余

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "[publish] building Rust supervisor..." -ForegroundColor Cyan
& "$PSScriptRoot\build-launcher.ps1"

Write-Host "[publish] creating *nix bin shim..." -ForegroundColor Cyan
if (-not (Test-Path "bin/svcctl")) {
    Copy-Item -Force bin/svcctl.js bin/svcctl
}

Write-Host "[publish] verifying tarball contents..." -ForegroundColor Cyan
$dryRun = npm pack --dry-run 2>&1
$dryRun | Select-String -Pattern "^\d+\.\d+(\.\d+)?(kB|MB)\s+(bin|src|README|LICENSE|package\.json)" | ForEach-Object { Write-Host "  $_" }

Write-Host "[publish] publishing to npm..." -ForegroundColor Cyan
npm publish --access public
