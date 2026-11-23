# Native Windows LAN / certificate helpers

These standalone helpers use **only Node built-ins and native Windows PowerShell 5.1**. No DSH private imports, dependencies, package installation, firewall changes, listeners, service changes, or trust-store installation. Importing the module does not create certificates.

## API

Import the functions from [windows.mjs](../windows.mjs):

```js
import {
  discoverAdapters, discoverNetworks, discoverPhysicalAdapters, selectNetwork,
  ensureAuthority, issueServerIdentity, WindowsHelperError,
} from './v2/windows.mjs';
```

- `await discoverAdapters({ signal } = {})` returns **all** Windows interfaces as `{ interfaceGuid, interfaceAlias, interfaceIndex, kind, status, available, address, prefixLength }[]`. It unions `Get-NetAdapter -IncludeHidden` with `.NET NetworkInterface.GetAllNetworkInterfaces()` on every query, preserving software-only loopback/tunnels as well as virtual, VPN, disconnected, hidden, and no-IPv4 adapters. Either source can serve as fallback if the other is unavailable. GUIDs are lowercase without braces and deduplicated by GUID. `kind` is `wifi | ethernet | virtual | vpn | tunnel | loopback | other`; unknown bounded kind strings normalize to `other`, never remove a row. Aliases/status are control-sanitized and bounded to 1024/100 characters. `interfaceIndex: 0` is the unknown-index inventory sentinel.
- `available` is true for an `Up` interface with a reported IP index and a usable owned canonical unicast IPv4. Public addresses (including Radmin `26.*`), APIPA `169.254.*`, and loopback `127.*` are accepted. Unspecified/zero-net `0/8`, multicast/reserved first octets `>=224`, limited broadcast, noncanonical strings, and non-IPv4 values are rejected. No private-range, physical/hardware/connector, default gateway, winning route, or `SkipAsSource` requirement exists. A normal Preferred address ranks first, but any owned valid IPv4 is a fallback. Unavailable rows retain their GUID/alias/kind/status with `address: null` and `prefixLength: null`. Prefixes include `0..32`; `/32` VPNs remain usable. If Windows exposes an address but no prefix, the helper conservatively uses `/32`.
- `await discoverNetworks({ signal } = {})` retains the candidate shape `{ interfaceGuid, interfaceAlias, interfaceIndex, kind, address, prefixLength }[]`, now for **every kind** of usable `Up` interface. All owned valid IPv4 addresses are retained for runtime/issuance checks, not just the inventory row's preferred address. Ordering: Wi-Fi first, then stable GUID, numeric IP, prefix/index. No usable address returns `[]`, never a wildcard.
- `await discoverPhysicalAdapters({ signal } = {})` is a legacy name for the same complete inventory, with the new `status`, `available`, nullable `address` and nullable `prefixLength` fields. The PowerShell `Get-PhysicalLanAdapters` and `Get-PhysicalLanCandidates` names are also inclusive compatibility wrappers; their names no longer establish physicality. All inventory operations are read-only and do not grant listening/firewall permission.
- `selectNetwork(candidates, { interfaceGuid, address } = {})` returns the deterministic first candidate, or `null` when auto mode finds none. A fixed GUID selects only that adapter and follows its DHCP changes if `address` is omitted. A fixed GUID plus address requires both. An unavailable fixed selection throws `NETWORK_SELECTION_UNAVAILABLE`; it **never** falls back to another NIC. Persist GUID, not a translated or user-renamed alias. No function listens on any address.
- `await ensureAuthority({ stateDir, publicDir, signal })` returns `{ thumbprint, caDer: Buffer, caPem: string, fingerprint256, notAfterISO }`. SHA-1 thumbprints are uppercase unseparated store identifiers, not the security fingerprint. `fingerprint256` is the colon-separated uppercase SHA-256 certificate fingerprint. The public artifact is `publicDir/phone-root-ca.cer`, **DER**, suitable for reviewed manual phone enrollment.
- `await issueServerIdentity({ authorityThumbprint, ipAddresses, signal })` returns `{ pfx: Buffer, passphrase: string, notAfterISO }`, **RAM only**. Pass its result directly to a TLS consumer; never print, persist, attach, include in tool results, or put it in process arguments. Requested SANs must still be usable owned IPv4 addresses on active Windows interfaces of any kind at issuance, verified by the inclusive `Get-NetworkCandidates` path. All requested addresses are encoded as IP SANs, not DNS names. The identity lasts up to 365 days, bounded by the root expiry minus five minutes.

`WindowsHelperError` contains a fixed sanitized `code` and message, never raw PowerShell stderr or private arguments. A `LEAF_CLEANUP_REQUIRED` error additionally contains the nonsecret `operationId` for exact recovery. `parseAdapters`, `parseNetworkCandidates`, the inclusive legacy alias `parsePhysicalAdapters`, and `createWindowsHelpers({ invokePowerShell })` are exported for isolated validation/tests; production should use the default implementations. `runPowerShell` is a low-level, captured-JSON implementation detail: its identity reply is private too.

## Review before the first authority call

**Creating the first root must be a separate, explicitly reviewed action. The test suite never does it.**

Use two distinct absolute local drive paths. Their parent directories must already exist. `stateDir` must be dedicated to this helper: either absent, empty, or containing only `authority.json`. Do not use the workspace root, profile, a gateway configuration folder, or an ancestor of the scripts as `stateDir`.

```js
// Run only after the root-creation review. Do not print the complete helper objects.
const authority = await ensureAuthority({ stateDir, publicDir });
console.log(JSON.stringify({
  thumbprint: authority.thumbprint,
  fingerprint256: authority.fingerprint256,
  notAfterISO: authority.notAfterISO,
}));
// Distribute only publicDir/phone-root-ca.cer and compare the SHA-256 fingerprint.
```

Only a public root certificate and public metadata are returned by this API. No helper imports it into Windows trusted roots or automatically changes phone trust settings. Installing a root on a phone is a separate reviewed action; the phone user should check its fingerprint and purpose first.

### Persistent authority

The root lives in `Cert:\CurrentUser\My`, **not** `LocalMachine` or a trust store. Its RSA-3072 CNG key uses Microsoft Software Key Storage Provider and `KeyExportPolicy=NonExportable`. It has a neutral public subject `CN=Local Phone Root CA` (no DSH name), a unique locally stored friendly ownership tag and key-container ID, seven-year validity, critical CA BasicConstraints/path length zero, and critical CertSign/CRLSign KeyUsage. Existing roots are checked for exact state ownership, subject/purpose, critical CA/KU flags, dates, actual private-key usability, provider/container, and non-exportability. The Node side also verifies the public self-signature, certificate/fingerprint/expiry consistency, and CA status.

`authority.json` contains **only** schema/status, unique friendly ownership tag, key-container identifier, and public thumbprint. Its directory and file get protected NTFS ACLs permitting only the current owner, SYSTEM, and Administrators. ACL changes are confined to that dedicated directory/file; no workspace/profile ACL is changed. Reparse-point paths, non-NTFS state volumes, unrelated existing directory contents, and dangerous ancestors are rejected. Existing public-directory ACLs are not modified; a newly created public directory gets the same narrow ACL. Public files can be served through a separately authorized gateway without loosening filesystem ACLs.

A `creating` marker is durably persisted **before** invoking the PKI cmdlet. Existing incomplete/malformed state, a missing saved certificate/key, or an orphaned previously exported public root requires explicit repair, not automatic replacement. Existing different public DER is not overwritten. An expired/invalid root is not deleted or rotated automatically. A failure after initial root creation retains the protected root and repair marker. Back up the **nonsecret** state file; a non-exportable Windows key cannot be migrated as a private CA backup.

### Ephemeral server identity

A random 256-bit PFX passphrase is generated by Node and sent to PowerShell via **stdin JSON only**. The leaf is RSA-2048, serverAuth-only EKU, critical non-CA BasicConstraints, and DigitalSignature/KeyEncipherment KU. Export uses a memory-only X509 collection with the leaf and a **new public-only root object reconstructed from `RawData`**; the owned root object with its private key is never added. There is no temporary private PFX file.

Before returning success, the helper deletes only the operation's verified exact leaf certificate and key. It checks the exact `Cert:\CurrentUser\My\<thumbprint>` resolved path, non-root thumbprint, operation friendly tag, named CNG key, non-CA purpose, and signature chain to the requested authority. No wildcard or friendly-name-only deletion occurs. A second exact-operation cleanup process runs after the child closes, including after cancellation/timeout, without inheriting an aborted signal. Orphan CNG keys can be deleted only when a persisted custom property exactly identifies the random operation and authority. The root key is never a cleanup target.

The Node wrapper checks SANs, serverAuth, leaf/root signatures/expiry and calls `tls.createSecureContext({ pfx, passphrase })` before returning a usable identity. If native Windows memory export ever uses an OpenSSL-incompatible PBE, it fails closed; no weaker cipher, root export, filesystem fallback, or extra software is introduced automatically.

## Process boundary and time limits

The executable is the absolute `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, with no PATH lookup or shell. It runs `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <fixed-script>`; this execution-policy choice is process-local and does not alter persisted policy. No input data, passphrase, PFX, or private certificate parameters enter argv. PowerShell reads stdin and emits one UTF-8 JSON envelope. Raw stderr is drained but never retained, forwarded, or included in errors. Stdout is captured with a 2 MiB cap; stdin is capped at 64 KiB.

Discovery/inventory: 25 seconds. Authority and leaf operations: 90 seconds. Post-operation cleanup: an additional bounded 25 seconds. Cancellation kills the child and waits for it to close before exact cleanup. Public/root state is fail-closed if interrupted. A hard host crash or key-creation interruption before ownership metadata is persisted can leave an uncertain ephemeral key; it is deliberately **not** broadly deleted. `LEAF_CLEANUP_REQUIRED` calls for targeted human review rather than unsafe cleanup. JavaScript strings cannot be reliably zeroized; buffers are cleared where possible, but passphrases/base64 may survive until GC. Protect the owning Windows account and do not enable subprocess/JSON logging around the low-level runner.

## Validation (no CA creation)

Use the bundled Node executable, not Node/npm from PATH:

```powershell
node --test v2/windows/windows.test.mjs
```

[windows.test.mjs](windows.test.mjs) validates parsers, stable selection, fail-closed fixed selection, native PowerShell 5.1 syntax, all-kind inventory, NetAdapter/.NET union and either-source fallback, public Radmin IPv4, WireGuard `/32`, Hyper-V, software loopback/tunnels, APIPA, zero prefixes, disconnected/no-IPv4/unknown-index rows, unknown kinds, inclusive SAN request addresses, stdin-only random passphrase handling, abort cleanup, sanitized errors, and source safety invariants prohibiting physical/gateway-only discovery. It creates **no certificates/keys/PFX** and opens no servers. Non-Windows environments skip native PS tests. Additional read-only live discovery and isolated owner/SYSTEM/Administrators ACL checks are safe to run separately; actual CA creation, real signing/export compatibility, and TLS serving require the root agent's reviewed integration check.
