const legacyUpgradeUrl = 'vast://upgrade'
const retiredReaderUrl = 'vast://reader'
const newTabUrl = 'vast://newtab'
const videoAudioUrl = 'vast://avidae'

function migrateVideoAudioTitle(title: string): string {
  return title === 'Avidae' || title.startsWith('Avidae —')
    ? title.replace(/^Avidae/, 'Video & Audio')
    : title
}

export function migrateLegacyInternalUrl(url: string): string {
  return url === legacyUpgradeUrl || url === retiredReaderUrl ? newTabUrl : url
}

export function migrateLegacyInternalTab<T extends { title: string; url: string }>(tab: T): T {
  const migrated = { ...tab } as T & { readerMode?: boolean }
  delete migrated.readerMode
  if (migrated.url === legacyUpgradeUrl || migrated.url === retiredReaderUrl) return { ...migrated, title: 'New tab', url: newTabUrl }
  if (migrated.url === videoAudioUrl) return { ...migrated, title: migrateVideoAudioTitle(migrated.title) }
  return migrated
}

export function stripRetiredReaderState<T extends object>(value: T): T {
  const next = { ...value } as T & { readerMode?: boolean }
  delete next.readerMode
  return next
}

export function migrateLegacySessionSnapshot<
  T extends { activeUrl?: string; tabs?: Array<{ title: string; url: string }> }
>(snapshot: T): T {
  return {
    ...snapshot,
    activeUrl: snapshot.activeUrl ? migrateLegacyInternalUrl(snapshot.activeUrl) : undefined,
    tabs: snapshot.tabs?.map(migrateLegacyInternalTab)
  }
}
