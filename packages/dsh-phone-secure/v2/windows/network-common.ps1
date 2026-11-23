# Inclusive, read-only Windows inventory. Classification is display metadata, never eligibility.
function Get-NetworkProperty {
    param($Object, [string]$Name, $Default = $null)
    try {
        if ($null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    } catch { }
    return $Default
}
function ConvertTo-NetworkText {
    param($Value, [int]$Limit, [string]$Fallback)
    $text = ([string]$Value -replace '[\x00-\x1f\x7f-\x9f\u200e\u200f\u2028-\u202e\u2066-\u2069]', ' ').Trim()
    if ($text.Length -gt $Limit) { $text = $text.Substring(0, $Limit).Trim() }
    if ([string]::IsNullOrEmpty($text)) { return $Fallback }
    return $text
}
function ConvertTo-NetworkGuid {
    param($Value)
    $guid = [Guid]::Empty
    if ([Guid]::TryParse([string]$Value, [ref]$guid)) { return $guid.ToString('D').ToLowerInvariant() }
    return $null
}
function ConvertTo-NetworkIndex {
    param($Value)
    $index = 0
    if ([int]::TryParse([string]$Value, [ref]$index) -and $index -gt 0) { return $index }
    return 0
}
function Get-NetworkKind {
    param([int]$Type, [bool]$Virtual, [string]$Description)
    if ($Type -eq 24) { return 'loopback' }
    if ($Type -eq 23 -or $Description -match '(?i)(\bvpn\b|radmin|wireguard|wintun|openvpn|\btap[- ])') { return 'vpn' }
    if ($Type -eq 131) { return 'tunnel' }
    if ($Virtual -or $Type -eq 53 -or $Description -match '(?i)(virtual|hyper-v|vethernet|vmware|vbox)') { return 'virtual' }
    if ($Type -eq 71) { return 'wifi' }
    if (@(6, 26, 62, 69, 117) -contains $Type) { return 'ethernet' }
    return 'other'
}
function Get-WindowsNetworkInterfaces {
    # NetAdapter omits some software loopback/tunnel interfaces. Always union this source.
    return [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()
}
function Get-NetworkPrefix {
    param($Value, $Mask = $null)
    $prefix = -1
    if ($null -ne $Value -and [int]::TryParse([string]$Value, [ref]$prefix) -and $prefix -ge 0 -and $prefix -le 32) { return $prefix }
    if ($null -ne $Mask) {
        try {
            $prefix = 0
            $zeroSeen = $false
            foreach ($octet in $Mask.GetAddressBytes()) {
                for ($bit = 7; $bit -ge 0; $bit--) {
                    if (($octet -band (1 -shl $bit)) -ne 0) {
                        if ($zeroSeen) { return 32 }
                        $prefix++
                    } else { $zeroSeen = $true }
                }
            }
            if ($Mask.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) { return $prefix }
        } catch { }
    }
    # An owned address without exposed prefix metadata is conservatively host-sized.
    return 32
}
function Add-NetworkAddress {
    param($Adapter, $Address, [int]$PrefixLength, $State, $SkipAsSource, [switch]$Native)
    if (-not (Test-LanIPv4 $Address)) { return }
    $rank = 2
    if ([string]$State -eq 'Preferred') { $rank = 0 }
    if ($SkipAsSource -eq $true) { $rank++ }
    $existing = $Adapter.addresses[$Address]
    if ($null -ne $existing -and -not $Native -and $existing.rank -le $rank) { return }
    $Adapter.addresses[$Address] = [PSCustomObject]@{ address = $Address; prefixLength = $PrefixLength; rank = $rank }
}
function Get-WindowsNetworkState {
    $byGuid = @{}
    $nativeAdapters = @()
    $managedAdapters = @()
    $nativeSucceeded = $false
    $managedSucceeded = $false
    try {
        $nativeAdapters = @(Get-NetAdapter -IncludeHidden -ErrorAction Stop)
        $nativeSucceeded = $true
    } catch { }
    try {
        $managedAdapters = @(Get-WindowsNetworkInterfaces)
        $managedSucceeded = $true
    } catch { }
    if (-not $nativeSucceeded -and -not $managedSucceeded) { Stop-Helper 'NETWORK_QUERY_FAILED' }
    foreach ($adapter in $nativeAdapters) {
        $guid = ConvertTo-NetworkGuid (Get-NetworkProperty $adapter 'InterfaceGuid')
        if ($null -eq $guid) { continue }
        $type = ConvertTo-NetworkIndex (Get-NetworkProperty $adapter 'InterfaceType' 0)
        $description = [string](Get-NetworkProperty $adapter 'InterfaceDescription' '') + ' ' + [string](Get-NetworkProperty $adapter 'DriverDescription' '')
        $byGuid[$guid] = [PSCustomObject]@{
            interfaceGuid = $guid
            interfaceAlias = ConvertTo-NetworkText (Get-NetworkProperty $adapter 'Name' '') 1024 $guid
            interfaceIndex = ConvertTo-NetworkIndex (Get-NetworkProperty $adapter 'ifIndex' (Get-NetworkProperty $adapter 'InterfaceIndex' 0))
            kind = Get-NetworkKind $type ((Get-NetworkProperty $adapter 'Virtual' $false) -eq $true) $description
            status = ConvertTo-NetworkText (Get-NetworkProperty $adapter 'Status' '') 100 'Unknown'
            addresses = @{}
            native = $true
        }
    }
    foreach ($networkInterface in $managedAdapters) {
        $guid = ConvertTo-NetworkGuid (Get-NetworkProperty $networkInterface 'Id')
        if ($null -eq $guid) { continue }
        $properties = $null
        $index = 0
        try { $properties = $networkInterface.GetIPProperties() } catch { }
        if ($null -ne $properties) {
            try { $index = ConvertTo-NetworkIndex $properties.GetIPv4Properties().Index } catch { }
            if ($index -eq 0) { try { $index = ConvertTo-NetworkIndex $properties.GetIPv6Properties().Index } catch { } }
        }
        $kind = Get-NetworkKind ([int](Get-NetworkProperty $networkInterface 'NetworkInterfaceType' 0)) $false ([string](Get-NetworkProperty $networkInterface 'Description' ''))
        if (-not $byGuid.ContainsKey($guid)) {
            $byGuid[$guid] = [PSCustomObject]@{
                interfaceGuid = $guid
                interfaceAlias = ConvertTo-NetworkText (Get-NetworkProperty $networkInterface 'Name' '') 1024 $guid
                interfaceIndex = $index
                kind = $kind
                status = ConvertTo-NetworkText (Get-NetworkProperty $networkInterface 'OperationalStatus' '') 100 'Unknown'
                addresses = @{}
                native = $false
            }
        } else {
            if ($byGuid[$guid].interfaceIndex -eq 0) { $byGuid[$guid].interfaceIndex = $index }
            if ($byGuid[$guid].kind -eq 'other' -or @('loopback', 'vpn', 'tunnel') -contains $kind) { $byGuid[$guid].kind = $kind }
            if ($byGuid[$guid].status -eq 'Unknown') { $byGuid[$guid].status = ConvertTo-NetworkText (Get-NetworkProperty $networkInterface 'OperationalStatus' '') 100 'Unknown' }
        }
        if ($null -eq $properties) { continue }
        foreach ($ip in @(Get-NetworkProperty $properties 'UnicastAddresses' @())) {
            $address = [string](Get-NetworkProperty $ip 'Address' '')
            $prefix = Get-NetworkPrefix (Get-NetworkProperty $ip 'PrefixLength') (Get-NetworkProperty $ip 'IPv4Mask')
            Add-NetworkAddress $byGuid[$guid] $address $prefix (Get-NetworkProperty $ip 'DuplicateAddressDetectionState' '') $false
        }
    }
    # ActiveStore is only an address source. No routes, gateway, private range or source flag gate.
    $nativeAddresses = @()
    try { $nativeAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -PolicyStore ActiveStore -ErrorAction Stop) } catch { }
    $byIndex = @{}
    foreach ($adapter in $byGuid.Values) {
        if ($adapter.interfaceIndex -gt 0) { $byIndex[$adapter.interfaceIndex] = $adapter }
    }
    foreach ($ip in $nativeAddresses) {
        $index = ConvertTo-NetworkIndex (Get-NetworkProperty $ip 'InterfaceIndex' 0)
        if ($index -eq 0 -or -not $byIndex.ContainsKey($index)) { continue }
        $address = [string](Get-NetworkProperty $ip 'IPAddress' '')
        $prefix = Get-NetworkPrefix (Get-NetworkProperty $ip 'PrefixLength')
        Add-NetworkAddress $byIndex[$index] $address $prefix (Get-NetworkProperty $ip 'AddressState' '') (Get-NetworkProperty $ip 'SkipAsSource' $false) -Native
    }
    return @($byGuid.Values | Sort-Object interfaceGuid)
}
function Get-SortedNetworkAddresses {
    param($Adapter)
    return @($Adapter.addresses.Values | Sort-Object rank, @{ Expression = {
        $octets = $_.address.Split('.')
        return ([long]$octets[0] * 16777216 + [long]$octets[1] * 65536 + [long]$octets[2] * 256 + [long]$octets[3])
    } }, prefixLength)
}
function Get-WindowsAdapters {
    $result = @()
    foreach ($adapter in @(Get-WindowsNetworkState)) {
        $address = $null
        $prefix = $null
        if ($adapter.status -eq 'Up' -and $adapter.interfaceIndex -gt 0) {
            $addresses = @(Get-SortedNetworkAddresses $adapter)
            if ($addresses.Count -gt 0) { $address = $addresses[0].address; $prefix = $addresses[0].prefixLength }
        }
        $result += [PSCustomObject]@{
            interfaceGuid = $adapter.interfaceGuid
            interfaceAlias = $adapter.interfaceAlias
            interfaceIndex = $adapter.interfaceIndex
            kind = $adapter.kind
            status = $adapter.status
            available = ($null -ne $address)
            address = $address
            prefixLength = $prefix
        }
    }
    return $result
}
function Get-NetworkCandidates {
    $result = @()
    foreach ($adapter in @(Get-WindowsNetworkState)) {
        if ($adapter.status -ne 'Up' -or $adapter.interfaceIndex -eq 0) { continue }
        foreach ($ip in @(Get-SortedNetworkAddresses $adapter)) {
            $result += [PSCustomObject]@{
                interfaceGuid = $adapter.interfaceGuid
                interfaceAlias = $adapter.interfaceAlias
                interfaceIndex = $adapter.interfaceIndex
                kind = $adapter.kind
                address = $ip.address
                prefixLength = $ip.prefixLength
            }
        }
    }
    return $result
}
# Legacy names remain inclusive so older callers do not silently retain physical-only selection.
function Get-PhysicalLanAdapters { return @(Get-WindowsAdapters) }
function Get-PhysicalLanCandidates { return @(Get-NetworkCandidates) }
