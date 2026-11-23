import { readFile } from 'node:fs/promises';

export async function compileClient(root = new URL('./', import.meta.url)) {
  const marker = '    // @local-parakeet:feature-modules';
  const source = await readFile(new URL('client.js', root), 'utf8');
  const modules = await Promise.all(['hold-to-talk.mjs', 'question-ui.mjs', 'rig-client.mjs', 'microphone-input.mjs', 'microphone-picker.mjs', 'recording-limit.mjs', 'rig-finalization.mjs'].map(async name => {
    const text = await readFile(new URL(name, root), 'utf8');
    if (/^import\s/m.test(text)) throw new Error(`Client feature must be self-contained: ${name}`);
    return text.replace(/^export /gm, '');
  }));
  if (source.split(marker).length !== 2) throw new Error('Client feature marker must appear exactly once');
  return source.replace(marker, modules.join('\n\n'));
}
