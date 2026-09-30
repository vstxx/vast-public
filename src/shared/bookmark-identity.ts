import type { Bookmark } from './types'

/** The tab star owns only its own top-level, manually-created bookmark. */
export function findOwnTabBookmark(bookmarks: readonly Bookmark[], url: string, workspaceId: string): Bookmark | undefined {
  return bookmarks.find((bookmark) =>
    bookmark.url === url && bookmark.workspaceId === workspaceId && !bookmark.folderId && !bookmark.importSource)
}
