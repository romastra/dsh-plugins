import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../src/usage.js';

const now = 1_800_000_000_000;
const window = (overrides = {}) => ({ used_percent: 45, limit_window_seconds: 18_000, reset_after_seconds: 600, ...overrides });
const body = (primary = window(), secondary) => ({ rate_limit: { primary_window: primary, secondary_window: secondary } });
const parse = value => parseUsage(value, { now });

const unknown = { state: 'unknown', windows: [] };
for (const [index, input] of [undefined, null, '', 'secret-token', 0, false, [], {},
  { rate_limit: [] }, { rate_limit: 'secret' }, { primary_window: window() },
  { rate_limit: { primary_window: {}, secondary_window: null } }].entries()) {
  test('malformed or missing body stays unknown, fixture ' + index, () => {
    assert.deepEqual(parse(input), unknown);
  });
}

test('public projection reports server USED percent and complementary remaining, without positional assumptions', () => {
  assert.deepEqual(parse(body(window(), window({ used_percent: 80, limit_window_seconds: 604_800, reset_at: 1_800_100_000 }))), {
    state: 'available', windows: [
      { kind: 'session', usedPercent: 45, remainingPercent: 55, resetAt: now + 600_000, windowSeconds: 18_000 },
      { kind: 'weekly', usedPercent: 80, remainingPercent: 20, resetAt: 1_800_100_000_000, windowSeconds: 604_800 },
    ],
  });
});

test('weekly-only primary lane stays weekly; secondary session lane stays session', () => {
  assert.equal(parse(body(window({ limit_window_seconds: 604_800 }))).windows[0].kind, 'weekly');
  const reversed = parse(body(window({ limit_window_seconds: 604_800 }), window()));
  assert.deepEqual(reversed.windows.map(value => value.kind), ['weekly', 'session']);
});

test('most constrained lane remains available to client as maximum USED, not first position', () => {
  const windows = parse(body(window({ used_percent: 10 }), window({ used_percent: 45, limit_window_seconds: 604_800 }))).windows;
  const constrained = windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b);
  assert.equal(constrained.kind, 'weekly');
  assert.equal(constrained.usedPercent, 45);
  assert.equal(constrained.remainingPercent, 55);
});

for (const [seconds, kind] of [[17_100, 'session'], [18_900, 'session'], [17_099, 'other'],
  [18_901, 'other'], [574_560, 'weekly'], [635_040, 'weekly'], [574_559, 'other'],
  [635_041, 'other'], [432_000, 'other'], [1, 'other']]) {
  test('classifies canonical duration with exact inclusive five percent boundary: ' + seconds, () => {
    const result = parse(body(window({ limit_window_seconds: seconds }))).windows[0];
    assert.equal(result.kind, kind);
    assert.equal(result.windowSeconds, seconds);
  });
}

for (const [index, seconds] of [undefined, null, '', '18000', 0, -1, NaN, Infinity, 18_000.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
  test('invalid or missing duration has no fabricated kind, fixture ' + index, () => {
    const result = parse(body(window({ limit_window_seconds: seconds }))).windows[0];
    assert.equal(result.kind, 'unknown');
    assert.equal(result.windowSeconds, null);
    assert.equal(result.usedPercent, 45);
  });
}

for (const [index, used] of [undefined, null, '', '0', '45', false, {}, [], NaN, Infinity, -Infinity, -0.01, 100.01].entries()) {
  test('invalid percentage is dropped rather than clamped/coerced, fixture ' + index, () => {
    assert.deepEqual(parse(body(window({ used_percent: used }))), unknown);
  });
}

test('valid zero, hundred and fractional percentages are not lost', () => {
  for (const used of [0, -0, 100, 99.5]) {
    const result = parse(body(window({ used_percent: used }))).windows[0];
    assert.equal(result.usedPercent, used === 0 ? 0 : used);
    assert.equal(result.remainingPercent, 100 - used);
  }
});

test('one malformed window does not hide another valid window', () => {
  const result = parse(body(window({ used_percent: 'invalid' }), window({ used_percent: 70, limit_window_seconds: 604_800 })));
  assert.equal(result.state, 'available');
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].kind, 'weekly');
});

test('limit_reached/allowed are not invented percentages or permission to override measured usage', () => {
  assert.deepEqual(parse({ rate_limit: { limit_reached: true, allowed: false } }), unknown);
  assert.deepEqual(parse({ rate_limit: { limit_reached: false, allowed: true } }), unknown);
  const measured = body(window({ used_percent: 0 }));
  measured.rate_limit.limit_reached = true;
  measured.rate_limit.allowed = false;
  assert.equal(parse(measured).windows[0].usedPercent, 0);
});

test('absolute reset epoch seconds wins over relative even if already past', () => {
  assert.equal(parse(body(window({ reset_at: 1_700_000_000, reset_after_seconds: 999 }))).windows[0].resetAt, 1_700_000_000_000);
});

test('relative resets use caller milliseconds and zero means now, not missing', () => {
  for (const [seconds, delta] of [[0, 0], [1, 1000], [0.5, 500]]) {
    assert.equal(parse(body(window({ reset_after_seconds: seconds }))).windows[0].resetAt, now + delta);
  }
});

for (const [index, absolute] of [undefined, null, '1800100000', 0, -1, NaN, Infinity, 8_640_000_000_001].entries()) {
  test('invalid absolute reset safely falls back to valid relative, fixture ' + index, () => {
    assert.equal(parse(body(window({ reset_at: absolute }))).windows[0].resetAt, now + 600_000);
  });
}

for (const [index, relative] of [undefined, null, '600', -1, NaN, Infinity, Number.MAX_VALUE].entries()) {
  test('invalid relative with no valid absolute stays unknown, fixture ' + index, () => {
    assert.equal(parse(body(window({ reset_after_seconds: relative }))).windows[0].resetAt, null);
  });
}

test('invalid now cannot invent a relative reset but does not lose valid absolute', () => {
  for (const invalid of [NaN, Infinity, -1, '1800000000000', null, Number.MAX_VALUE]) {
    assert.equal(parseUsage(body(), { now: invalid }).windows[0].resetAt, null);
    assert.equal(parseUsage(body(window({ reset_at: 1_800_100_000 })), { now: invalid }).windows[0].resetAt, 1_800_100_000_000);
  }
  assert.equal(parseUsage(body(window({ reset_after_seconds: 2 })), { now: 0 }).windows[0].resetAt, 2000);
});

test('date range overflow is never exposed as an invalid date or infinity', () => {
  assert.equal(parseUsage(body(window()), { now: 8_640_000_000_000_000 }).windows[0].resetAt, null);
  assert.equal(parse(body(window({ reset_at: 8_640_000_000_000 }))).windows[0].resetAt, 8_640_000_000_000_000);
});

test('credits are whitelisted strict finite public scalars; credits-only quota stays unknown', () => {
  assert.deepEqual(parse({ credits: { has_credits: true, unlimited: false, balance: 12.5, token: 'secret' } }), {
    state: 'unknown', windows: [], credits: { hasCredits: true, unlimited: false, balance: 12.5 },
  });
  assert.deepEqual(parse({ credits: { has_credits: false, unlimited: true, balance: 0 } }).credits,
    { hasCredits: false, unlimited: true, balance: 0 });
  for (const balance of ['12', -1, NaN, Infinity, null, undefined]) {
    assert.deepEqual(parse({ credits: { has_credits: 'true', unlimited: 1, balance } }), unknown);
  }
});

test('plan type uses exact allowlist and never echoes arbitrary strings or metadata', () => {
  for (const plan of ['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']) {
    assert.equal(parse({ plan_type: plan }).planType, plan);
  }
  for (const plan of ['PLUS', 'token-secret', '', '__proto__', {}, null]) {
    assert.equal(Object.hasOwn(parse({ plan_type: plan }), 'planType'), false);
  }
});

test('raw secrets, account IDs, untrusted extra windows and input objects never cross public projection', () => {
  const input = body(window({ access: 'secret-access', ciphertext: 'secret-ciphertext' }));
  input.account_id = 'secret-account';
  input.token = 'secret-token';
  input.accounts = [body(window({ used_percent: 99 }))];
  input.rate_limit.additional_window = window({ used_percent: 99 });
  input.rate_limit.primary_window.raw = { secret: 'secret-deep' };
  const before = JSON.stringify(input);
  const output = parse(input);
  assert.equal(JSON.stringify(input), before);
  assert.doesNotMatch(JSON.stringify(output), /secret|account|access|ciphertext|token|raw/);
  assert.deepEqual(Object.keys(output), ['state', 'windows']);
  assert.equal(output.windows.length, 1);
  assert.equal(output.windows[0].usedPercent, 45);
  assert.notEqual(output.windows[0], input.rate_limit.primary_window);
});

test('inherited fields and accessors are not trusted and accessors are never executed', () => {
  const inherited = Object.create({ rate_limit: { primary_window: window() } });
  assert.deepEqual(parse(inherited), unknown);
  let accesses = 0;
  const input = { get rate_limit() { accesses++; throw new Error('secret-token'); } };
  assert.deepEqual(parse(input), unknown);
  const maliciousWindow = { get used_percent() { accesses++; throw new Error('secret-token'); } };
  assert.deepEqual(parse(body(maliciousWindow)), unknown);
  assert.equal(accesses, 0);
});

test('null-prototype JSON objects are parsed without inherited data', () => {
  const input = Object.assign(Object.create(null), body());
  assert.equal(parse(input).state, 'available');
});
