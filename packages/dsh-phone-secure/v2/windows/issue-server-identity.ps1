. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'network-common.ps1')
$pfxBytes = $null
$publicRoot = $null
$leaf = $null
$operationStarted = $false
$operationId = $null
$thumb = $null
try {
    $inputObject = Read-HelperInput
    Assert-InputFields $inputObject @('authorityThumbprint', 'ipAddresses', 'passphrase', 'operationId')
    $thumb = Assert-Thumbprint $inputObject.authorityThumbprint
    $operationId = Assert-OperationId $inputObject.operationId
    if ($inputObject.passphrase -isnot [string] -or $inputObject.passphrase -cnotmatch '^[A-Za-z0-9_-]{43}$' -or $inputObject.ipAddresses -isnot [System.Array] -or $inputObject.ipAddresses.Count -lt 1 -or $inputObject.ipAddresses.Count -gt 16) { Stop-Helper 'INVALID_INPUT' }
    $ips = @($inputObject.ipAddresses)
    $seen = @{}
    foreach ($ip in $ips) {
        if (-not (Test-LanIPv4 $ip) -or $seen.ContainsKey($ip)) { Stop-Helper 'INVALID_INPUT' }
        $seen[$ip] = $true
    }
    $available = @(Get-NetworkCandidates)
    foreach ($ip in $ips) { if (@($available | Where-Object { $_.address -ceq $ip }).Count -eq 0) { Stop-Helper 'IP_ADDRESS_UNAVAILABLE' } }
    $authority = Get-ExactStoreCertificate $thumb
    Assert-OwnedAuthority $authority
    $container = 'PhoneLanLeaf-' + $operationId
    $tag = 'Phone LAN ephemeral ' + $operationId
    $provider = [System.Security.Cryptography.CngProvider]::new($script:KspName)
    if ([System.Security.Cryptography.CngKey]::Exists($container, $provider, [System.Security.Cryptography.CngKeyOpenOptions]::None) -or @(Get-ChildItem -LiteralPath 'Cert:\CurrentUser\My' | Where-Object { $_.FriendlyName -ceq $tag }).Count -gt 0) { Stop-Helper 'OPERATION_ID_COLLISION' }
    $now = [DateTime]::UtcNow
    $notAfter = $now.AddDays(365)
    $limit = $authority.NotAfter.ToUniversalTime().AddMinutes(-5)
    if ($notAfter -gt $limit) { $notAfter = $limit }
    if ($notAfter -le $now.AddDays(1)) { Stop-Helper 'AUTHORITY_EXPIRING' }
    $san = '2.5.29.17={text}' + (($ips | ForEach-Object { 'IPAddress=' + $_ }) -join '&')
    $parameters = @{
        Type = 'Custom'
        Subject = 'CN=' + $ips[0]
        FriendlyName = $tag
        Signer = $authority
        CertStoreLocation = 'Cert:\CurrentUser\My'
        Provider = $script:KspName
        Container = $container
        KeyAlgorithm = 'RSA'
        KeyLength = 2048
        HashAlgorithm = 'SHA256'
        KeyExportPolicy = 'Exportable'
        KeyUsageProperty = 'All'
        KeyUsage = @('DigitalSignature', 'KeyEncipherment')
        TextExtension = @('2.5.29.19={critical}{text}ca=0', '2.5.29.37={text}1.3.6.1.5.5.7.3.1', $san)
        NotBefore = $now.AddMinutes(-5)
        NotAfter = $notAfter
    }
    $operationStarted = $true
    $leaf = New-SelfSignedCertificate @parameters
    Assert-LeafForOperation $leaf $authority $operationId
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($leaf)
    try {
        $markerBytes = [System.Text.Encoding]::ASCII.GetBytes($thumb + ':' + $operationId)
        $options = [System.Security.Cryptography.CngPropertyOptions]::CustomProperty -bor [System.Security.Cryptography.CngPropertyOptions]::Persist
        $marker = [System.Security.Cryptography.CngProperty]::new('PhoneLanOperationOwner', $markerBytes, $options)
        $rsa.Key.SetProperty($marker)
    } finally { $rsa.Dispose() }
    # CRITICAL: reconstruct from DER. Never add $authority (which has the root private key)
    # to the export collection. No private PFX is ever written to a file.
    $publicRoot = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$authority.RawData)
    if ($publicRoot.HasPrivateKey) { Stop-Helper 'CERTIFICATE_OPERATION_FAILED' }
    $collection = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
    [void]$collection.Add($leaf)
    [void]$collection.Add($publicRoot)
    $pfxBytes = $collection.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $inputObject.passphrase)
    $result = @{
        pfxBase64 = [Convert]::ToBase64String($pfxBytes)
        leafDerBase64 = [Convert]::ToBase64String($leaf.RawData)
        authority = Get-PublicAuthorityResult $authority
        notAfterISO = $leaf.NotAfter.ToUniversalTime().ToString('o')
    }
    # A success response is withheld until the exact certificate AND key are removed.
    Remove-OperationLeaf $thumb $operationId
    $operationStarted = $false
    Write-HelperResult $result
    exit 0
} catch {
    $failure = $_
    if ($operationStarted -and $null -ne $thumb -and $null -ne $operationId) {
        try { Remove-OperationLeaf $thumb $operationId } catch {
            Write-HelperFailure $_ 'LEAF_CLEANUP_REQUIRED'
            exit 1
        }
    }
    Write-HelperFailure $failure
    exit 1
} finally {
    if ($null -ne $pfxBytes) { [Array]::Clear($pfxBytes, 0, $pfxBytes.Length) }
    if ($null -ne $leaf) { $leaf.Dispose() }
    if ($null -ne $publicRoot) { $publicRoot.Dispose() }
}
