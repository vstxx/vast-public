const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { randomBytes, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
let token = process.env.VAST_RELAY_ADMIN_TOKEN || ''

const publicUrl = 'https://relay-staging.vastbrowser.com'
const adminUrl = 'https://relay-admin-staging.vastbrowser.com'
const artifactsDir = path.join(root, '.vast-test-artifacts')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-relay-e2e-profile-'))
const statePath = path.join(userDataDir, 'vast-relay-state.json')
const resultPath = path.join(artifactsDir, 'relay-client-e2e-result.json')
const electronExe = require('electron')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const suffix = Date.now()
const assetId = `client-e2e-${suffix}.png`
const seasonalId = randomUUID()
const tamperedId = randomUUID()
const releaseVersion = `9.9.${suffix % 1_000_000}`
const created = { broadcasts: [], releases: [], assets: [] }
let running

fs.mkdirSync(artifactsDir, { recursive: true })

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function adminRequest(route, init = {}, expected = [200, 201, 204]) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(`${adminUrl}${route}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) }
    })
    const body = await response.text()
    if (expected.includes(response.status)) return body ? JSON.parse(body) : null
    if (response.status !== 401 || attempt === 29) {
      throw new Error(`Admin ${init.method || 'GET'} ${route} returned ${response.status}: ${body.slice(0, 300)}`)
    }
    await wait(1_000)
  }
  throw new Error('Staging admin authentication did not converge.')
}

async function waitForAdmin() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await adminRequest('/health')
      return
    } catch {
      await wait(1_000)
    }
  }
  throw new Error('The staging admin Worker did not accept the rotated test token.')
}

function rotateEphemeralAdminToken() {
  token = randomBytes(32).toString('hex')
  const wrangler = path.join(root, 'relay', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const result = spawnSync(process.execPath, [
    wrangler,
    'secret', 'put', 'RELAY_ADMIN_TOKEN', '--env', 'staging',
    '--config', path.join(root, 'relay', 'admin', 'wrangler.jsonc')
  ], { cwd: root, input: token, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Could not rotate the staging admin token: ${String(result.stderr || result.stdout).slice(0, 500)}`)
}

async function createFixtures() {
  await adminRequest(`/v1/admin/assets/${assetId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: png
  })
  created.assets.push(assetId)
  const now = Date.now()
  await adminRequest('/v1/admin/broadcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: seasonalId,
      type: 'seasonal',
      title: 'Vast Relay client staging verified',
      body: 'This signed seasonal card exists only for the isolated Phase 2 staging test.',
      media_id: assetId,
      action_label: null,
      action_url: null,
      min_version: '0.1.0',
      max_version: '0.1.99',
      active_from: new Date(now - 60_000).toISOString(),
      active_until: new Date(now + 30 * 60_000).toISOString(),
      priority: 700,
      enabled: true
    })
  })
  created.broadcasts.push(seasonalId)
}

async function removeStaleClientFixtures() {
  const broadcasts = await adminRequest('/v1/admin/broadcasts')
  for (const envelope of broadcasts.items || []) {
    const title = envelope?.payload?.title
    if (title === 'Vast Relay client staging verified' || title === 'THIS TAMPERED MESSAGE MUST NEVER DISPLAY') {
      await adminRequest(`/v1/admin/broadcasts/${envelope.payload.id}`, { method: 'DELETE' }, [200, 404])
    }
  }
  const releases = await adminRequest('/v1/admin/releases')
  for (const envelope of releases.items || []) {
    if (envelope?.payload?.title === 'Critical staging update path verified') {
      await adminRequest(`/v1/admin/releases/${encodeURIComponent(envelope.payload.version)}`, { method: 'DELETE' }, [200, 404])
    }
  }
  const assets = await adminRequest('/v1/admin/assets')
  for (const asset of assets.items || []) {
    if (typeof asset?.id === 'string' && asset.id.startsWith('client-e2e-')) {
      await adminRequest(`/v1/admin/assets/${asset.id}`, { method: 'DELETE' }, [200, 404])
    }
  }
}

async function createTamperedAndCriticalFixtures() {
  const now = Date.now()
  await adminRequest('/v1/admin/broadcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: tamperedId,
      type: 'security',
      title: 'THIS TAMPERED MESSAGE MUST NEVER DISPLAY',
      body: 'The client must reject this envelope after its D1 signature is altered.',
      media_id: null,
      action_label: null,
      action_url: null,
      min_version: null,
      max_version: null,
      active_from: new Date(now - 60_000).toISOString(),
      active_until: new Date(now + 30 * 60_000).toISOString(),
      priority: 1_000,
      enabled: true
    })
  })
  created.broadcasts.push(tamperedId)
  const invalidSignature = `${'A'.repeat(86)}==`
  const wrangler = path.join(root, 'relay', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  execFileSync(process.execPath, [
    wrangler,
    'd1', 'execute', 'vast-relay-staging', '--remote',
    '--command', `UPDATE broadcasts SET signature = '${invalidSignature}' WHERE id = '${tamperedId}';`,
    '--config', path.join(root, 'relay', 'public', 'wrangler.jsonc')
  ], { cwd: root, stdio: 'ignore' })

  await adminRequest('/v1/admin/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: releaseVersion,
      release_url: `https://github.com/vstxx/vast-public/releases/tag/v${releaseVersion}`,
      severity: 'critical',
      min_supported_version: '0.1.5',
      title: 'Critical staging update path verified',
      notes: 'Relay may present this warning, but only the existing trusted updater may install software.',
      published_at: new Date(now - 60_000).toISOString(),
      enabled: true
    })
  })
  created.releases.push(releaseVersion)
}

class CdpSession {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
  }

  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const session = new CdpSession(socket)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out.`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result.value
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  }

  close() {
    this.socket.close()
  }
}

async function fetchDebugger(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const target = targets.find((item) => item.type === 'page' && item.url.includes('index.html'))
        if (target) return target
      }
    } catch {
      // Electron has not exposed CDP yet.
    }
    await wait(200)
  }
  throw new Error('Vast did not expose its renderer over the isolated CDP port.')
}

async function waitForExpression(session, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await session.evaluate(`Boolean(${expression})`).catch(() => false)) return
    await wait(200)
  }
  const text = await session.evaluate('document.body.innerText').catch(() => '')
  throw new Error(`Timed out waiting for ${label}. Renderer: ${String(text).slice(0, 500)}`)
}

async function waitForLocalState(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      if (predicate(state)) return state
    } catch {
      // State has not been written yet.
    }
    await wait(100)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function launchVast({ offline = false } = {}) {
  const port = 9600 + Math.floor(Math.random() * 300)
  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: userDataDir,
    VAST_RELAY_TEST_OFFLINE: offline ? '1' : '0'
  }
  delete env.ELECTRON_RUN_AS_NODE
  const stdout = []
  const stderr = []
  const child = spawn(electronExe, [`--remote-debugging-port=${port}`, root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  running = child
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  const target = await fetchDebugger(port)
  const session = await CdpSession.connect(target.webSocketDebuggerUrl)
  await waitForExpression(session, 'document.querySelector(".app-shell")', 'usable Vast browser shell')
  return { child, session, stdout, stderr }
}

async function closeVast(instance) {
  await instance.session.evaluate('window.vast.app.window.close()').catch(() => undefined)
  instance.session.close()
  const exited = await Promise.race([
    new Promise((resolve) => instance.child.once('exit', () => resolve(true))),
    wait(15_000).then(() => false)
  ])
  if (!exited) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(instance.child.pid), '/t', '/f'], { stdio: 'ignore' })
    else instance.child.kill('SIGKILL')
  }
  running = undefined
}

async function cleanupFixtures() {
  for (const version of created.releases.reverse()) {
    await adminRequest(`/v1/admin/releases/${encodeURIComponent(version)}`, { method: 'DELETE' }, [200, 404]).catch(() => undefined)
  }
  for (const id of created.broadcasts.reverse()) {
    await adminRequest(`/v1/admin/broadcasts/${id}`, { method: 'DELETE' }, [200, 404]).catch(() => undefined)
  }
  for (const id of created.assets.reverse()) {
    await adminRequest(`/v1/admin/assets/${id}`, { method: 'DELETE' }, [200, 404]).catch(() => undefined)
  }
}

async function main() {
  if (!token) rotateEphemeralAdminToken()
  await waitForAdmin()
  await wait(10_000)
  await removeStaleClientFixtures()
  await createFixtures()

  const first = await launchVast()
  await waitForExpression(first.session, `document.querySelector('[data-testid="relay-notice-title"]')?.textContent === 'Vast Relay client staging verified'`, 'signed staging seasonal message')
  await waitForExpression(first.session, `document.querySelector('[data-testid="relay-notice-media"] img')?.complete && document.querySelector('[data-testid="relay-notice-media"] img')?.naturalWidth > 0`, 'verified Relay media')
  await waitForExpression(first.session, `!document.querySelector('.vast-opening-overlay')`, 'opening presentation completion')
  const firstState = await waitForLocalState((state) => state.launchCount === 1, 'first launch state')
  const presentationJson = JSON.stringify(await first.session.evaluate('window.vast.relay.state()'))
  assert(!presentationJson.includes('https://'), 'Renderer Relay DTO unexpectedly exposed a remote URL.')
  await first.session.screenshot(path.join(artifactsDir, 'relay-seasonal-staging.png'))
  await first.session.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)
  await waitForExpression(first.session, `!document.querySelector('[data-testid="relay-notice"]')`, 'local seasonal dismissal')
  const dismissedState = await waitForLocalState(
    (state) => state.dismissed.some((entry) => entry.id === `broadcast:${seasonalId}`),
    'persisted local dismissal'
  )
  await closeVast(first)

  await createTamperedAndCriticalFixtures()
  const second = await launchVast()
  await waitForExpression(second.session, `document.querySelector('[data-testid="relay-notice-title"]')?.textContent === 'Critical staging update path verified'`, 'critical update presentation')
  await waitForExpression(second.session, `document.querySelector('[data-testid="relay-minimum-version"]')`, 'minimum supported version warning')
  await waitForExpression(second.session, `!document.querySelector('.vast-opening-overlay')`, 'second opening presentation completion')
  const secondState = await waitForLocalState(
    (state) => state.launchCount === 2 && state.installId === firstState.installId,
    'second launch with persistent identity'
  )
  await second.session.screenshot(path.join(artifactsDir, 'relay-critical-update-staging.png'))
  await second.session.evaluate(`document.querySelector('[data-testid="relay-notice-dismiss"]').click()`)
  await waitForExpression(second.session, `!document.querySelector('[data-testid="relay-notice"]')`, 'critical dismissal and tampered-message rejection')
  const afterDismiss = await second.session.evaluate('window.vast.relay.state()')
  assert(afterDismiss.current === null, 'Tampered Relay message became displayable after the critical notice was dismissed.')
  assert(!String(await second.session.evaluate('document.body.innerText')).includes('THIS TAMPERED MESSAGE MUST NEVER DISPLAY'), 'Tampered title reached the renderer.')
  await closeVast(second)

  const offline = await launchVast({ offline: true })
  const offlineState = await waitForLocalState(
    (state) => state.launchCount === 3 && state.installId === firstState.installId,
    'offline launch state'
  )
  await wait(4_000)
  assert(await offline.session.evaluate('Boolean(document.querySelector(".app-shell"))'), 'Relay outage disrupted the browser shell.')
  assert(!(await offline.session.evaluate('Boolean(document.querySelector("[data-testid=relay-notice]"))')), 'Offline launch displayed unverified Relay data.')
  await closeVast(offline)

  const result = {
    ok: true,
    environment: 'staging',
    publicUrl,
    installId: firstState.installId,
    localLaunchCounts: [firstState.launchCount, secondState.launchCount, offlineState.launchCount],
    expectedD1LaunchCount: 2,
    seasonalId,
    tamperedId,
    releaseVersion,
    localDismissalIds: offlineState.dismissed.map((entry) => entry.id),
    verified: ['signed-seasonal', 'sha256-media', 'persistent-install-id', 'monotonic-launch-count', 'tamper-drop', 'critical-update-ui', 'offline-startup']
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}).finally(async () => {
  if (running && !running.killed) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(running.pid), '/t', '/f'], { stdio: 'ignore' })
      else running.kill('SIGKILL')
    } catch {
      // Best-effort isolated process cleanup.
    }
  }
  await cleanupFixtures().catch(() => undefined)
  fs.rmSync(userDataDir, { recursive: true, force: true })
})
