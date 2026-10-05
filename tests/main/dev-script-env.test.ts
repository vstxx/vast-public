import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  scripts?: Record<string, string>
}
const devScriptSource = readFileSync(new URL('../../scripts/dev.cjs', import.meta.url), 'utf8')
const compatibilityDevScriptSource = readFileSync(new URL('../../scripts/dev-extension-compat.cjs', import.meta.url), 'utf8')

test('default dev startup uses the verified patched compatibility runtime and keeps stock explicit', () => {
  assert.equal(packageJson.scripts?.dev, 'node scripts/dev-extension-compat.cjs')
  assert.equal(packageJson.scripts?.['dev:stock'], 'node scripts/dev.cjs')
  assert.match(compatibilityDevScriptSource, /VAST_EXTENSION_COMPATIBILITY:\s*'1'/)
  assert.match(compatibilityDevScriptSource, /VAST_PATCHED_ELECTRON_COMPAT:\s*'1'/)
  assert.match(compatibilityDevScriptSource, /ELECTRON_EXEC_PATH:\s*executable/)
  assert.match(compatibilityDevScriptSource, /verify-extension-compat-runtime\.cjs/)
  assert.match(compatibilityDevScriptSource, /defaultOutputPath\(manifest\)/)
  assert.match(compatibilityDevScriptSource, /VAST_PATCHED_ELECTRON_DIST \|\| preparedDist/)
  assert.match(compatibilityDevScriptSource, /prepare-extension-compat-runtime\.cjs'\), '--check'/)
  assert.match(compatibilityDevScriptSource, /if \(prepared\.status !== 0\).*prepare-extension-compat-runtime\.cjs/s)
})

test('underlying dev startup clears ELECTRON_RUN_AS_NODE before launching Electron', () => {
  assert.match(devScriptSource, /delete env\.ELECTRON_RUN_AS_NODE/)
  assert.match(devScriptSource, /electron-vite/)
})
