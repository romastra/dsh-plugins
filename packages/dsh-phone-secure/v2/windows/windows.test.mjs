import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createWindowsHelpers, discoverAdapters, parseAdapters, parseNetworkCandidates, parsePhysicalAdapters, selectNetwork, WindowsHelperError } from '../windows.mjs';

const here = fileURLToPath(new URL('./', import.meta.url));
const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const candidate = (overrides = {}) => ({ interfaceGuid: guid(1), interfaceAlias: 'Wi-Fi', interfaceIndex: 21, kind: 'wifi', address: '192.168.1.10', prefixLength: 24, ...overrides });
const adapter = (overrides = {}) => ({ ...candidate(), status: 'Up', available: true, ...overrides });
const throwsCode = (fn, code) => assert.throws(fn, (error) => error instanceof WindowsHelperError && error.code === code);
const rejectsCode = async (promise, code) => assert.rejects(promise, (error) => error instanceof WindowsHelperError && error.code === code);

// Deliberately no certificates/keys/PFX fixtures are created by this suite.
test('candidates normalize GUIDs and prefer Wi-Fi, then stable GUID/numeric IP across all kinds', () => {
  const result = parseNetworkCandidates([
    candidate({ interfaceGuid: guid(3), kind: 'ethernet' }),
    candidate({ interfaceGuid: guid(2), address: '192.168.1.2' }),
    candidate({ interfaceGuid: `{${guid(1)}}`, address: '192.168.1.100', interfaceAlias: 'renamed-VPN-but-physical' }),
    candidate({ address: '192.168.1.9' }),
  ]);
  assert.deepEqual(result.map((entry) => [entry.kind, entry.interfaceGuid, entry.address]), [
    ['wifi', guid(1), '192.168.1.9'], ['wifi', guid(1), '192.168.1.100'], ['wifi', guid(2), '192.168.1.2'], ['ethernet', guid(3), '192.168.1.10'],
  ]);
});
test('empty result remains an array and auto selection does not invent a wildcard', () => {
  assert.deepEqual(parseNetworkCandidates([]), []);
  assert.equal(selectNetwork([]), null);
});
test('network parser fails closed on malformed or unsafe values', () => {
  for (const address of ['0.0.0.0', '0.1.2.3', '224.1.2.3', '255.255.255.255', '192.168.1.256', '192.168.01.2', '::1', '1.2.3', '1.2.3.4\n']) {
    throwsCode(() => parseNetworkCandidates([candidate({ address })]), 'HELPER_PROTOCOL');
  }
  for (const patch of [{ prefixLength: -1 }, { prefixLength: 33 }, { interfaceIndex: -1 }, { interfaceGuid: '*' }, { interfaceAlias: '' }, { interfaceAlias: 'x'.repeat(1025) }, { kind: null }, { kind: 'x'.repeat(101) }]) {
    throwsCode(() => parseNetworkCandidates([candidate(patch)]), 'HELPER_PROTOCOL');
  }
  for (const value of [null, {}, [null], [candidate(), candidate()]]) throwsCode(() => parseNetworkCandidates(value), 'HELPER_PROTOCOL');
});
test('fixed GUID follows DHCP only when no exact address is configured', () => {
  const networks = [candidate(), candidate({ kind: 'ethernet', interfaceGuid: guid(2), address: '10.0.0.2' })];
  assert.equal(selectNetwork(networks, { interfaceGuid: guid(2) }).address, '10.0.0.2');
  assert.equal(selectNetwork(networks, { interfaceGuid: guid(1), address: '192.168.1.10' }).kind, 'wifi');
  throwsCode(() => selectNetwork(networks, { interfaceGuid: guid(3) }), 'NETWORK_SELECTION_UNAVAILABLE');
  throwsCode(() => selectNetwork(networks, { interfaceGuid: guid(1), address: '192.168.1.11' }), 'NETWORK_SELECTION_UNAVAILABLE');
  throwsCode(() => selectNetwork(networks, { address: '192.168.1.10' }), 'INVALID_INPUT');
});
test('candidate fixtures include Radmin public IPv4, WireGuard /32, Hyper-V, APIPA, loopback and /0', () => {
  const fixtures = [
    candidate({ interfaceGuid: guid(1), interfaceAlias: 'Radmin VPN', kind: 'vpn', address: '26.33.44.55', prefixLength: 8 }),
    candidate({ interfaceGuid: guid(2), interfaceAlias: 'WireGuard', kind: 'vpn', address: '10.8.0.2', prefixLength: 32 }),
    candidate({ interfaceGuid: guid(3), interfaceAlias: 'vEthernet (Hyper-V)', kind: 'virtual', address: '172.20.16.1', prefixLength: 20 }),
    candidate({ interfaceGuid: guid(4), kind: 'loopback', address: '127.0.0.1', prefixLength: 8 }),
    candidate({ interfaceGuid: guid(5), kind: 'ethernet', address: '169.254.2.3', prefixLength: 16 }),
    candidate({ interfaceGuid: guid(6), kind: 'tunnel', address: '203.0.113.5', prefixLength: 0 }),
    candidate({ interfaceGuid: guid(7), kind: 'future-kind', address: '223.255.255.255', prefixLength: 0 }),
  ];
  const result = parseNetworkCandidates(fixtures);
  assert.equal(result.length, fixtures.length);
  assert.deepEqual(result.map((entry) => entry.address), fixtures.map((entry) => entry.address));
  assert.equal(result.at(-1).kind, 'other');
  for (const kind of ['', ' ', '\u0000unrecognized', 'x'.repeat(100)]) {
    assert.equal(parseNetworkCandidates([candidate({ kind })])[0].kind, 'other');
    assert.equal(parseAdapters([adapter({ kind })])[0].kind, 'other');
  }
  assert.equal(selectNetwork(fixtures, { interfaceGuid: guid(1) }).address, '26.33.44.55');
});
test('complete inventory retains all kinds, disconnected and no-IPv4 rows; legacy parser is inclusive', () => {
  const fixtures = [
    adapter({ interfaceGuid: guid(1), kind: 'vpn', interfaceAlias: 'Radmin VPN', address: '26.33.44.55', prefixLength: 8 }),
    adapter({ interfaceGuid: guid(2), kind: 'virtual', interfaceAlias: 'Hyper-V', address: '172.20.16.1', prefixLength: 20 }),
    adapter({ interfaceGuid: guid(3), status: 'Disconnected', available: false, address: null, prefixLength: null }),
    adapter({ interfaceGuid: guid(4), kind: 'other', status: 'Up', available: false, address: null, prefixLength: null }),
    adapter({ interfaceGuid: `{${guid(5)}}`, kind: 'loopback', address: '127.0.0.1', prefixLength: 8 }),
    adapter({ interfaceGuid: guid(6), kind: 'unrecognized metadata', status: 'Down', available: false, address: null, prefixLength: null, interfaceIndex: 0 }),
    adapter({ interfaceGuid: guid(7), kind: 'tunnel', address: '169.254.3.4', prefixLength: 0 }),
  ];
  const rows = parseAdapters(fixtures);
  assert.equal(rows.length, 7);
  assert.equal(rows.find((entry) => entry.interfaceGuid === guid(5)).address, '127.0.0.1');
  assert.equal(rows.find((entry) => entry.interfaceGuid === guid(6)).kind, 'other');
  assert.equal(rows.filter((entry) => !entry.available && entry.address === null && entry.prefixLength === null).length, 3);
  assert.deepEqual(parsePhysicalAdapters(fixtures), rows);
  throwsCode(() => parseAdapters([fixtures[0], fixtures[0]]), 'HELPER_PROTOCOL');
});
test('inventory requires coherent status/availability and bounded sanitized display strings', () => {
  const [clean] = parseAdapters([adapter({ interfaceAlias: 'VPN\n\u0000\u202ealias', status: '\tUp\n', kind: 'VPN' })]);
  assert.equal(clean.interfaceAlias, 'VPN   alias');
  assert.equal(clean.status, 'Up');
  assert.equal(clean.kind, 'vpn');
  assert.equal(clean.available, true);
  for (const patch of [
    { available: undefined }, { status: undefined }, { status: 'x'.repeat(101) },
    { available: false }, { status: 'Down' }, { interfaceIndex: 0 }, { address: '0.1.2.3' },
    { address: null }, { prefixLength: null }, { prefixLength: undefined }, { prefixLength: -1 }, { prefixLength: 33 },
    { address: null, prefixLength: null }, { address: null, prefixLength: 0 },
    { available: false, address: null, prefixLength: 24 },
  ]) throwsCode(() => parseAdapters([adapter(patch)]), 'HELPER_PROTOCOL');
  assert.deepEqual(parseAdapters([]), []);
});
test('discovery passes cancellation and bounded timing to the captured JSON protocol', async () => {
  const controller = new AbortController();
  const calls = [];
  const api = createWindowsHelpers({ invokePowerShell: async (...args) => { calls.push(args); return []; } });
  assert.equal(typeof discoverAdapters, 'function');
  assert.deepEqual(await api.discoverAdapters({ signal: controller.signal }), []);
  assert.deepEqual(await api.discoverNetworks({ signal: controller.signal }), []);
  assert.deepEqual(await api.discoverPhysicalAdapters(), []);
  assert.deepEqual(calls[0].slice(0, 2), ['discover-adapters.ps1', {}]);
  assert.equal(calls[0][2].signal, controller.signal);
  assert.equal(calls[0][2].timeoutMs, 25_000);
  assert.equal(calls[1][0], 'discover-networks.ps1');
  assert.equal(calls[2][0], 'discover-physical-adapters.ps1');
});
test('authority rejects unsafe or overlapping paths before invocation', async () => {
  let calls = 0;
  const api = createWindowsHelpers({ invokePowerShell: async () => { calls++; return {}; } });
  for (const [stateDir, publicDir] of [['relative', 'C:\\public'], ['C:\\state', 'C:\\state'], ['C:\\state', 'C:\\state\\public'], ['C:\\public\\state', 'C:\\public'], ['\\\\server\\state', 'C:\\public']]) {
    await rejectsCode(api.ensureAuthority({ stateDir, publicDir }), 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});
test('authority parser rejects non-certificate or forged public metadata', async () => {
  const api = createWindowsHelpers({ invokePowerShell: async () => ({ thumbprint: 'A'.repeat(40), caDerBase64: Buffer.from('not-a-certificate').toString('base64'), fingerprint256: '00', notAfterISO: '2099-01-01' }) });
  await rejectsCode(api.ensureAuthority({ stateDir: 'C:\\unit-state', publicDir: 'C:\\unit-public' }), 'HELPER_PROTOCOL');
});
test('invalid or pre-cancelled identity requests never invoke PowerShell', async () => {
  let calls = 0;
  const api = createWindowsHelpers({ invokePowerShell: async () => { calls++; return {}; } });
  const controller = new AbortController();
  controller.abort();
  await rejectsCode(api.issueServerIdentity({ authorityThumbprint: 'A'.repeat(40), ipAddresses: ['192.168.1.10'], signal: controller.signal }), 'HELPER_ABORTED');
  for (const patch of [{ authorityThumbprint: '*' }, { ipAddresses: [] }, { ipAddresses: ['0.0.0.0'] }, { ipAddresses: ['224.1.2.3'] }, { ipAddresses: ['192.168.1.10', '192.168.1.10'] }]) {
    await rejectsCode(api.issueServerIdentity({ authorityThumbprint: 'A'.repeat(40), ipAddresses: ['192.168.1.10'], ...patch }), 'INVALID_INPUT');
  }
  assert.equal(calls, 0);
});
test('candidate addresses of all kinds reach the certificate SAN request without creating keys', async () => {
  const candidates = parseNetworkCandidates([
    candidate({ interfaceGuid: guid(1), kind: 'vpn', address: '26.33.44.55', prefixLength: 8 }),
    candidate({ interfaceGuid: guid(2), kind: 'vpn', address: '10.8.0.2', prefixLength: 32 }),
    candidate({ interfaceGuid: guid(3), kind: 'virtual', address: '172.20.16.1', prefixLength: 20 }),
    candidate({ interfaceGuid: guid(4), kind: 'loopback', address: '127.0.0.1', prefixLength: 8 }),
    candidate({ interfaceGuid: guid(5), kind: 'other', address: '169.254.3.4', prefixLength: 0 }),
  ]);
  const calls = [];
  const api = createWindowsHelpers({ invokePowerShell: async (script, input) => {
    calls.push([script, input]);
    if (script === 'issue-server-identity.ps1') throw new WindowsHelperError('IP_ADDRESS_UNAVAILABLE');
    return { cleaned: true };
  } });
  await rejectsCode(api.issueServerIdentity({ authorityThumbprint: 'A'.repeat(40), ipAddresses: candidates.map((entry) => entry.address) }), 'IP_ADDRESS_UNAVAILABLE');
  assert.deepEqual(new Set(calls[0][1].ipAddresses), new Set(candidates.map((entry) => entry.address)));
  assert.equal(calls[0][0], 'issue-server-identity.ps1');
  assert.equal(calls[1][0], 'cleanup-leaf.ps1');
});
test('identity uses fresh stdin-only random passphrases and cleanup despite an aborted operation', async () => {
  const controller = new AbortController();
  const calls = [];
  const api = createWindowsHelpers({ invokePowerShell: async (...args) => {
    calls.push(args);
    if (args[0] === 'issue-server-identity.ps1') { controller.abort(); throw new Error(`private:${args[1].passphrase}`); }
    return { cleaned: true };
  } });
  await assert.rejects(api.issueServerIdentity({ authorityThumbprint: 'a'.repeat(40), ipAddresses: ['192.168.1.10'], signal: controller.signal }), (error) => {
    assert.equal(error.code, 'CERTIFICATE_OPERATION_FAILED');
    assert.ok(!error.stack.includes(calls[0][1].passphrase));
    return true;
  });
  assert.match(calls[0][1].passphrase, /^[A-Za-z0-9_-]{43}$/);
  assert.match(calls[0][1].operationId, /^[a-f0-9]{32}$/);
  assert.equal(calls[0][1].authorityThumbprint, 'A'.repeat(40));
  assert.equal(calls[1][0], 'cleanup-leaf.ps1');
  assert.equal(calls[1][1].operationId, calls[0][1].operationId);
  assert.equal(calls[1][2].signal, undefined);
  assert.equal(calls[1][1].passphrase, undefined);
});
test('cleanup failure withholds identity and exposes only a public recovery identifier', async () => {
  let operationId;
  const api = createWindowsHelpers({ invokePowerShell: async (script, input) => {
    operationId ??= input.operationId;
    if (script === 'cleanup-leaf.ps1') throw new Error('hidden');
    return { pfxBase64: 'never-returned' };
  } });
  await assert.rejects(api.issueServerIdentity({ authorityThumbprint: 'A'.repeat(40), ipAddresses: ['192.168.1.10'] }), (error) => {
    assert.equal(error.code, 'LEAF_CLEANUP_REQUIRED');
    assert.equal(error.operationId, operationId);
    assert.ok(!error.stack.includes('never-returned'));
    return true;
  });
});
test('source safety invariants: no root-key export, trust installation, PFX files, or noisy output', () => {
  const root = readFileSync(path.join(here, 'ensure-authority.ps1'), 'utf8');
  const issue = readFileSync(path.join(here, 'issue-server-identity.ps1'), 'utf8');
  const common = readFileSync(path.join(here, 'common.ps1'), 'utf8');
  const wrapper = readFileSync(path.join(here, '..', 'windows.mjs'), 'utf8');
  assert.match(root, /KeyExportPolicy = 'NonExportable'/);
  assert.match(root, /NotAfter = \$now\.AddYears\(7\)/);
  assert.match(root, /Write-StateRecord \$statePath \$saved -Create/);
  assert.match(root, /Get-ExactStoreCertificate \$thumbprint 'AUTHORITY_REPAIR_REQUIRED'/);
  assert.match(issue, /X509Certificate2\]::new\(\[byte\[\]\]\$authority\.RawData\)/);
  assert.match(issue, /\$collection\.Add\(\$publicRoot\)/);
  assert.doesNotMatch(issue, /\$collection\.Add\(\$authority\)/);
  assert.match(common, /Resolve-Path -LiteralPath \$target/);
  assert.match(common, /Remove-Item -LiteralPath \$target -DeleteKey/);
  for (const name of readdirSync(here).filter((entry) => entry.endsWith('.ps1') && !entry.startsWith('test-'))) {
    const source = readFileSync(path.join(here, name));
    assert.ok(source.every((byte) => byte < 128), `${name} must remain ASCII-safe for PowerShell 5.1`);
    const text = source.toString('ascii');
    assert.doesNotMatch(text, /Import-Certificate|Import-PfxCertificate|LocalMachine\\|CurrentUser\\Root|Write-Host|Write-Output|Write-Error|Export-PfxCertificate/i);
    assert.doesNotMatch(text, /\.pfx['"]/i);
  }
  assert.doesNotMatch(wrapper, /from ['"]@deepseek|console\.(log|error)|shell: true/);
  assert.match(wrapper, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(wrapper, /'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'/);
});
test('source discovery and issuance have no physical, gateway, source-flag, or private-only gates', () => {
  const network = readFileSync(path.join(here, 'network-common.ps1'), 'utf8');
  const discover = readFileSync(path.join(here, 'discover-adapters.ps1'), 'utf8');
  const candidates = readFileSync(path.join(here, 'discover-networks.ps1'), 'utf8');
  const issue = readFileSync(path.join(here, 'issue-server-identity.ps1'), 'utf8');
  const wrapper = readFileSync(path.join(here, '..', 'windows.mjs'), 'utf8');
  assert.match(network, /Get-NetAdapter -IncludeHidden -ErrorAction Stop/);
  assert.match(network, /\[System\.Net\.NetworkInformation\.NetworkInterface\]::GetAllNetworkInterfaces\(\)/);
  assert.doesNotMatch(network, /Get-NetAdapter[^\r\n]*-Physical|HardwareInterface|ConnectorPresent|Get-NetRoute|DefaultGateway|IPv4DefaultGateway/);
  assert.doesNotMatch(network, /if[^\r\n]*(?:Virtual|Description|SkipAsSource)[^\r\n]*\bcontinue\b/);
  assert.doesNotMatch(network, /AddressState[^\r\n]*-ne[^\r\n]*Preferred|SkipAsSource[^\r\n]*-ne[^\r\n]*false/);
  assert.match(discover, /Write-HelperResult @\(Get-WindowsAdapters\)/);
  assert.match(candidates, /Write-HelperResult @\(Get-NetworkCandidates\)/);
  assert.match(issue, /\$available = @\(Get-NetworkCandidates\)/);
  assert.doesNotMatch(issue, /Get-PhysicalLanCandidates|Get-NetAdapter|Get-NetRoute/);
  assert.match(issue, /'IPAddress=' \+ \$_/);
  assert.match(wrapper, /\['discover-adapters\.ps1', 'discover-networks\.ps1'/);
});
test('all native PowerShell 5.1 files parse without execution', { skip: process.platform !== 'win32' }, () => {
  const executable = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = "$bad=$false; Get-ChildItem -LiteralPath $args[0] -Filter *.ps1 | ForEach-Object { $tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$errors); if($errors.Count){$bad=$true} }; if($bad){exit 1}; [Console]::Out.Write('parsed')";
  // -Command's trailing argument is embedded as a quoted literal to avoid PowerShell's
  // command-line string interpretation. This is a test-owned public path, never private data.
  const command = source.replace('$args[0]', `'${here.replaceAll("'", "''")}'`);
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
  assert.equal(result.status, 0, 'PowerShell AST parsing failed');
  assert.equal(result.stdout, 'parsed');
  assert.equal(result.stderr, '');
});
test('native PowerShell union/fallback fixtures retain all adapter kinds, addresses and down inventory', { skip: process.platform !== 'win32' }, () => {
  const executable = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'test-network.ps1')], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
  assert.equal(result.status, 0, `Read-only inclusive adapter fixture validation failed: ${result.stdout || result.stderr}`);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.assertions >= 60, 'Expected full native union/fallback fixture coverage');
});
