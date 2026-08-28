const { createHash } = require('node:crypto')
const { existsSync, mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, join, resolve } = require('node:path')

const repo = join(__dirname, '..')
const args = process.argv.slice(2)
function argument(name, fallback) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback }
const root = resolve(repo, argument('--root', '.vast-build/ffmpeg'))
const runtime = resolve(argument('--runtime', join(root, 'runtime')))
const sourceBundle = resolve(argument('--source-bundle', join(root, 'ffmpeg-corresponding-source-win64.tar.zst')))
const provenancePath = join(runtime, 'ffmpeg-build-provenance.json')
const lock = JSON.parse(readFileSync(join(repo, 'third_party', 'ffmpeg', 'ffmpeg-build.lock.json'), 'utf8'))
const failures = []
function check(condition, message) { if (!condition) failures.push(message) }
function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }
function hasPersonalWindowsPath(value) {
  const normalized = String(value).replace(/\\\\/g, '/').replace(/\\/g, '/')
  return /(?:[A-Za-z]:\/|\/[A-Za-z]\/)[Uu]sers\/[^/]+/.test(normalized)
}
function run(file, commandArgs) {
  const result = spawnSync(file, commandArgs, { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) { failures.push(`${basename(file)} ${commandArgs.join(' ')} failed`); return '' }
  return `${result.stdout || ''}${result.stderr || ''}`
}

check(existsSync(provenancePath), 'FFmpeg build provenance is missing.')
check(existsSync(sourceBundle), 'FFmpeg corresponding-source archive is missing.')
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
let provenance
try { provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) } catch { failures.push('FFmpeg provenance is invalid JSON.'); provenance = {} }
function runtimeExecutable(name) {
  const candidates = [join(runtime, 'bin', name), join(runtime, 'media', name)]
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
}
const ffmpeg = runtimeExecutable('ffmpeg.exe')
const ffprobe = runtimeExecutable('ffprobe.exe')
for (const [name, file, record] of [['FFmpeg', ffmpeg, provenance.ffmpeg], ['FFprobe', ffprobe, provenance.ffprobe]]) {
  check(existsSync(file), `${name} binary is missing.`)
  if (existsSync(file)) {
    check(record && record.sha256 === sha256(file), `${name} SHA-256 does not match provenance.`)
    check(record && record.size === statSync(file).size, `${name} size does not match provenance.`)
  }
}
check(provenance.schemaVersion === 1, 'FFmpeg provenance schema is unsupported.')
check(provenance.ffmpegVersion === lock.ffmpegVersion && provenance.ffmpegCommit === lock.ffmpegCommit, 'FFmpeg source identity does not match the lock.')
check(provenance.licenseMode === lock.licenseMode, 'FFmpeg license mode does not match the lock.')
check(provenance.sourceBundle?.sha256 === sha256(sourceBundle), 'Corresponding-source archive SHA-256 does not match provenance.')
check(provenance.sourceBundle?.size === statSync(sourceBundle).size, 'Corresponding-source archive size does not match provenance.')
check(Array.isArray(provenance.dependencySources) && provenance.dependencySources.length === lock.sources.length, 'Dependency source provenance is incomplete.')
for (const source of lock.sources) check(provenance.dependencySources?.some((item) => item.id === source.id && item.sha256 === source.sha256 && item.url === source.url), `Source provenance is missing ${source.id}.`)
for (const source of lock.buildToolchain.correspondingSources) {
  check(provenance.toolchain?.correspondingSources?.some((item) => item.archive === source.archive && item.sha256 === source.sha256 && item.signatureSha256 === source.signatureSha256), `Toolchain source provenance is missing ${source.component}.`)
}
const observedToolchain = provenance.toolchain?.observed || {}
check(observedToolchain.gcc === lock.buildToolchain.gcc, 'Observed GCC version does not match the pinned toolchain.')
check(String(observedToolchain.binutils || '').includes(lock.buildToolchain.binutils), 'Observed binutils version does not match the pinned toolchain.')
check(String(observedToolchain.make || '').includes(lock.buildToolchain.make), 'Observed make version does not match the pinned toolchain.')
check(String(observedToolchain.nasm || '').includes(lock.buildToolchain.nasm), 'Observed NASM version does not match the pinned toolchain.')
check(observedToolchain.pkgconf === lock.buildToolchain.pkgconf, 'Observed pkgconf version does not match the pinned toolchain.')
check(!hasPersonalWindowsPath(JSON.stringify(provenance)), 'FFmpeg provenance contains a personal Windows profile path.')
for (const license of ['FFmpeg-GPLv3.txt', 'x264-COPYING.txt', 'libvpx-LICENSE.txt', 'Opus-COPYING.txt', 'libogg-COPYING.txt', 'libvorbis-COPYING.txt', 'LAME-COPYING.txt', 'GCC-GPLv3.txt', 'GCC-Runtime-Library-Exception.txt', 'MinGW-w64-runtime-COPYING.txt', 'libwinpthread-COPYING.txt']) {
  const file = join(runtime, 'licenses', license)
  check(existsSync(file) && statSync(file).size > 100, `Required license is missing: ${license}`)
}
const version = run(ffmpeg, ['-version'])
const buildconf = run(ffmpeg, ['-buildconf'])
const license = run(ffmpeg, ['-L'])
run(ffprobe, ['-version'])
check(version.includes(`ffmpeg version ${lock.ffmpegVersion}`), `Runtime is not FFmpeg ${lock.ffmpegVersion}.`)
check(buildconf.includes('--enable-gpl') && buildconf.includes('--enable-version3'), 'GPL runtime is missing its reviewed GPL/version3 configuration.')
check(!buildconf.includes('--enable-nonfree'), 'Nonfree FFmpeg configuration is forbidden.')
for (const option of lock.configuration.filter((value) => !value.startsWith('--prefix='))) check(buildconf.includes(option), `Runtime configuration is missing ${option}.`)
check(/either version 3 of the License|GPL(?:v| version )?3/i.test(license), 'FFmpeg -L does not identify GPLv3 terms.')
const allowedDlls = new Set(['ADVAPI32.dll', 'AVICAP32.dll', 'bcrypt.dll', 'CRYPT32.dll', 'GDI32.dll', 'KERNEL32.dll', 'msvcrt.dll', 'ncrypt.dll', 'ole32.dll', 'OLEAUT32.dll', 'Secur32.dll', 'SHELL32.dll', 'SHLWAPI.dll', 'ucrtbase.dll', 'USER32.dll', 'WS2_32.dll'])
for (const [binary, dependencies] of Object.entries(provenance.peImports || {})) {
  for (const dependency of dependencies || []) check(allowedDlls.has(dependency) || /^api-ms-win-/i.test(dependency), `${binary} has an unapproved runtime DLL dependency: ${dependency}`)
}
const archive = spawnSync('tar', ['-tf', sourceBundle], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
check(!archive.error && archive.status === 0, 'Corresponding-source archive cannot be read.')
const entries = String(archive.stdout || '')
for (const source of ['ffmpeg-9.0.1', 'x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55', 'libvpx-1.15.2', 'opus-1.5.2', 'libogg-1.3.6', 'libvorbis-1.3.7', 'lame-3.100']) check(entries.includes(`sources/${source}/`), `Corresponding source is missing ${source}.`)
for (const recipe of ['recipe/ffmpeg-build.lock.json', 'recipe/scripts/build-vast-ffmpeg.sh', 'recipe/scripts/package-corresponding-source.sh', 'recipe/windows/build-vast-ffmpeg.ps1', 'recipe/windows/check-ffmpeg-release-compliance.cjs', 'recipe/config.h', 'recipe/config_components.h', 'recipe/config.mak']) check(entries.includes(recipe), `Corresponding source is missing ${recipe}.`)
check(!entries.includes('recipe/config.log'), 'Corresponding source must not expose the configure environment through config.log.')
check(!entries.includes('sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55/config.log'), 'Corresponding source must contain the pristine x264 tree, not its configure environment.')
check(!entries.includes('sources/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55/libx264.a'), 'Corresponding source must not contain x264 build artifacts.')
const sourceAuditRoot = mkdtempSync(join(tmpdir(), 'vast-ffmpeg-source-audit-'))
try {
  const toolchainEntries = lock.buildToolchain.correspondingSources.flatMap((source) => [
    `./toolchain-sources/${source.archive}`,
    `./toolchain-sources/${source.signature}`
  ])
  const recipeEntries = ['./recipe/config.h', './recipe/config_components.h', './recipe/config.mak']
  const extraction = spawnSync('tar', ['-xf', sourceBundle, '-C', sourceAuditRoot, ...toolchainEntries, ...recipeEntries], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  check(!extraction.error && extraction.status === 0, 'Pinned toolchain sources cannot be extracted from the corresponding-source archive.')
  for (const source of lock.buildToolchain.correspondingSources) {
    const archivePath = join(sourceAuditRoot, 'toolchain-sources', source.archive)
    const signaturePath = join(sourceAuditRoot, 'toolchain-sources', source.signature)
    check(existsSync(archivePath) && sha256(archivePath) === source.sha256, `Toolchain source hash does not match for ${source.component}.`)
    check(existsSync(signaturePath) && sha256(signaturePath) === source.signatureSha256, `Toolchain source signature hash does not match for ${source.component}.`)
  }
  for (const entry of recipeEntries) {
    const recipePath = join(sourceAuditRoot, entry.replace(/^\.\//, ''))
    check(existsSync(recipePath) && !hasPersonalWindowsPath(readFileSync(recipePath, 'utf8')), `${entry} contains a personal Windows profile path.`)
  }
} finally {
  rmSync(sourceAuditRoot, { recursive: true, force: true })
}
const capability = provenance.capabilityReport
check(capability?.path === 'avidae-ffmpeg-capabilities.json', 'Capability report provenance path is invalid.')
const capabilityPath = [join(runtime, 'avidae-ffmpeg-capabilities.json'), join(root, 'avidae-ffmpeg-capabilities.json')].find((file) => existsSync(file))
check(capability && capabilityPath && sha256(capabilityPath) === capability.sha256 && statSync(capabilityPath).size === capability.size, 'Capability report is missing or does not match provenance.')
if (capabilityPath) check(!hasPersonalWindowsPath(readFileSync(capabilityPath, 'utf8')), 'Capability report contains a personal Windows profile path.')
if (!args.includes('--skip-capabilities') && existsSync(ffmpeg) && existsSync(ffprobe)) {
  const verificationReport = join(root, 'avidae-ffmpeg-capabilities.verification.json')
  const result = spawnSync(process.execPath, [join(repo, 'scripts', 'avidae-ffmpeg-capabilities.cjs'), '--ffmpeg', ffmpeg, '--ffprobe', ffprobe, '--output', verificationReport], { stdio: 'inherit', windowsHide: true, timeout: 10 * 60_000 })
  check(!result.error && result.status === 0, 'FFmpeg failed the Avidae capability contract.')
}
const report = { ok: failures.length === 0, runtime, sourceBundle, ffmpegVersion: provenance.ffmpegVersion, licenseMode: provenance.licenseMode, failures }
console.log(JSON.stringify(report, null, 2))
if (failures.length) process.exit(1)
