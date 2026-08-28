import { readFile, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { atomicWriteJson } from '../atomic-file.ts'
import type { InstalledExtensionRecord } from './extension-types.ts'
import { VAST_NATIVE_PERMISSIONS, type VastExtensionKind, type VastNativePermission } from '../../shared/extension-native-api.ts'

const REGISTRY_SCHEMA_VERSION = 5
const EXTENSION_ID = /^[a-p]{32}$/

interface PersistedExtensionRegistry {
  schemaVersion: number
  extensions: InstalledExtensionRecord[]
}

function limitedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

export function parseInstalledExtensionRecord(value: unknown): InstalledExtensionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const id = limitedString(input.id, 64)
  const name = limitedString(input.name, 256)
  const version = limitedString(input.version, 64)
  const path = limitedString(input.path, 32_768)
  const description = limitedString(input.description, 4_096)
  const installedAt = typeof input.installedAt === 'number' && Number.isFinite(input.installedAt) && input.installedAt > 0
    ? input.installedAt
    : undefined
  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt > 0
    ? input.updatedAt
    : undefined

  if (!id || !EXTENSION_ID.test(id) || !name || !version || !path || !isAbsolute(path)) return undefined
  if (input.enabled !== true && input.enabled !== false) return undefined
  if (!['unpacked', 'local-vext', 'hub', 'bundled'].includes(String(input.source)) || !['chrome', 'vast', 'hybrid', undefined].includes(input.runtime as VastExtensionKind | undefined)) return undefined
  if (input.manifestVersion !== 2 && input.manifestVersion !== 3) return undefined
  if (!installedAt || !updatedAt) return undefined

  const grantedPermissions = Array.isArray(input.grantedPermissions)
    ? [...new Set(input.grantedPermissions.filter((permission): permission is VastNativePermission =>
        typeof permission === 'string' && (VAST_NATIVE_PERMISSIONS as readonly string[]).includes(permission)
      ))]
    : []
  const runtime = (input.runtime === 'vast' || input.runtime === 'hybrid' ? input.runtime : 'chrome') as VastExtensionKind
  const source = input.source as InstalledExtensionRecord['source']
  const trust = input.trust === 'official' || input.trust === 'local' || input.trust === 'developer'
    ? input.trust
    : source === 'unpacked' ? 'developer' : source === 'hub' || source === 'bundled' ? 'official' : 'local'
  const updateState = ['not-applicable', 'up-to-date', 'checking', 'available', 'updating', 'pending-approval', 'failed'].includes(String(input.updateState))
    ? input.updateState as InstalledExtensionRecord['updateState']
    : source === 'hub' ? 'up-to-date' : 'not-applicable'
  const optionalVersion = (value: unknown): string | undefined => limitedString(value, 64)
  const optionalHash = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined
  const optionalTime = typeof input.lastUpdateCheckAt === 'number' && Number.isFinite(input.lastUpdateCheckAt) && input.lastUpdateCheckAt > 0 ? input.lastUpdateCheckAt : undefined
  return {
    id,
    name,
    version,
    ...(description ? { description } : {}),
    path,
    enabled: input.enabled,
    source,
    trust,
    ...(limitedString(input.publisherId, 128) ? { publisherId: limitedString(input.publisherId, 128) } : {}),
    ...(limitedString(input.publisherName, 256) ? { publisherName: limitedString(input.publisherName, 256) } : {}),
    ...(limitedString(input.category, 64) ? { category: limitedString(input.category, 64) } : {}),
    ...(input.catalogInstalled === true ? { catalogInstalled: true as const } : {}),
    ...(optionalHash(input.packageSha256) ? { packageSha256: optionalHash(input.packageSha256) } : {}),
    ...(limitedString(input.signatureKeyId, 128) ? { signatureKeyId: limitedString(input.signatureKeyId, 128) } : {}),
    ...(optionalVersion(input.previousVersion) ? { previousVersion: optionalVersion(input.previousVersion) } : {}),
    ...(optionalVersion(input.failedUpdateVersion) ? { failedUpdateVersion: optionalVersion(input.failedUpdateVersion) } : {}),
    ...(optionalVersion(input.availableVersion) ? { availableVersion: optionalVersion(input.availableVersion) } : {}),
    updateState,
    ...(limitedString(input.updateError, 2_048) ? { updateError: limitedString(input.updateError, 2_048) } : {}),
    ...(optionalTime ? { lastUpdateCheckAt: optionalTime } : {}),
    runtime,
    manifestVersion: input.manifestVersion,
    installedAt,
    updatedAt,
    allowFileAccess: false,
    grantedPermissions
  }
}

function clone(record: InstalledExtensionRecord): InstalledExtensionRecord {
  return { ...record }
}

function pathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export class ExtensionRegistry {
  readonly filePath: string
  private records = new Map<string, InstalledExtensionRecord>()
  private loaded = false

  constructor(userDataRoot: string) {
    this.filePath = join(userDataRoot, 'Extensions', 'registry.json')
  }

  async load(): Promise<InstalledExtensionRecord[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.quarantineMalformedRegistry()
      return []
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      await this.quarantineMalformedRegistry()
      return []
    }
    const input = parsed as { schemaVersion?: unknown; extensions?: unknown }
    if (![1, 2, 3, 4, REGISTRY_SCHEMA_VERSION].includes(Number(input.schemaVersion)) || !Array.isArray(input.extensions)) {
      await this.quarantineMalformedRegistry()
      return []
    }

    let sanitized = false
    const seenPaths = new Set<string>()
    for (const candidate of input.extensions) {
      const record = parseInstalledExtensionRecord(candidate)
      const recordPathKey = record ? pathKey(record.path) : undefined
      if (!record || this.records.has(record.id) || seenPaths.has(recordPathKey ?? '')) {
        sanitized = true
        continue
      }
      this.records.set(record.id, record)
      seenPaths.add(recordPathKey!)
    }
    if (sanitized || input.schemaVersion !== REGISTRY_SCHEMA_VERSION) await this.persist()
    return this.list()
  }

  list(): InstalledExtensionRecord[] {
    return [...this.records.values()].map(clone).sort((left, right) => left.installedAt - right.installedAt)
  }

  get(id: string): InstalledExtensionRecord | undefined {
    const record = this.records.get(id)
    return record ? clone(record) : undefined
  }

  findByPath(path: string): InstalledExtensionRecord | undefined {
    const key = pathKey(path)
    const record = [...this.records.values()].find((candidate) => pathKey(candidate.path) === key)
    return record ? clone(record) : undefined
  }

  async upsert(record: InstalledExtensionRecord, previousId?: string): Promise<void> {
    if (!this.loaded) await this.load()
    if (previousId && previousId !== record.id) this.records.delete(previousId)
    this.records.set(record.id, clone(record))
    await this.persist()
  }

  async remove(id: string): Promise<boolean> {
    if (!this.loaded) await this.load()
    const removed = this.records.delete(id)
    if (removed) await this.persist()
    return removed
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledExtensionRecord | undefined> {
    if (!this.loaded) await this.load()
    const record = this.records.get(id)
    if (!record) return undefined
    const next = { ...record, enabled, updatedAt: Date.now() }
    this.records.set(id, next)
    await this.persist()
    return clone(next)
  }

  async setGrantedPermissions(id: string, permissions: VastNativePermission[]): Promise<InstalledExtensionRecord | undefined> {
    if (!this.loaded) await this.load()
    const record = this.records.get(id)
    if (!record) return undefined
    const next = { ...record, grantedPermissions: [...new Set(permissions)], updatedAt: Date.now() }
    this.records.set(id, next)
    await this.persist()
    return clone(next)
  }

  async replace(record: InstalledExtensionRecord): Promise<InstalledExtensionRecord> {
    if (!this.loaded) await this.load()
    this.records.set(record.id, clone(record))
    await this.persist()
    return clone(record)
  }

  async patch(id: string, patch: Partial<InstalledExtensionRecord>): Promise<InstalledExtensionRecord | undefined> {
    if (!this.loaded) await this.load()
    const record = this.records.get(id)
    if (!record) return undefined
    const next: InstalledExtensionRecord = { ...record, ...patch, id: record.id, updatedAt: Date.now() }
    this.records.set(id, next)
    await this.persist()
    return clone(next)
  }

  private async persist(): Promise<void> {
    const registry: PersistedExtensionRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      extensions: this.list()
    }
    await atomicWriteJson(this.filePath, registry)
  }

  private async quarantineMalformedRegistry(): Promise<void> {
    this.records.clear()
    const directory = dirname(this.filePath)
    const quarantined = join(directory, `registry.corrupt-${Date.now()}.json`)
    await rename(this.filePath, quarantined).catch(() => undefined)
  }
}
