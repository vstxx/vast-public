import { createHash } from 'node:crypto'
import { DOMParser } from '@xmldom/xmldom'
import { VEXT_LIMITS } from '../../shared/vext-format.ts'
import { isChromeExtensionVersion, isNewerChromeExtensionVersion } from '../../shared/chrome-extension-version.ts'
import type { VerifiedUpstreamPackage } from './extension-managed-store.ts'
import { verifyCwsCrx3 } from './crx3-verifier.ts'

const UPDATE_ORIGIN = 'https://clients2.google.com'
const PACKAGE_HOSTS = new Set(['clients2.google.com', 'clients2.googleusercontent.com'])
const MAX_XML_BYTES = 128 * 1024
const TIMEOUT_MS = 20_000
const EXTENSION_ID = /^[a-p]{32}$/

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('Chrome Web Store response is too large.')
  if (!response.body) throw new Error('Chrome Web Store response is empty.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximum) throw new Error('Chrome Web Store response is too large.')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined) }
  if (!size) throw new Error('Chrome Web Store response is empty.')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

function elementChildren(element: Element): Element[] {
  const children: Element[] = []
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) children.push(node as Element)
    else if (node.nodeType !== 3 || node.nodeValue?.trim()) throw new Error('Chrome Web Store update XML contains unexpected content.')
  }
  return children
}

function updateFromXml(bytes: Uint8Array, expectedId: string): { url: URL; version: string; sha256: string } | undefined {
  let xml: string
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new Error('Chrome Web Store update XML is not UTF-8.') }
  if (/<!|<\?(?!xml\s)/i.test(xml)) throw new Error('Chrome Web Store update XML contains forbidden declarations.')
  let document: Document
  try {
    document = new DOMParser({ errorHandler: { warning: () => { throw new Error('Malformed Chrome Web Store XML.') }, error: () => { throw new Error('Malformed Chrome Web Store XML.') }, fatalError: () => { throw new Error('Malformed Chrome Web Store XML.') } } }).parseFromString(xml, 'application/xml')
  } catch { throw new Error('Chrome Web Store update XML is malformed.') }
  const root = document.documentElement
  if (!root || root.tagName !== 'gupdate' || root.namespaceURI !== 'http://www.google.com/update2/response') throw new Error('Chrome Web Store update XML has an unexpected root.')
  const rootChildren = elementChildren(root)
  if (rootChildren.some((child) => child.localName !== 'app' && child.localName !== 'daystart')) throw new Error('Chrome Web Store update XML has an unexpected element.')
  const apps = rootChildren.filter((child) => child.localName === 'app')
  if (apps.length !== 1 || apps[0].getAttribute('appid') !== expectedId || apps[0].getAttribute('status') !== 'ok') throw new Error('Chrome Web Store update XML has an unexpected app ID.')
  const checks = elementChildren(apps[0]).filter((child) => child.localName === 'updatecheck')
  if (checks.length !== 1 || elementChildren(apps[0]).length !== 1) throw new Error('Chrome Web Store update XML has ambiguous release metadata.')
  const check = checks[0]
  if (check.getAttribute('status') === 'noupdate') return undefined
  if (check.getAttribute('status') !== 'ok' || elementChildren(check).length) throw new Error('Chrome Web Store update XML has an invalid release status.')
  const version = check.getAttribute('version') ?? ''
  const sha256 = check.getAttribute('hash_sha256') ?? ''
  const codebase = check.getAttribute('codebase') ?? ''
  if (!isChromeExtensionVersion(version) || !/^[a-fA-F0-9]{64}$/.test(sha256)) throw new Error('Chrome Web Store release identity is invalid.')
  let url: URL
  try { url = new URL(codebase) } catch { throw new Error('Chrome Web Store package URL is invalid.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !PACKAGE_HOSTS.has(url.hostname)) throw new Error('Chrome Web Store package origin is not allowed.')
  return { url, version, sha256: sha256.toLowerCase() }
}

export class CwsUpstreamClient {
  private readonly fetcher: typeof fetch

  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher }

  async latest(extensionId: string, currentVersion?: string): Promise<VerifiedUpstreamPackage | undefined> {
    if (!EXTENSION_ID.test(extensionId)) throw new Error('Chrome Web Store extension ID is invalid.')
    if (currentVersion && !isChromeExtensionVersion(currentVersion)) throw new Error('Installed extension version is invalid.')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const update = new URL('/service/update2/crx', UPDATE_ORIGIN)
      update.searchParams.set('response', 'updatecheck')
      update.searchParams.set('acceptformat', 'crx3')
      update.searchParams.set('prodversion', process.versions.chrome ?? '152.0.0.0')
      update.searchParams.set('x', `id=${extensionId}&uc${currentVersion ? `&v=${currentVersion}` : ''}`)
      const metadataResponse = await this.fetcher(update, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal, headers: { accept: 'text/xml' } })
      if (!metadataResponse.ok || new URL(metadataResponse.url || update).origin !== UPDATE_ORIGIN) throw new Error('Chrome Web Store update metadata is unavailable.')
      const release = updateFromXml(await boundedBytes(metadataResponse, MAX_XML_BYTES), extensionId)
      if (!release || (currentVersion && !isNewerChromeExtensionVersion(release.version, currentVersion))) return undefined
      const packageResponse = await this.fetcher(release.url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal, headers: { accept: 'application/x-chrome-extension, application/octet-stream' } })
      const responseUrl = new URL(packageResponse.url || release.url)
      if (!packageResponse.ok || responseUrl.origin !== release.url.origin || !PACKAGE_HOSTS.has(responseUrl.hostname)) throw new Error('Chrome Web Store package is unavailable.')
      const bytes = await boundedBytes(packageResponse, VEXT_LIMITS.maxCompressedBytes)
      if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Chrome Web Store package hash does not match update metadata.')
      const verified = verifyCwsCrx3(bytes, extensionId)
      if (verified.version !== release.version) throw new Error('Chrome Web Store metadata and signed package versions disagree.')
      return verified
    } finally { clearTimeout(timeout) }
  }
}
