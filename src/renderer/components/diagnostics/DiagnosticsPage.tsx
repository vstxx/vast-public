import { Activity, Copy, Database, History, Search, ShieldCheck, Trash2, Wrench } from 'lucide-react'
import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { STORAGE_SCHEMA_VERSION } from '../../../shared/constants'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatDateTime, formatRelativeTime } from '../../lib/format'
import { hostnameFor, isInternalUrl } from '../../lib/url'
import { useBrowserStore, selectActiveTab, selectActiveWorkspace } from '../../store/browser-store'
import { InternalEmptyState, InternalLoadingSkeleton, InternalMetricCard, InternalPageHero, InternalPageSection, InternalPageShell } from '../internal/InternalPage'

interface AppDiagnostics {
  appVersion: string
  platform: string
  userDataPath: string
  storagePath: string
  electron: string
  chrome: string
  node: string
  googleAuth: {
    model: string
    partition: string
    chrome: string
    electron: string
    identityProfile: string
    lastStatus: string
    logPath: string
  }
  releaseChannel: string
}

interface SiteOrigin {
  origin: string
  host: string
  visits: number
  lastSeen: number
  openTabs: number
  bookmarked: boolean
  remembered: boolean
  memoryUpdatedAt?: number
}

export function DiagnosticsPage(): JSX.Element {
  const runtime = useBrowserRuntime()
  const activeTab = useBrowserStore(selectActiveTab)
  const workspace = useBrowserStore(selectActiveWorkspace)
  const tabs = useBrowserStore((state) => state.tabs)
  const bookmarks = useBrowserStore((state) => state.bookmarks)
  const history = useBrowserStore((state) => state.history)
  const siteMemory = useBrowserStore((state) => state.siteMemory)
  const forgetSiteMemory = useBrowserStore((state) => state.forgetSiteMemory)
  const notes = useBrowserStore((state) => state.notes)
  const macros = useBrowserStore((state) => state.macros)
  const snapshots = useBrowserStore((state) => state.sessionSnapshots)
  const httpsOnlyMode = useBrowserStore((state) => state.settings.security.httpsOnlyMode)
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null)
  const [originQuery, setOriginQuery] = useState('')
  const deferredOriginQuery = useDeferredValue(originQuery)

  useEffect(() => {
    void window.vast.app.diagnostics().then((result) => {
      startTransition(() => setDiagnostics(result))
    })
  }, [])

  const indexedOrigins = useMemo(() => {
    const map = new Map<string, SiteOrigin>()

    const add = (url: string, visitedAt = Date.now(), bookmarked = false, remembered = false): void => {
      if (isInternalUrl(url)) return
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
        const existing = map.get(parsed.origin)
        map.set(parsed.origin, {
          origin: parsed.origin,
          host: parsed.hostname.replace(/^www\./, ''),
          visits: (existing?.visits ?? 0) + 1,
          lastSeen: Math.max(existing?.lastSeen ?? 0, visitedAt),
          openTabs: existing?.openTabs ?? 0,
          bookmarked: Boolean(existing?.bookmarked || bookmarked),
          remembered: Boolean(existing?.remembered || remembered),
          memoryUpdatedAt: existing?.memoryUpdatedAt
        })
      } catch {
        // Ignore invalid local data.
      }
    }

    history.forEach((entry) => add(entry.url, entry.lastVisitedAt))
    bookmarks.forEach((bookmark) => add(bookmark.url, bookmark.updatedAt, true))
    siteMemory.forEach((memory) => {
      const existing = map.get(memory.origin)
      map.set(memory.origin, {
        origin: memory.origin,
        host: memory.hostname,
        visits: Math.max(existing?.visits ?? 0, memory.visitCount),
        lastSeen: Math.max(existing?.lastSeen ?? 0, memory.lastUsedAt),
        openTabs: existing?.openTabs ?? 0,
        bookmarked: existing?.bookmarked ?? false,
        remembered: true,
        memoryUpdatedAt: memory.updatedAt
      })
    })
    tabs.forEach((tab) => {
      if (isInternalUrl(tab.url)) return
      const host = hostnameFor(tab.url)
      try {
        const origin = new URL(tab.url).origin
        const existing = map.get(origin)
        map.set(origin, {
          origin,
          host,
          visits: existing?.visits ?? 0,
          lastSeen: existing?.lastSeen ?? tab.lastAccessedAt,
          openTabs: (existing?.openTabs ?? 0) + 1,
          bookmarked: existing?.bookmarked ?? false,
          remembered: existing?.remembered ?? false,
          memoryUpdatedAt: existing?.memoryUpdatedAt
        })
      } catch {
        // Ignore invalid tab data.
      }
    })

    return Array.from(map.values()).sort((a, b) => b.lastSeen - a.lastSeen)
  }, [bookmarks, history, siteMemory, tabs])

  const origins = useMemo(() => {
    const needle = deferredOriginQuery.toLowerCase().trim()
    if (!needle) return indexedOrigins
    return indexedOrigins.filter((origin) => `${origin.host} ${origin.origin}`.toLowerCase().includes(needle))
  }, [deferredOriginQuery, indexedOrigins])

  const report = useMemo(
    () => ({
      generatedAt: new Date().toISOString(),
      app: diagnostics,
      schemaVersion: STORAGE_SCHEMA_VERSION,
      counts: {
        tabs: tabs.length,
        sleepingTabs: tabs.filter((tab) => tab.lifecycle !== 'active').length,
        bookmarks: bookmarks.length,
        history: history.length,
        notes: notes.length,
        macros: macros.length,
        snapshots: snapshots.length,
        origins: indexedOrigins.length,
        siteMemory: siteMemory.length
      },
      security: {
        nodeIntegration: false,
        contextIsolation: true,
        sandboxedWebviews: true,
        webSecurity: true,
        unsafeProtocolsBlocked: true,
        httpsOnlyMode
      },
      activeTab: activeTab
        ? {
            title: activeTab.title,
            url: activeTab.url,
            lifecycle: activeTab.lifecycle,
            status: activeTab.status,
            zoom: activeTab.zoom,
            workspace: workspace?.name,
            groupId: activeTab.groupId
          }
        : null
    }),
    [activeTab, bookmarks.length, diagnostics, history.length, httpsOnlyMode, indexedOrigins.length, macros.length, notes.length, siteMemory.length, snapshots.length, tabs, workspace?.name]
  )

  return (
    <InternalPageShell
      className="labs-page-surface bg-[#06070a] p-5 lg:p-6"
      data-testid="diagnostics-page"
    >
      <div className="mx-auto max-w-6xl space-y-5">
        <InternalPageHero
          icon={Activity}
          title="Diagnostics"
          actions={
            <div className="grid w-full grid-cols-2 gap-2 sm:w-[25rem]" data-testid="diagnostics-primary-actions">
              <button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(report, null, 2))} className="vault-action-button min-w-0 justify-center px-2">
                <Copy className="h-4 w-4" />
                Copy diagnostics
              </button>
              <button type="button" onClick={runtime.toggleDevTools} className="vault-action-button min-w-0 justify-center px-2">
                <Wrench className="h-4 w-4" />
                Tab DevTools
              </button>
            </div>
          }
        />

        <section className="grid gap-4 md:grid-cols-4">
          <InternalMetricCard icon={Activity} label="Open tabs" value={String(tabs.length)} hint={`${tabs.filter((tab) => tab.lifecycle !== 'active').length} sleeping`} />
          <InternalMetricCard icon={Database} label="Origins" value={String(indexedOrigins.length)} hint={`${bookmarks.length} bookmarked domains`} />
          <InternalMetricCard icon={Activity} label="Macros" value={String(macros.length)} hint={`${history.length} history entries`} />
          <InternalMetricCard icon={History} label="Timeline entries" value={String(snapshots.length)} hint="Session memory snapshots" />
        </section>

        <section className="grid gap-5 lg:grid-cols-2">
          <InternalPageSection title="Runtime" icon={Activity} className="min-h-[240px]">
            {diagnostics ? (
              <>
                <Info label="App version" value={diagnostics.appVersion} />
                <Info label="Platform" value={diagnostics.platform} />
                <Info label="Release" value={diagnostics.releaseChannel} />
                <Info label="Electron" value={diagnostics.electron} />
                <Info label="Chromium" value={diagnostics.chrome} />
                <Info label="Node" value={diagnostics.node} />
              </>
            ) : (
              <InternalLoadingSkeleton title="Loading runtime" lines={5} />
            )}
          </InternalPageSection>

          <InternalPageSection title="Paths" icon={Database} className="min-h-[240px]">
            {diagnostics ? (
              <>
                <Info label="User data" value={diagnostics.userDataPath} />
                <Info label="Storage" value={diagnostics.storagePath} />
                <Info label="Schema" value={String(STORAGE_SCHEMA_VERSION)} />
              </>
            ) : (
              <InternalLoadingSkeleton title="Resolving paths" lines={3} />
            )}
          </InternalPageSection>

          <InternalPageSection title="Security flags" icon={ShieldCheck}>
            <Info label="Context isolation" value="Enabled" />
            <Info label="Node in webviews" value="Disabled" />
            <Info label="Sandbox" value="Enabled" />
            <Info label="Unsafe protocols" value="Blocked" />
            <Info label="HTTPS-only mode" value={httpsOnlyMode ? 'Enabled' : 'Disabled'} />
            <Info label="Password encryption" value="OS-backed safeStorage" />
          </InternalPageSection>

          <InternalPageSection title="Google auth compatibility" icon={ShieldCheck}>
            <Info label="Model" value={diagnostics?.googleAuth.model ?? 'Loading'} />
            <Info label="Partition" value={diagnostics?.googleAuth.partition ?? 'Loading'} />
            <Info label="Identity" value={diagnostics?.googleAuth.identityProfile ?? 'Loading'} />
            <Info label="Runtime" value={diagnostics ? `Electron ${diagnostics.googleAuth.electron} / Chromium ${diagnostics.googleAuth.chrome}` : 'Loading'} />
            <Info label="Last status" value={diagnostics?.googleAuth.lastStatus ?? 'Loading'} />
            <Info label="Redacted log" value={diagnostics?.googleAuth.logPath ?? 'Loading'} />
          </InternalPageSection>

          <InternalPageSection title="Active tab" icon={Activity}>
            <Info label="URL" value={activeTab?.url ?? 'No active tab'} />
            <Info label="Lifecycle" value={activeTab?.lifecycle ?? 'n/a'} />
            <Info label="Status" value={activeTab?.status ?? 'n/a'} />
            <Info label="Zoom" value={activeTab ? `${Math.round(activeTab.zoom * 100)}%` : 'n/a'} />
            <Info label="Workspace" value={workspace?.name ?? 'n/a'} />
          </InternalPageSection>
        </section>

        <InternalPageSection
          title="Site data and origins"
          icon={Database}
          description="Built from local Vast state. Cookie and site-data clearing is handled by Electron sessions."
          action={
            <button type="button" onClick={() => void window.vast.privacy.clearSiteData()} className="vault-danger-button">
              <Trash2 className="h-4 w-4" />
              Clear all site data
            </button>
          }
        >
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-vast-soft" />
            <input
              value={originQuery}
              onChange={(event) => setOriginQuery(event.target.value)}
              placeholder="Search origins"
              className="h-11 w-full rounded-2xl border border-white/10 bg-black/20 pl-10 pr-3 text-sm text-white outline-none focus:border-vast-cyan/[0.35]"
            />
          </div>
          <div className="space-y-2">
            {origins.map((origin) => (
              <div key={origin.origin} className="flex items-center gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-3">
                <div className="grid h-11 w-11 place-items-center rounded-2xl bg-vast-cyan/10 text-vast-cyan">
                  <Database className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-white">{origin.host}</div>
                  <div className="truncate text-xs text-vast-soft">{origin.origin}</div>
                </div>
                <div className="hidden text-right text-xs text-vast-soft md:block">
                  <div>{origin.visits} visits - {origin.openTabs} tabs</div>
                  <div>{origin.lastSeen ? formatRelativeTime(origin.lastSeen) : 'local only'}</div>
                </div>
                {origin.remembered && (
                  <button
                    type="button"
                    onClick={() => forgetSiteMemory(origin.origin)}
                    className="rounded-full border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-vast-soft hover:text-white"
                  >
                    Forget memory
                  </button>
                )}
                {origin.bookmarked && <ShieldCheck className="h-4 w-4 text-vast-cyan" />}
              </div>
            ))}
            {origins.length === 0 && (
              <InternalEmptyState
                icon={Database}
                title="No origins match"
                description="Open a few sites or clear the search to review locally known origins and recent site activity."
              />
            )}
          </div>
        </InternalPageSection>

        <InternalPageSection
          title="Recent timeline captures"
          icon={History}
          description="The latest workspace snapshots captured by manual saves, app restore, and workspace switching."
        >
          <div className="space-y-2">
            {snapshots.slice(0, 5).map((snapshot) => (
              <div key={snapshot.id} className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white">{snapshot.title}</div>
                    <div className="mt-1 text-xs text-vast-soft">
                      {snapshot.workspaceName ?? 'Workspace'} - {snapshot.counts?.tabs ?? snapshot.tabs?.length ?? 0} tabs - {formatRelativeTime(snapshot.createdAt)}
                    </div>
                  </div>
                  <div className="text-[11px] text-vast-soft" title={formatDateTime(snapshot.createdAt)}>
                    {formatDateTime(snapshot.createdAt)}
                  </div>
                </div>
              </div>
            ))}
            {snapshots.length === 0 && (
              <InternalEmptyState
                icon={History}
                title="No timeline captures yet"
                description="Open a few pages, switch workspaces, or save a manual snapshot to start building local session history."
              />
            )}
          </div>
        </InternalPageSection>
      </div>
    </InternalPageShell>
  )
}

function Info({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="mb-2 flex gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.035] px-3 py-2 text-sm">
      <span className="w-32 shrink-0 text-vast-soft">{label}</span>
      <span className="min-w-0 flex-1 break-all text-white/90">{value}</span>
    </div>
  )
}
