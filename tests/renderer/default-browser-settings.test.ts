import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const settingsSource = readFileSync(new URL('../../src/renderer/components/settings/SettingsModal.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
const ipcSource = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')

test('settings exposes a bottom default browser action', () => {
  assert.match(settingsSource, /settings-default-browser-panel/)
  assert.match(settingsSource, /settings-default-browser-action/)
  assert.match(settingsSource, /set browser as default/)
  assert.match(settingsSource, /MonitorCheck/)
})

test('default browser action uses preload IPC and reports Windows follow-up', () => {
  assert.match(settingsSource, /openDefaultBrowserSettings/)
  assert.match(settingsSource, /Select Vast for HTTP and HTTPS to finish/)
  assert.match(preloadSource, /vast:app:default-browser-status/)
  assert.match(preloadSource, /vast:app:open-default-browser-settings/)
  assert.match(ipcSource, /openDefaultBrowserSettings/)
})
