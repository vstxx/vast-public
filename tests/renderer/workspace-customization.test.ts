import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const storeSource = readFileSync(new URL('../../src/renderer/store/browser-store.ts', import.meta.url), 'utf8')
const switcherSource = readFileSync(new URL('../../src/renderer/components/workspaces/WorkspaceSwitcher.tsx', import.meta.url), 'utf8')
const pickerSource = readFileSync(new URL('../../src/renderer/components/workspaces/WorkspaceAppearancePicker.tsx', import.meta.url), 'utf8')
const newTabSource = readFileSync(new URL('../../src/renderer/components/new-tab/NewTabPage.tsx', import.meta.url), 'utf8')
const addressSource = readFileSync(new URL('../../src/renderer/components/browser/AddressBar.tsx', import.meta.url), 'utf8')

test('each workspace exposes its own icon and color editor', () => {
  assert.match(storeSource, /updateWorkspaceAppearance:/)
  assert.match(storeSource, /workspace\.id !== workspaceId/)
  assert.match(storeSource, /\^#\[0-9a-f\]\{6\}\$/i)
  assert.match(switcherSource, /Customize \$\{workspace\.name\} workspace/)
  assert.match(switcherSource, /workspaceId=\{workspace\.id\}/)
  assert.match(pickerSource, /WORKSPACE_ICON_OPTIONS\.map/)
  assert.match(pickerSource, /WORKSPACE_COLOR_OPTIONS\.map/)
  assert.match(pickerSource, /type="color"/)
})

test('opening identity is logo-first without the redundant workspace label', () => {
  assert.match(newTabSource, /data-testid="new-tab-identity"/)
  assert.doesNotMatch(newTabSource, /\{workspace\?\.name \?\? 'Vast'\} workspace/)
  assert.match(newTabSource, /h-28[^"]*sm:h-32/)
})

test('address-bar controls use a dedicated symmetric sizing hook', () => {
  assert.equal(addressSource.match(/address-bar-controls/g)?.length, 2)
})
