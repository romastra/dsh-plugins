/** Official Codex account catalog -> native pi-ai descriptors. Pure; no auth/I/O. */
const PROVIDER = 'openai-codex';
const API = 'openai-codex-responses';
const BASE = 'https://chatgpt.com/backend-api';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const safeText = (value, fallback) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : fallback;
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 10000000;
const invalid = () => Object.assign(new Error('CODEX_CATALOG_INVALID'), { code: 'CODEX_CATALOG_INVALID' });

export function parseModelCatalog(body, baseline = []) {
  if (!body || !Array.isArray(body.models) || !body.models.length || body.models.length > 4096) throw invalid();
  const known = new Map(baseline.map(model => [model.id, model]));
  const models = [], capabilities = new Map(), seen = new Set();
  for (const row of body.models) {
    if (!row || typeof row.slug !== 'string' || !ID.test(row.slug)) continue;
    if (seen.has(row.slug)) throw invalid();
    seen.add(row.slug);
    // Discovery is an advertisement, not permission to construct arbitrary routes.
    if (row.visibility !== undefined && row.visibility !== 'list') continue;
    // supported_in_api describes API-key access, not this ChatGPT OAuth route.
    if (row.type && row.type !== 'chat') continue;
    const exact = known.get(row.slug);
    const tiers = Array.isArray(row.service_tiers) ? row.service_tiers : [];
    const extra = Array.isArray(row.additional_speed_tiers) ? row.additional_speed_tiers : [];
    const contextWindow = positive(row.context_window) ? row.context_window : positive(row.max_context_window) ? row.max_context_window : exact?.contextWindow;
    // Unknown models without actual context metadata are not made selectable.
    if (!positive(contextWindow)) continue;
    const input = Array.isArray(row.input_modalities) ? [...new Set(row.input_modalities.filter(x => x === 'text' || x === 'image'))] : exact?.input ?? ['text'];
    if (!input.includes('text')) continue;
    const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(x => typeof x === 'string' ? x : x?.effort).filter(x => EFFORTS.has(x)) : undefined;
    // This pi-ai protocol cannot request unknown/custom efforts. Do not falsely
    // advertise an unknown-only reasoning model as a non-reasoning model.
    if (Array.isArray(row.supported_reasoning_levels) && row.supported_reasoning_levels.length && !levels.length) continue;
    const thinkingLevelMap = levels ? Object.fromEntries(levels.map(x => [x === 'none' ? 'off' : x, x])) : exact?.thinkingLevelMap;
    // For a new model, omit unsupported reasoning levels explicitly. Native pi-ai
    // otherwise assumes a generic set and can silently clamp the requested effort.
    const explicitMap = levels ? Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(key => [key, thinkingLevelMap[key] ?? null])) : thinkingLevelMap;
    // New service tiers require an explicit server-advertised ID, as in Codex CLI.
    // The legacy additional_speed_tiers array is retained only for Fast compatibility.
    capabilities.set(row.slug, {
      fast: tiers.some(t => t?.id === 'priority') || extra.includes('fast'),
      ultrafast: tiers.some(t => t?.id === 'ultrafast'),
    });
    const maxTokens = Math.min(contextWindow, positive(row.max_output_tokens) ? row.max_output_tokens : exact?.maxTokens ?? 16384);
    models.push(Object.freeze({
      ...(exact ?? {}), id: row.slug, name: safeText(row.display_name, row.slug),
      provider: PROVIDER, api: API, type: 'chat', baseUrl: BASE,
      input: Object.freeze([...input]), contextWindow, maxTokens,
      reasoning: levels ? levels.some(level => level !== 'none') : exact?.reasoning ?? false,
      ...(explicitMap ? { thinkingLevelMap: Object.freeze({ ...explicitMap }) } : {}),
      // Codex OAuth does not report prices. Native accounting requires the cost
      // shape; zero here means unpriced, NOT a claim that API inference is free.
      cost: exact?.cost ?? Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    }));
  }
  if (!models.length) throw invalid(); // Do not wipe a good catalog on malformed/empty replies.
  return { models: Object.freeze(models), capabilities };
}

/** Read a bounded JSON reply before retaining anything from the provider. */
export async function readMetadataBody(response, { maxBytes = 2097152, signal } = {}) {
  const reader = response.body?.getReader?.();
  if (!reader) throw invalid();
  let total = 0; const chunks = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw invalid();
      chunks.push(value);
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(total); let offset = 0;
    for (const value of chunks) { bytes.set(value, offset); offset += value.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Immutable provider snapshots: an already prepared call must keep its model. */
export function createModelCatalog({ baseline, publish = () => {} }) {
  const fallback = Object.freeze([...baseline]);
  let scope, current = fallback, fingerprint;
  function replace(models) {
    const next = JSON.stringify(models);
    if (next === fingerprint) return false;
    fingerprint = next; current = models; publish(current); return true;
  }
  return {
    baseline: fallback,
    getModels: () => current,
    accept(accountScope, body) {
      if (typeof accountScope !== 'string' || !accountScope) throw invalid();
      const parsed = parseModelCatalog(body, fallback);
      scope = accountScope;
      replace(parsed.models);
      return parsed.capabilities;
    },
    reset() { scope = undefined; replace(fallback); },
    scope: () => scope,
  };
}

/** Polls only while configured; capability cache owns TTL/singleflight/backoff. */
export function startCatalogAutoRefresh({ refresh, intervalMs = 60000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let disposed = false, flight;
  const tick = () => {
    if (disposed || flight) return flight;
    flight = Promise.resolve().then(() => !disposed && refresh()).catch(() => {}).finally(() => { flight = undefined; });
    return flight;
  };
  const timer = setIntervalFn(tick, intervalMs); timer.unref?.();
  void tick();
  return { tick, dispose() { disposed = true; clearIntervalFn(timer); } };
}
