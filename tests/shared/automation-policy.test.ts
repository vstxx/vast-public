import assert from 'node:assert/strict'
import test from 'node:test'
import { INTERNAL_PASSWORDS_URL } from '../../src/shared/constants.ts'
import {
  isSensitiveAutomationUrl,
  macroContainsSensitiveTarget,
  macroPermissionSummary
} from '../../src/shared/automation-policy.ts'
import type { MacroAction } from '../../src/shared/types.ts'

test('automation blocks auth, payment and password-vault targets without overmatching normal pages', () => {
  assert.equal(isSensitiveAutomationUrl('https://accounts.google.com/v3/signin/identifier'), true)
  assert.equal(isSensitiveAutomationUrl('https://shop.example/checkout/confirm'), true)
  assert.equal(isSensitiveAutomationUrl('https://service.example/account/billing'), true)
  assert.equal(isSensitiveAutomationUrl(INTERNAL_PASSWORDS_URL), true)
  assert.equal(isSensitiveAutomationUrl('https://example.com/articles/payment-history-explained'), false)
  assert.equal(isSensitiveAutomationUrl('https://accounts.google.com.evil.test/home'), false)
})

test('macro sensitive-target detection includes multi-url actions', () => {
  const actions: MacroAction[] = [
    { id: 'a', type: 'open-url-new-tab', url: 'https://example.com' },
    { id: 'b', type: 'open-multiple-urls', urls: ['https://docs.example', 'https://shop.example/payment'] }
  ]
  assert.equal(macroContainsSensitiveTarget(actions), true)
})

test('macro permission preview groups effects without exposing payload content', () => {
  const actions: MacroAction[] = [
    { id: 'a', type: 'open-url-new-tab', url: 'https://example.com' },
    { id: 'b', type: 'create-note', noteTitle: 'Private title', noteBody: 'Private body' },
    { id: 'c', type: 'close-duplicate-tabs' }
  ]
  assert.deepEqual(macroPermissionSummary(actions), ['Open pages and tabs', 'Write notes', 'Change existing tabs'])
  assert.equal(macroPermissionSummary(actions).join(' ').includes('Private'), false)
})
