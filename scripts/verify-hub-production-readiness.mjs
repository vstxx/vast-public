import { parseHubCatalog, parseSignedReleaseDescriptor, verifySignedReleaseDescriptor } from '../src/shared/extension-marketplace.ts'
import { verifyHubSignerProof } from '../src/shared/hub-signer-proof.ts'
import { TRUSTED_VAST_HUB_KEYS } from '../src/main/extensions/trusted-hub-keys.ts'

const origin = 'https://extensions.vastbrowser.com'
const healthResponse = await fetch(`${origin}/health`, { headers: { Accept: 'application/json' } })
if (!healthResponse.ok) throw new Error(`Production Hub health returned HTTP ${healthResponse.status}.`)
const health = await healthResponse.json()
if (health?.ok !== true || health.environment !== 'production') throw new Error('Production Hub health identifies the wrong environment.')
const trustedKey = TRUSTED_VAST_HUB_KEYS.find((key) => key.keyId === health.signingKeyId && key.status === 'current')
if (!trustedKey) throw new Error('Production Hub signing key is not compiled into this Vast build as a current trust root.')
await verifyHubSignerProof(health.signerProof, trustedKey.keyId, origin, TRUSTED_VAST_HUB_KEYS)

const catalogResponse = await fetch(`${origin}/v1/catalog`, { headers: { Accept: 'application/json' } })
if (!catalogResponse.ok) throw new Error(`Production Hub catalog returned HTTP ${catalogResponse.status}.`)
const catalog = parseHubCatalog(await catalogResponse.json())
const candidate = catalog.items[0] ?? catalog.featured[0]
if (!candidate) throw new Error('Production Hub catalog is empty; signing compatibility cannot be proven.')
const descriptorResponse = await fetch(`${origin}/v1/extensions/${candidate.id}/releases/current`, { headers: { Accept: 'application/json' } })
if (!descriptorResponse.ok) throw new Error(`Production Hub descriptor returned HTTP ${descriptorResponse.status}.`)
const descriptor = parseSignedReleaseDescriptor(await descriptorResponse.json(), origin)
const descriptorKey = TRUSTED_VAST_HUB_KEYS.find((key) => key.keyId === descriptor.signature.key_id && (key.status === 'current' || key.status === 'legacy'))
if (!descriptorKey) throw new Error('Published Hub descriptor does not use a current or legacy trust root compiled into this Vast build.')
await verifySignedReleaseDescriptor(descriptor, TRUSTED_VAST_HUB_KEYS)
console.log(JSON.stringify({ ok: true, origin, activeSigningKeyId: trustedKey.keyId, descriptorSigningKeyId: descriptorKey.keyId, verifiedExtension: candidate.id, version: candidate.version }))
