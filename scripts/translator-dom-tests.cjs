// Runs Translator for Vast DOM tests in a real Chromium page (the patched Electron runtime):
// bundles tests/dom.test.ts with esbuild, loads it in a hidden window, and reports each result.
// Usage: node scripts/translator-dom-tests.cjs  (runs Electron itself)
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const root = path.resolve(__dirname, '..')
  const dist = process.env.VAST_PATCHED_ELECTRON_DIST ? path.resolve(process.env.VAST_PATCHED_ELECTRON_DIST) : require('./prepare-patched-electron-dist.cjs').defaultOutputPath(require('../patches/extension-compatibility-runtime.json'))
  const electron = path.join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-dom-'))
  require('esbuild').buildSync({ entryPoints: [path.join(root, 'resources/first-party-extensions/translator-for-vast/tests/dom.test.ts')], outfile: path.join(out, 'dom.js'), bundle: true, format: 'esm', target: 'chrome130', logLevel: 'warning' })
  fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body><script type="module" src="dom.js"></script></html>')
  const env = { ...process.env, TFV_DOM_DIR: out }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [__filename], { env, stdio: 'inherit', windowsHide: true })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  app.on('window-all-closed', () => {})
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { sandbox: true, contextIsolation: true } })
    await win.loadFile(path.join(process.env.TFV_DOM_DIR, 'index.html'))
    let report
    for (let attempt = 0; attempt < 600 && !report; attempt += 1) {
      report = await win.webContents.executeJavaScript('window.__results ?? null')
      if (!report) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    let failed = !report
    for (const result of report?.results ?? []) {
      console.log(`${result.ok ? 'ok    ' : 'not ok'} ${result.name} (${result.ms.toFixed(0)} ms)`)
      if (!result.ok) {
        failed = true
        console.log(`       ${result.error.split('\n').slice(0, 3).join('\n       ')}`)
      }
    }
    if (report?.segmentationMs !== undefined) console.log(`segmentation of 6000 units: ${report.segmentationMs.toFixed(0)} ms; longest 24-unit batch preparation: ${report.batchMs.toFixed(1)} ms`)
    console.log(failed ? 'Translator DOM tests failed.' : `Translator DOM tests passed: ${report.results.length}.`)
    app.exit(failed ? 1 : 0)
  })
}
