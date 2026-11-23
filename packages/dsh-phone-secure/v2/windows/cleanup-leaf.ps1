. (Join-Path $PSScriptRoot 'common.ps1')
try {
    $inputObject = Read-HelperInput
    Assert-InputFields $inputObject @('authorityThumbprint', 'operationId')
    $thumb = Assert-Thumbprint $inputObject.authorityThumbprint
    $id = Assert-OperationId $inputObject.operationId
    Remove-OperationLeaf $thumb $id
    Write-HelperResult @{ cleaned = $true }
    exit 0
} catch {
    Write-HelperFailure $_ 'LEAF_CLEANUP_REQUIRED'
    exit 1
}
