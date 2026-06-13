# scripts/bump-version.ps1
# 同步 package.json + launcher/Cargo.toml 的 version 字段，然后重 build 一切。
#
# 用法：
#   pwsh scripts/bump-version.ps1 0.4.0
#   pwsh scripts/bump-version.ps1 -Version 0.4.0
#
# 流程：
#   1. 改 package.json 的 "version" 字段
#   2. 改 launcher/Cargo.toml 的 [package] "version" 字段（用 -creplace 区分大小写）
#   3. 调 build-all.ps1 重新生成图标 + 编译
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

# 1. 校验 semver（不严格匹配 prerelease/build metadata，但格式要求 X.Y.Z）
if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
    throw "Invalid version: '$Version'. Expected semver like '0.4.0' or '0.4.0-rc.1'."
}

# 2. 改 package.json
Write-Host "[bump] updating package.json..." -ForegroundColor Cyan
$pkg = Get-Content $pkgJsonPath -Raw | ConvertFrom-Json
$oldVer = $pkg.version
$pkg.version = $Version
$pkg | ConvertTo-Json -Depth 100 | Set-Content $pkgJsonPath -NoNewline
Write-Host "  $oldVer -> $Version" -ForegroundColor Green

# 3. 改 launcher/Cargo.toml
Write-Host "[bump] updating launcher/Cargo.toml..." -ForegroundColor Cyan
$ctoml = Get-Content $cargoTomlPath -Raw
# -creplace 区分大小写；多行模式只匹配行首
if ($ctoml -notmatch '(?m)^version = "[\d.]+([\-+][0-9A-Za-z.-]+)?"') {
    throw "Could not find [package] version = ""..."" in $cargoTomlPath"
}
$newCtoml = $ctoml -creplace '(?m)^version = "[\d.]+([\-+][0-9A-Za-z.-]+)?"', "version = `"$Version`""
Set-Content -Path $cargoTomlPath -Value $newCtoml -NoNewline
Write-Host "  $oldVer -> $Version" -ForegroundColor Green

# 4. 重新 build（图标 + 编译）
Write-Host ""
Write-Host "[bump] rebuild icon + launcher..." -ForegroundColor Cyan
& pwsh -File "$PSScriptRoot\build-all.ps1"
if ($LASTEXITCODE -ne 0) { throw "build-all failed" }

Write-Host ""
Write-Host "[bump] done. svcctl is now at v$Version." -ForegroundColor Green
Write-Host ""
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host "  git diff package.json launcher/Cargo.toml" -ForegroundColor Yellow
Write-Host "  git add -A && git commit -m 'v$Version'" -ForegroundColor Yellow
