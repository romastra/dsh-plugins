import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { streamZip } from '../archive.js';

test('cancelling a compressed download awaits native compressor close', async () => {
  const Original = zlib.DeflateRaw;
  const compressors = [];
  zlib.DeflateRaw = function(...args) {
    const compressor = new Original(...args);
    compressors.push(compressor);
    return compressor;
  };
  let reads = 0; let closed = false;
  try {
    const block = randomBytes(65536);
    const stream = streamZip(async function* () {
      yield { path: 'project/random.bin', chunks: (async function* () {
        try { for (let i = 0; i < 1000; i++) { reads++; yield block; } }
        finally { closed = true; }
      })() };
    }, new AbortController().signal);
    const reader = stream.getReader();
    while (reads === 0) { const next = await reader.read(); assert.equal(next.done, false); }
    await reader.cancel(new Error('test download cancelled'));
    await stream.settled;
    assert.ok(reads > 0 && reads < 1000);
    assert.equal(closed, true);
    assert.ok(compressors.length > 0);
    assert.ok(compressors.every(compressor => compressor.destroyed && compressor.closed));
  } finally { zlib.DeflateRaw = Original; }
});
