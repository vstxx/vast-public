import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  copyDataRootForMigration,
  dataPathConfigFile,
  readConfiguredDataRoot,
  validateDataRootCandidate,
  writeConfiguredDataRoot
} from '../../src/main/data-path-utils.ts'

test('data root validation accepts writable profile folders', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-data-root-'))
  try {
    const target = join(tempRoot, 'Profile')
    const result = await validateDataRootCandidate(target, {
      currentDataRoot: join(tempRoot, 'Current'),
      defaultDataRoot: join(tempRoot, 'Default'),
      installRoot: join(tempRoot, 'App')
    })
    assert.equal(result.ok, true)
    assert.equal(result.path, await realpath(target))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('data root validation rejects roots inside the active data directory', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-data-root-'))
  try {
    const current = join(tempRoot, 'Current')
    await mkdir(current, { recursive: true })
    const result = await validateDataRootCandidate(join(current, 'nested'), {
      currentDataRoot: current,
      defaultDataRoot: join(tempRoot, 'Default'),
      installRoot: join(tempRoot, 'App')
    })
    assert.equal(result.ok, false)
    assert.match(result.error, /inside the active Vast data directory/i)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('configured custom data root is persisted outside the active profile', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-data-config-'))
  try {
    const configRoot = join(tempRoot, 'Config')
    const customRoot = join(tempRoot, 'CustomProfile')
    await writeConfiguredDataRoot(configRoot, customRoot)
    assert.equal(dataPathConfigFile(configRoot), join(configRoot, 'data-root.json'))
    assert.equal(await readConfiguredDataRoot(configRoot), resolve(customRoot))
    const raw = await readFile(join(configRoot, 'data-root.json'), 'utf8')
    assert.doesNotMatch(raw, /licenseKey|privateKey|service_role/i)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('data root migration copy preserves user data and skips volatile caches', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-data-copy-'))
  try {
    const source = join(tempRoot, 'Source')
    const target = join(tempRoot, 'Target')
    await mkdir(join(source, 'Cache'), { recursive: true })
    await mkdir(join(source, 'Sessions'), { recursive: true })
    await writeFile(join(source, 'vast-data.json'), '{"schemaVersion":1}', 'utf8')
    await writeFile(join(source, 'password-vault.json'), '{"schemaVersion":1,"records":[]}', 'utf8')
    await writeFile(join(source, 'Cache', 'http-cache'), 'cache', 'utf8')
    await writeFile(join(source, 'Sessions', 'session'), 'session', 'utf8')

    const result = await copyDataRootForMigration(source, target)

    assert.equal(result.copiedFiles.includes('vast-data.json'), true)
    assert.equal(result.copiedFiles.includes('password-vault.json'), true)
    assert.equal(result.copiedFiles.includes('Sessions/session'), true)
    assert.equal(result.skippedFiles.includes('Cache/http-cache'), true)
    assert.equal(await readFile(join(target, 'vast-data.json'), 'utf8'), '{"schemaVersion":1}')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
