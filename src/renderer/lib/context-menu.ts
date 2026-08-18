import { INTERNAL_NEW_TAB_URL } from '../../shared/constants'
import type { ContextMenuItem } from '../store/browser-store'
import { useBrowserStore } from '../store/browser-store'
import { displayUrl, isInternalUrl } from './url'
import type { Tab } from '../../shared/types'

function separator(id: string): ContextMenuItem {
  return { id, label: '', separator: true }
}

export function openTabContextMenu(tab: Tab, x: number, y: number): void {
  const store = useBrowserStore.getState()
  const workspaceTabs = store.tabs.filter((item) => item.workspaceId === tab.workspaceId)
  const tabIndex = workspaceTabs.findIndex((item) => item.id === tab.id)
  const closeTargetsRight = tabIndex >= 0 ? workspaceTabs.slice(tabIndex + 1).filter((item) => !item.pinned) : []
  const closeTargetsOther = workspaceTabs.filter((item) => item.id !== tab.id && !item.pinned)
  const bookmarked = store.bookmarks.some((bookmark) => bookmark.url === tab.url)
  const canBookmark = !isInternalUrl(tab.url)

  store.openContextMenu({
    x,
    y,
    title: tab.title,
    items: [
      {
        id: 'activate',
        label: 'Switch to tab',
        action: () => store.activateTab(tab.id)
      },
      {
        id: 'new-tab',
        label: 'New tab',
        shortcut: 'Ctrl/Cmd+T',
        action: () => {
          void store.createTab({ workspaceId: tab.workspaceId, groupId: tab.groupId, url: INTERNAL_NEW_TAB_URL, activate: true })
        }
      },
      {
        id: 'duplicate',
        label: 'Duplicate tab',
        action: () => store.duplicateTab(tab.id)
      },
      separator('tab-edit-separator'),
      {
        id: 'pin',
        label: tab.pinned ? 'Unpin tab' : 'Pin tab',
        action: () => store.togglePinnedTab(tab.id)
      },
      {
        id: 'bookmark',
        label: bookmarked ? 'Remove bookmark' : 'Add bookmark',
        disabled: !canBookmark,
        detail: canBookmark ? displayUrl(tab.url) : 'Internal Vast page',
        action: () => {
          const current = useBrowserStore.getState()
          const existing = current.bookmarks.find((bookmark) => bookmark.url === tab.url)
          if (existing) {
            current.removeBookmark(existing.id)
          } else {
            current.addBookmark({
              title: tab.title,
              url: tab.url,
              favicon: tab.favicon,
              workspaceId: tab.workspaceId
            })
          }
        }
      },
      {
        id: 'copy-url',
        label: 'Copy URL',
        disabled: isInternalUrl(tab.url),
        action: () => navigator.clipboard.writeText(tab.url)
      },
      separator('tab-close-separator'),
      {
        id: 'close',
        label: 'Close tab',
        shortcut: 'Ctrl/Cmd+W',
        danger: true,
        action: () => store.closeTab(tab.id)
      },
      {
        id: 'close-right',
        label: 'Close tabs to the right',
        disabled: closeTargetsRight.length === 0,
        action: () => {
          for (const target of closeTargetsRight) useBrowserStore.getState().closeTab(target.id)
        }
      },
      {
        id: 'close-other',
        label: 'Close other tabs',
        disabled: closeTargetsOther.length === 0,
        action: () => {
          useBrowserStore.getState().activateTab(tab.id)
          for (const target of closeTargetsOther) useBrowserStore.getState().closeTab(target.id)
        }
      },
      {
        id: 'reopen',
        label: 'Reopen closed tab',
        shortcut: 'Ctrl/Cmd+Shift+T',
        disabled: store.recentlyClosedTabs.length === 0,
        action: () => store.reopenClosedTab()
      }
    ]
  })
}
