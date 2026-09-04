const { execFileSync, spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')

const executable = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!executable) {
  console.error('Usage: node scripts/register-default-browser-e2e.cjs <installed-vast.exe>')
  process.exit(2)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function fetchTargets(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        const shell = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
        if (shell) return shell
      }
    } catch {
      // The installed application has not exposed CDP yet.
    }
    await wait(250)
  }
  throw new Error('Installed Vast did not expose a browser-shell CDP target.')
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
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP ${method} timed out.`))
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
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result.value
  }

  close() {
    this.socket.close()
  }
}

let child
let session
async function cleanup() {
  try { session?.close() } catch {}
  if (child && child.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This check only supports Windows.')
  const port = await allocatePort()
  const env = { ...process.env, VAST_UPDATE_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executable),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const target = await fetchTargets(port)
  session = await CdpSession.connect(target.webSocketDebuggerUrl)
  const registration = await session.evaluate(`(async () => {
    if (!window.vast?.app?.openDefaultBrowserSettings) throw new Error('Default-browser API is unavailable.');
    return window.vast.app.openDefaultBrowserSettings();
  })()`)
  const status = registration?.status
  if (registration?.ok !== true || !status?.supported || status.platform !== 'win32') {
    throw new Error(`Unexpected registration result: ${JSON.stringify(registration)}`)
  }
  await session.evaluate('window.vast.app.window.close()')
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    wait(15_000).then(() => false)
  ])
  if (!exited) throw new Error('Installed Vast did not exit cleanly after registration.')
  process.stdout.write(`${JSON.stringify({ ok: true, registration: status })}\n`)
  if (stderr.trim()) process.stderr.write(stderr)
}

main()
  .catch(async (error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
  .finally(cleanup)
