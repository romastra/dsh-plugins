import { readFile, writeFile } from 'node:fs/promises';
const source = await readFile(new URL('./src/client.js', import.meta.url), 'utf8');
const body = source.replace(/^export /gm, '');
// This is a browser module-loader factory, not an ESM bundle. Fail closed if
// a future edit adds an import/export that this intentionally small build cannot lower.
if (/^\s*(?:import|export)\s/m.test(body)) throw new Error('Client factory must be self-contained: no ESM imports/exports');
const artifact = `// Generated from src/client.js; uses the existing DSH module loader.
window.__ModuleLoader__.load({id:'@local/codex-native',factory(require){
${body}
return createPlugin(require('react'), require('react-dom'));
}});
`;
await writeFile(new URL('./client.js', import.meta.url), artifact, 'utf8');
console.log('Built codex-native client (no dependencies installed).');
