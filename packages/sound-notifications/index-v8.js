import z from '@deepseek-ai/schemastery';
import { z as schema } from 'zod';
import { installHost } from './host-runtime.js?rev=1.6.0';

export const Config = z.object({
  approvalEnabled: z.boolean().default(true).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  volume: z.number().min(0).max(100).default(50).volatile(),
  approvalCount: z.number().min(1).max(20).step(1).default(5).volatile(),
  intervalSeconds: z.number().min(1).max(300).step(1).default(10).volatile(),
  repeatPauseMinutes: z.number().min(1).max(1440).step(1).default(5).volatile(),
  repeatCount: z.number().min(0).max(20).step(1).default(2).volatile(),
  completionCount: z.number().min(1).max(20).step(1).default(4).volatile(),
  completionIntervalSeconds: z.number().min(0.1).max(10).default(0.5).volatile(),
  requestSound: z.string().default('').volatile(),
  questionSound: z.string().default('').volatile(),
  completionSound: z.string().default('').volatile(),
});
export const inject = ['connection', 'agents', 'settings', 'tools', 'attachments', 'sessionProjections'];
export async function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  // Same current-turn semantics as DSH's authoritative todos projection. A
  // private Host-only key remains available even if the todo tool is scoped.
  const todos = await ctx.sessionProjections.register({
    key: 'sound-notifications/todos', stateVersion: 1,
    stateSchema: schema.array(schema.object({ content: schema.string(), status: schema.enum(['pending', 'in_progress', 'completed']) })).nullable(),
    init: () => null,
    apply: (state, event) => event.type === 'todo/write' ? event.data.todos : event.type === 'turn/start' ? null : state,
  });
  return installHost(ctx, config, { readTodos: agent => todos.stateOf(agent.session) });
}
