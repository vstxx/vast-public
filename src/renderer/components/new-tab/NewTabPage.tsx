import { Bookmark, Check, Compass, Edit3, History, ListTodo, Plus, RotateCcw, Search, SlidersHorizontal, StickyNote, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Note, Tab } from '../../../shared/types'
import { INTERNAL_SESSION_TIMELINE_URL } from '../../../shared/constants'
import vastLogo from '../../../../assets/logos/vast.png'
import { formatRelativeTime } from '../../lib/format'
import { isSafeLoadUrl, resolveAddressInput } from '../../lib/url'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { useBrowserStore, selectActiveWorkspace } from '../../store/browser-store'
import { Favicon } from '../ui/Favicon'
import { VastSelect } from '../ui/VastSelect'

function ClockWidget({ compact = false }: { compact?: boolean }): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className={compact ? 'text-center' : ''}>
      <div className={compact ? 'text-lg font-semibold tracking-normal text-white/90' : 'text-3xl font-semibold tracking-normal text-white'}>
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div className={compact ? 'mt-0.5 text-[11px] text-vast-soft' : 'mt-1 text-xs text-vast-soft'}>
        {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
      </div>
    </div>
  )
}

function VastLogo(): JSX.Element {
  return (
    <div className="vast-logo-lockup relative mb-2 grid h-24 w-full place-items-center sm:h-28">
      <div className="vast-logo-aura" />
      <img
        src={vastLogo}
        alt="Vast"
        className="vast-logo-image absolute h-32 w-auto max-w-none select-none object-contain sm:h-36"
        draggable={false}
      />
    </div>
  )
}

export function NewTabPage({ tab }: { tab: Tab }): JSX.Element {
  const runtime = useBrowserRuntime()
  const workspace = useBrowserStore(selectActiveWorkspace)
  const quickLinks = useBrowserStore((state) => state.quickLinks)
  const moveQuickLink = useBrowserStore((state) => state.moveQuickLink)
  const updateQuickLink = useBrowserStore((state) => state.updateQuickLink)
  const removeQuickLink = useBrowserStore((state) => state.removeQuickLink)
  const addQuickLink = useBrowserStore((state) => state.addQuickLink)
  const history = useBrowserStore((state) => state.history)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const notes = useBrowserStore((state) => state.notes)
  const tabs = useBrowserStore((state) => state.tabs)
  const recentlyClosed = useBrowserStore((state) => state.recentlyClosedTabs)
  const addNote = useBrowserStore((state) => state.addNote)
  const updateNote = useBrowserStore((state) => state.updateNote)
  const deleteNote = useBrowserStore((state) => state.deleteNote)
  const todos = useBrowserStore((state) => state.todos)
  const addTodo = useBrowserStore((state) => state.addTodo)
  const updateTodo = useBrowserStore((state) => state.updateTodo)
  const removeTodo = useBrowserStore((state) => state.removeTodo)
  const accentColor = useBrowserStore((state) => state.settings.accentColor)
  const defaultSearchEngine = useBrowserStore((state) => state.settings.defaultSearchEngine)
  const newTabBehavior = useBrowserStore((state) => state.settings.newTabBehavior)
  const newTabSettings = useBrowserStore((state) => state.settings.newTab)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const setActiveWorkspace = useBrowserStore((state) => state.setActiveWorkspace)
  const sessionSnapshots = useBrowserStore((state) => state.sessionSnapshots)
  const addSessionSnapshot = useBrowserStore((state) => state.addSessionSnapshot)
  const [query, setQuery] = useState('')
  const [todoText, setTodoText] = useState('')
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [quickLinkEditor, setQuickLinkEditor] = useState<{
    id?: string
    title: string
    url: string
    color: string
  } | null>(null)

  const workspaceTabs = useMemo(() => tabs.filter((item) => item.workspaceId === tab.workspaceId), [tab.workspaceId, tabs])
  const recentPages = useMemo(() => history.filter((entry) => !entry.workspaceId || entry.workspaceId === tab.workspaceId).slice(0, 5), [history, tab.workspaceId])
  const workspaceNotes = useMemo(() => notes.filter((note) => note.workspaceId === tab.workspaceId).slice(0, 3), [notes, tab.workspaceId])
  const bookmarkPreview = useMemo(() => bookmarks.slice(0, 6), [bookmarks])
  const workspaceTodos = useMemo(() => todos.filter((todo) => !todo.workspaceId || todo.workspaceId === tab.workspaceId).slice(0, 8), [todos, tab.workspaceId])
  const workspaceSnapshots = useMemo(
    () => sessionSnapshots.filter((snapshot) => snapshot.workspaceId === tab.workspaceId).slice(0, 4),
    [sessionSnapshots, tab.workspaceId]
  )
  const minimal = newTabBehavior === 'blank'
  const searchOnly = newTabBehavior === 'search'
  const dashboardCardClass = `overflow-hidden rounded-[24px] border border-white/[0.07] bg-[#090a0e] ${newTabSettings.compactCards ? 'p-4' : 'p-5'}`

  useEffect(() => {
    const timer = window.setTimeout(() => runtime.focusAddress(), 0)
    return () => window.clearTimeout(timer)
  }, [runtime, tab.id])

  if (minimal) {
    return (
      <div className="new-tab-page min-h-full bg-vast-bg" />
    )
  }

  if (searchOnly) {
    return (
      <div className="new-tab-page new-tab-flat-search grid min-h-full place-items-center overflow-auto bg-vast-bg px-8 py-10 text-white">
        <div className="w-full max-w-4xl">
          <div className="mb-7 grid place-items-center text-center" data-testid="new-tab-identity">
            <VastLogo />
            <div className="mt-2">
              <ClockWidget compact />
            </div>
          </div>
          <SearchForm query={query} setQuery={setQuery} onSubmit={(value) => runtime.navigateActive(value)} />
          {newTabSettings.showQuickLinks && quickLinks.length > 0 && (
            <div className="mt-8">
              <QuickLinkGrid
                quickLinks={quickLinks}
                onOpen={(url) => runtime.openUrlInNewTab(url)}
                onEdit={(link) => setQuickLinkEditor({ id: link.id, title: link.title, url: link.url, color: link.color })}
                onRemove={removeQuickLink}
                onMove={moveQuickLink}
                onAdd={() => setQuickLinkEditor({ title: '', url: '', color: accentColor })}
                showAdd={false}
                compact
              />
            </div>
          )}
          {quickLinkEditor && (
            <QuickLinkModal
              editor={quickLinkEditor}
              defaultSearchEngine={defaultSearchEngine}
              onClose={() => setQuickLinkEditor(null)}
              onSave={(draft) => {
                if (draft.id) updateQuickLink(draft.id, draft)
                else addQuickLink(draft)
                setQuickLinkEditor(null)
              }}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="new-tab-page min-h-full overflow-auto bg-vast-bg px-8 py-6 text-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        <section className={`relative flex flex-col items-center justify-center overflow-hidden rounded-[34px] border border-white/[0.07] bg-[#090a0e] px-6 text-center ${newTabSettings.compactCards ? 'min-h-[310px] py-6' : 'min-h-[390px] py-8'}`}>

          <div className="absolute right-4 top-4 z-10">
            <button
              type="button"
              aria-expanded={customizeOpen}
              onClick={() => setCustomizeOpen((value) => !value)}
              className="vast-control inline-flex h-10 items-center gap-2 px-3"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Customize
            </button>
            {customizeOpen && (
              <div className="absolute right-0 top-12 w-64 rounded-2xl border border-white/10 bg-[#0b0c11]/[0.98] p-3 text-left shadow-glass">
                <div className="mb-2 text-[13px] font-semibold text-white">Dashboard sections</div>
                {([
                  ['showQuickLinks', 'Quick links'],
                  ['showRecentPages', 'Recent pages'],
                  ['showBookmarks', 'Bookmarks'],
                  ['showTodos', 'To-do'],
                  ['showNotes', 'Notes'],
                  ['showRecentlyClosed', 'Recently closed'],
                  ['showWorkspaceSummary', 'Workspace summary'],
                  ['showSessionTimeline', 'Session timeline']
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex min-h-9 items-center justify-between gap-3 text-[13px] text-vast-soft">
                    <span>{label}</span>
                    <input type="checkbox" checked={newTabSettings[key]} onChange={(event) => updateSettings({ newTab: { [key]: event.target.checked } })} />
                  </label>
                ))}
                <label className="mt-2 flex min-h-9 items-center justify-between gap-3 border-t border-white/10 pt-2 text-[13px] text-vast-soft">
                  <span>Compact cards</span>
                  <input type="checkbox" checked={newTabSettings.compactCards} onChange={(event) => updateSettings({ newTab: { compactCards: event.target.checked } })} />
                </label>
              </div>
            )}
          </div>

          <VastLogo />
          <div className="relative">
            <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-vast-soft">
              {workspace?.name ?? 'Workspace'} has {workspaceTabs.length} open tab
              {workspaceTabs.length === 1 ? '' : 's'} and {workspaceNotes.length} active note
              {workspaceNotes.length === 1 ? '' : 's'}.
            </p>
          </div>

          <div className="relative mt-5">
            <ClockWidget compact />
          </div>

          <label className="relative mt-3 flex items-center gap-2 text-[13px] text-vast-soft">
            <span>Workspace</span>
            <VastSelect
              value={workspace?.id ?? ''}
              options={workspaces.map((item) => ({ value: item.id, label: item.name }))}
              onChange={setActiveWorkspace}
              ariaLabel="Workspace"
              className="min-w-[12rem]"
              buttonClassName="h-9 min-h-9"
              align="start"
            />
          </label>

          <div className="relative mt-3 w-full max-w-2xl">
            <SearchForm query={query} setQuery={setQuery} onSubmit={(value) => runtime.navigateActive(value)} />
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[10px] text-vast-soft">
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1">Ctrl/Cmd+K</span>
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1">g / yt / w</span>
              <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-1">local-first</span>
            </div>
          </div>

          {newTabSettings.showQuickLinks && <div className="relative mt-6 w-full max-w-5xl">
            <QuickLinkGrid
              quickLinks={quickLinks}
              onOpen={(url) => runtime.openUrlInNewTab(url)}
              onEdit={(link) => setQuickLinkEditor({ id: link.id, title: link.title, url: link.url, color: link.color })}
              onRemove={removeQuickLink}
              onMove={moveQuickLink}
              onAdd={() => setQuickLinkEditor({ title: '', url: '', color: accentColor })}
              showAdd={false}
              compact={newTabSettings.compactCards}
            />
          </div>}
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {newTabSettings.showRecentPages && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <History className="h-4 w-4 text-vast-cyan" />
              Recent pages
            </div>
            <div className="space-y-2">
              {recentPages.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-6 text-sm text-vast-soft">
                  History will appear here after you visit pages.
                </div>
              ) : (
                recentPages.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    onClick={() => runtime.openUrlInNewTab(entry.url)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.07]"
                  >
                    <Favicon url={entry.url} favicon={entry.favicon} title={entry.title} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-white">{entry.title}</div>
                      <div className="truncate text-xs text-vast-soft">{entry.url}</div>
                    </div>
                    <div className="shrink-0 text-xs text-vast-soft">{formatRelativeTime(entry.lastVisitedAt)}</div>
                  </button>
                ))
              )}
            </div>
          </div>}

          {newTabSettings.showBookmarks && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <Bookmark className="h-4 w-4 text-vast-lilac" />
              Bookmarks
            </div>
            <div className="grid grid-cols-2 gap-2">
              {bookmarkPreview.map((bookmark) => (
                <button
                  type="button"
                  key={bookmark.id}
                  onClick={() => runtime.navigateActive(bookmark.url)}
                  className="flex min-w-0 items-center gap-2 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2 text-left hover:bg-white/[0.06]"
                >
                  <Favicon url={bookmark.url} favicon={bookmark.favicon} title={bookmark.title} />
                  <span className="truncate text-xs font-medium text-white">{bookmark.title}</span>
                </button>
              ))}
            </div>
          </div>}

          {newTabSettings.showTodos && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <ListTodo className="h-4 w-4 text-vast-amber" />
              To-do
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (!todoText.trim()) return
                addTodo(todoText.trim(), tab.workspaceId)
                setTodoText('')
              }}
            >
              <input
                value={todoText}
                onChange={(event) => setTodoText(event.target.value)}
                placeholder="Add a task"
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/25 px-3 py-2 text-sm outline-none placeholder:text-vast-soft focus:border-vast-cyan/40"
              />
              <button className="grid h-10 w-10 place-items-center rounded-xl bg-white/10 text-white hover:bg-white/15">
                <Plus className="h-4 w-4" />
              </button>
            </form>
            <div className="mt-3 space-y-2">
              {workspaceTodos.map((todo) => (
                <label key={todo.id} className="group flex items-center gap-2 text-sm text-vast-soft">
                  <input
                    type="checkbox"
                    checked={todo.completed}
                    onChange={(event) => updateTodo(todo.id, { completed: event.target.checked })}
                    className="accent-vast-cyan"
                  />
                  <span className={`min-w-0 flex-1 truncate ${todo.completed ? 'line-through opacity-60' : ''}`}>{todo.title}</span>
                  <button
                    type="button"
                    onClick={() => removeTodo(todo.id)}
                    className="grid h-6 w-6 place-items-center rounded-md opacity-0 hover:bg-white/10 hover:text-white group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </label>
              ))}
            </div>
          </div>}
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          {newTabSettings.showNotes && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <StickyNote className="h-4 w-4 text-vast-cyan" />
              Notes
            </div>
            <button
              type="button"
              onClick={() =>
                addNote({
                  title: 'Workspace note',
                  body: '',
                  workspaceId: tab.workspaceId
                })
              }
              className="mb-3 w-full rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-left text-sm text-white hover:bg-white/[0.09]"
            >
              New workspace note
            </button>
            <div className="space-y-2">
              {workspaceNotes.map((note) => (
                <EditableNoteCard key={note.id} note={note} onChange={updateNote} onDelete={deleteNote} />
              ))}
              {workspaceNotes.length === 0 && (
                <div className="rounded-xl border border-dashed border-white/10 bg-black/20 p-4 text-sm text-vast-soft">
                  No workspace notes yet.
                </div>
              )}
            </div>
          </div>}

          {newTabSettings.showRecentlyClosed && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <RotateCcw className="h-4 w-4 text-vast-lilac" />
              Recently closed
            </div>
            <div className="space-y-2">
              {recentlyClosed.slice(0, 5).map((closed) => (
                <button
                  key={closed.id}
                  type="button"
                  onClick={() => runtime.openUrlInNewTab(closed.url)}
                  className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-white/[0.07]"
                >
                  <Favicon url={closed.url} favicon={closed.favicon} title={closed.title} />
                  <span className="min-w-0 flex-1 truncate text-sm text-white">{closed.title}</span>
                </button>
              ))}
            </div>
          </div>}

          {newTabSettings.showWorkspaceSummary && <div className={dashboardCardClass}>
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
              <Compass className="h-4 w-4 text-vast-amber" />
              Workspace
            </div>
            <div className="space-y-3 text-sm text-vast-soft">
              <div className="flex justify-between">
                <span>Open tabs</span>
                <span className="text-white">{workspaceTabs.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Bookmarks</span>
                <span className="text-white">{bookmarks.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Local notes</span>
                <span className="text-white">{notes.length}</span>
              </div>
            </div>
          </div>}
        </section>

        {newTabSettings.showSessionTimeline && <section className={dashboardCardClass}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <History className="h-4 w-4 text-vast-cyan" />
              Session Timeline
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  addSessionSnapshot(undefined, { workspaceId: tab.workspaceId, trigger: 'manual' })
                }}
                className="rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-xs font-semibold text-white transition hover:bg-white/[0.08]"
              >
                Save snapshot
              </button>
              <button
                type="button"
                onClick={() => runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)}
                className="rounded-xl border border-white/[0.08] bg-white/[0.045] px-3 py-2 text-xs font-semibold text-vast-cyan transition hover:bg-white/[0.08]"
              >
                Open timeline
              </button>
            </div>
          </div>
          <div className="grid gap-2 lg:grid-cols-4">
            {workspaceSnapshots.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-5 text-sm text-vast-soft lg:col-span-4">
                Timeline snapshots appear here after manual saves, app restore, or workspace switches.
              </div>
            ) : (
              workspaceSnapshots.map((snapshot) => (
                <button
                  type="button"
                  key={snapshot.id}
                  onClick={() => runtime.openUrlInNewTab(INTERNAL_SESSION_TIMELINE_URL)}
                  className="rounded-2xl border border-white/[0.08] bg-black/20 p-4 text-left transition hover:bg-white/[0.06]"
                >
                  <div className="truncate text-sm font-semibold text-white">{snapshot.title}</div>
                  <div className="mt-2 text-xs text-vast-soft">
                    {snapshot.counts?.tabs ?? snapshot.tabs?.length ?? 0} tabs
                  </div>
                  <div className="mt-1 truncate text-[11px] text-vast-soft">
                    {snapshot.activeUrl ? snapshot.activeUrl.replace(/^https?:\/\//, '') : 'Workspace snapshot'}
                  </div>
                  <div className="mt-3 text-[11px] text-vast-soft">{formatRelativeTime(snapshot.createdAt)}</div>
                </button>
              ))
            )}
          </div>
        </section>}
        {quickLinkEditor && (
          <QuickLinkModal
            editor={quickLinkEditor}
            defaultSearchEngine={defaultSearchEngine}
            onClose={() => setQuickLinkEditor(null)}
            onSave={(draft) => {
              if (draft.id) updateQuickLink(draft.id, draft)
              else addQuickLink(draft)
              setQuickLinkEditor(null)
            }}
          />
        )}
      </div>
    </div>
  )
}

function EditableNoteCard({
  note,
  onChange,
  onDelete
}: {
  note: Note
  onChange: (noteId: string, patch: Partial<Note>) => void
  onDelete: (noteId: string) => void
}): JSX.Element {
  return (
    <div className="group rounded-2xl border border-white/[0.065] bg-black/25 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)] transition hover:border-white/[0.12] hover:bg-black/30">
      <div className="flex items-center gap-2">
        <input
          value={note.title}
          onChange={(event) => onChange(note.id, { title: event.target.value })}
          placeholder="Untitled note"
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-vast-soft"
        />
        <button
          type="button"
          title="Delete note"
          onClick={() => onDelete(note.id)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-vast-soft opacity-0 transition hover:bg-white/10 hover:text-white group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        value={note.body}
        onChange={(event) => onChange(note.id, { body: event.target.value })}
        placeholder="Write a note..."
        rows={3}
        className="mt-2 max-h-24 min-h-[4.5rem] w-full resize-none rounded-xl border border-white/[0.055] bg-white/[0.035] px-3 py-2 text-xs leading-5 text-vast-soft outline-none placeholder:text-vast-soft/70 focus:border-vast-cyan/30 focus:bg-white/[0.055] focus:text-white"
      />
    </div>
  )
}

function SearchForm({
  query,
  setQuery,
  onSubmit,
  autoFocus = false
}: {
  query: string
  setQuery: (value: string) => void
  onSubmit: (value: string) => void
  autoFocus?: boolean
}): JSX.Element {
  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit(query)
        setQuery('')
      }}
    >
      <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-cyan" />
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search or enter address"
        className="no-drag h-14 w-full rounded-[28px] border border-white/10 bg-white/[0.06] pl-12 pr-5 text-base font-medium text-white outline-none shadow-[0_16px_50px_rgba(0,0,0,0.22),0_0_0_1px_rgba(255,255,255,0.03)] backdrop-blur-xl transition duration-150 placeholder:text-vast-soft focus:border-vast-cyan/50 focus:bg-white/[0.085]"
      />
    </form>
  )
}

function QuickLinkGrid({
  quickLinks,
  onOpen,
  onEdit,
  onRemove,
  onMove,
  onAdd,
  showAdd = true,
  compact = false
}: {
  quickLinks: Array<{ id: string; title: string; url: string; color: string }>
  onOpen: (url: string) => void
  onEdit: (link: { id: string; title: string; url: string; color: string }) => void
  onRemove: (id: string) => void
  onMove: (sourceId: string, targetId: string) => void
  onAdd: () => void
  showAdd?: boolean
  compact?: boolean
}): JSX.Element {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {quickLinks.map((link) => (
        <div
          key={link.id}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/x-vast-quick-link', link.id)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            const sourceId = event.dataTransfer.getData('application/x-vast-quick-link')
            if (sourceId) onMove(sourceId, link.id)
          }}
          className={`group cursor-grab border border-white/[0.075] bg-white/[0.035] text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_14px_38px_rgba(0,0,0,0.14)] transition duration-150 hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-white/[0.065] active:cursor-grabbing ${compact ? 'rounded-2xl p-3' : 'rounded-[26px] p-4'}`}
        >
          <button type="button" onClick={() => onOpen(link.url)} className="w-full text-left">
            <span className={`grid place-items-center overflow-hidden rounded-xl border border-white/10 bg-black/20 ${compact ? 'h-8 w-8' : 'h-10 w-10'}`} style={{ boxShadow: `0 8px 22px color-mix(in srgb, ${link.color} 24%, transparent)` }}>
              <Favicon url={link.url} title={link.title} />
            </span>
            <div className={`${compact ? 'mt-3' : 'mt-5'} text-sm font-semibold text-white`}>{link.title}</div>
            <div className="mt-1 truncate text-[13px] text-vast-soft">{link.url.replace(/^https?:\/\//, '')}</div>
          </button>
          <div className="mt-3 flex gap-1 opacity-0 transition group-hover:opacity-100">
            <button
              type="button"
              title="Edit quick link"
              onClick={() => onEdit(link)}
              className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
            >
              <Edit3 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              title="Remove quick link"
              onClick={() => onRemove(link.id)}
              className="grid h-7 w-7 place-items-center rounded-lg text-vast-soft hover:bg-white/10 hover:text-white"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
      {showAdd && <button
        type="button"
        onClick={onAdd}
        className="grid min-h-[126px] place-items-center rounded-2xl border border-dashed border-white/[0.12] bg-white/[0.035] text-sm font-medium text-vast-soft hover:border-white/20 hover:bg-white/[0.06] hover:text-white"
      >
        <Plus className="mb-2 h-5 w-5 text-vast-cyan" />
        Add quick link
      </button>}
    </section>
  )
}

function QuickLinkModal({
  editor,
  defaultSearchEngine,
  onClose,
  onSave
}: {
  editor: { id?: string; title: string; url: string; color: string }
  defaultSearchEngine: string
  onClose: () => void
  onSave: (draft: { id?: string; title: string; url: string; color: string }) => void
}): JSX.Element {
  const [draft, setDraft] = useState(editor)
  const resolvedUrl = draft.url.trim() ? resolveAddressInput(draft.url.trim(), defaultSearchEngine) : ''
  const valid = Boolean(draft.title.trim() && resolvedUrl && isSafeLoadUrl(resolvedUrl))

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/[0.45] p-6 backdrop-blur-md">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!valid) return
          onSave({ ...draft, title: draft.title.trim(), url: resolvedUrl, color: draft.color })
        }}
        className="w-full max-w-md rounded-3xl border border-white/[0.12] bg-[#0b0c11]/[0.96] p-5 shadow-glass"
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold text-white">{draft.id ? 'Edit quick link' : 'Add quick link'}</div>
            <div className="mt-1 text-sm text-vast-soft">Saved locally on your new tab page.</div>
          </div>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl text-vast-soft hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-vast-soft">
            Title
            <input
              autoFocus
              value={draft.title}
              onChange={(event) => setDraft((value) => ({ ...value, title: event.target.value }))}
              className="h-11 rounded-xl border border-white/10 bg-black/25 px-3 text-sm font-medium normal-case tracking-normal text-white outline-none focus:border-vast-cyan/40"
            />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-vast-soft">
            URL
            <input
              value={draft.url}
              onChange={(event) => setDraft((value) => ({ ...value, url: event.target.value }))}
              placeholder="https://github.com"
              className="h-11 rounded-xl border border-white/10 bg-black/25 px-3 text-sm font-medium normal-case tracking-normal text-white outline-none placeholder:text-vast-soft focus:border-vast-cyan/40"
            />
          </label>
          <label className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2 text-sm text-vast-soft">
            Color
            <input
              type="color"
              value={draft.color}
              onChange={(event) => setDraft((value) => ({ ...value, color: event.target.value }))}
              className="h-9 w-12 rounded-lg border-0 bg-transparent"
            />
          </label>
        </div>
        {draft.url.trim() && !valid && (
          <div className="mt-3 rounded-xl border border-vast-amber/20 bg-vast-amber/10 px-3 py-2 text-xs text-vast-soft">
            Enter a safe http(s) URL or domain.
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-xl border border-white/10 bg-white/[0.045] px-4 py-2 text-sm font-medium text-vast-soft hover:bg-white/[0.08] hover:text-white">
            Cancel
          </button>
          <button disabled={!valid} className="rounded-xl bg-vast-cyan px-4 py-2 text-sm font-semibold text-black hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
            <Check className="mr-2 inline h-4 w-4" />
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
