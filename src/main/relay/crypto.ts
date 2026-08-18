import { createPublicKey, verify } from 'node:crypto'
import type { RelaySignedEnvelope, RelayTrustKey } from '../../shared/relay-types.ts'

function canonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Relay canonical numbers must be safe integers.')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    return `{${Object.keys(source).sort().map((key) => {
      if (source[key] === undefined) throw new Error('Relay canonical objects cannot contain undefined.')
      return `${JSON.stringify(key)}:${canonicalValue(source[key])}`
    }).join(',')}}`
  }
  throw new Error('Relay canonical payload contains an unsupported value.')
}

export function canonicalizeRelayPayload(value: unknown): string {
  return canonicalValue(value)
}

export function verifyRelayEnvelope<T extends object>(
  envelope: RelaySignedEnvelope<T>,
  trustedKeys: readonly RelayTrustKey[]
): boolean {
  const trust = trustedKeys.find((key) => key.keyId === envelope.key_id)
  if (!trust) return false
  try {
    const publicKeyBytes = Buffer.from(trust.publicKeySpkiBase64, 'base64')
    if (publicKeyBytes.toString('base64') !== trust.publicKeySpkiBase64) return false
    const publicKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' })
    if (publicKey.asymmetricKeyType !== 'ed25519') return false
    const signature = Buffer.from(envelope.signature, 'base64')
    if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) return false
    return verify(null, Buffer.from(canonicalizeRelayPayload(envelope.payload), 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}
