# This script CREATES a root only when explicitly invoked and no state exists.
. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $inputObject = Read-HelperInput
    Assert-InputFields $inputObject @('stateDir', 'publicDir')
    $stateDir = Get-FullLocalPath $inputObject.stateDir 'PRIVATE_STATE_UNSAFE'
    $publicDir = Get-FullLocalPath $inputObject.publicDir 'PUBLIC_DIRECTORY_UNSAFE'
    if ($stateDir.Equals($publicDir, [System.StringComparison]::OrdinalIgnoreCase) -or $stateDir.StartsWith($publicDir + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $publicDir.StartsWith($stateDir + '\', [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Helper 'INVALID_INPUT' }
    Initialize-PrivateStateDirectory $stateDir
    Initialize-PublicDirectory $publicDir
    $statePath = Join-Path $stateDir 'authority.json'
    $publicPath = Join-Path $publicDir 'phone-root-ca.cer'
    $authority = $null
    if (Test-Path -LiteralPath $statePath) {
        try {
            if ((Get-Item -LiteralPath $statePath).Length -gt 16384) { Stop-Helper 'AUTHORITY_REPAIR_REQUIRED' }
            $saved = [System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            Assert-InputFields $saved @('version', 'status', 'ownerTag', 'keyContainer', 'thumbprint')
            if ($saved.version -ne 1 -or $saved.status -cne 'ready' -or $saved.ownerTag -cnotmatch '^Phone LAN authority ([a-f0-9]{32})$') { Stop-Helper 'AUTHORITY_REPAIR_REQUIRED' }
            $id = $Matches[1]
            if ($saved.keyContainer -cne ('PhoneLanAuthority-' + $id)) { Stop-Helper 'AUTHORITY_REPAIR_REQUIRED' }
            $thumbprint = Assert-Thumbprint $saved.thumbprint
            $authority = Get-ExactStoreCertificate $thumbprint 'AUTHORITY_REPAIR_REQUIRED'
        } catch { Stop-Helper 'AUTHORITY_REPAIR_REQUIRED' }
        Assert-OwnedAuthority $authority $saved.ownerTag $saved.keyContainer
    } else {
        # A previously distributed public root without state must NOT trigger replacement.
        if (Test-Path -LiteralPath $publicPath) { Stop-Helper 'AUTHORITY_REPAIR_REQUIRED' }
        $id = [Guid]::NewGuid().ToString('N')
        $saved = @{
            version = 1
            status = 'creating'
            ownerTag = 'Phone LAN authority ' + $id
            keyContainer = 'PhoneLanAuthority-' + $id
            thumbprint = $null
        }
        # CreateNew provides cross-process exclusion and a durable fail-closed repair marker.
        Write-StateRecord $statePath $saved -Create
        $now = [DateTime]::UtcNow
        $parameters = @{
            Type = 'Custom'
            Subject = $script:RootSubject
            FriendlyName = $saved.ownerTag
            CertStoreLocation = 'Cert:\CurrentUser\My'
            Provider = $script:KspName
            Container = $saved.keyContainer
            KeyAlgorithm = 'RSA'
            KeyLength = 3072
            HashAlgorithm = 'SHA256'
            KeyExportPolicy = 'NonExportable'
            KeyUsageProperty = 'Sign'
            KeyUsage = @('CertSign', 'CRLSign')
            TextExtension = @('2.5.29.19={critical}{text}ca=1&pathlength=0')
            NotBefore = $now.AddMinutes(-5)
            NotAfter = $now.AddYears(7)
        }
        $authority = New-SelfSignedCertificate @parameters
        Assert-OwnedAuthority $authority $saved.ownerTag $saved.keyContainer
        # Never delete an authority on an error; its protected Windows key is persistent.
        $saved.thumbprint = $authority.Thumbprint.ToUpperInvariant()
        $saved.status = 'ready'
        Write-StateRecord $statePath $saved
    }
    $der = [byte[]]$authority.RawData
    if (Test-Path -LiteralPath $publicPath) {
        if (-not [System.IO.File]::Exists($publicPath) -or (Get-Item -LiteralPath $publicPath).Length -gt 131072) { Stop-Helper 'PUBLIC_DIRECTORY_UNSAFE' }
        $old = [System.IO.File]::ReadAllBytes($publicPath)
        if ([Convert]::ToBase64String($old) -cne [Convert]::ToBase64String($der)) { Stop-Helper 'PUBLIC_CA_MISMATCH' }
    } else {
        Assert-NoReparsePath $publicPath 'PUBLIC_DIRECTORY_UNSAFE'
        $stream = [System.IO.FileStream]::new($publicPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $stream.Write($der, 0, $der.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    Write-HelperResult (Get-PublicAuthorityResult $authority)
    exit 0
} catch {
    Write-HelperFailure $_
    exit 1
}
