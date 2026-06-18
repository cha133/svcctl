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

# v0.4.10: 同步到 $HOME/.svcctl/bin/SvcCtl.exe（install 模式 supervisor 路径）
# windowsSupervisorPath() (src/paths.ts:61) 永远指 $HOME/.svcctl/bin/SvcCtl.exe，
# 跟 repo 的 bin/ 目录不同步 → dev 模式跑 install 路径的旧二进制会出现 grace / Job close 行为不一致
# （v0.4.4 旧二进制 30s grace + 老 Job 行为杀不干净 detached bun grandchild，stop 卡死）。
# 每次 build 自动同步让 dev 跟 install 用同一份二进制，行为一致。
# 用 try-catch 因为 supervisor 跑着时这个文件被锁（会失败），warn 而不是 fail build。
$installBin = Join-Path $env:USERPROFILE ".svcctl\bin\SvcCtl.exe"
if (Test-Path (Split-Path $installBin)) {
    try {
        Copy-Item -Force $src $installBin
        Write-Host "[build-launcher] synced to $installBin" -ForegroundColor Green
    } catch {
        Write-Host "[build-launcher] (skipped, file locked) $installBin — supervisor is running; restart it to pick up new binary" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[build-launcher] (skipped) install path not found: $installBin" -ForegroundColor DarkGray
}
