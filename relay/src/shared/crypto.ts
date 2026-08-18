import { canonicalize } from './canonical'

const encoder = new TextEncoder()

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(value: string, expectedLength?: number): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Malformed base64.')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('Malformed base64.')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new Error('Unexpected decoded length.')
  if (bytesToBase64(bytes) !== value) throw new Error('Non-canonical base64.')
  return bytes
}

export async function signCanonicalPayload(payload: unknown, privateKeyPkcs8Base64: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKeyPkcs8Base64),
    { name: 'Ed25519' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('Ed25519', privateKey, encoder.encode(canonicalize(payload)))
  return bytesToBase64(new Uint8Array(signature))
}

export async function verifyCanonicalPayload(
  payload: unknown,
  signatureBase64: string,
  publicKeySpkiBase64: string
): Promise<boolean> {
  let signature: Uint8Array
  let publicKeyBytes: Uint8Array
  try {
    signature = base64ToBytes(signatureBase64, 64)
    publicKeyBytes = base64ToBytes(publicKeySpkiBase64)
  } catch {
    return false
  }
  try {
    const publicKey = await crypto.subtle.importKey('spki', publicKeyBytes, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', publicKey, signature, encoder.encode(canonicalize(payload)))
  } catch {
    return false
  }
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
