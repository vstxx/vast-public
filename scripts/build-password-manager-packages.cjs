const { createHash } = require('node:crypto')
const { lstat, mkdir, readFile, readdir, writeFile } = require('node:fs/promises')
const { join, relative, resolve, sep } = require('node:path')
const { readCrxIdentity } = require('./password-manager-gate/crx-identity.cjs')

const PUBLISHER_ID = 'publisher_7b1e2c9f4a806d3e5b709c12'
const GPL_PATH = resolve('LICENSE')
const targets = [
  {
    key: 'bitwarden',
    id: 'nngceckbapebfimnlniiiahkandclblb',
    version: '2026.8.0',
    crxSha256: 'd1a5942d9c234d03382da99279932055064caae7a32cc9b157940c863165d59f',
    publisher: 'Bitwarden Inc.',
    sourceUrl: 'https://github.com/bitwarden/clients',
    sourceRef: 'browser-v2026.8.0',
    sourceCommit: 'f60a4606b7581c338d18091a98640ee71392f015',
    output: 'Bitwarden-2026.8.0.vext',
    listing: {
      slug: 'bitwarden-password-manager',
      name: 'Bitwarden Password Manager',
      summary: 'Use the upstream Bitwarden browser extension in Vast.',
      description: 'The unmodified upstream Bitwarden browser-extension runtime, packaged for Vast with only its CRX public key restored in manifest.json to preserve the official Chrome extension ID. Not an official or publisher-verified Bitwarden distribution.',
      homepage: 'https://bitwarden.com',
      dataPractice: 'external-processing',
      privacyPolicyUrl: 'https://bitwarden.com/privacy/',
      remoteServices: 'Bitwarden account, authentication, vault sync, and related services selected by the user.'
    }
  },
  {
    key: 'protonpass',
    id: 'ghmbeldphafepmbegfdlkpapadhbakde',
    version: '1.40.2',
    crxSha256: 'c54d144ce60fb4c1b005d1da09538c766a3f681db014046267007301c07526c8',
    publisher: 'Proton AG',
    sourceUrl: 'https://github.com/ProtonMail/WebClients',
    sourceRef: 'applications/pass-extension 1.40.2',
    sourceCommit: '3dd430f4de8ad38e23a70dd39e9861973f9abfd7',
    output: 'Proton-Pass-1.40.2.vext',
    listing: {
      slug: 'proton-pass',
      name: 'Proton Pass',
      summary: 'Use the upstream Proton Pass browser extension in Vast.',
      description: 'The unmodified upstream Proton Pass browser-extension runtime, packaged for Vast with only its CRX public key restored in manifest.json to preserve the official Chrome extension ID. Not an official or publisher-verified Proton distribution.',
      homepage: 'https://proton.me/pass',
      dataPractice: 'external-processing',
      privacyPolicyUrl: 'https://proton.me/legal/privacy',
      remoteServices: 'Proton account, authentication, vault sync, and related Proton Pass services selected by the user.'
    }
  }
]

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

async function collect(root, normalizePath) {
  const files = new Map()
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Refusing upstream symlink: ${absolute}`)
      if (entry.isDirectory()) { await visit(absolute); continue }
      if (!entry.isFile()) throw new Error(`Refusing upstream special file: ${absolute}`)
      files.set(normalizePath(relative(root, absolute).split(sep).join('/')), new Uint8Array(await readFile(absolute)))
    }
  }
  await visit(root)
  return files
}

async function main() {
  const format = await import('../src/shared/vext-format.ts')
  const out = resolve('artifacts')
  await mkdir(out, { recursive: true })
  const gpl = new Uint8Array(await readFile(GPL_PATH))
  for (const target of targets) {
    const source = resolve('extension-reference', target.key)
    const crxPath = resolve('extension-reference', `${target.key}.crx`)
    const identity = readCrxIdentity(crxPath, target.id)
    if (identity.crxSha256 !== target.crxSha256) throw new Error(`${target.key} CRX hash differs from the reviewed upstream package.`)
    const files = await collect(source, format.normalizeVextPath)
    const sourceManifestBytes = files.get('manifest.json')
    if (!sourceManifestBytes) throw new Error(`${target.key} manifest is missing.`)
    const manifest = JSON.parse(new TextDecoder().decode(sourceManifestBytes))
    if (manifest.version !== target.version) throw new Error(`${target.key} version differs from the reviewed upstream version.`)
    if ('key' in manifest) throw new Error(`${target.key} extracted manifest unexpectedly already contains a key.`)
    files.set('manifest.json', new TextEncoder().encode(`${JSON.stringify({ ...manifest, key: identity.manifestKey }, null, 2)}\n`))
    const provenance = {
      schemaVersion: 1,
      upstreamPublisher: target.publisher,
      upstreamExtensionId: target.id,
      upstreamVersion: target.version,
      upstreamCrxSha256: target.crxSha256,
      upstreamSource: target.sourceUrl,
      upstreamSourceRef: target.sourceRef,
      upstreamSourceCommit: target.sourceCommit,
      license: 'GPL-3.0-only',
      modifications: ['Restored manifest.key from the verified CRX3 public key so Vast preserves the upstream Chrome extension ID.', 'Added this provenance record and a GPL-3.0 license copy.'],
      endorsement: 'This package is maintained for Vast compatibility and does not imply upstream publisher authorization, partnership, endorsement, or verified-publisher status.'
    }
    files.set('VAST-UPSTREAM-PROVENANCE.json', new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`))
    files.set('LICENSE-GPL-3.0.txt', gpl)
    const bytes = await format.createVextPackage({ extensionId: target.id, version: target.version, publisherId: PUBLISHER_ID, files })
    const parsed = await format.parseVextPackage(bytes)
    if (parsed.metadata.extension_id !== target.id || parsed.metadata.version !== target.version) throw new Error(`${target.key} package identity verification failed.`)
    const packagePath = join(out, target.output)
    await writeFile(packagePath, bytes)
    const listing = {
      extensionId: target.id,
      ...target.listing,
      category: 'password-managers',
      sourceUrl: `${target.sourceUrl}/tree/${target.sourceCommit}`,
      attributionName: target.publisher,
      attributionUrl: target.listing.homepage,
      license: 'GPL-3.0-only',
      sourceRef: `${target.sourceRef} (${target.sourceCommit})`,
      publisherId: PUBLISHER_ID,
      version: target.version,
      packageFile: target.output,
      packageSha256: sha256(bytes),
      publisherVerified: false
    }
    await writeFile(join(out, `${target.output.slice(0, -5)}-Hub-listing.json`), `${JSON.stringify(listing, null, 2)}\n`)
    process.stdout.write(`${packagePath} ${bytes.byteLength} bytes sha256=${listing.packageSha256}\n`)
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
