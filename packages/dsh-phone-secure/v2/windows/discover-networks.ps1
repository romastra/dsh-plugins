. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'network-common.ps1')
try {
    $inputObject = Read-HelperInput
    Assert-InputFields $inputObject @()
    Write-HelperResult @(Get-NetworkCandidates)
    exit 0
} catch {
    Write-HelperFailure $_ 'NETWORK_QUERY_FAILED'
    exit 1
}
