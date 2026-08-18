import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const stageSource = readFileSync(new URL('../../src/renderer/components/browser/BrowserStage.tsx', import.meta.url), 'utf8')
const webviewSurfaceSource = readFileSync(new URL('../../src/renderer/components/browser/WebviewSurface.tsx', import.meta.url), 'utf8')
const source = `${stageSource}\n${webviewSurfaceSource}`

test('webviews use real per-workspace identity partitions while retaining explicit shared compatibility', () => {
  assert.match(source, /partition=\{partition\}/)
  assert.match(source, /partitionForWorkspace\(identityWorkspace\)/)
  assert.match(source, /tab\.identityWorkspaceId/)
})
