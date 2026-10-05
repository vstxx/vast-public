import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from '../atomic-file.ts'
import {
  parseVextPackage,
  canonicalJson,
  sha256Hex,
  verifyVextPackage,
  VEXT_EXTENSION_ID,
  VEXT_VERSION,
  type ParsedVextPackage,
  type VextPackageMetadata,
  type VextTrustedKey
} from '../../shared/vext-format.ts'
import type { ExtensionInstallSource } from '../../shared/extension-marketplace.ts'
import type { LocalChromiumStage } from './local-chromium-stage.ts'

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
  runtimeRelativePath?: string
  failedVersions: string[]
  versions: ManagedVersionState[]
}

interface StagedManagedPackageBase {
  id: string
  root: string
  contentRoot: string
}

export interface StagedVextPackage extends StagedManagedPackageBase {
  format: 'vext'
  source: 'local-vext' | 'hub' | 'upstream'
  parsed: ParsedVextPackage
}

export interface StagedLocalChromiumPackage extends StagedManagedPackageBase {
  format: 'local-chromium'
  source: 'local-chromium'
  local: LocalChromiumStage
}

export type StagedManagedPackage = StagedVextPackage | StagedLocalChromiumPackage

export interface ManagedPackageIdentity {
  extensionId: string
  version: string
  packageSha256: string
  manifestSha256: string
  publisherId?: string
  signatureKeyId?: string
}

export function stagedPackageIdentity(staged: StagedManagedPackage): ManagedPackageIdentity {
  if (staged.format === 'local-chromium') return {
    extensionId: staged.local.sourceExtensionId,
    version: staged.local.version,
    packageSha256: staged.local.fingerprint,
    manifestSha256: staged.local.manifestSha256
  }
  const metadata = staged.parsed.metadata
  return {
    extensionId: metadata.extension_id,
    version: metadata.version,
    packageSha256: staged.parsed.packageSha256,
    manifestSha256: metadata.manifest_sha256,
    ...(metadata.publisher_id ? { publisherId: metadata.publisher_id } : {}),
    ...(staged.parsed.verifiedKeyId ? { signatureKeyId: staged.parsed.verifiedKeyId } : {})
  }
}

export interface VerifiedUpstreamPackage {
  extensionId: string
  version: string
  packageSha256: string
  files: Map<string, Uint8Array>
}

export interface ManagedRuntimeTransaction {
  extensionId: string
  version: string
  currentRoot: string
  nextRoot: string
  previousRoot: string
  hadCurrent: boolean
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
  if (input.source !== 'local-vext' && input.source !== 'local-chromium' && input.source !== 'hub' && input.source !== 'upstream') return undefined
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
  const runtimeRelativePath = typeof input.runtimeRelativePath === 'string' && (input.runtimeRelativePath === 'current' || /^versions\/[0-9A-Za-z.+-]+$/.test(input.runtimeRelativePath))
    ? input.runtimeRelativePath
    : undefined
  return {
    schemaVersion: 1,
    extensionId: String(input.extensionId),
    activeVersion: String(input.activeVersion),
    ...(previousVersion ? { previousVersion } : {}),
    source: input.source,
    ...(publisherId ? { publisherId } : {}),
    ...(runtimeRelativePath ? { runtimeRelativePath } : {}),
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
    const managedEntries = await readdir(this.managedRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of managedEntries) {
      if (entry.isDirectory() && VEXT_EXTENSION_ID.test(entry.name)) {
        await this.migrateVersionArchives(entry.name)
        await this.recoverRuntimeSwap(entry.name)
      }
    }
  }

  async stagePackage(bytes: Uint8Array, source: 'local-vext' | 'hub', trustedKeys: readonly VextTrustedKey[]): Promise<StagedVextPackage> {
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
      return { format: 'vext', id: randomUUID(), root, contentRoot, source, parsed }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async stageUpstreamPackage(input: VerifiedUpstreamPackage): Promise<StagedVextPackage> {
    if (!VEXT_EXTENSION_ID.test(input.extensionId) || !VEXT_VERSION.test(input.version) || !/^[a-f0-9]{64}$/.test(input.packageSha256)) throw new Error('Upstream extension identity is invalid.')
    const manifest = input.files.get('manifest.json')
    if (!manifest) throw new Error('Upstream extension manifest is missing.')
    const fileList = await Promise.all([...input.files].map(async ([path, data]) => ({ path, size: data.byteLength, sha256: await sha256Hex(data) })))
    const metadata: VextPackageMetadata = {
      format_version: 1,
      extension_id: input.extensionId,
      version: input.version,
      publisher_id: null,
      manifest_sha256: await sha256Hex(manifest),
      files: fileList.sort((left, right) => left.path.localeCompare(right.path))
    }
    const parsed: ParsedVextPackage = {
      metadata,
      files: input.files,
      packageSha256: input.packageSha256,
      canonicalMetadata: new TextEncoder().encode(canonicalJson(metadata))
    }
    const root = await mkdtemp(join(this.stagingRoot, 'upstream-'))
    const contentRoot = join(root, 'content')
    await mkdir(contentRoot, { recursive: true })
    try {
      for (const [packagePath, data] of input.files) {
        const destination = resolve(contentRoot, ...packagePath.split('/'))
        if (!isInside(contentRoot, destination)) throw new Error('Upstream package extraction escaped the staging directory.')
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, data, { flag: 'wx' })
      }
      return { format: 'vext', id: randomUUID(), root, contentRoot, source: 'upstream', parsed }
    } catch (error) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async adoptLocalChromiumStage(local: LocalChromiumStage): Promise<StagedLocalChromiumPackage> {
    if (!VEXT_EXTENSION_ID.test(local.sourceExtensionId) || !VEXT_VERSION.test(local.version) ||
        !/^[a-f0-9]{64}$/.test(local.fingerprint) || !/^[a-f0-9]{64}$/.test(local.manifestSha256)) {
      throw new Error('Local Chromium stage is invalid.')
    }
    let stagingRoot: string
    let root: string
    let contentRoot: string
    try {
      stagingRoot = await realpath(this.stagingRoot)
      root = await realpath(local.root)
      contentRoot = await realpath(local.contentRoot)
    } catch {
      throw new Error('Local Chromium stage is invalid.')
    }
    if (!isInside(stagingRoot, root) || !isInside(root, contentRoot)) {
      throw new Error('Local Chromium stage is invalid.')
    }
    return { format: 'local-chromium', source: 'local-chromium', id: randomUUID(),
      root, contentRoot, local }
  }

  async commit(staged: StagedManagedPackage): Promise<string> {
    const identity = stagedPackageIdentity(staged)
    const extensionRoot = this.extensionRoot(identity.extensionId)
    const versionsRoot = join(extensionRoot, 'releases')
    const destination = this.versionRoot(identity.extensionId, identity.version)
    await mkdir(versionsRoot, { recursive: true })
    if (await stat(destination).then((info) => info.isDirectory()).catch(() => false)) {
      const state = await this.readState(identity.extensionId)
      const matching = state?.versions.find((version) => version.version === identity.version && version.packageSha256 === identity.packageSha256)
      if (!matching) throw new Error('A different package already uses this managed extension version.')
      await this.discard(staged)
      return destination
    }
    await renameWithRetry(staged.contentRoot, destination)
    await rm(staged.root, { recursive: true, force: true }).catch(() => undefined)
    return destination
  }

  async activate(staged: StagedManagedPackage): Promise<ManagedExtensionState> {
    const identity = stagedPackageIdentity(staged)
    const current = await this.readState(identity.extensionId)
    const version: ManagedVersionState = {
      version: identity.version,
      packageSha256: identity.packageSha256,
      manifestSha256: identity.manifestSha256,
      ...(identity.signatureKeyId ? { signatureKeyId: identity.signatureKeyId } : {}),
      installedAt: Date.now()
    }
    const versions = [version, ...(current?.versions ?? []).filter((item) => item.version !== version.version)].slice(0, 3)
    const state: ManagedExtensionState = {
      schemaVersion: 1,
      extensionId: identity.extensionId,
      activeVersion: identity.version,
      ...(current?.activeVersion && current.activeVersion !== identity.version ? { previousVersion: current.activeVersion } : current?.previousVersion ? { previousVersion: current.previousVersion } : {}),
      source: staged.source,
      ...(identity.publisherId ? { publisherId: identity.publisherId } : {}),
      ...(current?.runtimeRelativePath ? { runtimeRelativePath: current.runtimeRelativePath } : {}),
      failedVersions: (current?.failedVersions ?? []).filter((item) => item !== identity.version),
      versions
    }
    await atomicWriteJson(this.statePath(identity.extensionId), state)
    const retained = new Set(versions.map((item) => item.version))
    const versionEntries = await readdir(join(this.extensionRoot(identity.extensionId), 'releases'), { withFileTypes: true }).catch(() => [])
    await Promise.all(versionEntries.filter((entry) => entry.isDirectory() && VEXT_VERSION.test(entry.name) && !retained.has(entry.name)).map((entry) => rm(this.versionRoot(identity.extensionId, entry.name), { recursive: true, force: true }).catch(() => undefined)))
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

  async ensureCurrent(extensionId: string, version: string): Promise<string> {
    await this.recoverRuntimeSwap(extensionId)
    const currentRoot = await this.runtimeRoot(extensionId)
    if (await this.isDirectory(currentRoot)) return currentRoot
    const source = this.versionRoot(extensionId, version)
    if (!await this.isDirectory(source)) throw new Error('The active managed extension version is unavailable.')
    const nextRoot = this.nextRoot(extensionId)
    await rm(nextRoot, { recursive: true, force: true })
    await cp(source, nextRoot, { recursive: true, errorOnExist: true })
    await renameWithRetry(nextRoot, currentRoot)
    return currentRoot
  }

  async prepareRuntime(extensionId: string, version: string): Promise<ManagedRuntimeTransaction> {
    await this.recoverRuntimeSwap(extensionId)
    const source = this.versionRoot(extensionId, version)
    if (!await this.isDirectory(source)) throw new Error('The verified managed extension version is unavailable.')
    const currentRoot = await this.runtimeRoot(extensionId)
    const nextRoot = this.nextRoot(extensionId)
    const previousRoot = this.previousRoot(extensionId)
    await Promise.all([
      rm(nextRoot, { recursive: true, force: true }),
      rm(previousRoot, { recursive: true, force: true })
    ])
    await cp(source, nextRoot, { recursive: true, errorOnExist: true })
    return { extensionId, version, currentRoot, nextRoot, previousRoot, hadCurrent: await this.isDirectory(currentRoot) }
  }

  async swapRuntime(transaction: ManagedRuntimeTransaction): Promise<string> {
    if (!await this.isDirectory(transaction.nextRoot)) throw new Error('The prepared managed extension runtime is unavailable.')
    if (transaction.hadCurrent) await renameWithRetry(transaction.currentRoot, transaction.previousRoot)
    try {
      await renameWithRetry(transaction.nextRoot, transaction.currentRoot)
      return transaction.currentRoot
    } catch (error) {
      if (transaction.hadCurrent && !await this.isDirectory(transaction.currentRoot) && await this.isDirectory(transaction.previousRoot)) {
        await renameWithRetry(transaction.previousRoot, transaction.currentRoot).catch(() => undefined)
      }
      throw error
    }
  }

  async commitRuntime(transaction: ManagedRuntimeTransaction): Promise<void> {
    await Promise.all([
      rm(transaction.previousRoot, { recursive: true, force: true }),
      rm(transaction.nextRoot, { recursive: true, force: true })
    ])
  }

  async rollbackRuntime(transaction: ManagedRuntimeTransaction): Promise<void> {
    await rm(transaction.currentRoot, { recursive: true, force: true })
    if (transaction.hadCurrent && await this.isDirectory(transaction.previousRoot)) {
      await renameWithRetry(transaction.previousRoot, transaction.currentRoot)
    }
    await rm(transaction.nextRoot, { recursive: true, force: true })
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
    return join(this.extensionRoot(extensionId), 'releases', version)
  }

  currentRoot(extensionId: string): string {
    return join(this.extensionRoot(extensionId), 'current')
  }

  async adoptLegacyRuntimePath(extensionId: string, runtimePath: string): Promise<string> {
    const state = await this.readState(extensionId)
    if (!state) throw new Error('Managed extension state is unavailable.')
    const expected = this.legacyVersionRoot(extensionId, state.activeVersion)
    if (resolve(runtimePath) !== resolve(expected) || !await this.isDirectory(expected)) {
      throw new Error('Legacy managed extension runtime path is invalid.')
    }
    await this.migrateVersionArchives(extensionId)
    await atomicWriteJson(this.statePath(extensionId), {
      ...state,
      runtimeRelativePath: `versions/${state.activeVersion}`
    })
    return expected
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

  metadata(staged: StagedVextPackage): VextPackageMetadata {
    return staged.parsed.metadata
  }

  private extensionRoot(extensionId: string): string {
    if (!VEXT_EXTENSION_ID.test(extensionId)) throw new Error('Managed extension identity is invalid.')
    return join(this.managedRoot, extensionId)
  }

  private statePath(extensionId: string): string {
    return join(this.extensionRoot(extensionId), 'state.json')
  }

  private nextRoot(extensionId: string): string {
    return join(this.extensionRoot(extensionId), 'current.next')
  }

  private previousRoot(extensionId: string): string {
    return join(this.extensionRoot(extensionId), 'current.previous')
  }

  private legacyVersionRoot(extensionId: string, version: string): string {
    if (!VEXT_VERSION.test(version)) throw new Error('Managed extension version is invalid.')
    return join(this.extensionRoot(extensionId), 'versions', version)
  }

  private async runtimeRoot(extensionId: string): Promise<string> {
    const state = await this.readState(extensionId)
    if (!state?.runtimeRelativePath || state.runtimeRelativePath === 'current') return this.currentRoot(extensionId)
    return join(this.extensionRoot(extensionId), ...state.runtimeRelativePath.split('/'))
  }

  private async isDirectory(path: string): Promise<boolean> {
    return stat(path).then((entry) => entry.isDirectory()).catch(() => false)
  }

  private async recoverRuntimeSwap(extensionId: string): Promise<void> {
    const currentRoot = await this.runtimeRoot(extensionId)
    const nextRoot = this.nextRoot(extensionId)
    const previousRoot = this.previousRoot(extensionId)
    const hasCurrent = await this.isDirectory(currentRoot)
    const hasPrevious = await this.isDirectory(previousRoot)
    if (!hasCurrent && hasPrevious) {
      await renameWithRetry(previousRoot, currentRoot)
    } else if (hasCurrent && hasPrevious) {
      const state = await this.readState(extensionId)
      const currentVersion = await this.runtimeManifestVersion(currentRoot)
      if (state && currentVersion === state.activeVersion) {
        await rm(previousRoot, { recursive: true, force: true })
      } else {
        await rm(currentRoot, { recursive: true, force: true })
        await renameWithRetry(previousRoot, currentRoot)
      }
    }
    await rm(nextRoot, { recursive: true, force: true })
  }

  private async migrateVersionArchives(extensionId: string): Promise<void> {
    const state = await this.readState(extensionId)
    if (!state) return
    for (const version of state.versions) {
      const destination = this.versionRoot(extensionId, version.version)
      if (await this.isDirectory(destination)) continue
      const legacy = this.legacyVersionRoot(extensionId, version.version)
      if (!await this.isDirectory(legacy)) continue
      await mkdir(dirname(destination), { recursive: true })
      await cp(legacy, destination, { recursive: true, errorOnExist: true })
    }
  }

  private async runtimeManifestVersion(root: string): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { version?: unknown }
      return typeof parsed.version === 'string' ? parsed.version : undefined
    } catch {
      return undefined
    }
  }
}
