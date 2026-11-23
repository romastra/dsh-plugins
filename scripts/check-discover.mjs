// Run with the ASAR-aware DSH Node runtime for Desktop, or with ordinary Node for an npm installation.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  url: { type: 'string' }, file: { type: 'string' }, worker: { type: 'string' },
} })
assert(values.url && values.worker, 'Use --url URL --worker PATH; optionally --file INDEX for an offline check')
assert(['http:', 'https:'].includes(new URL(values.url).protocol))
let data
if (values.file) data = await readFile(values.file)
else {
  const reply = await fetch(values.url, { redirect: 'error', signal: AbortSignal.timeout(20_000) })
  assert.equal(reply.status, 200, 'Discover must fetch the index without authentication or redirects')
  assert(Number(reply.headers.get('content-length')) <= 4 * 1024 * 1024, 'Index has unexpectedly grown')
  data = new Uint8Array(await reply.arrayBuffer())
  assert(data.byteLength <= 4 * 1024 * 1024)
}
const result = await new Promise((accept, reject) => {
  const worker = new Worker(resolve(values.worker), { workerData: { body: new Uint8Array(data), url: values.url } })
  const timer = setTimeout(() => { worker.terminate(); reject(Error('The DSH validator timed out')) }, 10_000)
  worker.once('message', result => { clearTimeout(timer); accept(result) })
  worker.once('error', error => { clearTimeout(timer); reject(error) })
  worker.once('exit', status => { clearTimeout(timer); reject(Error(`DSH validator exited ${status} without a result`)) })
})
assert(result?.ok, result?.message ?? 'DSH validator failed')
const index = result.index
assert(Array.isArray(index.plugins))
const summary = { bundles: index.plugins.length, versions: 0, sources: {} }
for (const plugin of index.plugins) {
  for (const version of plugin.versions) {
    summary.versions++
    const type = version.source.type
    summary.sources[type] = (summary.sources[type] ?? 0) + 1
  }
}
assert(summary.bundles > 0)
console.log(JSON.stringify(summary))
