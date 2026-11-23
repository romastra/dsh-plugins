import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalZoomPreference, STORAGE_KEY } from '../src/local-preference.js';
import { createZoomController } from '../src/controller.js';

function browser() {
  const values = new Map();
  const listeners = new Set();
  let blocked = false;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (blocked) throw new Error('QuotaExceededError'); values.set(key, value); },
  };
  const open = () => {
    const preference = createLocalZoomPreference({
      getStorage: () => storage,
      subscribeStorage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    });
    const controller = createZoomController(preference);
    return { preference, controller, dispose() { controller.dispose(); preference.dispose(); } };
  };
  return { storage, values, open, block(value) { blocked = value; },
    event(event) { for (const listener of listeners) listener(event); },
  };
}

test('Desktop and phone controllers persist independent browser values through reloads', async () => {
  const desktop = browser();
  const phone = browser();
  let a = desktop.open();
  let b = phone.open();
  assert.equal(a.controller.getSnapshot().percent, 100);
  assert.equal(b.controller.getSnapshot().percent, 100);
  await a.controller.change('in');
  const desktopPercent = 100 * Math.exp(.1);
  assert.equal(a.controller.getSnapshot().percent, desktopPercent);
  assert.equal(b.controller.getSnapshot().percent, 100);
  await b.controller.set(81.87307530779819);
  assert.equal(a.controller.getSnapshot().percent, desktopPercent);
  assert.equal(b.controller.getSnapshot().percent, 81.87307530779819);
  assert.notEqual(desktop.values.get(STORAGE_KEY), phone.values.get(STORAGE_KEY));
  // Even a wrongly routed event cannot import a different browser's storageArea.
  phone.event({ key: STORAGE_KEY, storageArea: desktop.storage, newValue: desktop.values.get(STORAGE_KEY) });
  assert.equal(b.controller.getSnapshot().percent, 81.87307530779819);
  a.dispose(); b.dispose();
  a = desktop.open(); b = phone.open();
  assert.equal(a.controller.getSnapshot().percent, desktopPercent);
  assert.equal(b.controller.getSnapshot().percent, 81.87307530779819);
  a.dispose(); b.dispose();
});

test('same-origin tabs synchronize only after a real local storage event', async () => {
  const origin = browser();
  const a = origin.open();
  const b = origin.open();
  await a.controller.set(164.87212707001282);
  assert.equal(b.controller.getSnapshot().percent, 100);
  origin.event({ key: STORAGE_KEY, storageArea: origin.storage });
  assert.equal(b.controller.getSnapshot().percent, 164.87212707001282);
  a.dispose(); b.dispose();
});

test('quota failure retains usable tab-local zoom, reports unsaved status and permits retry', async () => {
  const origin = browser();
  const a = origin.open();
  origin.block(true);
  assert.equal(await a.controller.set(150.123456789), false);
  assert.equal(a.controller.getSnapshot().percent, 150.123456789);
  assert.equal(a.controller.getSnapshot().writable, true);
  assert.equal(a.controller.getSnapshot().persistent, false);
  assert.equal(a.controller.getSnapshot().error, true);
  assert.equal(origin.values.has(STORAGE_KEY), false);
  origin.block(false);
  assert.equal(await a.controller.set(150.123456789), true, 'same value must still retry a failed save');
  assert.equal(a.controller.getSnapshot().persistent, true);
  assert.equal(a.controller.getSnapshot().error, false);
  a.dispose();
  const reloaded = origin.open();
  assert.equal(reloaded.controller.getSnapshot().percent, 150.123456789);
  reloaded.dispose();
});

test('a later healthy same-origin update clears an obsolete local persistence warning', async () => {
  const origin = browser();
  const a = origin.open();
  origin.block(true);
  await a.controller.set(150);
  assert.equal(a.controller.getSnapshot().error, true);
  origin.block(false);
  origin.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, percent: 175 }));
  origin.event({ key: STORAGE_KEY, storageArea: origin.storage });
  assert.equal(a.controller.getSnapshot().percent, 175);
  assert.equal(a.controller.getSnapshot().persistent, true);
  assert.equal(a.controller.getSnapshot().error, false);
  a.dispose();
});

test('drag remains local and write-free until release, then saves only to the originating browser', async () => {
  const desktop = browser(); const phone = browser();
  const a = desktop.open(); const b = phone.open();
  for (let i = 0; i < 200; i++) a.controller.preview(50 + i);
  assert.equal(desktop.values.has(STORAGE_KEY), false);
  assert.equal(phone.values.has(STORAGE_KEY), false);
  assert.equal(b.controller.getSnapshot().percent, 100);
  await a.controller.commit();
  assert.equal(JSON.parse(desktop.values.get(STORAGE_KEY)).percent, 249);
  assert.equal(phone.values.has(STORAGE_KEY), false);
  a.dispose(); b.dispose();
});
