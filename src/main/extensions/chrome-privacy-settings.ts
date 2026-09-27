import { readFile } from 'node:fs/promises'
import { atomicWriteJson } from '../atomic-file.ts'

export const CHROME_PRIVACY_SERVICE_KEYS = [
  'services.passwordSavingEnabled',
  'services.autofillAddressEnabled',
  'services.autofillCreditCardEnabled'
] as const

export type ChromePrivacyServiceKey = typeof CHROME_PRIVACY_SERVICE_KEYS[number]
export type ChromePrivacyLevelOfControl =
  | 'controllable_by_this_extension'
  | 'controlled_by_this_extension'
  | 'controlled_by_other_extensions'

export interface ChromePrivacyDetails {
  value: boolean
  controllerExtensionId?: string
  updatedAt?: string
  levelOfControl: ChromePrivacyLevelOfControl
}

export interface ChromePrivacyChange {
  key: ChromePrivacyServiceKey
  details: ChromePrivacyDetails
}

export interface ChromePrivacySettingsStoreOptions {
  writeState?: (path: string, value: unknown) => Promise<void>
  now?: () => Date
}

interface PersistedChromePrivacySetting {
  value: boolean
  controllerExtensionId: string
  updatedAt: string
}

interface PersistedChromePrivacyState {
  schemaVersion: 1
  settings: Partial<Record<ChromePrivacyServiceKey, PersistedChromePrivacySetting>>
}

const EXTENSION_ID = /^[a-p]{32}$/
const SERVICE_KEYS = new Set<string>(CHROME_PRIVACY_SERVICE_KEYS)

function assertExtensionId(extensionId: string): void {
  if (!EXTENSION_ID.test(extensionId)) throw new Error('Invalid Chrome extension ID.')
}

function assertServiceKey(key: string): asserts key is ChromePrivacyServiceKey {
  if (!SERVICE_KEYS.has(key)) throw new Error(`Unsupported Chrome privacy setting: ${key}`)
}

function malformedState(): Error {
  return new Error('Chrome privacy settings state is malformed.')
}

function parseState(raw: string): PersistedChromePrivacyState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw malformedState()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw malformedState()
  const input = parsed as { schemaVersion?: unknown; settings?: unknown }
  if (input.schemaVersion !== 1 || !input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) {
    throw malformedState()
  }

  const settings: PersistedChromePrivacyState['settings'] = {}
  for (const [key, value] of Object.entries(input.settings)) {
    if (!SERVICE_KEYS.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) {
      throw malformedState()
    }
    const setting = value as Record<string, unknown>
    if (typeof setting.value !== 'boolean' ||
        typeof setting.controllerExtensionId !== 'string' ||
        !EXTENSION_ID.test(setting.controllerExtensionId) ||
        typeof setting.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(setting.updatedAt))) {
      throw malformedState()
    }
    settings[key as ChromePrivacyServiceKey] = {
      value: setting.value,
      controllerExtensionId: setting.controllerExtensionId,
      updatedAt: setting.updatedAt
    }
  }
  return { schemaVersion: 1, settings }
}

function detailsFor(extensionId: string, setting?: PersistedChromePrivacySetting): ChromePrivacyDetails {
  if (!setting) return { value: true, levelOfControl: 'controllable_by_this_extension' }
  return {
    ...setting,
    levelOfControl: setting.controllerExtensionId === extensionId
      ? 'controlled_by_this_extension'
      : 'controlled_by_other_extensions'
  }
}

export class ChromePrivacySettingsStore {
  readonly statePath: string
  private state?: PersistedChromePrivacyState
  private loadPromise?: Promise<PersistedChromePrivacyState>
  private mutationQueue: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<(change: ChromePrivacyChange) => void>()
  private readonly writeState: (path: string, value: unknown) => Promise<void>
  private readonly now: () => Date

  constructor(statePath: string, options: ChromePrivacySettingsStoreOptions = {}) {
    this.statePath = statePath
    this.writeState = options.writeState ?? atomicWriteJson
    this.now = options.now ?? (() => new Date())
  }

  async get(extensionId: string, key: ChromePrivacyServiceKey): Promise<ChromePrivacyDetails> {
    assertExtensionId(extensionId)
    assertServiceKey(key)
    await this.mutationQueue
    const state = await this.load()
    return detailsFor(extensionId, state.settings[key])
  }

  set(extensionId: string, key: ChromePrivacyServiceKey, value: boolean): Promise<ChromePrivacyDetails> {
    return this.enqueue(async () => {
      assertExtensionId(extensionId)
      assertServiceKey(key)
      if (typeof value !== 'boolean') throw new Error('Chrome privacy setting value must be boolean.')
      const state = await this.load()
      const setting = { value, controllerExtensionId: extensionId, updatedAt: this.now().toISOString() }
      const next = { schemaVersion: 1 as const, settings: { ...state.settings, [key]: setting } }
      await this.writeState(this.statePath, next)
      this.state = next
      const details = detailsFor(extensionId, setting)
      this.emit({ key, details })
      return details
    })
  }

  clear(extensionId: string, key: ChromePrivacyServiceKey): Promise<ChromePrivacyDetails> {
    return this.enqueue(async () => {
      assertExtensionId(extensionId)
      assertServiceKey(key)
      const state = await this.load()
      const current = state.settings[key]
      if (current && current.controllerExtensionId !== extensionId) {
        throw new Error('Chrome privacy setting is controlled by another extension.')
      }
      if (!current) return detailsFor(extensionId)
      const settings = { ...state.settings }
      delete settings[key]
      const next = { schemaVersion: 1 as const, settings }
      await this.writeState(this.statePath, next)
      this.state = next
      const details = detailsFor(extensionId)
      this.emit({ key, details })
      return details
    })
  }

  subscribe(listener: (change: ChromePrivacyChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  removeExtension(extensionId: string): Promise<void> {
    return this.enqueue(async () => {
      assertExtensionId(extensionId)
      const state = await this.load()
      const removed = CHROME_PRIVACY_SERVICE_KEYS.filter(
        (key) => state.settings[key]?.controllerExtensionId === extensionId
      )
      if (removed.length === 0) return
      const settings = { ...state.settings }
      for (const key of removed) delete settings[key]
      const next = { schemaVersion: 1 as const, settings }
      await this.writeState(this.statePath, next)
      this.state = next
      for (const key of removed) this.emit({ key, details: detailsFor(extensionId) })
    })
  }

  private async load(): Promise<PersistedChromePrivacyState> {
    if (this.state) return this.state
    if (!this.loadPromise) {
      this.loadPromise = readFile(this.statePath, 'utf8')
        .then(parseState)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return { schemaVersion: 1 as const, settings: {} }
          throw error
        })
        .then((state) => (this.state = state))
    }
    return this.loadPromise
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private emit(change: ChromePrivacyChange): void {
    for (const listener of this.listeners) listener(change)
  }
}
