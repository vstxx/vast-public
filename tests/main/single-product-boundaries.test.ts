import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

test('product-license runtime modules and activation UI are absent', () => {
  for (const path of [
    'src/shared/license.ts',
    'src/main/license.ts',
    'src/main/license-cache.ts',
    'src/renderer/hooks/useLicenseStatus.ts',
    'src/renderer/components/license/UpgradePage.tsx'
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, `${path} must stay removed`)
  }
})

test('Supabase backend, license provisioning script, and active licensing docs are absent', () => {
  for (const path of [
    'supabase',
    'scripts/create-license-key.mjs',
    'docs/LICENSING.md',
    'docs/LICENSING_SUPABASE_SETUP.md',
    'FREE_PRO_DISTRIBUTION.md',
    'RELEASE_PRO.md'
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, `${path} must stay removed`)
  }
})

test('main, preload, and public types expose no activation channels or license status', () => {
  const publicBoundary = [
    read('src/main/main.ts'),
    read('src/main/ipc.ts'),
    read('src/preload/index.ts'),
    read('src/shared/types.ts')
  ].join('\n')
  assert.doesNotMatch(publicBoundary, /vast:license|LicenseStatus|currentLicenseStatus|onLicenseStatusChanged|licenseState/)
})

test('diagnostics and build metadata contain no product tier or entitlement fields', () => {
  const boundary = [
    read('src/shared/build-metadata.ts'),
    read('src/renderer/components/diagnostics/DiagnosticsPage.tsx'),
    read('electron.vite.config.ts')
  ].join('\n')
  assert.doesNotMatch(
    boundary,
    /VastEdition|normalizeEdition|licenseMode|licenseApiBaseUrl|licensePublicKey|proBuildEntitlement|VAST_LICENSE|VAST_PRO_BUILD_ENTITLEMENT/
  )
})

test('single-product package scripts have no free or pro distribution branch', () => {
  const packageJson = JSON.parse(read('package.json'))
  const buildApp = read('scripts/build-app.cjs')
  assert.equal(packageJson.scripts['build:free'], undefined)
  assert.equal(packageJson.scripts['dist:free'], undefined)
  assert.equal(packageJson.scripts['dist:free-upgrader'], undefined)
  assert.match(packageJson.scripts.build, /build-app\.cjs/)
  assert.match(buildApp, /electron-vite.*build/s)
  assert.match(buildApp, /write-release-build-metadata\.cjs/)
  assert.match(packageJson.scripts.dist, /electron-builder/)
  assert.match(packageJson.scripts['dist:upgrader'], /build-release\.cjs/)
})

test('new release packages are scanned for backend and activation markers', () => {
  const verifier = read('scripts/verify-release-package.cjs')
  assert.match(verifier, /forbiddenProductBackendMarkers/)
  assert.match(verifier, /packaged app\.asar contains removed product-backend code/)
  assert.match(verifier, /\['supa', 'base', '\.co'\]\.join\(''\)/)
  assert.match(verifier, /\['VAST', 'LICENSE'\]\.join\('_'\)/)
  assert.match(verifier, /\['vast', 'license'\]\.join\(':'\)/)
})

test('legacy license metadata is ignored only at the backup compatibility boundary', () => {
  const backup = read('src/main/vast-backup.ts')
  assert.match(backup, /legacyProductMetadataFiles = new Set\(\['license-cache\.json', 'license-device\.json'\]\)/)
  assert.match(backup, /function isLegacyProductMetadataPath\(relativePath: string\)/)
  assert.match(backup, /isLegacyProductMetadataPath\(normalized\)/)
  assert.match(backup, /isLegacyProductMetadataPath\(entry\.path\)/)
})

test('legacy updater edition input is accepted but does not select or block a payload', () => {
  const updater = read('resources/updater/VastUpdater.ps1')
  assert.match(updater, /legacy edition\/targetEdition config fields are accepted/)
  assert.match(updater, /intentionally have no effect/)
  assert.doesNotMatch(updater, /EditionMismatch|Resolve-ManifestPayload|Normalize-Edition/)
  assert.doesNotMatch(updater, /\"edition\"|\"targetEdition\"/)
})
