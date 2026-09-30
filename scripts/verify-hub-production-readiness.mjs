import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseHubCatalog, parseHubExtensionDetails, parseSignedReleaseDescriptor, verifySignedReleaseDescriptor } from '../src/shared/extension-marketplace.ts'
import { verifyHubSignerProof } from '../src/shared/hub-signer-proof.ts'
import { TRUSTED_VAST_HUB_KEYS } from '../src/main/extensions/trusted-hub-keys.ts'
import { verifyVextPackage } from '../src/shared/vext-format.ts'

const origin = 'https://extensions.vastbrowser.com'
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const vastHeaders = { Accept: 'application/json', 'X-Vast-Version': version }
const healthResponse = await fetch(`${origin}/health`, { headers: { Accept: 'application/json' } })
if (!healthResponse.ok) throw new Error(`Production Hub health returned HTTP ${healthResponse.status}.`)
const health = await healthResponse.json()
if (health?.ok !== true || health.environment !== 'production') throw new Error('Production Hub health identifies the wrong environment.')
const trustedKey = TRUSTED_VAST_HUB_KEYS.find((key) => key.keyId === health.signingKeyId && key.status === 'current')
if (!trustedKey) throw new Error('Production Hub signing key is not compiled into this Vast build as a current trust root.')
await verifyHubSignerProof(health.signerProof, trustedKey.keyId, origin, TRUSTED_VAST_HUB_KEYS)

const catalogResponse = await fetch(`${origin}/v1/catalog`, { headers: vastHeaders })
if (!catalogResponse.ok) throw new Error(`Production Hub catalog returned HTTP ${catalogResponse.status}.`)
const catalog = parseHubCatalog(await catalogResponse.json())
const iCloud = catalog.items.find((item) => item.id === 'pejdijmoenmkgeppbflobdenhhabjlaj')
if (!iCloud || iCloud.distribution !== 'upstream' || iCloud.publisher.name !== 'Apple' || iCloud.publisher.verified) throw new Error('Production Hub iCloud upstream listing is missing or misattributed.')
const upstreamDescriptor = await fetch(`${origin}/v1/install/${iCloud.id}`, { headers: vastHeaders })
if (upstreamDescriptor.status !== 404) throw new Error('Production Hub must not host an install descriptor for iCloud Passwords.')

const passwordManagers = [
  {
    id: 'nngceckbapebfimnlniiiahkandclblb',
    name: 'Bitwarden Password Manager',
    publisher: 'Bitwarden Inc.',
    version: '2026.8.0',
    sourceRef: 'browser-v2026.8.0 (f60a4606b7581c338d18091a98640ee71392f015)',
    sourceUrl: 'https://github.com/bitwarden/clients/tree/f60a4606b7581c338d18091a98640ee71392f015'
  },
  {
    id: 'ghmbeldphafepmbegfdlkpapadhbakde',
    name: 'Proton Pass',
    publisher: 'Proton AG',
    version: '1.40.2',
    sourceRef: 'applications/pass-extension 1.40.2 (3dd430f4de8ad38e23a70dd39e9861973f9abfd7)',
    sourceUrl: 'https://github.com/ProtonMail/WebClients/tree/3dd430f4de8ad38e23a70dd39e9861973f9abfd7'
  }
]

const verifiedPackages = []
for (const expected of passwordManagers) {
  const listing = catalog.items.find((item) => item.id === expected.id) ?? catalog.featured.find((item) => item.id === expected.id)
  if (!listing || listing.name !== expected.name || listing.version !== expected.version || listing.distribution !== 'hub' || listing.license !== 'GPL-3.0-only' || listing.sourceRef !== expected.sourceRef || listing.publisher.name !== expected.publisher || listing.publisher.verified) {
    throw new Error(`Production Hub listing is invalid for ${expected.name}.`)
  }
  const detailsResponse = await fetch(`${origin}/v1/extensions/${expected.id}`, { headers: vastHeaders })
  if (!detailsResponse.ok) throw new Error(`Production Hub details returned HTTP ${detailsResponse.status} for ${expected.name}.`)
  const details = parseHubExtensionDetails(await detailsResponse.json())
  if (details.sourceUrl !== expected.sourceUrl || !details.description.includes('not an official or publisher-verified')) throw new Error(`Production Hub attribution disclaimer is invalid for ${expected.name}.`)
  const descriptorResponse = await fetch(`${origin}/v1/extensions/${expected.id}/releases/current`, { headers: vastHeaders })
  if (!descriptorResponse.ok) throw new Error(`Production Hub descriptor returned HTTP ${descriptorResponse.status} for ${expected.name}.`)
  const signed = parseSignedReleaseDescriptor(await descriptorResponse.json(), origin)
  const descriptorKey = TRUSTED_VAST_HUB_KEYS.find((key) => key.keyId === signed.signature.key_id && (key.status === 'current' || key.status === 'legacy'))
  if (!descriptorKey) throw new Error(`Published descriptor for ${expected.name} does not use a compiled trust root.`)
  await verifySignedReleaseDescriptor(signed, TRUSTED_VAST_HUB_KEYS)
  if (signed.descriptor.extension_id !== expected.id || signed.descriptor.version !== expected.version) throw new Error(`Published descriptor identity is invalid for ${expected.name}.`)
  const packageResponse = await fetch(signed.descriptor.package_url, { headers: { Accept: 'application/octet-stream' } })
  if (!packageResponse.ok) throw new Error(`Production Hub package returned HTTP ${packageResponse.status} for ${expected.name}.`)
  const bytes = new Uint8Array(await packageResponse.arrayBuffer())
  const parsed = await verifyVextPackage(bytes, TRUSTED_VAST_HUB_KEYS, true)
  if (parsed.packageSha256 !== signed.descriptor.sha256 || parsed.metadata.extension_id !== expected.id || parsed.metadata.version !== expected.version || parsed.metadata.publisher_id !== signed.descriptor.publisher_id) throw new Error(`Published package identity is invalid for ${expected.name}.`)
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(parsed.files.get('manifest.json')))
  const identity = createHash('sha256').update(Buffer.from(manifest.key ?? '', 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  if (identity !== expected.id) throw new Error(`Published package does not preserve the upstream ID for ${expected.name}.`)
  verifiedPackages.push({ id: expected.id, version: expected.version, packageSha256: parsed.packageSha256, signingKeyId: parsed.verifiedKeyId })
}

console.log(JSON.stringify({ ok: true, origin, activeSigningKeyId: trustedKey.keyId, iCloudDistribution: iCloud.distribution, verifiedPackages }))
