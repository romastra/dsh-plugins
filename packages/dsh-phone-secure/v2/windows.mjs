import { spawn } from 'node:child_process';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSecureContext } from 'node:tls';

const SCRIPTS = fileURLToPath(new URL('./windows/', import.meta.url));
const MAX_OUTPUT = 2 * 1024 * 1024;
const MESSAGES = Object.freeze({
  INVALID_INPUT: 'Invalid Windows helper input.',
  WINDOWS_REQUIRED: 'These helpers require native Windows PowerShell 5.1.',
  HELPER_FAILED: 'The Windows helper failed; private diagnostics were suppressed.',
  HELPER_PROTOCOL: 'The Windows helper returned an invalid response.',
  HELPER_TIMEOUT: 'The Windows helper exceeded its bounded execution time.',
  HELPER_ABORTED: 'The Windows helper was cancelled.',
  NETWORK_QUERY_FAILED: 'Windows could not query network interfaces.',
  NETWORK_SELECTION_UNAVAILABLE: 'The configured network interface or address is not available.',
  AUTHORITY_REPAIR_REQUIRED: 'Existing authority state needs repair; no replacement root was created.',
  AUTHORITY_INVALID: 'The saved certificate is not a usable owned, non-exportable local authority.',
  AUTHORITY_EXPIRING: 'The existing authority is expired or too close to expiry; explicit repair is required.',
  PRIVATE_STATE_UNSAFE: 'The private state directory could not be safely isolated with an NTFS ACL.',
  PUBLIC_DIRECTORY_UNSAFE: 'The public certificate directory or file is unsafe.',
  PUBLIC_CA_MISMATCH: 'The existing public certificate differs from the saved authority; review is required.',
  CERTIFICATE_OPERATION_FAILED: 'The Windows certificate operation failed; private diagnostics were suppressed.',
  IP_ADDRESS_UNAVAILABLE: 'A requested SAN address is not a usable IPv4 address on an active Windows interface.',
  OPERATION_ID_COLLISION: 'The ephemeral identity operation identifier already exists.',
  LEAF_CLEANUP_REQUIRED: 'An ephemeral identity could not be safely cleaned up; review its operationId.',
});

export class WindowsHelperError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? MESSAGES.HELPER_FAILED);
    this.name = 'WindowsHelperError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'HELPER_FAILED';
  }
}
const fail = (code = 'HELPER_PROTOCOL') => { throw new WindowsHelperError(code); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const thumbPattern = /^[0-9a-f]{40}$/i;

function ipv4Number(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  // Canonical owned IPv4, not a private-LAN policy: public, APIPA and loopback are valid.
  if (parts.some((part) => part > 255) || parts.join('.') !== value || parts[0] === 0 || parts[0] >= 224) return null;
  return parts.reduce((total, part) => total * 256 + part, 0);
}
function canonicalGuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string') fail(code);
  const normalized = value.replace(/^\{(.*)\}$/, '$1').toLowerCase();
  if (!guidPattern.test(normalized)) fail(code);
  return normalized;
}
function compareCandidates(a, b) {
  return (a.kind === 'wifi' ? 0 : 1) - (b.kind === 'wifi' ? 0 : 1)
    || (a.interfaceGuid < b.interfaceGuid ? -1 : a.interfaceGuid > b.interfaceGuid ? 1 : 0)
    || ipv4Number(a.address) - ipv4Number(b.address)
    || a.prefixLength - b.prefixLength || a.interfaceIndex - b.interfaceIndex;
}

const adapterKinds = new Set(['wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other']);
const unsafeDisplayCharacters = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
function displayText(value, maxLength, fallback) {
  if (typeof value !== 'string' || !value.length || value.length > maxLength) fail();
  return value.replace(unsafeDisplayCharacters, ' ').trim() || fallback;
}
function adapterIdentity(entry) {
  if (!object(entry) || !Number.isSafeInteger(entry.interfaceIndex) || entry.interfaceIndex < 0
    || typeof entry.kind !== 'string' || entry.kind.length > 100) fail();
  const interfaceGuid = canonicalGuid(entry.interfaceGuid, 'HELPER_PROTOCOL');
  const kind = entry.kind.trim().toLowerCase();
  return {
    interfaceGuid,
    interfaceAlias: displayText(entry.interfaceAlias, 1024, interfaceGuid),
    // Zero means Windows exposed no IP interface index; it never hides an inventory row.
    interfaceIndex: entry.interfaceIndex,
    kind: adapterKinds.has(kind) ? kind : 'other',
  };
}
const prefixLengthValid = (value) => Number.isInteger(value) && value >= 0 && value <= 32;

/** Validate owned unicast IPv4 candidates from every interface kind, without LAN policy. */
export function parseNetworkCandidates(value) {
  if (!Array.isArray(value) || value.length > 16384) fail();
  const seen = new Set();
  const result = value.map((entry) => {
    const identity = adapterIdentity(entry);
    if (!prefixLengthValid(entry.prefixLength) || ipv4Number(entry.address) === null) fail();
    const candidate = { ...identity, address: entry.address, prefixLength: entry.prefixLength };
    const key = `${candidate.interfaceGuid}/${candidate.address}`;
    if (seen.has(key)) fail();
    seen.add(key);
    return candidate;
  });
  return result.sort(compareCandidates);
}

/** Complete adapter inventory, including disconnected interfaces and interfaces without IPv4. */
export function parseAdapters(value) {
  if (!Array.isArray(value) || value.length > 4096) fail();
  const seen = new Set();
  return value.map((entry) => {
    const identity = adapterIdentity(entry);
    const status = displayText(entry.status, 100, 'Unknown');
    if (typeof entry.available !== 'boolean'
      || (entry.address !== null && ipv4Number(entry.address) === null)
      || (entry.prefixLength !== null && !prefixLengthValid(entry.prefixLength))
      || (entry.address === null) !== (entry.prefixLength === null)) fail();
    const available = status.toLowerCase() === 'up' && identity.interfaceIndex > 0
      && entry.address !== null && prefixLengthValid(entry.prefixLength);
    if (entry.available !== available || (!available && (entry.address !== null || entry.prefixLength !== null))) fail();
    if (seen.has(identity.interfaceGuid)) fail();
    seen.add(identity.interfaceGuid);
    return { ...identity, status, available, address: entry.address, prefixLength: entry.prefixLength };
  }).sort((a, b) => (a.kind === 'wifi' ? 0 : 1) - (b.kind === 'wifi' ? 0 : 1)
    || (a.interfaceGuid < b.interfaceGuid ? -1 : a.interfaceGuid > b.interfaceGuid ? 1 : 0));
}

/** Legacy name retained for callers; inventory is intentionally no longer physical-only. */
export const parsePhysicalAdapters = parseAdapters;

/** With a GUID, fail closed if the fixed selection disappears; an omitted address follows its DHCP changes. */
export function selectNetwork(candidates, { interfaceGuid, address } = {}) {
  const validated = parseNetworkCandidates(candidates);
  if (interfaceGuid === undefined) {
    if (address !== undefined) fail('INVALID_INPUT');
    return validated[0] ?? null;
  }
  const guid = canonicalGuid(interfaceGuid);
  if (address !== undefined && ipv4Number(address) === null) fail('INVALID_INPUT');
  const selected = validated.find((entry) => entry.interfaceGuid === guid && (address === undefined || entry.address === address));
  if (!selected) fail('NETWORK_SELECTION_UNAVAILABLE');
  return selected;
}

function decodeBase64(value, maxBytes) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maxBytes / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const buffer = Buffer.from(value, 'base64');
  if (!buffer.length || buffer.length > maxBytes || buffer.toString('base64') !== value) fail();
  return buffer;
}
function isoDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail();
  return new Date(value).toISOString();
}
function parsePublicAuthority(result) {
  if (!object(result) || !thumbPattern.test(result.thumbprint ?? '')) fail();
  const caDer = decodeBase64(result.caDerBase64, 128 * 1024);
  let certificate;
  try { certificate = new X509Certificate(caDer); } catch { fail(); }
  const thumbprint = createHash('sha1').update(caDer).digest('hex').toUpperCase();
  const notAfterISO = new Date(certificate.validTo).toISOString();
  if (thumbprint !== result.thumbprint.toUpperCase() || !certificate.ca
    || certificate.subject !== 'CN=Local Phone Root CA' || !certificate.checkIssued(certificate)
    || !certificate.verify(certificate.publicKey) || Date.parse(certificate.validFrom) > Date.now()
    || Date.parse(notAfterISO) <= Date.now() || isoDate(result.notAfterISO) !== notAfterISO
    || result.fingerprint256 !== certificate.fingerprint256) fail();
  return { thumbprint, caDer, caPem: certificate.toString(), fingerprint256: certificate.fingerprint256, notAfterISO };
}
function parseIdentity(result, passphrase, ipAddresses, authorityThumbprint) {
  if (!object(result)) fail();
  const authority = parsePublicAuthority(result.authority);
  if (authority.thumbprint !== authorityThumbprint) fail();
  const pfx = decodeBase64(result.pfxBase64, 1024 * 1024);
  try {
    const leaf = new X509Certificate(decodeBase64(result.leafDerBase64, 128 * 1024));
    const ca = new X509Certificate(authority.caDer);
    const notAfterISO = isoDate(result.notAfterISO);
    const sans = leaf.subjectAltName?.split(', ').map((entry) => entry.startsWith('IP Address:') ? entry.slice(11) : '') ?? [];
    if (leaf.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)
      || !leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1') || Date.parse(leaf.validFrom) > Date.now()
      || new Date(leaf.validTo).toISOString() !== notAfterISO || Date.parse(notAfterISO) <= Date.now()
      || Date.parse(notAfterISO) > Date.parse(authority.notAfterISO)
      || sans.length !== ipAddresses.length || !ipAddresses.every((ip) => sans.includes(ip) && leaf.checkIP(ip) === ip)) fail();
    // Import in memory only, checking that Windows exported a usable encrypted private identity.
    createSecureContext({ pfx, passphrase });
    return { pfx, passphrase, notAfterISO };
  } catch {
    pfx.fill(0);
    fail();
  }
}
function absoluteDirectory(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || value.includes('\0') || value.length > 240) fail('INVALID_INPUT');
  return path.win32.resolve(value);
}

/** No shell, PATH lookup, private argv, inherited stdio, or raw PowerShell errors. */
export function runPowerShell(script, input, { signal, timeoutMs = 90_000 } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new WindowsHelperError('WINDOWS_REQUIRED'));
  if (!['discover-adapters.ps1', 'discover-networks.ps1', 'discover-physical-adapters.ps1', 'ensure-authority.ps1', 'issue-server-identity.ps1', 'cleanup-leaf.ps1'].includes(script)) return Promise.reject(new WindowsHelperError('INVALID_INPUT'));
  if (signal?.aborted) return Promise.reject(new WindowsHelperError('HELPER_ABORTED'));
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (typeof systemRoot !== 'string' || !/^[a-z]:\\[^\0]*$/i.test(systemRoot)) return Promise.reject(new WindowsHelperError('WINDOWS_REQUIRED'));
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const payload = Buffer.from(JSON.stringify(input), 'utf8');
  if (payload.length > 64 * 1024) { payload.fill(0); return Promise.reject(new WindowsHelperError('INVALID_INPUT')); }
  return new Promise((resolve, reject) => {
    let child;
    let chunks = [];
    let outputBytes = 0;
    let pendingError;
    let settled = false;
    let timer;
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      payload.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      chunks = [];
    };
    const stop = (code) => {
      pendingError ??= new WindowsHelperError(code);
      if (child?.pid) child.kill();
    };
    const abort = () => stop('HELPER_ABORTED');
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      let raw;
      try {
        if (pendingError) throw pendingError;
        raw = Buffer.concat(chunks);
        let reply;
        try { reply = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail(); }
        if (!object(reply) || reply.version !== 1 || typeof reply.ok !== 'boolean') fail();
        if (!reply.ok) fail(Object.hasOwn(MESSAGES, reply.error?.code) ? reply.error.code : 'HELPER_FAILED');
        if (exitCode !== 0) fail('HELPER_FAILED');
        resolve(reply.result);
      } catch (error) {
        reject(error instanceof WindowsHelperError ? error : new WindowsHelperError('HELPER_FAILED'));
      } finally { raw?.fill(0); release(); }
    };
    try {
      child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, script)], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.on('error', () => { pendingError ??= new WindowsHelperError('HELPER_FAILED'); if (!child.pid) finish(null); });
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT) { chunk.fill(0); stop('HELPER_PROTOCOL'); } else chunks.push(chunk);
      });
      // Drain without retaining or forwarding diagnostics: PKI exceptions may contain private arguments.
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { pendingError ??= new WindowsHelperError('HELPER_FAILED'); });
      child.on('close', finish);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => stop('HELPER_TIMEOUT'), Math.min(Math.max(timeoutMs, 1), 120_000));
      if (signal?.aborted) abort();
      child.stdin.end(payload, () => payload.fill(0));
    } catch { pendingError = new WindowsHelperError('HELPER_FAILED'); finish(null); }
  });
}

/** Dependency injection is for tests; production uses the private captured PowerShell protocol above. */
export function createWindowsHelpers({ invokePowerShell = runPowerShell } = {}) {
  return {
    async discoverAdapters({ signal } = {}) {
      return parseAdapters(await invokePowerShell('discover-adapters.ps1', {}, { signal, timeoutMs: 25_000 }));
    },
    async discoverPhysicalAdapters({ signal } = {}) {
      return parsePhysicalAdapters(await invokePowerShell('discover-physical-adapters.ps1', {}, { signal, timeoutMs: 25_000 }));
    },
    async discoverNetworks({ signal } = {}) {
      return parseNetworkCandidates(await invokePowerShell('discover-networks.ps1', {}, { signal, timeoutMs: 25_000 }));
    },
    async ensureAuthority({ stateDir, publicDir, signal } = {}) {
      const privatePath = absoluteDirectory(stateDir);
      const publicPath = absoluteDirectory(publicDir);
      const a = privatePath.toLowerCase();
      const b = publicPath.toLowerCase();
      if (a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`)) fail('INVALID_INPUT');
      return parsePublicAuthority(await invokePowerShell('ensure-authority.ps1', { stateDir: privatePath, publicDir: publicPath }, { signal, timeoutMs: 90_000 }));
    },
    async issueServerIdentity({ authorityThumbprint, ipAddresses, signal } = {}) {
      if (typeof authorityThumbprint !== 'string' || !thumbPattern.test(authorityThumbprint)
        || !Array.isArray(ipAddresses) || !ipAddresses.length || ipAddresses.length > 16
        || ipAddresses.some((ip) => ipv4Number(ip) === null) || new Set(ipAddresses).size !== ipAddresses.length) fail('INVALID_INPUT');
      if (signal?.aborted) fail('HELPER_ABORTED');
      const thumbprint = authorityThumbprint.toUpperCase();
      const addresses = [...ipAddresses].sort((a, b) => ipv4Number(a) - ipv4Number(b));
      const operationId = randomBytes(16).toString('hex');
      const passphrase = randomBytes(32).toString('base64url');
      let result;
      let operationError;
      try {
        result = await invokePowerShell('issue-server-identity.ps1', { authorityThumbprint: thumbprint, ipAddresses: addresses, passphrase, operationId }, { signal, timeoutMs: 90_000 });
      } catch (error) {
        operationError = error instanceof WindowsHelperError ? error : new WindowsHelperError('CERTIFICATE_OPERATION_FAILED');
      }
      // Also runs after a killed/timed-out child, only after it has closed. Never pass the aborted signal.
      try {
        await invokePowerShell('cleanup-leaf.ps1', { authorityThumbprint: thumbprint, operationId }, { timeoutMs: 25_000 });
      } catch {
        const error = new WindowsHelperError('LEAF_CLEANUP_REQUIRED');
        error.operationId = operationId; // Public recovery identifier; never a key or passphrase.
        throw error;
      }
      if (operationError) throw operationError;
      return parseIdentity(result, passphrase, addresses, thumbprint);
    },
  };
}

const defaultHelpers = createWindowsHelpers();
export const discoverAdapters = defaultHelpers.discoverAdapters;
export const discoverPhysicalAdapters = defaultHelpers.discoverPhysicalAdapters;
export const discoverNetworks = defaultHelpers.discoverNetworks;
export const ensureAuthority = defaultHelpers.ensureAuthority;
export const issueServerIdentity = defaultHelpers.issueServerIdentity;
