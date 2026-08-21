# scripts/bump-version.ps1
# 同步主包、平台包和 launcher/Cargo.toml 的 version 字段。
#
# 用法：
#   pwsh scripts/bump-version.ps1 0.4.0
#   pwsh scripts/bump-version.ps1 -Version 0.4.0
#
# 流程：
#   1. 改 package.json 的 "version" 字段
#   2. 改 launcher/Cargo.toml 的 [package] "version" 字段（用 -creplace 区分大小写）
#   3. 更新两个平台包以及主包 optionalDependencies 的精确版本
#   4. 更新 bun.lock；发布二进制始终由 GitHub Actions 编译
#
# Version 格式校验：纯 semver（MAJOR.MINOR.PATCH，可选预发布/构建元数据）
# 不合法会 throw（不执行任何修改）。

[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$pkgJsonPath = Join-Path $root "package.json"
$cargoTomlPath = Join-Path $root "launcher\Cargo.toml"
$cargoLockPath = Join-Path $root "launcher\Cargo.lock"
$platformPackagePaths = @(
    (Join-Path $root "packages\svcctl-win32-x64\package.json"),
    (Join-Path $root "packages\svcctl-win32-arm64\package.json")
)

# 1. 校验 semver（不严格匹配 prerelease/build metadata，但格式要求 X.Y.Z）
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid version: '$Version'. Expected semver like '0.4.0' or '0.4.0-rc.1'."
}

# 2. 改 package.json
Write-Host "[bump] updating package.json..." -ForegroundColor Cyan
$pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
$oldVer = $pkg.version
$pkg.version = $Version
$pkg.optionalDependencies."svcctl-win32-x64" = $Version
$pkg.optionalDependencies."svcctl-win32-arm64" = $Version
$pkg | ConvertTo-Json -Depth 100 | Set-Content $pkgJsonPath -NoNewline
Write-Host "  $oldVer -> $Version" -ForegroundColor Green

# 3. 改平台包 package.json
foreach ($platformPackagePath in $platformPackagePaths) {
    Write-Host "[bump] updating $platformPackagePath..." -ForegroundColor Cyan
    $platformPackage = Get-Content $platformPackagePath -Raw | ConvertFrom-Json
    $platformPackage.version = $Version
    $platformPackage | ConvertTo-Json -Depth 100 | Set-Content $platformPackagePath -NoNewline
}

# 4. 改 launcher/Cargo.toml
Write-Host "[bump] updating launcher/Cargo.toml..." -ForegroundColor Cyan
$ctoml = Get-Content $cargoTomlPath -Raw
# -creplace 区分大小写；多行模式只匹配行首
if ($ctoml -notmatch '(?m)^version = "[\d.]+([\-+][0-9A-Za-z.-]+)?"') {
    throw "Could not find [package] version = ""..."" in $cargoTomlPath"
}
$newCtoml = $ctoml -creplace '(?m)^version = "[\d.]+([\-+][0-9A-Za-z.-]+)?"', "version = `"$Version`""
Set-Content -Path $cargoTomlPath -Value $newCtoml -NoNewline
Write-Host "  $oldVer -> $Version" -ForegroundColor Green

# 5. 同步 Cargo.lock 中 workspace package 自身的版本；依赖版本保持不变
$cargoLock = Get-Content $cargoLockPath -Raw
$cargoLockPattern = '(?m)(\[\[package\]\]\r?\nname = "svcctl"\r?\nversion = ")[^"]+("\r?$)'
if ($cargoLock -notmatch $cargoLockPattern) {
    throw "Could not find svcctl package version in $cargoLockPath"
}
$newCargoLock = $cargoLock -replace $cargoLockPattern, "`${1}$Version`${2}"
Set-Content -Path $cargoLockPath -Value $newCargoLock -NoNewline

# 6. 更新 workspace lockfile
Write-Host "[bump] updating bun.lock..." -ForegroundColor Cyan
Push-Location $root
try {
    bun install --lockfile-only
    if ($LASTEXITCODE -ne 0) { throw "bun install --lockfile-only failed" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "[bump] done. svcctl is now at v$Version." -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  git diff -- package.json packages launcher/Cargo.toml bun.lock" -ForegroundColor Yellow
Write-Host "  commit the version change, then create and push tag v$Version" -ForegroundColor Yellow
