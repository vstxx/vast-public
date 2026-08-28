import assert from 'node:assert/strict'
import test from 'node:test'
import { ExtensionContributionRegistry, validateTheme } from '../../src/main/extensions/extension-contributions.ts'

test('contributions are namespaced, bounded, and removed by permission or owner', () => {
  const registry = new ExtensionContributionRegistry((id) => id === 'a' ? 'A' : 'B', () => undefined)
  registry.createToolbar('a', { id: 'save', title: 'Save A' })
  registry.createToolbar('b', { id: 'save', title: 'Save B' })
  assert.deepEqual(registry.snapshot().toolbar.map((item) => item.key), ['a:save', 'b:save'])
  registry.removePermission('a', 'vast.toolbar')
  assert.deepEqual(registry.snapshot().toolbar.map((item) => item.key), ['b:save'])
  registry.removeExtension('b')
  assert.equal(registry.snapshot().toolbar.length, 0)
})

test('theme contributions are validated, clamped, layered deterministically, and restored', () => {
  assert.deepEqual(validateTheme({ accentColor: '#8b5cf6', cornerRadius: 999, saturation: 1 }), { accentColor: '#8b5cf6', cornerRadius: 36, saturation: 80 })
  assert.throws(() => validateTheme({ css: 'body { display:none }' }), /unsupported token/)
  const registry = new ExtensionContributionRegistry((id) => id, () => undefined)
  registry.applyTheme('a', { accentColor: '#111111' })
  registry.applyTheme('b', { accentColor: '#222222' })
  assert.equal(registry.snapshot().theme?.extensionId, 'b')
  registry.clearTheme('b')
  assert.equal(registry.snapshot().theme?.extensionId, 'a')
})
