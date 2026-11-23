import test from 'node:test';
import assert from 'node:assert/strict';
import { tensionModel, TENSION_CSS } from '../src/tension.js';

test('visual tension follows distance with bounded elastic resistance, not linear runaway', () => {
  let previous = tensionModel(0), previousStep = Infinity;
  assert.equal(previous.opacity, 0); assert.equal(previous.progress, 0);
  for (let d = 8; d <= 320; d += 8) {
    const value = tensionModel(d);
    assert.ok(value.reach >= previous.reach); assert.ok(value.reach < 86);
    assert.ok(value.reach - previous.reach <= previousStep + 1e-12);
    previousStep = value.reach - previous.reach;
    assert.ok(value.progress >= 0 && value.progress <= .96);
    assert.ok(value.opacity >= 0 && value.opacity <= 1);
    assert.doesNotMatch(value.dash, /NaN|Infinity/);assert.equal(Object.hasOwn(value,'membrane'),false);
    previous = value;
  }
});
test('threshold readiness changes geometry as well as color; reversal restores partial progress', () => {
  const before = tensionModel(79, false), ready = tensionModel(80, true), back = tensionModel(40, false);
  assert.equal(ready.progress, 1); assert.ok(ready.scale > before.scale);
  assert.ok(before.progress < ready.progress); assert.ok(back.progress < before.progress);
  assert.ok(back.reach < before.reach);
});
test('invalid or oversize input produces finite deterministic geometry', () => {
  for (const distance of [-100, NaN, Infinity, undefined, null, 0, 50, 10000]) {
    const model = tensionModel(distance);
    for (const key of ['progress','reach','opacity','scale']) assert.ok(Number.isFinite(model[key]));
    assert.deepEqual(model, tensionModel(distance));
  }
  assert.deepEqual(tensionModel(10000), tensionModel(320));
});
test('indicator is edge-local, mirrored for dismiss, non-interactive and without loading animation or text', () => {
  assert.match(TENSION_CSS, /\.cs-tension\{[^}]*left:0;top:50%/);
  assert.match(TENSION_CSS, /pointer-events:none/);
  assert.match(TENSION_CSS, /\[data-side=right\]\{left:auto;right:0\}/);
  assert.match(TENSION_CSS, /\.cs-tension\{[^}]*height:704px/);
  assert.match(TENSION_CSS, /\.cs-tension-head-svg\{width:100%;height:100%\}/);
  assert.doesNotMatch(TENSION_CSS,/membrane|scaleX|32%/,'only the large circular indicator remains, with no stretched edge');
  assert.match(TENSION_CSS, /width:560px;max-width:none/, 'head viewport is uniformly four times the 140×176 design');
  assert.doesNotMatch(TENSION_CSS, /head-svg\{transform:scaleX/, 'the current chat image must not be mirrored or vertically stretched');
  assert.doesNotMatch(TENSION_CSS, /animation|@keyframes|content:|#[a-f0-9]{3,8}\b|rgba?\(/i);
  assert.match(TENSION_CSS, /--dsw-alias-brand-primary/);
});
