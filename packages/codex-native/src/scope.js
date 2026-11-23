/** Account/generation fence around, not a replacement for, native Pi replay. */
const PROVIDER = 'openai-codex';
const API = 'openai-codex-responses';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.length > 0;
const validScope = value => nonempty(value) && value.length <= 128;

export class CodexReplayError extends Error {
  constructor(code = 'CODEX_REPLAY_INVALID') {
    const reasons = {
      CODEX_REPLAY_INVALID: 'Codex replay state is invalid.',
      CODEX_REPLAY_UNVERIFIED: 'Codex replay has no verified account scope.',
      CODEX_REPLAY_SCOPE_MISMATCH: 'Codex replay belongs to a different account or grant generation.',
      CODEX_REPLAY_MODEL_MISMATCH: 'Codex replay belongs to a different model.',
      CODEX_REPLAY_ROUTE_MISMATCH: 'Codex replay belongs to a different provider or API.',
    };
    super((reasons[code] ?? reasons.CODEX_REPLAY_INVALID) + ' Start a new session.');
    this.name = 'CodexReplayError';
    this.code = code;
  }
}
const fail = code => { throw new CodexReplayError(code); };

// Validate the native envelope without reconstructing its opaque signatures.
// This also prevents native's malformed-replay fallback from hiding own errors.
function validateNative(native) {
  if (!object(native) || !object(native.response) || !Array.isArray(native.blocks)) fail();
  const response = native.response;
  if (response.kind !== 'pi-ai' || response.version !== 2 || !nonempty(response.model)) fail();
  if (response.provider !== PROVIDER || response.api !== API) fail('CODEX_REPLAY_ROUTE_MISMATCH');
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(response.stopReason)) fail();
  for (const field of ['responseModel', 'responseId', 'providerThinkingLevel', 'prefixDigest']) {
    if (response[field] !== undefined && typeof response[field] !== 'string') fail();
  }
  for (const block of native.blocks) {
    if (!object(block) || !['text', 'reasoning', 'tool-call'].includes(block.type)) fail();
    for (const field of ['textSignature', 'thinkingSignature', 'thoughtSignature', 'namespace']) {
      if (block[field] !== undefined && typeof block[field] !== 'string') fail();
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') fail();
  }
}

/** Wrap only response metadata; blocks and native response keep their identity. */
export function wrapReplayState(native, scope) {
  if (!validScope(scope)) fail();
  validateNative(native);
  return {
    ...native,
    response: { kind: 'codex-native', version: 1, scope, state: native.response },
  };
}

/**
 * Verify own replay before native stream. The source and envelope must agree
 * on the original requested model (not the resolved response model). A new
 * requested model gets only portable content; its opaque state must not cross
 * the model boundary. Foreign routes are left to native history conversion.
 * Own reasoning without a verified wrapper still fails closed.
 */
export function unwrapMessages(messages, scope, { provider, model, api = API, allowPortablePiAiHistory = false } = {}) {
  if (!validScope(scope) || !Array.isArray(messages) || !nonempty(model)) fail();
  if (provider !== PROVIDER || api !== API) fail('CODEX_REPLAY_ROUTE_MISMATCH');
  let result = messages;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.source?.provider !== PROVIDER) continue;
    const source = message.source;
    if (!Array.isArray(message.content)) fail();
    const replay = source.replayState;
    if (replay === undefined) {
      if (message.content?.some(block => block?.type === 'reasoning')) fail('CODEX_REPLAY_UNVERIFIED');
      continue;
    }
    if (allowPortablePiAiHistory === true && object(replay) && replay.response?.kind === 'pi-ai') {
      // Recovery from the accidentally active stock adapter. Never adopt its
      // unscoped ciphertext: only portable visible content enters this request.
      validateNative(replay);
      if (replay.response.model !== source.model) fail('CODEX_REPLAY_MODEL_MISMATCH');
      if (replay.blocks.length !== message.content.length) fail();
      if (replay.blocks.some((block, index) => block.type !== message.content[index]?.type)) fail();
      const { replayState: _untrusted, ...portableSource } = source;
      if (result === messages) result = messages.slice();
      result[index] = { ...message, source: portableSource, content: message.content.filter(block => block.type !== 'reasoning') };
      continue;
    }
    if (!object(replay) || !object(replay.response) || replay.response.kind !== 'codex-native') {
      fail('CODEX_REPLAY_UNVERIFIED');
    }
    const wrapper = replay.response;
    if (wrapper.version !== 1 || !validScope(wrapper.scope)) fail();
    if (wrapper.scope !== scope) fail('CODEX_REPLAY_SCOPE_MISMATCH');
    const native = { ...replay, response: wrapper.state };
    validateNative(native);
    if (native.response.provider !== source.provider || native.response.api !== api) fail('CODEX_REPLAY_ROUTE_MISMATCH');
    if (native.response.model !== source.model) fail('CODEX_REPLAY_MODEL_MISMATCH');
    if (native.blocks.length !== message.content.length) fail();
    for (let block = 0; block < native.blocks.length; block++) {
      if (native.blocks[block].type !== message.content[block]?.type) fail();
    }
    if (result === messages) result = messages.slice();
    if (source.model === model) {
      result[index] = { ...message, source: { ...source, replayState: native } };
    } else {
      // No replayState makes the bundled adapter use its neutral conversion,
      // including tool-call/result ID normalization. Keep their original pairing
      // and do not edit persisted history: switching back can still replay it.
      const { replayState: _replay, ...portableSource } = source;
      result[index] = {
        ...message,
        source: portableSource,
        content: message.content.filter(block => block.type !== 'reasoning'),
      };
    }
  }
  return result;
}
