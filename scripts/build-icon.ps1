# scripts/build-icon.ps1
# 从一张原图生成多尺寸 svcctl.ico（含 alpha），嵌入 PE 用。
#
# 用法：
#   .\scripts\build-icon.ps1                                  # 用默认源图（assets/svcctl-source.png）
#   .\scripts\build-icon.ps1 -Source "C:\path\to\orb.png"     # 用指定源图
#
# 重要：原图就是源，不做 trim / resize / extent。
#   - 任何尺寸都能用（magick 的 -define icon:auto-resize 会自动 resize 到各目标尺寸）
#   - 但 16x16 任务管理器里球+halo 的视觉占比 = (原图球+halo 范围) / (原图画布尺寸)
#   - 想要 16x16 看起来大：原图球+halo 要占满整个画布（halo 贴边）
#
# 要求：
#   - magick（ImageMagick）在 PATH
#
# 输出：
#   - launcher/assets/svcctl.ico          多尺寸图标（256/128/64/48/32/24/16）
#   - launcher/assets/svcctl-source.png  原图备份（不入仓）

[CmdletBinding()]
param(
    [string]$Source = "$PSScriptRoot\..\launcher\assets\svcctl-source.png"
)

$ErrorActionPreference = "Stop"
$tmp = $env:TEMP
$root = Resolve-Path "$PSScriptRoot\.."
$icoDst = Join-Path $root "launcher\assets\svcctl.ico"
$sourceDst = Join-Path $root "launcher\assets\svcctl-source.png"

# 校验 magick
if (-not (Get-Command magick -ErrorAction SilentlyContinue)) {
    throw "magick (ImageMagick) not found in PATH. Install via: scoop install imagemagick"
}

# 校验源图
if (-not (Test-Path $Source)) {
    throw "source image not found: $Source"
}

Write-Host "[build-icon] source: $Source" -ForegroundColor Cyan

# 1. 复制到 ASCII 临时路径（magick native 调用对非 ASCII 路径编码乱码）
$asciiSrc = Join-Path $tmp "orb-source.png"
Copy-Item -Force $Source $asciiSrc

$origSize = magick $asciiSrc -format "%w x %h" info:
Write-Host "[build-icon] orig:   $origSize" -ForegroundColor Cyan

# 2. 直接从原图生成多尺寸 .ico（magick 内部 resize 到各目标尺寸）
#    不做 trim / resize / extent —— 原图就是 source of truth
$icoTmp = Join-Path $tmp "svcctl-new.ico"
magick $asciiSrc -define icon:auto-resize=256,128,64,48,32,24,16 $icoTmp

# 3. 复制到项目 assets/
# 3a. .ico
#     先 Remove 再 Copy，绕过 .NET File.Copy 跨卷/特定文件名偶尔不覆盖的 bug（pwsh 5/7 都中招）
if (Test-Path $icoDst) { Remove-Item $icoDst -Force }
Copy-Item $icoTmp $icoDst
# 3b. 母图备份：原图（byte-level 一致）
if (Test-Path $sourceDst) { Remove-Item $sourceDst -Force }
Copy-Item $asciiSrc $sourceDst

$icoSize = [math]::Round((Get-Item $icoDst).Length / 1KB)
Write-Host ""
Write-Host "[build-icon] $icoDst ($icoSize KB)" -ForegroundColor Green
Write-Host "[build-icon] $sourceDst (母图备份, byte-level = 原图)" -ForegroundColor Green
Write-Host ""
Write-Host "下一步：.\scripts\build-launcher.ps1 重新编译 + 嵌入图标" -ForegroundColor Yellow
