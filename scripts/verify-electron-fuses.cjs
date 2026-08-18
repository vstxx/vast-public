const { existsSync } = require('node:fs')
const { resolve } = require('node:path')
const { assertFuseState } = require('./electron-fuses.cjs')

async function main() {
  const executable = resolve(process.argv[2] || '')
  if (!process.argv[2] || !existsSync(executable)) throw new Error('Usage: node scripts/verify-electron-fuses.cjs <packaged-electron-executable>')
  const fuses = await import('@electron/fuses')
  await assertFuseState(executable, fuses)
  console.log(`Verified hardened Electron fuses for ${executable}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
