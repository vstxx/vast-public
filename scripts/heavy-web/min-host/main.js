// Minimal Electron host for A/B runs on the same runtime as Vast. No flags,
// no preload, no request handlers: only what the mode needs.
//   HEAVY_WEB_MODE=window   the page is the BrowserWindow's own document
//   HEAVY_WEB_MODE=webview  the page runs in a full-size <webview> guest
//   HEAVY_WEB_INTERCEPT=1   registers pass-through onBeforeRequest,
//                           onBeforeSendHeaders and onHeadersReceived listeners,
//                           the floor cost of Vast's three request hooks
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')

const mode = process.env.HEAVY_WEB_MODE || 'window'
const url = process.env.HEAVY_WEB_URL || 'about:blank'
const width = Number(process.env.HEAVY_WEB_WIDTH || 1280)
const height = Number(process.env.HEAVY_WEB_HEIGHT || 800)

app.setPath('userData', process.env.HEAVY_WEB_PROFILE || path.join(app.getPath('temp'), 'heavy-web-min-host'))

app.whenReady().then(() => {
  if (process.env.HEAVY_WEB_INTERCEPT === '1') {
    session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({}))
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: details.requestHeaders }))
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: details.responseHeaders }))
  }
  const window = new BrowserWindow({
    x: 0, y: 0, width, height, useContentSize: true, show: true, backgroundColor: '#000000',
    webPreferences: { webviewTag: mode === 'webview', contextIsolation: true, sandbox: true }
  })
  window.setMenuBarVisibility(false)
  if (mode === 'webview') {
    const host = `<!doctype html><html><body style="margin:0;overflow:hidden;background:#000">
<webview src="${url.replace(/"/g, '&quot;')}" style="position:fixed;inset:0;width:100vw;height:100vh;border:0"></webview></body></html>`
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(host)}`)
  } else {
    void window.loadURL(url)
  }
})

app.on('window-all-closed', () => app.quit())
