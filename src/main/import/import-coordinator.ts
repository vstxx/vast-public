import { randomUUID } from 'node:crypto'
import {
  BROWSER_IMPORT_DATA_TYPES, BROWSER_IMPORT_SOURCE_IDS,
  type BrowserImportCommitReceipt, type BrowserImportCommitRequest, type BrowserImportDataType,
  type BrowserImportExtensionConfirmRequest, type BrowserImportExtensionPreparation, type BrowserImportExtensionReceipt,
  type BrowserImportPrepareRequest, type BrowserImportPreview, type BrowserImportSourceId,
  type BrowserImportStatus, type BrowserSourceSnapshot
} from '../../shared/browser-import.ts'
import type { PersistedData } from '../../shared/types.ts'
import type { ExtensionPackagePreview, ExtensionPermissionSnapshot } from '../../shared/extension-marketplace.ts'
import type { VastExtensionInfo } from '../../shared/types.ts'
import { mergeImportCandidate } from './import-merge.ts'
import type { ResolvedImportSource } from './profile-discovery.ts'

const PREVIEW_TTL_MS = 10 * 60_000

export interface ImportCoordinatorDependencies {
  resolveProfile: (sourceId: BrowserImportSourceId, profileId: string) => Promise<ResolvedImportSource>
  readSource: (source: ResolvedImportSource, types: readonly BrowserImportDataType[], signal: AbortSignal) => Promise<BrowserSourceSnapshot>
  loadData: () => Promise<PersistedData>
  commitData: (
    operationId: string,
    merge: (current: PersistedData) => { data: PersistedData; receipt: BrowserImportCommitReceipt }
  ) => Promise<{ data: PersistedData; receipt: BrowserImportCommitReceipt; generation: number }>
  extensionManager?: {
    list: () => Promise<VastExtensionInfo[]>
    prepareLocalChromiumImport: (input: { profilePath: string; sourceExtensionId: string; version: string; fingerprint: string; sourceEnabled: boolean }) => Promise<ExtensionPackagePreview>
    confirmLocalChromiumImport: (token: string, approval: ExtensionPermissionSnapshot) => Promise<VastExtensionInfo>
    cancelPrepared: (token: string) => Promise<void>
  }
  recordExtensionResult?: (operationId: string, result: BrowserImportExtensionReceipt) => Promise<BrowserImportExtensionReceipt>
  now?: () => number
  token?: () => string
}

interface ActivePreview {
  source: ResolvedImportSource
  snapshot: BrowserSourceSnapshot
  preview: BrowserImportPreview
}

function assertRequest(input: BrowserImportPrepareRequest): void {
  if (!input || typeof input !== 'object' || !BROWSER_IMPORT_SOURCE_IDS.includes(input.sourceId) ||
      typeof input.profileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/.test(input.profileId) ||
      !Array.isArray(input.types) || input.types.length === 0 || input.types.length > BROWSER_IMPORT_DATA_TYPES.length ||
      input.types.some((type) => !BROWSER_IMPORT_DATA_TYPES.includes(type)) ||
      new Set(input.types).size !== input.types.length ||
      (input.sourceId === 'firefox' && input.types.includes('extensions'))) {
    throw new Error('Invalid browser import request.')
  }
}

function clonePreview(preview: BrowserImportPreview): BrowserImportPreview {
  return structuredClone(preview)
}

function extensionFailure(error: unknown): { status: 'unsupported' | 'failed'; message: string } {
  const detail = error instanceof Error ? error.message : ''
  // Never persist a raw worker/FS error: it can contain source profile paths.
  const known: Array<[RegExp, 'unsupported' | 'failed', string]> = [
    [/public key|original ID|source ID/i, 'unsupported', 'Extension identity could not be verified'],
    [/Vast-native privileges/i, 'unsupported', 'Vast-native permissions are not transferable'],
    [/content security policy is unsafe/i, 'unsupported', 'Unsafe extension content security policy'],
    [/invalid host access/i, 'unsupported', 'Invalid extension host access'],
    [/no supported entry point|Manifest V2 is restricted/i, 'unsupported', 'Unsupported extension entry point'],
    [/private or invalid path|unsafe or oversized file|non-regular file|case-insensitive path collisions|link or escaping path/i,
      'failed', 'Unsafe extension file structure'],
    [/exceeds its limit|too many versions|timed out/i, 'failed', 'Extension import safety limit exceeded'],
    [/changed|disappeared|mismatch/i, 'failed', 'Source extension changed during import'],
    [/manifest|version/i, 'failed', 'Extension manifest or version is invalid']
  ]
  const match = known.find(([pattern]) => pattern.test(detail))
  return match ? { status: match[1], message: match[2] } : { status: 'failed', message: 'Extension could not be validated' }
}

export class ImportCoordinator {
  private readonly dependencies: ImportCoordinatorDependencies
  private active: ActivePreview | undefined
  private busy = false
  private committing = false
  private extensionBusy = false
  private pendingExtension: { operationId: string; extensionId: string; token: string } | undefined

  constructor(dependencies: ImportCoordinatorDependencies) {
    this.dependencies = dependencies
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now() }

  async prepare(request: BrowserImportPrepareRequest): Promise<BrowserImportPreview> {
    assertRequest(request)
    if (this.busy || this.committing || (this.active && this.active.preview.expiresAt > this.now())) {
      throw new Error('A browser import is already active or in progress.')
    }
    this.active = undefined
    this.busy = true
    try {
      const source = await this.dependencies.resolveProfile(request.sourceId, request.profileId)
      const snapshot = await this.dependencies.readSource(source, request.types, new AbortController().signal)
      if (snapshot.sourceId !== source.sourceId || snapshot.profileId !== source.profileId) {
        throw new Error('Browser import worker returned a mismatched source.')
      }
      const preview: BrowserImportPreview = {
        token: this.dependencies.token?.() ?? randomUUID(),
        sourceId: source.sourceId,
        profileId: source.profileId,
        selected: [...request.types],
        detected: {
          bookmarks: snapshot.bookmarks.length,
          history: snapshot.history.length,
          extensions: snapshot.extensions.length
        },
        detectedExtensions: structuredClone(snapshot.extensions),
        categories: structuredClone(snapshot.categories),
        expiresAt: this.now() + PREVIEW_TTL_MS
      }
      if (!preview.token || preview.token.length > 256) throw new Error('Invalid import preview token.')
      this.active = { source, snapshot, preview }
      return clonePreview(preview)
    } finally {
      this.busy = false
    }
  }

  preview(token: string): BrowserImportPreview {
    if (typeof token !== 'string' || !this.active || this.active.preview.token !== token) {
      throw new Error('Invalid browser import preview token.')
    }
    if (this.active.preview.expiresAt <= this.now()) throw new Error('Browser import preview expired.')
    return clonePreview(this.active.preview)
  }

  async commit(request: BrowserImportCommitRequest): Promise<BrowserImportCommitReceipt> {
    if (!request || typeof request !== 'object' || typeof request.token !== 'string' ||
        typeof request.acceptPartial !== 'boolean' || !Array.isArray(request.selectedExtensionIds) ||
        request.selectedExtensionIds.length > 100 || request.selectedExtensionIds.some((id) => typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) ||
        new Set(request.selectedExtensionIds).size !== request.selectedExtensionIds.length) {
      throw new Error('Invalid browser import commit request.')
    }
    const active = this.active
    const persisted = await this.dependencies.loadData()
    if (persisted.importState?.receipt?.operationId === request.token) return persisted.importState.receipt
    if (!active || active.preview.token !== request.token) {
      throw new Error('Invalid browser import preview token.')
    }
    if (active.preview.expiresAt <= this.now()) throw new Error('Browser import preview expired.')
    if (request.selectedExtensionIds.length && !active.preview.selected.includes('extensions')) throw new Error('Extensions were not selected for this import.')
    if (request.selectedExtensionIds.some((id) => !active.snapshot.extensions.some((item) => item.id === id && item.state === 'detected'))) {
      throw new Error('Selected extension is unavailable or unsupported.')
    }
    if (this.busy || this.committing) throw new Error('Browser import is already in progress.')
    if (active.preview.selected.some((type) =>
      ['failed', 'unavailable'].includes(active.snapshot.categories[type].status)) && !request.acceptPartial) {
      throw new Error('Partial browser import requires explicit consent.')
    }
    this.committing = true
    try {
      const currentSource = await this.dependencies.resolveProfile(active.source.sourceId, active.source.profileId)
      if (currentSource.canonicalPath !== active.source.canonicalPath) {
        throw new Error('Selected browser profile changed after preview.')
      }
      const result = await this.dependencies.commitData(request.token, (current) => {
        const merged = mergeImportCandidate(current, active.snapshot, active.preview.selected)
        const receipt: BrowserImportCommitReceipt = {
          operationId: request.token,
          sourceId: active.source.sourceId,
          profileId: active.source.profileId,
          committedAt: this.now(),
          counts: merged.counts
        }
        return { data: { ...merged.data, importState: {
          generation: current.importState?.generation ?? 0,
          phase: 'extensions-pending', pendingExtensionIds: [...request.selectedExtensionIds]
        } }, receipt }
      })
      this.active = undefined
      return result.receipt
    } finally {
      this.committing = false
    }
  }

  async status(): Promise<BrowserImportStatus> {
    const data = await this.dependencies.loadData()
    return {
      receipt: data.importState?.receipt,
      generation: data.importState?.generation ?? 0,
      pendingExtensionIds: data.importState?.pendingExtensionIds ?? [],
      extensionReceipts: data.importState?.extensionReceipts ?? []
    }
  }

  private async selectedExtension(operationId: string, extensionId: string): Promise<BrowserImportCommitReceipt> {
    if (typeof operationId !== 'string' || typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId)) {
      throw new Error('Invalid selected extension.')
    }
    const state = (await this.dependencies.loadData()).importState
    if (!state?.receipt || state.receipt.operationId !== operationId ||
        !state.pendingExtensionIds?.includes(extensionId) || state.receipt.sourceId === 'firefox') {
      throw new Error('Extension is not pending for this committed import.')
    }
    return state.receipt
  }

  private async recordExtension(operationId: string, extensionId: string, status: BrowserImportExtensionReceipt['status'], message?: string): Promise<BrowserImportExtensionReceipt> {
    if (!this.dependencies.recordExtensionResult) throw new Error('Extension transfer is unavailable.')
    return this.dependencies.recordExtensionResult(operationId, { id: extensionId, status, recordedAt: this.now(), ...(message ? { message } : {}) })
  }

  async prepareSelectedExtension(operationId: string, extensionId: string): Promise<BrowserImportExtensionPreparation> {
    if (this.extensionBusy) throw new Error('An extension import is already in progress.')
    const receipt = await this.selectedExtension(operationId, extensionId)
    const manager = this.dependencies.extensionManager
    if (!manager) throw new Error('Extension transfer is unavailable.')
    this.extensionBusy = true
    try {
      if (this.pendingExtension) {
        await manager.cancelPrepared(this.pendingExtension.token).catch(() => undefined)
        this.pendingExtension = undefined
      }
      const existing = (await manager.list()).find((item) => item.id === extensionId)
      if (existing) {
        const status = existing.source === 'local-chromium'
          ? existing.compatibility === 'partial' ? 'partial compatibility' : 'installed'
          : 'already installed'
        return { kind: 'result', receipt: await this.recordExtension(operationId, extensionId, status) }
      }
      const source = await this.dependencies.resolveProfile(receipt.sourceId, receipt.profileId)
      const snapshot = await this.dependencies.readSource(source, ['extensions'], new AbortController().signal)
      const detected = snapshot.extensions.find((item) => item.id === extensionId)
      if (!detected || detected.state !== 'detected') {
        return { kind: 'result', receipt: await this.recordExtension(operationId, extensionId,
          detected?.state === 'failed' ? 'failed' : 'unsupported', detected?.limitationCodes[0] ?? 'Source extension unavailable') }
      }
      const preview = await manager.prepareLocalChromiumImport({ profilePath: source.canonicalPath,
        sourceExtensionId: extensionId, version: detected.version, fingerprint: detected.fingerprint,
        sourceEnabled: detected.sourceEnabled })
      if (preview.compatibility === 'unsupported') {
        await manager.cancelPrepared(preview.token)
        return { kind: 'result', receipt: await this.recordExtension(operationId, extensionId, 'unsupported', 'No supported extension entry point') }
      }
      this.pendingExtension = { operationId, extensionId, token: preview.token }
      return { kind: 'preview', preview }
    } catch (error) {
      const failure = extensionFailure(error)
      return { kind: 'result', receipt: await this.recordExtension(operationId, extensionId, failure.status, failure.message) }
    } finally {
      this.extensionBusy = false
    }
  }

  async confirmSelectedExtension(request: BrowserImportExtensionConfirmRequest): Promise<BrowserImportExtensionReceipt> {
    if (!request || typeof request !== 'object' || this.extensionBusy) throw new Error('Invalid or busy extension import.')
    await this.selectedExtension(request.operationId, request.extensionId)
    if (!this.pendingExtension || this.pendingExtension.operationId !== request.operationId ||
        this.pendingExtension.extensionId !== request.extensionId || this.pendingExtension.token !== request.token ||
        !this.dependencies.extensionManager) throw new Error('Extension permission preview expired or changed.')
    this.extensionBusy = true
    this.pendingExtension = undefined
    try {
      const installed = await this.dependencies.extensionManager.confirmLocalChromiumImport(request.token, request.approval)
      return await this.recordExtension(request.operationId, request.extensionId,
        installed.compatibility === 'partial' ? 'partial compatibility' : 'installed')
    } catch (error) {
      return await this.recordExtension(request.operationId, request.extensionId, 'failed', extensionFailure(error).message)
    } finally {
      this.extensionBusy = false
    }
  }

  async declineSelectedExtension(operationId: string, extensionId: string): Promise<BrowserImportExtensionReceipt> {
    if (this.extensionBusy) throw new Error('An extension import is already in progress.')
    await this.selectedExtension(operationId, extensionId)
    if (this.pendingExtension?.operationId === operationId && this.pendingExtension.extensionId === extensionId) {
      const pending = this.pendingExtension
      this.pendingExtension = undefined
      await this.dependencies.extensionManager?.cancelPrepared(pending.token).catch(() => undefined)
    }
    return this.recordExtension(operationId, extensionId, 'declined')
  }

  async discard(token: string): Promise<void> {
    if (this.committing || this.busy) throw new Error('Browser import is in progress.')
    if (typeof token !== 'string' || !this.active || this.active.preview.token !== token) {
      throw new Error('Invalid browser import preview token.')
    }
    this.active = undefined
  }
}
