const test = require('node:test')
const assert = require('node:assert/strict')

const { assertVastPeIdentity, inspectWindowsPeVersion } = require('../../scripts/windows-pe-version.cjs')

const valid = {
  fileDescription: 'Vast',
  productName: 'Vast',
  fileVersion: '0.4.1',
  productVersion: '0.4.1.0'
}

test('release PE identity rejects Electron branding and version drift', () => {
  assert.doesNotThrow(() => assertVastPeIdentity(valid, '0.4.1'))
  for (const [field, value] of [
    ['fileDescription', 'Electron'],
    ['productName', 'Electron'],
    ['fileVersion', '44.3.0'],
    ['productVersion', '0.4.0']
  ]) {
    assert.throws(() => assertVastPeIdentity({ ...valid, [field]: value }, '0.4.1'), new RegExp(field, 'i'))
  }
})

test('PE version inspection reads the actual Windows executable', { skip: process.platform !== 'win32' }, () => {
  const info = inspectWindowsPeVersion(process.execPath)
  assert.ok(info.productName)
  assert.ok(info.productVersion)
  assert.throws(() => assertVastPeIdentity(info, '0.4.1'))
})
