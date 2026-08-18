import { Gauge, Moon, Power, Snowflake, X, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useBrowserRuntime } from '../../app/browser-runtime'
import { formatBytes, formatRelativeTime } from '../../lib/format'
import { isInternalUrl } from '../../lib/url'
import { selectActiveTab, useBrowserStore } from '../../store/browser-store'
import { isInactiveTabUnloadCandidate } from '../../store/tab-lifecycle'

export function SmartUnloadPanel(): JSX.Element | null {
  const runtime = useBrowserRuntime()
  const open = useBrowserStore((state) => state.smartUnloadOpen)
  const setOpen = useBrowserStore((state) => state.setSmartUnloadOpen)
  const tabs = useBrowserStore((state) => state.tabs)
  const activeTab = useBrowserStore(selectActiveTab)
  const hibernateInactiveTabs = useBrowserStore((state) => state.settings.hibernateInactiveTabs)
  const ramLimitMb = useBrowserStore((state) => state.settings.advanced.ramLimitMb)
  const keepPinnedTabsAwake = useBrowserStore((state) => state.settings.advanced.keepPinnedTabsAwake)
  const splitView = useBrowserStore((state) => state.splitView)
  const keepAwakeTabIds = useBrowserStore((state) => state.keepAwakeTabIds)
  const updateSettings = useBrowserStore((state) => state.updateSettings)
  const unloadInactiveTabs = useBrowserStore((state) => state.unloadInactiveTabs)
  const [lastAction, setLastAction] = useState<string | null>(null)

  const snapshot = useMemo(() => {
    const webTabs = tabs.filter((tab) => !isInternalUrl(tab.url))
    const active = webTabs.filter((tab) => tab.lifecycle === 'active')
    const sleeping = webTabs.filter((tab) => tab.lifecycle === 'sleeping')
    const discarded = webTabs.filter((tab) => tab.lifecycle === 'discarded')
    const candidates = webTabs
      .filter((tab) => isInactiveTabUnloadCandidate(tab, {
        activeTabId: activeTab?.id,
        splitTabIds: splitView.enabled
          ? [splitView.primaryTabId, splitView.secondaryTabId].filter((id): id is string => Boolean(id))
          : [],
        keepAwakeTabIds,
        keepPinnedTabsAwake,
        internal: false
      }))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, 10)
    const estimatedShellMb = 896
    const estimatedAwakeWebviewMb = 384
    const estimatedMb = estimatedShellMb + active.length * estimatedAwakeWebviewMb
    const limitMb = ramLimitMb

    return {
      webTabs,
      active,
      sleeping,
      discarded,
      protectedCount: webTabs.filter((tab) => keepAwakeTabIds.includes(tab.id)).length,
      candidates,
      estimatedMb,
      limitMb,
      pressure: Math.min(100, Math.round((estimatedMb / Math.max(1024, limitMb)) * 100))
    }
  }, [activeTab?.id, keepAwakeTabIds, keepPinnedTabsAwake, ramLimitMb, splitView, tabs])

  if (!open) return null

  const runUnload = (lifecycle: 'sleeping' | 'discarded'): void => {
    const count = unloadInactiveTabs(lifecycle)
    setLastAction(count > 0 ? `${count} inactive tab${count === 1 ? '' : 's'} moved to ${lifecycle}.` : 'Nothing to unload right now.')
  }

  return (
    <div className="smart-unload-layer fixed inset-0 z-50 pointer-events-none">
      <button type="button" aria-label="Close smart unload" className="smart-unload-backdrop pointer-events-auto absolute inset-0 cursor-default" onClick={() => setOpen(false)} />
      <aside className="smart-unload-panel pointer-events-auto absolute right-4 top-20 flex max-h-[calc(100vh-6rem)] w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[28px] border border-white/10 shadow-glass backdrop-blur-2xl">
        <header className="smart-unload-header flex items-start justify-between gap-3 border-b p-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <Gauge className="h-4 w-4 text-vast-cyan" />
              Smart unload
            </div>
            <p className="mt-1 text-xs leading-5 text-vast-soft">Controls tab memory pressure without touching the active page.</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="smart-unload-close grid h-9 w-9 place-items-center rounded-xl text-vast-soft hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto p-4">
          <div className="smart-unload-summary rounded-3xl border p-4">
            <div className="flex items-center justify-between gap-3 text-xs text-vast-soft">
              <span>Estimated active footprint</span>
              <span>{snapshot.pressure}% of hard limit</span>
            </div>
            <div className="smart-unload-track mt-2 h-2 overflow-hidden rounded-full">
              <div className="h-full rounded-full bg-vast-cyan shadow-[0_0_18px_color-mix(in_srgb,var(--vast-accent)_36%,transparent)]" style={{ width: `${snapshot.pressure}%` }} />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <Metric label="Active" value={String(snapshot.active.length)} />
              <Metric label="Sleeping" value={String(snapshot.sleeping.length)} />
              <Metric label="Discarded" value={String(snapshot.discarded.length)} />
            </div>
            <div className="mt-3 text-xs text-vast-soft">
              {formatBytes(snapshot.estimatedMb * 1024 * 1024)} estimated / {formatBytes(snapshot.limitMb * 1024 * 1024)} limit
            </div>
            {snapshot.protectedCount > 0 && (
              <div className="mt-2 text-xs text-vast-cyan">
                {snapshot.protectedCount} call or media tab{snapshot.protectedCount === 1 ? '' : 's'} protected from sleep.
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-2">
            <button type="button" onClick={() => runUnload('sleeping')} className="smart-unload-action">
              <Moon className="h-4 w-4 text-vast-cyan" />
              <span>Sleep inactive tabs</span>
            </button>
            <button type="button" onClick={() => runUnload('discarded')} className="smart-unload-action">
              <Snowflake className="h-4 w-4 text-vast-cyan" />
              <span>Deep discard inactive tabs</span>
            </button>
            <button type="button" onClick={() => updateSettings({ hibernateInactiveTabs: !hibernateInactiveTabs })} className="smart-unload-action">
              <Power className="h-4 w-4 text-vast-cyan" />
              <span>{hibernateInactiveTabs ? 'Disable' : 'Enable'} automatic hibernation</span>
            </button>
          </div>

          {lastAction && (
            <div className="mt-3 rounded-2xl border border-vast-cyan/20 bg-vast-cyan/10 px-3 py-2 text-xs text-vast-cyan">
              {lastAction}
            </div>
          )}

          <section className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-vast-soft">
              <Zap className="h-3.5 w-3.5" />
              Best unload candidates
            </div>
            <div className="space-y-2">
              {snapshot.candidates.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => runtime.switchToTab(tab.id)}
                  className="smart-unload-row flex w-full items-center gap-3 rounded-2xl border p-3 text-left"
                >
                  <div className="smart-unload-avatar grid h-9 w-9 shrink-0 place-items-center rounded-xl text-vast-cyan">
                    {tab.title.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-white">{tab.title}</div>
                    <div className="truncate text-xs text-vast-soft">{formatRelativeTime(tab.lastAccessedAt)} - {tab.lifecycle}</div>
                  </div>
                </button>
              ))}
              {snapshot.candidates.length === 0 && (
                <div className="smart-unload-empty rounded-2xl border p-4 text-sm text-vast-soft">
                  No unload candidates. Active, call/media, and protected pinned tabs stay awake.
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="smart-unload-metric rounded-2xl border px-2 py-2">
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[11px] text-vast-soft">{label}</div>
    </div>
  )
}
