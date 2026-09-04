import { create } from 'zustand'
import { DEFAULT_DATA, FAKE_HISTORY_SEEDS, INTERNAL_NEW_TAB_URL } from '../../shared/constants'
import { resolveLayoutMode } from '../../shared/layout-mode'
import type {
  Bookmark,
  BookmarkFolder,
  BrowserSettings,
  DownloadItem,
  HistoryEntry,
  ID,
  Macro,
  MacroAction,
  MacroRunLog,
  Note,
  PersistedData,
  QuickLink,
  ReadingListItem,
  RecentlyClosedTab,
  SessionSnapshot,
  SessionSnapshotTrigger,
  SidePanelView,
  SiteMemoryEntry,
  Tab,
  TabGroup,
  TodoItem,
  Workspace
} from '../../shared/types'
import { createId } from '../lib/id'
import { displayUrl, getSearchEngine, isInternalUrl, titleFromUrl, webOriginFor } from '../lib/url'
import { isInactiveTabUnloadCandidate, restoredTabLifecycle } from './tab-lifecycle'
import { cleanTrackingUrl } from '../../shared/url-cleaning'
import { DEFAULT_WORKSPACE_IDENTITY } from '../../shared/workspace-identity'

type SettingsPatch = Omit<Partial<BrowserSettings>, 'appearance' | 'advanced' | 'privacy' | 'spoofing' | 'security' | 'network' | 'labs' | 'newTab' | 'sidePanel' | 'commandPalette' | 'keyboardShortcuts'> & {
  appearance?: Partial<BrowserSettings['appearance']>
  advanced?: Partial<BrowserSettings['advanced']>
  privacy?: Partial<BrowserSettings['privacy']>
  spoofing?: Omit<Partial<BrowserSettings['spoofing']>, 'location'> & {
    location?: Partial<BrowserSettings['spoofing']['location']>
  }
  security?: Partial<BrowserSettings['security']>
  network?: Partial<BrowserSettings['network']>
  labs?: Partial<BrowserSettings['labs']>
  newTab?: Partial<BrowserSettings['newTab']>
  sidePanel?: Partial<BrowserSettings['sidePanel']>
  commandPalette?: Partial<BrowserSettings['commandPalette']>
  keyboardShortcuts?: Partial<BrowserSettings['keyboardShortcuts']>
}

interface BrowserState extends PersistedData {
  hydrated: boolean
  commandPaletteOpen: boolean
  settingsOpen: boolean
  findOpen: boolean
  smartUnloadOpen: boolean
  activeFindQuery: string
  findResult: { activeMatchOrdinal: number; matches: number }
  promptDialog: PromptDialogState | null
  contextMenu: ContextMenuState | null
  keepAwakeTabIds: ID[]
  hydrate: (data: PersistedData) => void
  toPersistedData: () => PersistedData
  setCommandPaletteOpen: (open: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setFindOpen: (open: boolean) => void
  setSmartUnloadOpen: (open: boolean) => void
  setActiveFindQuery: (query: string) => void
  setFindResult: (result: { activeMatchOrdinal: number; matches: number }) => void
  openPromptDialog: (dialog: PromptDialogState) => void
  closePromptDialog: () => void
  openContextMenu: (menu: ContextMenuState) => void
  closeContextMenu: () => void
  setKeepAwakeTabIds: (tabIds: ID[]) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidePanelOpen: (open: boolean) => void
  setActiveSidePanel: (view: SidePanelView) => void
  setFocusMode: (enabled: boolean) => void
  setSplitView: (enabled: boolean, secondaryTabId?: ID, primaryTabId?: ID) => void
  setSplitRatio: (ratio: number) => void
  swapSplitPanes: () => void
  setActiveWorkspace: (workspaceId: ID) => void
  createWorkspace: (name: string, color?: string, isPrivate?: boolean) => Workspace
  renameWorkspace: (workspaceId: ID, name: string) => void
  updateWorkspaceAppearance: (workspaceId: ID, patch: Partial<Pick<Workspace, 'icon' | 'color'>>) => void
  updateWorkspaceIdentity: (workspaceId: ID, patch: Partial<NonNullable<Workspace['identity']>>) => void
  deleteWorkspace: (workspaceId: ID) => void
  createGroup: (workspaceId: ID, name: string) => TabGroup
  updateGroup: (groupId: ID, patch: Partial<Pick<TabGroup, 'name' | 'color' | 'collapsed'>>) => void
  deleteGroup: (groupId: ID) => void
  toggleGroup: (groupId: ID) => void
  createTab: (options?: {
    url?: string
    title?: string
    workspaceId?: ID
    identityWorkspaceId?: ID
    groupId?: ID
    pinned?: boolean
    activate?: boolean
  }) => Tab
  activateTab: (tabId: ID) => void
  updateTab: (tabId: ID, patch: Partial<Tab>) => void
  updateTabLifecycles: (updates: Array<{ id: ID; lifecycle: Tab['lifecycle'] }>) => void
  unloadInactiveTabs: (lifecycle?: Exclude<Tab['lifecycle'], 'active'>) => number
  navigateTab: (tabId: ID, url: string, title?: string) => void
  closeTab: (tabId: ID) => void
  duplicateTab: (tabId: ID) => void
  reopenClosedTab: () => void
  moveTab: (draggedId: ID, targetId: ID) => void
  moveTabToGroup: (tabId: ID, groupId?: ID) => void
  togglePinnedTab: (tabId: ID) => void
  addHistoryEntry: (entry: Pick<HistoryEntry, 'title' | 'url' | 'favicon' | 'workspaceId'>) => void
  clearHistory: () => void
  addBookmark: (bookmark: Pick<Bookmark, 'title' | 'url' | 'favicon' | 'workspaceId' | 'folderId'>) => void
  updateBookmark: (bookmarkId: ID, patch: Partial<Pick<Bookmark, 'title' | 'url' | 'folderId'>>) => void
  removeBookmark: (bookmarkId: ID) => void
  toggleCurrentBookmark: () => void
  createBookmarkFolder: (name: string) => BookmarkFolder
  updateBookmarkFolder: (folderId: ID, patch: Partial<Pick<BookmarkFolder, 'name' | 'parentId'>>) => void
  deleteBookmarkFolder: (folderId: ID) => void
  addNote: (note: Pick<Note, 'title' | 'body' | 'url' | 'workspaceId'>) => Note
  updateNote: (noteId: ID, patch: Partial<Note>) => void
  deleteNote: (noteId: ID) => void
  restoreNote: (note: Note) => void
  addReadingListItem: (item: Pick<ReadingListItem, 'title' | 'url' | 'favicon' | 'workspaceId'>) => void
  updateReadingListItem: (itemId: ID, patch: Partial<ReadingListItem>) => void
  removeReadingListItem: (itemId: ID) => void
  createMacro: (macro: Pick<Macro, 'name' | 'description' | 'icon' | 'color' | 'trigger' | 'actions'> & { enabled?: boolean }) => Macro
  updateMacro: (macroId: ID, patch: Partial<Pick<Macro, 'name' | 'description' | 'icon' | 'color' | 'trigger' | 'actions' | 'enabled' | 'lastRunAt'>>) => void
  deleteMacro: (macroId: ID) => void
  duplicateMacro: (macroId: ID) => Macro | undefined
  recordMacroRun: (log: Pick<MacroRunLog, 'macroId' | 'macroName' | 'status' | 'message'>) => void
  addSessionSnapshot: (title?: string, options?: { workspaceId?: ID; trigger?: SessionSnapshotTrigger }) => SessionSnapshot | undefined
  restoreSessionSnapshot: (snapshotId: ID) => void
  removeSessionSnapshot: (snapshotId: ID) => void
  upsertSiteMemory: (
    origin: string,
    patch: Partial<Omit<SiteMemoryEntry, 'origin' | 'hostname' | 'visitCount' | 'lastUsedAt' | 'updatedAt'>> & {
      hostname?: string
      visited?: boolean
    }
  ) => void
  forgetSiteMemory: (origin: string) => void
  forgetSite: (origin: string) => void
  updateSettings: (patch: SettingsPatch) => void
  updateDownload: (item: DownloadItem) => void
  clearCompletedDownloads: () => void
  setQuickLinks: (links: QuickLink[]) => void
  addQuickLink: (link: Pick<QuickLink, 'title' | 'url' | 'color'>) => QuickLink
  updateQuickLink: (linkId: ID, patch: Partial<Pick<QuickLink, 'title' | 'url' | 'color'>>) => void
  removeQuickLink: (linkId: ID) => void
  moveQuickLink: (sourceId: ID, targetId: ID) => void
  addTodo: (title: string, workspaceId?: ID) => TodoItem
  updateTodo: (todoId: ID, patch: Partial<Pick<TodoItem, 'title' | 'completed'>>) => void
  removeTodo: (todoId: ID) => void
  recordCommand: (commandId: string) => void
}

export interface PromptDialogState {
  title: string
  description?: string
  label: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  allowEmpty?: boolean
  hideInput?: boolean
  onConfirm: (value: string) => void
  onCancel?: () => void
}

export interface ContextMenuItem {
  id: string
  label: string
  detail?: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
  action?: () => void | Promise<void>
}

export interface ContextMenuState {
  x: number
  y: number
  title?: string
  preview?: {
    url: string
    host: string
    duplicateCount?: number
  }
  items: ContextMenuItem[]
}

function cloneInitial(): PersistedData {
  return JSON.parse(JSON.stringify(DEFAULT_DATA)) as PersistedData
}

const initial = cloneInitial()

function currentWorkspace(state: BrowserState): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)
}

function privateWorkspaceIds(state: BrowserState): Set<ID> {
  return new Set(state.workspaces.filter((workspace) => workspace.isPrivate).map((workspace) => workspace.id))
}

function defaultNewTabUrl(settings: BrowserSettings): string {
  if (settings.startupBehavior === 'home') {
    return getSearchEngine(settings.defaultSearchEngine).homeUrl
  }
  return INTERNAL_NEW_TAB_URL
}

function activeTabInWorkspace(state: BrowserState, workspaceId: ID): Tab | undefined {
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  return state.tabs.find((tab) => tab.id === workspace?.activeTabId)
}

function clampSplitRatio(ratio: number | undefined): number {
  return Math.min(72, Math.max(28, Number.isFinite(ratio) ? ratio! : 50))
}

function disabledSplitView(ratio?: number): PersistedData['splitView'] {
  return { enabled: false, ratio: clampSplitRatio(ratio) }
}

function splitViewAfterTabActivation(state: BrowserState, target: Tab): PersistedData['splitView'] {
  const split = state.splitView
  if (!split.enabled) return split
  const primary = state.tabs.find((tab) => tab.id === split.primaryTabId)
  const secondary = state.tabs.find((tab) => tab.id === split.secondaryTabId)
  if (!primary || !secondary || primary.workspaceId !== target.workspaceId || secondary.workspaceId !== target.workspaceId) {
    return disabledSplitView(split.ratio)
  }
  if (target.id === primary.id || target.id === secondary.id) return split

  const focusedBefore = activeTabInWorkspace(state, target.workspaceId)
  return focusedBefore?.id === secondary.id
    ? { ...split, secondaryTabId: target.id }
    : { ...split, primaryTabId: target.id }
}

function normalizeTab(tab: Tab): Tab {
  return {
    ...tab,
    status: tab.status === 'loading' ? 'idle' : tab.status,
    lifecycle: tab.lifecycle ?? 'sleeping',
    progress: 0,
    error: undefined,
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    zoom: tab.zoom || 1
  }
}

function normalizeRestoredTab(tab: Tab, active: boolean): Tab {
  const normalized = normalizeTab(tab)
  return {
    ...normalized,
    lifecycle: restoredTabLifecycle(active),
    status: isInternalUrl(tab.url) ? 'idle' : active ? normalized.status : 'idle'
  }
}

function defaultSnapshotTitle(workspaceName: string | undefined, trigger: SessionSnapshotTrigger): string {
  const base = workspaceName ?? 'Workspace'
  if (trigger === 'workspace-switch') return `${base} before switch`
  if (trigger === 'startup') return `${base} restored`
  if (trigger === 'restore') return `${base} before restore`
  return `${base} snapshot`
}

function buildSessionSnapshot(
  state: BrowserState,
  workspaceId = state.activeWorkspaceId,
  title?: string,
  trigger: SessionSnapshotTrigger = 'manual'
): SessionSnapshot | null {
  const workspace = state.workspaces.find((item) => item.id === workspaceId)
  if (workspace?.isPrivate) return null
  const workspaceTabs = state.tabs.filter((tab) => tab.workspaceId === workspaceId)
  if (workspaceTabs.length === 0) return null
  const groupNames = new Map(
    state.tabGroups
      .filter((group) => group.workspaceId === workspaceId)
      .map((group) => [group.id, group.name] as const)
  )
  const activeTab = activeTabInWorkspace(state, workspaceId)
  const snapshotTabs = workspaceTabs.map((tab) => ({
    title: tab.title,
    url: tab.url,
    favicon: tab.favicon,
    pinned: tab.pinned,
    groupId: tab.groupId,
    groupName: tab.groupId ? groupNames.get(tab.groupId) : undefined,
    muted: tab.muted,
    lastAccessedAt: tab.lastAccessedAt
  }))

  return {
    id: createId('snapshot'),
    title: title?.trim() || defaultSnapshotTitle(workspace?.name, trigger),
    workspaceId: workspace?.id,
    workspaceName: workspace?.name,
    workspaceColor: workspace?.color,
    tabIds: workspaceTabs.map((tab) => tab.id),
    tabs: snapshotTabs,
    activeUrl: activeTab?.url,
    trigger,
    counts: {
      tabs: snapshotTabs.length,
      pinned: snapshotTabs.filter((tab) => tab.pinned).length,
      internal: snapshotTabs.filter((tab) => isInternalUrl(tab.url)).length
    },
    createdAt: Date.now()
  }
}

function sessionSnapshotSignature(snapshot: SessionSnapshot): string {
  return [
    snapshot.workspaceId ?? 'workspace',
    snapshot.activeUrl ?? '',
    ...(snapshot.tabs ?? []).map((tab) => `${tab.url}|${tab.pinned ? 1 : 0}|${tab.groupName ?? ''}`)
  ].join('::')
}

function appendSessionSnapshot(current: SessionSnapshot[], snapshot: SessionSnapshot | null): SessionSnapshot[] {
  if (!snapshot) return current
  const latest = current[0]
  if (
    latest &&
    latest.workspaceId === snapshot.workspaceId &&
    latest.trigger === snapshot.trigger &&
    snapshot.createdAt - latest.createdAt < 3 * 60_000 &&
    sessionSnapshotSignature(latest) === sessionSnapshotSignature(snapshot)
  ) {
    return current
  }
  return [snapshot, ...current].slice(0, 80)
}

function fakeHistoryEntry(seedIndex: number, workspaceId: ID | undefined, now: number, offset = 0): HistoryEntry {
  const seed = FAKE_HISTORY_SEEDS[seedIndex % FAKE_HISTORY_SEEDS.length]
  return {
    id: createId('history'),
    title: seed.title,
    url: seed.url,
    favicon: `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(seed.url)}&sz=32`,
    visitCount: 1 + ((seedIndex + offset) % 4),
    lastVisitedAt: now - offset * 1000 * 60 * (9 + (offset % 7)),
    workspaceId
  }
}

function fakeHistoryBatch(workspaceId: ID | undefined, count = 18): HistoryEntry[] {
  const now = Date.now()
  return Array.from({ length: count }, (_item, index) => fakeHistoryEntry(index, workspaceId, now, index))
}

function upsertFakeHistory(history: HistoryEntry[], workspaceId: ID | undefined): HistoryEntry[] {
  const now = Date.now()
  const seedIndex = Math.abs(Math.floor(now / 997) + history.length) % FAKE_HISTORY_SEEDS.length
  const next = fakeHistoryEntry(seedIndex, workspaceId, now)
  const existing = history.find((item) => item.url === next.url)
  const nextEntry = existing
    ? {
        ...existing,
        visitCount: existing.visitCount + 1,
        lastVisitedAt: now,
        workspaceId: workspaceId ?? existing.workspaceId
      }
    : next
  return [nextEntry, ...history.filter((item) => item.url !== next.url)].slice(0, 1000)
}

function withoutVolatileState(state: BrowserState): PersistedData {
  const isolatedWorkspaceIds = privateWorkspaceIds(state)
  return {
    schemaVersion: state.schemaVersion,
    activeWorkspaceId: state.activeWorkspaceId,
    activeSidePanel: state.activeSidePanel,
    sidePanelOpen: state.sidePanelOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    focusMode: state.focusMode,
    splitView: state.splitView,
    workspaces: state.workspaces,
    tabGroups: state.tabGroups,
    tabs: state.tabs.filter((tab) => !isolatedWorkspaceIds.has(tab.workspaceId)).map(normalizeTab),
    recentlyClosedTabs: state.recentlyClosedTabs.filter((tab) => !isolatedWorkspaceIds.has(tab.workspaceId)),
    bookmarks: state.bookmarks,
    bookmarkFolders: state.bookmarkFolders,
    history: state.history.filter((entry) => !entry.workspaceId || !isolatedWorkspaceIds.has(entry.workspaceId)).slice(0, 1000),
    downloads: state.downloads.slice(0, 200),
    notes: state.notes,
    readingList: state.readingList,
    macros: state.macros,
    macroLogs: state.macroLogs.slice(0, 200),
    sessionSnapshots: state.sessionSnapshots.filter((snapshot) => !snapshot.workspaceId || !isolatedWorkspaceIds.has(snapshot.workspaceId)).slice(0, 80),
    quickLinks: state.quickLinks,
    siteMemory: state.siteMemory.slice(0, 250),
    todos: state.todos,
    recentCommandIds: state.recentCommandIds.slice(0, 12),
    settings: state.settings
  }
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  ...initial,
  hydrated: false,
  commandPaletteOpen: false,
  settingsOpen: false,
  findOpen: false,
  smartUnloadOpen: false,
  activeFindQuery: '',
  findResult: { activeMatchOrdinal: 0, matches: 0 },
  promptDialog: null,
  contextMenu: null,
  keepAwakeTabIds: [],

  hydrate: (data) => {
    const shouldRestore = data.settings.startupBehavior === 'restore' && data.settings.restorePreviousSession
    const isolatedWorkspaceIds = new Set(data.workspaces.filter((workspace) => workspace.isPrivate).map((workspace) => workspace.id))
    const activeWorkspace = data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)
    const priorityTabIds = new Set([
      activeWorkspace?.activeTabId,
      data.splitView.enabled ? data.splitView.primaryTabId : undefined,
      data.splitView.enabled ? data.splitView.secondaryTabId : undefined
    ].filter((id): id is string => Boolean(id)))
    const restoredTabs = shouldRestore
      ? data.tabs
          .filter((tab) => !isolatedWorkspaceIds.has(tab.workspaceId))
          .map((tab) => normalizeRestoredTab(tab, priorityTabIds.has(tab.id)))
      : []
    const restoredSplitView = (() => {
      if (!data.splitView.enabled) return disabledSplitView(data.splitView.ratio)
      const primaryTabId = data.splitView.primaryTabId ?? activeWorkspace?.activeTabId
      const primary = restoredTabs.find((tab) => tab.id === primaryTabId)
      const secondary = restoredTabs.find((tab) => tab.id === data.splitView.secondaryTabId)
      if (!primary || !secondary || primary.id === secondary.id || primary.workspaceId !== data.activeWorkspaceId || secondary.workspaceId !== data.activeWorkspaceId) {
        return disabledSplitView(data.splitView.ratio)
      }
      return { enabled: true, primaryTabId: primary.id, secondaryTabId: secondary.id, ratio: clampSplitRatio(data.splitView.ratio) }
    })()
    const restoredWorkspaces = restoredSplitView.enabled && restoredSplitView.primaryTabId && restoredSplitView.secondaryTabId
      ? data.workspaces.map((workspace) =>
          workspace.id === data.activeWorkspaceId && workspace.activeTabId !== restoredSplitView.primaryTabId && workspace.activeTabId !== restoredSplitView.secondaryTabId
            ? { ...workspace, activeTabId: restoredSplitView.primaryTabId }
            : workspace
        )
      : data.workspaces
    set({
      ...data,
      workspaces: restoredWorkspaces,
      tabs: restoredTabs,
      splitView: restoredSplitView,
      keepAwakeTabIds: [],
      hydrated: true
    })
    if (restoredTabs.length === 0 || !activeTabInWorkspace(get(), data.activeWorkspaceId)) {
      get().createTab({ workspaceId: data.activeWorkspaceId, url: defaultNewTabUrl(data.settings), activate: true })
    }
    if (shouldRestore && restoredTabs.length > 0) {
      const snapshot = buildSessionSnapshot(get(), data.activeWorkspaceId, undefined, 'startup')
      set((current) => ({ sessionSnapshots: appendSessionSnapshot(current.sessionSnapshots, snapshot) }))
    }
  },

  toPersistedData: () => withoutVolatileState(get()),

  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFindOpen: (open) => set({ findOpen: open }),
  setSmartUnloadOpen: (open) => set({ smartUnloadOpen: open }),
  setActiveFindQuery: (query) => set({ activeFindQuery: query }),
  setFindResult: (result) => set({ findResult: result }),
  openPromptDialog: (dialog) => set({ promptDialog: dialog }),
  closePromptDialog: () => set({ promptDialog: null }),
  openContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  setKeepAwakeTabIds: (tabIds) => {
    const next = [...new Set(tabIds)].sort()
    set((state) => (
      state.keepAwakeTabIds.length === next.length &&
      state.keepAwakeTabIds.every((id, index) => id === next[index])
        ? {}
        : { keepAwakeTabIds: next }
    ))
  },
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setSidePanelOpen: (open) => set({ sidePanelOpen: open }),
  setActiveSidePanel: (view) => set({ activeSidePanel: view, sidePanelOpen: true }),
  setFocusMode: (enabled) => set({ focusMode: enabled }),
  setSplitView: (enabled, secondaryTabId, primaryTabId) =>
    set((state) => {
      if (!enabled) return { splitView: disabledSplitView(state.splitView.ratio) }
      const active = activeTabInWorkspace(state, state.activeWorkspaceId)
      const primary = state.tabs.find((tab) => tab.id === (primaryTabId ?? active?.id))
      const secondary = state.tabs.find((tab) => tab.id === secondaryTabId)
      if (!primary || !secondary || primary.id === secondary.id || primary.workspaceId !== state.activeWorkspaceId || secondary.workspaceId !== state.activeWorkspaceId) {
        return { splitView: disabledSplitView(state.splitView.ratio) }
      }
      return {
        splitView: {
          enabled: true,
          primaryTabId: primary.id,
          secondaryTabId: secondary.id,
          ratio: clampSplitRatio(state.splitView.ratio)
        },
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === state.activeWorkspaceId && workspace.activeTabId !== primary.id && workspace.activeTabId !== secondary.id
            ? { ...workspace, activeTabId: primary.id, updatedAt: Date.now() }
            : workspace
        )
      }
    }),
  setSplitRatio: (ratio) => set((state) => ({ splitView: { ...state.splitView, ratio: clampSplitRatio(ratio) } })),
  swapSplitPanes: () => set((state) => {
    if (!state.splitView.enabled) return {}
    const primary = state.tabs.find((tab) => tab.id === state.splitView.primaryTabId)
    const secondary = state.tabs.find((tab) => tab.id === state.splitView.secondaryTabId)
    const active = activeTabInWorkspace(state, state.activeWorkspaceId)
    if (
      !primary ||
      !secondary ||
      !active ||
      primary.id === secondary.id ||
      primary.workspaceId !== state.activeWorkspaceId ||
      secondary.workspaceId !== state.activeWorkspaceId ||
      (active.id !== primary.id && active.id !== secondary.id)
    ) {
      return { splitView: disabledSplitView(state.splitView.ratio) }
    }
    return {
      splitView: {
        ...state.splitView,
        primaryTabId: secondary.id,
        secondaryTabId: primary.id
      }
    }
  }),

  setActiveWorkspace: (workspaceId) => {
    const state = get()
    const workspace = state.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    if (state.activeWorkspaceId === workspaceId) return
    const snapshot = buildSessionSnapshot(state, state.activeWorkspaceId, undefined, 'workspace-switch')
    set((current) => ({
      activeWorkspaceId: workspaceId,
      splitView: disabledSplitView(current.splitView.ratio),
      sessionSnapshots: appendSessionSnapshot(current.sessionSnapshots, snapshot)
    }))
    if (!activeTabInWorkspace(get(), workspaceId)) {
      get().createTab({ workspaceId, activate: true })
    }
  },

  createWorkspace: (name, color = '#74e7ff', isPrivate = false) => {
    const now = Date.now()
    const workspace: Workspace = {
      id: createId('workspace'),
      name: name.trim() || 'Untitled',
      icon: isPrivate ? 'Shield' : 'Sparkles',
      color,
      order: get().workspaces.length,
      isPrivate,
      identity: {
        ...DEFAULT_WORKSPACE_IDENTITY,
        sessionMode: isPrivate ? 'ephemeral' : 'isolated'
      },
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({
      workspaces: [...state.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      splitView: disabledSplitView(state.splitView.ratio)
    }))
    get().createGroup(workspace.id, 'Today')
    get().createTab({ workspaceId: workspace.id, activate: true })
    return workspace
  },

  renameWorkspace: (workspaceId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    set((state) => ({
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, name: trimmed, updatedAt: Date.now() } : workspace
      )
    }))
  },

  updateWorkspaceAppearance: (workspaceId, patch) => {
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace
        const icon = typeof patch.icon === 'string' && patch.icon.trim() ? patch.icon.trim().slice(0, 64) : workspace.icon
        const color = typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color) ? patch.color.toLowerCase() : workspace.color
        return { ...workspace, icon, color, updatedAt: Date.now() }
      })
    }))
  },

  updateWorkspaceIdentity: (workspaceId, patch) => {
    set((state) => ({
      workspaces: state.workspaces.map((workspace) => workspace.id === workspaceId
        ? {
            ...workspace,
            identity: { ...DEFAULT_WORKSPACE_IDENTITY, ...workspace.identity, ...patch },
            isPrivate: patch.sessionMode === 'ephemeral' ? true : patch.sessionMode ? false : workspace.isPrivate,
            updatedAt: Date.now()
          }
        : workspace)
    }))
  },

  deleteWorkspace: (workspaceId) => {
    const state = get()
    if (state.workspaces.length <= 1) return
    const nextWorkspace = state.workspaces.find((workspace) => workspace.id !== workspaceId)
    if (!nextWorkspace) return
    set((current) => ({
      activeWorkspaceId: current.activeWorkspaceId === workspaceId ? nextWorkspace.id : current.activeWorkspaceId,
      splitView: current.activeWorkspaceId === workspaceId || (
        current.splitView.enabled && current.tabs.some((tab) =>
          tab.workspaceId === workspaceId && (tab.id === current.splitView.primaryTabId || tab.id === current.splitView.secondaryTabId)
        )
      )
        ? disabledSplitView(current.splitView.ratio)
        : current.splitView,
      workspaces: current.workspaces.filter((workspace) => workspace.id !== workspaceId),
      tabGroups: current.tabGroups.filter((group) => group.workspaceId !== workspaceId),
      tabs: current.tabs.filter((tab) => tab.workspaceId !== workspaceId),
      notes: current.notes.filter((note) => note.workspaceId !== workspaceId),
      readingList: current.readingList.filter((item) => item.workspaceId !== workspaceId)
    }))
  },

  createGroup: (workspaceId, name) => {
    const group: TabGroup = {
      id: createId('group'),
      workspaceId,
      name: name.trim() || 'Group',
      color: get().workspaces.find((workspace) => workspace.id === workspaceId)?.color ?? '#74e7ff',
      collapsed: false,
      order: get().tabGroups.filter((groupItem) => groupItem.workspaceId === workspaceId).length
    }
    set((state) => ({ tabGroups: [...state.tabGroups, group] }))
    return group
  },

  updateGroup: (groupId, patch) => {
    set((state) => ({
      tabGroups: state.tabGroups.map((group) => (group.id === groupId ? { ...group, ...patch } : group))
    }))
  },

  deleteGroup: (groupId) => {
    set((state) => ({
      tabGroups: state.tabGroups.filter((group) => group.id !== groupId),
      tabs: state.tabs.map((tab) => (tab.groupId === groupId ? { ...tab, groupId: undefined } : tab))
    }))
  },

  toggleGroup: (groupId) => {
    set((state) => ({
      tabGroups: state.tabGroups.map((group) =>
        group.id === groupId ? { ...group, collapsed: !group.collapsed } : group
      )
    }))
  },

  createTab: (options = {}) => {
    const state = get()
    const workspaceId = options.workspaceId ?? state.activeWorkspaceId
    const workspace = state.workspaces.find((item) => item.id === workspaceId)
    const activeTab = state.tabs.find((item) => item.id === workspace?.activeTabId && item.workspaceId === workspaceId)
    const workspaceGroups = state.tabGroups.filter((group) => group.workspaceId === workspaceId)
    const groupId = options.groupId ?? activeTab?.groupId ?? workspaceGroups[0]?.id
    const requestedUrl = options.url ?? INTERNAL_NEW_TAB_URL
    const url = state.settings.privacy.stripTrackingParameters
      ? cleanTrackingUrl(requestedUrl, state.settings.privacy.stripAffiliateParameters).url
      : requestedUrl
    const siteIdentity = webOriginFor(url)
    const rememberedSite = siteIdentity ? state.siteMemory.find((entry) => entry.origin === siteIdentity.origin) : undefined
    const now = Date.now()
    const tab: Tab = {
      id: createId('tab'),
      workspaceId,
      identityWorkspaceId: options.identityWorkspaceId,
      groupId,
      title: options.title ?? titleFromUrl(url),
      url,
      displayUrl: displayUrl(url),
      pinned: Boolean(options.pinned),
      status: 'idle',
      lifecycle: options.activate === false ? 'sleeping' : 'active',
      progress: 0,
      canGoBack: false,
      canGoForward: false,
      muted: rememberedSite?.muted,
      zoom: rememberedSite?.zoom ?? 1,
      createdAt: now,
      lastAccessedAt: now
    }
    set((current) => {
      return {
        tabs: [...current.tabs, tab],
        splitView: options.activate === false ? current.splitView : splitViewAfterTabActivation(current, tab),
        workspaces: current.workspaces.map((workspace) =>
          workspace.id === workspaceId && options.activate !== false
            ? { ...workspace, activeTabId: tab.id, updatedAt: now }
            : workspace
        )
      }
    })
    return tab
  },

  activateTab: (tabId) => {
    const current = get()
    const tab = current.tabs.find((item) => item.id === tabId)
    if (!tab) return
    const now = Date.now()
    set((state) => ({
      activeWorkspaceId: tab.workspaceId,
      splitView: splitViewAfterTabActivation(state, tab),
      workspaces: state.workspaces.map((workspace) =>
        workspace.id === tab.workspaceId ? { ...workspace, activeTabId: tab.id, updatedAt: now } : workspace
      ),
      tabs: state.tabs.map((item) =>
        item.id === tabId
          ? { ...item, lifecycle: 'active', lastAccessedAt: now }
          : item
      )
    }))
  },

  updateTab: (tabId, patch) => {
    set((state) => {
      let changed = false
      const tabs = state.tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        for (const [key, value] of Object.entries(patch)) {
          if (!Object.is(tab[key as keyof Tab], value)) {
            changed = true
            break
          }
        }
        return changed ? { ...tab, ...patch } : tab
      })
      return changed ? { tabs } : {}
    })
  },

  updateTabLifecycles: (updates) => {
    if (updates.length === 0) return
    const lifecycleById = new Map(updates.map((update) => [update.id, update.lifecycle]))
    set((state) => {
      let changed = false
      const tabs = state.tabs.map((tab) => {
        const lifecycle = lifecycleById.get(tab.id)
        if (!lifecycle || tab.lifecycle === lifecycle) return tab
        changed = true
        return { ...tab, lifecycle }
      })
      return changed ? { tabs } : {}
    })
  },

  unloadInactiveTabs: (lifecycle = 'sleeping') => {
    const state = get()
    const active = activeTabInWorkspace(state, state.activeWorkspaceId)
    // Backdate past the retention controller's discard deadline so a manual
    // unload always releases the guest, regardless of remaining awake slots.
    const cutoffMinutes = Math.max(
      1,
      Math.max(state.settings.advanced.discardAfterMinutes, state.settings.advanced.hibernateAfterMinutes) + 1
    )
    const lastAccessedAt = Date.now() - cutoffMinutes * 60_000
    const candidates = new Set(
      state.tabs
        .filter((tab) => isInactiveTabUnloadCandidate(tab, {
          activeTabId: active?.id,
          splitTabIds: state.splitView.enabled
            ? [state.splitView.primaryTabId, state.splitView.secondaryTabId].filter((id): id is ID => Boolean(id))
            : [],
          keepAwakeTabIds: state.keepAwakeTabIds,
          keepPinnedTabsAwake: state.settings.advanced.keepPinnedTabsAwake,
          internal: isInternalUrl(tab.url)
        }))
        .map((tab) => tab.id)
    )
    if (candidates.size === 0) return 0
    set((current) => ({
      settings: {
        ...current.settings,
        hibernateInactiveTabs: true
      },
      tabs: current.tabs.map((tab) =>
        candidates.has(tab.id)
          ? {
              ...tab,
              lifecycle,
              status: tab.status === 'loading' ? 'idle' : tab.status,
              progress: 0,
              lastAccessedAt
            }
          : tab
      )
    }))
    return candidates.size
  },

  navigateTab: (tabId, url, title) => {
    set((state) => {
      const cleanUrl = state.settings.privacy.stripTrackingParameters
        ? cleanTrackingUrl(url, state.settings.privacy.stripAffiliateParameters).url
        : url
      return {
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? (() => {
              const siteIdentity = webOriginFor(cleanUrl)
              const rememberedSite = siteIdentity ? state.siteMemory.find((entry) => entry.origin === siteIdentity.origin) : undefined
              return {
                ...tab,
                url: cleanUrl,
                title: title ?? titleFromUrl(cleanUrl),
                displayUrl: displayUrl(cleanUrl),
                error: undefined,
                muted: rememberedSite?.muted ?? tab.muted,
                status: isInternalUrl(cleanUrl) ? 'idle' : 'loading',
                lifecycle: 'active',
                progress: isInternalUrl(cleanUrl) ? 0 : 0.12,
                zoom: rememberedSite?.zoom ?? tab.zoom,
                lastAccessedAt: Date.now()
              }
            })()
          : tab
      )
      }
    })
  },

  closeTab: (tabId) => {
    const state = get()
    const tab = state.tabs.find((item) => item.id === tabId)
    if (!tab) return
    const workspace = state.workspaces.find((item) => item.id === tab.workspaceId)
    const identityWorkspace = state.workspaces.find((item) => item.id === tab.identityWorkspaceId) ?? workspace
    const ephemeralIdentity = identityWorkspace?.identity?.sessionMode === 'ephemeral' || identityWorkspace?.isPrivate
    const workspaceTabs = state.tabs.filter((item) => item.workspaceId === tab.workspaceId)
    const closingIndex = workspaceTabs.findIndex((item) => item.id === tabId)
    const replacement =
      closingIndex >= 0
        ? workspaceTabs[closingIndex + 1] ?? workspaceTabs[closingIndex - 1]
        : workspaceTabs.find((item) => item.id !== tabId)
    const closingSplitPane = state.splitView.enabled &&
      (state.splitView.primaryTabId === tabId || state.splitView.secondaryTabId === tabId)
    const survivingSplitTabId = state.splitView.primaryTabId === tabId
      ? state.splitView.secondaryTabId
      : state.splitView.primaryTabId
    const nextActiveTabId = closingSplitPane && survivingSplitTabId
      ? survivingSplitTabId
      : replacement?.id
    const closed: RecentlyClosedTab = {
      id: createId('closed'),
      workspaceId: tab.workspaceId,
      title: tab.title,
      url: tab.url,
      favicon: tab.favicon,
      closedAt: Date.now()
    }
    set((current) => ({
      recentlyClosedTabs: ephemeralIdentity || current.settings.privacy.disableRecentlyClosedTabs ? current.recentlyClosedTabs : [closed, ...current.recentlyClosedTabs].slice(0, 30),
      tabs: current.tabs.filter((item) => item.id !== tabId),
      splitView: closingSplitPane ? disabledSplitView(current.splitView.ratio) : current.splitView,
      workspaces: current.workspaces.map((workspace) =>
        workspace.id === tab.workspaceId && workspace.activeTabId === tabId
          ? { ...workspace, activeTabId: nextActiveTabId, updatedAt: Date.now() }
          : workspace
      )
    }))
    if (!replacement) get().createTab({ workspaceId: tab.workspaceId, activate: true })
  },

  duplicateTab: (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId)
    if (!tab) return
    get().createTab({
      url: tab.url,
      title: tab.title,
      workspaceId: tab.workspaceId,
      identityWorkspaceId: tab.identityWorkspaceId,
      groupId: tab.groupId,
      pinned: false,
      activate: true
    })
  },

  reopenClosedTab: () => {
    const [closed, ...rest] = get().recentlyClosedTabs
    if (!closed) return
    set({ recentlyClosedTabs: rest })
    get().createTab({
      url: closed.url,
      title: closed.title,
      workspaceId: closed.workspaceId,
      activate: true
    })
  },

  moveTab: (draggedId, targetId) => {
    if (draggedId === targetId) return
    const state = get()
    const draggedIndex = state.tabs.findIndex((tab) => tab.id === draggedId)
    const targetIndex = state.tabs.findIndex((tab) => tab.id === targetId)
    if (draggedIndex < 0 || targetIndex < 0) return
    const next = [...state.tabs]
    const [dragged] = next.splice(draggedIndex, 1)
    next.splice(targetIndex, 0, dragged)
    set({ tabs: next })
  },

  moveTabToGroup: (tabId, groupId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, groupId } : tab))
    }))
  },

  togglePinnedTab: (tabId) => {
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab))
    }))
  },

  addHistoryEntry: (entry) => {
    if (isInternalUrl(entry.url)) return
    const workspace = entry.workspaceId ? get().workspaces.find((item) => item.id === entry.workspaceId) : undefined
    if (workspace?.isPrivate) return
    if (get().settings.privacy.disableHistory) return
    if (get().settings.privacy.fakeHistoryEnabled) {
      set((state) => ({ history: upsertFakeHistory(state.history, entry.workspaceId) }))
      return
    }
    const now = Date.now()
    set((state) => {
      const existing = state.history.find((item) => item.url === entry.url)
      const nextEntry: HistoryEntry = existing
        ? {
            ...existing,
            title: entry.title || existing.title,
            favicon: entry.favicon || existing.favicon,
            visitCount: existing.visitCount + 1,
            lastVisitedAt: now,
            workspaceId: entry.workspaceId ?? existing.workspaceId
          }
        : {
            id: createId('history'),
            title: entry.title || titleFromUrl(entry.url),
            url: entry.url,
            favicon: entry.favicon,
            visitCount: 1,
            lastVisitedAt: now,
            workspaceId: entry.workspaceId
          }
      return {
        history: [nextEntry, ...state.history.filter((item) => item.url !== entry.url)].slice(0, 1000)
      }
    })
  },

  clearHistory: () => set({ history: [] }),

  addBookmark: (bookmark) => {
    if (get().bookmarks.some((item) => item.url === bookmark.url)) return
    const now = Date.now()
    set((state) => ({
      bookmarks: [
        {
          id: createId('bookmark'),
          title: bookmark.title || titleFromUrl(bookmark.url),
          url: bookmark.url,
          favicon: bookmark.favicon,
          folderId: bookmark.folderId,
          workspaceId: bookmark.workspaceId,
          createdAt: now,
          updatedAt: now
        },
        ...state.bookmarks
      ]
    }))
  },

  updateBookmark: (bookmarkId, patch) => {
    set((state) => ({
      bookmarks: state.bookmarks.map((bookmark) =>
        bookmark.id === bookmarkId
          ? {
              ...bookmark,
              ...patch,
              title: patch.title !== undefined ? patch.title.trim() : bookmark.title,
              url: patch.url?.trim() || bookmark.url,
              updatedAt: Date.now()
            }
          : bookmark
      )
    }))
  },

  removeBookmark: (bookmarkId) => {
    set((state) => ({ bookmarks: state.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId) }))
  },

  toggleCurrentBookmark: () => {
    const state = get()
    const workspace = currentWorkspace(state)
    const tab = state.tabs.find((item) => item.id === workspace?.activeTabId)
    if (!tab || isInternalUrl(tab.url)) return
    const existing = state.bookmarks.find((bookmark) => bookmark.url === tab.url)
    if (existing) {
      get().removeBookmark(existing.id)
    } else {
      get().addBookmark({
        title: tab.title,
        url: tab.url,
        favicon: tab.favicon,
        workspaceId: tab.workspaceId
      })
    }
  },

  createBookmarkFolder: (name) => {
    const now = Date.now()
    const folder: BookmarkFolder = {
      id: createId('folder'),
      name: name.trim() || 'Folder',
      order: get().bookmarkFolders.length,
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({ bookmarkFolders: [...state.bookmarkFolders, folder] }))
    return folder
  },

  updateBookmarkFolder: (folderId, patch) => {
    set((state) => ({
      bookmarkFolders: state.bookmarkFolders.map((folder) =>
        folder.id === folderId
          ? {
              ...folder,
              ...patch,
              name: patch.name?.trim() || folder.name,
              updatedAt: Date.now()
            }
          : folder
      )
    }))
  },

  deleteBookmarkFolder: (folderId) => {
    set((state) => ({
      bookmarkFolders: state.bookmarkFolders.filter((folder) => folder.id !== folderId),
      bookmarks: state.bookmarks.map((bookmark) => (bookmark.folderId === folderId ? { ...bookmark, folderId: undefined } : bookmark))
    }))
  },

  addNote: (note) => {
    const now = Date.now()
    const next: Note = {
      id: createId('note'),
      title: note.title.trim() || 'Untitled note',
      body: note.body,
      url: note.url,
      workspaceId: note.workspaceId,
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({ notes: [next, ...state.notes] }))
    return next
  },

  updateNote: (noteId, patch) => {
    set((state) => ({
      notes: state.notes.map((note) =>
        note.id === noteId ? { ...note, ...patch, updatedAt: Date.now() } : note
      )
    }))
  },

  deleteNote: (noteId) => {
    set((state) => ({ notes: state.notes.filter((note) => note.id !== noteId) }))
  },

  restoreNote: (note) => {
    set((state) => ({ notes: [note, ...state.notes.filter((item) => item.id !== note.id)] }))
  },

  addReadingListItem: (item) => {
    if (get().readingList.some((entry) => entry.url === item.url)) return
    const now = Date.now()
    set((state) => ({
      readingList: [
        {
          id: createId('reading'),
          title: item.title || titleFromUrl(item.url),
          url: item.url,
          favicon: item.favicon,
          workspaceId: item.workspaceId,
          read: false,
          createdAt: now,
          updatedAt: now
        },
        ...state.readingList
      ]
    }))
  },

  updateReadingListItem: (itemId, patch) => {
    set((state) => ({
      readingList: state.readingList.map((item) =>
        item.id === itemId ? { ...item, ...patch, updatedAt: Date.now() } : item
      )
    }))
  },

  removeReadingListItem: (itemId) => {
    set((state) => ({ readingList: state.readingList.filter((item) => item.id !== itemId) }))
  },

  createMacro: (macro) => {
    const now = Date.now()
    const next: Macro = {
      id: createId('macro'),
      name: macro.name.trim() || 'Untitled macro',
      description: macro.description.trim(),
      icon: macro.icon || 'Sparkles',
      color: macro.color || get().settings.accentColor,
      trigger: macro.trigger,
      actions: macro.actions,
      enabled: macro.enabled ?? true,
      createdAt: now,
      updatedAt: now
    }
    set((state) => ({ macros: [next, ...state.macros] }))
    return next
  },

  updateMacro: (macroId, patch) => {
    set((state) => ({
      macros: state.macros.map((macro) =>
        macro.id === macroId
          ? {
              ...macro,
              ...patch,
              name: patch.name?.trim() || macro.name,
              description: patch.description === undefined ? macro.description : patch.description.trim(),
              updatedAt: Date.now()
            }
          : macro
      )
    }))
  },

  deleteMacro: (macroId) => {
    set((state) => ({
      macros: state.macros.filter((macro) => macro.id !== macroId),
      macroLogs: state.macroLogs.filter((log) => log.macroId !== macroId)
    }))
  },

  duplicateMacro: (macroId) => {
    const macro = get().macros.find((item) => item.id === macroId)
    if (!macro) return undefined
    const actions = macro.actions.map((action): MacroAction => ({ ...action, id: createId('action') }))
    return get().createMacro({
      name: `${macro.name} Copy`,
      description: macro.description,
      icon: macro.icon,
      color: macro.color,
      trigger: macro.trigger,
      actions,
      enabled: macro.enabled
    })
  },

  recordMacroRun: (log) => {
    const entry: MacroRunLog = {
      id: createId('macro-log'),
      ...log,
      ranAt: Date.now()
    }
    set((state) => ({
      macroLogs: [entry, ...state.macroLogs].slice(0, 200),
      macros: state.macros.map((macro) => (macro.id === log.macroId ? { ...macro, lastRunAt: entry.ranAt } : macro))
    }))
  },

  addSessionSnapshot: (title, options) => {
    const snapshot = buildSessionSnapshot(get(), options?.workspaceId, title, options?.trigger ?? 'manual')
    if (!snapshot) return undefined
    set((current) => ({ sessionSnapshots: appendSessionSnapshot(current.sessionSnapshots, snapshot) }))
    return snapshot
  },

  restoreSessionSnapshot: (snapshotId) => {
    const state = get()
    const snapshot = state.sessionSnapshots.find((entry) => entry.id === snapshotId)
    if (!snapshot?.tabs?.length) return

    const now = Date.now()
    const backupSnapshot = buildSessionSnapshot(state, state.activeWorkspaceId, undefined, 'restore')
    const existingWorkspace = snapshot.workspaceId ? state.workspaces.find((workspace) => workspace.id === snapshot.workspaceId) : currentWorkspace(state)
    const workspaceId = existingWorkspace?.id ?? createId('workspace')
    const workspaceName = snapshot.workspaceName?.trim() || existingWorkspace?.name || 'Restored session'
    const workspaceColor = snapshot.workspaceColor || existingWorkspace?.color || state.settings.accentColor
    const workspace = existingWorkspace ?? {
      id: workspaceId,
      name: workspaceName,
      icon: 'Sparkles',
      color: workspaceColor,
      order: state.workspaces.length,
      createdAt: now,
      updatedAt: now
    }

    const existingGroups = state.tabGroups.filter((group) => group.workspaceId === workspaceId)
    const groupByName = new Map(existingGroups.map((group) => [group.name, group.id] as const))
    const restoredGroups = [...existingGroups]

    const ensureGroupId = (groupName?: string): ID | undefined => {
      const trimmed = groupName?.trim()
      if (!trimmed) return restoredGroups[0]?.id
      const existing = groupByName.get(trimmed)
      if (existing) return existing
      const nextGroup: TabGroup = {
        id: createId('group'),
        workspaceId,
        name: trimmed,
        color: workspaceColor,
        collapsed: false,
        order: restoredGroups.length
      }
      restoredGroups.push(nextGroup)
      groupByName.set(trimmed, nextGroup.id)
      return nextGroup.id
    }

    if (restoredGroups.length === 0) {
      const defaultGroup: TabGroup = {
        id: createId('group'),
        workspaceId,
        name: 'Timeline',
        color: workspaceColor,
        collapsed: false,
        order: 0
      }
      restoredGroups.push(defaultGroup)
      groupByName.set(defaultGroup.name, defaultGroup.id)
    }

    const activeIndex = Math.max(0, snapshot.tabs.findIndex((tab) => tab.url === snapshot.activeUrl))
    const restoredTabs = snapshot.tabs.map((tab, index): Tab => ({
      id: createId('tab'),
      workspaceId,
      groupId: ensureGroupId(tab.groupName),
      title: tab.title,
      url: tab.url,
      displayUrl: displayUrl(tab.url),
      favicon: tab.favicon,
      pinned: tab.pinned,
      muted: tab.muted,
      status: isInternalUrl(tab.url) ? 'idle' : 'loading',
      lifecycle: index === activeIndex ? 'active' : 'sleeping',
      progress: isInternalUrl(tab.url) ? 0 : 0.12,
      canGoBack: false,
      canGoForward: false,
      zoom: 1,
      lastAccessedAt: tab.lastAccessedAt || now,
      createdAt: now
    }))
    const activeTabId = restoredTabs[activeIndex]?.id ?? restoredTabs[0]?.id

    set((current) => {
      const nextWorkspaces = existingWorkspace
        ? current.workspaces.map((item) =>
            item.id === workspaceId
              ? { ...item, name: workspaceName, color: workspaceColor, activeTabId, updatedAt: now }
              : item
          )
        : [...current.workspaces, { ...workspace, activeTabId }]

      return {
        activeWorkspaceId: workspaceId,
        workspaces: nextWorkspaces,
        tabGroups: [...current.tabGroups.filter((group) => group.workspaceId !== workspaceId), ...restoredGroups],
        tabs: [...current.tabs.filter((tab) => tab.workspaceId !== workspaceId), ...restoredTabs],
        splitView: disabledSplitView(current.splitView.ratio),
        sessionSnapshots: appendSessionSnapshot(current.sessionSnapshots, backupSnapshot)
      }
    })
  },

  removeSessionSnapshot: (snapshotId) => {
    set((state) => ({ sessionSnapshots: state.sessionSnapshots.filter((snapshot) => snapshot.id !== snapshotId) }))
  },

  upsertSiteMemory: (origin, patch) => {
    if (!origin) return
    const now = Date.now()
    set((state) => {
      const existing = state.siteMemory.find((entry) => entry.origin === origin)
      const { visited, ...memoryPatch } = patch
      const hostname = memoryPatch.hostname ?? existing?.hostname ?? webOriginFor(origin)?.hostname ?? origin
      const nextEntry: SiteMemoryEntry = {
        ...existing,
        ...memoryPatch,
        origin,
        hostname,
        visitCount: (existing?.visitCount ?? 0) + (visited ? 1 : 0),
        lastUsedAt: visited ? now : existing?.lastUsedAt ?? now,
        updatedAt: now
      }
      const nextMemory = [nextEntry, ...state.siteMemory.filter((entry) => entry.origin !== origin)]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 250)
      return { siteMemory: nextMemory }
    })
  },

  forgetSiteMemory: (origin) => {
    set((state) => ({ siteMemory: state.siteMemory.filter((entry) => entry.origin !== origin) }))
  },

  forgetSite: (origin) => {
    let hostname = ''
    try { hostname = new URL(origin).hostname } catch { return }
    const belongsToSite = (url: string): boolean => {
      try { return new URL(url).hostname === hostname || new URL(url).hostname.endsWith(`.${hostname}`) } catch { return false }
    }
    set((state) => ({
      history: state.history.filter((entry) => !belongsToSite(entry.url)),
      recentlyClosedTabs: state.recentlyClosedTabs.filter((entry) => !belongsToSite(entry.url)),
      siteMemory: state.siteMemory.filter((entry) => entry.origin !== origin),
      settings: {
        ...state.settings,
        privacy: {
          ...state.settings.privacy,
          adBlockAllowlist: state.settings.privacy.adBlockAllowlist.filter((entry) => entry !== hostname && entry !== origin),
          cookieExceptions: state.settings.privacy.cookieExceptions.filter((entry) => entry !== hostname && entry !== origin),
          clearSiteDataOnClose: state.settings.privacy.clearSiteDataOnClose.filter((entry) => entry !== hostname && entry !== origin)
        },
        security: {
          ...state.settings.security,
          sitePermissions: state.settings.security.sitePermissions.filter((permission) => permission.origin !== origin)
        }
      }
    }))
  },

  updateSettings: (patch) => {
    set((state) => {
      const keyboardShortcuts: Record<string, string> = { ...state.settings.keyboardShortcuts }
      for (const [key, value] of Object.entries(patch.keyboardShortcuts ?? {})) {
        if (value) keyboardShortcuts[key] = value
      }
      const privacy = {
        ...state.settings.privacy,
        ...patch.privacy
      }
      const spoofing = {
        ...state.settings.spoofing,
        ...patch.spoofing,
        location: {
          ...state.settings.spoofing.location,
          ...patch.spoofing?.location
        }
      }
      const appearance = {
        ...state.settings.appearance,
        ...patch.appearance
      }
      const advanced = {
        ...state.settings.advanced,
        ...patch.advanced
      }
      const requestedLayoutMode = patch.layoutMode ?? state.settings.layoutMode
      const layoutMode = resolveLayoutMode(requestedLayoutMode, advanced.experimentalFeatures)
      const security = {
        ...state.settings.security,
        ...patch.security
      }
      const network = {
        ...state.settings.network,
        ...patch.network
      }
      const labs = {
        ...state.settings.labs,
        ...patch.labs
      }
      const newTab = {
        ...state.settings.newTab,
        ...patch.newTab
      }
      const sidePanel = {
        ...state.settings.sidePanel,
        ...patch.sidePanel
      }
      const commandPalette = {
        ...state.settings.commandPalette,
        ...patch.commandPalette
      }
      const fakeHistoryActivated = patch.privacy?.fakeHistoryEnabled === true && !state.settings.privacy.fakeHistoryEnabled
      return {
        settings: {
          ...state.settings,
          ...patch,
          layoutMode,
          appearance,
          advanced,
          privacy,
          spoofing,
          security,
          network,
          labs,
          newTab,
          sidePanel,
          commandPalette,
          keyboardShortcuts
        },
        history: fakeHistoryActivated ? fakeHistoryBatch(state.activeWorkspaceId) : state.history
      }
    })
  },

  updateDownload: (item) => {
    set((state) => ({
      downloads: [item, ...state.downloads.filter((download) => download.id !== item.id)].slice(0, 200)
    }))
  },

  setQuickLinks: (links) => set({ quickLinks: links }),

  addQuickLink: (link) => {
    const next: QuickLink = {
      id: createId('quick'),
      title: link.title.trim() || titleFromUrl(link.url),
      url: link.url,
      color: link.color || get().settings.accentColor
    }
    set((state) => ({ quickLinks: [...state.quickLinks, next].slice(0, 12) }))
    return next
  },

  updateQuickLink: (linkId, patch) => {
    set((state) => ({
      quickLinks: state.quickLinks.map((link) =>
        link.id === linkId
          ? {
              ...link,
              ...patch,
              title: patch.title?.trim() || link.title,
              url: patch.url?.trim() || link.url
            }
          : link
      )
    }))
  },

  removeQuickLink: (linkId) => {
    set((state) => ({ quickLinks: state.quickLinks.filter((link) => link.id !== linkId) }))
  },

  clearCompletedDownloads: () => {
    set((state) => ({ downloads: state.downloads.filter((item) => item.state !== 'completed' && item.state !== 'cancelled') }))
  },

  moveQuickLink: (sourceId, targetId) => {
    if (sourceId === targetId) return
    set((state) => {
      const sourceIndex = state.quickLinks.findIndex((link) => link.id === sourceId)
      const targetIndex = state.quickLinks.findIndex((link) => link.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return state
      const quickLinks = [...state.quickLinks]
      const [source] = quickLinks.splice(sourceIndex, 1)
      quickLinks.splice(targetIndex, 0, source)
      return { quickLinks }
    })
  },

  addTodo: (title, workspaceId) => {
    const now = Date.now()
    const todo: TodoItem = {
      id: createId('todo'),
      workspaceId,
      title: title.trim(),
      completed: false,
      createdAt: now,
      updatedAt: now
    }
    if (!todo.title) return todo
    set((state) => ({ todos: [todo, ...state.todos].slice(0, 200) }))
    return todo
  },

  updateTodo: (todoId, patch) => {
    set((state) => ({
      todos: state.todos.map((todo) => (todo.id === todoId ? { ...todo, ...patch, updatedAt: Date.now() } : todo))
    }))
  },

  removeTodo: (todoId) => {
    set((state) => ({ todos: state.todos.filter((todo) => todo.id !== todoId) }))
  },

  recordCommand: (commandId) => {
    set((state) => ({
      recentCommandIds: [commandId, ...state.recentCommandIds.filter((id) => id !== commandId)].slice(0, 12)
    }))
  }
}))

export const selectActiveWorkspace = (state: BrowserState): Workspace | undefined =>
  state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)

export const selectActiveTab = (state: BrowserState): Tab | undefined => {
  const workspace = selectActiveWorkspace(state)
  return state.tabs.find((tab) => tab.id === workspace?.activeTabId)
}

export const selectWorkspaceTabs = (workspaceId: ID) => (state: BrowserState): Tab[] =>
  state.tabs.filter((tab) => tab.workspaceId === workspaceId)
