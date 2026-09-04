const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')

const repo = resolve(__dirname, '..')
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

const root = resolve(repo, argument('--root', '.vast-build/ffmpeg'))
const sourceBundle = join(root, 'ffmpeg-corresponding-source-win64.tar.zst')
const provenancePath = join(root, 'runtime', 'ffmpeg-build-provenance.json')
const recipeFiles = [
  ['third_party/ffmpeg/ffmpeg-build.lock.json', 'recipe/ffmpeg-build.lock.json', true],
  ['third_party/ffmpeg/scripts/build-vast-ffmpeg.sh', 'recipe/scripts/build-vast-ffmpeg.sh', true],
  ['third_party/ffmpeg/scripts/package-corresponding-source.sh', 'recipe/scripts/package-corresponding-source.sh', false],
  ['scripts/build-vast-ffmpeg.ps1', 'recipe/windows/build-vast-ffmpeg.ps1', true],
  ['scripts/avidae-ffmpeg-capabilities.cjs', 'recipe/windows/avidae-ffmpeg-capabilities.cjs', true],
  ['scripts/generate-vast-ffmpeg-provenance.cjs', 'recipe/windows/generate-vast-ffmpeg-provenance.cjs', true],
  ['scripts/check-ffmpeg-release-compliance.cjs', 'recipe/windows/check-ffmpeg-release-compliance.cjs', true]
]

if (!existsSync(sourceBundle)) fail('The FFmpeg corresponding-source archive is missing.')
let provenance
try {
  provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
} catch {
  fail('The FFmpeg provenance is missing or invalid.')
}

const revision = createHash('sha256')
for (const [repoPath, , partOfRevision] of recipeFiles) {
  if (!partOfRevision) continue
  const file = join(repo, repoPath)
  revision.update(basename(file)).update('\0').update(readFileSync(file)).update('\0')
}
const expectedRevision = revision.digest('hex')
if (provenance.buildRecipeRevision !== expectedRevision) {
  fail(`FFmpeg provenance recipe mismatch. Expected ${expectedRevision}, got ${provenance.buildRecipeRevision || 'missing'}.`)
}

const auditRoot = mkdtempSync(join(tmpdir(), 'vast-ffmpeg-recipe-audit-'))
try {
  const archivePaths = recipeFiles.map(([, archivePath]) => `./${archivePath}`)
  const extraction = spawnSync('tar', ['-xf', sourceBundle, '-C', auditRoot, ...archivePaths], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
  if (extraction.error || extraction.status !== 0) fail('The exact FFmpeg recipe cannot be extracted from corresponding source.')
  for (const [repoPath, archivePath] of recipeFiles) {
    const source = join(repo, repoPath)
    const archived = join(auditRoot, archivePath)
    if (!existsSync(archived) || sha256(source) !== sha256(archived)) {
      fail(`Corresponding source contains a stale FFmpeg recipe file: ${archivePath}`)
    }
  }
} finally {
  rmSync(auditRoot, { recursive: true, force: true })
}

console.log(JSON.stringify({ ok: true, buildRecipeRevision: expectedRevision, recipeFiles: recipeFiles.length }, null, 2))
