const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const args = process.argv.slice(2)
const MiB = 1024 * 1024

function argument(name, fallback) {
  const direct = args.find((value) => value.startsWith(`${name}=`))
  if (direct) return direct.slice(name.length + 1)
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

function repositoryPath(value) {
  const target = isAbsolute(value) ? resolve(value) : resolve(root, value)
  const repositoryRoot = resolve(root)
  if (target !== repositoryRoot && !target.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error('Distribution size budget paths must remain inside the repository.')
  }
  return target
}

function formatMiB(bytes) {
  return `${(bytes / MiB).toFixed(2)} MiB`
}

const reportPath = repositoryPath(argument('--report', join('performance-results', 'distribution-size-audit.json')))
if (!existsSync(reportPath)) throw new Error(`Distribution size audit is missing: ${relative(root, reportPath)}`)
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
if (report.schemaVersion !== 2 || report.appVersion !== pkg.version) {
  throw new Error('Distribution size audit schema or application version is stale.')
}

const artifacts = new Map((report.artifacts || []).map((item) => [item.id, item]))
const components = new Map((report.components || []).map((item) => [item.id, item]))

// Vast Core (installer, Portable, update ZIP, installed tree) and the optional
// Video & Audio module have independent budgets; the module never counts
// toward the default installed footprint. Core limits keep roughly 5-10%
// headroom over the measured 0.5.x Core for Electron security updates.
// Module limits apply only when the module was built in this workspace
// (avidae:module:build); the module release workflow always builds it.
const limits = [
  { id: 'installer', label: 'Core NSIS installer', source: artifacts, maximum: 120 * MiB },
  { id: 'portable', label: 'Core Portable executable', source: artifacts, maximum: 120 * MiB },
  { id: 'updateZip', label: 'Core update ZIP', source: artifacts, maximum: 170 * MiB },
  { id: 'winUnpacked', label: 'Core installed tree (win-unpacked)', source: artifacts, maximum: 450 * MiB },
  { id: 'avidaeInCore', label: 'Video & Audio content inside Core', source: artifacts, maximum: 0 },
  { id: 'appAsar', label: 'app.asar', source: components, maximum: 14 * MiB },
  { id: 'nodeModules', label: 'Packaged node_modules', source: components, maximum: 5 * MiB },
  { id: 'moduleArchive', label: 'Video & Audio module download', source: artifacts, maximum: 400 * MiB, module: true },
  { id: 'moduleInstalled', label: 'Video & Audio module installed', source: artifacts, maximum: 700 * MiB, module: true },
  { id: 'playwright', label: 'Module Playwright runtime', source: components, maximum: 450 * MiB, module: true },
  { id: 'playwrightHeadlessShell', label: 'Module redundant Playwright headless shell', source: components, maximum: 0, module: true },
  { id: 'pyinstaller', label: 'Module PyInstaller runtime', source: components, maximum: 155 * MiB, module: true }
]
const moduleBuilt = Number(artifacts.get('moduleArchive')?.bytes) > 0

const checks = limits.map((limit) => {
  const measured = limit.source.get(limit.id)
  const actual = Number(measured?.bytes)
  if (limit.module && !moduleBuilt) {
    return { id: limit.id, label: limit.label, actual: null, maximum: limit.maximum, pass: true, reason: 'module not built in this workspace' }
  }
  const present = Number.isFinite(actual) && (actual > 0 || limit.maximum === 0)
  return {
    id: limit.id,
    label: limit.label,
    actual: present ? actual : null,
    maximum: limit.maximum,
    pass: present && actual <= limit.maximum,
    reason: !present ? 'missing measurement' : actual > limit.maximum ? `over by ${formatMiB(actual - limit.maximum)}` : 'within budget'
  }
})

const ffmpegBytes = Number(components.get('ffmpeg')?.bytes)
const ffprobeBytes = Number(components.get('ffprobe')?.bytes)
const mediaMaximum = 205 * MiB
const mediaPresent = Number.isFinite(ffmpegBytes) && ffmpegBytes > 0 && Number.isFinite(ffprobeBytes) && ffprobeBytes > 0
checks.push({
  id: 'ffmpegAndFfprobe',
  label: 'Module FFmpeg + FFprobe',
  actual: mediaPresent ? ffmpegBytes + ffprobeBytes : null,
  maximum: mediaMaximum,
  pass: !moduleBuilt || (mediaPresent && ffmpegBytes + ffprobeBytes <= mediaMaximum),
  reason: !moduleBuilt
    ? 'module not built in this workspace'
    : !mediaPresent
      ? 'missing measurement'
      : ffmpegBytes + ffprobeBytes > mediaMaximum
        ? `over by ${formatMiB(ffmpegBytes + ffprobeBytes - mediaMaximum)}`
        : 'within budget'
})

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  appVersion: pkg.version,
  auditReport: relative(root, reportPath).replace(/\\/g, '/'),
  ok: checks.every((check) => check.pass),
  checks
}

const outputPath = repositoryPath(argument('--output', join('performance-results', 'distribution-size-budget.json')))
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log('Vast distribution size budget')
for (const check of checks) {
  console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.label}: ${check.actual === null ? 'missing' : formatMiB(check.actual)} / ${formatMiB(check.maximum)} (${check.reason})`)
}
console.log(`JSON result: ${relative(root, outputPath).replace(/\\/g, '/')}`)

if (!result.ok) {
  const failures = checks.filter((check) => !check.pass).map((check) => `${check.label}: ${check.reason}`)
  throw new Error(`Distribution size budget failed:\n- ${failures.join('\n- ')}`)
}
