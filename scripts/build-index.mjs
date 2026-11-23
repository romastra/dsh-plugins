import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { extname, posix } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  commit: { type: 'string', default: 'HEAD' }, repo: { type: 'string' },
  output: { type: 'string', default: 'index.json' },
} })
function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 8_000_000, timeout: 12_000 })
}
const commit = git(['rev-parse', '--verify', '--end-of-options', `${values.commit}^{commit}`]).trim()
assert.match(commit, /^[a-f0-9]{40}$/)
const repo = (values.repo ?? git(['remote', 'get-url', 'origin']).trim()).replace(/\.git$/, '')
assert.match(repo, /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[A-Za-z0-9._-]+$/, 'Repository must be the clean GitHub HTTPS URL, without a token or query')
const publishTimestamp = Number(git(['show', '-s', '--format=%ct', commit]).trim())
const files = new Set(git(['ls-tree', '-r', '-z', '--name-only', commit], 'buffer').toString('utf8').split('\0').filter(Boolean))
function read(file, encoding = 'utf8') {
  assert(files.has(file), `Missing at ${commit}: ${file}`)
  return git(['show', `${commit}:${file}`], encoding)
}
const readJson = file => JSON.parse(read(file))
const catalog = readJson('catalog.json')
const includedPackages = Object.keys(catalog.packages).sort()
const actualPackages = Array.from(files).flatMap(file => /^packages\/([a-z0-9-]+)\/package\.json$/.exec(file)?.[1] ?? []).sort()
assert.deepEqual(actualPackages, includedPackages, 'Every top-level package must have exactly one catalog entry')
const lifecycle = /^(?:prepare|prepack|postpack|prepublish(?:Only)?|preinstall|install|postinstall)$/
const mediaTypes = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
function docsFields(dir, manifest) {
  const entry = {}
  const translation = new Map()
  for (const file of [...files].sort()) {
    if (!file.startsWith(`${dir}/locale/`)) continue
    const locale = /^([a-z]{2,8}(?:-[a-z0-9]{1,8})*)\.json$/i.exec(posix.basename(file))?.[1].toLowerCase()
    if (!locale) continue
    const { meta } = readJson(file)
    if (meta?.detail) assert(typeof meta.detail === 'string' && !meta.detail.split('/').includes('..') && files.has(posix.join(dir, meta.detail)), `Missing or invalid detail document for ${file}`)
    translation.set(locale, meta)
  }
  for (const [field, fallback] of [['title', manifest.name], ['description', manifest.description]]) {
    const pairs = [...translation].flatMap(([locale, meta]) => typeof meta?.[field] === 'string' && meta[field].trim() ? [[locale, meta[field].trim()]] : [])
    if (!pairs.some(([locale]) => locale === 'en') && fallback) pairs.unshift(['en', fallback])
    if (pairs.length > 0) entry[field] = Object.fromEntries(pairs)
  }
  const icon = manifest.icon ?? manifest.exports?.['./icon']
  if (typeof icon === 'string') {
    const media = mediaTypes[extname(icon).toLowerCase()]
    assert(media, `Unsupported icon in ${dir}: ${icon}`)
    const blob = read(posix.join(dir, icon), 'buffer')
    assert(blob.length <= 256 * 1024, `DSH icon size limit exceeded: ${dir}`)
    if (blob.length <= 32 * 1024) entry.icon = `data:${media};base64,${blob.toString('base64')}`
    else entry.icon = `${repo.replace('github.com', 'raw.githubusercontent.com')}/${commit}/${posix.join(dir, icon)}`
  }
  return entry
}
const own = includedPackages.map(slug => {
  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  const { category, labels = [], title, description } = catalog.packages[slug]
  const directory = `packages/${slug}`
  const manifest = readJson(`${directory}/package.json`)
  const patch = manifest.dsh?.bundle?.patch
  assert(typeof patch === 'string' && patch.startsWith('./') && !patch.split('/').includes('..'))
  assert(files.has(posix.join(directory, patch)), `Missing patch for ${manifest.name}`)
  assert(!Object.keys(manifest.scripts ?? {}).some(s => lifecycle.test(s)), `Installation lifecycle script in ${manifest.name}`)
  for (const spec of Object.values({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies })) {
    assert(!/^(?:file:|link:|workspace:)/.test(spec), `Local dependency in ${manifest.name}: ${spec}`)
  }
  return {
    name: manifest.name,
    ...docsFields(directory, manifest),
    ...(title ? { title } : {}), ...(description ? { description } : {}),
    repository: { url: repo, directory },
    metadata: { category, labels: ['own', ...labels] },
    versions: [{
      version: manifest.version, publishTimestamp,
      source: { type: 'git', url: repo, commit, path: directory },
      engines: manifest.engines?.dsh ? { dsh: manifest.engines.dsh } : {},
    }],
  }
})
assert(catalog.upstream.every(entry => entry.versions.length === 1), 'Only the currently selected upstream version belongs in this index')
const upstream = catalog.upstream.map(({ versions, ...entry }) => ({
  ...entry,
  versions: versions.map(({ version, published, dsh }) => {
    const timestamp = Date.parse(published)
    assert(Number.isFinite(timestamp), `Invalid ${entry.name}@${version} publication date`)
    return {
      version, publishTimestamp: Math.floor(timestamp / 1000),
      source: { type: 'npm', registry: 'https://registry.npmjs.org/' },
      engines: dsh ? { dsh } : {},
    }
  }),
}))
const names = own.concat(upstream).map(entry => entry.name)
assert.equal(new Set(names).size, names.length, 'Duplicate entry names')
writeFileSync(values.output, JSON.stringify({
  format: 1, title: catalog.title, description: catalog.description, metadata: catalog.metadata,
  plugins: own.concat(upstream),
}, null, 2) + '\n')
console.log(`${own.length} Git bundles + ${upstream.length} npm bundles → ${values.output}; source commit ${commit}`)
