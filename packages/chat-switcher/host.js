import { randomUUID } from 'node:crypto';
import { selectImageSalt, imageSaltValid, IMAGE_REGENERATION_POLICY } from './image-salt.js';
import { HYBRID_VARIANT, PARAMETRIC_VARIANT, LEGACY_VARIANT, validImageVariant } from './src/image-variant.js';

export const IMAGE_ENDPOINT = 'chat-switcher/images';
const DOMAIN = 'local_chat_switcher_images';

/** Plugin-owned sidecar data: never changes the transcript, title, or draft. */
export function createIdentityService({ table, activatedAt, session, random = randomUUID, generation = randomUUID() }) {
  let revision = 0;
  let disposed = false;
  const listeners = new Set();
  const tails = new Map();
  const validate = id => {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid chat id');
    if (!session(id)) throw new Error('Chat is not open');
  };
  const read = id => {
    validate(id);
    const record = table.get(id);
    return { sessionId: id, salt: record?.salt ?? null, variant: record?.variant ?? LEGACY_VARIANT, revision: record?.revision ?? 0, generation, catalogRevision: revision, regenerationPolicy: IMAGE_REGENERATION_POLICY };
  };
  const snapshot = () => ({ generation, revision, records: [...table.entries()].map(([sessionId, record]) => ({ sessionId, ...record })) });
  const changed = () => { revision++; for (const notify of [...listeners]) notify(); };
  function serial(id, operation) {
    const previous = tails.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (disposed) throw new Error('Chat images unloaded');
      return operation();
    });
    tails.set(id, next);
    void next.finally(() => { if (tails.get(id) === next) tails.delete(id); }).catch(() => {});
    return next;
  }
  async function replace(id, { contrast = false, expectedSalt, expectedGeneration, expectedVariant, signal } = {}) {
    validate(id);
    const current = table.get(id);
    // Compare with the image the caller actually saw, not an unseen concurrent reroll.
    if ((expectedSalt !== undefined && expectedSalt !== null && typeof expectedSalt !== 'string')
        || (expectedGeneration !== undefined && typeof expectedGeneration !== 'string') || !validImageVariant(expectedVariant)) throw new Error('Invalid image reference');
    if ((expectedSalt !== undefined && expectedSalt !== (current?.salt ?? null))
        || (expectedGeneration !== undefined && expectedGeneration !== generation)
        || (expectedVariant !== undefined && expectedVariant !== (current?.variant ?? LEGACY_VARIANT))) throw new Error('Chat image already changed; refresh and try again');
    const shouldAbort = () => disposed || signal?.aborted || !session(id);
    const salt = contrast ? await selectImageSalt({ sessionId: id, previousSalt: current?.salt ?? null, previousVariant: current?.variant ?? LEGACY_VARIANT, nextVariant: PARAMETRIC_VARIANT, random, shouldAbort }) : random();
    // A faulty entropy source must not report a successful no-op.
    if (!imageSaltValid(salt) || salt === current?.salt) throw new Error('Could not generate a new image salt');
    if (shouldAbort()) throw new Error('Chat image change cancelled or unloaded');
    const record = { salt, revision: (current?.revision ?? 0) + 1, ...(contrast ? { variant: PARAMETRIC_VARIANT } : {}) };
    await table.put(id, record); // Publish only after the durable commit.
    changed();
    return { sessionId: id, ...record, variant: record.variant ?? LEGACY_VARIANT, generation, catalogRevision: revision, regenerationPolicy: IMAGE_REGENERATION_POLICY };
  }
  return {
    read, snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    ensure(id) {
      validate(id);
      return serial(id, async () => {
        const existing = table.get(id);
        // Existing chats retain their recognizable legacy image until a click.
        if (existing || (session(id)?.header.createdAt ?? 0) < activatedAt) return read(id);
        return replace(id);
      });
    },
    regenerate(id, options = {}) { validate(id); return serial(id, () => replace(id, { ...options, contrast: true })); },
    async watch(cursor, signal, { waitMs = 25000, later = setTimeout, cancel = clearTimeout } = {}) {
      if (disposed) throw new Error('Chat images unloaded');
      if (cursor?.generation !== generation || cursor.revision !== revision) return snapshot();
      await new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const cleanup = () => { listeners.delete(finish); if (timer !== undefined) cancel(timer); signal.removeEventListener('abort', abort); };
        function finish() { if (settled) return; settled = true; cleanup(); resolve(); }
        function abort() { if (settled) return; settled = true; cleanup(); reject(signal.reason ?? new Error('Image subscription cancelled')); }
        listeners.add(finish);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort(); else timer = later(finish, waitMs);
      });
      if (disposed) throw new Error('Chat images unloaded');
      return cursor.revision === revision ? { generation, revision } : snapshot();
    },
    async dispose() { disposed = true; for (const finish of [...listeners]) finish(); listeners.clear(); await Promise.allSettled([...tails.values()]); },
  };
}

export async function installIdentityHost(ctx, { valueSchema, globalSchema, now = Date.now, random = randomUUID } = {}) {
  const domain = await ctx.storageDomain.open({
    name: DOMAIN, version: 1,
    global: { schema: globalSchema, initial: { activatedAt: now() } },
    tables: { images: { valueSchema } },
  });
  // Register ownership before the next fallible write. Failed activation must
  // release the single-open domain too, so a retry needs no Host restart.
  let service;
  ctx.effect(() => async () => { await service?.dispose(); await domain.close(); });
  // Persist the initial boundary too: a missing global must not reset on reload.
  await domain.global.set(domain.global.get());
  service = createIdentityService({ table: domain.table('images'), activatedAt: domain.global.get().activatedAt, session: id => ctx.sessions.get(id), now, random });
  ctx.on('agent/created', async ({ agent }) => {
    // Cosmetic storage failure must not prevent a chat from being created.
    try { await service.ensure(agent.id); }
    catch (error) { ctx.logger.warn('chat-switcher: image salt could not be saved: %s', error.message); }
  });
  for (const session of ctx.sessions.list()) await service.ensure(session.id);

  ctx.effect(() => ctx.tools.register({
    name: 'chat_image',
    description: 'Read or regenerate this chat’s identifying mosaic. Explicit regeneration toggles the fractal-presence parameter, changes every shared active image parameter and palette position, and persists only an accepted salt/variant. Fractal-enabled images have bounded hybrid fills inside the large polygons; old images stay unchanged until regeneration. Messages and draft stay unchanged.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['get', 'regenerate'] } }, required: ['action'], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { sessionId: { type: 'string' }, salt: { oneOf: [{ type: 'string' }, { type: 'null' }] }, revision: { type: 'integer' }, variant: { type: 'string', enum: [LEGACY_VARIANT, HYBRID_VARIANT, PARAMETRIC_VARIANT] }, generation: { type: 'string' }, catalogRevision: { type: 'integer' }, regenerationPolicy: { type: 'string', const: IMAGE_REGENERATION_POLICY } }, required: ['sessionId', 'salt', 'revision', 'generation', 'catalogRevision'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: args => args.action === 'get',
    async execute(args, exec) {
      if (!exec.agent) throw new Error('A chat is required');
      if (args.action === 'get') return service.read(exec.agent.id);
      if (args.action === 'regenerate') return service.regenerate(exec.agent.id);
      throw new Error('Unknown image action');
    },
  }));
  // Exact Fetch routes are owner-authenticated by Connection and work over both
  // the Web carrier and Desktop IPC. The UI and tool share the same service.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/' + IMAGE_ENDPOINT, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415 });
      let message;
      try { message = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== IMAGE_ENDPOINT) return new Response('Invalid image request', { status: 400 });
      let result;
      try {
        const input = message.payload;
        if (!input || !['watch', 'get', 'regenerate'].includes(input.action)) throw new Error('Unknown image action');
        let value;
        if (input.action === 'watch') {
          if (input.generation !== undefined && (typeof input.generation !== 'string' || !Number.isSafeInteger(input.revision) || input.revision < 0)) throw new Error('Invalid image cursor');
          value = await service.watch(input, request.signal);
        } else if (input.action === 'get') value = service.read(input.sessionId);
        else value = await service.regenerate(input.sessionId, { expectedSalt: input.expectedSalt, expectedGeneration: input.expectedGeneration, expectedVariant: input.expectedVariant, signal: request.signal });
        result = { ok: true, value };
      } catch (error) {
        if (request.signal.aborted) throw error;
        result = { ok: false, error: { code: 'chat-image-failed', message: error.message, details: {} } };
      }
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
    },
  }));
  return service;
}
