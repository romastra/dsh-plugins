import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoomController } from '../src/controller.js';
import { nextZoom } from '../src/scale.js';

function fixture(percent = 100, patch = {}) {
  let snapshot = { status: 'ready', writable: true, value: { percent }, ...patch };
  const listeners = new Set();
  const calls = [];
  const notify = value => { snapshot = { ...snapshot, ...value }; for (const fn of listeners) fn(); };
  const form = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(field, value) {
      return new Promise((resolve, reject) => calls.push({ field, value,
        accept() { notify({ value: { percent: value } }); resolve(true); },
        refuse() { resolve(false); }, fail() { reject(new Error('network')); },
      }));
    },
  };
  return { controller: createZoomController(form), calls, listeners, notify };
}

test('accepted Host value initializes independently from font preferences and retains legacy values', () => {
  const f = fixture(125);
  assert.equal(f.controller.getSnapshot().percent, 125);
  assert.equal(f.controller.getSnapshot().ready, true);
  f.notify({ value: { percent: 90.48374180359595, fontSize: 20 } });
  assert.equal(f.controller.getSnapshot().percent, 90.48374180359595);
  f.controller.dispose();
});

test('rapid keys use latest log gesture and ignore intermediate Host echoes', async () => {
  const f = fixture();
  const firstValue = nextZoom(100, 'in');
  const secondValue = nextZoom(firstValue, 'in');
  const first = f.controller.change('in');
  const second = f.controller.change('in');
  assert.deepEqual(f.calls.map(call => [call.field, call.value]), [['percent', firstValue], ['percent', secondValue]]);
  f.calls[0].accept(); await first;
  assert.equal(f.controller.getSnapshot().percent, secondValue);
  assert.equal(f.controller.getSnapshot().pending, true);
  f.calls[1].accept(); await second;
  assert.equal(f.controller.getSnapshot().percent, secondValue);
  assert.equal(f.controller.getSnapshot().pending, false);
  assert.equal(f.controller.getSnapshot().error, false);
  f.controller.dispose();
});

test('latest refusal rolls back to accepted value with feedback', async () => {
  const f = fixture(125);
  const write = f.controller.change('in');
  assert.equal(f.controller.getSnapshot().percent, nextZoom(125, 'in'));
  f.calls[0].refuse();
  assert.equal(await write, false);
  assert.equal(f.controller.getSnapshot().percent, 125);
  assert.equal(f.controller.getSnapshot().error, true);
  f.controller.dispose();
});

test('earlier failed write cannot overwrite a later accepted gesture', async () => {
  const f = fixture();
  const a = f.controller.change('in');
  const b = f.controller.change('in');
  const expected = nextZoom(nextZoom(100, 'in'), 'in');
  f.calls[0].fail(); await a;
  assert.equal(f.controller.getSnapshot().percent, expected);
  assert.equal(f.controller.getSnapshot().error, false);
  f.calls[1].accept(); await b;
  assert.equal(f.controller.getSnapshot().percent, expected);
  assert.equal(f.controller.getSnapshot().error, false);
  f.controller.dispose();
});

test('transport rejection is caught, rolled back and reported', async () => {
  const f = fixture();
  const write = f.controller.change('out');
  f.calls[0].fail();
  assert.equal(await write, false);
  assert.equal(f.controller.getSnapshot().percent, 100);
  assert.equal(f.controller.getSnapshot().error, true);
  f.controller.dispose();
});

test('unavailable or read-only settings are not mutated', async () => {
  for (const patch of [{ status: 'loading', value: undefined }, { writable: false }, { value: { percent: 'bad' } }]) {
    const f = fixture(100, patch);
    assert.equal(await f.controller.change('in'), false);
    assert.equal(f.controller.preview(150), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.controller.getSnapshot().error, true);
    f.controller.dispose();
  }
});

test('bounds/reset give feedback without redundant writes or dead 100% steps', async () => {
  const f = fixture(300);
  assert.equal(await f.controller.change('in'), true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getSnapshot().notice, 1);
  const reset = f.controller.change('reset');
  assert.equal(f.calls[0].value, 100);
  f.calls[0].accept(); await reset;
  await f.controller.change('reset');
  assert.equal(f.calls.length, 1);
  const out = f.controller.change('out');
  assert.ok(f.calls[1].value < 100);
  f.calls[1].accept(); await out;
  const back = f.controller.change('in');
  assert.equal(f.calls[2].value, 100);
  f.calls[2].accept(); await back;
  const onward = f.controller.change('in');
  assert.ok(f.calls[3].value > 100);
  f.calls[3].accept(); await onward;
  f.controller.dispose();
});

test('drag previews do not flood profile writes; release commits exactly one full-precision value', async () => {
  const f = fixture();
  for (let i = 0; i < 500; i++) assert.equal(f.controller.preview(50 + i / 3), true);
  const final = 100 * Math.exp(.4);
  f.controller.preview(final);
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getSnapshot().previewing, true);
  assert.equal(f.controller.getSnapshot().notice, 0);
  f.notify({ value: { percent: 90 } });
  assert.equal(f.controller.getSnapshot().percent, final);
  const commit = f.controller.commit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].value, final);
  assert.equal(f.controller.getSnapshot().previewing, false);
  f.calls[0].accept(); await commit;
  await f.controller.commit();
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getSnapshot().percent, final);
  f.controller.dispose();
});

test('Host echo of an earlier key write cannot overwrite an ongoing drag', async () => {
  const f = fixture();
  const key = f.controller.change('in');
  f.controller.preview(200.123456789);
  f.calls[0].accept(); await key;
  assert.equal(f.controller.getSnapshot().percent, 200.123456789);
  const drag = f.controller.commit();
  f.calls[1].accept(); await drag;
  assert.equal(f.controller.getSnapshot().percent, 200.123456789);
  f.controller.dispose();
});

test('failed drag commit restores durable value; no false save', async () => {
  const f = fixture(125);
  f.controller.preview(100);
  const save = f.controller.commit();
  f.calls[0].fail();
  assert.equal(await save, false);
  assert.equal(f.controller.getSnapshot().percent, 125);
  assert.equal(f.controller.getSnapshot().error, true);
  assert.equal(f.controller.getSnapshot().previewing, false);
  f.controller.dispose();
});

test('reset and explicit fractional set use same operation, preserving precision', async () => {
  const f = fixture(125);
  const value = 100 * Math.exp(.1);
  const save = f.controller.set(value);
  assert.equal(f.calls[0].value, value);
  f.calls[0].accept(); await save;
  await assert.rejects(f.controller.set(NaN), RangeError);
  assert.throws(() => f.controller.preview(900), RangeError);
  f.controller.dispose();
});

test('retry an unchanged value when browser storage previously failed', async () => {
  const f = fixture(100, { persistent: false });
  assert.equal(f.controller.getSnapshot().persistent, false);
  const retry = f.controller.change('reset');
  assert.equal(f.calls.length, 1, 'an unchanged numeric value must still retry persistence');
  f.notify({ persistent: true });
  f.calls[0].accept();
  assert.equal(await retry, true);
  assert.equal(f.controller.getSnapshot().persistent, true);
  await f.controller.change('reset');
  assert.equal(f.calls.length, 1, 'successful persistence makes another identical reset idempotent');
  f.controller.dispose();
});

test('disposal removes subscriptions and suppresses late async notifications', async () => {
  const f = fixture();
  let updates = 0;
  f.controller.subscribe(() => updates++);
  const write = f.controller.change('in');
  const before = updates;
  f.controller.dispose();
  assert.equal(f.listeners.size, 0);
  f.calls[0].accept(); await write;
  assert.equal(updates, before);
  assert.equal(await f.controller.change('in'), false);
  assert.equal(f.controller.preview(150), false);
  assert.equal(f.calls.length, 1);
});
