'use strict';
// Pure helper + source-contract tests only: no browser, DOM, React emulation, real endpoints or secrets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
let definition;
vm.runInNewContext(source, {
  window: { __ModuleLoader__: { load(value) { assert.equal(definition, undefined); definition = value; } } },
  URL, AbortController, setTimeout, clearTimeout,
}, { filename: 'client.js', timeout: 1000 });
const client = definition.factory(() => { throw new Error('Helper tests must not import React or other modules'); });
const syntheticLink = 'https://192.0.2.42:63819/?token=SYNTHETIC_ONLY_not_a_real_owner_secret_0000';
function fixture(overrides = {}) {
  return {
    state: 'ready', origin: 'https://192.0.2.42:63819', address: '192.0.2.42', port: 63819,
    interfaceAlias: 'Synthetic test adapter', leafNotAfter: '2030-01-01T00:00:00Z',
    caFingerprint: 'ab'.repeat(32), caNotAfter: '2035-01-01T00:00:00Z', caAvailable: true,
    errorCode: null, launchUrl: syntheticLink, qrDataUrl: 'data:image/png;base64,AA==',
    updatedAt: '2026-11-14T00:00:00Z', ...overrides,
  };
}
const wifiGuid = '11111111-aaaa-4111-8111-111111111111';
const ethernetGuid = '22222222-bbbb-4222-8222-222222222222';
const missingGuid = '33333333-cccc-4333-8333-333333333333';
function adapterFixture(overrides = {}) {
  return { interfaceGuid: wifiGuid, interfaceAlias: 'Synthetic Wi-Fi', interfaceIndex: 12, kind: 'wifi', address: '192.168.20.42', prefixLength: 24, ...overrides };
}
function networksFixture(overrides = {}) {
  return { available: true, selectedInterfaceGuid: '', adapters: [adapterFixture(), adapterFixture({ interfaceGuid: ethernetGuid,
    interfaceAlias: 'Synthetic Ethernet', interfaceIndex: 8, kind: 'ethernet', address: '100.64.1.2', prefixLength: 10 })], errorCode: null, ...overrides };
}
function selectionFixture(overrides = {}) {
  return { ok: true, selectedInterfaceGuid: wifiGuid, phase: 'ready', errorCode: null, ...overrides };
}
function readyNetworks(selectedInterfaceGuid = wifiGuid, overrides = {}) {
  return networksFixture({ selectedInterfaceGuid, phase: 'ready', activeInterfaceGuid: selectedInterfaceGuid || wifiGuid,
    activeAddress: '192.168.20.42', activeOrigin: 'https://192.168.20.42:63819', gatewayErrorCode: null, ...overrides });
}
function response(value = fixture(), overrides = {}) {
  return { ok: true, status: 200, headers: { get: key => key === 'content-type' ? 'application/json; charset=utf-8' : null },
    json: async () => value, ...overrides };
}
function scheduler() {
  let sequence = 0;
  const jobs = new Map();
  return {
    jobs,
    setTimeout(fn, delay) { const id = ++sequence; jobs.set(id, { fn, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    fire(delay) {
      const pair = Array.from(jobs).find(([, job]) => job.delay === delay);
      assert.ok(pair, `No scheduled delay ${delay}`);
      jobs.delete(pair[0]); pair[1].fn();
    },
  };
}
async function advanceRecovery(clock, delays = [500, 1000, 2000, 3000]) {
  for (const delay of delays) {
    await new Promise(resolve => setImmediate(resolve));
    clock.fire(delay);
  }
}
function readerOptions(fetch, views, clock) {
  return { fetch, onChange: value => views.push(value), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
}
function abortablePending(calls) {
  return (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options, resolve });
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

async function unconfirmedRecovery(payload, requestedGuid = wifiGuid) {
  const clock = scheduler(), views = [];
  let switched = false;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') { switched = true; throw new TypeError('synthetic interrupted'); }
    return response(switched ? payload : networksFixture({ selectedInterfaceGuid: ethernetGuid }));
  }, views, clock));
  await networks.start(); networks.choose(requestedGuid); const applying = networks.applySelection();
  await advanceRecovery(clock); await applying;
  return { clock, views, networks, updatePayload(value) { payload = value; } };
}

test('artifact is a lazy factory, pure helpers do not materialize React', () => {
  assert.equal(definition.id, '@local/dsh-phone-settings');
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale']);
  assert.equal(typeof client.apply, 'function');
});

test('ready snapshots preserve the exact full synthetic link and normalize public facts', () => {
  const value = client.normalizeSnapshot(fixture());
  assert.equal(value.launchUrl, syntheticLink);
  assert.equal(value.qrDataUrl, 'data:image/png;base64,AA==');
  assert.equal(value.caFingerprint, Array(32).fill('AB').join(':'));
  assert.equal(value.origin, 'https://192.0.2.42:63819');
  assert.equal(value.updatedAt, '2026-11-14T00:00:00.000Z');
  assert.ok(Object.isFrozen(value));
});

test('ready snapshots accept public, VPN, link-local and loopback IPv4 without changing token or QR privacy', () => {
  for (const address of ['26.0.0.1', '26.0.0.42', '8.8.8.8', '169.254.1.2', '127.0.0.1', '127.2.3.4', '100.64.1.2']) {
    const origin = `https://${address}:63819`;
    const launchUrl = `${origin}/?token=SYNTHETIC_ONLY_not_a_real_owner_secret_0000`;
    const value = client.normalizeSnapshot(fixture({ origin, address, launchUrl }));
    assert.equal(value.origin, origin); assert.equal(value.address, address); assert.equal(value.launchUrl, launchUrl);
    assert.equal(client.isQrRevealed(null, value.qrDataUrl), false);
  }
});

test('every non-ready state clears secrets even when stale secret fields are included', () => {
  for (const state of ['inactive', 'unavailable', 'error', 'starting']) {
    const value = client.normalizeSnapshot(fixture({ state }));
    assert.equal(value.launchUrl, null);
    assert.equal(value.qrDataUrl, null);
    assert.equal(value.caAvailable, true);
    assert.equal(value.state, state);
  }
});

test('ready validation refuses invalid/non-unicast origins, wrong port, token changes and non-PNG QR', () => {
  const invalid = [
    { origin: 'http://192.0.2.42:63819' }, { origin: 'https://192.0.2.42:63818' },
    { origin: 'https://192.0.2.42:63819/?token=synthetic' },
    ...['localhost', 'example.invalid', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.2.3', '255.255.255.255',
      '[::1]', '[::ffff:127.0.0.1]'].map(host => ({ origin: `https://${host}:63819` })),
    { launchUrl: 'https://192.0.2.43:63819/?token=synthetic' },
    { launchUrl: 'https://192.0.2.42:63819/' }, { launchUrl: 'https://192.0.2.42:63819/?token=' },
    { launchUrl: syntheticLink + '&extra=1' }, { launchUrl: syntheticLink + '&token=another' },
    { launchUrl: syntheticLink + '#fragment' }, { launchUrl: syntheticLink.replace('/?', '/nested?') },
    { qrDataUrl: 'data:image/svg+xml;base64,AA==' }, { qrDataUrl: 'https://example.invalid/qr.png' },
    { qrDataUrl: 'data:image/png;base64,' + 'A'.repeat(524289) }, { port: 63818 }, { state: 'unexpected' },
  ];
  for (const override of invalid) assert.throws(() => client.normalizeSnapshot(fixture(override)), error => error.code === 'INVALID_RESPONSE');
});

test('nullable and unknown metadata is bounded and cannot become a raw diagnostic', () => {
  const value = client.normalizeSnapshot(fixture({ state: 'inactive', origin: syntheticLink, interfaceAlias: 'bad\nmetadata',
    caFingerprint: 'invalid', errorCode: 'toString', updatedAt: 'invalid', address: syntheticLink }));
  for (const key of ['origin', 'interfaceAlias', 'caFingerprint', 'errorCode', 'updatedAt', 'address']) assert.equal(value[key], null);
  assert.equal(client.statusDetailKey(value), 'detail.inactive');
  assert.equal(client.requestErrorKey(new Error(syntheticLink)), 'request.failed');
  assert.equal(client.requestErrorKey({ code: 'constructor' }), 'request.failed');
  assert.equal(client.requestErrorKey({ code: '__proto__' }), 'request.failed');
});

test('mounted reader uses only the exact native authenticated no-store GET route and serializes reads', async () => {
  const clock = scheduler(), views = [], calls = [];
  const reader = client.createSnapshotReader(readerOptions(abortablePending(calls), views, clock));
  assert.equal(calls.length, 0);
  const first = reader.start();
  assert.equal(reader.refresh(), first);
  assert.equal(reader.start(), first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/phone-access-settings/state');
  for (const [key, expected] of Object.entries({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) {
    assert.equal(calls[0].options[key], expected);
  }
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(clock.jobs.size, 1);
  calls[0].resolve(response()); await first;
  assert.equal(views.at(-1).snapshot.launchUrl, syntheticLink);
  assert.equal(views.at(-1).pending, false);
  assert.equal(clock.jobs.size, 1);
  clock.fire(15000);
  const second = reader.refresh();
  assert.equal(calls.length, 2);
  calls[1].resolve(response(fixture({ state: 'inactive' }))); await second;
  assert.equal(views.at(-1).snapshot.launchUrl, null);
  assert.equal(views.at(-1).snapshot.qrDataUrl, null);
  reader.stop();
  assert.equal(clock.jobs.size, 0);
  await reader.refresh();
  assert.equal(calls.length, 2);
});

test('unmount aborts in-flight work, clears timers and suppresses late publication', async () => {
  const clock = scheduler(), views = [], calls = [];
  const reader = client.createSnapshotReader(readerOptions(abortablePending(calls), views, clock));
  const first = reader.start();
  const count = views.length;
  reader.stop();
  assert.ok(calls[0].options.signal.aborted);
  await first;
  assert.equal(views.length, count);
  assert.equal(clock.jobs.size, 0);
});

test('request timeout aborts the pending request and produces only localized fixed failure', async () => {
  const clock = scheduler(), views = [], calls = [];
  const reader = client.createSnapshotReader(readerOptions(abortablePending(calls), views, clock));
  const first = reader.start();
  clock.fire(10000); await first;
  assert.ok(calls[0].options.signal.aborted);
  assert.equal(views.at(-1).errorKey, 'request.timeout');
  assert.equal(views.at(-1).snapshot, null);
  reader.stop(); assert.equal(clock.jobs.size, 0);
});

test('failed refresh drops earlier secrets instead of keeping a stale QR visible', async () => {
  const clock = scheduler(), views = [];
  let calls = 0;
  const reader = client.createSnapshotReader(readerOptions(async () => {
    if (++calls === 1) return response();
    throw new Error(syntheticLink);
  }, views, clock));
  await reader.start();
  await reader.refresh();
  const final = views.at(-1);
  assert.equal(final.snapshot, null);
  assert.equal(final.errorKey, 'request.failed');
  assert.ok(!JSON.stringify(final).includes('SYNTHETIC_ONLY'));
  reader.stop();
});

test('invalid JSON and non-browser authorization failures expose no server diagnostic', async () => {
  for (const [reply, key] of [
    [response(null, { ok: false, status: 401 }), 'request.denied'],
    [response(null, { ok: false, status: 403 }), 'request.denied'],
    [response(null, { ok: false, status: 404 }), 'request.unavailable'],
    [response(null, { ok: false, status: 503 }), 'request.unavailable'],
    [response(null, { headers: { get: () => 'text/html' } }), 'request.invalid'],
    [response(null, { json: async () => { throw new Error(syntheticLink); } }), 'request.invalid'],
  ]) {
    const clock = scheduler(), views = [];
    const reader = client.createSnapshotReader(readerOptions(async () => reply, views, clock));
    await reader.start();
    assert.equal(views.at(-1).errorKey, key);
    assert.equal(views.at(-1).snapshot, null);
    reader.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('CA download uses protected exact route and only bounded public DER bytes', async () => {
  const controller = new AbortController();
  const bytes = new Uint8Array([0x30, 0x02, 0x01, 0x00]).buffer;
  const output = await client.fetchCertificate(async (url, options) => {
    assert.equal(url, '/api/phone-access-settings/ca');
    for (const [key, expected] of Object.entries({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(options[key], expected);
    assert.equal(options.signal, controller.signal);
    return { ok: true, headers: { get: key => key === 'content-type' ? 'application/pkix-cert' : '4' }, arrayBuffer: async () => bytes };
  }, controller.signal);
  assert.equal(output, bytes);
});

test('CA download rejects denied, HTML, empty, oversized and aborted replies with fixed errors', async () => {
  for (const options of [
    { ok: false }, { contentType: 'text/html' }, { length: '65537' }, { bytes: new ArrayBuffer(0) },
    { bytes: new ArrayBuffer(65537) }, { aborted: true },
  ]) {
    const controller = new AbortController(); if (options.aborted) controller.abort();
    await assert.rejects(client.fetchCertificate(async () => ({
      ok: options.ok !== false,
      headers: { get: key => key === 'content-type' ? options.contentType || 'application/pkix-cert' : options.length || null },
      arrayBuffer: async () => options.bytes || new ArrayBuffer(4),
    }), controller.signal), error => error.code === 'CA_DOWNLOAD_FAILED');
  }
});

test('Russian and English own-namespace dictionaries are complete and cover errors and displayed text', () => {
  const { en, ru } = client.localeDictionaries;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  assert.equal(ru.title, 'Доступ с телефона');
  for (const value of Object.values(en).concat(Object.values(ru))) {
    assert.equal(typeof value, 'string'); assert.ok(value.trim()); assert.doesNotMatch(value, /[\u200b\ufeff]/);
  }
  for (const match of source.matchAll(/(?:text|translate)\('([^']+)'\)/g)) assert.ok(en[match[1]], `Missing ${match[1]}`);
  for (const state of ['loading', 'ready', 'inactive', 'starting', 'error', 'unavailable']) assert.ok(en[`status.${state}`]);
  for (const code of ['STATUS_UNAVAILABLE', 'STATUS_INVALID', 'STATUS_STALE', 'GATEWAY_STARTING', 'GATEWAY_INACTIVE',
    'GATEWAY_ERROR', 'CA_UNAVAILABLE', 'CA_INVALID', 'CERTIFICATE_EXPIRED', 'LAUNCH_UNAVAILABLE', 'QR_UNAVAILABLE', 'SETTINGS_CLOSED']) {
    assert.ok(en[client.statusDetailKey(client.normalizeSnapshot(fixture({ state: 'unavailable', errorCode: code })))]);
  }
});

test('source contract: additive React slots, theme-only CSS, cleanup and no alternate app/auth/storage', () => {
  assert.deepEqual(Array.from(source.matchAll(/require\('([^']+)'\)/g), match => match[1]), ['react']);
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/);
  assert.match(source, /ctx\.slots\.inject\('settings\.section\.icon'/);
  assert.match(source, /id: SECTION_ID, order: 25, label: \(\) => translate\('title'\), locale: NS/);
  assert.match(source, /const NS = 'phoneAccessSettings'/);
  assert.match(source, /ctx\.effect\(\(\) => ctx\.locale\.register\(NS, 'ru', ru\)/);
  assert.match(source, /React\.memo\(function QrImage/);
  assert.match(source, /reader\.stop\(\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /role: 'status'/);
  assert.match(source, /role: view\.errorKey \|\| state === 'error' \? 'alert'/);
  assert.match(source, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(source, /readOnly: true/);
  assert.doesNotMatch(source, /\bconsole\s*\.|localStorage|sessionStorage|history\.|location\s*[.=]|document\.cookie|document\.body|createRoot|dangerouslySetInnerHTML|iframe|https?:\/\/127\./);
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  for (const match of css.matchAll(/var\((--[^),\s]+)/g)) assert.ok(match[1].startsWith('--dsw-alias-'));
  assert.match(css, /max-width:100%/);
  assert.match(css, /@media\(pointer:coarse\)/);
  assert.doesNotMatch(source, /setInterval\s*\(/);
});

test('QR privacy starts hidden and a different QR cannot inherit revealed state', () => {
  const first = 'data:image/png;base64,U1lOVEhFVElDX09OTFk=';
  const second = 'data:image/png;base64,T1RIRVJfU1lOVEhFVElD';
  assert.equal(client.isQrRevealed(null, first), false);
  assert.equal(client.isQrRevealed(first, first), true);
  assert.equal(client.isQrRevealed(first, second), false);
  assert.equal(client.isQrRevealed(null, second), false);
  assert.equal(client.isQrRevealed('', ''), false);
});

test('keyboard reveal requires two deliberate activations; repeats and slow presses do not reveal', () => {
  let state = client.nextQrKeyActivation(null, 1000, false);
  assert.equal(state.activate, false);
  assert.equal(state.previous, 1000);
  state = client.nextQrKeyActivation(state.previous, 1100, true);
  assert.equal(state.activate, false);
  assert.equal(state.previous, 1000);
  state = client.nextQrKeyActivation(state.previous, 1300, false);
  assert.equal(state.activate, true);
  assert.equal(state.previous, null);
  state = client.nextQrKeyActivation(1000, 1700, false);
  assert.equal(state.activate, false);
  assert.equal(state.previous, 1700);
  assert.equal(client.nextQrKeyActivation(1000, 900, false).activate, false);
});

test('hidden QR renders only a neutral blurred decoy and has no single-click disclosure', () => {
  const component = source.match(/const QrImage = React\.memo\(function QrImage[\s\S]*?\n      function PhoneAccessSettings/)[0];
  assert.match(component, /useState\(null\)/);
  assert.match(component, /const revealed = isQrRevealed\(revealedSource, src\)/);
  assert.match(component, /revealed \? h\('img'/);
  assert.match(component, /className: 'dps-qr-decoy'/);
  assert.match(component, /onDoubleClick:/);
  assert.doesNotMatch(component, /\bonClick:/);
  assert.match(component, /onBlur: conceal/);
  assert.match(component, /addEventListener\('blur', conceal\)/);
  assert.match(component, /removeEventListener\('blur', conceal\)/);
  assert.match(component, /addEventListener\('visibilitychange', onVisibility\)/);
  assert.match(component, /removeEventListener\('visibilitychange', onVisibility\)/);
  assert.match(source, /\.dps-qr-decoy\{[^}]*filter:blur\(9px\)/);
});

test('network normalization accepts every canonical unicast IPv4 range and legacy ready rows', () => {
  for (const address of ['10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.2.3', '100.64.0.1', '100.127.255.254',
    '26.0.0.1', '26.0.0.42', '8.8.8.8', '192.0.2.42', '127.0.0.1', '169.254.1.2', '172.15.0.1', '172.32.0.1', '100.128.0.1']) {
    const network = client.normalizeNetworks(networksFixture({ selectedInterfaceGuid: wifiGuid.toUpperCase(),
      adapters: [adapterFixture({ interfaceGuid: wifiGuid.toUpperCase(), address })] }));
    assert.equal(network.selectedInterfaceGuid, wifiGuid);
    assert.equal(network.adapters[0].interfaceGuid, wifiGuid);
    assert.equal(network.adapters[0].interfaceAlias, 'Synthetic Wi-Fi');
    assert.equal(network.adapters[0].address, address);
    assert.equal(network.adapters[0].available, true); assert.equal(network.adapters[0].status, 'Up');
    assert.ok(Object.isFrozen(network) && Object.isFrozen(network.adapters) && Object.isFrozen(network.adapters[0]));
  }
});

test('network normalization omits only malformed identities/text/index/kind and duplicate rows', () => {
  const invalid = [
    { interfaceGuid: '' }, { interfaceGuid: `{${wifiGuid}}` }, { interfaceGuid: 'invalid' },
    { interfaceAlias: 'bad\nmetadata' }, { interfaceAlias: 'x'.repeat(1025) }, { interfaceAlias: '   ' },
    { kind: '' }, { kind: '  ' }, { kind: 'bad\nkind' }, { kind: 'x'.repeat(65) }, { kind: null },
    { interfaceIndex: -1 }, { interfaceIndex: 1.5 }, { interfaceIndex: 4294967296 },
  ];
  for (const patch of invalid) assert.equal(client.normalizeNetworks(networksFixture({ adapters: [adapterFixture(patch)] })).adapters.length, 0);
  const network = client.normalizeNetworks(networksFixture({ adapters: [null, [], 'invalid', adapterFixture(), adapterFixture({ address: '10.0.0.2' })] }));
  assert.equal(network.adapters.length, 1);
  assert.equal(network.adapters[0].address, '192.168.20.42');
});

test('invalid or missing IPv4/prefix metadata never hides its adapter or becomes a connection target', () => {
  for (const address of [null, undefined, '::1', 'fe80::1234', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.1.2.3', '255.255.255.255',
    '10.001.2.3', '10.256.2.3', syntheticLink]) {
    const row = client.normalizeNetworks(networksFixture({ adapters: [adapterFixture({ address, status: 'Up', available: true })] })).adapters[0];
    assert.ok(row); assert.equal(row.address, null); assert.equal(row.prefixLength, null); assert.equal(row.available, false);
    const label = client.networkAdapterLabel(row, key => client.localeDictionaries.en[key]);
    assert.match(label, /No usable IPv4/); assert.match(label, /Not connectable now/); assert.doesNotMatch(label, /SYNTHETIC_ONLY/);
  }
  for (const prefixLength of [null, undefined, -1, 33, 2.5, '24']) {
    const row = client.normalizeNetworks(networksFixture({ adapters: [adapterFixture({ prefixLength })] })).adapters[0];
    assert.ok(row); assert.equal(row.prefixLength, null); assert.equal(row.address, '192.168.20.42');
    assert.equal(row.available, false); assert.equal(row.status, 'Unknown');
  }
});

test('all kinds, public virtual/VPN /32 addresses, disconnected and IPv6-only inventory rows remain visible', () => {
  const kinds = ['wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other', 'vendor-overlay', 'constructor'];
  const rows = kinds.map((kind, index) => adapterFixture({ interfaceGuid: `${String(index + 1).padStart(8, '0')}-aaaa-4111-8111-111111111111`,
    interfaceAlias: `Synthetic ${kind}`, kind, address: kind === 'loopback' ? '127.0.0.1' : `26.0.0.${index + 1}`,
    prefixLength: 32, status: 'Up', available: true }));
  rows.push(adapterFixture({ interfaceGuid: missingGuid, interfaceAlias: 'Synthetic disconnected', kind: 'vpn',
    address: null, prefixLength: null, status: 'Disconnected', available: false }));
  rows.push(adapterFixture({ interfaceGuid: ethernetGuid, interfaceAlias: 'Synthetic IPv6 only', kind: 'virtual',
    interfaceIndex: 0, address: null, prefixLength: null, status: 'Up', available: false }));
  const network = client.normalizeNetworks(networksFixture({ adapters: rows }));
  assert.equal(network.adapters.length, rows.length);
  for (let index = 0; index < kinds.length; index++) {
    assert.equal(network.adapters[index].kind, kinds[index]); assert.equal(network.adapters[index].available, true);
    const expectedKind = ['vendor-overlay', 'constructor'].includes(kinds[index]) ? 'other' : kinds[index];
    for (const dictionary of Object.values(client.localeDictionaries)) {
      const label = client.networkAdapterLabel(network.adapters[index], key => dictionary[key]);
      assert.ok(label.includes(dictionary[`network.${expectedKind}`])); assert.ok(label.includes(dictionary['network.statusUp']));
      assert.ok(label.includes(`${network.adapters[index].address}/32`));
    }
  }
  const disconnected = network.adapters.at(-2), ipv6Only = network.adapters.at(-1);
  assert.equal(disconnected.status, 'Disconnected'); assert.equal(ipv6Only.interfaceIndex, 0);
  for (const row of [disconnected, ipv6Only]) {
    assert.equal(row.address, null); assert.equal(row.available, false);
    assert.equal(client.networkChoices(network, row.interfaceGuid).find(choice => choice.value === row.interfaceGuid).missing, false);
  }
  assert.match(client.networkAdapterLabel(disconnected, key => client.localeDictionaries.en[key]), /Disconnected/);
});

test('long aliases and large inventories remain accepted within shared Host bounds; unsafe status is sanitized', () => {
  const alias = 'Synthetic '.padEnd(1024, 'x');
  const adapters = Array.from({ length: 4096 }, (_, index) => adapterFixture({
    interfaceGuid: `${index.toString(16).padStart(8, '0')}-aaaa-4111-8111-111111111111`, interfaceAlias: alias }));
  const network = client.normalizeNetworks(networksFixture({ adapters }));
  assert.equal(network.adapters.length, 4096); assert.equal(network.adapters[0].interfaceAlias, alias);
  assert.equal(client.normalizeSnapshot(fixture({ interfaceAlias: alias })).interfaceAlias, alias);
  for (const status of ['bad\nstatus', 'x'.repeat(101), null, ' ']) {
    const row = client.normalizeNetworks(networksFixture({ adapters: [adapterFixture({ status, available: false })] })).adapters[0];
    assert.equal(row.status, 'Unknown'); assert.equal(row.available, false);
  }
});

test('network envelopes are bounded and invalid/unknown diagnostics never enter display state', () => {
  for (const data of [null, [], {}, networksFixture({ available: 'true' }), networksFixture({ selectedInterfaceGuid: null }),
    networksFixture({ selectedInterfaceGuid: 'invalid' }), networksFixture({ adapters: null }),
    networksFixture({ adapters: Array(4097).fill(adapterFixture()) }), networksFixture({ errorCode: {} })]) {
    assert.throws(() => client.normalizeNetworks(data), error => error.code === 'INVALID_RESPONSE');
  }
  for (const errorCode of ['toString', '__proto__', syntheticLink]) {
    const value = client.normalizeNetworks(networksFixture({ errorCode }));
    assert.equal(value.errorCode, 'NETWORK_QUERY_FAILED');
    assert.equal(client.networkErrorKey({ code: errorCode }), 'network.errorQuery');
    assert.equal(client.networkErrorKey({ code: errorCode }, 'network.errorSave'), 'network.errorSave');
    assert.ok(!JSON.stringify(value).includes('SYNTHETIC_ONLY'));
  }
});

test('optional runtime evidence is sanitized and old GET envelopes cannot invent gateway readiness', () => {
  const legacy = client.normalizeNetworks(networksFixture());
  for (const key of ['phase', 'activeInterfaceGuid', 'activeAddress', 'activeOrigin', 'gatewayErrorCode']) assert.equal(legacy[key], null);
  const current = client.normalizeNetworks(networksFixture({ phase: 'ready', activeInterfaceGuid: wifiGuid.toUpperCase(),
    activeAddress: '26.0.0.42', activeOrigin: 'https://26.0.0.42:63819', gatewayErrorCode: 'EADDRINUSE' }));
  assert.equal(current.phase, 'ready'); assert.equal(current.activeInterfaceGuid, wifiGuid);
  assert.equal(current.activeAddress, '26.0.0.42'); assert.equal(current.activeOrigin, 'https://26.0.0.42:63819');
  assert.equal(current.gatewayErrorCode, 'EADDRINUSE');
  const invalid = client.normalizeNetworks(networksFixture({ phase: syntheticLink, activeInterfaceGuid: syntheticLink,
    activeAddress: '224.0.0.1', activeOrigin: syntheticLink, gatewayErrorCode: syntheticLink }));
  for (const key of ['phase', 'activeInterfaceGuid', 'activeAddress', 'activeOrigin']) assert.equal(invalid[key], null);
  assert.equal(invalid.gatewayErrorCode, 'GATEWAY_SETUP_FAILED'); assert.doesNotMatch(JSON.stringify(invalid), /SYNTHETIC_ONLY/);
});

test('automatic and missing selected/draft choices remain present and recover when the adapter returns', () => {
  const missing = client.normalizeNetworks(networksFixture({ selectedInterfaceGuid: missingGuid }));
  const choices = client.networkChoices(missing, missingGuid);
  assert.equal(choices[0].value, '');
  assert.equal(choices.filter(choice => choice.value === missingGuid).length, 1);
  assert.equal(choices.find(choice => choice.value === missingGuid).missing, true);
  assert.equal(client.networkChoices(missing, '44444444-dddd-4444-8444-444444444444').filter(choice => choice.missing).length, 2);
  const returned = client.normalizeNetworks(networksFixture({ selectedInterfaceGuid: missingGuid,
    adapters: [adapterFixture({ interfaceGuid: missingGuid })] }));
  assert.equal(client.networkChoices(returned, missingGuid).find(choice => choice.value === missingGuid).missing, false);
});

test('network GET and selection POST use exact protected native routes and JSON, never navigation', async () => {
  const controller = new AbortController();
  await client.fetchNetworks(async (url, options) => {
    assert.equal(url, '/api/phone-access-settings/networks');
    for (const [key, expected] of Object.entries({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(options[key], expected);
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.signal, controller.signal);
    return response(networksFixture());
  }, controller.signal);
  for (const guid of ['', wifiGuid.toUpperCase()]) {
    const result = await client.applyNetworkSelection(async (url, options) => {
      assert.equal(url, '/api/phone-access-settings/network');
      for (const [key, expected] of Object.entries({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })) assert.equal(options[key], expected);
      assert.equal(options.headers.Accept, 'application/json');
      assert.equal(options.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(options.body), { interfaceGuid: guid.toLowerCase() });
      assert.equal(options.signal, controller.signal);
      return response(selectionFixture({ selectedInterfaceGuid: guid.toLowerCase() }));
    }, guid, controller.signal);
    assert.equal(result.ok, true);
    assert.equal(result.selectedInterfaceGuid, guid.toLowerCase());
    assert.ok(Object.isFrozen(result));
  }
});

test('network actions reject invalid GUIDs, denied/HTML/invalid JSON and mismatched successful selections', async () => {
  const controller = new AbortController();
  for (const guid of [null, undefined, 'invalid', `{${wifiGuid}}`, ' ']) {
    await assert.rejects(client.applyNetworkSelection(() => { throw new Error('must not fetch'); }, guid, controller.signal), error => error.code === 'NETWORK_SELECTION_INVALID');
  }
  for (const [reply, code] of [
    [response(null, { ok: false, status: 403 }), 'DENIED'],
    [response(null, { headers: { get: () => 'text/html' } }), 'INVALID_RESPONSE'],
    [response(null, { json: async () => { throw new Error(syntheticLink); } }), 'INVALID_RESPONSE'],
    [response({}), 'INVALID_RESPONSE'], [response(selectionFixture({ selectedInterfaceGuid: ethernetGuid })), 'INVALID_RESPONSE'],
    [response(selectionFixture({ phase: null })), 'INVALID_RESPONSE'],
    [response(selectionFixture(), { status: 201 }), 'INVALID_RESPONSE'],
    [response(selectionFixture(), { ok: false, status: 500 }), 'INVALID_RESPONSE'],
  ]) await assert.rejects(client.applyNetworkSelection(async () => reply, wifiGuid, controller.signal), error => error.code === code);
});

test('network action preserves committed GUID on startup failure but not arbitrary server messages', async () => {
  const controller = new AbortController();
  const result = await client.applyNetworkSelection(async () => response({ ok: false, selectedInterfaceGuid: wifiGuid,
    phase: 'error', errorCode: 'EADDRINUSE', message: syntheticLink }, { ok: false, status: 409 }), wifiGuid, controller.signal);
  assert.equal(result.ok, false);
  assert.equal(result.selectedInterfaceGuid, wifiGuid);
  assert.equal(result.errorCode, 'EADDRINUSE');
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_ONLY'));
  const unknown = await client.applyNetworkSelection(async () => response({ ok: false, errorCode: syntheticLink }, { ok: false, status: 500 }), wifiGuid, controller.signal);
  assert.equal(unknown.selectedInterfaceGuid, null);
  assert.equal(unknown.errorCode, 'GATEWAY_SETUP_FAILED');
});

test('mounted network reader serializes initial/manual reads and does not fetch before mounting or after disposal', async () => {
  const clock = scheduler(), views = [], calls = [];
  const networks = client.createNetworkSettings(readerOptions(abortablePending(calls), views, clock));
  networks.choose(''); await networks.refresh(); await networks.applySelection();
  assert.equal(calls.length, 0);
  const first = networks.start();
  assert.equal(networks.start(), first); assert.equal(networks.refresh(), first);
  assert.equal(calls.length, 1);
  calls[0].resolve(response(networksFixture({ selectedInterfaceGuid: wifiGuid }))); await first;
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).dirty, false);
  assert.equal(client.canApplyNetwork(views.at(-1)), true); // same selection can force start/reconcile
  assert.equal(clock.jobs.size, 0);
  networks.stop(); await networks.refresh(); await networks.applySelection();
  assert.equal(calls.length, 1);
});

test('refresh and polling retain an edited draft, including its missing option, until the user applies or restores it', async () => {
  const clock = scheduler(), views = [];
  let payload = networksFixture({ selectedInterfaceGuid: wifiGuid });
  const networks = client.createNetworkSettings(readerOptions(async () => response(payload), views, clock));
  await networks.start(); networks.choose(ethernetGuid.toUpperCase());
  assert.equal(views.at(-1).draftInterfaceGuid, ethernetGuid); assert.equal(views.at(-1).dirty, true);
  payload = networksFixture({ selectedInterfaceGuid: wifiGuid, adapters: [adapterFixture()] });
  await networks.refresh();
  assert.equal(views.at(-1).draftInterfaceGuid, ethernetGuid);
  assert.equal(client.networkChoices(views.at(-1).network, ethernetGuid).find(choice => choice.value === ethernetGuid).missing, true);
  assert.equal(client.canApplyNetwork(views.at(-1)), false);
  payload = networksFixture({ selectedInterfaceGuid: missingGuid });
  await networks.refresh();
  assert.equal(views.at(-1).network.selectedInterfaceGuid, missingGuid);
  assert.equal(views.at(-1).draftInterfaceGuid, ethernetGuid);
  assert.equal(client.canApplyNetwork(views.at(-1)), true); // adapter recovered
  networks.choose(''); await networks.refresh();
  assert.equal(views.at(-1).draftInterfaceGuid, '');
  networks.choose(missingGuid); assert.equal(views.at(-1).dirty, false);
  payload = networksFixture({ selectedInterfaceGuid: wifiGuid }); await networks.refresh();
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid); // untouched view follows external committed choice
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('a draft chosen during an in-flight refresh is not overwritten by that read', async () => {
  const clock = scheduler(), views = [];
  let resolveRefresh, count = 0;
  const networks = client.createNetworkSettings(readerOptions(async () => ++count === 1 ? response(networksFixture()) :
    new Promise(resolve => { resolveRefresh = resolve; }), views, clock));
  await networks.start(); const reading = networks.refresh();
  networks.choose(ethernetGuid); resolveRefresh(response(networksFixture({ selectedInterfaceGuid: wifiGuid })));
  await reading;
  assert.equal(views.at(-1).draftInterfaceGuid, ethernetGuid);
  assert.equal(views.at(-1).dirty, true);
  networks.stop();
});

test('unavailable provider and missing inventory selection cannot apply, while returned listed choices can', async () => {
  const clock = scheduler(), views = [];
  let payload = networksFixture({ available: false, selectedInterfaceGuid: missingGuid, adapters: [], errorCode: 'NETWORK_SELECTION_UNAVAILABLE' });
  let posts = 0;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') posts++;
    return response(payload);
  }, views, clock));
  await networks.start();
  assert.equal(views.at(-1).draftInterfaceGuid, missingGuid);
  assert.equal(views.at(-1).readErrorKey, 'network.errorUnavailable');
  assert.equal(client.networkChoices(views.at(-1).network, missingGuid).at(-1).missing, true);
  await networks.applySelection(); assert.equal(posts, 0);
  payload = networksFixture({ selectedInterfaceGuid: missingGuid }); await networks.refresh();
  assert.equal(client.canApplyNetwork(views.at(-1)), false);
  networks.choose(wifiGuid); assert.equal(client.canApplyNetwork(views.at(-1)), true);
  networks.choose('invalid'); assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  networks.stop();
});

test('disconnected/no-IPv4 and IPv6-only interfaces can be chosen, applied and persist as committed standby', async () => {
  for (const adapter of [adapterFixture({ kind: 'vpn', address: null, prefixLength: null, status: 'Disconnected', available: false }),
    adapterFixture({ kind: 'virtual', interfaceIndex: 0, address: null, prefixLength: null, status: 'Up', available: false })]) {
    const clock = scheduler(), views = [], posts = [];
    let selected = '';
    const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
      if (options.method === 'GET') return response(networksFixture({ adapters: [adapter], selectedInterfaceGuid: selected, phase: selected ? 'standby' : null }));
      posts.push(JSON.parse(options.body)); selected = wifiGuid;
      return response(selectionFixture({ ok: false, phase: 'standby', errorCode: 'NETWORK_SELECTION_UNAVAILABLE' }), { ok: false, status: 503 });
    }, views, clock));
    await networks.start(); networks.choose(wifiGuid);
    assert.equal(client.canApplyNetwork(views.at(-1)), true);
    assert.equal(client.networkChoices(views.at(-1).network, wifiGuid).find(choice => choice.value === wifiGuid).missing, false);
    await networks.applySelection();
    assert.deepEqual(posts, [{ interfaceGuid: wifiGuid }]); assert.equal(views.at(-1).network.selectedInterfaceGuid, wifiGuid);
    assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid); assert.equal(views.at(-1).dirty, false);
    assert.equal(views.at(-1).feedbackKey, 'network.savedStandby'); assert.equal(views.at(-1).saveErrorKey, null);
    assert.equal(client.canApplyNetwork(views.at(-1)), true);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('query failures retain the draft and selected facts but prevent applying until a successful refresh', async () => {
  const clock = scheduler(), views = [];
  let fails = false;
  const networks = client.createNetworkSettings(readerOptions(async () => {
    if (fails) throw new Error(syntheticLink);
    return response(networksFixture());
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); fails = true; await networks.refresh();
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).network.selectedInterfaceGuid, '');
  assert.equal(views.at(-1).readErrorKey, 'network.errorQuery');
  assert.equal(client.canApplyNetwork(views.at(-1)), false);
  assert.ok(!JSON.stringify(views.at(-1)).includes('SYNTHETIC_ONLY'));
  fails = false; await networks.refresh();
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).readErrorKey, null);
  assert.equal(client.canApplyNetwork(views.at(-1)), true);
  networks.stop();
});

test('discovery helper failures use read-network guidance while startup actions keep certificate guidance', async () => {
  for (const [code, actionKey] of [['HELPER_FAILED', 'network.errorCertificate'], ['HELPER_PROTOCOL', 'network.errorCertificate'],
    ['CERTIFICATE_OPERATION_FAILED', 'network.errorCertificate'], ['HELPER_TIMEOUT', 'network.errorHelperTimeout'],
    ['HELPER_ABORTED', 'network.outcomeUnknown'], ['REQUEST_ABORTED', 'network.outcomeUnknown']]) {
    assert.equal(client.networkErrorKey({ code }), actionKey);
    assert.equal(client.networkSelectionFeedback(selectionFixture({ ok: false, phase: 'error', errorCode: code }), wifiGuid).saveErrorKey, actionKey);
    for (const mode of ['http', 'envelope']) {
      const clock = scheduler(), views = [];
      let failing = true;
      const networks = client.createNetworkSettings(readerOptions(async () => !failing ? response(networksFixture()) : mode === 'http' ?
        response({ errorCode: code }, { ok: false, status: 503 }) : response(networksFixture({ available: false, adapters: [], errorCode: code })), views, clock));
      await networks.start();
      assert.equal(views.at(-1).readErrorKey, 'network.errorQuery'); assert.equal(views.at(-1).pending, false);
      assert.equal(client.networkFeedbackKeys(views.at(-1)).includes('network.loading'), false);
      failing = false; await networks.refresh();
      assert.equal(views.at(-1).readErrorKey, null); assert.equal(views.at(-1).pending, false);
      assert.equal(client.canApplyNetwork(views.at(-1)), true);
      networks.stop(); assert.equal(clock.jobs.size, 0);
    }
  }
});

test('a fresh network retry clears stale read errors and cannot leave loading forever when fetch ignores abort', async () => {
  const clock = scheduler(), views = [];
  let calls = 0, resolveLate, signal;
  const networks = client.createNetworkSettings(readerOptions((url, options) => {
    if (++calls === 1) return Promise.reject(Object.assign(new Error(syntheticLink), { code: 'HELPER_PROTOCOL' }));
    signal = options.signal;
    return new Promise(resolve => { resolveLate = resolve; });
  }, views, clock));
  await networks.start(); assert.equal(views.at(-1).readErrorKey, 'network.errorQuery');
  const reading = networks.refresh();
  assert.equal(views.at(-1).pending, true); assert.equal(views.at(-1).readErrorKey, null);
  clock.fire(10000); await reading;
  assert.equal(signal.aborted, true); assert.equal(views.at(-1).pending, false); assert.equal(views.at(-1).readErrorKey, 'request.timeout');
  assert.equal(client.networkFeedbackKeys(views.at(-1)).includes('network.loading'), false); assert.equal(clock.jobs.size, 0);
  const count = views.length; resolveLate(response(networksFixture())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, count); assert.doesNotMatch(JSON.stringify(views), /SYNTHETIC_ONLY/);
  networks.stop();
});

test('applying is single-flight, blocks editing/refresh, uses the two-minute PKI timeout and refreshes after success', async () => {
  const clock = scheduler(), views = [], calls = [];
  let selected = '', starts = 0, settles = 0;
  const post = abortablePending(calls);
  const networks = client.createNetworkSettings({ ...readerOptions((url, options) => options.method === 'POST' ? post(url, options) :
    Promise.resolve(response(networksFixture({ selectedInterfaceGuid: selected }))), views, clock),
    onApplyStart() { starts++; }, onApplySettled() { settles++; } });
  await networks.start(); networks.choose(wifiGuid);
  const applying = networks.applySelection();
  assert.equal(networks.applySelection(), applying);
  await networks.refresh(); networks.choose(ethernetGuid);
  assert.equal(calls.length, 1); assert.equal(starts, 1);
  assert.equal(views.at(-1).saving, true); assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  assert.equal(Array.from(clock.jobs.values())[0].delay, 120000);
  selected = wifiGuid; calls[0].resolve(response(selectionFixture())); await applying;
  assert.equal(settles, 1); assert.equal(views.at(-1).saving, false);
  assert.equal(views.at(-1).network.selectedInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid); assert.equal(views.at(-1).dirty, false);
  assert.equal(views.at(-1).feedbackKey, 'network.applied');
  assert.equal(views.at(-1).saveErrorKey, null); assert.equal(clock.jobs.size, 0);
  networks.stop();
});

test('saved startup failure updates committed selection; unsaved failure keeps the draft; both refresh and can retry', async () => {
  for (const persisted of [true, false]) {
    const clock = scheduler(), views = [];
    let selected = '', gets = 0, settles = 0;
    const networks = client.createNetworkSettings({ ...readerOptions(async (url, options) => {
      if (options.method === 'GET') { gets++; return response(networksFixture({ selectedInterfaceGuid: selected })); }
      if (persisted) selected = wifiGuid;
      return response({ ok: false, ...(persisted ? { selectedInterfaceGuid: selected, phase: 'error' } : {}),
        errorCode: persisted ? 'CERTIFICATE_OPERATION_FAILED' : 'NETWORK_SELECTION_SAVE_FAILED' }, { ok: false, status: 503 });
    }, views, clock), onApplySettled() { settles++; } });
    await networks.start(); networks.choose(wifiGuid); await networks.applySelection();
    assert.equal(gets, 2); assert.equal(settles, 1);
    assert.equal(views.at(-1).network.selectedInterfaceGuid, persisted ? wifiGuid : '');
    assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid); assert.equal(views.at(-1).dirty, !persisted);
    assert.equal(views.at(-1).saveErrorKey, persisted ? 'network.errorCertificate' : 'network.errorSave');
    assert.equal(views.at(-1).feedbackKey, persisted ? 'network.savedError' : null);
    assert.deepEqual(Array.from(client.networkFeedbackKeys(views.at(-1))), persisted ?
      ['network.savedError', 'network.errorCertificate'] : ['network.errorSave']);
    assert.equal(client.canApplyNetwork(views.at(-1)), true);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('actual ok:false committed standby/starting/switching phases show saved waiting guidance, not save/plugin failure', async () => {
  for (const [phase, expected] of [['standby', 'network.savedStandby'], ['starting', 'network.savedStarting'], ['switching', 'network.savedStarting']]) {
    const clock = scheduler(), views = [];
    const networks = client.createNetworkSettings(readerOptions(async (url, options) => response(options.method === 'POST' ?
      selectionFixture({ ok: false, selectedInterfaceGuid: '', phase, errorCode: 'NETWORK_SELECTION_UNAVAILABLE' }) : networksFixture()), views, clock));
    await networks.start(); await networks.applySelection();
    assert.equal(views.at(-1).feedbackKey, expected);
    assert.equal(views.at(-1).saveErrorKey, null);
    assert.deepEqual(Array.from(client.networkFeedbackKeys(views.at(-1))), [expected]);
    assert.equal(views.at(-1).dirty, false);
    const text = client.localeDictionaries.en[expected];
    assert.match(text, /saved/); assert.doesNotMatch(text, /could not be saved|enable.*plugin/i);
    networks.stop();
  }
});

test('a lost response followed by a legacy GET confirms the saved choice without inventing readiness or a red unknown', async () => {
  const clock = scheduler(), views = [];
  let selected = '', gets = 0, settles = 0;
  const networks = client.createNetworkSettings({ ...readerOptions(async (url, options) => {
    if (options.method === 'GET') { gets++; return response(networksFixture({ selectedInterfaceGuid: selected })); }
    selected = wifiGuid; // backend may have committed before the phone lost its old connection
    throw new TypeError(syntheticLink);
  }, views, clock), onApplySettled() { settles++; } });
  await networks.start(); networks.choose(wifiGuid); await networks.applySelection();
  assert.equal(gets, 3); assert.equal(settles, 1);
  assert.equal(views.at(-1).network.selectedInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
  assert.equal(views.at(-1).saveErrorKey, null);
  assert.equal(views.at(-1).feedbackKey, 'network.savedNotReady');
  assert.ok(!JSON.stringify(views.at(-1)).includes('SYNTHETIC_ONLY'));
  for (const dictionary of Object.values(client.localeDictionaries)) {
    assert.notEqual(dictionary['network.outcomeUnknown'], dictionary['network.errorSave']);
  }
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('lost POST responses reconcile to confirmed ready, including public virtual IPv4 and automatic selection', async () => {
  for (const guid of [wifiGuid, '']) {
    const clock = scheduler(), views = [];
    let selected = ethernetGuid, switched = false, gets = 0, starts = 0, settles = 0;
    const networks = client.createNetworkSettings({ ...readerOptions(async (url, options) => {
      if (options.method === 'POST') { selected = guid; switched = true; throw new TypeError(syntheticLink); }
      gets++;
      return response(switched ? readyNetworks(selected, { activeAddress: '26.0.0.42', activeOrigin: 'https://26.0.0.42:63819',
        adapters: [adapterFixture({ kind: 'virtual', address: '26.0.0.42', prefixLength: 32, status: 'Up', available: true })] }) : networksFixture({ selectedInterfaceGuid: selected }));
    }, views, clock), onApplyStart() { starts++; }, onApplySettled() { settles++; } });
    await networks.start(); networks.choose(guid); await networks.applySelection();
    assert.equal(gets, 3); assert.equal(starts, 1); assert.equal(settles, 1);
    assert.equal(views.at(-1).network.selectedInterfaceGuid, guid); assert.equal(views.at(-1).draftInterfaceGuid, guid);
    assert.equal(views.at(-1).dirty, false); assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
    assert.ok(views.some(view => view.confirming)); assert.equal(clock.jobs.size, 0);
    assert.doesNotMatch(JSON.stringify(views), /SYNTHETIC_ONLY/);
    networks.stop();
  }
});

test('automatic selection cannot prove ready without a GUID, available inventory row and complete active endpoint', async () => {
  const incomplete = [
    { activeInterfaceGuid: null, activeAddress: null, activeOrigin: null },
    { activeInterfaceGuid: null }, { activeAddress: null }, { activeOrigin: null }, { adapters: [] },
    { activeInterfaceGuid: missingGuid },
  ];
  for (const patch of incomplete) {
    const { clock, views, networks } = await unconfirmedRecovery(readyNetworks('', patch), '');
    assert.equal(views.at(-1).feedbackKey, 'network.savedNotReady'); assert.equal(views.at(-1).saveErrorKey, 'network.errorNotReady');
    assert.equal(views.at(-1).dirty, false); assert.equal(views.some(view => view.feedbackKey === 'network.applied'), false);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('fixed selection cannot prove ready from missing or inconsistent active address, origin or inventory', async () => {
  const inconsistent = [
    { activeInterfaceGuid: null }, { activeAddress: null }, { activeAddress: '26.0.0.42' }, { activeAddress: '224.0.0.1' },
    { activeOrigin: null }, { activeOrigin: 'https://26.0.0.42:63819' }, { activeOrigin: 'https://192.168.20.42:63818' },
    { activeOrigin: 'http://192.168.20.42:63819' }, { activeOrigin: syntheticLink },
    { adapters: [] }, { adapters: [adapterFixture({ address: '26.0.0.42', available: true, status: 'Up' })] },
  ];
  for (const patch of inconsistent) {
    const { clock, views, networks } = await unconfirmedRecovery(readyNetworks(wifiGuid, patch));
    assert.equal(views.at(-1).feedbackKey, 'network.savedNotReady'); assert.equal(views.at(-1).saveErrorKey, 'network.errorNotReady');
    assert.equal(views.some(view => view.feedbackKey === 'network.applied'), false);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('ready phase with a gateway error never becomes green, for fixed or automatic selection', async () => {
  for (const guid of [wifiGuid, '']) {
    const { clock, views, networks, updatePayload } = await unconfirmedRecovery(readyNetworks(guid, { gatewayErrorCode: 'EADDRINUSE' }), guid);
    assert.equal(views.at(-1).feedbackKey, 'network.savedError'); assert.equal(views.at(-1).saveErrorKey, 'network.errorPort');
    assert.equal(views.some(view => view.feedbackKey === 'network.applied'), false);
    updatePayload(readyNetworks(guid)); await networks.refresh();
    assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('explicit successful POST remains valid with a legacy GET that omits optional gateway health', async () => {
  for (const guid of [wifiGuid, '']) {
    const clock = scheduler(), views = [];
    let selected = ethernetGuid;
    const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
      if (options.method === 'POST') { selected = guid; return response(selectionFixture({ selectedInterfaceGuid: guid })); }
      return response(networksFixture({ selectedInterfaceGuid: selected }));
    }, views, clock));
    await networks.start(); networks.choose(guid); await networks.applySelection();
    assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
    assert.equal(views.at(-1).network.phase, null); assert.equal(views.some(view => view.confirming), false);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('recovery never claims ready for a different saved GUID or a different active interface', async () => {
  for (const mismatch of ['saved', 'active']) {
    const clock = scheduler(), views = [];
    let switched = false;
    const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
      if (options.method === 'POST') { switched = true; throw new TypeError('synthetic interrupted'); }
      return response(switched ? readyNetworks(mismatch === 'saved' ? ethernetGuid : wifiGuid, { activeInterfaceGuid: ethernetGuid }) : networksFixture());
    }, views, clock));
    await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
    await advanceRecovery(clock); await applying;
    assert.equal(views.at(-1).saveErrorKey, mismatch === 'saved' ? 'network.notApplied' : 'network.errorNotActive');
    assert.notEqual(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
    assert.equal(views.at(-1).dirty, mismatch === 'saved'); assert.equal(clock.jobs.size, 0);
    networks.stop();
  }
});

test('a down active inventory row cannot prove ready; a later fresh Up row clears waiting feedback', async () => {
  const clock = scheduler(), views = [];
  let switched = false, up = false;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') { switched = true; throw new TypeError('synthetic interrupted'); }
    return response(switched ? readyNetworks(wifiGuid, { adapters: [adapterFixture({ available: up, status: up ? 'Up' : 'Disconnected' })] }) : networksFixture());
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  await advanceRecovery(clock); await applying;
  assert.equal(views.at(-1).feedbackKey, 'network.savedStandby'); assert.equal(views.at(-1).saveErrorKey, null);
  up = true; await networks.refresh();
  assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('bounded recovery retries an unavailable provider and preparing phase before confirming ready', async () => {
  const clock = scheduler(), views = [];
  let gets = 0, switched = false;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') { switched = true; throw new TypeError('synthetic interrupted'); }
    gets++;
    if (!switched) return response(networksFixture());
    if (gets === 2) return response({ errorCode: 'GATEWAY_UNAVAILABLE' }, { ok: false, status: 503 });
    if (gets === 3) return response(networksFixture({ selectedInterfaceGuid: wifiGuid, phase: 'starting' }));
    return response(readyNetworks());
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  await advanceRecovery(clock, [500, 1000]); await applying;
  assert.equal(gets, 5); assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
  assert.ok(views.some(view => view.confirming && client.networkFeedbackKeys(view)[0] === 'network.confirming'));
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('unknown outcome is retained only while fresh state is unreadable, and a later confirmed refresh clears it', async () => {
  const clock = scheduler(), views = [];
  let switched = false, readable = false;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') { switched = true; throw new TypeError(syntheticLink); }
    if (!switched) return response(networksFixture());
    if (!readable) throw new TypeError(syntheticLink);
    return response(readyNetworks());
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  await advanceRecovery(clock); await applying;
  assert.equal(views.at(-1).saveErrorKey, 'network.outcomeUnknown'); assert.equal(views.at(-1).feedbackKey, null);
  assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid); assert.equal(views.at(-1).dirty, true);
  readable = true; await networks.refresh();
  assert.equal(views.at(-1).saveErrorKey, null); assert.equal(views.at(-1).feedbackKey, 'network.applied');
  assert.equal(views.at(-1).readErrorKey, null); assert.equal(views.at(-1).dirty, false);
  assert.doesNotMatch(JSON.stringify(views), /SYNTHETIC_ONLY/);
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('fresh gateway errors after a lost response remain actionable and a later ready refresh clears them', async () => {
  const clock = scheduler(), views = [];
  let switched = false, ready = false;
  const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
    if (options.method === 'POST') { switched = true; throw new TypeError('synthetic interrupted'); }
    if (!switched) return response(networksFixture());
    return response(ready ? readyNetworks() : networksFixture({ selectedInterfaceGuid: wifiGuid, phase: 'error', gatewayErrorCode: 'EADDRINUSE' }));
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  await advanceRecovery(clock); await applying;
  assert.equal(views.at(-1).feedbackKey, 'network.savedError'); assert.equal(views.at(-1).saveErrorKey, 'network.errorPort');
  ready = true; await networks.refresh();
  assert.equal(views.at(-1).feedbackKey, 'network.applied'); assert.equal(views.at(-1).saveErrorKey, null);
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('explicit pre-commit and authorization failures do not become success from an unchanged already-ready selection', async () => {
  for (const [reply, expected] of [
    [response({ ok: false, errorCode: 'NETWORK_SELECTION_SAVE_FAILED' }, { ok: false, status: 503 }), 'network.errorSave'],
    [response({ ok: false, selectedInterfaceGuid: wifiGuid, errorCode: 'NETWORK_SELECTION_SAVE_FAILED' }, { ok: false, status: 503 }), 'network.errorSave'],
    [response(null, { ok: false, status: 403 }), 'request.denied'],
  ]) {
    const clock = scheduler(), views = [];
    let gets = 0;
    const networks = client.createNetworkSettings(readerOptions(async (url, options) => {
      if (options.method === 'POST') return reply;
      gets++; return response(readyNetworks());
    }, views, clock));
    await networks.start(); await networks.applySelection(); await networks.refresh();
    assert.equal(views.at(-1).saveErrorKey, expected); assert.equal(views.at(-1).feedbackKey, null); assert.equal(gets, 3);
    assert.equal(views.at(-1).network.selectedInterfaceGuid, wifiGuid);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('confirmed fresh readiness after a POST timeout overrides the unknown timeout result', async () => {
  const clock = scheduler(), views = [], calls = [];
  let gets = 0;
  const post = abortablePending(calls);
  const networks = client.createNetworkSettings(readerOptions((url, options) => options.method === 'POST' ? post(url, options) :
    Promise.resolve(response(++gets === 1 ? networksFixture() : readyNetworks())), views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  clock.fire(120000); await applying;
  assert.equal(calls[0].options.signal.aborted, true); assert.equal(views.at(-1).feedbackKey, 'network.applied');
  assert.equal(views.at(-1).saveErrorKey, null); assert.equal(views.at(-1).dirty, false);
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('closing during a recovery GET or retry delay aborts and clears every timer without late updates', async () => {
  for (const stage of ['read', 'delay']) {
    const clock = scheduler(), views = [];
    let switched = false, resolveLate, recoverySignal, settles = 0;
    const networks = client.createNetworkSettings({ ...readerOptions((url, options) => {
      if (options.method === 'POST') { switched = true; return Promise.reject(new TypeError('synthetic interrupted')); }
      if (!switched) return Promise.resolve(response(networksFixture()));
      recoverySignal = options.signal;
      return stage === 'read' ? new Promise(resolve => { resolveLate = resolve; }) : Promise.reject(new TypeError('synthetic interrupted'));
    }, views, clock), onApplySettled() { settles++; } });
    await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(recoverySignal); const count = views.length; networks.stop(); await applying;
    assert.equal(recoverySignal.aborted, true); assert.equal(clock.jobs.size, 0); assert.equal(settles, 0); assert.equal(views.length, count);
    if (resolveLate) { resolveLate(response(readyNetworks())); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(views.length, count);
  }
});

test('the additional recovery budget is ten seconds even if a GET ignores cancellation', async () => {
  const clock = scheduler(), views = [];
  let switched = false, gets = 0, recoverySignal, resolveLate;
  const networks = client.createNetworkSettings(readerOptions((url, options) => {
    if (options.method === 'POST') { switched = true; return Promise.reject(new TypeError('synthetic interrupted')); }
    gets++;
    if (!switched) return Promise.resolve(response(networksFixture()));
    if (gets === 2) { recoverySignal = options.signal; return new Promise(resolve => { resolveLate = resolve; }); }
    return Promise.reject(new TypeError('synthetic unavailable'));
  }, views, clock));
  await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
  await new Promise(resolve => setImmediate(resolve)); clock.fire(10000); await applying;
  assert.equal(recoverySignal.aborted, true); assert.equal(views.at(-1).saveErrorKey, 'network.outcomeUnknown'); assert.equal(clock.jobs.size, 0);
  const count = views.length; resolveLate(response(readyNetworks())); await new Promise(resolve => setImmediate(resolve));
  assert.equal(views.length, count);
  networks.stop();
});

test('saved runtime errors retain saved-prefix plus actionable error, while mismatched selection is not reported saved', () => {
  for (const code of ['EADDRINUSE', 'EACCES', 'CERTIFICATE_OPERATION_FAILED', 'GATEWAY_UNAVAILABLE',
    'HELPER_TIMEOUT', 'HELPER_FAILED', 'HELPER_PROTOCOL', 'AUTHORITY_REPAIR_REQUIRED', 'PRIVATE_STATE_UNSAFE',
    'LEAF_CLEANUP_REQUIRED', 'GATEWAY_SETUP_FAILED', 'NETWORK_SELECTION_SAVE_FAILED']) {
    const feedback = client.networkSelectionFeedback(selectionFixture({ ok: false, selectedInterfaceGuid: wifiGuid, phase: 'error', errorCode: code }), wifiGuid);
    assert.equal(feedback.feedbackKey, 'network.savedError');
    assert.notEqual(feedback.saveErrorKey, 'network.errorSave');
    assert.deepEqual(Array.from(client.networkFeedbackKeys({ ...feedback, saving: false, pending: false })), ['network.savedError', feedback.saveErrorKey]);
    for (const dictionary of Object.values(client.localeDictionaries)) assert.ok(dictionary[feedback.saveErrorKey]);
  }
  const mismatch = client.networkSelectionFeedback(selectionFixture({ ok: false, selectedInterfaceGuid: ethernetGuid,
    phase: 'error', errorCode: 'NETWORK_SELECTION_SAVE_FAILED' }), wifiGuid);
  assert.equal(mismatch.feedbackKey, null); assert.equal(mismatch.saveErrorKey, 'network.errorSave');
});

test('HTTP guard failures without ok retain only allowlisted localized codes and unknown failures use generic setup', async () => {
  const signal = new AbortController().signal;
  for (const [code, status] of [['NETWORK_SELECTION_INVALID', 400], ['REQUEST_INVALID', 415], ['NETWORK_SELECTION_BUSY', 409], ['GATEWAY_SETUP_FAILED', 503]]) {
    const result = await client.applyNetworkSelection(async () => response({ errorCode: code, message: syntheticLink }, { ok: false, status }), wifiGuid, signal);
    assert.equal(result.ok, false); assert.equal(result.errorCode, code);
    assert.equal(result.selectedInterfaceGuid, null);
    assert.ok(client.localeDictionaries.en[client.networkSelectionFeedback(result, wifiGuid).saveErrorKey]);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_ONLY'));
  }
  await assert.rejects(client.fetchNetworks(async () => response({ errorCode: 'NETWORK_QUERY_FAILED' }, { ok: false, status: 503 }), signal),
    error => error.code === 'NETWORK_QUERY_FAILED');
  const unknown = await client.applyNetworkSelection(async () => response({ ok: false, selectedInterfaceGuid: wifiGuid, phase: 'error', errorCode: syntheticLink }), wifiGuid, signal);
  assert.equal(unknown.errorCode, 'GATEWAY_SETUP_FAILED');
  assert.equal(client.networkSelectionFeedback(unknown, wifiGuid).saveErrorKey, 'network.errorSetup');
});

test('network read timeout and apply timeout abort work and expose localized fixed errors, never server details', async () => {
  {
    const clock = scheduler(), views = [], calls = [];
    const networks = client.createNetworkSettings(readerOptions(abortablePending(calls), views, clock));
    const reading = networks.start(); clock.fire(10000); await reading;
    assert.ok(calls[0].options.signal.aborted);
    assert.equal(views.at(-1).readErrorKey, 'request.timeout');
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
  {
    const clock = scheduler(), views = [], calls = [];
    let settles = 0, gets = 0;
    const post = abortablePending(calls);
    const networks = client.createNetworkSettings({ ...readerOptions((url, options) => options.method === 'POST' ? post(url, options) :
      ++gets === 1 ? Promise.resolve(response(networksFixture())) : Promise.reject(new TypeError(syntheticLink)), views, clock), onApplySettled() { settles++; } });
    await networks.start(); networks.choose(wifiGuid); const applying = networks.applySelection();
    clock.fire(120000); await advanceRecovery(clock); await applying;
    assert.ok(calls[0].options.signal.aborted);
    assert.equal(views.at(-1).saveErrorKey, 'network.timeout');
    assert.equal(views.at(-1).saving, false); assert.equal(views.at(-1).draftInterfaceGuid, wifiGuid);
    assert.equal(settles, 1);
    networks.stop(); assert.equal(clock.jobs.size, 0);
  }
});

test('disposal aborts either network operation and suppresses late publication and refresh callbacks', async () => {
  for (const mode of ['read', 'save']) {
    const clock = scheduler(), views = [], calls = [];
    let settles = 0;
    const pending = abortablePending(calls);
    const networks = client.createNetworkSettings({ ...readerOptions((url, options) => mode === 'read' || options.method === 'POST' ?
      pending(url, options) : Promise.resolve(response(networksFixture())), views, clock), onApplySettled() { settles++; } });
    let operation = networks.start();
    if (mode === 'save') { await operation; networks.choose(wifiGuid); operation = networks.applySelection(); }
    const count = views.length; networks.stop(); await operation;
    assert.ok(calls[0].options.signal.aborted);
    assert.equal(views.length, count); assert.equal(settles, 0); assert.equal(clock.jobs.size, 0);
  }
});

test('a late network response from an old mount cannot overwrite a new mount', async () => {
  const clock = scheduler(), views = [];
  let resolveOld, count = 0;
  const networks = client.createNetworkSettings(readerOptions(() => ++count === 1 ? new Promise(resolve => { resolveOld = resolve; }) :
    Promise.resolve(response(networksFixture({ selectedInterfaceGuid: ethernetGuid }))), views, clock));
  const old = networks.start(); networks.stop(); await networks.start(); const published = views.length;
  resolveOld(response(networksFixture({ selectedInterfaceGuid: wifiGuid }))); await old;
  assert.equal(views.length, published); assert.equal(views.at(-1).draftInterfaceGuid, ethernetGuid);
  networks.stop(); assert.equal(clock.jobs.size, 0);
});

test('snapshot pause immediately discards secrets, aborts stale polling and will not publish it before a fresh resume', async () => {
  const clock = scheduler(), views = [];
  let resolveOld, calls = 0;
  const reader = client.createSnapshotReader(readerOptions(() => {
    if (++calls === 1) return Promise.resolve(response());
    if (calls === 2) return new Promise(resolve => { resolveOld = resolve; }); // deliberately ignores abort
    return Promise.resolve(response(fixture({ state: 'starting' })));
  }, views, clock));
  await reader.start(); const stale = reader.refresh(); reader.pause();
  assert.equal(views.at(-1).snapshot, null); assert.equal(clock.jobs.size, 0);
  await reader.refresh(); assert.equal(calls, 2);
  resolveOld(response()); await stale;
  assert.equal(views.at(-1).snapshot, null); assert.equal(clock.jobs.size, 0);
  await reader.resume(); assert.equal(calls, 3);
  assert.equal(views.at(-1).snapshot.state, 'starting'); assert.equal(views.at(-1).snapshot.qrDataUrl, null);
  reader.stop(); assert.equal(clock.jobs.size, 0);
});

test('network apply hides the ready snapshot synchronously and fetches state/list afterwards even on failure', async () => {
  const clock = scheduler(), views = [], networkViews = [], posts = [];
  let selected = '', stateReads = 0, networkReads = 0;
  const post = abortablePending(posts);
  const fetch = (url, options) => {
    if (options.method === 'POST') return post(url, options);
    if (url.endsWith('/networks')) { networkReads++; return Promise.resolve(response(networksFixture({ selectedInterfaceGuid: selected }))); }
    stateReads++; return Promise.resolve(response(stateReads === 1 ? fixture() : fixture({ state: 'error', errorCode: 'EADDRINUSE' })));
  };
  const networks = client.createNetworkSettings({ ...readerOptions(fetch, networkViews, clock), onApplyStart: () => reader.pause(), onApplySettled: () => reader.resume() });
  const reader = client.createSnapshotReader({ ...readerOptions(fetch, views, clock), onRefresh: () => { void networks.refresh(); } });
  await Promise.all([networks.start(), reader.start()]);
  assert.equal(views.at(-1).snapshot.launchUrl, syntheticLink);
  networks.choose(wifiGuid); const applying = networks.applySelection();
  assert.equal(views.at(-1).snapshot, null); // no microtask or passive React effect needed
  assert.equal(networkViews.at(-1).saving, true);
  assert.equal(clock.jobs.size, 1); // only the 120-second POST timeout remains
  selected = wifiGuid;
  posts[0].resolve(response({ ok: false, selectedInterfaceGuid: selected, phase: 'error', errorCode: 'EADDRINUSE' }, { ok: false, status: 409 }));
  await applying;
  assert.equal(stateReads, 2); assert.equal(networkReads, 2);
  assert.equal(views.at(-1).snapshot.launchUrl, null); assert.equal(views.at(-1).snapshot.qrDataUrl, null);
  assert.equal(networkViews.at(-1).saveErrorKey, 'network.errorPort');
  networks.stop(); reader.stop(); assert.equal(clock.jobs.size, 0);
});

test('all runtime network errors map to complete RU/EN feedback, including connection status errors', () => {
  const { en, ru } = client.localeDictionaries;
  for (const code of ['NETWORK_SELECTION_UNAVAILABLE', 'NETWORK_QUERY_FAILED', 'NETWORK_SELECTION_INVALID',
    'NETWORK_SELECTION_SAVE_FAILED', 'NETWORK_SELECTION_BUSY', 'GATEWAY_UNAVAILABLE', 'GATEWAY_SETUP_FAILED',
    'EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'IP_ADDRESS_UNAVAILABLE', 'CERTIFICATE_OPERATION_FAILED',
    'HELPER_TIMEOUT', 'HELPER_ABORTED', 'HELPER_FAILED', 'HELPER_PROTOCOL', 'AUTHORITY_REPAIR_REQUIRED',
    'AUTHORITY_INVALID', 'AUTHORITY_EXPIRING', 'PRIVATE_STATE_UNSAFE', 'PUBLIC_DIRECTORY_UNSAFE',
    'PUBLIC_CA_MISMATCH', 'LEAF_CLEANUP_REQUIRED', 'REQUEST_ABORTED', 'SETTINGS_CLOSED', 'REQUEST_INVALID',
    'METHOD_NOT_ALLOWED', 'INTERNAL_ERROR', 'AUTH_REQUIRED', 'FORBIDDEN']) {
    const key = client.networkErrorKey({ code });
    assert.ok(en[key] && ru[key]);
    assert.equal(client.statusDetailKey(client.normalizeSnapshot(fixture({ state: 'error', errorCode: code }))), key);
  }
  for (const kind of ['wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other']) assert.ok(en[`network.${kind}`] && ru[`network.${kind}`]);
  assert.equal(client.networkErrorKey({ code: 'NETWORK_SELECTION_UNAVAILABLE' }), 'network.errorUnavailable');
  assert.equal(client.networkErrorKey({ code: 'GATEWAY_UNAVAILABLE' }), 'network.errorGateway');
  assert.equal(client.networkErrorKey({ code: 'UNAVAILABLE' }), 'network.errorGateway');
  assert.doesNotMatch(en['network.errorUnavailable'], /plugin|enable/i);
  assert.match(en['network.errorUnavailable'], /adapter/);
});

test('network UI wiring is above connection facts, uses labeled controlled selection, shared refresh and owned cleanup', () => {
  const component = source.slice(source.indexOf('function PhoneAccessSettings'), source.indexOf('function PhoneIcon'));
  assert.ok(component.indexOf("text('network.title')") < component.indexOf("className: 'dps-facts'"));
  assert.match(component, /htmlFor: 'dps-network-adapter'/);
  assert.match(component, /h\('select', \{[^]*?value: networkView\.draftInterfaceGuid/);
  assert.match(component, /value: choice\.value, disabled: choice\.missing/);
  assert.match(component, /networkAdapterLabel\(choice\.adapter, text\)/);
  assert.match(component, /text\('network\.savedChoice'\)/);
  assert.match(component, /text\('network\.activeChoice'\)/);
  assert.match(component, /networkView\.network\.activeOrigin \|\| networkView\.network\.activeAddress/);
  assert.match(component, /text\('network\.reachability'\)/);
  assert.match(component, /text\('network\.standbyHint'\)/);
  assert.match(component, /networkRef\.current\.choose\(event\.currentTarget\.value\)/);
  assert.match(component, /disabled: !canApplyNetwork\(networkView\)/);
  assert.match(component, /networkRef\.current\.applySelection\(\)/);
  assert.match(component, /function refreshSettings\(\)[^]*?readerRef\.current\.refresh\(\)[^]*?networkRef\.current\.refresh\(\)/);
  assert.equal(Array.from(component.matchAll(/onClick: refreshSettings/g)).length, 2);
  assert.match(component, /onRefresh: \(\) => \{ void networks\.refresh\(\); \}/);
  assert.match(component, /void networks\.start\(\)/);
  assert.match(component, /networks\.stop\(\)/);
  assert.match(component, /onApplyStart: \(\) => \{\s*reader\.pause\(\);\s*launchRef\.current = null/);
  assert.match(component, /onApplySettled: \(\) => reader\.resume\(\)/);
  assert.match(component, /const snapshot = networkView\.saving \? null : view\.snapshot/);
  assert.match(component, /text\('network\.desktopWarning'\)/);
  assert.match(component, /networkFeedback\.map\(key => text\(key\)\)\.join\(' '\)/);
});
