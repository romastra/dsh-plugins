import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  placeholder: z.string().default('msg or task; / for cmd; @ for file or sess').volatile(),
});

export function apply() {}
