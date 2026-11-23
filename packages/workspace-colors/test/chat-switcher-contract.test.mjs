import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE } from '../palette.js';
import { createColorStore } from '../src/store.js';
import { createWorkspaceColorSource } from '../src/color-source.js';
import { createWorkspaceColorBridge, workspaceColor, workspaceTintStyle } from '../../chat-switcher/src/workspace-tint.js';
import { readCardMeta } from '../../chat-switcher/src/card-meta.js';

// Exercise the real producer and consumer together using ordinary snapshots.
// No Cordis/React/DOM emulation and no persistent state or user preferences.
function setup() {
  const store = createColorStore({ call: async () => ({ generation: 'host', revision: 0, colors: {} }) });
  const producer = createWorkspaceColorSource(store);
  const consumer = createWorkspaceColorBridge();
  const disconnect = consumer.connect(producer.source);
  return { store, producer, consumer, disconnect,
    async close() { consumer.dispose(); producer.dispose(); await store.dispose(); } };
}

test('real Workspace color source and Chat Switcher consumer agree on every MSX color', async () => {
  const f = setup();
  for (const color of PALETTE) {
    f.store.accept({ generation: 'host', revision: color.index, colors: { workspace: color.index } });
    assert.equal(f.producer.source.getSnapshot().colors.workspace, color.hex);
    assert.equal(workspaceColor(f.consumer.getSnapshot(), 'workspace'), color.hex);
    assert.deepEqual(workspaceTintStyle(workspaceColor(f.consumer.getSnapshot(), 'workspace')), { '--cs-workspace-color': color.hex });
  }
  await f.close();
});

test('real reset/reconnect/remove operations remove or replace consumer tints without copying saved state', async () => {
  const f = setup();
  f.store.accept({ generation: 'host', revision: 1, colors: { workspace: 8 } });
  assert.equal(workspaceColor(f.consumer.getSnapshot(), 'workspace'), '#db6559');
  f.store.accept({ generation: 'host', revision: 2, colors: {} });
  assert.equal(workspaceColor(f.consumer.getSnapshot(), 'workspace'), null);
  f.store.accept({ generation: 'new-host', revision: 0, colors: { workspace: 7 } });
  assert.equal(workspaceColor(f.consumer.getSnapshot(), 'workspace'), '#65dbef');
  f.disconnect(); assert.equal(f.consumer.getSnapshot().active, false);
  f.consumer.connect(f.producer.source); assert.equal(workspaceColor(f.consumer.getSnapshot(), 'workspace'), '#65dbef');
  await f.close();
});

test('same-named parent and nested Workspaces give each card only its exact owner color', async () => {
  const f = setup();
  const meta = readCardMeta({ byId: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c', workspaceId: 'parent' } } }, { items: [
    { workspaceId: 'parent', title: 'Same', path: '/root', sessionIds: ['a'] },
    { workspaceId: 'nested', title: 'Same', path: '/root/nested', sessionIds: ['b'] },
  ] });
  f.store.accept({ generation: 'host', revision: 1, colors: { parent: 8, nested: 4 } });
  assert.equal(workspaceColor(f.consumer.getSnapshot(), meta.get('a').workspaceId), '#db6559');
  assert.equal(workspaceColor(f.consumer.getSnapshot(), meta.get('b').workspaceId), '#5955e0');
  assert.equal(workspaceColor(f.consumer.getSnapshot(), meta.get('c').workspaceId), null);
  f.store.accept({ generation: 'host', revision: 2, colors: { parent: 8 } });
  assert.equal(workspaceColor(f.consumer.getSnapshot(), meta.get('b').workspaceId), null);
  await f.close();
});

test('consumer receives a read-only detached snapshot, not producer mutation methods or index records', async () => {
  const f = setup(); f.store.accept({ generation: 'host', revision: 1, colors: { workspace: 8 } });
  const original = f.producer.source.getSnapshot();
  assert.deepEqual(Object.keys(f.producer.source).sort(), ['getSnapshot', 'subscribe']);
  assert.notEqual(original.colors, f.consumer.getSnapshot().colors);
  assert.throws(() => { f.consumer.getSnapshot().colors.workspace = '#ffffff'; }, TypeError);
  assert.equal(f.producer.source.getSnapshot(), original);
  assert.equal(f.store.getSnapshot().colors.workspace, 8);
  await f.close();
});
