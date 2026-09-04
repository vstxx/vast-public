import { canonicalJson, verifyEd25519Signature, type VextTrustedKey } from './vext-format.ts'

export const HUB_SIGNER_PROOF_PROTOCOL = 1
export const HUB_SIGNER_PROOF_PURPOSE = 'vast-hub-signer-readiness'

export interface HubSignerProof {
  keyId: string
  payload: string
  signature: string
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function createHubSignerProofPayload(keyId: string, origin: string): string {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(keyId)) throw new Error('Hub signer proof key ID is invalid.')
  const parsedOrigin = new URL(origin)
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password) {
    throw new Error('Hub signer proof origin is invalid.')
  }
  return canonicalJson({
    key_id: keyId,
    origin,
    protocol: HUB_SIGNER_PROOF_PROTOCOL,
    purpose: HUB_SIGNER_PROOF_PURPOSE
  })
}

export function parseHubSignerProof(value: unknown, expectedKeyId: string, expectedOrigin: string): HubSignerProof {
  if (!record(value) || Object.keys(value).length !== 3 || typeof value.keyId !== 'string' || typeof value.payload !== 'string' || typeof value.signature !== 'string') {
    throw new Error('Hub signer returned an invalid readiness proof.')
  }
  if (value.keyId !== expectedKeyId || value.payload !== createHubSignerProofPayload(expectedKeyId, expectedOrigin) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.signature)) {
    throw new Error('Hub signer readiness proof does not match this deployment.')
  }
  return { keyId: value.keyId, payload: value.payload, signature: value.signature }
}

export async function verifyHubSignerProof(value: unknown, expectedKeyId: string, expectedOrigin: string, trustedKeys: readonly VextTrustedKey[]): Promise<void> {
  const proof = parseHubSignerProof(value, expectedKeyId, expectedOrigin)
  const valid = await verifyEd25519Signature(new TextEncoder().encode(proof.payload), proof.signature, proof.keyId, trustedKeys)
  if (!valid) throw new Error('Could not verify the Hub signer readiness proof.')
}
