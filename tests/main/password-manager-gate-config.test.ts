import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)

const {
  DEFAULT_FIXTURE_PORTS,
  MODE_TARGETS,
  TARGETS,
  parseGateArgs,
  resolveGateConfig
} = require('../../scripts/password-manager-gate/config.cjs')
const {
  idFromKey,
  readCrxIdentity,
  stageIdentityRuntime
} = require('../../scripts/password-manager-gate/crx-identity.cjs')
const {
  acquireProfileLock,
  buildRuntimeFingerprint,
  credentialReferenceSha256,
  releaseProfileLock,
  writeJsonAtomic
} = require('../../scripts/password-manager-gate/run-state.cjs')

const FIXTURE_ID = 'bfmcheajhnbjgnhpjgbiefloegniiime'
const FIXTURE_KEY = Buffer.from('fixture-public-key')

test('credential reference fingerprint is deterministic without exposing controlled hashes', () => {
  const expected = { username: 'a'.repeat(64), password: 'b'.repeat(64) }
  const first = credentialReferenceSha256(expected)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(credentialReferenceSha256(expected), first)
  assert.notEqual(credentialReferenceSha256({ ...expected, password: 'c'.repeat(64) }), first)
  assert.equal(JSON.stringify({ credentialReferenceSha256: first }).includes(expected.username), false)
  assert.throws(() => credentialReferenceSha256({ ...expected, username: 'invalid' }), /credential hash/i)
})

function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining) byte |= 0x80
    bytes.push(byte)
  } while (remaining)
  return Buffer.from(bytes)
}

function field(number: number, value: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(value.length), value])
}

function crx3(publicKey = FIXTURE_KEY): Buffer {
  const proof = field(1, publicKey)
  const header = field(2, proof)
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'ascii')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, Buffer.from('zip-payload')])
}

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'vast-password-gate-'))
  for (const target of Object.values(TARGETS) as Array<{ sourceDirectory: string }>) {
    json(join(root, target.sourceDirectory, 'manifest.json'), {
      manifest_version: 3,
      name: 'Fixture password manager',
      version: '1.2.3',
      background: { service_worker: 'background.js' }
    })
    writeFileSync(join(root, target.sourceDirectory, 'background.js'), 'void 0\n')
  }
  const patchedDist = join(root, 'patched-electron')
  mkdirSync(patchedDist, { recursive: true })
  writeFileSync(join(patchedDist, process.platform === 'win32' ? 'electron.exe' : 'electron'), 'electron fixture')
  writeFileSync(join(root, 'bitwarden.crx'), crx3())
  writeFileSync(join(root, 'proton.crx'), crx3())
  return root
}

function gateEnv(root: string): NodeJS.ProcessEnv {
  return {
    VAST_PATCHED_ELECTRON_DIST: join(root, 'patched-electron'),
    VAST_BITWARDEN_CRX: join(root, 'bitwarden.crx'),
    VAST_PROTON_PASS_CRX: join(root, 'proton.crx')
  }
}

test('CLI parsing accepts only the gate command contract and explicit flags', () => {
  assert.deepEqual(parseGateArgs(['run', 'bitwarden', '--dry-run', '--build-vast'], {}), {
    command: 'run',
    mode: 'bitwarden',
    dryRun: true,
    buildVast: true,
    runId: undefined
  })
  assert.deepEqual(parseGateArgs(['status', '--run-id=run-17'], {}), {
    command: 'status',
    mode: undefined,
    dryRun: false,
    buildVast: false,
    runId: 'run-17'
  })
  assert.deepEqual(parseGateArgs(['restart', 'bitwarden', '--run-id=run-17'], {}), {
    command: 'restart', mode: 'bitwarden', dryRun: false, buildVast: false, runId: 'run-17'
  })
  assert.throws(() => parseGateArgs(['run', 'unknown'], {}), /unknown mode/i)
  assert.throws(() => parseGateArgs(['launch', 'bitwarden'], {}), /unknown command/i)
  assert.throws(() => parseGateArgs(['run', 'bitwarden', '--mystery'], {}), /unknown argument/i)
  assert.deepEqual(parseGateArgs(['run', 'proton', '--exploratory'], {}), {
    command: 'run', mode: 'proton', dryRun: false, buildVast: false, runId: undefined, exploratory: true
  })
  assert.throws(() => parseGateArgs(['resume', 'proton', '--exploratory', '--run-id=run-17'], {}), /only valid for prepare and run/i)
  assert.deepEqual(parseGateArgs(['confirm-autofill', 'bitwarden', '--run-id=run-17', '--operator-confirmed'], {}), {
    command: 'confirm-autofill', mode: 'bitwarden', dryRun: false, buildVast: false,
    runId: 'run-17', operatorConfirmed: true
  })
  assert.deepEqual(parseGateArgs(['confirm-suggestion', 'bitwarden', '--run-id=run-17', '--operator-confirmed'], {}), {
    command: 'confirm-suggestion', mode: 'bitwarden', dryRun: false, buildVast: false,
    runId: 'run-17', operatorConfirmed: true
  })
  assert.throws(() => parseGateArgs(['run', 'bitwarden', '--operator-confirmed'], {}), /only valid for confirmation commands/i)
  assert.throws(() => parseGateArgs(['confirm-autofill', 'bitwarden', '--dry-run'], {}), /not valid for confirmation commands/i)
})

test('modes resolve to three distinct persistent profiles and exact target sets', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const resolveMode = (mode: 'bitwarden' | 'proton' | 'combined') =>
    resolveGateConfig(root, parseGateArgs(['prepare', mode], gateEnv(root)), gateEnv(root))

  assert.deepEqual(resolveMode('bitwarden').targets.map((item: { key: string }) => item.key), ['bitwarden'])
  assert.deepEqual(resolveMode('proton').targets.map((item: { key: string }) => item.key), ['protonpass'])
  assert.deepEqual(resolveMode('combined').targets.map((item: { key: string }) => item.key), ['bitwarden', 'protonpass'])
  assert.equal(new Set(['bitwarden', 'proton', 'combined'].map((mode) => resolveMode(mode as 'bitwarden' | 'proton' | 'combined').profile)).size, 3)
  assert.deepEqual(MODE_TARGETS, {
    bitwarden: ['bitwarden'],
    proton: ['protonpass'],
    combined: ['bitwarden', 'protonpass']
  })
  assert.deepEqual(DEFAULT_FIXTURE_PORTS, {
    bitwarden: 54443,
    proton: 54444,
    combined: 54445
  })
  assert.equal(resolveMode('bitwarden').fixturePort, 54443)
  assert.equal(resolveMode('proton').fixturePort, 54444)
  assert.equal(resolveMode('combined').fixturePort, 54445)
})

test('fixture port can be overridden explicitly and rejects ambiguous values', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const args = parseGateArgs(['prepare', 'proton'], gateEnv(root))

  assert.equal(resolveGateConfig(root, args, { ...gateEnv(root), VAST_GATE_FIXTURE_PORT: '50889' }).fixturePort, 50889)
  for (const value of ['0', '443', '65536', '50889junk', '050889', '']) {
    assert.throws(
      () => resolveGateConfig(root, args, { ...gateEnv(root), VAST_GATE_FIXTURE_PORT: value }),
      /VAST_GATE_FIXTURE_PORT/i
    )
  }
})

test('configuration rejects relative or missing CRX files, non-MV3 targets and Electron outside its patched dist', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const args = parseGateArgs(['prepare', 'bitwarden'], gateEnv(root))

  assert.throws(
    () => resolveGateConfig(root, args, { ...gateEnv(root), VAST_BITWARDEN_CRX: 'bitwarden.crx' }),
    /absolute CRX path/i
  )
  assert.throws(
    () => resolveGateConfig(root, args, { ...gateEnv(root), VAST_BITWARDEN_CRX: join(root, 'missing.crx') }),
    /CRX.*does not exist/i
  )

  json(join(root, TARGETS.bitwarden.sourceDirectory, 'manifest.json'), {
    manifest_version: 2,
    name: 'Old fixture',
    version: '1.0.0'
  })
  assert.throws(() => resolveGateConfig(root, args, gateEnv(root)), /Manifest V3/i)

  json(join(root, TARGETS.bitwarden.sourceDirectory, 'manifest.json'), {
    manifest_version: 3,
    name: 'Fixture',
    version: '1.0.0'
  })
  assert.throws(
    () => resolveGateConfig(root, args, {
      ...gateEnv(root),
      VAST_PATCHED_ELECTRON_EXE: join(root, 'outside', 'electron.exe')
    }),
    /inside VAST_PATCHED_ELECTRON_DIST/i
  )
})

test('CRX3 identity is proven from the embedded public key and rejects a different upstream ID', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const crxPath = join(root, 'identity.crx')
  const bytes = crx3()
  writeFileSync(crxPath, bytes)

  assert.equal(idFromKey(FIXTURE_KEY), FIXTURE_ID)
  assert.deepEqual(readCrxIdentity(crxPath, FIXTURE_ID), {
    extensionId: FIXTURE_ID,
    manifestKey: 'Zml4dHVyZS1wdWJsaWMta2V5',
    crxSha256: createHash('sha256').update(bytes).digest('hex')
  })
  assert.throws(() => readCrxIdentity(crxPath, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /does not contain a public key/i)
})

test('identity staging changes only manifest.key in a disposable runtime and fingerprints its sources', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const sourcePath = join(root, 'extension-reference', 'fixture')
  const sourceManifest = {
    manifest_version: 3,
    name: 'Identity fixture',
    version: '7.8.9',
    permissions: ['storage']
  }
  json(join(sourcePath, 'manifest.json'), sourceManifest)
  writeFileSync(join(sourcePath, 'worker.js'), 'fixture worker\n')
  const crxPath = join(root, 'identity.crx')
  writeFileSync(crxPath, crx3())
  const identity = readCrxIdentity(crxPath, FIXTURE_ID)

  const target = stageIdentityRuntime({
    gateRoot: join(root, '.vast-build', 'password-manager-gates'),
    key: 'bitwarden',
    popup: 'popup/index.html',
    sourcePath,
    expectedId: FIXTURE_ID,
    identity
  })

  assert.equal(target.runtimeId, FIXTURE_ID)
  assert.equal(target.version, '7.8.9')
  assert.equal(readFileSync(join(sourcePath, 'manifest.json'), 'utf8').includes('"key"'), false)
  const stagedManifest = JSON.parse(readFileSync(join(target.runtimePath, 'manifest.json'), 'utf8'))
  assert.deepEqual({ ...stagedManifest, key: undefined }, { ...sourceManifest, key: undefined })
  assert.equal(stagedManifest.key, identity.manifestKey)
  assert.equal(readFileSync(join(target.runtimePath, 'worker.js'), 'utf8'), 'fixture worker\n')
  const marker = JSON.parse(readFileSync(join(target.runtimePath, '.vast-password-manager-identity.json'), 'utf8'))
  assert.deepEqual(marker, {
    schemaVersion: 1,
    sourceManifestSha256: target.manifestSha256,
    crxSha256: identity.crxSha256,
    expectedId: FIXTURE_ID
  })

  json(join(target.runtimePath, 'manifest.json'), { ...stagedManifest, name: 'Tampered runtime' })
  assert.throws(() => stageIdentityRuntime({
    gateRoot: join(root, '.vast-build', 'password-manager-gates'),
    key: 'bitwarden',
    popup: 'popup/index.html',
    sourcePath,
    expectedId: FIXTURE_ID,
    identity
  }), /staged manifest differs from its source/i)
})

test('live profile lock fails closed and dead lock is recoverable without deleting the profile', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'vault-sentinel'), 'preserve me')

  const first = acquireProfileLock(profile, { pid: process.pid, runId: 'first' })
  assert.throws(() => acquireProfileLock(profile, { pid: process.pid, runId: 'second' }), /already owned/i)
  releaseProfileLock(first)
  writeFileSync(first.path, `${JSON.stringify({ pid: 2147483647, runId: 'dead' })}\n`)
  const replacement = acquireProfileLock(profile, { pid: process.pid, runId: 'replacement' })
  assert.equal(existsSync(join(profile, 'vault-sentinel')), true)
  assert.equal(readFileSync(join(profile, 'vault-sentinel'), 'utf8'), 'preserve me')
  releaseProfileLock(replacement)
})

test('atomic JSON never leaves its temporary file and runtime fingerprints are stable and dirty-aware', (t) => {
  const root = makeRoot()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const statePath = join(root, 'state', 'run.json')
  writeJsonAtomic(statePath, { state: 'ready' })
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), { state: 'ready' })
  assert.deepEqual(require('node:fs').readdirSync(dirname(statePath)), ['run.json'])

  json(join(root, 'package.json'), {
    devDependencies: { electron: '44.3.0', 'electron-chrome-extensions': '4.9.0' }
  })
  writeFileSync(join(root, 'ece.patch'), 'ece patch\n')
  writeFileSync(join(root, '0004.patch'), 'electron patch four\n')
  writeFileSync(join(root, '0005.patch'), 'electron patch five\n')
  writeFileSync(join(root, 'tracked.txt'), 'clean\n')
  for (const args of [
    ['init'],
    ['add', '.'],
    ['-c', 'user.name=Vast Test', '-c', 'user.email=vast-test@example.invalid', 'commit', '-m', 'fixture']
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }

  const config = {
    root,
    electronExecutable: join(root, 'patched-electron', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    electronPatchPaths: [join(root, '0004.patch'), join(root, '0005.patch')],
    ecePatchPath: join(root, 'ece.patch'),
    targets: [{
      key: 'bitwarden',
      version: '1.2.3',
      runtimeId: FIXTURE_ID,
      manifestSha256: 'a'.repeat(64),
      crxSha256: 'b'.repeat(64)
    }]
  }
  const clean = buildRuntimeFingerprint(config)
  assert.equal(clean.schemaVersion, 1)
  assert.equal(clean.electronVersion, '44.3.0')
  assert.equal(clean.eceVersion, '4.9.0')
  assert.equal(clean.vastDirty, false)
  assert.match(clean.vastCommit, /^[0-9a-f]{40}$/)
  assert.equal(clean.vastDiffSha256, createHash('sha256').update('').digest('hex'))
  assert.deepEqual(buildRuntimeFingerprint(config), clean)

  writeFileSync(join(root, 'tracked.txt'), 'dirty\n')
  const dirty = buildRuntimeFingerprint(config)
  assert.equal(dirty.vastDirty, true)
  assert.notEqual(dirty.vastDiffSha256, clean.vastDiffSha256)
  assert.equal(existsSync(join(root, '.vast-diff')), false)

  writeFileSync(join(root, 'untracked-runtime.cjs'), 'first untracked runtime\n')
  const firstUntracked = buildRuntimeFingerprint(config)
  writeFileSync(join(root, 'untracked-runtime.cjs'), 'changed untracked runtime\n')
  const changedUntracked = buildRuntimeFingerprint(config)
  assert.notEqual(changedUntracked.vastDiffSha256, firstUntracked.vastDiffSha256)
})

test('target constants use exact official IDs and immutable definitions', () => {
  assert.equal(TARGETS.bitwarden.expectedUpstreamId, 'nngceckbapebfimnlniiiahkandclblb')
  assert.equal(TARGETS.protonpass.expectedUpstreamId, 'ghmbeldphafepmbegfdlkpapadhbakde')
  assert.equal(Object.isFrozen(TARGETS), true)
  assert.equal(Object.isFrozen(TARGETS.bitwarden), true)
  assert.equal(Object.isFrozen(MODE_TARGETS.combined), true)
})
