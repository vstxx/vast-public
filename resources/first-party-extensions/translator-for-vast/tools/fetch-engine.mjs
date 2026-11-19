// Downloads the Bergamot WebAssembly binary pinned in vendor/bergamot/engine.lock.json and writes it
// next to the glue only when the compressed and the decompressed bytes both match the pinned size
// and SHA-256. The binary is executable code: it ships inside the reviewed package and is never
// fetched by the extension at runtime.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendor = resolve(root, 'vendor/bergamot')
const lock = JSON.parse(await readFile(resolve(vendor, 'engine.lock.json'), 'utf8'))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const target = resolve(vendor, lock.wasm.file)

try {
  const existing = await readFile(target)
  if (existing.length === lock.wasm.bytes && sha256(existing) === lock.wasm.sha256) {
    console.log(`engine: ${lock.wasm.file} present and verified`)
    process.exit(0)
  }
} catch {
  // Missing: download below.
}

const response = await fetch(lock.wasm.url, { redirect: 'error' })
if (!response.ok) throw new Error(`Engine download failed: HTTP ${response.status}`)
const compressed = Buffer.from(await response.arrayBuffer())
if (compressed.length !== lock.wasm.zstdBytes || sha256(compressed) !== lock.wasm.zstdSha256) throw new Error('Compressed engine does not match engine.lock.json.')
const wasm = zstdDecompressSync(compressed, { maxOutputLength: lock.wasm.bytes })
if (wasm.length !== lock.wasm.bytes || sha256(wasm) !== lock.wasm.sha256) throw new Error('Decompressed engine does not match engine.lock.json.')
await writeFile(target, wasm)
console.log(`engine: wrote ${lock.wasm.file} (${wasm.length} bytes)`)
