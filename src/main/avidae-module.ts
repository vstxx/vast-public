import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import type { AvidaeModuleErrorCode, AvidaeModuleState, AvidaeModuleStatus } from '../shared/types.ts'
import { extractModuleArchive, ModuleArchiveError } from './avidae-module-archive.ts'
import {
  AVIDAE_MODULE_HOST_API,
  AVIDAE_MODULE_ID,
  ModuleManifestError,
  verifyModuleReleaseManifest,
  type AvidaeModuleReleasePayload,
  type AvidaeModuleTrustedKey
} from './avidae-module-manifest.ts'
import { verifyAvidaeRuntime } from './avidae-runtime.ts'

// Installs the optional Video & Audio runtime outside the browser installation.
//
// <root>/
//   active.json              pointer to the verified, promoted version
//   trust.json               highest accepted manifest sequence (anti-replay)
//   <version>-<digest>/      immutable promoted runtime directories
//   .downloads/<sha>.part    resumable archive download
//   .staging/<random>/       extraction workspace, never executed
//   .install.lock            cross-process installation lock
//
// active.json is written last with an atomic rename, so an interrupted
// download, extraction or promotion can never be reported as ready.

const ACTIVE_FILE = 'active.json'
const TRUST_FILE = 'trust.json'
const LOCK_FILE = '.install.lock'
const DOWNLOADS = '.downloads'
const STAGING = '.staging'
const LOCK_STALE_MS = 6 * 60 * 60 * 1000
const DISK_MARGIN_BYTES = 128 * 1024 * 1024
const PROGRESS_INTERVAL_MS = 200
const MAX_MANIFEST_BYTES = 256 * 1024

export interface AvidaeModuleEnvironment {
  root: string
  manifestUrl?: string
  trustedKeys: readonly AvidaeModuleTrustedKey[]
  // Set when this build must never download the module (for example a
  // distribution channel whose policy has not approved it).
  unavailableReason?: string
  revokedModuleVersions: readonly string[]
  vastVersion: string
  platform: string
  arch: string
  allowLoopbackHttp?: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  isOnline?: () => boolean
  freeBytes?: (directory: string) => Promise<number>
  retryDelaysMs?: readonly number[]
  stallTimeoutMs?: number
  requestTimeoutMs?: number
  now?: () => number
}

interface ActiveRecord {
  schemaVersion: 1
  moduleId: string
  directory: string
  previousDirectory?: string
  moduleVersion: string
  sequence: number
  hostApi: number
  minVastVersion: string
  archiveSha256: string
  runtimeManifestSha256: string
  unpackedSize: number
  keyId: string
  installedAt: string
}

export interface ActiveAvidaeModule {
  root: string
  moduleVersion: string
  hostApi: number
}

export class AvidaeModuleError extends Error {
  readonly code: AvidaeModuleErrorCode

  constructor(code: AvidaeModuleErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

class CancelledError extends Error {}

const messages: Record<AvidaeModuleErrorCode, string> = {
  offline: 'You appear to be offline. Connect to the internet and try again.',
  'not-published': 'The Video & Audio runtime is not available for download right now. Try again later.',
  'disk-space': 'There is not enough free disk space to install Video & Audio.',
  signature: 'The Video & Audio download could not be verified, so nothing was installed.',
  integrity: 'The Video & Audio download was damaged in transit, so nothing was installed. Try again.',
  archive: 'The Video & Audio package is damaged, so nothing was installed.',
  incompatible: 'This Video & Audio runtime is not compatible with this version of Vast. Update Vast and try again.',
  busy: 'Video & Audio is already being installed by another Vast window.',
  unknown: 'Video & Audio could not be installed.'
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isDirectoryName(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,80}-[a-f0-9]{12}$/.test(value)
}

function versionDirectory(payload: AvidaeModuleReleasePayload): string {
  return `${payload.moduleVersion}-${payload.archive.sha256.slice(0, 12)}`
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, file)
}

async function hashFile(file: string, signal: AbortSignal, onBytes: (count: number) => void): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 })
  const abort = (): void => { stream.destroy(new CancelledError()) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      hash.update(chunk)
      onBytes(chunk.length)
    }
  } finally {
    signal.removeEventListener('abort', abort)
  }
  return hash.digest('hex')
}

async function defaultFreeBytes(directory: string): Promise<number> {
  const info = await statfs(directory)
  return Number(info.bavail) * Number(info.bsize)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class AvidaeModuleManager {
  private readonly env: AvidaeModuleEnvironment
  private readonly listeners = new Set<(status: AvidaeModuleStatus) => void>()
  private current: AvidaeModuleStatus = { state: 'checking', canCancel: false }
  private active: ActiveRecord | undefined
  private release: AvidaeModuleReleasePayload | undefined
  private releaseKeyId: string | undefined
  private releaseChecked = false
  private releaseCheckFailedAt = 0
  private availabilityError: { code: AvidaeModuleErrorCode; message: string } | undefined
  // The last installation failure stays visible until the next attempt.
  private installFailure: { code: AvidaeModuleErrorCode; message: string } | undefined
  private refreshPromise: Promise<AvidaeModuleStatus> | undefined
  private installPromise: Promise<AvidaeModuleStatus> | undefined
  private abort: AbortController | undefined
  private lastProgressAt = 0

  constructor(env: AvidaeModuleEnvironment) {
    this.env = env
  }

  status(): AvidaeModuleStatus {
    return { ...this.current }
  }

  onChange(listener: (status: AvidaeModuleStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private now(): number {
    return this.env.now?.() ?? Date.now()
  }

  private lastNotified = ''

  private set(next: AvidaeModuleStatus, progressOnly = false): void {
    this.current = next
    const serialized = JSON.stringify(next)
    if (serialized === this.lastNotified) return
    if (progressOnly) {
      const now = this.now()
      if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return
      this.lastProgressAt = now
    }
    this.lastNotified = serialized
    for (const listener of this.listeners) listener(this.status())
  }

  private baseStatus(): Pick<AvidaeModuleStatus, 'installedVersion' | 'availableVersion' | 'updateAvailable' | 'downloadSize' | 'installedSize'> {
    const release = this.release
    const updateAvailable = Boolean(this.active && release && release.sequence > this.active.sequence &&
      semver.gt(release.moduleVersion, this.active.moduleVersion))
    return {
      installedVersion: this.active?.moduleVersion,
      availableVersion: release?.moduleVersion,
      updateAvailable: updateAvailable || undefined,
      downloadSize: release?.archive.size,
      installedSize: this.active?.unpackedSize ?? release?.archive.unpackedSize
    }
  }

  private revoked(version: string): boolean {
    return this.env.revokedModuleVersions.includes(version) || Boolean(this.release?.revokedModuleVersions.includes(version))
  }

  // Classifies the promoted installation from cached metadata only. Executable
  // integrity is checked separately right before launch.
  private async installedState(): Promise<AvidaeModuleState> {
    const record = await readJson<ActiveRecord>(path.join(this.env.root, ACTIVE_FILE))
    if (!record) {
      this.active = undefined
      return 'not-installed'
    }
    if (record.schemaVersion !== 1 || record.moduleId !== AVIDAE_MODULE_ID || !isDirectoryName(record.directory) ||
        typeof record.moduleVersion !== 'string' || !semver.valid(record.moduleVersion) || !Number.isSafeInteger(record.sequence)) {
      this.active = undefined
      return 'repair-required'
    }
    this.active = record
    const directory = path.join(this.env.root, record.directory)
    const info = await lstat(directory).catch(() => undefined)
    if (!info?.isDirectory() || info.isSymbolicLink()) return 'repair-required'
    const manifest = await stat(path.join(directory, 'runtime-manifest.json')).catch(() => undefined)
    if (!manifest?.isFile()) return 'repair-required'
    if (record.hostApi !== AVIDAE_MODULE_HOST_API || this.revoked(record.moduleVersion)) return 'update-required'
    if (!semver.valid(this.env.vastVersion) || !semver.valid(record.minVastVersion) || semver.lt(this.env.vastVersion, record.minVastVersion)) {
      return 'incompatible'
    }
    return 'ready'
  }

  private async fetchWithTimeout(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.env.requestTimeoutMs ?? 20_000)
    return this.env.fetch(url, { ...init, redirect: 'follow', cache: 'no-store', signal: AbortSignal.any([signal, timeout]) })
  }

  private classifyNetworkError(error: unknown): AvidaeModuleError {
    if (error instanceof AvidaeModuleError) return error
    if (this.env.isOnline && !this.env.isOnline()) return new AvidaeModuleError('offline', messages.offline)
    const detail = error instanceof Error ? error.message : String(error)
    if (/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_NETWORK_CHANGED/i.test(detail)) {
      return new AvidaeModuleError('offline', messages.offline)
    }
    if (/ERR_CONNECTION_(?:REFUSED|RESET|TIMED_OUT|CLOSED)|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ECONNRESET|ETIMEDOUT|TimeoutError/i.test(detail)) {
      return new AvidaeModuleError('offline', 'The Video & Audio download server could not be reached. Check your connection and try again.')
    }
    return new AvidaeModuleError('unknown', `${messages.unknown} ${detail}`.trim())
  }

  private async withRetries<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const delays = this.env.retryDelaysMs ?? [1_000, 3_000, 9_000]
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        if (signal.aborted || error instanceof CancelledError) throw new CancelledError()
        // Transient network failures are retried; a machine that reports
        // itself offline, and every verification failure, is not.
        const retryable = !(error instanceof AvidaeModuleError) || error.code === 'unknown' ||
          (error.code === 'offline' && this.env.isOnline?.() !== false)
        if (!retryable || attempt >= delays.length) throw error
        await wait(delays[attempt], signal)
      }
    }
  }

  private async fetchRelease(signal: AbortSignal): Promise<AvidaeModuleReleasePayload> {
    const manifestUrl = this.env.manifestUrl
    if (!manifestUrl) throw new AvidaeModuleError('not-published', this.env.unavailableReason ?? messages['not-published'])
    if (this.env.isOnline && !this.env.isOnline()) throw new AvidaeModuleError('offline', messages.offline)
    const raw = await this.withRetries(signal, async () => {
      let response: Response
      try {
        response = await this.fetchWithTimeout(manifestUrl, { headers: { Accept: 'application/json' } }, signal)
      } catch (error) {
        if (signal.aborted) throw new CancelledError()
        throw this.classifyNetworkError(error)
      }
      if (response.status === 404 || response.status === 410) throw new AvidaeModuleError('not-published', messages['not-published'])
      if (!response.ok) throw new AvidaeModuleError('unknown', `${messages.unknown} The release server returned HTTP ${response.status}.`)
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > MAX_MANIFEST_BYTES) throw new AvidaeModuleError('signature', messages.signature)
      const body = await response.arrayBuffer()
      if (body.byteLength > MAX_MANIFEST_BYTES) throw new AvidaeModuleError('signature', messages.signature)
      return Buffer.from(body).toString('utf8')
    })
    let release
    try {
      release = verifyModuleReleaseManifest(raw, {
        trustedKeys: this.env.trustedKeys,
        vastVersion: this.env.vastVersion,
        platform: this.env.platform,
        arch: this.env.arch,
        allowLoopbackHttp: this.env.allowLoopbackHttp
      })
    } catch (error) {
      if (error instanceof ModuleManifestError && error.code === 'incompatible') throw new AvidaeModuleError('incompatible', error.message)
      throw new AvidaeModuleError('signature', messages.signature)
    }
    const trust = await readJson<{ highestSequence?: number }>(path.join(this.env.root, TRUST_FILE))
    const highest = Math.max(trust?.highestSequence ?? 0, this.active?.sequence ?? 0)
    // Replaying an older signed manifest must never roll an installation back.
    if (release.payload.sequence < highest) throw new AvidaeModuleError('signature', messages.signature)
    if (this.env.revokedModuleVersions.includes(release.payload.moduleVersion)) throw new AvidaeModuleError('incompatible', messages.incompatible)
    this.releaseKeyId = release.keyId
    return release.payload
  }

  // Reads the installation state and, once per session, the signed release
  // metadata needed to show the real download size. Called when the Video &
  // Audio page asks for status, never during browser startup.
  async refresh(options: { checkRelease?: boolean } = {}): Promise<AvidaeModuleStatus> {
    if (this.installPromise) return this.status()
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = (async () => {
      if (this.env.unavailableReason && !(await readJson(path.join(this.env.root, ACTIVE_FILE)))) {
        this.set({ state: 'unavailable', error: this.env.unavailableReason, canCancel: false })
        return this.status()
      }
      let state = await this.installedState()
      // A failed availability check is retried at most once a minute while
      // the page keeps asking for status.
      if (options.checkRelease && !this.releaseChecked && this.env.manifestUrl && !this.env.unavailableReason &&
          this.now() - this.releaseCheckFailedAt > 60_000) {
        if (state !== 'ready') this.set({ ...this.baseStatus(), state: 'checking', canCancel: false })
        const controller = new AbortController()
        try {
          this.release = await this.fetchRelease(controller.signal)
          this.releaseChecked = true
          this.availabilityError = undefined
          state = await this.installedState()
        } catch (error) {
          this.releaseCheckFailedAt = this.now()
          this.availabilityError = error instanceof AvidaeModuleError ? { code: error.code, message: error.message } : undefined
        }
      }
      if (state === 'not-installed' && this.installFailure) {
        this.set({ ...this.baseStatus(), state: 'failed', errorCode: this.installFailure.code, error: this.installFailure.message, canCancel: false })
        return this.status()
      }
      // Availability failures are shown only when they block the user.
      const blocking = state !== 'ready' ? this.availabilityError : undefined
      const errorCode = blocking?.code
      const errorMessage = blocking?.message
      if (state === 'not-installed' && !this.env.manifestUrl) {
        this.set({ state: 'unavailable', error: this.env.unavailableReason ?? messages['not-published'], canCancel: false })
        return this.status()
      }
      this.set({ ...this.baseStatus(), state, errorCode, error: errorMessage, canCancel: false })
      return this.status()
    })()
    try {
      return await this.refreshPromise
    } finally {
      this.refreshPromise = undefined
    }
  }

  async activeRuntime(): Promise<ActiveAvidaeModule> {
    if (this.installPromise) throw new AvidaeModuleError('busy', 'Video & Audio is still being installed.')
    const state = await this.installedState()
    if (state !== 'ready' || !this.active) {
      this.set({ ...this.baseStatus(), state, canCancel: false })
      throw new AvidaeModuleError(state === 'incompatible' || state === 'update-required' ? 'incompatible' : 'unknown',
        'The Video & Audio runtime is not installed.')
    }
    return {
      root: path.join(this.env.root, this.active.directory),
      moduleVersion: this.active.moduleVersion,
      hostApi: this.active.hostApi
    }
  }

  // A verified runtime failed its pre-launch check; require a reinstall.
  markRepairRequired(message: string): void {
    this.set({ ...this.baseStatus(), state: 'repair-required', error: message, canCancel: false })
  }

  cancel(): AvidaeModuleStatus {
    if (this.abort && !this.abort.signal.aborted) this.abort.abort(new CancelledError())
    return this.status()
  }

  install(): Promise<AvidaeModuleStatus> {
    if (this.installPromise) return this.installPromise
    this.installPromise = this.runInstall().finally(() => {
      this.installPromise = undefined
      this.abort = undefined
    })
    return this.installPromise
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = path.join(this.env.root, LOCK_FILE)
    const token = randomBytes(12).toString('hex')
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, 'wx')
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: this.now() }), 'utf8')
        } finally {
          await handle.close()
        }
        return async () => {
          const owner = await readJson<{ token?: string }>(lockPath)
          if (owner?.token === token) await rm(lockPath, { force: true })
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const owner = await readJson<{ pid?: number; createdAt?: number }>(lockPath)
        const stale = !owner || !Number.isSafeInteger(owner.pid) || !processAlive(owner.pid as number) ||
          this.now() - Number(owner.createdAt ?? 0) > LOCK_STALE_MS
        if (!stale || attempt > 0) throw new AvidaeModuleError('busy', messages.busy)
        await rm(lockPath, { force: true })
      }
    }
    throw new AvidaeModuleError('busy', messages.busy)
  }

  // Removes interrupted extraction workspaces and promoted directories that
  // are neither active nor the retained last-known-good version. Directories
  // still in use by another running Vast fail to delete and are retried later.
  private async cleanup(keep: ReadonlySet<string>, keepDownload?: string): Promise<void> {
    await rm(path.join(this.env.root, STAGING), { recursive: true, force: true }).catch(() => undefined)
    const downloads = path.join(this.env.root, DOWNLOADS)
    for (const entry of await readdir(downloads).catch(() => [] as string[])) {
      if (keepDownload && entry.startsWith(keepDownload)) continue
      await rm(path.join(downloads, entry), { force: true }).catch(() => undefined)
    }
    for (const entry of await readdir(this.env.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !isDirectoryName(entry.name) || keep.has(entry.name)) continue
      await rm(path.join(this.env.root, entry.name), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async ensureDiskSpace(payload: AvidaeModuleReleasePayload, alreadyDownloaded: number): Promise<void> {
    const required = payload.archive.size - alreadyDownloaded + payload.archive.unpackedSize + DISK_MARGIN_BYTES
    const free = await (this.env.freeBytes ?? defaultFreeBytes)(this.env.root)
    if (free < required) {
      const needMiB = Math.ceil(required / 1024 / 1024)
      throw new AvidaeModuleError('disk-space', `${messages['disk-space']} About ${needMiB} MB of free space is needed.`)
    }
  }

  private async download(payload: AvidaeModuleReleasePayload, partPath: string, signal: AbortSignal): Promise<void> {
    const total = payload.archive.size
    const metaPath = `${partPath}.json`
    const progress = (transferred: number): void => this.set({
      ...this.baseStatus(), state: 'downloading', transferredBytes: transferred, totalBytes: total, canCancel: true
    }, true)
    await this.withRetries(signal, async () => {
      const meta = await readJson<{ url?: string; sha256?: string; size?: number }>(metaPath)
      let offset = (await stat(partPath).catch(() => undefined))?.size ?? 0
      if (!meta || meta.url !== payload.archive.url || meta.sha256 !== payload.archive.sha256 || meta.size !== total || offset > total) offset = 0
      if (offset === total) return
      await writeJsonAtomic(metaPath, { url: payload.archive.url, sha256: payload.archive.sha256, size: total })
      const attempt = new AbortController()
      const linked = AbortSignal.any([signal, attempt.signal])
      let response: Response
      try {
        response = await this.env.fetch(payload.archive.url, {
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          redirect: 'follow',
          cache: 'no-store',
          signal: AbortSignal.any([linked, AbortSignal.timeout(this.env.requestTimeoutMs ?? 20_000)])
        })
      } catch (error) {
        if (signal.aborted) throw new CancelledError()
        throw this.classifyNetworkError(error)
      }
      if (response.status === 404 || response.status === 410) throw new AvidaeModuleError('not-published', messages['not-published'])
      let append = false
      if (offset > 0 && response.status === 206) {
        // Resume only when the server confirms exactly the expected range of
        // the signed total size; otherwise start over from byte zero.
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '')
        append = Boolean(range && Number(range[1]) === offset && Number(range[2]) === total - 1 && Number(range[3]) === total)
        if (!append) {
          await response.body?.cancel()
          await rm(partPath, { force: true })
          throw new AvidaeModuleError('unknown', 'The download could not be resumed.')
        }
      } else if (response.status !== 200) {
        await response.body?.cancel()
        throw new AvidaeModuleError('unknown', `${messages.unknown} The release server returned HTTP ${response.status}.`)
      }
      if (!append) offset = 0
      const expectedLength = total - offset
      const declared = response.headers.get('content-length')
      if (declared !== null && Number(declared) !== expectedLength) {
        await response.body?.cancel()
        throw new AvidaeModuleError('integrity', messages.integrity)
      }
      if (!response.body) throw new AvidaeModuleError('unknown', messages.unknown)
      const handle = await open(partPath, append ? 'a' : 'w')
      let transferred = offset
      let stallTimer: NodeJS.Timeout | undefined
      const armStall = (): void => {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => attempt.abort(new Error('stalled')), this.env.stallTimeoutMs ?? 30_000)
      }
      try {
        armStall()
        progress(transferred)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          if (transferred + chunk.byteLength > total) throw new AvidaeModuleError('integrity', messages.integrity)
          await handle.write(chunk)
          transferred += chunk.byteLength
          armStall()
          progress(transferred)
        }
      } catch (error) {
        if (signal.aborted) throw new CancelledError()
        if (error instanceof AvidaeModuleError) throw error
        // Stalls and dropped connections keep the partial file for resume.
        throw new AvidaeModuleError('unknown', attempt.signal.aborted
          ? 'The download stalled.'
          : `The download was interrupted. ${error instanceof Error ? error.message : ''}`.trim())
      } finally {
        clearTimeout(stallTimer)
        await handle.close()
      }
      if (transferred !== total) throw new AvidaeModuleError('unknown', 'The download ended early.')
    })
  }

  private async runInstall(): Promise<AvidaeModuleStatus> {
    const controller = new AbortController()
    this.abort = controller
    const signal = controller.signal
    let release: (() => Promise<void>) | undefined
    let partPath: string | undefined
    this.installFailure = undefined
    try {
      if (this.env.unavailableReason) throw new AvidaeModuleError('not-published', this.env.unavailableReason)
      this.set({ ...this.baseStatus(), state: 'checking', canCancel: true })
      await mkdir(this.env.root, { recursive: true })
      const rootInfo = await lstat(this.env.root)
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new AvidaeModuleError('unknown', 'The Video & Audio module folder is not a regular directory.')
      release = await this.acquireLock()
      await this.installedState()
      const payload = await this.fetchRelease(signal)
      this.release = payload
      this.releaseChecked = true
      this.availabilityError = undefined
      const directoryName = versionDirectory(payload)
      if ((await this.installedState()) === 'ready' && this.active?.archiveSha256 === payload.archive.sha256) {
        await this.cleanup(new Set([directoryName, this.active.previousDirectory ?? '']))
        this.set({ ...this.baseStatus(), state: 'ready', canCancel: false })
        return this.status()
      }
      const keep = new Set([this.active?.directory ?? '', this.active?.previousDirectory ?? ''])
      await this.cleanup(keep, payload.archive.sha256)

      await mkdir(path.join(this.env.root, DOWNLOADS), { recursive: true })
      partPath = path.join(this.env.root, DOWNLOADS, `${payload.archive.sha256}.part`)
      const partial = (await stat(partPath).catch(() => undefined))?.size ?? 0
      await this.ensureDiskSpace(payload, Math.min(partial, payload.archive.size))
      await this.download(payload, partPath, signal)

      let hashed = 0
      this.set({ ...this.baseStatus(), state: 'verifying', transferredBytes: 0, totalBytes: payload.archive.size, canCancel: true })
      const digest = await hashFile(partPath, signal, (count) => {
        hashed += count
        this.set({ ...this.baseStatus(), state: 'verifying', transferredBytes: hashed, totalBytes: payload.archive.size, canCancel: true }, true)
      })
      if (digest !== payload.archive.sha256 || hashed !== payload.archive.size) {
        await rm(partPath, { force: true })
        await rm(`${partPath}.json`, { force: true })
        throw new AvidaeModuleError('integrity', messages.integrity)
      }

      const staging = path.join(this.env.root, STAGING, randomBytes(6).toString('hex'))
      const payloadRoot = path.join(staging, 'payload')
      await mkdir(payloadRoot, { recursive: true })
      this.set({ ...this.baseStatus(), state: 'installing', transferredBytes: 0, totalBytes: payload.archive.unpackedSize, canCancel: true })
      try {
        await extractModuleArchive(partPath, payloadRoot, {
          runtimeManifestSha256: payload.runtimeManifest.sha256,
          runtimeManifestSize: payload.runtimeManifest.size,
          unpackedSize: payload.archive.unpackedSize,
          fileCount: payload.archive.fileCount
        }, {
          signal,
          onProgress: ({ extractedBytes, totalBytes }) => this.set({
            ...this.baseStatus(), state: 'installing', transferredBytes: extractedBytes, totalBytes, canCancel: true
          }, true)
        })
        await verifyAvidaeRuntime(payloadRoot, { moduleVersion: payload.moduleVersion, hostApi: payload.hostApi })
      } catch (error) {
        if (signal.aborted) throw new CancelledError()
        await rm(partPath, { force: true })
        await rm(`${partPath}.json`, { force: true })
        if (error instanceof ModuleArchiveError) throw new AvidaeModuleError('archive', messages.archive)
        throw new AvidaeModuleError('archive', `${messages.archive} ${error instanceof Error ? error.message : ''}`.trim())
      }
      if (signal.aborted) throw new CancelledError()

      // Promotion: cancellation is no longer honoured from here on.
      this.set({ ...this.baseStatus(), state: 'installing', transferredBytes: payload.archive.unpackedSize, totalBytes: payload.archive.unpackedSize, canCancel: false })
      const target = path.join(this.env.root, directoryName)
      if (directoryName === this.active?.directory || directoryName === this.active?.previousDirectory) {
        // Reinstalling a damaged copy of the same build. It is not running:
        // the backend refuses to start until the module is ready.
        await rm(target, { recursive: true, force: true })
      }
      await rename(payloadRoot, target)
      const previous = this.active && this.active.directory !== directoryName && (await this.installedState()) === 'ready'
        ? this.active.directory
        : undefined
      const record: ActiveRecord = {
        schemaVersion: 1,
        moduleId: AVIDAE_MODULE_ID,
        directory: directoryName,
        previousDirectory: previous,
        moduleVersion: payload.moduleVersion,
        sequence: payload.sequence,
        hostApi: payload.hostApi,
        minVastVersion: payload.minVastVersion,
        archiveSha256: payload.archive.sha256,
        runtimeManifestSha256: payload.runtimeManifest.sha256,
        unpackedSize: payload.archive.unpackedSize,
        keyId: this.releaseKeyId ?? '',
        installedAt: new Date(this.now()).toISOString()
      }
      await writeJsonAtomic(path.join(this.env.root, ACTIVE_FILE), record)
      const trust = await readJson<{ highestSequence?: number }>(path.join(this.env.root, TRUST_FILE))
      await writeJsonAtomic(path.join(this.env.root, TRUST_FILE), { highestSequence: Math.max(trust?.highestSequence ?? 0, payload.sequence) })
      this.active = record
      await this.cleanup(new Set([directoryName, previous ?? '']))
      this.set({ ...this.baseStatus(), state: 'ready', canCancel: false })
      return this.status()
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) {
        // An explicit cancel discards the partial download.
        if (partPath) {
          await rm(partPath, { force: true }).catch(() => undefined)
          await rm(`${partPath}.json`, { force: true }).catch(() => undefined)
        }
        await rm(path.join(this.env.root, STAGING), { recursive: true, force: true }).catch(() => undefined)
        const state = await this.installedState().catch(() => 'not-installed' as const)
        this.set({ ...this.baseStatus(), state: state === 'ready' ? 'ready' : 'cancelled', canCancel: false })
        return this.status()
      }
      const failure = error instanceof AvidaeModuleError ? error : new AvidaeModuleError('unknown', `${messages.unknown} ${error instanceof Error ? error.message : ''}`.trim())
      await rm(path.join(this.env.root, STAGING), { recursive: true, force: true }).catch(() => undefined)
      const installed = await this.installedState().catch(() => 'not-installed' as const)
      if (installed !== 'ready') this.installFailure = { code: failure.code, message: failure.message }
      // A failed update keeps the previous verified version usable.
      this.set({
        ...this.baseStatus(),
        state: installed === 'ready' ? 'ready' : 'failed',
        error: failure.message,
        errorCode: failure.code,
        canCancel: false
      })
      return this.status()
    } finally {
      await release?.().catch(() => undefined)
    }
  }
}
