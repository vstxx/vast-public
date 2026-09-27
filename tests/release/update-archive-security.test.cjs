const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')
const { zipSync } = require('fflate')

const root = join(__dirname, '..', '..')
const verifier = join(root, 'scripts', 'verify-update-archive.ps1')
const version = '9.8.7'
const required = {
  'Updater/VastUpdater.ps1': Buffer.from('# updater'),
  'Updater/updater.config.json': Buffer.from('{}'),
  [`Vast-${version}/win-unpacked/Vast.exe`]: Buffer.from('exe'),
  [`Vast-${version}/win-unpacked/resources/app.asar`]: Buffer.from('asar'),
  [`Vast-${version}/win-unpacked/resources/app-update.yml`]: Buffer.from('provider: github'),
  [`Vast-${version}/win-unpacked/resources/avidae-runtime/runtime-manifest.json`]: Buffer.from('{}')
}

function run(bytes, extract = false) {
  const directory = mkdtempSync(join(tmpdir(), 'vast-update-archive-'))
  const archive = join(directory, 'update.zip')
  writeFileSync(archive, bytes)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', verifier, '-ArchivePath', archive, '-Version', version]
  if (extract) args.push('-ExtractRuntimeTo', join(directory, 'runtime'))
  const result = spawnSync('powershell.exe', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  rmSync(directory, { recursive: true, force: true })
  return result
}

function patchExternalAttributes(bytes, name, attributes) {
  const output = Buffer.from(bytes)
  for (let offset = 0; offset + 46 <= output.length; offset++) {
    if (output.readUInt32LE(offset) !== 0x02014b50) continue
    const nameLength = output.readUInt16LE(offset + 28)
    const entryName = output.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (entryName === name) { output.writeUInt32LE(attributes >>> 0, offset + 38); return output }
  }
  throw new Error(`Central ZIP entry not found: ${name}`)
}

test('update archive accepts only the complete canonical runtime tree', () => {
  const result = run(zipSync(required), true)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const missing = { ...required }
  delete missing[`Vast-${version}/win-unpacked/resources/app.asar`]
  const rejected = run(zipSync(missing))
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr + rejected.stdout, /missing required entry/i)
})

test('update archive rejects zip-slip, unsafe Windows names, symlinks, and reparse-point entries', () => {
  const traversal = run(zipSync({ ...required, '../escape.txt': Buffer.from('escape') }))
  assert.notEqual(traversal.status, 0)
  assert.match(traversal.stderr + traversal.stdout, /path traversal|unsafe path/i)

  const reserved = run(zipSync({ ...required, [`Vast-${version}/win-unpacked/NUL.txt`]: Buffer.from('reserved') }))
  assert.notEqual(reserved.status, 0)
  assert.match(reserved.stderr + reserved.stdout, /unsafe Windows path segment/i)

  const entry = `Vast-${version}/win-unpacked/link`
  const base = zipSync({ ...required, [entry]: Buffer.from('target') })
  const symlink = run(patchExternalAttributes(base, entry, 0xA0000000))
  assert.notEqual(symlink.status, 0)
  assert.match(symlink.stderr + symlink.stdout, /link or special file/i)

  const reparse = run(patchExternalAttributes(base, entry, 0x00000400))
  assert.notEqual(reparse.status, 0)
  assert.match(reparse.stderr + reparse.stdout, /reparse-point/i)
})
