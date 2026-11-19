// Translation quality check with the real engine and real models, outside the browser.
// Loads the pinned Bergamot glue and binary into Node, downloads each needed model through the same
// catalog rules as the extension (packaged hashes and sizes, gzip size caps), and runs
// tests/quality/cases.json. Structural checks (protected tokens, markup) and keyword plausibility
// fail the run; chrF against the human reference is reported as an indicator, not a pass mark.
//
// Usage: node tools/quality.mjs [--cache <dir>] [--json <report.json>]
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { gunzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const cacheDir = resolve(option('--cache', join(os.tmpdir(), 'tfv-model-cache')))
const reportPath = option('--json', null)
const BUCKET = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

const catalog = JSON.parse(await readFile(join(root, 'catalog/models.json'), 'utf8'))
const cases = JSON.parse(await readFile(join(root, 'tests/quality/cases.json'), 'utf8'))

async function modelFile(file) {
  const target = join(cacheDir, file.sha256)
  try {
    const cached = await readFile(target)
    if (cached.length === file.bytes && sha256(cached) === file.sha256) return cached
  } catch {
    // Not cached.
  }
  const response = await fetch(new URL(file.path, BUCKET), { redirect: 'error' })
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`)
  const compressed = Buffer.from(await response.arrayBuffer())
  if (compressed.length !== file.gzipBytes) throw new Error(`${file.name}: unexpected size`)
  const bytes = gunzipSync(compressed, { maxOutputLength: file.bytes })
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`${file.name}: integrity check failed`)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(target, bytes)
  return bytes
}

// The engine, exactly as the worker configures it.
const lock = JSON.parse(await readFile(join(root, 'vendor/bergamot/engine.lock.json'), 'utf8'))
const glue = await readFile(join(root, 'vendor/bergamot', lock.glue.file))
if (sha256(glue) !== lock.glue.sha256) throw new Error('Glue does not match the lock file.')
const wasm = await readFile(join(root, 'vendor/bergamot', lock.wasm.file))
if (sha256(wasm) !== lock.wasm.sha256) throw new Error('Engine binary does not match the lock file.')
globalThis.require = createRequire(import.meta.url)
vm.runInThisContext(glue.toString('utf8'), { filename: 'bergamot-translator.js' })
const engine = await new Promise((done, fail) => {
  const module = globalThis.loadBergamot({ INITIAL_MEMORY: 40 * 1024 * 1024, wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), print() {}, printErr() {}, onAbort: fail, onRuntimeInitialized() { queueMicrotask(() => done(module)) } })
})
const service = new engine.BlockingService({ cacheSize: 0 })
const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 }

async function loadModel(source, target) {
  const pair = catalog.pairs[`${source}-${target}`]
  if (!pair) throw new Error(`No direct model ${source}-${target}`)
  const memory = {}
  for (const [type, file] of Object.entries(pair.files)) {
    const bytes = await modelFile(file)
    const block = new engine.AlignedMemory(bytes.length, ALIGN[type])
    block.getByteArrayView().set(bytes)
    memory[type] = block
  }
  const vocabs = new engine.AlignedMemoryList()
  if (memory.vocab) vocabs.push_back(memory.vocab)
  else { vocabs.push_back(memory.srcvocab); vocabs.push_back(memory.trgvocab) }
  const values = { 'beam-size': '1', normalize: '1.0', 'word-penalty': '0', 'max-length-break': '128', 'mini-batch-words': '1024', workspace: '128', 'max-length-factor': '2.0', 'skip-cost': 'true', 'cpu-threads': '0', quiet: 'true', 'quiet-translation': 'true', 'gemm-precision': pair.files.model.name.endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll', alignment: 'soft' }
  const config = `\n${Object.entries(values).map(([key, value]) => `            ${key}: ${value}`).join('\n')}\n            `
  return new engine.TranslationModel(source, target, config, memory.model, memory.lex ?? null, vocabs, null)
}

function translate(model, texts, html) {
  const messages = new engine.VectorString()
  const options = new engine.VectorResponseOptions()
  for (const text of texts) {
    messages.push_back(text)
    options.push_back({ qualityScores: false, alignment: true, html })
  }
  const responses = service.translate(model, messages, options)
  const out = []
  for (let index = 0; index < responses.size(); index++) out.push(responses.get(index).getTranslatedText())
  messages.delete()
  options.delete()
  responses.delete()
  return out
}

// chrF (character 6-grams, beta 2), on text without markup.
function chrF(hypothesis, reference, order = 6, beta = 2) {
  const clean = (text) => text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  const grams = (text, n) => {
    const counts = new Map()
    for (let index = 0; index + n <= text.length; index++) counts.set(text.slice(index, index + n), (counts.get(text.slice(index, index + n)) ?? 0) + 1)
    return counts
  }
  const h = clean(hypothesis)
  const r = clean(reference)
  let precision = 0
  let recall = 0
  let used = 0
  for (let n = 1; n <= order; n++) {
    const hg = grams(h, n)
    const rg = grams(r, n)
    let match = 0
    let hTotal = 0
    let rTotal = 0
    for (const value of hg.values()) hTotal += value
    for (const value of rg.values()) rTotal += value
    for (const [gram, count] of hg) match += Math.min(count, rg.get(gram) ?? 0)
    if (hTotal === 0 || rTotal === 0) continue
    precision += match / hTotal
    recall += match / rTotal
    used += 1
  }
  if (used === 0) return 0
  precision /= used
  recall /= used
  return precision + recall === 0 ? 0 : (1 + beta ** 2) * precision * recall / (beta ** 2 * precision + recall)
}

const report = { engine: lock.glue.versionString, directions: {} }
let failures = 0
for (const [direction, list] of Object.entries(cases).filter(([key]) => key !== 'note')) {
  const [source, target] = direction.split('-')
  const model = await loadModel(source, target)
  const rows = []
  const started = performance.now()
  for (const item of list) {
    const [output] = translate(model, [item.source], Boolean(item.html))
    const lower = output.toLocaleLowerCase()
    const problems = []
    if (!output.trim()) problems.push('empty output')
    for (const options of item.expect ?? []) if (!options.some((word) => lower.includes(word.toLocaleLowerCase()))) problems.push(`missing one of ${options.join('/')}`)
    for (const word of item.forbid ?? []) if (lower.includes(word)) problems.push(`contains ${word}`)
    for (const tag of item.markup ?? []) if (!output.includes(tag)) problems.push(`markup ${tag} lost`)
    const score = chrF(output, item.reference)
    // A documented model limitation is reported, not counted as a failure of this build.
    if (problems.length && !item.known) failures += 1
    rows.push({ id: item.id, output, chrF: Number(score.toFixed(3)), problems, ...(item.known ? { known: item.known } : {}) })
  }
  const ms = performance.now() - started
  const average = rows.reduce((sum, row) => sum + row.chrF, 0) / rows.length
  const chars = list.reduce((sum, item) => sum + item.source.length, 0)
  report.directions[direction] = { cases: rows.length, failed: rows.filter((row) => row.problems.length && !row.known).length, known: rows.filter((row) => row.known).length, chrF: Number(average.toFixed(3)), charsPerSecond: Math.round(chars / (ms / 1000)), rows }
  console.log(`${direction}: ${rows.length} cases, ${report.directions[direction].failed} failed checks, mean chrF ${average.toFixed(3)}, ${Math.round(chars / (ms / 1000))} chars/s (Node, single thread)`)
  for (const row of rows) console.log(`  ${row.problems.length ? (row.known ? 'KNOWN' : 'FAIL') : 'ok  '} ${row.id.padEnd(12)} ${row.chrF.toFixed(2)}  ${row.output}${row.problems.length ? `  [${row.problems.join('; ')}]` : ''}`)
  model.delete()
}
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
if (failures) {
  console.log(`${failures} case(s) failed a structural or plausibility check.`)
  process.exitCode = 1
}
