// The packaged model catalog (catalog/models.json, produced by tools/refresh-catalog.mjs). It is the
// only source of model hashes, sizes and download paths: nothing about a model is read from the
// network before its bytes are verified against this file.

export type ModelFileType = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab'

export interface CatalogFile {
  name: string
  path: string
  gzipBytes: number
  bytes: number
  sha256: string
}

export interface CatalogPair {
  source: string
  target: string
  version: string
  architecture: string | null
  files: Partial<Record<ModelFileType, CatalogFile>>
  comet22?: number
}

export interface Catalog {
  schema: 1
  modelMajor: number
  pairs: Record<string, CatalogPair>
}

// The engine and model generations this package runs. A stored model installed for another
// generation counts as not installed and is downloaded again.
export const ENGINE_RELEASE = '4.0'
export const MODEL_MAJOR = 3
export const PIVOT_LANGUAGE = 'en'

// Model bytes come from this bucket and nowhere else. The manifest's connect-src allows only this
// host, so even a bug here cannot reach another origin.
export const MODEL_BUCKET = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/'

// Hard ceilings well above the largest published file, so a corrupted catalog entry cannot ask for
// an unbounded download or allocation.
export const MAX_FILE_BYTES = 128 * 1024 * 1024
export const MAX_PAIR_BYTES = 192 * 1024 * 1024

const LANGUAGE = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?$/
const PATH = /^models\/[A-Za-z0-9-]{2,24}\/[A-Za-z0-9_-]{1,128}\/exported\/[A-Za-z0-9._-]{1,128}\.gz$/
const NAME = /^[A-Za-z0-9._-]{1,128}$/
const SHA = /^[a-f0-9]{64}$/
const TYPES: readonly ModelFileType[] = ['model', 'lex', 'vocab', 'srcvocab', 'trgvocab']

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function size(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max
}

export function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE.test(value)
}

// Validates the whole snapshot once. Anything unexpected rejects the catalog rather than one
// entry: a catalog that is partly wrong is not one to trust partly.
export function parseCatalog(value: unknown): Catalog {
  if (!record(value) || value.schema !== 1 || value.modelMajor !== MODEL_MAJOR || !record(value.pairs)) throw new Error('Model catalog is invalid.')
  const pairs: Record<string, CatalogPair> = {}
  for (const [key, raw] of Object.entries(value.pairs)) {
    if (!record(raw) || !isLanguageCode(raw.source) || !isLanguageCode(raw.target) || raw.source === raw.target) throw new Error(`Catalog entry ${key} is invalid.`)
    if (key !== `${raw.source}-${raw.target}` || raw.source !== PIVOT_LANGUAGE && raw.target !== PIVOT_LANGUAGE) throw new Error(`Catalog entry ${key} is invalid.`)
    if (typeof raw.version !== 'string' || !new RegExp(`^${MODEL_MAJOR}\\.\\d+$`).test(raw.version) || !record(raw.files)) throw new Error(`Catalog entry ${key} is invalid.`)
    const files: Partial<Record<ModelFileType, CatalogFile>> = {}
    let total = 0
    for (const [type, file] of Object.entries(raw.files)) {
      if (!TYPES.includes(type as ModelFileType) || !record(file)) throw new Error(`Catalog entry ${key} is invalid.`)
      if (typeof file.name !== 'string' || !NAME.test(file.name) || typeof file.path !== 'string' || !PATH.test(file.path) || typeof file.sha256 !== 'string' || !SHA.test(file.sha256)) throw new Error(`Catalog entry ${key} is invalid.`)
      if (!size(file.bytes, MAX_FILE_BYTES) || !size(file.gzipBytes, MAX_FILE_BYTES)) throw new Error(`Catalog entry ${key} is invalid.`)
      total += file.bytes
      files[type as ModelFileType] = { name: file.name, path: file.path, gzipBytes: file.gzipBytes, bytes: file.bytes, sha256: file.sha256 }
    }
    const vocab = Boolean(files.vocab) || Boolean(files.srcvocab && files.trgvocab)
    if (!files.model || !vocab || total > MAX_PAIR_BYTES) throw new Error(`Catalog entry ${key} is invalid.`)
    pairs[key] = {
      source: raw.source,
      target: raw.target,
      version: raw.version,
      architecture: typeof raw.architecture === 'string' ? raw.architecture : null,
      files,
      ...(typeof raw.comet22 === 'number' ? { comet22: raw.comet22 } : {})
    }
  }
  return { schema: 1, modelMajor: MODEL_MAJOR, pairs }
}

export function pairKey(source: string, target: string): string {
  return `${source}-${target}`
}

// A direct model when one exists, otherwise two hops through English. Null when the catalog cannot
// serve the direction at all, which is how pickers avoid offering it.
export function planRoute(catalog: Catalog, source: string, target: string): CatalogPair[] | null {
  if (source === target) return null
  const direct = catalog.pairs[pairKey(source, target)]
  if (direct) return [direct]
  if (source === PIVOT_LANGUAGE || target === PIVOT_LANGUAGE) return null
  const first = catalog.pairs[pairKey(source, PIVOT_LANGUAGE)]
  const second = catalog.pairs[pairKey(PIVOT_LANGUAGE, target)]
  return first && second ? [first, second] : null
}

export function pairDownloadBytes(pair: CatalogPair): number {
  return Object.values(pair.files).reduce((sum, file) => sum + (file?.gzipBytes ?? 0), 0)
}

export function pairDiskBytes(pair: CatalogPair): number {
  return Object.values(pair.files).reduce((sum, file) => sum + (file?.bytes ?? 0), 0)
}

export function catalogLanguages(catalog: Catalog): { sources: string[]; targets: string[] } {
  const sources = new Set<string>([PIVOT_LANGUAGE])
  const targets = new Set<string>([PIVOT_LANGUAGE])
  for (const pair of Object.values(catalog.pairs)) {
    sources.add(pair.source)
    targets.add(pair.target)
  }
  return { sources: [...sources].sort(), targets: [...targets].sort() }
}

export function modelUrl(file: CatalogFile): string {
  // The path is validated by parseCatalog; resolving against the bucket can only stay on it.
  const url = new URL(file.path, MODEL_BUCKET)
  if (!url.href.startsWith(MODEL_BUCKET)) throw new Error('Model path leaves the model bucket.')
  return url.href
}
