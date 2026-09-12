const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const { verify } = require('../../scripts/release-candidate.cjs')
const root = path.join(__dirname, '../..')
test('resuming requires identical version, source, channel, signature mode and every file hash', () => {
  const candidate = { schema: 2, version: '0.3.0', sourceCommit: 'a'.repeat(40), channel: 'stable', unsigned: true, files: require('../../scripts/release-files.cjs').candidatePaths('0.3.0', true).map(file => ({ path: file, asset: path.posix.basename(file), sha256: 'b'.repeat(64), bytes: 42 })) }
  assert.doesNotThrow(() => verify(candidate, structuredClone(candidate)))
  for (const key of ['version', 'sourceCommit', 'channel', 'unsigned', 'files']) assert.throws(() => verify(candidate, { ...candidate, [key]: null }))
  assert.throws(() => verify(candidate, { ...candidate, files: [] }))
})
test('snapshot audit rejects internal paths and credentials anywhere in the tree', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'vast-snapshot-audit-test-'))
  try {
    const files = ['README.md','SECURITY.md','CONTRIBUTING.md','LICENSE','THIRD_PARTY_NOTICES.md','RELEASE.md','ROADMAP.md','docs/README.md','docs/PRIVACY.md','docs/FEATURE_STATUS.md','docs/SECURITY_ARCHITECTURE.md','docs/IPC_SECURITY.md','docs/OPEN_SOURCE_LICENSE_AUDIT.md','docs/RELEASE_CHECKLIST.md','scripts/public-release-audit.cjs']
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.copyFileSync(path.join(root, file), path.join(directory, file)) }
    const pkg = structuredClone(require('../../package.json')); pkg.scripts['release:audit'] = 'node scripts/public-release-audit.cjs'
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(pkg))
    fs.mkdirSync(path.join(directory, '.github/workflows'), { recursive: true })
    fs.writeFileSync(path.join(directory, '.github/workflows/windows-ci.yml'), fs.readFileSync(path.join(root, '.github/workflows/windows-ci.yml'), 'utf8').replace('branches: [master]', 'branches: [main]'))
    fs.writeFileSync(path.join(directory, '.vast-source-provenance.json'), JSON.stringify({ schema: 2, version: pkg.version, sourceCommit: 'a'.repeat(40), exclusions: ['audit/'] }))
    const audit = () => spawnSync(process.execPath, ['scripts/public-release-audit.cjs'], { cwd: directory, encoding: 'utf8' })
    assert.equal(audit().status, 0)
    for (const file of ['audit/fixture/proof.json', 'nested/local-proofs.cjs', 'nested/secrets/config.json', 'nested/identity.pfx', 'nested/.env.production', 'nested/User Data/Default/Cookies', 'release-candidate.json', '.gitleaksignore']) {
      const target = path.join(directory, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, '{}')
      assert.notEqual(audit().status, 0, file)
      fs.rmSync(target)
      // Remove only the disposable fixture's now-empty ancestor directories.
      let parent = path.dirname(target)
      while (parent !== directory && fs.readdirSync(parent).length === 0) { fs.rmdirSync(parent); parent = path.dirname(parent) }
    }
    fs.writeFileSync(path.join(directory, 'innocent.txt'), ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\ninvalid-test-material')
    assert.notEqual(audit().status, 0)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('release workflows default to candidate-only, guard every publication and preserve resume verification', () => {
  const yaml = require('js-yaml')
  for (const name of ['public-release', 'public-unsigned-beta']) {
    const workflow = yaml.load(fs.readFileSync(path.join(root, `.github/workflows/${name}.yml`), 'utf8'))
    assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
    const steps = Object.values(workflow.jobs)[0].steps
    assert.ok(steps.some(step => step.if === "inputs.publish && inputs.resume_run_id == ''" && step.run.startsWith('throw ')))
    for (const step of steps) {
      if (/publish-source-snapshot|publish-release-assets|gh release edit/.test(step.run || '')) assert.match(step.if, /inputs\.publish/)
      assert.doesNotMatch(step.run || '', /--clobber/)
    }
    const restore = steps.findIndex(step => step.run === 'node scripts/release-candidate.cjs verify')
    const verifyPackage = steps.findIndex(step => step.run === 'node scripts/verify-release-package.cjs')
    const publish = steps.findIndex(step => /publish-source-snapshot/.test(step.run || ''))
    assert.ok(restore >= 0 && restore < verifyPackage && verifyPackage < publish)
    assert.ok(steps.some(step => /export-public-source-snapshot/.test(step.run || '') && !step.if))
  }
  assert.match(fs.readFileSync(path.join(root, 'scripts/build-release.cjs'), 'utf8'), /'electron-builder', '--publish', 'never'/)
})
test('narrow Gitleaks exceptions still detect a new token in an allowlisted file', () => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'vast-secret-negative-'))
  try {
    const relative = 'resources/first-party-extensions/adblocker-for-vast/manifest.json'
    const target = path.join(directory, relative); fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(root, relative), target)
    const scan = () => spawnSync(process.execPath, [path.join(root, 'scripts/secret-scan.cjs'), directory], { cwd: root, encoding: 'utf8' })
    assert.equal(scan().status, 0, 'install pinned Gitleaks with node scripts/setup-gitleaks.cjs')
    const manifest = JSON.parse(fs.readFileSync(target, 'utf8'))
    manifest.accidentalCredential = ['gh', 'p_', require('node:crypto').randomBytes(18).toString('hex')].join('')
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2))
    assert.equal(scan().status, 1, 'a public-key exception must not allow a different secret in the same file')
    delete manifest.accidentalCredential
    manifest.api_key = require('node:crypto').randomBytes(24).toString('base64')
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2))
    assert.equal(scan().status, 1, 'the same generic-api-key rule must still detect another key in the allowlisted file')
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
