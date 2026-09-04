const { existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

function windowsSdkTool(name) {
  if (process.platform !== 'win32') throw new Error(`${name} is only available on Windows.`)
  const explicit = String(process.env.VAST_WINDOWS_SDK_BIN ?? '').trim()
  if (explicit) {
    const candidate = join(explicit, name)
    if (existsSync(candidate)) return candidate
    throw new Error(`${name} was not found under VAST_WINDOWS_SDK_BIN.`)
  }
  const kitsRoot = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  if (!existsSync(kitsRoot)) throw new Error('Windows SDK bin directory was not found. Install the current Windows SDK.')
  const versions = readdirSync(kitsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .reverse()
  for (const version of versions) {
    const candidate = join(kitsRoot, version, 'x64', name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`${name} was not found in an x64 Windows SDK tool directory.`)
}

module.exports = { windowsSdkTool }
