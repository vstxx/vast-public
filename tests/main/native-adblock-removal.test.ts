import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_SETTINGS, DEFAULT_SHORTCUTS } from '../../src/shared/constants.ts'

test('native ad blocker cannot return through defaults, scripts, IPC or chrome', () => {
  assert.equal('adBlockerEnabled' in DEFAULT_SETTINGS.privacy, false)
  assert.equal('toggleAdBlocker' in DEFAULT_SHORTCUTS, false)
  for (const path of ['src/shared/adblock.ts', 'src/main/privacy-filter-lists.ts', 'src/shared/privacy-filter-matcher.ts']) assert.equal(existsSync(path), false)
  for (const path of ['src/main/sessions.ts', 'src/main/ipc.ts', 'src/preload/index.ts', 'src/renderer/components/browser/WebviewSurface.tsx', 'src/renderer/components/settings/SettingsModal.tsx', 'src/renderer/components/command-palette/CommandPalette.tsx']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /adBlockerEnabled|adBlockerMode|buildCosmeticAdBlockScript|updatePrivacyFilters|privacy:filter-status|privacy:update-filters/)
  }
  assert.ok(existsSync('resources/first-party-extensions/adblocker-for-vast/manifest.json'))
  assert.match(readFileSync('src/main/sessions.ts', 'utf8'), /extensionNetworkDecision/)
})
