import { ChevronsLeft, ChevronsRight, PanelRight, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBrowserStore, selectActiveWorkspace } from '../../store/browser-store'
import { BrandMark } from '../ui/BrandMark'
import { IconButton } from '../ui/IconButton'
import { WorkspaceSwitcher } from '../workspaces/WorkspaceSwitcher'
import { TabRow } from './TabRow'

export function Sidebar({ forcedCollapsed = false, onManualExpand }: { forcedCollapsed?: boolean; onManualExpand?: () => void }): JSX.Element {
  const workspace = useBrowserStore(selectActiveWorkspace)
  const tabs = useBrowserStore((state) => state.tabs)
  const sidebarDensity = useBrowserStore((state) => state.settings.sidebarDensity)
  const savedSidebarCollapsed = useBrowserStore((state) => state.sidebarCollapsed)
  const sidebarCollapsed = forcedCollapsed || savedSidebarCollapsed
  const setSidebarCollapsed = useBrowserStore((state) => state.setSidebarCollapsed)
  const setCommandPaletteOpen = useBrowserStore((state) => state.setCommandPaletteOpen)
  const setSidePanelOpen = useBrowserStore((state) => state.setSidePanelOpen)
  const sidePanelOpen = useBrowserStore((state) => state.sidePanelOpen)
  const createTab = useBrowserStore((state) => state.createTab)

  const tabLayout = useMemo(() => {
    const workspaceTabs = workspace ? tabs.filter((tab) => tab.workspaceId === workspace.id) : []
    return {
      pinnedTabs: workspaceTabs.filter((tab) => tab.pinned),
      regularTabs: workspaceTabs.filter((tab) => !tab.pinned)
    }
  }, [tabs, workspace])
  const { pinnedTabs, regularTabs } = tabLayout
  const compactDensity = sidebarDensity === 'compact'
  const asideRef = useRef<HTMLElement | null>(null)
  const [compactContents, setCompactContents] = useState(sidebarCollapsed)
  const showCompactContents = sidebarCollapsed || compactContents

  useEffect(() => {
    if (sidebarCollapsed) {
      setCompactContents(true)
      return
    }
    if (!compactContents) return
    let frame = 0
    const revealExpandedContents = (): void => {
      const width = asideRef.current?.getBoundingClientRect().width
      if (width === undefined) return
      if (width >= (compactDensity ? 220 : 248) - 1) {
        setCompactContents(false)
      } else {
        frame = window.requestAnimationFrame(revealExpandedContents)
      }
    }
    frame = window.requestAnimationFrame(revealExpandedContents)
    return () => window.cancelAnimationFrame(frame)
  }, [sidebarCollapsed, compactContents, compactDensity])

  return (
    <aside
      ref={asideRef}
      data-tab-sidebar
      className={`drag relative flex min-h-0 shrink-0 flex-col border-r border-white/8 bg-[#08090d]/88 text-white backdrop-blur-2xl transition-[width] duration-200 ease-smooth ${
        sidebarCollapsed ? 'w-16' : compactDensity ? 'w-[220px]' : 'w-[248px]'
      }`}
      data-sidebar-content={showCompactContents ? 'compact' : 'expanded'}
    >
      <div className={`no-drag flex items-center justify-between overflow-hidden px-4 ${compactDensity ? 'h-[58px]' : 'h-[72px]'}`}>
        <BrandMark compact={showCompactContents} />
        {!showCompactContents && (
          <IconButton tooltip="Collapse sidebar" onClick={() => setSidebarCollapsed(true)}>
            <ChevronsLeft className="h-4 w-4" />
          </IconButton>
        )}
      </div>
      {showCompactContents && (
        <div className="no-drag flex w-16 shrink-0 justify-center pb-2">
          <IconButton tooltip="Expand sidebar" onClick={() => { onManualExpand?.(); setSidebarCollapsed(false) }}>
            <ChevronsRight className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      <div className={`no-drag flex items-center gap-2 ${showCompactContents ? 'w-16 shrink-0 justify-center' : 'px-4'} ${compactDensity ? 'pb-2' : 'pb-3'}`}>
        {showCompactContents ? (
          <IconButton tooltip="Sidebar" active={sidePanelOpen} onClick={() => setSidePanelOpen(!sidePanelOpen)}>
            <PanelRight className="h-4 w-4" />
          </IconButton>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setCommandPaletteOpen(true)}
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-control border border-white/6 bg-white/[0.035] px-3 text-left text-[12px] text-vast-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition hover:border-white/12 hover:bg-white/6.5 hover:text-white"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="min-w-0 flex-1 truncate">Command...</span>
              <kbd className="rounded-control border border-white/6 bg-black/20 px-1.5 py-0.5 text-[10px] text-vast-soft">⌘K</kbd>
            </button>
            <IconButton tooltip="Sidebar" active={sidePanelOpen} onClick={() => setSidePanelOpen(!sidePanelOpen)}>
              <PanelRight className="h-4 w-4" />
            </IconButton>
          </>
        )}
      </div>

      <div className={`no-drag ${showCompactContents ? 'w-16 shrink-0 px-2' : 'px-4'} ${compactDensity ? 'pb-2' : 'pb-4'}`}>
        <WorkspaceSwitcher compact={showCompactContents} />
      </div>

      <div className={`no-drag min-h-0 flex-1 overflow-y-auto ${showCompactContents ? 'w-16 shrink-0 px-2' : 'px-4'} pb-4`}>
        <div className="space-y-1" data-testid="vertical-tabs-list">
          {pinnedTabs.map((tab) => (
            <TabRow key={tab.id} tab={tab} active={tab.id === workspace?.activeTabId} compact={showCompactContents} />
          ))}
          {pinnedTabs.length > 0 && regularTabs.length > 0 && <div className="mx-2 my-2 h-px bg-white/[0.07]" />}
          {regularTabs.map((tab) => (
            <TabRow key={tab.id} tab={tab} active={tab.id === workspace?.activeTabId} compact={showCompactContents} />
          ))}
        </div>
      </div>

      <div className={`no-drag border-t border-white/[0.07] ${showCompactContents ? 'grid w-16 shrink-0 place-items-center p-2' : 'p-3'}`}>
        {showCompactContents ? (
          <IconButton tooltip="New tab" data-testid="vertical-new-tab" onClick={() => createTab({ activate: true })}>
            <Plus className="h-4 w-4" />
          </IconButton>
        ) : (
          <button
            type="button"
            title="New tab"
            onClick={() => createTab({ activate: true })}
            data-testid="vertical-new-tab"
            className="flex h-10 w-full items-center gap-2.5 rounded-control border border-white/8 bg-white/4.5 px-3 text-left text-[13px] font-semibold text-white/85 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)] transition hover:border-white/[0.14] hover:bg-white/7.5 hover:text-white"
          >
            <span className="grid h-6 w-6 place-items-center rounded-control bg-vast-cyan/9 text-vast-cyan"><Plus className="h-3.5 w-3.5" /></span>
            <span className="min-w-0 flex-1">New tab</span>
            <kbd className="text-[10px] font-medium text-white/30">Ctrl T</kbd>
          </button>
        )}
      </div>
    </aside>
  )
}
