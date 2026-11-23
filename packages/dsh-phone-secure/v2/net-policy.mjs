import { isIPv4 } from 'node:net';

function number(address) {
  return address.split('.').reduce((sum, part) => ((sum << 8) | Number(part)) >>> 0, 0);
}
/** Actual unicast endpoints, not a private-address or adapter-type allowlist. */
export function isBindableIpv4(address) {
  if (typeof address !== 'string' || !isIPv4(address)) return false;
  const first = Number(address.split('.')[0]);
  return first > 0 && first < 224;
}
// Kept as a source-compatible name; LAN is no longer restricted to RFC1918.
export const isLanIpv4 = isBindableIpv4;
export function isPeerInNetwork(address, network) {
  const ip = typeof address === 'string' ? address.replace(/^::ffff:/i, '') : '';
  if (!network || !isBindableIpv4(ip) || !isBindableIpv4(network.address) || !Number.isInteger(network.prefixLength) ||
      network.prefixLength < 0 || network.prefixLength > 32) return false;
  const mask = network.prefixLength === 0 ? 0 : (0xffffffff << (32 - network.prefixLength)) >>> 0;
  return (number(ip) & mask) === (number(network.address) & mask);
}
/** A VPN's /32 local address does not describe its remote peers' source subnet.
 * Binding the exact selected local IP and native DSH authorization, not a
 * guessed source prefix, establish the ingress boundary for routed adapters.
 */
export function isPeerForAdapter(address, network) {
  const ip = typeof address === 'string' ? address.replace(/^::ffff:/i, '') : '';
  return Boolean(network && isBindableIpv4(network.address) && isBindableIpv4(ip));
}
export function networkIdentity(network) {
  if (!network) return '';
  return `${String(network.interfaceGuid).toLowerCase()}|${network.address}/${network.prefixLength}`;
}
export function eligibleNetworks(candidates) {
  // Only readiness/address validity are needed to bind. Inventory is kept
  // separately and includes unavailable, virtual, tunnel and unknown adapters.
  return Array.isArray(candidates) ? candidates.filter(item => item && item.available !== false &&
    typeof item.interfaceGuid === 'string' && item.interfaceGuid && isBindableIpv4(item.address) &&
    Number.isInteger(item.prefixLength) && item.prefixLength >= 0 && item.prefixLength <= 32) : [];
}
export function selectAdapterNetwork(candidates, { interfaceGuid = '' } = {}) {
  const valid = eligibleNetworks(candidates);
  const selected = interfaceGuid ? valid.filter(item => item.interfaceGuid.toLowerCase() === interfaceGuid.toLowerCase()) : valid;
  const rank = network => network.kind === 'wifi' ? 0 : network.kind === 'ethernet' ? 1 :
    network.kind === 'loopback' ? 3 : 2;
  return selected.toSorted((a, b) => rank(a) - rank(b) || a.interfaceIndex - b.interfaceIndex || a.address.localeCompare(b.address))[0];
}
// Legacy callers remain compatible, without retaining the old physical filter.
export const selectPhysicalNetwork = selectAdapterNetwork;
