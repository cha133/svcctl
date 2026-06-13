# scripts/build-all.ps1
# 一键重新生成图标 + 编译 supervisor（build-icon + build-launcher）
#
# 串联两个步骤，避免 build-launcher 跑在 build-icon 之前导致 .exe 嵌入旧图标的时序问题。
#
# 用法：
#   pwsh scripts/build-all.ps1                                    # 用默认源图（launcher/assets/svcctl-source.png）
#   pwsh scripts/build-all.ps1 -Source "C:\path\to\new-orb.png"   # 换新图
#
# 流程：
#   1. build-icon.ps1     原图 -> launcher/assets/svcctl.ico + 母图备份
#   2. build-launcher.ps1 cargo build + rcedit set-icon -> bin/svcctl.exe
#
# 要求：
#   - pwsh 7+（PowerShell Core）—— 跟 build-icon.ps1 / build-launcher.ps1 一样
#   - magick 在 PATH
#   - cargo + MSVC 工具链（build-launcher.ps1 需要）

[CmdletBinding()]
param(
    [string]$Source = "$PSScriptRoot\..\launcher\assets\svcctl-source.png"
)

$ErrorActionPreference = "Stop"

Write-Host "[build-all] step 1/2: regenerate icon from source" -ForegroundColor Cyan
& pwsh -File "$PSScriptRoot\build-icon.ps1" -Source $Source
if ($LASTEXITCODE -ne 0) { throw "build-icon failed" }

Write-Host ""
Write-Host "[build-all] step 2/2: rebuild launcher" -ForegroundColor Cyan
& pwsh -File "$PSScriptRoot\build-launcher.ps1"
if ($LASTEXITCODE -ne 0) { throw "build-launcher failed" }

Write-Host ""
Write-Host "[build-all] done." -ForegroundColor Green
Write-Host "  bin/svcctl.exe is up to date with latest source image." -ForegroundColor Green
