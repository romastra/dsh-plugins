import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CallToolResultSchema, CreateTaskResultSchema, TaskStatusNotificationSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const CLEANUP_MS = 5000;
const MAX_PAGES = 100;
const secretKey = /KEY|PASSWORD|SECRET|TOKEN|^DSH_/i;
const taskResultSchema = z.union([CreateTaskResultSchema, CallToolResultSchema]);
const taskCapable = tool => ['optional', 'required'].includes(tool.execution?.taskSupport);
const objectCapability = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function assertTaskId(taskId) {
  if (typeof taskId !== 'string' || !taskId.length || taskId.length > 512) throw new Error('Invalid MCP taskId (expected 1–512 characters)');
}
function boundedMetadata(tool) {
  // Keep advertised schemas intact; reject oversized schemas rather than silently weakening validation.
  const result = { name: tool.name, inputSchema: tool.inputSchema,
    ...(tool.title ? { title: tool.title.slice(0, 512) } : {}),
    ...(tool.description !== undefined ? { description: tool.description.slice(0, 8192) } : {}),
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool.execution ? { execution: tool.execution } : {}) };
  if (Buffer.byteLength(JSON.stringify(result)) > 262144) throw new Error('Tool metadata exceeds 256 KiB bound');
  return result;
}

function scrubEnvironment(explicit = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!secretKey.test(key) && value !== undefined && !value.startsWith('()')) env[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

function errorSanitizer(server) {
  const secrets = new Set();
  for (const source of [process.env, server.env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key) && typeof value === 'string' && value) secrets.add(value);
    }
  }
  // Headers and URL credentials are never part of diagnostics, including custom auth headers.
  for (const value of Object.values(server.headers ?? {})) {
    if (typeof value !== 'string' || !value) continue;
    secrets.add(value);
    if (/^\S+\s+\S+$/.test(value)) secrets.add(value.slice(value.indexOf(' ') + 1));
  }
  try {
    const url = new URL(server.url);
    for (const value of [url.username, url.password, ...url.searchParams.values()]) {
      if (value) { secrets.add(value); secrets.add(decodeURIComponent(value)); }
    }
  } catch { /* stdio has no URL */ }
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return error => {
    let message = String(error?.message ?? error ?? 'MCP connection failed');
    for (const value of values) message = message.split(value).join('[REDACTED]');
    // Do not retain cause/data: SDK error data may contain the complete request/configuration.
    const safe = new Error(message);
    safe.name = error?.name === 'AbortError' ? 'AbortError' : 'Error';
    return safe;
  };
}

function deadline(signals, ms) {
  const controller = new AbortController();
  const listeners = [];
  for (const signal of signals.filter(Boolean)) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else { signal.addEventListener('abort', abort, { once: true }); listeners.push([signal, abort]); }
  }
  const timer = setTimeout(() => controller.abort(new Error('MCP request deadline exceeded')), ms);
  return { signal: controller.signal, dispose() {
    clearTimeout(timer);
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
  } };
}

async function withSignal(operation, signal) {
  signal.throwIfAborted();
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(signal.reason ?? new Error('MCP request aborted'));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', listener); }
}

// Search returns JSON tool metadata, not prose to interpret or tool names to fuzzy-match.
function metadataFromSearch(result, name) {
  if (result.isError) throw new Error('Read-only tool metadata search failed');
  const matches = [];
  let budget = 2000;
  function visit(value, depth = 0) {
    if (--budget < 0 || depth > 12 || !value || typeof value !== 'object') return;
    if (!Array.isArray(value) && value.name === name && value.inputSchema) {
      const parsed = ToolSchema.safeParse(value);
      if (parsed.success) matches.push(parsed.data);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  }
  for (const block of result.content ?? []) {
    if (block.type !== 'text') continue;
    try { visit(JSON.parse(block.text)); } catch { /* Never parse prose or fenced snippets. */ }
  }
  if (!matches.length) throw new Error('Exact allowlisted tool metadata was not found');
  const canonical = JSON.stringify(matches[0]);
  if (matches.some(tool => JSON.stringify(tool) !== canonical)) throw new Error('Ambiguous tool metadata search result');
  return matches[0];
}

/** A new isolated legacy (2025-11-25) MCP connection; callers never share it between jobs. */
export async function openConnection(server, signal) {
  const sanitize = errorSanitizer(server);
  const requestTimeout = server.requestTimeoutMs ?? 30000;
  const startupTimeout = server.startupTimeoutMs ?? 15000;
  const lifetime = new AbortController();
  const client = new Client({ name: 'mcp-task-bridge', version: '1.0.0' }, {
    enforceStrictCapabilities: true,
    // No sampling/elicitation handlers or reverse task requests are advertised.
    capabilities: { tasks: {} },
  });
  let transport;
  let closed = false;
  let closePromise;
  let revision = 0;
  let capabilities;
  let catalog;
  const resolved = new Map();
  const outputValidators = new Map();
  const waiters = new Set();
  const allowed = new Set(server.allowedTools ?? []);

  // Notifications only wake local monitoring. They never become agent messages or results.
  client.setNotificationHandler(TaskStatusNotificationSchema, () => {
    revision += 1;
    for (const wake of [...waiters]) wake();
  });
  client.onerror = () => {}; // Transport failures are returned by the pending SDK request, not logged.

  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    lifetime.abort(new Error('MCP connection closed'));
    for (const wake of [...waiters]) wake();
    closePromise = (async () => {
      let timer;
      try {
        // SDK stdio close ends stdin, then SIGTERM/SIGKILLs the owned child (within 4s).
        await Promise.race([
          Promise.resolve().then(() => client.close()).catch(() => {}),
          new Promise(resolve => { timer = setTimeout(resolve, CLEANUP_MS); }),
        ]);
      } finally { clearTimeout(timer); }
    })();
    return closePromise;
  }

  async function request(operation, requestSignal, timeout = requestTimeout) {
    const scope = deadline([lifetime.signal, requestSignal], timeout);
    try { return await withSignal(() => operation({ signal: scope.signal, timeout, maxTotalTimeout: timeout }), scope.signal); }
    catch (error) { throw sanitize(error); }
    finally { scope.dispose(); }
  }

  try {
    signal?.throwIfAborted();
    if (server.transport === 'stdio') {
      transport = new StdioClientTransport({ command: server.command, args: server.args ?? [],
        cwd: server.cwd, env: scrubEnvironment(server.env), stderr: 'ignore' });
    } else if (server.transport === 'streamable-http') {
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...(server.headers ?? {}) } },
        // Even SSE resumption is disabled: a transport failure never triggers a replay.
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      });
    } else throw new Error('Unsupported MCP transport');
    await request(options => client.connect(transport, options), signal, startupTimeout);
    capabilities = client.getServerCapabilities() ?? {};
  } catch (error) {
    await close();
    throw sanitize(error);
  }

  function assertAllowed(name) {
    if (typeof name !== 'string' || !allowed.has(name)) throw new Error('Tool is not in server.allowedTools');
  }
  function assertTaskSupport(tool) {
    if (!objectCapability(capabilities.tasks?.requests?.tools?.call)) throw new Error('Server does not advertise tasks.requests.tools.call');
    if (!taskCapable(tool)) throw new Error('Raw tool execution.taskSupport must be optional or required');
  }
  async function loadCatalog(requestSignal) {
    if (catalog) return catalog;
    const found = new Map();
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await request(options => client.listTools(cursor === undefined ? undefined : { cursor }, options), requestSignal);
      for (const tool of result.tools) {
        if (found.has(tool.name) && JSON.stringify(found.get(tool.name)) !== JSON.stringify(tool)) throw new Error('Conflicting tools/list metadata');
        found.set(tool.name, tool);
      }
      if (result.nextCursor === undefined) { catalog = found; return found; }
      if (seen.has(result.nextCursor)) throw new Error('tools/list pagination cursor cycle');
      seen.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error('tools/list exceeded 100 pages');
  }
  async function resolveTool(name, requestSignal) {
    try {
      assertAllowed(name);
      if (closed) throw new Error('MCP connection closed');
      requestSignal?.throwIfAborted();
      if (resolved.has(name)) return structuredClone(resolved.get(name));
      const tools = await loadCatalog(requestSignal);
      let tool = tools.get(name);
      if (!tool) {
        const search = tools.get('search_tools');
        if (!search || search.annotations?.readOnlyHint !== true) throw new Error('Exact tool not listed and read-only search_tools unavailable');
        const searchArgs = { query: name };
        const validate = new AjvJsonSchemaValidator().getValidator(search.inputSchema);
        if (!validate(searchArgs).valid) throw new Error('search_tools does not accept a name query');
        const result = await request(options => client.request({ method: 'tools/call', params: {
          name: 'search_tools', arguments: searchArgs,
        } }, CallToolResultSchema, options), requestSignal);
        tool = metadataFromSearch(result, name);
      }
      tool = boundedMetadata(tool);
      resolved.set(name, structuredClone(tool));
      return structuredClone(tool);
    } catch (error) { throw sanitize(error); }
  }
  function validateOutput(result, validator) {
    if (!validator) return result;
    if (result.structuredContent === undefined) {
      if (!result.isError) throw new Error('Tool outputSchema requires structuredContent');
    } else {
      const validation = validator(result.structuredContent);
      if (!validation.valid) throw new Error(`Tool output does not match outputSchema: ${validation.errorMessage}`);
    }
    return result;
  }

  return {
    get revision() { return revision; },
    get capabilities() { return structuredClone(capabilities); },
    resolveTool,
    async listTaskTools(requestSignal) {
      const tools = [];
      for (const name of allowed) {
        const tool = await resolveTool(name, requestSignal);
        if (objectCapability(capabilities.tasks?.requests?.tools?.call) && taskCapable(tool)) tools.push(tool);
      }
      return tools;
    },
    async createTask(name, args, { signal: requestSignal, ttl } = {}) {
      try {
        const tool = await resolveTool(name, requestSignal);
        assertTaskSupport(tool);
        const validator = new AjvJsonSchemaValidator();
        const validation = validator.getValidator(tool.inputSchema)(args);
        if (!validation.valid) throw new Error(`Tool arguments do not match inputSchema: ${validation.errorMessage}`);
        if (ttl !== undefined && (!Number.isSafeInteger(ttl) || ttl < 0)) throw new Error('Task ttl must be a nonnegative safe integer');
        // Separate providers prevent a reused remote $id from substituting the input schema for output.
        const outputValidator = tool.outputSchema ? new AjvJsonSchemaValidator().getValidator(tool.outputSchema) : undefined;
        // Exactly one creation request. A lost response is indeterminate, never retried.
        const receipt = await request(options => client.request({ method: 'tools/call', params: {
          name, arguments: args,
        } }, taskResultSchema, { ...options, task: ttl === undefined ? {} : { ttl } }), requestSignal);
        if (receipt.task !== undefined) {
          CreateTaskResultSchema.parse(receipt);
          assertTaskId(receipt.task.taskId);
          outputValidators.set(receipt.task.taskId, outputValidator);
        } else validateOutput(receipt, outputValidator);
        return receipt;
      } catch (error) { throw sanitize(error); }
    },
    async getTask(taskId, requestSignal) {
      try {
        assertTaskId(taskId);
        const task = await request(options => client.experimental.tasks.getTask(taskId, options), requestSignal);
        assertTaskId(task.taskId);
        return task;
      } catch (error) { throw sanitize(error); }
    },
    async getResult(taskId, requestSignal) {
      try {
        assertTaskId(taskId);
        if (!outputValidators.has(taskId)) throw new Error('Task is not owned by this connection');
        const result = await request(options => client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema, options), requestSignal);
        return validateOutput(result, outputValidators.get(taskId));
      } catch (error) { throw sanitize(error); }
    },
    async cancelTask(taskId) {
      if (!objectCapability(capabilities.tasks?.cancel)) return 'Remote cancellation unsupported; remote work may still be running.';
      try {
        assertTaskId(taskId);
        // Deliberately independent of the job/lifetime signal: cleanup still works after job abort.
        const cleanupSignal = AbortSignal.timeout(CLEANUP_MS);
        await withSignal(() => client.experimental.tasks.cancelTask(taskId, {
          signal: cleanupSignal, timeout: CLEANUP_MS, maxTotalTimeout: CLEANUP_MS,
        }), cleanupSignal);
        return 'Remote cancellation acknowledged.';
      } catch (error) { return `Remote cancellation failed; remote work may still be running: ${sanitize(error).message}`; }
    },
    async waitForUpdate(previousRevision, delayMs, requestSignal) {
      try {
        requestSignal?.throwIfAborted();
        lifetime.signal.throwIfAborted();
        if (revision !== previousRevision) return revision;
        if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid update wait delay');
        await new Promise((resolve, reject) => {
          let timer;
          const dispose = () => {
            clearTimeout(timer); waiters.delete(wake);
            requestSignal?.removeEventListener('abort', abort);
            lifetime.signal.removeEventListener('abort', abort);
          };
          const wake = () => { dispose(); resolve(); };
          const abort = () => { dispose(); reject(requestSignal?.aborted ? requestSignal.reason : lifetime.signal.reason); };
          waiters.add(wake);
          requestSignal?.addEventListener('abort', abort, { once: true });
          lifetime.signal.addEventListener('abort', abort, { once: true });
          timer = setTimeout(wake, Math.min(delayMs, 2147483647));
          // Snapshot was taken before getTask; a notification in between must not be lost.
          if (revision !== previousRevision) wake();
          else if (requestSignal?.aborted || lifetime.signal.aborted) abort();
        });
        return revision;
      } catch (error) { throw sanitize(error); }
    },
    close,
  };
}
