import { env } from 'cloudflare:workers'
import { bytesToBase64 } from '../src/shared/crypto'
import type { AccessIdentity } from '../src/admin/auth'

export const TEST_KEY_ID = 'relay-staging-2026-01'
export const TEST_ACCESS_AUD = 'd57429a0aa7ef593c1a7eac956cfce93eb284f518625454b55b6a25787ef0866'
export const TEST_IDENTITY: AccessIdentity = {
  actor: 'relay-admin@example.com',
  kind: 'human',
  subject: 'test-access-subject'
}

const allowAll: RateLimit = {
  async limit() {
    return { success: true }
  }
}

const panelAssets: Fetcher = {
  async fetch() {
    return new Response('control panel fixture', { headers: { 'Content-Type': 'text/plain' } })
  },
  connect() {
    throw new Error('Socket connections are not available in the control panel fixture.')
  }
}

export function publicBindings(overrides: Partial<PublicEnv> = {}): PublicEnv {
  return {
    DB: env.DB,
    ASSETS: env.ASSETS,
    CHECKIN_SOURCE_RATE_LIMIT: allowAll,
    CHECKIN_INSTALL_RATE_LIMIT: allowAll,
    ASSET_SOURCE_RATE_LIMIT: allowAll,
    ENVIRONMENT: 'staging',
    ...overrides
  }
}

export async function generateTestSigningKey(): Promise<{ privateKeyBase64: string; publicKeyBase64: string }> {
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  if (!('privateKey' in generated)) throw new Error('Ed25519 key generation did not return a key pair.')
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', generated.privateKey),
    crypto.subtle.exportKey('spki', generated.publicKey)
  ])
  if (!(privateKey instanceof ArrayBuffer) || !(publicKey instanceof ArrayBuffer)) {
    throw new Error('Ed25519 key export returned an unexpected format.')
  }
  return {
    privateKeyBase64: bytesToBase64(new Uint8Array(privateKey)),
    publicKeyBase64: bytesToBase64(new Uint8Array(publicKey))
  }
}

export async function adminBindings(): Promise<{ env: AdminEnv; publicKeyBase64: string }> {
  const keys = await generateTestSigningKey()
  return {
    env: {
      DB: env.DB,
      ASSETS: env.ASSETS,
      ADMIN_SOURCE_RATE_LIMIT: allowAll,
      ADMIN_ACTOR_RATE_LIMIT: allowAll,
      ADMIN_MUTATION_RATE_LIMIT: allowAll,
      CONTROL_PANEL_ASSETS: panelAssets,
      ACCESS_AUD: TEST_ACCESS_AUD,
      ACCESS_TEAM_DOMAIN: 'https://vast-browser.cloudflareaccess.com',
      CONTROL_PANEL_ORIGIN: 'https://controlpanel-staging.vastbrowser.com',
      ENVIRONMENT: 'staging',
      RELAY_KEY_ID: TEST_KEY_ID,
      RELAY_SIGNING_PRIVATE_KEY_PKCS8_BASE64: keys.privateKeyBase64
    },
    publicKeyBase64: keys.publicKeyBase64
  }
}

export function jsonRequest(url: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(url, {
    method: 'POST',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.10',
      ...Object.fromEntries(new Headers(init.headers))
    },
    body: JSON.stringify(body)
  })
}

export const onePixelPng = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
), (character) => character.charCodeAt(0))
