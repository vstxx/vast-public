const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')
const { assertPassiveGuestWheelListeners, verifyPackagedGuestScroll } = require('../../scripts/verify-packaged-guest-scroll.cjs')

test('extracts and checks the guest preload from a real Windows ASAR', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vast-guest-asar-test-'))
  try {
    const source = path.join(temp, 'source')
    const preload = path.join(source, 'out', 'preload')
    fs.mkdirSync(preload, { recursive: true })
    fs.writeFileSync(path.join(preload, 'guest.js'), 'document.addEventListener("wheel", () => {}, { passive: true })')
    const archive = path.join(temp, 'app.asar')
    await asar.createPackage(source, archive)
    assert.equal(verifyPackagedGuestScroll(archive), 1)
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('packaged guest preload accepts a passive wheel listener', () => {
  assert.equal(assertPassiveGuestWheelListeners('document.addEventListener("wheel", () => {}, { capture: true, passive: true })'), 1)
})

test('packaged guest preload rejects a blocking wheel listener', () => {
  assert.throws(() => assertPassiveGuestWheelListeners('document.addEventListener("wheel", () => {}, { capture: true, passive: false })'), /passive/i)
})

test('packaged guest preload rejects missing wheel tracking', () => {
  assert.throws(() => assertPassiveGuestWheelListeners('document.addEventListener("scroll", () => {}, { passive: true })'), /wheel/i)
})
