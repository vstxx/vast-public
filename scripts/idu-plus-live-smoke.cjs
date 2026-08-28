const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const extensionPath = path.join(root, 'resources', 'first-party-extensions', 'idu-plus')

async function runElectronSmoke() {
  const { app, BrowserWindow, session } = require('electron')
  const userDataPath = process.env.VAST_IDU_SMOKE_USER_DATA
  if (!userDataPath) throw new Error('Live smoke profile path is missing.')
  app.setPath('userData', userDataPath)
  app.commandLine.appendSwitch('disable-background-networking')

  await app.whenReady()
  const partition = 'persist:vast-idu-plus-live-smoke'
  const extensionSession = session.fromPartition(partition)
  const extension = await extensionSession.extensions.loadExtension(extensionPath, { allowFileAccess: false })
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  await window.loadURL('https://s19.idu.edu.pl/users/sign_in')
  const result = await window.webContents.executeJavaScript(`(() => ({
      url: location.href,
      extensionId: ${JSON.stringify(extension.id)},
      runtime: document.documentElement.dataset.iduPlusRuntime || null,
      classes: document.documentElement.className,
      loginForm: Boolean(document.querySelector('form input[type="password"]')),
      containerRadius: getComputedStyle(document.querySelector('#container') || document.body).borderRadius,
      bodyFont: getComputedStyle(document.body).fontFamily,
      logoCount: document.querySelectorAll('[src*="idu-plus-logo"]').length
    }))()`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.runtime !== 'active' || !String(result.classes).split(/\s+/).includes('idu-plus')) {
    throw new Error('IDU+ content runtime did not initialize on the live IDU page.')
  }
  window.destroy()
  app.exit(0)
}

if (process.versions.electron) {
  runElectronSmoke().catch((error) => {
    console.error(error)
    require('electron').app.exit(1)
  })
} else {
  const electron = require('electron')
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-idu-plus-live-smoke-'))
  const environment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1', VAST_IDU_SMOKE_USER_DATA: userDataPath }
  delete environment.ELECTRON_RUN_AS_NODE
  try {
    const result = spawnSync(electron, [__filename], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 1
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true })
  }
}
