import { shell } from 'electron/common'
import { webContents, type WebContents } from 'electron/main'
import { randomUUID } from 'node:crypto'
import { externalProtocolTarget } from '../shared/external-protocol'
import type { ExternalProtocolRequest } from '../shared/types'
import { windowRegistry } from './windows/WindowRegistry'

interface PendingExternalProtocol {
  id: string
  ownerWebContentsId: number
  sourceWebContentsId: number
  sourceOrigin?: string
  url: string
  timeout: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 60_000
const MAX_PENDING_REQUESTS = 16
const pendingRequests = new Map<string, PendingExternalProtocol>()
const pendingRequestBySource = new Map<number, string>()

function sourceOrigin(contents: WebContents): string | undefined {
  try {
    const parsed = new URL(contents.getURL())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
  } catch {
    return undefined
  }
}

function clearPendingRequest(id: string): PendingExternalProtocol | undefined {
  const pending = pendingRequests.get(id)
  if (!pending) return undefined
  clearTimeout(pending.timeout)
  pendingRequests.delete(id)
  if (pendingRequestBySource.get(pending.sourceWebContentsId) === id) {
    pendingRequestBySource.delete(pending.sourceWebContentsId)
  }
  return pending
}

export function requestExternalProtocolOpen(contents: WebContents, rawUrl: string): boolean {
  const target = externalProtocolTarget(rawUrl)
  if (!target || contents.isDestroyed()) return false
  const owner = windowRegistry.vastWindowForWebContents(contents)
  if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed()) return false

  const existingId = pendingRequestBySource.get(contents.id)
  if (existingId) {
    if (pendingRequests.has(existingId)) return true
    pendingRequestBySource.delete(contents.id)
  }
  while (pendingRequests.size >= MAX_PENDING_REQUESTS) {
    const oldestId = pendingRequests.keys().next().value as string | undefined
    if (!oldestId) break
    clearPendingRequest(oldestId)
  }

  const id = randomUUID()
  const origin = sourceOrigin(contents)
  const timeout = setTimeout(() => clearPendingRequest(id), REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  pendingRequests.set(id, {
    id,
    ownerWebContentsId: owner.webContents.id,
    sourceWebContentsId: contents.id,
    sourceOrigin: origin,
    url: target.url,
    timeout
  })
  pendingRequestBySource.set(contents.id, id)

  const payload: ExternalProtocolRequest = {
    id,
    scheme: target.scheme.slice(0, -1),
    sourceOrigin: origin
  }
  owner.webContents.send('vast:browser:external-protocol-request', payload)
  return true
}

export async function resolveExternalProtocolOpen(
  sender: WebContents,
  requestId: string,
  allow: boolean
): Promise<void> {
  const pending = pendingRequests.get(requestId)
  if (!pending || pending.ownerWebContentsId !== sender.id) throw new Error('External app request is no longer active.')
  clearPendingRequest(requestId)
  if (!allow) return

  const source = webContents.fromId(pending.sourceWebContentsId)
  if (!source || source.isDestroyed()) throw new Error('The page that requested this app is no longer open.')
  if (sourceOrigin(source) !== pending.sourceOrigin) throw new Error('The requesting page changed before approval.')

  await shell.openExternal(pending.url)
}

export function clearExternalProtocolRequestsForContents(contentsId: number): void {
  const requestId = pendingRequestBySource.get(contentsId)
  if (requestId) clearPendingRequest(requestId)
}
