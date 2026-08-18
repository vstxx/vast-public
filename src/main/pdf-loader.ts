import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export const MAX_PDF_BYTES = 100 * 1024 * 1024
export const MAX_PDF_REDIRECTS = 5

export interface LoadedPdf {
  data: Uint8Array
  mimeType?: string
  filename?: string
}

export interface LoadPdfOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  userAgent?: string
  resolveHost?: (hostname: string) => Promise<readonly string[]>
  allowLiteralLoopbackForTests?: boolean
}

const blockedAddresses = new BlockList()
const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addAddress('::1', 'ipv6')
loopbackAddresses.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
blockedAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
blockedAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
blockedAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
blockedAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
blockedAddresses.addAddress('::', 'ipv6')
blockedAddresses.addAddress('::1', 'ipv6')
blockedAddresses.addSubnet('fc00::', 7, 'ipv6')
blockedAddresses.addSubnet('fe80::', 10, 'ipv6')
blockedAddresses.addSubnet('::ffff:10.0.0.0', 104, 'ipv6')
blockedAddresses.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')
blockedAddresses.addSubnet('::ffff:169.254.0.0', 112, 'ipv6')
blockedAddresses.addSubnet('::ffff:172.16.0.0', 108, 'ipv6')
blockedAddresses.addSubnet('::ffff:192.168.0.0', 112, 'ipv6')

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function isBlockedAddress(address: string): boolean {
  const normalized = normalizedHostname(address)
  const family = isIP(normalized)
  return family === 4
    ? blockedAddresses.check(normalized, 'ipv4')
    : family === 6
      ? blockedAddresses.check(normalized, 'ipv6')
      : false
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizedHostname(address)
  const family = isIP(normalized)
  return family === 4
    ? loopbackAddresses.check(normalized, 'ipv4')
    : family === 6
      ? loopbackAddresses.check(normalized, 'ipv6')
      : false
}

async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

async function assertSafePdfUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
  allowLiteralLoopbackForTests = false
): Promise<URL> {
  try {
    const parsed = new URL(rawUrl.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only HTTP(S) PDF URLs are allowed.')
    if (parsed.username || parsed.password) throw new Error('Authenticated PDF URLs are not allowed.')
    const hostname = normalizedHostname(parsed.hostname)
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
      throw new Error('Local PDF URLs are not allowed.')
    }
    if (isBlockedAddress(hostname) && !(allowLiteralLoopbackForTests && isLoopbackAddress(hostname))) {
      throw new Error('Private PDF URLs are not allowed.')
    }
    if (isIP(hostname) === 0) {
      const addresses = await resolveHost(hostname)
      if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new Error('Private PDF URLs are not allowed.')
    }
    return parsed
  } catch {
    throw new Error('Only public HTTP(S) PDF URLs are allowed.')
  }
}

function filenameFromContentDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]).trim().replace(/[\\/:*?"<>|]+/g, '_') || undefined
    } catch {
      // Fall back to basic filename parsing.
    }
  }
  const basicMatch = header.match(/filename="?([^";]+)"?/i)
  return basicMatch?.[1]?.trim().replace(/[\\/:*?"<>|]+/g, '_') || undefined
}

function filenameFromUrl(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl)
    const segment = parsed.pathname.split('/').filter(Boolean).pop()?.trim()
    return segment ? decodeURIComponent(segment).replace(/[\\/:*?"<>|]+/g, '_') : undefined
  } catch {
    return undefined
  }
}

function assertPdfMagic(bytes: Uint8Array): void {
  if (bytes.byteLength < 4) throw new Error('Response is not a PDF.')
  const header = Buffer.from(bytes.subarray(0, 4)).toString('latin1')
  if (header !== '%PDF') throw new Error('Response is not a PDF.')
}

async function readLimitedResponseBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const parsed = Number(contentLength)
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('PDF content length is invalid.')
    if (parsed > MAX_PDF_BYTES) throw new Error('PDF is too large to load safely.')
  }

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > MAX_PDF_BYTES) throw new Error('PDF is too large to load safely.')
    return buffer
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    received += value.byteLength
    if (received > MAX_PDF_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('PDF is too large to load safely.')
    }
    chunks.push(value)
  }

  const result = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

export async function loadPdfFromUrl(rawUrl: string, options: LoadPdfOptions = {}): Promise<LoadedPdf> {
  const trimmedUrl = rawUrl.trim()
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveHost = options.resolveHost ?? defaultResolveHost
  const allowLiteralLoopbackForTests = options.allowLiteralLoopbackForTests === true
  const signal = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  let currentUrl = await assertSafePdfUrl(trimmedUrl, resolveHost, allowLiteralLoopbackForTests)
  let response: Response | undefined

  for (let hop = 0; hop <= MAX_PDF_REDIRECTS; hop += 1) {
    response = await fetchImpl(currentUrl, {
      headers: {
        Accept: 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.5',
        'User-Agent': options.userAgent ?? 'Vast'
      },
      redirect: 'manual',
      signal
    })
    if (response.status < 300 || response.status >= 400) break
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => undefined)
    if (!location) throw new Error('PDF redirect is missing a location.')
    if (hop === MAX_PDF_REDIRECTS) throw new Error('PDF redirect limit exceeded.')
    currentUrl = await assertSafePdfUrl(new URL(location, currentUrl).toString(), resolveHost, allowLiteralLoopbackForTests)
  }

  if (!response) throw new Error('PDF request failed.')
  if (!response.ok) throw new Error(`PDF request failed with status ${response.status}.`)

  const data = await readLimitedResponseBytes(response)
  assertPdfMagic(data)
  return {
    data,
    mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || undefined,
    filename: filenameFromContentDisposition(response.headers.get('content-disposition')) ?? filenameFromUrl(currentUrl.toString())
  }
}
