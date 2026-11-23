const KINDS = new Set(['approval', 'question', 'plan-review', 'terminal']);
export const ATTENTION_LIMITS = Object.freeze({ sessionLength: 256, tokenLength: 2048, tokensPerSession: 256, sessions: 2000 });

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function validSession(sessionId) { return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= ATTENTION_LIMITS.sessionLength; }

// Exact, canonical tuples cannot collide when ids contain colons, quotes or Unicode.
// These tokens acknowledge notification attention only; they never answer a request.
export function validateAcknowledgement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('bad-request', 'Invalid attention acknowledgement');
  const { sessionId, tokens } = input;
  if (!validSession(sessionId) || !Array.isArray(tokens) || tokens.length === 0 || tokens.length > ATTENTION_LIMITS.tokensPerSession) throw failure('bad-request', 'Invalid attention acknowledgement');
  for (const token of tokens) {
    if (typeof token !== 'string' || token.length === 0 || token.length > ATTENTION_LIMITS.tokenLength) throw failure('bad-request', 'Invalid attention token');
    let tuple;
    try { tuple = JSON.parse(token); } catch { throw failure('bad-request', 'Invalid attention token'); }
    if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== sessionId || !KINDS.has(tuple[1]) || typeof tuple[2] !== 'string' || tuple[2].length === 0 || JSON.stringify(tuple) !== token) throw failure('bad-request', 'Invalid attention token');
  }
  return { sessionId, tokens: [...new Set(tokens)] };
}

// Only tombstones are durable. Live terminal notices belong to this Host generation:
// restoring an old completed event after restart would manufacture historical work.
export function createAttentionState({ table } = {}) {
  const acknowledged = new Map();
  const terminals = new Map();
  let revision = 0;
  let disposed = false;
  let tail = Promise.resolve();
  if (table) for (const [sessionId, row] of table.entries()) {
    if (!Array.isArray(row?.tokens)) throw failure('invalid-state', 'Invalid stored attention acknowledgement');
    if (!row.tokens.length) continue;
    const normalized = validateAcknowledgement({ sessionId, tokens: row.tokens });
    acknowledged.set(sessionId, new Set(normalized.tokens));
  }

  function snapshot() {
    return {
      revision,
      acknowledged: [...acknowledged].map(([sessionId, tokens]) => ({ sessionId, tokens: [...tokens] })),
      terminals: [...terminals.values()].map(event => structuredClone(event)),
    };
  }
  function publish(event) {
    if (disposed || !event || !validSession(event.sessionId)) return false;
    if (event.type === 'clear-attention') {
      if (!terminals.delete(event.sessionId)) return false;
    } else if (event.type === 'completed' && typeof event.id === 'string' && event.id.length > 0) {
      const token = JSON.stringify([event.sessionId, 'terminal', event.id]);
      if (token.length > ATTENTION_LIMITS.tokenLength) return false;
      if (terminals.get(event.sessionId)?.id === event.id) return false;
      terminals.set(event.sessionId, structuredClone(event));
    } else return false;
    revision++;
    return true;
  }
  function acknowledge(input) {
    if (disposed) return Promise.reject(failure('disposed', 'Attention state disposed'));
    let normalized;
    try { normalized = validateAcknowledgement(input); } catch (error) { return Promise.reject(error); }
    const operation = tail.then(async () => {
      const { sessionId, tokens } = normalized;
      const previous = acknowledged.get(sessionId);
      const merged = new Set(previous);
      for (const token of tokens) merged.add(token);
      if (merged.size === (previous?.size ?? 0)) return { changed: false, tokens };
      // Never evict tombstones on a journal timeout or silently resurrect old cards.
      if (merged.size > ATTENTION_LIMITS.tokensPerSession || (!previous && acknowledged.size >= ATTENTION_LIMITS.sessions)) throw failure('capacity-exceeded', 'Attention acknowledgement storage is full');
      if (table) await table.put(sessionId, { tokens: [...merged] });
      // No observer can see a successful acknowledgement before durable commit.
      acknowledged.set(sessionId, merged);
      revision++;
      return { changed: true, tokens };
    });
    // Serialize merges (including concurrent duplicates) and recover after a failed put.
    tail = operation.catch(() => {});
    return operation;
  }
  function dispose() { disposed = true; return tail; }
  return { snapshot, publish, acknowledge, dispose };
}
