import test from 'node:test';
import assert from 'node:assert/strict';
import { chatIndicator, liveInteractionKind } from '../src/status.js';
import { CSS_TEXT } from '../src/styles.js';

test('verified Done is a persistent bright green circle, not an unobtrusive checkmark', () => {
  assert.deepEqual(chatIndicator({}, {}, {kind:'completion',reminderActive:false}), {kind:'completion',reminderActive:false});
  assert.match(CSS_TEXT, /data-state=completion[^}]*#39ff70/);
  assert.match(CSS_TEXT, /cs-row-indicator>.cs-status-dot[^}]*width:12px/);
});
test('unread running-stop alone is not mislabeled successful Done', () => {
  assert.equal(chatIndicator({}, {completionUnread:true}).kind,'unread');
  assert.equal(chatIndicator({}, {running:true,completionUnread:true}).kind,'running');
  assert.equal(chatIndicator({running:true}, {running:false}).kind,'running');
});
test('real pending interactions take priority and observation never answers', () => {
  const q={kind:'question',getSnapshot:()=>({closed:false,channel:'rpc'}),answer(){throw Error('must not answer')}};
  assert.equal(chatIndicator({}, {running:true,pendingInteraction:q}, {kind:'completion'}).kind,'question');
  assert.equal(liveInteractionKind({kind:'approval',answerable:true}),'approval');
  assert.equal(liveInteractionKind({kind:'approval',answerable:false}),null);
  assert.equal(liveInteractionKind({...q,getSnapshot:()=>({closed:true,channel:'rpc'})}),null);
  assert.equal(liveInteractionKind({...q,review:{}}),null);
  assert.equal(liveInteractionKind({...q,getSnapshot:()=>({closed:false,channel:'auto'})}),null);
  assert.equal(liveInteractionKind({...q,getSnapshot(){throw Error('disposed')}}),null);
});
test('error has a bright red circle without claiming every attention event is an error', () => {
  assert.equal(chatIndicator({}, {completionUnread:true}, {kind:'attention',reason:'error'}).kind,'failed');
  assert.equal(chatIndicator({}, {}, {kind:'attention'}).kind,'attention');
  assert.match(CSS_TEXT,/data-state=failed[^}]*#ff4545/);
  assert.match(CSS_TEXT,/data-state=question[^}]*#ff5fd2/);
  assert.match(CSS_TEXT,/data-state=approval[^}]*#ffd332/);
});
test('theme background overlays the mosaic at50 percent without dimming labels', () => {
  assert.equal(CSS_TEXT.includes('.cs-mosaic-shade{background:var(--dsw-alias-bg-base,#171c23);opacity:.5}'),true);
  assert.doesNotMatch(CSS_TEXT,/.cs-preview{[^}]*opacity:/);
  assert.match(CSS_TEXT,/.cs-mosaic{[^}]*object-fit:contain/);
});
