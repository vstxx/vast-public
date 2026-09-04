import type { BrowserWindow } from 'electron/main'
import { app, dialog } from 'electron/main'
import { join } from 'node:path'
import { assertPositiveInteger, fail, ok, type IpcHandle, type SenderWindowFor } from './registration'
import { pdfCapturesForGuest, pdfResourceInfo, pdfResourcePath, pdfViewerUrlForResource, readPdfResourceRange, registerLocalPdfResource, sanitizePdfFilename, savePdfResource } from '../pdf-resources'

type ResolveGuest = (host: Electron.WebContents, id: number) => Electron.WebContents
type Notify = (window: BrowserWindow, notification: {
  tone: 'error'
  title: string
  message: string
  detail: string
}) => void

function assertResourceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid PDF resource id.')
}

export function registerPdfIpc(
  handle: IpcHandle,
  senderWindowFor: SenderWindowFor,
  resolveGuest: ResolveGuest,
  notify: Notify
): void {
  handle('vast:browser:print-web-contents', async (event, webContentsId: number) => {
    try {
      assertPositiveInteger(webContentsId, 'webContents id')
      const owner = senderWindowFor(event)
      const target = resolveGuest(event.sender, webContentsId)
      await (await import('./pdf-implementation')).printPage(target, owner)
      return ok()
    } catch (error) {
      notify(senderWindowFor(event), {
        tone: 'error', title: 'Print failed', message: 'Vast could not open the print dialog for this page.',
        detail: error instanceof Error ? error.message : String(error)
      })
      return fail(error)
    }
  })

  handle('vast:pdf:info', async (event, id: string) => {
    try {
      assertResourceId(id)
      return { ok: true, resource: pdfResourceInfo(event.sender.id, id) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:pdf:open-local-file', async (event, path: string) => {
    let owner: BrowserWindow | undefined
    try {
      owner = senderWindowFor(event)
      const resource = await registerLocalPdfResource(owner.webContents.id, path)
      return { ok: true, viewerUrl: pdfViewerUrlForResource(resource) }
    } catch (error) {
      if (owner) {
        notify(owner, {
          tone: 'error', title: 'PDF could not be opened', message: 'Vast could not open this local PDF.',
          detail: error instanceof Error ? error.message : String(error)
        })
      }
      return fail(error)
    }
  })

  handle('vast:pdf:captures', async (event, guestWebContentsId: number) => {
    try {
      assertPositiveInteger(guestWebContentsId, 'webContents id')
      resolveGuest(event.sender, guestWebContentsId)
      return { ok: true, captures: pdfCapturesForGuest(event.sender.id, guestWebContentsId) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:pdf:read-range', async (event, id: string, begin: number, end: number) => {
    try {
      assertResourceId(id)
      return { ok: true, data: await readPdfResourceRange(event.sender.id, id, begin, end) }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:pdf:save', async (event, id: string, filename?: string) => {
    try {
      assertResourceId(id)
      const owner = senderWindowFor(event)
      const suggested = sanitizePdfFilename(filename ?? pdfResourceInfo(event.sender.id, id).filename)
      const selection = await dialog.showSaveDialog(owner, {
        title: 'Save PDF',
        defaultPath: join(app.getPath('downloads'), suggested),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }]
      })
      if (selection.canceled || !selection.filePath) return { ok: true, canceled: true }
      await savePdfResource(owner, id, selection.filePath)
      return { ok: true, canceled: false }
    } catch (error) {
      notify(senderWindowFor(event), {
        tone: 'error', title: 'PDF save failed', message: 'Vast could not save this PDF.',
        detail: error instanceof Error ? error.message : String(error)
      })
      return fail(error)
    }
  })

  handle('vast:pdf:open-external-fallback', async (event, id: string) => {
    try {
      assertResourceId(id)
      await (await import('./pdf-implementation')).openPdfExternal(pdfResourcePath(event.sender.id, id))
      return ok()
    } catch (error) {
      notify(senderWindowFor(event), {
        tone: 'error', title: 'External PDF fallback failed', message: 'Vast could not open this PDF in the system viewer.',
        detail: error instanceof Error ? error.message : String(error)
      })
      return fail(error)
    }
  })

  handle('vast:pdf:print', async (event, id: string) => {
    try {
      assertResourceId(id)
      const owner = senderWindowFor(event)
      await (await import('./pdf-implementation')).printPdf(pdfResourcePath(event.sender.id, id), owner)
      return ok()
    } catch (error) {
      notify(senderWindowFor(event), {
        tone: 'error', title: 'PDF print failed', message: 'Vast could not prepare this PDF for printing.',
        detail: error instanceof Error ? error.message : String(error)
      })
      return fail(error)
    }
  })
}
