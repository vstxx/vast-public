import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  beginUpdateRestart,
  cancelUpdateRestart,
  isUpdateRestartInProgress
} from '../../src/main/update-lifecycle.ts'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const sessionsSource = readFileSync(new URL('../../src/main/sessions.ts', import.meta.url), 'utf8')
const updaterSource = readFileSync(new URL('../../src/main/updater.ts', import.meta.url), 'utf8')

test('update restart state prevents clear-on-exit cleanup during installer handoff', () => {
  cancelUpdateRestart()
  assert.equal(isUpdateRestartInProgress(), false)
  beginUpdateRestart()
  assert.equal(isUpdateRestartInProgress(), true)
  cancelUpdateRestart()
  assert.equal(isUpdateRestartInProgress(), false)
  assert.match(mainSource, /if \(isUpdateRestartInProgress\(\) \|\| shutdownCleanupComplete\) return[\s\S]*clearCookiesOnExit/)
  assert.match(mainSource, /event\.preventDefault\(\)[\s\S]*await checkpointBrowserSessionData\(\)[\s\S]*app\.quit\(\)/)
})

test('in-app updates checkpoint all persistent browser sessions before quitting', () => {
  assert.match(updaterSource, /await checkpointBrowserSessionData\(\)[\s\S]*beginUpdateRestart\(\)[\s\S]*quitAndInstall/)
  assert.match(sessionsSource, /checkpointPersistentBrowserSessions\(configuredTrackerSessions\)/)
  assert.match(sessionsSource, /persistentBrowserSessions\(\)/)
})
