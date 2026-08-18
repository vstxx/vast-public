import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { atomicWriteFile } from '../atomic-file.ts'
import { isRelayInstallId } from './protocol.ts'

const RELAY_STATE_SCHEMA_VERSION = 1
const MAX_STATE_BYTES = 64 * 1024
const MAX_LAUNCH_COUNT = 2_147_483_647
const MAX_DISMISSALS = 500
const DISMISSAL_RETENTION_MS = 400 * 24 * 60 * 60 * 1_000
const PRESENTATION_ID_PATTERN = /^(?:broadcast:[0-9a-f-]{36}|release:[0-9A-Za-z.+-]{5,72})$/

export interface RelayDismissal {
  id: string
  dismissedAt: number
}

export interface RelayLocalState {
  schemaVersion: 1
  installId: string
  launchCount: number
  dismissed: RelayDismissal[]
}

function freshState(): RelayLocalState {
  return {
    schemaVersion: RELAY_STATE_SCHEMA_VERSION,
    installId: randomUUID(),
    launchCount: 0,
    dismissed: []
  }
}

function exactKeys(source: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(source).length === expected.length && expected.every((key) => Object.hasOwn(source, key))
}

function validDismissal(value: unknown): value is RelayDismissal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const source = value as Record<string, unknown>
  return exactKeys(source, ['id', 'dismissedAt']) &&
    typeof source.id === 'string' && PRESENTATION_ID_PATTERN.test(source.id) &&
    Number.isSafeInteger(source.dismissedAt) && Number(source.dismissedAt) >= 0
}

function pruneDismissals(dismissed: readonly RelayDismissal[], now: number): RelayDismissal[] {
  const oldest = Math.max(0, now - DISMISSAL_RETENTION_MS)
  const byId = new Map<string, RelayDismissal>()
  for (const entry of dismissed) {
    if (!validDismissal(entry) || entry.dismissedAt < oldest || entry.dismissedAt > now + 60_000) continue
    const previous = byId.get(entry.id)
    if (!previous || previous.dismissedAt < entry.dismissedAt) byId.set(entry.id, { ...entry })
  }
  return [...byId.values()].sort((left, right) => right.dismissedAt - left.dismissedAt).slice(0, MAX_DISMISSALS)
}

function parseState(raw: string, now: number): RelayLocalState {
  const value = JSON.parse(raw) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Relay state must be an object.')
  const source = value as Record<string, unknown>
  if (!exactKeys(source, ['schemaVersion', 'installId', 'launchCount', 'dismissed'])) throw new Error('Relay state shape is invalid.')
  if (source.schemaVersion !== RELAY_STATE_SCHEMA_VERSION || !isRelayInstallId(source.installId)) throw new Error('Relay identity is invalid.')
  if (!Number.isSafeInteger(source.launchCount) || Number(source.launchCount) < 0 || Number(source.launchCount) > MAX_LAUNCH_COUNT) {
    throw new Error('Relay launch count is invalid.')
  }
  if (!Array.isArray(source.dismissed) || source.dismissed.length > MAX_DISMISSALS * 2) throw new Error('Relay dismissals are invalid.')
  return {
    schemaVersion: RELAY_STATE_SCHEMA_VERSION,
    installId: source.installId.toLowerCase(),
    launchCount: Number(source.launchCount),
    dismissed: pruneDismissals(source.dismissed.filter(validDismissal), now)
  }
}

export class RelayStateStore {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(filePath: string) {
    this.filePath = filePath
  }

  private async read(now: number): Promise<RelayLocalState> {
    try {
      const info = await stat(this.filePath)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) return freshState()
      return parseState(await readFile(this.filePath, 'utf8'), now)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt or transient state is replaced with a fresh pseudonymous identity.
      }
      return freshState()
    }
  }

  private async write(state: RelayLocalState): Promise<void> {
    const raw = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(raw, 'utf8') > MAX_STATE_BYTES) throw new Error('Relay state exceeds its storage bound.')
    await atomicWriteFile(this.filePath, raw)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  beginLaunch(now = Date.now()): Promise<RelayLocalState> {
    return this.serialize(async () => {
      const current = await this.read(now)
      const next: RelayLocalState = {
        ...current,
        launchCount: Math.min(MAX_LAUNCH_COUNT, current.launchCount + 1),
        dismissed: pruneDismissals(current.dismissed, now)
      }
      await this.write(next)
      return next
    })
  }

  dismiss(presentationId: string, now = Date.now()): Promise<RelayLocalState> {
    return this.serialize(async () => {
      if (!PRESENTATION_ID_PATTERN.test(presentationId)) throw new Error('Relay presentation id is invalid.')
      const current = await this.read(now)
      const next: RelayLocalState = {
        ...current,
        dismissed: pruneDismissals([{ id: presentationId, dismissedAt: now }, ...current.dismissed], now)
      }
      await this.write(next)
      return next
    })
  }
}
