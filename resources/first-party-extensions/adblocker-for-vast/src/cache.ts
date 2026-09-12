export interface CachedList { text: string; updatedAt: number; checkedAt: number; etag?: string; lastModified?: string; error?: string }
const max = 12 * 1024 * 1024
export function validateList(text: string): void {
  if (new TextEncoder().encode(text).length > max || text.length < 100 || /\0|^\s*<(?:!doctype|html|head|body)/i.test(text) || !/^(?:\[Adblock|!|\|\|)/m.test(text) || text.split('\n').some(line => line.length > 16384)) throw new Error('Publisher did not return a valid filter list.')
}
export async function download(url: string, previous?: CachedList, signal?: AbortSignal): Promise<CachedList> {
  // Only the fixed catalog supplies URLs. The browser makes this ordinary HTTPS
  // request without a Node fetch bridge, browser credentials or redirect following.
  const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]), headers: {
    ...(previous?.etag ? { 'If-None-Match': previous.etag } : {}), ...(previous?.lastModified ? { 'If-Modified-Since': previous.lastModified } : {})
  } })
  if (response.status === 304 && previous) return { ...previous, checkedAt: Date.now(), error: undefined }
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) throw new Error('Filter download failed; previous filters remain active.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new Error('Filter list exceeds 12 MiB.'); chunks.push(value) } } finally { await reader.cancel().catch(() => undefined) }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); validateList(text)
  if (previous && text.length < previous.text.length * .25) throw new Error('Unexpectedly small list; previous filters remain active.')
  return { text, updatedAt: Date.now(), checkedAt: Date.now(), etag: response.headers.get('etag')?.slice(0, 512), lastModified: response.headers.get('last-modified')?.slice(0, 512) }
}
let database: Promise<IDBDatabase> | undefined
async function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('adblocker-for-vast', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('state')
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Local storage is unavailable.'))
  })
}
async function readKey(key: string): Promise<any> {
  const database = await db()
  return new Promise((resolve, reject) => { const request = database.transaction('state').objectStore('state').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Could not read local filters.')) })
}
async function writeKey(key: string, state: unknown): Promise<void> {
  const database = await db()
  await new Promise<void>((resolve, reject) => { const transaction = database.transaction('state', 'readwrite'); transaction.objectStore('state').put(state, key); transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error('Could not save local filters.')) })
}

export async function readState(): Promise<any> {
  const [state, total] = await Promise.all([readKey('current'), readKey('total')])
  return state ? { ...state, total: Number.isSafeInteger(total) ? total : state.total } : state
}
export const writeState = (state: unknown) => writeKey('current', state)
export const writeTotal = (total: number) => writeKey('total', total)
