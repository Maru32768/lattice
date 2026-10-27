#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Installer
)

$ErrorActionPreference = 'Stop'
try {
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'The bundled Visual C++ installer is missing.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Installer
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Microsoft Corporation(,|$)') {
        throw 'The bundled Visual C++ installer does not have a valid Microsoft Corporation signature.'
    }
    $process = Start-Process -FilePath $Installer -Verb RunAs -ArgumentList '/install', '/passive', '/norestart' -WindowStyle Hidden -Wait -PassThru
    exit $process.ExitCode
} catch {
    Write-Output ('Visual C++ runtime installation failed or was cancelled. ' + $_.Exception.Message)
    exit 1
}
