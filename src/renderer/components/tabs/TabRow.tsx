import { GripVertical, Moon, X } from 'lucide-react'
import { memo, type DragEvent } from 'react'
import type { Tab, TabGroup } from '../../../shared/types'
import { openTabContextMenu } from '../../lib/context-menu'
import { useTabMotion } from '../../lib/tab-motion'
import { useBrowserStore } from '../../store/browser-store'
import { Favicon, getInternalTabMeta } from '../ui/Favicon'
import { VastSelect } from '../ui/VastSelect'

const TAB_TEAR_OUT_MARGIN = 18

function shouldDetachVerticalTab(event: DragEvent<HTMLElement>): boolean {
  const { clientX, clientY, currentTarget } = event
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
  if (clientX <= 0 || clientY <= 0 || clientX >= window.innerWidth - 1 || clientY >= window.innerHeight - 1) {
    return true
  }
  const sidebar = (currentTarget as HTMLElement).closest('aside')
  if (!sidebar) return false
  const rect = sidebar.getBoundingClientRect()
  return (
    clientX < rect.left - TAB_TEAR_OUT_MARGIN ||
    clientX > rect.right + TAB_TEAR_OUT_MARGIN ||
    clientY < rect.top - TAB_TEAR_OUT_MARGIN ||
    clientY > rect.bottom + TAB_TEAR_OUT_MARGIN
  )
}

interface TabRowProps {
  tab: Tab
  active: boolean
  compact?: boolean
  groups?: TabGroup[]
}

function TabRowComponent({ tab, active, compact, groups = [] }: TabRowProps): JSX.Element {
  const motionRef = useTabMotion<HTMLDivElement>(tab.id)
  const activateTab = useBrowserStore((state) => state.activateTab)
  const closeTab = useBrowserStore((state) => state.closeTab)
  const moveTab = useBrowserStore((state) => state.moveTab)
  const moveTabToGroup = useBrowserStore((state) => state.moveTabToGroup)
  const compactDensity = useBrowserStore((state) => state.settings.sidebarDensity === 'compact')
  const internalMeta = getInternalTabMeta(tab.url)
  const tabTone = internalMeta
    ? active
      ? internalMeta.activeTabClassName
      : internalMeta.tabClassName
    : active
      ? 'bg-white/[0.085] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_28px_rgba(0,0,0,0.16)]'
      : 'border-transparent text-vast-soft hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white'

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain')
    if (draggedId) moveTab(draggedId, tab.id)
  }

  const onDragEnd = (event: DragEvent<HTMLDivElement>): void => {
    if (!shouldDetachVerticalTab(event)) return
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
    void window.vast.browser.detachTab({
      ...payload
    }).then((result) => {
      if (result.ok) closeTab(tab.id)
      else console.warn('[tabs] Failed to detach tab:', result.error)
    })
  }

  return (
    <div
      ref={motionRef}
      data-tab-motion-id={tab.id}
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', tab.id)
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(event) => {
        event.preventDefault()
        openTabContextMenu(tab, event.clientX, event.clientY)
      }}
      onClick={() => activateTab(tab.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activateTab(tab.id)
        }
      }}
      className={`group relative flex w-full items-center gap-2 overflow-hidden rounded-xl border px-2 text-left transition duration-150 ease-smooth ${tabTone} ${active ? 'vast-tab-active' : ''} ${compactDensity ? 'h-8' : 'h-10'} ${compact ? 'justify-center px-0' : ''}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: compactDensity ? '32px' : '40px' }}
      title={tab.title}
    >
      {tab.status === 'loading' && (
        <span
          className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-vast-cyan/70 transition-all"
          style={{ transform: `scaleX(${Math.max(tab.progress, 0.12)})`, transformOrigin: 'left' }}
        />
      )}
      {!compact && <GripVertical className="h-3.5 w-3.5 shrink-0 text-white/20 opacity-0 transition group-hover:opacity-100" />}
      <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
      {!compact && (
        <>
          <span className={`min-w-0 flex-1 truncate text-[13px] font-medium ${internalMeta ? internalMeta.labelClassName : ''}`}>{tab.title}</span>
          {groups.length > 1 && (
            <VastSelect
              value={tab.groupId ?? ''}
              options={[
                { value: '', label: 'Loose' },
                ...groups.map((group) => ({ value: group.id, label: group.name }))
              ]}
              onChange={(groupId) => moveTabToGroup(tab.id, groupId || undefined)}
              ariaLabel={`Move ${tab.title} to group`}
              className="max-w-20 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
              buttonClassName="h-7 min-h-7 rounded-md px-1.5 text-[10px]"
            />
          )}
          {tab.lifecycle === 'sleeping' && (
            <Moon className="h-3.5 w-3.5 shrink-0 text-vast-soft" aria-label="Sleeping tab" />
          )}
          <span
            role="button"
            tabIndex={0}
            title="Close tab"
            onClick={(event) => {
              event.stopPropagation()
              closeTab(tab.id)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.stopPropagation()
                closeTab(tab.id)
              }
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-white/[0.35] opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        </>
      )}
    </div>
  )
}

export const TabRow = memo(TabRowComponent, (previous, next) =>
  previous.tab === next.tab &&
  previous.active === next.active &&
  previous.compact === next.compact &&
  previous.groups === next.groups
)
