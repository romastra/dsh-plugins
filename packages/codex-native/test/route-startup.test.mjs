import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
const installed = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'));
const { Context } = installed('@deepseek-ai/cordis');
const { default: Loader } = installed('@deepseek-ai/cordis-plugin-loader');
const appBoot = installed('@deepseek-ai/dsh-app-boot');
process.argv.push(join(process.env.DSH_INSTALL_DIR, 'lib/bin.js'));

test('saved profile cold-starts with exactly one native Codex owner, then reopens with the same generation', { timeout: 10000 }, async () => {
  const profile = appBoot.loadProfileDirectory('dsh', process.env.DSH_PROFILE_DIR, process.env.DSH_INSTALL_DIR);
  const rows = appBoot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches]);
  const pi = rows.find(row => row.id === 'llm-pi-ai');
  const native = rows.find(row => row.id === 'codex-native');
  assert.equal(pi.config.providers['openai-codex'], undefined);
  assert.ok(native.name.includes('/codex-native-next/index.js'));
  const prefix = resolve('codex-native-next/test-state/startup-');
  await mkdir(resolve('codex-native-next/test-state'), { recursive: true });
  const dir = await mkdtemp(prefix);
  const noNetwork = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('No network allowed in cold-start verification'); };
  let first;
  try {
    for (let i = 0; i < 2; i++) {
      const root = new Context();
      try {
        await root.plugin(Loader, { baseUrl: pathToFileURL(join(process.env.DSH_INSTALL_DIR, 'package.json')).href });
        for (const name of ['dsh-session-projection', 'dsh-session', 'dsh-llm']) {
          const module = installed('@deepseek-ai/' + name); await root.plugin(module.default ?? module);
        }
        await root.plugin(ctx => {
          ctx.provide('credentials', { describeRecord: async () => ({ configured: false }), readRecord: async () => { throw Error('No user credential read'); }, modifyRecord: async () => { throw Error('No credential mutation'); } });
          ctx.provide('authorization', { describe: () => ({ inFlight: false }), begin: async () => { throw Error('No login'); } });
          ctx.provide('connection', { fetch: { register: () => () => {} } });
        });
        await root.loader.create({ ...pi, name: pathToFileURL(installed.resolve('@deepseek-ai/dsh-llm-pi-ai')).href });
        await root.loader.create({ ...native, config: { ...native.config, stateDirectory: dir } });
        await root.loader.await();
        const route = root.llm.listProviders().filter(value => value.id === 'openai-codex');
        assert.deepEqual(route, [{ id: 'openai-codex', name: 'OpenAI Codex · Native replay' }]);
        assert.equal(root.llm.providerRetryPolicy('openai-codex').maxRetries, 12);
        const current = await readFile(join(dir, 'grant-generation.json'), 'utf8');
        if (first === undefined) first = current;
        else assert.equal(current, first);
      } finally { await root.fiber.dispose(); }
    }
  } finally {
    globalThis.fetch = noNetwork;
    assert.ok(resolve(dir).startsWith(prefix));
    await rm(dir, { recursive: true, force: true });
  }
});
