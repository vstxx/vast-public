// Opt-in local E2E. Real bookmarks/history are written only to a unique
// temporary Vast profile, never printed, and removed after the restart check.
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectRenderer, waitFor } = require('./performance-suite.cjs')

const sourceId = process.argv[2]
const inspectExtensions = process.argv.includes('--extension-previews')
if (!['chrome', 'edge'].includes(sourceId)) throw new Error('Use chrome or edge')
const project = path.resolve(__dirname, '..')
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
const executable = dist && path.join(dist, 'electron.exe')
if (!executable || !fs.existsSync(executable)) throw new Error('Set VAST_PATCHED_ELECTRON_DIST to the patched Electron binary')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-import-real-commit-'))
const userData = path.join(root, 'Vast')
const port = 12000 + Math.floor(Math.random() * 500)
let child
let cdp

async function launch() {
  const env = { ...process.env, VAST_TEST_USER_DATA_DIR: userData, VAST_RELAY_ENABLED: '0',
    VAST_RELAY_TEST_OFFLINE: '1', VAST_UPDATE_ENABLED: '0', VAST_EXTENSION_COMPATIBILITY: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(executable, [`--remote-debugging-port=${port}`, project], {
    cwd: project, env, windowsHide: true, stdio: 'ignore'
  })
  cdp = await connectRenderer(port)
  await waitFor(cdp, 'Boolean(window.vast?.importer?.prepare)', 30_000)
}

async function close() {
  const process = child
  const session = cdp
  child = undefined
  cdp = undefined
  await waitFor(session, 'Boolean(document.querySelector(".app-shell"))', 10_000)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const response = await session.evaluate('window.vast.app.window.close()')
  assert.equal(response.ok, true)
  const exited = process.exitCode !== null || process.signalCode !== null || await new Promise((resolve) => {
    const timer = setTimeout(() => { process.removeListener('exit', onExit); resolve(false) }, 15_000)
    const onExit = () => { clearTimeout(timer); resolve(true) }
    process.once('exit', onExit)
  })
  session.close()
  assert.equal(exited, true, 'Vast did not close cleanly')
}

async function main() {
  try {
    await launch()
    const catalog = await cdp.evaluate('window.vast.importer.discover()')
    const profileId = catalog.sources.find((source) => source.id === sourceId)?.profiles[0]?.id
    assert.equal(typeof profileId, 'string', `${sourceId} has no discoverable profile`)
    const types = sourceId === 'chrome' ? ['history'] : ['bookmarks', 'history']
    if (inspectExtensions) types.push('extensions')
    const preview = await cdp.evaluate(`window.vast.importer.prepare(${JSON.stringify({ sourceId, profileId, types })})`)
    for (const type of types) assert.equal(preview.categories[type].status, 'ready', `${sourceId} ${type} source is not ready`)
    const extensionCandidates = inspectExtensions ? preview.detectedExtensions.filter((item) => item.state === 'detected') : []
    const extensionIds = extensionCandidates.slice(0, 3).map((item) => item.id)
    const receipt = await cdp.evaluate(`window.vast.importer.commit(${JSON.stringify({ token: preview.token,
      acceptPartial: false, selectedExtensionIds: extensionIds })})`)
    assert.ok(receipt.counts.history.added > 0)
    if (sourceId === 'edge') assert.ok(receipt.counts.bookmarks.added > 0)
    const before = await cdp.evaluate('window.vast.storage.load().then(data => ({bookmarks:data.bookmarks.length,history:data.history.length}))')
    assert.equal(before.history, receipt.counts.history.added)
    assert.equal(before.bookmarks, receipt.counts.bookmarks.added)
    let extensionPreviews = 0
    const extensionResults = { unsupported: 0, failed: 0, installed: 0, declined: 0 }
    const extensionFailureReasons = {}
    if (inspectExtensions) {
      for (const id of extensionIds) {
        const prepared = await cdp.evaluate(`window.vast.importer.prepareExtension(${JSON.stringify(receipt.operationId)},${JSON.stringify(id)})`)
        if (prepared.kind === 'preview') {
          extensionPreviews++
          assert.deepEqual(prepared.preview.permissions.vast, [], 'local copy requested Vast-native permission')
          const beforeConsent = await cdp.evaluate('window.vast.extensions.list()')
          assert.equal(beforeConsent.extensions.some((item) => item.id === id), false, 'real extension activated before consent')
          await cdp.evaluate(`window.vast.importer.declineExtension(${JSON.stringify(receipt.operationId)},${JSON.stringify(id)})`)
          extensionResults.declined++
        } else {
          assert.ok(Object.hasOwn(extensionResults, prepared.receipt.status), 'unexpected extension result')
          extensionResults[prepared.receipt.status]++
          const reason = prepared.receipt.message || 'No reason recorded'
          extensionFailureReasons[reason] = (extensionFailureReasons[reason] || 0) + 1
          if (prepared.receipt.status === 'failed') {
            await cdp.evaluate(`window.vast.importer.declineExtension(${JSON.stringify(receipt.operationId)},${JSON.stringify(id)})`)
          }
        }
      }
    }
    // Direct IPC bypasses onboarding's normal post-commit store hydration.
    await cdp.evaluate('location.reload()').catch(() => undefined)
    await waitFor(cdp, 'Boolean(document.querySelector("[data-testid=onboarding-page]"))', 15_000)
    await close()
    await launch()
    const after = await cdp.evaluate('window.vast.storage.load().then(data => ({bookmarks:data.bookmarks.length,history:data.history.length}))')
    const status = await cdp.evaluate('window.vast.importer.status()')
    assert.deepEqual(after, before)
    assert.equal(status.receipt?.operationId, receipt.operationId)
    assert.deepEqual(status.pendingExtensionIds, [])
    await close()
    console.log(JSON.stringify({ source: sourceId, result: 'PASS', bookmarks: after.bookmarks,
      history: after.history, extensionCandidates: extensionCandidates.length,
      extensionPreviews, extensionResults, extensionFailureReasons, extensionsActivated: 0,
      restartPersistence: true, profile: 'temporary; removed' }))
  } finally {
    cdp?.close()
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vast-import-real-commit-'))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
}

main().catch(() => { console.error('Real import E2E failed; no personal data was printed.'); process.exitCode = 1 })
