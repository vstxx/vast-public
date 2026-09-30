const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

function inspectWindowsPeVersion(executable) {
  if (process.platform !== 'win32') throw new Error('Windows PE version inspection requires Windows')
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'read-windows-pe-version.ps1'),
    '-Executable', executable
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`Could not read PE version: ${result.error?.message || String(result.stderr || result.stdout).trim()}`)
  }
  return JSON.parse(String(result.stdout).trim())
}

function assertVastPeIdentity(info, version) {
  for (const field of ['fileDescription', 'productName']) {
    if (info?.[field] !== 'Vast') throw new Error(`Packaged Vast PE ${field} must be Vast, got ${JSON.stringify(info?.[field])}`)
  }
  for (const field of ['fileVersion', 'productVersion']) {
    if (info?.[field] !== version && info?.[field] !== `${version}.0`) {
      throw new Error(`Packaged Vast PE ${field} must match ${version}, got ${JSON.stringify(info?.[field])}`)
    }
  }
}

module.exports = { inspectWindowsPeVersion, assertVastPeIdentity }
