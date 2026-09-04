const { existsSync, readFileSync } = require('node:fs')
const { join, relative } = require('node:path')
const asar = require('@electron/asar')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const packageCandidates = [
  join(root, 'release', 'win-unpacked'),
  join(root, 'release', `Vast-${pkg.version}`, 'win-unpacked')
]
const packageRoot = packageCandidates.find((candidate) => existsSync(join(candidate, 'Vast.exe'))) || packageCandidates[0]
const executable = join(packageRoot, 'Vast.exe')
const resources = join(packageRoot, 'resources')
const appAsar = join(resources, 'app.asar')
const failures = []

function fail(message) {
  failures.push(message)
}

for (const path of [executable, appAsar]) {
  if (!existsSync(path)) fail(`missing packaged path: ${relative(root, path).replace(/\\/g, '/')}`)
}

if (existsSync(join(resources, 'cat-addon'))) fail('CI package contains removed Cat Addon resources')

if (existsSync(appAsar)) {
  const forbidden = /(?:^|\/)first-party-extensions\/idu-plus(?:[-.\/]|$)|IDU-Plus-by-Vast|IDU-Plus-screenshot|idu-plus-logo|Otfits Grotesk|Audex-Regular|Aligra\.woff2|\.vext$/i
  const forbiddenSource = /IDU-Plus-by-Vast|IDU-Plus-screenshot|idu-plus-logo|first-party-extensions[\\/]idu-plus/i
  for (const entry of asar.listPackage(appAsar)) {
    const portable = String(entry).replace(/\\/g, '/')
    if (forbidden.test(portable)) fail(`app.asar contains excluded asset: ${portable}`)
    if (/\.(?:c?js|mjs|html?|json|ya?ml)$/i.test(portable)) {
      const source = asar.extractFile(appAsar, String(entry).replace(/^\\/, '')).toString('utf8')
      if (forbiddenSource.test(source)) fail(`app.asar contains excluded runtime code: ${portable}`)
    }
  }
  try {
    const metadata = JSON.parse(asar.extractFile(appAsar, 'out\\release-build-metadata.json').toString('utf8'))
    if (metadata.version !== pkg.version) fail(`packaged version ${metadata.version} does not match ${pkg.version}`)
  } catch (error) {
    fail(`could not validate packaged release metadata: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (existsSync(executable)) {
  const { spawnSync } = require('node:child_process')
  const fuseCheck = spawnSync(process.execPath, [join(root, 'scripts', 'verify-electron-fuses.cjs'), executable], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  })
  if (fuseCheck.error || fuseCheck.status !== 0) fail(`packaged Electron fuse verification failed: ${fuseCheck.error?.message || String(fuseCheck.stderr || fuseCheck.stdout).trim()}`)
}

console.log(JSON.stringify({ ok: failures.length === 0, packageRoot, version: pkg.version, failures }, null, 2))
if (failures.length) process.exit(1)
