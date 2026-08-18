import {
  Bookmark,
  Check,
  Clock3,
  Copy,
  Download,
  Edit3,
  Folder,
  GripHorizontal,
  History,
  ListChecks,
  NotebookPen,
  Pause,
  Play,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { INTERNAL_NEW_TAB_URL } from '../../../shared/constants'
import type { BookmarkFolder, SidePanelView } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatBytes, formatRelativeTime } from '../../lib/format'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { Favicon } from '../ui/Favicon'
import { IconButton } from '../ui/IconButton'
import { VastSelect } from '../ui/VastSelect'

const views: Array<{ id: SidePanelView; title: string; icon: typeof NotebookPen }> = [
  { id: 'notes', title: 'Notes', icon: NotebookPen },
  { id: 'bookmarks', title: 'Bookmarks', icon: Bookmark },
  { id: 'history', title: 'History', icon: History },
  { id: 'downloads', title: 'Downloads', icon: Download },
  { id: 'reading-list', title: 'Reading', icon: ListChecks }
]

const PANEL_EDGE_GAP = 12

interface PanelPosition {
  x: number
  y: number
}

function minimumPanelTopInset(): number {
  return window.vast.app.platform === 'win32' ? 60 : PANEL_EDGE_GAP
}

function measurePanelTopInset(): number {
  const browserStage = document.querySelector<HTMLElement>('.browser-stage-shell')
  if (!browserStage) return minimumPanelTopInset()
  return Math.max(minimumPanelTopInset(), Math.round(browserStage.getBoundingClientRect().top) + PANEL_EDGE_GAP)
}

function panelHeightFor(viewportHeight: number, topInset: number): number {
  const availableHeight = Math.max(240, viewportHeight - topInset - PANEL_EDGE_GAP)
  const movementReserve = Math.min(96, Math.max(32, Math.round(availableHeight * 0.14)))
  return Math.max(240, Math.min(720, availableHeight - movementReserve))
}

function clampPanelPosition(
  position: PanelPosition,
  width: number,
  viewport: { width: number; height: number },
  topInset: number
): PanelPosition {
  const height = panelHeightFor(viewport.height, topInset)
  const maxX = Math.max(PANEL_EDGE_GAP, viewport.width - width - PANEL_EDGE_GAP)
  const maxY = Math.max(topInset, viewport.height - height - PANEL_EDGE_GAP)
  return {
    x: position.x < 0 ? maxX : Math.min(maxX, Math.max(PANEL_EDGE_GAP, position.x)),
    y: Math.min(maxY, Math.max(topInset, position.y))
  }
}

export function SidePanel({ pinned = false }: { pinned?: boolean }): JSX.Element | null {
  const open = useBrowserStore((state) => state.sidePanelOpen)
  const activeView = useBrowserStore((state) => state.activeSidePanel)
  const setActiveView = useBrowserStore((state) => state.setActiveSidePanel)
  const sidePanelSettings = useBrowserStore((state) => state.settings.sidePanel)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const runtime = useBrowserRuntime()
  const [width, setWidth] = useState(() => Math.max(304, Math.min(520, sidePanelSettings.width)))
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [topInset, setTopInset] = useState(measurePanelTopInset)
  const [position, setPosition] = useState(() => clampPanelPosition(
    { x: sidePanelSettings.positionX, y: sidePanelSettings.positionY },
    Math.max(304, Math.min(520, sidePanelSettings.width)),
    { width: window.innerWidth, height: window.innerHeight },
    topInset
  ))
  const [present, setPresent] = useState(open)

  useLayoutEffect(() => {
    const browserStage = document.querySelector<HTMLElement>('.browser-stage-shell')
    const updateTopInset = (): void => setTopInset(measurePanelTopInset())
    updateTopInset()
    const observer = browserStage ? new ResizeObserver(updateTopInset) : null
    if (browserStage) observer?.observe(browserStage)
    window.addEventListener('resize', updateTopInset)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateTopInset)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setPresent(true)
      return
    }
    const timer = window.setTimeout(() => setPresent(false), 260)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const nextWidth = Math.max(304, Math.min(520, sidePanelSettings.width))
    setWidth(nextWidth)
    setPosition((current) => clampPanelPosition(current, nextWidth, viewport, topInset))
  }, [sidePanelSettings.width, topInset, viewport])

  useEffect(() => {
    const onResize = (): void => {
      const nextViewport = { width: window.innerWidth, height: window.innerHeight }
      setViewport(nextViewport)
      setPosition((current) => clampPanelPosition(current, width, nextViewport, topInset))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [topInset, width])

  if (!present) return null

  const activeTitle = views.find((view) => view.id === activeView)?.title ?? 'Notes'
  const startResize = (event: ReactMouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = width
    const fixedRight = position.x + width
    const onMove = (moveEvent: MouseEvent): void => {
      const nextWidth = Math.max(304, Math.min(520, startWidth - (moveEvent.clientX - startX)))
      setWidth(nextWidth)
      if (pinned) {
        setPosition((current) => clampPanelPosition({ x: fixedRight - nextWidth, y: current.y }, nextWidth, viewport, topInset))
      }
    }
    const onUp = (): void => {
      const finalWidth = Math.max(304, Math.min(520, startWidth - (lastPointerX - startX)))
      if (pinned) {
        const finalPosition = clampPanelPosition({ x: fixedRight - finalWidth, y: position.y }, finalWidth, viewport, topInset)
        setPosition(finalPosition)
        updateSettings({ sidePanel: { width: finalWidth, positionX: finalPosition.x, positionY: finalPosition.y } })
      } else {
        updateSettings({ sidePanel: { width: finalWidth } })
      }
      window.removeEventListener('mousemove', trackMove)
      window.removeEventListener('mouseup', onUp)
    }
    let lastPointerX = startX
    const trackMove = (moveEvent: MouseEvent): void => {
      lastPointerX = moveEvent.clientX
      onMove(moveEvent)
    }
    window.addEventListener('mousemove', trackMove)
    window.addEventListener('mouseup', onUp)
  }

  const startMove = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (!pinned || event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, select, a')) return
    event.preventDefault()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startPosition = position
    let lastPosition = position
    const onMove = (moveEvent: MouseEvent): void => {
      lastPosition = clampPanelPosition(
        {
          x: startPosition.x + moveEvent.clientX - startPointer.x,
          y: startPosition.y + moveEvent.clientY - startPointer.y
        },
        width,
        viewport,
        topInset
      )
      setPosition(lastPosition)
    }
    const onUp = (): void => {
      updateSettings({ sidePanel: { positionX: lastPosition.x, positionY: lastPosition.y } })
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const panelHeight = panelHeightFor(viewport.height, topInset)
  const panelStyle: CSSProperties = pinned
    ? { position: 'absolute', width, height: panelHeight, left: position.x, top: position.y }
    : { position: 'relative', width: '100%', height: '100%' }

  return (
    <div
      className={`side-panel-slot no-drag ${pinned ? 'is-pinned' : 'is-docked'} ${open ? 'is-open' : 'is-closed'}`}
      data-pinned={pinned ? 'true' : 'false'}
      style={pinned ? undefined : { width }}
    >
    <aside
      className={`side-panel no-drag z-[60] flex min-h-0 shrink-0 flex-col overflow-hidden border border-white/[0.1] bg-[#08090d]/[0.96] backdrop-blur-2xl ${
        pinned ? 'rounded-3xl shadow-[0_18px_54px_rgba(0,0,0,0.34)]' : 'rounded-none border-b-0 border-r-0 border-t-0 shadow-none'
      }`}
      style={panelStyle}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startResize}
        className="absolute bottom-4 left-0 top-4 w-1 cursor-col-resize rounded-full bg-transparent hover:bg-vast-cyan/40"
      />
      <div
        className={`side-panel-header flex h-[72px] select-none items-center gap-3 border-b border-white/[0.08] px-4 ${pinned ? 'cursor-move' : 'cursor-default'}`}
        data-testid="sidebar-drag-handle"
        title={pinned ? 'Drag sidebar' : undefined}
        onMouseDown={pinned ? startMove : undefined}
      >
        <IconButton
          tooltip={pinned ? 'Unpin sidebar' : 'Pin sidebar over page'}
          aria-label={pinned ? 'Unpin sidebar' : 'Pin sidebar over page'}
          aria-pressed={pinned}
          active={pinned}
          className="side-panel-pin-button"
          onClick={() => updateSettings({ sidePanel: { mode: pinned ? 'docked' : 'overlay' } })}
        >
          {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        </IconButton>
        <div className="min-w-0 truncate text-left text-lg font-semibold text-white">{activeTitle}</div>
        {pinned && <GripHorizontal className="ml-auto h-4 w-4 text-white/25" aria-hidden="true" />}
      </div>
      <div role="tablist" aria-label="Sidebar sections" className="flex gap-1 border-b border-white/[0.08] p-2">
        {views.map((view) => {
          const Icon = view.icon
          return (
            <button
              key={view.id}
              type="button"
              title={view.title}
              role="tab"
              aria-selected={activeView === view.id}
              onClick={() => setActiveView(view.id)}
              className={`flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-xl px-1 transition ${
                activeView === view.id ? 'bg-white/[0.11] text-vast-cyan' : 'text-vast-soft hover:bg-white/[0.06] hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              {sidePanelSettings.showLabels && width >= 440 && <span className="truncate text-[11px] font-medium">{view.title}</span>}
            </button>
          )
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-4 pb-6">
        {activeView === 'notes' && <NotesPanel />}
        {activeView === 'bookmarks' && <BookmarksPanel />}
        {activeView === 'history' && <HistoryPanel />}
        {activeView === 'downloads' && <DownloadsPanel />}
        {activeView === 'reading-list' && <ReadingListPanel />}
      </div>
    </aside>
    </div>
  )
}

function PanelSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }): JSX.Element {
  return (
    <div className="relative mb-3">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-vast-soft" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-xl border border-white/10 bg-black/20 pl-9 pr-3 text-sm text-white outline-none placeholder:text-vast-soft focus:border-vast-cyan/[0.35]"
      />
    </div>
  )
}

function NotesPanel(): JSX.Element {
  const activeTab = useBrowserStore(selectActiveTab)
  const workspace = useBrowserStore(selectActiveWorkspace)
  const notes = useBrowserStore((state) => state.notes)
  const addNote = useBrowserStore((state) => state.addNote)
  const updateNote = useBrowserStore((state) => state.updateNote)
  const deleteNote = useBrowserStore((state) => state.deleteNote)
  const [query, setQuery] = useState('')
  const queryText = query.toLowerCase().trim()
  const workspaceNotes = notes
    .filter((note) => note.workspaceId === workspace?.id || note.url === activeTab?.url)
    .filter((note) => !queryText || `${note.title} ${note.body} ${note.url ?? ''}`.toLowerCase().includes(queryText))

  return (
    <div className="space-y-3">
      <PanelSearch value={query} onChange={setQuery} placeholder="Search notes" />
      <button
        type="button"
        onClick={() =>
          addNote({
            title: activeTab ? activeTab.title : 'New note',
            body: '',
            url: activeTab?.url,
            workspaceId: workspace?.id
          })
        }
        className="flex w-full items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white hover:bg-white/[0.09]"
      >
        <Plus className="h-4 w-4 text-vast-cyan" />
        New URL/workspace note
      </button>
      {workspaceNotes.map((note) => (
        <div key={note.id} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
          <input
            value={note.title}
            onChange={(event) => updateNote(note.id, { title: event.target.value })}
            className="w-full bg-transparent text-sm font-semibold text-white outline-none"
          />
          <textarea
            value={note.body}
            onChange={(event) => updateNote(note.id, { body: event.target.value })}
            placeholder="Write locally..."
            rows={5}
            className="mt-2 w-full resize-none rounded-xl border border-white/[0.08] bg-black/20 p-3 text-sm leading-6 text-vast-soft outline-none placeholder:text-vast-soft/60 focus:border-vast-cyan/30"
          />
          <div className="mt-2 flex items-center justify-between text-[11px] text-vast-soft">
            <span>{note.url ? 'URL note' : 'Workspace note'}</span>
            <button type="button" onClick={() => deleteNote(note.id)} className="hover:text-white">
              Delete
            </button>
          </div>
        </div>
      ))}
      {workspaceNotes.length === 0 && <EmptyPanel icon={NotebookPen} text={queryText ? 'No notes match this search.' : 'Notes you attach to this workspace or URL will appear here.'} />}
    </div>
  )
}

function BookmarksPanel(): JSX.Element {
  const runtime = useBrowserRuntime()
  const activeTab = useBrowserStore(selectActiveTab)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const folders = useBrowserStore((state) => state.bookmarkFolders)
  const createFolder = useBrowserStore((state) => state.createBookmarkFolder)
  const updateBookmark = useBrowserStore((state) => state.updateBookmark)
  const removeBookmark = useBrowserStore((state) => state.removeBookmark)
  const updateFolder = useBrowserStore((state) => state.updateBookmarkFolder)
  const deleteFolder = useBrowserStore((state) => state.deleteBookmarkFolder)
  const openPromptDialog = useBrowserStore((state) => state.openPromptDialog)
  const [query, setQuery] = useState('')
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null)
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const queryText = query.toLowerCase().trim()
  const matchesBookmark = (bookmark: (typeof bookmarks)[number]): boolean =>
    !queryText || `${bookmark.title} ${bookmark.url}`.toLowerCase().includes(queryText)
  const looseBookmarks = bookmarks.filter((bookmark) => !bookmark.folderId && matchesBookmark(bookmark))
  const openBookmark = (url: string): void => {
    if (activeTab?.url === INTERNAL_NEW_TAB_URL) runtime.navigateActive(url)
    else runtime.openUrlInNewTab(url)
  }

  return (
    <div className="space-y-4">
      <PanelSearch value={query} onChange={setQuery} placeholder="Search bookmarks" />
      <button
        type="button"
        onClick={() =>
          openPromptDialog({
            title: 'New bookmark folder',
            label: 'Folder name',
            placeholder: 'Design, Hotels, Research',
            confirmLabel: 'Create folder',
            onConfirm: (name) => createFolder(name)
          })
        }
        className="flex w-full items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white hover:bg-white/[0.09]"
      >
        <Plus className="h-4 w-4 text-vast-cyan" />
        New folder
      </button>
      {folders.map((folder) => {
        const items = bookmarks.filter((bookmark) => bookmark.folderId === folder.id && matchesBookmark(bookmark))
        if (queryText && items.length === 0 && !folder.name.toLowerCase().includes(queryText)) return null
        return (
          <section key={folder.id} className="min-w-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.025] p-2">
            <div className="mb-2 flex items-center gap-2 px-1">
              <Folder className="h-3.5 w-3.5 text-vast-cyan" />
              {editingFolderId === folder.id ? (
                <FolderNameEditor
                  folder={folder}
                  onCommit={(name) => updateFolder(folder.id, { name })}
                  onDone={() => setEditingFolderId(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingFolderId(folder.id)}
                  className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-vast-soft hover:text-white"
                >
                  {folder.name}
                </button>
              )}
              <button
                type="button"
                title="Rename folder"
                onClick={() => setEditingFolderId(folder.id)}
                className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
              >
                <Edit3 className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title="Delete folder"
                onClick={() => deleteFolder(folder.id)}
                className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="space-y-1">
              {items.map((bookmarkItem) => (
                <div key={bookmarkItem.id} className="group rounded-xl px-2 py-2 hover:bg-white/[0.06]">
                  <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openBookmark(bookmarkItem.url)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Favicon url={bookmarkItem.url} favicon={bookmarkItem.favicon} title={bookmarkItem.title} />
                    <span className="min-w-0 flex-1 truncate text-sm text-white">{bookmarkItem.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingBookmarkId((id) => (id === bookmarkItem.id ? null : bookmarkItem.id))}
                    className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeBookmark(bookmarkItem.id)}
                    className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  </div>
                  {editingBookmarkId === bookmarkItem.id && <div className="mt-2 grid min-w-0 max-w-full gap-2 overflow-hidden pl-6">
                    <input
                      value={bookmarkItem.title}
                      onChange={(event) => updateBookmark(bookmarkItem.id, { title: event.target.value })}
                      className="h-8 w-full min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-black/20 px-2 text-xs text-white outline-none focus:border-vast-cyan/30"
                    />
                    <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_minmax(5.5rem,7.5rem)] gap-2">
                      <input
                        value={bookmarkItem.url}
                        onChange={(event) => updateBookmark(bookmarkItem.id, { url: event.target.value })}
                        className="h-8 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2 text-xs text-vast-soft outline-none focus:border-vast-cyan/30"
                      />
                      <VastSelect
                        value={bookmarkItem.folderId ?? ''}
                        options={[
                          { value: '', label: 'Bar' },
                          ...folders.map((targetFolder) => ({ value: targetFolder.id, label: targetFolder.name }))
                        ]}
                        onChange={(folderId) => updateBookmark(bookmarkItem.id, { folderId: folderId || undefined })}
                        ariaLabel={`Folder for ${bookmarkItem.title || 'bookmark'}`}
                        className="w-full min-w-0 max-w-[7.5rem]"
                        buttonClassName="h-8 min-h-8 rounded-lg px-2 text-xs"
                      />
                    </div>
                  </div>}
                </div>
              ))}
            </div>
          </section>
        )
      })}
      {looseBookmarks.map((bookmarkItem) => (
        <div key={bookmarkItem.id} className="rounded-xl px-2 py-2 hover:bg-white/[0.06]">
          <div className="group flex items-center gap-2">
            <button
              type="button"
              onClick={() => openBookmark(bookmarkItem.url)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <Favicon url={bookmarkItem.url} favicon={bookmarkItem.favicon} title={bookmarkItem.title} />
              <span className="min-w-0 flex-1 truncate text-sm text-white">{bookmarkItem.title}</span>
            </button>
            <button
              type="button"
              onClick={() => setEditingBookmarkId((id) => (id === bookmarkItem.id ? null : bookmarkItem.id))}
              className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
            >
              <Edit3 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => removeBookmark(bookmarkItem.id)}
              className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {editingBookmarkId === bookmarkItem.id && <div className="mt-2 grid min-w-0 max-w-full gap-2 overflow-hidden pl-6">
            <input
              value={bookmarkItem.title}
              onChange={(event) => updateBookmark(bookmarkItem.id, { title: event.target.value })}
              className="h-8 w-full min-w-0 max-w-full rounded-lg border border-white/[0.08] bg-black/20 px-2 text-xs text-white outline-none focus:border-vast-cyan/30"
            />
            <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_minmax(5.5rem,7.5rem)] gap-2">
              <input
                value={bookmarkItem.url}
                onChange={(event) => updateBookmark(bookmarkItem.id, { url: event.target.value })}
                className="h-8 min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-black/20 px-2 text-xs text-vast-soft outline-none focus:border-vast-cyan/30"
              />
              <VastSelect
                value={bookmarkItem.folderId ?? ''}
                options={[
                  { value: '', label: 'Bar' },
                  ...folders.map((folder) => ({ value: folder.id, label: folder.name }))
                ]}
                onChange={(folderId) => updateBookmark(bookmarkItem.id, { folderId: folderId || undefined })}
                ariaLabel={`Folder for ${bookmarkItem.title || 'bookmark'}`}
                className="w-full min-w-0 max-w-[7.5rem]"
                buttonClassName="h-8 min-h-8 rounded-lg px-2 text-xs"
              />
            </div>
          </div>}
        </div>
      ))}
      {folders.length === 0 && looseBookmarks.length === 0 && (
        <EmptyPanel icon={Bookmark} text={queryText ? 'No bookmarks match this search.' : 'Bookmarks and folders will appear here.'} />
      )}
    </div>
  )
}

function FolderNameEditor({
  folder,
  onCommit,
  onDone
}: {
  folder: BookmarkFolder
  onCommit: (name: string) => void
  onDone: () => void
}): JSX.Element {
  const [draft, setDraft] = useState(folder.name)
  const cancelledRef = useRef(false)
  const finish = (): void => {
    if (cancelledRef.current) return
    const name = draft.trim()
    if (name && name !== folder.name) onCommit(name)
    onDone()
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          cancelledRef.current = true
          onDone()
        }
      }}
      className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-xs font-semibold text-white outline-none focus:border-vast-cyan/30"
    />
  )
}

function HistoryPanel(): JSX.Element {
  const runtime = useBrowserRuntime()
  const history = useBrowserStore((state) => state.history)
  const clearHistory = useBrowserStore((state) => state.clearHistory)
  const [query, setQuery] = useState('')
  const queryText = query.toLowerCase().trim()
  const filteredHistory = history.filter((entry) => !queryText || `${entry.title} ${entry.url}`.toLowerCase().includes(queryText))

  return (
    <div className="space-y-3">
      <PanelSearch value={query} onChange={setQuery} placeholder="Search history" />
      <button
        type="button"
        onClick={clearHistory}
        className="flex w-full items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-medium text-white hover:bg-white/[0.09]"
      >
        <Trash2 className="h-4 w-4 text-vast-amber" />
        Clear history
      </button>
      {filteredHistory.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => runtime.openUrlInNewTab(entry.url)}
          className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/[0.06]"
        >
          <Favicon url={entry.url} favicon={entry.favicon} title={entry.title} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-white">{entry.title}</div>
            <div className="truncate text-xs text-vast-soft">{entry.url}</div>
          </div>
          <span className="text-[11px] text-vast-soft">{formatRelativeTime(entry.lastVisitedAt)}</span>
        </button>
      ))}
      {filteredHistory.length === 0 && <EmptyPanel icon={History} text={queryText ? 'No history matches this search.' : 'Pages you visit will appear here.'} />}
    </div>
  )
}

function DownloadsPanel(): JSX.Element {
  const downloads = useBrowserStore((state) => state.downloads)
  const clearCompletedDownloads = useBrowserStore((state) => state.clearCompletedDownloads)
  const [filter, setFilter] = useState<'all' | 'active' | 'finished'>('all')
  const visibleDownloads = downloads.filter((item) => filter === 'all' || (filter === 'active' ? item.state === 'progressing' : item.state !== 'progressing'))

  const clearCompleted = async (): Promise<void> => {
    const result = await window.vast.downloads.clearCompleted()
    if (result.ok) clearCompletedDownloads()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {(['all', 'active', 'finished'] as const).map((value) => (
          <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-lg px-2.5 py-1.5 text-[13px] capitalize ${filter === value ? 'bg-white/10 text-white' : 'text-vast-soft hover:bg-white/[0.06] hover:text-white'}`}>
            {value}
          </button>
        ))}
        {downloads.some((item) => item.state === 'completed' || item.state === 'cancelled') && (
          <button type="button" onClick={() => void clearCompleted()} className="ml-auto rounded-lg px-2.5 py-1.5 text-[13px] text-vast-soft hover:bg-white/[0.06] hover:text-white">Clear completed</button>
        )}
      </div>
      {visibleDownloads.length === 0 && <EmptyPanel icon={Download} text={downloads.length === 0 ? 'Downloads will appear here.' : 'No downloads match this filter.'} />}
      {visibleDownloads.map((item) => {
        const progress = item.totalBytes > 0 ? item.receivedBytes / item.totalBytes : 0
        const remainingBytes = Math.max(0, item.totalBytes - item.receivedBytes)
        const etaSeconds = item.bytesPerSecond && item.bytesPerSecond > 0 ? Math.ceil(remainingBytes / item.bytesPerSecond) : undefined
        const scanReady = item.scanStatus && !['pending', 'scanning'].includes(item.scanStatus)
        const ScanIcon = item.scanStatus === 'clean' ? ShieldCheck : item.scanStatus === 'dangerous' || item.scanStatus === 'suspicious' ? ShieldAlert : ShieldQuestion
        return (
          <div key={item.id} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
            <div className="flex items-center gap-3">
              <Download className="h-4 w-4 text-vast-cyan" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{item.filename}</div>
                <div className="mt-1 text-xs text-vast-soft">
                  {formatBytes(item.receivedBytes)} / {formatBytes(item.totalBytes)}
                </div>
                {item.state === 'progressing' && (
                  <div className="mt-1 text-[13px] text-vast-soft">
                    {item.paused ? 'Paused' : item.bytesPerSecond ? `${formatBytes(item.bytesPerSecond)}/s${etaSeconds !== undefined ? ` · ${formatEta(etaSeconds)} left` : ''}` : 'Starting…'}
                  </div>
                )}
              </div>
              {item.state === 'completed' && <Check className="h-4 w-4 text-emerald-300" />}
            </div>
            {item.state === 'progressing' && (
              <>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                  <div className="h-full rounded-full bg-vast-cyan" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={() => void (item.paused ? window.vast.downloads.resume(item.id) : window.vast.downloads.pause(item.id))} className="vault-action-button h-8 px-2.5">
                    {item.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}{item.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button type="button" onClick={() => void window.vast.downloads.cancel(item.id)} className="vault-danger-button h-8 px-2.5"><X className="h-3.5 w-3.5" />Cancel</button>
                </div>
              </>
            )}
            {item.state !== 'progressing' && item.state !== 'completed' && (
              <button type="button" onClick={() => void window.vast.downloads.retry(item.id)} className="vault-action-button mt-3 h-8 px-2.5"><RotateCcw className="h-3.5 w-3.5" />Retry</button>
            )}
            {item.state === 'completed' && (
              <div className="mt-3 rounded-xl border border-white/[0.07] bg-black/15 p-2.5">
                <div className="flex items-center gap-2 text-[13px] text-vast-soft"><ScanIcon className="h-4 w-4" /><span>{downloadScanLabel(item.scanStatus)}</span></div>
                {item.scanFindings?.slice(0, 3).map((finding) => <div key={finding} className="mt-1 text-[12px] leading-5 text-vast-soft">{finding}</div>)}
              </div>
            )}
            {item.savePath && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!scanReady}
                  onClick={() => void window.vast.downloads.openFile(item.savePath!)}
                  className="rounded-lg bg-white/[0.08] px-2 py-1 text-xs text-white hover:bg-white/[0.12]"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => void window.vast.downloads.showInFolder(item.savePath!)}
                  className="rounded-lg bg-white/[0.08] px-2 py-1 text-xs text-white hover:bg-white/[0.12]"
                >
                  Show
                </button>
                <button type="button" onClick={() => void navigator.clipboard.writeText(item.url)} className="rounded-lg bg-white/[0.08] px-2 py-1 text-xs text-white hover:bg-white/[0.12]"><Copy className="mr-1 inline h-3.5 w-3.5" />Copy link</button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function downloadScanLabel(status: import('../../../shared/types').DownloadItem['scanStatus']): string {
  if (status === 'clean') return 'Security scan passed'
  if (status === 'scanning' || status === 'pending' || !status) return 'Security scan in progress'
  if (status === 'dangerous') return 'Security scan marked this file as dangerous'
  if (status === 'suspicious') return 'Security scan found suspicious characteristics'
  if (status === 'scan-unavailable') return 'Operating-system scanner unavailable'
  return 'Security scan failed'
}

function ReadingListPanel(): JSX.Element {
  const runtime = useBrowserRuntime()
  const readingList = useBrowserStore((state) => state.readingList)
  const update = useBrowserStore((state) => state.updateReadingListItem)
  const remove = useBrowserStore((state) => state.removeReadingListItem)

  return (
    <div className="space-y-2">
      {readingList.length === 0 && <EmptyPanel icon={ListChecks} text="Saved pages will appear here." />}
      {readingList.map((item) => (
        <div key={item.id} className="group flex items-center gap-2 rounded-xl px-2 py-2 hover:bg-white/[0.06]">
          <button type="button" onClick={() => runtime.openUrlInNewTab(item.url)} className="min-w-0 flex-1 text-left">
            <div className={`truncate text-sm ${item.read ? 'text-vast-soft line-through' : 'text-white'}`}>{item.title}</div>
            <div className="truncate text-xs text-vast-soft">{item.url}</div>
          </button>
          <button
            type="button"
            onClick={() => update(item.id, { read: !item.read })}
            className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => remove(item.id)}
            className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function EmptyPanel({ icon: Icon, text }: { icon: typeof Clock3; text: string }): JSX.Element {
  return (
    <div className="grid place-items-center rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-vast-soft">
      <Icon className="mb-3 h-5 w-5 text-white/[0.35]" />
      {text}
    </div>
  )
}
