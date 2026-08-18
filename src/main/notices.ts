import { session } from 'electron/main'
import { getNoticesTrustConfig } from '../shared/notices-trust'
import type { VastNoticesResult } from '../shared/types'
import { verifySignedNoticesFeed } from './notices-feed'

const maxFeedBytes = 256 * 1024
let cache: { raw: string; fetchedAt: number } | undefined

async function readBoundedResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxFeedBytes) throw new Error('Vast Notices feed is too large.')
  if (!response.body) throw new Error('Vast Notices feed returned an empty body.')
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxFeedBytes) throw new Error('Vast Notices feed is too large.')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')
}

export async function getVastNotices(): Promise<VastNoticesResult> {
  const trust = getNoticesTrustConfig()
  if (!trust.enabled) return { enabled: false, notices: [], reason: 'Vast Notices are disabled for this build.' }
  const now = Date.now()
  if (cache && now - cache.fetchedAt < 15 * 60_000) {
    try {
      return verifySignedNoticesFeed(cache.raw, trust, now)
    } catch {
      cache = undefined
    }
  }

  const noticesSession = session.fromPartition('vast-notices', { cache: false })
  const response = await noticesSession.fetch(trust.feedUrl, {
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`Vast Notices feed returned HTTP ${response.status}.`)
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new Error('Vast Notices feed must use application/json.')
  const raw = await readBoundedResponseBody(response)
  const result = verifySignedNoticesFeed(raw, trust, now)
  cache = { raw, fetchedAt: now }
  return result
}
