import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { bindReplayGeneration } from '../src/replay-generation.js';
import { wrapReplayState, unwrapMessages } from '../src/scope.js';

const epoch = '11111111-1111-4111-8111-111111111111';
const nextEpoch = '22222222-2222-4222-8222-222222222222';
const scope = (generation, account = 'synthetic-account-A') => createHash('sha256').update(generation + '\0' + account).digest('hex');
const route = { provider: 'openai-codex', model: 'gpt-6.1-sol' };
const native = () => ({ response: { kind: 'pi-ai', version: 2, provider: route.provider, api: 'openai-codex-responses', model: route.model, stopReason: 'stop' }, blocks: [{ type: 'reasoning', thinkingSignature: 'SYNTHETIC_OPAQUE' }] });
const message = generation => ({ role: 'assistant', content: [{ type: 'reasoning', text: 'synthetic summary' }], source: { ...route, replayState: wrapReplayState(native(), scope(generation)) } });

async function fixture(run) {
  const prefix = join(tmpdir(), 'codex-native-replay-');
  const root = await mkdtemp(prefix);
  const owner = join(root, 'desktop');
  const path = join(owner, 'grant-generation.json');
  await mkdir(owner);
  await writeFile(path, JSON.stringify({ version: 1, generation: epoch }) + '\n', { mode: 0o600 });
  const runtime = n => ({ generation: n, path: new URL('file:///synthetic-runtime/grant-generation.json'), release: async () => {} });
  try { return await run({ root, owner, path, runtime }); }
  finally {
    assert.ok(resolve(root).startsWith(resolve(prefix)));
    await rm(root, { recursive: true, force: true });
  }
}

test('independent ACP runtime instances borrow one durable owner epoch read-only', () => fixture(async ({owner,path,runtime}) => {
  const before = await stat(path);
  const original = await readFile(path, 'utf8');
  const [a,b] = await Promise.all([bindReplayGeneration(runtime('runtime-A'),owner),bindReplayGeneration(runtime('runtime-B'),owner)]);
  assert.equal(a.external,true); assert.equal(b.external,true);
  assert.equal(a.generation,epoch); assert.equal(b.generation,epoch);
  assert.equal(scope(a.generation),scope(b.generation));
  assert.equal(await readFile(path,'utf8'),original);
  assert.equal((await stat(path)).mtimeMs,before.mtimeMs);
}));

test('persisted encrypted reasoning reopens in another ACP process without signature degradation', () => fixture(async ({owner,runtime}) => {
  const first = await bindReplayGeneration(runtime('PID-A'),owner);
  const messages = [message(first.generation)];
  const persisted = JSON.parse(JSON.stringify(messages));
  const restarted = await bindReplayGeneration(runtime('PID-B'),owner);
  const restored = unwrapMessages(persisted,scope(await restarted.refresh()),route);
  assert.equal(restored[0].source.replayState.blocks,persisted[0].source.replayState.blocks);
  assert.equal(restored[0].source.replayState.blocks[0].thinkingSignature,'SYNTHETIC_OPAQUE');
  assert.equal(restored[0].source.replayState.response.kind,'pi-ai');
  assert.equal(persisted[0].source.replayState.response.kind,'codex-native');
}));

test('owner login rotation invalidates old reasoning for every concurrently running ACP instance', () => fixture(async ({owner,path,runtime}) => {
  const a=await bindReplayGeneration(runtime('A'),owner);
  const b=await bindReplayGeneration(runtime('B'),owner);
  const messages=[message(epoch)];
  const tmp=join(owner,'next.json');
  await writeFile(tmp,JSON.stringify({version:1,generation:nextEpoch}));
  assert.equal(resolve(path),join(resolve(owner),'grant-generation.json'));
  await rename(tmp,path);
  assert.equal(await a.refresh(),nextEpoch); assert.equal(await b.refresh(),nextEpoch);
  assert.throws(()=>unwrapMessages(messages,scope(a.generation),route),{code:'CODEX_REPLAY_SCOPE_MISMATCH'});
}));

test('account changes still reject replay even when the owner epoch stays the same', () => fixture(async ({owner,runtime}) => {
  const a=await bindReplayGeneration(runtime('A'),owner);
  assert.throws(()=>unwrapMessages([message(epoch)],scope(a.generation,'synthetic-account-B'),route),{code:'CODEX_REPLAY_SCOPE_MISMATCH'});
}));

test('runtime generation is never accepted as an alias for the owner generation', () => fixture(async ({owner,runtime}) => {
  const a=await bindReplayGeneration(runtime(nextEpoch),owner);
  assert.throws(()=>unwrapMessages([message(nextEpoch)],scope(a.generation),route),{code:'CODEX_REPLAY_SCOPE_MISMATCH'});
}));

test('missing owner state fails closed instead of generating a new authorization epoch', () => fixture(async ({root,runtime}) => {
  await assert.rejects(bindReplayGeneration(runtime('A'),join(root,'missing')),{code:'CODEX_REPLAY_OWNER_UNAVAILABLE'});
  await assert.rejects(stat(join(root,'missing')),{code:'ENOENT'});
}));

for(const invalid of [{version:2,generation:epoch},{version:1,generation:'bad'},{version:1},null]) {
  test('malformed owner epoch fails closed: '+JSON.stringify(invalid),()=>fixture(async ({owner,path,runtime})=>{
    await writeFile(path,JSON.stringify(invalid));
    await assert.rejects(bindReplayGeneration(runtime('A'),owner),{code:'CODEX_REPLAY_OWNER_INVALID'});
  }));
}

test('relative owner paths are rejected before filesystem access',async()=>{
  await assert.rejects(bindReplayGeneration({generation:epoch},'relative-owner'),{code:'CODEX_REPLAY_OWNER_DIRECTORY_REQUIRED'});
});

test('standalone desktop-compatible generation remains mutable and needs no external file',async()=>{
  const state=await bindReplayGeneration({generation:epoch});
  assert.equal(state.external,false); assert.equal(await state.refresh(),epoch);
  state.generation=nextEpoch; assert.equal(await state.refresh(),nextEpoch);
});
