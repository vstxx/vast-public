import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { analyzeExtensionCompatibility } from '../../src/main/extensions/extension-compatibility.ts'
import {
  chromeExtensionId,
  resolveExtensionAssetPath,
  validateExtensionManifest
} from '../../src/main/extensions/extension-manifest.ts'

const fixturePath = resolve('tests/fixtures/extensions/content-script-basic')
const nativeFixturePath = resolve('tests/fixtures/extensions/vast-native-basic')
const hybridFixturePath = resolve('tests/fixtures/extensions/hybrid-basic')

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vast-extension-manifest-'))
}

test('validates a deterministic MV3 content-script extension fixture', async () => {
  const validated = await validateExtensionManifest(fixturePath)

  assert.equal(validated.manifest.name, 'Vast Content Script Fixture')
  assert.equal(validated.manifest.manifest_version, 3)
  assert.deepEqual(validated.permissions, ['storage'])
  assert.deepEqual(validated.hostPermissions, ['http://127.0.0.1/*', 'http://localhost/*'])
  assert.match(chromeExtensionId(validated.rootPath), /^[a-p]{32}$/)
  assert.deepEqual(analyzeExtensionCompatibility(validated), {
    compatibility: 'compatible',
    summary: 'Content scripts and documented Electron extension APIs were detected.',
    warnings: []
  })
})

test('recognizes Vast-native and hybrid manifests without merging their permission layers', async () => {
  const native = await validateExtensionManifest(nativeFixturePath)
  assert.equal(native.kind, 'vast')
  assert.equal(native.vast?.api_version, 1)
  assert.equal(native.vast?.permissions.includes('vast.storage'), true)
  assert.deepEqual(native.permissions, [])

  const hybrid = await validateExtensionManifest(hybridFixturePath)
  assert.equal(hybrid.kind, 'hybrid')
  assert.deepEqual(hybrid.vast?.permissions, ['vast.storage'])
  assert.deepEqual(hybrid.hostPermissions, ['https://example.com/*'])
})

test('validates Chrome and Vast custom popup and options surfaces', async () => {
  const chromeRoot = await temporaryDirectory()
  const nativeRoot = await temporaryDirectory()
  try {
    await writeFile(join(chromeRoot, 'popup.html'), '<!doctype html><title>Popup</title>', 'utf8')
    await writeFile(join(chromeRoot, 'options.html'), '<!doctype html><title>Options</title>', 'utf8')
    await writeFile(join(chromeRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Chrome UI',
      version: '1.0.0',
      action: { default_popup: 'popup.html' },
      options_ui: { page: 'options.html', open_in_tab: false }
    }), 'utf8')
    const chrome = await validateExtensionManifest(chromeRoot)
    assert.deepEqual(chrome.ui, {
      popup: { runtime: 'chrome', path: 'popup.html' },
      options: { runtime: 'chrome', path: 'options.html' }
    })
    assert.deepEqual(analyzeExtensionCompatibility(chrome), {
      compatibility: 'compatible',
      summary: 'The extension provides a supported popup or options page.',
      warnings: []
    })

    await writeFile(join(nativeRoot, 'background.js'), '', 'utf8')
    await writeFile(join(nativeRoot, 'popup.html'), '<!doctype html><title>Native popup</title>', 'utf8')
    await writeFile(join(nativeRoot, 'settings.html'), '<!doctype html><title>Native settings</title>', 'utf8')
    await writeFile(join(nativeRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Vast UI',
      version: '1.0.0',
      vast: { api_version: 1, background: 'background.js', popup: 'popup.html', options: 'settings.html', permissions: [] }
    }), 'utf8')
    const native = await validateExtensionManifest(nativeRoot)
    assert.deepEqual(native.ui, {
      popup: { runtime: 'native', path: 'popup.html' },
      options: { runtime: 'native', path: 'settings.html' }
    })
  } finally {
    await rm(chromeRoot, { recursive: true, force: true })
    await rm(nativeRoot, { recursive: true, force: true })
  }
})

test('rejects missing or non-HTML extension interface assets', async () => {
  const root = await temporaryDirectory()
  try {
    await writeFile(join(root, 'popup.js'), '', 'utf8')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Bad UI', version: '1.0.0', action: { default_popup: 'popup.js' } }), 'utf8')
    await assert.rejects(validateExtensionManifest(root), /must be a local HTML file/)
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Missing UI', version: '1.0.0', action: { default_popup: 'missing.html' } }), 'utf8')
    await assert.rejects(validateExtensionManifest(root), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('keeps an incompatible native layer diagnosable while preserving a hybrid Chrome layer', async () => {
  const root = await temporaryDirectory()
  try {
    await writeFile(join(root, 'content.js'), '', 'utf8')
    await writeFile(join(root, 'background.js'), '', 'utf8')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Future API', version: '1.0.0', content_scripts: [{ matches: ['https://example.com/*'], js: ['content.js'] }], vast: { api_version: 2, background: 'background.js', permissions: ['vast.storage'] } }), 'utf8')
    const validated = await validateExtensionManifest(root)
    assert.equal(validated.kind, 'hybrid')
    assert.match(validated.nativeCompatibilityError ?? '', /version 2 is not supported/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects unknown Vast permissions and unsafe background paths for the native layer', async () => {
  const root = await temporaryDirectory()
  try {
    await writeFile(join(root, 'background.js'), '', 'utf8')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Unknown permission', version: '1.0.0', vast: { api_version: 1, background: 'background.js', permissions: ['vast.passwords'] } }), 'utf8')
    const validated = await validateExtensionManifest(root)
    assert.match(validated.nativeCompatibilityError ?? '', /Unknown Vast permission/)
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Traversal', version: '1.0.0', vast: { api_version: 1, background: '../outside.js', permissions: [] } }), 'utf8')
    await assert.rejects(validateExtensionManifest(root), /escapes the extension directory/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('rejects missing and malformed extension manifests with actionable errors', async () => {
  const root = await temporaryDirectory()
  try {
    await assert.rejects(validateExtensionManifest(root), /does not contain manifest\.json/)
    await writeFile(join(root, 'manifest.json'), '{ invalid json', 'utf8')
    await assert.rejects(validateExtensionManifest(root), /not valid JSON/)
    await writeFile(join(root, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'Missing version'
    }), 'utf8')
    await assert.rejects(validateExtensionManifest(root), /invalid version/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extension asset resolution rejects traversal and symlink escapes', async (t) => {
  const root = await temporaryDirectory()
  const outside = join(dirname(root), `${root.split(/[\\/]/).pop()}-outside.svg`)
  try {
    await writeFile(join(root, 'inside.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
    await writeFile(outside, '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')
    assert.equal(await resolveExtensionAssetPath(root, 'inside.svg'), await realpath(join(root, 'inside.svg')))
    await assert.rejects(resolveExtensionAssetPath(root, '../outside.svg'), /escapes the extension directory/)

    const linkPath = join(root, 'linked.svg')
    try {
      const { symlink } = await import('node:fs/promises')
      await symlink(outside, linkPath, 'file')
      await assert.rejects(resolveExtensionAssetPath(root, 'linked.svg'), /escapes the extension directory/)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') t.diagnostic('Symlink assertion skipped: host disallows symlink creation.')
      else throw error
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { force: true })
  }
})

test('classifies supported, partial, and unsupported manifests explicitly', async () => {
  const supported = await validateExtensionManifest(fixturePath)
  const partial = structuredClone(supported)
  partial.permissions = ['storage', 'tabs', 'cookies']
  partial.manifest.action = { default_title: 'No toolbar surface in Vast yet' }
  assert.equal(analyzeExtensionCompatibility(partial).compatibility, 'partial')
  assert.match(analyzeExtensionCompatibility(partial).warnings.join(' '), /tabs.*partially supported/i)
  assert.match(analyzeExtensionCompatibility(partial).warnings.join(' '), /cookies.*not in Electron/i)

  const unsupported = structuredClone(supported)
  unsupported.manifest.content_scripts = []
  assert.equal(analyzeExtensionCompatibility(unsupported).compatibility, 'unsupported')
})
