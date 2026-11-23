/** Request-local, allowlisted metadata; requested speed is not server confirmation. */
import { REPORTED_SERVICE_TIERS, SPEED_TIERS, requestedServiceTier } from './policy.js';
const TIERS = new Set(REPORTED_SERVICE_TIERS);
const SUCCESS_EVENTS = new Set(['response.done', 'response.completed']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Called only with this request's native evidence rows, before diagnostic redaction. */
export function noteReportedTier(context, row) {
  if (!object(context) || !object(row)) return;
  if (row.phase === 'request-policy') {
    // A new native attempt must never inherit a previous attempt's confirmation.
    context.reportedTier = null;
    const tier = row.selectedTier;
    const requested = requestedServiceTier(tier);
    context.requestedSpeed = SPEED_TIERS.includes(tier) && row.requestedTier === requested &&
      row.serviceTier === requested && row.serviceTierPresent === (requested !== null) ? tier : null;
    return;
  }
  if (row.phase !== 'response-terminal') return;
  context.reportedTier = SUCCESS_EVENTS.has(row.eventType) &&
    row.rawReportedTierPresent === true && row.rawReportedTierRecognized === true &&
    TIERS.has(row.rawReportedTier) ? row.rawReportedTier : null;
}

/** Add only own metadata; retain native state/blocks identity and never mutate input. */
export function attachReportedTier(wrappedReplay, context) {
  if (!object(wrappedReplay) || !object(wrappedReplay.response)) return wrappedReplay;
  const response = wrappedReplay.response;
  if (response.kind !== 'codex-native' || response.version !== 1) return wrappedReplay;
  const state = response.state;
  const successful = object(state) && state.kind === 'pi-ai' && state.version === 2 &&
    state.provider === 'openai-codex' && state.api === 'openai-codex-responses' &&
    ['stop', 'toolUse'].includes(state.stopReason);
  const tier = object(context) ? context.reportedTier : null;
  const requested = object(context) ? context.requestedSpeed : null;
  const { reportedServiceTier: _stale, requestedSpeed: _priorRequest, ...metadata } = response;
  const report = successful && TIERS.has(tier);
  const request = successful && SPEED_TIERS.includes(requested);
  if (!report && !request && !Object.hasOwn(response, 'reportedServiceTier') && !Object.hasOwn(response, 'requestedSpeed')) {
    return wrappedReplay;
  }
  return { ...wrappedReplay, response: { ...metadata,
    ...(report ? { reportedServiceTier: { source: 'codex-terminal', version: 1, tier } } : {}),
    ...(request ? { requestedSpeed: { source: 'codex-request', version: 1, tier: requested } } : {}),
  } };
}
