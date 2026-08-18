import { assertNonEmptyString, fail, ok, type IpcHandle } from './registration'

export function registerDownloadsIpc(handle: IpcHandle): void {
  handle('vast:downloads:show-in-folder', async (_event, path: string) => {
    try {
      assertNonEmptyString(path, 'path', 32_768)
      await (await import('../downloads')).showInFolder(path)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:downloads:open-file', async (_event, path: string) => {
    try {
      assertNonEmptyString(path, 'path', 32_768)
      await (await import('../downloads')).openDownloadedFile(path)
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
        const downloads = await import('../downloads')
        downloads[operation](id)
        return ok()
      } catch (error) {
        return fail(error)
      }
    })
  }

  handle('vast:downloads:retry', async (_event, id: string) => {
    try {
      assertNonEmptyString(id, 'download id', 512)
      await (await import('../downloads')).retryDownload(id)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:downloads:clear-completed', async () => {
    try {
      await (await import('../storage')).clearCompletedDownloads()
      return ok()
    } catch (error) {
      return fail(error)
    }
  })
}
