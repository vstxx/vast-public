const requiredCanaryChecks = Object.freeze([
  'cleanInstall',
  'publicUpgrade',
  'updaterCanary',
  'chatgptAuthenticated',
  'extensionRuntime',
  'bitwarden',
  'proton',
  'icloudBasic',
  'profilePersistence'
])

function verifiedCandidateAssets(candidateRoot, info) {
  const path = require('node:path')
  const fs = require('node:fs')
  const { verifyTree } = require('./release-candidate.cjs')
  const { publishedReleaseFiles } = require('./release-files.cjs')
  if (!path.isAbsolute(candidateRoot) || fs.lstatSync(candidateRoot).isSymbolicLink()) {
    throw new Error('Candidate root must be a real absolute directory.')
  }
  verifyTree(candidateRoot, info)
  return publishedReleaseFiles(info.version, info.unsigned).map((relative) => path.join(candidateRoot, 'release', relative))
}

function assertExpectedReleaseAssets(existing, expectedNames) {
  const allowed = new Set(expectedNames)
  const seen = new Set()
  for (const asset of existing) {
    if (!asset || typeof asset.name !== 'string' || !allowed.has(asset.name)) {
      throw new Error(`Unapproved release asset: ${asset?.name ?? '<invalid>'}.`)
    }
    if (seen.has(asset.name)) throw new Error(`Duplicate release asset: ${asset.name}.`)
    seen.add(asset.name)
  }
}

function validateReleaseFileEnv(parsed, version, sourceCommit) {
  const baseUrl = `https://github.com/vstxx/vast-public/releases/download/v${version}`
  const expected = {
    VAST_RELEASE_CHANNEL: 'stable', VAST_RELEASE_REPO: 'vstxx/vast-public',
    VAST_PREVIOUS_VERSION: '0.3.0', VAST_RELAY_ENVIRONMENT: 'production',
    VAST_PRIVATE_BUILD: '0', VAST_RELAY_ENABLED: '1',
    VAST_UPDATE_ENABLED: '1', VAST_OBFUSCATE: '1',
    VAST_RELEASE_COMMIT: sourceCommit,
    VAST_UPDATE_MANIFEST_URL: `${baseUrl}/update-manifest.json`,
    VAST_PRODUCTION_RELEASE_BASE_URL: baseUrl
  }
  for (const [key, value] of Object.entries(expected)) {
    if (parsed[key] !== undefined && parsed[key] !== value) throw new Error(`${key} in .env.release.local conflicts with the approved ${version} release.`)
  }
}

function snapshotDigest(directory) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { createHash } = require('node:crypto')
  if (!path.isAbsolute(directory) || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Snapshot root must be a real absolute directory.')
  const hash = createHash('sha256')
  function visit(relative) {
    const folder = path.join(directory, relative)
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const nested = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Snapshot contains a symlink: ${nested}`)
      if (entry.isDirectory()) { visit(nested); continue }
      if (!entry.isFile()) throw new Error(`Snapshot contains a non-file: ${nested}`)
      const file = path.join(directory, ...nested.split('/'))
      const size = fs.statSync(file).size
      hash.update(`${nested}\0${size}\0`)
      const fd = fs.openSync(file, 'r')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      try {
        let count
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
      } finally { fs.closeSync(fd) }
    }
  }
  visit('')
  return hash.digest('hex')
}

function assertCleanInstallAllowed(env) {
  if (env.VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E !== 'YES') {
    throw new Error('Clean-install E2E changes current-user registration. Use an isolated Windows account and explicitly set VAST_ALLOW_DESTRUCTIVE_INSTALL_E2E=YES.')
  }
}

function assertPublishReady(state, identity, canary) {
  if (state?.schema !== 1 || state.phases?.prepare !== 'passed' || state.phases?.verify !== 'passed') {
    throw new Error('Prepare and verify must pass before publication.')
  }
  for (const key of ['version', 'sourceCommit', 'candidateManifestSha256']) {
    if (state[key] !== identity[key] || canary?.[key] !== identity[key]) {
      throw new Error(`Release ${key === 'candidateManifestSha256' ? 'candidate' : key} mismatch.`)
    }
  }
  for (const name of requiredCanaryChecks) {
    if (canary.checks?.[name] !== true) throw new Error(`Canary check ${name} is not passed.`)
  }
}

function nextStep(steps, keys, { retry = false, retryBuild = false } = {}) {
  for (const key of keys) {
    const item = steps.find((step) => step.key === key)
    if (item?.status === 'passed') continue
    if (item?.status === 'running') throw new Error(`${key} is still running or its process state is uncertain.`)
    if (item?.status === 'interrupted' && !retry) throw new Error(`${key} was interrupted; inspect its log before --retry.`)
    if (item?.status === 'failed' && !retry) throw new Error(`${key} failed; inspect its log before --retry.`)
    if (key === 'build' && item && ['failed', 'interrupted'].includes(item.status) && !retryBuild) {
      throw new Error('A failed or interrupted build requires explicit --retry-build after checking artifacts.')
    }
    return { key }
  }
  return null
}

async function executeSteps(state, keys, runner, save, options = {}) {
  let pending
  while ((pending = nextStep(state.steps, keys, options))) {
    const key = pending.key
    let step = state.steps.find((item) => item.key === key)
    if (!step) {
      step = { key }
      state.steps.push(step)
    }
    Object.assign(step, { status: 'running', pid: null, exitCode: null, startedAt: new Date().toISOString() })
    save()
    try {
      const result = await runner(key, (pid, log, command) => {
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid child PID for ${key}.`)
        step.pid = pid
        if (log) step.log = log
        if (command) step.command = command
        save()
      })
      step.exitCode = result.exitCode
      step.log = result.log ?? null
      step.finishedAt = new Date().toISOString()
      step.status = result.exitCode === 0 ? 'passed' : 'failed'
      save()
      if (step.status !== 'passed') throw new Error(`${key} failed with exit code ${result.exitCode}; inspect ${step.log || 'its log'}.`)
    } catch (error) {
      if (step.status === 'running') {
        step.status = 'failed'
        step.finishedAt = new Date().toISOString()
        step.error = error instanceof Error ? error.message : String(error)
        save()
      }
      throw error
    }
  }
}

function publicSourceCommitMessage(version, sourceCommit) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error('A valid release version and full source commit are required.')
  }
  return `Publish Vast ${version} source snapshot (${sourceCommit}) [skip ci]`
}

const releaseSteps = Object.freeze({
  prepare: [
    'dependencies', 'relay-dependencies', 'compatibility',
    'preflight', 'relay', 'hub', 'avidae-runtime', 'archive', 'build',
    'updater-background', 'package', 'secret-scan', 'snapshot', 'seal', 'stage'
  ].map((key) => ({ key })),
  verify: ['candidate-verify', 'clean-install', 'public-upgrade'].map((key) => ({ key })),
  publish: ['source', 'draft', 'draft-verify', 'make-public', 'public-verify'].map((key) => ({ key }))
})

async function main() {
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const { spawn, spawnSync } = require('node:child_process')
  const root = path.join(__dirname, '..')
  const version = require('../package.json').version
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw new Error('A Git source commit is required.')
  const sourceCommit = head.stdout.trim()
  const stateDir = path.join(root, '.vast-build', 'local-public-release', `${version}-${sourceCommit}`)
  const statePath = path.join(stateDir, 'status.json')
  const candidateRoot = path.join(stateDir, 'candidate')
  const command = process.argv[2] || 'status'
  const flags = new Set(process.argv.slice(3).filter((arg) => arg.startsWith('--')))
  const canaryIndex = process.argv.indexOf('--canary')
  const canaryPath = canaryIndex < 0 ? null : process.argv[canaryIndex + 1]
  if (!['prepare', 'verify', 'publish', 'status'].includes(command)) throw new Error('Use prepare|verify|publish|status.')
  if ([...flags].some((flag) => !['--retry', '--retry-build', '--canary'].includes(flag))) throw new Error('Unknown release option.')
  if (command === 'status') {
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null
    console.log(JSON.stringify({ version, sourceCommit, statePath, state, currentPid: process.pid }, null, 2))
    return
  }
  if (version !== '0.4.1') throw new Error('This local route is approved only for Vast 0.4.1.')
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (status.status !== 0 || status.stdout.trim()) throw new Error('Release work requires a clean exact source commit.')
  if (!process.env.npm_execpath) throw new Error('Run through npm run release:local:public so npm_execpath is pinned.')
  fs.mkdirSync(stateDir, { recursive: true })
  const lockPath = path.join(stateDir, 'operator.lock')
  function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }
  const initialState = {
    schema: 1, version, sourceCommit, candidateRoot, candidateManifestSha256: null,
    phases: { prepare: 'pending', verify: 'pending', publish: 'pending' },
    steps: [], createdAt: new Date().toISOString()
  }
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : initialState
  if (state.schema !== 1 || state.version !== version || state.sourceCommit !== sourceCommit || state.candidateRoot !== candidateRoot) {
    throw new Error('Existing release state belongs to another source or schema.')
  }
  function save() {
    state.updatedAt = new Date().toISOString()
    const temporary = `${statePath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
    fs.renameSync(temporary, statePath)
  }
  function releaseEnv() {
    const file = path.join(root, '.env.release.local')
    if (!fs.existsSync(file)) throw new Error('Missing .env.release.local for the pinned public build.')
    const parsed = {}
    for (const raw of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!match) throw new Error('Invalid release environment entry.')
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      parsed[match[1]] = value
    }
    validateReleaseFileEnv(parsed, version, sourceCommit)
    const baseUrl = `https://github.com/vstxx/vast-public/releases/download/v${version}`
    const env = {
      ...process.env, ...parsed,
      VAST_RELEASE_COMMIT: sourceCommit,
      VAST_RELEASE_CHANNEL: 'stable', VAST_DISTRIBUTION_CHANNEL: 'direct',
      VAST_PRIVATE_BUILD: '0', VAST_PUBLIC_UNSIGNED_RELEASE: '1',
      VAST_UNSIGNED_RELEASE_ACK: 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK',
      VAST_RELEASE_REPO: 'vstxx/vast-public', VAST_PREVIOUS_VERSION: '0.3.0',
      VAST_PREVIOUS_RELEASE_BASE_URL: 'https://github.com/vstxx/vast-public/releases/download/v0.3.0',
      VAST_UPDATE_MANIFEST_URL: `${baseUrl}/update-manifest.json`,
      VAST_PRODUCTION_RELEASE_BASE_URL: baseUrl,
      VAST_PREVIOUS_SIGNATURE_POLICY: 'unsigned', VAST_CURRENT_SIGNATURE_POLICY: 'unsigned',
      VAST_UPDATE_ENABLED: '1', VAST_OBFUSCATE: '1',
      VAST_RELAY_ENABLED: '1', VAST_RELAY_ENVIRONMENT: 'production',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false', VAST_CANDIDATE_ROOT: candidateRoot
    }
    for (const key of ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD', 'VAST_EXPECTED_SIGNER_SUBJECT']) delete env[key]
    return env
  }
  const env = releaseEnv()
  const npm = (args, extra = {}) => ({ command: process.execPath, args: [process.env.npm_execpath, ...args], env: { ...env, ...extra } })
  const node = (script, args = [], extra = {}) => ({ command: process.execPath, args: [path.join(root, 'scripts', script), ...args], env: { ...env, ...extra } })
  function archiveRelease(suffix) {
    const source = path.join(root, 'release')
    const target = path.join(stateDir, suffix)
    if (!fs.existsSync(source)) return `No old release directory to archive.\n`
    if (fs.lstatSync(source).isSymbolicLink() || fs.existsSync(target) || path.resolve(source) !== path.join(root, 'release')) {
      throw new Error('Release archive target is unsafe or already occupied.')
    }
    fs.renameSync(source, target)
    return `Archived ${source} to ${target}.\n`
  }
  function specification(phase, key) {
    if (phase === 'prepare') {
      if (key === 'dependencies') return npm(['ci'])
      if (key === 'relay-dependencies') return npm(['ci', '--prefix', 'relay'])
      if (key === 'compatibility') return npm(['run', 'extension:compat:prepare'])
      if (key === 'preflight') return npm(['run', 'release:preflight'])
      if (key === 'relay') return npm(['run', 'verify:release-checkin', '--prefix', 'relay'])
      if (key === 'hub') return npm(['run', 'hub:verify:production'])
      if (key === 'avidae-runtime') return npm(['run', 'avidae:runtime:prepare'])
      if (key === 'archive') return { internal: () => archiveRelease('preexisting-release') }
      if (key === 'build') return npm(['run', 'release:public-unsigned'])
      if (key === 'updater-background') return npm(['run', 'test:updater:background'])
      if (key === 'package') return node('verify-release-package.cjs')
      if (key === 'secret-scan') return node('secret-scan.cjs')
      if (key === 'snapshot') {
        const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vast-release-snapshot-')), 'source')
        state.snapshot = snapshot
        save()
        return node('export-public-source-snapshot.mjs', ['--output', snapshot])
      }
      if (key === 'seal') return node('release-candidate.cjs', ['seal'])
      if (key === 'stage') return { internal: () => {
        const { stageCandidate, identity, digest, verifyTree } = require('./release-candidate.cjs')
        if (fs.existsSync(candidateRoot)) verifyTree(candidateRoot, identity(env))
        else stageCandidate(root, identity(env), candidateRoot)
        state.candidateManifestSha256 = digest(path.join(candidateRoot, 'release-candidate.json'))
        save()
        return `Staged immutable candidate at ${candidateRoot}.\n`
      } }
    }
    if (phase === 'verify') {
      if (key === 'candidate-verify') return { internal: () => {
        const { identity } = require('./release-candidate.cjs')
        verifiedCandidateAssets(candidateRoot, identity(env))
        return 'Candidate hashes match seal.\n'
      } }
      if (key === 'clean-install') return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tests/windows-clean-uninstall.test.ps1'), '-InstallerPath', path.join(candidateRoot, 'release', 'Installer', `Vast-Setup-${version}.exe`)], env }
      if (key === 'public-upgrade') return npm(['run', 'test:upgrade:public'], { VAST_CURRENT_RELEASE_ROOT: path.join(candidateRoot, 'release'), VAST_RELEASE_VERSION: version })
    }
    if (phase === 'publish') {
      if (key === 'source') return node('publish-source-snapshot.cjs', [state.snapshot])
      if (key === 'draft') return node('publish-release-assets.cjs', [state.notes])
      if (key === 'draft-verify') return npm(['run', 'release:verify:published'], { VAST_GITHUB_DRAFT_RELEASE: '1' })
      if (key === 'make-public') return { command: 'gh', args: ['release', 'edit', `v${version}`, '--repo', 'vstxx/vast-public', '--draft=false'], env }
      if (key === 'public-verify') return npm(['run', 'release:verify:published'], { VAST_GITHUB_DRAFT_RELEASE: '0' })
    }
    throw new Error(`Unknown release step ${phase}/${key}.`)
  }
  async function runStep(phase, key, setPid) {
    const spec = specification(phase, key)
    const log = path.join(stateDir, `${phase}-${key}.log`)
    const rendered = spec.internal ? `internal:${phase}/${key}` : [spec.command, ...spec.args].map((part) => JSON.stringify(part)).join(' ')
    if (spec.internal) {
      setPid(process.pid, log, rendered)
      fs.writeFileSync(log, spec.internal())
      return { exitCode: 0, log }
    }
    return new Promise((resolve, reject) => {
      const fd = fs.openSync(log, 'a')
      let child
      try { child = spawn(spec.command, spec.args, { cwd: root, env: spec.env, stdio: ['ignore', fd, fd], windowsHide: true }) }
      catch (error) { fs.closeSync(fd); reject(error); return }
      fs.closeSync(fd)
      setPid(child.pid, log, rendered)
      child.once('error', reject)
      child.once('close', (exitCode) => {
        if (exitCode === 0 && phase === 'prepare' && key === 'snapshot') {
          try { state.snapshotSha256 = snapshotDigest(state.snapshot); save() }
          catch (error) { reject(error); return }
        }
        resolve({ exitCode: exitCode ?? 1, log })
      })
    })
  }
  let lockOwned = false
  try {
    if (fs.existsSync(lockPath)) {
      const oldPid = Number(fs.readFileSync(lockPath, 'utf8'))
      if (alive(oldPid)) throw new Error(`Release operator is already running at PID ${oldPid}.`)
      fs.renameSync(lockPath, `${lockPath}.stale-${Date.now()}`)
    }
    const lockFd = fs.openSync(lockPath, 'wx')
    lockOwned = true
    fs.writeSync(lockFd, String(process.pid))
    fs.closeSync(lockFd)
    if (!fs.existsSync(statePath)) save()
    for (const step of state.steps) {
      if (step.status === 'running') {
        if (alive(step.pid)) throw new Error(`${step.key} is still running at PID ${step.pid}; do not launch duplicate work.`)
        step.status = 'interrupted'
        save()
      }
    }
    if (command !== 'prepare' && state.phases.prepare !== 'passed') throw new Error('Prepare must pass before this phase.')
    if (command === 'publish' && state.phases.verify !== 'passed') throw new Error('Verify must pass before publication.')
    if (command !== 'prepare' && state.candidateManifestSha256 !== require('./release-candidate.cjs').digest(path.join(candidateRoot, 'release-candidate.json'))) {
      throw new Error('Staged candidate manifest changed; refuse continuation.')
    }
    if (command !== 'prepare') verifiedCandidateAssets(candidateRoot, require('./release-candidate.cjs').identity(env))
    if (command === 'publish') {
      if (!state.snapshotSha256 || snapshotDigest(state.snapshot) !== state.snapshotSha256) throw new Error('Audited source snapshot changed after preparation.')
      if (!canaryPath || !path.isAbsolute(canaryPath)) throw new Error('Publish requires --canary <absolute reviewed JSON path>.')
      const canary = JSON.parse(fs.readFileSync(canaryPath, 'utf8'))
      assertPublishReady(state, { version, sourceCommit, candidateManifestSha256: state.candidateManifestSha256 }, canary)
      state.canaryReport = canaryPath
      if (!state.notes) {
        state.notes = path.join(stateDir, 'release-notes.md')
        const details = fs.readFileSync(path.join(root, 'docs', `PUBLIC_RELEASE_${version}.md`), 'utf8')
        fs.writeFileSync(state.notes, `# Vast ${version} — PUBLIC UNSIGNED RELEASE\n\nWindows may display Unknown publisher or SmartScreen warnings. These assets are intentionally not Authenticode-signed.\n\nSource commit: ${sourceCommit}\n\n${details}`)
      }
      const token = env.GH_TOKEN || env.VAST_RELEASE_TOKEN || spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true }).stdout?.trim()
      if (!token) throw new Error('GitHub publication token is unavailable; authenticate gh without printing the token.')
      env.GH_TOKEN = token
      env.VAST_RELEASE_TOKEN = token
      env.VAST_PUBLIC_SNAPSHOT_SHA256 = state.snapshotSha256
      save()
    }
    if (command === 'verify') assertCleanInstallAllowed(env)
    state.phases[command] = 'running'
    state.runnerPid = process.pid
    save()
    const keys = releaseSteps[command].map((item) => item.key)
    if (command === 'prepare' && flags.has('--retry-build') && state.steps.some((step) => step.key === 'build' && ['failed', 'interrupted'].includes(step.status))) {
      state.retryArchive = archiveRelease(`failed-release-${Date.now()}`)
      save()
    }
    await executeSteps(state, keys, (key, setPid) => runStep(command, key, setPid), save, {
      retry: flags.has('--retry'), retryBuild: flags.has('--retry-build')
    })
    state.phases[command] = 'passed'
    state.runnerPid = null
    save()
    console.log(JSON.stringify({ ok: true, phase: command, version, sourceCommit, candidateRoot, statePath }))
  } catch (error) {
    if (lockOwned) {
      if (state.phases[command] === 'running') state.phases[command] = 'failed'
      state.runnerPid = null
      save()
    }
    throw error
  } finally {
    if (lockOwned) fs.rmSync(lockPath, { force: true })
  }
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })

module.exports = { assertPublishReady, requiredCanaryChecks, nextStep, executeSteps, publicSourceCommitMessage, verifiedCandidateAssets, assertExpectedReleaseAssets, validateReleaseFileEnv, snapshotDigest, assertCleanInstallAllowed, releaseSteps }
