import type { BrowserWindow } from 'electron/main'
import { assertNonEmptyString, assertPositiveInteger, fail, ok, type IpcHandle, type SenderWindowFor } from './registration'

type ResolveGuest = (host: Electron.WebContents, id: number) => Electron.WebContents
type Notify = (window: BrowserWindow, notification: {
  tone: 'error'
  title: string
  message: string
  detail: string
}) => void

function assertPdfData(data: unknown): asserts data is Uint8Array {
  if (!(data instanceof Uint8Array) && !Buffer.isBuffer(data)) throw new Error('Invalid PDF data.')
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

  handle('vast:pdf:load', async (_event, url: string) => {
    try {
      assertNonEmptyString(url, 'PDF URL', 32_768)
      const pdf = await (await import('./pdf-implementation')).loadPdf(url.trim())
      return { ok: true, data: pdf.data, mimeType: pdf.mimeType, filename: pdf.filename }
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:pdf:open-external-fallback', async (_event, data: Uint8Array) => {
    try {
      assertPdfData(data)
      await (await import('./pdf-implementation')).openPdfExternal(data)
      return ok()
    } catch (error) {
      return fail(error)
    }
  })

  handle('vast:pdf:print', async (event, data: Uint8Array, filename?: string) => {
    try {
      assertPdfData(data)
      if (filename !== undefined && (typeof filename !== 'string' || filename.length > 512)) throw new Error('Invalid PDF filename.')
      const owner = senderWindowFor(event)
      await (await import('./pdf-implementation')).printPdf(data, filename, owner)
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
