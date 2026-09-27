#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const ICLOUD_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj'
const port = Number.parseInt(process.argv[2] || '', 10)
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : undefined
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node probe-icloud-popup.cjs <debugger-port> [output.json]')
  process.exit(1)
}

function safeError(value) {
  const text = String(value || '')
  return text
    .replaceAll(/https?:\/\/[^\s)]+/g, '<url>')
    .replaceAll(/chrome-extension:\/\/[^\s)]+/g, '<extension-url>')
    .replaceAll(/[A-Za-z]:\\[^\s:)]+/g, '<path>')
    .slice(0, 800)
}

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  const target = targets.find((item) => item.type === 'webview' && item.url === `chrome-extension://${ICLOUD_ID}/page_popup.html`)
  if (!target) throw new Error('The iCloud Passwords popup target is not open.')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  const events = []
  let sequence = 0
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message))
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      events.push({ type: 'exception', description: safeError(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text) })
    } else if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params?.entry?.level)) {
      events.push({ type: `log-${message.params.entry.level}`, source: message.params.entry.source, text: safeError(message.params.entry.text) })
    } else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params?.type)) {
      events.push({ type: `console-${message.params.type}`, arguments: (message.params.args || []).map((arg) => safeError(arg.description || arg.value)).slice(0, 4) })
    }
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  // Do not reload the popup here. A reload tears down its runtime Port and can
  // erase the exact post-authorization state this diagnostic is meant to see.
  await new Promise((resolve) => setTimeout(resolve, 500))
  const evaluated = await send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      const body = document.body
      const rect = body?.getBoundingClientRect()
      const style = body ? getComputedStyle(body) : null
      const boxes = ['divPIN', 'divMessageBoard', 'divICs', 'divDownloadPage', 'divOpeniC4WPage']
        .map((id) => {
          const element = document.getElementById(id)
          const boxStyle = element ? getComputedStyle(element) : null
          return { id, present: Boolean(element), display: boxStyle?.display, childCount: element?.children.length ?? 0 }
        })
      const tabs = await new Promise((resolve) => chrome.tabs.query({ active: true, currentWindow: true }, resolve))
      const tabSummary = (tabs || []).slice(0, 4).map((tab) => ({
        idType: typeof tab.id,
        hasId: Number.isSafeInteger(tab.id),
        active: tab.active === true,
        protocol: (() => { try { return new URL(tab.url).protocol } catch { return '<invalid>' } })()
      }))
      let frameSummary = { attempted: false, count: 0, error: null }
      const activeTabId = tabs?.[0]?.id
      if (Number.isSafeInteger(activeTabId)) {
        frameSummary.attempted = true
        try {
          const frames = await new Promise((resolve) => chrome.webNavigation.getAllFrames({ tabId: activeTabId }, resolve))
          frameSummary.count = Array.isArray(frames) ? frames.length : -1
        } catch (error) {
          frameSummary.error = String(error?.message || error).slice(0, 300)
        }
      }
      return {
        readyState: document.readyState,
        title: document.title,
        popupState: typeof g_lastUpdatedPopupContentsState === 'undefined' ? '<unavailable>' : g_lastUpdatedPopupContentsState,
        backgroundPortConnected: typeof g_portToBackgroundPage !== 'undefined' && g_portToBackgroundPage !== null,
        body: body ? { childCount: body.children.length, width: rect.width, height: rect.height,
          display: style.display, visibility: style.visibility, opacity: style.opacity,
          backgroundColor: style.backgroundColor, overflow: style.overflow } : null,
        boxes,
        activeTabs: tabSummary,
        navigationFrames: frameSummary,
        scripts: [...document.scripts].map((item) => item.src ? new URL(item.src).pathname.split('/').pop() : '<inline>'),
        stylesheets: [...document.styleSheets].map((item) => item.href ? new URL(item.href).pathname.split('/').pop() : '<inline>'),
        domIframes: [...document.querySelectorAll('iframe')].map((item) => ({ src: item.src ? new URL(item.src).pathname : '', width: item.clientWidth, height: item.clientHeight })),
        elementTags: [...(body?.children || [])].map((item) => item.tagName.toLowerCase()),
        customElements: [...document.querySelectorAll('*')].map((item) => item.tagName.toLowerCase()).filter((tag, index, all) => tag.includes('-') && all.indexOf(tag) === index).slice(0, 50)
      }
    })()`
  })
  const result = { schema: 1, observedAt: new Date().toISOString(), extensionId: ICLOUD_ID,
    payloadsCaptured: false, dom: evaluated.result?.value, events }
  socket.close()
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify({ ...result, outputPath }, null, 2)}\n`)
}

main().catch((error) => { console.error(safeError(error?.message || error)); process.exitCode = 1 })
