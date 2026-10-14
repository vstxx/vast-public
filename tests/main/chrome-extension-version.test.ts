import assert from 'node:assert/strict'
import test from 'node:test'
import { isChromeExtensionVersion, isNewerChromeExtensionVersion } from '../../src/shared/chrome-extension-version.ts'

test('accepts Chrome one-to-four component versions and compares all components', () => {
  assert.equal(isChromeExtensionVersion('1'), true)
  assert.equal(isChromeExtensionVersion('1.2.3.4'), true)
  assert.equal(isNewerChromeExtensionVersion('1.2.3.4', '1.2.3.3'), true)
  assert.equal(isNewerChromeExtensionVersion('1.2.3.0', '1.2.3'), false)
  assert.equal(isNewerChromeExtensionVersion('1.2.2.999', '1.2.3'), false)
})

test('rejects unsafe or ambiguous version components', () => {
  for (const value of ['1.2.3.4.5', '01.2', '1.2-beta', '1/2', '65536.0']) {
    assert.equal(isChromeExtensionVersion(value), false, value)
  }
})
