import { ChevronDown, ChevronRight, Edit3, MoreHorizontal, Trash2 } from 'lucide-react'
import type { DragEvent } from 'react'
import { memo, useState } from 'react'
import type { Tab, TabGroup } from '../../../shared/types'
import { useBrowserStore } from '../../store/browser-store'
import { TabRow } from './TabRow'

const GROUP_COLORS = ['#74e7ff', '#b7a7ff', '#ffbf69', '#7ee787', '#ff7aa2', '#f472b6']

function TabGroupSectionComponent({
  group,
  tabs,
  workspaceGroups,
  activeTabId,
  compact
}: {
  group: TabGroup
  tabs: Tab[]
  workspaceGroups: TabGroup[]
  activeTabId?: string
  compact?: boolean
}): JSX.Element {
  const toggleGroup = useBrowserStore((state) => state.toggleGroup)
  const updateGroup = useBrowserStore((state) => state.updateGroup)
  const deleteGroup = useBrowserStore((state) => state.deleteGroup)
  const moveTabToGroup = useBrowserStore((state) => state.moveTabToGroup)
  const createTab = useBrowserStore((state) => state.createTab)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const openContextMenu = useBrowserStore((state) => state.openContextMenu)
  const [menuOpen, setMenuOpen] = useState(false)

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    const draggedId = event.dataTransfer.getData('text/plain')
    if (draggedId) moveTabToGroup(draggedId, group.id)
  }

  if (compact) {
    return (
      <div className="space-y-1">
        {tabs.map((tab) => (
          <TabRow key={tab.id} tab={tab} active={tab.id === activeTabId} compact groups={workspaceGroups} />
        ))}
      </div>
    )
  }

  return (
    <section className="space-y-1" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <div
        className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft hover:bg-white/[0.05] hover:text-white"
        onContextMenu={(event) => {
          event.preventDefault()
          openContextMenu({
            x: event.clientX,
            y: event.clientY,
            title: group.name,
            items: [
              {
                id: 'toggle',
                label: group.collapsed ? 'Expand group' : 'Collapse group',
                action: () => toggleGroup(group.id)
              },
              {
                id: 'new-tab',
                label: 'New tab in group',
                action: () => {
                  void createTab({ workspaceId: group.workspaceId, groupId: group.id, activate: true })
                }
              },
              {
                id: 'rename',
                label: 'Rename group',
                action: () =>
                  openPromptDialog({
                    title: 'Rename group',
                    label: 'Group name',
                    placeholder: group.name,
                    confirmLabel: 'Rename group',
                    onConfirm: (name) => updateGroup(group.id, { name })
                  })
              },
              { id: 'separator', label: '', separator: true },
              {
                id: 'delete',
                label: 'Delete group',
                detail: 'Tabs stay open and move to loose tabs.',
                danger: true,
                action: () => deleteGroup(group.id)
              }
            ]
          })
        }}
      >
        <button type="button" onClick={() => toggleGroup(group.id)} className="grid h-5 w-5 place-items-center rounded-md hover:bg-white/10">
          {group.collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full shadow-[0_0_14px_currentColor]" style={{ color: group.color, backgroundColor: group.color }} />
        <button
          type="button"
          onClick={() => toggleGroup(group.id)}
          className="min-w-0 flex-1 truncate text-left uppercase tracking-[0.12em]"
        >
          {group.name}
        </button>
        <div className="relative opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            title="Group options"
            onClick={() => setMenuOpen((value) => !value)}
            className="grid h-6 w-6 place-items-center rounded-md text-white/[0.35] hover:bg-white/10 hover:text-white"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-30 w-52 rounded-2xl border border-white/10 bg-[#0c0d12]/[0.98] p-2 shadow-glass backdrop-blur-xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  openPromptDialog({
                    title: 'Rename group',
                    label: 'Group name',
                    placeholder: group.name,
                    confirmLabel: 'Rename group',
                    onConfirm: (name) => updateGroup(group.id, { name })
                  })
                }}
                className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-xs text-vast-soft hover:bg-white/[0.07] hover:text-white"
              >
                <Edit3 className="h-3.5 w-3.5 text-vast-cyan" />
                Rename
              </button>
              <div className="px-2 py-2">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-vast-soft">Color</div>
                <div className="flex flex-wrap gap-1.5">
                  {GROUP_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      title={color}
                      onClick={() => updateGroup(group.id, { color })}
                      className={`h-5 w-5 rounded-full border ${group.color === color ? 'border-white' : 'border-white/15'}`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  deleteGroup(group.id)
                }}
                className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-xs text-red-300 hover:bg-red-400/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
      {!group.collapsed && (
        <div className="space-y-1">
          {tabs.map((tab) => (
            <TabRow key={tab.id} tab={tab} active={tab.id === activeTabId} groups={workspaceGroups} />
          ))}
        </div>
      )}
    </section>
  )
}

export const TabGroupSection = memo(TabGroupSectionComponent, (previous, next) =>
  previous.group === next.group &&
  previous.tabs === next.tabs &&
  previous.workspaceGroups === next.workspaceGroups &&
  previous.activeTabId === next.activeTabId &&
  previous.compact === next.compact
)
