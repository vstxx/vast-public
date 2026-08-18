import {
  CircleAlert,
  ChevronDown,
  Folder,
  LoaderCircle,
  MoreHorizontal,
  Moon,
  Pin,
  Plus,
  Search,
  Trash2,
  Volume2,
  X
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { calculateVisibleBookmarkCount } from '../../../shared/bookmarks-bar-layout'
import { INTERNAL_NEW_TAB_URL } from '../../../shared/constants'
import type { Bookmark as BookmarkModel, BookmarkFolder, Tab, TabGroup, Workspace } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { openTabContextMenu } from '../../lib/context-menu'
import { displayUrl, isPdfViewerUrl } from '../../lib/url'
import { useTabMotion } from '../../lib/tab-motion'
import { selectActiveTab, selectActiveWorkspace, useBrowserStore } from '../../store/browser-store'
import { AddressBar } from '../browser/AddressBar'
import { Favicon, getInternalTabMeta } from '../ui/Favicon'
import { IconButton } from '../ui/IconButton'
import { notifyCatNewTabButton, notifyCatTabClosing } from '../../lib/cat-addon-events'
import { WorkspaceIcon } from '../workspaces/WorkspaceIcon'
import { WindowControls } from '../window/WindowControls'

const TAB_TEAR_OUT_MARGIN = 18
type ChromeVariant = 'horizontal' | 'purist'

function shouldDetachHorizontalTab(event: DragEvent<HTMLElement>, strip: HTMLElement | null): boolean {
  const { clientX, clientY } = event
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
  if (clientX <= 0 || clientY <= 0 || clientX >= window.innerWidth - 1 || clientY >= window.innerHeight - 1) {
    return true
  }
  if (!strip) return false
  const rect = strip.getBoundingClientRect()
  return (
    clientX < rect.left - TAB_TEAR_OUT_MARGIN ||
    clientX > rect.right + TAB_TEAR_OUT_MARGIN ||
    clientY < rect.top - TAB_TEAR_OUT_MARGIN ||
    clientY > rect.bottom + TAB_TEAR_OUT_MARGIN
  )
}

export function HorizontalChrome(): JSX.Element {
  const workspace = useBrowserStore(selectActiveWorkspace)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)

  return (
    <header className="horizontal-chrome drag relative z-30 shrink-0 border-b border-white/[0.08] bg-[#07080b]/[0.92] text-white backdrop-blur-2xl">
      <div className="horizontal-titlebar-row flex h-10 min-w-0 items-center gap-2 px-3">
        <WorkspacePopover
          workspace={workspace}
          open={workspaceOpen}
          onToggle={() => setWorkspaceOpen((value) => !value)}
          onClose={() => setWorkspaceOpen(false)}
        />

        <HorizontalTabBar />
        <WindowControls />
      </div>
      <AddressBar compact />
      <BookmarksBar />
    </header>
  )
}

export function WorkspacePopover({
  workspace,
  open,
  onToggle,
  onClose,
  variant = 'horizontal'
}: {
  workspace?: Workspace
  open: boolean
  onToggle: () => void
  onClose: () => void
  variant?: ChromeVariant
}): JSX.Element {
  const workspaces = useBrowserStore((state) => state.workspaces)
  const setActiveWorkspace = useBrowserStore((state) => state.setActiveWorkspace)
  const createWorkspace = useBrowserStore((state) => state.createWorkspace)
  const deleteWorkspace = useBrowserStore((state) => state.deleteWorkspace)
  const accentColor = useBrowserStore((state) => state.settings.accentColor)
  const privateWorkspaceDefault = useBrowserStore((state) => state.settings.privacy.privateWorkspaceDefault)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)

  const purist = variant === 'purist'

  return (
    <div className={`no-drag relative h-10 w-fit shrink-0 ${purist ? 'purist-workspace-popover' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={`Switch workspace. Current: ${workspace?.name ?? 'Workspace'}`}
        className={purist
          ? 'purist-workspace-button mt-1 grid h-8 w-8 place-items-center rounded-full text-vast-soft transition'
          : 'mt-2 flex h-8 max-w-52 items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.055] pl-2 pr-2.5 text-xs font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] transition hover:border-white/[0.16] hover:bg-white/[0.085]'}
        title="Switch workspace"
      >
        <span className={`flex min-w-0 items-center ${purist ? 'justify-center' : 'flex-1 gap-2'}`}>
          <span
            className={`grid h-5 w-5 shrink-0 place-items-center ${purist ? 'rounded-full' : 'rounded-md'}`}
            style={{ backgroundColor: `${workspace?.color ?? '#74e7ff'}22`, color: workspace?.color ?? '#74e7ff' }}
          >
            <WorkspaceIcon name={workspace?.icon ?? 'Sparkles'} className="h-3 w-3" />
          </span>
          {!purist && <span className="min-w-0 truncate leading-none">{workspace?.name ?? 'Workspace'}</span>}
          {!purist && workspace?.isPrivate && (
            <span className="shrink-0 rounded-md border border-vast-cyan/25 bg-vast-cyan/10 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-vast-cyan">
              Isolated
            </span>
          )}
        </span>
        {!purist && <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-vast-soft transition ${open ? 'rotate-180' : ''}`} />}
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-50 w-80 overflow-hidden rounded-2xl border border-white/10 bg-[#090a0d]/[0.98] p-2 shadow-glass backdrop-blur-2xl" data-testid="workspace-popover">
          <div className="px-3 pb-3 pt-2">
            <h2 className="text-2xl font-semibold leading-tight tracking-tight text-white" data-testid="workspace-popover-heading">Workspaces</h2>
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {workspaces
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((item) => (
                <div
                  key={item.id}
                  className={`group/workspace flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition ${
                    item.id === workspace?.id
                      ? 'bg-white/[0.11] text-white'
                      : 'text-vast-soft hover:bg-white/[0.07] hover:text-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveWorkspace(item.id)
                      onClose()
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-1 py-0.5 text-left"
                  >
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-xl"
                      style={{ backgroundColor: `${item.color}22`, color: item.color }}
                    >
                      <WorkspaceIcon name={item.icon} className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                    {item.isPrivate && <span className="text-[11px] text-vast-cyan">Isolated</span>}
                  </button>
                  <button
                    type="button"
                    title="Delete workspace"
                    disabled={workspaces.length <= 1}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (workspaces.length <= 1) return
                      openPromptDialog({
                        title: `Delete "${item.name}" workspace?`,
                        description: 'Tabs, groups, notes, and reading-list items in this workspace will be removed.',
                        label: '', hideInput: true, allowEmpty: true, confirmLabel: 'Delete workspace',
                        onConfirm: () => deleteWorkspace(item.id)
                      })
                    }}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-vast-soft opacity-0 transition hover:bg-red-400/10 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-20 group-hover/workspace:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onClose()
              openPromptDialog({
                title: 'New workspace',
                label: 'Workspace name',
                placeholder: 'Research, Travel, Side project',
                confirmLabel: 'Create workspace',
                onConfirm: (name) => createWorkspace(name, accentColor, privateWorkspaceDefault)
              })
            }}
            className="mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.12] text-sm font-medium text-vast-soft hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
          >
            <Plus className="h-4 w-4" />
            New workspace
          </button>
        </div>
      )}
    </div>
  )
}

function HorizontalTabBar(): JSX.Element {
  const workspace = useBrowserStore(selectActiveWorkspace)
  const tabs = useBrowserStore((state) => state.tabs)
  const groups = useBrowserStore((state) => state.tabGroups)
  const activateTab = useBrowserStore((state) => state.activateTab)
  const closeTab = useBrowserStore((state) => state.closeTab)
  const createTab = useBrowserStore((state) => state.createTab)
  const moveTab = useBrowserStore((state) => state.moveTab)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [overflowQuery, setOverflowQuery] = useState('')
  const [dragTargetId, setDragTargetId] = useState<string | null>(null)
  const [stripWidth, setStripWidth] = useState(900)
  const stripRef = useRef<HTMLDivElement | null>(null)

  const workspaceGroups = useMemo(
    () => groups.filter((group) => group.workspaceId === workspace?.id).sort((a, b) => a.order - b.order),
    [groups, workspace?.id]
  )

  const workspaceTabs = useMemo(() => {
    const scoped = tabs.filter((tab) => tab.workspaceId === workspace?.id)
    return [...scoped.filter((tab) => tab.pinned), ...scoped.filter((tab) => !tab.pinned)]
  }, [tabs, workspace?.id])

  useEffect(() => {
    const node = stripRef.current
    if (!node) return
    const update = (): void => {
      const width = node.getBoundingClientRect().width
      setStripWidth(width)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [workspaceTabs.length])

  const tabCount = Math.max(workspaceTabs.length, 1)
  const minimumTabWidth = 108
  const maximumTabWidth = 188
  const newTabButtonWidth = 42
  const visibleCapacity = Math.max(1, Math.min(workspaceTabs.length || 1, Math.floor((stripWidth - newTabButtonWidth) / minimumTabWidth)))
  const visibleTabs = workspaceTabs.slice(0, visibleCapacity)
  const overflowTabs = workspaceTabs.slice(visibleCapacity)
  const visiblePinnedCount = visibleTabs.filter((tab) => tab.pinned).length
  const overflowButtonWidth = overflowTabs.length > 0 ? 48 : 0
  const availableForTabs = Math.max(minimumTabWidth, stripWidth - newTabButtonWidth - overflowButtonWidth - 10)
  const tabWidth = Math.floor(Math.min(maximumTabWidth, Math.max(minimumTabWidth, availableForTabs / Math.max(visibleTabs.length, 1) - 4)))

  const onDrop = (event: DragEvent<HTMLButtonElement>, targetId: string): void => {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain')
    if (draggedId) moveTab(draggedId, targetId)
    setDragTargetId(null)
  }

  const onTabDragEnd = (event: DragEvent<HTMLButtonElement>, tab: Tab): void => {
    if (!shouldDetachHorizontalTab(event, stripRef.current)) return
    event.preventDefault()
    const payload = {
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      muted: tab.muted,
      zoom: tab.zoom,
      sourceTabId: tab.id,
      sourceWorkspaceId: tab.workspaceId,
      sourceGroupId: tab.groupId
    }
    if (new URLSearchParams(window.location.search).has('vastDetachedTab')) {
      void window.vast.browser.reattachDetachedTab(payload).then((result) => {
        if (!result.ok) console.warn('[tabs] Failed to reattach detached tab:', result.error)
      })
      return
    }
    void window.vast.browser.detachTab(payload).then((result) => {
      if (result.ok) closeTab(tab.id)
      else console.warn('[tabs] Failed to detach tab:', result.error)
    })
  }

  const renderTab = (tab: Tab): JSX.Element => (
    <HorizontalTab
      key={tab.id}
      tab={tab}
      active={tab.id === workspace?.activeTabId}
      onActivate={() => activateTab(tab.id)}
      onClose={() => { notifyCatTabClosing(); closeTab(tab.id) }}
      onDrop={(event) => onDrop(event, tab.id)}
      onDragEnd={(event) => onTabDragEnd(event, tab)}
      onDragTarget={() => setDragTargetId(tab.id)}
      onDragExit={() => setDragTargetId(null)}
      dragTarget={dragTargetId === tab.id}
      group={workspaceGroups.find((group) => group.id === tab.groupId)}
      width={tabWidth}
    />
  )

  const normalizedOverflowQuery = overflowQuery.trim().toLowerCase()
  const searchableTabs = workspaceTabs.filter((tab) => {
    if (!normalizedOverflowQuery) return true
    return `${tab.title} ${tab.url}`.toLowerCase().includes(normalizedOverflowQuery)
  })

  return (
    <div className="drag flex min-w-0 flex-1 items-center gap-1">
      <div ref={stripRef} className="horizontal-tab-strip drag flex min-w-0 flex-1 items-center gap-1 overflow-hidden py-1">
        {visibleTabs.map((tab, index) => (
          <div key={tab.id} className="contents">
            {index === visiblePinnedCount && visiblePinnedCount > 0 && (
              <span aria-hidden="true" className="mx-0.5 h-5 w-px shrink-0 bg-white/[0.13]" />
            )}
            {renderTab(tab)}
          </div>
        ))}
        <button
          type="button"
          title="New tab"
          onClick={() => { notifyCatNewTabButton(); createTab({ workspaceId: workspace?.id, activate: true }) }}
          className="no-drag mt-[3px] grid h-8 w-8 shrink-0 place-items-center self-center rounded-full bg-transparent text-vast-soft/75 transition hover:bg-white/[0.045] hover:text-white/90"
        >
          <Plus className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      {overflowTabs.length > 0 && (
        <div className="no-drag relative shrink-0">
          <button
            type="button"
            onClick={() => setOverflowOpen((value) => !value)}
            className="flex h-8 items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.045] px-2 text-xs text-vast-soft hover:border-white/[0.14] hover:bg-white/[0.08] hover:text-white"
            title="Tab overflow"
          >
            <MoreHorizontal className="h-4 w-4" />
            {overflowTabs.length}
          </button>
          {overflowOpen && (
            <div className="absolute right-0 top-10 z-50 w-80 rounded-2xl border border-white/10 bg-[#090a0d]/[0.98] p-2 shadow-glass backdrop-blur-2xl">
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-[13px] font-semibold text-white">Tabs in {workspace?.name ?? 'workspace'}</span>
                <span className="text-[13px] text-vast-soft">{workspaceTabs.length}</span>
              </div>
              <label className="relative mb-2 block">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
                <input
                  autoFocus
                  value={overflowQuery}
                  onChange={(event) => setOverflowQuery(event.target.value)}
                  placeholder="Search title or address"
                  className="vast-control h-10 w-full pl-9 pr-3"
                />
              </label>
              <div className="max-h-[min(60vh,440px)] overflow-y-auto">
              {searchableTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    activateTab(tab.id)
                    setOverflowOpen(false)
                  }}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-vast-soft hover:bg-white/[0.07] hover:text-white"
                >
                  <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-white">{tab.title}</span>
                    <span className="block truncate text-[13px] text-vast-soft">{tabDisplayHost(tab.url)}</span>
                  </span>
                  {tab.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-vast-cyan" aria-label="Pinned" />}
                </button>
              ))}
              {searchableTabs.length === 0 && (
                <div className="px-3 py-8 text-center text-[13px] text-vast-soft">No tabs match this search.</div>
              )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HorizontalTabComponent({
  tab,
  active,
  onActivate,
  onClose,
  onDrop,
  onDragEnd,
  onDragTarget,
  onDragExit,
  dragTarget,
  group,
  width
}: {
  tab: Tab
  active: boolean
  onActivate: () => void
  onClose: () => void
  onDrop: (event: DragEvent<HTMLButtonElement>) => void
  onDragEnd: (event: DragEvent<HTMLButtonElement>) => void
  onDragTarget: () => void
  onDragExit: () => void
  dragTarget: boolean
  group?: TabGroup
  width: number
}): JSX.Element {
  const motionRef = useTabMotion(tab.id)
  const showGroupLabel = group && group.name.toLowerCase() !== 'today'
  const isPlainNewTab = tab.url === INTERNAL_NEW_TAB_URL
  const internalMeta = isPlainNewTab ? null : getInternalTabMeta(tab.url)
  const tabTone = internalMeta
    ? active
      ? internalMeta.activeTabClassName
      : internalMeta.tabClassName
    : active
      ? 'bg-white/[0.08] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_28px_rgba(0,0,0,0.16)]'
      : 'border-white/[0.035] bg-white/[0.022] text-vast-soft hover:border-white/10 hover:bg-white/[0.06] hover:text-white'

  return (
    <button
      ref={motionRef}
      data-tab-motion-id={tab.id}
      type="button"
      draggable
      title={`${tab.title}\n${tabDisplayHost(tab.url)}\n${tab.pinned ? 'Pinned · ' : ''}${tab.lifecycle}`}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', tab.id)
      }}
      onDragEnd={(event) => {
        onDragEnd(event)
        onDragExit()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        onDragTarget()
      }}
      onDragLeave={onDragExit}
      onDrop={onDrop}
      onContextMenu={(event) => {
        event.preventDefault()
        openTabContextMenu(tab, event.clientX, event.clientY)
      }}
      onClick={onActivate}
      style={{ width }}
      className="no-drag group relative h-10 min-w-0 shrink-0 text-left"
    >
      <div
        className={`absolute inset-x-0 bottom-0 flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-xl border px-2 transition duration-150 ${tabTone} ${active ? 'vast-tab-active' : ''} ${dragTarget ? 'ring-2 ring-vast-cyan/70 ring-offset-1 ring-offset-transparent' : ''}`}
      >
        {isPlainNewTab ? (
          <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-white/10 text-[9px] font-semibold text-white/70">
            N
          </span>
        ) : (
          <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
        )}
        <span className={`min-w-0 flex-1 truncate text-xs font-medium ${internalMeta ? internalMeta.labelClassName : ''}`}>{tab.title}</span>
        {tab.status === 'loading' && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-vast-cyan" aria-label="Loading" />}
        {tab.status === 'error' && <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-300" aria-label="Load failed" />}
        {tab.muted && <Volume2 className="h-3.5 w-3.5 shrink-0 text-vast-soft" aria-label="Muted" />}
        {tab.lifecycle === 'sleeping' && <Moon className="h-3.5 w-3.5 shrink-0 text-vast-soft" aria-label="Sleeping" />}
        {showGroupLabel && (
          <span
            className="hidden max-w-16 items-center rounded-full border border-white/[0.06] bg-white/[0.035] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-vast-soft xl:flex"
            title={group.name}
          >
            <span className="truncate">{group.name}</span>
          </span>
        )}
        <span
          role="button"
          tabIndex={0}
          title="Close tab"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-white/[0.45] transition hover:bg-white/10 hover:text-white group-hover:opacity-100 group-focus-within:opacity-100 ${active ? 'opacity-100' : 'opacity-0'}`}
        >
          <X className="h-3.5 w-3.5" />
        </span>
      </div>
    </button>
  )
}

const HorizontalTab = memo(HorizontalTabComponent, (previous, next) =>
  previous.tab === next.tab &&
  previous.active === next.active &&
  previous.group === next.group &&
  previous.dragTarget === next.dragTarget &&
  previous.width === next.width
)

function tabDisplayHost(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : parsed.protocol.replace(':', '')
  } catch {
    return url
  }
}

function bookmarkBarItemKey(item: { type: 'folder'; folder: BookmarkFolder } | { type: 'bookmark'; bookmark: BookmarkModel }): string {
  return item.type === 'folder' ? `folder:${item.folder.id}` : `bookmark:${item.bookmark.id}`
}

export function BookmarksBar({ variant = 'horizontal' }: { variant?: ChromeVariant }): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const visible = useBrowserStore((state) => state.settings.bookmarksBarVisible)
  const onlyOnNewTab = useBrowserStore((state) => state.settings.bookmarksBarOnlyOnNewTab)
  const activeTabUrl = useBrowserStore((state) => selectActiveTab(state)?.url ?? '')
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const folders = useBrowserStore((state) => state.bookmarkFolders)
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const itemWidthCacheRef = useRef(new Map<string, number>())
  const replacedNewTabRef = useRef(false)
  const [visibleCount, setVisibleCount] = useState(Infinity)
  const openBookmark = (url: string): void => {
    if (activeTabUrl === INTERNAL_NEW_TAB_URL && !replacedNewTabRef.current) {
      replacedNewTabRef.current = true
      runtime.navigateActive(url)
    }
    else runtime.openUrlInNewTab(url)
  }

  useEffect(() => {
    replacedNewTabRef.current = false
  }, [activeTabUrl])

  const rootBookmarks = bookmarks.filter((bookmark) => !bookmark.folderId)
  const orderedItems: Array<{ type: 'folder'; folder: BookmarkFolder } | { type: 'bookmark'; bookmark: BookmarkModel }> = [
    ...folders.map((folder) => ({ type: 'folder' as const, folder })),
    ...rootBookmarks.map((bookmark) => ({ type: 'bookmark' as const, bookmark }))
  ]
  const orderedItemKeys = orderedItems.map(bookmarkBarItemKey)
  const orderedItemSignature = orderedItems
    .map((item) => (item.type === 'folder' ? `folder:${item.folder.id}:${item.folder.name}` : `bookmark:${item.bookmark.id}:${item.bookmark.title}:${item.bookmark.url}`))
    .join('|')

  useLayoutEffect(() => {
    itemWidthCacheRef.current.clear()
    setVisibleCount(Infinity)
  }, [orderedItemSignature])

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!visible || onlyOnNewTab && activeTabUrl !== INTERNAL_NEW_TAB_URL || isPdfViewerUrl(activeTabUrl)) {
      setVisibleCount(Infinity)
      return
    }
    if (!bar) return

    const compute = (): void => {
      const barWidth = bar.clientWidth
      const items = Array.from(bar.querySelectorAll<HTMLElement>('[data-bookmark-item]'))
      for (const item of items) {
        const key = item.dataset.bookmarkKey
        if (key && item.offsetWidth > 0) {
          itemWidthCacheRef.current.set(key, item.offsetWidth)
        }
      }
      const itemWidths = orderedItemKeys.map((key) => itemWidthCacheRef.current.get(key) ?? 0)
      const nextVisibleCount = calculateVisibleBookmarkCount({ barWidth, itemWidths })
      if (nextVisibleCount === null) {
        return
      }
      if (nextVisibleCount === 0 && orderedItemKeys.length === 0) {
        setVisibleCount(Infinity)
        return
      }
      setVisibleCount(nextVisibleCount)
    }

    const ro = new ResizeObserver(compute)
    ro.observe(bar)
    compute()
    const frame = window.requestAnimationFrame(compute)
    return () => {
      window.cancelAnimationFrame(frame)
      ro.disconnect()
    }
  // Re-run when item count changes so newly added items are measured correctly.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedItems.length, visible, onlyOnNewTab, activeTabUrl])

  if (!visible || onlyOnNewTab && activeTabUrl !== INTERNAL_NEW_TAB_URL || isPdfViewerUrl(activeTabUrl)) return null

  const visCount = visibleCount === Infinity ? orderedItems.length : visibleCount
  const visibleItems = orderedItems.slice(0, visCount)
  const overflowItems = orderedItems.slice(visCount)

  if (variant === 'purist' && orderedItems.length === 0) return null

  return (
    <div
      ref={barRef}
      className={`horizontal-bookmarks-bar no-drag flex h-9 items-center gap-1 text-xs text-vast-soft ${variant === 'purist' ? 'purist-bookmarks-bar' : 'px-3'}`}
    >
      {visibleItems.map((item) =>
        item.type === 'folder' ? (
          <FolderButton
            key={item.folder.id}
            itemKey={bookmarkBarItemKey(item)}
            folder={item.folder}
            open={openMenuId === item.folder.id}
            onToggle={() => setOpenMenuId((id) => (id === item.folder.id ? null : item.folder.id))}
            onOpen={(url) => {
              openBookmark(url)
              setOpenMenuId(null)
            }}
          />
        ) : (
          <BookmarkButton
            key={item.bookmark.id}
            itemKey={bookmarkBarItemKey(item)}
            bookmark={item.bookmark}
            onOpen={openBookmark}
          />
        )
      )}

      {overflowItems.length > 0 && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenMenuId((id) => (id === 'bookmark-overflow' ? null : 'bookmark-overflow'))}
            className="chrome-bookmark-overflow flex h-7 items-center gap-1 rounded-lg px-2 hover:bg-white/[0.07] hover:text-white"
            title="More bookmarks"
          >
            <MoreHorizontal className="h-4 w-4" />
            {variant !== 'purist' && 'More'}
          </button>
          {openMenuId === 'bookmark-overflow' && (
            <BookmarkOverflowMenu
              items={overflowItems}
              allBookmarks={bookmarks}
              onOpen={(url) => {
                openBookmark(url)
                setOpenMenuId(null)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

function BookmarkButton({ itemKey, bookmark, onOpen }: { itemKey: string; bookmark: BookmarkModel; onOpen: (url: string) => void }): JSX.Element {
  const openBookmarkContextMenu = useBookmarkContextMenu(bookmark, onOpen)

  return (
    <button
      type="button"
      data-bookmark-item
      data-bookmark-key={itemKey}
      onClick={() => onOpen(bookmark.url)}
      onContextMenu={openBookmarkContextMenu}
      className={`chrome-bookmark-item flex h-7 items-center rounded-lg px-2 hover:bg-white/[0.07] hover:text-white${bookmark.title ? ' max-w-40 gap-2' : ''}`}
      title={bookmark.url}
    >
      <Favicon url={bookmark.url} favicon={bookmark.favicon} title={bookmark.title} />
      {bookmark.title && <span className="truncate">{bookmark.title}</span>}
    </button>
  )
}

function FolderButton({
  itemKey,
  folder,
  open,
  onToggle,
  onOpen
}: {
  itemKey: string
  folder: BookmarkFolder
  open: boolean
  onToggle: () => void
  onOpen: (url: string) => void
}): JSX.Element {
  const allBookmarks = useBrowserStore((state) => state.bookmarks)
  const bookmarks = useMemo(() => allBookmarks.filter((bookmark) => bookmark.folderId === folder.id), [allBookmarks, folder.id])
  const openFolderContextMenu = useBookmarkFolderContextMenu(folder, bookmarks, onOpen)

  return (
    <div className="relative" data-bookmark-item data-bookmark-key={itemKey}>
      <button
        type="button"
        onClick={onToggle}
        onContextMenu={openFolderContextMenu}
        className="chrome-bookmark-folder flex h-7 max-w-44 items-center gap-2 rounded-lg px-2 hover:bg-white/[0.07] hover:text-white"
      >
        <Folder className="h-3.5 w-3.5 text-vast-cyan" />
        <span className="truncate">{folder.name}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && <BookmarkMenu bookmarks={bookmarks} onOpen={onOpen} />}
    </div>
  )
}

function BookmarkOverflowMenu({
  items,
  allBookmarks,
  onOpen
}: {
  items: Array<{ type: 'folder'; folder: BookmarkFolder } | { type: 'bookmark'; bookmark: BookmarkModel }>
  allBookmarks: BookmarkModel[]
  onOpen: (url: string) => void
}): JSX.Element {
  return (
    <div className="absolute left-0 top-9 z-50 w-80 rounded-2xl border border-white/10 bg-[#090a0d]/[0.98] p-2 shadow-glass backdrop-blur-2xl">
      {items.map((item) => {
        if (item.type === 'bookmark') {
          return <BookmarkMenuItem key={item.bookmark.id} bookmark={item.bookmark} onOpen={onOpen} />
        }
        const folderBookmarks = allBookmarks.filter((bookmark) => bookmark.folderId === item.folder.id)
        return (
          <div key={item.folder.id} className="rounded-xl px-2 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft">
              <Folder className="h-3.5 w-3.5 text-vast-cyan" />
              {item.folder.name}
            </div>
            {folderBookmarks.length === 0 ? (
              <div className="px-2 py-1 text-xs text-vast-soft">No bookmarks</div>
            ) : (
              folderBookmarks.map((bookmark) => <BookmarkMenuItem key={bookmark.id} bookmark={bookmark} onOpen={onOpen} compact />)
            )}
          </div>
        )
      })}
    </div>
  )
}

function BookmarkMenu({
  bookmarks,
  onOpen
}: {
  bookmarks: BookmarkModel[]
  onOpen: (url: string) => void
}): JSX.Element {
  return (
    <div className="absolute left-0 top-9 z-50 w-72 rounded-2xl border border-white/10 bg-[#090a0d]/[0.98] p-2 shadow-glass backdrop-blur-2xl">
      {bookmarks.length === 0 && <div className="px-3 py-3 text-sm text-vast-soft">No bookmarks in this folder.</div>}
      {bookmarks.map((bookmark) => (
        <BookmarkMenuItem key={bookmark.id} bookmark={bookmark} onOpen={onOpen} />
      ))}
    </div>
  )
}

function BookmarkMenuItem({
  bookmark,
  onOpen,
  compact = false
}: {
  bookmark: BookmarkModel
  onOpen: (url: string) => void
  compact?: boolean
}): JSX.Element {
  const openBookmarkContextMenu = useBookmarkContextMenu(bookmark, onOpen)

  return (
    <button
      type="button"
      onClick={() => onOpen(bookmark.url)}
      onContextMenu={openBookmarkContextMenu}
      className={`flex w-full items-center gap-3 rounded-xl text-left hover:bg-white/[0.07] ${
        compact ? 'px-2 py-1.5' : 'px-3 py-2'
      }`}
    >
      <Favicon url={bookmark.url} favicon={bookmark.favicon} title={bookmark.title} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">{bookmark.title}</div>
        <div className="truncate text-xs text-vast-soft">{displayUrl(bookmark.url)}</div>
      </div>
    </button>
  )
}

function useBookmarkContextMenu(bookmark: BookmarkModel, onOpen: (url: string) => void): (event: MouseEvent<HTMLElement>) => void {
  const openContextMenu = useBrowserStore((state) => state.openContextMenu)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const folders = useBrowserStore((state) => state.bookmarkFolders)
  const createBookmarkFolder = useBrowserStore((state) => state.createBookmarkFolder)
  const updateBookmark = useBrowserStore((state) => state.updateBookmark)
  const removeBookmark = useBrowserStore((state) => state.removeBookmark)

  return (event) => {
    event.preventDefault()
    event.stopPropagation()
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: bookmark.title,
      items: [
        {
          id: 'open',
          label: 'Open bookmark',
          action: () => onOpen(bookmark.url)
        },
        {
          id: 'copy-url',
          label: 'Copy URL',
          action: () => navigator.clipboard.writeText(bookmark.url)
        },
        { id: 'separator-1', label: '', separator: true },
        {
          id: 'edit-title',
          label: 'Edit title',
          action: () =>
            openPromptDialog({
              title: 'Edit bookmark title',
              label: 'Title',
              placeholder: bookmark.title,
              defaultValue: bookmark.title,
              confirmLabel: 'Save title',
              allowEmpty: true,
              onConfirm: (title) => updateBookmark(bookmark.id, { title })
            })
        },
        {
          id: 'edit-url',
          label: 'Edit URL',
          action: () =>
            openPromptDialog({
              title: 'Edit bookmark URL',
              label: 'URL',
              placeholder: bookmark.url,
              confirmLabel: 'Save URL',
              onConfirm: (url) => updateBookmark(bookmark.id, { url })
            })
        },
        {
          id: 'move-folder',
          label: 'Move to folder',
          detail: bookmark.folderId ? folders.find((folder) => folder.id === bookmark.folderId)?.name : 'Currently in bookmarks bar',
          action: () =>
            openPromptDialog({
              title: 'Move bookmark',
              label: 'Folder name',
              placeholder: 'Leave blank for bookmarks bar',
              confirmLabel: 'Move bookmark',
              onConfirm: (folderName) => {
                const name = folderName.trim()
                if (!name) {
                  updateBookmark(bookmark.id, { folderId: undefined })
                  return
                }
                const existing = folders.find((folder) => folder.name.toLowerCase() === name.toLowerCase())
                const folder = existing ?? createBookmarkFolder(name)
                updateBookmark(bookmark.id, { folderId: folder.id })
              }
            })
        },
        { id: 'separator-2', label: '', separator: true },
        {
          id: 'remove',
          label: 'Remove bookmark',
          danger: true,
          action: () => removeBookmark(bookmark.id)
        }
      ]
    })
  }
}

function useBookmarkFolderContextMenu(
  folder: BookmarkFolder,
  bookmarks: BookmarkModel[],
  onOpen: (url: string) => void
): (event: MouseEvent<HTMLElement>) => void {
  const openContextMenu = useBrowserStore((state) => state.openContextMenu)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const updateBookmarkFolder = useBrowserStore((state) => state.updateBookmarkFolder)
  const deleteBookmarkFolder = useBrowserStore((state) => state.deleteBookmarkFolder)

  return (event) => {
    event.preventDefault()
    event.stopPropagation()
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: folder.name,
      items: [
        {
          id: 'open-all',
          label: 'Open all bookmarks',
          disabled: bookmarks.length === 0,
          action: () => {
            for (const bookmark of bookmarks) onOpen(bookmark.url)
          }
        },
        {
          id: 'rename',
          label: 'Rename folder',
          action: () =>
            openPromptDialog({
              title: 'Rename bookmark folder',
              label: 'Folder name',
              placeholder: folder.name,
              confirmLabel: 'Rename folder',
              onConfirm: (name) => updateBookmarkFolder(folder.id, { name })
            })
        },
        { id: 'separator', label: '', separator: true },
        {
          id: 'delete',
          label: 'Delete folder',
          detail: 'Bookmarks move back to the bookmarks bar.',
          danger: true,
          action: () => deleteBookmarkFolder(folder.id)
        }
      ]
    })
  }
}
