const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function credentialReferenceSha256(expectedHashes) {
  if (!expectedHashes || ![expectedHashes.username, expectedHashes.password]
    .every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('Controlled credential hashes must be SHA-256 hex values.')
  }
  return sha256(Buffer.concat([
    Buffer.from(expectedHashes.username, 'hex'),
    Buffer.from(expectedHashes.password, 'hex')
  ]))
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function pidIsLive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function acquireProfileLock(profileRoot, owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || typeof owner?.runId !== 'string' || !owner.runId) {
    throw new Error('A profile lock requires a positive PID and non-empty run ID.')
  }
  fs.mkdirSync(profileRoot, { recursive: true })
  const lockPath = path.join(profileRoot, '.vast-password-manager-gate.lock.json')
  const record = { pid: owner.pid, runId: owner.runId, acquiredAt: new Date().toISOString() }

  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let current
      try { current = JSON.parse(fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, '')) } catch {}
      if (current && pidIsLive(current.pid)) {
        throw new Error(`Profile is already owned by live PID ${current.pid} (run ${current.runId || 'unknown'}).`)
      }
      const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`
      try {
        fs.renameSync(lockPath, stalePath)
        fs.unlinkSync(stalePath)
      } catch (renameError) {
        if (renameError.code !== 'ENOENT') throw renameError
      }
    }
  }

  const lock = {
    path: lockPath,
    pid: owner.pid,
    runId: owner.runId,
    release() { releaseProfileLock(lock) }
  }
  return Object.freeze(lock)
}

function releaseProfileLock(lock) {
  let current
  try { current = JSON.parse(fs.readFileSync(lock.path, 'utf8').replace(/^\uFEFF/, '')) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (current.pid !== lock.pid || current.runId !== lock.runId) {
    throw new Error('Refusing to release a profile lock owned by another controller.')
  }
  fs.unlinkSync(lock.path)
}

function hashOrderedFiles(root, filePaths) {
  const hash = createHash('sha256')
  for (const filePath of filePaths) {
    const absolute = path.resolve(filePath)
    const label = path.relative(root, absolute).replaceAll('\\', '/')
    hash.update(label, 'utf8')
    hash.update(Buffer.from([0]))
    hash.update(fs.readFileSync(absolute))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trimEnd()
}

function exactVersion(value, name) {
  if (typeof value !== 'string') throw new Error(`Missing ${name} version in package.json.`)
  const match = value.match(/\d+\.\d+\.\d+/)
  if (!match) throw new Error(`Invalid ${name} version in package.json: ${value}`)
  return match[0]
}

function workingTreeSha256(root) {
  const hash = createHash('sha256')
  hash.update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root }))
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort()
  for (const relativePath of untracked) {
    hash.update(Buffer.from(relativePath.replaceAll('\\', '/'), 'utf8'))
    hash.update(Buffer.from([0]))
    hash.update(fs.readFileSync(path.join(root, relativePath)))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

function buildRuntimeFingerprint(config) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
  const status = git(config.root, ['status', '--porcelain'])
  const electronPatchPaths = config.electronPatchPaths || [
    path.join(config.root, 'experiments', 'electron-44-patches', '0004-electron-composed-webrequest-lifecycle.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0005-chromium-lifecycle-auth-support.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0006-electron-messaging-split-view-compat.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0007-electron-action-open-popup-event.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0008-electron-extensions-reload-api.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0009-chromium-css-env-fallback.patch'),
    path.join(config.root, 'experiments', 'electron-44-patches', '0010-chromium-css-var-fallback-leading-space.patch')
  ]
  const ecePatchPath = config.ecePatchPath || path.join(config.root, 'patches', 'electron-chrome-extensions-4.9.0-vast.patch')

  return Object.freeze({
    schemaVersion: 1,
    electronVersion: exactVersion(dependencies.electron, 'Electron'),
    electronExecutableSha256: sha256(fs.readFileSync(config.electronExecutable)),
    electronPatchsetSha256: hashOrderedFiles(config.root, electronPatchPaths),
    eceVersion: exactVersion(dependencies['electron-chrome-extensions'], 'ECE'),
    ecePatchSha256: sha256(fs.readFileSync(ecePatchPath)),
    vastCommit: git(config.root, ['rev-parse', 'HEAD']),
    vastDirty: status.length > 0,
    vastDiffSha256: workingTreeSha256(config.root),
    extensions: Object.freeze(config.targets.map((target) => Object.freeze({
      key: target.key,
      version: target.version,
      runtimeId: target.runtimeId,
      manifestSha256: target.manifestSha256,
      crxSha256: target.crxSha256
    })))
  })
}

module.exports = {
  acquireProfileLock,
  buildRuntimeFingerprint,
  credentialReferenceSha256,
  releaseProfileLock,
  writeJsonAtomic
}
