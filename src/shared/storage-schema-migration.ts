import type { PersistedData } from './types'

/**
 * Schema migrations always begin from current defaults, then overlay the full
 * existing profile. This makes new fields additive without replacing any
 * existing user collections or preferences.
 */
export function mergePersistedDataForMigration(
  fallback: PersistedData,
  existing: PersistedData,
  schemaVersion: number
): PersistedData {
  return {
    ...fallback,
    ...existing,
    schemaVersion
  }
}
