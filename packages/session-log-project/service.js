import { ExportError, projectEntries, projectRoot, safeFilename, streamChunks, streamZip, validSessionId } from './archive.js';

export const EXPORT_PATH = '/api/session.project-export';
export const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Session to export; defaults to the calling session.' },
  },
  additionalProperties: false,
};

/** The browser download and agent attachment use this exact archive operation. */
export function createExportService(ctx, logApi, { compressionLevel = 6 } = {}) {
  const lifetime = new AbortController();
  const active = new Set();
  const signalOf = signal => AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  async function prepare(value, signal) {
    const sessionId = validSessionId(value);
    signal.throwIfAborted();
    const deps = logApi.sessionLogExportDeps(ctx);
    if (!deps.sessionPersistence || !deps.sessionQuery || !deps.attachments) {
      throw new ExportError('export-unavailable', 'The session log export services are unavailable.', 503);
    }
    await logApi.flushLiveSessionLog(deps, sessionId, signal);
    const rootContent = await logApi.readSessionLogText(deps.sessionPersistence, sessionId, signal);
    if (rootContent === undefined) throw new ExportError('session-not-found', 'Session not found.', 404);
    signal.throwIfAborted();
    // Read the effective directory through its domain owner, not the initial
    // header or a global process cwd. This also handles worktrees and cwd changes.
    const cwd = await ctx.sessionQuery.inspectSession(sessionId, session => ctx.workingDirectory.get(session), signal);
    const root = await projectRoot(ctx.fs, cwd, signal);
    return { deps, rootContent, sessionId, root, filename: safeFilename(sessionId) };
  }
  function archive(prepared, signal) {
    const stream = streamZip(async function* (producerSignal) {
      yield* logApi.sessionLogZipEntries(prepared.deps, prepared.rootContent, prepared.sessionId, true, producerSignal);
      yield* projectEntries(ctx.fs, prepared.root, producerSignal);
    }, signal, { compressionLevel });
    active.add(stream.settled);
    stream.settled.then(() => active.delete(stream.settled), () => active.delete(stream.settled));
    return stream;
  }
  async function response(request) {
    const signal = signalOf(request.signal);
    try {
      const url = new URL(request.url);
      if (url.searchParams.getAll('sessionId').length !== 1) throw new ExportError('invalid-session', 'Expected one sessionId.', 400);
      const prepared = await prepare(url.searchParams.get('sessionId'), signal);
      return new Response(request.method === 'HEAD' ? null : archive(prepared, signal), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${prepared.filename}"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ExportError)) ctx.logger.warn('session-log-project: export preparation failed: %s', error instanceof Error ? error.message : String(error));
      const failure = error instanceof ExportError ? error : new ExportError('export-failed', 'Could not read the session log or project directory. Check access and retry.', 500);
      return Response.json({ error: failure.message, code: failure.code }, { status: failure.status, headers: { 'cache-control': 'no-store' } });
    }
  }
  async function save(sessionId, requestSignal) {
    const signal = signalOf(requestSignal);
    const prepared = await prepare(sessionId, signal);
    const attachment = await ctx.attachments.saveFileStream({ data: streamChunks(archive(prepared, signal)), name: prepared.filename, signal });
    return {
      filename: prepared.filename,
      projectDirectory: prepared.root.displayPath,
      attachment,
      filePath: ctx.attachments.fileHostPath(attachment) ?? null,
    };
  }
  return {
    response,
    save,
    async dispose() {
      lifetime.abort(new Error('Session log with project plugin unloaded.'));
      await Promise.allSettled([...active]);
    },
  };
}
