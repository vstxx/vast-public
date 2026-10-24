import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const windowSource = read('src/main/window.ts')
const mainSource = read('src/main/main.ts')
const splashSource = read('src/main/opening-splash.ts')

// 0.5.4: the 0.5.0 updater relaunches Vast with -WindowStyle Hidden, Windows
// applied that to the browser window, and Vast stayed invisible.
test('a window meant to be visible is shown again when a hidden launch hid it', () => {
  assert.match(windowSource, /const revealIfStartedHidden = \(\): void => \{\n\s+if \(mainWindow\.isDestroyed\(\) \|\| mainWindow\.isVisible\(\)\) return\n\s+if \(options\.showWhenReady \|\| options\.showInitially !== false\) \{\n\s+mainWindow\.show\(\)/)
  assert.match(windowSource, /once\('ready-to-show', \(\) => \{\n[^\n]+\n\s+revealIfStartedHidden\(\)/)
  assert.match(windowSource, /webContents\.once\('did-finish-load', \(\) => \{\n[^\n]+\n\s+revealIfStartedHidden\(\)/)
  assert.match(splashSource, /splash\.show\(\)\n[^\n]+\n\s+if \(!splash\.isVisible\(\)\) splash\.show\(\)/)
})

test('opening Vast again brings the running browser forward once startup has revealed it', () => {
  assert.match(mainSource, /app\.on\('second-instance', \(_event, commandLine\) => \{\n\s+revealExistingWindow\?\.\(\)/)
  assert.match(mainSource, /revealExistingWindow = \(\) => \{\n\s+if \(!primaryRevealed\) return\n[\s\S]{0,200}window\.show\(\)\n\s+window\.focus\(\)/)
})

test('both public release workflows launch the packaged app hidden and require a visible window', () => {
  for (const workflow of ['public-unsigned-beta.yml', 'public-release.yml']) {
    const source = read(`.github/workflows/${workflow}`)
    assert.match(source, /tests\/windows-hidden-launch\.test\.ps1 -ExecutablePath "release\/Vast-\$version\/win-unpacked\/Vast\.exe"/, workflow)
  }
  const probe = read('tests/windows-hidden-launch.test.ps1')
  assert.match(probe, /Start-Process -FilePath \$exe -ArgumentList '--vast-after-update'[^\n]+-WindowStyle Hidden/)
  assert.match(probe, /IsWindowVisible/)
})

test('the update helper relaunches the browser with a normal window', () => {
  const helper = read('resources/apply-update.ps1')
  const relaunch = helper.split('\n').filter((line) => line.startsWith('Start-Process -FilePath $LaunchPath'))
  assert.equal(relaunch.length, 1)
  assert.match(relaunch[0], /-WindowStyle Normal$/)
})
