import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

interface RuntimeFileRecord {
  path: string
  sha256: string
  size: number
}

interface RuntimeManifest {
  schemaVersion: 3
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
}

export interface BundledAvidaeRuntime {
  executable: string
  ffmpeg: string
  ffprobe: string
  playwrightBrowsersPath: string
  chromiumExecutable: string
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
  const fileStat = await stat(file)
  if (!fileStat.isFile() || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 1 || fileStat.size !== value.size) {
    throw new Error(`Bundled ${label} size is invalid.`)
  }
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
  if (manifest.schemaVersion !== 3 || typeof manifest.runtimeVersion !== 'string' || !manifest.runtimeVersion) {
    throw new Error('Bundled Video & Audio runtime manifest is unsupported.')
  }
  if (manifest.browser?.engine !== 'chromium' || manifest.browser?.distribution !== 'playwright-chromium' || manifest.browser?.headlessMode !== 'new') {
    throw new Error('Bundled Video & Audio browser policy is unsupported.')
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
    throw new Error('Bundled FFmpeg corresponding-source metadata is invalid.')
  }
  let provenance: { licenseMode?: string; ffmpeg?: RuntimeFileRecord; ffprobe?: RuntimeFileRecord; capabilityReport?: RuntimeFileRecord; sourceBundle?: { sha256?: string; size?: number } }
  try {
    provenance = JSON.parse(await readFile(ffmpegProvenance, 'utf8')) as typeof provenance
  } catch {
    throw new Error('Bundled FFmpeg provenance is invalid.')
  }
  if (provenance.licenseMode !== 'gpl-3.0-or-later' ||
      provenance.ffmpeg?.sha256 !== manifest.ffmpeg.sha256 ||
      provenance.ffprobe?.sha256 !== manifest.ffprobe.sha256 ||
      provenance.capabilityReport?.sha256 !== manifest.ffmpegCapabilities.sha256 ||
      provenance.capabilityReport?.size !== manifest.ffmpegCapabilities.size ||
      provenance.sourceBundle?.sha256 !== manifest.ffmpegSourceBundle.sha256 ||
      provenance.sourceBundle?.size !== manifest.ffmpegSourceBundle.size) {
    throw new Error('Bundled FFmpeg provenance does not match its runtime manifest.')
  }
  const playwrightBrowsersPath = resolveRuntimePath(root, manifest.playwrightBrowsersPath)
  if (!existsSync(playwrightBrowsersPath) || !(await stat(playwrightBrowsersPath)).isDirectory()) throw new Error('Bundled Playwright browser directory is missing.')
  if (!chromiumExecutable.startsWith(`${playwrightBrowsersPath}${path.sep}`)) throw new Error('Bundled Chromium is outside the Playwright browser directory.')
  if ((await readdir(playwrightBrowsersPath, { withFileTypes: true })).some((entry) => entry.isDirectory() && /^chromium_headless_shell-\d+$/i.test(entry.name))) {
    throw new Error('Bundled Playwright runtime contains a redundant headless shell.')
  }

  return {
    executable,
    ffmpeg,
    ffprobe,
    playwrightBrowsersPath,
    chromiumExecutable,
    label: `Bundled runtime ${manifest.runtimeVersion}`
  }
}
