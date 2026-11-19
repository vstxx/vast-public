import type { ID, UiNotificationPayload } from '../../shared/types'
import { useBrowserStore } from '../store/browser-store'
import { selectHistoryIds, type HistorySelection } from './history-deletion'

export type ToastRequest = Omit<UiNotificationPayload, 'id'> & { id?: string }

/** Shows a toast through App's notification stack from anywhere in the renderer. */
export function showToast(toast: ToastRequest): void {
  window.dispatchEvent(new CustomEvent<ToastRequest>('vast:toast', { detail: toast }))
}

async function persistNow(): Promise<void> {
  const result = await window.vast.storage.flush(useBrowserStore.getState().toPersistedData())
  if (!result.ok) throw new Error(result.error ?? 'History changes could not be saved.')
}

function entriesLabel(count: number): string {
  return count === 1 ? '1 page' : `${count} pages`
}

export type ConfirmDialog = (title: string, description?: string, confirmLabel?: string, options?: { danger?: boolean }) => Promise<boolean>

/** Asks once, then clears all history (or one workspace's) with Undo. */
export async function confirmClearAllHistory(confirm: ConfirmDialog, workspaceId?: ID): Promise<void> {
  const ok = await confirm(
    workspaceId ? 'Clear this workspace’s history?' : 'Clear all history?',
    workspaceId
      ? 'Every page visited in this workspace is removed from history.'
      : 'Every page in your history is removed, including from Vast’s automatic data backups.',
    'Clear history',
    { danger: true }
  )
  if (ok) await deleteHistory({ range: 'all', workspaceId })
}

/**
 * Deletes the selected history, saves immediately (so a crash cannot bring it
 * back) and offers Undo. Clearing all history also removes it from storage
 * backups.
 */
export async function deleteHistory(selection: HistorySelection): Promise<number> {
  const store = useBrowserStore.getState()
  const ids = selectHistoryIds(store.history, selection)
  if (ids.length === 0) return 0
  const removed = store.removeHistoryEntries(ids)
  const everything = selection.range === 'all' && !selection.ids && !selection.host && !selection.query && !selection.workspaceId
  try {
    await persistNow()
    if (everything) await window.vast.storage.scrubHistoryBackups()
  } catch (error) {
    showToast({ tone: 'error', title: 'History not saved', message: error instanceof Error ? error.message : String(error) })
    return removed.length
  }
  showToast({
    tone: 'success',
    title: 'History deleted',
    message: `Removed ${entriesLabel(removed.length)} from history.`,
    durationMs: 8_000,
    actions: [{
      label: 'Undo',
      action: () => {
        useBrowserStore.getState().restoreHistoryEntries(removed)
        void persistNow().catch(() => undefined)
      }
    }]
  })
  return removed.length
}
