import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const buildRelease = readFileSync(new URL('../../scripts/build-release.cjs', import.meta.url), 'utf8')
const releaseCheck = readFileSync(new URL('../../scripts/release-check.cjs', import.meta.url), 'utf8')
const releaseAudit = readFileSync(new URL('../../scripts/release-audit.cjs', import.meta.url), 'utf8')
const releaseVerifier = readFileSync(new URL('../../scripts/verify-release-package.cjs', import.meta.url), 'utf8')
const releaseMetadataWriter = readFileSync(new URL('../../scripts/write-release-build-metadata.cjs', import.meta.url), 'utf8')
const updaterSigner = readFileSync(new URL('../../scripts/sign-windows-updater.cjs', import.meta.url), 'utf8')
const localRelease = readFileSync(new URL('../../scripts/local-release-from-env.cjs', import.meta.url), 'utf8')
const releaseEnvExample = readFileSync(new URL('../../.env.release.example', import.meta.url), 'utf8')
const privateUnsignedBuilder = readFileSync(new URL('../../scripts/electron-builder-private-unsigned.cjs', import.meta.url), 'utf8')
const gitAttributes = readFileSync(new URL('../../.gitattributes', import.meta.url), 'utf8')

test('package exposes the single-product hardened release pipeline', () => {
  assert.match(gitAttributes, /relay\/worker-configuration\.d\.ts text eol=lf/)
  assert.match(gitAttributes, /relay\/admin-configuration\.d\.ts text eol=lf/)
  assert.match(packageJson.scripts['release:check'], /release-check\.cjs/)
  assert.match(packageJson.scripts['release:audit'], /release-audit\.cjs/)
  assert.match(packageJson.scripts['release:windows:0.1.5'], /dist:upgrader/)
  assert.match(buildRelease, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(buildRelease, /electron-builder-private-unsigned\.cjs/)
  assert.match(privateUnsignedBuilder, /VAST_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /forceCodeSigning:\s*false/)
  assert.match(privateUnsignedBuilder, /signExecutable:\s*false/)
  assert.match(localRelease, /delete env\.WIN_CSC_LINK/)
  assert.match(localRelease, /CSC_IDENTITY_AUTO_DISCOVERY = 'false'/)
  assert.match(buildRelease, /for \(const windowsTarget of \['nsis', 'portable'\]\)/)
  assert.match(buildRelease, /electronBuilderArgs\(windowsTarget\)/)
  assert.match(buildRelease, /write-release-build-metadata\.cjs/)
  assert.match(buildRelease, /sign-windows-updater\.cjs/)
  assert.match(buildRelease, /verify-release-package\.cjs/)
})

test('public release check requires signing, updater, obfuscation, and repo without licensing config', () => {
  assert.match(releaseCheck, /WIN_CSC_LINK/)
  assert.match(releaseCheck, /VAST_UPDATE_ENABLED/)
  assert.match(releaseCheck, /VAST_OBFUSCATE/)
  assert.match(releaseCheck, /vstxx\/vast-public/)
  assert.doesNotMatch(releaseCheck, /VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT/)
})

test('release audit retains Electron, Authenticode, updater, and package checks', () => {
  for (const marker of [
    'contextIsolation',
    'updater install gated by ready state',
    'storage restore validates payloads',
    'strict app chrome CSP exists',
    'public signing fails closed',
    'standalone updater signing exists',
    'release verifier requires Authenticode and obfuscation evidence'
  ]) {
    assert.match(releaseAudit, new RegExp(marker))
  }
  assert.match(releaseVerifier, /@electron\/asar/)
  assert.match(releaseVerifier, /Get-AuthenticodeSignature/)
  assert.match(updaterSigner, /RFC 3161 timestamp/)
  assert.match(releaseMetadataWriter, /release-build-metadata\.json/)
})

test('local release environment documents only release hardening and signing inputs', () => {
  assert.match(localRelease, /\.env\.release\.local/)
  assert.match(releaseEnvExample, /VAST_RELEASE_REPO=vstxx\/vast-public/)
  assert.match(releaseEnvExample, /VAST_UPDATE_ENABLED=1/)
  assert.match(releaseEnvExample, /VAST_OBFUSCATE=1/)
  assert.match(releaseEnvExample, /VAST_PREVIOUS_VERSION=0\.1\.4/)
  assert.match(releaseEnvExample, /WIN_CSC_LINK/)
  assert.doesNotMatch(releaseEnvExample, /VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT|supabase/i)
})
