[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Path,
    [Parameter(Mandatory)]
    [ValidateSet("x64", "arm64")]
    [string]$Expected
)

$ErrorActionPreference = "Stop"
$resolved = Resolve-Path -LiteralPath $Path
$stream = [System.IO.File]::OpenRead($resolved)
$reader = $null
try {
    $reader = [System.IO.BinaryReader]::new($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$resolved is not a PE file" }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadUInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "$resolved has an invalid PE signature" }
    $machine = $reader.ReadUInt16()
} finally {
    if ($reader) { $reader.Dispose() }
    $stream.Dispose()
}

$actual = switch ($machine) {
    0x8664 { "x64" }
    0xAA64 { "arm64" }
    default { "unknown (0x$($machine.ToString('X4')))" }
}

if ($actual -ne $Expected) {
    throw "PE architecture mismatch for $resolved`: expected $Expected, got $actual"
}
Write-Host "[verify-pe] $resolved is $actual" -ForegroundColor Green
