import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const browserStage = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurface = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const browserRuntime = `${browserStage}\n${webviewSurface}`
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const diagnosticsSource = readFileSync(new URL('../../src/main/diagnostics-events.ts', import.meta.url), 'utf8')

test('guest crashes are isolated into a reloadable tab crash state', () => {
  assert.match(browserRuntime, /addEventListener\('render-process-gone', onGuestCrash\)/)
  assert.match(browserRuntime, /lifecycle: 'crashed'/)
  assert.match(browserRuntime, /validatedUrl: latestTabRef\.current\.url/)
  assert.match(browserRuntime, /lifecycle: 'active'/)
})

test('main renderer recovery is bounded and child process exits are observed', () => {
  assert.match(windowSource, /rendererCrashTimes\.length > 2/)
  assert.match(windowSource, /mainWindow\.webContents\.reload\(\)/)
  assert.match(mainSource, /app\.on\('child-process-gone'/)
  assert.match(mainSource, /repeatedGpuCrashes/)
})

test('local diagnostics are bounded, atomic, and redact common secrets', () => {
  assert.match(diagnosticsSource, /const MAX_EVENTS = 200/)
  assert.match(diagnosticsSource, /atomicWriteJson/)
  assert.match(diagnosticsSource, /Bearer \[redacted\]/)
  assert.match(diagnosticsSource, /access_token/)
})
