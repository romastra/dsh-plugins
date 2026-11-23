/** Public allowlisted projection of a single selected account's wham usage JSON.
 * No account selection, pooling, I/O, refresh, headers, or credential access.
 */
const SESSION_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PLANS = new Set(['free', 'go', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const record = value => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
// Parsed JSON has only own data properties. Do not trust inherited metadata or
// invoke accessors if an injected caller supplies something other than JSON.
const field = (value, key) => {
  if (!record(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};
const validMilliseconds = value => finite(value) && value >= 0 && value <= MAX_DATE_MS;

function resetAt(window, now) {
  const absolute = field(window, 'reset_at');
  if (finite(absolute) && absolute > 0 && validMilliseconds(absolute * 1000)) {
    return absolute * 1000;
  }
  const relative = field(window, 'reset_after_seconds');
  if (finite(relative) && relative >= 0 && validMilliseconds(now) && validMilliseconds(now + relative * 1000)) {
    return now + relative * 1000;
  }
  return null;
}

function windowKind(seconds) {
  if (seconds === null) return 'unknown';
  if (seconds >= SESSION_SECONDS * 0.95 && seconds <= SESSION_SECONDS * 1.05) return 'session';
  if (seconds >= WEEKLY_SECONDS * 0.95 && seconds <= WEEKLY_SECONDS * 1.05) return 'weekly';
  return 'other';
}

function usageWindow(value, now) {
  const used = field(value, 'used_percent');
  if (!finite(used) || used < 0 || used > 100) return null;
  const seconds = field(value, 'limit_window_seconds');
  const windowSeconds = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
  // Normalize negative zero only when the server actually supplied a zero.
  const usedPercent = used === 0 ? 0 : used;
  return {
    kind: windowKind(windowSeconds),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetAt: resetAt(value, now),
    windowSeconds,
  };
}

function usageCredits(value) {
  const credits = {};
  const hasCredits = field(value, 'has_credits');
  const unlimited = field(value, 'unlimited');
  const balance = field(value, 'balance');
  if (typeof hasCredits === 'boolean') credits.hasCredits = hasCredits;
  if (typeof unlimited === 'boolean') credits.unlimited = unlimited;
  if (finite(balance) && balance >= 0) credits.balance = balance === 0 ? 0 : balance;
  return Object.keys(credits).length > 0 ? credits : undefined;
}

/**
 * now is Unix milliseconds, injected for deterministic relative resets.
 * Missing/invalid percentages never become 0 or 100, even if limit_reached is
 * true. Windows retain backend order; their kind depends on duration, not slot.
 * A weekly-only primary window is therefore weekly. No duration means unknown.
 * credits alone cannot establish percentage availability. The cache owner adds
 * checkedAt/stale; this parser never labels data as freshly fetched.
 */
export function parseUsage(body, { now = Date.now() } = {}) {
  const rateLimit = field(body, 'rate_limit');
  const windows = [];
  for (const name of ['primary_window', 'secondary_window']) {
    const window = usageWindow(field(rateLimit, name), now);
    if (window !== null) windows.push(window);
  }
  const result = { state: windows.length > 0 ? 'available' : 'unknown', windows };
  const credits = usageCredits(field(body, 'credits'));
  if (credits !== undefined) result.credits = credits;
  const plan = field(body, 'plan_type');
  if (typeof plan === 'string' && PLANS.has(plan)) result.planType = plan;
  return result;
}
