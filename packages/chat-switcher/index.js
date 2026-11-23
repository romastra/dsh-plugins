import z from '@deepseek-ai/schemastery';
import { z as value } from 'zod';
import { installIdentityHost } from './host.js';
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  pullEnabled: z.boolean().default(true).volatile(),
  delayMs: z.number().min(0).max(2000).step(1).default(250).volatile(),
});
export const inject = ['settings', 'storageDomain', 'sessions', 'connection', 'tools'];
export async function apply(ctx) {
  ctx.effect(() => ctx.settings.configure({ auto: false }));
  await installIdentityHost(ctx, {
    valueSchema: value.object({ salt: value.string().uuid(), revision: value.number().int().positive(), variant: value.enum(['hybrid-fractal/v1', 'hybrid-fractal/v2']).optional() }),
    globalSchema: value.object({ activatedAt: value.number().int().nonnegative() }),
  });
}
