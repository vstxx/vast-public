import { Archive, Download, FileText, Link2, Pin, Plus, Redo2, Search, Star, Tag, Trash2, Undo2 } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { formatRelativeTime } from '../../lib/format'
import { VastSelect } from '../ui/VastSelect'
import { NotificationCard } from '../ui/NotificationCard'

function parseTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12)
}

function markdownPreview(body: string): string {
  return body
    .replace(/^### (.*)$/gm, '$1')
    .replace(/^## (.*)$/gm, '$1')
    .replace(/^# (.*)$/gm, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

function renderInlineMarkdown(text: string): Array<string | JSX.Element> {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g)
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index} className="font-semibold text-white">{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded bg-white/10 px-1.5 py-0.5 text-vast-cyan">{part.slice(1, -1)}</code>
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer" className="text-vast-cyan underline decoration-vast-cyan/40 underline-offset-2">{link[1]}</a>
    return part
  })
}

function MarkdownPreview({ body }: { body: string }): JSX.Element {
  const lines = body.split(/\r?\n/)
  const blocks: JSX.Element[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index])
        index += 1
      }
      blocks.push(<pre key={`code-${index}`} className="my-3 overflow-x-auto rounded-2xl border border-white/10 bg-black/30 p-4 text-[13px] leading-6 text-vast-cyan"><code>{code.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      blocks.push(<div key={index} className={`${level === 1 ? 'mt-5 text-2xl' : level === 2 ? 'mt-4 text-xl' : 'mt-3 text-lg'} font-semibold text-white`}>{renderInlineMarkdown(heading[2])}</div>)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push(<div key={index} className="flex gap-2"><span className="text-vast-cyan">•</span><span>{renderInlineMarkdown(line.replace(/^[-*]\s+/, ''))}</span></div>)
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const number = line.match(/^\d+/)?.[0]
      blocks.push(<div key={index} className="flex gap-2"><span className="min-w-5 text-vast-cyan">{number}.</span><span>{renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</span></div>)
      continue
    }
    if (line.startsWith('> ')) {
      blocks.push(<blockquote key={index} className="my-2 border-l-2 border-vast-cyan/50 pl-3 italic text-vast-soft">{renderInlineMarkdown(line.slice(2))}</blockquote>)
      continue
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={index} className="my-4 border-white/10" />)
      continue
    }
    blocks.push(line ? <p key={index} className="min-h-6">{renderInlineMarkdown(line)}</p> : <div key={index} className="h-3" />)
  }
  return <div className="text-sm leading-7 text-vast-soft">{blocks.length > 0 ? blocks : 'Preview appears as you write.'}</div>
}

interface NoteRevisionHistory {
  past: string[]
  future: string[]
}

export function NotesPage(): JSX.Element {
  const notes = useBrowserStore((state) => state.notes)
  const updateNote = useBrowserStore((state) => state.updateNote)
  const addNote = useBrowserStore((state) => state.addNote)
  const deleteNote = useBrowserStore((state) => state.deleteNote)
  const restoreNote = useBrowserStore((state) => state.restoreNote)
  const activeTab = useBrowserStore(selectActiveTab)
  const workspace = useBrowserStore(selectActiveWorkspace)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [selectedId, setSelectedId] = useState(notes.find((note) => !note.archived)?.id ?? notes[0]?.id ?? '')
  const [revisionHistory, setRevisionHistory] = useState<Record<string, NoteRevisionHistory>>({})
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')
  const [lastDeleted, setLastDeleted] = useState<(typeof notes)[number] | null>(null)
  const editBurstTimers = useRef<Record<string, number>>({})
  const saveStatusTimer = useRef<number | undefined>(undefined)
  const deferredQuery = useDeferredValue(query)
  const allTags = useMemo(() => Array.from(new Set(notes.flatMap((note) => note.tags ?? []))).sort(), [notes])
  const scopedNotes = useMemo(() => {
    return notes
      .filter((note) => (showArchived ? true : !note.archived))
      .filter((note) => !tagFilter || note.tags?.includes(tagFilter))
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
  }, [notes, showArchived, tagFilter])
  const filtered = useMemo(() => {
    const needle = deferredQuery.toLowerCase().trim()
    return scopedNotes
      .filter((note) => !needle || `${note.title} ${note.body} ${(note.tags ?? []).join(' ')} ${note.url ?? ''}`.toLowerCase().includes(needle))
  }, [deferredQuery, scopedNotes])
  const selected = notes.find((note) => note.id === selectedId) ?? filtered[0]

  useEffect(() => () => {
    Object.values(editBurstTimers.current).forEach((timer) => window.clearTimeout(timer))
    window.clearTimeout(saveStatusTimer.current)
  }, [])

  const markSaving = (): void => {
    setSaveStatus('saving')
    window.clearTimeout(saveStatusTimer.current)
    saveStatusTimer.current = window.setTimeout(() => setSaveStatus('saved'), 900)
  }

  const updateBody = (value: string): void => {
    if (!selected) return
    if (!editBurstTimers.current[selected.id]) {
      setRevisionHistory((current) => ({
        ...current,
        [selected.id]: {
          past: [...(current[selected.id]?.past ?? []), selected.body].slice(-40),
          future: []
        }
      }))
    }
    window.clearTimeout(editBurstTimers.current[selected.id])
    editBurstTimers.current[selected.id] = window.setTimeout(() => { delete editBurstTimers.current[selected.id] }, 750)
    updateNote(selected.id, { body: value })
    markSaving()
  }

  const undoBody = (): void => {
    if (!selected) return
    const history = revisionHistory[selected.id]
    const previous = history?.past.at(-1)
    if (previous === undefined) return
    setRevisionHistory((current) => ({ ...current, [selected.id]: { past: history.past.slice(0, -1), future: [selected.body, ...history.future].slice(0, 40) } }))
    updateNote(selected.id, { body: previous })
    markSaving()
  }

  const redoBody = (): void => {
    if (!selected) return
    const history = revisionHistory[selected.id]
    const next = history?.future[0]
    if (next === undefined) return
    setRevisionHistory((current) => ({ ...current, [selected.id]: { past: [...history.past, selected.body].slice(-40), future: history.future.slice(1) } }))
    updateNote(selected.id, { body: next })
    markSaving()
  }

  const removeSelected = (): void => {
    if (!selected) return
    setLastDeleted(selected)
    deleteNote(selected.id)
    setSelectedId(notes.find((note) => note.id !== selected.id && !note.archived)?.id ?? '')
  }

  const createNote = (linked = false): void => {
    const note = addNote({
      title: linked && activeTab ? `Note for ${activeTab.title}` : 'Untitled note',
      body: '',
      url: linked && activeTab && !activeTab.url.startsWith('vast://') ? activeTab.url : undefined,
      workspaceId: workspace?.id
    })
    updateNote(note.id, { tags: linked ? ['page'] : [], pinned: false, archived: false, favorite: false })
    setSelectedId(note.id)
  }

  const createLinkedNote = (): void => createNote(true)

  const updateAdvancedNote = (patch: Parameters<typeof updateNote>[1]): void => {
    if (!selected) return
    updateNote(selected.id, patch)
  }

  return (
    <div className="labs-page-surface h-full min-h-0 overflow-y-auto overflow-x-hidden bg-[#06070a] p-6 text-white" data-testid="notes-page">
      <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[370px_minmax(0,1fr)]">
        <section className="vast-glass-panel rounded-[30px] p-5">
          <div className="mb-5 flex items-start justify-between gap-3">
            <h1 className="text-3xl font-semibold">Local notebook</h1>
            <button type="button" onClick={() => createNote(false)} className="grid h-11 w-11 place-items-center rounded-2xl bg-vast-cyan text-black" title="Create note">
              <Plus className="h-5 w-5" />
            </button>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes, pages, tags" className="h-11 w-full rounded-2xl border border-white/10 bg-black/20 pl-10 pr-3 text-sm text-white outline-none focus:border-vast-cyan/[0.35]" data-testid="notes-search-input" />
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setShowArchived((value) => !value)} className={`rounded-full border px-3 py-1.5 text-xs ${showArchived ? 'border-vast-cyan/[0.35] text-vast-cyan' : 'border-white/10 text-vast-soft'}`}>Archived</button>
            {allTags.slice(0, 8).map((tag) => (
              <button key={tag} type="button" onClick={() => setTagFilter((value) => (value === tag ? '' : tag))} className={`rounded-full border px-3 py-1.5 text-xs ${tagFilter === tag ? 'border-vast-cyan/[0.35] text-vast-cyan' : 'border-white/10 text-vast-soft'}`}>#{tag}</button>
            ))}
          </div>
          <div className="space-y-2">
            {filtered.map((note) => (
              <button key={note.id} type="button" onClick={() => setSelectedId(note.id)} className={`w-full rounded-2xl p-3 text-left transition ${selected?.id === note.id ? 'bg-white/[0.1]' : 'hover:bg-white/[0.055]'}`}>
                <div className="flex items-center gap-2">
                  {note.pinned && <Star className="h-3.5 w-3.5 fill-current text-vast-amber" />}
                  <div className="min-w-0 flex-1 truncate text-sm font-semibold">{note.title}</div>
                  <span className="text-[11px] text-vast-soft">{formatRelativeTime(note.updatedAt)}</span>
                </div>
                <div className="mt-2 line-clamp-2 text-xs leading-5 text-vast-soft">{markdownPreview(note.body) || 'Empty note'}</div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(note.tags ?? []).slice(0, 4).map((tag) => <span key={tag} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-vast-soft">#{tag}</span>)}
                </div>
              </button>
            ))}
            {filtered.length === 0 && <div className="rounded-3xl border border-dashed border-white/10 p-8 text-center text-sm text-vast-soft">No notes match this view.</div>}
          </div>
        </section>

        <section className="vast-glass-panel min-h-[720px] rounded-[30px] p-5">
          {selected ? (
            <div className="grid h-full min-h-0 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex min-h-0 flex-col">
                <div className="mb-3 flex items-center gap-3">
                  <input value={selected.title} onChange={(event) => { updateNote(selected.id, { title: event.target.value }); markSaving() }} className="min-w-0 flex-1 bg-transparent text-4xl font-semibold text-white outline-none" data-testid="note-title-input" />
                  <span className={`shrink-0 text-[13px] ${saveStatus === 'saved' ? 'text-emerald-300' : 'text-vast-soft'}`}>{saveStatus === 'saved' ? 'Saved locally' : 'Saving…'}</span>
                </div>
                <div className="mb-3 space-y-2" data-testid="notes-action-toolbar">
                  <div className="grid grid-cols-4 gap-2" data-testid="notes-primary-actions">
                    <button type="button" onClick={undoBody} disabled={!revisionHistory[selected.id]?.past.length} className="vault-action-button min-w-0 justify-center px-2"><Undo2 className="h-4 w-4" />Undo</button>
                    <button type="button" onClick={redoBody} disabled={!revisionHistory[selected.id]?.future.length} className="vault-action-button min-w-0 justify-center px-2"><Redo2 className="h-4 w-4" />Redo</button>
                    <button type="button" onClick={() => updateAdvancedNote({ pinned: !selected.pinned })} className="vault-action-button min-w-0 justify-center px-2"><Pin className="h-4 w-4" />{selected.pinned ? 'Unpin' : 'Pin'}</button>
                    <button type="button" onClick={() => updateAdvancedNote({ favorite: !selected.favorite })} className="vault-action-button min-w-0 justify-center px-2"><Star className="h-4 w-4" />{selected.favorite ? 'Unfavorite' : 'Favorite'}</button>
                  </div>
                  <div className="grid grid-cols-3 gap-2" data-testid="notes-secondary-actions">
                    <button type="button" onClick={() => updateAdvancedNote({ archived: !selected.archived })} className="vault-action-button min-w-0 justify-center px-2"><Archive className="h-4 w-4" />{selected.archived ? 'Unarchive' : 'Archive'}</button>
                    <button type="button" onClick={() => void window.vast.notes.exportMarkdown(selected.title, selected.body)} className="vault-action-button min-w-0 justify-center" title="Export as Markdown (.md)" aria-label="Export note as Markdown"><Download className="h-4 w-4" />Export</button>
                    <button type="button" onClick={removeSelected} className="vault-danger-button min-w-0 justify-center"><Trash2 className="h-4 w-4" />Delete</button>
                  </div>
                </div>
                <textarea value={selected.body} onChange={(event) => updateBody(event.target.value)} placeholder="Write Markdown. Use # headings, **bold**, lists, quotes, links, and fenced code." className="min-h-[420px] flex-1 resize-none rounded-3xl border border-white/10 bg-black/[0.22] p-5 text-base leading-8 text-white outline-none focus:border-vast-cyan/[0.35]" data-testid="note-body-input" />
              </div>
              <aside className="space-y-4">
                <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Tag className="h-4 w-4 text-vast-cyan" />Tags</div>
                  <input value={(selected.tags ?? []).join(', ')} onChange={(event) => updateAdvancedNote({ tags: parseTags(event.target.value) })} placeholder="research, quote, school" className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white outline-none" />
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Link2 className="h-4 w-4 text-vast-cyan" />Linked page</div>
                  <input value={selected.url ?? ''} onChange={(event) => updateAdvancedNote({ url: event.target.value || undefined })} placeholder="https://..." className="h-10 w-full rounded-xl border border-white/10 bg-black/20 px-3 text-sm text-white outline-none" />
                  <button type="button" onClick={createLinkedNote} className="mt-3 w-full rounded-xl border border-white/10 bg-white/[0.06] px-3 py-2 text-sm hover:bg-white/[0.09]">New note for active page</button>
                  <label className="mt-3 block text-[13px] text-vast-soft">
                    Workspace
                    <VastSelect
                      value={selected.workspaceId ?? ''}
                      options={[
                        { value: '', label: 'All workspaces' },
                        ...workspaces.map((item) => ({ value: item.id, label: item.name }))
                      ]}
                      onChange={(workspaceId) => updateAdvancedNote({ workspaceId: workspaceId || undefined })}
                      ariaLabel="Workspace"
                      className="mt-1 w-full"
                      buttonClassName="h-10 min-h-10"
                      align="start"
                    />
                  </label>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold"><FileText className="h-4 w-4 text-vast-cyan" />Preview</div>
                  <div className="max-h-96 overflow-auto"><MarkdownPreview body={selected.body} /></div>
                </div>
                {(selected.quotes ?? []).length > 0 && (
                  <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                    <div className="mb-3 text-sm font-semibold">Captured quotes</div>
                    {(selected.quotes ?? []).map((quote) => (
                      <blockquote key={quote.id} className="mb-3 border-l-2 border-vast-cyan/50 pl-3 text-sm leading-6 text-vast-soft">
                        {quote.text}
                      </blockquote>
                    ))}
                  </div>
                )}
              </aside>
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div><FileText className="mx-auto mb-4 h-10 w-10 text-vast-cyan" /><div className="text-xl font-semibold">No notes yet</div><button type="button" onClick={() => createNote(false)} className="mt-4 rounded-2xl bg-vast-cyan px-4 py-2 text-sm font-semibold text-black">Create note</button></div>
            </div>
          )}
        </section>
      </div>
      {lastDeleted && (
        <NotificationCard role="status" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 border border-white/10 bg-[#0b0c11]/95 text-sm text-white shadow-glass">
          <span>“{lastDeleted.title}” deleted</span>
          <button type="button" className="font-semibold text-vast-cyan" onClick={() => { restoreNote(lastDeleted); setSelectedId(lastDeleted.id); setLastDeleted(null) }}>Undo</button>
          <button type="button" className="text-vast-soft" aria-label="Dismiss undo" onClick={() => setLastDeleted(null)}>×</button>
        </NotificationCard>
      )}
    </div>
  )
}
