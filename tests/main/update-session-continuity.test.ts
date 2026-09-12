import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const updaterSource = readFileSync(new URL('../../src/main/updater.ts', import.meta.url), 'utf8')
const closeSource = readFileSync(new URL('../../src/main/windows/WindowCloseCoordinator.ts', import.meta.url), 'utf8')

test('updates use the same renderer and session save barriers as normal close', () => {
  assert.doesNotMatch(mainSource, /isUpdateRestartInProgress/)
  assert.match(mainSource, /await extensionManager\?\.shutdown\(\)[\s\S]*await extensionManager\?\.flush\(\)/)
  assert.match(mainSource, /clearCookiesOnExit[\s\S]*await clearSiteData\(\)[\s\S]*await checkpointBrowserSessionData\(\)[\s\S]*app\.quit\(\)/)
  assert.match(updaterSource, /updaterState\.assertInstallAllowed\(\)[\s\S]*app\.quit\(\)/)
  assert.match(closeSource, /await this\.requestFlush\(window\)[\s\S]*window\.destroy\(\)/)
})

test('checkpoints cover persistent shared and workspace browser sessions', () => {
  assert.match(sessionsSource, /checkpointPersistentBrowserSessions\(configuredTrackerSessions\)/)
  assert.match(sessionsSource, /persistentBrowserSessions\(\)/)
})
