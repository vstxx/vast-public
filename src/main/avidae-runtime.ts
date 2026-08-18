import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface RuntimeFileRecord {
  path: string
  sha256: string
}

interface RuntimeManifest {
  schemaVersion: 1
  runtimeVersion: string
  executable: RuntimeFileRecord
  ffmpeg: RuntimeFileRecord
  ffprobe: RuntimeFileRecord
  chromium: RuntimeFileRecord
  playwrightBrowsersPath: string
}

export interface BundledAvidaeRuntime {
  executable: string
  ffmpeg: string
  ffprobe: string
  playwrightBrowsersPath: string
  label: string
}

function resolveRuntimePath(root: string, relativePath: unknown): string {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) {
    throw new Error('Video & Audio runtime manifest contains an invalid path.')
  }
  const segments = relativePath.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Video & Audio runtime manifest contains an unsafe path.')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...segments)
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Video & Audio runtime path escapes its bundle.')
  }
  return resolved
}

async function verifyFile(root: string, record: unknown, label: string): Promise<string> {
  if (!record || typeof record !== 'object') throw new Error(`Bundled ${label} metadata is missing.`)
  const value = record as Partial<RuntimeFileRecord>
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`Bundled ${label} digest is invalid.`)
  }
  const file = resolveRuntimePath(root, value.path)
  if (!existsSync(file)) throw new Error(`Bundled ${label} is missing.`)
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  const digest = hash.digest('hex')
  if (digest !== value.sha256) throw new Error(`Bundled ${label} failed its integrity check.`)
  return file
}

export async function verifyBundledAvidaeRuntime(resourcesPath: string): Promise<BundledAvidaeRuntime> {
  const root = path.resolve(resourcesPath, 'avidae-runtime')
  const manifestPath = path.join(root, 'runtime-manifest.json')
  let manifest: RuntimeManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
  } catch {
    throw new Error('Bundled Video & Audio runtime manifest is missing or invalid.')
  }
  if (manifest.schemaVersion !== 1 || typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion) {
    throw new Error('Bundled Video & Audio runtime manifest is unsupported.')
  }

  const [executable, ffmpeg, ffprobe] = await Promise.all([
    verifyFile(root, manifest.executable, 'Video & Audio executable'),
    verifyFile(root, manifest.ffmpeg, 'FFmpeg'),
    verifyFile(root, manifest.ffprobe, 'FFprobe'),
    verifyFile(root, manifest.chromium, 'Chromium')
  ])
  const playwrightBrowsersPath = resolveRuntimePath(root, manifest.playwrightBrowsersPath)
  if (!existsSync(playwrightBrowsersPath)) throw new Error('Bundled Playwright browser directory is missing.')

  return {
    executable,
    ffmpeg,
    ffprobe,
    playwrightBrowsersPath,
    label: `Bundled runtime ${manifest.runtimeVersion}`
  }
}
