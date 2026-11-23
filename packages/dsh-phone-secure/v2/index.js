import { isAbsolute, relative, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPhoneRuntime } from './runtime.mjs';

export const name = 'secure-phone-lan';
export const inject = ['connection', 'webServer'];
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function resolveConfig(input = {}) {
  const config = {
    port: 63819, interfaceGuid: '', quarantineLimit: 10, quarantinePerIp: 3,
    quarantineMs: 120000, headerDeadlineMs: 10000, pollIntervalMs: 5000, ...input,
  };
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 3080) {
    throw new Error('Use a new HTTPS port from 1024 to 65535, not the retired HTTP port 3080');
  }
  for (const name of ['outputDir', 'stateDir']) {
    if (typeof config[name] !== 'string' || !isAbsolute(config[name])) throw new Error(`${name} must be an absolute path`);
    config[name] = resolve(config[name]);
    const insidePackage = relative(packageRoot, config[name]);
    if (!insidePackage || (!insidePackage.startsWith('..') && !isAbsolute(insidePackage))) {
      throw new Error(`${name} must not be inside public plugin package assets`);
    }
  }
  const between = relative(config.outputDir, config.stateDir);
  const reverse = relative(config.stateDir, config.outputDir);
  if (!between || (!between.startsWith('..') && !isAbsolute(between)) ||
      (!reverse.startsWith('..') && !isAbsolute(reverse))) throw new Error('Private state and public artifacts must be separate sibling directories');
  if (typeof config.interfaceGuid !== 'string' || (config.interfaceGuid !== '' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.interfaceGuid))) {
    throw new Error('interfaceGuid must be empty (automatic) or a network adapter GUID');
  }
  config.interfaceGuid = config.interfaceGuid.toLowerCase();
  for (const [name, min, max] of [['quarantineLimit', 1, 10], ['quarantinePerIp', 1, Math.min(3, config.quarantineLimit)],
    ['quarantineMs', 1000, 120000], ['headerDeadlineMs', 1000, 10000], ['pollIntervalMs', 1000, 30000]]) {
    if (!Number.isInteger(config[name]) || config[name] < min || config[name] > max) throw new Error(`Invalid bounded setting: ${name}`);
  }
  return config;
}

export async function apply(ctx, input) {
  const config = resolveConfig(input);
  await ctx.effect(async () => {
    const runtime = await startPhoneRuntime({ connection: ctx.connection, webServer: ctx.webServer, config,
      log: (level, text) => ctx.logger('secure-phone-lan')[level](text) });
    // Optional consumers use ctx.get(), not a hard injection: saving this row's
    // config must be able to restart the gateway without disposing their request.
    let unprovide;
    try {
      unprovide = ctx.provide('phoneSecure', Object.freeze({
        entry: ctx.fiber.entry,
        selectedInterfaceGuid: config.interfaceGuid,
        listNetworks: () => runtime.listNetworks(),
        status: () => runtime.status(),
        reconcile: () => runtime.reconcile(true),
      }));
    } catch (error) { await runtime.close(); throw error; }
    return async () => { await unprovide(); await runtime.close(); };
  });
}
