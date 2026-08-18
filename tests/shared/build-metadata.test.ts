import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMetadataFromEnv,
  buildMetadataFromMergedEnv,
  envFlag,
  isPublicDistributionBuild,
  isPublicStableBuild,
  publicReleaseMetadataFailures
} from '../../src/shared/build-metadata.ts'

test('build metadata defaults to private dev-safe release settings', () => {
  const metadata = buildMetadataFromEnv({})
  assert.deepEqual(metadata, {
    channel: 'dev',
    updateEnabled: false,
    obfuscate: false,
    privateBuild: true,
    catAddonAvailable: true,
    releaseRepo: 'vstxx/vast-public',
    performanceGpu: false,
    safeGpu: false
  })
})

test('public stable build is detected without product-tier metadata', () => {
  const metadata = buildMetadataFromEnv({
    VAST_RELEASE_CHANNEL: 'stable',
    VAST_PRIVATE_BUILD: '0',
    VAST_UPDATE_ENABLED: '1'
  })
  assert.equal(isPublicStableBuild(metadata), true)
  assert.equal(isPublicDistributionBuild(metadata), true)
  assert.equal('edition' in metadata, false)
  assert.equal('licenseMode' in metadata, false)
})

test('envFlag parses explicit false values', () => {
  assert.equal(envFlag({ VAST_UPDATE_ENABLED: 'false' }, 'VAST_UPDATE_ENABLED', true), false)
  assert.equal(envFlag({ VAST_UPDATE_ENABLED: 'off' }, 'VAST_UPDATE_ENABLED', true), false)
})

test('embedded build metadata wins over runtime fallbacks', () => {
  const metadata = buildMetadataFromMergedEnv(
    { VAST_RELEASE_CHANNEL: 'dev', VAST_PRIVATE_BUILD: '1' },
    { VAST_RELEASE_CHANNEL: 'stable', VAST_PRIVATE_BUILD: '0' }
  )
  assert.equal(metadata.channel, 'stable')
  assert.equal(metadata.privateBuild, false)
})

test('public stable runtime guard needs updater, obfuscation, and the release repo', () => {
  const metadata = buildMetadataFromMergedEnv({}, {
    VAST_RELEASE_CHANNEL: 'stable',
    VAST_PRIVATE_BUILD: '0',
    VAST_UPDATE_ENABLED: '1',
    VAST_OBFUSCATE: '1',
    VAST_RELEASE_REPO: 'vstxx/vast-public'
  })
  assert.deepEqual(publicReleaseMetadataFailures(metadata), [])
})

test('public stable runtime guard reports missing hardening only', () => {
  const metadata = buildMetadataFromMergedEnv({}, {
    VAST_RELEASE_CHANNEL: 'stable',
    VAST_PRIVATE_BUILD: '0',
    VAST_RELEASE_REPO: 'wrong/repo'
  })
  assert.deepEqual(publicReleaseMetadataFailures(metadata), [
    'VAST_UPDATE_ENABLED=1',
    'VAST_OBFUSCATE=1',
    'release repository must be vstxx/vast-public'
  ])
})

test('public beta uses the complete distribution gate and excludes Cat Addon', () => {
  const metadata = buildMetadataFromEnv({
    VAST_RELEASE_CHANNEL: 'beta',
    VAST_PRIVATE_BUILD: '0',
    VAST_UPDATE_ENABLED: '1',
    VAST_OBFUSCATE: '1',
    VAST_RELEASE_REPO: 'vstxx/vast-public'
  })
  assert.equal(isPublicDistributionBuild(metadata), true)
  assert.equal(isPublicStableBuild(metadata), false)
  assert.equal(metadata.catAddonAvailable, false)
  assert.deepEqual(publicReleaseMetadataFailures(metadata), [])
})
