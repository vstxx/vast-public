import {
  cancelDownload,
  clearCompletedDownloadHistory,
  listCurrentDownloads,
  openDownloadedFile,
  pauseDownload,
  resumeDownload,
  retryDownload,
  showInFolder
} from '../downloads'
import { assertNonEmptyString, fail, ok, type IpcHandle } from './registration'

const downloadOperations = { pauseDownload, resumeDownload, cancelDownload }

export function registerDownloadsIpc(handle: IpcHandle): void {
  handle('vast:downloads:list-current', async () => listCurrentDownloads())
  handle('vast:downloads:show-in-folder', async (_event, path: string) => {
    try {
      assertNonEmptyString(path, 'path', 32_768)
      await showInFolder(path)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:downloads:open-file', async (_event, path: string) => {
    try {
      assertNonEmptyString(path, 'path', 32_768)
      await openDownloadedFile(path)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  for (const [channel, operation] of [
    ['vast:downloads:pause', 'pauseDownload'],
    ['vast:downloads:resume', 'resumeDownload'],
    ['vast:downloads:cancel', 'cancelDownload']
  ] as const) {
    handle(channel, async (_event, id: string) => {
      try {
        assertNonEmptyString(id, 'download id', 512)
        downloadOperations[operation](id)
        return ok()
      } catch (error) {
        return fail(error)
      }
    })
  }

  handle('vast:downloads:retry', async (_event, id: string) => {
    try {
      assertNonEmptyString(id, 'download id', 512)
      await retryDownload(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:downloads:clear-completed', async () => {
    try {
      await clearCompletedDownloadHistory()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })
}
