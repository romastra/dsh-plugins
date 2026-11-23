/** Bounded, read-only structural audit. Never returns messages, arguments or replay blobs. */
export async function diagnoseSession(persistence, sessionId, signal) {
  const snapshot = await persistence.stat(sessionId, { signal });
  if (!snapshot) throw new Error('Session not found.');
  if (snapshot.formatStatus === 'migration-required') {
    return { sessionId, formatStatus: snapshot.formatStatus, inspected: false };
  }
  const handle = await persistence.open(sessionId, 'read', { signal });
  const counts = {};
  const calls = new Map();
  const results = new Set();
  const failures = [];
  const tail = [];
  let latestHeader = null;
  let lastTurn = null;
  let offset = 0;
  let contiguous = true;
  let assistantReasoningBlocks = 0;
  let assistantReplayMessages = 0;
  const maxEvents = 50000;
  try {
    while (offset < maxEvents) {
      signal?.throwIfAborted();
      const { events } = await handle.read(offset, Math.min(256, maxEvents - offset), { signal });
      if (events.length === 0) break;
      for (const event of events) {
        if (event.seq !== offset) contiguous = false;
        offset += 1;
        counts[event.type] = (counts[event.type] ?? 0) + 1;
        const data = event.data;
        const row = { seq: event.seq, type: event.type };
        if (typeof data.turn === 'number') row.turn = data.turn;
        if (typeof data.step === 'number') row.step = data.step;
        if (event.type === 'turn/start') lastTurn = { turn: data.turn, startSeq: event.seq, assistantMessages: 0, attempts: 0, toolCalls: 0, toolResults: 0, retries: 0 };
        if (event.type === 'request/header') latestHeader = data.header.config;
        if (event.type === 'tool/call') {
          calls.set(data.callId, { seq: event.seq, name: data.name });
          if (lastTurn) lastTurn.toolCalls += 1;
        }
        if (event.type === 'tool/result') {
          results.add(data.message.toolCallId);
          if (lastTurn) lastTurn.toolResults += 1;
          if (data.error) row.errorCode = data.error.code;
        }
        if (event.type === 'assistant/message') {
          const content = data.message.content;
          row.blockTypes = content.map(block => block.type);
          row.hasReplayState = data.message.source.replayState !== undefined;
          assistantReasoningBlocks += content.filter(block => block.type === 'reasoning').length;
          assistantReplayMessages += Number(row.hasReplayState);
          if (lastTurn) lastTurn.assistantMessages += 1;
        }
        if (event.type === 'assistant/attempt') {
          row.streamRecords = data.stream.length;
          if (lastTurn) lastTurn.attempts += 1;
        }
        if (event.type === 'llm/retry') {
          row.retry = data.retry;
          row.errorCode = data.failure.code;
          if (lastTurn) lastTurn.retries += 1;
        }
        if (event.type === 'turn/end') {
          row.reason = data.reason;
          if (lastTurn) Object.assign(lastTurn, { endSeq: event.seq, reason: data.reason });
          if (data.reason.kind === 'error') {
            failures.push({ seq: event.seq, turn: data.turn, error: data.reason.error });
            if (failures.length > 12) failures.shift();
          }
        }
        tail.push(row);
        if (tail.length > 24) tail.shift();
      }
      if (events.length < 256) break;
    }
  } finally {
    await handle.close();
  }
  return {
    sessionId, inspected: true, formatStatus: snapshot.formatStatus ?? 'current',
    eventsRead: offset, truncated: offset >= maxEvents, contiguous,
    counts, latestRequest: latestHeader, lastTurn, recentFailures: failures,
    unansweredRecordedCalls: [...calls].filter(([id]) => !results.has(id)).map(([, value]) => value),
    retainedReasoningBlocks: assistantReasoningBlocks,
    retainedReplayMessages: assistantReplayMessages,
    tail,
    note: 'Read handle only; no Agent resume, prompts, writes, tool execution or hidden-reasoning contents. Counts describe stored events, not provider-internal state.',
  };
}
