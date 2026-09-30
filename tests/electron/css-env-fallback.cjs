const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.env.VAST_CSS_ENV_TEST_PROFILE)
app.setPath('sessionData', process.env.VAST_CSS_ENV_TEST_PROFILE)

const css = '--first: env(vast-unknown-environment, 10px); --value: var(--missing, var(--first)); color: var(--value);'
let finished = false
function finish(code, message) {
  if (finished) return
  finished = true
  console.log(message)
  app.exit(code)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  window.webContents.once('render-process-gone', (_event, details) => {
    finish(1, `CSS fallback renderer crashed: ${details.reason}, exit ${details.exitCode}`)
  })
  const html = `<!doctype html><style>#target { ${css} }</style><div id="target">CSS fallback regression</div>`
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  const values = await window.webContents.executeJavaScript(`(() => {
    const style = getComputedStyle(document.querySelector('#target'))
    return { first: style.getPropertyValue('--first'), value: style.getPropertyValue('--value') }
  })()`)
  if (values.first !== '10px' || values.value !== '10px') {
    throw new Error(`Wrong CSS fallback value: ${JSON.stringify(values)}`)
  }

  // Typed OM preserves leading whitespace in custom-property values. A nested
  // var() fallback must trim it before the Blink trailing-comment scanner.
  const typedOmHtml = '<!doctype html><style>#target { --value: var(--missing, var(--typed)); width: var(--value); }</style><div id="target">CSS Typed OM fallback regression</div>'
  await window.loadURL(`data:text/html,${encodeURIComponent(typedOmHtml)}`)
  const typedOmValues = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector('#target')
    target.attributeStyleMap.set('--typed', new CSSUnparsedValue([' 10px/2']))
    const style = getComputedStyle(target)
    return { original: style.getPropertyValue('--typed'), fallback: style.getPropertyValue('--value') }
  })()`)
  if (typedOmValues.original !== ' 10px/2' || typedOmValues.fallback !== '10px/2') {
    throw new Error(`Wrong Typed OM var() fallback value: ${JSON.stringify(typedOmValues)}`)
  }
  finish(0, 'CSS env()/var()/Typed OM fallbacks resolved without leading whitespace or a renderer crash')
}).catch(error => finish(1, `CSS fallback regression failed: ${error.message}`))

setTimeout(() => finish(1, 'CSS fallback regression timed out'), 45_000).unref()
