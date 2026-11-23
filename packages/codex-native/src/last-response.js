// Pure, bounded whole-session fold. Host modules are injected, never loaded here.
import { REPORTED_SERVICE_TIERS, SPEED_TIERS } from './policy.js';
const PROVIDER = 'openai-codex';
const API = 'openai-codex-responses';
const TIERS = REPORTED_SERVICE_TIERS;
const WRAPPER_KEYS = new Set(['kind', 'version', 'scope', 'state', 'reportedServiceTier', 'requestedSpeed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const index = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Validate the carrier before reading either request or server metadata. */
function speedMetadata(source, finishKind) {
  const replay = source.replayState;
  if (!object(replay) || !Array.isArray(replay.blocks)) return null;
  const wrapper = replay.response;
  if (!object(wrapper) || wrapper.kind !== 'codex-native' || wrapper.version !== 1
    || Object.keys(wrapper).some(key => !WRAPPER_KEYS.has(key))
    || typeof wrapper.scope !== 'string' || !wrapper.scope || wrapper.scope.length > 128) return null;
  const native = wrapper.state;
  const stopReason = finishKind === 'stop' ? 'stop' : 'toolUse';
  if (!object(native) || native.kind !== 'pi-ai' || native.version !== 2
    || native.provider !== PROVIDER || native.api !== API || native.model !== source.model
    || native.stopReason !== stopReason) return null;
  return wrapper;
}

function readTier(value, source, allowed) {
  if (!object(value) || Object.keys(value).length !== 3
      || !Object.hasOwn(value, 'source') || !Object.hasOwn(value, 'version') || !Object.hasOwn(value, 'tier')
      || value.source !== source || value.version !== 1 || !allowed.includes(value.tier)) return null;
  return value.tier;
}

/** Explicit scalar allowlist, even if a caller accidentally extends host state later. */
function view(state) {
  const last = state.last;
  return { last: last === null ? null : {
    version: last.version,
    eventSeq: last.eventSeq,
    messageId: last.messageId,
    turn: last.turn,
    step: last.step,
    model: last.model,
    completedAt: last.completedAt,
    reportedTier: last.reportedTier,
    requestedSpeed: last.requestedSpeed,
    outputTokens: last.outputTokens,
    decodeMs: last.decodeMs,
  } };
}

/**
 * Definition for await ctx.sessionProjections.register(...).
 *
 * This describes the latest successful MAIN durable response, not the current
 * model-visible surface. Append-origin messages remain historical responses
 * after compaction; replacement copies are not new generations. A fork retains
 * its inherited response until the child completes a newer one. The host folds
 * the full log / checkpoint, independently of the client's paginated window.
 *
 * TPS is a presentation calculation: outputTokens * 1000 / decodeMs when both
 * are positive, otherwise unknown. No step totals or previous attempts enter it.
 */
export function createLastResponseProjection({ z, assistantStreamFirstTokenTime, lastAssistantStreamChunk }) {
  if (!z || typeof assistantStreamFirstTokenTime !== 'function' || typeof lastAssistantStreamChunk !== 'function') {
    throw new Error('CODEX_LAST_RESPONSE_DEPENDENCIES_REQUIRED');
  }
  const lastSchema = z.object({
    version: z.literal(1),
    eventSeq: z.number().int().nonnegative(),
    messageId: z.string().min(1).max(160),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    model: z.string().min(1).max(160),
    completedAt: z.number().int().nonnegative(),
    reportedTier: z.enum(TIERS).nullable(),
    requestedSpeed: z.enum(SPEED_TIERS).nullable(),
    outputTokens: z.number().finite().positive().nullable(),
    decodeMs: z.number().finite().positive().nullable(),
  }).strict();
  const stateSchema = z.object({ last: lastSchema.nullable() }).strict();
  return {
    key: 'codex-native/last-response',
    stateVersion: 2,
    stateSchema,
    init: () => ({ last: null }),
    apply: (state, event) => {
      // Only the agent loop's durable, append-origin assistant settlement is a
      // candidate. Auxiliary/title/search/attempt records never qualify.
      if (!object(event) || event.type !== 'assistant/message' || event.surfaceOp !== 'append'
        || !index(event.seq) || !index(event.time)
        || (state.last !== null && event.seq <= state.last.eventSeq)) return state;
      const data = event.data;
      if (!object(data) || !index(data.turn) || !index(data.step) || !Array.isArray(data.stream)
        || (data.interrupted !== undefined && data.interrupted !== false)) return state;
      const message = data.message;
      const source = message?.source;
      if (!object(message) || message.role !== 'assistant' || !label(message.id)
        || !object(source) || source.kind !== 'model' || source.provider !== PROVIDER || !label(source.model)) return state;
      let finish;
      try {
        // Actual host signature is (compactStream, type), returning the raw chunk.
        finish = lastAssistantStreamChunk(data.stream, 'finish');
      } catch { return state; }
      const finishKind = finish?.reason?.kind;
      if (finish?.type !== 'finish' || (finishKind !== 'stop' && finishKind !== 'tool-calls')) return state;
      let firstToken;
      try { firstToken = assistantStreamFirstTokenTime(data.stream); } catch { /* Unknown timing, no diagnostics. */ }
      const elapsed = typeof firstToken === 'number' && Number.isFinite(firstToken) && firstToken >= 0
        ? event.time - firstToken : null;
      const metadata = speedMetadata(source, finishKind);
      return { last: {
        version: 1,
        eventSeq: event.seq,
        messageId: message.id,
        turn: data.turn,
        step: data.step,
        model: source.model,
        completedAt: event.time,
        reportedTier: readTier(metadata?.reportedServiceTier, 'codex-terminal', TIERS),
        requestedSpeed: readTier(metadata?.requestedSpeed, 'codex-request', SPEED_TIERS),
        outputTokens: positive(data.usage?.outputTokens) ? data.usage.outputTokens : null,
        decodeMs: positive(elapsed) ? elapsed : null,
      } };
    },
    wire: { viewSchema: stateSchema, view },
  };
}
