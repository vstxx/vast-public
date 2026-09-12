import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, rm, copyFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import semver from 'semver'

export interface PendingUpdate {
  version: string
  executable: string
  installer: string
  sha512: string
  attempts: number
  automatic: boolean
}

export function updateCacheKey(executable: string, profile: string): string {
  return createHash('sha256').update(dirname(executable).toLowerCase() + '\0' + profile.toLowerCase()).digest('hex').slice(0, 24)
}

export function pendingUpdatePath(executable: string, profile: string): string {
  return join(profile, 'UpdateCache', 'pending-' + updateCacheKey(executable, profile) + '.json')
}

export function validPendingUpdate(value: unknown, executable: string, profile: string, cacheRoot: string): value is PendingUpdate {
  if (!value || typeof value !== 'object') return false
  const record = value as PendingUpdate
  return typeof record.version === 'string' && Boolean(semver.valid(record.version)) &&
    record.executable === executable && typeof record.installer === 'string' &&
    dirname(resolve(record.installer)).toLowerCase() === resolve(cacheRoot, 'vast-update-' + updateCacheKey(executable, profile), 'pending').toLowerCase() &&
    record.installer.toLowerCase().endsWith('.exe') &&
    typeof record.sha512 === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(record.sha512) &&
    Number.isInteger(record.attempts) && record.attempts >= 0 && record.attempts <= 3 && typeof record.automatic === 'boolean'
}

export async function readPendingUpdate(file: string): Promise<unknown> {
  try { return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) } catch { return undefined }
}

export async function stagePendingUpdate(record: Omit<PendingUpdate, 'attempts'>, profile: string, helperSource: string, resetAttempts = false): Promise<number> {
  const file = pendingUpdatePath(record.executable, profile)
  const old = await readPendingUpdate(file) as Partial<PendingUpdate> | undefined
  const attempts = !resetAttempts && old?.version === record.version && old.sha512 === record.sha512 && Number.isInteger(old.attempts)
    ? Math.max(0, Math.min(3, old.attempts!)) : 0
  await mkdir(dirname(file), { recursive: true })
  await copyFile(helperSource, join(dirname(file), 'apply-update.ps1'))
  await writeFile(file + '.tmp', JSON.stringify({ ...record, attempts }), 'utf8')
  await rename(file + '.tmp', file)
  return attempts
}

export async function pendingStartupDecision(options: {
  executable: string; profile: string; cacheRoot: string; currentVersion: string; skipOnce: boolean
}): Promise<PendingUpdate | undefined> {
  const file = pendingUpdatePath(options.executable, options.profile)
  const record = await readPendingUpdate(file)
  if (!validPendingUpdate(record, options.executable, options.profile, options.cacheRoot)) return undefined
  if (!semver.gt(record.version, options.currentVersion)) {
    await rm(file, { force: true })
    await rm(file + '.error', { force: true })
    return undefined
  }
  if (options.skipOnce || !record.automatic || record.attempts >= 3) return undefined
  return record
}
