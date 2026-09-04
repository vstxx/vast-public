import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const outputArgument = process.argv[2]
if (!outputArgument) throw new Error('Usage: node scripts/generate-hub-signing-keys.mjs <secure-output-directory>')

const outputDirectory = resolve(outputArgument)
const definitions = [
  { environment: 'production', keyId: 'vast-hub-2026-02' },
  { environment: 'staging', keyId: 'vast-hub-staging-2026-02' }
]

mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })

const manifest = {
  schema: 1,
  algorithm: 'Ed25519',
  generatedAt: new Date().toISOString(),
  keys: []
}

for (const definition of definitions) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })
  const publicSpki = publicKey.export({ type: 'spki', format: 'der' })
  const privatePath = resolve(outputDirectory, `${definition.keyId}.pkcs8.base64`)
  const descriptor = openSync(privatePath, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${privatePkcs8.toString('base64')}\n`, { encoding: 'utf8' })
  } finally {
    closeSync(descriptor)
  }
  manifest.keys.push({
    environment: definition.environment,
    keyId: definition.keyId,
    publicKeySpkiBase64: publicSpki.toString('base64'),
    publicKeySha256: createHash('sha256').update(publicSpki).digest('hex'),
    privateKeyFile: privatePath
  })
  privatePkcs8.fill(0)
  publicSpki.fill(0)
}

writeFileSync(resolve(outputDirectory, 'hub-signing-public-keys.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
writeFileSync(resolve(outputDirectory, 'BACKUP-REQUIRED.txt'), [
  'These Ed25519 private keys are the only source copies for the Vast Extensions Hub signer Workers.',
  'Create an encrypted copy outside this computer before publishing a release signed by either key.',
  'Never commit, paste, email, or upload the *.pkcs8.base64 files to ordinary cloud storage.',
  'The JSON manifest contains public information and fingerprints only.',
  ''
].join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })

console.log(JSON.stringify({
  ok: true,
  outputDirectory,
  keys: manifest.keys.map(({ environment, keyId, publicKeySha256 }) => ({ environment, keyId, publicKeySha256 }))
}))
