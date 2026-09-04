import type { BrowserTabOpenRequest, ID, Tab } from '../../shared/types'
import { setPendingInitialNavigation } from './pending-initial-navigation.ts'

interface BrowserTabModel {
  tabs: Tab[]
  createTab: (options: {
    url: string
    title: string
    workspaceId?: ID
    groupId?: ID
    activate: boolean
  }) => Tab
}

export interface BrowserTabOpenContext {
  getTabIdForWebContents: (webContentsId: number) => ID | undefined
  getTabModel: () => BrowserTabModel
  isSafeUrl: (url: string) => boolean
  routeUrl: (url: string) => string
  titleForUrl: (url: string) => string
}

export function handleBrowserTabOpenRequest(
  request: BrowserTabOpenRequest,
  context: BrowserTabOpenContext
): Tab | undefined {
  if (!context.isSafeUrl(request.url)) return undefined

  const routedUrl = context.routeUrl(request.url)
  const model = context.getTabModel()
  const sourceTabId = request.sourceWebContentsId
    ? context.getTabIdForWebContents(request.sourceWebContentsId)
    : undefined
  const sourceTab = sourceTabId ? model.tabs.find((tab) => tab.id === sourceTabId) : undefined

  const tab = model.createTab({
    url: routedUrl,
    title: context.titleForUrl(routedUrl),
    workspaceId: sourceTab?.workspaceId,
    groupId: sourceTab?.groupId,
    activate: request.activate
  })
  // Referrer and POST metadata replay the navigation Chromium would have made;
  // it lives only until the new tab's first webview load commits.
  setPendingInitialNavigation(tab.id, request.navigation)
  return tab
}
