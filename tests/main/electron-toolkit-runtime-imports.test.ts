import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

const mainSource = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
const windowSource = readFileSync(new URL('../../src/main/window.ts', import.meta.url), 'utf8')
const openingSplashUrl = new URL('../../src/main/opening-splash.ts', import.meta.url)

test('main process startup avoids runtime imports from electron toolkit utils', () => {
  for (const source of [mainSource, windowSource]) {
    assert.doesNotMatch(source, /@electron-toolkit\/utils/)
    assert.doesNotMatch(source, /from 'electron'/)
  }
  assert.match(mainSource, /from 'electron\/main'/)
  assert.match(windowSource, /from 'electron\/main'/)
  assert.equal(existsSync(openingSplashUrl), false, 'opening sequence must not create a second renderer process')
})
