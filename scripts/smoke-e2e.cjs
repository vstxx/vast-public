const { spawn, execFileSync } = require('node:child_process')
const assertStrict = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const artifactsDir = process.env.VAST_E2E_ARTIFACTS_DIR
  ? path.resolve(process.env.VAST_E2E_ARTIFACTS_DIR)
  : path.join(root, '.vast-test-artifacts')
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-e2e-profile-'))
const openingVisualOnlyRequested = process.argv.includes('--opening-visual-only')
const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-e2e-downloads-'))
const localPdfPath = path.join(userDataDir, 'vast-local-open.pdf')
const port = 9400 + Math.floor(Math.random() * 400)
const electronVersion = require('electron/package.json').version

const forcedWindowSize = process.env.VAST_E2E_WINDOW_SIZE?.match(/^(\d+)x(\d+)$/i)
if (forcedWindowSize) {
  const width = Number(forcedWindowSize[1])
  const height = Number(forcedWindowSize[2])
  if (width < 980 || height < 680) fail('VAST_E2E_WINDOW_SIZE must be at least 980x680.')
  fs.writeFileSync(path.join(userDataDir, 'window-state.json'), JSON.stringify({
    main: { x: 0, y: 0, width, height, maximized: false }
  }))
}

fs.mkdirSync(artifactsDir, { recursive: true })
const seedPartition = process.env.VAST_E2E_SEED_PARTITION
if (seedPartition) {
  const seededPartition = path.join(userDataDir, 'Partitions', 'vast-workspace-workspace-default')
  for (const entry of ['Network', 'Local Storage', 'Session Storage', 'IndexedDB']) {
    const source = path.join(seedPartition, entry)
    if (!fs.existsSync(source)) continue
    try {
      fs.cpSync(source, path.join(seededPartition, entry), { recursive: true })
    } catch {
      console.warn(`[smoke] Seed partition entry was locked and skipped: ${entry}`)
    }
  }
}
const electronExe = require('electron')
const packagedExecutable = process.env.VAST_E2E_EXECUTABLE
  ? path.resolve(process.env.VAST_E2E_EXECUTABLE)
  : undefined
const packagedPdfUrl = process.env.VAST_E2E_PUBLIC_PDF_URL?.trim()
const launchExecutable = packagedExecutable ?? electronExe
const launchArgs = packagedExecutable
  ? [`--remote-debugging-port=${port}`, `--vast-performance-report=${path.join(userDataDir, 'packaged-smoke-performance.json')}`]
  // Electron 44 parses switches before the app path as electron CLI options.
  // Put the app path first so Chromium receives the remote-debugging switch.
  : [root, `--remote-debugging-port=${port}`]

const env = {
  ...process.env,
  VAST_TEST_USER_DATA_DIR: userDataDir,
  VAST_TEST_DOWNLOAD_DIR: downloadDir,
  VAST_RELAY_TEST_OFFLINE: '1'
}
delete env.ELECTRON_RUN_AS_NODE

const stdout = []
const stderr = []
const rendererIssues = []
const checks = []
let appProcess
let downloadServer
let authenticatedPdfRequests = 0

function record(name, detail = '') {
  checks.push({ name, detail })
  console.log(`PASS ${name}${detail ? ` - ${detail}` : ''}`)
}

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function isExpectedRendererIssue(issue) {
  const normalized = String(issue).trim()
  // Electron can report these exact internal teardown messages after the
  // corresponding popup/webview behavior has already completed successfully.
  // The assertions verify those flows before this narrow exception is applied;
  // every application exception and every other Electron error still fails.
  return (
    normalized === 'Electron sandboxed_renderer.bundle.js script failed to run' ||
    (normalized.includes("Cannot destructure property 'preloadScripts' of 'binding.startupData' as it is null.") &&
      normalized.includes('node:electron/js2c/sandbox_bundle')) ||
    (normalized.includes('Error: Invalid guestInstanceId:') &&
      normalized.includes('at WebViewElement.disconnectedCallback (node:electron/js2c/isolated_bundle') &&
      normalized.includes('at commitDeletionEffectsOnFiber'))
  )
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanup() {
  if (downloadServer) {
    downloadServer.close()
    downloadServer = undefined
  }
  if (appProcess && !appProcess.killed) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', String(appProcess.pid), '/t', '/f'], { stdio: 'ignore' })
      } else {
        appProcess.kill('SIGKILL')
      }
    } catch {
      // Best effort cleanup only.
    }
  }
  for (const tempDir of [userDataDir, downloadDir]) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup only.
    }
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

async function fetchJson(url, retries = 60) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // Retry until Electron exposes the remote debugger.
    }
    await wait(250)
  }
  fail(`Could not fetch ${url}`)
}

class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        rendererIssues.push(message.params.args.map((arg) => arg.value || arg.description || arg.type).join(' '))
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails
        const description = details.exception?.description || details.exception?.value
        const location = details.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1}` : ''
        rendererIssues.push([details.text, description, location].filter(Boolean).join('\n'))
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timeout } = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(timeout)
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
    await session.send('Performance.enable')
    await session.send('Input.setIgnoreInputEvents', { ignore: false })
    return session
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId
      this.nextId += 1
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`CDP ${method} timed out after 30 seconds`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timeout })
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
      fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }

  async bodyText() {
    return String(await this.evaluate('document.body.innerText') || '')
  }

  async screenshot(name) {
    try {
      const result = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const filePath = path.join(artifactsDir, `${name}.png`)
      fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'))
      return filePath
    } catch (error) {
      console.warn(`[smoke] Optional screenshot ${name} skipped: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  async key(key, code, keyCode, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers
    })
  }

  async ctrl(key, code, keyCode) {
    await this.key(key, code, keyCode, 2)
  }

  async ctrlShift(key, code, keyCode) {
    await this.key(key, code, keyCode, 10)
  }

  async type(text) {
    await this.send('Input.insertText', { text })
  }

  close() {
    this.ws.close()
  }
}

async function pageSession(preferOpeningSplash = false) {
  let target
  for (let i = 0; i < 60; i += 1) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
    target = preferOpeningSplash
      ? targets.find((item) => item.type === 'page' && item.url.startsWith('data:text/html')) ||
        targets.find((item) => item.type === 'page' && item.url.includes('index.html')) ||
        targets.find((item) => item.type === 'page')
      : targets.find((item) => item.type === 'page' && item.url.includes('index.html')) ||
        targets.find((item) => item.type === 'page')
    if (target) break
    await wait(250)
  }
  assert(target, 'No debuggable Electron renderer page found.')
  return CdpSession.connect(target.webSocketDebuggerUrl)
}

async function waitFor(session, expression, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await session.evaluate(`Boolean(${expression})`).catch(() => false)
    if (value) return
    await wait(250)
  }
  const body = await session.bodyText().catch(() => '')
  fail(`Timed out waiting for ${label}. Body: ${body.slice(0, 800)}`)
}

async function waitForFileContaining(filePath, needle, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8')
      if (text.includes(needle)) return text
    }
    await wait(200)
  }
  fail(`Timed out waiting for ${label}: ${filePath}`)
}

async function waitForStorage(session, expression, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await session
      .evaluate(`window.vast.storage.load().then((data) => Boolean((${expression})(data)))`)
      .catch(() => false)
    if (value) return
    await wait(350)
  }
  const snapshot = await session.evaluate('window.vast.storage.load()').catch(() => null)
  const urls = snapshot?.tabs?.map((tab) => tab.url).slice(-8) ?? []
  const workspaces = snapshot?.workspaces?.map((workspace) => ({ name: workspace.name, private: workspace.isPrivate, activeTabId: workspace.activeTabId })) ?? []
  fail(`Timed out waiting for storage: ${label}. Recent stored URLs: ${JSON.stringify(urls)}. Workspaces: ${JSON.stringify(workspaces)}`)
}

async function assertTwoPaneSplitGeometry(session, label) {
  const geometry = await session.evaluate(`(() => {
    const stage = document.querySelector('[data-testid="browser-stage"]');
    const panes = [...document.querySelectorAll('[data-testid="split-pane"]')]
      .map((pane) => pane.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((left, right) => left.left - right.left);
    if (!stage) return null;
    const stageRect = stage.getBoundingClientRect();
    return {
      stage: { left: stageRect.left, right: stageRect.right, top: stageRect.top, bottom: stageRect.bottom },
      panes: panes.map((rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height })),
      rows: getComputedStyle(stage).gridTemplateRows
    };
  })()`)
  assert(geometry && geometry.panes.length === 2, `${label}: expected exactly two visible split panes.`)
  const [left, right] = geometry.panes
  const tolerance = 2
  assert(left.width > 200 && right.width > 200, `${label}: one of the split panes has no usable width.`)
  assert(Math.abs(left.top - geometry.stage.top) <= tolerance && Math.abs(right.top - geometry.stage.top) <= tolerance, `${label}: split panes flowed into separate grid rows at the top.`)
  assert(Math.abs(left.bottom - geometry.stage.bottom) <= tolerance && Math.abs(right.bottom - geometry.stage.bottom) <= tolerance, `${label}: split panes do not fill the same stage row.`)
  assert(Math.abs(left.left - geometry.stage.left) <= tolerance && Math.abs(right.right - geometry.stage.right) <= tolerance, `${label}: split panes do not cover the stage horizontally.`)
  assert(left.right <= right.left + tolerance, `${label}: split panes overlap instead of remaining side by side.`)
  return geometry
}

async function assertEqualActionGrid(session, testId, expectedItems, expectedRows) {
  const metrics = await session.evaluate(`(() => {
    const grid = document.querySelector('[data-testid="${testId}"]');
    if (!grid) throw new Error('Action grid not found: ${testId}');
    const items = [...grid.children].filter((item) => {
      const style = getComputedStyle(item);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    const rects = items.map((item) => item.getBoundingClientRect());
    const rowTops = rects.map((rect) => rect.top).sort((left, right) => left - right);
    const rows = rowTops.reduce((groups, top) => {
      if (groups.length === 0 || Math.abs(top - groups.at(-1)) > 3) groups.push(top);
      return groups;
    }, []);
    return {
      count: rects.length,
      widths: rects.map((rect) => Math.round(rect.width * 10) / 10),
      rows: rows.length,
      overflowing: items.filter((item) => item.scrollWidth > item.clientWidth + 1 || item.scrollHeight > item.clientHeight + 1).map((item) => item.innerText.trim())
    };
  })()`)
  assert(metrics.count === expectedItems, `${testId} rendered ${metrics.count} controls instead of ${expectedItems}.`)
  assert(Math.max(...metrics.widths) - Math.min(...metrics.widths) <= 1, `${testId} controls have uneven widths: ${metrics.widths.join(', ')}.`)
  assert(metrics.rows === expectedRows, `${testId} rendered ${metrics.rows} rows instead of ${expectedRows}.`)
  assert(metrics.overflowing.length === 0, `${testId} controls overflow their cells: ${metrics.overflowing.join(', ')}.`)
}

async function clickByText(session, text) {
  const quoted = JSON.stringify(text)
  await session.evaluate(`(() => {
    const elements = [...document.querySelectorAll('button,a,[role="button"]')];
    const element = elements.find((item) => item.innerText.trim().includes(${quoted}) || item.title === ${quoted});
    if (!element) throw new Error('Could not find clickable: ' + ${quoted});
    element.click();
    return true;
  })()`)
}

async function executeInActiveWebview(session, expression) {
  const source = JSON.stringify(expression)
  return session.evaluate(`(() => {
    const webview = [...document.querySelectorAll('webview.browser-webview')]
      .find((item) => {
        const rect = item.getBoundingClientRect();
        return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
      });
    if (!webview) throw new Error('Active browser webview not found.');
    return webview.executeJavaScript(${source}, true);
  })()`)
}

async function typeInActiveWebview(session, selector, value) {
  const quotedSelector = JSON.stringify(selector)
  const quotedValue = JSON.stringify(value)
  await executeInActiveWebview(session, `(() => {
    const input = document.querySelector(${quotedSelector});
    if (!(input instanceof HTMLInputElement)) throw new Error('Guest input not found: ' + ${quotedSelector});
    input.focus();
    input.value = '';
    return true;
  })()`)
  // the saved username. Let that one-shot action settle, then model the user
  // replacing it with trusted keyboard input.
  await wait(120)
  await executeInActiveWebview(session, `(() => {
    const input = document.querySelector(${quotedSelector});
    if (!(input instanceof HTMLInputElement)) throw new Error('Guest input disappeared: ' + ${quotedSelector});
    input.focus();
    input.value = '';
    return true;
  })()`)
  for (const character of value) {
    await session.evaluate(`(() => {
      const webview = [...document.querySelectorAll('webview.browser-webview')]
        .find((item) => item.getClientRects().length > 0 && item.getBoundingClientRect().width > 0);
      if (!webview) throw new Error('Active browser webview not found for input.');
      webview.sendInputEvent({ type: 'char', keyCode: ${JSON.stringify(character)} });
      return true;
    })()`)
  }
  try {
    await waitForActiveWebview(session, `document.querySelector(${quotedSelector})?.value === ${quotedValue}`, `trusted input ${selector}`)
  } catch {
    const observedValue = await executeInActiveWebview(session, `document.querySelector(${quotedSelector})?.value ?? null`).catch(() => null)
    fail(`Trusted input ${selector} produced ${JSON.stringify(observedValue)} instead of ${quotedValue}.`)
  }
}

async function keyInActiveWebview(session, keyCode) {
  const quotedKey = JSON.stringify(keyCode)
  await session.evaluate(`(() => {
    const webview = [...document.querySelectorAll('webview.browser-webview')]
      .find((item) => item.getClientRects().length > 0 && item.getBoundingClientRect().width > 0);
    if (!webview) throw new Error('Active browser webview not found for keyboard input.');
    webview.sendInputEvent({ type: 'keyDown', keyCode: ${quotedKey} });
    if (${quotedKey} === 'Enter') webview.sendInputEvent({ type: 'char', keyCode: '\\r' });
    webview.sendInputEvent({ type: 'keyUp', keyCode: ${quotedKey} });
    return true;
  })()`)
}

async function trustedClickInActiveWebview(session, selector) {
  const quotedSelector = JSON.stringify(selector)
  const point = await executeInActiveWebview(session, `(() => {
    const element = document.querySelector(${quotedSelector});
    if (!element) throw new Error('Guest element not found: ' + ${quotedSelector});
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  await session.evaluate(`(() => {
    const webview = [...document.querySelectorAll('webview.browser-webview')]
      .find((item) => item.getClientRects().length > 0 && item.getBoundingClientRect().width > 0);
    if (!webview) throw new Error('Active browser webview not found for mouse input.');
    webview.sendInputEvent({ type: 'mouseDown', x: ${Number(point.x)}, y: ${Number(point.y)}, button: 'left', clickCount: 1 });
    webview.sendInputEvent({ type: 'mouseUp', x: ${Number(point.x)}, y: ${Number(point.y)}, button: 'left', clickCount: 1 });
    return true;
  })()`)
}

async function waitForActiveWebview(session, expression, label, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await executeInActiveWebview(session, expression).catch(() => false)
    if (value) return
    await wait(250)
  }
  fail(`Timed out waiting for active webview: ${label}`)
}

async function clickInActiveWebview(session, selector) {
  const quoted = JSON.stringify(selector)
  return executeInActiveWebview(session, `(() => {
    const element = document.querySelector(${quoted});
    if (!element) throw new Error('Guest element not found: ' + ${quoted});
    element.click();
    return true;
  })()`)
}

async function clickByTitle(session, title) {
  const quoted = JSON.stringify(title)
  const rect = await session.evaluate(`(() => {
    const visible = (item) => {
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const element =
      [...document.querySelectorAll('button[data-tab-motion-id]')].find((item) => visible(item) && item.innerText.trim().startsWith(${quoted})) ||
      [...document.querySelectorAll('[draggable="true"][title]')].find((item) => visible(item) && (item.title === ${quoted} || item.title.startsWith(${quoted} + '\\n'))) ||
      [...document.querySelectorAll('[title]')].find((item) => visible(item) && item.title === ${quoted});
    if (!element) throw new Error('Could not find titled element: ' + ${quoted});
    const target = element.closest('button,[role="button"],a') || element;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: rect.x,
    y: rect.y,
    button: 'left',
    clickCount: 1
  })
  await wait(150)
}

async function deleteWorkspaceByName(session, name) {
  await clickByText(session, name)
  const quoted = JSON.stringify(name)
  await session.evaluate(`(() => {
    const workspaceButton = [...document.querySelectorAll('button')].find((item) => item.title === ${quoted} || item.innerText.includes(${quoted}));
    if (!workspaceButton) throw new Error('Workspace button not found: ' + ${quoted});
    const row = [...document.querySelectorAll('div')]
      .filter((item) => item.innerText.includes(${quoted}) && item.querySelector('button[title="Delete workspace"]'))
      .sort((left, right) => left.innerText.length - right.innerText.length)[0];
    const deleteButton = row?.querySelector('button[title="Delete workspace"]');
    if (!deleteButton) throw new Error('Delete workspace button not found for: ' + ${quoted});
    deleteButton.click();
    return true;
  })()`)
  await waitFor(session, 'document.body.innerText.includes("Delete workspace")', 'workspace delete confirmation')
  await session.evaluate(`(() => {
    const form = [...document.querySelectorAll('form')].at(-1);
    if (!form || !form.innerText.includes('Delete workspace')) throw new Error('Workspace confirmation form not found.');
    form.requestSubmit();
    return true;
  })()`)
  await wait(250)
}

async function activateButtonByTitle(session, title) {
  const quoted = JSON.stringify(title)
  await session.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => {
      if (item.title !== ${quoted}) return false;
      const rect = item.getBoundingClientRect();
      const style = getComputedStyle(item);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (!button) throw new Error('Could not find visible button: ' + ${quoted});
    button.focus();
    button.click();
    return true;
  })()`)
  await wait(150)
}

async function clickHorizontalBrowserTools(session) {
  await session.evaluate(`(() => {
    const button = document.querySelector('.horizontal-chrome button[title="More browser tools"]');
    if (!button) throw new Error('Visible horizontal browser tools button not found.');
    button.click();
    return true;
  })()`)
  await wait(150)
}

async function setAddress(session, value) {
  const quoted = JSON.stringify(value)
  await session.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === 'Search or enter address');
    if (!input || !input.form) throw new Error('Address input not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${quoted});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  // React commits the controlled input state after the input event. Submitting
  // in the same renderer task can make onSubmit observe the previous URL,
  // which is not representative of a user typing and then pressing Enter.
  await wait(50)
  await session.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find((item) => item.placeholder === 'Search or enter address');
    if (!input || !input.form) throw new Error('Address input disappeared before submit.');
    input.form.requestSubmit();
    return true;
  })()`)
}

async function submitPrompt(session, value, confirmLabel, verifyFocus = false) {
  const quotedValue = JSON.stringify(value)
  const quotedConfirm = JSON.stringify(confirmLabel)
  await waitFor(session, `document.body.innerText.includes(${quotedConfirm})`, `${confirmLabel} prompt`)
  await session.evaluate(`(() => {
    const forms = [...document.querySelectorAll('form')];
    const form = forms.at(-1);
    const input = form?.querySelector('input');
    if (!form || !input) throw new Error('Prompt input not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${verifyFocus ? "''" : quotedValue});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (!${verifyFocus}) form.requestSubmit();
    return true;
  })()`)
  if (verifyFocus) {
    let typed = ''
    for (const character of value) {
      typed += character
      await session.type(character)
      const state = await session.evaluate(`(() => {
        const form = [...document.querySelectorAll('form')].at(-1);
        const input = form?.querySelector('input');
        return { focused: document.activeElement === input, value: input?.value ?? '' };
      })()`)
      assert(state.focused, `Prompt input lost focus after typing ${JSON.stringify(typed)}.`)
      assert(state.value === typed, `Prompt input value changed unexpectedly after typing ${JSON.stringify(typed)}.`)
    }
    await session.evaluate(`([...document.querySelectorAll('form')].at(-1))?.requestSubmit()`)
  }
  await wait(250)
}

async function setSelectByLabel(session, labelText, value) {
  const quotedLabel = JSON.stringify(labelText)
  const quotedValue = JSON.stringify(value)
  const usedNative = await session.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((item) => item.innerText.includes(${quotedLabel}));
    const select = label?.querySelector('select');
    if (select) {
      select.value = ${quotedValue};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    // SettingsSelect wraps VastSelect in a div (not a label) and forwards the
    // setting name through data-settings-select.
    const custom = label?.querySelector('[data-settings-select]') ??
      document.querySelector('[data-settings-select=' + CSS.escape(${quotedLabel}) + ']');
    const trigger = custom?.querySelector('button[aria-haspopup="listbox"]');
    const choiceGroup = document.querySelector('[role="group"][aria-label=' + CSS.escape(${quotedLabel}) + ']');
    const choice = [...(choiceGroup?.querySelectorAll('button') ?? [])].find((button) =>
      button.getAttribute('aria-label')?.toLowerCase() === String(${quotedValue}).toLowerCase()
    );
    if (choice) {
      choice.click();
      return true;
    }
    if (!custom || !trigger) throw new Error('Select not found for label: ' + ${quotedLabel});
    trigger.click();
    return false;
  })()`)
  if (usedNative) return
  await waitFor(
    session,
    `(() => {
      const menu = [...document.querySelectorAll('[role="listbox"]')].find((item) => item.getAttribute('aria-label') === ${quotedLabel});
      return Boolean(menu?.querySelector('[data-value=' + CSS.escape(${quotedValue}) + ']'));
    })()`,
    `settings option ${labelText}:${value}`
  )
  await session.evaluate(`(() => {
    const menu = [...document.querySelectorAll('[role="listbox"]')].find((item) => item.getAttribute('aria-label') === ${quotedLabel});
    const option = menu?.querySelector('[data-value=' + CSS.escape(${quotedValue}) + ']');
    if (!option) throw new Error('Option not found for label: ' + ${quotedLabel} + ' value: ' + ${quotedValue});
    option.click();
    return true;
  })()`)
}

async function setCheckboxByLabel(session, labelText, checked) {
  const quotedLabel = JSON.stringify(labelText)
  await session.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((item) => item.innerText.includes(${quotedLabel}));
    const checkbox = label?.querySelector('input[type="checkbox"]');
    if (!checkbox) throw new Error('Checkbox not found for label: ' + ${quotedLabel});
    if (checkbox.checked !== ${checked ? 'true' : 'false'}) checkbox.click();
    return true;
  })()`)
}

async function setNumberInputByLabel(session, labelText, value) {
  const quotedLabel = JSON.stringify(labelText)
  await session.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((item) => item.innerText.includes(${quotedLabel}));
    const input = label?.querySelector('input[type="number"]');
    if (!input) throw new Error('Number input not found for label: ' + ${quotedLabel});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, String(${value}));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`)
}

async function openCommand(session, query = '') {
  await session.ctrl('k', 'KeyK', 75)
  await waitFor(
    session,
    'Boolean(document.querySelector("input[placeholder=\\"Command, tab, bookmark, history, or search\\"]"))',
    'command palette open'
  )
  if (query) {
    const quoted = JSON.stringify(query)
    await session.evaluate(`(() => {
      const input = document.querySelector('input[placeholder="Command, tab, bookmark, history, or search"]');
      if (!input) throw new Error('Command input not found.');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, ${quoted});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await wait(250)
  }
}

async function waitForCommandClosed(session) {
  await waitFor(
    session,
    '!Boolean(document.querySelector("input[placeholder=\\"Command, tab, bookmark, history, or search\\"]"))',
    'command palette closed'
  )
}

async function closeWorkspacePopover(session) {
  const closed = await session.evaluate(`(() => {
    const isOpen = Boolean(document.querySelector('[data-testid="workspace-popover"]'));
    if (!isOpen) return false;
    const button = document.querySelector('button[title="Switch workspace"]');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  if (closed) await wait(200)
}

function createPdfBuffer(text) {
  const escapedText = text.replace(/[()\\]/g, '\\$&')
  const stream = ['BT', '/F1 24 Tf', '40 72 Td', `(${escapedText}) Tj`, 'ET'].join('\n')
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'))
    pdf += object
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8')
  pdf += `xref\n0 ${objects.length + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(pdf, 'utf8')
}

async function startDownloadServer() {
  const pdfBuffer = createPdfBuffer('Vast PDF Smoke')
  return new Promise((resolve) => {
    downloadServer = http.createServer((request, response) => {
      const parsedRequestUrl = new URL(request.url, 'http://127.0.0.1')
      if (request.url === '/download.txt') {
        const chunk = Buffer.alloc(32 * 1024, 'V')
        const chunkCount = 16
        response.writeHead(200, {
          'Content-Type': 'text/plain',
          'Content-Length': String(chunk.length * chunkCount),
          'Content-Disposition': 'attachment; filename="vast-smoke-download.txt"'
        })
        let sentChunks = 0
        const sendChunk = () => {
          if (response.destroyed) return
          if (sentChunks >= chunkCount) {
            response.end()
            return
          }
          response.write(chunk)
          sentChunks += 1
          setTimeout(sendChunk, 80)
        }
        sendChunk()
        return
      }
      if (request.url === '/viewer.pdf') {
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfBuffer.length),
          'Content-Disposition': 'inline; filename="vast-smoke.pdf"'
        })
        response.end(pdfBuffer)
        return
      }
      if (request.url === '/target-blank') {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Target Blank Result</title><h1>Target Blank Result</h1>')
        return
      }
      if (request.url === '/script-open') {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end('<!doctype html><title>Script Open Result</title><h1>Script Open Result</h1>')
        return
      }
      if (parsedRequestUrl.pathname === '/compat-source') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        response.end(`<!doctype html><title>Compat Source</title><body>
          <a id="guarded-download" href="/guarded-download?token=vast-compat-token" target="_blank">Guarded download</a>
          <form id="compat-post" method="POST" action="/post-target" target="_blank">
            <input type="hidden" name="token" value="vast-post-test">
          </form>
          <button id="compat-named-one" onclick="window.__compatFirst = window.open('/compat-one', 'vast-compat-named')">Named one</button>
          <button id="compat-named-two" onclick="window.__compatSecond = window.open('/compat-two', 'vast-compat-named')">Named two</button>
          <div id="compat-status"></div>
          <script>
            window.addEventListener('message', (event) => {
              if (typeof event.data === 'string' && event.data.startsWith('compat:')) {
                const status = document.getElementById('compat-status')
                status.dataset.messages = (status.dataset.messages ?? '') + event.data.slice(6) + ';'
              }
            })
          </script>
        </body>`)
        return
      }
      if (parsedRequestUrl.pathname === '/guarded-download') {
        const referer = String(request.headers.referer ?? '')
        const token = parsedRequestUrl.searchParams.get('token')
        if (!referer.endsWith('/compat-source')) {
          response.writeHead(302, { Location: '/compat-source?failed=referrer', 'Cache-Control': 'no-store' })
          response.end()
          return
        }
        if (token !== 'vast-compat-token') {
          response.writeHead(302, { Location: '/compat-source?failed=token', 'Cache-Control': 'no-store' })
          response.end()
          return
        }
        const payload = Buffer.from('vast-compat-guarded-download\n', 'utf8')
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(payload.length),
          'Content-Disposition': 'attachment; filename="vast-compat-download.txt"'
        })
        response.end(payload)
        return
      }
      if (parsedRequestUrl.pathname === '/post-target') {
        const chunks = []
        request.on('data', (chunk) => chunks.push(chunk))
        request.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const verdict = request.method === 'POST'
            ? (body.includes('token=vast-post-test') ? 'post-ok' : 'post-missing-body')
            : `wrong-method-${request.method.toLowerCase()}`
          response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
          response.end(`<!doctype html><title>Post Target</title><body data-post-verdict="${verdict}"><h1>${verdict}</h1></body>`)
        })
        return
      }
      if (parsedRequestUrl.pathname === '/compat-one' || parsedRequestUrl.pathname === '/compat-two') {
        const label = parsedRequestUrl.pathname.slice(1)
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        response.end(`<!doctype html><title>Compat ${label}</title><body><h1>${label}</h1><script>
          try { window.opener.postMessage('compat:${label}:${parsedRequestUrl.pathname}', '*') } catch (error) {}
        </script></body>`)
        return
      }
      if (request.url === '/pdf-auth') {
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'vast_pdf_session=authorized; Path=/; HttpOnly; SameSite=Lax'
        })
        response.end('<!doctype html><title>Authenticated PDF source</title><a id="secure-pdf" href="/secure-export?id=one-shot">Open protected PDF</a>')
        return
      }
      if (parsedRequestUrl.pathname === '/secure-export') {
        authenticatedPdfRequests += 1
        const authorized = String(request.headers.cookie || '').includes('vast_pdf_session=authorized')
        const referred = String(request.headers.referer || '').endsWith('/pdf-auth')
        const browserUserAgent = !String(request.headers['user-agent'] || '').startsWith('Vast/')
        if (!authorized || !referred || !browserUserAgent || authenticatedPdfRequests !== 1) {
          response.writeHead(403, { 'Content-Type': 'text/html' })
          response.end('<!doctype html><title>PDF authorization failed</title>PDF authorization failed')
          return
        }
        response.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdfBuffer.length),
          'Content-Disposition': 'inline; filename="authenticated-session.pdf"'
        })
        response.end(pdfBuffer)
        return
      }
      if (parsedRequestUrl.pathname === '/session-start') {
        response.writeHead(302, {
          Location: `http://localhost:${downloadServer.address().port}/session-finish`,
          'Set-Cookie': 'vast_cross_site_session=registered; Path=/; SameSite=Lax',
          'Cache-Control': 'no-store'
        })
        response.end()
        return
      }
      if (parsedRequestUrl.pathname === '/session-finish') {
        const sessionState = String(request.headers.cookie || '').includes('vast_cross_site_session=registered')
          ? 'session-ok'
          : 'session-missing'
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        response.end(`<!doctype html><title>Cross-site session ${sessionState}</title><body data-cross-site-session="${sessionState}"><h1>${sessionState}</h1></body>`)
        return
      }
      if (parsedRequestUrl.pathname.startsWith('/split-')) {
        const title = parsedRequestUrl.pathname === '/split-primary'
          ? 'Split Primary'
          : parsedRequestUrl.pathname === '/split-secondary'
            ? 'Split Secondary'
            : 'Split Secondary Navigated'
        response.writeHead(200, { 'Content-Type': 'text/html' })
        response.end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>${parsedRequestUrl.pathname}</p>`)
        return
      }
      if (parsedRequestUrl.pathname === '/oauth-callback' || parsedRequestUrl.pathname === '/auth/google') {
        response.writeHead(200, { 'Content-Type': 'text/html' })
        const message = parsedRequestUrl.pathname === '/oauth-callback' ? 'blank-popup-opener-ok' : 'direct-popup-opener-ok'
        const requestIdentity = String(request.headers['user-agent'] || '').includes(`Electron/${electronVersion}`)
          ? 'request-native-ua'
          : 'request-non-native-ua'
        response.end(`<!doctype html><title>OAuth Popup</title><script>
          const sessionState = document.cookie.includes('vast_popup_session=shared') ? 'session-ok' : 'session-missing'
          const openerState = window.opener ? 'opener-ok' : 'opener-missing'
          const nodeState = typeof require === 'undefined' && typeof process === 'undefined' ? 'node-off' : 'node-exposed'
          const preloadState = typeof window.vast === 'undefined' ? 'preload-off' : 'preload-exposed'
          const spoofState = typeof window.__vastSpoofingSignature === 'undefined' ? 'spoof-off' : 'spoof-exposed'
          const cosmeticState = document.getElementById('vast-cosmetic-adblock-style') ? 'cosmetic-exposed' : 'cosmetic-off'
          const identityState = navigator.userAgent.includes(${JSON.stringify(`Electron/${electronVersion}`)}) ? 'native-ua' : 'non-native-ua'
          window.opener.postMessage([
            ${JSON.stringify(message)}, sessionState, openerState, nodeState,
            preloadState, spoofState, cosmeticState, identityState, ${JSON.stringify(requestIdentity)}
          ].join(':'), '*')
          setTimeout(() => window.close(), 80)
        </script>`)
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(`<!doctype html><title>Vast Local Test</title><h1>Vast Local Test</h1><p>Example page for testing.</p>
        <a id="target-blank" href="/target-blank" target="_blank" onclick="document.body.dataset.targetBlankClicked='1'">Target blank</a>
        <button id="script-open" onclick="window.open('/script-open')">Script open</button>
        <button id="blank-popup" onclick="const popup = window.open('about:blank', 'blank-oauth', 'width=520,height=640'); popup.location.href='/oauth-callback'">Blank popup</button>
        <button id="direct-popup" onclick="window.open('/auth/google?code=popup-secret&amp;state=popup-state&amp;login_hint=user%40example.test', 'direct-oauth', 'width=520,height=640')">Direct popup</button>
        <button id="cross-site-session" onclick="location.href='http://localhost:${downloadServer.address().port}/session-start'">Cross-site session</button>
        <button id="notification-permission" onclick="Notification.requestPermission().then((result) => { document.body.dataset.notificationPermission = result }).catch((error) => { document.body.dataset.notificationPermission = error.name })">Notifications permission</button>
        <button id="screen-share" onclick="document.body.dataset.screenShare='pending'; navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }).then((stream) => { document.body.dataset.screenShare = 'granted:' + stream.getVideoTracks().length; stream.getTracks().forEach((track) => track.stop()) }).catch((error) => { document.body.dataset.screenShare = 'denied:' + error.name })">Share screen</button>
        <button id="html-fullscreen" onclick="document.documentElement.requestFullscreen()">Fullscreen player</button>
        <button id="external-app" onclick="window.location.href='vast-smoke-app://open/from-browser'">Open external app</button>
        <script>
          document.cookie = 'vast_popup_session=shared; Path=/'
          window.addEventListener('message', (event) => { document.body.dataset.popupMessage = event.data })
        </script>`)
    })
    downloadServer.listen(0, '127.0.0.1', () => resolve(downloadServer.address().port))
  })
}

async function runSplitViewSmoke(session, localServerPort) {
  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-primary`)
  await waitForActiveWebview(session, `document.title === 'Split Primary'`, 'split primary page')
  await session.ctrl('t', 'KeyT', 84)
  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-secondary`)
  await waitForActiveWebview(session, `document.title === 'Split Secondary'`, 'split secondary page')
  await clickByTitle(session, 'Split Primary')
  await waitForStorage(
    session,
    `(data) => data.tabs.find((tab) => tab.id === data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId)?.url.endsWith('/split-primary')`,
    'split primary focused before toggle'
  )

  await openCommand(session, 'split')
  await clickByText(session, 'Toggle split view')
  await waitFor(
    session,
    'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.split === "true" && document.querySelectorAll("[data-testid=\\"split-pane\\"]").length === 2',
    'two real split panes'
  )
  await waitForStorage(
    session,
    '(data) => data.splitView.enabled === true && Boolean(data.splitView.primaryTabId) && Boolean(data.splitView.secondaryTabId) && data.splitView.primaryTabId !== data.splitView.secondaryTabId',
    'split pair persisted'
  )

  const splitMeta = await session.evaluate(`window.vast.storage.load().then((data) => ({
    activeTabId: data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId,
    primaryTabId: data.splitView.primaryTabId,
    secondaryTabId: data.splitView.secondaryTabId
  }))`)
  assert(splitMeta.activeTabId === splitMeta.primaryTabId, 'Split primary pane is not focused after enabling.')
  await assertTwoPaneSplitGeometry(session, 'initial split')

  const visibleSplitUrls = await session.evaluate(`[...document.querySelectorAll('webview.browser-webview')]
    .filter((item) => { const rect = item.getBoundingClientRect(); return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 })
    .map((item) => item.getURL())`)
  assert(visibleSplitUrls.some((url) => url.endsWith('/split-primary')) && visibleSplitUrls.some((url) => url.endsWith('/split-secondary')), 'Split did not keep both webviews live.')

  const secondarySurfacePoint = await session.evaluate(`(() => {
    const webviews = [...document.querySelectorAll('webview.browser-webview')]
      .filter((item) => { const rect = item.getBoundingClientRect(); return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 })
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
    if (webviews.length !== 2) throw new Error('Expected two visible split webviews.');
    const rect = webviews[1].getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(80, rect.height / 3) };
  })()`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y, button: 'left', clickCount: 1 })
  await waitForStorage(
    session,
    `(data) => data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId === ${JSON.stringify(splitMeta.secondaryTabId)} && data.splitView.primaryTabId === ${JSON.stringify(splitMeta.primaryTabId)} && data.splitView.secondaryTabId === ${JSON.stringify(splitMeta.secondaryTabId)}`,
    'right split pane focused without mutating pair'
  )

  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-secondary-navigated`)
  await waitForStorage(
    session,
    `(data) => data.tabs.find((tab) => tab.id === ${JSON.stringify(splitMeta.secondaryTabId)})?.url.endsWith('/split-secondary-navigated') && data.tabs.find((tab) => tab.id === ${JSON.stringify(splitMeta.primaryTabId)})?.url.endsWith('/split-primary')`,
    'address bar navigates only the focused pane'
  )

  await session.ctrl('t', 'KeyT', 84)
  await waitForStorage(
    session,
    `(data) => data.splitView.enabled === true && data.splitView.primaryTabId === ${JSON.stringify(splitMeta.primaryTabId)} && data.splitView.secondaryTabId === data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId && data.tabs.find((tab) => tab.id === data.splitView.secondaryTabId)?.url === 'vast://newtab'`,
    'new tab replaces only focused split pane'
  )
  await waitFor(session, 'document.querySelectorAll("[data-testid=\\"split-pane\\"]").length === 2', 'split remains after pane replacement')
  await assertTwoPaneSplitGeometry(session, 'split after pane replacement')

  await session.evaluate(`document.querySelector('[data-testid="split-resizer"]')?.focus()`)
  await session.key('ArrowRight', 'ArrowRight', 39)
  await waitForStorage(session, '(data) => data.splitView.enabled === true && data.splitView.ratio > 50', 'keyboard resize persisted')
  const ratioBeforeDrag = await session.evaluate('window.vast.storage.load().then((data) => data.splitView.ratio)')
  const resizerDrag = await session.evaluate(`(() => {
    const stage = document.querySelector('[data-testid="browser-stage"]')?.getBoundingClientRect();
    const handle = document.querySelector('[data-testid="split-resizer"]')?.getBoundingClientRect();
    if (!stage || !handle) return null;
    return { startX: handle.left + handle.width / 2, y: handle.top + Math.min(120, handle.height / 3), endX: Math.min(stage.right - 80, handle.left + handle.width / 2 + stage.width * 0.08) };
  })()`)
  assert(resizerDrag, 'Split resizer geometry is unavailable.')
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resizerDrag.startX, y: resizerDrag.y })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: resizerDrag.startX, y: resizerDrag.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: resizerDrag.endX, y: resizerDrag.y, button: 'left', buttons: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: resizerDrag.endX, y: resizerDrag.y, button: 'left', clickCount: 1 })
  await waitForStorage(session, `(data) => data.splitView.ratio > ${JSON.stringify(ratioBeforeDrag + 2)}`, 'pointer resize persisted')
  await assertTwoPaneSplitGeometry(session, 'split after resize')

  const preSwap = await session.evaluate(`window.vast.storage.load().then((data) => ({
    primary: data.splitView.primaryTabId,
    secondary: data.splitView.secondaryTabId,
    active: data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId
  }))`)
  await clickByTitle(session, 'Swap split panes')
  await waitForStorage(
    session,
    `(data) => data.splitView.primaryTabId === ${JSON.stringify(preSwap.secondary)} && data.splitView.secondaryTabId === ${JSON.stringify(preSwap.primary)} && data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId === ${JSON.stringify(preSwap.active)}`,
    'swap keeps tabs and focus stable'
  )
  await assertTwoPaneSplitGeometry(session, 'split after swap')
  await session.screenshot('02-split-view-regression')

  await clickByTitle(session, 'Exit split view')
  await waitForStorage(session, '(data) => data.splitView.enabled === false', 'split exit persisted')
  await waitFor(
    session,
    'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.split === "false" && document.querySelectorAll("[data-testid=\\"split-pane\\"]").length === 0 && document.querySelectorAll("[data-testid=\\"split-pane-header\\"]").length === 0',
    'split exits to one clean pane'
  )
  record('split view regression', 'two full-height panes, stable focus, pane-scoped navigation, replacement, keyboard/pointer resize, swap, and clean exit')
}

async function main() {
  const localServerPort = await startDownloadServer()
  if (process.argv.includes('--local-pdf-only')) {
    fs.writeFileSync(localPdfPath, createPdfBuffer('Vast Local PDF Smoke'))
  }
  if (openingVisualOnlyRequested) {
    const { DEFAULT_DATA } = await import(require('node:url').pathToFileURL(path.join(root, 'src/shared/constants.ts')).href)
    const seed = structuredClone(DEFAULT_DATA)
    seed.settings.animations = true
    seed.settings.openingAnimation = true
    fs.writeFileSync(path.join(userDataDir, 'vast-data.json'), JSON.stringify(seed))
  }

  appProcess = spawn(launchExecutable, launchArgs, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  appProcess.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  appProcess.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  appProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      rendererIssues.push(`Electron exited with code ${code}`)
    }
  })

  const openingVisualOnly = openingVisualOnlyRequested
  const session = await pageSession(openingVisualOnly)
  if (openingVisualOnly) {
    await waitFor(
      session,
      `document.readyState !== 'loading' && document.getAnimations().length >= 4 && [...document.images].every((image) => image.complete)`,
      'opening animation document'
    )
    const openingViewport = await session.evaluate('[window.innerWidth, window.innerHeight]')
    assert(openingViewport[0] <= 700 && openingViewport[1] <= 420, `Opening window is not compact: ${openingViewport.join('x')}.`)
    const metrics = {}
    for (const frameMs of [0, 1000, 2000, 2600]) {
      metrics[frameMs] = await session.evaluate(`(() => {
        document.querySelector('.vast-opening-overlay')?.style.setProperty('--vast-opening-delay', '0ms');
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = ${frameMs};
        }
        const root = document.querySelector('.opening-splash, .vast-opening-overlay');
        const backdrop = document.querySelector('.vast-opening-backdrop');
        const core = document.querySelector('.vast-splash-opening-core, .vast-opening-core');
        const halo = document.querySelector('.vast-splash-opening-halo, .vast-opening-logo-halo');
        const logo = document.querySelector('.vast-splash-opening-logo, .vast-opening-logo-frame');
        const logoRect = logo?.getBoundingClientRect();
        return {
          viewport: [window.innerWidth, window.innerHeight],
          rootBackground: root ? getComputedStyle(root).backgroundImage : '',
          backdropOpacity: backdrop ? getComputedStyle(backdrop).opacity : getComputedStyle(root, '::before').opacity,
          coreTransform: core ? getComputedStyle(core).transform : '',
          haloOpacity: halo ? getComputedStyle(halo).opacity : '',
          logoOpacity: logo ? getComputedStyle(logo).opacity : '',
          logoRect: logoRect ? [logoRect.left, logoRect.top, logoRect.width, logoRect.height].map((value) => Math.round(value * 10) / 10) : []
        };
      })()`)
      await session.screenshot(`opening-${String(frameMs).padStart(4, '0')}`)
    }
    fs.writeFileSync(path.join(artifactsDir, 'opening-visual-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')
    record('opening visual sequence', 'deterministic splash frames captured at 0, 1000, 2000, and 2600 ms')
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  // A fresh profile now starts in first-run onboarding. Complete it through the
  // defaults route so the rest of the suite exercises the normal browser, and so
  // onboarding itself is covered end-to-end.
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"onboarding-page\\"]"))', 'first-run onboarding page', 60000)
  await clickByText(session, 'Configure')
  await waitFor(session, 'Boolean(document.querySelector("[data-onboarding-step-content=\\"1\\"]"))', 'onboarding appearance step')
  await clickByText(session, 'Next')
  await waitFor(session, 'Boolean(document.querySelector("[data-onboarding-step-content=\\"2\\"]"))', 'onboarding search step')
  await waitFor(session, '[...document.querySelectorAll(\'[role="radiogroup"][aria-label="Search engine"] img\')].length === 4 && [...document.querySelectorAll(\'[role="radiogroup"][aria-label="Search engine"] img\')].every((icon) => icon.complete && icon.naturalWidth > 0)', 'onboarding search logos')
  const searchBrands = await session.evaluate(`[...document.querySelectorAll('[role="radiogroup"][aria-label="Search engine"] [role="radio"]')].map((button) => ({
    label: button.textContent.trim(),
    iconLoaded: Boolean(button.querySelector('img')?.complete && button.querySelector('img')?.naturalWidth > 0),
    iconLocal: Boolean(button.querySelector('img')?.currentSrc && !button.querySelector('img').currentSrc.startsWith('http'))
  }))`)
  assertStrict.deepEqual(searchBrands, ['Google', 'DuckDuckGo', 'Brave Search', 'Perplexity'].map((label) => ({ label, iconLoaded: true, iconLocal: true })), 'Search engine choices must show local official logos alongside their names.')
  await session.screenshot('onboarding-search-brands')
  await clickByText(session, 'Next')
  await waitFor(session, 'Boolean(document.querySelector("[data-onboarding-step-content=\\"3\\"]"))', 'onboarding import step')
  await waitFor(session, '[...document.querySelectorAll(\'[role="radiogroup"][aria-label="Import from"] img\')].length === 3 && [...document.querySelectorAll(\'[role="radiogroup"][aria-label="Import from"] img\')].every((icon) => icon.complete && icon.naturalWidth > 0)', 'onboarding browser logos')
  const browserBrands = await session.evaluate(`[...document.querySelectorAll('[role="radiogroup"][aria-label="Import from"] [role="radio"]')].map((button) => ({
    label: button.textContent.trim(),
    iconLoaded: Boolean(button.querySelector('img')?.complete && button.querySelector('img')?.naturalWidth > 0),
    iconLocal: Boolean(button.querySelector('img')?.currentSrc && !button.querySelector('img').currentSrc.startsWith('http'))
  }))`)
  assertStrict.deepEqual(browserBrands, [
    { label: 'Chrome', iconLoaded: true, iconLocal: true },
    { label: 'Edge', iconLoaded: true, iconLocal: true },
    { label: 'Firefox', iconLoaded: true, iconLocal: true },
    { label: 'Fresh start', iconLoaded: false, iconLocal: false }
  ], 'Browser import choices must show local official logos while Fresh start remains unbranded.')
  await session.screenshot('onboarding-import-brands')
  await clickByText(session, 'Next')
  await waitFor(session, 'Boolean(document.querySelector("[data-onboarding-step-content=\\"4\\"]"))', 'onboarding extensions step')
  const extensionCopy = await session.evaluate('document.querySelector("[data-onboarding-step-content=\\"4\\"]").textContent')
  assert(!extensionCopy.includes('Extensions Hub'), 'The onboarding extensions step must not show Extensions Hub labels.')
  await session.screenshot('onboarding-extensions-copy')
  record('onboarding provider branding', 'local logos load for search and browser choices; Hub labels are absent')
  if (process.argv.includes('--onboarding-brand-only')) {
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    return
  }
  for (const previousStep of [3, 2, 1, 0]) {
    await session.evaluate(`document.querySelector('nav[aria-label="Onboarding navigation"] button')?.click()`)
    await waitFor(session, `Boolean(document.querySelector('[data-onboarding-step-content="${previousStep}"]'))`, `onboarding return to step ${previousStep}`)
  }
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"onboarding-use-defaults\\"]"))', 'onboarding welcome step')
  await clickByText(session, 'Use defaults')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"onboarding-enter-vast\\"]"))', 'onboarding ready step', 60000)
  await clickByText(session, 'Enter Vast')
  record('first-run onboarding', 'fresh profile completed onboarding and landed in the browser')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"new-tab-identity\\"]")) && document.body.innerText.includes("New tab")', 'initial new tab', 60000)
  if (process.argv.includes('--local-pdf-only')) {
    const activationArgs = packagedExecutable ? [localPdfPath] : [root, localPdfPath]
    const activationProcess = spawn(launchExecutable, activationArgs, {
      cwd: root,
      env,
      windowsHide: true,
      stdio: 'ignore'
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The secondary file-activation process did not exit.')), 10_000)
      activationProcess.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      activationProcess.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    await waitFor(
      session,
      'document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes("vast-local-open.pdf") && document.body.innerText.includes("Ready")',
      'Windows local PDF file activation',
      30_000
    )
    assert(fs.existsSync(localPdfPath), 'Viewing a local PDF removed the original file.')
    record('local PDF file activation', 'a second Vast launch routes the original file into the owner-scoped built-in viewer without deleting it')

    await setAddress(session, 'vast://newtab')
    await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"new-tab-identity\\"]"))', 'new tab before local PDF drop')
    const dropPoint = await session.evaluate(`(() => {
      const target = document.querySelector('.address-bar-form');
      if (!target) throw new Error('Address bar drop target is unavailable.');
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    const dragData = {
      items: [{ mimeType: 'application/pdf', data: '' }],
      files: [localPdfPath],
      dragOperationsMask: 1
    }
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', ...dropPoint, data: dragData })
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', ...dropPoint, data: dragData })
    await session.send('Input.dispatchDragEvent', { type: 'drop', ...dropPoint, data: dragData })
    await waitFor(
      session,
      'document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes("vast-local-open.pdf") && document.body.innerText.includes("Ready")',
      'local PDF dropped on the omnibar',
      30_000
    )
    record('omnibar local PDF drop', 'a native file drop opens the validated local PDF in the built-in viewer')
    const unexpectedRendererIssues = rendererIssues.filter((issue) => !isExpectedRendererIssue(issue))
    if (unexpectedRendererIssues.length) fail(`Renderer errors observed:\n${unexpectedRendererIssues.join('\n')}`)
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--download-only') || process.argv.includes('--download-pdf-only')) {
    await setAddress(session, `http://127.0.0.1:${localServerPort}/download.txt`)
    await waitFor(session, 'Boolean(document.querySelector(".download-progress-toast"))', 'download progress toast', 10_000)
    await waitForStorage(session, '(data) => data.downloads.some((item) => item.filename === "vast-smoke-download.txt" && item.state === "completed")', 'download completed', 30_000)
    record('download progress lifecycle', 'progress card appears from the initial event and the download completes')
    if (process.argv.includes('--download-pdf-only')) {
      await setAddress(session, `http://127.0.0.1:${localServerPort}/viewer.pdf`)
      await waitFor(
        session,
        'document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes("vast-smoke.pdf") && document.body.innerText.includes("Ready")',
        'PDF navigation after a download',
        30_000
      )
      record('post-download PDF navigation', 'a download cannot strand the guest before the next omnibar navigation')
    }
    const unexpectedRendererIssues = rendererIssues.filter((issue) => !isExpectedRendererIssue(issue))
    if (unexpectedRendererIssues.length) fail(`Renderer errors observed:\n${unexpectedRendererIssues.join('\n')}`)
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--pdf-only')) {
    await setAddress(session, `http://127.0.0.1:${localServerPort}/pdf-auth`)
    await waitForActiveWebview(session, 'document.title === "Authenticated PDF source"', 'authenticated PDF source')
    await executeInActiveWebview(session, 'document.querySelector("#secure-pdf").click(); true')
    await waitFor(
      session,
      'document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes("authenticated-session.pdf") && document.body.innerText.includes("Ready")',
      'session-bound PDF viewer',
      30_000
    )
    assert(authenticatedPdfRequests === 1, `Protected PDF was requested ${authenticatedPdfRequests} times instead of exactly once.`)
    const captured = await session.evaluate(`window.vast.storage.load().then(async (data) => {
      const activeWorkspace = data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId);
      const tab = data.tabs.find((candidate) => candidate.id === activeWorkspace?.activeTabId);
      const id = tab ? new URL(tab.url).searchParams.get('id') : null;
      return id ? window.vast.pdf.info(id) : { ok: false, error: 'missing id' };
    })`)
    assert(captured?.ok === true && captured.resource?.filename === 'authenticated-session.pdf', `Captured PDF metadata is invalid: ${JSON.stringify(captured)}`)
    record('session-aware PDF pipeline', 'cookie, Referer and Chromium UA survive one original MIME-detected request; viewer uses scoped cached ranges')
    await setAddress(session, `http://127.0.0.1:${localServerPort}/viewer.pdf`)
    await waitFor(
      session,
      'document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes("vast-smoke.pdf") && document.body.innerText.includes("Ready")',
      'direct omnibar PDF navigation',
      30_000
    )
    record('direct PDF navigation', 'typing a PDF URL in the omnibar routes the host-initiated download into the built-in viewer')
    const unexpectedRendererIssues = rendererIssues.filter((issue) => !isExpectedRendererIssue(issue))
    if (unexpectedRendererIssues.length) fail(`Renderer errors observed:\n${unexpectedRendererIssues.join('\n')}`)
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--purist-visual-only')) {
    await openCommand(session, 'Open settings')
    await clickByText(session, 'Open settings')
    await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', 'settings modal')
    await clickByText(session, 'Advanced')
    await setCheckboxByLabel(session, 'Experimental features', true)
    await waitForStorage(session, '(data) => data.settings.advanced.experimentalFeatures === true', 'Experimental features enabled')
    await clickByText(session, 'Appearance')
    await setSelectByLabel(session, 'Layout', 'purist')
    await waitForStorage(session, '(data) => data.settings.layoutMode === "purist"', 'Purist layout persisted')
    await clickByTitle(session, 'Close settings')
    await waitFor(session, 'Boolean(document.querySelector(".layout-purist .purist-chrome"))', 'lazy Purist chrome')

    const metrics = {}
    for (const theme of ['dark', 'dim', 'light']) {
      await openCommand(session, 'Open settings')
      await clickByText(session, 'Open settings')
      await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', `${theme} settings modal`)
      await clickByText(session, 'Appearance')
      await setSelectByLabel(session, 'Theme', theme)
      await waitForStorage(session, `(data) => data.settings.theme === ${JSON.stringify(theme)}`, `${theme} theme persisted`)
      await clickByTitle(session, 'Close settings')
      await waitFor(session, `document.querySelector('.app-shell')?.classList.contains(${JSON.stringify(`${theme}-theme`)})`, `${theme} Purist theme`)
      await wait(250)
      metrics[theme] = await session.evaluate(`(() => {
        const shell = document.querySelector('.app-shell');
        const chrome = document.querySelector('.purist-chrome');
        const island = document.querySelector('[data-testid="purist-topbar-island"]');
        const stage = document.querySelector('[data-testid="browser-stage"]');
        if (!shell || !chrome || !island || !stage) return null;
        const chromeStyle = getComputedStyle(chrome);
        const islandStyle = getComputedStyle(island);
        const islandRect = island.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        return {
          shellClass: shell.className,
          chromePosition: chromeStyle.position,
          chromePointerEvents: chromeStyle.pointerEvents,
          islandState: island.getAttribute('data-state'),
          islandWidth: Math.round(islandRect.width * 10) / 10,
          islandHeight: Math.round(islandRect.height * 10) / 10,
          islandRadius: islandStyle.borderTopLeftRadius,
          stageTop: Math.round(stageRect.top * 10) / 10,
          stageBackground: getComputedStyle(stage).backgroundColor
        };
      })()`)
      assert(metrics[theme]?.shellClass.includes('layout-purist'), `${theme}: Purist layout class is missing.`)
      assert(metrics[theme]?.chromePosition === 'absolute' && metrics[theme]?.chromePointerEvents === 'none', `${theme}: Purist chrome ownership changed.`)
      assert(metrics[theme]?.islandState === 'collapsed', `${theme}: Purist island no longer starts collapsed.`)
      await session.screenshot(`purist-${theme}`)
    }
    fs.writeFileSync(path.join(artifactsDir, 'purist-visual-metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8')
    record('Purist visual parity', 'dark, dim, and light screenshots captured with stable collapsed-island geometry')
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--settings-search-only')) {
    await openCommand(session, 'Open settings')
    await clickByText(session, 'Open settings')
    await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"settings-search-input\\"]"))', 'settings search input')
    await session.evaluate(`document.querySelector('[data-testid="settings-search-input"]')?.focus()`)
    for (const character of 'privacy') {
      await session.type(character)
      await wait(50)
      const inputState = await session.evaluate(`(() => {
        const input = document.querySelector('[data-testid="settings-search-input"]');
        return { value: input?.value || '', focused: document.activeElement === input };
      })()`)
      assert(inputState.focused, `Settings search lost focus after typing "${character}".`)
    }
    const searchAppearance = await session.evaluate(`(() => {
      const input = document.querySelector('[data-testid="settings-search-input"]');
      const panel = input?.closest('.settings-search-panel');
      if (!input || !panel) return null;
      const inputStyle = getComputedStyle(input);
      const panelStyle = getComputedStyle(panel);
      return {
        value: input.value,
        inputOutlineStyle: inputStyle.outlineStyle,
        inputOutlineWidth: inputStyle.outlineWidth,
        inputBoxShadow: inputStyle.boxShadow,
        panelRadius: parseFloat(panelStyle.borderTopLeftRadius),
        panelBorderColor: panelStyle.borderTopColor
      };
    })()`)
    assert(searchAppearance?.value === 'privacy', `Settings search value is incorrect: ${searchAppearance?.value}`)
    assert(searchAppearance.inputOutlineStyle === 'none' || searchAppearance.inputOutlineWidth === '0px', `Settings search still has an inner outline: ${JSON.stringify(searchAppearance)}`)
    assert(searchAppearance.inputBoxShadow === 'none', `Settings search still has an inner box shadow: ${JSON.stringify(searchAppearance)}`)
    assert(searchAppearance.panelRadius >= 10, `Settings search container is not rounded: ${JSON.stringify(searchAppearance)}`)
    record('settings search focus', 'focus survives every typed character and only the rounded container receives the focus treatment')
    await session.screenshot('00-settings-search-focus')

    const searchCases = [
      ['ram limit', 'Memory target (best effort)', 'Advanced'],
      ['mikrofon', 'Microphone', 'Site Data']
    ]
    for (const [query, expectedLabel, expectedSection] of searchCases) {
      await session.evaluate(`(() => {
        const input = document.querySelector('[data-testid="settings-search-input"]');
        input?.focus();
        input?.select();
      })()`)
      await session.type(query)
      await waitFor(session, `[
        ...document.querySelectorAll('[data-settings-search-result]')
      ].some((item) => item.getAttribute('data-settings-search-result') === ${JSON.stringify(expectedLabel)} && item.getAttribute('data-settings-search-section') === ${JSON.stringify(expectedSection)})`, `settings synonym result for ${query}`)
    }
    await session.evaluate(`[
      ...document.querySelectorAll('[data-settings-search-result]')
    ].find((item) => item.getAttribute('data-settings-search-result') === 'Microphone')?.click()`)
    await waitFor(session, `document.getElementById('Site Data')?.querySelector('.settings-search-highlight')?.innerText.includes('Microphone')`, 'direct settings search result highlight')
    record('settings search catalog', 'function names, English and Polish synonyms, reordered words, typo tolerance, and direct result navigation work')
    await session.screenshot('00-settings-search-powerful')
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--new-tab-chrome-only')) {
    await openCommand(session, 'Open settings')
    await clickByText(session, 'Open settings')
    await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', 'settings modal')
    await setCheckboxByLabel(session, 'Bookmarks bar', true)
    await clickByTitle(session, 'Close settings')
    await waitFor(session, 'Boolean(document.querySelector(".horizontal-bookmarks-bar"))', 'New Tab bookmarks bar')
    const chromeAppearance = await session.evaluate(`(() => {
      const shell = document.querySelector('.app-shell');
      const surface = document.querySelector('.app-main-surface');
      const chrome = document.querySelector('.horizontal-chrome');
      const addressDivider = document.querySelector('.horizontal-chrome .address-bar-divider');
      const bookmarks = document.querySelector('.horizontal-bookmarks-bar');
      const stage = document.querySelector('.browser-stage');
      const newTabPage = document.querySelector('.new-tab-page');
      if (!shell || !surface || !chrome || !addressDivider || !bookmarks || !stage || !newTabPage) return null;
      const surfaceStyle = getComputedStyle(surface);
      const chromeStyle = getComputedStyle(chrome);
      const addressDividerStyle = getComputedStyle(addressDivider);
      const bookmarkStyle = getComputedStyle(bookmarks);
      const stageStyle = getComputedStyle(stage);
      const newTabStyle = getComputedStyle(newTabPage);
      return {
        newTabClass: shell.classList.contains('is-new-tab'),
        stageNewTabClass: stage.classList.contains('is-new-tab'),
        surfaceBackgroundImage: surfaceStyle.backgroundImage,
        stageBackgroundImage: stageStyle.backgroundImage,
        newTabBackgroundImage: newTabStyle.backgroundImage,
        chromeBackgroundImage: chromeStyle.backgroundImage,
        surfaceBeforeDisplay: getComputedStyle(surface, '::before').display,
        chromeBeforeDisplay: getComputedStyle(chrome, '::before').display,
        chromeAfterDisplay: getComputedStyle(chrome, '::after').display,
        upperDividerColor: addressDividerStyle.borderTopColor,
        lowerDividerColor: chromeStyle.borderBottomColor,
        bookmarkBorderWidth: bookmarkStyle.borderTopWidth,
        lowerDividerWidth: chromeStyle.borderBottomWidth,
        upperDividerWidth: addressDividerStyle.borderTopWidth
      };
    })()`)
    assert(chromeAppearance?.newTabClass && chromeAppearance?.stageNewTabClass, `New Tab state class is missing: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.surfaceBackgroundImage === 'none' && chromeAppearance.stageBackgroundImage === 'none' && chromeAppearance.newTabBackgroundImage === 'none', `New Tab surface still has a gradient: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.chromeBackgroundImage === 'none', `Horizontal chrome still has a gradient: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.surfaceBeforeDisplay === 'none' && chromeAppearance.chromeBeforeDisplay === 'none', `New Tab decorative gradients remain: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.chromeAfterDisplay === 'none', `Horizontal chrome accent divider remains: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.upperDividerColor === chromeAppearance.lowerDividerColor, `Bookmark dividers use different colors: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.bookmarkBorderWidth === '0px', `Bookmarks bar still adds a second separator: ${JSON.stringify(chromeAppearance)}`)
    assert(chromeAppearance.upperDividerWidth === chromeAppearance.lowerDividerWidth, `Bookmark dividers use different widths: ${JSON.stringify(chromeAppearance)}`)
    record('New Tab chrome', 'flat canvas and identical neutral bookmark dividers with no accent gradient')
    await session.screenshot('00-new-tab-flat-chrome')
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--marriott-only')) {
    const marriottUrl = 'https://www.marriott.com/search/availabilityCalendar.mi?fromDate=09%2F12%2F2026&toDate=09%2F13%2F2026&propertyCode=madeb&numberOfGuests=2&numberOfRooms=1&marriottRewardsNumber=&corporateCode=&useRewardsPoints=false&flexibleDateSearch=false&costTab=total&isAdultsOnly=false#/31/'
    await setAddress(session, marriottUrl)
    await waitFor(session, 'Boolean([...document.querySelectorAll("webview.browser-webview")].find((item) => item.getClientRects().length > 0))', 'Marriott diagnostic webview')
    await session.evaluate(`(() => {
      const webview = [...document.querySelectorAll('webview.browser-webview')].find((item) => item.getClientRects().length > 0);
      if (!webview) throw new Error('Active Marriott diagnostic webview not found.');
      const started = performance.now();
      window.__vastMarriottTrace = [];
      for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page']) {
        webview.addEventListener(name, (event) => {
          window.__vastMarriottTrace.push({
            name,
            at: Math.round(performance.now() - started),
            eventUrl: event.url || '',
            currentUrl: webview.getURL()
          });
        });
      }
      return true;
    })()`)
    await wait(20_000)
    const diagnostic = await session.evaluate(`(() => {
      const trace = window.__vastMarriottTrace || [];
      const webview = [...document.querySelectorAll('webview.browser-webview')].find((item) => item.getClientRects().length > 0);
      return {
        currentUrl: webview?.getURL() || '',
        startCount: trace.filter((item) => item.name === 'did-start-loading').length,
        navigationCount: trace.filter((item) => item.name === 'did-navigate').length,
        inPageCount: trace.filter((item) => item.name === 'did-navigate-in-page').length,
        stopCount: trace.filter((item) => item.name === 'did-stop-loading').length,
        trace
      };
    })()`)
    fs.writeFileSync(path.join(artifactsDir, 'marriott-navigation-trace.json'), `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8')
    const lastNavigationAt = Math.max(0, ...diagnostic.trace
      .filter((item) => item.name === 'did-navigate' || item.name === 'did-navigate-in-page')
      .map((item) => item.at))
    assert(diagnostic.navigationCount <= 2, `Marriott performed ${diagnostic.navigationCount} full navigations: ${JSON.stringify(diagnostic.trace.slice(-20))}`)
    assert(diagnostic.inPageCount <= 12, `Marriott remained in an in-page navigation loop (${diagnostic.inPageCount} changes): ${JSON.stringify(diagnostic.trace.slice(-20))}`)
    assert(lastNavigationAt < 15_000, `Marriott navigation did not stabilize within 15 seconds: ${JSON.stringify(diagnostic.trace.slice(-20))}`)
    record('Marriott navigation stability', `${diagnostic.navigationCount} full navigation, ${diagnostic.inPageCount} in-page changes, stable after ${lastNavigationAt} ms`)
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--smart-unload-only')) {
    await openCommand(session, 'Open settings')
    await clickByText(session, 'Open settings')
    await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', 'settings modal')
    await session.evaluate(`document.querySelector('[data-settings-select="Layout"] button[aria-haspopup="listbox"]')?.click()`)
    await waitFor(session, 'Boolean(document.querySelector(\'[role="listbox"][aria-label="Layout"]\'))', 'layout choices')
    const stableLayoutChoices = await session.evaluate(`[
      ...document.querySelectorAll('[role="listbox"][aria-label="Layout"] [role="option"]')
    ].map((option) => option.innerText.trim())`)
    assert(!stableLayoutChoices.includes('Purist'), 'Purist remains visible while Experimental features is disabled.')
    await session.screenshot('00-experimental-layout-hidden')
    await session.evaluate(`document.querySelector('[data-settings-select="Layout"] button[aria-haspopup="listbox"]')?.click()`)

    await clickByText(session, 'Advanced')
    await setCheckboxByLabel(session, 'Experimental features', true)
    await waitForStorage(session, '(data) => data.settings.advanced.experimentalFeatures === true', 'Experimental features enabled')
    await clickByText(session, 'Appearance')
    await session.evaluate(`document.querySelector('[data-settings-select="Layout"] button[aria-haspopup="listbox"]')?.click()`)
    await waitFor(session, 'Boolean(document.querySelector(\'[role="listbox"][aria-label="Layout"]\'))', 'experimental layout choices')
    const experimentalLayoutChoices = await session.evaluate(`[
      ...document.querySelectorAll('[role="listbox"][aria-label="Layout"] [role="option"]')
    ].map((option) => option.innerText.trim())`)
    assert(experimentalLayoutChoices.includes('Purist'), 'Purist did not appear after Experimental features was enabled.')
    record('experimental feature visibility', 'Purist is absent while disabled and appears only after opt-in')
    await session.evaluate(`document.querySelector('[data-settings-select="Layout"] button[aria-haspopup="listbox"]')?.click()`)
    await clickByText(session, 'Advanced')
    await setCheckboxByLabel(session, 'Experimental features', false)
    await waitForStorage(session, '(data) => data.settings.advanced.experimentalFeatures === false', 'Experimental features disabled')
    await clickByTitle(session, 'Close settings')

    await openCommand(session, 'Smart unload')
    await clickByText(session, 'Open Smart Unload')
    await waitFor(session, 'Boolean(document.querySelector(".smart-unload-panel"))', 'Smart Unload panel')
    const smartUnloadColors = await session.evaluate(`(() => {
      const panel = document.querySelector('.smart-unload-panel');
      const summary = document.querySelector('.smart-unload-summary');
      return {
        theme: panel?.closest('.dark-theme, .dim-theme, .light-theme')?.className || '',
        panel: panel ? getComputedStyle(panel).backgroundColor : '',
        summary: summary ? getComputedStyle(summary).backgroundColor : ''
      };
    })()`)
    assert(smartUnloadColors.theme.includes('dark-theme'), 'Smart Unload smoke did not run under the selected Dark theme.')
    assert(smartUnloadColors.panel === 'rgb(5, 5, 7)', `Dark Smart Unload panel is not near-black: ${smartUnloadColors.panel}`)
    assert(smartUnloadColors.summary === 'rgb(12, 13, 18)', `Dark Smart Unload summary surface is incorrect: ${smartUnloadColors.summary}`)
    record('Smart Unload theme', 'Dark uses the Vast #050507 canvas with #0c0d12 controls')
    await session.screenshot('00-smart-unload-dark')

    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  if (process.argv.includes('--split-view-only')) {
    await runSplitViewSmoke(session, localServerPort)
    const unexpectedRendererIssues = rendererIssues.filter(
      (issue) =>
        !isExpectedRendererIssue(issue) &&
        !issue.includes('ERR_FAILED (-2) loading') &&
        !issue.includes('ERR_UNSAFE_PORT') &&
        !issue.includes('ERR_ABORTED (-3) loading')
    )
    if (unexpectedRendererIssues.length) fail(`Renderer errors observed:\n${unexpectedRendererIssues.join('\n')}`)
    session.close()
    cleanup()
    console.log(`\n${checks.length} targeted app checks passed.`)
    console.log(`Artifacts: ${artifactsDir}`)
    return
  }
  let body = await session.bodyText()
  assert(body.includes('Workspace') && body.includes('New tab'), 'Initial shell did not render the clean first-launch surfaces.')
  assert(!body.includes('Opening Vast') && !body.includes('Restoring local session'), 'Old startup loader text is visible.')
  assert(!body.includes('VAST RECOVERED'), 'Renderer error boundary is visible on startup.')
  record('startup renders shell', 'one workspace, one new tab, and the side panel closed')
  await session.screenshot('01-startup')

  await openCommand(session, 'Open Privacy Settings')
  await clickByText(session, 'Open Privacy Settings')
  await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', 'settings modal for vertical layout')
  await setSelectByLabel(session, 'Layout', 'vertical')
  await waitForStorage(session, '(data) => data.settings.layoutMode === "vertical"', 'vertical layout persisted')
  await clickByTitle(session, 'Close settings')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"vertical-tabs-list\\"]"))', 'vertical sidebar rendered')

  const verticalSidebarState = await session.evaluate(`(() => {
    const list = document.querySelector('[data-testid="vertical-tabs-list"]');
    const sidebar = list?.closest('aside');
    const newTab = sidebar?.querySelector('[data-testid="vertical-new-tab"]');
    return {
      text: sidebar?.innerText || '',
      tabCount: list?.querySelectorAll('[data-tab-motion-id]').length || 0,
      hasNewTab: Boolean(newTab),
      newTabAtBottom: Boolean(newTab && sidebar && newTab.getBoundingClientRect().bottom <= sidebar.getBoundingClientRect().bottom)
    };
  })()`)
  assert(!verticalSidebarState.text.toUpperCase().includes('LOCAL BY DEFAULT'), 'Vertical sidebar still shows the removed brand subtitle.')
  assert(!verticalSidebarState.text.toUpperCase().includes('TODAY'), 'Vertical sidebar still renders the default Today group heading.')
  assert(!verticalSidebarState.text.includes('Search or enter address'), 'Vertical sidebar still has the redundant bottom address action.')
  assert(verticalSidebarState.tabCount > 0 && verticalSidebarState.hasNewTab && verticalSidebarState.newTabAtBottom, 'Vertical tabs or the cleaned New tab control are missing.')
  record('vertical sidebar cleanup', 'flat tab list, compact Vast brand, clean bottom New tab action, and no duplicate address control')
  await session.screenshot('01b-vertical-sidebar')

  const openingIdentityState = await session.evaluate(`(() => {
    const identity = document.querySelector('[data-testid="new-tab-identity"]');
    const logo = identity?.querySelector('.vast-logo-image');
    return identity && logo ? { text: identity.innerText, logoHeight: logo.getBoundingClientRect().height } : null;
  })()`)
  assert(openingIdentityState && !openingIdentityState.text.toLowerCase().includes('workspace'), 'Opening identity still shows the redundant workspace label.')
  assert(openingIdentityState.logoHeight >= 104, 'Opening Vast logo was not enlarged.')
  record('opening identity', 'larger Vast logo with no redundant workspace label')

  const addressControlSizing = await session.evaluate(`(() => {
    const address = document.querySelector('.vast-top-address');
    const groups = [...document.querySelectorAll('.address-bar-controls')];
    const leftButton = groups[0]?.querySelector(':scope > button');
    const rightButton = groups[1]?.querySelector(':scope > button, :scope > div > button');
    const panelPin = [...document.querySelectorAll('button')].find((item) => item.title === 'Pin sidebar over page' || item.title === 'Unpin sidebar');
    const closeInsidePanel = [...document.querySelectorAll('.side-panel-header button')].some((item) => item.title === 'Close sidebar');
    return address && leftButton && rightButton ? {
      addressHeight: address.getBoundingClientRect().height,
      leftHeight: leftButton.getBoundingClientRect().height,
      rightHeight: rightButton.getBoundingClientRect().height,
      panelPinHeight: panelPin?.getBoundingClientRect().height ?? null,
      closeInsidePanel
    } : null;
  })()`)
  assert(addressControlSizing && Math.abs(addressControlSizing.addressHeight - addressControlSizing.leftHeight) <= 4, `Left address controls do not align with the omnibox height: ${JSON.stringify(addressControlSizing)}`)
  assert(Math.abs(addressControlSizing.addressHeight - addressControlSizing.rightHeight) <= 4, `Right address controls do not align with the omnibox height: ${JSON.stringify(addressControlSizing)}`)
  assert(addressControlSizing.panelPinHeight === null || addressControlSizing.panelPinHeight === addressControlSizing.leftHeight, `Sidebar pin control does not match the address control height: ${JSON.stringify(addressControlSizing)}`)
  assert(addressControlSizing.closeInsidePanel === false, 'Sidebar still contains a duplicate close button.')
  record('chrome control sizing', 'navigation and omnibox tools use one balanced height; the sidebar does not duplicate its close toggle')

  const addressUnfocusedState = await session.evaluate(`(async () => {
    const input = document.querySelector('.address-bar-input');
    if (!input) return null;
    // onBlur defers state by 120 ms and the color transition takes 150 ms.
    // Leave scheduler headroom so CI never samples the transition boundary.
    input.focus();
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.blur();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const unfocusedInput = document.querySelector('.address-bar-input');
    if (!unfocusedInput) return null;
    return {
      color: getComputedStyle(unfocusedInput).color
    };
  })()`)
  assert(addressUnfocusedState, 'Address input was unavailable before the focus interaction.')
  await session.evaluate(`(() => {
    const input = document.querySelector('.address-bar-input');
    if (!input) throw new Error('Address input not found for focus styling.');
    input.focus();
    return true;
  })()`)
  await wait(450)
  const addressFocusStyle = await session.evaluate(`(() => {
    const focusedInput = document.querySelector('.address-bar-input');
    const focusedContainer = focusedInput?.closest('.vast-top-address');
    if (!focusedInput || !focusedContainer) return null;
    const inputStyle = getComputedStyle(focusedInput);
    const containerStyle = getComputedStyle(focusedContainer);
    const outlineColor = inputStyle.outlineColor;
    const outlineAlpha = outlineColor === 'transparent'
      ? 0
      : outlineColor.startsWith('rgba(')
        ? Number(outlineColor.slice(5, -1).split(',').at(-1)?.trim())
        : 1;
    const transparentOutline = Number.isFinite(outlineAlpha) && outlineAlpha === 0;
    const result = {
      outline: inputStyle.outlineStyle,
      outlineWidth: Number.parseFloat(inputStyle.outlineWidth),
      outlineColor,
      outlineVisible: inputStyle.outlineStyle !== 'none' && Number.parseFloat(inputStyle.outlineWidth) > 0 && !transparentOutline,
      shadow: inputStyle.boxShadow,
      containerRadius: Number.parseFloat(containerStyle.borderRadius),
      focusedColor: inputStyle.color,
      unfocusedColor: ${JSON.stringify(addressUnfocusedState.color)},
      className: focusedInput.className
    };
    focusedInput.blur();
    return result;
  })()`)
  assert(addressFocusStyle && !addressFocusStyle.outlineVisible, `Address input renders an inner focus outline: ${JSON.stringify(addressFocusStyle)}`)
  assert(addressFocusStyle?.shadow === 'none', 'Address input renders an inner rectangular focus shadow.')
  assert(addressFocusStyle?.containerRadius > 0, 'Address focus is not represented by the rounded omnibox container.')
  assert(addressFocusStyle?.focusedColor !== addressFocusStyle?.unfocusedColor, `Unfocused URL is not visually muted: ${JSON.stringify(addressFocusStyle)}`)
  record('address focus treatment', 'focus stays on the rounded omnibox and the URL becomes muted after blur')

  await session.evaluate(`(() => {
    const input = document.querySelector('.address-bar-input');
    if (!input) throw new Error('Address input not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, 'draft survives sidebar');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  const initialSidePanelToggle = await session.evaluate(`([...document.querySelectorAll('button')].find((item) => item.title === 'Hide sidebar' || item.title === 'Show sidebar'))?.title`)
  assert(initialSidePanelToggle, 'Sidebar toggle was not found for address draft regression.')
  await activateButtonByTitle(session, initialSidePanelToggle)
  const restoredSidePanelToggle = initialSidePanelToggle === 'Hide sidebar' ? 'Show sidebar' : 'Hide sidebar'
  await waitFor(session, `Boolean(document.querySelector('button[title=${JSON.stringify(restoredSidePanelToggle)}]'))`, 'Sidebar toggle state after address draft check')
  const addressDraftAfterSidebarToggle = await session.evaluate(`document.querySelector('.address-bar-input')?.value`)
  assert(addressDraftAfterSidebarToggle === 'draft survives sidebar', 'Opening or closing the Sidebar erased the address draft.')
  await activateButtonByTitle(session, restoredSidePanelToggle)
  await waitForStorage(session, `(data) => data.sidePanelOpen === ${initialSidePanelToggle === 'Hide sidebar'}`, 'Sidebar restored after address draft check')
  await wait(300)
  await session.evaluate(`document.querySelector('.address-bar-input')?.focus()`)
  await session.key('Escape', 'Escape', 27)
  record('address draft persistence', 'Sidebar focus changes preserve typed text and Escape restores the active URL')

  assert(!body.includes('Add quick link'), 'Opening screen still shows the add quick link card.')
  record('opening quick links', 'add quick link card is hidden from the opening screen')

  await openCommand(session)
  body = await session.bodyText()
  assert(body.includes('Toggle split view') && body.includes('Clear history'), 'Command palette is missing expected actions.')
  record('command palette opens', 'actions, tabs, settings commands present')
  await session.screenshot('02-command-palette')
  await session.key('Escape', 'Escape', 27)

  await clickByText(session, 'Workspace')
  await clickByText(session, 'New workspace')
  await submitPrompt(session, 'QA Space', 'Create workspace')
  await waitForStorage(session, '(data) => data.workspaces.some((workspace) => workspace.name === "QA Space")', 'workspace creation')
  record('workspace creation', 'in-app prompt-created workspace appears')

  await openCommand(session, 'Workspace')
  await clickByText(session, 'Switch to Workspace')
  await waitForCommandClosed(session)
  await waitForStorage(session, '(data) => data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.name === "Workspace"', 'switch to default workspace')
  await openCommand(session, 'QA Space')
  await clickByText(session, 'Switch to QA Space')
  await waitForCommandClosed(session)
  await waitForStorage(session, '(data) => data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.name === "QA Space"', 'switch back to QA Space')
  await closeWorkspacePopover(session)
  record('workspace switching', 'command palette switches workspaces')

  await session.ctrl('t', 'KeyT', 84)
  await waitForStorage(session, '(data) => data.tabs.filter((tab) => tab.workspaceId === data.activeWorkspaceId).length >= 2', 'new tab persisted')
  record('new tab shortcut', 'tab added and persisted')

  await session.ctrl('b', 'KeyB', 66)
  await waitForStorage(session, '(data) => data.sidebarCollapsed === false', 'sidebar expanded')
  record('sidebar shortcut', 'the compact default sidebar expands and persists via Ctrl+B')

  await openCommand(session, 'duplicate')
  await clickByText(session, 'Duplicate current tab')
  await waitForStorage(session, '(data) => data.tabs.filter((tab) => tab.workspaceId === data.activeWorkspaceId).length >= 3', 'duplicate tab command')
  record('duplicate tab command', 'command palette duplicates active tab')

  await setAddress(session, `http://127.0.0.1:${localServerPort}/page`)
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url.includes("127.0.0.1"))', 'navigated tab persisted')
  await waitForActiveWebview(session, `document.title === 'Vast Local Test'`, 'local page navigation', 45_000)
  record('real navigation', 'local deterministic page loaded through webview')

  // Start this navigation through the address bar instead of a coordinate-based
  // guest click. The click can race a transient duplicate webview in headless
  // Windows; the redirect and cookie round-trip exercised below are unchanged.
  await setAddress(session, `http://localhost:${localServerPort}/session-start`)
  await waitForActiveWebview(session, `document.body.dataset.crossSiteSession === 'session-ok'`, 'cross-site top-level session cookie preserved', 25_000)
  record('cross-site auth session', 'top-level redirect keeps its session cookie while third-party cookie protection remains enabled')
  await setAddress(session, `http://127.0.0.1:${localServerPort}/page`)
  await waitForActiveWebview(session, `document.querySelector('#cross-site-session') !== null`, 'local page restored after cross-site session check', 25_000)

  const popupPolicy = await session.evaluate(`(() => {
    const webview = [...document.querySelectorAll('webview.browser-webview')]
      .find((item) => {
        const rect = item.getBoundingClientRect();
        return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
      });
    return {
      hasAttribute: webview?.hasAttribute('allowpopups'),
      attribute: webview?.getAttribute('allowpopups'),
      property: webview?.allowpopups
    };
  })()`)
  assert(popupPolicy.hasAttribute === true, `Active webview is missing allowpopups: ${JSON.stringify(popupPolicy)}`)

  // Fullscreen requires a renderer user activation. CDP mouse coordinates sent
  // to the embedder are not consistently promoted to a guest activation by a
  // packaged Chromium build, while webview.executeJavaScript's userGesture flag
  // is the supported deterministic way to exercise this permission boundary.
  const fullscreenRequest = await executeInActiveWebview(session, `(async () => {
    try {
      await document.documentElement.requestFullscreen();
      return {
        ok: true,
        enabled: document.fullscreenEnabled,
        active: document.fullscreenElement === document.documentElement
      };
    } catch (error) {
      return {
        ok: false,
        enabled: document.fullscreenEnabled,
        active: Boolean(document.fullscreenElement),
        name: error?.name,
        message: error?.message
      };
    }
  })()`)
  assert(fullscreenRequest?.ok && fullscreenRequest.active, `Guest Fullscreen API request failed: ${JSON.stringify(fullscreenRequest)}`)
  await waitFor(session, 'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.htmlFullscreen === "true"', 'HTML video fullscreen entered', 25_000)
  const fullscreenChromeState = await session.evaluate(`({
    stage: document.querySelector('[data-testid="browser-stage"]')?.dataset.htmlFullscreen,
    sidebarVisible: Boolean(document.querySelector('aside')),
    addressVisible: Boolean(document.querySelector('.address-bar-input'))
  })`)
  assert(fullscreenChromeState?.stage === 'true', 'Fullscreen guest was not promoted to the app fullscreen surface.')
  assert(fullscreenChromeState?.sidebarVisible === false && fullscreenChromeState?.addressVisible === false, `Vast chrome remained visible over HTML fullscreen: ${JSON.stringify(fullscreenChromeState)}`)
  await executeInActiveWebview(session, 'document.exitFullscreen(); true')
  await waitFor(session, 'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.htmlFullscreen === "false"', 'HTML video fullscreen exited', 25_000)
  record('HTML video fullscreen', 'guest player fullscreen fills the native window, hides Vast chrome, and restores it on exit')

  let externalAppPromptShown = false
  for (let attempt = 0; attempt < 3 && !externalAppPromptShown; attempt += 1) {
    // An unregistered custom-scheme location assignment can be discarded by a
    // packaged Windows Chromium before it becomes a navigation event. The
    // window-open path reaches the same production approval broker without
    // registering or launching a fake OS protocol handler during the smoke run.
    await executeInActiveWebview(session, `window.open('vast-smoke-app://open/from-browser'); true`)
    try {
      await waitFor(session, 'document.body.innerText.includes("Open vast-smoke-app app?") && document.body.innerText.includes("Open app") && document.body.innerText.includes("Block")', 'external app approval notification', 5_000)
      externalAppPromptShown = true
    } catch {
      // Native protocol dispatch can lose a synthetic click while fullscreen
      // ownership is settling; retry the same explicit user action.
    }
  }
  assert(externalAppPromptShown, 'External app approval notification did not appear after three explicit clicks.')
  await clickByText(session, 'Block')
  await waitFor(session, '!document.body.innerText.includes("Open vast-smoke-app app?")', 'external app request blocked')
  await waitForActiveWebview(session, 'document.title === "Vast Local Test"', 'external app request kept source page')
  record('external app protocol', 'custom protocol requests stay on the source page and require a one-time Open app / Block choice')

  await executeInActiveWebview(session, `(() => {
    Notification.requestPermission()
      .then((result) => { document.body.dataset.notificationPermission = result })
      .catch((error) => { document.body.dataset.notificationPermission = error?.name || 'error' });
    return true;
  })()`)
  let notificationPromptShown = true
  try {
    await waitFor(session, 'document.body.innerText.includes("Always allow") && document.body.innerText.includes("notifications")', 'notification permission prompt', 5_000)
  } catch {
    notificationPromptShown = false
  }
  if (!notificationPromptShown) {
    const notificationState = await executeInActiveWebview(session, `({
      result: document.body.dataset.notificationPermission,
      platformPermission: Notification.permission
    })`)
    assert(
      packagedExecutable && notificationState?.result === 'denied' && notificationState.platformPermission === 'denied',
      `Notification permission produced neither Vast's prompt nor an explicit packaged Windows denial: ${JSON.stringify(notificationState)}`
    )
    record('packaged notification platform gate', 'unsigned win-unpacked received an explicit native Windows denial before Electron prompting')
  } else {
    await clickByText(session, 'Always allow')
    await waitForActiveWebview(session, `document.body.dataset.notificationPermission === 'granted'`, 'notification permission granted')
    await waitForStorage(
      session,
      `(data) => data.settings.security.sitePermissions.some((item) => item.origin === 'http://127.0.0.1:${localServerPort}' && item.permission === 'notifications' && item.setting === 'allow')`,
      'origin notification permission persisted'
    )
    const permissionAutosaveToggle = await session.evaluate(`([...document.querySelectorAll('button')].find((item) => item.title === 'Hide sidebar' || item.title === 'Show sidebar'))?.title`)
    assert(permissionAutosaveToggle, 'Sidebar toggle was not found for permission autosave regression.')
    await activateButtonByTitle(session, permissionAutosaveToggle)
    await wait(1_500)
    await waitForStorage(
      session,
      `(data) => data.settings.security.sitePermissions.some((item) => item.origin === 'http://127.0.0.1:${localServerPort}' && item.permission === 'notifications' && item.setting === 'allow')`,
      'permission survives renderer autosave'
    )
    const restoredPermissionToggle = permissionAutosaveToggle === 'Hide sidebar' ? 'Show sidebar' : 'Hide sidebar'
    await waitFor(session, `Boolean(document.querySelector('button[title=${JSON.stringify(restoredPermissionToggle)}]'))`, 'Sidebar toggle state after permission autosave')
    await activateButtonByTitle(session, restoredPermissionToggle)
    record('site permission persistence', 'Always allow survives renderer autosave and remains scoped to the requesting origin')
  }

  const requestScreenShare = () => executeInActiveWebview(session, `(() => {
    document.body.dataset.screenShare = 'pending';
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      .then((stream) => {
        document.body.dataset.screenShare = 'granted:' + stream.getVideoTracks().length;
        stream.getTracks().forEach((track) => track.stop());
      })
      .catch((error) => { document.body.dataset.screenShare = 'denied:' + error.name });
    return true;
  })()`)
  await requestScreenShare()
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"prompt-choice-grid\\"]"))', 'screen-share source picker', 25_000)
  const screenSourceCount = await session.evaluate(`document.querySelectorAll('[data-testid="prompt-choice"]').length`)
  assert(screenSourceCount > 0, 'Screen-share picker did not expose any selectable displays or windows.')
  await session.evaluate(`document.querySelector('[data-testid="prompt-choice"]')?.click()`)
  await waitForActiveWebview(session, `document.body.dataset.screenShare === 'granted:1'`, 'screen capture granted from selected source', 25_000)
  const screenShareLogPath = path.join(userDataDir, 'Logs', 'screen-share.log')
  const screenShareLog = await waitForFileContaining(screenShareLogPath, 'request granted', 'screen-share grant log')
  assert(!/screen:\d|window:\d/i.test(screenShareLog), 'Screen-share diagnostics leaked a desktop source identifier.')

  await requestScreenShare()
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"prompt-choice-grid\\"]"))', 'screen-share cancel picker', 25_000)
  await session.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.innerText.trim() === 'Cancel');
    if (!button) throw new Error('Screen-share Cancel button not found.');
    button.click();
    return true;
  })()`)
  await waitForActiveWebview(session, `document.body.dataset.screenShare.startsWith('denied:')`, 'screen capture cancellation', 25_000)
  record('screen sharing', 'fresh user-gesture source picker grants one selected source, stops cleanly, redacts logs, and supports cancellation')

  await clickInActiveWebview(session, '#target-blank')
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url.includes("/target-blank"))', 'target blank tab persisted')
  record('target blank routing', 'left-click target=_blank opens a Vast tab')
  await clickByTitle(session, 'Vast Local Test')
  await waitForActiveWebview(session, `document.title === 'Vast Local Test'`, 'source tab restored after target blank')

  await executeInActiveWebview(session, `window.open('/script-open'); true`)
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url.includes("/script-open"))', 'window.open tab persisted')
  record('window open routing', 'ordinary window.open(url) opens a Vast tab')
  await clickByTitle(session, 'Vast Local Test')
  await waitForActiveWebview(session, `document.title === 'Vast Local Test'`, 'source tab restored after window.open')


  await setAddress(session, `http://127.0.0.1:${localServerPort}/compat-source`)
  await waitForActiveWebview(session, `document.title === 'Compat Source'`, 'compat source page')

  await clickInActiveWebview(session, '#guarded-download')
  try {
    await waitForStorage(session, '(data) => data.downloads.some((item) => item.filename === "vast-compat-download.txt" && item.state === "completed")', 'guarded referer download completed', 20_000)
  } catch (error) {
    const activeWebviewState = await session.evaluate(`(() => {
      const webview = [...document.querySelectorAll('webview.browser-webview')]
        .find((item) => item.getClientRects().length > 0 && item.getBoundingClientRect().width > 0)
      return webview ? webview.getAttribute('src') : 'none-visible'
    })()`).catch((evaluateError) => `eval-failed:${evaluateError.message}`)
    const guestState = await Promise.resolve(executeInActiveWebview(session, 'location.href + " | " + document.title'))
      .catch((evaluateError) => `guest-eval-failed:${evaluateError.message}`)
    console.log('DIAG guarded-download activeWebviewSrc:', activeWebviewState)
    console.log('DIAG guarded-download guest:', guestState)
    const authLogDiagnostic = path.join(userDataDir, 'Logs', 'google-auth.log')
    try {
      const authLogText = fs.readFileSync(authLogDiagnostic, 'utf8')
      console.log('DIAG guarded-download auth log:', authLogText.split('\n').filter((line) => line.includes('guarded-download')).slice(-5).join('\n'))
    } catch (readError) {
      console.log('DIAG guarded-download auth log missing:', readError.message)
    }
    throw error
  }
  await waitForStorage(session, '(data) => !data.tabs.some((tab) => tab.url.includes("failed=referrer") || tab.url.includes("failed=token"))', 'guarded download did not bounce back to the source page')
  await session.ctrl('w', 'KeyW', 87)
  record('guarded target=_blank download', 'referrer-guarded target=_blank download completes with Content-Disposition instead of bouncing to the source page')

  await clickByTitle(session, 'Compat Source')
  await waitForActiveWebview(session, `document.title === 'Compat Source'`, 'compat source page restored')
  await executeInActiveWebview(session, `document.getElementById('compat-post').submit(); true`)
  await waitForActiveWebview(session, `document.body.dataset.postVerdict === 'post-ok'`, 'POST body preserved in new tab', 20_000)
  await session.ctrl('w', 'KeyW', 87)
  record('target=_blank POST navigation', 'form POST target=_blank stays POST with its body in the new Vast tab')

  await clickByTitle(session, 'Compat Source')
  await waitForActiveWebview(session, `document.title === 'Compat Source'`, 'compat source page restored again')
  await executeInActiveWebview(session, `document.getElementById('compat-named-one').click(); true`)
  await waitForActiveWebview(session, `(document.getElementById('compat-status').dataset.messages ?? '').includes('one:/compat-one')`, 'named popup first message', 15_000)
  await executeInActiveWebview(session, `document.getElementById('compat-named-two').click(); true`)
  await waitForActiveWebview(session, `(document.getElementById('compat-status').dataset.messages ?? '').includes('two:/compat-two')`, 'named popup second message', 15_000)
  const namedReuseVerdict = await executeInActiveWebview(session, `(() => ({
    firstNotNull: window.__compatFirst !== null && window.__compatFirst !== undefined,
    sameWindow: window.__compatFirst === window.__compatSecond,
    firstPath: window.__compatFirst && window.__compatFirst.location.pathname
  }))()`)
  assert(namedReuseVerdict.firstNotNull && namedReuseVerdict.sameWindow && namedReuseVerdict.firstPath === '/compat-two', `Named window.open reuse broken: ${JSON.stringify(namedReuseVerdict)}`)
  await waitForStorage(session, '(data) => !data.tabs.some((tab) => tab.url.includes("/compat-one") || tab.url.includes("/compat-two"))', 'named popups did not become tabs')
  await executeInActiveWebview(session, `window.__compatFirst.close(); true`)
  record('named window.open', 'named window.open opens one reusable real popup with native opener semantics')
  // The compat fixtures navigated the original source tab; restore it before
  // the popup checks that depend on its message listener.
  await setAddress(session, `http://127.0.0.1:${localServerPort}/`)
  await waitForActiveWebview(session, `document.title === 'Vast Local Test'`, 'source page restored before popup checks')

  await executeInActiveWebview(session, `(() => {
    const popup = window.open('about:blank', 'blank-oauth', 'width=520,height=640');
    popup.location.href = '/oauth-callback';
    return true;
  })()`)
  await waitForActiveWebview(session, `document.body.dataset.popupMessage?.startsWith('blank-popup-opener-ok:')`, 'about blank popup response')
  const blankPopupMessage = await executeInActiveWebview(session, `document.body.dataset.popupMessage`)
  assert(blankPopupMessage === 'blank-popup-opener-ok:session-ok:opener-ok:node-off:preload-off:spoof-off:cosmetic-off:native-ua:request-native-ua', `About blank popup security state changed: ${blankPopupMessage}`)
  await waitForStorage(session, '(data) => !data.tabs.some((tab) => tab.url.includes("/oauth-callback"))', 'about blank remained popup')
  record('about blank popup', 'real popup preserves opener and postMessage after location change')

  await executeInActiveWebview(session, `window.open('/auth/google?code=popup-secret&state=popup-state&login_hint=user%40example.test', 'direct-oauth', 'width=520,height=640'); true`)
  await waitForActiveWebview(session, `document.body.dataset.popupMessage?.startsWith('direct-popup-opener-ok:')`, 'direct auth popup response')
  const directPopupMessage = await executeInActiveWebview(session, `document.body.dataset.popupMessage`)
  assert(directPopupMessage === 'direct-popup-opener-ok:session-ok:opener-ok:node-off:preload-off:spoof-off:cosmetic-off:native-ua:request-native-ua', `Direct auth popup security state changed: ${directPopupMessage}`)
  await waitForStorage(session, '(data) => !data.tabs.some((tab) => tab.url.includes("/auth/google"))', 'direct auth remained popup')
  const authLogPath = path.join(userDataDir, 'Logs', 'google-auth.log')
  const authLog = await waitForFileContaining(authLogPath, 'code=[redacted]', 'redacted Google auth log')
  assert(authLog.includes('identity=native-electron debugger=false'), 'Auth popup diagnostics did not confirm native identity without CDP.')
  assert(authLog.includes('code=[redacted]') && authLog.includes('state=[redacted]'), 'Auth URL diagnostics did not mark sensitive OAuth parameters as redacted.')
  assert(authLog.includes('login_hint=[redacted]'), 'Auth URL diagnostics did not classify the identity hint as sensitive.')
  assert(!authLog.includes('popup-secret') && !authLog.includes('popup-state') && !authLog.includes('user@example.test'), 'Auth diagnostics leaked OAuth or identity values.')
  record('direct auth popup', 'sterile popup preserves opener/session, uses native UA, and redacts diagnostics')

  const openedSidebarForLibrary = await session.evaluate(`(() => {
    if (document.querySelector('[title="History"]')) return false;
    const toggle = document.querySelector('button[title="Show sidebar"]');
    if (!toggle) throw new Error('Sidebar toggle not found before library checks.');
    toggle.click();
    return true;
  })()`)
  if (openedSidebarForLibrary) {
    try {
      await waitFor(session, `Boolean(document.querySelector('[title="History"]'))`, 'Sidebar library controls')
    } catch (error) {
      const libraryState = await session.evaluate('window.vast.storage.load().then((data) => JSON.stringify({ activeWorkspaceId: data.activeWorkspaceId, sidePanelOpen: data.sidePanelOpen, activeSidePanel: data.activeSidePanel, workspaceNames: data.workspaces.map((w) => w.name), tabTitles: data.tabs.map((t) => t.title) }))').catch((e) => 'eval-failed:' + e.message)
      console.log('DIAG history sidebar:', libraryState)
      throw error
    }
  }
  await activateButtonByTitle(session, 'History')
  await waitFor(session, 'document.body.innerText.includes("127.0.0.1")', 'history Sidebar')
  await waitForStorage(session, '(data) => data.history.some((entry) => entry.url.includes("127.0.0.1"))', 'history persisted')
  record('history', 'visited page recorded')

  // A shell-level CDP mouse coordinate can drift after the right side panel
  // changes the browser viewport on scaled Windows runners. Activate the
  // visible chrome control directly, then keep both the rendered-state and
  // persisted-storage assertions below as the behavior gate.
  await activateButtonByTitle(session, 'Bookmark page')
  await waitFor(session, 'Boolean(document.querySelector("[title=\\"Remove bookmark\\"]"))', 'bookmark star filled')
  await activateButtonByTitle(session, 'Bookmarks')
  await clickByText(session, 'New folder')
  await submitPrompt(session, 'QA Folder', 'Create folder', true)
  await waitForStorage(session, '(data) => data.bookmarks.some((entry) => entry.url.includes("127.0.0.1"))', 'bookmark persisted')
  await waitForStorage(session, '(data) => data.bookmarkFolders.some((folder) => folder.name === "QA Folder")', 'bookmark folder persisted')
  record('bookmarks', 'current page bookmark saved and folder prompt works')

  await openCommand(session, '127.0.0.1')
  body = await session.bodyText()
  const normalizedPaletteBody = body.toLowerCase()
  assert(
    normalizedPaletteBody.includes('tabs') && normalizedPaletteBody.includes('bookmarks') && normalizedPaletteBody.includes('history') && body.includes('127.0.0.1'),
    `Command palette did not expose tab, bookmark, and history matches for the local page. Visible body: ${body}`
  )
  await session.key('Escape', 'Escape', 27)
  record('command search', 'tabs, bookmarks, and history appear in palette search')

  await activateButtonByTitle(session, 'More browser tools')
  await clickByText(session, 'Save to reading list')
  await activateButtonByTitle(session, 'Reading')
  await waitForStorage(session, '(data) => data.readingList.some((entry) => entry.url.includes("127.0.0.1"))', 'reading list persisted')
  record('reading list', 'current page saved')

  await activateButtonByTitle(session, 'Notes')
  await clickByText(session, 'New URL/workspace note')
  await waitForStorage(session, '(data) => data.notes.length >= 1', 'note creation persisted')
  record('notes', 'URL/workspace note created')

  await activateButtonByTitle(session, 'More browser tools')
  await clickByText(session, 'Find in page')
  await waitFor(session, 'Boolean(document.querySelector("input[placeholder=\\"Find in page\\"]"))', 'find bar')
  await session.type('Example')
  await session.key('Escape', 'Escape', 27)
  record('find in page', 'find UI opens and accepts query')

  await openCommand(session, 'reader')
  body = await session.bodyText()
  assert(!body.includes('Toggle Focus Reader'), 'Experimental Focus Reader command is visible while experimental features are disabled.')
  await session.key('Escape', 'Escape', 27)
  record('experimental command visibility', 'Focus Reader is absent while experimental features are disabled')

  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-primary`)
  await waitForActiveWebview(session, `document.title === 'Split Primary'`, 'split primary page')
  await session.ctrl('t', 'KeyT', 84)
  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-secondary`)
  await waitForActiveWebview(session, `document.title === 'Split Secondary'`, 'split secondary page')
  await clickByTitle(session, 'Split Primary')
  await waitForStorage(session, `(data) => data.tabs.find((tab) => tab.id === data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId)?.url.endsWith('/split-primary')`, 'split primary focused before toggle')

  const sidePanelWasOpenForSplit = await session.evaluate(`Boolean([...document.querySelectorAll('button')].find((item) => item.title === 'Hide sidebar'))`)
  if (sidePanelWasOpenForSplit) {
    await activateButtonByTitle(session, 'Hide sidebar')
    await waitForStorage(session, '(data) => data.sidePanelOpen === false', 'Sidebar hidden for split surface interaction')
  }

  await openCommand(session, 'split')
  await clickByText(session, 'Toggle split view')
  await waitFor(session, 'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.split === "true" && document.querySelectorAll("[data-testid=\\"split-pane\\"]").length === 2', 'two real split panes')
  await waitForStorage(
    session,
    '(data) => data.splitView.enabled === true && Boolean(data.splitView.primaryTabId) && Boolean(data.splitView.secondaryTabId) && data.splitView.primaryTabId !== data.splitView.secondaryTabId',
    'split pair persisted'
  )
  const splitMeta = await session.evaluate(`window.vast.storage.load().then((data) => ({
    activeTabId: data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId,
    primaryTabId: data.splitView.primaryTabId,
    secondaryTabId: data.splitView.secondaryTabId
  }))`)
  assert(splitMeta.activeTabId === splitMeta.primaryTabId, 'Split primary pane is not the focused tab after enabling.')
  const splitSurfaceState = await session.evaluate(`(() => {
    const stage = document.querySelector('[data-testid="browser-stage"]');
    const panes = [...document.querySelectorAll('[data-testid="split-pane"]')];
    const headers = [...document.querySelectorAll('[data-testid="split-pane-header"]')];
    const visibleWebviews = [...document.querySelectorAll('webview.browser-webview')].filter((item) => {
      const rect = item.getBoundingClientRect();
      return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
    });
    return {
      columns: getComputedStyle(stage).gridTemplateColumns,
      paneWidths: panes.map((pane) => pane.getBoundingClientRect().width),
      headerTitles: headers.map((header) => header.innerText),
      activeHeaders: headers.filter((header) => header.dataset.active === 'true').length,
      visibleWebviewUrls: visibleWebviews.map((webview) => webview.getURL())
    };
  })()`)
  await assertTwoPaneSplitGeometry(session, 'initial split')
  assert(splitSurfaceState.paneWidths.length === 2 && splitSurfaceState.paneWidths.every((width) => width > 200), 'Split panes are not both visibly sized.')
  assert(splitSurfaceState.headerTitles.some((title) => title.includes('Split Primary')) && splitSurfaceState.headerTitles.some((title) => title.includes('Split Secondary')), 'Split pane headers do not identify both pages.')
  assert(splitSurfaceState.activeHeaders === 1, 'Split view does not expose exactly one focused pane.')
  assert(splitSurfaceState.visibleWebviewUrls.some((url) => url.endsWith('/split-primary')) && splitSurfaceState.visibleWebviewUrls.some((url) => url.endsWith('/split-secondary')), 'Split view did not keep two independent live webviews.')
  await session.screenshot('02-split-view')

  const secondarySurfacePoint = await session.evaluate(`(() => {
    const webviews = [...document.querySelectorAll('webview.browser-webview')]
      .filter((item) => {
        const rect = item.getBoundingClientRect();
        return item.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
      })
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
    if (webviews.length !== 2) throw new Error('Expected two visible split webviews.');
    const rect = webviews[1].getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(80, rect.height / 3) };
  })()`)
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: secondarySurfacePoint.x, y: secondarySurfacePoint.y, button: 'left', clickCount: 1 })
  await waitForStorage(session, `(data) => data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId === ${JSON.stringify(splitMeta.secondaryTabId)} && data.splitView.primaryTabId === ${JSON.stringify(splitMeta.primaryTabId)} && data.splitView.secondaryTabId === ${JSON.stringify(splitMeta.secondaryTabId)}`, 'right split pane focused without collapsing pair')
  await setAddress(session, `http://127.0.0.1:${localServerPort}/split-secondary-navigated`)
  await waitForStorage(session, `(data) => data.tabs.find((tab) => tab.id === ${JSON.stringify(splitMeta.secondaryTabId)})?.url.endsWith('/split-secondary-navigated') && data.tabs.find((tab) => tab.id === ${JSON.stringify(splitMeta.primaryTabId)})?.url.endsWith('/split-primary')`, 'address bar navigates focused split pane only')

  await session.ctrl('t', 'KeyT', 84)
  await waitForStorage(session, `(data) => data.splitView.enabled === true && data.splitView.primaryTabId === ${JSON.stringify(splitMeta.primaryTabId)} && data.splitView.secondaryTabId === data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId && data.tabs.find((tab) => tab.id === data.splitView.secondaryTabId)?.url === 'vast://newtab'`, 'new tab replaces focused right split pane')
  await waitFor(session, 'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.split === "true" && document.querySelectorAll("[data-testid=\\"split-pane\\"]").length === 2', 'split remains after new tab')
  await assertTwoPaneSplitGeometry(session, 'split after pane replacement')

  await session.evaluate(`document.querySelector('[data-testid="split-resizer"]')?.focus()`)
  await session.key('ArrowRight', 'ArrowRight', 39)
  await waitForStorage(session, '(data) => data.splitView.enabled === true && data.splitView.ratio > 50', 'split ratio keyboard resize persisted')
  const preSwap = await session.evaluate(`window.vast.storage.load().then((data) => ({
    primary: data.splitView.primaryTabId,
    secondary: data.splitView.secondaryTabId,
    active: data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId
  }))`)
  await clickByTitle(session, 'Swap split panes')
  await waitForStorage(session, `(data) => data.splitView.primaryTabId === ${JSON.stringify(preSwap.secondary)} && data.splitView.secondaryTabId === ${JSON.stringify(preSwap.primary)} && data.workspaces.find((workspace) => workspace.id === data.activeWorkspaceId)?.activeTabId === ${JSON.stringify(preSwap.active)}`, 'split panes swapped without losing tabs or focus')
  await assertTwoPaneSplitGeometry(session, 'split after swap')

  await openCommand(session, 'split')
  await clickByText(session, 'Toggle split view')
  await waitForStorage(session, '(data) => data.splitView.enabled === false', 'split view disabled')
  await waitFor(session, 'document.querySelector("[data-testid=\\"browser-stage\\"]")?.dataset.split === "false" && document.querySelectorAll("[data-testid=\\"split-pane-header\\"]").length === 0', 'split chrome removed cleanly')
  if (sidePanelWasOpenForSplit) {
    await activateButtonByTitle(session, 'Show sidebar')
    await waitForStorage(session, '(data) => data.sidePanelOpen === true', 'Sidebar restored after split surface interaction')
  }
  record('split view', 'two live panes, stable focus, pane-scoped navigation, new-tab replacement, resizing, swapping, persistence, and clean toggle-off')

  await session.ctrl('=', 'Equal', 187)
  await session.ctrl('-', 'Minus', 189)
  await session.ctrl('0', 'Digit0', 48)
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.zoom === 1)', 'zoom reset persisted')
  record('zoom controls', 'zoom in/out/reset executed')

  await setAddress(session, `http://127.0.0.1:${localServerPort}/download.txt`)
  await waitFor(session, 'Boolean(document.querySelector(".download-progress-toast"))', 'restrained download progress toast', 10000)
  const downloadProgressStyle = await session.evaluate(`(() => {
    const toast = document.querySelector('.download-progress-toast');
    if (!toast) return null;
    const style = getComputedStyle(toast);
    return {
      backgroundImage: style.backgroundImage,
      backdropFilter: style.backdropFilter,
      text: toast.innerText
    };
  })()`)
  assert(downloadProgressStyle?.backgroundImage === 'none', 'Download progress toast still uses a decorative gradient.')
  assert(downloadProgressStyle?.backdropFilter === 'none', 'Download progress toast still uses backdrop blur.')
  assert(downloadProgressStyle?.text.includes('Downloading'), 'Simplified download progress status is not visible.')
  assert(!(await session.bodyText()).includes('Download started'), 'A duplicate download-started toast is visible beside the progress card.')
  await session.screenshot('03c-download-progress')
  record('download progress visual', 'active download uses a flat neutral card without colored glow or gradient')
  await waitForStorage(session, '(data) => data.downloads.some((item) => item.filename === "vast-smoke-download.txt" && item.state === "completed")', 'download completed', 30000)
  record('downloads', 'local attachment downloaded and persisted')

  const pdfSmokeUrl = packagedExecutable && packagedPdfUrl
    ? packagedPdfUrl
    : `http://127.0.0.1:${localServerPort}/viewer.pdf`
  const pdfSmokeFilename = packagedExecutable && packagedPdfUrl ? (() => {
    try {
      return decodeURIComponent(new URL(pdfSmokeUrl).pathname.split('/').filter(Boolean).at(-1) || 'document.pdf')
    } catch {
      return 'document.pdf'
    }
  })() : 'vast-smoke.pdf'
  await setAddress(session, pdfSmokeUrl)
  await waitFor(
    session,
    `document.body.innerText.includes("BUILT-IN PDF") && document.body.innerText.includes(${JSON.stringify(pdfSmokeFilename)})`,
    'pdf viewer shell',
    30000
  )
  body = await session.bodyText()
  assert(!body.includes('VAST RECOVERED'), 'Built-in PDF viewer triggered renderer error boundary.')
  assert(body.includes('BUILT-IN PDF') && body.includes(pdfSmokeFilename), 'Built-in PDF viewer did not render the expected shell.')
  record('pdf viewer', `${packagedExecutable && packagedPdfUrl ? 'public HTTPS' : 'local'} PDF opens in the built-in viewer without renderer crashes`)

  await setAddress(session, 'https://127.0.0.1:9')
  await waitFor(session, 'document.body.innerText.includes("Could not open")', 'error page', 25000)
  await clickByText(session, 'Try again')
  await wait(750)
  assert(!(await session.bodyText()).includes('VAST RECOVERED'), 'Retry caused renderer error boundary.')
  record('error page', 'failed load shows friendly page and retry is wired')

  await session.ctrl('w', 'KeyW', 87)
  await waitForStorage(session, '(data) => data.recentlyClosedTabs.length >= 1', 'recently closed after close')
  await session.ctrlShift('T', 'KeyT', 84)
  await waitForStorage(session, '(data) => data.tabs.length >= 2', 'reopened tab')
  record('recently closed', 'close and reopen shortcut work')

  await closeWorkspacePopover(session)
  await openCommand(session, 'Open Privacy Settings')
  await clickByText(session, 'Open Privacy Settings')
  await waitFor(session, 'Boolean(document.querySelector(".settings-modal-shell"))', 'settings modal')
  const labsSectionState = await session.evaluate(`(() => {
    const section = document.querySelector('section#Labs')
    return {
      present: Boolean(section),
      hasFeatureToggles: Boolean(section?.querySelector('input[type="checkbox"]')),
      removedDescriptionGone: section?.textContent?.includes('local, experimental feature flags') !== true
    }
  })()`)
  assert(labsSectionState.present && labsSectionState.hasFeatureToggles && labsSectionState.removedDescriptionGone, `Labs section state unexpected: ${JSON.stringify(labsSectionState)}`)
  record('Labs settings model', 'local feature flags are exposed through toggles without description blocks or product-tier controls')
  await setCheckboxByLabel(session, 'Block common trackers', false)
  await waitForStorage(session, '(data) => data.settings.privacy.blockTrackers === false', 'settings mutation persisted')
  await setCheckboxByLabel(session, 'Opening animation', false)
  await waitForStorage(session, '(data) => data.settings.openingAnimation === false', 'opening animation setting persisted')
  await setNumberInputByLabel(session, 'Memory target (best effort)', 1536)
  await waitForStorage(session, '(data) => data.settings.advanced.ramLimitMb === 1536', 'RAM limit setting persisted')
  assert(await session.evaluate(`![...document.querySelectorAll('label')].some((label) => label.textContent.trim() === 'Ad blocker')`), 'Removed native ad blocker control must not return; extension filtering has its own E2E gate.')
  await setCheckboxByLabel(session, 'Fake browsing history', true)
  await waitForStorage(
    session,
    '(data) => data.settings.privacy.fakeHistoryEnabled === true && data.history.length >= 10 && data.history.some((entry) => entry.url.includes("booking.com") || entry.url.includes("facebook.com")) && !data.history.some((entry) => entry.url.includes("127.0.0.1"))',
    'fake history setting populated plausible history'
  )
  record('settings', 'modal opens, privacy settings persist, and fake history replaces real history')

  await setSelectByLabel(session, 'Theme', 'light')
  await waitForStorage(session, '(data) => data.settings.theme === "light"', 'light theme persisted')
  await session.screenshot('03-light-theme')
  await setSelectByLabel(session, 'Theme', 'dim')
  await waitForStorage(session, '(data) => data.settings.theme === "dim"', 'dim theme persisted')
  await session.screenshot('03b-dim-theme')
  await setSelectByLabel(session, 'Theme', 'dark')
  await waitForStorage(session, '(data) => data.settings.theme === "dark"', 'dark theme restored')
  record('theme switching', 'light, dim, and dark theme settings persist')

  await setCheckboxByLabel(session, 'Experimental features', true)
  await waitForStorage(session, '(data) => data.settings.advanced.experimentalFeatures === true', 'experimental features enabled for Labs checks')
  record('experimental settings opt-in', 'the master switch enables later experimental coverage')

  await setCheckboxByLabel(session, 'Bookmarks bar', true)
  await setCheckboxByLabel(session, 'Show bookmarks bar only on New Tab', false)
  await setSelectByLabel(session, 'New tab layout', 'blank')
  await setCheckboxByLabel(session, 'Video & Audio', true)
  await setCheckboxByLabel(session, 'Network Devices', true)
  await setCheckboxByLabel(session, 'Automation', true)
  await setCheckboxByLabel(session, 'Diagnostics', true)
  await setSelectByLabel(session, 'Sidebar mode', 'docked')
  await setSelectByLabel(session, 'Layout', 'horizontal')
  await waitForStorage(
    session,
    '(data) => data.settings.layoutMode === "horizontal" && data.settings.sidePanel.mode === "docked" && data.settings.bookmarksBarVisible === true && data.settings.bookmarksBarOnlyOnNewTab === false && data.settings.newTabBehavior === "blank" && data.settings.labs.avidae === true && data.settings.labs.networkDevices === true && data.settings.labs.automation === true && data.settings.labs.advancedDiagnostics === true',
    'horizontal settings persisted'
  )
  await waitFor(
    session,
    'Boolean(document.querySelector(".horizontal-chrome"))',
    'live horizontal layout while settings remain open'
  )
  await session.evaluate(`(() => {
    const button = document.querySelector('button[title="Close settings"]');
    if (!button) throw new Error('Visible settings close button not found.');
    button.click();
    return true;
  })()`)
  await waitFor(
    session,
    '!Boolean(document.querySelector("button[title=\\"Close settings\\"]"))',
    'settings modal close before horizontal layout assertion'
  )
  await waitFor(
    session,
    'Boolean(document.querySelector(".horizontal-chrome")) && Boolean(document.querySelector(".horizontal-bookmarks-bar")) && !Boolean(document.querySelector("select[title=\\"Switch workspace\\"]"))',
    'horizontal bookmarks bar'
  )
  record('horizontal mode', 'top tabs and bookmarks bar render from persisted settings')

  await session.evaluate(`(() => {
    const button = document.querySelector('.horizontal-chrome button[title="Switch workspace"]');
    if (!button) throw new Error('Visible horizontal workspace switcher not found.');
    button.click();
    return true;
  })()`)
  await waitFor(
    session,
    'Boolean(document.querySelector("[data-testid=\\"workspace-popover-heading\\"]")) && !document.body.innerText.includes("Isolated workspaces use a temporary Chromium session")',
    'custom workspace popover'
  )
  await session.screenshot('03c-workspace-popover')
  await session.evaluate('document.querySelector(\'.horizontal-chrome button[title="Switch workspace"]\')?.click()')
  record('horizontal workspace popover', 'custom popover replaces native select')

  await clickHorizontalBrowserTools(session)
  await waitFor(
    session,
    'document.body.innerText.includes("Incognito window") && document.body.innerText.includes("Video & Audio") && document.body.innerText.includes("Network Devices") && !document.body.innerText.includes("Developer tools")',
    'toolbar overflow'
  )
  await clickByText(session, 'Video & Audio')
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url === "vast://avidae")', 'avidae tab opened from overflow')
  await waitFor(session, 'document.body.innerText.includes("Start backend")', 'avidae explicit start screen')
  await assertEqualActionGrid(session, 'avidae-primary-actions', 3, 1)
  await session.screenshot('04a-avidae-actions')
  await clickByText(session, 'Start backend')
  await waitFor(
    session,
    '(() => { const frame = document.querySelector("iframe[title=\\"Video & Audio\\"]"); return Boolean(frame && frame.src.startsWith("http://127.0.0.1:")); })()',
    'avidae live iframe',
    45000
  )
  const avidaeOverflowStatus = await session.evaluate('window.vast.avidae.status()')
  assert(avidaeOverflowStatus.state === 'running' && avidaeOverflowStatus.url, 'Video & Audio backend did not report a running local URL.')
  record('avidae overflow', 'browser tools opens Video & Audio; explicit start launches and embeds the local backend')

  await openCommand(session, 'Open Video & Audio')
  await clickByText(session, 'Open Video & Audio')
  await waitForStorage(session, '(data) => data.tabs.filter((tab) => tab.url === "vast://avidae").length >= 2', 'avidae command opened')
  await waitFor(session, 'Boolean(document.querySelector("iframe[title=\\"Video & Audio\\"]"))', 'avidae command page visible', 20000)
  record('avidae command', 'command palette opens the built-in Video & Audio page')

  await clickHorizontalBrowserTools(session)
  await clickByText(session, 'Network Devices')
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url === "vast://network")', 'network tab opened from overflow')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"network-page\\"]")) && document.body.innerText.includes("Scan local network")', 'network page visible')
  await assertEqualActionGrid(session, 'network-primary-actions', 2, 2)
  record('network devices overflow', 'browser tools menu opens the local network devices page')

  await clickByText(session, 'Enable discovery')
  await waitForStorage(session, '(data) => data.settings.network.enabled === true && data.settings.network.allowScans === false', 'network discovery explicit opt in')

  const networkMock = await session.evaluate('window.vast.network.scan({ mock: true, confirmed: true })')
  assert(networkMock.ok === true && networkMock.devices.some((device) => device.name.includes('Chromecast')), 'Mock network scan did not return cast device.')
  await clickByText(session, 'Refresh')
  await waitFor(session, 'document.body.innerText.includes("Living Room Chromecast") && document.body.innerText.includes("Home Assistant")', 'mock network devices rendered')
  record('network mock discovery', 'mock Chromecast and Home Assistant devices render without scanning real LAN')

  await openCommand(session, 'Open Network Devices')
  await clickByText(session, 'Open Network Devices')
  await waitForStorage(session, '(data) => data.tabs.filter((tab) => tab.url === "vast://network").length >= 2', 'network command opened')
  record('network command', 'command palette opens Network Devices')

  await openCommand(session, 'Open settings')
  await clickByText(session, 'Open settings')
  await waitFor(session, 'document.body.innerText.includes("Network Devices") && document.body.innerText.includes("Active local probing")', 'network settings visible')
  await setCheckboxByLabel(session, 'Active local probing', true)
  await waitForStorage(session, '(data) => data.settings.network.activeProbing === true', 'network active probing persisted')
  await setCheckboxByLabel(session, 'Active local probing', false)
  await waitForStorage(session, '(data) => data.settings.network.activeProbing === false', 'network active probing restored')
  await clickByTitle(session, 'Close settings')
  record('network settings', 'network settings toggles persist')

  await clickHorizontalBrowserTools(session)
  body = await session.bodyText()
  assert(
    body.includes('Automation') && body.includes('Notes') && body.includes('Site Data') && body.includes('Diagnostics'),
    'Built-in tools launcher is missing Automation, Notes, Site Data, or Diagnostics.'
  )
  await clickByText(session, 'Automation')
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url === "vast://automation")', 'automation tab opened from overflow')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"automation-page\\"]"))', 'automation page visible')
  await clickByTitle(session, 'Create macro')
  await waitForStorage(session, '(data) => data.macros.some((macro) => macro.name === "New Macro")', 'macro created from automation page')
  await session.evaluate(`(() => {
    const input = document.querySelector('[data-testid="macro-name-input"]');
    if (!input) throw new Error('Macro name input not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Smoke Macro');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await waitForStorage(session, '(data) => data.macros.some((macro) => macro.name === "Smoke Macro")', 'macro rename persisted')
  await clickByText(session, 'Dry run')
  await waitForStorage(session, '(data) => data.macroLogs.some((log) => log.macroName === "Smoke Macro" && log.message.includes("Dry run passed"))', 'macro dry run logged')
  await assertEqualActionGrid(session, 'automation-primary-actions', 4, 1)
  await session.screenshot('04c-automation-actions')
  await clickByText(session, 'Run')
  await waitFor(session, 'document.body.innerText.includes("Maximum 25 actions and 30 seconds")', 'macro permission confirmation')
  await clickByText(session, 'Run macro')
  await waitForStorage(session, '(data) => data.macroLogs.some((log) => log.macroName === "Smoke Macro" && log.status === "success" && log.message.startsWith("Ran "))', 'macro run logged')
  record('automation page', 'macro supports dry run, permission confirmation, execution, and activity logging')

  await openCommand(session, 'Open Automation')
  await clickByText(session, 'Open Automation')
  await waitForStorage(session, '(data) => data.tabs.filter((tab) => tab.url === "vast://automation").length >= 2', 'automation command opened')
  record('automation command', 'command palette opens automation')

  await clickHorizontalBrowserTools(session)
  await clickByText(session, 'Notes')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"notes-page\\"]"))', 'notes page visible')
  const openedWorkspaceDropdown = await session.evaluate(`(() => {
    const control = document.querySelector('[data-testid="notes-page"] [data-vast-select="Workspace"]');
    const button = control?.querySelector('button');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  assert(openedWorkspaceDropdown, 'Notes workspace dropdown did not expose the shared Vast control.')
  await waitFor(session, 'Boolean(document.querySelector(\'[role="listbox"][aria-label="Workspace"]\'))', 'workspace dropdown menu')
  try {
    await waitFor(session, `(() => {
      const menu = document.querySelector('[role="listbox"][aria-label="Workspace"]');
      if (!menu || getComputedStyle(menu).position !== 'fixed' || menu.parentElement?.parentElement !== document.body) return false;
      const rect = menu.getBoundingClientRect();
      return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    })()`, 'workspace dropdown settled inside viewport', 5000)
  } catch (error) {
    const diagnostic = await session.evaluate(`(() => {
      const menu = document.querySelector('[role="listbox"][aria-label="Workspace"]');
      if (!menu) return { present: false, innerWidth, innerHeight };
      const rect = menu.getBoundingClientRect();
      return {
        present: true,
        position: getComputedStyle(menu).position,
        portaledToBody: menu.parentElement?.parentElement === document.body,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        viewport: { width: innerWidth, height: innerHeight }
      };
    })()`)
    throw new Error(`${error instanceof Error ? error.message : String(error)} State: ${JSON.stringify(diagnostic)}`)
  }
  const workspaceDropdownState = await session.evaluate(`(() => {
    const menu = document.querySelector('[role="listbox"][aria-label="Workspace"]');
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    return {
      position: getComputedStyle(menu).position,
      portaledToBody: menu.parentElement?.parentElement === document.body,
      insideViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      options: [...menu.querySelectorAll('[role="option"]')].map((option) => option.innerText.trim()),
      nativeSelectCount: document.querySelectorAll('select').length
    };
  })()`)
  assert(
    workspaceDropdownState?.position === 'fixed' && workspaceDropdownState.portaledToBody && workspaceDropdownState.insideViewport,
    `Workspace dropdown is clipped or is not portaled above the page: ${JSON.stringify(workspaceDropdownState)}`
  )
  assert(workspaceDropdownState.options.includes('All workspaces') && workspaceDropdownState.options.includes('Workspace'), 'Workspace dropdown is missing expected options.')
  assert(workspaceDropdownState.nativeSelectCount === 0, 'An active Vast page still renders a native select.')
  await session.screenshot('04d-workspace-dropdown')
  await session.evaluate(`(() => {
    const option = document.querySelector('[role="option"][data-value="workspace-default"]');
    option?.click();
    return Boolean(option);
  })()`)
  await waitFor(session, '!document.querySelector(\'[role="listbox"][aria-label="Workspace"]\')', 'workspace dropdown close')
  record('dropdown system', 'workspace selector uses the portaled Vast menu, stays inside the viewport, selects an option, and renders no native select')
  const notesScrollState = await session.evaluate(`(() => {
    const page = document.querySelector('[data-testid="notes-page"]');
    if (!page) return null;
    const originalHeight = page.style.height;
    page.style.height = '320px';
    const before = page.scrollTop;
    page.scrollTop = page.scrollHeight;
    const result = {
      overflowY: getComputedStyle(page).overflowY,
      clientHeight: page.clientHeight,
      scrollHeight: page.scrollHeight,
      before,
      after: page.scrollTop
    };
    page.scrollTop = 0;
    page.style.height = originalHeight;
    return result;
  })()`)
  assert(notesScrollState?.overflowY === 'auto', 'Notes page is not a vertical scroll container.')
  assert(notesScrollState?.scrollHeight > notesScrollState?.clientHeight, 'Notes page content does not produce a constrained scroll range.')
  assert(notesScrollState?.after > notesScrollState?.before, 'Notes page refused to update scrollTop.')
  await clickByTitle(session, 'Create note')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"note-title-input\\"]"))', 'note editor visible')
  await session.evaluate(`(() => {
    const title = document.querySelector('[data-testid="note-title-input"]');
    const body = document.querySelector('[data-testid="note-body-input"]');
    if (!title || !body) throw new Error('Notes editor inputs not found.');
    const titleSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const bodySetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    titleSetter.call(title, 'Smoke Note');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    bodySetter.call(body, '# Smoke\\n\\nLocal notes 2.0 works.');
    body.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await waitForStorage(session, '(data) => data.notes.some((note) => note.title === "Smoke Note" && note.body.includes("Local notes 2.0"))', 'notes page note persisted')
  await session.evaluate(`(() => {
    const input = document.querySelector('[data-testid="notes-search-input"]');
    if (!input) throw new Error('Notes search input not found.');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Smoke');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)
  await waitFor(session, 'document.body.innerText.includes("Smoke Note")', 'notes search result')
  await assertEqualActionGrid(session, 'notes-primary-actions', 4, 1)
  await assertEqualActionGrid(session, 'notes-secondary-actions', 3, 1)
  await session.screenshot('04d-notes-actions')
  record('notes page', 'full notes page scrolls independently, creates notes, and searches')

  await openCommand(session, 'Diagnostics')
  await clickByText(session, 'Open Diagnostics')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"diagnostics-page\\"]"))', 'diagnostics page visible')
  await assertEqualActionGrid(session, 'diagnostics-primary-actions', 2, 1)
  await session.screenshot('04e-diagnostics-actions')
  record('diagnostics command', 'command palette opens diagnostics')

  await openCommand(session, 'Open Session Timeline')
  await clickByText(session, 'Open Session Timeline')
  await waitFor(session, 'Boolean(document.querySelector("[data-testid=\\"timeline-primary-actions\\"]"))', 'session timeline page visible')
  await assertEqualActionGrid(session, 'timeline-primary-actions', 2, 1)
  await session.screenshot('04f-timeline-actions')
  record('Labs action symmetry', 'Notes, Automation, Video & Audio, Diagnostics, Network, and Session Timeline use equal action grids')

  await clickHorizontalBrowserTools(session)
  await clickByText(session, 'Incognito window')
  await waitForStorage(
    session,
    '(data) => { const workspace = data.workspaces.find((item) => item.name === "Incognito"); return Boolean(workspace && workspace.isPrivate === true && data.activeWorkspaceId === workspace.id); }',
    'incognito workspace opened'
  )
  record('toolbar overflow', 'incognito and built-in tools live in the address bar overflow menu')

  await clickByTitle(session, 'Switch workspace')
  await clickByText(session, 'Workspace')
  await waitForStorage(session, '(data) => data.activeWorkspaceId === "workspace-default"', 'returned to persistent workspace')

  const sidebarToggleBeforePinning = await session.evaluate(`([...document.querySelectorAll('button')].find((item) => item.title === 'Hide sidebar' || item.title === 'Show sidebar'))?.title`)
  assert(sidebarToggleBeforePinning, 'Sidebar toggle was not found before pinning tests.')
  if (sidebarToggleBeforePinning === 'Show sidebar') {
    await activateButtonByTitle(session, 'Show sidebar')
    await waitForStorage(session, '(data) => data.sidePanelOpen === true', 'right Sidebar prepared for pinning tests')
  }
  await activateButtonByTitle(session, 'Hide sidebar')
  await waitForStorage(session, '(data) => data.sidePanelOpen === false', 'right Sidebar hidden')
  await activateButtonByTitle(session, 'Show sidebar')
  await waitForStorage(session, '(data) => data.sidePanelOpen === true', 'right Sidebar restored')
  record('right Sidebar toggle', 'address bar control hides and restores Sidebar')

  await waitFor(session, 'Boolean(document.querySelector(".side-panel-slot.is-docked"))', 'unpinned Sidebar docked')
  const dockedSidebarState = await session.evaluate(`(() => {
    const slot = document.querySelector('.side-panel-slot.is-docked');
    const panel = slot?.querySelector('.side-panel');
    const header = panel?.querySelector('[data-testid="sidebar-drag-handle"]');
    const pin = panel ? [...panel.querySelectorAll('button')].find((item) => item.title === 'Pin sidebar over page') : null;
    const main = document.querySelector('.app-main-surface');
    if (!slot || !panel || !header || !pin || !main) return null;
    const slotRect = slot.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    return {
      slotPosition: getComputedStyle(slot).position,
      slotWidth: slotRect.width,
      panelWidth: panel.getBoundingClientRect().width,
      pinShadow: getComputedStyle(pin).boxShadow,
      headerDraggable: header.title === 'Drag sidebar',
      mainRight: mainRect.right,
      slotLeft: slotRect.left,
      viewportWidth: window.innerWidth,
      pinned: slot.dataset.pinned
    };
  })()`)
  assert(dockedSidebarState?.slotPosition === 'relative' && dockedSidebarState.pinned === 'false', 'Unpinned Sidebar is not docked in the application layout.')
  assert(Math.abs(dockedSidebarState.mainRight - dockedSidebarState.slotLeft) <= 1 && dockedSidebarState.mainRight < dockedSidebarState.viewportWidth, 'Unpinned Sidebar does not reserve a right column beside the page.')
  assert(Math.abs(dockedSidebarState.slotWidth - dockedSidebarState.panelWidth) <= 1, 'Docked Sidebar does not fill its reserved column.')
  assert(dockedSidebarState.headerDraggable === false, 'Unpinned Sidebar incorrectly exposes a drag handle.')
  assert(dockedSidebarState.pinShadow === 'none', 'Sidebar pin button still renders a shadow.')
  await session.screenshot('04g-unpinned-sidebar-docked')

  await clickByTitle(session, 'Pin sidebar over page')
  await waitForStorage(session, '(data) => data.settings.sidePanel.mode === "overlay"', 'pinned Sidebar mode persisted')
  await waitFor(session, '!document.querySelector(".side-panel-scrim") && Boolean(document.querySelector(".side-panel-slot.is-pinned"))', 'Sidebar pinned above page without scrim')
  const pinnedPanelBefore = await session.evaluate(`(() => {
    const slot = document.querySelector('.side-panel-slot.is-pinned');
    const panel = slot?.querySelector('.side-panel');
    const header = panel?.querySelector('[data-testid="sidebar-drag-handle"]');
    const pin = panel ? [...panel.querySelectorAll('button')].find((item) => item.title === 'Unpin sidebar') : null;
    const main = document.querySelector('.app-main-surface');
    if (!slot || !panel || !header || !pin || !main) return null;
    const panelRect = panel.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const topElement = document.elementFromPoint(panelRect.left + panelRect.width / 2, panelRect.top + Math.min(160, panelRect.height / 3));
    return {
      x: panelRect.left,
      y: panelRect.top,
      width: panelRect.width,
      height: panelRect.height,
      dragX: headerRect.left + headerRect.width * 0.68,
      dragY: headerRect.top + headerRect.height / 2,
      slotPosition: getComputedStyle(slot).position,
      slotZ: Number.parseInt(getComputedStyle(slot).zIndex || '0', 10),
      pinShadow: getComputedStyle(pin).boxShadow,
      mainRight: main.getBoundingClientRect().right,
      viewportWidth: window.innerWidth,
      panelOwnsHitTest: Boolean(topElement?.closest('.side-panel')),
      pinned: slot.dataset.pinned
    };
  })()`)
  assert(pinnedPanelBefore?.slotPosition === 'fixed' && pinnedPanelBefore.slotZ >= 35, 'Pinned Sidebar is not in a fixed always-on-top layer.')
  assert(Math.abs(pinnedPanelBefore.mainRight - pinnedPanelBefore.viewportWidth) <= 1, 'Pinned Sidebar still shrinks the browser content.')
  assert(pinnedPanelBefore.panelOwnsHitTest === true && pinnedPanelBefore.pinned === 'true', 'Pinned Sidebar is not above browser hit-testing.')
  assert(pinnedPanelBefore.pinShadow === 'none', 'Pinned Sidebar button still renders a shadow.')
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pinnedPanelBefore.dragX, y: pinnedPanelBefore.dragY })
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pinnedPanelBefore.dragX, y: pinnedPanelBefore.dragY, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pinnedPanelBefore.dragX - 150, y: pinnedPanelBefore.dragY + 70, button: 'left', buttons: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pinnedPanelBefore.dragX - 150, y: pinnedPanelBefore.dragY + 70, button: 'left', clickCount: 1 })
  await waitForStorage(
    session,
    `(data) => data.settings.sidePanel.positionX < ${JSON.stringify(pinnedPanelBefore.x - 100)} && data.settings.sidePanel.positionY > ${JSON.stringify(pinnedPanelBefore.y + 30)}`,
    'pinned Sidebar drag persisted'
  )
  const pinnedPanelAfter = await session.evaluate(`(() => {
    const panel = document.querySelector('.side-panel-slot.is-pinned .side-panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  })()`)
  assert(pinnedPanelAfter && pinnedPanelAfter.x < pinnedPanelBefore.x - 100 && pinnedPanelAfter.y > pinnedPanelBefore.y + 30, 'Pinned Sidebar did not move with its drag handle.')
  assert(pinnedPanelAfter.x >= 0 && pinnedPanelAfter.y >= 48 && pinnedPanelAfter.right <= pinnedPanelAfter.viewportWidth && pinnedPanelAfter.bottom <= pinnedPanelAfter.viewportHeight, 'Dragged Sidebar escaped the visible viewport.')
  await session.screenshot('04h-pinned-sidebar-drag')

  await clickByTitle(session, 'Unpin sidebar')
  await waitForStorage(session, '(data) => data.settings.sidePanel.mode === "docked"', 'unpinned Sidebar mode persisted')
  await waitFor(session, 'Boolean(document.querySelector(".side-panel-slot.is-docked[data-pinned=\\"false\\"]"))', 'unpinned Sidebar returned to dock')
  const mainRightAfterUnpin = await session.evaluate(`document.querySelector('.app-main-surface')?.getBoundingClientRect().right`)
  const viewportWidthAfterUnpin = await session.evaluate('window.innerWidth')
  assert(mainRightAfterUnpin < viewportWidthAfterUnpin, 'Unpinned Sidebar did not return to its reserved right column.')
  record('right Sidebar pinning', 'unpinned mode docks beside the page; pinned mode stays above content, drags, persists, and unpins cleanly')

  await session.ctrl('t', 'KeyT', 84)
  await waitFor(session, '!document.body.innerText.toLowerCase().includes("blank new tab")', 'blank new tab behavior')
  await session.screenshot('04-horizontal-mode')
  record('new tab behavior', 'blank mode renders as a truly minimal surface')

  const privacyResult = await session.evaluate('window.vast.privacy.clearSiteData()')
  assert(privacyResult.ok === true, 'Clear site data IPC failed.')
  const removedIntegrationApis = await session.evaluate('window.vast.ai === undefined && window.vast.integrations === undefined')
  assert(removedIntegrationApis === true, 'Removed integrations APIs are still exposed to the renderer.')
  record('privacy and removed integrations', 'clear site data responds; integrations and AI APIs are absent')

  await openCommand(session, 'clear history')
  await clickByText(session, 'Clear history')
  await waitForStorage(session, '(data) => data.history.length === 0', 'command clear history')
  record('clear history command', 'history cleared from command palette')

  await setAddress(session, 'w Vast browser')
  await waitForStorage(session, '(data) => data.tabs.some((tab) => tab.url.includes("wikipedia.org") || tab.url.includes("Special:Search"))', 'search shortcut navigation')
  await wait(1800)
  record('search engine shortcut', 'address bar shortcut navigates without refresh loop')

  await setAddress(session, 'javascript:alert(1)')
  await wait(1200)
  await waitForStorage(session, '(data) => !data.tabs.some((tab) => tab.url.startsWith("javascript:"))', 'unsafe protocol blocked')
  record('URL safety', 'javascript: input is not loaded as a page')

  await wait(900)
  const unexpectedRendererIssues = rendererIssues.filter(
    (issue) =>
      !isExpectedRendererIssue(issue) &&
      !issue.includes('ERR_FAILED (-2) loading') &&
      !issue.includes('ERR_UNSAFE_PORT') &&
      !issue.includes('ERR_ABORTED (-3) loading')
  )
  if (unexpectedRendererIssues.length) {
    fail(`Renderer errors observed:\n${unexpectedRendererIssues.join('\n')}`)
  }

  session.close()
  cleanup()
  console.log(`\n${checks.length} app checks passed.`)
  console.log(`Artifacts: ${artifactsDir}`)
}

main().catch((error) => {
  console.error('\nE2E smoke failed.')
  console.error(error)
  const popupLogPath = path.join(userDataDir, 'Logs', 'google-auth.log')
  if (fs.existsSync(popupLogPath)) console.error(`\npopup routing log:\n${fs.readFileSync(popupLogPath, 'utf8')}`)
  const screenShareLogPath = path.join(userDataDir, 'Logs', 'screen-share.log')
  if (fs.existsSync(screenShareLogPath)) console.error(`\nscreen share log:\n${fs.readFileSync(screenShareLogPath, 'utf8')}`)
  if (rendererIssues.length) console.error(`\nrenderer:\n${rendererIssues.join('\n')}`)
  if (stdout.length) console.error(`\nstdout:\n${stdout.join('')}`)
  if (stderr.length) console.error(`\nstderr:\n${stderr.join('')}`)
  cleanup()
  process.exit(1)
})
