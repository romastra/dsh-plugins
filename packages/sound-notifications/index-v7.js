import z from '@deepseek-ai/schemastery';
import { installHost } from './host-runtime.js?rev=1.5.0';

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
export const inject = ['connection', 'agents', 'settings', 'tools', 'attachments'];
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  return installHost(ctx, config);
}
