import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface RuntimeFileRecord {
  path: string
  sha256: string
  size: number
}

interface RuntimeManifest {
  schemaVersion: 4
  moduleId: string
  moduleVersion: string
  hostApi: number
  runtimeVersion: string
  executable: RuntimeFileRecord
  ffmpeg: RuntimeFileRecord
  ffprobe: RuntimeFileRecord
  ffmpegProvenance: RuntimeFileRecord
  ffmpegCapabilities: RuntimeFileRecord
  ffmpegSourceBundle: {
    fileName: 'ffmpeg-corresponding-source-win64.tar.zst'
    sha256: string
    size: number
  }
  browser: {
    engine: 'chromium'
    distribution: 'playwright-chromium'
    headlessMode: 'new'
    executable: RuntimeFileRecord
  }
  playwrightBrowsersPath: string
  files: RuntimeFileRecord[]
}

export interface AvidaeRuntime {
  executable: string
  ffmpeg: string
  ffprobe: string
  playwrightBrowsersPath: string
  chromiumExecutable: string
  root: string
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
  if (!record || typeof record !== 'object') throw new Error(`Video & Audio ${label} metadata is missing.`)
  const value = record as Partial<RuntimeFileRecord>
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    throw new Error(`Video & Audio ${label} digest is invalid.`)
  }
  const file = resolveRuntimePath(root, value.path)
  if (!existsSync(file)) throw new Error(`Video & Audio ${label} is missing.`)
  const fileStat = await stat(file)
  if (!fileStat.isFile() || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 1 || fileStat.size !== value.size) {
    throw new Error(`Video & Audio ${label} size is invalid.`)
  }
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  const digest = hash.digest('hex')
  if (digest !== value.sha256) throw new Error(`Video & Audio ${label} failed its integrity check.`)
  return file
}

// Cheap completeness check over the whole inventory. Archive installation
// already hashed every byte; before each launch the executables are hashed
// again and every other file must still exist with its recorded size.
async function verifyInventoryPresence(root: string, files: unknown): Promise<void> {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Video & Audio runtime inventory is missing.')
  const queue = [...files] as Partial<RuntimeFileRecord>[]
  const workers = Array.from({ length: 16 }, async () => {
    for (let record = queue.pop(); record; record = queue.pop()) {
      const file = resolveRuntimePath(root, record.path)
      const fileStat = await stat(file).catch(() => undefined)
      if (!fileStat?.isFile() || fileStat.size !== record.size) throw new Error(`Video & Audio runtime file is missing or changed: ${record.path}`)
    }
  })
  await Promise.all(workers)
}

export async function verifyAvidaeRuntime(runtimeRoot: string, expected: { moduleVersion: string; hostApi: number }): Promise<AvidaeRuntime> {
  const root = path.resolve(runtimeRoot)
  const manifestPath = path.join(root, 'runtime-manifest.json')
  let manifest: RuntimeManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
  } catch {
    throw new Error('Video & Audio runtime manifest is missing or invalid.')
  }
  if (manifest.schemaVersion !== 4 || typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion) {
    throw new Error('Video & Audio runtime manifest is unsupported.')
  }
  if (manifest.moduleVersion !== expected.moduleVersion || manifest.hostApi !== expected.hostApi) {
    throw new Error('Video & Audio runtime does not match its installation record.')
  }
  await verifyInventoryPresence(root, manifest.files)
  if (manifest.browser?.engine !== 'chromium' || manifest.browser?.distribution !== 'playwright-chromium' || manifest.browser?.headlessMode !== 'new') {
    throw new Error('Video & Audio browser policy is unsupported.')
  }

  const [executable, ffmpeg, ffprobe, ffmpegProvenance, , chromiumExecutable] = await Promise.all([
    verifyFile(root, manifest.executable, 'Video & Audio executable'),
    verifyFile(root, manifest.ffmpeg, 'FFmpeg'),
    verifyFile(root, manifest.ffprobe, 'FFprobe'),
    verifyFile(root, manifest.ffmpegProvenance, 'FFmpeg provenance'),
    verifyFile(root, manifest.ffmpegCapabilities, 'FFmpeg capability report'),
    verifyFile(root, manifest.browser.executable, 'Chromium')
  ])
  if (manifest.ffmpegSourceBundle?.fileName !== 'ffmpeg-corresponding-source-win64.tar.zst' ||
      !SHA256_PATTERN.test(String(manifest.ffmpegSourceBundle?.sha256 || '')) ||
      !Number.isSafeInteger(manifest.ffmpegSourceBundle?.size) || manifest.ffmpegSourceBundle.size < 1) {
    throw new Error('FFmpeg corresponding-source metadata is invalid.')
  }
  let provenance: { licenseMode?: string; ffmpeg?: RuntimeFileRecord; ffprobe?: RuntimeFileRecord; capabilityReport?: RuntimeFileRecord; sourceBundle?: { sha256?: string; size?: number } }
  try {
    provenance = JSON.parse(await readFile(ffmpegProvenance, 'utf8')) as typeof provenance
  } catch {
    throw new Error('FFmpeg provenance is invalid.')
  }
  if (provenance.licenseMode !== 'gpl-3.0-or-later' ||
      provenance.ffmpeg?.sha256 !== manifest.ffmpeg.sha256 ||
      provenance.ffprobe?.sha256 !== manifest.ffprobe.sha256 ||
      provenance.capabilityReport?.sha256 !== manifest.ffmpegCapabilities.sha256 ||
      provenance.capabilityReport?.size !== manifest.ffmpegCapabilities.size ||
      provenance.sourceBundle?.sha256 !== manifest.ffmpegSourceBundle.sha256 ||
      provenance.sourceBundle?.size !== manifest.ffmpegSourceBundle.size) {
    throw new Error('FFmpeg provenance does not match its runtime manifest.')
  }
  const playwrightBrowsersPath = resolveRuntimePath(root, manifest.playwrightBrowsersPath)
  if (!existsSync(playwrightBrowsersPath) || !(await stat(playwrightBrowsersPath)).isDirectory()) throw new Error('Playwright browser directory is missing.')
  if (!chromiumExecutable.startsWith(`${playwrightBrowsersPath}${path.sep}`)) throw new Error('Chromium is outside the Playwright browser directory.')
  return {
    executable,
    ffmpeg,
    ffprobe,
    playwrightBrowsersPath,
    chromiumExecutable,
    root,
    label: `Video & Audio module ${manifest.moduleVersion} (${manifest.runtimeVersion})`
  }
}
