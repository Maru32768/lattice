#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Windows runtime preparation requires Windows.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'target/windows-runtime'
$installer = Join-Path $runtimeDir 'vc_redist.x64.exe'
$minimumVersion = [version]'14.44.35211.0'
[IO.Directory]::CreateDirectory($runtimeDir) | Out-Null

$download = $null
try {
    $candidate = $installer
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        $download = Join-Path $runtimeDir ('vc_redist.' + [guid]::NewGuid().ToString('N') + '.exe')
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $download -UseBasicParsing
        $candidate = $download
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $candidate
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
        throw 'The Visual C++ installer must have a valid Microsoft Corporation signature. Remove an invalid cached installer and retry.'
    }
    $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($candidate)
    $version = [version]::new($info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
    if ($version -lt $minimumVersion) {
        throw "The Visual C++ installer is $version; Lattice requires $minimumVersion or newer. Remove the outdated cached installer and retry."
    }
    if ($download) { Move-Item -LiteralPath $download -Destination $installer }

    $installerPath = [IO.Path]::GetFullPath($installer).Replace('$', '$$').Replace('"', '$\"')
    $scriptPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'install-windows-runtime.ps1')).Replace('$', '$$').Replace('"', '$\"')
    $include = @"
!define LATTICE_VC_REDIST "$installerPath"
!define LATTICE_VC_RUNTIME_VERSION "$version"
!define LATTICE_VC_INSTALL_SCRIPT "$scriptPath"
"@
    [IO.File]::WriteAllText((Join-Path $runtimeDir 'runtime.nsh'), $include + "`n", [Text.UTF8Encoding]::new($true))
    Write-Output "Prepared Microsoft Visual C++ x64 runtime $version."
} finally {
    if ($download -and (Test-Path -LiteralPath $download -PathType Leaf)) { Remove-Item -LiteralPath $download }
}
