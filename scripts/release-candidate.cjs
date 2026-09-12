const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { candidatePaths } = require('./release-files.cjs')
const root = path.join(__dirname, '..')
const manifestName = 'release-candidate.json'
function digest(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  const fd = fs.openSync(file, 'r')
  try { let size; while ((size = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, size)) } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
function regularFile(directory, relative) {
  let file = directory
  for (const segment of relative.split('/')) {
    file = path.join(file, segment)
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Candidate contains a symlink: ${relative}`)
  }
  if (!fs.statSync(file).isFile()) throw new Error(`Candidate is not a regular file: ${relative}`)
  return file
}
function identity(env = process.env) {
  const result = { version: require('../package.json').version, sourceCommit: env.VAST_RELEASE_COMMIT, channel: env.VAST_RELEASE_CHANNEL, unsigned: env.VAST_PUBLIC_UNSIGNED_RELEASE === '1' }
  validateIdentity(result)
  return result
}
function validateIdentity(value) {
  if (!value || !/^[a-f0-9]{40}$/.test(value.sourceCommit) || !['beta', 'stable'].includes(value.channel) || typeof value.unsigned !== 'boolean') throw new Error('Candidate requires a full source SHA, public channel and signing mode')
  candidatePaths(value.version, value.unsigned)
}
function validateManifest(value) {
  validateIdentity(value)
  if (value.schema !== 2) throw new Error('Unsupported candidate schema; build a new candidate from this workflow revision')
  const expected = candidatePaths(value.version, value.unsigned)
  if (!Array.isArray(value.files) || JSON.stringify(value.files.map(file => file.path)) !== JSON.stringify(expected)) throw new Error('Candidate file set differs from canonical deliverables')
  const names = new Set([manifestName])
  for (const file of value.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.asset !== path.posix.basename(file.path) || names.has(file.asset)) throw new Error('Invalid candidate hash, size or asset mapping')
    names.add(file.asset)
  }
}
function inventory(directory, info) {
  const paths = candidatePaths(info.version, info.unsigned)
  // These are generated for local tooling/the ZIP, never public assets.
  const intermediates = new Set(['Updater/updater.config.json', 'Updater/README.md', 'Updater/VastUpdater.ps1', 'Updater/update-manifest.sample.json', 'Docs/technical-update-notes.md', 'Docs/updater-runbook.md'])
  function scan(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`
      if (entry.isDirectory()) scan(name)
      else if (entry.isSymbolicLink() || (!paths.includes(name) && !intermediates.has(name.slice('release/'.length)))) throw new Error(`Unexpected candidate deliverable: ${name}`)
    }
  }
  for (const folder of ['Installer', 'Updater', 'Downloads', 'Checksums', 'Docs', 'Source']) scan(`release/${folder}`)
  return paths.map(relative => {
    const file = regularFile(directory, relative)
    return { path: relative, asset: path.posix.basename(relative), sha256: digest(file), bytes: fs.statSync(file).size }
  })
}
function inspect(directory, info) {
  const actual = { schema: 2, ...info, files: inventory(directory, info) }
  validateManifest(actual)
  return actual
}
function verify(expected, actual) {
  validateManifest(expected)
  validateManifest(actual)
  for (const key of ['version', 'sourceCommit', 'channel', 'unsigned']) {
    if (expected[key] !== actual[key]) throw new Error(`Candidate ${key} mismatch; select the same source SHA, channel and signing workflow.`)
  }
  if (JSON.stringify(expected.files) !== JSON.stringify(actual.files)) throw new Error('Candidate files/hashes differ; refuse to rebuild or overwrite published assets. Restore the original verified candidate.')
}
function verifyTree(directory, info) {
  const expected = JSON.parse(fs.readFileSync(regularFile(directory, manifestName), 'utf8'))
  verify(expected, inspect(directory, info))
  return expected
}
function stageCandidate(directory, info, staging) {
  const manifest = verifyTree(directory, info)
  fs.mkdirSync(path.dirname(staging), { recursive: true })
  fs.mkdirSync(staging)
  for (const relative of [...manifest.files.map(file => file.path), manifestName]) {
    const target = path.join(staging, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(regularFile(directory, relative), target, fs.constants.COPYFILE_EXCL)
  }
  verifyTree(staging, info)
}
if (require.main === module) {
  const info = identity()
  if (process.argv[2] === 'seal') fs.writeFileSync(path.join(root, manifestName), JSON.stringify(inspect(root, info), null, 2) + '\n')
  else if (process.argv[2] === 'verify') verifyTree(root, info)
  else if (process.argv[2] === 'stage') stageCandidate(root, info, path.join(root, '.vast-build', 'candidate'))
  else throw new Error('Use release-candidate.cjs seal|verify|stage')
  console.log(`Candidate ${process.argv[2]} passed: ${info.version} / ${info.sourceCommit}`)
}
module.exports = { verify, verifyTree, inspect, identity, validateManifest, digest, regularFile, manifestName, stageCandidate }
