# Build the Windows Rust supervisor
# 编译产物：bin/svcctl-supervisor.exe

$ErrorActionPreference = "Stop"

Write-Host "[build-launcher] compiling Rust supervisor..." -ForegroundColor Cyan
Push-Location $PSScriptRoot\..\launcher
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "cargo build failed"
}
Pop-Location

$src = Join-Path $PSScriptRoot "..\launcher\target\release\svcctl-supervisor.exe"
$dst = Join-Path $PSScriptRoot "..\bin\svcctl-supervisor.exe"

if (-not (Test-Path $src)) {
    throw "compiled binary not found: $src"
}

New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item -Force $src $dst
Write-Host "[build-launcher] copied to $dst" -ForegroundColor Green

$size = (Get-Item $dst).Length
Write-Host "[build-launcher] size: $([math]::Round($size / 1024)) KB" -ForegroundColor Green
