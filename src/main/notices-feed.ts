import { createPublicKey, verify } from 'node:crypto'
import type { VastNotice, VastNoticesResult, VastNoticesTrustConfig } from '../shared/types'

const maxFeedBytes = 256 * 1024
const maxNotices = 40

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vast Notices payload must be a JSON object.')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} contains forbidden fields: ${unexpected.join(', ')}`)
}

function plainText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`)
  const text = value.trim()
  if (!text || text.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error(`${label} is not valid passive plain text.`)
  }
  return text
}

function timestamp(value: unknown, label: string): string {
  const text = plainText(value, 64, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${label} must be an unambiguous UTC ISO timestamp.`)
  }
  return text
}

function decodeBase64(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`${label} must be base64.`)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 1 || bytes.length > maxBytes || bytes.toString('base64') !== value) throw new Error(`${label} is malformed or too large.`)
  return bytes
}

function parseNotice(value: unknown): VastNotice {
  const source = record(value)
  exactKeys(source, ['id', 'title', 'message', 'severity', 'publishedAt', 'expiresAt'], 'Notice')
  const severity = source.severity
  if (severity !== 'info' && severity !== 'important' && severity !== 'security') throw new Error('Notice severity is invalid.')
  return {
    id: plainText(source.id, 100, 'Notice id'),
    title: plainText(source.title, 160, 'Notice title'),
    message: plainText(source.message, 2_000, 'Notice message'),
    severity,
    publishedAt: timestamp(source.publishedAt, 'Notice publishedAt'),
    expiresAt: source.expiresAt === undefined ? undefined : timestamp(source.expiresAt, 'Notice expiresAt')
  }
}

export function verifySignedNoticesFeed(
  raw: string,
  trust: VastNoticesTrustConfig,
  now = Date.now()
): VastNoticesResult {
  if (!trust.enabled) return { enabled: false, notices: [], reason: 'Vast Notices are disabled for this build.' }
  if (Buffer.byteLength(raw, 'utf8') > maxFeedBytes) throw new Error('Vast Notices feed is too large.')
  const envelope = record(JSON.parse(raw) as unknown)
  exactKeys(envelope, ['schemaVersion', 'keyId', 'payload', 'signature'], 'Vast Notices envelope')
  if (envelope.schemaVersion !== 1 || envelope.keyId !== trust.keyId) throw new Error('Vast Notices envelope version or signing key is not trusted.')

  const payloadBytes = decodeBase64(envelope.payload, 'Vast Notices payload', maxFeedBytes)
  const signature = decodeBase64(envelope.signature, 'Vast Notices signature', 64)
  if (signature.length !== 64) throw new Error('Vast Notices requires an Ed25519 signature.')
  const publicKey = createPublicKey({
    key: Buffer.from(trust.publicKeySpkiBase64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Vast Notices requires an Ed25519 public key.')
  if (!verify(null, payloadBytes, publicKey, signature)) throw new Error('Vast Notices signature verification failed.')

  const payload = record(JSON.parse(payloadBytes.toString('utf8')) as unknown)
  exactKeys(payload, ['schemaVersion', 'generatedAt', 'expiresAt', 'notices'], 'Vast Notices signed payload')
  if (payload.schemaVersion !== 1) throw new Error('Vast Notices signed payload version is unsupported.')
  const generatedAt = timestamp(payload.generatedAt, 'Feed generatedAt')
  const expiresAt = timestamp(payload.expiresAt, 'Feed expiresAt')
  if (Date.parse(generatedAt) > now + 5 * 60_000) throw new Error('Vast Notices feed was generated in the future.')
  if (Date.parse(expiresAt) <= now) throw new Error('Vast Notices feed has expired.')
  if (!Array.isArray(payload.notices) || payload.notices.length > maxNotices) throw new Error('Vast Notices list is invalid or too large.')

  const seen = new Set<string>()
  const notices = payload.notices.map(parseNotice).filter((notice) => {
    if (seen.has(notice.id)) throw new Error(`Duplicate Vast Notice id: ${notice.id}`)
    seen.add(notice.id)
    return Date.parse(notice.publishedAt) <= now && (!notice.expiresAt || Date.parse(notice.expiresAt) > now)
  })
  return { enabled: true, notices, generatedAt, expiresAt }
}
