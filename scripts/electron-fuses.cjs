const { existsSync } = require('node:fs')
const { join } = require('node:path')

const REQUIRED_ELECTRON_FUSES = Object.freeze({
  RunAsNode: false,
  EnableCookieEncryption: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true
})

function packagedElectronPath(context) {
  if (!context?.appOutDir || !context?.packager?.appInfo) throw new Error('Electron fuse hook requires an electron-builder afterPack context.')
  const platform = context.packager.platform?.nodeName ?? process.platform
  const productFilename = context.packager.appInfo.productFilename
  if (platform === 'darwin') return join(context.appOutDir, `${productFilename}.app`)
  if (platform === 'win32') return join(context.appOutDir, `${productFilename}.exe`)
  const executableName = context.packager.executableName ?? productFilename.toLowerCase()
  return join(context.appOutDir, executableName)
}

function fuseConfig(fuses, platform, arch) {
  const arm64 = arch === 'arm64' || arch === 3 || arch === '3'
  const config = {
    version: fuses.FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: platform === 'darwin' && arm64
  }
  for (const [name, enabled] of Object.entries(REQUIRED_ELECTRON_FUSES)) {
    const option = fuses.FuseV1Options[name]
    if (option === undefined) throw new Error(`Installed @electron/fuses does not expose ${name}.`)
    config[option] = enabled
  }
  return config
}

async function assertFuseState(pathToElectron, fuses) {
  const current = await fuses.getCurrentFuseWire(pathToElectron)
  for (const [name, expected] of Object.entries(REQUIRED_ELECTRON_FUSES)) {
    const option = fuses.FuseV1Options[name]
    const expectedState = expected ? fuses.FuseState.ENABLE : fuses.FuseState.DISABLE
    if (current[option] !== expectedState) throw new Error(`Electron fuse verification failed for ${name}.`)
  }
}

async function applyElectronFuses(context) {
  const pathToElectron = packagedElectronPath(context)
  if (!existsSync(pathToElectron)) throw new Error(`Packaged Electron executable was not found: ${pathToElectron}`)
  const fuses = await import('@electron/fuses')
  const platform = context.packager.platform?.nodeName ?? process.platform
  const arch = context.arch
  await fuses.flipFuses(pathToElectron, fuseConfig(fuses, platform, arch))
  await assertFuseState(pathToElectron, fuses)
  console.log(`Applied and verified hardened Electron fuses for ${pathToElectron}`)
}

module.exports = {
  REQUIRED_ELECTRON_FUSES,
  applyElectronFuses,
  assertFuseState,
  fuseConfig,
  packagedElectronPath
}
