import z from '@deepseek-ai/schemastery';
import { installHost } from './host-runtime.js';

export const Config = z.object({
  approvalEnabled: z.boolean().default(true).volatile(),
  completionEnabled: z.boolean().default(true).volatile(),
  volume: z.number().min(0).max(100).default(50).volatile(),
  approvalCount: z.number().min(1).max(20).step(1).default(5).volatile(),
  intervalSeconds: z.number().min(1).max(300).step(1).default(10).volatile(),
});
export const inject = ['connection', 'webServer', 'agents', 'settings', 'tools'];
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  return installHost(ctx, config);
}
