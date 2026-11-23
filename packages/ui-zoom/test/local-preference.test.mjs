import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, decodeStoredZoom, createLocalZoomPreference } from '../src/local-preference.js';
import { createZoomController } from '../src/controller.js';
import { nextZoom, ZOOM_LEVELS } from '../src/scale.js';

const encode = percent => JSON.stringify({ version: 1, percent });

// Plain Storage contract and event bus: no browser globals, DOM, or renderer.
function memoryStorage(entries = []) {
  const values = entries instanceof Map ? entries : new Map(entries);
  const calls = { reads: [], writes: [], removes: [], clears: 0 };
  return {
    calls, failRead: false, failWrite: false,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) {
      calls.reads.push(String(key));
      if (this.failRead) throw new Error('SecurityError: storage read blocked');
      return values.get(String(key)) ?? null;
    },
    setItem(key, value) {
      calls.writes.push([String(key), String(value)]);
      if (this.failWrite) throw new Error('QuotaExceededError: storage write blocked');
      values.set(String(key), String(value));
    },
    removeItem(key) { calls.removes.push(String(key)); values.delete(String(key)); },
    clear() { calls.clears++; values.clear(); },
  };
}

function eventBus() {
  const listeners = new Set();
  const callbacks = [];
  return {
    listeners, callbacks, disposals: 0,
    subscribe(callback) {
      listeners.add(callback);
      callbacks.push(callback);
      return () => { this.disposals++; listeners.delete(callback); };
    },
    emit(event) { for (const callback of [...listeners]) callback(event); },
  };
}

function tab(storage, events = eventBus()) {
  let getterCalls = 0;
  const preference = createLocalZoomPreference({
    getStorage: () => { getterCalls++; return storage; },
    subscribeStorage: callback => events.subscribe(callback),
  });
  return { preference, events, get getterCalls() { return getterCalls; } };
}

function expectSnapshot(preference, percent, persistent = true, problem = null) {
  assert.deepEqual(preference.getSnapshot(), {
    status: 'ready', value: { percent }, writable: true, persistent, problem,
  });
}

test('versioned decoder accepts full-double percentages, endpoints, and no coercion', () => {
  assert.equal(STORAGE_KEY, 'dsh.ui-zoom.browser.v1');
  for (const percent of [50, 50.00000000000001, 75, 99.99999999999999, 100, 123.45678901234567, 299.99999999999994, 300, ...ZOOM_LEVELS]) {
    assert.equal(decodeStoredZoom(encode(percent)), percent);
  }
});

test('decoder rejects corrupt JSON, wrong envelopes/versions, types, ranges, and nonfinite numbers', () => {
  const invalid = [
    undefined, null, 100, true, {}, [], new String(encode(100)),
    '', 'not JSON', '{', 'null', 'true', '100', '"100"', '[]',
    '{}', '{"percent":100}', '{"version":0,"percent":100}',
    '{"version":2,"percent":100}', '{"version":"1","percent":100}',
    '{"version":true,"percent":100}', '{"version":1}',
    '{"version":1,"percent":"100"}', '{"version":1,"percent":null}',
    '{"version":1,"percent":true}', '{"version":1,"percent":[]}',
    '{"version":1,"percent":{}}', '{"version":1,"percent":1e400}',
    '{"version":1,"percent":-1e400}', '{"version":1,"percent":NaN}',
    '{"version":1,"percent":Infinity}', encode(49.999), encode(300.001), encode(-100),
  ];
  for (const raw of invalid) assert.equal(decodeStoredZoom(raw), undefined, String(raw));
});

test('new browser starts at 100 without reading old shared settings or writing defaults', () => {
  const storage = memoryStorage([['old-host-percent', '225']]);
  const { preference } = tab(storage);
  expectSnapshot(preference, 100);
  assert.deepEqual(storage.calls.reads, [STORAGE_KEY]);
  assert.deepEqual(storage.calls.writes, []);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  preference.dispose();
});

test('initial local preference is ready, writable, immutable, stable, and never rewritten on load', () => {
  const percent = 100 * Math.exp(.1);
  const storage = memoryStorage([[STORAGE_KEY, encode(percent)]]);
  const { preference } = tab(storage);
  expectSnapshot(preference, percent);
  const initial = preference.getSnapshot();
  assert.equal(preference.getSnapshot(), initial);
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.value), true);
  assert.throws(() => { initial.value.percent = 200; }, TypeError);
  assert.equal(storage.calls.writes.length, 0);
  preference.dispose();
});

test('invalid local records fall back without writes and explicit changes can replace them', async () => {
  for (const raw of ['', 'broken', '{"version":2,"percent":175}', '{"version":1,"percent":900}']) {
    const storage = memoryStorage([[STORAGE_KEY, raw]]);
    const { preference } = tab(storage);
    expectSnapshot(preference, 100, false, 'invalid');
    assert.equal(storage.calls.writes.length, 0);
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(await preference.set('percent', 125.123456789), true);
    expectSnapshot(preference, 125.123456789);
    assert.equal(storage.getItem(STORAGE_KEY), encode(125.123456789));
    preference.dispose();
  }
});

test('set rejects every unsupported field or invalid percentage without reads, writes, or notifications', async () => {
  const storage = memoryStorage();
  const f = tab(storage);
  const initial = f.preference.getSnapshot();
  let updates = 0;
  f.preference.subscribe(() => updates++);
  for (const field of [undefined, null, '', 'zoom', 'fontSize', 'Percent', {}, ['percent']]) {
    assert.equal(await f.preference.set(field, 125), false);
  }
  for (const value of [undefined, null, '100', true, [], {}, new Number(100), NaN, Infinity, -Infinity, 49.999, 300.001]) {
    assert.equal(await f.preference.set('percent', value), false);
  }
  assert.equal(f.getterCalls, 1);
  assert.equal(f.preference.getSnapshot(), initial);
  assert.equal(updates, 0);
  assert.equal(storage.calls.writes.length, 0);
  f.preference.dispose();
});

test('set writes synchronously before publishing same-page subscribers and resolves persistence truthfully', async () => {
  const storage = memoryStorage();
  const { preference } = tab(storage);
  const percent = 100 * Math.exp(.4);
  const updates = [];
  const unsubscribe = preference.subscribe(() => {
    updates.push(preference.getSnapshot());
    assert.equal(storage.getItem(STORAGE_KEY), encode(preference.getSnapshot().value.percent));
  });
  const result = preference.set('percent', percent);
  assert.equal(typeof result.then, 'function');
  assert.equal(storage.getItem(STORAGE_KEY), encode(percent));
  expectSnapshot(preference, percent);
  assert.equal(updates.length, 1, 'same-page update does not wait for a storage event or Promise turn');
  assert.equal(await result, true);
  unsubscribe();
  assert.equal(await preference.set('percent', 125), true);
  assert.equal(updates.length, 1);
  preference.dispose();
});

test('full-double values survive adapter disposal/reload without rounding or redundant load writes', async () => {
  for (const percent of [50, 50.00000000000001, 90.48374180359595, 99.99999999999999, 100, 123.45678901234567, 299.99999999999994, 300, ...ZOOM_LEVELS]) {
    const storage = memoryStorage();
    const first = tab(storage);
    assert.equal(await first.preference.set('percent', percent), true);
    first.preference.dispose();
    const second = tab(storage);
    expectSnapshot(second.preference, percent);
    assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), { version: 1, percent });
    assert.equal(storage.calls.writes.length, 1);
    second.preference.dispose();
  }
});

test('Desktop and phone browser storage maps never propagate preferences to each other', async () => {
  const events = eventBus();
  const desktopStorage = memoryStorage();
  const phoneStorage = memoryStorage();
  const desktop = tab(desktopStorage, events);
  const phone = tab(phoneStorage, events);
  assert.equal(await desktop.preference.set('percent', 175), true);
  events.emit({ key: STORAGE_KEY, newValue: encode(175), storageArea: desktopStorage });
  expectSnapshot(desktop.preference, 175);
  expectSnapshot(phone.preference, 100);
  assert.equal(await phone.preference.set('percent', 80), true);
  events.emit({ key: STORAGE_KEY, newValue: encode(80), storageArea: phoneStorage });
  expectSnapshot(desktop.preference, 175);
  expectSnapshot(phone.preference, 80);
  assert.equal(phoneStorage.calls.writes.length, 1);
  assert.equal(desktopStorage.calls.writes.length, 1);
  desktop.preference.dispose(); phone.preference.dispose();
  const reloadedDesktop = tab(desktopStorage);
  const reloadedPhone = tab(phoneStorage);
  expectSnapshot(reloadedDesktop.preference, 175);
  expectSnapshot(reloadedPhone.preference, 80);
  reloadedDesktop.preference.dispose(); reloadedPhone.preference.dispose();
});

test('same-origin tabs share the underlying map using each receiving window storageArea', async () => {
  const map = new Map();
  const storageA = memoryStorage(map);
  const storageB = memoryStorage(map);
  const a = tab(storageA);
  const b = tab(storageB);
  let notificationsA = 0;
  let notificationsB = 0;
  a.preference.subscribe(() => notificationsA++);
  b.preference.subscribe(() => notificationsB++);
  assert.equal(await a.preference.set('percent', 150), true);
  expectSnapshot(a.preference, 150);
  expectSnapshot(b.preference, 100);
  b.events.emit({ key: STORAGE_KEY, storageArea: storageB, newValue: encode(150) });
  expectSnapshot(b.preference, 150);
  assert.equal(notificationsA, 1);
  assert.equal(notificationsB, 1);
  assert.equal(await b.preference.set('percent', 90), true);
  a.events.emit({ key: STORAGE_KEY, storageArea: storageA, newValue: encode(90) });
  expectSnapshot(a.preference, 90);
  assert.equal(storageA.calls.writes.length, 1, 'event synchronization must not echo writes');
  assert.equal(storageB.calls.writes.length, 1);
  a.preference.dispose(); b.preference.dispose();
});

test('removing the owned key resets other same-origin tabs to 100 without writing a replacement', () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(175)]]);
  const { preference, events } = tab(storage);
  storage.removeItem(STORAGE_KEY);
  events.emit({ key: STORAGE_KEY, storageArea: storage, oldValue: encode(175), newValue: null });
  expectSnapshot(preference, 100);
  assert.equal(storage.calls.writes.length, 0);
  const reloaded = tab(storage);
  expectSnapshot(reloaded.preference, 100);
  preference.dispose(); reloaded.preference.dispose();
});

test('storage clear events re-read the latest owned value and reset missing records to 100', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)], ['other', 'value']]);
  const { preference, events } = tab(storage);
  storage.clear();
  events.emit({ key: null, storageArea: storage, newValue: null });
  expectSnapshot(preference, 100);
  assert.equal(storage.calls.writes.length, 0);
  assert.equal(await preference.set('percent', 200), true);
  events.emit({ key: null, storageArea: storage, newValue: null });
  expectSnapshot(preference, 200, true, null);
  preference.dispose();
});

test('unrelated keys, sessionStorage, and foreign storage areas cannot affect the preference', () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)]]);
  const sessionStorage = memoryStorage([[STORAGE_KEY, encode(250)]]);
  const foreignStorage = memoryStorage([[STORAGE_KEY, encode(50)]]);
  const { preference, events } = tab(storage);
  const initial = preference.getSnapshot();
  let notifications = 0;
  preference.subscribe(() => notifications++);
  for (const event of [
    { key: 'unrelated', storageArea: storage, newValue: encode(250) },
    { key: STORAGE_KEY, storageArea: sessionStorage, newValue: encode(250) },
    { key: null, storageArea: sessionStorage },
    { key: STORAGE_KEY, storageArea: foreignStorage, newValue: encode(50) },
    { key: null, storageArea: foreignStorage },
    undefined, {}, { key: undefined, storageArea: storage },
  ]) events.emit(event);
  assert.equal(preference.getSnapshot(), initial);
  assert.equal(notifications, 0);
  assert.equal(storage.calls.reads.length, 1, 'ignored events must not read local records');
  assert.equal(sessionStorage.calls.reads.length, 0);
  assert.equal(foreignStorage.calls.reads.length, 0);
  preference.dispose();
});

test('storage events without storageArea still re-read this browser rather than payload data', () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)]]);
  const { preference, events } = tab(storage);
  events.emit({ key: STORAGE_KEY, newValue: encode(275) });
  expectSnapshot(preference, 125);
  storage.setItem(STORAGE_KEY, encode(150));
  events.emit({ key: STORAGE_KEY, storageArea: null, newValue: encode(80) });
  expectSnapshot(preference, 150);
  preference.dispose();
});

test('delayed events cannot revert more recent writes or revive a removed record', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(100)]]);
  const { preference, events } = tab(storage);
  storage.setItem(STORAGE_KEY, encode(125));
  storage.setItem(STORAGE_KEY, encode(150));
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(125) });
  expectSnapshot(preference, 150);
  assert.equal(await preference.set('percent', 200.123456789), true);
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(150) });
  expectSnapshot(preference, 200.123456789);
  storage.removeItem(STORAGE_KEY);
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(200.123456789) });
  expectSnapshot(preference, 100);
  preference.dispose();
});

test('invalid external records fall back without repair writes and can later be replaced explicitly', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(150)]]);
  const { preference, events } = tab(storage);
  storage.setItem(STORAGE_KEY, 'corrupt');
  const writesBeforeEvent = storage.calls.writes.length;
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(250) });
  expectSnapshot(preference, 100, false, 'invalid');
  assert.equal(storage.calls.writes.length, writesBeforeEvent);
  assert.equal(storage.getItem(STORAGE_KEY), 'corrupt');
  assert.equal(await preference.set('percent', 110.51709180756477), true);
  expectSnapshot(preference, 110.51709180756477);
  preference.dispose();
});

test('SecurityError from the storage getter leaves controls ready with memory fallback and write recovery', async () => {
  const storage = memoryStorage();
  const events = eventBus();
  let blocked = true;
  let getterCalls = 0;
  const preference = createLocalZoomPreference({
    getStorage() {
      getterCalls++;
      if (blocked) throw new Error('SecurityError: localStorage unavailable');
      return storage;
    },
    subscribeStorage: callback => events.subscribe(callback),
  });
  expectSnapshot(preference, 100, false, 'read');
  let notifications = 0;
  preference.subscribe(() => notifications++);
  const failed = preference.set('percent', 125);
  expectSnapshot(preference, 125, false, 'write');
  assert.equal(await failed, false);
  assert.equal(await preference.set('percent', 150), false);
  expectSnapshot(preference, 150, false, 'write');
  assert.equal(notifications, 2);
  assert.equal(getterCalls, 3);
  assert.equal(storage.calls.writes.length, 0);
  blocked = false;
  assert.equal(await preference.set('percent', 150), true, 'retry even an unchanged in-memory value');
  expectSnapshot(preference, 150);
  assert.equal(getterCalls, 4);
  const reloaded = tab(storage);
  expectSnapshot(reloaded.preference, 150);
  preference.dispose(); reloaded.preference.dispose();
});

test('a failing getItem never makes the adapter read-only and does not prevent a later successful setItem', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(175)]]);
  storage.failRead = true;
  const { preference } = tab(storage);
  expectSnapshot(preference, 100, false, 'read');
  assert.equal(storage.calls.writes.length, 0);
  assert.equal(await preference.set('percent', 123.45678901234567), true);
  expectSnapshot(preference, 123.45678901234567);
  storage.failRead = false;
  assert.equal(storage.getItem(STORAGE_KEY), encode(123.45678901234567));
  preference.dispose();
});

test('quota failure preserves accepted memory values, old durable bytes, and publishes recovery', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)]]);
  const { preference } = tab(storage);
  const observed = [];
  preference.subscribe(() => observed.push(preference.getSnapshot()));
  storage.failWrite = true;
  assert.equal(await preference.set('percent', 150), false);
  expectSnapshot(preference, 150, false, 'write');
  assert.equal(storage.getItem(STORAGE_KEY), encode(125));
  assert.equal(await preference.set('percent', 175.123456789), false);
  expectSnapshot(preference, 175.123456789, false, 'write');
  assert.equal(observed.length, 2);
  const separateReload = tab(storage);
  expectSnapshot(separateReload.preference, 125, true, null);
  separateReload.preference.dispose();
  storage.failWrite = false;
  assert.equal(await preference.set('percent', 175.123456789), true);
  expectSnapshot(preference, 175.123456789);
  assert.equal(storage.calls.writes.length, 3);
  assert.equal(observed.length, 3);
  preference.dispose();
});

test('missing storage capability can recover because every valid write reattempts the getter', async () => {
  const storage = memoryStorage();
  const events = eventBus();
  let available;
  const preference = createLocalZoomPreference({
    getStorage: () => available,
    subscribeStorage: callback => events.subscribe(callback),
  });
  expectSnapshot(preference, 100, false, 'read');
  assert.equal(await preference.set('percent', 90), false);
  expectSnapshot(preference, 90, false, 'write');
  available = storage;
  assert.equal(await preference.set('percent', 90), true);
  expectSnapshot(preference, 90);
  preference.dispose();
});

test('relevant read failures preserve current memory and a later storage event can recover', () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(150)]]);
  const { preference, events } = tab(storage);
  storage.failRead = true;
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(175) });
  expectSnapshot(preference, 150, false, 'read');
  storage.failRead = false;
  storage.setItem(STORAGE_KEY, encode(175));
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(50) });
  expectSnapshot(preference, 175);
  preference.dispose();
});

test('delayed unchanged-storage events do not discard a failed write memory choice', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)]]);
  const { preference, events } = tab(storage);
  storage.failWrite = true;
  assert.equal(await preference.set('percent', 175), false);
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(125) });
  expectSnapshot(preference, 175, false, 'write');
  events.emit({ key: STORAGE_KEY, newValue: encode(250) });
  expectSnapshot(preference, 175, false, 'write');
  storage.failWrite = false;
  storage.setItem(STORAGE_KEY, encode(200));
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(200) });
  expectSnapshot(preference, 200);
  preference.dispose();
});

test('an older queued tab write cannot discard a newer choice whose save failed', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(100)]]);
  const { preference, events } = tab(storage);
  storage.setItem(STORAGE_KEY, encode(200)); // Another tab wrote; its event is still queued.
  storage.failWrite = true;
  assert.equal(await preference.set('percent', 150), false);
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(200) });
  expectSnapshot(preference, 150, false, 'write');
  storage.failWrite = false;
  storage.setItem(STORAGE_KEY, encode(225)); // A genuinely later external choice can win.
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(225) });
  expectSnapshot(preference, 225);
  preference.dispose();
});

test('unreadable failed-save baseline retains memory until an explicit successful save', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(100)]]);
  const { preference, events } = tab(storage);
  storage.setItem(STORAGE_KEY, encode(200));
  storage.failWrite = true; storage.failRead = true;
  assert.equal(await preference.set('percent', 150), false);
  storage.failRead = false;
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(200) });
  expectSnapshot(preference, 150, false, 'write');
  storage.failWrite = false;
  assert.equal(await preference.set('percent', 150), true);
  expectSnapshot(preference, 150);
  storage.setItem(STORAGE_KEY, encode(225));
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(225) });
  expectSnapshot(preference, 225);
  preference.dispose();
});

test('dispose removes listeners/subscribers, ignores captured late events, and rejects later writes', async () => {
  const storage = memoryStorage();
  const { preference, events } = tab(storage);
  let notifications = 0;
  const unsubscribe = preference.subscribe(() => notifications++);
  assert.equal(events.listeners.size, 1);
  assert.equal(await preference.set('percent', 125), true);
  const before = preference.getSnapshot();
  const readsBefore = storage.calls.reads.length;
  const writesBefore = storage.calls.writes.length;
  preference.dispose();
  preference.dispose();
  assert.equal(events.listeners.size, 0);
  assert.equal(events.disposals, 1);
  preference.subscribe(() => assert.fail('must not subscribe after disposal'));
  storage.removeItem(STORAGE_KEY);
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: null });
  for (const callback of events.callbacks) callback({ key: null, storageArea: storage });
  assert.equal(await preference.set('percent', 175), false);
  unsubscribe();
  assert.equal(preference.getSnapshot(), before);
  assert.equal(notifications, 1);
  assert.equal(storage.calls.reads.length, readsBefore);
  assert.equal(storage.calls.writes.length, writesBefore);
});

test('existing controller retains key echo guards and commits one full-precision drag write', async () => {
  const storage = memoryStorage();
  const { preference, events } = tab(storage);
  const controller = createZoomController(preference);
  const first = controller.change('in');
  const second = controller.change('in');
  const afterKeys = nextZoom(nextZoom(100, 'in'), 'in');
  await Promise.all([first, second]);
  assert.equal(controller.getSnapshot().percent, afterKeys);
  assert.equal(storage.calls.writes.length, 2);
  const writesBeforeDrag = storage.calls.writes.length;
  for (let index = 0; index < 500; index++) assert.equal(controller.preview(50 + index / 3), true);
  const final = 100 * Math.exp(.4);
  controller.preview(final);
  assert.equal(storage.calls.writes.length, writesBeforeDrag);
  storage.setItem(STORAGE_KEY, encode(90));
  events.emit({ key: STORAGE_KEY, storageArea: storage, newValue: encode(90) });
  assert.equal(controller.getSnapshot().percent, final, 'external tab changes cannot overwrite an active preview');
  const beforeCommit = storage.calls.writes.length;
  assert.equal(await controller.commit(), true);
  assert.equal(await controller.commit(), true);
  assert.equal(storage.calls.writes.length, beforeCommit + 1);
  assert.equal(storage.getItem(STORAGE_KEY), encode(final));
  assert.equal(controller.getSnapshot().percent, final);
  assert.equal(controller.getSnapshot().pending, false);
  assert.equal(controller.getSnapshot().error, false);
  controller.dispose(); preference.dispose();
});

test('existing controller warns on failed persistence without rolling back the usable tab-local choice', async () => {
  const storage = memoryStorage([[STORAGE_KEY, encode(125)]]);
  const { preference } = tab(storage);
  const controller = createZoomController(preference);
  storage.failWrite = true;
  const chosen = 123.45678901234567;
  controller.preview(chosen);
  assert.equal(await controller.commit(), false);
  expectSnapshot(preference, chosen, false, 'write');
  assert.equal(controller.getSnapshot().percent, chosen);
  assert.equal(controller.getSnapshot().ready, true);
  assert.equal(controller.getSnapshot().writable, true);
  assert.equal(controller.getSnapshot().error, true);
  assert.equal(controller.getSnapshot().pending, false);
  assert.equal(controller.preview(150), true);
  assert.equal(await controller.commit(), false);
  assert.equal(controller.getSnapshot().percent, 150);
  storage.failWrite = false;
  assert.equal(await controller.change('in'), true);
  const recovered = nextZoom(150, 'in');
  assert.equal(controller.getSnapshot().percent, recovered);
  assert.equal(controller.getSnapshot().error, false);
  expectSnapshot(preference, recovered);
  controller.dispose(); preference.dispose();
});
