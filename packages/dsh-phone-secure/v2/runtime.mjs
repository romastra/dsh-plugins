import { networkInterfaces } from 'node:os';
import { createDshAuthorizer } from './auth.mjs';
import { isPeerForAdapter, networkIdentity, selectAdapterNetwork } from './net-policy.mjs';
import { writeConnectionArtifacts, writeStandbyArtifacts, writeGatewayStatus } from './artifacts.mjs';
import { discoverAdapters, ensureAuthority, issueServerIdentity } from './windows.mjs';
import { startSecureGateway } from './gateway.mjs';

function addressSnapshot() {
  return JSON.stringify(Object.entries(networkInterfaces()).flatMap(([name, rows]) =>
    (rows ?? []).filter(row => row.family === 'IPv4').map(row => `${name}|${row.address}|${row.cidr}`)).sort());
}
const safeCode = error => /^[A-Z0-9_-]{1,64}$/i.test(error?.code ?? '') ? error.code : 'GATEWAY_SETUP_FAILED';
const stoppedError = () => Object.assign(new Error('Phone gateway has stopped'), { code: 'GATEWAY_UNAVAILABLE' });

/** Context-owned supervisor: list every Windows adapter, bind only its actual ready IPv4. */
export async function startPhoneRuntime({ connection, webServer, config, log = () => {}, dependencies = {} }) {
  const deps = { discoverAdapters, ensureAuthority, issueServerIdentity, startSecureGateway,
    writeConnectionArtifacts, writeStandbyArtifacts, writeGatewayStatus, addressSnapshot, ...dependencies };
  const lifetime = new AbortController();
  let authority;
  try {
    authority = await deps.ensureAuthority({ stateDir: config.stateDir, publicDir: config.outputDir, signal: lifetime.signal });
  } catch (error) {
    await deps.writeStandbyArtifacts({ outputDir: config.outputDir,
      reason: 'Сохранённый ЦС недоступен или требует проверки. HTTPS-вход не запущен; новый корневой сертификат автоматически не создаётся взамен прежнего. Проверьте ошибку расширения на ноутбуке.' }).catch(() => {});
    await deps.writeGatewayStatus(config.outputDir, { version: 2, phase: 'error', errorCode: safeCode(error) }).catch(() => {});
    throw error;
  }
  let stopped = false;
  let active;
  let phase = 'starting';
  let errorCode = null;
  let generation = 0;
  let lastSnapshot = '';
  let lastDiscovery = 0;
  let working;
  let discovering;
  let forced = false;
  let interval;

  async function discover() {
    if (stopped) throw stoppedError();
    if (!discovering) {
      discovering = Promise.resolve().then(() => deps.discoverAdapters({ signal: lifetime.signal }))
        .finally(() => { discovering = undefined; });
    }
    const networks = await discovering;
    if (stopped) throw stoppedError();
    return networks.map(network => ({ ...network }));
  }
  async function report(extra = {}) {
    await deps.writeGatewayStatus(config.outputDir, {
      version: 2, phase, port: config.port, caFingerprint256: authority.fingerprint256,
      selectedInterfaceGuid: config.interfaceGuid, generation, errorCode,
      ...(active ? { origin: active.gateway.origin, network: active.network,
        certificateNotAfter: active.identity.notAfterISO, ...active.gateway.snapshot?.() } : {}), ...extra,
    });
  }
  async function closeActive() {
    const previous = active;
    active = undefined;
    if (!previous) return;
    previous.authorizer.destroy();
    try { await previous.gateway.close(); }
    finally { if (Buffer.isBuffer(previous.identity.pfx)) previous.identity.pfx.fill(0); }
  }
  async function performReconcile(force = false) {
    if (stopped) return;
    const snapshot = deps.addressSnapshot();
    const renewalDue = active && Date.parse(active.identity.notAfterISO) - Date.now() < 14 * 86400000;
    if (!force && snapshot === lastSnapshot && Date.now() - lastDiscovery < 60000 && !renewalDue) return;
    lastSnapshot = snapshot;
    lastDiscovery = Date.now();
    let unownedIdentity;
    try {
      const candidates = await discover();
      if (stopped) return;
      const network = selectAdapterNetwork(candidates, { interfaceGuid: config.interfaceGuid });
      if (!network) {
        phase = 'standby';
        generation++;
        errorCode = 'NETWORK_SELECTION_UNAVAILABLE';
        await closeActive();
        await deps.writeStandbyArtifacts({ outputDir: config.outputDir, authority });
        await report();
        return;
      }
      if (active && networkIdentity(network) === networkIdentity(active.network) && !renewalDue) {
        active.network = network;
        await report();
        return;
      }
      // Revoke the old origin before waiting on shutdown, certificates or artifacts.
      phase = 'switching';
      generation++;
      errorCode = null;
      await closeActive();
      await deps.writeStandbyArtifacts({ outputDir: config.outputDir, authority, reason: 'Обновляется HTTPS-вход для выбранного сетевого адаптера. Подождите несколько секунд и обновите настройки доступа с телефона.' });
      await report({ network });
      const identity = unownedIdentity = await deps.issueServerIdentity({ authorityThumbprint: authority.thumbprint,
        ipAddresses: [network.address], signal: lifetime.signal });
      if (stopped) { if (Buffer.isBuffer(identity.pfx)) identity.pfx.fill(0); return; }
      // DHCP may have changed while Windows was issuing a certificate. Never
      // advertise a certificate/listener for an address no longer on this adapter.
      const verified = selectAdapterNetwork(await discover(), { interfaceGuid: config.interfaceGuid });
      if (stopped || networkIdentity(verified) !== networkIdentity(network)) {
        if (Buffer.isBuffer(identity.pfx)) identity.pfx.fill(0);
        if (!stopped) forced = true;
        return;
      }
      const publicOrigin = `https://${network.address}:${config.port}`;
      const authorizer = createDshAuthorizer({ connection, publicOrigin,
        getUpstream: () => webServer.getOrigin(), isActive: () => !stopped && phase === 'ready' });
      let gateway;
      try {
        gateway = await deps.startSecureGateway({
          host: network.address, port: config.port,
          tlsOptions: { pfx: identity.pfx, passphrase: identity.passphrase },
          authorize: req => authorizer.authorize(req),
          getUpstream: () => webServer.getOrigin(),
          prepareUpstreamHeaders: req => authorizer.prepareUpstreamHeaders(req),
          allowPeer: ip => isPeerForAdapter(ip, network),
          quarantineLimit: config.quarantineLimit, quarantinePerIp: config.quarantinePerIp,
          quarantineMs: config.quarantineMs, headerDeadlineMs: config.headerDeadlineMs,
          maxHeaderBytes: 16384, maxConnections: 128, maxPendingTls: 32, maxPendingHeaders: 32,
        });
      } catch (error) {
        authorizer.destroy();
        if (Buffer.isBuffer(identity.pfx)) identity.pfx.fill(0);
        throw error;
      }
      active = { gateway, network, identity, authorizer };
      unownedIdentity = undefined;
      if (stopped) { await closeActive(); return; }
      await deps.writeConnectionArtifacts({ outputDir: config.outputDir, publicOrigin: gateway.origin,
        phoneUrl: connection.authenticatedUrl(gateway.origin + '/'),
        localUrl: connection.authenticatedUrl(webServer.getOrigin() + '/'), network, authority });
      if (stopped) { await closeActive(); return; }
      phase = 'ready';
      await report();
      log('info', `HTTPS phone entry ready at ${gateway.origin} on the selected ${network.kind} interface`);
    } catch (error) {
      if (Buffer.isBuffer(unownedIdentity?.pfx)) unownedIdentity.pfx.fill(0);
      if (stopped) { await closeActive(); return; }
      phase = 'error';
      generation++;
      errorCode = safeCode(error);
      await closeActive();
      await deps.writeStandbyArtifacts({ outputDir: config.outputDir, authority,
        reason: 'HTTPS-вход не удалось открыть. Он закрыт; Desktop на ноутбуке продолжает работать. Проверьте состояние расширения и доступность выбранного сетевого адаптера.' }).catch(() => {});
      await report().catch(() => {});
      log('warn', `HTTPS phone entry remains closed (${errorCode})`);
    }
  }
  function reconcile(force = false) {
    if (stopped) return Promise.resolve();
    // A forced retry arriving during work is not lost. All callers await the
    // final queued pass; no two passes can issue identities or bind concurrently.
    forced ||= force;
    if (working) return working;
    working = (async () => {
      do {
        const runForced = forced;
        forced = false;
        await performReconcile(runForced);
      } while (forced && !stopped);
    })().finally(() => {
      working = undefined;
      // Also cover a forced call in the promise-finalization microtask gap.
      if (forced && !stopped) return reconcile();
    });
    return working;
  }
  await reconcile(true);
  if (!stopped && dependencies.disableTimer !== true) {
    interval = setInterval(() => { void reconcile().catch(() => {}); }, config.pollIntervalMs);
    interval.unref?.();
  }
  let closing;
  return {
    authority,
    reconcile,
    listNetworks: discover,
    status() { return { phase, origin: active?.gateway.origin, network: active ? { ...active.network } : undefined,
      selectedInterfaceGuid: config.interfaceGuid, errorCode, generation }; },
    close() {
      return closing ??= (async () => {
        stopped = true;
        phase = 'disabled';
        generation++;
        clearInterval(interval);
        lifetime.abort();
        await Promise.allSettled([working, discovering]);
        await closeActive();
        await deps.writeStandbyArtifacts({ outputDir: config.outputDir, authority,
          reason: 'Сетевой HTTPS-вход отключён. Для создания актуальных ссылок включите набор защищённого доступа с телефона.' }).catch(() => {});
        await report().catch(() => {});
      })();
    },
  };
}
