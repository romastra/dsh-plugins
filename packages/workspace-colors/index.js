import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createColorRoute, createWorkspaceColorService, TOOL_PARAMETERS } from './service.js';

export const inject = ['storageDomain', 'workspaceRegistry', 'connection', 'tools'];
export async function apply(ctx) {
  const domain = await ctx.storageDomain.open({
    name: 'local_workspace_colors', version: 1,
    tables: { colors: { valueSchema: z.object({ color: z.number().int().min(1).max(15) }).strict() } },
  });
  const service = createWorkspaceColorService({ table: domain.table('colors'), registry: ctx.workspaceRegistry, generation: randomUUID() });
  ctx.effect(() => async () => { await service.close(); await domain.close(); }, 'workspace-colors: durable state');
  ctx.provide('workspaceColors', service);
  // Exact Connection routes are authenticated and owner-only on HTTP and Desktop IPC.
  // Do not replace Gateway's shared /api RPC interceptor.
  ctx.effect(() => ctx.connection.fetch.register(createColorRoute(service)), 'workspace-colors: owner RPC');
  ctx.effect(() => ctx.tools.register({
    name: 'workspace_colors', deferLoading: true,
    description: 'List Workspaces and their MSX color accents, or set one Workspace color by ID. Indices 1–15 follow the listed palette; null removes the accent. Saved in this DSH profile and shared by connected pages. Does not modify folders, titles or sessions. Optional expectedColor rejects concurrent changes.',
    parameters: TOOL_PARAMETERS,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { return service.operate(args, { signal: exec.signal }); },
  }), 'workspace-colors: shared operation');
}
