import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local';
import { unzipSync, strFromU8 } from 'fflate';
import { projectEntries, projectRoot, streamZip } from '../archive.js';

// This test writes only its own unique fixture. No user project/session is touched.
test('installed LocalFileSystem: real Windows paths, versions, binary, dotfiles and junctions', async () => {
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  const owned = await nodeFs.mkdtemp(path.join(parent, '.fixture-'));
  const rootPath = path.join(owned, 'project');
  const outside = path.join(owned, 'outside');
  const ctx = new Context();
  try {
    await nodeFs.mkdir(path.join(rootPath, 'empty'), { recursive: true });
    await nodeFs.mkdir(path.join(rootPath, '.git'), { recursive: true });
    await nodeFs.mkdir(outside);
    await nodeFs.writeFile(path.join(outside, 'not-in-project.txt'), 'must not leak');
    await nodeFs.writeFile(path.join(rootPath, '.git', 'config'), '[core]\n');
    await nodeFs.writeFile(path.join(rootPath, '.env'), 'EXAMPLE=one\n');
    await nodeFs.writeFile(path.join(rootPath, 'Файл 😀.txt'), 'Содержимое 😀\r\n');
    const binary = Uint8Array.from({ length: 180000 }, (_, i) => (i * 127) & 255);
    await nodeFs.writeFile(path.join(rootPath, 'bytes.bin'), binary);
    await nodeFs.symlink(outside, path.join(rootPath, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
    const fs = new LocalFileSystem(ctx, { cwd: rootPath, diffBasisMaxBytes: 10485760 });
    const signal = new AbortController().signal;
    const root = await projectRoot(fs, rootPath, signal);
    const stream = streamZip(producerSignal => projectEntries(fs, root, producerSignal), signal);
    const zip = unzipSync(new Uint8Array(await new Response(stream).arrayBuffer()));
    assert.equal(strFromU8(zip['project/.env']), 'EXAMPLE=one\n');
    assert.equal(strFromU8(zip['project/.git/config']), '[core]\n');
    assert.equal(strFromU8(zip['project/Файл 😀.txt']), 'Содержимое 😀\r\n');
    assert.deepEqual(zip['project/bytes.bin'], binary);
    assert.ok(zip['project/empty/']);
    assert.ok(Object.keys(zip).every(name => !name.includes('not-in-project')));
    assert.match(strFromU8(zip['project-export-notes.txt']), /linked-outside/u);
    assert.deepEqual(new Uint8Array(await nodeFs.readFile(path.join(rootPath, 'bytes.bin'))), binary);
    assert.equal(await nodeFs.readFile(path.join(rootPath, '.env'), 'utf8'), 'EXAMPLE=one\n');
  } finally {
    await ctx.fiber.dispose();
    // Verify the absolute deletion target is precisely our mkdtemp fixture.
    assert.equal(path.dirname(path.resolve(owned)), parent);
    assert.ok(path.basename(owned).startsWith('.fixture-'));
    await nodeFs.rm(owned, { recursive: true, force: true });
  }
});
