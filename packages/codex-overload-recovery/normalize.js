/** Exact provider wording only: PI_AI_ERROR is NOT generally retryable. */
const CODEX_OVERLOAD = /^(?:Codex error:\s*)?Our servers are currently overloaded\.\s*Please try again later\.?$/i;

/** Preserve request/stream identities except for this one misclassified finish. */
export function normalizeCodexOverload(chunk, signal) {
  if (signal?.aborted || chunk.type !== 'finish' || chunk.reason.kind !== 'error') return chunk;
  const failure = chunk.reason.failure;
  if (failure.code !== 'PI_AI_ERROR' || typeof failure.message !== 'string') return chunk;
  // Explicit client/auth/quota errors must never become transient server errors.
  if (failure.status >= 400 && failure.status < 500) return chunk;
  if (!CODEX_OVERLOAD.test(failure.message.trim())) return chunk;
  return {
    ...chunk,
    reason: { ...chunk.reason, failure: { ...failure, code: 'SERVER' } },
  };
}

/** No retries here: the native loop owns attempts, backoff, logging and cancel. */
export async function* normalizeStream(stream, signal, onNormalized = () => {}) {
  for await (const chunk of stream) {
    const normalized = normalizeCodexOverload(chunk, signal);
    if (normalized !== chunk) onNormalized();
    yield normalized;
  }
}
