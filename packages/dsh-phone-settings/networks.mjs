/** One Host business operation for the Settings page and the agent tool.
 * Persistence belongs to ConfigEditor, never a hand-written profile patch or
 * the CA's private directory. No launch tokens/cookies/keys enter this module.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_ERRORS = new Set(['NETWORK_QUERY_FAILED', 'NETWORK_SELECTION_UNAVAILABLE',
  'NETWORK_SELECTION_INVALID', 'NETWORK_SELECTION_SAVE_FAILED', 'NETWORK_SELECTION_BUSY',
  'GATEWAY_UNAVAILABLE', 'GATEWAY_SETUP_FAILED', 'EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL', 'HELPER_TIMEOUT', 'HELPER_ABORTED',
  'HELPER_FAILED', 'HELPER_PROTOCOL', 'IP_ADDRESS_UNAVAILABLE', 'CERTIFICATE_OPERATION_FAILED',
  'AUTHORITY_REPAIR_REQUIRED', 'AUTHORITY_INVALID', 'AUTHORITY_EXPIRING', 'PRIVATE_STATE_UNSAFE',
  'PUBLIC_DIRECTORY_UNSAFE', 'PUBLIC_CA_MISMATCH', 'LEAF_CLEANUP_REQUIRED', 'SETTINGS_CLOSED', 'REQUEST_ABORTED']);
const codeOf = (error, fallback) => KNOWN_ERRORS.has(error?.code) ? error.code : fallback;
const failure = (errorCode, extra = {}) => ({ ok: false, errorCode, ...extra });
export function normalizeSelection(value) {
  if (typeof value !== 'string' || (value !== '' && !GUID.test(value))) {
    throw Object.assign(new Error('Invalid adapter GUID'), { code: 'NETWORK_SELECTION_INVALID' });
  }
  return value.toLowerCase();
}
export function isAdapterIpv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false;
  return Number(parts[0]) > 0 && Number(parts[0]) < 224;
}
const safeText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
function candidates(rows) {
  if (!Array.isArray(rows) || rows.length > 4096) throw new Error('Invalid network query');
  const result = rows.map(row => {
    if (!row || !GUID.test(row.interfaceGuid ?? '') || !safeText(row.kind, 64) || !safeText(row.interfaceAlias, 1024) ||
        !Number.isInteger(row.interfaceIndex) || row.interfaceIndex < 0 || row.interfaceIndex > 2147483647 ||
        (row.available !== undefined && typeof row.available !== 'boolean') ||
        (row.status !== undefined && !safeText(row.status, 100))) throw new Error('Invalid network query');
    const hasAddress = isAdapterIpv4(row.address) && Number.isInteger(row.prefixLength) && row.prefixLength >= 0 && row.prefixLength <= 32;
    const available = row.available ?? hasAddress;
    if (available && (!hasAddress || row.interfaceIndex < 1)) throw new Error('Invalid network query');
    return { interfaceGuid: row.interfaceGuid.toLowerCase(), interfaceAlias: row.interfaceAlias,
      interfaceIndex: row.interfaceIndex, kind: row.kind, address: hasAddress ? row.address : null,
      prefixLength: hasAddress ? row.prefixLength : null, status: row.status ?? (available ? 'Up' : 'Unavailable'), available };
  });
  const rank = row => row.kind === 'wifi' ? 0 : row.kind === 'ethernet' ? 1 : row.kind === 'loopback' ? 3 : 2;
  result.sort((a, b) => rank(a) - rank(b) || a.interfaceIndex - b.interfaceIndex ||
    Number(b.available) - Number(a.available) || (a.address ?? '').localeCompare(b.address ?? ''));
  // Group multiple IP rows of one adapter, never remove an adapter by kind,
  // connectivity, address range, default gateway, or availability.
  return result.filter((row, index) => result.findIndex(other => other.interfaceGuid === row.interfaceGuid) === index);
}
export function createPhoneNetworkSettings({ getGateway, getEditor }) {
  let closed = false;
  let busy = false;
  let pending;
  let lastSelected = '';
  const current = () => closed ? undefined : getGateway();
  function health(gateway) {
    const state = gateway?.status();
    const phases = ['ready', 'standby', 'error', 'starting', 'switching', 'disabled'];
    const activeAddress = isAdapterIpv4(state?.network?.address) ? state.network.address : null;
    const activeInterfaceGuid = GUID.test(state?.network?.interfaceGuid ?? '') ? state.network.interfaceGuid.toLowerCase() : null;
    let activeOrigin = null;
    try {
      const url = new URL(state.origin);
      if (activeAddress && url.protocol === 'https:' && url.hostname === activeAddress &&
          !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && url.origin === state.origin) activeOrigin = url.origin;
    } catch {}
    return { phase: phases.includes(state?.phase) ? state.phase : 'unavailable',
      activeInterfaceGuid, activeAddress, activeOrigin,
      gatewayErrorCode: KNOWN_ERRORS.has(state?.errorCode) ? state.errorCode : state?.phase === 'error' ? 'GATEWAY_SETUP_FAILED' : null };
  }
  function statusResult(gateway) {
    const state = gateway.status();
    const selectedInterfaceGuid = normalizeSelection(gateway.selectedInterfaceGuid);
    lastSelected = selectedInterfaceGuid;
    return { selectedInterfaceGuid, phase: state.phase,
      errorCode: KNOWN_ERRORS.has(state.errorCode) ? state.errorCode : state.phase === 'error' ? 'GATEWAY_SETUP_FAILED' : null };
  }
  return Object.freeze({
    async networks() {
      const gateway = current();
      if (!gateway) return { available: false, selectedInterfaceGuid: lastSelected, adapters: [],
        errorCode: closed ? 'SETTINGS_CLOSED' : 'GATEWAY_UNAVAILABLE', ...health() };
      try {
        lastSelected = normalizeSelection(gateway.selectedInterfaceGuid);
        const adapters = candidates(await gateway.listNetworks());
        if (current() !== gateway) return { available: false, selectedInterfaceGuid: lastSelected, adapters: [], errorCode: 'GATEWAY_UNAVAILABLE', ...health() };
        return { available: true, selectedInterfaceGuid: lastSelected, adapters, errorCode: null, ...health(gateway) };
      } catch (error) {
        return { available: false, selectedInterfaceGuid: lastSelected, adapters: [], errorCode: codeOf(error, 'NETWORK_QUERY_FAILED'), ...health(gateway) };
      }
    },
    selectNetwork(value, { signal } = {}) {
      let selected;
      try { selected = normalizeSelection(value); }
      catch { return Promise.resolve(failure('NETWORK_SELECTION_INVALID')); }
      if (closed) return Promise.resolve(failure('SETTINGS_CLOSED'));
      if (busy) return Promise.resolve(failure('NETWORK_SELECTION_BUSY'));
      if (signal?.aborted) return Promise.resolve(failure('REQUEST_ABORTED'));
      busy = true;
      pending = (async () => {
        let gateway = current();
        if (!gateway) return failure('GATEWAY_UNAVAILABLE');
        // Validate against fresh actual Windows records before persisting. A
        // removed fixed adapter is never silently replaced by another one.
        let adapters;
        try { adapters = candidates(await gateway.listNetworks()); }
        catch (error) { return failure(codeOf(error, 'NETWORK_QUERY_FAILED')); }
        if (closed) return failure('SETTINGS_CLOSED');
        if (signal?.aborted) return failure('REQUEST_ABORTED');
        if (current() !== gateway) return failure('GATEWAY_UNAVAILABLE');
        if (selected && !adapters.some(row => row.interfaceGuid === selected)) return failure('NETWORK_SELECTION_UNAVAILABLE');
        if (normalizeSelection(gateway.selectedInterfaceGuid) !== selected) {
          const editor = getEditor();
          if (!editor || !gateway.entry) return failure('NETWORK_SELECTION_SAVE_FAILED');
          try {
            await editor.edit(gateway.entry, config => ({ ...config, interfaceGuid: selected }));
          } catch { return failure('NETWORK_SELECTION_SAVE_FAILED'); }
          // ConfigEditor awaits the gateway's normal Loader teardown/startup.
          // The Settings route remains alive because it did not inject it.
          gateway = current();
          if (!gateway) return failure(closed ? 'SETTINGS_CLOSED' : 'GATEWAY_UNAVAILABLE', { selectedInterfaceGuid: selected });
        } else {
          try { await gateway.reconcile(); }
          catch (error) { return failure(codeOf(error, 'GATEWAY_SETUP_FAILED')); }
        }
        if (closed) return failure('SETTINGS_CLOSED');
        if (current() !== gateway) return failure('GATEWAY_UNAVAILABLE');
        const result = statusResult(gateway);
        if (result.selectedInterfaceGuid !== selected) return failure('NETWORK_SELECTION_SAVE_FAILED', result);
        return { ok: result.phase === 'ready', ...result,
          errorCode: result.phase === 'ready' ? null : result.errorCode ?? 'NETWORK_SELECTION_UNAVAILABLE' };
      })().catch(error => failure(codeOf(error, 'GATEWAY_SETUP_FAILED'))).finally(() => { busy = false; pending = undefined; });
      return pending;
    },
    isApplying: () => busy,
    async close() { closed = true; await pending; },
  });
}
