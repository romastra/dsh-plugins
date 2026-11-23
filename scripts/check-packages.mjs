import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { posix, resolve } from 'node:path'

const here = resolve('packages')
const config = JSON.parse(readFileSync('catalog.json', 'utf8'))
const slugs = Object.keys(config.packages).sort()
assert.deepEqual(readdirSync(here).sort(), slugs, 'catalog/package tree mismatch')
const npm = process.env.npm_execpath ?? (process.platform === 'win32' ? resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js') : null)
function run(program, args, cwd = process.cwd()) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 25_000, maxBuffer: 8_000_000, windowsHide: true })
  if (result.error || result.status !== 0) throw Error(`${program} ${args[0]} failed in ${cwd}: ${result.error?.message || result.stderr || result.stdout}`)
  return result.stdout
}
function namedExports(spec) {
  if (typeof spec === 'string') return [spec];
  if (Array.isArray(spec)) return spec.flatMap(namedExports);
  return spec ? Object.values(spec).flatMap(namedExports) : [];
}
let checkedJs = 0
for (const slug of slugs) {
  const cwd = resolve(here, slug)
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
  assert.notEqual(manifest.engines?.dsh, undefined, `DSH compatibility unrecorded: ${slug}`)
  const args = ['pack', '--dry-run', '--ignore-scripts', '--json', '--loglevel=error']
  const [pack] = JSON.parse(npm ? run(process.execPath, [npm, ...args], cwd) : run('npm', args, cwd))
  assert.equal(pack.name, manifest.name)
  assert.equal(pack.version, manifest.version)
  assert(pack.unpackedSize < 4 * 1024 * 1024, `Unexpectedly large npm artifact: ${slug}`)
  const contents = new Set(pack.files.map(f => f.path))
  const required = ['package.json', 'README.md', manifest.dsh?.bundle?.patch, manifest.main, manifest.icon, ...namedExports(manifest.exports)]
    .filter(s => typeof s === 'string' && !s.includes('*')).map(s => s.replace(/^\.\//, '').split(/[?#]/)[0])
  for (const f of required) assert(contents.has(f), `Missing packed ${slug}/${f}`)
  for (const f of contents) {
    assert(!/(^|\/)(?:\.env(?:[./]|$)|\.npmrc$|\.git(?:\/|$)|\.venv(?:\/|$)|node_modules(?:\/|$)|known_hosts$|hosts\.toml$|\w+\.(?:key|pfx|ppk|p12|sqlite3?|jsonl|log|whl|onnx|exe|dll|tgz|zip)$)/i.test(f), `Unexpected data file: ${slug}/${f}`)
    if (f.startsWith('locale/') && f.endsWith('.json')) {
      const { meta } = JSON.parse(readFileSync(resolve(cwd, f), 'utf8'))
      if (meta?.detail) assert(contents.has(meta.detail), `Missing packed detail document ${slug}/${meta.detail}`)
    }
    if (!/\.(?:js|mjs|cjs)$/i.test(f)) continue
    assert(existsSync(resolve(cwd, f)))
    if (!/(?:^|\/)(?:test|tests)\/|\.test\.|(?:^|\/)build\.mjs$/i.test(f)) {
      const code = readFileSync(resolve(cwd, f), 'utf8')
      const imports = /(?:^\s*(?:export|import)\s+(?:[^'"\n]*?\s+from\s+)?|\b(?:import|require)\(\s*)["'](\.{1,2}\/[^"'\n]+)["']/gm
      for (const [, spec] of code.matchAll(imports)) {
        const filename = posix.join(posix.dirname(f), spec.split(/[?#]/)[0])
        assert(contents.has(filename), `Missing packed relative import: ${slug}/${f} → ${filename}`)
      }
    }
    if (!process.argv.includes('--skip-syntax')) {
      run(process.execPath, ['--check', f], cwd)
      checkedJs++
    }
  }
  console.log(`${manifest.name}@${manifest.version} — ${contents.size} packed files`)
}
console.log(`${slugs.length} package manifests and ${checkedJs} packed JS files checked`)
