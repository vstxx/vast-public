const { createHash } = require('node:crypto')
const { readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { basename, join, resolve } = require('node:path')

const repo = join(__dirname, '..')
const args = process.argv.slice(2)
function argument(name, fallback) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const buildRoot = resolve(repo, argument('--root', '.vast-build/ffmpeg'))
const runtime = join(buildRoot, 'runtime')
const ffmpeg = join(runtime, 'bin', 'ffmpeg.exe')
const ffprobe = join(runtime, 'bin', 'ffprobe.exe')
const sourceBundle = join(buildRoot, 'ffmpeg-corresponding-source-win64.tar.zst')
const capabilityReport = join(buildRoot, 'avidae-ffmpeg-capabilities.json')
const lockPath = join(repo, 'third_party', 'ffmpeg', 'ffmpeg-build.lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function record(file) { return { path: basename(file), size: statSync(file).size, sha256: sha256(file) } }
function run(file, commandArgs) {
  const result = spawnSync(file, commandArgs, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw result.error || new Error(`${basename(file)} failed: ${result.stderr || result.stdout}`)
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}
function dllDependencies(file) {
  const objdump = process.env.VAST_FFMPEG_OBJDUMP
  if (!objdump) throw new Error('VAST_FFMPEG_OBJDUMP is required to audit PE imports.')
  return [...run(objdump, ['-p', file]).matchAll(/^\s*DLL Name:\s*(.+?)\s*$/gim)].map((match) => match[1]).sort((a, b) => a.localeCompare(b))
}
function recipeRevision() {
  const files = [
    lockPath,
    join(repo, 'third_party', 'ffmpeg', 'scripts', 'build-vast-ffmpeg.sh'),
    join(repo, 'scripts', 'build-vast-ffmpeg.ps1'),
    join(repo, 'scripts', 'avidae-ffmpeg-capabilities.cjs'),
    join(repo, 'scripts', 'generate-vast-ffmpeg-provenance.cjs'),
    join(repo, 'scripts', 'check-ffmpeg-release-compliance.cjs')
  ]
  const hash = createHash('sha256')
  for (const file of files) hash.update(basename(file)).update('\0').update(readFileSync(file)).update('\0')
  return hash.digest('hex')
}

const versionOutput = run(ffmpeg, ['-version'])
const buildconfOutput = run(ffmpeg, ['-buildconf'])
const licenseOutput = run(ffmpeg, ['-L'])
const ffprobeVersionOutput = run(ffprobe, ['-version'])
const actualConfiguration = [...buildconfOutput.matchAll(/^\s+(--\S.*)$/gm)].map((match) => match[1].trim())
const provenance = {
  schemaVersion: 1,
  ffmpegVersion: lock.ffmpegVersion,
  ffmpegCommit: lock.ffmpegCommit,
  licenseMode: lock.licenseMode,
  buildTarget: lock.buildTarget,
  sourceDateEpoch: lock.sourceDateEpoch,
  configuration: actualConfiguration,
  reviewedConfiguration: lock.configuration,
  ffmpeg: record(ffmpeg),
  ffprobe: record(ffprobe),
  sourceBundle: { ...record(sourceBundle), path: basename(sourceBundle) },
  capabilityReport: { ...record(capabilityReport), path: basename(capabilityReport) },
  buildRecipeRevision: recipeRevision(),
  dependencySources: lock.sources,
  toolchain: {
    ...lock.buildToolchain,
    observed: JSON.parse(readFileSync(join(buildRoot, 'toolchain-versions.json'), 'utf8').replace(/^\uFEFF/, ''))
  },
  peImports: { ffmpeg: dllDependencies(ffmpeg), ffprobe: dllDependencies(ffprobe) },
  evidence: { versionOutput, ffprobeVersionOutput, buildconfOutput, licenseOutput },
  runtimeLicenses: readdirSync(join(runtime, 'licenses')).sort().map((name) => ({ name, size: statSync(join(runtime, 'licenses', name)).size, sha256: sha256(join(runtime, 'licenses', name)) }))
}
writeFileSync(join(runtime, 'ffmpeg-build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
writeFileSync(join(runtime, 'README.txt'), `Vast self-built FFmpeg ${lock.ffmpegVersion}\nLicense mode: ${lock.licenseMode}\nExact build provenance: ffmpeg-build-provenance.json\nComplete corresponding source: ${basename(sourceBundle)} (distributed with the same Vast release)\n`)
console.log(JSON.stringify({ ok: true, ffmpeg: provenance.ffmpeg, ffprobe: provenance.ffprobe, sourceBundle: provenance.sourceBundle, peImports: provenance.peImports }, null, 2))
