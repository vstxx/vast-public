const { app, BrowserWindow, WebContentsView } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')

const root = join(__dirname, '..')
const counts = [1, 10, 25]

function memory() {
  const metrics = app.getAppMetrics()
  return {
    processCount: metrics.length,
    workingSetBytes: metrics.reduce((sum, item) => sum + item.memory.workingSetSize * 1024, 0),
    privateBytes: metrics.reduce((sum, item) => sum + item.memory.privateBytes * 1024, 0)
  }
}

function loaded(contents) {
  return new Promise((resolve, reject) => {
    contents.once('did-finish-load', resolve)
    contents.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`)))
  })
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const scenarios = []
  for (const count of counts) {
    const views = []
    const started = performance.now()
    for (let index = 0; index < count; index += 1) {
      const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
      view.setBounds({ x: 0, y: 0, width: 1200, height: 800 })
      const ready = loaded(view.webContents)
      void view.webContents.loadURL(`data:text/html,<title>Spike ${index}</title><main>WebContentsView ${index}</main>`)
      await ready
      views.push(view)
    }
    window.contentView.addChildView(views[0])
    const createAndLoadMs = performance.now() - started
    const samples = []
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const next = views[iteration % views.length]
      const switchStarted = performance.now()
      for (const view of views) window.contentView.removeChildView(view)
      window.contentView.addChildView(next)
      samples.push(performance.now() - switchStarted)
    }
    samples.sort((a, b) => a - b)
    scenarios.push({
      count,
      createAndLoadMs,
      switchMedianMs: samples[Math.floor(samples.length / 2)],
      switchP95Ms: samples[Math.floor(samples.length * 0.95)],
      memory: memory()
    })
    for (const view of views) {
      window.contentView.removeChildView(view)
      view.webContents.close()
    }
  }
  window.destroy()
  const result = { schemaVersion: 1, capturedAt: new Date().toISOString(), electron: process.versions.electron, scenarios }
  const target = join(root, 'performance-results', 'webcontents-view-spike.json')
  mkdirSync(join(root, 'performance-results'), { recursive: true })
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`)
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
