import { installCompletionChannel } from './completion-channel.js?rev=1.7.0';
import { installCustomAudio, validateSoundReference } from './custom-audio.js?rev=1.4.0';
import { classifyWorkOutcome } from './work-outcome.js';

export const DEFAULTS = Object.freeze({ approvalEnabled: true, completionEnabled: true, volume: 50, approvalCount: 5, intervalSeconds: 10, repeatPauseMinutes: 5, repeatCount: 2, completionCount: 4, completionIntervalSeconds: 0.5, requestSound: '', questionSound: '', completionSound: '' });
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Expected a settings object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
    if (key === 'requestSound' || key === 'questionSound' || key === 'completionSound') { result[key] = validateSoundReference(value); continue; }
    if (typeof DEFAULTS[key] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    } else {
      const [min, max] = { volume: [0, 100], approvalCount: [1, 20], intervalSeconds: [1, 300], repeatPauseMinutes: [1, 1440], repeatCount: [0, 20], completionCount: [1, 20], completionIntervalSeconds: [0.1, 10] }[key];
      if (!Number.isFinite(value) || value < min || value > max || (!['volume', 'completionIntervalSeconds'].includes(key) && !Number.isInteger(value))) throw new Error(`Invalid ${key}`);
    }
    result[key] = value;
  }
  return result;
}

// Production entries inject readTodos from an awaited session projection. The
// empty fallback exists for older isolated fixtures, not as a runtime data source.
export function installHost(ctx, config, { settleMs = 250, later = setTimeout, cancel = clearTimeout, channelOptions, readTodos = () => [] } = {}) {
  const candidates = new Map();
  const checks = new Map();
  const timers = new Map();
  const terminalReasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted']);
  const channel = installCompletionChannel(ctx, channelOptions);
  const customAudio = installCustomAudio(ctx);
  let disposed = false;
  const values = () => Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, config[key]?.get?.() ?? fallback]));
  const namespace = () => ctx.settings.describe().find((row) => row.ns === 'sound-notifications');
  async function settingsOperation(action, patch, expectedRevision) {
    if (action === 'update') await ctx.settings.update('sound-notifications', validatePatch(patch), expectedRevision);
    const row = namespace();
    return { settings: values(), revision: row?.revision ?? 0 };
  }
  // The built-in settings UI and this tool share Settings' schema-validated,
  // revisioned write path. No profile file is read or rewritten by the plugin.
  ctx.tools.register({
    name: 'sound_notifications_settings',
    description: 'Read or change bell notifications for approvals, answer selectors and task completion. Configure volume, reminder series and a separate completion sequence. Changes persist in this DSH profile.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'update', 'status'], description: 'status reports live completion delivery health without changing settings.' },
      settings: { type: 'object', properties: {
        approvalEnabled: { type: 'boolean' }, completionEnabled: { type: 'boolean' },
        volume: { type: 'number', minimum: 0, maximum: 100 },
        approvalCount: { type: 'integer', minimum: 1, maximum: 20 },
        intervalSeconds: { type: 'integer', minimum: 1, maximum: 300, description: 'Seconds between signals within one series.' },
        repeatPauseMinutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Minutes from the last signal of one series to the first of the next.' },
        repeatCount: { type: 'integer', minimum: 0, maximum: 20, description: 'Additional series after the first; 0 disables long-cycle reminders.' },
        completionCount: { type: 'integer', minimum: 1, maximum: 20, description: 'Signals per task-completion sequence; default 4.' },
        completionIntervalSeconds: { type: 'number', minimum: 0.1, maximum: 10, description: 'Seconds between starts of completion signals; default 0.5.' },
        requestSound: { type: 'string', description: 'Approval/access-request audio reference from sound_notifications_audio, or empty string for the built-in bell.' },
        questionSound: { type: 'string', description: 'Question/plan-review audio reference from sound_notifications_audio, or empty string for the built-in bell.' },
        completionSound: { type: 'string', description: 'Stored audio reference from sound_notifications_audio, or empty string for the built-in completion bell.' },
      }, additionalProperties: false, description: 'Fields to change; required with update.' },
      expectedRevision: { type: 'integer', minimum: 0, description: 'Optional revision from get, to reject concurrent changes.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { settings: { type: 'object' }, revision: { type: 'integer' } }, required: ['settings', 'revision'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args) {
      if (!['get', 'update', 'status'].includes(args.action)) throw new Error('Unknown action');
      const result = await settingsOperation(args.action, args.settings, args.expectedRevision);
      return args.action === 'status' ? { ...result, pluginVersion: '1.7.0', delivery: channel.status(), pendingStops: [...candidates.keys()] } : result;
    },
  });
  ctx.tools.register({
    name: 'sound_notifications_audio',
    description: 'Import separate approval, question or end-of-work audio, inspect selections, or restore the built-in sound. Imports save a durable DSH copy; other notification settings are preserved.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set_file', 'reset'] },
      kind: { type: 'string', enum: ['request', 'question', 'completion'], description: 'Required for set_file and reset: request = approval/access; question = user question/plan review.' },
      file_path: { type: 'string', description: 'Host audio file path for set_file; up to 10 MiB. Browser decoder support and 30-second duration limit apply during playback.' },
      expectedRevision: { type: 'integer', minimum: 0 },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { request: { type: 'object' }, question: { type: 'object' }, completion: { type: 'object' }, revision: { type: 'integer' } }, required: ['request', 'question', 'completion', 'revision'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (args.action !== 'get') {
        if (!['request', 'question', 'completion'].includes(args.kind)) throw new Error('Choose request, question or completion');
        let reference;
        if (args.action === 'set_file') reference = (await customAudio.importFile(args.file_path, exec?.signal)).reference;
        else if (args.action === 'reset') reference = '';
        else throw new Error('Unknown audio action');
        await ctx.settings.update('sound-notifications', { [{ request: 'requestSound', question: 'questionSound', completion: 'completionSound' }[args.kind]]: reference }, args.expectedRevision);
      }
      const settings = values();
      return { question: settings.questionSound ? { builtin: false, ...JSON.parse(settings.questionSound) } : { builtin: true }, request: settings.requestSound ? { builtin: false, ...JSON.parse(settings.requestSound) } : { builtin: true }, completion: settings.completionSound ? { builtin: false, ...JSON.parse(settings.completionSound) } : { builtin: true }, revision: namespace()?.revision ?? 0 };
    },
  });
  function root(agent) {
    // AgentRegistry now exposes get/list, not roots. The durable origin is
    // the subagent boundary; parentSession also exists on independent forks.
    return ctx.agents.get(agent.id) === agent && agent.session.header.origin !== 'subagent';
  }
  function continuingGoal(agent) {
    const goal = ctx.get('goals')?.get(agent);
    return goal?.phase === 'active' && goal.activation === 'armed';
  }
  function clearTimer(id) {
    if (!timers.has(id)) return;
    cancel(timers.get(id)); timers.delete(id);
  }
  function schedule(agent) {
    clearTimer(agent.id);
    if (disposed || !candidates.has(agent.id)) return;
    timers.set(agent.id, later(() => { timers.delete(agent.id); void check(agent); }, settleMs));
  }
  async function check(agent) {
    const candidate = candidates.get(agent.id);
    if (!candidate || checks.has(agent.id) || disposed || agent.status !== 'idle') return;
    checks.set(agent.id, candidate);
    try {
      await agent.whenIdle();
      // Errors and explicit stop are terminal even if a descendant is still
      // resident. For a normal end, wait for progressing children as before.
      if (candidate.reason === 'completed') {
        const subagents = ctx.get('subagents');
        // DSH rc.3 joins progressing work across the whole subagent tree.
        // Retain the former method only for profiles on older DSH versions.
        if (typeof subagents?.waitForTreeWork === 'function') await subagents.waitForTreeWork(agent);
        else if (typeof subagents?.waitForChildren === 'function') await subagents.waitForChildren(agent);
      }
      if (disposed || candidates.get(agent.id) !== candidate || agent.status !== 'idle' || !root(agent)) return;
      // An armed active Goal may still be scheduling its next automatic round.
      // Keep the candidate until a real stop/disarm/block edge, not phase=complete.
      if (candidate.reason === 'completed' && continuingGoal(agent)) return;
      let todos;
      try { todos = readTodos(agent); }
      catch (error) { ctx.logger.warn('sound-notifications: todo projection unavailable: %s', error.message); }
      const outcome = classifyWorkOutcome({ reason: candidate.reason, goal: ctx.get('goals')?.get(agent), todos });
      candidates.delete(agent.id);
      // Visual attention is independent of whether the corresponding sound
      // family is enabled. The browser gates playback, not logical delivery.
      channel.publish({ type: 'completed', id: `${channel.generation}:${agent.id}:${candidate.seq}`, sessionId: agent.id, reason: candidate.reason, ...outcome });
    } catch (error) {
      if (!disposed) ctx.logger.warn('sound-notifications: completion observation failed: %s', error.message);
    } finally {
      checks.delete(agent.id);
      if (!disposed && candidates.has(agent.id) && candidates.get(agent.id) !== candidate) schedule(agent);
    }
  }
  // Observe only new committed ends from this exact live Agent. Initial idle
  // baselines and opening old history cannot manufacture a completion event.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return;
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session || !root(agent)) return;
    // The committed feed is live, but reject an explicitly replayed historical
    // envelope too. Fixtures without lifecycle sequence metadata retain support.
    if (Number.isInteger(event.seq) && Number.isInteger(session.firstLiveSeq) && event.seq < session.firstLiveSeq) return;
    clearTimer(session.id); candidates.delete(session.id);
    if (event.type === 'turn/start') { channel.publish({ type: 'clear-attention', sessionId: session.id }); return; }
    if (!terminalReasons.has(event.data.reason.kind)) return;
    if (event.data.reason.kind === 'aborted' && event.data.reason.reason?.kind === 'disposed') return;
    candidates.set(session.id, { seq: event.seq, reason: event.data.reason.kind });
    schedule(agent);
  });
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') schedule(agent); });
  ctx.on('goal/changed', ({ agent }) => { if (agent.status === 'idle') schedule(agent); });
  ctx.on('goal/activation-changed', ({ sessionId }) => { const agent = ctx.agents.get(sessionId); if (agent?.status === 'idle') schedule(agent); });
  ctx.on('agent/disposed', ({ agent }) => { clearTimer(agent.id); candidates.delete(agent.id); });
  ctx.effect(() => () => {
    disposed = true;
    candidates.clear();
    for (const timer of timers.values()) cancel(timer);
    timers.clear();
  });
}
