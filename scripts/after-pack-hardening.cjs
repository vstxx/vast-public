const applyWindowsIcon = require('./apply-windows-icon.cjs')
const { applyElectronFuses } = require('./electron-fuses.cjs')

module.exports = async function afterPackHardening(context) {
  // Both mutations happen in afterPack, before electron-builder performs any
  // platform signing. The fuses are verified from the packaged binary before
  // control returns to the signing pipeline.
  await applyWindowsIcon(context)
  await applyElectronFuses(context)
}
