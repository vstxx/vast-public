async function extensionContextId(session,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const ids = new Set()
  const unsubscribe = session.on('Runtime.executionContextCreated', (params) => {
    if (Number.isSafeInteger(params?.context?.id)) ids.add(params.context.id)
  })
  try {
    try { await session.send('Runtime.disable') } catch {}
    await session.send('Runtime.enable')
    await wait(50)
  } finally { unsubscribe() }
  for (const contextId of ids) {
    const response = await session.send('Runtime.evaluate', {
      expression: 'typeof chrome === "object" && typeof chrome.runtime === "object"',
      contextId,
      returnByValue: true
    })
    if (!response?.exceptionDetails && response?.result?.value === true) return contextId
  }
  return undefined
}

async function evaluateExtensionExpression(session, expression, wait) {
  const contextId = await extensionContextId(session, wait)
  if (!Number.isSafeInteger(contextId)) throw new Error('Extension execution context is unavailable.')
  const response = await session.send('Runtime.evaluate', {
    expression,
    contextId,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (response?.exceptionDetails || !response?.result || !Object.hasOwn(response.result, 'value')) {
    throw new Error('Extension context evaluation failed.')
  }
  return response.result.value
}

module.exports = { evaluateExtensionExpression, extensionContextId }
