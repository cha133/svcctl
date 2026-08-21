[CmdletBinding()]
param(
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$main = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$x64 = Get-Content (Join-Path $root "packages\svcctl-win32-x64\package.json") -Raw | ConvertFrom-Json
$arm64 = Get-Content (Join-Path $root "packages\svcctl-win32-arm64\package.json") -Raw | ConvertFrom-Json
$cargo = Get-Content (Join-Path $root "launcher\Cargo.toml") -Raw
$cargoLock = Get-Content (Join-Path $root "launcher\Cargo.lock") -Raw

$versions = @(
    $main.version,
    $x64.version,
    $arm64.version,
    $main.optionalDependencies."svcctl-win32-x64",
    $main.optionalDependencies."svcctl-win32-arm64"
)
if (($versions | Select-Object -Unique).Count -ne 1) {
    throw "Release versions are not synchronized: $($versions -join ', ')"
}

$cargoMatch = [regex]::Match($cargo, '(?m)^version = "([^"]+)"')
if (-not $cargoMatch.Success -or $cargoMatch.Groups[1].Value -ne $main.version) {
    throw "launcher/Cargo.toml version does not match package.json version $($main.version)"
}

$cargoLockMatch = [regex]::Match($cargoLock, '(?m)\[\[package\]\]\r?\nname = "svcctl"\r?\nversion = "([^"]+)"')
if (-not $cargoLockMatch.Success -or $cargoLockMatch.Groups[1].Value -ne $main.version) {
    throw "launcher/Cargo.lock version does not match package.json version $($main.version)"
}

if ($Tag -and $Tag -ne "v$($main.version)") {
    throw "Release tag $Tag does not match package version v$($main.version)"
}

$x64Binary = Join-Path $root "packages\svcctl-win32-x64\SvcCtl.exe"
$arm64Binary = Join-Path $root "packages\svcctl-win32-arm64\SvcCtl.exe"
& "$PSScriptRoot\verify-pe-architecture.ps1" -Path $x64Binary -Expected x64
& "$PSScriptRoot\verify-pe-architecture.ps1" -Path $arm64Binary -Expected arm64

Write-Host "[verify-release] version $($main.version) is ready to package." -ForegroundColor Green
