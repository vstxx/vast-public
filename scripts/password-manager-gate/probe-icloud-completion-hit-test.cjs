#!/usr/bin/env node
const { WorkerCdpSession } = require('./controller.cjs')

const ICLOUD_ID = 'pejdijmoenmkgeppbflobdenhhabjlaj'

function parsePort(value) {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Debugger port must be a valid non-privileged port.')
  }
  return port
}

async function probeCompletionHitTest(debuggerPort, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${debuggerPort}/json/list`)
  if (!response.ok) throw new Error('Local debugger target list is unavailable.')
  const target = (await response.json()).find((item) =>
    item.type === 'webview' && typeof item.url === 'string' &&
    item.url.startsWith('https://login.vast-test.local:') &&
    typeof item.webSocketDebuggerUrl === 'string')
  if (!target) throw new Error('The trusted iCloud fixture webview is unavailable.')

  const session = await WorkerCdpSession.connect(target.webSocketDebuggerUrl)
  try {
    await session.send('Page.enable')
    await session.send('DOM.enable')
    const tree = await session.send('Page.getFrameTree')
    const prefix = `chrome-extension://${ICLOUD_ID}/completion_list.html`
    const pending = [tree.frameTree]
    let frameId
    while (pending.length > 0) {
      const entry = pending.shift()
      if (entry?.frame?.url?.startsWith(prefix)) {
        frameId = entry.frame.id
        break
      }
      pending.push(...(entry?.childFrames || []))
    }
    if (!frameId) return { found: false, reason: 'frame-tree-missing' }
    const owner = await session.send('DOM.getFrameOwner', { frameId })
    const resolved = await session.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId })
    if (!resolved?.object?.objectId) return { found: false, reason: 'owner-unresolved' }
    const response = await session.send('Runtime.callFunctionOn', {
      objectId: resolved.object.objectId,
      functionDeclaration: `function () {
      const frame = this
      const rect = frame.getBoundingClientRect()
      const style = getComputedStyle(frame)
      const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2))
      const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
      const stack = document.elementsFromPoint(x, y).slice(0, 8).map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id || '',
        classNames: [...element.classList].slice(0, 6),
        isCompletionFrame: element === frame
      }))
      return {
        found: true,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        pointerEvents: style.pointerEvents,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        zIndex: style.zIndex,
        position: style.position,
        stack,
        frameIsTopHit: stack[0]?.isCompletionFrame === true,
        ownerTag: frame.tagName.toLowerCase(),
        ownerRootHasHost: frame.getRootNode()?.host != null,
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
      }
    }`,
      returnByValue: true
    })
    if (response?.exceptionDetails || typeof response?.result?.value !== 'object') {
      throw new Error('The completion-list hit-test probe did not return safe metadata.')
    }
    return response.result.value
  } finally {
    session.close()
  }
}

if (require.main === module) {
  const [portValue] = process.argv.slice(2)
  if (!portValue) {
    console.error('Usage: node probe-icloud-completion-hit-test.cjs <debugger-port>')
    process.exitCode = 1
  } else {
    probeCompletionHitTest(parsePort(portValue))
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { parsePort, probeCompletionHitTest }
