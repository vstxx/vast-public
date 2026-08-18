import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { readNoticesReleaseConfig } = require('../../scripts/notices-release-config.cjs') as {
  readNoticesReleaseConfig: (env: Record<string, string>) => {
    enabled: boolean
    feedUrl: string
    feedOrigin: string
    keyId: string
  }
}

const enabledConfig = {
  VAST_NOTICES_ENABLED: '1',
  VAST_NOTICES_FEED_URL: 'https://notices.vast.example/v1/notices.json',
  VAST_NOTICES_KEY_ID: 'vast-notices-test-1',
  VAST_NOTICES_PUBLIC_KEY_SPKI_BASE64: 'A'.repeat(64)
}

test('release configuration keeps Notices disabled unless explicitly provisioned', () => {
  assert.deepEqual(readNoticesReleaseConfig({}), {
    enabled: false,
    feedUrl: '',
    feedOrigin: '',
    keyId: '',
    publicKeySpkiBase64: ''
  })
  const enabled = readNoticesReleaseConfig(enabledConfig)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.feedOrigin, 'https://notices.vast.example')
})

test('release configuration rejects updater origins and mutable feed URLs', () => {
  assert.throws(() => readNoticesReleaseConfig({
    ...enabledConfig,
    VAST_NOTICES_FEED_URL: 'https://github.com/vstxx/vast-public/notices.json'
  }), /separate from the updater/)
  assert.throws(() => readNoticesReleaseConfig({
    ...enabledConfig,
    VAST_NOTICES_FEED_URL: 'https://notices.vast.example/notices.json?target=other'
  }), /one exact HTTPS endpoint/)
})
