const { runInNewContext } = require('node:vm')
const { join } = require('node:path')

function assertPassiveGuestWheelListeners(source) {
  const wheelListeners = []
  const addEventListener = (name, _handler, options) => {
    if (name === 'wheel') wheelListeners.push(options)
  }
  runInNewContext(source, {
    require: (name) => {
      if (name === 'electron/renderer') return { ipcRenderer: { sendSync: () => null, sendToHost: () => undefined } }
      throw new Error(`Unexpected packaged preload import: ${name}`)
    },
    document: { readyState: 'loading', addEventListener },
    window: { addEventListener },
    location: { href: 'https://example.test/', protocol: 'https:' },
    process: { isMainFrame: false }
  }, { filename: 'packaged guest preload', timeout: 1000 })
  if (!wheelListeners.length) throw new Error('Packaged guest preload has no wheel tracking listener.')
  if (wheelListeners.some((options) => options?.passive !== true)) {
    throw new Error('Packaged guest preload registered a non-passive wheel listener.')
  }
  return wheelListeners.length
}

function verifyPackagedGuestScroll(asarPath) {
  const source = require('@electron/asar').extractFile(asarPath, join('out', 'preload', 'guest.js')).toString('utf8')
  return assertPassiveGuestWheelListeners(source)
}

if (require.main === module) {
  try {
    const root = join(__dirname, '..')
    const version = require('../package.json').version
    const asarPath = join(root, 'release', `Vast-${version}`, 'win-unpacked', 'resources', 'app.asar')
    const wheelListeners = verifyPackagedGuestScroll(asarPath)
    console.log(JSON.stringify({ ok: true, version, asarPath, wheelListeners }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = { assertPassiveGuestWheelListeners, verifyPackagedGuestScroll }
