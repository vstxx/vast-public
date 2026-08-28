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
if (report.schemaVersion !== 1 || report.appVersion !== pkg.version) {
  throw new Error('Distribution size audit schema or application version is stale.')
}

const artifacts = new Map((report.artifacts || []).map((item) => [item.id, item]))
const components = new Map((report.components || []).map((item) => [item.id, item]))

// Measured from the optimized 0.1.5 Windows x64 package, with roughly 5-10%
// headroom for runtime security updates. app.asar/node_modules retain additional
// headroom because ordinary application code should not require a runtime reset.
const limits = [
  { id: 'installer', label: 'NSIS installer', source: artifacts, maximum: 350 * MiB },
  { id: 'portable', label: 'Portable executable', source: artifacts, maximum: 310 * MiB },
  { id: 'updateZip', label: 'Full update ZIP', source: artifacts, maximum: 495 * MiB },
  { id: 'winUnpacked', label: 'win-unpacked', source: artifacts, maximum: 1200 * MiB },
  { id: 'avidaeRuntime', label: 'Video & Audio runtime', source: components, maximum: 810 * MiB },
  { id: 'playwright', label: 'Playwright runtime', source: components, maximum: 450 * MiB },
  { id: 'playwrightHeadlessShell', label: 'Redundant Playwright headless shell', source: components, maximum: 0 },
  { id: 'pyinstaller', label: 'PyInstaller runtime', source: components, maximum: 155 * MiB },
  { id: 'appAsar', label: 'app.asar', source: components, maximum: 14 * MiB },
  { id: 'nodeModules', label: 'Packaged node_modules', source: components, maximum: 5 * MiB }
]

const checks = limits.map((limit) => {
  const measured = limit.source.get(limit.id)
  const actual = Number(measured?.bytes)
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
  label: 'FFmpeg + FFprobe',
  actual: mediaPresent ? ffmpegBytes + ffprobeBytes : null,
  maximum: mediaMaximum,
  pass: mediaPresent && ffmpegBytes + ffprobeBytes <= mediaMaximum,
  reason: !mediaPresent
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
