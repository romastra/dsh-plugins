. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'network-common.ps1')
try {
    $inputObject = Read-HelperInput
    Assert-InputFields $inputObject @()
    # Legacy entry point: complete inventory, NOT permission to listen or change policy.
    Write-HelperResult @(Get-WindowsAdapters)
    exit 0
} catch {
    Write-HelperFailure $_ 'NETWORK_QUERY_FAILED'
    exit 1
}
