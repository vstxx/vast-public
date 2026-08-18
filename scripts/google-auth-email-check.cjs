const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const artifactsRoot = path.join(root, '.vast-test-artifacts', 'google-auth-live-email-check')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const artifactsDir = path.join(artifactsRoot, runId)
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-google-auth-email-'))
let port
const email = process.env.VAST_GOOGLE_AUTH_TEST_EMAIL
const navigationUrl = 'https://accounts.google.com/ServiceLogin?hl=en'
const packagedExe = process.env.VAST_GOOGLE_AUTH_TEST_EXE
  ? path.resolve(process.env.VAST_GOOGLE_AUTH_TEST_EXE)
  : ''
const electronExe = packagedExe || require('electron')

if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Set VAST_GOOGLE_AUTH_TEST_EMAIL to the account address used for this email-only check.')
  process.exit(2)
}

fs.mkdirSync(artifactsDir, { recursive: true })

const env = {
  ...process.env,
  VAST_TEST_USER_DATA_DIR: userDataDir,
  VAST_UPDATE_ENABLED: '0'
}
delete env.ELECTRON_RUN_AS_NODE

let appProcess
let shellSession
let authSession

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function allocateDebuggerPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const allocatedPort = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) reject(error)
        else if (!allocatedPort) reject(new Error('Could not allocate a debugger port.'))
        else resolve(allocatedPort)
      })
    })
  })
}

function safeUrlShape(value) {
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'unavailable'
  }
}

function cleanup() {
  try { authSession?.close() } catch {}
  try { shellSession?.close() } catch {}
  if (appProcess && !appProcess.killed) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        appProcess.kill('SIGKILL')
      }
    } catch {
      // Best-effort cleanup only.
    }
  }
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // A terminated Chromium child may keep a transient file locked briefly.
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function fetchJson(url, retries = 100) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Wait for Electron to expose the debugger endpoint.
    }
    await wait(250)
  }
  throw new Error(`Could not connect to the local Electron debugger at ${new URL(url).origin}.`)
}

class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
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
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    }
    return response.result.value
  }

  async clickSelector(selectorExpression) {
    const point = await this.evaluate(`(() => {
      const node = ${selectorExpression};
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    if (!point) throw new Error('The expected Google control was not found.')
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13
    })
  }

  close() {
    this.ws.close()
  }
}

async function waitForTarget(predicate, label, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3).catch(() => [])
    const target = targets.find(predicate)
    if (target) return target
    await wait(250)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function waitForEvaluation(session, expression, label, timeoutMs = 30000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const result = await session.evaluate(`Boolean(${expression})`).catch(() => false)
    if (result) return
    await wait(300)
  }
  throw new Error(`Timed out waiting for ${label}.`)
}

async function setAddress(session, value) {
  await session.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')]
      .find((item) => item.placeholder === 'Search or enter address');
    if (!input || !input.form) throw new Error('Vast address input was not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.form.requestSubmit();
    return true;
  })()`)
}

async function classifyGoogleState(session) {
  return session.evaluate(`(() => {
    const text = (document.body?.innerText || '').toLowerCase();
    const isVisible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const blockedPhrases = [
      'browser or app may not be secure',
      "couldn't sign you in",
      'couldn’t sign you in',
      'this browser is not supported'
    ];
    const hasPassword = isVisible(document.querySelector('input[type="password"]'));
    const hasChallenge = [...document.querySelectorAll('[data-challengeid], [data-challengetype]')].some(isVisible);
    const hasBlockedMessage = blockedPhrases.some((phrase) => text.includes(phrase));
    const hasAccountError = text.includes("couldn't find your google account") || text.includes('enter a valid email');
    const hasCaptcha = Boolean(document.querySelector('iframe[src*="recaptcha"], [data-captcha], [class*="captcha"]'));
    const hasEmailInput = [...document.querySelectorAll('#identifierId, input[type="email"]')].some(isVisible);
    return {
      hasPassword,
      hasChallenge,
      hasBlockedMessage,
      hasAccountError,
      hasCaptcha,
      hasEmailInput,
      url: location.href
    };
  })()`)
}

async function main() {
  if (packagedExe && !fs.existsSync(packagedExe)) {
    throw new Error('The requested packaged Vast executable does not exist.')
  }
  if (!packagedExe && !fs.existsSync(path.join(root, 'out', 'main', 'main.js'))) {
    throw new Error('Current Vast build is missing. Run npm run build first.')
  }
  port = await allocateDebuggerPort()

  const stdoutPath = path.join(artifactsDir, 'electron.stdout.log')
  const stderrPath = path.join(artifactsDir, 'electron.stderr.log')
  const stdoutFile = fs.openSync(stdoutPath, 'w')
  const stderrFile = fs.openSync(stderrPath, 'w')
  const launchArgs = packagedExe
    ? [`--remote-debugging-port=${port}`]
    : [`--remote-debugging-port=${port}`, root]
  appProcess = spawn(electronExe, launchArgs, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', stdoutFile, stderrFile]
  })
  fs.closeSync(stdoutFile)
  fs.closeSync(stderrFile)

  const shellTarget = await waitForTarget(
    (target) => target.type === 'page' && target.url.includes('index.html'),
    'the Vast renderer'
  )
  shellSession = await CdpSession.connect(shellTarget.webSocketDebuggerUrl)
  await waitForEvaluation(
    shellSession,
    `[...document.querySelectorAll('input')].some((item) => item.placeholder === 'Search or enter address')`,
    'the Vast address bar'
  )

  await setAddress(shellSession, navigationUrl)
  const authTarget = await waitForTarget(
    (target) => target.type === 'page' && target.url.startsWith('https://accounts.google.com/'),
    'the sterile Google authentication window',
    45000
  )
  authSession = await CdpSession.connect(authTarget.webSocketDebuggerUrl)
  await waitForEvaluation(
    authSession,
    `document.querySelector('#identifierId, input[type="email"]') || (document.body?.innerText || '').toLowerCase().includes('browser or app may not be secure')`,
    'the Google email page or a provider block',
    45000
  )

  const initialState = await classifyGoogleState(authSession)
  if (initialState.hasBlockedMessage) {
    throw new Error('PROVIDER_BLOCK_BEFORE_EMAIL')
  }
  if (!initialState.hasEmailInput) {
    throw new Error('GOOGLE_EMAIL_INPUT_MISSING')
  }

  await authSession.send('Page.bringToFront')
  await authSession.evaluate(`(() => {
    const input = document.querySelector('#identifierId, input[type="email"]');
    input.focus();
    return true;
  })()`)
  await authSession.send('Input.insertText', { text: email })
  const emailInputAccepted = await authSession.evaluate(`(() => {
    const input = document.querySelector('#identifierId, input[type="email"]');
    return Boolean(input && input.value.length === ${email.length});
  })()`)
  if (!emailInputAccepted) throw new Error('TEST_INPUT_NOT_ACCEPTED')
  await authSession.clickSelector(`document.querySelector('#identifierNext button, #identifierNext, button[type="button"]')`)
  await wait(1500)
  const afterClickState = await classifyGoogleState(authSession).catch(() => initialState)
  if (afterClickState.hasEmailInput && !afterClickState.hasBlockedMessage && !afterClickState.hasAccountError && !afterClickState.hasCaptcha) {
    await authSession.pressEnter()
  }

  let finalState = initialState
  const started = Date.now()
  while (Date.now() - started < 45000) {
    finalState = await classifyGoogleState(authSession).catch(() => finalState)
    const leftIdentifierStep = !finalState.hasEmailInput
    if (
      finalState.hasPassword ||
      (leftIdentifierStep && finalState.hasChallenge) ||
      finalState.hasBlockedMessage ||
      finalState.hasAccountError ||
      finalState.hasCaptcha
    ) break
    await wait(500)
  }

  let result = 'INCONCLUSIVE'
  let passed = false
  const advancedPastEmail = finalState.hasPassword || (!finalState.hasEmailInput && finalState.hasChallenge)
  const navigatedPastIdentifier = !finalState.hasEmailInput && safeUrlShape(finalState.url) !== safeUrlShape(initialState.url)
  if (finalState.hasBlockedMessage) {
    result = 'PROVIDER_BLOCK_AFTER_EMAIL'
  } else if (finalState.hasAccountError) {
    result = 'PROVIDER_ACCOUNT_REJECTED'
  } else if (finalState.hasCaptcha) {
    result = 'PROVIDER_ADDITIONAL_CHALLENGE'
  } else if (advancedPastEmail || navigatedPastIdentifier) {
    result = 'EMAIL_ACCEPTED_AUTH_CONTINUES'
    passed = true
  }

  const authLogPath = path.join(userDataDir, 'Logs', 'google-auth.log')
  const authLogCopy = path.join(artifactsDir, 'google-auth.redacted.log')
  if (fs.existsSync(authLogPath)) fs.copyFileSync(authLogPath, authLogCopy)

  const summary = {
    timestamp: new Date().toISOString(),
    result,
    passed,
    profile: 'disposable-and-deleted',
    identityInput: 'email-only-not-persisted',
    runtime: packagedExe ? 'packaged-test-build' : 'development-build',
    initialUrlShape: safeUrlShape(initialState.url),
    finalUrlShape: safeUrlShape(finalState.url),
    acceptedSignal: finalState.hasPassword
      ? 'password-input'
      : advancedPastEmail
        ? 'identifier-input-removed-and-challenge-visible'
        : navigatedPastIdentifier
          ? 'identifier-input-removed-and-navigation-advanced'
          : 'none',
    emailInputAccepted,
    passwordEntered: false,
    cookiesImported: false,
    authLogCaptured: fs.existsSync(authLogCopy)
  }
  fs.writeFileSync(path.join(artifactsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`Artifacts: ${artifactsDir}`)
  if (!passed) process.exitCode = 1
}

main().then(() => {
  const exitCode = process.exitCode || 0
  cleanup()
  process.exit(exitCode)
}).catch((error) => {
  const result = String(error?.message || error)
  const summary = {
    timestamp: new Date().toISOString(),
    result,
    passed: false,
    profile: 'disposable-and-deleted',
    identityInput: 'email-only-not-persisted',
    runtime: packagedExe ? 'packaged-test-build' : 'development-build',
    passwordEntered: false,
    cookiesImported: false
  }
  fs.writeFileSync(path.join(artifactsDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.error(JSON.stringify(summary, null, 2))
  console.error(`Artifacts: ${artifactsDir}`)
  cleanup()
  process.exit(1)
})
