globalThis.nativeMessagingEvidence = {
  sendNativeMessage: null,
  portMessages: [],
  connectError: null,
  disconnectError: null,
  complete: false
}

const hostName = 'com.vast.native_messaging_test'
const markComplete = () => {
  globalThis.nativeMessagingEvidence.complete = Boolean(
    globalThis.nativeMessagingEvidence.sendNativeMessage &&
    globalThis.nativeMessagingEvidence.portMessages.length === 3 &&
    globalThis.nativeMessagingEvidence.disconnectError
  )
}

chrome.runtime.sendNativeMessage(hostName, { kind: 'single', text: 'zażółć 🌍' }, (response) => {
  globalThis.nativeMessagingEvidence.sendNativeMessage = {
    response,
    error: chrome.runtime.lastError?.message || null
  }
  markComplete()
})

let port
try {
  port = chrome.runtime.connectNative(hostName)
} catch (error) {
  globalThis.nativeMessagingEvidence.connectError = error?.message || String(error)
  throw error
}
port.onMessage.addListener((message) => {
  globalThis.nativeMessagingEvidence.portMessages.push(message)
  if (globalThis.nativeMessagingEvidence.portMessages.length === 2) {
    port.postMessage({ kind: 'fragmented', text: 'gęślą jaźń 🌍' })
  }
  if (globalThis.nativeMessagingEvidence.portMessages.length === 3) {
    port.disconnect()
    const crashPort = chrome.runtime.connectNative(hostName)
    crashPort.onDisconnect.addListener(() => {
      globalThis.nativeMessagingEvidence.disconnectError = chrome.runtime.lastError?.message || null
      markComplete()
    })
    crashPort.postMessage({ kind: 'exit' })
  }
})
port.postMessage({ kind: 'coalesced' })
