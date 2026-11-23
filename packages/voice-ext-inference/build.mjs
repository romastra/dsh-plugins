import { readFile, writeFile } from 'node:fs/promises';
import { compileClient } from './compile-client.mjs';

// Immutable browser entry pathname: a linked bundle upgrade cannot accidentally
// reuse the old Client module when no dev:web build watcher is running.
const root = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
// Host-only releases retain the reviewed immutable browser artifact.
const clientVersion = manifest.clientArtifactVersion ?? manifest.version;
const target = `./client-${clientVersion}.js`;
if (manifest.exports['./client'] !== target) throw new Error('Client export must match declared clientArtifactVersion (or package version by default)');
const source = await compileClient(root);
if (!source.includes(`version: '${clientVersion}'`)) throw new Error('Inspect version must match the package version');
const destination = new URL(target, root);
try {
  await writeFile(destination, source, { flag: 'wx' });
  console.log(`Built ${manifest.name} ${manifest.version}: ${target}`);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (await readFile(destination, 'utf8') !== source) {
    throw new Error('Versioned Client artifacts are immutable; bump the Client artifact/Inspect version for changed browser source');
  }
  console.log(`Verified unchanged ${manifest.name} ${manifest.version}: ${target}`);
}
