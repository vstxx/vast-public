const { createHash } = require('node:crypto')
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { basename, dirname, join, relative, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const args = process.argv.slice(2)
function argument(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
function fail(message) {
  console.error(message)
  process.exit(1)
}
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
function recipeRevision() {
  const files = [
    join(root, 'third_party', 'ffmpeg', 'ffmpeg-build.lock.json'),
    join(root, 'third_party', 'ffmpeg', 'scripts', 'build-vast-ffmpeg.sh'),
    join(root, 'scripts', 'build-vast-ffmpeg.ps1'),
    join(root, 'scripts', 'avidae-ffmpeg-capabilities.cjs'),
    join(root, 'scripts', 'generate-vast-ffmpeg-provenance.cjs'),
    join(root, 'scripts', 'check-ffmpeg-release-compliance.cjs')
  ]
  const hash = createHash('sha256')
  for (const file of files) hash.update(basename(file)).update('\0').update(readFileSync(file)).update('\0')
  return hash.digest('hex')
}

const descriptorPath = resolve(root, argument('--descriptor', 'third_party/ffmpeg/ffmpeg-ci-cache.json'))
const archive = resolve(root, argument('--archive', ''))
if (!archive || !existsSync(archive)) fail('The pinned FFmpeg cache archive is missing.')

let descriptor
try {
  descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
} catch {
  fail('The FFmpeg cache descriptor is invalid JSON.')
}
if (descriptor.schemaVersion !== 1) fail('The FFmpeg cache descriptor schema is unsupported.')
const currentRecipeRevision = recipeRevision()
if (descriptor.recipeRevision !== currentRecipeRevision) {
  fail(`The pinned FFmpeg cache does not match the current build recipe. Expected ${descriptor.recipeRevision}, got ${currentRecipeRevision}.`)
}
if (descriptor.assetName !== basename(archive)) fail('The FFmpeg cache asset name does not match its descriptor.')
if (!Number.isSafeInteger(descriptor.size) || descriptor.size !== statSync(archive).size) fail('The FFmpeg cache size does not match its descriptor.')
if (!/^[a-f0-9]{64}$/.test(descriptor.sha256) || descriptor.sha256 !== sha256(archive)) fail('The FFmpeg cache SHA-256 does not match its descriptor.')

const listing = spawnSync('tar', ['-tf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
if (listing.error || listing.status !== 0) fail('The FFmpeg cache archive cannot be listed.')
const entries = String(listing.stdout || '').split(/\r?\n/).filter(Boolean)
if (!entries.length) fail('The FFmpeg cache archive is empty.')
for (const entry of entries) {
  const normalized = entry.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (!normalized.startsWith('ffmpeg/') || normalized.startsWith('/') || segments.includes('..') || /^[A-Za-z]:/.test(normalized)) {
    fail(`The FFmpeg cache contains an unsafe path: ${entry}`)
  }
}
const detailedListing = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
if (detailedListing.error || detailedListing.status !== 0) fail('The FFmpeg cache archive metadata cannot be inspected.')
for (const line of String(detailedListing.stdout || '').split(/\r?\n/).filter(Boolean)) {
  if (!['-', 'd'].includes(line[0])) fail('The FFmpeg cache must contain only regular files and directories.')
}

const buildRoot = resolve(root, '.vast-build')
const output = resolve(buildRoot, 'ffmpeg')
if (dirname(output) !== buildRoot || relative(root, output).startsWith('..')) fail('The FFmpeg cache output path is unsafe.')
mkdirSync(buildRoot, { recursive: true })
rmSync(output, { recursive: true, force: true })
const extraction = spawnSync('tar', ['-xf', archive, '-C', buildRoot], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
if (extraction.error || extraction.status !== 0) fail(`The FFmpeg cache archive could not be extracted: ${extraction.stderr || ''}`)

const provenancePath = join(output, 'runtime', 'ffmpeg-build-provenance.json')
let provenance
try {
  provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
} catch {
  fail('The restored FFmpeg provenance is missing or invalid.')
}
if (provenance.buildRecipeRevision !== descriptor.recipeRevision) fail('The restored FFmpeg provenance does not match the pinned recipe revision.')

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `restored=true\n`)
console.log(JSON.stringify({ ok: true, output, recipeRevision: descriptor.recipeRevision, archiveSha256: descriptor.sha256 }, null, 2))
