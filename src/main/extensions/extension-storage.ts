import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '../atomic-file.ts'

export const EXTENSION_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024
const MAX_KEY_LENGTH = 256
const MAX_KEYS = 10_000
const MAX_DEPTH = 32

function safeKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH && value !== '__proto__' && value !== 'prototype' && value !== 'constructor'
}

function validateJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > MAX_DEPTH) throw new Error('Storage value exceeds the maximum nesting depth.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Storage only accepts finite JSON numbers.')
    return
  }
  if (typeof value !== 'object') throw new Error('Storage only accepts JSON-compatible values.')
  if (seen.has(value)) throw new Error('Storage values cannot contain cycles.')
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > MAX_KEYS) throw new Error('Storage array is too large.')
    for (const item of value) validateJson(item, depth + 1, seen)
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Storage only accepts plain objects.')
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > MAX_KEYS) throw new Error('Storage object has too many keys.')
    for (const [key, item] of entries) {
      if (!safeKey(key)) throw new Error('Storage contains an invalid key.')
      validateJson(item, depth + 1, seen)
    }
  }
  seen.delete(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export class ExtensionStorage {
  private readonly root: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(userDataRoot: string) {
    this.root = join(userDataRoot, 'Extensions', 'Data')
  }

  private file(id: string): string { return join(this.root, id, 'storage.json') }

  private async read(id: string): Promise<Record<string, unknown>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file(id), 'utf8'))
      validateJson(value)
      return value && typeof value === 'object' && !Array.isArray(value) ? clone(value as Record<string, unknown>) : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const result = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation)
    this.queues.set(id, result.then(() => undefined, () => undefined))
    return result
  }

  async get(id: string, keys?: unknown): Promise<Record<string, unknown>> {
    const data = await this.read(id)
    if (keys === undefined || keys === null) return data
    const result: Record<string, unknown> = {}
    if (typeof keys === 'string') {
      if (!safeKey(keys)) throw new Error('Invalid storage key.')
      if (Object.hasOwn(data, keys)) result[keys] = clone(data[keys])
      return result
    }
    if (Array.isArray(keys)) {
      if (keys.length > MAX_KEYS || !keys.every(safeKey)) throw new Error('Invalid storage keys.')
      for (const key of keys) if (Object.hasOwn(data, key)) result[key] = clone(data[key])
      return result
    }
    if (!keys || typeof keys !== 'object') throw new Error('Invalid storage keys.')
    validateJson(keys)
    for (const [key, fallback] of Object.entries(keys as Record<string, unknown>)) result[key] = Object.hasOwn(data, key) ? clone(data[key]) : clone(fallback)
    return result
  }

  async set(id: string, items: unknown): Promise<void> {
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('Storage set requires a plain object.')
    validateJson(items)
    await this.enqueue(id, async () => {
      const next = { ...await this.read(id), ...clone(items as Record<string, unknown>) }
      const serialized = JSON.stringify(next)
      if (Buffer.byteLength(serialized, 'utf8') > EXTENSION_STORAGE_QUOTA_BYTES) throw new Error('Extension storage quota exceeded (5 MB).')
      await atomicWriteJson(this.file(id), next)
    })
  }

  async remove(id: string, keys: unknown): Promise<void> {
    const list = typeof keys === 'string' ? [keys] : keys
    if (!Array.isArray(list) || list.length > MAX_KEYS || !list.every(safeKey)) throw new Error('Invalid storage keys.')
    await this.enqueue(id, async () => {
      const next = await this.read(id)
      for (const key of list) delete next[key]
      await atomicWriteJson(this.file(id), next)
    })
  }

  async clear(id: string): Promise<void> { await this.enqueue(id, () => atomicWriteJson(this.file(id), {})) }

  async removeAll(id: string): Promise<void> {
    await (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined)
    this.queues.delete(id)
    await rm(join(this.root, id), { recursive: true, force: true })
  }
}
