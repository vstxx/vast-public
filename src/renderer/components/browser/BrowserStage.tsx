import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { Columns2 } from 'lucide-react'
import {
  INTERNAL_AUTOMATION_URL,
  INTERNAL_AVIDAE_URL,
  INTERNAL_DIAGNOSTICS_URL,
  INTERNAL_EXTENSIONS_URL,
  INTERNAL_NEW_TAB_URL,
  INTERNAL_NOTES_URL,
  INTERNAL_NETWORK_URL,
  INTERNAL_PDF_VIEWER_URL,
  INTERNAL_PASSWORDS_URL,
  INTERNAL_SESSION_TIMELINE_URL,
  INTERNAL_SITE_DATA_URL
} from '../../../shared/constants'
import type { ID, Tab } from '../../../shared/types'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { isInternalUrl, matchesInternalUrl } from '../../lib/url'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { ErrorPage } from './ErrorPage'
import { WebviewSurface } from './WebviewSurface'
import { InternalPageRouter } from './InternalPageRouter'
import { SplitPaneHeader } from './SplitViewSurface'
import { useTabRetentionController } from './TabRetentionController'
import { DEFAULT_WORKSPACE_IDENTITY, partitionForWorkspace, resolveWorkspaceIdentity } from '../../../shared/workspace-identity'


export interface BrowserStageHandle {
  getWebview: (tabId: ID) => Electron.WebviewTag | undefined
  getActiveWebview: () => Electron.WebviewTag | undefined
  getTabIdForWebContents: (webContentsId: number) => ID | undefined
}





interface BrowserStageProps {
  htmlFullscreenTabId?: ID
  puristChromeVisible?: boolean
}





export const BrowserStage = forwardRef<BrowserStageHandle, BrowserStageProps>(function BrowserStage(
  { htmlFullscreenTabId, puristChromeVisible = false },
  ref
): JSX.Element {
  const stageRef = useRef<HTMLElement | null>(null)
  const webviews = useRef(new Map<ID, Electron.WebviewTag>())
  const runtime = useBrowserRuntime()
  const activeWorkspace = useBrowserStore(selectActiveWorkspace)
  const activeTab = useBrowserStore(selectActiveTab)
  const tabs = useBrowserStore((state) => state.tabs)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const splitView = useBrowserStore((state) => state.splitView)
  const hibernateInactiveTabs = useBrowserStore((state) => state.settings.hibernateInactiveTabs)
  const ramSettings = useBrowserStore((state) => state.settings.advanced)
  const updateTab = useBrowserStore((state) => state.updateTab)
  const createTab = useBrowserStore((state) => state.createTab)
  const openContextMenu = useBrowserStore((state) => state.openContextMenu)
  const setCommandPaletteOpen = useBrowserStore((state) => state.setCommandPaletteOpen)
  const setSettingsOpen = useBrowserStore((state) => state.setSettingsOpen)
  const setActiveSidePanel = useBrowserStore((state) => state.setActiveSidePanel)
  const activateTab = useBrowserStore((state) => state.activateTab)
  const setSplitView = useBrowserStore((state) => state.setSplitView)
  const setSplitRatio = useBrowserStore((state) => state.setSplitRatio)
  const swapSplitPanes = useBrowserStore((state) => state.swapSplitPanes)

  const primaryTab = useMemo(
    () => (splitView.enabled ? tabs.find((tab) => tab.id === splitView.primaryTabId) : undefined),
    [splitView.enabled, splitView.primaryTabId, tabs]
  )
  const secondaryTab = useMemo(
    () => (splitView.enabled ? tabs.find((tab) => tab.id === splitView.secondaryTabId) : undefined),
    [splitView.enabled, splitView.secondaryTabId, tabs]
  )
  const splitActive = Boolean(
    splitView.enabled &&
    primaryTab &&
    secondaryTab &&
    primaryTab.id !== secondaryTab.id &&
    primaryTab.workspaceId === activeWorkspace?.id &&
    secondaryTab.workspaceId === activeWorkspace.id
  )

  const visibleIds = useMemo(() => {
    if (splitActive && primaryTab && secondaryTab) return [primaryTab.id, secondaryTab.id]
    return activeTab ? [activeTab.id] : []
  }, [activeTab, primaryTab, secondaryTab, splitActive])

  const { webTabs, setMediaActive, callProtectedTabIds } = useTabRetentionController({
    webviews,
    tabs,
    visibleIds,
    hibernateInactiveTabs,
    ramSettings
  })
  const [splitRatio, setSplitRatioPreview] = useState(() => splitView.ratio ?? 50)
  const splitRatioRef = useRef(splitRatio)

  useEffect(() => {
    const ratio = splitView.ratio ?? 50
    splitRatioRef.current = ratio
    setSplitRatioPreview(ratio)
  }, [splitView.ratio])

  const previewSplitRatio = useCallback((ratio: number): void => {
    const nextRatio = Math.min(72, Math.max(28, ratio))
    splitRatioRef.current = nextRatio
    setSplitRatioPreview(nextRatio)
  }, [])

  const commitSplitRatio = useCallback((): void => {
    setSplitRatio(splitRatioRef.current)
  }, [setSplitRatio])

  useEffect(() => {
    if (splitView.enabled && !splitActive) setSplitView(false)
  }, [setSplitView, splitActive, splitView.enabled])

  const focusPane = useCallback((tabId: ID): void => {
    if (useBrowserStore.getState().workspaces.find((workspace) => workspace.id === useBrowserStore.getState().activeWorkspaceId)?.activeTabId !== tabId) {
      activateTab(tabId)
    }
  }, [activateTab])


  const callProtectedTabIdsRef = useRef(callProtectedTabIds)
  callProtectedTabIdsRef.current = callProtectedTabIds

  const register = useCallback((tabId: ID, webview?: Electron.WebviewTag) => {
    const previous = webviews.current.get(tabId)
    if (webview) {
      webviews.current.set(tabId, webview)
      try {
        void window.vast.browser.setKeepAwake(webview.getWebContentsId(), callProtectedTabIdsRef.current.has(tabId))
      } catch {
        // The guest may not expose its webContents id until dom-ready retries registration.
      }
      return
    }
    if (previous) {
      try {
        void window.vast.browser.setKeepAwake(previous.getWebContentsId(), false)
      } catch {
        // Detached guests may already be destroyed.
      }
    }
    webviews.current.delete(tabId)
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      getWebview: (tabId) => webviews.current.get(tabId),
      getActiveWebview: () => (activeTab ? webviews.current.get(activeTab.id) : undefined),
      getTabIdForWebContents: (webContentsId) => {
        for (const [tabId, webview] of webviews.current) {
          try {
            if (webview.getWebContentsId() === webContentsId) return tabId
          } catch {
            // A webview can disappear between the main-process route and this lookup.
          }
        }
        return undefined
      }
    }),
    [activeTab]
  )

  const panes = visibleIds.map((id, index) => tabs.find((tab) => tab.id === id)).filter(Boolean) as Tab[]

  const openInternalPageMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>, tab: Tab): void => {
      event.preventDefault()
      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: 'Vast page',
        items: [
          {
            id: 'focus-address',
            label: 'Focus address bar',
            shortcut: 'Ctrl/Cmd+L',
            action: runtime.focusAddress
          },
          {
            id: 'new-tab',
            label: 'New tab',
            shortcut: 'Ctrl/Cmd+T',
            action: () => runtime.openUrlInNewTab(INTERNAL_NEW_TAB_URL)
          },
          {
            id: 'avidae',
            label: 'Open Video & Audio',
            action: () => runtime.openUrlInNewTab(INTERNAL_AVIDAE_URL)
          },
          {
            id: 'passwords',
            label: 'Open Password Manager',
            action: () => runtime.openUrlInNewTab(INTERNAL_PASSWORDS_URL)
          },
          {
            id: 'automation',
            label: 'Open Automation',
            action: () => runtime.openUrlInNewTab(INTERNAL_AUTOMATION_URL)
          },
          {
            id: 'network',
            label: 'Open Network Devices',
            action: () => runtime.openUrlInNewTab(INTERNAL_NETWORK_URL)
          },
          {
            id: 'notes-page',
            label: 'Open Notes',
            action: () => runtime.openUrlInNewTab(INTERNAL_NOTES_URL)
          },
          {
            id: 'diagnostics',
            label: 'Open Diagnostics',
            action: () => runtime.openUrlInNewTab(INTERNAL_DIAGNOSTICS_URL)
          },
          {
            id: 'session-timeline',
            label: 'Open Session Timeline',
            action: () => runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)
          },
          {
            id: 'extensions',
            label: 'Open Extensions',
            action: () => runtime.openUrlInNewTab(INTERNAL_EXTENSIONS_URL)
          },
          {
            id: 'command',
            label: 'Open command palette',
            shortcut: 'Ctrl/Cmd+K',
            action: () => setCommandPaletteOpen(true)
          },
          { id: 'internal-separator-1', label: '', separator: true },
          {
            id: 'notes',
            label: 'Open notes panel',
            action: () => setActiveSidePanel('notes')
          },
          {
            id: 'bookmarks',
            label: 'Open bookmarks panel',
            action: () => setActiveSidePanel('bookmarks')
          },
          {
            id: 'settings',
            label: 'Open settings',
            action: () => setSettingsOpen(true)
          },
          { id: 'internal-separator-2', label: '', separator: true },
          {
            id: 'split',
            label: 'Toggle split view',
            action: runtime.toggleSplitView
          },
          {
            id: 'copy-title',
            label: 'Copy tab title',
            action: () => navigator.clipboard.writeText(tab.title)
          }
        ]
      })
    },
    [openContextMenu, runtime, setActiveSidePanel, setCommandPaletteOpen, setSettingsOpen]
  )


  return (
    <main
      ref={stageRef}
      className={`browser-stage relative grid min-h-0 flex-1 overflow-hidden bg-black ${activeTab?.url === INTERNAL_NEW_TAB_URL ? 'is-new-tab' : ''} ${splitActive && !htmlFullscreenTabId ? 'is-split' : ''} ${htmlFullscreenTabId ? 'is-html-fullscreen' : ''}`}
      data-testid="browser-stage"
      data-split={splitActive && !htmlFullscreenTabId ? 'true' : 'false'}
      data-html-fullscreen={htmlFullscreenTabId ? 'true' : 'false'}
      style={{
        gridTemplateColumns: splitActive && !htmlFullscreenTabId ? `minmax(0,${splitRatio}fr) minmax(0,${100 - splitRatio}fr)` : '1fr',
        gridTemplateRows: 'minmax(0,1fr)'
      }}
    >
      {!htmlFullscreenTabId && panes.map((tab, index) =>
        isInternalUrl(tab.url) ? (
          <section
            key={tab.id}
            className={`browser-stage-pane relative flex h-full min-h-0 flex-col overflow-hidden ${splitActive && activeTab?.id === tab.id ? 'ring-1 ring-inset ring-vast-cyan/20' : ''}`}
            style={{ gridColumn: index + 1 }}
            data-testid={splitActive ? 'split-pane' : undefined}
            data-tab-id={tab.id}
            data-active={activeTab?.id === tab.id ? 'true' : 'false'}
            onContextMenu={(event) => openInternalPageMenu(event, tab)}
          >
            {splitActive && (
              <SplitPaneHeader
                tab={tab}
                active={activeTab?.id === tab.id}
                side={index === 0 ? 'left' : 'right'}
                onActivate={() => focusPane(tab.id)}
                onSwap={swapSplitPanes}
                onExit={() => {
                  focusPane(tab.id)
                  setSplitView(false)
                }}
              />
            )}
            <div
              className={`relative min-h-0 flex-1 ${tab.url === INTERNAL_AVIDAE_URL || tab.url === INTERNAL_NOTES_URL || matchesInternalUrl(tab.url, INTERNAL_PDF_VIEWER_URL) ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden'}`}
              onPointerDown={() => focusPane(tab.id)}
            >
              <InternalPageRouter tab={tab} />
            </div>
          </section>
        ) : null
      )}
      {webTabs.map((tab) => {
        const workspace = workspaces.find((item) => item.id === tab.workspaceId)
        const identityWorkspace = workspaces.find((item) => item.id === tab.identityWorkspaceId) ?? workspace
        const identityPartition = identityWorkspace ? partitionForWorkspace(identityWorkspace) : 'persist:vast-default'
        const visibleIndex = visibleIds.indexOf(tab.id)
        const isHtmlFullscreenTab = tab.id === htmlFullscreenTabId
        const visible = htmlFullscreenTabId ? isHtmlFullscreenTab : visibleIndex >= 0
        const wakingSleepingTab = visible && hibernateInactiveTabs && !webviews.current.has(tab.id) && tab.status !== 'error'
        return (
          <div
            key={tab.id}
            className={`browser-stage-pane relative min-h-0 overflow-hidden ${splitActive && !htmlFullscreenTabId && activeTab?.id === tab.id ? 'ring-1 ring-inset ring-vast-cyan/20' : ''}`}
            style={{
              display: visible ? 'grid' : 'none',
              gridColumn: visible ? (htmlFullscreenTabId ? 1 : visibleIndex + 1) : undefined,
              gridTemplateRows: splitActive && !htmlFullscreenTabId ? '40px minmax(0,1fr)' : 'minmax(0,1fr)'
            }}
            data-testid={visible && splitActive && !htmlFullscreenTabId ? 'split-pane' : undefined}
            data-tab-id={visible ? tab.id : undefined}
            data-active={visible && activeTab?.id === tab.id ? 'true' : 'false'}
          >
            {visible && splitActive && !htmlFullscreenTabId && (
              <SplitPaneHeader
                tab={tab}
                active={activeTab?.id === tab.id}
                side={visibleIndex === 0 ? 'left' : 'right'}
                onActivate={() => focusPane(tab.id)}
                onSwap={swapSplitPanes}
                onExit={() => {
                  focusPane(tab.id)
                  setSplitView(false)
                }}
              />
            )}
            <div className="relative min-h-0 overflow-hidden" onPointerDown={() => visible && focusPane(tab.id)}>
              <WebviewSurface
                key={`${tab.id}:${identityPartition}`}
                tab={tab}
                visible={visible}
                isPrivate={identityWorkspace ? resolveWorkspaceIdentity(identityWorkspace).sessionMode === 'ephemeral' : Boolean(workspace?.isPrivate)}
                identity={identityWorkspace?.identity ?? DEFAULT_WORKSPACE_IDENTITY}
                partition={identityPartition}
                identitySeed={identityWorkspace?.id ?? tab.workspaceId}
                register={register}
                setMediaActive={setMediaActive}
                onFocused={focusPane}
                puristSafeSpace={puristChromeVisible}
              />
              {visible && tab.error && (
                <ErrorPage
                  tab={tab}
                  onReload={() => {
                    updateTab(tab.id, { error: undefined, status: 'loading', lifecycle: 'active', progress: 0.12 })
                    const webview = webviews.current.get(tab.id)
                    if (webview) webview.reload()
                    else updateTab(tab.id, { lifecycle: 'sleeping' })
                  }}
                />
              )}
              {wakingSleepingTab && (
                <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/[0.18] backdrop-blur-[1px]">
                  <div className="rounded-3xl border border-white/10 bg-black/50 px-5 py-4 text-center shadow-glass backdrop-blur-xl">
                    <div className="mx-auto mb-3 h-1.5 w-14 rounded-full bg-vast-cyan/70 shadow-[0_0_22px_color-mix(in_srgb,var(--vast-accent)_32%,transparent)]" />
                    <div className="text-sm font-semibold text-white">Restoring discarded tab</div>
                    <div className="mt-1 text-xs text-vast-soft">Vast unloaded this page under memory pressure.</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      })}
      {splitActive && !htmlFullscreenTabId && (
        <div
          role="separator"
          aria-label="Resize split panes"
          aria-orientation="vertical"
          aria-valuemin={28}
          aria-valuemax={72}
          aria-valuenow={Math.round(splitRatio)}
          tabIndex={0}
          data-testid="split-resizer"
          className="group absolute inset-y-0 z-30 w-3 -translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none"
          style={{ left: `${splitRatio}%` }}
          onDoubleClick={() => {
            previewSplitRatio(50)
            setSplitRatio(50)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home') return
            event.preventDefault()
            const next = event.key === 'Home' ? 50 : Math.min(72, Math.max(28, splitRatio + (event.key === 'ArrowLeft' ? -2 : 2)))
            previewSplitRatio(next)
            setSplitRatio(next)
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const rect = stageRef.current?.getBoundingClientRect()
            if (!rect || rect.width <= 0) return
            previewSplitRatio(((event.clientX - rect.left) / rect.width) * 100)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            commitSplitRatio()
          }}
          onPointerCancel={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
            commitSplitRatio()
          }}
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 transition-colors group-hover:bg-vast-cyan/55 group-focus-visible:bg-vast-cyan" />
          <span className="absolute left-1/2 top-5 grid h-7 w-5 -translate-x-1/2 place-items-center rounded-full border border-white/10 bg-[#111218] text-white/35 shadow-md transition group-hover:border-vast-cyan/30 group-hover:text-vast-cyan">
            <Columns2 className="h-3 w-3" />
          </span>
        </div>
      )}
      {!activeTab && (
        <section className="browser-stage-pane grid place-items-center text-vast-soft">
          <div>No active tab</div>
        </section>
      )}
      {activeWorkspace?.isPrivate && !htmlFullscreenTabId && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-20 rounded-full border border-white/10 bg-black/40 px-3 py-1 text-[11px] font-medium text-vast-cyan backdrop-blur-xl">
          Isolated workspace - history off
        </div>
      )}
    </main>
  )
})
