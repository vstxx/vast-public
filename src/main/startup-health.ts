import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PersistedData } from '../shared/types.ts'
import { atomicWriteJson } from './atomic-file.ts'

type StartupPhase = 'booting' | 'stable' | 'clean-exit'

interface StartupHealthState {
  schemaVersion: 1
  phase: StartupPhase
  bootId: string
  consecutiveFailedStartups: number
  startedAt: number
  updatedAt: number
  recoverySnapshotPath?: string
}

export interface StartupRecoveryInfo {
  safeStartup: boolean
  consecutiveFailedStartups: number
  recoverySnapshotPath?: string
}

const sessionKeys = [
  'activeWorkspaceId',
  'splitView',
  'workspaces',
  'tabGroups',
  'tabs',
  'recentlyClosedTabs',
  'sessionSnapshots'
] as const satisfies readonly (keyof PersistedData)[]

function parseState(value: unknown): StartupHealthState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== 1 || !['booting', 'stable', 'clean-exit'].includes(String(input.phase))) return undefined
  const consecutiveFailedStartups = Number(input.consecutiveFailedStartups)
  const startedAt = Number(input.startedAt)
  const updatedAt = Number(input.updatedAt)
  if (!Number.isInteger(consecutiveFailedStartups) || consecutiveFailedStartups < 0 || !Number.isFinite(startedAt) || !Number.isFinite(updatedAt)) return undefined
  return {
    schemaVersion: 1,
    phase: input.phase as StartupPhase,
    bootId: typeof input.bootId === 'string' ? input.bootId : 'legacy',
    consecutiveFailedStartups,
    startedAt,
    updatedAt,
    ...(typeof input.recoverySnapshotPath === 'string' ? { recoverySnapshotPath: input.recoverySnapshotPath } : {})
  }
}

export class StartupHealthTracker {
  readonly statePath: string
  readonly recoveryRoot: string
  private state?: StartupHealthState
  private safeStartup = false

  constructor(dataRoot: string) {
    this.statePath = join(dataRoot, 'Startup Health', 'state.json')
    this.recoveryRoot = join(dataRoot, 'Startup Recovery')
  }

  async begin(): Promise<StartupRecoveryInfo> {
    const previous = await this.readState()
    const consecutiveFailedStartups = previous?.phase === 'booting'
      ? previous.consecutiveFailedStartups + 1
      : 0
    this.safeStartup = consecutiveFailedStartups >= 2
    const now = Date.now()
    this.state = {
      schemaVersion: 1,
      phase: 'booting',
      bootId: randomUUID(),
      consecutiveFailedStartups,
      startedAt: now,
      updatedAt: now,
      ...(previous?.recoverySnapshotPath ? { recoverySnapshotPath: previous.recoverySnapshotPath } : {})
    }
    await atomicWriteJson(this.statePath, this.state)
    return this.info()
  }

  async preserveRecoverySnapshot(data: PersistedData): Promise<string | undefined> {
    if (!this.safeStartup || !this.state) return undefined
    if (this.state.recoverySnapshotPath && await stat(this.state.recoverySnapshotPath).then((entry) => entry.isFile()).catch(() => false)) {
      return this.state.recoverySnapshotPath
    }
    const snapshotPath = join(this.recoveryRoot, `session-${this.state.startedAt}-${this.state.bootId}.json`)
    await atomicWriteJson(snapshotPath, {
      schemaVersion: 1,
      createdAt: Date.now(),
      reason: 'consecutive-failed-startups',
      data
    })
    this.state = { ...this.state, recoverySnapshotPath: snapshotPath, updatedAt: Date.now() }
    await atomicWriteJson(this.statePath, this.state)
    return snapshotPath
  }

  dataForRenderer(data: PersistedData): PersistedData {
    return {
      ...data,
      startupRecovery: this.info()
    }
  }

  preserveStoredSession(current: PersistedData, incoming: PersistedData): PersistedData {
    if (!this.safeStartup) return incoming
    const next = { ...incoming }
    for (const key of sessionKeys) Object.assign(next, { [key]: current[key] })
    return next
  }

  async markStable(): Promise<void> {
    await this.transition('stable')
  }

  async markCleanExit(): Promise<void> {
    if (!this.state) return
    this.state = {
      ...this.state,
      phase: 'clean-exit',
      consecutiveFailedStartups: 0,
      updatedAt: Date.now()
    }
    await atomicWriteJson(this.statePath, this.state)
  }

  info(): StartupRecoveryInfo {
    return {
      safeStartup: this.safeStartup,
      consecutiveFailedStartups: this.state?.consecutiveFailedStartups ?? 0,
      ...(this.state?.recoverySnapshotPath ? { recoverySnapshotPath: this.state.recoverySnapshotPath } : {})
    }
  }

  private async transition(phase: StartupPhase): Promise<void> {
    if (!this.state) return
    this.state = { ...this.state, phase, updatedAt: Date.now() }
    await atomicWriteJson(this.statePath, this.state)
  }

  private async readState(): Promise<StartupHealthState | undefined> {
    try {
      return parseState(JSON.parse(await readFile(this.statePath, 'utf8')) as unknown)
    } catch {
      return undefined
    }
  }
}
