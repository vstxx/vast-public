import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { isLikelyCallUrl } from '../../../shared/call-protection'
import type { BrowserSettings, ID, Tab } from '../../../shared/types'
import { isInternalUrl } from '../../lib/url'
import { useBrowserStore } from '../../store/browser-store'
import { isInactiveTabEligibleForRetention } from '../../store/tab-lifecycle'

interface EffectiveRamSettings {
  ramLimitMb: number
  maxAwakeWebviews: number
  hibernateAfterMs: number
}

function effectiveRamSettings(settings: BrowserSettings['advanced'], visibleCount: number): EffectiveRamSettings {
  const hardLimitMb = Math.min(32_768, Math.max(1_024, settings.ramLimitMb ?? 3_072))
  const configuredHibernate = Math.max(1, settings.hibernateAfterMinutes ?? 30)
  const estimatedShellCostMb = 896
  const estimatedAwakeWebviewCostMb = 384
  const budgetForWebviewsMb = Math.max(estimatedAwakeWebviewCostMb, hardLimitMb - estimatedShellCostMb)
  const computedMaxAwake = Math.floor(budgetForWebviewsMb / estimatedAwakeWebviewCostMb)
  return {
    ramLimitMb: hardLimitMb,
    maxAwakeWebviews: Math.max(visibleCount, Math.min(16, Math.max(1, computedMaxAwake))),
    hibernateAfterMs: configuredHibernate * 60_000
  }
}

export function useTabRetentionController({
  webviews,
  tabs,
  visibleIds,
  hibernateInactiveTabs,
  ramSettings
}: {
  webviews: MutableRefObject<Map<ID, Electron.WebviewTag>>
  tabs: Tab[]
  visibleIds: ID[]
  hibernateInactiveTabs: boolean
  ramSettings: BrowserSettings['advanced']
}): {
  webTabs: Tab[]
  setMediaActive: (tabId: ID, active: boolean) => void
  callProtectedTabIds: Set<ID>
} {
  const updateTabLifecycles = useBrowserStore((state) => state.updateTabLifecycles)
  const setKeepAwakeTabIds = useBrowserStore((state) => state.setKeepAwakeTabIds)
  const [ramClock, setRamClock] = useState(() => Date.now())
  const [actualWorkingSetMb, setActualWorkingSetMb] = useState(0)
  const [mediaActiveTabIds, setMediaActiveTabIds] = useState<Set<ID>>(() => new Set())
  const [captureActiveWebContentsIds, setCaptureActiveWebContentsIds] = useState<Set<number>>(() => new Set())
  const visibleIdSet = useMemo(() => new Set(visibleIds), [visibleIds])
  const effectiveRam = useMemo(() => effectiveRamSettings(ramSettings, visibleIds.length), [ramSettings, visibleIds.length])

  useEffect(() => {
    if (!hibernateInactiveTabs) return undefined
    const interval = window.setInterval(() => setRamClock(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [hibernateInactiveTabs])

  useEffect(() => {
    if (!hibernateInactiveTabs) return undefined
    let cancelled = false
    const updateMetrics = (): void => {
      void window.vast.app.processMetrics().then((metrics) => {
        if (!cancelled) setActualWorkingSetMb(metrics.totalWorkingSetMb)
      }).catch(() => undefined)
    }
    updateMetrics()
    const interval = window.setInterval(updateMetrics, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [hibernateInactiveTabs])

  const setMediaActive = useCallback((tabId: ID, active: boolean): void => {
    setMediaActiveTabIds((current) => {
      if (active === current.has(tabId)) return current
      const next = new Set(current)
      if (active) next.add(tabId)
      else next.delete(tabId)
      return next
    })
  }, [])

  useEffect(
    () => window.vast.browser.onMediaCaptureState((state) => {
      setCaptureActiveWebContentsIds((current) => {
        if (state.active === current.has(state.webContentsId)) return current
        const next = new Set(current)
        if (state.active) next.add(state.webContentsId)
        else next.delete(state.webContentsId)
        return next
      })
    }),
    []
  )

  const captureActiveTabIds = useMemo(() => {
    const protectedIds = new Set<ID>()
    for (const [tabId, webview] of webviews.current) {
      try {
        if (captureActiveWebContentsIds.has(webview.getWebContentsId())) protectedIds.add(tabId)
      } catch {
        // A guest can disappear while capture state is being reconciled.
      }
    }
    return protectedIds
  }, [captureActiveWebContentsIds, tabs, webviews])

  const callProtectedTabIds = useMemo(() => {
    const protectedIds = new Set<ID>()
    for (const tab of tabs) {
      if (
        tab.status !== 'error' &&
        (mediaActiveTabIds.has(tab.id) || captureActiveTabIds.has(tab.id) || (tab.lifecycle !== 'discarded' && isLikelyCallUrl(tab.url)))
      ) protectedIds.add(tab.id)
    }
    return protectedIds
  }, [captureActiveTabIds, mediaActiveTabIds, tabs])

  useEffect(() => {
    setKeepAwakeTabIds([...callProtectedTabIds])
    for (const [tabId, webview] of webviews.current) {
      try {
        void window.vast.browser.setKeepAwake(webview.getWebContentsId(), callProtectedTabIds.has(tabId))
      } catch {
        // A guest can be destroyed between protection reconciliation and IPC.
      }
    }
  }, [callProtectedTabIds, setKeepAwakeTabIds, webviews])

  useEffect(() => () => {
    setKeepAwakeTabIds([])
    for (const webview of webviews.current.values()) {
      try {
        void window.vast.browser.setKeepAwake(webview.getWebContentsId(), false)
      } catch {
        // The webview may already have been detached while BrowserStage unmounts.
      }
    }
  }, [setKeepAwakeTabIds, webviews])

  const retainedWebTabIds = useMemo(() => {
    const webCandidates = tabs.filter((tab) => !isInternalUrl(tab.url))
    if (!hibernateInactiveTabs) return new Set(webCandidates.map((tab) => tab.id))
    const callRetainedIds = webCandidates.filter((tab) => callProtectedTabIds.has(tab.id)).map((tab) => tab.id)
    const pinnedRetainedIds = ramSettings.keepPinnedTabsAwake
      ? webCandidates.filter((tab) => tab.pinned && tab.status !== 'error').map((tab) => tab.id)
      : []
    const retained = new Set<ID>([...visibleIds, ...callRetainedIds, ...pinnedRetainedIds])
    const recentCandidates = webCandidates
      .filter((tab) => !retained.has(tab.id) && isInactiveTabEligibleForRetention(tab))
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
    const prioritizedCandidates = ramSettings.keepPinnedTabsAwake
      ? [...recentCandidates.filter((tab) => tab.pinned), ...recentCandidates.filter((tab) => !tab.pinned)]
      : recentCandidates
    const memoryPressureSlots = actualWorkingSetMb > effectiveRam.ramLimitMb
      ? Math.ceil((actualWorkingSetMb - effectiveRam.ramLimitMb) / 384)
      : 0
    const actualMetricLimit = Math.max(retained.size, effectiveRam.maxAwakeWebviews - memoryPressureSlots)
    for (const tab of prioritizedCandidates) {
      if (retained.size >= actualMetricLimit) break
      if (ramClock - tab.lastAccessedAt <= effectiveRam.hibernateAfterMs) retained.add(tab.id)
    }
    return retained
  }, [actualWorkingSetMb, callProtectedTabIds, effectiveRam, hibernateInactiveTabs, ramClock, ramSettings.keepPinnedTabsAwake, tabs, visibleIds])

  const webTabs = useMemo(
    () => tabs.filter((tab) => !isInternalUrl(tab.url) && retainedWebTabIds.has(tab.id)),
    [retainedWebTabIds, tabs]
  )

  useEffect(() => {
    const updates: Array<{ id: ID; lifecycle: Tab['lifecycle'] }> = []
    for (const tab of tabs) {
      if (isInternalUrl(tab.url)) continue
      if (tab.lifecycle === 'crashed' && tab.status === 'error') continue
      let nextLifecycle: Tab['lifecycle'] = visibleIdSet.has(tab.id) || callProtectedTabIds.has(tab.id) ? 'active' : 'sleeping'
      if (hibernateInactiveTabs && !retainedWebTabIds.has(tab.id)) nextLifecycle = 'discarded'
      if (tab.lifecycle !== nextLifecycle) updates.push({ id: tab.id, lifecycle: nextLifecycle })
    }
    updateTabLifecycles(updates)
  }, [callProtectedTabIds, hibernateInactiveTabs, retainedWebTabIds, tabs, updateTabLifecycles, visibleIdSet])

  return { webTabs, setMediaActive, callProtectedTabIds }
}
