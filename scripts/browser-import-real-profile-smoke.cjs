// Read-only smoke test: real browser profiles are never committed to Vast.
// Output contains only aggregate availability, category status and counts.
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { connectRenderer, waitFor } = require('./performance-suite.cjs')

const project = path.resolve(__dirname, '..')
const dist = process.env.VAST_PATCHED_ELECTRON_DIST
const executable = dist ? path.join(dist, 'electron.exe') : path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe')
assert.ok(fs.existsSync(executable), 'Electron binary is unavailable')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-import-real-smoke-'))
const port = 11500 + Math.floor(Math.random() * 500)
let child
let cdp

async function main() {
  try {
    const env = { ...process.env, VAST_TEST_USER_DATA_DIR: path.join(root, 'Vast'),
      VAST_RELAY_ENABLED: '0', VAST_RELAY_TEST_OFFLINE: '1', VAST_UPDATE_ENABLED: '0', VAST_EXTENSION_COMPATIBILITY: '0' }
    delete env.ELECTRON_RUN_AS_NODE
    child = spawn(executable, [`--remote-debugging-port=${port}`, project], {
      cwd: project, env, windowsHide: true, stdio: 'ignore'
    })
    cdp = await connectRenderer(port)
    await waitFor(cdp, 'Boolean(window.vast?.importer?.discover)', 30_000)
    const catalog = await cdp.evaluate('window.vast.importer.discover()')
    for (const sourceId of ['chrome', 'edge', 'firefox']) {
      const source = catalog.sources.find((item) => item.id === sourceId)
      const profiles = source?.profiles ?? []
      let prepared = 0
      let failed = 0
      for (const profile of profiles.slice(0, 3)) {
        try {
          const preview = await cdp.evaluate(`window.vast.importer.prepare(${JSON.stringify({ sourceId, profileId: profile.id,
            types: sourceId === 'firefox' ? ['bookmarks', 'history'] : ['bookmarks', 'history', 'extensions'] })})`)
          console.log(JSON.stringify({ source: sourceId, profileIndex: prepared + failed + 1,
            categories: Object.fromEntries(Object.entries(preview.categories).map(([type, category]) => [type, {
              status: category.status, code: category.code ?? null }])),
            detected: preview.detected }))
          await cdp.evaluate(`window.vast.importer.discard(${JSON.stringify(preview.token)})`)
          prepared++
        } catch {
          failed++
          console.log(JSON.stringify({ source: sourceId, profileIndex: prepared + failed, status: 'prepare-failed' }))
        }
      }
      console.log(JSON.stringify({ source: sourceId, available: Boolean(source?.available), profiles: profiles.length,
        prepared, failed }))
    }
    const close = await cdp.evaluate('window.vast.app.window.close()')
    assert.equal(close.ok, true)
    cdp.close()
    cdp = undefined
    const exited = child.exitCode !== null || child.signalCode !== null || await new Promise((resolve) => {
      const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false) }, 15_000)
      const onExit = () => { clearTimeout(timer); resolve(true) }
      child.once('exit', onExit)
    })
    assert.equal(exited, true, 'Vast did not close cleanly after read-only smoke')
  } finally {
    cdp?.close()
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }) } catch {}
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vast-import-real-smoke-'))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 })
  }
}

main().catch(() => { console.error('Real-profile read-only smoke failed; no source data was committed or printed.'); process.exitCode = 1 })
