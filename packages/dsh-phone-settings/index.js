import { createPhoneAccessSettings, createPhoneAccessSettingsRoutes } from './service.mjs';
import { createPhoneNetworkSettings } from './networks.mjs';

export const inject = ['connection', 'tools', 'webServer'];

export function apply(ctx, config) {
  const connection = ctx.connection;
  const networks = createPhoneNetworkSettings({
    getGateway: () => ctx.get('phoneSecure'), getEditor: () => ctx.get('configEditor'),
  });
  const facade = createPhoneAccessSettings({ connection, config, dependencies: {
    getGateway: () => ctx.get('phoneSecure'), isApplying: () => networks.isApplying(),
  } });
  ctx.effect(() => async () => { await networks.close(); await facade.close(); }, 'phone-access-settings: scope');
  ctx.provide('phoneAccessSettings', networks);
  for (const route of createPhoneAccessSettingsRoutes(connection, facade, networks, { getCarrierOrigin: () => ctx.webServer.getOrigin() })) {
    ctx.effect(() => connection.fetch.register(route), `phone-access-settings: ${route.path}`);
  }
  ctx.effect(() => ctx.tools.register({
    name: 'phone_network', deferLoading: true,
    description: 'List all network adapters, including virtual, VPN, hidden, disconnected and no-IPv4 interfaces, or select the adapter used for secure phone access. Empty interfaceGuid selects an available adapter automatically. Listing includes saved choice and active gateway/IP state for outcome verification. Selection is saved through DSH ConfigEditor, closes the previous HTTPS listener and prepares the selected IP, certificate and Settings QR. Does not return secret links or QR. A phone connection can be interrupted when switching; prefer Desktop. Does not enable a disabled plugin or elevate firewall access.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['list', 'select'] },
        interfaceGuid: { type: 'string', description: 'For select: exact adapter GUID from list, or empty string for automatic selection.' },
      }, required: ['action'], additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 120000,
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['action', 'interfaceGuid'].includes(key))) {
        return { ok: false, errorCode: 'REQUEST_INVALID' };
      }
      if (args.action === 'list' && args.interfaceGuid === undefined) return networks.networks();
      if (args.action === 'select' && typeof args.interfaceGuid === 'string') return networks.selectNetwork(args.interfaceGuid, { signal: exec.signal });
      return { ok: false, errorCode: 'REQUEST_INVALID' };
    },
  }), 'phone-access-settings: shared network operation');
}
