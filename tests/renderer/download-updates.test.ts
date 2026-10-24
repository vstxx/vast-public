import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string): string => readFileSync(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')

test('download progress re-renders only the notification overlay, not the root App', () => {
  const app = read('app/App.tsx')
  assert.doesNotMatch(app, /useBrowserStore\(\(state\) => state\.downloads\)/)
  assert.match(app, /<NotificationsOverlay toasts=\{toasts\} onDismiss=\{dismissToast\} \/>/)
  assert.match(read('components/ui/NotificationsOverlay.tsx'), /const downloads = useBrowserStore\(\(state\) => state\.downloads\)/)
})

test('download progress bars animate a transform instead of layout width', () => {
  for (const path of ['components/ui/NotificationsOverlay.tsx', 'components/side-panel/SidePanel.tsx', 'components/pdf/PdfViewerPage.tsx']) {
    const source = read(path)
    assert.doesNotMatch(source, /transition-\[width\]/, `${path} animates width`)
    assert.match(source, /origin-left[^"]*"\s*style=\{\{ transform: `scaleX\(/, `${path} uses scaleX`)
  }
})
