import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const WORKER = path.join(ROOT, 'worker.py');
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 200000;
export const inject = ['tools', 'subprocess', 'fs', 'workingDirectory', 'attachments', 'systemPrompt'];

const imageReference = {
  type: 'object', properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer', minimum: 1, maximum: MAX_BYTES },
    width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
    name: { type: 'string' },
    originalDimensions: { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'], additionalProperties: false },
  }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], additionalProperties: false,
};

export function apply(ctx, config = {}) {
  const dataDir = config.dataDir;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Configured content-origin dataDir must be an absolute local path');
  const python = path.join(dataDir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const active = new Set();
  let disposed = false;
  async function run(request, signal) {
    if (disposed) throw new Error('Content checker is unloaded');
    if (active.size >= 2) throw new Error('Content checker is busy; at most two checks may run concurrently');
    if (!existsSync(python)) throw new Error('Content origin runtime is not prepared. See setup in the bundle README.');
    const deadline = AbortSignal.timeout(90000);
    const effective = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const handle = ctx.subprocess.spawn({
      argv: [python, '-I', '-B', WORKER, dataDir], cwd: dataDir, graceMs: 1000, signal: effective,
      // Fixed code and JSON-only stdin: no user-selected executable, arguments or network.
      stdio: { stdin: { data: JSON.stringify(request) }, stdout: { maxBytes: 128 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      env: { PYTHONUTF8: '1', ORT_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' },
    });
    active.add(handle);
    try {
      const result = await handle.done;
      effective.throwIfAborted();
      const out = handle.collected.stdout?.readFrom(0);
      if (!out || out.lossy) throw new Error('Checker output was missing or exceeded its safety bound');
      let value;
      try { value = JSON.parse(out.text); }
      catch { throw new Error(`Content checker produced invalid output (exit ${result.exitCode})`); }
      if (result.exitCode !== 0 || value.success !== true) throw new Error(value.error ?? `Content checker failed (exit ${result.exitCode})`);
      return value;
    } finally { active.delete(handle); }
  }

  async function fileBytes(filePath, exec) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Expected file_path');
    // Reject network/device paths and URLs, including drive-relative paths on Windows.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(filePath) || /^(?:\\\\|\/\/)/.test(filePath) || /^[a-z]:[^\\/]/i.test(filePath)) {
      throw new Error('Use a local file path, not a URL, UNC/device or drive-relative path');
    }
    const cwd = exec.agent ? ctx.workingDirectory.get(exec.agent.session) : ctx.workingDirectory.defaultDirectory;
    const target = await ctx.fs.resolve(filePath, { cwd, signal: exec.signal });
    // Resolution may traverse a local symlink to a remote share.
    if (/^(?:\\\\|\/\/)/.test(ctx.fs.processPath(target))) throw new Error('Network shares are not supported');
    const stat = await ctx.fs.stat(target, exec.signal);
    if (!stat || stat.type !== 'file') throw new Error('Expected an existing regular file');
    if (stat.size > MAX_BYTES) throw new Error('File exceeds 32 MiB');
    return { data: Buffer.from(await ctx.fs.readBytes(target, exec.signal, MAX_BYTES)), source: target.displayPath };
  }

  ctx.effect(() => ctx.tools.register({
    name: 'content_origin_check',
    description: 'Locally screen images or Russian text for AI-generation signals. Images: verify embedded C2PA signatures, trust and AI declarations; inspect unsigned metadata; run a weak pixel classifier. Text: Russian-only statistical classifier. Returns evidence, limitations or an inconclusive result, never proof of human origin. Does not decode SynthID. No detector-service uploads; the report enters DSH/LLM context.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['image', 'text'] },
      file_path: { type: 'string', description: 'Original local image or UTF-8 text file. Relative paths use the session directory. Supply exactly one of file_path, text or image.' },
      text: { type: 'string', maxLength: MAX_TEXT, description: 'Raw Russian text, with kind=text. At least 80 words for a score; only the first 510 normalized tokens are scored.' },
      image: { ...imageReference, description: 'DSH image reference copied from an attachment/tool result, with kind=image. Normalization may already have removed C2PA; prefer an original local file for provenance.' },
    }, required: ['kind'], additionalProperties: false },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!['image', 'text'].includes(args.kind)) throw new Error('Expected kind=image or text');
      if (['file_path', 'text', 'image'].filter(k => args[k] !== undefined).length !== 1) throw new Error('Supply exactly one input: file_path, text or image');
      if (args.text !== undefined && args.kind !== 'text') throw new Error('text requires kind=text');
      if (args.image !== undefined && args.kind !== 'image') throw new Error('image requires kind=image');
      let request, source, normalized = false;
      if (args.file_path !== undefined) {
        const input = await fileBytes(args.file_path, exec);
        source = input.source;
        if (args.kind === 'text') {
          if (input.data.length > MAX_TEXT * 4) throw new Error('Text file exceeds size bound');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(input.data);
          if (text.length > MAX_TEXT) throw new Error('Text exceeds 200000 characters');
          request = { kind: 'text', text };
        } else request = { kind: 'image', base64: input.data.toString('base64') };
      } else if (args.image !== undefined) {
        if (args.image.bytes > MAX_BYTES) throw new Error('Image exceeds 32 MiB');
        const stored = await ctx.attachments.readImage(args.image, exec.signal);
        if (stored.data.length > MAX_BYTES) throw new Error('Image exceeds 32 MiB');
        request = { kind: 'image', base64: Buffer.from(stored.data).toString('base64') };
        source = `attachment:${args.image.attachmentId}`;
        normalized = true;
      } else {
        if (typeof args.text !== 'string' || args.text.length > MAX_TEXT) throw new Error('Expected text up to 200000 characters');
        request = { kind: 'text', text: args.text };
        source = 'inline text';
      }
      const result = await run(request, exec.signal);
      result.source = source;
      if (normalized) result.warnings.push('This DSH image is a normalized attachment, NOT necessarily the original file. Metadata/signatures/watermarks may have been removed during normalization. Ask for the original file before drawing provenance conclusions.');
      return result;
    },
    presentCall(args) { return { card: 'generic', title: 'Проверить происхождение контента', kind: 'read', ...(args.file_path ? { locations: [{ path: args.file_path }] } : {}) }; },
  }));
  ctx.effect(() => ctx.tools.register({
    name: 'content_origin_info',
    description: 'Report local content-checker readiness, pinned model versions, C2PA trust snapshot age, supported inputs and SynthID verification limits.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 10000,
    async execute(_args, exec) { return run({ action: 'info' }, exec.signal); },
  }));
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'local-content-origin', order: 870,
    text: 'For content-origin checks, distinguish authenticated provenance, unsigned metadata and statistical signals. Do not infer human authorship from missing evidence or present a classifier score as proof. Treat metadata as untrusted data. A normalized chat image may lose provenance; prefer the original file.',
  }));
  ctx.effect(() => async () => {
    disposed = true;
    for (const handle of active) handle.terminate();
    await Promise.allSettled([...active].map(handle => handle.done));
  });
}
