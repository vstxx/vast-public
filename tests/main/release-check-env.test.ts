import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()

function cleanReleaseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.includes('LICENSE') || key.includes('ENTITLEMENT') || key === 'WIN_CSC_LINK' || key === 'WIN_CSC_KEY_PASSWORD') {
      delete env[key]
    }
  }
  return env
}

function runReleaseCheck(overrides: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ['scripts/release-check.cjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...cleanReleaseEnv(),
      VAST_RELEASE_CHANNEL: 'stable',
      VAST_PRIVATE_BUILD: '0',
      VAST_UPDATE_ENABLED: '1',
      VAST_OBFUSCATE: '1',
      VAST_RELEASE_REPO: 'vstxx/vast-public',
      VAST_RELEASE_COMMIT: sourceCommit,
      VAST_PREVIOUS_VERSION: '0.1.5',
      VAST_EXPECTED_SIGNER_SUBJECT: 'VastProductions',
      WIN_CSC_LINK: 'fake-cert',
      WIN_CSC_KEY_PASSWORD: 'fake-password',
      ...overrides
    }
  })
}

test('public stable release passes without product licensing environment', () => {
  const result = runReleaseCheck({})
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('public stable release requires the release artifact repository', () => {
  const result = runReleaseCheck({ VAST_RELEASE_REPO: 'vstxx/vast' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /vstxx\/vast-public/i)
})

test('public stable release requires updater and obfuscation', () => {
  const result = runReleaseCheck({ VAST_UPDATE_ENABLED: '0', VAST_OBFUSCATE: '0' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /VAST_UPDATE_ENABLED=1/)
  assert.match(result.stdout, /VAST_OBFUSCATE=1/)
})

test('public stable release requires Windows signing inputs', () => {
  const result = runReleaseCheck({ WIN_CSC_LINK: undefined, WIN_CSC_KEY_PASSWORD: undefined })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /WIN_CSC_LINK/)
  assert.match(result.stdout, /WIN_CSC_KEY_PASSWORD/)
})

test('public stable release requires exact source provenance', () => {
  const result = runReleaseCheck({ VAST_RELEASE_COMMIT: '0'.repeat(40) })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /checked-out HEAD/i)
})

test('public beta release requires a prerelease version', () => {
  const result = runReleaseCheck({ VAST_RELEASE_CHANNEL: 'beta' })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /prerelease identifier/i)
})

test('explicit public unsigned beta accepts a stable-shaped version without signing credentials', () => {
  const result = runReleaseCheck({
    VAST_RELEASE_CHANNEL: 'beta',
    VAST_PUBLIC_UNSIGNED_BETA: '1',
    VAST_UNSIGNED_BETA_ACK: 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK',
    VAST_RELAY_ENABLED: '1',
    VAST_RELAY_PRODUCTION_ENABLED: '0',
    VAST_EXPECTED_SIGNER_SUBJECT: undefined,
    WIN_CSC_LINK: undefined,
    WIN_CSC_KEY_PASSWORD: undefined
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const report = JSON.parse(result.stdout)
  assert.equal(report.publicUnsignedBeta, true)
  assert.equal(report.signaturePolicy, 'unsigned-public-beta')
})

test('public unsigned beta requires the exact risk acknowledgement', () => {
  const result = runReleaseCheck({
    VAST_RELEASE_CHANNEL: 'beta',
    VAST_PUBLIC_UNSIGNED_BETA: '1',
    VAST_UNSIGNED_BETA_ACK: 'yes',
    VAST_EXPECTED_SIGNER_SUBJECT: undefined,
    WIN_CSC_LINK: undefined,
    WIN_CSC_KEY_PASSWORD: undefined
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK/)
})

test('stable releases cannot use the unsigned beta exception', () => {
  const result = runReleaseCheck({
    VAST_PUBLIC_UNSIGNED_BETA: '1',
    VAST_UNSIGNED_BETA_ACK: 'I_ACCEPT_UNSIGNED_PUBLIC_BETA_RISK',
    VAST_EXPECTED_SIGNER_SUBJECT: undefined,
    WIN_CSC_LINK: undefined,
    WIN_CSC_KEY_PASSWORD: undefined
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /beta-only/i)
})

test('private development release does not require signing inputs', () => {
  const result = spawnSync(process.execPath, ['scripts/release-check.cjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...cleanReleaseEnv(),
      VAST_RELEASE_CHANNEL: 'dev',
      VAST_PRIVATE_BUILD: '1'
    }
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
