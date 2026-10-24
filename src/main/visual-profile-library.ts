import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from './atomic-file.ts'
import {
  VISUAL_PROFILE_IMAGE_TYPES,
  VISUAL_PROFILE_MAX_IMAGE_BYTES,
  normalizeVisualProfileName,
  parseVisualProfileDocument,
  parseVisualProfileValues,
  serializeVisualProfileDocument,
  uniqueVisualProfileName,
  type VisualProfileImageType,
  type VisualProfileValues
} from '../shared/visual-profile.ts'
import type { VisualProfileListing, VisualProfileSummary } from '../shared/types'

// Local library of saved visual profiles: `<data>/visual-profiles/profiles.json`
// plus one `<id>.image` per profile that carries a New Tab image. Loaded on the
// first request, never at startup. Every write is atomic and serialized.

const INDEX_FORMAT = 'vast.visual-profiles'
const INDEX_VERSION = 1
const INDEX_FILE = 'profiles.json'
const INDEX_MAX_BYTES = 1024 * 1024
const UNDO_IMAGE_FILE = 'previous-background.image'
export const VISUAL_PROFILE_LIMIT = 50
const PROFILE_ID = /^vp-[0-9a-f]{16}$/

interface StoredProfile {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  values: VisualProfileValues
  image?: VisualProfileImageType
}

export interface VisualProfileImageTools {
  /** Verifies untrusted bytes (header, decode, dimensions) and returns their type. */
  inspect(bytes: Buffer): VisualProfileImageType
  /** Bounded copy of the current New Tab image, re-encoded only when needed. */
  prepare(bytes: Buffer): { bytes: Buffer; type: VisualProfileImageType }
}

export interface NewTabBackgroundStore {
  read(): Promise<Buffer | undefined>
  write(bytes: Buffer): Promise<string>
  clear(): Promise<void>
}

export interface VisualProfileLibraryOptions {
  directory: string
  images: VisualProfileImageTools
  background: NewTabBackgroundStore
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function storedProfile(input: unknown): StoredProfile | null {
  if (!isRecord(input) || typeof input.id !== 'string' || !PROFILE_ID.test(input.id)) return null
  if (typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) return null
  if (typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt)) return null
  if (input.image !== undefined && !VISUAL_PROFILE_IMAGE_TYPES.includes(input.image as VisualProfileImageType)) return null
  try {
    const values = parseVisualProfileValues(input.values)
    if (input.image !== undefined && values.newTabBackground !== 'custom') return null
    return {
      id: input.id,
      name: normalizeVisualProfileName(input.name),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      values,
      ...(input.image ? { image: input.image as VisualProfileImageType } : {})
    }
  } catch {
    return null
  }
}

export function createVisualProfileLibrary(options: VisualProfileLibraryOptions) {
  const { directory, images, background } = options
  const now = options.now ?? Date.now
  const indexPath = join(directory, INDEX_FILE)
  const imagePath = (id: string): string => join(directory, `${id}.image`)
  const undoImagePath = join(directory, UNDO_IMAGE_FILE)
  let profiles: StoredProfile[] | undefined
  let appliedId: string | null = null
  // What applying a profile image replaced: a backed-up file, or no image at all.
  let undoImage: 'none' | 'file' | 'absent' = 'none'
  let queue: Promise<unknown> = Promise.resolve()

  // One operation at a time, so concurrent IPC calls cannot interleave writes.
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(operation)
    queue = next
    return next
  }

  async function load(): Promise<StoredProfile[]> {
    if (profiles) return profiles
    let raw: string | undefined
    try {
      const info = await stat(indexPath)
      if (!info.isFile() || info.size > INDEX_MAX_BYTES) throw new Error('oversized')
      raw = await readFile(indexPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await quarantineIndex()
      profiles = []
      return profiles
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!isRecord(parsed) || parsed.format !== INDEX_FORMAT || parsed.version !== INDEX_VERSION || !Array.isArray(parsed.profiles)) {
      await quarantineIndex()
      profiles = []
      return profiles
    }
    const seen = new Set<string>()
    profiles = []
    for (const item of parsed.profiles.slice(0, VISUAL_PROFILE_LIMIT)) {
      const profile = storedProfile(item)
      if (!profile || seen.has(profile.id)) continue
      seen.add(profile.id)
      profiles.push(profile)
    }
    appliedId = typeof parsed.appliedId === 'string' && seen.has(parsed.appliedId) ? parsed.appliedId : null
    return profiles
  }

  // Keep an unreadable index for inspection instead of overwriting it.
  async function quarantineIndex(): Promise<void> {
    await rename(indexPath, `${indexPath}.unreadable-${now()}`).catch(() => undefined)
  }

  async function persist(): Promise<void> {
    await atomicWriteJson(indexPath, {
      format: INDEX_FORMAT,
      version: INDEX_VERSION,
      appliedId,
      profiles: (profiles ?? []).map((profile) => ({ ...profile }))
    })
  }

  function listing(): VisualProfileListing {
    return {
      appliedId,
      profiles: (profiles ?? []).map((profile): VisualProfileSummary => ({
        id: profile.id,
        name: profile.name,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        values: { ...profile.values },
        hasImage: Boolean(profile.image)
      }))
    }
  }

  function find(id: unknown): StoredProfile {
    const profile = typeof id === 'string' && PROFILE_ID.test(id) ? profiles?.find((item) => item.id === id) : undefined
    if (!profile) throw new Error('That visual profile no longer exists.')
    return profile
  }

  async function readProfileImage(profile: StoredProfile): Promise<Buffer> {
    const bytes = await readFile(imagePath(profile.id))
    if (bytes.length > VISUAL_PROFILE_MAX_IMAGE_BYTES || images.inspect(bytes) !== profile.image) {
      throw new Error('The image saved with this profile is damaged.')
    }
    return bytes
  }

  /** Snapshot of the current New Tab image when the values use it. */
  async function snapshotImage(values: VisualProfileValues): Promise<{ bytes: Buffer; type: VisualProfileImageType } | undefined> {
    if (values.newTabBackground !== 'custom') return undefined
    const current = await background.read()
    if (!current) return undefined
    try {
      return images.prepare(current)
    } catch {
      throw new Error('The current New Tab image could not be read, so it cannot be saved in a profile.')
    }
  }

  async function storeImage(id: string, image: { bytes: Buffer; type: VisualProfileImageType } | undefined): Promise<VisualProfileImageType | undefined> {
    if (!image) {
      await unlink(imagePath(id)).catch(() => undefined)
      return undefined
    }
    if (image.bytes.length > VISUAL_PROFILE_MAX_IMAGE_BYTES) throw new Error('The New Tab image is too large to save in a profile.')
    await atomicWriteFile(imagePath(id), image.bytes)
    return image.type
  }

  async function add(name: string, values: VisualProfileValues, image: { bytes: Buffer; type: VisualProfileImageType } | undefined, markApplied: boolean): Promise<string> {
    const list = await load()
    if (list.length >= VISUAL_PROFILE_LIMIT) throw new Error(`You can keep up to ${VISUAL_PROFILE_LIMIT} visual profiles.`)
    const id = `vp-${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const timestamp = now()
    const type = await storeImage(id, image)
    const profile: StoredProfile = {
      id,
      name: uniqueVisualProfileName(name, list.map((item) => item.name)),
      createdAt: timestamp,
      updatedAt: timestamp,
      values,
      ...(type ? { image: type } : {})
    }
    const previousApplied = appliedId
    list.push(profile)
    if (markApplied) appliedId = id
    try {
      await persist()
    } catch (error) {
      list.pop()
      appliedId = previousApplied
      await unlink(imagePath(id)).catch(() => undefined)
      throw error
    }
    return id
  }

  return {
    list: () => serialized(async () => {
      await load()
      return listing()
    }),

    save: (nameInput: unknown, valuesInput: unknown) => serialized(async () => {
      const name = normalizeVisualProfileName(nameInput)
      const values = parseVisualProfileValues(valuesInput)
      const id = await add(name, values, await snapshotImage(values), true)
      return { ...listing(), id }
    }),

    /** Replaces a profile's snapshot with the current appearance. */
    update: (id: unknown, valuesInput: unknown) => serialized(async () => {
      await load()
      const profile = find(id)
      const values = parseVisualProfileValues(valuesInput)
      const previous = { ...profile }
      const previousApplied = appliedId
      const type = await storeImage(profile.id, await snapshotImage(values))
      profile.values = values
      profile.updatedAt = now()
      if (type) profile.image = type
      else delete profile.image
      appliedId = profile.id
      try {
        await persist()
      } catch (error) {
        Object.assign(profile, previous)
        if (!previous.image) delete profile.image
        appliedId = previousApplied
        throw error
      }
      return listing()
    }),

    rename: (id: unknown, nameInput: unknown) => serialized(async () => {
      await load()
      const profile = find(id)
      const name = normalizeVisualProfileName(nameInput)
      profile.name = uniqueVisualProfileName(name, (profiles ?? []).filter((item) => item !== profile).map((item) => item.name))
      await persist()
      return listing()
    }),

    remove: (id: unknown) => serialized(async () => {
      const list = await load()
      const profile = find(id)
      list.splice(list.indexOf(profile), 1)
      if (appliedId === profile.id) appliedId = null
      await persist()
      await unlink(imagePath(profile.id)).catch(() => undefined)
      return listing()
    }),

    setApplied: (id: unknown) => serialized(async () => {
      await load()
      const next = id === null ? null : find(id).id
      if (next !== appliedId) {
        appliedId = next
        await persist()
      }
      return listing()
    }),

    /**
     * Installs a profile's image as the New Tab background, keeping what it
     * replaced so `restoreImage` can undo the switch.
     */
    applyImage: (id: unknown) => serialized(async () => {
      await load()
      const profile = find(id)
      if (!profile.image) throw new Error('This profile has no New Tab image.')
      const bytes = await readProfileImage(profile)
      const current = await background.read()
      if (current) await atomicWriteFile(undoImagePath, current)
      undoImage = current ? 'file' : 'absent'
      return { dataUrl: await background.write(bytes) }
    }),

    restoreImage: () => serialized(async () => {
      const state = undoImage
      undoImage = 'none'
      if (state === 'none') throw new Error('There is no image switch to undo.')
      if (state === 'absent') {
        await background.clear()
        return { dataUrl: undefined }
      }
      const dataUrl = await background.write(await readFile(undoImagePath))
      await unlink(undoImagePath).catch(() => undefined)
      return { dataUrl }
    }),

    exportDocument: (id: unknown) => serialized(async () => {
      await load()
      const profile = find(id)
      const image = profile.image ? { type: profile.image, data: (await readProfileImage(profile)).toString('base64') } : undefined
      return { name: profile.name, text: serializeVisualProfileDocument({ name: profile.name, values: profile.values, image }) }
    }),

    /** Adds an untrusted `.vastvisual` text to the library. Never applies it. */
    importDocument: (text: string) => serialized(async () => {
      const document = parseVisualProfileDocument(text)
      let image: { bytes: Buffer; type: VisualProfileImageType } | undefined
      if (document.image) {
        const bytes = Buffer.from(document.image.data, 'base64')
        if (bytes.length === 0 || bytes.length > VISUAL_PROFILE_MAX_IMAGE_BYTES) throw new Error('The image in this visual profile is too large.')
        if (images.inspect(bytes) !== document.image.type) throw new Error('The image in this visual profile is not what it claims to be.')
        image = { bytes, type: document.image.type }
      }
      const id = await add(document.name, document.values, image, false)
      return { ...listing(), id }
    })
  }
}

export type VisualProfileLibrary = ReturnType<typeof createVisualProfileLibrary>
