const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const screenshotRoot = path.join(root, 'preview-screenshots')
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outputDir = path.join(screenshotRoot, `vast-ui-${runId}`)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-preview-profile-'))
const remotePort = 9600 + Math.floor(Math.random() * 300)
const webPort = 9900 + Math.floor(Math.random() * 300)
const vastExe = path.join(root, 'release', 'Vast-1.0.8', 'win-unpacked', 'Vast.exe')

let appProcess
let webServer
let cleanedUp = false

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (webServer) {
    webServer.close()
    webServer = undefined
  }
  if (appProcess && !appProcess.killed) {
    try {
      execFileSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // Best effort cleanup.
    }
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // Best effort cleanup.
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

function startDemoServer() {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vast Preview Studio</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body {
      margin: 0;
      min-height: 100vh;
      color: #f7f7fb;
      background:
        radial-gradient(circle at 20% 10%, rgba(116,231,255,.22), transparent 28%),
        radial-gradient(circle at 82% 18%, rgba(209,163,255,.18), transparent 30%),
        linear-gradient(135deg, #08090d 0%, #0e1018 54%, #050507 100%);
      overflow: hidden;
    }
    .shell { display: grid; grid-template-columns: 1.05fr .95fr; gap: 36px; height: 100vh; box-sizing: border-box; padding: 70px 84px; }
    .hero { align-self: center; }
    .eyebrow { color: #74e7ff; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 13px; }
    h1 { margin: 18px 0 22px; font-size: clamp(56px, 7vw, 104px); line-height: .88; letter-spacing: 0; }
    p { max-width: 680px; color: #b7bdca; font-size: 20px; line-height: 1.7; }
    .actions { display: flex; gap: 14px; margin-top: 34px; }
    .btn { border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 14px 18px; background: rgba(255,255,255,.07); color: white; font-weight: 700; }
    .btn.primary { background: linear-gradient(135deg, #74e7ff, #d1a3ff); color: #08090d; }
    .panel { align-self: center; border: 1px solid rgba(255,255,255,.12); border-radius: 28px; background: rgba(7,9,14,.72); box-shadow: 0 34px 120px rgba(0,0,0,.42); padding: 24px; backdrop-filter: blur(26px); }
    .toolbar { display: flex; gap: 10px; margin-bottom: 20px; }
    .dot { width: 10px; height: 10px; border-radius: 999px; background: #74e7ff; opacity: .8; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 14px; }
    .card { min-height: 128px; border-radius: 20px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); padding: 18px; }
    .metric { font-size: 34px; font-weight: 800; }
    .label { margin-top: 8px; color: #9aa3b8; font-size: 13px; }
    .wide { grid-column: 1 / -1; min-height: 180px; background: linear-gradient(135deg, rgba(116,231,255,.16), rgba(209,163,255,.14)); }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Local-first browser workspace</div>
      <h1>Browse, capture, automate.</h1>
      <p>Vast keeps research, notes, sessions, downloads, and local tools inside one private desktop browser shell.</p>
      <div class="actions"><div class="btn primary">Open workspace</div><div class="btn">Review timeline</div></div>
    </section>
    <section class="panel">
      <div class="toolbar"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
      <div class="grid">
        <div class="card"><div class="metric">42</div><div class="label">tabs organized</div></div>
        <div class="card"><div class="metric">8</div><div class="label">local automations</div></div>
        <div class="card wide"><div class="metric">Session snapshot ready</div><div class="label">Bookmarks, notes, and workspace context travel together.</div></div>
      </div>
    </section>
  </main>
</body>
</html>`

  webServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => webServer.listen(webPort, '127.0.0.1', resolve))
}

async function fetchJson(url, retries = 80) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Retry until the Electron debugger starts.
    }
    await wait(250)
  }
  throw new Error(`Could not fetch ${url}`)
}

class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const session = new CdpSession(ws)
    await session.send('Runtime.enable')
    await session.send('Page.enable')
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false
    })
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  async key(key, code, keyCode, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
  }

  async ctrl(key, code, keyCode) {
    await this.key(key, code, keyCode, 2)
  }

  async type(text) {
    await this.send('Input.insertText', { text })
  }

  async screenshot(filename) {
    await this.evaluate(`(() => {
      const active = document.activeElement;
      if (active && typeof active.blur === 'function') active.blur();
      const selection = window.getSelection?.();
      if (selection && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
      return true;
    })()`).catch(() => undefined)
    await wait(200)
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const filePath = path.join(outputDir, filename)
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'))
    return filePath
  }
}

async function pageSession() {
  let target
  for (let i = 0; i < 80; i++) {
    const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
    target = targets.find((item) => item.type === 'page' && item.url.includes('index.html')) || targets.find((item) => item.type === 'page')
    if (target) break
    await wait(250)
  }
  if (!target) throw new Error('No Electron renderer target found.')
  return CdpSession.connect(target.webSocketDebuggerUrl)
}

async function waitFor(session, expression, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await session.evaluate(`Boolean(${expression})`).catch(() => false)
    if (ok) return
    await wait(250)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function makeTab(id, title, url, workspaceId, extra = {}) {
  const now = Date.now()
  return {
    id,
    workspaceId,
    title,
    url,
    pinned: false,
    status: 'idle',
    lifecycle: 'active',
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    zoom: 1,
    lastAccessedAt: now,
    createdAt: now,
    ...extra
  }
}

async function buildDemoData() {
  const constants = await import(pathToFileURL(path.join(root, 'src', 'shared', 'constants.ts')).href)
  const data = JSON.parse(JSON.stringify(constants.DEFAULT_DATA))
  const now = Date.now()
  const workspaceId = 'workspace-personal'
  const previewUrl = `http://127.0.0.1:${webPort}/`
  const tabIds = ['tab-new', 'tab-preview', 'tab-notes', 'tab-automation', 'tab-timeline', 'tab-passwords']

  data.activeWorkspaceId = workspaceId
  data.sidePanelOpen = false
  data.activeSidePanel = 'notes'
  data.focusMode = false
  data.sidebarCollapsed = false
  data.settings = {
    ...data.settings,
    theme: 'dark',
    layoutMode: 'horizontal',
    bookmarksBarVisible: true,
    openingAnimation: false,
    animations: false,
    startupBehavior: 'restore',
    restorePreviousSession: true,
    accentColor: '#74e7ff',
    privacy: {
      ...data.settings.privacy,
      adBlockerEnabled: true,
      adBlockerMode: 'brutal'
    },
    spoofing: {
      ...data.settings.spoofing,
      enabled: true,
      browserProfile: 'chrome-windows',
      timezone: 'Europe/Warsaw',
      location: {
        mode: 'fixed',
        latitude: 52.2297,
        longitude: 21.0122,
        accuracy: 35
      }
    }
  }

  data.workspaces = [
    { id: workspaceId, name: 'Launch', icon: 'Sparkles', color: '#74e7ff', order: 0, activeTabId: 'tab-new', createdAt: now, updatedAt: now },
    { id: 'workspace-research', name: 'Research', icon: 'FlaskConical', color: '#b7a7ff', order: 1, activeTabId: 'tab-notes', createdAt: now, updatedAt: now },
    { id: 'workspace-build', name: 'Build', icon: 'Code2', color: '#8df7b5', order: 2, createdAt: now, updatedAt: now }
  ]
  data.tabs = [
    makeTab('tab-new', 'New tab', constants.INTERNAL_NEW_TAB_URL, workspaceId),
    makeTab('tab-preview', 'Vast Preview Studio', previewUrl, workspaceId),
    makeTab('tab-notes', 'Notes', constants.INTERNAL_NOTES_URL, workspaceId),
    makeTab('tab-automation', 'Automation', constants.INTERNAL_AUTOMATION_URL, workspaceId),
    makeTab('tab-timeline', 'Session Timeline', constants.INTERNAL_SESSION_TIMELINE_URL, workspaceId),
    makeTab('tab-passwords', 'Passwords', constants.INTERNAL_PASSWORDS_URL, workspaceId)
  ]
  data.bookmarkFolders = [
    { id: 'folder-product', name: 'Product', order: 0, createdAt: now, updatedAt: now },
    { id: 'folder-research', name: 'Research', order: 1, createdAt: now, updatedAt: now }
  ]
  data.bookmarks = [
    { id: 'bm-vast', title: 'Vast', url: previewUrl, createdAt: now, updatedAt: now },
    { id: 'bm-docs', title: 'Docs', url: 'https://docs.vast.local/', folderId: 'folder-product', createdAt: now, updatedAt: now },
    { id: 'bm-roadmap', title: 'Roadmap', url: 'https://roadmap.vast.local/', folderId: 'folder-product', createdAt: now, updatedAt: now },
    { id: 'bm-ui', title: 'UI Research', url: 'https://research.vast.local/ui', folderId: 'folder-research', createdAt: now, updatedAt: now },
    { id: 'bm-github', title: 'GitHub', url: 'https://github.com/', createdAt: now, updatedAt: now },
    { id: 'bm-linear', title: 'Linear', url: 'https://linear.app/', createdAt: now, updatedAt: now }
  ]
  data.quickLinks = [
    { id: 'ql-youtube', title: 'YouTube', url: 'https://youtube.com', color: '#ff0033', order: 0 },
    { id: 'ql-github', title: 'GitHub', url: 'https://github.com', color: '#ffffff', order: 1 },
    { id: 'ql-chatgpt', title: 'ChatGPT', url: 'https://chatgpt.com', color: '#74e7ff', order: 2 },
    { id: 'ql-linear', title: 'Linear', url: 'https://linear.app', color: '#b7a7ff', order: 3 }
  ]
  data.notes = [
    { id: 'note-launch', title: 'Launch positioning', body: 'Vast is a local-first browser workspace for research, automation, notes, downloads, and session recovery.', tags: ['launch', 'copy'], workspaceId, pinned: true, favorite: true, createdAt: now - 7200000, updatedAt: now - 1800000 },
    { id: 'note-oauth', title: 'Sign-in polish', body: 'Provider popups should keep opener session, preserve cookies, and give clear fallback prompts.', tags: ['auth', 'quality'], workspaceId, createdAt: now - 5200000, updatedAt: now - 900000 },
    { id: 'note-ui', title: 'Website preview shots', body: 'Capture dashboard, browsing, notes, automation, timeline, and spoofing settings for the landing page gallery.', tags: ['design'], workspaceId, createdAt: now - 3200000, updatedAt: now - 600000 }
  ]
  data.history = [
    { id: 'hist-preview', title: 'Vast Preview Studio', url: previewUrl, visitCount: 12, lastVisitedAt: now - 200000, workspaceId },
    { id: 'hist-docs', title: 'Vast Docs', url: 'https://docs.vast.local/', visitCount: 7, lastVisitedAt: now - 900000, workspaceId },
    { id: 'hist-release', title: 'Release checklist', url: 'https://release.vast.local/1.0.8', visitCount: 4, lastVisitedAt: now - 1600000, workspaceId }
  ]
  data.downloads = [
    { id: 'dl-one', filename: 'vast-browser-1.0.8-release.zip', url: previewUrl, receivedBytes: 622837745, totalBytes: 622837745, state: 'completed', startedAt: now - 4000000, updatedAt: now - 3800000 },
    { id: 'dl-two', filename: 'preview-gallery-assets.zip', url: previewUrl, receivedBytes: 184000000, totalBytes: 184000000, state: 'completed', startedAt: now - 3000000, updatedAt: now - 2800000 }
  ]
  data.macros = [
    { id: 'macro-morning', name: 'Morning research stack', description: 'Open launch docs, notes, and session timeline.', icon: 'Sparkles', color: '#74e7ff', trigger: 'manual', actions: [{ id: 'a1', type: 'open-url-current', url: previewUrl }], createdAt: now - 8000000, updatedAt: now - 7000000 },
    { id: 'macro-clean', name: 'Clean duplicate tabs', description: 'Review workspace and close duplicates before saving a snapshot.', icon: 'RefreshCw', color: '#b7a7ff', trigger: 'manual', actions: [{ id: 'a2', type: 'close-duplicate-tabs' }], createdAt: now - 6000000, updatedAt: now - 5000000 }
  ]
  data.sessionSnapshots = [
    { id: 'snap-launch', workspaceId, title: 'Launch workspace review', tabs: data.tabs.filter((tab) => tabIds.includes(tab.id)), createdAt: now - 1200000, counts: { tabs: 6, pinned: 0, internal: 4, sleeping: 0, discarded: 0 } },
    { id: 'snap-design', workspaceId, title: 'Preview gallery pass', tabs: data.tabs.slice(0, 4), createdAt: now - 5200000, counts: { tabs: 4, pinned: 0, internal: 3, sleeping: 0, discarded: 0 } }
  ]
  data.recentlyClosedTabs = []
  data.activeWorkspaceId = workspaceId

  return data
}

async function saveScenario(session, data, activeTabId, sidePanelOpen = false, activeSidePanel = 'notes') {
  const next = JSON.parse(JSON.stringify(data))
  next.sidePanelOpen = sidePanelOpen
  next.activeSidePanel = activeSidePanel
  next.workspaces = next.workspaces.map((workspace) =>
    workspace.id === next.activeWorkspaceId ? { ...workspace, activeTabId, updatedAt: Date.now() } : workspace
  )
  next.tabs = next.tabs.map((tab) => ({ ...tab, lastAccessedAt: tab.id === activeTabId ? Date.now() : tab.lastAccessedAt }))
  await session.evaluate(`window.vast.storage.save(${JSON.stringify(next)}).then(() => location.reload())`)
  await wait(1800)
}

async function openSettingsSpoofing(session) {
  await session.ctrl('k', 'KeyK', 75)
  await waitFor(session, `document.querySelector('input[placeholder="Command, tab, bookmark, history, or search"]')`, 'command palette')
  await session.type('open settings')
  await wait(300)
  await session.key('Enter', 'Enter', 13)
  await waitFor(session, `document.body.innerText.includes('Settings') && document.body.innerText.includes('Appearance')`, 'settings modal')
  await session.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim().includes('Spoofing'));
    if (!button) throw new Error('Spoofing nav button not found');
    button.click();
    return true;
  })()`)
  await wait(600)
}

async function main() {
  if (!fs.existsSync(vastExe)) throw new Error(`Missing Vast executable: ${vastExe}`)
  fs.mkdirSync(outputDir, { recursive: true })
  await startDemoServer()
  const data = await buildDemoData()
  fs.mkdirSync(userDataDir, { recursive: true })
  fs.writeFileSync(path.join(userDataDir, 'vast-data.json'), JSON.stringify(data, null, 2), 'utf8')

  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: userDataDir,
    VAST_TEST_DOWNLOAD_DIR: path.join(userDataDir, 'Downloads')
  }
  delete env.ELECTRON_RUN_AS_NODE
  appProcess = spawn(vastExe, [`--remote-debugging-port=${remotePort}`], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })

  const session = await pageSession()
  await session.send('Page.bringToFront')
  try {
    const info = await session.send('Browser.getWindowForTarget')
    await session.send('Browser.setWindowBounds', {
      windowId: info.windowId,
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    })
  } catch {
    // Device metrics override still gives a 1920x1080 capture.
  }

  await waitFor(session, `document.body.innerText.includes('vast') || document.body.innerText.includes('Vast')`, 'Vast UI')
  await wait(1200)

  const shots = []
  await saveScenario(session, data, 'tab-new', false)
  shots.push(await session.screenshot('01-new-tab-dashboard.png'))

  await saveScenario(session, data, 'tab-preview', false)
  await wait(1200)
  shots.push(await session.screenshot('02-browser-preview-page.png'))

  await saveScenario(session, data, 'tab-preview', true, 'notes')
  shots.push(await session.screenshot('03-notes-sidebar.png'))

  await saveScenario(session, data, 'tab-preview', true, 'bookmarks')
  shots.push(await session.screenshot('04-bookmarks-sidebar.png'))

  await saveScenario(session, data, 'tab-timeline', false)
  shots.push(await session.screenshot('05-session-timeline.png'))

  await openSettingsSpoofing(session)
  shots.push(await session.screenshot('06-settings-spoofing.png'))

  console.log(JSON.stringify({ outputDir, shots }, null, 2))
  cleanup()
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
