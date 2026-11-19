// Signs a Video & Audio module release payload produced by
// build-avidae-module.cjs, writing the avidae-module.json release manifest.
//
// The Ed25519 private key is read from the VAST_AVIDAE_MODULE_SIGNING_KEY
// environment variable (PKCS#8 PEM) or from --key-file, which must be outside
// this repository. Unless --allow-unpinned is given (tests only), the derived
// public key must already be pinned in src/shared/avidae-module-policy.json
// with status "current", so a release can never be signed by a key that
// shipped Vast builds do not trust.
//
// Usage: node scripts/sign-avidae-module.cjs --dir release/avidae-module/<version> --key-id <id> [--key-file <pem>] [--allow-unpinned]
//        node scripts/sign-avidae-module.cjs --generate-key <directory outside the repository>
const { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, relative, resolve, isAbsolute } = require('node:path')

const root = resolve(__dirname, '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function insideRepository(target) {
  const relativePath = relative(root, resolve(target))
  return !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

async function main() {
  const { signedModuleBytes } = await import('../src/main/avidae-module-manifest.ts')
  const generateDirectory = argument('--generate-key')
  if (generateDirectory) {
    if (insideRepository(generateDirectory)) fail('Refusing to write a private signing key inside the repository.')
    mkdirSync(generateDirectory, { recursive: true })
    const keyPath = join(generateDirectory, 'vast-avidae-module-signing-key.pem')
    if (existsSync(keyPath)) fail(`${keyPath} already exists.`)
    const pair = generateKeyPairSync('ed25519')
    writeFileSync(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({
      privateKey: keyPath,
      publicKeySpkiBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      next: 'Store the private key as the VAST_AVIDAE_MODULE_SIGNING_KEY secret, then pin the public key in src/shared/avidae-module-policy.json.'
    }, null, 2))
    return
  }

  const directory = argument('--dir')
  const keyId = argument('--key-id')
  if (!directory || !keyId || !/^[A-Za-z0-9._-]{3,64}$/.test(keyId)) fail('--dir and a valid --key-id are required.')
  const keyFile = argument('--key-file')
  if (keyFile && insideRepository(keyFile)) fail('Refusing to read a signing key from inside the repository.')
  const pem = keyFile ? readFileSync(keyFile, 'utf8') : process.env.VAST_AVIDAE_MODULE_SIGNING_KEY
  if (!pem) fail('No signing key: set VAST_AVIDAE_MODULE_SIGNING_KEY or pass --key-file.')
  const privateKey = createPrivateKey(pem)
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('The module signing key must be Ed25519.')
  const publicKey = createPublicKey(privateKey)
  const publicKeySpkiBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const policy = JSON.parse(readFileSync(join(root, 'src', 'shared', 'avidae-module-policy.json'), 'utf8'))
  const pinned = policy.trustedKeys.find((key) => key.keyId === keyId)
  if (!process.argv.includes('--allow-unpinned')) {
    if (!pinned || pinned.status !== 'current' || pinned.publicKeySpkiBase64 !== publicKeySpkiBase64) {
      fail(`Key ${keyId} is not pinned as a current key in src/shared/avidae-module-policy.json.`)
    }
  }
  const payload = JSON.parse(readFileSync(join(directory, 'avidae-module.payload.json'), 'utf8'))
  const message = signedModuleBytes(payload)
  const signature = sign(null, message, privateKey)
  if (!verify(null, message, publicKey, signature)) fail('Signature self-check failed.')
  const manifest = { format: 'vast-avidae-module-manifest', keyId, signature: signature.toString('base64'), payload }
  writeFileSync(join(directory, 'avidae-module.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify({ ok: true, manifest: join(directory, 'avidae-module.json'), keyId, publicKeySpkiBase64 }, null, 2))
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
