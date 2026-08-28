import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from '../atomic-file.ts'
import {
  parseVextPackage,
  verifyVextPackage,
  VEXT_EXTENSION_ID,
  VEXT_VERSION,
  type ParsedVextPackage,
  type VextPackageMetadata,
  type VextTrustedKey
} from '../../shared/vext-format.ts'
import type { ExtensionInstallSource } from '../../shared/extension-marketplace.ts'

const retryDelays = [60, 180, 450, 900]
const retryableCodes = new Set(['EBUSY', 'EPERM', 'EACCES'])

export interface ManagedVersionState {
  version: string
  packageSha256: string
  manifestSha256: string
  signatureKeyId?: string
  installedAt: number
}

export interface ManagedExtensionState {
  schemaVersion: 1
  extensionId: string
  activeVersion: string
  previousVersion?: string
  source: Exclude<ExtensionInstallSource, 'unpacked' | 'bundled'>
  publisherId?: string
  failedVersions: string[]
  versions: ManagedVersionState[]
}

export interface StagedManagedPackage {
  id: string
  root: string
  contentRoot: string
  source: Exclude<ExtensionInstallSource, 'unpacked' | 'bundled'>
  parsed: ParsedVextPackage
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? String((error as { code: string }).code)
    : undefined
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try { await rename(source, destination); return } catch (error) {
      lastError = error
      const code = errorCode(error)
      if (!code || !retryableCodes.has(code) || attempt === retryDelays.length) throw error
      await delay(retryDelays[attempt])
    }
  }
  throw lastError
}

function isInside(root: string, candidate: string): boolean {
  const next = relative(root, candidate)
  return next === '' || (next !== '..' && !next.startsWith(`..${sep}`) && !isAbsolute(next))
}

function stateFromUnknown(value: unknown): ManagedExtensionState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !VEXT_EXTENSION_ID.test(String(input.extensionId)) || !VEXT_VERSION.test(String(input.activeVersion))) return undefined
  if (input.source !== 'local-vext' && input.source !== 'hub') return undefined
  const failedVersions = Array.isArray(input.failedVersions) ? input.failedVersions.filter((version): version is string => typeof version === 'string' && VEXT_VERSION.test(version)).slice(0, 32) : []
  const versions = Array.isArray(input.versions) ? input.versions.flatMap((candidate): ManagedVersionState[] => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const version = candidate as Record<string, unknown>
    if (!VEXT_VERSION.test(String(version.version)) || !/^[a-f0-9]{64}$/.test(String(version.packageSha256)) || !/^[a-f0-9]{64}$/.test(String(version.manifestSha256))) return []
    const installedAt = Number(version.installedAt)
    if (!Number.isFinite(installedAt) || installedAt <= 0) return []
    const signatureKeyId = typeof version.signatureKeyId === 'string' && /^[A-Za-z0-9_-]{3,128}$/.test(version.signatureKeyId) ? version.signatureKeyId : undefined
    return [{ version: String(version.version), packageSha256: String(version.packageSha256), manifestSha256: String(version.manifestSha256), ...(signatureKeyId ? { signatureKeyId } : {}), installedAt }]
  }) : []
  const previousVersion = typeof input.previousVersion === 'string' && VEXT_VERSION.test(input.previousVersion) ? input.previousVersion : undefined
  const publisherId = typeof input.publisherId === 'string' ? input.publisherId : undefined
  return {
    schemaVersion: 1,
    extensionId: String(input.extensionId),
    activeVersion: String(input.activeVersion),
    ...(previousVersion ? { previousVersion } : {}),
    source: input.source,
    ...(publisherId ? { publisherId } : {}),
    failedVersions,
    versions
  }
}

export class ExtensionManagedStore {
  readonly extensionsRoot: string
  readonly managedRoot: string
  readonly stagingRoot: string

  constructor(userDataRoot: string) {
    this.extensionsRoot = join(userDataRoot, 'Extensions')
    this.managedRoot = join(this.extensionsRoot, 'Managed')
    this.stagingRoot = join(this.extensionsRoot, 'Staging')
  }

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.managedRoot, { recursive: true }), mkdir(this.stagingRoot, { recursive: true })])
    const entries = await readdir(this.stagingRoot, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map((entry) => rm(join(this.stagingRoot, entry.name), { recursive: true, force: true }).catch(() => undefined)))
  }

  async stagePackage(bytes: Uint8Array, source: Exclude<ExtensionInstallSource, 'unpacked' | 'bundled'>, trustedKeys: readonly VextTrustedKey[]): Promise<StagedManagedPackage> {
    let parsed = await parseVextPackage(bytes)
    if (source === 'hub') {
      parsed = await verifyVextPackage(bytes, trustedKeys, true)
    } else if (parsed.signature && trustedKeys.some((key) => key.keyId === parsed.signature?.key_id)) {
      parsed = await verifyVextPackage(bytes, trustedKeys, true)
    }
    const root = await mkdtemp(join(this.stagingRoot, 'install-'))
    const contentRoot = join(root, 'content')
    await mkdir(contentRoot, { recursive: true })
    try {
      for (const [packagePath, data] of parsed.files) {
        const destination = resolve(contentRoot, ...packagePath.split('/'))
        if (!isInside(contentRoot, destination)) throw new Error('Package extraction escaped the staging directory.')
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, data, { flag: 'wx' })
      }
      return { id: randomUUID(), root, contentRoot, source, parsed }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async commit(staged: StagedManagedPackage): Promise<string> {
    const extensionRoot = this.extensionRoot(staged.parsed.metadata.extension_id)
    const versionsRoot = join(extensionRoot, 'versions')
    const destination = this.versionRoot(staged.parsed.metadata.extension_id, staged.parsed.metadata.version)
    await mkdir(versionsRoot, { recursive: true })
    if (await stat(destination).then((info) => info.isDirectory()).catch(() => false)) {
      const state = await this.readState(staged.parsed.metadata.extension_id)
      const matching = state?.versions.find((version) => version.version === staged.parsed.metadata.version && version.packageSha256 === staged.parsed.packageSha256)
      if (!matching) throw new Error('A different package already uses this managed extension version.')
      await this.discard(staged)
      return destination
    }
    await renameWithRetry(staged.contentRoot, destination)
    await rm(staged.root, { recursive: true, force: true }).catch(() => undefined)
    return destination
  }

  async activate(staged: StagedManagedPackage): Promise<ManagedExtensionState> {
    const metadata = staged.parsed.metadata
    const current = await this.readState(metadata.extension_id)
    const version: ManagedVersionState = {
      version: metadata.version,
      packageSha256: staged.parsed.packageSha256,
      manifestSha256: metadata.manifest_sha256,
      ...(staged.parsed.verifiedKeyId ? { signatureKeyId: staged.parsed.verifiedKeyId } : {}),
      installedAt: Date.now()
    }
    const versions = [version, ...(current?.versions ?? []).filter((item) => item.version !== version.version)].slice(0, 3)
    const state: ManagedExtensionState = {
      schemaVersion: 1,
      extensionId: metadata.extension_id,
      activeVersion: metadata.version,
      ...(current?.activeVersion && current.activeVersion !== metadata.version ? { previousVersion: current.activeVersion } : current?.previousVersion ? { previousVersion: current.previousVersion } : {}),
      source: staged.source,
      ...(metadata.publisher_id ? { publisherId: metadata.publisher_id } : {}),
      failedVersions: (current?.failedVersions ?? []).filter((item) => item !== metadata.version),
      versions
    }
    await atomicWriteJson(this.statePath(metadata.extension_id), state)
    const retained = new Set(versions.map((item) => item.version))
    const versionEntries = await readdir(join(this.extensionRoot(metadata.extension_id), 'versions'), { withFileTypes: true }).catch(() => [])
    await Promise.all(versionEntries.filter((entry) => entry.isDirectory() && VEXT_VERSION.test(entry.name) && !retained.has(entry.name)).map((entry) => rm(this.versionRoot(metadata.extension_id, entry.name), { recursive: true, force: true }).catch(() => undefined)))
    return state
  }

  async restoreActive(extensionId: string, version: string): Promise<ManagedExtensionState | undefined> {
    const state = await this.readState(extensionId)
    if (!state || !state.versions.some((item) => item.version === version)) return undefined
    const previous = state.activeVersion
    const next: ManagedExtensionState = { ...state, activeVersion: version, ...(previous !== version ? { previousVersion: previous } : {}) }
    await atomicWriteJson(this.statePath(extensionId), next)
    return next
  }

  async markFailed(extensionId: string, version: string): Promise<void> {
    const state = await this.readState(extensionId)
    if (!state) return
    const failedVersions = [version, ...state.failedVersions.filter((item) => item !== version)].slice(0, 32)
    await atomicWriteJson(this.statePath(extensionId), { ...state, failedVersions })
  }

  async readState(extensionId: string): Promise<ManagedExtensionState | undefined> {
    if (!VEXT_EXTENSION_ID.test(extensionId)) return undefined
    try { return stateFromUnknown(JSON.parse(await readFile(this.statePath(extensionId), 'utf8')) as unknown) } catch { return undefined }
  }

  versionRoot(extensionId: string, version: string): string {
    if (!VEXT_EXTENSION_ID.test(extensionId) || !VEXT_VERSION.test(version)) throw new Error('Managed extension identity is invalid.')
    return join(this.extensionRoot(extensionId), 'versions', version)
  }

  async discard(staged: StagedManagedPackage): Promise<void> {
    await rm(staged.root, { recursive: true, force: true })
  }

  async remove(extensionId: string): Promise<void> {
    await rm(this.extensionRoot(extensionId), { recursive: true, force: true })
  }

  async removeVersion(extensionId: string, version: string): Promise<void> {
    await rm(this.versionRoot(extensionId, version), { recursive: true, force: true })
  }

  metadata(staged: StagedManagedPackage): VextPackageMetadata {
    return staged.parsed.metadata
  }

  private extensionRoot(extensionId: string): string {
    if (!VEXT_EXTENSION_ID.test(extensionId)) throw new Error('Managed extension identity is invalid.')
    return join(this.managedRoot, extensionId)
  }

  private statePath(extensionId: string): string {
    return join(this.extensionRoot(extensionId), 'state.json')
  }
}
