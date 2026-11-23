import test from 'node:test';
import assert from 'node:assert/strict';
import { startPhoneRuntime } from './runtime.mjs';

const wifi = { interfaceGuid: 'wifi', interfaceAlias: 'Wi-Fi', interfaceIndex: 7, kind: 'wifi', address: '192.168.242.8', prefixLength: 24 };
const config = { outputDir: 'C:/fixture/public', stateDir: 'C:/fixture/private', port: 3443, interfaceGuid: '',
  quarantineLimit: 10, quarantinePerIp: 3, quarantineMs: 120000, headerDeadlineMs: 10000, pollIntervalMs: 5000 };
async function fixture(t, options = {}) {
  let networks = options.networks ?? [wifi];
  const events = [];
  const statuses = [];
  const identity = () => ({ pfx: Buffer.from('not-a-real-key'), passphrase: 'not-a-real-password', notAfterISO: new Date(Date.now() + 86400000 * 100).toISOString() });
  const runtime = await startPhoneRuntime({
    connection: { authenticatedUrl: base => base + '?token=fixture' }, webServer: { getOrigin: () => 'http://127.0.0.1:50195' }, config: { ...config, ...options.config },
    dependencies: {
      disableTimer: true,
      ensureAuthority: async () => ({ thumbprint: 'FIXTURE', fingerprint256: 'not-a-real-fingerprint' }),
      discoverAdapters: async () => networks,
      addressSnapshot: () => JSON.stringify(networks),
      issueServerIdentity: async value => { events.push('cert:' + value.ipAddresses[0]); return identity(); },
      startSecureGateway: async options => {
        events.push('open:' + options.host);
        return { origin: `https://${options.host}:${options.port}`, close: async () => { events.push('close:' + options.host); }, snapshot: () => ({ quarantined: 0 }) };
      },
      writeConnectionArtifacts: async value => { events.push('artifacts:' + value.publicOrigin); },
      writeStandbyArtifacts: async () => {},
      writeGatewayStatus: async (_dir, value) => { statuses.push(value); },
      ...options.dependencies,
    },
  });
  t.after(() => runtime.close());
  return { runtime, events, statuses, setNetworks(value) { networks = value; } };
}

test('initial physical LAN creates identity and HTTPS link without changing core origin', async t => {
  const { runtime, events } = await fixture(t);
  assert.equal(runtime.status().phase, 'ready');
  assert.equal(runtime.status().origin, 'https://192.168.242.8:3443');
  assert.deepEqual(events.slice(0, 3), ['cert:192.168.242.8', 'open:192.168.242.8', 'artifacts:https://192.168.242.8:3443']);
});
test('roaming closes old listener before issuing and opening the new identity', async t => {
  const { runtime, events, setNetworks } = await fixture(t);
  setNetworks([{ ...wifi, address: '10.20.0.9', prefixLength: 24 }]);
  await runtime.reconcile(true);
  assert.equal(runtime.status().origin, 'https://10.20.0.9:3443');
  assert.deepEqual(events.slice(3, 7), ['close:192.168.242.8', 'cert:10.20.0.9', 'open:10.20.0.9', 'artifacts:https://10.20.0.9:3443']);
});
test('unavailable adapter closes ingress instead of binding a stale IP', async t => {
  const { runtime, events, setNetworks } = await fixture(t);
  setNetworks([{ ...wifi, kind: 'vpn', address: null, prefixLength: null, available: false, status: 'Disconnected' }]);
  await runtime.reconcile(true);
  assert.equal(runtime.status().phase, 'standby');
  assert.equal(runtime.status().origin, undefined);
  assert.equal(events.at(-1), 'close:192.168.242.8');
});
test('initial authority failure replaces stale ready artifacts and stays closed', async () => {
  const events = [];
  await assert.rejects(startPhoneRuntime({ connection: {}, webServer: {}, config,
    dependencies: { disableTimer: true, ensureAuthority: async () => { const e = new Error('fixed fixture'); e.code = 'AUTHORITY_REPAIR_REQUIRED'; throw e; },
      writeStandbyArtifacts: async value => { events.push({ type: 'standby', authority: value.authority }); },
      writeGatewayStatus: async (_dir, value) => { events.push({ type: 'status', ...value }); },
    } }), { code: 'AUTHORITY_REPAIR_REQUIRED' });
  assert.equal(events[0].type, 'standby');
  assert.equal(events[0].authority, undefined);
  assert.equal(events[1].phase, 'error');
});

test('unchanged selected LAN does not regenerate certificates or listeners', async t => {
  const { runtime, events } = await fixture(t);
  await runtime.reconcile(true);
  assert.equal(events.filter(value => value.startsWith('cert:')).length, 1);
  await runtime.close();
  await runtime.close();
  assert.equal(events.filter(value => value.startsWith('close:')).length, 1);
});

const cable = { ...wifi, interfaceGuid: 'ethernet', interfaceAlias: 'Cable', interfaceIndex: 3, kind: 'ethernet', address: '10.20.0.3' };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('fixed adapter is used instead of preferred Wi-Fi, disappears closed, returns without fallback', async t => {
  const { runtime, setNetworks, events } = await fixture(t, { networks: [wifi, cable], config: { interfaceGuid: 'ethernet' } });
  assert.equal(runtime.status().network.address, cable.address);
  setNetworks([wifi]);
  await runtime.reconcile(true);
  assert.equal(runtime.status().phase, 'standby');
  assert.equal(runtime.status().selectedInterfaceGuid, 'ethernet');
  assert.equal(runtime.status().errorCode, 'NETWORK_SELECTION_UNAVAILABLE');
  assert.equal(events.filter(v => v === 'open:' + wifi.address).length, 0);
  setNetworks([wifi, { ...cable, address: '10.21.0.8' }]);
  await runtime.reconcile(true);
  assert.equal(runtime.status().network.address, '10.21.0.8');
});
test('list includes public/VPN/disconnected adapters and cannot mutate supervisor state', async t => {
  const { runtime, setNetworks } = await fixture(t);
  const rows = [wifi, { ...cable, address: '26.20.1.3', kind: 'virtual' },
    { ...wifi, interfaceGuid: 'vpn', kind: 'vpn' },
    { ...cable, interfaceGuid: 'offline', address: null, prefixLength: null, available: false, status: 'Disconnected' }];
  setNetworks(rows);
  const list = await runtime.listNetworks();
  assert.deepEqual(list, rows);
  list[0].address = '1.2.3.4';
  assert.equal(runtime.status().network.address, wifi.address);
});
test('forced reconciliation during discovery is queued and awaited, never dropped', async t => {
  const gate = deferred(); const entered = deferred();
  let calls = 0;
  const { runtime } = await fixture(t, { dependencies: { discoverAdapters: async () => {
    calls++;
    if (calls === 3) { entered.resolve(); await gate.promise; }
    return [wifi];
  } } });
  const one = runtime.reconcile(true);
  await entered.promise;
  const two = runtime.reconcile(true);
  assert.equal(one, two);
  gate.resolve();
  await two;
  assert.equal(calls, 4, 'the forced retry got its own serialized pass');
  assert.equal(runtime.status().phase, 'ready');
});
test('post-issuance discovery failure wipes the identity before it has an active owner', async t => {
  const pfx = Buffer.from('temporary-identity');
  let calls = 0;
  const { runtime, events } = await fixture(t, { dependencies: {
    discoverAdapters: async () => { if (++calls === 2) throw Object.assign(new Error('private'), { code: 'NETWORK_QUERY_FAILED' }); return [wifi]; },
    issueServerIdentity: async () => ({ pfx, passphrase: 'fixture', notAfterISO: new Date(Date.now() + 100 * 86400000).toISOString() }),
  } });
  assert.equal(runtime.status().phase, 'error');
  assert.equal(runtime.status().errorCode, 'NETWORK_QUERY_FAILED');
  assert.equal(pfx.every(byte => byte === 0), true);
  assert.equal(events.some(value => value.startsWith('open:')), false);
});
test('DHCP change during issuance discards old identity and publishes only the current IP', async t => {
  let calls = 0;
  const oldPfx = Buffer.from('old');
  const later = { ...wifi, address: '192.168.77.8' };
  const issued = [];
  const { runtime, events } = await fixture(t, { dependencies: {
    discoverAdapters: async () => ++calls === 1 ? [wifi] : [later],
    issueServerIdentity: async options => { issued.push(options.ipAddresses[0]); return { pfx: issued.length === 1 ? oldPfx : Buffer.from('new'), passphrase: 'fixture', notAfterISO: new Date(Date.now() + 100 * 86400000).toISOString() }; },
  } });
  assert.deepEqual(issued, [wifi.address, later.address]);
  assert.equal(oldPfx.every(byte => byte === 0), true);
  assert.equal(runtime.status().network.address, later.address);
  assert.equal(events.includes('open:' + wifi.address), false);
});
test('port bind failure has no ready origin, launch artifacts or surviving identity', async t => {
  const pfx = Buffer.from('bind-identity');
  const { runtime, events } = await fixture(t, { dependencies: {
    issueServerIdentity: async () => ({ pfx, passphrase: 'fixture', notAfterISO: new Date(Date.now() + 100 * 86400000).toISOString() }),
    startSecureGateway: async () => { throw Object.assign(new Error('private'), { code: 'EADDRINUSE' }); },
  } });
  assert.equal(runtime.status().phase, 'error');
  assert.equal(runtime.status().errorCode, 'EADDRINUSE');
  assert.equal(runtime.status().origin, undefined);
  assert.equal(events.some(value => value.startsWith('artifacts:')), false);
  assert.equal(pfx.every(byte => byte === 0), true);
});
test('closing during a failed discovery preserves final disabled state and rejects further listing', async t => {
  const entered = deferred(); const gate = deferred();
  let calls = 0;
  const { runtime, statuses } = await fixture(t, { dependencies: { discoverAdapters: async () => {
    if (++calls === 3) { entered.resolve(); await gate.promise; throw Object.assign(new Error('private'), { code: 'HELPER_ABORTED' }); }
    return [wifi];
  } } });
  const reconcile = runtime.reconcile(true);
  await entered.promise;
  const closing = runtime.close();
  gate.resolve();
  await Promise.all([reconcile, closing]);
  assert.equal(runtime.status().phase, 'disabled');
  assert.equal(statuses.at(-1).phase, 'disabled');
  await assert.rejects(runtime.listNetworks(), { code: 'GATEWAY_UNAVAILABLE' });
});
