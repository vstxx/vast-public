import { CircleAlert, LoaderCircle, LockKeyhole, Moon, Plus, Volume2, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type WheelEvent } from 'react'
import type { Tab, TabGroup } from '../../../shared/types'
import { selectActiveTab, selectActiveWorkspace, useBrowserStore } from '../../store/browser-store'
import { notifyCatNewTabButton, notifyCatTabClosing } from '../../lib/cat-addon-events'
import { openTabContextMenu } from '../../lib/context-menu'
import { useTabMotion } from '../../lib/tab-motion'
import { getEffectiveTabUrl, isSecureUrl } from '../../lib/url'
import { AddressBar } from '../browser/AddressBar'
import { BookmarksBar, WorkspacePopover } from '../horizontal/HorizontalChrome'
import { Favicon } from '../ui/Favicon'
import { WindowControls } from '../window/WindowControls'
import './purist.css'

const TAB_TEAR_OUT_MARGIN = 18
const ISLAND_COLLAPSE_DELAY = 850
const ISLAND_ACTIVITY_COLLAPSE_DELAY = 1_200

function shouldDetachPuristTab(event: DragEvent<HTMLElement>, strip: HTMLElement | null): boolean {
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

export function PuristChrome(): JSX.Element {
  const workspace = useBrowserStore(selectActiveWorkspace)
  const activeTab = useBrowserStore(selectActiveTab)
  const [workspaceOpen, setWorkspaceOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const islandRef = useRef<HTMLDivElement | null>(null)
  const collapseTimerRef = useRef<number | undefined>(undefined)
  const previousActiveTabIdRef = useRef(activeTab?.id)

  const clearCollapseTimer = useCallback((): void => {
    window.clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = undefined
  }, [])

  const expandIsland = useCallback((): void => {
    clearCollapseTimer()
    setExpanded(true)
  }, [clearCollapseTimer])

  const collapseIsland = useCallback((): void => {
    clearCollapseTimer()
    setWorkspaceOpen(false)
    setExpanded(false)
  }, [clearCollapseTimer])

  const scheduleCollapse = useCallback((delay = ISLAND_COLLAPSE_DELAY): void => {
    clearCollapseTimer()
    if (activeTab?.status === 'loading') return
    collapseTimerRef.current = window.setTimeout(() => {
      if (islandRef.current?.contains(document.activeElement)) return
      setWorkspaceOpen(false)
      setExpanded(false)
    }, delay)
  }, [activeTab?.status, clearCollapseTimer])

  useEffect(() => () => clearCollapseTimer(), [clearCollapseTimer])

  useEffect(() => {
    const revealForAddress = (): void => expandIsland()
    window.addEventListener('vast-focus-address', revealForAddress)
    return () => window.removeEventListener('vast-focus-address', revealForAddress)
  }, [expandIsland])

  useEffect(() => {
    const collapseForPageScroll = (): void => collapseIsland()
    window.addEventListener('vast-purist-page-scroll', collapseForPageScroll)
    return () => window.removeEventListener('vast-purist-page-scroll', collapseForPageScroll)
  }, [collapseIsland])

  useEffect(() => {
    const shell = islandRef.current?.closest<HTMLElement>('.app-shell')
    if (!shell) return undefined
    shell.dataset.puristIsland = expanded ? 'expanded' : 'collapsed'
    return () => {
      delete shell.dataset.puristIsland
    }
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const collapseFromPage = (event: PointerEvent): void => {
      if (event.target instanceof Node && !islandRef.current?.contains(event.target)) collapseIsland()
    }
    const collapseFromEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      ;(document.activeElement as HTMLElement | null)?.blur()
      collapseIsland()
    }
    document.addEventListener('pointerdown', collapseFromPage, true)
    window.addEventListener('keydown', collapseFromEscape, true)
    return () => {
      document.removeEventListener('pointerdown', collapseFromPage, true)
      window.removeEventListener('keydown', collapseFromEscape, true)
    }
  }, [collapseIsland, expanded])

  useEffect(() => {
    if (activeTab?.status === 'loading') {
      expandIsland()
      return
    }
    if (expanded) scheduleCollapse(ISLAND_ACTIVITY_COLLAPSE_DELAY)
  }, [activeTab?.status, expandIsland, expanded, scheduleCollapse])

  useEffect(() => {
    const previousId = previousActiveTabIdRef.current
    previousActiveTabIdRef.current = activeTab?.id
    if (!previousId || previousId === activeTab?.id) return
    expandIsland()
    scheduleCollapse(ISLAND_ACTIVITY_COLLAPSE_DELAY)
  }, [activeTab?.id, expandIsland, scheduleCollapse])

  const openAddress = (): void => {
    expandIsland()
    window.requestAnimationFrame(() => window.dispatchEvent(new Event('vast-focus-address')))
  }

  const addressLabel = topbarIslandAddress(activeTab)
  const showLoadingProgress = Boolean(activeTab && (activeTab.status === 'loading' || activeTab.progress > 0))
  const loadingProgress = activeTab
    ? Math.min(1, Math.max(activeTab.status === 'loading' ? 0.08 : 0, activeTab.progress))
    : 0

  return (
    <header className="purist-chrome drag relative z-30 shrink-0 text-white">
      <div
        ref={islandRef}
        data-testid="purist-topbar-island"
        data-state={expanded ? 'expanded' : 'collapsed'}
        onPointerEnter={clearCollapseTimer}
        onPointerLeave={() => scheduleCollapse()}
        onFocusCapture={expandIsland}
        onBlurCapture={() => {
          window.requestAnimationFrame(() => {
            if (!islandRef.current?.contains(document.activeElement)) scheduleCollapse()
          })
        }}
        className={`purist-chrome-surface topbar-island relative ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      >
        <button
          type="button"
          tabIndex={expanded ? -1 : 0}
          aria-hidden={expanded}
          aria-label={`Open browser controls for ${addressLabel}`}
          onClick={openAddress}
          className="topbar-island-compact no-drag absolute inset-0 flex w-full items-center justify-center gap-1.5 px-5 text-center"
        >
          {activeTab && isSecureUrl(getEffectiveTabUrl(activeTab.url)) && <LockKeyhole className="h-3 w-3 shrink-0" strokeWidth={2} />}
          <span className="min-w-0 truncate text-[13px] font-medium">{addressLabel}</span>
          {showLoadingProgress && (
            <span
              className="topbar-island-progress absolute bottom-0 left-0 right-0 h-px origin-left"
              style={{ transform: `scaleX(${loadingProgress})` }}
            />
          )}
        </button>

        <div className="topbar-island-expanded" aria-hidden={!expanded} inert={!expanded}>
          <div className="purist-titlebar-row drag flex h-10 min-w-0 items-center gap-1 px-2">
            <WorkspacePopover
              workspace={workspace}
              open={workspaceOpen}
              onToggle={() => setWorkspaceOpen((value) => !value)}
              onClose={() => setWorkspaceOpen(false)}
              variant="purist"
            />
            <PuristTabStrip />
            <WindowControls />
          </div>
          <AddressBar compact variant="purist" onFocusChange={(focused) => focused ? expandIsland() : scheduleCollapse()} />
          <BookmarksBar variant="purist" />
        </div>
      </div>
    </header>
  )
}

function topbarIslandAddress(tab?: Tab): string {
  if (!tab) return 'vast'
  const url = getEffectiveTabUrl(tab.url)
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.hostname.replace(/^www\./, '')
    if (parsed.protocol === 'vast:') return 'vast'
  } catch {
    // Fall back to the bounded raw value below.
  }
  return url.slice(0, 96)
}

function PuristTabStrip(): JSX.Element {
  const workspace = useBrowserStore(selectActiveWorkspace)
  const tabs = useBrowserStore((state) => state.tabs)
  const groups = useBrowserStore((state) => state.tabGroups)
  const activateTab = useBrowserStore((state) => state.activateTab)
  const closeTab = useBrowserStore((state) => state.closeTab)
  const createTab = useBrowserStore((state) => state.createTab)
  const moveTab = useBrowserStore((state) => state.moveTab)
  const [dragTargetId, setDragTargetId] = useState<string | null>(null)
  const [overflowEdges, setOverflowEdges] = useState({ left: false, right: false })
  const stripRef = useRef<HTMLDivElement | null>(null)

  const workspaceGroups = useMemo(
    () => groups.filter((group) => group.workspaceId === workspace?.id).sort((a, b) => a.order - b.order),
    [groups, workspace?.id]
  )
  const workspaceGroupById = useMemo(
    () => new Map(workspaceGroups.map((group) => [group.id, group])),
    [workspaceGroups]
  )

  const workspaceTabs = useMemo(() => {
    const scoped = tabs.filter((tab) => tab.workspaceId === workspace?.id)
    return [...scoped.filter((tab) => tab.pinned), ...scoped.filter((tab) => !tab.pinned)]
  }, [tabs, workspace?.id])

  const visiblePinnedCount = workspaceTabs.filter((tab) => tab.pinned).length

  const updateOverflowEdges = (): void => {
    const strip = stripRef.current
    if (!strip) return
    const maximumScroll = Math.max(0, strip.scrollWidth - strip.clientWidth)
    const left = strip.scrollLeft > 2
    const right = strip.scrollLeft < maximumScroll - 2
    setOverflowEdges((current) => current.left === left && current.right === right ? current : { left, right })
  }

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const observer = new ResizeObserver(updateOverflowEdges)
    observer.observe(strip)
    const frame = window.requestAnimationFrame(updateOverflowEdges)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [workspaceTabs.length])

  useEffect(() => {
    const strip = stripRef.current
    const activeElement = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    activeElement?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    const frame = window.requestAnimationFrame(updateOverflowEdges)
    return () => window.cancelAnimationFrame(frame)
  }, [workspace?.activeTabId])

  const onDrop = (event: DragEvent<HTMLDivElement>, targetId: string): void => {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain')
    if (draggedId) moveTab(draggedId, targetId)
    setDragTargetId(null)
  }

  const onTabDragEnd = (event: DragEvent<HTMLDivElement>, tab: Tab): void => {
    if (!shouldDetachPuristTab(event, stripRef.current)) return
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

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
    event.preventDefault()
    event.currentTarget.scrollBy({ left: event.deltaY, behavior: 'smooth' })
  }

  return (
    <div className="purist-tab-bar drag flex min-w-0 flex-1 items-center gap-1">
      <div
        ref={stripRef}
        data-overflow-left={overflowEdges.left}
        data-overflow-right={overflowEdges.right}
        onScroll={updateOverflowEdges}
        onWheel={onWheel}
        className="purist-tab-viewport no-drag flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
      >
        <div role="tablist" aria-label="Open tabs" className="contents">
          {workspaceTabs.map((tab, index) => (
            <div key={tab.id} className="contents">
              {index === visiblePinnedCount && visiblePinnedCount > 0 && (
                <span aria-hidden="true" className="purist-tab-separator mx-1 h-4 w-px shrink-0" />
              )}
              <PuristTab
                tab={tab}
                active={tab.id === workspace?.activeTabId}
                group={tab.groupId ? workspaceGroupById.get(tab.groupId) : undefined}
                dragTarget={dragTargetId === tab.id}
                onActivate={() => activateTab(tab.id)}
                onClose={() => {
                  notifyCatTabClosing()
                  closeTab(tab.id)
                }}
                onDrop={(event) => onDrop(event, tab.id)}
                onDragEnd={(event) => onTabDragEnd(event, tab)}
                onDragTarget={() => setDragTargetId(tab.id)}
                onDragExit={() => setDragTargetId(null)}
              />
            </div>
          ))}
        </div>
        <button
          type="button"
          title="New tab"
          aria-label="New tab"
          onClick={() => {
            notifyCatNewTabButton()
            createTab({ workspaceId: workspace?.id, activate: true })
          }}
          className="purist-new-tab no-drag grid h-8 w-8 shrink-0 place-items-center rounded-full text-vast-soft transition"
        >
          <Plus className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  )
}

function PuristTabComponent({
  tab,
  active,
  group,
  dragTarget,
  onActivate,
  onClose,
  onDrop,
  onDragEnd,
  onDragTarget,
  onDragExit
}: {
  tab: Tab
  active: boolean
  group?: TabGroup
  dragTarget: boolean
  onActivate: () => void
  onClose: () => void
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragEnd: (event: DragEvent<HTMLDivElement>) => void
  onDragTarget: () => void
  onDragExit: () => void
}): JSX.Element {
  const motionRef = useTabMotion<HTMLDivElement>(tab.id)
  const groupIsNamed = Boolean(group && group.name.toLowerCase() !== 'today')

  return (
    <div
      ref={motionRef}
      data-tab-motion-id={tab.id}
      data-pinned={tab.pinned}
      draggable
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
      className={`purist-tab no-drag group relative h-8 shrink-0 ${tab.pinned ? 'is-pinned' : ''} ${active ? 'is-active' : ''} ${dragTarget ? 'is-drag-target' : ''}`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={`${tab.title}\n${tab.pinned ? 'Pinned · ' : ''}${tab.lifecycle}`}
        onClick={onActivate}
        onAuxClick={(event) => {
          if (event.button === 1) onClose()
        }}
        className="purist-tab-surface flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-[11px] border px-2 text-left transition"
      >
        <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
        {!tab.pinned && <span className="purist-tab-title min-w-0 flex-1 truncate text-xs font-medium">{tab.title}</span>}
        {!tab.pinned && tab.status === 'loading' && <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="Loading" />}
        {!tab.pinned && tab.status === 'error' && <CircleAlert className="h-3.5 w-3.5 shrink-0 text-red-300" aria-label="Load failed" />}
        {!tab.pinned && tab.muted && <Volume2 className="h-3.5 w-3.5 shrink-0" aria-label="Muted" />}
        {!tab.pinned && tab.lifecycle === 'sleeping' && <Moon className="h-3.5 w-3.5 shrink-0" aria-label="Sleeping" />}
        {groupIsNamed && (
          <span
            aria-label={`Tab group: ${group?.name}`}
            className="purist-tab-group-mark absolute bottom-[3px] left-1/2 h-0.5 w-3 -translate-x-1/2 rounded-full"
            style={{ backgroundColor: group?.color }}
          />
        )}
      </button>
      {!tab.pinned && (
        <button
          type="button"
          title="Close tab"
          aria-label={`Close ${tab.title}`}
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
          className="purist-tab-close absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full transition"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

const PuristTab = memo(PuristTabComponent, (previous, next) =>
  previous.tab === next.tab &&
  previous.active === next.active &&
  previous.group === next.group &&
  previous.dragTarget === next.dragTarget
)
