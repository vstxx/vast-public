import type { Tab, Workspace } from '../../shared/types'

type PersistedChangeState = {
  schemaVersion: number
  activeWorkspaceId: string
  activeSidePanel: unknown
  sidePanelOpen: boolean
  sidebarCollapsed: boolean
  focusMode: boolean
  splitView: unknown
  workspaces: Workspace[]
  tabGroups: unknown[]
  tabs: Tab[]
  recentlyClosedTabs: unknown[]
  bookmarks: unknown[]
  bookmarkFolders: unknown[]
  history: unknown[]
  downloads: unknown[]
  notes: unknown[]
  readingList: unknown[]
  macros: unknown[]
  macroLogs: unknown[]
  sessionSnapshots: unknown[]
  quickLinks: unknown[]
  siteMemory: unknown[]
  todos: unknown[]
  recentCommandIds: unknown[]
  settings: unknown
}

function persistedTabSignature(tabs: Tab[], workspaces: Workspace[]): string {
  const privateIds = new Set(workspaces.filter((workspace) => workspace.isPrivate).map((workspace) => workspace.id))
  return tabs
    .filter((tab) => !privateIds.has(tab.workspaceId))
    .map((tab) => [
      tab.id,
      tab.workspaceId,
      tab.groupId ?? '',
      tab.url,
      tab.pinned ? 1 : 0,
      tab.muted ? 1 : 0,
      tab.zoom,
      tab.createdAt,
      tab.lastAccessedAt
    ].join('\u001f'))
    .join('\u001e')
}

const referenceIds = new WeakMap<object, number>()
let nextReferenceId = 1

function referenceId(value: unknown): number {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return 0
  const object = value as object
  let id = referenceIds.get(object)
  if (!id) {
    id = nextReferenceId++
    referenceIds.set(object, id)
  }
  return id
}

/** Compact durable-state token; it does not serialize record bodies on webview churn. */
export function persistedStateChangeToken(state: PersistedChangeState): string {
  const references: Array<keyof PersistedChangeState> = [
    'workspaces', 'tabGroups', 'recentlyClosedTabs', 'bookmarks', 'bookmarkFolders', 'history', 'notes',
    'readingList', 'macros', 'macroLogs', 'sessionSnapshots', 'quickLinks', 'siteMemory', 'todos', 'recentCommandIds', 'settings'
  ]
  return [
    state.schemaVersion,
    state.activeWorkspaceId,
    String(state.activeSidePanel),
    state.sidePanelOpen ? 1 : 0,
    state.sidebarCollapsed ? 1 : 0,
    state.focusMode ? 1 : 0,
    referenceId(state.splitView),
    ...references.map((key) => referenceId(state[key])),
    persistedTabSignature(state.tabs, state.workspaces)
  ].join('|')
}

/** Ignores progress, loading, title, favicon, media, and crash-only tab updates. */
export function hasPersistedStateChanged(current: PersistedChangeState, previous: PersistedChangeState): boolean {
  if (
    current.schemaVersion !== previous.schemaVersion ||
    current.activeWorkspaceId !== previous.activeWorkspaceId ||
    current.activeSidePanel !== previous.activeSidePanel ||
    current.sidePanelOpen !== previous.sidePanelOpen ||
    current.sidebarCollapsed !== previous.sidebarCollapsed ||
    current.focusMode !== previous.focusMode ||
    current.splitView !== previous.splitView ||
    current.settings !== previous.settings
  ) return true

  const referenceCollections: Array<keyof PersistedChangeState> = [
    'workspaces', 'tabGroups', 'recentlyClosedTabs', 'bookmarks', 'bookmarkFolders', 'history', 'notes',
    'readingList', 'macros', 'macroLogs', 'sessionSnapshots', 'quickLinks', 'siteMemory', 'todos', 'recentCommandIds'
  ]
  if (referenceCollections.some((key) => current[key] !== previous[key])) return true
  if (current.tabs === previous.tabs) return false
  return persistedTabSignature(current.tabs, current.workspaces) !== persistedTabSignature(previous.tabs, previous.workspaces)
}
