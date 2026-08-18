const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const rootDir = join(__dirname, '..')

function findRcedit() {
  const candidates = [
    join(rootDir, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
    join(rootDir, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
    join(rootDir, 'node_modules', '@electron', 'windows-installer', 'vendor', 'rcedit.exe')
  ]
  return candidates.find(existsSync) ?? null
}

/**
 * Called by electron-builder as an afterPack hook after win-unpacked is
 * assembled but before the NSIS installer is created.
 *
 * Also callable as a plain CLI script after electron-builder finishes.
 */
async function applyWindowsIcon(context) {
  if (process.platform !== 'win32') {
    console.log('Skipped Windows icon patch on non-Windows platform.')
    return
  }

  const outDir = context?.outDir ?? join(rootDir, 'release')
  const appOutDir = context?.appOutDir ?? join(outDir, 'win-unpacked')
  const iconPath =
    (context?.packager?.getIconPath ? await context.packager.getIconPath() : null) ??
    join(outDir, '.icon-ico', 'icon.ico')
  const executablePath = join(appOutDir, 'Vast.exe')
  const rceditPath = findRcedit()

  if (!existsSync(iconPath)) {
    throw new Error(`Windows icon file not found: ${iconPath}`)
  }
  if (!rceditPath) {
    throw new Error('rcedit.exe not found. Install electron-winstaller or rcedit as a dev dependency.')
  }
  if (!existsSync(executablePath)) {
    throw new Error(`Release executable not found: ${executablePath}`)
  }

  const result = spawnSync(rceditPath, [executablePath, '--set-icon', iconPath], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true
  })

  if (result.status !== 0) {
    throw new Error(`Failed to apply icon to ${executablePath}: ${result.stderr || result.stdout}`)
  }

  console.log(`Applied Windows icon to ${executablePath}`)
}

if (require.main === module) {
  applyWindowsIcon().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
} else {
  module.exports = applyWindowsIcon
}
