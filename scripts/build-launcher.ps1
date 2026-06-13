# Build the Windows Rust supervisor
# 编译产物：bin/SvcCtl.exe

$ErrorActionPreference = "Stop"

Write-Host "[build-launcher] compiling Rust supervisor..." -ForegroundColor Cyan
Push-Location $PSScriptRoot\..\launcher
cargo build --release
if ($LASTEXITCODE -ne 0) {
    Pop-Location
    throw "cargo build failed"
}
Pop-Location

$src = Join-Path $PSScriptRoot "..\launcher\target\release\SvcCtl.exe"
$dst = Join-Path $PSScriptRoot "..\bin\SvcCtl.exe"

if (-not (Test-Path $src)) {
    throw "compiled binary not found: $src"
}

# 可选: rcedit 强制 set-icon (winres 默认 ID 1 但 rcedit 更稳. scoop install rcedit)
if (Get-Command rcedit -ErrorAction SilentlyContinue) {
    $icoPath = Join-Path $PSScriptRoot "..\launcher\assets\svcctl.ico"
    if (Test-Path $icoPath) {
        Write-Host "[build-launcher] rcedit: forcing icon to ID 1..." -ForegroundColor Cyan
        rcedit $src --set-icon $icoPath
        if ($LASTEXITCODE -ne 0) { throw "rcedit failed" }
    }
} else {
    Write-Host "[build-launcher] (optional) install rcedit for guaranteed icon ID 1: scoop install rcedit" -ForegroundColor DarkGray
}

New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item -Force $src $dst
Write-Host "[build-launcher] copied to $dst" -ForegroundColor Green

$size = (Get-Item $dst).Length
Write-Host "[build-launcher] size: $([math]::Round($size / 1024)) KB" -ForegroundColor Green
