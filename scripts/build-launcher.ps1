# Build one Windows Rust supervisor target into its npm platform package.

[CmdletBinding()]
param(
    [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
    [string]$Target = $(if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }),
    [switch]$NoSync
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$packageName = switch ($Target) {
    "x86_64-pc-windows-msvc" { "svcctl-win32-x64" }
    "aarch64-pc-windows-msvc" { "svcctl-win32-arm64" }
}
$expectedMachine = switch ($Target) {
    "x86_64-pc-windows-msvc" { "x64" }
    "aarch64-pc-windows-msvc" { "arm64" }
}

function Initialize-MsvcEnvironment([string]$Architecture) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) {
        throw "Visual Studio Installer (vswhere.exe) was not found"
    }

    $component = if ($Architecture -eq "arm64") {
        "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
    } else {
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
    }
    $installationPath = & $vswhere -latest -products * -requires $component -property installationPath
    if (-not $installationPath) {
        throw "Visual Studio C++ tools for $Architecture are not installed (missing $component)"
    }

    $devCmd = Join-Path $installationPath "Common7\Tools\VsDevCmd.bat"
    $environmentLines = & cmd.exe /d /s /c "`"$devCmd`" -no_logo -arch=$Architecture -host_arch=x64 && set"
    if ($LASTEXITCODE -ne 0) { throw "VsDevCmd failed for $Architecture" }
    foreach ($line in $environmentLines) {
        if ($line -match '^([^=]+)=(.*)$') {
            Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
}

Write-Host "[build-launcher] compiling $Target..." -ForegroundColor Cyan
if ($Target -eq "aarch64-pc-windows-msvc") {
    Initialize-MsvcEnvironment "arm64"
}
Push-Location "$root\launcher"
try {
    rustup target add $Target
    if ($LASTEXITCODE -ne 0) { throw "rustup target add failed for $Target" }
    cargo build --release --locked --target $Target
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed for $Target" }
} finally {
    Pop-Location
}

$src = Join-Path $root "launcher\target\$Target\release\SvcCtl.exe"
$dst = Join-Path $root "packages\$packageName\SvcCtl.exe"
if (-not (Test-Path -LiteralPath $src)) {
    throw "compiled binary not found: $src"
}

New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
Copy-Item -LiteralPath $src -Destination $dst -Force
& "$PSScriptRoot\verify-pe-architecture.ps1" -Path $dst -Expected $expectedMachine

$size = (Get-Item -LiteralPath $dst).Length
Write-Host "[build-launcher] wrote $dst ($([math]::Round($size / 1024)) KB)" -ForegroundColor Green

$nativeTarget = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") {
    "aarch64-pc-windows-msvc"
} else {
    "x86_64-pc-windows-msvc"
}

# Keep the locally installed supervisor in sync only for a native local build.
if (-not $NoSync -and $Target -eq $nativeTarget) {
    $installBin = Join-Path $env:USERPROFILE ".local\share\svcctl\bin\SvcCtl.exe"
    if (Test-Path -LiteralPath (Split-Path $installBin)) {
        try {
            Copy-Item -LiteralPath $src -Destination $installBin -Force
            Write-Host "[build-launcher] synced to $installBin" -ForegroundColor Green
        } catch {
            Write-Host "[build-launcher] skipped locked install binary: $installBin" -ForegroundColor DarkYellow
        }
    }
}
