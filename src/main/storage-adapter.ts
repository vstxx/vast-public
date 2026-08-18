import type { PersistedData, StorageBackupInfo } from '../shared/types'

export interface StorageAdapter {
  load(): Promise<PersistedData>
  save(data: PersistedData): Promise<void>
  createBackup(kind: StorageBackupInfo['kind']): Promise<StorageBackupInfo | null>
  listBackups(): Promise<StorageBackupInfo[]>
  restoreBackup(id: string): Promise<PersistedData>
}

export interface StorageAdapterHealth {
  adapter: 'json' | 'sqlite'
  ok: boolean
  message: string
  lastBackupAt?: number
}

export const activeStorageAdapterName = 'json' as const

export function sqliteStorageAdapterStatus(): StorageAdapterHealth {
  return {
    adapter: 'sqlite',
    ok: false,
    message: 'SQLite storage is reserved for a future migration and is not enabled in Vast 1.0.7.'
  }
}
