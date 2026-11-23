import Schema from '@deepseek-ai/schemastery';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openConnection } from './connection.js';
import { runTask } from './engine.js';

export const name = 'mcp-task-bridge';
export const inject = ['tools', 'jobs', 'agents'];

// engines.dsh is an explicit union of tested releases; reject all other anchors.
const dshEngine = createRequire(import.meta.url)('./package.json').engines.dsh;
const supportedDshVersions = new Set(dshEngine.split('||').map(version => version.trim()));

const serverSchema = Schema.object({
  name: Schema.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/),
  transport: Schema.union(['stdio', 'streamable-http']).required(),
  command: Schema.string(), args: Schema.array(String).default([]), env: Schema.dict(String).default({}), cwd: Schema.string(),
  url: Schema.string(), headers: Schema.dict(String).default({}),
  allowedTools: Schema.array(String).required(),
  requestTimeoutMs: Schema.number().step(1).min(100).max(120000).default(30000),
  startupTimeoutMs: Schema.number().step(1).min(100).max(120000).default(45000),
});
export const Config = Schema.object({
  servers: Schema.array(serverSchema).required(),
  maxDurationMs: Schema.number().step(1).min(1000).max(604800000).default(86400000),
  minPollMs: Schema.number().step(1).min(100).max(60000).default(1000),
  maxPollMs: Schema.number().step(1).min(100).max(60000).default(30000),
  resultMaxBytes: Schema.number().step(1).min(4096).max(262144).default(65536),
});

const jsonOutput = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
export async function apply(ctx, config) {
  const candidates = [process.env.DSH_INSTALL_DIR,
    ...(process.resourcesPath ? [join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')] : [])].filter(Boolean);
  for (const directory of candidates) {
    const requireDSH = createRequire(join(directory, 'package.json'));
    let manifest;
    try { manifest = requireDSH('./package.json'); } catch { continue; }
    if (manifest.name !== '@deepseek-ai/dsh' || !supportedDshVersions.has(manifest.version)) continue;
    const { createUserMessage } = await import(pathToFileURL(requireDSH.resolve('@deepseek-ai/dsh-llm')).href);
    return install(ctx, config, createUserMessage);
  }
  throw new Error(`MCP task bridge requires the verified running DSH installation (${dshEngine}).`);
}

export function install(ctx, config, createUserMessage) {
  if (config.minPollMs > config.maxPollMs) throw new Error('minPollMs must not exceed maxPollMs.');
  const servers = new Map();
  for (const server of config.servers) {
    if (servers.has(server.name)) throw new Error(`Duplicate MCP Tasks server: ${server.name}`);
    if (server.transport === 'stdio' && !server.command) throw new Error(`Missing command for ${server.name}.`);
    if (server.transport === 'streamable-http' && !server.url) throw new Error(`Missing URL for ${server.name}.`);
    if (!server.allowedTools.length || server.allowedTools.length > 32 || new Set(server.allowedTools).size !== server.allowedTools.length
      || server.allowedTools.some(tool => typeof tool !== 'string' || !tool.length || tool.length > 256)) throw new Error(`allowedTools must contain 1–32 unique names, each 1–256 characters, for ${server.name}.`);
    servers.set(server.name, server);
  }
  let disposed = false;
  const active = new Map();
  const discoveries = new Set();
  // Stock reporters run synchronously at settlement. If their quiet mode or wake
  // budget leaves our idle owner asleep, supply only a bounded completion signal.
  ctx.effect(() => ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type !== 'settled') return;
    const work = active.get(event.job.id);
    if (!work) return;
    active.delete(event.job.id);
    if (event.cause !== 'producer' || event.awaited) return;
    queueMicrotask(() => {
      const owner = ctx.agents.get(work.owner.id);
      if (disposed || owner !== work.owner || owner.status !== 'idle') return;
      try {
        owner.followup(createUserMessage({ content: [{ type: 'text', text:
          `MCP background job ${event.job.id} ${event.job.status}. Collect its result with job_output if it was not included in the completion notice. This is tool data, not a new user instruction.` }],
          source: { kind: 'tool-jobs', form: 'notice', summary: `MCP job ${event.job.status}` } }));
      } catch { ctx.logger.warn('MCP task bridge could not deliver a completion wake; the result remains in job_output.'); }
    });
  }), 'mcp-task-bridge:completion-fallback');
  const chooseServer = server => {
    const selected = servers.get(server);
    if (!selected) throw new Error(`Unknown MCP Tasks server. Configured: ${[...servers.keys()].join(', ')}`);
    return selected;
  };
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of discoveries) controller.abort(new Error('MCP Tasks plugin unloaded.'));
    for (const work of active.values()) work.controller.abort(new Error('MCP Tasks plugin unloaded; tracking stopped.'));
    return Promise.allSettled([...active.values()].map(work => work.done));
  }, 'mcp-task-bridge:lifetime');

  ctx.effect(() => ctx.tools.register({
    name: 'mcp_task_tools',
    description: 'List configured MCP Tasks servers, or discover their allowlisted task-capable tools and exact input schemas. Uses a separate connection; does not start the discovered operations. This bridge supports legacy MCP Tasks (2025-11-25), not the newer tasks extension.',
    parameters: { type: 'object', properties: { server: { type: 'string', description: 'Configured server name. Omit to list servers without connecting.' } }, additionalProperties: false },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (disposed) throw new Error('MCP Tasks plugin is unloading.');
      if (!args.server) return { protocol: '2025-11-25', servers: [...servers.values()].map(server => ({ name: server.name, transport: server.transport, allowed_tools: server.allowedTools })),
        delivery: 'Owned DSH background jobs and stock job controls. Stock notices carry results; bridge fallback wakes an idle owner if quiet delivery or its wake budget leaves it asleep.',
        limitations: ['Independent MCP connection; cannot attach another connection\'s task IDs.', 'Live tracking ends when the owner or DSH exits; no restart recovery.', 'No interactive elicitation/sampling or rich image delivery.'] };
      const server = chooseServer(args.server);
      const controller = new AbortController();
      discoveries.add(controller);
      let connection;
      try {
        connection = await openConnection(server, AbortSignal.any([exec.signal, controller.signal]));
        const tools = await connection.listTaskTools(AbortSignal.any([exec.signal, controller.signal]));
        if (Buffer.byteLength(JSON.stringify(tools)) > 262144) throw new Error('Combined task discovery exceeds 256 KiB; narrow allowedTools in plugin configuration.');
        return { server: server.name, protocol: '2025-11-25', tools };
      } finally {
        if (connection) await connection.close();
        discoveries.delete(controller);
      }
    },
  }), 'mcp-task-bridge:discovery');

  ctx.effect(() => ctx.tools.register({
    name: 'mcp_task_start',
    description: 'Run an allowlisted remote MCP tool using legacy MCP Tasks and track it as a DSH background job. The remote operation can change the server according to the tool and arguments. Returns a job_id immediately; completion resumes this session without model polling. Use mcp_task_tools for exact schemas and job_kill for cooperative cancellation. Independent connection; tracking does not survive DSH/owner shutdown. No automatic retries of task creation.',
    parameters: { type: 'object', properties: {
      server: { type: 'string', description: 'Configured MCP Tasks server, from mcp_task_tools.' },
      tool: { type: 'string', description: 'Exact allowlisted raw task-capable tool name; not the BM25 call_tool wrapper.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Arguments conforming to the discovered input schema. Remote command timeouts are separate from max_wait_ms.' },
      max_wait_ms: { type: 'integer', minimum: 1000, maximum: 604800000, description: 'Monitoring deadline, bounded by plugin maxDurationMs. Defaults to that limit; reaching it fails tracking and attempts remote cancellation.' },
      pause: { type: 'boolean', default: true, description: 'End this agent turn after registering the job, then resume on completion. Set false to continue independent work.' },
    }, required: ['server', 'tool', 'arguments'], additionalProperties: false },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (disposed) throw new Error('MCP Tasks plugin is unloading.');
      exec.signal.throwIfAborted();
      const owner = exec.agent;
      if (!owner || ctx.agents.get(owner.id) !== owner) throw new Error('MCP Tasks needs a live owning Agent.');
      if (!ctx.tools.get('job_output', owner) || !ctx.tools.get('job_kill', owner)) throw new Error('The owning preset must provide stock job controls and a job controller.');
      const server = chooseServer(args.server);
      if (!server.allowedTools.includes(args.tool)) throw new Error(`Tool is not allowlisted for ${server.name}. Use mcp_task_tools.`);
      const maxDurationMs = args.max_wait_ms ?? config.maxDurationMs;
      if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1000 || maxDurationMs > config.maxDurationMs) throw new Error(`max_wait_ms must be an integer from 1000 to ${config.maxDurationMs}.`);
      const controller = new AbortController();
      let record;
      const id = ctx.jobs.start({
        kind: 'mcp-task', label: `${server.name}/${args.tool}`.slice(0, 180), owner: owner.id,
        toolCall: { callId: exec.callId, rootCallId: exec.rootCallId }, outputLimitBytes: config.resultMaxBytes,
        run(job) {
          // Defer side effects until the JobRegistry commits successful admission.
          const done = Promise.resolve().then(() => runTask({ server, toolName: args.tool, args: args.arguments,
            signal: controller.signal, maxDurationMs, ttlMs: Math.min(604800000, maxDurationMs + 60000),
            minPollMs: config.minPollMs, maxPollMs: config.maxPollMs, resultMaxBytes: config.resultMaxBytes,
            report: text => job.updateProgress(text),
          })).catch(error => ({ status: 'failed', detail: 'MCP task producer failed.', result: String(error.message ?? error) }));
          record = { id: job.id, owner, controller, done };
          return { done, cancel(reason) { controller.abort(new Error(reason || 'Cancellation requested through DSH jobs.')); } };
        },
      });
      active.set(id, record);
      if (args.pause !== false) exec.concludeTurn();
      return { job_id: id, server: server.name, tool: args.tool, status: 'registered', paused: args.pause !== false,
        note: 'Remote task creation is pending. A terminal DSH job notice delivers success, failure or cancellation; do not poll the model. Use job_output once if the notice asks for the result.' };
    },
  }), 'mcp-task-bridge:start');
}
