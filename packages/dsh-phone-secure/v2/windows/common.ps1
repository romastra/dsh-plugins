# ASCII-only: compatible with Windows PowerShell 5.1 without a BOM.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:HelperCodes = @(
    'INVALID_INPUT', 'NETWORK_QUERY_FAILED', 'AUTHORITY_REPAIR_REQUIRED',
    'AUTHORITY_INVALID', 'AUTHORITY_EXPIRING', 'PRIVATE_STATE_UNSAFE',
    'PUBLIC_DIRECTORY_UNSAFE', 'PUBLIC_CA_MISMATCH', 'CERTIFICATE_OPERATION_FAILED',
    'IP_ADDRESS_UNAVAILABLE', 'OPERATION_ID_COLLISION', 'LEAF_CLEANUP_REQUIRED'
)
$script:RootSubject = 'CN=Local Phone Root CA'
$script:KspName = 'Microsoft Software Key Storage Provider'

function Stop-Helper {
    param([string]$Code)
    # Only fixed public codes may cross the process boundary.
    if ($script:HelperCodes -notcontains $Code) { $Code = 'CERTIFICATE_OPERATION_FAILED' }
    throw [System.InvalidOperationException]::new($Code)
}
function Write-HelperResult {
    param($Result)
    $json = @{ version = 1; ok = $true; result = $Result } | ConvertTo-Json -Compress -Depth 12
    [Console]::Out.Write($json)
}
function Write-HelperFailure {
    param($Failure, [string]$Fallback = 'CERTIFICATE_OPERATION_FAILED')
    $code = $Fallback
    if ($null -ne $Failure -and $null -ne $Failure.Exception -and $script:HelperCodes -contains $Failure.Exception.Message) {
        $code = $Failure.Exception.Message
    }
    [Console]::Out.Write((@{ version = 1; ok = $false; error = @{ code = $code } } | ConvertTo-Json -Compress))
}
function Read-HelperInput {
    $text = [Console]::In.ReadToEnd()
    if ($text.Length -gt 65536 -or [string]::IsNullOrWhiteSpace($text)) { Stop-Helper 'INVALID_INPUT' }
    try { $request = $text | ConvertFrom-Json -ErrorAction Stop } catch { Stop-Helper 'INVALID_INPUT' }
    if ($null -eq $request -or $request -isnot [System.Management.Automation.PSCustomObject]) { Stop-Helper 'INVALID_INPUT' }
    return $request
}
function Assert-InputFields {
    param($InputObject, [string[]]$Required)
    $actual = @($InputObject.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Required.Count) { Stop-Helper 'INVALID_INPUT' }
    foreach ($name in $Required) { if ($actual -notcontains $name) { Stop-Helper 'INVALID_INPUT' } }
}
function Assert-Thumbprint {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[A-Fa-f0-9]{40}$') { Stop-Helper 'INVALID_INPUT' }
    return $Value.ToUpperInvariant()
}
function Assert-OperationId {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[a-f0-9]{32}$') { Stop-Helper 'INVALID_INPUT' }
    return $Value
}
function Test-LanIPv4 {
    param($Address)
    if ($Address -isnot [string] -or $Address -cnotmatch '^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$') { return $false }
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$ip)) { return $false }
    if ($ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $ip.ToString() -cne $Address) { return $false }
    $bytes = $ip.GetAddressBytes()
    # Owned public, APIPA and loopback unicast addresses are valid too. This is not LAN policy.
    return ($bytes[0] -ne 0 -and $bytes[0] -lt 224)
}
function Get-FullLocalPath {
    param($Value, [string]$Code)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[A-Za-z]:[\\/]' -or $Value.Length -gt 240 -or $Value.IndexOf([char]0) -ge 0) { Stop-Helper $Code }
    # No alternate streams, device paths, wildcards, UNC shares, or relative drive paths.
    if ($Value.Substring(2).IndexOf(':') -ge 0 -or $Value -match '[*?]') { Stop-Helper $Code }
    $full = [System.IO.Path]::GetFullPath($Value).TrimEnd('\')
    if ($full.Length -le 3) { Stop-Helper $Code }
    return $full
}
function Assert-NoReparsePath {
    param([string]$Path, [string]$Code)
    $cursor = $Path
    while (-not [string]::IsNullOrEmpty($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Helper $Code }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Get-CurrentSid {
    return [System.Security.Principal.WindowsIdentity]::GetCurrent().User
}
function New-PrivateDirectorySecurity {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $sid = Get-CurrentSid
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        [void]$acl.AddAccessRule($rule)
    }
    return $acl
}
function Set-PrivateFileAcl {
    param([string]$Path)
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $sid = Get-CurrentSid
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($identity in @($sid, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
    }
    [System.IO.File]::SetAccessControl($Path, $acl)
    Assert-PrivateAcl $Path
}
function Assert-PrivateAcl {
    param([string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    $sid = Get-CurrentSid
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
    $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 3) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
    foreach ($rule in $rules) {
        if ($rule.IsInherited -or $allowed -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
    }
}
function Initialize-PrivateStateDirectory {
    param([string]$Path)
    try {
        Assert-NoReparsePath $Path 'PRIVATE_STATE_UNSAFE'
        # Never change the workspace, script directory, home, profile, or an ancestor of these.
        $protectedPaths = @($PSScriptRoot, (Get-Location).Path, $env:USERPROFILE, $env:APPDATA, $env:LOCALAPPDATA)
        foreach ($protected in $protectedPaths) {
            if ([string]::IsNullOrEmpty($protected)) { continue }
            $protectedFull = [System.IO.Path]::GetFullPath($protected).TrimEnd('\')
            if ($protectedFull.Equals($Path, [System.StringComparison]::OrdinalIgnoreCase) -or $protectedFull.StartsWith($Path + '\', [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
        }
        $drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($Path))
        if ($drive.DriveFormat -ne 'NTFS') { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
        $parent = [System.IO.Directory]::GetParent($Path).FullName
        if (-not [System.IO.Directory]::Exists($parent)) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
        if (Test-Path -LiteralPath $Path) {
            if (-not [System.IO.Directory]::Exists($Path)) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
            # An unrelated existing folder is not a private state directory; do not change its ACL.
            foreach ($entry in @(Get-ChildItem -LiteralPath $Path -Force)) {
                if ($entry.Name -ne 'authority.json' -or $entry.PSIsContainer -or ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
            }
            [System.IO.Directory]::SetAccessControl($Path, (New-PrivateDirectorySecurity))
        } else {
            [void][System.IO.Directory]::CreateDirectory($Path, (New-PrivateDirectorySecurity))
        }
        Assert-PrivateAcl $Path
        $statePath = Join-Path $Path 'authority.json'
        if (Test-Path -LiteralPath $statePath) { Set-PrivateFileAcl $statePath }
    } catch {
        Stop-Helper 'PRIVATE_STATE_UNSAFE'
    }
}
function Initialize-PublicDirectory {
    param([string]$Path)
    try {
        Assert-NoReparsePath $Path 'PUBLIC_DIRECTORY_UNSAFE'
        if (Test-Path -LiteralPath $Path) {
            if (-not [System.IO.Directory]::Exists($Path)) { Stop-Helper 'PUBLIC_DIRECTORY_UNSAFE' }
            # Existing public folder ACLs are intentionally left unchanged.
        } else {
            $parent = [System.IO.Directory]::GetParent($Path).FullName
            if (-not [System.IO.Directory]::Exists($parent)) { Stop-Helper 'PUBLIC_DIRECTORY_UNSAFE' }
            [void][System.IO.Directory]::CreateDirectory($Path, (New-PrivateDirectorySecurity))
        }
        Assert-NoReparsePath (Join-Path $Path 'phone-root-ca.cer') 'PUBLIC_DIRECTORY_UNSAFE'
    } catch { Stop-Helper 'PUBLIC_DIRECTORY_UNSAFE' }
}
function Write-StateRecord {
    param([string]$Path, $Record, [switch]$Create)
    # This nonsecret record is intentionally written before root creation. An interrupted write
    # fails closed on the next call rather than silently replacing an already-enrolled root.
    Assert-NoReparsePath $Path 'PRIVATE_STATE_UNSAFE'
    if ([System.IO.Path]::GetFileName($Path) -ne 'authority.json') { Stop-Helper 'PRIVATE_STATE_UNSAFE' }
    $mode = [System.IO.FileMode]::Open
    if ($Create) { $mode = [System.IO.FileMode]::CreateNew }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($Record | ConvertTo-Json -Compress))
    $stream = [System.IO.FileStream]::new($Path, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
        $stream.SetLength(0)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    Set-PrivateFileAcl $Path
}
function Get-ExactStoreCertificate {
    param([string]$Thumbprint, [string]$Code = 'AUTHORITY_INVALID')
    $thumb = Assert-Thumbprint $Thumbprint
    $expected = 'Cert:\CurrentUser\My\' + $thumb
    try {
        $resolved = Resolve-Path -LiteralPath $expected
        if ($resolved.Provider.Name -ne 'Certificate' -or -not $resolved.Path.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Helper $Code }
        $cert = Get-Item -LiteralPath $expected
        if ($cert -isnot [System.Security.Cryptography.X509Certificates.X509Certificate2] -or $cert.Thumbprint -ne $thumb) { Stop-Helper $Code }
        return $cert
    } catch { Stop-Helper $Code }
}
function Get-OneExtension {
    param($Certificate, [string]$Oid, [switch]$Optional)
    $extensions = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq $Oid })
    if ($extensions.Count -eq 0 -and $Optional) { return $null }
    if ($extensions.Count -ne 1) { Stop-Helper 'AUTHORITY_INVALID' }
    return $extensions[0]
}
function Assert-OwnedAuthority {
    param($Certificate, [string]$ExpectedTag = '', [string]$ExpectedContainer = '')
    if ($Certificate.FriendlyName -cnotmatch '^Phone LAN authority ([a-f0-9]{32})$') { Stop-Helper 'AUTHORITY_INVALID' }
    $id = $Matches[1]
    $tag = 'Phone LAN authority ' + $id
    $container = 'PhoneLanAuthority-' + $id
    if (($ExpectedTag -and $ExpectedTag -cne $tag) -or ($ExpectedContainer -and $ExpectedContainer -cne $container)) { Stop-Helper 'AUTHORITY_INVALID' }
    if ($Certificate.Subject -cne $script:RootSubject -or $Certificate.Issuer -cne $script:RootSubject -or -not $Certificate.HasPrivateKey) { Stop-Helper 'AUTHORITY_INVALID' }
    if ($Certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $Certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow.AddDays(1)) { Stop-Helper 'AUTHORITY_EXPIRING' }
    $basicRaw = Get-OneExtension $Certificate '2.5.29.19'
    $basic = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($basicRaw, $basicRaw.Critical)
    if (-not $basic.CertificateAuthority -or -not $basic.Critical -or -not $basic.HasPathLengthConstraint -or $basic.PathLengthConstraint -ne 0) { Stop-Helper 'AUTHORITY_INVALID' }
    $usageRaw = Get-OneExtension $Certificate '2.5.29.15'
    $usage = [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usageRaw, $usageRaw.Critical)
    $required = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
    if (-not $usage.Critical -or $usage.KeyUsages -ne $required -or $null -ne (Get-OneExtension $Certificate '2.5.29.37' -Optional)) { Stop-Helper 'AUTHORITY_INVALID' }
    if ($Certificate.SignatureAlgorithm.Value -ne '1.2.840.113549.1.1.11') { Stop-Helper 'AUTHORITY_INVALID' }
    $rsa = $null
    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
        if ($rsa -isnot [System.Security.Cryptography.RSACng] -or $rsa.KeySize -lt 3072 -or $rsa.Key.IsMachineKey -or $rsa.Key.Provider.Provider -cne $script:KspName -or $rsa.Key.KeyName -cne $container -or $rsa.Key.ExportPolicy -ne [System.Security.Cryptography.CngExportPolicies]::None) { Stop-Helper 'AUTHORITY_INVALID' }
        # A sign/verify proof checks actual key availability, not only HasPrivateKey metadata.
        $probe = [System.Text.Encoding]::ASCII.GetBytes('local-authority-key-check')
        $signature = $rsa.SignData($probe, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $public = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($Certificate)
        try { if (-not $public.VerifyData($probe, $signature, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)) { Stop-Helper 'AUTHORITY_INVALID' } } finally { $public.Dispose() }
    } catch { Stop-Helper 'AUTHORITY_INVALID' } finally { if ($null -ne $rsa) { $rsa.Dispose() } }
}
function Get-PublicAuthorityResult {
    param($Certificate)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = $sha.ComputeHash($Certificate.RawData) } finally { $sha.Dispose() }
    $fingerprint = ([System.BitConverter]::ToString($digest)).Replace('-', ':')
    return @{
        thumbprint = $Certificate.Thumbprint.ToUpperInvariant()
        caDerBase64 = [Convert]::ToBase64String($Certificate.RawData)
        fingerprint256 = $fingerprint
        notAfterISO = $Certificate.NotAfter.ToUniversalTime().ToString('o')
    }
}
function Assert-LeafForOperation {
    param($Certificate, $Authority, [string]$OperationId)
    if ($Certificate.Thumbprint -eq $Authority.Thumbprint -or $Certificate.FriendlyName -cne ('Phone LAN ephemeral ' + $OperationId) -or -not $Certificate.HasPrivateKey -or $Certificate.Issuer -cne $Authority.Subject) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
    $basicRaw = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
    if ($basicRaw.Count -ne 1) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
    $basic = [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($basicRaw[0], $basicRaw[0].Critical)
    if ($basic.CertificateAuthority) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
    $rsa = $null
    $chain = $null
    $publicRoot = $null
    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
        if ($rsa -isnot [System.Security.Cryptography.RSACng] -or $rsa.Key.IsMachineKey -or $rsa.Key.Provider.Provider -cne $script:KspName -or $rsa.Key.KeyName -cne ('PhoneLanLeaf-' + $OperationId)) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
        $publicRoot = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$Authority.RawData)
        $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
        [void]$chain.ChainPolicy.ExtraStore.Add($publicRoot)
        if (-not $chain.Build($Certificate) -or $chain.ChainElements.Count -ne 2 -or $chain.ChainElements[1].Certificate.Thumbprint -ne $Authority.Thumbprint) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
    } catch { Stop-Helper 'LEAF_CLEANUP_REQUIRED' } finally {
        if ($null -ne $rsa) { $rsa.Dispose() }
        if ($null -ne $chain) { $chain.Dispose() }
        if ($null -ne $publicRoot) { $publicRoot.Dispose() }
    }
}
function Remove-OperationLeaf {
    param([string]$AuthorityThumbprint, [string]$OperationId)
    $thumb = Assert-Thumbprint $AuthorityThumbprint
    $id = Assert-OperationId $OperationId
    $tag = 'Phone LAN ephemeral ' + $id
    $container = 'PhoneLanLeaf-' + $id
    $provider = [System.Security.Cryptography.CngProvider]::new($script:KspName)
    $leaves = @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' | Where-Object { $_.FriendlyName -ceq $tag })
    foreach ($candidate in $leaves) {
        $root = Get-ExactStoreCertificate $thumb 'LEAF_CLEANUP_REQUIRED'
        # Never use a wildcard deletion, friendly-name-only deletion, or the root's key.
        $exact = Get-ExactStoreCertificate $candidate.Thumbprint 'LEAF_CLEANUP_REQUIRED'
        Assert-LeafForOperation $exact $root $id
        $target = 'Cert:\CurrentUser\My\' + $exact.Thumbprint.ToUpperInvariant()
        $resolved = Resolve-Path -LiteralPath $target
        if ($resolved.Provider.Name -ne 'Certificate' -or -not $resolved.Path.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) -or $exact.Thumbprint -eq $thumb) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
        Remove-Item -LiteralPath $target -DeleteKey -Force -ErrorAction Stop
        if (Test-Path -LiteralPath $target) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
    }
    if ([System.Security.Cryptography.CngKey]::Exists($container, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::None)) {
        $key = [System.Security.Cryptography.CngKey]::Open($container, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::None)
        try {
            # An orphan key is removable ONLY with our persisted, exact operation/root marker.
            $marker = $key.GetProperty('PhoneLanOperationOwner', [System.Security.Cryptography.CngPropertyOptions]::CustomProperty)
            $expected = $thumb + ':' + $id
            $actual = [System.Text.Encoding]::ASCII.GetString($marker.GetValue())
            if ($key.IsMachineKey -or $key.KeyName -cne $container -or $key.Provider.Provider -cne $script:KspName -or $actual -cne $expected) { Stop-Helper 'LEAF_CLEANUP_REQUIRED' }
            $key.Delete()
        } catch { Stop-Helper 'LEAF_CLEANUP_REQUIRED' } finally { $key.Dispose() }
    }
}
