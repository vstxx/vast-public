const { spawnSync } = require('node:child_process')
const path = require('node:path')

const verifier = path.join(__dirname, 'verify-all-pe-signatures.ps1')

function runAudit(root, allowFailure) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', verifier, '-Root', root],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
  )
  const reportLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'))
  if (!reportLine) {
    throw new Error(`PE Authenticode audit did not produce a report.\n${result.stderr || result.stdout}`)
  }
  let report
  try {
    report = JSON.parse(reportLine)
  } catch (error) {
    throw new Error(`PE Authenticode audit produced invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!allowFailure && (result.status !== 0 || !report.ok)) {
    throw new Error(`PE Authenticode audit failed after signing for ${report.failureCount} file(s).\n${result.stderr}`)
  }
  return report
}

module.exports = async function afterSignAllPortableExecutables(context) {
  if (process.platform !== 'win32' || context.electronPlatformName !== 'win32') return
  if (context.packager?.platformSpecificBuildOptions?.signExecutable === false) {
    const privateUnsigned = process.env.VAST_PRIVATE_BUILD === '1' && process.env.VAST_ALLOW_UNSIGNED_PRIVATE_BUILD === '1'
    const acknowledgedPublicRelease =
      ['beta', 'stable'].includes(process.env.VAST_RELEASE_CHANNEL) &&
      process.env.VAST_PUBLIC_UNSIGNED_RELEASE === '1' &&
      process.env.VAST_UNSIGNED_RELEASE_ACK === 'I_ACCEPT_UNSIGNED_PUBLIC_RELEASE_RISK'
    if (!privateUnsigned && !acknowledgedPublicRelease) {
      throw new Error('PE signing was disabled without an authorized unsigned-build policy.')
    }
    console.log('[store-readiness] All-PE Authenticode signing skipped for an explicitly authorized unsigned build.')
    return
  }
  if (typeof context.packager?.signIf !== 'function') {
    throw new Error('The Windows packager does not expose signIf(); refusing to create a partially signed runtime.')
  }

  const initial = runAudit(context.appOutDir, true)
  for (const failure of initial.failures) {
    const candidate = path.resolve(context.appOutDir, ...String(failure.path).split('/'))
    const relative = path.relative(context.appOutDir, candidate)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`PE audit returned an unsafe path: ${failure.path}`)
    }
    const signed = await context.packager.signIf(candidate)
    if (!signed) throw new Error(`Failed to Authenticode-sign shipped PE: ${failure.path}`)
  }

  const finalReport = runAudit(context.appOutDir, false)
  console.log(`[store-readiness] Authenticode-valid shipped PEs: ${finalReport.validCount}/${finalReport.peCount}`)
}
