import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createVastBackupArchive,
  extractVastBackupArchive,
  listZipEntries,
  validateBackupManifest
} from '../../src/main/vast-backup.ts'

function errno(code: string): Error & { code: string } {
  const error = new Error(`${code}: simulated locked file`)
  return Object.assign(error, { code })
}

test('full Vast backup creates a .vastbackup zip with manifest, checksums, and expected data', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-'))
  try {
    const dataRoot = join(tempRoot, 'Data')
    const archivePath = join(tempRoot, 'profile.vastbackup')
    await mkdir(join(dataRoot, 'Local Storage'), { recursive: true })
    await mkdir(join(dataRoot, 'Cache'), { recursive: true })
    await mkdir(join(dataRoot, 'DawnWebGPUCache'), { recursive: true })
    await mkdir(join(dataRoot, 'Backups', 'Vast-1.0.11', 'user-data-1'), { recursive: true })
    await mkdir(join(dataRoot, 'avidae'), { recursive: true })
    await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"notes":[{"id":"n1"}]}', 'utf8')
    await writeFile(join(dataRoot, 'password-vault.json'), '{"schemaVersion":1,"records":[]}', 'utf8')
    await writeFile(join(dataRoot, 'license-cache.json'), '{"state":"active","signature":"signed"}', 'utf8')
    await writeFile(join(dataRoot, 'license-device.json'), '{"deviceId":"legacy"}', 'utf8')
    await writeFile(join(dataRoot, 'Local State'), '{"os_crypt":{}}', 'utf8')
    await writeFile(join(dataRoot, 'Local Storage', 'leveldb.txt'), 'site-state', 'utf8')
    await writeFile(join(dataRoot, 'Cache', 'ignored.bin'), 'cache', 'utf8')
    await writeFile(join(dataRoot, 'DawnWebGPUCache', 'data_3'), Buffer.alloc(2 * 1024 * 1024), 'utf8')
    await writeFile(join(dataRoot, 'Backups', 'Vast-1.0.11', 'user-data-1', 'vast-data.json'), '{"redundant":true}', 'utf8')
    await writeFile(join(dataRoot, 'avidae', 'memory.json'), '{"enabled":true}', 'utf8')

    const report = await createVastBackupArchive({
      dataRoot,
      destinationPath: archivePath,
      appVersion: '1.0.9',
      appId: 'app.vast.browser',
      platform: 'win32'
    })

    assert.equal(report.ok, true)
    assert.equal(report.path, archivePath)
    assert.equal(report.includedFiles.includes('vast-data.json'), true)
    assert.equal(report.includedFiles.includes('password-vault.json'), true)
    assert.equal(report.includedFiles.includes('license-cache.json'), false)
    assert.equal(report.includedFiles.includes('license-device.json'), false)
    assert.equal(report.includedFiles.includes('Local Storage/leveldb.txt'), true)
    assert.equal(report.includedFiles.includes('avidae/memory.json'), true)
    assert.equal(report.skippedFiles.includes('Cache/ignored.bin'), true)
    assert.equal(report.skippedFiles.includes('DawnWebGPUCache/data_3'), true)
    assert.equal(report.skippedFiles.includes('Backups'), true)
    assert.equal(report.manifest.excludedSections.includes('Redundant updater profile backups'), true)
    assert.equal(report.includedFileCount, report.includedFiles.length)
    assert.equal(report.skippedFileCount, report.skippedFiles.length)
    assert.equal(report.vastDataIncluded, true)
    assert.equal(report.passwordVaultIncluded, true)
    assert.equal(report.manifest.sourceDataPath, undefined)

    const entries = await listZipEntries(archivePath)
    assert.equal(entries.includes('manifest.json'), true)
    assert.equal(entries.includes('README.md'), true)
    assert.equal(entries.includes('data/vast-data.json'), true)
    assert.equal(entries.includes('data/password-vault.json'), true)
    assert.equal(entries.includes('data/license-cache.json'), false)
    assert.equal(entries.includes('data/license-device.json'), false)
    assert.equal(entries.includes('data/avidae/memory.json'), true)
    assert.equal(entries.includes('data/Cache/ignored.bin'), false)
    assert.equal(entries.includes('data/DawnWebGPUCache/data_3'), false)
    assert.equal(entries.some((entry) => entry.startsWith('data/Backups/')), false)

    const extracted = await extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted'))
    assert.equal(extracted.manifest.product, 'Vast')
    assert.equal(validateBackupManifest(extracted.manifest).ok, true)
    assert.equal(extracted.manifest.includedFileCount, report.includedFiles.length)
    assert.equal(extracted.manifest.skippedFileCount, report.skippedFiles.length)
    assert.equal(extracted.manifest.vastDataIncluded, true)
    assert.equal(extracted.manifest.passwordVaultIncluded, true)
    assert.equal(extracted.manifest.includedSections.includes('Video & Audio data'), true)
    assert.equal(extracted.manifest.skippedFiles.some((item) => item.path === 'Cache/ignored.bin' && item.reason), true)
    assert.match(extracted.manifest.warnings.join('\n'), /password vault/i)
    assert.doesNotMatch(extracted.manifest.warnings.join('\n'), /license|reactivat/i)
    assert.equal(await readFile(join(tempRoot, 'Extracted', 'data', 'vast-data.json'), 'utf8'), '{"schemaVersion":1,"notes":[{"id":"n1"}]}')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('legacy backup metadata verifies but is not restored', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-legacy-metadata-'))
  try {
    const legacyEntries = {
      'data/license-cache.json': '{"state":"active","signature":"legacy"}',
      'data/license-device.json': '{"deviceId":"legacy"}'
    }
    const archivePath = await createMinimalBackup(tempRoot, {
      extraEntriesForTests: Object.entries(legacyEntries).map(([path, data]) => ({ path, data })),
      manifestTransformForTests: (manifest) => {
        for (const [path, data] of Object.entries(legacyEntries)) {
          manifest.checksums[path] = {
            sha256: createHash('sha256').update(data).digest('hex'),
            sizeBytes: Buffer.byteLength(data)
          }
          manifest.includedFileCount += 1
        }
      }
    })
    const destination = join(tempRoot, 'Extracted')
    const extracted = await extractVastBackupArchive(archivePath, destination)

    assert.equal(extracted.manifest.includedFileCount, 3)
    assert.equal(extracted.extractedFiles.includes('data/license-cache.json'), false)
    assert.equal(extracted.extractedFiles.includes('data/license-device.json'), false)
    await assert.rejects(() => readFile(join(destination, 'data', 'license-cache.json')), /ENOENT/)
    await assert.rejects(() => readFile(join(destination, 'data', 'license-device.json')), /ENOENT/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('full Vast backup skips locked non-critical files and records the reason', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-locked-'))
  try {
    const dataRoot = join(tempRoot, 'Data')
    const archivePath = join(tempRoot, 'profile.vastbackup')
    await mkdir(join(dataRoot, 'Local Storage'), { recursive: true })
    await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[]}', 'utf8')
    await writeFile(join(dataRoot, 'Local Storage', 'leveldb.txt'), 'locked-site-state', 'utf8')

    const report = await createVastBackupArchive({
      dataRoot,
      destinationPath: archivePath,
      appVersion: '1.0.9',
      appId: 'app.vast.browser',
      platform: 'win32',
      fileOperationHooksForTests: {
        beforeCopy: (relativePath) => {
          if (relativePath === 'Local Storage/leveldb.txt') throw errno('EBUSY')
        }
      }
    })

    assert.equal(report.ok, true)
    assert.equal(report.includedFiles.includes('vast-data.json'), true)
    assert.equal(report.includedFiles.includes('Local Storage/leveldb.txt'), false)
    assert.equal(report.skippedFiles.includes('Local Storage/leveldb.txt'), true)
    assert.equal(report.skippedFileDetails.some((item) => item.path === 'Local Storage/leveldb.txt' && /EBUSY/.test(item.reason)), true)

    const entries = await listZipEntries(archivePath)
    assert.equal(entries.includes('data/vast-data.json'), true)
    assert.equal(entries.includes('data/Local Storage/leveldb.txt'), false)

    const extracted = await extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted'))
    assert.equal(extracted.manifest.skippedFileCount, 1)
    assert.equal(extracted.manifest.skippedFiles[0]?.path, 'Local Storage/leveldb.txt')
    assert.match(extracted.manifest.warnings.join('\n'), /skipped/i)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('full Vast backup skips locked password vault with a warning instead of failing', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-vault-locked-'))
  try {
    const dataRoot = join(tempRoot, 'Data')
    const archivePath = join(tempRoot, 'profile.vastbackup')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[]}', 'utf8')
    await writeFile(join(dataRoot, 'password-vault.json'), '{"schemaVersion":1,"records":[{"id":"p1"}]}', 'utf8')

    const report = await createVastBackupArchive({
      dataRoot,
      destinationPath: archivePath,
      appVersion: '1.0.9',
      appId: 'app.vast.browser',
      platform: 'win32',
      fileOperationHooksForTests: {
        beforeCopy: (relativePath) => {
          if (relativePath === 'password-vault.json') throw errno('EACCES')
        }
      }
    })

    assert.equal(report.ok, true)
    assert.equal(report.vastDataIncluded, true)
    assert.equal(report.passwordVaultIncluded, false)
    assert.equal(report.skippedFiles.includes('password-vault.json'), true)
    assert.match(report.manifest.warnings.join('\n'), /password-vault\.json could not be included/i)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('full Vast backup refuses to separate a password vault from its Local State key', async () => {
  for (const locked of [false, true]) {
    const tempRoot = await mkdtemp(join(tmpdir(), `vast-backup-vault-key-${locked ? 'locked' : 'missing'}-`))
    try {
      const dataRoot = join(tempRoot, 'Data')
      const archivePath = join(tempRoot, 'profile.vastbackup')
      await mkdir(dataRoot, { recursive: true })
      await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[]}', 'utf8')
      await writeFile(join(dataRoot, 'password-vault.json'), '{"schemaVersion":2,"records":[{"id":"p1","encryptedPassword":"ciphertext"}]}', 'utf8')
      if (locked) await writeFile(join(dataRoot, 'Local State'), '{"os_crypt":{}}', 'utf8')

      await assert.rejects(
        () => createVastBackupArchive({
          dataRoot,
          destinationPath: archivePath,
          appVersion: '0.1.4',
          appId: 'app.vast.browser',
          platform: 'win32',
          fileOperationHooksForTests: locked
            ? {
                beforeCopy: (relativePath) => {
                  if (relativePath === 'Local State') throw errno('EBUSY')
                }
              }
            : undefined
        }),
        /matching Local State encryption key is locked or unavailable/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
})

test('full Vast backup fails clearly when vast-data.json is missing', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-missing-critical-'))
  try {
    const dataRoot = join(tempRoot, 'Data')
    const archivePath = join(tempRoot, 'profile.vastbackup')
    await mkdir(dataRoot, { recursive: true })

    await assert.rejects(
      () =>
        createVastBackupArchive({
          dataRoot,
          destinationPath: archivePath,
          appVersion: '1.0.9',
          appId: 'app.vast.browser',
          platform: 'win32'
        }),
      /Could not export Vast profile data because vast-data\.json is locked or unavailable\./
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('full Vast backup fails clearly when vast-data.json is locked', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-locked-critical-'))
  try {
    const dataRoot = join(tempRoot, 'Data')
    const archivePath = join(tempRoot, 'profile.vastbackup')
    await mkdir(dataRoot, { recursive: true })
    await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[]}', 'utf8')

    await assert.rejects(
      () =>
        createVastBackupArchive({
          dataRoot,
          destinationPath: archivePath,
          appVersion: '1.0.9',
          appId: 'app.vast.browser',
          platform: 'win32',
          fileOperationHooksForTests: {
            beforeCopy: (relativePath) => {
              if (relativePath === 'vast-data.json') throw errno('EBUSY')
            }
          }
        }),
      /Could not export Vast profile data because vast-data\.json is locked or unavailable\./
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('backup extraction rejects zip-slip entries', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-slip-'))
  try {
    const archivePath = join(tempRoot, 'bad.vastbackup')
    await writeFile(join(tempRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[]}', 'utf8')
    await createVastBackupArchive({
      dataRoot: tempRoot,
      destinationPath: archivePath,
      appVersion: '1.0.9',
      appId: 'app.vast.browser',
      platform: 'win32',
      extraEntriesForTests: [{ path: '../escape.txt', data: 'nope' }]
    })

    await assert.rejects(
      () => extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted')),
      /Unsafe archive entry/
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

async function createMinimalBackup(tempRoot: string, options: Parameters<typeof createVastBackupArchive>[0] extends infer T ? Partial<T> : never = {}): Promise<string> {
  const dataRoot = join(tempRoot, 'Data')
  const archivePath = join(tempRoot, 'profile.vastbackup')
  await mkdir(dataRoot, { recursive: true })
  await writeFile(join(dataRoot, 'vast-data.json'), '{"schemaVersion":1,"tabs":[],"workspaces":[]}', 'utf8')
  await createVastBackupArchive({
    dataRoot,
    destinationPath: archivePath,
    appVersion: '1.0.9',
    appId: 'app.vast.browser',
    platform: 'win32',
    ...options
  })
  return archivePath
}

test('backup extraction rejects legacy password vault archives that omitted Local State', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-vault-without-key-'))
  try {
    const vault = '{"schemaVersion":1,"records":[]}'
    const archivePath = await createMinimalBackup(tempRoot, {
      extraEntriesForTests: [{ path: 'data/password-vault.json', data: vault }],
      manifestTransformForTests: (manifest) => {
        manifest.passwordVaultIncluded = true
        manifest.checksums['data/password-vault.json'] = {
          sha256: createHash('sha256').update(vault).digest('hex'),
          sizeBytes: Buffer.byteLength(vault)
        }
        manifest.includedFileCount += 1
      }
    })

    await assert.rejects(
      () => extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted')),
      /password vault without its matching Local State encryption key/
    )
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('backup extraction verifies SHA-256, declared size, and expected files', async () => {
  const cases: Array<{ name: string; options: Partial<Parameters<typeof createVastBackupArchive>[0]>; expected: RegExp }> = [
    {
      name: 'modified data',
      options: { archiveEntryOverridesForTests: { 'data/vast-data.json': '{"tampered":true}' } },
      expected: /size mismatch|checksum mismatch/
    },
    {
      name: 'incorrect checksum',
      options: { manifestTransformForTests: (manifest) => { manifest.checksums['data/vast-data.json'].sha256 = '0'.repeat(64) } },
      expected: /checksum mismatch/
    },
    {
      name: 'missing checksum',
      options: { manifestTransformForTests: (manifest) => { delete manifest.checksums['data/vast-data.json'] } },
      expected: /file count|required Vast data file/
    },
    {
      name: 'missing expected file',
      options: { omitArchiveEntriesForTests: ['data/vast-data.json'] },
      expected: /missing expected file/
    }
  ]

  for (const item of cases) {
    const tempRoot = await mkdtemp(join(tmpdir(), `vast-backup-${item.name.replace(/\s/g, '-')}-`))
    try {
      const archivePath = await createMinimalBackup(tempRoot, item.options)
      await assert.rejects(() => extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted')), item.expected)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
})

test('backup extraction rejects duplicate and unexpected archive entries', async () => {
  for (const extra of [
    { path: 'data/vast-data.json', data: '{}' },
    { path: 'unexpected.txt', data: 'nope' }
  ]) {
    const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-extra-'))
    try {
      const archivePath = await createMinimalBackup(tempRoot, { extraEntriesForTests: [extra] })
      await assert.rejects(
        () => extractVastBackupArchive(archivePath, join(tempRoot, 'Extracted')),
        extra.path === 'data/vast-data.json' ? /Duplicate or empty/ : /Unexpected file/
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
})

test('backup extraction rejects oversized archives before reading them and suspicious compression ratios', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-limits-'))
  try {
    const oversized = join(tempRoot, 'oversized.vastbackup')
    await writeFile(oversized, '')
    await truncate(oversized, 512 * 1024 * 1024 + 1)
    await assert.rejects(() => extractVastBackupArchive(oversized, join(tempRoot, 'Oversized')), /archive is too large/)

    const archivePath = await createMinimalBackup(tempRoot)
    const archive = await readFile(archivePath)
    const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    const centralOffset = archive.indexOf(centralSignature)
    assert.ok(centralOffset >= 0)
    archive.writeUInt32LE(200 * 1024 * 1024, centralOffset + 24)
    await writeFile(archivePath, archive)
    await assert.rejects(() => extractVastBackupArchive(archivePath, join(tempRoot, 'Bomb')), /suspicious compression ratio/)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('backup parser accepts highly compressible GPU cache from legacy exports', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-legacy-gpu-cache-'))
  try {
    const archivePath = await createMinimalBackup(tempRoot, {
      extraEntriesForTests: [{ path: 'data/DawnWebGPUCache/data_3', data: Buffer.alloc(2 * 1024 * 1024) }]
    })
    const entries = await listZipEntries(archivePath)
    assert.equal(entries.includes('data/DawnWebGPUCache/data_3'), true)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('backup parser accepts legacy exports that expand beyond the old 1 GiB limit', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-legacy-size-'))
  try {
    const payload = randomBytes(1024 * 1024)
    const extraEntries = Array.from({ length: 6 }, (_, index) => ({
      path: `data/legacy-large-${index}.bin`,
      data: payload
    }))
    const archivePath = await createMinimalBackup(tempRoot, { extraEntriesForTests: extraEntries })
    const archive = await readFile(archivePath)
    const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
    const eocd = archive.lastIndexOf(eocdSignature)
    assert.ok(eocd >= 0)
    const entryCount = archive.readUInt16LE(eocd + 10)
    let cursor = archive.readUInt32LE(eocd + 16)
    let rewritten = 0
    for (let index = 0; index < entryCount; index += 1) {
      assert.equal(archive.readUInt32LE(cursor), 0x02014b50)
      const nameLength = archive.readUInt16LE(cursor + 28)
      const extraLength = archive.readUInt16LE(cursor + 30)
      const commentLength = archive.readUInt16LE(cursor + 32)
      const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      if (name.startsWith('data/legacy-large-')) {
        archive.writeUInt32LE(200 * 1024 * 1024, cursor + 24)
        rewritten += 1
      }
      cursor += 46 + nameLength + extraLength + commentLength
    }
    assert.equal(rewritten, 6)
    await writeFile(archivePath, archive)

    const entries = await listZipEntries(archivePath)
    assert.equal(entries.filter((entry) => entry.startsWith('data/legacy-large-')).length, 6)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('interrupted activation preserves the previous destination', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'vast-backup-interrupted-'))
  try {
    const archivePath = await createMinimalBackup(tempRoot)
    const destination = join(tempRoot, 'Current')
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'sentinel.txt'), 'keep-me', 'utf8')
    await assert.rejects(
      () => extractVastBackupArchive(archivePath, destination, { beforeActivateForTests: () => { throw new Error('simulated interruption') } }),
      /simulated interruption/
    )
    assert.equal(await readFile(join(destination, 'sentinel.txt'), 'utf8'), 'keep-me')
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
