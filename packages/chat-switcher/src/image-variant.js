// Absent/legacy metadata preserves every existing seed and artwork byte.
export const HYBRID_VARIANT = 'hybrid-fractal/v1';
export const LEGACY_VARIANT = 'legacy';
export const HYBRID_SEED_DOMAIN = 'dsh-chat-image/hybrid-fractal/v1';
export const PARAMETRIC_VARIANT = 'hybrid-fractal/v2';
export const PARAMETRIC_SEED_DOMAIN = 'dsh-chat-image/hybrid-fractal/v2';

export function imageVariantFromSeed(seed) {
  if (typeof seed !== 'string') return LEGACY_VARIANT;
  const variant = seed.startsWith('["' + HYBRID_SEED_DOMAIN + '",') ? HYBRID_VARIANT
    : seed.startsWith('["' + PARAMETRIC_SEED_DOMAIN + '",') ? PARAMETRIC_VARIANT : LEGACY_VARIANT;
  if (variant === LEGACY_VARIANT) return LEGACY_VARIANT;
  const domain = variant === HYBRID_VARIANT ? HYBRID_SEED_DOMAIN : PARAMETRIC_SEED_DOMAIN;
  try {
    const value = JSON.parse(seed);
    return Array.isArray(value) && value.length === 3 && value[0] === domain
      && typeof value[1] === 'string' && value[1].length > 0 && typeof value[2] === 'string'
      ? variant : LEGACY_VARIANT;
  } catch { return LEGACY_VARIANT; }
}

export function validImageVariant(variant) {
  return variant === undefined || variant === LEGACY_VARIANT || variant === HYBRID_VARIANT || variant === PARAMETRIC_VARIANT;
}
