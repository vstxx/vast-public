import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))

test('approved Electron runtime and npm lock match the measured 45.0.0 candidate', () => {
  const candidate = readJson('audit/evidence/vast-electron-45.0.0-runtime-manifest.json')
  const approved = readJson('patches/extension-compatibility-runtime.json')
  const pkg = readJson('package.json')
  const lock = readJson('package-lock.json')

  assert.equal(candidate.electron.version, '45.0.0')
  assert.deepEqual(approved.electron, candidate.electron)
  assert.equal(approved.ece.version, candidate.ece.version)
  assert.equal(approved.ece.patchPath, candidate.ece.patchPath)
  assert.deepEqual(approved.ece.runtimeFiles, candidate.ece.runtimeFiles)
  assert.equal(pkg.devDependencies.electron, candidate.electron.version)
  assert.equal(lock.packages[''].devDependencies.electron, candidate.electron.version)
  assert.equal(lock.packages['node_modules/electron'].version, candidate.electron.version)
})
