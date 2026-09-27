const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve, join, relative } = require('node:path')
const { spawnSync } = require('node:child_process')

const ECE_VERSION = '4.9.0'
const PATCH_SHA256 = '002c90dd134e6a203ad05438939563c415f95b02d3fa75f1de93d1dfd5b8d865'
const RUNTIME_SHA256 = '2658339fb6f278c1f602ecb04ab4bb9b71705a5880200c062c896bb20c3db334'
const PATCHED_FILES = [
  'dist/chrome-extension-api.preload.js',
  'dist/cjs/index.js',
  'dist/esm/index.mjs',
  'dist/types/browser/impl.d.ts'
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path.`)
  return value
}

const repositoryRoot = resolve(__dirname, '..')
const packageRoot = resolve(optionValue('--root') || join(repositoryRoot, 'node_modules', 'electron-chrome-extensions'))
const patchPath = join(repositoryRoot, 'patches', 'electron-chrome-extensions-4.9.0-vast.patch')
const checkOnly = process.argv.includes('--check')

function gitApply(args, allowFailure = false) {
  const result = spawnSync('git', ['apply', ...args, patchPath], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: resolve(packageRoot, '..') },
    windowsHide: true
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git apply exited ${result.status}`).trim())
  }
  return result.status === 0
}

function runtimeFingerprint() {
  const hash = createHash('sha256')
  for (const path of PATCHED_FILES) {
    hash.update(path)
    hash.update(Buffer.from([0]))
    hash.update(readFileSync(join(packageRoot, path)))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
if (pkg.version !== ECE_VERSION) {
  throw new Error(`Expected electron-chrome-extensions ${ECE_VERSION}, found ${pkg.version}`)
}

const actualPatchSha256 = sha256(readFileSync(patchPath))
if (actualPatchSha256 !== PATCH_SHA256) {
  throw new Error(`ECE patch SHA-256 mismatch: expected ${PATCH_SHA256}, found ${actualPatchSha256}`)
}

const canApply = gitApply(['--check'], true)
const isApplied = gitApply(['--reverse', '--check'], true)
if (canApply === isApplied) {
  throw new Error('ECE runtime is neither the pristine pinned package nor the exact approved patched state.')
}

if (checkOnly) {
  if (!isApplied) throw new Error('ECE approved patch is not applied.')
} else {
  if (isApplied) throw new Error('ECE approved patch is already applied; refusing to stack it.')
  gitApply(['--whitespace=nowarn'])
  if (!gitApply(['--reverse', '--check'], true)) throw new Error('ECE patch application could not be verified.')
}

const actualRuntimeSha256 = runtimeFingerprint()
if (actualRuntimeSha256 !== RUNTIME_SHA256) {
  throw new Error(`ECE runtime SHA-256 mismatch: expected ${RUNTIME_SHA256}, found ${actualRuntimeSha256}`)
}

const report = Object.freeze({
  eceVersion: ECE_VERSION,
  patch: relative(repositoryRoot, patchPath).replaceAll('\\', '/'),
  patchSha256: actualPatchSha256,
  runtimeSha256: actualRuntimeSha256,
  state: 'patched'
})

console.log(`ECE ${ECE_VERSION} approved patch ${checkOnly ? 'verified' : 'applied'}.`)
console.log(JSON.stringify(report))

module.exports = { ECE_VERSION, PATCH_SHA256, RUNTIME_SHA256, PATCHED_FILES, report }
