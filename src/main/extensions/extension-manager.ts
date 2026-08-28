import type { Workspace, VastExtensionInfo, VastExtensionSurface, VastExtensionSurfaceKind } from '../../shared/types.ts'
import { VAST_PERMISSION_METADATA, type VastExtensionContributionSnapshot, type VastNativePermission, type VastNativeRuntimeState, type VastUiBrokerResponse } from '../../shared/extension-native-api.ts'
import {
  hasPermissionEscalation,
  permissionEscalation,
  type ExtensionPackagePreview,
  type ExtensionPermissionSnapshot,
  type SignedVastHubReleaseDescriptor,
  type VastHubCatalogResult,
  type VastHubExtensionDetails
} from '../../shared/extension-marketplace.ts'
import { canonicalJson, VEXT_LIMITS } from '../../shared/vext-format.ts'
import { partitionForWorkspace, resolveWorkspaceIdentity } from '../../shared/workspace-identity.ts'
import { analyzeExtensionCompatibility } from './extension-compatibility.ts'
import { chromeExtensionId, validateExtensionManifest } from './extension-manifest.ts'
import { ExtensionRegistry } from './extension-registry.ts'
import type {
  ExtensionSessionLike,
  ExtensionSessionProvider,
  InstalledExtensionRecord,
  ValidatedExtensionManifest
} from './extension-types.ts'
import { ExtensionStorage } from './extension-storage.ts'
import { ExtensionContributionRegistry } from './extension-contributions.ts'
import type { ExtensionNativeRuntime } from './extension-native-runtime.ts'
import type { ExtensionUiBroker } from './extension-ui-broker.ts'
import { join } from 'node:path'
import { effectiveNativeGrants, hasPendingNativePermissions } from './extension-permissions.ts'
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import semver from 'semver'
import { ExtensionManagedStore, type StagedManagedPackage } from './extension-managed-store.ts'
import { ExtensionHubClient } from './extension-hub-client.ts'
import { TRUSTED_VAST_HUB_KEYS } from './trusted-hub-keys.ts'
import { PRODUCTION_EXTENSION_HUB_ORIGIN } from './extension-hub-config.ts'

const EXTENSION_ID = /^[a-p]{32}$/

interface ExtensionRuntimeStatus {
  loaded: Map<string, string>
  errors: Map<string, string>
  validationError?: string
}

interface PendingPackageInstall {
  token: string
  expiresAt: number
  preview: ExtensionPackagePreview
  staged?: StagedManagedPackage
  descriptor?: SignedVastHubReleaseDescriptor
}

interface PreparedExtensionSurface {
  extensionId: string
  src: string
  partition: string
  runtime: 'chrome' | 'native'
  requiredPermission?: VastNativePermission
  expiresAt: number
}

const PENDING_INSTALL_TTL_MS = 5 * 60_000

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'Unknown extension error.').slice(0, 2_048)
}

function surfaceKey(partition: string, src: string): string {
  return `${partition}\n${src}`
}

function extensionPageUrl(protocol: 'chrome-extension' | 'vast-extension', id: string, path: string): string {
  const encodedPath = path.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/')
  return `${protocol}://${id}/${encodedPath}`
}

function sameRecordMetadata(record: InstalledExtensionRecord, validated: ValidatedExtensionManifest, id: string): boolean {
  return record.id === id &&
    record.path === validated.rootPath &&
    record.name === validated.manifest.name &&
    record.version === validated.manifest.version &&
    record.description === validated.manifest.description &&
    record.manifestVersion === validated.manifest.manifest_version &&
    record.allowFileAccess === false && record.runtime === validated.kind
}

export function isEligibleExtensionPartition(partition: string): boolean {
  return partition === 'persist:vast-default' || /^persist:vast-workspace-[a-z0-9_-]{1,80}$/.test(partition)
}

export function extensionPartitionsForWorkspaces(
  workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'isPrivate' | 'identity'>>
): string[] {
  const partitions = new Set<string>()
  for (const workspace of workspaces) {
    if (workspace.isPrivate) continue
    const identity = resolveWorkspaceIdentity(workspace)
    if (identity.sessionMode === 'ephemeral') continue
    const partition = partitionForWorkspace(workspace)
    if (isEligibleExtensionPartition(partition)) partitions.add(partition)
  }
  return [...partitions].sort()
}

export class ExtensionManager {
  private readonly registry: ExtensionRegistry
  private readonly sessionProvider: ExtensionSessionProvider
  private readonly onChanged?: () => void
  private readonly onContributionsChanged?: (snapshot: VastExtensionContributionSnapshot) => void
  private readonly storage: ExtensionStorage
  private readonly contributions: ExtensionContributionRegistry
  private readonly managedStore: ExtensionManagedStore
  private readonly hubClient: ExtensionHubClient
  private readonly nativeSurfacePreloadPath?: string
  private readonly reloadMatchingTabs?: (patterns: readonly string[]) => void | Promise<void>
  private readonly runtime = new Map<string, ExtensionRuntimeStatus>()
  private readonly manifests = new Map<string, ValidatedExtensionManifest>()
  private readonly sessions = new Map<string, ExtensionSessionLike>()
  private eligiblePartitions = new Set<string>()
  private operationQueue: Promise<void> = Promise.resolve()
  private initialized = false
  private nativeRuntime?: ExtensionNativeRuntime
  private nativeUiBroker?: ExtensionUiBroker
  private nativeStates = new Map<string, VastNativeRuntimeState>()
  private nativeErrors = new Map<string, string>()
  private preparedSurfaces = new Map<string, PreparedExtensionSurface>()
  private surfaceTokens = new Map<string, PreparedExtensionSurface>()
  private boundSurfaces = new Map<number, { extensionId: string; origin: string }>()
  private pendingInstalls = new Map<string, PendingPackageInstall>()

  constructor(options: {
    userDataRoot: string
    sessionProvider: ExtensionSessionProvider
    hubOrigin?: string
    nativeSurfacePreloadPath?: string
    reloadMatchingTabs?: (patterns: readonly string[]) => void | Promise<void>
    onChanged?: () => void
    onContributionsChanged?: (snapshot: VastExtensionContributionSnapshot) => void
  }) {
    this.registry = new ExtensionRegistry(options.userDataRoot)
    this.sessionProvider = options.sessionProvider
    this.onChanged = options.onChanged
    this.onContributionsChanged = options.onContributionsChanged
    this.storage = new ExtensionStorage(options.userDataRoot)
    this.managedStore = new ExtensionManagedStore(options.userDataRoot)
    this.hubClient = new ExtensionHubClient(options.hubOrigin ?? PRODUCTION_EXTENSION_HUB_ORIGIN, TRUSTED_VAST_HUB_KEYS)
    this.nativeSurfacePreloadPath = options.nativeSurfacePreloadPath
    this.reloadMatchingTabs = options.reloadMatchingTabs
    this.contributions = new ExtensionContributionRegistry(
      (id) => this.registry.get(id)?.name ?? 'Extension',
      (snapshot) => this.onContributionsChanged?.(snapshot)
    )
  }

  async initialize(workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'isPrivate' | 'identity'>>): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return
      await Promise.all([this.registry.load(), this.managedStore.initialize()])
      await this.removeLegacyBundledCatalogInstallations()
      this.eligiblePartitions = new Set(extensionPartitionsForWorkspaces(workspaces))
      this.initialized = true

      for (const storedRecord of this.registry.list()) {
        if (!storedRecord.enabled) continue
        try {
          const { record, validated } = await this.refreshRecord(storedRecord)
          await this.loadRecordEverywhere(record, validated)
          await this.startNativeIfAllowed(record, validated)
        } catch (error) {
          this.status(storedRecord.id).validationError = errorMessage(error)
          console.warn(`[extensions] Could not restore ${storedRecord.name}: ${errorMessage(error)}`)
        }
      }
    })
  }

  async syncWorkspaces(workspaces: ReadonlyArray<Pick<Workspace, 'id' | 'isPrivate' | 'identity'>>): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const next = new Set(extensionPartitionsForWorkspaces(workspaces))
      const removed = [...this.eligiblePartitions].filter((partition) => !next.has(partition))
      const added = [...next].filter((partition) => !this.eligiblePartitions.has(partition))
      this.eligiblePartitions = next

      for (const partition of removed) {
        for (const record of this.registry.list()) await this.unloadRecordFromPartition(record.id, partition)
        this.sessions.delete(partition)
      }
      for (const partition of added) await this.loadEnabledForPartition(partition)
      if (removed.length > 0 || added.length > 0) this.onChanged?.()
    })
  }

  async ensureForPartition(partition: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      if (!isEligibleExtensionPartition(partition) || !this.eligiblePartitions.has(partition)) return
      await this.loadEnabledForPartition(partition)
    })
  }

  async list(): Promise<VastExtensionInfo[]> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const result: VastExtensionInfo[] = []
      for (const record of this.registry.list()) result.push(await this.infoFor(record))
      return result
    })
  }

  async installUnpacked(extensionPath: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const validated = await validateExtensionManifest(extensionPath)
      const duplicate = this.registry.findByPath(validated.rootPath)
      if (duplicate) {
        let { record } = await this.refreshRecord(duplicate, validated)
        if (!record.enabled) {
          record = (await this.registry.setEnabled(record.id, true)) ?? record
        }
        await this.loadRecordEverywhere(record, validated)
        await this.startNativeIfAllowed(record, validated)
        this.onChanged?.()
        return this.infoFor(record)
      }

      const id = chromeExtensionId(validated.rootPath, validated.manifest.key)
      const collision = this.registry.get(id)
      if (collision && collision.path !== validated.rootPath) {
        throw new Error('Another installed extension already uses this Chrome extension ID.')
      }
      const now = Date.now()
      let record: InstalledExtensionRecord = {
        id,
        name: validated.manifest.name,
        version: validated.manifest.version,
        ...(validated.manifest.description ? { description: validated.manifest.description } : {}),
        path: validated.rootPath,
        enabled: true,
        source: 'unpacked',
        trust: 'developer',
        updateState: 'not-applicable',
        runtime: validated.kind,
        manifestVersion: validated.manifest.manifest_version,
        installedAt: now,
        updatedAt: now,
        allowFileAccess: false,
        grantedPermissions: []
      }
      await this.registry.upsert(record)
      this.manifests.set(record.id, validated)
      record = await this.loadRecordEverywhere(record, validated)
      await this.startNativeIfAllowed(record, validated)
      this.onChanged?.()
      return this.infoFor(record)
    })
  }

  async prepareLocalPackage(packagePath: string): Promise<ExtensionPackagePreview> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      await this.cleanupPendingInstalls()
      const info = await stat(packagePath)
      if (!info.isFile() || info.size <= 0 || info.size > VEXT_LIMITS.maxCompressedBytes) throw new Error('Extension package is empty or too large.')
      const staged = await this.managedStore.stagePackage(new Uint8Array(await readFile(packagePath)), 'local-vext', TRUSTED_VAST_HUB_KEYS)
      try {
        const validated = await validateExtensionManifest(staged.contentRoot)
        const preview = await this.packagePreview(staged, validated, staged.parsed.metadata.publisher_id ?? 'Local publisher')
        const pending: PendingPackageInstall = { token: preview.token, expiresAt: Date.now() + PENDING_INSTALL_TTL_MS, preview, staged }
        this.pendingInstalls.set(preview.token, pending)
        return preview
      } catch (error) {
        await this.managedStore.discard(staged)
        throw error
      }
    })
  }

  async prepareHubInstall(extensionId: string): Promise<ExtensionPackagePreview> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      await this.cleanupPendingInstalls()
      if (!EXTENSION_ID.test(extensionId)) throw new Error('Invalid extension ID.')
      const existing = this.registry.get(extensionId)
      if (existing && existing.source !== 'hub') throw new Error('Another extension installation already uses this extension ID.')
      const [details, descriptor] = await Promise.all([this.hubClient.details(extensionId), this.hubClient.descriptor(extensionId)])
      if (descriptor.descriptor.publisher_id !== details.publisher.id || descriptor.descriptor.version !== details.version) throw new Error('Vast Extensions returned inconsistent release metadata.')
      const previous = existing ? await this.permissionSnapshotForRecord(existing) : { chrome: [], hosts: [], vast: [] }
      const escalation = permissionEscalation(previous, descriptor.descriptor.permissions)
      const token = randomUUID()
      const preview: ExtensionPackagePreview = {
        token,
        extensionId,
        name: details.name,
        description: details.summary,
        version: descriptor.descriptor.version,
        publisherId: details.publisher.id,
        publisherName: details.publisher.name,
        source: 'hub',
        trust: 'official',
        kind: details.kind,
        permissions: descriptor.descriptor.permissions,
        isUpdate: Boolean(existing),
        permissionEscalation: existing ? escalation : descriptor.descriptor.permissions
      }
      this.pendingInstalls.set(token, { token, expiresAt: Date.now() + PENDING_INSTALL_TTL_MS, preview, descriptor })
      return preview
    })
  }

  async installPrepared(token: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      await this.cleanupPendingInstalls()
      const pending = this.pendingInstalls.get(token)
      if (!pending || pending.expiresAt < Date.now()) throw new Error('Extension installation confirmation expired.')
      this.pendingInstalls.delete(token)
      let staged = pending.staged
      if (pending.descriptor) {
        const bytes = await this.hubClient.download(pending.descriptor)
        staged = await this.managedStore.stagePackage(bytes, 'hub', TRUSTED_VAST_HUB_KEYS)
      }
      if (!staged) throw new Error('Extension package is unavailable.')
      try {
        const validated = await validateExtensionManifest(staged.contentRoot)
        this.assertPreparedPackage(pending, staged, validated)
        return await this.activateManagedPackage(staged, validated, pending.preview.publisherName, true)
      } catch (error) {
        await this.managedStore.discard(staged).catch(() => undefined)
        throw error
      }
    })
  }

  async cancelPrepared(token: string): Promise<void> {
    return this.enqueue(async () => {
      const pending = this.pendingInstalls.get(token)
      this.pendingInstalls.delete(token)
      if (pending?.staged) await this.managedStore.discard(pending.staged)
    })
  }

  async catalog(input: { query?: string; category?: string; page?: number; sort?: 'popular' | 'updated' }): Promise<VastHubCatalogResult> {
    await this.ensureInitialized()
    const installed = new Set(this.registry.list().map((record) => record.id))
    const remote = await this.hubClient.catalog(input)
    return {
      ...remote,
      items: remote.items.map((item) => ({ ...item, installed: installed.has(item.id) })),
      featured: remote.featured.map((item) => ({ ...item, installed: installed.has(item.id) }))
    }
  }

  async catalogDetails(extensionId: string): Promise<VastHubExtensionDetails> {
    await this.ensureInitialized()
    const details = await this.hubClient.details(extensionId)
    return { ...details, installed: Boolean(this.registry.get(extensionId)) }
  }

  async checkForUpdates(extensionId?: string): Promise<VastExtensionInfo[]> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const records = this.registry.list().filter((record) => record.source === 'hub' && (!extensionId || record.id === extensionId))
      if (extensionId && !EXTENSION_ID.test(extensionId)) throw new Error('Invalid extension ID.')
      const results: VastExtensionInfo[] = []
      for (let record of records) {
        let candidate: StagedManagedPackage | undefined
        try {
          record = (await this.registry.patch(record.id, { updateState: 'checking', updateError: undefined, lastUpdateCheckAt: Date.now() })) ?? record
          this.onChanged?.()
          const descriptor = await this.hubClient.descriptor(record.id)
          if (!semver.gt(descriptor.descriptor.version, record.version)) {
            record = (await this.registry.patch(record.id, { updateState: 'up-to-date', availableVersion: undefined, updateError: undefined, lastUpdateCheckAt: Date.now() })) ?? record
          } else if (record.failedUpdateVersion === descriptor.descriptor.version) {
            record = (await this.registry.patch(record.id, { updateState: 'failed', availableVersion: descriptor.descriptor.version, updateError: 'This release previously failed to activate.' })) ?? record
          } else {
            const escalation = permissionEscalation(await this.permissionSnapshotForRecord(record), descriptor.descriptor.permissions)
            if (hasPermissionEscalation(escalation)) {
              record = (await this.registry.patch(record.id, { updateState: 'pending-approval', availableVersion: descriptor.descriptor.version, updateError: undefined })) ?? record
            } else {
              record = (await this.registry.patch(record.id, { updateState: 'updating', availableVersion: descriptor.descriptor.version, updateError: undefined })) ?? record
              const bytes = await this.hubClient.download(descriptor)
              candidate = await this.managedStore.stagePackage(bytes, 'hub', TRUSTED_VAST_HUB_KEYS)
              const validated = await validateExtensionManifest(candidate.contentRoot)
              this.assertDescriptorPackage(descriptor, candidate, validated)
              record = this.registry.get((await this.activateManagedPackage(candidate, validated, record.publisherName ?? record.publisherId ?? 'Verified publisher', false)).id) ?? record
              candidate = undefined
            }
          }
        } catch (error) {
          if (candidate) await this.managedStore.discard(candidate).catch(() => undefined)
          record = (await this.registry.patch(record.id, { updateState: 'failed', updateError: errorMessage(error), lastUpdateCheckAt: Date.now() })) ?? record
        }
        results.push(await this.infoFor(record))
      }
      this.onChanged?.()
      return results
    })
  }

  async approveUpdate(extensionId: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const record = this.requireRecord(extensionId)
      if (record.source !== 'hub' || record.updateState !== 'pending-approval' || !record.availableVersion) throw new Error('This extension has no update awaiting approval.')
      const descriptor = await this.hubClient.descriptor(extensionId)
      if (descriptor.descriptor.version !== record.availableVersion || !semver.gt(descriptor.descriptor.version, record.version)) throw new Error('The pending update is no longer available.')
      const bytes = await this.hubClient.download(descriptor)
      const staged = await this.managedStore.stagePackage(bytes, 'hub', TRUSTED_VAST_HUB_KEYS)
      try {
        const validated = await validateExtensionManifest(staged.contentRoot)
        this.assertDescriptorPackage(descriptor, staged, validated)
        return await this.activateManagedPackage(staged, validated, record.publisherName ?? record.publisherId ?? 'Verified publisher', true)
      } catch (error) {
        await this.managedStore.discard(staged).catch(() => undefined)
        throw error
      }
    })
  }

  async enable(id: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      let record = this.requireRecord(id)
      const changed = !record.enabled
      if (changed) record = (await this.registry.setEnabled(id, true)) ?? record
      const refreshed = await this.refreshRecord(record)
      record = await this.loadRecordEverywhere(refreshed.record, refreshed.validated)
      await this.startNativeIfAllowed(record, refreshed.validated)
      if (changed) await this.reloadContentScriptTabsAfterToggle(record, refreshed.validated)
      this.onChanged?.()
      return this.infoFor(record)
    })
  }

  async disable(id: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      let record = this.requireRecord(id)
      const changed = record.enabled
      if (changed) record = (await this.registry.setEnabled(id, false)) ?? record
      const validated = this.manifests.get(record.id) ?? await validateExtensionManifest(record.path)
      await this.stopNative(record.id, 'stopped')
      await this.unloadRecordEverywhere(record.id)
      this.status(record.id).errors.clear()
      if (changed) await this.reloadContentScriptTabsAfterToggle(record, validated)
      this.onChanged?.()
      return this.infoFor(record)
    })
  }

  async reload(id: string): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const previous = this.requireRecord(id)
      await this.stopNative(previous.id, 'stopped')
      await this.unloadRecordEverywhere(previous.id)
      const refreshed = await this.refreshRecord(previous)
      const record = refreshed.record.enabled
        ? await this.loadRecordEverywhere(refreshed.record, refreshed.validated)
        : refreshed.record
      if (record.enabled) await this.startNativeIfAllowed(record, refreshed.validated)
      this.onChanged?.()
      return this.infoFor(record)
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      await this.ensureInitialized()
      const record = this.registry.get(id)
      if (!record) return false
      const validated = record.source === 'hub' || record.source === 'bundled'
        ? this.manifests.get(record.id) ?? await validateExtensionManifest(record.path)
        : undefined
      await this.stopNative(id, 'stopped')
      await this.unloadRecordEverywhere(id)
      const removed = await this.registry.remove(id)
      this.runtime.delete(id)
      this.manifests.delete(id)
      this.nativeStates.delete(id)
      this.nativeErrors.delete(id)
      await this.storage.removeAll(id)
      if (record.source !== 'unpacked' && record.source !== 'bundled') await this.managedStore.remove(id)
      if (validated) await this.reloadContentScriptTabsAfterToggle(record, validated)
      if (removed) this.onChanged?.()
      return removed
    })
  }

  async flush(): Promise<void> {
    await this.operationQueue.catch(() => undefined)
  }

  async approvePermissions(id: string, permissions: VastNativePermission[]): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      const record = this.requireRecord(id)
      const validated = await validateExtensionManifest(record.path)
      if (!validated.vast || validated.nativeCompatibilityError) throw new Error(validated.nativeCompatibilityError ?? 'Extension has no Vast-native runtime.')
      const requested = validated.vast.permissions
      if (!Array.isArray(permissions) || permissions.some((permission) => !requested.includes(permission))) throw new Error('Cannot grant a permission the extension did not request.')
      const next = await this.registry.setGrantedPermissions(id, permissions)
      if (!next) throw new Error('Extension is not installed.')
      this.manifests.set(id, validated)
      if (next.enabled) await this.startNativeIfAllowed(next, validated)
      this.onChanged?.()
      return this.infoFor(next)
    })
  }

  async setPermission(id: string, permission: VastNativePermission, granted: boolean): Promise<VastExtensionInfo> {
    return this.enqueue(async () => {
      const record = this.requireRecord(id); const validated = await validateExtensionManifest(record.path)
      if (!validated.vast?.permissions.includes(permission)) throw new Error('Extension does not request this permission.')
      const grants = new Set(record.grantedPermissions)
      if (granted) grants.add(permission); else { grants.delete(permission); this.contributions.removePermission(id, permission) }
      const next = await this.registry.setGrantedPermissions(id, [...grants])
      if (!next) throw new Error('Extension is not installed.')
      this.nativeRuntime?.updateAuthority(next, validated)
      if (next.enabled && this.allPermissionsGranted(next, validated)) await this.startNativeIfAllowed(next, validated)
      this.onChanged?.()
      return this.infoFor(next)
    })
  }

  contributionSnapshot(): VastExtensionContributionSnapshot { return this.contributions.snapshot() }

  async prepareSurface(id: string, kind: VastExtensionSurfaceKind, workspacePartition: string): Promise<VastExtensionSurface | undefined> {
    this.cleanupPreparedSurfaces()
    const record = this.requireRecord(id)
    if (!record.enabled) throw new Error('Enable the extension before opening its interface.')
    const manifest = this.manifests.get(record.id) ?? await validateExtensionManifest(record.path)
    this.manifests.set(record.id, manifest)
    const declared = manifest.ui[kind]
    if (!declared) return undefined

    let src: string
    let partition: string
    if (declared.runtime === 'native') {
      if (!manifest.vast || manifest.nativeCompatibilityError || !this.allPermissionsGranted(record, manifest)) {
        throw new Error('Approve the extension permissions before opening its interface.')
      }
      partition = `vast-native-surface-${record.id}-${kind}`
      src = extensionPageUrl('vast-extension', record.id, declared.path)
      const runtime = await this.ensureNativeRuntime()
      await runtime.prepareSurfaceSession(partition, record.id, manifest)
    } else {
      if (!isEligibleExtensionPartition(workspacePartition) || !this.eligiblePartitions.has(workspacePartition)) {
        throw new Error('Extension interfaces are unavailable in private or temporary workspaces.')
      }
      const actualId = await this.loadRecordIntoPartition(record, manifest, workspacePartition)
      partition = workspacePartition
      src = extensionPageUrl('chrome-extension', actualId, declared.path)
    }

    const prepared: PreparedExtensionSurface = {
      extensionId: record.id,
      src,
      partition,
      runtime: declared.runtime,
      expiresAt: Date.now() + 30_000
    }
    this.preparedSurfaces.set(surfaceKey(partition, src), prepared)
    return { src, partition, kind, runtime: declared.runtime }
  }

  async prepareSidebar(key: string): Promise<{ src: string; partition: string }> {
    this.cleanupPreparedSurfaces()
    const owner = this.contributions.ownerFor(key)
    if (!owner || owner.type !== 'sidebar') throw new Error('Extension sidebar is unavailable.')
    const record = this.requireRecord(owner.extensionId)
    const manifest = this.manifests.get(record.id) ?? await validateExtensionManifest(record.path)
    if (!record.enabled || !record.grantedPermissions.includes('vast.sidebar') || !manifest.vast) throw new Error('Extension sidebar is not authorized.')
    const panel = this.contributions.snapshot().sidebar.find((item) => item.key === key)
    if (!panel) throw new Error('Extension sidebar is unavailable.')
    const partition = `vast-native-surface-${record.id}-${owner.localId.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`
    const runtime = await this.ensureNativeRuntime()
    await runtime.prepareSurfaceSession(partition, record.id, manifest)
    const prepared: PreparedExtensionSurface = {
      extensionId: record.id,
      src: panel.resourceUrl,
      partition,
      runtime: 'native',
      requiredPermission: 'vast.sidebar',
      expiresAt: Date.now() + 30_000
    }
    this.preparedSurfaces.set(surfaceKey(partition, panel.resourceUrl), prepared)
    return { src: panel.resourceUrl, partition }
  }

  authorizeSurfaceAttachment(src: string, partition: string): { preload?: string; token: string } | undefined {
    const key = surfaceKey(partition, src)
    const prepared = this.preparedSurfaces.get(key)
    if (!prepared || prepared.expiresAt < Date.now()) return undefined
    this.preparedSurfaces.delete(key)
    const token = randomUUID()
    this.surfaceTokens.set(token, prepared)
    return prepared.runtime === 'native'
      ? { ...(this.nativeSurfacePreloadPath ? { preload: this.nativeSurfacePreloadPath } : {}), token }
      : { token }
  }

  bindPreparedSurface(contents: import('electron/main').WebContents, token: string): boolean {
    const prepared = this.surfaceTokens.get(token)
    this.surfaceTokens.delete(token)
    if (!prepared || prepared.expiresAt < Date.now()) return false
    const record = this.registry.get(prepared.extensionId)
    const manifest = record ? this.manifests.get(record.id) : undefined
    if (!record || !manifest || !record.enabled) return false
    const target = new URL(prepared.src)
    if (prepared.runtime === 'native') {
      if (!manifest.vast || !this.nativeRuntime || !this.allPermissionsGranted(record, manifest)) return false
      if (prepared.requiredPermission && !record.grantedPermissions.includes(prepared.requiredPermission)) return false
      this.nativeRuntime.bindSurface(contents, record, manifest)
    } else {
      const actualId = this.status(record.id).loaded.get(prepared.partition)
      if (!actualId || target.protocol !== 'chrome-extension:' || target.hostname !== actualId) return false
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const guard = (event: import('electron/main').Event, url: string): void => {
        try { if (new URL(url).origin !== target.origin) event.preventDefault() } catch { event.preventDefault() }
      }
      contents.on('will-navigate', guard)
      contents.on('will-redirect', guard)
    }
    this.boundSurfaces.set(contents.id, { extensionId: record.id, origin: target.origin })
    contents.once('destroyed', () => this.boundSurfaces.delete(contents.id))
    return true
  }

  isAllowedSurfaceNavigation(contents: import('electron/main').WebContents, url: string): boolean {
    const surface = this.boundSurfaces.get(contents.id)
    if (!surface) return false
    try { return new URL(url).origin === surface.origin } catch { return false }
  }

  dispatchContribution(key: string, context?: Record<string, unknown>): boolean {
    const owner = this.contributions.ownerFor(key)
    if (!owner) return false
    const event = owner.type === 'toolbar' ? 'toolbar.onClicked' : owner.type === 'commands' ? 'commands.onCommand' : owner.type === 'contextMenus' ? 'contextMenus.onClicked' : undefined
    if (!event) return false
    const payload = owner.type === 'contextMenus' ? { menuItemId: owner.localId, ...(context ?? {}) } : { id: owner.localId }
    this.nativeRuntime?.send(owner.extensionId, event, payload)
    return true
  }

  emitTabEvent(name: 'tabs.onActivated' | 'tabs.onCreated' | 'tabs.onUpdated' | 'tabs.onRemoved', payload: unknown): void {
    for (const record of this.registry.list()) {
      if (record.enabled && record.grantedPermissions.includes('vast.tabs.read')) this.nativeRuntime?.send(record.id, name, payload)
    }
  }

  respondToUiRequest(sender: import('electron/main').WebContents, response: VastUiBrokerResponse): boolean { return this.nativeUiBroker?.respond(sender, response) ?? false }

  async shutdown(): Promise<void> {
    for (const pending of this.pendingInstalls.values()) if (pending.staged) await this.managedStore.discard(pending.staged).catch(() => undefined)
    this.pendingInstalls.clear()
    this.nativeUiBroker?.shutdown()
    await this.nativeRuntime?.shutdown()
    this.nativeRuntime = undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.catch(() => undefined).then(operation)
    this.operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) throw new Error('Extension manager is not initialized.')
  }

  private requireRecord(id: string): InstalledExtensionRecord {
    if (!EXTENSION_ID.test(id)) throw new Error('Invalid extension ID.')
    const record = this.registry.get(id)
    if (!record) throw new Error('Extension is not installed.')
    return record
  }

  private status(id: string): ExtensionRuntimeStatus {
    let status = this.runtime.get(id)
    if (!status) {
      status = { loaded: new Map(), errors: new Map() }
      this.runtime.set(id, status)
    }
    return status
  }

  private allPermissionsGranted(record: InstalledExtensionRecord, validated: ValidatedExtensionManifest): boolean {
    const native = validated.vast
    return Boolean(native && !hasPendingNativePermissions(native.permissions, record.grantedPermissions))
  }

  private async ensureNativeRuntime(): Promise<ExtensionNativeRuntime> {
    if (this.nativeRuntime) return this.nativeRuntime
    const [{ ExtensionResourceProtocol }, { ExtensionUiBroker }, { ExtensionCapabilityBroker }, { ExtensionNativeRuntime }] = await Promise.all([
      import('./extension-resource-protocol.ts'), import('./extension-ui-broker.ts'), import('./extension-capability-broker.ts'), import('./extension-native-runtime.ts')
    ])
    const resources = new ExtensionResourceProtocol()
    const ui = new ExtensionUiBroker()
    let runtime: ExtensionNativeRuntime | undefined
    const broker = new ExtensionCapabilityBroker((sender) => runtime?.authorityFor(sender), this.storage, this.contributions, ui)
    runtime = new ExtensionNativeRuntime(resources, broker, (id, state, error) => {
      this.nativeStates.set(id, state)
      if (error) this.nativeErrors.set(id, error); else this.nativeErrors.delete(id)
      if (state === 'error' || state === 'stopped') this.contributions.removeExtension(id)
      this.onChanged?.()
    })
    runtime.registerIpc()
    this.nativeUiBroker = ui
    this.nativeRuntime = runtime
    return runtime
  }

  private async startNativeIfAllowed(record: InstalledExtensionRecord, validated: ValidatedExtensionManifest): Promise<void> {
    if (!validated.vast) { this.nativeStates.set(record.id, 'not-applicable'); return }
    if (validated.nativeCompatibilityError) {
      this.nativeStates.set(record.id, 'error'); this.nativeErrors.set(record.id, validated.nativeCompatibilityError); return
    }
    if (!this.allPermissionsGranted(record, validated)) {
      this.nativeStates.set(record.id, 'pending-permission'); this.contributions.removeExtension(record.id); return
    }
    const runtime = await this.ensureNativeRuntime()
    await runtime.start(record, validated)
  }

  private async stopNative(id: string, nextState: VastNativeRuntimeState): Promise<void> {
    await this.nativeRuntime?.stop(id)
    this.contributions.removeExtension(id)
    this.nativeStates.set(id, nextState)
    this.nativeErrors.delete(id)
    for (const [key, prepared] of this.preparedSurfaces) if (prepared.extensionId === id) this.preparedSurfaces.delete(key)
    for (const [token, prepared] of this.surfaceTokens) if (prepared.extensionId === id) this.surfaceTokens.delete(token)
    for (const [contentsId, surface] of this.boundSurfaces) if (surface.extensionId === id) this.boundSurfaces.delete(contentsId)
  }

  private cleanupPreparedSurfaces(): void {
    const now = Date.now()
    for (const [key, prepared] of this.preparedSurfaces) if (prepared.expiresAt < now) this.preparedSurfaces.delete(key)
    for (const [token, prepared] of this.surfaceTokens) if (prepared.expiresAt < now) this.surfaceTokens.delete(token)
  }

  private permissionSnapshot(validated: ValidatedExtensionManifest): ExtensionPermissionSnapshot {
    return {
      chrome: [...validated.permissions].sort(),
      hosts: [...validated.hostPermissions].sort(),
      vast: [...(validated.vast?.permissions ?? [])].sort()
    }
  }

  private async permissionSnapshotForRecord(record: InstalledExtensionRecord): Promise<ExtensionPermissionSnapshot> {
    const validated = this.manifests.get(record.id) ?? await validateExtensionManifest(record.path)
    return this.permissionSnapshot(validated)
  }

  private samePermissions(left: ExtensionPermissionSnapshot, right: ExtensionPermissionSnapshot): boolean {
    const sorted = (snapshot: ExtensionPermissionSnapshot): ExtensionPermissionSnapshot => ({
      chrome: [...new Set(snapshot.chrome)].sort(),
      hosts: [...new Set(snapshot.hosts.map((host) => host.toLowerCase().replace(/\/$/, '')))].sort(),
      vast: [...new Set(snapshot.vast)].sort()
    })
    return canonicalJson(sorted(left)) === canonicalJson(sorted(right))
  }

  private async packagePreview(staged: StagedManagedPackage, validated: ValidatedExtensionManifest, publisherName: string): Promise<ExtensionPackagePreview> {
    const metadata = staged.parsed.metadata
    if (validated.manifest.version !== metadata.version) throw new Error('Package version does not match its manifest.')
    if (validated.vast?.extension_id && validated.vast.extension_id !== metadata.extension_id) throw new Error('Package identity does not match its manifest.')
    const existing = this.registry.get(metadata.extension_id)
    if (existing?.source === 'unpacked') throw new Error('A developer extension already uses this extension ID.')
    if (existing?.source === 'bundled') throw new Error('Extensions included with Vast cannot be replaced by a package.')
    if (existing?.source === 'hub' && staged.source !== 'hub') throw new Error('A local package cannot replace an extension installed from Vast Extensions.')
    if (existing && semver.lt(metadata.version, existing.version)) throw new Error('Extension package downgrade is not allowed.')
    if (existing?.publisherId && metadata.publisher_id && existing.publisherId !== metadata.publisher_id) throw new Error('Extension publisher identity does not match the installed extension.')
    const permissions = this.permissionSnapshot(validated)
    const previous = existing ? await this.permissionSnapshotForRecord(existing) : { chrome: [], hosts: [], vast: [] }
    return {
      token: randomUUID(),
      extensionId: metadata.extension_id,
      name: validated.manifest.name,
      ...(validated.manifest.description ? { description: validated.manifest.description } : {}),
      version: metadata.version,
      ...(metadata.publisher_id ? { publisherId: metadata.publisher_id } : {}),
      publisherName,
      source: staged.source,
      trust: staged.source === 'hub' || Boolean(staged.parsed.verifiedKeyId) ? 'official' : 'local',
      kind: validated.kind,
      permissions,
      isUpdate: Boolean(existing),
      permissionEscalation: existing ? permissionEscalation(previous, permissions) : permissions
    }
  }

  private assertPreparedPackage(pending: PendingPackageInstall, staged: StagedManagedPackage, validated: ValidatedExtensionManifest): void {
    const metadata = staged.parsed.metadata
    if (pending.preview.extensionId !== metadata.extension_id || pending.preview.version !== metadata.version || pending.preview.source !== staged.source) throw new Error('Prepared extension package identity changed.')
    if (!this.samePermissions(pending.preview.permissions, this.permissionSnapshot(validated))) throw new Error('Prepared extension package permissions changed.')
    if (pending.descriptor) this.assertDescriptorPackage(pending.descriptor, staged, validated)
  }

  private assertDescriptorPackage(descriptor: SignedVastHubReleaseDescriptor, staged: StagedManagedPackage, validated: ValidatedExtensionManifest): void {
    const expected = descriptor.descriptor
    const metadata = staged.parsed.metadata
    if (staged.source !== 'hub' || !staged.parsed.verifiedKeyId || expected.extension_id !== metadata.extension_id || expected.publisher_id !== metadata.publisher_id || expected.version !== metadata.version || expected.sha256 !== staged.parsed.packageSha256 || expected.key_id !== staged.parsed.verifiedKeyId) {
      throw new Error('Verified release metadata does not match the extension package.')
    }
    if (!this.samePermissions(expected.permissions, this.permissionSnapshot(validated))) throw new Error('Signed release permissions do not match the extension package.')
  }

  private async activateManagedPackage(staged: StagedManagedPackage, validated: ValidatedExtensionManifest, publisherName: string, approveRequestedPermissions: boolean): Promise<VastExtensionInfo> {
    const metadata = staged.parsed.metadata
    const previous = this.registry.get(metadata.extension_id)
    if (previous?.source === 'unpacked' || previous?.source === 'bundled' || (previous?.source === 'hub' && staged.source !== 'hub')) throw new Error('Managed extension source cannot replace this installation.')
    if (previous?.publisherId && previous.publisherId !== metadata.publisher_id) throw new Error('Extension publisher identity does not match the installed extension.')
    if (previous && semver.lt(metadata.version, previous.version)) throw new Error('Extension package downgrade is not allowed.')
    const destination = await this.managedStore.commit(staged)
    try {
      validated = await validateExtensionManifest(destination)
    } catch (error) {
      if (!previous || metadata.version !== previous.version) await this.managedStore.removeVersion(metadata.extension_id, metadata.version).catch(() => undefined)
      throw new Error(`Extension activation failed before runtime startup. ${errorMessage(error)}`)
    }
    const now = Date.now()
    const grantedPermissions = approveRequestedPermissions
      ? [...(validated.vast?.permissions ?? [])]
      : effectiveNativeGrants(validated.vast?.permissions ?? [], previous?.grantedPermissions ?? [])
    const record: InstalledExtensionRecord = {
      id: metadata.extension_id,
      name: validated.manifest.name,
      version: validated.manifest.version,
      ...(validated.manifest.description ? { description: validated.manifest.description } : {}),
      path: destination,
      enabled: previous?.enabled ?? true,
      source: staged.source,
      trust: staged.source === 'hub' || Boolean(staged.parsed.verifiedKeyId) ? 'official' : 'local',
      ...(metadata.publisher_id ? { publisherId: metadata.publisher_id } : {}),
      publisherName,
      packageSha256: staged.parsed.packageSha256,
      ...(staged.parsed.verifiedKeyId ? { signatureKeyId: staged.parsed.verifiedKeyId } : {}),
      ...(previous && previous.version !== metadata.version ? { previousVersion: previous.version } : previous?.previousVersion ? { previousVersion: previous.previousVersion } : {}),
      updateState: staged.source === 'hub' ? 'up-to-date' : 'not-applicable',
      runtime: validated.kind,
      manifestVersion: validated.manifest.manifest_version,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      allowFileAccess: false,
      grantedPermissions
    }
    if (previous) {
      await this.stopNative(previous.id, 'stopped')
      await this.unloadRecordEverywhere(previous.id)
    }
    await this.registry.upsert(record)
    this.manifests.set(record.id, validated)
    try {
      if (record.enabled) {
        await this.loadRecordEverywhere(record, validated)
        await this.startNativeIfAllowed(record, validated)
      }
      const info = await this.infoFor(record)
      const chromeFailed = validated.kind !== 'vast' && info.chrome.state === 'error'
      const nativeFailed = Boolean(validated.vast) && info.native.state === 'error'
      if (chromeFailed || nativeFailed) throw new Error(info.native.error ?? info.chrome.error ?? 'Extension runtime stopped unexpectedly.')
      await this.managedStore.activate(staged)
      this.onChanged?.()
      return info
    } catch (error) {
      await this.stopNative(record.id, 'stopped')
      await this.unloadRecordEverywhere(record.id)
      if (previous) {
        await this.registry.upsert(previous)
        const previousManifest = await validateExtensionManifest(previous.path)
        this.manifests.set(previous.id, previousManifest)
        if (previous.enabled) {
          await this.loadRecordEverywhere(previous, previousManifest)
          await this.startNativeIfAllowed(previous, previousManifest)
        }
        await this.managedStore.markFailed(previous.id, metadata.version)
        await this.registry.patch(previous.id, {
          failedUpdateVersion: metadata.version,
          updateState: previous.source === 'hub' ? 'failed' : previous.updateState,
          updateError: errorMessage(error)
        })
        if (metadata.version !== previous.version) await this.managedStore.removeVersion(record.id, metadata.version).catch(() => undefined)
      } else {
        await this.registry.remove(record.id)
        await this.managedStore.remove(record.id).catch(() => undefined)
      }
      this.onChanged?.()
      throw new Error(`Extension activation failed; the previous version was restored. ${errorMessage(error)}`)
    }
  }

  private async cleanupPendingInstalls(): Promise<void> {
    const now = Date.now()
    const expired = [...this.pendingInstalls.values()].filter((pending) => pending.expiresAt < now)
    for (const pending of expired) {
      this.pendingInstalls.delete(pending.token)
      if (pending.staged) await this.managedStore.discard(pending.staged).catch(() => undefined)
    }
  }

  private async removeLegacyBundledCatalogInstallations(): Promise<void> {
    for (const record of this.registry.list()) {
      if (record.source === 'bundled') await this.registry.remove(record.id)
    }
  }

  private async reloadContentScriptTabsAfterToggle(record: InstalledExtensionRecord, validated: ValidatedExtensionManifest): Promise<void> {
    if ((record.source !== 'hub' && record.source !== 'bundled') || !this.reloadMatchingTabs) return
    const patterns = [...new Set((validated.manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? []))]
    if (patterns.length === 0) return
    try {
      await this.reloadMatchingTabs(patterns)
    } catch (error) {
      console.warn(`[extensions:lifecycle] Could not refresh matching tabs for ${record.name}: ${errorMessage(error)}`)
    }
  }

  private sessionFor(partition: string): ExtensionSessionLike {
    if (!isEligibleExtensionPartition(partition) || !this.eligiblePartitions.has(partition)) {
      throw new Error('Extension loading is not allowed for this browser partition.')
    }
    let targetSession = this.sessions.get(partition)
    if (!targetSession) {
      targetSession = this.sessionProvider(partition)
      if (!targetSession.isPersistent()) throw new Error('Extensions require a persistent browser session.')
      this.sessions.set(partition, targetSession)
    }
    return targetSession
  }

  private async refreshRecord(
    storedRecord: InstalledExtensionRecord,
    suppliedManifest?: ValidatedExtensionManifest
  ): Promise<{ record: InstalledExtensionRecord; validated: ValidatedExtensionManifest }> {
    const validated = suppliedManifest ?? await validateExtensionManifest(storedRecord.path)
    const id = storedRecord.id
    let record = storedRecord
    if (!sameRecordMetadata(storedRecord, validated, id)) {
      record = {
        ...storedRecord,
        id,
        name: validated.manifest.name,
        version: validated.manifest.version,
        ...(validated.manifest.description ? { description: validated.manifest.description } : { description: undefined }),
        path: validated.rootPath,
        manifestVersion: validated.manifest.manifest_version,
        runtime: validated.kind,
        grantedPermissions: effectiveNativeGrants(validated.vast?.permissions ?? [], storedRecord.grantedPermissions),
        updatedAt: Date.now(),
        allowFileAccess: false
      }
      await this.registry.upsert(record, storedRecord.id)
      if (storedRecord.id !== id) this.moveRuntimeState(storedRecord.id, id)
    }
    this.manifests.set(id, validated)
    if (record.grantedPermissions.some((permission) => !(validated.vast?.permissions.includes(permission) ?? false))) {
      record = (await this.registry.setGrantedPermissions(id, effectiveNativeGrants(validated.vast?.permissions ?? [], record.grantedPermissions))) ?? record
    }
    this.status(id).validationError = undefined
    return { record, validated }
  }

  private moveRuntimeState(previousId: string, nextId: string): void {
    if (previousId === nextId) return
    const status = this.runtime.get(previousId)
    const manifest = this.manifests.get(previousId)
    if (status) {
      this.runtime.set(nextId, status)
      this.runtime.delete(previousId)
    }
    if (manifest) {
      this.manifests.set(nextId, manifest)
      this.manifests.delete(previousId)
    }
  }

  private async loadEnabledForPartition(partition: string): Promise<void> {
    for (const storedRecord of this.registry.list()) {
      if (!storedRecord.enabled) continue
      try {
        const refreshed = await this.refreshRecord(storedRecord)
        if (refreshed.validated.kind !== 'vast') await this.loadRecordIntoPartition(refreshed.record, refreshed.validated, partition)
      } catch (error) {
        this.status(storedRecord.id).errors.set(partition, errorMessage(error))
        console.warn(`[extensions] Could not load ${storedRecord.name} into a workspace session: ${errorMessage(error)}`)
      }
    }
  }

  private async loadRecordEverywhere(
    initialRecord: InstalledExtensionRecord,
    validated: ValidatedExtensionManifest
  ): Promise<InstalledExtensionRecord> {
    let record = initialRecord
    if (validated.kind === 'vast') {
      this.status(record.id).loaded.clear()
      this.status(record.id).errors.clear()
      return record
    }
    const partitions = [...this.eligiblePartitions].sort()
    if (partitions.length === 0) {
      this.status(record.id).validationError = 'No persistent Vast workspace is available. Extensions stay disabled in private workspaces.'
      return record
    }
    for (const partition of partitions) {
      try {
        const actualId = await this.loadRecordIntoPartition(record, validated, partition)
        if (!actualId) throw new Error('Electron did not return an extension runtime ID.')
      } catch (error) {
        this.status(record.id).errors.set(partition, errorMessage(error))
        console.warn(`[extensions] Could not load ${record.name} into a workspace session: ${errorMessage(error)}`)
      }
    }
    return record
  }

  private async loadRecordIntoPartition(
    record: InstalledExtensionRecord,
    validated: ValidatedExtensionManifest,
    partition: string
  ): Promise<string> {
    const status = this.status(record.id)
    const targetSession = this.sessionFor(partition)
    const loadedId = status.loaded.get(partition)
    if (loadedId && targetSession.extensions.getExtension(loadedId)) {
      status.errors.delete(partition)
      return loadedId
    }
    const extension = await targetSession.extensions.loadExtension(validated.rootPath, { allowFileAccess: false })
    status.loaded.set(partition, extension.id)
    status.errors.delete(partition)
    status.validationError = undefined
    return extension.id
  }

  private async unloadRecordEverywhere(id: string): Promise<void> {
    const status = this.status(id)
    for (const partition of [...status.loaded.keys()]) await this.unloadRecordFromPartition(id, partition)
  }

  private async unloadRecordFromPartition(id: string, partition: string): Promise<void> {
    const status = this.status(id)
    const extensionId = status.loaded.get(partition)
    if (!extensionId) return
    try {
      const targetSession = this.sessions.get(partition)
      if (targetSession?.extensions.getExtension(extensionId)) targetSession.extensions.removeExtension(extensionId)
      status.errors.delete(partition)
    } catch (error) {
      status.errors.set(partition, errorMessage(error))
    } finally {
      status.loaded.delete(partition)
    }
  }

  private async infoFor(record: InstalledExtensionRecord): Promise<VastExtensionInfo> {
    let validated = this.manifests.get(record.id)
    const status = this.status(record.id)
    try {
      validated = await validateExtensionManifest(record.path)
      this.manifests.set(record.id, validated)
      status.validationError = undefined
    } catch (error) {
      status.validationError = errorMessage(error)
    }

    const compatibility = validated && validated.kind === 'vast'
      ? { compatibility: validated.nativeCompatibilityError ? 'unsupported' as const : 'compatible' as const, summary: validated.nativeCompatibilityError ?? 'Built for the Vast Native Extension API.', warnings: validated.nativeCompatibilityError ? [validated.nativeCompatibilityError] : [] }
      : validated
      ? analyzeExtensionCompatibility(validated)
      : {
          compatibility: 'unsupported' as const,
          summary: 'The unpacked extension directory or manifest is unavailable.',
          warnings: []
        }
    const partitionErrors = [...status.errors.values()]
    const error = status.validationError ?? (partitionErrors.length > 0 ? [...new Set(partitionErrors)].join(' ') : undefined)
    const loadedSessionCount = [...status.loaded.keys()].filter((partition) => this.eligiblePartitions.has(partition)).length
    const eligibleSessionCount = this.eligiblePartitions.size
    const chromeApplicable = validated?.kind !== 'vast'
    const chromeState = !chromeApplicable || !record.enabled ? 'disabled' : error && (loadedSessionCount === 0 || status.validationError)
      ? 'error'
      : 'loaded'
    const nativeState = !validated?.vast ? 'not-applicable' : !record.enabled ? 'stopped' : this.nativeStates.get(record.id) ?? (validated.nativeCompatibilityError ? 'error' : this.allPermissionsGranted(record, validated) ? 'stopped' : 'pending-permission')
    const nativeError = validated?.nativeCompatibilityError ?? this.nativeErrors.get(record.id)
    const runtimeState = error && (loadedSessionCount === 0 || status.validationError) && nativeState !== 'running'
      ? 'error'
      : record.enabled
        ? 'loaded'
        : 'disabled'

    return {
      id: record.id,
      name: record.name,
      version: record.version,
      ...(record.description ? { description: record.description } : {}),
      path: record.path,
      enabled: record.enabled,
      source: record.source,
      trust: record.trust,
      ...(record.publisherId ? { publisherId: record.publisherId } : {}),
      ...(record.publisherName ? { publisherName: record.publisherName } : {}),
      ...(record.category ? { category: record.category } : {}),
      firstParty: record.source === 'bundled',
      removable: true,
      update: {
        state: record.updateState,
        ...(record.availableVersion ? { availableVersion: record.availableVersion } : {}),
        ...(record.previousVersion ? { previousVersion: record.previousVersion } : {}),
        ...(record.lastUpdateCheckAt ? { lastCheckedAt: record.lastUpdateCheckAt } : {}),
        ...(record.updateError ? { error: record.updateError } : {})
      },
      runtime: record.runtime,
      kind: validated?.kind ?? record.runtime,
      manifestVersion: record.manifestVersion,
      compatibility: compatibility.compatibility,
      compatibilitySummary: compatibility.summary,
      compatibilityWarnings: compatibility.warnings,
      permissions: validated?.permissions ?? [],
      hostPermissions: validated?.hostPermissions ?? [],
      runtimeState,
      loadedSessionCount,
      eligibleSessionCount,
      chrome: { state: chromeState, loadedSessionCount, eligibleSessionCount, ...(error ? { error } : {}) },
      native: {
        state: nativeState,
        ...(validated?.vast ? { apiVersion: validated.vast.api_version } : {}),
        requestedPermissions: validated?.vast?.permissions ?? [],
        grantedPermissions: record.grantedPermissions.filter((permission) => validated?.vast?.permissions.includes(permission) ?? false),
        permissionDetails: (validated?.vast?.permissions ?? []).map((permission) => VAST_PERMISSION_METADATA[permission]),
        ...(nativeError ? { error: nativeError } : {})
      },
      ui: {
        popup: Boolean(validated?.ui.popup),
        options: Boolean(validated?.ui.options)
      },
      ...(error ? { error } : {}),
      ...(validated?.iconDataUrl ? { iconDataUrl: validated.iconDataUrl } : {}),
      installedAt: record.installedAt,
      updatedAt: record.updatedAt
    }
  }
}
