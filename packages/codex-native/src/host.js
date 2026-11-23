import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Resolve only the application-supplied modules; never install or patch them.
const entry = process.argv.find(arg => typeof arg === 'string' && /[\\/]dsh[\\/].*\.(?:js|mjs|cjs)$/.test(arg));
const anchor = process.resourcesPath ? process.resourcesPath + '/app.asar/dsh/package.json' : entry;
if (!anchor) throw new Error('CODEX_NATIVE_HOST_UNAVAILABLE');
const requireHost = createRequire(anchor);
const pinnedEntrypoints = {
  '@earendil-works/pi-ai': '@earendil-works/pi-ai/dist/index.js',
  '@earendil-works/pi-ai/providers/openai-codex': '@earendil-works/pi-ai/dist/providers/openai-codex.js',
};
function resolveHost(specifier) {
  return pinnedEntrypoints[specifier] ? join(dirname(anchor), 'node_modules', pinnedEntrypoints[specifier]) : requireHost.resolve(specifier);
}
export async function hostModule(specifier) {
  return import(pathToFileURL(resolveHost(specifier)).href);
}
export function hostVersion(specifier) {
  let directory = dirname(resolveHost(specifier));
  for (let depth = 0; depth < 6; depth++) {
    try { const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); if (manifest.name === specifier) return manifest.version; } catch {}
    directory = dirname(directory);
  }
  throw new Error('CODEX_NATIVE_HOST_VERSION_UNAVAILABLE');
}
