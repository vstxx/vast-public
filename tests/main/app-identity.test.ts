import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const electronRuntimeSource = readFileSync(new URL('../../src/main/electron-runtime.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')

test('Windows app identity always uses the Vast AppUserModelID', () => {
  assert.match(mainSource, /app\.setAppUserModelId\('app\.vast\.browser'\)/)
  assert.match(electronRuntimeSource, /app\.setAppUserModelId\(id\)/)
  assert.doesNotMatch(electronRuntimeSource, /setAppUserModelId\(isDev \? process\.execPath : id\)/)
})

test('main browser window carries the packaged Vast icon path', () => {
  assert.match(windowSource, /APP_ICON_PATH/)
  assert.match(windowSource, /app-icon\.png/)
  assert.match(windowSource, /app-icon-windows\.png/)
  assert.match(windowSource, /process\.platform === 'win32'/)
  assert.match(windowSource, /icon:\s*APP_ICON_PATH/)
})
