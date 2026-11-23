// Protocol-independent job producer. Polling and notifications never call a model.
import { openConnection } from './connection.js';
import { setTimeout as sleep } from 'node:timers/promises';

export function fitText(text, bytes) {
  const value = String(text);
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = '\n[truncated]';
  return Buffer.from(value).subarray(0, Math.max(0, bytes - Buffer.byteLength(suffix))).toString('utf8').replace(/\uFFFD$/, '') + suffix;
}

export function summarizeResult(result, metadata, limit) {
  const content = (result.content ?? []).map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'resource_link') return { type: block.type, uri: block.uri, name: block.name };
    return { type: 'text', text: `[MCP ${block.type ?? 'unknown'} block omitted: this bridge delivers text and structured data only]` };
  });
  const value = { ...metadata, isError: result.isError === true, content,
    ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) <= limit) return json;
  const fallback = { ...metadata, isError: result.isError === true, truncated: true,
    text: fitText(content.filter(b => b.type === 'text').map(b => b.text).join('\n'), Math.max(256, limit - 1024)),
    note: 'Result exceeded the configured byte bound; structured data and rich blocks may be omitted.' };
  let encoded = JSON.stringify(fallback);
  while (Buffer.byteLength(encoded) > limit && fallback.text.length > 0) {
    fallback.text = fallback.text.slice(0, Math.floor(fallback.text.length / 2));
    encoded = JSON.stringify(fallback);
  }
  // Even malicious escaped identifiers cannot bypass the byte limit.
  return Buffer.byteLength(encoded) <= limit ? encoded : JSON.stringify({ isError: result.isError === true, truncated: true, note: 'Oversized MCP result and metadata omitted.' });
}

function pollDelay(task, options) {
  const suggestion = task.pollInterval ?? task.pollIntervalMs ?? options.minPollMs;
  return Math.max(options.minPollMs, Math.min(options.maxPollMs,
    Number.isFinite(suggestion) && suggestion >= 0 ? suggestion : options.minPollMs));
}

export async function runTask({ server, toolName, args, signal, report = () => {}, open = openConnection,
  maxDurationMs = 86400000, ttlMs = 86400000, minPollMs = 1000, maxPollMs = 30000, resultMaxBytes = 65536 }) {
  const deadline = AbortSignal.timeout(maxDurationMs);
  const combined = AbortSignal.any([signal, deadline]);
  let connection;
  let taskId;
  let terminal = false;
  let lastStatus;
  const metadata = () => ({ server: server.name, tool: toolName, ...(taskId ? { task_id: taskId } : {}) });
  const publish = status => { if (status !== lastStatus) { lastStatus = status; report(`${server.name}/${toolName}: ${status}${taskId ? ` (${taskId})` : ''}`); } };
  try {
    combined.throwIfAborted();
    publish('connecting');
    connection = await open(server, combined);
    combined.throwIfAborted();
    const response = await connection.createTask(toolName, args, { signal: combined, ttl: ttlMs });
    if (!response.task) {
      terminal = true;
      const failed = response.isError === true;
      publish(failed ? 'failed' : 'completed');
      return { status: failed ? 'failed' : 'completed', detail: 'Server returned an inline tool result (no remote task was created).',
        result: summarizeResult(response, { ...metadata(), execution: 'inline' }, resultMaxBytes) };
    }
    taskId = response.task.taskId;
    publish(response.task.status);
    // A notification is a hint to re-read authoritative status, never an instruction.
    for (;;) {
      combined.throwIfAborted();
      const revision = connection.revision;
      const task = await connection.getTask(taskId, combined);
      if (task.taskId !== taskId) throw new Error('MCP returned a mismatched task id.');
      publish(task.status);
      if (task.status === 'completed') {
        terminal = true;
        const result = await connection.getResult(taskId, combined);
        return { status: result.isError === true ? 'failed' : 'completed',
          detail: result.isError === true ? 'MCP tool returned isError.' : `MCP task ${taskId} completed.`,
          result: summarizeResult(result, { ...metadata(), execution: 'task' }, resultMaxBytes) };
      }
      if (task.status === 'cancelled') {
        terminal = true;
        return { status: 'killed', detail: `Remote MCP task ${taskId} was cancelled.`, result: JSON.stringify({ ...metadata(), status: 'cancelled' }) };
      }
      if (task.status === 'failed') {
        terminal = true;
        let result;
        try { result = summarizeResult(await connection.getResult(taskId, combined), metadata(), resultMaxBytes); }
        catch (error) { result = fitText(error.message ?? String(error), resultMaxBytes); }
        return { status: 'failed', detail: `Remote MCP task ${taskId} failed.`, result };
      }
      if (task.status === 'input_required') throw new Error('MCP task requires interactive input; this bridge does not advertise elicitation or sampling. Tracking stopped and cancellation will be attempted.');
      if (task.status !== 'working') throw new Error(`Unsupported MCP task status: ${String(task.status)}`);
      const waitingSince = performance.now();
      await connection.waitForUpdate(revision, pollDelay(task, { minPollMs, maxPollMs }), combined);
      // Push hints may arrive faster than polling. Bound the authoritative query
      // rate too, including a notification racing every tasks/get response.
      const remaining = minPollMs - (performance.now() - waitingSince);
      if (remaining > 0) await sleep(remaining, undefined, { signal: combined });
    }
  } catch (error) {
    let cancellation;
    if (connection && taskId && !terminal) {
      try { cancellation = await connection.cancelTask(taskId); }
      catch { cancellation = 'Remote cancellation failed; remote work may still be running.'; }
    }
    const killed = signal.aborted;
    const reason = killed ? `Cancelled: ${String(signal.reason?.message ?? signal.reason ?? 'requested')}`
      : deadline.aborted ? `Monitoring deadline reached (${maxDurationMs} ms).` : String(error.message ?? error);
    return { status: killed ? 'killed' : 'failed', detail: fitText(reason, 1024),
      result: fitText(JSON.stringify({ ...metadata(), error: reason, ...(cancellation ? { cancellation } : {}),
        ...(!taskId ? { note: 'No task receipt was obtained. Creation is never retried; remote execution may be indeterminate after a transport failure.' } : {}) }), resultMaxBytes) };
  } finally {
    // close() owns a bounded, idempotent shutdown, even after cancellation.
    if (connection) await connection.close();
  }
}
