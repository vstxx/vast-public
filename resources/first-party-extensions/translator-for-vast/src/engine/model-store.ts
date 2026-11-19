// Downloads, verifies, stores and removes language models. Model lifecycle ideas follow Glossa
// src/engine/model-store.ts (MIT, SysAdminDoc); the trust model differs: hashes, sizes and paths come
// only from the packaged catalog, never from a catalog fetched at runtime.
//
// Every download:
// - goes to one HTTPS bucket (connect-src in the manifest allows no other host), without cookies,
//   referrer or redirects;
// - is streamed: the compressed bytes are counted and refused past the catalog size, decompressed
//   into a buffer of exactly the expected size, and refused if they would overflow it;
// - is hashed (SHA-256) before it is stored, and a pair is recorded as installed only after every
//   file is verified and durably written. Model bytes are data handed to Bergamot, never code.

import { ENGINE_RELEASE, MODEL_MAJOR, modelUrl, pairDiskBytes, pairDownloadBytes, pairKey, type CatalogFile, type CatalogPair, type ModelFileType } from '../shared/catalog.ts'
import type { DownloadProgress, InstalledPair } from '../shared/protocol.ts'

const MODELS = 'tfv-models-v1'
const META = 'tfv-meta-v1'
// Cache keys must be http(s) URLs. A reserved .invalid host can never collide with a real origin.
const KEY_ORIGIN = 'https://store.translator.invalid'
const INSTALLED_KEY = `${KEY_ORIGIN}/meta/installed`
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 600
const STORAGE_HEADROOM = 1.5
const PROGRESS_STEP = 256 * 1024

interface InstalledEntry {
  pairKey: string
  source: string
  target: string
  version: string
  engineRelease: string
  modelMajor: number
  files: Partial<Record<ModelFileType, string>>
  bytes: number
  installedAt: number
}

export class ModelError extends Error {
  constructor(message: string, readonly code: 'cancelled' | 'network' | 'integrity' | 'storage' | 'missing') {
    super(message)
    this.name = 'ModelError'
  }
}

export type PairBytes = Partial<Record<ModelFileType, ArrayBuffer>>

function fileKey(file: CatalogFile): string {
  return `${KEY_ORIGIN}/models/${file.sha256}`
}

async function sha256(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let out = ''
  for (const byte of digest) out += byte.toString(16).padStart(2, '0')
  return out
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new ModelError('Download cancelled', 'cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class ModelStore {
  private readonly downloads = new Map<string, { promise: Promise<void>; controller: AbortController; loaded: number; total: number }>()
  private persistenceAsked = false

  constructor(private readonly onProgress: (progress: DownloadProgress) => void) {}

  get activeDownloads(): number {
    return this.downloads.size
  }

  downloadState(): DownloadProgress[] {
    return [...this.downloads].map(([key, entry]) => ({ pairKey: key, loadedBytes: entry.loaded, totalBytes: entry.total, phase: 'download' }))
  }

  private async manifest(): Promise<Record<string, InstalledEntry>> {
    const hit = await (await caches.open(META)).match(INSTALLED_KEY)
    if (!hit) return {}
    try {
      const value = await hit.json() as unknown
      return value && typeof value === 'object' ? value as Record<string, InstalledEntry> : {}
    } catch {
      return {}
    }
  }

  private async writeManifest(value: Record<string, InstalledEntry>): Promise<void> {
    await (await caches.open(META)).put(INSTALLED_KEY, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }))
  }

  // Installed means: recorded for this engine generation, recorded with the catalog's own hashes,
  // and every file present. A record is a claim; the cache is the proof.
  async isInstalled(pair: CatalogPair): Promise<boolean> {
    const entry = (await this.manifest())[pairKey(pair.source, pair.target)]
    if (!entry || !this.current(entry, pair)) return false
    const cache = await caches.open(MODELS)
    for (const file of Object.values(pair.files)) {
      if (!file || !await cache.match(fileKey(file))) return false
    }
    return true
  }

  private current(entry: InstalledEntry, pair: CatalogPair): boolean {
    if (entry.engineRelease !== ENGINE_RELEASE || entry.modelMajor !== MODEL_MAJOR || entry.version !== pair.version) return false
    const wanted = Object.entries(pair.files).map(([type, file]) => `${type}:${file?.sha256}`).sort()
    const have = Object.entries(entry.files).map(([type, sha]) => `${type}:${sha}`).sort()
    return wanted.length === have.length && wanted.every((value, index) => value === have[index])
  }

  async listInstalled(pairs: Record<string, CatalogPair>): Promise<InstalledPair[]> {
    const manifest = await this.manifest()
    const out: InstalledPair[] = []
    for (const entry of Object.values(manifest)) {
      const pair = pairs[entry.pairKey]
      if (!pair || !await this.isInstalled(pair)) continue
      out.push({ pairKey: entry.pairKey, source: entry.source, target: entry.target, version: entry.version, bytes: entry.bytes, installedAt: entry.installedAt })
    }
    return out.sort((a, b) => a.pairKey.localeCompare(b.pairKey))
  }

  // Reads an installed pair for the engine. Sizes and hashes are checked again: a file damaged on
  // disk is removed and reported, never handed to the engine.
  async read(pair: CatalogPair): Promise<PairBytes> {
    const cache = await caches.open(MODELS)
    const out: PairBytes = {}
    for (const [type, file] of Object.entries(pair.files) as Array<[ModelFileType, CatalogFile]>) {
      const hit = await cache.match(fileKey(file))
      if (!hit) throw new ModelError(`${file.name} is not installed`, 'missing')
      const buffer = await hit.arrayBuffer()
      if (buffer.byteLength !== file.bytes || await sha256(buffer) !== file.sha256) {
        await this.deletePair(pairKey(pair.source, pair.target), pair)
        throw new ModelError(`${file.name} failed verification and was removed. Download the language again.`, 'integrity')
      }
      out[type] = buffer
    }
    return out
  }

  // One download per pair however many callers ask; a second caller joins the first.
  download(pair: CatalogPair): Promise<void> {
    const key = pairKey(pair.source, pair.target)
    const running = this.downloads.get(key)
    if (running) return running.promise
    const controller = new AbortController()
    const entry = { controller, loaded: 0, total: pairDownloadBytes(pair), promise: Promise.resolve() }
    entry.promise = this.downloadPair(pair, key, controller.signal, (loaded) => {
      entry.loaded = loaded
    }).then(
      () => this.onProgress({ pairKey: key, loadedBytes: entry.total, totalBytes: entry.total, phase: 'done' }),
      (error: unknown) => {
        const cancelled = error instanceof ModelError && error.code === 'cancelled'
        this.onProgress({ pairKey: key, loadedBytes: entry.loaded, totalBytes: entry.total, phase: cancelled ? 'cancelled' : 'error', error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    ).finally(() => this.downloads.delete(key))
    this.downloads.set(key, entry)
    return entry.promise
  }

  cancel(key: string): boolean {
    const entry = this.downloads.get(key)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  private async downloadPair(pair: CatalogPair, key: string, signal: AbortSignal, loaded: (bytes: number) => void): Promise<void> {
    const total = pairDownloadBytes(pair)
    await this.assertRoom(pairDiskBytes(pair))
    this.askForPersistence()
    const cache = await caches.open(MODELS)
    let before = 0
    for (const file of Object.values(pair.files) as CatalogFile[]) {
      const existing = await cache.match(fileKey(file))
      if (existing && Number(existing.headers.get('content-length')) === file.bytes) {
        before += file.gzipBytes
        continue
      }
      let lastReport = 0
      const bytes = await this.fetchVerified(file, signal, (received) => {
        loaded(before + received)
        if (received - lastReport >= PROGRESS_STEP) {
          lastReport = received
          this.onProgress({ pairKey: key, loadedBytes: before + received, totalBytes: total, phase: 'download' })
        }
      })
      this.onProgress({ pairKey: key, loadedBytes: before + file.gzipBytes, totalBytes: total, phase: 'store' })
      try {
        await cache.put(fileKey(file), new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) } }))
      } catch (error) {
        throw new ModelError(`Could not store ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'storage')
      }
      before += file.gzipBytes
    }
    if (signal.aborted) throw new ModelError('Download cancelled', 'cancelled')
    const manifest = await this.manifest()
    manifest[key] = {
      pairKey: key,
      source: pair.source,
      target: pair.target,
      version: pair.version,
      engineRelease: ENGINE_RELEASE,
      modelMajor: MODEL_MAJOR,
      files: Object.fromEntries(Object.entries(pair.files).map(([type, file]) => [type, file!.sha256])),
      bytes: pairDiskBytes(pair),
      installedAt: Date.now()
    }
    await this.writeManifest(manifest)
  }

  private async fetchVerified(file: CatalogFile, signal: AbortSignal, onBytes: (received: number) => void): Promise<Uint8Array<ArrayBuffer>> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new ModelError('Download cancelled', 'cancelled')
      try {
        return await this.fetchOnce(file, signal, onBytes)
      } catch (error) {
        lastError = error
        if (signal.aborted) throw new ModelError('Download cancelled', 'cancelled')
        // Wrong bytes do not become right on a second try.
        if (error instanceof ModelError && error.code === 'integrity') throw error
        if (attempt < MAX_ATTEMPTS - 1) await wait(RETRY_BASE_MS * 2 ** attempt, signal)
      }
    }
    throw lastError instanceof ModelError ? lastError : new ModelError(`Download of ${file.name} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, 'network')
  }

  private async fetchOnce(file: CatalogFile, signal: AbortSignal, onBytes: (received: number) => void): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(modelUrl(file), { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    if (!response.ok || !response.body) throw new ModelError(`Model server answered HTTP ${response.status}`, 'network')
    const declared = Number(response.headers.get('content-length'))
    if (declared > 0 && declared !== file.gzipBytes) throw new ModelError(`${file.name} has an unexpected size`, 'integrity')
    let received = 0
    const counted = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength
        if (received > file.gzipBytes) {
          controller.error(new ModelError(`${file.name} is larger than published`, 'integrity'))
          return
        }
        onBytes(received)
        controller.enqueue(chunk)
      }
    })
    const output = new Uint8Array(new ArrayBuffer(file.bytes))
    let written = 0
    const reader = response.body.pipeThrough(counted).pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (written + value.byteLength > file.bytes) throw new ModelError(`${file.name} expands past its published size`, 'integrity')
        output.set(value, written)
        written += value.byteLength
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined)
      if (error instanceof ModelError) throw error
      if (signal.aborted) throw new ModelError('Download cancelled', 'cancelled')
      // A truncated stream fails inside the decompressor; that is a network failure to retry.
      throw new ModelError(`Download of ${file.name} was interrupted`, 'network')
    }
    if (received !== file.gzipBytes) throw new ModelError(`Download of ${file.name} was interrupted`, 'network')
    if (written !== file.bytes || await sha256(output) !== file.sha256) throw new ModelError(`${file.name} failed its integrity check`, 'integrity')
    return output
  }

  async deletePair(key: string, pair?: CatalogPair): Promise<boolean> {
    this.cancel(key)
    const manifest = await this.manifest()
    const entry = manifest[key]
    const cache = await caches.open(MODELS)
    const shas = new Set([...Object.values(entry?.files ?? {}), ...Object.values(pair?.files ?? {}).map((file) => file!.sha256)])
    // A file another installed pair still references stays (pairs never share files today, but the
    // catalog does not promise that).
    for (const [other, value] of Object.entries(manifest)) {
      if (other === key) continue
      for (const sha of Object.values(value.files)) shas.delete(sha)
    }
    for (const sha of shas) await cache.delete(`${KEY_ORIGIN}/models/${sha}`)
    if (!entry) return false
    delete manifest[key]
    await this.writeManifest(manifest)
    return true
  }

  async deleteAll(): Promise<void> {
    for (const entry of this.downloads.values()) entry.controller.abort()
    await caches.delete(MODELS)
    await caches.delete(META)
  }

  async usage(): Promise<{ usage: number | null; quota: number | null }> {
    try {
      const estimate = await navigator.storage.estimate()
      return { usage: estimate.usage ?? null, quota: estimate.quota ?? null }
    } catch {
      return { usage: null, quota: null }
    }
  }

  private askForPersistence(): void {
    if (this.persistenceAsked) return
    this.persistenceAsked = true
    void navigator.storage?.persist?.().catch(() => false)
  }

  private async assertRoom(bytes: number): Promise<void> {
    const { usage, quota } = await this.usage()
    if (usage === null || quota === null) return
    if (quota - usage < bytes * STORAGE_HEADROOM) {
      throw new ModelError(`Not enough free storage: this language needs about ${Math.ceil(bytes * STORAGE_HEADROOM / 1e6)} MB.`, 'storage')
    }
  }
}
