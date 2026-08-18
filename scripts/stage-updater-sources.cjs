const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const sourceRoot = join(root, 'resources', 'updater')
const targetRoot = join(root, 'release', 'Updater')
const requiredFiles = ['VastUpdater.ps1', 'updater.config.json']

for (const file of requiredFiles) {
  const source = join(sourceRoot, file)
  if (!existsSync(source)) {
    throw new Error(`Canonical updater source is missing: ${source}`)
  }
}

mkdirSync(targetRoot, { recursive: true })
for (const file of requiredFiles) {
  copyFileSync(join(sourceRoot, file), join(targetRoot, file))
}

console.log(`Staged ${requiredFiles.length} updater source files in ${targetRoot}`)
