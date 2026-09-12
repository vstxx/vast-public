const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { inspect, verifyTree, verify, manifestName, stageCandidate } = require('../../scripts/release-candidate.cjs')
const { candidatePaths, publishedReleaseFiles, requiredReleaseFiles } = require('../../scripts/release-files.cjs')
const { operate } = require('../../scripts/private-release-candidate.cjs')
const info = { version: require('../../package.json').version, sourceCommit: 'a'.repeat(40), channel: 'stable', unsigned: true }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-candidate-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const file of candidatePaths(info.version, true)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.writeFileSync(path.join(directory, file), Buffer.from(`original bytes: ${file}\0\xff`))
  }
  fs.writeFileSync(path.join(directory, manifestName), JSON.stringify(inspect(directory, info), null, 2) + '\n')
  return directory
}
function fakeGithub() {
  let ref = null, release = null, nextId = 1
  const bytes = new Map(), calls = []
  const run = { head_sha: info.sourceCommit, path: '.github/workflows/public-unsigned-beta.yml', event: 'workflow_dispatch', status: 'completed' }
  async function api(method, route, body) {
    calls.push([method, route])
    if (method === 'GET' && route === 'repos/vstxx/vast') return { private: true }
    if (route.includes('/actions/runs/')) return run
    if (method === 'GET' && route.includes('/git/ref/')) return ref
    if (method === 'GET' && route.includes('/releases?')) return release ? [structuredClone(release)] : []
    if (method === 'GET' && route.includes('/assets?')) return [...bytes].map(([name, value]) => ({ id: value.id, name, size: value.data.length, state: 'uploaded' }))
    if (method === 'POST' && route.endsWith('/git/refs')) return (ref = { object: { sha: body.sha, type: 'commit' } })
    if (method === 'POST' && route.endsWith('/releases')) return (release = { ...body, id: 123 })
    if (method === 'DELETE' && route.includes('/releases/')) { release = null; bytes.clear(); return }
    if (method === 'DELETE' && route.includes('/git/refs/')) { ref = null; return }
    throw new Error(`Unexpected API call: ${method} ${route}`)
  }
  async function upload(release, file, name) {
    assert.equal(bytes.has(name), false, 'never overwrite an asset')
    bytes.set(name, { id: nextId++, data: fs.readFileSync(file) })
    calls.push(['UPLOAD', name])
  }
  async function download(asset, target) { fs.writeFileSync(target, bytes.get(asset.name).data, { flag: 'wx' }) }
  return { api, upload, download, bytes, calls, run, release: () => release, ref: () => ref }
}
function options(directory, github, command = 'store', extra = {}) { return { command, directory, info, runId: '1234', ...github, ...extra } }
test('canonical inventory contains every public/verification file and excludes redundant runtime/build outputs', t => {
  const directory = fixture(t)
  fs.mkdirSync(path.join(directory, 'release/win-unpacked'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'release/win-unpacked/Vast.exe'), 'redundant')
  fs.writeFileSync(path.join(directory, 'release/Docs/updater-runbook.md'), 'not published')
  const candidate = verifyTree(directory, info)
  assert.deepEqual(candidate.files.map(file => file.path), candidatePaths(info.version, true))
  for (const file of [...publishedReleaseFiles(info.version, true), ...requiredReleaseFiles(info.version, true)]) assert.ok(candidate.files.some(item => item.path === `release/${file}`))
  assert.ok(candidate.files.every(file => !file.path.includes('win-unpacked')))
  const staged = path.join(directory, 'staging')
  stageCandidate(directory, info, staged)
  verifyTree(staged, info)
  assert.equal(fs.existsSync(path.join(staged, 'release/win-unpacked')), false)
  assert.equal(fs.existsSync(path.join(staged, 'release/Docs/updater-runbook.md')), false)
})
test('missing files, changed bytes and unexpected deliverables fail closed', t => {
  const directory = fixture(t), file = path.join(directory, candidatePaths(info.version, true)[0])
  const original = fs.readFileSync(file)
  fs.unlinkSync(file)
  assert.throws(() => verifyTree(directory, info))
  fs.writeFileSync(file, Buffer.alloc(original.length, 7))
  assert.throws(() => verifyTree(directory, info), /hashes differ/)
  fs.writeFileSync(file, original)
  fs.writeFileSync(path.join(directory, 'release/Installer/extra.exe'), 'unexpected')
  assert.throws(() => verifyTree(directory, info), /Unexpected/)
})
test('source SHA, version, channel and signing mode are pinned', t => {
  const manifest = inspect(fixture(t), info)
  for (const change of [{ sourceCommit: 'b'.repeat(40) }, { version: '9.9.9' }, { channel: 'beta' }, { unsigned: false }]) {
    assert.throws(() => verify(manifest, { ...manifest, ...change }))
  }
})
test('private candidate uploads and restores exactly the original bytes without Actions artifact APIs', async t => {
  const source = fixture(t), github = fakeGithub()
  const stored = await operate(options(source, github))
  assert.equal(stored.files, candidatePaths(info.version, true).length + 1)
  assert.equal(github.ref().object.sha, info.sourceCommit)
  assert.equal(github.release().draft, true)
  assert.ok(github.calls.every(([, route]) => !route.includes('/actions/artifacts')))
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-restored-test-'))
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }))
  await operate(options(destination, github, 'restore'))
  for (const file of [...candidatePaths(info.version, true), manifestName]) assert.deepEqual(fs.readFileSync(path.join(source, file)), fs.readFileSync(path.join(destination, file)))
  verifyTree(destination, info)
})
test('identical rerun reuses bytes; mismatching existing bytes or draft cannot be overwritten', async t => {
  const directory = fixture(t), github = fakeGithub()
  await operate(options(directory, github))
  const uploaded = github.calls.filter(([method]) => method === 'UPLOAD').length
  await operate(options(directory, github))
  assert.equal(github.calls.filter(([method]) => method === 'UPLOAD').length, uploaded)
  const asset = github.bytes.get('latest.yml')
  asset.data[0] ^= 1
  await assert.rejects(operate(options(directory, github)), /hash mismatch/)
  assert.equal(github.calls.filter(([method]) => method === 'UPLOAD').length, uploaded)
  asset.data[0] ^= 1
  github.release().draft = false
  await assert.rejects(operate(options(directory, github)), /differs/)
})
test('different same-SHA build fails before upload; partial upload resumes only matching missing assets', async t => {
  const directory = fixture(t), github = fakeGithub()
  let uploads = 0
  await assert.rejects(operate(options(directory, github, 'store', { upload: async (...args) => { if (++uploads === 3) throw new Error('interrupted'); await github.upload(...args) } })), /interrupted/)
  assert.ok(github.release().draft)
  await operate(options(directory, github))
  const file = path.join(directory, candidatePaths(info.version, true)[0])
  fs.appendFileSync(file, 'different build')
  fs.writeFileSync(path.join(directory, manifestName), JSON.stringify(inspect(directory, info)))
  const count = github.calls.length
  await assert.rejects(operate(options(directory, github)), /differs/)
  assert.ok(github.calls.slice(count).every(([method]) => method === 'GET'))
})
test('moved private tags and changed staging provenance fail before any mutation', async t => {
  const directory = fixture(t), github = fakeGithub()
  await operate(options(directory, github))
  const count = github.calls.length
  github.ref().object.sha = 'b'.repeat(40)
  await assert.rejects(operate(options(directory, github)), /different source/)
  github.ref().object.sha = info.sourceCommit
  const record = JSON.parse(github.release().body)
  github.release().body = JSON.stringify({ ...record, manifestSha256: 'b'.repeat(64) })
  await assert.rejects(operate(options(directory, github)), /differs/)
  assert.ok(github.calls.slice(count).every(([method]) => method === 'GET'))
})
test('extra private asset, missing asset and invalid resume run fail; cleanup is publication-only', async t => {
  const directory = fixture(t), github = fakeGithub()
  await operate(options(directory, github))
  await assert.rejects(operate(options(directory, github, 'cleanup')), /successful public verification/)
  github.run.event = 'push'
  await assert.rejects(operate(options(directory, github, 'restore')), /completed manual/)
  github.run.event = 'workflow_dispatch'
  github.bytes.set('unexpected.exe', { id: 999, data: Buffer.from('x') })
  await assert.rejects(operate(options(directory, github, 'restore')), /Unexpected/)
  github.bytes.delete('unexpected.exe')
  const saved = github.bytes.get('latest.yml'); github.bytes.delete('latest.yml')
  await assert.rejects(operate(options(directory, github, 'restore')), /incomplete/)
  github.bytes.set('latest.yml', saved)
  await operate(options(directory, github, 'cleanup', { publicationVerified: true }))
  assert.equal(github.release(), null)
  assert.equal(github.ref(), null)
  await operate(options(directory, github, 'cleanup', { publicationVerified: true }))
})
test('workflow needs no Actions artifacts, never rebuilds on resume and cleans up only after public verification', () => {
  const yaml = require('js-yaml'), source = fs.readFileSync(path.join(__dirname, '../../.github/workflows/public-unsigned-beta.yml'), 'utf8')
  const workflow = yaml.load(source), steps = Object.values(workflow.jobs)[0].steps
  assert.doesNotMatch(source, /actions\/(?:upload|download)-artifact|continue-on-error/)
  assert.equal(workflow.permissions.contents, 'write')
  assert.equal(workflow.permissions.actions, 'read')
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false)
  for (const step of steps.filter(step => /dist:upgrader|runtime:prepare|prepare-ffmpeg|Full quality/.test((step.run || '') + (step.uses || '') + (step.name || '')))) assert.equal(step.if, "inputs.resume_run_id == ''")
  for (const command of ['store', 'restore', 'cleanup']) {
    const step = steps.find(step => step.run === `node scripts/private-release-candidate.cjs ${command}`)
    assert.equal(step.env.GH_TOKEN, '${{ github.token }}')
  }
  const verify = steps.findIndex(step => step.run === 'node scripts/release-candidate.cjs verify')
  const reconstruct = steps.findIndex(step => (step.run || '').includes('-ExtractRuntimeTo'))
  const packageGate = steps.findIndex(step => step.run === 'node scripts/verify-release-package.cjs')
  assert.ok(verify < reconstruct && reconstruct < packageGate)
  const cleanup = steps.findIndex(step => step.run === 'node scripts/private-release-candidate.cjs cleanup')
  assert.equal(steps[cleanup].if, 'inputs.publish')
  assert.equal(steps[cleanup - 1].run, 'npm run release:verify:published')
  assert.ok(steps.findIndex(step => (step.run || '').includes('publish-source-snapshot')) > packageGate)
})
