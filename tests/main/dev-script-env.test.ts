import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts?: Record<string, string>
}
const devScriptSource = readFileSync(new URL('../../scripts/dev.cjs', import.meta.url), 'utf8')

test('dev startup clears ELECTRON_RUN_AS_NODE before launching Electron', () => {
  assert.equal(packageJson.scripts?.dev, 'node scripts/dev.cjs')
  assert.match(devScriptSource, /delete env\.ELECTRON_RUN_AS_NODE/)
  assert.match(devScriptSource, /electron-vite/)
})
