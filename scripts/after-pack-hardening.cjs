const { existsSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { join, resolve, sep } = require('node:path')
const applyWindowsIcon = require('./apply-windows-icon.cjs')
const { applyElectronFuses } = require('./electron-fuses.cjs')

async function enforceDistributionFeatures(context) {
  if (process.env.VAST_RELEASE_CHANNEL !== 'beta') return

  const resourcesRoot = resolve(context.appOutDir, 'resources')
  const catAddonRoot = resolve(join(resourcesRoot, 'cat-addon'))
  if (!catAddonRoot.startsWith(`${resourcesRoot}${sep}`)) {
    throw new Error('Refusing to resolve beta Cat Addon cleanup outside packaged resources.')
  }

  await rm(catAddonRoot, { recursive: true, force: true })
  if (existsSync(catAddonRoot)) throw new Error('Cat Addon remained in the beta package.')
}

module.exports = async function afterPackHardening(context) {
  // Both mutations happen in afterPack, before electron-builder performs any
  // platform signing. The fuses are verified from the packaged binary before
  // control returns to the signing pipeline.
  await enforceDistributionFeatures(context)
  await applyWindowsIcon(context)
  await applyElectronFuses(context)
}
