# Read-only synthetic adapter/address fixtures. Never invokes any PKI operation.
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'network-common.ps1')
$script:NativeFailure = $false
$script:ManagedFailure = $false
$script:NativeAddressFailure = $false
$script:RouteQueries = 0
$script:Assertions = 0
function Test-Guid { param([int]$Index) return ('00000000-0000-0000-0000-' + $Index.ToString('000000000000')) }
function Assert-Test {
    param([bool]$Condition, [string]$Message)
    $script:Assertions++
    if (-not $Condition) { throw $Message }
}
function New-TestAdapter {
    param([int]$Index, [string]$Name, [int]$Type = 6, [string]$Status = 'Up', [string]$Description = 'Network controller', [bool]$Virtual = $false)
    # These flags intentionally must not make software/non-connected devices disappear.
    return [PSCustomObject]@{ HardwareInterface = $false; Virtual = $Virtual; ConnectorPresent = $false; InterfaceType = $Type; Status = $Status; InterfaceGuid = ('{' + (Test-Guid $Index).ToUpperInvariant() + '}'); Name = $Name; ifIndex = $Index; InterfaceDescription = $Description }
}
function Get-NetAdapter {
    param([switch]$Physical, [switch]$IncludeHidden, $ErrorAction)
    if ($Physical -or -not $IncludeHidden) { throw 'Inclusive hidden adapter query required' }
    if ($script:NativeFailure) { throw 'Synthetic NetAdapter unavailable' }
    New-TestAdapter 1 'renamed-vpn-but-wifi' -Type 71 -Description 'Wireless controller'
    New-TestAdapter 2 'Ethernet without gateway'
    New-TestAdapter 3 'Radmin VPN' -Description 'Radmin VPN adapter' -Virtual $true
    New-TestAdapter 4 'vEthernet (Hyper-V)' -Description 'Hyper-V Virtual Ethernet Adapter' -Virtual $true
    New-TestAdapter 5 'unplugged adapter' -Status 'Disconnected'
    New-TestAdapter 6 'Up without IPv4'
    New-TestAdapter 7 'WireGuard' -Type 131 -Description 'WireGuard Tunnel' -Virtual $true
    New-TestAdapter 8 'future interface' -Type 999
    New-TestAdapter 9 "APIPA`ncontrol$([char]0x202e)alias"
}
function Get-NetIPAddress {
    param($AddressFamily, $PolicyStore, $ErrorAction)
    if ($script:NativeFailure -or $script:NativeAddressFailure) { throw 'Synthetic NetIPAddress unavailable' }
    if ($AddressFamily -ne 'IPv4' -or $PolicyStore -ne 'ActiveStore') { throw 'Expected owned active IPv4 query' }
    foreach ($entry in @(
        @(1, '192.168.7.10', 24, 'Preferred', $false),
        @(1, '192.168.7.1', 24, 'Preferred', $true),
        @(1, '192.168.7.2', 24, 'Deprecated', $false),
        @(1, '192.168.7.11', 24, 'Tentative', $false),
        @(1, '0.0.0.0', 0, 'Preferred', $false),
        @(1, '224.1.2.3', 24, 'Preferred', $false),
        @(1, '255.255.255.255', 32, 'Preferred', $false),
        @(2, '10.1.2.3', 0, 'Deprecated', $true),
        @(3, '26.33.44.55', 8, 'Preferred', $true),
        @(4, '172.20.16.1', 20, 'Preferred', $false),
        @(5, '172.16.0.2', 24, 'Preferred', $false),
        @(7, '10.8.0.2', 32, 'Deprecated', $true),
        @(8, '203.0.113.5', 0, 'Preferred', $false),
        @(9, '169.254.1.1', 16, 'Preferred', $false)
    )) { [PSCustomObject]@{ InterfaceIndex = $entry[0]; IPAddress = $entry[1]; PrefixLength = $entry[2]; AddressState = $entry[3]; SkipAsSource = $entry[4] } }
}
function Get-NetRoute {
    $script:RouteQueries++
    throw 'Gateway/route queries must not be used for discovery'
}
function New-TestUnicast {
    param([string]$Address, [int]$Prefix, [string]$State = 'Preferred')
    return [PSCustomObject]@{ Address = [System.Net.IPAddress]::Parse($Address); PrefixLength = $Prefix; DuplicateAddressDetectionState = $State }
}
function New-TestManagedAdapter {
    param([int]$Index, [string]$Name, [int]$Type = 6, [string]$Status = 'Up', [string]$Description = 'Network controller', [object[]]$Unicast = @(), [switch]$NoIndex, [switch]$IPv6Only)
    $reportedIndex = $Index
    if ($NoIndex) { $reportedIndex = 0 }
    $properties = [PSCustomObject]@{ UnicastAddresses = $Unicast; IPv4Data = [PSCustomObject]@{ Index = $reportedIndex }; IPv6Data = [PSCustomObject]@{ Index = $reportedIndex }; IPv6Only = [bool]$IPv6Only }
    Add-Member -InputObject $properties -MemberType ScriptMethod -Name GetIPv4Properties -Value { if ($this.IPv6Only) { throw 'IPv4 is not bound' }; return $this.IPv4Data }
    Add-Member -InputObject $properties -MemberType ScriptMethod -Name GetIPv6Properties -Value { return $this.IPv6Data }
    $adapter = [PSCustomObject]@{ Id = ('{' + (Test-Guid $Index).ToUpperInvariant() + '}'); Name = $Name; NetworkInterfaceType = $Type; OperationalStatus = $Status; Description = $Description; Properties = $properties }
    Add-Member -InputObject $adapter -MemberType ScriptMethod -Name GetIPProperties -Value { return $this.Properties }
    return $adapter
}
function Get-WindowsNetworkInterfaces {
    if ($script:ManagedFailure) { throw 'Synthetic managed inventory unavailable' }
    New-TestManagedAdapter 1 'Wi-Fi from managed source' -Type 71 -Unicast @((New-TestUnicast '192.168.7.1' 24), (New-TestUnicast '192.168.7.20' 24))
    New-TestManagedAdapter 2 'Ethernet without gateway' -Unicast @((New-TestUnicast '10.1.2.3' 0 'Deprecated'))
    New-TestManagedAdapter 3 'Radmin VPN' -Description 'Radmin VPN' -Unicast @((New-TestUnicast '26.33.44.55' 8))
    New-TestManagedAdapter 4 'Hyper-V virtual switch' -Description 'Hyper-V Virtual Ethernet' -Unicast @((New-TestUnicast '172.20.16.1' 20))
    New-TestManagedAdapter 5 'unplugged adapter' -Status 'Down' -Unicast @((New-TestUnicast '172.16.0.2' 24))
    New-TestManagedAdapter 6 'Up without IPv4' -IPv6Only
    New-TestManagedAdapter 7 'WireGuard' -Type 131 -Description 'WireGuard Tunnel' -Unicast @((New-TestUnicast '10.8.0.2' 32))
    New-TestManagedAdapter 8 'future interface' -Type 999 -Unicast @((New-TestUnicast '203.0.113.5' 0))
    New-TestManagedAdapter 9 'APIPA' -Unicast @((New-TestUnicast '169.254.1.1' 16))
    New-TestManagedAdapter 10 'software tunnel' -Type 131 -Unicast @((New-TestUnicast '100.64.0.9' 32 'Tentative'))
    # Prefix metadata may require the Framework IPv4Mask fallback rather than PrefixLength.
    $loopback = [PSCustomObject]@{ Address = [System.Net.IPAddress]::Loopback; IPv4Mask = [System.Net.IPAddress]::Parse('255.0.0.0'); DuplicateAddressDetectionState = 'Preferred' }
    New-TestManagedAdapter 11 'Loopback Pseudo-Interface 1' -Type 24 -Unicast @($loopback)
    New-TestManagedAdapter 12 'No IP stack interface' -Type 999 -NoIndex
}
try {
    Assert-InputFields ([PSCustomObject]@{}) @()
    $adapters = @(Get-WindowsAdapters)
    Assert-Test ($adapters.Count -eq 12) 'Union must keep all twelve interfaces'
    foreach ($index in 1..12) { Assert-Test (@($adapters | Where-Object { $_.interfaceGuid -ceq (Test-Guid $index) }).Count -eq 1) 'GUID union must be stable and duplicate-free' }
    $wifi = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 1) })[0]
    Assert-Test ($wifi.kind -eq 'wifi' -and $wifi.address -eq '192.168.7.10') 'Prefer normal Preferred address without excluding alternatives'
    $radmin = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 3) })[0]
    Assert-Test ($radmin.kind -eq 'vpn' -and $radmin.available -and $radmin.address -eq '26.33.44.55') 'Radmin public IPv4 must be usable'
    $hyperv = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 4) })[0]
    Assert-Test ($hyperv.kind -eq 'virtual' -and $hyperv.available) 'Hyper-V must remain available'
    $wireguard = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 7) })[0]
    Assert-Test ($wireguard.kind -eq 'vpn' -and $wireguard.address -eq '10.8.0.2' -and $wireguard.prefixLength -eq 32) 'WireGuard host prefix must be retained'
    $loop = @($adapters | Where-Object { $_.kind -eq 'loopback' })[0]
    Assert-Test ($loop.available -and $loop.address -eq '127.0.0.1' -and $loop.prefixLength -eq 8) 'Managed-only software loopback must be included'
    $tunnel = @($adapters | Where-Object { $_.kind -eq 'tunnel' })[0]
    Assert-Test ($tunnel.available -and $tunnel.address -eq '100.64.0.9') 'Managed-only tunnel must be included'
    foreach ($index in @(5, 6, 12)) {
        $row = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid $index) })[0]
        Assert-Test (-not $row.available -and $null -eq $row.address -and $null -eq $row.prefixLength) 'Down/no IPv4/no index inventory rows must remain null-addressed'
    }
    Assert-Test (@($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 5) })[0].status -eq 'Disconnected') 'Retain native status'
    Assert-Test (@($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 12) })[0].interfaceIndex -eq 0) 'Unknown index is inventory sentinel zero'
    $apipa = @($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 9) })[0]
    Assert-Test ($apipa.available -and $apipa.address -eq '169.254.1.1') 'APIPA is usable owned unicast'
    Assert-Test ($apipa.interfaceAlias -notmatch '[\x00-\x1f\u202e]') 'Sanitize display controls'
    Assert-Test (@($adapters | Where-Object { $_.interfaceGuid -eq (Test-Guid 8) })[0].kind -eq 'other') 'Unknown type stays in inventory'
    $candidates = @(Get-NetworkCandidates)
    foreach ($kind in @('wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other')) { Assert-Test (@($candidates | Where-Object { $_.kind -eq $kind }).Count -gt 0) 'Candidates must include every recognized kind' }
    foreach ($address in @('192.168.7.1', '192.168.7.2', '192.168.7.11', '26.33.44.55', '10.8.0.2', '127.0.0.1', '169.254.1.1')) { Assert-Test (@($candidates | Where-Object { $_.address -eq $address }).Count -eq 1) 'Keep all owned valid source addresses for SAN validation' }
    Assert-Test (@($candidates | Where-Object { $_.address -eq '10.1.2.3' -and $_.prefixLength -eq 0 }).Count -eq 1) 'Zero prefix and SkipAsSource fallback need no gateway'
    Assert-Test (@($candidates | Where-Object { $_.interfaceGuid -eq (Test-Guid 5) }).Count -eq 0) 'Disconnected interface is inventory only'
    Assert-Test (@(Get-PhysicalLanAdapters).Count -eq $adapters.Count) 'Legacy adapter wrapper must remain inclusive'
    Assert-Test (@(Get-PhysicalLanCandidates).Count -eq $candidates.Count) 'Legacy candidate wrapper must remain inclusive'
    foreach ($good in @('26.33.44.55', '127.0.0.1', '169.254.1.2', '223.255.255.255')) { Assert-Test (Test-LanIPv4 $good) 'Expanded owned IPv4 accepted'
    }
    foreach ($bad in @('0.0.0.0', '0.1.2.3', '224.1.2.3', '255.255.255.255', '192.168.001.1', '192.168.1.256', '::1', "1.2.3.4`n")) { Assert-Test (-not (Test-LanIPv4 $bad)) 'Invalid owned IPv4 rejected' }
    $script:NativeFailure = $true
    $fallback = @(Get-WindowsAdapters)
    Assert-Test ($fallback.Count -eq 12) 'Managed fallback must retain all interfaces'
    Assert-Test (@($fallback | Where-Object { $_.kind -eq 'vpn' -and $_.address -eq '26.33.44.55' -and $_.available }).Count -eq 1) 'Managed fallback preserves Radmin'
    Assert-Test (@($fallback | Where-Object { $_.kind -eq 'loopback' -and $_.available }).Count -eq 1) 'Managed fallback preserves loopback'
    $script:NativeFailure = $false
    $script:NativeAddressFailure = $true
    Assert-Test (@(Get-NetworkCandidates | Where-Object { $_.address -eq '26.33.44.55' }).Count -eq 1) 'Managed unicast union survives NetIPAddress failure'
    $script:NativeAddressFailure = $false
    $script:ManagedFailure = $true
    Assert-Test (@(Get-WindowsAdapters).Count -eq 9) 'Native inventory survives managed source failure'
    $script:NativeFailure = $true
    $failedClosed = $false
    try { [void](Get-WindowsAdapters) } catch { $failedClosed = ($_.Exception.Message -eq 'NETWORK_QUERY_FAILED') }
    Assert-Test $failedClosed 'Both source failures must not look like successful empty inventory'
    Assert-Test ($script:RouteQueries -eq 0) 'Discovery must never query routes or gateways'
    [Console]::Out.Write((@{ ok = $true; assertions = $script:Assertions } | ConvertTo-Json -Compress))
    exit 0
} catch {
    [Console]::Out.Write((@{ ok = $false; assertions = $script:Assertions; fixtureFailure = $_.Exception.Message } | ConvertTo-Json -Compress))
    exit 1
}
