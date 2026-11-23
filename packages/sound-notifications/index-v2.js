import z from '@deepseek-ai/schemastery';
import { installHost } from './host-runtime.js?rev=1.1.0';

export const Config = z.object({
  approvalEnabled: z.boolean().default(true).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  volume: z.number().min(0).max(100).default(50).volatile(),
  approvalCount: z.number().min(1).max(20).step(1).default(5).volatile(),
  intervalSeconds: z.number().min(1).max(300).step(1).default(10).volatile(),
  repeatPauseMinutes: z.number().min(1).max(1440).step(1).default(5).volatile(),
  repeatCount: z.number().min(0).max(20).step(1).default(2).volatile(),
});
export const inject = ['connection', 'webServer', 'agents', 'settings', 'tools'];
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  return installHost(ctx, config);
}
