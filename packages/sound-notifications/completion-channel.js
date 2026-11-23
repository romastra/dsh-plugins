import { randomUUID } from 'node:crypto';
import { createAttentionState, validateAcknowledgement } from './attention-state.js';

export const COMPLETION_ENDPOINT = 'sound-notifications/events';
// Logical RPC uses the app's authenticated carrier (HTTP or Desktop IPC).
// A cursor recovers short interruptions, but a new page starts at the live edge.
export function installCompletionChannel(ctx, { now = () => Date.now(), later = setTimeout, cancel = clearTimeout, waitMs = 25000, retentionMs = 120000, attentionState } = {}) {
  const ownsState = attentionState === undefined;
  const state = attentionState ?? createAttentionState();
  const generation = randomUUID();
  const journal = [];
  const waiters = new Set();
  const clients = new Map();
  let cursor = 0;
  let disposed = false;
  let published = 0;
  function trim() {
    while (journal.length && (journal.length > 256 || now() - journal[0].at > retentionMs)) journal.shift();
    for (const [id, client] of clients) if (now() - client.lastSeen > retentionMs) clients.delete(id);
    while (clients.size > 32) clients.delete(clients.keys().next().value);
  }
  const result = (events = []) => ({ protocol: 2, generation, cursor, events, state: state.snapshot() });
  function status() {
    trim();
    const recent = [...clients.values()];
    const snapshot = state.snapshot();
    const sessionIds = new Set([...snapshot.acknowledged.map(row => row.sessionId), ...snapshot.terminals.map(event => event.sessionId)]);
    const summary = { revision: snapshot.revision, sessionCount: sessionIds.size, acknowledgedCount: snapshot.acknowledged.reduce((count, row) => count + row.tokens.length, 0), terminalCount: snapshot.terminals.length };
    return { transport: 'authenticated-rpc', generation, published, cursor, waitingClients: waiters.size, recentClients: recent.length, clients: recent, lastClient: recent.at(-1) ?? null, lastPublished: journal.at(-1)?.event ?? null, state: summary };
  }
  function append(event) {
    if (disposed) return;
    journal.push({ cursor: ++cursor, at: now(), event }); published++; trim();
    for (const finish of [...waiters]) finish();
  }
  function publish(event) {
    if (disposed) return;
    state.publish(event);
    append(event);
  }
  async function handle(payload, signal) {
    // Connection's exact Fetch registry admits authenticated owner Peers on
    // both HTTP and Desktop IPC. Do not claim Gateway's single RPC interceptor.
    if (disposed) throw new Error('Sound notifications unloaded');
    const refused = (code, message) => ({ ok: false, error: { code, message, details: {} } });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.clientId !== 'string' || payload.clientId.length === 0 || payload.clientId.length > 100 || (payload.cursor !== undefined && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0))) return refused('bad-request', 'Invalid completion cursor');
    const action = payload.action === undefined ? 'watch' : payload.action;
    if (action !== 'watch' && action !== 'acknowledge') return refused('bad-request', 'Invalid attention action');
    let acknowledgement;
    if (action === 'acknowledge') {
      try { acknowledgement = validateAcknowledgement(payload); } catch (error) { return refused('bad-request', error.message); }
    }
    trim();
    const previous = clients.get(payload.clientId);
    clients.delete(payload.clientId);
    clients.set(payload.clientId, {
      lastSeen: now(),
      protocol: payload.protocol === 2 ? 2 : 1,
      received: typeof payload.received === 'string' ? payload.received.slice(0, 200) : previous?.received ?? null,
      audio: ['ready', 'locked', 'failed', 'unsupported'].includes(payload.audio) ? payload.audio : null,
    });
    if (action === 'acknowledge') {
      try {
        const committed = await state.acknowledge(acknowledgement);
        if (committed.changed) append({ type: 'acknowledged', sessionId: acknowledgement.sessionId, tokens: committed.tokens });
        // This cursor describes the response snapshot only. ACK callers must not
        // advance their independent watch cursor or they could skip live work.
        return { ok: true, value: result() };
      } catch (error) {
        return refused(error.code === 'capacity-exceeded' ? error.code : 'storage-unavailable', error.code === 'capacity-exceeded' ? error.message : 'Could not persist attention acknowledgement');
      }
    }
    // No historical sound at first connection or Host replacement, but logical
    // attention and durable tombstones are present in every response snapshot.
    if (payload.generation !== generation || payload.cursor === undefined || payload.cursor > cursor) return { ok: true, value: result() };
    const collect = () => { trim(); return result(journal.filter(row => row.cursor > payload.cursor).map(row => row.event)); };
    if (cursor > payload.cursor) return { ok: true, value: collect() };
    const value = await new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      function cleanup() { waiters.delete(finish); if (timer !== undefined) cancel(timer); signal.removeEventListener('abort', aborted); }
      function finish() { if (settled) return; settled = true; cleanup(); resolve(collect()); }
      function aborted() { if (settled) return; settled = true; cleanup(); reject(signal.reason ?? new Error('Completion stream cancelled')); }
      waiters.add(finish);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) { aborted(); return; }
      timer = later(finish, waitMs);
    });
    return { ok: true, value };
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/${COMPLETION_ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415 });
      let message;
      try { message = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== COMPLETION_ENDPOINT) return new Response('Invalid completion request', { status: 400 });
      const result = await handle(message.payload, request.signal);
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result });
    },
  }));
  ctx.effect(() => () => { disposed = true; for (const finish of [...waiters]) finish(); clients.clear(); journal.length = 0; if (ownsState) return state.dispose(); });
  return { publish, status, generation };
}
