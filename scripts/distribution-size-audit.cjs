const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { basename, dirname, join, relative, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)

function argument(name, fallback = '') {
  const direct = args.find((value) => value.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function normalize(path) {
  return path.replace(/\\/g, '/')
}

function safeRelative(base, target) {
  const value = normalize(relative(base, target))
  return value || '.'
}

function filesUnder(directory) {
  if (!directory || !existsSync(directory)) return []
  const pending = [directory]
  const files = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const file = join(current, entry.name)
      if (entry.isDirectory()) pending.push(file)
      else if (entry.isFile()) files.push({ path: file, bytes: statSync(file).size })
    }
  }
  return files
}

function treeBytes(directory) {
  return filesUnder(directory).reduce((sum, item) => sum + item.bytes, 0)
}

function firstExisting(candidates, kind = 'any') {
  return candidates.find((candidate) => {
    if (!candidate || !existsSync(candidate)) return false
    if (kind === 'file') return statSync(candidate).isFile()
    if (kind === 'directory') return statSync(candidate).isDirectory()
    return true
  })
}

function findArtifact(searchRoots, predicate) {
  const matches = searchRoots.flatMap(filesUnder).filter((item) => predicate(basename(item.path), item.path))
  return matches.sort((a, b) => b.bytes - a.bytes)[0]?.path
}

function fileBytes(file) {
  return file && existsSync(file) && statSync(file).isFile() ? statSync(file).size : 0
}

function component(id, label, path, bytes = undefined) {
  const measured = bytes === undefined
    ? (path && existsSync(path) ? (statSync(path).isDirectory() ? treeBytes(path) : statSync(path).size) : 0)
    : bytes
  return { id, label, path: path ? safeRelative(root, path) : null, bytes: measured }
}

function sumAsarNodeModules(asarPath, unpackedRoot) {
  let packedBytes = 0
  let packedFiles = 0
  if (asarPath && existsSync(asarPath)) {
    try {
      const asar = require('@electron/asar')
      for (const entry of asar.listPackage(asarPath)) {
        const normalized = entry.replace(/^[/\\]+/, '')
        if (!normalized.startsWith(`node_modules${sep}`) && !normalized.startsWith('node_modules/')) continue
        try {
          const stat = asar.statFile(asarPath, normalized)
          if (typeof stat.size === 'number' && !stat.unpacked) {
            packedBytes += stat.size
            packedFiles += 1
          }
        } catch {
          // Directories have no file payload to count.
        }
      }
    } catch (error) {
      console.warn(`Could not inspect app.asar node_modules: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const unpackedNodeModules = unpackedRoot ? join(unpackedRoot, 'node_modules') : ''
  const unpackedBytes = treeBytes(unpackedNodeModules)
  return { bytes: packedBytes + unpackedBytes, packedBytes, unpackedBytes, packedFiles, unpackedFiles: filesUnder(unpackedNodeModules).length }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit < 2 ? 0 : 2)} ${units[unit]}`
}

function printTable(rows, columns) {
  const widths = columns.map((column) => Math.max(column.label.length, ...rows.map((row) => String(column.value(row)).length)))
  console.log(columns.map((column, index) => column.label.padEnd(widths[index])).join('  '))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(columns.map((column, index) => {
      const value = String(column.value(row))
      return column.align === 'right' ? value.padStart(widths[index]) : value.padEnd(widths[index])
    }).join('  '))
  }
}

const releaseRoot = resolve(root, argument('--release-root', 'release'))
const runtimeRoot = resolve(root, argument('--runtime-root', join('resources', 'avidae-runtime')))
const explicitWinUnpacked = argument('--win-unpacked')
const winUnpacked = firstExisting([
  explicitWinUnpacked ? resolve(root, explicitWinUnpacked) : '',
  join(releaseRoot, `Vast-${pkg.version}`, 'win-unpacked'),
  join(releaseRoot, 'win-unpacked')
], 'directory')
const searchRoots = [releaseRoot].filter((item) => existsSync(item))
const installer = findArtifact(searchRoots, (name, path) => /^Vast-Setup-.*\.exe$/i.test(name) && !/Updater/i.test(path))
const portable = findArtifact(searchRoots, (name) => /^Vast-.*-Portable\.exe$/i.test(name))
const updateZip = findArtifact(searchRoots, (name) => /^Vast-.*-update\.zip$/i.test(name))
const resources = winUnpacked ? join(winUnpacked, 'resources') : ''
const packagedAvidaeRuntime = firstExisting([resources && join(resources, 'avidae-runtime'), runtimeRoot], 'directory')
const packagedAvidae = firstExisting([resources && join(resources, 'avidae'), join(root, 'resources', 'avidae')], 'directory')
const appAsar = firstExisting([resources && join(resources, 'app.asar')], 'file')
const appAsarUnpacked = firstExisting([resources && join(resources, 'app.asar.unpacked')], 'directory')
const playwrightRoot = firstExisting([packagedAvidaeRuntime && join(packagedAvidaeRuntime, 'ms-playwright')], 'directory')
const mediaRoot = firstExisting([packagedAvidaeRuntime && join(packagedAvidaeRuntime, 'media')], 'directory')
const pyinstallerRoot = firstExisting([packagedAvidaeRuntime && join(packagedAvidaeRuntime, 'VastVideoAudio')], 'directory')
const catAddonRoot = firstExisting(winUnpacked
  ? [resources && join(resources, 'cat-addon')]
  : [join(root, 'resources', 'cat-addon')], 'directory')
const ffmpeg = firstExisting([mediaRoot && join(mediaRoot, 'ffmpeg.exe')], 'file')
const ffprobe = firstExisting([mediaRoot && join(mediaRoot, 'ffprobe.exe')], 'file')
const chromiumDirectories = playwrightRoot && existsSync(playwrightRoot)
  ? readdirSync(playwrightRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^chromium-\d+$/i.test(entry.name)).map((entry) => join(playwrightRoot, entry.name))
  : []
const headlessShellDirectories = playwrightRoot && existsSync(playwrightRoot)
  ? readdirSync(playwrightRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^chromium_headless_shell-\d+$/i.test(entry.name)).map((entry) => join(playwrightRoot, entry.name))
  : []
const playwrightFfmpegDirectories = playwrightRoot && existsSync(playwrightRoot)
  ? readdirSync(playwrightRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^ffmpeg-\d+$/i.test(entry.name)).map((entry) => join(playwrightRoot, entry.name))
  : []
const nodeModules = sumAsarNodeModules(appAsar, appAsarUnpacked)
const winFiles = filesUnder(winUnpacked)
const resourcesBytes = treeBytes(resources)
const localesRoot = winUnpacked ? join(winUnpacked, 'locales') : ''
const localesBytes = treeBytes(localesRoot)
const topLevelRuntimeBytes = winUnpacked
  ? readdirSync(winUnpacked, { withFileTypes: true }).filter((entry) => entry.name !== 'resources' && entry.name !== 'locales').reduce((sum, entry) => sum + (entry.isDirectory() ? treeBytes(join(winUnpacked, entry.name)) : entry.isFile() ? fileBytes(join(winUnpacked, entry.name)) : 0), 0)
  : 0

const artifacts = [
  component('installer', 'NSIS installer', installer),
  component('portable', 'Portable executable', portable),
  component('updateZip', 'Full update ZIP', updateZip),
  component('winUnpacked', 'win-unpacked', winUnpacked),
  component('appAsar', 'app.asar', appAsar),
  component('resources', 'resources total', resources)
]
const components = [
  component('electronRuntime', 'Electron runtime (excluding locales/resources)', winUnpacked, topLevelRuntimeBytes),
  component('locales', 'Electron locales', localesRoot, localesBytes),
  component('appAsar', 'app.asar', appAsar),
  component('nodeModules', 'Packaged node_modules', appAsar, nodeModules.bytes),
  component('appAsarUnpacked', 'app.asar.unpacked', appAsarUnpacked),
  component('avidaeSource', 'Video & Audio source assets', packagedAvidae),
  component('avidaeRuntime', 'Video & Audio runtime total', packagedAvidaeRuntime),
  component('pyinstaller', 'PyInstaller service runtime', pyinstallerRoot),
  component('playwright', 'Playwright browser payload total', playwrightRoot),
  component('playwrightChromium', 'Playwright full Chromium', playwrightRoot, chromiumDirectories.reduce((sum, path) => sum + treeBytes(path), 0)),
  component('playwrightHeadlessShell', 'Playwright headless shell', playwrightRoot, headlessShellDirectories.reduce((sum, path) => sum + treeBytes(path), 0)),
  component('playwrightFfmpeg', 'Playwright recording FFmpeg', playwrightRoot, playwrightFfmpegDirectories.reduce((sum, path) => sum + treeBytes(path), 0)),
  component('ffmpeg', 'FFmpeg', ffmpeg),
  component('ffprobe', 'FFprobe', ffprobe),
  component('catAddon', 'Cat Addon', catAddonRoot)
]
const winUnpackedBytes = artifacts.find((item) => item.id === 'winUnpacked').bytes
const installerBytes = artifacts.find((item) => item.id === 'installer').bytes
for (const item of components) {
  item.shareOfWinUnpacked = winUnpackedBytes ? item.bytes / winUnpackedBytes : 0
  item.estimatedInstallerBytes = winUnpackedBytes && installerBytes ? Math.round(item.bytes * installerBytes / winUnpackedBytes) : 0
}

const top50 = winFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 50).map((item) => ({
  path: safeRelative(winUnpacked, item.path),
  bytes: item.bytes
}))
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  label: argument('--label', 'current'),
  appVersion: pkg.version,
  paths: {
    releaseRoot: safeRelative(root, releaseRoot),
    winUnpacked: winUnpacked ? safeRelative(root, winUnpacked) : null,
    sourceRuntime: existsSync(runtimeRoot) ? safeRelative(root, runtimeRoot) : null
  },
  artifacts,
  components,
  nodeModules,
  browserInstallations: {
    chromium: chromiumDirectories.map((item) => safeRelative(packagedAvidaeRuntime, item)),
    headlessShell: headlessShellDirectories.map((item) => safeRelative(packagedAvidaeRuntime, item)),
    ffmpeg: playwrightFfmpegDirectories.map((item) => safeRelative(packagedAvidaeRuntime, item))
  },
  top50PackagedFiles: top50
}

console.log(`Vast distribution size audit (${report.label}, ${report.appVersion})`)
console.log(`Packaged tree: ${report.paths.winUnpacked || 'not found'}\n`)
printTable(artifacts, [
  { label: 'Artifact', value: (item) => item.label },
  { label: 'Size', value: (item) => formatBytes(item.bytes), align: 'right' }
])
console.log('\nComponent breakdown (installer impact is a proportional estimate; compressed ratios vary by file type)')
printTable(components, [
  { label: 'Component', value: (item) => item.label },
  { label: 'Raw size', value: (item) => formatBytes(item.bytes), align: 'right' },
  { label: 'Raw share', value: (item) => `${(item.shareOfWinUnpacked * 100).toFixed(1)}%`, align: 'right' },
  { label: 'Est. installer', value: (item) => formatBytes(item.estimatedInstallerBytes), align: 'right' }
])
console.log('\nTop 50 largest packaged files')
printTable(top50, [
  { label: 'File', value: (item) => item.path },
  { label: 'Size', value: (item) => formatBytes(item.bytes), align: 'right' }
])

const outputPath = resolve(root, argument('--output', join('performance-results', 'distribution-size-audit.json')))
const resolvedRoot = resolve(root)
if (!outputPath.startsWith(`${resolvedRoot}${sep}`)) throw new Error('Size audit output must remain inside the repository.')
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`\nJSON report: ${safeRelative(root, outputPath)}`)
