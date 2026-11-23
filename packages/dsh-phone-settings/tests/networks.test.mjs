import test from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneNetworkSettings, normalizeSelection } from '../networks.mjs';
import { createPhoneAccessSettingsRoutes, NETWORKS_PATH, NETWORK_PATH } from '../service.mjs';
const wifi = { interfaceGuid: '11111111-1111-4111-8111-111111111111', interfaceAlias: 'Wi-Fi', interfaceIndex: 7, kind: 'wifi', address: '192.168.1.2', prefixLength: 24 };
const cable = { ...wifi, interfaceGuid: '22222222-2222-4222-8222-222222222222', interfaceAlias: 'Ethernet', interfaceIndex: 3, kind: 'ethernet', address: '10.20.1.2' };
function setup(options = {}) {
  const entry = { options: { config: { port: 63819, interfaceGuid: options.selected ?? '', otherSetting: 'preserved' } } };
  let rows = [wifi, cable];
  let calls = 0;
  let saved = 0;
  let gateway;
  const makeGateway = () => ({ entry, selectedInterfaceGuid: entry.options.config.interfaceGuid,
    async listNetworks() { calls++; if (options.listGate) await options.listGate; if (options.listError) throw options.listError; return rows; },
    async reconcile() { calls++; }, status: () => ({ phase: options.phase ?? 'ready', errorCode: options.errorCode ?? null }) });
  gateway = makeGateway();
  const editor = { async edit(target, change) {
    assert.equal(target, entry); saved++;
    if (options.saveError) throw new Error('not reflected raw profile diagnostic');
    entry.options.config = change({ ...entry.options.config }, {});
    gateway = makeGateway(); // Normal Loader restart after durable config write.
  } };
  const controller = createPhoneNetworkSettings({ getGateway: () => gateway, getEditor: () => options.noEditor ? undefined : editor });
  return { controller, entry, stats: () => ({ calls, saved }), setRows: value => { rows = value; }, stopGateway: () => { gateway = undefined; } };
}
test('canonical selection validation accepts only empty or exact GUID, never commands/addresses', () => {
  assert.equal(normalizeSelection(''), '');
  assert.equal(normalizeSelection(wifi.interfaceGuid.toUpperCase()), wifi.interfaceGuid);
  for (const value of [undefined, null, 1, {}, [], 'Wi-Fi', wifi.address, '{' + wifi.interfaceGuid + '}', ' ' + wifi.interfaceGuid, 'a;exit']) {
    assert.throws(() => normalizeSelection(value), { code: 'NETWORK_SELECTION_INVALID' });
  }
});
test('networks returns current choice, fresh physical candidates and one deterministic IP per adapter', async () => {
  const f = setup({ selected: cable.interfaceGuid });
  f.setRows([cable, { ...wifi, address: '192.168.1.3' }, wifi]);
  const result = await f.controller.networks();
  assert.equal(result.available, true); assert.equal(result.selectedInterfaceGuid, cable.interfaceGuid);
  assert.deepEqual(result.adapters, [wifi, cable].map(row => ({ ...row, status: 'Up', available: true })));
  f.setRows([wifi]);
  const missing = await f.controller.networks();
  assert.equal(missing.selectedInterfaceGuid, cable.interfaceGuid);
  assert.equal(missing.adapters.some(row => row.interfaceGuid === cable.interfaceGuid), false);
  await f.controller.close();
});
test('selection persists through ConfigEditor and normal reload, preserving every unrelated config', async () => {
  const f = setup();
  const result = await f.controller.selectNetwork(cable.interfaceGuid);
  assert.deepEqual(result, { ok: true, selectedInterfaceGuid: cable.interfaceGuid, phase: 'ready', errorCode: null });
  assert.deepEqual(f.entry.options.config, { interfaceGuid: cable.interfaceGuid, port: 63819, otherSetting: 'preserved' });
  assert.equal((await f.controller.networks()).selectedInterfaceGuid, cable.interfaceGuid);
  assert.equal(f.stats().saved, 1);
  await f.controller.selectNetwork(cable.interfaceGuid);
  assert.equal(f.stats().saved, 1, 'retry reconciles same adapter, does not restart or rewrite config');
  assert.equal((await f.controller.selectNetwork('')).ok, true);
  assert.equal(f.entry.options.config.interfaceGuid, '');
  await f.controller.close();
});
test('missing selection, invalid input, absent editor or save failure never claim to have saved', async () => {
  for (const [options, value, errorCode] of [
    [{}, 'not-a-guid', 'NETWORK_SELECTION_INVALID'],
    [{}, '33333333-3333-4333-8333-333333333333', 'NETWORK_SELECTION_UNAVAILABLE'],
    [{ noEditor: true }, cable.interfaceGuid, 'NETWORK_SELECTION_SAVE_FAILED'],
    [{ saveError: true }, cable.interfaceGuid, 'NETWORK_SELECTION_SAVE_FAILED'],
    [{ listError: Object.assign(new Error('raw'), { code: 'NETWORK_QUERY_FAILED' }) }, cable.interfaceGuid, 'NETWORK_QUERY_FAILED'],
  ]) {
    const f = setup(options);
    assert.deepEqual(await f.controller.selectNetwork(value), { ok: false, errorCode });
    assert.equal(f.entry.options.config.interfaceGuid, '');
    await f.controller.close();
  }
});
test('setup/bind failure explicitly reports persisted choice and leaves retry available', async () => {
  const f = setup({ phase: 'error', errorCode: 'EADDRINUSE' });
  assert.deepEqual(await f.controller.selectNetwork(cable.interfaceGuid), { ok: false, selectedInterfaceGuid: cable.interfaceGuid, phase: 'error', errorCode: 'EADDRINUSE' });
  assert.equal(f.entry.options.config.interfaceGuid, cable.interfaceGuid);
  await f.controller.close();
});
test('all kinds, ranges and unavailable adapters stay visible; only malformed inventory fails validation', async () => {
  const f = setup(); f.stopGateway();
  assert.equal((await f.controller.networks()).errorCode, 'GATEWAY_UNAVAILABLE');
  assert.equal((await f.controller.selectNetwork('')).errorCode, 'GATEWAY_UNAVAILABLE');
  await f.controller.close();
  const g = setup({ phase: 'standby', errorCode: 'NETWORK_SELECTION_UNAVAILABLE' });
  for (const kind of ['vpn', 'virtual', 'tunnel', 'loopback', 'other', 'future-kind']) {
    g.setRows([{ ...wifi, kind, address: '26.1.2.3', prefixLength: 32 }]);
    const result = await g.controller.networks();
    assert.equal(result.available, true);
    assert.equal(result.adapters[0].kind, kind);
    assert.equal(result.adapters[0].address, '26.1.2.3');
  }
  g.setRows([{ ...wifi, interfaceIndex: 0, kind: 'virtual', address: null, prefixLength: null, available: false, status: 'Disconnected' }]);
  const unavailable = await g.controller.networks();
  assert.equal(unavailable.available, true);
  assert.equal(unavailable.adapters.length, 1);
  assert.equal(unavailable.adapters[0].available, false);
  const applied = await g.controller.selectNetwork(wifi.interfaceGuid);
  assert.equal(applied.phase, 'standby');
  assert.equal(applied.selectedInterfaceGuid, wifi.interfaceGuid, 'unavailable but existing adapter GUID can still be saved');
  assert.equal(g.entry.options.config.interfaceGuid, wifi.interfaceGuid);
  g.setRows([{ ...wifi, interfaceGuid: 'not-a-guid' }]);
  assert.equal((await g.controller.networks()).errorCode, 'NETWORK_QUERY_FAILED');
  await g.controller.close();
});
test('overlapping selects reject BUSY; close/cancel during discovery prevents a profile mutation', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup({ listGate: gate });
  const ac = new AbortController();
  const one = f.controller.selectNetwork(cable.interfaceGuid, { signal: ac.signal });
  assert.equal(f.controller.isApplying(), true);
  assert.deepEqual(await f.controller.selectNetwork(''), { ok: false, errorCode: 'NETWORK_SELECTION_BUSY' });
  ac.abort(); release();
  assert.equal((await one).errorCode, 'REQUEST_ABORTED');
  assert.equal(f.stats().saved, 0);
  assert.equal(f.controller.isApplying(), false);
  await f.controller.close();
  assert.equal((await f.controller.selectNetwork('')).errorCode, 'SETTINGS_CLOSED');
});
test('fresh inventory exposes exact saved and active gateway proof without launch credentials', async () => {
  const active = { ...wifi, interfaceAlias: 'A'.repeat(200), kind: 'vpn', address: '26.1.2.3', prefixLength: 32, status: 'Up', available: true };
  let phase = 'ready';
  const gateway = { selectedInterfaceGuid: wifi.interfaceGuid, listNetworks: async () => [active],
    status: () => ({ phase, origin: 'https://26.1.2.3:63819', network: active, errorCode: null }) };
  const controller = createPhoneNetworkSettings({ getGateway: () => gateway, getEditor: () => undefined });
  const result = await controller.networks();
  assert.equal(result.available, true);
  assert.equal(result.adapters[0].interfaceAlias.length, 200);
  assert.equal(result.phase, 'ready');
  assert.equal(result.selectedInterfaceGuid, wifi.interfaceGuid);
  assert.equal(result.activeInterfaceGuid, wifi.interfaceGuid);
  assert.equal(result.activeAddress, '26.1.2.3');
  assert.equal(result.activeOrigin, 'https://26.1.2.3:63819');
  assert.equal(result.gatewayErrorCode, null);
  assert.equal(JSON.stringify(result).includes('token'), false);
  phase = 'switching';
  assert.equal((await controller.networks()).phase, 'switching', 'late reads must not retain a cached ready proof');
  await controller.close();
});
const peer = { id: 'native-browser', principal: { kind: 'owner' }, signal: new AbortController().signal };
const connection = { browserPeer: peer, admit: () => ({ peer }) };
const base = 'http://127.0.0.1:51115';
function post(body = { interfaceGuid: cable.interfaceGuid }, headers = {}) {
  return new Request(base + NETWORK_PATH, { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers,
  }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
function routeFixture(conn = connection, options = {}) {
  const calls = [];
  const business = { async networks() { return { available: true, selectedInterfaceGuid: '', adapters: [wifi], errorCode: null }; },
    async selectNetwork(value) { calls.push(value); return { ok: true, selectedInterfaceGuid: value, phase: 'ready', errorCode: null }; } };
  const routes = createPhoneAccessSettingsRoutes(conn, {}, business, options);
  return { calls, listing: routes.find(row => row.path === NETWORKS_PATH), mutation: routes.find(row => row.path === NETWORK_PATH) };
}
test('native same-origin owner GET/POST use the same controller without launch data', async () => {
  const { calls, listing, mutation } = routeFixture();
  const read = await listing.fetch(new Request(base + NETWORKS_PATH));
  assert.equal(read.status, 200); assert.equal((await read.json()).available, true);
  const response = await mutation.fetch(post());
  assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
  assert.deepEqual(calls, [cable.interfaceGuid]);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
test('POST rejects cross-origin, missing Origin, cross-site, simple content types and non-browser API Peer', async () => {
  const f = routeFixture();
  for (const [headers, expected] of [
    [{ Origin: 'https://attacker.invalid' }, 403], [{ Origin: 'null' }, 403],
    [{ Origin: '' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403], [{ 'Sec-Fetch-Site': 'same-site' }, 403],
    [{ 'Content-Type': 'text/plain' }, 415], [{ 'Content-Type': 'application/x-www-form-urlencoded' }, 415],
  ]) assert.equal((await f.mutation.fetch(post(undefined, headers))).status, expected);
  assert.equal(f.calls.length, 0);
  const api = routeFixture({ ...connection, admit: () => ({ peer: { ...peer, id: 'api-owner' } }) });
  assert.equal((await api.mutation.fetch(post())).status, 403);
  assert.equal(api.calls.length, 0);
});
test('POST rejects malformed/oversized/extra fields and wrong routes before any mutation', async () => {
  const f = routeFixture();
  for (const body of ['{', 'null', '[]', '{}', '{"interfaceGuid":4}', { interfaceGuid: cable.interfaceGuid, address: '8.8.8.8' },
    { interfaceGuid: cable.interfaceGuid, port: 80 }, { interfaceGuid: 'unsafe' }]) {
    assert.equal((await f.mutation.fetch(post(body))).status, 400);
  }
  assert.equal((await f.mutation.fetch(post(' '.repeat(1025)))).status, 413);
  assert.equal((await f.mutation.fetch(new Request(base + NETWORK_PATH))).status, 405);
  assert.equal(f.calls.length, 0);
});

test('real native bridge URL uses admitted Host and actual carrier protocol, not dsh.internal origin', async () => {
  const f = routeFixture(connection, { getCarrierOrigin: () => base });
  const request = (host, origin) => new Request('http://dsh.internal' + NETWORK_PATH, {
    method: 'POST', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ interfaceGuid: cable.interfaceGuid }),
  });
  assert.equal((await f.mutation.fetch(request('127.0.0.1:51115', base))).status, 200);
  assert.equal((await f.mutation.fetch(request('localhost:51115', 'http://localhost:51115'))).status, 200);
  for (const origin of ['http://dsh.internal', 'http://attacker.invalid', base + '/', 'https://127.0.0.1:51115', 'null']) {
    assert.equal((await f.mutation.fetch(request('127.0.0.1:51115', origin))).status, 403);
  }
  assert.equal(f.calls.length, 2);
  assert.equal(f.mutation.requestBody, 'streaming', 'core must not pre-buffer the request before the 1KiB bound');
});
