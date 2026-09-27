const assert = require('node:assert/strict')
const test = require('node:test')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const asar = require('@electron/asar')
const { packagedMainContains } = require('../../scripts/store-msix-bundles.cjs')

test('Store package origin check searches split main-process chunks, not dependencies', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'vast-store-bundles-'))
  try {
    const source = join(temporary, 'source')
    mkdirSync(join(source, 'out', 'main', 'chunks'), { recursive: true })
    mkdirSync(join(source, 'node_modules', 'example'), { recursive: true })
    writeFileSync(join(source, 'out', 'main', 'main.js'), 'require("./chunks/hub.js")')
    writeFileSync(join(source, 'out', 'main', 'chunks', 'hub.js'), 'const origin = "https://extensions.vastbrowser.com"')
    writeFileSync(join(source, 'node_modules', 'example', 'index.js'), 'const decoy = "https://evil.example"')
    const archive = join(temporary, 'app.asar')
    await asar.createPackage(source, archive)
    assert.equal(packagedMainContains(asar, archive, 'https://extensions.vastbrowser.com'), true)
    assert.equal(packagedMainContains(asar, archive, 'https://evil.example'), false)
    assert.equal(packagedMainContains(asar, archive, 'https://missing.example'), false)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
