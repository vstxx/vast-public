import { Clock3, History, Layers3, RotateCcw, Search, Sparkles, Trash2, Workflow } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { ID, SessionSnapshot, SessionSnapshotTrigger } from '../../../shared/types'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatDateTime, formatRelativeTime } from '../../lib/format'
import { displayUrl } from '../../lib/url'
import { selectActiveWorkspace, useBrowserStore } from '../../store/browser-store'
import { InternalEmptyState, InternalMetricCard, InternalPageHero, InternalPageSection, InternalPageShell } from '../internal/InternalPage'
import { Favicon } from '../ui/Favicon'

const triggerLabels: Record<SessionSnapshotTrigger, string> = {
  manual: 'Manual snapshot',
  'workspace-switch': 'Before workspace switch',
  startup: 'Restored on launch',
  restore: 'Safety snapshot before restore'
}

const triggerBadgeTone: Record<SessionSnapshotTrigger, string> = {
  manual: 'border-vast-cyan/20 bg-vast-cyan/10 text-vast-cyan',
  'workspace-switch': 'border-[#8fa1ff]/25 bg-[#8fa1ff]/10 text-[#d5dcff]',
  startup: 'border-[#89f2c1]/22 bg-[#89f2c1]/10 text-[#cffff0]',
  restore: 'border-[#f1bf72]/24 bg-[#f1bf72]/10 text-[#ffe0af]'
}

export function SessionTimelinePage(): JSX.Element {
  const runtime = useBrowserRuntime()
  const activeWorkspace = useBrowserStore(selectActiveWorkspace)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const snapshots = useBrowserStore((state) => state.sessionSnapshots)
  const addSessionSnapshot = useBrowserStore((state) => state.addSessionSnapshot)
  const restoreSessionSnapshot = useBrowserStore((state) => state.restoreSessionSnapshot)
  const removeSessionSnapshot = useBrowserStore((state) => state.removeSessionSnapshot)
  const [query, setQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState<'all' | ID>('all')
  const [triggerFilter, setTriggerFilter] = useState<'all' | SessionSnapshotTrigger>('all')
  const deferredQuery = useDeferredValue(query)

  const filteredSnapshots = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    return snapshots.filter((snapshot) => {
      const matchesWorkspace = workspaceFilter === 'all' || snapshot.workspaceId === workspaceFilter
      const matchesTrigger = triggerFilter === 'all' || snapshot.trigger === triggerFilter
      if (!matchesWorkspace || !matchesTrigger) return false
      if (!needle) return true
      const haystack = [
        snapshot.title,
        snapshot.workspaceName,
        snapshot.activeUrl,
        ...(snapshot.tabs ?? []).flatMap((tab) => [tab.title, tab.url, tab.groupName])
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [deferredQuery, snapshots, triggerFilter, workspaceFilter])

  const stats = useMemo(() => {
    const totalTabs = snapshots.reduce((sum, snapshot) => sum + (snapshot.counts?.tabs ?? snapshot.tabs?.length ?? 0), 0)
    const workspaceCount = new Set(snapshots.map((snapshot) => snapshot.workspaceId).filter(Boolean)).size
    const autoCaptured = snapshots.filter((snapshot) => snapshot.trigger && snapshot.trigger !== 'manual').length
    return {
      totalTabs,
      workspaceCount,
      autoCaptured
    }
  }, [snapshots])

  return (
    <InternalPageShell className="labs-page-surface bg-[#06070a] p-5 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <InternalPageHero
          icon={History}
          title="Chronological workspace memory"
          description="Vast now keeps a local timeline of manual snapshots, session restores, and workspace switches so you can rewind context without losing the current workspace."
          actions={
            <div className="grid w-full grid-cols-2 gap-2 sm:w-[25rem]" data-testid="timeline-primary-actions">
              <button type="button" onClick={() => addSessionSnapshot(undefined, { trigger: 'manual' })} className="vault-action-button min-w-0 justify-center px-2">
                <Sparkles className="h-4 w-4" />
                Save snapshot now
              </button>
              <button
                type="button"
                onClick={() => {
                  const latest = filteredSnapshots[0]
                  if (latest?.tabs?.[0]) restoreSessionSnapshot(latest.id)
                }}
                disabled={!filteredSnapshots[0]?.tabs?.[0]}
                className="vault-action-button min-w-0 justify-center px-2 disabled:opacity-40"
              >
                <RotateCcw className="h-4 w-4" />
                Restore latest
              </button>
            </div>
          }
        >
          <div className="flex flex-wrap gap-2 text-[11px] font-medium text-vast-soft">
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1">
              Current workspace: <span className="text-white">{activeWorkspace?.name ?? 'None'}</span>
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1">
              Auto-captures before workspace switches and restores
            </span>
          </div>
        </InternalPageHero>

        <section className="grid gap-4 md:grid-cols-4">
          <InternalMetricCard icon={History} label="Timeline entries" value={String(snapshots.length)} hint="Stored locally only" />
          <InternalMetricCard icon={Layers3} label="Captured tabs" value={String(stats.totalTabs)} hint="Across all saved sessions" />
          <InternalMetricCard icon={Workflow} label="Workspaces seen" value={String(stats.workspaceCount)} hint="Represented in timeline" />
          <InternalMetricCard icon={Clock3} label="Auto captures" value={String(stats.autoCaptured)} hint="Startup, restore, switch" />
        </section>

        <InternalPageSection
          icon={Search}
          title="Browse snapshots"
          description="Filter by workspace, trigger, or page title. Restoring a snapshot replaces the target workspace tabs and creates a safety snapshot first."
        >
          <div className="grid gap-3 border-b border-white/[0.06] pb-4">
            <div className="relative min-w-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search snapshots, pages, workspace names"
                className="h-11 w-full rounded-2xl border border-transparent bg-white/[0.035] pl-10 pr-3 text-sm text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.055)] outline-none transition focus:shadow-[inset_0_0_0_1px_rgba(116,231,255,0.32),0_0_28px_rgba(116,231,255,0.07)]"
              />
            </div>
            <div className="grid gap-2 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
              <div className="pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-vast-soft">Workspace</div>
              <div className="flex flex-wrap gap-2">
                <TimelineFilter active={workspaceFilter === 'all'} onClick={() => setWorkspaceFilter('all')}>
                  All workspaces
                </TimelineFilter>
                {workspaces.map((workspace) => (
                  <TimelineFilter key={workspace.id} active={workspaceFilter === workspace.id} onClick={() => setWorkspaceFilter(workspace.id)}>
                    {workspace.name}
                  </TimelineFilter>
                ))}
              </div>
            </div>
            <div className="grid gap-2 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start">
              <div className="pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-vast-soft">Trigger</div>
              <div className="flex flex-wrap gap-2">
                <TimelineFilter active={triggerFilter === 'all'} onClick={() => setTriggerFilter('all')}>
                  Everything
                </TimelineFilter>
                {(Object.keys(triggerLabels) as SessionSnapshotTrigger[]).map((trigger) => (
                  <TimelineFilter key={trigger} active={triggerFilter === trigger} onClick={() => setTriggerFilter(trigger)}>
                    {triggerLabels[trigger]}
                  </TimelineFilter>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {filteredSnapshots.length === 0 ? (
              <InternalEmptyState
                icon={History}
                title="No snapshots match"
                description="Save a manual snapshot or switch workspaces to start building a navigable local session history."
                action={
                  <button type="button" onClick={() => addSessionSnapshot(undefined, { trigger: 'manual' })} className="vault-action-button">
                    <Sparkles className="h-4 w-4" />
                    Create snapshot
                  </button>
                }
              />
            ) : (
              filteredSnapshots.map((snapshot) => (
                <SnapshotCard
                  key={snapshot.id}
                  snapshot={snapshot}
                  onOpenTab={(url) => runtime.openUrlInNewTab(url)}
                  onRestore={() => restoreSessionSnapshot(snapshot.id)}
                  onDelete={() => removeSessionSnapshot(snapshot.id)}
                />
              ))
            )}
          </div>
        </InternalPageSection>
      </div>
    </InternalPageShell>
  )
}

function SnapshotCard({
  snapshot,
  onOpenTab,
  onRestore,
  onDelete
}: {
  snapshot: SessionSnapshot
  onOpenTab: (url: string) => void
  onRestore: () => void
  onDelete: () => void
}): JSX.Element {
  const tabs = snapshot.tabs ?? []
  const extraTabs = Math.max(tabs.length - 6, 0)
  const trigger = snapshot.trigger ?? 'manual'

  return (
    <article className="internal-page-enter rounded-[26px] border border-white/[0.08] bg-white/[0.035] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.16)]">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${triggerBadgeTone[trigger]}`}>
              {triggerLabels[trigger]}
            </span>
            <span className="text-xs text-vast-soft" title={formatDateTime(snapshot.createdAt)}>
              {formatRelativeTime(snapshot.createdAt)} - {formatDateTime(snapshot.createdAt)}
            </span>
          </div>
          <h2 className="mt-3 text-xl font-semibold text-white">{snapshot.title}</h2>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-vast-soft">
            {snapshot.workspaceName && (
              <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1">
                Workspace: <span className="text-white">{snapshot.workspaceName}</span>
              </span>
            )}
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1">
              {snapshot.counts?.tabs ?? tabs.length} tabs
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1">
              {snapshot.counts?.pinned ?? tabs.filter((tab) => tab.pinned).length} pinned
            </span>
            <span className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1">
              {snapshot.counts?.internal ?? tabs.filter((tab) => tab.url.startsWith('vast://')).length} internal
            </span>
          </div>

          {tabs.length > 0 ? (
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {tabs.slice(0, 6).map((tab) => (
                <button
                  type="button"
                  key={`${snapshot.id}-${tab.url}-${tab.title}`}
                  onClick={() => onOpenTab(tab.url)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.06] bg-black/20 px-3 py-2 text-left transition hover:bg-white/[0.06]"
                >
                  <Favicon url={tab.url} favicon={tab.favicon} title={tab.title} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-white">{tab.title}</div>
                    <div className="truncate text-xs text-vast-soft">{displayUrl(tab.url)}</div>
                  </div>
                  {tab.pinned && <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-vast-soft">Pinned</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-4 rounded-2xl border border-dashed border-white/[0.1] bg-white/[0.025] px-4 py-3 text-sm text-vast-soft">
              Legacy snapshot without stored tab metadata. New entries are fully restorable.
            </div>
          )}

          {extraTabs > 0 && <div className="mt-3 text-xs text-vast-soft">+{extraTabs} more tab{extraTabs === 1 ? '' : 's'} in this snapshot</div>}
        </div>

        <div className="grid w-full grid-cols-2 gap-2 xl:w-44 xl:grid-cols-1">
          <button type="button" onClick={onRestore} disabled={tabs.length === 0} className="vault-action-button justify-center disabled:opacity-40">
            <RotateCcw className="h-4 w-4" />
            Restore
          </button>
          <button type="button" onClick={onDelete} className="vault-danger-button justify-center">
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </div>
      </div>
    </article>
  )
}

function TimelineFilter({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: string
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? 'border-transparent bg-vast-cyan/[0.12] text-vast-cyan shadow-[0_0_0_1px_rgba(116,231,255,0.28),0_0_20px_rgba(116,231,255,0.08)]'
          : 'border-transparent bg-white/[0.035] text-vast-soft shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] hover:bg-white/[0.07] hover:text-white hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
      }`}
    >
      {children}
    </button>
  )
}
