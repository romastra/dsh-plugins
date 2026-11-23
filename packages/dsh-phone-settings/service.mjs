import * as nativeFs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAdapterIpv4 } from './networks.mjs';

export const PORT = 63819;
export const STATE_PATH = '/api/phone-access-settings/state';
export const CA_PATH = '/api/phone-access-settings/ca';
export const NETWORKS_PATH = '/api/phone-access-settings/networks';
export const NETWORK_PATH = '/api/phone-access-settings/network';
export const LIMITS = Object.freeze({ status: 16 * 1024, certificate: 64 * 1024, launchUrl: 4096, qr: 512 * 1024 });
export const RESPONSE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const PHASES = new Set(['starting', 'switching', 'ready', 'standby', 'disabled', 'error']);
const FINGERPRINT = /^(?:[0-9a-f]{2}:){31}[0-9a-f]{2}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

class FixedFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new FixedFailure(code); };
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function inside(candidate, parent) {
  const rel = relative(parent, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}
function date(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
function fingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value) ? value.toUpperCase() : null;
}
function empty(state = 'unavailable', errorCode = 'STATUS_UNAVAILABLE') {
  return {
    state, origin: null, address: null, port: PORT, interfaceAlias: null,
    leafNotAfter: null, caFingerprint: null, caNotAfter: null, caAvailable: false,
    errorCode, launchUrl: null, qrDataUrl: null, updatedAt: null,
  };
}
function statusHeader(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2 || !PHASES.has(value.phase)) fail('STATUS_INVALID');
  const updated = date(value.updatedAt);
  if (updated === null || updated > now) fail('STATUS_INVALID');
  return updated;
}
function readyFields(status, now) {
  if (status.port !== PORT || status.closing !== false || !fingerprint(status.caFingerprint256)) fail('STATUS_INVALID');
  const network = status.network;
  if (!network || typeof network !== 'object' || Array.isArray(network) || !isAdapterIpv4(network.address) ||
      typeof network.kind !== 'string' || !network.kind.trim() || network.kind.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(network.kind) || typeof network.interfaceGuid !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(network.interfaceGuid) ||
      !Number.isInteger(network.interfaceIndex) || network.interfaceIndex < 1 || network.interfaceIndex > 2147483647 ||
      !Number.isInteger(network.prefixLength) || network.prefixLength < 0 || network.prefixLength > 32 ||
      typeof network.interfaceAlias !== 'string' || !network.interfaceAlias.trim() || network.interfaceAlias.length > 1024 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(network.interfaceAlias)) fail('STATUS_INVALID');
  const expectedOrigin = `https://${network.address}:${PORT}`;
  if (status.origin !== expectedOrigin) fail('STATUS_INVALID');
  let url;
  try { url = new URL(status.origin); } catch { fail('STATUS_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== network.address || url.port !== String(PORT) ||
      url.origin !== status.origin || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('STATUS_INVALID');
  const expires = date(status.certificateNotAfter);
  if (expires === null) fail('STATUS_INVALID');
  if (expires <= now) fail('CERTIFICATE_EXPIRED');
  return {
    origin: expectedOrigin, address: network.address, interfaceAlias: network.interfaceAlias,
    leafNotAfter: status.certificateNotAfter,
  };
}
async function nativeQr(launchUrl) {
  const { default: qr } = await import('qrcode');
  return qr.toDataURL(launchUrl, { type: 'image/png', errorCorrectionLevel: 'M', margin: 4, width: 560 });
}
function checkLaunch(value, origin) {
  if (typeof value !== 'string' || value.length > LIMITS.launchUrl) fail('LAUNCH_UNAVAILABLE');
  let url;
  try { url = new URL(value); } catch { fail('LAUNCH_UNAVAILABLE'); }
  if (url.origin !== origin || url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].length !== 1 || !url.searchParams.has('token') || !url.searchParams.get('token')) fail('LAUNCH_UNAVAILABLE');
  return value;
}

/** Read-only connection view; a live optional supervisor invalidates retired QR generations.
 * No gateway imports, credential store, persistence, or timers.
 */
export function createPhoneAccessSettings({ connection, config, dependencies = {} }) {
  if (!config || typeof config.outputDir !== 'string' || !isAbsolute(config.outputDir) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(config.outputDir)) ||
      (config.port !== undefined && config.port !== PORT)) fail('SETTINGS_CONFIG_INVALID');
  const outputDir = resolve(config.outputDir);
  const packageDir = resolve(dependencies.packageDir ?? PACKAGE_DIR);
  if (inside(outputDir, packageDir)) fail('SETTINGS_CONFIG_INVALID');
  const fs = dependencies.fs ?? nativeFs;
  const now = dependencies.now ?? Date.now;
  const processStartedAt = dependencies.processStartedAt ?? Date.now() - process.uptime() * 1000;
  const renderQr = dependencies.renderQr ?? nativeQr;
  const getGateway = dependencies.getGateway;
  const isApplying = dependencies.isApplying ?? (() => false);
  function liveMatches(status, gateway, generation) {
    if (!getGateway) return true; // Standalone read-only facade/test compatibility.
    if (isApplying() || !gateway || getGateway() !== gateway) return false;
    const live = gateway.status();
    return live.phase === 'ready' && live.generation === generation && live.origin === status.origin &&
      live.network?.interfaceGuid === status.network?.interfaceGuid && live.network?.address === status.network?.address &&
      live.network?.prefixLength === status.network?.prefixLength;
  }
  if (!Number.isFinite(processStartedAt)) fail('SETTINGS_CONFIG_INVALID');
  let closed = false;
  let closing;
  const pending = new Set();
  const requireOpen = () => { if (closed) fail('SETTINGS_CLOSED'); };
  function owned(operation) {
    const task = Promise.resolve().then(operation);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  }
  async function readPublicFile(name, limit) {
    requireOpen();
    const [root, pkg, directory] = await Promise.all([fs.realpath(outputDir), fs.realpath(packageDir), fs.lstat(outputDir)]);
    requireOpen();
    if (!samePath(root, outputDir) || inside(root, pkg) || !directory.isDirectory() || directory.isSymbolicLink()) fail('FILE_INVALID');
    const path = join(root, name);
    const [canonical, info] = await Promise.all([fs.realpath(path), fs.lstat(path)]);
    requireOpen();
    if (!samePath(canonical, path) || !info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) fail('FILE_INVALID');
    let handle;
    try {
      handle = await fs.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      requireOpen();
      if (!opened.isFile() || opened.size < 1 || opened.size > limit || opened.dev !== info.dev || opened.ino !== info.ino) fail('FILE_INVALID');
      // A growing file cannot cause an unbounded allocation/read, even after the size check.
      const buffer = Buffer.alloc(limit + 1);
      let used = 0;
      while (used < buffer.length) {
        requireOpen();
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      requireOpen();
      if (used === 0 || used > limit) fail('FILE_INVALID');
      return buffer.subarray(0, used);
    } finally {
      if (handle) await handle.close();
    }
  }
  async function readStatus() {
    let bytes;
    try { bytes = await readPublicFile('gateway-status.json', LIMITS.status); }
    catch (error) {
      if (error?.code === 'SETTINGS_CLOSED') throw error;
      fail(error?.code === 'FILE_INVALID' ? 'STATUS_INVALID' : 'STATUS_UNAVAILABLE');
    }
    try { return JSON.parse(UTF8.decode(bytes)); } catch { fail('STATUS_INVALID'); }
  }
  async function publicCertificate(status, at) {
    const expected = fingerprint(status?.caFingerprint256);
    if (!expected) return { ok: false, errorCode: 'CA_UNAVAILABLE' };
    let bytes;
    try { bytes = await readPublicFile('phone-root-ca.cer', LIMITS.certificate); }
    catch (error) {
      if (error?.code === 'SETTINGS_CLOSED') throw error;
      return { ok: false, errorCode: error?.code === 'FILE_INVALID' ? 'CA_INVALID' : 'CA_UNAVAILABLE' };
    }
    try {
      const cert = new X509Certificate(bytes);
      const validFrom = Date.parse(cert.validFrom);
      const validTo = Date.parse(cert.validTo);
      if (!Buffer.from(cert.raw).equals(bytes) || !cert.ca || cert.subject !== cert.issuer || !cert.verify(cert.publicKey) ||
          fingerprint(cert.fingerprint256) !== expected || !Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > at || validTo <= at) {
        return { ok: false, errorCode: 'CA_INVALID' };
      }
      return { ok: true, bytes, caFingerprint: expected, caNotAfter: new Date(validTo).toISOString() };
    } catch { return { ok: false, errorCode: 'CA_INVALID' }; }
  }
  return Object.freeze({
    snapshot() {
      return owned(async () => {
        let result = empty();
        try {
          requireOpen();
          const gateway = getGateway?.();
          const live = gateway?.status();
          const status = await readStatus();
          const at = now();
          const updated = statusHeader(status, at);
          result.updatedAt = status.updatedAt;
          const ca = await publicCertificate(status, at);
          requireOpen();
          if (ca.ok) Object.assign(result, { caFingerprint: ca.caFingerprint, caNotAfter: ca.caNotAfter, caAvailable: true });
          if (updated < processStartedAt) return Object.freeze({ ...result, errorCode: 'STATUS_STALE' });
          if (getGateway && (status.phase === 'ready' || !gateway || isApplying()) && !liveMatches(status, gateway, live?.generation)) {
            const changing = isApplying() || ['starting', 'switching'].includes(live?.phase);
            return Object.freeze({ ...result, state: changing ? 'starting' : 'inactive',
              errorCode: changing ? 'GATEWAY_STARTING' : 'GATEWAY_INACTIVE' });
          }
          if (status.phase !== 'ready') {
            const [state, errorCode] = status.phase === 'error' ? ['error', 'GATEWAY_ERROR'] :
              ['starting', 'switching'].includes(status.phase) ? ['starting', 'GATEWAY_STARTING'] : ['inactive', 'GATEWAY_INACTIVE'];
            return Object.freeze({ ...result, state, errorCode });
          }
          Object.assign(result, readyFields(status, at));
          if (!ca.ok) fail(ca.errorCode);
          if (Date.parse(result.leafNotAfter) > Date.parse(ca.caNotAfter)) fail('STATUS_INVALID');
          let launchUrl;
          try { launchUrl = checkLaunch(connection.authenticatedUrl(result.origin + '/'), result.origin); }
          catch { fail('LAUNCH_UNAVAILABLE'); }
          let qrDataUrl;
          try { qrDataUrl = await renderQr(launchUrl); } catch { fail('QR_UNAVAILABLE'); }
          if (typeof qrDataUrl !== 'string' || qrDataUrl.length > LIMITS.qr || !PNG_DATA_URL.test(qrDataUrl)) fail('QR_UNAVAILABLE');
          requireOpen();
          if (!liveMatches(status, gateway, live?.generation)) {
            return Object.freeze({ ...empty('starting', 'GATEWAY_STARTING'),
              caFingerprint: result.caFingerprint, caNotAfter: result.caNotAfter, caAvailable: result.caAvailable });
          }
          return Object.freeze({ ...result, state: 'ready', errorCode: null, launchUrl, qrDataUrl });
        } catch (error) {
          if (closed) return Object.freeze(empty('unavailable', 'SETTINGS_CLOSED'));
          const codes = new Set(['STATUS_INVALID', 'STATUS_UNAVAILABLE', 'CERTIFICATE_EXPIRED', 'CA_INVALID', 'CA_UNAVAILABLE', 'LAUNCH_UNAVAILABLE', 'QR_UNAVAILABLE']);
          const code = codes.has(error?.code) ? error.code : 'INTERNAL_ERROR';
          return Object.freeze({ ...result, state: code === 'STATUS_UNAVAILABLE' ? 'unavailable' : 'error', errorCode: code, launchUrl: null, qrDataUrl: null });
        }
      });
    },
    certificate() {
      return owned(async () => {
        try {
          requireOpen();
          const status = await readStatus();
          const at = now();
          statusHeader(status, at);
          const ca = await publicCertificate(status, at);
          requireOpen();
          return ca.ok ? { ok: true, bytes: ca.bytes } : { ok: false, errorCode: ca.errorCode };
        } catch (error) {
          return { ok: false, errorCode: closed ? 'SETTINGS_CLOSED' : 'CA_UNAVAILABLE' };
        }
      });
    },
    close() {
      closed = true;
      return closing ??= Promise.allSettled([...pending]).then(() => {});
    },
  });
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...RESPONSE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
});

/** Exact native Connection routes only; no public WebServer route or independent authentication. */
export function createPhoneAccessSettingsRoutes(connection, facade, networks, { getCarrierOrigin } = {}) {
  function admitBrowser(request, path, method = 'GET') {
    // Core admits the /api request and checks owner before invoking an exact route.
    // Re-admission narrows that owner to the native browser Peer: API owner credentials
    // must never be upgraded to the browser's reusable launch token.
    let admission;
    try { admission = connection.admit({ headers: request.headers }); }
    catch { return json({ errorCode: 'FORBIDDEN' }, 403); }
    if ('rejection' in admission) return json({ errorCode: admission.rejection === 401 ? 'AUTH_REQUIRED' : 'FORBIDDEN' }, admission.rejection === 401 ? 401 : 403);
    if (admission.peer.id !== connection.browserPeer.id || admission.peer.principal.kind !== 'owner' || admission.peer.signal.aborted) return json({ errorCode: 'FORBIDDEN' }, 403);
    if (request.method !== method) return json({ errorCode: 'METHOD_NOT_ALLOWED' }, 405);
    let url;
    try { url = new URL(request.url); } catch { return json({ errorCode: 'REQUEST_INVALID' }, 400); }
    if (url.pathname !== path || url.search || url.hash) return json({ errorCode: 'REQUEST_INVALID' }, 400);
    if (request.signal.aborted) return json({ errorCode: 'REQUEST_ABORTED' }, 409);
    if (method === 'POST') {
      // Native owner admission is not CSRF protection. Mutation requires exact
      // same-origin Origin and a non-simple JSON content type, with no CORS.
      let expectedOrigin = url.origin;
      if (getCarrierOrigin) {
        try {
          // DSH's HTTP bridge deliberately uses http://dsh.internal in
          // Request.url. The admitted Host header retains the real carrier;
          // the HTTPS phone gateway canonicalizes both Host and Origin to it.
          const protocol = new URL(getCarrierOrigin()).protocol;
          const host = request.headers.get('host');
          if (!['http:', 'https:'].includes(protocol) || !host || /[\s/@\\?#]/.test(host)) throw new Error('Invalid carrier');
          expectedOrigin = `${protocol}//${host}`;
          if (new URL(expectedOrigin).origin !== expectedOrigin) throw new Error('Invalid carrier');
        } catch { return json({ errorCode: 'FORBIDDEN' }, 403); }
      }
      if (request.headers.get('origin') !== expectedOrigin ||
          (request.headers.has('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'same-origin')) {
        return json({ errorCode: 'FORBIDDEN' }, 403);
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) {
        return json({ errorCode: 'REQUEST_INVALID' }, 415);
      }
    }
    return null;
  }
  return [
    {
      path: STATE_PATH, methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        const rejection = admitBrowser(request, STATE_PATH);
        if (rejection) return rejection;
        try {
          const snapshot = await facade.snapshot();
          const lateRejection = admitBrowser(request, STATE_PATH);
          return lateRejection ?? json(snapshot);
        } catch { return json({ errorCode: 'INTERNAL_ERROR' }, 503); }
      },
    },
    {
      path: CA_PATH, methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        const rejection = admitBrowser(request, CA_PATH);
        if (rejection) return rejection;
        try {
          const result = await facade.certificate();
          const lateRejection = admitBrowser(request, CA_PATH);
          if (lateRejection) return lateRejection;
          if (!result.ok) return json({ errorCode: result.errorCode }, result.errorCode === 'CA_UNAVAILABLE' ? 404 : 503);
          return new Response(new Uint8Array(result.bytes), {
            status: 200,
            headers: { ...RESPONSE_HEADERS, 'Content-Type': 'application/pkix-cert', 'Content-Disposition': 'attachment; filename="phone-root-ca.cer"' },
          });
        } catch { return json({ errorCode: 'INTERNAL_ERROR' }, 503); }
      },
    },
    ...(networks ? [
      {
        path: NETWORKS_PATH, methods: ['GET'], requestBody: 'buffered',
        async fetch(request) {
          const rejection = admitBrowser(request, NETWORKS_PATH);
          if (rejection) return rejection;
          try {
            const result = await networks.networks();
            return admitBrowser(request, NETWORKS_PATH) ?? json(result);
          } catch { return json({ errorCode: 'NETWORK_QUERY_FAILED' }, 503); }
        },
      },
      {
        path: NETWORK_PATH, methods: ['POST'], requestBody: 'streaming',
        async fetch(request) {
          const rejection = admitBrowser(request, NETWORK_PATH, 'POST');
          if (rejection) return rejection;
          // Enforce a small streaming read even if Content-Length was omitted
          // or lied about. Do not materialize a general request body as text.
          const length = request.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > 1024)) return json({ errorCode: 'REQUEST_INVALID' }, 413);
          let reader;
          try {
            reader = request.body?.getReader();
            let size = 0;
            const chunks = [];
            if (reader) while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 1024) { await reader.cancel(); return json({ errorCode: 'REQUEST_INVALID' }, 413); }
              chunks.push(value);
            }
            let input;
            try { input = JSON.parse(UTF8.decode(Buffer.concat(chunks))); }
            catch { return json({ errorCode: 'REQUEST_INVALID' }, 400); }
            if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
                typeof input.interfaceGuid !== 'string' || (input.interfaceGuid !== '' &&
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.interfaceGuid))) {
              return json({ errorCode: 'NETWORK_SELECTION_INVALID' }, 400);
            }
            const beforeCommit = admitBrowser(request, NETWORK_PATH, 'POST');
            if (beforeCommit) return beforeCommit;
            const result = await networks.selectNetwork(input.interfaceGuid, { signal: request.signal });
            return admitBrowser(request, NETWORK_PATH, 'POST') ?? json(result, result.errorCode === 'NETWORK_SELECTION_BUSY' ? 409 : 200);
          } catch { return json({ errorCode: 'GATEWAY_SETUP_FAILED' }, 503); }
          finally { reader?.releaseLock(); }
        },
      },
    ] : []),
  ];
}
