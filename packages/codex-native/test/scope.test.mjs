import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapReplayState, unwrapMessages, CodexReplayError } from '../src/scope.js';

const scope = 'opaque-account-A-generation-1';
const route = { provider: 'openai-codex', model: 'gpt-codex' };
function native() {
  return {
    response: { kind: 'pi-ai', version: 2, api: 'openai-codex-responses', provider: route.provider,
      model: route.model, responseModel: 'resolved-model-different', responseId: 'private-response', stopReason: 'stop' },
    blocks: [{ type: 'text', textSignature: 'opaque-text' },
      { type: 'reasoning', thinkingSignature: 'ciphertext-secret', redacted: false },
      { type: 'tool-call', thoughtSignature: 'token-secret', namespace: 'opaque-namespace' }],
  };
}
function assistant(replayState = wrapReplayState(native(), scope)) {
  return { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'reasoning', text: '' },
    { type: 'tool-call', id: 'call', name: 'tool', arguments: '{}' }],
    source: { provider: route.provider, model: route.model, replayState } };
}
const safe = code => error => {
  assert.ok(error instanceof CodexReplayError);
  assert.equal(error.name, 'CodexReplayError');
  assert.equal(error.code, code);
  assert.match(error.message, /Start a new session/);
  assert.doesNotMatch(error.stack + JSON.stringify(error), /ciphertext-secret|token-secret|private-response|opaque-account/);
  assert.equal(error.cause, undefined);
  return true;
};

test('scope wrapper preserves opaque native response and block identity', () => {
  const state = native();
  const wrapped = wrapReplayState(state, scope);
  assert.notEqual(wrapped, state);
  assert.deepEqual(wrapped.response, { kind: 'codex-native', version: 1, scope, state: state.response });
  assert.equal(wrapped.blocks, state.blocks);
  assert.equal(wrapped.response.state, state.response);
  assert.equal(state.response.kind, 'pi-ai');
});

test('unwrap clones only changed path and leaves all opaque signatures untouched', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'question' }] };
  const own = assistant();
  const foreign = { ...assistant(), source: { provider: 'old-codex', model: 'old', replayState: { untrusted: 'foreign' } } };
  const messages = [user, own, foreign];
  const output = unwrapMessages(messages, scope, route);
  assert.notEqual(output, messages);
  assert.equal(output[0], user);
  assert.equal(output[2], foreign);
  assert.notEqual(output[1], own);
  assert.notEqual(output[1].source, own.source);
  assert.equal(output[1].content, own.content);
  assert.equal(output[1].source.replayState.blocks, own.source.replayState.blocks);
  assert.equal(output[1].source.replayState.response, own.source.replayState.response.state);
  assert.equal(own.source.replayState.response.kind, 'codex-native');
});

for (const changed of ['opaque-account-B-generation-1', 'opaque-account-A-generation-2']) {
  test('different account or fixed grant generation fails before hypothetical network: ' + changed, () => {
    let networkCalls = 0;
    assert.throws(() => { unwrapMessages([assistant()], changed, route); networkCalls++; }, safe('CODEX_REPLAY_SCOPE_MISMATCH'));
    assert.equal(networkCalls, 0);
  });
}

test('verified model switches use portable request content; forged source identity still fails', () => {
  assert.equal(unwrapMessages([assistant()], scope, route)[0].source.replayState.response.responseModel, 'resolved-model-different');
  const original = assistant();
  const portable = unwrapMessages([original], scope, { ...route, model: 'other-model' });
  assert.equal(portable[0].source.replayState, undefined);
  assert.deepEqual(portable[0].content.map(block => block.type), ['text', 'tool-call']);
  assert.equal(original.source.replayState.response.kind, 'codex-native');
  const forged = assistant();
  forged.source.model = 'other-model';
  assert.throws(() => unwrapMessages([forged], scope, route), safe('CODEX_REPLAY_MODEL_MISMATCH'));
});

test('old verified models preserve visible tools without sending opaque state to another model', () => {
  const old = assistant();
  old.source.model = 'old-model';
  old.source.replayState.response.state.model = 'old-model';
  const original = JSON.stringify(old);
  const result = unwrapMessages([old], scope, route);
  assert.equal(result[0].source.replayState, undefined);
  assert.equal(result[0].content.some(block => block.type === 'reasoning'), false);
  assert.equal(result[0].content.find(block => block.type === 'tool-call'), old.content[2]);
  assert.equal(JSON.stringify(old), original);
});

for (const [field, value] of [['api', 'other-api'], ['provider', 'other-provider']]) {
  test('own native ' + field + ' mismatch is a sanitized route failure', () => {
    const own = assistant();
    own.source.replayState.response.state[field] = value;
    assert.throws(() => unwrapMessages([own], scope, route), safe('CODEX_REPLAY_ROUTE_MISMATCH'));
  });
}

test('own raw/native replay and unknown envelopes reject rather than degrading', () => {
  for (const replay of [native(), null, {}, { response: { kind: 'other', secret: 'token-secret' } }]) {
    assert.throws(() => unwrapMessages([assistant(replay)], scope, route), safe('CODEX_REPLAY_UNVERIFIED'));
  }
});

test('own reasoning without replay rejects; own plain text without replay stays neutral', () => {
  const own = assistant();
  delete own.source.replayState;
  assert.throws(() => unwrapMessages([own], scope, route), safe('CODEX_REPLAY_UNVERIFIED'));
  own.content = [{ type: 'text', text: 'plain old content' }];
  own.source.model = 'old-model';
  const messages = [own];
  assert.equal(unwrapMessages(messages, scope, route), messages);
});

test('foreign providers including old codex remain byte-for-byte untouched', () => {
  const messages = ['codex', 'anthropic', 'old-codex'].map(provider => {
    const own = assistant();
    return { ...own, source: { ...own.source, provider, model: 'foreign-model' } };
  });
  const before = JSON.stringify(messages);
  assert.equal(unwrapMessages(messages, scope, route), messages);
  assert.equal(JSON.stringify(messages), before);
});

const malformed = [
  value => { value.source.replayState.response.version = 2; },
  value => { value.source.replayState.response.state = null; },
  value => { value.source.replayState.response.state.version = 3; },
  value => { value.source.replayState.response.state.kind = 'other'; },
  value => { value.source.replayState.response.state.stopReason = 'token-secret'; },
  value => { value.source.replayState.response.state.responseId = 8; },
  value => { value.source.replayState.blocks.pop(); },
  value => { value.source.replayState.blocks[1].type = 'text'; },
  value => { value.source.replayState.blocks[1].thinkingSignature = {}; },
  value => { value.source.replayState.blocks[1].redacted = 'false'; },
  value => { value.source.replayState.blocks[2] = null; },
  value => { value.source.replayState.blocks = 'token-secret'; },
  value => { value.content = 'token-secret'; },
  value => { value.source.replayState.response.scope = ''; },
];
malformed.forEach((mutate, index) => test('malformed own replay fails loudly without exposing state: ' + index, () => {
  const value = assistant();
  mutate(value);
  assert.throws(() => unwrapMessages([value], scope, route), safe('CODEX_REPLAY_INVALID'));
}));

for (const invalidScope of ['', undefined, null, 3, 'x'.repeat(129)]) {
  test('reject invalid scope ' + typeof invalidScope + '/' + String(invalidScope).length, () => {
    assert.throws(() => wrapReplayState(native(), invalidScope), safe('CODEX_REPLAY_INVALID'));
    assert.throws(() => unwrapMessages([], invalidScope, route), safe('CODEX_REPLAY_INVALID'));
  });
}

test('scope boundary is 128 characters, and empty route/model is refused', () => {
  assert.equal(wrapReplayState(native(), 'x'.repeat(128)).response.scope.length, 128);
  assert.throws(() => unwrapMessages([], scope, { provider: route.provider }), safe('CODEX_REPLAY_INVALID'));
  assert.throws(() => unwrapMessages([], scope, { ...route, provider: 'other' }), safe('CODEX_REPLAY_ROUTE_MISMATCH'));
  assert.throws(() => unwrapMessages([], scope, { ...route, api: 'other' }), safe('CODEX_REPLAY_ROUTE_MISMATCH'));
});
