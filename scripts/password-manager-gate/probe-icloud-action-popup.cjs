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

async function probeIcloudActionPopup(debuggerPort, mode = 'inspect', fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${debuggerPort}/json/list`)
  if (!response.ok) throw new Error('Local debugger target list is unavailable.')
  const completionPrefix = `chrome-extension://${ICLOUD_ID}/completion_list.html`
  const backgroundUrl = `chrome-extension://${ICLOUD_ID}/background.js`
  const targets = (await response.json()).filter((item) =>
    typeof item.url === 'string' && typeof item.webSocketDebuggerUrl === 'string' && (
      (item.type === 'iframe' && item.url.startsWith(completionPrefix)) ||
      (mode === 'state' && item.type === 'service_worker' && item.url === backgroundUrl)
    ))
  if (targets.length === 0) throw new Error('The iCloud extension debugging target is unavailable.')

  const expression = mode === 'state'
      ? `Promise.resolve().then(async () => {
          try {
            const popup = await chrome.action.getPopup({})
            return { settled: 'resolved', popup: typeof popup === 'string' ? popup : null }
          } catch (error) {
            return {
              settled: 'rejected',
              error: typeof error?.message === 'string' ? error.message.slice(0, 200) : 'unknown error'
            }
          }
        })`
      : mode === 'invoke'
      ? `Promise.resolve().then(async () => {
          if (typeof chrome?.action?.openPopup !== 'function') return { available: false, settled: 'unavailable' }
          try {
            await chrome.action.openPopup()
            return { available: true, settled: 'resolved' }
          } catch {
            return { available: true, settled: 'rejected' }
          }
        })`
      : mode === 'arm'
        ? `(() => {
            if (typeof chrome?.action?.openPopup !== 'function') return { armed: false, calls: 0 }
            if (!globalThis.__vastGateOriginalOpenPopup) {
              globalThis.__vastGateOriginalOpenPopup = chrome.action.openPopup.bind(chrome.action)
            }
            if (globalThis.__vastGateOpenPopupObserverVersion !== 2) {
              globalThis.__vastGateOpenPopupCalls = 0
              globalThis.__vastGateOpenPopupResolved = 0
              globalThis.__vastGateOpenPopupRejected = 0
              globalThis.__vastGateOpenPopupPending = 0
              globalThis.__vastGateOpenPopupLastError = null
              Object.defineProperty(chrome.action, 'openPopup', {
                configurable: true,
                enumerable: true,
                value: (...args) => {
                  globalThis.__vastGateOpenPopupCalls += 1
                  globalThis.__vastGateOpenPopupPending += 1
                  const result = globalThis.__vastGateOriginalOpenPopup(...args)
                  Promise.resolve(result).then(
                    () => {
                      globalThis.__vastGateOpenPopupPending -= 1
                      globalThis.__vastGateOpenPopupResolved += 1
                    },
                    (error) => {
                      globalThis.__vastGateOpenPopupPending -= 1
                      globalThis.__vastGateOpenPopupRejected += 1
                      globalThis.__vastGateOpenPopupLastError =
                        typeof error?.message === 'string' ? error.message.slice(0, 200) : 'unknown error'
                    }
                  )
                  return result
                }
              })
              globalThis.__vastGateOpenPopupObserverVersion = 2
            }
            if (!globalThis.__vastGateMouseObserver) {
              globalThis.__vastGateMouseDowns = 0
              globalThis.__vastGateLastTargetIsPairMessage = false
              globalThis.__vastGateMouseObserver = (event) => {
                globalThis.__vastGateMouseDowns += 1
                globalThis.__vastGateLastTargetIsPairMessage =
                  event.target?.closest?.('#needToPairMessageBox') != null
              }
              document.addEventListener('mousedown', globalThis.__vastGateMouseObserver, true)
            }
            return {
              armed: true,
              calls: globalThis.__vastGateOpenPopupCalls,
              resolved: globalThis.__vastGateOpenPopupResolved,
              rejected: globalThis.__vastGateOpenPopupRejected,
              pending: globalThis.__vastGateOpenPopupPending,
              lastError: globalThis.__vastGateOpenPopupLastError,
              mouseDowns: globalThis.__vastGateMouseDowns,
              lastTargetIsPairMessage: globalThis.__vastGateLastTargetIsPairMessage
            }
          })()`
        : mode === 'count'
          ? `({ armed: typeof globalThis.__vastGateOriginalOpenPopup === 'function',
                calls: Number.isSafeInteger(globalThis.__vastGateOpenPopupCalls)
                  ? globalThis.__vastGateOpenPopupCalls : 0,
                resolved: Number.isSafeInteger(globalThis.__vastGateOpenPopupResolved)
                  ? globalThis.__vastGateOpenPopupResolved : 0,
                rejected: Number.isSafeInteger(globalThis.__vastGateOpenPopupRejected)
                  ? globalThis.__vastGateOpenPopupRejected : 0,
                pending: Number.isSafeInteger(globalThis.__vastGateOpenPopupPending)
                  ? globalThis.__vastGateOpenPopupPending : 0,
                lastError: typeof globalThis.__vastGateOpenPopupLastError === 'string'
                  ? globalThis.__vastGateOpenPopupLastError : null,
                mouseDowns: Number.isSafeInteger(globalThis.__vastGateMouseDowns)
                  ? globalThis.__vastGateMouseDowns : 0,
                lastTargetIsPairMessage: globalThis.__vastGateLastTargetIsPairMessage === true })`
          : `(() => {
          const bodyStyle = document.body ? getComputedStyle(document.body) : null
          const rootStyle = document.documentElement ? getComputedStyle(document.documentElement) : null
          const bodyRect = document.body?.getBoundingClientRect()
          const pairMessage = document.querySelector('#needToPairMessageBox')
          const pairRect = pairMessage?.getBoundingClientRect()
          const pairStyle = pairMessage ? getComputedStyle(pairMessage) : null
          const centerX = pairRect ? pairRect.left + pairRect.width / 2 : -1
          const centerY = pairRect ? pairRect.top + pairRect.height / 2 : -1
          const centerElement = centerX >= 0 && centerY >= 0
            ? document.elementFromPoint(centerX, centerY)
            : null
          return {
          available: typeof chrome?.action?.openPopup === 'function',
          actionAvailable: typeof chrome?.action === 'object',
          manifestDefaultPopup: chrome?.runtime?.getManifest?.()?.action?.default_popup || null,
          documentReady: document.readyState === 'complete',
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          bodyRect: bodyRect ? {
            x: Math.round(bodyRect.x), y: Math.round(bodyRect.y),
            width: Math.round(bodyRect.width), height: Math.round(bodyRect.height)
          } : null,
          pairMessagePresent: pairMessage != null,
          pairRect: pairRect ? {
            x: Math.round(pairRect.x), y: Math.round(pairRect.y),
            width: Math.round(pairRect.width), height: Math.round(pairRect.height)
          } : null,
          pairDisplay: pairStyle?.display || null,
          pairVisibility: pairStyle?.visibility || null,
          pairPointerEvents: pairStyle?.pointerEvents || null,
          pairOpacity: pairStyle?.opacity || null,
          centerHitsPairMessage: centerElement?.closest?.('#needToPairMessageBox') != null,
          bodyDisplay: bodyStyle?.display || null,
          bodyVisibility: bodyStyle?.visibility || null,
          bodyPointerEvents: bodyStyle?.pointerEvents || null,
          rootDisplay: rootStyle?.display || null,
          rootVisibility: rootStyle?.visibility || null,
          rootPointerEvents: rootStyle?.pointerEvents || null,
          nativeImplementation: typeof chrome?.action?.openPopup === 'function' &&
            Function.prototype.toString.call(chrome.action.openPopup).includes('[native code]'),
          implementationLength: typeof chrome?.action?.openPopup === 'function'
            ? Function.prototype.toString.call(chrome.action.openPopup).length
            : 0,
          setTitleNative: typeof chrome?.action?.setTitle === 'function' &&
            Function.prototype.toString.call(chrome.action.setTitle).includes('[native code]'),
          setTitleLength: typeof chrome?.action?.setTitle === 'function'
            ? Function.prototype.toString.call(chrome.action.setTitle).length
            : 0,
          getUserSettingsNative: typeof chrome?.action?.getUserSettings === 'function' &&
            Function.prototype.toString.call(chrome.action.getUserSettings).includes('[native code]'),
          actionDescriptorConfigurable: Object.getOwnPropertyDescriptor(chrome, 'action')?.configurable === true,
          openPopupOwnProperty: Object.prototype.hasOwnProperty.call(chrome.action || {}, 'openPopup')
          }
        })()`

  const results = []
  for (const target of targets) {
    const session = await WorkerCdpSession.connect(target.webSocketDebuggerUrl)
    try {
      const evaluation = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: mode === 'invoke' || mode === 'state'
      })
      if (evaluation?.exceptionDetails || typeof evaluation?.result?.value !== 'object') {
        throw new Error('The action-popup probe did not return safe metadata.')
      }
      results.push(Object.freeze({
        targetSuffix: String(target.id || '').slice(-8),
        parentSuffix: String(target.parentId || '').slice(-8),
        targetType: target.type,
        ...evaluation.result.value
      }))
    } finally {
      session.close()
    }
  }
  return Object.freeze(results)
}

async function watchIcloudActionPopup(debuggerPort, durationMs = 120_000) {
  const deadline = Date.now() + durationMs
  let passes = 0
  while (Date.now() < deadline) {
    try {
      await probeIcloudActionPopup(debuggerPort, 'arm')
      passes += 1
    } catch {
      // Targets are expected to disappear briefly while the completion iframe
      // is being replaced. Keep watching for its successor.
    }
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  return Object.freeze({ watchedMs: durationMs, passes })
}

if (require.main === module) {
  const [portValue, mode = 'inspect', durationValue] = process.argv.slice(2)
  if (!portValue || !['inspect', 'state', 'invoke', 'arm', 'count', 'watch'].includes(mode)) {
    console.error('Usage: node probe-icloud-action-popup.cjs <debugger-port> [inspect|state|invoke|arm|count|watch] [duration-ms]')
    process.exitCode = 1
  } else {
    const durationMs = durationValue === undefined ? 120_000 : Number(durationValue)
    const operation = mode === 'watch'
      ? (Number.isSafeInteger(durationMs) && durationMs >= 1_000 && durationMs <= 300_000
          ? watchIcloudActionPopup(parsePort(portValue), durationMs)
          : Promise.reject(new Error('Watch duration must be between 1000 and 300000 milliseconds.')))
      : probeIcloudActionPopup(parsePort(portValue), mode)
    operation
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => { console.error(error.message); process.exitCode = 1 })
  }
}

module.exports = { parsePort, probeIcloudActionPopup, watchIcloudActionPopup }
