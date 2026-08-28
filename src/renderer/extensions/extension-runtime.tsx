import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { VastExtensionContributionSnapshot, VastExtensionTab, VastUiBrokerRequest, VastUiBrokerResponse } from '../../shared/extension-native-api'
import { useBrowserStore } from '../store/browser-store'

const EMPTY: VastExtensionContributionSnapshot = { revision: 0, toolbar: [], sidebar: [], commands: [], contextMenus: [] }
let snapshot = EMPTY
let started = false
const listeners = new Set<() => void>()

function publish(next: VastExtensionContributionSnapshot): void { snapshot = next; for (const listener of listeners) listener() }
function start(): void {
  if (started) return
  started = true
  void window.vast.extensions.contributions().then((result) => { if (result.ok && result.contributions) publish(result.contributions) })
  window.vast.extensions.onContributionsChanged(publish)
}

export function useExtensionContributions(): VastExtensionContributionSnapshot {
  start()
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => listeners.delete(listener) }, () => snapshot, () => EMPTY)
}
export function getExtensionContributions(): VastExtensionContributionSnapshot { start(); return snapshot }

function ordinaryTabs(): VastExtensionTab[] {
  const state = useBrowserStore.getState()
  const privateIds = new Set(state.workspaces.filter((workspace) => workspace.isPrivate || workspace.identity?.sessionMode === 'ephemeral').map((workspace) => workspace.id))
  return state.tabs.filter((tab) => !privateIds.has(tab.workspaceId) && /^https?:\/\//i.test(tab.url)).map((tab) => ({
    id: tab.id, title: tab.title.slice(0, 512), url: tab.url, active: state.workspaces.some((workspace) => workspace.id === tab.workspaceId && workspace.activeTabId === tab.id), workspaceId: tab.workspaceId
  }))
}

function errorResponse(requestId: string, error: unknown): VastUiBrokerResponse {
  return { requestId, ok: false, error: error instanceof Error ? error.message.slice(0, 512) : 'Browser UI request failed.' }
}

async function execute(request: VastUiBrokerRequest): Promise<unknown> {
  const state = useBrowserStore.getState(); const tabs = ordinaryTabs(); const [first, second] = request.args
  const find = (): VastExtensionTab => { const found = tabs.find((tab) => tab.id === first); if (!found) throw new Error('Tab is unavailable.'); return found }
  if (request.operation === 'tabs.query') {
    const query = first && typeof first === 'object' ? first as Record<string, unknown> : {}
    return tabs.filter((tab) => (query.active === undefined || tab.active === query.active) && (query.workspaceId === undefined || tab.workspaceId === query.workspaceId))
  }
  if (request.operation === 'tabs.get') return tabs.find((tab) => tab.id === first)
  if (request.operation === 'tabs.create') {
    const options = first as { url: string; active?: boolean }; const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace || workspace.isPrivate || workspace.identity?.sessionMode === 'ephemeral') throw new Error('Extensions cannot create tabs in a private workspace.')
    const created = state.createTab({ url: options.url, activate: options.active !== false }); return ordinaryTabs().find((tab) => tab.id === created.id)
  }
  const target = find()
  if (request.operation === 'tabs.update') {
    const patch = second as { url?: string; active?: boolean }
    if (patch.url) state.navigateTab(target.id, patch.url)
    if (patch.active) state.activateTab(target.id)
    return ordinaryTabs().find((tab) => tab.id === target.id)
  }
  if (request.operation === 'tabs.reload') state.navigateTab(target.id, target.url)
  if (request.operation === 'tabs.close') state.closeTab(target.id)
  if (request.operation === 'tabs.activate') state.activateTab(target.id)
  return undefined
}

export function ExtensionRuntimeController(): null {
  const tabs = useBrowserStore((state) => state.tabs)
  const workspaces = useBrowserStore((state) => state.workspaces)
  const activeWorkspaceId = useBrowserStore((state) => state.activeWorkspaceId)
  const previousTabsRef = useRef(new Map<string, VastExtensionTab>())
  const previousActiveRef = useRef<string | undefined>(undefined)

  useEffect(() => window.vast.extensions.onUiRequest((request) => {
    void execute(request).then((result) => window.vast.extensions.respondToUiRequest({ requestId: request.requestId, ok: true, result })).catch((error) => window.vast.extensions.respondToUiRequest(errorResponse(request.requestId, error)))
  }), [])

  useEffect(() => {
    const current = ordinaryTabs()
    const currentMap = new Map(current.map((tab) => [tab.id, tab]))
    for (const tab of current) {
      const previous = previousTabsRef.current.get(tab.id)
      if (!previous) void window.vast.extensions.reportTabEvent('tabs.onCreated', tab)
      else if (previous.title !== tab.title || previous.url !== tab.url || previous.active !== tab.active) void window.vast.extensions.reportTabEvent('tabs.onUpdated', tab)
    }
    for (const id of previousTabsRef.current.keys()) if (!currentMap.has(id)) void window.vast.extensions.reportTabEvent('tabs.onRemoved', { id })
    const active = current.find((tab) => tab.active)
    if (active && active.id !== previousActiveRef.current) void window.vast.extensions.reportTabEvent('tabs.onActivated', active)
    previousTabsRef.current = currentMap
    previousActiveRef.current = active?.id
  }, [activeWorkspaceId, tabs, workspaces])
  return null
}
