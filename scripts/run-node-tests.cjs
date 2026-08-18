const { existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = join(__dirname, '..')
const testsRoot = join(root, 'tests')

function collect(dir) {
  const entries = readdirSync(dir)
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) files.push(...collect(full))
    else if (entry.endsWith('.test.ts')) files.push(full)
  }
  return files
}

const catAssetArchive = join(root, 'assets', 'cat-addon', 'Cat_85_Animations.zip')
const catAssetTests = new Set([
  join(testsRoot, 'main', 'cat-addon-assets.test.ts'),
  join(testsRoot, 'main', 'cat-addon-manager.test.ts'),
  join(testsRoot, 'renderer', 'cat-addon-engine.test.ts'),
])

const files = collect(testsRoot).filter((file) => {
  if (file.includes(`${join('tests', 'updater')}`)) return false
  return existsSync(catAssetArchive) || !catAssetTests.has(file)
})

if (!existsSync(catAssetArchive)) {
  console.log('Cat Addon artwork is not part of the public source export; skipping 3 asset-dependent tests.')
}
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    VAST_RELEASE_CHANNEL: process.env.VAST_RELEASE_CHANNEL || 'dev',
  }
})

process.exit(result.status ?? 1)
