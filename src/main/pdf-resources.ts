import { app, type BrowserWindow, type DownloadItem, type WebContents } from 'electron/main'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { copyFile, mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INTERNAL_PDF_VIEWER_URL } from '../shared/constants'
import { windowRegistry } from './windows/WindowRegistry'

export type PdfCaptureState = 'started' | 'progress' | 'ready' | 'failed'

export interface PdfCaptureEvent {
  id: string
  guestWebContentsId: number
  state: PdfCaptureState
  sourceUrl: string
  filename: string
  mimeType: string
  receivedBytes: number
  totalBytes: number
  error?: string
}

interface PdfResourceRecord {
  id: string
  requestId?: number
  guestWebContentsId: number
  ownerWebContentsId?: number
  sourceUrl: string
  filename: string
  mimeType: string
  expectedBytes: number
  receivedBytes: number
  path?: string
  ownsPath: boolean
  state: 'pending' | 'downloading' | 'ready' | 'failed'
  error?: string
  createdAt: number
  touchedAt: number
  lastProgressAt: number
}

const MAX_PDF_BYTES = 1024 * 1024 * 1024
const MAX_RANGE_BYTES = 2 * 1024 * 1024
const MAX_RESOURCES = 32
const DOWNLOAD_IDLE_TIMEOUT_MS = 3 * 60_000
const PENDING_TTL_MS = 2 * 60_000
const READY_TTL_MS = 45 * 60_000
const records = new Map<string, PdfResourceRecord>()
let cachePrepared = false

function cacheRoot(): string {
  return join(app.getPath('temp'), 'Vast', 'pdf-cache')
}

function prepareCache(): void {
  if (cachePrepared) return
  const root = cacheRoot()
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  cachePrepared = true
}

export function sanitizePdfFilename(input: unknown): string {
  const candidate = typeof input === 'string' ? input.trim().replace(/[\r\n\\/:*?"<>|]+/g, '_') : ''
  const filename = (candidate || 'document.pdf').slice(0, 180)
  return filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`
}

function sameUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    a.hash = ''
    b.hash = ''
    return a.toString() === b.toString()
  } catch {
    return left === right
  }
}

function removeRecord(record: PdfResourceRecord): void {
  records.delete(record.id)
  if (record.ownsPath && record.path) void rm(record.path, { force: true }).catch(() => undefined)
}

function sweep(now = Date.now()): void {
  for (const record of records.values()) {
    const ttl = record.state === 'ready' ? READY_TTL_MS : PENDING_TTL_MS
    if (record.state !== 'downloading' && now - record.touchedAt > ttl) removeRecord(record)
  }
  if (records.size <= MAX_RESOURCES) return
  const evictable = [...records.values()]
    .filter((record) => record.state !== 'downloading')
    .sort((a, b) => a.touchedAt - b.touchedAt)
  while (records.size > MAX_RESOURCES && evictable.length) removeRecord(evictable.shift()!)
}

export function registerPdfNavigationResponse(input: {
  requestId: number
  guestWebContentsId: number
  sourceUrl: string
  filename?: string
  mimeType: string
  contentLength?: number
}): void {
  sweep()
  if ([...records.values()].some((record) => record.requestId === input.requestId && record.guestWebContentsId === input.guestWebContentsId)) return
  const now = Date.now()
  const urlFilename = (() => {
    try {
      return decodeURIComponent(new URL(input.sourceUrl).pathname.split('/').filter(Boolean).pop() ?? '')
    } catch {
      return ''
    }
  })()
  const id = randomUUID()
  records.set(id, {
    id,
    requestId: input.requestId,
    guestWebContentsId: input.guestWebContentsId,
    sourceUrl: input.sourceUrl,
    filename: sanitizePdfFilename(input.filename || urlFilename),
    mimeType: input.mimeType || 'application/pdf',
    expectedBytes: input.contentLength ?? 0,
    receivedBytes: 0,
    state: 'pending',
    ownsPath: true,
    createdAt: now,
    touchedAt: now,
    lastProgressAt: 0
  })
}

async function validatePdfPath(path: string, emptyMessage: string, invalidMessage: string): Promise<number> {
  const details = await stat(path)
  if (!details.isFile() || details.size < 5) throw new Error(emptyMessage)
  if (details.size > MAX_PDF_BYTES) throw new Error("This PDF exceeds Vast's 1 GB safety limit.")
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(5)
    const result = await handle.read(header, 0, header.length, 0)
    if (result.bytesRead < 5 || header.toString('latin1') !== '%PDF-') throw new Error(invalidMessage)
  } finally {
    await handle.close()
  }
  return details.size
}

export interface RegisteredLocalPdfResource {
  id: string
  sourceUrl: string
  filename: string
}

export function pdfViewerUrlForResource(resource: RegisteredLocalPdfResource): string {
  const viewerUrl = new URL(INTERNAL_PDF_VIEWER_URL)
  viewerUrl.searchParams.set('src', resource.sourceUrl)
  viewerUrl.searchParams.set('id', resource.id)
  return viewerUrl.toString()
}

export async function registerLocalPdfResource(ownerWebContentsId: number, inputPath: string): Promise<RegisteredLocalPdfResource> {
  sweep()
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 32_768 || inputPath.includes('\0') || !isAbsolute(inputPath)) {
    throw new Error('Invalid local PDF path.')
  }
  if (extname(inputPath).toLowerCase() !== '.pdf') throw new Error('Only local PDF files can be opened in the PDF viewer.')
  const canonicalPath = await realpath(inputPath)
  if (extname(canonicalPath).toLowerCase() !== '.pdf') throw new Error('Only local PDF files can be opened in the PDF viewer.')
  const existing = [...records.values()].find((record) =>
    record.ownerWebContentsId === ownerWebContentsId && record.state === 'ready' && !record.ownsPath && record.path === canonicalPath
  )
  if (existing) {
    existing.touchedAt = Date.now()
    return { id: existing.id, sourceUrl: existing.sourceUrl, filename: existing.filename }
  }

  const size = await validatePdfPath(
    canonicalPath,
    'The selected local PDF is empty.',
    'The selected local file is not a valid PDF.'
  )
  const now = Date.now()
  const record: PdfResourceRecord = {
    id: randomUUID(),
    guestWebContentsId: 0,
    ownerWebContentsId,
    sourceUrl: pathToFileURL(canonicalPath).toString(),
    filename: sanitizePdfFilename(basename(canonicalPath)),
    mimeType: 'application/pdf',
    expectedBytes: size,
    receivedBytes: size,
    path: canonicalPath,
    ownsPath: false,
    state: 'ready',
    createdAt: now,
    touchedAt: now,
    lastProgressAt: 0
  }
  records.set(record.id, record)
  sweep()
  return { id: record.id, sourceUrl: record.sourceUrl, filename: record.filename }
}

function emit(record: PdfResourceRecord, owner: BrowserWindow, state: PdfCaptureState): void {
  if (owner.isDestroyed() || owner.webContents.isDestroyed()) return
  owner.webContents.send('vast:pdf:capture', {
    id: record.id,
    guestWebContentsId: record.guestWebContentsId,
    state,
    sourceUrl: record.sourceUrl,
    filename: record.filename,
    mimeType: record.mimeType,
    receivedBytes: record.receivedBytes,
    totalBytes: record.expectedBytes,
    error: record.error
  } satisfies PdfCaptureEvent)
}

async function verifyPdfFile(record: PdfResourceRecord): Promise<void> {
  if (!record.path) throw new Error('The captured PDF file is unavailable.')
  const size = await validatePdfPath(
    record.path,
    'The server returned an empty PDF response.',
    'The server returned HTML or another non-PDF response.'
  )
  record.receivedBytes = size
  record.expectedBytes = size
}

export function claimPdfDownload(item: DownloadItem, initiatingContents: WebContents | null | undefined): boolean {
  sweep()
  if (!initiatingContents || initiatingContents.isDestroyed()) return false
  const urls = [item.getURL(), ...item.getURLChain()]
  const record = [...records.values()]
    .filter((candidate) => candidate.state === 'pending' && candidate.guestWebContentsId === initiatingContents.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((candidate) => urls.some((url) => sameUrl(url, candidate.sourceUrl)))
  if (!record) return false

  const owner = windowRegistry.vastWindowForWebContents(initiatingContents)
  if (!owner || owner.isDestroyed()) {
    record.state = 'failed'
    record.error = 'The originating Vast window is unavailable.'
    return false
  }

  prepareCache()
  record.ownerWebContentsId = owner.webContents.id
  record.path = join(cacheRoot(), `${record.id}.pdf`)
  record.ownsPath = true
  record.filename = sanitizePdfFilename(item.getFilename() || record.filename)
  record.mimeType = item.getMimeType() || record.mimeType
  record.expectedBytes = item.getTotalBytes() || record.expectedBytes
  record.state = 'downloading'
  record.touchedAt = Date.now()
  item.setSavePath(record.path)
  emit(record, owner, 'started')

  let idleTimer: NodeJS.Timeout
  const armIdleTimeout = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      record.error = 'The PDF download stopped making progress.'
      item.cancel()
    }, DOWNLOAD_IDLE_TIMEOUT_MS)
  }
  armIdleTimeout()

  item.on('updated', () => {
    record.receivedBytes = item.getReceivedBytes()
    record.expectedBytes = item.getTotalBytes() || record.expectedBytes
    record.touchedAt = Date.now()
    armIdleTimeout()
    if (record.receivedBytes > MAX_PDF_BYTES || record.expectedBytes > MAX_PDF_BYTES) {
      record.error = "This PDF exceeds Vast's 1 GB safety limit."
      item.cancel()
      return
    }
    if (record.touchedAt - record.lastProgressAt >= 120) {
      record.lastProgressAt = record.touchedAt
      emit(record, owner, 'progress')
    }
  })

  item.once('done', (_event, state) => {
    clearTimeout(idleTimer)
    void (async () => {
      record.touchedAt = Date.now()
      if (state !== 'completed') throw new Error(record.error || 'The original PDF request did not complete.')
      await verifyPdfFile(record)
      record.state = 'ready'
      emit(record, owner, 'ready')
    })().catch((error: unknown) => {
      record.state = 'failed'
      record.error = error instanceof Error ? error.message : 'The PDF capture failed.'
      if (record.path) void rm(record.path, { force: true }).catch(() => undefined)
      record.path = undefined
      emit(record, owner, 'failed')
    })
  })
  return true
}

function ownedReadyRecord(ownerWebContentsId: number, id: string): PdfResourceRecord {
  sweep()
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid PDF resource id.')
  const record = records.get(id)
  if (!record || record.ownerWebContentsId !== ownerWebContentsId) throw new Error('PDF resource is unavailable in this window.')
  record.touchedAt = Date.now()
  if (record.state !== 'ready' || !record.path) throw new Error(record.error || 'PDF download has not completed.')
  return record
}

export function pdfResourceInfo(ownerWebContentsId: number, id: string): {
  sourceUrl: string
  filename: string
  mimeType: string
  sizeBytes: number
  state: 'downloading' | 'ready' | 'failed'
  receivedBytes: number
  totalBytes: number
  error?: string
} {
  sweep()
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid PDF resource id.')
  const record = records.get(id)
  if (!record || record.ownerWebContentsId !== ownerWebContentsId) throw new Error('PDF resource is unavailable in this window.')
  record.touchedAt = Date.now()
  return {
    sourceUrl: record.sourceUrl,
    filename: record.filename,
    mimeType: record.mimeType,
    sizeBytes: record.state === 'ready' ? record.receivedBytes : record.expectedBytes,
    state: record.state === 'ready' ? 'ready' : record.state === 'failed' ? 'failed' : 'downloading',
    receivedBytes: record.receivedBytes,
    totalBytes: record.expectedBytes,
    error: record.error
  }
}

export function pdfCapturesForGuest(ownerWebContentsId: number, guestWebContentsId: number): PdfCaptureEvent[] {
  sweep()
  return [...records.values()]
    .filter((record) => record.ownerWebContentsId === ownerWebContentsId && record.guestWebContentsId === guestWebContentsId)
    .map((record) => ({
      id: record.id,
      guestWebContentsId: record.guestWebContentsId,
      state: record.state === 'ready' ? 'ready' : record.state === 'failed' ? 'failed' : record.state === 'downloading' ? 'progress' : 'started',
      sourceUrl: record.sourceUrl,
      filename: record.filename,
      mimeType: record.mimeType,
      receivedBytes: record.receivedBytes,
      totalBytes: record.expectedBytes,
      error: record.error
    }))
}

export async function readPdfResourceRange(ownerWebContentsId: number, id: string, begin: number, end: number): Promise<Uint8Array> {
  const record = ownedReadyRecord(ownerWebContentsId, id)
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > record.receivedBytes) {
    throw new Error('Invalid PDF byte range.')
  }
  if (end - begin > MAX_RANGE_BYTES) throw new Error('PDF byte range is too large.')
  const handle = await open(record.path!, 'r')
  try {
    const output = Buffer.allocUnsafe(end - begin)
    const { bytesRead } = await handle.read(output, 0, output.length, begin)
    return output.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function pdfResourcePath(ownerWebContentsId: number, id: string): string {
  return ownedReadyRecord(ownerWebContentsId, id).path!
}

export async function savePdfResource(owner: BrowserWindow, id: string, destination: string): Promise<void> {
  const source = pdfResourcePath(owner.webContents.id, id)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
}

export function disposePdfResources(): void {
  records.clear()
  if (cachePrepared) rmSync(cacheRoot(), { recursive: true, force: true })
  cachePrepared = false
}
