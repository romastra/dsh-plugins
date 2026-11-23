/** Both callers use the existing Host sessionController.selectModel operation. */
export const inject = ['tools', 'sessionController'];

export function apply(ctx) {
  const controller = ctx.sessionController;
  ctx.effect(() => ctx.tools.register({
    name: 'reasoning_depth',
    description: 'Read available reasoning depths or set the current session’s depth without changing its model. Returns the selected effort and advertised choices. Like the built-in model menu, set also saves this complete model/depth as the profile default for sessions without an explicit choice; a running request keeps its captured depth.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'] },
        effort: { type: 'string', description: 'For set: an advertised effort id returned by get. Omit to use the adapter default.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('A current session is required.');
      if (args?.action !== 'get' && args?.action !== 'set') throw new Error('Unknown action.');
      if (args.effort !== undefined && (typeof args.effort !== 'string' || args.effort.length === 0)) throw new Error('Invalid effort id.');
      if (args.action === 'get' && args.effort !== undefined) throw new Error('effort is only accepted with action=set.');
      const sessionId = exec.agent.id;
      const [catalog, projection] = await Promise.all([
        controller.modelCatalog(),
        controller.projections({ sessionId }, exec.signal),
      ]);
      if (!projection || projection.kind !== 'sequenced') throw new Error('The current session projection is not ready.');
      const current = projection.values.modelSelection?.next ?? catalog.default;
      const model = catalog.groups.find(group => group.id === current.provider)?.models.find(item => item.id === current.model);
      const reasoning = model?.reasoning;
      if (!model) throw new Error('The selected model is unavailable in the current catalog.');
      if (args.action === 'set') {
        if (!reasoning || reasoning.efforts.length === 0) throw new Error('This model does not advertise configurable reasoning depth.');
        if (args.effort !== undefined && !reasoning.efforts.some(item => item.id === args.effort)) throw new Error('Unsupported effort. Use an id returned by action=get.');
        const result = await controller.selectModel({
          sessionId, provider: current.provider, model: current.model,
          ...(args.effort === undefined ? {} : { reasoningEffort: args.effort }),
        });
        return { selected: result.selected, defaultEffort: reasoning.defaultEffort ?? null, choices: reasoning.efforts };
      }
      return { selected: current, defaultEffort: reasoning?.defaultEffort ?? null, choices: reasoning?.efforts ?? [] };
    },
  }), 'reasoning-depth: agent action');
}
