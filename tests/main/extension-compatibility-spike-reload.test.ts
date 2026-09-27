import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('multi-extension matrix reloads in place without uninstalling either extension', async () => {
  const harness = await readFile(
    'experiments/extension-compatibility-spike/harness-main.cjs',
    'utf8'
  )
  const multiStart = harness.indexOf('\n  if (scenario.multiExtension) {')
  const multiEnd = harness.indexOf('\n  if (scenario.patchMatrix)', multiStart)
  const multiExtensionBlock = harness.slice(multiStart, multiEnd)
  const reloadStart = multiExtensionBlock.indexOf("await sampleResources('after-popup-tab-cycles')")
  const reloadEnd = multiExtensionBlock.indexOf("await sampleResources('after-reloads')", reloadStart)
  const reloadBlock = multiExtensionBlock.slice(reloadStart, reloadEnd)

  assert.ok(multiStart >= 0 && multiEnd > multiStart && reloadStart >= 0 && reloadEnd > reloadStart)
  assert.match(reloadBlock, /extensions\.reloadExtension\(item\.extension\.id\)/)
  assert.match(reloadBlock, /extensions\.getExtension\(item\.extension\.id\)/)
  assert.doesNotMatch(reloadBlock, /extensions\.removeExtension\(/)
  assert.doesNotMatch(reloadBlock, /extensions\.loadExtension\(/)
})
