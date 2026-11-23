import test from 'node:test';
import assert from 'node:assert/strict';
import { isPeerInNetwork, isPeerForAdapter, isBindableIpv4, eligibleNetworks, networkIdentity, selectAdapterNetwork } from './net-policy.mjs';
const wifi = { interfaceGuid: 'wifi-guid', interfaceAlias: 'Wi-Fi', interfaceIndex: 7, kind: 'wifi', address: '192.168.242.8', prefixLength: 24 };
const cable = { interfaceGuid: 'eth-guid', interfaceAlias: 'Ethernet', interfaceIndex: 3, kind: 'ethernet', address: '10.20.1.3', prefixLength: 24 };

test('subnet utility supports every valid prefix including zero', () => {
  assert.equal(isPeerInNetwork('192.168.242.99', wifi), true);
  assert.equal(isPeerInNetwork('::ffff:192.168.242.99', wifi), true);
  assert.equal(isPeerInNetwork('172.19.0.2', wifi), false);
  assert.equal(isPeerInNetwork('10.20.1.4', cable), true);
  assert.equal(isPeerInNetwork('2001:db8::1', wifi), false);
  assert.equal(isPeerInNetwork('26.2.3.4', { ...wifi, prefixLength: 0 }), true);
  assert.equal(isPeerInNetwork('26.2.3.4', { ...wifi, prefixLength: 32 }), false);
});
test('all adapter kinds and public/link-local/loopback IPv4 are eligible; only readiness gates binding', () => {
  for (const kind of ['wifi', 'ethernet', 'virtual', 'vpn', 'tunnel', 'loopback', 'other', 'future-driver-kind']) {
    for (const address of ['192.168.56.1', '26.33.44.55', '169.254.20.30', '127.0.0.1', '100.80.20.30']) {
      const row = { ...wifi, kind, address, prefixLength: 32 };
      assert.equal(selectAdapterNetwork([row]).address, address);
    }
  }
  assert.equal(selectAdapterNetwork([{ ...wifi, available: false }]), undefined);
  assert.deepEqual(eligibleNetworks([{ ...wifi, address: null, prefixLength: null }]), []);
  for (const address of ['0.0.0.0', '0.1.2.3', '224.1.2.3', '255.255.255.255', '192.168.01.2', '::1', 'localhost']) assert.equal(isBindableIpv4(address), false);
});
test('automatic order can prefer Wi-Fi but explicit selection never filters virtual/VPN adapters', () => {
  const vpn = { ...wifi, interfaceGuid: 'vpn-guid', kind: 'vpn', address: '26.1.2.3', prefixLength: 32 };
  assert.equal(selectAdapterNetwork([cable, vpn, wifi]).interfaceGuid, wifi.interfaceGuid);
  assert.equal(selectAdapterNetwork([wifi, vpn], { interfaceGuid: 'VPN-GUID' }).address, '26.1.2.3');
  assert.equal(selectAdapterNetwork([wifi], { interfaceGuid: 'missing' }), undefined);
  assert.equal(selectAdapterNetwork([vpn]).interfaceGuid, vpn.interfaceGuid);
});
test('routed VPN peers are not incorrectly denied by a local /32 prefix', () => {
  const vpn = { ...wifi, kind: 'vpn', address: '100.81.182.70', prefixLength: 32 };
  assert.equal(isPeerForAdapter('100.90.0.2', vpn), true);
  assert.equal(isPeerForAdapter('::ffff:26.99.1.2', vpn), true);
  assert.equal(isPeerForAdapter('127.0.0.1', vpn), true);
  assert.equal(isPeerForAdapter('0.0.0.0', vpn), false);
  assert.equal(isPeerForAdapter('224.0.0.1', vpn), false);
  assert.equal(isPeerForAdapter('2001:db8::1', vpn), false);
});
test('roaming identity changes with adapter, IPv4 or prefix, not unrelated metadata', () => {
  assert.equal(networkIdentity(wifi), networkIdentity({ ...wifi, unusedVpnAddress: '172.19.0.1' }));
  assert.notEqual(networkIdentity(wifi), networkIdentity({ ...wifi, address: '26.5.0.7' }));
  assert.notEqual(networkIdentity(wifi), networkIdentity({ ...wifi, prefixLength: 32 }));
  assert.equal(networkIdentity(undefined), '');
});
