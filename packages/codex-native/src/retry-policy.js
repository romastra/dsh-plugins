/** Native route owns this policy; the DSH retry executor owns the retry loop. */
import { ultrafastAvailability } from './policy.js';
export const NATIVE_RETRY_DEFAULT = Object.freeze({
  mode: 'normal', maxRetries: 12,
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'STREAM_CLOSED', 'TIMEOUT', 'TRANSPORT']),
  backoff: Object.freeze({ initialDelayMs: 2000, maxDelayMs: 60000, jitterRatio: 0.2 }),
});

export function nativeRetryPolicy(config, resolveRetryPolicy) {
  if (config.allowPortablePiAiHistory !== undefined && typeof config.allowPortablePiAiHistory !== 'boolean') {
    throw new TypeError('codex-native.allowPortablePiAiHistory must be boolean');
  }
  return resolveRetryPolicy(config.retryPolicy ?? NATIVE_RETRY_DEFAULT, 'codex-native.retryPolicy');
}

/** Cache-only readout: no credential read, refresh, metadata fetch or session write. */
export function installRuntimeStatus(ctx, { catalog, capabilities, retryPolicy, config, activeRequests }) {
  const tools = ctx.get('tools');
  if (!tools) return;
  ctx.effect(() => tools.register({
    name: 'codex_native_status',
    description: 'Read Codex Native ownership, retry policy and cached model/Fast/Ultrafast availability without network requests or session changes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    execute() {
      const scope = catalog.scope();
      return {
        revision: 'ultrafast.1', provider: 'openai-codex', owner: 'codex-native',
        retryPolicy, allowPortablePiAiHistory: config.allowPortablePiAiHistory !== false,
        activeRequests: activeRequests(), catalogWarm: Boolean(scope),
        models: catalog.getModels().map(model => {
          const cached = scope ? capabilities.get(scope, model.id) : null;
          return {
            id: model.id, fastAvailable: cached?.available ?? null, stale: cached?.stale ?? true,
            ultrafastAvailable: scope ? ultrafastAvailability(capabilities.get(scope, model.id, 'ultrafast')) : null,
          };
        }),
      };
    },
  }), 'codex-native: cache-only runtime status');
}
