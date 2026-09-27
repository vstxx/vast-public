// Maintainer-only, offline conversion of the included, pinned GPL source.
// No minification: function bodies remain readable and reproducible.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Resources } from '@ghostery/adblocker'
import { builtinScriptlets } from './src/js/resources/scriptlets.js'
const root = new URL('../', import.meta.url)
const source = JSON.parse(await readFile(new URL('source/provenance.json', root), 'utf8'))
const original = JSON.parse(await readFile(new URL('source/upstream-resources.json', root), 'utf8'))
for (const file of source.files) {
  const bytes = await readFile(new URL(`source/${file.path}`, root))
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Pinned source changed: ${file.path}`)
}
const scriptlets = builtinScriptlets.map(entry => ({
  name: entry.name, aliases: entry.aliases ?? [], body: entry.fn.toString(),
  dependencies: entry.dependencies ?? [], ...(entry.world ? { executionWorld: entry.world } : {}), requiresTrust: entry.requiresTrust === true
}))
const redirects = []
for (const entry of original.redirects) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name)) throw new Error('Invalid resource name')
  // Synthetic MIME stubs are fully represented by their included JSON source.
  // Every executable surrogate comes directly from the pinned original source.
  const file = source.files.find(file => file.path === `src/web_accessible_resources/${entry.name}`)
  if (!file && entry.name.endsWith('.js') && !entry.name.startsWith('MIME_TYPE_STUB.')) throw new Error(`Missing source: ${entry.name}`)
  const bytes = file ? await readFile(new URL(`source/${file.path}`, root)) : undefined
  redirects.push({ ...entry, body: bytes ? bytes.toString(entry.contentType.includes(';base64') ? 'base64' : 'utf8') : entry.body })
}
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'))
for (const trusted of [false, true]) {
  const name = trusted ? 'resources-trusted.json' : 'resources-safe.json'
  const selected = scriptlets.filter(entry => trusted || !entry.requiresTrust)
  // Parsing also validates every dependency and alias, including the safe closure.
  const bytes = Buffer.from(JSON.stringify({ scriptlets: selected, redirects: trusted ? [] : redirects }) + '\n')
  Resources.parse(bytes.toString(), { checksum: 'source-check' })
  if (process.argv.includes('--check')) {
    if (!bytes.equals(await readFile(new URL(name, root)))) throw new Error(`Resource source does not reproduce ${name}`)
  } else {
    await writeFile(new URL(name, root), bytes)
    provenance.files = provenance.files.filter(entry => entry.name !== name && entry.name !== 'resources.json')
    provenance.files.push({ name, license: 'GPL-3.0', url: `${source.repository}/tree/${source.commit}`, generatedBy: 'source/compile-adblock-resources.mjs', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
}
if (!process.argv.includes('--check')) await writeFile(new URL('provenance.json', root), JSON.stringify(provenance, null, 2) + '\n')
console.log(`Reproduced ${scriptlets.length} scriptlets and ${redirects.length} redirects from uBlock Origin ${source.tag}.`)
