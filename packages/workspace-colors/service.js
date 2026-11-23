import { PALETTE, PALETTE_SOURCE, isColor } from './palette.js';

export const ENDPOINT = 'workspace-colors/operate';
export const TOOL_PARAMETERS = {
  type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'set'] },
    workspaceId: { type: 'string', description: 'For set: exact Workspace ID returned by list.' },
    color: { oneOf: [{ type: 'integer', minimum: 1, maximum: 15 }, { type: 'null' }], description: 'For set: MSX index 1–15, or null to remove the accent.' },
    expectedColor: { oneOf: [{ type: 'integer', minimum: 1, maximum: 15 }, { type: 'null' }], description: 'Optional compare-and-set guard; null means no existing accent.' },
  }, required: ['action'], additionalProperties: false,
};

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function createWorkspaceColorService({ table, registry, generation, later = setTimeout, cancel = clearTimeout, waitMs = 25000 }) {
  const waiters = new Set();
  let revision = 0;
  let closed = false;
  let queue = Promise.resolve();
  const assertOpen = () => { if (closed) throw fail('unavailable', 'Workspace colors are unloaded'); };
  function snapshot() {
    assertOpen();
    return { generation, revision, colors: Object.fromEntries(registry.list().flatMap(row => {
      const saved = table.get(row.id);
      return saved ? [[row.id, saved.color]] : [];
    })) };
  }
  function list() {
    const state = snapshot();
    return { ...state, palette: PALETTE, source: PALETTE_SOURCE, workspaces: registry.list().map(row => ({
      workspaceId: row.id, title: row.title, path: row.path, color: state.colors[row.id] ?? null,
    })) };
  }
  function validate(input, internal) {
    if (!record(input)) throw fail('invalid-request', 'Expected an operation object');
    const fields = input.action === 'watch' && internal ? ['action', 'generation', 'revision'] : ['action', 'workspaceId', 'color', 'expectedColor'];
    if (Object.keys(input).some(key => !fields.includes(key))) throw fail('invalid-request', 'Unknown operation field');
    if (input.action === 'list') {
      if (Object.keys(input).length !== 1) throw fail('invalid-request', 'list takes no additional fields');
    } else if (input.action === 'set') {
      if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200 || !isColor(input.color)
        || (Object.hasOwn(input, 'expectedColor') && !isColor(input.expectedColor))) throw fail('invalid-request', 'Choose a Workspace and MSX color 1–15, or null');
    } else if (input.action === 'watch' && internal) {
      if (input.generation !== undefined && (typeof input.generation !== 'string' || input.generation.length > 100)) throw fail('invalid-request', 'Invalid generation');
      if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) throw fail('invalid-request', 'Invalid revision');
    } else throw fail('invalid-request', 'Unknown operation');
  }
  function set(input, signal) {
    const result = queue.then(async () => {
      assertOpen(); signal?.throwIfAborted();
      if (!registry.get(input.workspaceId)) throw fail('workspace-not-found', 'The Workspace no longer exists');
      const previousColor = table.get(input.workspaceId)?.color ?? null;
      if (Object.hasOwn(input, 'expectedColor') && input.expectedColor !== previousColor) throw fail('conflict', 'The Workspace color changed; reopen the menu and try again');
      const changed = previousColor !== input.color;
      if (changed) {
        try {
          if (input.color === null) await table.delete(input.workspaceId);
          else await table.put(input.workspaceId, { color: input.color });
        } catch (error) { throw fail('storage-unavailable', `Could not save Workspace color: ${error.message}`); }
        revision++;
        for (const finish of [...waiters]) finish();
      }
      return { workspaceId: input.workspaceId, color: input.color, previousColor, changed, snapshot: snapshot() };
    });
    queue = result.catch(() => {});
    return result;
  }
  async function watch(input, signal) {
    assertOpen(); signal?.throwIfAborted();
    if (input.generation !== generation || input.revision !== revision) return snapshot();
    await new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      function cleanup() { waiters.delete(finish); if (timer !== undefined) cancel(timer); signal?.removeEventListener('abort', aborted); }
      function finish() { if (settled) return; settled = true; cleanup(); resolve(); }
      function aborted() { if (settled) return; settled = true; cleanup(); reject(signal.reason ?? fail('cancelled', 'Cancelled')); }
      waiters.add(finish);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) { aborted(); return; }
      timer = later(finish, waitMs);
    });
    return snapshot();
  }
  return {
    snapshot, list,
    async operate(input, { internal = false, signal } = {}) {
      validate(input, internal); assertOpen(); signal?.throwIfAborted();
      if (input.action === 'list') return list();
      if (input.action === 'set') return set(input, signal);
      return watch(input, signal);
    },
    status: () => ({ generation, revision, closed, waitingClients: waiters.size }),
    async close() { if (closed) return; closed = true; for (const finish of [...waiters]) finish(); await queue; },
  };
}

export function createColorRoute(service) {
  return {
    path: `/api/${ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415 });
      let message;
      try {
        const text = await request.text();
        if (text.length > 4096) return new Response('Request too large', { status: 413 });
        message = JSON.parse(text);
      } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (!record(message) || message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.rpcId.length > 200 || message.method !== ENDPOINT) return new Response('Invalid RPC envelope', { status: 400 });
      let result;
      try { result = { ok: true, value: await service.operate(message.payload, { internal: true, signal: request.signal }) }; }
      catch (error) { result = { ok: false, error: { code: error.code ?? 'unavailable', message: error.message, details: {} } }; }
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result }, { headers: { 'cache-control': 'no-store' } });
    },
  };
}
