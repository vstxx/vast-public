const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assertPublishReady,
  requiredCanaryChecks,
  requiredSplitFeedCanaryChecks,
  requiredHotfixCanaryChecks,
  nextStep,
  publicSourceCommitMessage,
  verifiedCandidateAssets,
  executeSteps,
  releaseSteps,
  hotfixReleaseSteps,
  assertExpectedReleaseAssets,
  validateReleaseFileEnv,
  assertReleaseProfile,
  snapshotDigest,
  assertCleanInstallAllowed
} = require('../../scripts/local-public-release.cjs')

const sourceCommit = 'a'.repeat(40)
const candidateManifestSha256 = 'b'.repeat(64)
const identity = { version: '0.4.1', sourceCommit, candidateManifestSha256 }
const completeCanary = {
  ...identity,
  checks: Object.fromEntries(requiredCanaryChecks.map((name) => [name, true]))
}
const readyState = {
  schema: 1,
  ...identity,
  phases: { prepare: 'passed', verify: 'passed', publish: 'pending' },
  steps: []
}

test('publication requires the exact sealed candidate and every canary check', () => {
  assert.doesNotThrow(() => assertPublishReady(readyState, identity, completeCanary))
  assert.throws(() => assertPublishReady(readyState, { ...identity, candidateManifestSha256: 'c'.repeat(64) }, completeCanary), /candidate/i)
  assert.throws(() => assertPublishReady(readyState, identity, { ...completeCanary, sourceCommit: 'd'.repeat(40) }), /source/i)
  for (const name of requiredCanaryChecks) {
    assert.throws(() => assertPublishReady(readyState, identity, { ...completeCanary, checks: { ...completeCanary.checks, [name]: false } }), new RegExp(name))
  }
  assert.throws(() => assertPublishReady({ ...readyState, phases: { ...readyState.phases, verify: 'failed' } }, identity, completeCanary), /verify/i)
})

test('hotfix publication still binds the sealed candidate and requires its targeted canary', () => {
  const hotfixState = { ...readyState, profile: 'hotfix' }
  const hotfixCanary = { ...identity, checks: Object.fromEntries(requiredHotfixCanaryChecks.map((name) => [name, true])) }
  assert.doesNotThrow(() => assertPublishReady(hotfixState, identity, hotfixCanary))
  for (const name of requiredHotfixCanaryChecks) {
    assert.throws(() => assertPublishReady(hotfixState, identity, {
      ...hotfixCanary, checks: { ...hotfixCanary.checks, [name]: false }
    }), new RegExp(name))
  }
  assert.throws(() => assertPublishReady(hotfixState, { ...identity, candidateManifestSha256: 'c'.repeat(64) }, hotfixCanary), /candidate/i)
  assert.throws(() => assertPublishReady({ ...hotfixState, phases: { ...hotfixState.phases, verify: 'failed' } }, identity, hotfixCanary), /verify/i)
})

test('split stable feed requires proof that old clients are held and new clients update', () => {
  const splitIdentity = { ...identity, version: '0.4.3' }
  const splitState = { ...readyState, ...splitIdentity, profile: 'standard' }
  const canary = { ...splitIdentity, checks: Object.fromEntries(requiredSplitFeedCanaryChecks.map((name) => [name, true])) }
  assert.doesNotThrow(() => assertPublishReady(splitState, splitIdentity, canary))
  for (const name of ['legacyFeedHold', 'v2UpdaterCanary']) {
    assert.throws(() => assertPublishReady(splitState, splitIdentity, {
      ...canary, checks: { ...canary.checks, [name]: false, updaterCanary: true }
    }), new RegExp(name))
  }
})

test('resume skips completed steps but never duplicates a running or uncertain command', () => {
  const steps = [{ key: 'preflight', status: 'passed' }, { key: 'build', status: 'pending' }]
  assert.equal(nextStep(steps, ['preflight', 'build', 'seal']).key, 'build')
  assert.equal(nextStep([{ key: 'preflight', status: 'passed' }, { key: 'build', status: 'passed' }], ['preflight', 'build']), null)
  assert.throws(() => nextStep([{ key: 'build', status: 'running', pid: process.pid }], ['build']), /running/i)
  assert.throws(() => nextStep([{ key: 'build', status: 'interrupted' }], ['build']), /interrupted/i)
  assert.throws(() => nextStep([{ key: 'build', status: 'failed' }], ['build']), /failed/i)
})

test('public source snapshot commit skips push-triggered Actions', () => {
  assert.match(publicSourceCommitMessage('0.4.1', sourceCommit), /\[skip ci\]/)
  assert.match(publicSourceCommitMessage('0.4.1', sourceCommit), /0\.4\.1/)
  assert.throws(() => publicSourceCommitMessage('0.4.1', 'not-a-sha'), /source/i)
})

test('publication reads only a sealed candidate and rejects changed bytes', (t) => {
  const candidate = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-local-candidate-'))
  t.after(() => fs.rmSync(candidate, { recursive: true, force: true }))
  const info = { version: require('../../package.json').version, sourceCommit, channel: 'stable', unsigned: true }
  const { candidatePaths, publishedReleaseFiles } = require('../../scripts/release-files.cjs')
  const { inspect } = require('../../scripts/release-candidate.cjs')
  for (const relative of candidatePaths(info.version, info.unsigned)) {
    const target = path.join(candidate, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `sealed ${relative}`)
  }
  fs.writeFileSync(path.join(candidate, 'release-candidate.json'), JSON.stringify(inspect(candidate, info)))
  const assets = verifiedCandidateAssets(candidate, info)
  assert.deepEqual(assets.map((file) => path.basename(file)), publishedReleaseFiles(info.version, true).map((file) => path.basename(file)))
  fs.appendFileSync(assets[0], 'tampered')
  assert.throws(() => verifiedCandidateAssets(candidate, info), /hash|differ/i)
})

test('phase runner persists child PID and resumes after completed commands', async () => {
  const state = { steps: [{ key: 'preflight', status: 'passed' }] }
  const saved = []
  const called = []
  await executeSteps(state, ['preflight', 'build', 'seal'], async (key, setPid) => {
    called.push(key)
    setPid(12345)
    return { exitCode: 0, log: `${key}.log` }
  }, () => saved.push(structuredClone(state)))
  assert.deepEqual(called, ['build', 'seal'])
  assert.deepEqual(state.steps.map(({ key, status }) => [key, status]), [['preflight', 'passed'], ['build', 'passed'], ['seal', 'passed']])
  assert.ok(saved.some((snapshot) => snapshot.steps.some((step) => step.key === 'build' && step.pid === 12345 && step.status === 'running')))
})

test('failed build is recorded and needs explicit retry-build', async () => {
  const state = { steps: [] }
  await assert.rejects(executeSteps(state, ['build'], async () => ({ exitCode: 17, log: 'build.log' }), () => {}), /build.*17/i)
  assert.equal(state.steps[0].status, 'failed')
  assert.equal(state.steps[0].exitCode, 17)
  await assert.rejects(executeSteps(state, ['build'], async () => ({ exitCode: 0 }), () => {}, { retry: true }), /retry-build/i)
  await executeSteps(state, ['build'], async () => ({ exitCode: 0, log: 'build-retry.log' }), () => {}, { retry: true, retryBuild: true })
  assert.equal(state.steps[0].status, 'passed')
})

test('local prepare includes production checks and seals only after package verification', () => {
  const keys = releaseSteps.prepare.map((step) => step.key)
  for (const name of ['dependencies', 'preflight', 'relay', 'hub', 'build', 'package', 'snapshot', 'seal']) {
    assert.ok(keys.includes(name), `${name} gate must be included`)
  }
  assert.ok(!keys.includes('hub-dependencies'), 'Hub has no lockfile or own dependencies; root npm ci supplies its pinned tools')
  assert.ok(keys.indexOf('package') < keys.indexOf('seal'))
  assert.ok(keys.indexOf('snapshot') < keys.indexOf('seal'))
  assert.ok(releaseSteps.verify.some((step) => step.key === 'public-upgrade'))
  assert.ok(releaseSteps.verify.some((step) => step.key === 'clean-install'))
  assert.deepEqual(releaseSteps.publish.map((step) => step.key), ['source', 'draft', 'draft-verify', 'make-public', 'public-verify'])
})

test('hotfix prepare skips broad gates but retains build, artifact checks and immutable publication', () => {
  const keys = hotfixReleaseSteps.prepare.map((step) => step.key)
  for (const name of ['compatibility-check', 'version-check', 'lint', 'targeted-test', 'updater-stage', 'release-audit', 'build', 'package', 'packaged-scroll', 'secret-scan', 'snapshot', 'seal', 'stage']) {
    assert.ok(keys.includes(name), `${name} must be included in the hotfix gate`)
  }
  assert.ok(keys.indexOf('updater-stage') < keys.indexOf('release-audit'))
  for (const name of ['dependencies', 'relay-dependencies', 'preflight', 'relay', 'hub']) {
    assert.ok(!keys.includes(name), `${name} is not part of the targeted hotfix gate`)
  }
  assert.ok(keys.indexOf('package') < keys.indexOf('seal'))
  assert.deepEqual(hotfixReleaseSteps.verify, releaseSteps.verify)
  assert.deepEqual(hotfixReleaseSteps.publish, releaseSteps.publish)
})

test('the 0.4.3 release uses the full standard gate and cannot resume under a different profile', () => {
  assert.doesNotThrow(() => assertReleaseProfile('0.4.2', 'hotfix', 'hotfix'))
  assert.doesNotThrow(() => assertReleaseProfile('0.4.3', 'standard', 'standard'))
  assert.throws(() => assertReleaseProfile('0.4.2', 'standard', 'standard'), /0\.4\.3/i)
  assert.throws(() => assertReleaseProfile('0.4.1', 'hotfix', 'hotfix'), /0\.4\.2/i)
  assert.throws(() => assertReleaseProfile('0.4.2', 'hotfix', 'standard'), /profile/i)
})

test('status command reports current source without starting release work', () => {
  const script = path.join(__dirname, '../../scripts/local-public-release.cjs')
  const result = spawnSync(process.execPath, [script, 'status'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const status = JSON.parse(result.stdout)
  assert.equal(status.version, require('../../package.json').version)
  assert.match(status.sourceCommit, /^[a-f0-9]{40}$/)
  assert.equal(typeof status.statePath, 'string')
})

test('draft publication rejects unapproved extra assets before uploading', () => {
  assert.doesNotThrow(() => assertExpectedReleaseAssets([{ name: 'a.exe' }], ['a.exe', 'b.zip']))
  assert.throws(() => assertExpectedReleaseAssets([{ name: 'a.exe' }, { name: 'unreviewed.exe' }], ['a.exe', 'b.zip']), /unreviewed\.exe/)
  assert.throws(() => assertExpectedReleaseAssets([{ name: 'a.exe' }, { name: 'a.exe' }], ['a.exe']), /duplicate/i)
})

test('local release refuses stale feed and channel overrides from the ignored env file', () => {
  const version = require('../../package.json').version
  const previousVersion = require('../../scripts/release-config.json').previousPublicVersion
  assert.doesNotThrow(() => validateReleaseFileEnv({ VAST_RELEASE_CHANNEL: 'stable', VAST_PREVIOUS_VERSION: previousVersion }, version, sourceCommit))
  assert.throws(() => validateReleaseFileEnv({ VAST_PREVIOUS_VERSION: '0.3.0' }, version, sourceCommit), /VAST_PREVIOUS_VERSION/)
  assert.throws(() => validateReleaseFileEnv({ VAST_UPDATE_MANIFEST_URL: 'https://example.test/v0.4.0/update-manifest.json' }, version, sourceCommit), /VAST_UPDATE_MANIFEST_URL/)
  assert.throws(() => validateReleaseFileEnv({ VAST_RELEASE_CHANNEL: 'beta' }, version, sourceCommit), /VAST_RELEASE_CHANNEL/)
  assert.throws(() => validateReleaseFileEnv({ VAST_RELEASE_COMMIT: 'c'.repeat(40) }, version, sourceCommit), /VAST_RELEASE_COMMIT/)
})

test('unsigned builder accepts the explicitly selected env file but keeps the previous version source-controlled', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'local-release-from-env.cjs'), 'utf8')
  assert.match(source, /process\.env\.VAST_RELEASE_ENV_FILE/)
  assert.match(source, /env\.VAST_PREVIOUS_VERSION\s*=\s*require\('\.\/release-config\.json'\)\.previousPublicVersion/)
})

test('source snapshot digest binds every path and byte and rejects symlinks', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-snapshot-digest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'docs'))
  fs.writeFileSync(path.join(root, 'docs', 'note.md'), 'original')
  const first = snapshotDigest(root)
  assert.match(first, /^[a-f0-9]{64}$/)
  fs.writeFileSync(path.join(root, 'docs', 'note.md'), 'changed')
  assert.notEqual(snapshotDigest(root), first)
  fs.renameSync(path.join(root, 'docs', 'note.md'), path.join(root, 'docs', 'renamed.md'))
  assert.notEqual(snapshotDigest(root), first)
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(root, 'docs', 'renamed.md'), path.join(root, 'link'))
    assert.throws(() => snapshotDigest(root), /symlink/i)
  }
})

test('clean install gate requires explicit isolated-account acknowledgement even under CI', () => {
  assert.throws(() => assertCleanInstallAllowed({ CI: 'true' }), /VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E/)
  assert.doesNotThrow(() => assertCleanInstallAllowed({ VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E: 'YES' }))
})
