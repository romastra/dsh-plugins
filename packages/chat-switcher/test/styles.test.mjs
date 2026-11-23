import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_ACTION_CSS, PULL_CSS_TEXT } from '../src/styles.js';

test('blank header puts palette and native sidebar on one non-wrapping right-aligned row',()=>{
  const rules=[...IMAGE_ACTION_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([,selector,declarations])=>({selector,declarations}));
  const header=rules.find(x=>x.selector.trim().endsWith(':has(>[data-conversation-header-leading] .cs-blank-image-action)'));
  for(const rule of ['display:flex!important','flex-wrap:nowrap!important','align-items:center!important','justify-content:flex-end!important','column-gap:8px!important'])assert.ok(header.declarations.includes(rule),rule);
  assert.doesNotMatch(IMAGE_ACTION_CSS,/grid-area|grid-column|grid-template-columns|display:contents/);
  const title=rules.find(x=>x.selector.endsWith(' .an3WzG_titleRow'));
  assert.ok(title,'title row selector reaches through the Session scope wrapper');
  assert.ok(title.declarations.includes('container-type:normal!important'));
  assert.ok(title.declarations.includes('flex:0 0 auto!important'));
  assert.doesNotMatch(title.declarations,/height:|display:/,'keep the native 30px row and flex contents');
});
test('root palette is hidden outside the actual native blank phase, avoiding duplicate controls',()=>{
  assert.ok(IMAGE_ACTION_CSS.includes('.cs-blank-image-action{display:none}'));
  assert.ok(IMAGE_ACTION_CSS.includes('header.an3WzG_headerBlank>[data-conversation-header-leading] .cs-blank-image-action{display:inline-flex}'));
  assert.doesNotMatch(IMAGE_ACTION_CSS,/position:fixed|\.cs-image-brush/);
});

test('gesture feedback is non-interactive, theme-token-only, and leaves the core flex layout intact', () => {
  assert.match(PULL_CSS_TEXT, /\.cs-pull-frame\{display:contents\}/);
  assert.match(PULL_CSS_TEXT, /\.cs-modal-area\{[^}]*visibility:hidden;pointer-events:none/);
  assert.match(PULL_CSS_TEXT, /\.cs-dialog\.cs-chat-area \.cs-grid\{[^}]*min-height:0;max-height:none/);
  assert.doesNotMatch(PULL_CSS_TEXT, /cs-pull-hint|cs-dismiss-hint/);
  assert.doesNotMatch(PULL_CSS_TEXT, /touch-action|#[a-f0-9]{3,8}\b|rgba?\(/i);
  assert.match(PULL_CSS_TEXT, /min-width:44px;min-height:44px/);
  assert.match(PULL_CSS_TEXT, /grid-template-columns:repeat\(auto-fit,minmax\(min\(150px,100%\),1fr\)\)/, 'new task/status bands collapse to one readable column at large zoom instead of clipping');
});
