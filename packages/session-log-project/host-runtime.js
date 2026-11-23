import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createExportService, EXPORT_PATH, TOOL_PARAMETERS } from './service.js';

// engines.dsh is an explicit union of tested releases; reject all other anchors.
const dshEngine = createRequire(import.meta.url)('./package.json').engines.dsh;
const supportedDshVersions = new Set(dshEngine.split('||').map(version => version.trim()));


// Linked workspace bundles do not resolve the Desktop app's shipped peers via
// ordinary node_modules ancestry. Anchor these public APIs to the running DSH,
// never to an unrelated checkout or a second downloaded copy of the framework.
function installedRequire() {
  const candidates = [process.env.DSH_INSTALL_DIR];
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'));
  for (const directory of candidates.filter(Boolean)) {
    try {
      const require = createRequire(join(directory, 'package.json'));
      const manifest = require('./package.json');
      if (manifest.name === '@deepseek-ai/dsh' && supportedDshVersions.has(manifest.version)) return require;
    } catch { /* Try the next verified runtime anchor. */ }
  }
  throw new Error(`Session log with project could not locate the running DSH installation (${dshEngine}).`);
}
const requireDSH = installedRequire();
const { default: Schema } = await import(pathToFileURL(requireDSH.resolve('@deepseek-ai/schemastery')).href);
const logApi = await import(pathToFileURL(requireDSH.resolve('@deepseek-ai/dsh-session-log-export')).href);

export const inject = ['connection', 'fs', 'sessionQuery', 'sessionPersistence', 'attachments', 'workingDirectory', 'tools'];
export const Config = Schema.object({ compressionLevel: Schema.number().step(1).min(0).max(9).default(6) });

export function apply(ctx, config) {
  const service = createExportService(ctx, logApi, config);
  ctx.effect(() => () => service.dispose(), 'session-log-project: lifetime');
  ctx.provide('sessionLogProject', service);
  ctx.effect(() => ctx.connection.fetch.register({
    path: EXPORT_PATH, methods: ['GET', 'HEAD'], requestBody: 'buffered',
    fetch: request => service.response(request),
  }), 'session-log-project: authenticated export');
  ctx.effect(() => ctx.tools.register({
    name: 'session_log_with_project', deferLoading: true,
    description: 'Create a ZIP containing the selected session log, descendant logs, attachments, and its entire current project directory under project/. Includes hidden and ignored files; symbolic links and special files are listed in export notes instead of followed. Saves the ZIP as a file attachment and returns its host path when available. Source files are not modified.',
    parameters: TOOL_PARAMETERS,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { return service.save(args.sessionId ?? exec.agent?.id, exec.signal); },
  }), 'session-log-project: shared archive tool');
}
