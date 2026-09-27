import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createVextPackage, parseVextPackage, sha256Hex } from '../src/shared/vext-format.ts'
import { validatePublisherPackage } from '../extensions-hub/src/validation.ts'

const publisherId = 'publisher_7b1e2c9f4a806d3e5b709c12'
const packages = [
  { file: 'Bitwarden-2026.8.0.vext', id: 'nngceckbapebfimnlniiiahkandclblb', version: '2026.8.0', commit: 'f60a4606b7581c338d18091a98640ee71392f015' },
  { file: 'Proton-Pass-1.40.2.vext', id: 'ghmbeldphafepmbegfdlkpapadhbakde', version: '1.40.2', commit: '3dd430f4de8ad38e23a70dd39e9861973f9abfd7' }
]

for (const expected of packages) {
  const bytes = new Uint8Array(await readFile(resolve('artifacts', expected.file)))
  const parsed = await parseVextPackage(bytes)
  if (parsed.metadata.extension_id !== expected.id || parsed.metadata.version !== expected.version || parsed.metadata.publisher_id !== publisherId) throw new Error(`${expected.file}: package identity is invalid.`)
  const manifest = JSON.parse(new TextDecoder().decode(parsed.files.get('manifest.json'))) as { key?: string }
  if (!manifest.key || !/^[A-Za-z0-9+/]+=*$/.test(manifest.key)) throw new Error(`${expected.file}: upstream manifest key is missing.`)
  const provenance = JSON.parse(new TextDecoder().decode(parsed.files.get('VAST-UPSTREAM-PROVENANCE.json'))) as Record<string, unknown>
  if (provenance.upstreamExtensionId !== expected.id || provenance.upstreamVersion !== expected.version || provenance.upstreamSourceCommit !== expected.commit || provenance.license !== 'GPL-3.0-only') throw new Error(`${expected.file}: provenance is invalid.`)
  if (!parsed.files.has('LICENSE-GPL-3.0.txt')) throw new Error(`${expected.file}: GPL license is missing.`)
  const summary = await validatePublisherPackage(bytes, expected.id, publisherId)
  if (summary.version !== expected.version || summary.kind !== 'chrome') throw new Error(`${expected.file}: Hub validation is inconsistent.`)
  process.stdout.write(`${expected.file} sha256=${await sha256Hex(bytes)} files=${parsed.files.size} validation=${summary.validation.join(',')}\n`)
  const changedFiles = new Map(parsed.files)
  changedFiles.set('VAST-UPSTREAM-PROVENANCE.json', new TextEncoder().encode('{}\n'))
  const changed = await createVextPackage({ extensionId: expected.id, version: expected.version, publisherId, files: changedFiles })
  let rejected = false
  try { await validatePublisherPackage(changed, expected.id, publisherId) } catch (error) {
    rejected = error instanceof Error && /Static policy validation failed/.test(error.message)
  }
  if (!rejected) throw new Error(`${expected.file}: a byte-modified package bypassed the curated hash gate.`)
  process.stdout.write(`${expected.file} modified-hash rejection=static-policy\n`)
}
