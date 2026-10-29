#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$KeyPath = (Join-Path $env:USERPROFILE '.tauri/lattice.key'),
    [string]$Repository = 'Maru32768/lattice',
    [switch]$RegisterSecrets,
    [switch]$GeneratePassword,
    [switch]$CopyPassword
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$keyFile = [IO.Path]::GetFullPath($KeyPath)
if ($keyFile.StartsWith($repoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Keep the signing key outside the repository.'
}
if ($RegisterSecrets) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw 'Install GitHub CLI and run gh auth login, then rerun with -RegisterSecrets.'
    }
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Run gh auth login before registering secrets.' }
}

$hasPrivate = Test-Path -LiteralPath $keyFile -PathType Leaf
$hasPublic = Test-Path -LiteralPath "$keyFile.pub" -PathType Leaf
if ($hasPrivate -ne $hasPublic) {
    throw 'Only one key file exists. Recover the matching pair from backup; this script never replaces keys.'
}

$configPath = Join-Path $repoRoot 'src-tauri/tauri.conf.json'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$configuredKey = [string]$config.plugins.updater.pubkey
if (-not $hasPrivate -and -not $configuredKey.StartsWith('NOT_CONFIGURED')) {
    throw 'The app already has a public key. Recover its private key instead of generating a replacement.'
}
if ($hasPublic) {
    $publicKey = (Get-Content -LiteralPath "$keyFile.pub" -Raw).Trim()
    if (-not $configuredKey.StartsWith('NOT_CONFIGURED') -and $configuredKey -ne $publicKey) {
        throw 'The local public key differs from the app public key. Do not rotate a released key.'
    }
}

$passwordFile = "$keyFile.password.xml"
$generatedPassword = $false
if (Test-Path -LiteralPath $passwordFile -PathType Leaf) {
    $password = Import-Clixml -LiteralPath $passwordFile
    if ($password -isnot [Security.SecureString]) { throw 'The saved password is not a SecureString.' }
} elseif ($GeneratePassword) {
    if ($hasPrivate) { throw 'Cannot generate a password for an existing key. Supply its original password.' }
    if (-not $IsWindows) { throw 'Automatic password storage requires Windows DPAPI.' }
    $password = ConvertTo-SecureString ([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))) -AsPlainText -Force
    $generatedPassword = $true
} else {
    $password = Read-Host 'Signing key password (save it in your password manager)' -AsSecureString
}
$ptr = [IntPtr]::Zero
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
$previousPublicKey = $env:LATTICE_UPDATER_PUBLIC_KEY
$previousKeyPath = $env:LATTICE_UPDATER_KEY_PATH
$probeDir = $null
Push-Location $repoRoot
try {
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ([string]::IsNullOrEmpty($plainPassword)) { throw 'Use a nonempty signing password.' }
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $plainPassword

    if (-not $hasPrivate) {
        if (-not $generatedPassword -and -not (Test-Path -LiteralPath $passwordFile)) {
            $confirm = Read-Host 'Confirm signing key password' -AsSecureString
            $confirmPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
            try {
                if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmPtr) -cne $plainPassword) {
                    throw 'Passwords do not match. No key was generated.'
                }
            } finally {
                [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmPtr)
                $confirm.Dispose()
            }
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $keyFile) -Force | Out-Null
        if ($generatedPassword) { $password | Export-Clixml -LiteralPath $passwordFile }
        $env:LATTICE_UPDATER_KEY_PATH = $keyFile
        & mise exec -- node -e 'require("@tauri-apps/cli").run(["signer","generate","--ci","--password",process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,"--write-keys",process.env.LATTICE_UPDATER_KEY_PATH]).catch(() => { process.exitCode=1; });' *> $null
        if ($LASTEXITCODE -ne 0) { throw 'Key generation failed. Inspect the key paths before retrying.' }
    }

    $probeDir = Join-Path ([IO.Path]::GetTempPath()) ('lattice-signing-' + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $probeDir | Out-Null
    $probe = Join-Path $probeDir 'probe.txt'
    [IO.File]::WriteAllText($probe, 'Lattice updater key check')
    & mise exec -- npx --no-install tauri signer sign --private-key-path $keyFile $probe *> $null
    if ($LASTEXITCODE -ne 0) { throw 'Could not sign with this key and password. Configuration was not changed.' }
    & mise exec -- node (Join-Path $PSScriptRoot 'verify-updater.ts') "$keyFile.pub" "$probe.sig" $probe *> $null
    if ($LASTEXITCODE -ne 0) { throw 'The private key and public key do not form a matching pair. Configuration was not changed.' }

    $publicKey = (Get-Content -LiteralPath "$keyFile.pub" -Raw).Trim()
    $env:LATTICE_UPDATER_PUBLIC_KEY = $publicKey
    & mise exec -- node --input-type=module -e 'import fs from "node:fs"; const p="src-tauri/tauri.conf.json"; const c=JSON.parse(fs.readFileSync(p,"utf8")); c.plugins.updater.pubkey=process.env.LATTICE_UPDATER_PUBLIC_KEY; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
    if ($LASTEXITCODE -ne 0) { throw 'Could not update the public key in tauri.conf.json.' }

    if ($RegisterSecrets) {
        foreach ($secret in @(
            @{ Name = 'TAURI_SIGNING_PRIVATE_KEY'; Value = [IO.File]::ReadAllText($keyFile) },
            @{ Name = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'; Value = $plainPassword }
        )) {
            $start = [Diagnostics.ProcessStartInfo]::new('gh')
            $start.UseShellExecute = $false
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            foreach ($arg in @('secret', 'set', $secret.Name, '--repo', $Repository)) { $start.ArgumentList.Add($arg) }
            $process = [Diagnostics.Process]::Start($start)
            $output = $process.StandardOutput.ReadToEndAsync()
            $errors = $process.StandardError.ReadToEndAsync()
            $process.StandardInput.Write($secret.Value)
            $process.StandardInput.Close()
            $process.WaitForExit()
            $output.GetAwaiter().GetResult() | Out-Null
            $errors.GetAwaiter().GetResult() | Out-Null
            if ($process.ExitCode -ne 0) { throw "Could not register $($secret.Name). Rerun with the same key pair." }
            $process.Dispose()
            $secret.Value = $null
        }
        Write-Host 'Both GitHub Actions signing secrets were registered.'
    }
    if ($CopyPassword) {
        Set-Clipboard -Value $plainPassword
        Write-Host 'Password copied. Save it in your password manager, then clear the clipboard.'
    }
    Write-Host "Public key configured. Back up $keyFile, $keyFile.pub and the password before releasing."
} finally {
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
    $env:LATTICE_UPDATER_PUBLIC_KEY = $previousPublicKey
    $env:LATTICE_UPDATER_KEY_PATH = $previousKeyPath
    $plainPassword = $null
    if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $password.Dispose()
    if ($probeDir) {
        Remove-Item -LiteralPath (Join-Path $probeDir 'probe.txt.sig') -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $probeDir 'probe.txt') -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $probeDir -ErrorAction SilentlyContinue
    }
    Pop-Location
}
