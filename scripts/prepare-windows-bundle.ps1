#Requires -Version 7.2
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    & mise exec -- cargo build --release --locked -p lattice-cli
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the CLI for the Windows installer.' }
    & (Join-Path $PSScriptRoot 'prepare-windows-runtime.ps1')
} finally {
    Pop-Location
}
