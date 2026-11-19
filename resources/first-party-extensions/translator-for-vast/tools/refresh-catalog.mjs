// Regenerates catalog/models.json, the language-model catalog that ships inside the package.
//
// The extension never downloads catalog metadata at runtime. Every hash, size and path it trusts
// comes from this snapshot, which is reviewed in source control and signed with the package. The
// snapshot joins two Mozilla sources and refuses to write when they disagree:
//   - Remote Settings `translations-models-v2`: the records Firefox uses, with the SHA-256 and size
//     of each decompressed file (the hash authority).
//   - The public model registry bucket: the gzip copy of each file, the only Mozilla source that
//     serves Chromium user agents (the Remote Settings CDN answers 406 to them).
// For every model file the registry's own decompressed hash must equal the Remote Settings hash, so
// two independently published Mozilla records agree on the bytes. Each gzip file is asked for its
// length with HEAD so the extension can refuse a response that is longer than the real file.
//
// Usage (explicit, networked, never part of the build):
//   node tools/refresh-catalog.mjs [--check]
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'catalog/models.json')
const RECORDS_URL = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models-v2/records'
const REGISTRY_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json'
const BUCKET = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data'
const MODEL_MAJOR = 3
const DESKTOP_FILTERS = new Set(['', "env.appinfo.OS != 'Android'"])
const FILE_KEYS = { model: 'model', lex: 'lexicalShortlist', vocab: 'vocab', srcvocab: 'srcVocab', trgvocab: 'trgVocab' }
const PATH = /^models\/[a-z]{2,3}(?:-[A-Za-z]{4})?-[a-z]{2,3}(?:-[A-Za-z]{4})?\/[A-Za-z0-9_-]{1,128}\/exported\/[A-Za-z0-9._-]{1,128}\.gz$/
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/

function stableVersion(version) {
  const match = /^(\d+)\.(\d+)$/.exec(version)
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

async function json(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}

async function gzipLength(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { method: 'HEAD' })
    if (response.ok) {
      const length = Number(response.headers.get('content-length'))
      if (Number.isSafeInteger(length) && length > 0) return length
    }
    await new Promise((done) => setTimeout(done, 500 * (attempt + 1)))
  }
  throw new Error(`No content length for ${url}`)
}

const records = (await json(RECORDS_URL)).data
const registry = await json(REGISTRY_URL)
if (registry.baseUrl !== BUCKET) throw new Error(`Registry points at ${registry.baseUrl}`)

// Newest stable record per pair and file type, desktop builds only.
const best = new Map()
for (const record of records) {
  const version = stableVersion(String(record.version))
  if (!version || version.major !== MODEL_MAJOR) continue
  if (!DESKTOP_FILTERS.has(String(record.filter_expression ?? '').trim())) continue
  if (!LANGUAGE.test(record.sourceLanguage) || !LANGUAGE.test(record.targetLanguage)) continue
  if (!FILE_KEYS[record.fileType] || !/^[a-f0-9]{64}$/.test(record.decompressedHash ?? '') || !Number.isSafeInteger(record.decompressedSize)) continue
  const key = `${record.sourceLanguage}-${record.targetLanguage}`
  const files = best.get(key) ?? {}
  const current = files[record.fileType]
  if (!current || version.minor > stableVersion(current.version).minor) files[record.fileType] = record
  best.set(key, files)
}

const pairs = {}
for (const [key, files] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
  const model = files.model
  if (!model) continue
  const vocabs = files.vocab ? ['vocab'] : files.srcvocab && files.trgvocab ? ['srcvocab', 'trgvocab'] : null
  if (!vocabs) continue
  const types = ['model', ...vocabs, ...(files.lex && files.lex.version === model.version ? ['lex'] : [])]
  const entry = (registry.models[key] ?? []).find((candidate) => candidate.files?.model?.uncompressedHash === model.decompressedHash)
  if (!entry) {
    console.warn(`skip ${key}: no registry entry for model ${model.decompressedHash}`)
    continue
  }
  const out = { source: model.sourceLanguage, target: model.targetLanguage, version: model.version, architecture: model.architecture ?? entry.architecture ?? null, files: {} }
  for (const type of types) {
    const record = files[type]
    if (record.version !== model.version) throw new Error(`${key}: ${type} version ${record.version} differs from model ${model.version}`)
    const path = entry.files[FILE_KEYS[type]]?.path
    if (!PATH.test(path ?? '')) throw new Error(`${key}: unexpected registry path ${path}`)
    const registryHash = entry.files[FILE_KEYS[type]].uncompressedHash
    if (registryHash && registryHash !== record.decompressedHash) throw new Error(`${key}: registry and Remote Settings disagree on ${type}`)
    out.files[type] = { name: record.name, path, gzipBytes: await gzipLength(`${BUCKET}/${path}`), bytes: record.decompressedSize, sha256: record.decompressedHash }
  }
  const comet = entry.metrics?.['flores200-plus']?.comet22
  if (typeof comet === 'number') out.comet22 = comet
  pairs[key] = out
}

const catalog = {
  schema: 1,
  modelMajor: MODEL_MAJOR,
  source: { records: RECORDS_URL, registry: REGISTRY_URL, bucket: BUCKET },
  pairs
}
const text = `${JSON.stringify(catalog, null, 1)}\n`
if (process.argv.includes('--check')) {
  const current = await readFile(output, 'utf8')
  if (current !== text) throw new Error('catalog/models.json differs from the live Mozilla catalog.')
  console.log('catalog matches')
} else {
  await writeFile(output, text)
  console.log(`wrote ${Object.keys(pairs).length} pairs`)
}
