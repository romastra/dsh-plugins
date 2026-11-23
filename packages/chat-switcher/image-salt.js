import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { getMosaicParameters, getFractalParameters, getFractalQuality } from './src/mosaic.js';
import { HYBRID_VARIANT, PARAMETRIC_VARIANT, LEGACY_VARIANT, validImageVariant } from './src/image-variant.js';
import { identitySeed } from './src/identity.js';

export const IMAGE_REGENERATION_POLICY = 'all-input-controls-fractal-presence/v3';
export const IMAGE_SALT_ATTEMPTS = 4096;
// RFC 9562 UUIDs, including the nil/max forms accepted by the storage schema.
export const imageSaltValid = value => typeof value === 'string' && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(value);

/** Every input control must differ, not merely the salt or the overall hash.
 * Palette entries at matching positions must also change (including canvas[0]).
 * Fixed generator constants and derived SVG coordinates are not input controls.
 */
export function allMosaicParametersDiffer(previous, next) {
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return false;
  const keys = Object.keys(previous);
  if (!keys.length || keys.length !== Object.keys(next).length) return false;
  return keys.every(key => {
    if (!Object.hasOwn(next, key)) return false;
    const before = previous[key], after = next[key];
    if (Array.isArray(before)) {
      if (!Array.isArray(after) || !before.length || !after.length) return false;
      return before.slice(0, after.length).every((value, index) => typeof value === 'string' && typeof after[index] === 'string' && value !== after[index]);
    }
    if (before === null || after === null || typeof before !== typeof after || !['number', 'string', 'boolean'].includes(typeof before)) return false;
    if (typeof before === 'number' && (!Number.isFinite(before) || !Number.isFinite(after))) return false;
    return before !== after;
  });
}

/** Host-only rejection sampling; rejected candidates never render or persist. */
export async function selectImageSalt({ sessionId, previousSalt = null, previousVariant = LEGACY_VARIANT, nextVariant = LEGACY_VARIANT, random, shouldAbort = () => false,
  maxAttempts = IMAGE_SALT_ATTEMPTS, batchSize = 32, yieldControl = yieldEventLoop, parameters = getMosaicParameters,
  fractalParameters = getFractalParameters, quality = getFractalQuality }) {
  if (typeof sessionId !== 'string' || !sessionId || !validImageVariant(previousVariant) || !validImageVariant(nextVariant) || (previousSalt !== null && !imageSaltValid(previousSalt))) throw new Error('Invalid image reference');
  if (typeof random !== 'function' || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 65536
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 65536) throw new Error('Invalid image search budget');
  const cancelled = () => { if (shouldAbort()) throw new Error('Chat image change cancelled or unloaded'); };
  cancelled();
  const previousSeed = identitySeed(sessionId, previousSalt, previousVariant);
  const previous = parameters(previousSeed);
  const isFractalVariant = variant => variant === HYBRID_VARIANT || variant === PARAMETRIC_VARIANT;
  const previousFractal = isFractalVariant(previousVariant) ? fractalParameters(previousSeed) : null;
  const previousPresence = !!previousFractal && previousFractal.enabled !== false;
  const controlsOnly = descriptor => { const { enabled, ...controls } = descriptor; return controls; };
  const seen = new Set(previousSalt === null ? [] : [previousSalt]);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    cancelled();
    const salt = random();
    if (!imageSaltValid(salt)) throw new Error('Could not generate a new image salt');
    if (!seen.has(salt)) {
      seen.add(salt);
      const candidateSeed = identitySeed(sessionId, salt, nextVariant);
      if (allMosaicParametersDiffer(previous, parameters(candidateSeed))) {
        const fractal = isFractalVariant(nextVariant) ? fractalParameters(candidateSeed) : null;
        const presence = !!fractal && fractal.enabled !== false;
        // Presence is a real boolean input: the all-parameters rule makes it flip.
        const changedPresence = nextVariant !== PARAMETRIC_VARIANT || (typeof fractal?.enabled === 'boolean' && presence !== previousPresence);
        // Compare fractal controls only when they affect BOTH images. Otherwise
        // toggling two booleans (presence/family) would lock every visible ON to one family.
        const changedFractal = !isFractalVariant(nextVariant) || (fractal && (!previousPresence || !presence || allMosaicParametersDiffer(controlsOnly(previousFractal), controlsOnly(fractal))));
        // Plain mosaics never calculate a fractal quality probe or require its contrast.
        if (changedPresence && changedFractal && (!presence || quality(candidateSeed)?.accepted === true)) { cancelled(); return salt; }
      }
    }
    // Keep unrelated Host sessions responsive even with a failing entropy source.
    if ((attempt + 1) % batchSize === 0) await yieldControl();
  }
  cancelled();
  throw new Error('Could not find an image with every parameter changed; previous image kept');
}
