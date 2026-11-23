import { normalizeStream } from './normalize.js';
import { diagnoseSession } from './diagnose.js';

export const name = 'codex-overload-recovery';
export const inject = ['llm', 'tools'];

export function apply(ctx) {
  let normalizedFinishes = 0;
  ctx.on('llm/stream', (options, next) => normalizeStream(
    next(), options.signal, () => { normalizedFinishes += 1; },
  ));

  ctx.effect(() => ctx.tools.register({
    name: 'autorecovery_status',
    description: 'Read the Codex overload hotfix version and the selected provider’s native retry policy. Optionally audit a named stored session for errors and tool-result pairing, without resuming or modifying it. Returns structural metadata, not message or reasoning text. Counters are process-local diagnostics. Direct LLM calls and external CLI subagents do not acquire native agent-loop retries.',
    parameters: {
      type: 'object',
      properties: { session_id: { type: 'string', minLength: 1, description: 'Optional exact stored Session id to audit read-only.' } },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const selected = exec.agent?.model.current();
      const persistence = args.session_id ? ctx.get('sessionPersistence') : undefined;
      if (args.session_id && !persistence) throw new Error('Session persistence is unavailable.');
      const diagnosis = args.session_id ? await diagnoseSession(persistence, args.session_id, exec.signal) : null;
      const inspectedProvider = diagnosis?.latestRequest?.provider;
      return {
        ...(diagnosis ? { session: { ...diagnosis, currentProviderRetryPolicy: inspectedProvider ? ctx.llm.providerRetryPolicy(inspectedProvider) : null } } : {}),
        version: '1.0.0',
        active: true,
        classification: 'Known Codex overload: PI_AI_ERROR -> SERVER; all other failures unchanged',
        selected: selected ?? null,
        retryPolicy: selected ? ctx.llm.providerRetryPolicy(selected.provider) : null,
        normalizedFinishes,
        mechanism: 'Native agent-loop same-step retries; provider policy and retry executor must permit SERVER',
        scope: 'Future model requests, not already-closed turns or external CLI subagents',
      };
    },
  }), 'codex-overload-recovery: read-only status');
}
