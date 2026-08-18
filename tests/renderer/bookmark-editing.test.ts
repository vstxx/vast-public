import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sidePanelSource = readFileSync(new URL('../../src/renderer/components/side-panel/SidePanel.tsx', import.meta.url), 'utf8')
const promptSource = readFileSync(new URL('../../src/renderer/components/ui/PromptDialog.tsx', import.meta.url), 'utf8')

test('bookmark editors stay constrained to the sidebar width', () => {
  assert.match(sidePanelSource, /grid-cols-\[minmax\(0,1fr\)_minmax\(5\.5rem,7\.5rem\)\]/)
  assert.match(sidePanelSource, /min-w-0 max-w-full gap-2 overflow-hidden pl-6/)
  assert.match(sidePanelSource, /className="w-full min-w-0 max-w-\[7\.5rem\]"/)
  assert.match(sidePanelSource, /min-w-0 overflow-hidden rounded-2xl/)
})

test('bookmark folder naming keeps a local draft and protects editable focus', () => {
  assert.match(sidePanelSource, /function FolderNameEditor/)
  assert.match(sidePanelSource, /const \[draft, setDraft\] = useState\(folder\.name\)/)
  assert.match(promptSource, /event\.key !== 'Tab' && event\.key !== 'Escape'/)
  assert.match(promptSource, /useBrowserStore\.getState\(\)\.promptDialog === dialog/)
  assert.match(promptSource, /onKeyDown=\{\(event\) => \{/)
})
