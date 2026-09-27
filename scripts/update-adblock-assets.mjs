// Maintainer-only refresh. Runtime updates use the identical fixed catalog and
// downloader; only reviewed snapshots and hashes are committed to the package.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { get } from 'node:https'
import { LISTS } from '../resources/first-party-extensions/adblocker-for-vast/src/settings.ts'
import { validateList } from '../resources/first-party-extensions/adblocker-for-vast/src/cache.ts'
const root = new URL('../resources/first-party-extensions/adblocker-for-vast/assets/', import.meta.url)
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'))
for (const list of LISTS) {
  // Node's native HTTPS client avoids a Node 24 Undici decompression failure on
  // EasyList. No redirects, credentials, referrer or compressed content requested.
  const bytes = await new Promise((resolve, reject) => {
    const request = get(list.url, { timeout: 30_000, headers: { 'Accept-Encoding': 'identity' } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new Error(`${list.id}: HTTP ${response.statusCode}`)); return }
      let size = 0; const chunks = []
      response.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) response.destroy(new Error('Filter list exceeds 12 MiB')); else chunks.push(chunk) })
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new Error('List download timed out')))
    request.on('error', reject)
  })
  validateList(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  const name = `${list.id}.txt`
  const previous = provenance.files.find(entry => entry.name === name)
  await writeFile(new URL(name, root), bytes)
  provenance.files = provenance.files.filter(entry => entry.name !== name)
  provenance.files.push({ name, url: list.url, license: previous?.license ?? 'GPL-3.0', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  console.log(`${name}: ${bytes.length} bytes`)
}
provenance.preparedAt = new Date().toISOString()
await writeFile(new URL('provenance.json', root), JSON.stringify(provenance, null, 2) + '\n')
