import { validateKeyId } from '../shared/validation'

type SigningEnv = Pick<
  AdminEnv,
  | 'RELAY_KEY_ID'
  | 'RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64'
  | 'RELAY_NEXT_KEY_ID'
  | 'RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64'
>

export function signingPrivateKey(env: SigningEnv): string {
  const activeKeyId = validateKeyId(env.RELAY_KEY_ID)
  const nextKeyId = env.RELAY_NEXT_KEY_ID?.trim()
  if (nextKeyId && validateKeyId(nextKeyId) === activeKeyId) {
    const nextPrivateKey = env.RELAY_NEXT_SIGNING_PRIVATE_KEY_PKCS8_BASE64?.trim()
    if (!nextPrivateKey) throw new Error('The active Relay next-key secret is unavailable.')
    return nextPrivateKey
  }
  const currentPrivateKey = env.RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64?.trim()
  if (!currentPrivateKey) throw new Error('The active Relay signing secret is unavailable.')
  return currentPrivateKey
}
