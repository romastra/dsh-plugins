export const POLICY_RECORD = 'plugin:codex-native/speed';
export const SPEED_TIERS = Object.freeze(['standard', 'fast', 'ultrafast']);
export const REPORTED_SERVICE_TIERS = Object.freeze(['default', 'priority', 'ultrafast', 'flex', 'auto', 'scale']);
export const defaultPolicy = () => ({ version: 1, tier: 'standard', model: null });

export function requestedServiceTier(tier) {
  return tier === 'fast' ? 'priority' : tier === 'ultrafast' ? 'ultrafast' : null;
}

function readPolicy(value) {
  if (!value || value.version !== 1 || !SPEED_TIERS.includes(value.tier) ||
      !(typeof value.model === 'string' || (value.model === null && value.tier === 'standard')) ||
      (value.tier === 'ultrafast' && !value.model)) throw new Error('INVALID_SPEED_POLICY');
  return { version: 1, tier: value.tier, model: value.model };
}

// The previous release ignores extra record fields and only understands Standard
// and Fast. It will read an Ultrafast selection as Standard after a code rollback.
// One ignorable record suffices, so there is no torn pair or log migration.
export function encodePolicyRecord(value) {
  const policy = readPolicy(value);
  return policy.tier === 'ultrafast' ? { ...policy, tier: 'standard', extendedTier: 'ultrafast' } : policy;
}

export function reducePolicy(state, event) {
  if (event.type === POLICY_RECORD) {
    const policy = readPolicy(event.data);
    if (policy.tier === 'ultrafast') throw new Error('INVALID_SPEED_RECORD');
    if (Object.hasOwn(event.data, 'extendedTier') && event.data.extendedTier === 'ultrafast') {
      if (policy.tier !== 'standard' || !policy.model) throw new Error('INVALID_SPEED_RECORD');
      return { ...policy, tier: 'ultrafast' };
    }
    return policy;
  }
  // Children start Standard, including when the seed carries an Ultrafast record.
  if (event.type === 'session/end-seed' && event.data?.inherited === true) return defaultPolicy();
  return state;
}

export function policyForSession(projection, session) {
  const inherited = session.inheritedEventCount ?? 0;
  if (!inherited) return projection.stateOf(session);
  let policy = defaultPolicy();
  for (const event of session.snapshotEvents()) if (event.seq >= inherited) policy = reducePolicy(policy, event);
  return policy;
}

export function speedForPolicy(state, model, available) {
  const policy = readPolicy(state);
  const tier = policy.model === model ? policy.tier : 'standard';
  if (tier !== 'standard' && available !== true) throw new Error('SPEED_CAPABILITY_UNCONFIRMED');
  return Object.freeze({ tier, source: policy.model === model ? 'session' : 'standard-default' });
}

export function assertSpeedSelection(tier, model, available) {
  if (!SPEED_TIERS.includes(tier) || typeof model !== 'string' || !model || model.length > 160) throw new Error('INVALID_SPEED_SELECTION');
  if (tier !== 'standard' && available !== true) throw new Error('SPEED_CAPABILITY_UNCONFIRMED');
  return { version: 1, tier, model };
}

const SPEED_ERRORS = Object.freeze({
  CODEX_FAST_UNSUPPORTED: 'Fast is not available for this model on the connected account. Choose Standard in Speed to continue.',
  CODEX_FAST_CHECK_UNAVAILABLE: 'Fast availability could not be checked. Retry when the Codex catalog is available or choose Standard.',
  CODEX_ULTRAFAST_UNSUPPORTED: 'The Codex account catalog does not advertise Ultrafast for this model. Choose Standard or Fast in Speed to continue.',
  CODEX_ULTRAFAST_CHECK_UNAVAILABLE: 'Ultrafast availability could not be verified. Retry when the Codex catalog is available or choose Standard or Fast in Speed.',
});

function unavailable(tier, advertised) {
  const prefix = tier === 'ultrafast' ? 'CODEX_ULTRAFAST' : 'CODEX_FAST';
  const code = prefix + (advertised === false ? '_UNSUPPORTED' : '_CHECK_UNAVAILABLE');
  return Object.assign(new Error(SPEED_ERRORS[code] ?? code), { code });
}

export function ultrafastAvailability(snapshot) {
  return snapshot?.stale === false && typeof snapshot.available === 'boolean' ? snapshot.available : null;
}

/** Do not translate a previously selected accelerated speed into a slower request. */
export async function requireSpeed(capabilities, scope, model, tier, signal) {
  if (tier === 'standard') return null;
  if (!SPEED_TIERS.includes(tier) || !scope) throw unavailable(tier, null);
  try { await capabilities.ensure(scope, { model, tier, signal }); }
  catch (error) {
    signal?.throwIfAborted();
    if (tier === 'ultrafast') throw unavailable(tier, null);
    throw error;
  }
  signal?.throwIfAborted();
  return assertAdvertisedSpeed(capabilities, scope, model, tier);
}

export function assertAdvertisedSpeed(capabilities, scope, model, tier) {
  const snapshot = capabilities.get(scope, model, tier);
  const available = tier === 'ultrafast' ? ultrafastAvailability(snapshot) : snapshot.available;
  if (available !== true) throw unavailable(tier, available);
  return true;
}
