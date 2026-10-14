function isCommittedStoreUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    if (url.pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() === 'error') return false
    return url.protocol === 'https:' && (
      url.hostname === 'chromewebstore.google.com' ||
      (url.hostname === 'chrome.google.com' && (url.pathname === '/webstore' || url.pathname.startsWith('/webstore/')))
    )
  } catch {
    return false
  }
}

function classifyCwsRun(run, approved) {
  const result = run?.result
  const cws = result?.cws
  const reasons = []
  const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (!validHash(approved?.binarySha256) || run?.binarySha256 !== approved.binarySha256) reasons.push('binary-identity')
  if (!validHash(approved?.patchsetSha256) || run?.patchsetSha256 !== approved.patchsetSha256) reasons.push('patchset-identity')
  if (result?.versions?.electron !== approved?.electron || result?.versions?.chrome !== approved?.chrome) reasons.push('runtime-version')
  if (run?.scenario?.extension && run.scenario.extension !== 'none' && !/^[a-p]{32}$/.test(result?.extension?.id ?? '')) reasons.push('extension-not-loaded')
  if (run?.code !== 0 || run?.signal != null || run?.timedOut === true) reasons.push('browser-exit')
  if (result?.completed !== true) reasons.push('incomplete')
  if (!isCommittedStoreUrl(cws?.finalUrl)) reasons.push('not-cws-page')
  if (run?.expectedExtensionId && !hasExtensionId(cws?.finalUrl, run.expectedExtensionId)) reasons.push('wrong-extension-page')
  if (run?.expectedHomepage === true && !isStoreHomepage(cws?.finalUrl)) reasons.push('wrong-homepage')
  if (cws?.pageLoaded !== true) reasons.push('page-not-loaded')
  if (!Number.isFinite(cws?.stableForMs) || cws.stableForMs < 60_000) reasons.push('stability-period')
  if (result?.rendererProcessGone !== false) reasons.push('renderer-gone-or-unobserved')
  if (!Array.isArray(result?.crashDumpFiles) || result.crashDumpFiles.length > 0) reasons.push('crash-dumps')
  if (!Array.isArray(result?.errors) || result.errors.length > 0) reasons.push('harness-errors')
  return { pass: reasons.length === 0, reasons }
}

function hasExtensionId(rawUrl, expectedId) {
  if (typeof expectedId !== 'string' || !/^[a-p]{32}$/.test(expectedId)) return false
  try {
    return new URL(rawUrl).pathname.split('/').includes(expectedId)
  } catch {
    return false
  }
}

function isStoreHomepage(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return url.hostname === 'chromewebstore.google.com' && url.pathname === '/'
  } catch { return false }
}

module.exports = { classifyCwsRun }
