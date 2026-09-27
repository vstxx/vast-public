const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'win32') throw new Error('The real iCloud Passwords smoke test requires Windows.')

const root = path.resolve(__dirname, '..')
const extensionId = 'pejdijmoenmkgeppbflobdenhhabjlaj'
const extensionRoot = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', extensionId)
const profile = path.resolve(process.env.VAST_ICLOUD_SMOKE_PROFILE || path.join(root, '.vast-build', 'password-manager-gates', 'profiles', 'icloud-smoke'))
const evidenceRoot = path.join(root, '.vast-build', 'password-manager-gates', 'icloud-smoke', new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-'))
const resultPath = path.join(evidenceRoot, 'result.json')
const electronExecutable = process.env.VAST_PATCHED_ELECTRON_DIST
  ? path.join(process.env.VAST_PATCHED_ELECTRON_DIST, 'electron.exe')
  : 'D:\\VastElectron44\\src\\out\\VastCompat\\electron.exe'
let appProcess

function assert(value, message) { if (!value) throw new Error(message) }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function writeResult(result) {
  fs.mkdirSync(evidenceRoot, { recursive: true })
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`)
}

function latestVersionDirectory() {
  assert(fs.existsSync(extensionRoot), `Official iCloud Passwords extension was not found under ${extensionRoot}`)
  const versions = fs.readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(extensionRoot, entry.name, 'manifest.json')))
    .map((entry) => ({ name: entry.name, path: path.join(extensionRoot, entry.name) }))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }))
  assert(versions.length > 0, 'No installed iCloud Passwords extension version was found.')
  return versions[0]
}

function seedRegistry(extensionPath, manifest) {
  const registryDirectory = path.join(profile, 'Extensions')
  const registryPath = path.join(registryDirectory, 'registry.json')
  fs.mkdirSync(registryDirectory, { recursive: true })
  let registry = { schemaVersion: 2, extensions: [] }
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) } catch {}
  const now = Date.now()
  const entry = {
    id: extensionId,
    name: 'iCloud Passwords',
    version: manifest.version,
    description: 'Official locally installed Apple iCloud Passwords extension.',
    path: extensionPath,
    enabled: true,
    source: 'unpacked',
    runtime: 'chrome',
    manifestVersion: manifest.manifest_version,
    installedAt: registry.extensions?.find((item) => item.id === extensionId)?.installedAt || now,
    updatedAt: now,
    allowFileAccess: false
  }
  registry.extensions = [...(registry.extensions || []).filter((item) => item.id !== extensionId), entry]
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)
}

async function targets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    return response.ok ? response.json() : []
  } catch { return [] }
}

function appleHostRegistration() {
  try {
    const output = execFileSync('reg', ['query', 'HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.apple.passwordmanager'], { encoding: 'utf8', windowsHide: true })
    const match = output.match(/REG_SZ\s+(.+)$/m)
    return match?.[1]?.trim()
  } catch { return undefined }
}

function appleHostPids() {
  try {
    const output = execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process -Name iCloudPasswordsExtensionHelper -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','"], { encoding: 'utf8', windowsHide: true })
    return new Set(output.trim().split(',').map((value) => Number.parseInt(value, 10)).filter(Number.isSafeInteger))
  } catch { return new Set() }
}

async function stop() {
  if (!appProcess || appProcess.exitCode !== null) return
  try { execFileSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
  await new Promise((resolve) => appProcess.once('exit', resolve))
}

async function main() {
  const selected = latestVersionDirectory()
  const manifest = JSON.parse(fs.readFileSync(path.join(selected.path, 'manifest.json'), 'utf8'))
  assert(manifest.key, 'The official iCloud Passwords extension manifest does not contain its upstream identity key.')
  assert(manifest.permissions?.includes('nativeMessaging'), 'The official extension does not declare nativeMessaging.')
  const hostManifestPath = appleHostRegistration()
  assert(hostManifestPath && fs.existsSync(hostManifestPath), 'Apple native host registration is missing or points to a missing manifest.')
  const hostManifest = JSON.parse(fs.readFileSync(hostManifestPath, 'utf8'))
  assert(hostManifest.name === 'com.apple.passwordmanager', 'Apple native host registration has the wrong name.')
  assert(hostManifest.allowed_origins?.includes(`chrome-extension://${extensionId}/`), 'Apple native host does not allow the official extension ID.')
  seedRegistry(selected.path, manifest)
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const initialHostPids = appleHostPids()

  const remotePort = 14700 + Math.floor(Math.random() * 250)
  const stderr = []
  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: profile,
    VAST_EXTENSION_COMPATIBILITY: '1',
    VAST_PATCHED_ELECTRON_COMPAT: '1',
    VAST_PATCHED_ELECTRON_DIST: path.dirname(electronExecutable),
    VAST_RELAY_ENABLED: '0',
    VAST_RELAY_TEST_OFFLINE: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  appProcess = spawn(electronExecutable, [`--remote-debugging-port=${remotePort}`, root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  appProcess.stderr.on('data', (data) => stderr.push(String(data)))

  let workerObserved = false
  let nativeHostProcessObserved = false
  let runtimeId
  const startedAt = new Date().toISOString()
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const list = await targets(remotePort)
    const worker = list.find((target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'))
    if (worker) {
      runtimeId = worker.url.split('/')[2]
      if (runtimeId === extensionId) workerObserved = true
    }
    if ([...appleHostPids()].some((pid) => !initialHostPids.has(pid))) nativeHostProcessObserved = true
    if (workerObserved && nativeHostProcessObserved) break
    await wait(250)
  }
  const registry = JSON.parse(fs.readFileSync(path.join(profile, 'Extensions', 'registry.json'), 'utf8'))
  const persisted = registry.extensions?.find((entry) => entry.id === extensionId)
  const result = {
    schema: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    extension: { expectedId: extensionId, runtimeId: runtimeId || persisted?.runtimeExtensionId || null, version: manifest.version },
    nativeHost: { name: hostManifest.name, registered: true, relativePath: !path.isAbsolute(hostManifest.path), processObserved: nativeHostProcessObserved },
    checks: {
      upstreamIdPreserved: (runtimeId || persisted?.runtimeExtensionId) === extensionId,
      serviceWorkerObserved: workerObserved,
      nativeHostProcessObserved,
      stderrHasUnhandledFailure: /unhandled rejection|uncaught exception/i.test(stderr.join(''))
    },
    passed: workerObserved && nativeHostProcessObserved && (runtimeId || persisted?.runtimeExtensionId) === extensionId && !/unhandled rejection|uncaught exception/i.test(stderr.join('')),
    profile,
    note: 'Structural smoke only; no vault values, native-message payloads, or credentials were read or logged.'
  }
  writeResult(result)
  console.log(JSON.stringify({ ...result, resultPath }, null, 2))
  if (!result.passed) process.exitCode = 1
}

main().catch((error) => {
  writeResult({ schema: 1, passed: false, error: error instanceof Error ? error.message : String(error), profile })
  console.error(error)
  process.exitCode = 1
}).finally(stop)
