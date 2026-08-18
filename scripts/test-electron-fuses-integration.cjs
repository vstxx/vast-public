const { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { applyElectronFuses } = require('./electron-fuses.cjs')

const root = join(__dirname, '..')

function sourceElectronPath() {
  const executable = require('electron')
  if (process.platform === 'darwin') return resolve(executable, '..', '..', '..')
  return executable
}

async function main() {
  const source = sourceElectronPath()
  if (!existsSync(source)) throw new Error(`Development Electron binary was not found: ${source}`)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'vast-fuse-integration-'))
  try {
    if (process.platform === 'darwin') cpSync(source, join(temporaryRoot, 'Vast.app'), { recursive: true })
    else copyFileSync(source, join(temporaryRoot, process.platform === 'win32' ? 'Vast.exe' : 'vast'))

    await applyElectronFuses({
      appOutDir: temporaryRoot,
      arch: process.arch,
      packager: {
        platform: { nodeName: process.platform },
        executableName: 'vast',
        appInfo: { productFilename: 'Vast' }
      }
    })
    console.log('Real Electron fuse integration test passed.')
  } finally {
    // mkdtempSync supplies the exact, dedicated target; never clean a caller path.
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
