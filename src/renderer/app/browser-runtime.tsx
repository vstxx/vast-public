import { createContext, useContext } from 'react'
import type { ID } from '../../shared/types'

export interface BrowserRuntime {
  focusAddress: () => void
  getActiveWebContentsId: () => number | undefined
  navigateActive: (input: string) => void
  openUrlInNewTab: (url: string, activate?: boolean) => void
  openIncognitoWindow: () => void
  goBack: () => void
  goForward: () => void
  reload: () => void
  stop: () => void
  closeActiveTab: () => void
  duplicateActiveTab: () => void
  reopenClosedTab: () => void
  openFindUi: () => void
  adjustZoom: (direction: 1 | -1, tabId?: ID) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
  toggleMuteActive: () => void
  printActive: () => Promise<void>
  toggleDevTools: () => void
  findInPage: (query: string, options?: { forward?: boolean; findNext?: boolean }) => void
  stopFindInPage: () => void
  copyCurrentUrl: () => Promise<void>
  copyCurrentTitle: () => Promise<void>
  saveCurrentToReadingList: () => void
  addCurrentBookmark: () => void
  fillLoginForActive: () => Promise<void>
  saveLoginForActive: () => Promise<void>
  createNoteForActive: (quote?: string) => void
  runMacro: (macroId: ID, options?: { dryRun?: boolean; allowSensitive?: boolean }) => Promise<{ ok: boolean; message: string }>
  stopMacro: (macroId?: ID) => void
  toggleSplitView: () => void
  switchToTab: (tabId: ID) => void
  getActivePageText: () => Promise<string>
}

export const BrowserRuntimeContext = createContext<BrowserRuntime | null>(null)

export function useBrowserRuntime(): BrowserRuntime {
  const runtime = useContext(BrowserRuntimeContext)
  if (!runtime) throw new Error('Browser runtime is not available.')
  return runtime
}
