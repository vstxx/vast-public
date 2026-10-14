const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { browserSession, waitForWorkerVersion } = require('./password-manager-gate/probe-worker-lifecycle.cjs')
const { WorkerCdpSession } = require('./password-manager-gate/controller.cjs')

if (process.platform !== 'win32') throw new Error('This iCloud lifecycle probe requires Windows.')
const root = path.resolve(__dirname, '..')
const extensionId = 'pejdijmoenmkgeppbflobdenhhabjlaj'
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
if (!dist) throw new Error('VAST_PATCHED_ELECTRON_DIST is required.')
const executable = path.join(dist, 'electron.exe')
const extensionRoot = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', extensionId)
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-icloud-lifecycle-'))
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><title>iCloud lifecycle fixture</title><h1>iCloud lifecycle fixture</h1>')
})
let child

function helperPids() {
  if (!child?.pid) return []
  const command = `@(Get-CimInstance Win32_Process -Filter "Name='iCloudPasswordsExtensionHelper.exe'" | Where-Object { $_.ParentProcessId -eq ${child.pid} } | ForEach-Object ProcessId) -join ','`
  const output = execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true }).trim()
  return output ? output.split(',').map(Number).filter(Number.isSafeInteger) : []
}

async function waitUntil(predicate, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = await predicate().catch(() => undefined)
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for isolated iCloud lifecycle state.')
}

async function main() {
  assert.ok(fs.existsSync(executable), 'The patched Electron executable is unavailable.')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const version = fs.readdirSync(extensionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(extensionRoot, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
  assert.ok(version, 'The official iCloud Passwords extension is unavailable.')
  const extensionPath = path.join(extensionRoot, version)
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'))
  assert.ok(manifest.permissions?.includes('nativeMessaging'))
  assert.ok(manifest.background?.service_worker, 'The official iCloud extension has no service worker.')
  const workerUrl = `chrome-extension://${extensionId}/${manifest.background.service_worker}`
  const now = Date.now()
  const registryDirectory = path.join(profile, 'Extensions')
  fs.mkdirSync(registryDirectory, { recursive: true })
  fs.writeFileSync(path.join(registryDirectory, 'registry.json'), JSON.stringify({
    schemaVersion: 2,
    extensions: [{ id: extensionId, name: 'iCloud Passwords', version: manifest.version,
      description: 'Official Apple extension, isolated lifecycle probe', path: extensionPath,
      enabled: true, source: 'unpacked', runtime: 'chrome', manifestVersion: manifest.manifest_version,
      installedAt: now, updatedAt: now, allowFileAccess: false }]
  }))
  const data = structuredClone((await import(pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)).DEFAULT_DATA)
  data.settings.layoutMode = 'horizontal'
  data.onboarding.completed = true
  data.activeWorkspaceId = data.workspaces[0].id
  data.workspaces[0].activeTabId = 'icloud-lifecycle-fixture'
  data.tabs = [{ id: 'icloud-lifecycle-fixture', workspaceId: data.workspaces[0].id,
    title: 'iCloud lifecycle fixture', url: origin, pinned: false, status: 'idle', lifecycle: 'active',
    progress: 0, canGoBack: false, canGoForward: false, zoom: 1, createdAt: now, lastAccessedAt: now }]
  fs.writeFileSync(path.join(profile, 'vast-data.json'), JSON.stringify(data))

  const port = 15800 + Math.floor(Math.random() * 200)
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: profile, VAST_EXTENSION_COMPATIBILITY: '1',
    VAST_PATCHED_ELECTRON_COMPAT: '1', VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1',
    VAST_UPDATE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, root], {
    cwd: root, env, windowsHide: true, stdio: 'ignore'
  })
  const initial = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`)
    if (!response.ok) return undefined
    const targets = await response.json()
    const worker = targets.find((target) => target.type === 'service_worker' && target.url === workerUrl)
    const pids = helperPids()
    return worker && pids.length > 0 ? { workerId: worker.id, pids } : undefined
  }, 30000)
  let cdp = await browserSession(port)
  try {
    let versionId
    try {
      versionId = await waitForWorkerVersion(cdp, extensionId)
    } catch (error) {
      if (error?.message !== 'CDP ServiceWorker.enable failed.') throw error
      cdp.close()
      const page = await waitUntil(async () => {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
        return targets.find((target) => target.type === 'webview' && target.url.startsWith(origin))
      }, 20000)
      cdp = await WorkerCdpSession.connect(page.webSocketDebuggerUrl)
      versionId = await waitForWorkerVersion(cdp, extensionId)
    }
    assert.ok(versionId, 'The iCloud worker version was not available to CDP.')
    await cdp.send('ServiceWorker.stopWorker', { versionId })
  } finally {
    cdp.close()
  }
  await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    return !targets.some((target) => target.id === initial.workerId)
  }, 15000)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const remaining = helperPids()
  const leaked = initial.pids.filter((pid) => remaining.includes(pid))
  assert.equal(leaked.length, 0, 'Native hosts owned by the stopped iCloud worker must exit.')

  const page = await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    return targets.find((target) => target.type === 'webview' && target.url.startsWith(origin))
  })
  const pageCdp = await WorkerCdpSession.connect(page.webSocketDebuggerUrl)
  try { await pageCdp.send('Page.reload', { ignoreCache: true }) } finally { pageCdp.close() }
  const resumed = await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    const worker = targets.find((target) => target.type === 'service_worker' && target.url === workerUrl)
    const pids = helperPids()
    return worker && worker.id !== initial.workerId && pids.length > 0 ? { workerId: worker.id, pids } : undefined
  }, 20000)
  const resumedPage = await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    return targets.find((target) => target.type === 'webview' && target.url.startsWith(origin))
  })
  const resumedCdp = await WorkerCdpSession.connect(resumedPage.webSocketDebuggerUrl)
  try {
    const versionId = await waitForWorkerVersion(resumedCdp, extensionId)
    assert.ok(versionId, 'The resumed iCloud worker version was not available to CDP.')
    await resumedCdp.send('ServiceWorker.stopWorker', { versionId })
  } finally { resumedCdp.close() }
  await waitUntil(async () => {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
    return !targets.some((target) => target.id === resumed.workerId)
  }, 15000)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const afterSecondStop = helperPids()
  const secondLeaked = resumed.pids.filter((pid) => afterSecondStop.includes(pid))
  console.log(JSON.stringify({ extensionVersion: manifest.version, workerStopped: true,
    initialHostCount: initial.pids.length, remainingHostCount: remaining.length,
    previousHostsStillAlive: leaked.length, reconnectedHostCount: resumed.pids.length,
    secondStopHostCount: afterSecondStop.length, secondPreviousHostsStillAlive: secondLeaked.length,
    profile }, null, 2))
  assert.equal(secondLeaked.length, 0, 'Native hosts owned by the resumed iCloud worker must exit.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  if (child && child.exitCode === null) {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
  }
  await new Promise((resolve) => server.close(resolve))
})
