import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceColorSource } from '../src/color-source.js';
import { createColorStore } from '../src/store.js';
import { sessionWorkspaceIds, sessionColorRules, SESSION_HIERARCHY_CSS, SESSION_CHILD_STEP_PX } from '../src/session-colors.js';

const state = (revision, colors = {}, generation = 'host') => ({ generation, revision, colors });
const workspaces = [
  { workspaceId: 'parent', path: '/root', title: 'Same', sessionIds: ['one', 'shared'] },
  { workspaceId: 'child', path: '/root/nested', title: 'Same', sessionIds: ['two', 'shared'] },
  { workspaceId: 'plain', sessionIds: ['plain-session'] },
];

test('read-only color source exposes immutable cached hex colors, not palette/persistence operations', async () => {
  const store = createColorStore({ call: async () => state(0) });
  store.accept(state(0, { parent: 8, child: 7, invalid: 16, transparent: null }));
  const projection = createWorkspaceColorSource(store);
  const source = projection.source;
  const initial = source.getSnapshot();
  assert.deepEqual(Object.keys(source).sort(), ['getSnapshot', 'subscribe']);
  assert.deepEqual(initial, state(0, { parent: '#db6559', child: '#65dbef' }));
  assert.equal(source.getSnapshot(), initial);
  assert.ok(Object.isFrozen(source)); assert.ok(Object.isFrozen(initial)); assert.ok(Object.isFrozen(initial.colors));
  assert.throws(() => { initial.colors.parent = '#ffffff'; });
  store.accept(state(0, { parent: 8, child: 7, invalid: 16, transparent: null }));
  assert.equal(source.getSnapshot(), initial);
  projection.dispose(); await store.dispose();
});

test('shared source publishes save/reset/reconnect and releases listeners on dispose', async () => {
  const store = createColorStore({ call: async () => state(0) });
  const projection = createWorkspaceColorSource(store);
  let changes = 0;
  const unsubscribe = projection.source.subscribe(() => { changes++; });
  store.accept(state(1, { parent: 3 })); assert.equal(projection.source.getSnapshot().colors.parent, '#74d07d');
  store.accept(state(2, {})); assert.deepEqual(projection.source.getSnapshot().colors, {});
  store.accept(state(0, { child: 13 }, 'new-host')); assert.equal(projection.source.getSnapshot().colors.child, '#b766b5');
  assert.equal(changes, 3); unsubscribe(); projection.dispose();
  store.accept(state(1, { parent: 4 }, 'new-host')); assert.equal(changes, 3);
  assert.equal(projection.source.getSnapshot().colors.child, '#b766b5'); await store.dispose();
});

test('session membership uses stable IDs, exact first owner and no parent-path inheritance', () => {
  assert.deepEqual([...sessionWorkspaceIds(workspaces)], [['one', 'parent'], ['shared', 'parent'], ['two', 'child'], ['plain-session', 'plain']]);
  const css = sessionColorRules({ parent: 8, child: 7 }, workspaces);
  assert.match(css, /data-row-key="session:one"/); assert.match(css, /data-row-key="session:two"/);
  assert.match(css, /data-row-key="session:shared"/);
  assert.doesNotMatch(css, /session:plain-session|\/root|Same/);
  assert.equal((css.match(/session:shared/g) ?? []).length, 1);
  const noParentColor = sessionColorRules({ child: 7 }, workspaces);
  assert.doesNotMatch(noParentColor, /session:shared|session:one/);
  assert.match(noParentColor, /session:two/);
});

test('reset removes session paints immediately while hierarchy remains independent', () => {
  assert.equal(sessionColorRules({}, workspaces), '');
  assert.equal(sessionColorRules({ parent: null, child: 0, plain: 16 }, workspaces), '');
  assert.ok(SESSION_HIERARCHY_CSS.length > 0);
});

test('grouped paint and content add one child step to native depth, never fake flat-list nesting', () => {
  assert.equal(SESSION_CHILD_STEP_PX, 12);
  assert.match(SESSION_HIERARCHY_CSS, /\[style\*="--dsh-workspace-indent"\] \[data-row-key\^="session:"\]/);
  assert.match(SESSION_HIERARCHY_CSS, /--wc-session-paint-inset:calc\(var\(--dsh-workspace-indent, 0px\) \+ 12px\)/);
  assert.match(SESSION_HIERARCHY_CSS, /padding-inline-start:calc\(var\(--dsh-sidebar-row-padding\) - var\(--dsh-sidebar-paint-inset\) \+ var\(--dsh-workspace-indent, 0px\) \+ 12px\)/);
  assert.match(SESSION_HIERARCHY_CSS, /data-row-key\^="overflow:"/);
  const css = sessionColorRules({ parent: 8 }, workspaces);
  assert.match(css, /var\(--wc-session-paint-inset, 0px\)/);
  assert.doesNotMatch(css, /padding|margin|width:|height:/);
});

test('tint keeps native selection/hover/text/status/drag/focus; no pseudo-element collision', () => {
  const css = sessionColorRules({ parent: 8, child: 7 }, workspaces);
  assert.match(css, /#db6559 9%, transparent/); assert.match(css, /#65dbef 9%, transparent/);
  assert.match(css, /background-size:2px calc\(100% - 8px\)/);
  assert.doesNotMatch(css, /(?:^|[;{\n])\s*(?:background-color|color|outline|border|position|opacity|z-index):/);
  assert.doesNotMatch(css, /::before|::after|\[aria-selected|:hover|cs-card|cs-preview/);
});

test('session IDs use CSS string escaping and rules never target another surface', () => {
  const css = sessionColorRules({ parent: 3 }, [{ workspaceId: 'parent', sessionIds: ['s"\\\n<style>'] }]);
  assert.match(css, /\[data-sidebar-list-area\] \[data-row-key="session:/);
  assert.match(css, /\\22 /); assert.match(css, /\\5c /); assert.match(css, /\\a /);
  assert.doesNotMatch(css, /<style>/);
});
