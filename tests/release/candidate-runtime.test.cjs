const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
test('resume reconstructs the original runtime from ZIP without overwriting deliverables or rebuilding', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-runtime-restore-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = require('../../package.json').version
  const prefix = `Vast-${version}/win-unpacked/`
  const files = ['Updater/VastUpdater.ps1', 'Updater/updater.config.json', ...['Vast.exe', 'resources/app.asar', 'resources/app-update.yml', 'resources/avidae-runtime/runtime-manifest.json', 'resources/nested/spaced name.bin'].map(file => prefix + file)]
  for (const file of files) {
    const target = path.join(root, 'input', file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(`sealed original ${file}\0\xff`))
  }
  const archive = path.join(root, 'update.zip'), destination = path.join(root, 'restored')
  const zip = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:TEST_ZIP_INPUT, $env:TEST_ZIP_OUTPUT)'], { env: { ...process.env, TEST_ZIP_INPUT: path.join(root, 'input'), TEST_ZIP_OUTPUT: archive }, encoding: 'utf8', windowsHide: true })
  assert.equal(zip.status, 0, zip.stderr)
  const restore = () => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '../../scripts/verify-update-archive.ps1'), '-ArchivePath', archive, '-Version', version, '-ExtractRuntimeTo', destination], { encoding: 'utf8', windowsHide: true })
  const result = restore()
  assert.equal(result.status, 0, result.stderr)
  for (const file of files.filter(file => file.startsWith(prefix))) assert.deepEqual(fs.readFileSync(path.join(destination, file.slice(prefix.length))), fs.readFileSync(path.join(root, 'input', file)))
  assert.equal(fs.existsSync(path.join(destination, 'Updater')), false)
  assert.notEqual(restore().status, 0, 'never overwrite an existing runtime')
  const corrupt = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; Add-Type -AssemblyName System.IO.Compression; $zip = [IO.Compression.ZipFile]::Open($env:TEST_ZIP_OUTPUT, [IO.Compression.ZipArchiveMode]::Update); try { $zip.CreateEntry("../escape.txt") | Out-Null } finally { $zip.Dispose() }'], { env: { ...process.env, TEST_ZIP_OUTPUT: archive }, encoding: 'utf8', windowsHide: true })
  assert.equal(corrupt.status, 0, corrupt.stderr)
  assert.match(restore().stderr, /path traversal/, 'validate ZIP paths before extracting anything')
  assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false)
})
