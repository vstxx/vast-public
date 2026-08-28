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
const windowsCi = readFileSync(new URL('../../.github/workflows/windows-ci.yml', import.meta.url), 'utf8')
const appTestRunner = readFileSync(new URL('../../scripts/run-app-test.cjs', import.meta.url), 'utf8')
const isolatedE2eRunner = readFileSync(new URL('../../scripts/run-isolated-electron-e2e.cjs', import.meta.url), 'utf8')
const extensionsE2e = readFileSync(new URL('../../scripts/extensions-e2e.cjs', import.meta.url), 'utf8')
const ffmpegCompliance = readFileSync(new URL('../../scripts/check-ffmpeg-release-compliance.cjs', import.meta.url), 'utf8')
const prepareRelease = readFileSync(new URL('../../scripts/prepare-release.ps1', import.meta.url), 'utf8')
const hubWrangler = readFileSync(new URL('../../extensions-hub/wrangler.jsonc', import.meta.url), 'utf8')
const ffmpegBuilder = readFileSync(new URL('../../scripts/build-vast-ffmpeg.ps1', import.meta.url), 'utf8')

test('automated app smoke builds cannot register Relay installations', () => {
  assert.match(windowsCi, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(packageJson.scripts['test:app'], /run-app-test\.cjs/)
  assert.match(packageJson.scripts['test:split-view'], /run-app-test\.cjs --split-view-only/)
  assert.match(appTestRunner, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(appTestRunner, /VAST_RELAY_TEST_OFFLINE:\s*'1'/)
  assert.match(packageJson.scripts['test:extensions:e2e'], /run-isolated-electron-e2e\.cjs extensions-e2e\.cjs/)
  assert.match(packageJson.scripts['test:extensions:native-e2e'], /run-isolated-electron-e2e\.cjs native-extensions-e2e\.cjs/)
  assert.match(isolatedE2eRunner, /VAST_RELAY_ENABLED:\s*'0'/)
  assert.match(isolatedE2eRunner, /VAST_INCLUDE_INTERNAL_TEST_HARNESS:\s*'1'/)
  assert.match(isolatedE2eRunner, /VAST_RELAY_TEST_OFFLINE:\s*'1'/)
})

test('extension E2E handles cold Chromium registration and scopes retained-tab UI assertions', () => {
  assert.match(extensionsE2e, /cold-registration-retry=1/)
  assert.match(extensionsE2e, /getBoundingClientRect\(\)/)
  assert.match(extensionsE2e, /visible extensions page before removal/)
  assert.match(extensionsE2e, /content script and chrome\.storage\.local/)
})

test('package exposes the single-product hardened release pipeline', () => {
  assert.match(gitAttributes, /relay\/worker-configuration\.d\.ts text eol=lf/)
  assert.match(gitAttributes, /relay\/admin-configuration\.d\.ts text eol=lf/)
  assert.match(packageJson.scripts['release:check'], /release-check\.cjs/)
  assert.match(packageJson.scripts['release:audit'], /release-audit\.cjs/)
  assert.match(packageJson.scripts['release:windows'], /dist:upgrader/)
  assert.match(buildRelease, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(buildRelease, /electron-builder-private-unsigned\.cjs/)
  assert.match(privateUnsignedBuilder, /VAST_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /VAST_ALLOW_UNSIGNED_PRIVATE_BUILD/)
  assert.match(privateUnsignedBuilder, /forceCodeSigning:\s*false/)
  assert.match(privateUnsignedBuilder, /signExecutable:\s*false/)
  assert.match(localRelease, /delete env\.WIN_CSC_LINK/)
  assert.match(localRelease, /CSC_IDENTITY_AUTO_DISCOVERY = 'false'/)
  assert.match(buildRelease, /for \(const windowsTarget of \['portable', 'nsis'\]\)/)
  assert.match(buildRelease, /electronBuilderArgs\(windowsTarget\)/)
  assert.match(buildRelease, /write-release-build-metadata\.cjs/)
  assert.match(buildRelease, /sign-windows-updater\.cjs/)
  assert.match(buildRelease, /verify-release-package\.cjs/)
})

test('release verification covers packaged FFmpeg layout and removes tagged smoke profiles', () => {
  assert.match(ffmpegCompliance, /join\(runtime, 'bin', name\)/)
  assert.match(ffmpegCompliance, /join\(runtime, 'media', name\)/)
  assert.match(prepareRelease, /-Filter 'smoke-\*'/)
  assert.match(prepareRelease, /Refusing to remove path outside release root/)
  assert.match(ffmpegBuilder, /System\.Security\.Cryptography\.SHA256/)
  assert.doesNotMatch(ffmpegBuilder, /Get-FileHash/)
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
  assert.match(releaseEnvExample, /VAST_PREVIOUS_VERSION=0\.1\.5/)
  assert.match(releaseEnvExample, /VAST_RELAY_ENABLED=1/)
  assert.match(releaseEnvExample, /VAST_RELAY_PRODUCTION_ENABLED=0/)
  assert.match(releaseEnvExample, /VAST_CAT_ADDON_ENABLED=0/)
  assert.match(releaseEnvExample, /WIN_CSC_LINK/)
  assert.doesNotMatch(releaseEnvExample, /VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT|supabase/i)
})

test('Hub staging is isolated from production resources and scheduled work', () => {
  assert.match(hubWrangler, /"name": "vast-extensions-hub-staging"/)
  assert.match(hubWrangler, /"pattern": "extensions-staging\.vastbrowser\.com"/)
  assert.match(hubWrangler, /"database_name": "vast-extensions-hub-staging"/)
  assert.match(hubWrangler, /"bucket_name": "vast-extensions-packages-staging"/)
  assert.match(hubWrangler, /"ENVIRONMENT": "staging"/)
  assert.match(hubWrangler, /"triggers": \{ "crons": \[\] \}/)
})
