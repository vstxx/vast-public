const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const screenshotRoot = path.join(root, 'preview-screenshots')
const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outputDir = path.join(screenshotRoot, `vast-gallery-${runId}`)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-dev-preview-profile-'))
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-dev-preview-downloads-'))
const remotePort = 9700 + Math.floor(Math.random() * 250)
const webPort = 10100 + Math.floor(Math.random() * 250)
const currentDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Vast', 'vast-data.json')

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
  for (const tempDir of [userDataDir, downloadDir]) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup.
    }
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

function createPdfBuffer() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'
  ]
  const stream = [
    'BT',
    '/F2 34 Tf',
    '72 704 Td',
    '(Vast Preview Brief) Tj',
    '/F1 13 Tf',
    '0 -42 Td',
    '(Local-first browser workspace preview document.) Tj',
    '0 -28 Td',
    '(This sample PDF is generated for screenshots only and contains no private data.) Tj',
    '0 -44 Td',
    '/F2 16 Tf',
    '(Highlights) Tj',
    '/F1 12 Tf',
    '0 -26 Td',
    '(1. Fast workspace memory and session restore.) Tj',
    '0 -22 Td',
    '(2. Network device inventory with mock data for safe previews.) Tj',
    '0 -22 Td',
    '(3. Notes, bookmarks, and PDF reading in one desktop shell.) Tj',
    'ET'
  ].join('\n')
  objects.push(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`)

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, 'binary'))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'binary')
}

function startDemoServer() {
  const pdf = createPdfBuffer()
  webServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${webPort}`)
    if (url.pathname === '/vast-preview-brief.pdf') {
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': pdf.byteLength,
        'content-disposition': 'inline; filename="vast-preview-brief.pdf"'
      })
      res.end(pdf)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Vast Preview</title><body style="background:#050507;color:white;font-family:system-ui">Vast preview fixture</body>')
  })
  return new Promise((resolve) => webServer.listen(webPort, '127.0.0.1', resolve))
}

async function fetchJson(url, retries = 90) {
  for (let index = 0; index < retries; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Retry until Electron exposes the remote debugger.
    }
    await wait(300)
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
    await session.send('Input.setIgnoreInputEvents', { ignore: false })
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
      const id = this.nextId
      this.nextId += 1
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

  async screenshot(filename, { keepFocus = false } = {}) {
    if (!keepFocus) {
      await this.evaluate(`(() => {
        const active = document.activeElement;
        if (active && typeof active.blur === 'function') active.blur();
        window.getSelection?.()?.removeAllRanges?.();
        return true;
      })()`).catch(() => undefined)
      await wait(180)
    }
    const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    const filePath = path.join(outputDir, filename)
    fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'))
    return filePath
  }

  close() {
    this.ws.close()
  }
}

async function pageSession() {
  let target
  for (let index = 0; index < 90; index += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${remotePort}/json/list`)
    target = targets.find((item) => item.type === 'page' && item.url.includes('index.html')) || targets.find((item) => item.type === 'page')
    if (target) break
    await wait(300)
  }
  if (!target) throw new Error('No debuggable Vast renderer target found.')
  return CdpSession.connect(target.webSocketDebuggerUrl)
}

async function waitFor(session, expression, label, timeoutMs = 18000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await session.evaluate(`Boolean(${expression})`).catch(() => false)
    if (ok) return
    await wait(250)
  }
  const bodyText = await session.evaluate('document.body?.innerText?.slice(0, 2000) ?? ""').catch(() => '')
  throw new Error(`Timed out waiting for ${label}. Visible text: ${bodyText}`)
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

function mockNetworkStore() {
  const now = Date.now()
  const devices = [
    {
      id: 'net-preview-chromecast',
      source: 'mock',
      sources: ['mock', 'mdns'],
      name: 'Living Room Chromecast',
      hostname: 'living-room.local',
      addresses: ['192.168.1.42'],
      primaryIp: '192.168.1.42',
      manufacturer: 'Google',
      model: 'Chromecast HD',
      deviceType: '_googlecast._tcp.local',
      category: 'cast',
      services: [{ name: 'Living Room Chromecast', type: '_googlecast._tcp.local', protocol: 'mdns', port: 8008, txt: { fn: 'Living Room Chromecast', md: 'Chromecast HD' } }],
      ports: [8008, 8009],
      webUrls: ['http://192.168.1.42:8008/setup/eureka_info'],
      firstSeenAt: now - 120000,
      lastSeenAt: now,
      online: true,
      favorite: true,
      pinned: true,
      notes: 'Demo device for preview screenshots only.'
    },
    {
      id: 'net-preview-home-assistant',
      source: 'mock',
      sources: ['mock', 'probe'],
      name: 'Home Assistant',
      addresses: ['192.168.1.20'],
      primaryIp: '192.168.1.20',
      deviceType: 'Home Assistant Web UI',
      category: 'smart-home',
      services: [{ name: 'Home Assistant', type: '_home-assistant._tcp.local', protocol: 'mdns', port: 8123 }],
      ports: [8123],
      webUrls: ['http://192.168.1.20:8123/'],
      firstSeenAt: now - 60000,
      lastSeenAt: now,
      online: true
    },
    {
      id: 'net-preview-router',
      source: 'mock',
      sources: ['mock', 'arp'],
      name: 'Studio Gateway',
      hostname: 'router.local',
      addresses: ['192.168.1.1'],
      primaryIp: '192.168.1.1',
      manufacturer: 'Ubiquiti',
      model: 'Dream Router',
      deviceType: 'Gateway',
      category: 'router',
      services: [{ name: 'Router UI', type: '_http._tcp.local', protocol: 'mdns', port: 443 }],
      ports: [80, 443],
      webUrls: ['https://192.168.1.1/'],
      firstSeenAt: now - 240000,
      lastSeenAt: now - 20000,
      online: true
    }
  ]
  return {
    devices,
    known: Object.fromEntries(devices.map((device) => [device.id, { alias: device.alias, favorite: device.favorite, pinned: device.pinned, notes: device.notes, firstSeenAt: device.firstSeenAt }])),
    logs: [
      `${new Date(now - 80000).toLocaleTimeString()} Loading mock network inventory for screenshots.`,
      `${new Date(now - 60000).toLocaleTimeString()} Scan complete: 3 online, 0 remembered.`
    ],
    lastScanAt: now - 60000
  }
}

async function buildDemoData() {
  const constants = await import(pathToFileURL(path.join(root, 'src', 'shared', 'constants.ts')).href)
  const current = fs.existsSync(currentDataPath) ? JSON.parse(fs.readFileSync(currentDataPath, 'utf8')) : {}
  const data = JSON.parse(JSON.stringify(constants.DEFAULT_DATA))
  const now = Date.now()
  const workspaceId = 'workspace-research'
  const pdfSource = `http://127.0.0.1:${webPort}/vast-preview-brief.pdf`
  // Exercise the real MIME/session-aware interception path. Internal viewer
  // URLs are created only after the original PDF response is captured.
  const pdfUrl = pdfSource
  const settings = {
    ...data.settings,
    ...(current.settings ?? {}),
    bookmarksBarVisible: false,
    restorePreviousSession: true,
    startupBehavior: 'restore',
    openingAnimation: false,
    animations: false,
    newTabBehavior: 'vast',
    labs: {
      ...data.settings.labs,
      ...(current.settings?.labs ?? {}),
      enabled: true,
      avidae: true,
      networkDevices: true,
      automation: true,
      ai: true,
      passwordManager: true,
      advancedDiagnostics: true,
      spoofing: true
    },
    network: {
      ...data.settings.network,
      ...(current.settings?.network ?? {}),
      enabled: true,
      allowScans: true,
      rememberDevices: true
    }
  }

  data.settings = settings
  data.activeWorkspaceId = workspaceId
  data.sidePanelOpen = false
  data.activeSidePanel = 'notes'
  data.sidebarCollapsed = false
  data.focusMode = false
  data.quickLinks = [
    { id: 'ql-vast', title: 'Vast', url: 'https://vastbrowser.com/', color: '#b7a7ff' },
    { id: 'ql-github', title: 'GitHub', url: 'https://github.com/', color: '#f3f5f8' },
    { id: 'ql-youtube', title: 'YouTube', url: 'https://youtube.com/', color: '#ff7676' },
    { id: 'ql-wikipedia', title: 'Wikipedia', url: 'https://wikipedia.org/', color: '#d7dae2' },
    { id: 'ql-figma', title: 'Figma', url: 'https://figma.com/', color: '#74e7ff' },
    { id: 'ql-linear', title: 'Linear', url: 'https://linear.app/', color: '#89a7ff' }
  ]
  data.workspaces = [
    { id: workspaceId, name: 'Research', icon: 'FlaskConical', color: '#b7a7ff', order: 0, activeTabId: 'tab-new', createdAt: now, updatedAt: now },
    { id: 'workspace-personal', name: 'Personal', icon: 'Sparkles', color: '#74e7ff', order: 1, createdAt: now, updatedAt: now },
    { id: 'workspace-coding', name: 'Coding', icon: 'Code2', color: '#8df7b5', order: 2, createdAt: now, updatedAt: now },
    { id: 'workspace-travel', name: 'Travel', icon: 'Plane', color: '#f0b86b', order: 3, isPrivate: true, createdAt: now, updatedAt: now }
  ]
  data.tabs = [
    makeTab('tab-billing', 'Billing', 'https://billing.example.test/', workspaceId),
    makeTab('tab-youtube', 'YouTube', 'https://youtube.com/', workspaceId),
    makeTab('tab-vast-site', 'Vast — The Falcon opens', 'https://vast.example.test/', workspaceId),
    makeTab('tab-new', 'New tab', constants.INTERNAL_NEW_TAB_URL, workspaceId),
    makeTab('tab-network', 'Network Devices', constants.INTERNAL_NETWORK_URL, workspaceId),
    makeTab('tab-timeline', 'Session Timeline', constants.INTERNAL_SESSION_TIMELINE_URL, workspaceId),
    makeTab('tab-avidae', 'Video & Audio', constants.INTERNAL_AVIDAE_URL, workspaceId),
    makeTab('tab-notes', 'Notes', constants.INTERNAL_NOTES_URL, workspaceId),
    makeTab('tab-pdf', 'Vast Preview Brief', pdfUrl, workspaceId),
    makeTab('tab-reader', 'Focus Reader', constants.INTERNAL_READER_URL, workspaceId),
    makeTab('tab-site-data', 'Site Data', constants.INTERNAL_SITE_DATA_URL, workspaceId),
    makeTab('tab-diagnostics', 'Diagnostics', constants.INTERNAL_DIAGNOSTICS_URL, workspaceId),
    makeTab('tab-automation', 'Automation', constants.INTERNAL_AUTOMATION_URL, workspaceId),
    makeTab('tab-passwords', 'Password Manager', constants.INTERNAL_PASSWORDS_URL, workspaceId)
  ]
  data.bookmarkFolders = [
    { id: 'folder-product', name: 'Product', order: 0, createdAt: now, updatedAt: now },
    { id: 'folder-research', name: 'Research', order: 1, createdAt: now, updatedAt: now }
  ]
  data.bookmarks = [
    { id: 'bm-avidae', title: 'Video & Audio workspace', url: constants.INTERNAL_AVIDAE_URL, folderId: 'folder-product', createdAt: now, updatedAt: now },
    { id: 'bm-network', title: 'Network map', url: constants.INTERNAL_NETWORK_URL, folderId: 'folder-product', createdAt: now, updatedAt: now },
    { id: 'bm-session', title: 'Session memory', url: constants.INTERNAL_SESSION_TIMELINE_URL, folderId: 'folder-research', createdAt: now, updatedAt: now },
    { id: 'bm-brief', title: 'Preview brief', url: pdfUrl, folderId: 'folder-research', createdAt: now, updatedAt: now },
    { id: 'bm-docs', title: 'Docs', url: 'https://docs.example.test/vast', createdAt: now, updatedAt: now },
    { id: 'bm-roadmap', title: 'Roadmap', url: 'https://roadmap.example.test/', createdAt: now, updatedAt: now }
  ]
  data.notes = [
    { id: 'note-preview', title: 'Preview gallery outline', body: 'Capture New tab, Network Devices, Session Timeline, Video & Audio with sidebar bookmarks, Notes, and PDF viewer. Use mock data only.', tags: ['preview', 'website'], workspaceId, pinned: true, favorite: true, createdAt: now - 7200000, updatedAt: now - 900000 },
    { id: 'note-network', title: 'Network inventory copy', body: 'Describe local discovery as opt-in, private, and useful for home lab, casting, and device dashboards.', tags: ['network'], workspaceId, createdAt: now - 5200000, updatedAt: now - 1600000 },
    { id: 'note-reader', title: 'Reader and PDF polish', body: 'Show the built-in PDF toolbar, page controls, and clean dark reading surface for launch assets.', tags: ['pdf', 'design'], workspaceId, createdAt: now - 3200000, updatedAt: now - 600000 }
  ]
  data.history = [
    { id: 'hist-new', title: 'New tab', url: constants.INTERNAL_NEW_TAB_URL, visitCount: 6, lastVisitedAt: now - 200000, workspaceId },
    { id: 'hist-network', title: 'Network Devices', url: constants.INTERNAL_NETWORK_URL, visitCount: 3, lastVisitedAt: now - 900000, workspaceId },
    { id: 'hist-notes', title: 'Launch notes', url: constants.INTERNAL_NOTES_URL, visitCount: 4, lastVisitedAt: now - 1600000, workspaceId },
    { id: 'hist-reader', title: 'Focus Reader', url: constants.INTERNAL_READER_URL, visitCount: 2, lastVisitedAt: now - 2600000, workspaceId },
    { id: 'hist-vast', title: 'Vast Browser', url: 'https://vastbrowser.com/', visitCount: 5, lastVisitedAt: now - 4200000, workspaceId }
  ]
  data.downloads = [
    { id: 'download-brief', filename: 'vast-preview-brief.pdf', url: pdfSource, mimeType: 'application/pdf', savePath: path.join(downloadDir, 'vast-preview-brief.pdf'), receivedBytes: 1843200, totalBytes: 1843200, state: 'completed', scanStatus: 'clean', startedAt: now - 480000, updatedAt: now - 420000 },
    { id: 'download-assets', filename: 'vast-brand-assets.zip', url: 'https://assets.example.test/vast-brand-assets.zip', mimeType: 'application/zip', receivedBytes: 12582912, totalBytes: 12582912, state: 'completed', scanStatus: 'clean', startedAt: now - 90000, updatedAt: now - 1000 }
  ]
  data.readingList = [
    { id: 'read-launch', title: 'Designing a local-first browser workspace', url: 'https://journal.example.test/local-first-browser', workspaceId, excerpt: 'A practical guide to calm browser workflows.', read: false, createdAt: now - 4200000, updatedAt: now - 4200000 },
    { id: 'read-security', title: 'Privacy by architecture', url: 'https://journal.example.test/privacy-architecture', workspaceId, excerpt: 'Why local storage boundaries matter.', read: false, createdAt: now - 7200000, updatedAt: now - 7200000 },
    { id: 'read-finished', title: 'Keyboard-first navigation patterns', url: 'https://journal.example.test/keyboard-navigation', workspaceId, read: true, createdAt: now - 12200000, updatedAt: now - 9200000 }
  ]
  data.todos = [
    { id: 'todo-gallery', workspaceId, title: 'Choose hero screenshot', completed: false, createdAt: now - 3200000, updatedAt: now - 3200000 },
    { id: 'todo-copy', workspaceId, title: 'Review launch page copy', completed: false, createdAt: now - 2600000, updatedAt: now - 2600000 },
    { id: 'todo-done', workspaceId, title: 'Prepare private demo profile', completed: true, createdAt: now - 5200000, updatedAt: now - 1200000 }
  ]
  data.sessionSnapshots = [
    {
      id: 'snap-research-morning',
      title: 'Research restored',
      workspaceId,
      workspaceName: 'Research',
      workspaceColor: '#b7a7ff',
      tabIds: ['tab-billing', 'tab-youtube', 'tab-vast-site', 'tab-new'],
      activeUrl: constants.INTERNAL_NEW_TAB_URL,
      trigger: 'restore',
      counts: { tabs: 4, pinned: 0, internal: 1 },
      tabs: data.tabs.slice(0, 4).map((tab) => ({ title: tab.title, url: tab.url, pinned: tab.pinned, lastAccessedAt: tab.lastAccessedAt })),
      createdAt: now - 160000
    },
    {
      id: 'snap-network-review',
      title: 'Network review stack',
      workspaceId,
      workspaceName: 'Research',
      workspaceColor: '#b7a7ff',
      tabIds: ['tab-network', 'tab-notes', 'tab-pdf'],
      activeUrl: constants.INTERNAL_NETWORK_URL,
      trigger: 'manual',
      counts: { tabs: 3, pinned: 0, internal: 3 },
      tabs: data.tabs.slice(4, 7).map((tab) => ({ title: tab.title, url: tab.url, pinned: tab.pinned, lastAccessedAt: tab.lastAccessedAt })),
      createdAt: now - 2600000
    },
    {
      id: 'snap-preview-assets',
      title: 'Preview assets pass',
      workspaceId,
      workspaceName: 'Research',
      workspaceColor: '#b7a7ff',
      tabIds: ['tab-avidae', 'tab-notes', 'tab-pdf'],
      activeUrl: constants.INTERNAL_AVIDAE_URL,
      trigger: 'workspace-switch',
      counts: { tabs: 3, pinned: 0, internal: 3 },
      tabs: data.tabs.slice(6).map((tab) => ({ title: tab.title, url: tab.url, pinned: tab.pinned, lastAccessedAt: tab.lastAccessedAt })),
      createdAt: now - 5600000
    }
  ]
  data.recentlyClosedTabs = [
    { id: 'closed-docs', workspaceId, title: 'Vast documentation', url: 'https://docs.example.test/vast', closedAt: now - 600000 },
    { id: 'closed-roadmap', workspaceId, title: 'Product roadmap', url: 'https://roadmap.example.test/', closedAt: now - 1500000 }
  ]
  return data
}

async function saveScenario(session, data, activeTabId, sidePanelOpen = false, activeSidePanel = 'notes', options = {}) {
  const next = JSON.parse(JSON.stringify(data))
  next.sidePanelOpen = sidePanelOpen
  next.activeSidePanel = activeSidePanel
  next.settings = {
    ...next.settings,
    ...(options.settings ?? {}),
    appearance: { ...next.settings.appearance, ...(options.settings?.appearance ?? {}) },
    labs: { ...next.settings.labs, ...(options.settings?.labs ?? {}) },
    reader: { ...next.settings.reader, ...(options.settings?.reader ?? {}) }
  }
  next.settings.bookmarksBarVisible = Boolean(options.bookmarksBarVisible)
  const defaultVisibleTabs = ['tab-billing', 'tab-youtube', 'tab-vast-site', 'tab-new', 'tab-network', 'tab-notes', 'tab-pdf', activeTabId]
  const visibleTabIds = new Set(options.visibleTabIds ?? defaultVisibleTabs)
  visibleTabIds.add(activeTabId)
  next.tabs = next.tabs.filter((tab) => visibleTabIds.has(tab.id))
  next.workspaces = next.workspaces.map((workspace) =>
    workspace.id === next.activeWorkspaceId ? { ...workspace, activeTabId, updatedAt: Date.now() } : workspace
  )
  next.tabs = next.tabs.map((tab) => ({ ...tab, lastAccessedAt: tab.id === activeTabId ? Date.now() : tab.lastAccessedAt }))
  await session.evaluate(`window.vast.storage.save(${JSON.stringify(next)}).then(() => location.reload())`)
  await wait(1800)
}

async function clickSelector(session, selector) {
  const clicked = await session.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Could not click selector: ${selector}`)
  await wait(350)
}

async function clickByText(session, text, selector = 'button') {
  const clicked = await session.evaluate(`(() => {
    const target = ${JSON.stringify(text)}.toLowerCase();
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = elements.find((candidate) => (candidate.textContent ?? '').trim().toLowerCase() === target)
      ?? elements.find((candidate) => (candidate.textContent ?? '').trim().toLowerCase().includes(target));
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`)
  if (!clicked) throw new Error(`Could not click ${selector} with text: ${text}`)
  await wait(400)
}

async function clickByTitle(session, title) {
  return clickSelector(session, `[title=${JSON.stringify(title)}]`)
}

async function setInput(session, selector, value) {
  const changed = await session.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.focus();
    return true;
  })()`)
  if (!changed) throw new Error(`Could not set input: ${selector}`)
  await wait(450)
}

async function scrollLargestPanel(session, top) {
  await session.evaluate(`(() => {
    const candidates = Array.from(document.querySelectorAll('*')).filter((element) => element.scrollHeight > element.clientHeight + 120);
    const target = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (!target) return false;
    target.scrollTop = ${Number(top)};
    target.dispatchEvent(new Event('scroll', { bubbles: true }));
    return true;
  })()`)
  await wait(400)
}

async function focusAddress(session) {
  await session.ctrl('l', 'KeyL', 76)
  await wait(350)
}

async function startApp() {
  const electronExe = require('electron')
  const env = {
    ...process.env,
    VAST_TEST_USER_DATA_DIR: userDataDir,
    VAST_TEST_DOWNLOAD_DIR: downloadDir
  }
  delete env.ELECTRON_RUN_AS_NODE
  appProcess = spawn(electronExe, [`--remote-debugging-port=${remotePort}`, root], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false
  })
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true })
  await startDemoServer()
  const data = await buildDemoData()
  fs.writeFileSync(path.join(userDataDir, 'vast-data.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(userDataDir, 'vast-network-devices.json'), `${JSON.stringify(mockNetworkStore(), null, 2)}\n`, 'utf8')
  fs.mkdirSync(downloadDir, { recursive: true })
  await startApp()

  const session = await pageSession()
  await session.send('Page.bringToFront')
  try {
    const info = await session.send('Browser.getWindowForTarget')
    await session.send('Browser.setWindowBounds', {
      windowId: info.windowId,
      bounds: { left: 0, top: 0, width: 1920, height: 1080, windowState: 'normal' }
    })
  } catch {
    // Device metrics override still produces 1920x1080 screenshots.
  }
  await waitFor(session, `document.body.innerText.includes('vast') || document.body.innerText.includes('Vast')`, 'Vast UI')

  const shots = []
  if (process.env.VAST_GALLERY_ONLY_AUTOMATION === '1') {
    await saveScenario(session, data, 'tab-new', false)
    await saveScenario(session, data, 'tab-automation', false)
    await waitFor(session, `document.querySelector('[data-testid="automation-page"]')`, 'automation page', 18000)
    shots.push(await session.screenshot('26-automation-macros.png'))
    session.close()
    console.log(JSON.stringify({ outputDir, shots }, null, 2))
    cleanup()
    process.exit(0)
  }

  const onlySettingsSection = String(process.env.VAST_GALLERY_ONLY_SETTINGS ?? '').trim()
  if (onlySettingsSection) {
    await saveScenario(session, data, 'tab-new', false)
    await saveScenario(session, data, 'tab-new', false)
    await clickByTitle(session, 'More browser tools')
    await clickByText(session, 'Settings')
    await waitFor(session, `document.querySelector('.settings-modal-shell')`, 'settings modal')
    if (onlySettingsSection !== 'Appearance') await clickByText(session, onlySettingsSection, '.settings-modal-nav button')
    const filename = `settings-${onlySettingsSection.toLowerCase().replace(/\s+/g, '-')}.png`
    shots.push(await session.screenshot(filename))
    session.close()
    console.log(JSON.stringify({ outputDir, shots }, null, 2))
    cleanup()
    process.exit(0)
  }

  const attemptShot = async (filename, prepare, assertion, timeoutMs = 9000, keepFocus = false) => {
    try {
      await prepare()
      if (assertion) await waitFor(session, assertion, filename, timeoutMs)
      await wait(450)
      shots.push(await session.screenshot(filename, { keepFocus }))
    } catch (error) {
      console.warn(`Skipping ${filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const openSettingsSection = async (section) => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await clickByTitle(session, 'More browser tools')
    await clickByText(session, 'Settings')
    await waitFor(session, `document.querySelector('.settings-modal-shell')`, 'settings modal')
    if (section !== 'Appearance') await clickByText(session, section, '.settings-modal-nav button')
    await wait(350)
  }

  await attemptShot('02-new-tab-dashboard.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'vast' } })
  }, `document.body.innerText.includes('Recent pages') && document.body.innerText.includes('To-do')`)

  await attemptShot('03-new-tab-dashboard-details.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'vast' } })
    await scrollLargestPanel(session, 760)
  }, `document.body.innerText.includes('Recently closed') && document.body.innerText.includes('Session Timeline')`)

  await attemptShot('04-workspace-switcher.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await clickByTitle(session, 'Switch workspace')
  }, `document.body.innerText.toLowerCase().includes('workspaces') && document.body.innerText.includes('Isolated')`)

  await attemptShot('05-command-palette.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await session.ctrl('k', 'KeyK', 75)
  }, `document.querySelector('.command-palette-shell')`, 9000, true)

  await attemptShot('06-command-palette-search.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await session.ctrl('k', 'KeyK', 75)
    await waitFor(session, `document.querySelector('.command-palette-shell input')`, 'command palette input')
    await setInput(session, '.command-palette-shell input', 'notes')
  }, `document.body.innerText.includes('Open Notes') || document.body.innerText.includes('Notes')`, 9000, true)

  await attemptShot('07-more-browser-tools.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await clickByTitle(session, 'More browser tools')
  }, `document.querySelector('.browser-tools-menu')`)

  await attemptShot('08-bookmarks-bar.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { bookmarksBarVisible: true, settings: { newTabBehavior: 'search' } })
  }, `document.body.innerText.includes('Product') && document.body.innerText.includes('Roadmap')`)

  for (const [index, view, label] of [
    [9, 'notes', 'Notes'],
    [10, 'bookmarks', 'Bookmarks'],
    [11, 'history', 'History'],
    [12, 'downloads', 'Downloads'],
    [13, 'reading-list', 'Reading']
  ]) {
    await attemptShot(`${String(index).padStart(2, '0')}-sidebar-${view}.png`, async () => {
      await saveScenario(session, data, 'tab-new', true, view, { settings: { newTabBehavior: 'search' } })
    }, `document.body.innerText.includes(${JSON.stringify(label)})`)
  }

  for (const [index, section] of [
    [14, 'Appearance'],
    [15, 'Labs'],
    [16, 'Privacy'],
    [17, 'Security'],
    [18, 'Shortcuts']
  ]) {
    await attemptShot(`${String(index).padStart(2, '0')}-settings-${section.toLowerCase().replace(/\s+/g, '-')}.png`, async () => {
      await openSettingsSection(section)
    }, `document.querySelector('.settings-modal-shell') && document.body.innerText.includes(${JSON.stringify(section)})`)
  }

  await attemptShot('19-network-devices-overview.png', async () => {
    await saveScenario(session, data, 'tab-network', false)
    await session.evaluate('window.vast.network.scan({ mock: true, confirmed: true })').catch(() => undefined)
    await wait(1400)
  }, `document.querySelector('[data-testid="network-page"]')`, 15000)

  await attemptShot('20-network-devices-filtered.png', async () => {
    await saveScenario(session, data, 'tab-network', false)
    await waitFor(session, `document.querySelector('[data-testid="network-page"] input[placeholder*="Search devices"]')`, 'network search', 15000)
    await setInput(session, '[data-testid="network-page"] input[placeholder*="Search devices"]', 'Home Assistant')
    await clickByText(session, 'Home Assistant')
  }, `document.body.innerText.includes('192.168.1.20')`, 15000)

  await attemptShot('21-notes-workspace.png', async () => {
    await saveScenario(session, data, 'tab-notes', false)
  }, `document.querySelector('[data-testid="notes-page"]') && document.body.innerText.includes('Preview gallery outline')`, 15000)

  await attemptShot('22-notes-search.png', async () => {
    await saveScenario(session, data, 'tab-notes', false)
    await waitFor(session, `document.querySelector('[data-testid="notes-search-input"]')`, 'notes search', 15000)
    await setInput(session, '[data-testid="notes-search-input"]', 'reader')
  }, `document.body.innerText.includes('Reader and PDF polish')`, 15000, true)

  await attemptShot('23-reader-mode.png', async () => {
    await saveScenario(session, data, 'tab-reader', false)
  }, `document.querySelector('[data-testid="reader-page"]')`, 15000)

  await attemptShot('24-pdf-viewer.png', async () => {
    await saveScenario(session, data, 'tab-pdf', false)
  }, `document.body.innerText.includes('BUILT-IN PDF') && document.body.innerText.includes('Ready')`, 30000)

  await attemptShot('25-pdf-viewer-sidebar.png', async () => {
    await saveScenario(session, data, 'tab-pdf', false)
    await waitFor(session, `document.body.innerText.includes('BUILT-IN PDF') && document.body.innerText.includes('Ready')`, 'PDF page', 30000)
    await clickByTitle(session, 'Show sidebar')
  }, `document.body.innerText.includes('Thumbnails') && document.body.innerText.includes('Page 1')`, 30000)

  await attemptShot('26-automation-macros.png', async () => {
    await saveScenario(session, data, 'tab-automation', false)
  }, `document.querySelector('[data-testid="automation-page"]')`, 15000)

  await attemptShot('27-diagnostics-center.png', async () => {
    await saveScenario(session, data, 'tab-diagnostics', false)
  }, `document.querySelector('[data-testid="diagnostics-page"]')`, 15000)

  await attemptShot('28-password-manager.png', async () => {
    await saveScenario(session, data, 'tab-passwords', false)
  }, `document.querySelector('[data-testid="passwords-page"]')`, 15000)

  await attemptShot('29-avidae.png', async () => {
    await saveScenario(session, data, 'tab-avidae', false)
  }, `document.body.innerText.includes('Video & Audio')`, 18000)

  await attemptShot('31-smart-unload.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await clickByTitle(session, 'More browser tools')
    await clickByText(session, 'Smart unload')
  }, `document.body.innerText.includes('Smart unload')`, 12000)

  await attemptShot('32-site-information.png', async () => {
    await saveScenario(session, data, 'tab-new', false, 'notes', { settings: { newTabBehavior: 'search' } })
    await clickByTitle(session, 'Site information')
  }, `document.body.innerText.includes('Vast internal page')`, 12000)

  session.close()
  console.log(JSON.stringify({ outputDir, shots }, null, 2))
  cleanup()
  process.exit(0)
}

main().catch((error) => {
  cleanup()
  console.error(error)
  process.exit(1)
})
