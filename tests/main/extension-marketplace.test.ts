import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasPermissionEscalation,
  parseExtensionInstallDeepLink,
  parseHubCatalog,
  parseSignedReleaseDescriptor,
  permissionEscalation,
  verifySignedReleaseDescriptor
} from '../../src/shared/extension-marketplace.ts'
import { canonicalJson, createEd25519Signer, type VextTrustedKey } from '../../src/shared/vext-format.ts'
import { createHubSignerProofPayload, parseHubSignerProof, verifyHubSignerProof } from '../../src/shared/hub-signer-proof.ts'

const id = 'abcdefghijklmnopabcdefghijklmnop'
const publisher = 'publisher_0123456789abcdef'

test('accepts only exact Vast Extensions install deep links', () => {
  assert.equal(parseExtensionInstallDeepLink(`vast://extensions/install?id=${id}`), id)
  for (const input of [
    `https://extensions.vastbrowser.com/install?id=${id}`,
    `vast://extensions/install?id=${id}&next=https://evil.test`,
    `vast://extensions/install?id=${id}&id=${id}`,
    `vast://extensions/install/${id}`,
    `vast://user:pass@extensions/install?id=${id}`,
    'vast://extensions/install?id=invalid'
  ]) assert.equal(parseExtensionInstallDeepLink(input), undefined)
})

test('detects permission escalation without treating normalized hosts as new access', () => {
  const escalation = permissionEscalation(
    { chrome: ['storage'], hosts: ['HTTPS://EXAMPLE.COM/'], vast: ['vast.storage'] },
    { chrome: ['storage', 'tabs'], hosts: ['https://example.com', 'https://new.example/*'], vast: ['vast.storage', 'vast.tabs.read'] }
  )
  assert.deepEqual(escalation, { chrome: ['tabs'], hosts: ['https://new.example/*'], vast: ['vast.tabs.read'] })
  assert.equal(hasPermissionEscalation(escalation), true)
  assert.equal(hasPermissionEscalation({ chrome: [], hosts: [], vast: [] }), false)
})

test('validates and verifies a fixed-origin signed release descriptor', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const privateKey = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey)
  const signer = await createEd25519Signer('vast-descriptor-test', Buffer.from(privateKey).toString('base64'))
  const trusted: VextTrustedKey = { keyId: signer.keyId, algorithm: 'Ed25519', publicKeySpkiBase64: Buffer.from(publicKey).toString('base64'), status: 'test' }
  const descriptor = { schema: 1 as const, extension_id: id, publisher_id: publisher, version: '2.0.0', package_url: `https://extensions.vastbrowser.com/packages/${id}/2.0.0/${'a'.repeat(64)}.vext`, sha256: 'a'.repeat(64), key_id: signer.keyId, permissions: { chrome: [], hosts: [], vast: ['vast.storage'] }, published_at: '2026-08-23T10:00:00.000Z' }
  const signature = Buffer.from(await signer.sign(new TextEncoder().encode(canonicalJson(descriptor)))).toString('base64')
  const signed = parseSignedReleaseDescriptor({ descriptor, signature: { signature_version: 1, algorithm: 'Ed25519', key_id: signer.keyId, signature } }, 'https://extensions.vastbrowser.com')
  await verifySignedReleaseDescriptor(signed, [trusted])
  await assert.rejects(verifySignedReleaseDescriptor({ ...signed, descriptor: { ...signed.descriptor, version: '2.0.1' } }, [trusted]), /Could not verify/)
  assert.throws(() => parseSignedReleaseDescriptor({ ...signed, descriptor: { ...descriptor, package_url: 'https://evil.test/package.vext' } }, 'https://extensions.vastbrowser.com'), /unsafe package URL/)
})

test('verifies a deployment-bound Hub signer readiness proof', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const [privateKey, publicKey] = await Promise.all([crypto.subtle.exportKey('pkcs8', pair.privateKey), crypto.subtle.exportKey('spki', pair.publicKey)])
  const signer = await createEd25519Signer('vast-readiness-test', Buffer.from(privateKey).toString('base64'))
  const trusted: VextTrustedKey = { keyId: signer.keyId, algorithm: 'Ed25519', publicKeySpkiBase64: Buffer.from(publicKey).toString('base64'), status: 'current' }
  const payload = createHubSignerProofPayload(signer.keyId, 'https://extensions.vastbrowser.com')
  const signature = Buffer.from(await signer.sign(new TextEncoder().encode(payload))).toString('base64')
  const proof = parseHubSignerProof({ keyId: signer.keyId, payload, signature }, signer.keyId, 'https://extensions.vastbrowser.com')
  await verifyHubSignerProof(proof, signer.keyId, 'https://extensions.vastbrowser.com', [trusted])
  await assert.rejects(verifyHubSignerProof(proof, signer.keyId, 'https://extensions-staging.vastbrowser.com', [trusted]), /does not match/)
})

test('rejects malformed catalog payloads and unknown Vast permissions', () => {
  const item = { id, slug: 'fixture', name: 'Fixture', summary: 'Summary', publisher: { id: publisher, name: 'Publisher', verified: false }, category: 'Utilities', kind: 'vast', version: '1.0.0', updatedAt: '2026-08-23T10:00:00.000Z', downloads: 0, installed: false }
  assert.equal(parseHubCatalog({ items: [item], featured: [], categories: ['Utilities'], page: 1, pageSize: 24, total: 1 }).items[0].id, id)
  assert.throws(() => parseHubCatalog({ items: [{ ...item, version: '../1' }], featured: [], categories: [], page: 1, pageSize: 24, total: 1 }), /invalid catalog item/)
  assert.throws(() => parseSignedReleaseDescriptor({ descriptor: { schema: 1, extension_id: id, publisher_id: publisher, version: '1.0.0', package_url: 'https://extensions.vastbrowser.com/x', sha256: 'a'.repeat(64), key_id: 'test-key', permissions: { chrome: [], hosts: [], vast: ['vast.root'] }, published_at: '2026-08-23T10:00:00.000Z' }, signature: { signature_version: 1, algorithm: 'Ed25519', key_id: 'test-key', signature: 'AAAA' } }, 'https://extensions.vastbrowser.com'), /unknown Vast permissions/)
})
