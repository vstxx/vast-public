// Run with: node --experimental-transform-types scripts/verify-translator-package.mjs
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'
import { parseCreateExtension, validatePublisherPackage } from '../extensions-hub/src/validation.ts'

const archive = resolve('artifacts/Translator-for-Vast-1.0.0.vext')
const dist = resolve('resources/first-party-extensions/translator-for-vast/dist')
const id = 'oaamgecaoemplhkceohcpahaeampndpj'
const publisher = 'publisher_7b1e2c9f4a806d3e5b709c12'
const summary = await validatePublisherPackage(new Uint8Array(await readFile(archive)), id, publisher)
const listing = parseCreateExtension(JSON.parse(await readFile(resolve('artifacts/Translator-for-Vast-Hub-listing.json'), 'utf8')))
assert.equal(listing.extensionId, id)
assert.equal(listing.dataPractice, 'local-only')
const files = []
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name)
    if (entry.isDirectory()) await walk(absolute)
    else if (entry.isFile()) files.push(relative(dist, absolute).split(sep).join('/'))
    else throw new Error(`Unexpected entry: ${absolute}`)
  }
}
await walk(dist)
assert.deepEqual([...summary.parsed.files.keys()].sort(), files.sort(), 'Package inventory differs from dist')
for (const [name, content] of summary.parsed.files) {
  assert(Buffer.from(content).equals(await readFile(resolve(dist, name))), `Stale package file: ${name}`)
}
console.log(`Translator package valid: ${files.length} files, ${summary.parsed.metadata.version}, ${listing.slug}`)
