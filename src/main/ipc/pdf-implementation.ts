import { shell } from 'electron/common'
import { BrowserWindow } from 'electron/main'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allowInternalNavigationForWebContents } from '../sessions'

const printPreviewWindows = new Set<BrowserWindow>()

function sanitizePdfFilename(input: unknown): string {
  const candidate = typeof input === 'string' ? input.trim().replace(/[\\/:*?"<>|]+/g, '_') : ''
  const filename = candidate || 'document.pdf'
  return filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWebContentsIdle(target: Electron.WebContents, timeoutMs = 8_000): Promise<void> {
  if (!target.isLoadingMainFrame()) return
  await Promise.race([
    new Promise<void>((resolve) => {
      target.once('did-stop-loading', () => resolve())
      target.once('did-fail-load', () => resolve())
    }),
    delay(timeoutMs)
  ])
}

function nativePrint(target: Electron.WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    target.print({ silent: false, printBackground: true }, (success, failureReason) => {
      if (success || failureReason === 'cancelled') resolve()
      else reject(new Error(failureReason || 'Print failed.'))
    })
  })
}

async function openPdfPrintPreview(buffer: Buffer, filename: string, parentWindow: BrowserWindow): Promise<void> {
  const tempDirectory = join(tmpdir(), `vast-print-${randomUUID()}`)
  const pdfPath = join(tempDirectory, sanitizePdfFilename(filename))
  let printWindow: BrowserWindow | undefined
  let releaseNavigationTrust: (() => void) | undefined
  await mkdir(tempDirectory, { recursive: true })
  await writeFile(pdfPath, buffer)
  try {
    printWindow = new BrowserWindow({
      parent: parentWindow.isDestroyed() ? undefined : parentWindow,
      show: true,
      width: 1080,
      height: 860,
      minWidth: 760,
      minHeight: 560,
      title: 'Vast Print Preview',
      resizable: true,
      minimizable: true,
      maximizable: true,
      fullscreenable: false,
      skipTaskbar: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: true
      }
    })
    printPreviewWindows.add(printWindow)
    printWindow.on('closed', () => {
      releaseNavigationTrust?.()
      releaseNavigationTrust = undefined
      printPreviewWindows.delete(printWindow!)
      setTimeout(() => rm(tempDirectory, { force: true, recursive: true }).catch(() => {}), 120_000)
    })
    releaseNavigationTrust = allowInternalNavigationForWebContents(printWindow.webContents)
    await printWindow.loadURL(pathToFileURL(pdfPath).toString())
    await waitForWebContentsIdle(printWindow.webContents, 15_000)
    printWindow.focus()
  } finally {
    if (!printWindow || printWindow.isDestroyed()) {
      releaseNavigationTrust?.()
      setTimeout(() => rm(tempDirectory, { force: true, recursive: true }).catch(() => {}), 120_000)
    }
  }
}

export async function openPdfExternal(path: string): Promise<void> {
  const openError = await shell.openPath(path)
  if (openError) throw new Error(openError)
}

export async function printPdf(path: string, parentWindow: BrowserWindow): Promise<void> {
  let printWindow: BrowserWindow | undefined
  let releaseNavigationTrust: (() => void) | undefined
  try {
    printWindow = new BrowserWindow({
      parent: parentWindow.isDestroyed() ? undefined : parentWindow,
      show: true,
      width: 1080,
      height: 860,
      minWidth: 760,
      minHeight: 560,
      title: 'Vast Print Preview',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        plugins: true
      }
    })
    printPreviewWindows.add(printWindow)
    printWindow.on('closed', () => {
      releaseNavigationTrust?.()
      releaseNavigationTrust = undefined
      printPreviewWindows.delete(printWindow!)
    })
    releaseNavigationTrust = allowInternalNavigationForWebContents(printWindow.webContents)
    await printWindow.loadURL(pathToFileURL(path).toString())
    await waitForWebContentsIdle(printWindow.webContents, 15_000)
    printWindow.focus()
  } catch (error) {
    releaseNavigationTrust?.()
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy()
    throw error
  }
}

export async function printPage(target: Electron.WebContents, parentWindow: BrowserWindow): Promise<void> {
  await waitForWebContentsIdle(target)
  try {
    const pdfBuffer = await target.printToPDF({
      printBackground: true,
      preferCSSPageSize: true
    })
    await openPdfPrintPreview(pdfBuffer, sanitizePdfFilename(target.getTitle() || 'page.pdf'), parentWindow)
  } catch (previewError) {
    try {
      await nativePrint(target)
    } catch (nativeError) {
      await target.executeJavaScript('window.print()', true).catch((scriptError: unknown) => {
        const previewMessage = previewError instanceof Error ? previewError.message : String(previewError)
        const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError)
        const scriptMessage = scriptError instanceof Error ? scriptError.message : String(scriptError)
        throw new Error(`Print preview failed (${previewMessage}); native print failed (${nativeMessage}); page print fallback failed (${scriptMessage}).`)
      })
    }
  }
}
