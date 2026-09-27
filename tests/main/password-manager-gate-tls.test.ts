import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { FIXTURE_HOSTS } = require('../../scripts/password-manager-gate/config.cjs')
const {
  ensureTlsMaterial,
  fixtureHostResolverRules,
  isApprovedFixtureHost,
  validateTlsMetadata
} = require('../../scripts/password-manager-gate/tls.cjs')

const ROOT_SUBJECT = 'CN=Vast Password Manager Gate Root'
const LEAF_SUBJECT = 'CN=login.vast-test.local'

function validMetadata(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    rootSubject: ROOT_SUBJECT,
    leafSubject: LEAF_SUBJECT,
    rootThumbprint: 'A'.repeat(40),
    leafThumbprint: 'B'.repeat(40),
    dnsNames: [...FIXTURE_HOSTS],
    expiresAt: '2099-12-31T00:00:00.000Z',
    pfxFile: 'leaf.pfx',
    passphraseFile: 'leaf.passphrase',
    ...overrides
  }
}

test('TLS policy names only the four approved hosts and generates loopback-only resolver rules', () => {
  assert.deepEqual(FIXTURE_HOSTS, [
    'login.vast-test.local',
    'spa.vast-test.local',
    'dynamic.vast-test.local',
    'iframe.vast-test.local'
  ])
  assert.equal(Object.isFrozen(FIXTURE_HOSTS), true)
  assert.equal(
    fixtureHostResolverRules(),
    'MAP login.vast-test.local 127.0.0.1, MAP spa.vast-test.local 127.0.0.1, MAP dynamic.vast-test.local 127.0.0.1, MAP iframe.vast-test.local 127.0.0.1'
  )
})

test('TLS scripts stay in CurrentUser stores and contain no certificate or web-security bypass', () => {
  const setup = readFileSync(join(process.cwd(), 'scripts/password-manager-gate/setup-tls.ps1'), 'utf8')
  const remove = readFileSync(join(process.cwd(), 'scripts/password-manager-gate/remove-tls.ps1'), 'utf8')
  const sources = `${setup}\n${remove}`
  assert.doesNotMatch(sources, /ignore-certificate-errors|certificate-error|disable-web-security/i)
  assert.doesNotMatch(sources, /Cert:\\LocalMachine/i)
  assert.match(setup, /Cert:\\CurrentUser\\Root/)
  assert.match(setup, /Cert:\\CurrentUser\\My/)
  assert.match(setup, /KeyLength\s+3072/i)
  assert.match(setup, /1\.3\.6\.1\.5\.5\.7\.3\.1/)
  assert.doesNotMatch(setup, /RandomNumberGenerator\]::Fill/)
  assert.match(setup, /RandomNumberGenerator\]::Create\(\)/)
  assert.match(setup, /\.GetBytes\(\$secretBytes\)/)
})

test('metadata rejects a leaf missing one SAN, extra names, unexpected subjects and weak identity fields', () => {
  assert.doesNotThrow(() => validateTlsMetadata(validMetadata()))
  assert.throws(() => validateTlsMetadata(validMetadata({ dnsNames: FIXTURE_HOSTS.slice(1) })), /SAN/i)
  assert.throws(() => validateTlsMetadata(validMetadata({ dnsNames: [...FIXTURE_HOSTS, 'extra.vast-test.local'] })), /SAN/i)
  assert.throws(() => validateTlsMetadata(validMetadata({ rootSubject: 'CN=Other Root' })), /subject/i)
  assert.throws(() => validateTlsMetadata(validMetadata({ leafSubject: 'CN=Other Leaf' })), /subject/i)
  assert.throws(() => validateTlsMetadata(validMetadata({ rootThumbprint: 'not-a-thumbprint' })), /thumbprint/i)
  assert.throws(() => validateTlsMetadata(validMetadata({ expiresAt: '2020-01-01T00:00:00.000Z' })), /seven days/i)
})

test('hostname policy rejects every name outside the exact fixture allowlist', () => {
  assert.equal(isApprovedFixtureHost('login.vast-test.local'), true)
  assert.equal(isApprovedFixtureHost('unlisted.vast-test.local'), false)
  assert.equal(isApprovedFixtureHost('vast-test.local'), false)
  assert.equal(isApprovedFixtureHost('LOGIN.vast-test.local'), false)
  assert.equal(isApprovedFixtureHost('login.vast-test.local.'), false)
})

test('TLS material loads PFX and protected passphrase while JSON serialization omits the secret', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-gate-tls-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'metadata.json'), `${JSON.stringify(validMetadata())}\n`)
  writeFileSync(join(root, 'leaf.pfx'), Buffer.from([1, 2, 3, 4]))
  writeFileSync(join(root, 'leaf.passphrase'), 'fixture-secret\n')

  const material = ensureTlsMaterial(root)
  assert.deepEqual(material.pfx, Buffer.from([1, 2, 3, 4]))
  assert.equal(material.passphrase, 'fixture-secret')
  assert.equal(material.rootThumbprint, 'A'.repeat(40))
  assert.equal(material.leafThumbprint, 'B'.repeat(40))
  assert.deepEqual(material.dnsNames, FIXTURE_HOSTS)
  assert.doesNotMatch(JSON.stringify(material), /fixture-secret|passphrase/i)
})

test('TLS material fails closed for missing files and path traversal in public metadata', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vast-gate-tls-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'metadata.json'), `${JSON.stringify(validMetadata())}\n`)
  assert.throws(() => ensureTlsMaterial(root), /PFX.*missing/i)

  writeFileSync(join(root, 'leaf.pfx'), Buffer.from([1]))
  writeFileSync(join(root, 'leaf.passphrase'), 'secret')
  writeFileSync(join(root, 'metadata.json'), `${JSON.stringify(validMetadata({ pfxFile: '..\\outside.pfx' }))}\n`)
  assert.throws(() => ensureTlsMaterial(root), /file name/i)
})
