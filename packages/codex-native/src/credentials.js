/** OAuth-only adapter over the injected host credential service. No ambient sources. */
export const CODEX_PROVIDER = 'openai-codex';

export class CodexCredentialError extends Error {
  constructor(code) {
    const messages = {
      CODEX_CREDENTIAL_PROVIDER: 'This credential bridge only supports the Codex route.',
      CODEX_CREDENTIAL_TYPE: 'The Codex route requires a stored OAuth grant.',
      CODEX_CREDENTIAL_SERVICE: 'The Codex credential service is unavailable.',
    };
    super(messages[code] ?? messages.CODEX_CREDENTIAL_SERVICE);
    this.name = 'CodexCredentialError';
    this.code = code;
  }
}

function oauthPayload(record) {
  if (record === undefined) return undefined;
  if (record?.kind !== 'grant' || record.payload?.type !== 'oauth') {
    throw new CodexCredentialError('CODEX_CREDENTIAL_TYPE');
  }
  return record.payload;
}

// Match the native bridge's JSON image, not JSON.stringify's lossy coercions.
// Invalid numbers/prototypes remain invalid so the host store can reject them.
function jsonImage(value) {
  if (Array.isArray(value)) return value.map(member => member === undefined ? null : jsonImage(member));
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .map(([key, member]) => [key, jsonImage(member)]));
  }
  return value;
}

/**
 * recordKeyFor is the native adapter's exported function. onCredential is a
 * trusted, request-local observer of the SAME private payload (never public UI).
 * It runs after a read or committed write and outside the host record lock.
 * Throwing from it can reject a request but cannot roll back a rotated grant.
 */
export function createCredentialBridge({ credentials, recordKeyFor, onCredential } = {}) {
  if (!credentials || typeof credentials.readRecord !== 'function' ||
      typeof credentials.describeRecord !== 'function' || typeof credentials.modifyRecord !== 'function' ||
      typeof recordKeyFor !== 'function' || (onCredential !== undefined && typeof onCredential !== 'function')) {
    throw new CodexCredentialError('CODEX_CREDENTIAL_SERVICE');
  }
  const key = recordKeyFor(CODEX_PROVIDER);
  const assertProvider = provider => {
    if (provider !== CODEX_PROVIDER) throw new CodexCredentialError('CODEX_CREDENTIAL_PROVIDER');
  };
  const observed = async record => {
    const payload = oauthPayload(record);
    await onCredential?.(payload);
    return payload;
  };
  return {
    async read(provider) {
      assertProvider(provider);
      return observed(await credentials.readRecord(key));
    },
    async list() {
      const metadata = await credentials.describeRecord(key);
      if (!metadata?.configured) return [];
      if (metadata.kind !== 'grant') throw new CodexCredentialError('CODEX_CREDENTIAL_TYPE');
      return [{ providerId: CODEX_PROVIDER, type: 'oauth' }];
    },
    async modify(provider, mutate, options) {
      assertProvider(provider);
      // The host service has a two-argument modifyRecord contract. Do not race
      // or cancel it after refresh starts: a refresh token may already rotate.
      options?.signal?.throwIfAborted();
      const committed = await credentials.modifyRecord(key, async current => {
        const next = await mutate(oauthPayload(current));
        if (next === undefined) return undefined; // host means preserve, not delete
        if (next?.type !== 'oauth') throw new CodexCredentialError('CODEX_CREDENTIAL_TYPE');
        return { kind: 'grant', payload: jsonImage(next) };
      });
      return observed(committed);
    },
  };
}
