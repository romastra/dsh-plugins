import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPhoneAccessSettings, createPhoneAccessSettingsRoutes, STATE_PATH, CA_PATH, NETWORKS_PATH, NETWORK_PATH, PORT, LIMITS } from '../service.mjs';
import { apply, inject } from '../index.js';

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PACKAGE, '..', 'fictional-phone-settings-data');
// Public DER only; no test fixture contains a key, PFX, real launch URL, or cookie.
const PUBLIC_DER = await readFile(new URL('./fixtures/public-root.cer', import.meta.url));
const PUBLIC_CERT = new X509Certificate(PUBLIC_DER);
const NOW = Date.parse('2026-11-14T02:00:00.000Z');
const START = NOW - 120_000;
const QR_FIXTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGrsAAAAASUVORK5CYII=';
const DTO_KEYS = ['state', 'origin', 'address', 'port', 'interfaceAlias', 'leafNotAfter', 'caFingerprint', 'caNotAfter', 'caAvailable', 'errorCode', 'launchUrl', 'qrDataUrl', 'updatedAt'].sort();
function status(extra = {}) {
  return {
    version: 2, phase: 'ready', port: PORT, origin: `https://192.168.45.8:${PORT}`,
    network: { address: '192.168.45.8', kind: 'wifi', interfaceGuid: '12345678-abcd-1234-abcd-123456789abc', interfaceAlias: 'Physical Wi-Fi', interfaceIndex: 7, prefixLength: 24 },
    certificateNotAfter: '2027-11-13T22:31:08.000Z', caFingerprint256: PUBLIC_CERT.fingerprint256,
    closing: false, updatedAt: new Date(NOW - 1_000).toISOString(), ...extra,
  };
}
const nodeInfo = (directory, size = 0, ino = 1, symbolic = false) => ({
  size, dev: 1, ino, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => symbolic,
});
function fakeFs(initialStatus, options = {}) {
  const files = new Map([
    ['gateway-status.json', Buffer.isBuffer(initialStatus) ? initialStatus : Buffer.from(JSON.stringify(initialStatus))],
    ['phone-root-ca.cer', options.der ?? PUBLIC_DER],
  ]);
  for (const key of options.missing ?? []) files.delete(key);
  const events = { opened: [], closed: 0, readBytes: 0 };
  const info = path => nodeInfo(path === ROOT || path === PACKAGE, files.get(basename(path))?.length ?? 0, basename(path) === 'phone-root-ca.cer' ? 2 : 1, options.symlink === basename(path));
  const requireFile = path => { if (!files.has(basename(path))) throw Object.assign(new Error('fictional unavailable file'), { code: 'ENOENT' }); };
  return {
    files, events,
    async realpath(path) {
      if (path !== ROOT && path !== PACKAGE) requireFile(path);
      return options.alias === basename(path) ? join(PACKAGE, 'unexpected') : path;
    },
    async lstat(path) {
      if (path !== ROOT && path !== PACKAGE) requireFile(path);
      return info(path);
    },
    async open(path) {
      requireFile(path);
      events.opened.push(basename(path));
      const data = options.grow === basename(path) ? Buffer.alloc(LIMITS.status + 100, 65) : files.get(basename(path));
      let offset = 0;
      let didClose = false;
      return {
        async stat() { return options.replace === basename(path) ? { ...info(path), ino: 999 } : info(path); },
        async read(buffer, start, length) {
          if (options.readGate) await options.readGate;
          const bytesRead = Math.min(length, data.length - offset);
          if (bytesRead > 0) data.copy(buffer, start, offset, offset + bytesRead);
          offset += bytesRead; events.readBytes += bytesRead;
          return { bytesRead, buffer };
        },
        async close() { if (!didClose) { didClose = true; events.closed += 1; } },
      };
    },
  };
}
function setup(value = status(), options = {}) {
  const fs = fakeFs(value, options);
  const calls = { launch: 0, qr: 0 };
  const connection = {
    authenticatedUrl(base) {
      calls.launch += 1;
      if (options.launchThrow) throw new Error('fictional private diagnostic');
      return options.launchValue ?? base + '?token=fictional-unit-test-value';
    },
  };
  const facade = createPhoneAccessSettings({
    connection, config: { outputDir: ROOT, port: PORT },
    dependencies: {
      fs, now: () => options.now ?? NOW, processStartedAt: options.start ?? START, packageDir: PACKAGE,
      async renderQr() {
        calls.qr += 1;
        if (options.qrGate) await options.qrGate;
        if (options.qrThrow) throw new Error('fictional private diagnostic');
        return options.qrValue ?? QR_FIXTURE;
      },
    },
  });
  return { facade, fs, calls };
}
async function noLaunch(facade, expectedCode) {
  const value = await facade.snapshot();
  assert.equal(value.errorCode, expectedCode);
  assert.ok(value.state !== 'ready');
  assert.ok(value.launchUrl === null && value.qrDataUrl === null, 'non-ready state contains no launch material');
  return value;
}

test('fresh ready metadata yields one stable DTO and in-memory QR from native launch URL', async () => {
  const { facade, calls, fs } = setup();
  const value = await facade.snapshot();
  assert.equal(value.state, 'ready');
  assert.equal(value.errorCode, null);
  assert.deepEqual(Object.keys(value).sort(), DTO_KEYS);
  assert.equal(value.port, PORT);
  assert.equal(value.origin, status().origin);
  assert.equal(value.caAvailable, true);
  assert.equal(value.caNotAfter, new Date(PUBLIC_CERT.validTo).toISOString());
  assert.ok(typeof value.launchUrl === 'string' && new URL(value.launchUrl).searchParams.has('token'), 'native launch material exists only in ready result');
  assert.ok(value.qrDataUrl === QR_FIXTURE, 'QR renderer result is returned without persistence');
  assert.deepEqual(calls, { launch: 1, qr: 1 });
  assert.deepEqual(fs.events.opened, ['gateway-status.json', 'phone-root-ca.cer']);
  assert.equal(fs.events.closed, 2);
  assert.equal(Object.isFrozen(value), true);
  await facade.close();
});

test('default pinned QR renderer produces a bounded PNG data URI without writing files', async () => {
  const fs = fakeFs(status());
  const facade = createPhoneAccessSettings({
    connection: { authenticatedUrl: base => base + '?token=fictional-unit-test-value' },
    config: { outputDir: ROOT, port: PORT },
    dependencies: { fs, packageDir: PACKAGE, now: () => NOW, processStartedAt: START },
  });
  const value = await facade.snapshot();
  assert.equal(value.state, 'ready');
  assert.ok(typeof value.qrDataUrl === 'string' && value.qrDataUrl.startsWith('data:image/png;base64,') && value.qrDataUrl.length <= LIMITS.qr);
  const png = Buffer.from(value.qrDataUrl.split(',', 2)[1], 'base64');
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'RAM renderer produces PNG bytes');
  assert.deepEqual(fs.events.opened, ['gateway-status.json', 'phone-root-ca.cer']);
  await facade.close();
});

test('prior-process status cannot claim ready or generate launch material', async () => {
  const { facade, calls } = setup(status({ updatedAt: new Date(START - 1).toISOString() }));
  const value = await noLaunch(facade, 'STATUS_STALE');
  assert.equal(value.state, 'unavailable');
  assert.equal(value.origin, null);
  assert.equal(value.caAvailable, true);
  assert.deepEqual(calls, { launch: 0, qr: 0 });
  await facade.close();
});

test('inactive, starting and error phases are sanitized and never generate launch material', async () => {
  for (const [phase, state, code] of [
    ['disabled', 'inactive', 'GATEWAY_INACTIVE'], ['standby', 'inactive', 'GATEWAY_INACTIVE'],
    ['starting', 'starting', 'GATEWAY_STARTING'], ['switching', 'starting', 'GATEWAY_STARTING'], ['error', 'error', 'GATEWAY_ERROR'],
  ]) {
    const { facade, calls } = setup(status({ phase, errorCode: 'arbitrary diagnostic not reflected', diagnostic: { token: 'fictional-ignored-value' } }));
    const value = await noLaunch(facade, code);
    assert.equal(value.state, state);
    assert.equal(value.origin, null);
    assert.deepEqual(Object.keys(value).sort(), DTO_KEYS);
    assert.deepEqual(calls, { launch: 0, qr: 0 });
    await facade.close();
  }
});

test('strict origin, canonical unicast IPv4, fixed port, phase, version and dates are required', async () => {
  const invalid = [
    { version: 1 }, { version: '2' }, { phase: 'unknown' }, { port: 443 }, { port: '63819' }, { closing: true }, { closing: undefined },
    { origin: 'http://192.168.45.8:63819' }, { origin: 'https://192.168.45.8:63819/' },
    { origin: 'https://192.168.45.8:63819/path' }, { origin: 'https://192.168.45.8:63819?token=fictional-ignored' },
    { origin: 'https://192.168.45.8:63819#ignored' }, { origin: 'https://owner@192.168.45.8:63819' },
    { origin: 'https://192.168.45.9:63819' }, { origin: 'https://example.invalid:63819' },
    { certificateNotAfter: 'not-a-date' }, { certificateNotAfter: '2027-02-30T00:00:00.000Z' },
    { updatedAt: '2026-11-14T01:59:59+00:00' }, { updatedAt: new Date(NOW + 1).toISOString() },
    ...['0.0.0.0', '224.1.2.3', '255.255.255.255', '192.168.045.8', '0xc0a82d08', '3232247048', '192.168.45.256', '::1'].map(address => ({ origin: `https://${address}:${PORT}`, network: { ...status().network, address } })),
    { network: { ...status().network, kind: 'unsafe\nkind' } }, { network: { ...status().network, interfaceAlias: 'unsafe\ntext' } },
    { network: { ...status().network, prefixLength: -1 } }, { network: { ...status().network, interfaceIndex: 0 } },
  ];
  for (const patch of invalid) {
    const { facade, calls } = setup(status(patch));
    await noLaunch(facade, 'STATUS_INVALID');
    assert.deepEqual(calls, { launch: 0, qr: 0 });
    await facade.close();
  }
  const { facade, calls } = setup(status({ certificateNotAfter: new Date(NOW).toISOString() }));
  await noLaunch(facade, 'CERTIFICATE_EXPIRED');
  assert.equal(calls.launch, 0);
  await facade.close();
});

test('valid address changes are derived from current status, never a fixed LAN address', async () => {
  for (const address of ['26.1.2.3', '8.8.8.8', '127.0.0.1', '169.254.1.1', '172.15.2.3', '100.63.255.1', '100.128.0.1', '10.4.5.6', '172.16.1.3', '172.31.254.8', '192.168.77.9', '100.64.0.1', '100.127.255.254']) {
    const { facade } = setup(status({ origin: `https://${address}:${PORT}`, network: { ...status().network, address } }));
    const value = await facade.snapshot();
    assert.equal(value.state, 'ready');
    assert.equal(value.address, address);
    await facade.close();
  }
});

test('missing, truncated, malformed, oversized or growing status fails closed with bounded reads', async () => {
  const cases = [
    [status(), { missing: ['gateway-status.json'] }, 'STATUS_UNAVAILABLE'],
    [Buffer.from('{'), {}, 'STATUS_INVALID'], [Buffer.from([0xff]), {}, 'STATUS_INVALID'],
    [Buffer.alloc(LIMITS.status + 1), {}, 'STATUS_INVALID'],
    [status(), { grow: 'gateway-status.json' }, 'STATUS_INVALID'],
    [status(), { replace: 'gateway-status.json' }, 'STATUS_INVALID'],
    [status(), { symlink: 'gateway-status.json' }, 'STATUS_INVALID'],
    [status(), { alias: 'gateway-status.json' }, 'STATUS_INVALID'],
  ];
  for (const [value, options, code] of cases) {
    const { facade, fs, calls } = setup(value, options);
    await noLaunch(facade, code);
    assert.ok(fs.events.readBytes <= LIMITS.status + 1);
    assert.equal(fs.events.closed, fs.events.opened.length);
    assert.equal(calls.launch, 0);
    await facade.close();
  }
});

test('certificate must be exact bounded public DER matching metadata fingerprint and validity', async () => {
  const cases = [
    [status(), { missing: ['phone-root-ca.cer'] }, 'CA_UNAVAILABLE'],
    [status(), { der: Buffer.from('not a DER certificate') }, 'CA_INVALID'],
    [status(), { der: Buffer.concat([PUBLIC_DER, Buffer.from('trailing')]) }, 'CA_INVALID'],
    [status(), { der: Buffer.from(PUBLIC_CERT.toString()) }, 'CA_INVALID'],
    [status(), { der: Buffer.alloc(LIMITS.certificate + 1) }, 'CA_INVALID'],
    [status({ caFingerprint256: '00:'.repeat(31) + '00' }), {}, 'CA_INVALID'],
    [status(), { symlink: 'phone-root-ca.cer' }, 'CA_INVALID'],
    [status(), { alias: 'phone-root-ca.cer' }, 'CA_INVALID'],
  ];
  for (const [value, options, code] of cases) {
    const { facade, calls } = setup(value, options);
    const snapshot = await noLaunch(facade, code);
    assert.equal(snapshot.caAvailable, false);
    assert.equal((await facade.certificate()).ok, false);
    assert.equal(calls.launch, 0);
    await facade.close();
  }
  const future = Date.parse('2034-01-01T00:00:00.000Z');
  const { facade } = setup(status({ updatedAt: new Date(future - 1).toISOString(), certificateNotAfter: '2034-02-01T00:00:00.000Z' }), { now: future });
  await noLaunch(facade, 'CA_INVALID');
  await facade.close();
});

test('certificate download uses same verified canonical file and does not generate a launch', async () => {
  const { facade, calls, fs } = setup(status({ phase: 'standby' }));
  const result = await facade.certificate();
  assert.equal(result.ok, true);
  assert.ok(result.bytes.equals(PUBLIC_DER), 'download is exact public DER fixture');
  assert.deepEqual(calls, { launch: 0, qr: 0 });
  assert.deepEqual(fs.events.opened, ['gateway-status.json', 'phone-root-ca.cer']);
  await facade.close();
});

test('native launch or QR failures are fixed-code responses without diagnostic reflection', async () => {
  for (const options of [
    { launchThrow: true }, { launchValue: 'https://example.invalid/?token=fictional-unit-test-value' },
    { launchValue: status().origin + '/?token=fictional-unit-test-value&extra=bad' },
    { launchValue: status().origin + '/?token=fictional-unit-test-value#bad' },
    { launchValue: status().origin + '/?token=' },
  ]) {
    const { facade, calls } = setup(status(), options);
    await noLaunch(facade, 'LAUNCH_UNAVAILABLE');
    assert.equal(calls.qr, 0);
    await facade.close();
  }
  for (const options of [{ qrThrow: true }, { qrValue: 'https://example.invalid/image' }, { qrValue: 'data:image/svg+xml;base64,AAAA' }, { qrValue: 'data:image/png;base64,' + 'A'.repeat(LIMITS.qr) }]) {
    const { facade } = setup(status(), options);
    await noLaunch(facade, 'QR_UNAVAILABLE');
    await facade.close();
  }
});

function browserConnection(mode = 'browser') {
  const browser = { id: 'fictional-browser', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const api = { ...browser, id: 'fictional-api-owner', interactions: 'none' };
  const controller = new AbortController(); controller.abort();
  return {
    browserPeer: browser,
    admit({ headers }) {
      assert.ok(headers instanceof Headers);
      if (mode === 'unauthenticated') return { rejection: 401 };
      if (mode === 'untrusted') return { rejection: 403 };
      if (mode === 'throw') throw new Error('fictional private diagnostic');
      if (mode === 'api') return { peer: api };
      if (mode === 'aborted') return { peer: { ...browser, signal: controller.signal } };
      if (mode === 'non-owner') return { peer: { ...browser, principal: { kind: 'other' } } };
      return { peer: browser };
    },
  };
}
function securityHeaders(response) {
  assert.ok(response.headers.get('cache-control')?.includes('no-store'));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
}

test('both exact native GET routes require actual native browser Peer, not an API owner Peer', async () => {
  for (const mode of ['unauthenticated', 'untrusted', 'api', 'aborted', 'non-owner', 'throw']) {
    let called = 0;
    const facade = { async snapshot() { called += 1; }, async certificate() { called += 1; } };
    const routes = createPhoneAccessSettingsRoutes(browserConnection(mode), facade);
    assert.deepEqual(routes.map(route => route.path), [STATE_PATH, CA_PATH]);
    for (const route of routes) {
      assert.deepEqual(route.methods, ['GET']);
      assert.equal(route.requestBody, 'buffered');
      const response = await route.fetch(new Request('http://127.0.0.1:50195' + route.path));
      assert.equal(response.status, mode === 'unauthenticated' ? 401 : 403);
      securityHeaders(response);
      assert.deepEqual(await response.json(), { errorCode: mode === 'unauthenticated' ? 'AUTH_REQUIRED' : 'FORBIDDEN' });
    }
    assert.equal(called, 0, 'unauthorized requests do not read files or generate launch material');
  }
});

test('protected native browser receives no-store JSON or exact public DER attachment', async () => {
  const { facade } = setup();
  const routes = createPhoneAccessSettingsRoutes(browserConnection(), facade);
  const state = await routes[0].fetch(new Request('http://127.0.0.1:50195' + STATE_PATH));
  assert.equal(state.status, 200); securityHeaders(state);
  assert.ok(state.headers.get('content-type').startsWith('application/json'));
  assert.equal((await state.json()).state, 'ready');
  const ca = await routes[1].fetch(new Request('http://127.0.0.1:50195' + CA_PATH));
  assert.equal(ca.status, 200); securityHeaders(ca);
  assert.equal(ca.headers.get('content-type'), 'application/pkix-cert');
  assert.equal(ca.headers.get('content-disposition'), 'attachment; filename="phone-root-ca.cer"');
  assert.ok(Buffer.from(await ca.arrayBuffer()).equals(PUBLIC_DER));
  await facade.close();
});

test('native browser authority and cancellation are rechecked before late responses', async () => {
  for (const which of ['authority', 'peer', 'request']) {
    const controller = new AbortController();
    const peerController = new AbortController();
    const connection = browserConnection();
    connection.browserPeer = { ...connection.browserPeer, signal: peerController.signal };
    let admitted = true;
    connection.admit = () => admitted ? { peer: connection.browserPeer } : { rejection: 401 };
    const operation = async () => {
      if (which === 'authority') admitted = false;
      else if (which === 'peer') peerController.abort();
      else controller.abort();
      return { state: 'ready' };
    };
    const route = createPhoneAccessSettingsRoutes(connection, { snapshot: operation })[0];
    const response = await route.fetch(new Request('http://127.0.0.1:50195' + STATE_PATH, { signal: controller.signal }));
    assert.equal(response.status, which === 'authority' ? 401 : which === 'peer' ? 403 : 409);
    securityHeaders(response);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ['errorCode']);
  }
});

test('queries, wrong methods and cancelled requests do not invoke the facade', async () => {
  let called = 0;
  const routes = createPhoneAccessSettingsRoutes(browserConnection(), { async snapshot() { called += 1; }, async certificate() { called += 1; } });
  const aborted = new AbortController(); aborted.abort();
  for (const route of routes) {
    for (const [request, statusCode] of [
      [new Request('http://127.0.0.1:50195' + route.path + '?ignored=1'), 400],
      [new Request('http://127.0.0.1:50195' + route.path, { method: 'POST' }), 405],
      [new Request('http://127.0.0.1:50195' + route.path, { signal: aborted.signal }), 409],
    ]) {
      const result = await route.fetch(request);
      assert.equal(result.status, statusCode); securityHeaders(result);
    }
  }
  assert.equal(called, 0);
});

test('absolute external output directory and immutable configured port are enforced', () => {
  for (const config of [undefined, {}, { outputDir: 'relative' }, { outputDir: PACKAGE }, { outputDir: join(PACKAGE, 'data') }, { outputDir: ROOT, port: 443 }]) {
    assert.throws(() => createPhoneAccessSettings({ connection: {}, config }), { message: 'SETTINGS_CONFIG_INVALID' });
  }
});

test('scope close awaits in-flight QR work and suppresses late launch responses', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const { facade } = setup();
  const fs = fakeFs(status());
  const owner = createPhoneAccessSettings({
    connection: { authenticatedUrl: base => base + '?token=fictional-unit-test-value' }, config: { outputDir: ROOT },
    dependencies: { fs, packageDir: PACKAGE, now: () => NOW, processStartedAt: START, renderQr: async () => { entered(); await gate; return QR_FIXTURE; } },
  });
  const request = owner.snapshot();
  await started;
  const closing = owner.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  const value = await request;
  assert.equal(value.errorCode, 'SETTINGS_CLOSED');
  assert.ok(value.launchUrl === null && value.qrDataUrl === null);
  await closing;
  await noLaunch(owner, 'SETTINGS_CLOSED');
  assert.equal((await owner.certificate()).errorCode, 'SETTINGS_CLOSED');
  assert.equal(fs.events.closed, fs.events.opened.length);
  await facade.close();
});

test('Host activation owns four native routes, shared controller and matching agent operation', async () => {
  assert.deepEqual(inject, ['connection', 'tools', 'webServer']);
  const effects = [];
  const paths = [];
  const removed = [];
  const services = new Map();
  let tool;
  const ctx = {
    connection: { ...browserConnection(), fetch: { register(route) { paths.push(route.path); return async () => { removed.push(route.path); }; } } },
    get: key => services.get(key),
    provide(key, value) { services.set(key, value); effects.push(() => services.delete(key)); },
    tools: { register(value) { tool = value; return () => {}; } },
    effect(factory) { const dispose = factory(); effects.push(dispose); return dispose; },
  };
  apply(ctx, { outputDir: ROOT, port: PORT });
  assert.deepEqual(paths, [STATE_PATH, CA_PATH, NETWORKS_PATH, NETWORK_PATH]);
  assert.equal(tool.name, 'phone_network');
  assert.equal(tool.deferLoading, true);
  const controller = services.get('phoneAccessSettings');
  assert.deepEqual(await tool.execute({ action: 'list' }, {}), await controller.networks());
  assert.deepEqual(await tool.execute({ action: 'select', interfaceGuid: '' }, {}), await controller.selectNetwork(''));
  for (const dispose of effects.reverse()) await dispose();
  assert.deepEqual(removed.sort(), [...paths].sort());
});

test('live supervisor identity/generation prevents a stale ready QR after switching during render', async () => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let generation = 1;
  let gateway = { status: () => ({ phase: 'ready', generation, origin: status().origin, network: status().network }) };
  const facade = createPhoneAccessSettings({
    connection: { authenticatedUrl: base => base + '?token=fictional-unit-test-value' }, config: { outputDir: ROOT },
    dependencies: { fs: fakeFs(status()), packageDir: PACKAGE, now: () => NOW, processStartedAt: START,
      getGateway: () => gateway, renderQr: async () => { entered(); await gate; return QR_FIXTURE; } },
  });
  const first = facade.snapshot();
  await started;
  generation++;
  release();
  const value = await first;
  assert.equal(value.state, 'starting');
  assert.equal(value.launchUrl, null); assert.equal(value.qrDataUrl, null);
  gateway = undefined;
  const stopped = await facade.snapshot();
  assert.equal(stopped.state, 'inactive');
  assert.equal(stopped.launchUrl, null);
  await facade.close();
});

test('selection in progress hides ready files without generating a launch', async () => {
  let launches = 0;
  const facade = createPhoneAccessSettings({
    connection: { authenticatedUrl() { launches++; return 'not-used'; } }, config: { outputDir: ROOT },
    dependencies: { fs: fakeFs(status()), packageDir: PACKAGE, now: () => NOW, processStartedAt: START,
      getGateway: () => undefined, isApplying: () => true },
  });
  const value = await facade.snapshot();
  assert.equal(value.state, 'starting'); assert.equal(value.launchUrl, null);
  assert.equal(launches, 0);
  await facade.close();
});
